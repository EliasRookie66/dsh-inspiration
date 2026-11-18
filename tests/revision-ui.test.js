import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createBook, mutateBook, buildContext, makeProposal } from '../core.js';
import { applyHunks, revisionPreview } from '../revision.js';

// These are the actual renderer-independent client helpers. No React substitute,
// ModuleLoader execution, mock rendering, DOM emulation, live calls or paid model
// calls. Source-wiring assertions below inspect code, not visual browser behavior.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('    const equal =');
const end = source.indexOf('    const en =');
assert(start > 0 && end > start);
const helperSource = source.slice(start, end);
const names = 'revisionView,revisionPreviewDecision,revisionHunkSnapshot,revisionHunkSnapshots,revisionActionProblem,staleProposal,workspace,dirty,isDirty,mergeWorkspace,sourceOffsets,textareaValue,reviewIsCurrent';
const extract = text => new Function(text + '\nreturn {' + names + '};')();
const f = extract(helperSource);
const copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const body = '开头\r\n她说：“好。”\r\n😀她说：“好。”\r\n结尾。';
  const first = body.indexOf('好'), second = body.lastIndexOf('好'), deletion = body.indexOf('结尾');
  const hunks = [
    { id: 'first', start: first, end: first + 1, before: '好', after: '你终于来了', state: 'pending' },
    { id: 'second', start: second, end: second + 1, before: '好', after: '我还以为你不来了', state: 'pending' },
    { id: 'delete', start: deletion, end: deletion + 2, before: '结尾', after: '', state: 'pending' },
    { id: 'insert', start: body.length, end: body.length, before: '', after: '\r\n新增对白：“走吧。”', state: 'pending' },
  ];
  let cursor = 0, text = '';
  for (const item of hunks) { text += body.slice(cursor, item.start) + item.after; cursor = item.end; }
  text += body.slice(cursor);
  const proposal = { id: 'proposal', chapterId: 'chapter', mode: 'revise', sourceRevision: 7, sourceBody: body,
    text, selection: null, state: 'ready', review: { analysis: '对白偏少、生硬；保留人物关系，增加自然回应。', hunks } };
  const chapter = { id: 'chapter', revision: 7, title: '本章', outline: '原计划', body, summary: '', status: 'draft', history: [] };
  const book = { id: 'book', revision: 12, title: '作品', premise: '', outline: '', style: '', contextBudget: 20000,
    chapters: [chapter], cards: [], proposals: [proposal] };
  return { book, proposal, chapter, w: f.workspace(book, chapter.id) };
}

function resolve(book, index, state) {
  const next = copy(book), proposal = next.proposals[0];
  proposal.review.hunks[index].state = state;
  const view = f.revisionView(proposal);
  next.chapters[0].body = view.saved;
  next.chapters[0].revision = proposal.sourceRevision + view.counts.accepted;
  next.revision++;
  if (!view.counts.pending) proposal.state = view.counts.accepted ? 'accepted' : 'rejected';
  return next;
}

test('full optimized preview reconstructs immutable target exactly, including all unchanged CRLF and Unicode', () => {
  const { proposal } = fixture(), view = f.revisionView(proposal);
  assert(view);
  assert.equal(view.preview, proposal.text);
  assert.equal(view.pieces.map(piece => piece.text).join(''), proposal.text);
  assert.equal(view.target, proposal.text);
  assert.equal(view.saved, proposal.sourceBody);
  assert.deepEqual(view.counts, { pending: 4, accepted: 0, rejected: 0 });
  assert(view.preview.includes('\r\n😀她说'));
  assert(!view.preview.replaceAll('\r\n', '').includes('\n'));
});

test('repeated text is addressed by original UTF-16 offsets, not first-occurrence replacement', () => {
  const { proposal } = fixture();
  proposal.review.hunks[0].state = 'rejected';
  proposal.review.hunks[1].state = 'accepted';
  const view = f.revisionView(proposal);
  assert(view.saved.includes('她说：“好。”\r\n😀她说：“我还以为你不来了。”'));
  assert(view.preview.includes('她说：“好。”\r\n😀她说：“我还以为你不来了。”'));
  const normalized = f.textareaValue(proposal.sourceBody), native = normalized.lastIndexOf('好');
  assert.deepEqual(f.sourceOffsets(proposal.sourceBody, native, native + 1), {
    start: proposal.review.hunks[1].start, end: proposal.review.hunks[1].end, text: '好',
  });
});

test('every subset uses after for pending/accepted, before for rejected, and only accepted text is saved', () => {
  const { proposal } = fixture(), original = copy(proposal);
  const states = ['pending', 'accepted', 'rejected'];
  for (const a of states) for (const b of states) for (const c of states) for (const d of states) {
    const p = copy(proposal), choices = [a, b, c, d];
    p.review.hunks.forEach((item, index) => { item.state = choices[index]; });
    const view = f.revisionView(p);
    let saved = original.sourceBody, preview = original.sourceBody;
    // Independent right-to-left oracle: offsets are never remapped after edits.
    for (const item of p.review.hunks.slice().reverse()) {
      if (item.state === 'accepted') saved = saved.slice(0, item.start) + item.after + saved.slice(item.end);
      if (item.state !== 'rejected') preview = preview.slice(0, item.start) + item.after + preview.slice(item.end);
    }
    assert.equal(view.saved, saved);
    assert.equal(view.preview, preview);
    assert.equal(view.pieces.map(piece => piece.text).join(''), preview);
    assert.equal(view.target, original.text);
    assert.equal(p.sourceRevision, original.sourceRevision);
    assert.equal(p.sourceBody, original.sourceBody);
    assert.equal(p.text, original.text);
    assert.equal(view.counts.accepted, choices.filter(state => state === 'accepted').length);
  }
});

test('deletion remains a separate addressable changed piece even when its preview text is empty', () => {
  const { proposal } = fixture(), view = f.revisionView(proposal);
  const deletion = view.pieces.find(piece => piece.hunk?.id === 'delete');
  assert.equal(deletion.kind, 'hunk');
  assert.equal(deletion.text, '');
  assert.equal(deletion.hunk.state, 'pending');
  assert.equal(deletion.hunk.before, '结尾');
});

test('own accepted changes advance only expected chapter revision and do not stale remaining hunks', () => {
  const { book } = fixture();
  let next = resolve(book, 1, 'accepted');
  assert(!f.staleProposal(f.workspace(next), next.proposals[0]));
  next = resolve(next, 0, 'rejected');
  assert(!f.staleProposal(f.workspace(next), next.proposals[0]));
  next = resolve(next, 2, 'accepted');
  assert(!f.staleProposal(f.workspace(next), next.proposals[0]));
  assert.equal(next.chapters[0].revision, 9);
});

test('manual body, title, outline or revision changes invalidate even a partially accepted proposal', () => {
  const { book } = fixture(), partial = resolve(book, 1, 'accepted');
  for (const patch of [{ body: partial.chapters[0].body + '手动正文', revision: 9 },
    { body: partial.chapters[0].body + '同修订的恶意正文' },
    { title: '改标题', revision: 9 }, { outline: '改提纲', revision: 9 }, { revision: 7 }, { revision: 9 }]) {
    const next = copy(partial);
    Object.assign(next.chapters[0], patch);
    assert(f.staleProposal(f.workspace(next), next.proposals[0]), JSON.stringify(patch));
  }
  const sameBodyLater = copy(partial);
  sameBodyLater.chapters[0].revision += 2;
  assert(f.staleProposal(f.workspace(sameBodyLater), sameBodyLater.proposals[0]), 'Editing and restoring original bytes still changes source revision');
});

test('stale guard rejects a wrong chapter or missing saved chapter', () => {
  const { w, proposal } = fixture();
  assert(f.staleProposal(w, { ...proposal, chapterId: 'other' }));
  assert(f.staleProposal({ ...w, chapterId: 'missing' }, proposal));
});

test('malformed review/source data fails closed rather than enabling author mutations', () => {
  const { proposal, w } = fixture();
  const mutations = [
    p => { delete p.review; }, p => { p.review = null; }, p => { p.review.analysis = 2; },
    p => { p.review.hunks = {}; }, p => { p.sourceBody = null; }, p => { p.text += 'untracked'; },
    p => { p.sourceRevision = 0; }, p => { p.sourceRevision = 1.5; },
    p => { p.review.hunks[0].before = 'not the original'; }, p => { p.review.hunks[0].after = 3; },
    p => { p.review.hunks[0].after = p.review.hunks[0].before; },
    p => { p.review.hunks[0].state = 'unknown'; }, p => { p.review.hunks[0].state = {}; },
    p => { p.review.hunks[1].id = p.review.hunks[0].id; },
    p => { p.review.hunks[0].start = -1; }, p => { p.review.hunks[0].end = Infinity; },
    p => { p.review.hunks[1].start = p.review.hunks[0].start; },
    p => { p.review.hunks.reverse(); }, p => { p.review.hunks[0] = null; },
    p => { p.sourceBody = '\uD800'; }, p => { p.text = '\uDC00'; },
    p => { p.review.hunks[0].after = '\uD800'; p.text = p.sourceBody.slice(0, p.review.hunks[0].start) + '\uD800' + p.sourceBody.slice(p.review.hunks[0].end); },
  ];
  for (const mutate of mutations) {
    const p = copy(proposal); mutate(p);
    assert.equal(f.revisionView(p), null);
    const active = { ...w, book: { ...w.book, proposals: [p] } };
    assert(f.staleProposal(active, p));
    const snapshot = f.revisionHunkSnapshot(active, p, 'first');
    assert(f.revisionActionProblem(active, snapshot), 'Invalid proposal must never enable a hunk');
  }
});

test('hunks that split Unicode surrogate pairs or CRLF pairs are invalid', () => {
  const { proposal } = fixture();
  for (const position of [proposal.sourceBody.indexOf('😀') + 1, proposal.sourceBody.indexOf('\r\n') + 1]) {
    const p = copy(proposal);
    p.review.hunks = [{ id: 'split', start: position, end: position, before: '', after: 'X', state: 'pending' }];
    p.text = p.sourceBody.slice(0, position) + 'X' + p.sourceBody.slice(position);
    assert.equal(f.revisionView(p), null);
  }
});

test('inline-click snapshots are frozen scalar identities and lock book/chapter/proposal/hunk', () => {
  const { w, proposal } = fixture(), snapshot = f.revisionHunkSnapshot(w, proposal, 'first');
  assert(Object.isFrozen(snapshot));
  assert(Object.values(snapshot).every(value => value === null || typeof value !== 'object'));
  assert.equal(f.revisionActionProblem(w, snapshot), '');
  for (const change of [
    next => { next.book.revision++; }, next => { next.book.id = 'different'; },
    next => { next.chapterId = 'different'; }, next => { next.candidateId = 'different'; },
    next => { next.book.chapters[0].body += 'concurrent'; },
    next => { next.book.proposals[0].review.hunks[0].after += 'concurrent'; },
    next => { next.book.proposals[0].review.hunks[0].state = 'rejected'; },
    next => { next.book.proposals[0].review.analysis += 'changed'; },
    next => { next.book.proposals[0].text += 'changed'; },
  ]) {
    const next = copy(w); change(next);
    assert.equal(f.revisionActionProblem(next, snapshot), 'confirmChanged');
  }
  assert.equal(f.revisionActionProblem(w, null), 'confirmChanged');
  assert.equal(f.revisionHunkSnapshot(w, proposal, 'not-found'), null);
});

test('all dirty groups, recovery, conflicts and busy state disable inline author confirmation', () => {
  const { w, proposal } = fixture(), snapshot = f.revisionHunkSnapshot(w, proposal, 'first');
  const drafts = [
    { ...w, chapter: { ...w.chapter, summary: '本地摘要' } },
    { ...w, settings: { ...w.settings, premise: '本地前提' } },
    { ...w, card: { title: 'unsaved card' }, baseCard: null },
    { ...w, candidate: w.candidate + 'unsaved candidate' },
  ];
  for (const draft of drafts) assert.equal(f.revisionActionProblem(draft, snapshot), 'saveFirst');
  assert.equal(f.revisionActionProblem(w, snapshot, { recovery: { bookId: w.book.id } }), 'manageRecovery');
  assert.equal(f.revisionActionProblem(w, snapshot, { conflict: {} }), 'saveFirst');
  assert.equal(f.revisionActionProblem(w, snapshot, { busy: true }), 'working');
  assert.equal(f.revisionActionProblem(w, snapshot), '');
});

test('saved hunk adoption retains selected proposal and candidate, and protects unrelated drafts', () => {
  const { w, book, proposal } = fixture();
  const draft = { ...w, settings: { ...w.settings, style: '本地文风' }, card: { title: '本地卡' }, baseCard: null };
  const next = resolve(book, 0, 'accepted'), merged = f.mergeWorkspace(draft, next);
  assert.equal(merged.candidateId, proposal.id);
  assert.equal(merged.candidate, proposal.text);
  assert.equal(merged.baseCandidate, proposal.text);
  assert.equal(merged.chapter.body, next.chapters[0].body);
  assert.equal(merged.baseChapter.body, next.chapters[0].body);
  assert.equal(merged.settings.style, '本地文风');
  assert.deepEqual(merged.card, draft.card);
  assert.equal(f.dirty(merged).chapter, false);
  assert.equal(f.dirty(merged).settings, true);
  const nextClick = f.revisionHunkSnapshot(merged, next.proposals[0], 'second');
  assert.equal(f.revisionActionProblem(merged, nextClick), 'saveFirst');
});

test('completed resolved proposal remains selected and accepted subset stays visible after reload', () => {
  const { book, proposal } = fixture();
  let next = resolve(book, 1, 'accepted');
  for (const index of [0, 2, 3]) next = resolve(next, index, 'rejected');
  assert.equal(next.proposals[0].state, 'accepted');
  const reloaded = f.workspace(JSON.parse(JSON.stringify(next)));
  assert.equal(reloaded.candidateId, proposal.id);
  assert.equal(f.revisionView(reloaded.book.proposals[0]).preview, next.chapters[0].body);
  assert.equal(reloaded.candidate, proposal.text, 'Original full target is immutable after partial acceptance');
  const snapshot = f.revisionHunkSnapshot(reloaded, next.proposals[0], 'first');
  assert.equal(f.revisionActionProblem(reloaded, snapshot), 'confirmChanged');
});

test('zero changes retains exact saved body and analysis without creating a fake hunk', () => {
  const { proposal } = fixture();
  proposal.review.hunks = [];
  proposal.text = proposal.sourceBody;
  const view = f.revisionView(proposal);
  assert.equal(view.preview, proposal.sourceBody);
  assert.equal(view.saved, proposal.sourceBody);
  assert.equal(view.pieces.filter(piece => piece.kind === 'hunk').length, 0);
  assert.deepEqual(view.counts, { pending: 0, accepted: 0, rejected: 0 });
  assert(proposal.review.analysis);
  assert.equal(f.revisionHunkSnapshot(fixture().w, proposal, 'first'), null);
});

test('source wiring: immutable render snapshot flows through guarded one-click host mutation and adopt', () => {
  const render = source.slice(source.indexOf('          const renderRevisionPreview ='), source.indexOf('          const renderModelPicker ='));
  assert(render.includes('const snapshots = revisionHunkSnapshots(w, proposal)'));
  assert(render.includes('snapshot = snapshots.get(item.id)'));
  assert.equal(render.split('revisionActionProblem(').length - 1, 1, 'Common disable guard is evaluated once per preview, not per hunk');
  assert(render.includes('applyRevisionHunk(snapshot, true)'));
  assert(render.includes('applyRevisionHunk(snapshot, false)'));
  assert(render.includes('disabled: !!problem'));
  assert(render.includes("revisionPreviewVisible ? renderRevisionPreview() : generatedManuscript ? renderGeneratedPreview() : h(Field"));
  assert(render.includes("piece.kind === 'unchanged'"));
  assert(render.includes("renderVisibleText(piece.text, item.state !== 'rejected' && !item.after ? 'revisionDeleted' : 'empty')"), 'Empty deletion and invisible whitespace remain visible');
  assert(render.includes('renderVisibleText(item.before)'));
  assert(render.includes('renderOriginalContext(proposal.sourceBody, item)'), 'True insertions show source context, not a fabricated nonempty before');
  const apply = source.slice(source.indexOf('          const applyRevisionHunk ='), source.indexOf('          useEffect(() => {\n            alive.current = true;'));
  assert.equal(apply.split('revisionActionProblem(').length - 1, 2, 'Check before and inside the busy lock');
  assert(apply.includes('if (busyRef.current) return;'));
  assert(apply.includes('loading || !!manager || !!guard || !!confirm'));
  assert(apply.includes('recovery: recoveryRef.current, conflict'));
  assert(apply.includes("action: accept ? 'acceptRevisionHunk' : 'rejectRevisionHunk'"));
  assert(apply.includes('proposalId: snapshot.proposalId, hunkId: snapshot.hunkId'));
  assert(apply.includes('await mutateRaw('));
  assert(!apply.includes('confirmMutation('));
  assert(!apply.includes("call('generate'"));
  assert(source.includes('if (!adopt(book, cleared))'));
});

test('source wiring: revise remains immutable and explicit approve-all uses its dedicated guarded operation', () => {
  assert(!source.includes('const renderCandidate ='), 'No separate proposal editor remains');
  assert(source.includes("!['draft', 'continue', 'summary'].includes(record?.mode)"), 'Generic whole-result acceptance never treats revise as a normal draft');
  assert(source.includes("selectedProposal?.mode === 'revise'"), 'Legacy recovery cannot edit immutable revise output');
  assert(source.includes("t('revisionAnalysis')"));
  assert(source.includes("t('revisionCounts', revision.counts)"));
  assert(source.includes("'revisionRejectRemaining'"));
  assert(source.includes("'revisionDismissEmpty'"));
  assert(source.includes("'revisionRejectHint'"));
  assert(source.includes('!proposal.review.hunks.length'));
  assert(source.includes("action: 'acceptRevisionAll', proposalId: snapshot.proposalId"));
});

test('source wiring: durable pending results auto-render inline without manual preview entry or draft replacement', () => {
  assert(source.includes("const [originalReviewKey, updateOriginalReviewKey] = useState(null)"));
  assert(source.includes('const setOriginalReviewKey = value => { reviewRef.current = null; updateOriginalReviewKey(value); }'), 'Settling a review invalidates stale rendered actions synchronously');
  assert(source.includes('const revisionDecision = revisionPreviewDecision(w, proposal, originalReviewKey, { recovery, conflict })'));
  assert(source.includes('revisionPreviewVisible = revisionDecision.visible'));
  assert(source.includes('candidateId: p.id, candidate: p.text, baseCandidate: p.text'));
  assert(!source.includes("setOriginalReviewKey(revisionPreviewVisible ? revisionKey : 'preview:' + revisionKey); resetSelection()"), 'No manual preview entry/hide control');
  assert(source.includes('revisionDecision.visible && !!revision?.counts.pending'), 'Zero-change results never lock the manuscript into review');
  assert(source.includes('const inlineReviewProblem ='), 'Exceptional blockers remain visible without a mode banner');
  assert(source.includes("? recovery ? 'manageRecovery' : anyDirty || conflict ? 'saveFirst'"), 'Local drafts and recovery still take priority');
  assert(source.includes("group === 'chapter' && revisionPreviewVisible"));
  assert(source.includes('.mx-revision-text{white-space:pre-wrap;'));
  assert(!helperSource.includes('require('), 'Preview algebra has no Node or runtime dependencies');
});

test('source wiring: requirements, two-call phases, actual model snapshot and bilingual safety labels', () => {
  assert(source.includes("revise: 'modeRevise'"));
  assert(source.includes("const requirementMissing = mode === 'revise' && !instruction.trim()"));
  assert(source.includes("if (mode === 'revise' && !instruction.trim()) throw new Error(t('reviseRequirement'))"));
  assert(source.includes('running || requirementMissing || !!modelProblem'));
  assert(source.includes("['analyzing', 'optimizing'].includes(job.phase)"));
  assert(source.includes("typeof job.analysis === 'string'"));
  assert(source.includes('modelDescription(job.model)'));
  assert(source.includes('两次可能计费的模型调用'));
  assert(source.includes('two sequential, potentially paid model calls'));
  assert(source.includes('全文润色预览，未确认改动尚未写入原稿'));
  assert(source.includes('采纳并保存此处修改'));
  assert(source.includes('保留已采纳内容'));
});

test('preview visibility never hides dirty manual edits, recovery or conflicts and never auto-covers a newly saved revision', () => {
  const { w, proposal } = fixture(), clean = f.revisionPreviewDecision(w, proposal, null);
  assert.equal(clean.visible, true);
  assert.equal(clean.deferred, false);
  assert.equal(f.revisionPreviewDecision(w, proposal, clean.key).visible, false, 'Explicit ordinary editor stays open');
  assert.equal(f.revisionPreviewDecision(w, proposal, 'preview:' + clean.key).visible, true);
  for (const draft of [{ ...w, chapter: { ...w.chapter, body: w.chapter.body + '作者手稿' } },
    { ...w, settings: { ...w.settings, style: '本地文风' } },
    { ...w, card: { title: '本地卡' } }, { ...w, candidate: w.candidate + 'draft' }]) {
    const decision = f.revisionPreviewDecision(draft, proposal, null);
    assert.equal(decision.visible, false);
    assert.equal(decision.deferred, true);
    assert.equal(f.revisionPreviewDecision(draft, proposal, 'preview:' + clean.key).visible, false, 'Even explicit preview cannot cover an unresolved draft');
  }
  for (const options of [{ recovery: {} }, { conflict: {} }]) {
    assert.equal(f.revisionPreviewDecision(w, proposal, null, options).visible, false);
    assert.equal(f.revisionPreviewDecision(w, proposal, null, options).deferred, true);
  }
  const changed = copy(w.book);
  changed.chapters[0].body += '已保存手动稿'; changed.chapters[0].revision++; changed.revision++;
  const saved = f.workspace(changed);
  assert.equal(f.revisionPreviewDecision(saved, changed.proposals[0], null).visible, false, 'Saving a manual draft does not auto-open its stale AI target');
  assert.equal(f.revisionPreviewDecision(saved, changed.proposals[0], 'preview:' + clean.key).visible, true, 'Explicit stale comparison remains available with hunk actions disabled');
  assert.equal(f.revisionActionProblem(saved, f.revisionHunkSnapshot(saved, changed.proposals[0], 'first')), 'stale');
  assert.equal(f.revisionPreviewDecision(w, { ...proposal, mode: 'draft' }, null).visible, false);
});

test('snapshot creation serializes large proposal/chapter identities only once and freezes every hunk identity', () => {
  const { w, proposal } = fixture();
  let serializations = 0;
  const counted = new Function('JSON', helperSource + '\nreturn {revisionHunkSnapshots};')({ stringify(value) { serializations++; return JSON.stringify(value); } });
  const snapshots = counted.revisionHunkSnapshots(w, proposal);
  assert.equal(snapshots.size, proposal.review.hunks.length);
  assert.equal(serializations, 2 + proposal.review.hunks.length);
  for (const item of proposal.review.hunks) {
    const snapshot = snapshots.get(item.id);
    assert(Object.isFrozen(snapshot));
    assert.equal(snapshot.hunkId, item.id);
    assert.equal(snapshot.hunk, JSON.stringify(item));
    assert.equal(f.revisionActionProblem(w, snapshot), '');
  }
});

test('source wiring: keyboard/screen-reader author decisions identify stable ordinal and exact changed text', () => {
  assert(source.includes("number = proposal.review.hunks.indexOf(item) + 1"));
  assert(source.includes("'aria-label': t('revisionHunk', { number, state:"));
  assert(source.includes("'aria-label': t('revisionAcceptLabel', { number }), 'aria-describedby': textId"));
  assert(source.includes("'aria-label': t('revisionRejectLabel', { number }), 'aria-describedby': textId"));
  assert(source.includes("h('div', { id: textId, className: 'mx-revision-text mx-diff-new' }"));
  assert(source.includes("decisionButton(true, t('revisionAcceptLabel', { number })"), 'The SVG accept control retains its exact ordinal author label');
  assert(source.includes("decisionButton(false, t('revisionRejectLabel', { number })"), 'The SVG reject control retains its exact ordinal author label');
});

test('actual domain integration: generated diff, acceptance, rejection, reloading and stale source agree with client algebra', () => {
  let book = mutateBook(createBook('真实内核'), { action: 'addChapter', title: '本章' });
  const id = book.chapters[0].id;
  const body = '甲说：“好。”\r\n保留中段。\r\n😀乙说：“好。”\r\n尾声。';
  const target = '甲说：“你终于来了。”\r\n保留中段。\r\n😀乙说：“我一直等你。”\r\n尾声。';
  book = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body } });
  const request = { mode: 'revise', instruction: '对白更自然，保持人物情节不变' };
  const proposal = makeProposal(book, id, request, target, buildContext(book, id, request), { analysis: '增加自然回应，不改变情节。' });
  assert(proposal.review.hunks.length >= 2);
  book = mutateBook(book, { action: 'addProposal', proposal });
  const original = copy(proposal);
  let w = f.workspace(book, id), view = f.revisionView(proposal);
  assert.equal(view.preview, target);
  assert.equal(revisionPreview(proposal).text, target);
  const first = proposal.review.hunks[0], snapshot = f.revisionHunkSnapshot(w, proposal, first.id);
  assert.equal(f.revisionActionProblem(w, snapshot), '');
  book = mutateBook(book, { action: 'acceptRevisionHunk', proposalId: proposal.id, hunkId: first.id });
  w = f.mergeWorkspace(w, book);
  let current = book.proposals.find(item => item.id === proposal.id);
  view = f.revisionView(current);
  assert.equal(w.chapter.body, applyHunks(body, current.review.hunks));
  assert.equal(view.saved, w.chapter.body);
  assert.equal(view.preview, revisionPreview(current).text);
  assert(!f.staleProposal(w, current));
  assert.equal(f.revisionActionProblem(w, snapshot), 'confirmChanged');
  const remaining = current.review.hunks.find(item => item.state === 'pending');
  assert.equal(f.revisionActionProblem(w, f.revisionHunkSnapshot(w, current, remaining.id)), '');
  book = mutateBook(book, { action: 'rejectRevisionHunk', proposalId: proposal.id, hunkId: remaining.id });
  book = book.proposals[0].state === 'ready' ? mutateBook(book, { action: 'rejectProposal', proposalId: proposal.id }) : book;
  w = f.workspace(JSON.parse(JSON.stringify(book)), id);
  current = book.proposals.find(item => item.id === proposal.id);
  assert.equal(current.state, 'accepted');
  assert.equal(current.sourceBody, original.sourceBody);
  assert.equal(current.sourceRevision, original.sourceRevision);
  assert.equal(current.text, original.text);
  assert.equal(f.revisionView(current).preview, w.chapter.body);
  assert.equal(w.candidateId, proposal.id);
  const edited = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { title: '作者改标题' } });
  assert(f.staleProposal(f.workspace(edited, id), edited.proposals[0]));
});

test('mutation evidence: preview, saved-body, own-acceptance and snapshot guards independently matter', () => {
  const { w, proposal, book } = fixture();
  const reversePreview = extract(helperSource.replace("item.state === 'rejected' ? item.before : item.after", "item.before"));
  assert.notEqual(reversePreview.revisionView(proposal).preview, proposal.text);
  const savePending = extract(helperSource.replace("item.state === 'accepted' ? item.after : item.before", 'item.after'));
  assert.notEqual(savePending.revisionView(proposal).saved, proposal.sourceBody);
  const noOwnRevision = extract(helperSource.replace('proposal.sourceRevision + view.counts.accepted', 'proposal.sourceRevision'));
  const partial = resolve(book, 0, 'accepted');
  assert(noOwnRevision.staleProposal(f.workspace(partial), partial.proposals[0]));
  const guardStart = helperSource.indexOf('    function revisionActionProblem('), guardEnd = helperSource.indexOf('    function staleProposal(', guardStart);
  const guard = helperSource.slice(guardStart, guardEnd);
  assert(guard.includes('!snapshot || !reviewIsCurrent(w, snapshot)'));
  const skipSnapshot = extract(helperSource.slice(0, guardStart) + guard.replace('!snapshot || !reviewIsCurrent(w, snapshot)', '!snapshot || false') + helperSource.slice(guardEnd));
  const newer = { ...w, book: { ...w.book, revision: w.book.revision + 1 } };
  assert.equal(skipSnapshot.revisionActionProblem(newer, f.revisionHunkSnapshot(w, proposal, 'first')), '');
  assert.equal(f.revisionActionProblem(newer, f.revisionHunkSnapshot(w, proposal, 'first')), 'confirmChanged');
});
