// Plugin-owned preferences only. Never reads credentials or writes the global model.
const UNIT = Object.freeze({ name: 'ycx_inspiration_settings', version: 1, tables: ['settings'], hasGlobal: false, layout: 'single' });
const RECORD = 'model';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const copy = value => structuredClone(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function abort(signal) { signal?.throwIfAborted(); }

// listModels has no cancellation parameter. Bound our wait without pretending to
// cancel provider work; always observe late failures and discard late results.
function metadata(operation, signal) {
  abort(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      handler(value);
    };
    const cancelled = () => finish(reject, signal.reason);
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('Model metadata lookup timed out'), { code: 'MODEL' })), 15_000);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) { cancelled(); return; }
    Promise.resolve().then(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

// Inspect descriptors before reading values: JSON-like input must not execute getters.
function object(value, allowed, code = 'VALIDATION') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code, 'Expected a plain model settings object');
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string' || (allowed && !allowed.includes(key)) || !own(fields[key], 'value')) fail(code, 'Unexpected model settings field or accessor');
  }
  return fields;
}
function text(value, max, code = 'VALIDATION') {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(code, 'Invalid model settings string');
  return value;
}
function selection(value, code = 'VALIDATION') {
  if (value === null) return null;
  object(value, ['provider', 'model', 'reasoningEffort'], code);
  const result = { provider: text(value.provider, 256, code), model: text(value.model, 512, code) };
  if (own(value, 'reasoningEffort')) result.reasoningEffort = text(value.reasoningEffort, 256, code);
  return result;
}
function state(value) {
  object(value, ['revision', 'selection'], 'STORAGE');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || !own(value, 'selection')) fail('STORAGE', 'Corrupt model preference revision or selection');
  return { revision: value.revision, selection: selection(value.selection, 'STORAGE') };
}
// Read only advertised public fields; irrelevant metadata (including accessors) is untouched.
function field(value, key) {
  const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !own(descriptor, 'value')) fail('MODEL', 'Invalid model catalog metadata');
  return descriptor.value;
}
function optional(value, key) {
  if (!value || !own(value, key)) return undefined;
  return field(value, key);
}
const label = value => text(value, 1024, 'MODEL');
function callConfig(value, route) {
  if (!value || field(value, 'provider') !== route.provider || field(value, 'model') !== route.model) fail('MODEL', 'Resolved model route changed');
  const result = { provider: route.provider, model: route.model };
  const effort = optional(value, 'reasoningEffort');
  if (effort !== undefined) result.reasoningEffort = text(effort, 256, 'MODEL');
  if (route.reasoningEffort !== undefined && result.reasoningEffort !== route.reasoningEffort) fail('MODEL', 'Resolved reasoning effort changed');
  for (const key of ['maxTokens', 'temperature']) {
    const control = optional(value, key);
    if (control === undefined) continue;
    if (typeof control !== 'number' || !Number.isFinite(control) || (key === 'maxTokens' && (!Number.isSafeInteger(control) || control <= 0))) fail('MODEL', 'Invalid resolved model controls');
    result[key] = control;
  }
  const stop = optional(value, 'stop');
  if (stop !== undefined) {
    if (!Array.isArray(stop) || stop.length > 64) fail('MODEL', 'Invalid resolved stop sequences');
    result.stop = stop.map(item => text(item, 4096, 'MODEL'));
  }
  return result;
}

/** Durable, independently revisioned model preferences for the inspiration plugin. */
export class ModelPreferences {
  constructor(backend, llm, getDefault) {
    this.backend = backend; this.llm = llm; this.getDefault = getDefault;
    this.chain = Promise.resolve(); this.closed = false; this.value = null;
  }
  init() {
    if (this.closed) return Promise.reject(Object.assign(new Error('Model preferences are closed'), { code: 'CLOSED' }));
    if (!this.initializing) this.initializing = this.initialize();
    return this.initializing;
  }
  async initialize() {
    try {
      this.unit = await this.backend.kv.open({ ...UNIT, tables: [...UNIT.tables] });
      const data = await this.unit.loadAll();
      object(data, ['tables', 'global'], 'STORAGE');
      object(data.tables, ['settings'], 'STORAGE');
      if (!own(data.tables, 'settings') || (data.global !== null && data.global !== undefined)) fail('STORAGE', 'Corrupt model preference unit');
      object(data.tables.settings, [RECORD], 'STORAGE');
      let next;
      if (own(data.tables.settings, RECORD)) next = state(data.tables.settings[RECORD]);
      else {
        next = { revision: 1, selection: null };
        await this.unit.putRecord('settings', RECORD, copy(next));
      }
      this.value = next;
      return this;
    } catch (error) {
      this.failure = error;
      if (this.unit) { try { await this.unit.close(); } catch { /* preserve the initialization failure */ } this.unit = null; }
      throw error;
    }
  }
  ready() {
    if (this.closed) fail('CLOSED', 'Model preferences are closed');
    if (this.failure) throw this.failure;
    if (!this.value) fail('STORAGE', 'Model preferences are not initialized');
  }
  snapshot() { this.ready(); return copy(this.value); }
  effective() {
    this.ready();
    if (this.value.selection !== null) return copy(this.value.selection);
    const current = this.getDefault();
    if (current == null) return null;
    // An unconfigured global route must not prevent opening the writing workspace.
    // The global callback can include future metadata; expose only routing fields.
    const provider = optional(current, 'provider'), model = optional(current, 'model');
    if (provider == null || model == null || (typeof provider === 'string' && !provider.trim()) || (typeof model === 'string' && !model.trim())) return null;
    const result = { provider: text(provider, 256, 'MODEL'), model: text(model, 512, 'MODEL') };
    const effort = optional(current, 'reasoningEffort');
    if (effort !== undefined) result.reasoningEffort = text(effort, 256, 'MODEL');
    return result;
  }
  async catalog(query = {}, signal) {
    this.ready();
    return this.readCatalog(query, signal);
  }
  async readCatalog(query, signal) {
    abort(signal);
    object(query, ['provider', 'model']);
    const provider = query.provider === undefined ? undefined : text(query.provider, 256);
    const model = query.model === undefined ? undefined : text(query.model, 512);
    if (model !== undefined && provider === undefined) fail('VALIDATION', 'A model catalog query requires a provider');
    if (!this.llm || typeof this.llm.listProviders !== 'function' || typeof this.llm.listModels !== 'function' || typeof this.llm.resolveModelInfo !== 'function') fail('MODEL', 'Model catalog service is unavailable');
    const advertised = this.llm.listProviders();
    if (!Array.isArray(advertised)) fail('MODEL', 'Invalid provider catalog');
    const providers = advertised.map(item => ({ id: text(field(item, 'id'), 256, 'MODEL'), name: label(field(item, 'name')) }));
    const result = { providers, models: [], details: null };
    if (provider === undefined) return result;
    if (!providers.some(item => item.id === provider)) fail('MODEL', 'Model provider is not currently registered');
    const models = await metadata(() => this.llm.listModels(provider), signal); abort(signal);
    if (!Array.isArray(models)) fail('MODEL', 'Invalid model catalog');
    result.models = models.map(item => {
      if (field(item, 'provider') !== provider) fail('MODEL', 'Model catalog provider mismatch');
      return { provider, id: text(field(item, 'id'), 512, 'MODEL'), name: label(field(item, 'name')) };
    });
    if (model === undefined) return result;
    if (!result.models.some(item => item.id === model)) fail('MODEL', 'Model is not currently advertised by this provider');
    const info = await metadata(() => this.llm.resolveModelInfo(provider, model, signal), signal); abort(signal);
    if (field(info, 'provider') !== provider || field(info, 'id') !== model) fail('MODEL', 'Model metadata route mismatch');
    const details = { provider, id: model, name: label(field(info, 'name')), efforts: [] };
    const reasoning = optional(info, 'reasoning');
    if (reasoning !== undefined) {
      const efforts = field(reasoning, 'efforts');
      if (!Array.isArray(efforts)) fail('MODEL', 'Invalid model reasoning metadata');
      details.efforts = efforts.map(item => ({ id: text(field(item, 'id'), 256, 'MODEL'), name: label(field(item, 'name')) }));
      const defaultEffort = optional(reasoning, 'defaultEffort');
      if (defaultEffort !== undefined) {
        if (!details.efforts.some(item => item.id === defaultEffort)) fail('MODEL', 'Invalid model default reasoning effort');
        details.defaultEffort = defaultEffort;
      }
    }
    result.details = details;
    return result;
  }
  async validateExplicit(route, signal) {
    const { details } = await this.readCatalog({ provider: route.provider, model: route.model }, signal);
    if (route.reasoningEffort !== undefined && !details.efforts.some(item => item.id === route.reasoningEffort)) fail('MODEL', 'Reasoning effort is not currently advertised for this model');
  }
  async save(nextSelection, expectedRevision, signal) {
    this.ready(); abort(signal);
    // Capture caller-owned input before entering the asynchronous save queue.
    const next = selection(nextSelection);
    const operation = this.chain.then(async () => {
      abort(signal);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.value.revision) fail('CONFLICT', 'Model preferences changed; reload before saving');
      if (this.value.revision === Number.MAX_SAFE_INTEGER) fail('STORAGE', 'Model preference revision exhausted');
      if (next !== null) await this.validateExplicit(next, signal);
      abort(signal);
      const committed = { revision: this.value.revision + 1, selection: next };
      await this.unit.putRecord('settings', RECORD, copy(committed));
      // A completed write is the commit boundary, even if cancellation arrived while writing.
      this.value = committed;
      return copy(committed);
    });
    this.chain = operation.catch(() => {});
    return operation;
  }
  async resolve(signal) {
    this.ready(); abort(signal);
    // Capture before any await: changes to preferences/defaults cannot rewrite a job's route.
    const explicit = this.value.selection !== null;
    let route;
    try { route = selection(this.effective(), 'MODEL'); }
    catch (error) { if (signal?.aborted) throw signal.reason; throw error; }
    if (route === null) fail('MODEL', 'No default model is configured');
    if (explicit) await this.validateExplicit(route, signal);
    abort(signal);
    if (!this.llm || typeof this.llm.resolveCallConfig !== 'function') fail('MODEL', 'Model configuration service is unavailable');
    const resolved = await metadata(() => this.llm.resolveCallConfig(copy(route), signal), signal); abort(signal);
    return callConfig(resolved, route);
  }
  close() {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        if (this.initializing) { try { await this.initializing; } catch { /* init already closed its unit */ } }
        await this.chain;
        if (this.unit) await this.unit.close();
      })();
    }
    return this.closing;
  }
}
