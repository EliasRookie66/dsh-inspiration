import { legacyWorkspaceRegion } from './legacy-workspace-guard.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { createBook, mutateBook, buildContext, makeProposal } from '../core.js';

// Actual Client pure helpers/controller and actual extracted App callbacks only.
// No renderer, fake React, DOM mock, paid model call, live profile or live book.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
const f = new Function(pure + '\nreturn {workspace,cardFields,blankCard,dirty,isDirty,chapterFields,patchOf,applyTextareaEdit,editWritingConstraints,validWritingConstraints,validRecovery,recoveryPayload,restoredWorkspace,conflictingFields,mergeWorkspace,autosaveStep,autosaveOperationApplied,mergeAutosaveAck,autosaveRecoveryWorkspace,autosaveRecoveryPayload,validAutosaveRecovery,restoredAutosaveWorkspace,autosaveCanSave,createAutosaveController};')();
const clone = value => JSON.parse(JSON.stringify(value));
const rule = (patch = {}) => ({ id: randomUUID(), category: '神态与自定义', content: '仅为测试虚构条件', enabled: true, ...patch });
function fixture() {
  let book = mutateBook(createBook('自动保存虚构测试'), { action: 'addChapter', title: '第一章' });
  book = mutateBook(book, { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: 'original\r\n😀', summary: '手动旧摘要' } });
  return f.workspace(book, book.chapters[0].id);
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fakeClock() {
  let time = 0, id = 0; const timers = new Map();
  return { setTimer(fn, delay) { timers.set(++id, { at: time + delay, fn }); return id; }, clearTimer(key) { timers.delete(key); },
    tick(ms) { time += ms; for (const [key, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= time && timers.delete(key)) timer.fn(); },
    get size() { return timers.size; } };
}
function harness(initial = fixture()) {
  const clock = fakeClock(), requests = [], failures = [], acks = [], journals = [];
  let w = initial, server = clone(initial.book), epoch = 1, paused = false, delay = null, failure = null, active = 0, maximum = 0;
  let controller;
  controller = f.createAutosaveController({
    getWorkspace: () => w, getEpoch: () => epoch, isPaused: manual => paused && !manual,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    started: () => journals.push(f.autosaveRecoveryPayload(w, controller)),
    send: async request => {
      requests.push(clone(request)); active++; maximum = Math.max(maximum, active);
      const waiting = delay; delay = null;
      try {
        if (failure) { const error = failure; failure = null; throw error; }
        if (request.expectedRevision !== server.revision) throw Object.assign(new Error('saved revision changed'), { code: 'CONFLICT' });
        server = mutateBook(server, request.operation); const response = clone(server);
        if (waiting) await waiting.promise;
        return response;
      } finally { active--; }
    },
    apply: next => { w = next; acks.push(next); }, fail: error => { failures.push(error); journals.push(f.autosaveRecoveryPayload(w, controller)); },
  });
  return { controller, clock, requests, failures, acks, journals,
    get w() { return w; }, set w(value) { w = value; }, get server() { return server; }, set server(value) { server = value; },
    get maximum() { return maximum; }, set paused(value) { paused = value; }, bumpEpoch() { epoch++; },
    hold() { delay = deferred(); return delay; }, failNext(error = new Error('network unavailable')) { failure = error; },
    edit(group, field, value) { w = { ...w, [group]: { ...w[group], [field]: value } }; controller.schedule(); },
    async tick(ms = 1000) { clock.tick(ms); await controller.wait(); },
  };
}
function callback(start, end, name, deps) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin);
  assert(begin >= 0 && finish > begin);
  return new Function('deps', `const {${Object.keys(deps).join(',')}}=deps;\n${source.slice(begin, finish)}\nreturn ${name};`)(deps);
}

test('1000ms debounce persists manual text once, without a model, proposal or success-toast callback', async () => {
  const h = harness(); h.edit('chapter', 'body', 'A');
  await h.tick(700); assert.equal(h.requests.length, 0);
  h.edit('chapter', 'body', 'AB'); await h.tick(999); assert.equal(h.requests.length, 0);
  await h.tick(1);
  assert.equal(h.requests.length, 1); assert.equal(h.server.chapters[0].body, 'AB');
  assert.equal(f.isDirty(h.w), false); assert.equal(h.maximum, 1);
  assert.deepEqual(h.requests.map(r => r.operation.action), ['updateChapter']);
});

test('blur flush drains independently valid groups and serializes their CAS revisions', async () => {
  const h = harness(); h.edit('chapter', 'title', ''); h.edit('chapter', 'body', '有效正文');
  h.edit('settings', 'title', ''); h.edit('settings', 'premise', '有效前提'); h.edit('settings', 'contextBudget', '');
  h.edit('settings', 'writingConstraints', [rule({ content: '' })]);
  await h.controller.flush();
  assert.deepEqual(h.requests.map(r => r.operation.action), ['updateChapter', 'updateBook']);
  assert.deepEqual(h.requests[0].operation.patch, { body: '有效正文' });
  assert.deepEqual(h.requests[1].operation.patch, { premise: '有效前提' });
  assert.equal(h.requests[1].expectedRevision, h.requests[0].expectedRevision + 1);
  assert.equal(h.w.chapter.title, ''); assert.equal(h.w.settings.title, '');
  assert.equal(h.w.settings.writingConstraints[0].content, ''); assert(f.isDirty(h.w));
  assert.equal(h.server.writingConstraints.length, 0); assert.equal(h.failures.length, 0);
});

for (const latest of ['newer text😀', 'original\r\n😀']) test(`in-flight ACK preserves latest edit including undo-to-old-baseline: ${JSON.stringify(latest)}`, async () => {
  const h = harness(), held = h.hold(); h.edit('chapter', 'body', 'A');
  const saving = h.controller.flush();
  assert.equal(h.controller.running, true); assert.equal(h.server.chapters[0].body, 'A');
  h.edit('chapter', 'body', latest);
  held.resolve(); await saving;
  assert.equal(h.w.chapter.body, latest); assert.equal(h.w.baseChapter.body, 'A'); assert.equal(f.dirty(h.w).chapter, true);
  await h.tick();
  assert.equal(h.server.chapters[0].body, latest); assert.equal(f.dirty(h.w).chapter, false);
  assert.equal(h.maximum, 1); assert.equal(h.requests.length, 2);
});

test('settings ACK preserves an incomplete newer atomic rule array and does not share baseline rows', async () => {
  const h = harness(), held = h.hold(); h.edit('settings', 'writingConstraints', [rule()]);
  const saving = h.controller.flush(); const rows = h.w.settings.writingConstraints;
  h.edit('settings', 'writingConstraints', [{ ...rows[0], content: '' }]);
  held.resolve(); await saving; await h.tick();
  assert.equal(h.requests.length, 1); assert.equal(h.w.settings.writingConstraints[0].content, '');
  assert.notEqual(h.w.settings.writingConstraints, h.w.baseSettings.writingConstraints);
  assert.notEqual(h.w.settings.writingConstraints[0], h.w.baseSettings.writingConstraints[0]);
  assert.equal(h.w.baseSettings.writingConstraints[0].content, '仅为测试虚构条件');
});

test('manual summary autosaves; generated summary and legacy candidate edits never auto-accept or save', async () => {
  const h = harness(); const request = { mode: 'summary' };
  const proposal = makeProposal(h.server, h.w.chapterId, request, 'AI 摘要待作者确认', buildContext(h.server, h.w.chapterId, request));
  h.server = mutateBook(h.server, { action: 'addProposal', proposal }); h.w = f.workspace(h.server, h.w.chapterId);
  h.edit('chapter', 'summary', '作者手动填写摘要'); h.w = { ...h.w, candidate: '尚未明确保存的候选编辑' };
  await h.controller.flush();
  assert.deepEqual(h.requests.map(r => r.operation.action), ['updateChapter']);
  assert.equal(h.server.chapters[0].summary, '作者手动填写摘要');
  assert.equal(h.server.proposals[0].text, 'AI 摘要待作者确认'); assert.equal(h.server.proposals[0].state, 'ready');
  assert.equal(h.w.candidate, '尚未明确保存的候选编辑'); assert.equal(f.dirty(h.w).candidate, true);
});

test('pending undo is journaled before ACK and restores against saved A without optimistic canonical mutation', async () => {
  const h = harness(), held = h.hold(); const original = h.w.chapter.body;
  h.edit('chapter', 'body', 'A'); const saving = h.controller.flush(); h.edit('chapter', 'body', original);
  assert.equal(f.isDirty(h.w), false); assert.equal(h.w.book.chapters[0].body, original);
  const journal = f.autosaveRecoveryPayload(h.w, h.controller);
  assert.equal(journal.dirty.chapter, true); assert.equal(journal.chapter.body, original); assert.equal(journal.baseChapter.body, 'A');
  assert.equal(f.validAutosaveRecovery(clone(journal), h.w.book.id), true);
  const reopened = f.restoredAutosaveWorkspace(f.workspace(clone(h.server), h.w.chapterId), clone(journal));
  assert.equal(reopened.chapter.body, original); assert.equal(reopened.book.chapters[0].body, 'A');
  assert.deepEqual(f.conflictingFields(reopened, reopened.book), []);
  const resumed = harness(reopened); await resumed.controller.flush(); assert.equal(resumed.server.chapters[0].body, original);
  held.resolve(); await saving;
});

test('network failure retains pending undo journal, enables explicit retry and never retries on more edits', async () => {
  const h = harness(), held = h.hold(), original = h.w.chapter.body;
  h.edit('chapter', 'body', 'A'); const saving = h.controller.flush(); h.edit('chapter', 'body', original);
  held.reject(new Error('ACK connection lost')); await saving;
  assert.equal(h.controller.failed, true); assert(h.controller.pendingSnapshot);
  assert.equal(f.autosaveCanSave(h.w, h.controller), true); assert.equal(f.isDirty(h.w), false);
  assert.equal(f.autosaveRecoveryPayload(h.w, h.controller).chapter.body, original);
  h.controller.schedule(); await h.tick(100000); assert.equal(h.requests.length, 1); assert.equal(h.failures.length, 1);
  assert.equal(f.autosaveRecoveryPayload(h.w, h.controller).dirty.chapter, true);
});

test('CAS conflict latches once; user edits and blur do not create a retry loop', async () => {
  const h = harness(); h.edit('chapter', 'body', '作者本地稿');
  h.server = mutateBook(h.server, { action: 'updateChapter', chapterId: h.w.chapterId, patch: { body: '其他作者远端稿' } });
  await h.controller.flush(); assert.equal(h.controller.failed, true);
  h.edit('chapter', 'body', '更多本地稿'); await h.tick(10000); await h.controller.flush();
  assert.equal(h.requests.length, 1); assert.equal(h.failures.length, 1); assert.equal(h.w.chapter.body, '更多本地稿');
});

test('new-card creation has one stable UUID and binds its ACK without closing editor or losing newer typing', async () => {
  const h = harness(), blank = f.blankCard(); h.w = { ...h.w, card: blank, baseCard: blank };
  h.edit('card', 'title', 'A'); const held = h.hold(), saving = h.controller.flush();
  const first = h.requests[0]; assert.equal(first.operation.action, 'createCard'); assert.match(first.operation.card.id, /^[0-9a-f-]{36}$/i);
  const id = first.operation.card.id, journal = f.autosaveRecoveryPayload(h.w, h.controller);
  assert.equal(journal.pendingCard.id, id); assert.equal(f.validAutosaveRecovery(clone(journal), h.w.book.id), true);
  h.edit('card', 'title', '新的标题'); h.edit('card', 'content', '新内容😀');
  held.resolve(); await saving;
  assert.equal(h.w.card.id, id); assert.equal(h.w.card.title, '新的标题'); assert.equal(h.w.baseCard.title, 'A');
  await h.tick(); assert.equal(h.server.cards.length, 1); assert.equal(h.server.cards[0].content, '新内容😀');
  assert.deepEqual(h.requests.map(r => r.operation.action), ['createCard', 'saveCard']);
  assert.equal(h.requests[1].operation.card.id, id); assert.equal(h.w.card.id, id);
});

test('new-card ACK preserves a revert to the exact blank template, including transient empty title', async () => {
  const h = harness(), blank = f.blankCard(); h.w = { ...h.w, card: blank, baseCard: blank };
  h.edit('card', 'title', 'sent title'); const held = h.hold(), saving = h.controller.flush();
  h.w = { ...h.w, card: { ...blank } }; h.controller.schedule();
  assert.equal(f.dirty(h.w).card, false);
  const journal = f.autosaveRecoveryPayload(h.w, h.controller);
  assert.equal(journal.dirty.card, true); assert.equal(journal.card.title, ''); assert.equal(journal.baseCard.title, 'sent title');
  held.resolve(); await saving; await h.tick();
  assert.equal(h.w.card.title, ''); assert.equal(h.w.card.id, h.server.cards[0].id);
  assert.equal(h.requests.length, 1); assert.equal(h.w.baseCard.title, 'sent title');
});

test('new-card ACK lost across restart rebinds only exact pending UUID, never content guesses or duplicate creation', async () => {
  const h = harness(), blank = f.blankCard(); h.w = { ...h.w, card: blank, baseCard: blank };
  h.edit('card', 'title', 'same-looking card'); const held = h.hold(), saving = h.controller.flush();
  h.edit('card', 'content', '创建期间作者的新稿');
  const journal = clone(f.autosaveRecoveryPayload(h.w, h.controller)); const id = journal.pendingCard.id;
  const other = { ...journal.pendingCard.card, id: randomUUID() };
  h.server = mutateBook(h.server, { action: 'createCard', card: other });
  const recovered = f.restoredAutosaveWorkspace(f.workspace(h.server, h.w.chapterId), journal);
  assert.equal(recovered.card.id, id); assert.equal(recovered.card.content, '创建期间作者的新稿');
  const resumed = harness(recovered); await resumed.controller.flush();
  assert.equal(resumed.server.cards.length, 2); assert.equal(resumed.requests[0].operation.action, 'saveCard');
  assert.equal(resumed.requests[0].operation.card.id, id);
  const changed = mutateBook(h.server, { action: 'saveCard', card: { ...h.server.cards.find(c => c.id === id), content: '其他作者稍后更改' } });
  const conflicting = f.restoredAutosaveWorkspace(f.workspace(changed, h.w.chapterId), journal);
  assert.deepEqual(f.conflictingFields(conflicting, changed), ['card']);
  h.controller.dispose(); held.resolve(); await saving;
});

test('ACK-lost new card with no unsaved tail adopts later exact-ID server edits instead of stale sent text', async () => {
  const h = harness(), blank = f.blankCard(); h.w = { ...h.w, card: blank, baseCard: blank };
  h.edit('card', 'title', '已发送卡片'); const held = h.hold(), saving = h.controller.flush();
  const journal = clone(f.autosaveRecoveryPayload(h.w, h.controller)), id = journal.pendingCard.id;
  const saved = h.server.cards.find(card => card.id === id);
  const remote = mutateBook(h.server, { action: 'saveCard', card: { ...saved, content: '创建后另一处明确保存的内容' } });
  const recovered = f.restoredAutosaveWorkspace(f.workspace(remote, h.w.chapterId), journal);
  assert.equal(recovered.card.id, id); assert.equal(recovered.card.content, '创建后另一处明确保存的内容');
  assert.equal(f.dirty(recovered).card, false); assert.deepEqual(f.conflictingFields(recovered, remote), []);
  const resumed = harness(recovered); await resumed.controller.flush(); assert.equal(resumed.requests.length, 0);
  h.controller.dispose(); held.resolve(); await saving;
});

test('uncommitted new-card journal retries the same UUID after explicit recovery', async () => {
  const h = harness(), blank = f.blankCard(); h.w = { ...h.w, card: blank, baseCard: blank };
  h.edit('card', 'title', '离线新卡'); h.failNext(); await h.controller.flush();
  const journal = clone(f.autosaveRecoveryPayload(h.w, h.controller));
  const recovered = f.restoredAutosaveWorkspace(f.workspace(h.server, h.w.chapterId), journal);
  const resumed = harness(recovered); resumed.controller.restorePendingCard(journal.pendingCard, recovered.baseCard);
  await resumed.controller.flush(); assert.equal(resumed.server.cards.length, 1);
  assert.equal(resumed.server.cards[0].id, journal.pendingCard.id);
});

for (const tag of ['', '   ', ' '.repeat(101) + 'a', '\ud800']) test(`pending-card recovery rejects raw invalid sent tags before any normalization: ${JSON.stringify(tag)}`, async () => {
  const h = harness(), blank = f.blankCard(); h.w = { ...h.w, card: blank, baseCard: blank };
  h.edit('card', 'title', '标签元数据校验'); h.failNext(); await h.controller.flush();
  const journal = clone(f.autosaveRecoveryPayload(h.w, h.controller));
  journal.pendingCard.card.tags = [tag];
  assert.equal(f.validAutosaveRecovery(journal, h.w.book.id), false);
  assert.throws(() => mutateBook(h.server, { action: 'createCard', card: journal.pendingCard.card }));
});

test('stale epoch, cancel and dispose never retarget ACK or overlap a still-live HTTP write', async () => {
  const h = harness(), held = h.hold(); h.edit('chapter', 'body', 'sent old book'); const saving = h.controller.flush();
  h.controller.cancel(); h.bumpEpoch(); const next = fixture(); h.w = next;
  h.edit('chapter', 'body', 'new-book local'); const waiting = h.controller.flush();
  assert.equal(h.requests.length, 1); assert.equal(h.controller.running, true);
  held.resolve(); await saving; await waiting; assert.equal(h.acks.length, 0); assert.equal(h.w.book.id, next.book.id);
  assert.equal(h.w.chapter.body, 'new-book local'); assert.equal(h.maximum, 1);
  h.controller.dispose(); h.controller.schedule(); h.clock.tick(100000); assert.equal(h.requests.length, 1);
});

test('paused IME/modal lane does not write; only explicit manual flag can ignore user-busy/modal policy', async () => {
  const h = harness(); h.paused = true; h.edit('chapter', 'body', '输入法中'); await h.tick(); await h.controller.flush();
  assert.equal(h.requests.length, 0);
  await h.controller.flush({ manual: true }); assert.equal(h.requests.length, 1);
  const permanentlyPaused = f.createAutosaveController({ getWorkspace: () => h.w, getEpoch: () => 1, isPaused: () => true,
    send: () => assert.fail('IME/recovery/availability must not be bypassed'), apply: () => {}, fail: () => {} });
  await permanentlyPaused.flush({ manual: true, retry: true }); permanentlyPaused.dispose();
});

test('actual manual edit callback stays unlocked during autosave and schedules only manual field edits', () => {
  const initial = fixture(), current = { current: initial }; let scheduled = 0;
  const change = callback('          const changeField =', '          const changeWritingConstraint =', 'changeField', {
    current, busyRef: { current: false }, commit: next => { current.current = next; }, applyTextareaEdit: f.applyTextareaEdit,
    resetSelection: () => {}, setNotice: () => {}, autosaveRef: { current: { running: true, schedule: () => { scheduled++; } } },
  });
  change('chapter', 'body', '作者继续编辑'); assert.equal(current.current.chapter.body, '作者继续编辑'); assert.equal(scheduled, 1);
  current.current = { ...current.current, candidate: 'legacy draft' };
  // Candidate is not routed through generic group fields in App; controller likewise has no candidate operation.
  assert(!['updateProposal', 'acceptProposal', 'acceptRevisionAll'].includes(f.autosaveStep(current.current)?.operation.action));
});

test('source wiring omits the header save panel but retains error recovery, IME/blur, poll deferral and immediate cancel', () => {
  const header = source.slice(source.indexOf("          const renderTopbar ="), source.indexOf("          return h('main'"));
  for (const forbidden of ["t('autosaveHint')", "button(t('saveNow')", "button(t('discard')", 'mx-save-controls']) assert(!header.includes(forbidden));
  const errors = source.slice(source.indexOf("          error &&"), source.indexOf("          h('div', { ref: contentRef"));
  assert(errors.includes("button(t('autosaveRetry'), saveAll"));
  assert(!header.includes('w && anyDirty')); assert(!header.includes("t('unsaved')")); assert(!header.includes("status("));
  assert(source.includes('onCompositionStartCapture:')); assert(source.includes('onCompositionEndCapture:'));
  assert(source.includes("onBlurCapture: e => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) void autosaveRef.current.flush(); }"));
  assert(source.includes('if (busyRef.current || autosaveRef.current?.running) { queueLatest(book); return; }'));
  assert(source.includes('if (busyRef.current || autosaveRef.current?.running) queueLatest(latest);'));
  assert.equal((source.match(/rememberJob\(result\); setPollVersion\(v => v \+ 1\); } }, false\)/g) || []).length, 1, 'One immediate cancel path serves both toolbar states');
  assert(source.includes('已自动保存的内容不会回滚')); assert(source.includes('onCompositionStart: () => { composing.current = true;'));
  const autoSource = source.slice(source.indexOf('    function autosaveStep('), source.indexOf('    // Native textarea values'));
  assert(!autoSource.includes("action: 'accept")); assert(!autoSource.includes("call('generate'")); assert(!autoSource.includes('setNotice('));
});

test('critical preexisting workspace and source/review/model helper regions remain byte-frozen', () => {
  for (const [start, end, hash] of [
    ['    const cardFields =', '    function validRecovery(', '11a7db1f41b1c65f324fb5ce1c9fc2b4d770f3dccec8c8b1370c2b0f18d3c2c6'],
    ['    const textareaValue =', '    const en =', '8b05aafaa77dc626c68aa6812c80350c2cb9e33c9ecc5bcbceffab43456c8148'],
  ]) assert.equal(createHash('sha256').update((start === '    const cardFields =' ? legacyWorkspaceRegion(source) : source.slice(source.indexOf(start), source.indexOf(end)))).digest('hex'), hash);
});
