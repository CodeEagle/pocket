import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { chromium } from "playwright";
import { createPreviewManager } from "../preview.ts";

type CommandEntry = { role: string; command: Record<string, any> };

test("replays browser accessibility facts to current and future guest runtimes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-accessibility-"));
  const probePath = join(root, "probe.mjs");
  const logPath = join(root, "commands.jsonl");
  const project = join(root, "project");
  const rootBytecode = join(root, "root.qjbc");
  const rootPak = join(root, "root.pak");
  const childBytecode = join(root, "child.qjbc");
  const childPak = join(root, "child.pak");
  await mkdir(join(project, "apps/child"), { recursive: true });
  await writeFile(join(project, "pocket.system.json"), JSON.stringify({
    roles: { systemUI: "pocket.test.system" },
    applications: { catalog: [{ package: "pocket.test.child", manifest: "apps/child/manifest.json" }] },
    installation: { installedPackages: ["pocket.test.child"] },
  }));
  await writeFile(join(project, "apps/child/manifest.json"), "{}");
  for (const path of [rootBytecode, rootPak, childBytecode, childPak]) await writeFile(path, "fake-artifact");
  await writeFile(probePath, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = ${JSON.stringify(logPath)};
let role = "unknown";
let frame = 0;
let rootPhase = 0;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const log = (command) => appendFileSync(logPath, JSON.stringify({ role, command }) + "\\n");
const rootFrame = () => ({
  frame: ++frame,
  width: 390,
  height: 360,
  ops: rootPhase >= 3 ? [{ type: "hostSurface", surfaceHandle: 2, id: "pocket.test.child", x: 0, y: 0, w: 390, h: 360, focused: true }] : [],
  events: rootPhase === 1
    ? [{ name: "host.request", payload: { requestId: "create-child", capability: "system.runtime.create", params: { appId: "pocket.test.child" } } }]
    : rootPhase === 2
      ? [{ name: "host.request", payload: { requestId: "await-child", capability: "system.runtime.awaitFirstFrame", params: { instanceId: "pocket-app-1", generation: 1 } } }]
      : [],
  resources: [],
});

const childFrame = () => ({ frame: ++frame, width: 390, height: 360, ops: [{ type: "text", text: "child", x: 8, y: 8, w: 40, h: 15 }], events: [{ name: "accessibility.snapshot", payload: { generation: 1, controls: [{ guestId: "child-action", nativeId: 11, label: "Child action", role: "button", selected: false, disabled: false, enabled: true, rect: { x: 8, y: 8, width: 120, height: 44 } }] } }], resources: [] });
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  log(command);
  if (command.op === "quit") { reply({ ok: true }); setImmediate(() => process.exit(0)); return; }
  if (command.op === "create" || command.op === "resize" || command.op === "schedule") { reply({ ok: true, nextWakeDelayMs: -1 }); return; }
  if (command.op === "loadBytecode") { role = String(command.bytecodePath).includes("child.qjbc") ? "child" : "root"; reply({ ok: true }); return; }
  if (command.op === "send") {
    const message = command.message;
    if (role === "root" && message?.type === "event" && message.name === "accessibility.preferences") rootPhase = Math.max(rootPhase, 1);
    if (role === "root" && message?.type === "event" && message.name === "host.response") {
      if (message.payload?.capability === "system.runtime.create") rootPhase = 2;
      if (message.payload?.capability === "system.runtime.awaitFirstFrame") rootPhase = 3;
    }
    reply({ ok: true });
    return;
  }
  if (command.op === "frame") { reply({ ok: true, frame: role === "child" ? childFrame() : rootFrame() }); return; }
  reply({ ok: true });
});
`, "utf8");
  await chmod(probePath, 0o755);

  const manager = createPreviewManager({
    probePath,
    projectDirectory: project,
    commandTimeoutMs: 5_000,
    width: 390,
    height: 360,
    idleDisposeMs: 1_000,
    artifacts: {
      bytecodePath: rootBytecode,
      pakPath: rootPak,
      revision: 1,
      applications: {
        "pocket.test.child": { bytecodePath: childBytecode, pakPath: childPak, appId: "pocket.test.child" },
      },
      tickHz: 60,
    },
  });
  const projectId = "accessibility-transport";
  const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
  const commands = async (): Promise<CommandEntry[]> => {
    const text = await readFile(logPath, "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as CommandEntry);
  };
  const accessibilityMessages = async (): Promise<CommandEntry[]> => (await commands()).filter((entry) =>
    entry.command.op === "send" && entry.command.message?.name === "accessibility.preferences");
  const waitFor = async (predicate: (entries: CommandEntry[]) => boolean): Promise<CommandEntry[]> => {
    const deadline = Date.now() + 3_000;
    let entries = await accessibilityMessages();
    while (Date.now() < deadline && !predicate(entries)) {
      await Bun.sleep(15);
      entries = await accessibilityMessages();
    }
    assert.ok(predicate(entries), `accessibility messages did not settle: ${JSON.stringify(entries)}`);
    return entries;
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request(`${base}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    const preferences = {
      reduceMotion: true,
      increaseContrast: true,
      textScale: 1.25,
      accessibleNavigation: true,
      reduceTransparency: null,
    };
    const first = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "accessibility", preferences }),
    }), projectId, "input");
    assert.equal(first.status, 200);

    // The first input creates a child after the cache is populated. Its
    // startup replay proves that late runtimes receive the latest fact.
    const afterChild = await waitFor((entries) => entries.some((entry) => entry.role === "child"));
    assert.ok(afterChild.some((entry) => entry.role === "root"));
    assert.deepEqual(afterChild.find((entry) => entry.role === "child")!.command.message.payload, preferences);

    const second = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "accessibility", preferences: { ...preferences, reduceMotion: false } }),
    }), projectId, "input");
    assert.equal(second.status, 200);
    const afterExisting = await waitFor((entries) => {
      const latest = entries.slice(-2);
      return latest.length === 2 && latest.every((entry) => entry.role === "root" || entry.role === "child");
    });
    const latest = afterExisting.slice(-2);
    assert.deepEqual(latest.map((entry) => entry.command.message.payload), [
      { ...preferences, reduceMotion: false },
      { ...preferences, reduceMotion: false },
    ]);

    const childAction = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({
        type: "semantic",
        action: "activate",
        guestId: "child-action",
        nativeId: 11,
        generation: 1,
        runtime: "pocket.test.child",
        runtimeToken: "pocket-app-1:1",
      }),
    }), projectId, "input");
    assert.equal(childAction.status, 200);
    const childActionCommands = (await commands()).filter((entry) =>
      entry.role === "child" && entry.command.op === "send" && entry.command.message?.name === "accessibility.action");
    assert.deepEqual(childActionCommands.at(-1)?.command.message.payload, {
      action: "activate",
      guestId: "child-action",
      nativeId: 11,
      generation: 1,
    });

    const malformed = await manager.handle(new Request(`${base}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "accessibility", preferences: { ...preferences, textScale: 0 } }),
    }), projectId, "input");
    assert.equal(malformed.status, 400);
  } finally {
    await reader?.cancel();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser sends an initial accessibility snapshot and only media-query changes", { timeout: 30_000 }, async () => {
  const clientSource = await readFile(join(import.meta.dir, "../client/preview.js"), "utf8");
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const isScript = new URL(request.url).pathname === "/preview.js";
      return new Response(isScript ? clientSource : "<div data-pocket-preview data-project-id=accessibility-browser></div><script src=/preview.js></script>", {
        headers: { "content-type": isScript ? "application/javascript" : "text/html" },
      });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 360 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      (window as any).__accessibilityInputs = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/input")) {
          (window as any).__accessibilityInputs.push(JSON.parse(String(init?.body ?? "{}")));
          return Promise.resolve(new Response("", { status: 200 }));
        }
        return originalFetch(input, init);
      }) as typeof window.fetch;
      const media = new Map<string, { matches: boolean; listeners: Set<(event: Event) => void> }>();
      (window as any).matchMedia = (query: string) => {
        let value = media.get(query);
        if (!value) {
          value = { matches: query.includes("prefers-reduced-motion"), listeners: new Set() };
          media.set(query, value);
        }
        return {
          get matches() { return value!.matches; },
          addEventListener: (_name: string, listener: (event: Event) => void) => value!.listeners.add(listener),
          removeEventListener: (_name: string, listener: (event: Event) => void) => value!.listeners.delete(listener),
          addListener: (listener: (event: Event) => void) => value!.listeners.add(listener),
          removeListener: (listener: (event: Event) => void) => value!.listeners.delete(listener),
        };
      };
      (window as any).__setMedia = (query: string, matches: boolean) => {
        const value = media.get(query);
        if (!value || value.matches === matches) return;
        value.matches = matches;
        for (const listener of value.listeners) listener(new Event("change"));
      };
      class FakeEventSource {
        static instances: FakeEventSource[] = [];
        onopen?: () => void;
        constructor(public readonly url: string) { FakeEventSource.instances.push(this); }
        close(): void {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance));
    await page.evaluate(() => {
      const source = ((window as any).EventSource as { instances: Array<{ onopen?: () => void }> }).instances[0];
      if (!source) throw new Error("preview must create one SSE source");
      source.onopen?.();
    });
    await page.waitForFunction(() => (window as any).__accessibilityInputs.length === 1);
    const initial = await page.evaluate(() => (window as any).__accessibilityInputs.slice());
    assert.deepEqual(initial[0], {
      type: "accessibility",
      preferences: { reduceMotion: true, increaseContrast: false, textScale: 1, accessibleNavigation: false, reduceTransparency: null },
    });
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => (window as any).__accessibilityInputs.length), 1, "preferences must not be polled");

    await page.evaluate(() => (window as any).__setMedia("(prefers-contrast: more)", true));
    await page.waitForFunction(() => (window as any).__accessibilityInputs.length === 2);
    const changed = await page.evaluate(() => (window as any).__accessibilityInputs.at(-1));
    assert.deepEqual(changed.preferences, { reduceMotion: true, increaseContrast: true, textScale: 1, accessibleNavigation: false, reduceTransparency: null });
    await page.evaluate(() => (window as any).__setMedia("(prefers-contrast: more)", true));
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => (window as any).__accessibilityInputs.length), 2, "unchanged media state must not resend");

    await page.evaluate(async () => { await (window as any).PocketEditorPreviewInstance.close(); });
    await page.evaluate(() => (window as any).__setMedia("(prefers-reduced-motion: reduce)", false));
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => (window as any).__accessibilityInputs.length), 2, "close must remove media listeners");
  } finally {
    await browser.close();
    server.stop(true);
  }
});
