import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ModelPreferences } from '../selection.js';
import { NovelService, NovelStore } from '../service.js';

const author = { user: true };
const original = '雨落下来。😀\r\n她推开窗。';
const savedOutline = '从雨夜开始；窗外的人还没现身。';
const generatedOutline = `# 本章细纲\r\n- 雨夜里的误会：${'保留自然停顿。'.repeat(400)}\n- 收束：窗上的记号🪟`;
const writer = { provider: 'local-fixture', model: 'writer', reasoningEffort: 'low' };
const alternate = { provider: 'local-fixture', model: 'alternate' };
const update = (book, operation) => ({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation });
const get = (service, id) => service.dispatch({ action: 'get', bookId: id });
const generate = (book, overrides = {}) => ({ action: 'generate', bookId: book.id, chapterId: book.chapters[0].id,
  expectedRevision: book.revision, expectedModelRevision: 1, mode: 'outline', instruction: '先列情节节点，不写正文。', ...overrides });
const accept = (book, proposalId) => update(book, { action: 'acceptProposal', proposalId });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// All KV writes round-trip JSON in a fresh map; all model operations are local
// doubles. These tests never open a real book or contact a model provider.
async function fixture(runner, { blankChapter = false } = {}) {
  const files = new Map(), calls = [], modelResolutions = [];
  let defaultModel = writer;
  const backend = { kv: { async open({ name, tables }) {
    if (!files.has(name)) files.set(name, JSON.stringify({ tables: Object.fromEntries(tables.map(table => [table, {}])), global: null }));
    const read = () => JSON.parse(files.get(name));
    return {
      async loadAll() { return read(); },
      async putRecord(table, key, value) {
        const db = read(); db.tables[table][key] = value; files.set(name, JSON.stringify(db));
      },
      async close() {},
    };
  } } };
  const store = await new NovelStore(backend).init();
  const prefs = await new ModelPreferences(backend, { async resolveCallConfig(route) { modelResolutions.push(route); return route; } }, () => defaultModel).init();
  const durableJob = id => JSON.parse(files.get('ycx_moxu_index')).tables.jobs[id];
  const service = new NovelService(store, { modelPreferences: prefs, async runModel(args) {
    calls.push(args);
    const persisted = durableJob(args.jobId);
    assert.equal(persisted?.status, 'running', 'provenance must be durable before any adapter call');
    assert.equal(persisted.request.prompt, args.prompt);
    assert.deepEqual(persisted.request.model, args.model);
    return runner ? runner(args, calls.length) : { text: generatedOutline };
  } });
  let book = await service.dispatch({ action: 'create', title: '章节细纲隔离测试' });
  book = await service.dispatch(update(book, { action: 'addChapter', title: '雨夜' }));
  if (!blankChapter) {
    book = await service.dispatch(update(book, { action: 'updateChapter', chapterId: book.chapters[0].id,
      patch: { body: original, outline: savedOutline, summary: '她推开窗。' } }), author);
  }
  return { backend, files, store, service, book, calls, modelResolutions, durableJob, setDefault(model) { defaultModel = model; } };
}

async function settled(service, jobId) {
  await service.live.get(jobId).promise;
  return service.dispatch({ action: 'job', jobId });
}

test('Agent payload cannot claim author authority to generate or preview an outline', async () => {
  const f = await fixture();
  try {
    const before = [...f.files];
    for (const action of ['generate', 'context']) {
      await assert.rejects(f.service.dispatch(generate(f.book, { action, user: true }), { user: false }), { code: 'AUTHOR_ONLY' });
      await assert.rejects(f.service.dispatch(generate(f.book, { action })), { code: 'AUTHOR_ONLY' });
    }
    // Mutating the caller's request after dispatch cannot evade the captured mode check.
    const input = generate(f.book, { action: 'context', mode: 'summary' });
    const preview = f.service.dispatch(input);
    input.mode = 'outline';
    assert.match((await preview).prompt, /"mode":"summary"/u);
    const authorPreview = await f.service.dispatch(generate(f.book, { action: 'context' }), author);
    assert.match(authorPreview.prompt, /"mode":"outline"/u);
    assert.deepEqual([...f.files], before);
    assert.equal(f.calls.length, 0); assert.equal(f.modelResolutions.length, 0);
  } finally { await f.service.close(); }
});

test('author must use saved chapter and current book/model revisions before any outline adapter work', async () => {
  const f = await fixture();
  try {
    const before = [...f.files];
    for (const [overrides, code] of [
      [{ chapterId: randomUUID() }, 'NOT_FOUND'],
      [{ expectedRevision: f.book.revision - 1 }, 'CONFLICT'],
      [{ expectedModelRevision: 0 }, 'MODEL_CONFLICT'],
    ]) await assert.rejects(f.service.dispatch(generate(f.book, overrides), author), { code });
    assert.deepEqual([...f.files], before);
    assert.equal(f.calls.length, 0); assert.equal(f.modelResolutions.length, 0); assert.equal(f.store.jobs.size, 0);
  } finally { await f.service.close(); }
});

test('one outline model call writes only a durable proposal; author adoption feeds a full mandatory draft block', async () => {
  // A saved blank chapter can be outlined before the author has written prose.
  const f = await fixture((_args, count) => ({ text: count === 1 ? generatedOutline : '正文候选，尚未采纳。' }), { blankChapter: true });
  let service = f.service;
  try {
    const req = generate(f.book);
    const preview = await service.dispatch({ ...req, action: 'context' }, author);
    const { jobId } = await service.dispatch(req, author);
    const job = await settled(service, jobId);
    assert.equal(job.status, 'completed', job.error); assert.equal(job.mode, 'outline');
    assert.equal(job.sourceRevision, f.book.chapters[0].revision); assert.equal(job.modelSettingsRevision, 1);
    assert.deepEqual(job.model, writer); assert.equal(job.request, undefined);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].maxTokens, 2048); assert.equal(f.calls[0].prompt, preview.prompt);
    assert.equal(f.durableJob(jobId).request.sourceBookRevision, f.book.revision);
    assert.equal(f.durableJob(jobId).request.sourceOutline, '');
    const withProposal = await get(service, f.book.id);
    assert.deepEqual(withProposal.chapters, f.book.chapters);
    const [proposal] = withProposal.proposals;
    assert.equal(proposal.id, job.proposalId); assert.equal(proposal.mode, 'outline'); assert.equal(proposal.state, 'ready');
    assert.equal(proposal.text, generatedOutline); assert.equal(proposal.selection, null);

    await service.close();
    service = new NovelService(await new NovelStore(f.backend).init(), { getModel: () => writer, async runModel(args) {
      f.calls.push(args);
      return { text: '起草的正文候选。' };
    } });
    assert.deepEqual((await get(service, f.book.id)).proposals, [proposal]);
    await assert.rejects(service.dispatch(accept(withProposal, proposal.id)), { code: 'AUTHOR_ONLY' });
    assert.deepEqual(await get(service, f.book.id), withProposal);
    const accepted = await service.dispatch(accept(withProposal, proposal.id), author);
    assert.deepEqual(accepted.chapters[0], { ...f.book.chapters[0], outline: generatedOutline, revision: f.book.chapters[0].revision + 1 });
    assert.equal(accepted.proposals[0].state, 'accepted');

    const draft = generate(accepted, { mode: 'draft', instruction: '写一版正文。' });
    const draftPreview = await service.dispatch({ ...draft, action: 'context' });
    const { jobId: draftId } = await service.dispatch(draft);
    const draftJob = await settled(service, draftId);
    assert.equal(draftJob.status, 'completed', draftJob.error);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].maxTokens, 8192);
    assert.equal(f.calls[1].prompt, draftPreview.prompt);
    const full = f.calls[1].prompt.match(/【本章细纲（完整；严格遵循的创作计划）】\n([^\n]+)/u);
    assert.ok(full, 'actual draft adapter prompt must show the mandatory outline section');
    assert.deepEqual(JSON.parse(full[1]), { text: generatedOutline }, 'exact complete Markdown, including emoji, line endings, and tail beyond the old cap');
    assert.deepEqual((await get(service, f.book.id)).chapters, accepted.chapters);
  } finally { if (!service.closed) await service.close(); }
});

for (const patch of [{ outline: '作者手动重排细纲。' }, { body: '作者提交了新正文。' }]) {
  test(`outline result retains start-time source and model; changing ${Object.keys(patch)[0]} makes adoption stale`, async () => {
    const gate = deferred();
    const f = await fixture(async () => { await gate.promise; return { text: generatedOutline }; });
    try {
      const { jobId } = await f.service.dispatch(generate(f.book), author);
      const changed = await f.service.dispatch(update(f.book, { action: 'updateChapter', chapterId: f.book.chapters[0].id, patch }), author);
      f.setDefault(alternate);
      await f.service.dispatch({ action: 'setModel', selection: null, expectedRevision: 1 });
      gate.resolve();
      const job = await settled(f.service, jobId);
      assert.equal(job.status, 'completed', job.error);
      assert.equal(f.calls.length, 1); assert.deepEqual(f.modelResolutions, [writer]); assert.deepEqual(job.model, writer);
      assert.equal(job.modelSettingsRevision, 1);
      const source = f.durableJob(jobId).request;
      assert.equal(source.sourceOutline, savedOutline); assert.equal(source.sourceBody, original);
      const latest = await get(f.service, f.book.id);
      assert.deepEqual(latest.chapters, changed.chapters);
      assert.equal(latest.proposals[0].sourceRevision, f.book.chapters[0].revision);
      assert.equal(latest.proposals[0].sourceBody, original);
      await assert.rejects(f.service.dispatch(accept(latest, job.proposalId), author), { code: 'STALE_PROPOSAL' });
      assert.deepEqual(await get(f.service, f.book.id), latest);
    } finally { gate.resolve(); await f.service.close(); }
  });
}

test('draft with an over-budget saved outline rejects before model lookup or job persistence', async () => {
  const f = await fixture();
  try {
    const book = await f.service.dispatch(update(f.book, { action: 'updateChapter', chapterId: f.book.chapters[0].id,
      patch: { outline: '不可裁剪🙂\r\n'.repeat(3000) } }), author);
    const before = [...f.files];
    await assert.rejects(f.service.dispatch(generate(book, { mode: 'draft' })), error => error?.code === 'CONTEXT_BUDGET' && /本章细纲/u.test(error.message));
    assert.deepEqual([...f.files], before);
    assert.equal(f.calls.length, 0); assert.equal(f.modelResolutions.length, 0); assert.equal(f.store.jobs.size, 0);
  } finally { await f.service.close(); }
});
