import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cycleFindIndex, literalFind, PAGE_FIND_MAX_QUERY_LENGTH, scanPageFind } from '../page-find.js';

const ranges = (...pairs) => pairs.map(([start, end]) => ({ start, end }));

test('find is literal, case-insensitive, and does not overlap', () => {
  assert.deepEqual(literalFind('aaaAA', 'aa'), { hits: ranges([0, 2], [2, 4]), limited: false });
  const punctuation = '[X].*+$^?{}()|/\\';
  assert.deepEqual(literalFind(`x${punctuation} ${punctuation.toLowerCase()}`, punctuation), {
    hits: ranges([1, 1 + punctuation.length], [2 + punctuation.length, 2 + 2 * punctuation.length]), limited: false,
  });
  assert.deepEqual(literalFind('a b\na\tb\na b', 'a b').hits, ranges([0, 3], [8, 11]));
  assert.deepEqual(literalFind('a\nb\nA\nB', 'a\nb').hits, ranges([0, 3], [4, 7]));
  assert.deepEqual(literalFind('dark  matter', '  ').hits, ranges([4, 6]));
});

test('Unicode simple case folding leaves original UTF-16 offsets intact', () => {
  assert.deepEqual(literalFind('İ🧪CAFÉ cafe\u0301 café', 'café').hits, ranges([3, 7], [14, 18]));
  const text = '🧪ΣςσKkſS𐐀𐐨';
  assert.deepEqual(literalFind(text, 'σ').hits, ranges([2, 3], [3, 4], [4, 5]));
  assert.deepEqual(literalFind(text, 'k').hits, ranges([5, 6], [6, 7]));
  assert.deepEqual(literalFind(text, 's').hits, ranges([7, 8], [8, 9]));
  assert.deepEqual(literalFind(text, '𐐨').hits, ranges([9, 11], [11, 13]));
  assert.deepEqual(literalFind('Straße', 'STRASSE').hits, []);
});

test('result overflow is reported only after the cap, and the global cap cannot be raised', () => {
  assert.deepEqual(literalFind('aAa', 'a', 2), { hits: ranges([0, 1], [1, 2]), limited: true });
  assert.deepEqual(literalFind('aAb', 'a', 2), { hits: ranges([0, 1], [1, 2]), limited: false });
  assert.deepEqual(literalFind('b', 'a', 0), { hits: [], limited: false });
  assert.deepEqual(literalFind('a', 'a', 0), { hits: [], limited: true });
  assert.equal(literalFind('a'.repeat(10_000), 'a').limited, false);
  const excess = literalFind('a'.repeat(10_001), 'a', 20_000);
  assert.equal(excess.hits.length, 10_000);
  assert.deepEqual(excess.hits.at(-1), { start: 9_999, end: 10_000 });
  assert.equal(excess.limited, true);
});

test('input budgets report a partial scan without inventing a half-surrogate hit', () => {
  const atLimit = 'z'.repeat(PAGE_FIND_MAX_QUERY_LENGTH);
  assert.deepEqual(literalFind(atLimit, atLimit), { hits: ranges([0, atLimit.length]), limited: false });
  assert.deepEqual(literalFind(atLimit + 'z', atLimit + 'z'), { hits: [], limited: true });
  const prefix = 'z'.repeat(999_999);
  assert.deepEqual(literalFind(prefix + 'q', 'q'), { hits: ranges([999_999, 1_000_000]), limited: false });
  assert.deepEqual(literalFind(prefix + 'qx', 'x'), { hits: [], limited: true });
  assert.deepEqual(literalFind(prefix + '🧪', '\uD83E'), { hits: [], limited: true });
});

test('empty queries and missing roots do not search; navigation cycles in either direction', () => {
  for (const [text, query] of [['text', ''], ['', 'x'], ['text', null], [null, 'x']]) {
    assert.deepEqual(literalFind(text, query), { hits: [], limited: false });
  }
  assert.deepEqual(scanPageFind(null, 'x'), { hits: [], limited: false });
  assert.equal(cycleFindIndex(0, 1, 0), -1);
  assert.equal(cycleFindIndex(-1, 1, 3), 0);
  assert.equal(cycleFindIndex(-1, -1, 3), 2);
  assert.equal(cycleFindIndex(0, -1, 3), 2);
  assert.equal(cycleFindIndex(2, 1, 3), 0);
  assert.equal(cycleFindIndex(2, -1, 3), 1);
  assert.equal(cycleFindIndex(0, 1, 1), 0);
  assert.equal(cycleFindIndex(7, -1, 3), 2);
});

test('DOM adapter source is a read-only subtree search, not native find or an editor action', () => {
  // This checks source boundaries, not rendered visibility or Range geometry.
  // No test constructs a DOM, opens a browser, or reads a real document.
  const source = readFileSync(new URL('../page-find.js', import.meta.url), 'utf8');
  assert.match(source, /\broot\.ownerDocument\b/);
  assert.match(source, /\bdoc\.createRange\s*\(/);
  assert.match(source, /\bnode\.value\b/);
  assert.match(source, /=>\s*\(\{ kind: 'field', node, start, end \}\)/);
  assert.match(source, /return \{ kind: 'text', range, node:/);
  assert.match(source, /\[data-page-find-ignore\]/);
  assert.doesNotMatch(source, /\b(?:window|document|globalThis)\s*\./);
  assert.doesNotMatch(source, /\b(?:execCommand|querySelector(?:All)?|getSelection|setSelectionRange|focus|scrollIntoView|dispatchEvent|appendChild|replaceChildren|fetch)\s*\(/);
  assert.doesNotMatch(source, /\bnode\.value\s*=(?!=)/);
});
