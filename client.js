/* 灵感 — independent, native React client. No client package imports or second DOM root. */
window.__ModuleLoader__.load({
  id: '@ycx/dsh-inspiration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useLayoutEffect, useCallback, useSyncExternalStore, useMemo } = React;
    const NS = 'ycx-inspiration';
    const STORAGE = 'ycx-moxu:draft:v1:';
    const JOB_STORAGE = 'ycx-moxu:job:v1:';
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const chapterFields = c => c ? ({ title: c.title, outline: c.outline, body: c.body, status: c.status, summary: c.summary }) : null;
    const copyWritingConstraints = rows => (rows || []).map(row => ({ ...row }));
    const bookFields = b => ({ title: b.title, premise: b.premise, outline: b.outline, style: b.style, contextBudget: String(b.contextBudget), writingConstraints: copyWritingConstraints(b.writingConstraints) });
    const cardKinds = ['world', 'character', 'rule', 'timeline', 'thread'];
    const categoryIdValid = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
    const cardCategory = card => card.categoryId || card.kind;
    const hasCategory = (book, id) => cardKinds.includes(id) || !!book.cardCategories?.some(category => category.id === id);
    const cardCategoryFieldValid = card => !card || !Object.hasOwn(card, 'categoryId') || card.categoryId === null || cardKinds.includes(card.categoryId) || categoryIdValid(card.categoryId);
    const equalCardFields = (left, right) => left && right ? equal({ ...left, categoryId: left.categoryId ?? null }, { ...right, categoryId: right.categoryId ?? null }) : equal(left, right);
    function editCardCategory(card, book, category) {
      if (category === (card.categoryId || '') || category && !hasCategory(book, category)) return card;
      return { ...card, categoryId: category || null };
    }
    const categoryFilter = (book, filter) => filter?.bookId === book.id && hasCategory(book, filter.id) ? filter.id : '';
    const cardsInCategory = (cards, filter) => filter ? cards.filter(card => cardCategory(card) === filter) : cards;
    const categorySaved = (book, category) => !!book?.cardCategories?.some(value => value.id === category.id && value.name === category.name);
    function categoryReceipt(before, next, category) {
      return next?.id === before.id && next.revision === before.revision + 1 && categorySaved(next, category) &&
        equal(next.cardCategories, [...(before.cardCategories || []), category]) && equal(next.cards, before.cards);
    }
    const cardFields = c => c ? ({ id: c.id, kind: c.kind, title: c.title, content: c.content, status: c.status, pinned: c.pinned, fromChapter: String(c.fromChapter), toChapter: c.toChapter == null ? '' : String(c.toChapter), tags: c.tags.join(', '),
      ...(Object.hasOwn(c, 'categoryId') ? { categoryId: c.categoryId } : {}) }) : null;
    const blankCard = (category = '') => ({ kind: 'character', title: '', content: '', status: 'proposed', pinned: false, fromChapter: '1', toChapter: '', tags: '',
      ...(cardKinds.includes(category) || categoryIdValid(category) ? { categoryId: category } : {}) });
    const chapterOf = w => w?.book.chapters.find(c => c.id === w.chapterId);
    const proposalOf = w => w?.book.proposals.find(p => p.id === w.candidateId);
    const constraintsEditorDirty = w => !!w?.constraintsEditor && w.constraintsEditor.text !== w.constraintsEditor.baseText;
    const dirty = w => w ? ({
      chapter: !equal(w.chapter, w.baseChapter),
      settings: !equal(w.settings, w.baseSettings) || constraintsEditorDirty(w),
      card: !!w.card && !equalCardFields(w.card, w.baseCard),
      candidate: w.candidateId != null && w.candidate !== w.baseCandidate,
    }) : {};
    const isDirty = w => Object.values(dirty(w)).some(Boolean);
    const patchOf = (base, value) => Object.fromEntries(Object.keys(value).filter(k => !equal(base?.[k], value[k])).map(k => [k, value[k]]));
    const proposalsFor = (b, id) => b.proposals.filter(p => p.chapterId === id && p.mode !== 'outline').slice().reverse();
    function workspace(book, chapterId) {
      const chapter = book.chapters.find(c => c.id === chapterId) || book.chapters[0];
      const fields = chapterFields(chapter);
      const proposals = proposalsFor(book, chapter?.id);
      const proposal = proposals.find(p => p.state === 'ready') || proposals[0];
      return { book, chapterId: chapter?.id || '', chapter: fields, baseChapter: fields,
        settings: bookFields(book), baseSettings: bookFields(book), constraintsEditor: constraintsEditorState(book.writingConstraints), card: null, baseCard: null,
        candidateId: proposal?.id || '', candidate: proposal?.text || '', baseCandidate: proposal?.text || '' };
    }
    // A background proposal may advance book.revision without touching the author's drafts.
    // Only adopt such a revision if ALL locally edited field groups still match their baseline.
    function conflictingFields(w, next) {
      const d = dirty(w), out = [];
      if (d.chapter && !equal(w.baseChapter, chapterFields(next.chapters.find(c => c.id === w.chapterId)))) out.push('chapter');
      if (d.settings && !equal(w.baseSettings, bookFields(next))) out.push('settings');
      if (d.card && w.card?.id && !equalCardFields(w.baseCard, cardFields(next.cards.find(c => c.id === w.card.id)))) out.push('card');
      const candidate = next.proposals.find(p => p.id === w.candidateId);
      if (d.candidate && (!candidate || candidate.state !== 'ready' || candidate.text !== w.baseCandidate)) out.push('candidate');
      return out;
    }
    function mergeWorkspace(w, next, cleared, rebase = false) {
      const d = dirty(w), fresh = workspace(next, w.chapterId);
      for (const [kind, field, base] of [['chapter', 'chapter', 'baseChapter'], ['settings', 'settings', 'baseSettings']]) {
        if (d[kind] && cleared !== kind) { fresh[field] = w[field]; if (!rebase) fresh[base] = w[base]; }
      }
      if (d.settings && cleared !== 'settings' && w.constraintsEditor) fresh.constraintsEditor = {
        ...w.constraintsEditor, baseText: rebase ? serializeConstraintsMarkdown(next.writingConstraints) : w.constraintsEditor.baseText };
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
      if (d.settings) { data.settings = w.settings; data.baseSettings = w.baseSettings; if (w.constraintsEditor) data.constraintsEditor = { ...w.constraintsEditor }; }
      if (d.card) { data.card = w.card; data.baseCard = w.baseCard; }
      if (d.candidate) { data.candidateId = w.candidateId; data.candidate = w.candidate; data.baseCandidate = w.baseCandidate; }
      return data;
    }
    function validRecovery(r, bookId) {
      if (!r || r.version !== 1 || r.bookId !== bookId || !r.dirty || typeof r.chapterId !== 'string') return false;
      if (r.dirty.chapter && (!r.chapter || !r.baseChapter || !['title', 'outline', 'body', 'summary', 'status'].every(k => typeof r.chapter[k] === 'string' && typeof r.baseChapter[k] === 'string'))) return false;
      if (r.dirty.settings && (!r.settings || !r.baseSettings || !['title', 'premise', 'outline', 'style', 'contextBudget'].every(k => typeof r.settings[k] === 'string' && typeof r.baseSettings[k] === 'string') || Object.hasOwn(r.settings, 'writingConstraints') !== Object.hasOwn(r.baseSettings, 'writingConstraints') || !validRecoveryConstraints(r.settings) || !validRecoveryConstraints(r.baseSettings))) return false;
      if (Object.hasOwn(r, 'constraintsEditor') && (!r.dirty.settings || !validConstraintsEditor(r.constraintsEditor, r.settings.writingConstraints?.length ?? 0) ||
          !constraintsDocumentMatches(r.constraintsEditor.parsedText, r.settings.writingConstraints) ||
          !constraintsDocumentMatches(r.constraintsEditor.baseText, r.baseSettings.writingConstraints))) return false;
      if (r.dirty.card && (!r.card || !['kind', 'title', 'content', 'status', 'fromChapter', 'toChapter', 'tags'].every(k => typeof r.card[k] === 'string') || typeof r.card.pinned !== 'boolean' || !cardCategoryFieldValid(r.card) || !cardCategoryFieldValid(r.baseCard))) return false;
      if (r.dirty.candidate && !['candidateId', 'candidate', 'baseCandidate'].every(k => typeof r[k] === 'string')) return false;
      return true;
    }
    // Recovery accepts blank new rows as manual drafts; only explicit Save requires non-empty text.
    function validRecoveryConstraints(settings) {
      const field = Object.getOwnPropertyDescriptor(settings, 'writingConstraints');
      return field ? field.enumerable && Object.hasOwn(field, 'value') && field.value !== undefined && validWritingConstraints(field.value, true) : !('writingConstraints' in settings);
    }
    function validWritingConstraints(rows, allowBlank = false) {
      if (rows === undefined) return true;
      if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > 64 || Reflect.ownKeys(rows).length !== rows.length + 1) return false;
      const ids = new Set();
      for (let index = 0; index < rows.length; index++) {
        const slot = Object.getOwnPropertyDescriptor(rows, String(index));
        if (!slot || !slot.enumerable || !Object.hasOwn(slot, 'value')) return false;
        const row = slot.value;
        if (!row || typeof row !== 'object' || Array.isArray(row) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(row)) || Reflect.ownKeys(row).length !== 4 ||
            !['id', 'category', 'content', 'enabled'].every(key => {
              const field = Object.getOwnPropertyDescriptor(row, key);
              return field && field.enumerable && Object.hasOwn(field, 'value');
            }) ||
            typeof row.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) ||
            ids.has(row.id.toLowerCase()) || typeof row.enabled !== 'boolean' ||
            typeof row.category !== 'string' || row.category.length > 80 || typeof row.content !== 'string' || row.content.length > 4000 ||
            /[\uD800-\uDFFF]/u.test(row.category) || /[\uD800-\uDFFF]/u.test(row.content) || !allowBlank && (!row.category.trim() || !row.content.trim())) return false;
        ids.add(row.id.toLowerCase());
      }
      return true;
    }
    // The whole Markdown document is a LOCAL journal, never a new Host patch field.
    // Identity stays outside the author's clean Markdown: exact row occurrences
    // survive reorders; a localized rule edit keeps that row, and a localized
    // category-heading edit keeps its explicit contiguous source-group members.
    // Identical duplicate occurrences retain occurrence order, not a fuzzy promise.
    function serializeConstraintsMarkdown(rows = []) {
      let last = null;
      return rows.map(row => {
        const category = /[\r\n]/.test(row.category) || row.category.startsWith('"') ? JSON.stringify(row.category) : row.category;
        const heading = row.category === last ? '' : '- ' + category + '\n';
        last = row.category;
        return heading + '    - [' + (row.enabled ? 'x' : ' ') + '] ' + row.content.replace(/(\r\n|\r|\n)/g, '$1      ');
      }).join('\n');
    }
    function constraintsEditorState(rows = []) {
      const text = serializeConstraintsMarkdown(rows);
      return { text, parsedText: text, baseText: text, error: '' };
    }
    function validConstraintsEditor(doc, rowCount = null) {
      if (!doc || typeof doc !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(doc))) return false;
      const anchors = Object.getOwnPropertyDescriptor(doc, 'anchoredStarts');
      if (Reflect.ownKeys(doc).length !== (anchors ? 5 : 4) || !['text', 'parsedText', 'baseText', 'error'].every(key => {
        const d = Object.getOwnPropertyDescriptor(doc, key);
        return d && d.enumerable && Object.hasOwn(d, 'value') && typeof d.value === 'string' &&
          (key === 'error' ? ['', 'constraintsMarkdownInvalid', 'constraintsMarkdownEmpty', 'constraintsCrypto', 'constraintsRuleStarter'].includes(d.value) : d.value.length <= 2000000);
      }) || !doc.error && doc.text !== doc.parsedText) return false;
      if (!anchors) return true; // v0.4.2 and older journals had no transaction coordinates.
      const points = anchors.value;
      if (!doc.error || !anchors.enumerable || !Object.hasOwn(anchors, 'value') || !Array.isArray(points) || Object.getPrototypeOf(points) !== Array.prototype ||
          points.length > 64 || rowCount !== null && points.length !== rowCount || Reflect.ownKeys(points).length !== points.length + 1) return false;
      const text = textareaValue(doc.text);
      let prior = -1;
      for (let index = 0; index < points.length; index++) {
        const point = Object.getOwnPropertyDescriptor(points, String(index));
        if (!point?.enumerable || !Object.hasOwn(point, 'value')) return false;
        if (point.value === null) continue;
        if (!Number.isSafeInteger(point.value) || point.value <= prior || point.value >= text.length || !' \t-*+'.includes(text[point.value])) return false;
        prior = point.value;
      }
      return true;
    }
    function constraintsDocumentMatches(text, rows = []) {
      if (text === serializeConstraintsMarkdown(rows)) return true;
      const parsed = parseConstraintsMarkdown(text, rows, null, { allowEmpty: true });
      return !parsed.error && equal(parsed.rows, rows);
    }
    function normalizedSourceOffsets(raw) {
      const removed = [];
      for (let index = raw.indexOf('\r\n'); index >= 0; index = raw.indexOf('\r\n', index + 2)) removed.push(index + 1);
      return position => {
        let lo = 0, hi = removed.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (removed[mid] < position) lo = mid + 1; else hi = mid; }
        return position - lo;
      };
    }
    function remapConstraintStarts(points, changes) {
      let delta = 0, changeIndex = 0;
      return points.map(point => {
        if (point == null) return null;
        while (changeIndex < changes.length && changes[changeIndex].to <= point) {
          const { from, to, insert } = changes[changeIndex++];
          delta += insert.length - (to - from);
        }
        const change = changes[changeIndex];
        return !change || change.from > point ? point + delta : null;
      });
    }
    function parseConstraintsMarkdown(text, previousRows = [], cryptoProvider = globalThis.crypto, { allowEmpty = false, previousText = null, sourceChanges = null, sourceAnchors = null, exactEol = false, rejectPlaceholders = false } = {}) {
      const bad = (error = 'constraintsMarkdownInvalid') => ({ rows: null, error, spans: [] });
      if (typeof text !== 'string' || text.length > 2000000 || /[\uD800-\uDFFF]/u.test(text)) return bad();
      if (!text.trim()) return previousRows.length && !allowEmpty ? bad('constraintsMarkdownEmpty') : { rows: [], error: '', spans: [] };
      const re = /([^\r\n]*)(\r\n|\r|\n|$)/g;
      let match, category = null, headingStart = -1, headingEnd = -1, categoryStart = -1, categoryEnd = -1, groupHasRule = true, current = null, headingStyle = false;
      const records = [];
      while ((match = re.exec(text)) && match[0]) {
        const line = { text: match[1], eol: match[2], start: match.index }, heading = /^(#{1,2} |[-*+] )(.+)$/.exec(line.text);
        const isHeading = heading && (!headingStyle || /^#/.test(line.text));
        if (isHeading) {
          if (!groupHasRule) return bad();
          headingStyle = /^#/.test(line.text);
          category = heading[2]; headingStart = line.start; headingEnd = line.start + line.text.length;
          categoryStart = line.start + heading[1].length; categoryEnd = headingEnd;
          if (category.startsWith('"')) { try { category = JSON.parse(category); } catch { return bad(); } }
          if (typeof category !== 'string' || !category.trim() || category.length > 80) return bad();
          groupHasRule = false; current = null;
          continue;
        }
        const child = /^(?: {4}|\t)[-*+] (.*)$/.exec(line.text);
        // Heading-style categories also accept ordinary unindented rule bullets.
        const flat = headingStyle && /^[-*+] (.*)$/.exec(line.text);
        const item = child || flat;
        if (item && category !== null) {
          let content = item[1], enabled = true;
          const task = /^\[([ xX])\] (.*)$/.exec(content);
          if (task) { enabled = task[1] !== ' '; content = task[2]; }
          current = { category, headingStart, headingEnd, categoryStart, categoryEnd, content, enabled, start: line.start, end: line.start + line.text.length, lastEol: line.eol };
          records.push(current); groupHasRule = true;
          if (records.length > 64) return bad();
        } else if (current && line.text.startsWith('      ')) {
          current.content += current.lastEol + line.text.slice(6); current.lastEol = line.eol;
          current.end = line.start + line.text.length;
        } else if (!line.text.trim()) {
          // Blank separator lines are not silently absorbed into the preceding rule.
          current = null;
        } else return bad();
      }
      if (!groupHasRule || !records.length || records.length > 64) return bad();
      const used = new Set(), matches = new Map(), forcedFresh = new Set(), rows = [], spans = [], sourceGroupPairs = [];
      const previousIds = new Set(previousRows.flatMap(row => typeof row?.id === 'string' ? [row.id.toLowerCase()] : []));
      // An empty inner bullet is unfinished even if the checkbox was removed.
      // Earlier saved literal dashes are grandfathered only at surviving source
      // offsets; a new starter must not inherit the exemption of a deleted row.
      const unfinished = new Set();
      if (rejectPlaceholders) records.forEach((item, index) => {
        if (item.content.trim() === '-') unfinished.add(index);
      });
      if (unfinished.size && typeof previousText !== 'string') return bad('constraintsRuleStarter');
      if (typeof previousText === 'string') {
        const before = textareaValue(previousText), after = textareaValue(text);
        let start = 0, tail = 0;
        while (start < before.length && start < after.length && before[start] === after[start]) start++;
        while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
        const old = parseConstraintsMarkdown(previousText, previousRows, null, { allowEmpty: true });
        const beforeOffset = normalizedSourceOffsets(previousText), afterOffset = normalizedSourceOffsets(text);
        const offset = (value, raw) => raw === previousText ? beforeOffset(value) : afterOffset(value);
        const oldEnd = before.length - tail, newEnd = after.length - tail;
        const identityBind = (newIndex, oldIndex) => {
          const previous = previousRows[oldIndex];
          if (!previous || !records[newIndex] || matches.has(newIndex) || used.has(previous.id.toLowerCase())) return false;
          matches.set(newIndex, previous); used.add(previous.id.toLowerCase());
          return true;
        };
        const stableBind = (newIndex, oldIndex) => {
          const previous = previousRows[oldIndex], oldSpan = old.spans[oldIndex], item = records[newIndex];
          if (!previous || !oldSpan || !item ||
              previousText.slice(oldSpan.start, oldSpan.end) !== text.slice(item.start, item.end) ||
              textareaValue(previous.content) !== textareaValue(item.content) || previous.enabled !== item.enabled) return false;
          return identityBind(newIndex, oldIndex);
        };
        // Continuous editing can change identical adjacent lines or edit several
        // disjoint ranges at once. Anchor surviving source occurrences by the
        // actual transaction before using text-only prefix/suffix inference.
        if (sourceAnchors || sourceChanges) {
          const indexAt = new Map(records.map((item, index) => [offset(item.start, text), index]));
          const anchors = sourceAnchors || remapConstraintStarts(old.spans.map(span => offset(span.start, previousText)), sourceChanges);
          anchors.forEach((point, oldIndex) => {
            if (point == null) {
              // If a legacy literal dash lost its source anchor during this
              // draft, do not let a new, now-filled starter recycle its ID.
              const previous = previousRows[oldIndex];
              if (rejectPlaceholders && previous?.content.trim() === '-') used.add(previous.id.toLowerCase());
              return;
            }
            const newIndex = indexAt.get(point);
            if (identityBind(newIndex, oldIndex) && previousRows[oldIndex].content.trim() === '-') unfinished.delete(newIndex);
          });
        }
        if (unfinished.size) return bad('constraintsRuleStarter');
        const oldPrefix = old.spans.map((span, index) => offset(span.end, previousText) <= start ? index : -1).filter(index => index >= 0);
        const newPrefix = records.map((item, index) => offset(item.end, text) <= start ? index : -1).filter(index => index >= 0);
        for (let index = 0; index < Math.min(oldPrefix.length, newPrefix.length); index++) stableBind(newPrefix[index], oldPrefix[index]);
        const oldSuffix = old.spans.map((span, index) => offset(span.start, previousText) >= oldEnd ? index : -1).filter(index => index >= 0);
        const newSuffix = records.map((item, index) => offset(item.start, text) >= newEnd ? index : -1).filter(index => index >= 0);
        for (let index = 1; index <= Math.min(oldSuffix.length, newSuffix.length); index++) stableBind(newSuffix.at(-index), oldSuffix.at(-index));
        // The first/last-difference hull can contain byte-identical interior groups
        // when one full-source paste edits both sides. Pair source groups before
        // any global duplicate matching so an inserted duplicate cannot steal an
        // untouched interior occurrence's UUID.
        const collectGroups = (items, raw) => {
          const groups = [];
          for (let first = 0; first < items.length;) {
            let last = first;
            while (last + 1 < items.length && items[last + 1].headingStart === items[first].headingStart) last++;
            groups.push({ members: Array.from({ length: last - first + 1 }, (_, index) => first + index),
              heading: raw.slice(items[first].headingStart, items[first].headingEnd),
              core: raw.slice(items[first].headingStart, items[last].end) });
            first = last + 1;
          }
          return groups;
        };
        const oldGroups = collectGroups(old.spans, previousText), newGroups = collectGroups(records, text);
        const pairedOld = new Set(), pairedNew = new Set(), pairGroups = (oldGroupIndex, newGroupIndex) => {
          if (pairedOld.has(oldGroupIndex) || pairedNew.has(newGroupIndex)) return;
          pairedOld.add(oldGroupIndex); pairedNew.add(newGroupIndex);
          sourceGroupPairs.push({ oldMembers: oldGroups[oldGroupIndex].members, newMembers: newGroups[newGroupIndex].members });
        };
        const pairUniqueGroups = field => {
          const oldBy = new Map(), newBy = new Map();
          oldGroups.forEach((group, index) => { if (!pairedOld.has(index)) oldBy.set(group[field], [...(oldBy.get(group[field]) || []), index]); });
          newGroups.forEach((group, index) => { if (!pairedNew.has(index)) newBy.set(group[field], [...(newBy.get(group[field]) || []), index]); });
          for (const [key, oldIndexes] of oldBy) {
            const newIndexes = newBy.get(key);
            if (oldIndexes.length === 1 && newIndexes?.length === 1) pairGroups(oldIndexes[0], newIndexes[0]);
          }
        };
        pairUniqueGroups('core');
        pairUniqueGroups('heading');
        const oldHeadingGroups = new Map(), newHeadingGroups = new Map();
        oldGroups.forEach((group, index) => { if (!pairedOld.has(index)) oldHeadingGroups.set(group.heading, [...(oldHeadingGroups.get(group.heading) || []), index]); });
        newGroups.forEach((group, index) => { if (!pairedNew.has(index)) newHeadingGroups.set(group.heading, [...(newHeadingGroups.get(group.heading) || []), index]); });
        for (const [heading, oldIndexes] of oldHeadingGroups) {
          const newIndexes = newHeadingGroups.get(heading);
          if (newIndexes?.length === oldIndexes.length) oldIndexes.forEach((oldGroupIndex, index) => pairGroups(oldGroupIndex, newIndexes[index]));
        }
        // Bind an exact whole group (including duplicate rules) or distinctive
        // exact/semantic occurrences inside a paired changed group first.
        for (const pair of sourceGroupPairs) {
          const oldGroup = oldGroups.find(group => group.members === pair.oldMembers) || { members: pair.oldMembers };
          const newGroup = newGroups.find(group => group.members === pair.newMembers) || { members: pair.newMembers };
          if (oldGroup.core === newGroup.core && pair.oldMembers.length === pair.newMembers.length) {
            pair.newMembers.forEach((newMember, index) => stableBind(newMember, pair.oldMembers[index]));
            continue;
          }
          for (const semanticOnly of [false, true]) {
            const oldBy = new Map(), newBy = new Map();
            pair.oldMembers.filter(oldMember => !used.has(previousRows[oldMember].id.toLowerCase())).forEach(oldMember => {
              const row = previousRows[oldMember], span = old.spans[oldMember];
              const key = semanticOnly ? JSON.stringify([textareaValue(row.content), row.enabled]) : previousText.slice(span.start, span.end);
              oldBy.set(key, [...(oldBy.get(key) || []), oldMember]);
            });
            pair.newMembers.filter(newMember => !matches.has(newMember)).forEach(newMember => {
              const item = records[newMember];
              const key = semanticOnly ? JSON.stringify([textareaValue(item.content), item.enabled]) : text.slice(item.start, item.end);
              newBy.set(key, [...(newBy.get(key) || []), newMember]);
            });
            for (const [key, oldMembers] of oldBy) {
              const newMembers = newBy.get(key);
              // Equal duplicate counts are the same ordered occurrences inside
              // this explicit source group. Reserve all of them before global
              // matching; unequal counts remain ambiguous and are reconciled later.
              if (newMembers?.length === oldMembers.length)
                newMembers.forEach((newMember, index) => (semanticOnly ? identityBind : stableBind)(newMember, oldMembers[index]));
            }
          }
        }
        const oldIndex = old.spans.findIndex(span => start >= offset(span.start, previousText) && oldEnd <= offset(span.end, previousText));
        const newIndex = records.findIndex(item => start >= offset(item.start, text) && newEnd <= offset(item.end, text));
        // A single source-row edit (including checkbox typing) owns its ID even
        // when it becomes textually identical to a neighboring duplicate.
        if (oldIndex >= 0 && newIndex >= 0 && !matches.has(newIndex) && !used.has(previousRows[oldIndex].id.toLowerCase())) {
          matches.set(newIndex, previousRows[oldIndex]); used.add(previousRows[oldIndex].id.toLowerCase());
        } else {
          // A heading group owns the surrounding separator bytes up to its
          // neighboring groups, but a separator-only edit owns no heading. This
          // lets one paste rename a heading and add/remove rules or blank lines
          // without allowing the destination group to steal surviving UUIDs.
          const headingGroup = (items, raw, changedEnd) => {
            const rawLength = offset(raw.length, raw);
            for (let first = 0; first < items.length;) {
              let last = first;
              while (last + 1 < items.length && items[last + 1].headingStart === items[first].headingStart) last++;
              const headingStart = offset(items[first].headingStart, raw), headingEnd = offset(items[first].headingEnd, raw);
              const ownedStart = first ? offset(items[first - 1].end, raw) : 0;
              const ownedEnd = last + 1 < items.length ? offset(items[last + 1].headingStart, raw) : rawLength;
              const intersects = (rangeStart, rangeEnd) => changedEnd > start
                ? start < rangeEnd && changedEnd > rangeStart
                : start >= rangeStart && start <= rangeEnd;
              const touchesGroup = intersects(headingStart, headingEnd) || items.slice(first, last + 1)
                .some(item => intersects(offset(item.start, raw), offset(item.end, raw)));
              if (start >= ownedStart && changedEnd <= ownedEnd && touchesGroup)
                return Array.from({ length: last - first + 1 }, (_, index) => first + index);
              first = last + 1;
            }
            return null;
          };
          const oldMembers = headingGroup(old.spans, previousText, oldEnd), newMembers = headingGroup(records, text, newEnd);
          if (oldMembers && newMembers) {
            const remainingOld = oldMembers.filter(index => !used.has(previousRows[index].id.toLowerCase())), bind = (index, oldMember) => {
              const previous = previousRows[oldMember];
              matches.set(index, previous); used.add(previous.id.toLowerCase());
              remainingOld.splice(remainingOld.indexOf(oldMember), 1);
            };
            // Deleted members stay reserved; a newly inserted duplicate must mint
            // a UUID rather than recycling identity removed by this paste.
            oldMembers.forEach(index => used.add(previousRows[index].id.toLowerCase()));
            // Preserve exact rules that moved inside a renamed group before using
            // source order for genuinely edited survivors.
            for (const includeEnabled of [true, false]) newMembers.forEach(index => {
              if (matches.has(index)) return;
              const found = remainingOld.find(oldMember => textareaValue(previousRows[oldMember].content) === textareaValue(records[index].content) &&
                (!includeEnabled || previousRows[oldMember].enabled === records[index].enabled));
              if (found !== undefined) bind(index, found);
            });
            newMembers.forEach(index => {
              if (matches.has(index)) return;
              if (remainingOld.length) bind(index, remainingOld[0]);
              else forcedFresh.add(index);
            });
          }
        }
      }
      // Reserve all exact occurrences BEFORE assigning edited rows, so a rename
      // cannot steal an existing ID from a distinct row moved elsewhere.
      for (const includeEnabled of [true, false]) records.forEach((item, index) => {
        if (matches.has(index) || forcedFresh.has(index)) return;
        const previous = previousRows.find(row => !used.has(row.id.toLowerCase()) && row.category === item.category &&
          textareaValue(row.content) === textareaValue(item.content) && (!includeEnabled || row.enabled === item.enabled));
        if (previous) { matches.set(index, previous); used.add(previous.id.toLowerCase()); }
      });
      // Exact matches above also preserve rules moved across source groups. Only
      // then use source order for genuinely edited survivors in paired groups;
      // deleted identities stay reserved and unmatched insertions must be fresh.
      for (const pair of sourceGroupPairs) {
        const oldMembers = pair.oldMembers.filter(index => !used.has(previousRows[index].id.toLowerCase()));
        const newMembers = pair.newMembers.filter(index => !matches.has(index) && !forcedFresh.has(index));
        while (oldMembers.length && newMembers.length) {
          const oldMember = oldMembers.shift(), newMember = newMembers.shift(), previous = previousRows[oldMember];
          matches.set(newMember, previous); used.add(previous.id.toLowerCase());
        }
        oldMembers.forEach(index => used.add(previousRows[index].id.toLowerCase()));
        newMembers.forEach(index => forcedFresh.add(index));
      }
      if (typeof previousText === 'string' && records.length === previousRows.length) records.forEach((item, index) => {
        const previous = previousRows[index];
        if (!matches.has(index) && !forcedFresh.has(index) && !used.has(previous.id.toLowerCase())) { matches.set(index, previous); used.add(previous.id.toLowerCase()); }
      });
      used.clear();
      for (const [index, item] of records.entries()) {
        const previous = matches.get(index);
        let id = previous?.id, generated = false;
        if (!id) { generated = true; try { id = cryptoProvider?.randomUUID?.(); } catch { return bad('constraintsCrypto'); } }
        if (typeof id !== 'string') return bad('constraintsCrypto');
        const key = id.toLowerCase();
        if (generated && (previousIds.has(key) || used.has(key))) return bad('constraintsCrypto');
        if (used.has(key)) return bad();
        used.add(key);
        const content = previous && !exactEol ? applyTextareaEdit(previous.content, item.content) :
          previous && textareaValue(previous.content) === textareaValue(item.content) ? previous.content : item.content;
        rows.push({ id, category: item.category, content, enabled: item.enabled });
        spans.push({ id, start: item.start, end: item.end, headingStart: item.headingStart, headingEnd: item.headingEnd,
          categoryStart: item.categoryStart, categoryEnd: item.categoryEnd });
      }
      return validWritingConstraints(rows) ? { rows, error: '', spans } : bad();
    }
    function editConstraintsMarkdown(w, bookId, value, cryptoProvider = globalThis.crypto) {
      if (!w || w.book.id !== bookId) return w;
      const editor = w.constraintsEditor || constraintsEditorState(w.settings.writingConstraints);
      return writeConstraintsSource(w, editor, applyTextareaEdit(editor.text, value), cryptoProvider);
    }
    function writeConstraintsSource(w, editor, text, cryptoProvider, sourceChanges = null, exactEol = false, sourceAnchors = null) {
      if (text.length > 2000000) throw new Error('constraintsMarkdownTooLong');
      if (text === editor.text) return w;
      const parsed = parseConstraintsMarkdown(text, w.settings.writingConstraints, cryptoProvider, { previousText: editor.parsedText,
        sourceChanges: editor.text === editor.parsedText ? sourceChanges : null, exactEol, sourceAnchors, rejectPlaceholders: true });
      return { ...w, constraintsEditor: { ...editor, text, parsedText: parsed.error ? editor.parsedText : text, error: parsed.error },
        settings: parsed.error ? w.settings : { ...w.settings, writingConstraints: parsed.rows } };
    }
    // Editor transactions use LF/UTF-16 coordinates. Splice each changed range
    // independently, so disjoint edits don't rewrite any untouched CRLF or CR.
    function applyConstraintsChanges(source, update) {
      if (!update || typeof update.text !== 'string' || textareaValue(source) !== update.before || !Array.isArray(update.changes)) return null;
      if (update.text.length > 2000000) throw new Error('constraintsMarkdownTooLong');
      const eol = source.match(/\r\n|\r|\n/)?.[0] || '\n';
      let raw = 0, logical = 0, previous = 0, text = '';
      const at = position => {
        while (logical < position && raw < source.length) {
          raw += source[raw] === '\r' && source[raw + 1] === '\n' ? 2 : 1;
          logical++;
        }
        return raw;
      };
      const append = part => {
        // A preserved lone CR followed by an independent LF must not turn into
        // one logical newline when deleting the text that separated them.
        if (text.endsWith('\r') && part.startsWith('\n')) text += '\n';
        text += part;
      };
      for (const change of update.changes) {
        if (!change || !Number.isSafeInteger(change.from) || !Number.isSafeInteger(change.to) ||
            change.from < logical || change.to < change.from || change.to > update.before.length ||
            typeof change.insert !== 'string' || change.insert.includes('\r')) return null;
        append(source.slice(previous, at(change.from)));
        append(change.insert.replace(/\n/g, eol));
        previous = at(change.to);
      }
      append(source.slice(previous));
      if (text.length > 2000000) throw new Error('constraintsMarkdownTooLong');
      return textareaValue(text) === update.text ? text : null;
    }
    function sameConstraintsDraft(a, b) {
      return !!a && !!b && a.text === b.text && a.parsedText === b.parsedText && a.error === b.error &&
        equal(a.anchoredStarts, b.anchoredStarts) && (a.rows === b.rows || equal(a.rows, b.rows));
    }
    function constraintsHistorySnapshot(w) {
      const { baseText: _baseline, ...draft } = w.constraintsEditor;
      return { ...draft, rows: w.settings.writingConstraints };
    }
    function constraintsHistoryTarget(update, history) {
      const saved = (update.origin === 'undo' || update.origin === 'redo') && history.get(update.version);
      return saved && textareaValue(saved.text) === update.text ? saved : null;
    }
    function applyConstraintsInput(w, update, text, saved, cryptoProvider = globalThis.crypto) {
      const editor = w.constraintsEditor;
      // Restore the exact ordered identities and raw source from a trusted editor
      // history token, but never restore a stale CAS baseline or unrelated settings.
      if (saved) {
        const { rows, ...draft } = saved;
        return { ...w, constraintsEditor: { ...draft, baseText: editor.baseText }, settings: { ...w.settings, writingConstraints: rows } };
      }
      let anchors = editor.error && editor.anchoredStarts ? remapConstraintStarts(editor.anchoredStarts, update.changes) : null;
      const next = writeConstraintsSource(w, editor, text, cryptoProvider, update.changes, true, anchors);
      // Recover these actual edit coordinates together with an unfinished draft:
      // its text alone can't distinguish where an identical new rule was typed.
      if (next !== w && next.constraintsEditor.error && !editor.error) {
        const old = parseConstraintsMarkdown(editor.text, w.settings.writingConstraints, null, { allowEmpty: true });
        if (!old.error) {
          const offset = normalizedSourceOffsets(editor.text);
          anchors = remapConstraintStarts(old.spans.map(span => offset(span.start)), update.changes);
        }
      }
      if (next !== w && next.constraintsEditor.error && anchors) next.constraintsEditor.anchoredStarts = anchors;
      return next;
    }
    // Resolve the source slices that the rule toolbar and focused caret refer to.
    function constraintVisualTargets(text, rows = [], cryptoProvider = globalThis.crypto) {
      const source = typeof text === 'string' ? text : '';
      if (!validWritingConstraints(rows)) return null;
      if (!rows.length) return source.trim() ? null : { groups: [], rules: [] };
      const parsed = parseConstraintsMarkdown(source, rows, cryptoProvider);
      if (parsed.error || parsed.rows.length !== rows.length || parsed.rows.some((row, index) => {
        const expected = rows[index];
        return row.category !== expected.category || textareaValue(row.content) !== textareaValue(expected.content) || row.enabled !== expected.enabled;
      })) return null;
      const rules = [], groups = [];
      for (const [index, span] of parsed.spans.entries()) {
        const row = rows[index], prefix = /^(?:(?: {4}|\t))?[-*+] (?:\[[ xX]\] )?/.exec(source.slice(span.start, span.end));
        if (!prefix) return null;
        const start = span.start + prefix[0].length;
        rules.push({ kind: 'rule', id: row.id, ids: [row.id], lineStart: span.start, start, end: span.end, expectedSlice: source.slice(start, span.end) });
        const group = groups.at(-1);
        if (group?.lineStart === span.headingStart) group.ids.push(row.id);
        else groups.push({ kind: 'category', id: row.id, ids: [row.id], category: row.category, firstIndex: index,
          lineStart: span.headingStart, start: span.categoryStart, end: span.categoryEnd, expectedSlice: source.slice(span.categoryStart, span.categoryEnd) });
      }
      return { groups, rules };
    }
    function editConstraintVisualBlock(w, bookId, target, value, cryptoProvider = globalThis.crypto) {
      if (!w || w.book.id !== bookId || !target || typeof value !== 'string') return null;
      const editor = w.constraintsEditor || constraintsEditorState(w.settings.writingConstraints), source = editor.text;
      if (target.expectedText !== source || !['category', 'rule'].includes(target.kind) || !Array.isArray(target.ids) || !target.ids.length ||
          !Number.isSafeInteger(target.start) || !Number.isSafeInteger(target.end) || target.start < 0 || target.end < target.start || target.end > source.length ||
          source.slice(target.start, target.end) !== target.expectedSlice) return null;
      const rows = copyWritingConstraints(w.settings.writingConstraints), indexes = target.ids.map(id => rows.findIndex(row => row.id === id));
      if (indexes.some(index => index < 0) || new Set(indexes).size !== indexes.length || indexes.some((index, offset) => offset && index !== indexes[0] + offset)) return null;
      let semanticValue, replacement;
      if (target.kind === 'rule') {
        if (target.ids.length !== 1) return null;
        semanticValue = applyTextareaEdit(rows[indexes[0]].content, value);
        rows[indexes[0]] = { ...rows[indexes[0]], content: semanticValue };
        replacement = semanticValue.replace(/(\r\n|\r|\n)/g, '$1      ');
      } else {
        const category = rows[indexes[0]].category;
        if (indexes.some(index => rows[index].category !== category)) return null;
        semanticValue = applyTextareaEdit(category, value);
        indexes.forEach(index => { rows[index] = { ...rows[index], category: semanticValue }; });
        replacement = /[\r\n]/.test(semanticValue) || semanticValue.startsWith('"') ? JSON.stringify(semanticValue) : semanticValue;
      }
      const text = source.slice(0, target.start) + replacement + source.slice(target.end);
      if (text.length > 2000000) throw new Error('constraintsMarkdownTooLong');
      const schemaValid = validWritingConstraints(rows);
      const parsed = schemaValid ? parseConstraintsMarkdown(text, rows, cryptoProvider, { previousText: editor.parsedText }) : null;
      const syntaxValid = !!parsed && !parsed.error && parsed.rows.length === rows.length && parsed.rows.every((row, index) =>
        row.category === rows[index].category && textareaValue(row.content) === textareaValue(rows[index].content) && row.enabled === rows[index].enabled);
      const valid = schemaValid && syntaxValid;
      const workspace = text === source && (valid || editor.error) ? w : {
        ...w,
        settings: valid ? { ...w.settings, writingConstraints: rows } : w.settings,
        constraintsEditor: { ...editor, text, parsedText: valid ? text : editor.parsedText, error: valid ? '' : 'constraintsMarkdownInvalid' },
      };
      return { workspace, valid, value: textareaValue(semanticValue), target: { ...target, end: target.start + replacement.length, expectedText: text, expectedSlice: replacement } };
    }
    function markdownTextareaEdit(text, start, end, key, { shiftKey = false, composing = false } = {}) {
      if (composing || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length || !['Tab', 'Enter'].includes(key)) return null;
      const value = textareaValue(text);
      if (end > value.length || key === 'Enter' && shiftKey) return null;
      const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
      if (key === 'Tab') {
        // Markdown indentation is structural: indent the whole current line even
        // with a collapsed caret, so a new top-level bullet can become a rule.
        const blockEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
        const nextLine = value.indexOf('\n', blockEnd), stop = nextLine < 0 ? value.length : nextLine;
        const block = value.slice(lineStart, stop), parts = block.split('\n');
        let firstDelta = 0, delta = 0;
        const changed = parts.map((line, index) => {
          const remove = shiftKey ? (/^(?: {1,4}|\t)/.exec(line)?.[0].length || 0) : 0;
          const amount = shiftKey ? -remove : 4;
          if (!index) firstDelta = amount;
          delta += amount; return shiftKey ? line.slice(remove) : '    ' + line;
        }).join('\n');
        return { value: value.slice(0, lineStart) + changed + value.slice(stop), start: Math.max(lineStart, start + firstDelta), end: Math.max(lineStart, end + delta) };
      }
      const before = value.slice(lineStart, start), bullet = /^(\s*)([-*+] |\d+\. )(?:\[([ xX])\] )?/.exec(before);
      if (!bullet) return null;
      const prefix = bullet[1] + (/^\d/.test(bullet[2]) ? (Number(bullet[2].slice(0, -2)) + 1) + '. ' : bullet[2]) + (bullet[3] === undefined ? '' : '[ ] ');
      if (before === bullet[0]) return { value: value.slice(0, lineStart) + '\n' + value.slice(end), start: lineStart + 1, end: lineStart + 1 };
      const inserted = '\n' + prefix;
      return { value: value.slice(0, start) + inserted + value.slice(end), start: start + inserted.length, end: start + inserted.length };
    }
    function constraintsDocumentKey(text, start, end, key, options = {}) {
      if (options.composing) return null;
      if (key === 'Enter') {
        const value = textareaValue(text);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > value.length) return null;
        const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
        const nextLine = value.indexOf('\n', start), lineEnd = nextLine < 0 ? value.length : nextLine;
        const currentLine = value.slice(lineStart, lineEnd);
        const afterHeading = /^#{1,2} .+/m.test(value.slice(0, lineStart));
        const rule = /^( {4}|\t)?[-*+] /.exec(currentLine);
        const isRule = rule && (rule[1] || afterHeading);
        const continuation = currentLine.startsWith('      ');
        const insertLine = prefix => {
          const inserted = '\n' + prefix, caret = start + inserted.length;
          return { value: value.slice(0, start) + inserted + value.slice(end), start: caret, end: caret };
        };
        if (options.shiftKey && (isRule || continuation) || continuation && !/^ {6,}(?:[-*+] |\d+\. )/.test(currentLine)) return insertLine('      ');
        if (!options.shiftKey && end <= lineEnd) {
          const starter = '- [x] - ';
          // The same unindented bullet is a category in list syntax but a
          // sibling rule after a #/## heading. Keep the parser's distinction.
          const category = /^(?:#{1,2}|[-*+]) (.+)$/.exec(value.slice(lineStart, start));
          if (!isRule && category?.[1].trim() && end === lineEnd) return insertLine('    ' + starter);
          const marked = isRule && /^\[[ xX]\] -(?: |$)/.exec(currentLine.slice(rule[0].length));
          if (marked && start >= lineStart + rule[0].length + marked[0].length) return insertLine((rule[1] || '') + starter);
        }
      }
      return markdownTextareaEdit(text, start, end, key, options);
    }
    // A small, bounded Markdown renderer produces data, never HTML. Remote
    // images and raw HTML stay literal text; only these URL schemes become links.
    function safeMarkdownUrl(url) {
      if (typeof url !== 'string' || /[\u0000-\u0020\u007f]/.test(url)) return null;
      return /^(?:https?:\/\/|mailto:)/i.test(url) ? url : null;
    }
    function markdownInline(text, depth = 0) {
      if (depth >= 8 || text.length > 20000) return [{ type: 'text', text }];
      const out = [], pattern = /(`+)([^`\n]+)\1|!\[([^\]\n]*)\]\(([^)\n]*)\)|\[([^\]\n]+)\]\(([^)\n]*)\)|(\*\*|__|~~|\*|_)([^\n]+?)\7|\\([\\`*_[\]{}()#+.!>~-])/g;
      let offset = 0, item;
      while ((item = pattern.exec(text))) {
        if (item.index > offset) out.push({ type: 'text', text: text.slice(offset, item.index) });
        if (item[1]) out.push({ type: 'code', text: item[2] });
        else if (item[3] !== undefined) out.push({ type: 'text', text: '![' + item[3] + '](' + item[4] + ')' });
        else if (item[5] !== undefined) {
          const url = safeMarkdownUrl(item[6]);
          out.push(url ? { type: 'a', url, children: markdownInline(item[5], depth + 1) } : { type: 'text', text: item[0] });
        } else if (item[7]) out.push({ type: item[7].length === 2 ? item[7] === '~~' ? 'del' : 'strong' : 'em', children: markdownInline(item[8], depth + 1) });
        else out.push({ type: 'text', text: item[9] });
        offset = pattern.lastIndex;
      }
      if (offset < text.length) out.push({ type: 'text', text: text.slice(offset) });
      return out;
    }
    function markdownBlocks(text, depth = 0) {
      if (depth >= 8 || text.length > 20000) return [{ type: 'p', text }];
      const lines = textareaValue(text).split('\n'), out = [];
      let index = 0;
      const special = line => /^(?:\s*$| {0,3}(?:#{1,6} |```|~~~|>|(?:[-*+] |\d+\. )|(?:-{3,}|\*{3,}|_{3,})\s*$))/.test(line);
      while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) { index++; continue; }
        const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
          const content = []; index++;
          while (index < lines.length && !new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$').test(lines[index])) content.push(lines[index++]);
          if (index < lines.length) index++;
          out.push({ type: 'pre', text: content.join('\n') }); continue;
        }
        const heading = /^ {0,3}(#{1,6}) (.*)$/.exec(line);
        if (heading) { out.push({ type: 'h' + heading[1].length, children: markdownInline(heading[2]) }); index++; continue; }
        if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push({ type: 'hr' }); index++; continue; }
        if (/^ {0,3}>/.test(line)) {
          const content = [];
          while (index < lines.length && /^ {0,3}>/.test(lines[index])) content.push(lines[index++].replace(/^ {0,3}> ?/, ''));
          out.push({ type: 'blockquote', children: markdownBlocks(content.join('\n'), depth + 1) }); continue;
        }
        const bullet = /^( {0,3})([-*+] |\d+\. )(.*)$/.exec(line);
        if (bullet) {
          const ordered = /^\d/.test(bullet[2]), items = [];
          while (index < lines.length) {
            const next = /^( {0,3})([-*+] |\d+\. )(.*)$/.exec(lines[index]);
            if (!next || /^\d/.test(next[2]) !== ordered) break;
            const content = [next[3]], indent = next[1].length + next[2].length; index++;
            while (index < lines.length && new RegExp('^ {' + indent + ',}').test(lines[index])) content.push(lines[index++].slice(indent));
            const task = /^\[([ xX])\] (.*)$/.exec(content[0]);
            if (task) content[0] = task[2];
            items.push({ type: 'li', checked: task ? task[1] !== ' ' : null, children: markdownBlocks(content.join('\n'), depth + 1) });
          }
          out.push({ type: ordered ? 'ol' : 'ul', children: items }); continue;
        }
        const content = [line]; index++;
        while (index < lines.length && !special(lines[index])) content.push(lines[index++]);
        out.push({ type: 'p', children: markdownInline(content.join('\n')) });
      }
      return out;
    }
    function editConstraintStructureMarkdown(source, previousRows, rows, action) {
      if (typeof source !== 'string' || !validWritingConstraints(previousRows) || !validWritingConstraints(rows)) return null;
      const parsed = parseConstraintsMarkdown(source, previousRows, null, { previousText: source });
      if (parsed.error || parsed.spans.length !== previousRows.length) return null;
      const eolAfter = end => /^(\r\n|\r|\n)/.exec(source.slice(end))?.[1] || /\r\n|\r|\n/.exec(source)?.[0] || '\n';
      const rulePrefix = span => {
        const lineEnd = source.slice(span.start).search(/[\r\n]/), line = source.slice(span.start, lineEnd < 0 ? source.length : span.start + lineEnd);
        return /^((?: {4}|\t)?[-*+] )(?:\[[ xX]\] )?/.exec(line);
      };
      let text = null;
      if (action.type === 'edit' && action.field === 'enabled') {
        const index = previousRows.findIndex(row => row.id === action.id), span = parsed.spans[index], prefix = span && rulePrefix(span);
        if (!prefix) return null;
        const replacement = prefix[1] + (rows[index].enabled ? '[x] ' : '[ ] ');
        text = source.slice(0, span.start) + replacement + source.slice(span.start + prefix[0].length);
      } else if (action.type === 'remove') {
        const index = previousRows.findIndex(row => row.id === action.id), span = parsed.spans[index];
        if (!span) return null;
        if (!rows.length) text = '';
        else {
          const members = parsed.spans.filter(item => item.headingStart === span.headingStart);
          let start = members.length === 1 ? span.headingStart : span.start, end = span.end;
          if (members.length === 1) {
            const firstGroup = parsed.spans[0]?.headingStart === span.headingStart;
            if (firstGroup) end += /^(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))*/.exec(source.slice(end))?.[0].length || 0;
            else start -= /(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))*$/.exec(source.slice(0, start))?.[0].length || 0;
          } else {
            const following = /^(\r\n|\r|\n)/.exec(source.slice(end))?.[1] || '';
            if (following) end += following.length;
            else start -= /(\r\n|\r|\n)$/.exec(source.slice(0, start))?.[1].length || 0;
          }
          text = source.slice(0, start) + source.slice(end);
        }
      } else if (action.type === 'move') {
        const index = previousRows.findIndex(row => row.id === action.id), other = index + action.direction;
        if (index < 0 || other < 0 || other >= previousRows.length) return null;
        const left = Math.min(index, other), right = Math.max(index, other), leftSpan = parsed.spans[left], rightSpan = parsed.spans[right];
        if (right !== left + 1 || !leftSpan || !rightSpan) return null;
        if (leftSpan.headingStart === rightSpan.headingStart || previousRows[left].category === previousRows[right].category) {
          const between = source.slice(leftSpan.end, rightSpan.start);
          text = source.slice(0, leftSpan.start) + source.slice(rightSpan.start, rightSpan.end) + between +
            source.slice(leftSpan.start, leftSpan.end) + source.slice(rightSpan.end);
        } else {
          const first = parsed.spans.findIndex(span => span.headingStart === leftSpan.headingStart);
          let last = right;
          while (last + 1 < parsed.spans.length && parsed.spans[last + 1].headingStart === rightSpan.headingStart) last++;
          if (first < 0) return null;
          const eol = eolAfter(parsed.spans[first].headingEnd), rebuilt = [];
          let category = null;
          for (const row of rows.slice(first, last + 1)) {
            const original = previousRows.findIndex(previous => previous.id === row.id), span = parsed.spans[original];
            if (original < 0 || !span) return null;
            if (row.category !== category) {
              if (rebuilt.length) rebuilt.push(eol, eol);
              rebuilt.push(source.slice(span.headingStart, span.headingEnd), eol);
              category = row.category;
            } else rebuilt.push(eol);
            rebuilt.push(source.slice(span.start, span.end));
          }
          text = source.slice(0, parsed.spans[first].headingStart) + rebuilt.join('') + source.slice(parsed.spans[last].end);
        }
      } else if (action.type === 'add') {
        const addedIndex = rows.findIndex(row => !previousRows.some(previous => previous.id === row.id)), added = rows[addedIndex];
        if (!added) return null;
        if (!previousRows.length) text = serializeConstraintsMarkdown(rows);
        else {
          const anchorIndex = action.afterId == null ? previousRows.length - 1 : previousRows.findIndex(row => row.id === action.afterId);
          const span = parsed.spans[anchorIndex], prefix = span && rulePrefix(span);
          if (!span || !prefix || addedIndex !== anchorIndex + 1) return null;
          const eol = eolAfter(span.end), content = textareaValue(added.content).replace(/\n/g, eol + '      ');
          const rule = prefix[1] + (added.enabled ? '[x] ' : '[ ] ') + content;
          if (added.category === previousRows[anchorIndex].category) text = source.slice(0, span.end) + eol + rule + source.slice(span.end);
          else {
            if (anchorIndex !== previousRows.length - 1) return null;
            const heading = source.slice(span.headingStart, span.headingEnd), marker = /^(#{1,2} |[-*+] )/.exec(heading)?.[1];
            if (!marker) return null;
            const category = /[\r\n]/.test(added.category) || added.category.startsWith('"') ? JSON.stringify(added.category) : added.category;
            text = source.slice(0, span.end) + eol + eol + marker + category + eol + rule + source.slice(span.end);
          }
        }
      }
      return text !== null && text.length <= 2000000 && constraintsDocumentMatches(text, rows) ? text : null;
    }
    function editWritingConstraints(w, bookId, action, cryptoProvider = globalThis.crypto) {
      if (!w || w.book.id !== bookId || w.constraintsEditor?.error && w.constraintsEditor.text !== w.constraintsEditor.parsedText) return w;
      const previousRows = copyWritingConstraints(w.settings.writingConstraints), rows = copyWritingConstraints(previousRows);
      if (action.type === 'add') {
        if (rows.length >= 64) throw new Error('constraintsLimit');
        if (typeof cryptoProvider?.randomUUID !== 'function') throw new Error('constraintsCrypto');
        const id = cryptoProvider.randomUUID(), category = action.category ?? '', content = action.content ?? '';
        if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
            previousRows.some(row => row.id.toLowerCase() === id.toLowerCase())) throw new Error('constraintsCrypto');
        const added = { id, category, content, enabled: action.enabled ?? true };
        if (!validWritingConstraints([added], !action.category && !action.content)) throw new Error('constraintsMarkdownInvalid');
        const after = action.afterId == null ? rows.length - 1 : rows.findIndex(row => row.id === action.afterId);
        if (action.afterId != null && after < 0) return w;
        rows.splice(after + 1, 0, added);
      } else {
        const index = rows.findIndex(row => row.id === action.id);
        if (index < 0) return w;
        if (action.type === 'edit' && ['category', 'content', 'enabled'].includes(action.field)) rows[index] = { ...rows[index], [action.field]: action.value };
        else if (action.type === 'remove') rows.splice(index, 1);
        else if (action.type === 'move' && [-1, 1].includes(action.direction) && rows[index + action.direction]) {
          [rows[index], rows[index + action.direction]] = [rows[index + action.direction], rows[index]];
        } else return w;
      }
      if (equal(rows, previousRows)) return w;
      const editor = w.constraintsEditor || constraintsEditorState(w.settings.writingConstraints);
      const structural = action.type === 'add' || action.type === 'remove' || action.type === 'move' || action.type === 'edit' && action.field === 'enabled';
      const preserved = structural && validWritingConstraints(rows) ? editConstraintStructureMarkdown(editor.text, previousRows, rows, action) : null;
      if (structural && validWritingConstraints(rows) && preserved === null) throw new Error('constraintsMarkdownInvalid');
      const text = preserved ?? serializeConstraintsMarkdown(rows);
      return { ...w, settings: { ...w.settings, writingConstraints: rows },
        constraintsEditor: { ...editor, text, parsedText: text, error: validWritingConstraints(rows) ? '' : 'constraintsMarkdownInvalid' } };
    }
    function restoredWorkspace(active, value) {
      const next = workspace(active.book, value.dirty.chapter || value.dirty.candidate ? value.chapterId : active.chapterId);
      for (const [kind, fields] of [['chapter', ['chapter', 'baseChapter']], ['settings', ['settings', 'baseSettings']], ['card', ['card', 'baseCard']], ['candidate', ['candidateId', 'candidate', 'baseCandidate']]]) {
        if (value.dirty[kind]) for (const field of fields) next[field] = kind === 'settings'
          ? { ...value[field], writingConstraints: copyWritingConstraints(value[field].writingConstraints === undefined ? active.book.writingConstraints : value[field].writingConstraints) } : value[field];
      }
      if (value.dirty.settings) {
        next.constraintsEditor = value.constraintsEditor ? { ...value.constraintsEditor } : {
          ...constraintsEditorState(next.settings.writingConstraints), baseText: serializeConstraintsMarkdown(next.baseSettings.writingConstraints) };
      }
      return next;
    }
    function cardRange(card) {
      const from = card.fromChapter.trim() ? Number(card.fromChapter) : NaN;
      const to = card.toChapter.trim() ? Number(card.toChapter) : null;
      return Number.isSafeInteger(from) && from >= 1 && (to === null || Number.isSafeInteger(to) && to >= from)
        ? { fromChapter: from, toChapter: to } : null;
    }
    // Manual autosave is a separate serialized lane. It never generates or approves AI output.
    function autosaveStep(w) {
      if (!w) return null;
      const text = (value, limit, required = false) => typeof value === 'string' && value.length <= limit &&
        (!required || !!value.trim()) && !/[\uD800-\uDFFF]/u.test(value);
      const chapterPatch = w.chapter ? patchOf(w.baseChapter, w.chapter) : {};
      const chapterLimits = { title: 300, outline: 50000, body: 200000, summary: 40000 };
      // Only manually edited chapter fields enter this lane; AI summaries remain proposals.
      const chapter = Object.fromEntries(Object.entries(chapterPatch).filter(([key, value]) =>
        key === 'status' ? ['draft', 'final'].includes(value) : Object.hasOwn(chapterLimits, key) && text(value, chapterLimits[key], key === 'title')));
      if (Object.keys(chapter).length) return { kind: 'chapter', operation: { action: 'updateChapter', chapterId: w.chapterId, patch: chapter } };
      const settingsPatch = patchOf(w.baseSettings, w.settings), settings = {};
      for (const [key, value] of Object.entries(settingsPatch)) {
        if (key === 'writingConstraints') { if (!w.constraintsEditor?.error && validWritingConstraints(value)) settings[key] = copyWritingConstraints(value); }
        else if (key === 'contextBudget') {
          const budget = typeof value === 'string' && value.trim() ? Number(value) : NaN;
          if (Number.isSafeInteger(budget) && budget >= 1000 && budget <= 60000) settings[key] = budget;
        } else if (Object.hasOwn({ title: 300, premise: 100000, outline: 200000, style: 50000 }, key) &&
            text(value, { title: 300, premise: 100000, outline: 200000, style: 50000 }[key], key === 'title')) settings[key] = value;
      }
      if (Object.keys(settings).length) return { kind: 'settings', operation: { action: 'updateBook', patch: settings } };
      if (dirty(w).card) {
        const c = w.card, scope = cardRange(c);
        const tags = c.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
        if (text(c.title, 300, true) && text(c.content, 50000) && cardKinds.includes(c.kind) && cardCategoryFieldValid(c) &&
            (!c.categoryId || !w.book || hasCategory(w.book, c.categoryId)) &&
            ['proposed', 'confirmed'].includes(c.status) && typeof c.pinned === 'boolean' && scope && tags.length <= 50 && tags.every(tag => text(tag, 100, true))) {
          const card = { ...c, ...scope, tags };
          return { kind: 'card', operation: { action: 'saveCard', card } };
        }
      }
      return null;
    }
    function autosaveOperationApplied(book, snapshot, step) {
      const target = step.kind === 'chapter' ? book.chapters.find(c => c.id === snapshot.chapterId) :
        step.kind === 'settings' ? book : book.cards.find(c => c.id === step.operation.card.id);
      const values = step.kind === 'card' ? step.operation.card : step.operation.patch;
      return !!target && Object.keys(values).every(key => key === 'categoryId' ? (target[key] ?? null) === (values[key] ?? null) : equal(target[key], values[key]));
    }
    function mergeAutosaveAck(local, snapshot, book, step) {
      if (!local || local.book.id !== snapshot.book.id || book?.id !== snapshot.book.id ||
          book.revision !== snapshot.book.revision + 1 || local.book.revision !== snapshot.book.revision || !autosaveOperationApplied(book, snapshot, step)) return null;
      const next = mergeWorkspace(local, book);
      if (step.kind === 'chapter' || step.kind === 'settings') {
        const group = step.kind === 'chapter' ? 'chapter' : 'settings', base = group === 'chapter' ? 'baseChapter' : 'baseSettings';
        const server = group === 'chapter' ? chapterFields(book.chapters.find(c => c.id === snapshot.chapterId)) : bookFields(book);
        if (!server || group === 'chapter' && local.chapterId !== snapshot.chapterId) return null;
        const fields = { ...server };
        for (const key of Object.keys(local[group])) {
          // Compare with SENT draft, not the old baseline: undo-to-original during HTTP is new intent too.
          if (!equal(local[group][key], snapshot[group][key]) ||
              !Object.hasOwn(step.operation.patch, key) && !equal(local[group][key], local[base][key])) fields[key] = local[group][key];
        }
        next[group] = group === 'settings' ? { ...fields, writingConstraints: copyWritingConstraints(fields.writingConstraints) } : fields;
        next[base] = server;
      } else if (step.kind === 'card') {
        const sentId = snapshot.card.id;
        const saved = book.cards.find(c => c.id === step.operation.card.id);
        if (!saved) return null;
        const sameEditor = sentId ? local.card?.id === sentId : local.card && !local.card.id && local.baseCard === snapshot.baseCard;
        if (sameEditor) {
          const server = cardFields(saved), fields = { ...server };
          for (const key of Object.keys(local.card)) if (key !== 'id' && !equal(local.card[key], snapshot.card[key])) fields[key] = local.card[key];
          next.card = fields; next.baseCard = server;
        }
      }
      if (local.constraintsEditor) {
        next.constraintsEditor = { ...local.constraintsEditor };
        if (step.kind === 'settings' && Object.hasOwn(step.operation.patch, 'writingConstraints'))
          next.constraintsEditor.baseText = snapshot.constraintsEditor?.parsedText ?? serializeConstraintsMarkdown(snapshot.settings.writingConstraints);
      }
      return next;
    }
    function missingChapterDraft(book, value) {
      return !!value?.dirty.chapter && !book.chapters.some(chapter => chapter.id === value.chapterId);
    }
    function chapterMutationReceipt(before, book, op) {
      if (book?.id !== before.id || book.revision !== before.revision + 1 || !Array.isArray(book.chapters) || !Array.isArray(book.cards) || !Array.isArray(book.proposals)) return false;
      const old = before.chapters.map(c => c.id), next = book.chapters.map(c => c?.id), index = old.indexOf(op.chapterId);
      const expectedProposals = op.action === 'deleteChapter' ? before.proposals.filter(p => p.chapterId !== op.chapterId) : before.proposals;
      if (!equal(book.proposals, expectedProposals)) return false;
      if (op.action === 'addChapter') {
        const added = book.chapters.at(-1);
        return next.length === old.length + 1 && typeof added?.id === 'string' && !old.includes(added.id) && added.title === op.title && equal(next.slice(0, -1), old);
      }
      if (index < 0) return false;
      if (op.action === 'deleteChapter') return equal(next, old.filter(id => id !== op.chapterId)) &&
        Array.isArray(book.proposals) && !book.proposals.some(proposal => proposal.chapterId === op.chapterId);
      if (op.action === 'moveChapter') {
        const target = index + (op.direction === 'up' ? -1 : 1);
        if (target < 0 || target >= old.length) return false;
        [old[index], old[target]] = [old[target], old[index]];
        return equal(next, old);
      }
      return op.action === 'updateChapter' && equal(next, old) && book.chapters[index].title === op.patch.title;
    }
    function autosaveRecoveryWorkspace(w, pending) {
      if (!w || !pending || pending.snapshot.book.id !== w.book.id || pending.snapshot.book.revision !== w.book.revision) return w;
      const { snapshot, step } = pending;
      if ((step.kind === 'chapter' && w.chapterId !== snapshot.chapterId) || step.kind === 'card' &&
          !(snapshot.card.id ? w.card?.id === snapshot.card.id : w.card && !w.card.id && w.baseCard === snapshot.baseCard)) return w;
      const group = step.kind === 'chapter' ? 'chapter' : step.kind === 'settings' ? 'settings' : 'card';
      const base = group === 'chapter' ? 'baseChapter' : group === 'settings' ? 'baseSettings' : 'baseCard';
      const projected = { ...w[base] }, keys = step.kind === 'card' ? Object.keys(snapshot.card) : Object.keys(step.operation.patch);
      for (const key of keys) if (!equal(w[group][key], snapshot[group][key])) projected[key] = snapshot[group][key];
      const next = { ...w, [base]: projected };
      if (group === 'settings' && w.constraintsEditor && !equal(projected.writingConstraints, w[base].writingConstraints))
        next.constraintsEditor = { ...w.constraintsEditor, baseText: snapshot.constraintsEditor?.parsedText ?? serializeConstraintsMarkdown(snapshot.settings.writingConstraints) };
      return next;
    }
    function autosaveRecoveryPayload(w, state = {}) {
      const data = recoveryPayload(autosaveRecoveryWorkspace(w, state.pendingSnapshot));
      const p = state.pendingCard;
      if (p && p.bookId === w.book.id && data.dirty.card && !w.card.id && state.pendingCardScope === w.baseCard) {
        data.pendingCard = { ...p, card: { ...p.card, tags: p.card.tags.slice() } };
      }
      return data;
    }
    function validAutosaveRecovery(value, bookId) {
      if (!validRecovery(value, bookId)) return false;
      const ownRecord = (object, keys) => !!object && typeof object === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(object)) &&
        Reflect.ownKeys(object).length === keys.length && keys.every(key => {
          const d = Object.getOwnPropertyDescriptor(object, key); return d && d.enumerable && Object.hasOwn(d, 'value');
        });
      const descriptor = Object.getOwnPropertyDescriptor(value, 'pendingCard');
      if (!descriptor) return !('pendingCard' in value);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
      const p = descriptor.value, keys = ['id', 'kind', 'title', 'content', 'status', 'pinned', 'fromChapter', 'toChapter', 'tags'];
      if (!ownRecord(p, ['bookId', 'id', 'baseRevision', 'card'])) return false;
      if (p.card && Object.hasOwn(p.card, 'categoryId')) keys.push('categoryId');
      if (p.bookId !== bookId ||
          !Number.isSafeInteger(p.baseRevision) || p.baseRevision < 1 || typeof p.id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id) ||
          !ownRecord(p.card, keys) || !cardCategoryFieldValid(p.card) || p.card.id !== p.id || !value.dirty.card || value.card.id !== undefined ||
          !Number.isSafeInteger(p.card.fromChapter) || p.card.fromChapter < 1 ||
          !(p.card.toChapter === null || Number.isSafeInteger(p.card.toChapter) && p.card.toChapter >= p.card.fromChapter) ||
          !Array.isArray(p.card.tags) || Object.getPrototypeOf(p.card.tags) !== Array.prototype || p.card.tags.length > 50 ||
          Reflect.ownKeys(p.card.tags).length !== p.card.tags.length + 1) return false;
      for (let i = 0; i < p.card.tags.length; i++) {
        const d = Object.getOwnPropertyDescriptor(p.card.tags, String(i));
        if (!d || !d.enumerable || !Object.hasOwn(d, 'value') || typeof d.value !== 'string' ||
            d.value.length > 100 || !d.value.trim() || /[\uD800-\uDFFF]/u.test(d.value)) return false;
      }
      return !!autosaveStep({ chapter: null, settings: {}, baseSettings: {}, card: cardFields(p.card), baseCard: null });
    }
    function restoredAutosaveWorkspace(active, value) {
      const next = restoredWorkspace(active, value), pending = value.pendingCard;
      const saved = pending && active.book.cards.find(card => card.id === pending.id);
      if (saved && next.card && !next.card.id) {
        const sent = cardFields(pending.card), desired = { ...next.card, id: pending.id };
        if (Object.keys(sent).every(key => equal(desired[key], sent[key]))) { next.card = cardFields(saved); next.baseCard = cardFields(saved); }
        else { next.card = desired; next.baseCard = sent; }
      }
      return next;
    }
    const autosaveCanSave = (w, state = {}) => !!w && (state.running || state.failed || isDirty(autosaveRecoveryWorkspace(w, state.pendingSnapshot)));
    function createAutosaveController({ getWorkspace, getEpoch, isPaused, send, apply, fail, settled = () => {}, started = () => {},
      setTimer = setTimeout, clearTimer = clearTimeout, delay = 1000, newId = () => globalThis.crypto.randomUUID() }) {
      let timer = null, pending = null, pendingSnapshot = null, pendingCard = null, cardScope = null;
      let due = false, halted = false, disposed = false, generation = 0;
      const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
      const run = (manual = false) => {
        if (pending) return pending;
        if (disposed || halted || !due || isPaused(manual)) return Promise.resolve(false);
        const work = async () => {
          while (due && !disposed && !halted && !isPaused(manual)) {
            const snapshot = getWorkspace();
            let step = autosaveStep(snapshot);
            if (!step) {
              // Pure formatting has no Host representation. Acknowledge it only
              // once this lane is idle and canonical rows already match baseline.
              if (constraintsEditorDirty(snapshot) && !snapshot.constraintsEditor.error &&
                  equal(snapshot.settings.writingConstraints, snapshot.baseSettings.writingConstraints))
                apply({ ...snapshot, constraintsEditor: { ...snapshot.constraintsEditor, baseText: snapshot.constraintsEditor.text } }, snapshot.book, null);
              due = false; break;
            }
            const epoch = getEpoch(), token = generation;
            try {
              if (step.kind === 'card' && !snapshot.card.id) {
                if (!pendingCard || pendingCard.bookId !== snapshot.book.id || cardScope !== snapshot.baseCard) {
                  const id = newId();
                  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('constraintsCrypto');
                  pendingCard = { bookId: snapshot.book.id, id, baseRevision: snapshot.book.revision, card: { ...step.operation.card, id } };
                  cardScope = snapshot.baseCard;
                }
                step = { kind: 'card', operation: { action: 'createCard', card: { ...step.operation.card, id: pendingCard.id } } };
                pendingCard = { ...pendingCard, card: step.operation.card, baseRevision: snapshot.book.revision };
              }
              pendingSnapshot = { snapshot, step }; started(pendingSnapshot);
              const book = await send({ bookId: snapshot.book.id, expectedRevision: snapshot.book.revision, operation: step.operation });
              if (disposed || token !== generation || getEpoch() !== epoch || getWorkspace()?.book.id !== snapshot.book.id) break;
              const next = mergeAutosaveAck(getWorkspace(), snapshot, book, step);
              if (!next) throw Object.assign(new Error('autosaveReceipt'), { code: 'CONFLICT' });
              pendingSnapshot = null;
              if (step.operation.action === 'createCard') { pendingCard = null; cardScope = null; }
              apply(next, book, step);
            } catch (error) {
              if (!disposed && token === generation && getEpoch() === epoch && getWorkspace()?.book.id === snapshot.book.id) {
                halted = true; due = false; clear(); fail(error, snapshot);
              }
              break;
            }
          }
          return !halted;
        };
        pending = work().finally(() => { pending = null; settled(); });
        return pending;
      };
      return {
        schedule() { if (disposed || halted) return; clear(); due = false; timer = setTimer(() => { timer = null; due = true; void run(); }, delay); },
        flush({ retry = false, manual = false } = {}) { if (retry) halted = false; clear(); due = true; return run(manual); },
        wait() { return pending || Promise.resolve(true); },
        cancel() { clear(); due = false; generation++; pendingSnapshot = null; pendingCard = null; cardScope = null; },
        resetFailure() { halted = false; if (!pending) pendingSnapshot = null; },
        restorePendingCard(value, scope) { pendingCard = value; cardScope = scope; },
        dispose() { disposed = true; clear(); due = false; generation++; },
        activate() { disposed = false; },
        get running() { return pending !== null; }, get failed() { return halted; },
        get pendingSnapshot() { return pendingSnapshot; }, get pendingCard() { return pendingCard; }, get pendingCardScope() { return cardScope; },
      };
    }
    const constraintsPreviewReady = (value, bookId) => !!value && value?.book?.id === bookId && !value?.constraintsEditor?.error;
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
      chapterOutline: 'Chapter plan', outlineSaved: 'Chapter outline saved.', outlineHint: 'Drafting this chapter uses the complete saved outline. The outline is a plan, not established canon.', outlineAI: 'Generate outline with AI', outlineInstruction: 'Optional guidance for the outline', outlineGenerating: 'Generating chapter outline…', outlineGenerated: 'Outline proposal ready for review.', outlineCandidate: 'AI outline proposal', outlineCandidateStale: 'The source chapter changed. Generate a new proposal before applying it.', outlineReviewReplace: 'Replace the saved outline with this proposal?', outlineReviewHint: 'Only the chapter outline changes. The manuscript stays unchanged.', outlineUse: 'Use this outline', outlineReject: 'Reject outline proposal', outlineRejected: 'Outline proposal rejected.', outlineRefresh: 'Refresh saved outline and proposals', outlineRefreshNeeded: 'Refresh the saved outline before retrying. The previous change may already be saved.', outlineMissing: 'This chapter is no longer available. The outline cannot be applied to another chapter.', outlineBackWriting: 'Back to writing', outlineBackManagement: 'Back to chapter management',
      findText: 'Find on this page', findPrevious: 'Previous match (Shift+Enter)', findNext: 'Next match (Enter)', findClose: 'Close find (Escape)', findCount: '{current} / {total}', findNoResults: 'No matches', findNoChapterBody: 'Open the chapter editor to search its manuscript.', findLimited: '{current} / {total} (limited scan)', findHint: 'Search visible content on this page. On the writing page, search only the current chapter.',
      autosaveHint: 'Manual edits save automatically about 1 second after typing stops. Incomplete fields stay local; AI proposals and model preferences still require explicit action.', autosaveShort: 'Autosave · manual edits', saveNow: 'Save now', autosaveRetry: 'Retry saving', autosavePaused: 'Autosave is paused. Your local edits are kept. Use Retry saving to check the saved version before continuing.', autosaveReceipt: 'The save response did not match the requested edit. Your local edits are kept; review the saved version before retrying.', autosaveIncomplete: 'Some manual fields are incomplete or invalid and remain local. Complete them before saving or continuing.',
      constraints: 'Writing constraints', constraintsHint: 'Book-wide reference conditions for every model call: environment, dialogue, expression or any custom novel element. Examples below are placeholders only.',
      constraintsTextEditor: 'Markdown editor', constraintsShowSource: 'Show Markdown syntax', constraintsHideSource: 'Hide Markdown syntax', constraintsWriteRules: 'Writing rules', constraintsAddRule: 'Add rule', constraintsCurrentActions: 'Current rule actions', constraintsPlaceCaret: 'Place the caret in a rule to manage it',
      constraintsContinuousHint: 'Type directly in the document. Markdown formatting stays in place; move the caret into the text to edit its syntax. Tab indents and Shift+Tab outdents. Press Escape then Tab to leave the editor.',
      constraintsLiteralHint: 'Showing all syntax in the same editor. Turn this off to format the document in place. Press Escape then Tab to leave the editor.',
      constraintsDraftHint: 'Use a top-level bullet for a category, then four spaces and a bullet for each rule. You can also use # or ## category headings with a rule list. [x] means enabled and [ ] means disabled. Press Enter at the end of a category to start an indented - [x] - rule. Enter on an existing - [x] - or - [ ] - rule starts a new enabled rule at the same indent. A starter with no text is not saved. Shift+Enter inside a rule adds a continuation line. Valid changes autosave after typing stops. Incomplete Markdown stays in local recovery and blocks generation. To remove the last rule, use the confirmed Delete action.',
      constraintsHelp: 'Markdown format and saving behavior',
      constraintsGuideExample: '- Setting\n    - [x] Write from the viewpoint character’s senses.\n    - [ ] - Describe the weather in every scene.',
      constraintsRuleStarter: 'Type text for the new rule before it can be saved.',
      constraintsGuideInnerList: 'A rule with no checkbox is enabled by default. The first bullet on the indented line starts a rule. A second hyphen after the checkbox is an optional bullet in the rule text, not a separate rule or switch.',
      constraintsMarkdownTooLong: 'The Markdown document exceeds the local recovery limit of 2000000 UTF-16 units. This input was not applied or truncated; reduce or split the pasted text.',
      constraintsMarkdownInvalid: 'Incomplete or invalid constraints Markdown. Use a category and at least one nonempty child rule (category ≤80, rule ≤4000 UTF-16 units; at most 64 rules). Your exact source remains in local recovery; constraints are not being saved.', constraintsMarkdownEmpty: 'The document is empty but saved or draft rules still exist. Undo the clearing or restore at least one valid rule, then use the confirmed delete buttons to remove rules.', constraintsPlaceholder: '- Environment\n    - Describe what the viewpoint character would notice before broader scenery.', constraintsDeleteTitle: 'Delete this writing constraint?', constraintsDeleteHint: 'Only this rule will be removed. It will no longer apply to new tasks after saving.', constraintsAddCategory: 'Add category', newConstraintCategory: 'New category', newConstraint: 'New writing constraint',
      constraintsModelHint: 'Enabled rules are injected in full within the fixed hard context budget; disabled rules are not applied. Oversized context is rejected, not silently trimmed. Each task keeps its starting snapshot; saved changes affect the next task. The model is not guaranteed to comply semantically. Preview context to inspect the report and prompt.',
      constraintsCount: '{total} / 64 rules · {enabled} enabled · {disabled} disabled', constraintsEmpty: 'No writing constraints. Add only conditions you want this book to use.', constraintsAdd: 'Add constraint', constraintsCategory: 'Category (custom text allowed)', constraintsContent: 'Condition', constraintsEnabled: 'Enabled', constraintsRemove: 'Delete constraint', constraintsRemoveNamed: 'Delete rule {position}: “{rule}”', constraintsUp: 'Move up', constraintsDown: 'Move down', constraintsCategoryPlaceholder: 'Environment, dialogue, expression, or your own category', constraintsContentPlaceholder: 'Example only: describe the environment through the viewpoint character’s senses.', constraintsCategories: 'Environment|Dialogue|Expression|Action|Psychology|Appearance|Plot|Pacing|Viewpoint|Style',
      constraintsLimit: 'A book can have at most 64 writing constraints.', constraintsCrypto: 'Secure UUID generation is unavailable. Use a browser with crypto.randomUUID; no constraint was added.', constraintsInvalid: 'Each writing constraint needs a category (1–80 UTF-16 units), condition (1–4000 UTF-16 units), unique UUID and enabled flag. Complete or delete blank rows before saving; disabled rows also need valid text.',
      writingControls: 'Writing toolbar', collapseControls: 'Focus writing', expandControls: 'Show toolbar',
      chaptersToggle: 'Chapter list', editChapterTitle: 'Edit title', closeTitleEditor: 'Close title editor', workspaceTools: 'Book tools', bookTools: 'Book / chapter tools and export', previousResult: 'Showing an earlier saved result, not output from this attempt.', results: 'Generated results', advanced: 'Model / context / details', insertionContext: 'Original context (insert here; no source text replaced)', insertionSpot: '│ insertion point │', sourceAnchor: 'Original context · append at end', legacyDraft: 'Recovered result edits — resolve explicitly before generation/review', discardResultEdits: 'Discard result edits', newTextLabel: 'New text (not saved)', approveAll: 'Approve all', approveAllHint: 'Approve every pending change in this visible result; previously rejected changes stay original.', summarySaved: 'Current saved summary (not the original generation snapshot)', summaryOnly: 'Summary only — manuscript is unchanged', noSummary: 'No saved summary',
      workspacePages: 'Book and generation pages', contextPageHint: 'Preview the latest saved reference for the current chapter and writing task. This does not call a model.', contextStageOne: 'Whole-chapter rewriting: this shows the first request (analysis). The second request also contains the model’s analysis, which is not available yet.', refreshPreview: 'Refresh preview', generatedContext: 'Context used to generate this result', openBackupTools: 'Open book tools to export a backup', operationDetails: 'Generation details', noGenerationDetails: 'No generated result or task to show for this selection.',
      nav: 'Inspiration', pages: 'Workspace pages', savedTabsDirty: '{page} · unsaved changes',
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
      chapterManagement: 'Chapter management', openChapter: 'Open', renameChapter: 'Rename', chapterUp: 'Move up', chapterDown: 'Move down', deleteChapter: 'Delete chapter', chapterAction: 'Chapter {number} · {title}: {action}', chapterCurrent: 'Current chapter', chapterCountDetails: '{history} versions · {proposals} AI proposals', chapterStructureHint: 'Chapter changes preserve card coverage. If an existing card would need two ranges or lose its only chapter, edit the card before continuing.', chapterStructureBusy: 'Wait for this book’s generation to finish before arranging or deleting chapters.', chapterDeleteWarning: 'Permanently deletes this chapter’s text, summary, history, and AI proposals. Export a JSON backup first. Existing backups, archived job records and model-session logs are not deleted.', chapterDeleteType: 'Type the exact saved chapter title', chapterDeleteMultiline: 'Rename to a single-line title before deleting.', chapterAdded: 'Chapter added.', chapterRenamed: 'Chapter renamed.', chapterMoved: 'Chapter order saved.', chapterDeleted: 'Chapter deleted.', chapterWriteUncertain: 'The change may have been saved. Refresh the saved version and check the chapter list before retrying.', chapterMissingDraft: 'The chapter for this draft no longer exists. Download the local edits before discarding them; they cannot be applied to another chapter.',
      manageBooks: 'Book management', manageBookHint: 'Rename or permanently delete the selected book.', savedBookTitle: 'Exact saved title', bookIdentity: 'Book ID: {id} · revision {revision}', bookOption: '{title} · {count} chapters · {id}',
      renameBook: 'Rename book', renameTitle: 'New book title', renamed: 'Book renamed.', manageUnsaved: 'Resolve all unsaved edits and saved-version conflicts before managing this book.', manageStale: 'The book has changed since this page was opened. Refresh the saved version to review it again.', manageRecovery: 'Restore and save, or explicitly discard the local recovery copy before managing this book.',
      deleteBook: 'Permanently delete book', deleteWarning: 'This cannot be undone. Permanently deletes this book, every chapter, canon card, proposal, revision history and this plugin’s job records. DSH model-session logs are stored separately and are not deleted.',
      deleteBackup: 'Export a JSON backup before deleting. The backup includes saved data only; keep it somewhere safe.', deleteTypeTitle: 'Type the exact saved title to confirm', deleteBusy: 'Deletion is blocked while this book has a running or unsettled generation. Wait for it to finish, or cancel it and wait for cancellation to settle.',
      deleteUnconfirmed: 'The server did not return a matching deletion confirmation. Local data has been kept. Close this dialog and refresh the library before trying again.',
      deleteUncertain: 'The deletion result could not be confirmed. Local data has been kept; the server may already have deleted the book. Refresh the saved version to check. Do not retry blindly.',
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
      manuscript: 'Manuscript', editorHint: 'Write here, or select an exact passage for polishing. Save before asking AI.',
      draft: 'Draft', final: 'Final', chapterStatus: 'Chapter status', chars: '{count} characters', revision: 'Revision {number}',
      selected: '{count} characters selected · offsets {start}–{end}', noSelection: 'Select text in the manuscript for precise polishing.',
      summary: 'Chapter summary',
      maintenance: 'Archive maintenance', prune: 'Clear processed proposals and old history', pruneTitle: 'Permanently clear old archive entries?', pruneHint: 'Export a JSON backup first. Accepted/rejected proposals will be deleted and each chapter will retain only its 5 most recent history snapshots. Ready proposals and current manuscript are kept. This cannot be undone.',
      ai: 'Writing partner', aiSafety: 'AI output is a proposal, never an automatic replacement.', mode: 'Task',
      modeDraft: 'Draft a chapter', modeContinue: 'Continue the chapter', modePolish: 'Polish selected text', modeSummary: 'Summarize this chapter', modeRevise: 'Rewrite this chapter to requirements',
      reviseHint: 'Rewrites only the current chapter, not the selected passage or the whole book. No selection needed. Starts two sequential, potentially paid model calls: analysis, then targeted rewriting. Preserve cast, canon and plot unless you explicitly request a change.',
      reviseRequirement: 'Enter a specific rewrite requirement before starting.', revisePlaceholder: 'For example: dialogue feels stiff and sparse — make it natural and add dialogue without changing the plot or character relationships.',
      analyzing: 'Analyzing your requirements… (step 1 of 2)', optimizing: 'Rewriting this chapter… (step 2 of 2)', revisionAnalysis: 'Analysis and rewrite plan',
      revisionPreview: 'Whole-chapter polish preview — unconfirmed changes have NOT been saved to the manuscript', revisionOpen: 'Open whole-chapter polish preview over editor', revisionOriginal: 'Show saved manuscript / edit', revisionOriginalHint: 'Ordinary manuscript editor. Pending changes are not saved; editing the source will invalidate this review after saving. Already accepted changes stay saved.',
      revisionDeferred: 'Whole-chapter polish is ready. Your manual edits remain visible; resolve unsaved edits, recovery and conflicts before opening the preview. Save all saves only manual edits — AI changes still need explicit confirmation — individually or with Approve all.', revisionLocalDraft: 'Showing your unsaved manual draft, not the AI preview. Save all saves these manual edits only; AI changes need explicit confirmation — individually or with Approve all. Saving source edits will invalidate the old proposal.', revisionHunk: 'Change {number} · {state}', revisionAcceptLabel: 'Accept and save change {number}', revisionRejectLabel: 'Reject change {number}',
      revisionCounts: '{pending} pending · {accepted} accepted and saved · {rejected} rejected', revisionAccept: 'Accept and save this change', revisionReject: 'Reject this change', revisionDeleted: '(deletion — no replacement text)', revisionBefore: 'Compare original text', revisionNoChanges: 'Analysis completed: no text changes were proposed. There is nothing to accept.',
      revisionInvalid: 'Invalid review data. Changes are disabled; refresh the saved version or generate a new proposal.', revisionImmutable: 'The original whole-chapter polish target is immutable. Review changes in the main editor; only explicitly approved changes are saved.',
      revisionRejectRemaining: 'Reject remaining changes (keep accepted changes)', revisionRejectHint: 'Reject all still-pending changes. Previously accepted and saved changes remain in the manuscript.', revisionDismissEmpty: 'Dismiss no-change proposal', revisionSaved: 'This change was accepted and saved.', revisionRejected: 'This change was rejected. The manuscript was not changed.',
      instruction: 'Your direction', instructionPlaceholder: 'What should happen, and what must stay unchanged?',
      generate: 'Generate', context: 'Preview context', contextTitle: 'Context report', contextNote: 'Approximate character budget, not a token count. Future chapter facts are excluded.',
      budgetUsed: '{used} / {budget} characters', included: 'Included', omitted: 'Omitted', warnings: 'Warnings', fullPrompt: 'Full prompt (reference data)',
      saveFirst: 'Save or discard your changes before generating or accepting a proposal.',
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
      cardCategory: 'Category', cardCategoryAll: 'All categories', cardCategoryNew: 'New category', cardCategoryName: 'Category name', cardCategoryByKind: 'Follow type: {kind}', cardCategoryEmpty: 'No cards in this category.', categoryReceipt: 'Could not verify that the category was saved.', categoryAdded: 'Category created.', cardContextKind: 'Context type',
      cardList: 'Canon card list', cardBack: 'Back to cards', cardOpenRange: 'Chapter {from} onward', cardKindStatus: '{kind} · {status}', cardPinnedShort: 'Pinned', cardPick: 'Edit {title}', cardChapterRange: 'How cards enter context', cardFrom: 'From chapter', cardThrough: 'Through chapter', cardNoEnd: 'No end',
      noCards: 'No canon cards yet. Add characters, rules, timelines or unresolved threads.', chooseCard: 'Choose a card to edit, or create one.', invalidScope: 'Chapter scope must use positive whole numbers, with the end at or after the start.',
      noHistory: 'No previous manuscript versions yet. Body changes create snapshots automatically.', historyHint: 'Up to 30 previous bodies are retained. Restoring creates a new revision; it never silently accepts an AI proposal.',
      restore: 'Restore this body', restoreTitle: 'Restore a previous body?', restoreHint: 'The current body will be saved to history before this snapshot becomes the manuscript.',
      unsavedTitle: 'Keep your changes?', unsavedHint: 'Some edits are still unsaved. Save them or discard only this unsaved tail. Content already autosaved will NOT be rolled back.', saveContinue: 'Save and continue', discardContinue: 'Discard and continue', stay: 'Stay here',
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
      requestFailed: 'Request failed', reviewCheckFailed: 'Review decision not submitted', networkError: 'Connection failed. A save may have completed; refresh the saved version before retrying.',
      generationFinished: 'Proposal ready for your review. Nothing has changed in the manuscript.',
      localOnly: 'Local edits have not been saved to the server.', discard: 'Discard unsaved edits', confirmDiscard: 'Discard only the unsaved edits?',
      confirmChanged: 'The reviewed content is no longer current. Review the latest content, then confirm again.',
      dismiss: 'Dismiss', empty: '(empty)', selectionChanged: 'The selected source changed. Select the passage again.',
    };
    const zh = {
      chapterOutline: '本章计划', outlineSaved: '章级细纲已保存。', outlineHint: '起草本章时会完整、严格地采用已保存的细纲。细纲是创作计划，不是已发生的事实。', outlineAI: 'AI 生成细纲', outlineInstruction: '对细纲的补充要求（可选）', outlineGenerating: '正在生成章级细纲…', outlineGenerated: '细纲候选可供审阅。', outlineCandidate: 'AI 细纲候选', outlineCandidateStale: '生成后本章已有更改，请重新生成细纲后再采纳。', outlineReviewReplace: '用此候选替换已保存的章级细纲？', outlineReviewHint: '仅替换本章细纲，不会修改正文。', outlineUse: '采纳细纲', outlineReject: '拒绝细纲候选', outlineRejected: '已拒绝细纲候选。', outlineRefresh: '刷新已保存的细纲和候选', outlineRefreshNeeded: '上一次变更可能已保存，请刷新核对后再试。', outlineMissing: '目标章节已不可用，细纲不能应用到其他章节。', outlineBackWriting: '返回正文', outlineBackManagement: '返回章节管理',
      findText: '在当前页查找', findPrevious: '上一处（Shift+Enter）', findNext: '下一处（Enter）', findClose: '关闭查找（Esc）', findCount: '{current} / {total}', findNoResults: '无匹配', findNoChapterBody: '请回到正文编辑区查找本章文本。', findLimited: '{current} / {total}（已达查找上限）', findHint: '查找当前页面的文本，正文页仅查找当前章节。',
      autosaveHint: '手动编辑停笔约 1 秒后自动保存。不完整字段保留在本地；AI 提案及模型偏好仍需明确操作。', autosaveShort: '自动保存 · 手动稿', saveNow: '立即保存', autosaveRetry: '重试保存', autosavePaused: '自动保存已暂停，本地编辑仍保留。请点「重试保存」核对已保存版本后继续。', autosaveReceipt: '保存回执与本次编辑不匹配，本地编辑仍保留。请核对已保存版本后重试。', autosaveIncomplete: '部分手动字段尚未完整或有效，仍保留在本地。请补全后再保存或继续。',
      constraints: '写作约束', constraintsHint: '本书所有模型调用都会参考的条件：可管理环境、对话、神态、表达，以及任何自定义小说要素。下方示例仅为占位提示。',
      constraintsTextEditor: 'Markdown 编辑器', constraintsShowSource: '显示 Markdown 语法', constraintsHideSource: '隐藏 Markdown 语法', constraintsWriteRules: '编写规则', constraintsAddRule: '添加规则', constraintsCurrentActions: '当前规则操作', constraintsPlaceCaret: '将光标放在规则内即可操作',
      constraintsContinuousHint: '直接在文档中输入。Markdown 格式原地呈现，移动光标到文字中即可编辑语法。Tab 缩进，Shift+Tab 减少缩进；先按 Esc 再按 Tab 可离开编辑器。',
      constraintsLiteralHint: '在同一个编辑器中显示全部语法。关闭后恢复原地排版；先按 Esc 再按 Tab 可离开编辑器。',
      constraintsDraftHint: '用顶层列表项写类别，下方每条规则用四个空格和列表标记开始；也可用 # 或 ## 标题加规则列表。[x] 表示启用，[ ] 表示停用。在类别末尾按 Enter，插入缩进后的「- [x] - 」。在「- [x] -」或「- [ ] -」规则里按 Enter，以相同缩进开始一条默认启用的新规则。空前缀不保存；规则内 Shift+Enter 只增加续行。有效内容会自动保存，未完成的 Markdown 保留在本地并阻止生成。删除最后一条规则须用删除按钮确认。',
      constraintsHelp: 'Markdown 格式与保存说明',
      constraintsGuideExample: '- 环境\n    - [x] 优先写视角人物会注意到的事物。\n    - [ ] - 每段都交代天气。',
      constraintsRuleStarter: '请补写新规则的正文；空条目暂不保存。',
      constraintsGuideInnerList: '省略方括号时，规则默认启用。缩进行的第一个短横线用来开始一条规则；方括号后的第二个短横线是规则正文里的可选项目符号，不会单独启停。',
      constraintsMarkdownTooLong: 'Markdown 原文超过本地恢复稿 2000000 个 UTF-16 单位的上限。此次输入未应用，也未截断；请缩短或拆分粘贴内容。',
      constraintsMarkdownInvalid: 'Markdown 尚未完成或格式无效：每个类别下须有非空子规则；类别最多 80、规则最多 4000 个 UTF-16 单位，最多 64 条。原文已保留在本地恢复稿，约束暂不保存。', constraintsMarkdownEmpty: '文档已清空，但仍有已保存或草稿规则。请撤销清空或恢复至少一条有效规则，再用删除按钮逐条确认删除。', constraintsPlaceholder: '- 环境\n    - 随人物感知展开。优先写人物此刻会注意到的事物。', constraintsDeleteTitle: '删除这条写作约束？', constraintsDeleteHint: '仅删除这条规则；保存后，它将不再应用于新任务。', constraintsAddCategory: '添加类别', newConstraintCategory: '新类别', newConstraint: '新写作约束',
      constraintsModelHint: '启用的约束在固定硬性上下文预算内完整注入，停用的约束不应用；超出预算会报错，不会静默截断。每个任务使用启动时快照，保存修改只影响下一次任务。模型不保证语义上完全遵守，请用「预览上下文」查看报告与提示词。',
      constraintsCount: '{total} / 64 条 · 启用 {enabled} 条 · 停用 {disabled} 条', constraintsEmpty: '尚无写作约束。仅添加你希望本书使用的条件。', constraintsAdd: '添加约束', constraintsCategory: '类别（可自由输入）', constraintsContent: '约束内容', constraintsEnabled: '启用', constraintsRemove: '删除约束', constraintsRemoveNamed: '删除第 {position} 条“{rule}”', constraintsUp: '上移', constraintsDown: '下移', constraintsCategoryPlaceholder: '环境、对话、神态，或自定义类别', constraintsContentPlaceholder: '仅示例：通过视角人物的感官描写环境。', constraintsCategories: '环境|对话|神态|表达|动作|心理|外貌|情节|节奏|视角|文风',
      constraintsLimit: '每本书最多 64 条写作约束。', constraintsCrypto: '当前浏览器无法安全生成 UUID，请使用支持 crypto.randomUUID 的浏览器；尚未添加约束。', constraintsInvalid: '每条约束需包含类别（1–80 个 UTF-16 单位）、内容（1–4000 个 UTF-16 单位）、唯一 UUID 和启用状态。请补全或删除空白行后保存；停用的约束也需有效文字。',
      writingControls: '写作工具栏', collapseControls: '专注写作', expandControls: '显示工具栏',
      chaptersToggle: '章节列表', editChapterTitle: '改标题', closeTitleEditor: '关闭标题编辑', workspaceTools: '作品工具', bookTools: '作品 / 章节工具与导出', previousResult: '当前显示的是此前已保存的结果，并非本次生成输出。', results: '生成结果', advanced: '模型 / 上下文 / 详情', insertionContext: '原文上下文（此处插入，未替换原文）', insertionSpot: '│ 此处插入 │', sourceAnchor: '原文上下文 · 从文末续写', legacyDraft: '已恢复旧版结果编辑，请明确处理后再生成或审阅', discardResultEdits: '放弃结果编辑', newTextLabel: '新文字（尚未保存）', approveAll: '一键批准', approveAllHint: '批准当前可见结果的所有待审阅修改；已拒绝的修改保持原文。', summarySaved: '当前已保存摘要（非生成时的原始摘要快照）', summaryOnly: '仅更新摘要，不改正文', noSummary: '尚无已保存摘要',
      workspacePages: '作品与生成页面', contextPageHint: '预览当前章节和写作任务使用的最新已保存参考资料，不调用模型。', contextStageOne: '按需重写本章：这里显示第一阶段（分析需求）的提示词；第二阶段还会带上模型返回的分析，生成前无法预览。', refreshPreview: '刷新预览', generatedContext: '这条结果生成时使用的上下文', openBackupTools: '前往作品工具备份', operationDetails: '生成详情', noGenerationDetails: '当前选择下没有生成结果或任务详情。',
      nav: '灵感', pages: '工作区页面', savedTabsDirty: '{page} · 有未保存的更改',
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
      chapterManagement: '章节管理', openChapter: '打开', renameChapter: '改名', chapterUp: '上移', chapterDown: '下移', deleteChapter: '删除章节', chapterAction: '第 {number} 章「{title}」：{action}', chapterCurrent: '当前章节', chapterCountDetails: '{history} 条历史 · {proposals} 条 AI 提案', chapterStructureHint: '排序或删除会保持设定卡对剩余章节的覆盖。若某张卡需拆成两段，或删除的是它唯一覆盖的章，请先调整该卡范围。', chapterStructureBusy: '本作品还有任务未结束，暂不能排序或删除章节。', chapterDeleteWarning: '永久删除本章正文、摘要、版本历史和 AI 提案。建议先导出 JSON 备份。已有备份、归档任务记录和模型会话日志不会随之删除。', chapterDeleteType: '输入完全一致的已保存章名', chapterDeleteMultiline: '请先将本章改为单行标题，再删除。', chapterAdded: '已新增章节。', chapterRenamed: '已修改章节名称。', chapterMoved: '章节顺序已保存。', chapterDeleted: '已删除章节。', chapterWriteUncertain: '章节变更可能已保存。请先刷新已保存版本，对照章节列表后再试。', chapterMissingDraft: '草稿所属章节已不存在。请先下载本地改动，再决定是否放弃；不能自动应用到其他章节。',
      manageBooks: '作品管理', manageBookHint: '重命名或永久删除当前所选作品。', savedBookTitle: '完整的已保存名称', bookIdentity: '作品编号：{id} · 修订 {revision}', bookOption: '{title} · {count} 章 · {id}',
      renameBook: '重命名作品', renameTitle: '新的作品名称', renamed: '作品已重命名。', manageUnsaved: '请先明确处理全部未保存编辑和版本冲突，再管理作品。', manageStale: '作品版本已变化，请刷新已保存版本后重新核对。', manageRecovery: '请先恢复并保存本地恢复稿，或明确丢弃恢复稿，再管理作品。',
      deleteBook: '永久删除作品', deleteWarning: '此操作不可撤销。将永久删除本作品及其全部章节、设定卡、提案、版本历史和本插件的任务记录。DSH 模型会话日志单独保留，不会随之删除。',
      deleteBackup: '删除前建议先导出 JSON 备份并妥善保存。备份仅包含已保存数据。', deleteTypeTitle: '请输入完整的已保存名称以确认', deleteBusy: '作品仍有生成中或尚未收尾的任务，暂不能删除。请等待完成，或取消任务并等待取消收尾。',
      deleteUnconfirmed: '服务端没有返回与当前作品匹配的删除确认。本地数据保持不变；请关闭此窗口并刷新作品列表后再检查。',
      deleteUncertain: '暂时无法确认删除结果，本地数据保持不变；服务端可能已经删除作品。请刷新已保存版本核实，不要直接重复删除。',
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
      manuscript: '正文', editorHint: '直接写作，或精确选中一段文字进行润色。请先保存，再交给 AI。',
      draft: '草稿', final: '定稿', chapterStatus: '章节状态', chars: '{count} 字符', revision: '修订 {number}',
      selected: '已选 {count} 字符 · 位置 {start}–{end}', noSelection: '在正文中选中文字，即可精确润色。',
      summary: '章节摘要',
      maintenance: '档案维护', prune: '清理已处理候选及旧历史', pruneTitle: '永久清理旧档案？', pruneHint: '建议先导出 JSON 备份。将删除已接受、已拒绝的提案；各章历史仅保留最近 5 份。待审阅提案和当前正文保留。此操作不可撤销。',
      ai: '写作搭档', aiSafety: 'AI 输出只形成提案，不会自动替换正文。', mode: '写作任务',
      modeDraft: '起草本章', modeContinue: '续写本章', modePolish: '精确润色选区', modeSummary: '提炼本章摘要', modeRevise: '按需重写本章',
      reviseHint: '只重写当前章节，不是当前选区，也不是全书，无需选中文字。将顺序发起两次可能计费的模型调用：先分析作者要求，再针对性重写；除非明确要求，保持人物、设定和情节不变。',
      reviseRequirement: '请先填写具体的重写要求。', revisePlaceholder: '例如：对话太过生硬且偏少，请让对话更自然、增加有效对话，但保留情节与人物关系。',
      analyzing: '正在分析作者要求…（第 1 / 2 步）', optimizing: '正在按需重写本章…（第 2 / 2 步）', revisionAnalysis: '分析与重写计划',
      revisionPreview: '全文润色预览，未确认改动尚未写入原稿', revisionOpen: '在主编辑器打开全文润色预览', revisionOriginal: '查看已保存正文 / 编辑', revisionOriginalHint: '当前为普通正文编辑器。待确认改动尚未保存；编辑并保存来源后，此审阅将过期。已采纳的修改仍保留在原稿中。',
      revisionDeferred: '全文润色已就绪，你的手动编辑保持显示。请先处理未保存编辑、恢复稿和冲突，再打开全文润色预览。「保存全部」只保存手动编辑，AI 改动仍须明确确认（逐处确认或一键批准）。', revisionLocalDraft: '当前显示你的未保存手动草稿，不是 AI 全文润色预览。「保存全部」只保存这些手动编辑，AI 改动仍须明确确认（逐处确认或一键批准）；保存来源编辑后，旧提案将过期。', revisionHunk: '第 {number} 处修改 · {state}', revisionAcceptLabel: '采纳并保存第 {number} 处修改', revisionRejectLabel: '拒绝第 {number} 处修改',
      revisionCounts: '待确认 {pending} 处 · 已采纳并保存 {accepted} 处 · 已拒绝 {rejected} 处', revisionAccept: '采纳并保存此处修改', revisionReject: '拒绝此处修改', revisionDeleted: '（删除此处，无替换文字）', revisionBefore: '对照原始文字', revisionNoChanges: '分析已完成：本次没有提出正文改动，无需采纳。',
      revisionInvalid: '审阅数据无效，已禁止应用修改。请刷新已保存版本，或重新生成提案。', revisionImmutable: '最初生成的完整全文润色目标不可编辑。请在主编辑器逐处审阅，只有明确采纳的修改才会保存。',
      revisionRejectRemaining: '拒绝剩余修改（保留已采纳内容）', revisionRejectHint: '拒绝全部仍待确认的修改。此前已采纳并保存的修改会保留在原稿中。', revisionDismissEmpty: '收起无改动提案', revisionSaved: '此处修改已采纳并保存。', revisionRejected: '此处修改已拒绝，正文没有改变。',
      instruction: '要求', instructionPlaceholder: '这一段要发生什么？哪些内容必须保持不变？',
      generate: '生成', context: '预览上下文', contextTitle: '上下文报告', contextNote: '按字符粗略预算，不是 token 数。不会混入未来章节事实。',
      budgetUsed: '{used} / {budget} 字符', included: '已包含', omitted: '已省略', warnings: '提醒', fullPrompt: '完整提示词（参考资料）',
      saveFirst: '请先保存或放弃当前更改，再生成或接受提案。',
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
      cardCategory: '分类', cardCategoryAll: '全部分类', cardCategoryNew: '新建分类', cardCategoryName: '分类名称', cardCategoryByKind: '按类型：{kind}', cardCategoryEmpty: '该分类暂无设定卡。', categoryReceipt: '无法确认分类是否已保存。', categoryAdded: '分类已创建。', cardContextKind: '上下文类型',
      cardList: '设定卡列表', cardBack: '返回设定卡列表', cardOpenRange: '第 {from} 章起', cardKindStatus: '{kind} · {status}', cardPinnedShort: '置顶', cardPick: '编辑「{title}」', cardChapterRange: '设定卡如何进入上下文', cardFrom: '起始章', cardThrough: '结束章', cardNoEnd: '不限',
      noCards: '还没有设定卡。可以记录人物、规则、时间线和未解伏笔。', chooseCard: '选择卡片进行编辑，或新建一张。', invalidScope: '章节范围须为正整数，结束章节不能早于起始章节。',
      noHistory: '暂无旧版正文。每次正文改变都会自动保留快照。', historyHint: '最多保留 30 份旧版正文。恢复会形成新修订，不会静默接受 AI 提案。',
      restore: '恢复此版正文', restoreTitle: '恢复一份旧版正文？', restoreHint: '当前正文会先存入历史，再用此快照替换。',
      unsavedTitle: '保留当前更改？', unsavedHint: '仍有待保存修改。可先保存再继续，或仅放弃这些待保存更改；已自动保存的内容不会回滚。', saveContinue: '保存并继续', discardContinue: '放弃并继续', stay: '留在此处',
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
      requestFailed: '请求失败', reviewCheckFailed: '未提交审阅决定', networkError: '连接失败，保存可能已完成；重试前请刷新已保存版本。',
      generationFinished: '提案已生成，等待你审阅；正文没有改变。',
      localOnly: '本地编辑尚未保存到服务端。', discard: '放弃待保存更改', confirmDiscard: '仅放弃这些待保存更改？',
      confirmChanged: '当前建议或其对应的版本已变化。请查看最新内容，重新审阅后再确认。',
      dismiss: '收起', empty: '（空）', selectionChanged: '选区来源已变化，请重新选择片段。',
    };

    function workspaceTabDirty(w) {
      if (!w) return { settings: false, constraints: false };
      const settings = w.settings || {}, baseSettings = w.baseSettings || {};
      const settingsKeys = new Set([...Object.keys(settings), ...Object.keys(baseSettings)]);
      settingsKeys.delete('writingConstraints');
      return {
        settings: [...settingsKeys].some(key => !equal(settings[key], baseSettings[key])),
        constraints: constraintsEditorDirty(w) || !equal(settings.writingConstraints, baseSettings.writingConstraints),
      };
    }

    const toolbarIcons = Object.freeze({
      outline: 'M6 5h12M6 10h12M6 15h8M6 20h5',
      find: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13M15 15l5 5',
      writing: 'M4 20h16M5 16l1-4L16 2l4 4-10 10-5 1zM14 4l4 4',
      constraints: 'M8 4h12M8 12h12M8 20h12M4 4h.01M4 12h.01M4 20h.01',
      cards: 'M6 7V4h14v13h-3M3 7h14v13H3zM6 11h8m-8 4h5',
      settings: 'M4 6h16m-16 6h16m-16 6h16M8 4v4m8 2v4m-6 2v4',
      history: 'M4 11a8 8 0 1 1 2 6M4 5v6h6m2-3v4l3 2',
      tools: 'M3 6h7l2 2h9v12H3zM8 14h8',
      manage: 'M4 4h12v16H4zM7 8h6M7 12h6M19 8v10m-2-2 2 2 2-2',
      refresh: 'M20 10a8 8 0 0 0-13-5L4 8m0-5v5h5m-5 6a8 8 0 0 0 13 5l3-3m0 5v-5h-5',
      title: 'M4 7V4h16v3M12 4v16m-4 0h8',
      generate: 'M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6L12 2z',
      context: 'M2 12c3-4 6-6 10-6s7 2 10 6c-3 4-6 6-10 6s-7-2-10-6zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
      advanced: 'M5 3h14v18H5zM8 8h8m-8 4h8m-8 4h5',
      focus: 'M8 4H4v4m12-4h4v4m0 8v4h-4M4 16v4h4',
      expand: 'M4 5h16v14H4zM4 9h16m-8 3v4m-2-2h4',
      approve: 'M4 12l4 4 8-8m-5 8 2 2 8-8',
      cancel: 'M6 6h12v12H6z',
      save: 'M4 4h13l3 3v13H4zM8 4v5h8V4m-8 16v-6h8v6',
      discard: 'M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 10v6m4-6v6',
      download: 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4',
    });

    const CSS = `
.mx-root{position:relative;--mx-ui-size:14px;--mx-field-size:13px;--mx-meta-size:12px;--mx-content-size:16px;--mx-section-size:17px;--mx-subhead-size:14px;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;overflow:hidden;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--mx-ui-size);line-height:1.55;container-type:inline-size}
.mx-content-pane{flex:1;min-height:0;min-width:0;overflow:auto;padding:8px clamp(10px,1.6vw,22px) 12px}.mx-content-pane> .mx-book-workspace{gap:6px}
.mx-root *, .mx-root *::before, .mx-root *::after{box-sizing:border-box}
.mx-find-anchor{position:relative;flex:none;height:0;z-index:110}.mx-find-bar{-webkit-app-region:no-drag;position:absolute;inset-block-start:5px;inset-inline-end:8px;max-width:calc(100% - 16px);width:fit-content;display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 3px 14px color-mix(in srgb,var(--dsw-alias-label-primary) 15%,transparent)}.mx-root .mx-find-input{width:clamp(5rem,24vw,16rem);min-width:2rem;flex:1 1 7rem;padding:4px 7px;height:30px}.mx-find-count{font-size:var(--mx-meta-size);color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 3px}.mx-root .mx-find-button{display:inline-grid;place-items:center;padding:0 5px;min-width:28px;min-height:28px;line-height:1}.mx-find-marks{position:absolute;inset:0;overflow:hidden;z-index:12;pointer-events:none}.mx-find-mark{position:absolute;pointer-events:none;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 26%,transparent);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-warn-primary);border-radius:2px}
.mx-root .mx-outline-entry{padding:3px 8px;min-height:27px;font-size:var(--mx-meta-size)}.mx-outline-editor{min-height:12rem}.mx-root .mx-outline-preview{font-size:var(--mx-field-size);max-height:30rem}.mx-root h2,.mx-root h3,.mx-root p{margin:0}.mx-root h2{font-size:var(--mx-section-size)}.mx-root h3{font-size:var(--mx-subhead-size)}
.mx-chapter-add-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px}.mx-root .mx-chapter-add-row>.mx-field>input:not([type=checkbox]),.mx-root .mx-chapter-add-row>button{height:40px;min-height:40px}.mx-chapter-add-row>button{white-space:nowrap}
.mx-row,.mx-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.mx-stack{display:flex;flex-direction:column;gap:14px;min-width:0}.mx-row-between{justify-content:space-between}.mx-grow{flex:1;min-width:150px}
.mx-root button,.mx-root input,.mx-root textarea,.mx-root select{font:inherit;color:var(--dsw-alias-label-primary)}
.mx-root button{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);padding:7px 12px;cursor:pointer;min-height:34px;line-height:1.35}.mx-root button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.mx-root button:disabled{opacity:.5;cursor:not-allowed}.mx-root .mx-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}.mx-root .mx-danger{color:var(--dsw-alias-state-error-primary)}
.mx-root :is(button,input,textarea,select,summary,a):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.mx-root input:not([type=checkbox]),.mx-root textarea,.mx-root select{width:100%;max-width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:7px;padding:9px 10px;min-height:38px}.mx-root textarea{resize:vertical;line-height:1.7}.mx-root input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px}
.mx-model-row{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}.mx-model-row>.mx-field{flex:1 1 130px}.mx-root .mx-model-row select,.mx-root .mx-model-row>button{height:40px;min-height:40px}.mx-model-row>button{flex-shrink:0}.mx-model-picker{width:100%}
.mx-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:var(--mx-field-size)}.mx-field>span:first-child{font-weight:550}.mx-hint{color:var(--dsw-alias-label-secondary);font-size:var(--mx-meta-size);line-height:1.6;overflow-wrap:anywhere}
.mx-panel{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px;min-width:0}.mx-subpanel{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;min-width:0}.mx-empty{padding:40px 22px;max-width:760px;margin:0 auto}
.mx-toolbar{padding:12px 0}.mx-root button[aria-pressed=true]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.mx-grid{display:grid;grid-template-columns:minmax(0,1fr);align-items:stretch;min-height:0}.mx-writing-column{min-width:0;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px}.mx-editor{min-height:0;font-size:var(--mx-content-size);line-height:1.9!important;tab-size:2}.mx-writing-partner{position:static;flex:0 0 auto;max-height:42%;overflow:auto;min-width:0;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1);padding:4px 3px 6px}.mx-partner-row{display:grid;grid-template-columns:minmax(9rem,.65fr) minmax(11rem,2fr);gap:5px 8px;align-items:end}.mx-partner-row>.mx-field{gap:2px}.mx-root .mx-partner-row :is(select,textarea){min-height:36px;padding:5px 8px}.mx-root .mx-partner-row textarea{height:36px;max-height:8rem;line-height:1.5}.mx-partner-meta{display:flex;align-items:center;gap:4px 8px;flex-wrap:wrap;margin-top:4px;padding-block:2px}.mx-partner-model{flex:0 1 auto;max-width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mx-result-chooser{display:flex;align-items:center;gap:6px;max-width:min(100%,22rem);min-width:0}.mx-result-chooser select{min-width:0}.mx-root .mx-result-chooser select{min-height:28px;padding:3px 6px;width:auto;max-width:min(16rem,100%);font-size:var(--mx-meta-size);text-overflow:ellipsis}.mx-legacy-recovery{border-inline-start:2px solid var(--dsw-alias-state-warn-primary);padding-inline-start:10px}
.mx-status{display:inline-flex;align-items:center;gap:6px;font-size:var(--mx-meta-size);color:var(--dsw-alias-label-secondary)}.mx-status[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}.mx-status[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.mx-banner{border:1px solid var(--dsw-alias-border-l2);border-inline-start:3px solid var(--dsw-alias-state-warn-primary);padding:12px 14px;border-radius:8px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-1);overflow-wrap:anywhere}.mx-banner.mx-error{border-inline-start-color:var(--dsw-alias-state-error-primary)}.mx-toast-layer{position:absolute;inset-inline:0;inset-block-end:16px;display:flex;justify-content:center;padding-inline:12px;z-index:80;pointer-events:none}.mx-toast{min-width:0;max-width:min(100%,38rem);box-sizing:border-box;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 3px 12px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);font-size:var(--mx-field-size);overflow-wrap:anywhere;pointer-events:none;user-select:none}.mx-toast[data-error=true]{border-color:var(--dsw-alias-state-error-primary)}.mx-text-error{color:var(--dsw-alias-state-error-primary)}.mx-toast-text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.mx-badge{display:inline-block;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}.mx-nav{display:flex;gap:6px;overflow:auto;padding:2px 0 10px;margin-bottom:6px}.mx-nav button{flex-shrink:0;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-root details>summary{cursor:pointer;font-size:var(--mx-field-size);padding:6px 0}.mx-root details[open]>summary{margin-bottom:9px}.mx-root pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:var(--mx-meta-size);line-height:1.65;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:10px}.mx-root ul{padding-inline-start:20px;margin:4px 0}.mx-root li{overflow-wrap:anywhere}
.mx-compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.mx-cards-page{min-width:0}.mx-cards{min-width:0}.mx-cards[data-editing=true]{display:grid;grid-template-columns:minmax(14rem,1fr) minmax(0,2.25fr);gap:12px;align-items:start}.mx-card-list,.mx-card-editor{min-width:0}.mx-root .mx-card-list{margin:0;padding:0;list-style:none}.mx-cards[data-editing=true] .mx-card-list{max-height:68vh;overflow:auto}.mx-card-item+.mx-card-item{border-block-start:1px solid var(--dsw-alias-border-l1)}.mx-root .mx-card-pick{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px 10px;text-align:start;width:100%;border:1px solid transparent;background:transparent;padding:5px 8px;min-height:36px}.mx-root .mx-card-pick[aria-current=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}.mx-card-name,.mx-card-excerpt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mx-card-excerpt{font-size:var(--mx-field-size);color:var(--dsw-alias-label-secondary);grid-column:1/-1}.mx-card-labels{font-size:var(--mx-meta-size);color:var(--dsw-alias-label-secondary);max-width:24ch;overflow-wrap:anywhere}.mx-card-editor{display:flex;flex-direction:column;gap:8px;padding:10px}.mx-card-editor .mx-field{gap:2px}.mx-card-editor-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px}.mx-card-editor-head h3{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mx-card-meta-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,2fr);gap:7px;align-items:end}.mx-root .mx-card-editor :is(input:not([type=checkbox]),select,button){min-height:30px}.mx-root .mx-card-editor :is(input:not([type=checkbox]),select){padding:4px 7px}.mx-root .mx-card-editor .mx-card-body{min-height:clamp(11rem,36vh,24rem);resize:vertical}.mx-card-editor>.mx-actions{justify-content:space-between}.mx-card-browser{min-width:0}.mx-card-filter{margin-bottom:6px}.mx-root .mx-card-filter:only-child{margin-bottom:0}.mx-card-category-form{display:flex;flex-wrap:wrap;align-items:end;gap:6px}.mx-card-category-form .mx-field{flex:1 1 10rem}.mx-card-category-form .mx-actions{margin-inline-start:auto}.mx-card-category-error{width:100%;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary)}.mx-card-type-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
.mx-check{display:flex;align-items:center;gap:8px}.mx-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.mx-revision-preview{min-height:0;font-size:var(--mx-content-size);line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;background:var(--dsw-alias-bg-base);padding:10px 0}.mx-revision-hunk{display:block;position:relative;border:0;border-radius:0;margin:0;padding:0;white-space:normal;background:transparent}.mx-revision-text{white-space:pre-wrap;overflow-wrap:anywhere}.mx-diff-new,.mx-polish-new{border-inline-start:2px solid var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);padding:0 72px 0 10px;min-height:1.9em}.mx-diff-old,.mx-polish-original{border-inline-start:2px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);padding:0 10px;color:var(--dsw-alias-label-secondary)}.mx-change-actions{position:absolute;inset-block-start:0;inset-inline-end:3px;gap:3px}.mx-revision-hunk>.mx-stack:has(.mx-decision){position:absolute;inset-block-start:0;inset-inline-end:3px;gap:2px}.mx-original-context{padding:0 10px;border-inline-start:2px solid var(--dsw-alias-border-l2);font-size:var(--mx-field-size);color:var(--dsw-alias-label-secondary)}.mx-insertion-spot{background:transparent;color:var(--dsw-alias-brand-primary);font-size:var(--mx-meta-size)}.mx-revision-analysis{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--mx-field-size)}
.mx-root .mx-decision{display:inline-flex;align-items:center;justify-content:center;flex:0 0 32px;width:32px;height:32px;min-height:32px;padding:0;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;line-height:1}.mx-root .mx-decision svg{display:block;flex:none;pointer-events:none}.mx-root .mx-decision-accept{color:var(--dsw-alias-state-success-primary)}.mx-root .mx-decision-reject{color:var(--dsw-alias-state-error-primary)}.mx-root .mx-constraint-done{color:var(--dsw-alias-brand-primary)}.mx-root .mx-decision-accept:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}.mx-root .mx-decision-reject:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 50%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}.mx-root .mx-constraint-done:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}.mx-root .mx-decision:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mx-selection-popup{position:fixed;inset:auto;margin:0;z-index:900;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 6px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);overflow:auto}.mx-selection-popup .mx-actions{gap:6px}.mx-selection-popup .mx-actions>button{flex:0 1 auto}.mx-selection-popup:popover-open{display:flex}.mx-selection-popup:not(:popover-open){display:none}.mx-job-terminal{max-width:min(100%,55ch);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mx-job-terminal[role=alert]{color:var(--dsw-alias-state-error-primary)}.mx-job-poll button{font-size:var(--mx-meta-size);min-height:28px;padding:3px 7px}.mx-review-notice{font-size:var(--mx-meta-size);gap:6px}.mx-review-notice strong{font-weight:500}.mx-revision-hunk[data-state=rejected]>.mx-diff-new{background:transparent;border-inline-start-color:var(--dsw-alias-border-l2)}.mx-summary-preview{flex:0 0 auto;min-height:0;max-height:12rem;overflow:auto;padding:0}.mx-polish-preview{min-height:0}.mx-polish-block h3{font-size:var(--mx-meta-size);color:var(--dsw-alias-label-secondary);margin:0}.mx-polish-new{border-radius:0}.mx-polish-original{margin:0;padding-block:0;border-top:0}
.mx-modal-shell{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 85%,transparent)}.mx-modal{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:24px;width:560px;max-width:100%;max-height:90vh;overflow:auto}.mx-modal .mx-actions{justify-content:flex-end;margin-top:20px}.mx-foot{margin-top:24px;padding:16px 0;border-top:1px solid var(--dsw-alias-border-l1)}
@container(max-width:760px){.mx-cards[data-editing=true]{display:block}.mx-cards[data-editing=true] .mx-card-browser,.mx-cards-page[data-editing=true] .mx-card-new{display:none}}
@container(max-width:440px){.mx-card-meta-fields>.mx-field:last-child,.mx-card-type-fields>.mx-field:first-child{grid-column:1/-1}.mx-card-type-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.mx-card-meta-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.mx-root .mx-card-pick{grid-template-columns:minmax(0,1fr)}.mx-card-labels{grid-row:3}}
@container(max-width:520px){.mx-model-row>.mx-field,.mx-model-row>button{flex-basis:100%;width:100%}.mx-compare,.mx-form-grid{grid-template-columns:minmax(0,1fr)}.mx-panel{padding:12px}.mx-actions>button{flex-grow:1}}
.mx-root-writing .mx-content-pane{display:flex;flex-direction:column;gap:5px}.mx-root-writing .mx-content-pane>.mx-banner{flex:none;max-height:18%;overflow:auto;margin:0;padding:6px 10px}.mx-root-writing .mx-book-workspace{flex:1 0 26rem;min-height:26rem;overflow:hidden;gap:4px}.mx-root-writing .mx-writing-host{display:flex;flex:1;min-height:0;overflow:hidden}.mx-root-writing .mx-grid{flex:1;min-width:0;min-height:0;overflow:hidden}.mx-editor-panel{flex:1 0 20rem;min-height:20rem;overflow:auto;gap:8px;padding:12px}.mx-editor-panel> :not(.mx-body-slot){flex:none}.mx-body-slot{display:flex;flex-direction:column;flex:1 0 16rem;min-height:16rem;overflow:hidden}.mx-body-slot>.mx-field{flex:1;min-height:0}.mx-body-slot .mx-editor{flex:1;min-height:0;height:0;resize:none}.mx-body-slot>.mx-revision-preview,.mx-body-slot>.mx-stack{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.mx-legacy-recovery{flex:none;max-height:25%;overflow:auto}
@media(max-height:640px){.mx-root-writing .mx-content-pane{display:block}.mx-root-writing .mx-book-workspace,.mx-root-writing .mx-writing-host,.mx-root-writing .mx-grid,.mx-root-writing .mx-writing-column{overflow:visible}.mx-root-writing .mx-writing-host{min-height:24rem}.mx-writing-partner{max-height:none}}
@media(max-width:600px){.mx-modal-shell{padding:16px}}
.mx-constraints-document{min-width:0}.mx-constraints-editor-host{min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-base)}.mx-constraints-editor-host:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.mx-constraints-editor-host[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}.mx-constraints-editor-host .cm-content{min-height:20rem}.mx-constraints-editor-host .cm-scroller{max-height:clamp(20rem,65vh,48rem)}.mx-constraints-status{gap:6px;flex-wrap:wrap}.mx-constraints-current{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(100%,26ch)}.mx-constraints-actions{min-width:0}.mx-constraints-error{color:var(--dsw-alias-state-error-primary);font-weight:550}
.mx-root .mx-constraint-guide-example{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:var(--mx-ui-size);tab-size:4}
.mx-root [hidden]{display:none!important}.mx-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.mx-topbar{flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;min-height:42px;max-height:45%;overflow:auto;padding:5px 10px 5px max(10px,var(--dsh-frame-leading-clearance,0px));border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.mx-topbar-group{display:flex;align-items:center;flex-wrap:wrap;gap:3px;min-width:0;max-width:100%}.mx-topbar-group+.mx-topbar-group{border-inline-start:1px solid var(--dsw-alias-border-l1);padding-inline-start:7px}.mx-topbar .mx-field{gap:0;flex:0 1 13rem;min-width:0}.mx-topbar-book{flex:1 1 13rem;max-width:24rem}.mx-topbar-chapter{flex:1 1 11rem;max-width:27rem}
.mx-root .mx-topbar select{min-height:32px;text-overflow:ellipsis;padding:4px 6px;font-size:var(--mx-ui-size)}.mx-topbar-book>.mx-field,.mx-topbar-chapter>.mx-field{flex:1 1 7rem;min-width:0}.mx-topbar-actions{flex:0 1 auto}.mx-topbar-feedback{flex:0 1 auto;flex-wrap:nowrap}.mx-topbar-feedback>.mx-job-terminal{min-width:0}
.mx-toolbar-hit{display:inline-flex;position:relative;flex:none}.mx-root .mx-toolbar-button{display:inline-flex;align-items:center;justify-content:center;position:relative;width:32px;height:32px;min-height:32px;padding:0;border:1px solid transparent;background:transparent}.mx-toolbar-button svg,.mx-toolbar-hit>button:disabled{pointer-events:none}.mx-root .mx-toolbar-button:focus-visible{outline-offset:-2px}.mx-root .mx-toolbar-button.mx-primary{border-color:var(--dsw-alias-brand-primary)}.mx-toolbar-dot{position:absolute;inset-inline-end:3px;inset-block-start:3px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);pointer-events:none}
.mx-utility-page{min-width:0}.mx-chapter-list{list-style:none;margin:0;padding:0}.mx-chapter-list li{padding:8px 0;border-block-end:1px solid var(--dsw-alias-border-l1);min-width:0}.mx-chapter-list li strong{overflow-wrap:anywhere}.mx-chapter-list li .mx-actions{justify-content:flex-start}.mx-utility-page h2:focus{outline-offset:3px}.mx-utility-page pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.mx-book-page-links{display:flex;flex:0 0 auto;gap:3px}.mx-utility-page .mx-subpanel{min-width:0}
.mx-chapter-bar{display:flex;align-items:center;flex-wrap:wrap;gap:5px 8px;min-width:0}.mx-chapter-meta{display:flex;align-items:center;flex:none;flex-wrap:wrap;gap:4px}.mx-editor-panel{gap:6px;padding:9px}.mx-root .mx-editor-panel .mx-editor{padding:9px 10px}.mx-root-writing.mx-controls-folded .mx-book-workspace{flex:1 0 20rem;min-height:20rem}.mx-controls-folded .mx-writing-column{overflow:auto;gap:0}
.mx-root textarea,.mx-constraints-editor-host,.mx-history-surface pre{font-size:var(--mx-content-size)}
@container(max-width:520px){.mx-topbar{gap:3px 6px}.mx-topbar-group+.mx-topbar-group{padding-inline-start:4px}.mx-topbar-book{flex-basis:12rem}.mx-topbar-chapter{flex-basis:8rem}.mx-partner-row{grid-template-columns:minmax(7rem,1fr) minmax(0,2fr)}.mx-partner-model{max-width:18ch}}
@container(max-width:340px){.mx-topbar-book,.mx-topbar-chapter{flex-basis:100%}.mx-partner-row{grid-template-columns:minmax(0,1fr)}.mx-result-chooser{max-width:100%}}
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

    const outlineTarget = (w, owner) => owner && w?.book.id === owner.bookId && w.chapterId === owner.chapterId ? chapterOf(w) : null;
    function outlineReviewReceipt(before, after, record, accept) {
      if (after?.id !== before.id || after.revision !== before.revision + 1 || !Array.isArray(after.chapters) || !Array.isArray(after.proposals)) return false;
      const old = before.chapters.find(c => c.id === record.chapterId), next = after.chapters?.find(c => c.id === record.chapterId);
      const saved = after.proposals?.find(p => p.id === record.id);
      return !!old && !!next && saved?.mode === 'outline' && saved.chapterId === record.chapterId && saved.text === record.text &&
        saved.state === (accept ? 'accepted' : 'rejected') && next.outline === (accept ? record.text : old.outline) &&
        next.body === old.body && equal(next.history, old.history);
    }
    const outlineProposals = (book, chapterId) => book.proposals.filter(p => p.chapterId === chapterId && p.mode === 'outline').slice().reverse();
    function outlineReviewProblem(w, owner, record, { conflict = null, recovery = null, accept = false } = {}) {
      const target = outlineTarget(w, owner);
      if (!target || !record || record.chapterId !== target.id || record.mode !== 'outline' || record.state !== 'ready' ||
          !w.book.proposals.some(p => p.id === record.id && JSON.stringify(p) === JSON.stringify(record))) return 'confirmChanged';
      if (recovery || conflict || isDirty(w)) return 'saveFirst';
      return accept && staleProposal(w, record) ? 'outlineCandidateStale' : '';
    }

    function Field({ label, hint, children, visuallyHidden = false }) {
      return h('label', { className: 'mx-field' }, h('span', { className: visuallyHidden ? 'mx-visually-hidden' : undefined }, label), children, hint && h('span', { className: 'mx-hint' }, hint));
    }
    function ConstraintsTextSurface({ draft, options, focusRef, bookId, addRef, viewport, owner }) {
      const host = useRef(null), engine = useRef(null), expected = useRef(null), latest = useRef(null);
      const ownedComposition = useRef(false);
      useLayoutEffect(() => {
        let alive = true;
        latest.current = { options };
        const saved = viewport.current;
        const initialViewport = saved?.bookId === bookId && sameConstraintsDraft(saved.draft, draft) ? saved.view : null;
        const instance = __dshInspirationContinuousMarkdown.createContinuousMarkdown(host.current, {
          ...options, ...listeners(), initialViewport, text: textareaValue(draft.text),
        });
        expected.current = draft;
        engine.current = { instance, listeners };
        const connection = { bookId, instance };
        owner.current = connection;
        function listeners() {
          return {
            acceptInput: update => alive && latest.current.options.acceptInput(update),
            onInput: update => {
              if (!alive) return;
              const applied = latest.current.options.onInput(update);
              if (applied) expected.current = applied;
            },
            onSelection: value => { if (alive) latest.current.options.onSelection(value); },
            onLimit: () => { if (alive) latest.current.options.onLimit(); },
            onCompositionStart: () => { if (alive) { ownedComposition.current = true; latest.current.options.beginComposition(); } },
            onCompositionEnd: () => { if (alive) { ownedComposition.current = false; latest.current.options.releaseComposition(); } },
          };
        }
        return () => {
          alive = false; engine.current = null;
          if (owner.current === connection) {
            viewport.current = { bookId, draft: expected.current, view: instance.captureViewport() };
            owner.current = null;
          }
          instance.destroy();
          if (ownedComposition.current) latest.current.options.releaseComposition();
          ownedComposition.current = false;
        };
      }, []);
      useLayoutEffect(() => {
        const entry = engine.current;
        if (!entry) return;
        latest.current = { options };
        // Reading the synchronous workspace prevents a delayed React render from
        // resetting a native editor that already accepted a newer keystroke.
        const currentDraft = options.getDraft();
        if (!currentDraft) return;
        const resetHistory = !sameConstraintsDraft(expected.current, currentDraft);
        expected.current = currentDraft;
        entry.instance.sync({ ...options, ...entry.listeners(), text: textareaValue(currentDraft.text),
          invalid: !!currentDraft.error || options.invalid, resetHistory });
        const pending = focusRef.current;
        if (pending?.bookId !== bookId) return;
        focusRef.current = null;
        if (pending.add) addRef.current?.focus();
        else entry.instance.focusRange(pending.start, pending.end);
      });
      return h('div', { ref: host, className: 'mx-constraints-editor-host', 'data-invalid': options.invalid || undefined });
    }
    function Icon({ size = 18 } = {}) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 4.5h7a3 3 0 0 1 3 3V20a4 4 0 0 0-3-1.5H4zM14 7.5l5-4 2 2-5 4M14 12h6v6.5h-3' }),
        h('path', { d: 'M7 9h4M7 12h4M7 15h3' }));
    }
    // Each receipt is a distinct event, even if its text repeats.
    function expireToast(message, setMessage, start = setTimeout, cancel = clearTimeout) {
      if (!message) return;
      const timer = start(() => setMessage(current => current === message ? null : current), 1000);
      return () => cancel(timer);
    }
    const isFindControl = node => !!node?.closest?.('.mx-find-bar,[data-mx-find-trigger]');
    function findShortcut(event) {
      return !event.defaultPrevented && !event.repeat && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229 &&
        (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key?.toLowerCase() === 'f';
    }
    function PageFind({ rootRef, pageRef, inputRef, scope, writing, onClose, t, id }) {
      const api = __dshInspirationPageFind;
      const [draft, setDraft] = useState(''), [query, setQuery] = useState(''), [result, setResult] = useState(null), [marks, setMarks] = useState([]);
      const revealed = useRef(null), sequence = useRef(0);
      const current = result?.query === query && result?.scope === scope ? result : null;
      const active = current?.hits[current.index];
      const move = direction => {
        if (inputRef.current?.dataset.findComposing) return;
        const navigation = ++sequence.current;
        setResult(old => old?.query === query && old?.scope === scope && old.hits.length
          ? { ...old, index: api.cycleFindIndex(old.index, direction, old.hits.length), navigation } : old);
      };
      useLayoutEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);
      useEffect(() => {
        const page = pageRef.current, view = page?.ownerDocument.defaultView;
        if (!page || !view || !query) return;
        let timer;
        const scan = () => {
          timer = undefined;
          const root = writing ? page.querySelector('.mx-body-slot textarea.mx-editor') : page; // Never search an AI preview in place of the manuscript.
          const { hits, limited } = root ? api.scanPageFind(root, query) : { hits: [], limited: false };
          const navigation = ++sequence.current;
          setResult(old => {
            const same = old?.query === query && old?.scope === scope;
            return { query, scope, hits, limited, unavailable: writing && !root, index: hits.length ? Math.min(same ? Math.max(old.index, 0) : 0, hits.length - 1) : -1,
              navigation: same && old.hits.length ? old.navigation : navigation };
          });
        };
        const schedule = () => { if (timer === undefined) timer = view.setTimeout(scan, 50); };
        const observer = new view.MutationObserver(schedule);
        observer.observe(page, { subtree: true, childList: true, characterData: true, attributes: true,
          attributeFilter: ['open', 'hidden', 'class', 'style', 'inert', 'aria-hidden', 'value', 'data-editing'] });
        page.addEventListener('input', schedule, true);
        page.addEventListener('toggle', schedule, true);
        schedule();
        return () => { observer.disconnect(); page.removeEventListener('input', schedule, true); page.removeEventListener('toggle', schedule, true); view.clearTimeout(timer); };
      }, [query, scope, writing]);
      useLayoutEffect(() => {
        const root = rootRef.current, view = root?.ownerDocument.defaultView;
        if (!root || !active || !view) { setMarks(previous => previous.length ? [] : previous); return; }
        let frame = null, local;
        const measure = () => { local = active.kind === 'field' ? api.findFieldRects(active, root) : null; };
        const paint = () => {
          frame = null;
          const next = api.paintFindHit(active, root, local);
          setMarks(previous => equal(previous, next) ? previous : next);
        };
        const schedule = () => { if (frame === null) frame = view.requestAnimationFrame(paint); };
        const resize = () => { measure(); schedule(); };
        measure();
        if (revealed.current !== current.navigation) { revealed.current = current.navigation; api.revealFindHit(active, root, local); }
        paint();
        root.addEventListener('scroll', schedule, true);
        view.addEventListener('resize', resize);
        const observer = view.ResizeObserver ? new view.ResizeObserver(resize) : null;
        observer?.observe(root); if (active.node !== root) observer?.observe(active.node);
        return () => { observer?.disconnect(); root.removeEventListener('scroll', schedule, true); view.removeEventListener('resize', resize); if (frame !== null) view.cancelAnimationFrame(frame); };
      }, [active, current?.navigation]);
      const count = current && (current.unavailable ? t('findNoChapterBody') : current.limited || current.hits.length
        ? t(current.limited ? 'findLimited' : 'findCount', { current: current.index + 1, total: current.hits.length }) : t('findNoResults'));
      const control = (label, path, onClick, disabled = false) => h('button', { type: 'button', className: 'mx-find-button',
        title: t(label), 'aria-label': t(label), onClick, disabled }, h('svg', { width: 14, height: 14, viewBox: '0 0 24 24',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' }, h('path', { d: path })));
      return h(React.Fragment, null,
        h('div', { className: 'mx-find-marks', 'aria-hidden': true }, marks.map((style, index) => h('span', { key: index, className: 'mx-find-mark', style }))),
        h('div', { className: 'mx-find-anchor' }, h('div', { className: 'mx-find-bar', id, role: 'search', 'aria-label': t('findText') },
          h('input', { type: 'search', className: 'mx-find-input', ref: inputRef, value: draft, maxLength: api.PAGE_FIND_MAX_QUERY_LENGTH,
            placeholder: t('findText'), 'aria-label': t('findText'), title: t('findHint'), autoComplete: 'off', spellCheck: false,
            onCompositionStart: event => { event.currentTarget.dataset.findComposing = 'true'; },
            onCompositionEnd: event => { delete event.currentTarget.dataset.findComposing; setDraft(event.target.value); setQuery(event.target.value); },
            onChange: event => { setDraft(event.target.value); if (!event.currentTarget.dataset.findComposing) setQuery(event.target.value); }, onKeyDown: event => {
              if (event.key === 'Enter' && !event.currentTarget.dataset.findComposing && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
            } }),
          h('span', { className: 'mx-find-count', 'aria-live': 'polite', 'aria-atomic': true }, count),
          control('findPrevious', 'M5 15l7-7 7 7', () => move(-1), !active),
          control('findNext', 'M5 9l7 7 7-7', () => move(1), !active),
          control('findClose', 'M6 6l12 12M18 6 6 18', onClose))));
    }
    function Modal({ title, children, actions, onCancel, busy, role = 'alertdialog', id, returnFocus }) {
      const ref = useRef(null), cancelRef = useRef(null);
      useEffect(() => {
        const old = document.activeElement;
        cancelRef.current?.focus();
        return () => {
          const target = returnFocus?.current || old;
          if (target?.isConnected && typeof target.focus === 'function') target.focus();
        };
      }, []);
      const onKeyDown = e => {
        e.stopPropagation();
        if (e.key === 'Escape' && !busy && !e.isComposing && !e.nativeEvent?.isComposing && e.keyCode !== 229) { e.preventDefault(); onCancel(); }
        if (e.key === 'Tab') {
          const items = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')];
          if (!items.length) { e.preventDefault(); return; }
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        }
      };
      return h('div', { className: 'mx-modal-shell' }, h('section', { id, className: 'mx-modal mx-stack', ref, role, 'aria-modal': true, 'aria-label': title, onKeyDown },
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
          const [error, setError] = useState(null), [notice, setToastNotice] = useState(null);
          const setNotice = useCallback(message => setToastNotice({ message }), []);
          const [findOpen, setFindOpen] = useState(false);
          const findPageRef = useRef(null), findInputRef = useRef(null), findButtonRef = useRef(null), findReturnFocus = useRef(null);
          const [tab, setTab] = useState('writing'), [newTitle, setNewTitle] = useState(''), [newChapter, setNewChapter] = useState('');
          const [cardFilter, setCardFilter] = useState(null), [categoryForm, setCategoryForm] = useState(null);
          const categoryNameRef = useRef(null), categoryFilterRef = useRef(null), categoryAddRef = useRef(null), categoryFocusReturn = useRef(false);
          useEffect(() => {
            if (tab !== 'cards' || !w) { categoryFocusReturn.current = false; return; }
            if (busy || loading) return;
            if (categoryForm?.bookId === w.book.id) categoryNameRef.current?.focus();
            else if (categoryFocusReturn.current) { categoryFocusReturn.current = false; categoryAddRef.current?.focus(); }
          }, [tab, w?.book.id, categoryForm?.bookId, busy, loading]);
          const cardTitleInput = useRef(null), cardBodyInput = useRef(null), cardNewButton = useRef(null), cardButtons = useRef(new Map()), cardFocusRequest = useRef(null);
          useEffect(() => {
            const request = cardFocusRequest.current;
            if (!request || busy || loading) return;
            cardFocusRequest.current = null;
            if (tab !== 'cards' || request.bookId !== w?.book.id) return;
            const control = request.editor ? (request.newCard ? cardTitleInput.current : cardBodyInput.current) :
              (cardButtons.current.get(request.id) || (request.id ? categoryFilterRef.current : cardNewButton.current) || categoryAddRef.current);
            control?.focus();
          }, [tab, busy, loading, w?.book.id, w?.card?.id, !!w?.card]);
          const [mode, setMode] = useState('draft'), [instruction, setInstruction] = useState('');
          const [chapterTitleFor, setChapterTitleFor] = useState('');
          const [outlineOwner, setOutlineOwner] = useState(null), [outlineInstruction, setOutlineInstruction] = useState(''), [outlineSelection, setOutlineSelection] = useState('');
          const [outlineNeedsRefresh, setOutlineNeedsRefresh] = useState('');
          const outlineFocusReturn = useRef(null);
          useLayoutEffect(() => {
            const owner = outlineFocusReturn.current, root = rootRef.current;
            if (!owner || owner.from !== tab) return;
            outlineFocusReturn.current = null;
            if (owner.bookId !== w?.book.id || !root) return;
            const trigger = [...root.querySelectorAll('[data-mx-outline-chapter]')].find(node => node.dataset.mxOutlineChapter === owner.chapterId && node.getClientRects().length);
            (trigger || (tab === 'writing' ? editorRef.current : chapterManagementHeading.current))?.focus({ preventScroll: true });
          }, [tab, w?.book.id]);
          const toolPages = ['tools', 'manage', 'context', 'advanced'];
          const chapterTitleButtonRef = useRef(null), workspaceNavigation = useRef(0), foldButtonRef = useRef(null), foldFocusPending = useRef(false);
          const addChapterInputRef = useRef(null), addChapterFocusPending = useRef(false);
          const chapterDeleteTrigger = useRef(null), chapterManagementHeading = useRef(null), chapterDeleteFocusPending = useRef(false);
          useEffect(() => { setNewChapter(''); }, [w?.book.id]);
          useLayoutEffect(() => {
            if (!chapterDeleteFocusPending.current) return;
            chapterDeleteFocusPending.current = false; chapterManagementHeading.current?.focus({ preventScroll: true });
          }, [w?.book.revision]);
          const utilityHeadingRef = useRef(null), utilityFocusPending = useRef('');
          useLayoutEffect(() => {
            if (utilityFocusPending.current !== tab) return;
            utilityFocusPending.current = '';
            if (!addChapterFocusPending.current) utilityHeadingRef.current?.focus({ preventScroll: true });
          }, [tab]);
          const [controlsFolded, setControlsFolded] = useState(false);
          useEffect(() => { setChapterTitleFor(''); }, [tab, w?.book.id, w?.chapterId]);
          useLayoutEffect(() => {
            if (!addChapterFocusPending.current || !addChapterInputRef.current) return;
            addChapterFocusPending.current = false; addChapterInputRef.current.focus();
          }, [tab, w?.book.id]);
          const focusWriting = value => {
            if (autosaveComposing.current) return;
            closeSelectionPopup();
            foldFocusPending.current = true; setControlsFolded(value);
          };
          useLayoutEffect(() => {
            if (!foldFocusPending.current) return;
            foldFocusPending.current = false;
            foldButtonRef.current?.focus({ preventScroll: true });
            foldButtonRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' });
          }, [controlsFolded]);
          const rootRef = useRef(null), contentRef = useRef(null), panelRef = useRef(null), columnRef = useRef(null);
          useLayoutEffect(() => {
            if (contentRef.current) { contentRef.current.scrollTop = 0; contentRef.current.scrollLeft = 0; }
          }, [tab, w?.book.id, w?.chapterId]);
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
          const [contextError, setContextError] = useState(null), [contextRefresh, setContextRefresh] = useState(0);
          const [job, setJob] = useState(null), [pollError, setPollError] = useState(false), [pollVersion, setPollVersion] = useState(0);
          const [recovery, setRecovery] = useState(null), recoveryRef = useRef(null);
          const [storageFailed, setStorageFailed] = useState(false), [conflict, setConflict] = useState(null);
          const [guard, setGuard] = useState(null), [confirm, setConfirm] = useState(null);
          const [constraintsHelpBook, setConstraintsHelpBook] = useState('');
          const constraintsHelpTrigger = useRef(null);
          const [manager, setManager] = useState(null), [deletionNotice, setDeletionNotice] = useState(null);
          const toastError = guard || confirm || polishRequirements || constraintsHelpBook ? null : error;
          const toast = toastError || notice;
          useEffect(() => expireToast(notice, setToastNotice), [notice]);
          useEffect(() => expireToast(toastError, setError), [toastError]);
          const uncertainDeletes = useRef(new Set()), uncertainChapterWrites = useRef(new Set());
          const [cleanupPendingCount, setCleanupPendingCount] = useState(0);
          const [constraintsSourceBook, setConstraintsSourceBook] = useState('');
          const [constraintsCursor, setConstraintsCursor] = useState(null), [constraintsLimit, setConstraintsLimit] = useState('');
          const constraintsFocusRef = useRef(null), constraintsAddRef = useRef(null), constraintsViewport = useRef(null);
          const constraintsHistory = useRef(new WeakMap()), constraintsEngine = useRef(null), pendingConstraintsStructure = useRef(null);
          const constraintsProjection = useMemo(() => tab === 'constraints' && w?.constraintsEditor && !w.constraintsEditor.error ?
            constraintVisualTargets(w.constraintsEditor.text, w.settings.writingConstraints, null) : null,
            [tab, w?.constraintsEditor?.text, w?.constraintsEditor?.error, w?.settings.writingConstraints]);
          const constraintsOffsets = useMemo(() => normalizedSourceOffsets(tab === 'constraints' ? w?.constraintsEditor?.text ?? '' : ''),
            [tab, w?.constraintsEditor?.text]);
          const editorRef = useRef(null), composing = useRef(false), alive = useRef(false), busyRef = useRef(false);
          const autosaveRef = useRef(null), autosaveBindings = useRef(null), autosaveComposing = useRef(false);
          const epoch = useRef(0), availabilityEpoch = useRef(0), listSequence = useRef(0), contextSequence = useRef(0), selectionRef = useRef(null);
          const requests = useRef(new Set()), downloads = useRef(new Map()), liveJobs = useRef([]), pendingLatest = useRef(null), unavailableBooks = useRef(new Map());
          const formId = useRef('inspiration-' + Math.random().toString(36).slice(2));
          const switchTab = value => {
            if (autosaveComposing.current) return;
            const active = current.current;
            reviewRef.current = null; setSelectionPopup(null); invalidateReviewReturn(); contextSequence.current++;
            if (tab === 'manage' && value !== 'manage' && !autosaveRef.current?.failed) setError(null);
            setManager(value === 'manage' && active ? {
              snapshot: managementSnapshot(active), title: active.book.title, typedTitle: '', uncertain: uncertainDeletes.current.has(active.book.id),
            } : null);
            setTab(value);
          };
          const navigatePage = value => {
            if (busyRef.current || loading || autosaveComposing.current || guard || confirm || polishRequirements || value === tab) return;
            workspaceNavigation.current++;
            utilityFocusPending.current = toolPages.includes(value) ? value : '';
            switchTab(value);
          };

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
            if (!value || deletedBookIds.has(value.book.id)) return;
            const projected = autosaveRecoveryWorkspace(value, autosaveRef.current?.pendingSnapshot);
            if (!isDirty(projected)) return;
            const payload = autosaveRecoveryPayload(value, autosaveRef.current || {});
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
            return validAutosaveRecovery(value, bookId) ? value : null;
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
          const refreshWorkspace = () => {
            const stillRequested = navigationIntent();
            return transition(() => withBusy(async () => {
              const data = await refreshList(), active = current.current;
              if (!data) return;
              if (active && !data.books.some(book => book.id === active.book.id)) {
                // An external deletion or an ambiguous earlier request is not a
                // deletion receipt: preserve the displayed copy and local drafts.
                const missing = markBookUnavailable({ unavailable: unavailableBooks.current, pendingLatest: pendingLatest.current }, active.book.id, listSequence.current);
                unavailableBooks.current = missing.unavailable; pendingLatest.current = missing.pendingLatest; epoch.current++; availabilityEpoch.current++;
                persist(active); setError({ code: 'NOT_FOUND', message: t('bookMissing') }); return;
              }
              const page = toolPages.includes(tab) || tab === 'outline' ? tab : 'writing';
              if (active) await openBook(active.book.id, active.chapterId, page, true);
              else if (data.books.length) await openBook(data.books[0].id, undefined, page, true);
            }), 'all', stillRequested);
          };
          const syncBookList = book => setBooks(previous => {
            if (!bookIsAvailable(book.id, deletedBookIds, unavailableBooks.current)) return previous;
            const entry = { id: book.id, title: book.title, chapterCount: book.chapters.length, updatedAt: book.updatedAt };
            return previous.some(b => b.id === book.id) ? previous.map(b => b.id === book.id ? entry : b) : [...previous, entry];
          });
          const resetSelection = () => { setSelectionPopup(null); setPolishRequirements(null); selectionRef.current = null; setSelection(null); setContext(null); setContextBusy(false); contextSequence.current++; };
          const openBook = async (bookId, preferredChapter, page = 'writing', reconcileDelete = false) => {
            if (!bookIsAvailable(bookId, deletedBookIds, unavailableBooks.current)) return false;
            autosaveRef.current?.cancel(); autosaveRef.current?.resetFailure();
            const serial = ++epoch.current;
            setLoading(true); setError(null); setConflict(null); pendingLatest.current = null; resetSelection();
            try {
              const book = await call('get', { bookId });
              if (!alive.current || epoch.current !== serial || !bookIsAvailable(book.id, deletedBookIds, unavailableBooks.current)) return false;
              commit(workspace(book, preferredChapter)); syncBookList(book); assignRecovery(readRecovery(book.id));
              if (reconcileDelete) { uncertainDeletes.current.delete(book.id); uncertainChapterWrites.current.delete(book.id); }
              const remembered = readJob(book.id) || liveJobs.current.find(item => item.bookId === book.id && item.mode === 'outline');
              setJob(remembered && book.chapters.some(c => c.id === remembered.chapterId) ? remembered : null);
              setPollError(false); setPollVersion(value => value + 1); switchTab(page);
              return true;
            } catch (e) { if (serial === epoch.current) messageError(e); return false; }
            finally { if (alive.current && epoch.current === serial) setLoading(false); }
          };
          const adopt = (book, cleared) => {
            const active = current.current;
            if (!active || active.book.id !== book.id || !bookIsAvailable(book.id, deletedBookIds, unavailableBooks.current)) return false;
            if (book.revision < active.book.revision) return false;
            const conflicts = conflictingFields(active, book).filter(kind => kind !== cleared);
            if (active.chapterId && !book.chapters.some(c => c.id === active.chapterId)) {
              const projected = autosaveRecoveryWorkspace(active, autosaveRef.current?.pendingSnapshot);
              if (dirty(projected).chapter && !conflicts.includes('chapter')) conflicts.push('chapter');
            }
            if (conflicts.length) { setConflict({ book, fields: conflicts }); setError({ code: 'CONFLICT', message: t('conflictTitle') }); persist(active); return false; }
            const next = mergeWorkspace(active, book, cleared);
            // A refresh for an unrelated Host update is not an instruction to
            // canonicalize author formatting or reset the editor's undo stack.
            if (!dirty(active).settings && cleared !== 'settings' && equal(active.settings.writingConstraints, next.settings.writingConstraints))
              next.constraintsEditor = active.constraintsEditor;
            commit(next); syncBookList(book); setConflict(null); setContext(null);
            return true;
          };
          const queueLatest = book => {
            if (!pendingLatest.current || pendingLatest.current.id !== book.id || pendingLatest.current.revision < book.revision) pendingLatest.current = book;
          };
          const loadLatest = async () => {
            const active = current.current, serial = epoch.current;
            if (!active) return;
            const book = await call('get', { bookId: active.book.id });
            if (!alive.current || epoch.current !== serial || current.current?.book.id !== book.id) return;
            // A poll read must not re-introduce old edits during an in-flight save.
            if (busyRef.current || autosaveRef.current?.running) { queueLatest(book); return; }
            adopt(book);
          };
          const withBusy = async (action, waitForAutosave = true, allowAutosaveFailure = false) => {
            if (busyRef.current || loading || autosaveComposing.current) return false;
            const serial = epoch.current, bookId = current.current?.book.id;
            busyRef.current = true; setBusy(true); setError(null);
            try {
              if (waitForAutosave) await autosaveRef.current?.wait();
              if (!alive.current || epoch.current !== serial || current.current?.book.id !== bookId) return false;
              if (waitForAutosave && autosaveRef.current?.failed && !allowAutosaveFailure) throw new Error(t('autosavePaused'));
              await action(); return true;
            }
            catch (e) { messageError(e); return false; }
            finally {
              busyRef.current = false;
              if (alive.current) {
                setBusy(false);
                if (!autosaveRef.current?.running) {
                  const waiting = pendingLatest.current; pendingLatest.current = null;
                  if (waiting && waiting.id === current.current?.book.id && waiting.revision > current.current.book.revision) adopt(waiting);
                }
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
          autosaveBindings.current = {
            paused: manual => !alive.current || loading || !!recoveryRef.current || !!conflict || autosaveComposing.current ||
              !current.current || !bookIsAvailable(current.current.book.id, deletedBookIds, unavailableBooks.current) ||
              !manual && (busyRef.current || !!guard || !!confirm || !!polishRequirements),
            send: request => call('mutate', request),
            apply: (next, book) => {
              commit(next); syncBookList(book); setContext(null);
              if (isDirty(next)) persist(next); else forgetDraft(book.id);
            },
            started: () => persist(current.current),
            fail: error => {
              persist(current.current);
              messageError({ ...error, code: error.code, message: ['autosaveReceipt', 'constraintsCrypto'].includes(error.message) ? t(error.message) : error.message });
            },
            settled: () => {
              if (!alive.current || busyRef.current) return;
              const waiting = pendingLatest.current; pendingLatest.current = null;
              if (waiting && waiting.id === current.current?.book.id && waiting.revision > current.current.book.revision) adopt(waiting);
            },
          };
          if (!autosaveRef.current) autosaveRef.current = createAutosaveController({
            getWorkspace: () => current.current, getEpoch: () => epoch.current,
            isPaused: manual => autosaveBindings.current.paused(manual), send: request => autosaveBindings.current.send(request),
            apply: (...args) => autosaveBindings.current.apply(...args), fail: error => autosaveBindings.current.fail(error),
            started: () => autosaveBindings.current.started(), settled: () => autosaveBindings.current.settled(),
          });
          const reconcileAutosaveFailure = async () => {
            const controller = autosaveRef.current, pending = controller.pendingSnapshot;
            if (!controller.failed) return;
            if (!pending) { controller.resetFailure(); return; }
            const serial = epoch.current, active = current.current;
            const latest = await call('get', { bookId: active.book.id });
            if (!alive.current || epoch.current !== serial || current.current?.book.id !== active.book.id) throw new DOMException('Panel changed', 'AbortError');
            let next;
            if (latest.revision === pending.snapshot.book.revision) next = mergeWorkspace(current.current, latest);
            else if (latest.revision === pending.snapshot.book.revision + 1 && autosaveOperationApplied(latest, pending.snapshot, pending.step)) {
              next = mergeAutosaveAck(current.current, pending.snapshot, latest, pending.step);
            } else {
              const journal = autosaveRecoveryPayload(current.current, controller);
              if (missingChapterDraft(latest, journal)) {
                setConflict({ book: latest, fields: ['chapter'] });
                throw Object.assign(new Error(t('chapterMissingDraft')), { code: 'CONFLICT' });
              }
              next = restoredAutosaveWorkspace(workspace(latest, current.current.chapterId), journal);
              const fields = conflictingFields(next, latest);
              if (fields.length) { setConflict({ book: latest, fields }); throw Object.assign(new Error(t('conflictTitle')), { code: 'CONFLICT' }); }
              next = mergeWorkspace(next, latest, null, true);
            }
            if (!next) throw Object.assign(new Error(t('autosaveReceipt')), { code: 'CONFLICT' });
            commit(next); syncBookList(latest); controller.resetFailure();
            controller.restorePendingCard(next.card && !next.card.id ? controller.pendingCard : null, next.baseCard);
          };
          const saveAll = async () => {
            if (!current.current || conflict) return false;
            const ok = await withBusy(async () => {
              await reconcileAutosaveFailure();
              if (current.current.constraintsEditor?.error) throw new Error(t(current.current.constraintsEditor.error));
              if (dirty(current.current).settings && !validWritingConstraints(current.current.settings.writingConstraints)) throw new Error(t('constraintsInvalid'));
              if (!await autosaveRef.current.flush({ manual: true, retry: true })) throw new Error(t('autosavePaused'));
              const active = current.current, d = dirty(active);
              if (d.chapter || d.settings || d.card) throw new Error(t('autosaveIncomplete'));
              if (d.candidate) await mutateRaw({ action: 'updateProposal', proposalId: active.candidateId, text: active.candidate }, 'candidate');
              if (alive.current) { forgetDraft(current.current.book.id); assignRecovery(null); }
            }, true, true);
            if (!ok && current.current) persist(current.current);
            return ok;
          };
          const discardScope = async scope => {
            const serial = epoch.current, bookId = current.current?.book.id;
            await autosaveRef.current.wait();
            if (epoch.current !== serial || current.current?.book.id !== bookId) return false;
            if (autosaveRef.current.failed && autosaveRef.current.pendingSnapshot) {
              try {
                const latest = await call('get', { bookId });
                if (!alive.current || epoch.current !== serial || current.current?.book.id !== bookId) return false;
                const journal = autosaveRecoveryPayload(current.current, autosaveRef.current);
                if (scope !== 'all' && missingChapterDraft(latest, journal)) {
                  setConflict({ book: latest, fields: ['chapter'] });
                  setError({ code: 'CONFLICT', message: t('chapterMissingDraft') }); return false;
                }
                const recovered = scope === 'all' ? null : restoredAutosaveWorkspace(workspace(latest, current.current.chapterId), journal);
                commit(scope === 'all' ? workspace(latest, current.current.chapterId) : mergeWorkspace(recovered, latest, scope));
                syncBookList(latest);
              } catch (error) { messageError(error); return false; }
            }
            autosaveRef.current.cancel(); autosaveRef.current.resetFailure();
            const active = current.current;
            if (!active) return;
            if (scope === 'candidate') commit({ ...active, candidate: active.baseCandidate });
            else if (scope === 'card') commit({ ...active, card: active.baseCard });
            else { commit(workspace(active.book, active.chapterId)); setConflict(null); }
            const remainingConflicts = conflictingFields(current.current, current.current.book);
            if (remainingConflicts.length) setConflict({ book: current.current.book, fields: remainingConflicts });
            if (!isDirty(current.current)) forgetDraft(active.book.id); else persist(current.current);
            return true;
          };
          const transition = async (run, scope = 'all', stillRequested = () => true) => {
            if (busyRef.current || loading || autosaveComposing.current) return;
            const serial = epoch.current, bookId = current.current?.book.id;
            await autosaveRef.current.flush();
            if (epoch.current !== serial || current.current?.book.id !== bookId || busyRef.current || autosaveComposing.current || !stillRequested()) return;
            invalidateReviewReturn();
            const projected = autosaveRecoveryWorkspace(current.current, autosaveRef.current.pendingSnapshot), d = dirty(projected);
            if (scope === 'all' ? isDirty(projected) : d[scope]) setGuard({ run, scope });
            else run();
          };
          const navigationIntent = () => {
            const ticket = ++workspaceNavigation.current, bookId = current.current?.book.id;
            return () => workspaceNavigation.current === ticket && current.current?.book.id === bookId;
          };
          const selectBook = bookId => {
            const stillRequested = navigationIntent();
            if (bookId && current.current?.book.id !== bookId)
              return transition(() => { if (stillRequested()) openBook(bookId, undefined, toolPages.includes(tab) ? tab : 'writing'); }, 'all', stillRequested);
          };
          const changeChapter = (chapterId, page = toolPages.includes(tab) ? tab : 'writing') => {
            const stillRequested = navigationIntent();
            if (!current.current?.book.chapters.some(chapter => chapter.id === chapterId) || current.current.chapterId === chapterId) return;
            return transition(() => {
              const active = current.current;
              if (!stillRequested() || !active || active.chapterId === chapterId || !active.book.chapters.some(chapter => chapter.id === chapterId)) return;
              epoch.current++; commit(workspace(active.book, chapterId)); resetSelection(); setError(null); setConflict(null); switchTab(page);
            }, 'all', stillRequested);
          };
          const openManagedChapter = id => current.current?.chapterId === id ? navigatePage('writing') : changeChapter(id, 'writing');
          const openChapterOutline = (chapterId, from) => {
            if (busyRef.current || loading || guard || confirm || polishRequirements || autosaveComposing.current) return;
            const stillRequested = navigationIntent();
            const open = () => {
              const active = current.current;
              if (!stillRequested() || !active?.book.chapters.some(c => c.id === chapterId) || recoveryRef.current && active.chapterId !== chapterId) return;
              if (active.chapterId !== chapterId) {
                epoch.current++; commit(workspace(active.book, chapterId)); resetSelection(); setError(null); setConflict(null);
              }
              setOutlineOwner({ bookId: active.book.id, chapterId, from });
              setOutlineInstruction(''); setOutlineSelection(''); utilityFocusPending.current = 'outline'; switchTab('outline');
            };
            if (current.current?.chapterId === chapterId) open();
            else return transition(open, 'all', stillRequested);
          };
          const refreshChapterOutline = () => withBusy(async () => {
            const active = current.current, serial = epoch.current;
            if (!outlineTarget(active, outlineOwner)) return;
            const latest = await call('get', { bookId: active.book.id });
            if (!alive.current || epoch.current !== serial || latest?.id !== active.book.id) return;
            if (!adopt(latest)) throw new Error(t('conflictTitle'));
            const data = await refreshList();
            if (!data || !alive.current || epoch.current !== serial || current.current?.book.id !== active.book.id) return;
            const runningJob = data.activeJobs.find(item => item.bookId === active.book.id);
            if (runningJob?.mode === 'outline') { rememberJob(runningJob); setJob(runningJob); setPollError(false); setPollVersion(value => value + 1); }
            setOutlineNeedsRefresh('');
          }, true, true);
          const startChapterOutline = () => withBusy(async () => {
            const active = current.current, target = outlineTarget(active, outlineOwner), serial = epoch.current;
            if (tab !== 'outline' || !target || !bookIsAvailable(active.book.id, deletedBookIds, unavailableBooks.current)) throw new Error(t('outlineMissing'));
            if (outlineNeedsRefresh === active.book.id) throw new Error(t('outlineRefreshNeeded'));
            if (recoveryRef.current || conflict || isDirty(active)) throw new Error(t('saveFirst'));
            if ([job, ...liveJobs.current].some(item => item?.bookId === active.book.id && item.status === 'running')) throw new Error(t('chapterStructureBusy'));
            const modelProblem = modelGenerationProblem(modelPrefsRef.current, catalogRef.current, modelSaveRef.current);
            if (modelProblem) throw new Error(t(modelProblem));
            let data;
            try {
              data = await call('generate', { bookId: active.book.id, chapterId: target.id, expectedRevision: active.book.revision,
                expectedModelRevision: modelPrefsRef.current.settings.revision, mode: 'outline', instruction: outlineInstruction, selection: null });
            } catch (error) {
              if (error.code === 'MODEL_CONFLICT') { commitModelPrefs({ ...modelPrefsRef.current, conflict: true }); throw Object.assign(new Error(t('modelSettingsConflict')), { code: error.code }); }
              if (['NETWORK', 'RESPONSE', 'STORAGE', 'INTERNAL'].includes(error.code) && alive.current) setOutlineNeedsRefresh(active.book.id);
              throw error;
            }
            if (!alive.current || epoch.current !== serial || !outlineTarget(current.current, outlineOwner)) return;
            if (typeof data?.jobId !== 'string' || !data.jobId) { setOutlineNeedsRefresh(active.book.id); throw new Error(t('outlineRefreshNeeded')); }
            const next = { id: data.jobId, bookId: active.book.id, chapterId: target.id, status: 'running', mode: 'outline', sourceRevision: target.revision, text: '' };
            rememberJob(next); setJob(next); setPollError(false); setOutlineSelection('');
          });
          const decideChapterOutline = (record, accept) => {
            const active = current.current, owner = outlineOwner;
            const problem = outlineReviewProblem(active, owner, record, { recovery: recoveryRef.current, conflict, accept });
            if (problem || outlineNeedsRefresh === active?.book.id) { setError({ message: t(problem || 'outlineRefreshNeeded') }); return; }
            const operation = { action: accept ? 'acceptProposal' : 'rejectProposal', proposalId: record.id };
            const snapshot = reviewSnapshot(active, operation), label = t(accept ? 'outlineUse' : 'outlineReject');
            setConfirm({ outlineDecision: true, title: t(accept ? 'outlineReviewReplace' : 'outlineReject'), body: t(accept ? 'outlineReviewHint' : 'rejectHint'), label,
              run: () => withBusy(async () => {
                const latest = current.current, recheck = outlineReviewProblem(latest, owner, record, { recovery: recoveryRef.current, conflict, accept });
                if (recheck || !reviewIsCurrent(latest, snapshot)) throw new Error(t(recheck || 'confirmChanged'));
                if (outlineNeedsRefresh === latest.book.id) throw new Error(t('outlineRefreshNeeded'));
                let saved;
                try {
                  saved = await call('mutate', { bookId: snapshot.bookId, expectedRevision: snapshot.revision, operation });
                  if (!outlineReviewReceipt(latest.book, saved, record, accept)) throw Object.assign(new Error(t('outlineRefreshNeeded')), { code: 'RESPONSE' });
                } catch (error) {
                  if (['NETWORK', 'RESPONSE', 'STORAGE', 'INTERNAL', 'CONFLICT'].includes(error.code) && alive.current) {
                    setOutlineNeedsRefresh(snapshot.bookId); setConfirm(null);
                    throw new Error(t('outlineRefreshNeeded'));
                  }
                  throw error;
                }
                if (!alive.current || !outlineTarget(current.current, owner)) return;
                if (!adopt(saved)) throw new Error(t('conflictTitle'));
                setConfirm(null); setNotice(t(accept ? 'outlineSaved' : 'outlineRejected'));
              }) });
          };
          const closeChapterOutline = () => {
            const from = outlineOwner?.from === 'manage' ? 'manage' : 'writing';
            if (busyRef.current || loading || guard || confirm || autosaveComposing.current) return;
            outlineFocusReturn.current = outlineOwner ? { ...outlineOwner, from } : null;
            navigatePage(from);
          };
          const download = (filename, mime, text) => {
            const url = URL.createObjectURL(new Blob([text], { type: mime }));
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
            const timer = setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 1500);
            downloads.current.set(url, timer);
          };
          const downloadLocal = () => {
            const active = current.current, projected = autosaveRecoveryWorkspace(active, autosaveRef.current?.pendingSnapshot);
            const payload = active && isDirty(projected) ? autosaveRecoveryPayload(active, autosaveRef.current || {}) : recoveryRef.current;
            if (payload) download('inspiration-local-edits.json', 'application/json', JSON.stringify(payload, null, 2));
          };
          const changeField = (group, field, value) => {
            if (busyRef.current) return;
            const active = current.current;
            const multiline = ['body', 'summary', 'outline', 'premise', 'style', 'content'].includes(field);
            const nextValue = multiline ? applyTextareaEdit(active[group][field], value) : value;
            commit({ ...active, [group]: { ...active[group], [field]: nextValue } });
            if (group === 'chapter' && field === 'body') resetSelection();
            if (group !== 'candidate') autosaveRef.current.schedule();
          };
          const constraintsInputBlocked = (confirmed = false) => busyRef.current || loading || !!recoveryRef.current || !!manager || !!guard || !!confirm && !confirmed;
          const acceptConstraintInput = (bookId, update) => {
            const active = current.current, structure = update.payload;
            if (!alive.current || active?.book.id !== bookId || constraintsInputBlocked(structure?.confirmed === true) ||
                !update.beforeVersion || !update.version || typeof update.beforeVersion !== 'object' || typeof update.version !== 'object') return false;
            const previous = constraintsHistory.current.get(update.beforeVersion);
            if (previous && !sameConstraintsDraft(previous, constraintsHistorySnapshot(active))) return false;
            if (structure) return structure === pendingConstraintsStructure.current && structure.before === active && !autosaveComposing.current &&
              textareaValue(active.constraintsEditor.text) === update.before && textareaValue(structure.after.constraintsEditor.text) === update.text;
            const saved = constraintsHistoryTarget(update, constraintsHistory.current);
            // An admitted history token already carries the exact raw EOLs.
            // Do not synthesize them from today's first line ending on Undo.
            const source = saved ? textareaValue(active.constraintsEditor.text) : active.constraintsEditor.text;
            try { return applyConstraintsChanges(source, update) !== null; }
            catch (error) { return error.message === 'constraintsMarkdownTooLong' ? 'limit' : false; }
          };
          const changeConstraintsMarkdown = (bookId, update) => {
            if (acceptConstraintInput(bookId, update) !== true) return false;
            const active = current.current, history = constraintsHistory.current;
            const saved = constraintsHistoryTarget(update, history);
            const next = update.payload?.after ?? applyConstraintsInput(active, update,
              saved?.text ?? applyConstraintsChanges(active.constraintsEditor.text, update), saved);
            if (next === active) return false;
            if (!history.has(update.beforeVersion)) history.set(update.beforeVersion, constraintsHistorySnapshot(active));
            history.set(update.version, constraintsHistorySnapshot(next));
            commit(next);
            // Clean undo before a request must also clear the outdated local
            // journal. An in-flight/failed write can still need its undo tail.
            if (!recoveryRef.current && !isDirty(autosaveRecoveryWorkspace(next, autosaveRef.current.pendingSnapshot))) {
              const journal = memoryDrafts.get(bookId);
              if (journal?.constraintsEditor?.text === active.constraintsEditor.text) {
                memoryDrafts.delete(bookId);
                try {
                  if (localStorage.getItem(STORAGE + bookId) === JSON.stringify(journal)) localStorage.removeItem(STORAGE + bookId);
                } catch { setStorageFailed(true); }
              }
            } else persist(next);
            autosaveRef.current.schedule(); setConstraintsLimit(''); return true;
          };
          const changeWritingConstraint = (bookId, action, { confirmed = false } = {}) => {
            const active = current.current, owner = constraintsEngine.current;
            if (constraintsInputBlocked(confirmed) || autosaveComposing.current || active?.constraintsEditor?.error ||
                active?.book.id !== bookId || owner?.bookId !== bookId) return null;
            try {
              const next = editWritingConstraints(active, bookId, action);
              if (next === active) return null;
              const payload = { before: active, after: next, confirmed };
              pendingConstraintsStructure.current = payload;
              owner.instance.applyStructure({ text: textareaValue(next.constraintsEditor.text), payload });
              return current.current === next ? next : null;
            } catch (e) { setError({ message: t(e.message) }); return null; }
            finally { pendingConstraintsStructure.current = null; }
          };
          const closeSelectionPopup = () => setSelectionPopup(null);
          const captureSelection = event => {
            const node = editorRef.current, active = current.current;
            if (!node || !active?.chapter) return;
            // Toolbar focus and the requirements dialog must not re-read or
            // collapse a captured range. A fresh editor gesture captures a new intent.
            if (event?.type === 'blur' && (isFindControl(event.relatedTarget) || popupRef.current?.contains(event.relatedTarget) || polishRequirements)) return;
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
          const polishRequestProblem = snapshot => polishIntentProblem(current.current, snapshot, {
            recovery: recoveryRef.current, conflict, intent: selectionRef.current, composing: composing.current, busy: busyRef.current || loading || !!manager || !!guard || !!confirm,
            running: job?.status === 'running' || liveJobs.current.some(j => j.bookId === snapshot?.bookId && (j.status === 'running' || j.settled === false)),
            unavailable: !!snapshot && !bookIsAvailable(snapshot.bookId, deletedBookIds, unavailableBooks.current),
            modelProblem: modelGenerationProblem(modelPrefsRef.current, catalogRef.current, modelSaveRef.current) || (!model?.provider || !model?.model ? 'noModel' : ''),
          });
          const startPolish = (snapshot, direction, custom = false) => {
            // Selection alone NEVER calls the API. This is reached only by an
            // explicit click in the selection popup or requirements submission.
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
              }
            });
          };
          const contextKey = () => JSON.stringify([current.current?.book.id, current.current?.book.revision, current.current?.chapterId, mode, instruction]);
          const previewContext = async signal => {
            if (!current.current || isDirty(current.current) || busyRef.current || autosaveComposing.current) return;
            if (mode === 'revise' && !instruction.trim()) return;
            const key = contextKey(), seq = ++contextSequence.current, active = current.current;
            const stillCurrent = () => alive.current && !signal?.aborted && contextSequence.current === seq && contextKey() === key;
            setContextBusy(true); setContextError(null);
            try {
              const data = await call('context', { bookId: active.book.id, chapterId: active.chapterId, mode, instruction, selection: null }, signal);
              if (stillCurrent()) setContext({ key, data });
            } catch (e) { if (stillCurrent() && e?.name !== 'AbortError') setContextError({ key, message: e?.message || t('requestFailed') }); }
            finally { if (stillCurrent()) setContextBusy(false); }
          };
          const generate = () => withBusy(async () => {
            const active = current.current;
            if (isDirty(active)) throw new Error(t('saveFirst'));
            if (mode === 'revise' && !instruction.trim()) throw new Error(t('reviseRequirement'));
            const modelProblem = modelGenerationProblem(modelPrefsRef.current, catalogRef.current, modelSaveRef.current);
            if (modelProblem) throw new Error(t(modelProblem));

            let data;
            try {
              reviewRef.current = null;
              invalidateReviewReturn();
              data = await call('generate', { bookId: active.book.id, chapterId: active.chapterId, expectedRevision: active.book.revision, expectedModelRevision: modelPrefsRef.current.settings.revision, mode, instruction, selection: null });
            } catch (e) {
              if (e.code === 'MODEL_CONFLICT') {
                // The model revision guard is read-only; keep prose and model choices intact.
                commitModelPrefs({ ...modelPrefsRef.current, conflict: true });
                throw Object.assign(new Error(t('modelSettingsConflict')), { code: e.code });
              }
              throw e;
            }
            const next = { id: data.jobId, bookId: active.book.id, chapterId: active.chapterId, status: 'running', mode, sourceRevision: chapterOf(active)?.revision, text: '' };
            rememberJob(next);
            if (alive.current && current.current?.book.id === active.book.id) { setJob(next); setPollError(false); }
          });
          const create = () => transition(() => withBusy(async () => {
            const book = await call('create', { title: newTitle.trim() });
            if (!alive.current) return;
            epoch.current++; commit(workspace(book)); syncBookList(book); setNewTitle(''); switchTab('writing'); setJob(null); assignRecovery(null); setConflict(null); resetSelection(); setNotice(t('created'));
          }));
          const managedChapterProblem = (snapshot, structural = false) => {
            if (!snapshot || !bookIsAvailable(snapshot.bookId, deletedBookIds, unavailableBooks.current)) return 'bookMissing';
            const problem = managementProblem(current.current, snapshot, recoveryRef.current, conflict);
            if (problem) return problem;
            if (manager?.uncertain) return 'deleteUncertain';
            if (uncertainChapterWrites.current.has(snapshot.bookId)) return 'chapterWriteUncertain';
            if (structural && [job, ...liveJobs.current].some(item => item?.bookId === snapshot.bookId && (item.status === 'running' || item.settled === false))) return 'chapterStructureBusy';
            return '';
          };
          const updateManagementAfterReceipt = (book, operation) => setManager(previous => previous?.snapshot.bookId === book.id ? {
            ...previous, snapshot: managementSnapshot({ book }), typedTitle: '',
            chapterEdit: operation.action !== 'moveChapter' && previous.chapterEdit?.id === operation.chapterId ? null : previous.chapterEdit,
          } : previous);
          const mutateManagedChapter = (snapshot, operation, noticeKey) => withBusy(async () => {
            if (autosaveComposing.current) return;
            const structural = operation.action === 'moveChapter' || operation.action === 'deleteChapter';
            const problem = managedChapterProblem(snapshot, structural);
            if (problem) throw new Error(t(problem === 'confirmChanged' ? 'manageStale' : problem));
            const active = current.current, serial = epoch.current, index = active.book.chapters.findIndex(c => c.id === operation.chapterId);
            if (operation.action !== 'addChapter' && index < 0) throw new Error(t('manageStale'));
            let book;
            try {
              book = await call('mutate', { bookId: snapshot.bookId, expectedRevision: snapshot.revision, operation });
              if (!alive.current || epoch.current !== serial || current.current?.book.id !== snapshot.bookId) return;
              if (!chapterMutationReceipt(active.book, book, operation)) throw Object.assign(new Error(t('chapterWriteUncertain')), { code: 'RESPONSE' });
            } catch (error) {
              if (['NETWORK', 'RESPONSE', 'STORAGE', 'INTERNAL'].includes(error.code)) {
                uncertainChapterWrites.current.add(snapshot.bookId);
                if (alive.current) setConfirm(previous => previous?.chapterRemoval && previous.chapterRemoval.id === operation.chapterId ? { ...previous, uncertain: true } : previous);
                throw Object.assign(new Error(t('chapterWriteUncertain')), { code: error.code });
              }
              throw error;
            }
            if (!adopt(book)) throw Object.assign(new Error(t('conflictTitle')), { code: 'CONFLICT' });
            if (operation.action === 'addChapter') setNewChapter('');
            if (structural) resetSelection();
            if (operation.action === 'deleteChapter') {
              if (active.chapterId === operation.chapterId) {
                const nextId = (book.chapters[index] || book.chapters[index - 1])?.id;
                const next = workspace(book, nextId);
                const adopted = current.current;
                commit({ ...next, card: adopted.card, baseCard: adopted.baseCard, constraintsEditor: adopted.constraintsEditor });
              }
              if (job?.bookId === book.id && job.chapterId === operation.chapterId) { setJob(null); setPollError(false); }
              chapterDeleteFocusPending.current = true;
              setConfirm(null);
            }
            updateManagementAfterReceipt(book, operation); setNotice(t(noticeKey));
          });
          const addChapter = () => {
            const title = newChapter.trim();
            if (title && title.length <= 300) return mutateManagedChapter(manager?.snapshot, { action: 'addChapter', title }, 'chapterAdded');
          };
          const renameManagedChapter = (chapterId, title) => {
            const name = title.trim();
            if (name && name.length <= 300) return mutateManagedChapter(manager?.snapshot, { action: 'updateChapter', chapterId, patch: { title: name } }, 'chapterRenamed');
          };
          const moveManagedChapter = (chapterId, direction) => mutateManagedChapter(manager?.snapshot, { action: 'moveChapter', chapterId, direction }, 'chapterMoved');
          const requestChapterDeletion = (event, entry, number) => {
            if (busyRef.current || autosaveComposing.current || /[\r\n]/.test(entry.title)) return;
            const snapshot = manager?.snapshot, problem = managedChapterProblem(snapshot, true);
            if (problem) { setError({ message: t(problem === 'confirmChanged' ? 'manageStale' : problem) }); return; }
            chapterDeleteTrigger.current = event.currentTarget;
            setError(null);
            setConfirm({ title: t('deleteChapter'), body: t('chapterDeleteWarning'), label: t('deleteChapter'),
              chapterRemoval: { id: entry.id, title: entry.title, number, snapshot, history: entry.history.length,
                proposals: current.current.book.proposals.filter(item => item.chapterId === entry.id).length }, typedTitle: '', uncertain: false });
          };
          const confirmChapterDeletion = value => {
            const entry = value?.chapterRemoval;
            if (!entry || value.uncertain || entry.title !== value.typedTitle || autosaveComposing.current) return;
            return mutateManagedChapter(entry.snapshot, { action: 'deleteChapter', chapterId: entry.id, confirmTitle: value.typedTitle }, 'chapterDeleted');
          };
          const doImport = file => {
            if (!file) return;
            if (file.size > 40 * 1024 * 1024) { setError({ message: t('importTooLarge') }); return; }
            transition(() => withBusy(async () => {
              const text = await file.text();
              if (!alive.current) return;
              const book = await call('import', { text });
              if (!alive.current) return;
              epoch.current++; commit(workspace(book)); syncBookList(book); setJob(null); switchTab('writing'); assignRecovery(null); setConflict(null); resetSelection(); setNotice(t('imported'));
            }));
          };
          const exportBook = format => withBusy(async () => {
            const data = await call('export', { bookId: current.current.book.id, format });
            if (alive.current) download(data.filename, data.mime, data.text);
          });
          const renameManagedBook = () => withBusy(async () => {
            const problem = !bookIsAvailable(manager.snapshot.bookId, deletedBookIds, unavailableBooks.current) ? 'bookMissing' : managementProblem(current.current, manager.snapshot, recoveryRef.current, conflict);
            if (problem || manager.uncertain || uncertainDeletes.current.has(manager.snapshot.bookId)) throw new Error(t(problem || 'deleteUncertain'));
            const title = manager.title.trim();
            if (!title || title.length > 300 || title === manager.snapshot.title) return;
            const saved = await mutateRaw({ action: 'updateBook', patch: { title } });
            if (alive.current && saved) { setManager({ snapshot: managementSnapshot({ book: saved }), title: saved.title, typedTitle: '', uncertain: false }); setNotice(t('renamed')); }
          });
          // This follow-up has its own failure state: an acknowledged deletion
          // cannot become a "delete failed" error just because list/get failed.
          const refreshDeletedLibrary = async (report = null) => {
            const refreshed = await refreshAfterBookDeletion(refreshList, () => !!current.current, openBook);
            if (alive.current) setDeletionNotice(previous => {
              const state = report || previous;
              return state && (!refreshed || state.cleanupPending || state.localCleanupPending) ? { ...state, refreshFailed: !refreshed } : null;
            });
            return refreshed;
          };
          const deleteManagedBook = () => withBusy(async () => {
            const reviewed = manager.snapshot;
            const problem = !bookIsAvailable(reviewed.bookId, deletedBookIds, unavailableBooks.current) ? 'bookMissing' : deletionProblem(current.current, reviewed, manager.typedTitle, { recovery: recoveryRef.current, conflict, jobs: [job, ...liveJobs.current] });
            if (problem || manager.uncertain || uncertainDeletes.current.has(reviewed.bookId)) throw new Error(t(problem || 'deleteUncertain'));
            let result;
            try {
              result = await call('delete', { bookId: reviewed.bookId, expectedRevision: reviewed.revision, confirmTitle: manager.typedTitle });
            } catch (e) {
              if (['NETWORK', 'RESPONSE'].includes(e.code)) {
                uncertainDeletes.current.add(reviewed.bookId);
                if (alive.current) setManager(previous => previous && ({ ...previous, uncertain: true }));
                throw Object.assign(new Error(t('deleteUncertain')), { code: e.code });
              }
              if (e.code === 'BUSY' || e.code === 'CONFLICT') throw Object.assign(new Error(t(e.code === 'BUSY' ? 'deleteBusy' : 'confirmChanged')), { code: e.code });
              throw e;
            }
            if (!deletionReceipt(reviewed, result)) {
              uncertainDeletes.current.add(reviewed.bookId);
              if (alive.current) setManager(previous => previous && ({ ...previous, uncertain: true }));
              throw new Error(t('deleteUnconfirmed'));
            }
            const previous = { books, workspace: current.current, job, recovery: recoveryRef.current, selection: selectionRef.current, context,
              activeJobs: liveJobs.current, pendingLatest: pendingLatest.current, drafts: memoryDrafts, rememberedJobs: memoryJobs };
            const next = afterBookDeletion(previous, reviewed, result), id = reviewed.bookId;
            // Tombstone before clearing state so late list/get/poll/unmount work
            // cannot revive the deleted book or write its draft back to storage.
            uncertainDeletes.current.delete(id);
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
              setNewChapter(''); setInstruction(''); switchTab('writing');
            }
            setManager(null); setConfirm(null); setGuard(null);
            const refreshed = await refreshDeletedLibrary({ title: reviewed.title, cleanupPending: result.cleanupPending, localCleanupPending });
            if (alive.current && refreshed && !result.cleanupPending && !localCleanupPending) setNotice(t('deleted', { title: reviewed.title }));
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
            if (!validAutosaveRecovery(value, active.book.id)) { setError({ message: t('requestFailed') }); return; }
            const next = restoredAutosaveWorkspace(active, value);
            autosaveRef.current.restorePendingCard(value.pendingCard && !next.card?.id ? value.pendingCard : null, next.baseCard);
            commit(next); assignRecovery(null); resetSelection(); setNotice(t('recoveryRestored'));
            if (next.constraintsEditor?.error) {
              const end = textareaValue(next.constraintsEditor.text).length;
              constraintsFocusRef.current = { bookId: next.book.id, start: end, end };
              setConstraintsSourceBook(next.book.id); switchTab('constraints');
            }
            const fields = conflictingFields(next, active.book);
            setConflict(fields.length ? { book: active.book, fields } : null);
          };
          const chooseCandidate = id => transition(() => {
            const active = current.current, p = active.book.proposals.find(item => item.id === id && item.mode !== 'outline');
            if (p) { commit({ ...active, candidateId: p.id, candidate: p.text, baseCandidate: p.text }); if (job?.status !== 'running') setJob(null); }
          }, 'candidate');
          const chooseCard = id => {
            if (busyRef.current || loading || guard || confirm || recoveryRef.current || autosaveComposing.current) return;
            const stillRequested = navigationIntent();
            const active = current.current;
            if (active?.card && (active.card.id || null) === id) {
              (id === null ? cardTitleInput.current : cardBodyInput.current)?.focus(); return;
            }
            return transition(() => {
              if (!stillRequested() || recoveryRef.current) return;
              const latest = current.current;
              const card = id === null ? null : latest.book.cards.find(entry => entry.id === id);
              if (id !== null && !card) return;
              const value = card ? cardFields(card) : blankCard(categoryFilter(latest.book, cardFilter));
              cardFocusRequest.current = { bookId: latest.book.id, editor: true, newCard: id === null };
              commit({ ...latest, card: value, baseCard: value });
            }, 'card', stillRequested);
          };
          const changeCardCategory = category => {
            if (busyRef.current || loading || guard || confirm || recoveryRef.current || autosaveComposing.current) return;
            const active = current.current;
            if (!active?.card) return;
            const card = editCardCategory(active.card, active.book, category);
            if (card === active.card) return;
            commit({ ...active, card }); autosaveRef.current.schedule();
          };
          const createCardCategory = form => withBusy(async () => {
            const active = current.current, name = form?.name.trim(), serial = epoch.current;
            if (!name || name.length > 60 || form.bookId !== active?.book.id || recoveryRef.current || conflict) return;
            const bookId = active.book.id;
            const stillHere = () => alive.current && epoch.current === serial && current.current?.book.id === bookId;
            const category = { id: form.id || globalThis.crypto.randomUUID(), name };
            const setAttempt = problem => setCategoryForm(previous => previous?.bookId === bookId && previous.name.trim() === name
              ? { ...previous, id: category.id, problem } : previous);
            setAttempt('');
            let next;
            try {
              next = await call('mutate', { bookId, expectedRevision: active.book.revision, operation: { action: 'addCardCategory', category } });
              if (!categoryReceipt(active.book, next, category)) throw Object.assign(new Error(t('categoryReceipt')), { code: 'RESPONSE' });
            } catch (error) {
              if (!stillHere()) return;
              if (!['NETWORK', 'RESPONSE', 'CONFLICT', 'STORAGE', 'INTERNAL'].includes(error.code) && !(error.code === 'VALIDATION' && form.id)) {
                setAttempt(error.message || t('requestFailed')); return;
              }
              let latest;
              try { latest = await call('get', { bookId }); }
              catch { if (stillHere()) setAttempt(t('categoryReceipt')); return; }
              if (!stillHere()) return;
              if (latest?.id !== bookId || !categorySaved(latest, category)) {
                if (latest?.id === bookId && latest.revision > active.book.revision) adopt(latest);
                setAttempt(error.message || t('categoryReceipt')); return;
              }
              next = latest;
            }
            if (!stillHere() || !adopt(next)) return;
            if (!current.current.card) setCardFilter({ bookId, id: category.id });
            categoryFocusReturn.current = true; setCategoryForm(null); setNotice(t('categoryAdded'));
          });
          const closeCard = () => {
            const stillRequested = navigationIntent();
            return transition(() => {
              if (!stillRequested()) return;
              const active = current.current;
              cardFocusRequest.current = { bookId: active.book.id, id: active.card?.id || null };
              commit({ ...active, card: null, baseCard: null });
            }, 'card', stillRequested);
          };
          const confirmMutation = (title, body, operation, label, renderedSnapshot = null, onSaved) => {
            const reviewed = renderedSnapshot || reviewSnapshot(current.current, operation);
            if (!reviewIsCurrent(current.current, reviewed) || isDirty(current.current) || recoveryRef.current || conflict) { setError({ message: t('confirmChanged') }); return; }
            setConfirm({ title, body, label, run: () => withBusy(async () => {
              // A poll or another actor may have changed the saved candidate while
              // the confirmation was open. Never adopt a newer revision implicitly.
              if (!reviewIsCurrent(current.current, reviewed) || isDirty(current.current) || recoveryRef.current || conflict) throw Object.assign(new Error(t('confirmChanged')), { code: 'REVIEW_REQUIRED' });
              const saved = await mutateRaw(operation);
              if (alive.current && saved) { onSaved?.(saved); setConfirm(null); resetSelection(); setNotice(t('saved')); }
            }) });
          };

          const capturePolishReturn = snapshot => {
            const record = current.current?.book.proposals.find(p => p.id === snapshot.proposalId), block = polishBlockRef.current;
            if (!block || block.dataset.proposalId !== snapshot.proposalId || !rootRef.current?.contains(block)) return null;
            const position = node => ({ top: node?.scrollTop || 0, left: node?.scrollLeft || 0 });
            try { return captureReviewReturn(snapshot, record, { screenY: block.getBoundingClientRect().top, intent: returnIntent.current,
              root: position(contentRef.current), panel: position(panelRef.current), column: position(columnRef.current) }); } catch { return null; }
          };
          const queuePolishViewport = (snapshot, saved, accept, anchor) => {
            const record = saved.proposals.find(p => p.id === snapshot.proposalId), savedChapter = saved.chapters.find(c => c.id === snapshot.chapterId);
            if (!anchor || anchor.intent !== returnIntent.current || !savedChapter || record?.mode !== 'polish' || record.id !== anchor.proposalId) return;
            pendingPolishViewport.current = { anchor, proposalId: record.id, proposal: JSON.stringify(record), accept,
              expectedBody: savedChapter.body, chapter: JSON.stringify(savedChapter) };
            setRestoreEpoch(value => value + 1);
          };
          const applyPolish = (snapshot, accept) => {
            if (busyRef.current) return;
            // The visible Accept/Reject control is the explicit author decision. Bind the click to
            // exactly what was rendered, never silently save candidate edits first.
            const blocked = visibleReviewProblem(snapshot, reviewRef.current) || polishActionProblem(current.current, snapshot, { recovery: recoveryRef.current, conflict, accept,
              unavailable: !bookIsAvailable(snapshot?.bookId, deletedBookIds, unavailableBooks.current), busy: loading || !!manager || !!guard || !!confirm });
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
            if (busyRef.current) return;
            const options = () => ({ recovery: recoveryRef.current, conflict, accept,
              unavailable: !bookIsAvailable(snapshot?.bookId, deletedBookIds, unavailableBooks.current) });
            const blocked = visibleReviewProblem(snapshot, reviewRef.current) || generatedActionProblem(current.current, snapshot, { ...options(), busy: loading || !!manager || !!guard || !!confirm });
            if (blocked) { setError({ message: t(blocked) }); return; }
            return withBusy(async () => {
              const problem = visibleReviewProblem(snapshot, reviewRef.current) || generatedActionProblem(current.current, snapshot, options());
              if (problem) throw Object.assign(new Error(t(problem)), { code: 'REVIEW_REQUIRED' });
              const saved = await mutateRaw({ action: accept ? 'acceptProposal' : 'rejectProposal', proposalId: snapshot.proposalId });
              if (alive.current && saved) { setOriginalReviewKey(JSON.stringify([snapshot.bookId, snapshot.chapterId, snapshot.proposalId, 'generated'])); resetSelection(); setNotice(t('saved')); }
            });
          };

          const applyRevisionAll = snapshot => {
            if (busyRef.current) return;
            const options = () => ({ recovery: recoveryRef.current, conflict, unavailable: !bookIsAvailable(snapshot?.bookId, deletedBookIds, unavailableBooks.current) });
            const blocked = visibleReviewProblem(snapshot, reviewRef.current) || bulkRevisionProblem(current.current, snapshot, { ...options(), busy: loading || !!manager || !!guard || !!confirm });
            if (blocked) { setError({ message: t(blocked) }); return; }
            return withBusy(async () => {
              const problem = visibleReviewProblem(snapshot, reviewRef.current) || bulkRevisionProblem(current.current, snapshot, options());
              if (problem) throw Object.assign(new Error(t(problem)), { code: 'REVIEW_REQUIRED' });
              const saved = await mutateRaw({ action: 'acceptRevisionAll', proposalId: snapshot.proposalId });
              if (alive.current && saved) { setOriginalReviewKey(JSON.stringify([snapshot.bookId, snapshot.chapterId, snapshot.proposalId])); resetSelection(); setNotice(t('saved')); }
            });
          };

          const applyRevisionHunk = (snapshot, accept) => {
            if (busyRef.current) return;
            // The inline Accept button is itself explicit author confirmation. Capture the
            // reviewed identity at render time, not from a possibly newer book
            // when clicked, and never launch a second whole-proposal modal.
            const blocked = visibleReviewProblem(snapshot, reviewRef.current) || revisionActionProblem(current.current, snapshot, { recovery: recoveryRef.current, conflict, busy: loading || !!manager || !!guard || !!confirm });
            if (blocked) { setError({ message: t(blocked) }); return; }
            return withBusy(async () => {
              const problem = visibleReviewProblem(snapshot, reviewRef.current) || revisionActionProblem(current.current, snapshot, { recovery: recoveryRef.current, conflict });
              if (problem) throw Object.assign(new Error(t(problem)), { code: 'REVIEW_REQUIRED' });
              const saved = await mutateRaw({ action: accept ? 'acceptRevisionHunk' : 'rejectRevisionHunk', proposalId: snapshot.proposalId, hunkId: snapshot.hunkId });
              if (alive.current && saved) { resetSelection(); setNotice(t(accept ? 'revisionSaved' : 'revisionRejected')); }
            });
          };

          useEffect(() => {
            alive.current = true; autosaveRef.current?.activate();
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
              if (autosaveRef.current?.running || isDirty(autosaveRecoveryWorkspace(current.current, autosaveRef.current?.pendingSnapshot))) { e.preventDefault(); e.returnValue = ''; }
            };
            const pagehide = () => persist(current.current);
            window.addEventListener('beforeunload', leave); window.addEventListener('pagehide', pagehide);
            return () => {
              persist(current.current); autosaveRef.current?.dispose(); stopped = true; alive.current = false; epoch.current++; contextSequence.current++; listSequence.current++;
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
            const released = event => { if (document.activeElement === editorRef.current && event.target !== editorRef.current && !isFindControl(event.target) && !popupRef.current?.contains(event.target)) captureSelection(event); };
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
          useEffect(() => { persist(w); }, [w]);
          useEffect(() => {
            if (!autosaveBindings.current.paused(false) && autosaveStep(current.current)) autosaveRef.current.schedule();
          }, [busy, loading, recovery, conflict, guard, confirm, polishRequirements]);
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
                  try {
                    const latest = await call('get', { bookId }, controller.signal);
                    if (!stillValid()) return;
                    if (busyRef.current || autosaveRef.current?.running) queueLatest(latest);
                    else if (adopt(latest) && value.mode !== 'outline' && value.chapterId === current.current.chapterId && !isDirty(current.current) && !recoveryRef.current && !conflict) {
                      const p = latest.proposals.find(item => item.id === value.proposalId);
                      if (p) commit({ ...current.current, candidateId: p.id, candidate: p.text, baseCandidate: p.text });
                    }
                    if (latest.proposals.some(item => item.id === value.proposalId && item.chapterId === value.chapterId)) setNotice(t(value.mode === 'outline' ? 'outlineGenerated' : 'generationFinished'));
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

          const d = dirty(w), tabDirty = workspaceTabDirty(w), anyDirty = isDirty(w), chapter = chapterOf(w), selectedProposal = proposalOf(w);
          const displayRecord = generatedDisplayRecord(w, selectedProposal, job?.mode === 'outline' ? null : job, { recovery, conflict });
          const awaitingOutcome = displayRecord === job && !!job;
          const proposal = awaitingOutcome ? null : displayRecord;
          // Resolve the previous recovery copy before new typing can overwrite it.
          const locked = busy || loading || !!recovery, running = job?.status === 'running';
          const manageProblem = manager && (!bookIsAvailable(manager.snapshot.bookId, deletedBookIds, unavailableBooks.current) ? 'bookMissing' : managementProblem(w, manager.snapshot, recovery, conflict));
          const chapterOperationUncertain = !!w && uncertainChapterWrites.current.has(w.book.id);
          const deleteProblem = manager && (manageProblem || deletionProblem(w, manager.snapshot, manager.typedTitle, { recovery, conflict, jobs: [job, ...liveJobs.current] }));
          const modelDraftDirty = !!modelPrefs.settings && !sameModelSelection(modelPrefs.draft, modelPrefs.settings.selection);
          const modelProblem = modelGenerationProblem(modelPrefs, catalog, modelSaving);
          const catalogProblem = modelCatalogProblem(modelPrefs.draft, catalog);
          const modelControlsLocked = locked || modelSaving;
          const writingTaskModes = ['draft', 'revise'];
          // Older proposals and the selection popup still have their own modes.
          const modeKeys = { draft: 'modeDraft', continue: 'modeContinue', polish: 'modePolish', summary: 'modeSummary', revise: 'modeRevise', outline: 'chapterOutline' };
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
          // A decision must recheck the current review after waiting for autosave.
          // Its own busy lock disables controls, but does not invalidate that review.
          reviewRef.current = proposal ? { bookId: w.book.id, chapterId: w.chapterId, proposalId: proposal.id,
            visible: tab === 'writing' && (isRevision ? revisionPreviewVisible : isPolish ? polishPreviewVisible : generatedVisible),
            blocked: running || awaitingOutcome || loading || !!recovery || !!manager || !!guard || !!confirm || !!polishRequirements } : null;
          const bulkSnapshot = isRevision ? bulkRevisionSnapshot(w, proposal) : isPolish ? polishRenderedSnapshot : generatedActionSnapshot(w, proposal);
          const bulkOpts = { recovery, conflict, busy: locked || running || awaitingOutcome || !!guard || !!confirm };
          const bulkProblem = isRevision ? bulkRevisionProblem(w, bulkSnapshot, bulkOpts) : isPolish ? polishActionProblem(w, bulkSnapshot, bulkOpts) : generatedActionProblem(w, bulkSnapshot, bulkOpts);
          const bulkVisible = proposal?.state === 'ready' && !!bulkSnapshot;
          const bulkPreview = isRevision ? revisionPreviewVisible : isPolish ? polishPreviewVisible : generatedVisible;
          // Only exceptional blockers need a compact inline message; no edit/review mode banner.
          const inlineReviewProblem = proposal?.state === 'ready' && !bulkPreview && !(isRevision && revision && !revision.counts.pending)
            ? recovery ? 'manageRecovery' : anyDirty || conflict ? 'saveFirst' : isRevision && !revision ? 'revisionInvalid' : staleProposal(w, proposal) ? 'stale' : '' : '';
          const requirementMissing = mode === 'revise' && !instruction.trim();
          const previewKey = contextKey();
          const previewProblem = loading || busy ? 'loading' : !w ? 'chooseBookHint' : !chapter ? 'noChapters' :
            !bookIsAvailable(w.book.id, deletedBookIds, unavailableBooks.current) ? 'bookMissing' : recovery ? 'manageRecovery' :
              anyDirty || conflict ? 'saveFirst' : requirementMissing ? 'reviseRequirement' : '';
          useEffect(() => {
            contextSequence.current++; setContext(null); setContextError(null); setContextBusy(false);
            if (tab !== 'context' || previewProblem) return;
            const controller = new AbortController();
            void previewContext(controller.signal);
            return () => { contextSequence.current++; controller.abort(); };
          }, [tab, previewKey, previewProblem, contextRefresh]);
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
            const ports = { root: contentRef.current, panel: panelRef.current, column: columnRef.current };
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
          const toolbarButton = (name, label, onClick, { key, dirty = false, className = '', title = label, ...props } = {}) => h('span', { key, className: 'mx-toolbar-hit', title },
            button(h(React.Fragment, null,
              h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65,
                strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' }, h('path', { d: toolbarIcons[name] })),
              dirty && h('span', { className: 'mx-toolbar-dot', 'aria-hidden': true })),
            onClick, { className: 'mx-toolbar-button ' + className, 'aria-label': dirty ? t('savedTabsDirty', { page: label }) : label, ...props }));
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
          const renderReport = (data, heading = 'contextTitle') => data && h('section', { className: 'mx-subpanel mx-stack' }, h('h3', null, t(heading)),
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
              !revision.pieces.some(piece => piece.kind === 'hunk') && h('p', { className: 'mx-hint', role: 'status' }, t('revisionNoChanges')),
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
          const titleKey = chapter ? w.book.id + ':' + chapter.id : '', titleOpen = !!titleKey && chapterTitleFor === titleKey;
          const titleId = formId.current + '-chapter-title';
          const closeTitleEditor = () => { if (!autosaveComposing.current) { setChapterTitleFor(''); chapterTitleButtonRef.current?.focus({ preventScroll: true }); } };
          const renderChapterPicker = () => h(Field, { label: t('chaptersToggle'), visuallyHidden: true },
            h('select', { value: w.chapterId, disabled: locked || !chapter, title: w.chapter?.title || t('noChapters'), onChange: e => changeChapter(e.target.value) },
              !chapter && h('option', { value: '' }, t('noChapters')),
              w.book.chapters.map((c, i) => h('option', { key: c.id, value: c.id }, (i + 1) + '. ' + (c.id === chapter?.id ? w.chapter?.title || c.title : c.title) + (c.status === 'final' ? ' · ' + t('final') : '')))));
          const renderTitleControl = () => toolbarButton('title', t(titleOpen ? 'closeTitleEditor' : 'editChapterTitle'), () => {
            if (titleOpen) closeTitleEditor();
            else if (!autosaveComposing.current) setChapterTitleFor(titleKey);
          }, { ref: chapterTitleButtonRef, disabled: locked || polishPreviewVisible || revisionPreviewVisible, 'aria-expanded': titleOpen, 'aria-controls': titleId });
          const renderEditor = () => {
            return h('section', { ref: panelRef, className: 'mx-panel mx-stack mx-editor-panel', 'aria-label': t('manuscript') },
            !folded && h('div', { key: 'chapter-bar', className: 'mx-chapter-bar' },
              h('div', { className: 'mx-chapter-meta' }, badge(t('revision', { number: chapter.revision })), status(t('chars', { count: w.chapter.body.length })))),
            h('div', { key: 'chapter-title', id: titleId, hidden: !titleOpen }, titleOpen && h(Field, { label: t('chapterTitle') }, input('chapter', 'title', {
              autoFocus: true, maxLength: 300, onKeyDown: e => {
                if (e.key === 'Escape' && !e.isComposing && !e.nativeEvent?.isComposing && !autosaveComposing.current) closeTitleEditor();
              },
            }))),
            h('div', { key: 'manuscript', className: 'mx-body-slot' }, inlineReviewProblem && h('p', { className: 'mx-hint', role: 'status', style: { flex: 'none' } }, t(inlineReviewProblem)), polishPreviewVisible ? renderPolishPreview() : revisionPreviewVisible ? renderRevisionPreview() : generatedManuscript ? renderGeneratedPreview() : h(Field, { label: t('manuscript'), visuallyHidden: true }, textarea('chapter', 'body', {
              ref: editorRef, className: 'mx-editor', rows: 22, spellCheck: true,
              onSelect: captureSelection, onMouseUp: captureSelection, onKeyUp: captureSelection, onBlur: captureSelection,
              onKeyDown: e => { if (e.key === 'Escape') closeSelectionPopup(); if (e.key === 'Tab' && !e.shiftKey && selectionPopup) { const first = popupRef.current?.querySelector('button:not(:disabled)'); if (first) { e.preventDefault(); first.focus({ preventScroll: true }); } } },
               onCompositionStart: () => { composing.current = true; closeSelectionPopup(); }, onCompositionEnd: () => { composing.current = false; captureSelection(); },
            }))));
          };
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
            h('section', { hidden: folded, id: formId.current + '-writing-task', className: 'mx-writing-partner', 'aria-label': t('ai') },
              h('div', { className: 'mx-partner-row' },
                h(Field, { label: t('mode') }, h('select', { value: mode, disabled: locked, onChange: e => { if (writingTaskModes.includes(e.target.value)) setMode(e.target.value); } },
                  writingTaskModes.map(value => h('option', { key: value, value }, t(modeKeys[value]))))),
                h(Field, { label: t('instruction') }, h('textarea', { value: instruction, disabled: locked, rows: 2, maxLength: 60000, placeholder: t(mode === 'revise' ? 'revisePlaceholder' : 'instructionPlaceholder'), onChange: e => setInstruction(e.target.value) }))),
              h('div', { className: 'mx-partner-meta' },
                h('span', { className: 'mx-hint mx-partner-model', title: modelDescription(model) || t('noModel') }, modelDescription(model) || t('noModel')),
                 button(t('chapterOutline'), () => openChapterOutline(w.chapterId, 'writing'), { className: 'mx-outline-entry', 'data-mx-outline-chapter': w.chapterId, title: t('outlineHint'), disabled: locked }),
                proposalsFor(w.book, w.chapterId).length > 0 && h('label', { className: 'mx-result-chooser mx-hint' }, t('results'), h('select', { 'aria-label': t('results'), value: proposal?.id || w.candidateId, disabled: locked || running || awaitingOutcome, onChange: e => chooseCandidate(e.target.value) }, proposalsFor(w.book, w.chapterId).map(p => h('option', { key: p.id, value: p.id }, t(modeKeys[p.mode]) + ' · ' + t(p.state) + ' · ' + formatDate(p.createdAt))))),
                anyDirty && h('span', { className: 'mx-hint' }, t('saveFirst')),
                modelProblem && h('span', { className: 'mx-hint', role: 'status' }, t(modelProblem)),
                mode === 'revise' && requirementMissing && h('span', { className: 'mx-hint' }, t('reviseRequirement')))),
            // Only a saved/streamed summary proposal is shown here, never a second editor.
            generatedVisible && displayRecord.mode === 'summary' && renderGeneratedPreview(),
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
                button(t('discardResultEdits'), () => setConfirm({ title: t('confirmDiscard'), body: t('unsavedHint'), label: t('discardResultEdits'), run: async () => { if (await discardScope('candidate')) setConfirm(null); } }), { className: 'mx-danger' }))),
            isRevision && proposal.state === 'ready' && h('div', { className: 'mx-actions mx-result-tools' },
              button(t(revision && !proposal.review.hunks.length ? 'revisionDismissEmpty' : 'revisionRejectRemaining'), () => confirmMutation(t('rejectTitle'), t('revisionRejectHint'), { action: 'rejectProposal', proposalId: proposal.id }, t('reject'), reviewSnapshot(w, { proposalId: proposal.id })), { disabled: locked || anyDirty || !!conflict })));
          const constraintsHelpId = formId.current + '-constraints-guide';
          const constraintsHelpBlocked = !!(error || guard || confirm || manager || polishRequirements || recovery);
          const constraintsHelpOpen = !constraintsHelpBlocked && tab === 'constraints' && !!w && constraintsHelpBook === w.book.id;
          const closeConstraintsHelp = () => setConstraintsHelpBook('');
          useEffect(() => {
            if (constraintsHelpBook && !constraintsHelpOpen) setConstraintsHelpBook('');
          }, [constraintsHelpBook, constraintsHelpOpen]);
          const renderConstraints = () => {
            const rows = w.settings.writingConstraints, bookId = w.book.id, editor = w.constraintsEditor;
            const raw = constraintsSourceBook === bookId, enabled = rows.filter(row => row.enabled).length;
            const modeLabelId = formId.current + '-constraints-mode', hintId = formId.current + '-constraints-hint';
            const errorId = formId.current + '-markdown-error', editorId = formId.current + '-constraints-editor';
            const limit = constraintsLimit === bookId;
            const readOnly = locked || !!confirm || !!guard;
            const projection = constraintsProjection;
            const cursor = constraintsCursor?.bookId === bookId ? constraintsCursor : { anchor: 0, head: 0 };
            const lower = Math.min(cursor.anchor, cursor.head), upper = Math.max(cursor.anchor, cursor.head);
            const logical = constraintsOffsets;
            const selectedRule = projection?.rules.find(rule => lower >= logical(rule.lineStart) && upper <= logical(rule.end));
            const selectedGroup = selectedRule ? projection?.groups.find(group => group.ids.includes(selectedRule.id)) :
              projection?.groups.find(group => lower >= logical(group.lineStart) && upper <= logical(group.end));
            const row = selectedRule && rows.find(item => item.id === selectedRule.id);
            const structuralDisabled = readOnly || !!editor.error;
            const getDraft = () => current.current?.book.id === bookId ? constraintsHistorySnapshot(current.current) : null;
            const options = {
              raw, readOnly, invalid: !!editor.error, label: t('constraintsTextEditor'), placeholder: t('constraintsPlaceholder'),
              describedBy: hintId + (editor.error || limit ? ' ' + errorId : ''), getDraft,
              acceptInput: update => acceptConstraintInput(bookId, update),
              onInput: update => changeConstraintsMarkdown(bookId, update) && getDraft(),
              onSelection: ({ anchor, head }) => setConstraintsCursor(old => old?.bookId === bookId && old.anchor === anchor && old.head === head ? old : { bookId, anchor, head }),
              onLimit: () => setConstraintsLimit(bookId), editKey: constraintsDocumentKey,
              beginComposition: () => { autosaveComposing.current = true; },
              releaseComposition: () => { autosaveComposing.current = false; autosaveRef.current.schedule(); },
            };
            const focusTarget = (next, kind, id, select = false) => {
              const text = next.constraintsEditor.text;
              const targets = constraintVisualTargets(text, next.settings.writingConstraints, null);
              const slice = (kind === 'category' ? targets?.groups : targets?.rules)?.find(target => target.id === id);
              if (!slice) return;
              const start = textareaValue(text.slice(0, slice.start)).length;
              constraintsFocusRef.current = { bookId, start, end: select ? textareaValue(text.slice(0, slice.end)).length : start };
            };
            const addConstraint = (category, afterId, kind) => {
              if (constraintsInputBlocked() || autosaveComposing.current || current.current?.book.id !== bookId) return;
              const before = new Set(current.current.settings.writingConstraints.map(item => item.id));
              const next = changeWritingConstraint(bookId, { type: 'add', category, content: t('newConstraint'), afterId });
              const added = next?.settings.writingConstraints.find(item => !before.has(item.id));
              if (added) focusTarget(next, kind, added.id, true);
            };
            const addCategory = () => {
              if (current.current?.book.id !== bookId) return;
              const latestRows = current.current.settings.writingConstraints, categories = new Set(latestRows.map(item => item.category));
              const base = t('newConstraintCategory'); let category = base, index = 2;
              while (categories.has(category)) category = base.slice(0, 72) + ' ' + index++;
              addConstraint(category, latestRows.at(-1)?.id, 'category');
            };
            const ruleSummary = value => Array.from(textareaValue(value.content).split('\n')[0]).slice(0, 72).join('');
            const requestRemove = row => {
              if (constraintsInputBlocked() || autosaveComposing.current) return;
              const snapshot = getDraft();
              if (!snapshot || snapshot.error || !snapshot.rows.some(item => item.id === row.id)) return;
              setConfirm({ title: t('constraintsDeleteTitle'), body: t('constraintsDeleteHint') + ' ' + row.category + ' — ' + ruleSummary(row), label: t('constraintsRemove'), run: () => {
                if (!sameConstraintsDraft(snapshot, getDraft())) { setError({ message: t('confirmChanged') }); return; }
                const latestRows = current.current.settings.writingConstraints, index = latestRows.findIndex(item => item.id === row.id);
                const fallback = latestRows[index + 1] || latestRows[index - 1];
                const next = changeWritingConstraint(bookId, { type: 'remove', id: row.id }, { confirmed: true });
                if (next) {
                  if (fallback) focusTarget(next, 'rule', fallback.id);
                  else constraintsFocusRef.current = { bookId, add: true };
                }
                setConfirm(null);
              } });
            };
            const toggleRaw = () => {
              if (!constraintsInputBlocked() && !autosaveComposing.current && current.current?.book.id === bookId) setConstraintsSourceBook(raw ? '' : bookId);
            };
            const activeName = row ? ruleSummary(row) : selectedGroup?.category;
            const targetLabelId = formId.current + '-constraints-current';
            return h('section', { className: 'mx-panel mx-stack', 'aria-label': t('constraints') },
              h('h2', null, t('constraints')),
              h('p', { className: 'mx-hint' }, t('constraintsHint')),

              h('section', { className: 'mx-subpanel mx-constraints-document mx-stack', 'data-mode': raw ? 'source' : 'continuous', 'aria-labelledby': modeLabelId },
                h('div', { className: 'mx-row mx-row-between' },
                  h('h3', { id: modeLabelId }, t('constraintsTextEditor')),
                  h('div', { className: 'mx-actions', role: 'group', 'aria-label': t('constraints') },
                    button(t('constraintsWriteRules'), () => {
                      if (!constraintsHelpBlocked && !autosaveComposing.current && current.current?.book.id === bookId) setConstraintsHelpBook(bookId);
                    }, { ref: constraintsHelpTrigger, disabled: constraintsHelpBlocked, 'aria-haspopup': 'dialog', 'aria-controls': constraintsHelpOpen ? constraintsHelpId : undefined }),
                    button(t('constraintsAddCategory'), addCategory, { ref: constraintsAddRef, disabled: structuralDisabled || rows.length >= 64 }),
                    button(t(raw ? 'constraintsHideSource' : 'constraintsShowSource'), toggleRaw, { disabled: readOnly, 'aria-controls': editorId }))),
                h('p', { className: 'mx-hint', id: hintId }, t(raw ? 'constraintsLiteralHint' : 'constraintsContinuousHint')),
                limit || editor.error ? h('p', { className: 'mx-hint mx-constraints-error', id: errorId, role: 'status' }, t(limit ? 'constraintsMarkdownTooLong' : editor.error)) : null,
                h('div', { id: editorId }, h(ConstraintsTextSurface, { key: bookId, bookId, draft: constraintsHistorySnapshot(w), options,
                  focusRef: constraintsFocusRef, addRef: constraintsAddRef, viewport: constraintsViewport, owner: constraintsEngine })),
                h('div', { className: 'mx-row mx-row-between mx-constraints-status' },
                  !editor.error && h('p', { className: 'mx-hint' }, t('constraintsCount', { total: rows.length, enabled, disabled: rows.length - enabled })),
                  h('div', { className: 'mx-actions mx-constraints-actions', role: 'group', 'aria-label': t('constraintsCurrentActions') },
                    h('span', { id: targetLabelId, className: 'mx-hint mx-constraints-current', title: activeName }, activeName || t('constraintsPlaceCaret')),
                    button(t('constraintsAddRule'), () => { if (selectedGroup && sameConstraintsDraft(constraintsHistorySnapshot(w), getDraft())) addConstraint(selectedGroup.category, selectedGroup.ids.at(-1), 'rule'); }, { disabled: structuralDisabled || !selectedGroup || rows.length >= 64, 'aria-describedby': targetLabelId }),
                    h('label', { className: 'mx-check' }, h('input', { type: 'checkbox', checked: !!row?.enabled, disabled: structuralDisabled || !row, 'aria-describedby': targetLabelId,
                      onChange: event => { if (row && sameConstraintsDraft(constraintsHistorySnapshot(w), getDraft())) changeWritingConstraint(bookId, { type: 'edit', id: row.id, field: 'enabled', value: event.target.checked }); } }), t('constraintsEnabled')),
                    button(t('constraintsRemove'), () => { if (row && sameConstraintsDraft(constraintsHistorySnapshot(w), getDraft())) requestRemove(row); }, { className: 'mx-danger', disabled: structuralDisabled || !row, 'aria-describedby': targetLabelId })))));
          };
          const renderSettings = () => h('section', { className: 'mx-panel mx-stack' }, h('h2', null, t('settings')), h('p', { className: 'mx-hint' }, t('projectHint')),
            h('div', { className: 'mx-row' }, h('strong', null, t('bookTitle') + ': ' + w.book.title), button(t('manageBooks'), () => navigatePage('manage'), { disabled: busy || loading })),
            h(Field, { label: t('premise') }, textarea('settings', 'premise', { rows: 4 })),
            h(Field, { label: t('outline') }, textarea('settings', 'outline', { rows: 10 })),
            h(Field, { label: t('style') }, textarea('settings', 'style', { rows: 5 })),
            h(Field, { label: t('contextBudget'), hint: t('contextNote') }, input('settings', 'contextBudget', { type: 'number', min: 1000, max: 60000, step: 1 })),
            h('details', { className: 'mx-subpanel' }, h('summary', null, t('maintenance')), h('div', { className: 'mx-stack' }, h('p', { className: 'mx-hint' }, t('pruneHint')),
              h('div', { className: 'mx-actions' }, button(t('openBackupTools'), () => navigatePage('tools')), button(t('prune'), () => transition(() => confirmMutation(t('pruneTitle'), t('pruneHint'), { action: 'pruneArchive' }, t('prune'))), { className: 'mx-danger' })))));
          const requestCardRemoval = id => {
            if (busyRef.current || loading || guard || confirm || recoveryRef.current || autosaveComposing.current) return;
            const stillRequested = navigationIntent();
            return transition(() => {
              const active = current.current, card = active.book.cards.find(entry => entry.id === id);
              if (!stillRequested() || active.card?.id !== id || !card) return;
              const filter = categoryFilter(active.book, cardFilter);
              const index = Math.max(0, cardsInCategory(active.book.cards, filter).findIndex(entry => entry.id === id));
              confirmMutation(t('removeTitle'), t('removeHint') + '\n' + card.title,
                { action: 'removeCard', cardId: id }, t('removeCard'), null, saved => {
                  const remaining = cardsInCategory(saved.cards, filter);
                  cardFocusRequest.current = { bookId: saved.id, id: (remaining[index] || remaining[index - 1])?.id || (filter ? id : null) };
                });
            }, 'all', stillRequested);
          };
          const renderCards = () => {
            const card = w.card, editing = !!card, editedCard = card?.id && w.book.cards.find(entry => entry.id === card.id);
            const filter = categoryFilter(w.book, cardFilter), form = categoryForm?.bookId === w.book.id ? categoryForm : null;
            const categories = [...cardKinds.map(id => ({ id, name: t(id) })), ...(w.book.cardCategories || [])];
            const names = new Map(categories.map(({ id, name }) => [id, name]));
            const options = () => categories.map(({ id, name }) => h('option', { key: id, value: id }, name));
            const visibleCards = cardsInCategory(w.book.cards, filter);
            const categoryLocked = locked || !!conflict || !!recovery || !!guard || !!confirm;
            const invalid = d.card && (!cardRange(card) ? 'invalidScope' :
              !autosaveStep({ book: w.book, settings: {}, baseSettings: {}, card, baseCard: w.baseCard }) ? 'autosaveIncomplete' : '');
            const editId = formId.current + '-card-editor';
            return h('section', { className: 'mx-stack mx-cards-page', 'data-editing': editing },
              h('div', { className: 'mx-row mx-row-between' }, h('h2', null, t('cards')),
                h('div', { className: 'mx-actions' },
                  button(t('cardCategoryNew'), () => setCategoryForm({ bookId: w.book.id, name: '', id: '' }), { ref: categoryAddRef, disabled: categoryLocked || !!form || (w.book.cardCategories?.length || 0) >= 128 }),
                  button(t('newCard'), () => chooseCard(null), { className: 'mx-primary mx-card-new', ref: cardNewButton }))),
              form && h('div', { className: 'mx-card-category-form', 'aria-label': t('cardCategoryNew'), role: 'group' },
                h(Field, { label: t('cardCategoryName') }, h('input', { ref: categoryNameRef, value: form.name, maxLength: 60, disabled: categoryLocked, 'aria-invalid': !!form.problem,
                  'aria-describedby': form.problem ? formId.current + '-category-error' : undefined,
                  onChange: event => { const name = event.target.value; setCategoryForm({ ...form, name, id: name.trim() === form.name.trim() ? form.id : '', problem: '' }); } })),
                h('div', { className: 'mx-actions' },
                  button(t('cancel'), () => { categoryFocusReturn.current = true; setError(null); setCategoryForm(null); }),
                  button(t('cardCategoryNew'), () => createCardCategory(form), { className: 'mx-primary', disabled: categoryLocked || !form.name.trim() })),
                form.problem && h('p', { className: 'mx-card-category-error mx-hint', id: formId.current + '-category-error', role: 'alert' }, form.problem)),
              h('div', { className: 'mx-cards', 'data-editing': editing },
                h('div', { className: 'mx-card-browser' },
                  h('div', { className: 'mx-card-filter' }, h(Field, { label: t('cardCategory'), visuallyHidden: true },
                    h('select', { ref: categoryFilterRef, value: filter, disabled: busy || loading || !!guard || !!confirm,
                      onChange: event => { navigationIntent(); setCardFilter({ bookId: w.book.id, id: event.target.value }); } },
                    h('option', { value: '' }, t('cardCategoryAll')), options()))),
                  !visibleCards.length ? h('p', { className: 'mx-hint' }, t(filter ? 'cardCategoryEmpty' : 'noCards')) :
                    h('ul', { className: 'mx-card-list', 'aria-label': t('cardList') }, visibleCards.map(entry => {
                      const selected = card?.id === entry.id;
                      const metadata = [t('cardKindStatus', { kind: names.get(cardCategory(entry)) || t(entry.kind), status: t(entry.status) }),
                        entry.toChapter === null ? t('cardOpenRange', { from: entry.fromChapter }) : t('range', { from: entry.fromChapter, to: entry.toChapter }),
                        entry.pinned ? t('cardPinnedShort') : ''].filter(Boolean).join(' · ');
                      return h('li', { key: entry.id, className: 'mx-card-item' },
                        button(h(React.Fragment, null, h('strong', { className: 'mx-card-name', title: entry.title }, entry.title),
                          h('span', { className: 'mx-card-labels' }, metadata),
                          entry.content.trim() && h('span', { className: 'mx-card-excerpt' }, entry.content.trim().slice(0, 250))),
                          () => chooseCard(entry.id), { className: 'mx-card-pick', 'aria-current': selected ? 'true' : undefined,
                            'aria-controls': selected ? editId : undefined,
                            ref: node => { if (node) cardButtons.current.set(entry.id, node); else cardButtons.current.delete(entry.id); } }));
                    }))),
                editing && h('section', { id: editId, className: 'mx-panel mx-card-editor', 'aria-label': t(editedCard ? 'cardPick' : 'newCard', { title: editedCard?.title }) },
                  h('div', { className: 'mx-card-editor-head' }, h('h3', null, t(editedCard ? 'cardPick' : 'newCard', { title: editedCard?.title })),
                    button(t('cardBack'), closeCard)),
                  h(Field, { label: t('cardTitle') }, input('card', 'title', { maxLength: 300, ref: cardTitleInput })),
                  h('div', { className: 'mx-card-type-fields' },
                    h(Field, { label: t('cardCategory') }, h('select', { value: card.categoryId || '', disabled: categoryLocked, onChange: event => changeCardCategory(event.target.value) },
                      h('option', { value: '' }, t('cardCategoryByKind', { kind: t(card.kind) })), options())),
                    h(Field, { label: t('cardContextKind') }, select('card', 'kind', cardKinds)),
                    h(Field, { label: t('cardStatus') }, select('card', 'status', ['proposed', 'confirmed']))),
                  h(Field, { label: t('cardContent') }, textarea('card', 'content', { rows: 8, maxLength: 50000, ref: cardBodyInput, className: 'mx-card-body' })),
                  h('div', { className: 'mx-card-meta-fields' },
                    h(Field, { label: t('cardFrom') }, input('card', 'fromChapter', { type: 'number', min: 1, step: 1 })),
                    h(Field, { label: t('cardThrough') }, input('card', 'toChapter', { type: 'number', min: 1, step: 1, placeholder: t('cardNoEnd') })),
                    h(Field, { label: t('tags') }, input('card', 'tags'))),
                  h('div', { className: 'mx-row mx-row-between' },
                    h('label', { className: 'mx-check' }, h('input', { type: 'checkbox', checked: card.pinned, disabled: locked, onChange: e => changeField('card', 'pinned', e.target.checked) }), t('pin')),
                    h('details', { className: 'mx-hint' }, h('summary', null, t('cardChapterRange')), h('p', null, t('canonHint')))),
                  invalid && h('p', { className: 'mx-hint', role: 'status' }, t(invalid)),
                  h('div', { className: 'mx-actions' },
                    button(t('save'), saveAll, { className: 'mx-primary', disabled: locked || !(d.card || autosaveRef.current?.failed) || invalid || !!conflict }),
                    editedCard && button(t('removeCard'), () => requestCardRemoval(editedCard.id), { className: 'mx-danger' })))));
          };
          const renderHistory = () => h('section', { className: 'mx-panel mx-stack mx-history-surface' }, h('h2', null, t('history')), h('p', { className: 'mx-hint' }, t('historyHint')),
            !chapter ? h('p', null, t('noChapters')) : !chapter.history.length ? h('p', { className: 'mx-hint' }, t('noHistory')) : chapter.history.slice().reverse().map(item => h('details', { key: item.id, className: 'mx-subpanel' },
              h('summary', null, t('revision', { number: item.revision }) + ' · ' + formatDate(item.createdAt)), h('div', { className: 'mx-stack' }, h('p', { className: 'mx-hint' }, item.reason), h('pre', null, item.body || t('empty')),
                button(t('restore'), () => transition(() => confirmMutation(t('restoreTitle'), t('restoreHint'), { action: 'restoreChapter', chapterId: chapter.id, historyId: item.id }, t('restore'))), { className: 'mx-danger' })))));
          const renderConflict = () => {
            if (!conflict || !w) return null;
            const latest = conflict.book, local = autosaveRecoveryPayload(w, autosaveRef.current || {}), remote = {};
            const orphaned = missingChapterDraft(latest, local);
            if (d.chapter) remote.chapter = chapterFields(latest.chapters.find(c => c.id === w.chapterId));
            if (d.settings) remote.settings = bookFields(latest);
            if (d.card) remote.card = cardFields(latest.cards.find(c => c.id === w.card?.id));
            if (d.candidate) remote.candidate = latest.proposals.find(p => p.id === w.candidateId) || null;
            return h('section', { className: 'mx-banner mx-error mx-stack', role: 'alert' }, h('h3', null, t('conflictTitle')), h('p', { className: 'mx-hint' }, t(orphaned ? 'chapterMissingDraft' : 'conflictHint')),
              h('details', { open: true }, h('summary', null, t('compare')), h('div', { className: 'mx-compare' },
                h('div', null, h('h3', null, t('localChanges')), h('pre', null, JSON.stringify(local, null, 2))), h('div', null, h('h3', null, t('latestSaved')), h('pre', null, JSON.stringify(remote, null, 2))))),
              h('div', { className: 'mx-actions' }, button(t('downloadLocal'), downloadLocal), button(t('reviewLatest'), inspectConflict),
                button(t('rebase'), () => {
                  if (missingChapterDraft(latest, autosaveRecoveryPayload(current.current, autosaveRef.current || {}))) { setError({ message: t('chapterMissingDraft') }); return; }
                  if (d.candidate && latest.proposals.find(p => p.id === w.candidateId)?.state !== 'ready') { setError({ message: t('rebaseUnavailable') }); return; }
                  setConfirm({ title: t('rebaseTitle'), body: t('rebaseHint'), label: t('rebase'), run: () => {
                    if (missingChapterDraft(latest, autosaveRecoveryPayload(current.current, autosaveRef.current || {}))) { setError({ message: t('chapterMissingDraft') }); return; }
                    commit(mergeWorkspace(current.current, latest, null, true)); setConflict(null); setConfirm(null); setError(null); setNotice(t('localOnly')); } });
                }, { disabled: locked || orphaned }), button(t('refresh'), () => transition(() => openBook(w.book.id, w.chapterId)))));
          };
          const renderCreate = () => h('div', { className: 'mx-row' }, h('div', { className: 'mx-grow' }, h(Field, { label: t('newBookTitle') }, h('input', { value: newTitle, maxLength: 300, disabled: locked, onChange: e => setNewTitle(e.target.value) }))), button(t('createBook'), create, { className: 'mx-primary', disabled: locked || !newTitle.trim() }));
          const renderImport = () => h(Field, { label: t('import'), hint: t('importHint') }, h('input', { type: 'file', accept: '.json,application/json', disabled: locked, onChange: e => { const file = e.target.files?.[0]; e.target.value = ''; doImport(file); } }));

          const taskId = formId.current + '-writing-task', pageHeadingId = formId.current + '-page-heading';
          const renderBookPicker = () => h(Field, { label: t('book'), visuallyHidden: true },
            h('select', { value: w?.book.id || '', disabled: locked, title: w?.settings.title, onChange: e => selectBook(e.target.value) },
              h('option', { value: '', disabled: true }, t('chooseBook')),
              w && !books.some(b => b.id === w.book.id) && h('option', { value: w.book.id, disabled: true }, t('bookUnavailable', { title: w.book.title })),
              books.map(b => h('option', { key: b.id, value: b.id }, t('bookOption', { title: b.title, count: b.chapterCount, id: b.id.slice(0, 8) })))));
          const renderUtilityPage = (title, ...children) => h('section', { className: 'mx-panel mx-stack mx-utility-page', 'aria-labelledby': pageHeadingId },
            h('h2', { id: pageHeadingId, ref: utilityHeadingRef, tabIndex: -1 }, t(title)), ...children);
          const renderBookTools = () => renderUtilityPage('workspaceTools',
            h('section', { className: 'mx-subpanel mx-stack' }, h('h3', null, t('createBook')), renderCreate(), renderImport()),
            w ? h(React.Fragment, null,
              h('section', { className: 'mx-subpanel mx-stack' }, h('p', { className: 'mx-hint' }, t('exportHint')),
                h('div', { className: 'mx-actions' }, button(t('exportJson'), () => exportBook('json')), button(t('exportMarkdown'), () => exportBook('markdown')), anyDirty && button(t('downloadLocal'), downloadLocal)))) :
              h('p', { className: 'mx-hint' }, t('chooseBookHint')));
          const renderChapterManagement = () => {
            const disabled = locked || !!manageProblem || !!manager.uncertain || chapterOperationUncertain;
            const structural = managedChapterProblem(manager.snapshot, true);
            const id = formId.current + '-chapter-management';
            return h('section', { className: 'mx-subpanel mx-stack', 'aria-labelledby': id },
              h('h3', { id, ref: chapterManagementHeading, tabIndex: -1 }, t('chapterManagement')),
              h('div', { className: 'mx-chapter-add-row' },
                h(Field, { label: t('newChapterTitle') }, h('input', { ref: addChapterInputRef, value: newChapter, maxLength: 300, disabled, onChange: e => setNewChapter(e.target.value) })),
                button(t('addChapter'), addChapter, { disabled: disabled || !newChapter.trim() || w.book.chapters.length >= 2000 })),
              h('p', { className: 'mx-hint' }, t('chapterStructureHint')),
              structural === 'chapterStructureBusy' && h('p', { className: 'mx-hint', role: 'status' }, t(structural)),
              !w.book.chapters.length ? h('p', { className: 'mx-hint' }, t('noChapters')) : h('ol', { className: 'mx-chapter-list mx-stack' }, w.book.chapters.map((entry, i) => {
                const edit = manager.chapterEdit?.id === entry.id ? manager.chapterEdit : null;
                const multiline = /[\r\n]/.test(entry.title);
                const props = (action, options = {}) => ({ 'aria-label': t('chapterAction', { number: i + 1, title: entry.title, action: t(action) }), ...options });
                return h('li', { key: entry.id, className: 'mx-stack' },
                  h('div', { className: 'mx-row' }, h('strong', null, (i + 1) + '. ' + entry.title), badge(t(entry.status)), w.chapterId === entry.id && badge(t('chapterCurrent'))),
                  h('div', { className: 'mx-actions' },
                    button(t('openChapter'), () => openManagedChapter(entry.id), props('openChapter', { disabled: locked })),
                    button(t('chapterOutline'), () => openChapterOutline(entry.id, 'manage'), props('chapterOutline', { 'data-mx-outline-chapter': entry.id, disabled: locked })),
                    button(t('renameChapter'), () => setManager(previous => ({ ...previous, chapterEdit: edit ? null : { id: entry.id, title: multiline ? '' : entry.title } })), props('renameChapter', { 'aria-expanded': !!edit, disabled })),
                    button(t('chapterUp'), () => moveManagedChapter(entry.id, 'up'), props('chapterUp', { disabled: disabled || !!structural || i === 0 })),
                    button(t('chapterDown'), () => moveManagedChapter(entry.id, 'down'), props('chapterDown', { disabled: disabled || !!structural || i === w.book.chapters.length - 1 })),
                    button(t('deleteChapter'), event => requestChapterDeletion(event, entry, i + 1), props('deleteChapter', { className: 'mx-danger', 'aria-haspopup': 'dialog', disabled: disabled || !!structural || multiline }))),
                  multiline && h('p', { className: 'mx-hint' }, t('chapterDeleteMultiline')),
                  edit && h('div', { className: 'mx-row' }, h('div', { className: 'mx-grow' }, h(Field, { label: t('chapterTitle') }, h('input', { autoFocus: true, value: edit.title, maxLength: 300, disabled,
                    onChange: event => setManager(previous => ({ ...previous, chapterEdit: { id: entry.id, title: event.target.value } })) }))),
                    button(t('save'), () => renameManagedChapter(entry.id, edit.title), { className: 'mx-primary', disabled: disabled || !edit.title.trim() || edit.title.trim() === entry.title })));
              })));
          };
          const renderManagementPage = () => renderUtilityPage('manageBooks', h('p', { className: 'mx-hint' }, t('manageBookHint')),
            !manager ? h('p', { className: 'mx-hint' }, t('chooseBookHint')) : h(React.Fragment, null,
              h('p', { className: 'mx-hint' }, t('bookIdentity', { id: manager.snapshot.bookId, revision: manager.snapshot.revision })),
              h('div', null, h('h3', null, t('savedBookTitle')), h('pre', null, manager.snapshot.title)),
              manageProblem && h('p', { className: 'mx-banner', role: 'status' }, t(manageProblem === 'confirmChanged' ? 'manageStale' : manageProblem)),
              manager.uncertain && h('p', { className: 'mx-banner', role: 'status' }, t('deleteUncertain')),
              chapterOperationUncertain && h('p', { className: 'mx-banner', role: 'status' }, t('chapterWriteUncertain')),
              renderChapterManagement(),
              h('section', { className: 'mx-subpanel mx-stack', 'aria-label': t('renameBook') },
                h('h3', null, t('renameBook')),
                h(Field, { label: t('renameTitle') }, h('input', { value: manager.title, maxLength: 300, disabled: busy || !!manageProblem || manager.uncertain, onChange: e => setManager(previous => ({ ...previous, title: e.target.value })) })),
                button(t('renameBook'), renameManagedBook, { className: 'mx-primary', disabled: busy || !!manageProblem || manager.uncertain || !manager.title.trim() || manager.title.trim() === manager.snapshot.title })),
              h('section', { className: 'mx-subpanel mx-stack', 'aria-label': t('deleteBook') },
                h('h3', null, t('deleteBook')), h('p', null, t('deleteWarning')), h('p', { className: 'mx-hint' }, t('deleteBackup')),
                button(t('openBackupTools'), () => navigatePage('tools')),
                h(Field, { label: t('deleteTypeTitle') }, h('input', { value: manager.typedTitle, disabled: busy || !!manageProblem || manager.uncertain, autoComplete: 'off', spellCheck: false, onChange: e => setManager(previous => ({ ...previous, typedTitle: e.target.value })) })),
                deleteProblem === 'deleteBusy' && h('p', { className: 'mx-banner', role: 'status' }, t('deleteBusy')),
                button(t('deleteBook'), deleteManagedBook, { className: 'mx-danger', disabled: busy || !!deleteProblem || manager.uncertain }))));
          const renderChapterOutline = () => {
            const target = outlineTarget(w, outlineOwner);
            const back = button(t(outlineOwner?.from === 'manage' ? 'outlineBackManagement' : 'outlineBackWriting'), closeChapterOutline, { disabled: busy || loading });
            if (!target) return renderUtilityPage('chapterOutline', h('p', { className: 'mx-hint' }, t('outlineMissing')), back);
            const candidates = outlineProposals(w.book, target.id);
            const record = candidates.find(p => p.id === outlineSelection) || candidates.find(p => p.state === 'ready') || candidates[0];
            const exactJob = job?.mode === 'outline' && job.chapterId === target.id && job.bookId === w.book.id ? job : null;
            const uncertain = outlineNeedsRefresh === w.book.id;
            const pending = exactJob?.status === 'completed' && !candidates.some(p => p.id === exactJob.proposalId);
            const acceptProblem = record && outlineReviewProblem(w, outlineOwner, record, { recovery, conflict, accept: true });
            const rejectProblem = record && outlineReviewProblem(w, outlineOwner, record, { recovery, conflict });
            const canGenerate = !locked && !conflict && !anyDirty && !running && !pending && !uncertain && !modelProblem && !!model?.provider && !!model?.model;
            return renderUtilityPage('chapterOutline',
              h('div', { className: 'mx-row mx-row-between' }, h('strong', null, (w.book.chapters.indexOf(target) + 1) + '. ' + target.title), back),
              h('p', { className: 'mx-hint' }, t('outlineHint')),
              h(Field, { label: t('chapterOutline'), visuallyHidden: true }, textarea('chapter', 'outline', { rows: 12, maxLength: 50000, className: 'mx-outline-editor', readOnly: locked || !!conflict || uncertain })),
              h('div', { className: 'mx-row' }, button(t('save'), async () => { if (await saveAll() && alive.current) setNotice(t('outlineSaved')); }, { className: 'mx-primary', disabled: locked || !!conflict || uncertain || !autosaveCanSave(w, autosaveRef.current) }),
                button(t('outlineRefresh'), refreshChapterOutline, { disabled: busy || loading }), uncertain && h('span', { className: 'mx-hint', role: 'status' }, t('outlineRefreshNeeded'))),
              h('section', { className: 'mx-subpanel mx-stack' },
                h('div', { className: 'mx-row mx-row-between' }, h('h3', null, t('outlineCandidate')),
                  button(t('outlineAI'), startChapterOutline, { className: 'mx-primary', disabled: !canGenerate, title: anyDirty ? t('saveFirst') : modelProblem ? t(modelProblem) : undefined })),
                h(Field, { label: t('outlineInstruction') }, h('textarea', { rows: 2, maxLength: 60000, value: outlineInstruction, disabled: busy || !!recovery, onChange: event => setOutlineInstruction(event.target.value) })),
                anyDirty && h('span', { className: 'mx-hint' }, t('saveFirst')),
                modelProblem && h('span', { className: 'mx-hint' }, t(modelProblem)),
                exactJob?.status === 'running' && h('div', { className: 'mx-row' }, h('span', { className: 'mx-hint', role: 'status' }, t('outlineGenerating')),
                  button(t('cancelJob'), cancelActiveJob, { className: 'mx-danger' })),
                pollError && exactJob && h('div', { className: 'mx-row' }, h('span', { className: 'mx-hint', role: 'status' }, t('pollError')),
                  button(t('retry'), () => { setPollError(false); setPollVersion(value => value + 1); })),
                !pollError && pending && h('p', { className: 'mx-hint', role: 'status' }, t('polishAwaitProposal')),
                exactJob && ['cancelled', 'failed'].includes(exactJob.status) && h('p', { className: 'mx-hint', role: 'status' }, t(exactJob.status) + (exactJob.error ? ' · ' + exactJob.error : '')),
                record && h(React.Fragment, null,
                  h(Field, { label: t('results') }, h('select', { value: record.id, onChange: e => setOutlineSelection(e.target.value) },
                    candidates.map(p => h('option', { key: p.id, value: p.id }, t(p.state) + ' · ' + formatDate(p.createdAt))))),
                  h('pre', { className: 'mx-outline-preview' }, record.text),
                  acceptProblem === 'outlineCandidateStale' && h('p', { className: 'mx-hint' }, t(acceptProblem)),
                  record.state === 'ready' && h('div', { className: 'mx-actions' },
                    button(t('outlineUse'), () => decideChapterOutline(record, true), { className: 'mx-primary', disabled: locked || uncertain || !!acceptProblem }),
                    button(t('outlineReject'), () => decideChapterOutline(record, false), { disabled: locked || uncertain || !!rejectProblem })))));
          };
          const renderContextPage = () => renderUtilityPage('context',
            h('p', { className: 'mx-hint' }, t('contextPageHint')),
            chapter && h('div', { className: 'mx-row' }, badge(chapter.title), badge(t(modeKeys[mode]))),
            mode === 'revise' && h('p', { className: 'mx-hint' }, t('contextStageOne')),
            previewProblem ? h('div', { className: 'mx-stack' }, h('p', { role: 'status', className: 'mx-hint' }, t(previewProblem)),
              previewProblem === 'reviseRequirement' && button(t('writing'), () => navigatePage('writing'))) : h(React.Fragment, null,
              h('div', { className: 'mx-actions' }, button(t('refreshPreview'), () => setContextRefresh(value => value + 1), { disabled: contextBusy })),
              (contextBusy || !context && !contextError) && h('p', { role: 'status', className: 'mx-hint' }, t('loading')),
              contextError?.key === previewKey && h('p', { role: 'alert', className: 'mx-banner mx-error' }, contextError.message),
              context?.key === previewKey && renderReport(context.data)));
          const renderDetailsPage = () => renderUtilityPage('advanced', renderModelPicker(),
            h('section', { className: 'mx-subpanel mx-stack', 'aria-label': t('operationDetails') }, h('h3', null, t('operationDetails')),
              !proposal && !job && h('p', { className: 'mx-hint' }, t('noGenerationDetails')),
              proposal && h('p', { className: 'mx-hint' }, t(modeKeys[proposal.mode]) + ' · ' + t(proposal.state) + ' · ' + formatDate(proposal.createdAt)),
              proposal?.review?.analysis && h('details', null, h('summary', null, t('revisionAnalysis')), h('div', { className: 'mx-revision-analysis' }, proposal.review.analysis)),
              job && h('div', { className: 'mx-stack', 'aria-label': t('job') },
                h('p', { className: 'mx-hint' }, t(job.status) + ' · ' + (modelDescription(job.model) ? t('modelJob', { model: modelDescription(job.model) }) : t('modelJobPending'))),
                job.chapterId !== w?.chapterId && h('p', { className: 'mx-hint' }, t('jobOtherChapter')),
                typeof job.analysis === 'string' && job.analysis && !(job.proposalId === proposal?.id && proposal?.review?.analysis) &&
                  h('details', null, h('summary', null, t('revisionAnalysis')), h('div', { className: 'mx-revision-analysis' }, job.analysis)),
                pollError && h('p', { className: 'mx-hint', role: 'status' }, t('pollError')),
                job.error && h('p', { className: 'mx-hint', role: 'status' }, String(job.error)),
                h('div', { className: 'mx-actions' }, !running && button(t('dismiss'), () => setJob(null)), pollError && button(t('retry'), () => { setPollError(false); setPollVersion(v => v + 1); })))),
            proposal?.context && renderReport({ report: proposal.context }, 'generatedContext'));
          const writingLayout = tab === 'writing' && !!chapter && !d.candidate && !recovery && !conflict && !deletionNotice && !storageFailed && cleanupPendingCount === 0;
          const folded = controlsFolded && writingLayout;
          const renderFoldedCritical = () => autosaveCanSave(w, autosaveRef.current) && h(React.Fragment, null,
            toolbarButton('save', t('saveNow'), saveAll, { disabled: locked || !!conflict }),
            toolbarButton('discard', t('discard'), () => setConfirm({ title: t('confirmDiscard'), body: t('unsavedHint'), label: t('discard'), run: async () => { if (await discardScope('all')) { setConfirm(null); setError(null); resetSelection(); } } }), { disabled: locked }),
            toolbarButton('download', t('downloadLocal'), downloadLocal));
          const writingTaskProblem = anyDirty || conflict ? 'saveFirst' : requirementMissing ? 'reviseRequirement' : '';
          const generateProblem = writingTaskProblem || modelProblem || (!model?.provider || !model?.model ? 'noModel' : '');
          const taskTitle = (key, problem) => t(key) + (problem ? ' · ' + t(problem) : '');
          const renderWritingFeedback = () => {
            const jobStatus = (running || awaitingOutcome) && job?.mode !== 'polish' ? t(running ? job.mode === 'outline' ? 'outlineGenerating' : ['analyzing', 'optimizing'].includes(job.phase) ? job.phase : 'generating' : 'polishAwaitProposal') : '';
            const terminal = !!job && ['failed', 'cancelled'].includes(job.status);
            const message = pollError ? t('pollError') : terminal ? t(job.status) + (job.error ? ' · ' + String(job.error) : '') : jobStatus;
            if (!message) return null;
            const detail = terminal ? job.chapterId !== w.chapterId ? t('jobOtherChapter') : proposal ? t('previousResult') : '' : '';
            const label = message + (detail ? ' · ' + detail : '');
            return h('div', { className: 'mx-topbar-group mx-topbar-feedback' },
              h('span', { className: 'mx-hint mx-job-terminal', role: terminal && job.status === 'failed' && !pollError ? 'alert' : 'status', title: label }, label),
              pollError && toolbarButton('refresh', t('retry'), () => { setPollError(false); setPollVersion(v => v + 1); }));
          };
          const cancelActiveJob = () => withBusy(async () => { const result = await call('cancel', { jobId: job.id }); if (alive.current) { setJob(result); rememberJob(result); setPollVersion(v => v + 1); } }, false);
          const renderWritingActions = () => h('div', { className: 'mx-topbar-group mx-topbar-actions', role: 'group', 'aria-label': t('writingControls') },
            !folded && toolbarButton('generate', t('generate'), generate, { className: 'mx-primary', title: taskTitle('generate', generateProblem), disabled: locked || anyDirty || !!conflict || running || requirementMissing || !!modelProblem || !model?.provider || !model?.model }),
            bulkVisible && toolbarButton('approve', t('approveAll'), () => isRevision ? applyRevisionAll(bulkSnapshot) : isPolish ? applyPolish(bulkSnapshot, true) : applyGenerated(bulkSnapshot, true), { disabled: !!bulkProblem || !bulkPreview, title: t('approveAll') + (bulkProblem ? ' · ' + t(bulkProblem) : '') }),
            running && toolbarButton('cancel', t('cancelJob'), cancelActiveJob, { className: 'mx-danger' }),
            folded && toolbarButton('outline', t('chapterOutline'), () => openChapterOutline(w.chapterId, 'writing'), { 'data-mx-outline-chapter': w.chapterId }),
            folded && renderFoldedCritical(),
            writingLayout && toolbarButton(folded ? 'expand' : 'focus', t(folded ? 'expandControls' : 'collapseControls'), () => focusWriting(!folded),
              { ref: foldButtonRef, disabled: false, 'aria-expanded': !folded, 'aria-controls': taskId }));
          const pageButton = (value, label, dirty = false) => toolbarButton(value, t(label), () => navigatePage(value), {
            key: value, 'aria-pressed': tab === value, 'aria-controls': formId.current, disabled: busy || loading, dirty,
          });
          const findBlocked = !!(guard || confirm || polishRequirements || constraintsHelpOpen);
          const findId = formId.current + '-find';
          const openPageFind = () => {
            if (findBlocked || loading || autosaveComposing.current || composing.current || findInputRef.current?.dataset.findComposing) return false;
            closeSelectionPopup();
            if (findOpen && findInputRef.current) { findInputRef.current.focus({ preventScroll: true }); findInputRef.current.select(); }
            else {
              const own = rootRef.current;
              const active = own?.ownerDocument.activeElement;
              findReturnFocus.current = own?.contains(active) ? active : findButtonRef.current;
              setFindOpen(true);
            }
            return true;
          };
          const dismissPageFind = () => {
            const own = rootRef.current, previous = findReturnFocus.current;
            const restore = isFindControl(own?.ownerDocument.activeElement);
            findReturnFocus.current = null; setFindOpen(false);
            if (restore) (own?.contains(previous) && previous.getClientRects().length ? previous : findButtonRef.current)?.focus({ preventScroll: true });
          };
          const handlePageFindKey = event => {
            if (findBlocked || event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || autosaveComposing.current || composing.current || findInputRef.current?.dataset.findComposing) return;
            if (findShortcut(event) ? openPageFind() : event.key === 'Escape' && findOpen) {
              event.preventDefault(); event.stopPropagation();
              if (event.key === 'Escape') dismissPageFind();
            }
          };
          useEffect(() => {
            // Mere focus in another panel does not make its browser shortcut ours.
            const own = rootRef.current, doc = own?.ownerDocument;
            if (!doc || findBlocked) return;
            const fromPageBody = event => {
              if (event.target === doc.body && doc.activeElement === doc.body && own.getClientRects().length && !own.closest('[inert],[hidden]')) handlePageFindKey(event);
            };
            doc.addEventListener('keydown', fromPageBody, true);
            return () => doc.removeEventListener('keydown', fromPageBody, true);
          });
          useEffect(() => { if (findBlocked) { findReturnFocus.current = null; setFindOpen(false); } }, [findBlocked]);
          const chapterDeleteConfirm = confirm?.chapterRemoval;
          const closeConfirmation = () => { setConfirm(null); if (chapterDeleteConfirm || confirm?.outlineDecision) setError(null); };
          const chapterDeleteBlock = chapterDeleteConfirm && managedChapterProblem(chapterDeleteConfirm.snapshot, true);
          const renderTopbar = () => h('header', { inert: (constraintsHelpOpen || !!chapterDeleteConfirm || !!confirm?.outlineDecision) || undefined, className: 'mx-topbar' },
            w && h('nav', { className: 'mx-topbar-group', 'aria-label': t('pages') }, ['writing', 'constraints', 'cards', 'settings', 'history'].map(value =>
              pageButton(value, value, !!((value === 'writing' && (d.chapter || d.candidate)) || (value === 'cards' && d.card) || (value === 'settings' && tabDirty.settings) || (value === 'constraints' && tabDirty.constraints))))),
            h('div', { className: 'mx-topbar-group mx-topbar-book', role: 'group', 'aria-label': t('bookTools') }, renderBookPicker(),
              h('nav', { className: 'mx-book-page-links', 'aria-label': t('workspacePages') },
                pageButton('tools', 'workspaceTools'), pageButton('manage', 'manageBooks'), pageButton('context', 'context'), pageButton('advanced', 'advanced')),
              toolbarButton('find', t('findText'), openPageFind, { ref: findButtonRef, disabled: findBlocked || loading, 'data-mx-find-trigger': '', 'aria-keyshortcuts': 'Control+F Meta+F', 'aria-expanded': findOpen && !findBlocked, 'aria-controls': findOpen && !findBlocked ? findId : undefined }),
              toolbarButton('refresh', t('refresh'), refreshWorkspace),
              w && autosaveRef.current?.failed && toolbarButton('save', t('autosaveRetry'), saveAll, { title: t('autosavePaused'), disabled: locked || !autosaveCanSave(w, autosaveRef.current) || !!conflict })),
            w && h('div', { className: 'mx-topbar-group mx-topbar-chapter' }, renderChapterPicker(), tab === 'writing' && chapter && renderTitleControl()),
            tab === 'writing' && chapter && renderWritingActions(),
            tab === 'writing' && chapter && renderWritingFeedback());
          const renderCurrentPage = () => {
            switch (tab) {
              case 'tools': return renderBookTools();
              case 'manage': return renderManagementPage();
              case 'outline': return renderChapterOutline();
              case 'context': return renderContextPage();
              case 'advanced': return renderDetailsPage();
            }
            if (!w) return loading ? null : h('section', { className: 'mx-empty mx-stack' },
              h('h2', null, t(books.length ? 'chooseBook' : 'emptyTitle')), h('p', { className: 'mx-hint' }, t(books.length ? 'chooseBookHint' : 'emptyHint')),
              button(t('workspaceTools'), () => navigatePage('tools')));
            switch (tab) {
              case 'constraints': return renderConstraints();
              case 'settings': return renderSettings();
              case 'cards': return renderCards();
              case 'history': return renderHistory();
              default: return chapter ? h('div', { className: 'mx-grid' }, h('div', { ref: columnRef, className: 'mx-writing-column' }, renderAI(), renderEditor())) :
                h('section', { className: 'mx-panel mx-stack' }, h('p', null, t('noChapters')), button(t('addChapter'), () => {
                  if (autosaveComposing.current) return;
                  addChapterFocusPending.current = true; navigatePage('manage');
                }, { disabled: locked, 'aria-controls': formId.current }));
            }
          };
          return h('main', { ref: rootRef, className: 'mx-root' + (writingLayout ? ' mx-root-writing' : '') + (folded ? ' mx-controls-folded' : ''), 'aria-label': t('nav'),
            onKeyDownCapture: handlePageFindKey,
            onPointerDownCapture: event => { if (!isFindControl(event.target) && document.activeElement === editorRef.current) captureSelection(); },
            onCompositionStartCapture: e => { if (!isFindControl(e?.target) && !e?.target?.closest?.('.mx-constraints-editor-host')) autosaveComposing.current = true; },
            // Native form fields and the Markdown engine each release their own
            // composition. The engine waits for the final native transaction.
            onCompositionEndCapture: e => {
              if (!isFindControl(e?.target) && !e?.target?.closest?.('.mx-constraints-editor-host')) { autosaveComposing.current = false; autosaveRef.current.schedule(); }
            },
            onBlurCapture: e => { if (!isFindControl(e.target) && !isFindControl(e.relatedTarget) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) void autosaveRef.current.flush(); },
            onKeyDown: e => { if (e.key === 'Escape') closeSelectionPopup(); if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.isComposing && !e.nativeEvent?.isComposing && !composing.current && !autosaveComposing.current && !guard && !confirm) { e.preventDefault(); if (autosaveCanSave(current.current, autosaveRef.current) && !busyRef.current) saveAll(); } },
          }, h('style', null, CSS),
          renderTopbar(),
          findOpen && !findBlocked && h(PageFind, { rootRef, pageRef: findPageRef, inputRef: findInputRef, id: findId, t, writing: tab === 'writing',
            scope: tab + '\0' + (w?.book.id || '') + '\0' + (tab === 'writing' ? w?.chapterId || '' : ''), onClose: dismissPageFind }),
          h('div', { className: 'mx-toast-layer', role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
            toast && h('div', { className: 'mx-toast', 'data-error': !!toastError }, h('span', { className: 'mx-toast-text' }, toast.message))),
          h('div', { ref: contentRef, className: 'mx-content-pane', 'aria-busy': loading || busy, inert: (constraintsHelpOpen || !!chapterDeleteConfirm || !!confirm?.outlineDecision) || undefined },
          deletionNotice && h('section', { className: 'mx-banner mx-stack', role: 'alert' },
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
            loading && h('p', { role: 'status', className: 'mx-hint' }, t('loading')),
            h('div', { id: formId.current, ref: findPageRef, className: 'mx-writing-host' }, renderCurrentPage()))),
          renderSelectionPopup(),
          constraintsHelpOpen && h(Modal, { id: constraintsHelpId, role: 'dialog', title: t('constraintsHelp'), onCancel: closeConstraintsHelp, returnFocus: constraintsHelpTrigger,
            actions: closeRef => [button(t('close'), closeConstraintsHelp, { key: 'close', ref: closeRef, disabled: false })] },
            h('p', null, t('constraintsDraftHint')),
            h('pre', { className: 'mx-constraint-guide-example' }, t('constraintsGuideExample')),
            h('p', null, t('constraintsGuideInnerList')),
            h('p', null, t('constraintsModelHint'))),
           polishRequirements && h(Modal, { title: t('polishCustom'), busy, onCancel: () => setPolishRequirements(null), actions: cancelRef => [
             button(t('cancel'), () => setPolishRequirements(null), { key: 'cancel', ref: cancelRef, disabled: busy }),
             button(t('polishSubmit'), () => startPolish(polishRequirements.snapshot, polishRequirements.text, true), { key: 'submit', className: 'mx-primary', disabled: busy || !!requirementsProblem || !polishRequirements.text.trim() }),
           ] }, h(React.Fragment, null,
             h('p', { className: 'mx-hint' }, t('polishSelectionOnly')),
             h('div', null, h('h3', null, t('originalPassage')), h('pre', null, polishRequirements.snapshot.text)),
             h(Field, { label: t('polishRequirement') }, h('textarea', { ref: requirementsRef, value: polishRequirements.text, rows: 5, maxLength: 60000, disabled: busy, required: true, onChange: e => setPolishRequirements(previous => previous && ({ ...previous, text: e.target.value })) })),
             requirementsProblem && h('p', { className: 'mx-banner', role: 'alert' }, t(requirementsProblem)),
             error && h('p', { className: 'mx-hint mx-text-error', role: 'alert' }, error.message))),
          guard && h(Modal, { title: t('unsavedTitle'), busy, onCancel: () => setGuard(null), actions: cancelRef => [
            button(t('stay'), () => setGuard(null), { key: 'stay', ref: cancelRef, disabled: busy }),
            button(t('discardContinue'), async () => { const next = guard; if (await discardScope(next.scope)) { setGuard(null); next.run(); } }, { key: 'discard', className: 'mx-danger', disabled: busy }),
            button(t('saveContinue'), async () => { const next = guard; if (await saveAll()) { setGuard(null); next.run(); } }, { key: 'save', className: 'mx-primary', disabled: busy || !!conflict }),
          ] }, h(React.Fragment, null, h('p', null, t('unsavedHint')), error && h('p', { role: 'alert', className: 'mx-hint mx-text-error' }, error.message))),
          confirm && h(Modal, { title: confirm.title, busy, returnFocus: chapterDeleteConfirm ? chapterDeleteTrigger : undefined, onCancel: closeConfirmation, actions: cancelRef => [
            button(t('cancel'), closeConfirmation, { key: 'cancel', ref: cancelRef, disabled: busy }),
            button(confirm.label, chapterDeleteConfirm ? () => confirmChapterDeletion(confirm) : confirm.run, { key: 'confirm', className: chapterDeleteConfirm ? 'mx-danger' : 'mx-primary',
               disabled: busy || !!chapterDeleteConfirm && (confirm.uncertain || confirm.typedTitle !== chapterDeleteConfirm.title || !!chapterDeleteBlock) }),
          ] }, h(React.Fragment, null, h('p', null, confirm.body), chapterDeleteConfirm && h('div', { className: 'mx-stack' },
             h('strong', null, t('chapterAction', { number: chapterDeleteConfirm.number, title: chapterDeleteConfirm.title, action: t('deleteChapter') })),
             h('p', { className: 'mx-hint' }, t('chapterCountDetails', { history: chapterDeleteConfirm.history, proposals: chapterDeleteConfirm.proposals })),
             chapterDeleteBlock && !error && h('p', { role: 'status', className: 'mx-hint' }, t(chapterDeleteBlock === 'confirmChanged' ? 'manageStale' : chapterDeleteBlock)),
             h(Field, { label: t('chapterDeleteType') }, h('input', { value: confirm.typedTitle, disabled: busy || confirm.uncertain, autoComplete: 'off', spellCheck: false,
               onChange: e => setConfirm(previous => previous?.chapterRemoval ? { ...previous, typedTitle: e.target.value } : previous) }))), error && h('p', { role: 'alert', className: 'mx-hint mx-text-error' }, error.message))));
        }

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ycx-inspiration', locale: NS }, App));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'ycx-inspiration', order: 35, label: () => t('nav') }, Icon));
      },
    };
  },
});
