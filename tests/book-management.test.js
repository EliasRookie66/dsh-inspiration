import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { NovelStore, NovelService } from '../service.js';
import { makeHandler } from '../http.js';

// Atomic-per-call KV double. Real JSON storage + actual registered tool are
// exercised independently in runtime-contract.mjs, not simulated here.
function backend() {
  const files = new Map(); let fault = () => {};
  return { files, setFault(fn = () => {}) { fault = fn; }, kv: { async open(spec) {
    if (!files.has(spec.name)) files.set(spec.name, { tables: Object.fromEntries(spec.tables.map(t => [t, {}])), global: null });
    const data = files.get(spec.name);
    return {
      async loadAll() { return structuredClone(data); },
      async putRecord(table, id, value) { fault('put', spec.name, table, id); data.tables[table][id] = structuredClone(value); },
      async deleteRecord(table, id) { fault('delete', spec.name, table, id); delete data.tables[table][id]; },
      async close() {},
    };
  } } };
}
const model = () => ({ provider: 'test', model: 'no-network' });
const makeService = (store, Service = NovelService) => new Service(store, { getModel: model, runModel: async () => ({ text: '候选内容' }) });
const mutation = (book, operation) => ({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation });
const deletion = book => ({ action: 'delete', bookId: book.id, expectedRevision: book.revision, confirmTitle: book.title });
async function fixture(Store = NovelStore, Service = NovelService) {
  const disk = backend(), store = await new Store(disk).init(), service = makeService(store, Service);
  let target = await service.dispatch({ action: 'create', title: '验收 demo 😀' });
  target = await service.dispatch(mutation(target, { action: 'addChapter', title: '第一章' }));
  target = await service.dispatch(mutation(target, { action: 'updateChapter', chapterId: target.chapters[0].id, patch: { body: '只删除这一本\r\n原稿' } }));
  const other = await service.dispatch({ action: 'create', title: target.title }); // Same title is not identity.
  return { disk, store, service, target, other };
}

test('rename retains exact manuscript, ids and histories and rejects stale edits', async () => {
  const { service, target, other } = await fixture();
  try {
    const renamed = await service.dispatch(mutation(target, { action: 'updateBook', patch: { title: '新书名' } }));
    assert.equal(renamed.id, target.id); assert.equal(renamed.title, '新书名');
    assert.deepEqual(renamed.chapters, target.chapters); assert.deepEqual(renamed.proposals, target.proposals);
    await assert.rejects(service.dispatch(deletion(target)), { code: 'CONFLICT' });
    assert.deepEqual(await service.dispatch({ action: 'get', bookId: other.id }), other);
  } finally { await service.close(); }
});

test('delete requires exact revision/title, with zero persisted changes on rejected requests', async () => {
  const { disk, service, target } = await fixture();
  try {
    const before = structuredClone([...disk.files]);
    for (const [patch, code] of [[{ confirmTitle: undefined }, 'VALIDATION'], [{ confirmTitle: target.title + ' ' }, 'VALIDATION'], [{ confirmTitle: '' }, 'VALIDATION'], [{ expectedRevision: 0 }, 'CONFLICT'], [{ expectedRevision: String(target.revision) }, 'CONFLICT'], [{ bookId: '../outside' }, 'VALIDATION']]) {
      await assert.rejects(service.dispatch({ ...deletion(target), ...patch }), { code });
      assert.deepEqual([...disk.files], before);
    }
  } finally { await service.close(); }
});

test('UI and agent delete share durable whole-book semantics without touching equal-title siblings', async () => {
  for (const user of [true, false]) {
    const { disk, store, service, target, other } = await fixture();
    await store.serial(() => store.saveJob({ id: 'target-job', bookId: target.id, status: 'completed', request: { sourceBody: 'private target' } }));
    await store.serial(() => store.saveJob({ id: 'other-job', bookId: other.id, status: 'completed', request: { sourceBody: 'private sibling' } }));
    const backup = await service.dispatch({ action: 'export', bookId: target.id, format: 'json' });
    const result = await service.dispatch(deletion(target), { user });
    assert.deepEqual(result, { deleted: true, bookId: target.id, cleanupPending: false });
    assert.deepEqual((await service.dispatch({ action: 'list' })).books.map(b => b.id), [other.id]);
    await assert.rejects(service.dispatch({ action: 'get', bookId: target.id }), { code: 'NOT_FOUND' });
    await assert.rejects(service.dispatch({ action: 'export', bookId: target.id, format: 'json' }), { code: 'NOT_FOUND' });
    await assert.rejects(service.dispatch({ action: 'job', jobId: 'target-job' }), { code: 'NOT_FOUND' });
    assert.equal((await service.dispatch({ action: 'job', jobId: 'other-job' })).bookId, other.id);
    assert.deepEqual(await service.dispatch({ action: 'get', bookId: other.id }), other);
    const unit = disk.files.get(`ycx_moxu_book_${target.id.replaceAll('-', '_')}`);
    assert.deepEqual(unit.tables.books, {}, 'deleted manuscript/canon/proposals/history cannot remain in KV');
    assert(!JSON.stringify([...disk.files]).includes('private target'), 'delete plugin job source provenance too');
    await service.close();
    const reopened = makeService(await new NovelStore(disk).init());
    assert.deepEqual((await reopened.dispatch({ action: 'list' })).books.map(b => b.id), [other.id]);
    const recovered = await reopened.dispatch({ action: 'import', text: backup.text });
    assert.notEqual(recovered.id, target.id); assert.equal(recovered.chapters[0].body, target.chapters[0].body);
    await reopened.close();
  }
});

test('failure before durable deletion intent leaves the entire book and jobs untouched', async () => {
  const { disk, service, target } = await fixture();
  try {
    const before = structuredClone([...disk.files]);
    disk.setFault((op) => { if (op === 'put') throw new Error('intent write failed'); });
    await assert.rejects(service.dispatch(deletion(target)), /intent write failed/);
    assert.deepEqual([...disk.files], before);
    assert.deepEqual(await service.dispatch({ action: 'get', bookId: target.id }), target);
  } finally { disk.setFault(); await service.close(); }
});

for (const stage of ['book', 'job', 'index']) test(`interrupted ${stage} cleanup stays hidden and completes after storage reopen`, async () => {
  const { disk, store, service, target, other } = await fixture();
  await store.serial(() => store.saveJob({ id: 'target-job', bookId: target.id, status: 'completed', request: { sourceBody: 'private target' } }));
  disk.setFault((op, unit, table) => {
    if (op === 'delete' && ((stage === 'book' && unit !== 'ycx_moxu_index') || (stage === 'job' && table === 'jobs') || (stage === 'index' && unit === 'ycx_moxu_index' && table === 'books'))) throw new Error('disk cleanup failed');
  });
  assert.deepEqual(await service.dispatch(deletion(target)), { deleted: true, bookId: target.id, cleanupPending: true });
  assert.equal((await service.dispatch({ action: 'list' })).cleanupPending, 1);
  await assert.rejects(service.dispatch({ action: 'get', bookId: target.id }), { code: 'NOT_FOUND' });
  await assert.rejects(service.dispatch({ action: 'job', jobId: 'target-job' }), { code: 'NOT_FOUND' });
  await assert.rejects(store.serial(() => store.saveJob({ id: 'late-job', bookId: target.id, status: 'failed' })), { code: 'NOT_FOUND' });
  await service.close();
  // Repeat restart while failure persists: no resurrection and other books stay usable.
  const partial = makeService(await new NovelStore(disk).init());
  assert.equal((await partial.dispatch({ action: 'list' })).cleanupPending, 1);
  assert.deepEqual(await partial.dispatch({ action: 'get', bookId: other.id }), other);
  await partial.close(); disk.setFault();
  const reopened = makeService(await new NovelStore(disk).init());
  assert.equal((await reopened.dispatch({ action: 'list' })).cleanupPending, 0);
  assert.deepEqual((await reopened.dispatch({ action: 'list' })).books.map(b => b.id), [other.id]);
  assert.deepEqual(disk.files.get(`ycx_moxu_book_${target.id.replaceAll('-', '_')}`).tables.books, {});
  assert(!JSON.stringify([...disk.files]).includes('private target'));
  await reopened.close();
});

test('active and terminal-but-unsettled model jobs block deletion, then completed jobs are removed', async () => {
  const { service, target } = await fixture();
  let release;
  service.runModel = async () => new Promise(resolve => { release = resolve; });
  try {
    const { jobId } = await service.dispatch({ action: 'generate', bookId: target.id, chapterId: target.chapters[0].id, expectedRevision: target.revision, mode: 'draft' });
    await assert.rejects(service.dispatch(deletion(target)), { code: 'BUSY' });
    // Model error can set terminal status before its queued persistence settles.
    service.live.get(jobId).status = 'failed';
    await assert.rejects(service.dispatch(deletion(target)), { code: 'BUSY' });
    release({ text: '完成候选' }); await service.live.get(jobId).promise;
    const current = await service.dispatch({ action: 'get', bookId: target.id });
    await assert.rejects(service.dispatch(deletion(target)), { code: 'CONFLICT' });
    await service.dispatch(deletion(current));
    assert.equal(service.live.has(jobId), false);
    await assert.rejects(service.dispatch({ action: 'job', jobId }), { code: 'NOT_FOUND' });
  } finally { release?.({ text: '完成候选' }); await service.close(); }
});

test('HTTP delete authenticates first, rejects wrong title/stale revision, and persists success', async () => {
  const { service, target, other } = await fixture(); let origin;
  const browserPeer = { id: 'browser' };
  const connection = { browserPeer, admit: req => req.headers.cookie === 'test-browser' ? { peer: browserPeer } : { rejection: 401 } };
  const server = createServer(makeHandler(service, () => origin, connection));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const send = (input, cookie = 'test-browser') => fetch(origin, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-inspiration-Request': '1' }, body: JSON.stringify(input) });
  try {
    for (const [payload, cookie, status, code] of [[deletion(target), 'fake', 401, 'UNAUTHORIZED'], [{ ...deletion(target), confirmTitle: 'wrong' }, 'test-browser', 400, 'VALIDATION'], [{ ...deletion(target), expectedRevision: 0 }, 'test-browser', 409, 'CONFLICT']]) {
      const response = await send(payload, cookie); assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
      assert.deepEqual(await service.dispatch({ action: 'get', bookId: target.id }), target);
    }
    const response = await send(deletion(target)); assert.equal(response.status, 200); assert.equal((await response.json()).data.deleted, true);
    assert.deepEqual(await service.dispatch({ action: 'get', bookId: other.id }), other);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close(); }
});

const serviceSource = await readFile(new URL('../service.js', import.meta.url), 'utf8');
const mutants = [
  ['title guard', "if (input.confirmTitle !== book.title)", 'if (false)', async ({ service, target }) => {
    await assert.rejects(service.dispatch({ ...deletion(target), confirmTitle: 'wrong' }), { code: 'VALIDATION' });
  }],
  ['revision guard', "case 'delete': {\n          const book = await this.store.load(input.bookId);\n          this.requireRevision(book, input.expectedRevision);", "case 'delete': {\n          const book = await this.store.load(input.bookId);", async ({ service, target }) => {
    await assert.rejects(service.dispatch({ ...deletion(target), expectedRevision: 0 }), { code: 'CONFLICT' });
  }],
  ['durable intent', "await this.index.putRecord('books', book.id, { id: book.id, deleted: true });", '/* broken: no durable intent */', async ({ disk, service, target }) => {
    disk.setFault(op => { if (op === 'delete') throw new Error('cleanup fault'); });
    await service.dispatch(deletion(target));
    assert.equal(disk.files.get('ycx_moxu_index').tables.books[target.id]?.deleted, true);
  }],
  ['job provenance cleanup', 'for (const [jobId, job] of this.jobs) if (job.bookId === id)', 'for (const [jobId, job] of this.jobs) if (false)', async ({ disk, store, service, target }) => {
    await store.saveJob({ id: 'private-job', bookId: target.id, status: 'completed', request: { sourceBody: 'PRIVATE_DELETE_ORACLE' } });
    await service.dispatch(deletion(target));
    assert.equal(JSON.stringify([...disk.files]).includes('PRIVATE_DELETE_ORACLE'), false);
  }],
];
for (const [name, old, replacement, oracle] of mutants) test(`deletion oracle detects broken ${name} without changing production files`, async () => {
  assert.equal(serviceSource.split(old).length, 2, 'Mutation anchor must match exactly once');
  const text = serviceSource.replace(old, replacement).replace(/from '(\.\/[^']+)'/g, (_match, relative) => `from ${JSON.stringify(new URL('../' + relative.slice(2), import.meta.url).href)}`);
  const variant = await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
  const fixtureState = await fixture(variant.NovelStore, variant.NovelService);
  try { await assert.rejects(oracle(fixtureState), error => error?.code === 'ERR_ASSERTION'); }
  finally { fixtureState.disk.setFault(); await fixtureState.service.close(); }
});
