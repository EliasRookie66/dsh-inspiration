import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const url = new URL('../core.js', import.meta.url);
const source = (await readFile(url, 'utf8')).replace("from './revision.js'", `from '${new URL('../revision.js', import.meta.url).href}'`);
const options = { mode: 'revise', instruction: '改善对话' };
const code = expected => error => error.code === expected;
async function load(text) { return import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`); }
function checks(core) {
  let book = core.mutateBook(core.createBook('guards'), { action: 'addChapter' });
  const chapterId = book.chapters[0].id;
  book = core.mutateBook(book, { action: 'updateChapter', chapterId, patch: { body: '相同甲相同乙相同丙' } });
  book = core.mutateBook(book, { action: 'updateChapter', chapterId, patch: { summary: '有效摘要' } });
  const p = core.makeProposal(book, chapterId, options, '相同A相同B相同C', core.buildContext(book, chapterId, options), { analysis: '定位问题' });
  book = core.mutateBook(book, { action: 'addProposal', proposal: p });
  const op = { action: 'acceptRevisionHunk', proposalId: p.id, hunkId: p.review.hunks[1].id };
  const revisionOnly = core.mutateBook(book, { action: 'updateChapter', chapterId, patch: { title: 'different' } });
  assert.throws(() => core.mutateBook(revisionOnly, op), code('STALE_PROPOSAL'));
  const bodyOnly = structuredClone(book); bodyOnly.chapters[0].body = '不匹配甲相同乙相同丙';
  assert.throws(() => core.mutateBook(bodyOnly, op), code('STALE_PROPOSAL'));
  const accepted = core.mutateBook(book, op);
  assert.equal(accepted.chapters[0].body, '相同甲相同B相同丙');
  assert.equal(accepted.chapters[0].revision, p.sourceRevision + 1);
  assert.equal(accepted.chapters[0].history.at(-1).body, book.chapters[0].body);
  assert.equal(accepted.chapters[0].summaryRevision, null);
  const next = core.mutateBook(accepted, { ...op, hunkId: p.review.hunks[0].id });
  assert.equal(next.chapters[0].body, '相同A相同B相同丙');
  const rejectOp = { action: 'rejectRevisionHunk', proposalId: p.id, hunkId: p.review.hunks[2].id };
  const rejected = core.mutateBook(book, rejectOp);
  assert.deepEqual(rejected.chapters, book.chapters);
  assert.throws(() => core.mutateBook(rejected, rejectOp), code('INVALID_STATE'));
  assert.throws(() => core.mutateBook(book, { action: 'acceptProposal', proposalId: p.id }), code('INVALID_STATE'));
  assert.throws(() => core.mutateBook(book, { action: 'updateProposal', proposalId: p.id, text: '任意正文' }), code('INVALID_STATE'));
  const corrupt = structuredClone(book); corrupt.proposals[0].text += '不完整';
  assert.throws(() => core.validateBook(corrupt), code('VALIDATION'));
  const wrongBefore = structuredClone(book); wrongBefore.proposals[0].review.hunks[0].before = '假';
  assert.throws(() => core.validateBook(wrongBefore), code('VALIDATION'));
  const resolved = core.mutateBook(next, { action: 'rejectProposal', proposalId: p.id });
  assert.equal(resolved.proposals[0].state, 'accepted');
  assert.deepEqual(resolved.chapters, next.chapters);
}

test('revision safety assertions pass against unmodified core', async () => checks(await load(source)));

const mutations = [
  ['chapter revision guard', "chapter.revision !== proposal.sourceRevision + accepted || chapter.body !== applyHunks(proposal.sourceBody, proposal.review.hunks)", "chapter.body !== applyHunks(proposal.sourceBody, proposal.review.hunks)"],
  ['full original body guard', "chapter.revision !== proposal.sourceRevision + accepted || chapter.body !== applyHunks(proposal.sourceBody, proposal.review.hunks)", "chapter.revision !== proposal.sourceRevision + accepted"],
  ['pending state guard', "if (hunk.state !== 'pending') fail('修改已经处理，不能再次确认', 'INVALID_STATE');", ''],
  ['immutable update guard', "if (proposal.mode === 'revise') fail('定向优化差异快照不可编辑，请重新生成', 'INVALID_STATE');", ''],
  ['per-hunk-only accept guard', "if (proposal.mode === 'revise') fail('定向优化必须逐处确认，不能整章采纳', 'INVALID_STATE');", ''],
  ['whole-target reconstruction guard', "if (applyHunks(proposal.sourceBody, proposal.review.hunks, ['pending', 'accepted', 'rejected']) !== proposal.text) fail('修订片段不能完整重建不可变的优化正文');", ''],
  ['summary invalidation', 'chapter.summaryRevision = null;', '/* disabled summary invalidation */'],
  ['prior accepted edits algebra', "const body = applyHunks(proposal.sourceBody, proposal.review.hunks);", "const body = proposal.sourceBody.slice(0, hunk.start) + hunk.after + proposal.sourceBody.slice(hunk.end);"],
  ['history records before body', 'body: chapter.body, revision: chapter.revision, reason, createdAt: stamp', 'body: patch.body, revision: chapter.revision, reason, createdAt: stamp'],
];
for (const [label, needle, replacement] of mutations) test(`mutation selfcheck kills removed ${label}`, async () => {
  assert.ok(source.includes(needle), `mutation anchor missing: ${label}`);
  const mutant = await load(source.replace(needle, replacement));
  assert.throws(() => checks(mutant), undefined, `safety assertions survived mutant: ${label}`);
});
