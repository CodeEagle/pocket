import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { resolveNativeProbePath } from "../../scripts/native_probe_path.ts";
import { createPreviewManager, type PreviewArtifactPaths } from "../preview.ts";

const repositoryRoot = resolve(import.meta.dir, "../..", "..");
const sdkRoot = join(repositoryRoot, "sdk");
const demoRoot = join(repositoryRoot, "demo/js");
const profileRoot = join(demoRoot, "apps/profile");
const lobbyRoot = join(demoRoot, "apps/lobby");
const profileAppId = "pocket.demo.profile";
const lobbyAppId = "pocket.demo.lobby";
const projectId = "video-browser-acceptance";
const playwrightPath = process.env.POCKET_PLAYWRIGHT ?? "/tmp/pocket-playwright-review/node_modules/playwright/index.mjs";

type PreviewFrame = {
  frame: number;
  width: number;
  height: number;
  ops: Array<Record<string, unknown>>;
};

type BrowserVideo = {
  currentSrc: string;
  currentTime: number;
  duration: number;
  height: number;
  paused: boolean;
  readyState: number;
  videoHeight: number;
  videoWidth: number;
  width: number;
};

function textOp(frame: PreviewFrame, text: string): Record<string, unknown> {
  const op = frame.ops.find((value) => value.type === "text" && value.text === text);
  assert.ok(op, `preview frame is missing text ${JSON.stringify(text)}`);
  return op;
}

function videoOps(frame: PreviewFrame): Array<Record<string, unknown>> {
  return frame.ops.filter((value) => value.type === "video");
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function runVideoBrowserAcceptance(): Promise<void> {
  assert.ok(existsSync(playwrightPath), `Playwright Chromium module is required: ${playwrightPath}`);
  const probe = resolveNativeProbePath(sdkRoot);
  assert.ok(existsSync(probe), `fresh pocket_probe is required: ${probe}`);

  // Use the same pinned Playwright module as the other browser acceptance
  // tests. chromium.launch() therefore uses Playwright's bundled Chromium;
  // this test never starts the system Chrome binary.
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const outputRoot = mkdtempSync(join(tmpdir(), "pocket-preview-video-browser-root-"));
  const outputProfile = mkdtempSync(join(tmpdir(), "pocket-preview-video-browser-profile-"));
  const outputLobby = mkdtempSync(join(tmpdir(), "pocket-preview-video-browser-lobby-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let browser: any;
  let server: any;

  try {
    // Build the real Showcase bytecode and installed child artifacts. The
    // browser is only a projection: the guest is still executed by the
    // native pocket_probe through createPreviewManager.
    const root = await buildGuest({ projectRoot: demoRoot, outDir: outputRoot, tickHz: 60 });
    const profile = await buildGuest({ projectRoot: profileRoot, outDir: outputProfile, tickHz: 60 });
    const lobby = await buildGuest({ projectRoot: lobbyRoot, outDir: outputLobby, tickHz: 60 });
    const applications: Record<string, PreviewArtifactPaths> = {
      [profileAppId]: {
        bytecodePath: profile.bytecode,
        pakPath: profile.pak,
        appId: profileAppId,
        projectDirectory: profileRoot,
      },
      [lobbyAppId]: {
        bytecodePath: lobby.bytecode,
        pakPath: lobby.pak,
        appId: lobbyAppId,
        projectDirectory: lobbyRoot,
      },
    };
    manager = createPreviewManager({
      probePath: probe,
      projectDirectory: demoRoot,
      width: 390,
      height: 844,
      idleDisposeMs: 30_000,
      artifacts: {
        bytecodePath: root.bytecode,
        pakPath: root.pak,
        appId: "pocket.host.demo",
        revision: 1,
        tickHz: 60,
        applications,
      },
    });

    const prefix = `/api/projects/${projectId}/preview`;
    server = Bun.serve({
      port: 0,
      idleTimeout: 60,
      fetch: (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/") {
          return new Response(
            "<!doctype html><body style=\"margin:0;background:#111827\"><iframe " +
            `style=\"position:absolute;left:100px;top:100px;width:390px;height:844px;border:0;transform:scale(.74);transform-origin:top left\" src=\"${prefix}\"></iframe>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        const endpoint = pathname.endsWith("/stream")
          ? "stream"
          : pathname.endsWith("/input")
            ? "input"
            : pathname.endsWith("/snapshot")
              ? "snapshot"
              : pathname.endsWith("/media")
                ? "media"
                : "page";
        return manager!.handle(request, projectId, endpoint);
      },
    });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const pageErrors: string[] = [];
    const previewRequests: Array<{ method: string; url: string; body?: string; at: number }> = [];
    const mediaResponses: Array<{ status: number; url: string; contentType: string }> = [];
    await page.addInitScript(() => {
      (window as any).__previewVideoTrace = { frameMessages: [] };
      window.addEventListener("message", (event) => {
        const packet = event.data;
        if (packet?.source === "pocket-editor-preview" && packet?.type === "preview.frame") {
          const frame = packet.frame;
          (window as any).__previewVideoTrace.frameMessages.push({
            at: performance.now(),
            revision: packet.revision,
            frame: frame?.frame,
            width: frame?.width,
            height: frame?.height,
            labels: Array.isArray(frame?.ops) ? frame.ops.filter((op: any) => op?.type === "text").map((op: any) => op.text) : [],
          });
        }
      });
    });
    page.on("request", (request: any) => {
      if (request.url().includes(prefix)) previewRequests.push({ method: request.method(), url: request.url(), body: request.postData() ?? undefined, at: Date.now() });
    });
    page.on("response", (response: any) => {
      if (!response.url().includes("/media")) return;
      mediaResponses.push({
        status: response.status(),
        url: response.url(),
        contentType: response.headers()["content-type"] ?? "",
      });
    });
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));

    const response = await page.goto(`http://127.0.0.1:${server.port}/`);
    assert.equal(response?.status(), 200, "browser harness must load");
    try {
      await page.waitForFunction(
        (expectedProjectId: string) => Boolean(
          (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentWindow &&
          ((document.querySelector("iframe") as HTMLIFrameElement | null)?.contentWindow as any)?.PocketEditorPreviewInstance?.getFrame?.(),
        ),
        projectId,
        { timeout: 30_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => {
        const iframe = document.querySelector("iframe") as HTMLIFrameElement | null;
        return {
          iframeSrc: iframe?.src,
          iframeReadyState: iframe?.contentDocument?.readyState,
          iframeTitle: iframe?.contentDocument?.title,
          previewInstance: Boolean((iframe?.contentWindow as any)?.PocketEditorPreviewInstance),
        };
      });
      throw new Error(`preview iframe did not initialize: ${String(error)}; diagnostics=${JSON.stringify(diagnostics)}; pageErrors=${JSON.stringify(pageErrors)}; previewRequests=${JSON.stringify(previewRequests)}; mediaResponses=${JSON.stringify(mediaResponses)}`);
    }

    const previewFrame = page.frames().find((value: any) => value.url().includes(prefix));
    assert.ok(previewFrame, "preview iframe must be attached");
    await previewFrame!.waitForFunction(
      () => Boolean((globalThis as any).PocketEditorPreviewInstance?.getFrame?.()),
      undefined,
      { timeout: 30_000 },
    );
    const canvas = previewFrame!.locator("canvas");
    const canvasBox = await canvas.boundingBox();
    assert.ok(canvasBox, "preview canvas must have a browser box");

    const readCurrent = async (): Promise<PreviewFrame> =>
      previewFrame!.evaluate(() => (globalThis as any).PocketEditorPreviewInstance.getFrame()) as Promise<PreviewFrame>;
    const clickLogical = async (x: number, y: number): Promise<void> => {
      const current = await readCurrent();
      // Route transitions can change the iframe/canvas box after the frame
      // that supplied the DrawOp. Re-read it immediately before every click
      // so the pointer stays aligned with the current logical surface.
      const currentBox = await canvas.boundingBox();
      assert.ok(currentBox, "preview canvas must retain a browser box before click");
      await page.mouse.click(
        currentBox.x + x * currentBox.width / Number(current.width),
        currentBox.y + y * currentBox.height / Number(current.height),
      );
    };
    const clickText = async (label: string): Promise<void> => {
      const current = await readCurrent();
      const op = textOp(current, label);
      await clickLogical(Number(op.x) + Number(op.w) / 2, Number(op.y) + Number(op.h) / 2);
    };
    const readVideos = async (): Promise<BrowserVideo[]> => previewFrame!.evaluate(() =>
      [...document.querySelectorAll("video")].map((node) => {
        const video = node as HTMLVideoElement;
        return {
          currentSrc: video.currentSrc,
          currentTime: video.currentTime,
          duration: video.duration,
          height: video.clientHeight,
          paused: video.paused,
          readyState: video.readyState,
          videoHeight: video.videoHeight,
          videoWidth: video.videoWidth,
          width: video.clientWidth,
        };
      }),
    ) as Promise<BrowserVideo[]>;
    const readTrace = async (): Promise<{ frameMessages: Array<Record<string, unknown>> }> => page.evaluate(
      () => (window as any).__previewVideoTrace as { frameMessages: Array<Record<string, unknown>> },
    );
    const readCanvasVideoHash = async (op: Record<string, unknown>): Promise<string> => previewFrame!.evaluate((target) => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
      const frame = (globalThis as any).PocketEditorPreviewInstance?.getFrame?.();
      const context = canvas?.getContext("2d");
      if (!canvas || !context || !frame) throw new Error("preview canvas is unavailable for video pixel sampling");
      const scaleX = canvas.width / Math.max(1, Number(frame.width));
      const scaleY = canvas.height / Math.max(1, Number(frame.height));
      // Sample a compact interior ROI, away from rounded corners and the
      // control row, so this hash only observes the actual decoded video.
      const x = Math.max(0, Math.floor((Number(target.x) + Number(target.w) * 0.38) * scaleX));
      const y = Math.max(0, Math.floor((Number(target.y) + Number(target.h) * 0.28) * scaleY));
      const width = Math.max(2, Math.min(canvas.width - x, Math.floor(Number(target.w) * 0.2 * scaleX)));
      const height = Math.max(2, Math.min(canvas.height - y, Math.floor(Number(target.h) * 0.2 * scaleY)));
      const data = context.getImageData(x, y, width, height).data;
      let hash = 2166136261;
      for (const value of data) hash = Math.imul(hash ^ value, 16777619) >>> 0;
      return `${hash.toString(16)}:${width}x${height}`;
    }, op) as Promise<string>;

    // Route through the real Showcase home action, then wait for the native
    // FrameResult to expose Video Lab's retained video surface.
    await waitFor(readCurrent, (frame) => frame.ops.some((value) => value.type === "text" && value.text === "Video Lab"), "Showcase Video Lab action");
    await clickText("Video Lab");
    const videoFrame = await waitFor(readCurrent, (frame) =>
      frame.ops.some((value) => value.type === "text" && value.text === "Video Lab") && videoOps(frame).some((value) => value.id === "video-lab-hero"),
      "Video Lab route and hero video surface",
    );
    // The Showcase route animates in from the side. Wait for its final
    // logical geometry for two consecutive samples before tapping a
    // control; otherwise the DrawOp can move between the sampled frame and
    // the real Playwright pointer edge.
    let previousVideoGeometry = "";
    let stableVideoGeometrySamples = 0;
    const settledVideoFrame = await waitFor(readCurrent, (frame) => {
      const hero = videoOps(frame).find((value) => value.id === "video-lab-hero");
      const play = frame.ops.find((value) => value.type === "text" && value.text === "Play");
      if (!hero || !play || Number(hero.x) > 40 || Number(play.x) > 60) {
        previousVideoGeometry = "";
        stableVideoGeometrySamples = 0;
        return false;
      }
      const geometry = [
        frame.width,
        frame.height,
        hero.x,
        hero.y,
        hero.w,
        hero.h,
        play.x,
        play.y,
        play.w,
        play.h,
      ].join(":");
      if (geometry === previousVideoGeometry) stableVideoGeometrySamples += 1;
      else stableVideoGeometrySamples = 1;
      previousVideoGeometry = geometry;
      return stableVideoGeometrySamples >= 2;
    }, "settled Video Lab route");
    assert.equal(videoFrame.width, 390);
    assert.equal(videoFrame.height, 844);

    // A video DrawOp must become a real HTMLVideoElement backed by the local
    // MP4, not a painted placeholder or a static source-string assertion.
    await previewFrame!.waitForFunction(
      () => [...document.querySelectorAll("video")].some((node) => {
        const video = node as HTMLVideoElement;
        return video.currentSrc.includes("clip-a.mp4") && video.readyState >= 2 &&
          video.videoWidth > 0 && video.videoHeight > 0 && Number.isFinite(video.duration) && video.duration > 0;
      }),
      undefined,
      { timeout: 30_000 },
    );
    const initialVideos = await readVideos();
    const initialVideo = initialVideos.find((value) => value.currentSrc.includes("clip-a.mp4"));
    assert.ok(initialVideo, `Video Lab must expose the hero MP4 element: ${JSON.stringify(initialVideos)}`);
    assert.ok(initialVideo.videoWidth >= 320 && initialVideo.videoHeight >= 180, "Chromium must decode the real MP4 dimensions");
    assert.ok(initialVideo.duration > 0, "Chromium must decode a non-empty MP4 duration");
    assert.equal(initialVideo.paused, true, "Video Lab hero starts paused until explicit Play");
    assert.ok(mediaResponses.some((value) =>
      (value.status === 200 || value.status === 206) && value.contentType.includes("video/mp4") && value.url.includes("clip-a.mp4"),
    ), `browser must fetch local MP4 through the preview media endpoint: ${JSON.stringify(mediaResponses)}`);

    // Explicit Play must reach the browser video. Observe real media clock
    // movement and then ensure playback itself does not poll preview/input.
    await clickText("Play");
    try {
      await previewFrame!.waitForFunction(
        () => [...document.querySelectorAll("video")].some((node) => {
          const video = node as HTMLVideoElement;
          return video.currentSrc.includes("clip-a.mp4") && !video.paused && video.currentTime > 0.1;
        }),
        undefined,
        { timeout: 15_000 },
      );
    } catch (error) {
      const diagnostics = { videos: await readVideos(), frame: await readCurrent(), requests: previewRequests.slice(-12) };
      throw new Error(`explicit Play did not advance the browser video: ${String(error)}; diagnostics=${JSON.stringify(diagnostics)}`);
    }
    const playing = (await readVideos()).find((value) => value.currentSrc.includes("clip-a.mp4"));
    assert.ok(playing && !playing.paused, "explicit Play must leave the decoded hero playing");
    const playingTime = playing!.currentTime;
    const heroVideoOp = videoOps(settledVideoFrame).find((value) => value.id === "video-lab-hero");
    assert.ok(heroVideoOp, "settled Video Lab frame must retain the hero video DrawOp");
    // `playing` and `ready` are event-driven host facts and can arrive after
    // currentTime first advances. Let that initial state burst settle before
    // measuring steady playback; continuous SSE polling cannot satisfy this
    // bounded quiet window because each delivered FrameResult resets it.
    let lastObservedFrameCount = -1;
    let stableFrameSince = 0;
    const stablePlayback = await waitFor(async () => {
      const [frame, trace, videos] = await Promise.all([readCurrent(), readTrace(), readVideos()]);
      return { frame, trace, videos };
    }, ({ frame, trace, videos }) => {
      const frameCount = trace.frameMessages.length;
      if (frameCount !== lastObservedFrameCount) {
        lastObservedFrameCount = frameCount;
        stableFrameSince = Date.now();
      }
      const liveVideo = videos.find((value) => value.currentSrc.includes("clip-a.mp4"));
      const currentFrameSaysPlaying = frame.ops.some((value) => value.type === "text" && value.text === "video-lab-hero · playing");
      if (!liveVideo || liveVideo.paused || liveVideo.currentTime <= playingTime + 0.1 || !currentFrameSaysPlaying) {
        stableFrameSince = Date.now();
        return false;
      }
      return stableFrameSince > 0 && Date.now() - stableFrameSince >= 600;
    }, "settled playing media state without new FrameResult events", 8_000);
    const stableVideo = stablePlayback.videos.find((value) => value.currentSrc.includes("clip-a.mp4"));
    assert.ok(stableVideo && !stableVideo.paused,
      "the quiet playback measurement must begin with the real MP4 still playing");
    const canvasHashBefore = await readCanvasVideoHash(heroVideoOp!);
    const requestsBeforePlayback = previewRequests.length;
    const framesBeforePlayback = stablePlayback.trace.frameMessages.length;
    await Bun.sleep(700);
    const progressed = (await readVideos()).find((value) => value.currentSrc.includes("clip-a.mp4"));
    assert.ok(progressed && !progressed.paused && progressed.currentTime > stableVideo!.currentTime + 0.2,
      `the quiet playback window must retain playing state and advance currentTime: ${stableVideo!.currentTime} -> ${progressed?.currentTime} (paused=${progressed?.paused})`);
    const canvasHashAfter = await readCanvasVideoHash(heroVideoOp!);
    assert.notEqual(canvasHashAfter, canvasHashBefore,
      `Canvas video ROI must change with decoded frames, not remain a static first frame (${canvasHashBefore})`);
    const playbackRequests = previewRequests.slice(requestsBeforePlayback).filter((value) => {
      const url = new URL(value.url);
      if (/\/(?:stream|snapshot)(?:\?|$)/.test(url.pathname + url.search)) return true;
      if (value.method !== "POST") return false;
      try {
        const body = JSON.parse(value.body ?? "") as Record<string, any>;
        const message = body.message as Record<string, any> | undefined;
        return !(body.type === "message" && message?.type === "event" && message.name === "video.state");
      } catch {
        return true;
      }
    });
    assert.deepEqual(playbackRequests, [], "video frame progression must not poll preview stream/snapshot or send interactive input; event-driven video.state notifications are allowed");
    const traceDuringPlayback = await readTrace();
    const framesDuringPlayback = traceDuringPlayback.frameMessages.length - framesBeforePlayback;
    if (framesDuringPlayback > 2) console.error("Video frame update diagnosis:", JSON.stringify({
      framesBeforePlayback,
      newFrames: traceDuringPlayback.frameMessages.slice(framesBeforePlayback),
      requestsDuringPlayback: previewRequests.filter((value) => value.at >= Date.now() - 1500),
    }));
    assert.ok(framesDuringPlayback <= 2, `video playback must not create a continuous SSE frame poll (${framesDuringPlayback} extra frames)`);
    const videoStateEvents = previewRequests.flatMap((value) => {
      if (value.method !== "POST") return [];
      try {
        const body = JSON.parse(value.body ?? "") as Record<string, any>;
        const message = body.message as Record<string, any> | undefined;
        const payload = message?.payload as Record<string, any> | undefined;
        if (body.type !== "message" || message?.type !== "event" || message.name !== "video.state" || payload?.id !== "video-lab-hero") return [];
        return [{ state: payload.state, at: value.at }];
      } catch {
        return [];
      }
    });
    console.log("Video playback facts:", JSON.stringify({
      source: progressed!.currentSrc,
      readyState: progressed!.readyState,
      startedAt: playingTime,
      afterStableQuietWindow: stableVideo!.currentTime,
      afterMeasuredWindow: progressed!.currentTime,
      stableQuietWindowMs: 600,
      measuredPlaybackWindowMs: 700,
      additionalFrameResults: framesDuringPlayback,
      streamOrSnapshotRequests: playbackRequests.filter((value) => /\/(?:stream|snapshot)(?:\?|$)/.test(new URL(value.url).pathname + new URL(value.url).search)).length,
      otherInputPosts: playbackRequests.filter((value) => value.method === "POST").length,
      observedStateEvents: videoStateEvents.map((value) => value.state),
    }));

    // Explicit Pause must stop the same media clock, not merely hide the
    // canvas layer. Allow a short decoder scheduling tail, then require a
    // stable currentTime over another real wall-clock interval.
    await clickText("Pause");
    await previewFrame!.waitForFunction(
      () => [...document.querySelectorAll("video")].some((node) => {
        const video = node as HTMLVideoElement;
        return video.currentSrc.includes("clip-a.mp4") && video.paused;
      }),
      undefined,
      { timeout: 10_000 },
    );
    const pausedAt = (await readVideos()).find((value) => value.currentSrc.includes("clip-a.mp4"));
    assert.ok(pausedAt, "paused hero video must remain queryable before route cleanup");
    await Bun.sleep(500);
    const pausedAfter = (await readVideos()).find((value) => value.currentSrc.includes("clip-a.mp4"));
    assert.ok(pausedAfter && Math.abs(pausedAfter.currentTime - pausedAt!.currentTime) < 0.05,
      `explicit Pause must stop currentTime: ${pausedAt!.currentTime} -> ${pausedAfter?.currentTime}`);

    // Back removes the Video Lab route. The HTML video must be paused and
    // detached rather than surviving as a stale decoder over the Home route.
    const beforeBackFrame = await readCurrent();
    const beforeBackInspection = {
      frame: { frame: beforeBackFrame.frame, width: beforeBackFrame.width, height: beforeBackFrame.height },
      frameKeys: Object.keys(beforeBackFrame),
      opTypeCounts: Object.fromEntries([...new Set(beforeBackFrame.ops.map((op) => String(op.type)))].map((type) => [
        type,
        beforeBackFrame.ops.filter((op) => op.type === type).length,
      ])),
      visibleText: beforeBackFrame.ops
        .filter((op) => op.type === "text")
        .map((op) => ({ text: op.text, x: op.x, y: op.y, w: op.w, h: op.h })),
      headerOps: beforeBackFrame.ops
        .filter((op) => Number(op.y) >= 0 && Number(op.y) < 88)
        .map((op) => Object.fromEntries(Object.entries(op).filter(([key]) => [
          "type", "text", "x", "y", "w", "h", "color", "asset", "id", "debugName", "action", "focused", "shape",
        ].includes(key)))),
      semanticOrHitOps: beforeBackFrame.ops
        .filter((op) => /semantic|focus|hit|target|action/i.test(String(op.type)))
        .map((op) => Object.fromEntries(Object.entries(op).filter(([key]) => [
          "type", "text", "x", "y", "w", "h", "id", "debugName", "action", "focused",
        ].includes(key)))),
    };
    const videoLabTitle = textOp(beforeBackFrame, "Video Lab");
    const headerChevron = beforeBackFrame.ops.filter((op) => {
      if (op.type !== "triangle") return false;
      const right = Number(op.x) + Number(op.w);
      const top = Number(op.y);
      const bottom = top + Number(op.h);
      return right <= Number(videoLabTitle.x) && top < Number(videoLabTitle.y) + Number(videoLabTitle.h) && bottom > Number(videoLabTitle.y);
    });
    const backTargetDiagnostics = JSON.stringify({
      inspection: beforeBackInspection,
      videos: await readVideos(),
      canvas: await canvas.boundingBox(),
      previewRequests: previewRequests.slice(-8),
    });
    assert.ok(headerChevron.length >= 2,
      `icon-only app-bar Back control must expose its visible chevron DrawOps beside the Video Lab title; ${backTargetDiagnostics}`);
    const backBounds = {
      left: Math.min(...headerChevron.map((op) => Number(op.x))),
      top: Math.min(...headerChevron.map((op) => Number(op.y))),
      right: Math.max(...headerChevron.map((op) => Number(op.x) + Number(op.w))),
      bottom: Math.max(...headerChevron.map((op) => Number(op.y) + Number(op.h))),
    };
    const backPoint = {
      x: (backBounds.left + backBounds.right) / 2,
      y: (backBounds.top + backBounds.bottom) / 2,
    };
    const requestsBeforeBack = previewRequests.length;
    const framesBeforeBack = (await readTrace()).frameMessages.length;
    await clickLogical(backPoint.x, backPoint.y);
    try {
      await waitFor(readCurrent, (frame) =>
        frame.ops.some((value) => value.type === "text" && value.text === "POCKET SHOWCASE") && videoOps(frame).length === 0,
        "Video Lab route cleanup",
      );
    } catch (error) {
      const currentFrame = await readCurrent();
      throw new Error(`${String(error)}; postBack=${JSON.stringify({
        backPoint,
        backBounds,
        beforeBackInspection,
        currentFrame: {
          frame: currentFrame.frame,
          labels: currentFrame.ops.filter((op) => op.type === "text").map((op) => op.text),
          videoOps: videoOps(currentFrame),
        },
        videos: await readVideos(),
        frameMessages: (await readTrace()).frameMessages.slice(framesBeforeBack).map((message) => ({
          frame: message.frame,
          labels: message.labels,
        })),
        inputRequests: previewRequests.slice(requestsBeforeBack),
      })}`);
    }
    await previewFrame!.waitForFunction(
      () => document.querySelectorAll("video").length === 0,
      undefined,
      { timeout: 10_000 },
    );
    assert.equal((await readVideos()).length, 0, "switching away from Video Lab must clean up HTML video elements");
    const disposedVideoState = previewRequests.slice(requestsBeforeBack).some((value) => {
      if (value.method !== "POST") return false;
      try {
        const body = JSON.parse(value.body ?? "") as Record<string, any>;
        const message = body.message as Record<string, any> | undefined;
        const payload = message?.payload as Record<string, any> | undefined;
        return body.type === "message" && message?.type === "event" && message.name === "video.state" &&
          payload?.id === "video-lab-hero" && payload.state === "disposed";
      } catch {
        return false;
      }
    });
    assert.ok(disposedVideoState, "leaving Video Lab must emit the hero's disposed video.state fact");
    assert.deepEqual(pageErrors, [], "browser preview must not report page errors");
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager?.dispose();
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(outputProfile, { recursive: true, force: true });
    rmSync(outputLobby, { recursive: true, force: true });
  }
}

test("Editor browser preview decodes Video Lab MP4 and cleans playback lifecycle", { timeout: 210_000 }, runVideoBrowserAcceptance);
