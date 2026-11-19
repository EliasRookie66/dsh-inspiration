import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function region(a, b) {
  const start = source.indexOf(a), end = source.indexOf(b, start + a.length);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
const expireToast = new Function(region('    function expireToast(', '    function Modal(') + '\nreturn expireToast;')();
function clock() {
  let time = 0, next = 0;
  const tasks = new Map();
  return {
    start(fn, delay) { const id = ++next; tasks.set(id, { fn, at: time + delay }); return id; },
    cancel(id) { tasks.delete(id); },
    advance(ms) {
      time += ms;
      for (const [id, task] of tasks) if (task.at <= time) { tasks.delete(id); task.fn(); }
    },
    get pending() { return tasks.size; },
  };
}

test('feedback expires at one second; an identical later receipt gets its own full lifetime', () => {
  const c = clock(), first = { message: '已删除章节。' }, second = { ...first };
  let visible = first;
  const set = update => { visible = update(visible); };
  expireToast(first, set, c.start, c.cancel);
  c.advance(999); assert.equal(visible, first);
  visible = second;
  expireToast(second, set, c.start, c.cancel);
  c.advance(1); assert.equal(visible, second, 'A stale timeout cannot dismiss another receipt');
  c.advance(998); assert.equal(visible, second);
  c.advance(1); assert.equal(visible, null);
  assert.equal(c.pending, 0);
});

test('effect cleanup cancels a pending timer and never changes interactive state', () => {
  const c = clock(), notice = { message: '已保存' };
  let writes = 0;
  assert.equal(expireToast(null, () => writes++, c.start, c.cancel), undefined);
  const cancel = expireToast(notice, () => writes++, c.start, c.cancel);
  assert.equal(c.pending, 1);
  cancel(); c.advance(1000);
  assert.equal(writes, 0);
  assert.equal(c.pending, 0);
});

test('one always-mounted polite live region stays outside the content and never handles input', () => {
  const shell = region("return h('main', { ref: rootRef", 'ctx.slots.inject(');
  const host = region("          h('div', { className: 'mx-toast-layer'", "          h('div', { ref: contentRef");
  assert.match(host, /role: 'status', 'aria-live': 'polite', 'aria-atomic': true/);
  assert.match(shell, /className: 'mx-content-pane', 'aria-busy': loading \|\| busy/);
  assert.doesNotMatch(host, /Modal|tabIndex|onClick|focus\(|inert|button/);
  assert.match(source, /\.mx-root\{position:relative;/);
  assert.match(source, /\.mx-toast-layer\{[^}]*position:absolute;[^}]*pointer-events:none/);
  assert.match(source, /\.mx-toast\{[^}]*pointer-events:none/);
  assert.doesNotMatch(shell, /mx-banner mx-info|error && !guard.*h\(Modal/);
  assert.match(shell, /guard && h\(Modal/);
  assert.match(shell, /confirm && h\(Modal/);
  assert.match(source, /w && autosaveRef\.current\?\.failed && toolbarButton\('save', t\('autosaveRetry'\)/);
  assert.match(source, /expireToast\(notice, setToastNotice\)/);
  assert.match(source, /expireToast\(toastError, setError\)/);
});

test('only actionable book-deletion results remain visible after the refresh', async () => {
  const body = region('          const refreshDeletedLibrary =', '          const deleteManagedBook =');
  let state, available = true;
  const env = { alive: { current: true }, refreshList() {}, current: { current: null }, openBook() {},
    refreshAfterBookDeletion: async () => available, setDeletionNotice: fn => { state = fn(state); } };
  const refresh = new Function('env', 'with(env){' + body + '\nreturn refreshDeletedLibrary;}')(env);
  const clean = { title: 'A', cleanupPending: false, localCleanupPending: false };
  assert.equal(await refresh(clean), true); assert.equal(state, null);
  available = false;
  assert.equal(await refresh(clean), false); assert.equal(state.refreshFailed, true);
  available = true;
  assert.equal(await refresh(), true); assert.equal(state, null);
  for (const flag of ['cleanupPending', 'localCleanupPending']) {
    assert.equal(await refresh({ ...clean, [flag]: true }), true);
    assert.equal(state[flag], true); assert.equal(state.refreshFailed, false);
  }
});
