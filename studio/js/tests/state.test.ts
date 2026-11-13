import { strict as assert } from "node:assert";
import { describe, expect, test } from "bun:test";
import { createManualTimers } from "../src/state/env.ts";
import { RingBuffer } from "../src/state/ring.ts";
import { openResilient } from "../src/state/resilient.ts";
import { createToasts } from "../src/state/toasts.ts";
import { createDialogs } from "../src/state/dialogs.ts";
import { createWorkspace, diffEdit, isDirty, MAX_CODE_BYTES, MAX_INPUT_BYTES } from "../src/state/workspace.ts";
import { createBuild, LOG_CAPACITY } from "../src/state/build.ts";
import { createPreview, type PreviewRuntime } from "../src/state/preview.ts";
import { createSettings, DEFAULT_SETTINGS, parseSettings, SETTINGS_KEY } from "../src/state/settings.ts";
import { validateNewPath } from "../src/lib/path.ts";
import { excerpt, normalizeDiagnostics } from "../src/lib/diagnostics.ts";
import { buildTree } from "@pocket/ui/tree-model";
import { createFakeClient, flush } from "./fake_client.ts";
import { StudioError } from "../src/studio-client.ts";

describe("ring buffer", () => {
  test("keeps the newest capacity entries, oldest first, and counts evictions", () => {
    const ring = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i += 1) ring.push(i);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.tail(2)).toEqual([4, 5]);
    expect(ring.size).toBe(3);
    expect(ring.evicted).toBe(2);
    ring.clear();
    expect(ring.toArray()).toEqual([]);
    expect(() => new RingBuffer(0)).toThrow();
  });
});

describe("paths and diagnostics", () => {
  test("validateNewPath refuses traversal, protected names, hidden segments and non-editable extensions", () => {
    for (const bad of ["", "/abs.ts", "../x.ts", "a/../b.ts", "a//b.ts", ".env.ts", "a\\b.ts", "assets/x.ts", "node_modules/x.ts", "logo.png", "noext"]) {
      expect(validateNewPath(bad, "file")).toBeString();
    }
    expect(validateNewPath("src/ok.tsx", "file")).toBeUndefined();
    expect(validateNewPath("src/new-dir", "directory")).toBeUndefined();
    expect(validateNewPath("keys", "directory")).toBeString();
  });
  test("normalizeDiagnostics drops malformed entries and duplicates; excerpt clamps", () => {
    const list = normalizeDiagnostics([{ file: "a.ts", line: 3, column: 2, message: "m" }, { file: "a.ts", line: 3, column: 2, message: "m" }, { message: "" }, null, { file: "b.ts", line: -4, message: "x", severity: "warning" }]);
    expect(list).toEqual([{ file: "a.ts", line: 3, column: 2, severity: "error", message: "m" }, { file: "b.ts", line: 1, column: 1, severity: "warning", message: "x" }]);
    expect(excerpt("a\nb\nc\nd", 1)).toEqual([{ number: 1, text: "a" }, { number: 2, text: "b" }]);
  });
  test("buildTree shows empty folders", () => {
    const tree = buildTree([{ path: "a.ts", bytes: 1 }], ["empty/inner"]);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(["directory:empty", "file:a.ts"]);
    expect(tree[0]!.children[0]!.name).toBe("inner");
  });
});

describe("resilient streams", () => {
  test("reconnects with exponential backoff, resyncs on the first event after a drop and stops on close", () => {
    const timers = createManualTimers();
    let opens = 0;
    let handlers: any;
    const events: string[] = [];
    const states: string[] = [];
    const handle = openResilient<string>({
      timers,
      open: (h) => { opens += 1; handlers = h; return { close: () => { events.push("closed"); } }; },
      onEvent: (e) => events.push(e),
      onResync: () => events.push("resync"),
      onState: (s, d) => states.push(d ? `${s}:${d.delayMs}` : s),
    });
    expect(opens).toBe(1);
    handlers.onEvent("a");
    handlers.onEnd();
    expect(states.slice(-1)).toEqual(["retrying:500"]);
    timers.advance(499);
    expect(opens).toBe(1);
    timers.advance(1);
    expect(opens).toBe(2);
    handlers.onError(new StudioError("x", "service_stream_error", "boom")); // dropped again before any event
    expect(states.slice(-1)).toEqual(["retrying:1000"]);
    timers.advance(1000);
    expect(opens).toBe(3);
    handlers.onEvent("b");
    expect(events.filter((e) => e === "resync")).toHaveLength(1);
    expect(events.indexOf("resync")).toBeLessThan(events.indexOf("b"));
    handlers.onEnd();
    expect(states.slice(-1)).toEqual(["retrying:500"]); // backoff reset by the successful connection
    handle.close();
    timers.advance(60_000);
    expect(opens).toBe(3);
    expect(timers.pending()).toBe(0);
  });
  test("a throwing open is retried", () => {
    const timers = createManualTimers();
    let opens = 0;
    openResilient<string>({ timers, open: () => { opens += 1; if (opens === 1) throw new Error("no adapter"); return { close() {} }; }, onEvent() {} });
    timers.advance(500);
    expect(opens).toBe(2);
  });
});

describe("toasts and dialogs", () => {
  test("toasts expire, dedupe, and are bounded", () => {
    const timers = createManualTimers();
    const toasts = createToasts(timers);
    toasts.error("boom");
    toasts.error("boom");
    expect(toasts.items()).toHaveLength(1);
    for (let i = 0; i < 6; i += 1) toasts.info(`n${i}`);
    expect(toasts.items().length).toBeLessThanOrEqual(4);
    timers.advance(10_000);
    expect(toasts.items()).toHaveLength(0);
  });
  test("a prompt keeps the dialog open on invalid input and resolves on valid input", async () => {
    const dialogs = createDialogs();
    const answer = dialogs.prompt({ title: "t", input: { value: "" } }, (v) => (v.endsWith(".ts") ? undefined : "bad"));
    dialogs.setInput("x");
    dialogs.confirmActive();
    expect(dialogs.active()?.error).toBe("bad");
    dialogs.setInput("x.ts");
    dialogs.confirmActive();
    expect(await answer).toBe("x.ts");
    expect(dialogs.active()).toBeUndefined();
  });
  test("opening a new dialog cancels the displaced one; choices resolve by id", async () => {
    const dialogs = createDialogs();
    const first = dialogs.open({ title: "a" });
    const second = dialogs.open({ title: "b", choices: [{ id: "discard", label: "x" }] });
    expect((await first).kind).toBe("cancel");
    dialogs.choose("discard");
    expect(await second).toMatchObject({ kind: "choice", id: "discard" });
  });
});

function workspaceFixture(initial: Record<string, string> = { "a.ts": "A\n", "b.ts": "B\n" }, kind: "input" | "code" = "input") {
  const fake = createFakeClient();
  for (const [k, v] of Object.entries(initial)) fake.files.set(k, v);
  const timers = createManualTimers();
  const toasts = createToasts(timers);
  const dialogs = createDialogs();
  const ws = createWorkspace({ client: fake.client, toasts, dialogs, timers, editorKind: () => kind });
  return { fake, timers, toasts, dialogs, ws };
}

describe("sliced work (guest turn budget)", () => {
  test("diffEdit finds the minimal middle edit, never cuts a surrogate pair, and reconstructs the target", () => {
    const cases: [string, string][] = [
      ["abc", "abc"], ["", "x"], ["x", ""], ["one\ntwo\nthree", "one\nTWO\nthree"], ["aaaa", "aaaaa"], ["aaaa", "aa"],
      ["x\u{1F600}y", "x\u{1F601}y"], ["\u{1F600}", "\u{1F600}\u{1F600}"], ["head" + "z".repeat(5000) + "tail", "head" + "z".repeat(4999) + "Qtail"],
    ];
    for (const [before, after] of cases) {
      const edit = diffEdit(before, after);
      if (before === after) { expect(edit).toBeUndefined(); continue; }
      expect(before.slice(0, edit!.from) + edit!.text + before.slice(edit!.to)).toBe(after);
      const high = (c: number) => c >= 0xd800 && c <= 0xdbff, low = (c: number) => c >= 0xdc00 && c <= 0xdfff;
      expect(edit!.from === 0 || !high(before.charCodeAt(edit!.from - 1))).toBe(true);
      expect(edit!.to >= before.length || !low(before.charCodeAt(edit!.to))).toBe(true);
    }
    expect(diffEdit("one\ntwo\nthree", "one\nTWO\nthree")).toEqual({ from: 4, to: 7, text: "TWO" });
  });
});

describe("workspace", () => {
  test("open, edit, dirty, save writes through writeText; saved listeners fire; save failure keeps it dirty with an error toast", async () => {
    const { fake, ws, toasts } = workspaceFixture();
    await ws.load("p");
    await ws.open("a.ts");
    expect(ws.state().docs[0]).toMatchObject({ path: "a.ts", text: "A\n", status: "ready" });
    const saved: string[] = [];
    ws.onSaved((p) => saved.push(p));
    ws.setText("a.ts", "A2\n");
    expect(isDirty(ws.docOf("a.ts")!)).toBe(true);
    fake.state.failWrites = true;
    expect(await ws.save("a.ts")).toBe(false);
    expect(isDirty(ws.docOf("a.ts")!)).toBe(true);
    expect(toasts.items().some((t) => t.tone === "danger" && t.message.includes("disk full"))).toBe(true);
    fake.state.failWrites = false;
    expect(await ws.save("a.ts")).toBe(true);
    expect(fake.files.get("a.ts")).toBe("A2\n");
    expect(isDirty(ws.docOf("a.ts")!)).toBe(false);
    expect(saved).toEqual(["a.ts"]);
    ws.unload();
  });

  test("files above the cap are blocked without reading; a known size skips the small read", async () => {
    const { fake, ws } = workspaceFixture({ "small.ts": "s" });
    await ws.load("p");
    fake.files.set("big.ts", "b");
    await ws.refreshTree();
    ws.store.update({ files: [...ws.state().files.filter((f) => f.path !== "big.ts"), { path: "big.ts", bytes: MAX_INPUT_BYTES + 1 }] });
    await ws.open("big.ts");
    expect(ws.docOf("big.ts")).toMatchObject({ status: "blocked" });
    expect(ws.docOf("big.ts")!.message).toContain("多行输入框");
    expect(fake.count("readText")).toBe(0);
    await ws.open("small.ts");
    expect(fake.calls.find((c) => c.name === "readText")!.args).toEqual(["p", "small.ts", MAX_INPUT_BYTES, 1]);
    ws.unload();
  });

  test("closing a dirty tab asks: cancel keeps, discard drops, save writes and closes", async () => {
    const { fake, ws, dialogs } = workspaceFixture();
    await ws.load("p");
    await ws.open("a.ts");
    ws.setText("a.ts", "X");
    let closing = ws.close("a.ts");
    expect(dialogs.active()?.title).toContain("保存");
    dialogs.cancel();
    expect(await closing).toBe(false);
    expect(ws.docOf("a.ts")).toBeDefined();
    closing = ws.close("a.ts");
    dialogs.choose("discard");
    expect(await closing).toBe(true);
    expect(ws.docOf("a.ts")).toBeUndefined();
    expect(fake.files.get("a.ts")).toBe("A\n");
    await ws.open("a.ts");
    ws.setText("a.ts", "SAVED");
    closing = ws.close("a.ts");
    dialogs.confirmActive();
    expect(await closing).toBe(true);
    expect(fake.files.get("a.ts")).toBe("SAVED");
    ws.unload();
  });

  test("confirmLeave prompts only when something is dirty", async () => {
    const { ws, dialogs } = workspaceFixture();
    await ws.load("p");
    await ws.open("a.ts");
    expect(await ws.confirmLeave()).toBe(true);
    ws.setText("a.ts", "dirty");
    const leave = ws.confirmLeave();
    expect(dialogs.active()?.choices?.[0]?.id).toBe("discard");
    dialogs.choose("discard");
    expect(await leave).toBe(true);
    ws.unload();
  });

  test("watch: own writes are ignored, a clean tab reloads silently, a dirty tab conflicts and resolves both ways", async () => {
    const { fake, ws, timers } = workspaceFixture();
    await ws.load("p");
    await ws.open("a.ts");
    // Our own save comes back as a change event.
    ws.setText("a.ts", "mine\n");
    await ws.save("a.ts");
    fake.emitWatch({ type: "change", path: "a.ts", kind: "file", event: "change" });
    timers.advance(200); await flush();
    expect(ws.docOf("a.ts")).toMatchObject({ text: "mine\n", conflict: undefined });

    // Clean tab: silent reload.
    fake.external("a.ts", "theirs 1\n");
    timers.advance(200); await flush();
    expect(ws.docOf("a.ts")).toMatchObject({ text: "theirs 1\n", saved: "theirs 1\n" });
    expect(ws.docOf("a.ts")!.conflict).toBeUndefined();

    // Dirty tab: conflict banner, theirs kept aside.
    ws.setText("a.ts", "local edit\n");
    fake.external("a.ts", "theirs 2\n");
    timers.advance(200); await flush();
    expect(ws.docOf("a.ts")).toMatchObject({ text: "local edit\n", conflict: { kind: "changed", theirs: "theirs 2\n" } });
    ws.resolveConflict("a.ts", "theirs");
    expect(ws.docOf("a.ts")).toMatchObject({ text: "theirs 2\n", saved: "theirs 2\n", conflict: undefined });

    ws.setText("a.ts", "keep me\n");
    fake.external("a.ts", "theirs 3\n");
    timers.advance(200); await flush();
    ws.resolveConflict("a.ts", "mine");
    expect(ws.docOf("a.ts")).toMatchObject({ text: "keep me\n", conflict: undefined });
    expect(isDirty(ws.docOf("a.ts")!)).toBe(true);
    expect(await ws.save("a.ts")).toBe(true);
    expect(fake.files.get("a.ts")).toBe("keep me\n");

    // Saving while a conflict is pending asks before overwriting.
    ws.setText("a.ts", "again\n");
    fake.external("a.ts", "theirs 4\n");
    timers.advance(200); await flush();
    const saving = ws.save("a.ts");
    await flush();
    expect(fake.files.get("a.ts")).toBe("theirs 4\n");
    ws.unload();
    void saving;
  });

  test("code editor buffer: dirty follows the buffer version, save writes the buffer text, edits during a write stay dirty", async () => {
    const { fake, ws } = workspaceFixture({ "a.ts": "line1\nline2\n" }, "code");
    await ws.load("p");
    await ws.open("a.ts");
    const editor = ws.editorFor("a.ts");
    expect(ws.editorFor("a.ts")).toBe(editor); // one buffer per document, kept across tab switches
    expect(isDirty(ws.docOf("a.ts")!)).toBe(false);
    editor.handleInput({ kind: "commit", text: "X" });
    expect(isDirty(ws.docOf("a.ts")!)).toBe(true);
    expect(ws.docOf("a.ts")!.text).toBe("line1\nline2\n"); // the doc text is a snapshot, not per-keystroke state
    expect(ws.textOf("a.ts")).toBe("Xline1\nline2\n");
    const saving = ws.save("a.ts");
    editor.handleInput({ kind: "commit", text: "Y" }); // typed while the write is in flight
    expect(await saving).toBe(true);
    expect(fake.files.get("a.ts")).toBe("Xline1\nline2\n");
    expect(isDirty(ws.docOf("a.ts")!)).toBe(true);
    expect(await ws.save("a.ts")).toBe(true);
    expect(fake.files.get("a.ts")).toBe("XYline1\nline2\n");
    expect(isDirty(ws.docOf("a.ts")!)).toBe(false);
    ws.unload();
  });

  test("code editor buffer: CRLF files are written back with CRLF", async () => {
    const { fake, ws } = workspaceFixture({ "w.ts": "a\r\nb\r\n" }, "code");
    await ws.load("p");
    await ws.open("w.ts");
    ws.editorFor("w.ts").handleInput({ kind: "commit", text: "Z" });
    await ws.save("w.ts");
    expect(fake.files.get("w.ts")).toBe("Za\r\nb\r\n");
    ws.unload();
  });

  test("code editor buffer: an external change reloads a clean tab as ONE undoable edit; a dirty tab conflicts", async () => {
    const { fake, ws, timers } = workspaceFixture({ "a.ts": "one\ntwo\nthree\n" }, "code");
    await ws.load("p");
    await ws.open("a.ts");
    const editor = ws.editorFor("a.ts");
    fake.external("a.ts", "one\nTWO\nthree\n");
    timers.advance(200); await flush();
    expect(ws.textOf("a.ts")).toBe("one\nTWO\nthree\n");
    expect(ws.docOf("a.ts")).toMatchObject({ saved: "one\nTWO\nthree\n", bufferDirty: false, reload: 1 });
    expect(isDirty(ws.docOf("a.ts")!)).toBe(false);
    // Undo reverts the reload (history is intact) and the tab then shows as modified against the new disk text.
    expect(editor.undo()).toBe(true);
    expect(ws.textOf("a.ts")).toBe("one\ntwo\nthree\n");
    expect(isDirty(ws.docOf("a.ts")!)).toBe(true);
    expect(editor.redo()).toBe(true);
    // Dirty + external change: banner, buffer untouched; "load disk" replaces it, "keep mine" keeps it dirty.
    editor.handleInput({ kind: "commit", text: "!" });
    fake.external("a.ts", "disk A\n");
    timers.advance(200); await flush();
    expect(ws.docOf("a.ts")!.conflict).toMatchObject({ kind: "changed", theirs: "disk A\n" });
    expect(ws.textOf("a.ts")).toBe("!one\nTWO\nthree\n");
    ws.resolveConflict("a.ts", "theirs");
    expect(ws.textOf("a.ts")).toBe("disk A\n");
    expect(isDirty(ws.docOf("a.ts")!)).toBe(false);
    editor.handleInput({ kind: "commit", text: "mine " });
    fake.external("a.ts", "disk B\n");
    timers.advance(200); await flush();
    ws.resolveConflict("a.ts", "mine");
    expect(isDirty(ws.docOf("a.ts")!)).toBe(true);
    expect(await ws.save("a.ts")).toBe(true);
    expect(fake.files.get("a.ts")).toBe("mine disk A\n");
    expect(isDirty(ws.docOf("a.ts")!)).toBe(false);
    ws.unload();
  });

  test("code editor buffer: rename keeps the buffer; releasing hands the text to the InputField; large files go up to the 4 MiB cap", async () => {
    const { fake, ws } = workspaceFixture({ "a.ts": "A\n" }, "code");
    await ws.load("p");
    await ws.open("a.ts");
    const editor = ws.editorFor("a.ts");
    editor.handleInput({ kind: "commit", text: "q" });
    ws.releaseEditors();
    expect(ws.docOf("a.ts")).toMatchObject({ text: "qA\n", buffered: false });
    expect(isDirty(ws.docOf("a.ts")!)).toBe(true);
    const again = ws.editorFor("a.ts"); // switching back: a new buffer from the text, still dirty
    expect(ws.textOf("a.ts")).toBe("qA\n");
    expect(isDirty(ws.docOf("a.ts")!)).toBe(true);
    again.handleInput({ kind: "commit", text: "r" });
    expect(await ws.save("a.ts")).toBe(true);
    expect(fake.files.get("a.ts")).toBe("rqA\n");

    fake.files.set("big.ts", "b");
    await ws.refreshTree();
    ws.store.update({ files: [...ws.state().files.filter((f) => f.path !== "big.ts"), { path: "big.ts", bytes: MAX_INPUT_BYTES + 1 }, { path: "huge.ts", bytes: MAX_CODE_BYTES + 1 }] });
    await ws.open("big.ts");
    expect(ws.docOf("big.ts")).toMatchObject({ status: "ready" }); // above the InputField cap, below the code cap
    await ws.open("huge.ts");
    expect(ws.docOf("huge.ts")).toMatchObject({ status: "blocked" });
    expect(ws.docOf("huge.ts")!.message).toContain("4 MiB");
    ws.unload();
  });

  test("watch: external delete closes a clean tab and flags a dirty one; external create updates the tree; resync after a drop", async () => {
    const { fake, ws, timers } = workspaceFixture();
    await ws.load("p");
    await ws.open("a.ts");
    await ws.open("b.ts");
    ws.setText("b.ts", "dirty b");
    fake.external("a.ts", undefined);
    fake.external("b.ts", undefined);
    fake.external("new.ts", "n");
    timers.advance(200); await flush();
    expect(ws.docOf("a.ts")).toBeUndefined();
    expect(ws.docOf("b.ts")!.conflict).toEqual({ kind: "deleted" });
    expect(ws.state().files.map((f) => f.path)).toContain("new.ts");

    const trees = fake.count("tree");
    fake.dropWatch();
    expect(ws.state().watch).toBe("retrying");
    fake.files.set("while-down.ts", "w");
    timers.advance(500); await flush();
    timers.advance(200); await flush();
    expect(fake.count("watch")).toBe(2);
    expect(fake.count("tree")).toBeGreaterThan(trees);
    expect(ws.state().files.map((f) => f.path)).toContain("while-down.ts");
    ws.unload();
  });

  test("create / rename / delete / mkdir / rmdir through the dialogs; errors become toasts", async () => {
    const { fake, ws, dialogs, toasts } = workspaceFixture();
    await ws.load("p");
    let op = ws.createFile("src");
    expect(dialogs.active()?.title).toBe("新建文件");
    dialogs.setInput("bad.png"); dialogs.confirmActive();
    expect(dialogs.active()?.error).toContain("仅支持");
    dialogs.setInput("a.ts"); dialogs.confirmActive(); // src/a.ts does not exist: allowed
    await op;
    expect(fake.files.get("src/a.ts")).toBe("");
    expect(ws.state().active).toBe("src/a.ts");

    op = ws.rename("src/a.ts");
    dialogs.setInput("b.ts"); dialogs.confirmActive();
    expect(dialogs.active()?.error).toBe("目标已存在");
    dialogs.setInput("src/c.ts"); dialogs.confirmActive();
    await op;
    expect(fake.files.has("src/c.ts") && !fake.files.has("src/a.ts")).toBe(true);
    expect(ws.state().docs.map((d) => d.path)).toContain("src/c.ts");

    op = ws.remove("src/c.ts");
    dialogs.confirmActive();
    await op;
    expect(fake.files.has("src/c.ts")).toBe(false);
    expect(ws.docOf("src/c.ts")).toBeUndefined();

    op = ws.createFolder("");
    dialogs.setInput("widgets"); dialogs.confirmActive();
    await op;
    expect(fake.calls.find((c) => c.name === "mkdir")!.args).toEqual(["p", "widgets"]);
    expect(ws.state().emptyFolders).toContain("widgets");
    op = ws.remove("widgets"); dialogs.confirmActive(); await op;
    expect(fake.calls.find((c) => c.name === "rmdir")!.args).toEqual(["p", "widgets"]);
    expect(ws.state().emptyFolders).not.toContain("widgets");

    fake.files.delete("b.ts"); // vanished under us: the service says not_found
    op = ws.remove("b.ts"); dialogs.confirmActive(); await op;
    expect(toasts.items().some((t) => t.message.includes("删除失败") && t.message.includes("not_found"))).toBe(true);

    // A non-empty folder is refused without a request.
    op = ws.remove("a.ts"); dialogs.cancel(); await op;
    ws.unload();
  });

  test("jump records the target line; switching project drops results of the old one", async () => {
    const { ws } = workspaceFixture();
    await ws.load("p");
    await ws.open("a.ts", { line: 3, column: 5 });
    expect(ws.docOf("a.ts")!.jump).toMatchObject({ line: 3, column: 5 });
    await ws.open("a.ts", { line: 9, column: 1 });
    expect(ws.docOf("a.ts")!.jump).toMatchObject({ line: 9, column: 1 });
    ws.unload();
    expect(ws.state().docs).toEqual([]);
  });
});

function buildFixture() {
  const fake = createFakeClient();
  const timers = createManualTimers();
  const toasts = createToasts(timers);
  const build = createBuild({ client: fake.client, timers, toasts });
  build.attach("p");
  return { fake, timers, toasts, build };
}

describe("build", () => {
  test("log ring buffer is bounded and gap markers force a status read", async () => {
    const { fake, build } = buildFixture();
    await flush();
    for (let i = 0; i < LOG_CAPACITY + 50; i += 1) fake.emitBuild({ type: "log", line: `line ${i}` });
    expect(build.logSize()).toBe(LOG_CAPACITY);
    expect(build.tail(1)[0]!.text).toBe(`line ${LOG_CAPACITY + 49}`);
    expect(build.state().logs[0]!.text).toBe("line 50");
    const reads = fake.count("build.status");
    fake.emitBuild({ type: "gap", dropped: 12 });
    await flush();
    expect(build.tail(1)[0]).toMatchObject({ gap: 12 });
    expect(fake.count("build.status")).toBe(reads + 1);
  });

  test("run resolves once even when both a busy->idle status and `done` arrive; diagnostics come from the failing build", async () => {
    const { fake, build } = buildFixture();
    await flush();
    const done: boolean[] = [];
    build.onDone((d) => done.push(d.ok));
    const run = build.run();
    await flush();
    expect(build.state().busy).toBe(true);
    fake.finishBuild(false, [{ file: "app.tsx", line: 2, column: 3, severity: "error", message: "bad" }]);
    const result = await run;
    expect(result.ok).toBe(false);
    expect(done).toEqual([false]);
    expect(build.state().diagnostics).toEqual([{ file: "app.tsx", line: 2, column: 3, severity: "error", message: "bad" }]);
    const second = build.run();
    await flush();
    fake.finishBuild(true);
    expect((await second).ok).toBe(true);
    expect(done).toEqual([false, true]);
    expect(build.state().diagnostics).toEqual([]);
  });

  test("a dropped `done` is recovered from the authoritative status after the stream reconnects", async () => {
    const { fake, timers, build } = buildFixture();
    await flush();
    const run = build.run();
    await flush();
    fake.errorBuildStream(); // the stream dies mid-build
    fake.state.busy = false; fake.state.builtRevision = fake.state.revision; // and the build finished meanwhile
    timers.advance(500); await flush();
    const result = await run;
    expect(result.ok).toBe(true);
  });

  test("start is refused while busy; cancel calls the service", async () => {
    const { fake, build } = buildFixture();
    await flush();
    expect(await build.start()).toBe(true);
    expect(await build.start()).toBe(false);
    await build.cancel();
    expect(fake.count("build.cancel")).toBe(1);
  });
});

function previewFixture() {
  const fake = createFakeClient();
  const timers = createManualTimers();
  const toasts = createToasts(timers);
  const build = createBuild({ client: fake.client, timers, toasts });
  build.attach("p");
  const log: string[] = [];
  let seq = 0;
  const runtime: PreviewRuntime & { failCreate?: Error; frame?: Promise<void> } = {
    async ensure() { log.push("ensure"); },
    async create(appId) { log.push(`create:${appId}`); if (runtime.failCreate) throw runtime.failCreate; return { instanceId: `i${++seq}`, generation: 1 }; },
    async destroy(id) { log.push(`destroy:${id}`); },
    async awaitFirstFrame(id) { log.push(`frame:${id}`); await runtime.frame; },
  };
  fake.state.startBuildHook = () => { setTimeout(() => fake.finishBuild(true), 0); };
  const preview = createPreview({ client: fake.client, runtime, build, timers, toasts, project: () => "p" });
  return { fake, timers, toasts, build, preview, runtime, log };
}

describe("preview", () => {
  test("build -> publish -> destroy old -> create new -> first frame, phases are real", async () => {
    const { fake, preview, log } = previewFixture();
    await flush();
    preview.setSurfaceVisible(true);
    const phases: string[] = [];
    preview.store.subscribe(() => { const p = preview.state().phase; if (phases.at(-1) !== p) phases.push(p); });
    expect(await preview.run({ build: true })).toBe(true);
    expect(phases.filter((p) => p !== "idle")).toEqual(["building", "publishing", "loading", "running"]);
    expect(log).toEqual(["ensure", "create:dev.pocket.studio.preview", "frame:i1"]);
    expect(preview.state()).toMatchObject({ phase: "running", instanceId: "i1", reloads: 1, version: "0.1.0-preview.2" });
    fake.state.revision += 1; // another save
    expect(await preview.run({ build: true })).toBe(true);
    expect(log.slice(3)).toEqual(["destroy:i1", "create:dev.pocket.studio.preview", "frame:i2"]);
    expect(preview.state().reloads).toBe(2);
  });

  test("the first frame is awaited only once the surface is visible", async () => {
    const { preview, log } = previewFixture();
    await flush();
    const run = preview.run({ build: true });
    await flush(20); await new Promise((r) => setTimeout(r, 5));
    expect(preview.state().phase).toBe("loading");
    expect(log.some((l) => l.startsWith("frame:"))).toBe(false);
    preview.setSurfaceVisible(true);
    expect(await run).toBe(true);
    expect(log.some((l) => l.startsWith("frame:"))).toBe(true);
  });

  test("failures surface as errors: build failure, publish failure, create failure, runtime unavailable", async () => {
    const { fake, preview, runtime, toasts } = previewFixture();
    await flush();
    preview.setSurfaceVisible(true);
    fake.state.startBuildHook = () => { setTimeout(() => fake.finishBuild(false), 0); };
    expect(await preview.run({ build: true })).toBe(false);
    expect(preview.state()).toMatchObject({ phase: "error", code: "build_failed" });

    fake.state.startBuildHook = () => { setTimeout(() => fake.finishBuild(true), 0); };
    fake.state.publishError = new StudioError("studio.preview.publish", "forbidden", "no credential (HTTP 403)");
    expect(await preview.run({ build: true })).toBe(false);
    expect(preview.state()).toMatchObject({ phase: "error", code: "forbidden" });
    expect(preview.state().message).toContain("no credential");
    fake.state.publishError = undefined;

    fake.state.revision += 1;
    runtime.failCreate = Object.assign(new Error("manifest-signature: bad"), { code: "update_rejected" });
    expect(await preview.run({ build: true })).toBe(false);
    expect(preview.state()).toMatchObject({ phase: "error", code: "update_rejected" });
    expect(toasts.items().some((t) => t.message.includes("预览加载失败"))).toBe(true);

    runtime.ensure = async () => { throw Object.assign(new Error("no system"), { code: "capability_unavailable" }); };
    const fresh = previewFixture();
    fresh.runtime.ensure = async () => { throw new Error("no system"); };
    await flush();
    expect(await fresh.preview.run({ build: true })).toBe(false);
    expect(fresh.preview.state()).toMatchObject({ phase: "error", runtime: "unavailable" });
  });

  test("a source change during the build (409 on publish) rebuilds instead of failing", async () => {
    const { fake, preview } = previewFixture();
    await flush();
    preview.setSurfaceVisible(true);
    let first = true;
    fake.state.startBuildHook = () => { setTimeout(() => { fake.finishBuild(true); if (first) { first = false; fake.state.revision += 1; } }, 0); };
    expect(await preview.run({ build: true })).toBe(true);
    expect(fake.count("build.start")).toBe(2);
    expect(fake.count("publish")).toBe(2);
  });

  test("requests made during a run coalesce into exactly one follow-up run", async () => {
    const { fake, preview } = previewFixture();
    await flush();
    preview.setSurfaceVisible(true);
    const first = preview.run({ build: true });
    expect(await preview.run({ build: true })).toBe(false);
    expect(await preview.run({ build: true })).toBe(false);
    await first;
    await flush(); await new Promise((r) => setTimeout(r, 20));
    expect(fake.count("build.start")).toBe(2);
  });

  test("reset closes the child and returns to idle", async () => {
    const { preview, log } = previewFixture();
    await flush();
    preview.setSurfaceVisible(true);
    await preview.run({ build: true });
    await preview.reset();
    expect(log.at(-1)).toBe("destroy:i1");
    expect(preview.state()).toMatchObject({ phase: "idle", instanceId: undefined });
  });
});

describe("settings", () => {
  test("parse defaults, clamp, persist, and report an unavailable store", async () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.editor).toBe("code");
    expect(parseSettings({ autoBuild: true, debounceMs: 300, dockPreview: true }).editor).toBe("code"); // M2/M3 stored value without `editor`
    expect(parseSettings({ editor: "input" }).editor).toBe("input");
    expect(parseSettings({ editor: "bogus" }).editor).toBe("code");
    expect(parseSettings({ autoBuild: true, debounceMs: 99999, dockPreview: false, editor: "code" })).toEqual({ autoBuild: true, debounceMs: 10000, dockPreview: false, editor: "code", treeWidth: 240, dockWidth: 300 });
    const timers = createManualTimers();
    const toasts = createToasts(timers);
    const store = new Map<string, unknown>([[SETTINGS_KEY, { autoBuild: true, debounceMs: 300 }]]);
    let failing = false;
    const settings = createSettings({ backend: { get: async (k) => store.get(k), set: async (k, v) => { if (failing) throw new Error("denied"); store.set(k, v); } }, toasts });
    await settings.load();
    expect(settings.get()).toMatchObject({ autoBuild: true, debounceMs: 300, loaded: true, persistence: "ok" });
    await settings.set({ autoBuild: false });
    expect((store.get(SETTINGS_KEY) as any).autoBuild).toBe(false);
    failing = true;
    await settings.set({ debounceMs: 2000 });
    expect(settings.get()).toMatchObject({ debounceMs: 2000, persistence: "unavailable" });
    expect(toasts.items().some((t) => t.message.includes("仅在本次会话生效"))).toBe(true);
  });
});
