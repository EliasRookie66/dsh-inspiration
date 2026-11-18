# Standalone constraints editor build

From the plugin root, with Node 22 or later:

```sh
npm --prefix editor-build ci --ignore-scripts
npm --prefix editor-build test
node editor-build/build.mjs /path/to/engine.iife.js
```

The last command writes only the given file (omit the path or use `--stdout` to write to stdout). The minified browser IIFE declares `__dshInspirationContinuousMarkdown.createContinuousMarkdown`; the plugin packager can place that declaration in its own lexical wrapper. npm installs the editor dependencies for the build only; the browser artifact includes its third-party license notices. There is no runtime npm import, CSS fetch, or network asset.

The factory mounts one CodeMirror view. `sync` takes complete options. Switching `raw` keeps the document, selection and history. Different incoming LF text (or one-shot `resetHistory: true` on a different semantic base with identical text) is not authored input and clears stale undo/redo. Pass `initialViewport` from `captureViewport()` only when the saved selection and scroll match the same source. Escape followed by Tab or Shift+Tab leaves the editor when Tab is currently an indentation key.

For authored changes, `acceptInput(update)` runs synchronously before acceptance; return `false` to reject silently or `'limit'` to call `onLimit`. `onInput(update)` commits the accepted LF edit and `onSelection` follows. `beforeVersion` and `version` are opaque WeakMap-compatible identities for app snapshots and follow native undo/redo, including grouped edits. `applyStructure({text,payload})` is an isolated native history event with `origin: 'input.structure'`; `payload` appears only in its direct input callback/guard. In read-only mode that explicitly privileged call requires `acceptInput(update) === true`.

Projection folds recognized inactive syntax and keeps unknown/incomplete syntax literal. It styles category and rule-body headings, bullets/tasks, inline emphasis/strong/strike/code, fenced code, and quotes. Direct HTTP(S)/mailto link labels can be styled but not navigated. Images/HTML remain text. Tables, embedded media, math, footnotes, reference-link rendering, and a full Markdown publishing preview are not implemented. Lists and fenced sections remain document lines rather than replaced layout blocks. Large malformed blocks outside the projection budget remain editable as source.

The Node tests exercise parsing, offset mapping, state transactions and repeatable builds without a DOM emulator. Browser verification is still needed for native selection rendering, scroll restoration, clipboard and platform-specific IME behavior.
