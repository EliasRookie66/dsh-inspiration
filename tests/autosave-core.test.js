import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBook, mutateBook } from '../core.js';

const create = (book, card) => mutateBook(book, { action: 'createCard', card });
const hasCode = code => error => error?.code === code;

test('create-only card uses the caller identity without mutating input or sharing supplied arrays', () => {
  const original = createBook('autosave identity fixture'), snapshot = structuredClone(original);
  const id = randomUUID(), tags = ['fixture'];
  const saved = create(original, { id, title: 'Manual fixture card', tags });
  assert.deepEqual(original, snapshot);
  assert.equal(saved.revision, original.revision + 1);
  assert.equal(saved.cards.length, 1);
  assert.equal(saved.cards[0].id, id);
  assert.equal(saved.cards[0].status, 'proposed');
  tags.push('not persisted');
  assert.deepEqual(saved.cards[0].tags, ['fixture']);
});

test('retrying create-only with the same identity cannot overwrite or create duplicates', () => {
  const id = randomUUID(), saved = create(createBook('fixture'), { id, title: 'First', content: 'Original' });
  const before = structuredClone(saved);
  assert.throws(() => create(saved, { id, title: 'Overwrite attempt', content: 'Wrong' }), hasCode('CONFLICT'));
  assert.throws(() => create(saved, { id: id.toUpperCase(), title: 'Case collision' }), hasCode('CONFLICT'));
  assert.deepEqual(saved, before);
});

test('caller card identity still cannot collide with another book entity', () => {
  let book = mutateBook(createBook('fixture'), { action: 'addChapter' });
  const constraintId = randomUUID();
  book = mutateBook(book, { action: 'updateBook', patch: { writingConstraints: [{ id: constraintId, category: 'fixture', content: 'fixture condition', enabled: false }] } });
  const before = structuredClone(book);
  for (const id of [book.id, book.chapters[0].id, constraintId]) {
    assert.throws(() => create(book, { id, title: 'Collision' }), hasCode('VALIDATION'));
    assert.deepEqual(book, before);
  }
});

test('create-only input requires a valid explicit UUID and strict field shape', () => {
  const book = createBook('fixture');
  for (const card of [{ title: 'No identity' }, { id: 'invalid' }, { id: randomUUID(), extra: 'forbidden' }, { id: randomUUID(), title: '' }]) {
    assert.throws(() => create(book, card), hasCode('VALIDATION'));
  }
  assert.equal(book.cards.length, 0);
});

test('host rejects card and nested tag accessors without executing them', () => {
  const book = createBook('fixture'); let calls = 0;
  const card = { title: 'fixture' };
  Object.defineProperty(card, 'id', { enumerable: true, get() { calls++; return randomUUID(); } });
  assert.throws(() => create(book, card), hasCode('VALIDATION'));
  const tags = [];
  Object.defineProperty(tags, '0', { enumerable: true, get() { calls++; return 'forbidden'; } });
  assert.throws(() => create(book, { id: randomUUID(), tags }), hasCode('VALIDATION'));
  assert.equal(calls, 0);
  assert.equal(book.cards.length, 0);
});

test('legacy saveCard semantics remain unchanged and do not turn unknown ids into creation', () => {
  let book = createBook('fixture');
  assert.throws(() => mutateBook(book, { action: 'saveCard', card: { id: randomUUID(), title: 'Unknown' } }), hasCode('NOT_FOUND'));
  book = mutateBook(book, { action: 'saveCard', card: { title: 'Legacy creation' } });
  const id = book.cards[0].id;
  book = mutateBook(book, { action: 'saveCard', card: { id, content: 'Explicit update' } });
  assert.equal(book.cards.length, 1);
  assert.equal(book.cards[0].content, 'Explicit update');
});
