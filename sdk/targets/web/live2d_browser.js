const { createLive2dProvider } = require("./live2d_provider.js");

const live2dCapabilities = ["media.live2d.model.load", "media.live2d.model.update", "media.live2d.model.release"];
const coreScripts = new Map();

// Core is a host dependency, never guest JavaScript. Loading a local official
// script keeps CSP script-src 'self' and offline deployments usable.
function loadCubismCore(url) {
  const absolute = new URL(url, document.baseURI).href;
  if (coreScripts.has(absolute)) return coreScripts.get(absolute);
  const pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = absolute;
    const timer = setTimeout(() => finish(new Error("Cubism Web Core initialization timed out")), 20000);
    let poll;
    const finish = (error, core) => {
      clearTimeout(timer); clearTimeout(poll);
      script.onload = script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve(core);
    };
    script.onerror = () => finish(new Error(`Could not load Cubism Web Core: ${absolute}`));
    script.onload = () => {
      const ready = () => {
        try {
          const core = globalThis.Live2DCubismCore;
          if (!core?.Moc || !core?.Model || !core?.Version?.csmGetVersion()) throw new Error("Core is not ready");
          finish(null, core);
        } catch (_) { poll = setTimeout(ready, 16); }
      };
      ready();
    };
    document.head.appendChild(script);
  });
  coreScripts.set(absolute, pending);
  pending.catch(() => { if (coreScripts.get(absolute) === pending) coreScripts.delete(absolute); });
  return pending;
}

function safeAsset(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !/[\\\x00-\x1f%?#:]/.test(value) && !value.startsWith("/") &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}

function createBrowserLive2d(config, baseUrl) {
  if (!config) return null;
  if (typeof config.coreUrl !== "string" || !config.coreUrl) throw new Error("Live2D requires a trusted Cubism Web coreUrl");
  if (!config.assets || typeof config.assets !== "object" || Array.isArray(config.assets)) throw new Error("Live2D requires a packaged asset allowlist");
  const assets = new Map();
  const base = new URL(baseUrl, document.baseURI);
  for (const [key, path] of Object.entries(config.assets)) {
    if (!safeAsset(key) || typeof path !== "string" || !path || path.length > 8192) throw new Error("Live2D asset allowlist contains an unsafe path");
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash) throw new Error("Live2D model assets must share their package origin");
    assets.set(key, url.href);
  }
  return createLive2dProvider({
    core: () => loadCubismCore(new URL(config.coreUrl, base).href),
    readAsset: async (key, signal) => {
      const url = assets.get(key);
      if (!url) throw Object.assign(new Error(`Live2D asset is not packaged: ${key}`), { code: "permission_denied" });
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Live2D model HTTP ${response.status}`);
      const limit = 32 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > limit) throw new Error("Live2D model exceeds 32 MiB");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Live2D model response has no body");
      const chunks = []; let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) throw new Error("Live2D model exceeds 32 MiB");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    },
  });
}

module.exports = { createBrowserLive2d, live2dCapabilities, loadCubismCore };
