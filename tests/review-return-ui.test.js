import { legacyWorkspaceRegion } from './legacy-workspace-guard.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createBook, mutateBook, makeProposal, buildContext } from '../core.js';

// Run the actual author callback with real domain mutations and view-capability
// command adapters. No React, fake DOM tree, browser geometry or paid models.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const region = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const legacy = region('    const equal =', '    const en =');
const presentation = region('    function captureReviewReturn(', '    function Field(');
const f = new Function(legacy + presentation + '\nreturn {workspace,mergeWorkspace,polishActionSnapshot,polishActionProblem,visibleReviewProblem,captureReviewReturn,reviewReturnPlan,reviewReturnScroll,textareaValue};')();
const applyText = region('          const applyPolish =', '          const applyGenerated =');
const queueText = region('          const queuePolishViewport =', '          const applyPolish =');
function fixture() {
  let book = mutateBook(createBook('当前阅读位置'), { action: 'addChapter', title: '本章' });
  const chapterId = book.chapters[0].id;
  const body = '开头\r\n😀重复段。\r\n' + '长段\t保留。\n'.repeat(80) + '😀重复段。\r结尾';
  book = mutateBook(book, { action: 'updateChapter', chapterId, patch: { body } });
  const selection = { start: body.lastIndexOf('😀重复段。'), end: body.lastIndexOf('😀重复段。') + '😀重复段。'.length, text: '😀重复段。' };
  const request = { mode: 'polish', selection, instruction: '明确修改' };
  const proposal = makeProposal(book, chapterId, request, '😀新的段落。', buildContext(book, chapterId, request));
  book = mutateBook(book, { action: 'addProposal', proposal });
  const w = f.workspace(book, chapterId), snapshot = f.polishActionSnapshot(w, proposal);
  return { w, proposal, snapshot, body };
}
function callbackHarness(options = {}) {
  const data = fixture(), current = { current: data.w }, pendingPolishViewport = { current: null }, returnIntent = { current: 7 };
  const commands = [], errors = [], alive = { current: true }, busyRef = { current: false };
  const reviewRef = { current: { bookId: data.w.book.id, chapterId: data.w.chapterId, proposalId: data.proposal.id, visible: true, blocked: false } };
  const decisionMetrics = { screenY: 246, intent: 7, root: { top: 37, left: 0 }, panel: { top: 83, left: 4 }, column: { top: 19, left: 0 } };
  const job = options.session === 'fresh-job' ? { id: 'this-job', proposalId: data.proposal.id } : null;
  const polishViewportRef = { current: { bookId: data.w.book.id, chapterId: data.w.chapterId, jobId: 'this-job', scrollTop: 0, screenY: 12 } };
  // App closure inputs include current job and stale launch metadata. New
  // production queue intentionally ignores both; a reintroduced old gate fails.
  const queue = new Function('pendingPolishViewport', 'returnIntent', 'setRestoreEpoch', 'job', 'polishViewportRef', queueText + '\nreturn queuePolishViewport;')(pendingPolishViewport, returnIntent, update => { commands.push(['restoreEpoch', update(0)]); }, job, polishViewportRef);
  const deps = {
    current, reviewRef, alive, busyRef, job, polishViewportRef, loading: false, manager: null, guard: null, confirm: null, conflict: null,
    recoveryRef: { current: null }, deletedBookIds: new Set(), unavailableBooks: { current: new Map() },
    visibleReviewProblem: f.visibleReviewProblem, polishActionProblem: f.polishActionProblem, bookIsAvailable: () => true,
    t: key => key, setError: error => errors.push(error),
    capturePolishReturn: snapshot => {
      commands.push(['captureDecision', decisionMetrics.screenY]);
      // Deliberately no launch anchor and no job dependency: current reading Y wins.
      return f.captureReviewReturn(snapshot, current.current.book.proposals.find(p => p.id === snapshot.proposalId), decisionMetrics);
    },
    queuePolishViewport: (...args) => { commands.push(['queueAfterReceipt', args[3]?.screenY]); return queue(...args); },
    mutateRaw: async operation => {
      commands.push(['mutate', operation]);
      assert.deepEqual(Object.keys(operation).sort(), ['action', 'proposalId']);
      if (options.failIO) throw new Error('private mutate failed');
      const next = mutateBook(current.current.book, operation);
      current.current = f.mergeWorkspace(current.current, next);
      if (options.newIntent) returnIntent.current++;
      if (options.unmounted) alive.current = false;
      return options.noReceipt ? null : next;
    },
    withBusy: async action => {
      if (options.innerGuardFails) reviewRef.current.visible = false;
      try { return await action(); } catch (error) { errors.push(error); return false; }
    },
    setOriginalPolishKey: key => commands.push(['dismissPreview', key]), resetSelection: () => commands.push(['resetSelection']), setNotice: key => commands.push(['notice', key]),
  };
  if (options.outerGuardFails) busyRef.current = true;
  const declarations = 'const {' + Object.keys(deps).join(',') + '} = deps;';
  const apply = new Function('deps', declarations + applyText + '\nreturn applyPolish;')(deps);
  const context = () => {
    const active = current.current, chapter = active.book.chapters.find(c => c.id === active.chapterId);
    return { bookId: active.book.id, chapterId: active.chapterId, candidateId: active.candidateId, displayRecordId: data.proposal.id, intent: returnIntent.current,
      body: active.chapter.body, savedBody: chapter.body, chapter: JSON.stringify(chapter), proposal: active.book.proposals.find(p => p.id === data.proposal.id), dirty: false, blocked: false, reviewActive: false };
  };
  return { ...data, current, commands, errors, apply, pendingPolishViewport, context, decisionMetrics };
}

for (const accept of [false, true]) for (const session of ['historical-no-job', 'fresh-job']) test(`${session}: actual ${accept ? 'check' : 'cross'} callback queues current reading anchor after real core receipt`, async () => {
  const h = callbackHarness({ session });
  // App's actual callback/queue closures receive either a completed job or no
  // job after reselect/reload, plus obsolete launch metrics. Neither may gate
  // restoration or replace the current decision-time reading position.
  await h.apply(h.snapshot, accept);
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.commands.slice(0, 3).map(command => command[0]), ['captureDecision', 'mutate', 'queueAfterReceipt']);
  const pending = h.pendingPolishViewport.current;
  assert(pending);
  assert.equal(pending.anchor.screenY, 246, 'Decision-time current review Y, not launch-time scrollTop or Y');
  assert.equal(pending.anchor.jobId, undefined);
  const plan = f.reviewReturnPlan(pending.anchor, pending, h.context());
  assert(plan);
  assert.equal(plan.screenY, 246);
  assert.equal(plan.caret, f.textareaValue(h.body.slice(0, h.proposal.selection.start)).length);
  assert.equal(h.current.current.chapter.body, accept ? h.body.slice(0, h.proposal.selection.start) + h.proposal.text + h.body.slice(h.proposal.selection.end) : h.body);
  assert.deepEqual(plan.ports, [{ name: 'root', top: 37, left: 0 }, { name: 'panel', top: 83, left: 4 }, { name: 'column', top: 19, left: 0 }]);
});

for (const scenario of ['outerGuardFails', 'innerGuardFails', 'failIO', 'noReceipt', 'unmounted', 'newIntent']) test(`actual callback does not queue/focus after ${scenario}`, async () => {
  const h = callbackHarness({ [scenario]: true });
  await h.apply(h.snapshot, false);
  assert.equal(h.pendingPolishViewport.current, null);
  assert(!h.commands.some(command => command[0] === 'restoreEpoch'));
  if (scenario.endsWith('GuardFails')) assert(!h.commands.some(command => ['captureDecision', 'mutate', 'queueAfterReceipt'].includes(command[0])));
  if (scenario === 'failIO') assert(!h.commands.some(command => command[0] === 'queueAfterReceipt'));
});

test('acknowledged return plan blocks changed chapter/book/result/candidate, new review, new intent, dirty body and modal', async () => {
  const h = callbackHarness(); await h.apply(h.snapshot, false);
  const pending = h.pendingPolishViewport.current, context = h.context();
  for (const patch of [{ bookId: 'elsewhere' }, { chapterId: 'elsewhere' }, { candidateId: 'other' }, { displayRecordId: 'other' }, { intent: 8 }, { dirty: true }, { blocked: true }, { reviewActive: true }, { body: context.body + 'manual' }, { savedBody: context.savedBody + 'remote' }, { chapter: context.chapter + 'remote' }]) assert.equal(f.reviewReturnPlan(pending.anchor, pending, { ...context, ...patch }), null, JSON.stringify(patch));
  assert.equal(f.reviewReturnPlan(pending.anchor, pending, { ...context, proposal: { ...context.proposal, text: 'different' } }), null);
});

test('production scroll math places actual native caret near clicked Y, clamps resize/fold targets and never substitutes a cached zero', () => {
  const metrics = { caretTop: 1984, editorTop: 112, borderTop: 1, clientHeight: 480, scrollHeight: 5000, lineHeight: 30, paddingTop: 9, paddingBottom: 9 };
  const top = f.reviewReturnScroll(metrics, 246);
  assert.equal(top, 1851);
  assert.equal(metrics.editorTop + metrics.borderTop + metrics.caretTop - top, 246);
  assert.notEqual(top, 0);
  assert.equal(f.reviewReturnScroll(metrics, -999), 1975, 'Clamp target to visible padded top after fold/resize');
  assert.equal(f.reviewReturnScroll(metrics, 9999), 1543, 'Clamp to visible final line after resize');
  assert.equal(f.reviewReturnScroll({ ...metrics, caretTop: NaN }, 246), null);
  assert.equal(f.reviewReturnScroll({ ...metrics, clientHeight: 0 }, 246), null);
  assert.equal(f.reviewReturnScroll(null, 246), null);
});

test('production measurement mirrors full native prefix/rest styles inside an owned zero-footprint clipping wrapper', () => {
  const helper = region('    function measureTextareaCaret(', '    function Field(');
  for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'wordBreak', 'overflowWrap']) assert(helper.includes(property));
  assert(helper.includes("width: editor.clientWidth + 'px'"));
  assert(helper.includes("whiteSpace: editor.wrap === 'off' ? 'pre' : computed.whiteSpace"));
  assert(helper.includes('editor.value.slice(0, caret)'));
  assert(helper.includes("marker.textContent = editor.value.slice(caret) ||"));
  assert(helper.includes("width: '0', height: '0', overflow: 'hidden', contain: 'strict'"));
  assert(helper.includes('clip.appendChild(mirror)'));
  assert(helper.includes('ownedRoot.appendChild(clip)'));
  assert(helper.includes('finally { clip.remove(); }'));
  assert(!helper.includes('document.body') && !helper.includes('React'));
});

test('layout restoration waits for receipt epoch and native mount, restores ports and sets measured native scrollTop last', () => {
  const effect = region('          useLayoutEffect(() => {\n            const pending = pendingPolishViewport.current;', '          const formatDate =');
  assert(effect.includes('if (!pending || busy || loading) return'));
  assert(effect.includes('[restoreEpoch,'));
  assert(effect.includes('reviewReturnPlan('));
  assert(effect.includes('displayRecordId: displayRecord?.id'));
  assert(effect.includes('reviewActive: polishPreviewVisible || revisionPreviewVisible || generatedManuscript'));
  assert(effect.includes('editor.value !== textareaValue(pending.expectedBody)'));
  assert(effect.indexOf('restorePorts();') < effect.indexOf('measureTextareaCaret('));
  assert(effect.includes('try { measured = measureTextareaCaret('));
  assert(effect.includes('if (!measured) return'));
  assert(effect.includes('editor.focus({ preventScroll: true })'));
  assert(effect.includes('editor.setSelectionRange(plan.caret, plan.caret)'));
  assert(effect.lastIndexOf('restorePorts();') > effect.indexOf('editor.setSelectionRange'));
  assert(effect.indexOf('editor.scrollTop = scrollTop') > effect.lastIndexOf('restorePorts();'));
  assert(effect.indexOf('pendingPolishViewport.current = null;', effect.indexOf('editor.scrollTop = scrollTop')) > effect.indexOf('editor.scrollTop = scrollTop'));
  assert(!effect.includes('plan.scrollTop') && !effect.includes('jobId:'));
});

test('new generation/navigation invalidate UI intent while selected source display and all author guards remain intact', () => {
  assert(source.includes('const invalidateReviewReturn = () => { returnIntent.current++; pendingPolishViewport.current = null; }'));
  assert(region('          const transition =', '          const changeChapter =').includes('invalidateReviewReturn()'));
  assert(region('          const startPolish =', '          const contextKey =').includes('invalidateReviewReturn()'));
  assert(!source.includes('polishViewportRef') && !source.includes('anchor.jobId'));
  assert(source.includes("'data-proposal-id': polishRecord.id"));
  const capture = region('          const capturePolishReturn =', '          const queuePolishViewport =');
  assert(capture.includes('block.getBoundingClientRect().top'));
  assert(capture.includes('block.dataset.proposalId !== snapshot.proposalId'));
  const polish = region('          const renderPolishPreview =', '          const renderSelectionPopup =');
  assert(polish.includes('mx-polish-new') && polish.includes('mx-polish-original'), 'Keep latest green/new plus red/source evidence unchanged');
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(legacyWorkspaceRegion(source)), '11a7db1f41b1c65f324fb5ce1c9fc2b4d770f3dccec8c8b1370c2b0f18d3c2c6');
  assert.equal(hash(region('    const textareaValue =', '    const en =')), '8b05aafaa77dc626c68aa6812c80350c2cb9e33c9ecc5bcbceffab43456c8148', 'Constraint settings/recovery additions cannot alter source/author/native-text helpers');
  const callbacks = region('          const applyPolish =', '          useEffect(').replace('              const returnAnchor = capturePolishReturn(snapshot);\n', '').replace('queuePolishViewport(snapshot, saved, accept, returnAnchor); ', '');
  assert.equal(hash(callbacks), '59e913af925fb7b5364da9a05f01d4a9968e9de7c8d60e5547302e3a1cc71792', 'Retain the audited author checks and duplicate-click guard');
});
