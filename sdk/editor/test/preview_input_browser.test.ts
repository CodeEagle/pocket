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
const projectId = "input-browser-acceptance";
const playwrightPath = process.env.POCKET_PLAYWRIGHT ?? "/tmp/pocket-playwright-review/node_modules/playwright/index.mjs";

type PreviewFrame = {
  frame: number;
  width: number;
  height: number;
  ops: Array<Record<string, unknown>>;
};

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

function textOp(frame: PreviewFrame, text: string): Record<string, unknown> | undefined {
  return frame.ops.find((value) => value.type === "text" && value.text === text);
}

function draftOf(frame: PreviewFrame): string | undefined {
  const op = frame.ops.find((value) => value.type === "text" && typeof value.text === "string" && value.text.startsWith("Draft: "));
  if (!op) return undefined;
  return String(op.text).slice("Draft: ".length);
}

async function runInputBrowserAcceptance(): Promise<void> {
  assert.ok(existsSync(playwrightPath), `Playwright Chromium module is required: ${playwrightPath}`);
  const probe = resolveNativeProbePath(sdkRoot);
  assert.ok(existsSync(probe), `fresh pocket_probe is required: ${probe}`);

  // This is the pinned Playwright module used by the other browser acceptance
  // tests. chromium.launch() therefore uses Playwright's bundled Chromium and
  // never starts the system Chrome binary.
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const outputRoot = mkdtempSync(join(tmpdir(), "pocket-preview-input-browser-root-"));
  const outputProfile = mkdtempSync(join(tmpdir(), "pocket-preview-input-browser-profile-"));
  const outputLobby = mkdtempSync(join(tmpdir(), "pocket-preview-input-browser-lobby-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let browser: any;
  let server: any;

  try {
    // Build the real Showcase guest and installed child artifacts. The browser
    // is only a projection; native pocket_probe still executes the bytecode.
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
    const previewRequests: Array<{ method: string; url: string; body?: string }> = [];
    page.on("request", (request: any) => {
      if (request.url().includes(prefix)) {
        previewRequests.push({ method: request.method(), url: request.url(), body: request.postData() ?? undefined });
      }
    });
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));

    const response = await page.goto(`http://127.0.0.1:${server.port}/`);
    assert.equal(response?.status(), 200, "browser harness must load");
    try {
      await page.waitForFunction(
        () => Boolean(
          (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentWindow &&
          ((document.querySelector("iframe") as HTMLIFrameElement | null)?.contentWindow as any)?.PocketEditorPreviewInstance?.getFrame?.(),
        ),
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
          previewInstance: Boolean((iframe?.contentWindow as any)?.PocketEditorPreviewInstance),
        };
      });
      throw new Error(`preview iframe did not initialize: ${String(error)}; diagnostics=${JSON.stringify(diagnostics)}; pageErrors=${JSON.stringify(pageErrors)}; previewRequests=${JSON.stringify(previewRequests)}`);
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
      const currentBox = await canvas.boundingBox();
      assert.ok(currentBox, "preview canvas must retain a browser box before click");
      await page.mouse.click(
        currentBox.x + x * currentBox.width / Number(current.width),
        currentBox.y + y * currentBox.height / Number(current.height),
      );
    };
    const readTextareaState = async (): Promise<{ count: number; display: string; active: boolean }> => previewFrame!.evaluate(() => {
      const element = document.querySelector("textarea") as HTMLTextAreaElement | null;
      return {
        count: document.querySelectorAll("textarea").length,
        display: element ? getComputedStyle(element).display : "absent",
        active: element ? document.activeElement === element : false,
      };
    });
    const readTextarea = () => previewFrame!.locator("textarea").first();

    const initial = await waitFor(readCurrent, (frame) =>
      Boolean(textOp(frame, "Tap to type") && draftOf(frame) === "(empty)"), "Showcase home input field");
    const inputOp = textOp(initial, "Tap to type");
    assert.ok(inputOp, "home must expose the real InputField placeholder");
    await clickLogical(Number(inputOp.x) + Number(inputOp.w) / 2, Number(inputOp.y) + Number(inputOp.h) / 2);

    // The first click must open a real browser text control from the guest's
    // textInput.open event. This is intentionally an attached textarea check,
    // not a canvas-only focus assertion.
    await previewFrame!.waitForFunction(
      () => Boolean(document.querySelector("textarea")),
      undefined,
      { timeout: 10_000 },
    );
    const textarea = readTextarea();
    await previewFrame!.waitForFunction(
      () => document.activeElement?.tagName === "TEXTAREA",
      undefined,
      { timeout: 10_000 },
    );
    assert.equal(await textarea.inputValue(), "", "fresh browser input must mirror the empty guest Draft");

    // A real browser keyboard path must update the native guest FrameResult;
    // checking only textarea.value would miss a broken preview/native bridge.
    await page.keyboard.type("hello");
    await waitFor(readCurrent, (frame) => draftOf(frame) === "hello", "guest Draft after keyboard.type");
    assert.equal(await textarea.inputValue(), "hello", "textarea must mirror the committed guest Draft");

    // Keep the guest text-input session open while replacing only the browser
    // projection. A fresh SSE subscriber has no local editor session after
    // reload; the real re-click below makes the guest emit a full-value
    // textInput.update, which must recover the existing value instead of being
    // ignored by the new browser client.
    await previewFrame!.goto(previewFrame!.url(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await previewFrame!.waitForFunction(
      () => Boolean(
        (globalThis as any).PocketEditorPreviewInstance?.getFrame?.() &&
        document.querySelector("textarea"),
      ),
      undefined,
      { timeout: 30_000 },
    );
    const reloaded = await waitFor(
      readCurrent,
      (frame) => draftOf(frame) === "hello" && Boolean(textOp(frame, "hello")),
      "guest Draft and existing input after preview iframe reload",
    );
    const recoveredInputOp = textOp(reloaded, "hello");
    assert.ok(recoveredInputOp, "reloaded preview must paint the existing input value");
    await clickLogical(Number(recoveredInputOp.x) + Number(recoveredInputOp.w) / 2, Number(recoveredInputOp.y) + Number(recoveredInputOp.h) / 2);
    await previewFrame!.waitForFunction(
      () => document.activeElement?.tagName === "TEXTAREA",
      undefined,
      { timeout: 10_000 },
    );
    try {
      await waitFor(
        () => readTextarea().inputValue(),
        (value) => value === "hello",
        "textarea value recovery from full textInput.update",
        10_000,
      );
    } catch (error) {
      const diagnostics = await previewFrame!.evaluate(() => {
        const textarea = document.querySelector("textarea") as HTMLTextAreaElement | null;
        const frame = (globalThis as any).PocketEditorPreviewInstance?.getFrame?.();
        return {
          textarea: textarea ? {
            value: textarea.value,
            display: getComputedStyle(textarea).display,
            active: document.activeElement === textarea,
            selectionStart: textarea.selectionStart,
            selectionEnd: textarea.selectionEnd,
          } : null,
          textEvents: Array.isArray(frame?.events)
            ? frame.events.filter((event: any) => String(event?.name ?? event?.method ?? "").startsWith("textInput."))
            : [],
        };
      });
      throw new Error(`textarea value recovery failed: ${String(error)}; diagnostics=${JSON.stringify(diagnostics)}`);
    }
    await page.keyboard.insertText("R");
    await waitFor(readCurrent, (frame) => draftOf(frame) === "helloR", "guest Draft after input-session reload and re-click");
    await page.keyboard.press("Backspace");
    await waitFor(readCurrent, (frame) => draftOf(frame) === "hello", "guest Draft after Backspace following reload");

    // insertText is the browser's text-edit path (no synthetic keydown for
    // each character), so it exercises the same path used by paste/IME commit.
    await page.keyboard.insertText("!");
    await waitFor(readCurrent, (frame) => draftOf(frame) === "hello!", "guest Draft after keyboard.insertText");

    await page.keyboard.press("Backspace");
    await waitFor(readCurrent, (frame) => draftOf(frame) === "hello", "guest Draft after Backspace");

    // Select through the real textarea API, then replace via the real browser
    // keyboard. The final assertion remains the native guest frame, not DOM.
    await textarea.evaluate((element) => {
      const node = element as HTMLTextAreaElement;
      node.focus();
      node.setSelectionRange(1, 4);
    });
    assert.deepEqual(await textarea.evaluate((element) => {
      const node = element as HTMLTextAreaElement;
      return [node.selectionStart, node.selectionEnd];
    }), [1, 4], "browser textarea selection must be active before replacement");
    await page.keyboard.insertText("i");
    await waitFor(readCurrent, (frame) => draftOf(frame) === "hio", "guest Draft after selection replacement");

    // Chromium's direct insertText path also carries non-ASCII text without
    // pretending that an operating-system IME candidate window was opened.
    await textarea.evaluate((element) => {
      const node = element as HTMLTextAreaElement;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    });
    await page.keyboard.insertText("中文");
    await waitFor(readCurrent, (frame) => draftOf(frame) === "hio中文", "guest Draft after browser Chinese insertText");

    // Exercise the browser's CompositionEvent/InputEvent protocol against the
    // real textarea. This validates composition event translation, while
    // deliberately not claiming that Playwright opened an OS IME candidate
    // window; the preceding insertText assertion covers ordinary Unicode.
    await textarea.evaluate((element) => {
      const node = element as HTMLTextAreaElement;
      node.focus();
      node.setSelectionRange(0, node.value.length);
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      node.setRangeText("你好", 0, node.value.length, "end");
      node.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "你好" }));
      node.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "你好",
        inputType: "insertCompositionText",
        isComposing: true,
      }));
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
      node.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "你好",
        inputType: "insertText",
        isComposing: false,
      }));
    });
    await waitFor(readCurrent, (frame) => draftOf(frame) === "你好", "guest Draft after Chinese IME composition");
    assert.equal(await textarea.inputValue(), "你好", "textarea must retain the committed IME value");

    // Clicking outside the embedded iframe is a real browser focus loss. The
    // preview must release the textarea instead of leaving a stale control
    // (and stale keyboard target) attached to an unfocused guest session.
    await page.mouse.click(700, 700);
    await previewFrame!.waitForFunction(
      () => document.activeElement?.tagName !== "TEXTAREA",
      undefined,
      { timeout: 10_000 },
    );
    const afterBlur = await waitFor(readTextareaState, (state) =>
      state.count === 0 || (!state.active && state.display === "none"),
    "textarea cleanup after browser focus loss", 10_000);
    assert.ok(afterBlur.count === 0 || afterBlur.display === "none",
      `blurred textarea must be detached or hidden: ${JSON.stringify(afterBlur)}`);
    assert.deepEqual(pageErrors, [], `browser preview must not report page errors: ${JSON.stringify(pageErrors)}`);

    // Keep the native frame assertion after cleanup so this does not pass only
    // because the DOM control happened to update before the guest bridge did.
    await waitFor(readCurrent, (frame) => draftOf(frame) === "你好", "guest Draft retained after textarea cleanup");
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager?.dispose();
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(outputProfile, { recursive: true, force: true });
    rmSync(outputLobby, { recursive: true, force: true });
  }
}

test("Editor browser preview routes real textarea keyboard, selection, IME and blur input to guest Draft", { timeout: 210_000 }, runInputBrowserAcceptance);
