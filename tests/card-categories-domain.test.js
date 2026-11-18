import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildContext, cloneImportedBook, createBook, exportMarkdown, LIMITS, makeProposal, mutateBook, validateBook } from '../core.js';
import { optimizationContext, optimizationRewriteContext } from '../optimization.js';
import { NovelService, NovelStore } from '../service.js';

const kindKeys = ['world', 'character', 'rule', 'timeline', 'thread'];
const category = (name, id = randomUUID()) => ({ id, name });
const addCategory = (book, value) => mutateBook(book, { action: 'addCardCategory', category: value });
const createCard = (book, card) => mutateBook(book, { action: 'createCard', card: { id: randomUUID(), ...card } });
const saveCard = (book, card) => mutateBook(book, { action: 'saveCard', card });
const invalid = { code: 'VALIDATION' };
const importJson = book => cloneImportedBook(JSON.parse(JSON.stringify(book)));

function fixture() {
  const book = mutateBook(createBook('Isolated category fixture'), { action: 'addChapter', title: '雨夜' });
  return mutateBook(book, { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: '旧稿🙂\r\n第一行。' } });
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('old schema-1 books validate, save, and import without backfilling either optional category field', () => {
  let old = fixture();
  delete old.writingConstraints;
  for (const kind of kindKeys) old = createCard(old, { kind });
  const original = JSON.stringify(freeze(old));
  assert.equal(validateBook(old), old);
  assert.equal(Object.hasOwn(old, 'cardCategories'), false);
  assert.ok(old.cards.every(card => !Object.hasOwn(card, 'categoryId')));
  const changed = saveCard(old, { id: old.cards[0].id, title: 'Only change the title' });
  assert.equal(Object.hasOwn(changed, 'cardCategories'), false);
  assert.ok(changed.cards.every(card => !Object.hasOwn(card, 'categoryId')));
  const imported = importJson(old);
  assert.equal(Object.hasOwn(imported, 'cardCategories'), false);
  assert.equal(Object.hasOwn(imported, 'writingConstraints'), false);
  assert.deepEqual(imported.cards.map(card => card.kind), kindKeys);
  assert.ok(imported.cards.every(card => !Object.hasOwn(card, 'categoryId')));
  assert.equal(imported.chapters[0].body, old.chapters[0].body);
  assert.equal(JSON.stringify(old), original);
});

test('addCardCategory appends detached canonical records; cannot overwrite by ID or normalized name', () => {
  const base = freeze(createCard(fixture(), { title: 'Unrelated card' }));
  const input = category('　Ｃafé  ', 'C7611C16-1BB0-410C-9972-4672FEEE9000');
  const first = addCategory(base, input);
  const saved = { id: input.id.toLowerCase(), name: 'Ｃafé' };
  assert.deepEqual(first.cardCategories, [saved]);
  assert.equal(Object.hasOwn(base, 'cardCategories'), false);
  assert.equal(first.revision, base.revision + 1);
  assert.equal(first.schemaVersion, base.schemaVersion);
  const { revision, updatedAt, cardCategories, ...rest } = first;
  assert.deepEqual({ ...rest, revision: base.revision, updatedAt: base.updatedAt }, base);
  input.name = 'Exterior mutation';
  const second = category('史料');
  const both = addCategory(freeze(first), second);
  assert.deepEqual(both.cardCategories, [saved, second]);
  assert.notEqual(both.cardCategories[0], first.cardCategories[0]);
  assert.notEqual(both.cardCategories[1], second);
  assert.deepEqual(first.cardCategories, [saved]);
  assert.throws(() => addCategory(both, category('Other name', input.id)), { ...invalid, message: /ID 重复/u });
  assert.throws(() => addCategory(both, category('　cafe\u0301　')), { ...invalid, message: /名称已存在/u });
  assert.throws(() => mutateBook(both, { action: 'updateBook', patch: { cardCategories: [] } }), invalid);
  assert.throws(() => mutateBook(both, { action: 'renameCardCategory', category: saved }), invalid);
  assert.throws(() => mutateBook(both, { action: 'removeCardCategory', category: saved }), invalid);
});

test('category count, UTF-16 limits, reserved aliases and control characters are validated', () => {
  const book = createBook('Category limits');
  const maxName = '🙂'.repeat(30);
  assert.equal(addCategory(book, category(`　${maxName} `)).cardCategories[0].name, maxName);
  assert.equal(addCategory(book, category('甲')).cardCategories[0].name, '甲');
  const reserved = [...kindKeys, 'OPEN THREAD', 'Ｏｐｅｎ　ｔｈｒｅａｄ', 'All categories', '世界观', '人物', '规则', '时间线', '未解伏笔', '伏笔', '全部分类'];
  const malformed = ['', '　  ', null, undefined, 1, `${maxName}x`, '\ud800', '\udfff', '\r尾', '首\n', '首\t', '首\u0000尾', '首\u007f尾', '首\u0085尾', '首\u2028', '首\u2029尾', '首\u202e尾'];
  for (const name of [...reserved.map(name => ` ${name} `), ...malformed]) {
    assert.throws(() => addCategory(book, category(name)), invalid, `must reject ${JSON.stringify(name)}`);
  }
  const atLimit = { ...book, cardCategories: Array.from({ length: 127 }, (_, index) => category(`类目 ${index}`)) };
  const full = addCategory(atLimit, category('Last allowed category'));
  assert.equal(validateBook(full).cardCategories.length, 128);
  assert.throws(() => addCategory(full, category('Too many categories')), invalid);
  assert.throws(() => importJson({ ...full, cardCategories: [...full.cardCategories, category('Too many categories')] }), invalid);
});

test('category IDs are globally unique within the book; malformed or non-canonical stored records fail closed', () => {
  const base = createCard(fixture(), { title: 'Other entity' });
  for (const id of [base.id, base.chapters[0].id, base.chapters[0].history[0].id, base.cards[0].id, 'not-uuid']) {
    assert.throws(() => addCategory(base, category('Conflicting identity', id)), invalid);
  }
  const row = category('地点', 'c7611c16-1bb0-410c-9972-4672feee9000');
  const valid = addCategory(base, row);
  assert.throws(() => createCard(valid, { id: row.id }), invalid);
  for (const entries of [null, undefined, {}, [null], [category(' missing trim')], [{ id: row.id }], [{ name: row.name }], [{ ...row, alias: 'Unexpected' }], [category(row.name, row.id.toUpperCase())], [row, category('Conflicting id', row.id)], [row, category(row.name)]]) {
    assert.throws(() => validateBook({ ...base, cardCategories: entries }), invalid);
  }
});

test('exact JSON shapes reject getters, exotic objects, hidden properties and malformed lists without executing user code', () => {
  const base = createCard(fixture(), { title: 'No accessors' });
  let called = 0;
  const value = category('Hostile fixtures');
  const hostileRows = [
    Object.assign(Object.create({ name: 'prototype' }), value),
    Object.defineProperty({ ...value }, 'name', { get() { called++; return 'getter'; } }),
    Object.defineProperty({ ...value }, 'hidden', { value: 1 }),
    { ...value, [Symbol('hidden')]: 1 },
    { ...value, toJSON() { called++; return {}; } },
  ];
  for (const row of hostileRows) {
    assert.throws(() => addCategory(base, row), invalid);
    assert.throws(() => validateBook({ ...base, cardCategories: [row] }), invalid);
  }
  const accessorRows = [];
  Object.defineProperty(accessorRows, '0', { enumerable: true, get() { called++; return value; } });
  for (const rows of [new Array(1), accessorRows, Object.assign([value], { extra: true })]) {
    assert.throws(() => validateBook({ ...base, cardCategories: rows }), invalid);
  }
  const stored = Object.defineProperty({ ...base }, 'cardCategories', { get() { called++; return [value]; } });
  assert.throws(() => validateBook(stored), invalid);
  const card = Object.defineProperty({ id: base.cards[0].id }, 'categoryId', { enumerable: true, get() { called++; return value.id; } });
  assert.throws(() => saveCard(base, card), invalid);
  const hidden = Object.defineProperty({ id: randomUUID() }, 'categoryId', { value: value.id });
  assert.throws(() => mutateBook(base, { action: 'createCard', card: hidden }), invalid);
  assert.equal(called, 0);
});

test('create and save validate local category references, preserve omitted/null semantics, and never change kind implicitly', () => {
  const custom = category('史料', 'c7611c16-1bb0-410c-9972-4672feee9000');
  const foreign = category('他书设定');
  const other = addCategory(createBook('Other book'), foreign);
  assert.doesNotThrow(() => createCard(other, { categoryId: foreign.id }));
  const book = addCategory(fixture(), custom);
  let saved = createCard(book, { kind: 'rule', categoryId: custom.id.toUpperCase() });
  const cardId = saved.cards[0].id;
  assert.equal(saved.cards[0].categoryId, custom.id);
  saved = saveCard(saved, { id: cardId, title: 'Partial update' });
  assert.equal(saved.cards[0].categoryId, custom.id, 'omission in a partial update retains the assigned category');
  saved = saveCard(saved, { id: cardId, categoryId: null });
  assert.equal(saved.cards[0].categoryId, null);
  assert.equal(saved.cards[0].kind, 'rule');
  const viaLegacySave = saveCard(saved, { kind: 'timeline', categoryId: custom.id });
  assert.equal(viaLegacySave.cards[1].categoryId, custom.id);
  assert.equal(viaLegacySave.cards[1].kind, 'timeline');
  const nonAssigned = createCard(viaLegacySave, { kind: 'thread' });
  assert.equal(Object.hasOwn(nonAssigned.cards[2], 'categoryId'), false);
  const explicitlyCleared = createCard(viaLegacySave, { kind: 'thread', categoryId: null });
  assert.equal(explicitlyCleared.cards[2].categoryId, null);
  const before = JSON.stringify(saved);
  for (const categoryId of [foreign.id, randomUUID(), book.id, cardId, undefined, 12, '', 'invented', 'Rule']) {
    assert.throws(() => createCard(saved, { categoryId }), invalid);
    assert.throws(() => saveCard(saved, { id: cardId, categoryId }), invalid);
  }
  assert.throws(() => createCard(fixture(), { categoryId: custom.id }), invalid);
  assert.equal(JSON.stringify(saved), before);
});

test('custom and preset display assignments do not alter prompts, canon/report labels, or Markdown', () => {
  let base = createCard(fixture(), { kind: 'rule', status: 'confirmed', title: 'Steady rule', content: 'CANON_STAYS_EXACT' });
  base = createCard(base, { kind: 'world', status: 'proposed', title: 'Proposed only', content: 'PROPOSED_STAYS_OUT' });
  const chapterId = base.chapters[0].id, rule = base.cards[0];
  const custom = category('不进入上下文');
  const grouped = addCategory(base, custom);
  for (const categoryId of [...kindKeys, custom.id, null]) {
    const book = saveCard(grouped, { id: rule.id, categoryId });
    assert.equal(book.cards[0].categoryId, categoryId);
    const { categoryId: _, ...underlying } = book.cards[0];
    assert.deepEqual(underlying, rule);
    for (const mode of ['draft', 'continue', 'summary', 'polish', 'revise']) {
      const opts = { mode, instruction: 'Only tighten the prose.', ...(mode === 'polish' ? { selection: { start: 0, end: 2, text: '旧稿' } } : {}) };
      const actual = buildContext(book, chapterId, opts);
      assert.deepEqual(actual, buildContext(base, chapterId, opts));
      assert.match(actual.prompt, /CANON_STAYS_EXACT/u);
      assert.match(actual.prompt, /设定卡 #1（rule）/u);
      assert.doesNotMatch(actual.prompt, /PROPOSED_STAYS_OUT|不进入上下文/u);
      if (mode === 'revise') {
        const first = optimizationContext(book, chapterId, opts), expected = optimizationContext(base, chapterId, opts);
        assert.deepEqual(first, expected);
        assert.deepEqual(optimizationRewriteContext(first, 'Only tighten the prose.'), optimizationRewriteContext(expected, 'Only tighten the prose.'));
      }
    }
    assert.equal(exportMarkdown(book), exportMarkdown(base));
  }
});

test('JSON import remaps custom IDs and all matching references without rewriting assignments, old card data or input', () => {
  const first = category('远港'), second = category('深海');
  let book = addCategory(addCategory(fixture(), first), second);
  for (const [index, categoryId] of [second.id, first.id, second.id, 'character', null, undefined].entries()) {
    book = createCard(book, { kind: 'rule', title: `Card ${index}`, ...(categoryId === undefined ? {} : { categoryId }) });
  }
  const chapterId = book.chapters[0].id;
  book = mutateBook(book, { action: 'addProposal', proposal: makeProposal(book, chapterId, {}, 'Unapproved', buildContext(book, chapterId)) });
  const encoded = JSON.stringify(book);
  const imported = importJson(freeze(book));
  assert.deepEqual(imported.cardCategories.map(row => row.name), [first.name, second.name]);
  assert.notEqual(imported.id, book.id);
  assert.notEqual(imported.cardCategories[0].id, first.id);
  assert.notEqual(imported.cardCategories[1].id, second.id);
  assert.deepEqual(imported.cards.map(card => card.categoryId), [imported.cardCategories[1].id, imported.cardCategories[0].id, imported.cardCategories[1].id, 'character', null, undefined]);
  assert.equal(Object.hasOwn(imported.cards.at(-1), 'categoryId'), false);
  assert.deepEqual(imported.cards.map(({ id, categoryId, ...rest }) => rest), book.cards.map(({ id, categoryId, ...rest }) => rest));
  assert.ok(imported.cards.every((card, index) => card.id !== book.cards[index].id));
  assert.deepEqual(imported.proposals, []);
  assert.equal(imported.chapters[0].body, book.chapters[0].body);
  assert.equal(JSON.stringify(book), encoded);
  for (const categoryId of [randomUUID(), book.cards[0].id, 'unsupported', first.id.toUpperCase()]) {
    assert.throws(() => importJson({ ...book, cards: [{ ...book.cards[0], categoryId }] }), invalid);
  }
  assert.throws(() => importJson({ ...book, cardCategories: [] }), invalid);
});

test('category names participate in the aggregate UTF-16 book tally before JSON byte checks', () => {
  const source = fixture();
  const name = 'z'.repeat(60);
  const fullCount = Math.floor(LIMITS.bookChars / LIMITS.body);
  const body = 'x'.repeat(LIMITS.body);
  const length = LIMITS.bookChars - source.title.length - fullCount - 1 - body.length * fullCount - name.length + 1;
  const chapter = { ...source.chapters[0], title: 'T', history: [] };
  const chapters = Array.from({ length: fullCount + 1 }, (_, index) => ({ ...chapter, id: randomUUID(), body: index === fullCount ? 'x'.repeat(length) : body }));
  const book = { ...source, chapters };
  assert.throws(() => validateBook(book), /JSON 超过 32 MiB/u);
  assert.throws(() => validateBook({ ...book, cardCategories: [category(name)] }), /文本总量超过 32 Mi 字符上限/u);
});

function jsonBackend() {
  const data = new Map();
  return { data, kv: { async open({ name, tables }) {
    if (!data.has(name)) data.set(name, JSON.stringify({ tables: Object.fromEntries(tables.map(table => [table, {}])) }));
    return {
      async loadAll() { return JSON.parse(data.get(name)); },
      async putRecord(table, id, record) {
        const unit = JSON.parse(data.get(name));
        unit.tables[table][id] = record;
        data.set(name, JSON.stringify(unit));
      },
      async close() {},
    };
  } } };
}

test('existing service CAS commits category/add-card data atomically, exports JSON, and reloads old/new records without rewriting', async () => {
  const disk = jsonBackend();
  const open = async () => new NovelService(await new NovelStore(disk).init(), {
    getModel: () => ({ provider: 'fixture', model: 'unavailable' }), runModel: () => assert.fail('No model call expected'),
  });
  let service = await open();
  try {
    const dispatch = (book, operation) => service.dispatch({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation });
    const get = book => service.dispatch({ action: 'get', bookId: book.id });
    const base = await service.dispatch({ action: 'create', title: 'CAS category fixture' });
    const old = await service.store.insert(createCard(fixture(), { kind: 'character' }));
    const row = category('Pacts');
    const [success, stale] = await Promise.allSettled([
      dispatch(base, { action: 'addCardCategory', category: row }),
      dispatch(base, { action: 'addCardCategory', category: category('Stale race') }),
    ]);
    assert.equal(success.status, 'fulfilled');
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.reason.code, 'CONFLICT');
    const categorized = success.value;
    assert.deepEqual(categorized.cardCategories, [row]);
    const stable = [...disk.data];
    await assert.rejects(dispatch(categorized, { action: 'addCardCategory', category: { ...row, name: 'Overwrite' } }), invalid);
    await assert.rejects(dispatch(old, { action: 'saveCard', card: { id: old.cards[0].id, categoryId: row.id } }), invalid);
    assert.deepEqual([...disk.data], stable);
    const saved = await dispatch(categorized, { action: 'createCard', card: { id: randomUUID(), kind: 'rule', categoryId: row.id } });
    const exported = await service.dispatch({ action: 'export', bookId: saved.id, format: 'json' });
    assert.deepEqual(JSON.parse(exported.text), saved);
    const imported = await service.dispatch({ action: 'import', text: exported.text });
    assert.notEqual(imported.cardCategories[0].id, row.id);
    assert.equal(imported.cards[0].categoryId, imported.cardCategories[0].id);
    const legacyJson = await service.dispatch({ action: 'export', bookId: old.id, format: 'json' });
    const legacyImported = await service.dispatch({ action: 'import', text: legacyJson.text });
    assert.equal(Object.hasOwn(legacyImported, 'cardCategories'), false);
    assert.equal(Object.hasOwn(legacyImported.cards[0], 'categoryId'), false);
    await service.close();
    const reopenedBefore = [...disk.data];
    service = await open();
    for (const record of [old, legacyImported, saved, imported]) assert.deepEqual(await get(record), record);
    assert.deepEqual([...disk.data], reopenedBefore, 'reload and read leave all persisted JSON bytes untouched');
  } finally {
    await service.close();
  }
});
