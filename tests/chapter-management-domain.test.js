import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildContext, createBook, makeProposal, mutateBook, validateBook } from '../core.js';
import { NovelService, NovelStore } from '../service.js';

const move = (chapter, direction) => ({ action: 'moveChapter', chapterId: chapter.id, direction });
const remove = (chapter, confirmTitle = chapter.title) => ({ action: 'deleteChapter', chapterId: chapter.id, confirmTitle });
const mutation = (book, operation) => ({ action: 'mutate', bookId: book.id, expectedRevision: book.revision, operation });
const chapterIds = book => book.chapters.map(chapter => chapter.id);
const addCard = (book, title, fromChapter, toChapter) => mutateBook(book, {
  action: 'saveCard', card: { title, fromChapter, toChapter, content: '设定原文', status: 'confirmed', pinned: true, tags: ['测试'] },
});

function withChapters(titles) {
  return titles.reduce((book, title) => mutateBook(book, { action: 'addChapter', title }), createBook('同名测试作品'));
}
function richBook() {
  let book = withChapters(['  同名章节😀  ', '  同名章节😀  ', '第三章']);
  book = mutateBook(book, { action: 'updateBook', patch: {
    outline: '全书大纲', writingConstraints: [{ id: randomUUID(), category: '叙事', content: '保留视角', enabled: true }],
  } });
  for (const [index, { id: chapterId }] of book.chapters.entries()) {
    book = mutateBook(book, { action: 'updateChapter', chapterId, patch: { body: `原稿 ${index}\r\n😀`, outline: `提纲 ${index}` } });
    book = mutateBook(book, { action: 'updateChapter', chapterId, patch: { body: `定稿 ${index}\r\n😀`, status: 'final' } });
    const summaryOptions = { mode: 'summary' };
    const summary = makeProposal(book, chapterId, summaryOptions, `摘要 ${index}`, buildContext(book, chapterId, summaryOptions));
    book = mutateBook(book, { action: 'addProposal', proposal: summary });
    book = mutateBook(book, { action: 'acceptProposal', proposalId: summary.id });
    const options = { mode: 'draft' };
    const draft = makeProposal(book, chapterId, options, `候选 ${index}`, buildContext(book, chapterId, options));
    book = mutateBook(book, { action: 'addProposal', proposal: draft });
    if (index === 0) book = mutateBook(book, { action: 'rejectProposal', proposalId: draft.id });
  }
  const chapterId = book.chapters[0].id;
  const options = { mode: 'revise', instruction: '改善措辞' };
  const revision = makeProposal(book, chapterId, options, '优化稿\r\n😀', buildContext(book, chapterId, options), { analysis: '调整措辞' });
  return mutateBook(book, { action: 'addProposal', proposal: revision });
}
const ordinalCoverage = (card, ordinals) => ordinals.filter(ordinal => ordinal >= card.fromChapter && (card.toChapter === null || ordinal <= card.toChapter));

// Independently compute the expected member identities, including future slots
// beyond the four actual chapters. The sample ends after all finite input bounds.
const ordinals = Array.from({ length: 9 }, (_, i) => i + 1);
const scopes = ordinals.slice(0, 6).flatMap(from => [...ordinals.slice(from - 1, 6), null].map(to => [from, to]));

test('up/down swaps exactly one neighbor and preserves whole chapter records and proposals, even for equal titles', () => {
  const book = addCard(richBook(), '仅第二章', 2, 2);
  const original = structuredClone(book);
  const [first, second, third] = book.chapters;
  const next = mutateBook(book, move(second, 'up'));
  assert.deepEqual(next, { ...book, revision: book.revision + 1, updatedAt: next.updatedAt,
    chapters: [second, first, third], cards: [{ ...book.cards[0], fromChapter: 1, toChapter: 1 }],
  });
  assert.equal(first.title, second.title);
  assert.equal(next.chapters[0].summaryRevision, second.revision);
  assert.deepEqual(next.chapters[0].history, second.history);
  assert.match(buildContext(next, second.id).prompt, /"targetChapter":1/);
  assert.match(buildContext(next, second.id).prompt, /仅第二章/);
  assert.doesNotMatch(buildContext(next, first.id).prompt, /仅第二章/);
  const restored = mutateBook(next, move(second, 'down'));
  assert.deepEqual(restored, { ...book, revision: book.revision + 2, updatedAt: restored.updatedAt });
  assert.deepEqual(book, original);
});

test('each adjacent swap preserves every card member, or rejects if the resulting range is noncontiguous', () => {
  const base = withChapters(['一', '二', '三', '四']);
  for (const [from, to] of scopes) {
    const book = addCard(base, '范围夹具', from, to);
    const original = structuredClone(book);
    const members = ordinalCoverage(book.cards[0], ordinals);
    for (let index = 0; index < book.chapters.length - 1; index++) {
      const swapped = [...ordinals];
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
      const expected = ordinals.filter(ordinal => members.includes(swapped[ordinal - 1]));
      const contiguous = expected.at(-1) - expected[0] + 1 === expected.length;
      for (const [sourceIndex, direction] of [[index, 'down'], [index + 1, 'up']]) {
        const op = move(book.chapters[sourceIndex], direction);
        const label = `move ${sourceIndex + 1} ${direction}, range ${from}..${to}`;
        if (contiguous) {
          const next = mutateBook(book, op);
          assert.deepEqual(chapterIds(next), swapped.slice(0, 4).map(ordinal => book.chapters[ordinal - 1].id), label);
          assert.deepEqual(ordinalCoverage(next.cards[0], ordinals), expected, label);
          assert.deepEqual(next.cards[0], { ...book.cards[0], fromChapter: expected[0], toChapter: to === null ? null : expected.at(-1) }, label);
        } else {
          assert.throws(() => mutateBook(book, op), { code: 'CHAPTER_CARD_RANGE' }, label);
        }
      }
    }
    assert.deepEqual(book, original);
  }
});

test('deletion maps each retained ordinal including future positions and keeps open ends', () => {
  const base = withChapters(['一', '二', '三', '四']);
  for (const [from, to] of scopes) {
    const book = addCard(base, '范围夹具', from, to);
    const original = structuredClone(book);
    const members = ordinalCoverage(book.cards[0], ordinals);
    for (const [index, chapter] of book.chapters.entries()) {
      const retained = ordinals.filter(ordinal => ordinal !== index + 1);
      const expected = retained.flatMap((ordinal, position) => members.includes(ordinal) ? [position + 1] : []);
      const label = `delete ${index + 1}, range ${from}..${to}`;
      if (!expected.length) {
        assert.throws(() => mutateBook(book, remove(chapter)), { code: 'CHAPTER_CARD_RANGE' }, label);
      } else {
        const next = mutateBook(book, remove(chapter));
        assert.deepEqual(chapterIds(next), retained.slice(0, 3).map(ordinal => book.chapters[ordinal - 1].id), label);
        assert.deepEqual(ordinalCoverage(next.cards[0], ordinals.slice(0, -1)), expected, label);
        assert.deepEqual(next.cards, [{ ...book.cards[0], fromChapter: expected[0], toChapter: to === null ? null : expected.at(-1) }], label);
      }
    }
    assert.deepEqual(book, original);
  }
});

test('delete by ID removes only the selected equal-title chapter and all its proposal states', () => {
  const book = richBook();
  const [target, sameTitle, other] = book.chapters;
  assert.equal(target.title, sameTitle.title);
  assert.deepEqual(book.proposals.filter(p => p.chapterId === target.id).map(p => p.state), ['accepted', 'rejected', 'ready']);
  assert.throws(() => mutateBook(book, remove(target, target.title.trim())), { code: 'VALIDATION' });
  const after = mutateBook(book, remove(target));
  assert.deepEqual(after, { ...book, revision: book.revision + 1, updatedAt: after.updatedAt,
    chapters: [sameTitle, other], proposals: book.proposals.filter(proposal => proposal.chapterId !== target.id),
  });
  assert.ok(!JSON.stringify(after).includes(target.history[0].id));
  assert.deepEqual(validateBook(after), after);
});

test('a future-inclusive range can block a swap even when existing chapters alone would fit', () => {
  const book = withChapters(['一', '二']);
  // This range covers chapter 2 and future chapter 3. After moving 2 to 1,
  // the interval {1, 3} cannot be represented by a single contiguous range.
  for (const upper of [3, null]) {
    const current = mutateBook(book, { action: 'saveCard', card: { title: `未来范围 ${upper}`, fromChapter: 2, toChapter: upper } });
    assert.equal(current.cards[0].status, 'proposed');
    assert.throws(() => mutateBook(current, move(current.chapters[1], 'up')), {
      code: 'CHAPTER_CARD_RANGE', message: /未来范围.*请先修改这些设定卡的章节范围/,
    });
  }
});

test('blocker messages identify a bounded list and never apply earlier remaps on failure', () => {
  for (const [operation, remappedRange, blockedRange] of [
    [chapters => move(chapters[1], 'up'), [1, 1], [2, 3]],
    [chapters => remove(chapters[1]), [3, null], [2, 2]],
  ]) {
    let book = addCard(withChapters(['一', '二', '三']), '会先变更的卡', ...remappedRange);
    for (let i = 1; i <= 7; i++) {
      book = addCard(book, `卡${i}\u202e\n${'长'.repeat(55)}😀${'后'.repeat(200)}`, ...blockedRange);
    }
    const original = structuredClone(book);
    assert.throws(() => mutateBook(book, operation(book.chapters)), error => {
      assert.equal(error.code, 'CHAPTER_CARD_RANGE');
      assert.match(error.message, /#2「卡1  长/);
      assert.match(error.message, /#6「卡5/);
      assert.match(error.message, /另有 2 张/);
      assert.doesNotMatch(error.message, /卡[67]|[\n\u202e]/);
      assert.equal(error.message.isWellFormed(), true);
      assert.ok(error.message.length < 500);
      return true;
    });
    assert.deepEqual(book, original);
  }
});

test('validation rejects missing identities, non-adjacent moves, edges, extra fields and incomplete confirmation', () => {
  const book = withChapters(['一', '二']);
  const [first, last] = book.chapters;
  for (const [op, code] of [
    [move(first, 'up'), 'INVALID_STATE'], [move(last, 'down'), 'INVALID_STATE'],
    [move(first, 'top'), 'VALIDATION'], [move(first, 2), 'VALIDATION'],
    [{ action: 'moveChapter', chapterId: first.id }, 'VALIDATION'],
    [{ ...move(first, 'down'), index: 1 }, 'VALIDATION'],
    [{ ...move(first, 'down'), chapterId: '一' }, 'VALIDATION'],
    [{ ...move(first, 'down'), chapterId: randomUUID() }, 'NOT_FOUND'],
    [{ ...remove(first), chapterId: randomUUID() }, 'NOT_FOUND'],
    [{ action: 'deleteChapter', chapterId: first.id }, 'VALIDATION'],
    [remove(first, '二'), 'VALIDATION'], [remove(first, null), 'VALIDATION'],
    [{ ...remove(first), direction: 'up' }, 'VALIDATION'],
  ]) assert.throws(() => mutateBook(book, op), { code });
});

function memoryBackend() {
  const files = new Map(), writes = [];
  return { files, writes, kv: { async open(spec) {
    if (!files.has(spec.name)) files.set(spec.name, { tables: Object.fromEntries(spec.tables.map(table => [table, {}])) });
    const data = files.get(spec.name);
    return {
      async loadAll() { return structuredClone(data); },
      async putRecord(table, id, value) { writes.push(['put', spec.name, table, id]); data.tables[table][id] = structuredClone(value); },
      async deleteRecord(table, id) { writes.push(['delete', spec.name, table, id]); delete data.tables[table][id]; },
      async close() {},
    };
  } } };
}
const getModel = () => ({ provider: 'test', model: 'no-network' });
const noModel = () => assert.fail('this fixture must not call a model');
async function fixture(t, { book = richBook(), runModel = noModel } = {}) {
  const disk = memoryBackend(), store = await new NovelStore(disk).init();
  const service = new NovelService(store, { getModel, runModel });
  let closing;
  const close = () => closing ??= service.close();
  t.after(close);
  const other = withChapters(['  同名章节😀  ', '另一本书的第二章']);
  await store.serial(async () => { await store.insert(book); await store.insert(other); });
  return { disk, store, service, book, other, close };
}
const get = (service, book) => service.dispatch({ action: 'get', bookId: book.id });
const author = { user: true };

test('only the dispatch author context authorizes chapter moves and deletion, with zero rejected writes', async t => {
  const { disk, service, book } = await fixture(t);
  const length = disk.writes.length;
  for (const op of [move(book.chapters[0], 'down'), remove(book.chapters[0])]) {
    const input = { ...mutation(book, op), user: true };
    await assert.rejects(service.dispatch(input), { code: 'AUTHOR_ONLY' });
    await assert.rejects(service.dispatch(input, { user: false }), { code: 'AUTHOR_ONLY' });
  }
  assert.equal(disk.writes.length, length);
  assert.deepEqual(await get(service, book), book);
});

test('stale concurrent move and delete use book CAS, and rejected mutations never write', async t => {
  for (const first of ['move', 'delete']) await t.test(first, async t => {
    const { disk, service, book, other } = await fixture(t);
    const [a, b, c] = book.chapters;
    const ops = [move(a, 'down'), remove(b)];
    if (first === 'delete') ops.reverse();
    const writes = disk.writes.length;
    const [winner, loser] = await Promise.allSettled(ops.map(op => service.dispatch(mutation(book, op), author)));
    assert.equal(winner.status, 'fulfilled');
    assert.equal(loser.status, 'rejected');
    assert.equal(loser.reason.code, 'CONFLICT');
    assert.deepEqual(chapterIds(winner.value), (first === 'move' ? [b, a, c] : [a, c]).map(chapter => chapter.id));
    assert.equal(winner.value.revision, book.revision + 1);
    assert.deepEqual(await get(service, book), winner.value);
    assert.deepEqual(await get(service, other), other);
    assert.deepEqual(disk.writes.slice(writes), [['put', `ycx_moxu_book_${book.id.replaceAll('-', '_')}`, 'books', book.id]]);
  });
});

test('card conflict and title mismatch reject atomically at the serialized persistence boundary', async t => {
  let book = addCard(richBook(), '可换的单章卡', 1, 1);
  book = addCard(book, '限制移动的尾部卡', 2, null);
  book = addCard(book, '限制删除的单章卡', 2, 2);
  const { disk, service } = await fixture(t, { book });
  const before = structuredClone([...disk.files]), writes = disk.writes.length;
  const [first, target] = book.chapters;
  await assert.rejects(service.dispatch(mutation(book, move(first, 'down')), author), { code: 'CHAPTER_CARD_RANGE', message: /限制移动的尾部卡/ });
  await assert.rejects(service.dispatch(mutation(book, remove(target)), author), { code: 'CHAPTER_CARD_RANGE', message: /限制删除的单章卡/ });
  await assert.rejects(service.dispatch(mutation(book, remove(target, target.title.trim())), author), { code: 'VALIDATION' });
  assert.deepEqual([...disk.files], before);
  assert.equal(disk.writes.length, writes);
  assert.deepEqual(await get(service, book), book);
});

test('an empty chapter list stays openable and can be rebuilt after exact-title deletion', async t => {
  const book = addCard(withChapters(['  空间 😀  ']), '单章卡', 1, 1);
  const { service } = await fixture(t, { book });
  const [target] = book.chapters;
  await assert.rejects(service.dispatch(mutation(book, remove(target)), author), { code: 'CHAPTER_CARD_RANGE' });
  const widened = await service.dispatch(mutation(book, { action: 'saveCard', card: { id: book.cards[0].id, toChapter: null } }));
  const empty = await service.dispatch(mutation(widened, remove(target)), author);
  assert.deepEqual(empty.chapters, []);
  assert.deepEqual(empty.cards, widened.cards);
  assert.deepEqual(await get(service, book), empty);
  assert.equal((await service.dispatch({ action: 'list' })).books.find(entry => entry.id === book.id).chapterCount, 0);
  await assert.rejects(service.dispatch(mutation(empty, remove(target)), author), { code: 'NOT_FOUND' });
  const added = await service.dispatch(mutation(empty, { action: 'addChapter' }));
  assert.equal(added.chapters[0].title, '第 1 章');
  assert.notEqual(added.chapters[0].id, target.id);
  const renamed = await service.dispatch(mutation(added, { action: 'updateChapter', chapterId: added.chapters[0].id, patch: { title: target.title } }));
  assert.equal(renamed.chapters[0].title, target.title);
  assert.equal(renamed.chapters[0].id, added.chapters[0].id);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('running and cancelled-but-unsettled jobs block both chapter operations in their book only', async t => {
  const model = deferred();
  const { disk, store, service, book, other } = await fixture(t, { runModel: ({ signal }) => {
    signal.addEventListener('abort', () => model.reject(signal.reason), { once: true });
    return model.promise;
  } });
  const [first, second, third] = book.chapters;
  const mutations = [move(first, 'down'), remove(second)].map(op => mutation(book, op));
  const writes = disk.writes.length;
  const generating = service.dispatch({ action: 'generate', bookId: book.id, chapterId: third.id, expectedRevision: book.revision, mode: 'draft' });
  // Enqueue behind the generation before it registers its live job; these must
  // not pass a busy check taken outside the critical section.
  const [{ jobId }] = await Promise.all([generating, ...mutations.map(input => assert.rejects(service.dispatch(input, author), { code: 'BUSY' }))]);
  const job = service.live.get(jobId);
  assert.deepEqual(disk.writes.slice(writes), [['put', 'ycx_moxu_index', 'jobs', jobId]]);
  assert.deepEqual(await get(service, book), book);
  const otherMoved = await service.dispatch(mutation(other, move(other.chapters[0], 'down')), author);
  const otherDeleted = await service.dispatch(mutation(otherMoved, remove(other.chapters[0])), author);
  assert.deepEqual(otherDeleted.chapters, [other.chapters[1]]);

  // Queue the author mutations before the cancellation's final job write, so
  // each sees the real terminal status while the live promise is still pending.
  const gate = deferred();
  const hold = store.serial(() => gate.promise);
  try {
    const rejected = mutations.map(input => assert.rejects(service.dispatch(input, author), { code: 'BUSY' }));
    await service.dispatch({ action: 'cancel', jobId });
    await model.promise.catch(() => {});
    assert.equal(job.status, 'cancelled');
    assert.notEqual(job.settled, true);
    assert.equal(store.jobs.get(jobId).status, 'running', 'terminal update has not persisted yet');
    gate.resolve();
    await Promise.all(rejected);
    await job.promise;
    assert.equal(job.settled, true);
    assert.deepEqual(await get(service, book), book);
    const moved = await service.dispatch(mutation(book, move(first, 'down')), author);
    assert.deepEqual(chapterIds(moved), [second.id, first.id, third.id]);
    const removed = await service.dispatch(mutation(moved, remove(second)), author);
    assert.deepEqual(await get(service, book), removed);
  } finally { gate.resolve(); await hold; }
});

test('deleting a chapter changes only its book unit and keeps preexisting job records and reads', async t => {
  const { disk, store, service, book, other, close } = await fixture(t);
  const [target] = book.chapters;
  const records = [book, other].map(value => ({
    id: `job-${value.id}`, bookId: value.id, chapterId: value.chapters[0].id, status: 'completed',
    createdAt: value.createdAt, sessionId: `session-${value.id}`, request: { sourceBody: value.chapters[0].body },
  }));
  await store.serial(async () => { for (const record of records) await store.saveJob(record); });
  const previousIndex = structuredClone(disk.files.get('ycx_moxu_index'));
  const writes = disk.writes.length;
  const next = await service.dispatch(mutation(book, remove(target)), author);
  const stored = await get(service, book);
  assert.deepEqual(stored, next);
  assert.deepEqual(chapterIds(stored), chapterIds(book).slice(1));
  assert.deepEqual(await get(service, other), other);
  assert.deepEqual(disk.files.get('ycx_moxu_index'), previousIndex);
  assert.deepEqual(disk.writes.slice(writes), [['put', `ycx_moxu_book_${book.id.replaceAll('-', '_')}`, 'books', book.id]]);
  await close();
  const reopened = new NovelService(await new NovelStore(disk).init(), { getModel, runModel: noModel });
  try {
    assert.deepEqual(await get(reopened, book), next);
    assert.deepEqual(await get(reopened, other), other);
    for (const { request: _request, ...publicJob } of records) {
      assert.deepEqual(await reopened.dispatch({ action: 'job', jobId: publicJob.id }), publicJob);
    }
  } finally { await reopened.close(); }
});
