// Run under the installed DSH Electron-as-Node. Real Session/LLM value contracts;
// model transport and agent factory are explicitly test doubles, not GUI evidence.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
if (!process.env.DSH_INSTALL_DIR) throw new Error('Run inside the DSH runtime environment');
const entries = new Map(['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-json'].map(name => [name, pathToFileURL(require.resolve(name, { paths: [process.env.DSH_INSTALL_DIR] })).href]));
registerHooks({ resolve(specifier, context, next) {
  if (entries.has(specifier)) return { url: entries.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
const { Context } = await import('@deepseek-ai/cordis');
const { SessionStore } = await import('@deepseek-ai/dsh-session');
const { makeModelRunner } = await import('../model.js');
const { defineTool } = await import('@deepseek-ai/dsh-tools');
const model = { provider: 'contract-test', model: 'no-network' };
let count = 0;
async function scenario(reason, { noFlush = false, missingFinish = false, cancel = false } = {}) {
  const owner = new Context();
  const sessions = new SessionStore(owner);
  let observedMessages, disposed = false, flushes = 0, calls = 0, session;
  if (!noFlush) owner.on('session/flush', () => { flushes++; });
  const controller = new AbortController();
  const ctx = { sessions,
    agentLoop: { async createAgent(_ctx, { sessionId }) {
      session = sessions.create(sessionId);
      return { async dispose() { disposed = true; } };
    } },
    llm: { async *stream(options) {
      calls++; assert.ok(flushes > 0, 'input must be flushed before model call');
      observedMessages = options.messages;
      assert.equal(options.tools, undefined);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '书稿😀\r\n原样' };
      if (cancel) controller.abort(new Error('test cancellation'));
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '书稿😀\r\n原样' } };
      if (!missingFinish) yield { type: 'finish', reason };
    } },
  };
  const runner = makeModelRunner(ctx);
  let result, error;
  try { result = await runner({ model, prompt: '精确输入😀\r\n设定', signal: controller.signal, jobId: `contract-${++count}`, maxTokens: 200, onText() {} }); } catch (e) { error = e; }
  assert.equal(disposed, true);
  if (noFlush) { assert.equal(calls, 0); assert.equal(error?.code, 'SESSION'); }
  else {
    assert.equal(observedMessages[0].content[0].text, '精确输入😀\r\n设定');
    assert.ok(flushes >= 2);
    if (reason.kind === 'stop' && !missingFinish && !cancel) {
      assert.ifError(error); assert.equal(result.text, '书稿😀\r\n原样');
      assert.equal(session.deriveMessages().at(-1).role, 'assistant');
    } else { assert.ok(error, 'incomplete model responses must reject'); assert.equal(session.deriveMessages().length, 1); }
  }
  await owner.fiber.dispose();
}
await scenario({ kind: 'stop' });
await scenario({ kind: 'max-tokens' });
await scenario({ kind: 'error', failure: { code: 'TEST', message: 'expected provider error' } });
await scenario({ kind: 'stop' }, { noFlush: true });
await scenario({ kind: 'stop' }, { missingFinish: true });
await scenario({ kind: 'stop' }, { cancel: true });
const tool = defineTool({ name: 'inspiration_contract_test', description: 'Schema contract', parameters: { action: { type: 'string', required: true }, payload: { type: 'object', additionalProperties: true } }, output: { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] }, async execute() { return { ok: true }; } });
assert.equal(tool.name, 'inspiration_contract_test');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const { NovelStore, NovelService } = await import('../service.js');
const { mkdtemp, readFile, writeFile, rm, realpath } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join, dirname, basename } = await import('node:path');
const tempParent = await realpath(tmpdir());
const root = await mkdtemp(join(tempParent, 'inspiration-contract-'));
try {
  const disk = new JsonStorageBackend(root);
  const store = await new NovelStore(disk).init();
  const svc = new NovelService(store, { getModel: () => model, runModel: () => { throw new Error('No network in contract test'); } });
  let book = await svc.dispatch({ action: 'create', title: '真实后端测试' });
  book = await svc.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation: { action: 'addChapter', title: '第一章' } });
  book = await svc.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation: { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: '保留CRLF😀\r\n换行' } } });
  await svc.close(); await disk.close();
  const again = new JsonStorageBackend(root); const reopened = await new NovelStore(again).init();
  assert.deepEqual(await reopened.load(book.id), book);
  await reopened.close(); await again.close();
  const file = join(root, `ycx_moxu_book_${book.id.replaceAll('-', '_')}.json`);
  const before = await readFile(file, 'utf8'); assert.ok(before.includes('真实后端测试'));
  await writeFile(file, '{corrupted', 'utf8');
  const badDisk = new JsonStorageBackend(root); const badStore = await new NovelStore(badDisk).init();
  await assert.rejects(badStore.load(book.id));
  assert.equal(await readFile(file, 'utf8'), '{corrupted', 'corrupt manuscript must not become an empty book');
  await badStore.close(); await badDisk.close();

  // Real plugin apply + Cordis ownership; a narrow route registry double models
  // webServer.register's documented returned disposer (it is NOT auto-owned).
  const { apply } = await import('../index.js');
  const routes = new Map();
  const routeDisk = new JsonStorageBackend(join(root, 'route-lifecycle'));
  try {
    for (let activation = 0; activation < 2; activation++) {
      const owner = new Context();
      try {
        await apply({
          effect: fn => owner.effect(fn),
          storage: { backend: { get: name => { assert.equal(name, 'json'); return routeDisk; } } },
          webServer: { getOrigin: () => 'http://127.0.0.1:59263', register(route) {
            assert.equal(routes.has(route.path), false, 'reactivation must not collide with an old route');
            routes.set(route.path, route);
            return () => { assert.equal(routes.get(route.path), route); routes.delete(route.path); };
          } },
          connection: { admit() { throw new Error('No HTTP in lifecycle test'); } },
          agentDefaultModel: { currentSelection: () => model },
          tools: { register(tool) { assert.equal(tool.name, 'inspiration_novel'); } },
        });
        assert.equal(routes.size, 1);
      } finally { await owner.fiber.dispose(); }
      assert.equal(routes.size, 0, 'disposing the plugin must unregister its HTTP route');
    }
  } finally { await routeDisk.close(); }

  // Independent integration entry: actual defineTool executor/schema, real JSON
  // backend and new Cordis owners. Failure injection wraps only one KV call;
  // successful calls and reopen always use installed storage implementation.
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const helperStart = clientSource.indexOf('    const equal ='), helperEnd = clientSource.indexOf('    const en =');
  assert(helperStart > 0 && helperEnd > helperStart);
  const ui = new Function(clientSource.slice(helperStart, helperEnd) + '\nreturn {workspace,managementSnapshot,deletionProblem,deletionReceipt,afterBookDeletion};')();
  for (const failure of ['none', 'intent', 'book', 'job', 'index']) {
    const directory = join(root, 'management-' + failure);
    let owner, disk, captured, indexHandle, fault = 'none';
    const activate = async () => {
      owner = new Context(); disk = new JsonStorageBackend(directory);
      const wrapped = { kv: { async open(spec) {
        const unit = await disk.kv.open(spec);
        if (spec.name === 'ycx_moxu_index') indexHandle = unit;
        return {
          loadAll: () => unit.loadAll(), close: () => unit.close(),
          async putRecord(table, id, value) {
            if (fault === 'intent' && value?.deleted) throw new Error('injected deletion intent failure');
            return unit.putRecord(table, id, value);
          },
          async deleteRecord(table, id) {
            if ((fault === 'book' && spec.name !== 'ycx_moxu_index') || (fault === 'job' && table === 'jobs') || (fault === 'index' && spec.name === 'ycx_moxu_index' && table === 'books')) throw new Error('injected cleanup failure');
            return unit.deleteRecord(table, id);
          },
        };
      } } };
      await apply({ effect: fn => owner.effect(fn), storage: { backend: { get: () => wrapped } },
        webServer: { getOrigin: () => 'http://127.0.0.1:59263', register: () => () => {} },
        connection: { admit() { throw new Error('No HTTP in tool contract'); } },
        agentDefaultModel: { currentSelection: () => model }, tools: { register: t => { captured = t; } },
      });
    };
    const execute = (action, payload = {}) => captured.execute({ action, payload }, { signal: new AbortController().signal });
    const deactivate = async () => { await owner.fiber.dispose(); await disk.close(); };
    await activate();
    let target, sibling, backup;
    try {
      target = await execute('create', { title: '独立验证 😀 同名' });
      sibling = await execute('create', { title: target.title });
      target = await execute('mutate', { bookId: target.id, expectedRevision: target.revision, operation: { action: 'addChapter', title: 'CRLF' } });
      target = await execute('mutate', { bookId: target.id, expectedRevision: target.revision, operation: { action: 'updateChapter', chapterId: target.chapters[0].id, patch: { body: '完整原稿😀\r\n不重排' } } });
      backup = await execute('export', { bookId: target.id, format: 'json' });
      await indexHandle.putRecord('jobs', 'seed-job', { id: 'seed-job', bookId: target.id, status: 'completed', request: { sourceBody: 'SENSITIVE_DELETION_MARKER' } });
    } finally { await deactivate(); }
    await activate();
    const request = { bookId: target.id, expectedRevision: target.revision, confirmTitle: target.title };
    try {
      const manuscriptPath = join(directory, `ycx_moxu_book_${target.id.replaceAll('-', '_')}.json`);
      const before = await readFile(manuscriptPath, 'utf8');
      await assert.rejects(execute('delete', { ...request, confirmTitle: target.title + ' ' }), { code: 'VALIDATION' });
      await assert.rejects(execute('delete', { ...request, expectedRevision: 0 }), { code: 'CONFLICT' });
      assert.equal(await readFile(manuscriptPath, 'utf8'), before, 'rejected deletes preserve exact disk bytes');
      fault = failure;
      if (failure === 'intent') {
        await assert.rejects(execute('delete', request), /intent failure/);
        assert.equal(await readFile(manuscriptPath, 'utf8'), before);
        fault = 'none';
      }
      const result = await execute('delete', request);
      assert.equal(result.deleted, true);
      assert.equal(result.cleanupPending, !['none', 'intent'].includes(failure));
      // A real production tool receipt, consumed by actual pure client helpers
      // under Electron's Node runtime; this is not React or a DOM simulation.
      const workspace = ui.workspace(target), snapshot = ui.managementSnapshot(workspace);
      assert.equal(ui.deletionProblem(workspace, snapshot, target.title), '');
      assert.equal(ui.deletionProblem(workspace, snapshot, target.title + ' '), 'deleteTypeTitle');
      assert.equal(ui.deletionReceipt(snapshot, result), true);
      assert.equal(ui.deletionReceipt(snapshot, { ...result, bookId: sibling.id }), false);
      const state = { books: [target, sibling], workspace, selection: { text: '😀' }, context: {},
        job: { bookId: target.id }, recovery: { bookId: target.id }, pendingLatest: target,
        activeJobs: [{ bookId: sibling.id }], drafts: new Map([[target.id, 'local target'], [sibling.id, 'local sibling']]),
        rememberedJobs: new Map([[target.id, 'target-job'], [sibling.id, 'sibling-job']]) };
      const next = ui.afterBookDeletion(state, snapshot, result);
      assert.equal(next.workspace, null); assert.equal(next.recovery, null); assert.equal(next.pendingLatest, null);
      assert.deepEqual(next.books, [sibling]); assert.deepEqual([...next.drafts], [[sibling.id, 'local sibling']]);
      assert.deepEqual([...next.rememberedJobs], [[sibling.id, 'sibling-job']]);
      assert.equal(state.drafts.size, 2, 'client reducer must not mutate pre-delete recovery snapshots');
      assert.equal(ui.afterBookDeletion(state, snapshot, { ...result, deleted: false }), state);
      await assert.rejects(execute('get', { bookId: target.id }), { code: 'NOT_FOUND' });
      await assert.rejects(execute('job', { jobId: 'seed-job' }), { code: 'NOT_FOUND' });
      assert.deepEqual(await execute('get', { bookId: sibling.id }), sibling);
    } finally { await deactivate(); }
    // Retry while the I/O fault is still present, then a healthy restart.
    await activate();
    try {
      assert.deepEqual((await execute('list')).books.map(b => b.id), [sibling.id]);
      assert.equal((await execute('list')).cleanupPending, !['none', 'intent'].includes(failure) ? 1 : 0);
    } finally { await deactivate(); }
    fault = 'none'; await activate();
    try {
      assert.equal((await execute('list')).cleanupPending, 0);
      const manuscriptPath = join(directory, `ycx_moxu_book_${target.id.replaceAll('-', '_')}.json`);
      const erased = await readFile(manuscriptPath, 'utf8');
      assert(!erased.includes(target.id)); assert(!erased.includes('完整原稿'));
      assert(!(await readFile(join(directory, 'ycx_moxu_index.json'), 'utf8')).includes('SENSITIVE_DELETION_MARKER'));
      const imported = await execute('import', { text: backup.text });
      assert.notEqual(imported.id, target.id); assert.equal(imported.chapters[0].body, target.chapters[0].body);
      for (const book of [imported, sibling]) {
        const receipt = await execute('delete', { bookId: book.id, expectedRevision: book.revision, confirmTitle: book.title });
        assert.equal(receipt.cleanupPending, false);
      }
      assert.deepEqual((await execute('list')).books, [], 'deleting the final book leaves an empty library');
    } finally { await deactivate(); }
    await activate();
    try {
      assert.deepEqual((await execute('list')).books, [], 'empty library stays empty after reopen');
      const fresh = await execute('create', { title: '空书库重新开始' });
      assert.deepEqual((await execute('list')).books.map(book => book.id), [fresh.id]);
    } finally { await deactivate(); }
  }
} finally {
  const target = await realpath(root);
  assert.equal(dirname(target), tempParent); assert.ok(basename(target).startsWith('inspiration-contract-'));
  await rm(target, { recursive: true });
}
console.log('PASS: six real Session/stream scenarios; real JSON backend save/reopen/corruption isolation; tool schema and route disposal/reactivation; five production-tool deletion/failed-I/O/restart scenarios with actual client receipt/reducer contracts. No model network or GUI operation.');
