import { describe, expect, test } from "bun:test";
import { KEYMAP, PAGE_COMMANDS, displayChord, helpRows, resolveShellKey } from "../src/keymap.ts";
import { fuzzyFilter, fuzzyScore } from "../src/lib/fuzzy.ts";
import { createManualTimers } from "../src/state/env.ts";
import { createStudio, STUDIO_PAGES } from "../src/state/studio.ts";
import { createFakeClient, flush } from "./fake_client.ts";
import { lookupKey } from "@pocket/ui/code";

describe("keymap", () => {
  test("the shell shortcuts resolve from raw key names (modifiers folded Control, Alt, Shift, Meta)", () => {
    const k = (name: string, platform: "mac" | "other" | "any" = "any") => resolveShellKey(name, { platform });
    expect(k("Meta+s")).toBe("save");
    expect(k("Control+s")).toBe("save");
    expect(k("Meta+b")).toBe("build");
    expect(k("Shift+Meta+B")).toBe("buildPreview");
    expect(k("Shift+Meta+b")).toBe("buildPreview");
    expect(k("Meta+p")).toBe("quickOpen");
    expect(k("Shift+Meta+p")).toBe("publish");
    expect(k("Shift+Meta+P")).toBe("publish");
    expect(k("Meta+w")).toBe("closeTab");
    expect(k("Meta+f")).toBe("find");
    expect(k("Shift+Meta+{")).toBe("prevTab");
    expect(k("Shift+Meta+}")).toBe("nextTab");
    expect(k("Shift+Meta+[")).toBe("prevTab");
    expect(k("Control+Shift+]")).toBe("nextTab");
    for (let n = 1; n <= 9; n += 1) expect(k(`Meta+${n}`)).toBe(PAGE_COMMANDS[n - 1]);
    expect(k("Escape")).toBe("closeOverlay");
  });

  test("platform scoping: Mod is Meta on mac, Control elsewhere; the other modifier is never ours", () => {
    expect(resolveShellKey("Meta+b", { platform: "mac" })).toBe("build");
    expect(resolveShellKey("Control+b", { platform: "mac" })).toBeUndefined();
    expect(resolveShellKey("Control+b", { platform: "other" })).toBe("build");
    expect(resolveShellKey("Meta+b", { platform: "other" })).toBeUndefined();
    // Both held, extra modifiers, and plain keys are not shortcuts.
    expect(resolveShellKey("Control+Meta+b")).toBeUndefined();
    expect(resolveShellKey("Alt+Meta+b")).toBeUndefined();
    expect(resolveShellKey("b")).toBeUndefined();
    expect(resolveShellKey("Meta")).toBeUndefined();
    expect(resolveShellKey("Meta+Shift+x")).toBeUndefined();
    expect(resolveShellKey("Shift+Enter")).toBeUndefined();
  });

  test("precedence: editor-scoped keys belong to the focused CodeView, global keys always reach the shell", () => {
    expect(resolveShellKey("Meta+s", { editorFocused: true })).toBeUndefined();
    expect(resolveShellKey("Meta+f", { editorFocused: true })).toBeUndefined();
    expect(resolveShellKey("Meta+s", { editorFocused: false })).toBe("save");
    expect(resolveShellKey("Meta+p", { editorFocused: true })).toBe("quickOpen");
    expect(resolveShellKey("Shift+Meta+{", { editorFocused: true })).toBe("prevTab");
    // Every editor-scoped binding is really an editor command in CodeView's keymap (so the editor does handle it) ...
    for (const b of KEYMAP.filter((x) => x.scope === "editor")) {
      const name = b.chord.replace("Mod+", "Meta+");
      expect(lookupKey(name, "mac")).not.toBeNull();
    }
    // ... and no global shortcut that is not an intentional override collides with an editor command.
    for (const b of KEYMAP.filter((x) => x.scope === "global" && x.chord.startsWith("Mod+"))) {
      const name = b.chord.replace("Mod+", "Meta+").replace("Shift+Meta+", "Shift+Meta+");
      const owned = lookupKey(name.replace(/^Meta\+Shift\+/, "Shift+Meta+"), "mac");
      // The only documented override: Shift+[ / Shift+] (the editor's outdent / indent-lines) when the host names them "[" / "]".
      if (owned) expect(["prevTab", "nextTab"]).toContain(b.command);
    }
  });

  test("the keymap has unique chords and every command appears once", () => {
    expect(new Set(KEYMAP.map((b) => b.chord)).size).toBe(KEYMAP.length);
    expect(new Set(KEYMAP.map((b) => b.command)).size).toBe(KEYMAP.length);
    expect(PAGE_COMMANDS.length).toBe(STUDIO_PAGES.length);
  });

  test("display and help rows come from the same table", () => {
    expect(displayChord("Mod+Shift+b", "mac")).toBe("⇧⌘B");
    expect(displayChord("Mod+Shift+b", "other")).toBe("Ctrl+Shift+B");
    expect(displayChord("Escape")).toBe("Esc");
    const rows = helpRows("mac");
    expect(rows.length).toBe(KEYMAP.filter((b) => !b.hidden).length);
    expect(rows.find((r) => r.chord === "⌘P")?.label).toContain("快速打开");
    expect(rows.find((r) => r.chord === "⌘S")?.scope).toBe("editor");
  });
});

describe("fuzzy file matching", () => {
  const paths = ["app.tsx", "src/state/workspace.ts", "src/state/build.ts", "src/pages/source.tsx", "src/components/quick-open.tsx", "manifest.json", "src/ui/theme.ts", "tests/probe_session.ts"];
  test("subsequence match, ranked: file-name hits beat folder hits, prefix beats scatter", () => {
    expect(fuzzyScore("src/state/build.ts", "zzz")).toBeUndefined();
    expect(fuzzyFilter(paths, "wsp")[0]!.path).toBe("src/state/workspace.ts");
    expect(fuzzyFilter(paths, "build")[0]!.path).toBe("src/state/build.ts");
    expect(fuzzyFilter(paths, "qo")[0]!.path).toBe("src/components/quick-open.tsx");
    expect(fuzzyFilter(paths, "APP")[0]!.path).toBe("app.tsx");
    expect(fuzzyFilter(paths, "s t").map((m) => m.path)).toContain("src/state/workspace.ts"); // spaces ignored
    const m = fuzzyScore("src/state/build.ts", "sbu")!;
    expect(m.positions.map((i) => "src/state/build.ts"[i]).join("")).toBe("sbu");
  });
  test("empty query lists recent files first, then the rest alphabetically, capped", () => {
    const out = fuzzyFilter(paths, "", { recent: ["src/ui/theme.ts", "gone.ts"], limit: 3 });
    expect(out.map((m) => m.path)).toEqual(["src/ui/theme.ts", "app.tsx", "manifest.json"]);
    expect(fuzzyFilter(paths, "s", { limit: 2 }).length).toBe(2);
  });
});

function makeStudio() {
  const fake = createFakeClient();
  fake.files.set("app.tsx", "export {};\n");
  fake.files.set("src/lib.ts", "export const a = 1;\n");
  fake.files.set("src/state.ts", "export const b = 2;\n");
  const timers = createManualTimers();
  const studio = createStudio({
    client: fake.client, timers,
    runtime: { ensure: async () => {}, create: async () => ({ instanceId: "i1", generation: 1 }), destroy: async () => {}, awaitFirstFrame: async () => {} },
    settingsBackend: { get: async () => undefined, set: async () => {} },
  });
  return { fake, studio, timers };
}

describe("shell commands (keyboard -> stores)", () => {
  test("page keys switch the rail page; project-bound commands say so without a project", async () => {
    const { studio } = makeStudio();
    expect(studio.commands.handleKey("Meta+3")).toBe(true);
    expect(studio.page()).toBe("console");
    expect(studio.commands.handleKey("Meta+6")).toBe(true);
    expect(studio.page()).toBe("settings");
    expect(studio.commands.handleKey("Meta+b")).toBe(true);
    expect(studio.toasts.items().some((t) => t.message.includes("打开一个项目"))).toBe(true);
    expect(studio.commands.handleKey("Meta+s")).toBe(false); // nothing to save: not consumed
    expect(studio.commands.handleKey("Meta+q")).toBe(false);
  });

  test("open a project: Cmd+P quick-open filters, Enter opens the selected file; Cmd+W closes; tab switching wraps", async () => {
    const { fake, studio } = makeStudio();
    await studio.projects.open("alpha");
    await flush();
    expect(studio.page()).toBe("source");
    expect(studio.quickOpen.isOpen()).toBe(false);
    expect(studio.commands.handleKey("Meta+p")).toBe(true);
    expect(studio.quickOpen.isOpen()).toBe(true);
    studio.quickOpen.setQuery("lib");
    expect(studio.quickOpen.state().results[0]!.path).toBe("src/lib.ts");
    expect(studio.commands.handleKey("ArrowDown")).toBe(true);
    expect(studio.quickOpen.state().selected).toBe(0); // one result: wraps
    expect(studio.commands.handleKey("Enter")).toBe(true);
    await flush();
    expect(studio.quickOpen.isOpen()).toBe(false);
    expect(studio.workspace.state().active).toBe("src/lib.ts");
    expect(fake.count("readText")).toBe(1);

    // Open two more files, switch tabs both ways (wrapping).
    await studio.workspace.open("app.tsx");
    await studio.workspace.open("src/state.ts");
    expect(studio.workspace.state().docs.map((d) => d.path)).toEqual(["src/lib.ts", "app.tsx", "src/state.ts"]);
    expect(studio.commands.handleKey("Shift+Meta+}")).toBe(true);
    expect(studio.workspace.state().active).toBe("src/lib.ts"); // wrapped
    expect(studio.commands.handleKey("Shift+Meta+{")).toBe(true);
    expect(studio.workspace.state().active).toBe("src/state.ts");
    expect(studio.commands.handleKey("Meta+w")).toBe(true);
    await flush();
    expect(studio.workspace.state().docs.length).toBe(2);
  });

  test("Esc closes quick-open, then a dialog; with nothing open it is not consumed (the editor keeps it)", async () => {
    const { studio } = makeStudio();
    await studio.projects.open("alpha");
    await flush();
    expect(studio.commands.handleKey("Escape", { editorFocused: true })).toBe(false);
    expect(studio.commands.handleKey("ArrowDown", { editorFocused: true })).toBe(false);
    expect(studio.commands.handleKey("Enter", { editorFocused: true })).toBe(false);
    studio.commands.handleKey("Meta+p");
    expect(studio.commands.handleKey("Escape")).toBe(true);
    expect(studio.quickOpen.isOpen()).toBe(false);
    const pending = studio.dialogs.confirm({ title: "t" });
    expect(studio.commands.handleKey("Escape")).toBe(true);
    expect(await pending).toBe(false);
    // Cmd+P twice toggles.
    studio.commands.handleKey("Meta+p");
    studio.commands.handleKey("Meta+p");
    expect(studio.quickOpen.isOpen()).toBe(false);
  });

  test("build, build+preview, publish page and find route to the real stores", async () => {
    const { fake, studio } = makeStudio();
    await studio.projects.open("alpha");
    await flush();
    expect(studio.commands.handleKey("Meta+b")).toBe(true);
    await flush();
    expect(fake.count("build.start")).toBe(1);
    fake.finishBuild(true);
    await flush();
    expect(studio.commands.handleKey("Shift+Meta+B")).toBe(true);
    await flush();
    expect(fake.count("build.start")).toBe(2);
    fake.finishBuild(true);
    await flush(20);
    expect(fake.count("publish")).toBe(1); // preview publish after the build
    expect(studio.commands.handleKey("Shift+Meta+P")).toBe(true);
    expect(studio.page()).toBe("publish");
    await studio.workspace.open("app.tsx");
    studio.setPage("console");
    const before = studio.commands.requests.get().find;
    expect(studio.commands.handleKey("Meta+f", { editorFocused: false })).toBe(true);
    expect(studio.page()).toBe("source");
    expect(studio.commands.requests.get().find).toBe(before + 1);
    // Editor focused: Cmd+F and Cmd+S are the CodeView's, the shell leaves them alone.
    expect(studio.commands.handleKey("Meta+f", { editorFocused: true })).toBe(false);
    expect(studio.commands.handleKey("Meta+s", { editorFocused: true })).toBe(false);
  });

  test("Cmd+S outside the editor saves the active document", async () => {
    const { fake, studio } = makeStudio();
    await studio.projects.open("alpha");
    await studio.workspace.open("app.tsx");
    studio.workspace.setText("app.tsx", "export const edited = 1;\n");
    expect(studio.commands.handleKey("Control+s")).toBe(true);
    await flush();
    expect(fake.files.get("app.tsx")).toBe("export const edited = 1;\n");
  });
});

describe("resources are released (M7 leak checks)", () => {
  test("project switches and tab churn keep exactly one watch stream and one build stream, and bound the toast list", async () => {
    const { fake, studio } = makeStudio();
    for (let round = 0; round < 6; round += 1) {
      await studio.projects.open(round % 2 === 0 ? "alpha" : "beta");
      await flush();
      expect(fake.watchers.length).toBe(1);
      expect(fake.buildStreams.length).toBe(1);
      for (const path of ["app.tsx", "src/lib.ts", "src/state.ts"]) { await studio.workspace.open(path); studio.workspace.editorFor(path); }
      expect(studio.workspace.state().docs.length).toBe(3);
      for (let i = 0; i < 3; i += 1) await studio.workspace.close(studio.workspace.state().active!);
      expect(studio.workspace.state().docs.length).toBe(0);
    }
    for (let i = 0; i < 50; i += 1) studio.toasts.info(`t${i}`);
    expect(studio.toasts.items().length).toBeLessThanOrEqual(4);
    // Quick-open is empty and closed after project switches.
    studio.commands.handleKey("Meta+p");
    await studio.projects.open("alpha");
    await flush();
    expect(studio.quickOpen.isOpen()).toBe(false);
  });

  test("the build log ring is bounded", async () => {
    const { fake, studio } = makeStudio();
    await studio.projects.open("alpha");
    await flush();
    for (let i = 0; i < 5000; i += 1) fake.emitBuild({ type: "log", line: `line ${i}` });
    await flush();
    expect(studio.build.logSize()).toBeGreaterThan(1000);
    expect(studio.build.logSize()).toBeLessThanOrEqual(2000);
  });
});
