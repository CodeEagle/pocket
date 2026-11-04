import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { prepareWechatRunner } from "../preview_wechat.ts";

test("browser staging verifies the official engine and preserves the canonical mini-program", () => {
  const temp = mkdtempSync(join(tmpdir(), "pocket-wechat-stage-"));
  try {
    const source = join(temp, "mini"), runner = join(temp, "runner");
    mkdirSync(join(source, "engine"), { recursive: true });
    const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    const compressed = brotliCompressSync(wasm);
    const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    writeFileSync(join(source, "engine/pocketjs.wasm.br"), compressed);
    writeFileSync(join(source, "build-info.json"), JSON.stringify({ target: "wechat-host-qjbc", composition: "single-guest-primary-surface",
      engineSha256: sha(wasm), compressedEngineSha256: sha(compressed) }));
    writeFileSync(join(source, "app.js"), "App({onLaunch(){ console.log('consumer'); }});\n");
    prepareWechatRunner(source, runner);
    expect(readFileSync(join(runner, "engine/pocketjs.browser.wasm"))).toEqual(wasm);
    expect(readFileSync(join(runner, "app.js"), "utf8")).toContain("globalThis.parent.WebAssembly.instantiate");
    expect(readFileSync(join(runner, "app.js"), "utf8")).toContain("wx.__pocketBrowserPreview = true");
    expect(readFileSync(join(runner, "app.js"), "utf8")).toContain("wx.__pocketBrowserDevicePixelRatio = function()");
    expect(readFileSync(join(runner, "app.js"), "utf8")).toContain("globalThis.parent.devicePixelRatio");
    expect(readFileSync(join(runner, "app.js"), "utf8")).toContain("App({onLaunch(){ console.log('consumer'); }});");
    expect(readFileSync(join(source, "app.js"), "utf8")).not.toContain("WXWebAssembly");
    expect(existsSync(join(source, "engine/pocketjs.browser.wasm"))).toBe(false);
    expect(() => prepareWechatRunner(source, runner)).toThrow("must be empty");
    expect(() => prepareWechatRunner(source, source)).toThrow("separate");
    writeFileSync(join(source, "engine/pocketjs.wasm.br"), brotliCompressSync(Buffer.from("changed")));
    expect(() => prepareWechatRunner(source, join(temp, "invalid"))).toThrow("integrity");
    expect(existsSync(join(temp, "invalid"))).toBe(false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
