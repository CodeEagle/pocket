import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { createLive2dProvider } from "../targets/web/live2d_provider.js";

export const cubismWebCorePath = () => resolve(process.env.POCKET_CUBISM_WEB_CORE ||
  join(import.meta.dir, "../packages/pocket_live2d/.cache/cubism-web-core/live2dcubismcore.min.js"));

let corePromise: Promise<any> | undefined;
export function loadPreviewCubismCore(): Promise<any> {
  return corePromise ??= (async () => {
    const path = cubismWebCorePath();
    const info = await stat(path).catch(() => { throw new Error("Live2D Web Core is missing; set POCKET_CUBISM_WEB_CORE to the official live2dcubismcore.min.js"); });
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("Invalid Cubism Web Core script");
    // This executes only the explicitly installed official host dependency.
    // Guest code continues to execute exclusively through pinned QJBC/probe.
    const context = createContext({ console, WebAssembly, ArrayBuffer, Uint8Array,
      Int8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array,
      Float64Array, Math, setTimeout, clearTimeout, performance, atob });
    runInContext(await readFile(path, "utf8"), context, { filename: "cubism-web-core.js", timeout: 5000 });
    const deadline = performance.now() + 20000;
    for (;;) {
      try {
        const core = context.Live2DCubismCore;
        if (core?.Version?.csmGetVersion() > 0) return core;
      } catch { /* The official embedded WASM initializes asynchronously. */ }
      if (performance.now() >= deadline) throw new Error("Cubism Web Core initialization timed out");
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  })().catch(error => { corePromise = undefined; throw error; });
}

export function createPreviewLive2d(bytecodePath: string) {
  const root = dirname(resolve(bytecodePath));
  return createLive2dProvider({
    core: loadPreviewCubismCore,
    readAsset: async (key: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("Live2D request cancelled");
      const catalog = JSON.parse(await readFile(join(root, "novel.native-assets.json"), "utf8"));
      const path = catalog.version === 1 && Object.hasOwn(catalog.assets ?? {}, key) ? catalog.assets[key] : null;
      if (typeof path !== "string" || !/^native-models\/[a-f0-9]{64}\.moc3$/.test(path)) throw new Error("Live2D model is not in the compiled asset allowlist");
      const canonicalRoot = await realpath(root);
      const target = await realpath(join(root, path));
      if (!target.startsWith(canonicalRoot + sep)) throw new Error("Live2D model escapes its package");
      const info = await stat(target);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Live2D model exceeds 32 MiB");
      const bytes = new Uint8Array(await readFile(target, { signal }));
      if (bytes.byteLength > 32 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== path.slice(14, -5)) throw new Error("Live2D model hash mismatch");
      return bytes;
    },
  });
}
