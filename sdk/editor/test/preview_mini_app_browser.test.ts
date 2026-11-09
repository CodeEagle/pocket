import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager, type PreviewArtifactPaths } from "../preview.ts";

const repositoryRoot = resolve(import.meta.dir, "../..", "..");
const sdkRoot = join(repositoryRoot, "sdk");
const demoRoot = join(repositoryRoot, "demo/js");
const profileRoot = join(demoRoot, "apps/profile");
const lobbyRoot = join(demoRoot, "apps/lobby");
const profileAppId = "pocket.demo.profile";
const lobbyAppId = "pocket.demo.lobby";
const projectId = "mini-browser-fullscreen";
const probeCandidates = process.env.POCKET_NATIVE_PROBE
  ? [resolve(process.env.POCKET_NATIVE_PROBE)]
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ];
const probe = probeCandidates.find(existsSync);
const playwrightPath = process.env.POCKET_PLAYWRIGHT ?? "/tmp/pocket-playwright-review/node_modules/playwright/index.mjs";

type BrowserFrame = {
  frame: number;
  width: number;
  height: number;
  hasProfile: boolean;
  profileY?: number;
  inputBounds?: { x: number; y: number; w: number; h: number };
  closePressed: boolean;
  presentationTokens: number;
  resourceCount: number;
};

async function waitForRecords(
  read: () => Promise<BrowserFrame[]>,
  predicate: (frames: BrowserFrame[]) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<BrowserFrame[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = await read();
    if (predicate(frames)) return frames;
    await Bun.sleep(16);
  }
  const frames = await read();
  throw new Error("timed out waiting for " + label + ": " + JSON.stringify(frames.slice(-12)));
}

function distinct(values: number[]): number[] {
  return [...new Set(values.map((value) => value.toFixed(2)))].map(Number);
}

function assertIncreasing(frames: BrowserFrame[], label: string): void {
  for (let index = 1; index < frames.length; index += 1) {
    assert.ok(frames[index]!.frame > frames[index - 1]!.frame,
      label + " SSE frame ids must increase: " + frames[index - 1]!.frame + " -> " + frames[index]!.frame);
  }
}

async function runMiniAppBrowserAcceptance(): Promise<void> {
  assert.ok(probe, "pocket_probe is required for browser mini-app acceptance: " + probeCandidates.join(", "));
  assert.ok(existsSync(playwrightPath), "Playwright Chromium module is required: " + playwrightPath);

  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const outputRoot = mkdtempSync(join(tmpdir(), "pocket-preview-mini-browser-root-"));
  const outputProfile = mkdtempSync(join(tmpdir(), "pocket-preview-mini-browser-profile-"));
  const outputLobby = mkdtempSync(join(tmpdir(), "pocket-preview-mini-browser-lobby-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let browser: any;
  let server: any;
  try {
    // Build the same real SystemUI and child guest artifacts used by the
    // native acceptance. Temporary output keeps this test away from the
    // checked-in demo/assets cache and from the Flutter host.
    const root = await buildGuest({ projectRoot: demoRoot, outDir: outputRoot, tickHz: 60 });
    const profile = await buildGuest({ projectRoot: profileRoot, outDir: outputProfile, tickHz: 60 });
    const lobby = await buildGuest({ projectRoot: lobbyRoot, outDir: outputLobby, tickHz: 60 });
    const applications: Record<string, PreviewArtifactPaths> = {
      [profileAppId]: {
        bytecodePath: profile.bytecode,
        pakPath: profile.pak,
        appId: profileAppId,
      },
      [lobbyAppId]: {
        bytecodePath: lobby.bytecode,
        pakPath: lobby.pak,
        appId: lobbyAppId,
      },
    };
    manager = createPreviewManager({
      probePath: probe,
      projectDirectory: demoRoot,
      width: 390,
      height: 844,
      // The browser first loads the page document, then executes the iframe
      // client and opens EventSource. Do not evict that not-yet-subscribed
      // session during a cold Playwright startup.
      idleDisposeMs: 30_000,
      artifacts: {
        bytecodePath: root.bytecode,
        pakPath: root.pak,
        revision: 1,
        tickHz: 60,
        applications,
      },
    });

    const prefix = "/api/projects/" + projectId + "/preview";
    server = Bun.serve({
      port: 0,
      idleTimeout: 60,
      fetch: (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/") {
          return new Response(
            "<!doctype html><body style=\"margin:0;background:#111827\"><iframe " +
              "style=\"position:absolute;left:100px;top:100px;width:390px;height:844px;border:0;" +
              "transform:scale(.74);transform-origin:top left\" src=\"" + prefix + "\"></iframe>",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        const endpoint = pathname.endsWith("/stream")
          ? "stream"
          : pathname.endsWith("/input")
            ? "input"
            : pathname.endsWith("/snapshot")
              ? "snapshot"
              : "page";
        return manager!.handle(request, projectId, endpoint);
      },
    });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const pageErrors: string[] = [];
    const previewRequests: string[] = [];
    const previewResponses: string[] = [];
    page.on("request", (request: any) => {
      if (request.url().includes("/api/projects/" + projectId + "/preview")) previewRequests.push(request.method() + " " + request.url());
    });
    page.on("response", (response: any) => {
      if (response.url().includes("/api/projects/" + projectId + "/preview")) {
        previewResponses.push(response.status() + " " + response.url());
      }
    });
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.addInitScript((expectedProjectId: string) => {
      (window as any).__miniBrowserFrames = [];
      window.addEventListener("message", (event) => {
        const packet = event.data;
        if (!packet || packet.source !== "pocket-editor-preview" || packet.type !== "preview.frame") return;
        if (packet.projectId !== expectedProjectId) return;
        const frame = packet.frame;
        if (!frame || typeof frame !== "object") return;
        const ops = Array.isArray(frame.ops) ? frame.ops : [];
        const profile = ops.find((value: any) => value?.type === "text" && value?.text === "Pocket Profile");
        const pressed = ops.some((value: any) =>
          Number(value?.color) === 0xffdce2eb && Number(value?.x) > Number(frame.width) - 90 &&
          Number(value?.y) >= 0 && Number(value?.y) < 100,
        );
        const bounds = frame.inputBounds && typeof frame.inputBounds === "object"
          ? {
              x: Number(frame.inputBounds.x),
              y: Number(frame.inputBounds.y),
              w: Number(frame.inputBounds.w),
              h: Number(frame.inputBounds.h),
            }
          : undefined;
        (window as any).__miniBrowserFrames.push({
          frame: Number(frame.frame),
          width: Number(frame.width),
          height: Number(frame.height),
          hasProfile: Boolean(profile),
          ...(profile && typeof profile.y === "number" ? { profileY: profile.y } : {}),
          ...(bounds ? { inputBounds: bounds } : {}),
          closePressed: pressed,
          presentationTokens: Array.isArray(frame.presentationTokens) ? frame.presentationTokens.length : 0,
          resourceCount: Array.isArray(frame.resources) ? frame.resources.length : 0,
        });
      });
    }, projectId);

    const response = await page.goto("http://127.0.0.1:" + server.port + "/");
    assert.equal(response?.status(), 200, "browser harness must load");
    try {
      await page.waitForFunction(
        () => Boolean((document.querySelector("iframe") as HTMLIFrameElement | null)?.contentWindow &&
          ((document.querySelector("iframe") as HTMLIFrameElement | null)?.contentWindow as any)?.PocketEditorPreviewInstance?.getFrame?.()),
        undefined,
        { timeout: 30_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => {
        const iframe = document.querySelector("iframe") as HTMLIFrameElement | null;
        return {
          iframeSrc: iframe?.src,
          iframeReadyState: iframe?.contentDocument?.readyState,
          iframeTitle: iframe?.contentDocument?.title,
          iframePreview: Boolean((iframe?.contentWindow as any)?.PocketEditorPreviewInstance),
        };
      });
      throw new Error("preview iframe did not initialize: " + JSON.stringify({
        diagnostics,
        pageErrors,
        previewRequests,
        previewResponses,
        error: String(error),
      }));
    }
    const previewFrame = page.frames().find((value: any) => value.url().includes("/api/projects/" + projectId + "/preview"));
    assert.ok(previewFrame, "preview iframe must be attached");
    await previewFrame!.waitForFunction(
      () => Boolean((globalThis as any).PocketEditorPreviewInstance?.getFrame?.()),
      undefined,
      { timeout: 30_000 },
    );
    const canvas = previewFrame!.locator("canvas");
    const canvasBox = await canvas.boundingBox();
    assert.ok(canvasBox, "preview canvas must have a transformed browser box");
    assert.ok(Math.abs(canvasBox!.width - 390 * 0.74) < 1.5,
      "iframe scale must remain isolated: " + canvasBox!.width);
    assert.ok(Math.abs(canvasBox!.height - 844 * 0.74) < 1.5,
      "iframe scale must remain isolated: " + canvasBox!.height);

    const readCurrent = async (): Promise<any> =>
      previewFrame!.evaluate(() => (globalThis as any).PocketEditorPreviewInstance.getFrame());
    const readRecords = async (): Promise<BrowserFrame[]> =>
      page.evaluate(() => (window as any).__miniBrowserFrames as BrowserFrame[]);
    const clickLogical = async (x: number, y: number): Promise<void> => {
      const current = await readCurrent();
      await page.mouse.click(
        canvasBox!.x + x * canvasBox!.width / Number(current.width),
        canvasBox!.y + y * canvasBox!.height / Number(current.height),
      );
    };

    const initial = await readCurrent();
    assert.equal(initial.width, 390);
    assert.equal(initial.height, 844);
    const open = initial.ops.find((value: any) => value?.type === "text" && value?.text === "Open profile app");
    assert.ok(open, "real Showcase guest must expose the profile launch action");
    await page.evaluate(() => { (window as any).__miniBrowserFrames = []; });
    await clickLogical(Number(open.x) + Number(open.w) / 2, Number(open.y) + Number(open.h) / 2);

    const entryRecords = await waitForRecords(
      readRecords,
      (records) => {
        const visible = records.filter((value) => value.hasProfile && value.profileY !== undefined);
        return visible.some((value) => Number(value.profileY) < 80) &&
          distinct(visible.map((value) => Number(value.profileY))).length >= 4;
      },
      "four visible SSE entry positions",
    );
    const entrySample = entryRecords.filter((value) => value.hasProfile && value.profileY !== undefined);
    assert.ok(entrySample.length >= 4, "entry must expose multiple child frames through SSE");
    assertIncreasing(entrySample, "entry");
    assert.ok(Number(entrySample[0]!.profileY) > 0.8 * 844,
      "first visible child frame must begin near the bottom: " + entrySample[0]!.profileY);
    assert.ok(Number(entrySample[0]!.profileY) > Number(entrySample.at(-1)!.profileY) + 4,
      "entry must travel upward: " + entrySample[0]!.profileY + " -> " + entrySample.at(-1)!.profileY);
    assert.ok(distinct(entrySample.map((value) => Number(value.profileY))).length >= 4,
      "entry must expose at least four distinct visible positions");
    assert.ok(entrySample.some((value) => value.presentationTokens > 0),
      "browser SSE must publish a first-frame presentation token");
    const settledRecords = await waitForRecords(
      readRecords,
      (records) => records.some((value) => value.hasProfile && Number(value.profileY) < 20 &&
        value.inputBounds?.x === 0 && value.inputBounds?.y === 0 &&
        value.inputBounds?.w === 390 && value.inputBounds?.h === 844),
      "settled full-viewport child",
    );
    const entry = settledRecords.filter((value) => value.hasProfile && value.profileY !== undefined);
    const followup = entry.slice(1);
    assert.ok(followup.filter((value) => value.resourceCount === 0).length * 2 > followup.length,
      "most post-first entry SSE frames should carry resource deltas, not the full atlas");
    const settled = entry.at(-1)!;
    assert.ok(Number(settled.profileY) < 80, "settled child must reach the viewport top: " + settled.profileY);
    assert.deepEqual(settled.inputBounds, { x: 0, y: 0, w: 390, h: 844 },
      "mini-app child must own the full logical viewport");
    assert.ok(entry.every((value) => value.width === 390 && value.height === 844),
      "all browser FrameResults must retain the logical full viewport");

    // A fresh browser stream receives a replay with the retained full resource
    // cache even though live animation frames only contain deltas.
    const replay = await page.evaluate(async (url: string) => {
      const response = await fetch(url);
      if (!response.body) throw new Error("preview replay stream has no body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (let attempt = 0; attempt < 16; attempt += 1) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((value) => value.startsWith("data: "));
            if (!line) continue;
            const packet = JSON.parse(line.slice(6));
            if (packet.type === "frame") return packet.frame;
          }
        }
      } finally {
        await reader.cancel();
      }
      throw new Error("preview replay stream did not publish a frame");
    }, "http://127.0.0.1:" + server.port + prefix + "/stream?presentation=browser");
    assert.equal(replay.width, 390);
    assert.equal(replay.height, 844);
    assert.ok(Array.isArray(replay.resources) && replay.resources.length > 0,
      "a new browser connection must receive the retained resource cache");
    const screenshot = await canvas.screenshot({ type: "png" });
    assert.ok(screenshot.length > 1_000, "the browser projection must retain a non-empty mini-app screenshot");

    const current = await readCurrent();
    const closeOps = current.ops.filter((value: any) =>
      (value?.type === "rect" || value?.type === "image") &&
      Number(value?.color) === 0xff17233b &&
      Number(value?.x) > Number(current.width) - 90 &&
      Number(value?.y) >= 0 && Number(value?.y) < 100 &&
      Number(value?.w) > 0 && Number(value?.h) > 0,
    );
    assert.ok(closeOps.length > 0, "full-screen child must still expose the floating close overlay");
    // The official control remains a 44px button at right/top 8px in the
    // logical viewport; its hit center is therefore (360,30). DrawOps above
    // only prove that the visual overlay is present; they are not a hit-test
    // substitute because rounded masks are emitted as multiple pieces.
    const close = { x: 360, y: 30 };
    const beforeClose = await readRecords();
    await page.mouse.click(
      canvasBox!.x + close.x * canvasBox!.width / 390,
      canvasBox!.y + close.y * canvasBox!.height / 844,
    );
    const exitRecords = await waitForRecords(
      readRecords,
      (records) => records.slice(beforeClose.length).some((value) => !value.hasProfile),
      "reverse close completion",
    );
    const exit = exitRecords.slice(beforeClose.length).filter((value) => value.hasProfile && value.profileY !== undefined);
    assert.ok(exit.length >= 4, "reverse exit must expose intermediate SSE frames: " + exit.length);
    assertIncreasing(exit, "exit");
    assert.ok(Number(exit.at(-1)!.profileY) > Number(exit[0]!.profileY) + 4,
      "exit must reverse downward: " + exit[0]!.profileY + " -> " + exit.at(-1)!.profileY);
    const final = exitRecords.at(-1)!;
    assert.equal(final.hasProfile, false, "profile child must disappear after reverse close");
    assert.equal(final.inputBounds, undefined, "child input bounds must clear after close");
    assert.deepEqual(pageErrors, [], "browser iframe must not report page errors");
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager?.dispose();
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(outputProfile, { recursive: true, force: true });
    rmSync(outputLobby, { recursive: true, force: true });
  }
}

if (process.env.POCKET_PREVIEW_MINI_BROWSER_CHILD === "1") {
  test("browser mini-app fullscreen entry and overlay close are sampled from SSE", { timeout: 180_000 }, runMiniAppBrowserAcceptance);
} else {
  test("browser mini-app acceptance runs in an isolated Bun process", { timeout: 210_000 }, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, POCKET_PREVIEW_MINI_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const timeout = setTimeout(() => child.kill(), 200_000);
    const exitCode = await child.exited;
    clearTimeout(timeout);
    const output = `${await stdout}\n${await stderr}`;
    assert.equal(exitCode, 0, output);
  });
}
