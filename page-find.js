// Local find operates on the mounted current-page subtree, not on saved data,
// global selection, the browser's Find UI, or a virtual editor's backing model.
export const PAGE_FIND_MAX_QUERY_LENGTH = 1024;
const MAX_HITS = 10_000;
const MAX_TEXT_UNITS = 1_000_000;
const MAX_NODES = 40_000;
const ELEMENT = 1, TEXT = 3;
const TEXT_INPUT_TYPES = new Set(['text', 'tel', 'url', 'email']);
const EXCLUDED = '[hidden], [inert], [aria-hidden="true"], [data-page-find-ignore], .mx-visually-hidden, .mx-card-filter, .cm-placeholder';
const NON_CONTENT = 'script, style, template, noscript, select, option, optgroup, button:not(.mx-card-pick), [role="button"]:not(.mx-card-pick), svg, img, canvas, audio, video, iframe, hr, br';

function literalPattern(query) {
  // Unicode simple case folding does not rewrite text or move its UTF-16
  // offsets (unlike lowercasing it). No normalization, wildcard, or word mode.
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

function visitLiteralMatches(text, pattern, visit) {
  pattern.lastIndex = 0;
  for (let match; (match = pattern.exec(text));) {
    if (!visit(match.index, pattern.lastIndex)) return true;
  }
  return false;
}

function boundedPrefix(text, units) {
  if (text.length <= units) return text;
  // Never turn half of a valid surrogate pair into a searchable lone surrogate.
  if (units > 0 && (text.charCodeAt(units - 1) & 0xfc00) === 0xd800 &&
      (text.charCodeAt(units) & 0xfc00) === 0xdc00) units--;
  return text.slice(0, units);
}

/** Case-insensitive, literal, non-overlapping UTF-16 ranges in one string. */
export function literalFind(text, query, limit = MAX_HITS) {
  const hits = [];
  if (typeof text !== 'string' || !text || typeof query !== 'string' || !query) return { hits, limited: false };
  if (query.length > PAGE_FIND_MAX_QUERY_LENGTH) return { hits, limited: true };
  const cap = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, MAX_HITS)) : MAX_HITS;
  const prefix = boundedPrefix(text, MAX_TEXT_UNITS);
  const overflow = visitLiteralMatches(prefix, literalPattern(query), (start, end) => {
    if (hits.length >= cap) return false;
    hits.push({ start, end });
    return true;
  });
  return { hits, limited: overflow || prefix.length < text.length };
}

/** A negative/out-of-range index means there is no active hit yet. */
export function cycleFindIndex(index, direction, count) {
  if (!Number.isSafeInteger(count) || count <= 0) return -1;
  const backwards = direction < 0;
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) return backwards ? count - 1 : 0;
  return backwards ? (index === 0 ? count - 1 : index - 1) : (index === count - 1 ? 0 : index + 1);
}

function isSuppressed(style) {
  return style.display === 'none' || style.contentVisibility === 'hidden' || style.opacity === '0';
}

function textIsVisible(style) {
  return style.visibility !== 'hidden' && style.visibility !== 'collapse';
}

/**
 * Search only the connected element passed by the caller. Return DOM-order hits:
 * { kind: 'field', node, start, end } for live text field values, or
 * { kind: 'text', range, node } for DOM text (node is the start's parent element).
 * Text is matched across inline wrappers in a block, not across hard breaks,
 * block boundaries, or separate form controls. Literal whitespace is read from
 * DOM text; CSS wrapping/collapsing, CSS-only generated text, and unmounted
 * editor content are not modeled. Mounted content beyond a scroll port is
 * still searchable.
 */
export function scanPageFind(root, query) {
  const hits = [];
  if (root?.nodeType !== ELEMENT || !root.isConnected || typeof query !== 'string' || !query) return { hits, limited: false };
  if (query.length > PAGE_FIND_MAX_QUERY_LENGTH) return { hits, limited: true };
  const doc = root.ownerDocument, view = doc.defaultView;
  if (!view) return { hits, limited: false };
  const pattern = literalPattern(query);
  let limited = false, visited = 0, remaining = MAX_TEXT_UNITS;
  let stopped = false, parts = [], size = 0;

  function visitNode() {
    if (++visited <= MAX_NODES) return true;
    limited = stopped = true;
    return false;
  }

  function takeText(value) {
    const text = boundedPrefix(value, remaining);
    remaining -= text.length;
    if (text.length < value.length) limited = stopped = true;
    return text;
  }

  function addHit(create) {
    if (hits.length >= MAX_HITS) {
      limited = stopped = true;
      return false;
    }
    hits.push(create());
    return true;
  }

  function flushText() {
    if (!parts.length) return;
    const text = parts.length === 1 ? parts[0].text : parts.map(part => part.text).join('');
    let left = 0, right = 0;
    visitLiteralMatches(text, pattern, (start, end) => addHit(() => {
      // Matches are ordered; each pointer only moves forward through the scope.
      while (parts[left].end <= start) left++;
      while (parts[right].end < end) right++;
      const a = parts[left], b = parts[right], range = doc.createRange();
      range.setStart(a.node, start - a.start);
      range.setEnd(b.node, end - b.start);
      return { kind: 'text', range, node: a.node.parentElement };
    }));
    parts = [];
    size = 0;
  }

  // Ancestors are consulted for visibility only. No ancestor text is searched.
  for (let branch = root, parent = branch.parentElement; parent; branch = parent, parent = parent.parentElement) {
    if (!visitNode()) return { hits, limited };
    if (parent.matches(EXCLUDED) || isSuppressed(view.getComputedStyle(parent))) return { hits, limited };
    if (parent.localName === 'details' && !parent.open) {
      if (branch.localName !== 'summary') return { hits, limited };
      for (let prev = branch.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (!visitNode() || prev.localName === 'summary') return { hits, limited };
      }
    }
  }

  // Iterative DFS: each frame holds only the next sibling and its parent's
  // context. This does not enqueue huge child lists or recurse on deep markup.
  const stack = [{ next: root, root: true }];
  while (stack.length && !stopped) {
    const frame = stack[stack.length - 1], node = frame.next;
    if (!node) {
      stack.pop();
      if (frame.boundary) flushText();
      continue;
    }
    if (!visitNode()) break;
    frame.next = frame.root ? null : node.nextSibling;
    if (frame.summaryOnly) {
      if (node.localName !== 'summary') continue;
      frame.next = null;
    }
    if (node.nodeType === TEXT) {
      if (!frame.visible) {
        flushText();
      } else if (node.length) {
        const text = takeText(node.data);
        if (text) {
          parts.push({ node, text, start: size, end: size + text.length });
          size += text.length;
        }
      }
      continue;
    }
    if (node.nodeType !== ELEMENT || node.matches(EXCLUDED)) continue;
    const style = view.getComputedStyle(node);
    if (isSuppressed(style)) continue;
    const visible = textIsVisible(style), tag = node.localName;
    if (tag === 'input' || tag === 'textarea') {
      flushText();
      if (!stopped && visible && (tag === 'textarea' || TEXT_INPUT_TYPES.has(node.type)) && typeof node.value === 'string') {
        // Read .value rather than attributes/textContent: draft edits and native
        // newline normalization must agree with setSelectionRange / a mirror.
        const text = takeText(node.value);
        visitLiteralMatches(text, pattern, (start, end) => addHit(() => ({ kind: 'field', node, start, end })));
      }
      continue;
    }
    if (node.matches(NON_CONTENT)) {
      flushText();
      continue;
    }
    const boundary = tag === 'details' || !['inline', 'inline flow', 'contents'].includes(style.display);
    if (boundary) flushText();
    if (node.firstChild) stack.push({ next: node.firstChild, visible, boundary, summaryOnly: tag === 'details' && !node.open });
  }
  flushText();
  return { hits, limited };
}
