import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildGuest } from "../../scripts/build_guest.ts";
import { hotIdentity } from "../hot_reload.ts";
import { createPreviewManager } from "../preview.ts";

const sdk = resolve(import.meta.dir, "../..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdk, "native/target/debug/pocket_probe");
const playwrightPath = process.env.POCKET_PLAYWRIGHT ?? "/tmp/pocket-playwright-review/node_modules/playwright/index.mjs";

test("compiled guest hot replacement retains counter state, updates input behavior and rejects incompatible resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-hot-native-"));
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "hot-counter", app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}` } }));
  const source = (step: number, label = "Increment counter") => `
import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton } from "@pocket/ui";
import { registerHotState, mountHotRoot } from "@pocket/ui/dev";
function App() {
  const [count, setCount] = createSignal(0);
  onCleanup(registerHotState("count", { read: count, write: value => setCount(Number(value)) }));
  return <Screen><View class="flex-col w-full gap-4 p-4 bg-slate-100">
    <Text class="text-slate-900">Independent counter fixture</Text>
    <Text class="text-slate-900">{"count=" + count()}</Text>
    <ActionButton label=${JSON.stringify(label)} onPress={() => setCount(value => value + ${step})}/>
  </View></Screen>;
}
mountHotRoot(() => mount(() => <App/>));`;
  let current: any;
  const build = async (version: number, step: number, label?: string) => {
    await writeFile(join(project, "app.tsx"), source(step, label));
    const built = await buildGuest({ projectRoot: project, outDir: join(directory, `build-${version}`) });
    current = { ...built, sourcePath: built.source, bytecodePath: built.bytecode, metadataPath: built.metadata,
      pakPath: built.pak, generation: `build-${version}`, revision: version, tickHz: 60, projectDirectory: project };
    return current;
  };
  const manager = createPreviewManager({ probePath: probe, width: 390, height: 360, artifacts: () => current });
  const url = "http://127.0.0.1/api/projects/hot-counter/preview";
  const open = async () => {
    const response = await manager.handle(new Request(`${url}/stream`), "hot-counter", "stream");
    expect(response.status).toBe(200);
    await response.body!.cancel();
  };
  const snapshot = async () => (await manager.handle(new Request(`${url}/snapshot`), "hot-counter", "snapshot")).json() as any;
  const click = async () => {
    for (const phase of ["down", "up"]) {
      const response = await manager.handle(new Request(`${url}/input`, {
        method: "POST", body: JSON.stringify({ type: "pointer", phase, id: 0, x: 195, y: 120 }),
      }), "hot-counter", "input");
      expect(response.status).toBe(200);
    }
  };
  const hasText = (value: any, text: string) => value.frame.ops.some((op: any) => op.type === "text" && op.text === text);
  try {
    const first = await build(1, 1);
    expect(await hotIdentity(first)).toBeDefined();
    await open(); await click();
    expect(hasText(await snapshot(), "count=1")).toBe(true);
    const firstIdentity = await hotIdentity(first);
    const second = await build(2, 2);
    expect((await hotIdentity(second))?.compatibility).toBe(firstIdentity?.compatibility);
    await open();
    let result = await snapshot();
    expect(result.status.hotReload).toEqual({ mode: "replace" });
    expect(hasText(result, "count=1")).toBe(true);
    await click(); result = await snapshot();
    expect(hasText(result, "count=3")).toBe(true);
    // Resource/policy changes must load the completed bytecode in a fresh VM.
    await build(3, 1, "A changed label with Ω");
    await open(); result = await snapshot();
    expect(result.status.hotReload.mode).toBe("reload");
    expect(hasText(result, "count=0")).toBe(true);
    // Diagnostic JS tampering cannot become a hot update.
    await writeFile(current.sourcePath, (await readFile(current.sourcePath, "utf8")) + "\n// tampered");
    expect(await hotIdentity(current)).toBeUndefined();
  } finally {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test("compiled root replacement preserves cleanup tokens for text and same-id video lifecycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-hot-lifecycle-native-"));
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "hot-lifecycle", app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}` } }));
  const source = (version: number) => `
import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { InputField, Video, createMediaController, deliverTextInputEvent } from "@pocket/ui";
import { registerHotState, mountHotRoot } from "@pocket/ui/dev";
const pocketGlobal = globalThis as typeof globalThis & { __pocketEvent?: (line: string) => void };
pocketGlobal.__pocketEvent = (line) => {
  try {
    const packet = JSON.parse(line) as { name?: string; method?: string; payload?: Record<string, unknown>; params?: Record<string, unknown> };
    deliverTextInputEvent(packet.name ?? packet.method ?? "", packet.payload ?? packet.params ?? {});
  } catch { /* malformed host events are ignored by this fixture */ }
};
function App() {
  const [value, setValue] = createSignal("");
  const media = createMediaController({ subscribeLifecycle: false });
  onCleanup(() => media.dispose());
  onCleanup(registerHotState("value", { read: value, write: next => setValue(String(next)) }));
  return <Screen><View class="flex-col w-full gap-2 p-4 bg-slate-100">
    <Text>version-${version}</Text><InputField value={value} onInput={setValue}/>
    {/* Keep the SDK's legal media-registration boundary in this regression.
        HMR must publish every old-generation cleanup edge together with the
        replacement generation's media state. */}
    {Array.from({length: 128}, (_, i) => <Video id={i === 0 ? "hero" : "video-" + i} asset="assets/videos/clip-a.mp4" media={media} active={true} playing={false}/>)}
  </View></Screen>;
}
mountHotRoot(() => mount(() => <App/>));`;
  let current: any;
  const build = async (version: number) => {
    await writeFile(join(project, "app.tsx"), source(version));
    const built = await buildGuest({ projectRoot: project, outDir: join(directory, `build-${version}`) });
    current = { ...built, sourcePath: built.source, bytecodePath: built.bytecode, metadataPath: built.metadata,
      pakPath: built.pak, generation: `build-${version}`, revision: version, tickHz: 60, projectDirectory: project };
  };
  const manager = createPreviewManager({ probePath: probe, width: 390, height: 360, artifacts: () => current });
  const url = "http://127.0.0.1/api/projects/hot-lifecycle/preview";
  const open = async () => {
    const response = await manager.handle(new Request(`${url}/stream`), "hot-lifecycle", "stream");
    expect(response.status).toBe(200);
    await response.body!.cancel();
  };
  const snapshot = async () => (await manager.handle(new Request(`${url}/snapshot`), "hot-lifecycle", "snapshot")).json() as any;
  const send = async (body: Record<string, unknown>) => {
    const response = await manager.handle(new Request(`${url}/input`, {
      method: "POST", body: JSON.stringify(body),
    }), "hot-lifecycle", "input");
    expect(response.status).toBe(200);
  };
  const clickInput = async (value: any) => {
    const placeholder = value.frame.ops.find((op: any) => op.type === "text" && op.text === "Tap to type");
    expect(placeholder).toBeDefined();
    const x = Number(placeholder.x) + Number(placeholder.w) / 2;
    const y = Number(placeholder.y) + Number(placeholder.h) / 2;
    for (const phase of ["down", "up"]) await send({ type: "pointer", phase, id: 0, x, y });
  };
  try {
    await build(1);
    await open();
    const initial = await snapshot();
    expect(initial.frame.events.some((event: any) => event.name === "video.pause" && event.runtimeToken === "system-ui:1")).toBe(true);
    await clickInput(initial);
    const opened = await snapshot();
    const inputOpen = opened.frame.events.find((event: any) => event.name === "textInput.open");
    const firstToken = inputOpen?.runtimeToken;
    expect(firstToken).toBe("system-ui:1");

    await build(2);
    await open();
    const replaced = await snapshot();
    const close = replaced.frame.events.find((event: any) => event.name === "textInput.close");
    const release = replaced.frame.events.find((event: any) => event.name === "video.release");
    const nextVideo = replaced.frame.events.find((event: any) => event.name === "video.pause");
    expect(close?.runtimeToken).toBe(firstToken);
    expect(release?.runtimeToken).toBe(firstToken);
    expect(nextVideo?.runtimeToken).toBe("system-ui:2");
    const expectedVideoIds = Array.from({ length: 128 }, (_, i) => i === 0 ? "hero" : `video-${i}`).sort();
    const oldReleaseIds = replaced.frame.events
      .filter((event: any) => event.name === "video.release" && event.runtimeToken === firstToken)
      .map((event: any) => event.payload?.id)
      .sort();
    const newPauseIds = replaced.frame.events
      .filter((event: any) => event.name === "video.pause" && event.runtimeToken === "system-ui:2")
      .map((event: any) => event.payload?.id)
      .sort();
    expect(oldReleaseIds).toEqual(expectedVideoIds);
    expect(newPauseIds).toEqual(expectedVideoIds);
    const videoOp = replaced.frame.ops.find((op: any) => op.type === "video" && op.id === "hero");
    if (videoOp) expect(videoOp.runtimeToken).toBe("system-ui:2");

    // A replacement must still be able to open a fresh editor and route a
    // native text commit after the old root's close edge was published.
    await clickInput(replaced);
    const reopened = await snapshot();
    const reopen = reopened.frame.events.find((event: any) => event.name === "textInput.open");
    expect(reopen?.runtimeToken).toBe("system-ui:2");
  } finally {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test("compiled guest keeps value-bearing text update before rect-only update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-text-lifecycle-native-"));
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "text-lifecycle", app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}` } }));
  await writeFile(join(project, "app.tsx"), `
import { onMount } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text } from "@pocketjs/framework/solid/components";
const bridge = globalThis as typeof globalThis & { pocket?: { _emitValue?: (value: unknown) => boolean } };
function App() {
  onMount(() => {
    const emit = bridge.pocket?._emitValue;
    if (!emit) return;
    emit({ type: "event", name: "textInput.update", payload: {
      id: "guest-text-input-1", editingSession: "guest-text-input-1:1", revision: 1, jsRevision: 1,
      text: "value-bearing", selectionBase: 13, selectionExtent: 13,
      rect: { x: 10, y: 20, width: 200, height: 32 }, clip: null,
    }});
    emit({ type: "event", name: "textInput.update", payload: {
      id: "guest-text-input-1", editingSession: "guest-text-input-1:1", revision: 1, jsRevision: 1,
      rect: { x: 11, y: 21, width: 200, height: 32 }, clip: null,
    }});
    emit({ type: "event", name: "video.pause", payload: { id: "ordering" }});
    emit({ type: "event", name: "video.play", payload: { id: "ordering" }});
    emit({ type: "event", name: "video.pause", payload: { id: "ordering" }});
  });
  return <Screen><Text>text lifecycle</Text></Screen>;
}
mount(() => <App/>);`);
  const built = await buildGuest({ projectRoot: project, outDir: join(directory, "build") });
  const current = { ...built, sourcePath: built.source, bytecodePath: built.bytecode, metadataPath: built.metadata,
    pakPath: built.pak, generation: "text-lifecycle-1", revision: 1, tickHz: 60, projectDirectory: project };
  const manager = createPreviewManager({ probePath: probe, width: 390, height: 360, artifacts: current });
  const url = "http://127.0.0.1/api/projects/text-lifecycle/preview";
  try {
    const response = await manager.handle(new Request(`${url}/stream`), "text-lifecycle", "stream");
    expect(response.status).toBe(200);
    await response.body!.cancel();
    const snapshotResponse = await manager.handle(new Request(`${url}/snapshot`), "text-lifecycle", "snapshot");
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json() as any;
    const updates = snapshot.frame.events.filter((event: any) => event.name === "textInput.update");
    expect(updates).toHaveLength(2);
    expect(updates[0]?.payload?.text).toBe("value-bearing");
    expect(updates[1]?.payload?.text).toBeUndefined();
    expect(updates[1]?.payload?.rect?.x).toBe(11);
    const ordering = snapshot.frame.events
      .filter((event: any) => event.payload?.id === "ordering")
      .map((event: any) => event.name);
    // Repeated same-state edges are coalesced, but the replacement pause must
    // move behind the intervening play so the browser never ends in play.
    expect(ordering.slice(-2)).toEqual(["video.play", "video.pause"]);
  } finally {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

test("Playwright Chromium replaces the real InputField DOM and accepts later input", { timeout: 240_000 }, async () => {
  expect(existsSync(playwrightPath)).toBe(true);
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const directory = await mkdtemp(join(tmpdir(), "pocket-hot-lifecycle-browser-"));
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "hot-lifecycle-browser", app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  await writeFile(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}` } }));
  const source = (version: number) => `
import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { InputField, Video, createMediaController, deliverTextInputEvent } from "@pocket/ui";
import { registerHotState, mountHotRoot } from "@pocket/ui/dev";
const pocketGlobal = globalThis as typeof globalThis & { __pocketEvent?: (line: string) => void };
pocketGlobal.__pocketEvent = (line) => {
  try {
    const packet = JSON.parse(line) as { name?: string; method?: string; payload?: Record<string, unknown>; params?: Record<string, unknown> };
    deliverTextInputEvent(packet.name ?? packet.method ?? "", packet.payload ?? packet.params ?? {});
  } catch { /* malformed host events are ignored by this fixture */ }
};
function App() {
  const [value, setValue] = createSignal("");
  const media = createMediaController({ subscribeLifecycle: false });
  onCleanup(() => media.dispose());
  onCleanup(registerHotState("value", { read: value, write: next => setValue(String(next)) }));
  return <Screen><View class="flex-col w-full gap-2 p-4 bg-slate-100">
    <Text>browser-version-${version}</Text><InputField value={value} onInput={setValue}/>
    {Array.from({length: 128}, (_, i) => <Video id={i === 0 ? "hero" : "video-" + i} asset="assets/videos/clip-a.mp4" media={media} active={true} playing={false}/>)}
  </View></Screen>;
}
mountHotRoot(() => mount(() => <App/>));`;
  let current: any;
  const build = async (version: number) => {
    await writeFile(join(project, "app.tsx"), source(version));
    const built = await buildGuest({ projectRoot: project, outDir: join(directory, `build-${version}`) });
    current = { ...built, sourcePath: built.source, bytecodePath: built.bytecode, metadataPath: built.metadata,
      pakPath: built.pak, generation: `build-${version}`, revision: version, tickHz: 60, projectDirectory: project };
  };
  const manager = createPreviewManager({ probePath: probe, width: 390, height: 360, artifacts: () => current });
  const prefix = "/api/projects/hot-lifecycle-browser/preview";
  const url = `http://127.0.0.1${prefix}`;
  let browser: any;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const textOp = (frame: any, value: string) => frame.ops.find((op: any) => op.type === "text" && op.text === value);
  const waitFor = async <T,>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 30_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (predicate(value)) return value;
      await Bun.sleep(20);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  try {
    await build(1);
    server = Bun.serve({
      port: 0,
      idleTimeout: 60,
      fetch: (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/") return new Response(`<!doctype html><body style="margin:0"><iframe style="width:390px;height:360px;border:0" src="${prefix}"></iframe>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
        const endpoint = pathname.endsWith("/stream") ? "stream" : pathname.endsWith("/input") ? "input" : pathname.endsWith("/snapshot") ? "snapshot" : pathname.endsWith("/media") ? "media" : "page";
        return manager.handle(request, "hot-lifecycle-browser", endpoint);
      },
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 600, height: 500 } });
    const pageErrors: string[] = [];
    const inputResponses: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("response", (response: any) => {
      if (response.url().includes("/input")) inputResponses.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    let preview: any;
    try {
      preview = await waitFor(
        async () => page.frames().find((frame: any) => frame.url().includes("hot-lifecycle-browser/preview")),
        (frame): frame is any => Boolean(frame),
        "preview iframe",
      );
    } catch (error) {
      const rootResponse = await fetch(`http://127.0.0.1:${server.port}/`);
      const diagnostics = await page.evaluate(() => ({
        url: location.href,
        frames: Array.from(window.frames).map((frame) => frame.location.href),
        iframe: (document.querySelector("iframe") as HTMLIFrameElement | null)?.src,
      }));
      throw new Error(`preview iframe did not initialize: ${String(error)} diagnostics=${JSON.stringify({ ...diagnostics, rootStatus: rootResponse.status, rootBody: (await rootResponse.text()).slice(0, 500) })} pageErrors=${JSON.stringify(pageErrors)}`);
    }
    await preview.waitForFunction(() => Boolean((globalThis as any).PocketEditorPreviewInstance?.getFrame?.()), undefined, { timeout: 30_000 });
    const readFrame = () => preview.evaluate(() => (globalThis as any).PocketEditorPreviewInstance.getFrame());
    const clickInput = async () => {
      const frame = await readFrame();
      const input = textOp(frame, "Tap to type") ?? textOp(frame, "A");
      expect(input).toBeDefined();
      const canvas = preview.locator("canvas");
      const box = await canvas.boundingBox();
      expect(box).toBeDefined();
      await page.mouse.click(box!.x + (Number(input.x) + Number(input.w) / 2) * box!.width / Number(frame.width),
        box!.y + (Number(input.y) + Number(input.h) / 2) * box!.height / Number(frame.height));
    };
    await waitFor(readFrame, (frame) => Boolean(textOp(frame, "Tap to type")), "initial InputField");
    await clickInput();
    await preview.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA", undefined, { timeout: 10_000 });
    await page.keyboard.insertText("A");
    try {
      await waitFor(readFrame, (frame) => Boolean(textOp(frame, "A")), "initial browser input");
    } catch (error) {
      const diagnostics = await preview.evaluate(() => {
        const textarea = document.querySelector("textarea") as HTMLTextAreaElement | null;
        return {
          frame: (globalThis as any).PocketEditorPreviewInstance?.getFrame?.(),
          textarea: textarea ? { value: textarea.value, active: document.activeElement === textarea } : null,
        };
      });
      throw new Error(`initial browser input failed: ${String(error)} diagnostics=${JSON.stringify(diagnostics)} pageErrors=${JSON.stringify(pageErrors)} inputResponses=${JSON.stringify(inputResponses)}`);
    }

    await build(2);
    const trigger = await manager.handle(new Request(`${url}/stream?presentation=browser`), "hot-lifecycle-browser", "stream");
    expect(trigger.status).toBe(200);
    await trigger.body?.cancel();
    await waitFor(readFrame, (frame) => Boolean(textOp(frame, "browser-version-2")), "hot replacement frame");
    await waitFor(
      () => preview.evaluate(() => {
        const textarea = document.querySelector("textarea") as HTMLTextAreaElement | null;
        return !textarea || getComputedStyle(textarea).display === "none";
      }),
      Boolean,
      "old InputField DOM cleanup",
    );
    await clickInput();
    await preview.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA", undefined, { timeout: 10_000 });
    expect(await preview.locator("textarea").inputValue()).toBe("A");
    await page.keyboard.insertText("!");
    await waitFor(readFrame, (frame) => Boolean(textOp(frame, "A!")), "post-replacement browser input");
    expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
