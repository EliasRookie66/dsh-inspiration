import { EditorSelection, EditorState, Annotation, Compartment, Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewline, invertedEffects, isolateHistory, temporarilySetTabFocusMode } from '@codemirror/commands';
import { parser, Strikethrough, TaskList } from '@lezer/markdown';

export const MAX_DOCUMENT_LENGTH = 2_000_000;
const MAX_STRUCTURE_RECORDS = 256; // Four times the maximum valid rule count, plus their categories.
const MAX_RULE_SOURCE = 32_000; // 4000 content code units plus six spaces per continuation.
const MAX_MARKDOWN_BODY = 16_000;
const markdown = parser.configure([Strikethrough, TaskList]);
const normalize = text => text.replace(/\r\n?/g, '\n');

export function scanStructure(source) {
  // Mirror parseConstraintsMarkdown's outer syntax, not CommonMark's list indentation.
  // An invalid document may still contain recognizable lines. Other text is never dropped.
  const blocks = [];
  let category = false, headingStyle = false, rule = null;
  for (let from = 0; from < source.length && blocks.length < MAX_STRUCTURE_RECORDS;) {
    let to = source.indexOf('\n', from);
    if (to < 0) to = source.length;
    const text = source.slice(from, to);
    const heading = /^(#{1,2} |[-*+] )(.+)$/.exec(text);
    if (heading && (!headingStyle || text.startsWith('#'))) {
      headingStyle = text.startsWith('#');
      const quoted = heading[2].startsWith('"');
      let label = heading[2];
      if (quoted) {
        try { label = JSON.parse(label); } catch { label = null; }
      }
      category = typeof label === 'string' && !!label.trim() && label.length <= 80;
      if (category) blocks.push({ kind: 'category', from, to, firstTo: to, contentFrom: from + heading[1].length, quoted });
      rule = null;
    } else {
      const item = /^(?: {4}|\t)[-*+] (.*)$/.exec(text) || (headingStyle && /^[-*+] (.*)$/.exec(text));
      if (item && category) {
        const task = /^\[([ xX])\] /.exec(item[1]);
        const glyph = task ? task[1] === ' ' ? 'unchecked' : 'checked' : 'bullet';
        rule = { kind: 'rule', from, to, firstTo: to, contentFrom: to - item[1].length + (task?.[0].length ?? 0), glyph };
        blocks.push(rule);
      } else if (rule && text.startsWith('      ')) {
        rule.to = to;
      } else {
        rule = null;
      }
    }
    from = to + 1;
  }
  return blocks;
}

function findLine(lines, offset) {
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].bodyFrom <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Analyze one canonical block. All output ranges refer to the original LF text. */
export function analyzeBlock(source, block) {
  const events = [], { from, to, firstTo } = block;
  const category = block.kind === 'category';
  if (block.contentFrom < firstTo || to > firstTo) {
    events.push({ kind: category ? 'category' : 'rule', from, to: block.contentFrom, activeFrom: from, activeTo: firstTo, glyph: block.glyph });
  }
  if (category && block.quoted || to - from > MAX_RULE_SOURCE) return events;
  // Canonical continuations are indented by six columns. Analyzing just the rule
  // body avoids treating those columns as Markdown code. Keep a UTF-16 map to
  // the actual document; no projected text is ever fed to CodeMirror.
  const lines = [], parts = [];
  let bodyFrom = 0, sourceFrom = from, sourceTo = firstTo;
  for (;;) {
    const contentFrom = sourceFrom === from ? block.contentFrom : sourceFrom + 6;
    const part = source.slice(contentFrom, sourceTo);
    if (bodyFrom + part.length > MAX_MARKDOWN_BODY) return events;
    parts.push(part);
    lines.push({ sourceFrom, contentFrom, sourceTo, bodyFrom, bodyTo: bodyFrom + part.length });
    if (sourceFrom !== from && part.length) {
      events.push({ kind: 'continuation', from: sourceFrom, to: contentFrom, activeFrom: sourceFrom, activeTo: sourceTo });
    }
    if (sourceTo === to) break;
    sourceFrom = sourceTo + 1;
    sourceTo = source.indexOf('\n', sourceFrom);
    if (sourceTo < 0 || sourceTo > to) sourceTo = to;
    bodyFrom += part.length + 1;
  }
  const body = parts.join('\n');
  const map = offset => {
    const line = lines[findLine(lines, offset)];
    return line.contentFrom + offset - line.bodyFrom;
  };
  const pieces = (start, end, cb) => {
    for (let i = findLine(lines, start); i < lines.length && lines[i].bodyFrom < end; i++) {
      const line = lines[i], a = Math.max(start, line.bodyFrom), b = Math.min(end, line.bodyTo);
      if (a < b) cb(line.contentFrom + a - line.bodyFrom, line.contentFrom + b - line.bodyFrom, line);
    }
  };
  const style = (kind, start, end) => pieces(start, end, (from, to) => events.push({ kind, from, to }));
  const hide = (start, end, node, lineActive = false, glyph) => {
    const activeFrom = lineActive ? null : map(node.from), activeTo = lineActive ? null : map(node.to);
    pieces(start, end, (from, to, line) => events.push({ kind: 'hidden', from, to,
      activeFrom: activeFrom ?? line.sourceFrom, activeTo: activeTo ?? line.sourceTo, glyph }));
  };
  const formats = { Emphasis: ['em', 'EmphasisMark'], StrongEmphasis: ['strong', 'EmphasisMark'],
    Strikethrough: ['strike', 'StrikethroughMark'], InlineCode: ['code', 'CodeMark'] };
  markdown.parse(body).iterate({ enter(ref) {
    const { name, from, to, node } = ref;
    if (name === 'Image' || name === 'HTMLBlock' || name === 'HTMLTag' || name === 'Autolink' || name === 'LinkReference') return false;
    if (Object.hasOwn(formats, name)) {
      const [kind, marker] = formats[name], marks = node.getChildren(marker);
      if (marks.length === 2) {
        style(kind, marks[0].to, marks[1].from);
        for (const mark of marks) hide(mark.from, mark.to, node);
      }
    } else if (name === 'Link') {
      const marks = node.getChildren('LinkMark'), url = node.getChild('URL');
      // These are only *styled labels*. Do not create <a>, href, title, src,
      // handlers, network requests or any HTML from the document's syntax.
      if (!url || !/^(?:https?:\/\/|mailto:)[^\u0000-\u0020\u007f]+$/i.test(body.slice(url.from, url.to)) ||
          marks.length !== 4 || marks[0].to >= marks[1].from) return false;
      style('link', marks[0].to, marks[1].from);
      hide(from, marks[0].to, node);
      hide(marks[1].from, to, node);
    } else if (!category && /^(?:ATX|Setext)Heading[1-6]$/.test(name)) {
      const marks = node.getChildren('HeaderMark');
      const kind = /[12]$/.test(name) ? 'heading' : 'subheading';
      if (name.startsWith('ATX') && marks.length) {
        let start = marks[0].to, end = marks[1]?.from ?? to;
        while (start < end && /[ \t]/.test(body[start])) start++;
        if (marks[1]) while (end > start && /[ \t]/.test(body[end - 1])) end--;
        if (start < end) { // Keep a bare/incomplete heading marker visible.
          style(kind, start, end);
          hide(marks[0].from, start, node, true);
          if (marks[1]) hide(end, marks[1].to, node, true);
        }
      } else if (marks.length === 1) {
        const line = lines[findLine(lines, marks[0].from)];
        style(kind, from, line.bodyFrom - 1);
        hide(marks[0].from, marks[0].to, node, true);
      }
    } else if (name === 'FencedCode') {
      const marks = node.getChildren('CodeMark');
      for (const code of node.getChildren('CodeText')) style('code', code.from, code.to);
      // The opening fence must remain literal if the author hasn't closed it.
      if (marks.length === 2) {
        const first = lines[findLine(lines, marks[0].from)], last = lines[findLine(lines, marks[1].from)];
        hide(marks[0].from, first.bodyTo, node, true);
        hide(marks[1].from, last.bodyTo, node, true);
      }
      return false;
    } else if (name === 'QuoteMark') {
      hide(from, body[to] === ' ' ? to + 1 : to, node, true, 'quote');
    } else if (name === 'ListMark' && /^[-*+]$/.test(body.slice(from, to))) {
      hide(from, to, node, true, 'bullet');
    } else if (name === 'TaskMarker') {
      hide(from, to, node, true, /x/i.test(body.slice(from, to)) ? 'checked' : 'unchecked');
    }
  } });
  return events;
}

const glyphText = { bullet: '•', checked: '☑', unchecked: '☐', quote: '│' };
class SyntaxGlyph extends WidgetType {
  constructor(kind) { super(); this.kind = kind; }
  eq(other) { return this.kind === other.kind; }
  toDOM(view) {
    const span = view.contentDOM.ownerDocument.createElement('span');
    span.className = 'mx-cm-glyph';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = glyphText[this.kind];
    return span;
  }
  // A click/drag on a glyph is an editor selection, not a checkbox action.
  ignoreEvent() { return false; }
}
const replacements = { none: Decoration.replace({}) };
for (const kind of Object.keys(glyphText)) replacements[kind] = Decoration.replace({ widget: new SyntaxGlyph(kind) });
const lineStyle = {};
for (const kind of ['category', 'rule', 'continuation']) {
  lineStyle[kind] = [Decoration.line({ class: 'mx-cm-' + kind }), Decoration.line({ class: 'mx-cm-' + kind + ' mx-cm-folded' })];
}
const inlineStyle = {};
for (const kind of ['em', 'strong', 'strike', 'code', 'link', 'heading', 'subheading']) inlineStyle[kind] = Decoration.mark({ class: 'mx-cm-' + kind });

// Keep a rendered multi-line selection stable: only an insertion caret,
// not every character selected by a drag or Select All, reveals syntax.
export const caretTouches = (selection, from, to) => selection.ranges.some(range => range.empty && range.head >= from && range.head <= to);
const refreshProjection = StateEffect.define();
function markdownProjection(isComposing) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.doc = null;
      this.decorations = Decoration.none;
      this.rebuild(view);
    }
    update(update) {
      if (isComposing(update.view)) {
        // Keep markup DOM stable under IME, only map offsets while the IME owns
        // the composition. The pre-composition caret's syntax is already open.
        this.decorations = this.decorations.map(update.changes);
      } else if (this.doc !== update.state.doc || update.viewportChanged || update.selectionSet || update.focusChanged ||
          update.transactions.some(tr => tr.effects.some(effect => effect.is(refreshProjection)))) {
        this.rebuild(update.view);
      }
    }
    rebuild(view) {
      if (this.doc !== view.state.doc) {
        this.doc = view.state.doc;
        this.source = this.doc.toString();
        this.blocks = scanStructure(this.source);
      }
      const window = view.viewport, ranges = [], selection = view.state.selection;
      for (const block of this.blocks) {
        if (block.to < window.from) continue;
        if (block.from > window.to) break;
        const events = block.events ??= analyzeBlock(this.source, block);
        for (const event of events) {
          const { kind, from, to, glyph, activeFrom, activeTo } = event;
          if (to < window.from || from > window.to) continue;
          const active = view.hasFocus && activeFrom !== undefined && caretTouches(selection, activeFrom, activeTo);
          if (lineStyle[kind]) ranges.push(lineStyle[kind][active ? 0 : 1].range(from));
          if (activeFrom === undefined) ranges.push(inlineStyle[kind].range(from, to));
          else if (!active && from < to) ranges.push(replacements[glyph ?? 'none'].range(from, to));
        }
      }
      // No atomicRanges facet: selection and commands are always CM's native
      // source offsets, including across hidden replacements and line breaks.
      this.decorations = Decoration.set(ranges, true);
    }
  }, { decorations: plugin => plugin.decorations });
}

const theme = EditorView.theme({
  // The host owns the control's border, focus indication and scroll bounds.
  '&': { fontSize: 'inherit', color: 'inherit', minWidth: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.65' },
  '.cm-content': { padding: '.55rem .35rem', caretColor: 'currentColor' },
  '.cm-placeholder': { color: 'var(--dsw-alias-label-secondary)' },
  '.cm-line.mx-cm-category': { fontWeight: '650', fontSize: '1.12em' },
  '.cm-line.mx-cm-rule.mx-cm-folded': { paddingInlineStart: '1rem' },
  '.cm-line.mx-cm-continuation.mx-cm-folded': { paddingInlineStart: '2.15rem' },
  '.mx-cm-glyph': { color: 'var(--dsw-alias-label-secondary)', paddingInlineEnd: '.4em' },
  '.mx-cm-em': { fontStyle: 'italic' },
  '.mx-cm-strong': { fontWeight: '700' },
  '.mx-cm-heading': { fontWeight: '650', fontSize: '1.1em' },
  '.mx-cm-subheading': { fontWeight: '650' },
  '.mx-cm-strike': { textDecoration: 'line-through' },
  '.mx-cm-link': { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'underline' },
  '.mx-cm-code': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '3px' },
  '&.mx-cm-raw .cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
});

// History stores opaque versions rather than document text or application state.
// When CM groups adjacent typing it appends the oldest inverse effect last. Taking
// the last effect thus restores the exact boundary token for both undo and redo.
const restoreVersion = StateEffect.define();
const freshVersions = new WeakMap();
function versionAfter(tr) {
  for (let i = tr.effects.length - 1; i >= 0; i--) if (tr.effects[i].is(restoreVersion)) return tr.effects[i].value;
  if (!tr.docChanged) return tr.startState.field(documentVersion);
  let version = freshVersions.get(tr);
  if (!version) freshVersions.set(tr, version = Object.freeze({}));
  return version;
}
const documentVersion = StateField.define({
  create: () => Object.freeze({}),
  update: (_version, tr) => versionAfter(tr),
});
export const documentVersions = [documentVersion, invertedEffects.of(tr => tr.docChanged ? [restoreVersion.of(tr.startState.field(documentVersion))] : [])];
const externalSync = Annotation.define(), rejected = Annotation.define(), structureAction = Annotation.define();
export function inputUpdate(tr) {
  const changes = [], action = tr.annotation(structureAction);
  tr.changes.iterChanges((from, to, _fromB, _toB, insert) => changes.push(Object.freeze({ from, to, insert: insert.toString() })), true);
  return Object.freeze({ before: tr.startState.doc.toString(), text: tr.newDoc.toString(), changes: Object.freeze(changes),
    origin: tr.annotation(Transaction.userEvent), beforeVersion: tr.startState.field(documentVersion), version: versionAfter(tr),
    ...(action ? { payload: action.payload } : {}) });
}

export function structureTransaction(state, text, payload) {
  return state.update({ changes: minimalChanges(state.doc.toString(), text), userEvent: 'input.structure',
    annotations: [structureAction.of({ payload }), isolateHistory.of('full')] });
}

/** Guard user transactions. Native undo/redo deliberately bypasses CM filters. */
export function transactionGate(getOptions) {
  const checked = new WeakMap();
  const check = tr => {
    if (!tr.docChanged || tr.annotation(externalSync)) return null;
    const cached = checked.get(tr);
    if (cached) return cached;
    const decision = {}, privileged = tr.startState.readOnly && tr.annotation(structureAction);
    if (tr.startState.readOnly && !privileged) decision.reject = true;
    else if (tr.changes.newLength > MAX_DOCUMENT_LENGTH) decision.reject = 'limit';
    else {
      decision.input = inputUpdate(tr);
      // String changes, including pasted text, are split by CM's LF/CRLF/CR
      // default separator. A stray CR from a platform Text object is not saved.
      if (decision.input.changes.some(change => change.insert.includes('\r'))) decision.reject = true;
      else {
        const accepted = getOptions().acceptInput?.(decision.input);
        if (accepted === false || accepted === 'limit' || privileged && accepted !== true) decision.reject = accepted === 'limit' ? 'limit' : true;
      }
    }
    checked.set(tr, decision);
    return decision;
  };
  return {
    extension: EditorState.transactionFilter.of(tr => {
      const decision = check(tr);
      return decision?.reject ? { annotations: rejected.of(decision.reject) } : tr;
    }),
    checkDispatched(tr) {
      const skip = tr.annotation(rejected);
      return skip ? { reject: skip } : check(tr);
    },
  };
}

export function minimalChanges(before, after) {
  let from = 0, oldEnd = before.length, newEnd = after.length;
  while (from < oldEnd && from < newEnd && before[from] === after[from]) from++;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return from === oldEnd && from === newEnd ? [] : [{ from, to: oldEnd, insert: after.slice(from, newEnd) }];
}

export function shortcutChanges(before, after, from, to, key, shiftKey) {
  if (key === 'Enter' && after.length >= before.length - (to - from) &&
      after.startsWith(before.slice(0, from)) && after.endsWith(before.slice(to))) {
    const insert = after.slice(from, after.length - (before.length - to));
    if (before.slice(from, to) !== insert) return [{ from, to, insert }];
    return [];
  }
  if (key === 'Tab') {
    const lineFrom = from === 0 ? 0 : before.lastIndexOf('\n', from - 1) + 1;
    const blockEnd = to > from && before[to - 1] === '\n' ? to - 1 : to;
    let lineTo = before.indexOf('\n', blockEnd);
    if (lineTo < 0) lineTo = before.length;
    let start = lineFrom, changedStart = lineFrom;
    const changes = [];
    while (start <= lineTo) {
      let stop = before.indexOf('\n', start);
      if (stop < 0) stop = before.length;
      const line = before.slice(start, stop), removed = shiftKey ? (/^(?: {1,4}|\t)/.exec(line)?.[0].length ?? 0) : 0;
      const expected = shiftKey ? line.slice(removed) : '    ' + line;
      if (!after.startsWith(expected, changedStart) || (stop < lineTo && after[changedStart + expected.length] !== '\n')) break;
      if (!shiftKey || removed) changes.push({ from: start, to: start + removed, insert: shiftKey ? '' : '    ' });
      start = stop + 1;
      changedStart += expected.length + 1;
    }
    if (start > lineTo && after.startsWith(before.slice(0, lineFrom)) && after.slice(changedStart - 1) === before.slice(lineTo)) return changes;
  }
  return minimalChanges(before, after);
}

export function externalTransactions(state, undoHistory, effects, changes, reset) {
  const first = state.update({ changes,
    effects: reset ? [...effects, undoHistory.reconfigure([]), restoreVersion.of(Object.freeze({}))] : effects,
    annotations: [externalSync.of(true), Transaction.addToHistory.of(false)] });
  // Removed for one transaction so CodeMirror cannot map stale undo/redo
  // entries into a different setting book/semantic base. The view stays mounted.
  return reset ? [first, first.state.update({ effects: undoHistory.reconfigure(history()), annotations: externalSync.of(true) })] : [first];
}

function boundedText(text) {
  return typeof text === 'string' && text.length <= MAX_DOCUMENT_LENGTH ? normalize(text) : null;
}
const clamp = (position, length) => Math.max(0, Math.min(length, Number.isFinite(position) ? Math.trunc(position) : 0));
export function shortcutSelection(state, changes, key, result) {
  // A selection endpoint can be INSIDE the whitespace being removed;
  // adding the net delta would move it into the previous line.
  if (key === 'Tab') return state.selection.map(changes, 1);
  const { anchor, head } = state.selection.main;
  const start = clamp(result.start, changes.newLength), end = clamp(result.end, changes.newLength);
  return EditorSelection.single(head < anchor ? end : start, head < anchor ? start : end);
}

export function editorAppearance({ raw, readOnly, invalid, label, describedBy, placeholder: hint }, projection) {
  return [
    raw ? [] : projection,
    EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly),
    EditorView.editorAttributes.of({ class: 'mx-cm-editor' + (raw ? ' mx-cm-raw' : '') + (invalid ? ' mx-cm-invalid' : '') }),
    EditorView.contentAttributes.of({
      role: 'textbox', 'aria-multiline': 'true', 'aria-readonly': String(!!readOnly), 'aria-invalid': String(!!invalid),
      ...(label ? { 'aria-label': label } : {}), ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      ...(readOnly ? { tabindex: '0' } : {}),
    }),
    hint ? placeholder(hint) : [],
  ];
}

function restoreViewportScroll(view, viewport) {
  if (!viewport || ![viewport.scrollTop, viewport.scrollLeft].some(Number.isFinite)) return () => {};
  const signals = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  let pending = true;
  const cancel = () => {
    if (!pending) return;
    pending = false;
    for (const signal of signals) view.dom.removeEventListener(signal, cancel, true);
  };
  for (const signal of signals) view.dom.addEventListener(signal, cancel, { capture: true, passive: true });
  view.requestMeasure({
    read: () => pending,
    write: restore => {
      if (!restore || !pending) return;
      cancel();
      if (Number.isFinite(viewport.scrollTop)) view.scrollDOM.scrollTop = Math.max(0, viewport.scrollTop);
      // Native RTL scrollLeft may be negative.
      if (Number.isFinite(viewport.scrollLeft)) view.scrollDOM.scrollLeft = viewport.scrollLeft;
    },
  });
  return cancel;
}

export function observeEditContext(readContext, start, end) {
  let attached = null;
  const set = next => {
    if (next === attached) return;
    attached?.removeEventListener('compositionstart', start);
    attached?.removeEventListener('compositionend', end);
    attached = next || null;
    attached?.addEventListener('compositionstart', start);
    attached?.addEventListener('compositionend', end);
  };
  return { refresh: () => set(readContext()), dispose: () => set(null) };
}

/**
 * Mount a single authoritative CM editor. sync takes a complete options object;
 * resetHistory is a one-shot flag for a different semantic base with identical
 * LF text. The selection and view survive source-mode switches and external sync.
 */
export function createContinuousMarkdown(parent, initialOptions) {
  let options = initialOptions, view, destroyed = false, compositionActive = false, endTimer, pendingSync;
  const isComposing = currentView => compositionActive || currentView.compositionStarted;
  const appearance = new Compartment(), undoHistory = new Compartment(), projection = markdownProjection(isComposing);
  const appearanceValues = value => [value.raw, value.readOnly, value.invalid, value.label, value.describedBy, value.placeholder];
  let appliedAppearance = appearanceValues(options);
  const gate = transactionGate(() => options);
  const reportSelection = (current = view.state.selection.main) => options.onSelection?.({ anchor: current.anchor, head: current.head });
  const reportLimit = () => options.onLimit?.();

  function keydown(event, currentView) {
    const key = event.key;
    if (key !== 'Tab' && key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey ||
        event.isComposing || event.keyCode === 229 || isComposing(currentView) || currentView.state.readOnly) return false;
    const { state } = currentView, { from, to } = state.selection.main;
    const stop = to > from && state.sliceDoc(to - 1, to) === '\n' ? to - 1 : to;
    // Do not allocate thousands of lines of guaranteed-over-limit indentation.
    if (key === 'Tab' && !event.shiftKey && options.editKey &&
        state.doc.length + 4 * (state.doc.lineAt(stop).number - state.doc.lineAt(from).number + 1) > MAX_DOCUMENT_LENGTH) {
      reportLimit();
      return true;
    }
    const before = state.doc.toString();
    const result = options.editKey?.(before, from, to, key, { shiftKey: event.shiftKey, composing: false });
    if (!result) return key === 'Enter' ? insertNewline(currentView) : false;
    const text = boundedText(result.value);
    if (text === null) { reportLimit(); return true; }
    const changes = shortcutChanges(before, text, from, to, key, event.shiftKey);
    if (key === 'Tab' && !changes.length) return true;
    const changeSet = state.changes(changes);
    currentView.dispatch({ changes: changeSet, selection: shortcutSelection(state, changeSet, key, result),
      scrollIntoView: true, userEvent: key === 'Enter' ? 'input.type' : event.shiftKey ? 'delete.dedent' : 'input.indent' });
    return true;
  }

  function startComposition() {
    if (destroyed) return;
    if (endTimer !== undefined) { clearTimeout(endTimer); endTimer = undefined; }
    if (!compositionActive) { compositionActive = true; options.onCompositionStart?.(); }
  }
  function endComposition() {
    if (destroyed || !compositionActive || endTimer !== undefined) return;
    // CM may flush the last native mutation immediately after compositionend.
    // Wait one task so the final onInput arrives before onCompositionEnd.
    endTimer = setTimeout(() => {
      endTimer = undefined;
      if (destroyed) return;
      compositionActive = false;
      view.dispatch({ effects: refreshProjection.of(null) });
      const pending = pendingSync;
      pendingSync = null;
      if (pending) {
        // An input accepted after this snapshot wins over older React props.
        const fresh = pending.text !== undefined && (pending.at === view.state.doc || pending.text === view.state.doc.toString());
        applySync(pending.options, fresh ? pending.text : undefined, fresh);
      }
      options.onCompositionEnd?.();
    }, 0);
  }
  const initialText = boundedText(options.text);
  const base = [
    documentVersions, gate.extension, undoHistory.of(history()), appearance.of(editorAppearance(options, projection)), theme,
    EditorView.lineWrapping, EditorState.tabSize.of(4),
    Prec.high(EditorView.domEventHandlers({ keydown })),
    EditorView.domEventObservers({ compositionstart: startComposition, compositionend: endComposition,
      blur() { endComposition(); options.onBlur?.(); } }),
    keymap.of([{ key: 'Escape', run: temporarilySetTabFocusMode, stopPropagation: true }, ...historyKeymap,
      ...defaultKeymap.filter(binding => binding.key !== 'Enter')]),
  ];
  const initialViewport = options.initialViewport;
  const initialLength = initialText?.length ?? 0;
  const selection = initialViewport ? EditorSelection.single(clamp(initialViewport.anchor, initialLength), clamp(initialViewport.head, initialLength)) : undefined;
  view = new EditorView({ parent, state: EditorState.create({ doc: initialText ?? '', selection, extensions: base }),
    dispatchTransactions(transactions, currentView) {
      for (const tr of transactions) {
        if (tr.startState !== currentView.state) break;
        const decision = gate.checkDispatched(tr);
        if (decision?.reject) {
          if (decision.reject === 'limit') reportLimit();
          break;
        }
        const next = tr.newSelection.main, prev = tr.startState.selection.main;
        currentView.update([tr]);
        if (decision?.input) options.onInput?.(decision.input);
        if (!tr.annotation(externalSync) && (decision?.input || prev.anchor !== next.anchor || prev.head !== next.head)) reportSelection(next);
      }
    },
  });
  // Chromium can attach its EditContext only after leaving read-only mode.
  // Follow that attachment without changing the platform input mechanism.
  const inputContext = observeEditContext(() => view.contentDOM.editContext, startComposition, endComposition);
  inputContext.refresh();
  const cancelViewportRestore = restoreViewportScroll(view, initialViewport);
  if (initialText === null) reportLimit();
  reportSelection();

  function applySync(next, text = undefined, canReset = true) {
    const effects = [], flags = appearanceValues(next);
    if (flags.some((value, index) => value !== appliedAppearance[index])) {
      effects.push(appearance.reconfigure(editorAppearance(next, projection)));
      appliedAppearance = flags;
    }
    const old = text === undefined ? null : view.state.doc.toString();
    const replacement = old !== null && old !== text;
    const reset = canReset && (!!next.resetHistory || replacement);
    if (reset) cancelViewportRestore();
    if (effects.length || reset) {
      view.dispatch(externalTransactions(view.state, undoHistory, effects, replacement ? minimalChanges(old, text) : [], reset));
      inputContext.refresh();
      if (reset) reportSelection();
    }
  }
  return {
    sync(next) {
      if (destroyed) return;
      options = next;
      const text = boundedText(next.text);
      if (text === null) reportLimit();
      if (isComposing(view)) { pendingSync = { options: next, text: text ?? undefined, at: view.state.doc }; return; }
      applySync(next, text ?? undefined, text !== null);
    },
    applyStructure({ text: proposed, payload }) {
      if (destroyed || isComposing(view)) return false;
      const text = boundedText(proposed);
      if (text === null) { reportLimit(); return false; }
      const tr = structureTransaction(view.state, text, payload);
      const accepted = tr.docChanged && !gate.checkDispatched(tr)?.reject;
      view.dispatch(tr);
      return accepted;
    },
    captureViewport() {
      if (destroyed) return null;
      const { anchor, head } = view.state.selection.main;
      return { anchor, head, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft };
    },
    focusRange(from, to = from) {
      if (destroyed) return;
      cancelViewportRestore();
      const length = view.state.doc.length;
      const selection = EditorSelection.single(clamp(from, length), clamp(to, length));
      // Don't move a native candidate window to an unrelated source offset.
      if (isComposing(view)) { view.focus(); reportSelection(); return; }
      view.dispatch({ selection, scrollIntoView: true, annotations: externalSync.of(true) });
      view.focus();
      reportSelection();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelViewportRestore();
      if (endTimer !== undefined) clearTimeout(endTimer);
      inputContext.dispose();
      pendingSync = null;
      view.destroy();
    },
  };
}
