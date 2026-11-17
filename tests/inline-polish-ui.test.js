import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createBook, mutateBook, makeProposal, buildContext } from '../core.js';

// Actual renderer-independent client helpers, extracted without evaluating the
// module factory, React, a fake DOM, browser, screenshots or any model calls.
// Source-wiring checks below are explicitly NOT visual or interaction tests.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
const names = 'workspace,dirty,isDirty,textareaValue,sourceOffsets,capturePolishSnapshot,polishIntentProblem,polishView,polishDisplayRecord,polishPreviewDecision,polishActionSnapshot,polishActionProblem,selectionPopupDecision,selectionPopupPosition';
const extract = text => new Function(text + '\nreturn {' + names + '};')();
const f = extract(helpers), copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
  let book = mutateBook(createBook('原位润色'), { action: 'addChapter', title: '本章' });
  const id = book.chapters[0].id;
  const body = '开头\r\n她说：“好。”\r\n😀她说：“好。”\r\n末尾\r保留\n结束';
  book = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body } });
  const w = f.workspace(book, id), nativeStart = f.textareaValue(body).lastIndexOf('她说');
  const snapshot = f.capturePolishSnapshot(w, nativeStart, nativeStart + '她说：“好。”'.length);
  const selection = { start: snapshot.start, end: snapshot.end, text: snapshot.text };
  const request = { mode: 'polish', instruction: '对白自然，保留原意', selection };
  const proposal = makeProposal(book, id, request, '她轻声说：“你终于来了。”', buildContext(book, id, request));
  book = mutateBook(book, { action: 'addProposal', proposal });
  const ready = f.workspace(book, id);
  const job = { id: 'running-job', bookId: book.id, chapterId: id, mode: 'polish', sourceRevision: proposal.sourceRevision, selection, status: 'running', text: '' };
  return { book, w: ready, snapshot: f.capturePolishSnapshot(ready, nativeStart, nativeStart + selection.text.length), proposal, job, body, id };
}

const drafts = w => [
  { ...w, chapter: { ...w.chapter, body: w.chapter.body + '作者手稿' } },
  { ...w, chapter: { ...w.chapter, summary: '手写摘要' } },
  { ...w, settings: { ...w.settings, style: '本地文风' } },
  { ...w, card: { title: '本地卡片' }, baseCard: null },
  { ...w, candidate: w.candidate + '尚未保存的候选编辑' },
];

test('immutable capture maps native LF selection to the second repeated raw UTF16 range without CRLF normalization', () => {
  const { w, snapshot, body } = fixture();
  assert(Object.isFrozen(snapshot));
  assert(Object.values(snapshot).every(value => value === null || typeof value !== 'object'));
  assert.equal(snapshot.start, body.lastIndexOf('她说'));
  assert.equal(snapshot.end, snapshot.start + '她说：“好。”'.length);
  assert.equal(snapshot.body, body);
  assert.equal(snapshot.bookRevision, w.book.revision);
  assert.equal(snapshot.chapterRevision, w.book.chapters[0].revision);
  assert(snapshot.start > body.indexOf('她说'));
  const normalized = f.textareaValue(body), emoji = normalized.indexOf('😀');
  const emojiCapture = f.capturePolishSnapshot(w, emoji, emoji + 2);
  assert.equal(emojiCapture.text, '😀');
  assert.equal(emojiCapture.end - emojiCapture.start, 2);
  const multiline = f.capturePolishSnapshot(w, 0, normalized.length);
  assert.equal(multiline.text, body);
  assert.equal(multiline.end, body.length);
});

test('empty, out of range and surrogate-splitting selections do not create a polish intent', () => {
  const { w, body } = fixture(), emoji = f.textareaValue(body).indexOf('😀');
  for (const [start, end] of [[0, 0], [-1, 2], [1, 9999], [2, 1], [0.5, 2], [emoji + 1, emoji + 2], [emoji, emoji + 1]]) {
    assert.equal(f.capturePolishSnapshot(w, start, end), null);
  }
  assert.equal(f.capturePolishSnapshot(null, 0, 1), null);
});

test('fresh capture is valid, but any dirty draft, source revision, navigation, recovery or conflict blocks API intent', () => {
  const { w, snapshot } = fixture();
  assert.equal(f.polishIntentProblem(w, snapshot), '');
  for (const draft of drafts(w)) assert(f.polishIntentProblem(draft, snapshot));
  const unsaved = { ...w, chapter: { ...w.chapter, body: '尚未保存的新正文' } };
  const draftIntent = f.capturePolishSnapshot(unsaved, 0, 4);
  assert.equal(f.polishIntentProblem(unsaved, draftIntent), 'saveFirst', 'Reselecting unsaved prose cannot fix the saved-source guard; explain manual Save instead');
  assert.equal(f.polishIntentProblem(unsaved, draftIntent, { recovery: {} }), 'manageRecovery');
  for (const change of [
    next => { next.book.id = 'another'; }, next => { next.book.revision++; },
    next => { next.chapterId = 'another'; }, next => { next.book.chapters[0].revision++; },
    next => { next.book.chapters[0].body += 'remote'; },
  ]) { const next = copy(w); change(next); assert.equal(f.polishIntentProblem(next, snapshot), 'selectionChanged'); }
  assert.equal(f.polishIntentProblem(w, snapshot, { recovery: {} }), 'manageRecovery');
  assert.equal(f.polishIntentProblem(w, snapshot, { conflict: {} }), 'saveFirst');
  assert.equal(f.polishIntentProblem(w, snapshot, { busy: true }), 'working');
  assert.equal(f.polishIntentProblem(w, snapshot, { running: true }), 'polishBusy');
  assert.equal(f.polishIntentProblem(w, snapshot, { unavailable: true }), 'bookMissing');
  assert.equal(f.polishIntentProblem(w, snapshot, { composing: true }), 'polishComposing');
  for (const reason of ['modelUnsaved', 'modelSettingsConflict', 'modelSaving', 'modelRouteUnavailable', 'noModel']) {
    assert.equal(f.polishIntentProblem(w, snapshot, { modelProblem: reason }), reason);
  }
});

test('a newly captured same-body selection invalidates old popup/custom intent instead of retargeting it', () => {
  const { w, snapshot, body } = fixture();
  const firstStart = f.textareaValue(body).indexOf('她说');
  const nextIntent = f.capturePolishSnapshot(w, firstStart, firstStart + snapshot.text.length);
  assert.equal(nextIntent.text, snapshot.text);
  assert.notEqual(nextIntent.start, snapshot.start);
  assert.equal(f.polishIntentProblem(w, snapshot, { intent: nextIntent }), 'selectionChanged');
  assert.equal(f.polishIntentProblem(w, snapshot, { intent: null }), 'selectionChanged');
  assert.equal(f.polishIntentProblem(w, snapshot, { intent: snapshot }), '');
  assert.equal(snapshot.start, body.lastIndexOf('她说'), 'Old snapshot itself never moves to first repeated occurrence');
});

test('first frame and partial stream overlay exact unchanged source with new block first and original selected text below', () => {
  const { w, job, body } = fixture();
  const before = JSON.stringify(w);
  for (const text of ['', '她轻声', '她轻声说：\r\n“你终于来了。”']) {
    const view = f.polishView(w, { ...job, text });
    assert(view);
    assert.equal(view.durable, false);
    assert.equal(view.prefix, body.slice(0, job.selection.start));
    assert.equal(view.original, job.selection.text);
    assert.equal(view.suffix, body.slice(job.selection.end));
    assert.equal(view.preview, view.prefix + text + view.suffix);
    assert.deepEqual(view.pieces, [{ kind: 'unchanged', text: view.prefix }, { kind: 'polish', text, before: job.selection.text }, { kind: 'unchanged', text: view.suffix }]);
    assert.equal(view.pieces.map(piece => piece.text).join(''), view.preview);
    assert(view.prefix.includes('她说：“好。”'), 'First repeated passage is untouched');
  }
  assert.equal(JSON.stringify(w), before, 'Streams never mutate manuscript, candidate or baseline');
});

test('durable proposal reconstructs exact full source and completion-gap records cannot acquire author controls', () => {
  const { w, proposal, job, body } = fixture();
  const view = f.polishView(w, proposal);
  assert.equal(view.durable, true);
  assert.equal(view.preview, body.slice(0, proposal.selection.start) + proposal.text + body.slice(proposal.selection.end));
  assert.equal(view.pieces[1].before, proposal.selection.text);
  const newJob = { ...job, id: 'new-job', text: '新任务的部分输出' };
  assert.equal(f.polishDisplayRecord(w, proposal, newJob), newJob);
  assert.equal(f.polishView(w, f.polishDisplayRecord(w, proposal, newJob)).durable, false);
  const gap = { ...newJob, status: 'completed', proposalId: 'not-fetched' };
  assert.equal(f.polishDisplayRecord(w, proposal, gap), gap);
  assert.equal(f.polishView(w, gap).durable, false);
  assert.equal(f.polishActionSnapshot(w, gap), null, 'Completed job is not a durable proposal');
  assert.equal(f.polishActionProblem(w, f.polishActionSnapshot(w, gap)), 'confirmChanged');
  assert.equal(f.polishDisplayRecord(w, proposal, { ...gap, proposalId: proposal.id }), proposal);
  assert.equal(f.polishDisplayRecord(w, proposal, { ...newJob, bookId: 'other' }), proposal);
});

test('job resume requires exact chapter source revision/range and never searches for repeated prose', () => {
  const { w, job } = fixture();
  for (const patch of [{ sourceRevision: job.sourceRevision + 1 }, { chapterId: 'other' }, { bookId: 'other' }, { mode: 'continue' },
    { selection: { ...job.selection, text: 'wrong' } }, { selection: { ...job.selection, start: 0 } }, { sourceRevision: 0 }]) {
    assert.equal(f.polishView(w, { ...job, ...patch }), null);
  }
  const changed = copy(w); changed.book.chapters[0].revision++; changed.book.chapters[0].body += 'manual';
  assert.equal(f.polishView(changed, job), null);
  assert.equal(f.polishPreviewDecision(changed, job, null).visible, false);
});

test('manual drafts, recovery and conflicts are never hidden by auto or explicit preview; newly stale proposals require explicit compare', () => {
  const { w, proposal } = fixture(), clean = f.polishPreviewDecision(w, proposal, null);
  assert.equal(clean.visible, true);
  assert.equal(f.polishPreviewDecision(w, proposal, clean.key).visible, false);
  for (const draft of drafts(w)) for (const key of [null, 'preview:' + clean.key]) {
    assert.deepEqual(f.polishPreviewDecision(draft, proposal, key), { key: clean.key, visible: false, deferred: true });
  }
  for (const guards of [{ recovery: {} }, { conflict: {} }]) assert.equal(f.polishPreviewDecision(w, proposal, null, guards).visible, false);
  const next = copy(w); next.book.chapters[0].revision++; next.book.chapters[0].body += 'saved manual'; next.chapter.body += 'saved manual'; next.baseChapter = next.chapter;
  assert.equal(f.polishPreviewDecision(next, proposal, null).visible, false);
  assert.equal(f.polishPreviewDecision(next, proposal, 'preview:' + clean.key).visible, true);
  assert.equal(f.polishActionProblem(next, f.polishActionSnapshot(next, proposal)), 'stale');
});

test('author click is frozen to rendered book/chapter/revision/proposal and rejects every dirty or newer identity', () => {
  const { w, proposal } = fixture(), snapshot = f.polishActionSnapshot(w, proposal);
  assert(Object.isFrozen(snapshot));
  assert(Object.values(snapshot).every(value => value === null || typeof value !== 'object'));
  assert.equal(f.polishActionProblem(w, snapshot), '');
  for (const change of [
    next => { next.book.id = 'other'; }, next => { next.book.revision++; }, next => { next.chapterId = 'other'; },
    next => { next.candidateId = 'other'; }, next => { next.book.chapters[0].body += 'changed'; },
    next => { next.book.chapters[0].title += 'changed'; }, next => { next.book.proposals[0].text += 'changed'; },
    next => { next.book.proposals[0].selection.start++; }, next => { next.book.proposals[0].state = 'accepted'; },
  ]) { const next = copy(w); change(next); assert.equal(f.polishActionProblem(next, snapshot), 'confirmChanged'); }
  for (const draft of drafts(w)) assert.equal(f.polishActionProblem(draft, snapshot), 'saveFirst');
  for (const accept of [true, false]) {
    assert.equal(f.polishActionProblem(w, snapshot, { recovery: {}, accept }), 'manageRecovery');
    assert.equal(f.polishActionProblem(w, snapshot, { conflict: {}, accept }), 'saveFirst');
    assert.equal(f.polishActionProblem(w, snapshot, { busy: true, accept }), 'working');
    assert.equal(f.polishActionProblem(w, snapshot, { unavailable: true, accept }), 'bookMissing');
  }
});

test('real core accepts exact selected range only; stale source may be explicitly rejected but never accepted', () => {
  const { w, book, proposal, body, id } = fixture();
  const click = f.polishActionSnapshot(w, proposal);
  const accepted = mutateBook(book, { action: 'acceptProposal', proposalId: proposal.id });
  assert.equal(accepted.chapters[0].body, body.slice(0, proposal.selection.start) + proposal.text + body.slice(proposal.selection.end));
  assert.equal(f.polishActionProblem(f.workspace(accepted), click), 'confirmChanged');
  const changed = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body: body + '\r\n作者新正文' } });
  const stale = f.workspace(changed), staleClick = f.polishActionSnapshot(stale, stale.book.proposals[0]);
  assert.equal(f.polishActionProblem(stale, staleClick), 'stale');
  assert.equal(f.polishActionProblem(stale, staleClick, { accept: false }), '');
  const rejected = mutateBook(changed, { action: 'rejectProposal', proposalId: proposal.id });
  assert.equal(rejected.chapters[0].body, changed.chapters[0].body);
  assert.equal(rejected.chapters[0].revision, changed.chapters[0].revision);
  const p = rejected.proposals[0], next = f.workspace(rejected);
  assert.equal(f.polishActionProblem(next, staleClick, { accept: false }), 'confirmChanged');
  const key = f.polishPreviewDecision(stale, proposal, null).key;
  assert.equal(f.polishPreviewDecision(next, p, key).visible, false, 'Successful author action records ordinary-editor choice, even after explicit stale comparison');
  assert.equal(f.polishPreviewDecision(next, p, 'preview:' + key).visible, true, 'Rejected history may still be explicitly compared without author controls');
  assert.equal(f.polishActionProblem(next, f.polishActionSnapshot(next, p), { accept: false }), 'confirmChanged');
});

test('popup pure decisions close collapse/composition/Escape and open only explicit selection gestures', () => {
  for (const args of [{ start: 2, end: 2 }, { start: 2, end: 1 }, { start: 0, end: 2, composing: true }, { start: 0, end: 2, key: 'Escape', event: 'keyup' }]) assert.equal(f.selectionPopupDecision(args), 'close');
  assert.equal(f.selectionPopupDecision({ start: 0, end: 2, event: 'mouseup' }), 'open');
  for (const key of ['Shift', 'ArrowRight', 'Home', 'End', 'a']) assert.equal(f.selectionPopupDecision({ start: 0, end: 2, event: 'keyup', key }), 'open');
  assert.equal(f.selectionPopupDecision({ start: 0, end: 2 }), 'keep');
  assert.equal(f.selectionPopupDecision({ start: 0, end: 2, event: 'keyup', key: 'Tab' }), 'keep');
});

test('popup coordinates clamp at viewport edges and keyboard fallback uses only visible editor rectangle', () => {
  for (const [x, y] of [[0, 0], [799, 599], [-200, 9999], [320, 320]]) {
    const result = f.selectionPopupPosition({ x, y, rect: { left: 20, right: 780, top: 40, bottom: 900 }, viewportWidth: 800, viewportHeight: 600 });
    assert(result.left >= 8 && result.top >= 8);
    assert(result.left + result.width <= 792);
    assert(result.top + 132 <= 592);
  }
  const keyboard = f.selectionPopupPosition({ rect: { left: 50, right: 500, top: -500, bottom: 300 }, viewportWidth: 800, viewportHeight: 600 });
  assert.equal(keyboard.left, 62);
  assert(keyboard.top >= 8 && keyboard.top < 300);
  const narrow = f.selectionPopupPosition({ x: 99, y: 99, viewportWidth: 120, viewportHeight: 100 });
  assert.equal(narrow.width, 104);
  assert.equal(narrow.left, 8);
  assert.equal(narrow.top, 8);
  assert.equal(f.selectionPopupPosition({ rect: { left: 0, right: 500, top: 700, bottom: 900 }, viewportWidth: 800, viewportHeight: 600 }), null);
});

test('source wiring (not a visual test): selection handlers never request AI; explicit dispatch binds mode/range and saved preference revision', () => {
  const selection = source.slice(source.indexOf('          const captureSelection ='), source.indexOf('          const polishRequestProblem ='));
  assert(!selection.includes("call('generate'"));
  assert(selection.includes('capturePolishSnapshot(active, node.selectionStart, node.selectionEnd)'));
  assert(selection.includes('equal(captured, selectionRef.current) ? selectionRef.current : captured'));
  const dispatch = source.slice(source.indexOf('          const startPolish ='), source.indexOf('          const contextKey ='));
  assert(dispatch.includes('expectedRevision: snapshot.bookRevision, expectedModelRevision'));
  assert(dispatch.includes("mode: 'polish', instruction: direction, selection: picked"));
  assert(dispatch.includes('intent: selectionRef.current'));
  assert(dispatch.includes('composing: composing.current'));
  assert(dispatch.includes('custom && !direction.trim()'));
  assert(dispatch.indexOf("call('generate'") < dispatch.indexOf("setMode('polish')"), 'Mode state is context only, not dispatch input');
  assert(!dispatch.includes('saveAll('));
  assert(!dispatch.includes('mutateRaw('));
  assert(!dispatch.includes('commit('));
  assert(source.includes("const generate = () => mode === 'polish' ? startPolish(selectionRef.current"), 'Legacy Writing partner uses the identical request path');
});

test('source wiring (not a visual test): toolbar is pointer anchored, keyboard reachable, dismissible and native selection preserving', () => {
  assert(source.includes("onSelect: captureSelection, onMouseUp: captureSelection, onKeyUp: captureSelection"));
  assert(source.includes('event.clientX'));
  assert(source.includes('node.getBoundingClientRect()'));
  assert(source.includes("window.addEventListener('scroll', dismiss, true)"));
  assert(source.includes("window.removeEventListener('scroll', dismiss, true)"));
  assert(source.includes("window.addEventListener('resize', dismiss)"));
  assert(source.includes("document.addEventListener('selectionchange', changed)"));
  assert(source.includes("document.addEventListener('mouseup', released)"));
  assert(source.includes("document.removeEventListener('mouseup', released)"));
  assert(source.includes("event.target?.nodeType && popupRef.current?.contains(event.target)"));
  assert(source.includes("popover: 'manual', role: 'toolbar'"));
  assert(source.includes('node.showPopover()'));
  assert(source.includes('onMouseDown: e => e.preventDefault()'));
  assert(source.includes("e.key === 'Tab' && !e.shiftKey && selectionPopup"));
  assert(source.includes("first.focus({ preventScroll: true })"));
  assert(source.includes('composing.current = true; closeSelectionPopup()'));
  assert(source.includes('[w?.book.id, w?.book.revision, w?.chapterId, w?.chapter?.body, tab]'));
  assert(source.includes("disabled: !!popupProblem"));
  assert(source.includes("popupProblem ? t(popupProblem) : t('polishSelectionOnly')"));
  assert(source.includes("required: true, onChange: e => setPolishRequirements"));
  assert(source.includes('!polishRequirements.text.trim()'));
});

test('source wiring (not a visual test): selected polish shows green suggestions and red source, preserving explicit author decisions without duplicate status', () => {
  const inline = source.slice(source.indexOf('          const renderPolishActions ='), source.indexOf('          const renderSelectionPopup ='));
  assert(inline.includes('record !== proposal'));
  assert(inline.includes('!polishView(w, record)?.durable'));
  assert(inline.includes("h('span', { className: 'mx-revision-text' }, polish.prefix)"));
  assert(inline.includes('polish.newText'));
  assert(inline.includes('renderVisibleText(polish.original'), 'Original remains visible while waiting, streaming and ready');
  assert(inline.indexOf('polish.newText') < inline.indexOf('renderVisibleText(polish.original'), 'Green suggestion precedes the red original');
  assert(!inline.includes("h('details'"));
  assert(inline.includes("renderPolishActions(polishRecord, formId.current + '-polish-' + polishRecord.id)"));
  assert(!inline.includes("h('h3'"), 'No redundant polished-text title');
  assert(!inline.includes("t('polishAwaitProposal')"), 'The green placeholder owns waiting feedback without a second line');
  assert(source.includes("polish?.durable && polishRecord.state !== 'ready' ? 'polishHistoryPreview' : 'polishPreview'"));
  assert(inline.includes("h('span', { className: 'mx-revision-text' }, polish.suffix)"));
  assert(source.includes('polishPreviewVisible ? renderPolishPreview() : revisionPreviewVisible ? renderRevisionPreview()'));
  assert(source.includes(".mx-polish-preview{min-height:0}"), 'Preview has no forced viewport height; its allocated body slot owns scrolling');
  assert(source.includes('.mx-body-slot>.mx-revision-preview,.mx-body-slot>.mx-stack{') && source.includes('.mx-editor-panel{'), 'The normal-flow editor/body allocation remains explicit');
  assert(source.includes("polishBlockRef.current?.scrollIntoView({ block: 'nearest' })"));
  assert(source.includes('[polishPreviewVisible, polishRecord?.id]'));
  const action = source.slice(source.indexOf('          const applyPolish ='), source.indexOf('          const applyRevisionHunk ='));
  assert.equal(action.split('polishActionProblem(').length - 1, 2);
  assert(action.includes("action: accept ? 'acceptProposal' : 'rejectProposal'"));
  assert(action.includes('proposalId: snapshot.proposalId'));
  assert(action.includes('setOriginalPolishKey(JSON.stringify([snapshot.bookId'));
  assert(!action.includes('saveAll('));
  assert(!action.includes('confirmMutation('));
  assert(!source.includes('const renderCandidate ='), 'The separate proposal UI was intentionally removed');
  assert(inline.includes("'aria-live': 'off' }, renderVisibleText(polish.newText, polish.durable ? 'revisionDeleted' : 'polishProgress')"), 'One green region shows output or one progress placeholder');
  assert(source.includes("polishProgress: '正在润色...'"), 'Waiting text is concise and exact');
  assert(source.includes("d.candidate && h('div', { className: 'mx-legacy-recovery"), 'Removing the old editor must not orphan its unsaved recovery drafts');
});

test('source wiring (not a visual test): all four author decisions share native icon-only SVG buttons with descriptive accessible names', () => {
  const primitive = source.slice(source.indexOf('          const decisionButton ='), source.indexOf('          const input ='));
  assert(primitive.includes("=> button("), 'Native button wrapper retains disabled/type/click behavior');
  assert(primitive.includes("h('svg', { width: 16, height: 16"));
  assert(primitive.includes("fill: 'none', stroke: 'currentColor', strokeWidth: 1.7"));
  assert(primitive.includes("strokeLinecap: 'round', strokeLinejoin: 'round'"));
  assert(primitive.includes("'aria-hidden': true, focusable: 'false'"));
  assert(primitive.includes("h('path', { d: accept ? 'M5 12l4 4L19 6' : 'M6 6l12 12M18 6 6 18' })"));
  assert(primitive.includes("'aria-label': label, title: label, ...props"), 'Localized label defaults and per-call disabled reasons are retained');
  assert.equal((source.match(/decisionButton\((?:true|false),/g) || []).length, 6, 'Selected passage, full chapter and ordinary generated results share the same accept/reject primitive');
  assert(!/[✅❌✔✕✖]/u.test(source), 'No rendered emoji/glyph decisions or hint glyphs remain (including implementation comments)');
  assert(source.includes("decisionButton(true, t('polishAccept'), () => applyPolish(snapshot, true)"));
  assert(source.includes("decisionButton(false, t('polishReject'), () => applyPolish(snapshot, false)"));
  assert(source.includes("decisionButton(true, t('revisionAcceptLabel', { number }), () => applyRevisionHunk(snapshot, true)"));
  assert(source.includes("decisionButton(false, t('revisionRejectLabel', { number }), () => applyRevisionHunk(snapshot, false)"));
  assert(source.includes("'aria-label': t('revisionAcceptLabel', { number }), 'aria-describedby': textId"));
  assert(source.includes("'aria-label': t('revisionRejectLabel', { number }), 'aria-describedby': textId"));
  assert(source.includes("'aria-describedby': describedBy, disabled: !!polishProblem"));
  assert(source.includes("'aria-describedby': describedBy, disabled: !!polishRejectProblem"));
  assert(source.includes("id: formId.current + '-polish-' + polishRecord.id"));
  assert(!source.includes("id: formId.current + '-candidate', value: textareaValue(w.candidate)"), 'There is no separate generated-proposal textarea');
  assert(source.includes("decisionButton(true, t('accept'), () => applyGenerated(snapshot, true)"));
  assert(source.includes("decisionButton(false, t('reject'), () => applyGenerated(snapshot, false)"));
  assert(source.includes('flex:0 0 32px;width:32px;height:32px;min-height:32px;padding:0'));
  assert(source.includes('.mx-root .mx-decision-accept{color:var(--dsw-alias-state-success-primary)}'));
  assert(source.includes('.mx-root .mx-decision-reject{color:var(--dsw-alias-state-error-primary)}'));
  assert(source.includes('.mx-root .mx-decision:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)'));
});

test('bilingual user labels distinguish selected passage polish from full current chapter polish', () => {
  const dictionaries = new Function(source.slice(source.indexOf('    const en ='), source.indexOf('    const CSS =')) + '\nreturn {en,zh};')();
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort());
  assert.equal(dictionaries.zh.polishCustom, '按需润色');
  assert.equal(dictionaries.zh.modeRevise, '按需润色（全文）');
  assert(dictionaries.zh.reviseHint.includes('不是当前选区，也不是全书'));
  assert(dictionaries.en.reviseHint.includes('not the selected passage or the whole book'));
});

test('mutation evidence: removing intent, source-revision or author-snapshot guards changes the result', () => {
  const { w, snapshot, job, proposal, body } = fixture();
  const other = f.capturePolishSnapshot(w, 0, 2);
  const looseIntent = extract(helpers.replace('intent !== snapshot || ', ''));
  assert.equal(looseIntent.polishIntentProblem(w, snapshot, { intent: other }), '');
  assert.equal(f.polishIntentProblem(w, snapshot, { intent: other }), 'selectionChanged');
  const wrongJob = { ...job, sourceRevision: job.sourceRevision + 1 };
  const looseJob = extract(helpers.replace('if (!hasSource && chapter.revision !== record.sourceRevision) return null;', ''));
  assert(looseJob.polishView(w, wrongJob));
  assert.equal(f.polishView(w, wrongJob), null);
  const click = f.polishActionSnapshot(w, proposal), newer = { ...w, book: { ...w.book, revision: w.book.revision + 1 } };
  const looseAuthor = extract(helpers.replace('snapshot == null || !reviewIsCurrent(w, snapshot)', 'snapshot == null'));
  assert.equal(looseAuthor.polishActionProblem(newer, click), '');
  assert.equal(f.polishActionProblem(newer, click), 'confirmChanged');
  const shifted = extract(helpers.replace('source.slice(0, start), suffix = source.slice(end)', 'source.slice(0, 0), suffix = source.slice(end)'));
  assert.notEqual(shifted.polishView(w, proposal).preview, body.slice(0, proposal.selection.start) + proposal.text + body.slice(proposal.selection.end));
});
