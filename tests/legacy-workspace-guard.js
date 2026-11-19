import assert from 'node:assert/strict';

// Project only the reviewed Markdown journal and optional card-category fields
// out of the legacy workspace region. The original SHA remains unchanged: no
// blanket golden refresh may conceal edits to chapter/card/candidate or guards.
export function legacyWorkspaceRegion(source) {
  const start = source.indexOf('    const cardFields ='), end = source.indexOf('    function validRecovery(', start);
  assert(start >= 0 && end > start);
  let region = source.slice(start, end);
  const additions = [
    ["b.proposals.filter(p => p.chapterId === id && p.mode !== 'outline')", 'b.proposals.filter(p => p.chapterId === id)'],
    ["    const constraintsEditorDirty = w => !!w?.constraintsEditor && w.constraintsEditor.text !== w.constraintsEditor.baseText;\n", ''],
    ['settings: !equal(w.settings, w.baseSettings) || constraintsEditorDirty(w),', 'settings: !equal(w.settings, w.baseSettings),'],
    [' constraintsEditor: constraintsEditorState(book.writingConstraints),', ''],
    ["      if (d.settings && cleared !== 'settings' && w.constraintsEditor) fresh.constraintsEditor = {\n        ...w.constraintsEditor, baseText: rebase ? serializeConstraintsMarkdown(next.writingConstraints) : w.constraintsEditor.baseText };\n", ''],
    [' if (w.constraintsEditor) data.constraintsEditor = { ...w.constraintsEditor };', ''],
    [",\n      ...(Object.hasOwn(c, 'categoryId') ? { categoryId: c.categoryId } : {})", ''],
    ["    const blankCard = (category = '') => ({ kind: 'character', title: '', content: '', status: 'proposed', pinned: false, fromChapter: '1', toChapter: '', tags: '',\n      ...(cardKinds.includes(category) || categoryIdValid(category) ? { categoryId: category } : {}) });", "    const blankCard = () => ({ kind: 'character', title: '', content: '', status: 'proposed', pinned: false, fromChapter: '1', toChapter: '', tags: '' });"],
    ['card: !!w.card && !equalCardFields(w.card, w.baseCard)', 'card: !!w.card && !equal(w.card, w.baseCard)'],
    ['!equalCardFields(w.baseCard, cardFields(next.cards.find(c => c.id === w.card.id)))', '!equal(w.baseCard, cardFields(next.cards.find(c => c.id === w.card.id)))'],
  ];
  for (const [addition, original] of additions) {
    assert.equal(region.split(addition).length - 1, 1, 'Exactly one reviewed workspace extension: ' + addition);
    region = region.replace(addition, original);
  }
  return region;
}
