import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createBook, mutateBook } from '../core.js';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const range = (a, b) => {
  const start = source.indexOf(a), end = source.indexOf(b, start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
};
const helpers = new Function(range('    const equal =', '    const en =') + '\nreturn {autosaveRecoveryWorkspace,dirty,isDirty,workspace};')();
const code = range('          const transition =', '          const download =');
const compile = (text, deps) => new Function('deps', `const {${Object.keys(deps).join(',')}}=deps;\n${text}\nreturn {changeChapter,selectBook};`)(deps);
function harness({ text = code, dirty = false, tab = 'writing' } = {}) {
  let book = createBook('fixture');
  for (const title of ['第一章', '相同标题', '相同标题']) book = mutateBook(book, { action: 'addChapter', title });
  const ids = book.chapters.map(chapter => chapter.id), initial = helpers.workspace(book, ids[0]);
  let release;
  const pending = new Promise(resolve => { release = resolve; }), events = [], guards = [], pages = [];
  const current = { current: dirty ? { ...initial, chapter: { ...initial.chapter, body: '未保存文字' } } : initial };
  const flags = { current: false }, ticket = { current: 0 };
  const other = createBook('another fixture');
  const {changeChapter: select, selectBook} = compile(text, { ...helpers, current, busyRef: { current: false }, loading: false, epoch: { current: 0 },
    tab, toolPages: ['tools', 'manage', 'context', 'advanced'], autosaveComposing: flags, workspaceNavigation: ticket, autosaveRef: { current: { flush: () => pending } },
    openBook(id, _chapter, page) { assert.equal(other.id, id); current.current = helpers.workspace(other); events.push(id); pages.push(page); },
    invalidateReviewReturn: () => events.push('invalidate'), setGuard: value => guards.push(value),
    commit(next) { current.current = next; events.push(next.chapterId); }, resetSelection() {}, setError() {}, setNotice() {}, setConflict() {}, switchTab(page) { pages.push(page); },
  });
  return { ids, select, selectBook, other, current, events, guards, pages, flags, ticket, release };
}

test('chapter selection waits for save and applies only the latest ID, even with duplicate titles', async () => {
  const h = harness(), [, second, third] = h.ids, p = h.select(second), q = h.select(third);
  assert.equal(h.current.current.chapterId, h.ids[0]);
  assert.equal(h.events.length, 0);
  h.release(); await Promise.all([p, q]);
  assert.deepEqual(h.events, ['invalidate', third]);
  assert.equal(h.current.current.chapterId, third);
  assert.equal(h.current.current.chapter.title, '相同标题');
});

test('a later book choice supersedes a chapter choice waiting for the same save', async () => {
  const h = harness(), p = h.select(h.ids[1]), q = h.selectBook(h.other.id);
  h.release(); await Promise.all([p, q]);
  assert.deepEqual(h.events, ['invalidate', h.other.id]);
  assert.equal(h.current.current.book.id, h.other.id);
  const reverse = harness(), a = reverse.selectBook(reverse.other.id), b = reverse.select(reverse.ids[2]);
  reverse.release(); await Promise.all([a, b]);
  assert.deepEqual(reverse.events, ['invalidate', reverse.ids[2]]);
});

test('chapter and book changes retain the current utility page but normal panes reopen Writing', async () => {
  for (const [tab, expected] of [['tools','tools'],['manage','manage'],['context','context'],['advanced','advanced'],['settings','writing']]) {
    const h = harness({ tab }); h.release(); await h.select(h.ids[1]); await h.selectBook(h.other.id);
    assert.deepEqual(h.pages, [expected, expected]);
  }
});

test('cancelled chapter intent or active composition after the receipt leaves manuscript in place', async () => {
  for (const cancel of [h => h.ticket.current++, h => { h.flags.current = true; }]) {
    const h = harness(); const p = h.select(h.ids[1]); cancel(h); h.release(); await p;
    assert.equal(h.current.current.chapterId, h.ids[0]); assert.deepEqual(h.events, []); assert.deepEqual(h.guards, []);
  }
});

test('dirty source opens one guard for the latest chapter; dismissing it leaves title and text intact', async () => {
  const h = harness({ dirty: true });
  const p = h.select(h.ids[1]), q = h.select(h.ids[2]); h.release(); await Promise.all([p,q]);
  assert.equal(h.guards.length, 1);
  assert.equal(h.current.current.chapter.body, '未保存文字');
  assert.equal(h.current.current.chapterId, h.ids[0]);
  // Cancel never calls run. A superseded callback also must not change the chapter.
  h.ticket.current++; h.guards[0].run();
  assert.equal(h.current.current.chapterId, h.ids[0]);
  assert.equal(h.current.current.chapter.body, '未保存文字');
});

test('latest-intent guard oracle catches stale navigation before the confirmation flow', async () => {
  const before = 'autosaveComposing.current || !stillRequested()) return;', after = 'autosaveComposing.current) return;';
  assert.equal(code.split(before).length, 2);
  const broken = harness({ dirty: true, text: code.replace(before, after) });
  const choices = [broken.select(broken.ids[1]), broken.select(broken.ids[2])]; broken.release(); await Promise.all(choices);
  assert.equal(broken.guards.length, 2, 'Without the guard, an obsolete chapter choice would create a second dialog');
});
