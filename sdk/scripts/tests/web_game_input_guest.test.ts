import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { buildGuest } from "../build_guest.ts";
import { resolvePrebuiltTools } from "../prebuilt_tools.mjs";
import { BrowserGameInput } from "../../targets/web/game_input.js";
import { encodeMessage } from "../../targets/wechat/template/binary-bridge.js";

const sdkRoot = resolve(import.meta.dir, "../..");

test("keyboard and controller facts execute real QJBC and change WebAssembly rendered pixels", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-web-game-input-"));
  let ex: any, host = 0;
  try {
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ id: "pocket.test.gameinput", app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), `import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame, analogRaw } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
function App() {
 const [count, setCount] = createSignal(0);
 const [axis, setAxis] = createSignal(32896);
 onButtonPress(BTN.CROSS, () => setCount(n => n + 1));
 onFrame(() => setAxis(analogRaw()));
 return <View class="w-full h-full bg-black"><Text class="text-white">{count() + ":" + axis()}</Text></View>;
}
mount(() => <App />);`);
    // This fixture feeds the browser software-raster engine directly, so it
    // must carry baked glyphs even though native Flutter builds default to
    // host-measured vector fonts.
    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out"), bakeFonts: true });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8"));
    const configuredEngine = process.env.POCKET_WEB_ENGINE?.trim();
    const wasmPath = configuredEngine
      ? resolve(configuredEngine)
      : process.env.POCKET_SOURCE_BUILD === "1"
        ? join(sdkRoot, ".pocket-build/web-engine/pocketjs.wasm")
        : join(resolvePrebuiltTools(sdkRoot).root, "engine/pocketjs.wasm");
    expect(existsSync(wasmPath), `WebAssembly engine does not exist: ${wasmPath}`).toBe(true);
    const loaded = await WebAssembly.instantiate(readFileSync(wasmPath), {
      env: { __rquickjs_host_now_us: () => Date.now() * 1000 },
      pocket_wechat: { host_emit: () => 1 },
      pocket_web_worker: { operation: () => -6, now_micros: () => Math.floor(performance.now() * 1000) },
    });
    ex = loaded.instance.exports;
    const result = () => new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ex.web_result_ptr(host), ex.web_result_len(host)));
    const check = (status: number) => { if (status !== 0) throw new Error(result() || `Web ABI failed: ${status}`); };
    const bytes = (data: Uint8Array, call: (pointer: number, length: number) => void) => {
      const pointer = ex.web_alloc(data.length);
      expect(pointer).toBeGreaterThan(0);
      try { new Uint8Array(ex.memory.buffer, pointer, data.length).set(data); call(pointer, data.length); }
      finally { ex.web_free(pointer, data.length); }
    };
    host = ex.web_create(160, 80, 1, 0, 0);
    expect(host).toBeGreaterThan(0);
    bytes(new TextEncoder().encode("pocket.test.gameinput"), (p, n) => check(ex.web_set_identity(host, p, n, metadata.bindingGeneration)));
    bytes(readFileSync(built.bytecode), (qp, qn) => bytes(readFileSync(built.pak), (pp, pn) => check(ex.web_boot(host, qp, qn, pp, pn, built.tickHz, 1))));
    const texts = () => {
      const values: string[] = [];
      for (let id = 1; id < 64; id++) {
        check(ex.web_inspect(host, id));
        const node = JSON.parse(result());
        if (typeof node?.text === "string") values.push(node.text);
      }
      return values;
    };
    const canvas = Object.assign(new EventTarget(), { tabIndex: -1 });
    const pads: any[] = [];
    const environment = Object.assign(new EventTarget(), {
      document: { activeElement: canvas }, navigator: { getGamepads: () => pads },
      requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    });
    const input = new BrowserGameInput({ canvas, environment });
    const frame = () => bytes(encodeMessage({ ...input.state(), contacts: [], axisDeltas: [] }), (p, n) => {
      check(ex.web_advance(host, p, n, 1)); check(ex.web_present(host));
    });
    const pixels = () => createHash("sha256").update(new Uint8Array(ex.memory.buffer, ex.web_pixels(host), ex.web_pixels_len(host))).digest("hex");
    try {
      input.setActive(true); frame(); expect(texts()).toContain("0:32896");
      const initial = pixels();
      canvas.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { code: "KeyZ" }));
      frame(); expect(texts()).toContain("1:32896"); expect(pixels()).not.toBe(initial);
      frame(); expect(texts()).toContain("1:32896"); // held key is one edge
      environment.dispatchEvent(Object.assign(new Event("keyup"), { code: "KeyZ" })); frame();
      pads.push({ connected: true, mapping: "standard", axes: [1, -1, 0, 0], buttons: [{ pressed: true }] });
      input.sample(); frame(); expect(texts()).toContain("2:65280");
      input.setActive(false); frame(); expect(texts()).toContain("2:32896");
    } finally { input.dispose(); }
  } finally {
    if (host) ex.web_destroy(host);
    rmSync(project, { recursive: true, force: true });
  }
}, 120_000);
