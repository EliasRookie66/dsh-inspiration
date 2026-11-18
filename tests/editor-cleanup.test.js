import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createBook, mutateBook, buildContext } from '../core.js';
// Source/pure-data contracts only, not a DOM renderer or screenshot assertion.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('          const renderEditor ='), end = source.indexOf('          const renderModelPicker =', start);
assert(start > 0 && end > start);
const editor = source.slice(start, end);
function cleanContract(text) {
  const body = text.slice(text.indexOf('          const renderEditor ='), text.indexOf('          const renderModelPicker ='));
  for (const old of ["t('chapterOutline')", "hint: t('editorHint')", "t('noSelection')", "t('selected'", "t('chapterStatus')", "select('chapter', 'status'"]) assert(!body.includes(old), 'Removed editor chrome: ' + old);
  assert(!/padding-top:\s*64px/.test(text), 'No unconditional oversized macOS top padding');
  const toolbar = text.match(/\.mx-topbar\{([^}]+)\}/)?.[1];
  assert(toolbar?.includes('min-height:42px'), 'Toolbar preserves native-control row height');
  assert(toolbar?.includes('var(--dsh-frame-leading-clearance,0px)'), 'Toolbar preserves native leading clearance');
}
test('removed plan/hint/selection/status controls are absent while manuscript and review actions stay', () => {
  cleanContract(source);
  for (const marker of ["label: t('manuscript')", 'onSelect: captureSelection', 'onMouseUp: captureSelection', 'onKeyUp: captureSelection', 'onCompositionStart:', 'renderPolishPreview()', 'renderRevisionPreview()', 'renderGeneratedPreview()']) assert(editor.includes(marker), marker);
  assert.doesNotMatch(editor, /t\('summary'\)|textarea\('chapter', 'summary'/);
  assert(source.includes('const applyRevisionAll ='));
  assert(source.includes('const applyPolish ='));
});
test('header uses host horizontal chrome clearance instead of a full-width blank strip', () => {
  cleanContract(source);
  assert(source.includes("className: 'mx-topbar'"));
  assert(source.includes("t('chaptersToggle')"));
  assert(!editor.includes("t('chaptersToggle')"), 'Chapter navigation uses the pinned shared row');
  assert(!source.includes('transform:translateY'));
});
test('hidden outline/status remain in saved context and survive normal manuscript edits', () => {
  const helpers = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
  const ui = new Function(helpers + '\nreturn {workspace,patchOf};')();
  let book = mutateBook(createBook('隐藏控件不删除数据'), { action: 'addChapter', title: '本章' });
  const id = book.chapters[0].id;
  book = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body: '原正文😀\r\n下一行', outline: '保留本章隐藏计划', status: 'final' } });
  const w = ui.workspace(book, id), patch = ui.patchOf(w.baseChapter, { ...w.chapter, body: '作者新正文😀\r\n下一行' });
  assert.deepEqual(patch, { body: '作者新正文😀\r\n下一行' });
  const next = mutateBook(book, { action: 'updateChapter', chapterId: id, patch });
  assert.equal(next.chapters[0].outline, '保留本章隐藏计划'); assert.equal(next.chapters[0].status, 'final');
  assert(buildContext(next, id, { mode: 'draft' }).prompt.includes('保留本章隐藏计划'));
});
test('cleanup contract detects restored obsolete controls, whitespace and missing native clearance', () => {
  for (const [before, after] of [
    ["const renderEditor = () =>", "const renderEditor = () => /* t('chapterOutline') */"],
    ["const renderEditor = () =>", "const renderEditor = () => /* t('chapterStatus') */"],
    ["const renderEditor = () =>", "const renderEditor = () => /* hint: t('editorHint') */"],
    ['    const CSS = `', "    const CSS = `\nhtml[data-platform='darwin'] .mx-root{padding-top:64px}"],
    ['var(--dsh-frame-leading-clearance,0px)', '0px'],
    ['min-height:42px', 'min-height:12px'],
  ]) { assert(source.includes(before)); assert.throws(() => cleanContract(source.replace(before, after))); }
});
