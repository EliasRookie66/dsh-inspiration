import assert from 'node:assert/strict';

// Project only the explicitly reviewed LOCAL Markdown journal additions out of
// the legacy workspace region. The original SHA remains unchanged: no blanket
// golden refresh may conceal edits to chapter/card/candidate or conflict guards.
export function legacyWorkspaceRegion(source) {
  const start = source.indexOf('    const cardFields ='), end = source.indexOf('    function validRecovery(', start);
  assert(start >= 0 && end > start);
  let region = source.slice(start, end);
  const additions = [
    ["    const constraintsEditorDirty = w => !!w?.constraintsEditor && w.constraintsEditor.text !== w.constraintsEditor.baseText;\n", ''],
    ['settings: !equal(w.settings, w.baseSettings) || constraintsEditorDirty(w),', 'settings: !equal(w.settings, w.baseSettings),'],
    [' constraintsEditor: constraintsEditorState(book.writingConstraints),', ''],
    ["      if (d.settings && cleared !== 'settings' && w.constraintsEditor) fresh.constraintsEditor = {\n        ...w.constraintsEditor, baseText: rebase ? serializeConstraintsMarkdown(next.writingConstraints) : w.constraintsEditor.baseText };\n", ''],
    [' if (w.constraintsEditor) data.constraintsEditor = { ...w.constraintsEditor };', ''],
  ];
  for (const [addition, original] of additions) {
    assert.equal(region.split(addition).length - 1, 1, 'Exactly one reviewed Markdown extension: ' + addition);
    region = region.replace(addition, original);
  }
  return region;
}
