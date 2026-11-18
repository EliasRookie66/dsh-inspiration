import { randomUUID } from 'node:crypto';
import { createBook, mutateBook, validateBook, buildContext, makeProposal, cloneImportedBook, exportMarkdown } from './core.js';
import { optimizationContext, optimizationRewriteContext, ANALYSIS_LIMIT } from './optimization.js';

export const VERSION = '0.4.11';
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function checkId(id) { if (typeof id !== 'string' || !ID.test(id)) fail('VALIDATION', 'Invalid record id / 无效记录编号'); return id; }
const copy = value => structuredClone(value);
const now = () => new Date().toISOString();
const publicJob = j => copy(Object.fromEntries(Object.entries(j).filter(([k]) => !['request', 'controller', 'promise', 'settled'].includes(k))));
const unsettled = job => job.status === 'running' || (!!job.promise && !job.settled);

/** One single-layout atomic JSON unit per book. A corrupt book fails closed. */
export class NovelStore {
  constructor(backend) { this.backend = backend; this.units = new Map(); this.books = new Map(); this.chain = Promise.resolve(); this.closed = false; }
  async init() {
    this.index = await this.backend.kv.open({ name: 'ycx_moxu_index', version: 1, tables: ['books', 'jobs'], hasGlobal: false, layout: 'single' });
    const data = await this.index.loadAll();
    this.ids = new Set(); this.deletions = new Set();
    for (const [id, record] of Object.entries(data.tables.books || {})) {
      checkId(id);
      (record?.deleted === true ? this.deletions : this.ids).add(id);
    }
    this.jobs = new Map(Object.entries(data.tables.jobs || {}));
    for (const [id, job] of this.jobs) {
      checkId(id);
      if (!job || job.id !== id || typeof job.status !== 'string') fail('STORAGE', 'Invalid stored job / 任务记录损坏');
    }
    // An acknowledged deletion never comes back after a crash. A pending journal
    // hides the book and its jobs even if physical cleanup still cannot finish.
    for (const id of this.deletions) await this.finishDeletion(id);
    for (const [id, job] of this.jobs) {
      if (job.status === 'running' && !this.deletions.has(job.bookId)) {
        job.status = 'failed'; job.error = 'Generation interrupted by restart / 重启中断了生成，请重新发起'; job.updatedAt = now();
        await this.index.putRecord('jobs', id, job);
      }
    }
    return this;
  }
  serial(fn) {
    if (this.closed) return Promise.reject(Object.assign(new Error('Plugin is closing'), { code: 'CLOSED' }));
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }
  async load(id) {
    checkId(id);
    if (!this.ids.has(id)) fail('NOT_FOUND', 'Book not found / 未找到作品');
    if (!this.books.has(id)) {
      let unit = this.units.get(id);
      if (!unit) {
        unit = await this.backend.kv.open({ name: `ycx_moxu_book_${id.replaceAll('-', '_').toLowerCase()}`, version: 1, tables: ['books'], hasGlobal: false, layout: 'single' });
        this.units.set(id, unit);
      }
      const data = await unit.loadAll();
      const book = validateBook(data.tables.books?.[id]);
      if (book.id !== id) fail('STORAGE', 'Book identity mismatch / 存储作品编号不匹配');
      this.books.set(id, book);
    }
    return this.books.get(id);
  }
  async insert(book) {
    validateBook(book); checkId(book.id);
    if (this.ids.has(book.id) || this.deletions.has(book.id)) fail('CONFLICT', 'Book id already exists');
    const unit = await this.backend.kv.open({ name: `ycx_moxu_book_${book.id.replaceAll('-', '_').toLowerCase()}`, version: 1, tables: ['books'], hasGlobal: false, layout: 'single' });
    try {
      await unit.putRecord('books', book.id, book);
      await this.index.putRecord('books', book.id, { id: book.id });
    } catch (error) { await unit.close(); throw error; }
    this.units.set(book.id, unit); this.books.set(book.id, book); this.ids.add(book.id);
    return copy(book);
  }
  async commit(book) {
    validateBook(book);
    if (!this.ids.has(book.id)) fail('NOT_FOUND', 'Book not found / 未找到作品');
    await this.units.get(book.id).putRecord('books', book.id, book);
    this.books.set(book.id, book);
    return copy(book);
  }
  async remove(book) {
    // The index is the durable visibility boundary. Never erase manuscript data
    // before this intent succeeds; never report complete cleanup until all writes
    // succeed. The final index removal is last so init() can resume any phase.
    await this.index.putRecord('books', book.id, { id: book.id, deleted: true });
    this.deletions.add(book.id); this.ids.delete(book.id); this.books.delete(book.id);
    const complete = await this.finishDeletion(book.id);
    return { deleted: true, bookId: book.id, cleanupPending: !complete };
  }
  async finishDeletion(id) {
    checkId(id);
    if (!this.deletions.has(id)) fail('VALIDATION', 'Deletion intent required');
    try {
      let unit = this.units.get(id);
      if (!unit) {
        unit = await this.backend.kv.open({ name: `ycx_moxu_book_${id.replaceAll('-', '_').toLowerCase()}`, version: 1, tables: ['books'], hasGlobal: false, layout: 'single' });
        this.units.set(id, unit);
      }
      await unit.deleteRecord('books', id);
      for (const [jobId, job] of this.jobs) if (job.bookId === id) {
        await this.index.deleteRecord('jobs', jobId); this.jobs.delete(jobId);
      }
      await unit.close(); this.units.delete(id);
      await this.index.deleteRecord('books', id);
      this.deletions.delete(id);
      return true;
    } catch {
      // The requested deletion is committed; callers must see cleanupPending,
      // not a misleading failure that implies the old book is still writable.
      return false;
    }
  }
  async saveJob(job) {
    if (job.bookId && !this.ids.has(job.bookId)) fail('NOT_FOUND', 'Book not found / 未找到作品');
    const value = { ...publicJob(job), request: job.request };
    await this.index.putRecord('jobs', job.id, value);
    this.jobs.set(job.id, value);
    if (this.jobs.size > 40) {
      const old = [...this.jobs.values()].filter(j => j.status !== 'running' && j.id !== job.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const j of old.slice(0, this.jobs.size - 40)) {
        await this.index.deleteRecord('jobs', j.id); this.jobs.delete(j.id);
      }
    }
  }
  async close() {
    this.closed = true; await this.chain;
    await Promise.all([...this.units.values()].map(unit => unit.close()));
    if (this.index) await this.index.close();
  }
}

/** Shared application boundary for UI and agent tool; approval is a distinct human action. */
export class NovelService {
  constructor(store, { getModel, runModel, modelPreferences = null }) {
    this.store = store; this.getModel = getModel; this.runModel = runModel; this.modelPreferences = modelPreferences; this.live = new Map(); this.closed = false;
  }
  currentModel() { return copy(this.modelPreferences ? this.modelPreferences.effective() : this.getModel()); }
  requireRevision(book, expected) {
    if (!Number.isSafeInteger(expected) || expected !== book.revision) fail('CONFLICT', 'Saved version changed. Keep your draft and reload before merging. / 保存版本已变化，请保留本地稿并重新载入后合并。');
  }
  async dispatch(input, { user = false, signal } = {}) {
    signal?.throwIfAborted();
    if (this.closed) fail('CLOSED', 'Plugin is closing / 插件正在关闭');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('VALIDATION', 'Expected an operation object');
    const { action } = input;
    // Catalog discovery does not take the manuscript write lock. Provider
    // metadata can be slow, and must not delay saves or a job's final commit.
    if (action === 'models') {
      if (!this.modelPreferences) fail('MODEL', 'Model selection is unavailable / 模型选择暂不可用');
      return this.modelPreferences.catalog({ ...(input.provider !== undefined ? { provider: input.provider } : {}), ...(input.model !== undefined ? { model: input.model } : {}) }, signal);
    }
    if (action === 'job' || action === 'cancel') {
      const id = checkId(input.jobId);
      const job = this.live.get(id) || this.store.jobs.get(id);
      if (!job || !this.store.ids.has(job.bookId)) fail('NOT_FOUND', 'Job not found / 未找到任务');
      if (action === 'cancel' && job.status === 'running') {
        this.live.get(id)?.controller.abort(new Error('Cancelled by author / 作者已取消'));
      }
      return copy(publicJob(job));
    }
    return this.store.serial(async () => {
      signal?.throwIfAborted();
      switch (action) {
        case 'list': {
          const books = [];
          for (const id of this.store.ids) {
            const book = await this.store.load(id);
            books.push({ id, title: book.title, chapterCount: book.chapters.length, updatedAt: book.updatedAt });
          }
          return { books, model: this.currentModel(), modelSettings: this.modelPreferences?.snapshot() ?? null, version: VERSION, cleanupPending: this.store.deletions.size, activeJobs: [...this.live.values()].filter(j => j.status === 'running' && this.store.ids.has(j.bookId)).map(publicJob) };
        }
        case 'setModel': {
          if (!this.modelPreferences) fail('MODEL', 'Model selection is unavailable / 模型选择暂不可用');
          const modelSettings = await this.modelPreferences.save(input.selection, input.expectedRevision, signal);
          return { modelSettings, model: this.currentModel() };
        }
        case 'delete': {
          const book = await this.store.load(input.bookId);
          this.requireRevision(book, input.expectedRevision);
          if (input.confirmTitle !== book.title) fail('VALIDATION', 'Type the exact saved book title to confirm deletion / 请完整输入已保存的作品名称以确认删除');
          if ([...this.live.values()].some(j => j.bookId === book.id && unsettled(j))) fail('BUSY', 'Wait for generation to finish or cancel it first / 请先等待生成完成，或取消任务并等其结束，再删除作品');
          const result = await this.store.remove(book);
          for (const [id, job] of this.live) if (job.bookId === book.id) this.live.delete(id);
          return result;
        }
        case 'create': return this.store.insert(createBook(input.title));
        case 'import': {
          if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 40 * 1024 * 1024) fail('VALIDATION', 'Import is too large / 导入不得超过 40 MiB');
          let value; try { value = JSON.parse(input.text); } catch { fail('VALIDATION', 'Invalid JSON / 无效 JSON'); }
          return this.store.insert(cloneImportedBook(value));
        }
        case 'get': return copy(await this.store.load(input.bookId));
        case 'mutate': {
          const book = await this.store.load(input.bookId);
          this.requireRevision(book, input.expectedRevision);
          const op = input.operation;
          if (!op || typeof op.action !== 'string') fail('VALIDATION', 'Missing mutation operation');
          const changesChapterOrder = op.action === 'moveChapter' || op.action === 'deleteChapter';
          if (!user && (changesChapterOrder || ['acceptProposal', 'restoreChapter', 'acceptRevisionHunk', 'rejectRevisionHunk', 'acceptRevisionAll'].includes(op.action))) fail('AUTHOR_ONLY', 'The author must confirm this in the writing panel. / 此操作须由作者在写作面板确认。');
          // Providers/tools can propose text but cannot fabricate completed generation records.
          if (op.action === 'addProposal') fail('AUTHOR_ONLY', 'Use generate to create a revision proposal');
          if (changesChapterOrder && [...this.live.values()].some(j => j.bookId === book.id && unsettled(j))) {
            fail('BUSY', 'Wait for generation to settle before moving or deleting a chapter / 请先等待生成完成，或取消任务并等其结束，再移动或删除章节');
          }
          return this.store.commit(mutateBook(book, op));
        }
        case 'context': return (input.mode === 'revise' ? optimizationContext : buildContext)(await this.store.load(input.bookId), input.chapterId, {
          mode: input.mode, instruction: input.instruction ?? '', selection: input.selection ?? null,
        });
        case 'export': {
          const book = await this.store.load(input.bookId);
          const stem = book.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'novel';
          if (input.format === 'markdown') return { filename: `${stem}.md`, mime: 'text/markdown;charset=utf-8', text: exportMarkdown(book) };
          if (input.format === 'json') return { filename: `${stem}.inspiration.json`, mime: 'application/json', text: JSON.stringify(book, null, 2) };
          fail('VALIDATION', 'Unknown export format'); break;
        }
        case 'generate': {
          const book = await this.store.load(input.bookId);
          this.requireRevision(book, input.expectedRevision);
          if ([...this.live.values()].some(j => j.status === 'running' && j.bookId === book.id)) fail('BUSY', 'This book already has an active generation / 本作品已有生成任务');
          if ([...this.live.values()].filter(j => j.status === 'running').length >= 3) fail('BUSY', 'At most three concurrent generations / 最多同时生成三项');
          if (!['draft', 'continue', 'polish', 'summary', 'revise'].includes(input.mode)) fail('VALIDATION', 'Invalid generation mode');
          if (this.modelPreferences && input.expectedModelRevision !== undefined && input.expectedModelRevision !== this.modelPreferences.snapshot().revision) fail('MODEL_CONFLICT', 'Writing model settings changed; reload the model selection before generating / 写作模型已被其他页面修改，请重新载入模型选择后生成');
          const source = copy(book), options = { mode: input.mode, instruction: input.instruction || '', selection: input.selection || null };
          const context = (options.mode === 'revise' ? optimizationContext : buildContext)(source, input.chapterId, options);
          // Freeze exact intent immediately after validation, before asynchronous
          // adapter metadata lookup or a caller can mutate its selection object.
          options.selection = copy(options.selection);
          const chapter = source.chapters.find(c => c.id === input.chapterId);
          const model = this.modelPreferences ? await this.modelPreferences.resolve(signal) : this.currentModel();
          signal?.throwIfAborted();
          if (!model?.provider || !model?.model) fail('MODEL', 'Choose a model in Inspiration or set a DSH default / 请在灵感中选择模型，或设置 DSH 默认模型');
          const job = {
            id: randomUUID(), bookId: source.id, chapterId: chapter.id, mode: options.mode, sourceRevision: chapter.revision, ...(options.mode === 'polish' ? { selection: copy(options.selection) } : {}), model: copy(model), ...(this.modelPreferences ? { modelSettingsRevision: this.modelPreferences.snapshot().revision } : {}), status: 'running', text: '', createdAt: now(), updatedAt: now(),
            ...(options.mode === 'revise' ? { phase: 'analyzing', analysis: '' } : {}),
            request: { ...options, model, prompt: context.prompt, report: context.report, ...(context.basePrompt ? { basePrompt: context.basePrompt } : {}), sourceRevision: chapter.revision, sourceBody: chapter.body },
            controller: new AbortController(),
          };
          await this.store.saveJob(job); // Never issue a paid call before durable request provenance.
          this.live.set(job.id, job);
          job.promise = this.run(job, source, options, context);
          return { jobId: job.id };
        }
        default: fail('VALIDATION', 'Unknown operation / 未知操作');
      }
    });
  }
  async run(job, source, options, context) {
    let timer;
    try {
      timer = setTimeout(() => job.controller.abort(new Error('Generation timed out after 15 minutes / 生成超过15分钟')), 15 * 60 * 1000);
      timer.unref?.();
      let finalContext = context;
      if (options.mode === 'revise') {
        const analyzed = await this.runModel({
          model: copy(job.request.model), prompt: context.prompt, signal: job.controller.signal,
          jobId: job.id + '-analysis', maxTokens: 1024,
          onText: text => { job.analysis = text; job.updatedAt = now(); if (text.length > ANALYSIS_LIMIT) job.controller.abort(new Error('需求分析超过 2000 字符安全上限，已停止，正文未变')); },
        });
        job.controller.signal.throwIfAborted();
        finalContext = optimizationRewriteContext(context, analyzed.text);
        job.analysis = analyzed.text; job.phase = 'optimizing'; job.text = ''; job.updatedAt = now();
        if (analyzed.sessionId) job.analysisSessionId = analyzed.sessionId;
        job.request.rewritePrompt = finalContext.prompt; job.request.rewriteReport = finalContext.report;
        // A distinct durable provenance boundary for the SECOND paid call. If
        // persistence fails or the author cancels, never proceed to rewriting.
        await this.store.serial(() => this.store.saveJob(job));
        job.controller.signal.throwIfAborted();
      }
      const result = await this.runModel({
        model: copy(job.request.model), prompt: finalContext.prompt, signal: job.controller.signal,
        jobId: options.mode === 'revise' ? job.id + '-revise' : job.id, maxTokens: options.mode === 'summary' ? 2048 : 8192,
        onText: text => { job.text = text; job.updatedAt = now(); if (text.length > 200000) job.controller.abort(new Error('Output exceeds 200000 characters')); },
      });
      job.controller.signal.throwIfAborted();
      if (!result.text?.trim()) fail('EMPTY', 'The model returned no manuscript text / 模型没有返回正文');
      job.text = result.text;
      if (result.sessionId) job.sessionId = result.sessionId;
      const proposal = makeProposal(source, job.chapterId, options, result.text, finalContext.report, options.mode === 'revise' ? { analysis: job.analysis } : {});
      await this.store.serial(async () => {
        job.controller.signal.throwIfAborted();
        const current = await this.store.load(job.bookId);
        await this.store.commit(mutateBook(current, { action: 'addProposal', proposal }));
        job.proposalId = proposal.id; job.status = 'completed'; if (options.mode === 'revise') job.phase = 'review'; job.updatedAt = now();
        await this.store.saveJob(job);
      });
    } catch (error) {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = String(job.controller.signal.aborted ? job.controller.signal.reason?.message || 'Cancelled' : error?.message || error).slice(0, 2000);
      job.updatedAt = now();
      try { await this.store.serial(() => this.store.saveJob(job)); } catch (storageError) { job.error += `; persistence failed: ${storageError.message}`; }
    } finally {
      clearTimeout(timer); job.settled = true;
      // Keep recent in-memory failures (including an unpersisted error) inspectable.
      const done = [...this.live.values()].filter(j => j.settled).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const old of done.slice(0, Math.max(0, done.length - 20))) this.live.delete(old.id);
    }
  }
  async close() {
    this.closed = true;
    const pending = [...this.live.values()].filter(unsettled);
    for (const j of pending) j.controller.abort(new Error('Plugin unloaded / 插件已停用'));
    await Promise.allSettled(pending.map(j => j.promise));
    try { await this.store.close(); }
    finally { await this.modelPreferences?.close(); }
  }
}
