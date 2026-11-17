import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createBook, mutateBook, makeProposal, buildContext } from '../core.js';
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
const ui = new Function(helpers + '\nreturn {workspace,revisionView,revisionPreviewDecision,polishPreviewDecision,generatedPreviewDecision,polishView,generatedReviewView};')();
// Evaluate the actual production visibility expression, not an invented DOM/React renderer.
const expression = source.match(/revisionPreviewVisible = ([^;]+);/)?.[1];
assert(expression);
const actualRevisionVisible = new Function('revisionDecision', 'revision', 'polishPreviewVisible', 'return ' + expression);
const modes = ['draft', 'continue', 'summary', 'polish', 'revise'];
function fixture(mode, unchanged = false) {
  let book = mutateBook(createBook('自动原位审阅隔离测试'), { action: 'addChapter' });
  const chapterId = book.chapters[0].id, body = '甲一。\r\n中段😀不变。\r\n乙二。\r\n中段不变。\r\n丙三。';
  book = mutateBook(book, { action: 'updateChapter', chapterId, patch: { body, summary: '已保存摘要' } });
  const start = body.indexOf('乙二'), selection = mode === 'polish' ? { start, end: start + 2, text: '乙二' } : null;
  const options = { mode, instruction: '保留事实，仅改善表达', selection };
  const text = mode === 'revise' ? unchanged ? body : '甲A。\r\n中段😀不变。\r\n乙B。\r\n中段不变。\r\n丙C。' : '本次生成内容😀';
  const proposal = makeProposal(book, chapterId, options, text, buildContext(book, chapterId, options), mode === 'revise' ? { analysis: '仅改三处。' } : {});
  book = mutateBook(book, { action: 'addProposal', proposal });
  return { book, chapterId, proposal: book.proposals[0], body };
}
function visible(book, chapterId, proposal, options = {}) {
  const w = ui.workspace(book, chapterId);
  if (options.dirty) w.chapter = { ...w.chapter, body: w.chapter.body + '未保存草稿' };
  const before = JSON.stringify(w);
  const decision = proposal.mode === 'revise' ? ui.revisionPreviewDecision(w, proposal, null, options) : proposal.mode === 'polish' ? ui.polishPreviewDecision(w, proposal, null, options) : ui.generatedPreviewDecision(w, proposal, null, options);
  assert.equal(JSON.stringify(w), before, 'A visibility calculation never writes or accepts text');
  return proposal.mode === 'revise' ? actualRevisionVisible(decision, ui.revisionView(proposal), false) : decision.visible;
}
for (const mode of modes) {
  test(`${mode}: current durable pending result appears inline automatically with no preview-entry click`, () => {
    const f = fixture(mode);
    assert(visible(f.book, f.chapterId, f.proposal));
    assert.equal(f.book.chapters[0].body, f.body, 'Displaying suggestions never saves them');
    for (const options of [{ dirty: true }, { recovery: {} }, { conflict: {} }]) assert.equal(visible(f.book, f.chapterId, f.proposal, options), false);
    const stale = mutateBook(f.book, { action: 'updateChapter', chapterId: f.chapterId, patch: { body: f.body + '作者已保存修改' } });
    assert.equal(visible(stale, f.chapterId, stale.proposals[0]), false, 'Never paint an old target over new manual prose');
  });
  for (const accept of [true, false]) test(`${mode}: ${accept ? 'approval' : 'rejection'} returns the same region to ordinary manuscript`, () => {
    const f = fixture(mode), action = accept ? mode === 'revise' ? 'acceptRevisionAll' : 'acceptProposal' : 'rejectProposal';
    const next = mutateBook(f.book, { action, proposalId: f.proposal.id });
    assert.equal(visible(next, f.chapterId, next.proposals[0]), false);
    if (!accept || mode === 'summary') assert.equal(next.chapters[0].body, f.body);
    if (accept && mode === 'summary') assert.equal(next.chapters[0].summary, f.proposal.text);
  });
}
test('accepted and rejected hunks become exact ordinary prose while remaining pending hunks stay inline', () => {
  const f = fixture('revise'), hunks = f.proposal.review.hunks;
  assert.equal(hunks.length, 3);
  let book = mutateBook(f.book, { action: 'acceptRevisionHunk', proposalId: f.proposal.id, hunkId: hunks[0].id });
  book = mutateBook(book, { action: 'rejectRevisionHunk', proposalId: f.proposal.id, hunkId: hunks[1].id });
  const p = book.proposals[0], view = ui.revisionView(p);
  assert(visible(book, f.chapterId, p));
  for (const piece of view.pieces.filter(p => p.kind === 'hunk')) assert.equal(piece.text, piece.hunk.state === 'rejected' ? piece.hunk.before : piece.hunk.after);
  const renderer = source.slice(source.indexOf('          const renderRevisionPreview ='), source.indexOf('          const renderEditor ='));
  const plain = renderer.indexOf("if (item.state !== 'pending') return h('span'");
  assert(plain > 0 && plain < renderer.indexOf("return h('section'"), 'Resolved pieces exit before diff decoration/actions/original rows');
});
test('zero-change result keeps editable body and its existing explicit dismiss action', () => {
  const f = fixture('revise', true);
  assert.equal(f.proposal.review.hunks.length, 0);
  assert.equal(visible(f.book, f.chapterId, f.proposal), false);
  assert(source.includes("'revisionDismissEmpty'"));
  assert(source.includes("{ action: 'rejectProposal', proposalId: proposal.id }"));
});
test('actual inline exception expression distinguishes malformed results from stale sources and prioritizes local drafts', () => {
  const expr = source.match(/const inlineReviewProblem = ([\s\S]*?);/)?.[1]; assert(expr);
  const message = new Function('proposal', 'bulkPreview', 'isRevision', 'revision', 'recovery', 'anyDirty', 'conflict', 'w', 'staleProposal', 'return ' + expr);
  const ready = { state: 'ready' }, w = {}, stale = () => true;
  assert.equal(message(ready, false, true, null, null, false, null, w, stale), 'revisionInvalid');
  assert.equal(message(ready, false, true, null, {}, false, null, w, stale), 'manageRecovery');
  assert.equal(message(ready, false, true, null, null, true, null, w, stale), 'saveFirst');
  assert.equal(message(ready, false, false, null, null, false, null, w, stale), 'stale');
  assert.equal(message(ready, true, false, null, null, false, null, w, stale), '');
  assert.equal(message({ state: 'accepted' }, false, false, null, null, false, null, w, stale), '');
  assert.equal(message(ready, false, true, { counts: { pending: 0 } }, null, false, null, w, stale), '');
});
function noManualEntry(text) {
  const editor = text.slice(text.indexOf('          const renderEditor ='), text.indexOf('          const renderModelPicker ='));
  for (const forbidden of ['mx-result-toggle', 'mx-review-notice', "'revisionOriginalHint'", "'revisionOpen'", "'polishOpen'", 'setOriginalReviewKey(', 'setOriginalPolishKey(']) assert(!editor.includes(forbidden), forbidden);
  assert(editor.includes('inlineReviewProblem'));
  assert(editor.includes('renderPolishPreview()') && editor.includes('renderRevisionPreview()') && editor.includes('renderGeneratedPreview()'));
}
test('no manual edit/review toggle or mode description remains; exceptional blockers stay inside body', () => {
  noManualEntry(source);
  assert(source.includes("? recovery ? 'manageRecovery' : anyDirty || conflict ? 'saveFirst' : isRevision && !revision ? 'revisionInvalid' : staleProposal(w, proposal) ? 'stale'"));
  assert(source.includes("className: 'mx-body-slot' }, inlineReviewProblem"));
  for (const marker of ['visibleReviewProblem', 'bulkRevisionProblem', 'generatedActionProblem', 'polishActionProblem', 'revisionActionProblem']) assert(source.includes(marker));
  for (const marker of ['mx-review-notice', "'revisionOpen'", "'polishOpen'"]) assert.throws(() => noManualEntry(source.replace('const renderEditor = () =>', `const renderEditor = () => /* ${marker} */`)));
});
