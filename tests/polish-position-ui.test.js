import { legacyWorkspaceRegion } from './legacy-workspace-guard.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createBook, mutateBook, makeProposal, buildContext } from '../core.js';

// Actual renderer-free client helpers plus explicit static wiring contracts.
// No DOM emulation or claim of live browser/visual positioning coverage.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const legacy = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
const view = source.slice(source.indexOf('    function captureReviewReturn('), source.indexOf('    function Field('));
const f = new Function(legacy + view + '\nreturn {captureReviewReturn,reviewReturnPlan,reviewReturnScroll,textareaValue,workspace,polishView,polishActionSnapshot};')();
const region = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const sha = text => createHash('sha256').update(text).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(accept = false) {
  let book = mutateBook(createBook('位置'), { action: 'addChapter', title: '本章' });
  const chapterId = book.chapters[0].id, body = '前文\r\n😀重复句\r第二段\r\n😀重复句\r\n尾声';
  book = mutateBook(book, { action: 'updateChapter', chapterId, patch: { body } });
  const start = body.lastIndexOf('😀重复句');
  const selection = { start, end: start + '😀重复句'.length, text: '😀重复句' };
  const request = { mode: 'polish', selection, instruction: '自然表达' };
  const proposal = makeProposal(book, chapterId, request, '😀新的表达', buildContext(book, chapterId, request));
  book = mutateBook(book, { action: 'addProposal', proposal });
  const ready = book.proposals[0], snapshot = f.polishActionSnapshot(f.workspace(book, chapterId), ready);
  const metrics = { screenY: 250, intent: 7, root: { top: 44, left: 0 }, panel: { top: 73, left: 0 }, column: { top: 29, left: 3 } };
  const anchor = f.captureReviewReturn(snapshot, ready, metrics);
  book = mutateBook(book, { action: accept ? 'acceptProposal' : 'rejectProposal', proposalId: proposal.id });
  const record = book.proposals[0], saved = book.chapters[0];
  const settlement = { proposalId: record.id, proposal: JSON.stringify(record), accept, expectedBody: saved.body, chapter: JSON.stringify(saved) };
  const context = { bookId: book.id, chapterId, candidateId: snapshot.candidateId, displayRecordId: ready.id, intent: 7, body: saved.body, savedBody: saved.body, chapter: JSON.stringify(saved), proposal: record, dirty: false, blocked: false, reviewActive: false };
  return { anchor, settlement, context, snapshot, ready, selection, metrics, source: body };
}

for (const accept of [false, true]) test(`${accept ? 'accept' : 'reject'} uses current review coordinates and native caret without a launch job`, () => {
  const { anchor, settlement, context, selection, source: original } = fixture(accept);
  const plan = f.reviewReturnPlan(anchor, settlement, context);
  assert(plan, 'Historical and reselected results need no retained job');
  assert.equal(plan.caret, f.textareaValue(original.slice(0, selection.start)).length);
  assert(plan.caret < selection.start, 'CRLF native offsets differ from immutable raw UTF16 offsets');
  assert.equal(plan.screenY, 250);
  assert.equal(f.reviewReturnScroll({ caretTop: 1500, editorTop: 120, borderTop: 1, clientHeight: 400, scrollHeight: 4000, lineHeight: 30, paddingTop: 10, paddingBottom: 10 }, plan.screenY), 1371);
  assert.deepEqual(plan.ports, [{ name: 'root', top: 44, left: 0 }, { name: 'panel', top: 73, left: 0 }, { name: 'column', top: 29, left: 3 }]);
  assert.equal(context.body, accept ? original.slice(0, selection.start) + context.proposal.text + original.slice(selection.end) : original);
});

test('capture is immutable view-only metadata and rejects unsafe CRLF/surrogate boundaries', () => {
  const { snapshot, ready, metrics } = fixture(), before = JSON.stringify(snapshot);
  const anchor = f.captureReviewReturn(snapshot, ready, metrics);
  assert(Object.isFrozen(anchor) && Object.isFrozen(anchor.ports) && Object.isFrozen(anchor.ports[0]));
  assert.equal(anchor.screenY, 250); assert.equal(JSON.stringify(snapshot), before);
  const invalid = { ...ready, selection: { ...ready.selection, start: ready.selection.start + 1, text: ready.selection.text.slice(1) } };
  assert.equal(f.captureReviewReturn({ ...snapshot, proposal: JSON.stringify(invalid) }, invalid, metrics), null);
  assert.equal(f.captureReviewReturn(snapshot, ready, { ...metrics, screenY: NaN }), null);
  assert.equal(f.captureReviewReturn(snapshot, ready, { ...metrics, intent: 0.5 }), null);
});

test('changed visible result/intent/book/chapter, drafts, modal and stale source never produce focus plans', () => {
  const { anchor, settlement, context } = fixture();
  assert(f.reviewReturnPlan(anchor, settlement, context), 'Current decision anchor works without any launch-session/job identity');
  for (const patch of [{ bookId: 'other' }, { chapterId: 'other' }, { candidateId: 'other' }, { displayRecordId: 'other' }, { intent: 8 }, { reviewActive: true }, { dirty: true }, { blocked: true }, { body: context.body + '手写' }, { savedBody: context.savedBody + '远端' }, { chapter: context.chapter + 'changed' }]) assert.equal(f.reviewReturnPlan(anchor, settlement, { ...context, ...patch }), null, JSON.stringify(patch));
  for (const patch of [{ sourceBody: context.proposal.sourceBody + 'changed' }, { sourceRevision: context.proposal.sourceRevision + 1 }, { state: 'ready' }, { id: 'other' }, { selection: { ...context.proposal.selection, start: 0 } }]) assert.equal(f.reviewReturnPlan(anchor, settlement, { ...context, proposal: { ...context.proposal, ...patch } }), null);
  assert.equal(f.reviewReturnPlan(null, settlement, context), null, 'A decision must still match an actual visible review, even without a job');
  assert.equal(f.reviewReturnPlan(anchor, { ...settlement, expectedBody: 'fabricated' }, context), null);
});

test('UI restoration plans never change manuscript, proposal or source identity', () => {
  const data = fixture(), before = JSON.stringify(data);
  for (let index = 0; index < 5; index++) f.reviewReturnPlan(data.anchor, data.settlement, data.context);
  assert.equal(JSON.stringify(data), before);
  const changed = copy(data); changed.context.proposal.text += 'different';
  assert.equal(f.reviewReturnPlan(changed.anchor, changed.settlement, changed.context), null);
});

test('current decision captures after both author gates, before mutation, and only acknowledged success queues restoration', () => {
  assert(source.includes("button(t('polishAI'), () => startPolish(selectionPopup.snapshot, t('polishDefaultDirection'))"));
  const action = region('          const applyPolish =', '          const applyGenerated =');
  assert(action.includes('const returnAnchor = capturePolishReturn(snapshot);'));
  assert(action.includes('if (alive.current && saved) { queuePolishViewport(snapshot, saved, accept, returnAnchor);'));
  assert(action.indexOf('capturePolishReturn(snapshot)') > action.indexOf('if (problem) throw'));
  assert(action.indexOf('capturePolishReturn(snapshot)') < action.indexOf('await mutateRaw('));
  assert(action.indexOf("await mutateRaw({ action: accept ? 'acceptProposal' : 'rejectProposal'") < action.indexOf('queuePolishViewport('));
  assert.equal((action.match(/polishActionProblem\(current.current/g) || []).length, 2);
  assert.equal((action.match(/visibleReviewProblem\(snapshot, reviewRef.current\)/g) || []).length, 2);
  const queue = region('          const queuePolishViewport =', '          const applyPolish =');
  assert(!queue.includes('job') && !queue.includes('polishViewportRef'), 'No dependency on a lost launch job/session anchor');
});

test('layout-effect scheduling uses an explicit restore epoch, collapsed native caret and positions last', () => {
  const effect = region('          useLayoutEffect(() => {\n            const pending = pendingPolishViewport.current;', '          const formatDate =');
  assert(effect.includes('if (!pending || busy || loading) return'));
  assert(effect.includes('reviewReturnPlan('));
  assert(effect.includes('measureTextareaCaret(editor, plan.caret, rootRef.current)'));
  assert(effect.includes('if (!measured) return'));
  assert(effect.includes('editor.value !== textareaValue(pending.expectedBody)'));
  assert(effect.includes('editor.focus({ preventScroll: true })'));
  assert(effect.includes('editor.setSelectionRange(plan.caret, plan.caret)'));
  assert(effect.indexOf('editor.scrollTop = scrollTop') > effect.indexOf('editor.setSelectionRange'));
  assert(effect.lastIndexOf('restorePorts();') > effect.indexOf('editor.setSelectionRange'));
  assert(effect.includes('reviewReturnScroll(metrics(), plan.screenY)'));
  const measurement = region('    function measureTextareaCaret(', '    function Field(');
  assert(measurement.includes("width: '0', height: '0', overflow: 'hidden', contain: 'strict'"), 'Full manuscript measurement must not alter owned scrollable overflow');
  assert(measurement.includes('finally { clip.remove(); }'));
  assert(measurement.includes('editor.clientWidth') && measurement.includes('editor.value.slice(0, caret)') && measurement.includes('editor.value.slice(caret)'));
  assert(effect.includes('[restoreEpoch,'));
  assert(source.includes('setRestoreEpoch(value => value + 1)'));
  assert(!effect.includes('requestAnimationFrame') && !effect.includes('setTimeout'));
});

test('selected polish keeps green placeholder/result then red immutable original throughout review without duplicate title/status', () => {
  const render = region('          const renderPolishPreview =', '          const renderSelectionPopup =');
  assert(render.includes('mx-polish-new'));
  assert(render.includes("renderVisibleText(polish.newText, polish.durable ? 'revisionDeleted' : 'polishProgress')"));
  for (const forbidden of ["h('h3'", 'polishAwaitProposal', "role: 'status'"]) assert(!render.includes(forbidden), forbidden);
  const originalNode = "h('div', { className: 'mx-polish-original mx-revision-text', role: 'note', 'aria-label': t('originalPassage') }, renderVisibleText(polish.original, 'empty'))";
  assert(render.includes(originalNode), 'Original is an unconditional sibling, not gated on output/durable/status');
  assert.equal(render.split('renderVisibleText(polish.original').length - 1, 1);
  assert(render.indexOf('renderVisibleText(polish.newText') < render.indexOf(originalNode));
  assert(source.includes('.mx-diff-old,.mx-polish-original{border-inline-start:2px solid var(--dsw-alias-state-error-primary)'));
  assert(render.includes("polish.durable && polishRecord.state === 'ready' && renderPolishActions"));
  assert(source.includes("polishProgress: '正在润色...'"));
  assert(source.includes("(running || awaitingOutcome) && job?.mode !== 'polish'"));
  const revise = region('          const renderRevisionPreview =', '          const renderEditor =');
  assert(revise.includes('renderVisibleText(item.before)') && revise.includes('renderOriginalContext(proposal.sourceBody, item)'));
});

test('waiting, streaming, completion-gap and durable-ready retain the exact selected source', () => {
  let book = mutateBook(createBook('四阶段原文对照'), { action: 'addChapter' });
  const chapterId = book.chapters[0].id, body = '首段\r\n重复😀\r\n中间\r\n重复😀\r\n尾声';
  book = mutateBook(book, { action: 'updateChapter', chapterId, patch: { body } });
  const start = body.lastIndexOf('重复😀'), selection = { start, end: start + '重复😀'.length, text: '重复😀' };
  const request = { mode: 'polish', selection, instruction: '保持含义' };
  const proposal = makeProposal(book, chapterId, request, '新的表达', buildContext(book, chapterId, request));
  for (const [status, text] of [['running', ''], ['running', '新的'], ['completed', '新的表达']]) {
    const view = f.polishView(f.workspace(book, chapterId), { id: 'job', bookId: book.id, chapterId, mode: 'polish', sourceRevision: book.chapters[0].revision, selection, status, text });
    assert.equal(view.original, selection.text); assert.equal(view.prefix + view.original + view.suffix, body);
    assert.equal(view.newText, text); assert.equal(view.durable, false); assert.equal(book.chapters[0].body, body);
  }
  book = mutateBook(book, { action: 'addProposal', proposal });
  const ready = f.polishView(f.workspace(book, chapterId), book.proposals[0]);
  assert.equal(ready.original, selection.text); assert.equal(ready.durable, true); assert.equal(book.chapters[0].body, body);
});

test('task and requirements share a wide content row, while actions stay pinned on all widths', () => {
  assert(source.includes("instruction: '要求'"));
  assert(source.includes('.mx-partner-row{display:grid;grid-template-columns:minmax(9rem,.65fr) minmax(11rem,2fr)'));
  assert(source.includes('.mx-partner-row{grid-template-columns:minmax(0,1fr)}'));
  const toolbar = region('          const renderTopbar =', "          return h('main'");
  assert(toolbar.includes("tab === 'writing' && chapter && renderWritingActions()"));
});

test('focus writing preserves manuscript and AI inputs and keeps critical actions outside hidden task fields', () => {
  assert(source.includes('const folded = controlsFolded && writingLayout'));
  assert(source.includes("hidden: folded, id: formId.current + '-writing-task'"));
  const header = region('          const renderTopbar =', '          const renderCurrentPage =');
  assert(header.includes("pageButton('context', 'context'), pageButton('advanced', 'advanced')"));
  assert(!header.includes('!folded'));
  assert(source.includes('.mx-root [hidden]{display:none!important}'));
  const editor = region('          const renderEditor =', '          const renderModelPicker =');
  assert.match(editor, /key: 'chapter-bar'[\s\S]*key: 'manuscript'/);
  assert.doesNotMatch(editor.slice(editor.indexOf("key: 'manuscript'")), /folded/);
  const critical = region('          const renderFoldedCritical =', '          const renderTopbar =');
  for (const marker of ["t('saveNow'), saveAll", "t('discard')", "t('downloadLocal'), downloadLocal", "t('approveAll')", "t('cancelJob')", "['failed', 'cancelled']", "toolbarButton('refresh', t('retry')"]) assert(critical.includes(marker), marker);
  assert(source.includes('folded && renderFoldedCritical()'));
  assert(source.includes('.mx-controls-folded .mx-writing-column{overflow:auto'));
});

test('a single focus-toggle icon stays available in both modes and restores focus', () => {
  const actions = region('          const renderWritingActions =', '          const renderTopbar =');
  assert.match(actions, /folded \? 'expand' : 'focus'[\s\S]*focusWriting\(!folded\)/);
  assert.match(actions, /'aria-expanded': !folded, 'aria-controls': taskId/);
  assert(source.includes('foldButtonRef.current?.focus({ preventScroll: true })'));
  assert(!source.includes('mx-controls-collapse'));
});

test('immutable source/offset helpers and the audited author callbacks retain their protected code', () => {
  assert.equal(sha(legacyWorkspaceRegion(source)), '11a7db1f41b1c65f324fb5ce1c9fc2b4d770f3dccec8c8b1370c2b0f18d3c2c6');
  assert.equal(sha(region('    const textareaValue =', '    const en =')), '8b05aafaa77dc626c68aa6812c80350c2cb9e33c9ecc5bcbceffab43456c8148', 'Only constraint settings/recovery change; original source/offset/review algebra is intact');
  const callbacks = region('          const applyPolish =', '          useEffect(')
    .replace('              const returnAnchor = capturePolishReturn(snapshot);\n', '')
    .replace('queuePolishViewport(snapshot, saved, accept, returnAnchor); ', '');
  assert.equal(sha(callbacks), '59e913af925fb7b5364da9a05f01d4a9968e9de7c8d60e5547302e3a1cc71792');
});
