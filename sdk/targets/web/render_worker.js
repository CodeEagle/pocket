/*
 * Off-main-thread PocketJS renderer.
 *
 * The worker owns one PocketWechatHost and its WebAssembly UI realm. The
 * pinned QJBC/runtime, layout, DrawList generation and raster upload stay in
 * that host; the main thread only owns the HTML canvas and browser boundary.
 */
const { PocketWechatHost, registerCapability, setPermissionHandler } = require("../wechat/template/wechat-host.js");
const { createPocketWorkerTransport } = require("./worker_transport.js");
const { observeRenderHost } = require("./render_observations.js");

const workerGlobal = typeof self !== "undefined" ? self : globalThis;
const pendingBoundary = new Map();
let boundarySequence = 1;
let session = null;

function post(message, transfer = []) {
  workerGlobal.postMessage?.(message, transfer);
}
function errorShape(error) {
  return { message: String(error?.message || error || "PocketJS render worker failed"), ...(error?.code ? { code: String(error.code) } : {}) };
}
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function baseUrl() {
  try { return new URL(workerGlobal.location?.href || "http://localhost/"); }
  catch (_) { return new URL("http://localhost/"); }
}
function absoluteUrl(value, base = baseUrl()) {
  if (!value) return null;
  try { return new URL(String(value), base).href; }
  catch (_) { throw fail("invalid_argument", `Invalid render-worker URL: ${value}`); }
}
function boundary(operation, params, signal) {
  if (pendingBoundary.size >= 32) return Promise.reject(fail("request_quota", "Render-worker boundary queue is full"));
  const id = boundarySequence++;
  post({ type: "boundary", id, operation, params });
  return new Promise((resolve, reject) => {
    const pending = { resolve, reject, cleanup: () => {} };
    pendingBoundary.set(id, pending);
    const abort = () => {
      if (!pendingBoundary.delete(id)) return;
      pending.cleanup();
      post({ type: "boundaryCancel", id });
      reject(fail("cancelled", "Render-worker boundary request cancelled"));
    };
    pending.cleanup = () => signal?.removeEventListener?.("abort", abort);
    if (signal?.aborted) abort();
    else signal?.addEventListener?.("abort", abort, { once: true });
  });
}
function browserWx(state) {
  const wx = {
    __pocketBrowserPreview: true,
    __pocketBrowserDevicePixelRatio: () => state.devicePixelRatio,
    WXWebAssembly: { instantiate: async (_path, imports) => {
      const response = await fetch(state.engineUrl, { cache: state.cache || "no-store" });
      if (!response.ok) throw new Error(`PocketJS WASM HTTP ${response.status}`);
      return WebAssembly.instantiate(await response.arrayBuffer(), imports);
    } },
    getWindowInfo: () => ({ windowWidth: state.width, windowHeight: state.height,
      screenWidth: state.width, screenHeight: state.height, pixelRatio: state.devicePixelRatio,
      safeArea: { left: 0, top: 0, right: state.width, bottom: state.height } }),
    getSystemInfoSync: () => wx.getWindowInfo(),
    hideKeyboard: ({ complete } = {}) => { if (typeof complete === "function") complete(); },
    getStorage: ({ key, success, fail: onFail } = {}) => {
      boundary("storage.get", { key: String(key) }).then((value) => {
        if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "data")) {
          onFail?.({ errMsg: "data not found" });
        } else success?.(value);
      }).catch((error) => onFail?.({ errMsg: String(error?.message || error) }));
    },
    setStorage: ({ key, data, success, fail: onFail } = {}) => {
      boundary("storage.set", { key: String(key), data }).then(() => success?.())
        .catch((error) => onFail?.({ errMsg: String(error?.message || error) }));
    },
    removeStorage: ({ key, success, fail: onFail } = {}) => {
      boundary("storage.remove", { key: String(key) }).then(() => success?.())
        .catch((error) => onFail?.({ errMsg: String(error?.message || error) }));
    },
    getStorageInfo: ({ success, fail: onFail } = {}) => {
      boundary("storage.info", {}).then((value) => success?.({ keys: value?.keys || [], currentSize: 0, limitSize: 0 }))
        .catch((error) => onFail?.({ errMsg: String(error?.message || error) }));
    },
  };
  return wx;
}
function installBoundaryHandlers(names) {
  const unregister = [];
  for (const name of names) {
    if (typeof name !== "string" || !name) continue;
    unregister.push(registerCapability(name, (params, context) =>
      boundary("capability.invoke", { capability: name, params }, context?.signal)));
  }
  setPermissionHandler((name, params, context) =>
    boundary("permission", { capability: name, params }, context?.signal).then((value) => Boolean(value)));
  return unregister;
}
function currentState(state) {
  return state.observation.stats();
}
async function disposeSession() {
  const state = session;
  if (state && !state.disposed) {
    state.disposed = true;
    state.active = false;
    try { state.workerTransport?.dispose(); } catch (_) {}
    try { state.host?.dispose(); } catch (_) {}
    for (const unregister of state.unregister || []) { try { unregister(); } catch (_) {} }
    state.unregister = [];
  }
  for (const [id, pending] of pendingBoundary) {
    pendingBoundary.delete(id);
    pending.cleanup?.();
    post({ type: "boundaryCancel", id });
    pending.reject(fail("cancelled", "Render-worker disposed"));
  }
  setPermissionHandler(null);
  session = null;
}

async function init(message) {
  if (session && !session.disposed) throw fail("invalid_state", "PocketJS render worker is already initialized");
  if (!message.canvas || typeof message.canvas.getContext !== "function") throw fail("invalid_argument", "Render worker requires a transferred OffscreenCanvas");
  const fallback = baseUrl();
  const state = {
    canvas: message.canvas, context: message.canvas.getContext("2d", { alpha: true }),
    engineUrl: absoluteUrl(message.engineUrl, fallback), qjbcUrl: absoluteUrl(message.qjbcUrl, fallback),
    pakUrl: absoluteUrl(message.pakUrl, fallback), cache: message.cache,
    width: Math.max(1, Math.floor(Number(message.width) || message.canvas.width || 1)),
    height: Math.max(1, Math.floor(Number(message.height) || message.canvas.height || 1)),
    devicePixelRatio: Math.max(0.25, Math.min(4, Number(message.devicePixelRatio) || 1)),
    active: true, disposed: false, inputSample: {}, workerTransport: null, host: null, observation: null, unregister: [],
  };
  if (!state.context) throw fail("unsupported", "Render worker requires OffscreenCanvas 2D context");
  if (Boolean(state.qjbcUrl) !== Boolean(state.pakUrl)) {
    throw fail("invalid_argument", "Render worker requires both qjbcUrl and pakUrl");
  }
  const config = { ...(message.config || {}), provider: "web", host: "web", hostRuntime: "WebAssembly + OffscreenCanvas", enginePath: state.engineUrl };
  state.unregister = installBoundaryHandlers(Array.isArray(message.capabilityNames) ? message.capabilityNames : []);
  const host = new PocketWechatHost({
    wx: browserWx(state), config, canvas: state.canvas, context: state.context,
    onInput: (value) => post({ type: "input", value }),
    onError: (error) => post({ type: "error", error: errorShape(error) }),
    isActive: () => state.active && !state.disposed,
    sampleInput: () => state.inputSample,
    onWorkerChannel: (channel, data) => state.workerTransport?.receive(channel, data),
  });
  state.host = host;
  state.observation = observeRenderHost(host, "worker");
  session = state;
  try {
    if (state.qjbcUrl && state.pakUrl) {
      const [qjbcResponse, pakResponse] = await Promise.all([
        fetch(state.qjbcUrl, { cache: state.cache || "no-store" }), fetch(state.pakUrl, { cache: state.cache || "no-store" })]);
      if (!qjbcResponse.ok || !pakResponse.ok) throw new Error("PocketJS render-worker Guest artifact fetch failed");
      const hostAbi = Number(config.bindingGeneration ?? config.hostAbi);
      if (!Number.isInteger(hostAbi) || hostAbi < 1) {
        throw fail("invalid_argument", "Render worker external Guest requires bindingGeneration");
      }
      config.externalGuest = { qjbc: new Uint8Array(await qjbcResponse.arrayBuffer()), pak: new Uint8Array(await pakResponse.arrayBuffer()),
        tickHz: Number(config.tickHz || 60), hostAbi };
    }
    await host.start(state.width, state.height, state.devicePixelRatio);
    const workerConfig = config.worker && typeof config.worker === "object" ? config.worker : null;
    const descriptor = workerConfig?.descriptor && typeof workerConfig.descriptor === "object" ? workerConfig.descriptor : workerConfig;
    if (workerConfig && descriptor) {
      const workerQjbc = absoluteUrl(workerConfig.bytecode || "app.worker.qjbc", state.qjbcUrl ? new URL(state.qjbcUrl) : fallback);
      state.workerTransport = createPocketWorkerTransport({ descriptor, engineUrl: state.engineUrl, qjbcUrl: workerQjbc,
        workerHttpOrigins: config.workerHttpOrigins, onError: (error) => post({ type: "error", error: errorShape(error) }) });
      state.workerTransport.subscribe((channel, data) => host.pushWorkerChannel(channel, data));
      await state.workerTransport.ready;
    }
    host.show();
    return { thread: "worker", width: state.width, height: state.height, scale: host.scale, worker: Boolean(state.workerTransport) };
  } catch (error) { await disposeSession(); throw error; }
}

async function command(message) {
  if (!session || session.disposed || !session.host) throw fail("invalid_state", "PocketJS render worker is not mounted");
  const state = session, host = state.host, args = message.args && typeof message.args === "object" ? message.args : {};
  switch (message.method) {
    case "resize": {
      const width = Math.max(1, Math.floor(Number(args.width) || state.width));
      const height = Math.max(1, Math.floor(Number(args.height) || state.height));
      if (args.devicePixelRatio !== undefined) {
        const ratio = Number(args.devicePixelRatio);
        if (Number.isFinite(ratio) && ratio > 0) state.devicePixelRatio = Math.max(0.25, Math.min(4, ratio));
      }
      state.width = width;
      state.height = height;
      host.resize(width, height);
      return currentState(state);
    }
    case "show": state.active = true; host.show(); state.workerTransport?.setActive(true); return currentState(state);
    case "hide": state.active = false; state.workerTransport?.setActive(false); host.hide(); return currentState(state);
    case "inputFrame": state.inputSample = args.inputSample && typeof args.inputSample === "object" ? { ...args.inputSample } : {}; host.inputFrame(Array.isArray(args.contacts) ? args.contacts : []); return currentState(state);
    case "imeEdit": host.imeEdit(args.detail || args); return null;
    case "imeSubmit": host.imeSubmit(args.detail || args); return null;
    case "imeDismiss": host.imeDismiss(args.detail || args); return null;
    case "inspect": return state.observation.inspect();
    case "stats": return currentState(state);
    case "dispose": await disposeSession(); return { disposed: true, thread: "worker" };
    default: throw fail("unsupported", `Unsupported render-worker command: ${message.method}`);
  }
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "boundaryResult") {
    const pending = pendingBoundary.get(Number(message.id));
    if (!pending) return;
    pendingBoundary.delete(Number(message.id));
    pending.cleanup?.();
    if (message.error || message.ok === false) pending.reject(fail(message.error?.code || "host_error", message.error?.message || "Render-worker boundary failed"));
    else pending.resolve(Object.prototype.hasOwnProperty.call(message, "result") ? message.result : message);
    return;
  }
  if (message.type !== "init" && message.type !== "command") return;
  try { post({ type: "reply", id: message.id, result: message.type === "init" ? await init(message) : await command(message) }); }
  catch (error) {
    if (message.id !== undefined) post({ type: "reply", id: message.id, error: errorShape(error) });
    else post({ type: "error", error: errorShape(error) });
  }
}
workerGlobal.onmessage = (event) => { void handle(event.data); };
module.exports = { handle };
