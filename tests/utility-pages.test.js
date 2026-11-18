import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createBook, mutateBook } from '../core.js';

// Run the production navigation, management and request closures without a
// React renderer, real books, models, delays, or network access.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const part = (from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
  assert(a >= 0 && b > a, from);
  return source.slice(a, b);
};
const compile = (code, names, env) => new Function('env', `with (env) { ${code}\nreturn {${names}}; }`)(env);
const helpers = new Function(part('    const equal =', '    const en =') + '\nreturn {workspace,managementSnapshot,managementProblem,deletionProblem,isDirty,bookIsAvailable};')();
const navigation = part('          const toolPages =', '          const chapterTitleButtonRef =') + part('          const switchTab =', '          const commit =');
const preview = part('          const contextKey =', '          const generate =');
const rename = part('          const renameManagedBook =', '          // This follow-up');
const deletion = part('          const deleteManagedBook =', '          const inspectConflict =');
const fixture = () => {
  let book = mutateBook(createBook('原书名'), { action: 'addChapter', title: '测试章' });
  book = mutateBook(book, { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: '只用于测试的正文', summary: '旧摘要' } });
  const events = [], reports = [], errors = [], requests = [];
  const env = { ...helpers, current: { current: helpers.workspace(book) }, tab: 'writing', mode: 'draft', instruction: '', manager: null,
    deletedBookIds: new Set(), unavailableBooks: { current: new Map() }, uncertainDeletes: { current: new Set() },
    reviewRef: { current: { visible: true } }, alive: { current: true }, busyRef: { current: false }, loading: false,
    guard: null, confirm: null, conflict: null, job: null, liveJobs: { current: [] }, recoveryRef: { current: null }, polishRequirements: null,
    contextSequence: { current: 0 }, autosaveComposing: { current: false }, workspaceNavigation: { current: 0 }, utilityFocusPending: { current: '' }, autosaveRef: {},
    setTab: value => { env.tab = value; events.push(value); }, setManager: value => { env.manager = typeof value === 'function' ? value(env.manager) : value; },
    setSelectionPopup: () => {}, invalidateReviewReturn: () => {}, setError: value => errors.push(value), setContextError: value => errors.push(value),
    setContext: value => reports.push(value), setContextBusy: () => {}, t: key => key, withBusy: action => action(),
    call: async (...args) => { requests.push(args); throw Object.assign(new Error('isolated response lost'), { code: 'NETWORK' }); },
  };
  return { env, book, events, reports, errors, requests, ...compile(navigation + preview + rename + deletion, 'navigatePage,previewContext,renameManagedBook,deleteManagedBook', env) };
};

test('utility routing selects exactly one section including with no selected book', () => {
  const renderers = { tools: 'renderBookTools', manage: 'renderManagementPage', context: 'renderContextPage', advanced: 'renderDetailsPage' };
  const env = { w: null, ...Object.fromEntries(Object.values(renderers).map(name => [name, () => name])) };
  const { renderCurrentPage } = compile(part('          const renderCurrentPage =', "          return h('main'"), 'renderCurrentPage', env);
  for (const [tab, rendered] of Object.entries(renderers)) { env.tab = tab; assert.equal(renderCurrentPage(), rendered); }
  assert.doesNotMatch(source, /manager && h\(Modal|setBookToolsFor|mx-partner-advanced/);
});

test('utility navigation does not save or change a manuscript and refuses navigation during composition', () => {
  const h = fixture(), w = h.env.current.current;
  h.env.current.current = { ...w, chapter: { ...w.chapter, body: '本地未保存' } };
  h.navigatePage('manage');
  assert.equal(h.env.tab, 'manage'); assert.equal(h.env.reviewRef.current, null);
  assert.equal(h.env.utilityFocusPending.current, 'manage');
  assert(helpers.managementProblem(h.env.current.current, h.env.manager.snapshot));
  assert.equal(h.env.manager.typedTitle, '');
  h.env.autosaveComposing.current = true; h.navigatePage('advanced');
  assert.equal(h.env.tab, 'manage');
  h.env.autosaveComposing.current = false; h.navigatePage('context');
  assert.equal(h.env.tab, 'context'); assert.equal(h.env.manager, null);
  assert.deepEqual(h.requests, []); assert.equal(h.env.current.current.chapter.body, '本地未保存');
  assert.match(source, /!manual && \(busyRef.current \|\| !!guard \|\| !!confirm \|\| !!polishRequirements\)/);
});

test('a context page never installs a late result or error after navigation, abort or source change', async () => {
  for (const scenario of ['exit', 'abort', 'chapter-version', 'mode', 'error-exit', 'available', 'error']) {
    const h = fixture(), controller = new AbortController();
    h.navigatePage('context');
    let resolve, reject;
    h.env.call = (action, args, signal) => {
      assert.equal(action, 'context'); assert.equal(args.selection, null); assert.equal(signal, controller.signal);
      return new Promise((a, b) => { resolve = a; reject = b; });
    };
    const run = h.previewContext(controller.signal);
    if (scenario.endsWith('exit')) h.navigatePage('advanced');
    if (scenario === 'abort') controller.abort();
    if (scenario === 'chapter-version') h.env.current.current = helpers.workspace(mutateBook(h.book, { action: 'updateBook', patch: { premise: '更新' } }));
    if (scenario === 'mode') h.env.mode = 'revise';
    if (scenario.startsWith('error')) reject(new Error('临时失败')); else resolve({ prompt: '只读报告' });
    await run;
    assert.equal(h.reports.length, scenario === 'available' ? 1 : 0, scenario);
    assert.equal(h.errors.filter(Boolean).length, scenario === 'error' ? 1 : 0, scenario);
  }
  assert.match(source, /if \(tab !== 'context' \|\| previewProblem\) return;/);
  assert.match(source, /return \(\) => \{ contextSequence.current\+\+; controller.abort\(\); \}/);
});

test('deletion still validates exact title, revision and running jobs; a lost receipt blocks retry after navigation', async () => {
  const h = fixture(); h.navigatePage('manage');
  h.env.manager.typedTitle = h.book.title + ' ';
  await assert.rejects(h.deleteManagedBook(), /deleteTypeTitle/);
  h.env.manager.typedTitle = h.book.title;
  h.env.job = { bookId: h.book.id, status: 'running' };
  await assert.rejects(h.deleteManagedBook(), /deleteBusy/); h.env.job = null;
  const changed = mutateBook(h.book, { action: 'updateBook', patch: { premise: '发生变化' } });
  h.env.current.current = helpers.workspace(changed);
  await assert.rejects(h.deleteManagedBook(), /confirmChanged/);
  h.env.current.current = helpers.workspace(h.book);
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.deleteManagedBook(), /deleteUncertain/);
  assert.deepEqual(h.requests, [['delete', { bookId: h.book.id, expectedRevision: h.book.revision, confirmTitle: h.book.title }]]);
  h.navigatePage('tools'); h.navigatePage('manage');
  assert.equal(h.env.manager.typedTitle, ''); assert.equal(h.env.manager.uncertain, true);
  h.env.manager.typedTitle = h.book.title;
  await assert.rejects(h.deleteManagedBook(), /deleteUncertain/);
  assert.equal(h.requests.length, 1); assert.equal(h.env.current.current.book, h.book);
});

test('renaming stays on Management and rebinds to the acknowledged revision, not an older delete intent', async () => {
  const h = fixture(); h.navigatePage('manage');
  h.env.manager.typedTitle = h.book.title;
  h.env.manager.title = '新书名';
  h.env.setNotice = value => h.events.push(value);
  h.env.mutateRaw = async operation => {
    h.requests.push(operation);
    const saved = mutateBook(h.env.current.current.book, operation);
    h.env.current.current = helpers.workspace(saved);
    return saved;
  };
  await h.renameManagedBook();
  assert.equal(h.env.tab, 'manage');
  assert.deepEqual(h.requests, [{ action: 'updateBook', patch: { title: '新书名' } }]);
  assert.equal(h.env.manager.snapshot.revision, h.book.revision + 1);
  assert.equal(h.env.manager.snapshot.title, '新书名'); assert.equal(h.env.manager.typedTitle, '');
  assert.deepEqual(h.env.current.current.book.chapters, h.book.chapters);
});

test('only Tools exports JSON; Settings redirects to the one rename flow; details never builds a fresh preview', () => {
  assert.equal(source.split("() => exportBook('json')").length, 2);
  assert.doesNotMatch(source, /input\('settings', 'title'/);
  const details = part('          const renderDetailsPage =', '          const writingLayout =');
  assert.match(details, /renderReport\(\{ report: proposal.context \}, 'generatedContext'\)/);
  assert.match(details, /job.proposalId === proposal\?\.id && proposal\?\.review\?\.analysis/);
  assert.doesNotMatch(details, /previewContext|context\.data|call\('context'/);
  assert.equal(source.split('renderModelPicker()').length, 2);
});
