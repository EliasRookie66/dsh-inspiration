import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createBook, mutateBook, makeProposal, buildContext } from '../core.js';

// Execute only actual client pure helpers. The source-wiring/CSS tests below
// deliberately make no claim of browser rendering or interaction coverage.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
const f = new Function(helpers + '\nreturn {workspace,revisionContext,visibleWhitespace,generatedDisplayRecord,generatedReviewView,generatedPreviewDecision,generatedActionSnapshot,generatedActionProblem,revisionView,bulkRevisionSnapshot,bulkRevisionProblem,visibleReviewProblem};')();
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(mode = 'draft') {
  let book = mutateBook(createBook('界面契约'), { action: 'addChapter', title: '本章' });
  const chapterId = book.chapters[0].id;
  const body = '开头\r\n重复😀正文\r\n重复😀正文\r\n结尾';
  book = mutateBook(book, { action: 'updateChapter', chapterId, patch: { body, summary: '原摘要' } });
  const request = { mode, instruction: '保留细节', selection: null };
  const proposal = makeProposal(book, chapterId, request, mode === 'continue' ? '\r\n续写' : '新文字', buildContext(book, chapterId, request), mode === 'revise' ? { analysis: '逐处优化' } : {});
  book = mutateBook(book, { action: 'addProposal', proposal });
  return { w: f.workspace(book, chapterId), proposal, body };
}

test('newline insertion shows truthful source context without fabricating replaced text', () => {
  const body = '首段。\r\n第二段😀。\r\n末段。';
  const start = body.indexOf('第二');
  const hunk = { start, end: start, before: '', after: '\r\n' };
  const original = clone(hunk), context = f.revisionContext(body, hunk);
  assert.equal(context.focus, '');
  assert.equal(context.prefix + context.focus + context.suffix, body);
  assert(context.prefix.endsWith('\r\n'));
  assert(context.suffix.startsWith('第二段😀。'));
  assert.deepEqual(hunk, original, 'Context is view-only; accept algebra keeps zero-length before');
  assert.deepEqual(f.visibleWhitespace(hunk.after), { text: '↵\n', whitespaceOnly: true, newlines: 1, tabs: 0, spaces: 0 });
});

test('visible whitespace and genuine before remain distinct, exact immutable source strings', () => {
  assert.equal(f.visibleWhitespace(' \t\r\n  ').text, '·⇥↵\n··');
  assert.equal(f.visibleWhitespace('正文 空格\r\n保留').text, '正文 空格\r\n保留');
  const source = '前文\r\n实际原文😀\r\n后文', start = source.indexOf('实际');
  const item = { start, end: start + '实际原文😀'.length, before: '实际原文😀', after: '' };
  assert.equal(f.revisionContext(source, item).focus, item.before);
  assert.equal(f.revisionContext(source, { ...item, before: '伪造' }), null);
  const emoji = source.indexOf('😀');
  assert.equal(f.revisionContext(source, { start: emoji + 1, end: emoji + 1, before: '' }), null);
  const crlf = source.indexOf('\r\n');
  assert.equal(f.revisionContext(source, { start: crlf + 1, end: crlf + 1, before: '' }), null);
});

test('bounded context never splits UTF16 scalars or CRLF and stays exact', () => {
  const source = '😀'.repeat(900) + '\r\n正文\r\n' + '😀'.repeat(900), start = source.indexOf('正文');
  const result = f.revisionContext(source, { start, end: start, before: '' }, { maxChars: 7 });
  assert(result.prefix.length <= 7 && result.suffix.length <= 7);
  assert(!/[\uD800-\uDFFF]/u.test(result.prefix + result.suffix));
  assert(source.slice(0, start).endsWith(result.prefix));
  assert(source.slice(start).startsWith(result.suffix));
});

for (const mode of ['draft', 'continue', 'summary']) test(`${mode} inline preview is exact and only durable output owns decisions`, () => {
  const { w, proposal, body } = fixture(mode), unchanged = JSON.stringify(w);
  const view = f.generatedReviewView(w, proposal);
  assert(view.durable);
  assert.equal(view.source, body);
  assert.equal(view.preview, mode === 'continue' ? body + proposal.text : proposal.text);
  assert(f.generatedPreviewDecision(w, proposal, null).visible);
  const snapshot = f.generatedActionSnapshot(w, proposal);
  assert(Object.isFrozen(snapshot));
  assert.equal(f.generatedActionProblem(w, snapshot), '');
  const job = { bookId: w.book.id, chapterId: w.chapterId, id: 'new-job', mode, sourceRevision: proposal.sourceRevision, status: 'running', text: '部分输出' };
  assert.equal(f.generatedDisplayRecord(w, proposal, job), job);
  assert.equal(f.generatedActionSnapshot(w, job), null);
  assert.equal(f.generatedReviewView(w, job).durable, false);
  assert.equal(f.generatedDisplayRecord(w, proposal, { ...job, status: 'completed', proposalId: 'not-durable' }).id, job.id);
  for (const options of [{ recovery: {} }, { conflict: {} }]) {
    assert.equal(f.generatedPreviewDecision(w, proposal, null, options).visible, false);
    assert(f.generatedActionProblem(w, snapshot, options));
  }
  const dirty = { ...w, chapter: { ...w.chapter, body: body + '手写稿' } };
  assert.equal(f.generatedPreviewDecision(dirty, proposal, null).visible, false);
  assert.equal(f.generatedActionProblem(dirty, snapshot), 'saveFirst');
  const remote = clone(w); remote.book.chapters[0].summary += '远端变动';
  assert.equal(f.generatedActionProblem(remote, snapshot), 'confirmChanged');
  assert.equal(JSON.stringify(w), unchanged);
});

test('all mode generations suppress old controls and completed identity uses matching durable result', () => {
  const { w, proposal } = fixture();
  for (const mode of ['draft', 'continue', 'summary', 'polish', 'revise']) {
    const job = { bookId: w.book.id, chapterId: w.chapterId, id: 'new', mode, status: 'running', text: '' };
    assert.equal(f.generatedDisplayRecord(w, proposal, job), job);
    assert.equal(f.generatedDisplayRecord(w, proposal, { ...job, status: 'completed', proposalId: 'not-loaded' }).id, 'new');
  }
  const old = { ...proposal, id: 'old-result' }, next = { ...w, book: { ...w.book, proposals: [old, proposal] }, candidateId: old.id };
  const completed = { bookId: w.book.id, chapterId: w.chapterId, id: 'new', status: 'completed', proposalId: proposal.id };
  assert.equal(f.generatedDisplayRecord(next, old, completed), proposal);
  assert.equal(f.generatedDisplayRecord(next, old, completed, { recovery: {} }), old);
  assert.equal(f.generatedDisplayRecord({ ...next, candidate: '旧版未保存编辑' }, old, completed), old);
});

test('source wiring removes proposal section, keeps all inline modes and legacy draft resolution', () => {
  assert(!source.includes('renderCandidate'));
  assert(!source.includes("generate: '生成提案'"));
  assert(source.includes("toolbarButton('generate', t('generate'), generate"));
  assert(source.includes('generatedManuscript ? renderGeneratedPreview()'));
  const editor = source.slice(source.indexOf('const renderEditor ='), source.indexOf('const renderModelPicker ='));
  const results = source.slice(source.indexOf('const renderAI ='), source.indexOf('const renderConstraints ='));
  assert.doesNotMatch(editor, /t\('summary'\)|'chapter', 'summary'|renderGeneratedPreview\(\).*summary/);
  assert(results.includes("generatedVisible && displayRecord.mode === 'summary' && renderGeneratedPreview()"), 'Existing summary proposals still show their actual preview outside the manuscript editor');
  assert(results.indexOf('renderGeneratedPreview()') > results.indexOf("t('reviseRequirement')))),"), 'A folded task section must not hide a still-actionable result');
  assert(source.includes('generatedActionSnapshot(w, proposal)'));
  assert(source.includes("'aria-label': t('results'), value: proposal?.id || w.candidateId"), 'Chooser must identify the actually displayed durable outcome even before candidate selection catches up');
  const actions = source.slice(source.indexOf('const applyGenerated ='), source.indexOf('const applyRevisionHunk ='));
  assert.equal((actions.match(/generatedActionProblem\(current.current/g) || []).length, 2);
  for (const marker of ["discardScope('candidate')", "button(t('downloadLocal'), downloadLocal)", "action: 'updateProposal'", "className: 'mx-legacy-recovery mx-stack'"]) assert(source.includes(marker), marker);
  const revision = source.slice(source.indexOf('const renderRevisionPreview ='), source.indexOf('const renderEditor ='));
  assert(revision.includes('renderOriginalContext(proposal.sourceBody, item)'));
  assert(revision.includes('renderVisibleText(item.before)'));
  assert(!revision.includes("h('details'"), 'Original is directly visible below new text, not collapsed');
});

test('only draft/rewrite are selectable and their preview and generation send no selected range', async () => {
  const modesStart = source.indexOf('const writingTaskModes ='), modeKeysStart = source.indexOf('const modeKeys =', modesStart);
  const modes = new Function(source.slice(modesStart, modeKeysStart) + 'return writingTaskModes;')();
  assert.deepEqual(modes, ['draft', 'revise']);
  assert(source.includes('writingTaskModes.map(value =>'));
  const changeCode = /onChange: e => \{ if \(writingTaskModes\.includes\(e\.target\.value\)\) setMode\(e\.target\.value\); \}/.exec(source)?.[0];
  assert(changeCode);
  const changes = [], setMode = value => changes.push(value);
  const onChange = new Function('writingTaskModes', 'setMode', 'return ({ ' + changeCode + ' }).onChange;')(modes, setMode);
  for (const value of ['draft', 'summary', 'continue', 'polish', 'revise']) onChange({ target: { value } });
  assert.deepEqual(changes, ['draft', 'revise']);
  const actions = source.slice(source.indexOf('          const contextKey ='), source.indexOf('          const create ='));
  const build = new Function('env', 'with(env) {' + actions + '\nreturn {previewContext,generate};}');
  const current = { current: fixture().w };
  for (const mode of modes) {
    const requests = [], jobs = [], report = [], instruction = '保留人物关系';
    const env = { current, mode, instruction, busyRef: { current: false }, isDirty: () => false, alive: { current: true }, contextSequence: { current: 0 }, autosaveComposing: { current: false },
      selectionRef: { current: { start: 1, end: 3, text: '测试' } }, withBusy: action => action(),
      setContextBusy: () => {}, setContextError: error => { assert.equal(error, null); }, setContext: data => report.push(data),
      modelGenerationProblem: () => '', modelPrefsRef: { current: { settings: { revision: 2 } } }, catalogRef: {}, modelSaveRef: {},
      call: async (action, payload) => { requests.push({ action, payload }); return action === 'context' ? { prompt: 'book prompt' } : { jobId: 'test' }; },
      reviewRef: {}, invalidateReviewReturn: () => {}, chapterOf: w => w.book.chapters[0], rememberJob: job => jobs.push(job),
      setJob: () => {}, setPollError: () => {}, setNotice: () => {}, messageError: error => { throw error; },
    };
    const { previewContext, generate } = build(env);
    await previewContext(); await generate();
    assert.deepEqual(requests.map(({ action, payload }) => [action, payload.mode, payload.selection, payload.instruction]),
      [['context', mode, null, instruction], ['generate', mode, null, instruction]]);
    assert.equal(requests[1].payload.expectedRevision, current.current.book.revision);
    assert.equal(requests[1].payload.expectedModelRevision, 2);
    assert.equal(report[0].data.prompt, 'book prompt');
    assert.equal(jobs[0].mode, mode);
  }
});

test('CSS/static layout contracts: allocated normal-flow controls above editor, collapsible navigation and no hunk cards', () => {
  const rule = name => source.match(new RegExp('(?:^|\\})\\.' + name + '\\{([^}]+)\\}', 'm'))?.[1];
  assert(rule('mx-content-pane').includes('overflow:auto'));
  assert(rule('mx-grid').includes('grid-template-columns:minmax(0,1fr)'));
  assert(!source.includes('.mx-grid[data-chapters'));
  assert(rule('mx-writing-column').includes('overflow:auto'), 'A short allocated pane must scroll to its guaranteed-size editor instead of clipping it');
  assert(rule('mx-writing-partner').includes('position:static'));
  assert(!source.slice(source.indexOf('    const CSS ='), source.indexOf('    function Field(')).includes('position:sticky'));
  assert(rule('mx-utility-page').includes('min-width:0'));
  assert(!source.includes('mx-partner-advanced'));
  assert(source.includes("h('div', { ref: columnRef, className: 'mx-writing-column' }, renderAI(), renderEditor())"));
  assert(!source.includes("const renderAI = () => h('aside'"));
  for (const declaration of ['border:0', 'border-radius:0', 'padding:0']) assert(rule('mx-revision-hunk').includes(declaration));
  assert(!source.includes('max-height:65vh'));
  assert(!source.includes('mx-chapter-nav'), 'No persistent chapter sidebar');
  assert(source.includes("className: 'mx-topbar-group mx-topbar-chapter'"));
  assert(source.includes("rows: 2, maxLength: 60000"));
  assert(source.includes("pageButton('advanced', 'advanced')"));
  assert(source.includes("'aria-pressed': tab === value"));
  assert(source.includes("'aria-hidden': true, focusable: 'false'"));
});


test('approve-all captures the exact durable revision and rejects stale, dirty, recovery, busy or settled snapshots', () => {
  const { w, proposal } = fixture('revise');
  const snapshot = f.bulkRevisionSnapshot(w, proposal), before = JSON.stringify(w);
  assert(Object.isFrozen(snapshot));
  assert.equal(f.bulkRevisionProblem(w, snapshot), '');
  assert.equal(f.bulkRevisionSnapshot(w, { ...proposal, text: '伪造结果' }), null);
  for (const options of [{ recovery: {} }, { conflict: {} }, { busy: true }, { unavailable: true }]) assert(f.bulkRevisionProblem(w, snapshot, options));
  assert.equal(f.bulkRevisionProblem({ ...w, candidate: w.candidate + '旧版草稿' }, snapshot), 'saveFirst');
  const changed = clone(w); changed.book.chapters[0].summary += '变动';
  assert.equal(f.bulkRevisionProblem(changed, snapshot), 'confirmChanged');
  const settled = clone(w); settled.book.proposals[0].review.hunks.forEach(h => { h.state = 'rejected'; }); settled.book.proposals[0].state = 'rejected';
  const settledSnapshot = f.bulkRevisionSnapshot(settled, settled.book.proposals[0]);
  assert.equal(f.bulkRevisionProblem(settled, settledSnapshot), 'confirmChanged');
  assert.equal(JSON.stringify(w), before, 'Presentation and snapshots never approve a result');
  const callback = source.slice(source.indexOf('const applyRevisionAll ='), source.indexOf('const applyRevisionHunk ='));
  assert.equal((callback.match(/bulkRevisionProblem\(current.current/g) || []).length, 2);
  assert(callback.includes("action: 'acceptRevisionAll', proposalId: snapshot.proposalId"));
  assert(!callback.includes('forEach') && !callback.includes('books.map'));
  assert(source.includes("approveAll: '一键批准'"));
  assert(source.includes('disabled: !!bulkProblem || !bulkPreview'));
});


test('live review identity prevents old enabled actions after generation starts, source view or result switch', () => {
  const { w, proposal } = fixture(), snapshot = f.generatedActionSnapshot(w, proposal);
  const review = { bookId: w.book.id, chapterId: w.chapterId, proposalId: proposal.id, visible: true, blocked: false };
  assert.equal(f.visibleReviewProblem(snapshot, review), '');
  for (const value of [null, { ...review, visible: false }, { ...review, blocked: true }, { ...review, proposalId: 'new-result' }, { ...review, chapterId: 'other' }]) assert(f.visibleReviewProblem(snapshot, value));
  for (const action of ['applyGenerated', 'applyPolish', 'applyRevisionHunk', 'applyRevisionAll']) {
    const start = source.indexOf('const ' + action + ' ='), end = source.indexOf('\n          };', start);
    const body = source.slice(start, end);
    assert.equal((body.match(/visibleReviewProblem\(snapshot, reviewRef.current\)/g) || []).length, 2, action);
  }
  assert(source.includes('setOriginalReviewKey = value => { reviewRef.current = null;'));
  assert(source.includes('setOriginalPolishKey = value => { reviewRef.current = null;'));
  assert(source.includes("reviewRef.current = null;\n              data = await call('generate'"));
});


test('compact toolbar exposes failed/cancelled attempts and polling retry without opening advanced controls', () => {
  const start = source.indexOf('const renderWritingFeedback =');
  const compact = source.slice(start, source.indexOf('const renderWritingActions =', start));
  assert(compact.includes("['failed', 'cancelled'].includes(job.status)"));
  assert(compact.includes("role: terminal && job.status === 'failed' && !pollError ? 'alert' : 'status'"));
  assert(compact.includes("job.error ? ' · ' + String(job.error) : ''"));
  assert(compact.includes("t('previousResult')"), 'Earlier selected output is explicitly not output from the failed attempt');
  assert(compact.includes("pollError ? t('pollError')"));
  assert(compact.includes("toolbarButton('refresh', t('retry'), () => { setPollError(false); setPollVersion(v => v + 1); })"));
});
