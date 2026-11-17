// Isolated integration: installed LLM capability validation, Cordis and JSON
// backend, production tool/prefs/service/model runner. Adapter wire is a local
// fixture (no model network or real manuscripts); agent factory is explicit double.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
const require = createRequire(import.meta.url);
const modules = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-session'];
const entries = new Map(modules.map(name => [name, pathToFileURL(require.resolve(name, { paths: [process.env.DSH_INSTALL_DIR] })).href]));
registerHooks({ resolve(specifier, context, next) { return entries.has(specifier) ? { url: entries.get(specifier), shortCircuit: true } : next(specifier, context); } });
const { Context } = await import('@deepseek-ai/cordis');
const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm');
const { SessionStore } = await import('@deepseek-ai/dsh-session');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const { apply } = await import('../index.js');
const { ModelPreferences } = await import('../selection.js');
const { NovelService, NovelStore } = await import('../service.js');
const { makeModelRunner } = await import('../model.js');
const parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, 'inspiration-selection-contract-'));
let owner, disk, llm, global = { provider: 'fixture-a', model: 'writer', reasoningEffort: 'low' }, tool;
let calls = 0, release, entered;
let gate = new Promise(resolve => { release = resolve; });
let started = new Promise(resolve => { entered = resolve; });
const wireRequests = [];
class LocalAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'Local ' + provider }; }
  async listModels(provider) { return [{ provider, id: 'writer', name: 'Fixture Writer' }]; }
  async resolveModel(provider, model) {
    return { provider, id: model, name: 'Fixture Writer', context: { contextWindow: 65536 },
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } };
  }
  async *stream(options) {
    calls++; wireRequests.push(structuredClone({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort })); entered();
    await gate;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '隔离候选😀\r\n' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '隔离候选😀\r\n' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const boot = () => {
  owner = new Context(); disk = new JsonStorageBackend(directory); llm = new LlmRuntime(owner);
  llm.registerAdapter(['fixture-a', 'fixture-b'], new LocalAdapter());
};
const execute = (action, payload = {}) => tool.execute({ action, payload }, { signal: new AbortController().signal });
try {
  boot();
  await apply({ effect: fn => owner.effect(fn), storage: { backend: { get: () => disk } }, llm,
    agentDefaultModel: { currentSelection: () => structuredClone(global), saveSelection() { throw new Error('Global model must never be written'); } },
    webServer: { getOrigin: () => 'http://127.0.0.1:59263', register: () => () => {} },
    connection: {}, tools: { register: value => { tool = value; } },
  });
  let state = await execute('list');
  assert.deepEqual(state.modelSettings, { revision: 1, selection: null });
  assert.deepEqual((await execute('models')).providers.map(p => p.id), ['fixture-a', 'fixture-b']);
  const catalog = await execute('models', { provider: 'fixture-b', model: 'writer' });
  assert.deepEqual(catalog.details.efforts.map(e => e.id), ['low', 'high']);
  await assert.rejects(execute('setModel', { expectedRevision: 1, selection: { provider: 'fixture-b', model: 'writer', reasoningEffort: 'invented' } }));
  const selected = { provider: 'fixture-b', model: 'writer', reasoningEffort: 'high' };
  state = await execute('setModel', { expectedRevision: 1, selection: selected });
  assert.equal(state.modelSettings.revision, 2); assert.deepEqual(state.model, selected);
  await assert.rejects(execute('setModel', { expectedRevision: 1, selection: null }), { code: 'CONFLICT' });
  assert.equal(global.provider, 'fixture-a'); assert.equal(calls, 0, 'catalog and save must not call the model');
  await owner.fiber.dispose(); await disk.close();

  // Reopen real disk and run the actual model runner against our local adapter.
  boot();
  const preferences = await new ModelPreferences(disk, llm, () => global).init();
  assert.deepEqual(preferences.snapshot(), { revision: 2, selection: selected });
  const store = await new NovelStore(disk).init();
  const sessions = new SessionStore(owner); owner.on('session/flush', () => {});
  const runner = makeModelRunner({ llm, sessions, agentLoop: { async createAgent(_ctx, { sessionId }) { sessions.create(sessionId); return { async dispose() {} }; } } });
  const service = new NovelService(store, { getModel: () => global, modelPreferences: preferences, runModel: runner });
  try {
    let book = await service.dispatch({ action: 'create', title: '隔离模型快照验证' });
    book = await service.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation: { action: 'addChapter', title: '一' } });
    const launch = { action: 'generate', bookId: book.id, chapterId: book.chapters[0].id, expectedRevision: book.revision, expectedModelRevision: 2, mode: 'draft' };
    await assert.rejects(service.dispatch({ ...launch, expectedModelRevision: 1 }), { code: 'MODEL_CONFLICT' });
    assert.equal(calls, 0); assert.equal(store.jobs.size, 0, 'stale visible model cannot create job provenance or a paid call');
    const { jobId } = await service.dispatch(launch);
    await started;
    const live = service.live.get(jobId);
    assert.deepEqual(live.model, selected); assert.deepEqual(live.request.model, selected);
    await service.dispatch({ action: 'setModel', expectedRevision: 2, selection: null });
    global = { provider: 'fixture-a', model: 'writer', reasoningEffort: 'low' };
    assert.equal((await service.dispatch({ action: 'list' })).model.provider, 'fixture-a');
    release(); await live.promise;
    assert.deepEqual(wireRequests[0], selected, 'running task keeps the selection from generation start');
    const record = sessions.get('inspiration-' + jobId);
    const header = record.snapshotEvents().find(event => event.type === 'request/header');
    assert.equal(header.data.header.config.provider, 'fixture-b');
    assert.equal(header.data.header.config.reasoningEffort, 'high');
    const publicJob = await service.dispatch({ action: 'job', jobId });
    assert.deepEqual(publicJob.model, selected); assert.equal(publicJob.modelSettingsRevision, 2); assert.equal(publicJob.request, undefined);
    assert.equal(publicJob.status, 'completed');
    const latest = await service.dispatch({ action: 'get', bookId: book.id });
    assert.equal(latest.chapters[0].body, ''); assert.equal(latest.proposals.length, 1);
    await assert.rejects(service.dispatch({ ...launch, expectedRevision: latest.revision }), { code: 'MODEL_CONFLICT' });
    const { jobId: nextId } = await service.dispatch({ ...launch, expectedRevision: latest.revision, expectedModelRevision: 3 });
    await service.live.get(nextId).promise;
    assert.equal(wireRequests[1].provider, 'fixture-a'); assert.equal(wireRequests[1].reasoningEffort, 'low');
  } finally { release(); await service.close(); await owner.fiber.dispose(); await disk.close(); }
  const saved = await readFile(join(directory, 'ycx_inspiration_settings.json'), 'utf8');
  assert(saved.includes('"selection":null') || saved.includes('"selection": null'));
  console.log('PASS: production tool preferences + actual LLM catalog/effort validation, real JSON reopen, running/next-task selection isolation, logged Session header and manuscript preservation. Local fixture adapter only; no external model call.');
} finally {
  release(); await owner?.fiber.dispose(); await disk?.close();
  const target = await realpath(directory);
  assert.equal(dirname(target), parent); assert(basename(target).startsWith('inspiration-selection-contract-'));
  await rm(target, { recursive: true });
}
