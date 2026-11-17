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

test('writing-only full-height flex chain allocates remaining content height without viewport guesses', () => {
  assert(rule('.mx-root-writing').includes('overflow:auto'), 'Actual allocated pane shortfall must scroll, regardless of browser-window height');
  for (const selector of ['.mx-root-writing .mx-book-workspace', '.mx-root-writing .mx-writing-host', '.mx-root-writing .mx-grid']) {
    assert(rule(selector).includes('overflow:hidden'), selector);
  }
  assert(rule('.mx-root-writing').includes('display:flex'));
  assert(rule('.mx-root-writing .mx-book-workspace').includes('flex:1 0 32rem'));
  assert(rule('.mx-root-writing .mx-book-workspace').includes('min-height:32rem'));
  assert(rule('.mx-editor-panel').includes('flex:1 0 20rem'));
  assert(rule('.mx-editor-panel').includes('min-height:20rem'));
  for (const selector of ['.mx-root-writing .mx-writing-host', '.mx-root-writing .mx-grid']) {
    assert(rule(selector).includes('flex:1'), selector);
    assert(rule(selector).includes('min-height:0'), selector);
  }
  assert(!/min-height:(?:52|46|42)vh/.test(css));
  assert(!css.includes('max-height:65vh'));
  assert(source.includes("className: 'mx-panel mx-stack mx-editor-panel'"));
  assert(source.includes("className: 'mx-writing-host'"));
});

test('body slot fills available height; long manuscript text scrolls in its own native or read-only surface', () => {
  assert(rule('.mx-body-slot').includes('flex:1 0 16rem'));
  assert(rule('.mx-body-slot').includes('overflow:hidden'));
  assert(rule('.mx-body-slot>.mx-field').includes('min-height:0'));
  const textarea = rule('.mx-body-slot .mx-editor');
  for (const declaration of ['flex:1', 'min-height:0', 'height:0', 'resize:none']) assert(textarea.includes(declaration));
  assert(rule('.mx-body-slot>.mx-revision-preview,.mx-body-slot>.mx-stack').includes('overflow:auto'));
  assert(rule('.mx-editor-panel').includes('overflow:auto'), 'Outline, metadata and expanded summary remain reachable');
  assert(source.includes("h('div', { className: 'mx-body-slot' }, inlineReviewProblem"));
  assert(source.includes('polishPreviewVisible ? renderPolishPreview() : revisionPreviewVisible ? renderRevisionPreview() : generatedManuscript ? renderGeneratedPreview()'), 'All review modes retain the same allocated body slot and precedence');
  assert(source.includes("generatedVisible && displayRecord.mode === 'summary' && renderGeneratedPreview()"));
});

test('chapter toggle is UI-only, accessible, physically unmounts navigation and never lies on narrow layouts', () => {
  assert(source.includes('const [chaptersVisible, setChaptersVisible] = useState(false)'));
  assert(source.includes("button(t('chaptersToggle'), () => setChaptersVisible(value => !value), { 'aria-expanded': chaptersVisible, 'aria-controls': formId.current + '-chapters' })"));
  assert(source.includes("chaptersVisible && !folded && h('nav', { id: formId.current + '-chapters'"));
  assert(region("h('header', { id: formId.current + '-controls', hidden: folded, className: 'mx-header'", '          error &&').includes("button(t('chaptersToggle')"), 'Navigation toggle remains in the expanded header; the always-reachable surface bar restores the folded control group');
  assert(source.includes("'data-chapters': chaptersVisible"));
  assert.equal(rule('.mx-grid').match(/grid-template-columns:([^;]+)/)?.[1], 'minmax(0,1fr)');
  assert(rule('.mx-grid[data-chapters=true]').includes('minmax(150px,230px) minmax(0,1fr)'));
  assert(!css.includes('.mx-chapter-nav{display:none}'));
  assert(css.includes('@container(max-width:850px){.mx-grid[data-chapters=true]{grid-template-columns:minmax(0,1fr);grid-template-rows:'));
  const toggle = source.match(/button\(t\('chaptersToggle'\)[^\n]+/)[0];
  for (const forbidden of ['changeChapter', 'commit(', 'mutate', 'localStorage', 'generate']) assert(!toggle.includes(forbidden));
});

test('clean book header has no saved pill or dead save control, while dirty save/discard and Ctrl+S remain', () => {
  const header = region("h('header', { id: formId.current + '-controls', hidden: folded, className: 'mx-header'", '          error &&');
  assert(header.includes("w && anyDirty && h('div', { className: 'mx-stack mx-save-controls' }"));
  assert(header.includes("status(t('unsaved'), 'warn')"));
  assert(!header.includes("t('saved')"));
  assert(header.includes("button(busy ? t('working') : t('save'), saveAll"));
  assert(header.includes("button(t('discard')"));
  assert(source.includes("if (isDirty(current.current) && !busyRef.current) saveAll()"));
});

test('non-writing tabs, recovery/error flows and short viewports retain an accessible scroll path', () => {
  assert(rule('.mx-root').includes('overflow:auto'));
  const gate = source.match(/const writingLayout = ([^;]+);/)[1];
  for (const marker of ["tab === 'writing'", '!!chapter', '!d.candidate', '!recovery', '!conflict', '!error', '!deletionNotice', '!storageFailed', 'cleanupPendingCount === 0']) assert(gate.includes(marker), marker);
  assert(source.includes("className: 'mx-root' + (writingLayout ? ' mx-root-writing' : '')"));
  assert(css.includes('@media(max-height:640px){.mx-root.mx-root-writing{display:block;overflow:auto}'));
  assert(css.includes('.mx-root-writing .mx-writing-host{min-height:28rem}'));
  assert(rule('.mx-partner-advanced').includes('max-height:28%'));
  assert(rule('.mx-partner-advanced').includes('flex:0 0 auto'), 'Expanded controls cannot shrink to an unreachable zero-height pane');
  assert(rule('.mx-writing-column').includes('overflow:auto'));
  assert(rule('.mx-editor-panel').includes('min-height:20rem'), 'Crowded control budgets cannot zero the editor; allocated column scrolls instead');
  assert(rule('.mx-book-tools').includes('overflow:auto'));
  assert(source.includes("h('details', { hidden: folded, className: 'mx-book-tools' }, h('summary', null, t('bookTools'))"));
  assert(source.includes("h('footer', { className: 'mx-foot mx-stack' }"));
  assert(source.includes("recovery && h('section'"));
  assert(source.includes('renderConflict()'));
});

test('author callbacks preserve all original bytes except decision-time view capture and guarded post-success queue', () => {
  // SHA-256 from the actual ../inspiration-0.1.6-source.zip client regions.
  assert.equal(hash(region('    const equal =', '    const en =')), 'a7ff890af715dad5a9e74555a7e1b0b383e2f26a560b3dff3da072192fbfb534');
  const callbacks = region('          const applyPolish =', '          useEffect(');
  const capture = '              const returnAnchor = capturePolishReturn(snapshot);\n';
  const viewHook = 'queuePolishViewport(snapshot, saved, accept, returnAnchor); ';
  assert.equal(callbacks.split(capture).length - 1, 1);
  assert.equal(callbacks.split(viewHook).length - 1, 1);
  assert(callbacks.indexOf(capture) > callbacks.indexOf('if (problem) throw') && callbacks.indexOf(capture) < callbacks.indexOf('const saved = await mutateRaw('));
  assert(callbacks.includes('if (alive.current && saved) { ' + viewHook), 'Viewport work is queued only after a checked successful durable response');
  assert(callbacks.indexOf(viewHook) > callbacks.indexOf('const saved = await mutateRaw('));
  assert.equal(hash(callbacks.replace(capture, '').replace(viewHook, '')), '9312b2aa0cae51f1beddf899098f4a0cba91a1ad4e98bfc118e624335efa6202', 'Removing only the two precisely placed view operations reproduces every original author check and payload byte-for-byte');
  for (const marker of ["action: 'acceptRevisionAll'", 'bulkRevisionProblem', 'generatedActionProblem', 'polishActionProblem', 'revisionActionProblem', 'visibleReviewProblem']) assert(source.includes(marker));
});
