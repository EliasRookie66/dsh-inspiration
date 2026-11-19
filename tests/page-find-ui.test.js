import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const source = read('client.js');
function region(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}
const keys = region('    function findShortcut(', '    function PageFind(');
const findShortcut = new Function(keys + '\nreturn findShortcut;')();
const handler = region('          const handlePageFindKey =', '          useEffect(');
function invoke(overrides, state = {}) {
  const actions = [];
  const env = { findBlocked: false, findOpen: false, autosaveComposing: { current: false }, composing: { current: false }, findInputRef: { current: null }, findShortcut,
    openPageFind() { actions.push('open'); return true; }, dismissPageFind() { actions.push('close'); }, ...state };
  const run = new Function('env', 'with(env) {' + handler + '\nreturn handlePageFindKey;}')(env);
  run({ key: 'f', ctrlKey: true, preventDefault() { actions.push('prevent'); }, stopPropagation() { actions.push('stop'); }, ...overrides });
  return actions;
}

test('find consumes only an eligible local Ctrl+F / Cmd+F or Escape when open', () => {
  for (const chord of [{}, { key: 'F', ctrlKey: false, metaKey: true }]) assert.deepEqual(invoke(chord), ['open', 'prevent', 'stop']);
  for (const ignored of [{ key: 's' }, { ctrlKey: false }, { shiftKey: true }, { altKey: true }, { repeat: true },
    { defaultPrevented: true }, { isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }]) assert.deepEqual(invoke(ignored), []);
  for (const blocked of [{ findBlocked: true }, { composing: { current: true } }, { autosaveComposing: { current: true } }, { findInputRef: { current: { dataset: { findComposing: 'true' } } } }]) assert.deepEqual(invoke({}, blocked), []);
  assert.deepEqual(invoke({ key: 'Escape', ctrlKey: false }), []);
  assert.deepEqual(invoke({ key: 'Escape', ctrlKey: false }, { findOpen: true }), ['prevent', 'stop', 'close']);
});

test('writing queries only the current native manuscript and cannot search a proposal preview', () => {
  const bar = region('    function PageFind(', '    function Modal(');
  assert.match(bar, /writing \? page\.querySelector\('\.mx-body-slot textarea\.mx-editor'\) : page/);
  assert.match(bar, /unavailable: writing && !root/);
  assert.match(bar, /current\.unavailable \? t\('findNoChapterBody'\)/);
  assert.match(source, /ref: findPageRef, className: 'mx-writing-host' \}, renderCurrentPage\(\)/);
  assert.match(source, /scope: tab .*w\?\.book\.id.*tab === 'writing' \? w\?\.chapterId/);
});

test('floating find leaves selection and data alone, is reachable by button, and uses no host-wide key registration', () => {
  const bar = region('    function PageFind(', '    function Modal(');
  assert.match(source, /toolbarButton\('find', t\('findText'\), openPageFind/);
  assert.match(source, /event.target === doc.body && doc.activeElement === doc.body/);
  assert.match(source, /\.mx-find-anchor\{[^}]*height:0/);
  assert.match(source, /\.mx-find-bar\{[^}]*position:absolute/);
  assert.match(source, /\.mx-find-marks\{[^}]*pointer-events:none/);
  for (const code of [bar, read('find-overlay.js'), read('page-find.js')])
    assert.doesNotMatch(code, /setSelectionRange\(|(?<!Ref\.current\?\.)\.select\(|getSelection\(|(?:generate|commit|mutateRaw|saveAll)\(|\.value\s*=(?![=>])/);
  assert.doesNotMatch(bar, /showModal|aria-modal|onKeyDown.*Tab/);
  assert.match(bar, /move\(event.shiftKey \? -1 : 1\)/);
  assert.match(bar, /observer\.disconnect\(\)/);
});
