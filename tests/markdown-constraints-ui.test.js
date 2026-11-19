import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createBook, mutateBook } from '../core.js';

// Actual production helpers; no mock React, fake DOM, browser, or model call.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('    const equal ='), source.indexOf('    const en ='));
const f = new Function(pure + '\nreturn {equal,constraintsEditorDirty,workspace,dirty,isDirty,serializeConstraintsMarkdown,parseConstraintsMarkdown,editConstraintsMarkdown,constraintVisualTargets,editConstraintVisualBlock,editWritingConstraints,validConstraintsEditor,constraintsDocumentMatches,validRecovery,recoveryPayload,restoredWorkspace,autosaveStep,mergeAutosaveAck,autosaveRecoveryPayload,restoredAutosaveWorkspace,mergeWorkspace,conflictingFields,createAutosaveController,constraintsPreviewReady,textareaValue,applyTextareaEdit,markdownTextareaEdit,markdownInline,markdownBlocks,safeMarkdownUrl,polishIntentProblem,capturePolishSnapshot};')();
const tabDirtyRegion = source.slice(source.indexOf('    function workspaceTabDirty('), source.indexOf('\n\n    const CSS ='));
const workspaceTabDirty = new Function('equal', 'constraintsEditorDirty', tabDirtyRegion + '\nreturn workspaceTabDirty;')(f.equal, f.constraintsEditorDirty);
const clone = value => JSON.parse(JSON.stringify(value));
const row = (content = '随人物感知展开。', patch = {}) => ({ id: randomUUID(), category: '环境', content, enabled: true, ...patch });
function fixture(rows = []) {
  let book = mutateBook(createBook('Markdown test'), { action: 'addChapter', title: 'Chapter' });
  book = mutateBook(book, { action: 'updateChapter', chapterId: book.chapters[0].id, patch: { body: '原稿😀' } });
  if (rows.length) book = mutateBook(book, { action: 'updateBook', patch: { writingConstraints: rows } });
  return f.workspace(book, book.chapters[0].id);
}
const edit = (w, value) => f.editConstraintsMarkdown(w, w.book.id, value);
const ack = (local, snapshot, step = f.autosaveStep(snapshot)) => f.mergeAutosaveAck(local, snapshot, mutateBook(snapshot.book, step.operation), step);
const types = nodes => nodes.flatMap(node => [node.type, ...types(node.children || [])]);
const textOf = nodes => nodes.map(node => node.text ?? textOf(node.children || [])).join('');

test('tab indicators attribute raw and semantic constraint drafts only to writing constraints', () => {
  const base = fixture([row('原规则')]);
  assert.deepEqual(workspaceTabDirty(base), { settings: false, constraints: false });
  const invalid = edit(base, base.constraintsEditor.text + '\n- 未完成类别');
  assert.deepEqual(workspaceTabDirty(invalid), { settings: false, constraints: true });
  const semantic = edit(base, base.constraintsEditor.text.replace('原规则', '新规则'));
  assert.deepEqual(workspaceTabDirty(semantic), { settings: false, constraints: true });
  const settings = { ...base, settings: { ...base.settings, title: '改名' } };
  assert.deepEqual(workspaceTabDirty(settings), { settings: true, constraints: false });
  assert.deepEqual(workspaceTabDirty({ ...invalid, settings: { ...invalid.settings, title: '改名' } }), { settings: true, constraints: true });
  assert.match(source, /value === 'settings' && tabDirty\.settings/);
  assert.match(source, /value === 'constraints' && tabDirty\.constraints/);
  const compile = region => new Function('equal', 'constraintsEditorDirty', region + '\nreturn workspaceTabDirty;')(f.equal, f.constraintsEditorDirty);
  const duplicateDot = compile(tabDirtyRegion.replace("      settingsKeys.delete('writingConstraints');", ''));
  assert.throws(() => assert.deepEqual(duplicateDot(semantic), { settings: false, constraints: true }));
  const loseRawDot = compile(tabDirtyRegion.replace('constraints: constraintsEditorDirty(w) || ', 'constraints: '));
  assert.throws(() => assert.deepEqual(loseRawDot(invalid), { settings: false, constraints: true }));
});

test('whole clean Markdown parses nested categories and plain default-enabled rules', () => {
  const text = '- 环境\n    - 随人物感知展开。优先写人物此刻会注意到的事物，不脱离视角堆砌全景。\n- 对话\n    - [ ] 不使用解释性独白。';
  const parsed = f.parseConstraintsMarkdown(text);
  assert.equal(parsed.error, '');
  assert.deepEqual(parsed.rows.map(({ category, content, enabled }) => ({ category, content, enabled })), [
    { category: '环境', content: '随人物感知展开。优先写人物此刻会注意到的事物，不脱离视角堆砌全景。', enabled: true },
    { category: '对话', content: '不使用解释性独白。', enabled: false },
  ]);
  assert.match(parsed.rows[0].id, /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(f.serializeConstraintsMarkdown(parsed.rows), /<!--|rule:|[0-9a-f]{8}-[0-9a-f]{4}-/i);
});

test('heading categories with ordinary lists are whole Markdown, not a category outline', () => {
  const parsed = f.parseConstraintsMarkdown('# 环境\n- **感官**与`细节`\n- [ ] 停用规则\n## 对话\n- 简洁');
  assert.equal(parsed.error, '');
  assert.deepEqual(parsed.rows.map(item => item.category), ['环境', '环境', '对话']);
  assert.equal(parsed.rows[1].enabled, false);
  for (const invalid of ['- 环境', '- 环境\n- 对话', '## 环境', '- \n    - 规则', '- 环境\n    - [ ] ']) assert.ok(f.parseConstraintsMarkdown(invalid).error, invalid);
});

test('serializer roundtrips canonical order, disabled rows, Markdown characters, CRLF and multiline legacy category', () => {
  const rows = [
    row('**bold**\r\n\r\n```js\r\n  <script>alert(1)</script>\r\n```\r\n- list\r\n  - nested\r\n', { enabled: false }),
    row('[x] is literal content\n<!-- rule:' + randomUUID() + ' --> literal\n    preserved indentation'),
    row('content', { category: '对话' }),
    row('last', { category: '环境' }),
    row('legacy', { category: '多行\r\n类别' }),
    row('quote', { category: '"literal category' }),
  ];
  const serialized = f.serializeConstraintsMarkdown(rows);
  const parsed = f.parseConstraintsMarkdown(serialized, rows);
  assert.equal(parsed.error, '');
  assert.deepEqual(parsed.rows, rows);
  const isolated = f.parseConstraintsMarkdown(serialized);
  assert.equal(isolated.error, '');
  assert.deepEqual(isolated.rows.map(({ id, ...rest }) => rest), rows.map(({ id, ...rest }) => rest));
  assert.equal((serialized.match(/^- 环境$/gm) || []).length, 2, 'Noncontiguous category groups repeat instead of reordering canonical rows');
});

test('entering legacy tab and native no-change normalization do not rewrite or dirty canonical data', () => {
  const w = fixture([row('第一行\r\n第二行', { category: '旧版\r\n类别', enabled: false })]);
  assert.equal(f.isDirty(w), false);
  assert.equal(edit(w, f.textareaValue(w.constraintsEditor.text)), w);
  assert.equal(f.autosaveStep(w), null);
  assert.deepEqual(w.settings.writingConstraints, w.book.writingConstraints);
});

test('localized content/category renames preserve UUID and disabled state without source metadata', () => {
  let w = fixture([row('原有内容', { enabled: false }), row('另一条')]);
  const ids = w.settings.writingConstraints.map(item => item.id);
  w = edit(w, w.constraintsEditor.text.replace('原有内容', '改写内容'));
  assert.deepEqual(w.settings.writingConstraints.map(item => item.id), ids);
  assert.equal(w.settings.writingConstraints[0].enabled, false);
  w = edit(w, w.constraintsEditor.text.replace('- 环境', '- 气氛'));
  assert.deepEqual(w.settings.writingConstraints.map(item => item.id), ids);
  assert.deepEqual(w.settings.writingConstraints.map(item => item.category), ['气氛', '气氛']);
});

test('exact reorder preserves distinct UUIDs, repeated category groups and enabled flags', () => {
  const rows = [row('甲'), row('乙', { category: '对话', enabled: false }), row('丙')];
  const w = edit(fixture(rows), f.serializeConstraintsMarkdown([rows[2], rows[1], rows[0]]));
  assert.deepEqual(w.settings.writingConstraints, [rows[2], rows[1], rows[0]]);
});

test('duplicate occurrences are deterministic; single edited duplicate owns its old UUID', () => {
  let w = fixture([row('相同内容'), row('相同内容', { enabled: false }), row('不同内容')]);
  const original = clone(w.settings.writingConstraints);
  assert.deepEqual(f.parseConstraintsMarkdown(w.constraintsEditor.text, original).rows, original);
  w = edit(w, w.constraintsEditor.text.replace('[x] 相同内容', '[ ] 相同内容'));
  assert.deepEqual(w.settings.writingConstraints.map(item => item.id), original.map(item => item.id));
  assert.deepEqual(w.settings.writingConstraints.map(item => item.enabled), [false, false, true]);
  const reset = fixture(original);
  const moved = edit(reset, f.serializeConstraintsMarkdown([original[1], original[0], original[2]]));
  assert.deepEqual(moved.settings.writingConstraints, [original[1], original[0], original[2]]);
  const collision = fixture([row('甲'), row('乙')]);
  const same = edit(collision, collision.constraintsEditor.text.replace('甲', '乙'));
  assert.deepEqual(same.settings.writingConstraints.map(item => item.id), collision.settings.writingConstraints.map(item => item.id));
});

test('whole-source category rename cannot steal UUIDs from a duplicate destination group', () => {
  const rows = [
    row('same', { category: 'A' }),
    row('other', { category: 'A', enabled: false }),
    row('same', { category: 'B' }),
  ];
  const w = fixture(rows);
  const changed = edit(w, w.constraintsEditor.text.replace('- A', '- B'));
  assert.equal(changed.constraintsEditor.error, '');
  assert.deepEqual(changed.settings.writingConstraints.map(item => item.id), rows.map(item => item.id));
  assert.deepEqual(changed.settings.writingConstraints.map(item => item.category), ['B', 'B', 'B']);
  assert.deepEqual(changed.settings.writingConstraints.map(item => item.enabled), [true, false, true]);

  const headingSource = '## A\r\n- [x] same\r\n- [ ] other\r\n\r\n## B\r\n- [x] same';
  const headingBase = { ...w, constraintsEditor: { ...w.constraintsEditor, text: headingSource, parsedText: headingSource } };
  const markerRename = edit(headingBase, headingSource.replace('## A', '# B'));
  assert.deepEqual(markerRename.settings.writingConstraints.map(item => item.id), rows.map(item => item.id), 'Full heading marker+token replacement keeps group identity');
  const groupPaste = edit(headingBase, headingSource.replace('## A\r\n- [x] same', '# B\r\n- [x] changed'));
  assert.deepEqual(groupPaste.settings.writingConstraints.map(item => item.id), rows.map(item => item.id), 'One local heading+rule paste keeps group identity');
  assert.deepEqual(groupPaste.settings.writingConstraints.map(item => item.content), ['changed', 'other', 'same']);

  const pair = [row('same', { category: 'A' }), row('same', { category: 'B' })], pairBase = fixture(pair);
  const spaced = '## A\n- [x] same\n\n## B\n- [x] same';
  const spacedBase = { ...pairBase, constraintsEditor: { ...pairBase.constraintsEditor, text: spaced, parsedText: spaced } };
  const removedSeparator = edit(spacedBase, spaced.replace('## A\n- [x] same\n\n', '## B\n- [x] same\n'));
  assert.deepEqual(removedSeparator.settings.writingConstraints.map(item => item.id), pair.map(item => item.id), 'Heading rename plus separator removal keeps both UUIDs');
  const tight = '## A\n- [x] same\n## B\n- [x] same';
  const tightBase = { ...pairBase, constraintsEditor: { ...pairBase.constraintsEditor, text: tight, parsedText: tight } };
  const addedSeparator = edit(tightBase, tight.replace('## A\n- [x] same\n', '## B\n- [x] same\n\n'));
  assert.deepEqual(addedSeparator.settings.writingConstraints.map(item => item.id), pair.map(item => item.id), 'Heading rename plus separator insertion keeps both UUIDs');
  const leading = '\n## A\n- [x] same\n\n## B\n- [x] same';
  const leadingBase = { ...pairBase, constraintsEditor: { ...pairBase.constraintsEditor, text: leading, parsedText: leading } };
  const leadingChanged = edit(leadingBase, leading.replace('\n## A', '## B'));
  assert.deepEqual(leadingChanged.settings.writingConstraints.map(item => item.id), pair.map(item => item.id), 'Heading rename plus removal of its leading separator keeps both UUIDs');

  const middleRows = [row('x', { category: 'X' }), ...pair], middleBase = fixture(middleRows);
  const middle = '## X\n- [x] x\n\n## A\n- [x] same\n\n## B\n- [x] same';
  const middleWorkspace = { ...middleBase, constraintsEditor: { ...middleBase.constraintsEditor, text: middle, parsedText: middle } };
  const middleChanged = edit(middleWorkspace, middle.replace('\n\n## A', '\n## B'));
  assert.deepEqual(middleChanged.settings.writingConstraints.map(item => item.id), middleRows.map(item => item.id), 'A middle heading owns its leading separator without crossing the previous rule');

  const addValue = '## B\n- [x] same\n- [x] new\n\n## B\n- [x] same';
  const withAdded = edit(spacedBase, addValue);
  assert.deepEqual([withAdded.settings.writingConstraints[0].id, withAdded.settings.writingConstraints[2].id], pair.map(item => item.id), 'Rename plus add preserves both surviving group UUIDs');
  assert(!pair.some(item => item.id === withAdded.settings.writingConstraints[1].id), 'The added rule receives a fresh UUID');
  const insertedDuplicateValue = '## B\n- [x] same\n- [x] outside\n\n## B\n- [x] outside';
  const externalRows = [row('same', { category: 'A' }), row('outside', { category: 'B' })], externalBase = fixture(externalRows);
  const externalSource = '## A\n- [x] same\n\n## B\n- [x] outside';
  const externalWorkspace = { ...externalBase, constraintsEditor: { ...externalBase.constraintsEditor, text: externalSource, parsedText: externalSource } };
  const insertedDuplicate = edit(externalWorkspace, insertedDuplicateValue);
  assert.deepEqual([insertedDuplicate.settings.writingConstraints[0].id, insertedDuplicate.settings.writingConstraints[2].id], externalRows.map(item => item.id), 'An inserted duplicate cannot steal the untouched external occurrence UUID');
  assert(!externalRows.some(item => item.id === insertedDuplicate.settings.writingConstraints[1].id), 'An excess pasted group member is forced fresh');

  const multiRows = [row('one', { category: 'A' }), row('two', { category: 'A' }), row('outside', { category: 'A' })], multiBase = fixture(multiRows);
  const multiSource = '## A\n- [x] one\n- [x] two\n\n## A\n- [x] outside';
  const multiWorkspace = { ...multiBase, constraintsEditor: { ...multiBase.constraintsEditor, text: multiSource, parsedText: multiSource } };
  const multiPaste = edit(multiWorkspace, '## A\n- [x] outside\n- [x] other\n\n## A\n- [x] outside');
  assert.deepEqual(multiPaste.settings.writingConstraints.map(item => item.id), multiRows.map(item => item.id), 'A multi-rule paste owns its source group without stealing an untouched duplicate');

  const bracketRows = [row('alpha', { category: 'A' }), row('dup', { category: 'A' }), row('omega', { category: 'C' })];
  const bracketSource = '# A\n- [x] alpha\n\n## A\n- [x] dup\n\n## C\n- [x] omega';
  const bracketBase = fixture(bracketRows);
  const bracketWorkspace = { ...bracketBase, constraintsEditor: { ...bracketBase.constraintsEditor, text: bracketSource, parsedText: bracketSource } };
  const bracketPaste = edit(bracketWorkspace, '# A\n- [x] alpha2\n- [x] dup\n\n## A\n- [x] dup\n\n## C\n- [x] omega2');
  assert.equal(bracketPaste.constraintsEditor.error, '');
  assert.deepEqual([bracketPaste.settings.writingConstraints[0].id, bracketPaste.settings.writingConstraints[2].id, bracketPaste.settings.writingConstraints[3].id], bracketRows.map(item => item.id),
    'A multi-hunk paste preserves edited edge rules and a byte-identical interior source group');
  assert(!bracketRows.some(item => item.id === bracketPaste.settings.writingConstraints[1].id), 'The bracketed inserted duplicate receives a fresh UUID');

  const duplicateGroupRows = [row('alpha', { category: 'B' }), row('dup', { category: 'B' }), row('dup', { category: 'B' }), row('tail', { category: 'B' }), row('omega', { category: 'C' })];
  const duplicateGroupBefore = '# B\n- [x] alpha\n\n## B\n- [x] dup\n- [x] dup\n- [x] tail\n\n## C\n- [x] omega';
  const duplicateGroupAfter = '# B\n- [x] alpha2\n- [x] dup\n\n## B\n- [x] dup\n- [x] dup\n- [x] tail2\n\n## C\n- [x] omega2';
  const duplicateGroupBase = fixture(duplicateGroupRows);
  const duplicateGroupPaste = edit({ ...duplicateGroupBase, constraintsEditor: { ...duplicateGroupBase.constraintsEditor, text: duplicateGroupBefore, parsedText: duplicateGroupBefore } }, duplicateGroupAfter);
  assert.equal(duplicateGroupPaste.constraintsEditor.error, '');
  assert.deepEqual([0, 2, 3, 4, 5].map(index => duplicateGroupPaste.settings.writingConstraints[index].id), duplicateGroupRows.map(item => item.id),
    'Equal duplicate occurrences in an interior paired group stay ordered before global matching');
  assert(!duplicateGroupRows.some(item => item.id === duplicateGroupPaste.settings.writingConstraints[1].id), 'An earlier inserted duplicate cannot steal from the paired interior group');

  const mergedRows = [row('first', { category: 'A' }), row('outside', { category: 'B' }), row('outside', { category: 'A' })], mergedBase = fixture(mergedRows);
  const mergedSource = '## A\n- [x] first\n\n## B\n- [x] outside\n\n## A\n- [x] outside';
  const mergedWorkspace = { ...mergedBase, constraintsEditor: { ...mergedBase.constraintsEditor, text: mergedSource, parsedText: mergedSource } };
  const merged = edit(mergedWorkspace, mergedSource.replace('## B\n', ''));
  assert.deepEqual(merged.settings.writingConstraints.map(item => item.id), mergedRows.map(item => item.id), 'Deleting only a heading preserves unchanged rows while source groups merge');

  const splitRows = [row('first', { category: 'A' }), row('outside', { category: 'A' }), row('outside', { category: 'B' })], splitBase = fixture(splitRows);
  const splitSource = '## A\n- [x] first\n- [x] outside\n\n## B\n- [x] outside';
  const splitWorkspace = { ...splitBase, constraintsEditor: { ...splitBase.constraintsEditor, text: splitSource, parsedText: splitSource } };
  const split = edit(splitWorkspace, splitSource.replace('- [x] outside\n\n## B', '## B\n- [x] outside\n\n## B'));
  assert.deepEqual(split.settings.writingConstraints.map(item => item.id), splitRows.map(item => item.id), 'Inserting only a heading preserves unchanged rows while a source group splits');

  const cryptoRows = [row('keep', { category: 'A' }), row('deleted', { category: 'A' })];
  const cryptoCollision = f.parseConstraintsMarkdown('## A\n- keep\n- new', cryptoRows, { randomUUID: () => cryptoRows[1].id });
  assert.equal(cryptoCollision.error, 'constraintsCrypto', 'A generated UUID cannot reuse any previous-row identity');
  const repeatedGeneratedId = randomUUID();
  const repeatedGenerated = f.parseConstraintsMarkdown('## A\n- first\n- second', [], { randomUUID: () => repeatedGeneratedId });
  assert.equal(repeatedGenerated.error, 'constraintsCrypto', 'Two fresh records cannot receive the same generated UUID');

  const deleteRows = [row('same', { category: 'A' }), row('drop', { category: 'A' }), row('same', { category: 'B' })], deleteBase = fixture(deleteRows);
  const deleteSource = '## A\n- [x] same\n- [x] drop\n\n## B\n- [x] same';
  const deleteWorkspace = { ...deleteBase, constraintsEditor: { ...deleteBase.constraintsEditor, text: deleteSource, parsedText: deleteSource } };
  const withDeleted = edit(deleteWorkspace, '## B\n- [x] same\n\n## B\n- [x] same');
  assert.deepEqual(withDeleted.settings.writingConstraints.map(item => item.id), [deleteRows[0].id, deleteRows[2].id], 'Rename plus delete preserves the surviving exact member and the neighboring group');

  const reorderedRows = [row('one', { category: 'A' }), row('two', { category: 'A' })], reorderedBase = fixture(reorderedRows);
  const reorderedSource = '## A\n- [x] one\n- [x] two', reorderedValue = '## B\n- [x] two\n- [x] three';
  const reorderedWorkspace = { ...reorderedBase, constraintsEditor: { ...reorderedBase.constraintsEditor, text: reorderedSource, parsedText: reorderedSource } };
  const reordered = edit(reorderedWorkspace, reorderedValue);
  assert.deepEqual(reordered.settings.writingConstraints.map(item => item.id), [reorderedRows[1].id, reorderedRows[0].id], 'An unchanged rule moved during a heading paste keeps its own UUID before positional fallback');
});

test('visual category edits bind the explicit contiguous UUID group and preserve untouched source bytes', () => {
  const rows = [row('same', { category: 'A', enabled: false }), row('same', { category: 'B' })];
  const w = fixture(rows), projection = f.constraintVisualTargets(w.constraintsEditor.text, rows, { randomUUID });
  assert.deepEqual(projection.groups.map(group => group.ids), [[rows[0].id], [rows[1].id]]);
  const target = { ...projection.groups[0], expectedText: w.constraintsEditor.text };
  const result = f.editConstraintVisualBlock(w, w.book.id, target, 'B', { randomUUID });
  assert.equal(result.valid, true);
  assert.deepEqual(result.workspace.settings.writingConstraints.map(item => item.id), rows.map(item => item.id));
  assert.deepEqual(result.workspace.settings.writingConstraints.map(item => item.category), ['B', 'B']);
  assert.deepEqual(result.workspace.settings.writingConstraints.map(item => item.enabled), [false, true]);
  assert.equal(result.workspace.constraintsEditor.text,
    w.constraintsEditor.text.slice(0, target.start) + 'B' + w.constraintsEditor.text.slice(target.end));
  assert.deepEqual(f.constraintVisualTargets(result.workspace.constraintsEditor.text, result.workspace.settings.writingConstraints, { randomUUID }).groups.map(group => group.ids),
    [[rows[0].id], [rows[1].id]], 'Adjacent equal headings remain distinct visual source groups');
});

test('toggle, add and remove preserve untouched source groups, Markdown spelling and CRLF', () => {
  const rows = [row('one', { category: 'A' }), row('two', { category: 'A' })];
  const sourceText = '## A\r\n\r\n- [x] one\r\n\r\n## A\r\n- [x] two';
  const base = fixture(rows);
  const w = { ...base, constraintsEditor: { ...base.constraintsEditor, text: sourceText, parsedText: sourceText } };
  const toggled = f.editWritingConstraints(w, w.book.id, { type: 'edit', id: rows[1].id, field: 'enabled', value: false });
  assert.equal(toggled.constraintsEditor.text, sourceText.replace('- [x] two', '- [ ] two'));
  assert.equal((toggled.constraintsEditor.text.match(/## A/g) || []).length, 2, 'Distinct equal-name source groups stay distinct');

  const added = f.editWritingConstraints(toggled, w.book.id, { type: 'add', category: 'A', content: 'three', afterId: rows[1].id }, { randomUUID });
  const newRow = added.settings.writingConstraints[2];
  assert.equal(added.constraintsEditor.text, toggled.constraintsEditor.text + '\r\n- [x] three');
  assert.equal((added.constraintsEditor.text.match(/## A/g) || []).length, 2);
  const removed = f.editWritingConstraints(added, w.book.id, { type: 'remove', id: newRow.id });
  assert.equal(removed.constraintsEditor.text, toggled.constraintsEditor.text, 'Removing the just-added final rule restores the exact preceding source');

  const categoryAdded = f.editWritingConstraints(toggled, w.book.id, { type: 'add', category: 'NEW', content: 'fresh', afterId: rows[1].id }, { randomUUID });
  assert.equal(categoryAdded.constraintsEditor.text, toggled.constraintsEditor.text + '\r\n\r\n## NEW\r\n- [x] fresh');
  const categoryRow = categoryAdded.settings.writingConstraints.at(-1);
  const categoryRemoved = f.editWritingConstraints(categoryAdded, w.book.id, { type: 'remove', id: categoryRow.id });
  assert.equal(categoryRemoved.constraintsEditor.text, toggled.constraintsEditor.text, 'Adding then removing a final source group is byte-reversible');
  const withTail = { ...toggled, constraintsEditor: { ...toggled.constraintsEditor, text: toggled.constraintsEditor.text + '\r\n', parsedText: toggled.constraintsEditor.text + '\r\n' } };
  const tailAdded = f.editWritingConstraints(withTail, w.book.id, { type: 'add', category: 'TAIL', content: 'fresh', afterId: rows[1].id }, { randomUUID });
  const tailRemoved = f.editWritingConstraints(tailAdded, w.book.id, { type: 'remove', id: tailAdded.settings.writingConstraints.at(-1).id });
  assert.equal(tailRemoved.constraintsEditor.text, withTail.constraintsEditor.text, 'Add/remove also preserves one original trailing CRLF exactly');

  const middleRows = [row('A', { category: 'A' }), row('B', { category: 'B' }), row('C', { category: 'C' })];
  const middleSource = '## A\n- [x] A\n\n## B\n- [x] B\n\n## C\n- [x] C';
  const middleBase = fixture(middleRows);
  const middleWorkspace = { ...middleBase, constraintsEditor: { ...middleBase.constraintsEditor, text: middleSource, parsedText: middleSource } };
  const middleRemoved = f.editWritingConstraints(middleWorkspace, middleWorkspace.book.id, { type: 'remove', id: middleRows[1].id });
  assert.equal(middleRemoved.constraintsEditor.text, '## A\n- [x] A\n\n## C\n- [x] C', 'Removing a middle group owns one separator run and does not accumulate blank lines');

  const leadingRows = [row('one', { category: 'A' }), row('two', { category: 'B' })], leadingBase = fixture(leadingRows);
  const leadingSource = '\r\n## A\n- one\n\n\n## B\r\n- two';
  const leadingWorkspace = { ...leadingBase, constraintsEditor: { ...leadingBase.constraintsEditor, text: leadingSource, parsedText: leadingSource } };
  const leadingRemoved = f.editWritingConstraints(leadingWorkspace, leadingWorkspace.book.id, { type: 'remove', id: leadingRows[0].id });
  assert.equal(leadingRemoved.constraintsEditor.text, '\r\n## B\r\n- two', 'Removing the first semantic group preserves leading bytes and consumes its following mixed-EOL separator');

  const sameMoveRows = [row('one', { category: 'A' }), row('two', { category: 'A', enabled: false })], sameMoveBase = fixture(sameMoveRows);
  const sameMoveSource = '## A\r\n* [x] one\r\n\r\n* [ ] two';
  const sameMoveWorkspace = { ...sameMoveBase, constraintsEditor: { ...sameMoveBase.constraintsEditor, text: sameMoveSource, parsedText: sameMoveSource } };
  const sameMoved = f.editWritingConstraints(sameMoveWorkspace, sameMoveWorkspace.book.id, { type: 'move', id: sameMoveRows[1].id, direction: -1 });
  assert.equal(sameMoved.constraintsEditor.text, '## A\r\n* [ ] two\r\n\r\n* [x] one', 'Moving within one source heading swaps only the exact adjacent rule blocks');

  const crossMoveRows = [row('x', { category: 'X' }), row('one', { category: 'A' }), row('two', { category: 'B' }), row('z', { category: 'Z' })], crossMoveBase = fixture(crossMoveRows);
  const crossMoveSource = '\r\n## X\r\n* x\r\n\r\n## A\n- one\n\n## B\r\n+ two\r\n\r\n## Z\n- z\n';
  const crossMoveWorkspace = { ...crossMoveBase, constraintsEditor: { ...crossMoveBase.constraintsEditor, text: crossMoveSource, parsedText: crossMoveSource } };
  const crossMoved = f.editWritingConstraints(crossMoveWorkspace, crossMoveWorkspace.book.id, { type: 'move', id: crossMoveRows[1].id, direction: 1 });
  assert.equal(crossMoved.constraintsEditor.text, '\r\n## X\r\n* x\r\n\r\n## B\n+ two\n\n## A\n- one\r\n\r\n## Z\n- z\n', 'A cross-category move reconstructs only the two affected groups and preserves unrelated mixed-EOL bytes');
  assert.throws(() => f.editWritingConstraints(crossMoveWorkspace, crossMoveWorkspace.book.id,
    { type: 'add', category: 'Z', content: 'collision' }, { randomUUID: () => crossMoveRows[0].id }), /constraintsCrypto/,
  'Visual Add rejects a UUID provider collision with every existing row');
});

test('visual rule edits are target-local and never steal a duplicate neighbor UUID', () => {
  const rows = [row('same'), row('same', { enabled: false }), row('tail', { category: '对话' })];
  const sourceText = '## 环境\r\n\r\n- [x] same\r\n- [ ] same\r\n\r\n## 对话\r\n- [x] tail';
  const base = fixture(rows);
  const w = { ...base, constraintsEditor: { ...base.constraintsEditor, text: sourceText, parsedText: sourceText } };
  const projection = f.constraintVisualTargets(w.constraintsEditor.text, w.settings.writingConstraints, { randomUUID });
  const target = { ...projection.rules[0], expectedText: w.constraintsEditor.text };
  const result = f.editConstraintVisualBlock(w, w.book.id, target, 'same\n- nested Markdown', { randomUUID });
  assert.equal(result.valid, true);
  assert.deepEqual(result.workspace.settings.writingConstraints.map(item => item.id), rows.map(item => item.id));
  assert.deepEqual(result.workspace.settings.writingConstraints.map(item => item.enabled), [true, false, true]);
  assert.equal(result.workspace.settings.writingConstraints[0].content, 'same\n- nested Markdown');
  const changed = 'same\n      - nested Markdown';
  assert.equal(result.workspace.constraintsEditor.text, sourceText.slice(0, target.start) + changed + sourceText.slice(target.end));
  assert.match(result.workspace.constraintsEditor.text, /## 对话\r\n- \[x\] tail$/);
});

test('invalid visual drafts journal exact text while canonical rows stay last-valid, then repair through the same target', () => {
  const rows = [row('original')], w = fixture(rows);
  const target = { ...f.constraintVisualTargets(w.constraintsEditor.text, rows, { randomUUID }).rules[0], expectedText: w.constraintsEditor.text };
  const invalid = f.editConstraintVisualBlock(w, w.book.id, target, '', { randomUUID });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.workspace.constraintsEditor.error, 'constraintsMarkdownInvalid');
  assert.equal(invalid.workspace.settings.writingConstraints[0].content, 'original');
  assert.equal(invalid.workspace.constraintsEditor.text.slice(invalid.target.start, invalid.target.end), '');
  assert.equal(invalid.workspace.constraintsEditor.parsedText, w.constraintsEditor.parsedText);
  const repaired = f.editConstraintVisualBlock(invalid.workspace, w.book.id, invalid.target, 'repaired', { randomUUID });
  assert.equal(repaired.valid, true);
  assert.equal(repaired.workspace.settings.writingConstraints[0].content, 'repaired');
  assert.equal(repaired.workspace.constraintsEditor.error, '');
  assert.equal(f.editConstraintVisualBlock(repaired.workspace, w.book.id, target, 'stale', { randomUUID }), null, 'Old source token is rejected');
  assert.equal(f.editConstraintVisualBlock(repaired.workspace, 'other-book', repaired.target, 'cross-book', { randomUUID }), null);
});

test('visual target guards reject stale IDs, reordered category members, limits and surrogate halves without truncation', () => {
  const rows = [row('one'), row('two')], w = fixture(rows);
  const group = f.constraintVisualTargets(w.constraintsEditor.text, rows, { randomUUID }).groups[0];
  const target = { ...group, expectedText: w.constraintsEditor.text };
  assert.equal(f.editConstraintVisualBlock(w, w.book.id, { ...target, ids: [...target.ids].reverse() }, '环境2', { randomUUID }), null);
  assert.equal(f.editConstraintVisualBlock(w, w.book.id, { ...target, ids: [randomUUID()] }, '环境2', { randomUUID }), null);
  const longCategory = f.editConstraintVisualBlock(w, w.book.id, target, '类'.repeat(81), { randomUUID });
  assert.equal(longCategory.valid, false); assert.equal(longCategory.workspace.settings.writingConstraints[0].category, '环境');
  const ruleTarget = { ...f.constraintVisualTargets(w.constraintsEditor.text, rows, { randomUUID }).rules[0], expectedText: w.constraintsEditor.text };
  const surrogate = f.editConstraintVisualBlock(w, w.book.id, ruleTarget, '\ud800', { randomUUID });
  assert.equal(surrogate.valid, false); assert.equal(surrogate.workspace.constraintsEditor.text.slice(surrogate.target.start, surrogate.target.end), '\ud800');
});

test('ID-less unmatched full paste without previous-document binding gets fresh UUIDs', () => {
  const old = [row('旧')], parsed = f.parseConstraintsMarkdown('- 新类别\n    - 全新规则', old);
  assert.equal(parsed.error, '');
  assert.notEqual(parsed.rows[0].id, old[0].id);
});

test('invalid raw survives journal/reopen and blocks constraints autosave while body/title still save', () => {
  const base = fixture([row('原规则')]);
  let w = edit(base, base.constraintsEditor.text.replace('原规则', '有效但未发送'));
  w = edit(w, w.constraintsEditor.text + '\n- 未完成类别');
  assert.ok(w.constraintsEditor.error);
  assert.equal(w.settings.writingConstraints[0].content, '有效但未发送');
  assert.equal(f.dirty(w).settings, true);
  assert.equal(f.autosaveStep(w), null, 'Never save stale last-valid array during newer invalid source');
  w = { ...w, chapter: { ...w.chapter, body: '正文可以独立保存' }, settings: { ...w.settings, title: '标题仍可保存' } };
  const bodyStep = f.autosaveStep(w);
  assert.deepEqual(bodyStep.operation.patch, { body: '正文可以独立保存' });
  w = ack(w, w, bodyStep);
  const titleStep = f.autosaveStep(w);
  assert.deepEqual(titleStep.operation.patch, { title: '标题仍可保存' });
  w = ack(w, w, titleStep);
  const journal = clone(f.recoveryPayload(w));
  assert.equal(f.validRecovery(journal, w.book.id), true);
  const restored = f.restoredAutosaveWorkspace(f.workspace(w.book, w.chapterId), journal);
  assert.equal(restored.constraintsEditor.text, w.constraintsEditor.text);
  assert.equal(restored.constraintsEditor.error, w.constraintsEditor.error);
  assert.equal(f.autosaveStep(restored), null);
  const selection = f.capturePolishSnapshot(restored, 0, 2);
  assert.equal(f.polishIntentProblem(restored, selection), 'saveFirst');
});

test('raw-only invalid draft, including an unfinished surrogate, survives valid recovery and remote conflict', () => {
  for (const raw of ['- 类别', '\ud800', '', '- 环境\n    - [x] ']) {
    const base = fixture([row()]), w = edit(base, raw), journal = clone(f.recoveryPayload(w));
    assert.ok(w.constraintsEditor.error);
    assert.deepEqual(w.settings.writingConstraints, base.settings.writingConstraints);
    assert.equal(f.validRecovery(journal, base.book.id), true, JSON.stringify(raw));
    assert.equal(f.restoredWorkspace(base, journal).constraintsEditor.text, raw);
    const remote = mutateBook(base.book, { action: 'updateBook', patch: { writingConstraints: [row('外部修改')] } });
    assert.deepEqual(f.conflictingFields(w, remote), ['settings']);
    assert.equal(f.mergeWorkspace(w, remote).constraintsEditor.text, raw);
  }
});

test('emptying nonempty source is not delete-all; explicit remove may delete last rule', () => {
  const base = fixture([row()]), empty = edit(base, '');
  assert.equal(empty.constraintsEditor.error, 'constraintsMarkdownEmpty');
  assert.equal(f.autosaveStep(empty), null);
  const removed = f.editWritingConstraints(base, base.book.id, { type: 'remove', id: base.settings.writingConstraints[0].id });
  assert.equal(removed.constraintsEditor.error, '');
  assert.deepEqual(f.autosaveStep(removed).operation.patch, { writingConstraints: [] });
  assert.equal(f.parseConstraintsMarkdown('').error, '');
});

test('invalid raw cannot be overwritten by enable/delete/move/add helper operations', () => {
  const base = fixture([row(), row('第二条')]), w = edit(base, base.constraintsEditor.text + '\n- 未完成');
  for (const action of [{ type: 'remove', id: base.settings.writingConstraints[0].id }, { type: 'edit', id: base.settings.writingConstraints[0].id, field: 'enabled', value: false }, { type: 'move', id: base.settings.writingConstraints[0].id, direction: 1 }, { type: 'add' }]) {
    assert.equal(f.editWritingConstraints(w, w.book.id, action), w);
  }
});

test('ACK retains newer invalid raw and only acknowledges SENT parsedText', () => {
  const base = fixture([row('原')]), sent = edit(base, base.constraintsEditor.text.replace('原', 'A'));
  const local = edit(sent, sent.constraintsEditor.text + '\n- unfinished');
  const next = ack(local, sent);
  assert.equal(next.constraintsEditor.text, local.constraintsEditor.text);
  assert.equal(next.constraintsEditor.baseText, sent.constraintsEditor.parsedText);
  assert.ok(next.constraintsEditor.error);
  assert.equal(f.isDirty(next), true);
  assert.equal(f.autosaveStep(next), null);
});

test('A-send then undo-to-original remains dirty across pending projection, restart, and ACK', () => {
  const base = fixture([row('原')]), sent = edit(base, base.constraintsEditor.text.replace('原', 'A'));
  const local = edit(sent, base.constraintsEditor.text), step = f.autosaveStep(sent);
  assert.deepEqual(local.settings.writingConstraints, base.settings.writingConstraints);
  const journal = clone(f.autosaveRecoveryPayload(local, { pendingSnapshot: { snapshot: sent, step } }));
  assert.equal(journal.constraintsEditor.baseText, sent.constraintsEditor.parsedText);
  assert.equal(f.validRecovery(journal, base.book.id), true);
  const reopened = f.restoredAutosaveWorkspace(base, journal);
  assert.equal(f.isDirty(reopened), true);
  const next = ack(local, sent, step);
  assert.equal(next.constraintsEditor.text, base.constraintsEditor.text);
  assert.equal(next.constraintsEditor.baseText, sent.constraintsEditor.parsedText);
  assert.equal(f.isDirty(next), true);
  assert.deepEqual(f.autosaveStep(next).operation.patch.writingConstraints, base.settings.writingConstraints);
});

test('well-shaped corrupted journal cannot label unrelated canonical rows as parsed or saved', () => {
  const base = fixture([row('原')]), changed = edit(base, base.constraintsEditor.text.replace('原', 'B'));
  const journal = clone(f.recoveryPayload(changed));
  assert.equal(f.validRecovery(journal, base.book.id), true);
  const parsedMismatch = clone(journal);
  parsedMismatch.constraintsEditor.text = parsedMismatch.constraintsEditor.parsedText = '- 环境\n    - [x] C';
  assert.equal(f.validRecovery(parsedMismatch, base.book.id), false);
  const baseMismatch = clone(journal); baseMismatch.constraintsEditor.baseText = '- 环境\n    - [x] 不同基准';
  assert.equal(f.validRecovery(baseMismatch, base.book.id), false);
  const accessor = { ...journal.constraintsEditor }; Object.defineProperty(accessor, 'text', { enumerable: true, get() { throw Error('must not run'); } });
  assert.equal(f.validConstraintsEditor(accessor), false);
});

test('explicit rebase advances both canonical and local-document baselines without losing invalid raw', () => {
  const base = fixture([row('原')]), local = edit(base, base.constraintsEditor.text + '\n- 未完成类别');
  const remote = mutateBook(base.book, { action: 'updateBook', patch: { writingConstraints: [row('远端')] } });
  const rebased = f.mergeWorkspace(local, remote, null, true);
  assert.equal(rebased.constraintsEditor.text, local.constraintsEditor.text);
  assert.equal(rebased.constraintsEditor.parsedText, local.constraintsEditor.parsedText);
  assert.equal(rebased.constraintsEditor.baseText, f.serializeConstraintsMarkdown(remote.writingConstraints));
  assert.equal(f.validRecovery(clone(f.recoveryPayload(rebased)), base.book.id), true);
  assert.equal(f.restoredAutosaveWorkspace(f.workspace(remote, base.chapterId), clone(f.recoveryPayload(rebased))).constraintsEditor.text, local.constraintsEditor.text);
});

test('unavailable or throwing UUID providers preserve valid-looking source as a recoverable local error', () => {
  const base = fixture(), text = '- 新类别\n    - 新规则';
  for (const provider of [null, {}, { randomUUID() { throw new Error('disabled'); } }]) {
    const changed = f.editConstraintsMarkdown(base, base.book.id, text, provider);
    assert.equal(changed.constraintsEditor.text, text);
    assert.equal(changed.constraintsEditor.error, 'constraintsCrypto');
    assert.deepEqual(changed.settings.writingConstraints, []);
    assert.equal(f.validRecovery(clone(f.recoveryPayload(changed)), base.book.id), true);
    assert.equal(f.autosaveStep(changed), null);
  }
});

test('pure formatting ACK has no Host patch or extra request and does not stay falsely dirty', async () => {
  const base = fixture([row()]); let current = edit(base, base.constraintsEditor.text.replace('    - [x] ', '    - '));
  assert.equal(f.isDirty(current), true);
  assert.equal(f.autosaveStep(current), null);
  let sends = 0;
  const controller = f.createAutosaveController({ getWorkspace: () => current, getEpoch: () => 0, isPaused: () => false,
    send: () => { sends++; throw Error('must not send'); }, apply: next => { current = next; }, fail: error => { throw error; } });
  await controller.flush();
  assert.equal(sends, 0);
  assert.equal(f.isDirty(current), false);
  assert.equal(current.constraintsEditor.text, current.constraintsEditor.baseText);
  controller.dispose();
});

test('Markdown schema limits and oversized raw input fail without truncation or a partial canonical update', () => {
  const base = fixture([row()]);
  for (const text of ['- ' + '类'.repeat(81) + '\n    - 文', '- 类\n    - ' + '文'.repeat(4001), Array.from({ length: 65 }, (_, i) => '- 类' + i + '\n    - 文').join('\n')]) {
    const next = edit(base, text);
    assert.ok(next.constraintsEditor.error);
    assert.deepEqual(next.settings.writingConstraints, base.settings.writingConstraints);
    assert.equal(next.constraintsEditor.text, text);
  }
  assert.throws(() => edit(base, 'x'.repeat(2000001)), /constraintsMarkdownTooLong/);
  assert.deepEqual(base.settings.writingConstraints, base.book.writingConstraints);
});

test('every schema-valid newline-heavy canonical row fits the local document and recovery cap', () => {
  const rows = Array.from({ length: 64 }, (_, index) => row('\n'.repeat(3997) + 'end', { category: '类别' + index, enabled: index % 2 === 0 }));
  const w = fixture(rows), text = w.constraintsEditor.text;
  assert.ok(text.length > 1700000 && text.length < 2000000);
  assert.deepEqual(f.parseConstraintsMarkdown(text, rows).rows, rows);
  const changed = { ...w, settings: { ...w.settings, title: '只是编辑标题' } };
  assert.equal(f.validRecovery(clone(f.recoveryPayload(changed)), w.book.id), true);
});

test('native Markdown Tab, ShiftTab, Enter continuation and IME guards use exact selections', () => {
  assert.deepEqual(f.markdownTextareaEdit('- 类', 3, 3, 'Tab'), { value: '    - 类', start: 7, end: 7 });
  const indented = f.markdownTextareaEdit('甲\n乙', 0, 3, 'Tab');
  assert.deepEqual(indented, { value: '    甲\n    乙', start: 4, end: 11 });
  assert.deepEqual(f.markdownTextareaEdit(indented.value, indented.start, indented.end, 'Tab', { shiftKey: true }), { value: '甲\n乙', start: 0, end: 3 });
  const content = '    - [x] 规则', enter = f.markdownTextareaEdit(content, content.length, content.length, 'Enter');
  assert.equal(enter.value, content + '\n    - [ ] ');
  assert.equal(f.markdownTextareaEdit('1. rule', 7, 7, 'Enter').value, '1. rule\n2. ');
  assert.equal(f.markdownTextareaEdit('    - ', 6, 6, 'Enter').value, '\n');
  for (const key of ['Enter', 'Tab']) assert.equal(f.markdownTextareaEdit(content, 0, 0, key, { composing: true }), null);
  assert.equal(f.markdownTextareaEdit(content, 0, 0, 'Enter', { shiftKey: true }), null);
  assert.equal(f.markdownTextareaEdit('\n', 0, 0, 'Tab').start, 4);
});

test('collapsed Tab turns a new category-level bullet into a parseable child rule', () => {
  const text = '- 环境\n- 新条目', expected = '- 环境\n    - 新条目';
  const changed = f.markdownTextareaEdit(text, text.length, text.length, 'Tab');
  assert.deepEqual(changed, { value: expected, start: text.length + 4, end: text.length + 4 });
  const parsed = f.parseConstraintsMarkdown(changed.value);
  assert.equal(parsed.error, '');
  assert.deepEqual(parsed.rows.map(({ category, content, enabled }) => ({ category, content, enabled })), [
    { category: '环境', content: '新条目', enabled: true },
  ]);
  assert.deepEqual(f.markdownTextareaEdit(changed.value, changed.start, changed.end, 'Tab', { shiftKey: true }),
    { value: text, start: text.length, end: text.length });

  const start = source.indexOf('    function markdownTextareaEdit('), end = source.indexOf('    // A small, bounded Markdown renderer', start);
  const helper = source.slice(start, end), anchor = "      if (key === 'Tab') {\n";
  assert.equal(helper.split(anchor).length, 2, 'mutant anchor must be unique');
  const oldInlineInsert = new Function('textareaValue', helper.replace(anchor, anchor +
    "        if (start === end && !shiftKey) return { value: value.slice(0, start) + '    ' + value.slice(end), start: start + 4, end: start + 4 };\n") + '\nreturn markdownTextareaEdit;')(f.textareaValue);
  const mutant = oldInlineInsert(text, text.length, text.length, 'Tab');
  assert.throws(() => assert.equal(f.parseConstraintsMarkdown(mutant.value).error, ''), undefined, 'old inline-space behavior must fail the structural assertion');
});

test('native CRLF no-op and multiline source edit preserve untouched CRLF outside the edit', () => {
  const raw = '- 环境\r\n    - [ ] 首行\r\n      次行';
  const parsed = f.parseConstraintsMarkdown(raw);
  assert.equal(parsed.error, '');
  const w = fixture(parsed.rows), withRaw = { ...w, constraintsEditor: { text: raw, parsedText: raw, baseText: raw, error: '' } };
  assert.equal(edit(withRaw, f.textareaValue(raw)), withRaw);
  const changed = edit(withRaw, f.textareaValue(raw).replace('次行', '新次行'));
  assert.equal(changed.constraintsEditor.text, raw.replace('次行', '新次行'));
  assert.equal(changed.settings.writingConstraints[0].content, '首行\r\n新次行');
});

test('legacy source-validity predicate remains strict for invalid and wrong-book drafts', () => {
  const valid = fixture([row()]);
  assert.equal(f.constraintsPreviewReady(valid, valid.book.id), true);
  const invalid = edit(valid, '- 未完成类别');
  assert.equal(invalid.constraintsEditor.error, 'constraintsMarkdownInvalid');
  assert.equal(f.constraintsPreviewReady(invalid, valid.book.id), false);
  assert.equal(f.constraintsPreviewReady(valid, randomUUID()), false);
  assert.equal(f.constraintsPreviewReady(null, valid.book.id), false);
  const repaired = edit(invalid, valid.constraintsEditor.text.replace('随人物感知展开。', '修复后的规则'));
  assert.equal(repaired.constraintsEditor.error, '');
  assert.equal(f.constraintsPreviewReady(repaired, valid.book.id), true);
});

test('safe preview supports common inline/block Markdown without HTML or remote image nodes', () => {
  const inline = f.markdownInline('**加粗** *斜体* ~~删除~~ `code` [安全](https://example.com) ![image](https://remote.example/x.png) <script>alert(1)</script>');
  for (const type of ['strong', 'em', 'del', 'code', 'a']) assert.ok(types(inline).includes(type), type);
  assert.ok(textOf(inline).includes('![image](https://remote.example/x.png)'));
  assert.ok(textOf(inline).includes('<script>alert(1)</script>'));
  assert.ok(!types(inline).includes('img'));
  const blocks = f.markdownBlocks('# 标题\n\n> 引用\n\n- 外层\n  - 内层\n\n1. 有序\n\n```js\n<script>literal</script>\n```\n\n---');
  for (const type of ['h1', 'blockquote', 'ul', 'ol', 'li', 'pre', 'hr']) assert.ok(types(blocks).includes(type), type);
  assert.ok(textOf(blocks).includes('<script>literal</script>'));
  assert.deepEqual(f.markdownBlocks('x'.repeat(20001)), [{ type: 'p', text: 'x'.repeat(20001) }]);
});

test('URL scheme allowlist blocks javascript/data/file/obfuscated/control-char links', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,evil', 'file:///private', ' https://example.com', 'https:\n//evil', '//evil', 'java&#x73;cript:alert(1)', 'javascript%3Aalert(1)']) assert.equal(f.safeMarkdownUrl(url), null, url);
  for (const url of ['https://example.com/x', 'http://example.com', 'mailto:author@example.com']) assert.equal(f.safeMarkdownUrl(url), url);
  const unsafe = f.markdownInline('[bad](javascript:alert(1)) [data](data:text/html,x)');
  assert.ok(!types(unsafe).includes('a'));
});

test('constraint tab mounts one editor for both presentations and never substitutes old raw', () => {
  const ui = source.slice(source.indexOf('          const renderConstraints ='), source.indexOf('          const renderSettings ='));
  const surface = source.slice(source.indexOf('    function ConstraintsTextSurface('), source.indexOf('    function Icon('));
  assert.match(ui, /const raw = constraintsSourceBook === bookId/);
  assert.match(ui, /'data-mode': raw \? 'source' : 'continuous'/);
  assert.equal((ui.match(/h\(ConstraintsTextSurface, /g) || []).length, 1);
  assert.doesNotMatch(ui, /activeBlock|activateBlock|h\('textarea'|h\('pre'|editor\.parsedText|dangerouslySetInnerHTML/);
  assert.match(ui, /button\(t\(raw \? 'constraintsHideSource' : 'constraintsShowSource'\), toggleRaw, \{ disabled: readOnly, 'aria-controls': editorId \}\)/);
  assert.doesNotMatch(ui, /'aria-pressed': raw/);
  assert.match(ui, /onInput: update => changeConstraintsMarkdown\(bookId, update\) && getDraft\(\)/);
  assert.match(ui, /describedBy: hintId \+ \(editor\.error \|\| limit \? ' ' \+ errorId/);
  assert.match(ui, /role: 'status' \}, t\(limit \? 'constraintsMarkdownTooLong' : editor\.error\)/);
  assert.match(ui, /constraintsInputBlocked\(\) && !autosaveComposing\.current/);
  assert.match(ui, /setConfirm\(\{ title: t\('constraintsDeleteTitle'\)/);
  assert.match(ui, /sameConstraintsDraft\(snapshot, getDraft\(\)\)/);
  assert.match(ui, /if \(fallback\) focusTarget\(next, 'rule', fallback\.id\)/);
  assert.equal((surface.match(/\.createContinuousMarkdown\(/g) || []).length, 1);
  assert.match(surface, /owner\.current === connection/);
  assert.match(surface, /instance\.destroy\(\)/);
  assert.match(surface, /entry\.instance\.sync\(\{[\s\S]*text: textareaValue\(currentDraft\.text\)/);
  assert.match(surface, /entry\.instance\.focusRange\(pending\.start, pending\.end\)/);
});

test('compiled guide examples round-trip as two rules, preserving the inner bullet as content', () => {
  const dictionaries = new Function(source.slice(source.indexOf('    const en ='), source.indexOf('    const CSS =')) + '\nreturn [en, zh];')();
  for (const locale of dictionaries) {
    const result = f.parseConstraintsMarkdown(locale.constraintsGuideExample);
    assert.equal(result.error, '');
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.rows.map(row => row.enabled), [true, false]);
    assert(!result.rows[0].content.startsWith('- '));
    assert(result.rows[1].content.startsWith('- '));
  }
  assert.deepEqual([dictionaries[1].constraintsWriteRules, dictionaries[1].constraintsShowSource, dictionaries[1].constraintsHideSource],
    ['编写规则', '显示 Markdown 语法', '隐藏 Markdown 语法']);
});

test('writing guide opens before Add category, owns focus, and never replaces the editor', () => {
  const ui = source.slice(source.indexOf('          const renderConstraints ='), source.indexOf('          const renderSettings ='));
  const start = ui.indexOf("button(t('constraintsWriteRules')");
  assert(start >= 0);
  const action = ui.slice(start, ui.indexOf("button(t('constraintsAddCategory')", start));
  assert.match(action, /!constraintsHelpBlocked && !autosaveComposing\.current && current\.current\?\.book.id === bookId/);
  assert.match(action, /'aria-haspopup': 'dialog'/);
  assert.doesNotMatch(ui, /t\('constraints(?:Help|DraftHint|ModelHint)'\)/, 'No second inline instructions');
  assert.match(source, /constraintsHelpOpen && h\(Modal, \{ id: constraintsHelpId, role: 'dialog', title: t\('constraintsHelp'\), onCancel: closeConstraintsHelp, returnFocus: constraintsHelpTrigger/);
  assert.match(source, /ref: closeRef, disabled: false/);
  assert.match(source, /const target = returnFocus\?\.current \|\| old/);
  assert.equal((source.match(/inert: \(constraintsHelpOpen \|\| !!chapterDeleteConfirm \|\| !!confirm\?\.outlineDecision\) \|\| undefined/g) || []).length, 2);
  assert.match(source, /constraintsHelpOpen = !constraintsHelpBlocked && tab === 'constraints'/);
  assert.match(source, /h\('pre', \{ className: 'mx-constraint-guide-example' \}, t\('constraintsGuideExample'\)\)/);
});

test('raw syntax action switches both directions and stays put during composition or book change', () => {
  const start = source.indexOf('            const toggleRaw =');
  const callback = source.slice(start, source.indexOf('            const activeName =', start));
  const run = new Function('raw', 'bookId', 'autosaveComposing', 'current', 'constraintsInputBlocked', 'setConstraintsSourceBook', callback + '\nreturn toggleRaw;');
  const bookId = 'test-book', calls = [], write = value => calls.push(value);
  const book = id => ({ current: { book: { id } } });
  run(false, bookId, { current: false }, book(bookId), () => false, write)();
  run(true, bookId, { current: true }, book(bookId), () => false, write)();
  run(true, bookId, { current: false }, book('changed-book'), () => false, write)();
  run(true, bookId, { current: false }, book(bookId), () => true, write)();
  run(true, bookId, { current: false }, book(bookId), () => false, write)();
  assert.deepEqual(calls, [bookId, '']);
});

test('source-review UTF16/model helper block is byte-identical to the protected prechange block', () => {
  const protectedBlock = source.slice(source.indexOf('    const textareaValue ='), source.indexOf('    const en ='));
  assert.equal(createHash('sha256').update(protectedBlock).digest('hex'), '8b05aafaa77dc626c68aa6812c80350c2cb9e33c9ecc5bcbceffab43456c8148');
});
