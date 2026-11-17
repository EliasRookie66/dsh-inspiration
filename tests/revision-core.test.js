import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBook, mutateBook, buildContext, makeProposal, validateBook, cloneImportedBook, LIMITS } from '../core.js';
import { applyHunks } from '../revision.js';

const options = { mode: 'revise', instruction: '对话太生硬且偏少：改善语气，适度增加对话；保留原剧情。' };
function fixture(source = '相同甲相同乙相同丙', target = '相同A相同B相同C') {
  let book = mutateBook(createBook('测试'), { action: 'addChapter' });
  const chapterId = book.chapters[0].id;
  book = mutateBook(book, { action: 'updateChapter', chapterId, patch: { body: source } });
  book = mutateBook(book, { action: 'updateChapter', chapterId, patch: { summary: '已确认摘要' } });
  const context = buildContext(book, chapterId, options);
  const proposal = makeProposal(book, chapterId, options, target, context, { analysis: '人物在紧张环境中应该有停顿，而不是机械问答。只优化指定问题。' });
  book = mutateBook(book, { action: 'addProposal', proposal });
  return { book, proposal, chapterId, context };
}
const accept = (book, proposal, hunk) => mutateBook(book, { action: 'acceptRevisionHunk', proposalId: proposal.id, hunkId: hunk.id });
const reject = (book, proposal, hunk) => mutateBook(book, { action: 'rejectRevisionHunk', proposalId: proposal.id, hunkId: hunk.id });
const code = value => error => error.code === value;
const permutations = list => list.length ? list.flatMap((item, i) => permutations(list.filter((_, j) => i !== j)).map(rest => [item, ...rest])) : [[]];

// Export a compact assertion used by mutation tests with independently loaded core.
export function guardAssertions(core) {
  let book = core.mutateBook(core.createBook('guard'), { action: 'addChapter' });
  const chapterId = book.chapters[0].id;
  book = core.mutateBook(book, { action: 'updateChapter', chapterId, patch: { body: '甲一乙二丙' } });
  const p = core.makeProposal(book, chapterId, options, '甲A乙B丙', core.buildContext(book, chapterId, options), { analysis: '定位两个问题' });
  book = core.mutateBook(book, { action: 'addProposal', proposal: p });
  const acceptOp = { action: 'acceptRevisionHunk', proposalId: p.id, hunkId: p.review.hunks[0].id };
  const changedRevision = core.mutateBook(book, { action: 'updateChapter', chapterId, patch: { title: 'changed' } });
  assert.throws(() => core.mutateBook(changedRevision, acceptOp), code('STALE_PROPOSAL'));
  const changedBody = structuredClone(book); changedBody.chapters[0].body = '无关一乙二丙';
  assert.throws(() => core.mutateBook(changedBody, acceptOp), code('STALE_PROPOSAL'));
  const first = core.mutateBook(book, acceptOp);
  assert.equal(first.chapters[0].body, '甲A乙二丙');
  assert.equal(first.chapters[0].revision, book.chapters[0].revision + 1);
  assert.equal(first.chapters[0].history.at(-1).body, book.chapters[0].body);
  assert.throws(() => core.mutateBook(first, acceptOp), code('INVALID_STATE'));
  assert.throws(() => core.mutateBook(book, { action: 'acceptProposal', proposalId: p.id }), code('INVALID_STATE'));
  assert.throws(() => core.mutateBook(book, { action: 'updateProposal', proposalId: p.id, text: 'arbitrary' }), code('INVALID_STATE'));
  const corrupted = structuredClone(book); corrupted.proposals[0].text += '截断';
  assert.throws(() => core.validateBook(corrupted), code('VALIDATION'));
}

test('revise requires author elements, nonempty whole source, analysis and no selection; legacy shape retained', () => {
  const { book, chapterId, proposal } = fixture();
  assert.equal(proposal.mode, 'revise');
  assert.ok(proposal.review.analysis);
  for (const instruction of ['', '  ', undefined]) assert.throws(() => buildContext(book, chapterId, { mode: 'revise', ...(instruction === undefined ? {} : { instruction }) }), code('VALIDATION'));
  const empty = mutateBook(createBook('空'), { action: 'addChapter' });
  assert.throws(() => buildContext(empty, empty.chapters[0].id, options), code('VALIDATION'));
  for (const analysis of [undefined, '', ' ', 'x'.repeat(8001)]) assert.throws(() => makeProposal(book, chapterId, options, '优化', buildContext(book, chapterId, options), { analysis }), code('VALIDATION'));
  assert.throws(() => makeProposal(book, chapterId, options, '', buildContext(book, chapterId, options), { analysis: '策略' }), code('VALIDATION'));
  assert.throws(() => buildContext(book, chapterId, { ...options, selection: { start: 0, end: 1, text: '相' } }), code('VALIDATION'));
  const legacy = makeProposal(book, chapterId, { mode: 'draft' }, '新正文', buildContext(book, chapterId));
  assert.ok(!Object.hasOwn(legacy, 'review'));
  validateBook(mutateBook(book, { action: 'addProposal', proposal: legacy }));
});

test('context always includes full source or explicitly refuses, never clips revise source', () => {
  const source = `FULLSTART${'中'.repeat(12_000)}FULLEND`;
  const { book, chapterId, context } = fixture(source, source + '新');
  assert.ok(context.prompt.includes(JSON.stringify({ text: source })));
  assert.ok(context.report.included.some(part => part.label.includes('定向优化原稿')));
  assert.ok(!context.report.included.some(part => part.label === '当前正文参考'));
  assert.match(context.prompt, /保留故事情节.*作者意图/);
  const small = mutateBook(book, { action: 'updateBook', patch: { contextBudget: 1000 } });
  assert.throws(() => buildContext(small, chapterId, options), code('CONTEXT_BUDGET'));
});

test('every subset in every order saves only confirmed positions, immutable source/target, exact histories/revisions/summary', () => {
  const initial = fixture();
  const { proposal } = initial;
  assert.equal(proposal.review.hunks.length, 3);
  for (let mask = 0; mask < 8; mask++) for (const order of permutations([0, 1, 2])) {
    let book = initial.book, saves = 0;
    for (const index of order) {
      const before = structuredClone(book), hunk = proposal.review.hunks[index];
      const yes = Boolean(mask & 1 << index);
      book = yes ? accept(book, proposal, hunk) : reject(book, proposal, hunk);
      if (yes) saves++;
      const chapter = book.chapters[0], previous = before.chapters[0], current = book.proposals[0];
      assert.equal(book.revision, before.revision + 1);
      assert.equal(chapter.revision, proposal.sourceRevision + saves);
      assert.equal(chapter.body, applyHunks(proposal.sourceBody, current.review.hunks));
      assert.equal(current.sourceBody, proposal.sourceBody);
      assert.equal(current.sourceRevision, proposal.sourceRevision);
      assert.equal(current.text, proposal.text);
      if (yes) {
        assert.equal(chapter.history.length, previous.history.length + 1);
        const last = chapter.history.at(-1);
        assert.equal(last.body, previous.body); assert.equal(last.revision, previous.revision);
        assert.equal(last.reason, 'accept-revise-hunk');
        assert.equal(chapter.summaryRevision, null);
      } else assert.deepEqual(chapter, previous, 'rejection never writes body, history, summary or chapter revision');
    }
    assert.equal(book.proposals[0].state, mask ? 'accepted' : 'rejected');
    assert.equal(book.chapters[0].body, `相同${mask & 1 ? 'A' : '甲'}相同${mask & 2 ? 'B' : '乙'}相同${mask & 4 ? 'C' : '丙'}`);
  }
});

test('manual/concurrent/title/outline and revision-only staleness block both hunk operations atomically', () => {
  const initial = fixture(); const { proposal, chapterId } = initial;
  const hunk = proposal.review.hunks[0];
  const variants = [
    mutateBook(initial.book, { action: 'updateChapter', chapterId, patch: { title: '新标题' } }),
    mutateBook(initial.book, { action: 'updateChapter', chapterId, patch: { outline: '新提纲' } }),
    mutateBook(initial.book, { action: 'updateChapter', chapterId, patch: { body: '手动修改' } }),
  ];
  variants.push(mutateBook(variants[2], { action: 'updateChapter', chapterId, patch: { body: proposal.sourceBody } }));
  const concurrent = makeProposal(initial.book, chapterId, options, '并发正文', initial.context, { analysis: '并发' });
  let other = mutateBook(initial.book, { action: 'addProposal', proposal: concurrent });
  other = accept(other, concurrent, concurrent.review.hunks[0]); variants.push(other);
  for (const stale of variants) {
    validateBook(stale); // stale data must remain loadable/exportable
    const before = JSON.stringify(stale);
    assert.throws(() => accept(stale, proposal, hunk), code('STALE_PROPOSAL'));
    assert.throws(() => reject(stale, proposal, hunk), code('STALE_PROPOSAL'));
    assert.equal(JSON.stringify(stale), before);
  }
  const corruptBodyOnly = structuredClone(initial.book); corruptBodyOnly.chapters[0].body = '同revision不同全文';
  assert.throws(() => accept(corruptBodyOnly, proposal, hunk), code('STALE_PROPOSAL'));
});

test('whole rejection preserves accepted edits, permits safe stale dismissal, and zero diff never writes manuscript', () => {
  const { book, proposal, chapterId } = fixture();
  const one = accept(book, proposal, proposal.review.hunks[1]);
  const stale = mutateBook(one, { action: 'updateChapter', chapterId, patch: { body: '作者后来修改' } });
  const dismissed = mutateBook(stale, { action: 'rejectProposal', proposalId: proposal.id });
  assert.deepEqual(dismissed.chapters, stale.chapters);
  assert.equal(dismissed.proposals[0].state, 'accepted');
  assert.deepEqual(dismissed.proposals[0].review.hunks.map(h => h.state), ['rejected', 'accepted', 'rejected']);
  const noop = fixture('不变正文', '不变正文');
  assert.deepEqual(noop.proposal.review.hunks, []);
  assert.equal(noop.proposal.state, 'ready');
  const after = mutateBook(noop.book, { action: 'rejectProposal', proposalId: noop.proposal.id });
  assert.deepEqual(after.chapters, noop.book.chapters);
  assert.equal(after.proposals[0].state, 'rejected');
});

test('failed operations are atomic; invalid state/id/schema cannot bypass per-change review', () => {
  const { book, proposal } = fixture();
  const original = JSON.stringify(book);
  for (const operation of [
    { action: 'acceptProposal', proposalId: proposal.id },
    { action: 'updateProposal', proposalId: proposal.id, text: '直接替换' },
    { action: 'acceptRevisionHunk', proposalId: proposal.id, hunkId: randomUUID() },
    { action: 'acceptRevisionHunk', proposalId: proposal.id, hunkId: proposal.review.hunks[0].id, text: '额外' },
  ]) { assert.throws(() => mutateBook(book, operation)); assert.equal(JSON.stringify(book), original); }
  const once = accept(book, proposal, proposal.review.hunks[0]);
  for (const act of [accept, reject]) assert.throws(() => act(once, proposal, proposal.review.hunks[0]), code('INVALID_STATE'));
  guardAssertions({ createBook, mutateBook, makeProposal, buildContext, validateBook });
});

test('strict hostile review/import data is rejected before getters run; imports still clear valid proposals', () => {
  const { book } = fixture();
  const invalid = [
    p => delete p.review, p => { p.review.analysis = ''; }, p => { p.review.analysis = 'x'.repeat(8001); },
    p => { p.review.hunks[0].before = '伪造'; }, p => { p.review.hunks[0].after = p.review.hunks[0].before; },
    p => { p.review.hunks[1].start = p.review.hunks[0].start; }, p => { p.review.hunks[1].id = p.review.hunks[0].id; },
    p => { p.review.hunks.reverse(); }, p => { p.text += '无法重建'; }, p => { p.state = 'accepted'; },
    p => { p.review.hunks[0].state = 'accepted'; }, p => { p.review.extra = true; },
    p => { p.review.hunks.length = LIMITS.revisionHunks + 1; },
    p => { p.review.hunks[0].start = -0; }, p => { p.review.hunks[0].end = 0.5; },
    p => { p.review.hunks[0].after = '\ud800'; },
    p => { Object.defineProperty(p.review.hunks[0], 'after', { enumerable: true, get() { throw new Error('getter executed'); } }); },
    p => { Object.defineProperty(p.review, 'hunks', { enumerable: true, get() { throw new Error('getter executed'); } }); },
  ];
  for (const corrupt of invalid) {
    const broken = structuredClone(book); corrupt(broken.proposals[0]);
    assert.throws(() => validateBook(broken), code('VALIDATION'));
    assert.throws(() => cloneImportedBook(broken), code('VALIDATION'));
  }
  for (const [source, target, split] of [['😀甲', '😺甲', 1], ['甲\r\n乙', '甲\n乙', 2]]) {
    const data = fixture(source, target).book;
    data.proposals[0].review.hunks[0].start = split;
    assert.throws(() => validateBook(data), code('VALIDATION'));
  }
  assert.deepEqual(cloneImportedBook(book).proposals, []);
  const legacy = structuredClone(book); legacy.proposals[0].mode = 'draft';
  assert.throws(() => validateBook(legacy), code('VALIDATION'));
});

test('repeated identical generations use snapshot-local UUIDs; coarse fallback is explicitly persisted', () => {
  let { book, proposal, chapterId, context } = fixture();
  const repeated = makeProposal(book, chapterId, options, proposal.text, context, { analysis: '相同分析' });
  book = mutateBook(book, { action: 'addProposal', proposal: repeated });
  assert.notEqual(book.proposals[0].review.hunks[0].id, book.proposals[1].review.hunks[0].id);
  const coarse = fixture('甲'.repeat(1000), '乙'.repeat(1000));
  assert.match(coarse.proposal.context.warnings.join(''), /粗粒度.*未丢弃/);
  assert.deepEqual(Reflect.ownKeys(coarse.proposal.review.hunks), ['0', 'length']);
});
