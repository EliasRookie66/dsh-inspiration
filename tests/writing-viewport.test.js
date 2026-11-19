import { legacyWorkspaceRegion } from './legacy-workspace-guard.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Static contracts against the real client source/CSS. These intentionally do
// not evaluate React, invent a DOM renderer, or claim browser geometry proof.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const css = source.slice(source.indexOf('    const CSS = `'), source.indexOf('\n`;'));
const rule = selector => {
  const start = css.indexOf(selector + '{');
  assert(start >= 0, selector);
  return css.slice(start + selector.length + 1, css.indexOf('}', start));
};
const hash = text => createHash('sha256').update(text).digest('hex');
const region = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('normal-flow controls consume allocated space instead of overlaying scrolling prose', () => {
  const partner = rule('.mx-writing-partner');
  assert(partner.includes('position:static'));
  assert(partner.includes('flex:0 0 auto'));
  assert(partner.includes('overflow:auto'), 'Oversized control zone remains independently reachable');
  assert(!partner.includes('top:') && !partner.includes('z-index:'));
  assert(!css.includes('position:sticky'));
  assert(!css.includes("html[data-platform='darwin'] .mx-writing-partner"));
  assert(source.includes("h('div', { ref: columnRef, className: 'mx-writing-column' }, renderAI(), renderEditor())"));
  assert(rule('.mx-writing-column').includes('overflow:auto'), 'Crowded controls and minimum editor remain reachable without overlay');
  assert(rule('.mx-writing-column').includes('min-height:0'));
});

test('pinned chrome has its own allocation and the content pane handles vertical shortfall', () => {
  assert(rule('.mx-root').includes('overflow:hidden') && rule('.mx-root').includes('flex-direction:column'));
  for (const declaration of ['flex:1', 'min-height:0', 'overflow:auto']) assert(rule('.mx-content-pane').includes(declaration));
  assert(rule('.mx-root-writing .mx-content-pane').includes('display:flex'));
  assert(rule('.mx-topbar').includes('flex:0 0 auto'));
  for (const selector of ['.mx-root-writing .mx-book-workspace', '.mx-root-writing .mx-writing-host', '.mx-root-writing .mx-grid']) assert(rule(selector).includes('overflow:hidden'), selector);
  assert(rule('.mx-root-writing .mx-book-workspace').includes('min-height:26rem'));
  assert(rule('.mx-editor-panel').includes('min-height:20rem'));
  assert(source.includes("className: 'mx-panel mx-stack mx-editor-panel'"));
  assert(source.includes('root: position(contentRef.current)'));
  assert(source.includes('const ports = { root: contentRef.current, panel: panelRef.current, column: columnRef.current }'));
  assert(source.includes('measureTextareaCaret(editor, plan.caret, rootRef.current)'));
});

test('body slot fills available height; long manuscript text scrolls in its own native or read-only surface', () => {
  assert(rule('.mx-body-slot').includes('flex:1 0 16rem'));
  assert(rule('.mx-body-slot').includes('overflow:hidden'));
  assert(rule('.mx-body-slot>.mx-field').includes('min-height:0'));
  const textarea = rule('.mx-body-slot .mx-editor');
  for (const declaration of ['flex:1', 'min-height:0', 'height:0', 'resize:none']) assert(textarea.includes(declaration));
  assert(rule('.mx-body-slot>.mx-revision-preview,.mx-body-slot>.mx-stack').includes('overflow:auto'));
  assert(rule('.mx-editor-panel').includes('overflow:auto'), 'Chapter metadata and manuscript remain reachable');
  assert(rule('.mx-summary-preview').includes('overflow:auto'), 'A legacy summary proposal has a scrollable result, not an editor');
  assert(source.includes("h('div', { key: 'manuscript', className: 'mx-body-slot' }, inlineReviewProblem"));
  assert(source.includes('polishPreviewVisible ? renderPolishPreview() : revisionPreviewVisible ? renderRevisionPreview() : generatedManuscript ? renderGeneratedPreview()'), 'All review modes retain the same allocated body slot and precedence');
  assert(source.includes("generatedVisible && displayRecord.mode === 'summary' && renderGeneratedPreview()"));
});

test('one ID-valued native chapter picker remains pinned in normal and focus modes', () => {
  const picker = region('          const renderChapterPicker =', '          const renderTitleControl =');
  const bar = region('          const renderTopbar =', "          return h('main'");
  const editor = region('          const renderEditor =', '          const renderModelPicker =');
  assert.match(picker, /h\(Field, \{ label: t\('chaptersToggle'\), visuallyHidden: true \}/);
  assert.match(picker, /h\('select', \{ value: w.chapterId, disabled: locked/);
  assert.match(picker, /onChange: e => changeChapter\(e.target.value\)/);
  assert.match(picker, /h\('option', \{ key: c.id, value: c.id \}, \(i \+ 1\)/);
  assert.match(bar, /w && h\('div', .*renderChapterPicker\(\)/);
  assert.match(picker, /!chapter && h\('option', \{ value: '' \}, t\('noChapters'\)\)/);
  assert.doesNotMatch(bar, /hidden: folded|chapterNav|role: 'menu'/);
  assert.match(editor, /titleOpen && h\(Field, \{ label: t\('chapterTitle'\) \}, input\('chapter', 'title'/);
  assert.match(editor, /autoFocus: true/);
  assert.match(source, /chapterTitleButtonRef.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.equal(rule('.mx-grid').match(/grid-template-columns:([^;]+)/)?.[1], 'minmax(0,1fr)');
  assert(!css.includes('data-chapters') && !css.includes('mx-chapter-nav'));
});

test('header omits the entire save panel while automatic save, error retry and Ctrl+S remain', () => {
  const header = region("          const renderTopbar =", "          return h('main'");
  for (const forbidden of ['mx-save-controls', "t('unsaved')", "t('saved')", "t('autosaveHint')", "t('saveNow')", "t('discard')"]) assert(!header.includes(forbidden), forbidden);
  assert(header.includes("autosaveRef.current?.failed && toolbarButton('save', t('autosaveRetry'), saveAll"));
  assert(header.includes('!autosaveCanSave(w, autosaveRef.current)'));
  assert(source.includes("if (autosaveCanSave(current.current, autosaveRef.current) && !busyRef.current) saveAll()"));
});

test('non-writing tabs, recovery/error flows and short viewports retain an accessible scroll path', () => {
  assert(rule('.mx-content-pane').includes('overflow:auto'));
  const gate = source.match(/const writingLayout = ([^;]+);/)[1];
  for (const marker of ["tab === 'writing'", '!!chapter', '!d.candidate', '!recovery', '!conflict', '!deletionNotice', '!storageFailed', 'cleanupPendingCount === 0']) assert(gate.includes(marker), marker);
  assert(source.includes("className: 'mx-root' + (writingLayout ? ' mx-root-writing' : '')"));
  assert(css.includes('@media(max-height:640px){.mx-root-writing .mx-content-pane{display:block}'));
  assert(!css.includes('.mx-root.mx-root-writing{display:block'));
  assert(css.includes('.mx-root-writing .mx-writing-host{min-height:24rem}'));
  assert(rule('.mx-utility-page').includes('min-width:0'));
  assert(!css.includes('.mx-partner-advanced'));
  assert(rule('.mx-writing-column').includes('overflow:auto'));
  assert(rule('.mx-editor-panel').includes('min-height:20rem'), 'Crowded control budgets cannot zero the editor; allocated column scrolls instead');
  assert(!css.includes('.mx-compact-tools'));
  assert(source.includes("h('div', { id: formId.current, ref: findPageRef, className: 'mx-writing-host' }, renderCurrentPage())"));
  assert(source.includes("recovery && h('section'"));
  assert(source.includes('renderConflict()'));
});

test('author callbacks preserve all original bytes except decision-time view capture and guarded post-success queue', () => {
  // Pinned v0.1.0 spans: only book settings/constraint recovery helpers may evolve.
  assert.equal(hash(legacyWorkspaceRegion(source)), '11a7db1f41b1c65f324fb5ce1c9fc2b4d770f3dccec8c8b1370c2b0f18d3c2c6');
  assert.equal(hash(region('    const textareaValue =', '    const en =')), '8b05aafaa77dc626c68aa6812c80350c2cb9e33c9ecc5bcbceffab43456c8148', 'All original native-offset/source/review/model guards remain byte-identical');
  const callbacks = region('          const applyPolish =', '          useEffect(');
  const capture = '              const returnAnchor = capturePolishReturn(snapshot);\n';
  const viewHook = 'queuePolishViewport(snapshot, saved, accept, returnAnchor); ';
  assert.equal(callbacks.split(capture).length - 1, 1);
  assert.equal(callbacks.split(viewHook).length - 1, 1);
  assert(callbacks.indexOf(capture) > callbacks.indexOf('if (problem) throw') && callbacks.indexOf(capture) < callbacks.indexOf('const saved = await mutateRaw('));
  assert(callbacks.includes('if (alive.current && saved) { ' + viewHook), 'Viewport work is queued only after a checked successful durable response');
  assert(callbacks.indexOf(viewHook) > callbacks.indexOf('const saved = await mutateRaw('));
  assert.equal(hash(callbacks.replace(capture, '').replace(viewHook, '')), '59e913af925fb7b5364da9a05f01d4a9968e9de7c8d60e5547302e3a1cc71792', 'Removing the view operations reproduces the audited author checks and payload byte-for-byte');
  for (const marker of ["action: 'acceptRevisionAll'", 'bulkRevisionProblem', 'generatedActionProblem', 'polishActionProblem', 'revisionActionProblem', 'visibleReviewProblem']) assert(source.includes(marker));
});
