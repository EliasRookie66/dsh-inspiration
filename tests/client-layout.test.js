import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Source/CSS contracts only, not a renderer or visual-layout verification.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const css = source.slice(source.indexOf('    const CSS = `') + 17, source.indexOf('\n`;', source.indexOf('    const CSS = `')));
const rule = selector => {
  const match = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) => selectors.split(',').map(s => s.trim()).includes(selector));
  assert(match, 'Missing scoped CSS rule: ' + selector);
  return Object.fromEntries(match[2].split(';').filter(Boolean).map(declaration => declaration.split(':').map(value => value.trim())));
};

test('shared header contains the labelled book picker and direct book actions on every page', () => {
  const header = source.slice(source.indexOf('          const renderTopbar ='), source.indexOf("          return h('main'"));
  assert.match(header, /mx-topbar-book[\s\S]*renderBookPicker\(\)/);
  for (const entry of ["pageButton('tools', 'workspaceTools')", "pageButton('manage', 'manageBooks')", "pageButton('context', 'context')", "pageButton('advanced', 'advanced')", "t('refresh'), refreshWorkspace"]) assert(header.includes(entry), entry);
  assert.match(source, /renderBookPicker = \(\) => h\(Field, \{ label: t\('book'\), visuallyHidden: true \}/);
  assert.match(source, /case 'tools': return renderBookTools\(\)/);
  assert.doesNotMatch(source, /toolsOpen|toggleTools|beginManagement/);
  assert(!source.includes('mx-book-row'));
  assert.equal(rule('.mx-topbar-book>.mx-field')['min-width'], '0');
});

test('top groups wrap without narrowing or clipping the original shared action rows', () => {
  assert.equal(rule('.mx-topbar')['flex-wrap'], 'wrap');
  assert.equal(rule('.mx-topbar-group')['flex-wrap'], 'wrap');
  assert.equal(rule('.mx-toolbar-hit').flex, 'none');
  assert.equal(rule('.mx-row')['flex-wrap'], 'wrap');
  assert.equal(rule('.mx-actions')['align-items'], 'center');
});
