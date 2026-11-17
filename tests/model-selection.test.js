import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelPreferences } from '../selection.js';
import { NovelService } from '../service.js';

// Isolated KV contract double: no profile, runtime settings, live books, or model I/O.
function backend(initial) {
  let data = initial ?? { tables: { settings: {} }, global: null };
  const state = { opens: [], writes: [], closed: 0, fail: false, beforeWrite: null, loadError: null };
  return { state, data: () => structuredClone(data), corrupt(value) { data = value; },
    close() { assert.fail('Must close the owned unit, not the shared backend'); },
    kv: { async open(spec) {
      state.opens.push(structuredClone(spec));
      return {
        async loadAll() { if (state.loadError) throw state.loadError; return structuredClone(data); },
        async putRecord(table, key, value) {
          if (state.beforeWrite) await state.beforeWrite();
          if (state.fail) throw new Error('disk full');
          state.writes.push({ table, key, value: structuredClone(value) });
          data.tables[table][key] = structuredClone(value);
        },
        async close() { state.closed++; },
      };
    } },
  };
}
function models() {
  const state = {
    providers: [{ id: 'alpha', name: 'Alpha', apiKey: 'provider-secret' }, { id: 'beta', name: 'Beta' }],
    models: {
      alpha: [{ provider: 'alpha', id: 'writer', name: 'Writer', secret: 'model-secret' }, { provider: 'alpha', id: 'plain', name: 'Plain' }],
      beta: [{ provider: 'beta', id: 'other', name: 'Other' }],
    },
    reasoning: { efforts: [{ id: 'low', name: 'Low', description: 'private-detail' }, { id: 'high', name: 'High' }], defaultEffort: 'low', token: 'reason-secret' },
    calls: [], beforeModels: null, beforeResolve: null, lastConfig: null,
  };
  return { state,
    listProviders() { state.calls.push(['listProviders']); return state.providers; },
    async listModels(provider) { state.calls.push(['listModels', provider]); if (state.beforeModels) await state.beforeModels(); return state.models[provider] ?? []; },
    async resolveModelInfo(provider, model, signal) {
      state.calls.push(['resolveModelInfo', provider, model, signal]);
      return { provider, id: model, name: model === 'writer' ? 'Writer' : model, ...(model === 'writer' && state.reasoning ? { reasoning: state.reasoning } : {}), apiKey: 'detail-secret', context: { contextWindow: 99999 } };
    },
    async resolveCallConfig(config, signal) {
      state.calls.push(['resolveCallConfig', structuredClone(config), signal]);
      if (state.beforeResolve) await state.beforeResolve();
      signal?.throwIfAborted();
      if (!state.providers.some(item => item.id === config.provider)) throw Object.assign(new Error('No adapter'), { code: 'MODEL' });
      const efforts = config.model === 'writer' ? state.reasoning?.efforts ?? [] : [];
      if (config.reasoningEffort && !efforts.some(item => item.id === config.reasoningEffort)) throw Object.assign(new Error('Unsupported effort'), { code: 'MODEL' });
      state.lastConfig = { ...config, ...(!config.reasoningEffort && config.model === 'writer' && state.reasoning?.defaultEffort ? { reasoningEffort: state.reasoning.defaultEffort } : {}), maxTokens: 1024, credential: 'resolved-secret' };
      return state.lastConfig;
    },
    stream() { assert.fail('No paid model call is permitted'); },
    discoverModels() { assert.fail('No endpoint discovery is permitted'); },
    listConfigurableProviders() { assert.fail('Do not expose dormant/configurable routes'); },
    credentials: new Proxy({}, { get() { assert.fail('No credential access'); } }),
    settings: new Proxy({}, { get() { assert.fail('No provider settings access'); } }),
  };
}
const route = (reasoningEffort) => ({ provider: 'alpha', model: 'writer', ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
async function fixture() {
  const storage = backend(), llm = models();
  let global = route('high'), reads = 0;
  const prefs = await new ModelPreferences(storage, llm, () => { reads++; return global; }).init();
  return { prefs, storage, llm, setDefault(value) { global = value; }, default: () => global, reads: () => reads };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('separate version-one settings unit initializes and persists across reopen', async () => {
  const { prefs, storage, llm } = await fixture();
  assert.deepEqual(storage.state.opens, [{ name: 'ycx_inspiration_settings', version: 1, tables: ['settings'], hasGlobal: false, layout: 'single' }]);
  assert.deepEqual(prefs.snapshot(), { revision: 1, selection: null });
  const saved = await prefs.save(route('high'), 1);
  assert.deepEqual(saved, { revision: 2, selection: route('high') });
  await prefs.close();
  const reopened = await new ModelPreferences(storage, llm, () => null).init();
  assert.deepEqual(reopened.snapshot(), saved);
  assert.deepEqual(reopened.effective(), route('high'));
  assert.equal(storage.state.writes.length, 2, 'reopen does not rewrite settings');
  await reopened.close();
  assert.equal(storage.state.closed, 2);
});

test('exact optimistic revision is mandatory and stale concurrent saves serialize', async () => {
  const { prefs, storage } = await fixture();
  for (const revision of [undefined, null, '1', 0, 1.1, NaN, Infinity]) await assert.rejects(prefs.save(null, revision), { code: 'CONFLICT' });
  const results = await Promise.allSettled([prefs.save(route('high'), 1), prefs.save(route('low'), 1)]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(results[1].reason.code, 'CONFLICT');
  assert.deepEqual(prefs.snapshot(), { revision: 2, selection: route('high') });
  assert.equal(storage.state.writes.length, 2);
  await prefs.close();
});

test('failed durable save is atomic and does not poison later saves', async () => {
  const { prefs, storage } = await fixture();
  const before = storage.data(); storage.state.fail = true;
  await assert.rejects(prefs.save(route('high'), 1), /disk full/);
  assert.deepEqual(prefs.snapshot(), { revision: 1, selection: null });
  assert.deepEqual(storage.data(), before);
  storage.state.fail = false;
  assert.equal((await prefs.save(route('low'), 1)).revision, 2);
  await prefs.close();
});

test('catalog is progressive, active-only, public-field-only, and does not consult defaults', async () => {
  const { prefs, llm, reads } = await fixture();
  const providers = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];
  assert.deepEqual(await prefs.catalog(), { providers, models: [], details: null });
  assert.deepEqual(llm.state.calls, [['listProviders']]);
  const selected = await prefs.catalog({ provider: 'alpha', model: 'writer' });
  assert.deepEqual(selected, { providers, models: [{ provider: 'alpha', id: 'writer', name: 'Writer' }, { provider: 'alpha', id: 'plain', name: 'Plain' }], details: { provider: 'alpha', id: 'writer', name: 'Writer', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } });
  assert.equal(reads(), 0);
  selected.details.efforts[0].name = 'mutated'; selected.providers[0].id = 'changed';
  assert.equal((await prefs.catalog({ provider: 'alpha', model: 'writer' })).details.efforts[0].name, 'Low');
  assert.equal((await prefs.catalog({ provider: 'alpha' })).details, null);
  assert.deepEqual((await prefs.catalog({ provider: 'alpha', model: 'plain' })).details.efforts, []);
  await prefs.close();
});

test('explicit selection requires exact provider, model and effort advertised membership', async () => {
  const { prefs } = await fixture();
  for (const candidate of [
    { provider: 'Alpha', model: 'writer' }, { provider: 'dormant', model: 'writer' },
    { provider: 'alpha', model: 'Writer' }, { provider: 'alpha', model: 'other' },
    route('HIGH'), route('medium'), { provider: 'alpha', model: 'plain', reasoningEffort: 'low' },
  ]) await assert.rejects(prefs.save(candidate, 1), { code: 'MODEL' });
  await assert.rejects(prefs.catalog({ model: 'writer' }), { code: 'VALIDATION' });
  await assert.rejects(prefs.catalog({ provider: 'dormant' }), { code: 'MODEL' });
  await assert.rejects(prefs.catalog({ provider: 'alpha', model: 'unlisted' }), { code: 'MODEL' });
  assert.equal((await prefs.save(route(), 1)).revision, 2);
  assert.equal((await prefs.save({ provider: 'beta', model: 'other' }, 2)).revision, 3);
  await prefs.close();
});

test('removed provider, model, or effort rejects resolution and saves without changing stored selection', async () => {
  for (const remove of [
    llm => { llm.state.providers = []; },
    llm => { llm.state.models.alpha = []; },
    llm => { llm.state.reasoning.efforts = [{ id: 'low', name: 'Low' }]; },
    llm => { llm.state.reasoning = undefined; },
  ]) {
    const { prefs, llm, storage } = await fixture();
    await prefs.save(route('high'), 1); const before = storage.data();
    remove(llm);
    await assert.rejects(prefs.resolve(), { code: 'MODEL' });
    await assert.rejects(prefs.save(route('high'), 2), { code: 'MODEL' });
    assert.deepEqual(prefs.snapshot(), { revision: 2, selection: route('high') });
    assert.deepEqual(storage.data(), before);
    // Following global is always saveable, even when no models remain.
    assert.equal((await prefs.save(null, 2)).selection, null);
    await prefs.close();
  }
});

test('null follows changing global default including reasoning, without writing it', async () => {
  const { prefs, setDefault, default: global, storage } = await fixture();
  assert.deepEqual(prefs.effective(), route('high'));
  const effective = prefs.effective(); effective.model = 'bad';
  assert.equal(global().model, 'writer');
  await prefs.save(route('low'), 1);
  setDefault({ provider: 'beta', model: 'other' });
  assert.deepEqual(prefs.effective(), route('low'));
  await prefs.save(null, 2);
  assert.deepEqual(prefs.effective(), { provider: 'beta', model: 'other' });
  setDefault(route('high'));
  assert.equal((await prefs.resolve()).reasoningEffort, 'high');
  assert.deepEqual(global(), route('high'));
  assert.equal(storage.state.writes.length, 3, 'effective/resolve never persist defaults');
  await prefs.close();
});

test('global uncatalogued route is allowed only when resolveCallConfig accepts it', async () => {
  const { prefs, llm, setDefault } = await fixture();
  setDefault({ provider: 'alpha', model: 'uncatalogued' });
  assert.deepEqual(await prefs.resolve(), { provider: 'alpha', model: 'uncatalogued', maxTokens: 1024 });
  assert.deepEqual(llm.state.calls.map(call => call[0]), ['resolveCallConfig']);
  setDefault({ provider: 'removed', model: 'uncatalogued' });
  await assert.rejects(prefs.resolve(), { code: 'MODEL' });
  for (const missing of [null, undefined, {}, { provider: 'alpha' }, { model: 'writer' }]) {
    setDefault(missing); await assert.rejects(prefs.resolve(), { code: 'MODEL' });
  }
  await prefs.close();
});

test('missing or empty global routing leaves list/editor available while generation resolution fails MODEL', async () => {
  const { prefs, setDefault, storage } = await fixture();
  // Empty in-memory library only: this never opens or modifies a live book.
  const store = { ids: new Set(), deletions: new Set(), serial: operation => operation() };
  const service = new NovelService(store, { modelPreferences: prefs });
  for (const missing of [null, undefined, {}, { provider: 'alpha' }, { model: 'writer' }, { provider: '', model: '' }, { provider: 'alpha', model: '' }, { provider: ' ', model: 'writer' }, { provider: null, model: 'writer' }]) {
    setDefault(missing);
    assert.equal(prefs.effective(), null);
    const listed = await service.dispatch({ action: 'list' });
    assert.deepEqual(listed.books, []);
    assert.equal(listed.model, null);
    assert.deepEqual(listed.modelSettings, { revision: 1, selection: null });
    await assert.rejects(prefs.resolve(), { code: 'MODEL' });
  }
  assert.equal(storage.state.writes.length, 1);
  await prefs.close();
});

test('resolve materializes adapter defaults and detaches controls and model snapshots', async () => {
  const { prefs, llm } = await fixture();
  await prefs.save(route(), 1);
  const resolved = await prefs.resolve();
  assert.deepEqual(resolved, { provider: 'alpha', model: 'writer', reasoningEffort: 'low', maxTokens: 1024 });
  assert.equal(prefs.snapshot().selection.reasoningEffort, undefined, 'adapter default is not saved as an explicit preference');
  llm.state.lastConfig.reasoningEffort = 'high';
  assert.equal(resolved.reasoningEffort, 'low');
  resolved.model = 'changed';
  assert.equal(prefs.snapshot().selection.model, 'writer');
  assert.equal(JSON.stringify(resolved).includes('secret'), false);
  await prefs.close();
});

test('resolution freezes the route before asynchronous work and later preference/default changes', async () => {
  const { prefs, llm, setDefault } = await fixture();
  const gate = deferred(), entered = deferred();
  llm.state.beforeResolve = () => { entered.resolve(); return gate.promise; };
  const pending = prefs.resolve(); await entered.promise;
  setDefault({ provider: 'beta', model: 'other' });
  await prefs.save({ provider: 'beta', model: 'other' }, 1);
  gate.resolve();
  assert.deepEqual(await pending, { provider: 'alpha', model: 'writer', reasoningEffort: 'high', maxTokens: 1024 });
  await prefs.close();
});

test('save input, result and snapshot are independently detached', async () => {
  const { prefs, llm } = await fixture();
  const gate = deferred(), entered = deferred();
  llm.state.beforeModels = () => { entered.resolve(); return gate.promise; };
  const input = route('high'), pending = prefs.save(input, 1); await entered.promise;
  input.model = 'mutated'; input.reasoningEffort = 'bad'; gate.resolve();
  const saved = await pending; saved.selection.model = 'also-mutated'; saved.revision = 99;
  const snapshot = prefs.snapshot(); snapshot.selection.reasoningEffort = 'bad'; snapshot.revision = 100;
  assert.deepEqual(prefs.snapshot(), { revision: 2, selection: route('high') });
  await prefs.close();
});

test('strict selection schema rejects objects, excessive strings, unknown keys and accessors without invoking them', async () => {
  const { prefs, storage } = await fixture(); let invoked = 0;
  const getter = { provider: 'alpha', model: 'writer', get reasoningEffort() { invoked++; return 'low'; } };
  const hidden = route(); Object.defineProperty(hidden, 'apiKey', { value: 'secret' });
  const symbol = route(); symbol[Symbol('secret')] = 'secret';
  for (const invalid of [
    undefined, [], true, 5, 'writer', {}, { provider: 'alpha', model: 3 },
    { provider: 'alpha', model: { toString: () => 'writer' } },
    { provider: '', model: 'writer' }, { provider: 'a'.repeat(257), model: 'writer' },
    { provider: 'alpha', model: 'm'.repeat(513) }, route('e'.repeat(257)), route(null), { ...route(), reasoningEffort: undefined },
    { ...route(), apiKey: 'secret' }, { ...route(), temperature: 0 }, { provider: 'alpha\n', model: 'writer' },
    Object.create(route()), getter, hidden, symbol,
  ]) await assert.rejects(prefs.save(invalid, 1), { code: 'VALIDATION' });
  assert.equal(invoked, 0);
  assert.equal(storage.state.writes.length, 1);
  assert.deepEqual(prefs.snapshot(), { revision: 1, selection: null });
  await prefs.close();
});

test('secret metadata getters are not evaluated and never enter public catalog or defaults', async () => {
  const { prefs, llm, setDefault } = await fixture();
  const secret = () => { assert.fail('Secret metadata accessor must not be touched'); };
  Object.defineProperty(llm.state.providers[0], 'credential', { get: secret });
  Object.defineProperty(llm.state.models.alpha[0], 'apiKey', { get: secret });
  Object.defineProperty(llm.state.reasoning.efforts[0], 'description', { get: secret, configurable: true });
  const global = route('high'); Object.defineProperty(global, 'credential', { get: secret }); setDefault(global);
  assert.deepEqual(prefs.effective(), route('high'));
  const catalog = await prefs.catalog({ provider: 'alpha', model: 'writer' });
  assert.equal(JSON.stringify(catalog).includes('secret'), false);
  await prefs.close();
});

test('malformed persisted schema fails closed and never resets or overwrites corruption', async () => {
  const record = { revision: 3, selection: route('high') };
  for (const corrupt of [
    null, {}, { tables: {}, global: null }, { tables: { settings: [] }, global: null },
    { tables: { settings: {} }, global: { old: true } },
    { tables: { settings: { unexpected: record } }, global: null },
    ...[null, {}, { revision: 0, selection: null }, { revision: '3', selection: null }, { revision: 3 }, { ...record, extra: true }, { revision: 3, selection: { ...route(), apiKey: 'secret' } }, { revision: 3, selection: route(null) }].map(value => ({ tables: { settings: { model: value } }, global: null })),
  ]) {
    // Explicit undefined is not a malformed load result in this double; null is.
    const storage = backend(); storage.corrupt(corrupt);
    const prefs = new ModelPreferences(storage, models(), () => route());
    await assert.rejects(prefs.init(), { code: 'STORAGE' });
    await assert.rejects(prefs.init(), { code: 'STORAGE' });
    assert.throws(() => prefs.snapshot(), { code: 'STORAGE' });
    await assert.rejects(prefs.save(null, 1), { code: 'STORAGE' });
    assert.equal(storage.state.writes.length, 0); assert.equal(storage.state.closed, 1);
    await prefs.close(); assert.equal(storage.state.closed, 1);
  }
});

test('load failure and initial write failure do not become a usable empty preference', async () => {
  for (const configure of [storage => { storage.state.loadError = new Error('invalid JSON'); }, storage => { storage.state.fail = true; }]) {
    const storage = backend(); configure(storage);
    const prefs = new ModelPreferences(storage, models(), () => route());
    await assert.rejects(prefs.init(), /invalid JSON|disk full/);
    assert.throws(() => prefs.snapshot(), /invalid JSON|disk full/);
    assert.equal(storage.state.closed, 1); assert.equal(storage.state.writes.length, 0);
    await prefs.close();
  }
});

test('close waits for accepted queued saves and closes only its KV unit exactly once', async () => {
  const { prefs, storage, llm } = await fixture();
  const entered = deferred(), gate = deferred();
  llm.state.beforeModels = () => { entered.resolve(); return gate.promise; };
  const first = prefs.save(route('high'), 1), second = prefs.save(null, 2);
  await entered.promise;
  const closing = prefs.close();
  assert.equal(storage.state.closed, 0);
  await assert.rejects(prefs.save(null, 3), { code: 'CLOSED' });
  await assert.rejects(prefs.catalog(), { code: 'CLOSED' });
  await assert.rejects(prefs.resolve(), { code: 'CLOSED' });
  assert.throws(() => prefs.snapshot(), { code: 'CLOSED' });
  gate.resolve(); await first; await second; await closing; await prefs.close();
  assert.equal(storage.state.closed, 1);
  assert.deepEqual(storage.data().tables.settings.model, { revision: 3, selection: null });
});

test('abort is honored before validation/write; an already committed write stays reflected in memory', async () => {
  const { prefs, storage } = await fixture();
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(prefs.catalog({}, controller.signal), /cancelled/);
  await assert.rejects(prefs.save(route(), 1, controller.signal), /cancelled/);
  await assert.rejects(prefs.resolve(controller.signal), /cancelled/);
  assert.equal(storage.state.writes.length, 1);
  const writing = new AbortController();
  storage.state.beforeWrite = async () => { writing.abort(new Error('late cancellation')); };
  const saved = await prefs.save(null, 1, writing.signal);
  assert.deepEqual(prefs.snapshot(), saved);
  assert.equal(saved.revision, 2);
  await prefs.close();
});

test('aborting a stalled catalog wait releases a queued save without claiming to cancel provider work', async () => {
  const { prefs, llm, storage } = await fixture();
  const entered = deferred(), gate = deferred(), controller = new AbortController();
  let underlyingSettled = false;
  llm.listModels = async (...args) => {
    assert.deepEqual(args, ['alpha'], 'installed listModels accepts provider only');
    entered.resolve(); await gate.promise; underlyingSettled = true;
    return llm.state.models.alpha;
  };
  const stalled = prefs.save(route('high'), 1, controller.signal);
  const rejected = assert.rejects(stalled, /cancel metadata wait/);
  await entered.promise;
  controller.abort(new Error('cancel metadata wait'));
  await rejected;
  assert.equal(underlyingSettled, false, 'caller stops waiting without falsely cancelling the provider');
  assert.deepEqual(prefs.snapshot(), { revision: 1, selection: null });
  const committed = await prefs.save(null, 1);
  assert.equal(committed.revision, 2);
  gate.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(prefs.snapshot(), committed, 'late metadata cannot commit the aborted save');
  assert.equal(storage.state.writes.length, 2);
  await prefs.close();
});

test('metadata timeout bounds an uncancellable stalled save and allows close to drain', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { prefs, llm, storage } = await fixture();
  const entered = deferred();
  llm.listModels = async () => { entered.resolve(); return new Promise(() => {}); };
  const stalled = prefs.save(route('high'), 1);
  const rejected = assert.rejects(stalled, error => error.code === 'MODEL' && /timed out/.test(error.message));
  await entered.promise;
  const closing = prefs.close();
  assert.equal(storage.state.closed, 0);
  context.mock.timers.tick(15_000);
  await rejected; await closing;
  assert.equal(storage.state.closed, 1);
  assert.deepEqual(storage.data().tables.settings.model, { revision: 1, selection: null });
});

test('async model info and adapter config waits honor abort even if providers ignore it', async () => {
  for (const method of ['resolveModelInfo', 'resolveCallConfig']) {
    const { prefs, llm } = await fixture();
    const entered = deferred(), gate = deferred(), controller = new AbortController();
    const original = llm[method];
    llm[method] = async (...args) => { entered.resolve(); await gate.promise; return original.apply(llm, args); };
    const pending = method === 'resolveModelInfo' ? prefs.catalog({ provider: 'alpha', model: 'writer' }, controller.signal) : prefs.resolve(controller.signal);
    const rejected = assert.rejects(pending, /stop metadata/);
    await entered.promise; controller.abort(new Error('stop metadata')); await rejected;
    gate.resolve(); await Promise.resolve(); await Promise.resolve();
    await prefs.close();
  }
});

test('signals reach exact model metadata and adapter config validation without generation', async () => {
  const { prefs, llm } = await fixture();
  const controller = new AbortController();
  await prefs.save(route('high'), 1, controller.signal);
  await prefs.resolve(controller.signal);
  const info = llm.state.calls.filter(call => call[0] === 'resolveModelInfo');
  assert.ok(info.length >= 2); assert.ok(info.every(call => call[3] === controller.signal));
  assert.equal(llm.state.calls.find(call => call[0] === 'resolveCallConfig')[2], controller.signal);
  await prefs.close();
});

test('lifecycle is independent of llm availability and close is safe before initialization', async () => {
  const storage = backend();
  const unopened = new ModelPreferences(storage, undefined, () => route());
  await unopened.close(); await unopened.close();
  assert.equal(storage.state.opens.length, 0); assert.equal(storage.state.closed, 0);
  await assert.rejects(unopened.init(), { code: 'CLOSED' });
  const prefs = await new ModelPreferences(storage, undefined, () => route()).init();
  assert.deepEqual(prefs.snapshot(), { revision: 1, selection: null });
  assert.deepEqual(prefs.effective(), route());
  await assert.rejects(prefs.catalog(), { code: 'MODEL' });
  await assert.rejects(prefs.resolve(), { code: 'MODEL' });
  await prefs.save(null, 1);
  await prefs.close();
});

test('misrouted catalog metadata and resolved config fail closed', async () => {
  const { prefs, llm } = await fixture();
  llm.state.models.alpha[0].provider = 'beta';
  await assert.rejects(prefs.catalog({ provider: 'alpha' }), { code: 'MODEL' });
  llm.state.models.alpha[0].provider = 'alpha';
  llm.resolveModelInfo = async () => ({ provider: 'alpha', id: 'different', name: 'Wrong' });
  await assert.rejects(prefs.save(route(), 1), { code: 'MODEL' });
  llm.resolveCallConfig = async () => ({ provider: 'beta', model: 'writer' });
  await assert.rejects(prefs.resolve(), { code: 'MODEL' });
  await prefs.close();
});
