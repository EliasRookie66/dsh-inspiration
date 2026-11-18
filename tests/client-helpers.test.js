import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createBook, mutateBook, buildContext, makeProposal } from '../core.js';

// Exercise actual renderer-independent client helpers, not a second implementation.
// The refresh helper injects only list/open operations, never a UI framework.
// This file never invokes ModuleLoader, React, a renderer, a browser, or a DOM mock.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('    const equal =');
const end = source.indexOf('    const en =');
assert(start > 0 && end > start, 'Pure helper extraction boundaries remain explicit');
const helperSource = source.slice(start, end);
const helpersFrom = text => new Function(text + '\nreturn {workspace,dirty,isDirty,patchOf,chapterFields,conflictingFields,mergeWorkspace,recoveryPayload,validRecovery,staleProposal,sourceOffsets,textareaValue,applyTextareaEdit,reviewSnapshot,reviewIsCurrent,managementSnapshot,managementIsCurrent,managementProblem,deletionProblem,deletionReceipt,afterBookDeletion,refreshAfterBookDeletion,bookIsAvailable,markBookUnavailable,reconcileBookAvailability};')();
const f = helpersFrom(helperSource);

let book = mutateBook(createBook('测试 · Book'), { action: 'addChapter', title: 'One' });
const id = book.chapters[0].id;
book = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body: '甲\r\n😀乙\r\n末', summary: '旧摘要' } });
book = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { summary: '已确认摘要' } });
const base = f.workspace(book, id);
const edited = { ...base, chapter: { ...base.chapter, body: base.chapter.body + '\r\n作者新稿' } };
const context = buildContext(book, id, { mode: 'continue' });
const proposal = makeProposal(book, id, { mode: 'continue' }, 'AI continuation', context);
const completed = mutateBook(book, { action: 'addProposal', proposal });
const changed = mutateBook(book, { action: 'updateChapter', chapterId: id, patch: { body: '其他作者的新正文' } });
const saved = mutateBook(completed, { action: 'updateChapter', chapterId: id, patch: f.patchOf(base.baseChapter, edited.chapter) });

test('background proposal does not conflict with local body edits', () => {
  assert.deepEqual(f.conflictingFields(edited, completed), []);
});
test('new revision is adopted without overwriting the local manuscript', () => {
  const merged = f.mergeWorkspace(edited, completed);
  assert.equal(merged.chapter.body, edited.chapter.body);
  assert.equal(merged.book.revision, completed.revision);
  assert.equal(merged.baseChapter.body, base.chapter.body);
  assert(f.isDirty(merged));
});
test('concurrent saved body changes produce an explicit conflict', () => {
  assert.deepEqual(f.conflictingFields(edited, changed), ['chapter']);
});
test('explicit rebase retains local body and only updates its baseline', () => {
  const next = f.mergeWorkspace(edited, changed, null, true);
  assert.equal(next.chapter.body, edited.chapter.body);
  assert.equal(next.baseChapter.body, '其他作者的新正文');
  assert(f.isDirty(next));
});
test('chapter save emits no unchanged summary field', () => {
  assert.deepEqual(f.patchOf(base.baseChapter, edited.chapter), { body: edited.chapter.body });
});
test('server save invalidates the old summary', () => {
  assert.equal(saved.chapters[0].summaryRevision, null);
});
test('saved chapter clears only its own dirty group', () => {
  const both = { ...edited, settings: { ...edited.settings, premise: '我的前提' } };
  const merged = f.mergeWorkspace(both, saved, 'chapter');
  assert.equal(f.dirty(merged).chapter, false);
  assert.equal(f.dirty(merged).settings, true);
  assert.equal(merged.settings.premise, '我的前提');
});
test('recovery payload round-trips dirty values and original baseline', () => {
  const r = f.recoveryPayload(edited);
  assert(f.validRecovery(JSON.parse(JSON.stringify(r)), book.id));
  assert.equal(r.chapter.body, edited.chapter.body);
  assert.equal(r.baseChapter.body, base.chapter.body);
});
test('malformed or wrong-book recovery is rejected', () => {
  assert(!f.validRecovery({}, book.id));
  assert(!f.validRecovery(f.recoveryPayload(edited), 'another-book'));
  const r = f.recoveryPayload(edited);
  r.chapter = { body: 3 };
  assert(!f.validRecovery(r, book.id));
});
test('source revision/body changes invalidate an old proposal', () => {
  assert(!f.staleProposal(f.workspace(completed, id), proposal));
  assert(f.staleProposal(f.workspace(saved, id), proposal));
});
test('newly accepted candidate conflicts with unsaved proposal edits', () => {
  const w = f.workspace(completed, id);
  const draft = { ...w, candidate: w.candidate + ' edit' };
  const accepted = mutateBook(completed, { action: 'acceptProposal', proposalId: proposal.id });
  assert(f.conflictingFields(draft, accepted).includes('candidate'));
});
test('native LF values map to exact CRLF source offsets', () => {
  assert.equal(f.textareaValue(book.chapters[0].body), '甲\n😀乙\n末');
  assert.deepEqual(f.sourceOffsets(book.chapters[0].body, 2, 5), { start: 3, end: 6, text: '😀乙' });
  assert.deepEqual(f.sourceOffsets(book.chapters[0].body, 1, 6), { start: 1, end: 8, text: '\r\n😀乙\r\n' });
});
test('invalid textarea offsets are rejected', () => {
  for (const [a, b] of [[-1, 2], [2, 1], [0, 100], [0.5, 2]]) assert.equal(f.sourceOffsets('abc', a, b), null);
});
test('no-op native editing preserves every original CRLF', () => {
  assert.equal(f.applyTextareaEdit(book.chapters[0].body, f.textareaValue(book.chapters[0].body)), book.chapters[0].body);
});
test('localized editing preserves untouched original line endings', () => {
  assert.equal(f.applyTextareaEdit('甲\r\n乙\r\n丙', '甲\n新乙\n丙'), '甲\r\n新乙\r\n丙');
  assert.equal(f.applyTextareaEdit('a\r\nb\rc\nd', 'a\nbX\nc\nd'), 'a\r\nbX\rc\nd');
  assert.equal(f.applyTextareaEdit('a\r\nb', 'a\nb\nc'), 'a\r\nb\r\nc');
});
test('editing cannot merge distinct logical newlines at original-text splice boundaries', () => {
  for (const [original, value] of [['a\rb\nc', 'a\n\nc'], ['\r\nb\rZ\n', '\n\n\n'], ['\r', '\n\n']]) {
    assert.equal(f.textareaValue(f.applyTextareaEdit(original, value)), value);
  }
});
test('all short mixed-newline insertions and deletions preserve the exact native text', () => {
  const fragments = ['', 'a', '\r', '\n', '\r\n', '😀'];
  for (const a of fragments) for (const b of fragments) for (const c of fragments) {
    const original = a + b + c, native = f.textareaValue(original);
    for (let start = 0; start <= native.length; start++) for (let end = start; end <= native.length; end++) for (const addition of ['', 'X', '\n', '\n\n', '😀']) {
      const next = native.slice(0, start) + addition + native.slice(end);
      assert.equal(f.textareaValue(f.applyTextareaEdit(original, next)), next, JSON.stringify({ original, next, start, end }));
    }
  }
});
test('emoji UTF16 edits round-trip through native normalization', () => {
  assert.equal(f.applyTextareaEdit('甲\r\n😀乙', '甲\n😁乙'), '甲\r\n😁乙');
});
test('exact mapped polish is accepted by the real domain core', () => {
  const selection = f.sourceOffsets(book.chapters[0].body, 2, 5);
  const ctx = buildContext(book, id, { mode: 'polish', selection });
  const p = makeProposal(book, id, { mode: 'polish', selection }, '润色', ctx);
  const ready = mutateBook(book, { action: 'addProposal', proposal: p });
  const accepted = mutateBook(ready, { action: 'acceptProposal', proposalId: p.id });
  assert.equal(accepted.chapters[0].body, '甲\r\n润色\r\n末');
});
test('confirmation snapshot rejects a newer book revision', () => {
  const w = f.workspace(completed, id), snap = f.reviewSnapshot(w, { proposalId: proposal.id });
  assert(f.reviewIsCurrent(w, snap));
  assert(!f.reviewIsCurrent(f.workspace(saved, id), snap));
});
test('confirmation snapshot also locks exact proposal text', () => {
  const w = f.workspace(completed, id), snap = f.reviewSnapshot(w, { proposalId: proposal.id });
  const tampered = structuredClone(w);
  tampered.book.proposals[0].text = 'unreviewed replacement';
  assert(!f.reviewIsCurrent(tampered, snap));
});
test('native normalization round-trip across many replacements', () => {
  const bodies = ['', 'a', 'a\r\nb\r\nc', '甲\r\n😀乙\n丙', 'a\rb\rc', 'a\n\r\nb'];
  for (const body of bodies) {
    const value = f.textareaValue(body);
    for (let a = 0; a <= value.length; a++) for (let b = a; b <= value.length; b++) {
      const next = value.slice(0, a) + '新\n字' + value.slice(b);
      assert.equal(f.textareaValue(f.applyTextareaEdit(body, next)), next);
    }
  }
});

test('book-management confirmation binds identity, revision and exact saved title, not the draft title', () => {
  const snap = f.managementSnapshot(base);
  assert.deepEqual(snap, { bookId: book.id, revision: book.revision, title: book.title });
  assert(f.managementIsCurrent(base, snap));
  for (const patch of [{ id: 'other' }, { revision: book.revision + 1 }, { title: book.title + ' ' }]) {
    assert(!f.managementIsCurrent({ ...base, book: { ...book, ...patch } }, snap), JSON.stringify(patch));
  }
  assert(!f.managementIsCurrent(null, snap));
  assert(!f.managementIsCurrent(base, null));
  const editedTitle = { ...base, settings: { ...base.settings, title: 'unsaved title' } };
  assert.equal(f.managementSnapshot(editedTitle).title, book.title);
  assert.equal(f.managementProblem(editedTitle, snap), 'manageUnsaved');
});
test('deletion requires literal typed title: no trimming, case folding, prefixes or Unicode normalization', () => {
  const w = f.workspace({ ...book, title: 'Book Café 😀' }), snap = f.managementSnapshot(w);
  assert.equal(f.deletionProblem(w, snap, snap.title), '');
  for (const typed of ['', 'Book', 'book Café 😀', ' Book Café 😀', 'Book Café 😀 ', 'Book Cafe\u0301 😀', null, 42]) {
    assert.equal(f.deletionProblem(w, snap, typed), 'deleteTypeTitle', String(typed));
  }
  for (const patch of [{ id: 'other' }, { revision: book.revision + 1 }, { title: 'New title' }]) {
    assert.equal(f.deletionProblem({ ...w, book: { ...w.book, ...patch } }, snap, snap.title), 'confirmChanged');
  }
});
test('every dirty field group and unresolved recovery/conflict blocks management and deletion', () => {
  const w = f.workspace(completed, id), snap = f.managementSnapshot(w);
  const variants = [
    { ...w, chapter: { ...w.chapter, body: 'unsaved manuscript' } },
    { ...w, settings: { ...w.settings, premise: 'unsaved premise' } },
    { ...w, card: { title: 'unsaved canon' }, baseCard: null },
    { ...w, candidate: w.candidate + ' unsaved candidate' },
  ];
  for (const draft of variants) {
    assert.equal(f.managementProblem(draft, snap), 'manageUnsaved');
    assert.equal(f.deletionProblem(draft, snap, snap.title), 'manageUnsaved');
  }
  assert.equal(f.deletionProblem(w, snap, snap.title, { recovery: { bookId: snap.bookId } }), 'manageRecovery');
  assert.equal(f.deletionProblem(w, snap, snap.title, { conflict: { fields: ['settings'] } }), 'manageUnsaved');
  assert.equal(f.deletionProblem(w, snap, snap.title, { recovery: { bookId: 'other' } }), '');
});
test('running and unsettled target jobs block deletion but unrelated and settled jobs do not', () => {
  const snap = f.managementSnapshot(base);
  for (const job of [{ status: 'running' }, { status: 'cancelled', settled: false }, { status: 'completed', settled: false }]) {
    assert.equal(f.deletionProblem(base, snap, snap.title, { jobs: [{ bookId: book.id, ...job }] }), 'deleteBusy');
  }
  assert.equal(f.deletionProblem(base, snap, snap.title, { jobs: [null, { bookId: 'other', status: 'running' }, { bookId: book.id, status: 'completed', settled: true }] }), '');
});
function deletionFixture(active = base) {
  const other = createBook(book.title); // Duplicate titles must never determine cleanup scope.
  return { other, state: { workspace: active, books: [book, other], selection: { start: 1, end: 3 }, context: { prompt: 'reviewed context' },
    job: { bookId: book.id, status: 'completed' }, recovery: f.recoveryPayload(edited), pendingLatest: book,
    activeJobs: [{ bookId: book.id, id: 'target-job' }, { bookId: other.id, id: 'other-job' }],
    drafts: new Map([[book.id, f.recoveryPayload(edited)], [other.id, { bookId: other.id, body: 'other draft' }]]),
    rememberedJobs: new Map([[book.id, { id: 'target-job' }], [other.id, { id: 'other-job' }]]) } };
}
test('failed, mismatched and malformed deletion receipts preserve every state reference and cache', () => {
  const { state } = deletionFixture(), snap = f.managementSnapshot(base), frozen = structuredClone(state);
  for (const result of [null, {}, { deleted: false, bookId: book.id, cleanupPending: false }, { deleted: true, bookId: 'other', cleanupPending: false }, { deleted: true, bookId: book.id }, { deleted: true, bookId: book.id, cleanupPending: 0 }]) {
    assert(!f.deletionReceipt(snap, result));
    assert.strictEqual(f.afterBookDeletion(state, snap, result), state);
    assert.deepEqual(state, frozen);
  }
  assert(!f.deletionReceipt({}, { deleted: true, cleanupPending: false }));
});
test('confirmed deletion clears only the target, including when physical cleanup is pending', () => {
  for (const cleanupPending of [false, true]) {
    const { state, other } = deletionFixture(), before = structuredClone(state), snap = f.managementSnapshot(base);
    const result = { deleted: true, bookId: book.id, cleanupPending };
    assert(f.deletionReceipt(snap, result));
    const next = f.afterBookDeletion(state, snap, result);
    for (const key of ['workspace', 'selection', 'context', 'job', 'recovery', 'pendingLatest']) assert.equal(next[key], null, key);
    assert.deepEqual(next.books.map(b => b.id), [other.id]);
    assert.deepEqual(next.activeJobs.map(j => j.bookId), [other.id]);
    assert(!next.drafts.has(book.id)); assert(!next.rememberedJobs.has(book.id));
    assert.strictEqual(next.drafts.get(other.id), state.drafts.get(other.id));
    assert.strictEqual(next.rememberedJobs.get(other.id), state.rememberedJobs.get(other.id));
    assert.deepEqual(state, before, 'Planning deletion must not mutate the pre-acknowledgement state');
  }
});
test('deleting a target cannot clear another currently selected book or its editing state', () => {
  const { state, other } = deletionFixture();
  Object.assign(state, { workspace: f.workspace(other), job: { bookId: other.id }, recovery: { bookId: other.id }, pendingLatest: other });
  const next = f.afterBookDeletion(state, f.managementSnapshot(base), { deleted: true, bookId: book.id, cleanupPending: false });
  for (const key of ['workspace', 'selection', 'context', 'job', 'recovery', 'pendingLatest']) assert.strictEqual(next[key], state[key], key);
});

test('post-delete refresh distinguishes failed list/get from successful empty or selected libraries', async () => {
  let opens = 0;
  const list = async () => ({ books: [{ id: 'survivor' }] });
  const open = async id => { assert.equal(id, 'survivor'); opens++; return true; };
  assert.equal(await f.refreshAfterBookDeletion(list, () => false, open), true);
  assert.equal(opens, 1);
  assert.equal(await f.refreshAfterBookDeletion(list, () => false, async () => false), false, 'get failure must remain a post-delete warning');
  assert.equal(await f.refreshAfterBookDeletion(list, () => false, async () => { throw new Error('get unavailable'); }), false);
  assert.equal(await f.refreshAfterBookDeletion(async () => { throw new Error('list unavailable'); }, () => false, open), false);
  assert.equal(await f.refreshAfterBookDeletion(async () => null, () => false, open), false);
  assert.equal(await f.refreshAfterBookDeletion(async () => ({ books: [] }), () => false, open), true);
  assert.equal(await f.refreshAfterBookDeletion(list, () => true, open), true);
  assert.equal(opens, 1, 'failed list, empty library and existing selection must not reopen a book');
  const before = 'return await openBook(data.books[0].id) === true;';
  assert.equal(helperSource.split(before).length, 2);
  const unsafe = helpersFrom(helperSource.replace(before, 'await openBook(data.books[0].id); return true;'));
  await assert.rejects(async () => assert.equal(await unsafe.refreshAfterBookDeletion(list, () => false, async () => false), false), assert.AssertionError);
});
test('external absence blocks stale adoption without discarding local workspace, recovery or caches', () => {
  const { state, other } = deletionFixture();
  state.unavailable = new Map();
  const marked = f.markBookUnavailable(state, book.id, 8);
  assert.equal(marked.pendingLatest, null);
  assert(!f.bookIsAvailable(book.id, new Set(), marked.unavailable));
  assert(f.bookIsAvailable(other.id, new Set(), marked.unavailable));
  for (const key of ['workspace', 'selection', 'context', 'job', 'recovery', 'drafts', 'rememberedJobs']) assert.strictEqual(marked[key], state[key], key);
  assert.equal(state.unavailable.size, 0, 'The prior state remains unchanged');
  assert.strictEqual(f.markBookUnavailable({ ...state, pendingLatest: other }, book.id, 8).pendingLatest, other);
  for (const seq of [7, 8]) {
    const fromOldList = f.reconcileBookAvailability(marked.unavailable, [book, other], seq);
    assert(!f.bookIsAvailable(book.id, new Set(), fromOldList), 'Old list cannot revive an externally missing book');
  }
  assert(!f.bookIsAvailable(book.id, new Set(), f.reconcileBookAvailability(marked.unavailable, [other], 9)));
  const freshPresence = f.reconcileBookAvailability(marked.unavailable, [book, other], 9);
  assert(f.bookIsAvailable(book.id, new Set(), freshPresence));
  assert(!f.bookIsAvailable(book.id, new Set([book.id]), freshPresence), 'Even a fresh list cannot revive an acknowledged deletion');
  for (const [before, after, verify] of [
    ['!deleted.has(bookId) && !unavailable.has(bookId)', '!deleted.has(bookId)', m => assert(!m.bookIsAvailable(book.id, new Set(), marked.unavailable))],
    ['sequence <= observed || !present.has(id)', '!present.has(id)', m => assert(!m.bookIsAvailable(book.id, new Set(), m.reconcileBookAvailability(marked.unavailable, [book], 7)))],
  ]) {
    assert.equal(helperSource.split(before).length, 2); verify(f);
    assert.throws(() => verify(helpersFrom(helperSource.replace(before, after))), assert.AssertionError);
  }
});

test('negative guard and cleanup assertions reject deliberately unsafe helper mutations', () => {
  const snap = f.managementSnapshot(base), receipt = { deleted: true, bookId: book.id, cleanupPending: false };
  const cases = [
    ['return !!w && !!snapshot && w.book.id === snapshot.bookId && w.book.revision', 'return !!w && !!snapshot && true && w.book.revision', m => assert(!m.managementIsCurrent({ ...base, book: { ...book, id: 'other' } }, snap))],
    ['w.book.revision === snapshot.revision && w.book.title', 'true && w.book.title', m => assert(!m.managementIsCurrent({ ...base, book: { ...book, revision: book.revision + 1 } }, snap))],
    ['w.book.title === snapshot.title;', 'true;', m => assert(!m.managementIsCurrent({ ...base, book: { ...book, title: 'changed' } }, snap))],
    ["typedTitle !== snapshot.title", "typedTitle.trim() !== snapshot.title", m => assert.equal(m.deletionProblem(base, snap, snap.title + ' '), 'deleteTypeTitle')],
    ["if (isDirty(w) || conflict)", "if (conflict)", m => assert.equal(m.deletionProblem(edited, snap, snap.title), 'manageUnsaved')],
    ["if (isDirty(w) || conflict)", "if (isDirty(w))", m => assert.equal(m.deletionProblem(base, snap, snap.title, { conflict: {} }), 'manageUnsaved')],
    ["if (recovery?.bookId === snapshot.bookId)", "if (false)", m => assert.equal(m.deletionProblem(base, snap, snap.title, { recovery: { bookId: book.id } }), 'manageRecovery')],
    ["(j.status === 'running' || j.settled === false)", "(j.settled === false)", m => assert.equal(m.deletionProblem(base, snap, snap.title, { jobs: [{ bookId: book.id, status: 'running' }] }), 'deleteBusy')],
    ["(j.status === 'running' || j.settled === false)", "(j.status === 'running')", m => assert.equal(m.deletionProblem(base, snap, snap.title, { jobs: [{ bookId: book.id, status: 'cancelled', settled: false }] }), 'deleteBusy')],
    ["result?.deleted === true", "result?.deleted !== undefined", m => assert(!m.deletionReceipt(snap, { ...receipt, deleted: false }))],
    ["result.bookId === snapshot.bookId &&", "true &&", m => assert(!m.deletionReceipt(snap, { ...receipt, bookId: 'other' }))],
    ["typeof result.cleanupPending === 'boolean'", "true", m => assert(!m.deletionReceipt(snap, { deleted: true, bookId: book.id }))],
    ["workspace: active ? null : state.workspace", "workspace: state.workspace", m => assert.equal(m.afterBookDeletion(deletionFixture().state, snap, receipt).workspace, null)],
    ["active = state.workspace?.book.id === id", "active = true", m => { const { state, other } = deletionFixture(); state.workspace = f.workspace(other); assert.strictEqual(m.afterBookDeletion(state, snap, receipt).workspace, state.workspace); }],
    ["drafts: new Map([...state.drafts].filter(([bookId]) => bookId !== id))", "drafts: state.drafts", m => assert(!m.afterBookDeletion(deletionFixture().state, snap, receipt).drafts.has(book.id))],
    ["drafts: new Map([...state.drafts].filter(([bookId]) => bookId !== id))", "drafts: new Map()", m => { const { state, other } = deletionFixture(); assert.strictEqual(m.afterBookDeletion(state, snap, receipt).drafts.get(other.id), state.drafts.get(other.id)); }],
    ["rememberedJobs: new Map([...state.rememberedJobs].filter(([bookId]) => bookId !== id))", "rememberedJobs: state.rememberedJobs", m => assert(!m.afterBookDeletion(deletionFixture().state, snap, receipt).rememberedJobs.has(book.id))],
    ["pendingLatest: state.pendingLatest?.id === id ? null : state.pendingLatest", "pendingLatest: state.pendingLatest", m => assert.equal(m.afterBookDeletion(deletionFixture().state, snap, receipt).pendingLatest, null)],
  ];
  for (const [before, after, verify] of cases) {
    assert.equal(helperSource.split(before).length, 2, 'Mutation must target exactly one helper branch: ' + before);
    verify(f);
    const mutant = helpersFrom(helperSource.replace(before, after));
    assert.throws(() => verify(mutant), assert.AssertionError, 'Unsafe mutation escaped: ' + before);
  }
});

const enStart = source.indexOf('    const en ='), cssStart = source.indexOf('    const CSS =');
const dicts = new Function(source.slice(enStart, cssStart) + ';return {en,zh};')();
test('sidebar name stays 灵感 or Inspiration without a repeated page heading', async () => {
  for (const [lang, title] of [['zh', '灵感'], ['en', 'Inspiration']]) {
    const meta = JSON.parse(await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'));
    assert.equal(dicts[lang].nav, title);
    assert(!Object.hasOwn(dicts[lang], 'title'));
    assert(!Object.hasOwn(dicts[lang], 'subtitle'));
    assert.equal(meta.meta.title, title);
  }
});
test('zh/en dictionaries expose identical complete keys', () => {
  assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(dicts.zh).sort());
});
test('all literal translation lookups exist', () => {
  for (const match of source.matchAll(/\bt\('([^']+)'/g)) assert(match[1] in dicts.en, match[1]);
});
test('only React is imported and no renderer or raw HTML is created', () => {
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]), ['react']);
  assert(!/createRoot|dangerouslySetInnerHTML|<iframe/.test(source));
});
test('completion status cannot clean up the pending book refresh', () => {
  assert(source.includes('}, [job?.id, w?.book.id, pollVersion]);'));
});
