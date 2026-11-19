// Geometry for page find. Use a temporary hidden mirror for textareas rather
// than changing the real field's selection (which belongs to the author).
const boxProperties = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
  'fontFeatureSettings', 'fontVariationSettings', 'fontKerning', 'lineHeight', 'letterSpacing', 'wordSpacing',
  'textIndent', 'textTransform', 'textAlign', 'textRendering', 'tabSize', 'overflowWrap', 'wordBreak', 'hyphens',
  'direction', 'writingMode', 'lineBreak', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

function rect(left, top, right, bottom) { return { left, top, right, bottom }; }
const shift = (r, x, y) => rect(r.left + x, r.top + y, r.right + x, r.bottom + y);
const area = r => r.right > r.left && r.bottom > r.top;
const intersect = (a, b, x = true, y = true) => rect(x ? Math.max(a.left, b.left) : a.left,
  y ? Math.max(a.top, b.top) : a.top, x ? Math.min(a.right, b.right) : a.right, y ? Math.min(a.bottom, b.bottom) : a.bottom);
function viewport(node) {
  const { left, top } = node.getBoundingClientRect();
  const x = left + node.clientLeft, y = top + node.clientTop;
  return rect(x, y, x + node.clientWidth, y + node.clientHeight);
}
const clips = value => /^(auto|scroll|hidden|clip|overlay)$/.test(value);
const scrolls = value => /^(auto|scroll|hidden|overlay)$/.test(value);

export function findFieldRects(hit, root) {
  const { node, start, end } = hit;
  if (node.tagName !== 'TEXTAREA') return null;
  const value = node.value;
  if (!root.contains(node) || !node.clientWidth || start < 0 || end <= start || end > value.length) return [];
  const doc = node.ownerDocument, computed = doc.defaultView.getComputedStyle(node);
  const clip = doc.createElement('div'), mirror = doc.createElement('div');
  clip.setAttribute('aria-hidden', 'true'); clip.inert = true;
  Object.assign(clip.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', overflow: 'hidden',
    contain: 'strict', visibility: 'hidden', pointerEvents: 'none' });
  Object.assign(mirror.style, { position: 'absolute', left: '0', top: '0', width: node.clientWidth + 'px', height: 'auto',
    boxSizing: 'border-box', margin: '0', border: '0', overflow: 'visible', whiteSpace: node.wrap === 'off' ? 'pre' : computed.whiteSpace || 'pre-wrap' });
  for (const property of boxProperties) mirror.style[property] = computed[property];
  const text = doc.createTextNode(value + (value.endsWith('\n') ? '\u200b' : ''));
  mirror.append(text); clip.append(mirror);
  try {
    root.append(clip);
    const range = doc.createRange(); range.setStart(text, start); range.setEnd(text, end);
    const box = mirror.getBoundingClientRect();
    return Array.from(range.getClientRects(), r => shift(r, -box.left, -box.top)).filter(area).slice(0, 24);
  } finally { clip.remove(); }
}

function absoluteRects(hit, local) {
  if (hit.kind === 'text') return Array.from(hit.range.getClientRects()).filter(area).slice(0, 24);
  const { node } = hit;
  if (!local?.length) return [node.getBoundingClientRect()];
  const v = viewport(node);
  return local.map(r => shift(r, v.left - node.scrollLeft, v.top - node.scrollTop));
}

function startNode(hit) { return hit.kind === 'field' ? hit.node : hit.range.startContainer.parentElement || hit.node; }

function scrollAxis(current, start, end, low, high) {
  if (start >= low && end <= high) return current;
  if (end - start > high - low || start < low) return current + start - low;
  return current + end - high;
}

export function revealFindHit(hit, root, local) {
  if (!hit || !root.contains(hit.node)) return;
  const view = root.ownerDocument.defaultView;
  // Only scroll the plugin's own ancestors, including the textarea, never the DSH shell.
  for (let node = startNode(hit); node && node !== root; node = node.parentElement) {
    const style = view.getComputedStyle(node), isField = hit.kind === 'field' && hit.node === node;
    const horizontal = (isField || scrolls(style.overflowX)) && node.scrollWidth > node.clientWidth;
    const vertical = (isField || scrolls(style.overflowY)) && node.scrollHeight > node.clientHeight;
    if ((!horizontal && !vertical) || (isField && !local?.length)) continue;
    // Once the native field has scrolled, scroll the ancestors to its visible hit.
    let place = absoluteRects(hit, local)[0];
    if (place && local?.length && node !== hit.node) place = intersect(place, viewport(hit.node));
    if (!place || !area(place)) continue;
    const frame = viewport(node);
    if (vertical) node.scrollTop = scrollAxis(node.scrollTop, place.top, place.bottom, frame.top + 10, frame.bottom - 10);
    if (horizontal) node.scrollLeft = scrollAxis(node.scrollLeft, place.left, place.right, frame.left + 7, frame.right - 7);
  }
}

export function paintFindHit(hit, root, local) {
  if (!hit || !root.contains(hit.node)) return [];
  const rootBox = viewport(root), view = root.ownerDocument.defaultView;
  let visible = absoluteRects(hit, local);
  for (let node = startNode(hit); node && node !== root; node = node.parentElement) {
    if (node === hit.node && hit.kind === 'field' && !local?.length) continue;
    const style = view.getComputedStyle(node), isField = node === hit.node && hit.kind === 'field';
    const x = isField || clips(style.overflowX), y = isField || clips(style.overflowY);
    if ((x || y) && node.clientWidth && node.clientHeight) {
      const frame = viewport(node);
      visible = visible.map(r => intersect(r, frame, x, y)).filter(area);
    }
  }
  return visible.map(r => intersect(r, rootBox)).filter(area).map(r => ({
    left: r.left - rootBox.left, top: r.top - rootBox.top,
    width: r.right - r.left, height: r.bottom - r.top,
  }));
}
