import { fail } from './service.js';
export const API_PATH = '/api/ycx-inspiration';
const MAX_BYTES = 40 * 1024 * 1024;
export function isLoopback(address) {
  return address === '::1' || /^127(?:\.\d{1,3}){3}$/.test(address || '') || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address || '');
}
export function assertLocalRequest(req, origin, connection) {
  const trusted = new URL(origin);
  if (!isLoopback(trusted.hostname.replace(/^\[|\]$/g, '')) || !isLoopback(req.socket.remoteAddress)) fail('FORBIDDEN', 'This personal workbench is local-only / 写作台仅支持本机');
  if (req.method !== 'POST') fail('METHOD', 'POST required');
  // Desktop validates dsh-app://app, then removes Origin AND Sec-Fetch-Site and
  // forwards with its Host browser cookie. Missing headers alone prove nothing:
  // BOTH transports must pass DSH admission below before reading any body.
  const site = req.headers['sec-fetch-site'];
  const forwardedShape = req.headers.origin === undefined && site === undefined;
  if (req.headers.host !== trusted.host || (req.headers.origin !== trusted.origin && !forwardedShape)) fail('FORBIDDEN', 'Same-origin request required');
  if (req.headers['x-inspiration-request'] !== '1') fail('FORBIDDEN', 'Missing application request header');
  if (site !== undefined && site !== 'same-origin') fail('FORBIDDEN', 'Cross-site requests are not allowed');
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail('VALIDATION', 'JSON content type required');
  const admission = connection.admit(req);
  if ('rejection' in admission) fail(admission.rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', 'Authenticated DSH browser required / 请从已登录的 DSH 页面打开写作台');
  // API peers may also have principal.kind=owner. They are not author UI and
  // must never acquire accept/restore authority through this route.
  if (!admission.peer || !connection.browserPeer || admission.peer.id !== connection.browserPeer.id) fail('FORBIDDEN', 'Author browser required / 此操作仅限作者界面');
}
export async function readJson(req) {
  const chunks = []; let length = 0;
  const announced = Number(req.headers['content-length']);
  if (announced > MAX_BYTES) fail('TOO_LARGE', 'Request exceeds 40 MiB');
  const timer = setTimeout(() => req.destroy(Object.assign(new Error('Request body timed out'), { code: 'TIMEOUT' })), 30_000);
  timer.unref?.();
  try {
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_BYTES) fail('TOO_LARGE', 'Request exceeds 40 MiB');
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('VALIDATION', 'Invalid JSON / 无效 JSON'); }
}
export function makeHandler(service, getOrigin, connection) {
  return async (req, res) => {
    let status = 200, payload;
    try {
      assertLocalRequest(req, getOrigin(), connection);
      const input = await readJson(req);
      payload = { ok: true, data: await service.dispatch(input, { user: true }) };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
      status = ({ UNAUTHORIZED: 401, FORBIDDEN: 403, AUTHOR_ONLY: 403, METHOD: 405, NOT_FOUND: 404, CONFLICT: 409, MODEL_CONFLICT: 409, STALE_PROPOSAL: 409, BUSY: 409, TOO_LARGE: 413, CLOSED: 503, INTERNAL: 500, STORAGE: 500 })[code] || 400;
      payload = { ok: false, error: { code, message: String(error?.message || error).slice(0, 3000) } };
    }
    if (!res.destroyed && !res.writableEnded) {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json;charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(JSON.stringify(payload));
    }
  };
}
