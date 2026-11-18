import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createBook, makeProposal, mutateBook, buildContext } from '../core.js';

// Independent contract review: actual domain snapshots and actual client pure
// helpers. No service, provider, HTTP, real book, DOM/React mock, timer or temp file.
// Source-wiring probes, where used, are NOT browser/event/visual verification.
const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const helperStart = client.indexOf('    const equal =');
const helperEnd = client.indexOf('    const en =');
assert(helperStart > 0 && helperEnd > helperStart);
const helperSource = client.slice(helperStart, helperEnd);
const names = 'workspace,dirty,isDirty,mergeWorkspace,recoveryPayload,validRecovery,sourceOffsets,textareaValue,revisionContext,visibleWhitespace,revisionView,revisionPreviewDecision,revisionHunkSnapshot,revisionActionProblem,polishView,polishDisplayRecord,polishPreviewDecision,polishActionSnapshot,polishActionProblem,generatedReviewView,generatedDisplayRecord,generatedPreviewDecision,generatedActionSnapshot,generatedActionProblem,bulkRevisionSnapshot,bulkRevisionProblem,visibleReviewProblem,reviewSnapshot,reviewIsCurrent,staleProposal';
const extract = text => new Function(text + '\nreturn {' + names + '};')();
const f = extract(helperSource);
const MODES = ['draft', 'continue', 'polish', 'revise', 'summary'];
const BODY = '序章😀\r\n她说：“好。”\r\n她说：“好。”\r\n尾声\r保留\n结束';
function bookWith(body = BODY) {
  let book = mutateBook(createBook('Contract fixture — never persisted'), { action: 'addChapter', title: 'Chapter' });
  const id = book.chapters[0].id;
  book = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body } });
  return mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { summary: '作者已确认摘要' } });
}
function fixture(mode, body = BODY, output) {
  const source = bookWith(body), id = source.chapters[0].id;
  const start = body.lastIndexOf('她说');
  const selection = mode === 'polish' ? { start, end: start + '她说：“好。”'.length, text: '她说：“好。”' } : null;
  const text = output ?? ({ draft: '新整章😁\r\n保留空格  ', continue: '\r\n\r\n  新续文😁\n', polish: '她轻声说：“好。”', revise: body.replace('尾声', '尾声更清楚'), summary: '忠实的新摘要😀\r\n第二行' })[mode];
  const options = { mode, instruction: '只修作者指定的问题', selection };
  const proposal = makeProposal(source, id, options, text, buildContext(source, id, options), mode === 'revise' ? { analysis: '针对问题进行局部修改' } : {});
  const book = mutateBook(source, { action: 'addProposal', proposal });
  return { source, book, id, proposal, w: f.workspace(book, id), body, text };
}
const savedChapter = book => book.chapters[0];
const viewFor = (w, record) => record?.mode === 'revise' ? f.revisionView(record) : record?.mode === 'polish' ? f.polishView(w, record) : f.generatedReviewView(w, record);
function accept(book, proposal) {
  if (proposal.mode !== 'revise') return mutateBook(book, { action: 'acceptProposal', proposalId: proposal.id });
  for (const hunk of proposal.review.hunks) book = mutateBook(book, { action: 'acceptRevisionHunk', proposalId: proposal.id, hunkId: hunk.id });
  return book;
}
function expectedBody({ proposal, body, text }) {
  if (proposal.mode === 'summary') return body;
  if (proposal.mode === 'continue') return body + text;
  if (proposal.mode === 'polish') return body.slice(0, proposal.selection.start) + text + body.slice(proposal.selection.end);
  return text;
}
function unchanged(book, before) { assert.equal(JSON.stringify(book), before, 'Reading/rejecting an invalid action must not mutate input'); }
function validScalars(value) {
  for (const scalar of value) assert(!/[\uD800-\uDFFF]/u.test(scalar), 'No unpaired surrogate in context');
}
function boundary(text, at) {
  return !(at > 0 && at < text.length && (text[at - 1] === '\r' && text[at] === '\n' || /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at])));
}

for (const mode of MODES) test(`${mode}: durable generation/repeated preview never autoaccepts; explicit core acceptance matches exact saved algebra`, () => {
  const data = fixture(mode), { source, book, proposal, w, body, text } = data;
  assert.equal(savedChapter(book).body, body);
  assert.equal(savedChapter(book).summary, savedChapter(source).summary);
  assert.equal(savedChapter(book).revision, savedChapter(source).revision);
  assert.deepEqual(savedChapter(book).history, savedChapter(source).history);
  const before = JSON.stringify(book), localBefore = JSON.stringify(w);
  for (let pass = 0; pass < 3; pass++) {
    const view = viewFor(w, proposal);
    assert(view);
    assert.equal(view.preview, mode === 'summary' ? text : expectedBody(data));
    if (mode !== 'revise') assert(view.durable);
    else assert.equal(view.pieces.map(piece => piece.text).join(''), proposal.text);
  }
  unchanged(book, before); assert.equal(JSON.stringify(w), localBefore);
  const adopted = accept(book, proposal);
  assert.equal(savedChapter(adopted).body, expectedBody(data));
  assert.equal(savedChapter(adopted).summary, mode === 'summary' ? text : savedChapter(book).summary);
  assert.equal(savedChapter(adopted).summaryRevision, mode === 'summary' ? savedChapter(book).revision : null);
  assert.equal(adopted.proposals[0].state, 'accepted');
  if (mode === 'summary') {
    assert.equal(savedChapter(adopted).revision, savedChapter(book).revision);
    assert.deepEqual(savedChapter(adopted).history, savedChapter(book).history);
  } else assert.equal(savedChapter(adopted).history.at(-1).body, body);
  unchanged(book, before);
});

for (const mode of MODES) test(`${mode}: stale acceptance fails atomically and explicit rejection preserves the author's newly saved body`, () => {
  const { book, proposal, id } = fixture(mode);
  const changed = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body: BODY + '\r\n作者自己的新段落' } });
  const before = JSON.stringify(changed);
  const operation = mode === 'revise' ? { action: 'acceptRevisionHunk', proposalId: proposal.id, hunkId: proposal.review.hunks[0].id } : { action: 'acceptProposal', proposalId: proposal.id };
  assert.throws(() => mutateBook(changed, operation), error => error.code === 'STALE_PROPOSAL');
  unchanged(changed, before);
  const rejected = mutateBook(changed, { action: 'rejectProposal', proposalId: proposal.id });
  assert.deepEqual(savedChapter(rejected), savedChapter(changed));
  assert.equal(rejected.proposals[0].state, 'rejected');
  unchanged(changed, before);
});

test('actual newline-only insertion has empty immutable before, truthful surrounding original, and visible whitespace instead of a blank green block', () => {
  const body = '序言😀\r\n原段\r\n尾声', target = '序言😀\r\n\r\n原段\r\n尾声';
  const { proposal } = fixture('revise', body, target), [hunk] = proposal.review.hunks;
  assert.equal(proposal.review.hunks.length, 1);
  assert.equal(hunk.start, hunk.end); assert.equal(hunk.before, ''); assert.equal(hunk.after, '\r\n');
  const context = f.revisionContext(body, hunk);
  assert.deepEqual(context, { prefix: body.slice(0, hunk.start), focus: '', suffix: body.slice(hunk.end) });
  assert.equal(context.prefix + context.focus + context.suffix, body);
  assert(context.prefix.length + context.suffix.length > 0, 'Insertion must still show actual original context');
  const shown = f.visibleWhitespace(hunk.after);
  assert(shown.whitespaceOnly); assert.equal(shown.newlines, 1); assert.match(shown.text, /↵/); assert(shown.text.trim());
  assert.equal(f.revisionView(proposal).preview, target, 'Display-only source context never enters logical reconstruction');
});

test('real diff distinguishes insertion, deletion and replacement without inventing deleted old text', () => {
  const cases = [
    ['甲😀乙\r\n尾', '甲😀\t 乙\r\n尾', '', '\t ', 'insert'],
    ['甲😀旧段乙\r\n尾', '甲😀乙\r\n尾', '旧段', '', 'delete'],
    ['重复😀\r\n重复😀\r\n尾', '重复😀\r\n替换😁\r\n尾', '重复😀', '替换😁', 'replace'],
  ];
  for (const [body, target, before, after, kind] of cases) {
    const { proposal } = fixture('revise', body, target);
    assert.equal(proposal.review.hunks.length, 1);
    const [hunk] = proposal.review.hunks, context = f.revisionContext(body, hunk);
    assert.equal(hunk.before, before); assert.equal(hunk.after, after);
    assert.equal(hunk.before ? hunk.after ? 'replace' : 'delete' : 'insert', kind);
    assert.equal(context.focus, before);
    assert.equal(context.prefix + context.focus + context.suffix, body);
    assert.equal(body.slice(0, hunk.start) + after + body.slice(hunk.end), target);
    assert.equal(f.revisionView(proposal).pieces.map(piece => piece.text).join(''), target);
  }
});

test('whitespace presentation preserves ordinary prose exactly and makes every nonempty whitespace-only change visible', () => {
  for (const prose of ['普通 prose  ', '甲\r\n乙', '😀\t ', 'line\n\nline']) assert.equal(f.visibleWhitespace(prose).text, prose);
  for (const value of [' ', '\t', '\r\n', '\r', '\n', '\t \r\n\n', '\u00a0', '\u3000']) {
    const view = f.visibleWhitespace(value);
    assert(view.whitespaceOnly); assert(view.text.trim().length > 0, JSON.stringify(value));
    assert.notEqual(view.text, value); assert.equal(view.newlines, (value.match(/\r\n|\r|\n/g) || []).length);
  }
  assert.equal(f.visibleWhitespace('').text, ''); assert.equal(f.visibleWhitespace('').whitespaceOnly, false);
});

test('bounded source context retains exact UTF16/CRLF slices and never cuts surrogate pairs or CRLF', () => {
  const source = '前😀'.repeat(60) + '\r\n中段\r\n' + '后😁'.repeat(60);
  const start = source.indexOf('中段'), hunk = { start, end: start + 2, before: '中段', after: '新段' };
  for (const maxChars of [1, 2, 3, 7, 20]) {
    const result = f.revisionContext(source, hunk, { maxChars, maxLines: 3 });
    assert.equal(result.focus, hunk.before);
    assert(result.prefix.length <= maxChars && result.suffix.length <= maxChars);
    assert.equal(result.prefix, source.slice(start - result.prefix.length, start));
    assert.equal(result.suffix, source.slice(hunk.end, hunk.end + result.suffix.length));
    for (const value of Object.values(result)) validScalars(value);
    assert(boundary(source, start - result.prefix.length)); assert(boundary(source, hunk.end + result.suffix.length));
  }
  const emoji = source.indexOf('😀'), crlf = source.indexOf('\r\n');
  for (const invalid of [{ ...hunk, before: '伪造' }, { start: emoji + 1, end: emoji + 2, before: source.slice(emoji + 1, emoji + 2) }, { start: crlf + 1, end: crlf + 1, before: '' }, { start: -1, end: 0, before: '' }]) assert.equal(f.revisionContext(source, invalid), null);
});

test('actual multi-hunk decisions retain original coordinates after length changes and distinguish target, saved body and mixed preview', () => {
  const middle = '中间重复😀保持不动。'.repeat(12);
  const body = '开场😀\r\n' + middle + '\r\n尾声😁';
  const target = '改写开场😀更长\r\n' + middle + '\r\n结局😁';
  const data = fixture('revise', body, target), original = JSON.stringify(data.book);
  assert(data.proposal.review.hunks.length >= 2, 'Fixture must exercise independent nonadjacent hunks');
  let current = data.book;
  const ids = data.proposal.review.hunks.map(item => item.id).reverse();
  for (const [index, hunkId] of ids.entries()) {
    const action = index === 0 ? 'acceptRevisionHunk' : 'rejectRevisionHunk';
    current = mutateBook(current, { action, proposalId: data.proposal.id, hunkId });
    const proposal = current.proposals[0], view = f.revisionView(proposal);
    assert.equal(view.target, target, 'Immutable full generated target never becomes the partial saved result');
    assert.equal(view.saved, savedChapter(current).body);
    assert.equal(view.pieces.map(piece => piece.text).join(''), view.preview);
    let cursor = 0, expected = '';
    for (const hunk of proposal.review.hunks) {
      expected += body.slice(cursor, hunk.start) + (hunk.state === 'accepted' ? hunk.after : hunk.before);
      cursor = hunk.end;
    }
    expected += body.slice(cursor);
    assert.equal(savedChapter(current).body, expected, 'Do not apply a source coordinate to a progressively shifted preview');
  }
  assert.equal(current.proposals[0].state, 'accepted', 'Mixed accepted/rejected is settled, not silently discarded');
  unchanged(data.book, original);
});

test('UTF16 source selection replaces only the second repeated occurrence including original CRLF preservation', () => {
  const { book, proposal, body, w } = fixture('polish');
  const native = f.textareaValue(body), a = native.lastIndexOf('她说');
  assert.deepEqual(f.sourceOffsets(body, a, a + proposal.selection.text.length), proposal.selection);
  const adopted = accept(book, proposal), next = savedChapter(adopted).body;
  assert.equal(next, body.slice(0, proposal.selection.start) + proposal.text + body.slice(proposal.selection.end));
  assert(next.startsWith(body.slice(0, proposal.selection.start)), 'Earlier identical passage must remain untouched');
  assert(proposal.selection.start > body.indexOf(proposal.selection.text));
  assert.equal(f.polishView(w, proposal).preview, next);
});

test('all mixed-mode current jobs suppress previous durable outcomes throughout running and completion-fetch gaps', () => {
  for (const oldMode of MODES) for (const newMode of MODES) {
    const { w, proposal, id, book } = fixture(oldMode);
    const job = { id: 'new-job', bookId: book.id, chapterId: id, mode: newMode, sourceRevision: savedChapter(book).revision, selection: newMode === 'polish' ? { start: 0, end: 2, text: BODY.slice(0, 2) } : null, text: '新任务预览', status: 'running' };
    const before = JSON.stringify(w);
    for (const status of ['running', 'completed']) {
      const current = { ...job, status, proposalId: 'not-durable-yet' };
      assert.strictEqual(f.generatedDisplayRecord(w, proposal, current), current, `${oldMode} -> ${newMode} ${status}`);
      assert.notStrictEqual(f.generatedDisplayRecord(w, proposal, current), proposal);
      if (newMode !== 'revise') assert.equal(viewFor(w, current)?.durable, false);
    }
    unchanged(w, before);
    assert.strictEqual(f.generatedDisplayRecord(w, proposal, { ...job, bookId: 'other' }), proposal);
    assert.strictEqual(f.generatedDisplayRecord(w, proposal, { ...job, chapterId: 'other' }), proposal);
  }
});

test('completed jobs resolve their own durable result rather than whichever older candidate is still selected, including missing legacy metadata', () => {
  for (const oldMode of MODES) for (const newMode of MODES) {
    const old = fixture(oldMode);
    const newer = fixture(newMode);
    // Generate the new proposal against this same exact chapter using the real core.
    const options = { mode: newMode, instruction: '具体修订', selection: newer.proposal.selection };
    const next = makeProposal(old.book, old.id, options, newer.text, buildContext(old.book, old.id, options), newMode === 'revise' ? { analysis: '明确修订' } : {});
    const latest = mutateBook(old.book, { action: 'addProposal', proposal: next });
    const w = { ...f.workspace(latest), candidateId: old.proposal.id, candidate: old.proposal.text, baseCandidate: old.proposal.text };
    const durable = w.book.proposals.find(record => record.id === next.id);
    for (const metadata of [{ mode: newMode, sourceRevision: next.sourceRevision, selection: next.selection }, {}]) {
      const job = { id: 'completed-new-job', bookId: latest.id, chapterId: old.id, status: 'completed', proposalId: next.id, text: next.text, ...metadata };
      assert.strictEqual(f.generatedDisplayRecord(w, old.proposal, job), durable, `${oldMode} -> ${newMode}, legacy=${!metadata.mode}`);
      for (const draft of [{ ...w, candidate: w.candidate + 'dirty result' }, { ...w, chapter: { ...w.chapter, body: BODY + 'manual' } }]) {
        const before = JSON.stringify(draft);
        assert.strictEqual(f.generatedDisplayRecord(draft, old.proposal, job), old.proposal, 'New completed result must not cover older local edits');
        unchanged(draft, before);
      }
      for (const guards of [{ recovery: {} }, { conflict: {} }]) assert.strictEqual(f.generatedDisplayRecord(w, old.proposal, job, guards), old.proposal);
    }
  }
});

test('generic public-job fallback requires exact saved revision; durable snapshot rendering cannot confer membership to a forged record', () => {
  for (const mode of ['draft', 'continue', 'summary']) {
    const { w, proposal, id, book } = fixture(mode);
    const job = { id: 'legacy-job', bookId: book.id, chapterId: id, mode, sourceRevision: savedChapter(book).revision, text: '仅预览', status: 'completed' };
    const view = f.generatedReviewView(w, job);
    assert(view); assert.equal(view.source, BODY); assert.equal(view.durable, false);
    assert.equal(f.generatedReviewView(w, { ...job, sourceRevision: undefined }), null);
    assert.equal(f.generatedReviewView(w, { ...job, sourceRevision: job.sourceRevision + 1 }), null);
    assert.equal(f.generatedReviewView(w, { ...job, bookId: 'other' }), null);
    assert.equal(f.generatedReviewView(w, { ...job, chapterId: 'other' }), null);
    assert.equal(f.generatedReviewView(w, { ...proposal, text: proposal.text + 'unreviewed' }).durable, false);
  }
});

test('legacy dirty candidate recovery is lossless across background adoption and cannot silently disappear', () => {
  const { w, book, id } = fixture('continue');
  const draft = { ...w, candidate: '0.1.5 作者编辑的候选\r\n😀  ', chapter: { ...w.chapter, body: BODY + '\r\n手动草稿' } };
  const before = JSON.stringify(draft), payload = f.recoveryPayload(draft);
  assert(f.validRecovery(JSON.parse(JSON.stringify(payload)), book.id));
  assert.equal(payload.candidate, draft.candidate); assert.equal(payload.baseCandidate, w.baseCandidate); assert.equal(payload.dirty.candidate, true);
  const request = { mode: 'draft' }, fresh = makeProposal(book, id, request, '另一任务', buildContext(book, id, request));
  const latest = mutateBook(book, { action: 'addProposal', proposal: fresh });
  const merged = f.mergeWorkspace(draft, latest);
  assert.equal(merged.candidate, draft.candidate); assert.equal(merged.baseCandidate, draft.baseCandidate);
  assert.equal(merged.chapter.body, draft.chapter.body); assert(f.isDirty(merged));
  const exported = JSON.stringify(f.recoveryPayload(merged));
  assert.equal(JSON.parse(exported).candidate, draft.candidate);
  unchanged(draft, before);
});

test('revision and polish defer automatic and explicit previews for each dirty group, recovery and conflict', () => {
  for (const mode of ['polish', 'revise']) {
    const { w, proposal } = fixture(mode);
    const decide = mode === 'polish' ? f.polishPreviewDecision : f.revisionPreviewDecision;
    const clean = decide(w, proposal, null);
    assert(clean.visible);
    const drafts = [
      { ...w, chapter: { ...w.chapter, body: BODY + '本地稿' } },
      { ...w, settings: { ...w.settings, style: '本地文风' } },
      { ...w, card: { title: '本地卡' }, baseCard: null },
      { ...w, candidate: w.candidate + '旧版候选编辑' },
    ];
    for (const draft of drafts) for (const key of [null, 'preview:' + clean.key]) {
      const before = JSON.stringify(draft), result = decide(draft, proposal, key);
      assert.equal(result.visible, false); assert.equal(result.deferred, true); unchanged(draft, before);
    }
    for (const guard of [{ recovery: {} }, { conflict: {} }]) assert.equal(decide(w, proposal, null, guard).visible, false);
  }
});

test('actual revision hunk action rejects stale rendered identity, changed source/text, busy and dirty candidate without a mutation', () => {
  const { w, proposal, book } = fixture('revise'), hunk = proposal.review.hunks[0];
  const snapshot = f.revisionHunkSnapshot(w, proposal, hunk.id);
  assert.equal(f.revisionActionProblem(w, snapshot), '');
  assert(Object.isFrozen(snapshot));
  for (const change of [
    value => { value.book.id = 'other'; }, value => { value.book.revision++; }, value => { value.chapterId = 'other'; },
    value => { value.candidateId = 'other'; }, value => { value.book.chapters[0].body += 'remote'; },
    value => { value.book.proposals[0].text += 'remote'; }, value => { value.book.proposals[0].review.hunks[0].after += 'remote'; },
  ]) {
    const next = structuredClone(w); change(next); const before = JSON.stringify(next);
    assert(f.revisionActionProblem(next, snapshot)); unchanged(next, before);
  }
  assert.equal(f.revisionActionProblem(w, snapshot, { busy: true }), 'working');
  assert.equal(f.revisionActionProblem({ ...w, candidate: w.candidate + 'dirty' }, snapshot), 'saveFirst');
  const before = JSON.stringify(book);
  assert.equal(f.revisionActionProblem(w, snapshot, { recovery: {} }), 'manageRecovery'); unchanged(book, before);
});

test('generic review defers all dirty groups/recovery/conflict without losing local text or allowing explicit bypass', () => {
  for (const mode of ['draft', 'continue', 'summary']) {
    const { w, proposal } = fixture(mode), clean = f.generatedPreviewDecision(w, proposal, null);
    assert(clean.visible);
    const variants = [
      { ...w, chapter: { ...w.chapter, body: BODY + 'manual' } },
      { ...w, chapter: { ...w.chapter, summary: 'manual summary' } },
      { ...w, settings: { ...w.settings, style: 'manual style' } },
      { ...w, card: { title: 'manual card' }, baseCard: null },
      { ...w, candidate: w.candidate + '0.1.5 unsaved result' },
    ];
    for (const draft of variants) for (const key of [null, 'preview:' + clean.key]) {
      const before = JSON.stringify(draft), decision = f.generatedPreviewDecision(draft, proposal, key);
      assert.equal(decision.visible, false); assert.equal(decision.deferred, true); unchanged(draft, before);
    }
    for (const guard of [{ recovery: {} }, { conflict: {} }]) for (const key of [null, 'preview:' + clean.key]) assert.equal(f.generatedPreviewDecision(w, proposal, key, guard).visible, false);
  }
});

test('generic rendered acceptance snapshot binds source, exact result and identity; stale/busy/dirty/forged controls authorize zero writes', () => {
  for (const mode of ['draft', 'continue', 'summary']) {
    const { w, proposal } = fixture(mode), snapshot = f.generatedActionSnapshot(w, proposal);
    assert(Object.isFrozen(snapshot)); assert(Object.values(snapshot).every(value => value === null || typeof value !== 'object'));
    assert.equal(f.generatedActionProblem(w, snapshot), '');
    const before = JSON.stringify(w);
    for (const change of [
      value => { value.book.id = 'other'; }, value => { value.book.revision++; }, value => { value.chapterId = 'other'; },
      value => { value.candidateId = 'other'; }, value => { value.book.chapters[0].body += 'remote'; },
      value => { value.book.chapters[0].summary += 'remote'; }, value => { value.book.proposals[0].text += 'remote'; },
      value => { value.book.proposals[0].state = 'accepted'; }, value => { value.book.proposals[0].sourceBody += 'remote'; },
    ]) {
      const next = structuredClone(w); change(next); const nextBefore = JSON.stringify(next);
      assert(f.generatedActionProblem(next, snapshot), 'Old render cannot silently retarget'); unchanged(next, nextBefore);
    }
    for (const accept of [true, false]) {
      assert.equal(f.generatedActionProblem(w, snapshot, { busy: true, accept }), 'working');
      assert.equal(f.generatedActionProblem(w, snapshot, { unavailable: true, accept }), 'bookMissing');
      assert.equal(f.generatedActionProblem(w, snapshot, { recovery: {}, accept }), 'manageRecovery');
      assert.equal(f.generatedActionProblem(w, snapshot, { conflict: {}, accept }), 'saveFirst');
      assert.equal(f.generatedActionProblem({ ...w, candidate: w.candidate + 'dirty' }, snapshot, { accept }), 'saveFirst');
    }
    assert.equal(f.generatedActionSnapshot(w, { ...proposal, text: 'forged preview' }), null);
    const job = { ...proposal, id: 'job-not-a-proposal', status: 'completed', proposalId: 'not-fetched' };
    delete job.sourceBody;
    assert.equal(f.generatedActionSnapshot(w, job), null);
    assert.equal(f.generatedActionProblem(w, null), 'confirmChanged'); unchanged(w, before);
  }
});

test('generic stale durable results remain explicitly comparable and rejectable, never acceptable', () => {
  for (const mode of ['draft', 'continue', 'summary']) {
    const { book, proposal, id } = fixture(mode);
    const changed = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body: BODY + 'saved manual' } });
    const w = f.workspace(changed), snapshot = f.generatedActionSnapshot(w, w.book.proposals[0]);
    const automatic = f.generatedPreviewDecision(w, proposal, null);
    assert.equal(automatic.visible, false);
    assert.equal(f.generatedPreviewDecision(w, proposal, 'preview:' + automatic.key).visible, true);
    assert.equal(f.generatedActionProblem(w, snapshot), 'stale');
    assert.equal(f.generatedActionProblem(w, snapshot, { accept: false }), '');
  }
});

test('settled author rejection returns to manual manuscript in all five modes, with explicit historical comparison retained', () => {
  for (const mode of MODES) {
    const { book, proposal, w } = fixture(mode);
    const decide = mode === 'revise' ? f.revisionPreviewDecision : mode === 'polish' ? f.polishPreviewDecision : f.generatedPreviewDecision;
    const key = decide(w, proposal, null).key;
    const rejected = mutateBook(book, { action: 'rejectProposal', proposalId: proposal.id });
    const next = f.workspace(rejected), record = rejected.proposals[0];
    assert.equal(decide(next, record, null).visible, false, `${mode}: settled rejection must not keep covering manual manuscript`);
    assert.equal(decide(next, record, key).visible, false);
    assert.equal(decide(next, record, 'preview:' + key).visible, true, 'Historical compare is an explicit read, not an accept');
    assert.deepEqual(savedChapter(rejected), savedChapter(book));
  }
});

test('visibility guard prevents old enabled handlers from acting on hidden/manual, generation-gap, blocked or different current results in all modes', () => {
  for (const mode of MODES) {
    const { w, proposal } = fixture(mode);
    const snapshot = mode === 'revise' ? f.bulkRevisionSnapshot(w, proposal) : mode === 'polish' ? f.polishActionSnapshot(w, proposal) : f.generatedActionSnapshot(w, proposal);
    const shown = { bookId: w.book.id, chapterId: w.chapterId, proposalId: proposal.id, visible: true, blocked: false };
    const before = JSON.stringify(w);
    assert.equal(f.visibleReviewProblem(snapshot, shown), '');
    for (const current of [null, { ...shown, visible: false }, { ...shown, bookId: 'other' }, { ...shown, chapterId: 'other' }, { ...shown, proposalId: 'next-result' }]) assert.equal(f.visibleReviewProblem(snapshot, current), 'confirmChanged');
    assert.equal(f.visibleReviewProblem(null, shown), 'confirmChanged');
    assert.equal(f.visibleReviewProblem(snapshot, { ...shown, blocked: true }), 'working');
    // Removing this guard would leave all source/identity checks valid: toggling
    // manual view or starting generation does not itself alter the saved book.
    const underlying = mode === 'revise' ? f.bulkRevisionProblem : mode === 'polish' ? f.polishActionProblem : f.generatedActionProblem;
    assert.equal(underlying(w, snapshot), '');
    unchanged(w, before);
  }
  const mutant = helperSource.replace('!review.visible || ', '');
  assert.notEqual(mutant, helperSource);
  const data = fixture('draft'), snapshot = f.generatedActionSnapshot(data.w, data.proposal);
  const hidden = { bookId: data.book.id, chapterId: data.id, proposalId: data.proposal.id, visible: false, blocked: false };
  assert.throws(() => assert.equal(extract(mutant).visibleReviewProblem(snapshot, hidden), 'confirmChanged'));
});

test('source wiring only: every decision checks latest visibility twice and manual toggles invalidate stale review synchronously', () => {
  for (const [name, next] of [['applyPolish', 'applyGenerated'], ['applyGenerated', 'applyRevisionAll'], ['applyRevisionAll', 'applyRevisionHunk'], ['applyRevisionHunk', null]]) {
    const start = client.indexOf('          const ' + name + ' =');
    const end = next ? client.indexOf('          const ' + next + ' =', start) : client.indexOf('          useEffect(() =>', start);
    assert(start >= 0 && end > start);
    const callback = client.slice(start, end), guard = 'visibleReviewProblem(snapshot, reviewRef.current)';
    const first = callback.indexOf(guard), busy = callback.indexOf('return withBusy(async () =>'), second = callback.indexOf(guard, first + 1), mutate = callback.indexOf('await mutateRaw(');
    assert(first >= 0 && first < busy && second > busy && second < mutate, name);
  }
  for (const key of ['Review', 'Polish']) assert(client.includes('const setOriginal' + key + 'Key = value => { reviewRef.current = null; updateOriginal' + key + 'Key(value); };'));
});

// Execute the production review projection, click callbacks, busy lock and
// write dispatch together. A deferred autosave wait permits the busy render
// to run before inside-lock validation, as observed in the installed panel.
function decisionHarness(data, clientSource = client) {
  const slice = (from, to) => {
    const start = clientSource.indexOf(from), end = clientSource.indexOf(to, start + from.length);
    assert(start >= 0 && end > start);
    return clientSource.slice(start, end);
  };
  const locked = slice('          const locked =', '          const manageProblem');
  const review = slice('          reviewRef.current = proposal ?', '          const bulkSnapshot');
  const project = new Function('env', `with(env) { ${locked}\n${review}\nreturn locked; }`);
  const run = new Function('env', `with(env) {
    ${slice('          const withBusy =', '          autosaveBindings.current =')}
    ${slice('          const applyPolish =', '          useEffect(() => {\n            alive.current = true;')}
    return {applyPolish,applyGenerated,applyRevisionAll,applyRevisionHunk};
  }`);
  const current = { current: data.w }, reviewRef = { current: null }, errors = [], requests = [], notices = [];
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let saved = data.book;
  const mode = data.proposal.mode;
  const env = { ...f, current, reviewRef, w: data.w, proposal: data.proposal, tab: 'writing', busy: false, loading: false, job: null, awaitingOutcome: false,
    manager: null, guard: null, confirm: null, polishRequirements: null, constraintsHelpOpen: false, conflict: null, recovery: null, recoveryRef: { current: null },
    isRevision: mode === 'revise', isPolish: mode === 'polish', revisionPreviewVisible: mode === 'revise', polishPreviewVisible: mode === 'polish',
    generatedVisible: mode !== 'revise' && mode !== 'polish', alive: { current: true }, busyRef: { current: false }, autosaveComposing: { current: false },
    epoch: { current: 0 }, pendingLatest: { current: null }, autosaveRef: { current: { wait: () => wait } },
    deletedBookIds: new Set(), unavailableBooks: { current: new Map() }, bookIsAvailable: () => true,
    setBusy: busy => { env.busy = busy; project(env); }, setError: error => { if (error) errors.push(error); }, messageError: error => errors.push(error),
    t: key => key, capturePolishReturn: () => null, queuePolishViewport: () => {}, setOriginalPolishKey: () => {}, setOriginalReviewKey: () => {},
    resetSelection: () => {}, setNotice: key => notices.push(key),
    call: async (action, request) => {
      assert.equal(action, 'mutate'); requests.push(request);
      assert.equal(request.bookId, saved.id);
      if (request.expectedRevision !== saved.revision) throw Object.assign(new Error('Conflict'), { code: 'CONFLICT' });
      saved = mutateBook(saved, request.operation); return saved;
    },
    adopt: book => { current.current = f.mergeWorkspace(current.current, book); return true; },
  };
  project(env);
  return { ...run(env), env, reviewRef, release, errors, requests, notices, project: () => project(env),
    get saved() { return saved; }, set saved(value) { saved = value; } };
}

for (const [mode, callback, operation, accept] of [
  ['revise', 'applyRevisionHunk', 'acceptRevisionHunk', true], ['revise', 'applyRevisionHunk', 'rejectRevisionHunk', false],
  ['revise', 'applyRevisionAll', 'acceptRevisionAll', true], ['polish', 'applyPolish', 'acceptProposal', true],
  ['polish', 'applyPolish', 'rejectProposal', false], ['draft', 'applyGenerated', 'acceptProposal', true],
  ['continue', 'applyGenerated', 'acceptProposal', true], ['summary', 'applyGenerated', 'acceptProposal', true],
  ['draft', 'applyGenerated', 'rejectProposal', false],
]) test(`${callback}/${mode}/${operation}: a busy render still settles exactly one author click`, async () => {
  const data = fixture(mode), h = decisionHarness(data);
  const make = { applyRevisionHunk: f.revisionHunkSnapshot, applyRevisionAll: f.bulkRevisionSnapshot, applyPolish: f.polishActionSnapshot, applyGenerated: f.generatedActionSnapshot }[callback];
  const hunkId = callback === 'applyRevisionHunk' ? data.proposal.review.hunks[0].id : undefined;
  const snapshot = make(data.w, data.proposal, hunkId);
  const first = h[callback](snapshot, accept);
  assert.equal(h.env.busyRef.current, true);
  assert.equal(h.project(), true, 'Controls stay locked while the first decision is pending');
  assert.equal(h.requests.length, 0);
  await h[callback](snapshot, accept); // Rapid double-click/wrong stale event cannot start another action.
  assert.deepEqual(h.errors, [], 'A repeated click during the first decision does not open an error dialog');
  h.release();
  assert.equal(await first, true, h.errors.map(error => `${error.code}: ${error.message}`).join('; '));
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.requests, [{ bookId: data.book.id, expectedRevision: data.book.revision, operation: { action: operation, proposalId: data.proposal.id, ...(hunkId ? { hunkId } : {}) } }]);
  assert.equal(savedChapter(h.saved).body, accept ? expectedBody(data) : data.body);
  assert.equal(h.saved.proposals[0].state, accept ? 'accepted' : 'rejected');
  assert.equal(h.notices.length, 1);
  await h[callback](snapshot, accept);
  assert.equal(h.requests.length, 1, 'Old callback cannot replay after the saved revision advances');
  assert.equal(h.errors[0]?.message, 'confirmChanged');
});

for (const [name, change] of [
  ['hidden', h => { h.env.revisionPreviewVisible = false; }],
  ['other page', h => { h.env.tab = 'constraints'; }],
  ['another generation', h => { h.env.job = { status: 'running' }; }],
  ['confirmation', h => { h.env.confirm = {}; }],
  ['requirements dialog', h => { h.env.polishRequirements = {}; }],
  ['recovery', h => { h.env.recovery = h.env.recoveryRef.current = {}; }],
  ['unsaved chapter', h => { const w = h.env.current.current; h.env.current.current = { ...w, chapter: { ...w.chapter, body: w.chapter.body + '本地未保存' } }; }],
  ['changed saved revision', h => { h.env.current.current = f.workspace(mutateBook(h.saved, { action: 'updateBook', patch: { premise: 'New saved premise' } })); }],
]) test(`inside-lock recheck refuses ${name} without sending an author mutation`, async () => {
  const data = fixture('revise'), h = decisionHarness(data);
  const snapshot = f.revisionHunkSnapshot(data.w, data.proposal, data.proposal.review.hunks[0].id);
  const first = h.applyRevisionHunk(snapshot, true);
  change(h); h.project(); h.release();
  assert.equal(await first, false);
  assert.equal(h.errors[0]?.code, 'REVIEW_REQUIRED');
  assert.equal(h.requests.length, 0); assert.equal(h.saved, data.book);
});

test('an unseen concurrent saved version still rejects a review by CAS without changing manuscript', async () => {
  const data = fixture('revise'), h = decisionHarness(data);
  const snapshot = f.bulkRevisionSnapshot(data.w, data.proposal);
  const first = h.applyRevisionAll(snapshot);
  const remote = mutateBook(data.book, { action: 'updateChapter', chapterId: data.id, patch: { body: data.body + '作者另存' } });
  h.saved = remote; h.release();
  assert.equal(await first, false);
  assert.equal(h.errors[0]?.code, 'CONFLICT');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].expectedRevision, data.book.revision);
  assert.equal(h.saved, remote); assert.equal(h.saved.proposals[0].state, 'ready');
});

test('bulk visible-result guard freezes exact durable identity and refuses stale, dirty, recovery, busy and forged outcomes without writing', () => {
  const { w, proposal, book, id } = fixture('revise'), snapshot = f.bulkRevisionSnapshot(w, proposal);
  assert(Object.isFrozen(snapshot)); assert(Object.values(snapshot).every(value => value === null || typeof value !== 'object'));
  assert.equal(f.bulkRevisionProblem(w, snapshot), '');
  const before = JSON.stringify(w);
  for (const change of [
    value => { value.book.id = 'other'; }, value => { value.book.revision++; }, value => { value.chapterId = 'other'; },
    value => { value.candidateId = 'other'; }, value => { value.book.chapters[0].body += 'remote'; },
    value => { value.book.proposals[0].text += 'remote'; }, value => { value.book.proposals[0].review.hunks[0].after += 'remote'; },
    value => { value.book.proposals[0].state = 'accepted'; },
  ]) {
    const next = structuredClone(w); change(next); const nextBefore = JSON.stringify(next);
    assert(f.bulkRevisionProblem(next, snapshot)); unchanged(next, nextBefore);
  }
  for (const [options, expected] of [[{ busy: true }, 'working'], [{ unavailable: true }, 'bookMissing'], [{ recovery: {} }, 'manageRecovery'], [{ conflict: {} }, 'saveFirst']]) assert.equal(f.bulkRevisionProblem(w, snapshot, options), expected);
  for (const dirty of [
    { ...w, candidate: w.candidate + 'old recovery edits' }, { ...w, chapter: { ...w.chapter, body: BODY + 'manual' } },
    { ...w, settings: { ...w.settings, style: 'manual' } }, { ...w, card: { title: 'manual' }, baseCard: null },
  ]) assert.equal(f.bulkRevisionProblem(dirty, snapshot), 'saveFirst');
  assert.equal(f.bulkRevisionSnapshot(w, { ...proposal, text: proposal.text + 'forged' }), null);
  assert.equal(f.bulkRevisionSnapshot(w, { ...proposal, id: 'job-not-durable', status: 'completed' }), null);
  assert.equal(f.bulkRevisionProblem(w, null), 'confirmChanged');
  const changed = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body: BODY + 'saved author text' } }), stale = f.workspace(changed);
  assert.equal(f.bulkRevisionProblem(stale, f.bulkRevisionSnapshot(stale, stale.book.proposals[0])), 'stale');
  unchanged(w, before);
});

test('bulk guard honors partial accepted/rejected source algebra and refuses settled outcomes', () => {
  const bridge = '不变的长段落😀。'.repeat(15), body = '起点\r\n' + bridge + '\r\n中点\r\n' + bridge + '\r\n终点';
  const target = body.replace('起点', '新起点').replace('中点', '新中点').replace('终点', '新终点');
  const { book, proposal } = fixture('revise', body, target);
  assert(proposal.review.hunks.length >= 3);
  let partial = mutateBook(book, { action: 'acceptRevisionHunk', proposalId: proposal.id, hunkId: proposal.review.hunks[0].id });
  partial = mutateBook(partial, { action: 'rejectRevisionHunk', proposalId: proposal.id, hunkId: proposal.review.hunks[1].id });
  const w = f.workspace(partial), current = partial.proposals[0], before = JSON.stringify(partial);
  assert.equal(f.revisionView(current).saved, savedChapter(partial).body);
  assert.equal(f.bulkRevisionProblem(w, f.bulkRevisionSnapshot(w, current)), '', 'Previously rejected hunks are not a reason to overwrite them or block remaining review');
  unchanged(partial, before);
  for (const hunk of current.review.hunks.filter(item => item.state === 'pending')) partial = mutateBook(partial, { action: 'rejectRevisionHunk', proposalId: current.id, hunkId: hunk.id });
  const settled = f.workspace(partial), snap = f.bulkRevisionSnapshot(settled, partial.proposals[0]);
  assert.equal(f.bulkRevisionProblem(settled, snap), 'confirmChanged');
});

test('bulk source wiring only: one visible rendered result uses one guarded author mutation, never every proposal or book', () => {
  const start = client.indexOf('          const applyRevisionAll ='), end = client.indexOf('          const applyRevisionHunk =', start);
  assert(start >= 0 && end > start);
  const action = client.slice(start, end), first = action.indexOf('bulkRevisionProblem(current.current, snapshot');
  const busy = action.indexOf('return withBusy(async () =>'), second = action.indexOf('bulkRevisionProblem(current.current, snapshot', first + 1), mutate = action.indexOf('await mutateRaw(');
  assert(first >= 0 && first < busy && second > busy && second < mutate);
  assert(action.includes("action: 'acceptRevisionAll', proposalId: snapshot.proposalId"));
  assert.equal((action.match(/await mutateRaw\(/g) || []).length, 1);
  assert(!action.includes('.map(') && !action.includes('.forEach(') && !action.includes('saveAll('));
  assert(client.includes('applyRevisionAll(bulkSnapshot) : isPolish ? applyPolish(bulkSnapshot, true) : applyGenerated(bulkSnapshot, true)'));
  assert(client.includes('disabled: !!bulkProblem || !bulkPreview'));
});

function checkRenderedActionWiring(text) {
  const start = text.indexOf('          const applyGenerated =');
  const end = text.indexOf('          const applyRevisionHunk =', start);
  assert(start >= 0 && end > start, 'Actual callback boundaries must exist');
  const callback = text.slice(start, end);
  const firstGuard = callback.indexOf('generatedActionProblem(current.current, snapshot');
  const busy = callback.indexOf('return withBusy(async () =>');
  const secondGuard = callback.indexOf('generatedActionProblem(current.current, snapshot', firstGuard + 1);
  const mutate = callback.indexOf('await mutateRaw(');
  assert(firstGuard >= 0 && firstGuard < busy && secondGuard > busy && secondGuard < mutate, 'Render-bound snapshot is checked before and inside the write gate');
  assert(callback.includes('if (busyRef.current) return;'));
  assert(callback.includes('busy: loading || !!manager || !!guard || !!confirm'));
  assert(callback.includes('proposalId: snapshot.proposalId'));
  assert(!callback.includes('saveAll(') && !callback.includes('updateProposal'), 'Accept cannot silently save edited outcomes');
  assert(text.includes('const proposal = awaitingOutcome ? null : displayRecord;'), 'Do not render older candidate controls against newer current job output');
  const actionStart = text.indexOf('          const renderGeneratedActions =');
  const actionEnd = text.indexOf('          const renderGeneratedPreview =', actionStart);
  assert(actionStart >= 0 && actionEnd > actionStart);
  const render = text.slice(actionStart, actionEnd);
  assert(render.includes('displayRecord !== proposal'));
  assert(render.includes('const snapshot = generatedActionSnapshot(w, proposal)'));
  assert(render.includes('() => applyGenerated(snapshot, true)'));
  assert(render.includes('() => applyGenerated(snapshot, false)'));
}

test('source wiring only: generic inline decisions bind the rendered result and recheck the current author guard twice', () => {
  // This connects the dynamic helper contracts to the actual client source, but
  // does not prove browser mounting, click dispatch, layout or perceived timing.
  checkRenderedActionWiring(client);
  for (const [before, after] of [
    ['const proposal = awaitingOutcome ? null : displayRecord;', 'const proposal = awaitingOutcome ? null : selectedProposal;'],
    ['() => applyGenerated(snapshot, true)', '() => applyGenerated(generatedActionSnapshot(current.current, proposal), true)'],
    ['const problem = visibleReviewProblem(snapshot, reviewRef.current) || generatedActionProblem(current.current, snapshot, options());', "const problem = '';"],
  ]) {
    const mutant = client.replace(before, after); assert.notEqual(mutant, client);
    assert.throws(() => checkRenderedActionWiring(mutant), 'The source probe must reject its own targeted wiring regression');
  }
});

test('mutation sanity: contracts detect wrong context focus, continuation replacement and removed busy guards', () => {
  const { w, proposal } = fixture('continue');
  const continuationMutant = helperSource.replace("preview: record.mode === 'continue' ? source + record.text : record.text", 'preview: record.text');
  assert.notEqual(continuationMutant, helperSource);
  assert.throws(() => assert.equal(extract(continuationMutant).generatedReviewView(w, proposal).preview, BODY + proposal.text));
  const contextMutant = helperSource.replace('focus: source.slice(hunk.start, hunk.end)', "focus: 'fabricated deleted text'");
  assert.notEqual(contextMutant, helperSource);
  const data = fixture('revise', '甲\r\n乙', '甲\r\n\r\n乙'), hunk = data.proposal.review.hunks[0];
  assert.throws(() => assert.equal(extract(contextMutant).revisionContext(data.body, hunk).focus, hunk.before));
  const busyMutant = helperSource.replaceAll("if (busy) return 'working';", '');
  const revision = fixture('revise'), snapshot = f.revisionHunkSnapshot(revision.w, revision.proposal, revision.proposal.review.hunks[0].id);
  assert.throws(() => assert.equal(extract(busyMutant).revisionActionProblem(revision.w, snapshot, { busy: true }), 'working'));
  assert.throws(() => assert.equal(extract(busyMutant).bulkRevisionProblem(revision.w, f.bulkRevisionSnapshot(revision.w, revision.proposal), { busy: true }), 'working'));
  assert.throws(() => assert.equal(extract(busyMutant).generatedActionProblem(w, f.generatedActionSnapshot(w, proposal), { busy: true }), 'working'));
});
