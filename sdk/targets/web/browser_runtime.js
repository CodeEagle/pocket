/*
 * PocketJS browser host.
 *
 * The generated WASM is the same pinned QuickJS/PocketJS runtime used by the
 * WeChat target. This adapter only supplies browser boundaries: standard
 * WebAssembly.instantiate, Canvas2D, pointer/IME/lifecycle events and the
 * browser's localStorage implementation. It never evaluates guest source.
 */
const { PocketWechatHost, registerCapability, setPermissionHandler, registeredCapabilityNames,
  invokeRegisteredCapability, requestCapabilityPermission } = require("../wechat/template/wechat-host.js");
const { BrowserGameInput } = require("./game_input.js");
const { createPocketWorkerTransport } = require("./worker_transport.js");
const { PocketRenderWorkerHost } = require("./render_worker_transport.js");
const { observeRenderHost } = require("./render_observations.js");
const { createBrowserLive2d, live2dCapabilities } = require("./live2d_browser.js");

function numberOr(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function browserStorage() {
  const store = globalThis.localStorage;
  if (!store) throw Object.assign(new Error("localStorage is unavailable"), { code: "unsupported" });
  return store;
}

function createBrowserWx(runtime) {
  const wx = {
    __pocketBrowserPreview: true,
    __pocketBrowserDevicePixelRatio: () => numberOr(globalThis.devicePixelRatio, 1),
    WXWebAssembly: {
      instantiate: async (_path, imports) => {
        const response = await fetch(runtime.engineUrl, { cache: runtime.cache ?? "no-store" });
        if (!response.ok) throw new Error(`PocketJS WASM HTTP ${response.status}`);
        return WebAssembly.instantiate(await response.arrayBuffer(), imports);
      },
    },
    getWindowInfo: () => {
      const rect = runtime.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width || runtime.canvas.clientWidth || 1));
      const height = Math.max(1, Math.floor(rect.height || runtime.canvas.clientHeight || 1));
      return { windowWidth: width, windowHeight: height, screenWidth: width, screenHeight: height,
        pixelRatio: numberOr(globalThis.devicePixelRatio, 1), safeArea: { left: 0, top: 0, right: width, bottom: height } };
    },
    getSystemInfoSync: () => wx.getWindowInfo(),
    hideKeyboard: ({ complete } = {}) => { if (typeof complete === "function") complete(); },
    getStorage: ({ key, success, fail } = {}) => {
      try {
        const value = browserStorage().getItem(String(key));
        if (value === null) fail?.({ errMsg: "data not found" });
        else success?.({ data: value });
      } catch (error) { fail?.({ errMsg: String(error?.message || error) }); }
    },
    setStorage: ({ key, data, success, fail } = {}) => {
      try { browserStorage().setItem(String(key), String(data)); success?.(); }
      catch (error) { fail?.({ errMsg: String(error?.message || error) }); }
    },
    removeStorage: ({ key, success, fail } = {}) => {
      try { browserStorage().removeItem(String(key)); success?.(); }
      catch (error) { fail?.({ errMsg: String(error?.message || error) }); }
    },
    getStorageInfo: ({ success, fail } = {}) => {
      try {
        const store = browserStorage();
        const keys = [];
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          if (key !== null) keys.push(key);
        }
        success?.({ keys, currentSize: 0, limitSize: 0 });
      } catch (error) { fail?.({ errMsg: String(error?.message || error) }); }
    },
  };
  return wx;
}

class PocketWebRuntime {
  constructor(options = {}) {
    if (!options.canvas || typeof options.canvas.getContext !== "function") {
      throw new TypeError("PocketWebRuntime requires an HTMLCanvasElement or compatible Canvas2D surface");
    }
    if (!options.engineUrl) throw new TypeError("PocketWebRuntime requires engineUrl");
    this.canvas = options.canvas;
    this.engineUrl = String(options.engineUrl);
    const configured = options.config && typeof options.config === "object" ? options.config : {};
    this.qjbcUrl = options.qjbcUrl ? String(options.qjbcUrl) : (configured.qjbcUrl ? String(configured.qjbcUrl) : null);
    this.pakUrl = options.pakUrl ? String(options.pakUrl) : (configured.pakUrl ? String(configured.pakUrl) : null);
    this.cache = options.cache;
    this.config = { ...(options.config || {}), provider: "web", host: "web",
      hostRuntime: "WebAssembly + Canvas2D", enginePath: "engine/pocketjs.wasm" };
    this.inputElement = options.inputElement || null;
    this.ownsInputElement = false;
    this.disposed = false;
    this.active = false;
    this.mounted = false;
    this.mountPromise = null;
    this.pointers = new Map();
    this.renderWorker = options.renderWorker ?? this.config.renderWorker ?? false;
    if (typeof this.renderWorker !== "boolean") throw new TypeError("renderWorker must be a boolean host option");
    this.context = this.renderWorker ? null : this.canvas.getContext("2d", { alpha: true });
    if (!this.renderWorker && !this.context) throw new Error("PocketJS requires a Canvas2D context");
    this.onError = options.onError;
    this.workerTransport = null;
    this.workerTransportUnsubscribe = null;
    this.gameInput = (options.gameInput === true || this.config.gameInput === true)
      ? new BrowserGameInput({ canvas: this.canvas, onChange: () => {
        if (this.active && !this.disposed) this.host?.inputFrame([...this.pointers.values()]);
      } }) : null;
    this.wx = createBrowserWx(this);
    this.live2d = createBrowserLive2d(this.config.live2d,
      this.qjbcUrl ? new URL(this.qjbcUrl, document.baseURI).href : document.baseURI);
    this.capabilityHandlers = Object.create(null);
    if (this.live2d) for (const name of live2dCapabilities) {
      this.capabilityHandlers[name] = (params, context) => this.live2d.invoke(name, params, context);
    }
    const hostOptions = {
      wx: this.wx, config: this.config, canvas: this.canvas, context: this.context,
      onInput: (value) => this.updateInput(value), onError: (error) => this.onError?.(error),
      isActive: () => this.active && !this.disposed,
      sampleInput: () => this.gameInput?.state(),
      onWorkerChannel: (channel, data) => this.workerTransport?.receive(channel, data),
      capabilityHandlers: this.capabilityHandlers,
    };
    if (this.renderWorker) {
      const base = document.baseURI;
      const absolute = (value) => value ? new URL(value, base).href : null;
      try {
        this.host = new PocketRenderWorkerHost({ ...hostOptions,
          workerUrl: absolute(options.renderWorkerUrl) || new URL("./pocket-render-worker.js", import.meta.url).href,
          engineUrl: absolute(this.engineUrl), qjbcUrl: absolute(this.qjbcUrl), pakUrl: absolute(this.pakUrl),
          cache: this.cache,
          capabilityNames: [...new Set([...Object.keys(this.capabilityHandlers), ...registeredCapabilityNames(), ...(this.config.requires || []), ...(this.config.optional || [])])],
          boundary: (operation, params, signal) => this.browserBoundary(operation, params, signal),
        });
      } catch (error) { this.gameInput?.dispose(); throw error; }
    } else {
      this.host = new PocketWechatHost(hostOptions);
      this.observations = observeRenderHost(this.host, "main");
    }
    this.handleResize = () => { if (!this.disposed) this.host.resize(this.width(), this.height()); };
    this.handleVisibility = () => { if (document.visibilityState === "hidden") this.hide(); else this.show(); };
    this.handlePointer = (event) => this.pointer(event);
    this.handleKey = (event) => {
      if (event.key === "Enter") this.host.imeSubmit({ value: this.inputElement?.value || "" });
      if (event.key === "Escape") this.host.imeDismiss({ value: this.inputElement?.value || "" });
    };
  }

  width() { return Math.max(1, Math.floor(this.canvas.clientWidth || this.canvas.width || 1)); }
  height() { return Math.max(1, Math.floor(this.canvas.clientHeight || this.canvas.height || 1)); }

  async browserBoundary(operation, params, signal) {
    if (this.disposed || signal.aborted) throw Object.assign(new Error("Browser host is disposed"), { code: "cancelled" });
    if (Object.hasOwn(this.capabilityHandlers, params.capability)) {
      if (operation === "permission") return true;
      if (operation === "capability.invoke") return this.capabilityHandlers[params.capability](params.params || {}, { signal });
    }
    if (operation === "permission") return requestCapabilityPermission(params.capability, params.params || {}, { signal, wx: this.wx });
    if (operation === "capability.invoke") return invokeRegisteredCapability(params.capability, params.params || {}, { signal, wx: this.wx });
    const store = browserStorage();
    if (operation === "storage.get") {
      const data = store.getItem(String(params.key));
      if (data === null) throw Object.assign(new Error("data not found"), { code: "not_found" });
      return { data };
    }
    if (operation === "storage.set") { store.setItem(String(params.key), String(params.data)); return {}; }
    if (operation === "storage.remove") { store.removeItem(String(params.key)); return {}; }
    if (operation === "storage.info") {
      const keys = [];
      for (let index = 0; index < store.length; index++) { const key = store.key(index); if (key !== null) keys.push(key); }
      return { keys, currentSize: 0, limitSize: 0 };
    }
    throw Object.assign(new Error(`Unsupported browser boundary: ${operation}`), { code: "unsupported" });
  }

  async inspect() { return this.renderWorker ? this.host.inspect() : this.observations.inspect(); }
  async stats() { return this.renderWorker ? this.host.stats() : this.observations.stats(); }

  ensureInputElement() {
    if (this.inputElement) return this.inputElement;
    const parent = this.canvas.parentElement || document.body;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const input = document.createElement("input");
    input.autocomplete = "off"; input.spellcheck = false;
    input.style.position = "absolute"; input.style.display = "none"; input.style.zIndex = "10";
    input.addEventListener("input", () => this.host.imeEdit({ value: input.value, cursor: input.selectionStart ?? input.value.length }));
    input.addEventListener("blur", () => this.host.imeDismiss({ value: input.value }));
    input.addEventListener("keydown", this.handleKey);
    parent.appendChild(input); this.inputElement = input; this.ownsInputElement = true;
    return input;
  }

  updateInput(value) {
    const input = this.ensureInputElement();
    if (!value?.visible) { input.style.display = "none"; return; }
    input.value = String(value.text || ""); input.placeholder = String(value.placeholder || "");
    input.style.cssText = `${value.style || ""};position:absolute;z-index:10;display:block;box-sizing:border-box;`;
    input.focus({ preventScroll: true });
    const cursor = Math.max(0, Math.min(input.value.length, Number(value.cursor) || input.value.length));
    input.setSelectionRange(cursor, cursor);
  }

  pointer(event) {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.width() / Math.max(1, rect.width), scaleY = this.height() / Math.max(1, rect.height);
    const contact = { surface: 0, id: Number(event.pointerId || 0) >>> 0,
      x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY,
      cancelled: event.type === "pointercancel" };
    if (event.type === "pointerdown") {
      if ((!this.inputElement || this.inputElement.style.display === "none") && this.canvas.focus) this.canvas.focus({ preventScroll: true });
      this.pointers.set(event.pointerId, contact);
      this.canvas.setPointerCapture?.(event.pointerId);
    } else if (event.type === "pointermove") {
      if (!this.pointers.has(event.pointerId)) return;
      this.pointers.set(event.pointerId, contact);
    } else {
      if (!this.pointers.has(event.pointerId)) return;
      this.pointers.delete(event.pointerId);
    }
    const contacts = [...this.pointers.values()];
    if (event.type === "pointercancel") contacts.push(contact);
    this.host.inputFrame(contacts);
    event.preventDefault();
  }

  async mount() {
    if (this.disposed) throw new Error("PocketWebRuntime is disposed");
    if (this.mounted) return this;
    if (this.mountPromise) return this.mountPromise;
    this.mountPromise = this.mountRuntime();
    try { return await this.mountPromise; }
    catch (error) { this.dispose(); throw error; }
    finally { this.mountPromise = null; }
  }

  async mountRuntime() {
    if (!this.renderWorker && (this.qjbcUrl || this.pakUrl)) {
      if (!this.qjbcUrl || !this.pakUrl) throw new Error("PocketWebRuntime requires both qjbcUrl and pakUrl");
      const [qjbcResponse, pakResponse] = await Promise.all([
        fetch(this.qjbcUrl, { cache: this.cache ?? "no-store" }),
        fetch(this.pakUrl, { cache: this.cache ?? "no-store" }),
      ]);
      if (!qjbcResponse.ok) throw new Error(`PocketJS QJBC HTTP ${qjbcResponse.status}`);
      if (!pakResponse.ok) throw new Error(`PocketJS PAK HTTP ${pakResponse.status}`);
      const hostAbi = Number(this.config.bindingGeneration ?? this.config.hostAbi);
      if (!Number.isInteger(hostAbi) || hostAbi < 1) {
        throw new Error("PocketWebRuntime external Guest requires config.bindingGeneration");
      }
      this.config.externalGuest = {
        qjbc: new Uint8Array(await qjbcResponse.arrayBuffer()),
        pak: new Uint8Array(await pakResponse.arrayBuffer()),
        tickHz: Number(this.config.tickHz || 60),
        hostAbi,
      };
    }
    this.active = true;
    addEventListener("resize", this.handleResize); addEventListener("visibilitychange", this.handleVisibility);
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) this.canvas.addEventListener(type, this.handlePointer, { passive: false });
    await this.host.start(this.width(), this.height(), numberOr(globalThis.devicePixelRatio, 1));
    const workerConfig = this.config.worker && typeof this.config.worker === "object" ? this.config.worker : null;
    const workerDescriptor = workerConfig?.descriptor && typeof workerConfig.descriptor === "object" ? workerConfig.descriptor : workerConfig;
    if (!this.renderWorker && workerConfig && workerDescriptor) {
      const base = globalThis.location?.href || globalThis.document?.baseURI || "http://localhost/";
      const engineUrl = new URL(this.engineUrl, base).href;
      const qjbcBase = this.qjbcUrl ? new URL(this.qjbcUrl, base) : new URL(base);
      this.workerTransport = createPocketWorkerTransport({
        descriptor: workerDescriptor,
        engineUrl,
        qjbcUrl: new URL(String(workerConfig.bytecode || "app.worker.qjbc"), qjbcBase).href,
        workerHttpOrigins: this.config.workerHttpOrigins,
        onError: (error) => this.onError?.(error),
      });
      this.workerTransportUnsubscribe = this.workerTransport.subscribe((channel, data) =>
        this.host.pushWorkerChannel(channel, data));
      try {
        await this.workerTransport.ready;
      } catch (error) {
        this.dispose();
        throw error;
      }
    }
    this.mounted = true;
    this.host.show(); this.workerTransport?.setActive(true); this.gameInput?.setActive(true); return this;
  }

  show() { if (!this.disposed) { this.active = true; this.host.show(); this.workerTransport?.setActive(true); this.gameInput?.setActive(true); } }
  hide() { if (!this.disposed) { this.gameInput?.setActive(false); this.active = false; this.workerTransport?.setActive(false); this.host.hide(); } }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.active = false;
    const released = this.live2d?.dispose().catch(error => this.onError?.(error)); this.live2d = null;
    removeEventListener("resize", this.handleResize); removeEventListener("visibilitychange", this.handleVisibility);
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) this.canvas.removeEventListener(type, this.handlePointer);
    this.pointers.clear(); this.gameInput?.dispose(); this.gameInput = null; this.workerTransportUnsubscribe?.(); this.workerTransportUnsubscribe = null; this.workerTransport?.dispose(); this.workerTransport = null; this.host.dispose(); if (this.ownsInputElement) this.inputElement?.remove();
    return released;
  }
}

export { PocketWebRuntime, registerCapability, setPermissionHandler };
