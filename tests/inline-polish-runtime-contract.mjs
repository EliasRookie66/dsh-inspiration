// Installed runtime integration, not native authentication/UI evidence. The only
// doubles are named local adapter, agent factory, route registry, and author
// admission below. Production plugin/defineTool/model runner, LlmRuntime,
// SessionStore, JSON KV, core CAS and HTTP handler are actually executed.
// Run under installed Electron-as-Node with DSH_INSTALL_DIR, never a live profile.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createServer } from 'node:http';
const require = createRequire(import.meta.url);
if (!process.env.DSH_INSTALL_DIR) throw new Error('DSH_INSTALL_DIR must identify the installed runtime');
const entries = new Map(['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-session'].map(name => [name, pathToFileURL(require.resolve(name, { paths: [process.env.DSH_INSTALL_DIR] })).href]));
registerHooks({ resolve(specifier, context, next) { return entries.has(specifier) ? { url: entries.get(specifier), shortCircuit: true } : next(specifier, context); } });
const { Context } = await import('@deepseek-ai/cordis');
const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm');
const { SessionStore } = await import('@deepseek-ai/dsh-session');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const { apply } = await import('../index.js');
const { API_PATH } = await import('../http.js');
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const helperStart = clientSource.indexOf('    const equal ='), helperEnd = clientSource.indexOf('    const en =');
assert(helperStart > 0 && helperEnd > helperStart);
// Exact production pure functions only; no React/DOM simulation or GUI assertion.
const ui = new Function(clientSource.slice(helperStart, helperEnd) + '\nreturn {workspace,sourceOffsets,capturePolishSnapshot,polishIntentProblem,polishView,polishActionSnapshot,polishActionProblem};')();
const repeated = '同一句😀\r\n下一行';
const source = `前缀🌙\r\n${repeated}\r\n中间原样\r\n${repeated}\r\n尾声🚀`;
const selection = { start: source.lastIndexOf(repeated), end: source.lastIndexOf(repeated) + repeated.length, text: repeated };
const replacement = '新句✨\r\n仍是原位置';
const expected = source.slice(0, selection.start) + replacement + source.slice(selection.end);
const selectedModel = { provider: 'inline-local-fixture', model: 'writer' };
const requests = [], plans = [], durableJobs = new Map(), terminalJobs = new Map(), terminalWaiters = new Map(), writes = [];
const opened = new Set();
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise, label, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}
function terminal(jobId) {
  if (terminalJobs.has(jobId)) return Promise.resolve(terminalJobs.get(jobId));
  const waiter = deferred(); terminalWaiters.set(jobId, waiter); return bounded(waiter.promise, 'terminal job ' + jobId);
}
function assertPublic(job) {
  assert.equal(job.mode, 'polish'); assert.deepEqual(job.selection, selection);
  for (const key of ['request', 'sourceBody', 'prompt', 'controller', 'promise']) assert.equal(job[key], undefined, 'private public-job field: ' + key);
}
class LocalInlineAdapterDouble extends LlmAdapter {
  async listModels(provider) { return ['writer', 'other'].map(id => ({ provider, id, name: id })); }
  async resolveModel(provider, id) { return { provider, id, name: id }; }
  async *stream(options) {
    const plan = plans.shift(); assert.ok(plan, 'every model invocation requires an explicit local fixture');
    const prompt = options.messages.at(-1).content[0].text;
    assert.equal(options.provider, selectedModel.provider); assert.equal(options.model, selectedModel.model);
    const durable = durableJobs.get(options.sessionId.replace(/^inspiration-/, ''));
    assert.ok(durable, 'actual JSON job write must finish before model transport');
    assert.equal(durable.request.prompt, prompt); assert.equal(durable.request.sourceBody, source); assert.deepEqual(durable.request.selection, selection);
    assert.equal(options.tools, undefined, 'writing calls must not acquire tools');
    requests.push({ provider: options.provider, model: options.model, prompt, sessionId: options.sessionId, plan });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '新句✨' };
    plan.entered.resolve();
    await bounded(plan.release.promise, 'local adapter release'); options.signal.throwIfAborted();
    if (plan.kind === 'failure') throw new Error('expected inline local adapter failure');
    yield { type: 'text-delta', index: 0, text: '\r\n仍是原位置' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: replacement } };
    yield { type: 'finish', reason: { kind: plan.kind === 'TRUNCATED' ? 'max-tokens' : 'stop' } };
  }
}
const parent = await realpath(tmpdir());
const root = await mkdtemp(join(parent, 'inspiration-inline-polish-contract-'));
let owner, disk, llm, sessions, tool, route, origin, server, defaultModel = selectedModel;
let flushes = 0, disposedAgents = 0, activations = 0;
const authorPeerDouble = { id: 'isolated-inline-author', principal: { kind: 'owner' } };
const authorAdmissionDouble = { browserPeer: authorPeerDouble, admit(req) { return req.headers.cookie === 'inline-author-fixture=1' ? { peer: authorPeerDouble } : { rejection: 401 }; } };
const routeRegistryDouble = { getOrigin: () => origin, register(value) { assert.equal(route, undefined); assert.equal(value.path, API_PATH); route = value; return () => { assert.equal(route, value); route = undefined; }; } };
async function activate() {
  owner = new Context(); disk = new JsonStorageBackend(root); llm = new LlmRuntime(owner); sessions = new SessionStore(owner);
  llm.registerAdapter(['inline-local-fixture'], new LocalInlineAdapterDouble());
  // Real SessionStore flush contract, an explicit listener, not a claim of a
  // mounted production Session persistence plugin or native agent factory.
  owner.on('session/flush', () => { flushes++; });
  const realKvNotificationWrapper = { kv: { async open(spec) {
    opened.add(spec.name); const unit = await disk.kv.open(spec);
    return { loadAll: () => unit.loadAll(), close: () => unit.close(), deleteRecord: (table, key) => unit.deleteRecord(table, key),
      async putRecord(table, key, value) {
        await unit.putRecord(table, key, value); writes.push({ name: spec.name, table, key });
        if (table === 'jobs') durableJobs.set(key, structuredClone(value));
        if (table === 'jobs' && value.status !== 'running') {
          const snapshot = structuredClone(value); terminalJobs.set(key, snapshot); terminalWaiters.get(key)?.resolve(snapshot); terminalWaiters.delete(key);
        }
      } };
  } } };
  const agentFactoryDouble = { async createAgent(_ctx, { sessionId }) { sessions.create(sessionId); return { async dispose() { disposedAgents++; } }; } };
  await apply({ effect: fn => owner.effect(fn), storage: { backend: { get(name) { assert.equal(name, 'json'); return realKvNotificationWrapper; } } }, llm, sessions,
    agentDefaultModel: { currentSelection: () => defaultModel, saveSelection() { throw new Error('Test must never alter the global default'); } },
    agentLoop: agentFactoryDouble, connection: authorAdmissionDouble, webServer: routeRegistryDouble,
    tools: { register(value) { assert.equal(value.name, 'inspiration_novel'); tool = value; } },
  }); activations++;
}
async function deactivate() {
  if (owner) { await bounded(owner.fiber.dispose(), 'plugin disposal'); owner = undefined; }
  if (disk) { await bounded(disk.close(), 'JSON backend close'); disk = undefined; }
  assert.equal(route, undefined, 'production plugin must dispose its route');
}
const execute = (action, payload = {}) => tool.execute({ action, payload }, { signal: new AbortController().signal });
async function author(book, operation, overrides = {}) {
  const response = await fetch(origin + API_PATH, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Origin: origin, Cookie: 'inline-author-fixture=1', 'Content-Type': 'application/json', 'X-inspiration-Request': '1' }, body: JSON.stringify({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation, ...overrides }) });
  return { status: response.status, payload: await response.json() };
}
const manuscriptPath = book => join(root, `ycx_moxu_book_${book.id.replaceAll('-', '_').toLowerCase()}.json`);
async function createBook(label) {
  let book = await execute('create', { title: '选段润色真实隔离·' + label });
  const change = operation => execute('mutate', { bookId: book.id, expectedRevision: book.revision, operation });
  book = await change({ action: 'addChapter', title: '第二处重复😀' });
  book = await change({ action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: source } });
  book = await change({ action: 'updateChapter', chapterId: book.chapters[0].id, patch: { summary: '必须在采纳后失效的原摘要' } });
  return book;
}
async function start(book, instruction = '', kind = 'stop') {
  const plan = { kind, entered: deferred(), release: deferred() }; plans.push(plan);
  const request = { bookId: book.id, chapterId: book.chapters[0].id, expectedRevision: book.revision, expectedModelRevision: 1, mode: 'polish', instruction, selection: structuredClone(selection) };
  const count = requests.length, beforeBytes = await readFile(manuscriptPath(book), 'utf8');
  const context = await execute('context', request); assert.equal(requests.length, count, 'context is not generation');
  const { jobId } = await execute('generate', request);
  await bounded(plan.entered.promise, 'partial local stream');
  assert.equal(requests.length, count + 1, 'one model API call per polish'); assert.equal(requests.at(-1).prompt, context.prompt);
  if (instruction) assert.ok(requests.at(-1).prompt.includes(instruction));
  const job = await execute('job', { jobId }); assertPublic(job); assert.equal(job.sourceRevision, book.chapters[0].revision);
  assert.equal(job.status, 'running'); assert.equal(job.text, '新句✨'); assert.deepEqual(job.model, selectedModel);
  assert.deepEqual(await execute('get', { bookId: book.id }), book); assert.equal(await readFile(manuscriptPath(book), 'utf8'), beforeBytes);
  const w = ui.workspace(book), nativeStart = source.slice(0, selection.start).replaceAll('\r\n', '\n').length;
  const snapshot = ui.capturePolishSnapshot(w, nativeStart, nativeStart + repeated.replaceAll('\r\n', '\n').length);
  assert.equal(snapshot.start, selection.start); assert.equal(snapshot.end, selection.end); assert.equal(snapshot.text, repeated);
  assert.equal(ui.polishIntentProblem(w, snapshot), '');
  const partial = ui.polishView(w, job); assert.ok(partial); assert.equal(partial.original, repeated); assert.equal(partial.newText, '新句✨');
  assert.equal(partial.prefix, source.slice(0, selection.start)); assert.equal(partial.suffix, source.slice(selection.end));
  assert.equal(partial.preview, source.slice(0, selection.start) + '新句✨' + source.slice(selection.end));
  job.selection.text = 'public mutation'; job.model.model = 'public mutation';
  const listed = await execute('list'); assertPublic(listed.activeJobs.find(j => j.id === jobId));
  listed.activeJobs.find(j => j.id === jobId).selection.start = 0;
  assertPublic(await execute('job', { jobId }));
  defaultModel = { provider: 'inline-local-fixture', model: 'other' };
  assert.deepEqual((await execute('job', { jobId })).model, selectedModel, 'in-flight model snapshot is immutable');
  defaultModel = selectedModel;
  return { plan, jobId, beforeBytes, initialCalls: count };
}
async function finish(book, running) {
  running.plan.release.resolve(); const stored = await terminal(running.jobId);
  const job = await execute('job', { jobId: running.jobId }); assert.equal(job.status, 'completed', job.error); assertPublic(job);
  assert.equal(stored.request.sourceBody, source); assert.equal(stored.request.sourceRevision, book.chapters[0].revision);
  assert.deepEqual(stored.request.selection, selection); assert.equal(stored.request.prompt, requests[running.initialCalls].prompt);
  assert.equal(requests.length, running.initialCalls + 1);
  const current = await execute('get', { bookId: book.id }), proposal = current.proposals.find(p => p.id === job.proposalId);
  assert.deepEqual(current.chapters, book.chapters); assert.equal(proposal.state, 'ready'); assert.equal(proposal.text, replacement);
  assert.deepEqual(proposal.selection, selection); assert.equal(proposal.sourceBody, source);
  const w = ui.workspace(current), view = ui.polishView(w, proposal);
  assert.equal(view.original, repeated); assert.equal(view.newText, replacement); assert.equal(view.preview, expected);
  assert.equal(view.prefix, source.slice(0, selection.start)); assert.equal(view.suffix, source.slice(selection.end));
  assert.equal(view.pieces[1].kind, 'polish'); assert.equal(view.pieces[1].text, replacement); assert.equal(view.pieces[1].before, repeated);
  const click = ui.polishActionSnapshot(w, proposal); assert.equal(ui.polishActionProblem(w, click), '');
  const session = sessions.get(job.sessionId), events = session.snapshotEvents();
  assert.equal(events.find(e => e.type === 'user/message').data.content[0].text, requests[running.initialCalls].prompt);
  assert.ok(events.some(e => e.type === 'assistant/message')); assert.equal(session.deriveMessages().at(-1).content[0].text, replacement);
  return { book: current, proposal, job, click };
}
let persistedBook, persistedJob;
try {
  server = createServer((req, res) => { if (route) void route.handler(req, res); else { res.statusCode = 404; res.end(); } });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 'isolated HTTP listen');
  origin = `http://127.0.0.1:${server.address().port}`; await activate();
  assert.equal(requests.length, 0); assert.deepEqual((await execute('list')).books, []);
  for (const instruction of ['', '只调整第二处节奏，保留😀与CRLF，不新增人物。']) {
    const initial = await createBook(instruction ? 'custom' : 'default'), running = await start(initial, instruction);
    const { book, proposal, job, click } = await finish(initial, running);
    const forbidden = { bookId: book.id, expectedRevision: book.revision, user: true, operation: { action: 'acceptProposal', proposalId: proposal.id } };
    const count = writes.length, bytes = await readFile(manuscriptPath(book), 'utf8');
    await assert.rejects(execute('mutate', forbidden), { code: 'AUTHOR_ONLY' });
    assert.equal(writes.length, count); assert.equal(await readFile(manuscriptPath(book), 'utf8'), bytes);
    const accepted = await author(book, forbidden.operation); assert.equal(accepted.status, 200);
    const saved = accepted.payload.data, chapter = saved.chapters[0];
    assert.equal(chapter.body, expected); assert.equal(chapter.body.indexOf(repeated), source.indexOf(repeated));
    assert.deepEqual(Buffer.from(chapter.body.slice(0, selection.start)), Buffer.from(source.slice(0, selection.start)));
    assert.equal(chapter.history.length, initial.chapters[0].history.length + 1); assert.equal(chapter.history.at(-1).body, source);
    assert.equal(chapter.history.at(-1).reason, 'accept-polish'); assert.equal(chapter.revision, initial.chapters[0].revision + 1);
    assert.equal(chapter.summary, initial.chapters[0].summary); assert.equal(chapter.summaryRevision, null);
    assert.equal(ui.polishActionProblem(ui.workspace(saved), click), 'confirmChanged');
    const afterBytes = await readFile(manuscriptPath(saved), 'utf8'), afterWrites = writes.length;
    const doubleClick = await author(book, forbidden.operation); assert.equal(doubleClick.status, 409); assert.equal(doubleClick.payload.error.code, 'CONFLICT');
    assert.equal(writes.length, afterWrites); assert.equal(await readFile(manuscriptPath(saved), 'utf8'), afterBytes);
    persistedBook = saved; persistedJob = job;
  }
  {
    const initial = await createBook('reject'), { book, proposal } = await finish(initial, await start(initial));
    const rejected = await author(book, { action: 'rejectProposal', proposalId: proposal.id }); assert.equal(rejected.status, 200);
    assert.deepEqual(rejected.payload.data.chapters, initial.chapters); assert.equal(rejected.payload.data.proposals[0].state, 'rejected');
    const bytes = await readFile(manuscriptPath(book), 'utf8'), count = writes.length;
    const old = await author(book, { action: 'rejectProposal', proposalId: proposal.id }); assert.equal(old.status, 409);
    assert.equal(writes.length, count); assert.equal(await readFile(manuscriptPath(book), 'utf8'), bytes);
  }
  for (const kind of ['manual-body', 'chapter-title', 'revision-only']) {
    const initial = await createBook(kind), finished = await finish(initial, await start(initial)); let book = finished.book;
    const change = async patch => { const result = await author(book, { action: 'updateChapter', chapterId: book.chapters[0].id, patch }); assert.equal(result.status, 200); book = result.payload.data; };
    if (kind === 'manual-body') await change({ body: source + '\r\n作者手改' });
    else { await change({ title: '作者临时标题' }); if (kind === 'revision-only') await change({ title: initial.chapters[0].title }); }
    const count = writes.length, bytes = await readFile(manuscriptPath(book), 'utf8');
    const stale = await author(book, { action: 'acceptProposal', proposalId: finished.proposal.id });
    assert.equal(stale.status, 409); assert.equal(stale.payload.error.code, 'STALE_PROPOSAL');
    assert.equal(writes.length, count); assert.equal(await readFile(manuscriptPath(book), 'utf8'), bytes); assert.deepEqual(await execute('get', { bookId: book.id }), book);
  }
  for (const kind of ['cancel', 'failure', 'TRUNCATED']) {
    const initial = await createBook(kind), running = await start(initial, '', kind);
    if (kind === 'cancel') await execute('cancel', { jobId: running.jobId });
    running.plan.release.resolve(); await terminal(running.jobId);
    const job = await execute('job', { jobId: running.jobId }); assert.equal(job.status, kind === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(job.proposalId, undefined); assertPublic(job);
    assert.equal(requests.length, running.initialCalls + 1); assert.deepEqual(await execute('get', { bookId: initial.id }), initial);
    assert.equal(await readFile(manuscriptPath(initial), 'utf8'), running.beforeBytes);
    const events = sessions.get(`inspiration-${job.id}`).snapshotEvents();
    assert.ok(events.some(e => e.type === 'assistant/attempt')); assert.ok(!events.some(e => e.type === 'assistant/message'));
    if (kind === 'TRUNCATED') assert.equal(events.find(e => e.type === 'turn/end').data.reason.error.code, 'TRUNCATED');
  }
  assert.equal(requests.length, 9); assert.equal(disposedAgents, 9); assert.ok(flushes >= 18); assert.equal(plans.length, 0);
  await deactivate(); await activate();
  assert.deepEqual(await execute('get', { bookId: persistedBook.id }), persistedBook);
  const resumed = await execute('job', { jobId: persistedJob.id }); assert.deepEqual(resumed, persistedJob); assertPublic(resumed);
  resumed.selection.text = 'reopened public mutation'; assertPublic(await execute('job', { jobId: persistedJob.id }));
  assert.equal(requests.length, 9, 'JSON reopen/job resume makes no model call'); assert.equal(activations, 2);
  assert.ok([...opened].every(name => name === 'ycx_moxu_index' || name === 'ycx_inspiration_settings' || name.startsWith('ycx_moxu_book_')));
  console.log('PASS: 9 installed-runtime local-adapter polish scenarios (default/custom accept, reject, 3 stale guards, cancel/failure/TRUNCATED); real JSON reopen/public metadata, 9 exact Session/one-call contracts, production defineTool author guard, isolated author HTTP CAS/history/summary, actual pure Client UTF-16/CRLF preview helpers. No external model, live book/profile, native-auth or GUI claim.');
} finally {
  // Release only our own fixture barriers even after an assertion failure; no
  // polling, sleeps, unbounded adapter wait, or live runtime file access.
  for (const request of requests) request.plan.release.resolve(); for (const plan of plans) plan.release.resolve();
  try { await deactivate(); }
  finally {
    if (server) { server.closeAllConnections(); await bounded(new Promise(resolve => server.close(resolve)), 'isolated HTTP close'); }
    const target = await realpath(root); assert.equal(target, root); assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith('inspiration-inline-polish-contract-'));
    await rm(target, { recursive: true });
  }
}
