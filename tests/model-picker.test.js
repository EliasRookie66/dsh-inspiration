import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Actual renderer-independent helpers only. No React/DOM substitute, ModuleLoader
// execution, browser simulation, paid generation, or assertion of visual layout.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('    const equal =');
const end = source.indexOf('    const en =');
assert(start > 0 && end > start);
const helperSource = source.slice(start, end);
const names = 'validModelSelection,validModelSettings,sameModelSelection,receiveModelSettings,modelRouteKey,catalogRequestIsCurrent,modelCatalogRequest,modelCatalogProblem,modelGenerationProblem,modelDescription,workspace,isDirty,recoveryPayload';
const extract = text => new Function(text + '\nreturn {' + names + '};')();
const f = extract(helperSource);
const route = { provider: 'active-a', model: 'writer' };
const settings = { revision: 1, selection: route };
const initial = () => ({ settings: null, draft: null, available: false, conflict: false });
const saved = () => f.receiveModelSettings(initial(), settings);
const catalog = (selection = route) => ({ key: f.modelRouteKey(selection), loading: false, error: '',
  providers: [{ id: 'active-a', name: 'Active A' }, { id: 'active-b', name: 'Active B' }],
  models: [{ provider: 'active-a', id: 'writer', name: 'Writer' }],
  details: { provider: 'active-a', id: 'writer', name: 'Writer', efforts: [{ id: 'deep', name: 'Deep' }], defaultEffort: 'deep' } });

test('missing old-runtime modelSettings is unavailable, not a crash or an implicit saved default', () => {
  for (const value of [undefined, null, {}, { revision: 0, selection: null }, { revision: 1.5, selection: null }, { revision: 1 }, { revision: 1, selection: {} }]) {
    assert(!f.validModelSettings(value));
    const next = f.receiveModelSettings(initial(), value);
    assert.equal(next.available, false);
    assert.equal(f.modelGenerationProblem(next, catalog()), 'modelFeatureUnavailable');
  }
  assert(f.validModelSettings({ revision: 1, selection: null }));
  assert(f.validModelSettings(settings));
  assert(f.validModelSettings({ revision: 2, selection: { ...route, reasoningEffort: 'deep' } }));
  assert(!f.validModelSettings({ revision: 2, selection: { ...route, reasoningEffort: '' } }));
});

test('model equality is semantic rather than property order or object identity', () => {
  assert(f.sameModelSelection(route, { model: route.model, provider: route.provider }));
  assert(f.sameModelSelection(route, { ...route, reasoningEffort: undefined }));
  assert(!f.sameModelSelection(null, route));
  assert(!f.sameModelSelection(route, { ...route, reasoningEffort: 'deep' }));
  assert(f.sameModelSelection(null, null));
});

test('refresh and conflict keep every local model choice until explicit reload, including clean prior choices', () => {
  const draft = { provider: 'active-b', model: 'other', reasoningEffort: 'low' };
  for (const choice of [route, draft, null]) {
    const state = { ...saved(), draft: choice };
    const concurrent = { revision: 2, selection: null };
    const result = f.receiveModelSettings(state, concurrent);
    assert.strictEqual(result.draft, choice);
    assert.strictEqual(result.settings, state.settings);
    assert.equal(result.conflict, true);
    assert.equal(f.modelGenerationProblem(result, catalog(choice)), 'modelSettingsConflict');
    const reloaded = f.receiveModelSettings(result, concurrent, true);
    assert.strictEqual(reloaded.settings, concurrent);
    assert.equal(reloaded.draft, null);
    assert.equal(reloaded.conflict, false);
  }
  const state = saved();
  assert.strictEqual(f.receiveModelSettings(state, { revision: 0, selection: null }).draft, state.draft);
  assert.strictEqual(f.receiveModelSettings({ ...state, settings: { revision: 3, selection: route } }, settings).settings.revision, 3);
  assert.equal(f.receiveModelSettings(state, { revision: 1, selection: null }).conflict, true, 'Malformed same-revision changes must not silently overwrite intent');
});

test('dropdown intent, loading, saving and catalog errors block generation independently of manuscript dirtiness', () => {
  const state = saved(), data = catalog();
  assert.equal(f.modelGenerationProblem(state, data), '');
  assert.equal(f.modelGenerationProblem({ ...state, draft: null }, data), 'modelUnsaved');
  assert.equal(f.modelGenerationProblem(state, data, true), 'modelSaving');
  assert.equal(f.modelGenerationProblem(state, { ...data, loading: true }), 'modelLoading');
  assert.equal(f.modelGenerationProblem(state, { ...data, key: 'older-route' }), 'modelLoading');
  assert.equal(f.modelGenerationProblem(state, { ...data, error: 'offline' }), 'modelCatalogError');
  const book = { id: 'book', revision: 1, title: 'Title', premise: '', outline: '', style: '', contextBudget: 1000, chapters: [], cards: [], proposals: [] };
  const w = f.workspace(book);
  const before = structuredClone(w);
  f.receiveModelSettings({ ...state, draft: null }, { revision: 2, selection: route });
  assert.deepEqual(w, before);
  assert(!f.isDirty(w));
  assert(!Object.hasOwn(f.recoveryPayload(w), 'modelSettings'));
});

test('unavailable saved routes stay selected; follow-default is an explicit draft and explicit save', () => {
  const state = saved();
  assert.equal(f.modelCatalogProblem(route, { ...catalog(), providers: [] }), 'modelRouteUnavailable');
  assert.equal(f.modelCatalogProblem(route, { ...catalog(), models: [] }), 'modelRouteUnavailable');
  assert.equal(f.modelCatalogProblem(route, { ...catalog(), details: { provider: 'active-b', id: route.model, efforts: [] } }), 'modelRouteUnavailable');
  assert.equal(f.modelCatalogProblem({ provider: 'active-a', model: '' }, catalog({ provider: 'active-a', model: '' })), 'modelChooseRoute');
  assert.strictEqual(state.draft, route);
  const followDraft = { ...state, draft: null };
  assert.equal(f.modelGenerationProblem(followDraft, catalog(null)), 'modelUnsaved');
  const applied = f.receiveModelSettings(followDraft, { revision: 2, selection: null }, true);
  assert.equal(f.modelGenerationProblem(applied, catalog(null)), '');
  assert.equal(applied.settings.selection, null, 'Follow-default must never persist today’s concrete DSH model');
});

test('progressive catalog decisions recover removed saved/global routes without resolving unknown providers or models', () => {
  const root = { providers: catalog().providers, models: [] };
  const removedProvider = { provider: 'removed', model: 'gone' };
  const removedModel = { provider: 'active-a', model: 'gone' };
  for (const value of [null, { provider: '', model: '' }, removedProvider]) assert.equal(f.modelCatalogRequest(value, root), null);
  assert.deepEqual(f.modelCatalogRequest(removedModel, root), { provider: 'active-a' });
  assert.equal(f.modelCatalogRequest(removedModel, catalog(), true), null);
  assert.deepEqual(f.modelCatalogRequest(route, catalog(), true), route);
  // Missing saved provider still leaves the independent active provider catalog.
  // A user may choose one without applying a broken global default first.
  const afterFailure = { ...catalog(removedProvider), providers: root.providers, models: [], details: null, error: 'route removed' };
  assert.deepEqual(f.modelCatalogRequest({ provider: 'active-a', model: '' }, afterFailure), { provider: 'active-a' });
  assert.equal(f.modelCatalogRequest({ provider: 'active-a', model: '' }, afterFailure, true), null);
  const unavailableSaved = f.receiveModelSettings(initial(), { revision: 1, selection: removedProvider });
  const selectedValid = { ...unavailableSaved, draft: route };
  assert.equal(f.modelGenerationProblem(selectedValid, catalog()), 'modelUnsaved');
  const applied = f.receiveModelSettings(selectedValid, { revision: 2, selection: route }, true);
  assert.equal(f.modelGenerationProblem(applied, catalog()), '');
});

test('source review: discovery preserves partial catalogs and guards each progressive await', () => {
  const from = source.indexOf('            let partial = { key: request.key');
  const to = source.indexOf('          }, [modelPrefs.available', from);
  const discovery = source.slice(from, to);
  assert(from > 0 && to > from);
  assert(discovery.includes("await call('models', {}, controller.signal)"));
  assert(discovery.includes('partial = { ...partial, providers: root.providers }'));
  assert(discovery.includes('partial = { ...partial, models: providerData.models }'));
  assert(discovery.includes('const providerQuery = modelCatalogRequest(picked, partial)'));
  assert(discovery.includes('const detailQuery = modelCatalogRequest(picked, partial, true)'));
  assert.equal(discovery.split('if (!fresh()) return;').length - 1, 3);
  const failure = discovery.slice(discovery.indexOf('} catch (e)'));
  assert(failure.includes('commitCatalog({ ...partial, details: null, loading: false, error:'));
  assert(!failure.includes('providers: []'), 'Metadata errors must not erase independently discovered active providers');
  const picker = source.slice(source.indexOf('          const renderModelPicker ='), source.indexOf('          const renderAI ='));
  assert(picker.includes("changeModelDraft(e.target.value === 'default' ? null : { provider: '', model: '' })"));
  assert(!picker.includes("provider: model?.provider"), 'Custom must not reseed an unavailable DSH default');
  assert(picker.includes("modelPrefs.settings?.selection === null ? 'modelFollowObserved' : 'modelEffective'"));
  assert(picker.includes('!modelPrefs.conflict && (model?.provider && model?.model'), 'Do not classify fresh effective data using a deliberately retained old preference baseline during conflicts');
});

test('only advertised reasoning efforts are valid; provider default remains absent, not forced to advertised defaultEffort', () => {
  assert.equal(f.modelCatalogProblem(route, catalog()), '');
  assert.equal(f.modelCatalogProblem({ ...route, reasoningEffort: 'deep' }, catalog()), '');
  assert.equal(f.modelCatalogProblem({ ...route, reasoningEffort: 'invented' }, catalog()), 'modelEffortUnavailable');
  assert.equal(f.modelCatalogProblem(route, { ...catalog(), details: { ...catalog().details, efforts: [] } }), '');
  assert.equal(f.modelCatalogProblem({ ...route, reasoningEffort: 'deep' }, { ...catalog(), details: { ...catalog().details, efforts: [] } }), 'modelEffortUnavailable');
  assert(!Object.hasOwn(route, 'reasoningEffort'));
  assert.equal(f.modelDescription({ ...route, reasoningEffort: 'deep' }), 'active-a / writer · deep');
  assert.equal(f.modelDescription(null), '');
});

test('catalog sequence, exact provider/model and abort decisions independently reject stale results', () => {
  const request = { sequence: 7, key: f.modelRouteKey(route) };
  assert(f.catalogRequestIsCurrent(7, request, route));
  assert(f.catalogRequestIsCurrent(7, request, { ...route, reasoningEffort: 'deep' }), 'Effort-only changes share the same route metadata');
  assert(!f.catalogRequestIsCurrent(8, request, route));
  assert(!f.catalogRequestIsCurrent(7, request, { ...route, provider: 'active-b' }));
  assert(!f.catalogRequestIsCurrent(7, request, { ...route, model: 'new-model' }));
  assert(!f.catalogRequestIsCurrent(7, request, route, true));
  assert(!f.catalogRequestIsCurrent(7, request, null));
  for (const [before, after, verify] of [
    ['sequence === request.sequence', 'true', m => assert(!m.catalogRequestIsCurrent(8, request, route))],
    ['modelRouteKey(selection) === request.key', 'true', m => assert(!m.catalogRequestIsCurrent(7, request, { ...route, model: 'new-model' }))],
    ['return !aborted && sequence', 'return true && sequence', m => assert(!m.catalogRequestIsCurrent(7, request, route, true))],
  ]) {
    assert.equal(helperSource.split(before).length, 2);
    verify(f);
    assert.throws(() => verify(extract(helperSource.replace(before, after))), assert.AssertionError);
  }
});

test('out-of-order deferred catalog completions cannot replace the latest route decision', async () => {
  let sequence = 1, selection = route, displayed = null;
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const first = deferred(), second = deferred();
  const bind = (pending, request) => pending.promise.then(data => {
    if (f.catalogRequestIsCurrent(sequence, request, selection)) displayed = data;
  });
  const a = bind(first, { sequence: 1, key: f.modelRouteKey(selection) });
  sequence = 2; selection = { provider: 'active-b', model: 'new' };
  const b = bind(second, { sequence: 2, key: f.modelRouteKey(selection) });
  second.resolve('new catalog'); await b;
  first.resolve('stale catalog'); await a;
  assert.equal(displayed, 'new catalog');
});

test('source review: preference operations never commit workspace, mutate prose, or invoke manuscript saves', () => {
  const from = source.indexOf('          const changeModelDraft =');
  const to = source.indexOf('          const refreshList =', from);
  const operations = source.slice(from, to);
  assert(from > 0 && to > from);
  assert(!/\bcommit\(|\bsetW\(|\bmutateRaw\(|\bsaveAll\(|\btransition\(/.test(operations));
  assert.equal([...source.matchAll(/call\('setModel'/g)].length, 1);
  const saveStart = operations.indexOf('const applyModelPreference =');
  assert(saveStart >= 0 && operations.indexOf("call('setModel'") > saveStart, 'Dropdowns and reload must never setModel');
  assert(operations.includes('expectedRevision: prefs.settings.revision'));
  assert(operations.includes('modelSettingsEpoch.current++'));
  assert(operations.includes('catalogController.current?.abort()'));
  assert(source.includes("expectedModelRevision: modelPrefsRef.current.settings.revision"));
  const generate = source.slice(source.indexOf('          const generate ='), source.indexOf('          const create ='));
  assert(generate.includes("if (e.code === 'MODEL_CONFLICT')"));
  assert(!generate.includes("if (e.code === 'CONFLICT')"), 'Manuscript conflict must not masquerade as model preference conflict');
  assert(generate.includes("new Error(t('modelSettingsConflict'))"));
  assert(source.includes('const modelProblem = modelGenerationProblem(modelPrefsRef.current, catalogRef.current, modelSaveRef.current);'));
  assert(source.includes('if (modelProblem) throw new Error(t(modelProblem));'));
  assert(source.includes('modelDescription(job.model)'));
  assert(!source.includes('modelDescription(job.model || model)'));
});

test('source review: discoverable native themed model fields preserve aligned book controls and responsive widths', () => {
  const ai = source.slice(source.indexOf('          const renderAI ='), source.indexOf('          const renderSettings ='));
  const pickerIndex = ai.indexOf('renderModelPicker()'), generateIndex = ai.indexOf("button(t('generate')");
  assert(generateIndex >= 0 && pickerIndex > generateIndex, 'Compact Generate precedes the non-sticky advanced model settings');
  assert(ai.includes("className: 'mx-partner-advanced"));
  assert(ai.includes("'aria-expanded': advanced"), 'The full model settings remain explicitly discoverable');
  assert(ai.includes('|| !!modelProblem ||'));
  const picker = source.slice(source.indexOf('          const renderModelPicker ='), source.indexOf('          const renderAI ='));
  for (const key of ['modelMode', 'modelProvider', 'modelName', 'modelReasoning']) assert(picker.includes("h(Field, { label: t('" + key + "') }"));
  assert(picker.includes('custom && efforts.length > 0'));
  assert(picker.includes("h('option', { value: '' }, t('modelProviderDefault'))"));
  assert(picker.includes("button(modelSaving ? t('modelSaving') : t('modelApply'), applyModelPreference"));
  assert(picker.includes("t('modelScope')")); assert(picker.includes("t('modelNextGeneration')"));
  assert(source.includes('.mx-book-row{align-items:flex-end}'));
  assert(source.includes('.mx-root .mx-book-row select,.mx-root .mx-book-row>button{height:40px;min-height:40px}'));
  assert(source.includes('.mx-model-row{display:flex;align-items:flex-end;'));
  assert(source.includes('.mx-model-row>.mx-field,.mx-model-row>button{flex-basis:100%;width:100%}'));
  // These assertions review source wiring only; browser layout, keyboard/focus and
  // real-provider rendering still need a real mounted page, not a fake renderer.
});
