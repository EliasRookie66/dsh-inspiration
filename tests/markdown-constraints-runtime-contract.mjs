// Independent contract: exact production Markdown helpers/App closures -> admitted
// HTTP -> production service -> installed Cordis/JsonStorageBackend, close/reopen.
// State/storage/clock/admission are fixtures, NOT a React renderer or browser DOM.
// No live profile, author manuscripts, model session or paid/network adapter.
import assert from 'node:assert/strict';
import { transaction } from './continuous-edit-fixture.mjs';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
assert(process.env.DSH_INSTALL_DIR, 'Use installed Electron-as-Node');
const entries = new Map(['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-session'].map(name => [name, pathToFileURL(require.resolve(name, { paths: [process.env.DSH_INSTALL_DIR] })).href]));
registerHooks({ resolve(name, context, next) { return entries.has(name) ? { url: entries.get(name), shortCircuit: true } : next(name, context); } });
const { Context } = await import('@deepseek-ai/cordis');
const { LlmRuntime, LlmAdapter } = await import('@deepseek-ai/dsh-llm');
const { SessionStore } = await import('@deepseek-ai/dsh-session');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const { apply } = await import('../index.js');
const { NovelStore } = await import('../service.js');
const { createBook, mutateBook, buildContext } = await import('../core.js');
let source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const replaceOnce = (from, to) => { assert.equal(source.split(from).length, 2, 'Unique production mutant anchor'); source = source.replace(from, to); };
// Mutants edit the LOADED production implementation, never the expected results.
const mutants = {
  'stale-rebase-source': () => replaceOnce('baseText: rebase ? serializeConstraintsMarkdown(next.writingConstraints) : w.constraintsEditor.baseText', 'baseText: w.constraintsEditor.baseText'),
  'drop-disabled-rules': () => replaceOnce('function serializeConstraintsMarkdown(rows = []) {', 'function serializeConstraintsMarkdown(rows = []) { rows = rows.filter(row => row.enabled);'),
  'regenerate-rule-ids': () => replaceOnce('let id = previous?.id, generated = false;', 'let id, generated = false;'),
  'allow-add-id-reuse': () => replaceOnce(' ||\n            previousRows.some(row => row.id.toLowerCase() === id.toLowerCase())', ''),
  'allow-fresh-id-reuse': () => replaceOnce('generated && (previousIds.has(key) || used.has(key))', 'generated && previousIds.has(key)'),
  'category-heading-steals-id': () => {
    replaceOnce('const stableBind = (newIndex, oldIndex) => {', 'const stableBind = () => {}, ignoredStableBind = (newIndex, oldIndex) => {');
    replaceOnce('if (oldMembers && newMembers) {', 'if (false) {');
  },
  'drop-interior-group-binding': () => replaceOnce('const oldGroups = collectGroups(old.spans, previousText), newGroups = collectGroups(records, text);', 'const oldGroups = [], newGroups = [];'),
  'steal-paired-duplicates': () => replaceOnce('if (newMembers?.length === oldMembers.length)', 'if (oldMembers.length === 1 && newMembers?.length === 1)'),
  'canonicalize-structural-source': () => replaceOnce('const text = preserved ?? serializeConstraintsMarkdown(rows);', 'const text = serializeConstraintsMarkdown(rows);'),
  'icons-clobber-invalid': () => replaceOnce('w.constraintsEditor?.error && w.constraintsEditor.text !== w.constraintsEditor.parsedText', 'false'),
  'bad-preview-url': () => replaceOnce('return /^(?:https?:\\/\\/|mailto:)/i.test(url) ? url : null;', 'return url;'),
  'save-incomplete': () => replaceOnce('function autosaveStep(w) {', "function autosaveStep(w) { if (w?.constraintsEditor?.error) w = {...w, constraintsEditor: {...w.constraintsEditor, error: ''}};"),
  'drop-recovery-raw': () => replaceOnce('function recoveryPayload(w) {', 'function recoveryPayload(w) { if (w?.constraintsEditor) w = {...w, constraintsEditor: constraintsEditorState(w.settings.writingConstraints)};'),
  'drop-newer-raw-ack': () => replaceOnce('function mergeAutosaveAck(local, snapshot, book, step) {', 'function mergeAutosaveAck(local, snapshot, book, step) { if (local?.constraintsEditor) local = {...local, constraintsEditor: {...snapshot.constraintsEditor}};'),
  'accept-mismatched-journal': () => replaceOnce('function validRecovery(r, bookId) {', 'function validRecovery(r, bookId) { if (r?.constraintsEditor) return true;'),
  'drop-newer-edit': () => replaceOnce('fields[key] = local[group][key];', 'fields[key] = server[key];'),
  'retry-after-error': () => replaceOnce('schedule() { if (disposed || halted) return; clear(); due = false;', 'schedule() { if (disposed) return; halted = false; clear(); due = false;'),
  'drop-range-anchors': () => replaceOnce('if (sourceAnchors || sourceChanges) {', 'if (false) {'),
  'drop-history-identities': () => replaceOnce("const saved = (update.origin === 'undo' || update.origin === 'redo') && history.get(update.version);", 'const saved = null;'),
  'drop-invalid-anchors': () => replaceOnce('editor.error && editor.anchoredStarts ? remapConstraintStarts(editor.anchoredStarts, update.changes) : null', 'null'),
  'navigate-mid-composition-after-ack': () => replaceOnce('busyRef.current || autosaveComposing.current || !stillRequested()) return;\n            invalidateReviewReturn();', 'busyRef.current || !stillRequested()) return;\n            invalidateReviewReturn();'),
  'limit-undo-using-synthesized-eol': () => replaceOnce('const source = saved ? textareaValue(active.constraintsEditor.text) : active.constraintsEditor.text;', 'const source = active.constraintsEditor.text;'),
  'drop-durable-anchors': () => replaceOnce('next.constraintsEditor.anchoredStarts = anchors;', 'void anchors;'),
  'leave-clean-undo-journal': () => replaceOnce('if (journal?.constraintsEditor?.text === active.constraintsEditor.text) {', 'if (false) {'),
  'accept-stale-before': () => replaceOnce('textareaValue(source) !== update.before || ', ''),
  'accept-stale-history': () => replaceOnce('if (previous && !sameConstraintsDraft(previous, constraintsHistorySnapshot(active))) return false;', ''),
  'restore-invalid-preview': () => replaceOnce('if (next.constraintsEditor?.error) {', 'if (false) {'),
  'save-empty-rule-starter': () => replaceOnce('exactEol, sourceAnchors, rejectPlaceholders: true', 'exactEol, sourceAnchors, rejectPlaceholders: false'),
  'inherit-removed-dash-exemption': () => replaceOnce("if (unfinished.size) return bad('constraintsRuleStarter');\n        const oldPrefix", "if (unfinished.size && !previousRows.some(row => row.content.trim() === '-')) return bad('constraintsRuleStarter');\n        const oldPrefix"),
  'start-disabled-rule': () => replaceOnce("const starter = '- [x] - ';", "const starter = '- [ ] - ';"),
  'recycle-deleted-dash-id': () => replaceOnce("if (rejectPlaceholders && previous?.content.trim() === '-') used.add(previous.id.toLowerCase());", ''),
};
if (process.env.DSH_MARKDOWN_MUTANT) { assert(mutants[process.env.DSH_MARKDOWN_MUTANT]); mutants[process.env.DSH_MARKDOWN_MUTANT](); }
const slice = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert(a >= 0 && b > a, 'Exact production source boundary: ' + start); return source.slice(a, b); };
const helperNames = ['equal','workspace','dirty','isDirty','blankCard','cardFields','editWritingConstraints','autosaveStep','mergeAutosaveAck','createAutosaveController','recoveryPayload','restoredWorkspace','validRecovery','conflictingFields','mergeWorkspace','constraintsPreviewReady','textareaValue','applyTextareaEdit','autosaveRecoveryWorkspace','missingChapterDraft','autosaveRecoveryPayload','validAutosaveRecovery','restoredAutosaveWorkspace','applyConstraintsChanges','applyConstraintsInput','sameConstraintsDraft','constraintsHistorySnapshot','constraintsHistoryTarget','autosaveOperationApplied','autosaveCanSave','validWritingConstraints','bookIsAvailable','serializeConstraintsMarkdown','parseConstraintsMarkdown','editConstraintsMarkdown','constraintVisualTargets','editConstraintVisualBlock','constraintsEditorDirty','safeMarkdownUrl','markdownBlocks','markdownInline','constraintsDocumentKey'];
const f = new Function(slice('    const equal =', '    const en =') + '\nreturn {' + helperNames.join(',') + '};')();
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 12000); })]); } finally { clearTimeout(timer); } }
function clock() {
  let now = 0, serial = 0; const timers = new Map();
  return { setTimer(fn, delay) { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id; }, clearTimer(id) { timers.delete(id); },
    advance(ms) { const end = now + ms; let count = 0; while (true) { const next = [...timers].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0]; if (!next) break; assert(++count < 100, 'No retry loop'); now = next[1].at; timers.delete(next[0]); next[1].fn(); } now = end; }, get pending() { return timers.size; } };
}
const root = await mkdtemp(join(tmpdir(), 'inspiration-markdown-contract-'));
const allUis = [], releases = [], savedBooks = new Map(), requests = [];
let active, responseLossGate = null, modelCalls = 0, agentCreates = 0, preferenceWrites = 0, jobWrites = 0;
class NoModel extends LlmAdapter {
  listModels() { return [{ id: 'never-call', name: 'Forbidden Markdown model', capabilities: [] }]; }
  async *stream() { modelCalls++; throw new Error('No model calls in Markdown author editing'); }
}
async function activate(seed) {
  const owner = new Context(), disk = new JsonStorageBackend(root), llm = new LlmRuntime(owner), sessions = new SessionStore(owner);
  llm.registerAdapter(['markdown-tripwire'], new NoModel());
  const backend = { kv: { async open(spec) { const unit = await disk.kv.open(spec); return { loadAll: () => unit.loadAll(), close: () => unit.close(), deleteRecord: (table,key) => unit.deleteRecord(table,key), async putRecord(table,key,value) { await unit.putRecord(table,key,value); if (table === 'jobs') jobWrites++; if (table === 'books' && value.chapters) savedBooks.set(key, structuredClone(value)); } }; } } };
  if (seed) { const store = await new NovelStore(backend).init(); await store.insert(seed); await store.close(); }
  let handler; const peer = { id: 'isolated-markdown-author', principal: { kind: 'owner' } };
  const server = createServer((req,res) => {
    if (req.headers['x-fixture-fault'] === 'aftercommit') {
      const gate = responseLossGate; responseLossGate = null; assert(gate);
      res.end = function(body) { const receipt = JSON.parse(String(body)); assert.equal(receipt.ok, true); gate.entered.resolve(receipt.data); void gate.release.promise.then(() => req.socket.destroy()); return res; };
    }
    if (handler) handler(req,res); else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  active = { owner,disk,sessions,server,origin };
  await apply({ effect: fn => owner.effect(fn), storage: { backend: { get: () => backend } }, llm,sessions,
    agentDefaultModel: { currentSelection: () => ({ provider: 'markdown-tripwire', model: 'never-call' }), saveSelection() { preferenceWrites++; throw new Error('No preference writes'); } },
    agentLoop: { async createAgent() { agentCreates++; throw new Error('No author generation'); } },
    connection: { browserPeer: peer, admit: req => req.headers.cookie === 'markdown-fixture=1' ? { peer } : { rejection: 401 } },
    webServer: { getOrigin: () => origin, register(route) { assert.equal(handler,undefined); handler = route.handler; return () => { handler = undefined; }; } }, tools: { register() {} },
  });
}
async function deactivate() { if (!active) return; const old = active; active = undefined; await old.owner.fiber.dispose(); old.server.closeAllConnections(); await new Promise(resolve => old.server.close(resolve)); await old.disk.close(); }
async function post(action,args={},fault) {
  requests.push({ action,...structuredClone(args) }); let response;
  try { response = await fetch(active.origin + '/api/ycx-inspiration', { method: 'POST', headers: { Origin: active.origin, Cookie: 'markdown-fixture=1', 'Content-Type': 'application/json', 'X-Inspiration-Request': '1', ...(fault ? { 'X-Fixture-Fault': fault } : {}) }, body: JSON.stringify({ action,...args }) }); }
  catch(cause) { throw Object.assign(new Error('Network disconnected'), { code: 'NETWORK',cause }); }
  const payload = await response.json(); if (!response.ok || !payload.ok) throw Object.assign(new Error(payload.error?.message || 'HTTP error'), { code: payload.error?.code,status: response.status }); return payload.data;
}
const get = b => post('get',{bookId: typeof b === 'string' ? b : b.id});
const mutate = (b,operation) => post('mutate',{bookId:b.id,expectedRevision:b.revision,operation});
async function freshBook(title,rows=[]) { let b = await post('create',{title}); b = await mutate(b,{action:'addChapter',title:'第一章'}); return mutate(b,{action:'updateBook',patch:{writingConstraints:rows,contextBudget:60000}}); }
const row = (category,content,enabled=true) => ({id:randomUUID(),category,content,enabled});
function appUi(book) {
  const c = clock(), memoryDrafts = new Map(), storage = new Map(), current = {current:f.workspace(book)}, epoch = {current:0};
  const autosaveRef = {current:null}, autosaveBindings = {current:null}, pendingLatest = {current:null}, constraintsFocusRef = {current:null};
  const constraintsHistory = {current:new WeakMap()}, pendingConstraintsStructure = {current:null}, constraintsEngine = {current:null};
  let version = {};
  const h = {currentRef:current,epochRef:epoch,autosaveRef,bindings:autosaveBindings,pendingLatest,clock:c,
    flags:{loading:false,manager:null,guard:null,confirm:null,polishRequirements:null},alive:{current:true},busyRef:{current:false},recoveryRef:{current:null},composing:{current:false},
    errors:[],sent:[],applied:[],downloads:[],inFlight:0,maxInFlight:0,nextGate:null,conflict:null,memoryDrafts,storage,
    constraintsFocusRef, constraintsSourceBook:'',tab:'writing', limit:'', get version(){return version;},
    hold() {const gate={entered:deferred(),release:deferred()}; releases.push(gate.release); h.nextGate=gate; return gate;},
    loseResponse() {assert.equal(responseLossGate,null); const gate={entered:deferred(),release:deferred()}; releases.push(gate.release); responseLossGate=gate; h.faultNext='aftercommit'; return gate;},
    dispose() {autosaveRef.current.dispose(); h.alive.current=false;},
    recovery() {const raw=storage.get('ycx-moxu:draft:v1:'+current.current.book.id); return raw?JSON.parse(raw):null;},
    async finish() {c.advance(1000); await bounded(autosaveRef.current.wait(),'App autosave drains');},
  };
  const env = {...f,mode:'draft',instruction:'',current,epoch,autosaveRef,autosaveBindings,pendingLatest,memoryDrafts,constraintsFocusRef,constraintsHistory,pendingConstraintsStructure,constraintsEngine,STORAGE:'ycx-moxu:draft:v1:',alive:h.alive,busyRef:h.busyRef,recoveryRef:h.recoveryRef,autosaveComposing:h.composing,
    deletedBookIds:new Set(),unavailableBooks:{current:new Map()},
    get loading(){return h.flags.loading;},get conflict(){return h.conflict;},get manager(){return h.flags.manager;},get guard(){return h.flags.guard;},get confirm(){return h.flags.confirm;},get polishRequirements(){return h.flags.polishRequirements;},get constraintsSourceBook(){return h.constraintsSourceBook;},
    localStorage:{setItem(key,value){storage.set(key,value);},getItem:key=>storage.get(key)||null,removeItem(key){storage.delete(key);}},
    t:key=>key,commit(next){current.current=next; h.applied.push(next);},setConflict(value){h.conflict=value;},setGuard(value){h.flags.guard=value;},setBusy(){},setNotice(){},setError(value){if(value)h.errors.push(value);},setContext(){},setStorageFailed(){},syncBookList(){},resetSelection(){},invalidateReviewReturn(){},setConstraintsLimit(value){h.limit=value;},setConstraintsSourceBook(value){h.constraintsSourceBook=value;},switchTab(value){h.tab=value;},
    assignRecovery(value){h.recoveryRef.current=value;},download(filename,mime,text){h.downloads.push({filename,mime,value:JSON.parse(text)});},messageError(error){if(h.alive.current&&error?.name!=='AbortError')h.errors.push(error);},
    createAutosaveController:options=>f.createAutosaveController({...options,setTimer:c.setTimer,clearTimer:c.clearTimer}),
    async call(action,args){if(action!=='mutate')return post(action,args); h.sent.push(structuredClone(args)); h.inFlight++;h.maxInFlight=Math.max(h.maxInFlight,h.inFlight);const gate=h.nextGate;h.nextGate=null;const fault=h.faultNext;h.faultNext=null;try{const result=await post(action,args,fault);if(gate){gate.entered.resolve(result);await gate.release.promise;}return result;}finally{h.inFlight--;}}
  };
  const actions = slice('          const forgetDraft =','          const rememberJob =') + slice('          const adopt =','          const discardScope =') + slice('          const transition =','          const changeChapter =') + slice('          const downloadLocal =','          const closeSelectionPopup =') + slice('          const restoreRecovery =','          const chooseCandidate =') + slice('          const generate =','          const create =') + slice('            const leave =','            window.addEventListener');
  h.app = new Function('env','with(env){'+actions+'\nreturn {persist,adopt,loadLatest,withBusy,mutateRaw,saveAll,transition,generate,changeField,changeWritingConstraint,changeConstraintsMarkdown,acceptConstraintInput,constraintsInputBlocked,downloadLocal,restoreRecovery,leave,pagehide};}')(env);
  const applyInput = h.app.changeConstraintsMarkdown;
  h.apply = (bookId, update) => { const accepted=applyInput(bookId,update); if(accepted)version=update.version; return accepted; };
  h.edit = (text, options={}) => h.apply(current.current.book.id, transaction(current.current.constraintsEditor.text,text,{beforeVersion:version,...options}));
  h.app.changeConstraintsMarkdown = (bookId,text) => {
    const update = transaction(current.current.constraintsEditor.text,text,{beforeVersion:version});
    if(h.app.acceptConstraintInput(bookId,update)==='limit') { h.limit=bookId; return false; }
    return h.apply(bookId,update);
  };
  constraintsEngine.current = { bookId:book.id,instance:{applyStructure:({text,payload})=>h.edit(text,{origin:'input.structure',payload})} };
  Object.defineProperties(h,{controller:{get:()=>autosaveRef.current},current:{get:()=>current.current,set:value=>{current.current=value;version={};}}}); allUis.push(h);return h;
}
function requestRemove(h,id) {
  const bookId=h.current.book.id,row=h.current.settings.writingConstraints.find(item=>item.id===id);assert(row);
  const getDraft=()=>h.current.book.id===bookId?f.constraintsHistorySnapshot(h.current):null;
  const env={...f,current:h.currentRef,bookId,getDraft,constraintsFocusRef:h.constraintsFocusRef,autosaveComposing:h.composing,
    constraintsInputBlocked:h.app.constraintsInputBlocked,focusTarget(_next,kind,target){h.constraintsFocusRef.current={bookId,kind,target};},
    setConfirm(value){h.flags.confirm=value;},setError:value=>h.errors.push(value),changeWritingConstraint:h.app.changeWritingConstraint,t:key=>key};
  const request=new Function('env','with(env){'+slice('            const ruleSummary =','            const toggleRaw =')+'return requestRemove;}')(env);
  request(row);return h.flags.confirm;
}
function parseGood(text,previous=[]) {const value=f.parseConstraintsMarkdown(text,previous); assert.equal(value.error,'','Valid Markdown must parse atomically'); assert(f.validWritingConstraints(value.rows)); return value.rows;}
function assertRowsExact(actual,expected) {assert.deepEqual(actual,expected,'Exact ordered IDs/category/content/enabled, not just text presence');}
function assertContext(book) {
  for (const mode of ['draft','continue','polish','summary','revise']) {
    const chapter=book.chapters[0]; const body=chapter.body; const options={mode,instruction:'本地上下文合同',selection:mode==='polish'?{start:0,end:body.length,text:body}:null};
    const {prompt}=buildContext(book,chapter.id,options); const blocks=[...prompt.matchAll(/^【全书写作条件（完整硬约束；启用 (\d+) 条）】\n([^\n]+)/gm)]; const expected=book.writingConstraints.filter(r=>r.enabled).map(({category,content})=>({category,content}));
    assert.equal(blocks.length,expected.length?1:0); if(expected.length){assert.equal(Number(blocks[0][1]),expected.length);assert.deepEqual(JSON.parse(blocks[0][2]).conditions,expected);}
    for(const disabled of book.writingConstraints.filter(r=>!r.enabled)) {if(!expected.some(r=>r.content===disabled.content))assert(!prompt.includes(disabled.content));}
  }
}
let checks=0;
try {
  await activate();
  const preferences=(await post('list')).modelSettings;
  {
    const hostile='<script>alert(1)</script> <img src="file:///private/secret" onerror="alert(1)">\n\n![remote](https://example.invalid/image.png) [bad](javascript:alert) [data](data:text/html,alert) [file](file:///tmp/a) [safe](https://example.invalid/path)';const ast=f.markdownBlocks(hostile),allowed=new Set(['text','p','a','strong','em','del','code','pre','blockquote','ul','ol','li','hr','h1','h2','h3','h4','h5','h6']);let links=0;const visit=nodes=>{for(const n of nodes){assert(allowed.has(n.type),'Preview AST tag allowlist');assert(!Object.hasOwn(n,'html')&&!Object.hasOwn(n,'src')&&!Object.hasOwn(n,'dangerouslySetInnerHTML'));if(n.type==='a'){links++;assert.equal(n.url,'https://example.invalid/path');}if(n.children)visit(n.children);}};visit(ast);assert.equal(links,1);assert(JSON.stringify(ast).includes('<script>'),'Hostile HTML remains text data, never markup');for(const url of ['javascript:alert(1)','JAVASCRIPT:alert(1)','data:text/html,alert','file:///tmp/a','//evil.invalid/a','https://safe.invalid/\nunsafe','\u0000https://safe.invalid'])assert.equal(f.safeMarkdownUrl(url),null);assert.equal(f.safeMarkdownUrl('https://example.invalid/a'),'https://example.invalid/a');const huge='<'+'x'.repeat(21000)+'>';assert.deepEqual(f.markdownBlocks(huge),[{type:'p',text:huge}]);checks++;
  }
  const legacyRows=[row('环境','随人物的具体活动更新环境😀\r\n```text\r\n  <script>alert(1)</script>\r\n```'),row('环境','同样的规则',false),row('环境','同样的规则',true),row('分类\r\n第二行','首行\n\n末行含缩进\n    - literal child'),row('安全','[图片](https://example.invalid/remote.png) ![](data:text/html,unsafe) <iframe src="javascript:alert(1)">'),row('注释字面量','<!-- rule:11111111-1111-4111-8111-111111111111 --> 这是作者原文，不是元数据')];
  {
    const text=f.serializeConstraintsMarkdown(legacyRows);assert(!/<!--\s*rule:/.test(f.serializeConstraintsMarkdown(legacyRows.filter(r=>r.category!=='注释字面量'))),'Source contains no generated metadata comments');for(const r of legacyRows)assert(!text.includes(r.id),'Rule identity is journal metadata, not Markdown clutter');const parsed=parseGood(text,legacyRows);assertRowsExact(parsed,legacyRows);assert.equal(f.serializeConstraintsMarkdown(parsed),text,'Serializer idempotence');
    const native=text.replace(/\r\n?/g,'\n');assertRowsExact(parseGood(native,legacyRows),legacyRows);
    const b=await freshBook('重复多行CRLF往返',legacyRows),h=appUi(b);const untouched=structuredClone(h.current);await h.finish();assert.equal(h.sent.length,0,'Opening legacy conditions never rewrites canonical store');assertRowsExact((await get(b)).writingConstraints,legacyRows);assert.deepEqual(h.current,untouched);
    h.app.changeConstraintsMarkdown(b.id,text);await h.finish();assert.equal(h.sent.length,0,'Lossless same document is not a canonical rewrite');h.dispose();checks++;
  }
  {
    const collision=[row('A','same'),row('A','other',false),row('B','same')],before=f.serializeConstraintsMarkdown(collision),after=before.replace('- A','- B');
    const parsed=f.parseConstraintsMarkdown(after,collision,globalThis.crypto,{previousText:before});assert.equal(parsed.error,'');assert.deepEqual(parsed.rows.map(item=>item.id),collision.map(item=>item.id),'Localized full-source heading rename keeps the explicit group UUIDs before duplicate-value matching');
    const pair=[row('A','same'),row('B','same')],spaced='## A\n- [x] same\n\n## B\n- [x] same',pasted=spaced.replace('## A\n- [x] same\n\n','## B\n- [x] same\n'),separator=f.parseConstraintsMarkdown(pasted,pair,globalThis.crypto,{previousText:spaced});assert.equal(separator.error,'');assert.deepEqual(separator.rows.map(item=>item.id),pair.map(item=>item.id),'A heading-owned separator edit cannot let a duplicate destination group steal its UUID');
    const leading='\n'+spaced,leadingPaste=leading.replace('\n## A','## B'),leadingParsed=f.parseConstraintsMarkdown(leadingPaste,pair,globalThis.crypto,{previousText:leading});assert.deepEqual(leadingParsed.rows.map(item=>item.id),pair.map(item=>item.id),'The heading owns an edited leading separator too');
    const addPaste='## B\n- [x] same\n- [x] new\n\n## B\n- [x] same',added=f.parseConstraintsMarkdown(addPaste,pair,globalThis.crypto,{previousText:spaced});assert.equal(added.rows[0].id,pair[0].id);assert.equal(added.rows[2].id,pair[1].id);assert(!pair.some(item=>item.id===added.rows[1].id),'A newly pasted member mints identity without stealing either surviving duplicate');
    const external=[row('A','keep'),row('B','outside')],externalBefore='## A\n- [x] keep\n\n## B\n- [x] outside',externalAfter='## B\n- [x] keep\n- [x] outside\n\n## B\n- [x] outside',externalParsed=f.parseConstraintsMarkdown(externalAfter,external,globalThis.crypto,{previousText:externalBefore});assert.deepEqual([externalParsed.rows[0].id,externalParsed.rows[2].id],external.map(item=>item.id));assert(!external.some(item=>item.id===externalParsed.rows[1].id),'An inserted duplicate cannot take an untouched suffix occurrence UUID');
    const bracketRows=[row('A','alpha'),row('A','dup'),row('C','omega')],bracketBefore='# A\n- [x] alpha\n\n## A\n- [x] dup\n\n## C\n- [x] omega',bracketAfter='# A\n- [x] alpha2\n- [x] dup\n\n## A\n- [x] dup\n\n## C\n- [x] omega2',bracket=f.parseConstraintsMarkdown(bracketAfter,bracketRows,globalThis.crypto,{previousText:bracketBefore});assert.equal(bracket.error,'');assert.deepEqual([bracket.rows[0].id,bracket.rows[2].id,bracket.rows[3].id],bracketRows.map(item=>item.id),'A broad paste preserves edited edge identities and a byte-identical interior source group');assert(!bracketRows.some(item=>item.id===bracket.rows[1].id),'The bracketed inserted duplicate must be fresh');
    const duplicateGroupRows=[row('B','alpha'),row('B','dup'),row('B','dup'),row('B','tail'),row('C','omega')],duplicateGroupBefore='# B\n- [x] alpha\n\n## B\n- [x] dup\n- [x] dup\n- [x] tail\n\n## C\n- [x] omega',duplicateGroupAfter='# B\n- [x] alpha2\n- [x] dup\n\n## B\n- [x] dup\n- [x] dup\n- [x] tail2\n\n## C\n- [x] omega2',duplicateGroup=f.parseConstraintsMarkdown(duplicateGroupAfter,duplicateGroupRows,globalThis.crypto,{previousText:duplicateGroupBefore});assert.equal(duplicateGroup.error,'');assert.deepEqual([0,2,3,4,5].map(index=>duplicateGroup.rows[index].id),duplicateGroupRows.map(item=>item.id),'Paired interior duplicate occurrences reserve their ordered UUIDs before global exact matching');assert(!duplicateGroupRows.some(item=>item.id===duplicateGroup.rows[1].id),'The earlier inserted duplicate remains fresh');
    const mergedRows=[row('A','first'),row('B','outside'),row('A','outside')],mergedBefore='## A\n- [x] first\n\n## B\n- [x] outside\n\n## A\n- [x] outside',mergedAfter=mergedBefore.replace('## B\n',''),merged=f.parseConstraintsMarkdown(mergedAfter,mergedRows,globalThis.crypto,{previousText:mergedBefore});assert.deepEqual(merged.rows.map(item=>item.id),mergedRows.map(item=>item.id),'Heading deletion preserves unchanged prefix and suffix occurrences during group merge');
    const splitRows=[row('A','first'),row('A','outside'),row('B','outside')],splitBefore='## A\n- [x] first\n- [x] outside\n\n## B\n- [x] outside',splitAfter=splitBefore.replace('- [x] outside\n\n## B','## B\n- [x] outside\n\n## B'),split=f.parseConstraintsMarkdown(splitAfter,splitRows,globalThis.crypto,{previousText:splitBefore});assert.deepEqual(split.rows.map(item=>item.id),splitRows.map(item=>item.id),'Heading insertion preserves unchanged prefix and suffix occurrences during group split');
    const repeatedFresh=randomUUID(),repeatedGenerated=f.parseConstraintsMarkdown('## A\n- first\n- second',[],{randomUUID:()=>repeatedFresh});assert.equal(repeatedGenerated.error,'constraintsCrypto','A repeated provider result across two fresh rows is a crypto failure');checks++;
  }
  {
    const rows=[row('A','one'),row('A','two')],book=mutateBook(createBook('结构源保真'),{action:'updateBook',patch:{writingConstraints:rows}}),base=f.workspace(book),raw='## A\r\n\r\n- [x] one\r\n\r\n## A\r\n- [x] two';
    const workspace={...base,constraintsEditor:{...base.constraintsEditor,text:raw,parsedText:raw}},toggled=f.editWritingConstraints(workspace,book.id,{type:'edit',id:rows[1].id,field:'enabled',value:false});
    assert.equal(toggled.constraintsEditor.text,raw.replace('- [x] two','- [ ] two'),'Structural checkbox edit splices only its marker and preserves CRLF plus equal-name source groups');
    assert.throws(()=>f.editWritingConstraints(workspace,book.id,{type:'add',category:'A',content:'collision'},{randomUUID:()=>rows[0].id}),/constraintsCrypto/,'Visual Add rejects a UUID provider collision with an existing row');checks++;
  }
  {
    const legacy=mutateBook(createBook('schema1旧书无条件字段'),{action:'addChapter',title:'旧章节'});delete legacy.writingConstraints;await deactivate();await activate(legacy);const h=appUi(await get(legacy));await h.finish();assert.equal(h.sent.length,0);assert(!Object.hasOwn(await get(legacy),'writingConstraints'),'Legacy tab entry never injects canonical constraints field');h.app.changeField('settings','premise','旧书其他合法字段');await h.finish();assert(!Object.hasOwn(await get(legacy),'writingConstraints'),'Unrelated edits do not migrate legacy condition storage');h.dispose();checks++;
  }
  {
    const boundary=[row('😀'.repeat(40),'😀'.repeat(2000)),...Array.from({length:63},(_,i)=>row('类'+i,'内容'+i,i%2===0))];assertRowsExact(parseGood(f.serializeConstraintsMarkdown(boundary),boundary),boundary);const newlineHeavy=Array.from({length:64},(_,i)=>row('合法满长'+i,'x'+'\n'.repeat(3999),i%2===0));const heavyDocument=f.serializeConstraintsMarkdown(newlineHeavy);assert(heavyDocument.length>1700000);assertRowsExact(parseGood(heavyDocument,newlineHeavy),newlineHeavy);const tooMany=[...boundary,row('第65','拒绝')];assert(f.parseConstraintsMarkdown(f.serializeConstraintsMarkdown(tooMany),boundary).error);assert(f.parseConstraintsMarkdown('- '+ '😀'.repeat(41)+'\n    - 规则').error);const plain=parseGood('- 环境\n    - 普通启用规则\n    - [ ] 停用任务\n    - [x] 启用任务');assert.deepEqual(plain.map(({category,content,enabled})=>({category,content,enabled})),[{category:'环境',content:'普通启用规则',enabled:true},{category:'环境',content:'停用任务',enabled:false},{category:'环境',content:'启用任务',enabled:true}]);checks++;
  }
  {
    const rows=[row('格式','条件**内容**不变')],b=await freshBook('有效外围格式不迁移后端',rows),h=appUi(b),raw='## 格式\n- [x] 条件**内容**不变';h.app.changeConstraintsMarkdown(b.id,raw);assert.equal(h.current.constraintsEditor.text,raw);await h.finish();assert.equal(h.sent.length,0,'Semantic-only formatting acknowledgment does not create a Host mutation');assert.equal(f.isDirty(h.current),false);assert.equal(h.current.constraintsEditor.text,raw,'Current session keeps authored outer spelling');assert.equal(h.recovery(),null);const reopened=f.workspace(await get(b));assert.equal(reopened.constraintsEditor.text,f.serializeConstraintsMarkdown(rows),'Clean outer syntax intentionally regenerates from canonical array on reopen');assert.notEqual(reopened.constraintsEditor.text,raw);assertRowsExact(reopened.settings.writingConstraints,rows);h.dispose();checks++;
  }
  {
    const base=[row('唯一','不可通过临时剪切清空')],b=await freshBook('剪切空文档与显式最后删除',base),h=appUi(b);h.app.changeConstraintsMarkdown(b.id,'');await h.finish();assertRowsExact((await get(b)).writingConstraints,base);assert(h.current.constraintsEditor.error,'Temporary select-all/cut is not destructive valid empty save');h.app.changeConstraintsMarkdown(b.id,f.serializeConstraintsMarkdown(base));h.app.changeWritingConstraint(b.id,{type:'remove',id:base[0].id});await h.finish();assertRowsExact((await get(b)).writingConstraints,[]);assert.equal(h.current.constraintsEditor.text,'');assert.equal(h.current.constraintsEditor.error,'');assert.equal(h.recovery(),null);h.dispose();checks++;
  }
  {
    const base=[row('模式','最新状态决定是否完成')],b=await freshBook('连续编辑、恢复与写入门禁',base),h=appUi(b);
    const initial=h.current.constraintsEditor.text, initialVersion=h.version, invalid='- 模式\n    - [x] ';
    assert(h.edit(invalid)); assert(h.current.constraintsEditor.error); assertRowsExact(h.current.settings.writingConstraints,base);
    assert.equal(h.recovery()?.constraintsEditor?.text,invalid,'The local journal contains the exact unfinished raw text');
    assert.equal(h.app.changeWritingConstraint(b.id,{type:'add',category:'不得新增',content:'不得覆盖raw'}),null);
    assert.doesNotThrow(() => assert.equal(f.editWritingConstraints(h.current,b.id,{type:'add',category:'纯结构助手',content:'不得覆盖raw'}),h.current),
      'The pure structural helper ignores invalid document edits without touching the last-valid array');
    h.constraintsSourceBook=b.id; assert.equal(h.current.constraintsEditor.text,invalid,'Literal presentation never rewrites the document');
    assert(h.edit(initial,{origin:'undo',version:initialVersion})); assert.equal(h.recovery(),null,'Returning clean must not revive a stale invalid journal'); await h.finish(); assert.equal(h.sent.length,0);
    h.flags.manager={}; assert.equal(h.edit(invalid),false); h.flags.manager=null;
    h.composing.current=true; assert(h.edit(initial.replace('最新状态决定是否完成','输入法组合中'))); await h.finish(); assert.equal(h.sent.length,0);
    h.composing.current=false; assert(h.edit(initial.replace('最新状态决定是否完成','修复后的完整内容'))); await h.finish();
    assertRowsExact((await get(b)).writingConstraints,[{...base[0],content:'修复后的完整内容'}]);
    const current=h.current, text=current.constraintsEditor.text;
    const wrongBefore=transaction(text,'- 过期\n    - 内容',{beforeVersion:h.version}); wrongBefore.before='x'+wrongBefore.before.slice(1);
    assert.equal(h.apply(b.id,wrongBefore),false); assert.equal(h.current,current);
    h.busyRef.current=true; assert.equal(h.edit(invalid),false); assert.equal(h.current,current); h.busyRef.current=false;
    h.current={...current,settings:{...current.settings,writingConstraints:[{...base[0],id:randomUUID(),content:'修复后的完整内容'}]}};
    assert.equal(h.apply(b.id,transaction(text,text+'编辑',{beforeVersion:wrongBefore.beforeVersion})),false,'Identical source with different canonical rows must reject old version');
    h.dispose();checks++;
  }
  {
    const base=[row('原类','不能误删')],b=await freshBook('新增与确认删除进入同一撤销历史',base),h=appUi(b);
    const next=h.app.changeWritingConstraint(b.id,{type:'add',category:'新类',content:'新规则',afterId:base[0].id});assert(next);
    const added=next.settings.writingConstraints.find(item=>item.id!==base[0].id);assert(added);
    assert(h.edit(next.constraintsEditor.text.replace('新规则','完整后保存')));await h.finish();
    const saved=await get(b);assertRowsExact(saved.writingConstraints,[base[0],{...added,content:'完整后保存'}]);
    const stale=requestRemove(h,added.id), snapshot=h.current;
    h.flags.confirm=null;assert(h.edit(snapshot.constraintsEditor.text.replace('完整后保存','又一次编辑')));
    const before=h.sent.length;stale.run();assert.equal(h.errors.at(-1).message,'confirmChanged');assert.equal(h.sent.length,before);
    assert(h.edit(snapshot.constraintsEditor.text));await h.finish();
    const previous=h.version;
    const approved=requestRemove(h,added.id);assert(approved);approved.run();assert.equal(h.flags.confirm,null);
    assert.deepEqual(h.constraintsFocusRef.current,{bookId:b.id,kind:'rule',target:base[0].id});
    await h.finish();assertRowsExact((await get(b)).writingConstraints,base);
    const removed=h.version;assert(h.edit(snapshot.constraintsEditor.text,{origin:'undo',version:previous}));await h.finish();
    assertRowsExact((await get(b)).writingConstraints,saved.writingConstraints,'Undo of toolbar deletion restores the exact UUID after ACK');
    assert(h.edit(f.serializeConstraintsMarkdown(base),{origin:'redo',version:removed}));await h.finish();
    assertRowsExact((await get(b)).writingConstraints,base);h.dispose();checks++;
  }
  {
    const rows=[row('环境','第一条😀'),row('同类','重复规则',false),row('同类','重复规则',true)];const b=await freshBook('文档重排分类改名与图标',rows),h=appUi(b);
    const edited=[rows[0],rows[1],{...rows[2],category:'新分类',content:'改名仍是同一规则😀\n下一行'}];h.app.changeConstraintsMarkdown(b.id,f.serializeConstraintsMarkdown(edited));await h.finish();assertRowsExact((await get(b)).writingConstraints,edited,'Localized edit preserves changed row identity');
    const desired=[edited[2],edited[0],edited[1]];
    const raw=f.serializeConstraintsMarkdown(desired);h.app.changeConstraintsMarkdown(b.id,raw);await h.finish();assertRowsExact((await get(b)).writingConstraints,desired);
    h.app.changeWritingConstraint(b.id,{type:'edit',id:rows[1].id,field:'enabled',value:true});await h.finish();const toggled=[desired[0],desired[1],{...desired[2],enabled:true}];assertRowsExact((await get(b)).writingConstraints,toggled);assertRowsExact(parseGood(h.current.constraintsEditor.text,toggled),toggled);
    h.app.changeWritingConstraint(b.id,{type:'remove',id:rows[0].id});await h.finish();const removed=[toggled[0],toggled[2]];assertRowsExact((await get(b)).writingConstraints,removed);assertRowsExact(parseGood(h.current.constraintsEditor.text,removed),removed);
    const withAdded=h.app.changeWritingConstraint(b.id,{type:'add',category:'图标新类',content:'初始规则'});const added=withAdded.settings.writingConstraints.find(r=>!removed.some(old=>old.id===r.id));assert(added);assert(h.edit(withAdded.constraintsEditor.text.replace('图标新类','视觉新类').replace('初始规则','完整后保存')));await h.finish();assertRowsExact((await get(b)).writingConstraints,[...removed,{...added,category:'视觉新类',content:'完整后保存'}]);h.dispose();checks++;
  }
  {
    const rows=[row('同类','相同目标',false),row('同类','另一个内容'),row('同类','待编辑',false)],b=await freshBook('局部编辑形成重复项仍守身份',rows),h=appUi(b);const duplicated=[rows[0],rows[1],{...rows[2],content:'相同目标'}];h.app.changeConstraintsMarkdown(b.id,f.serializeConstraintsMarkdown(duplicated));await h.finish();assertRowsExact((await get(b)).writingConstraints,duplicated);const toggled=[{...duplicated[0],enabled:true},duplicated[1],duplicated[2]];h.app.changeConstraintsMarkdown(b.id,f.serializeConstraintsMarkdown(toggled));await h.finish();assertRowsExact((await get(b)).writingConstraints,toggled);const reordered=[toggled[2],toggled[1],toggled[0]], replacement=f.serializeConstraintsMarkdown(reordered);assert(h.edit(replacement,{origin:'input.paste',changes:[{from:0,to:h.current.constraintsEditor.text.length,insert:replacement}]}));await h.finish();assertRowsExact((await get(b)).writingConstraints,reordered);h.dispose();checks++;
  }
  {
    const b=await freshBook('未完成文档只本地保存',[row('基线','保持已有内容')]),h=appUi(b);const before=structuredClone(b.writingConstraints);
    const invalid=['- 环境\n    - ', '- 分类没有子规则','孤立正文','- \n    - 内容','- 分类\n  - 错误缩进','- 分类\n    - [x] '+ '长'.repeat(4001),'- '+ '类'.repeat(81)+'\n    - 完整','- 分类\n    - \uD800'];
    for(const raw of invalid){const parsed=f.parseConstraintsMarkdown(raw,before);assert(parsed.error,'Invalid syntax/UTF16/length must fail');assert.equal(parsed.rows,null,'Invalid parse exposes no partial array');h.app.changeConstraintsMarkdown(b.id,raw);assert.equal(h.current.constraintsEditor.text,raw);assert(h.current.constraintsEditor.error);assertRowsExact(h.current.settings.writingConstraints,before);h.app.changeField('settings','premise','别的有效字段 '+checks+' '+invalid.indexOf(raw));await h.finish();const saved=await get(b);assertRowsExact(saved.writingConstraints,before);assert.equal(saved.premise,h.current.settings.premise);assert.equal(h.current.constraintsEditor.text,raw);assert(h.recovery()?.constraintsEditor,'Invalid raw document must exist in recovery journal');assert.equal(h.recovery().constraintsEditor.text,raw);}
    const guarded=h.current;h.app.changeConstraintsMarkdown(b.id,'超'.repeat(2000001));assert.equal(h.current,guarded,'Oversize input cannot truncate or discard existing source');assert.equal(h.limit,b.id,'Limit is an inline notice, not a modal');for(const action of [{type:'add'},{type:'remove',id:before[0].id},{type:'edit',id:before[0].id,field:'enabled',value:false}]){h.app.changeWritingConstraint(b.id,action);assert.equal(h.current,guarded,'Actual icon callback cannot overwrite unfinished raw from last-valid rows');}
    let navigated=false;await h.app.transition(()=>{navigated=true;});assert.equal(navigated,false);assert(h.flags.guard);h.flags.guard=null;const beforeGenerate=requests.length;assert.equal(await h.app.generate(),false,'Invalid raw blocks actual generation callback even though canonical array remains valid');assert.equal(h.errors.at(-1).message,'saveFirst');assert(!requests.slice(beforeGenerate).some(r=>r.action==='generate'));
    const count=h.sent.length;await h.finish();await h.controller.flush();assert.equal(h.sent.length,count,'No repeated incomplete writes');const journal=h.recovery();assert.equal(f.validAutosaveRecovery(journal,b.id),true);h.dispose();
    await deactivate();await activate();const restored=appUi(await get(b));restored.recoveryRef.current=journal;restored.app.restoreRecovery();assert.equal(restored.current.constraintsEditor.text,invalid.at(-1));assert(restored.current.constraintsEditor.error);assert.equal(restored.constraintsSourceBook,b.id,'Invalid recovery opens the same editor in source mode');assert.equal(restored.tab,'constraints');assert.deepEqual(restored.constraintsFocusRef.current,{bookId:b.id,start:invalid.at(-1).length,end:invalid.at(-1).length});await restored.finish();assertRowsExact((await get(b)).writingConstraints,before);restored.dispose();checks++;
  }
  {
    const base=[row('已有类','已有内容')],b=await freshBook('未发出有效版本被无效raw拦截',base),h=appUi(b);const intermediate=[{...base[0],content:'尚未发出的有效A'}];h.app.changeConstraintsMarkdown(b.id,f.serializeConstraintsMarkdown(intermediate));h.app.changeConstraintsMarkdown(b.id,'- 未完成\n    - ');h.app.changeField('settings','premise','独立合法内容仍需保存');await h.finish();assertRowsExact((await get(b)).writingConstraints,base,'Incomplete raw forbids last-valid unsent array from silently saving');assert.equal((await get(b)).premise,'独立合法内容仍需保存');assert.equal(h.sent.length,1);assert(!Object.hasOwn(h.sent[0].operation.patch,'writingConstraints'));assert.equal(h.current.constraintsEditor.text,'- 未完成\n    - ');h.dispose();checks++;
  }
  {
    const base=[row('已有类','已有内容')],b=await freshBook('raw单独脏的跨窗口冲突',base),h=appUi(b);const raw='- 本地未完成\n    - ';h.app.changeConstraintsMarkdown(b.id,raw);assertRowsExact(h.current.settings.writingConstraints,base);const external=[{...base[0],content:'另一个窗口修改'}],updated=await mutate(b,{action:'updateBook',patch:{writingConstraints:external}});await h.app.loadLatest();assert(h.conflict,'Raw-only settings edits still participate in conflict detection');assert(h.conflict.fields.includes('settings'));assert.equal(h.current.constraintsEditor.text,raw);assertRowsExact(h.current.baseSettings.writingConstraints,base);assert.equal(h.recovery().constraintsEditor.text,raw);h.app.changeConstraintsMarkdown(b.id,'- 本地完成\n    - 内容');await h.finish();assert.equal(h.sent.length,0,'Conflicted completion cannot overwrite external constraints');assert.deepEqual(await get(b),updated);h.dispose();checks++;
  }
  {
    const base=[row('基线','原始')],b=await freshBook('显式变基后崩溃恢复',base),h=appUi(b);const desired=[{...base[0],content:'作者本地完整更改'}];h.app.changeConstraintsMarkdown(b.id,f.serializeConstraintsMarkdown(desired));const latest=await mutate(b,{action:'updateBook',patch:{writingConstraints:[{...base[0],content:'服务器已变更'}]}});await h.app.loadLatest();assert(h.conflict);const start=source.indexOf('commit(mergeWorkspace(current.current, latest, null, true))'),end=source.indexOf(' } });',start);assert(start>=0&&end>start,'Exact explicit rebase confirmation callback');const confirmRebase=new Function('env','with(env){return ()=>{'+source.slice(start,end)+'};}')({...f,current:h.currentRef,latest,commit:next=>{h.current=next;},setConflict:value=>{h.conflict=value;},setConfirm(){},setError(){},setNotice(){},t:key=>key});confirmRebase();h.app.persist(h.current);const journal=h.recovery();assert(journal);assert.equal(f.validAutosaveRecovery(journal,b.id),true,'Explicit rebase journal baseline document must match refreshed baseline rows');assert.equal(journal.constraintsEditor.text,f.serializeConstraintsMarkdown(desired));h.dispose();await deactivate();await activate();const restored=appUi(await get(b));restored.recoveryRef.current=journal;restored.app.restoreRecovery();assert.equal(restored.conflict,null);assertRowsExact(restored.current.settings.writingConstraints,desired);assert.equal(restored.current.constraintsEditor.text,f.serializeConstraintsMarkdown(desired));await restored.controller.flush();assertRowsExact((await get(b)).writingConstraints,desired);restored.dispose();checks++;
  }
  {
    const original=row('原类','原内容'),b=await freshBook('慢ACK保留新无效文档',[original]),h=appUi(b),gate=h.hold();const sent=[{...original,content:'发出版本A'}],rawA=f.serializeConstraintsMarkdown(sent),invalid='- 尚未完成\n    - ';
    h.app.changeConstraintsMarkdown(b.id,rawA);const pending=h.controller.flush();await bounded(gate.entered.promise,'Markdown A committed');h.app.changeConstraintsMarkdown(b.id,invalid);gate.release.resolve();await bounded(pending,'older Markdown ACK');assert.equal(h.current.constraintsEditor.text,invalid);assert(h.current.constraintsEditor.error);assert.equal(h.current.constraintsEditor.baseText,rawA);await h.finish();assertRowsExact((await get(b)).writingConstraints,sent);assert.equal(h.sent.length,1,'ACK cannot save prior parsed array while raw is unfinished');h.dispose();checks++;
  }
  {
    const original=row('原类','原内容'),b=await freshBook('慢ACK保留新有效文档',[original]),h=appUi(b),gate=h.hold();const sent=[{...original,content:'版本A'}],desired=[{...original,category:'改类',content:'版本B😀\n完整'}];h.app.changeConstraintsMarkdown(b.id,f.serializeConstraintsMarkdown(sent));const pending=h.controller.flush();await bounded(gate.entered.promise,'valid A committed');const raw=f.serializeConstraintsMarkdown(desired);h.app.changeConstraintsMarkdown(b.id,raw);gate.release.resolve();await bounded(pending,'valid newer ACK');assert.equal(h.current.constraintsEditor.text,raw);assertRowsExact(h.current.settings.writingConstraints,desired);await h.finish();assertRowsExact((await get(b)).writingConstraints,desired);assert.equal(h.sent.length,2);assert.equal(h.maxInFlight,1);h.dispose();checks++;
  }
  {
    const original=row('原类','原文😀\r\n不可丢失'),b=await freshBook('崩溃窗口原始文档撤销',[original]),h=appUi(b),rawOriginal=h.current.constraintsEditor.text,gate=h.hold();const sent=[{...original,content:original.content+'已提交的中间版本'}],rawA=f.serializeConstraintsMarkdown(sent);h.app.changeConstraintsMarkdown(b.id,rawA);const pending=h.controller.flush();const committed=await bounded(gate.entered.promise,'undo A committed');h.app.changeConstraintsMarkdown(b.id,rawOriginal);assert.equal(h.current.constraintsEditor.text,rawOriginal);h.app.pagehide();const journal=h.recovery();assert(journal,'Pending clean-looking undo must retain journal');assert.equal(journal.constraintsEditor.text,rawOriginal);assert.equal(journal.constraintsEditor.baseText,rawA);assert.equal(f.validAutosaveRecovery(journal,b.id),true);let warned=0;h.app.leave({preventDefault(){warned++;},returnValue:undefined});assert.equal(warned,1);h.dispose();gate.release.resolve();await bounded(pending,'abandoned undo ACK');await deactivate();await activate();const reopened=await get(b);assert.equal(reopened.revision,committed.revision);assertRowsExact(reopened.writingConstraints,sent);const restored=appUi(reopened);restored.recoveryRef.current=journal;restored.app.restoreRecovery();assert.equal(restored.current.constraintsEditor.text,rawOriginal);assertRowsExact(restored.current.settings.writingConstraints,[original]);await restored.controller.flush();assertRowsExact((await get(b)).writingConstraints,[original]);restored.dispose();checks++;
  }
  {
    const original=row('原类','原文'),b=await freshBook('真实ACK断连GET重试身份',[original]),h=appUi(b),rawOriginal=h.current.constraintsEditor.text,gate=h.loseResponse();const sent=[{...original,content:'ACK丢失但已提交'}];h.app.changeConstraintsMarkdown(b.id,f.serializeConstraintsMarkdown(sent));const pending=h.controller.flush();const committed=await bounded(gate.entered.promise,'response-loss commit');h.app.changeConstraintsMarkdown(b.id,rawOriginal);gate.release.resolve();await bounded(pending,'real TCP disconnect');assert.equal(h.controller.failed,true);assert.equal(h.errors.length,1);assert.equal(h.errors[0].code,'NETWORK');h.app.changeField('settings','premise','失败后本地编辑');await h.finish();await h.controller.flush();assert.equal(h.sent.length,1,'Failure latch prevents implicit retries');assert.equal(h.recovery().constraintsEditor.text,rawOriginal);const before=requests.length;assert.equal(await h.app.saveAll(),true);assert(requests.slice(before).some(r=>r.action==='get'),'Explicit retry reconciles via real GET');assert.equal(h.sent[1].expectedRevision,committed.revision);assertRowsExact((await get(b)).writingConstraints,[original]);assert.equal((await get(b)).premise,'失败后本地编辑');assert.equal(h.controller.failed,false);assert.equal(h.recovery(),null);h.dispose();checks++;
  }
  {
    const original=row('旧书','原文'),b=await freshBook('过期book与epoch',[original]),other=await freshBook('新书不许被迟到覆盖',[row('新书','不可改')]),h=appUi(b),gate=h.hold();const raw=f.serializeConstraintsMarkdown([{...original,content:'旧书发出'}]);h.app.changeConstraintsMarkdown(b.id,raw);const pending=h.controller.flush();await bounded(gate.entered.promise,'old book commit');h.epochRef.current++;h.current=f.workspace(other);h.controller.cancel();const unchanged=h.current;h.app.changeConstraintsMarkdown(b.id,'- 旧事件\n    - 不可定向新书');assert.equal(h.current,unchanged,'Stale source callback cannot target different book');gate.release.resolve();await bounded(pending,'stale ACK');assert.equal(h.current,unchanged);assert.deepEqual(await get(other),other);assert.equal(h.applied.filter(w=>w.book.id===other.id).length,0);h.dispose();checks++;
  }
  {
    const base=[row('基线','A')],b=await freshBook('恢复文档与行不匹配拒绝',base),w=f.workspace(b);const rowsB=[{...base[0],content:'B'}],rowsC=[{...base[0],content:'C'}],edited=f.editConstraintsMarkdown(w,b.id,f.serializeConstraintsMarkdown(rowsB));const good=f.autosaveRecoveryPayload(edited);assert.equal(f.validAutosaveRecovery(good,b.id),true);const corrupt=structuredClone(good);corrupt.constraintsEditor.text=f.serializeConstraintsMarkdown(rowsC);corrupt.constraintsEditor.parsedText=corrupt.constraintsEditor.text;assert.equal(f.validAutosaveRecovery(corrupt,b.id),false,'Well-shaped journal cannot show C while persisting B');const wrongBase=structuredClone(good);wrongBase.constraintsEditor.baseText=f.serializeConstraintsMarkdown(rowsC);assert.equal(f.validAutosaveRecovery(wrongBase,b.id),false,'Journal base document must match canonical baseline');const same=structuredClone(good);same.constraintsEditor.error='constraintsMarkdownInvalid';same.constraintsEditor.text='- 未完成\n    - ';assert.equal(f.validAutosaveRecovery(same,b.id),true,'Valid last-parsed rows plus unfinished raw remains recoverable');checks++;
  }
  {
    let b=await freshBook('全启用条件完整上下文',legacyRows);b=await mutate(b,{action:'updateChapter',chapterId:b.chapters[0].id,patch:{body:'完整原文😀'}});assertContext(b);const context=await post('context',{bookId:b.id,chapterId:b.chapters[0].id,mode:'continue',instruction:'真实上下文入口',selection:null});assert(context.prompt);assert.deepEqual(buildContext(b,b.chapters[0].id,{mode:'continue',instruction:'真实上下文入口',selection:null}).prompt,context.prompt);checks++;
  }
  {
    const rows=[row('A','one😀'),row('B','two\r\ncontinue'),row('C','three')],b=await freshBook('不相连的跨分类编辑和混合换行',rows),h=appUi(b);
    const original='## A\r\n- one😀\n\n## B\r- two\r\n      continue\n\n## C\n- three';
    h.current={...h.current,constraintsEditor:{text:original,baseText:original,parsedText:original,error:''}};
    const before=f.textareaValue(original), one=before.indexOf('one😀'), three=before.indexOf('three'), version=h.version;
    const desired=original.replace('one😀','uno😀').replace('three','tres');
    assert(h.edit(desired,{changes:[{from:one,to:one+5,insert:'uno😀'},{from:three,to:three+5,insert:'tres'}]}));
    assert.equal(h.current.constraintsEditor.text,desired,'Disjoint edits retain the untouched mixed-CRLF interior');
    await h.finish();assertRowsExact((await get(b)).writingConstraints,[{...rows[0],content:'uno😀'},rows[1],{...rows[2],content:'tres'}]);
    assert(h.edit(original,{origin:'undo',version}));await h.finish();assertRowsExact((await get(b)).writingConstraints,rows);assert.equal(h.current.constraintsEditor.text,original);h.dispose();checks++;
  }
  {
    const rows=[row('同类','same',false),row('同类','same',false)],b=await freshBook('精确删除与逐字补全重复规则',rows),h=appUi(b);
    const original=h.current.constraintsEditor.text, originalVersion=h.version, from=original.indexOf('    -'), to=original.lastIndexOf('    -');
    const shortened=original.slice(0,from)+original.slice(to);
    assert(h.edit(shortened,{changes:[{from,to,insert:''}]}));
    assertRowsExact(h.current.settings.writingConstraints,[rows[1]],'Deleting the first identical line must retain the second UUID');
    await h.finish();assertRowsExact((await get(b)).writingConstraints,[rows[1]]);
    const shortVersion=h.version;
    assert(h.edit(original,{origin:'undo',version:originalVersion,changes:[{from,to:from,insert:original.slice(from,to)}]}));
    await h.finish();assertRowsExact((await get(b)).writingConstraints,rows);
    assert(h.edit(shortened,{origin:'redo',version:shortVersion,changes:[{from,to,insert:''}]}));
    assertRowsExact(h.current.settings.writingConstraints,[rows[1]]);
    const incomplete='    - [ ] \n';
    assert(h.edit(shortened.slice(0,from)+incomplete+shortened.slice(from),{changes:[{from,to:from,insert:incomplete}]}));
    assert(h.current.constraintsEditor.error);assertRowsExact(h.current.settings.writingConstraints,[rows[1]]);
    const journal=h.recovery();assert(f.validAutosaveRecovery(journal,b.id));
    assert.deepEqual(journal.constraintsEditor.anchoredStarts,[from+incomplete.length]);
    for(const invalidAnchors of [[],[null,null],[-1],[1000000],['0']]) {
      const malformed=structuredClone(journal);malformed.constraintsEditor.anchoredStarts=invalidAnchors;
      assert.equal(f.validAutosaveRecovery(malformed,b.id),false,'Recovery rejects malformed or misaligned source coordinates');
    }
    h.dispose();await deactivate();await activate();
    const reopened=appUi(await get(b));reopened.recoveryRef.current=journal;reopened.app.restoreRecovery();
    assert.equal(reopened.current.constraintsEditor.text,journal.constraintsEditor.text);
    const at=from+incomplete.length-1;
    assert(reopened.edit(original,{changes:[{from:at,to:at,insert:'same'}]}));
    const completed=reopened.current.settings.writingConstraints;
    assert(!rows.some(item=>item.id===completed[0].id),'Typing an indistinguishable new line after deletion is not undo');
    assertRowsExact(completed.slice(1),[rows[1]],'Completing an unfinished duplicate keeps the older following occurrence');
    await reopened.finish();assertRowsExact((await get(b)).writingConstraints,completed);reopened.dispose();checks++;
  }
  {
    const rows=[row('分类','保留内容')],b=await freshBook('接近上限的混合换行撤销',rows),h=appUi(b);
    const valid=h.current.constraintsEditor.text, skipped='X\n'.repeat(670000), raw='\r\n'+skipped+valid;
    h.current={...h.current,constraintsEditor:{...h.current.constraintsEditor,text:raw,error:'constraintsMarkdownInvalid'}};
    const beforeVersion=h.version;
    assert(h.edit('\r\n'+valid,{changes:[{from:1,to:1+skipped.length,insert:''}]}));
    await h.finish();assert.equal(h.current.constraintsEditor.error,'');assertRowsExact((await get(b)).writingConstraints,rows);
    assert(h.edit(raw,{origin:'undo',version:beforeVersion,changes:[{from:1,to:1,insert:skipped}]}),'Undo restores the original admitted raw bytes within their actual limit');
    assert.equal(h.current.constraintsEditor.text,raw);assert(f.validAutosaveRecovery(h.recovery(),b.id));
    h.dispose();checks++;
  }
  {
    const rows=[row('分类','原文')],b=await freshBook('导航等候写入时启动组合输入',rows),h=appUi(b);
    const text=f.serializeConstraintsMarkdown([{...rows[0],content:'开始组合前的文档'}]);
    assert(h.edit(text));const gate=h.hold();let navigated=false;
    const transition=h.app.transition(()=>{navigated=true;});
    await bounded(gate.entered.promise,'transition waiting for Markdown save');
    h.composing.current=true;gate.release.resolve();await bounded(transition,'transition rechecks composition');
    assert.equal(navigated,false,'A transition admitted before composition may not leave on a later receipt');
    assert.equal(h.flags.guard,null,'Do not take focus via a late unsaved dialog during composition');
    h.composing.current=false;await h.app.transition(()=>{navigated=true;});assert.equal(navigated,true);h.dispose();checks++;
  }
  {
    const legacy=row('环境','- ',false), existing=row('环境','- 仍可使用',false), base=[legacy,existing];
    const b=await freshBook('续写空前缀与旧短横线的身份',base),h=appUi(b);
    const old=h.current.constraintsEditor.text, at=old.length;
    const next=f.constraintsDocumentKey(old,at,at,'Enter');
    const starter='\n    - [x] - ';
    assert.equal(next.value,old+starter);
    assert(h.edit(next.value,{changes:[{from:at,to:at,insert:starter}]}));
    assert.equal(h.current.constraintsEditor.error,'constraintsRuleStarter');
    const recovered=h.recovery();assert.equal(recovered.constraintsEditor.text,old+starter);assert(f.validAutosaveRecovery(recovered,b.id));
    await h.finish();assert.equal(h.sent.length,0);assertRowsExact((await get(b)).writingConstraints,base);
    h.dispose();await deactivate();await activate();
    const reopened=appUi(await get(b));reopened.recoveryRef.current=recovered;reopened.app.restoreRecovery();
    const legacyStart=old.indexOf('\n')+1, legacyEnd=old.indexOf('\n',legacyStart)+1;
    let doc=old.slice(0,legacyStart)+old.slice(legacyEnd)+starter;
    assert(reopened.edit(doc,{changes:[{from:legacyStart,to:legacyEnd,insert:''}]}));
    assert.equal(reopened.current.constraintsEditor.error,'constraintsRuleStarter','Deleting an old dash cannot turn the new blank starter into a saved rule');
    const checkbox=doc.lastIndexOf('[x]');
    assert(reopened.edit(doc.slice(0,checkbox)+doc.slice(checkbox+4),{changes:[{from:checkbox,to:checkbox+4,insert:''}]}));
    doc=reopened.current.constraintsEditor.text;
    assert.equal(reopened.current.constraintsEditor.error,'constraintsRuleStarter','Removing the checkbox still leaves an empty inner bullet');
    await reopened.finish();assert.equal(reopened.sent.length,0);assertRowsExact((await get(b)).writingConstraints,base);
    const pos=doc.length, typed='新增正文😀';
    assert(reopened.edit(doc+typed,{changes:[{from:pos,to:pos,insert:typed}]}));
    await reopened.finish();assert.equal(reopened.sent.length,1);
    const saved=(await get(b)).writingConstraints;
    assert.equal(saved.length,2);assert.deepEqual(saved[0],existing);assert.equal(saved[1].content,'- '+typed);assert.equal(saved[1].enabled,true);
    assert(!base.some(rule=>rule.id===saved[1].id),'The new rule is not the deleted literal dash');
    reopened.dispose();checks++;
  }
  {
    const legacy=row('环境','- ',false), base=[legacy], b=await freshBook('类别回车开始缩进规则',base),h=appUi(b);
    const old=h.current.constraintsEditor.text, at=old.indexOf('\n'), starter='\n    - [x] - ';
    const next=f.constraintsDocumentKey(old,at,at,'Enter');
    assert.equal(next.value,old.slice(0,at)+starter+old.slice(at));
    assert(h.edit(next.value,{changes:[{from:at,to:at,insert:starter}]}));
    await h.finish();assert.equal(h.sent.length,0);assertRowsExact((await get(b)).writingConstraints,base);
    const pos=next.start, typed='第一条新正文';
    assert(h.edit(next.value.slice(0,pos)+typed+next.value.slice(pos),{changes:[{from:pos,to:pos,insert:typed}]}));
    await h.finish();assert.equal(h.sent.length,1);
    const saved=(await get(b)).writingConstraints;assert.equal(saved.length,2);assert.deepEqual(saved[1],legacy);assert.equal(saved[0].content,'- '+typed);assert.equal(saved[0].enabled,true);
    h.dispose();checks++;
  }
  for(const h of allUis)for(const request of h.sent){assert.deepEqual(Object.keys(request).sort(),['bookId','expectedRevision','operation']);assert.equal(request.operation.action,'updateBook');assert(!Object.hasOwn(request.operation.patch,'constraintsEditor')&&!Object.hasOwn(request.operation.patch,'rawMarkdown'),'Raw editor journal never becomes a Host schema migration');if(Object.hasOwn(request.operation.patch,'writingConstraints'))assert.equal(f.validWritingConstraints(request.operation.patch.writingConstraints),true);}
  assert.equal(modelCalls,0);assert.equal(agentCreates,0);assert.equal(preferenceWrites,0);assert.equal(jobWrites,0);assert.deepEqual((await post('list')).modelSettings,preferences);
  const snapshots=new Map(savedBooks);await deactivate();await activate();for(const [id,expected]of snapshots)assert.deepEqual(await get(id),expected,'Exact durable JSON close/reopen including IDs/status/order');
  console.log(JSON.stringify({ok:true,contract:'markdown-real-http-json',sourceSha256,checks,booksReopened:savedBooks.size,clientMutationRequests:allUis.reduce((n,h)=>n+h.sent.length,0),maxConcurrentWrites:Math.max(0,...allUis.map(h=>h.maxInFlight)),modelCalls,agentCreates,jobWrites}));
} finally {
  for(const h of allUis)h.dispose();for(const gate of releases)gate.resolve();await Promise.allSettled(allUis.map(h=>bounded(h.controller.wait(),'cleanup')));await deactivate();
  const target=await realpath(root),parent=await realpath(tmpdir());assert.equal(dirname(target),parent);assert(basename(target).startsWith('inspiration-markdown-contract-'));await rm(target,{recursive:true,force:true});
}
