import test from 'node:test';
import assert from 'node:assert/strict';
import { NovelStore, NovelService } from '../service.js';
import { assertLocalRequest, makeHandler } from '../http.js';
import { createServer } from 'node:http';

function backend() {
  const files = new Map(); let failWrite = false;
  return { files, setFail: value => { failWrite = value; }, kv: { async open(spec) {
    assert.match(spec.name, /^[a-z][a-z0-9_]*$/, 'DSH unit name contract');
    if (!files.has(spec.name)) files.set(spec.name, { tables: Object.fromEntries(spec.tables.map(t => [t, {}])), global: null });
    const data = files.get(spec.name);
    return {
      async loadAll() { return structuredClone(data); },
      async putRecord(t, id, value) { if (failWrite) throw new Error('disk full'); data.tables[t][id] = structuredClone(value); },
      async deleteRecord(t, id) { delete data.tables[t][id]; },
      async close() {},
    };
  } } };
}
// Explicit unit double only; desktop-transport-contract.mjs exercises installed DSH auth.
function browserConnection() {
  const browserPeer = { id: 'test-browser-peer', principal: { kind: 'owner' } };
  const apiPeer = { id: 'test-api-peer', principal: { kind: 'owner' } };
  return { browserPeer, admit(req) {
    if (req.headers.cookie === 'test-auth=browser') return { peer: browserPeer };
    if (req.headers.cookie === 'test-auth=api') return { peer: apiPeer };
    return { rejection: 401 };
  } };
}
const selection = () => ({ provider: 'test', model: 'test-model' });
async function fixture(runModel = async () => ({ text: '模型候选' })) {
  const kv = backend(); const store = await new NovelStore(kv).init();
  const service = new NovelService(store, { getModel: selection, runModel });
  let book = await service.dispatch({ action: 'create', title: '测试作品' });
  book = await service.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation: { action: 'addChapter', title: '第一章' } });
  return { kv, store, service, book, chapterId: book.chapters[0].id };
}
const mutate = (book, operation) => ({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation });

test('context previews work through dispatch and preserve the exact generation projection', async () => {
  const { service, book, chapterId } = await fixture();
  const result = await service.dispatch({ action: 'context', bookId: book.id, chapterId, mode: 'draft', instruction: '独立服务预览', selection: null });
  assert.match(result.prompt, /独立服务预览/);
  assert.equal(result.report.usedChars, result.prompt.length);
  assert.equal((await service.dispatch({ action: 'get', bookId: book.id })).revision, book.revision);
  await service.close();
});

test('real HTTP transport enforces origin before dispatch and returns durable mutation result', async () => {
  const { service, book, chapterId } = await fixture();
  let origin;
  const server = createServer(makeHandler(service, () => origin, browserConnection()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, Cookie: 'test-auth=browser', 'Content-Type': 'application/json', 'X-inspiration-Request': '1' };
  try {
    const body = JSON.stringify(mutate(book, { action: 'updateChapter', chapterId, patch: { body: '跨接口原文😀\r\n' } }));
    const blocked = await fetch(origin, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body });
    assert.equal(blocked.status, 403); assert.equal((await blocked.json()).error.code, 'FORBIDDEN');
    assert.deepEqual(await service.dispatch({ action: 'get', bookId: book.id }), book);
    const saved = await fetch(origin, { method: 'POST', headers, body });
    const payload = await saved.json(); assert.equal(saved.status, 200); assert.equal(payload.ok, true);
    assert.equal(payload.data.chapters[0].body, '跨接口原文😀\r\n');
    const invalid = await fetch(origin, { method: 'POST', headers, body: '{' });
    assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'VALIDATION');
    const stale = await fetch(origin, { method: 'POST', headers, body });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'CONFLICT');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close(); }
});

test('book CAS rejects a concurrent stale save without side effects', async () => {
  const { service, book, chapterId } = await fixture();
  const results = await Promise.allSettled(['人工稿A', '人工稿B'].map(body => service.dispatch(mutate(book, { action: 'updateChapter', chapterId, patch: { body } }), { user: true })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CONFLICT');
  const current = await service.dispatch({ action: 'get', bookId: book.id });
  assert.equal(current.chapters[0].body, '人工稿A');
  await service.close();
});

test('failed disk write cannot change committed in-memory manuscript', async () => {
  const { service, book, chapterId, kv } = await fixture();
  kv.setFail(true);
  await assert.rejects(service.dispatch(mutate(book, { action: 'updateChapter', chapterId, patch: { body: '应失败' } })), /disk full/);
  kv.setFail(false);
  assert.deepEqual(await service.dispatch({ action: 'get', bookId: book.id }), book);
  await service.close();
});

test('generation snapshots request and never silently overwrites subsequent human edits', async () => {
  let finish;
  const { service, book, chapterId, store } = await fixture(() => new Promise(resolve => { finish = resolve; }));
  const { jobId } = await service.dispatch({ action: 'generate', bookId: book.id, chapterId, expectedRevision: book.revision, mode: 'draft', instruction: '短篇测试' });
  assert.match(store.jobs.get(jobId).request.prompt, /短篇测试/);
  const changed = await service.dispatch(mutate(book, { action: 'updateChapter', chapterId, patch: { body: '作者在生成过程中写的新稿😀\r\n' } }), { user: true });
  finish({ text: 'AI旧版本候选' });
  await service.live.get(jobId).promise;
  const job = await service.dispatch({ action: 'job', jobId }); assert.equal(job.status, 'completed');
  const updated = await service.dispatch({ action: 'get', bookId: book.id });
  assert.equal(updated.chapters[0].body, changed.chapters[0].body);
  assert.equal(updated.proposals.length, 1);
  await assert.rejects(service.dispatch(mutate(updated, { action: 'acceptProposal', proposalId: job.proposalId }), { user: true }), { code: 'STALE_PROPOSAL' });
  await assert.rejects(service.dispatch(mutate(updated, { action: 'acceptProposal', proposalId: job.proposalId })), { code: 'AUTHOR_ONLY' });
  assert.equal((await service.dispatch({ action: 'get', bookId: book.id })).chapters[0].body, changed.chapters[0].body);
  await service.close();
});

test('cancel reaches model signal and no proposal is committed', async () => {
  let sawSignal;
  const { service, book, chapterId } = await fixture(({ signal, onText }) => new Promise((resolve, reject) => {
    sawSignal = signal; onText('部分草稿'); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const { jobId } = await service.dispatch({ action: 'generate', bookId: book.id, chapterId, expectedRevision: book.revision, mode: 'draft' });
  await assert.rejects(service.dispatch({ action: 'generate', bookId: book.id, chapterId, expectedRevision: book.revision, mode: 'draft' }), { code: 'BUSY' });
  await service.dispatch({ action: 'cancel', jobId });
  await service.live.get(jobId).promise;
  assert.equal(sawSignal.aborted, true);
  assert.equal((await service.dispatch({ action: 'job', jobId })).status, 'cancelled');
  assert.equal((await service.dispatch({ action: 'get', bookId: book.id })).proposals.length, 0);
  await service.close();
});

test('restart recovers books and marks unfinished jobs failed', async () => {
  const { service, store, kv, book } = await fixture();
  await store.saveJob({ id: 'unfinished-job', bookId: book.id, status: 'running', text: '', createdAt: new Date().toISOString(), request: {} });
  await service.close();
  const reopened = await new NovelStore(kv).init();
  assert.equal(reopened.jobs.get('unfinished-job').status, 'failed');
  assert.deepEqual(await reopened.serial(() => reopened.load(book.id)), book);
  await reopened.close();
});

test('import creates independent ids and export contains only manuscript', async () => {
  const { service, book, chapterId } = await fixture();
  const current = await service.dispatch(mutate(book, { action: 'updateChapter', chapterId, patch: { body: '精确手稿😀\r\n第二行' } }));
  const backup = await service.dispatch({ action: 'export', bookId: book.id, format: 'json' });
  const imported = await service.dispatch({ action: 'import', text: backup.text });
  assert.notEqual(imported.id, book.id); assert.notEqual(imported.chapters[0].id, chapterId);
  assert.equal(imported.chapters[0].body, current.chapters[0].body);
  assert.equal(imported.proposals.length, 0);
  const md = await service.dispatch({ action: 'export', bookId: book.id, format: 'markdown' });
  assert.ok(md.text.includes('精确手稿😀\r\n第二行'));
  assert.ok(!md.text.includes('proposals'));
  await service.close();
});

const requestOrigin = 'http://127.0.0.1:59263';
const browserRequest = () => ({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:59263', origin: requestOrigin, cookie: 'test-auth=browser', 'content-type': 'application/json', 'x-inspiration-request': '1', 'sec-fetch-site': 'same-origin' } });

test('HTTP guard blocks cross-origin, DNS rebinding, non-loopback and form requests', () => {
  const connection = browserConnection();
  assert.doesNotThrow(() => assertLocalRequest(browserRequest(), requestOrigin, connection));
  for (const alter of [r => { r.headers.origin = 'https://evil.test'; }, r => { delete r.headers.origin; }, r => { r.headers.origin = 'null'; }, r => { r.headers.origin = ''; }, r => { r.headers.origin = 'dsh-app://app'; }, r => { r.headers.host = 'evil.test:59263'; }, r => { r.socket.remoteAddress = '10.0.0.2'; }, r => { delete r.headers['x-inspiration-request']; }, r => { r.headers['sec-fetch-site'] = 'cross-site'; }, r => { r.headers['sec-fetch-site'] = ''; }]) {
    const req = browserRequest(); alter(req); assert.throws(() => assertLocalRequest(req, requestOrigin, connection), { code: 'FORBIDDEN' });
  }
  const form = browserRequest(); form.headers['content-type'] = 'application/x-www-form-urlencoded';
  assert.throws(() => assertLocalRequest(form, requestOrigin, connection), { code: 'VALIDATION' });
});

test('authenticated Desktop forwarding permits missing Origin only with missing fetch-site', () => {
  const connection = browserConnection(), req = browserRequest();
  delete req.headers.origin; delete req.headers['sec-fetch-site'];
  assert.doesNotThrow(() => assertLocalRequest(req, requestOrigin, connection));
  for (const site of ['same-origin', 'none', 'same-site', 'cross-site', '']) {
    req.headers['sec-fetch-site'] = site;
    assert.throws(() => assertLocalRequest(req, requestOrigin, connection), { code: 'FORBIDDEN' });
  }
  const web = browserRequest(); delete web.headers['sec-fetch-site'];
  assert.doesNotThrow(() => assertLocalRequest(web, requestOrigin, connection));
});

test('both Web and Desktop require authenticated browser peer, never API owner peer', () => {
  const connection = browserConnection();
  for (const desktop of [false, true]) for (const cookie of [undefined, 'forged-cookie', 'test-auth=api']) {
    const req = browserRequest();
    if (desktop) { delete req.headers.origin; delete req.headers['sec-fetch-site']; }
    if (cookie === undefined) delete req.headers.cookie; else req.headers.cookie = cookie;
    assert.throws(() => assertLocalRequest(req, requestOrigin, connection), { code: cookie === 'test-auth=api' ? 'FORBIDDEN' : 'UNAUTHORIZED' });
  }
});

test('HTTP authentication rejects before JSON parsing or author dispatch', async () => {
  const calls = []; let origin;
  const service = { async dispatch(input, options) { calls.push({ input, options }); return { accepted: true }; } };
  const server = createServer(makeHandler(service, () => origin, browserConnection()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const base = { 'Content-Type': 'application/json', 'X-inspiration-Request': '1' };
  try {
    for (const desktop of [false, true]) for (const cookie of [undefined, 'forged-cookie', 'test-auth=api']) {
      const headers = { ...base, ...(desktop ? {} : { Origin: origin }), ...(cookie === undefined ? {} : { Cookie: cookie }) };
      const result = await fetch(origin, { method: 'POST', headers, body: '{malformed' });
      assert.equal(result.status, cookie === 'test-auth=api' ? 403 : 401);
      assert.equal(calls.length, 0, 'no rejected input reaches author dispatch');
      await result.body.cancel();
    }
    for (const desktop of [false, true]) {
      const result = await fetch(origin, { method: 'POST', headers: { ...base, Cookie: 'test-auth=browser', ...(desktop ? {} : { Origin: origin }) }, body: JSON.stringify({ action: 'list' }) });
      assert.equal(result.status, 200); assert.deepEqual((await result.json()).data, { accepted: true });
    }
    assert.equal(calls.length, 2); assert(calls.every(c => c.options.user === true && c.input.action === 'list'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
