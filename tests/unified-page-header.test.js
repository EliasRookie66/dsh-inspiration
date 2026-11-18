import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source contracts, not browser-computed geometry or tooltip timing assertions.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const region = (text, from, to) => {
  const start = text.indexOf(from), end = text.indexOf(to, start);
  assert(start >= 0 && end > start, from);
  return text.slice(start, end);
};
const css = region(source, '    const CSS = `', '\n`;');
const rule = selector => {
  const pattern = selector + '{', start = css.indexOf(pattern);
  assert(start >= 0, selector);
  return css.slice(start + pattern.length, css.indexOf('}', start));
};
function toolbarContract(text) {
  const top = region(text, '          const pageButton =', '          const renderCurrentPage =');
  const main = region(text, "          return h('main'", '          renderSelectionPopup(),');
  assert.equal((main.match(/renderTopbar\(\)/g) || []).length, 1);
  assert.match(main, /}, h\('style', null, CSS\),\s*renderTopbar\(\),/);
  assert(main.indexOf('renderTopbar()') < main.indexOf("ref: contentRef, className: 'mx-content-pane'"));
  assert.doesNotMatch(top + main, /t\('(?:title|subtitle)'\)|h\('h1'|mx-brand/);
  assert.doesNotMatch(top, /hidden: folded|compactWriting/);
  assert.match(top, /h\('nav', \{ className: 'mx-topbar-group', 'aria-label': t\('pages'\) \}, \['writing', 'constraints', 'cards', 'settings', 'history'\]/);
  assert.match(top, /toolbarButton\(value, t\(label\),[\s\S]*'aria-pressed': tab === value/);
  assert.match(top, /pageButton\('tools', 'workspaceTools'\), pageButton\('manage', 'manageBooks'\), pageButton\('context', 'context'\), pageButton\('advanced', 'advanced'\)/);
  assert.doesNotMatch(top, /'aria-haspopup'|toolsOpen|!folded/);
  const icon = region(text, '          const toolbarButton =', '          const decisionButton =');
  assert.match(icon, /className: 'mx-toolbar-hit', title/);
  assert.match(icon, /title = label/);
  assert.match(icon, /'aria-label': dirty \? t\('savedTabsDirty', \{ page: label \}\) : label/);
  assert.match(icon, /'aria-hidden': true, focusable: 'false'/);
  assert.match(icon, /h\('path', \{ d: toolbarIcons\[name\] \}\)/);
}

test('writing and utility pages use one pinned toolbar with the four utilities in order', () => toolbarContract(source));
test('toolbar oracle rejects ancestor-scrolling placement, restored branding and unnamed SVG entries', () => {
  for (const [from, to] of [
    ['          renderTopbar(),\n', ''],
    ["className: 'mx-topbar' },", "className: 'mx-topbar' }, h('h1', null, t('title')),"],
    ["className: 'mx-toolbar-hit', title", "className: 'mx-toolbar-hit'"],
    ["'aria-label': dirty ?", "'aria-description': dirty ?"],
    ["pageButton('manage', 'manageBooks'), pageButton('context', 'context')", "pageButton('context', 'context'), pageButton('manage', 'manageBooks')"],
  ]) {
    assert(source.includes(from)); assert.throws(() => toolbarContract(source.replace(from, to)));
  }
});

test('shared font scale keeps manuscript, Markdown, settings, card and history content at 16px', () => {
  const root = rule('.mx-root');
  for (const token of ['--mx-ui-size:14px', '--mx-field-size:13px', '--mx-meta-size:12px', '--mx-content-size:16px', '--mx-section-size:17px']) assert(root.includes(token));
  assert(rule('.mx-root h2').includes('font-size:var(--mx-section-size)'));
  assert(rule('.mx-editor').includes('font-size:var(--mx-content-size)'));
  assert(rule('.mx-revision-preview').includes('font-size:var(--mx-content-size)'));
  assert(rule('.mx-root textarea,.mx-constraints-editor-host,.mx-card p,.mx-history-surface pre').includes('font-size:var(--mx-content-size)'));
  assert(rule('.mx-root .mx-topbar select').includes('font-size:var(--mx-ui-size)'));
  assert(!/\.mx-root-writing[^{}]*\{[^{}]*font-size:/.test(css));
});

test('writing retains status and disabled reasons while preview is a separate destination', () => {
  const actions = region(source, '          const writingTaskProblem =', '          const pageButton =');
  for (const token of ['running || awaitingOutcome', "['failed', 'cancelled']", "t('pollError')", "t('retry')", 'notice']) assert(actions.includes(token));
  assert.match(actions, /title: taskTitle\('generate', generateProblem\)/);
  assert.doesNotMatch(actions, /toolbarButton\('context'|toolbarButton\('advanced'|contextBusy/);
  assert.match(source, /case 'context': return renderContextPage\(\)/);
  assert.match(source, /utilityHeadingRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
});

test('toolbar respects host chrome and remains above independent page and manuscript scrollports', () => {
  assert(rule('.mx-topbar').includes('var(--dsh-frame-leading-clearance,0px)'));
  assert(rule('.mx-topbar').includes('max-height:45%'));
  assert(rule('.mx-root').includes('overflow:hidden'));
  assert(rule('.mx-content-pane').includes('overflow:auto'));
  assert(rule('.mx-body-slot .mx-editor').includes('resize:none'));
  assert(rule('.mx-body-slot>.mx-revision-preview,.mx-body-slot>.mx-stack').includes('overflow:auto'));
  assert(source.includes('const folded = controlsFolded && writingLayout'));
});
