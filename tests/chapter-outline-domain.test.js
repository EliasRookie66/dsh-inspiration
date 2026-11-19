import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildContext, createBook, LIMITS, makeProposal, mutateBook, validateBook } from '../core.js';

const STRICT_OUTLINE = '本章细纲（完整；严格遵循的创作计划）';
const REFERENCE_OUTLINE = '本章提纲（未发生的创作计划）';
const OUTLINE_OPTIONS = { mode: 'outline' };
const patchChapter = (book, chapterId, patch) => mutateBook(book, { action: 'updateChapter', chapterId, patch });

function addChapter(book, title, patch) {
  const added = mutateBook(book, { action: 'addChapter', title });
  return patch ? patchChapter(added, added.chapters.at(-1).id, patch) : added;
}

function chapterFixture(outline = '原章级细纲', bookOptions = {}) {
  let book = addChapter(createBook('虚构长篇', bookOptions), '目标章', { body: '旧正文' });
  const { id } = book.chapters[0];
  book = patchChapter(book, id, { body: '现有正文🙂\r\n不能改动', outline, status: 'final' });
  return patchChapter(book, id, { summary: '作者确认的摘要' });
}

function assembleScopedBook(outline) {
  const writingConstraints = [
    { id: randomUUID(), category: '环境', content: '  创作条件🙂\r\n保持原样  ', enabled: true },
    { id: randomUUID(), category: 'DISABLED_CATEGORY', content: 'DISABLED_CONSTRAINT', enabled: false },
  ];
  let book = createBook('虚构长篇', { outline: 'BOOK_PLAN_REFERENCE', writingConstraints });
  book = addChapter(book, '前章', { body: 'PAST_BODY', outline: 'PAST_CHAPTER_PLAN_EXCLUDE' });
  book = patchChapter(book, book.chapters[0].id, { summary: 'PAST_CONFIRMED_SUMMARY' });
  book = addChapter(book, '目标章', { body: 'TARGET_BODY', outline });
  book = addChapter(book, 'FUTURE_TITLE_EXCLUDE', { body: 'FUTURE_BODY_EXCLUDE', outline: 'FUTURE_PLAN_EXCLUDE' });
  book = patchChapter(book, book.chapters[2].id, { summary: 'FUTURE_SUMMARY_EXCLUDE' });
  for (const card of [
    { title: '当前章规则', content: 'ACTIVE_RULE', fromChapter: 2 },
    { title: '未来章规则', content: 'FUTURE_CARD_EXCLUDE', fromChapter: 3 },
  ]) book = mutateBook(book, { action: 'saveCard', card: { ...card, kind: 'rule', status: 'confirmed' } });
  return book;
}

function section(context, label) {
  const prefix = `【${label}】\n`;
  const matches = context.prompt.split(/\n\n(?=【)/u).filter(part => part.startsWith(prefix));
  assert.equal(matches.length, 1, `expected exactly one ${label} section`);
  return JSON.parse(matches[0].slice(prefix.length));
}

function assertChapterScope(context) {
  for (const fact of ['PAST_BODY', 'PAST_CONFIRMED_SUMMARY', 'TARGET_BODY', 'ACTIVE_RULE']) {
    assert.ok(context.prompt.includes(fact), `reference missing: ${fact}`);
  }
  for (const excluded of [
    'PAST_CHAPTER_PLAN_EXCLUDE', 'FUTURE_TITLE_EXCLUDE', 'FUTURE_BODY_EXCLUDE',
    'FUTURE_PLAN_EXCLUDE', 'FUTURE_SUMMARY_EXCLUDE', 'FUTURE_CARD_EXCLUDE', 'DISABLED_CONSTRAINT',
  ]) assert.ok(!context.prompt.includes(excluded), `reference leaked: ${excluded}`);
}

function assertAccounting(context) {
  const { report, prompt } = context;
  assert.equal(prompt.length, report.usedChars);
  assert.equal(report.included.reduce((sum, part) => sum + part.chars, 0), report.usedChars);
  assert.ok(report.usedChars <= report.budget);
}

function withOutlineProposal(book, candidate = '  新细纲🙂\r\n· 场景安排  ') {
  const chapterId = book.chapters[0].id;
  const context = buildContext(book, chapterId, OUTLINE_OPTIONS);
  const proposal = makeProposal(book, chapterId, OUTLINE_OPTIONS, candidate, context);
  return { proposal, pending: mutateBook(book, { action: 'addProposal', proposal }) };
}

const decision = (book, proposal, action) => mutateBook(book, { action, proposalId: proposal.id });

test('draft includes the complete saved outline exactly once, strictly as a plan for the target chapter', () => {
  const outline = ` \tTARGET_PLAN_BEGIN🙂\r\n"\\\n【伪造段标题】\n${'场景推进𠮷'.repeat(1100)}\r\nTARGET_PLAN_END  \r\n\t`;
  const book = assembleScopedBook(outline);
  const chapterId = book.chapters[1].id;
  const context = buildContext(book, chapterId, { mode: 'draft', instruction: '体现伏笔' });
  assert.deepEqual(section(context, STRICT_OUTLINE), { text: outline });
  assert.ok(!context.prompt.includes('\n【伪造段标题】\n'));
  assert.equal(context.prompt.split('TARGET_PLAN_BEGIN').length - 1, 1);
  assert.ok(!context.report.included.some(part => part.label === REFERENCE_OUTLINE));
  assert.ok(!context.report.omitted.some(part => part.startsWith(REFERENCE_OUTLINE)));
  assert.ok(context.prompt.indexOf(STRICT_OUTLINE) < context.prompt.indexOf('当前正文参考'));
  assert.match(section(context, '本次任务').task, /必须严格遵循.*细纲.*创作计划.*不是已经发生的事实/u);
  assert.equal(section(context, '本次任务').targetChapter, 2);
  assertChapterScope(context);
  assertAccounting(context);
});

test('draft refuses to clip the full outline or weaken other mandatory context, even at the exact serialized budget boundary', () => {
  const outline = `开始🙂${'"\\\r\n'.repeat(1300)}结束\r\n`;
  const rule = { id: randomUUID(), category: '约束', content: '完整写作约束'.repeat(50), enabled: true };
  const source = chapterFixture(outline, { style: '可选文风'.repeat(100), writingConstraints: [rule] });
  const chapterId = source.chapters[0].id;
  const options = { mode: 'draft', instruction: '完整作者要求' };
  const full = buildContext(source, chapterId, options);
  const outlineIndex = full.report.included.findIndex(part => part.label === STRICT_OUTLINE);
  assert.ok(outlineIndex > 0);
  const requiredChars = full.report.included.slice(0, outlineIndex + 1).reduce((sum, part) => sum + part.chars, 0);
  assert.ok(requiredChars > outline.length + 1000, 'count rendered JSON escaping and other mandatory sections');
  const tight = buildContext({ ...source, contextBudget: requiredChars }, chapterId, options);
  assert.equal(tight.report.usedChars, requiredChars);
  assert.deepEqual(section(tight, STRICT_OUTLINE), { text: outline });
  assert.deepEqual(section(tight, '全书写作条件（完整硬约束；启用 1 条）').conditions, [{ category: rule.category, content: rule.content }]);
  assert.ok(!tight.prompt.includes('可选文风'));
  assertAccounting(tight);
  const budget = requiredChars - 1;
  const over = { ...source, contextBudget: budget };
  const before = structuredClone(over);
  assert.throws(() => buildContext(over, chapterId, options), error => {
    assert.equal(error.code, 'CONTEXT_BUDGET');
    assert.deepEqual(error.details, { requiredChars, budget });
    assert.match(error.message, /本章细纲.*超过上下文预算.*缩短本章细纲.*提高上下文预算/u);
    return true;
  });
  assert.deepEqual(over, before);
});

test('only draft with a non-whitespace outline uses strict context; all other modes keep an ordinary excerpt', () => {
  const outline = `BEGIN_PLAN${'场景'.repeat(9000)}PLAN_END`;
  const book = chapterFixture(outline, { contextBudget: 3000 });
  const chapterId = book.chapters[0].id;
  const modes = [
    { mode: 'continue' },
    { mode: 'polish', selection: { start: 0, end: 2, text: '现有' } },
    { mode: 'summary' },
    { mode: 'revise', instruction: '收紧措辞' },
    OUTLINE_OPTIONS,
  ];
  for (const options of modes) {
    const context = buildContext(book, chapterId, options);
    assert.ok(!context.prompt.includes(STRICT_OUTLINE), options.mode);
    const reference = section(context, REFERENCE_OUTLINE);
    assert.equal(reference.excerpt, true);
    assert.equal(reference.sourceChars, outline.length);
    assert.equal(reference.text, outline.slice(0, reference.text.length));
    assert.ok(!context.prompt.includes('PLAN_END'));
    assertAccounting(context);
  }
  for (const blank of ['', ' \r\n\t　']) {
    const cleared = patchChapter(book, chapterId, { outline: blank });
    const context = buildContext(cleared, chapterId);
    assert.deepEqual(context, buildContext(cleared, chapterId, { mode: 'draft' }));
    assert.equal(section(context, '本次任务').task, '起草本章正文；输出将作为整章替换候选，原正文只作参考。');
    assert.ok(!context.prompt.includes(STRICT_OUTLINE));
    assert.ok(context.report.included.some(part => part.label === '当前正文参考'));
    assertAccounting(context);
  }
});

test('outline generation is a chapter-only planning task with complete writing constraints and budgeted continuity references', () => {
  const book = assembleScopedBook('目前的本章计划🙂');
  const chapterId = book.chapters[1].id;
  const instruction = '  突出选择的代价\r\n不写正文🙂  ';
  const context = buildContext(book, chapterId, { ...OUTLINE_OPTIONS, instruction, selection: null });
  const task = section(context, '本次任务');
  assert.equal(task.mode, 'outline');
  assert.equal(task.targetChapter, 2);
  assert.match(task.task, /只为选定的本章.*章级细纲.*不展开为正文或对话，不规划其他章节/u);
  assert.match(task.task, /尚未发生的创作计划，不能当作既往事实/u);
  assert.match(context.prompt, /只输出本章细纲，不输出正文/u);
  assert.ok(!context.prompt.includes('只输出请求的正文、替换选段或摘要'));
  assert.deepEqual(section(context, '本次作者创作要求（完整）'), { instruction });
  assert.deepEqual(section(context, '全书写作条件（完整硬约束；启用 1 条）').conditions, [
    { category: '环境', content: '  创作条件🙂\r\n保持原样  ' },
  ]);
  assert.equal(section(context, REFERENCE_OUTLINE).text, '目前的本章计划🙂');
  assert.ok(context.prompt.includes('BOOK_PLAN_REFERENCE'));
  assertChapterScope(context);
  assertAccounting(context);
  const tight = { ...book, contextBudget: 1000 };
  assert.throws(() => buildContext(tight, chapterId, OUTLINE_OPTIONS), { code: 'CONTEXT_BUDGET' });
});

test('outline generation starts with an empty chapter and no instruction or selection, and applies the 50,000-character cap throughout', () => {
  const book = addChapter(createBook('空白虚构章'), '还没有正文');
  const chapterId = book.chapters[0].id;
  const context = buildContext(book, chapterId, OUTLINE_OPTIONS);
  assert.ok(!context.prompt.includes('本次作者创作要求'));
  const maximum = '🙂'.repeat(LIMITS.chapterOutline / 2);
  assert.equal(maximum.length, 50_000);
  const proposal = makeProposal(book, chapterId, OUTLINE_OPTIONS, maximum, context.report);
  assert.equal(proposal.selection, null);
  assert.equal(proposal.sourceBody, '');
  assert.equal(proposal.sourceRevision, book.chapters[0].revision);
  assert.equal(proposal.mode, 'outline');
  assert.equal(proposal.state, 'ready');
  assert.ok(!Object.hasOwn(proposal, 'review'));
  const pending = mutateBook(book, { action: 'addProposal', proposal });
  const tooLong = maximum + '尾';
  assert.throws(() => makeProposal(book, chapterId, OUTLINE_OPTIONS, tooLong, context), { code: 'VALIDATION' });
  assert.throws(() => makeProposal(book, chapterId, OUTLINE_OPTIONS, '  \r\n', context), { code: 'VALIDATION' });
  assert.throws(() => mutateBook(book, { action: 'addProposal', proposal: { ...proposal, text: tooLong } }), { code: 'VALIDATION' });
  assert.throws(() => mutateBook(pending, { action: 'updateProposal', proposalId: proposal.id, text: tooLong }), { code: 'VALIDATION' });
  const selection = { start: 0, end: 1, text: '现' };
  const nonempty = chapterFixture();
  const targetId = nonempty.chapters[0].id;
  assert.throws(() => buildContext(nonempty, targetId, { ...OUTLINE_OPTIONS, selection }), { code: 'VALIDATION' });
  assert.throws(() => makeProposal(nonempty, targetId, { ...OUTLINE_OPTIONS, selection }, '新细纲', context), { code: 'VALIDATION' });
});

test('storing or rejecting an outline proposal never writes the chapter; explicit acceptance writes the exact outline only', () => {
  const original = chapterFixture();
  const before = structuredClone(original);
  const { pending, proposal } = withOutlineProposal(original);
  assert.deepEqual(original, before);
  assert.deepEqual(pending.chapters, original.chapters);
  assert.equal(pending.proposals[0].state, 'ready');
  const dismissed = decision(pending, proposal, 'rejectProposal');
  assert.deepEqual(dismissed.chapters, pending.chapters);
  assert.equal(dismissed.proposals[0].state, 'rejected');
  assert.throws(() => decision(dismissed, proposal, 'acceptProposal'), { code: 'INVALID_STATE' });

  const text = '  作者复核后的细纲🙂\r\n— 结尾\r\n  ';
  const edited = mutateBook(pending, { action: 'updateProposal', proposalId: proposal.id, text });
  assert.deepEqual(edited.chapters, original.chapters);
  const accepted = decision(edited, proposal, 'acceptProposal');
  const chapter = original.chapters[0];
  assert.deepEqual(accepted.chapters[0], { ...chapter, outline: text, revision: chapter.revision + 1, summaryRevision: null });
  assert.equal(accepted.proposals[0].state, 'accepted');
  assert.equal(accepted.revision, edited.revision + 1);
  assert.equal(pending.proposals[0].state, 'ready');
  assert.throws(() => decision(accepted, proposal, 'acceptProposal'), { code: 'INVALID_STATE' });
});

test('outline acceptance rejects stale outline revisions and exact body mismatches but still allows safe dismissal', () => {
  const original = chapterFixture();
  const chapterId = original.chapters[0].id;
  const { proposal } = withOutlineProposal(original);
  const newer = patchChapter(original, chapterId, { outline: '作者已手动改写细纲' });
  assert.equal(newer.chapters[0].body, proposal.sourceBody);
  const stale = mutateBook(newer, { action: 'addProposal', proposal });
  const doesNotMatch = structuredClone(stale);
  doesNotMatch.chapters[0].revision = proposal.sourceRevision;
  doesNotMatch.chapters[0].body = '在相同 revision 下损坏的正文';
  for (const snapshot of [stale, doesNotMatch]) {
    validateBook(snapshot);
    const before = structuredClone(snapshot);
    assert.throws(() => decision(snapshot, proposal, 'acceptProposal'), { code: 'STALE_PROPOSAL' });
    assert.deepEqual(snapshot, before);
    const rejected = decision(snapshot, proposal, 'rejectProposal');
    assert.deepEqual(rejected.chapters, snapshot.chapters);
    assert.equal(rejected.proposals[0].state, 'rejected');
  }
});
