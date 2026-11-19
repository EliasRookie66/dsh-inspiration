import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBook, mutateBook } from '../core.js';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
const f = new Function(pure + '\nreturn {workspace,conflictingFields,mergeWorkspace,dirty,equal,autosaveRecoveryWorkspace};')();
const adoptText = source.slice(source.indexOf('          const adopt ='), source.indexOf('          const loadLatest ='));
function harness(workspace) {
  const current = { current: workspace }, errors = [], conflicts = [], saved = [];
  const deps = { current, autosaveRef: { current: null }, autosaveRecoveryWorkspace: f.autosaveRecoveryWorkspace, bookIsAvailable: () => true, deletedBookIds: new Set(), unavailableBooks: { current: new Map() },
    dirty: f.dirty, equal: f.equal, conflictingFields: f.conflictingFields, mergeWorkspace: f.mergeWorkspace, setConflict: x => conflicts.push(x),
    setError: x => errors.push(x), persist: x => saved.push(x), commit: x => { current.current = x; },
    syncBookList: () => {}, setContext: () => {}, t: key => key };
  const adopt = new Function('deps', `const {${Object.keys(deps).join(',')}}=deps;\n${adoptText}\nreturn adopt;`)(deps);
  return { adopt, current, errors, conflicts, saved };
}

test('a real conflicting adoption marks the conflict and preserves the local draft; harmless updates do not', () => {
  let book = mutateBook(createBook('popup fixture'), { action: 'addChapter' });
  book = mutateBook(book, { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: 'saved source' } });
  const base = f.workspace(book), local = { ...base, chapter: { ...base.chapter, body: 'latest manual draft' } };
  const remote = mutateBook(book, { action: 'updateChapter', chapterId: base.chapterId, patch: { body: 'another saved version' } });
  const h = harness(local);
  assert.equal(h.adopt(remote), false);
  assert.deepEqual(h.errors, [{ code: 'CONFLICT', message: 'conflictTitle' }]);
  assert.deepEqual(h.conflicts[0].fields, ['chapter']);
  assert.equal(h.saved[0], local); assert.equal(h.current.current, local);
  const safe = harness(local), bookkeeping = mutateBook(book, { action: 'addChapter' });
  assert.equal(safe.adopt(bookkeeping), true);
  assert.deepEqual(safe.errors, []);
  assert.equal(safe.current.current.chapter.body, 'latest manual draft');
});
