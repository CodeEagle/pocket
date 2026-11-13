// The Studio shell's keyboard map: ONE table, resolved from raw-input key names
// (sdk/docs/STUDIO_TEXT_INPUT.md: modifiers folded in the order Control, Alt, Shift, Meta, e.g. "Meta+s",
// "Shift+Meta+B", "Control+Shift+p"). Pure TypeScript: no Solid, no host. The shell executes the resulting
// command id (state/commands.ts) and the Settings page renders the same table, so help can never drift.
//
// Precedence with the CodeView's own keymap (@pocket/ui/code `lookupKey`):
//  - "editor" scope bindings (save, find) are editor commands while a CodeView has the keyboard: the CodeView
//    handles them itself (its save intent calls the same save flow; Cmd+F opens its find bar) and the shell
//    does NOT act. When no editor has the keyboard (another page, a focused plain field's neighbours) the shell
//    runs them.
//  - "global" bindings win over the editor even when the CodeView's keymap also maps the key (the shell sees
//    the key first through CodeView's `onKeyDown` hook). A global binding whose command is not applicable at
//    that moment (Esc/arrows with nothing open) reports "not handled", so the key still reaches the editor.
//  - Keys no binding names always reach the editor untouched.
import { parseKey } from "@pocket/ui/code";

export type ShellCommand =
  | "save" | "find" | "build" | "buildPreview" | "quickOpen" | "closeTab" | "prevTab" | "nextTab" | "publish"
  | "closeOverlay" | "listUp" | "listDown" | "listAccept"
  | "page1" | "page2" | "page3" | "page4" | "page5" | "page6" | "page7" | "page8" | "page9";

export type KeyScope = "global" | "editor";
/** "mac": Mod = Meta. "other": Mod = Control. "any": either (Studio tests and non-mac hosts; the default). */
export type KeyPlatform = "mac" | "other" | "any";

export interface Binding {
  command: ShellCommand;
  /** Canonical chord: `Mod+Shift+b`, `Mod+1`, `Escape`. Letters are lower case; `Mod` is the primary modifier. */
  chord: string;
  scope: KeyScope;
  /** Settings/help text (zh, like the rest of the Studio UI). */
  label: string;
  /** Hidden from the help list (modal list navigation). */
  hidden?: boolean;
}

export const PAGE_COMMANDS: readonly ShellCommand[] = ["page1", "page2", "page3", "page4", "page5", "page6", "page7", "page8", "page9"];

export const KEYMAP: readonly Binding[] = [
  { command: "save", chord: "Mod+s", scope: "editor", label: "保存当前文件" },
  { command: "find", chord: "Mod+f", scope: "editor", label: "在当前文件中查找" },
  { command: "build", chord: "Mod+b", scope: "global", label: "构建项目" },
  { command: "buildPreview", chord: "Mod+Shift+b", scope: "global", label: "构建并刷新预览" },
  { command: "quickOpen", chord: "Mod+p", scope: "global", label: "快速打开文件" },
  { command: "closeTab", chord: "Mod+w", scope: "global", label: "关闭当前标签" },
  { command: "prevTab", chord: "Mod+Shift+[", scope: "global", label: "上一个标签" },
  { command: "nextTab", chord: "Mod+Shift+]", scope: "global", label: "下一个标签" },
  { command: "publish", chord: "Mod+Shift+p", scope: "global", label: "打开发布页" },
  { command: "page1", chord: "Mod+1", scope: "global", label: "项目页" },
  { command: "page2", chord: "Mod+2", scope: "global", label: "源码页" },
  { command: "page3", chord: "Mod+3", scope: "global", label: "控制台页" },
  { command: "page4", chord: "Mod+4", scope: "global", label: "预览页" },
  { command: "page5", chord: "Mod+5", scope: "global", label: "资源页" },
  { command: "page6", chord: "Mod+6", scope: "global", label: "设置页" },
  { command: "page7", chord: "Mod+7", scope: "global", label: "产物页" },
  { command: "page8", chord: "Mod+8", scope: "global", label: "发布页" },
  { command: "page9", chord: "Mod+9", scope: "global", label: "版本页" },
  { command: "closeOverlay", chord: "Escape", scope: "global", label: "关闭对话框 / 快速打开" },
  { command: "listUp", chord: "ArrowUp", scope: "global", label: "快速打开：上一项", hidden: true },
  { command: "listDown", chord: "ArrowDown", scope: "global", label: "快速打开：下一项", hidden: true },
  { command: "listAccept", chord: "Enter", scope: "global", label: "快速打开：打开所选", hidden: true },
];

interface ParsedChord { mod: boolean; shift: boolean; alt: boolean; key: string }

function parseChord(chord: string): ParsedChord {
  const out: ParsedChord = { mod: false, shift: false, alt: false, key: "" };
  let rest = chord;
  for (;;) {
    if (rest.startsWith("Mod+") && rest.length > 4) { out.mod = true; rest = rest.slice(4); }
    else if (rest.startsWith("Shift+") && rest.length > 6) { out.shift = true; rest = rest.slice(6); }
    else if (rest.startsWith("Alt+") && rest.length > 4) { out.alt = true; rest = rest.slice(4); }
    else break;
  }
  out.key = rest;
  return out;
}

const PARSED = KEYMAP.map((binding) => ({ binding, chord: parseChord(binding.chord) }));
// KeyboardEvent.key for Shift+[ and Shift+] on a US layout.
const SHIFTED: Record<string, string> = { "{": "[", "}": "]" };

export interface KeyContext {
  platform?: KeyPlatform;
  /** True when the key arrives through a focused CodeView: "editor" scope bindings are then the editor's. */
  editorFocused?: boolean;
}

/** The command a raw key name triggers, or undefined when no binding applies. */
export function resolveShellKey(name: string, context: KeyContext = {}): ShellCommand | undefined {
  const platform = context.platform ?? "any";
  const k = parseKey(name);
  if (!k.key || k.key === "Meta" || k.key === "Control" || k.key === "Shift" || k.key === "Alt") return undefined;
  const key = k.shift && SHIFTED[k.key] ? SHIFTED[k.key]! : k.key;
  // Exactly one of Meta/Control is the primary modifier; the other one is never ours.
  const primary = platform === "mac" ? k.meta && !k.control : platform === "other" ? k.control && !k.meta : k.meta !== k.control;
  for (const { binding, chord } of PARSED) {
    if (chord.key !== key) continue;
    if (chord.mod !== primary || chord.shift !== k.shift || chord.alt !== k.alt) continue;
    if (binding.scope === "editor" && context.editorFocused) return undefined;
    return binding.command;
  }
  return undefined;
}

/** Display form of a chord: "⌘⇧B" on mac, "Ctrl+Shift+B" elsewhere. */
export function displayChord(chord: string, platform: KeyPlatform = "mac"): string {
  const p = parseChord(chord);
  const key = p.key.length === 1 ? p.key.toUpperCase() : p.key === "Escape" ? "Esc" : p.key;
  if (platform === "mac" || platform === "any") return `${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""}${p.mod ? "⌘" : ""}${key}`;
  return [p.mod ? "Ctrl" : "", p.alt ? "Alt" : "", p.shift ? "Shift" : "", key].filter(Boolean).join("+");
}

/** Rows of the help list (hidden bindings omitted). */
export function helpRows(platform: KeyPlatform = "mac"): Array<{ chord: string; label: string; scope: KeyScope }> {
  return KEYMAP.filter((b) => !b.hidden).map((b) => ({ chord: displayChord(b.chord, platform), label: b.label, scope: b.scope }));
}
