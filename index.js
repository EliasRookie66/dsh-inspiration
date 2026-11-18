import { defineTool } from '@deepseek-ai/dsh-tools';
import { NovelStore, NovelService } from './service.js';
import { makeModelRunner } from './model.js';
import { API_PATH, makeHandler } from './http.js';
import { ModelPreferences } from './selection.js';

export const inject = ['storage', 'webServer', 'connection', 'llm', 'agentDefaultModel', 'agentLoop', 'sessions', 'tools'];
export async function apply(ctx) {
  const backend = ctx.storage.backend.get('json');
  if (!backend.kv) throw new Error('inspiration requires the JSON KV storage backend');
  const store = new NovelStore(backend);
  const preferences = new ModelPreferences(backend, ctx.llm, () => ctx.agentDefaultModel.currentSelection());
  let service;
  // Own partial initialization too: an invalid settings record must not leave
  // live KV handles behind and prevent the author from loading the plugin again.
  ctx.effect(() => async () => {
    if (service) await service.close();
    else { try { await store.close(); } finally { await preferences.close(); } }
  });
  await store.init();
  await preferences.init();
  service = new NovelService(store, {
    getModel: () => ctx.agentDefaultModel.currentSelection(),
    modelPreferences: preferences,
    runModel: makeModelRunner(ctx),
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API_PATH, handler: makeHandler(service, () => ctx.webServer.getOrigin(), ctx.connection) }));
  ctx.tools.register(defineTool({
    name: 'inspiration_novel',
    description: `Manage the author's inspiration long-fiction workspace. All actions use durable books and optimistic revisions. Start with list then get. For mutate pass {bookId,expectedRevision,operation:{action,...}}. Operations: updateBook(patch), addChapter(title), updateChapter(chapterId,patch), saveCard(card), createCard(card with a fresh caller-generated UUID id; create-only, refuses existing identifiers), removeCard(cardId), updateProposal(proposalId,text), rejectProposal(proposalId), pruneArchive() only upon an explicit author request after recommending a JSON backup (irreversibly removes resolved proposals and all but the latest five histories per chapter). Book-level writing constraints use updateBook.patch.writingConstraints, a complete ordered array of {id:UUID,category:nonempty string up to 80 UTF-16 characters,content:nonempty string up to 4000 characters,enabled:boolean}, at most 64 entries. Preserve unrelated entries when editing; only change constraints on an explicit author request, never add test constraints to a real book. Enabled saved constraints enter every generation prompt in full, including both revise stages; disabled entries do not. Insufficient context budget rejects generation rather than dropping constraints. Running tasks retain their start-time constraints; changes apply to new tasks. Generation: {bookId,chapterId,expectedRevision,mode:draft|continue|polish|summary|revise,instruction,selection:{start,end,text}|null}; UTF-16 offsets refer to exact saved body. Generate returns a jobId; query job or cancel explicitly, do not busy-poll. AI always creates a proposal, not manuscript edits. Polish makes one selected-model call for the exact saved selection (optional author requirements); new public jobs expose detached mode/sourceRevision/selection for result-first, original-below inline review. A selection popup is not consent to call a model or accept text; generation and author confirmation remain explicit. Revise requires a nonempty author instruction and complete saved chapter; it makes two automatic selected-model calls (brief requirement analysis, then targeted full-chapter optimization), preserving the source until the author reviews individual hunks. acceptRevisionHunk and rejectRevisionHunk {proposalId,hunkId}, acceptRevisionAll {proposalId} (atomic approval of this result's pending hunks only; retains previously rejected parts), acceptProposal and restoreChapter are author-only; ask the user to review in the inspiration panel, never bypass via HTTP or filesystem. Model selection: list includes modelSettings {revision,selection} and effective model. models {provider?,model?} reads registered routes and advertised reasoning efforts; setModel {selection:null|{provider,model,reasoningEffort?},expectedRevision} explicitly saves plugin-only preferences, never changes the DSH global default. Only change preferences when the author asks; adding the feature is not consent to pick a different model. A running job retains its job.model snapshot. Pass optional expectedModelRevision from list.modelSettings.revision to reject a concurrently changed preference before generating (MODEL_CONFLICT); this revision does not freeze the global default in follow mode. Context returns exact prompt/report. Export supports json/markdown; import validates JSON and creates a new book. Delete uses {bookId,expectedRevision,confirmTitle}: only on an explicit author request to delete that specific book, after explaining irreversible deletion and recommending a JSON backup; use the exact current title and revision from get, never infer permission from a feature request or a demo label. Delete removes the whole book and plugin job records, not downloaded backups or DSH model-session logs; cleanupPending means residual cleanup retries on plugin restart, not complete erasure. Never edit manuscript/canon unless the user asks.`,
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'create', 'get', 'mutate', 'delete', 'context', 'generate', 'job', 'cancel', 'export', 'import', 'models', 'setModel'] },
      payload: { type: 'object', additionalProperties: true, description: 'Action-specific fields; no action field here.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ action, payload }, exec) {
      exec.signal.throwIfAborted();
      return service.dispatch({ ...(payload || {}), action }, { user: false, signal: exec.signal });
    },
  }));
}
