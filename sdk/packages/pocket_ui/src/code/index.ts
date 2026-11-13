/**
 * Pocket code editor core: pure TypeScript, no DOM/Node APIs, runs in QuickJS.
 * See sdk/docs/CODE_EDITOR_CORE.md.
 *
 * - buffer: TextBuffer, grapheme and word helpers
 * - selection: multi-cursor selection model, ChangeMap
 * - commands: pure edit/move commands returning Transactions
 * - keymap: raw key name -> command id
 * - history: undo/redo with coalescing and bounded memory
 * - ime: composition reducer
 * - tokenizer / theme: line-incremental highlighting
 * - search: find/replace with regex guard
 * - viewport: virtualization and hit-test math
 * - editor: CodeEditor glue (buffer + selection + history + IME + keymap)
 */
export * from "./buffer.ts";
export * from "./selection.ts";
export * from "./commands.ts";
export * from "./keymap.ts";
export * from "./history.ts";
export * from "./ime.ts";
export * from "./tokenizer.ts";
export * from "./theme.ts";
export * from "./search.ts";
export * from "./viewport.ts";
export * from "./editor.ts";
