// Run with: ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" tests/desktop-transport-contract.mjs
// This is NOT a GUI test. Real installed Desktop forwardWebRequest, Connection
// apply/BrowserAuth/Peer and JSON storage are exercised over an isolated HTTP port.
// Test doubles: credential STORAGE (an initially empty Map, no ambient lookup),
// webServer REGISTRATION (a local route map), unused model/tools, mutant business spy.
// Authentication decisions/signatures, HTTP transport and production handlers are real.
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtemp, readFile, realpath, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import vm from 'node:vm';

assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1', 'Use the installed Electron-as-Node runtime');
assert.ok(process.env.DSH_INSTALL_DIR, 'DSH_INSTALL_DIR is required; no fallback to another installation');
const require = createRequire(import.meta.url);
const installDir = resolve(process.env.DSH_INSTALL_DIR);
const names = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm'];
const entries = new Map(names.map(name => [name, pathToFileURL(require.resolve(name, { paths: [installDir] })).href]));
registerHooks({ resolve(specifier, context, next) {
  return entries.has(specifier) ? { url: entries.get(specifier), shortCircuit: true } : next(specifier, context);
} });
const { Context } = await import('@deepseek-ai/cordis');
const { apply: applyConnection } = await import('@deepseek-ai/dsh-client-connection');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const { NovelStore, NovelService } = await import('../service.js');
const { API_PATH, makeHandler } = await import('../http.js');
const plugin = await import('../index.js');
assert.ok(plugin.inject.includes('connection'), 'Production plugin must hard-inject Connection');

// Pin extraction to the installed app's exact function region, never run the main process.
const appAsar = resolve(installDir, '../../../..');
assert.equal(basename(appAsar), 'app.asar', 'Expected packaged Desktop layout');
const mainPath = join(appAsar, 'lib/main.js');
assert.ok((await stat(mainPath)).size < 2 * 1024 * 1024, 'Bound Desktop source read');
const desktopSource = await readFile(mainPath, 'utf8');
const regionStart = desktopSource.indexOf('const WITHHELD_RESPONSE_HEADERS = [');
const functionStart = desktopSource.indexOf('async function forwardWebRequest(request, host, cookie) {', regionStart);
const regionEnd = desktopSource.indexOf('\n//#endregion', functionStart);
assert.ok(regionStart >= 0 && functionStart > regionStart && regionEnd > functionStart, 'Review changed Desktop function before updating this extraction');
assert.equal(desktopSource.indexOf('async function forwardWebRequest(', functionStart + 1), -1, 'Unique forwarding implementation');

const tempParent = await realpath(tmpdir());
const tempRoot = await mkdtemp(join(tempParent, 'inspiration-desktop-contract-'));
const owner = new Context();
const records = new Map();
owner.provide('credentials', {
  async modifyRecord(key, mutate) {
    const changed = await mutate(structuredClone(records.get(key)));
    if (changed !== undefined) records.set(key, structuredClone(changed));
    return structuredClone(records.get(key));
  },
});
// Only the installed Connection's carrier metadata/registration is stubbed.
owner.provide('webServer', { host: '127.0.0.1', protocol: 'http:', register() { return () => {}; } });
let origin, connection, backend, service, activeHandler;
let dispatches = 0, bodyReads = 0, hostHits = 0, forwardFetches = 0, lastForward;
let passed = 0, mutations = 0, moduleNonce = 0, bindingNonce = 0;
const testBody = JSON.stringify({ action: 'create', title: 'Must never be created by a rejected request' });
const appHeaders = { 'content-type': 'application/json', 'x-inspiration-request': '1' };
const server = createServer((req, res) => {
  hostHits++;
  const url = new URL(req.url, origin);
  if (url.pathname === '/') { if (connection.authorizeIndex(req, res)) res.end('isolated test index'); return; }
  if (url.pathname === '/connect') { connection.authorizeConnect(req, res); return; }
  if (url.pathname !== API_PATH) { res.statusCode = 404; res.end(); return; }
  const iterate = req[Symbol.asyncIterator].bind(req);
  req[Symbol.asyncIterator] = function () { bodyReads++; return iterate(); };
  Promise.resolve(activeHandler(req, res)).catch(() => { res.destroy(); });
});

function direct(headers = {}, body = testBody, method = 'POST') {
  // node:http lets the test set Host/Origin exactly; destination stays the test port.
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest(new URL(API_PATH, origin), { method, headers: { ...appHeaders, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolveResponse(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Isolated HTTP test timed out')));
    req.end(body);
  });
}
async function responseStatus(responsePromise, expected, code) {
  const response = await responsePromise;
  const text = await response.text();
  assert.equal(response.status, expected, 'HTTP admission status');
  const payload = text ? JSON.parse(text) : undefined;
  if (code !== undefined) assert.equal(payload?.error?.code, code, 'HTTP admission error code');
  return payload;
}
async function snapshot(directory = join(tempRoot, 'books')) {
  const rows = [];
  async function walk(path, relative = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), name + '/');
      else if (entry.isFile()) rows.push([name, createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex')]);
      else assert.fail('Unexpected non-regular test storage entry');
    }
  }
  await walk(directory);
  return rows;
}
async function rejected(name, send, expected, code, { beforeBody = true } = {}) {
  const before = { dispatches, bodyReads, disk: await snapshot() };
  await responseStatus(send(), expected, code);
  assert.equal(dispatches, before.dispatches, name + ': no business dispatch');
  if (beforeBody) assert.equal(bodyReads, before.bodyReads, name + ': no application body read');
  assert.deepEqual(await snapshot(), before.disk, name + ': no persistent side effects');
  passed++; console.log('PASS:', name);
}
async function detects(name, probe) {
  await assert.rejects(probe, error => error?.code === 'ERR_ASSERTION', name + ': oracle must fail, not throw an unrelated runtime error');
  mutations++; console.log('DETECTED MUTATION:', name);
}
async function importVariant(url, mutate) {
  const source = await readFile(url, 'utf8');
  let variant = mutate(source);
  assert.notEqual(variant, source, 'Mutation must change exactly the intended production guard');
  // Resolve only this module's relative imports; all implementation dependencies stay real.
  variant = variant.replace(/from (['"])(\.\/[^'"]+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`);
  return import('data:text/javascript;base64,' + Buffer.from(variant).toString('base64') + '#mutant-' + ++moduleNonce);
}
function replaceOnce(source, old, replacement) {
  assert.equal(source.split(old).length, 2, 'Mutation anchor must match once: ' + old);
  return source.replace(old, replacement);
}

try {
  await applyConnection(owner, { cookieMaxAgeDays: 1 });
  connection = owner.connection;
  assert.equal(records.size, 1, 'Only a fresh private signing-secret record exists');
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.notEqual(server.address().port, 59263, 'Never target the running GUI listener');

  backend = new JsonStorageBackend(join(tempRoot, 'books'));
  const store = await new NovelStore(backend).init();
  service = new NovelService(store, { getModel: () => ({ provider: 'isolated-test', model: 'no-network' }), runModel() { throw new Error('No model network in transport contract'); } });
  const trackedService = { dispatch(input, options) { dispatches++; assert.equal(options.user, true); return service.dispatch(input, options); } };
  const baseline = makeHandler(trackedService, () => origin, connection);
  activeHandler = baseline;

  async function mint(path, status) {
    // The official Connection creates this token and signs this cookie for THIS new context.
    const response = await fetch(connection.authenticatedUrl(origin + path), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, status);
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie?.startsWith('dsh-auth-'));
    await response.text();
    return cookie;
  }
  const browserCookie = await mint('/', 303);
  const apiCookie = await mint('/connect', 302);
  const trustRequest = cookie => ({ headers: { host: new URL(origin).host, cookie } });
  const browserAdmission = connection.admit(trustRequest(browserCookie));
  const apiAdmission = connection.admit(trustRequest(apiCookie));
  assert.equal(browserAdmission.peer.id, connection.browserPeer.id);
  assert.notEqual(apiAdmission.peer.id, connection.browserPeer.id);
  assert.equal(apiAdmission.peer.principal.kind, 'owner', 'An API Peer can be owner; principal kind is insufficient');
  assert.equal(connection.requestRejection(trustRequest(apiCookie)), undefined, 'requestRejection alone accepts API authentication');
  assert.equal(connection.admit(trustRequest(undefined)).rejection, 401);

  const forward = vm.runInNewContext(desktopSource.slice(regionStart, regionEnd) + '\nforwardWebRequest;', {
    URL, Headers, Response,
    fetch(target, init) {
      assert.equal(target.origin, origin, 'Desktop test transport must stay on the isolated listener');
      assert.equal(target.pathname, API_PATH);
      forwardFetches++;
      lastForward = {
        hasOrigin: init.headers.has('origin'), hasFetchSite: init.headers.has('sec-fetch-site'),
        hasHost: init.headers.has('host'), replacesRendererCookie: init.headers.get('cookie') === browserCookie,
        customHeader: init.headers.get('x-inspiration-request'),
      };
      return fetch(target, init);
    },
  }, { filename: mainPath, timeout: 1000 });
  const desktop = (headers = {}, cookie = browserCookie, body = testBody) => forward(new Request('dsh-app://app' + API_PATH, {
    method: 'POST', headers: { ...appHeaders, origin: 'dsh-app://app', 'sec-fetch-site': 'same-origin', cookie: 'renderer-must-not-control-auth=1', ...headers }, body, signal: AbortSignal.timeout(5000),
  }), origin, cookie);

  const created = await responseStatus(desktop({}, browserCookie, JSON.stringify({ action: 'create', title: 'Desktop contract 😀\r\n' })), 200);
  assert.equal(created.ok, true);
  assert.equal((await service.dispatch({ action: 'get', bookId: created.data.id })).id, created.data.id);
  assert.deepEqual(lastForward, { hasOrigin: false, hasFetchSite: false, hasHost: false, replacesRendererCookie: true, customHeader: '1' });
  passed++; console.log('PASS: installed Desktop forwarding + real signed browser admission + durable production mutation');
  await responseStatus(direct({ origin, 'sec-fetch-site': 'same-origin', cookie: browserCookie }, JSON.stringify({ action: 'list' })), 200);
  passed++; console.log('PASS: ordinary Web exact-Origin path remains accepted');

  await rejected('anonymous Desktop-shaped request', () => direct(), 401, 'UNAUTHORIZED');
  await rejected('anonymous forged exact-Origin request', () => direct({ origin, 'sec-fetch-site': 'same-origin' }), 401, 'UNAUTHORIZED');
  const forged = browserCookie.slice(0, browserCookie.indexOf('=') + 1) + randomBytes(32).toString('base64url');
  await rejected('forged browser cookie', () => direct({ cookie: forged }), 401, 'UNAUTHORIZED');
  const invalidSignature = browserCookie.slice(0, -1) + (browserCookie.endsWith('a') ? 'b' : 'a');
  await rejected('tampered signed browser cookie', () => direct({ cookie: invalidSignature }), 401, 'UNAUTHORIZED');
  // Only this isolated test process's clock advances. Official authentication
  // checks the genuine signed expiry; no cookie payload/signature is fabricated.
  const realNow = Date.now;
  const expiredNow = realNow() + 2 * 24 * 60 * 60 * 1000;
  try {
    Date.now = () => expiredNow;
    await rejected('expired genuine browser cookie', () => direct({ cookie: browserCookie }), 401, 'UNAUTHORIZED');
  } finally { Date.now = realNow; }
  await rejected('real signed API owner Peer cannot gain author rights', () => direct({ cookie: apiCookie }), 403, 'FORBIDDEN');
  await rejected('real API owner Peer cannot gain rights through Desktop forwarding', () => desktop({}, apiCookie), 403, 'FORBIDDEN');
  await rejected('unauthenticated invalid JSON rejected before parsing', () => direct({}, '{'), 401, 'UNAUTHORIZED');
  await rejected('authenticated malformed JSON is not dispatched', () => direct({ cookie: browserCookie }, '{'), 400, 'VALIDATION', { beforeBody: false });
  for (const badOrigin of ['null', '', 'https://evil.invalid', 'dsh-app://app', 'http://127.0.0.1:1']) {
    await rejected('Host rejects Origin ' + JSON.stringify(badOrigin), () => direct({ cookie: browserCookie, origin: badOrigin }), 403, 'FORBIDDEN');
  }
  for (const site of ['same-origin', 'same-site', 'cross-site', 'none', '']) {
    await rejected('missing Origin requires also missing metadata: ' + JSON.stringify(site), () => direct({ cookie: browserCookie, 'sec-fetch-site': site }), 403, 'FORBIDDEN');
  }
  await rejected('cross-site metadata despite exact Origin', () => direct({ cookie: browserCookie, origin, 'sec-fetch-site': 'cross-site' }), 403, 'FORBIDDEN');
  await rejected('exact Host blocks localhost alias', () => direct({ cookie: browserCookie, host: `localhost:${server.address().port}` }), 403, 'FORBIDDEN');
  await rejected('exact Host blocks wrong port', () => direct({ cookie: browserCookie, host: '127.0.0.1:1' }), 403, 'FORBIDDEN');
  await rejected('application request header required', () => direct({ cookie: browserCookie, 'x-inspiration-request': '' }), 403, 'FORBIDDEN');
  await rejected('JSON content-type required', () => direct({ cookie: browserCookie, 'content-type': 'application/x-www-form-urlencoded' }), 400, 'VALIDATION');
  await rejected('POST method required', () => direct({ cookie: browserCookie }, '', 'GET'), 405, 'METHOD');
  for (const rendererOrigin of ['null', 'https://evil.invalid', origin]) {
    const before = { hostHits, forwardFetches };
    await rejected('Desktop rejects renderer Origin ' + JSON.stringify(rendererOrigin), () => desktop({ origin: rendererOrigin }), 403);
    assert.equal(hostHits, before.hostHits, 'Rejected renderer request never reaches HTTP');
    assert.equal(forwardFetches, before.forwardFetches, 'Rejected renderer request never calls fetch');
  }

  // Production index -> captured route -> actual HTTP -> actual Connection.
  // The local registration stub deliberately behaves like real WebServer:
  // no implicit disposal, duplicate exact paths throw, disposer owns removal.
  async function bindingProbe(applyPlugin) {
    const routes = new Map();
    let pluginOwner, disk, admissions = 0, routeDisposals = 0;
    const directory = join(tempRoot, 'binding-' + ++bindingNonce);
    const webServer = { host: '127.0.0.1', protocol: 'http:', getOrigin: () => origin,
      register(route) {
        assert.equal(routes.has(route.path), false, 'Duplicate exact route on reload');
        routes.set(route.path, route);
        return () => { assert.equal(routes.get(route.path), route); routes.delete(route.path); routeDisposals++; };
      },
    };
    async function activate() {
      pluginOwner = new Context();
      disk = new JsonStorageBackend(directory);
      pluginOwner.provide('storage', { backend: { get: name => { assert.equal(name, 'json'); return disk; } } });
      pluginOwner.provide('webServer', webServer);
      pluginOwner.provide('connection', { browserPeer: connection.browserPeer, admit(req) { admissions++; return connection.admit(req); } });
      pluginOwner.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'isolated-test', model: 'no-network' }) });
      pluginOwner.provide('tools', { register() { return () => {}; } });
      await applyPlugin(pluginOwner);
      assert.equal(routes.size, 1);
      assert.equal(routes.get(API_PATH).kind, 'exact');
      activeHandler = (req, res) => {
        const route = routes.get(API_PATH);
        if (route) return route.handler(req, res);
        res.statusCode = 404; res.end();
      };
    }
    try {
      await activate();
      await responseStatus(desktop({}, browserCookie, JSON.stringify({ action: 'list' })), 200);
      assert.ok(admissions > 0, 'Production index must pass actual Connection into makeHandler');
      await responseStatus(direct({}, '{'), 401, 'UNAUTHORIZED');
      await responseStatus(direct({ cookie: apiCookie }), 403, 'FORBIDDEN');
      await pluginOwner.fiber.dispose();
      assert.equal(routes.size, 0, 'Plugin disposal must unregister its exact route');
      assert.equal(routeDisposals, 1);
      await responseStatus(direct({ cookie: browserCookie }), 404);
      await disk.close();
      await activate();
      await responseStatus(desktop({}, browserCookie, JSON.stringify({ action: 'list' })), 200);
      await pluginOwner.fiber.dispose();
      assert.equal(routes.size, 0, 'Second activation also disposes its route');
      assert.equal(routeDisposals, 2);
    } finally {
      activeHandler = baseline;
      await pluginOwner?.fiber.dispose();
      await disk?.close();
    }
  }
  await bindingProbe(plugin.apply);
  passed++; console.log('PASS: production index auth binding, exact-route disposal and clean reactivation');

  // Injection-style negative verification: mutate only in-memory source modules.
  // No production files are patched, and mutant dispatch cannot write the real fixture store.
  const spy = { async dispatch() { return { isolatedMutationProbe: true }; } };
  const httpUrl = new URL('../http.js', import.meta.url);
  const mutants = [
    ['skip authentication', s => replaceOnce(s, 'const admission = connection.admit(req);', 'const admission = { peer: connection.browserPeer };'), () => responseStatus(direct(), 401, 'UNAUTHORIZED')],
    ['accept signed API Peer as author', s => s.replace(/^  if \(!admission\.peer[^\n]+\n/m, ''), () => responseStatus(direct({ cookie: apiCookie }), 403, 'FORBIDDEN')],
    ['restore mandatory Origin and break Desktop', s => replaceOnce(s, 'const forwardedShape = req.headers.origin === undefined && site === undefined;', 'const forwardedShape = false;'), () => responseStatus(desktop(), 200)],
    ['relax the double-absent forwarding shape', s => replaceOnce(s, 'const forwardedShape = req.headers.origin === undefined && site === undefined;', 'const forwardedShape = req.headers.origin === undefined;'), () => responseStatus(direct({ cookie: browserCookie, 'sec-fetch-site': 'same-origin' }), 403, 'FORBIDDEN')],
  ];
  for (const [name, mutate, probe] of mutants) {
    const mutant = await importVariant(httpUrl, mutate);
    activeHandler = mutant.makeHandler(spy, () => origin, connection);
    try { await detects(name, probe); } finally { activeHandler = baseline; }
  }
  const badIndex = await importVariant(new URL('../index.js', import.meta.url), source => {
    const statement = source.split('\n').find(line => line.includes('ctx.effect(() => ctx.webServer.register('));
    assert.ok(statement, 'Production route registration must be effect-owned');
    return replaceOnce(source, statement, statement.replace('ctx.effect(() => ', '').replace(/\)\);\s*$/, ');'));
  });
  await detects('forget exact-route disposer', () => bindingProbe(badIndex.apply));
  const unboundIndex = await importVariant(new URL('../index.js', import.meta.url), source => replaceOnce(source,
    'makeHandler(service, () => ctx.webServer.getOrigin(), ctx.connection)',
    'makeHandler(service, () => ctx.webServer.getOrigin())'));
  await detects('omit production Connection binding', () => bindingProbe(unboundIndex.apply));
  assert.equal(mutations, 6);
  console.log(`PASS: ${passed} transport/binding scenarios; ${mutations} intentionally broken in-memory variants detected.`);
  console.log('Scope: real installed forwarding and authentication, fresh private credentials, isolated HTTP/JSON storage. Not Electron UI, live-profile reload, or live-cookie evidence.');
} finally {
  if (server.listening) await new Promise((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeAllConnections(); });
  await service?.close();
  await backend?.close();
  await owner.fiber.dispose();
  records.clear();
  const target = await realpath(tempRoot);
  assert.equal(dirname(target), tempParent, 'Cleanup must remain under the verified OS temporary directory');
  assert.ok(basename(target).startsWith('inspiration-desktop-contract-'));
  assert.equal(target, tempRoot, 'Never remove a redirected path');
  await rm(target, { recursive: true });
}
