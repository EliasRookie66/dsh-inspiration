/* 灵感 — independent, native React client. No client package imports or second DOM root. */
window.__ModuleLoader__.load({
  id: '@ycx/dsh-inspiration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useLayoutEffect, useCallback, useSyncExternalStore } = React;
    const NS = 'ycx-inspiration';
    const STORAGE = 'ycx-moxu:draft:v1:';
    const JOB_STORAGE = 'ycx-moxu:job:v1:';
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const chapterFields = c => c ? ({ title: c.title, outline: c.outline, body: c.body, status: c.status, summary: c.summary }) : null;
    const bookFields = b => ({ title: b.title, premise: b.premise, outline: b.outline, style: b.style, contextBudget: String(b.contextBudget) });
    const cardFields = c => c ? ({ id: c.id, kind: c.kind, title: c.title, content: c.content, status: c.status, pinned: c.pinned, fromChapter: String(c.fromChapter), toChapter: c.toChapter == null ? '' : String(c.toChapter), tags: c.tags.join(', ') }) : null;
    const blankCard = () => ({ kind: 'character', title: '', content: '', status: 'proposed', pinned: false, fromChapter: '1', toChapter: '', tags: '' });
    const chapterOf = w => w?.book.chapters.find(c => c.id === w.chapterId);
    const proposalOf = w => w?.book.proposals.find(p => p.id === w.candidateId);
    const dirty = w => w ? ({
      chapter: !equal(w.chapter, w.baseChapter),
      settings: !equal(w.settings, w.baseSettings),
      card: !!w.card && !equal(w.card, w.baseCard),
      candidate: w.candidateId != null && w.candidate !== w.baseCandidate,
    }) : {};
    const isDirty = w => Object.values(dirty(w)).some(Boolean);
    const patchOf = (base, value) => Object.fromEntries(Object.keys(value).filter(k => !equal(base?.[k], value[k])).map(k => [k, value[k]]));
    const proposalsFor = (b, id) => b.proposals.filter(p => p.chapterId === id).slice().reverse();
    function workspace(book, chapterId) {
      const chapter = book.chapters.find(c => c.id === chapterId) || book.chapters[0];
      const fields = chapterFields(chapter);
      const proposals = proposalsFor(book, chapter?.id);
      const proposal = proposals.find(p => p.state === 'ready') || proposals[0];
      return { book, chapterId: chapter?.id || '', chapter: fields, baseChapter: fields,
        settings: bookFields(book), baseSettings: bookFields(book), card: null, baseCard: null,
        candidateId: proposal?.id || '', candidate: proposal?.text || '', baseCandidate: proposal?.text || '' };
    }
    // A background proposal may advance book.revision without touching the author's drafts.
    // Only adopt such a revision if ALL locally edited field groups still match their baseline.
    function conflictingFields(w, next) {
      const d = dirty(w), out = [];
      if (d.chapter && !equal(w.baseChapter, chapterFields(next.chapters.find(c => c.id === w.chapterId)))) out.push('chapter');
      if (d.settings && !equal(w.baseSettings, bookFields(next))) out.push('settings');
      if (d.card && w.card?.id && !equal(w.baseCard, cardFields(next.cards.find(c => c.id === w.card.id)))) out.push('card');
      const candidate = next.proposals.find(p => p.id === w.candidateId);
      if (d.candidate && (!candidate || candidate.state !== 'ready' || candidate.text !== w.baseCandidate)) out.push('candidate');
      return out;
    }
    function mergeWorkspace(w, next, cleared, rebase = false) {
      const d = dirty(w), fresh = workspace(next, w.chapterId);
      for (const [kind, field, base] of [['chapter', 'chapter', 'baseChapter'], ['settings', 'settings', 'baseSettings']]) {
        if (d[kind] && cleared !== kind) { fresh[field] = w[field]; if (!rebase) fresh[base] = w[base]; }
      }
      if (w.card && cleared !== 'card') {
        const server = w.card.id ? cardFields(next.cards.find(c => c.id === w.card.id)) : blankCard();
        fresh.card = d.card ? w.card : server;
        fresh.baseCard = rebase || !d.card ? server : w.baseCard;
      }
      const proposal = next.proposals.find(p => p.id === w.candidateId && p.chapterId === fresh.chapterId);
      if (proposal) {
        fresh.candidateId = proposal.id;
        fresh.candidate = d.candidate && cleared !== 'candidate' ? w.candidate : proposal.text;
        fresh.baseCandidate = d.candidate && cleared !== 'candidate' && !rebase ? w.baseCandidate : proposal.text;
      }
      return fresh;
    }
    function recoveryPayload(w) {
      const d = dirty(w), data = { version: 1, bookId: w.book.id, bookRevision: w.book.revision, chapterId: w.chapterId, savedAt: new Date().toISOString(), dirty: d };
      if (d.chapter) { data.chapter = w.chapter; data.baseChapter = w.baseChapter; }
      if (d.settings) { data.settings = w.settings; data.baseSettings = w.baseSettings; }
      if (d.card) { data.card = w.card; data.baseCard = w.baseCard; }
      if (d.candidate) { data.candidateId = w.candidateId; data.candidate = w.candidate; data.baseCandidate = w.baseCandidate; }
      return data;
    }
    function validRecovery(r, bookId) {
      if (!r || r.version !== 1 || r.bookId !== bookId || !r.dirty || typeof r.chapterId !== 'string') return false;
      if (r.dirty.chapter && (!r.chapter || !r.baseChapter || !['title', 'outline', 'body', 'summary', 'status'].every(k => typeof r.chapter[k] === 'string' && typeof r.baseChapter[k] === 'string'))) return false;
      if (r.dirty.settings && (!r.settings || !r.baseSettings || !['title', 'premise', 'outline', 'style', 'contextBudget'].every(k => typeof r.settings[k] === 'string' && typeof r.baseSettings[k] === 'string'))) return false;
      if (r.dirty.card && (!r.card || !['kind', 'title', 'content', 'status', 'fromChapter', 'toChapter', 'tags'].every(k => typeof r.card[k] === 'string') || typeof r.card.pinned !== 'boolean')) return false;
      if (r.dirty.candidate && !['candidateId', 'candidate', 'baseCandidate'].every(k => typeof r[k] === 'string')) return false;
      return true;
    }
    // Native textarea values normalize CRLF and CR to LF. Keep the saved body
    // unchanged outside the edit (except a CR/LF splice boundary, see below),
    // and map selections to the original UTF-16 string for exact host checks.
    const textareaValue = value => value.replace(/\r\n?/g, '\n');
    function sourceOffsets(source, start, end) {
      let normalized = 0, rawStart = null, rawEnd = null;
      for (let raw = 0; raw <= source.length; raw++) {
        if (normalized === start && rawStart === null) rawStart = raw;
        if (normalized === end) { rawEnd = raw; break; }
        if (raw === source.length) break;
        if (source[raw] === '\r' && source[raw + 1] === '\n') raw++;
        normalized++;
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || rawStart === null || rawEnd === null) return null;
      return { start: rawStart, end: rawEnd, text: source.slice(rawStart, rawEnd) };
    }
    // Selection intents contain only immutable scalar values. Native offsets are
    // mapped once; neither a later DOM selection nor a repeated phrase can retarget it.
    const textBoundary = (text, offset) => !(offset > 0 && offset < text.length &&
      (text[offset - 1] === '\r' && text[offset] === '\n' ||
        /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])));
    function validPolishRange(body, range) {
      return typeof body === 'string' && !!range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) &&
        range.start >= 0 && range.end > range.start && range.end <= body.length &&
        textBoundary(body, range.start) && textBoundary(body, range.end) &&
        typeof range.text === 'string' && body.slice(range.start, range.end) === range.text;
    }
    function capturePolishSnapshot(w, start, end) {
      const chapter = chapterOf(w), body = w?.chapter?.body;
      if (!chapter || typeof body !== 'string') return null;
      const range = sourceOffsets(body, start, end);
      if (!validPolishRange(body, range)) return null;
      return Object.freeze({ bookId: w.book.id, bookRevision: w.book.revision, chapterId: w.chapterId,
        chapterRevision: chapter.revision, body, ...range });
    }
    function polishIntentProblem(w, snapshot, { recovery = null, conflict = null, busy = false, running = false, unavailable = false, modelProblem = '', intent = snapshot, composing = false } = {}) {
      if (composing) return 'polishComposing';
      if (busy) return 'working';
      if (unavailable) return 'bookMissing';
      const chapter = chapterOf(w);
      if (!snapshot || intent !== snapshot || !chapter || w.book.id !== snapshot.bookId || w.book.revision !== snapshot.bookRevision ||
          w.chapterId !== snapshot.chapterId || chapter.revision !== snapshot.chapterRevision || !validPolishRange(snapshot.body, snapshot)) return 'selectionChanged';
      if (recovery) return 'manageRecovery';
      if (conflict || isDirty(w)) return 'saveFirst';
      if (chapter.body !== snapshot.body || w.chapter?.body !== snapshot.body) return 'selectionChanged';
      if (running) return 'polishBusy';
      return modelProblem;
    }
    function polishView(w, record) {
      const chapter = chapterOf(w);
      if (!chapter || record?.mode !== 'polish' || record.chapterId !== w.chapterId ||
          record.bookId != null && record.bookId !== w.book.id || typeof record.text !== 'string' ||
          !Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 1) return null;
      const hasSource = typeof record.sourceBody === 'string';
      // Public jobs deliberately have no sourceBody. Resume only against the
      // exact saved chapter revision; never find/re-target matching prose.
      if (!hasSource && chapter.revision !== record.sourceRevision) return null;
      const source = hasSource ? record.sourceBody : chapter.body;
      if (!validPolishRange(source, record.selection)) return null;
      const { start, end, text: original } = record.selection;
      const prefix = source.slice(0, start), suffix = source.slice(end), newText = record.text;
      const durable = hasSource && w.book.proposals.some(p => p.id === record.id && JSON.stringify(p) === JSON.stringify(record));
      const stale = chapter.revision !== record.sourceRevision || chapter.body !== source;
      return { source, prefix, newText, original, suffix, preview: prefix + newText + suffix, durable, stale,
        pieces: [{ kind: 'unchanged', text: prefix }, { kind: 'polish', text: newText, before: original }, { kind: 'unchanged', text: suffix }] };
    }
    function polishDisplayRecord(w, proposal, job) {
      const active = job?.mode === 'polish' && job.bookId === w?.book.id && job.chapterId === w?.chapterId &&
        (job.status === 'running' || job.status === 'completed' && !w?.book.proposals.some(p => p.id === job.proposalId));
      return active ? job : proposal?.mode === 'polish' ? proposal : null;
    }
    function polishPreviewDecision(w, record, originalKey, { recovery = null, conflict = null } = {}) {
      const view = polishView(w, record);
      if (!view) return { key: null, visible: false, deferred: false };
      const key = JSON.stringify([w.book.id, w.chapterId, record.id, 'polish']);
      const requested = originalKey !== key, blocked = isDirty(w) || !!recovery || !!conflict;
      const explicit = originalKey === 'preview:' + key;
      const reviewable = view.durable ? record.state === 'ready' : ['running', 'completed'].includes(record.status);
      return { key, visible: requested && !blocked && (explicit || reviewable && !view.stale), deferred: requested && blocked };
    }
    function polishActionSnapshot(w, proposal) {
      if (!w || proposal?.mode !== 'polish' || !polishView(w, proposal)?.durable) return null;
      return Object.freeze({ ...reviewSnapshot(w, { proposalId: proposal.id }), candidateId: w.candidateId,
        chapter: JSON.stringify(chapterOf(w)) });
    }
    function polishActionProblem(w, snapshot, { recovery = null, conflict = null, busy = false, unavailable = false, accept = true } = {}) {
      if (busy) return 'working';
      if (unavailable) return 'bookMissing';
      if (snapshot == null || !reviewIsCurrent(w, snapshot) || w.candidateId !== snapshot.candidateId ||
          JSON.stringify(chapterOf(w)) !== snapshot.chapter) return 'confirmChanged';
      if (recovery) return 'manageRecovery';
      if (conflict || isDirty(w)) return 'saveFirst';
      const proposal = w.book.proposals.find(p => p.id === snapshot.proposalId), view = polishView(w, proposal);
      if (!view || !view.durable || proposal.state !== 'ready') return 'confirmChanged';
      if (accept && view.stale) return 'stale';
      return '';
    }
    function selectionPopupDecision({ start, end, composing = false, key = '', event = 'select' }) {
      if (composing || key === 'Escape' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return 'close';
      if (event === 'mouseup' || event === 'keyup' && (key === 'Shift' || key.startsWith('Arrow') || ['Home', 'End', 'a', 'A'].includes(key))) return 'open';
      return 'keep';
    }
    function selectionPopupPosition({ x, y, rect, viewportWidth, viewportHeight, width = 320, height = 132, margin = 8 }) {
      if (!(viewportWidth > 0 && viewportHeight > 0)) return null;
      const leftEdge = Math.max(margin, rect?.left ?? margin), rightEdge = Math.min(viewportWidth - margin, rect?.right ?? viewportWidth - margin);
      const topEdge = Math.max(margin, rect?.top ?? margin), bottomEdge = Math.min(viewportHeight - margin, rect?.bottom ?? viewportHeight - margin);
      if (rightEdge <= leftEdge || bottomEdge <= topEdge) return null;
      const popupWidth = Math.max(0, Math.min(width, viewportWidth - margin * 2));
      const popupHeight = Math.max(0, Math.min(height, viewportHeight - margin * 2));
      const anchorX = Number.isFinite(x) ? x : leftEdge + 12;
      const anchorY = Number.isFinite(y) ? y : topEdge + Math.min(32, (bottomEdge - topEdge) / 2);
      const below = anchorY + 12;
      return { left: Math.max(margin, Math.min(anchorX, viewportWidth - popupWidth - margin)),
        top: Math.max(margin, Math.min(below + popupHeight <= viewportHeight - margin ? below : anchorY - popupHeight - 12, viewportHeight - popupHeight - margin)),
        width: popupWidth, maxHeight: Math.max(0, viewportHeight - margin * 2) };
    }
    function applyTextareaEdit(source, value) {
      const before = textareaValue(source), after = textareaValue(value);
      if (before === after) return source;
      let start = 0, tail = 0;
      while (start < before.length && start < after.length && before[start] === after[start]) start++;
      while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
      const span = sourceOffsets(source, start, before.length - tail);
      const newline = source.match(/\r\n|\r|\n/)?.[0] || '\n';
      const inserted = after.slice(start, after.length - tail).replace(/\n/g, newline);
      // Two separate logical newlines can meet after a deletion or insertion:
      // a preserved trailing CR followed by an LF must not collapse into one CRLF.
      const join = (left, right) => left.endsWith('\r') && right.startsWith('\n') ? left + '\n' + right : left + right;
      return join(join(source.slice(0, span.start), inserted), source.slice(span.end));
    }
    function reviewSnapshot(w, operation) {
      return { bookId: w.book.id, revision: w.book.revision, chapterId: w.chapterId,
        proposalId: operation.proposalId || null,
        proposal: operation.proposalId ? JSON.stringify(w.book.proposals.find(p => p.id === operation.proposalId)) : null };
    }
    function reviewIsCurrent(w, snapshot) {
      return !!w && w.book.id === snapshot.bookId && w.book.revision === snapshot.revision && w.chapterId === snapshot.chapterId &&
        (!snapshot.proposalId || JSON.stringify(w.book.proposals.find(p => p.id === snapshot.proposalId)) === snapshot.proposal);
    }
    function managementSnapshot(w) {
      return { bookId: w.book.id, revision: w.book.revision, title: w.book.title };
    }
    function managementIsCurrent(w, snapshot) {
      return !!w && !!snapshot && w.book.id === snapshot.bookId && w.book.revision === snapshot.revision && w.book.title === snapshot.title;
    }
    function managementProblem(w, snapshot, recovery, conflict) {
      if (!managementIsCurrent(w, snapshot)) return 'confirmChanged';
      if (recovery?.bookId === snapshot.bookId) return 'manageRecovery';
      if (isDirty(w) || conflict) return 'manageUnsaved';
      return '';
    }
    function deletionProblem(w, snapshot, typedTitle, { recovery = null, conflict = null, jobs = [] } = {}) {
      const problem = managementProblem(w, snapshot, recovery, conflict);
      if (problem) return problem;
      if (jobs.some(j => j?.bookId === snapshot.bookId && (j.status === 'running' || j.settled === false))) return 'deleteBusy';
      if (typeof typedTitle !== 'string' || typedTitle !== snapshot.title) return 'deleteTypeTitle';
      return '';
    }
    // A response for another book, a failed response, or an ambiguous receipt
    // must never authorize local cleanup. Keep this independent of rendering.
    function deletionReceipt(snapshot, result) {
      return typeof snapshot?.bookId === 'string' && snapshot.bookId.length > 0 && result?.deleted === true && result.bookId === snapshot.bookId && typeof result.cleanupPending === 'boolean';
    }
    function afterBookDeletion(state, snapshot, result) {
      if (!deletionReceipt(snapshot, result)) return state;
      const id = snapshot.bookId, active = state.workspace?.book.id === id;
      return { ...state, books: state.books.filter(b => b.id !== id),
        workspace: active ? null : state.workspace,
        selection: active ? null : state.selection, context: active ? null : state.context,
        job: state.job?.bookId === id ? null : state.job,
        recovery: state.recovery?.bookId === id ? null : state.recovery,
        pendingLatest: state.pendingLatest?.id === id ? null : state.pendingLatest,
        activeJobs: state.activeJobs.filter(j => j.bookId !== id),
        drafts: new Map([...state.drafts].filter(([bookId]) => bookId !== id)),
        rememberedJobs: new Map([...state.rememberedJobs].filter(([bookId]) => bookId !== id)) };
    }
    function bookIsAvailable(bookId, deleted, unavailable) {
      return !deleted.has(bookId) && !unavailable.has(bookId);
    }
    function markBookUnavailable(state, bookId, sequence) {
      return { ...state, unavailable: new Map([...state.unavailable, [bookId, sequence]]),
        pendingLatest: state.pendingLatest?.id === bookId ? null : state.pendingLatest };
    }
    function reconcileBookAvailability(unavailable, books, sequence) {
      const present = new Set(books.map(book => book.id));
      return new Map([...unavailable].filter(([id, observed]) => sequence <= observed || !present.has(id)));
    }
    // Dependency-injected follow-up only: never retries deletion. A failed list
    // OR survivor load leaves the acknowledged deletion successful but flagged.
    async function refreshAfterBookDeletion(refreshList, hasCurrentBook, openBook) {
      try {
        const data = await refreshList();
        if (!data) return false;
        if (!hasCurrentBook() && data.books.length) return await openBook(data.books[0].id) === true;
        return true;
      } catch { return false; }
    }
    // Review offsets always address the ORIGINAL saved UTF-16 body, never a
    // progressively edited preview. Do not normalize whitespace or line endings.
    function revisionView(proposal) {
      const validText = value => typeof value === 'string' && value.length <= 200000 && !/[\uD800-\uDFFF]/u.test(value);
      if (proposal?.mode !== 'revise' || !validText(proposal.sourceBody) || !validText(proposal.text) ||
          !Number.isSafeInteger(proposal.sourceRevision) || proposal.sourceRevision < 1 ||
          !proposal.review || typeof proposal.review.analysis !== 'string' || !Array.isArray(proposal.review.hunks) || proposal.review.hunks.length > 256) return null;
      const source = proposal.sourceBody, ids = new Set(), pieces = [], counts = { pending: 0, accepted: 0, rejected: 0 };
      let cursor = 0, target = '', saved = '', preview = '', previous = null;
      const boundary = offset => !(offset > 0 && offset < source.length &&
        (source[offset - 1] === '\r' && source[offset] === '\n' ||
          /[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset])));
      for (const item of proposal.review.hunks) {
        if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
            !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < cursor || item.end < item.start || item.end > source.length ||
            !boundary(item.start) || !boundary(item.end) || !validText(item.before) || !validText(item.after) ||
            source.slice(item.start, item.end) !== item.before || item.before === item.after ||
            typeof item.state !== 'string' || !Object.hasOwn(counts, item.state) || previous && previous.start === item.start) return null;
        ids.add(item.id); counts[item.state]++;
        const unchanged = source.slice(cursor, item.start);
        if (unchanged) pieces.push({ kind: 'unchanged', text: unchanged });
        const shown = item.state === 'rejected' ? item.before : item.after;
        pieces.push({ kind: 'hunk', text: shown, hunk: item });
        target += unchanged + item.after;
        saved += unchanged + (item.state === 'accepted' ? item.after : item.before);
        preview += unchanged + shown;
        cursor = item.end; previous = item;
      }
      const tail = source.slice(cursor);
      if (tail) pieces.push({ kind: 'unchanged', text: tail });
      target += tail; saved += tail; preview += tail;
      if (target !== proposal.text) return null;
      return { pieces, counts, target, saved, preview };
    }
    // Presentation-only slices: never substitute context for a hunk's immutable before.
    function revisionContext(source, hunk, { maxLines = 5, maxChars = 800 } = {}) {
      if (typeof source !== 'string' || !hunk || !Number.isSafeInteger(hunk.start) || !Number.isSafeInteger(hunk.end) ||
          hunk.start < 0 || hunk.end < hunk.start || hunk.end > source.length || !textBoundary(source, hunk.start) || !textBoundary(source, hunk.end) ||
          source.slice(hunk.start, hunk.end) !== hunk.before) return null;
      const breaks = [...source.matchAll(/\r\n|\r|\n/g)];
      const lines = Math.max(1, Math.floor(maxLines / 2));
      const left = breaks.filter(m => m.index + m[0].length <= hunk.start);
      const right = breaks.filter(m => m.index >= hunk.end);
      let start = left.length > lines ? left[left.length - lines - 1].index + left[left.length - lines - 1][0].length : 0;
      let end = right.length >= lines ? right[lines - 1].index + right[lines - 1][0].length : source.length;
      // A very long physical line is bounded at safe scalar/CRLF boundaries.
      start = Math.max(start, hunk.start - Math.max(1, maxChars));
      end = Math.min(end, hunk.end + Math.max(1, maxChars));
      while (!textBoundary(source, start)) start++;
      while (!textBoundary(source, end)) end--;
      return { prefix: source.slice(start, hunk.start), focus: source.slice(hunk.start, hunk.end), suffix: source.slice(hunk.end, end) };
    }
    function visibleWhitespace(value) {
      const whitespaceOnly = value.length > 0 && /^\s+$/u.test(value);
      const newlines = (value.match(/\r\n|\r|\n/g) || []).length;
      const tabs = (value.match(/\t/g) || []).length, spaces = (value.match(/ /g) || []).length;
      return { text: whitespaceOnly ? value.replace(/\r\n|\r|\n/g, '↵\n').replace(/\t/g, '⇥').replace(/ /g, '·').replace(/[^\S\n↵⇥·]/gu, '␣') : value,
        whitespaceOnly, newlines, tabs, spaces };
    }
    function generatedDisplayRecord(w, proposal, job, { recovery = null, conflict = null } = {}) {
      const active = job && job.bookId === w?.book.id && job.chapterId === w?.chapterId &&
        (job.status === 'running' || job.status === 'completed' && !w.book.proposals.some(p => p.id === job.proposalId));
      // All modes suppress the previous outcome throughout generation and the durable-fetch gap.
      if (active) return job;
      const completed = job?.status === 'completed' && job.bookId === w?.book.id && job.chapterId === w?.chapterId && w.book.proposals.find(p => p.id === job.proposalId && p.chapterId === w.chapterId);
      return completed && !isDirty(w) && !recovery && !conflict ? completed : proposal;
    }
    function generatedReviewView(w, record) {
      if (!w || !['draft', 'continue', 'summary'].includes(record?.mode) || record.chapterId !== w.chapterId ||
          record.bookId != null && record.bookId !== w.book.id || typeof record.text !== 'string') return null;
      const chapter = chapterOf(w), hasSource = typeof record.sourceBody === 'string';
      if (!chapter || !Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 1 || !hasSource && chapter.revision !== record.sourceRevision) return null;
      const source = hasSource ? record.sourceBody : chapter.body;
      const durable = hasSource && w.book.proposals.some(p => p.id === record.id && JSON.stringify(p) === JSON.stringify(record));
      return { source, newText: record.text, prefix: record.mode === 'continue' ? source : '',
        preview: record.mode === 'continue' ? source + record.text : record.text,
        durable, stale: chapter.revision !== record.sourceRevision || chapter.body !== source };
    }
    function generatedPreviewDecision(w, record, originalKey, { recovery = null, conflict = null } = {}) {
      const view = generatedReviewView(w, record);
      if (!view) return { key: null, visible: false, deferred: false };
      const key = JSON.stringify([w.book.id, w.chapterId, record.id, 'generated']);
      const blocked = isDirty(w) || !!recovery || !!conflict, explicit = originalKey === 'preview:' + key;
      return { key, visible: originalKey !== key && !blocked && (explicit || !view.stale && (view.durable ? record.state === 'ready' : ['running', 'completed'].includes(record.status))), deferred: originalKey !== key && blocked };
    }
    function generatedActionSnapshot(w, record) {
      if (!generatedReviewView(w, record)?.durable) return null;
      return Object.freeze({ ...reviewSnapshot(w, { proposalId: record.id }), candidateId: w.candidateId, chapter: JSON.stringify(chapterOf(w)) });
    }
    function generatedActionProblem(w, snapshot, { recovery = null, conflict = null, busy = false, unavailable = false, accept = true } = {}) {
      if (busy) return 'working';
      if (unavailable) return 'bookMissing';
      if (!snapshot || !reviewIsCurrent(w, snapshot) || w.candidateId !== snapshot.candidateId || JSON.stringify(chapterOf(w)) !== snapshot.chapter) return 'confirmChanged';
      if (recovery) return 'manageRecovery';
      if (conflict || isDirty(w)) return 'saveFirst';
      const record = w.book.proposals.find(p => p.id === snapshot.proposalId), view = generatedReviewView(w, record);
      if (!view?.durable || record.state !== 'ready') return 'confirmChanged';
      return accept && view.stale ? 'stale' : '';
    }
    function revisionPreviewDecision(w, proposal, originalReviewKey, { recovery = null, conflict = null } = {}) {
      if (!w || proposal?.mode !== 'revise') return { key: null, visible: false, deferred: false };
      const key = JSON.stringify([w.book.id, w.chapterId, proposal.id]);
      const requested = originalReviewKey !== key, blocked = isDirty(w) || !!recovery || !!conflict;
      const explicitPreview = originalReviewKey === 'preview:' + key;
      // Do not cover a newly saved manual revision with its now-stale AI target.
      // Stale proposals remain available through an explicit compare/preview click.
      return { key, visible: requested && !blocked && (explicitPreview || proposal.state === 'ready' && !staleProposal(w, proposal)), deferred: requested && blocked };
    }
    function visibleReviewProblem(snapshot, review) {
      if (!snapshot || !review || !review.visible || review.bookId !== snapshot.bookId || review.chapterId !== snapshot.chapterId || review.proposalId !== snapshot.proposalId) return 'confirmChanged';
      return review.blocked ? 'working' : '';
    }
    function bulkRevisionSnapshot(w, proposal) {
      if (!w || !revisionView(proposal) || !w.book.proposals.some(p => p.id === proposal.id && JSON.stringify(p) === JSON.stringify(proposal))) return null;
      return Object.freeze({ ...reviewSnapshot(w, { proposalId: proposal.id }), candidateId: w.candidateId, chapter: JSON.stringify(chapterOf(w)) });
    }
    function bulkRevisionProblem(w, snapshot, { recovery = null, conflict = null, busy = false, unavailable = false } = {}) {
      if (busy) return 'working';
      if (unavailable) return 'bookMissing';
      if (!snapshot || !reviewIsCurrent(w, snapshot) || w.candidateId !== snapshot.candidateId || JSON.stringify(chapterOf(w)) !== snapshot.chapter) return 'confirmChanged';
      if (recovery) return 'manageRecovery';
      if (conflict || isDirty(w)) return 'saveFirst';
      const proposal = w.book.proposals.find(p => p.id === snapshot.proposalId), view = revisionView(proposal);
      if (!view || proposal.state !== 'ready' || !view.counts.pending) return 'confirmChanged';
      return staleProposal(w, proposal) ? 'stale' : '';
    }
    function revisionHunkSnapshots(w, proposal) {
      const hunks = proposal?.review?.hunks, snapshots = new Map();
      if (!w || !proposal || !Array.isArray(hunks)) return snapshots;
      // Serialize large source/target/chapter strings once per render, not for
      // each of up to 256 decisions. Frozen scalar identities share these strings.
      const identity = { ...reviewSnapshot(w, { proposalId: proposal.id }), candidateId: w.candidateId,
        chapter: JSON.stringify(chapterOf(w)) };
      for (const item of hunks) if (item && typeof item.id === 'string') {
        snapshots.set(item.id, Object.freeze({ ...identity, hunkId: item.id, hunk: JSON.stringify(item) }));
      }
      return snapshots;
    }
    function revisionHunkSnapshot(w, proposal, hunkId) {
      return revisionHunkSnapshots(w, proposal).get(hunkId) || null;
    }
    function revisionActionProblem(w, snapshot, { recovery = null, conflict = null, busy = false } = {}) {
      if (busy) return 'working';
      if (!snapshot || !reviewIsCurrent(w, snapshot) || w.candidateId !== snapshot.candidateId ||
          JSON.stringify(chapterOf(w)) !== snapshot.chapter) return 'confirmChanged';
      if (recovery) return 'manageRecovery';
      if (conflict || isDirty(w)) return 'saveFirst';
      const proposal = proposalOf(w), view = revisionView(proposal);
      if (!view) return 'revisionInvalid';
      const item = proposal.review.hunks.find(part => part.id === snapshot.hunkId);
      if (proposal.id !== snapshot.proposalId || proposal.state !== 'ready' || !item || item.state !== 'pending' || JSON.stringify(item) !== snapshot.hunk) return 'confirmChanged';
      if (staleProposal(w, proposal)) return 'stale';
      return '';
    }
    function staleProposal(w, proposal) {
      const c = chapterOf(w);
      if (proposal?.mode === 'revise') {
        const view = revisionView(proposal);
        return !c || !view || proposal.chapterId !== c.id || c.revision !== proposal.sourceRevision + view.counts.accepted || c.body !== view.saved;
      }
      if (!c || !proposal || proposal.sourceRevision !== c.revision || proposal.sourceBody !== c.body) return true;
      if (proposal.mode === 'polish') {
        const s = proposal.selection;
        return !s || s.end <= s.start || c.body.slice(s.start, s.end) !== s.text;
      }
      return false;
    }

    // Model preferences deliberately live outside workspace, manuscript dirty/recovery and saveAll.
    const validModelSelection = value => value === null || !!value && typeof value.provider === 'string' && !!value.provider && typeof value.model === 'string' && !!value.model && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string' && !!value.reasoningEffort);
    const validModelSettings = value => !!value && Number.isSafeInteger(value.revision) && value.revision > 0 && validModelSelection(value.selection);
    const sameModelSelection = (a, b) => a === null || b === null ? a === b : !!a && !!b && a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;
    function receiveModelSettings(state, settings, reset = false) {
      if (!validModelSettings(settings)) return { ...state, available: false };
      if (reset || !state.settings) return { settings, draft: settings.selection, available: true, conflict: false };
      if (settings.revision < state.settings.revision) return state;
      // Refresh/conflict reads never replace visible choices. Only explicit reload resets them.
      if (settings.revision !== state.settings.revision || !sameModelSelection(settings.selection, state.settings.selection)) return { ...state, available: true, conflict: true };
      return { ...state, available: true };
    }
    const modelRouteKey = selection => JSON.stringify([selection?.provider || '', selection?.model || '']);
    function catalogRequestIsCurrent(sequence, request, selection, aborted = false) {
      return !aborted && sequence === request.sequence && modelRouteKey(selection) === request.key;
    }
    // Discovery proceeds from registered providers to their model list, then metadata.
    // Never ask the backend to resolve an unavailable saved provider/model route.
    function modelCatalogRequest(selection, catalog, details = false) {
      if (!selection?.provider || !catalog.providers.some(p => p.id === selection.provider)) return null;
      if (!details) return { provider: selection.provider };
      if (!selection.model || !catalog.models.some(m => m.provider === selection.provider && m.id === selection.model)) return null;
      return { provider: selection.provider, model: selection.model };
    }
    function modelCatalogProblem(selection, catalog) {
      if (catalog.loading || catalog.key !== modelRouteKey(selection)) return 'modelLoading';
      if (catalog.error) return 'modelCatalogError';
      if (selection === null) return '';
      if (!selection?.provider || !selection?.model) return 'modelChooseRoute';
      if (!catalog.providers.some(p => p.id === selection.provider) || !catalog.models.some(m => m.provider === selection.provider && m.id === selection.model)) return 'modelRouteUnavailable';
      const details = catalog.details;
      if (!details || details.provider !== selection.provider || details.id !== selection.model) return 'modelRouteUnavailable';
      if (selection.reasoningEffort && !details.efforts.some(e => e.id === selection.reasoningEffort)) return 'modelEffortUnavailable';
      return '';
    }
    function modelGenerationProblem(state, catalog, saving = false) {
      if (!state.available || !state.settings) return 'modelFeatureUnavailable';
      if (saving) return 'modelSaving';
      if (state.conflict) return 'modelSettingsConflict';
      if (!sameModelSelection(state.draft, state.settings.selection)) return 'modelUnsaved';
      return modelCatalogProblem(state.draft, catalog);
    }
    const modelDescription = value => value?.provider && value?.model ? value.provider + ' / ' + value.model + (value.reasoningEffort ? ' · ' + value.reasoningEffort : '') : '';

    const en = {
      writingControls: 'Writing controls', collapseControls: 'Collapse controls', expandControls: 'Show controls',
      chaptersToggle: 'Chapters', bookTools: 'Book / chapter tools and export', previousResult: 'Showing an earlier saved result, not output from this attempt.', results: 'Generated results', advanced: 'Model / context / details', insertionContext: 'Original context (insert here; no source text replaced)', insertionSpot: '│ insertion point │', sourceAnchor: 'Original context · append at end', legacyDraft: 'Recovered result edits — resolve explicitly before generation/review', discardResultEdits: 'Discard result edits', newTextLabel: 'New text (not saved)', approveAll: 'Approve all', approveAllHint: 'Approve every pending change in this visible result; previously rejected changes stay original.', summarySaved: 'Current saved summary (not the original generation snapshot)', summaryOnly: 'Summary only — manuscript is unchanged', noSummary: 'No saved summary',
      nav: 'Inspiration', title: 'Inspiration', subtitle: 'AI drafts. You decide what stays.',
      polishAI: 'AI polish', polishCustom: 'Polish to requirements', polishSelectionActions: 'Selected passage actions', polishSelectionOnly: 'This selection only. Selecting text does not start an AI request. Tab enters these actions; Escape closes them.',
      polishDefaultDirection: 'Polish this selected passage for clarity, flow and natural expression. Preserve its meaning, point of view, characters, facts and plot; return only the polished passage.',
      polishRequirement: 'Enter a non-empty requirement for this selected passage.', polishSubmit: 'Polish this selection', polishComposing: 'Finish composing text before asking AI to polish.', polishBusy: 'A generation is running or settling for this book. Wait or cancel it before starting another.',
      polishHistoryPreview: 'Historical polish comparison — not the manuscript editor', polishApplied: 'Polished text · accepted and saved', polishDeclined: 'Polished text · rejected (comparison only)', polishPreview: 'Inline polish preview — NOT saved to the manuscript', polishNew: 'Polished text · not yet applied', polishProgress: 'Polishing...', polishAwaitProposal: 'Waiting for the durable proposal before author decisions are available.',
      polishAccept: 'Accept and save this polished passage', polishReject: 'Reject this polished passage', polishSaved: 'Polished passage accepted and saved.', polishRejected: 'Polish rejected. The manuscript is unchanged.',
      polishOpen: 'Open inline polish comparison', polishOriginalHint: 'Showing the actual manuscript. AI changes require the Accept button; Save all saves manual drafts only.', polishLocalDraft: 'Your unsaved manual draft stays visible. Save all saves only manual edits, not this AI preview.',
      polishDeferred: 'Inline polish is available, but manual drafts, recovery or conflicts must be resolved explicitly first. No draft was hidden or silently saved.', polishSourceUnavailable: 'Cannot safely overlay this job: its exact saved source revision is unavailable. Refresh the saved version and review its durable proposal.', candidateSave: 'Save proposal edits only',
      modelPicker: 'Generation model', modelMode: 'Model selection', modelFollowDefault: 'Follow DSH default', modelCustom: 'Custom for Inspiration', modelProvider: 'Provider', modelName: 'Model', modelReasoning: 'Reasoning effort', modelProviderDefault: 'Provider default', modelChooseProvider: 'Choose a provider', modelChooseModel: 'Choose a model',
      modelApply: 'Apply to Inspiration', modelReload: 'Reload saved model preference', modelRetryCatalog: 'Retry model catalog', modelSaved: 'Model preference saved', modelDraft: 'Model preference draft — not applied', modelScope: 'Plugin-wide preference for Inspiration only. Does not change the DSH default or your manuscript.', modelNextGeneration: 'Applies to the next generation. A running job keeps its original model.', modelFollowObserved: 'Last observed DSH default: {model}. Resolved again when generation starts.', modelEffective: 'Effective saved custom model: {model}', modelJob: 'This job’s actual model: {model}', modelJobPending: 'This job’s actual model will appear when its server snapshot is loaded.',
      modelFeatureUnavailable: 'Model selection is unavailable in the current backend. Reload the plugin/backend, then reload the saved model preference. Generation is blocked until the contract is available.', modelLoading: 'Loading model catalog…', modelSaving: 'Applying model preference…', modelUnsaved: 'Apply or explicitly reload your model choices before generating.', modelSettingsConflict: 'The saved model preference changed elsewhere. Your choices are kept. Reload the saved model preference explicitly before trying again.', modelChooseRoute: 'Choose a provider and model before applying.', modelRouteUnavailable: 'This selected route is unavailable. It has not been replaced. Choose another active route or follow the DSH default, then Apply.', modelEffortUnavailable: 'The selected reasoning effort is no longer advertised. Choose an advertised effort or Provider default, then Apply.', modelCatalogError: 'Could not load the model catalog. Your choices are kept; retry the catalog.', modelUnavailableOption: 'Unavailable: {id}',
      manageBooks: 'Book management', manageBookHint: 'Rename or permanently delete the selected book.', savedBookTitle: 'Exact saved title', bookIdentity: 'Book ID: {id} · revision {revision}', bookOption: '{title} · {count} chapters · {id}',
      renameBook: 'Rename book', renameTitle: 'New book title', renamed: 'Book renamed.', manageUnsaved: 'Resolve all unsaved edits and saved-version conflicts before managing this book.', manageRecovery: 'Restore and save, or explicitly discard the local recovery copy before managing this book.',
      deleteBook: 'Permanently delete book', deleteWarning: 'This cannot be undone. Permanently deletes this book, every chapter, canon card, proposal, revision history and this plugin’s job records. DSH model-session logs are stored separately and are not deleted.',
      deleteBackup: 'Export a JSON backup before deleting. The backup includes saved data only; keep it somewhere safe.', deleteTypeTitle: 'Type the exact saved title to confirm', deleteBusy: 'Deletion is blocked while this book has a running or unsettled generation. Wait for it to finish, or cancel it and wait for cancellation to settle.',
      deleteUnconfirmed: 'The server did not return a matching deletion confirmation. Local data has been kept. Close this dialog and refresh the library before trying again.',
      deleteUncertain: 'The deletion result could not be confirmed. Local data has been kept; the server may already have deleted the book. Close this dialog and refresh the library to check. Do not retry blindly.',
      deleted: '“{title}” was deleted from the library and its plugin records were removed. DSH model-session logs are retained separately.',
      deleteCleanupPending: '“{title}” is hidden from the library, but residual plugin data cleanup is still pending. Cleanup will retry on the next plugin load. Do not assume all data has been erased. DSH model-session logs are retained separately.',
      libraryCleanupPending: '{count} deleted book(s) still have residual plugin data awaiting cleanup. Cleanup retries on the next plugin load; DSH model-session logs are retained separately.',
      deleteLocalCleanupPending: 'Some local draft or job-cache data could not be removed from browser storage. The book stays deleted; local cleanup is incomplete.',
      deleteRefreshFailed: 'The deletion was confirmed, but the library could not be refreshed. The deleted book will not be reopened. Refresh the list to continue.', chooseBookHint: 'Select a remaining book above, or create or import a new book.',
      bookMissing: 'This book is no longer in the saved library. The currently displayed copy has not been cleared; download any local edits before choosing another book. Refresh will not reopen a missing book.', bookUnavailable: 'Unavailable saved book: {title}',
      book: 'Book', chapter: 'Chapter', chooseBook: 'Choose a book', newBookTitle: 'New book title', createBook: 'Create book',
      refresh: 'Refresh saved version', loading: 'Loading…', working: 'Working…', retry: 'Retry', close: 'Close', cancel: 'Cancel',
      writing: 'Manuscript', cards: 'Canon cards', settings: 'Project', history: 'Revision history',
      save: 'Save all changes', saved: 'Saved', unsaved: 'Unsaved changes', saveHint: 'Explicit save · local recovery is not a server backup',
      emptyTitle: 'A long story, written one decision at a time.', emptyHint: 'Create a book, add a chapter, then ask AI for a draft. Edit freely; nothing enters the manuscript until you accept it.',
      bookTitle: 'Book title', chapterTitle: 'Chapter title', newChapterTitle: 'New chapter title', addChapter: 'Add chapter', noChapters: 'Add your first chapter to begin.',
      chapterOutline: 'Chapter plan (not yet occurred)', manuscript: 'Manuscript', editorHint: 'Write here, or select an exact passage for polishing. Save before asking AI.',
      draft: 'Draft', final: 'Final', chapterStatus: 'Chapter status', chars: '{count} characters', revision: 'Revision {number}',
      selected: '{count} characters selected · offsets {start}–{end}', noSelection: 'Select text in the manuscript for precise polishing.',
      summary: 'Chapter summary', summaryCurrent: 'Summary matches this revision', summaryStale: 'Summary missing or stale — excluded from future context',
      summaryHint: 'A summary-only save confirms the current revision. If title, plan or body also changes, the summary remains stale: review and confirm it below. AI summaries also require acceptance.',
      confirmSummary: 'Confirm reviewed summary for this revision', confirmSummaryHint: 'Confirm that this summary describes the currently saved chapter accurately. The manuscript will not change.',
      maintenance: 'Archive maintenance', prune: 'Clear processed proposals and old history', pruneTitle: 'Permanently clear old archive entries?', pruneHint: 'Export a JSON backup first. Accepted/rejected proposals will be deleted and each chapter will retain only its 5 most recent history snapshots. Ready proposals and current manuscript are kept. This cannot be undone.',
      ai: 'Writing partner', aiSafety: 'AI output is a proposal, never an automatic replacement.', mode: 'Task',
      modeDraft: 'Draft a chapter', modeContinue: 'Continue the chapter', modePolish: 'Polish selected text', modeSummary: 'Summarize this chapter', modeRevise: 'Polish to requirements (whole chapter)',
      reviseHint: 'Whole current chapter only — not the selected passage or the whole book. No selection needed. Starts two sequential, potentially paid model calls: analysis, then targeted whole-chapter polishing. Preserve cast, canon and plot unless you explicitly request a change.',
      reviseRequirement: 'Enter a specific whole-chapter polish requirement before starting.', revisePlaceholder: 'For example: dialogue feels stiff and sparse — make it natural and add dialogue without changing the plot or character relationships.',
      analyzing: 'Analyzing your requirements… (step 1 of 2)', optimizing: 'Polishing this whole chapter… (step 2 of 2)', revisionAnalysis: 'Analysis and whole-chapter polish plan',
      revisionPreview: 'Whole-chapter polish preview — unconfirmed changes have NOT been saved to the manuscript', revisionOpen: 'Open whole-chapter polish preview over editor', revisionOriginal: 'Show saved manuscript / edit', revisionOriginalHint: 'Ordinary manuscript editor. Pending changes are not saved; editing the source will invalidate this review after saving. Already accepted changes stay saved.',
      revisionDeferred: 'Whole-chapter polish is ready. Your manual edits remain visible; resolve unsaved edits, recovery and conflicts before opening the preview. Save all saves only manual edits — AI changes still need explicit confirmation — individually or with Approve all.', revisionLocalDraft: 'Showing your unsaved manual draft, not the AI preview. Save all saves these manual edits only; AI changes need explicit confirmation — individually or with Approve all. Saving source edits will invalidate the old proposal.', revisionHunk: 'Change {number} · {state}', revisionAcceptLabel: 'Accept and save change {number}', revisionRejectLabel: 'Reject change {number}',
      revisionCounts: '{pending} pending · {accepted} accepted and saved · {rejected} rejected', revisionAccept: 'Accept and save this change', revisionReject: 'Reject this change', revisionDeleted: '(deletion — no replacement text)', revisionBefore: 'Compare original text', revisionNoChanges: 'Analysis completed: no text changes were proposed. There is nothing to accept.',
      revisionInvalid: 'Invalid review data. Changes are disabled; refresh the saved version or generate a new proposal.', revisionImmutable: 'The original whole-chapter polish target is immutable. Review changes in the main editor; only explicitly approved changes are saved.',
      revisionRejectRemaining: 'Reject remaining changes (keep accepted changes)', revisionRejectHint: 'Reject all still-pending changes. Previously accepted and saved changes remain in the manuscript.', revisionDismissEmpty: 'Dismiss no-change proposal', revisionSaved: 'This change was accepted and saved.', revisionRejected: 'This change was rejected. The manuscript was not changed.',
      instruction: 'Your direction', instructionPlaceholder: 'What should happen, and what must stay unchanged?',
      generate: 'Generate', context: 'Preview context', contextTitle: 'Context report', contextNote: 'Approximate character budget, not a token count. Future chapter facts are excluded.',
      budgetUsed: '{used} / {budget} characters', included: 'Included', omitted: 'Omitted', warnings: 'Warnings', fullPrompt: 'Full prompt (reference data)',
      saveFirst: 'Save or discard your changes before generating or accepting a proposal.', polishFirst: 'Select a non-empty passage in the saved manuscript first.',
      generating: 'Generating… You may keep editing; the proposal remains tied to its source revision.', cancelJob: 'Cancel generation',
      running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', job: 'Generation', liveOutput: 'Output in progress (not a proposal yet)',
      pollError: 'Could not check this job. Retrying; the generation has not been cancelled.', jobOtherChapter: 'This job belongs to another chapter in this book.',
      candidate: 'Proposal', noCandidates: 'No proposals yet. Preview the context, then generate one.', candidateText: 'Editable proposal',
      candidateUnsaved: 'Proposal edits must be saved before acceptance.', before: 'Before', after: 'Proposal', compare: 'Compare before / after',
      originalPassage: 'Original selected passage', originalChapter: 'Original source chapter', continueHint: 'Acceptance appends this continuation; it does not replace the existing chapter.',
      draftHint: 'Acceptance replaces the entire chapter body. The previous body is retained in history.', summaryModeHint: 'Acceptance updates the summary only; the manuscript stays unchanged.',
      polishHint: 'Acceptance replaces only the exact selected passage at the captured offsets.', stale: 'Source changed. This proposal cannot be accepted; generate a fresh one.',
      accept: 'Accept proposal', reject: 'Reject proposal', ready: 'Ready for review', accepted: 'Accepted', rejected: 'Rejected',
      acceptTitle: 'Accept this proposal?', acceptConfirm: 'Apply this exact saved proposal', rejectTitle: 'Reject this proposal?',
      rejectHint: 'The manuscript will remain unchanged. This proposal stays in the record as rejected.', candidateSaved: 'Proposal saved.',
      premise: 'Premise', outline: 'Book plan (not established facts)', style: 'Style and writing constraints', contextBudget: 'Context budget (characters)',
      projectHint: 'Plans describe intentions, not events that have already happened. Confirm established facts in canon cards.',
      invalidBudget: 'Enter a whole-number context budget from 1,000 to 60,000 characters.',
      canonHint: 'Only confirmed cards in the target chapter range enter context. Proposed cards are not canon. Pin hard rules that must not be silently clipped.',
      newCard: 'New card', cardTitle: 'Card title', cardContent: 'Content', kind: 'Kind', cardStatus: 'Canon status',
      world: 'World', character: 'Character', timeline: 'Timeline', thread: 'Open thread', rule: 'Rule', confirmed: 'Confirmed', proposed: 'Proposed',
      pin: 'Pin as a hard constraint', pinned: 'Pinned', fromChapter: 'Visible from chapter (1-based)', toChapter: 'Through chapter (blank = no end)', tags: 'Tags (comma-separated)',
      range: 'Chapters {from}–{to}', noEnd: 'onward', edit: 'Edit', removeCard: 'Remove card', removeTitle: 'Remove this canon card?', removeHint: 'It will no longer be included in future context.',
      noCards: 'No canon cards yet. Add characters, rules, timelines or unresolved threads.', chooseCard: 'Choose a card to edit, or create one.', invalidScope: 'Chapter scope must use positive whole numbers, with the end at or after the start.',
      noHistory: 'No previous manuscript versions yet. Body changes create snapshots automatically.', historyHint: 'Up to 30 previous bodies are retained. Restoring creates a new revision; it never silently accepts an AI proposal.',
      restore: 'Restore this body', restoreTitle: 'Restore a previous body?', restoreHint: 'The current body will be saved to history before this snapshot becomes the manuscript.',
      unsavedTitle: 'Keep your changes?', unsavedHint: 'There are unsaved edits. Save them before continuing, or explicitly discard them.', saveContinue: 'Save and continue', discardContinue: 'Discard and continue', stay: 'Stay here',
      recoveryTitle: 'A local recovery draft is available', recoveryHint: 'It has not replaced the saved book. Review and restore it only if you want to continue those edits.',
      recover: 'Restore local edits', discardRecovery: 'Discard recovery copy', recoveryPreview: 'Review recovery copy', recoveryMissing: 'This recovery refers to a missing chapter or proposal. Download it before discarding.',
      recoveryRestored: 'Local edits restored into the editor — not saved to the server.', storageWarning: 'Local recovery could not be stored. Keep this panel open and save or download your edits before leaving.',
      recoveredFrom: 'Local copy from {date}', conflictTitle: 'Saved data changed — your local edits are protected',
      conflictHint: 'Nothing was overwritten. Compare your changes with the latest saved fields. Reload to discard local edits, or explicitly use them as a new draft before saving again.',
      localChanges: 'Your local changes', latestSaved: 'Latest saved fields', reviewLatest: 'Fetch latest for comparison', rebase: 'Use my edits as a new draft',
      rebaseTitle: 'Keep these local edits over the reviewed version?', rebaseHint: 'This only changes the editing baseline. Review the resulting draft, then Save to commit it. Concurrent later changes will still be rejected.',
      rebaseUnavailable: 'This proposal is no longer editable. Download your local edits, then reload.', downloadLocal: 'Download local edits',
      exportJson: 'Export backup JSON', exportMarkdown: 'Export manuscript', exportHint: 'Exports contain saved data only. JSON includes canon, proposals and history; Markdown contains the manuscript.',
      import: 'Import backup JSON', importHint: 'Imports create a separate book; they never overwrite an existing book.', importTooLarge: 'Choose a JSON file no larger than 40 MiB.',
      imported: 'Imported as a new book.', created: 'Book created.', model: 'Last observed Inspiration model', noModel: 'No effective model. Choose a custom model here or set a default in DSH to generate.',
      requestFailed: 'Request failed', networkError: 'Connection failed. A save may have completed; refresh the saved version before retrying.',
      generationFinished: 'Proposal ready for your review. Nothing has changed in the manuscript.',
      localOnly: 'Local edits have not been saved to the server.', discard: 'Discard edits', confirmDiscard: 'Discard these unsaved edits?',
      confirmChanged: 'The reviewed version changed while this dialog was open. Cancel, review the latest content, then confirm again.',
      dismiss: 'Dismiss', empty: '(empty)', selectionChanged: 'The selected source changed. Select the passage again.',
    };
    const zh = {
      writingControls: '写作控制区', collapseControls: '收起控制区', expandControls: '展开控制区',
      chaptersToggle: '章节列表', bookTools: '作品 / 章节工具与导出', previousResult: '当前显示的是此前已保存的结果，并非本次生成输出。', results: '生成结果', advanced: '模型 / 上下文 / 详情', insertionContext: '原文上下文（此处插入，未替换原文）', insertionSpot: '│ 此处插入 │', sourceAnchor: '原文上下文 · 从文末续写', legacyDraft: '已恢复旧版结果编辑，请明确处理后再生成或审阅', discardResultEdits: '放弃结果编辑', newTextLabel: '新文字（尚未保存）', approveAll: '一键批准', approveAllHint: '批准当前可见结果的所有待审阅修改；已拒绝的修改保持原文。', summarySaved: '当前已保存摘要（非生成时的原始摘要快照）', summaryOnly: '仅更新摘要，不改正文', noSummary: '尚无已保存摘要',
      nav: '灵感', title: '灵感', subtitle: 'AI 起稿，落笔由你。',
      polishAI: 'AI润色', polishCustom: '按需润色', polishSelectionActions: '选中文字的润色操作', polishSelectionOnly: '仅处理当前选区；选择文字不会发起 AI 请求。Tab 可进入操作，Escape 可关闭。',
      polishDefaultDirection: '请润色所选片段，让表达更清晰、流畅、自然。保留原意、叙述视角、人物、事实与情节，不擅自增删设定；只返回润色后的片段。',
      polishRequirement: '请填写针对当前选区的非空润色要求。', polishSubmit: '润色此选区', polishComposing: '请先结束输入法组字，再发起润色。', polishBusy: '本作品仍有生成中或尚未收尾的任务，请等待完成，或取消并等待收尾后再生成。',
      polishHistoryPreview: '历史润色对照 · 不是正文编辑器', polishApplied: '润色后 · 已采纳并保存', polishDeclined: '润色后 · 已拒绝（仅供对照）', polishPreview: '原位润色预览 · 尚未写入正文', polishNew: '润色后 · 尚未应用', polishProgress: '正在润色...', polishAwaitProposal: '正在等待已保存提案，生成完成并持久化后才能确认。',
      polishAccept: '采纳并保存此段润色', polishReject: '拒绝此段润色', polishSaved: '此段润色已采纳并保存。', polishRejected: '此段润色已拒绝，正文保持不变。',
      polishOpen: '打开原位润色对照', polishOriginalHint: '当前显示真实正文。AI 改动仍须点击采纳按钮确认；「保存全部」只保存手动编辑。', polishLocalDraft: '当前保留显示你的未保存手动稿。「保存全部」只保存手动编辑，不会应用 AI 润色。',
      polishDeferred: '润色可供审阅，请先明确处理未保存手动稿、恢复稿或冲突。没有遮盖草稿，也没有静默保存。', polishSourceUnavailable: '无法安全覆盖此任务的预览：精确来源修订不可用。请刷新已保存版本，再审阅持久化提案。', candidateSave: '仅保存提案编辑',
      modelPicker: '生成模型', modelMode: '模型选择', modelFollowDefault: '跟随 DSH 默认', modelCustom: '为灵感单独选择', modelProvider: '提供方', modelName: '模型', modelReasoning: '推理强度', modelProviderDefault: '提供方默认', modelChooseProvider: '请选择提供方', modelChooseModel: '请选择模型',
      modelApply: '应用到灵感', modelReload: '重新载入已保存模型偏好', modelRetryCatalog: '重试模型目录', modelSaved: '模型偏好已保存', modelDraft: '模型偏好草稿 · 尚未应用', modelScope: '仅对灵感插件全局生效，不修改 DSH 默认模型，也不修改正文。', modelNextGeneration: '从下一次生成开始生效；正在运行的任务仍使用原模型。', modelFollowObserved: '最近读取的 DSH 默认模型：{model}（生成开始时重新读取）。', modelEffective: '已保存自选偏好的当前有效模型：{model}', modelJob: '本次任务实际模型：{model}', modelJobPending: '载入服务端任务快照后将显示本次任务的实际模型。',
      modelFeatureUnavailable: '当前后端尚不支持模型选择。请重新加载插件或后端，再重新载入已保存模型偏好。接口可用前暂不能生成。', modelLoading: '正在载入模型目录…', modelSaving: '正在应用模型偏好…', modelUnsaved: '生成前请先应用模型选择，或明确重新载入已保存偏好。', modelSettingsConflict: '已保存模型偏好在其他位置发生了变化，当前选择已保留。请明确重新载入已保存偏好后再操作。', modelChooseRoute: '应用前请选择提供方与模型。', modelRouteUnavailable: '当前所选模型路线不可用，未自动替换。请选择其他可用路线，或改为跟随 DSH 默认，再点击应用。', modelEffortUnavailable: '当前推理强度已不在模型公布的选项中，请选择有效强度或提供方默认，再点击应用。', modelCatalogError: '模型目录载入失败，当前选择已保留，请重试模型目录。', modelUnavailableOption: '不可用：{id}',
      manageBooks: '作品管理', manageBookHint: '重命名或永久删除当前所选作品。', savedBookTitle: '完整的已保存名称', bookIdentity: '作品编号：{id} · 修订 {revision}', bookOption: '{title} · {count} 章 · {id}',
      renameBook: '重命名作品', renameTitle: '新的作品名称', renamed: '作品已重命名。', manageUnsaved: '请先明确处理全部未保存编辑和版本冲突，再管理作品。', manageRecovery: '请先恢复并保存本地恢复稿，或明确丢弃恢复稿，再管理作品。',
      deleteBook: '永久删除作品', deleteWarning: '此操作不可撤销。将永久删除本作品及其全部章节、设定卡、提案、版本历史和本插件的任务记录。DSH 模型会话日志单独保留，不会随之删除。',
      deleteBackup: '删除前建议先导出 JSON 备份并妥善保存。备份仅包含已保存数据。', deleteTypeTitle: '请输入完整的已保存名称以确认', deleteBusy: '作品仍有生成中或尚未收尾的任务，暂不能删除。请等待完成，或取消任务并等待取消收尾。',
      deleteUnconfirmed: '服务端没有返回与当前作品匹配的删除确认。本地数据保持不变；请关闭此窗口并刷新作品列表后再检查。',
      deleteUncertain: '暂时无法确认删除结果，本地数据保持不变；服务端可能已经删除作品。请关闭此窗口并刷新作品列表核实，不要直接重复删除。',
      deleted: '《{title}》已从作品库删除，其插件数据已清理。DSH 模型会话日志仍单独保留。',
      deleteCleanupPending: '《{title}》已从作品库隐藏，但残留插件数据尚待清理；下次加载插件时会重试。不能视为所有数据均已擦除。DSH 模型会话日志仍单独保留。',
      libraryCleanupPending: '有 {count} 部已删除作品仍有残留插件数据待清理，下次加载插件时会重试。DSH 模型会话日志仍单独保留。',
      deleteLocalCleanupPending: '部分本地恢复稿或任务缓存无法从浏览器存储中移除。作品仍保持已删除状态，但本地清理尚未完成。',
      deleteRefreshFailed: '删除已确认，但作品列表刷新失败。不会重新打开已删除作品，请刷新列表后继续。', chooseBookHint: '请在上方选择其他作品，或创建、导入新作品。',
      bookMissing: '此作品已不在服务端作品库中，当前显示的副本尚未清除。切换作品前请下载保留本地编辑；刷新不会重新打开已不存在的作品。', bookUnavailable: '已保存作品不可用：{title}',
      book: '作品', chapter: '章节', chooseBook: '选择作品', newBookTitle: '新作品名称', createBook: '创建作品',
      refresh: '刷新已保存版本', loading: '正在载入…', working: '处理中…', retry: '重试', close: '关闭', cancel: '取消',
      writing: '正文', cards: '设定卡', settings: '作品设定', history: '版本历史',
      save: '保存全部更改', saved: '已保存', unsaved: '有未保存更改', saveHint: '手动保存 · 本地恢复稿不等于服务端备份',
      emptyTitle: '长篇，从一次次由你决定的落笔开始。', emptyHint: '创建作品、添加章节，再让 AI 起草。自由修改；只有你明确接受的提案才会进入正文。',
      bookTitle: '作品名称', chapterTitle: '章节名称', newChapterTitle: '新章节名称', addChapter: '添加章节', noChapters: '添加第一章，开始写作。',
      chapterOutline: '本章计划（尚未发生）', manuscript: '正文', editorHint: '直接写作，或精确选中一段文字进行润色。请先保存，再交给 AI。',
      draft: '草稿', final: '定稿', chapterStatus: '章节状态', chars: '{count} 字符', revision: '修订 {number}',
      selected: '已选 {count} 字符 · 位置 {start}–{end}', noSelection: '在正文中选中文字，即可精确润色。',
      summary: '章节摘要', summaryCurrent: '摘要与当前修订一致', summaryStale: '摘要缺失或已过期，不会用于后续上下文',
      summaryHint: '单独保存摘要会确认当前修订；若同时修改标题、提纲或正文，摘要仍会过期，请审阅后在下方明确确认。AI 摘要也须接受后才生效。',
      confirmSummary: '确认已审阅摘要对应当前修订', confirmSummaryHint: '请确认摘要准确描述了当前已保存章节。此操作不会改变正文。',
      maintenance: '档案维护', prune: '清理已处理候选及旧历史', pruneTitle: '永久清理旧档案？', pruneHint: '建议先导出 JSON 备份。将删除已接受、已拒绝的提案；各章历史仅保留最近 5 份。待审阅提案和当前正文保留。此操作不可撤销。',
      ai: '写作搭档', aiSafety: 'AI 输出只形成提案，不会自动替换正文。', mode: '写作任务',
      modeDraft: '起草本章', modeContinue: '续写本章', modePolish: '精确润色选区', modeSummary: '提炼本章摘要', modeRevise: '按需润色（全文）',
      reviseHint: '全文润色仅处理当前章节，不是当前选区，也不是全书，无需选中文字。将顺序发起两次可能计费的模型调用：先分析作者要求，再针对性润色全文；除非明确要求，保持人物、设定和情节不变。',
      reviseRequirement: '请先填写具体的全文润色要求。', revisePlaceholder: '例如：对话太过生硬且偏少，请让对话更自然、增加有效对话，但保留情节与人物关系。',
      analyzing: '正在分析作者要求…（第 1 / 2 步）', optimizing: '正在按需润色全文…（第 2 / 2 步）', revisionAnalysis: '分析与全文润色计划',
      revisionPreview: '全文润色预览，未确认改动尚未写入原稿', revisionOpen: '在主编辑器打开全文润色预览', revisionOriginal: '查看已保存正文 / 编辑', revisionOriginalHint: '当前为普通正文编辑器。待确认改动尚未保存；编辑并保存来源后，此审阅将过期。已采纳的修改仍保留在原稿中。',
      revisionDeferred: '全文润色已就绪，你的手动编辑保持显示。请先处理未保存编辑、恢复稿和冲突，再打开全文润色预览。「保存全部」只保存手动编辑，AI 改动仍须明确确认（逐处确认或一键批准）。', revisionLocalDraft: '当前显示你的未保存手动草稿，不是 AI 全文润色预览。「保存全部」只保存这些手动编辑，AI 改动仍须明确确认（逐处确认或一键批准）；保存来源编辑后，旧提案将过期。', revisionHunk: '第 {number} 处修改 · {state}', revisionAcceptLabel: '采纳并保存第 {number} 处修改', revisionRejectLabel: '拒绝第 {number} 处修改',
      revisionCounts: '待确认 {pending} 处 · 已采纳并保存 {accepted} 处 · 已拒绝 {rejected} 处', revisionAccept: '采纳并保存此处修改', revisionReject: '拒绝此处修改', revisionDeleted: '（删除此处，无替换文字）', revisionBefore: '对照原始文字', revisionNoChanges: '分析已完成：本次没有提出正文改动，无需采纳。',
      revisionInvalid: '审阅数据无效，已禁止应用修改。请刷新已保存版本，或重新生成提案。', revisionImmutable: '最初生成的完整全文润色目标不可编辑。请在主编辑器逐处审阅，只有明确采纳的修改才会保存。',
      revisionRejectRemaining: '拒绝剩余修改（保留已采纳内容）', revisionRejectHint: '拒绝全部仍待确认的修改。此前已采纳并保存的修改会保留在原稿中。', revisionDismissEmpty: '收起无改动提案', revisionSaved: '此处修改已采纳并保存。', revisionRejected: '此处修改已拒绝，正文没有改变。',
      instruction: '要求', instructionPlaceholder: '这一段要发生什么？哪些内容必须保持不变？',
      generate: '生成', context: '预览上下文', contextTitle: '上下文报告', contextNote: '按字符粗略预算，不是 token 数。不会混入未来章节事实。',
      budgetUsed: '{used} / {budget} 字符', included: '已包含', omitted: '已省略', warnings: '提醒', fullPrompt: '完整提示词（参考资料）',
      saveFirst: '请先保存或放弃当前更改，再生成或接受提案。', polishFirst: '请先在已保存的正文中选择非空片段。',
      generating: '正在生成…你可以继续编辑；提案会始终绑定生成开始时的版本。', cancelJob: '取消生成',
      running: '生成中', completed: '已完成', failed: '失败', cancelled: '已取消', job: '生成任务', liveOutput: '生成中的输出（尚非提案）',
      pollError: '暂时无法查询任务，正在重试；生成任务并未取消。', jobOtherChapter: '此任务属于本作品的另一章节。',
      candidate: '提案', noCandidates: '还没有提案。先预览上下文，再发起生成。', candidateText: '可编辑提案',
      candidateUnsaved: '请保存提案的修改后再接受。', before: '修改前', after: '提案内容', compare: '对照修改前后',
      originalPassage: '原始选区', originalChapter: '原始章节', continueHint: '接受后会将续写追加到本章末尾，不替换现有正文。',
      draftHint: '接受后会替换整章正文；原正文会保留在版本历史中。', summaryModeHint: '接受后只更新摘要，正文保持不变。',
      polishHint: '接受后仅替换原始位置上精确匹配的选中文字。', stale: '来源版本已变化，此提案不能再接受，请基于新版本重新生成。',
      accept: '接受提案', reject: '拒绝提案', ready: '待审阅', accepted: '已接受', rejected: '已拒绝',
      acceptTitle: '接受这份提案？', acceptConfirm: '应用这份已保存的提案', rejectTitle: '拒绝这份提案？',
      rejectHint: '正文不会改变。提案将保留在记录中并标记为已拒绝。', candidateSaved: '提案已保存。',
      premise: '故事前提', outline: '全书计划（不是已发生事实）', style: '文风与写作约束', contextBudget: '上下文预算（字符）',
      projectHint: '计划描述未来意图，不代表已经发生。请用设定卡确认已成立的事实。',
      invalidBudget: '上下文字符预算须为 1000 到 60000 之间的整数。',
      canonHint: '只有已确认且处于目标章节范围内的卡片会进入上下文。待确认卡片不算正史；将不可静默截断的硬约束置顶。',
      newCard: '新建设定卡', cardTitle: '卡片名称', cardContent: '内容', kind: '类型', cardStatus: '确认状态',
      world: '世界观', character: '人物', timeline: '时间线', thread: '未解伏笔', rule: '规则', confirmed: '已确认', proposed: '待确认',
      pin: '置顶为硬约束', pinned: '已置顶', fromChapter: '从第几章可见（从 1 开始）', toChapter: '截至第几章（留空为不限）', tags: '标签（逗号分隔）',
      range: '第 {from}–{to} 章', noEnd: '之后', edit: '编辑', removeCard: '删除卡片', removeTitle: '删除这张设定卡？', removeHint: '删除后，它将不再进入后续上下文。',
      noCards: '还没有设定卡。可以记录人物、规则、时间线和未解伏笔。', chooseCard: '选择卡片进行编辑，或新建一张。', invalidScope: '章节范围须为正整数，结束章节不能早于起始章节。',
      noHistory: '暂无旧版正文。每次正文改变都会自动保留快照。', historyHint: '最多保留 30 份旧版正文。恢复会形成新修订，不会静默接受 AI 提案。',
      restore: '恢复此版正文', restoreTitle: '恢复一份旧版正文？', restoreHint: '当前正文会先存入历史，再用此快照替换。',
      unsavedTitle: '保留当前更改？', unsavedHint: '还有未保存的修改。可以先保存再继续，或明确放弃这些修改。', saveContinue: '保存并继续', discardContinue: '放弃并继续', stay: '留在此处',
      recoveryTitle: '发现本地恢复稿', recoveryHint: '它尚未覆盖已保存作品。请先查看，再决定是否恢复这些编辑。',
      recover: '恢复本地编辑', discardRecovery: '丢弃恢复稿', recoveryPreview: '查看恢复稿', recoveryMissing: '恢复稿对应的章节或提案已不存在，请先下载保留后再丢弃。',
      recoveryRestored: '本地编辑已恢复到编辑器，尚未保存到服务端。', storageWarning: '无法存储本地恢复稿。离开前请保持此面板打开，保存或下载你的修改。',
      recoveredFrom: '本地副本时间：{date}', conflictTitle: '已保存版本发生变化，本地修改已保护',
      conflictHint: '没有覆盖任何内容。请对照本地修改与最新保存字段：可重新载入并放弃本地编辑，也可明确将本地编辑作为新草稿，再手动保存。',
      localChanges: '你的本地修改', latestSaved: '最新保存字段', reviewLatest: '获取最新版以供对照', rebase: '将我的编辑作为新草稿',
      rebaseTitle: '在已审阅版本上保留这些本地编辑？', rebaseHint: '此操作只更新编辑基准。请审阅形成的草稿，再点击保存提交；若期间再有其他改动，仍会阻止覆盖。',
      rebaseUnavailable: '此提案已不能编辑。请下载本地修改，再重新载入。', downloadLocal: '下载本地编辑',
      exportJson: '导出 JSON 备份', exportMarkdown: '导出正文', exportHint: '导出仅包含已保存数据。JSON 含设定、提案和历史；Markdown 仅含正文。',
      import: '导入 JSON 备份', importHint: '导入始终创建独立作品，不会覆盖已有作品。', importTooLarge: '请选择不超过 40 MiB 的 JSON 文件。',
      imported: '已作为新作品导入。', created: '作品已创建。', model: '最近读取的灵感模型', noModel: '当前没有有效模型。可在此单独选择模型，或在 DSH 中设置默认模型后再生成。',
      requestFailed: '请求失败', networkError: '连接失败，保存可能已完成；重试前请刷新已保存版本。',
      generationFinished: '提案已生成，等待你审阅；正文没有改变。',
      localOnly: '本地编辑尚未保存到服务端。', discard: '放弃编辑', confirmDiscard: '放弃这些未保存修改？',
      confirmChanged: '确认期间，已审阅的版本发生变化。请取消对话框，重新审阅最新内容后再确认。',
      dismiss: '收起', empty: '（空）', selectionChanged: '选区来源已变化，请重新选择片段。',
    };

    const CSS = `
.mx-root{height:100%;min-height:0;min-width:0;overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.55;padding:22px;container-type:inline-size}
.mx-root *, .mx-root *::before, .mx-root *::after{box-sizing:border-box}
.mx-root h1,.mx-root h2,.mx-root h3,.mx-root p{margin:0}.mx-root h1{font-size:24px;letter-spacing:.04em}.mx-root h2{font-size:17px}.mx-root h3{font-size:14px}
.mx-header,.mx-row,.mx-actions,.mx-tabs{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.mx-header{justify-content:space-between;margin-bottom:20px;min-height:34px;padding-inline-start:var(--dsh-frame-leading-clearance,0px)}.mx-stack{display:flex;flex-direction:column;gap:14px;min-width:0}.mx-row-between{justify-content:space-between}.mx-grow{flex:1;min-width:150px}
.mx-root button,.mx-root input,.mx-root textarea,.mx-root select{font:inherit;color:var(--dsw-alias-label-primary)}
.mx-root button{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);padding:7px 12px;cursor:pointer;min-height:34px;line-height:1.35}.mx-root button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.mx-root button:disabled{opacity:.5;cursor:not-allowed}.mx-root .mx-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}.mx-root .mx-danger{color:var(--dsw-alias-state-error-primary)}
.mx-root :is(button,input,textarea,select,summary,a):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.mx-root input:not([type=checkbox]),.mx-root textarea,.mx-root select{width:100%;max-width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:7px;padding:9px 10px;min-height:38px}.mx-root textarea{resize:vertical;line-height:1.7}.mx-root input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px}
.mx-book-row{align-items:flex-end}.mx-root .mx-book-row select,.mx-root .mx-book-row>button{height:40px;min-height:40px}.mx-book-row>button{flex-shrink:0;white-space:nowrap}
.mx-model-row{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}.mx-model-row>.mx-field{flex:1 1 130px}.mx-root .mx-model-row select,.mx-root .mx-model-row>button{height:40px;min-height:40px}.mx-model-row>button{flex-shrink:0}.mx-model-picker{width:100%}
.mx-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:13px}.mx-field>span:first-child{font-weight:550}.mx-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.mx-panel{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px;min-width:0}.mx-subpanel{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;min-width:0}.mx-empty{padding:40px 22px;max-width:760px;margin:0 auto}.mx-empty h2{font-size:22px}
.mx-toolbar{padding:12px 0}.mx-tabs{border-bottom:1px solid var(--dsw-alias-border-l1);gap:4px;margin:8px 0 18px;padding-bottom:7px}.mx-root .mx-tabs button{border-color:transparent;background:transparent}.mx-root button[aria-pressed=true]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.mx-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:stretch;min-height:0}.mx-grid[data-chapters=true]{grid-template-columns:minmax(150px,230px) minmax(0,1fr)}.mx-writing-column{min-width:0;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px}.mx-chapter-nav{min-width:0;display:flex;flex-direction:column;gap:4px;overflow:auto;min-height:0}.mx-chapter-nav button{text-align:start;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mx-editor{min-height:0;font-size:16px!important;line-height:1.9!important;tab-size:2}.mx-writing-partner{position:static;flex:0 0 auto;max-height:40%;overflow:auto;min-width:0;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l2);padding:8px 0}.mx-partner-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 10px;align-items:start}.mx-partner-row>.mx-field{grid-column:1}.mx-partner-row>.mx-actions{grid-column:2;grid-row:1/3;align-self:end}.mx-partner-row textarea{resize:none;max-height:76px}.mx-partner-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}.mx-partner-meta>button{font-size:12px;min-height:28px;padding:3px 7px}.mx-result-chooser{display:flex;align-items:center;gap:6px;max-width:350px}.mx-root .mx-result-chooser select{min-height:28px;padding:3px 6px;width:auto;max-width:270px;font-size:12px}.mx-partner-advanced{position:static;flex:0 0 auto;min-height:0;max-height:28%;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px 0}.mx-legacy-recovery{border-inline-start:2px solid var(--dsw-alias-state-warn-primary);padding-inline-start:10px}
.mx-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}.mx-status[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}.mx-status[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.mx-banner{border:1px solid var(--dsw-alias-border-l2);border-inline-start:3px solid var(--dsw-alias-state-warn-primary);padding:12px 14px;border-radius:8px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-1);overflow-wrap:anywhere}.mx-banner.mx-error{border-inline-start-color:var(--dsw-alias-state-error-primary)}.mx-banner.mx-info{border-inline-start-color:var(--dsw-alias-brand-primary)}
.mx-badge{display:inline-block;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}.mx-nav{display:flex;gap:6px;overflow:auto;padding:2px 0 10px;margin-bottom:6px}.mx-nav button{flex-shrink:0;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-root details>summary{cursor:pointer;font-size:13px;padding:6px 0}.mx-root details[open]>summary{margin-bottom:9px}.mx-root pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:12px;line-height:1.65;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:10px}.mx-root ul{padding-inline-start:20px;margin:4px 0}.mx-root li{overflow-wrap:anywhere}
.mx-compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.mx-cards{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,1.4fr);gap:18px;align-items:start}.mx-card{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.mx-card[aria-current=true]{border-color:var(--dsw-alias-brand-primary)}.mx-card p{white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:auto}.mx-check{display:flex;align-items:center;gap:8px}.mx-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.mx-revision-preview{min-height:0;font-size:16px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;background:var(--dsw-alias-bg-base);padding:10px 0}.mx-revision-hunk{display:block;position:relative;border:0;border-radius:0;margin:0;padding:0;white-space:normal;background:transparent}.mx-revision-text{white-space:pre-wrap;overflow-wrap:anywhere}.mx-diff-new,.mx-polish-new{border-inline-start:2px solid var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);padding:0 72px 0 10px;min-height:1.9em}.mx-diff-old,.mx-polish-original{border-inline-start:2px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);padding:0 10px;color:var(--dsw-alias-label-secondary)}.mx-change-actions{position:absolute;inset-block-start:0;inset-inline-end:3px;gap:3px}.mx-revision-hunk>.mx-stack:has(.mx-decision){position:absolute;inset-block-start:0;inset-inline-end:3px;gap:2px}.mx-original-context{padding:0 10px;border-inline-start:2px solid var(--dsw-alias-border-l2);font-size:13px;color:var(--dsw-alias-label-secondary)}.mx-insertion-spot{background:transparent;color:var(--dsw-alias-brand-primary);font-size:12px}.mx-revision-analysis{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
.mx-root .mx-decision{display:inline-flex;align-items:center;justify-content:center;flex:0 0 32px;width:32px;height:32px;min-height:32px;padding:0;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;line-height:1}.mx-root .mx-decision svg{display:block;flex:none;pointer-events:none}.mx-root .mx-decision-accept{color:var(--dsw-alias-state-success-primary)}.mx-root .mx-decision-reject{color:var(--dsw-alias-state-error-primary)}.mx-root .mx-decision-accept:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}.mx-root .mx-decision-reject:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 50%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}.mx-root .mx-decision:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mx-selection-popup{position:fixed;inset:auto;margin:0;z-index:900;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 6px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);overflow:auto}.mx-selection-popup .mx-actions{gap:6px}.mx-selection-popup .mx-actions>button{flex:0 1 auto}.mx-selection-popup:popover-open{display:flex}.mx-selection-popup:not(:popover-open){display:none}.mx-job-terminal{max-width:min(100%,55ch);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mx-job-terminal[role=alert]{color:var(--dsw-alias-state-error-primary)}.mx-job-poll button{font-size:12px;min-height:28px;padding:3px 7px}.mx-review-notice{font-size:12px;gap:6px}.mx-review-notice strong{font-weight:500}.mx-revision-hunk[data-state=rejected]>.mx-diff-new{background:transparent;border-inline-start-color:var(--dsw-alias-border-l2)}.mx-summary-preview{min-height:0;padding:0}.mx-polish-preview{min-height:0}.mx-polish-block h3{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0}.mx-polish-new{border-radius:0}.mx-polish-original{margin:0;padding-block:0;border-top:0}
.mx-modal-shell{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 85%,transparent)}.mx-modal{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:24px;width:560px;max-width:100%;max-height:90vh;overflow:auto}.mx-modal .mx-actions{justify-content:flex-end;margin-top:20px}.mx-foot{margin-top:24px;padding:16px 0;border-top:1px solid var(--dsw-alias-border-l1)}
@container(max-width:850px){.mx-grid[data-chapters=true]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(4rem,20%) minmax(0,1fr)}.mx-partner-row{grid-template-columns:minmax(0,1fr)}.mx-partner-row>.mx-actions{grid-column:1;grid-row:auto}.mx-cards{grid-template-columns:minmax(0,1fr)}}
@container(max-width:520px){.mx-model-row>.mx-field,.mx-model-row>button{flex-basis:100%;width:100%}.mx-compare,.mx-form-grid{grid-template-columns:minmax(0,1fr)}.mx-panel{padding:12px}.mx-header h1{font-size:21px}.mx-partner-row{grid-template-columns:minmax(0,1fr);gap:6px}.mx-partner-row .mx-field{gap:2px}.mx-partner-meta{gap:4px}.mx-partner-meta>span:first-child{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mx-writing-partner{padding:4px 0}.mx-partner-row>.mx-actions>button{min-height:28px;padding:4px 8px}.mx-result-chooser{max-width:180px}.mx-root .mx-result-chooser select{max-width:130px}.mx-actions>button{flex-grow:1}}
.mx-root-writing{display:flex;flex-direction:column;overflow:auto;gap:8px;padding-block:12px}.mx-root-writing>.mx-header{flex:none;margin:0}.mx-root-writing>.mx-header h1{font-size:18px}.mx-root-writing>.mx-header>div:first-child>.mx-hint{display:none}.mx-save-controls{gap:4px}.mx-root-writing>.mx-banner{flex:none;max-height:18%;overflow:auto;margin:0;padding:6px 10px}.mx-root-writing .mx-book-workspace{flex:1 0 32rem;min-height:32rem;overflow:hidden;gap:6px}.mx-root-writing .mx-book-workspace>.mx-book-row,.mx-root-writing .mx-tabs{flex:none}.mx-root-writing .mx-tabs{margin:0;padding:2px 0 5px}.mx-book-tools{flex:0 1 auto;min-height:0;max-height:30%;overflow:auto}.mx-book-tools .mx-foot{margin:0;padding:6px 0}.mx-root-writing .mx-writing-host{display:flex;flex:1;min-height:0;overflow:hidden}.mx-root-writing .mx-grid{flex:1;min-width:0;min-height:0;overflow:hidden}.mx-editor-panel{flex:1 0 20rem;min-height:20rem;overflow:auto;gap:8px;padding:12px}.mx-editor-panel> :not(.mx-body-slot){flex:none}.mx-body-slot{display:flex;flex-direction:column;flex:1 0 16rem;min-height:16rem;overflow:hidden}.mx-body-slot>.mx-field{flex:1;min-height:0}.mx-body-slot .mx-editor{flex:1;min-height:0;height:0;resize:none}.mx-body-slot>.mx-revision-preview,.mx-body-slot>.mx-stack{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.mx-legacy-recovery{flex:none;max-height:25%;overflow:auto}
@media(max-height:640px){.mx-root.mx-root-writing{display:block;overflow:auto}.mx-root-writing .mx-book-workspace,.mx-root-writing .mx-writing-host,.mx-root-writing .mx-grid,.mx-root-writing .mx-writing-column{overflow:visible}.mx-root-writing .mx-writing-host{min-height:28rem}.mx-writing-partner,.mx-partner-advanced,.mx-book-tools{max-height:none}.mx-editor-panel{min-height:26rem}.mx-chapter-nav{max-height:10rem}}
@media(max-width:600px){.mx-root{padding:12px}.mx-modal-shell{padding:16px}}
.mx-root [hidden]{display:none!important}.mx-surface-bar{display:flex;flex:none;align-items:center;flex-wrap:wrap;gap:6px;min-height:34px;padding-inline-start:var(--dsh-frame-leading-clearance,0px)}.mx-surface-bar>button{font-size:12px;min-height:28px;padding:4px 8px}.mx-root.mx-controls-folded{display:flex;flex-direction:column}.mx-controls-folded .mx-book-workspace{flex:1;min-height:0}.mx-controls-folded .mx-writing-host{min-height:0}.mx-controls-folded .mx-writing-column{overflow:hidden;gap:0}.mx-controls-folded .mx-editor-panel{flex:1;min-height:0}.mx-controls-folded .mx-body-slot{flex:1;min-height:16rem}
`;

    // UI return anchors are captured from the visible review at the author's decision,
    // not from a possibly absent/stale generation job or an old textarea scrollTop.
    function captureReviewReturn(snapshot, record, metrics = {}) {
      if (!snapshot || !snapshot.bookId || !snapshot.chapterId || record?.mode !== 'polish' || record.chapterId !== snapshot.chapterId || record.id !== snapshot.proposalId || JSON.stringify(record) !== snapshot.proposal ||
          !Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 1 || !validPolishRange(record.sourceBody, record.selection) || !Number.isFinite(metrics.screenY) || !Number.isSafeInteger(metrics.intent)) return null;
      const position = value => Number.isFinite(value) && value >= 0 ? value : 0;
      return Object.freeze({ bookId: snapshot.bookId, chapterId: snapshot.chapterId, proposalId: record.id, candidateId: snapshot.candidateId,
        sourceRevision: record.sourceRevision, sourceBody: record.sourceBody, ...record.selection, screenY: metrics.screenY, intent: metrics.intent,
        ports: Object.freeze(['root', 'panel', 'column'].map(name => Object.freeze({ name, top: position(metrics[name]?.top), left: position(metrics[name]?.left) }))) });
    }
    function reviewReturnPlan(anchor, settlement, context = {}) {
      const proposal = context.proposal;
      if (!anchor || !settlement || context.blocked || context.dirty || context.reviewActive || context.intent !== anchor.intent ||
          context.bookId !== anchor.bookId || context.chapterId !== anchor.chapterId || context.candidateId !== anchor.candidateId || context.displayRecordId !== anchor.proposalId ||
          proposal?.id !== anchor.proposalId || proposal.id !== settlement.proposalId || proposal.mode !== 'polish' || JSON.stringify(proposal) !== settlement.proposal ||
          proposal.sourceRevision !== anchor.sourceRevision || proposal.sourceBody !== anchor.sourceBody ||
          proposal.selection?.start !== anchor.start || proposal.selection?.end !== anchor.end || proposal.selection?.text !== anchor.text ||
          proposal.state !== (settlement.accept ? 'accepted' : 'rejected') || context.chapter !== settlement.chapter ||
          context.body !== settlement.expectedBody || context.savedBody !== settlement.expectedBody) return null;
      const expected = settlement.accept ? anchor.sourceBody.slice(0, anchor.start) + proposal.text + anchor.sourceBody.slice(anchor.end) : anchor.sourceBody;
      if (expected !== settlement.expectedBody) return null;
      return { caret: textareaValue(anchor.sourceBody.slice(0, anchor.start)).length, screenY: anchor.screenY, ports: anchor.ports };
    }
    function reviewReturnScroll(metrics, screenY) {
      if (!metrics || ![metrics.caretTop, metrics.editorTop, metrics.borderTop, metrics.clientHeight, metrics.scrollHeight, metrics.lineHeight, metrics.paddingTop, metrics.paddingBottom, screenY].every(Number.isFinite) || metrics.clientHeight <= 0) return null;
      const top = metrics.editorTop + metrics.borderTop + metrics.paddingTop;
      const bottom = Math.max(top, metrics.editorTop + metrics.borderTop + metrics.clientHeight - metrics.paddingBottom - metrics.lineHeight);
      const target = Math.max(top, Math.min(screenY, bottom));
      return Math.max(0, Math.min(metrics.scrollHeight - metrics.clientHeight, metrics.editorTop + metrics.borderTop + metrics.caretTop - target));
    }
    function measureTextareaCaret(editor, caret, ownedRoot) {
      if (!editor || !ownedRoot || !ownedRoot.contains(editor) || !(editor.clientWidth > 0) || !Number.isSafeInteger(caret) || caret < 0 || caret > editor.value.length) return null;
      const doc = editor.ownerDocument, computed = doc.defaultView.getComputedStyle(editor), mirror = doc.createElement('div'), clip = doc.createElement('div');
      const properties = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'fontFeatureSettings', 'fontVariationSettings', 'fontKerning', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'textAlign', 'textRendering', 'tabSize', 'overflowWrap', 'wordBreak', 'hyphens', 'direction', 'writingMode', 'lineBreak', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
      for (const property of properties) mirror.style[property] = computed[property];
      Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: '0', top: '0', width: editor.clientWidth + 'px', height: 'auto', minHeight: '0', maxHeight: 'none', boxSizing: 'border-box', border: '0', margin: '0', overflow: 'visible', whiteSpace: editor.wrap === 'off' ? 'pre' : computed.whiteSpace || 'pre-wrap', overflowAnchor: 'none' });
      Object.assign(clip.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', overflow: 'hidden', contain: 'strict', visibility: 'hidden', pointerEvents: 'none' });
      clip.setAttribute('aria-hidden', 'true'); clip.inert = true;
      mirror.setAttribute('aria-hidden', 'true');
      mirror.appendChild(doc.createTextNode(editor.value.slice(0, caret)));
      const marker = doc.createElement('span'); marker.textContent = editor.value.slice(caret) || '\u200b'; mirror.appendChild(marker);
      clip.appendChild(mirror);
      try {
        ownedRoot.appendChild(clip);
        const rect = marker.getClientRects()[0], box = mirror.getBoundingClientRect();
        if (!rect || !Number.isFinite(rect.top) || !(rect.height > 0)) return null;
        return { caretTop: rect.top - box.top, lineHeight: parseFloat(computed.lineHeight) || rect.height,
          borderTop: parseFloat(computed.borderTopWidth) || 0, paddingTop: parseFloat(computed.paddingTop) || 0, paddingBottom: parseFloat(computed.paddingBottom) || 0 };
      } finally { clip.remove(); }
    }

    function Field({ label, hint, children }) {
      return h('label', { className: 'mx-field' }, h('span', null, label), children, hint && h('span', { className: 'mx-hint' }, hint));
    }
    function Icon({ size = 18 } = {}) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 4.5h7a3 3 0 0 1 3 3V20a4 4 0 0 0-3-1.5H4zM14 7.5l5-4 2 2-5 4M14 12h6v6.5h-3' }),
        h('path', { d: 'M7 9h4M7 12h4M7 15h3' }));
    }
    function Modal({ title, children, actions, onCancel, busy }) {
      const ref = useRef(null), cancelRef = useRef(null);
      useEffect(() => {
        const old = document.activeElement;
        cancelRef.current?.focus();
        return () => { if (old?.isConnected && typeof old.focus === 'function') old.focus(); };
      }, []);
      const onKeyDown = e => {
        e.stopPropagation();
        if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel(); }
        if (e.key === 'Tab') {
          const items = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')];
          if (!items.length) { e.preventDefault(); return; }
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        }
      };
      return h('div', { className: 'mx-modal-shell' }, h('section', { className: 'mx-modal mx-stack', ref, role: 'alertdialog', 'aria-modal': true, 'aria-label': title, onKeyDown },
        h('h2', null, title), children, h('div', { className: 'mx-actions' }, actions(cancelRef))));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'inspiration: locale');
        const t = ctx.locale.bind(NS);
        const subscribeLocale = listener => ctx.locale.subscribe(listener);
        const localeSnapshot = () => ctx.locale.getSnapshot();
        // Memory is a fallback when storage is unavailable, and lasts across panel unmounts.
        let memoryDrafts = new Map(), memoryJobs = new Map();
        const deletedBookIds = new Set();

        function App() {
          const locale = useSyncExternalStore(subscribeLocale, localeSnapshot, localeSnapshot);
          const [w, setW] = useState(null), current = useRef(null);
          const [books, setBooks] = useState([]), [model, setModel] = useState(null);
          const [modelPrefs, setModelPrefs] = useState({ settings: null, draft: null, available: false, conflict: false });
          const modelPrefsRef = useRef(modelPrefs), modelSaveRef = useRef(false), modelSettingsEpoch = useRef(0);
          const [modelSaving, setModelSaving] = useState(false), [catalogVersion, setCatalogVersion] = useState(0);
          const [catalog, setCatalog] = useState({ key: '', providers: [], models: [], details: null, loading: true, error: '' });
          const catalogRef = useRef(catalog), catalogSequence = useRef(0), catalogController = useRef(null);
          const commitModelPrefs = next => { modelPrefsRef.current = next; setModelPrefs(next); };
          const commitCatalog = next => { catalogRef.current = next; setCatalog(next); };
          const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
          const [error, setError] = useState(null), [notice, setNotice] = useState('');
          const [tab, setTab] = useState('writing'), [newTitle, setNewTitle] = useState(''), [newChapter, setNewChapter] = useState('');
          const [mode, setMode] = useState('draft'), [instruction, setInstruction] = useState('');
          const [advanced, setAdvanced] = useState(false);
          const [chaptersVisible, setChaptersVisible] = useState(false);
          const [controlsFolded, setControlsFolded] = useState(false);
          const rootRef = useRef(null), panelRef = useRef(null), columnRef = useRef(null);
          const pendingPolishViewport = useRef(null), returnIntent = useRef(0);
          const invalidateReviewReturn = () => { returnIntent.current++; pendingPolishViewport.current = null; };
          const [restoreEpoch, setRestoreEpoch] = useState(0);
          // Preview is derived from the durable selected proposal, so reloads and
          // completed-job selection reopen it when the source is current and clean.
          // These keys dismiss completed review identities; pending reviews have no manual view toggle.
          const [originalReviewKey, updateOriginalReviewKey] = useState(null);
          const reviewRef = useRef(null);
          const setOriginalReviewKey = value => { reviewRef.current = null; updateOriginalReviewKey(value); };
          const [originalPolishKey, updateOriginalPolishKey] = useState(null);
          const setOriginalPolishKey = value => { reviewRef.current = null; updateOriginalPolishKey(value); };
          const [selectionPopup, setSelectionPopup] = useState(null), [polishRequirements, setPolishRequirements] = useState(null);
          const popupRef = useRef(null), requirementsRef = useRef(null), polishBlockRef = useRef(null);
          const [selection, setSelection] = useState(null), [context, setContext] = useState(null), [contextBusy, setContextBusy] = useState(false);
          const [job, setJob] = useState(null), [pollError, setPollError] = useState(false), [pollVersion, setPollVersion] = useState(0);
          const [recovery, setRecovery] = useState(null), recoveryRef = useRef(null);
          const [storageFailed, setStorageFailed] = useState(false), [conflict, setConflict] = useState(null);
          const [guard, setGuard] = useState(null), [confirm, setConfirm] = useState(null);
          const [manager, setManager] = useState(null), [deletionNotice, setDeletionNotice] = useState(null);
          const [cleanupPendingCount, setCleanupPendingCount] = useState(0);
          const editorRef = useRef(null), composing = useRef(false), alive = useRef(false), busyRef = useRef(false);
          const epoch = useRef(0), availabilityEpoch = useRef(0), listSequence = useRef(0), contextSequence = useRef(0), selectionRef = useRef(null);
          const requests = useRef(new Set()), downloads = useRef(new Map()), liveJobs = useRef([]), pendingLatest = useRef(null), unavailableBooks = useRef(new Map());
          const formId = useRef('inspiration-' + Math.random().toString(36).slice(2));

          const commit = next => { current.current = next; setW(next); };
          const assignRecovery = value => { recoveryRef.current = value; setRecovery(value); };
          const messageError = e => {
            if (!alive.current || e?.name === 'AbortError') return;
            setError({ code: e?.code || '', message: e?.message || t('requestFailed') });
          };
          const forgetDraft = bookId => {
            memoryDrafts.delete(bookId);
            try { localStorage.removeItem(STORAGE + bookId); } catch { setStorageFailed(true); }
          };
          const persist = value => {
            if (!value || deletedBookIds.has(value.book.id) || !isDirty(value)) return;
            const payload = recoveryPayload(value);
            memoryDrafts.set(value.book.id, payload);
            try { localStorage.setItem(STORAGE + value.book.id, JSON.stringify(payload)); if (alive.current) setStorageFailed(false); }
            catch { if (alive.current) setStorageFailed(true); }
          };
          const readRecovery = bookId => {
            if (deletedBookIds.has(bookId)) return null;
            let value = memoryDrafts.get(bookId);
            if (!value) {
              try { const raw = localStorage.getItem(STORAGE + bookId); if (raw) value = JSON.parse(raw); }
              catch { setStorageFailed(true); }
            }
            return validRecovery(value, bookId) ? value : null;
          };
          const rememberJob = value => {
            if (!value?.bookId || deletedBookIds.has(value.bookId)) return;
            liveJobs.current = liveJobs.current.filter(j => j.id !== value.id && !(j.bookId === value.bookId && j.status === 'running'));
            if (value.status === 'running') liveJobs.current.push(value);
            if (value?.status === 'running') {
              const info = { id: value.id, bookId: value.bookId, chapterId: value.chapterId, status: 'running', mode: value.mode, sourceRevision: value.sourceRevision, selection: value.mode === 'polish' ? value.selection : undefined, text: '' };
              memoryJobs.set(value.bookId, info);
              try { localStorage.setItem(JOB_STORAGE + value.bookId, JSON.stringify(info)); } catch { /* live list can recover jobs too */ }
            } else if (value?.bookId) {
              memoryJobs.delete(value.bookId);
              try { localStorage.removeItem(JOB_STORAGE + value.bookId); } catch { /* not author data */ }
            }
          };
          const readJob = bookId => {
            if (deletedBookIds.has(bookId)) return null;
            const live = liveJobs.current.find(j => j.bookId === bookId);
            if (live) return live;
            if (memoryJobs.has(bookId)) return memoryJobs.get(bookId);
            try { const stored = JSON.parse(localStorage.getItem(JOB_STORAGE + bookId) || 'null'); if (stored?.bookId === bookId && typeof stored.id === 'string') return stored; } catch { /* optional resume */ }
            return null;
          };
          const call = useCallback(async (action, args = {}, outerSignal) => {
            if (!alive.current) throw new DOMException('Panel unmounted', 'AbortError');
            const controller = new AbortController();
            requests.current.add(controller);
            const abort = () => controller.abort();
            if (outerSignal?.aborted) controller.abort(); else outerSignal?.addEventListener('abort', abort, { once: true });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
            try {
              const response = await fetch('/api/ycx-inspiration', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-inspiration-Request': '1' }, body: JSON.stringify({ action, ...args }), signal: controller.signal });
              let payload;
              try { payload = await response.json(); } catch { throw Object.assign(new Error(t('requestFailed') + ' (HTTP ' + response.status + ')'), { code: 'RESPONSE' }); }
              if (!response.ok || payload?.ok !== true) throw Object.assign(new Error(payload?.error?.message || t('requestFailed')), { code: payload?.error?.code || 'HTTP_' + response.status });
              return payload.data;
            } catch (e) {
              if (e?.code) throw e;
              if (controller.signal.aborted && !timedOut) throw e;
              throw Object.assign(new Error(t('networkError')), { code: 'NETWORK' });
            } finally {
              clearTimeout(timer); requests.current.delete(controller); outerSignal?.removeEventListener('abort', abort);
            }
          }, []);
          const changeModelDraft = value => {
            if (modelSaveRef.current || busyRef.current) return;
            // Invalidate immediately, before React's catalog effect can start the next request.
            if (modelRouteKey(value) !== modelRouteKey(modelPrefsRef.current.draft) || (value === null) !== (modelPrefsRef.current.draft === null)) {
              catalogSequence.current++; catalogController.current?.abort();
            }
            commitModelPrefs({ ...modelPrefsRef.current, draft: value });
          };
          const reloadModelPreference = async () => {
            if (modelSaveRef.current || busyRef.current) return;
            modelSaveRef.current = true; setModelSaving(true); modelSettingsEpoch.current++;
            try {
              const data = await call('list');
              if (!alive.current) return;
              commitModelPrefs(receiveModelSettings(modelPrefsRef.current, data.modelSettings, true));
              setModel(data.model || null); setCatalogVersion(v => v + 1);
              if (!validModelSettings(data.modelSettings)) throw new Error(t('modelFeatureUnavailable'));
            } catch (e) { if (alive.current) commitModelPrefs({ ...modelPrefsRef.current, conflict: true }); messageError(e); }
            finally { modelSettingsEpoch.current++; modelSaveRef.current = false; if (alive.current) setModelSaving(false); }
          };
          const applyModelPreference = async () => {
            const prefs = modelPrefsRef.current;
            if (modelSaveRef.current || busyRef.current || !prefs.available || !prefs.settings || prefs.conflict) return;
            const problem = modelCatalogProblem(prefs.draft, catalogRef.current);
            if (problem) { setError({ message: t(problem) }); return; }
            modelSaveRef.current = true; setModelSaving(true); modelSettingsEpoch.current++;
            try {
              const data = await call('setModel', { selection: prefs.draft, expectedRevision: prefs.settings.revision });
              if (!alive.current) return;
              if (!validModelSettings(data.modelSettings) || !sameModelSelection(data.modelSettings.selection, prefs.draft) || data.modelSettings.revision <= prefs.settings.revision) throw new Error(t('modelSettingsConflict'));
              commitModelPrefs(receiveModelSettings(modelPrefsRef.current, data.modelSettings, true));
              setModel(data.model || null);
            } catch (e) {
              // A failed/ambiguous write never discards choices or blindly retries an old revision.
              if (alive.current) commitModelPrefs({ ...modelPrefsRef.current, conflict: true });
              messageError(e);
            } finally { modelSettingsEpoch.current++; modelSaveRef.current = false; if (alive.current) setModelSaving(false); }
          };
          const refreshList = async () => {
            const seq = ++listSequence.current, modelEpoch = modelSettingsEpoch.current;
            const data = await call('list');
            if (!alive.current || seq !== listSequence.current) return null;
            unavailableBooks.current = reconcileBookAvailability(unavailableBooks.current, data.books, seq);
            const available = id => bookIsAvailable(id, deletedBookIds, unavailableBooks.current);
            const visible = { ...data, books: data.books.filter(b => available(b.id)), activeJobs: (data.activeJobs || []).filter(j => available(j.bookId)) };
            setBooks(visible.books); liveJobs.current = visible.activeJobs;
            if (!modelSaveRef.current && modelEpoch === modelSettingsEpoch.current) {
              setModel(visible.model || null);
              commitModelPrefs(receiveModelSettings(modelPrefsRef.current, visible.modelSettings));
            }
            setCleanupPendingCount(Number.isSafeInteger(data.cleanupPending) && data.cleanupPending > 0 ? data.cleanupPending : 0);
            return visible;
          };
          const refreshWorkspace = () => transition(() => withBusy(async () => {
            const data = await refreshList(), active = current.current;
            if (!data) return;
            if (active && !data.books.some(book => book.id === active.book.id)) {
              // An external deletion or an ambiguous earlier request is not a
              // deletion receipt: preserve the displayed copy and local drafts.
              const missing = markBookUnavailable({ unavailable: unavailableBooks.current, pendingLatest: pendingLatest.current }, active.book.id, listSequence.current);
              unavailableBooks.current = missing.unavailable; pendingLatest.current = missing.pendingLatest; epoch.current++; availabilityEpoch.current++;
              persist(active); setError({ code: 'NOT_FOUND', message: t('bookMissing') }); return;
            }
            if (active) await openBook(active.book.id, active.chapterId);
            else if (data.books.length) await openBook(data.books[0].id);
          }));
          const syncBookList = book => setBooks(previous => {
            if (!bookIsAvailable(book.id, deletedBookIds, unavailableBooks.current)) return previous;
            const entry = { id: book.id, title: book.title, chapterCount: book.chapters.length, updatedAt: book.updatedAt };
            return previous.some(b => b.id === book.id) ? previous.map(b => b.id === book.id ? entry : b) : [...previous, entry];
          });
          const resetSelection = () => { setSelectionPopup(null); setPolishRequirements(null); selectionRef.current = null; setSelection(null); setContext(null); setContextBusy(false); contextSequence.current++; };
          const openBook = async (bookId, preferredChapter) => {
            if (!bookIsAvailable(bookId, deletedBookIds, unavailableBooks.current)) return false;
            const serial = ++epoch.current;
            setLoading(true); setError(null); setNotice(''); setConflict(null); pendingLatest.current = null; resetSelection();
            try {
              const book = await call('get', { bookId });
              if (!alive.current || epoch.current !== serial || !bookIsAvailable(book.id, deletedBookIds, unavailableBooks.current)) return false;
              commit(workspace(book, preferredChapter)); syncBookList(book); assignRecovery(readRecovery(book.id));
              setJob(readJob(book.id)); setPollError(false); setPollVersion(value => value + 1); setTab('writing');
              return true;
            } catch (e) { if (serial === epoch.current) messageError(e); return false; }
            finally { if (alive.current && epoch.current === serial) setLoading(false); }
          };
          const adopt = (book, cleared) => {
            const active = current.current;
            if (!active || active.book.id !== book.id || !bookIsAvailable(book.id, deletedBookIds, unavailableBooks.current)) return false;
            if (book.revision < active.book.revision) return false;
            const conflicts = conflictingFields(active, book).filter(kind => kind !== cleared);
            if (conflicts.length) { setConflict({ book, fields: conflicts }); persist(active); return false; }
            commit(mergeWorkspace(active, book, cleared)); syncBookList(book); setConflict(null); setContext(null);
            return true;
          };
          const loadLatest = async () => {
            const active = current.current, serial = epoch.current;
            if (!active) return;
            const book = await call('get', { bookId: active.book.id });
            if (!alive.current || epoch.current !== serial || current.current?.book.id !== book.id) return;
            // A poll read must not re-introduce old edits during an in-flight save.
            if (busyRef.current) { pendingLatest.current = book; return; }
            adopt(book);
          };
          const withBusy = async action => {
            if (busyRef.current || loading) return false;
            busyRef.current = true; setBusy(true); setError(null);
            try { await action(); return true; }
            catch (e) { messageError(e); return false; }
            finally {
              busyRef.current = false;
              if (alive.current) {
                setBusy(false);
                const waiting = pendingLatest.current; pendingLatest.current = null;
                if (waiting && waiting.id === current.current?.book.id && waiting.revision >= current.current.book.revision) adopt(waiting);
              }
            }
          };
          const mutateRaw = async (operation, cleared) => {
            const active = current.current, serial = epoch.current;
            const book = await call('mutate', { bookId: active.book.id, expectedRevision: active.book.revision, operation });
            if (!alive.current || epoch.current !== serial || current.current?.book.id !== book.id) return null;
            if (!adopt(book, cleared)) throw Object.assign(new Error(t('conflictTitle')), { code: 'CONFLICT' });
            return book;
          };
          const saveAll = async () => {
            if (!current.current || conflict) return false;
            const ok = await withBusy(async () => {
              let active = current.current;
              if (dirty(active).chapter) {
                await mutateRaw({ action: 'updateChapter', chapterId: active.chapterId, patch: patchOf(active.baseChapter, active.chapter) }, 'chapter');
              }
              active = current.current;
              if (dirty(active).settings) {
                const patch = patchOf(active.baseSettings, active.settings);
                if ('contextBudget' in patch) {
                  patch.contextBudget = Number(patch.contextBudget);
                  if (!Number.isSafeInteger(patch.contextBudget) || patch.contextBudget < 1000 || patch.contextBudget > 60000) throw new Error(t('invalidBudget'));
                }
                await mutateRaw({ action: 'updateBook', patch }, 'settings');
              }
              active = current.current;
              if (dirty(active).card) {
                const card = { ...active.card, fromChapter: Number(active.card.fromChapter), toChapter: active.card.toChapter.trim() === '' ? null : Number(active.card.toChapter), tags: active.card.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean) };
                if (!Number.isSafeInteger(card.fromChapter) || card.fromChapter < 1 || (card.toChapter !== null && (!Number.isSafeInteger(card.toChapter) || card.toChapter < card.fromChapter))) throw new Error(t('invalidScope'));
                await mutateRaw({ action: 'saveCard', card }, 'card');
              }
              active = current.current;
              if (dirty(active).candidate) await mutateRaw({ action: 'updateProposal', proposalId: active.candidateId, text: active.candidate }, 'candidate');
              if (alive.current) { forgetDraft(current.current.book.id); assignRecovery(null); setNotice(t('saved')); }
            });
            if (!ok && current.current) persist(current.current);
            return ok;
          };
          const discardScope = scope => {
            const active = current.current;
            if (!active) return;
            if (scope === 'candidate') commit({ ...active, candidate: active.baseCandidate });
            else if (scope === 'card') commit({ ...active, card: active.baseCard });
            else { commit(workspace(active.book, active.chapterId)); setConflict(null); }
            if (!isDirty(current.current)) forgetDraft(active.book.id); else persist(current.current);
          };
          const transition = (run, scope = 'all') => {
            if (busyRef.current || loading) return;
            invalidateReviewReturn();
            const d = dirty(current.current);
            if (scope === 'all' ? isDirty(current.current) : d[scope]) setGuard({ run, scope });
            else run();
          };
          const changeChapter = chapterId => transition(() => {
            const active = current.current;
            if (!active || active.chapterId === chapterId) return;
            epoch.current++; commit(workspace(active.book, chapterId)); resetSelection(); setError(null); setNotice(''); setConflict(null); setTab('writing');
          });
          const download = (filename, mime, text) => {
            const url = URL.createObjectURL(new Blob([text], { type: mime }));
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
            const timer = setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 1500);
            downloads.current.set(url, timer);
          };
          const downloadLocal = () => {
            const payload = current.current && isDirty(current.current) ? recoveryPayload(current.current) : recoveryRef.current;
            if (payload) download('inspiration-local-edits.json', 'application/json', JSON.stringify(payload, null, 2));
          };
          const changeField = (group, field, value) => {
            if (busyRef.current) return;
            const active = current.current;
            const multiline = ['body', 'summary', 'outline', 'premise', 'style', 'content'].includes(field);
            const nextValue = multiline ? applyTextareaEdit(active[group][field], value) : value;
            commit({ ...active, [group]: { ...active[group], [field]: nextValue } });
            if (group === 'chapter' && field === 'body') resetSelection();
            setNotice('');
          };
          const closeSelectionPopup = () => setSelectionPopup(null);
          const captureSelection = event => {
            const node = editorRef.current, active = current.current;
            if (!node || !active?.chapter) return;
            // Toolbar focus and the requirements dialog must not re-read or
            // collapse a captured range. A fresh editor gesture captures a new intent.
            if (event?.type === 'blur' && (popupRef.current?.contains(event.relatedTarget) || polishRequirements)) return;
            if (composing.current || event?.isComposing || event?.nativeEvent?.isComposing) { closeSelectionPopup(); return; }
            const captured = textareaValue(active.chapter.body) === node.value ? capturePolishSnapshot(active, node.selectionStart, node.selectionEnd) : null;
            const snapshot = equal(captured, selectionRef.current) ? selectionRef.current : captured;
            if (!equal(snapshot, selectionRef.current)) { selectionRef.current = snapshot; setSelection(snapshot); setContext(null); setContextBusy(false); contextSequence.current++; }
            const decision = selectionPopupDecision({ start: node.selectionStart, end: node.selectionEnd, composing: composing.current,
              event: event?.type || 'select', key: event?.key || '' });
            if (!snapshot || decision === 'close') { closeSelectionPopup(); return; }
            if (decision === 'open') {
              const rect = node.getBoundingClientRect();
              const anchor = { x: event?.type === 'mouseup' ? event.clientX : undefined,
                y: event?.type === 'mouseup' ? event.clientY : undefined,
                rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } };
              const position = selectionPopupPosition({ ...anchor, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
              if (position) setSelectionPopup({ snapshot, anchor, position });
            }
          };
          const selectedSource = () => {
            const snapshot = selectionRef.current, active = current.current;
            // Sidebar polish uses the same immutable source identity as the popup.
            if (polishIntentProblem(active, snapshot)) return null;
            return { start: snapshot.start, end: snapshot.end, text: snapshot.text };
          };
          const polishRequestProblem = snapshot => polishIntentProblem(current.current, snapshot, {
            recovery: recoveryRef.current, conflict, intent: selectionRef.current, composing: composing.current, busy: busyRef.current || loading || !!manager || !!guard || !!confirm,
            running: job?.status === 'running' || liveJobs.current.some(j => j.bookId === snapshot?.bookId && (j.status === 'running' || j.settled === false)),
            unavailable: !!snapshot && !bookIsAvailable(snapshot.bookId, deletedBookIds, unavailableBooks.current),
            modelProblem: modelGenerationProblem(modelPrefsRef.current, catalogRef.current, modelSaveRef.current) || (!model?.provider || !model?.model ? 'noModel' : ''),
          });
          const startPolish = (snapshot, direction, custom = false) => {
            // Selection alone NEVER calls the API. This is reached only by an
            // explicit toolbar/sidebar click or explicit requirements submission.
            const problem = polishRequestProblem(snapshot);
            if (problem || custom && !direction.trim()) { setError({ message: t(problem || 'polishRequirement') }); return; }
            const expectedModelRevision = modelPrefsRef.current.settings.revision;
            invalidateReviewReturn();
            return withBusy(async () => {
              const blocked = polishIntentProblem(current.current, snapshot, { recovery: recoveryRef.current, conflict, intent: selectionRef.current, composing: composing.current,
                running: job?.status === 'running', modelProblem: modelGenerationProblem(modelPrefsRef.current, catalogRef.current, modelSaveRef.current) });
              if (blocked || modelPrefsRef.current.settings?.revision !== expectedModelRevision) throw new Error(t(blocked || 'modelSettingsConflict'));
              const picked = { start: snapshot.start, end: snapshot.end, text: snapshot.text };
              let data;
              try {
                reviewRef.current = null;
              data = await call('generate', { bookId: snapshot.bookId, chapterId: snapshot.chapterId,
                  expectedRevision: snapshot.bookRevision, expectedModelRevision, mode: 'polish', instruction: direction, selection: picked });
              } catch (e) {
                if (e.code === 'MODEL_CONFLICT') { commitModelPrefs({ ...modelPrefsRef.current, conflict: true }); throw Object.assign(new Error(t('modelSettingsConflict')), { code: e.code }); }
                throw e;
              }
              const next = { id: data.jobId, bookId: snapshot.bookId, chapterId: snapshot.chapterId, status: 'running',
                mode: 'polish', sourceRevision: snapshot.chapterRevision, selection: picked, text: '' };
              rememberJob(next);
              if (alive.current && current.current?.book.id === snapshot.bookId) {
                setJob(next); setPollError(false); setOriginalPolishKey(null); closeSelectionPopup(); setPolishRequirements(null);
                setMode('polish'); setInstruction(direction); setNotice('');
              }
            });
          };
          const contextKey = () => JSON.stringify([current.current?.book.id, current.current?.book.revision, current.current?.chapterId, mode, instruction, selectionRef.current]);
          const previewContext = async () => {
            if (!current.current || isDirty(current.current) || busyRef.current) return;
            const picked = mode === 'polish' ? selectedSource() : null;
            if (mode === 'polish' && !picked) { setError({ message: t('polishFirst') }); return; }
            if (mode === 'revise' && !instruction.trim()) { setError({ message: t('reviseRequirement') }); return; }
            const key = contextKey(), seq = ++contextSequence.current, active = current.current;
            setContextBusy(true); setError(null);
            try {
              const data = await call('context', { bookId: active.book.id, chapterId: active.chapterId, mode, instruction, selection: picked });
              if (alive.current && contextSequence.current === seq && contextKey() === key) { setContext({ key, data }); setAdvanced(true); }
            } catch (e) { if (seq === contextSequence.current) messageError(e); }
            finally { if (alive.current && seq === contextSequence.current) setContextBusy(false); }
          };
          const generate = () => mode === 'polish' ? startPolish(selectionRef.current, instruction.trim() ? instruction : t('polishDefaultDirection')) : withBusy(async () => {
            const active = current.current;
            if (isDirty(active)) throw new Error(t('saveFirst'));
            if (mode === 'revise' && !instruction.trim()) throw new Error(t('reviseRequirement'));
            const modelProblem = modelGenerationProblem(modelPrefsRef.current, catalogRef.current, modelSaveRef.current);
            if (modelProblem) throw new Error(t(modelProblem));
            const picked = mode === 'polish' ? selectedSource() : null;
            if (mode === 'polish' && !picked) throw new Error(t('polishFirst'));
            let data;
            try {
              reviewRef.current = null;
              invalidateReviewReturn();
              data = await call('generate', { bookId: active.book.id, chapterId: active.chapterId, expectedRevision: active.book.revision, expectedModelRevision: modelPrefsRef.current.settings.revision, mode, instruction, selection: picked });
            } catch (e) {
              if (e.code === 'MODEL_CONFLICT') {
                // The model revision guard is read-only; keep prose and model choices intact.
                commitModelPrefs({ ...modelPrefsRef.current, conflict: true });
                throw Object.assign(new Error(t('modelSettingsConflict')), { code: e.code });
              }
              throw e;
            }
            const next = { id: data.jobId, bookId: active.book.id, chapterId: active.chapterId, status: 'running', mode, sourceRevision: chapterOf(active)?.revision, selection: picked, text: '' };
            rememberJob(next);
            if (alive.current && current.current?.book.id === active.book.id) { setJob(next); setPollError(false); setNotice(''); }
          });
          const create = () => transition(() => withBusy(async () => {
            const book = await call('create', { title: newTitle.trim() });
            if (!alive.current) return;
            epoch.current++; commit(workspace(book)); syncBookList(book); setNewTitle(''); setTab('writing'); setJob(null); assignRecovery(null); setConflict(null); resetSelection(); setNotice(t('created'));
          }));
          const addChapter = () => transition(() => withBusy(async () => {
            const previousIds = new Set(current.current.book.chapters.map(c => c.id));
            const book = await mutateRaw({ action: 'addChapter', title: newChapter.trim() });
            if (!book) return;
            const added = book.chapters.find(c => !previousIds.has(c.id));
            epoch.current++; commit(workspace(book, added?.id)); setNewChapter(''); resetSelection(); setTab('writing');
          }));
          const doImport = file => {
            if (!file) return;
            if (file.size > 40 * 1024 * 1024) { setError({ message: t('importTooLarge') }); return; }
            transition(() => withBusy(async () => {
              const text = await file.text();
              if (!alive.current) return;
              const book = await call('import', { text });
              if (!alive.current) return;
              epoch.current++; commit(workspace(book)); syncBookList(book); setJob(null); setTab('writing'); assignRecovery(null); setConflict(null); resetSelection(); setNotice(t('imported'));
            }));
          };
          const exportBook = format => withBusy(async () => {
            const data = await call('export', { bookId: current.current.book.id, format });
            if (alive.current) download(data.filename, data.mime, data.text);
          });
          const beginManagement = () => {
            if (recoveryRef.current) { setError({ message: t('manageRecovery') }); return; }
            transition(() => {
              const active = current.current;
              if (!active) return;
              if (conflict || isDirty(active)) { setError({ message: t('manageUnsaved') }); return; }
              setError(null);
              setManager({ snapshot: managementSnapshot(active), title: active.book.title, typedTitle: '', uncertain: false });
            });
          };
          const renameManagedBook = () => withBusy(async () => {
            const problem = managementProblem(current.current, manager.snapshot, recoveryRef.current, conflict);
            if (problem) throw new Error(t(problem));
            const title = manager.title.trim();
            if (!title || title.length > 300 || title === manager.snapshot.title) return;
            await mutateRaw({ action: 'updateBook', patch: { title } });
            if (alive.current) { setManager(null); setNotice(t('renamed')); }
          });
          // This follow-up has its own failure state: an acknowledged deletion
          // cannot become a "delete failed" error just because list/get failed.
          const refreshDeletedLibrary = async () => {
            const refreshed = await refreshAfterBookDeletion(refreshList, () => !!current.current, openBook);
            if (alive.current) setDeletionNotice(previous => previous && ({ ...previous, refreshFailed: !refreshed }));
          };
          const deleteManagedBook = () => withBusy(async () => {
            const reviewed = manager.snapshot;
            const problem = deletionProblem(current.current, reviewed, manager.typedTitle, { recovery: recoveryRef.current, conflict, jobs: [job, ...liveJobs.current] });
            if (problem || manager.uncertain) throw new Error(t(problem || 'deleteUncertain'));
            let result;
            try {
              result = await call('delete', { bookId: reviewed.bookId, expectedRevision: reviewed.revision, confirmTitle: manager.typedTitle });
            } catch (e) {
              if (['NETWORK', 'RESPONSE'].includes(e.code)) {
                if (alive.current) setManager(previous => previous && ({ ...previous, uncertain: true }));
                throw Object.assign(new Error(t('deleteUncertain')), { code: e.code });
              }
              if (e.code === 'BUSY' || e.code === 'CONFLICT') throw Object.assign(new Error(t(e.code === 'BUSY' ? 'deleteBusy' : 'confirmChanged')), { code: e.code });
              throw e;
            }
            if (!deletionReceipt(reviewed, result)) {
              if (alive.current) setManager(previous => previous && ({ ...previous, uncertain: true }));
              throw new Error(t('deleteUnconfirmed'));
            }
            const previous = { books, workspace: current.current, job, recovery: recoveryRef.current, selection: selectionRef.current, context,
              activeJobs: liveJobs.current, pendingLatest: pendingLatest.current, drafts: memoryDrafts, rememberedJobs: memoryJobs };
            const next = afterBookDeletion(previous, reviewed, result), id = reviewed.bookId;
            // Tombstone before clearing state so late list/get/poll/unmount work
            // cannot revive the deleted book or write its draft back to storage.
            deletedBookIds.add(id); listSequence.current++;
            memoryDrafts = next.drafts; memoryJobs = next.rememberedJobs;
            let localCleanupPending = false;
            for (const key of [STORAGE + id, JOB_STORAGE + id]) {
              try { localStorage.removeItem(key); } catch { localCleanupPending = true; }
            }
            liveJobs.current = next.activeJobs; pendingLatest.current = next.pendingLatest;
            if (!alive.current) return;
            setBooks(previousBooks => previousBooks.filter(b => b.id !== id));
            setJob(next.job); assignRecovery(next.recovery);
            if (previous.workspace?.book.id === id) {
              epoch.current++; commit(next.workspace); resetSelection(); setConflict(null); setPollError(false);
              setNewChapter(''); setInstruction(''); setTab('writing');
            }
            setManager(null); setConfirm(null); setGuard(null); setNotice('');
            setDeletionNotice({ title: reviewed.title, cleanupPending: result.cleanupPending, localCleanupPending, refreshFailed: false });
            await refreshDeletedLibrary();
          });
          const inspectConflict = () => withBusy(async () => {
            const active = current.current;
            const book = await call('get', { bookId: active.book.id });
            if (alive.current && current.current?.book.id === book.id) setConflict({ book, fields: conflictingFields(current.current, book) });
          });
          const restoreRecovery = () => {
            const value = recoveryRef.current, active = current.current;
            if (!value || !active) return;
            if ((value.dirty.chapter && !active.book.chapters.some(c => c.id === value.chapterId)) || (value.dirty.candidate && !active.book.proposals.some(p => p.id === value.candidateId))) { setError({ message: t('recoveryMissing') }); return; }
            const next = workspace(active.book, value.dirty.chapter || value.dirty.candidate ? value.chapterId : active.chapterId);
            for (const [kind, fields] of [['chapter', ['chapter', 'baseChapter']], ['settings', ['settings', 'baseSettings']], ['card', ['card', 'baseCard']], ['candidate', ['candidateId', 'candidate', 'baseCandidate']]]) {
              if (value.dirty[kind]) for (const field of fields) next[field] = value[field];
            }
            commit(next); assignRecovery(null); resetSelection(); setNotice(t('recoveryRestored'));
            const fields = conflictingFields(next, active.book);
            setConflict(fields.length ? { book: active.book, fields } : null);
          };
          const chooseCandidate = id => transition(() => {
            const active = current.current, p = active.book.proposals.find(item => item.id === id);
            if (p) { commit({ ...active, candidateId: p.id, candidate: p.text, baseCandidate: p.text }); if (job?.status !== 'running') setJob(null); }
          }, 'candidate');
          const chooseCard = card => transition(() => {
            const active = current.current, value = card ? cardFields(card) : blankCard();
            commit({ ...active, card: value, baseCard: value });
          }, 'card');
          const confirmMutation = (title, body, operation, label, renderedSnapshot = null) => {
            const reviewed = renderedSnapshot || reviewSnapshot(current.current, operation);
            if (!reviewIsCurrent(current.current, reviewed) || isDirty(current.current) || recoveryRef.current || conflict) { setError({ message: t('confirmChanged') }); return; }
            setConfirm({ title, body, label, run: () => withBusy(async () => {
              // A poll or another actor may have changed the saved candidate while
              // the confirmation was open. Never adopt a newer revision implicitly.
              if (!reviewIsCurrent(current.current, reviewed) || isDirty(current.current) || recoveryRef.current || conflict) throw Object.assign(new Error(t('confirmChanged')), { code: 'REVIEW_REQUIRED' });
              await mutateRaw(operation);
              if (alive.current) { setConfirm(null); resetSelection(); setNotice(t('saved')); }
            }) });
          };

          const capturePolishReturn = snapshot => {
            const record = current.current?.book.proposals.find(p => p.id === snapshot.proposalId), block = polishBlockRef.current;
            if (!block || block.dataset.proposalId !== snapshot.proposalId || !rootRef.current?.contains(block)) return null;
            const position = node => ({ top: node?.scrollTop || 0, left: node?.scrollLeft || 0 });
            try { return captureReviewReturn(snapshot, record, { screenY: block.getBoundingClientRect().top, intent: returnIntent.current,
              root: position(rootRef.current), panel: position(panelRef.current), column: position(columnRef.current) }); } catch { return null; }
          };
          const queuePolishViewport = (snapshot, saved, accept, anchor) => {
            const record = saved.proposals.find(p => p.id === snapshot.proposalId), savedChapter = saved.chapters.find(c => c.id === snapshot.chapterId);
            if (!anchor || anchor.intent !== returnIntent.current || !savedChapter || record?.mode !== 'polish' || record.id !== anchor.proposalId) return;
            pendingPolishViewport.current = { anchor, proposalId: record.id, proposal: JSON.stringify(record), accept,
              expectedBody: savedChapter.body, chapter: JSON.stringify(savedChapter) };
            setRestoreEpoch(value => value + 1);
          };
          const applyPolish = (snapshot, accept) => {
            // The visible Accept/Reject control is the explicit author decision. Bind the click to
            // exactly what was rendered, never silently save candidate edits first.
            const blocked = visibleReviewProblem(snapshot, reviewRef.current) || polishActionProblem(current.current, snapshot, { recovery: recoveryRef.current, conflict, accept,
              unavailable: !bookIsAvailable(snapshot?.bookId, deletedBookIds, unavailableBooks.current), busy: busyRef.current || loading || !!manager || !!guard || !!confirm });
            if (blocked) { setError({ message: t(blocked) }); return; }
            return withBusy(async () => {
              const problem = visibleReviewProblem(snapshot, reviewRef.current) || polishActionProblem(current.current, snapshot, { recovery: recoveryRef.current, conflict, accept, unavailable: !bookIsAvailable(snapshot?.bookId, deletedBookIds, unavailableBooks.current) });
              if (problem) throw Object.assign(new Error(t(problem)), { code: 'REVIEW_REQUIRED' });
              const returnAnchor = capturePolishReturn(snapshot);
              const saved = await mutateRaw({ action: accept ? 'acceptProposal' : 'rejectProposal', proposalId: snapshot.proposalId });
              if (alive.current && saved) { queuePolishViewport(snapshot, saved, accept, returnAnchor); setOriginalPolishKey(JSON.stringify([snapshot.bookId, snapshot.chapterId, snapshot.proposalId, 'polish'])); resetSelection(); setNotice(t(accept ? 'polishSaved' : 'polishRejected')); }
            });
          };

          const applyGenerated = (snapshot, accept) => {
            const options = () => ({ recovery: recoveryRef.current, conflict, accept,
              unavailable: !bookIsAvailable(snapshot?.bookId, deletedBookIds, unavailableBooks.current) });
            const blocked = visibleReviewProblem(snapshot, reviewRef.current) || generatedActionProblem(current.current, snapshot, { ...options(), busy: busyRef.current || loading || !!manager || !!guard || !!confirm });
            if (blocked) { setError({ message: t(blocked) }); return; }
            return withBusy(async () => {
              const problem = visibleReviewProblem(snapshot, reviewRef.current) || generatedActionProblem(current.current, snapshot, options());
              if (problem) throw Object.assign(new Error(t(problem)), { code: 'REVIEW_REQUIRED' });
              const saved = await mutateRaw({ action: accept ? 'acceptProposal' : 'rejectProposal', proposalId: snapshot.proposalId });
              if (alive.current && saved) { setOriginalReviewKey(JSON.stringify([snapshot.bookId, snapshot.chapterId, snapshot.proposalId, 'generated'])); resetSelection(); setNotice(t('saved')); }
            });
          };

          const applyRevisionAll = snapshot => {
            const options = () => ({ recovery: recoveryRef.current, conflict, unavailable: !bookIsAvailable(snapshot?.bookId, deletedBookIds, unavailableBooks.current) });
            const blocked = visibleReviewProblem(snapshot, reviewRef.current) || bulkRevisionProblem(current.current, snapshot, { ...options(), busy: busyRef.current || loading || !!manager || !!guard || !!confirm });
            if (blocked) { setError({ message: t(blocked) }); return; }
            return withBusy(async () => {
              const problem = visibleReviewProblem(snapshot, reviewRef.current) || bulkRevisionProblem(current.current, snapshot, options());
              if (problem) throw Object.assign(new Error(t(problem)), { code: 'REVIEW_REQUIRED' });
              const saved = await mutateRaw({ action: 'acceptRevisionAll', proposalId: snapshot.proposalId });
              if (alive.current && saved) { setOriginalReviewKey(JSON.stringify([snapshot.bookId, snapshot.chapterId, snapshot.proposalId])); resetSelection(); setNotice(t('saved')); }
            });
          };

          const applyRevisionHunk = (snapshot, accept) => {
            // The inline Accept button is itself explicit author confirmation. Capture the
            // reviewed identity at render time, not from a possibly newer book
            // when clicked, and never launch a second whole-proposal modal.
            const blocked = visibleReviewProblem(snapshot, reviewRef.current) || revisionActionProblem(current.current, snapshot, { recovery: recoveryRef.current, conflict, busy: busyRef.current || loading || !!manager || !!guard || !!confirm });
            if (blocked) { setError({ message: t(blocked) }); return; }
            return withBusy(async () => {
              const problem = visibleReviewProblem(snapshot, reviewRef.current) || revisionActionProblem(current.current, snapshot, { recovery: recoveryRef.current, conflict });
              if (problem) throw Object.assign(new Error(t(problem)), { code: 'REVIEW_REQUIRED' });
              const saved = await mutateRaw({ action: accept ? 'acceptRevisionHunk' : 'rejectRevisionHunk', proposalId: snapshot.proposalId, hunkId: snapshot.hunkId });
              if (alive.current && saved) { resetSelection(); setNotice(t(accept ? 'revisionSaved' : 'revisionRejected')); }
            });
          };

          useEffect(() => {
            alive.current = true;
            let stopped = false;
            (async () => {
              try {
                const data = await refreshList();
                if (stopped || !data) return;
                if (data.books.length) await openBook(data.books[0].id);
                else setLoading(false);
              } catch (e) { messageError(e); if (!stopped) setLoading(false); }
            })();
            const leave = e => {
              persist(current.current);
              if (isDirty(current.current)) { e.preventDefault(); e.returnValue = ''; }
            };
            const pagehide = () => persist(current.current);
            window.addEventListener('beforeunload', leave); window.addEventListener('pagehide', pagehide);
            return () => {
              persist(current.current); stopped = true; alive.current = false; epoch.current++; contextSequence.current++; listSequence.current++;
              for (const controller of requests.current) controller.abort();
              for (const [url, timer] of downloads.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
              downloads.current.clear();
              window.removeEventListener('beforeunload', leave); window.removeEventListener('pagehide', pagehide);
            };
          }, []);
          useEffect(() => {
            closeSelectionPopup(); setPolishRequirements(null);
          }, [w?.book.id, w?.book.revision, w?.chapterId, w?.chapter?.body, tab]);
          useEffect(() => {
            const dismiss = event => {
              if (event?.type === 'scroll' && event.target?.nodeType && popupRef.current?.contains(event.target)) return;
              closeSelectionPopup();
            };
            const outside = e => { if (!popupRef.current?.contains(e.target) && e.target !== editorRef.current) dismiss(); };
            const changed = () => { if (document.activeElement === editorRef.current) captureSelection(); };
            const released = event => { if (document.activeElement === editorRef.current && event.target !== editorRef.current && !popupRef.current?.contains(event.target)) captureSelection(event); };
            window.addEventListener('scroll', dismiss, true); window.addEventListener('resize', dismiss);
            document.addEventListener('pointerdown', outside); document.addEventListener('selectionchange', changed); document.addEventListener('mouseup', released);
            return () => {
              window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss);
              document.removeEventListener('pointerdown', outside); document.removeEventListener('selectionchange', changed); document.removeEventListener('mouseup', released);
            };
          }, []);
          useEffect(() => {
            const node = popupRef.current;
            if (!selectionPopup || !node) return;
            // Native top-layer popover avoids fixed-position containment by the
            // workbench's container queries; no portal or second React root.
            if (typeof node.showPopover === 'function' && !node.matches(':popover-open')) node.showPopover();
            const rect = node.getBoundingClientRect();
            const position = selectionPopupPosition({ ...selectionPopup.anchor, viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight, width: rect.width || 320, height: rect.height || 132 });
            if (position && !equal(position, selectionPopup.position)) setSelectionPopup(previous => previous && ({ ...previous, position }));
          }, [selectionPopup]);
          useEffect(() => {
            if (!modelPrefs.available) return;
            const picked = modelPrefsRef.current.draft;
            const controller = new AbortController(); catalogController.current?.abort(); catalogController.current = controller;
            const request = { sequence: ++catalogSequence.current, key: modelRouteKey(picked) };
            const fresh = () => alive.current && catalogRequestIsCurrent(catalogSequence.current, request, modelPrefsRef.current.draft, controller.signal.aborted);
            let partial = { key: request.key, providers: [], models: [], details: null, loading: true, error: '' };
            commitCatalog(partial);
            const check = data => {
              if (!Array.isArray(data.providers) || !Array.isArray(data.models) || data.details != null && !Array.isArray(data.details.efforts)) throw new Error(t('modelCatalogError'));
              return data;
            };
            (async () => {
              try {
                // Keep independent provider/model catalogs even if a saved exact route vanished.
                const root = await call('models', {}, controller.signal);
                if (!fresh()) return;
                check(root); partial = { ...partial, providers: root.providers };
                const providerQuery = modelCatalogRequest(picked, partial);
                if (!providerQuery) { commitCatalog({ ...partial, loading: false }); return; }
                commitCatalog(partial);
                const providerData = await call('models', providerQuery, controller.signal);
                if (!fresh()) return;
                check(providerData); partial = { ...partial, models: providerData.models };
                const detailQuery = modelCatalogRequest(picked, partial, true);
                if (!detailQuery) { commitCatalog({ ...partial, loading: false }); return; }
                commitCatalog(partial);
                const exact = await call('models', detailQuery, controller.signal);
                if (!fresh()) return;
                check(exact);
                commitCatalog({ ...partial, details: exact.details, loading: false });
              } catch (e) {
                if (fresh()) commitCatalog({ ...partial, details: null, loading: false, error: e?.message || t('modelCatalogError') });
              }
            })();
            return () => { controller.abort(); };
          }, [modelPrefs.available, modelPrefs.draft === null, modelPrefs.draft?.provider, modelPrefs.draft?.model, catalogVersion]);
          useEffect(() => { if (isDirty(w)) persist(w); }, [w]);
          useEffect(() => { contextSequence.current++; setContext(null); setContextBusy(false); }, [mode, instruction, w?.book.id, w?.book.revision, w?.chapterId]);
          useEffect(() => {
            if (!job?.id || job.bookId !== w?.book.id || job.status !== 'running') return;
            const controller = new AbortController(), id = job.id, bookId = job.bookId, serial = availabilityEpoch.current;
            let stopped = false, timer;
            // Chapter navigation must not cancel a book-wide generation. Only
            // an unavailable-book observation invalidates this poll generation.
            const stillValid = () => !stopped && alive.current && current.current?.book.id === bookId && availabilityEpoch.current === serial && bookIsAvailable(bookId, deletedBookIds, unavailableBooks.current);
            const poll = async () => {
              try {
                const value = await call('job', { jobId: id }, controller.signal);
                if (!stillValid()) return;
                setJob(value); setPollError(false); rememberJob(value);
                if (value.status === 'completed') {
                  setNotice(t('generationFinished'));
                  try {
                    const latest = await call('get', { bookId }, controller.signal);
                    if (!stillValid()) return;
                    if (busyRef.current) pendingLatest.current = latest;
                    else if (adopt(latest) && value.chapterId === current.current.chapterId && !isDirty(current.current) && !recoveryRef.current && !conflict) {
                      const p = latest.proposals.find(item => item.id === value.proposalId);
                      if (p) commit({ ...current.current, candidateId: p.id, candidate: p.text, baseCandidate: p.text });
                    }
                  } catch (e) { if (stillValid()) messageError(e); }
                } else if (value.status === 'running') timer = setTimeout(poll, 1000);
              } catch (e) {
                if (!stillValid() || e?.name === 'AbortError') return;
                if (e.code === 'NOT_FOUND') { rememberJob({ bookId, status: 'failed' }); setJob(previous => previous?.id === id ? { ...previous, status: 'failed', error: e.message } : previous); }
                else { setPollError(true); timer = setTimeout(poll, 2500); }
              }
            };
            poll();
            return () => { stopped = true; clearTimeout(timer); controller.abort(); };
          // Do not depend on status: publishing "completed" must not abort the
          // subsequent durable-book fetch from this same polling iteration.
          }, [job?.id, w?.book.id, pollVersion]);

          const d = dirty(w), anyDirty = isDirty(w), chapter = chapterOf(w), selectedProposal = proposalOf(w);
          const displayRecord = generatedDisplayRecord(w, selectedProposal, job, { recovery, conflict });
          const awaitingOutcome = displayRecord === job && !!job;
          const proposal = awaitingOutcome ? null : displayRecord;
          // Resolve the previous recovery copy before new typing can overwrite it.
          const locked = busy || loading || !!recovery || !!manager, running = job?.status === 'running';
          const manageProblem = manager && managementProblem(w, manager.snapshot, recovery, conflict);
          const deleteProblem = manager && deletionProblem(w, manager.snapshot, manager.typedTitle, { recovery, conflict, jobs: [job, ...liveJobs.current] });
          const canPolish = mode !== 'polish' || !!selectedSource();
          const modelDraftDirty = !!modelPrefs.settings && !sameModelSelection(modelPrefs.draft, modelPrefs.settings.selection);
          const modelProblem = modelGenerationProblem(modelPrefs, catalog, modelSaving);
          const catalogProblem = modelCatalogProblem(modelPrefs.draft, catalog);
          const modelControlsLocked = locked || modelSaving;
          const modeKeys = { draft: 'modeDraft', continue: 'modeContinue', polish: 'modePolish', summary: 'modeSummary', revise: 'modeRevise' };
          const modeHint = value => t(({ draft: 'draftHint', continue: 'continueHint', polish: 'polishHint', summary: 'summaryModeHint', revise: 'reviseHint' })[value] || 'aiSafety');
          const activePolishJob = job?.mode === 'polish' && job.bookId === w?.book.id && job.chapterId === w?.chapterId &&
            (job.status === 'running' || job.status === 'completed' && !w?.book.proposals.some(p => p.id === job.proposalId));
          const polishRecord = awaitingOutcome && job.mode !== 'polish' ? null : polishDisplayRecord(w, proposal, job);
          const polish = polishView(w, polishRecord), isPolish = proposal?.mode === 'polish';
          const polishDecision = polishPreviewDecision(w, polishRecord, originalPolishKey, { recovery, conflict });
          const polishKey = polishDecision.key, polishPreviewVisible = polishDecision.visible;
          const polishPreviewLabel = polish?.durable && polishRecord.state !== 'ready' ? 'polishHistoryPreview' : 'polishPreview';
          const polishRenderedSnapshot = isPolish ? polishActionSnapshot(w, proposal) : null;
          const polishProblem = isPolish ? polishActionProblem(w, polishRenderedSnapshot, { recovery, conflict, unavailable: !!w && !bookIsAvailable(w.book.id, deletedBookIds, unavailableBooks.current), busy: locked || !!guard || !!confirm }) : '';
          const polishRejectProblem = isPolish ? polishActionProblem(w, polishRenderedSnapshot, { recovery, conflict, accept: false, unavailable: !!w && !bookIsAvailable(w.book.id, deletedBookIds, unavailableBooks.current), busy: locked || !!guard || !!confirm }) : '';
          const popupProblem = selectionPopup ? polishRequestProblem(selectionPopup.snapshot) : '';
          const requirementsProblem = polishRequirements ? polishRequestProblem(polishRequirements.snapshot) : '';
          const revision = revisionView(proposal), isRevision = proposal?.mode === 'revise';
          const revisionDecision = revisionPreviewDecision(w, proposal, originalReviewKey, { recovery, conflict });
          const revisionKey = revisionDecision.key, revisionPreviewVisible = revisionDecision.visible && !!revision?.counts.pending && !polishPreviewVisible;
          const generated = generatedReviewView(w, displayRecord);
          const generatedDecision = generatedPreviewDecision(w, displayRecord, originalReviewKey, { recovery, conflict });
          const generatedKey = generatedDecision.key, generatedVisible = generatedDecision.visible;
          const generatedManuscript = generatedVisible && displayRecord.mode !== 'summary';
          reviewRef.current = proposal ? { bookId: w.book.id, chapterId: w.chapterId, proposalId: proposal.id,
            visible: isRevision ? revisionPreviewVisible : isPolish ? polishPreviewVisible : generatedVisible,
            blocked: running || awaitingOutcome || locked || !!guard || !!confirm } : null;
          const bulkSnapshot = isRevision ? bulkRevisionSnapshot(w, proposal) : isPolish ? polishRenderedSnapshot : generatedActionSnapshot(w, proposal);
          const bulkOpts = { recovery, conflict, busy: locked || running || awaitingOutcome || !!guard || !!confirm };
          const bulkProblem = isRevision ? bulkRevisionProblem(w, bulkSnapshot, bulkOpts) : isPolish ? polishActionProblem(w, bulkSnapshot, bulkOpts) : generatedActionProblem(w, bulkSnapshot, bulkOpts);
          const bulkVisible = proposal?.state === 'ready' && !!bulkSnapshot;
          const bulkPreview = isRevision ? revisionPreviewVisible : isPolish ? polishPreviewVisible : generatedVisible;
          // Only exceptional blockers need a compact inline message; no edit/review mode banner.
          const inlineReviewProblem = proposal?.state === 'ready' && !bulkPreview && !(isRevision && revision && !revision.counts.pending)
            ? recovery ? 'manageRecovery' : anyDirty || conflict ? 'saveFirst' : isRevision && !revision ? 'revisionInvalid' : staleProposal(w, proposal) ? 'stale' : '' : '';
          const requirementMissing = mode === 'revise' && !instruction.trim();
          useEffect(() => {
            // Bring a deep selection into view ONCE, never on every stream delta.
            if (polishPreviewVisible) polishBlockRef.current?.scrollIntoView({ block: 'nearest' });
          }, [polishPreviewVisible, polishRecord?.id]);
          useLayoutEffect(() => {
            const pending = pendingPolishViewport.current;
            if (!pending || busy || loading) return;
            const active = current.current, savedChapter = chapterOf(active);
            const record = active?.book.proposals.find(p => p.id === pending.proposalId);
            const plan = reviewReturnPlan(pending.anchor, pending, { bookId: active?.book.id, chapterId: active?.chapterId,
              candidateId: active?.candidateId, displayRecordId: displayRecord?.id, intent: returnIntent.current,
              body: active?.chapter?.body, savedBody: savedChapter?.body, chapter: JSON.stringify(savedChapter), proposal: record,
              dirty: isDirty(active), reviewActive: polishPreviewVisible || revisionPreviewVisible || generatedManuscript,
              blocked: tab !== 'writing' || !!manager || !!guard || !!confirm || !!recovery || !!conflict || !alive.current || !bookIsAvailable(active?.book.id, deletedBookIds, unavailableBooks.current) });
            if (!plan) { pendingPolishViewport.current = null; return; }
            const editor = editorRef.current;
            if (!editor || editor.value !== textareaValue(pending.expectedBody)) return;
            const ports = { root: rootRef.current, panel: panelRef.current, column: columnRef.current };
            const restorePorts = () => { for (const position of plan.ports) if (ports[position.name]) { ports[position.name].scrollTop = position.top; ports[position.name].scrollLeft = position.left; } };
            restorePorts();
            let measured;
            try { measured = measureTextareaCaret(editor, plan.caret, rootRef.current); } catch { return; }
            if (!measured) return;
            const metrics = () => ({ ...measured, editorTop: editor.getBoundingClientRect().top, clientHeight: editor.clientHeight, scrollHeight: editor.scrollHeight });
            if (reviewReturnScroll(metrics(), plan.screenY) === null) return;
            editor.focus({ preventScroll: true });
            editor.setSelectionRange(plan.caret, plan.caret);
            restorePorts();
            const scrollTop = reviewReturnScroll(metrics(), plan.screenY);
            if (scrollTop === null) return;
            editor.scrollTop = scrollTop;
            pendingPolishViewport.current = null;
          }, [restoreEpoch, w?.book.id, w?.book.revision, w?.chapterId, w?.candidateId, w?.chapter?.body, displayRecord?.id, polishPreviewVisible, revisionPreviewVisible, generatedManuscript, controlsFolded, busy, loading, tab, manager, guard, confirm, recovery, conflict]);
          const formatDate = value => { try { return new Intl.DateTimeFormat(locale.active === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); } catch { return value || ''; } };
          const button = (label, onClick, props = {}) => h('button', { type: 'button', disabled: locked, onClick, ...props }, label);
          // Cursor-inspired compact line icons; native buttons retain disabled,
          // keyboard focus, localized accessible names and the exact review target.
          const decisionButton = (accept, label, onClick, props = {}) => button(
            h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
              strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
              h('path', { d: accept ? 'M5 12l4 4L19 6' : 'M6 6l12 12M18 6 6 18' })),
            onClick, { 'aria-label': label, title: label, ...props,
              className: 'mx-decision ' + (accept ? 'mx-decision-accept' : 'mx-decision-reject') + (props.className ? ' ' + props.className : '') });
          const input = (group, field, props = {}) => h('input', { value: w[group]?.[field] ?? '', disabled: locked || group === 'chapter' && revisionPreviewVisible || group === 'chapter' && polishPreviewVisible, onChange: e => changeField(group, field, e.target.value), ...props });
          const textarea = (group, field, props = {}) => h('textarea', { value: textareaValue(w[group]?.[field] ?? ''), readOnly: locked || group === 'chapter' && revisionPreviewVisible || group === 'chapter' && polishPreviewVisible, rows: 4, onChange: e => changeField(group, field, e.target.value), ...props });
          const select = (group, field, values) => h('select', { value: w[group][field], disabled: locked || group === 'chapter' && revisionPreviewVisible || group === 'chapter' && polishPreviewVisible, onChange: e => changeField(group, field, e.target.value) }, values.map(value => h('option', { key: value, value }, t(value))));
          const badge = (text, key) => h('span', { className: 'mx-badge', key }, text);
          const status = (text, tone) => h('span', { className: 'mx-status', 'data-tone': tone }, text);
          const renderReport = data => data && h('details', { className: 'mx-subpanel', open: true }, h('summary', null, t('contextTitle')),
            h('div', { className: 'mx-stack' },
              h('strong', null, t('budgetUsed', { used: data.report?.usedChars ?? 0, budget: data.report?.budget ?? 0 })), h('p', { className: 'mx-hint' }, t('contextNote')),
              ['warnings', 'included', 'omitted'].map(kind => (data.report?.[kind]?.length ? h('div', { key: kind }, h('h3', null, t(kind)), h('ul', null, data.report[kind].map((item, i) => h('li', { key: i, className: 'mx-hint' }, typeof item === 'string' ? item : item.label + ' · ' + t('chars', { count: item.chars }))))) : null)),
              data.prompt && h('details', null, h('summary', null, t('fullPrompt')), h('pre', null, data.prompt))));

          const renderVisibleText = (text, emptyLabel = 'revisionDeleted') => text ? visibleWhitespace(text).text : h('span', { className: 'mx-hint' }, t(emptyLabel));
          const renderOriginalContext = (source, item) => {
            const context = revisionContext(source, item);
            return h('div', { className: 'mx-original-context' }, h('span', { className: 'mx-hint' }, t('insertionContext')),
              context && h('div', { className: 'mx-revision-text' }, context.prefix,
                h('mark', { className: 'mx-insertion-spot' }, t('insertionSpot')), context.suffix));
          };
          const renderGeneratedActions = () => {
            if (!generated?.durable || displayRecord !== proposal || proposal.state !== 'ready') return null;
            const snapshot = generatedActionSnapshot(w, proposal);
            const opts = { recovery, conflict, busy: locked || !!guard || !!confirm };
            const acceptProblem = generatedActionProblem(w, snapshot, opts), rejectProblem = generatedActionProblem(w, snapshot, { ...opts, accept: false });
            return h('div', { className: 'mx-actions mx-change-actions' },
              decisionButton(true, t('accept'), () => applyGenerated(snapshot, true), { disabled: !!acceptProblem, title: acceptProblem ? t(acceptProblem) : t('accept') }),
              decisionButton(false, t('reject'), () => applyGenerated(snapshot, false), { disabled: !!rejectProblem, title: rejectProblem ? t(rejectProblem) : t('reject') }));
          };
          const renderGeneratedPreview = () => generated && h('div', { className: 'mx-revision-preview mx-generated-preview' + (displayRecord.mode === 'summary' ? ' mx-summary-preview' : ''), role: 'region', 'aria-label': t(modeKeys[displayRecord.mode]), 'aria-readonly': true },
            displayRecord.mode === 'summary' && h('p', { className: 'mx-hint' }, t('summaryOnly')),
            generated.prefix && h('span', { className: 'mx-revision-text' }, generated.prefix),
            h('section', { className: 'mx-revision-hunk' },
              h('span', { className: 'mx-hint' }, t(displayRecord.state === 'accepted' ? 'accepted' : displayRecord.state === 'rejected' ? 'rejected' : 'newTextLabel')),
              h('div', { className: 'mx-diff-new mx-revision-text' }, renderVisibleText(generated.newText, generated.durable ? 'revisionDeleted' : 'generating')),
              renderGeneratedActions(),
              !generated.durable && h('p', { className: 'mx-hint', role: 'status' }, t(displayRecord.status === 'running' ? 'generating' : 'polishAwaitProposal')),
              displayRecord.mode === 'continue' ? renderOriginalContext(generated.source, { start: generated.source.length, end: generated.source.length, before: '' }) :
                h('div', { className: 'mx-diff-old mx-revision-text' }, h('span', { className: 'mx-hint' }, t(displayRecord.mode === 'summary' ? 'summarySaved' : 'originalChapter')), '\n', renderVisibleText(displayRecord.mode === 'summary' ? chapter.summary : generated.source, displayRecord.mode === 'summary' ? 'noSummary' : 'empty')),
              generated.stale && h('p', { className: 'mx-hint', role: 'alert' }, t('stale'))));
          const renderPolishActions = (record = proposal, describedBy = formId.current + '-candidate') => {
            // No stream or completion-gap record may borrow a prior candidate's
            // author controls. Only the exact durable rendered proposal owns them.
            if (record?.mode !== 'polish' || record !== proposal || record.state !== 'ready' || !polishView(w, record)?.durable) return null;
            const snapshot = polishRenderedSnapshot;
            return h('div', { className: 'mx-stack' },
              polishProblem && h('p', { className: 'mx-hint', role: 'status' }, t(polishProblem)),
              h('div', { className: 'mx-actions' },
                decisionButton(true, t('polishAccept'), () => applyPolish(snapshot, true), { 'aria-describedby': describedBy, disabled: !!polishProblem, title: polishProblem ? t(polishProblem) : t('polishAccept') }),
                decisionButton(false, t('polishReject'), () => applyPolish(snapshot, false), { 'aria-describedby': describedBy, disabled: !!polishRejectProblem, title: polishRejectProblem ? t(polishRejectProblem) : t('polishReject') })));
          };
          const renderPolishPreview = () => !polish ? null : h('div', { className: 'mx-revision-preview mx-polish-preview', role: 'region', 'aria-label': t(polishPreviewLabel), 'aria-readonly': true },
            h('span', { className: 'mx-revision-text' }, polish.prefix),
            h('section', { ref: polishBlockRef, 'data-proposal-id': polishRecord.id, className: 'mx-revision-hunk mx-polish-block', 'aria-label': t('modePolish') },
              h('div', { id: formId.current + '-polish-' + polishRecord.id, className: 'mx-revision-text mx-polish-new', 'aria-live': 'off' }, renderVisibleText(polish.newText, polish.durable ? 'revisionDeleted' : 'polishProgress')),
              h('div', { className: 'mx-polish-original mx-revision-text', role: 'note', 'aria-label': t('originalPassage') }, renderVisibleText(polish.original, 'empty')),
              polish.stale && h('p', { className: 'mx-hint', role: 'alert' }, t('stale')),
              polish.durable && polishRecord.state === 'ready' && renderPolishActions(polishRecord, formId.current + '-polish-' + polishRecord.id)),
            h('span', { className: 'mx-revision-text' }, polish.suffix));
          const renderSelectionPopup = () => selectionPopup && !polishRequirements && h('div', {
            ref: popupRef, className: 'mx-selection-popup mx-stack', popover: 'manual', role: 'toolbar', 'aria-label': t('polishSelectionActions'),
            style: { left: selectionPopup.position.left, top: selectionPopup.position.top, width: selectionPopup.position.width, maxHeight: selectionPopup.position.maxHeight },
            onMouseDown: e => e.preventDefault(),
            onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSelectionPopup(); editorRef.current?.focus({ preventScroll: true }); } },
            onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== editorRef.current) closeSelectionPopup(); },
          }, h('div', { className: 'mx-actions' },
            button(t('polishAI'), () => startPolish(selectionPopup.snapshot, t('polishDefaultDirection')), { className: 'mx-primary', disabled: !!popupProblem, title: popupProblem ? t(popupProblem) : t('polishAI') }),
            button(t('polishCustom'), () => { const problem = polishRequestProblem(selectionPopup.snapshot); if (problem) { setError({ message: t(problem) }); return; } setPolishRequirements({ snapshot: selectionPopup.snapshot, text: '' }); closeSelectionPopup(); }, { disabled: !!popupProblem, 'aria-haspopup': 'dialog', title: popupProblem ? t(popupProblem) : t('polishCustom') }),
            button(t('close'), closeSelectionPopup, { disabled: false })),
            h('p', { className: 'mx-hint', role: 'status' }, popupProblem ? t(popupProblem) : t('polishSelectionOnly')));
          const renderRevisionPreview = () => {
            if (!revision) return h('p', { className: 'mx-banner mx-error', role: 'alert' }, t('revisionInvalid'));
            const snapshots = revisionHunkSnapshots(w, proposal);
            const pending = proposal.review.hunks.find(item => item.state === 'pending');
            const problem = pending ? revisionActionProblem(w, snapshots.get(pending.id), { recovery, conflict, busy: locked || !!guard || !!confirm }) : '';
            return h('div', { className: 'mx-stack' },
              h('p', { className: 'mx-hint', role: 'status' }, t('revisionCounts', revision.counts)),
              staleProposal(w, proposal) && h('p', { className: 'mx-banner', role: 'alert' }, t('stale')),
              (anyDirty || conflict) && h('p', { className: 'mx-hint' }, t('saveFirst')),
              !revision.pieces.some(piece => piece.kind === 'hunk') && h('p', { className: 'mx-banner mx-info', role: 'status' }, t('revisionNoChanges')),
              h('div', { className: 'mx-revision-preview', role: 'region', 'aria-label': t('revisionPreview') }, revision.pieces.map((piece, index) => {
                if (piece.kind === 'unchanged') return h('span', { key: 'text-' + index, className: 'mx-revision-text' }, piece.text);
                const item = piece.hunk, snapshot = snapshots.get(item.id);
                // Accepted text and rejected originals are ordinary prose; decorate pending changes only.
                if (item.state !== 'pending') return h('span', { key: item.id, className: 'mx-revision-text' }, piece.text);
                const number = proposal.review.hunks.indexOf(item) + 1, textId = formId.current + '-revision-' + item.id;
                return h('section', { key: item.id, className: 'mx-revision-hunk', 'data-state': item.state, 'aria-label': t('revisionHunk', { number, state: t(item.state === 'pending' ? 'ready' : item.state) }) },
                  h('div', { id: textId, className: 'mx-revision-text mx-diff-new' }, renderVisibleText(piece.text, item.state !== 'rejected' && !item.after ? 'revisionDeleted' : 'empty')),
                  h('div', { className: 'mx-actions mx-change-actions' },
                    item.state === 'pending' && decisionButton(true, t('revisionAcceptLabel', { number }), () => applyRevisionHunk(snapshot, true), { 'aria-label': t('revisionAcceptLabel', { number }), 'aria-describedby': textId, disabled: !!problem, title: problem ? t(problem) : t('revisionAccept') }),
                    item.state === 'pending' && decisionButton(false, t('revisionRejectLabel', { number }), () => applyRevisionHunk(snapshot, false), { 'aria-label': t('revisionRejectLabel', { number }), 'aria-describedby': textId, disabled: !!problem, title: problem ? t(problem) : t('revisionReject') })),
                  item.before ? h('div', { className: 'mx-diff-old mx-revision-text' }, h('span', { className: 'mx-hint' }, t('revisionBefore')), '\n', renderVisibleText(item.before)) : renderOriginalContext(proposal.sourceBody, item));
              })));
          };
          const renderEditor = () => h('section', { ref: panelRef, className: 'mx-panel mx-stack mx-editor-panel', 'aria-label': t('manuscript') },
            h('div', { hidden: folded, className: 'mx-row mx-row-between' }, h('h2', null, t('manuscript')), h('div', { className: 'mx-row' }, badge(t('revision', { number: chapter.revision })), status(t('chars', { count: w.chapter.body.length })))),
            h('div', { hidden: folded }, h(Field, { label: t('chapterTitle') }, input('chapter', 'title', { maxLength: 300 }))),
            h('div', { className: 'mx-body-slot' }, inlineReviewProblem && h('p', { className: 'mx-hint', role: 'status', style: { flex: 'none' } }, t(inlineReviewProblem)), polishPreviewVisible ? renderPolishPreview() : revisionPreviewVisible ? renderRevisionPreview() : generatedManuscript ? renderGeneratedPreview() : h(Field, { label: t('manuscript') }, textarea('chapter', 'body', {
              ref: editorRef, className: 'mx-editor', rows: 22, spellCheck: true,
              onSelect: captureSelection, onMouseUp: captureSelection, onKeyUp: captureSelection, onBlur: captureSelection,
              onKeyDown: e => { if (e.key === 'Escape') closeSelectionPopup(); if (e.key === 'Tab' && !e.shiftKey && selectionPopup) { const first = popupRef.current?.querySelector('button:not(:disabled)'); if (first) { e.preventDefault(); first.focus({ preventScroll: true }); } } },
               onCompositionStart: () => { composing.current = true; closeSelectionPopup(); }, onCompositionEnd: () => { composing.current = false; captureSelection(); },
            }))), 
            h('details', { open: generatedVisible && displayRecord.mode === 'summary' ? true : undefined }, h('summary', null, t('summary')), h('div', { className: 'mx-stack' },
              generatedVisible && displayRecord.mode === 'summary' && renderGeneratedPreview(),
              status(t(chapter.summary && chapter.summaryRevision === chapter.revision ? 'summaryCurrent' : 'summaryStale'), chapter.summary && chapter.summaryRevision === chapter.revision ? 'success' : 'warn'),
              h(Field, { label: t('summary'), hint: t('summaryHint') }, textarea('chapter', 'summary', { rows: 5 })),
              chapter.summary && chapter.summaryRevision !== chapter.revision && button(t('confirmSummary'), () => confirmMutation(t('confirmSummary'), t('confirmSummaryHint'), { action: 'updateChapter', chapterId: chapter.id, patch: { summary: chapter.summary } }, t('confirmSummary')), { disabled: locked || anyDirty || !!conflict }))));
          const renderModelPicker = () => {
            const picked = modelPrefs.draft, custom = picked !== null;
            const matchesRoute = catalog.key === modelRouteKey(picked);
            const providers = matchesRoute ? catalog.providers : [], models = matchesRoute ? catalog.models : [];
            const details = matchesRoute && catalog.details?.provider === picked?.provider && catalog.details?.id === picked?.model ? catalog.details : null;
            const efforts = details?.efforts || [];
            const unavailableOption = id => h('option', { value: id, disabled: true }, t('modelUnavailableOption', { id }));
            return h('section', { className: 'mx-subpanel mx-stack mx-model-picker', 'aria-label': t('modelPicker'), 'aria-busy': modelSaving || catalog.loading },
              h('div', { className: 'mx-row mx-row-between' }, h('h3', null, t('modelPicker')), modelPrefs.available && modelPrefs.settings && status(t(modelDraftDirty || modelPrefs.conflict ? 'modelDraft' : 'modelSaved'), modelDraftDirty || modelPrefs.conflict ? 'warn' : 'success')),
              h('p', { className: 'mx-hint' }, t('modelScope')),
              h('div', { className: 'mx-model-row' },
                h(Field, { label: t('modelMode') }, h('select', { value: custom ? 'custom' : 'default', disabled: modelControlsLocked || !modelPrefs.available, onChange: e => changeModelDraft(e.target.value === 'default' ? null : { provider: '', model: '' }) }, h('option', { value: 'default' }, t('modelFollowDefault')), h('option', { value: 'custom' }, t('modelCustom'))))),
              custom && h('div', { className: 'mx-model-row' },
                h(Field, { label: t('modelProvider') }, h('select', { value: picked.provider, disabled: modelControlsLocked || !modelPrefs.available, onChange: e => changeModelDraft({ provider: e.target.value, model: '' }) }, h('option', { value: '', disabled: true }, t('modelChooseProvider')), picked.provider && !providers.some(p => p.id === picked.provider) && unavailableOption(picked.provider), providers.map(p => h('option', { key: p.id, value: p.id }, p.name || p.id)))),
                h(Field, { label: t('modelName') }, h('select', { value: picked.model, disabled: modelControlsLocked || !modelPrefs.available || !picked.provider || catalog.loading || !matchesRoute, onChange: e => changeModelDraft({ provider: picked.provider, model: e.target.value }) }, h('option', { value: '', disabled: true }, t('modelChooseModel')), picked.model && !models.some(m => m.provider === picked.provider && m.id === picked.model) && unavailableOption(picked.model), models.filter(m => m.provider === picked.provider).map(m => h('option', { key: m.id, value: m.id }, m.name || m.id))))),
              custom && efforts.length > 0 && h('div', { className: 'mx-model-row' }, h(Field, { label: t('modelReasoning') }, h('select', { value: picked.reasoningEffort || '', disabled: modelControlsLocked || catalog.loading, onChange: e => changeModelDraft({ provider: picked.provider, model: picked.model, ...(e.target.value ? { reasoningEffort: e.target.value } : {}) }) }, h('option', { value: '' }, t('modelProviderDefault')), picked.reasoningEffort && !efforts.some(e => e.id === picked.reasoningEffort) && unavailableOption(picked.reasoningEffort), efforts.map(e => h('option', { key: e.id, value: e.id }, e.name || e.id))))),
              // Keep an unsupported saved effort visible even when the provider advertises no efforts.
              custom && picked.reasoningEffort && !efforts.length && h('div', { className: 'mx-stack' }, h('p', { className: 'mx-hint' }, t('modelUnavailableOption', { id: picked.reasoningEffort })), button(t('modelProviderDefault'), () => changeModelDraft({ provider: picked.provider, model: picked.model }), { disabled: modelControlsLocked })), 
              modelProblem && h('p', { className: 'mx-hint', role: 'status' }, t(modelProblem)),
              catalogProblem && catalogProblem !== modelProblem && h('p', { className: 'mx-hint', role: 'status' }, t(catalogProblem)),
              !modelPrefs.conflict && (model?.provider && model?.model ? h('p', { className: 'mx-hint' }, t(modelPrefs.settings?.selection === null ? 'modelFollowObserved' : 'modelEffective', { model: modelDescription(model) })) : h('p', { className: 'mx-hint' }, t('noModel'))),
              h('p', { className: 'mx-hint' }, t('modelNextGeneration')),
              h('div', { className: 'mx-model-row' },
                button(modelSaving ? t('modelSaving') : t('modelApply'), applyModelPreference, { className: 'mx-primary', disabled: modelControlsLocked || !modelPrefs.available || modelPrefs.conflict || !modelDraftDirty || !!catalogProblem }),
                button(t('modelReload'), reloadModelPreference, { disabled: modelControlsLocked }),
                catalog.error && button(t('modelRetryCatalog'), () => setCatalogVersion(v => v + 1), { disabled: modelControlsLocked || !modelPrefs.available })));
          };
          // Allocated normal-flow controls never overlay prose; only the body viewport scrolls.
          const renderAI = () => h(React.Fragment, null,
            h('section', { hidden: folded, className: 'mx-writing-partner', 'aria-label': t('ai') },
              h('div', { className: 'mx-partner-row' },
                h(Field, { label: t('mode') }, h('select', { value: mode, disabled: locked, onChange: e => setMode(e.target.value) }, Object.entries(modeKeys).map(([value, key]) => h('option', { key: value, value }, t(key))))),
                h(Field, { label: t('instruction') }, h('textarea', { value: instruction, disabled: locked, rows: 2, maxLength: 60000, placeholder: t(mode === 'revise' ? 'revisePlaceholder' : 'instructionPlaceholder'), onChange: e => setInstruction(e.target.value) })),
                h('div', { className: 'mx-actions' },
                  button(t('generate'), generate, { className: 'mx-primary', disabled: locked || anyDirty || !!conflict || running || !canPolish || requirementMissing || !!modelProblem || !model?.provider || !model?.model }),
                  bulkVisible && button(t('approveAll'), () => isRevision ? applyRevisionAll(bulkSnapshot) : isPolish ? applyPolish(bulkSnapshot, true) : applyGenerated(bulkSnapshot, true), { disabled: !!bulkProblem || !bulkPreview, title: bulkProblem ? t(bulkProblem) : t('approveAllHint') }),
                  button(contextBusy ? t('loading') : t('context'), previewContext, { disabled: locked || anyDirty || !canPolish || requirementMissing || contextBusy }),
                  running && button(t('cancelJob'), () => withBusy(async () => { const result = await call('cancel', { jobId: job.id }); if (alive.current) { setJob(result); rememberJob(result); setPollVersion(v => v + 1); } }), { className: 'mx-danger' }))),
              h('div', { className: 'mx-partner-meta' },
                h('span', { className: 'mx-hint' }, modelDescription(model) || t('noModel')),
                button(t('advanced'), () => setAdvanced(value => !value), { 'aria-expanded': advanced, 'aria-controls': formId.current + '-advanced' }),
                proposalsFor(w.book, w.chapterId).length > 0 && h('label', { className: 'mx-result-chooser mx-hint' }, t('results'), h('select', { 'aria-label': t('results'), value: proposal?.id || w.candidateId, disabled: locked || running || awaitingOutcome, onChange: e => chooseCandidate(e.target.value) }, proposalsFor(w.book, w.chapterId).map(p => h('option', { key: p.id, value: p.id }, t(modeKeys[p.mode]) + ' · ' + t(p.state) + ' · ' + formatDate(p.createdAt))))),
                (running || awaitingOutcome) && job?.mode !== 'polish' && h('span', { className: 'mx-hint', role: 'status' }, t(running ? ['analyzing', 'optimizing'].includes(job.phase) ? job.phase : 'generating' : 'polishAwaitProposal')),
                job && ['failed', 'cancelled'].includes(job.status) && h(React.Fragment, null,
                  h('span', { className: 'mx-hint mx-job-terminal', role: job.status === 'failed' ? 'alert' : 'status', title: job.error ? String(job.error) : undefined }, t(job.status), job.error ? ' · ' + String(job.error) : ''),
                  h('span', { className: 'mx-hint' }, proposal && job.chapterId === w.chapterId ? t('previousResult') : job.chapterId !== w.chapterId ? t('jobOtherChapter') : '')),
                pollError && h('span', { className: 'mx-hint mx-job-poll', role: 'status' }, t('pollError'), ' ', button(t('retry'), () => { setPollError(false); setPollVersion(v => v + 1); })),
                anyDirty && h('span', { className: 'mx-hint' }, t('saveFirst')),
                !canPolish && h('span', { className: 'mx-hint' }, t('polishFirst')),
                modelProblem && h('span', { className: 'mx-hint', role: 'status' }, t(modelProblem)),
                mode === 'revise' && requirementMissing && h('span', { className: 'mx-hint' }, t('reviseRequirement')))),
            advanced && h('div', { hidden: folded, id: formId.current + '-advanced', className: 'mx-partner-advanced mx-stack' },
              h('p', { className: 'mx-hint' }, t('aiSafety')), mode === 'revise' && h('p', { className: 'mx-hint' }, t('reviseHint')),
              renderModelPicker(), !anyDirty && context && context.key === contextKey() && renderReport(context.data),
              proposal?.review?.analysis && h('details', null, h('summary', null, t('revisionAnalysis')), h('div', { className: 'mx-revision-analysis' }, proposal.review.analysis)),
              proposal?.context && h('details', null, h('summary', null, t('contextTitle')), renderReport({ report: proposal.context })),
              job && h('div', { className: 'mx-stack', 'aria-label': t('job') },
                h('p', { className: 'mx-hint' }, t(job.status) + ' · ' + (modelDescription(job.model) ? t('modelJob', { model: modelDescription(job.model) }) : t('modelJobPending'))),
                job.chapterId !== w.chapterId && h('p', { className: 'mx-hint' }, t('jobOtherChapter')),
                typeof job.analysis === 'string' && job.analysis && h('details', null, h('summary', null, t('revisionAnalysis')), h('div', { className: 'mx-revision-analysis' }, job.analysis)),
                pollError && h('p', { className: 'mx-hint', role: 'status' }, t('pollError')),
                job.error && h('p', { className: 'mx-hint', role: 'status' }, String(job.error)),
                h('div', { className: 'mx-actions' }, !running && button(t('dismiss'), () => setJob(null)), pollError && button(t('retry'), () => { setPollError(false); setPollVersion(v => v + 1); })))),
            d.candidate && h('div', { className: 'mx-legacy-recovery mx-stack', role: 'status' },
              h('p', { className: 'mx-hint' }, t('legacyDraft')),
              h('details', null, h('summary', null, t('recoveryPreview')), h('pre', null, w.candidate)),
              h('div', { className: 'mx-actions' },
                button(t('candidateSave'), () => withBusy(async () => {
                  const active = current.current;
                  if (recoveryRef.current || conflict || proposalOf(active)?.state !== 'ready' || proposalOf(active)?.mode === 'revise') throw new Error(t('saveFirst'));
                  await mutateRaw({ action: 'updateProposal', proposalId: active.candidateId, text: active.candidate }, 'candidate');
                  if (alive.current) setNotice(t('candidateSaved'));
                }), { disabled: locked || !!conflict || selectedProposal?.state !== 'ready' || selectedProposal?.mode === 'revise' }),
                button(t('downloadLocal'), downloadLocal),
                button(t('discardResultEdits'), () => setConfirm({ title: t('confirmDiscard'), body: t('unsavedHint'), label: t('discardResultEdits'), run: () => { discardScope('candidate'); setConfirm(null); } }), { className: 'mx-danger' }))),
            isRevision && proposal.state === 'ready' && h('div', { className: 'mx-actions mx-result-tools' },
              button(t(revision && !proposal.review.hunks.length ? 'revisionDismissEmpty' : 'revisionRejectRemaining'), () => confirmMutation(t('rejectTitle'), t('revisionRejectHint'), { action: 'rejectProposal', proposalId: proposal.id }, t('reject'), reviewSnapshot(w, { proposalId: proposal.id })), { disabled: locked || anyDirty || !!conflict })),
            writingLayout && !folded && h('div', { className: 'mx-actions mx-controls-collapse' },
              button(t('collapseControls'), () => { closeSelectionPopup(); setControlsFolded(true); }, { disabled: false, 'aria-expanded': true, 'aria-controls': formId.current + '-controls' })));
          const renderSettings = () => h('section', { className: 'mx-panel mx-stack' }, h('h2', null, t('settings')), h('p', { className: 'mx-hint' }, t('projectHint')),
            h(Field, { label: t('bookTitle') }, input('settings', 'title', { maxLength: 300 })),
            h(Field, { label: t('premise') }, textarea('settings', 'premise', { rows: 4 })),
            h(Field, { label: t('outline') }, textarea('settings', 'outline', { rows: 10 })),
            h(Field, { label: t('style') }, textarea('settings', 'style', { rows: 5 })),
            h(Field, { label: t('contextBudget'), hint: t('contextNote') }, input('settings', 'contextBudget', { type: 'number', min: 1000, max: 60000, step: 1 })),
            h('details', { className: 'mx-subpanel' }, h('summary', null, t('maintenance')), h('div', { className: 'mx-stack' }, h('p', { className: 'mx-hint' }, t('pruneHint')),
              h('div', { className: 'mx-actions' }, button(t('exportJson'), () => exportBook('json')), button(t('prune'), () => transition(() => confirmMutation(t('pruneTitle'), t('pruneHint'), { action: 'pruneArchive' }, t('prune'))), { className: 'mx-danger' })))));
          const renderCards = () => h('section', { className: 'mx-stack' },
            h('div', { className: 'mx-row mx-row-between' }, h('h2', null, t('cards')), button(t('newCard'), () => chooseCard(null), { className: 'mx-primary' })), h('p', { className: 'mx-hint' }, t('canonHint')),
            h('div', { className: 'mx-cards' }, h('div', { className: 'mx-stack' }, !w.book.cards.length && h('p', { className: 'mx-hint' }, t('noCards')),
              w.book.cards.map(card => h('article', { key: card.id, className: 'mx-card', 'aria-current': w.card?.id === card.id ? 'true' : undefined },
                h('h3', null, card.title), h('div', { className: 'mx-row' }, badge(t(card.kind)), badge(t(card.status)), card.pinned && badge(t('pinned'))),
                h('p', { className: 'mx-hint' }, card.content), h('p', { className: 'mx-hint' }, t('range', { from: card.fromChapter, to: card.toChapter ?? t('noEnd') })),
                h('div', { className: 'mx-actions' }, button(t('edit'), () => chooseCard(card)), button(t('removeCard'), () => transition(() => confirmMutation(t('removeTitle'), t('removeHint'), { action: 'removeCard', cardId: card.id }, t('removeCard'))), { className: 'mx-danger' }))))),
              h('div', { className: 'mx-panel mx-stack' }, !w.card ? h('p', { className: 'mx-hint' }, t('chooseCard')) : h(React.Fragment, null,
                h('h3', null, t(w.card.id ? 'edit' : 'newCard')), h(Field, { label: t('cardTitle') }, input('card', 'title', { maxLength: 300 })),
                h('div', { className: 'mx-form-grid' }, h(Field, { label: t('kind') }, select('card', 'kind', ['world', 'character', 'timeline', 'thread', 'rule'])), h(Field, { label: t('cardStatus') }, select('card', 'status', ['proposed', 'confirmed']))),
                h(Field, { label: t('cardContent') }, textarea('card', 'content', { rows: 8 })),
                h('label', { className: 'mx-check' }, h('input', { type: 'checkbox', checked: w.card.pinned, disabled: locked, onChange: e => changeField('card', 'pinned', e.target.checked) }), t('pin')),
                h('div', { className: 'mx-form-grid' }, h(Field, { label: t('fromChapter') }, input('card', 'fromChapter', { type: 'number', min: 1, step: 1 })), h(Field, { label: t('toChapter') }, input('card', 'toChapter', { type: 'number', min: 1, step: 1 }))),
                h(Field, { label: t('tags') }, input('card', 'tags')), h('div', { className: 'mx-actions' }, button(t('save'), saveAll, { className: 'mx-primary', disabled: locked || !anyDirty || !!conflict }), button(t('close'), () => transition(() => commit({ ...current.current, card: null, baseCard: null }), 'card')))))));
          const renderHistory = () => h('section', { className: 'mx-panel mx-stack' }, h('h2', null, t('history')), h('p', { className: 'mx-hint' }, t('historyHint')),
            !chapter ? h('p', null, t('noChapters')) : !chapter.history.length ? h('p', { className: 'mx-hint' }, t('noHistory')) : chapter.history.slice().reverse().map(item => h('details', { key: item.id, className: 'mx-subpanel' },
              h('summary', null, t('revision', { number: item.revision }) + ' · ' + formatDate(item.createdAt)), h('div', { className: 'mx-stack' }, h('p', { className: 'mx-hint' }, item.reason), h('pre', null, item.body || t('empty')),
                button(t('restore'), () => transition(() => confirmMutation(t('restoreTitle'), t('restoreHint'), { action: 'restoreChapter', chapterId: chapter.id, historyId: item.id }, t('restore'))), { className: 'mx-danger' })))));
          const renderConflict = () => {
            if (!conflict || !w) return null;
            const latest = conflict.book, local = recoveryPayload(w), remote = {};
            if (d.chapter) remote.chapter = chapterFields(latest.chapters.find(c => c.id === w.chapterId));
            if (d.settings) remote.settings = bookFields(latest);
            if (d.card) remote.card = cardFields(latest.cards.find(c => c.id === w.card?.id));
            if (d.candidate) remote.candidate = latest.proposals.find(p => p.id === w.candidateId) || null;
            return h('section', { className: 'mx-banner mx-error mx-stack', role: 'alert' }, h('h3', null, t('conflictTitle')), h('p', { className: 'mx-hint' }, t('conflictHint')),
              h('details', { open: true }, h('summary', null, t('compare')), h('div', { className: 'mx-compare' },
                h('div', null, h('h3', null, t('localChanges')), h('pre', null, JSON.stringify(local, null, 2))), h('div', null, h('h3', null, t('latestSaved')), h('pre', null, JSON.stringify(remote, null, 2))))),
              h('div', { className: 'mx-actions' }, button(t('downloadLocal'), downloadLocal), button(t('reviewLatest'), inspectConflict),
                button(t('rebase'), () => {
                  if (d.candidate && latest.proposals.find(p => p.id === w.candidateId)?.state !== 'ready') { setError({ message: t('rebaseUnavailable') }); return; }
                  setConfirm({ title: t('rebaseTitle'), body: t('rebaseHint'), label: t('rebase'), run: () => { commit(mergeWorkspace(current.current, latest, null, true)); setConflict(null); setConfirm(null); setError(null); setNotice(t('localOnly')); } });
                }), button(t('refresh'), () => transition(() => openBook(w.book.id, w.chapterId)))));
          };
          const renderCreate = () => h('div', { className: 'mx-row' }, h('div', { className: 'mx-grow' }, h(Field, { label: t('newBookTitle') }, h('input', { value: newTitle, maxLength: 300, disabled: locked, onChange: e => setNewTitle(e.target.value) }))), button(t('createBook'), create, { className: 'mx-primary', disabled: locked || !newTitle.trim() }));
          const renderImport = () => h(Field, { label: t('import'), hint: t('importHint') }, h('input', { type: 'file', accept: '.json,application/json', disabled: locked, onChange: e => { const file = e.target.files?.[0]; e.target.value = ''; doImport(file); } }));

          const writingLayout = tab === 'writing' && !!chapter && !d.candidate && !recovery && !conflict && !error && !deletionNotice && !storageFailed && cleanupPendingCount === 0;
          const folded = controlsFolded && writingLayout;
          const renderFoldedCritical = () => h(React.Fragment, null,
            anyDirty && h('span', { className: 'mx-hint' }, t('unsaved')),
            anyDirty && button(t('save'), saveAll, { disabled: locked || !!conflict }),
            anyDirty && button(t('discard'), () => setConfirm({ title: t('confirmDiscard'), body: t('unsavedHint'), label: t('discard'), run: () => { discardScope('all'); setConfirm(null); setError(null); resetSelection(); } })),
            anyDirty && button(t('downloadLocal'), downloadLocal),
            bulkVisible && button(t('approveAll'), () => isRevision ? applyRevisionAll(bulkSnapshot) : isPolish ? applyPolish(bulkSnapshot, true) : applyGenerated(bulkSnapshot, true), { disabled: !!bulkProblem || !bulkPreview, title: bulkProblem ? t(bulkProblem) : t('approveAllHint') }),
            running && button(t('cancelJob'), () => withBusy(async () => { const result = await call('cancel', { jobId: job.id }); if (alive.current) { setJob(result); rememberJob(result); setPollVersion(v => v + 1); } })),
            job && ['failed', 'cancelled'].includes(job.status) && h('span', { className: 'mx-hint mx-job-terminal', role: job.status === 'failed' ? 'alert' : 'status' }, t(job.status), job.error ? ' · ' + String(job.error) : '', proposal ? ' · ' + t('previousResult') : ''),
            pollError && h('span', { className: 'mx-hint', role: 'status' }, t('pollError'), button(t('retry'), () => { setPollError(false); setPollVersion(v => v + 1); })));
          return h('main', { ref: rootRef, className: 'mx-root' + (writingLayout ? ' mx-root-writing' : '') + (folded ? ' mx-controls-folded' : ''), 'aria-label': t('nav'), 'aria-busy': loading || busy,
            onPointerDownCapture: () => { if (document.activeElement === editorRef.current) captureSelection(); },
            onKeyDown: e => { if (e.key === 'Escape') closeSelectionPopup(); if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.isComposing && !e.nativeEvent?.isComposing && !composing.current && !guard && !confirm && !manager) { e.preventDefault(); if (isDirty(current.current) && !busyRef.current) saveAll(); } },
          }, h('style', null, CSS),
          folded && h('div', { className: 'mx-surface-bar', role: 'toolbar', 'aria-label': t('writingControls') },
            button(t('expandControls'), () => { closeSelectionPopup(); setControlsFolded(false); }, { disabled: false, 'aria-expanded': false, 'aria-controls': formId.current + '-controls' }),
            folded && renderFoldedCritical()),
          h('header', { id: formId.current + '-controls', hidden: folded, className: 'mx-header' }, h('div', null, h('h1', null, t('title')), h('p', { className: 'mx-hint' }, t('subtitle'))),
            w && tab === 'writing' && button(t('chaptersToggle'), () => setChaptersVisible(value => !value), { 'aria-expanded': chaptersVisible, 'aria-controls': formId.current + '-chapters' }),
            w && anyDirty && h('div', { className: 'mx-stack mx-save-controls' }, h('div', { className: 'mx-actions' }, status(t('unsaved'), 'warn'), button(busy ? t('working') : t('save'), saveAll, { className: 'mx-primary', disabled: locked || !anyDirty || !!conflict }),
              anyDirty && button(t('discard'), () => setConfirm({ title: t('confirmDiscard'), body: t('unsavedHint'), label: t('discard'), run: () => { discardScope('all'); setConfirm(null); setError(null); resetSelection(); } }), { className: 'mx-danger' })), h('p', { className: 'mx-hint' }, t('saveHint')))),
          error && h('div', { className: 'mx-banner mx-error mx-stack', role: 'alert' }, h('p', null, error.message), error.code && h('span', { className: 'mx-hint' }, error.code),
            h('div', { className: 'mx-actions' }, w && button(t('reviewLatest'), inspectConflict), button(t('dismiss'), () => setError(null), { disabled: false }))),
          notice && !activePolishJob && h('div', { className: 'mx-banner mx-info', role: 'status' }, notice),
          deletionNotice && h('section', { className: 'mx-banner mx-stack', role: deletionNotice.cleanupPending || deletionNotice.localCleanupPending || deletionNotice.refreshFailed ? 'alert' : 'status' },
            h('p', null, t(deletionNotice.cleanupPending ? 'deleteCleanupPending' : 'deleted', { title: deletionNotice.title })),
            deletionNotice.localCleanupPending && h('p', null, t('deleteLocalCleanupPending')),
            deletionNotice.refreshFailed && h('p', null, t('deleteRefreshFailed')),
            h('div', { className: 'mx-actions' }, deletionNotice.refreshFailed && button(t('refresh'), () => withBusy(refreshDeletedLibrary)), button(t('dismiss'), () => setDeletionNotice(null)))),
          cleanupPendingCount > 0 && h('div', { className: 'mx-banner', role: 'alert' }, t('libraryCleanupPending', { count: cleanupPendingCount })),
          storageFailed && h('div', { className: 'mx-banner', role: 'alert' }, h('p', null, t('storageWarning')), button(t('downloadLocal'), downloadLocal, { disabled: !anyDirty && !recovery })),
          recovery && h('section', { className: 'mx-banner mx-stack' }, h('h3', null, t('recoveryTitle')), h('p', { className: 'mx-hint' }, t('recoveryHint')), h('p', { className: 'mx-hint' }, t('recoveredFrom', { date: formatDate(recovery.savedAt) })),
            h('details', null, h('summary', null, t('recoveryPreview')), h('pre', null, JSON.stringify(recovery, null, 2))),
            h('div', { className: 'mx-actions' }, button(t('recover'), () => transition(restoreRecovery), { className: 'mx-primary', disabled: busy || loading }), button(t('downloadLocal'), downloadLocal, { disabled: busy || loading }), button(t('discardRecovery'), () => setConfirm({ title: t('discardRecovery'), body: t('confirmDiscard'), label: t('discardRecovery'), run: () => { forgetDraft(w.book.id); assignRecovery(null); setConfirm(null); } }), { className: 'mx-danger', disabled: busy || loading }))),
          renderConflict(),
          h('section', { className: 'mx-stack mx-book-workspace' },
            h('div', { hidden: folded, className: 'mx-row mx-book-row' }, h('div', { className: 'mx-grow' }, h(Field, { label: t('book') }, h('select', { value: w?.book.id || '', disabled: locked, onChange: e => { const id = e.target.value; if (id) transition(() => openBook(id)); } }, h('option', { value: '', disabled: true }, t('chooseBook')), w && !books.some(b => b.id === w.book.id) && h('option', { value: w.book.id, disabled: true }, t('bookUnavailable', { title: w.book.title })), books.map(b => h('option', { key: b.id, value: b.id }, t('bookOption', { title: b.title, count: b.chapterCount, id: b.id.slice(0, 8) })))))),
              button(t('manageBooks'), beginManagement, { disabled: busy || loading || !w || !!manager, title: t('manageBookHint'), 'aria-haspopup': 'dialog' }),
              button(t('refresh'), refreshWorkspace)),
            loading && h('p', { role: 'status', className: 'mx-hint' }, t('loading')),
            !w && !loading && h('section', { className: 'mx-empty mx-stack' }, h('h2', null, t(books.length ? 'chooseBook' : 'emptyTitle')), h('p', { className: 'mx-hint' }, t(books.length ? 'chooseBookHint' : 'emptyHint')), renderCreate(), renderImport()),
            w && h(React.Fragment, null,
              h('details', { hidden: folded, className: 'mx-book-tools' }, h('summary', null, t('bookTools')), h('div', { className: 'mx-stack' },
               h('details', null, h('summary', null, t('createBook')), renderCreate()),
              h('div', { className: 'mx-row' }, h('div', { className: 'mx-grow' }, h(Field, { label: t('chapter') }, h('select', { value: w.chapterId, disabled: locked || !w.book.chapters.length, onChange: e => changeChapter(e.target.value) }, !w.book.chapters.length && h('option', { value: '' }, t('noChapters')), w.book.chapters.map((c, i) => h('option', { key: c.id, value: c.id }, (i + 1) + '. ' + c.title + (c.status === 'final' ? ' · ' + t('final') : '')))))),
                h('div', { className: 'mx-grow' }, h(Field, { label: t('newChapterTitle') }, h('input', { value: newChapter, maxLength: 300, disabled: locked, onChange: e => setNewChapter(e.target.value) }))), button(t('addChapter'), addChapter, { disabled: locked || !newChapter.trim() })),
              h('footer', { className: 'mx-foot mx-stack' }, h('p', { className: 'mx-hint' }, model?.provider && model?.model ? t('model') + ': ' + model.provider + ' / ' + model.model : t('noModel')),
                h('p', { className: 'mx-hint' }, t('exportHint')), h('div', { className: 'mx-actions' }, button(t('exportJson'), () => exportBook('json')), button(t('exportMarkdown'), () => exportBook('markdown')), anyDirty && button(t('downloadLocal'), downloadLocal)), renderImport()))),
               h('div', { hidden: folded, className: 'mx-tabs', 'aria-label': t('nav') }, ['writing', 'cards', 'settings', 'history'].map(value => button(t(value) + ((value === 'writing' && (d.chapter || d.candidate)) || (value === 'cards' && d.card) || (value === 'settings' && d.settings) ? ' •' : ''), () => setTab(value), { key: value, 'aria-pressed': tab === value, 'aria-controls': formId.current }))),
              h('div', { id: formId.current, className: 'mx-writing-host' }, tab === 'writing' ? chapter ? h('div', { className: 'mx-grid', 'data-chapters': chaptersVisible && !folded }, chaptersVisible && !folded && h('nav', { id: formId.current + '-chapters', className: 'mx-chapter-nav', 'aria-label': t('chapter') }, w.book.chapters.map((c, i) => button((i + 1) + '. ' + c.title, () => changeChapter(c.id), { key: c.id, 'aria-pressed': c.id === w.chapterId, title: c.title }))), h('div', { ref: columnRef, className: 'mx-writing-column' }, renderAI(), renderEditor())) : h('section', { className: 'mx-panel' }, h('p', null, t('noChapters'))) : tab === 'settings' ? renderSettings() : tab === 'cards' ? renderCards() : renderHistory()),
              )),
          renderSelectionPopup(),
           polishRequirements && h(Modal, { title: t('polishCustom'), busy, onCancel: () => setPolishRequirements(null), actions: cancelRef => [
             button(t('cancel'), () => setPolishRequirements(null), { key: 'cancel', ref: cancelRef, disabled: busy }),
             button(t('polishSubmit'), () => startPolish(polishRequirements.snapshot, polishRequirements.text, true), { key: 'submit', className: 'mx-primary', disabled: busy || !!requirementsProblem || !polishRequirements.text.trim() }),
           ] }, h(React.Fragment, null,
             h('p', { className: 'mx-hint' }, t('polishSelectionOnly')),
             h('div', null, h('h3', null, t('originalPassage')), h('pre', null, polishRequirements.snapshot.text)),
             h(Field, { label: t('polishRequirement') }, h('textarea', { ref: requirementsRef, value: polishRequirements.text, rows: 5, maxLength: 60000, disabled: busy, required: true, onChange: e => setPolishRequirements(previous => previous && ({ ...previous, text: e.target.value })) })),
             requirementsProblem && h('p', { className: 'mx-banner', role: 'alert' }, t(requirementsProblem)),
             error && h('p', { className: 'mx-banner mx-error', role: 'alert' }, error.message))),
           manager && h(Modal, { title: t('manageBooks'), busy, onCancel: () => setManager(null), actions: cancelRef => [
            button(t('cancel'), () => setManager(null), { key: 'cancel', ref: cancelRef, disabled: busy }),
          ] }, h(React.Fragment, null,
            h('p', { className: 'mx-hint' }, t('bookIdentity', { id: manager.snapshot.bookId, revision: manager.snapshot.revision })),
            h('div', null, h('h3', null, t('savedBookTitle')), h('pre', null, manager.snapshot.title)),
            manageProblem && h('p', { className: 'mx-banner', role: 'alert' }, t(manageProblem)),
            error && h('p', { className: 'mx-banner mx-error', role: 'alert' }, error.message),
            h('section', { className: 'mx-subpanel mx-stack', 'aria-label': t('renameBook') },
              h('h3', null, t('renameBook')),
              h(Field, { label: t('renameTitle') }, h('input', { value: manager.title, maxLength: 300, disabled: busy || !!manageProblem || manager.uncertain, onChange: e => setManager(previous => ({ ...previous, title: e.target.value })) })),
              button(t('renameBook'), renameManagedBook, { className: 'mx-primary', disabled: busy || !!manageProblem || manager.uncertain || !manager.title.trim() || manager.title.trim() === manager.snapshot.title })),
            h('section', { className: 'mx-subpanel mx-stack', 'aria-label': t('deleteBook') },
              h('h3', null, t('deleteBook')), h('p', null, t('deleteWarning')), h('p', { className: 'mx-hint' }, t('deleteBackup')),
              button(t('exportJson'), () => exportBook('json'), { disabled: busy || !!manageProblem || manager.uncertain }),
              h(Field, { label: t('deleteTypeTitle') }, h('input', { value: manager.typedTitle, disabled: busy || !!manageProblem || manager.uncertain, autoComplete: 'off', spellCheck: false, onChange: e => setManager(previous => ({ ...previous, typedTitle: e.target.value })) })),
              deleteProblem === 'deleteBusy' && h('p', { className: 'mx-banner', role: 'status' }, t('deleteBusy')),
              button(t('deleteBook'), deleteManagedBook, { className: 'mx-danger', disabled: busy || !!deleteProblem || manager.uncertain })))),
          guard && h(Modal, { title: t('unsavedTitle'), busy, onCancel: () => setGuard(null), actions: cancelRef => [
            button(t('stay'), () => setGuard(null), { key: 'stay', ref: cancelRef, disabled: busy }),
            button(t('discardContinue'), () => { const next = guard; discardScope(next.scope); setGuard(null); next.run(); }, { key: 'discard', className: 'mx-danger', disabled: busy }),
            button(t('saveContinue'), async () => { const next = guard; if (await saveAll()) { setGuard(null); next.run(); } }, { key: 'save', className: 'mx-primary', disabled: busy || !!conflict }),
          ] }, h(React.Fragment, null, h('p', null, t('unsavedHint')), error && h('p', { role: 'alert', className: 'mx-banner mx-error' }, error.message))),
          confirm && h(Modal, { title: confirm.title, busy, onCancel: () => setConfirm(null), actions: cancelRef => [
            button(t('cancel'), () => setConfirm(null), { key: 'cancel', ref: cancelRef, disabled: busy }),
            button(confirm.label, confirm.run, { key: 'confirm', className: 'mx-primary', disabled: busy }),
          ] }, h(React.Fragment, null, h('p', null, confirm.body), error && h('p', { role: 'alert', className: 'mx-banner mx-error' }, error.message))));
        }

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ycx-inspiration', locale: NS }, App));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'ycx-inspiration', order: 35, label: () => t('nav') }, Icon));
      },
    };
  },
});
