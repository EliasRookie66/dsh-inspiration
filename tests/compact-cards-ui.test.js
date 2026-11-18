import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function part(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}
const f = new Function(part('    const equal =', '    const en =') + '\nreturn {cardFields,blankCard,cardRange,autosaveStep,categoryFilter,cardsInCategory};')();
const actions = part('          const chooseCard =', '          const confirmMutation =') + part('          const requestCardRemoval =', '          const renderCards =');
const intent = part('          const navigationIntent =', '          const selectBook =');
const transition = part('          const transition =', '          const navigationIntent =');
const isWorkspaceDirty = new Function(part('    const equal =', '    const en =') + '\nreturn {dirty,isDirty,autosaveRecoveryWorkspace};')();

function fixture() {
  const make = (id, title) => ({ id, title, content: '内容', kind: 'world', status: 'proposed', pinned: false, fromChapter: 1, toChapter: null, tags: [] });
  const a = make('a', '同名'), b = make('b', '同名');
  const current = { current: { book: { id: 'book', cards: [a, b] }, card: null, baseCard: null } };
  let unblock;
  const hold = new Promise(resolve => { unblock = resolve; });
  const env = { ...f, ...isWorkspaceDirty, current, epoch: { current: 0 }, workspaceNavigation: { current: 0 }, busyRef: { current: false },
    loading: false, cardFilter: null, autosaveComposing: { current: false }, guard: null, confirm: null, recoveryRef: { current: null },
    autosaveRef: { current: { flush: () => hold, pendingSnapshot: null } },
    cardTitleInput: { current: null }, cardBodyInput: { current: null }, cardFocusRequest: { current: null }, t: key => key,
    invalidateReviewReturn() {}, commit: value => { current.current = value; }, setGuard: guard => { env.guard = guard; },
    confirmMutation: (...args) => { env.review = args; },
  };
  const api = new Function('env', 'with (env) { ' + transition + intent + actions + '\nreturn {chooseCard,closeCard,requestCardRemoval}; }')(env);
  return { ...api, env, current, unblock, a, b };
}

test('card clicks wait for autosave, use the latest card by ID, and only the latest click wins', async () => {
  const h = fixture();
  const first = h.chooseCard(h.a.id), second = h.chooseCard(h.b.id);
  h.current.current.book.cards[1] = { ...h.b, content: 'saved while clicks were waiting' };
  assert.equal(h.current.current.card, null);
  h.unblock(); await Promise.all([first, second]);
  assert.equal(h.current.current.card.id, h.b.id);
  assert.equal(h.current.current.card.content, 'saved while clicks were waiting');
  assert.deepEqual(h.env.cardFocusRequest.current, { bookId: 'book', editor: true, newCard: false });
});

test('reselecting the open card does not reset it and closing with an invalid draft uses the existing guard', async () => {
  const h = fixture(), base = f.cardFields(h.a);
  h.current.current = { ...h.current.current, baseCard: base, card: { ...base, fromChapter: '' } };
  let focused = 0;
  h.env.cardBodyInput.current = { focus: () => focused++ };
  await h.chooseCard(h.a.id);
  assert.equal(focused, 1);
  h.unblock(); await h.closeCard();
  assert.equal(h.current.current.card.fromChapter, '');
  assert.equal(h.env.guard.scope, 'card');
  h.env.guard.run();
  assert.equal(h.current.current.card, null);
  assert.deepEqual(h.env.cardFocusRequest.current, { bookId: 'book', id: h.a.id });
});

test('remove is reviewed by ID only for the open card, using the saved title, with focus fallback after success', async () => {
  const h = fixture(), base = f.cardFields(h.b);
  h.current.current = { ...h.current.current, baseCard: base, card: base };
  h.unblock();
  await h.requestCardRemoval(h.a.id);
  assert.equal(h.env.review, undefined);
  await h.requestCardRemoval(h.b.id);
  assert.match(h.env.review[1], /同名/);
  assert.deepEqual(h.env.review[2], { action: 'removeCard', cardId: h.b.id });
  assert.equal(h.env.cardFocusRequest.current, null);
  h.env.review[5]({ id: 'book', cards: [h.a] });
  assert.deepEqual(h.env.cardFocusRequest.current, { bookId: 'book', id: h.a.id });
});

test('card scope feedback uses the same parser as autosave and preserves open-ended ranges', () => {
  const base = f.blankCard();
  for (const card of [{ ...base, title: 'A', fromChapter: '2', toChapter: '1' }, { ...base, title: 'A', fromChapter: '1.5' }, { ...base, title: 'A', fromChapter: '' }]) {
    assert.equal(f.cardRange(card), null);
    assert.equal(f.autosaveStep({ card, baseCard: base, settings: {}, baseSettings: {} }), null);
  }
  const card = { ...base, title: 'A', fromChapter: '922', toChapter: '' };
  assert.deepEqual(f.cardRange(card), { fromChapter: 922, toChapter: null });
  assert.equal(f.autosaveStep({ card, baseCard: base, settings: {}, baseSettings: {} }).operation.card.toChapter, null);
});

test('layout only splits when editing and replaces the browser on narrow containers', () => {
  const render = part('          const renderCards =', '          const renderHistory');
  assert.match(source, /\.mx-cards\[data-editing=true\]\{display:grid;grid-template-columns:minmax\(14rem,1fr\) minmax\(0,2.25fr\)/);
  assert.match(source, /@container\(max-width:760px\).*\.mx-card-browser.*display:none/);
  assert.match(source, /\.mx-card-excerpt\{[^}]*grid-column:1\/-1/);
  assert.match(render, /editing && h\('section', \{ id: editId/);
  assert.match(render, /'aria-current': selected/);
  assert.match(render, /button\(t\('cardBack'\), closeCard\)/);
  assert.equal((render.match(/requestCardRemoval\(/g) || []).length, 1);
});
