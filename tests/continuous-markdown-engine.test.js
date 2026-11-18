import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// The installed plugin has no CodeMirror runtime/npm dependencies. The source
// tests use the pinned build toolchain when installed, without a DOM emulator.
let tooling, cm;
try {
  tooling = await import('../editor-build/build.mjs');
  const { build } = await import('../editor-build/node_modules/esbuild/lib/main.js');
  const result = await build({ ...tooling.pinnedBuildOptions, format: 'esm', platform: 'node',
    stdin: { resolveDir: tooling.workspace, contents: `
      export * from './continuous-markdown.js';
      export { EditorState, EditorSelection, Compartment, Text } from '@codemirror/state';
      export { EditorView } from '@codemirror/view';
      export { history, undo, undoDepth, redo } from '@codemirror/commands';
    ` } });
  cm = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
} catch (error) {
  const missingToolchain = error.code === 'ERR_MODULE_NOT_FOUND' && /editor-build\/(?:build\.mjs|node_modules\/esbuild)|package 'esbuild'/.test(error.message);
  if (!missingToolchain || basename(process.cwd()) === 'editor-build') throw error;
}
const suite = (name, fn) => test(name, { skip: !cm && 'Run npm --prefix editor-build ci for the pinned engine tests' }, fn);
const hiddenSource = (doc, events) => events.filter(event => event.activeFrom !== undefined).map(event => doc.slice(event.from, event.to));
const reconstruct = (text, changes) => {
  let from = 0, after = '';
  for (const change of changes) {
    assert.ok(change.from >= from && change.to >= change.from);
    after += text.slice(from, change.from) + change.insert;
    from = change.to;
  }
  return after + text.slice(from);
};

suite('canonical groups, indented tasks and flat heading children use exact original offsets', () => {
  const text = '- **人物**\n    - [x] 🐉 *先行动*\n      第二行\n\t+ [ ] 下一项\n## 地点\n- ~~屋外~~\n* [X] 庭院\n不完整';
  const groups = cm.scanStructure(text);
  assert.deepEqual(groups.map(({ kind, glyph }) => [kind, glyph]), [
    ['category', undefined], ['rule', 'checked'], ['rule', 'unchecked'], ['category', undefined], ['rule', 'bullet'], ['rule', 'checked'],
  ]);
  const all = groups.flatMap(block => cm.analyzeBlock(text, block));
  assert.ok(all.every(({ from, to }) => from >= 0 && from < to && to <= text.length));
  assert.deepEqual(all.filter(e => /^(strong|em|strike)$/.test(e.kind)).map(e => text.slice(e.from, e.to)), ['人物', '先行动', '屋外']);
  assert.deepEqual(hiddenSource(text, cm.analyzeBlock(text, groups[1])), ['    - [x] ', '      ', '*', '*']);
  assert.ok(all.every(e => text.slice(e.from, e.to) !== '不完整'));
  assert.equal(reconstruct(text, []), text);
});

suite('nested lists, quotes and fences are projected without touching literal code or URLs', () => {
  const text = ['# Groundwork', '- [X] Before `*code*` [**安全**](https://example.invalid/path "title")',
    '      ', '        - [ ] nested *rule*', '          - grandchild', '      ', '      > quote **keep**',
    '      ', '      ```js', '      let x = "**literal**";', '      ```'].join('\n');
  const rule = cm.scanStructure(text)[1], events = cm.analyzeBlock(text, rule);
  assert.deepEqual(events.filter(e => e.kind === 'code').map(e => text.slice(e.from, e.to)), ['*code*', 'let x = "**literal**";']);
  assert.deepEqual(events.filter(e => e.kind === 'link').map(e => text.slice(e.from, e.to)), ['**安全**']);
  assert.ok(events.some(e => e.glyph === 'unchecked' && text.slice(e.from, e.to) === '[ ]'));
  assert.ok(events.some(e => e.glyph === 'quote' && text.slice(e.from, e.to) === '> '));
  assert.ok(events.filter(e => e.glyph === 'bullet').length >= 2);
  assert.ok(hiddenSource(text, events).includes('```js'));
  assert.ok(hiddenSource(text, events).includes('```'));
  assert.ok(!events.some(e => e.kind === 'strong' && text.slice(e.from, e.to) === 'literal'));
});

suite('inner ATX and Setext headings preserve their rule source coordinates', () => {
  const text = '- Group\n    - [x] ### Inner ###\n      \n      Setext *inner*\n      ============';
  const [, rule] = cm.scanStructure(text), events = cm.analyzeBlock(text, rule);
  const subheading = events.find(e => e.kind === 'subheading'), heading = events.find(e => e.kind === 'heading');
  assert.equal(text.slice(subheading.from, subheading.to), 'Inner');
  assert.equal(text.slice(heading.from, heading.to), 'Setext *inner*');
  assert.ok(hiddenSource(text, events).includes('### '));
  assert.ok(hiddenSource(text, events).includes(' ###'));
  assert.ok(hiddenSource(text, events).includes('============'));
});

suite('malformed, quoted category, unsafe links, HTML, images, and unclosed fences stay literal', () => {
  const text = ['- "A\\nB"', '    - [x] <iframe src=x> ![**image**](https://x) [*danger*](javascript:alert) \n' +
    '      [reference] <https://example.invalid> **unfinished', '      ', '      ```sh', '      echo **literal**',
    'syntax nobody recognized', '- "invalid json', '    - orphaned', 'text ending].'].join('\n');
  const blocks = cm.scanStructure(text), events = blocks.flatMap(block => cm.analyzeBlock(text, block));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].quoted, true);
  assert.deepEqual(events.filter(e => e.kind === 'code').map(e => text.slice(e.from, e.to)), ['echo **literal**']);
  assert.deepEqual(events.filter(e => ['strong', 'em', 'link'].includes(e.kind)), []);
  assert.ok(!hiddenSource(text, events).includes('```sh'));
  assert.ok(events.every(e => e.to <= text.indexOf('syntax nobody recognized')));
});

suite('only a caret reveals markers; broad selection keeps layout stable', () => {
  const text = '- First\n    - [x] *🐉*\n- Second\n    - [ ] ~~end~~';
  const events = cm.scanStructure(text).flatMap(block => cm.analyzeBlock(text, block));
  const [open, close] = events.filter(e => e.kind === 'hidden' && text.slice(e.from, e.to) === '*');
  const [ruleOne, ruleTwo] = events.filter(e => e.kind === 'rule');
  const caret = cm.EditorSelection.single(text.indexOf('🐉') + 2);
  assert.ok(cm.caretTouches(caret, open.activeFrom, open.activeTo));
  assert.ok(cm.caretTouches(caret, close.activeFrom, close.activeTo));
  assert.equal(cm.caretTouches(caret, ruleTwo.activeFrom, ruleTwo.activeTo), false);
  const backwards = cm.EditorSelection.single(text.length - 1, text.indexOf('🐉'));
  assert.equal(cm.caretTouches(backwards, ruleOne.activeFrom, ruleOne.activeTo), false);
  assert.equal(cm.caretTouches(backwards, ruleTwo.activeFrom, ruleTwo.activeTo), false);
  assert.equal(backwards.main.anchor, text.length - 1);
});

suite('indentation remaps both selection directions when dedenting under an endpoint', () => {
  const doc = '# Alpha\n    - one\n## Beta\n- two', dedented = doc.replace('    - one','- one');
  for (const [anchor, head] of [[6,9],[9,6]]) {
    const state = cm.EditorState.create({ doc, selection: cm.EditorSelection.single(anchor, head) });
    const changes = state.changes(cm.shortcutChanges(doc,dedented,6,9,'Tab',true));
    assert.equal(changes.apply(state.doc).toString(),dedented);
    const range = cm.shortcutSelection(state,changes,'Tab',{start:6,end:5}).main;
    assert.deepEqual([range.anchor,range.head],anchor < head ? [6,8] : [8,6]);
  }
});

suite('edit context observes composition after attach or replacement and removes listeners on disposal', () => {
  const a = new EventTarget(), b = new EventTarget(); let actual = null; const events = [];
  const handle = cm.observeEditContext(() => actual, () => events.push('start'), () => events.push('end'));
  handle.refresh(); a.dispatchEvent(new Event('compositionstart'));
  actual = a; handle.refresh(); handle.refresh(); a.dispatchEvent(new Event('compositionstart'));
  actual = b; handle.refresh(); a.dispatchEvent(new Event('compositionend')); b.dispatchEvent(new Event('compositionend'));
  handle.dispose(); b.dispatchEvent(new Event('compositionstart'));
  assert.deepEqual(events,['start','end']);
});

suite('Enter and multi-line Tab produce source-local, reconstructable change ranges', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const start = client.indexOf('    function markdownTextareaEdit(');
  assert.ok(start >= 0);
  const end = client.indexOf('\n    }', start);
  const helper = runInNewContext('const textareaValue = text => text.replace(/\\r\\n?/g, "\\n");\n' + client.slice(start, end + 6) + '\nmarkdownTextareaEdit');
  const before = '# One\n- [x] 🐉\n- Next\n# Two\n- Tail';
  const from = before.indexOf('- [x]'), to = before.indexOf('# Two');
  const tab = helper(before, from, to, 'Tab');
  assert.equal(reconstruct(before, cm.shortcutChanges(before, tab.value, from, to, 'Tab', false)), tab.value);
  const tabChanges = cm.shortcutChanges(before, tab.value, from, to, 'Tab', false);
  assert.deepEqual(tabChanges, [{ from, to: from, insert: '    ' }, { from: before.indexOf('- Next'), to: before.indexOf('- Next'), insert: '    ' }]);
  const dedent = helper(tab.value, tab.start, tab.end, 'Tab', { shiftKey: true });
  assert.equal(dedent.value, before);
  assert.equal(reconstruct(tab.value, cm.shortcutChanges(tab.value, dedent.value, tab.start, tab.end, 'Tab', true)), before);
  const caret = before.indexOf('🐉') + 2, enter = helper(before, caret, caret, 'Enter');
  assert.deepEqual(cm.shortcutChanges(before, enter.value, caret, caret, 'Enter', false), [{ from: caret, to: caret, insert: '\n- [ ] ' }]);
  const empty = '# Heading\n- [ ] ', stop = empty.length;
  const remove = helper(empty, stop, stop, 'Enter');
  assert.equal(reconstruct(empty, cm.shortcutChanges(empty, remove.value, stop, stop, 'Enter', false)), remove.value);
  assert.equal(helper(before, caret, caret, 'Enter', { composing: true }), null);
});

suite('constraints Enter inserts the enabled marker in a native CodeMirror transaction', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const start = client.indexOf('    function markdownTextareaEdit('), end = client.indexOf('    // A small, bounded Markdown renderer', start);
  assert(start >= 0 && end > start);
  const edit = runInNewContext('const textareaValue = text => text.replace(/\\r\\n?/g, "\\n");\n' + client.slice(start, end) + '\nconstraintsDocumentKey');
  const starter = '- [x] - ';
  for (const [line, tail, prefix, options = {}] of [
    ['- 场景🌿', '', '    ' + starter],
    ['## 对话', '\n- [x] - 已有平级规则', '    ' + starter],
    ['- 对话\n    - [x] - 启用的规则', '\n    - [x] - 不受影响', '    ' + starter],
    ['- 对话\n    - [ ] - 停用的规则', '', '    ' + starter],
    ['- 对话\n\t- [ ] - 停用的规则', '', '\t' + starter],
    ['# 视角\n\n- [X] - 已有平级规则', '', starter],
    ['- 视角\n    - [ ] - 保持原状态', '', '      ', { shiftKey: true }],
  ]) {
    const before = line + tail, from = line.length;
    const outcome = edit(before, from, from, 'Enter', options);
    const expected = '\n' + prefix;
    assert.equal(outcome.value, line + expected + tail);
    assert.equal(outcome.start, from + expected.length);
    assert.equal(outcome.end, outcome.start);
    const h = stateHarness(before);
    const changes = cm.shortcutChanges(before, outcome.value, from, from, 'Enter', !!options.shiftKey);
    assert.deepEqual(changes, [{ from, to: from, insert: expected }]);
    h.dispatch(h.state.update({ changes, selection: { anchor: outcome.start }, userEvent: 'input.type' }));
    assert.equal(h.state.doc.toString(), outcome.value);
    assert.equal(h.state.selection.main.head, outcome.start);
    assert.equal(cm.undo(h), true);
    assert.equal(h.state.doc.toString(), before);
  }
  const source = '- 根分类\n    - [ ] - 例子';
  assert.equal(edit(source, source.length, source.length, 'Enter', { composing: true }), null);
  assert.equal(edit(source, source.length + 1, source.length + 1, 'Enter'), null);
  const nested = source + '\n      - 已有内层列表';
  assert.equal(edit(nested, nested.length, nested.length, 'Enter').value, nested + '\n      - ');
});

function stateHarness(doc, options = {}, extensions = []) {
  const gate = cm.transactionGate(() => options);
  const harness = { state: cm.EditorState.create({ doc, extensions: [cm.documentVersions, cm.history(), gate.extension, ...extensions] }), updates: [],
    dispatch(tr) {
      const checked = gate.checkDispatched(tr);
      if (checked?.reject) return checked.reject;
      harness.state = tr.state;
      if (checked?.input) harness.updates.push(checked.input);
      return null;
    },
  };
  return harness;
}

suite('candidate guard runs once before input, receives sorted LF changes, and bounds UTF-16', () => {
  const seen = [];
  const doc = '# A\n- 🌊 ok\n- Later';
  const h = stateHarness(doc, { acceptInput(u) { seen.push(u); return u.text.includes('nope') ? 'limit' : !u.text.includes('stale'); } });
  const offset = doc.indexOf('🌊');
  const tr = h.state.update({ changes: [{ from: 2, to: 3, insert: 'B' }, { from: offset, to: offset + 2, insert: 'a\r\nb\rc' }], userEvent: 'input.paste' });
  assert.equal(h.state.doc.toString(), doc);
  assert.equal(h.dispatch(tr), null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], h.updates[0]);
  assert.equal(seen[0].origin, 'input.paste');
  assert.deepEqual(seen[0].changes, [{ from: 2, to: 3, insert: 'B' }, { from: offset, to: offset + 2, insert: 'a\nb\nc' }]);
  assert.equal(reconstruct(seen[0].before, seen[0].changes), h.state.doc.toString());
  const good = h.state;
  assert.equal(h.dispatch(good.update({ changes: { from: 0, insert: 'nope' } })), 'limit');
  assert.equal(h.dispatch(good.update({ changes: { from: 0, insert: 'stale' } })), true);
  assert.equal(h.dispatch(good.update({ changes: { from: 0, insert: 'x'.repeat(cm.MAX_DOCUMENT_LENGTH) } })), 'limit');
  assert.equal(h.dispatch(good.update({ changes: { from: 0, insert: cm.Text.of(['\ra']) } })), true);
  assert.equal(seen.length, 3);
  assert.equal(h.state, good);
  const limit = stateHarness('');
  assert.equal(limit.dispatch(limit.state.update({ changes: { from: 0, insert: '🙂'.repeat(cm.MAX_DOCUMENT_LENGTH / 2) } })), null);
  assert.equal(limit.state.doc.length, cm.MAX_DOCUMENT_LENGTH);
});

suite('native history retains exact grouped versions, restores removed semantics, and guards undo/redo', () => {
  let permit = true;
  const h = stateHarness('# A\n- first\n- second', { acceptInput: () => permit });
  const first = h.state.doc.toString().indexOf('- first'), second = h.state.doc.toString().indexOf('- second');
  const kill = h.state.update({ changes: { from: first, to: second, insert: '' }, userEvent: 'delete.selection' });
  h.dispatch(kill);
  const removed = h.updates.at(-1);
  assert.equal(h.state.doc.toString(), '# A\n- second');
  const start = h.state.doc.length;
  h.dispatch(h.state.update({ changes: { from: start, insert: '!' }, userEvent: 'input.type' }));
  h.dispatch(h.state.update({ changes: { from: start + 1, insert: '?' }, userEvent: 'input.type' }));
  assert.equal(cm.undoDepth(h.state), 2);
  const typed = h.updates.at(-1);
  const typedState = h.state;
  permit = false;
  assert.ok(cm.undo(h)); // CM dispatched the undo, but its state is not accepted.
  assert.equal(h.state, typedState);
  permit = true;
  assert.ok(cm.undo(h));
  assert.equal(h.updates.at(-1).origin, 'undo');
  assert.equal(h.updates.at(-1).version, removed.version);
  assert.ok(cm.undo(h));
  assert.equal(h.updates.at(-1).version, removed.beforeVersion);
  assert.equal(cm.undoDepth(h.state), 0);
  assert.ok(cm.redo(h));
  assert.equal(h.updates.at(-1).version, removed.version);
  assert.ok(cm.redo(h));
  assert.equal(h.updates.at(-1).origin, 'redo');
  assert.equal(h.updates.at(-1).version, typed.version);
  assert.equal(h.state.doc.toString(), '# A\n- second!?');
});

suite('ordinary readOnly updates fail; only a private guarded structural action can bypass the lock', () => {
  const payload = Object.freeze({ confirm: 'A' }), readOnly = new cm.Compartment();
  const captured = [];
  const h = stateHarness('- A\n    - [x] a', { acceptInput(update) {
    captured.push(update);
    return update.origin === 'input.structure' && update.payload === payload;
  } }, [readOnly.of(cm.EditorState.readOnly.of(true))]);
  assert.equal(h.dispatch(h.state.update({ changes: { from: 0, to: 1 }, userEvent: 'input.structure' })), true);
  assert.equal(captured.length, 0);
  const target = '- B\n    - [x] b';
  assert.equal(h.dispatch(cm.structureTransaction(h.state, target, null)), true);
  assert.equal(h.dispatch(cm.structureTransaction(h.state, target, payload)), null);
  const structural = h.updates.at(-1);
  assert.equal(structural.payload, payload);
  assert.equal(h.state.doc.toString(), target);
  assert.equal(cm.undo(h), false);
  h.dispatch(h.state.update({ effects: readOnly.reconfigure(cm.EditorState.readOnly.of(false)) }));
  const unlocked = stateHarness('origin');
  unlocked.dispatch(cm.structureTransaction(unlocked.state, 'destination', payload));
  assert.ok(cm.undo(unlocked));
  assert.ok(!Object.hasOwn(unlocked.updates.at(-1), 'payload'));
  assert.equal(unlocked.updates.at(-1).version, unlocked.updates[0].beforeVersion);
});

suite('same-text semantic sync resets native history and tokens without emitting authored input', () => {
  const undoHistory = new cm.Compartment();
  let guards = 0;
  const gate = cm.transactionGate(() => ({ acceptInput: () => (++guards, true) }));
  const initial = cm.EditorState.create({ doc: '# A', extensions: [cm.documentVersions, undoHistory.of(cm.history()), gate.extension] });
  const local = initial.update({ changes: { from: 3, insert: '!' }, userEvent: 'input.type' });
  assert.equal(cm.undoDepth(local.state), 1);
  assert.equal(guards, 1);
  const last = gate.checkDispatched(local).input.version;
  const reset = cm.externalTransactions(local.state, undoHistory, [], [], true);
  assert.ok(reset.every(tr => !gate.checkDispatched(tr)));
  const resetState = reset.at(-1).state;
  assert.equal(cm.undoDepth(resetState), 0);
  assert.equal(resetState.doc, local.state.doc);
  const otherText = cm.externalTransactions(resetState, undoHistory, [], [{ from: 2, insert: 'Different ' }], true);
  assert.equal(otherText.at(-1).state.doc.toString(), '# Different A!');
  assert.ok(otherText.every(tr => !gate.checkDispatched(tr)));
  assert.equal(guards, 1);
  const lastState = otherText.at(-1).state;
  assert.notEqual(gate.checkDispatched(lastState.update({ changes: { from: 0, insert: 'Z' } })).input.beforeVersion, last);
});

suite('appearance updates keep the same state document and preserve label, invalid, and readonly semantics', () => {
  const appearance = new cm.Compartment(), projection = cm.EditorState.tabSize.of(4);
  const active = { raw: false, label: '写作约束', describedBy: 'hint error', invalid: true, readOnly: true };
  const state = cm.EditorState.create({ doc: '# A\n- First', selection: { anchor: 8, head: 2 }, extensions: appearance.of(cm.editorAppearance(active, projection)) });
  const [attrs] = state.facet(cm.EditorView.contentAttributes);
  assert.deepEqual(attrs, { role: 'textbox', 'aria-multiline': 'true', 'aria-readonly': 'true', 'aria-invalid': 'true',
    'aria-label': '写作约束', 'aria-describedby': 'hint error', tabindex: '0' });
  assert.equal(state.readOnly, true);
  assert.equal(state.facet(cm.EditorView.editable), false);
  const raw = state.update({ effects: appearance.reconfigure(cm.editorAppearance({ ...active, raw: true, readOnly: false }, projection)) }).state;
  assert.equal(raw.doc, state.doc);
  assert.equal(raw.selection, state.selection);
  assert.equal(raw.readOnly, false);
  assert.equal(raw.facet(cm.EditorView.editable), true);
});

suite('reproducible IIFE carries npm notices and evaluates without a DOM or other globals', async () => {
  const artifact = await tooling.buildEngine();
  assert.equal(artifact, await tooling.buildEngine());
  assert.match(artifact, /@codemirror\/view@\d+\.\d+\.\d+/);
  assert.match(artifact, /@lezer\/markdown@\d+\.\d+\.\d+/);
  assert.match(artifact, /Permission is hereby granted/);
  const sandbox = Object.create(null);
  runInNewContext(artifact, sandbox, { timeout: 1000 });
  assert.deepEqual(Object.keys(sandbox), ['__dshInspirationContinuousMarkdown']);
  assert.deepEqual(Object.keys(sandbox.__dshInspirationContinuousMarkdown), ['createContinuousMarkdown']);
  assert.equal(typeof sandbox.__dshInspirationContinuousMarkdown.createContinuousMarkdown, 'function');
});
