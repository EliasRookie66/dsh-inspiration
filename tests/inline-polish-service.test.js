// Service/dispatch units only: the backend and model runner below are explicit
// local doubles. Installed JSON/LLM/Session/plugin contracts live in the .mjs test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NovelStore, NovelService } from '../service.js';

const repeated = '同一句😀\r\n下一行';
const original = `前缀🌙\r\n${repeated}\r\n中间原样\r\n${repeated}\r\n尾声🚀`;
const selection = { start: original.lastIndexOf(repeated), end: original.lastIndexOf(repeated) + repeated.length, text: repeated };
const replacement = '新句✨\r\n仍是原位置';
const model = { provider: 'local-double', model: 'writer', reasoningEffort: 'high' };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function localJsonBackendDouble() {
  const files = new Map(), writes = [];
  return { files, writes, kv: { async open(spec) {
    if (!files.has(spec.name)) files.set(spec.name, { tables: Object.fromEntries(spec.tables.map(t => [t, {}])), global: null });
    const data = files.get(spec.name);
    return { async loadAll() { return structuredClone(data); }, async close() {},
      async putRecord(table, key, value) { writes.push({ name: spec.name, table, key }); data.tables[table][key] = structuredClone(value); },
      async deleteRecord(table, key) { writes.push({ name: spec.name, table, key }); delete data.tables[table][key]; } };
  } } };
}
async function fixture(runner = async () => ({ text: replacement }), modelPreferences = null) {
  const backend = localJsonBackendDouble(), store = await new NovelStore(backend).init(), calls = [];
  let selectedModel = structuredClone(model);
  const service = new NovelService(store, { modelPreferences, getModel: () => selectedModel, async runModel(args) {
    const durable = backend.files.get('ycx_moxu_index').tables.jobs[args.jobId];
    assert.ok(durable, 'durable provenance must precede the model runner');
    assert.equal(durable.request.prompt, args.prompt);
    calls.push(args); return runner(args);
  } });
  let book = await service.dispatch({ action: 'create', title: '选段润色隔离单元' });
  const mutate = operation => service.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation });
  book = await mutate({ action: 'addChapter', title: '重复选段😀' });
  book = await mutate({ action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: original } });
  book = await mutate({ action: 'updateChapter', chapterId: book.chapters[0].id, patch: { summary: '原摘要' } });
  const request = { action: 'generate', bookId: book.id, chapterId: book.chapters[0].id, expectedRevision: book.revision, mode: 'polish', instruction: '', selection: structuredClone(selection) };
  const get = () => service.dispatch({ action: 'get', bookId: book.id });
  async function generate(overrides = {}) {
    const { jobId } = await service.dispatch({ ...request, ...overrides });
    await service.live.get(jobId).promise;
    return { job: await service.dispatch({ action: 'job', jobId }), book: await get() };
  }
  return { backend, store, service, calls, book, request, get, generate, setModel: value => { selectedModel = value; } };
}
function noPrivateRequest(job) {
  for (const key of ['request', 'sourceBody', 'prompt', 'controller', 'promise']) assert.equal(job[key], undefined, key + ' must stay private');
}

for (const instruction of ['', '只调整节奏，保留😀与CRLF；不要扩写世界观。']) test(`polish ${instruction ? 'custom' : 'default'}: one call, exact second occurrence and proposal-only completion`, async () => {
  const f = await fixture();
  try {
    const context = await f.service.dispatch({ ...f.request, action: 'context', instruction });
    assert.equal(f.calls.length, 0, 'context/metadata inspection must not generate');
    await f.service.dispatch({ action: 'list' }); await f.get(); assert.equal(f.calls.length, 0);
    const { job, book } = await f.generate({ instruction });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].prompt, context.prompt);
    if (instruction) assert.ok(context.prompt.includes(instruction));
    assert.equal(job.status, 'completed'); assert.equal(job.mode, 'polish');
    assert.equal(job.sourceRevision, f.book.chapters[0].revision); assert.deepEqual(job.selection, selection); noPrivateRequest(job);
    assert.equal(book.chapters[0].body, original); assert.deepEqual(book.chapters, f.book.chapters);
    const proposal = book.proposals.find(p => p.id === job.proposalId);
    assert.equal(proposal.state, 'ready'); assert.equal(proposal.text, replacement);
    assert.equal(proposal.sourceBody, original); assert.equal(proposal.sourceRevision, job.sourceRevision); assert.deepEqual(proposal.selection, selection);
    const accepted = await f.service.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation: { action: 'acceptProposal', proposalId: proposal.id } }, { user: true });
    assert.equal(accepted.chapters[0].body, original.slice(0, selection.start) + replacement + original.slice(selection.end));
    assert.equal(accepted.chapters[0].body.indexOf(repeated), original.indexOf(repeated), 'first repeated occurrence is untouched');
    assert.equal(accepted.chapters[0].history.length, f.book.chapters[0].history.length + 1);
    assert.equal(accepted.chapters[0].history.at(-1).body, original); assert.equal(accepted.chapters[0].history.at(-1).reason, 'accept-polish');
    assert.equal(accepted.chapters[0].summary, '原摘要'); assert.equal(accepted.chapters[0].summaryRevision, null);
  } finally { await f.service.close(); }
});

test('partial stream exposes detached selection/model metadata but leaves saved manuscript/proposals untouched', async () => {
  const partial = deferred(), release = deferred();
  const f = await fixture(async args => { args.onText('半段😀'); partial.resolve(); await release.promise; return { text: replacement }; });
  try {
    const { jobId } = await f.service.dispatch(f.request); await partial.promise;
    f.request.selection.text = 'caller changed'; f.request.selection.start = 0;
    f.setModel({ provider: 'other', model: 'never-use' });
    const job = await f.service.dispatch({ action: 'job', jobId });
    assert.equal(job.status, 'running'); assert.equal(job.text, '半段😀'); assert.deepEqual(job.selection, selection); assert.deepEqual(job.model, model); noPrivateRequest(job);
    job.selection.text = 'public changed'; job.model.model = 'public changed';
    const list = await f.service.dispatch({ action: 'list' });
    assert.equal(list.activeJobs.length, 1); assert.deepEqual(list.activeJobs[0].selection, selection);
    list.activeJobs[0].selection.start = 0; list.activeJobs[0].model.model = 'list changed';
    assert.deepEqual((await f.service.dispatch({ action: 'job', jobId })).selection, selection);
    assert.deepEqual((await f.service.dispatch({ action: 'job', jobId })).model, model);
    assert.deepEqual(await f.get(), f.book);
    release.resolve(); await f.service.live.get(jobId).promise;
    assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].model, model);
    assert.deepEqual((await f.get()).proposals[0].selection, selection);
  } finally { release.resolve(); await f.service.close(); }
});

test('generation freezes exact selection/chapter before awaiting model resolution', async () => {
  const resolving = deferred(), release = deferred();
  const preferences = { effective: () => model, snapshot: () => ({ revision: 1 }), async resolve() { resolving.resolve(); await release.promise; return structuredClone(model); }, async close() {} };
  const f = await fixture(undefined, preferences);
  try {
    const starting = f.service.dispatch(f.request); await resolving.promise;
    f.request.selection.start = 0; f.request.selection.text = 'mutated during await'; f.request.chapterId = 'wrong-chapter';
    release.resolve(); const { jobId } = await starting; await f.service.live.get(jobId).promise;
    const job = await f.service.dispatch({ action: 'job', jobId });
    assert.equal(job.status, 'completed'); assert.deepEqual(job.selection, selection); assert.equal(job.chapterId, f.book.chapters[0].id);
    assert.deepEqual((await f.get()).proposals[0].selection, selection); assert.equal(f.calls.length, 1);
  } finally { release.resolve(); await f.service.close(); }
});

test('public job metadata survives backend reopen without exposing private provenance', async () => {
  const f = await fixture();
  try {
    const { job } = await f.generate(); await f.service.close();
    const reopened = await new NovelStore(f.backend).init();
    const service = new NovelService(reopened, { getModel: () => model, runModel: () => { throw new Error('Reopen must never generate'); } });
    try {
      const resumed = await service.dispatch({ action: 'job', jobId: job.id });
      assert.deepEqual(resumed, job); noPrivateRequest(resumed);
      resumed.selection.text = 'detached'; assert.deepEqual((await service.dispatch({ action: 'job', jobId: job.id })).selection, selection);
    } finally { await service.close(); }
  } finally { if (!f.service.closed) await f.service.close(); }
});

test('tool-style dispatch cannot accept even when payload claims user=true; author reject writes no manuscript', async () => {
  const f = await fixture();
  try {
    const { job, book } = await f.generate(); const before = structuredClone(book.chapters);
    const input = { action: 'mutate', bookId: book.id, expectedRevision: book.revision, user: true, operation: { action: 'acceptProposal', proposalId: job.proposalId } };
    const writes = f.backend.writes.length;
    await assert.rejects(f.service.dispatch(input), { code: 'AUTHOR_ONLY' });
    assert.equal(f.backend.writes.length, writes); assert.deepEqual(await f.get(), book);
    const rejected = await f.service.dispatch({ ...input, operation: { action: 'rejectProposal', proposalId: job.proposalId } }, { user: true });
    assert.deepEqual(rejected.chapters, before); assert.equal(rejected.proposals[0].state, 'rejected');
  } finally { await f.service.close(); }
});

for (const kind of ['manual-body', 'chapter-title', 'revision-only', 'source-body-only']) test(`${kind} stale source refuses acceptance with current CAS and zero writes`, async () => {
  const f = await fixture();
  try {
    const { job, book } = await f.generate(); let current = book;
    const edit = async patch => { current = await f.service.dispatch({ action: 'mutate', bookId: current.id, expectedRevision: current.revision, operation: { action: 'updateChapter', chapterId: current.chapters[0].id, patch } }); };
    if (kind === 'manual-body') await edit({ body: original + '\r\n作者手改' });
    if (kind === 'chapter-title') await edit({ title: '作者改标题' });
    if (kind === 'revision-only') { await edit({ title: '临时标题' }); await edit({ title: book.chapters[0].title }); assert.equal(current.chapters[0].body, original); }
    if (kind === 'source-body-only') {
      // Deliberate isolated store seam: keep revision identical to independently
      // exercise the full-source guard, not an ordinary author edit or live file.
      current = structuredClone(current); current.chapters[0].body += '存储源变化';
      current = await f.store.commit(current); assert.equal(current.chapters[0].revision, job.sourceRevision);
    }
    const writes = f.backend.writes.length, snapshot = structuredClone(current);
    await assert.rejects(f.service.dispatch({ action: 'mutate', bookId: current.id, expectedRevision: current.revision, operation: { action: 'acceptProposal', proposalId: job.proposalId } }, { user: true }), { code: 'STALE_PROPOSAL' });
    assert.equal(f.backend.writes.length, writes); assert.deepEqual(await f.get(), snapshot);
  } finally { await f.service.close(); }
});

test('old-CAS double click rejects before any second manuscript/history write', async () => {
  const f = await fixture();
  try {
    const { job, book } = await f.generate(); const input = { action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation: { action: 'acceptProposal', proposalId: job.proposalId } };
    const accepted = await f.service.dispatch(input, { user: true }), writes = f.backend.writes.length;
    await assert.rejects(f.service.dispatch(input, { user: true }), { code: 'CONFLICT' });
    assert.equal(f.backend.writes.length, writes); assert.deepEqual(await f.get(), accepted);
  } finally { await f.service.close(); }
});

for (const kind of ['failure', 'TRUNCATED', 'cancel']) test(`${kind} leaves no ready proposal or manuscript change`, async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture(async args => {
    args.onText('不完整😀'); entered.resolve(); await release.promise;
    if (kind !== 'cancel') throw Object.assign(new Error(kind === 'TRUNCATED' ? 'Generation did not finish (max-tokens)' : 'local adapter failure'), { code: kind });
    return { text: replacement };
  });
  try {
    const { jobId } = await f.service.dispatch(f.request); await entered.promise;
    if (kind === 'cancel') await f.service.dispatch({ action: 'cancel', jobId });
    release.resolve(); await f.service.live.get(jobId).promise;
    const job = await f.service.dispatch({ action: 'job', jobId });
    assert.equal(job.status, kind === 'cancel' ? 'cancelled' : 'failed'); assert.equal(job.proposalId, undefined);
    assert.equal(f.calls.length, 1); assert.deepEqual(await f.get(), f.book);
  } finally { release.resolve(); await f.service.close(); }
});

for (const kind of ['wrong-text', 'split-surrogate', 'old-revision']) test(`invalid ${kind} request rejects before model/provenance/book writes`, async () => {
  const f = await fixture();
  try {
    const request = structuredClone(f.request);
    if (kind === 'wrong-text') request.selection.text += '错';
    if (kind === 'split-surrogate') { request.selection.start = original.indexOf('🌙') + 1; request.selection.end = request.selection.start + 1; request.selection.text = original.slice(request.selection.start, request.selection.end); }
    if (kind === 'old-revision') request.expectedRevision--;
    const writes = f.backend.writes.length;
    await assert.rejects(f.service.dispatch(request), { code: kind === 'old-revision' ? 'CONFLICT' : 'VALIDATION' });
    assert.equal(f.calls.length, 0); assert.equal(f.store.jobs.size, 0); assert.equal(f.backend.writes.length, writes); assert.deepEqual(await f.get(), f.book);
  } finally { await f.service.close(); }
});
