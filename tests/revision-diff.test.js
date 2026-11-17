import test from 'node:test';
import assert from 'node:assert/strict';
import { diffText, applyHunks, revisionPreview, revisionBoundary, REVISION_LIMITS } from '../revision.js';

function verify(before, after) {
  const hunks = diffText(before, after);
  assert.equal(applyHunks(before, hunks, ['pending']), after);
  assert.equal(applyHunks(before, hunks), before);
  assert.deepEqual(diffText(before, after), hunks, 'diff and helper UUID assignment are deterministic');
  let end = -1;
  for (const hunk of hunks) {
    assert.match(hunk.id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    assert.ok(hunk.start >= end); end = hunk.end;
    assert.equal(before.slice(hunk.start, hunk.end), hunk.before);
    assert.notEqual(hunk.before, hunk.after);
    assert.ok(revisionBoundary(before, hunk.start) && revisionBoundary(before, hunk.end));
  }
  return hunks;
}

test('real diff reconstructs repeated passages, separated edits, insertion/deletion edges and noops', () => {
  for (const pair of [
    ['', '新增😀\r\n'], ['全文删除😀\r\n', ''], ['same', 'same'],
    ['重复。中间甲。重复。中间乙。重复。', '重复。中间A。重复。中间B。重复。'],
    ['alpha\nbeta\ngamma\n', 'NEW\nalpha\nBETA\ngamma\nEND'],
    ['前😀甲\r\n中😺乙\r\n后', '始前😺甲\r\n中😀乙\r\n后终'],
    ['a\r\nb', 'a\nb'], ['a\rb', 'a\r\nb'], ['\rX\n', '\r\n'],
    ['🙂🙂🙂', '🙂😺🙂'], ['abc', 'zabcZ'], ['abc', 'ac'],
  ]) verify(...pair);
  assert.ok(verify('重复甲重复乙重复丙', '重复A重复B重复C').length >= 3, 'does not silently collapse ordinary precise edits');
});

test('all subsets, in every confirmation order, use original positions not ambiguous substring replacement', () => {
  const source = '相同甲相同乙相同丙';
  const hunks = verify(source, '相同A相同B相同C');
  assert.equal(hunks.length, 3);
  const permutations = list => list.length ? list.flatMap((item, i) => permutations(list.filter((_, j) => i !== j)).map(rest => [item, ...rest])) : [[]];
  for (let mask = 0; mask < 8; mask++) for (const order of permutations([0, 1, 2])) {
    const changes = structuredClone(hunks);
    for (const i of order) changes[i].state = mask & 1 << i ? 'accepted' : 'rejected';
    const expected = `相同${mask & 1 ? 'A' : '甲'}相同${mask & 2 ? 'B' : '乙'}相同${mask & 4 ? 'C' : '丙'}`;
    assert.equal(applyHunks(source, changes), expected);
    assert.equal(revisionPreview({ mode: 'revise', sourceBody: source, review: { hunks: changes } }).text, expected);
  }
});

test('preview shows all optimized changes but preserves rejected originals and visible empty deletion segments', () => {
  const sourceBody = '甲旧乙删丙';
  const hunks = diffText(sourceBody, '甲新乙丙');
  const proposal = { mode: 'revise', sourceBody, review: { hunks } };
  const preview = revisionPreview(proposal);
  assert.equal(preview.text, '甲新乙丙');
  assert.equal(preview.segments.map(part => part.text).join(''), preview.text);
  assert.ok(preview.segments.some(part => part.type === 'change' && part.text === '' && part.hunk.before === '删'));
  hunks[0].state = 'rejected';
  assert.equal(revisionPreview(proposal).text, '甲旧乙丙');
  assert.equal(revisionPreview({ mode: 'revise', sourceBody, review: { hunks: [] } }).text, sourceBody);
});

test('bounded big inputs fall back explicitly, retain all bytes, cap hunk count and reject malformed input', () => {
  const warnings = [];
  const before = '甲'.repeat(200_000), after = '乙'.repeat(200_000);
  const start = performance.now();
  const hunks = diffText(before, after, { onFallback: message => warnings.push(message) });
  assert.ok(performance.now() - start < 4000, 'bounded work, not chapter-sized quadratic LCS');
  assert.equal(hunks.length, 1);
  assert.equal(applyHunks(before, hunks, ['pending']), after);
  assert.match(warnings.join(''), /粗粒度.*未丢弃/);
  const a = Array.from({ length: 300 }, (_, i) => `原${i}\n锚${i}\n`).join('');
  const b = a.replaceAll('原', '改');
  const countWarnings = [];
  const coarse = diffText(a, b, { onFallback: warning => countWarnings.push(warning) });
  assert.equal(coarse.length, 1);
  assert.ok(coarse.length <= REVISION_LIMITS.hunks);
  assert.match(countWarnings.join(''), /256/);
  assert.equal(applyHunks(a, coarse, ['pending']), b);
  for (const pair of [['\ud800', 'a'], ['a', '\udc00'], ['x'.repeat(200001), '']]) assert.throws(() => diffText(...pair));
});

test('seeded Unicode/CRLF randomized differential reconstruction', () => {
  let seed = 37481;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = ['甲', '乙', 'a', 'b', '😀', '😺', '\r\n', '\n', '\r'];
  for (let round = 0; round < 300; round++) {
    const source = Array.from({ length: next(60) }, () => alphabet[next(alphabet.length)]).join('');
    const target = Array.from({ length: next(60) }, () => alphabet[next(alphabet.length)]).join('');
    verify(source, target);
  }
});
