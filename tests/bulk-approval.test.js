import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../core.js';
import { applyHunks } from '../revision.js';
import { NovelStore, NovelService } from '../service.js';
const options = { mode: 'revise', instruction: '润色三处而不改中间文字' };
function fixture(api = core) {
  let book = api.mutateBook(api.createBook('批量批准隔离测试'), { action: 'addChapter' });
  const chapterId = book.chapters[0].id;
  book = api.mutateBook(book, { action: 'updateChapter', chapterId, patch: { body: '甲一。\r\n中段😀不变。\r\n乙二。\r\n中段不变。\r\n丙三。' } });
  book = api.mutateBook(book, { action: 'updateChapter', chapterId, patch: { summary: '原摘要' } });
  const p = api.makeProposal(book, chapterId, options, '甲A。\r\n中段😀不变。\r\n乙B。\r\n中段不变。\r\n丙C。', api.buildContext(book, chapterId, options), { analysis: '改三处。' });
  assert.equal(p.review.hunks.length, 3);
  book = api.mutateBook(book, { action: 'addProposal', proposal: p });
  return { book, p, chapterId, operation: { action: 'acceptRevisionAll', proposalId: p.id } };
}
function guards(api) {
  const { book, operation } = fixture(api);
  const badBody = structuredClone(book); badBody.chapters[0].body += '作者手改';
  assert.throws(() => api.mutateBook(badBody, operation), { code: 'STALE_PROPOSAL' });
  const badRevision = structuredClone(book); badRevision.chapters[0].revision++;
  assert.throws(() => api.mutateBook(badRevision, operation), { code: 'STALE_PROPOSAL' });
  const next = api.mutateBook(book, operation);
  assert.equal(next.chapters[0].body, next.proposals[0].text);
  assert.equal(next.chapters[0].history.at(-1).body, book.chapters[0].body);
  assert.equal(next.chapters[0].summaryRevision, null);
  assert.equal(next.chapters[0].revision, next.proposals[0].sourceRevision + 3);
}
test('approve all pending is one book mutation/history snapshot with exact target and accepted-count revision', () => {
  guards(core);
  const { book, p, operation } = fixture(); const before = structuredClone(book);
  const next = core.mutateBook(book, operation);
  assert.equal(next.revision, book.revision + 1); assert.equal(next.chapters[0].history.length, book.chapters[0].history.length + 1);
  assert(next.proposals[0].review.hunks.every(h => h.state === 'accepted')); assert.equal(next.proposals[0].state, 'accepted');
  assert.equal(next.proposals[0].sourceBody, p.sourceBody); assert.equal(next.proposals[0].text, p.text); assert.deepEqual(book, before);
  assert.throws(() => core.mutateBook(next, operation), { code: 'INVALID_STATE' });
});
test('all 19 mixed partial states preserve rejected edits, accepted text and immutable snapshots', () => {
  for (let mask = 0; mask < 27; mask++) {
    let { book, p, operation } = fixture(); let n = mask;
    for (const h of p.review.hunks) { const state = n % 3; n = Math.floor(n / 3); if (state) book = core.mutateBook(book, { action: state === 1 ? 'acceptRevisionHunk' : 'rejectRevisionHunk', proposalId: p.id, hunkId: h.id }); }
    const before = structuredClone(book), pending = book.proposals[0].review.hunks.filter(h => h.state === 'pending').length;
    if (!pending) { assert.throws(() => core.mutateBook(book, operation), { code: 'INVALID_STATE' }); continue; }
    const next = core.mutateBook(book, operation), proposal = next.proposals[0];
    assert.equal(next.chapters[0].body, applyHunks(p.sourceBody, before.proposals[0].review.hunks, ['pending', 'accepted']));
    assert.equal(next.chapters[0].revision, book.chapters[0].revision + pending);
    assert.equal(next.chapters[0].history.length, book.chapters[0].history.length + 1);
    assert.deepEqual(proposal.review.hunks.map(h => h.state), before.proposals[0].review.hunks.map(h => h.state === 'pending' ? 'accepted' : h.state));
    assert.equal(proposal.text, p.text); assert.equal(proposal.sourceBody, p.sourceBody); assert.deepEqual(book, before);
  }
});
test('empty/no-pending/wrong-mode/overflow approvals fail atomically', () => {
  const { book, p, chapterId, operation } = fixture();
  const empty = structuredClone(book); empty.proposals[0].text = p.sourceBody; empty.proposals[0].review.hunks = [];
  assert.throws(() => core.mutateBook(empty, operation), { code: 'INVALID_STATE' });
  const full = structuredClone(book); full.chapters[0].revision = Number.MAX_SAFE_INTEGER - 1; full.proposals[0].sourceRevision = Number.MAX_SAFE_INTEGER - 1;
  const original = structuredClone(full); assert.throws(() => core.mutateBook(full, operation), { code: 'VALIDATION' }); assert.deepEqual(full, original);
  const ordinary = core.makeProposal(book, chapterId, { mode: 'draft' }, '新正文', core.buildContext(book, chapterId, { mode: 'draft' }));
  const next = core.mutateBook(book, { action: 'addProposal', proposal: ordinary });
  assert.throws(() => core.mutateBook(next, { action: 'acceptRevisionAll', proposalId: ordinary.id }), { code: 'INVALID_STATE' });
});
function backendDouble() {
  const units = new Map(), writes = []; let fail = false;
  return { writes, setFailure(value) { fail = value; }, kv: { async open(spec) {
    if (!units.has(spec.name)) units.set(spec.name, { tables: Object.fromEntries(spec.tables.map(t => [t, {}])), global: null }); const data = units.get(spec.name);
    return { async loadAll() { return structuredClone(data); }, async close() {}, async putRecord(table, key, value) { if (fail) throw new Error('isolated disk failure'); writes.push([spec.name, table, key]); data.tables[table][key] = structuredClone(value); }, async deleteRecord(table, key) { delete data.tables[table][key]; } };
  } } };
}
test('shared dispatch rejects agent bulk approval and persists author approval exactly once; failed I/O preserves source', async () => {
  const backend = backendDouble(), store = await new NovelStore(backend).init(), service = new NovelService(store, { getModel: () => null, async runModel() { throw new Error('No model call'); } });
  try {
    const { book, operation } = fixture(); await store.insert(book);
    const input = { action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation, user: true };
    const count = backend.writes.length;
    await assert.rejects(service.dispatch(input), { code: 'AUTHOR_ONLY' }); assert.equal(backend.writes.length, count);
    backend.setFailure(true); await assert.rejects(service.dispatch(input, { user: true }), /isolated disk failure/);
    assert.deepEqual(await store.load(book.id), book); backend.setFailure(false);
    const next = await service.dispatch(input, { user: true }); assert.equal(backend.writes.length, count + 1);
    assert.equal(next.chapters[0].body, next.proposals[0].text);
    await assert.rejects(service.dispatch(input, { user: true }), { code: 'CONFLICT' });
    assert.deepEqual(await store.load(book.id), next);
  } finally { await service.close(); }
});
const originalSource = await readFile(new URL('../core.js', import.meta.url), 'utf8');
for (const [label, before, after] of [
  ['exact source', ' || chapter.body !== applyHunks(proposal.sourceBody, proposal.review.hunks)', ''],
  ['source revision', 'chapter.revision !== proposal.sourceRevision + accepted || ', ''],
  ['summary invalidation', 'chapter.summaryRevision = null;', 'chapter.summaryRevision = 2;'],
  ['accepted decision count', 'chapter.revision + pending.length', 'chapter.revision + 1'],
]) test('bulk oracle detects removed ' + label, async () => {
  const start = originalSource.indexOf("    case 'acceptRevisionAll':"), end = originalSource.indexOf("    case 'restoreChapter':", start);
  const block = originalSource.slice(start, end); assert(block.includes(before));
  let source = originalSource.slice(0, start) + block.replace(before, after) + originalSource.slice(end);
  source = source.replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, new URL('../core.js', import.meta.url)).href}'`);
  const api = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.throws(() => guards(api));
});
