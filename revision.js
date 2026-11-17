import { createHash } from 'node:crypto';

// UTF-16 positions, but never divide a Unicode scalar or a Windows newline.
// All limits are operation-count based, so the same input produces the same diff.
export const REVISION_LIMITS = Object.freeze({ text: 200_000, hunks: 256, cells: 400_000, totalCells: 2_000_000 });
export function revisionBoundary(value, offset) {
  if (offset <= 0 || offset >= value.length) return true;
  const left = value.charCodeAt(offset - 1), right = value.charCodeAt(offset);
  return !(left === 13 && right === 10) && !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}
function invalid(message) {
  const error = new TypeError(message); error.code = 'VALIDATION'; throw error;
}
function checkText(value) {
  if (typeof value !== 'string' || value.length > REVISION_LIMITS.text || !value.isWellFormed()) invalid('修订文本必须是有效 Unicode 且不超过 200000 字符');
}
function atoms(value) { return value.match(/\r\n|[\s\S]/gu) || []; }
function offsets(parts) { const out = [0]; for (const part of parts) out.push(out.at(-1) + part.length); return out; }
function uuid(seed, index, hunk) {
  const hex = createHash('sha256').update(`${seed}:${index}:${hunk.start}:${hunk.end}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Unique complete-line anchors + LIS: bounded O(n log n), without a quadratic
// chapter-sized matrix. Ambiguous repeated lines are handled in the gaps.
function anchors(before, after) {
  const lines = value => value.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [];
  const left = lines(before), right = lines(after), lp = offsets(left), rp = offsets(right);
  const occurrences = parts => {
    const map = new Map();
    parts.forEach((part, index) => map.set(part, map.has(part) ? -1 : index));
    return map;
  };
  const lm = occurrences(left), rm = occurrences(right), pairs = [];
  for (let i = 0; i < left.length; i++) {
    const j = rm.get(left[i]);
    if (lm.get(left[i]) === i && j !== undefined && j >= 0) pairs.push({ i, j });
  }
  const tails = [], previous = new Int32Array(pairs.length).fill(-1);
  pairs.forEach((pair, index) => {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >>> 1; if (pairs[tails[mid]].j < pair.j) low = mid + 1; else high = mid; }
    if (low) previous[index] = tails[low - 1];
    tails[low] = index;
  });
  const result = [];
  for (let at = tails.at(-1); at !== undefined && at >= 0; at = previous[at]) {
    const { i, j } = pairs[at];
    result.push({ start: lp[i], end: lp[i + 1], otherStart: rp[j], otherEnd: rp[j + 1] });
  }
  return result.reverse();
}

export function diffText(before, after, { onFallback } = {}) {
  checkText(before); checkText(after);
  if (onFallback !== undefined && typeof onFallback !== 'function') invalid('onFallback 必须是函数');
  if (before === after) return [];
  const raw = [], warnings = new Set();
  let remaining = REVISION_LIMITS.totalCells;
  const coarse = (start, end, replacement, reason) => {
    if (before.slice(start, end) !== replacement) raw.push({ start, end, before: before.slice(start, end), after: replacement });
    if (reason) warnings.add(reason);
  };
  function gap(start, end, otherStart, otherEnd) {
    const a = atoms(before.slice(start, end)), b = atoms(after.slice(otherStart, otherEnd));
    let prefix = 0, ae = a.length, be = b.length;
    while (prefix < ae && prefix < be && a[prefix] === b[prefix]) prefix++;
    while (ae > prefix && be > prefix && a[ae - 1] === b[be - 1]) { ae--; be--; }
    const ap = offsets(a);
    const n = ae - prefix, m = be - prefix;
    if (!n && !m) return;
    const cells = (n + 1) * (m + 1);
    if (!n || !m || cells > REVISION_LIMITS.cells || cells > remaining) {
      coarse(start + ap[prefix], start + ap[ae], b.slice(prefix, be).join(''), n && m ? '精细差异计算达到有界资源上限，已使用粗粒度完整替换；未丢弃任何修改' : null);
      return;
    }
    remaining -= cells;
    const width = m + 1, table = new Uint32Array(cells);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[prefix + i] === b[prefix + j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
    let i = 0, j = 0, si = null, sj = null;
    const flush = () => {
      if (si !== null) coarse(start + ap[prefix + si], start + ap[prefix + i], b.slice(prefix + sj, prefix + j).join(''));
      si = sj = null;
    };
    while (i < n || j < m) {
      if (i < n && j < m && a[prefix + i] === b[prefix + j]) { flush(); i++; j++; }
      else {
        if (si === null) { si = i; sj = j; }
        if (j < m && (i === n || table[i * width + j + 1] > table[(i + 1) * width + j])) j++;
        else i++;
      }
    }
    flush();
  }
  let start = 0, otherStart = 0;
  for (const anchor of anchors(before, after)) {
    gap(start, anchor.start, otherStart, anchor.otherStart);
    start = anchor.end; otherStart = anchor.otherEnd;
  }
  gap(start, before.length, otherStart, after.length);
  // Adjacent changes are one decision, avoiding ambiguous insert/delete ordering.
  const merged = [];
  for (const hunk of raw) {
    const last = merged.at(-1);
    if (last && last.end === hunk.start) { last.end = hunk.end; last.before += hunk.before; last.after += hunk.after; }
    else merged.push({ ...hunk });
  }
  let result = merged;
  if (result.length > REVISION_LIMITS.hunks) {
    result = [{ start: 0, end: before.length, before, after }];
    warnings.add('修改数量超过 256 处，已使用整章粗粒度替换；未丢弃任何修改');
  }
  const seed = createHash('sha256').update(before).update('\0').update(after).digest('hex');
  result = result.map((hunk, index) => ({ id: uuid(seed, index, hunk), ...hunk, state: 'pending' }));
  // Defensive algebra self-check: no diff implementation can publish partial output.
  if (applyHunks(before, result, ['pending']) !== after) invalid('修订差异未能完整重建目标正文');
  for (const warning of warnings) onFallback?.(warning);
  return result;
}

export function applyHunks(source, hunks, states = ['accepted']) {
  checkText(source);
  if (!Array.isArray(hunks) || hunks.length > REVISION_LIMITS.hunks || !Array.isArray(states) || states.some(state => !['pending', 'accepted', 'rejected'].includes(state))) invalid('修订差异或筛选状态无效');
  const output = [];
  let cursor = 0, previousEnd = -1, previousStart = -1;
  for (const hunk of hunks) {
    if (!hunk || !Number.isSafeInteger(hunk.start) || !Number.isSafeInteger(hunk.end) || hunk.start < 0 || hunk.end < hunk.start || hunk.end > source.length || (hunk.start < previousEnd || hunk.start === previousStart) || !revisionBoundary(source, hunk.start) || !revisionBoundary(source, hunk.end)) invalid('修订范围重叠、未排序或切断 Unicode/CRLF');
    checkText(hunk.before); checkText(hunk.after);
    if (hunk.before !== source.slice(hunk.start, hunk.end) || hunk.before === hunk.after || !['pending', 'accepted', 'rejected'].includes(hunk.state)) invalid('修订片段与原文不一致或没有变化');
    previousEnd = hunk.end; previousStart = hunk.start;
    if (states.includes(hunk.state)) { output.push(source.slice(cursor, hunk.start), hunk.after); cursor = hunk.end; }
  }
  output.push(source.slice(cursor));
  const result = output.join('');
  checkText(result);
  return result;
}

export function revisionPreview(proposal) {
  if (!proposal || proposal.mode !== 'revise' || !proposal.review) invalid('需要逐处修订候选');
  const { sourceBody: source, review: { hunks } } = proposal;
  const text = applyHunks(source, hunks, ['pending', 'accepted']);
  const segments = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.start > cursor) segments.push({ key: `unchanged-${cursor}`, type: 'unchanged', text: source.slice(cursor, hunk.start) });
    segments.push({ key: hunk.id, type: 'change', text: hunk.state === 'rejected' ? hunk.before : hunk.after, hunk });
    cursor = hunk.end;
  }
  if (cursor < source.length || !segments.length) segments.push({ key: `unchanged-${cursor}`, type: 'unchanged', text: source.slice(cursor) });
  return { segments, text };
}
