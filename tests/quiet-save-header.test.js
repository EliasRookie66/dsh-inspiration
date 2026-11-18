import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf("          const renderTopbar =");
const errorStart = source.indexOf("          error &&", start);
const errorEnd = source.indexOf("          h('div', { ref: contentRef", errorStart);
assert(start > 0 && errorStart > start && errorEnd > errorStart);
const header = source.slice(start, source.indexOf("          return h('main'", start)), errorControls = source.slice(errorStart, errorEnd);

function absentPanel(text) {
  for (const forbidden of ['mx-save-controls', "t('autosaveHint')", "t('saveNow')", "t('discard')", "t('unsaved')", "t('saved')"]) {
    assert(!text.includes(forbidden), 'No header save panel, static hint or fallback buttons: ' + forbidden);
  }
  assert(!text.includes("h('h1'"));
  assert(text.includes("pageButton('tools', 'workspaceTools')"));
}
function errorOnlyRetry(text) {
  assert(text.trimStart().startsWith('error &&'), 'Retry is conditional on an actual error');
  assert(text.includes('h(Modal,'), 'Failures use an actual alert dialog, not a permanent banner');
  for (const flag of ['guard', 'confirm', 'manager', 'polishRequirements']) assert(text.includes('!' + flag));
  assert(text.includes("button(t('autosaveRetry'), saveAll"));
  assert(text.includes('!autosaveCanSave(w, autosaveRef.current)'), 'Uncertain apparent-clean writes remain retryable');
  assert(text.includes("button(t('reviewLatest'), inspectConflict)"));
}

test('upper-right header has no save panel; automatic saving and conditional error recovery remain', () => {
  absentPanel(header); errorOnlyRetry(errorControls);
  assert(source.includes("guard && h(Modal, { title: t('unsavedTitle')"));
  assert(source.includes('if (autosaveCanSave(current.current, autosaveRef.current) && !busyRef.current) saveAll()'));
  assert(source.includes("onBlurCapture:"));
});

test('regression assertions reject restored header controls and weakened error retry gating', () => {
  for (const token of ['mx-save-controls', "t('autosaveHint')", "t('saveNow')", "t('discard')"]) {
    assert.throws(() => absentPanel(header + token));
  }
  assert.throws(() => errorOnlyRetry(errorControls.replace('error &&', 'true &&')));
  assert.throws(() => errorOnlyRetry(errorControls.replace('!autosaveCanSave(w, autosaveRef.current)', '!anyDirty')));
});
