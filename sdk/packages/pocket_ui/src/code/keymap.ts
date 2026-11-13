/**
 * Keymap from raw-input key names (STUDIO_TEXT_INPUT.md, modifiers folded in
 * the order Control, Alt, Shift, Meta: "Control+Shift+z", "Alt+ArrowLeft") to
 * command ids. Ids are either keys of `commandTable` (pure edit/move commands)
 * or editor-level ids (see EditorCommandId) handled by `CodeEditor`.
 *
 * Printable keys (no Control/Meta) return null: typed text arrives as `commit`.
 */

export type Platform = "mac" | "other";

/** Ids resolved by the editor rather than the pure command table. */
export type EditorCommandId = "undo" | "redo" | "copy" | "cut" | "paste" | "find" | "findNext" | "findPrev" | "save";

export interface ParsedKey { key: string; control: boolean; alt: boolean; shift: boolean; meta: boolean }

/** Split "Control+Shift+z" into modifiers and key. A trailing "+" key ("Control++") is supported. Single letters are lowercased. */
export function parseKey(name: string): ParsedKey {
  const out: ParsedKey = { key: "", control: false, alt: false, shift: false, meta: false };
  let rest = name;
  for (;;) {
    if (rest.startsWith("Control+") && rest.length > 8) { out.control = true; rest = rest.slice(8); }
    else if (rest.startsWith("Alt+") && rest.length > 4) { out.alt = true; rest = rest.slice(4); }
    else if (rest.startsWith("Shift+") && rest.length > 6) { out.shift = true; rest = rest.slice(6); }
    else if (rest.startsWith("Meta+") && rest.length > 5) { out.meta = true; rest = rest.slice(5); }
    else break;
  }
  out.key = rest.length === 1 ? rest.toLowerCase() : rest;
  return out;
}

/** Resolve a key name to a command id, or null when the key is not an editor shortcut. */
export function lookupKey(name: string, platform: Platform = "mac"): string | null {
  const k = parseKey(name);
  const mac = platform === "mac";
  // The "other" modifier (Control on mac, Meta elsewhere) is never ours.
  if (mac ? k.control : k.meta) return null;
  const p = mac ? k.meta : k.control; // primary shortcut modifier
  const { alt, shift } = k;
  const sel = (id: string) => (shift ? "select" + id : "cursor" + id);

  if (p && !alt) {
    switch (k.key) {
      case "z": return shift ? "redo" : "undo";
      case "y": return shift ? null : "redo";
      case "a": return shift ? null : "selectAll";
      case "c": return shift ? null : "copy";
      case "x": return shift ? null : "cut";
      case "v": return shift ? null : "paste";
      case "f": return shift ? null : "find";
      case "g": return shift ? "findPrev" : "findNext";
      case "s": return shift ? null : "save";
      case "/": return shift ? null : "toggleLineComment";
      case "]": return "indentLines";
      case "[": return "outdent";
    }
  }
  const word = mac ? alt && !p : p && !alt;
  switch (k.key) {
    case "ArrowLeft":
      if (word) return sel("WordLeft");
      if (mac && p && !alt) return sel("LineStart");
      return !alt && !p ? sel("Left") : null;
    case "ArrowRight":
      if (word) return sel("WordRight");
      if (mac && p && !alt) return sel("LineEnd");
      return !alt && !p ? sel("Right") : null;
    case "ArrowUp":
    case "ArrowDown": {
      const up = k.key === "ArrowUp";
      if (p && alt) return shift ? null : up ? "addCursorAbove" : "addCursorBelow";
      if (alt && !p) return shift ? (up ? "duplicateLineUp" : "duplicateLineDown") : up ? "moveLineUp" : "moveLineDown";
      if (mac && p) return sel(up ? "DocStart" : "DocEnd");
      if (p) return null;
      return sel(up ? "Up" : "Down");
    }
    case "Home": return p ? sel("DocStart") : alt ? null : sel("LineStart");
    case "End": return p ? sel("DocEnd") : alt ? null : sel("LineEnd");
    case "PageUp": return p || alt ? null : sel("PageUp");
    case "PageDown": return p || alt ? null : sel("PageDown");
    case "Backspace":
      if (word) return "deleteWordBackward";
      if (mac && p && !alt) return "deleteLineBackward";
      return p || alt ? null : "deleteBackward";
    case "Delete":
      if (word) return "deleteWordForward";
      return p || alt ? null : "deleteForward";
    case "Enter": return p || alt ? null : "newline";
    case "Tab": return p || alt ? null : shift ? "outdent" : "indent";
    case "Escape": return "escape";
  }
  return null;
}
