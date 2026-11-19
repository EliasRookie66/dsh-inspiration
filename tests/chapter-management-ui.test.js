import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createBook, mutateBook } from '../core.js';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}
const helpers = new Function(section('    const equal =', '    const en =') + '\nreturn {workspace,managementSnapshot,managementProblem,chapterMutationReceipt,bookIsAvailable,missingChapterDraft};')();
const actions = section('          const managedChapterProblem =', '          const doImport =');
function fixture() {
  let book = createBook('隔离书');
  for (const title of ['同名', '同名', '最后一章']) book = mutateBook(book, { action: 'addChapter', title });
  const start = helpers.workspace(book, book.chapters[1].id), sent = [], notices = [];
  const env = { ...helpers, current: { current: start }, busyRef: { current: false }, deletedBookIds: new Set(), unavailableBooks: { current: new Map() },
    recoveryRef: { current: null }, uncertainChapterWrites: { current: new Set() }, autosaveComposing: { current: false }, epoch: { current: 0 },
    alive: { current: true }, job: null, liveJobs: { current: [] }, conflict: null, manager: { snapshot: helpers.managementSnapshot(start), typedTitle: '隔离书' },
    confirm: null, newChapter: ' 新章 ', chapterDeleteTrigger: {}, chapterDeleteFocusPending: {}, t: key => key, withBusy: action => action(),
    adopt: value => { env.current.current = helpers.workspace(value, env.current.current.chapterId); return true; }, commit: value => { env.current.current = value; },
    call: async (name, input) => { assert.equal(name, 'mutate'); sent.push(input); assert.equal(input.expectedRevision, env.current.current.book.revision); return mutateBook(env.current.current.book, input.operation); },
    setManager: value => { env.manager = value(env.manager); }, setNewChapter: value => { env.newChapter = value; },
    setConfirm: value => { env.confirm = typeof value === 'function' ? value(env.confirm) : value; },
    setError: error => { env.error = error; }, setNotice: value => notices.push(value), resetSelection() {}, setJob() {}, setPollError() {},
  };
  const api = new Function('env', 'with (env) { ' + actions + '\nreturn {addChapter,renameManagedChapter,moveManagedChapter,requestChapterDeletion,confirmChapterDeletion}; }')(env);
  return { ...api, env, book, sent, notices };
}

test('chapter management adds, renames, and moves by stable ID while staying on the selected chapter', async () => {
  const h = fixture(), [a, b, c] = h.book.chapters;
  await h.addChapter();
  await h.renameManagedChapter(b.id, ' 新标题 ');
  await h.moveManagedChapter(b.id, 'up');
  const w = h.env.current.current;
  assert.deepEqual(w.book.chapters.slice(0, 3).map(item => item.id), [b.id, a.id, c.id]);
  assert.equal(w.chapterId, b.id);
  assert.equal(w.chapter.title, '新标题');
  assert.equal(w.book.chapters.at(-1).title, '新章');
  assert.equal(h.env.newChapter, '');
  assert.equal(h.env.manager.snapshot.revision, h.book.revision + 3);
  assert.deepEqual(h.notices, ['chapterAdded', 'chapterRenamed', 'chapterMoved']);
});

test('the chapter delete click only opens review; exact duplicate title deletes only the captured ID', async () => {
  const h = fixture(), [a, b, c] = h.book.chapters;
  const trigger = {};
  h.requestChapterDeletion({ currentTarget: trigger }, b, 2);
  assert.equal(h.env.chapterDeleteTrigger.current, trigger);
  assert.deepEqual(h.sent, []);
  assert.equal(h.env.confirm.chapterRemoval.number, 2);
  await h.confirmChapterDeletion({ ...h.env.confirm, typedTitle: '同名 ' });
  assert.deepEqual(h.sent, []);
  const confirmation = { ...h.env.confirm, typedTitle: '同名' };
  h.env.autosaveComposing.current = true;
  await h.confirmChapterDeletion(confirmation);
  h.env.autosaveComposing.current = false;
  assert.deepEqual(h.sent, []);
  await h.confirmChapterDeletion(confirmation);
  assert.deepEqual(h.sent[0].operation, { action: 'deleteChapter', chapterId: b.id, confirmTitle: b.title });
  assert.deepEqual(h.env.current.current.book.chapters, [a, c]);
  assert.equal(h.env.current.current.chapterId, c.id);
  assert.equal(h.env.confirm, null);
});

test('changes behind the deletion dialog and unresolved restoration refuse to write', async () => {
  for (const reason of ['revision', 'recovery', 'running']) {
    const h = fixture(), b = h.book.chapters[1];
    h.requestChapterDeletion({ currentTarget: {} }, b, 2);
    if (reason === 'revision') h.env.current.current = helpers.workspace(mutateBook(h.book, { action: 'updateBook', patch: { premise: '另一个版本' } }));
    if (reason === 'recovery') h.env.recoveryRef.current = { bookId: h.book.id };
    if (reason === 'running') h.env.liveJobs.current.push({ bookId: h.book.id, status: 'cancelled', settled: false });
    await assert.rejects(h.confirmChapterDeletion({ ...h.env.confirm, typedTitle: b.title }));
    assert.equal(h.sent.length, 0);
  }
});

test('a malformed success response does not clear the title draft or allow a retry without refresh', async () => {
  const h = fixture(); let requests = 0;
  h.env.call = async () => { requests++; return { ...h.book, revision: h.book.revision + 1 }; };
  await assert.rejects(h.addChapter(), /chapterWriteUncertain/);
  assert.equal(h.env.newChapter, ' 新章 ');
  assert.equal(h.env.current.current.book, h.book);
  await assert.rejects(h.addChapter(), /chapterWriteUncertain/);
  assert.equal(requests, 1);
});

test('chapter name field and add button share a non-wrapping row aligned at the input baseline', () => {
  const form = section("h('div', { className: 'mx-chapter-add-row'", "h('p', { className: 'mx-hint' }, t('chapterStructureHint'))");
  assert.match(form, /h\(Field, \{ label: t\('newChapterTitle'\) \}, h\('input', \{ ref: addChapterInputRef/);
  assert.match(form, /button\(t\('addChapter'\), addChapter, \{ disabled: disabled \|\| !newChapter\.trim\(\)/);
  assert.doesNotMatch(form, /mx-grow|mx-actions/);
  assert.match(source, /\.mx-chapter-add-row\{display:grid;grid-template-columns:minmax\(0,1fr\) auto;align-items:end;/);
  assert.match(source, /\.mx-chapter-add-row>\.mx-field>input[^,{]*,\.mx-root \.mx-chapter-add-row>button\{height:40px;min-height:40px\}/);
});

test('there is one add form, and both explicit rebase and autosave reconciliation guard against missing chapter identities', () => {
  assert.doesNotMatch(section('          const renderBookTools =', '          const renderChapterManagement ='), /addChapterInputRef/);
  assert.match(section('          const renderChapterManagement =', '          const renderContextPage ='), /ref: addChapterInputRef/);
  assert.match(source, /changeChapter\(id, 'writing'\)/);
  assert.match(source, /if \(missingChapterDraft\(latest, journal\)\)/);
  assert.equal((section('          const renderConflict =', '          const renderCreate =').match(/missingChapterDraft\(/g) || []).length, 3);
  assert.match(source, /disabled: busy \|\| !!chapterDeleteConfirm && \(confirm.uncertain \|\| confirm.typedTitle !== chapterDeleteConfirm.title \|\| !!chapterDeleteBlock\)/);
});
