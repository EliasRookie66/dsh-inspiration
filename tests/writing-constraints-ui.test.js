import { transaction } from './continuous-edit-fixture.mjs';
import { legacyWorkspaceRegion } from './legacy-workspace-guard.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { createBook, mutateBook } from '../core.js';

// Execute actual pure Client helpers and scoped App callbacks, never fake React/DOM.
// Source assertions below are wiring coverage only, not a browser geometry claim.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
const f = new Function(pure + '\nreturn {bookFields,workspace,dirty,isDirty,patchOf,editWritingConstraints,editConstraintsMarkdown,textareaValue,validWritingConstraints,validRecovery,recoveryPayload,restoredWorkspace,conflictingFields,mergeWorkspace,capturePolishSnapshot,polishIntentProblem,createAutosaveController,validAutosaveRecovery,restoredAutosaveWorkspace,autosaveRecoveryWorkspace,applyConstraintsChanges,applyConstraintsInput,constraintsHistorySnapshot,constraintsHistoryTarget,sameConstraintsDraft};')();
const clone = value => JSON.parse(JSON.stringify(value));
const rule = (patch = {}) => ({ id: randomUUID(), category: '任意自定义类别😀', content: '环境\r\n对话、表达和心理均可自定义。', enabled: true, ...patch });
function fixture(rows = []) {
  let book = mutateBook(createBook('写作约束 UI'), { action: 'addChapter', title: '本章' });
  book = mutateBook(book, { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: '原文😀和后文' } });
  if (rows.length) book = mutateBook(book, { action: 'updateBook', patch: { writingConstraints: rows } });
  return f.workspace(book, book.chapters[0].id);
}
const edit = (w, id, field, value) => f.editWritingConstraints(w, w.book.id, { type: 'edit', id, field, value });
function callback(start, end, name, deps) {
  const text = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  return new Function('deps', `const {${Object.keys(deps).join(',')}} = deps;\n${text}\nreturn ${name};`)(deps);
}
function saveHarness(initial) {
  const current = { current: initial }, operations = [], recovery = [], notices = [];
  const send = async ({ bookId, expectedRevision, operation }) => {
    assert.equal(bookId, current.current.book.id);
    assert.equal(expectedRevision, current.current.book.revision, 'Every write consumes the previous actual acknowledgement');
    operations.push({ bookId, expectedRevision, operation: clone(operation) });
    return mutateBook(current.current.book, operation);
  };
  const controller = f.createAutosaveController({ getWorkspace: () => current.current, getEpoch: () => 0, isPaused: () => false,
    send, apply: next => { current.current = next; }, fail: error => { throw error; } });
  const deps = { current, conflict: null, dirty: f.dirty, patchOf: f.patchOf, validWritingConstraints: f.validWritingConstraints,
    autosaveRef: { current: controller }, reconcileAutosaveFailure: async () => {},
    withBusy: async action => { try { await action(); return true; } catch (error) { deps.error = error; return false; } },
    mutateRaw: async (operation, cleared) => {
      const next = await send({ bookId: current.current.book.id, expectedRevision: current.current.book.revision, operation });
      current.current = f.mergeWorkspace(current.current, next, cleared);
    }, t: key => key, alive: { current: true }, forgetDraft: id => recovery.push(['forget', id]),
    assignRecovery: value => recovery.push(['assign', value]), setNotice: value => notices.push(value), persist: () => recovery.push(['persist']) };
  const save = callback('          const saveAll = async () => {', '          const discardScope =', 'saveAll', deps);
  return { save, current, operations, recovery, notices, deps };
}

test('legacy missing field and new empty book have no false dirty state or invented conditions', () => {
  const w = fixture(); delete w.book.writingConstraints;
  const legacy = f.workspace(w.book, w.chapterId);
  assert.deepEqual(legacy.settings.writingConstraints, []);
  assert.deepEqual(legacy.baseSettings.writingConstraints, []);
  assert.equal(f.isDirty(legacy), false);
  assert.deepEqual(f.patchOf(legacy.baseSettings, legacy.settings), {});
  assert.equal(Object.hasOwn(legacy.book, 'writingConstraints'), false);
});

test('bookFields, workspace draft and baseline deep copy every row without canonical mutation', () => {
  const w = fixture([rule()]), original = clone(w.book);
  assert.notEqual(w.settings.writingConstraints, w.baseSettings.writingConstraints);
  assert.notEqual(w.settings.writingConstraints[0], w.baseSettings.writingConstraints[0]);
  assert.notEqual(w.settings.writingConstraints[0], w.book.writingConstraints[0]);
  w.settings.writingConstraints[0].content = '仅本地';
  assert.deepEqual(w.book, original);
  assert.equal(w.baseSettings.writingConstraints[0].content, original.writingConstraints[0].content);
});

test('native UUID blank new row remains recoverable draft; no insecure fallback', () => {
  const w = fixture(), before = clone(w);
  const added = f.editWritingConstraints(w, w.book.id, { type: 'add' });
  assert.deepEqual(w, before);
  assert.equal(added.settings.writingConstraints.length, 1);
  const row = added.settings.writingConstraints[0];
  assert.match(row.id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual({ ...row, id: 'UUID' }, { id: 'UUID', category: '', content: '', enabled: true });
  assert.equal(f.dirty(added).settings, true);
  assert.equal(f.validWritingConstraints(added.settings.writingConstraints), false);
  assert.equal(f.validRecovery(f.recoveryPayload(added), w.book.id), true);
  const restored = f.restoredWorkspace(w, clone(f.recoveryPayload(added)));
  assert.deepEqual(restored.settings.writingConstraints, added.settings.writingConstraints);
  assert.notEqual(restored.settings.writingConstraints[0], added.settings.writingConstraints[0]);
  assert.throws(() => f.editWritingConstraints(w, w.book.id, { type: 'add' }, {}), /constraintsCrypto/);
  assert.throws(() => f.editWritingConstraints(w, w.book.id, { type: 'add' }, { randomUUID: () => 'fake' }), /constraintsCrypto/);
});

test('toolbar commands enter the document transaction path, are book-scoped and never call models inline', () => {
  const initial = fixture([rule()]), current = { current: initial }, dispatched = []; let scheduled = 0, version = {};
  const constraintsHistory = { current: new WeakMap() }, pendingConstraintsStructure = { current: null };
  const constraintsEngine = { current: { bookId: initial.book.id, instance: {
    applyStructure({ text, payload }) {
      const update = transaction(current.current.constraintsEditor.text, text, { beforeVersion: version, payload, origin: 'input.structure' });
      dispatched.push(update);
      if (!actions.changeConstraintsMarkdown(initial.book.id, update)) return false;
      version = update.version; return true;
    },
  } } };
  const actions = callback('          const constraintsInputBlocked =', '          const closeSelectionPopup =', '{ changeWritingConstraint, changeConstraintsMarkdown, acceptConstraintInput }', {
    ...f, current, busyRef: { current: false }, loading: false, recoveryRef: { current: null }, alive: { current: true }, manager: null, confirm: null, guard: null,
    autosaveComposing: { current: false }, constraintsEngine, pendingConstraintsStructure, constraintsHistory, setConstraintsLimit() {}, persist() {}, forgetDraft() {},
    autosaveRef: { current: { schedule: () => { scheduled++; } } }, commit: next => { current.current = next; }, setNotice() {},
    setError: error => { throw error; }, t: key => key,
  });
  const id = initial.settings.writingConstraints[0].id, change = actions.changeWritingConstraint;
  change('another-book', { type: 'remove', id });
  assert.equal(current.current, initial); assert.equal(dispatched.length, 0);
  change(initial.book.id, { type: 'edit', id, field: 'category', value: '完全自定义类别' });
  change(initial.book.id, { type: 'edit', id, field: 'content', value: '新的有效内容' });
  change(initial.book.id, { type: 'edit', id, field: 'enabled', value: false });
  assert.equal(current.current.settings.writingConstraints[0].content, '新的有效内容');
  assert.equal(current.current.settings.writingConstraints[0].enabled, false);
  assert.equal(f.validRecovery(f.recoveryPayload(current.current), initial.book.id), true);
  assert.equal(dispatched.length, 3); assert.equal(scheduled, 3);
  assert.equal(actions.acceptConstraintInput(initial.book.id, dispatched.at(-1)), false, 'A toolbar proof may only be consumed synchronously');
  assert.equal(initial.book.writingConstraints[0].category, '任意自定义类别😀');
});

test('add/edit/toggle/reorder/delete all participate in the ordinary settings patch', () => {
  let w = fixture([rule(), rule({ category: '对话' })]);
  const [a, b] = w.settings.writingConstraints;
  w = edit(w, a.id, 'category', '未枚举的新条件');
  w = edit(w, a.id, 'enabled', false);
  w = f.editWritingConstraints(w, w.book.id, { type: 'move', id: a.id, direction: 1 });
  assert.deepEqual(w.settings.writingConstraints.map(row => row.id), [b.id, a.id]);
  const patch = f.patchOf(w.baseSettings, w.settings);
  assert.deepEqual(Object.keys(patch), ['writingConstraints']);
  w = f.editWritingConstraints(w, w.book.id, { type: 'remove', id: b.id });
  assert.equal(w.settings.writingConstraints.length, 1);
  assert.equal(w.book.writingConstraints.length, 2);
  const full = fixture(Array.from({ length: 64 }, () => rule()));
  assert.throws(() => f.editWritingConstraints(full, full.book.id, { type: 'add' }), /constraintsLimit/);
});

test('actual Save all uses existing updateBook patch and sequential CAS, then reload is clean', async () => {
  let w = fixture([rule()]);
  w = edit(w, w.settings.writingConstraints[0].id, 'content', '保存的新条件😀');
  w = { ...w, chapter: { ...w.chapter, body: w.chapter.body + '手动正文' } };
  const h = saveHarness(w);
  assert.equal(await h.save(), true);
  assert.deepEqual(h.operations.map(item => item.operation.action), ['updateChapter', 'updateBook']);
  assert.deepEqual(h.notices, [], 'Successful explicit saves remain quiet as well as background autosaves');
  assert.equal(h.operations[1].expectedRevision, h.operations[0].expectedRevision + 1);
  assert.deepEqual(h.operations[1].operation.patch, { writingConstraints: w.settings.writingConstraints });
  assert.equal(f.isDirty(h.current.current), false);
  assert.deepEqual(f.workspace(h.current.current.book).settings.writingConstraints, w.settings.writingConstraints);
  assert.deepEqual(f.workspace(fixture().book).settings.writingConstraints, []);
});

test('blank new row fails explicit Save before any other draft or canonical value is saved', async () => {
  let w = fixture();
  w = f.editWritingConstraints(w, w.book.id, { type: 'add' });
  w = { ...w, chapter: { ...w.chapter, body: '其他未保存的正文' } };
  const h = saveHarness(w);
  assert.equal(await h.save(), false);
  assert.match(h.deps.error.message, /constraintsMarkdownInvalid/);
  assert.deepEqual(h.operations, []);
  assert.equal(h.current.current.chapter.body, '其他未保存的正文');
  assert.deepEqual(h.recovery, [['persist']]);
});

test('background merge protects local constraints; concurrent saved settings conflict, explicit rebase keeps draft', () => {
  const w = fixture([rule()]), id = w.settings.writingConstraints[0].id;
  const draft = edit(w, id, 'content', '本地约束');
  const background = mutateBook(w.book, { action: 'addChapter', title: '后台新章' });
  assert.deepEqual(f.conflictingFields(draft, background), []);
  const merged = f.mergeWorkspace(draft, background);
  assert.equal(merged.settings.writingConstraints[0].content, '本地约束');
  assert.equal(f.dirty(merged).settings, true);
  const remote = mutateBook(w.book, { action: 'updateBook', patch: { writingConstraints: [rule({ content: '远端规则' })] } });
  assert.deepEqual(f.conflictingFields(draft, remote), ['settings']);
  const rebase = f.mergeWorkspace(draft, remote, null, true);
  assert.equal(rebase.settings.writingConstraints[0].content, '本地约束');
  assert.equal(rebase.baseSettings.writingConstraints[0].content, '远端规则');
  assert.equal(f.validRecovery(f.recoveryPayload(rebase), rebase.book.id), true, 'Explicitly rebased Markdown drafts remain recoverable before ACK');
  assert.equal(f.isDirty(rebase), true);
});

test('legacy settings recovery preserves old manual edits and current saved nonempty constraints', async () => {
  const w = fixture([rule()]), legacy = f.recoveryPayload({ ...w, settings: { ...w.settings, title: '恢复旧标题' }, chapter: { ...w.chapter, body: '恢复旧正文' } });
  delete legacy.settings.writingConstraints; delete legacy.baseSettings.writingConstraints;
  delete legacy.constraintsEditor; // Genuine pre-constraint recovery never contained a Markdown editor journal.
  assert.equal(f.validRecovery(legacy, w.book.id), true);
  const restored = f.restoredWorkspace(w, legacy);
  assert.equal(restored.settings.title, '恢复旧标题');
  assert.equal(restored.chapter.body, '恢复旧正文');
  assert.deepEqual(restored.settings.writingConstraints, w.book.writingConstraints);
  assert.deepEqual(restored.baseSettings.writingConstraints, w.book.writingConstraints);
  assert.notEqual(restored.settings.writingConstraints[0], restored.baseSettings.writingConstraints[0]);
  assert.deepEqual(f.patchOf(restored.baseSettings, restored.settings), { title: '恢复旧标题' });
  assert.deepEqual(f.conflictingFields(restored, w.book), []);
  const h = saveHarness(restored); assert.equal(await h.save(), true);
  assert.deepEqual(h.current.current.book.writingConstraints, w.book.writingConstraints);
  const empty = fixture(); delete empty.book.writingConstraints;
  const missing = clone(legacy); missing.bookId = empty.book.id; missing.chapterId = empty.chapterId;
  const oldEmpty = f.restoredWorkspace(empty, missing);
  assert.deepEqual(oldEmpty.settings.writingConstraints, []);
  const explicitEmpty = clone(legacy); explicitEmpty.settings.writingConstraints = [];
  explicitEmpty.baseSettings.writingConstraints = clone(w.book.writingConstraints);
  assert.equal(f.validRecovery(explicitEmpty, w.book.id), true);
  assert.deepEqual(f.restoredWorkspace(w, explicitEmpty).settings.writingConstraints, []);
});

test('recovery rejects injected bad types, malformed exact rows, duplicate IDs, Unicode and length violations', () => {
  const w = fixture([rule()]);
  const valid = f.recoveryPayload(edit(w, w.settings.writingConstraints[0].id, 'content', '草稿'));
  for (const rows of [null, {}, 'rules', [null], [rule({ enabled: 1 })], [rule({ category: 1 })], [rule({ content: [] })], [rule({ id: 'fake' })], [rule({ extra: true })], [rule({ category: 'x'.repeat(81) })], [rule({ content: '😀'.repeat(2001) })], [rule({ category: '\ud800', content: '\udc00' })], Array(1), Array.from({ length: 65 }, () => rule())]) {
    for (const field of ['settings', 'baseSettings']) {
      const bad = clone(valid); bad[field].writingConstraints = rows;
      assert.equal(f.validRecovery(bad, w.book.id), false, `invalid ${field}`);
    }
  }
  const duplicate = rule(), duplicateCase = { ...duplicate, id: duplicate.id.toUpperCase() };
  assert.equal(f.validWritingConstraints([duplicate, duplicateCase], true), false);
  const accessor = rule(); Object.defineProperty(accessor, 'content', { enumerable: true, get() { throw new Error('must not invoke'); } });
  assert.equal(f.validWritingConstraints([accessor], true), false);
  const injected = clone(valid);
  Object.defineProperty(injected.settings, 'writingConstraints', { enumerable: true, get() { throw new Error('must not invoke'); } });
  assert.equal(f.validRecovery(injected, w.book.id), false);
  assert.equal(f.validRecovery(valid, 'another-book'), false);
  assert.equal(f.validWritingConstraints([rule({ category: '😀'.repeat(40), content: '😀'.repeat(2000) })]), true);
});

test('present undefined or hidden recovery constraint field is rejected instead of treated as legacy absence', () => {
  const w = fixture([rule()]);
  const valid = f.recoveryPayload(edit(w, w.settings.writingConstraints[0].id, 'content', '恢复草稿'));
  for (const field of ['settings', 'baseSettings']) {
    const undefinedField = clone(valid); undefinedField[field].writingConstraints = undefined;
    assert.equal(f.validRecovery(undefinedField, w.book.id), false);
    const hiddenField = clone(valid);
    Object.defineProperty(hiddenField[field], 'writingConstraints', { value: [], enumerable: false });
    assert.equal(f.validRecovery(hiddenField, w.book.id), false);
    const absentField = clone(valid); delete absentField[field].writingConstraints;
    assert.equal(f.validRecovery(absentField, w.book.id), false);
  }
});

test('mixed-presence recovery cannot replace a missing rule baseline with newer remote conditions', () => {
  const w = fixture([rule()]);
  const local = edit(w, w.settings.writingConstraints[0].id, 'content', '过期本地规则');
  const payload = f.recoveryPayload(local);
  const remote = mutateBook(w.book, { action: 'updateBook', patch: { writingConstraints: [rule({ content: '并发保存的新规则' })] } });
  const active = f.workspace(remote, w.chapterId);
  assert.deepEqual(f.conflictingFields(f.restoredWorkspace(active, payload), remote), ['settings']);
  for (const field of ['settings', 'baseSettings']) {
    const mixed = clone(payload); delete mixed[field].writingConstraints;
    assert.equal(f.validRecovery(mixed, w.book.id), false);
    let committed = false, error = null;
    const current = { current: active };
    const restore = callback('          const restoreRecovery =', '          const chooseCandidate =', 'restoreRecovery', {
      current, recoveryRef: { current: mixed }, validAutosaveRecovery: f.validAutosaveRecovery, restoredAutosaveWorkspace: f.restoredAutosaveWorkspace,
      autosaveRef: { current: { restorePendingCard: () => { throw new Error('Invalid recovery must never bind an identity'); } } },
      commit: () => { committed = true; }, setError: value => { error = value; }, t: key => key,
      assignRecovery: () => {}, resetSelection: () => {}, setNotice: () => {}, conflictingFields: f.conflictingFields, setConflict: () => {},
    });
    restore();
    assert.equal(committed, false);
    assert.equal(error.message, 'requestFailed');
    assert.equal(current.current, active);
    assert.equal(current.current.book.writingConstraints[0].content, '并发保存的新规则');
  }
});

test('restoring incomplete Markdown opens the same editor in literal mode', () => {
  const active = fixture([rule()]);
  const invalid = f.editConstraintsMarkdown(active, active.book.id, active.constraintsEditor.text + '\n- 未完成类别');
  const payload = f.recoveryPayload(invalid);
  assert.equal(f.validAutosaveRecovery(payload, active.book.id), true);
  const current = { current: active }, constraintsFocusRef = { current: null };
  let committed = null, restored = 'pending', sourceBook = '', tab = '', conflict = 'unset', error = null;
  const restore = callback('          const restoreRecovery =', '          const chooseCandidate =', 'restoreRecovery', {
    current, recoveryRef: { current: payload }, validAutosaveRecovery: f.validAutosaveRecovery, restoredAutosaveWorkspace: f.restoredAutosaveWorkspace,
    autosaveRef: { current: { restorePendingCard: () => {} } },
    commit: value => { committed = value; current.current = value; }, setError: value => { error = value; }, t: key => key,
    assignRecovery: value => { restored = value; }, resetSelection: () => {}, setNotice: () => {}, conflictingFields: f.conflictingFields,
    setConflict: value => { conflict = value; }, textareaValue: f.textareaValue, constraintsFocusRef,
    setConstraintsSourceBook: value => { sourceBook = value; }, switchTab: value => { tab = value; },
  });
  restore();
  assert.equal(error, null);
  assert.equal(committed.constraintsEditor.text, invalid.constraintsEditor.text);
  assert.equal(committed.constraintsEditor.error, invalid.constraintsEditor.error);
  assert.equal(restored, null);
  assert.equal(sourceBook, active.book.id);
  assert.equal(tab, 'constraints');
  const end = f.textareaValue(invalid.constraintsEditor.text).length;
  assert.deepEqual(constraintsFocusRef.current, { bookId: active.book.id, start: end, end });
  assert.equal(conflict, null);
});

test('a remount restores viewport only for the same book and unchanged draft', () => {
  const w = fixture([rule()]);
  const draft = f.constraintsHistorySnapshot(w), same = f.constraintsHistorySnapshot(structuredClone(w));
  assert.equal(f.sameConstraintsDraft(draft, same), true);
  assert.equal(f.sameConstraintsDraft(draft, { ...same, text: same.text + ' ' }), false);
  const differentId = { ...same, rows: same.rows.map(row => ({ ...row, id: randomUUID() })) };
  assert.equal(f.sameConstraintsDraft(draft, differentId), false);
  assert.match(source, /saved\?\.bookId === bookId && sameConstraintsDraft\(saved\.draft, draft\) \? saved\.view : null/);
  assert.match(source, /viewport\.current = \{ bookId, draft: expected\.current, view: instance\.captureViewport\(\) \}/);
});

test('constraint rows and arrays use Host-compatible plain prototypes and enumerable data descriptors', async () => {
  const malformed = [];
  const extraArray = [rule()]; extraArray.extra = true; malformed.push(extraArray);
  const hiddenArray = [rule()]; Object.defineProperty(hiddenArray, 'extra', { value: true }); malformed.push(hiddenArray);
  const symbolArray = [rule()]; symbolArray[Symbol('extra')] = true; malformed.push(symbolArray);
  const hiddenIndex = [rule()]; Object.defineProperty(hiddenIndex, '0', { enumerable: false }); malformed.push(hiddenIndex);
  const accessorIndex = [rule()]; Object.defineProperty(accessorIndex, '0', { enumerable: true, get() { throw new Error('must not invoke index'); } }); malformed.push(accessorIndex);
  malformed.push(Object.setPrototypeOf([rule()], null));
  class Rules extends Array {} malformed.push(new Rules(rule()));
  const hiddenRow = rule(); Object.defineProperty(hiddenRow, 'content', { enumerable: false }); malformed.push([hiddenRow]);
  const extraHiddenRow = rule(); Object.defineProperty(extraHiddenRow, 'extra', { value: true }); malformed.push([extraHiddenRow]);
  const symbolRow = rule(); symbolRow[Symbol('extra')] = true; malformed.push([symbolRow]);
  malformed.push([Object.assign(Object.create({ custom: true }), rule())]);
  malformed.push([Object.assign(new Date(), rule())]);
  const w = fixture([rule()]);
  for (const rows of malformed) {
    assert.equal(f.validWritingConstraints(rows, true), false);
    const recovered = f.recoveryPayload(edit(w, w.settings.writingConstraints[0].id, 'content', '恢复新草稿'));
    recovered.settings.writingConstraints = rows;
    assert.equal(f.validRecovery(recovered, w.book.id), false);
  }
  const nullPrototypeRow = Object.assign(Object.create(null), rule());
  assert.equal(f.validWritingConstraints([nullPrototypeRow]), true);
  assert.doesNotThrow(() => mutateBook(w.book, { action: 'updateBook', patch: { writingConstraints: [nullPrototypeRow] } }));
  const invalidDraftRow = rule({ content: '新的正文保存前必须拒绝此隐藏属性' });
  Object.defineProperty(invalidDraftRow, 'extra', { value: true });
  const draft = { ...w, settings: { ...w.settings, writingConstraints: [invalidDraftRow] }, chapter: { ...w.chapter, body: '其他手动正文草稿' } };
  const h = saveHarness(draft);
  assert.equal(await h.save(), false);
  assert.equal(h.deps.error.message, 'constraintsInvalid');
  assert.deepEqual(h.operations, []);
});

test('pending constraints block model calls; navigation autosaves valid rules but guards incomplete rules', async () => {
  const w = fixture([rule()]), selection = f.capturePolishSnapshot(w, 0, 2);
  const draft = edit(w, w.settings.writingConstraints[0].id, 'content', '');
  assert.equal(f.polishIntentProblem(draft, selection), 'saveFirst');
  let guard = null, ran = false;
  const h = saveHarness(draft);
  const deps = { busyRef: { current: false }, autosaveComposing: { current: false }, loading: false, epoch: { current: 0 }, invalidateReviewReturn: () => {}, dirty: f.dirty, isDirty: f.isDirty,
    current: h.current, autosaveRef: h.deps.autosaveRef, autosaveRecoveryWorkspace: f.autosaveRecoveryWorkspace, setGuard: value => { guard = value; } };
  const transition = callback('          const transition =', '          const changeChapter =', 'transition', deps);
  await transition(() => { ran = true; }); assert.equal(ran, false); assert.equal(guard.scope, 'all');
  assert.deepEqual(h.operations, [], 'An incomplete constraint array is retained locally, not filtered or erased');
  const valid = edit(w, w.settings.writingConstraints[0].id, 'enabled', false), ready = saveHarness(valid);
  guard = null;
  const savedTransition = callback('          const transition =', '          const changeChapter =', 'transition', {
    ...deps, current: ready.current, autosaveRef: ready.deps.autosaveRef,
  });
  await savedTransition(() => { ran = true; });
  assert.equal(ran, true); assert.equal(guard, null); assert.equal(f.isDirty(ready.current.current), false);
  assert.equal(ready.current.current.book.writingConstraints[0].enabled, false);
  const generation = source.slice(source.indexOf('          const generate ='), source.indexOf('          const generate =') + 1900);
  assert(generation.indexOf('if (isDirty(active))') < generation.indexOf("call('generate'"));
  assert(source.includes("button(t('saveContinue'), async () => { const next = guard; if (await saveAll())"));
  assert(source.includes("else { commit(workspace(active.book, active.chapterId)); setConflict(null); }"));
});

test('the continuous Markdown surface keeps scoped controls and generation help', () => {
  assert(source.includes("case 'constraints': return renderConstraints()"));
  const render = source.slice(source.indexOf('          const renderConstraints ='), source.indexOf('          const renderSettings ='));
  assert.match(render, /h\(ConstraintsTextSurface, \{ key: bookId/);
  assert.match(render, /button\(t\(raw \? 'constraintsHideSource' : 'constraintsShowSource'\), toggleRaw/);
  assert.match(render, /setConfirm\(\{ title:/);
  assert.doesNotMatch(render, /changeConstraintBlock|saveAll|call\('/);
  for (const text of ['未完成的 Markdown 保留在本地', '每个任务使用启动时快照', '模型不保证语义上完全遵守', '固定硬性上下文预算内完整注入']) assert(source.includes(text), text);
});

test('all preexisting workspace/recoveryPayload and UTF16/review/model helpers remain byte frozen', () => {
  for (const [start, end, expected] of [
    ['    const cardFields =', '    function validRecovery(', '11a7db1f41b1c65f324fb5ce1c9fc2b4d770f3dccec8c8b1370c2b0f18d3c2c6'],
    ['    const textareaValue =', '    const en =', '8b05aafaa77dc626c68aa6812c80350c2cb9e33c9ecc5bcbceffab43456c8148'],
  ]) assert.equal(createHash('sha256').update((start === '    const cardFields =' ? legacyWorkspaceRegion(source) : source.slice(source.indexOf(start), source.indexOf(end)))).digest('hex'), expected);
});
