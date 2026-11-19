import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf("          const renderTopbar =");
assert(start > 0);
const header = source.slice(start, source.indexOf("          return h('main'", start));

function absentPanel(text) {
  for (const forbidden of ['mx-save-controls', "t('autosaveHint')", "t('saveNow')", "t('discard')", "t('unsaved')", "t('saved')"]) {
    assert(!text.includes(forbidden), 'No header save panel, static hint or fallback buttons: ' + forbidden);
  }
  assert(!text.includes("h('h1'"));
  assert(text.includes("pageButton('tools', 'workspaceTools')"));
}
function errorOnlyRetry(text) {
  assert.match(text, /w && autosaveRef\.current\?\.failed && toolbarButton\('save', t\('autosaveRetry'\), saveAll/);
  assert(text.includes('!autosaveCanSave(w, autosaveRef.current)'), 'Uncertain apparent-clean writes remain retryable');
}

test('upper-right header has no save panel; automatic saving and conditional error recovery remain', () => {
  absentPanel(header); errorOnlyRetry(header);
  assert(source.includes("guard && h(Modal, { title: t('unsavedTitle')"));
  assert(source.includes('if (autosaveCanSave(current.current, autosaveRef.current) && !busyRef.current) saveAll()'));
  assert(source.includes("onBlurCapture:"));
});

test('regression assertions reject restored header controls and weakened error retry gating', () => {
  for (const token of ['mx-save-controls', "t('autosaveHint')", "t('saveNow')", "t('discard')"]) {
    assert.throws(() => absentPanel(header + token));
  }
  assert.throws(() => errorOnlyRetry(header.replace('autosaveRef.current?.failed &&', 'true &&')));
  assert.throws(() => errorOnlyRetry(header.replace('!autosaveCanSave(w, autosaveRef.current)', '!anyDirty')));
});
