import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NovelStore, NovelService } from '../service.js';
import { createBook, mutateBook } from '../core.js';

// Isolated JSON-persisting memory KV fixture. No installed profile, live book,
// provider discovery, model preferences, credentials or paid model calls.
function jsonBackend() {
  const files = new Map(), writes = []; let fail = false;
  return { files, writes, setFail(value) { fail = value; }, snapshot() { return [...files.entries()]; },
    read(name) { return JSON.parse(files.get(name)); },
    kv: { async open(spec) {
      assert.equal(spec.layout, 'single'); assert.equal(spec.version, 1);
      if (!files.has(spec.name)) files.set(spec.name, JSON.stringify({ tables: Object.fromEntries(spec.tables.map(table => [table, {}])), global: null }));
      return {
        async loadAll() { return JSON.parse(files.get(spec.name)); },
        async putRecord(table, key, value) {
          if (fail) throw new Error('fixture write failed');
          const data = JSON.parse(files.get(spec.name)); data.tables[table][key] = value;
          const json = JSON.stringify(data); files.set(spec.name, json); writes.push({ name: spec.name, table, key });
        },
        async deleteRecord(table, key) {
          const data = JSON.parse(files.get(spec.name)); delete data.tables[table][key]; files.set(spec.name, JSON.stringify(data));
        },
        async close() {},
      };
    } },
  };
}
const condition = (patch = {}) => ({ id: randomUUID(), category: '环境', content: '雨声与人物行动相互呼应🙂\r\n不要凭空增加情节。', enabled: true, ...patch });
const rows = () => [condition(), condition({ enabled: false, category: 'DISABLED_PRIVATE_CATEGORY', content: 'DISABLED_PRIVATE_CONTENT' }), condition({ category: '自由分类 / expression', content: '完整保留对话动机。LAST_CONSTRAINT_🙂\r\n' })];
const original = '甲🙂望向窗外。\r\n“走吗？”\r\n乙点头。';
const output = '甲🙂望向雨幕。\r\n“走吗？”\r\n乙点头。';
const analysis = '保留既有事实，让对话与动作自然衔接。';
const mutate = (book, operation) => ({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation });
const update = (service, book, writingConstraints, extra = {}) => service.dispatch(mutate(book, { action: 'updateBook', patch: { writingConstraints, ...extra } }));
const get = (service, book) => service.dispatch({ action: 'get', bookId: book.id });
const request = (book, mode) => ({ action: 'generate', bookId: book.id, chapterId: book.chapters[0].id, expectedRevision: book.revision, mode, instruction: '改善文学表达，不增添事实。', selection: mode === 'polish' ? { start: 1, end: 3, text: '🙂' } : null });
function block(prompt) {
  const match = prompt.match(/【全书写作条件（完整硬约束；启用 (\d+) 条）】\n([^\n]+)/u);
  assert.ok(match, 'actual model prompt has mandatory conditions block');
  return { raw: match[0], payload: JSON.parse(match[2]) };
}
function assertConditions(prompt, conditions) {
  assert.deepEqual(block(prompt).payload.conditions, conditions.filter(row => row.enabled).map(({ category, content }) => ({ category, content })));
  assert.ok(!prompt.includes('DISABLED_PRIVATE_'));
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(runner, { constraints = rows(), contextBudget = 18000 } = {}) {
  const disk = jsonBackend(), store = await new NovelStore(disk).init(), calls = [];
  let modelReads = 0;
  const service = new NovelService(store, { getModel: () => { modelReads++; return { provider: 'fixture-only', model: 'capturing-adapter' }; },
    async runModel(args) {
      calls.push(args);
      // Inspect the actual adapter boundary, not a re-created or mocked context.
      const id = args.jobId.replace(/-(analysis|revise)$/u, '');
      const durable = disk.read('ycx_moxu_index').tables.jobs[id];
      assert.ok(durable, 'durable job exists before every paid-call boundary');
      assert.equal(args.prompt, args.jobId.endsWith('-revise') ? durable.request.rewritePrompt : durable.request.prompt);
      if (args.jobId.endsWith('-revise')) assert.equal(durable.phase, 'optimizing');
      assert.deepEqual(args.model, { provider: 'fixture-only', model: 'capturing-adapter' });
      assert.equal(typeof args.onText, 'function'); assert.ok(args.signal instanceof AbortSignal);
      return runner ? runner(args, calls.length) : { text: args.jobId.endsWith('-analysis') ? analysis : output, sessionId: 'fixture-' + args.jobId };
    },
  });
  let book = await service.dispatch({ action: 'create', title: '持久条件服务隔离夹具' });
  assert.deepEqual(book.writingConstraints, []);
  book = await service.dispatch(mutate(book, { action: 'addChapter', title: '雨夜' }));
  book = await service.dispatch(mutate(book, { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: original } }));
  book = await update(service, book, constraints, { contextBudget });
  return { disk, store, service, book, calls, modelReads: () => modelReads };
}
async function finish(f, jobId) {
  await f.service.live.get(jobId).promise;
  const job = await f.service.dispatch({ action: 'job', jobId });
  assert.equal(job.status, 'completed', job.error);
  return job;
}

for (const mode of ['draft', 'continue', 'polish', 'summary', 'revise']) test(`${mode}: actual service adapter receives complete conditions at every paid boundary and only creates proposals`, async () => {
  const f = await fixture();
  try {
    const req = request(f.book, mode);
    const context = await f.service.dispatch({ ...req, action: 'context' });
    const { jobId } = await f.service.dispatch(req), job = await finish(f, jobId);
    assert.equal(f.calls.length, mode === 'revise' ? 2 : 1, 'no extra condition-analysis model call');
    assert.equal(f.calls[0].prompt, context.prompt);
    for (const call of f.calls) {
      assertConditions(call.prompt, f.book.writingConstraints);
      assert.ok(call.prompt.includes('LAST_CONSTRAINT_'));
      assert.ok(call.prompt.length <= f.book.contextBudget);
    }
    if (mode === 'revise') {
      assert.equal(block(f.calls[0].prompt).raw, block(f.calls[1].prompt).raw);
      assert.ok(f.calls[0].jobId.endsWith('-analysis')); assert.ok(f.calls[1].jobId.endsWith('-revise'));
      const durable = f.store.jobs.get(jobId);
      assert.ok(f.calls.every(call => call.prompt.startsWith(durable.request.basePrompt)));
      assert.ok(f.calls[1].prompt.includes(JSON.stringify({ analysis })));
    }
    if (mode === 'polish') assert.ok(f.calls[0].prompt.includes(JSON.stringify(req.selection)));
    if (mode === 'summary') assert.ok(f.calls[0].prompt.includes(JSON.stringify({ text: original })));
    const current = await get(f.service, f.book);
    assert.deepEqual(current.writingConstraints, f.book.writingConstraints);
    assert.deepEqual(current.chapters, f.book.chapters, 'generation never edits the source manuscript');
    assert.equal(current.proposals.length, 1);
    assert.equal(current.proposals[0].id, job.proposalId); assert.equal(current.proposals[0].state, 'ready');
    assert.equal(current.proposals[0].sourceBody, original);
    assert.equal(current.proposals[0].context.omitted.filter(item => item.includes('全书写作条件')).length, 1);
    assert.ok(!JSON.stringify(current.proposals[0].context).includes('DISABLED_PRIVATE_'));
  } finally { await f.service.close(); }
});

test('ordered constraints persist through JSON-store close/reopen, full export/import and stale concurrent CAS', async () => {
  const f = await fixture(); let reopened;
  try {
    const first = f.book.writingConstraints;
    const reordered = [{ ...first[2], content: '新表达🙂\r\n保持换行', enabled: false }, { ...first[0], category: '自定义环境' }];
    const attempts = await Promise.allSettled([update(f.service, f.book, reordered), update(f.service, f.book, [])]);
    assert.deepEqual(attempts.map(result => result.status), ['fulfilled', 'rejected']);
    assert.equal(attempts[1].reason.code, 'CONFLICT');
    const saved = attempts[0].value;
    assert.deepEqual(saved.writingConstraints, reordered); assert.deepEqual(saved.chapters, f.book.chapters);
    const json = await f.service.dispatch({ action: 'export', bookId: saved.id, format: 'json' });
    assert.deepEqual(JSON.parse(json.text).writingConstraints, reordered);
    const markdown = await f.service.dispatch({ action: 'export', bookId: saved.id, format: 'markdown' });
    assert.ok(markdown.text.includes(original)); assert.ok(!markdown.text.includes('新表达')); assert.ok(!markdown.text.includes('自定义环境'));
    const imported = await f.service.dispatch({ action: 'import', text: json.text });
    assert.deepEqual(imported.writingConstraints.map(({ id, ...value }) => value), reordered.map(({ id, ...value }) => value));
    assert.notEqual(imported.id, saved.id);
    for (let index = 0; index < reordered.length; index++) assert.notEqual(imported.writingConstraints[index].id, reordered[index].id);
    await f.service.close();
    const writes = f.disk.writes.length;
    const store = await new NovelStore(f.disk).init();
    reopened = new NovelService(store, { getModel: () => ({ provider: 'fixture-only', model: 'capturing-adapter' }), runModel: () => assert.fail('read/reopen must never call model') });
    assert.deepEqual(await get(reopened, saved), saved);
    assert.deepEqual((await get(reopened, imported)).writingConstraints, imported.writingConstraints);
    assert.equal(f.disk.writes.length, writes, 'reopen validation does not rewrite any book');
    const after = await update(reopened, saved, []);
    assert.deepEqual(after.writingConstraints, []);
    await assert.rejects(update(reopened, saved, reordered), { code: 'CONFLICT' });
  } finally { if (reopened) await reopened.close(); if (!f.service.closed) await f.service.close(); }
});

test('old missing-field book survives get/list/context/export and reopen without read migration or writes', async () => {
  const disk = jsonBackend(); let store = await new NovelStore(disk).init();
  let old = mutateBook(createBook('旧版隔离夹具'), { action: 'addChapter', title: '第一章' }); delete old.writingConstraints;
  await store.insert(old); await store.close();
  const before = disk.snapshot(), writes = disk.writes.length;
  store = await new NovelStore(disk).init();
  const service = new NovelService(store, { getModel: () => ({ provider: 'fixture', model: 'never-called' }), runModel: () => assert.fail('no model on reads') });
  try {
    assert.deepEqual(await get(service, old), old);
    await service.dispatch({ action: 'list' });
    await service.dispatch({ action: 'context', bookId: old.id, chapterId: old.chapters[0].id, mode: 'draft' });
    const json = await service.dispatch({ action: 'export', bookId: old.id, format: 'json' });
    assert.equal(Object.hasOwn(JSON.parse(json.text), 'writingConstraints'), false);
    assert.equal(disk.writes.length, writes); assert.deepEqual(disk.snapshot(), before, 'all read operations leave persisted JSON bytes unchanged');
    const renamed = await service.dispatch(mutate(old, { action: 'updateBook', patch: { title: '旧版只改标题' } }));
    assert.equal(Object.hasOwn(renamed, 'writingConstraints'), false);
    assert.equal(disk.writes.length, writes + 1, 'only explicit rename wrote once');
    // The prior reads did not rewrite bytes; the sole changed unit is the rename.
    assert.equal(disk.snapshot().filter(([name, value], index) => value !== before[index][1]).length, 1);
  } finally { await service.close(); }
  const reopened = await new NovelStore(disk).init();
  try { assert.equal(Object.hasOwn(await reopened.load(old.id), 'writingConstraints'), false); }
  finally { await reopened.close(); }
});

test('invalid constraint mutation, failed persistence and stale CAS leave both committed memory and JSON bytes atomic', async () => {
  const f = await fixture();
  try {
    const before = f.disk.snapshot(), writes = f.disk.writes.length;
    for (const bad of [[condition({ content: '' })], [condition({ extra: true })], [condition({ id: f.book.id })], new Array(1), Array.from({ length: 65 }, () => condition())]) {
      await assert.rejects(update(f.service, f.book, bad), { code: 'VALIDATION' });
      assert.deepEqual(await get(f.service, f.book), f.book); assert.deepEqual(f.disk.snapshot(), before);
    }
    assert.equal(f.disk.writes.length, writes);
    f.disk.setFail(true);
    await assert.rejects(update(f.service, f.book, [condition({ content: '不得提交' })]), /fixture write failed/u);
    f.disk.setFail(false);
    assert.deepEqual(await get(f.service, f.book), f.book); assert.deepEqual(f.disk.snapshot(), before);
    const saved = await update(f.service, f.book, []);
    await assert.rejects(update(f.service, f.book, rows()), { code: 'CONFLICT' });
    assert.deepEqual(await get(f.service, f.book), saved); assert.equal(f.calls.length, 0);
  } finally { f.disk.setFail(false); await f.service.close(); }
});

for (const mode of ['draft', 'continue', 'polish', 'summary', 'revise']) test(`${mode}: mandatory constraints over budget reject before adapter call, model lookup, or durable job writes`, async () => {
  const constraints = Array.from({ length: 3 }, (_, index) => condition({ content: `条件 ${index}` + '满'.repeat(3990) }));
  const f = await fixture(null, { constraints, contextBudget: 10000 });
  try {
    const before = f.disk.snapshot(), writes = f.disk.writes.length;
    await assert.rejects(f.service.dispatch({ ...request(f.book, mode), action: 'context' }), { code: 'CONTEXT_BUDGET' });
    await assert.rejects(f.service.dispatch(request(f.book, mode)), { code: 'CONTEXT_BUDGET' });
    assert.equal(f.calls.length, 0); assert.equal(f.modelReads(), 0); assert.equal(f.store.jobs.size, 0); assert.equal(f.service.live.size, 0);
    assert.equal(f.disk.writes.length, writes); assert.deepEqual(f.disk.snapshot(), before); assert.deepEqual(await get(f.service, f.book), f.book);
  } finally { await f.service.close(); }
});

for (const mode of ['draft', 'continue', 'polish', 'summary', 'revise']) test(`${mode}: updating constraints mid-job affects NEXT job only, with no reread between optimization stages`, async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture(async (args, count) => {
    if (count === 1) { entered.resolve(); await release.promise; }
    return { text: args.jobId.endsWith('-analysis') ? analysis : output };
  });
  try {
    const { jobId } = await f.service.dispatch(request(f.book, mode)); await entered.promise;
    const snapshotPrompt = f.calls[0].prompt;
    const replacement = [condition({ category: 'UPDATED_CATEGORY', content: 'NEXT_JOB_ONLY_🙂\r\n新条件' }), ...f.book.writingConstraints.map(row => ({ ...row, enabled: false }))];
    const changed = await update(f.service, f.book, replacement);
    assert.deepEqual(changed.chapters, f.book.chapters);
    const storedWhileRunning = f.disk.read('ycx_moxu_index').tables.jobs[jobId];
    assert.equal(storedWhileRunning.request.prompt, snapshotPrompt);
    release.resolve(); await finish(f, jobId);
    const firstCalls = f.calls.length;
    assert.equal(firstCalls, mode === 'revise' ? 2 : 1);
    for (const call of f.calls) {
      assertConditions(call.prompt, f.book.writingConstraints);
      assert.ok(!call.prompt.includes('NEXT_JOB_ONLY_'));
      assert.equal(block(call.prompt).raw, block(snapshotPrompt).raw);
    }
    const current = await get(f.service, f.book);
    assert.deepEqual(current.writingConstraints, replacement, 'result commit retains concurrent constraint edit');
    assert.deepEqual(current.chapters, f.book.chapters); assert.equal(current.proposals[0].sourceBody, original);
    const { jobId: nextId } = await f.service.dispatch(request(current, mode)); await finish(f, nextId);
    assert.equal(f.calls.length, firstCalls * 2);
    for (const call of f.calls.slice(firstCalls)) {
      assertConditions(call.prompt, replacement);
      assert.ok(call.prompt.includes('NEXT_JOB_ONLY_'));
      assert.ok(!call.prompt.includes('LAST_CONSTRAINT_'), 'new disabled conditions are never reread from prior enabled snapshot');
    }
  } finally { release.resolve(); await f.service.close(); }
});
