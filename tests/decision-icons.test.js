// Source/style contract only. This does not emulate React/DOM or claim a rendered
// Cursor pixel match, pointer hit test, screen-reader or keyboard execution.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function iconContract(text) {
  assert(!/[✅❌✔✖✕✓×]/u.test(text), 'Decision icons/hints must not render font glyphs or emoji');
  const start = text.indexOf('          const decisionButton ='), end = text.indexOf('          const input =', start);
  assert(start >= 0 && end > start);
  const icon = text.slice(start, end);
  for (const required of ["=> button(", "h('svg'", 'width: 16, height: 16', "fill: 'none'", "stroke: 'currentColor'", 'strokeWidth: 1.7', "strokeLinecap: 'round'", "strokeLinejoin: 'round'", "'aria-hidden': true", "focusable: 'false'", "accept ? 'M5 12l4 4L19 6' : 'M6 6l12 12M18 6 6 18'", "onClick, { 'aria-label': label, title: label, ...props"])
    assert(icon.includes(required), 'Missing native/SVG contract: ' + required);
  for (const css of ['width:32px;height:32px;min-height:32px;padding:0', '.mx-decision-accept{color:var(--dsw-alias-state-success-primary)}', '.mx-decision-reject{color:var(--dsw-alias-state-error-primary)}', '.mx-decision:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)', ':hover:not(:disabled)']) assert(text.includes(css), 'Missing theme/interaction contract: ' + css);
}
test('static style contract: both decisions are native accessible line-SVG buttons, never text glyphs', () => iconContract(source));
test('static wiring: SVG controls retain all four exact author handlers and disabled source guards', () => {
  for (const [label, handler, guard] of [
    ["true, t('polishAccept')", 'applyPolish(snapshot, true)', 'polishProblem'],
    ["false, t('polishReject')", 'applyPolish(snapshot, false)', 'polishRejectProblem'],
    ["true, t('revisionAcceptLabel', { number })", 'applyRevisionHunk(snapshot, true)', 'problem'],
    ["false, t('revisionRejectLabel', { number })", 'applyRevisionHunk(snapshot, false)', 'problem'],
  ]) {
    const line = source.split('\n').find(value => value.includes('decisionButton(' + label));
    assert(line && line.includes(handler) && line.includes('disabled: !!' + guard) && line.includes("'aria-describedby':"), label);
  }
});
test('static icon oracle detects unsafe emoji, unnamed, non-native, filled and focusless variants', () => {
  for (const [before, after] of [
    ["h('svg', { width: 16", "h('span', { title: '✅', width: 16"],
    ["=> button(\n            h('svg'", "=> h('div',\n            h('svg'"],
    ["onClick, { 'aria-label': label, title: label, ...props", 'onClick, { ...props'],
    ["width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none'", "width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor'"],
    ['.mx-decision:focus-visible{outline:2px', '.mx-decision:focus{outline:2px'],
  ]) {
    const anchor = before.startsWith('.mx-') ? 0 : source.indexOf('          const decisionButton =');
    const from = source.indexOf(before, anchor); assert(from >= anchor);
    const broken = source.slice(0, from) + after + source.slice(from + before.length); assert.notEqual(broken, source); assert.throws(() => iconContract(broken));
  }
});
