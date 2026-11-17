import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NovelStore, NovelService } from '../service.js';
import { optimizationContext, optimizationRewriteContext, ANALYSIS_LIMIT } from '../optimization.js';

const original = '他问：“去吗？”\r\n\r\n她点头。\r\n\r\n窗外的雨没有停。';
const optimized = '他望着她：“雨还没停，你真要去吗？”\r\n\r\n她点头：“必须去，别担心。”\r\n\r\n窗外的雨没有停。';
const analysis = '保留雨夜出行的情节，增加回应和自然停顿，避免问答生硬。';
function backend() {
  const files = new Map(); let fault = () => {};
  return { files, fail: next => { fault = next || (() => {}); }, kv: { async open(spec) {
    if (!files.has(spec.name)) files.set(spec.name, { tables: Object.fromEntries(spec.tables.map(t => [t, {}])), global: null });
    const data = files.get(spec.name);
    return { async loadAll() { return structuredClone(data); },
      async putRecord(table, key, value) { fault(spec.name, table, key, value); data.tables[table][key] = structuredClone(value); },
      async deleteRecord(table, key) { delete data.tables[table][key]; }, async close() {} };
  } } };
}
async function fixture(customRunner) {
  const disk = backend(), store = await new NovelStore(disk).init();
  const calls = [], initialModel = { provider: 'fixture', model: 'writer', reasoningEffort: 'high' };
  let selected = initialModel;
  const service = new NovelService(store, { getModel: () => selected, async runModel(args) {
    calls.push(args);
    const stored = disk.files.get('ycx_moxu_index').tables.jobs[args.jobId.replace(/-(analysis|revise)$/, '')];
    assert(stored, 'no model call before durable job provenance');
    if (args.jobId.endsWith('-revise')) { assert.equal(stored.phase, 'optimizing'); assert.equal(stored.request.rewritePrompt, args.prompt); }
    else assert.equal(stored.request.prompt, args.prompt);
    return customRunner ? customRunner(args, calls.length) : { text: calls.length === 1 ? analysis : optimized, sessionId: 'local-' + args.jobId };
  } });
  let book = await service.dispatch({ action: 'create', title: '需求优化隔离测试' });
  book = await service.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation: { action: 'addChapter', title: '雨夜' } });
  book = await service.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation: { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: original } } });
  const request = { action: 'generate', bookId: book.id, chapterId: book.chapters[0].id, expectedRevision: book.revision, mode: 'revise', instruction: '对话：太过生硬，且对话比较少。' };
  return { disk, store, service, calls, book, request, changeModel: value => { selected = value; } };
}

// These fixtures use a local runModel double. Actual installed LLM/session/JSON
// integration is verified separately, not claimed by these unit/dispatch tests.
test('two-stage targeted optimization stores exact phase prompts, one model snapshot and no automatic manuscript writes', async () => {
  const f = await fixture();
  try {
    const context = await f.service.dispatch({ ...f.request, action: 'context' });
    assert.equal(context.report.usedChars, context.prompt.length); assert(context.prompt.includes(original.replaceAll('\r', '\\r').replaceAll('\n', '\\n')));
    const { jobId } = await f.service.dispatch(f.request), live = f.service.live.get(jobId);
    f.changeModel({ provider: 'different', model: 'do-not-use' });
    await live.promise;
    assert.equal(live.status, 'completed'); assert.equal(live.phase, 'review'); assert.equal(f.calls.length, 2);
    assert(f.calls[0].jobId.endsWith('-analysis')); assert(f.calls[1].jobId.endsWith('-revise'));
    assert.equal(f.calls[0].prompt, context.prompt); assert(f.calls[1].prompt.includes(analysis));
    assert.deepEqual(f.calls.map(call => call.model), [live.model, live.model]);
    assert.equal(live.analysis, analysis); assert(live.analysisSessionId); assert(live.sessionId);
    const book = await f.service.dispatch({ action: 'get', bookId: f.book.id });
    assert.equal(book.chapters[0].body, original); assert.deepEqual(book.chapters[0].history, f.book.chapters[0].history);
    const proposal = book.proposals[0]; assert.equal(proposal.mode, 'revise'); assert.equal(proposal.text, optimized); assert.equal(proposal.review.analysis, analysis);
    assert(proposal.review.hunks.length > 0); assert(proposal.review.hunks.every(hunk => hunk.state === 'pending'));
    for (const action of ['acceptRevisionHunk', 'rejectRevisionHunk']) await assert.rejects(f.service.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation: { action, proposalId: proposal.id, hunkId: proposal.review.hunks[0].id } }), { code: 'AUTHOR_ONLY' });
    const reopened = await new NovelStore(f.disk).init();
    assert.deepEqual((await reopened.load(book.id)).proposals[0], proposal); await reopened.close();
  } finally { await f.service.close(); }
});

test('second-call provenance write failure prevents optimization call and leaves manuscript unchanged', async () => {
  const f = await fixture();
  f.disk.fail((_unit, table, _key, value) => { if (table === 'jobs' && value.phase === 'optimizing' && value.status === 'running') throw new Error('second provenance disk failure'); });
  try {
    const { jobId } = await f.service.dispatch(f.request); await f.service.live.get(jobId).promise;
    const job = await f.service.dispatch({ action: 'job', jobId });
    assert.equal(job.status, 'failed'); assert.match(job.error, /provenance disk failure/); assert.equal(f.calls.length, 1);
    assert.deepEqual(await f.service.dispatch({ action: 'get', bookId: f.book.id }), f.book);
  } finally { await f.service.close(); }
});

for (const phase of [1, 2]) test(`failure in optimization phase ${phase} never yields a review proposal or manuscript change`, async () => {
  const f = await fixture((_args, count) => { if (count === phase) throw new Error('expected upstream failure'); return { text: analysis }; });
  try {
    const { jobId } = await f.service.dispatch(f.request); await f.service.live.get(jobId).promise;
    assert.equal(f.calls.length, phase); assert.equal((await f.service.dispatch({ action: 'job', jobId })).status, 'failed');
    assert.deepEqual(await f.service.dispatch({ action: 'get', bookId: f.book.id }), f.book);
  } finally { await f.service.close(); }
});

for (const value of ['', 'x'.repeat(ANALYSIS_LIMIT + 1), '\u0000broken']) test('invalid analysis stops before the second paid stage: ' + JSON.stringify(value.slice(0, 10)), async () => {
  const f = await fixture(() => ({ text: value }));
  try {
    const { jobId } = await f.service.dispatch(f.request); await f.service.live.get(jobId).promise;
    assert.equal(f.calls.length, 1); assert.equal((await f.service.dispatch({ action: 'job', jobId })).status, 'failed');
    assert.deepEqual(await f.service.dispatch({ action: 'get', bookId: f.book.id }), f.book);
  } finally { await f.service.close(); }
});

test('cancel during analysis prevents the rewrite stage and any proposal', async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const f = await fixture(async () => { await pending; return { text: analysis }; });
  try {
    const { jobId } = await f.service.dispatch(f.request);
    await f.service.dispatch({ action: 'cancel', jobId }); finish(); await f.service.live.get(jobId).promise;
    assert.equal(f.calls.length, 1); assert.equal((await f.service.dispatch({ action: 'job', jobId })).status, 'cancelled');
    assert.deepEqual(await f.service.dispatch({ action: 'get', bookId: f.book.id }), f.book);
  } finally { finish(); await f.service.close(); }
});

test('cancel during rewrite discards the result and leaves only the saved original', async () => {
  let finish, entered; const pending = new Promise(resolve => { finish = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(async (_args, count) => { if (count === 1) return { text: analysis }; entered(); await pending; return { text: optimized }; });
  try {
    const { jobId } = await f.service.dispatch(f.request); await started;
    await f.service.dispatch({ action: 'cancel', jobId }); finish(); await f.service.live.get(jobId).promise;
    assert.equal(f.calls.length, 2); assert.equal((await f.service.dispatch({ action: 'job', jobId })).status, 'cancelled');
    assert.deepEqual(await f.service.dispatch({ action: 'get', bookId: f.book.id }), f.book);
  } finally { finish(); await f.service.close(); }
});

test('context reserve preflights both full-source stages and rejects incomplete requirements before calls', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.dispatch({ ...f.request, instruction: '' }), { code: 'VALIDATION' });
    const small = { ...f.book, contextBudget: 5999 };
    assert.throws(() => optimizationContext(small, f.request.chapterId, { mode: 'revise', instruction: '自然对话' }), { code: 'BUDGET' });
    const context = optimizationContext(f.book, f.request.chapterId, { mode: 'revise', instruction: f.request.instruction });
    for (const note of ['"'.repeat(ANALYSIS_LIMIT), '\n'.repeat(ANALYSIS_LIMIT - 1) + 'x', '😀'.repeat(ANALYSIS_LIMIT / 2)]) {
      const rewrite = optimizationRewriteContext(context, note);
      assert(rewrite.prompt.length <= f.book.contextBudget); assert.equal(rewrite.report.usedChars, rewrite.prompt.length);
    }
    assert.equal(f.calls.length, 0); assert.equal(f.store.jobs.size, 0);
  } finally { await f.service.close(); }
});
