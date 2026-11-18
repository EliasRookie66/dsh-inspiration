import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const helpers = new Function(source.slice(source.indexOf('    const equal ='), source.indexOf('    const en =')) +
  '\nreturn {categoryFilter,cardCategory,blankCard,editCardCategory,cardsInCategory,cardFields,categoryReceipt,dirty,autosaveStep};')();
const category = { id: '46febe53-a034-4b6e-83e4-98888de0f497', name: '势力' };
const book = { id: 'book', revision: 17, cardCategories: [category] };

test('filters are scoped to one book and new cards inherit a valid filter without changing context kind', () => {
  assert.equal(helpers.categoryFilter(book, { bookId: 'other', id: category.id }), '');
  assert.equal(helpers.categoryFilter({ ...book, cardCategories: [] }, { bookId: 'book', id: category.id }), '');
  for (const id of ['rule', category.id]) {
    const filter = helpers.categoryFilter(book, { bookId: book.id, id });
    const card = helpers.blankCard(filter);
    assert.equal(helpers.cardCategory(card), id);
    assert.equal(card.kind, 'character');
    assert.equal(helpers.dirty({ card, baseCard: card }).card, false, 'Selecting a filter does not persist a blank card');
  }
});

test('legacy grouping follows type, and reclassification or clearing never mutates context kind or other fields', () => {
  const base = { ...helpers.blankCard(), kind: 'rule', status: 'confirmed', title: 'Keep the rule' };
  assert.equal(helpers.cardCategory(base), 'rule');
  const moved = helpers.editCardCategory(base, book, 'world');
  assert.deepEqual(moved, { ...base, categoryId: 'world' });
  const custom = helpers.editCardCategory(moved, book, category.id);
  assert.deepEqual(helpers.cardsInCategory([base, moved, custom], category.id), [custom]);
  assert.deepEqual(helpers.cardsInCategory([base, moved, custom], 'rule'), [base]);
  assert.equal(helpers.editCardCategory(custom, book, 'not-a-category'), custom);
  const cleared = helpers.editCardCategory(custom, book, '');
  assert.deepEqual(cleared, { ...base, categoryId: null });
  assert.equal(helpers.dirty({ card: cleared, baseCard: base }).card, false, 'No-op undo is clean against a legacy omitted field');
  const w = { book, card: cleared, baseCard: custom, settings: {}, baseSettings: {} };
  assert.equal(helpers.autosaveStep(w).operation.card.categoryId, null, 'Clearing a saved assignment sends an explicit null');
  assert.equal(helpers.autosaveStep({ ...w, book: { ...book, cardCategories: [] }, card: custom, baseCard: base }), null, 'Unknown UUID must not be sent');
});

test('category creation receipt requires the requested ID, exact title and an unchanged saved card list', () => {
  const before = { id: 'b', revision: 12, cards: [{ id: 'a' }] };
  const next = { ...before, revision: 13, cardCategories: [category] };
  assert.equal(helpers.categoryReceipt(before, next, category), true);
  for (const corrupt of [{ ...next, id: 'other' }, { ...next, revision: 14 }, { ...next, cards: [] },
    { ...next, cardCategories: [{ ...category, id: 'a' }] }, { ...next, cardCategories: [{ ...category, name: '另一个名字' }] }]) {
    assert.equal(helpers.categoryReceipt(before, corrupt, category), false);
  }
});
