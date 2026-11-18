import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBook, mutateBook } from '../core.js';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
const f = new Function(pure + '\nreturn {workspace,conflictingFields,mergeWorkspace,dirty,equal,autosaveRecoveryWorkspace};')();
const popupStart = source.indexOf('\n          error &&') + 1, popupEnd = source.indexOf("          h('div', { ref: contentRef", popupStart);
const popup = source.slice(popupStart, popupEnd);
const gateText = popup.slice(0, popup.indexOf('h(Modal,')).trim().replace(/&&\s*$/, '');
const gate = new Function('error', 'guard', 'confirm', 'manager', 'polishRequirements', `return Boolean(${gateText});`);
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

test('save errors use an alert dialog only on failure and do not stack existing dialogs', () => {
  assert.equal(gate(null, false, false, false, false), false);
  assert.equal(gate({ message: 'network failure' }, false, false, false, false), true);
  for (let i = 0; i < 4; i++) {
    const flags = [false, false, false, false]; flags[i] = true;
    assert.equal(gate({ message: 'failure' }, ...flags), false);
  }
  assert(popup.includes("onCancel: () => setError(null)"));
  assert(popup.includes("error.code === 'REVIEW_REQUIRED' ? 'reviewCheckFailed'"));
  assert(popup.includes("error.code !== 'REVIEW_REQUIRED' && button(t('autosaveRetry'), saveAll"));
  assert(popup.includes("button(t('reviewLatest'), inspectConflict)"));
  assert.match(source, /function Modal\([^\n]+role = 'alertdialog'/);
  assert(source.includes("ref, role, 'aria-modal': true"));
});

test('a real conflicting adoption raises the popup and preserves the local draft; harmless updates do not', () => {
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

test('dismissing the actual popup clears only its error, not the conflict or draft', () => {
  const handlerText = popup.match(/onCancel: (\(\) => setError\(null\))/)?.[1];
  assert(handlerText);
  let error = { code: 'CONFLICT' };
  const conflict = { fields: ['chapter'] }, draft = { body: 'must remain local' };
  const close = new Function('setError', `return (${handlerText});`)(value => { error = value; });
  close();
  assert.equal(error, null);
  assert.deepEqual(conflict, { fields: ['chapter'] });
  assert.equal(draft.body, 'must remain local');
  assert(!popup.includes('setConflict(null)'));
  assert(!popup.includes('discardScope('));
});
