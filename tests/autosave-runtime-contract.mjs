// Production client controller/helpers and App closures -> real author HTTP ->
// production service -> installed Cordis + JsonStorageBackend. Clock, admission,
// state/storage/event payloads, one read-only job-completion notification, and
// model/agent tripwires are explicit fixtures. No React/DOM/browser simulation,
// live profile, paid model, or author manuscript. Optional source mutants alter
// the LOADED production source, never the assertions, and must fail this contract.
import assert from 'node:assert/strict';
import { transaction } from './continuous-edit-fixture.mjs';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
assert(process.env.DSH_INSTALL_DIR, 'Run with installed DSH Electron-as-Node');
const entries = new Map(['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-session'].map(name => [name, pathToFileURL(require.resolve(name, { paths: [process.env.DSH_INSTALL_DIR] })).href]));
registerHooks({ resolve(name, context, next) { return entries.has(name) ? { url: entries.get(name), shortCircuit: true } : next(name, context); } });
const { Context } = await import('@deepseek-ai/cordis');
const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm');
const { SessionStore } = await import('@deepseek-ai/dsh-session');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const { apply } = await import('../index.js');
const { NovelStore } = await import('../service.js');
const { createBook, mutateBook, makeProposal, buildContext } = await import('../core.js');
let clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const mutateOnce = (from, to) => { assert.equal(clientSource.split(from).length, 2, 'Exact production mutant anchor'); clientSource = clientSource.replace(from, to); };
const mutants = {
  'drop-newer-edit': () => mutateOnce('fields[key] = local[group][key];', 'fields[key] = server[key];'),
  'wrong-cas': () => mutateOnce('expectedRevision: snapshot.book.revision, operation: step.operation', 'expectedRevision: snapshot.book.revision + 1, operation: step.operation'),
  'retry-after-error': () => mutateOnce('schedule() { if (disposed || halted) return; clear(); due = false;', 'schedule() { if (disposed) return; halted = false; clear(); due = false;'),
  'auto-accept-candidate': () => mutateOnce('      return null;\n    }\n    function autosaveOperationApplied', "      if (dirty(w).candidate) return { kind: 'candidate', operation: { action: 'acceptProposal', proposalId: w.candidateId } };\n      return null;\n    }\n    function autosaveOperationApplied"),
  'drop-pending-undo-journal': () => mutateOnce('function autosaveRecoveryWorkspace(w, pending) {', 'function autosaveRecoveryWorkspace(w, pending) { return w;'),
  'force-save-from-find': () => mutateOnce("!isFindControl(e.target) && !isFindControl(e.relatedTarget) && ['INPUT', 'TEXTAREA', 'SELECT']", "['INPUT', 'TEXTAREA', 'SELECT']"),
  'regenerate-recovery-card-id': () => mutateOnce('if (!pendingCard || pendingCard.bookId !== snapshot.book.id || cardScope !== snapshot.baseCard) {', 'if (true || !pendingCard || pendingCard.bookId !== snapshot.book.id || cardScope !== snapshot.baseCard) {'),
  'discard-category-recovery': () => mutateOnce("if (p.card && Object.hasOwn(p.card, 'categoryId')) keys.push('categoryId');", ''),
  'category-changes-context-kind': () => mutateOnce('return { ...card, categoryId: category || null };', 'return { ...card, categoryId: category || null, kind: cardKinds.includes(category) ? category : card.kind };'),
  'retarget-queued-manual-action': () => mutateOnce('if (waitForAutosave) await autosaveRef.current?.wait();\n              if (!alive.current || epoch.current !== serial || current.current?.book.id !== bookId) return false;', 'if (waitForAutosave) await autosaveRef.current?.wait();\n              if (!alive.current) return false;'),
};
if (process.env.DSH_AUTOSAVE_MUTANT) { assert(mutants[process.env.DSH_AUTOSAVE_MUTANT]); mutants[process.env.DSH_AUTOSAVE_MUTANT](); }
const helperStart = clientSource.indexOf('    const equal ='), helperEnd = clientSource.indexOf('    const en =', helperStart);
assert(helperStart >= 0 && helperEnd > helperStart);
const f = new Function(clientSource.slice(helperStart, helperEnd) + '\nreturn {equal,workspace,dirty,isDirty,blankCard,cardFields,categorySaved,categoryReceipt,editCardCategory,editWritingConstraints,autosaveStep,mergeAutosaveAck,createAutosaveController,recoveryPayload,restoredWorkspace,validRecovery,conflictingFields,mergeWorkspace,textareaValue,applyTextareaEdit,autosaveRecoveryWorkspace,missingChapterDraft,autosaveRecoveryPayload,validAutosaveRecovery,restoredAutosaveWorkspace,autosaveOperationApplied,autosaveCanSave,validWritingConstraints,bookIsAvailable,applyConstraintsChanges,applyConstraintsInput,sameConstraintsDraft,constraintsHistorySnapshot,constraintsHistoryTarget};')();
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 12000); })]); } finally { clearTimeout(timer); } }
function clock() {
  let now = 0, serial = 0; const timers = new Map();
  return { setTimer(fn, delay) { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id; }, clearTimer(id) { timers.delete(id); },
    advance(ms) { const end = now + ms; let count = 0; while (true) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; assert(++count < 100, 'No retry timer loop'); now = next[1].at; timers.delete(next[0]); next[1].fn(); } now = end; }, get pending() { return timers.size; } };
}
const root = await mkdtemp(join(tmpdir(), 'inspiration-autosave-contract-'));
const allUis = [], releases = [], savedBooks = new Map(), httpRequests = [];
let active, responseLossGate = null, modelCalls = 0, agentCreates = 0, preferenceWrites = 0, jobWrites = 0, bookWrites = 0;
class NoModel extends LlmAdapter {
  listModels() { return [{ id: 'never-call', name: 'Forbidden autosave model', capabilities: [] }]; }
  async *stream() { modelCalls++; throw new Error('Autosave must never call a model'); }
}
async function activate(seed) {
  const owner = new Context(), disk = new JsonStorageBackend(root), llm = new LlmRuntime(owner), sessions = new SessionStore(owner);
  llm.registerAdapter(['autosave-local-tripwire'], new NoModel());
  const backend = { kv: { async open(spec) { const unit = await disk.kv.open(spec); return {
    loadAll: () => unit.loadAll(), close: () => unit.close(), deleteRecord: (table, key) => unit.deleteRecord(table, key),
    async putRecord(table, key, value) { await unit.putRecord(table, key, value); if (table === 'jobs') jobWrites++; if (table === 'books' && value.chapters) { bookWrites++; savedBooks.set(key, structuredClone(value)); } },
  }; } } };
  if (seed) { const store = await new NovelStore(backend).init(); await store.insert(seed); await store.close(); }
  let handler, tool;
  const peer = { id: 'isolated-autosave-author', principal: { kind: 'owner' } };
  const server = createServer((req, res) => {
    if (req.headers['x-fixture-fault'] === 'disconnect') { req.socket.destroy(); return; }
    if (req.headers['x-fixture-fault'] === 'aftercommit') {
      const gate = responseLossGate; responseLossGate = null; assert(gate, 'Explicit owned response-loss fixture');
      res.end = function(body) { const receipt = JSON.parse(String(body)); assert.equal(receipt.ok, true); gate.entered.resolve(receipt.data); void gate.release.promise.then(() => req.socket.destroy()); return res; };
    }
    if (handler) handler(req, res); else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  active = { owner, disk, sessions, server, origin };
  await apply({ effect: fn => owner.effect(fn), storage: { backend: { get: () => backend } }, llm, sessions,
    agentDefaultModel: { currentSelection: () => ({ provider: 'autosave-local-tripwire', model: 'never-call' }), saveSelection() { preferenceWrites++; throw new Error('No global model preference edits'); } },
    agentLoop: { async createAgent() { agentCreates++; throw new Error('No generation sessions from manual autosave'); } },
    connection: { browserPeer: peer, admit: req => req.headers.cookie === 'autosave-fixture=1' ? { peer } : { rejection: 401 } },
    webServer: { getOrigin: () => origin, register(route) { assert.equal(handler, undefined); handler = route.handler; return () => { handler = undefined; }; } },
    tools: { register(value) { tool = value; } },
  });
  active.execute = (action, payload = {}) => tool.execute({ action, payload }, { signal: new AbortController().signal });
}
async function deactivate() {
  if (!active) return;
  const old = active; active = undefined; await old.owner.fiber.dispose(); old.server.closeAllConnections();
  await new Promise(resolve => old.server.close(resolve)); await old.disk.close();
}
async function post(action, args = {}, fault = false) {
  const input = { action, ...args }; httpRequests.push(structuredClone(input));
  let response;
  try { response = await fetch(active.origin + '/api/ycx-inspiration', { method: 'POST', headers: {
    Origin: active.origin, Cookie: 'autosave-fixture=1', 'Content-Type': 'application/json', 'X-Inspiration-Request': '1', ...(fault ? { 'X-Fixture-Fault': fault === true ? 'disconnect' : fault } : {}),
  }, body: JSON.stringify(input) }); }
  catch (cause) { throw Object.assign(new Error('Network disconnected'), { code: 'NETWORK', cause }); }
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) throw Object.assign(new Error(payload.error?.message || 'HTTP error'), { code: payload.error?.code, status: response.status });
  return payload.data;
}
const get = book => post('get', { bookId: typeof book === 'string' ? book : book.id });
const mutate = (book, operation) => post('mutate', { bookId: book.id, expectedRevision: book.revision, operation });
async function freshBook(title) {
  let b = await post('create', { title }); b = await mutate(b, { action: 'addChapter', title: '第一章' });
  return mutate(b, { action: 'updateChapter', chapterId: b.chapters[0].id, patch: { body: '原文😀\r\n下一段', summary: '作者旧摘要' } });
}
function ui(book) {
  const c = clock(), h = { current: f.workspace(book), epoch: 0, paused: false, applied: [], errors: [], sent: [], inFlight: 0, maxInFlight: 0, nextGate: null, disconnect: false, settled: 0 };
  const controller = f.createAutosaveController({ getWorkspace: () => h.current, getEpoch: () => h.epoch, isPaused: () => h.paused,
    async send(request) {
      h.sent.push(structuredClone(request)); h.inFlight++; h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
      const gate = h.nextGate; h.nextGate = null; const fault = h.disconnect; h.disconnect = false;
      try { const result = await post('mutate', request, fault); if (gate) { gate.entered.resolve(result); await gate.release.promise; } return result; }
      finally { h.inFlight--; }
    },
    apply(next, nextBook, step) { h.current = next; h.applied.push({ book: nextBook, step }); },
    fail(error, snapshot) { h.errors.push({ error, snapshot }); }, settled() { h.settled++; }, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  Object.assign(h, { controller, clock: c,
    edit(group, field, value) { h.current = { ...h.current, [group]: { ...h.current[group], [field]: value } }; controller.schedule(); },
    constraints(rows) { h.edit('settings', 'writingConstraints', rows); },
    hold() { const gate = { entered: deferred(), release: deferred() }; releases.push(gate.release); h.nextGate = gate; return gate; },
    async finish() { c.advance(1000); await bounded(controller.wait(), 'controller drains'); },
    dispose() { controller.dispose(); },
  });
  allUis.push(h); return h;
}
// Execute the actual App action/binding closures, with explicit state-setter,
// localStorage, transport, and clock fixtures. This is NOT a renderer or DOM.
function sourceRange(start, end) {
  const a = clientSource.indexOf(start), b = clientSource.indexOf(end, a);
  assert(a >= 0 && b > a, 'Exact production callback boundaries: ' + start); return clientSource.slice(a, b);
}
function appUi(book) {
  const c = clock(), memoryDrafts = new Map(), storage = new Map(), current = { current: f.workspace(book) }, epoch = { current: 0 };
  const autosaveRef = { current: null }, autosaveBindings = { current: null }, pendingLatest = { current: null };
  const constraintsHistory = {current:new WeakMap()}, pendingConstraintsStructure = {current:null}, constraintsEngine = {current:null}; let viewVersion = {};
  const h = { currentRef: current, epochRef: epoch, autosaveRef, bindings: autosaveBindings, pendingLatest, clock: c,
    flags: { loading: false, manager: null, guard: null, confirm: null, polishRequirements: null },
    alive: { current: true }, busyRef: { current: false }, recoveryRef: { current: null }, composing: { current: false },
    errors: [], sent: [], applied: [], downloads: [], inFlight: 0, maxInFlight: 0, nextGate: null, conflict: null, memoryDrafts, storage,
    hold() { const gate = { entered: deferred(), release: deferred() }; releases.push(gate.release); h.nextGate = gate; return gate; },
    loseResponse() { assert.equal(responseLossGate, null); const gate = { entered: deferred(), release: deferred() }; releases.push(gate.release); responseLossGate = gate; h.faultNext = 'aftercommit'; return gate; },
    dispose() { autosaveRef.current.dispose(); h.alive.current = false; },
    recovery() { const raw = storage.get('ycx-moxu:draft:v1:' + current.current.book.id); return raw ? JSON.parse(raw) : null; },
    async finish() { c.advance(1000); await bounded(autosaveRef.current.wait(), 'App controller drains'); },
  };
  h.pollJob = { id: randomUUID(), bookId: book.id, chapterId: book.chapters[0]?.id, proposalId: book.proposals[0]?.id, status: 'completed' }; h.pollReads = 0;
  const env = { ...f, current, epoch, autosaveRef, autosaveBindings, pendingLatest, memoryDrafts, constraintsHistory, pendingConstraintsStructure, constraintsEngine, STORAGE: 'ycx-moxu:draft:v1:',
    job: h.pollJob, availabilityEpoch: { current: 0 }, setJob() {}, setPollError() {}, rememberJob() {}, setTimeout: c.setTimer, clearTimeout: c.clearTimer,
    alive: h.alive, busyRef: h.busyRef, recoveryRef: h.recoveryRef, autosaveComposing: h.composing,
    deletedBookIds: new Set(), unavailableBooks: { current: new Map() },
    get loading() { return h.flags.loading; }, get conflict() { return h.conflict; }, get manager() { return h.flags.manager; },
    get guard() { return h.flags.guard; }, get confirm() { return h.flags.confirm; }, get polishRequirements() { return h.flags.polishRequirements; },
    localStorage: { setItem(key, value) { storage.set(key, value); }, getItem: key => storage.get(key) || null, removeItem(key) { storage.delete(key); } },
    t: key => key, commit(next) { current.current = next; h.applied.push(next); },
    categoryFocusReturn: { current: false }, setCardFilter(value) { h.cardCategoryFilter = value; },
    setCategoryForm(value) { h.categoryForm = typeof value === 'function' ? value(h.categoryForm) : value; },
    setConflict(value) { h.conflict = value; }, setGuard(value) { h.flags.guard = value; }, setBusy() {}, setNotice() {},
    setError(value) { if (value) h.errors.push(value); }, setContext() {}, setStorageFailed() {}, syncBookList() {}, resetSelection() {}, invalidateReviewReturn() {}, setConstraintsLimit() {},
    assignRecovery(value) { h.recoveryRef.current = value; }, download(filename, mime, text) { h.downloads.push({ filename, mime, value: JSON.parse(text) }); },
    messageError(error) { if (h.alive.current && error?.name !== 'AbortError') h.errors.push(error); },
    createAutosaveController: options => f.createAutosaveController({ ...options, setTimer: c.setTimer, clearTimer: c.clearTimer }),
    async call(action, args) {
      // Read-only completed-job notification fixture; its subsequent get is real
      // HTTP. No job is generated or written just to trigger the actual poll.
      if (action === 'job') { h.pollReads++; return structuredClone(h.pollJob); }
      if (action !== 'mutate') return post(action, args);
      h.sent.push(structuredClone(args)); h.inFlight++; h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
      const gate = h.nextGate; h.nextGate = null; const fault = h.faultNext; h.faultNext = null;
      try { const result = await post(action, args, fault); if (gate) { gate.entered.resolve(result); await gate.release.promise; } return result; }
      finally { h.inFlight--; }
    },
  };
  const actions = sourceRange('          const forgetDraft =', '          const rememberJob =') +
    sourceRange('          const adopt =', '          const discardScope =') +
    sourceRange('          const transition =', '          const changeChapter =') +
    sourceRange('          const downloadLocal =', '          const closeSelectionPopup =') +
    sourceRange('          const restoreRecovery =', '          const chooseCandidate =') +
    sourceRange('          const changeCardCategory =', '          const closeCard =') +
    sourceRange('            const controller = new AbortController(), id = job.id, bookId = job.bookId, serial = availabilityEpoch.current;', '            poll();') +
    sourceRange('            const leave =', '            window.addEventListener');
  h.app = new Function('env', 'with (env) { ' + actions + '\nreturn {persist,readRecovery,adopt,loadLatest,withBusy,mutateRaw,saveAll,transition,changeField,changeWritingConstraint,changeConstraintsMarkdown,downloadLocal,restoreRecovery,changeCardCategory,createCardCategory,poll,leave,pagehide}; }')(env);
  constraintsEngine.current = {bookId:book.id,instance:{applyStructure({text,payload}) {
    const update=transaction(current.current.constraintsEditor.text,text,{beforeVersion:viewVersion,origin:'input.structure',payload});
    if(!h.app.changeConstraintsMarkdown(book.id,update))return false; viewVersion=update.version; return true;
  }}};
  h.events = new Function('env', 'with(env) { ' + sourceRange('    const isFindControl =', '    function findShortcut(') +
    'return { ' + sourceRange('            onCompositionStartCapture:', '            onKeyDown:') + ' }; }')(env);
  const retryProperty = clientSource.match(/toolbarButton\('save', t\('autosaveRetry'\), saveAll, \{ title: t\('autosavePaused'\), disabled: ([^}]+) \}\)/); assert(retryProperty);
  h.retryDisabled = () => new Function('env', 'with(env) { return (' + retryProperty[1] + '); }')({ ...f, locked: h.busyRef.current || h.flags.loading, w: h.current, anyDirty: f.isDirty(h.current), autosaveRef, conflict: h.conflict });
  Object.defineProperties(h, { controller: { get: () => autosaveRef.current }, current: { get: () => current.current, set: value => { current.current = value; } } });
  allUis.push(h); return h;
}
const row = (content, enabled = true) => ({ id: randomUUID(), category: '自定义条件😀', content, enabled });
try {
  // Seed a real durable ready AI summary without any model call; only this fixture
  // directly uses the domain/store. Every tested autosave is admitted author HTTP.
  let seed = mutateBook(createBook('隔离自动保存合同'), { action: 'addChapter', title: '摘要边界' });
  seed = mutateBook(seed, { action: 'updateChapter', chapterId: seed.chapters[0].id, patch: { body: '原稿，不接受AI候选。', summary: '作者旧摘要' } });
  const options = { mode: 'summary', instruction: '', selection: null };
  seed = mutateBook(seed, { action: 'addProposal', proposal: makeProposal(seed, seed.chapters[0].id, options, 'AI候选不能自动接受_7e42', buildContext(seed, seed.chapters[0].id, options)) });
  await activate(seed);
  const initialPreferences = (await post('list')).modelSettings;
  {
    const initial = await freshBook('isolated author outline and full draft context'), chapterId = initial.chapters[0].id;
    const book = await mutate(initial, { action: 'updateChapter', chapterId, patch: { outline: '第一幕\r\n' } });
    const h = appUi(book), tail = '后半段转折😀' + ' 甲'.repeat(1800) + ' 末尾🧭  ';
    h.app.changeField('chapter', 'outline', '第一幕\n' + tail);
    await h.finish();
    const saved = await get(book), exact = '第一幕\r\n' + tail;
    assert.equal(saved.chapters[0].outline, exact);
    assert.equal(saved.chapters[0].body, book.chapters[0].body);
    assert.deepEqual(saved.chapters[0].history, book.chapters[0].history);
    assert.deepEqual(h.sent[0].operation, { action: 'updateChapter', chapterId, patch: { outline: exact } });
    const request = { bookId: book.id, chapterId, mode: 'draft' };
    const preview = await post('context', request);
    const block = preview.prompt.split('【本章细纲（完整；严格遵循的创作计划）】\n')[1]?.split('\n\n')[0];
    assert.deepEqual(JSON.parse(block), { text: exact });
    assert.equal(preview.report.included.filter(item => item.label === '本章细纲（完整；严格遵循的创作计划）').length, 1);
    const small = await mutate(saved, { action: 'updateBook', patch: { contextBudget: 1000 } });
    await assert.rejects(post('generate', { ...request, expectedRevision: small.revision }), { code: 'CONTEXT_BUDGET' });
    assert.equal(modelCalls, 0, 'An over-budget outline stops before the model');
    h.dispose();
  }
  {
    const book = await freshBook('find must not force save or pause normal autosave');
    const h = appUi(book);
    const search = { tagName: 'INPUT', closest: selector => selector.includes('.mx-find-bar') ? search : null };
    const editor = { tagName: 'TEXTAREA' };
    h.app.changeField('chapter', 'body', '作者保留的未保存查找文本');
    h.events.onBlurCapture({ target: editor, relatedTarget: search });
    h.events.onBlurCapture({ target: search, relatedTarget: editor });
    h.events.onCompositionStartCapture({ target: search });
    assert.equal(h.composing.current, false);
    h.events.onCompositionEndCapture({ target: search });
    await h.controller.wait();
    assert.equal(h.sent.length, 0, 'Focus and IME in the search bar cannot force an HTTP save');
    await h.finish();
    assert.equal(h.sent.length, 1, 'The already-scheduled author edit still autosaves normally');
    assert.equal((await get(book)).chapters[0].body, '作者保留的未保存查找文本');
    h.dispose();
  }
  {
    const h = ui(await get(seed)); const originalProposal = structuredClone(seed.proposals[0]);
    h.current = { ...h.current, candidate: '作者尚未确认的候选编辑_41ba' };
    h.edit('chapter', 'summary', '作者亲自输入的新摘要😀'); await h.finish();
    const saved = await get(seed);
    assert.equal(saved.chapters[0].summary, '作者亲自输入的新摘要😀', 'Manual summary is autosaved, not excluded as if AI output');
    assert.deepEqual(saved.proposals[0], originalProposal, 'Ready AI summary and candidate editor are never autosaved/accepted');
    assert.equal(saved.chapters[0].body, seed.chapters[0].body); assert.equal(saved.chapters[0].summaryRevision, saved.chapters[0].revision);
    assert.equal(h.current.candidate, '作者尚未确认的候选编辑_41ba'); assert.equal(h.sent.length, 1); assert.equal(h.errors.length, 0); h.dispose();
  }
  {
    const b = await freshBook('去抖及慢ACK新输入'), h = ui(b), gate = h.hold();
    h.edit('chapter', 'body', '第一遍输入'); h.clock.advance(999); assert.equal(h.sent.length, 0);
    h.edit('chapter', 'body', '发出的版本A😀\r\n保持文本'); h.clock.advance(999); assert.equal(h.sent.length, 0);
    h.clock.advance(1); const acknowledged = await bounded(gate.entered.promise, 'real HTTP committed A');
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].expectedRevision, b.revision);
    h.edit('chapter', 'body', '等待期间继续输入B😀\r\n必须保留');
    assert.equal((await get(b)).chapters[0].body, '发出的版本A😀\r\n保持文本');
    gate.release.resolve(); await bounded(h.controller.wait(), 'old ACK');
    assert.equal(h.current.chapter.body, '等待期间继续输入B😀\r\n必须保留', 'Old ACK must not erase newer keystrokes');
    assert.equal(h.current.baseChapter.body, acknowledged.chapters[0].body);
    await h.finish(); const saved = await get(b); assert.equal(saved.chapters[0].body, h.current.chapter.body);
    assert.equal(h.sent.length, 2); assert.equal(h.sent[1].expectedRevision, acknowledged.revision); assert.equal(h.maxInFlight, 1); assert.equal(h.errors.length, 0); assert.equal(f.isDirty(h.current), false); h.dispose();
  }
  {
    const b = await freshBook('慢ACK期间撤销到旧基线'), h = ui(b), gate = h.hold();
    h.edit('chapter', 'body', '暂时改为A'); const pending = h.controller.flush();
    await bounded(gate.entered.promise, 'undo first commit'); h.edit('chapter', 'body', b.chapters[0].body);
    assert.equal(f.dirty(h.current).chapter, false, 'Critical undo appears clean against OLD baseline');
    gate.release.resolve(); await bounded(pending, 'undo ACK');
    assert.equal(h.current.chapter.body, b.chapters[0].body, 'Undo to old baseline is newer intent, not permission to adopt A');
    assert.equal(h.current.baseChapter.body, '暂时改为A'); assert.equal(f.dirty(h.current).chapter, true);
    await h.finish(); assert.equal((await get(b)).chapters[0].body, b.chapters[0].body); assert.equal(h.sent.length, 2); h.dispose();
  }
  {
    const b = await freshBook('有效字段与无效草稿独立'), h = ui(b), valid = row('完整条件\r\n😀尾部');
    h.edit('chapter', 'title', '   '); h.edit('chapter', 'body', '仍可保存的正文'); h.edit('settings', 'title', '');
    h.edit('settings', 'contextBudget', 'NaN'); h.edit('settings', 'premise', '有效前提');
    h.constraints([{ ...valid, content: '' }]); h.current = { ...h.current, card: f.blankCard(), baseCard: f.blankCard() };
    const writes = bookWrites; await h.finish(); let saved = await get(b);
    assert.equal(saved.chapters[0].body, '仍可保存的正文'); assert.equal(saved.premise, '有效前提');
    assert.equal(saved.title, b.title); assert.equal(saved.contextBudget, b.contextBudget); assert.deepEqual(saved.writingConstraints, []); assert.equal(saved.cards.length, 0);
    assert.equal(h.sent.length, 2); assert.equal(bookWrites - writes, 2); assert.equal(h.errors.length, 0, 'Invalid drafts pause locally without error flood');
    assert.equal(h.current.chapter.title, '   '); assert.equal(h.current.settings.contextBudget, 'NaN'); assert.equal(h.current.settings.writingConstraints[0].content, '');
    const failedDraftWrites = bookWrites; for (let i = 0; i < 4; i++) { h.controller.schedule(); await h.finish(); }
    assert.equal(bookWrites, failedDraftWrites, 'No canonical writes for remaining invalid-only drafts'); assert.equal(h.errors.length, 0);
    h.constraints([valid, row('停用也须完整持久保存', false)]); await h.finish(); saved = await get(b);
    assert.deepEqual(saved.writingConstraints, h.current.settings.writingConstraints); assert.equal(h.current.settings.title, ''); h.dispose();
  }
  {
    const b = await freshBook('跨窗口CAS冲突'), h = ui(b);
    h.edit('chapter', 'body', '本地待保存草稿'); const external = await mutate(b, { action: 'updateChapter', chapterId: b.chapters[0].id, patch: { body: '另一窗口已保存' } });
    await bounded(h.controller.flush(), 'real stale CAS');
    assert.equal(h.errors.length, 1); assert.equal(h.errors[0].error.status, 409); assert.equal(h.errors[0].error.code, 'CONFLICT'); assert.equal(h.controller.failed, true);
    assert.equal(h.current.chapter.body, '本地待保存草稿'); assert.equal(h.current.book.revision, b.revision); assert.deepEqual(await get(b), external);
    h.edit('chapter', 'body', '冲突之后仍可继续本地输入'); for (let i = 0; i < 4; i++) { await h.finish(); await h.controller.flush(); }
    assert.equal(h.sent.length, 1, 'No silent CAS refresh or retries after conflict'); assert.equal(h.errors.length, 1); assert.equal((await get(b)).chapters[0].body, '另一窗口已保存'); h.dispose();
  }
  {
    const b = await freshBook('断网不重试与显式重试'), h = ui(b); h.disconnect = true;
    h.edit('chapter', 'body', '断网前的草稿'); await h.finish(); assert.equal(h.errors.length, 1); assert.equal(h.errors[0].error.code, 'NETWORK');
    assert.equal(h.controller.failed, true); assert.deepEqual(await get(b), b, 'A disconnected request before admission cannot mutate canon');
    h.edit('chapter', 'body', '错误之后继续编辑仍留在本地'); await h.finish(); await h.controller.flush(); h.clock.advance(20000);
    assert.equal(h.sent.length, 1); assert.equal(h.errors.length, 1); assert.equal(h.current.chapter.body, '错误之后继续编辑仍留在本地');
    await bounded(h.controller.flush({ retry: true }), 'explicit author retry'); assert.equal(h.sent.length, 2); assert.equal(h.controller.failed, false);
    assert.equal((await get(b)).chapters[0].body, '错误之后继续编辑仍留在本地'); h.dispose();
  }
  {
    const b = await freshBook('新卡ACK保持编辑器且不重复'), h = ui(b), blank = f.blankCard();
    h.current = { ...h.current, card: { ...blank, title: '新卡A', content: '初稿' }, baseCard: blank };
    const gate = h.hold(), pending = h.controller.flush(), saved = await bounded(gate.entered.promise, 'new card created');
    const id = saved.cards[0].id; h.edit('card', 'content', 'ACK等待中的新内容😀');
    gate.release.resolve(); await bounded(pending, 'new card ACK'); assert.equal(h.current.card.id, id); assert.equal(h.current.card.content, 'ACK等待中的新内容😀');
    await h.finish(); const final = await get(b); assert.equal(final.cards.length, 1); assert.equal(final.cards[0].id, id); assert.equal(final.cards[0].content, 'ACK等待中的新内容😀');
    assert.equal(h.sent.length, 2); assert.equal(h.sent[1].operation.card.id, id); assert.equal(h.maxInFlight, 1); h.dispose();
  }
  {
    let b = await freshBook('新卡ACK不能绑定另一个编辑器'); b = await mutate(b, { action: 'saveCard', card: { title: '原有卡', content: '原有内容' } });
    const h = ui(b), blank = f.blankCard(); h.current = { ...h.current, card: { ...blank, title: '刚创建的新卡' }, baseCard: blank };
    const gate = h.hold(), pending = h.controller.flush(); await bounded(gate.entered.promise, 'other card committed');
    const existing = f.cardFields(b.cards[0]); h.current = { ...h.current, card: existing, baseCard: existing };
    gate.release.resolve(); await bounded(pending, 'different editor ACK'); assert.equal(h.current.card.id, b.cards[0].id); assert.equal(h.current.card.title, '原有卡'); assert.equal((await get(b)).cards.length, 2); h.dispose();
  }
  {
    const b = await freshBook('暂停和销毁防迟到ACK'), other = await freshBook('不能重定向到这里'), h = ui(b);
    h.paused = true; h.edit('chapter', 'body', '暂停时输入'); await h.finish(); await h.controller.flush(); assert.equal(h.sent.length, 0);
    h.paused = false; const gate = h.hold(), pending = h.controller.flush(); await bounded(gate.entered.promise, 'old book committed');
    h.epoch++; h.current = f.workspace(other); h.controller.cancel(); gate.release.resolve(); await bounded(pending, 'cancelled epoch ACK');
    assert.equal(h.applied.length, 0); assert.equal(h.errors.length, 0); assert.equal(h.current.book.id, other.id); assert.deepEqual(await get(other), other);
    h.edit('chapter', 'body', '销毁前未发送'); h.dispose(); await h.finish(); assert.equal(h.sent.length, 1); assert.deepEqual(await get(other), other);
  }
  {
    const b = await freshBook('卸载后ACK不修改当前状态'), h = ui(b), gate = h.hold();
    h.edit('chapter', 'body', '卸载前已发送'); const pending = h.controller.flush(); await bounded(gate.entered.promise, 'dispose commit');
    const local = h.current; h.dispose(); gate.release.resolve(); await bounded(pending, 'disposed ACK'); assert.equal(h.current, local); assert.equal(h.applied.length, 0); assert.equal(h.errors.length, 0);
  }
  {
    const b = await freshBook('实际App输入及轮询处理'), h = appUi(b), gate = h.hold();
    h.app.changeField('chapter', 'body', 'App发出A'); const pending = h.controller.flush();
    const committed = await bounded(gate.entered.promise, 'App first HTTP commit');
    assert.equal(h.busyRef.current, false, 'Autosave does not lock author inputs');
    h.app.changeField('chapter', 'body', 'App等待期间输入B'); await h.app.loadLatest();
    assert.equal(h.current.book.revision, b.revision, 'Own in-flight poll is queued, never adopted against the old draft baseline');
    assert.equal(h.pendingLatest.current.revision, committed.revision); assert.equal(h.conflict, null);
    h.pendingLatest.current = null; await h.app.poll(); assert.equal(h.pollReads, 1);
    assert.equal(h.current.book.revision, b.revision, 'Actual job-poll completion also queues own in-flight save instead of falsely conflicting');
    assert.equal(h.pendingLatest.current.revision, committed.revision); assert.equal(h.conflict, null);
    gate.release.resolve(); await bounded(pending, 'App own ACK reconciles queued poll');
    assert.equal(h.current.chapter.body, 'App等待期间输入B'); assert.equal(h.conflict, null); assert.equal(h.pendingLatest.current, null);
    await h.finish(); assert.equal((await get(b)).chapters[0].body, 'App等待期间输入B'); assert.equal(h.recovery(), null);
    h.app.changeWritingConstraint(b.id, { type: 'add', category: '临时分类', content: '临时条件' }); const rule = h.current.settings.writingConstraints[0];
    await h.finish(); assert.deepEqual((await get(b)).writingConstraints, [rule], 'Actual visual add callback saves its valid editable placeholder');
    h.app.changeWritingConstraint(b.id, { type: 'edit', id: rule.id, field: 'category', value: '特殊风格' });
    h.app.changeWritingConstraint(b.id, { type: 'edit', id: rule.id, field: 'content', value: '实际回调写入😀\r\n完整条件' });
    await h.finish(); assert.deepEqual((await get(b)).writingConstraints, h.current.settings.writingConstraints); assert.equal(h.errors.length, 0); h.dispose();
  }
  {
    const b = await freshBook('实际App显式写入串行'), h = appUi(b), gate = h.hold();
    h.app.changeField('chapter', 'body', '自动正文'); const pending = h.controller.flush();
    const committed = await bounded(gate.entered.promise, 'App serialized first commit'); let manualRan = false;
    const manual = h.app.withBusy(async () => { manualRan = true; await h.app.mutateRaw({ action: 'updateBook', patch: { premise: '显式操作' } }, 'settings'); });
    assert.equal(h.busyRef.current, true); assert.equal(manualRan, false); assert.equal(h.sent.length, 1);
    gate.release.resolve(); await bounded(Promise.all([pending, manual]), 'manual operation follows autosave ACK');
    assert.equal(manualRan, true); assert.equal(h.sent[1].expectedRevision, committed.revision); assert.equal(h.maxInFlight, 1); assert.equal(h.errors.length, 0);
    assert.equal((await get(b)).premise, '显式操作'); h.dispose();
  }
  {
    const b = await freshBook('实际App暂停与导航'), h = appUi(b);
    h.app.changeField('chapter', 'body', '暂存正文');
    for (const key of ['guard', 'confirm', 'polishRequirements', 'loading']) {
      h.flags[key] = true; await h.finish(); await h.controller.flush(); assert.equal(h.sent.length, 0, key + ' pauses actual App binding'); h.flags[key] = false;
    }
    h.recoveryRef.current = { pendingAuthorReview: true }; await h.controller.flush(); assert.equal(h.sent.length, 0); h.recoveryRef.current = null;
    h.events.onCompositionStartCapture(); h.events.onBlurCapture({ target: { tagName: 'TEXTAREA' } }); await h.controller.wait(); assert.equal(h.sent.length, 0, 'Actual composition event handler pauses even an actual blur flush');
    const markdown = { target: { closest: selector => selector === '.mx-constraints-editor-host' } };
    h.events.onCompositionEndCapture(markdown); assert.equal(h.composing.current,true,'React capture cannot preempt the Markdown engine composition release');
    assert.equal(await h.app.saveAll(),false,'A busy operation cannot start while final composition input is pending');
    let changedTab=false; await h.app.transition(()=>{changedTab=true;});assert.equal(changedTab,false);
    h.flags.manager = { snapshot: { bookId: b.id } };
    h.events.onCompositionEndCapture(); h.events.onBlurCapture({ target: { tagName: 'TEXTAREA' } }); await h.controller.wait();
    assert.equal(h.sent.length, 1, 'Management is a page, not an autosave-pausing modal; blur flushes immediately');
    assert.equal((await get(b)).chapters[0].body, '暂存正文'); h.flags.manager = null;
    h.app.changeField('chapter', 'body', '暂存正文追加'); let navigated = 0; await h.app.transition(() => { navigated++; }); assert.equal(navigated, 1); assert.equal((await get(b)).chapters[0].body, '暂存正文追加'); assert.equal(h.flags.guard, false);
    h.app.changeField('chapter', 'title', ''); await h.app.transition(() => { navigated++; }); assert.equal(navigated, 1, 'Invalid draft blocks navigation without discarding it'); assert(h.flags.guard);
    assert.equal(h.current.chapter.title, ''); h.dispose();
  }
  {
    const b = await freshBook('真实崩溃窗口保留撤销'), h = appUi(b), original = b.chapters[0].body, gate = h.hold();
    h.app.changeField('chapter', 'body', f.textareaValue(original) + '暂时附加A'); const pending = h.controller.flush();
    const committed = await bounded(gate.entered.promise, 'crash window server A committed');
    h.app.changeField('chapter', 'body', f.textareaValue(original)); assert.equal(h.current.chapter.body, original); assert.equal(f.isDirty(h.current), false);
    assert.equal(h.current.baseChapter.body, original, 'Recovery journal must never optimistically advance visible AI guard baseline');
    let warned = 0; const event = { preventDefault() { warned++; }, returnValue: undefined }; h.app.leave(event);
    assert.equal(warned, 1, 'Actual beforeunload warns for pending undo even when visible draft is clean'); assert.equal(event.returnValue, '');
    h.app.pagehide(); const journal = h.recovery(); assert(journal); assert.equal(f.validAutosaveRecovery(journal, b.id), true);
    assert.equal(journal.chapter.body, original, 'Recovery journal must retain clean-looking undo instead of the older sent draft'); assert.equal(journal.baseChapter.body, committed.chapters[0].body); assert.equal(journal.dirty.chapter, true);
    h.app.downloadLocal(); assert.equal(h.downloads.length, 1, 'Actual download callback exports clean-looking pending undo'); assert(Date.parse(h.downloads[0].value.savedAt) >= Date.parse(journal.savedAt)); assert.deepEqual({ ...h.downloads[0].value, savedAt: undefined }, { ...journal, savedAt: undefined });
    assert.equal(f.autosaveCanSave(h.current, h.controller), true, 'Manual retry/backup eligibility sees pending undo');
    h.dispose(); gate.release.resolve(); await bounded(pending, 'abandoned ACK after crash snapshot');
    await deactivate(); await activate(); const reopened = await get(b); assert.equal(reopened.chapters[0].body, committed.chapters[0].body);
    const restored = appUi(reopened); restored.recoveryRef.current = journal; restored.app.restoreRecovery();
    assert.equal(restored.current.chapter.body, original); assert.equal(restored.conflict, null); assert.equal(restored.recoveryRef.current, null);
    await restored.controller.flush(); assert.equal((await get(b)).chapters[0].body, original, 'Restore after real JSON reopen recovers undo, not committed A'); restored.dispose();
  }
  {
    const b = await freshBook('真实ACK断连后的干净撤销重试'), h = appUi(b), original = b.chapters[0].body, gate = h.loseResponse();
    h.app.changeField('chapter', 'body', f.textareaValue(original) + 'A待撤销'); const pending = h.controller.flush();
    const committed = await bounded(gate.entered.promise, 'server committed before real TCP response loss');
    h.app.changeField('chapter', 'body', f.textareaValue(original)); assert.equal(f.isDirty(h.current), false);
    gate.release.resolve(); await bounded(pending, 'real after-commit TCP loss delivered');
    assert.equal(h.controller.failed, true); assert.equal(h.errors.length, 1); assert.equal(h.errors[0].code, 'NETWORK'); assert.equal(h.current.chapter.body, original);
    assert.equal(h.recovery().baseChapter.body, committed.chapters[0].body); assert.equal(h.recovery().chapter.body, original);
    h.app.pagehide(); h.app.downloadLocal(); assert.equal(h.downloads[0].value.chapter.body, original); assert.equal(h.downloads[0].value.baseChapter.body, committed.chapters[0].body);
    assert.equal(f.autosaveCanSave(h.current, h.controller), true, 'Clean-looking failed undo must retain manual retry eligibility');
    assert.equal(h.retryDisabled(), false, 'Actual error-retry button disabled expression remains false for failed clean-looking undo');
    let navigated = false, aiRan = false, cancelRan = false;
    await h.app.transition(() => { navigated = true; }); assert.equal(navigated, false); assert(h.flags.guard); h.flags.guard = null;
    await h.app.withBusy(async () => { aiRan = true; }); assert.equal(aiRan, false, 'Generic/AI action must not run behind an ambiguous failed autosave');
    await h.app.withBusy(async () => { cancelRan = true; }, false); assert.equal(cancelRan, true, 'Cancellation remains allowed despite autosave failure');
    assert.equal(h.sent.length, 1, 'Failure latches until explicit retry; backup/navigation cannot retry');
    assert.equal(await h.app.saveAll(), true, 'Actual manual retry first disambiguates canonical commit then saves newer undo');
    assert.equal(h.sent.length, 2); assert.equal(h.sent[1].expectedRevision, committed.revision); assert.equal((await get(b)).chapters[0].body, original);
    assert.equal(h.controller.failed, false); assert.equal(h.recovery(), null); h.dispose();
  }
  {
    const b = await freshBook('在途自动保存不延迟取消'), h = appUi(b), gate = h.hold();
    h.app.changeField('chapter', 'body', '正在等待写入ACK'); const pending = h.controller.flush(); await bounded(gate.entered.promise, 'cancel while ACK held');
    let cancelled = false; await bounded(h.app.withBusy(async () => { cancelled = true; }, false), 'cancel bypasses slow autosave');
    assert.equal(cancelled, true); assert.equal(h.controller.running, true); gate.release.resolve(); await pending; h.dispose();
  }
  {
    let b = await freshBook('新卡丢失ACK后精确身份恢复'), blank = f.blankCard();
    const fields = { kind: blank.kind, title: '完全同内容卡片', content: '同样的内容😀', status: blank.status, pinned: blank.pinned, fromChapter: 1, toChapter: null, tags: [] };
    b = await mutate(b, { action: 'saveCard', card: fields }); const unrelatedId = b.cards[0].id;
    const h = appUi(b); h.current = { ...h.current, card: { ...blank, title: fields.title, content: fields.content }, baseCard: blank };
    const gate = h.loseResponse(), pending = h.controller.flush(), committed = await bounded(gate.entered.promise, 'stable UUID card created before ACK loss');
    const id = h.controller.pendingCard.id; assert.notEqual(id, unrelatedId); assert.equal(h.sent[0].operation.action, 'createCard'); assert.equal(h.sent[0].operation.card.id, id);
    assert.equal(committed.cards.length, 2); assert(committed.cards.some(card => card.id === id));
    assert.equal(h.recovery().pendingCard.id, id, 'Actual started hook journals exact create identity BEFORE transport resolves');
    h.app.changeField('card', 'content', '丢失ACK期间的继续编辑😀'); gate.release.resolve(); await bounded(pending, 'card TCP loss delivered');
    assert.equal(h.controller.failed, true); h.app.pagehide(); const journal = h.recovery(); assert.equal(f.validAutosaveRecovery(journal, b.id), true);
    assert.equal(journal.pendingCard.id, id); assert.equal(journal.pendingCard.card.content, fields.content); assert.equal(journal.card.content, '丢失ACK期间的继续编辑😀');
    h.dispose(); await deactivate(); await activate(); const reopened = await get(b); assert.equal(reopened.cards.length, 2);
    const restored = appUi(reopened); restored.recoveryRef.current = journal; restored.app.restoreRecovery();
    assert.equal(restored.current.card.id, id, 'Only exact caller UUID binds; identical unrelated content is never evidence'); assert.equal(restored.conflict, null);
    await restored.controller.flush(); const final = await get(b); assert.equal(final.cards.length, 2); assert.equal(final.cards.find(card => card.id === unrelatedId).content, fields.content);
    assert.equal(final.cards.find(card => card.id === id).content, '丢失ACK期间的继续编辑😀'); assert.equal(restored.sent[0].operation.action, 'saveCard'); assert.equal(restored.sent[0].operation.card.id, id);
    restored.dispose();
    const externallyChanged = await mutate(final, { action: 'saveCard', card: { id, content: '另一个窗口修改了同一ID' } });
    const conflicted = appUi(externallyChanged); conflicted.recoveryRef.current = journal; conflicted.app.restoreRecovery();
    assert.equal(conflicted.current.card.id, id); assert(conflicted.conflict.fields.includes('card'), 'Exact-ID binding still checks the sent baseline against an external card edit');
    await conflicted.controller.flush(); assert.equal(conflicted.sent.length, 0); assert.equal((await get(b)).cards.find(card => card.id === id).content, '另一个窗口修改了同一ID'); conflicted.dispose();
  }
  {
    const b = await freshBook('未到服务器的新卡恢复重用ID'), h = appUi(b), blank = f.blankCard();
    h.current = { ...h.current, card: { ...blank, title: '断连前的新卡', content: '完整草稿' }, baseCard: blank }; h.faultNext = true;
    await h.controller.flush(); assert.equal(h.controller.failed, true); const journal = h.recovery(), id = journal.pendingCard.id;
    assert.equal(f.validAutosaveRecovery(journal, b.id), true); assert.equal(h.sent[0].operation.card.id, id); assert.deepEqual(await get(b), b);
    h.dispose(); await deactivate(); await activate(); const restored = appUi(await get(b)); restored.recoveryRef.current = journal; restored.app.restoreRecovery();
    assert.equal(restored.current.card.id, undefined); assert.equal(restored.controller.pendingCard.id, id); assert.equal(restored.conflict, null);
    assert.equal(await restored.app.saveAll(), true); assert.equal(restored.sent[0].operation.action, 'createCard'); assert.equal(restored.sent[0].operation.card.id, id, 'Restart retry must reuse the journal UUID, never mint another identity');
    assert.equal((await get(b)).cards.length, 1); assert.equal((await get(b)).cards[0].id, id); restored.dispose();
  }
  {
    const b = await freshBook('显式操作等待期间切换epoch'), other = await freshBook('不可被迟到显式操作修改'), h = appUi(b), gate = h.hold();
    h.app.changeField('chapter', 'body', '旧本已发送'); const pending = h.controller.flush(); await bounded(gate.entered.promise, 'manual stale epoch commit');
    let actionRan = false; const queued = h.app.withBusy(async () => { actionRan = true; await h.app.mutateRaw({ action: 'updateBook', patch: { title: '不应写到新书' } }); });
    h.epochRef.current++; h.current = f.workspace(other); h.controller.cancel(); gate.release.resolve(); await bounded(Promise.all([pending, queued]), 'stale explicit action settles');
    assert.equal(actionRan, false, 'Queued explicit action checks epoch/book after waiting and cannot recapture another book'); assert.equal(h.sent.length, 1); assert.deepEqual(await get(other), other); h.dispose();
  }
  {
    const b = await get(seed), h = appUi(b); h.current = { ...h.current, candidate: '作者明确点击手动保存候选' };
    assert.equal(await h.app.saveAll(), true, 'Explicit candidate edit save remains available'); const saved = await get(b);
    assert.equal(saved.proposals[0].text, '作者明确点击手动保存候选'); assert.equal(saved.proposals[0].state, 'ready');
    assert.equal(saved.chapters[0].body, b.chapters[0].body); assert.equal(saved.chapters[0].summary, b.chapters[0].summary); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].operation.action, 'updateProposal'); h.dispose();
  }
  {
    const b = await freshBook('条件排序停用在慢ACK中不丢失'), h = appUi(b), first = row('第一条完整内容😀'), second = row('第二条停用内容', false);
    h.current = { ...h.current, settings: { ...h.current.settings, writingConstraints: [first, second] } };
    const gate = h.hold(), pending = h.controller.flush(); await bounded(gate.entered.promise, 'conditions first ACK held');
    h.app.changeWritingConstraint(b.id, { type: 'move', id: second.id, direction: -1 });
    h.app.changeWritingConstraint(b.id, { type: 'edit', id: first.id, field: 'content', value: '后续编辑😀\r\n完整文本' });
    h.app.changeWritingConstraint(b.id, { type: 'edit', id: first.id, field: 'enabled', value: false });
    const desired = structuredClone(h.current.settings.writingConstraints); gate.release.resolve(); await pending;
    assert.deepEqual(h.current.settings.writingConstraints, desired); assert.deepEqual(h.current.baseSettings.writingConstraints, [first, second]);
    await h.finish(); assert.deepEqual((await get(b)).writingConstraints, desired); assert.equal(h.sent.length, 2); assert.equal(h.maxInFlight, 1); h.dispose();
  }
  {
    const b = await freshBook('创建卡片期间撤销到空草稿'), h = appUi(b), blank = f.blankCard();
    h.current = { ...h.current, card: { ...blank, title: '已送出的卡片A' }, baseCard: blank };
    const gate = h.hold(), pending = h.controller.flush(), committed = await bounded(gate.entered.promise, 'card undo first commit');
    h.app.changeField('card', 'title', ''); assert.equal(f.isDirty(h.current), false); h.app.pagehide();
    const journal = h.recovery(); assert.equal(journal.card.title, ''); assert.equal(journal.baseCard.title, '已送出的卡片A'); assert.equal(journal.pendingCard.id, committed.cards[0].id);
    gate.release.resolve(); await pending; assert.equal(h.current.card.id, committed.cards[0].id); assert.equal(h.current.card.title, '');
    await h.finish(); assert.equal(h.sent.length, 1, 'Blank undo stays local instead of duplicate creation or invalid-write spam'); assert.equal((await get(b)).cards.length, 1); assert.equal(h.errors.length, 0); h.dispose();
  }
  {
    let book = await freshBook('外部删章后不得把草稿发到同名章节');
    const [{ id: removed, title, body }] = book.chapters;
    book = await mutate(book, { action: 'addChapter', title });
    const survivor = book.chapters[1].id;
    book = await mutate(book, { action: 'updateChapter', chapterId: survivor, patch: { body } });
    const h = appUi(book), gate = h.loseResponse();
    h.app.changeField('chapter', 'body', body + '旧章私有草稿');
    const pending = h.controller.flush();
    const committed = await bounded(gate.entered.promise, 'old chapter write before lost receipt');
    h.app.changeField('chapter', 'body', body); // Undo to a seemingly clean baseline.
    assert.equal(f.isDirty(h.current), false);
    const after = await mutate(committed, { action: 'deleteChapter', chapterId: removed, confirmTitle: title });
    assert.equal(after.chapters[0].id, survivor);
    gate.release.resolve(); await pending;
    assert.equal(await h.app.saveAll(), false);
    assert.equal(h.current.chapterId, removed);
    assert.equal(h.recovery().chapterId, removed);
    assert.equal(h.sent.length, 1, 'Retry must not send any mutation to the surviving chapter');
    assert.deepEqual((await get(book)).chapters, after.chapters);
    h.dispose();
  }
  {
    // The category itself uses a stable caller ID and reconciles through real HTTP.
    const book = await freshBook('设定卡分类的持久化与回执'), h = appUi(book);
    h.categoryForm = { bookId: book.id, id: '', name: '  宫廷势力  ' };
    const loss = h.loseResponse(), adding = h.app.createCardCategory(h.categoryForm);
    const committed = await bounded(loss.entered.promise, 'category committed before lost receipt');
    const [category] = committed.cardCategories;
    assert.equal(category.name, '宫廷势力');
    assert.equal(h.categoryForm.id, category.id);
    assert.equal(h.cardCategoryFilter, undefined, 'Do not offer an unacknowledged category');
    loss.release.resolve(); await adding;
    assert.deepEqual(h.cardCategoryFilter, { bookId: book.id, id: category.id });
    assert.equal(h.categoryForm, null);
    assert.equal(h.sent.length, 1);

    // Journal round-trip includes membership in the stable pending card; a later
    // reassignment while awaiting the new card ACK must win without a second card.
    const blank = { ...f.blankCard(category.id), kind: 'rule', status: 'confirmed' };
    h.current = { ...h.current, card: blank, baseCard: blank };
    h.app.changeField('card', 'title', '持久化规则');
    h.app.changeField('card', 'content', '每座城只能有一枚印章');
    const hold = h.hold(), saving = h.controller.flush();
    const original = await bounded(hold.entered.promise, 'category assignment first card ACK');
    const contextRequest = { bookId: book.id, chapterId: book.chapters[0].id, mode: 'draft' };
    const promptBefore = await post('context', contextRequest);
    assert.match(promptBefore.prompt, /每座城只能有一枚印章/);
    h.app.changeCardCategory('world');
    h.app.pagehide();
    const journal = h.recovery();
    assert.equal(journal.pendingCard.card.categoryId, category.id);
    assert.equal(journal.card.categoryId, 'world');
    assert.equal(f.validAutosaveRecovery(journal, book.id), true);
    const recovered = f.restoredAutosaveWorkspace(f.workspace(original), journal);
    assert.equal(recovered.card.id, original.cards[0].id);
    assert.equal(recovered.card.categoryId, 'world');
    hold.release.resolve(); await saving; await h.finish();
    assert.equal(h.current.card.kind, 'rule');
    assert.equal(h.current.card.categoryId, 'world');
    const saved = await get(book);
    assert.equal(saved.cards.length, 1);
    assert.equal(saved.cards[0].id, original.cards[0].id);
    assert.equal(saved.cards[0].categoryId, 'world');
    assert.equal(saved.cards[0].kind, 'rule');
    assert.deepEqual(await post('context', contextRequest), promptBefore, 'Library regrouping cannot change the real prompt or report');

    h.app.changeCardCategory(''); await h.finish();
    const cleared = await get(book);
    assert.equal(cleared.cards[0].categoryId, null);
    assert.equal(cleared.cards[0].kind, 'rule');
    assert.deepEqual(cleared.cardCategories, [category]);
    h.dispose();
  }
  assert.equal(modelCalls, 0); assert.equal(agentCreates, 0); assert.equal(preferenceWrites, 0); assert.equal(jobWrites, 0);
  assert.deepEqual((await post('list')).modelSettings, initialPreferences, 'Plugin and global model preferences unchanged');
  const snapshots = new Map(savedBooks); await deactivate(); await activate();
  for (const [id, expected] of snapshots) assert.deepEqual(await get(id), expected, 'Actual JSON close/reopen retains exact final book, body, and conditions');
  assert.equal(modelCalls, 0); assert.equal(agentCreates, 0); assert.equal(jobWrites, 0);
  console.log(JSON.stringify({ ok: true, contract: 'production-client-autosave-real-http-json', booksReopened: snapshots.size, clientMutationRequests: allUis.reduce((sum, h) => sum + h.sent.length, 0), maxConcurrentWrites: Math.max(...allUis.map(h => h.maxInFlight)), modelCalls, agentCreates, jobWrites }));
} finally {
  for (const h of allUis) h.dispose(); for (const gate of releases) gate.resolve();
  await Promise.allSettled(allUis.map(h => bounded(h.controller.wait(), 'cleanup controller'))); await deactivate();
  const resolved = await realpath(root), parent = await realpath(tmpdir());
  assert.equal(dirname(resolved), parent); assert(basename(resolved).startsWith('inspiration-autosave-contract-'));
  await rm(resolved, { recursive: true, force: true });
}
