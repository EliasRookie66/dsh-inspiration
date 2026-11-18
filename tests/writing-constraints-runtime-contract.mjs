// Installed Cordis/LLM/Session/JSON contracts + production plugin/service/runner.
// Transport is an isolated no-network adapter; agent factory, session-flush
// acknowledgement, route registry and HTTP admission are explicit test doubles.
// No React/DOM, live profile, author book, external model, or global preference.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
assert(process.env.DSH_INSTALL_DIR, 'Run with the installed DSH Electron-as-Node');
const entries = new Map(['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-session'].map(name => [name, pathToFileURL(require.resolve(name, { paths: [process.env.DSH_INSTALL_DIR] })).href]));
registerHooks({ resolve(specifier, context, next) { return entries.has(specifier) ? { url: entries.get(specifier), shortCircuit: true } : next(specifier, context); } });
const { Context } = await import('@deepseek-ai/cordis');
const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm');
const { SessionStore } = await import('@deepseek-ai/dsh-session');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const { apply } = await import('../index.js');
const body = '甲段😀原文。\r\n\r\n“去吗？”她点头。\r\n末段仍下雨。';
const selected = '😀原文', start = body.indexOf(selected);
const selection = { start, end: start + selected.length, text: selected };
const row = (category, content, enabled = true) => ({ id: randomUUID(), category, content, enabled });
const disabled = row('NEVER_TRANSMIT_CATEGORY_6cd2', 'NEVER_TRANSMIT_CONTENT_8f41\n停用内容不是指令。', false);
const initial = [
  row('陌生自定义维度_A_973b', 'START_ONLY_A_39d1\n' + '未匹配设定😀\r\n“完整保留”\\'.repeat(90) + 'TAIL_A_4c65'),
  row('禁忌与边界', '保持人物为成年人；不扩大精确选段范围。'),
  row('叙事视角', '坚持第三人称有限视角；SNAPSHOT_A_VIEW_51ed'), disabled,
];
const next = [
  row('下一任务维度_B_46d7', 'NEXT_ONLY_B_a312\n“不同的新条件”😀\r\nTAIL_B_74ce'),
  { ...initial[2], content: '依然保持有限视角；SNAPSHOT_B_VIEW_43c2' }, initial[1], disabled,
];
const expectedConditions = rows => rows.filter(r => r.enabled).map(({ category, content }) => ({ category, content }));
const conditionLine = /^【全书写作条件（完整硬约束；启用 (\d+) 条）】\n([^\n]+)/gm;
function assertConditions(messages, expected) {
  assert.equal(messages.length, 1, 'Each call uses one dedicated, tool-free author input');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content.length, 1);
  const text = messages[0].content[0].text;
  const blocks = [...text.matchAll(conditionLine)];
  assert.equal(blocks.length, 1, 'Exactly one mandatory constraints JSON block at actual adapter boundary');
  const parsed = JSON.parse(blocks[0][2]);
  assert.equal(Number(blocks[0][1]), expected.length);
  assert.deepEqual(Object.keys(parsed).sort(), ['conditions', 'policy']);
  assert.equal(typeof parsed.policy, 'string'); assert(parsed.policy.length > 0);
  assert.deepEqual(parsed.conditions, expected, 'Every enabled category/content is complete, ordered and exact UTF-16');
  const wire = JSON.stringify(messages);
  assert(!wire.includes(disabled.category) && !wire.includes('NEVER_TRANSMIT_CONTENT_8f41'), 'Disabled data must not reach any message');
  return text;
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15000); })]); }
  finally { clearTimeout(timer); }
}
const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'inspiration-writing-constraints-contract-'));
const requests = [], durableJobs = new Map(), terminals = new Map(), waiting = new Map();
const analysisEntered = deferred(), releaseAnalysis = deferred();
let active, sessionCreates = 0, flushes = 0;
class LocalAdapter extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'writer', name: 'Isolated writer' }]; }
  async resolveModel(provider, model) { return { provider, id: model, name: 'Isolated writer' }; }
  async *stream(options) {
    assert.equal(options.provider, 'local-constraints-contract'); assert.equal(options.tools, undefined);
    if (options.sessionId.endsWith('-analysis')) analysisEntered.resolve();
    assert(flushes > requests.length, 'Session input flush acknowledgement precedes every call');
    const messages = structuredClone(options.messages), expected = requests.length < 2 ? initial : next;
    const prompt = assertConditions(messages, expectedConditions(expected));
    const session = active.sessions.get(options.sessionId);
    assert(session, 'Production model runner must create a real installed Session');
    assert.equal(session.snapshotEvents().find(event => event.type === 'user/message').data.content[0].text, prompt);
    const request = { messages, prompt, sessionId: options.sessionId };
    requests.push(request);
    if (options.sessionId.endsWith('-analysis')) await bounded(releaseAnalysis.promise, 'release isolated analysis');
    const text = options.sessionId.endsWith('-analysis') ? '保留雨夜剧情，仅改善对白回应。'
      : options.sessionId.endsWith('-revise') ? body.replace('她点头。', '她点头：“我答应过他。”') : '测试候选😀，未写入正文。';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function activate() {
  const owner = new Context(), disk = new JsonStorageBackend(root), llm = new LlmRuntime(owner), sessions = new SessionStore(owner);
  let handler, tool;
  const browserPeer = { id: 'isolated-constraints-author', principal: { kind: 'owner' } };
  const server = createServer((req, res) => { if (handler) handler(req, res); else { res.statusCode = 404; res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  active = { owner, disk, sessions, server, origin };
  llm.registerAdapter(['local-constraints-contract'], new LocalAdapter());
  owner.on('session/flush', () => { flushes++; });
  const backend = { kv: { async open(spec) {
    const unit = await disk.kv.open(spec);
    return { loadAll: () => unit.loadAll(), close: () => unit.close(), deleteRecord: (table, key) => unit.deleteRecord(table, key),
      async putRecord(table, key, value) {
        await unit.putRecord(table, key, value);
        if (table === 'jobs') {
          durableJobs.set(key, structuredClone(value));
          if (value.status !== 'running') { const result = structuredClone(value); terminals.set(key, result); waiting.get(key)?.resolve(result); waiting.delete(key); }
        }
      } };
  } } };
  await apply({ effect: fn => owner.effect(fn), storage: { backend: { get: () => backend } }, llm, sessions,
    agentDefaultModel: { currentSelection: () => ({ provider: 'local-constraints-contract', model: 'writer' }), saveSelection() { throw new Error('No global preference edits'); } },
    agentLoop: { async createAgent(_ctx, { sessionId }) { sessionCreates++; sessions.create(sessionId); return { async dispose() {} }; } },
    connection: { browserPeer, admit: req => req.headers.cookie === 'constraints-fixture=1' ? { peer: browserPeer } : { rejection: 401 } },
    webServer: { getOrigin: () => origin, register(route) { assert.equal(handler, undefined); handler = route.handler; return () => { handler = undefined; }; } },
    tools: { register: value => { tool = value; } },
  });
  active.execute = (action, payload = {}) => tool.execute({ action, payload }, { signal: new AbortController().signal });
}
async function deactivate() {
  if (!active) return;
  const closing = active;
  await closing.owner.fiber.dispose();
  closing.server.closeAllConnections(); await new Promise(resolve => closing.server.close(resolve));
  await closing.disk.close(); active = undefined;
}
async function author(book, operation, expectedRevision = book.revision) {
  const response = await fetch(active.origin + '/api/ycx-inspiration', { method: 'POST',
    headers: { Origin: active.origin, Cookie: 'constraints-fixture=1', 'Content-Type': 'application/json', 'X-inspiration-Request': '1' },
    body: JSON.stringify({ action: 'mutate', bookId: book.id, expectedRevision, operation }) });
  return { status: response.status, payload: await response.json() };
}
async function patch(book, value) {
  const answer = await author(book, { action: 'updateBook', patch: value });
  assert.equal(answer.status, 200, JSON.stringify(answer.payload));
  return active.execute('get', { bookId: book.id });
}
async function finish(jobId) {
  let terminal = terminals.get(jobId);
  if (!terminal) { const event = deferred(); waiting.set(jobId, event); terminal = await bounded(event.promise, 'terminal job persistence'); }
  assert.equal(terminal.status, 'completed', terminal.error);
  return terminal;
}
const options = (book, mode) => ({ bookId: book.id, chapterId: book.chapters[0].id, expectedRevision: book.revision, mode,
  instruction: '改善对白，尊重既有事实。', selection: mode === 'polish' ? selection : null });
try {
  await activate();
  let book = await active.execute('create', { title: '隔离写作约束合同，无真实手稿' });
  assert.deepEqual(book.writingConstraints, []);
  book = await active.execute('mutate', { bookId: book.id, expectedRevision: book.revision, operation: { action: 'addChapter', title: '雨夜' } });
  book = await active.execute('mutate', { bookId: book.id, expectedRevision: book.revision, operation: { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body } } });
  book = await patch(book, { writingConstraints: initial, contextBudget: 30000 });
  const persisted = structuredClone(book);
  await deactivate(); await activate();
  book = await active.execute('get', { bookId: persisted.id });
  assert.deepEqual(book, persisted, 'All enabled and disabled conditions survive plugin/storage close and reopen');
  const { jobId } = await active.execute('generate', options(book, 'revise'));
  await bounded(analysisEntered.promise, 'first actual adapter call');
  const beforeEdit = structuredClone(book);
  book = await patch(book, { writingConstraints: next });
  const conflict = await author(book, { action: 'updateBook', patch: { writingConstraints: initial } }, beforeEdit.revision);
  assert.equal(conflict.status, 409, 'Stale writer cannot silently overwrite newly saved conditions');
  assert.deepEqual((await active.execute('get', { bookId: book.id })).writingConstraints, next);
  assert.equal(requests.length, 1, 'The saved edit and stale CAS rejection happen before the rewrite call');
  releaseAnalysis.resolve(); await finish(jobId);
  assert.equal(requests.length, 2); assert(requests[0].sessionId.endsWith('-analysis')); assert(requests[1].sessionId.endsWith('-revise'));
  assertConditions([{ role: 'user', content: [{ type: 'text', text: durableJobs.get(jobId).request.prompt }] }], expectedConditions(initial));
  assertConditions([{ role: 'user', content: [{ type: 'text', text: durableJobs.get(jobId).request.rewritePrompt }] }], expectedConditions(initial));
  for (const mode of ['draft', 'continue', 'polish', 'summary']) {
    book = await active.execute('get', { bookId: book.id });
    const started = await active.execute('generate', options(book, mode));
    const done = await finish(started.jobId); assert.equal(done.mode, mode);
    if (mode === 'polish') assert.deepEqual(done.selection, selection, 'UTF-16 selection snapshot stays exact');
  }
  assert.equal(requests.length, 6, 'Five modes issue exactly six calls including both revise stages');
  assert.equal(sessionCreates, 6);
  for (const request of requests) assert(active.sessions.get(request.sessionId).snapshotEvents().some(event => event.type === 'assistant/message'));
  book = await active.execute('get', { bookId: book.id });
  assert.equal(book.chapters[0].body, body, 'Conditions and generation never auto-write manuscript');
  assert.equal(book.chapters[0].history.length, persisted.chapters[0].history.length);
  assert.equal(book.proposals.length, 5);
  await assert.rejects(active.execute('mutate', { bookId: book.id, expectedRevision: book.revision, operation: { action: 'acceptProposal', proposalId: book.proposals.find(p => p.mode === 'draft').id } }), error => error.code === 'AUTHOR_ONLY');
  const exported = await active.execute('export', { bookId: book.id, format: 'json' });
  assert.deepEqual(JSON.parse(exported.text).writingConstraints, next);
  const imported = await active.execute('import', { text: exported.text });
  assert.deepEqual(imported.writingConstraints.map(({ id, ...value }) => value), next.map(({ id, ...value }) => value));
  assert(imported.writingConstraints.every(r => !next.some(old => old.id === r.id)), 'Import remaps every constraint ID');
  const markdown = await active.execute('export', { bookId: book.id, format: 'markdown' });
  assert(!markdown.text.includes('NEXT_ONLY_B_a312') && !markdown.text.includes(disabled.category), 'Manuscript export excludes constraints');
  const legacy = JSON.parse(exported.text); delete legacy.writingConstraints;
  const importedLegacy = await active.execute('import', { text: JSON.stringify(legacy) });
  const rereadLegacy = await active.execute('get', { bookId: importedLegacy.id });
  assert(!Object.hasOwn(rereadLegacy, 'writingConstraints'), 'Reading/importing schema-1 legacy books does not inject a new persisted field');
  const giant = Array.from({ length: 3 }, (_, index) => row(`完整约束${index}`, '长'.repeat(4000)));
  book = await patch(book, { writingConstraints: giant, contextBudget: 6000 });
  const beforeBudget = { calls: requests.length, sessions: sessionCreates, jobs: durableJobs.size };
  for (const mode of ['draft', 'continue', 'polish', 'summary', 'revise']) {
    await assert.rejects(active.execute('generate', options(book, mode)), error => error.code === 'CONTEXT_BUDGET');
    assert.deepEqual({ calls: requests.length, sessions: sessionCreates, jobs: durableJobs.size }, beforeBudget, `${mode}: insufficient mandatory budget fails before session/job/model side effects`);
  }
  // Mutation checks of the API-boundary oracle: omission, truncation, disabled
  // leakage, and live-rereading instead of job-start conditions all turn red.
  const good = requests[1].messages, corrupt = edit => { const m = structuredClone(good); m[0].content[0].text = edit(m[0].content[0].text); return m; };
  const rewriteBlock = change => text => text.replace(conditionLine, (_all, count, json) => `【全书写作条件（完整硬约束；启用 ${count} 条）】\n${JSON.stringify(change(JSON.parse(json)))}`);
  assert.throws(() => assertConditions(corrupt(text => text.replace(conditionLine, '')), expectedConditions(initial)));
  assert.throws(() => assertConditions(corrupt(rewriteBlock(value => ({ ...value, conditions: value.conditions.map((r, i) => i ? r : { ...r, content: r.content.slice(0, 50) }) }))), expectedConditions(initial)));
  assert.throws(() => assertConditions(corrupt(text => text + '\n' + disabled.content), expectedConditions(initial)));
  assert.throws(() => assertConditions(corrupt(rewriteBlock(value => ({ ...value, conditions: expectedConditions(next) }))), expectedConditions(initial)));
  console.log('PASS: installed LLM/Session boundary, 5 modes / 6 local adapter calls; parsed full ordered constraints; disabled absent; durable reopen; both revise calls freeze job-start conditions; later jobs use edits; UTF-16 selection; CAS/author-only/no auto-write; JSON/import/Markdown/legacy; 5 budget refusals before calls/sessions/jobs; 4 oracle mutants. No paid calls or GUI proof.');
} finally {
  releaseAnalysis.resolve();
  try { await deactivate(); }
  finally { const target = await realpath(root); assert.equal(dirname(target), parent); assert(basename(target).startsWith('inspiration-writing-constraints-contract-')); await rm(target, { recursive: true }); }
}
