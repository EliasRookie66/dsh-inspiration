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

test('book selector and actions use scoped bottom alignment and identical control heights', () => {
  assert.equal(source.split("className: 'mx-row mx-book-row'").length, 2);
  const row = source.slice(source.indexOf("className: 'mx-row mx-book-row'"), source.indexOf("loading && h('p'", source.indexOf("className: 'mx-row mx-book-row'")));
  for (const entry of ["label: t('book')", "button(t('manageBooks')", "button(t('refresh')"]) assert(row.includes(entry));
  assert.equal(rule('.mx-book-row')['align-items'], 'flex-end');
  for (const selector of ['.mx-root .mx-book-row select', '.mx-root .mx-book-row>button']) {
    assert.equal(rule(selector).height, '40px');
    assert.equal(rule(selector)['min-height'], '40px');
  }
  assert.equal(rule('.mx-book-row>button')['flex-shrink'], '0');
  assert.equal(rule('.mx-book-row>button')['white-space'], 'nowrap');
});

test('fix retains wrapping and does not change shared action-row alignment', () => {
  assert.equal(rule('.mx-row')['flex-wrap'], 'wrap');
  assert.equal(rule('.mx-row')['align-items'], 'center');
  assert.equal(rule('.mx-actions')['align-items'], 'center');
  assert(!Object.hasOwn(rule('.mx-book-row'), 'flex-wrap'));
});
