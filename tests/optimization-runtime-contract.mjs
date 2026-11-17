// Real installed Cordis/LLM/Session/JSON contracts + production plugin, with a
// local no-network adapter and explicit agent-factory/route/auth registry doubles.
// Author actions use isolated HTTP, never live books, profiles or credentials.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createServer } from 'node:http';
const require = createRequire(import.meta.url);
const entries = new Map(['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-session'].map(name => [name, pathToFileURL(require.resolve(name, { paths: [process.env.DSH_INSTALL_DIR] })).href]));
registerHooks({ resolve(specifier, context, next) { return entries.has(specifier) ? { url: entries.get(specifier), shortCircuit: true } : next(specifier, context); } });
const { Context } = await import('@deepseek-ai/cordis');
const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm');
const { SessionStore } = await import('@deepseek-ai/dsh-session');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const { NovelStore } = await import('../service.js');
const { apply } = await import('../index.js');
const { applyHunks, revisionPreview } = await import('../revision.js');
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const helperStart = clientSource.indexOf('    const equal ='), helperEnd = clientSource.indexOf('    const en =');
assert(helperStart > 0 && helperEnd > helperStart);
// Actual pure Client helpers under the installed runtime; not React/DOM execution.
const ui = new Function(clientSource.slice(helperStart, helperEnd) + '\nreturn {revisionView,workspace,staleProposal,revisionHunkSnapshot,revisionActionProblem,bulkRevisionSnapshot,bulkRevisionProblem};')();
const source = '“去吗？”\r\n\r\n她点头。\r\n\r\n雨仍未停，街上的灯亮着。';
const target = '“这么晚了，你还要去吗？”\r\n\r\n她点头：“我答应过他，不能食言。”\r\n\r\n雨仍未停，街上的灯一盏盏亮了起来。';
const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'inspiration-optimization-contract-'));
const owner = new Context(), disk = new JsonStorageBackend(root), llm = new LlmRuntime(owner), sessions = new SessionStore(owner);
const browserPeer = { id: 'isolated-author', principal: { kind: 'owner' } };
let handler, tool, origin, completed;
const terminal = new Promise(resolve => { completed = resolve; });
const requests = [];
class LocalAdapter extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'writer', name: 'Writer' }]; }
  async resolveModel(provider, model) { return { provider, id: model, name: 'Writer' }; }
  async *stream(options) {
    const prompt = options.messages.at(-1).content[0].text;
    requests.push({ provider: options.provider, model: options.model, prompt, sessionId: options.sessionId });
    const text = requests.length === 1 ? '增加有来有回的回应，保留雨夜出行的原情节，不增添新人物。' : target;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
llm.registerAdapter(['local-fixture'], new LocalAdapter()); owner.on('session/flush', () => {});
const wrapped = { kv: { async open(spec) {
  const unit = await disk.kv.open(spec);
  return { loadAll: () => unit.loadAll(), close: () => unit.close(), deleteRecord: (table, key) => unit.deleteRecord(table, key),
    async putRecord(table, key, value) { await unit.putRecord(table, key, value); if (table === 'jobs' && value.status !== 'running') completed(structuredClone(value)); } };
} } };
const server = createServer((req, res) => { if (handler) handler(req, res); else { res.statusCode = 404; res.end(); } });
const execute = (action, payload = {}) => tool.execute({ action, payload }, { signal: new AbortController().signal });
async function author(book, operation, overrides = {}) {
  const response = await fetch(origin + '/api/ycx-inspiration', { method: 'POST', headers: { Origin: origin, Cookie: 'fixture-author=1', 'Content-Type': 'application/json', 'X-inspiration-Request': '1' }, body: JSON.stringify({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation, ...overrides }) });
  return { status: response.status, payload: await response.json() };
}
let finalBook;
try {
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  await apply({ effect: fn => owner.effect(fn), storage: { backend: { get: () => wrapped } }, llm, sessions,
    agentDefaultModel: { currentSelection: () => ({ provider: 'local-fixture', model: 'writer' }), saveSelection() { throw new Error('Never change the default'); } },
    agentLoop: { async createAgent(_ctx, { sessionId }) { sessions.create(sessionId); return { async dispose() {} }; } },
    connection: { browserPeer, admit: req => req.headers.cookie === 'fixture-author=1' ? { peer: browserPeer } : { rejection: 401 } },
    webServer: { getOrigin: () => origin, register(route) { assert.equal(handler, undefined); handler = route.handler; return () => { handler = undefined; }; } },
    tools: { register: value => { tool = value; } },
  });
  let book = await execute('create', { title: '按作者要素优化·真实后端隔离验收' });
  book = await execute('mutate', { bookId: book.id, expectedRevision: book.revision, operation: { action: 'addChapter', title: '雨夜' } });
  book = await execute('mutate', { bookId: book.id, expectedRevision: book.revision, operation: { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: source } } });
  const { jobId } = await execute('generate', { bookId: book.id, chapterId: book.chapters[0].id, expectedRevision: book.revision, expectedModelRevision: 1, mode: 'revise', instruction: '对话太过生硬，且对话比较少。' });
  const finished = await terminal; assert.equal(finished.id, jobId); assert.equal(finished.status, 'completed', finished.error);
  assert.equal(requests.length, 2); assert(requests[0].sessionId.endsWith('-analysis')); assert(requests[1].sessionId.endsWith('-revise'));
  for (const request of requests) {
    assert.equal(request.provider, 'local-fixture');
    const log = sessions.get(request.sessionId).snapshotEvents();
    const input = log.find(event => event.type === 'user/message');
    assert.equal(input.data.content[0].text, request.prompt);
    assert(log.some(event => event.type === 'assistant/message'));
  }
  book = await execute('get', { bookId: book.id }); const proposal = book.proposals.find(p => p.id === finished.proposalId);
  assert.equal(book.chapters[0].body, source); assert.equal(proposal.text, target); assert.equal(revisionPreview(proposal).text, target);
  assert.equal(ui.revisionView(proposal).preview, target); assert.equal(ui.revisionView(proposal).saved, source);
  const click = ui.revisionHunkSnapshot(ui.workspace(book), proposal, proposal.review.hunks[0].id);
  assert.equal(ui.revisionActionProblem(ui.workspace(book), click), '');
  assert(proposal.review.hunks.length >= 3, 'fixture must allow partial acceptance, rejection and bulk approval');
  const first = proposal.review.hunks[0];
  for (const action of ['acceptRevisionHunk', 'rejectRevisionHunk', 'acceptRevisionAll']) await assert.rejects(execute('mutate', { bookId: book.id, expectedRevision: book.revision, operation: { action, proposalId: proposal.id, hunkId: first.id } }), { code: 'AUTHOR_ONLY' });
  const accepted = await author(book, { action: 'acceptRevisionHunk', proposalId: proposal.id, hunkId: first.id });
  assert.equal(accepted.status, 200); const old = book; book = accepted.payload.data;
  assert.notEqual(book.chapters[0].body, source); assert.notEqual(book.chapters[0].body, target);
  assert.equal(book.chapters[0].history.at(-1).body, source);
  const after = book.proposals.find(p => p.id === proposal.id); assert.equal(after.review.hunks[0].state, 'accepted');
  assert.equal(book.chapters[0].body, applyHunks(source, after.review.hunks));
  assert.equal(ui.revisionView(after).saved, book.chapters[0].body); assert.equal(ui.revisionView(after).preview, target);
  assert.equal(ui.staleProposal(ui.workspace(book), after), false, 'own accepted edit must not stale remaining UI decisions');
  assert.equal(ui.revisionActionProblem(ui.workspace(book), click), 'confirmChanged', 'old rendered click snapshot cannot authorize another write');
  const stale = await author(old, { action: 'acceptRevisionHunk', proposalId: proposal.id, hunkId: first.id }); assert.equal(stale.status, 409);
  const rejected = await author(book, { action: 'rejectRevisionHunk', proposalId: proposal.id, hunkId: after.review.hunks[1].id });
  assert.equal(rejected.status, 200); book = rejected.payload.data;
  assert.equal(book.chapters[0].history.length, old.chapters[0].history.length + 1, 'rejection creates no manuscript revision');
  const partial = structuredClone(book), pending = book.proposals[0].review.hunks.filter(h => h.state === 'pending').length;
  const bulkClick = ui.bulkRevisionSnapshot(ui.workspace(book), book.proposals[0]);
  assert.equal(ui.bulkRevisionProblem(ui.workspace(book), bulkClick), '');
  const approved = await author(book, { action: 'acceptRevisionAll', proposalId: proposal.id });
  assert.equal(approved.status, 200); book = approved.payload.data;
  const resolved = book.proposals.find(p => p.id === proposal.id);
  assert.equal(revisionPreview(resolved).text, book.chapters[0].body);
  assert.equal(resolved.review.hunks[1].state, 'rejected');
  assert.equal(book.chapters[0].revision, partial.chapters[0].revision + pending);
  assert.equal(book.chapters[0].history.length, partial.chapters[0].history.length + 1, 'bulk approval creates only one history snapshot');
  assert.equal(book.chapters[0].history.at(-1).body, partial.chapters[0].body);
  assert.equal(ui.revisionView(resolved).saved, book.chapters[0].body);
  assert.equal((await author(partial, { action: 'acceptRevisionAll', proposalId: proposal.id })).status, 409);
  assert.equal((await execute('job', { jobId })).request, undefined);
  finalBook = book;
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await owner.fiber.dispose(); await disk.close();
}
  const again = new JsonStorageBackend(root), store = await new NovelStore(again).init();
  try { assert.deepEqual(await store.load(finalBook.id), finalBook); }
  finally { await store.close(); await again.close(); }
  console.log('PASS: production two-stage model/session flow + real JSON storage, full preview/no auto-write, tool author-only refusal, isolated HTTP partial accept/reject + atomic approve-all preserving rejected edits, CAS, single-history bulk approval and reopen. Local adapter and explicit test auth/factory only; no external generation or live manuscripts.');
} finally {
  const targetPath = await realpath(root); assert.equal(dirname(targetPath), parent); assert(basename(targetPath).startsWith('inspiration-optimization-contract-'));
  await rm(targetPath, { recursive: true });
}
