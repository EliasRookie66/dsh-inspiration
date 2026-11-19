import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildContext, createBook, makeProposal, mutateBook } from '../core.js';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const f = new Function(section('    const equal =', '    const en =') + section('    const outlineTarget =', '    function Field(') +
  '\nreturn {workspace,bookIsAvailable,chapterOf,isDirty,autosaveStep,reviewSnapshot,reviewIsCurrent,outlineTarget,outlineProposals,outlineReviewProblem,outlineReviewReceipt};')();
const actions = section('          const openChapterOutline =', '          const download =');
function createFixture() {
  let book = createBook('隔离细纲作品');
  for (let i = 0; i < 2; i++) book = mutateBook(book, { action: 'addChapter', title: '重复章名' });
  const [a, b] = book.chapters;
  book = mutateBook(book, { action: 'updateChapter', chapterId: b.id, patch: { outline: '原细纲\r\n原计划', body: '已有正文' } });
  const request = { mode: 'outline', instruction: '', selection: null };
  const outline = makeProposal(book, b.id, request, '新的候选细纲😀', buildContext(book, b.id, request).report);
  book = mutateBook(book, { action: 'addProposal', proposal: outline });
  const calls = [], notices = [], current = { current: f.workspace(book, a.id) };
  const env = { ...f, current, epoch: { current: 0 }, alive: { current: true }, busyRef: { current: false }, loading: false, guard: null,
    confirm: null, polishRequirements: null, conflict: null, autosaveComposing: { current: false }, recoveryRef: { current: null }, tab: 'manage',
    outlineNeedsRefresh: '', outlineOwner: null, outlineInstruction: '', utilityFocusPending: {}, outlineFocusReturn: {},
    deletedBookIds: new Set(), unavailableBooks: { current: new Map() }, liveJobs: { current: [] }, job: null,
    modelPrefsRef: { current: { settings: { revision: 5 } } }, catalogRef: { current: null }, modelSaveRef: { current: false },
    navigationIntent: () => () => true, transition: async (fn) => fn(), withBusy: async fn => fn(), modelGenerationProblem: () => '',
    commit(w) { current.current = w; }, resetSelection() {}, setError(error) { env.error = error; }, setConflict(value) { env.conflict = value; },
    setOutlineOwner(owner) { env.outlineOwner = owner; }, setOutlineInstruction(value) { env.outlineInstruction = value; }, setOutlineSelection() {},
    setOutlineNeedsRefresh(id) { env.outlineNeedsRefresh = id; }, switchTab(value) { env.tab = value; }, navigatePage(value) { env.tab = value; },
    adopt(saved) { current.current = f.workspace(saved, current.current.chapterId); return true; }, rememberJob(value) { env.remembered = value; },
    setJob(value) { env.job = value; }, setPollError() {}, setPollVersion() {}, refreshList: async () => ({ activeJobs: [] }),
    setConfirm(value) { env.confirm = value; }, setNotice(value) { notices.push(value); }, t: key => key,
    async call(action, input) {
      calls.push([action, input]);
      const before = current.current.book;
      assert.equal(input.bookId, before.id);
      if (action === 'get') return before;
      assert.equal(input.expectedRevision, before.revision);
      return action === 'generate' ? { jobId: 'test-id' } : mutateBook(before, input.operation);
    },
  };
  const api = new Function('env', 'with(env){' + actions + '\nreturn {openChapterOutline,closeChapterOutline,startChapterOutline,decideChapterOutline,refreshChapterOutline};}')(env);
  return { a, b, book, outline, current, env, calls, notices, ...api };
}

test('a same-title management row opens and edits only its own chapter, then writing opens the same outline', async () => {
  const h = createFixture();
  await h.openChapterOutline(h.b.id, 'manage');
  assert.equal(h.env.tab, 'outline'); assert.equal(h.current.current.chapterId, h.b.id);
  assert.equal(h.current.current.candidateId, '', 'Never select outline proposals as manuscript candidates');
  assert.deepEqual(h.calls, [], 'Opening must not spend model tokens or write');
  const draft = h.current.current;
  h.current.current = { ...draft, chapter: { ...draft.chapter, outline: '手改细纲' } };
  const step = f.autosaveStep(h.current.current);
  assert.deepEqual(step.operation, { action: 'updateChapter', chapterId: h.b.id, patch: { outline: '手改细纲' } });
  h.env.adopt(mutateBook(h.current.current.book, step.operation));
  h.closeChapterOutline(); assert.equal(h.env.tab, 'manage');
  await h.openChapterOutline(h.b.id, 'writing');
  assert.equal(h.current.current.chapter.outline, '手改细纲');
  assert.equal(h.current.current.book.chapters[0].outline, '');
  assert.equal(h.current.current.chapter.body, '已有正文');
});

test('AI generation is explicit and uses exact owner and revisions, and only approval writes', async () => {
  const h = createFixture(); await h.openChapterOutline(h.b.id, 'manage');
  h.env.outlineInstruction = '补充一个转折';
  await h.startChapterOutline();
  assert.deepEqual(h.calls, [['generate', { bookId: h.book.id, chapterId: h.b.id, expectedRevision: h.book.revision, expectedModelRevision: 5, mode: 'outline', instruction: '补充一个转折', selection: null }]]);
  assert.equal(h.current.current.book, h.book);
  assert.equal(h.env.remembered.mode, 'outline');
  h.env.setJob(null);
  h.decideChapterOutline(h.outline, true);
  assert.equal(h.calls.length, 1);
  await h.env.confirm.run();
  assert.equal(h.calls[1][1].operation.action, 'acceptProposal');
  assert.equal(h.current.current.chapter.outline, h.outline.text);
  assert.equal(h.current.current.chapter.body, '已有正文');
  assert.deepEqual(h.notices, ['outlineSaved']);
});

test('dirty and stale sources cannot approve; a malformed reply blocks retry until refresh', async () => {
  const h = createFixture(); await h.openChapterOutline(h.b.id, 'manage');
  const w = h.current.current;
  h.current.current = { ...w, chapter: { ...w.chapter, outline: '本地未确认' } };
  h.decideChapterOutline(h.outline, true);
  assert.equal(h.env.error.message, 'saveFirst');
  await assert.rejects(h.startChapterOutline(), /saveFirst/);
  h.current.current = w;
  h.decideChapterOutline(h.outline, true);
  const save = h.env.confirm.run;
  h.env.adopt(mutateBook(w.book, { action: 'updateChapter', chapterId: h.b.id, patch: { outline: '别人已修改' } }));
  await assert.rejects(save(), /outlineCandidateStale/);
  assert.deepEqual(h.calls, []);
  h.current.current = w;
  h.decideChapterOutline(h.outline, true);
  const originalCall = h.env.call;
  h.env.call = async () => ({ id: w.book.id, revision: w.book.revision + 1, chapters: {} });
  await assert.rejects(h.env.confirm.run(), /outlineRefreshNeeded/);
  assert.equal(h.env.outlineNeedsRefresh, w.book.id);
  assert.equal(h.current.current, w);
  h.decideChapterOutline(h.outline, true);
  assert.equal(h.env.confirm, null);
  h.env.call = originalCall;
  await h.refreshChapterOutline();
  assert.equal(h.env.outlineNeedsRefresh, '');
});

test('the effective locale labels have no parenthetical qualifier', () => {
  for (const [start, end, expected] of [['    const en = {', '    const zh = {', 'Chapter plan'], ['    const zh = {', '    const toolbarIcons =', '本章计划']]) {
    const locale = section(start, end).match(/\bchapterOutline: '[^']*'/g);
    assert.deepEqual(locale, [`chapterOutline: '${expected}'`]);
  }
});

test('both visible entries use the same page; outline jobs bypass manuscript display and auto-selection', () => {
  assert.match(source, /openChapterOutline\(entry.id, 'manage'\)/);
  assert.match(source, /openChapterOutline\(w.chapterId, 'writing'\)/);
  assert.match(source, /case 'outline': return renderChapterOutline\(\)/);
  assert.match(source, /textarea\('chapter', 'outline',/);
  assert.match(source, /generatedDisplayRecord\(w, selectedProposal, job\?\.mode === 'outline' \? null : job,/);
  assert.match(source, /adopt\(latest\) && value.mode !== 'outline'/);
});
