const MAX_OUTBOUND = 32;
const MAX_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_STORAGE_ITEM_BYTES = 1024 * 1024;
const MAX_CANVAS_DIMENSION = 1365;
const capabilityHandlers = Object.create(null);
let permissionHandler = null;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function utf8Length(value) {
  return unescape(encodeURIComponent(value)).length;
}

function encodeUtf8(value) {
  const binary = unescape(encodeURIComponent(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeUtf8(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(bytes.length, offset + 8192)));
  }
  return decodeURIComponent(escape(binary));
}

function createAbortController() {
  let aborted = false;
  const listeners = [];
  return {
    signal: {
      get aborted() { return aborted; },
      addEventListener(name, listener) { if (name === "abort" && typeof listener === "function") listeners.push(listener); },
      removeEventListener(name, listener) {
        if (name !== "abort") return;
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of listeners.slice()) {
        try { listener({ type: "abort" }); } catch (_) { /* Cancellation cannot block host cleanup. */ }
      }
      listeners.length = 0;
    },
  };
}

class PocketWechatHost {
  constructor(options) {
    this.wx = options.wx;
    this.config = options.config;
    this.canvas = options.canvas;
    this.context = options.context;
    this.onInput = options.onInput;
    this.onError = options.onError;
    this.isActive = options.isActive;
    this.instance = null;
    this.exports = null;
    this.host = 0;
    this.scale = 1;
    this.logicalWidth = 1;
    this.logicalHeight = 1;
    this.imageData = null;
    this.outbound = [];
    this.pending = new Map();
    this.raf = 0;
    this.rafUsesCanvas = false;
    this.timer = 0;
    this.running = false;
    this.visible = false;
    this.disposed = false;
    this.draining = false;
    this.input = null;
    this.inputRevision = 0;
    this.generation = 1;
    this.lastClockUs = 0;
  }

  clockNowUs() {
    // Date.now is the portable clock available on the supported WX runtime.
    // Clamp clock adjustments so QuickJS execution deadlines never move back.
    this.lastClockUs = Math.max(Date.now() * 1000, this.lastClockUs + 1);
    return this.lastClockUs;
  }

  async start(width, height, devicePixelRatio) {
    this.logicalWidth = Math.max(1, Math.floor(width));
    this.logicalHeight = Math.max(1, Math.floor(height));
    const scale = Math.min(4, Math.max(1, Math.floor(devicePixelRatio || 1)),
      Math.floor(MAX_CANVAS_DIMENSION / this.logicalWidth), Math.floor(MAX_CANVAS_DIMENSION / this.logicalHeight));
    if (scale < 1) throw new Error("PocketJS Canvas2D viewport exceeds WeChat's 1365px dimension limit.");
    this.scale = scale;
    this.configureCanvas();

    const imports = {
      env: { __rquickjs_host_now_us: () => this.clockNowUs() },
      pocket_wechat: {
        host_emit: (pointer, length) => this.enqueueFromWasm(pointer, length),
      },
    };
    const loaded = await this.wx.WXWebAssembly.instantiate(this.config.enginePath, imports);
    if (this.disposed) return;
    this.instance = loaded.instance || loaded;
    this.exports = this.instance.exports;
    this.host = this.exports.web_create(this.logicalWidth, this.logicalHeight, this.scale, 0, 0);
    if (!this.host) throw new Error("PocketJS WASM could not allocate its runtime host.");
    this.check(this.exports.web_wechat_boot(this.host, this.scale), "PocketJS QuickJS guest did not boot.");
    this.draw();
    this.drainOutbound();
    this.visible = !!this.isActive();
    this.schedule();
  }

  configureCanvas() {
    const width = this.logicalWidth * this.scale;
    const height = this.logicalHeight * this.scale;
    if (width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION) throw new Error("PocketJS Canvas2D output exceeds WeChat's 1365px dimension limit.");
    this.canvas.width = width;
    this.canvas.height = height;
    this.imageData = this.context.createImageData(width, height);
  }

  resize(width, height) {
    if (!this.exports || this.disposed) return;
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    const nextScale = Math.min(this.scale, Math.floor(MAX_CANVAS_DIMENSION / nextWidth), Math.floor(MAX_CANVAS_DIMENSION / nextHeight));
    if (nextScale < 1) {
      this.onError(new Error("PocketJS Canvas2D viewport exceeds WeChat's 1365px dimension limit."));
      return;
    }
    const changed = nextWidth !== this.logicalWidth || nextHeight !== this.logicalHeight || nextScale !== this.scale;
    if (!changed) return;
    this.logicalWidth = nextWidth;
    this.logicalHeight = nextHeight;
    this.scale = nextScale;
    this.configureCanvas();
    this.check(this.exports.web_resize(this.host, nextWidth, nextHeight), "PocketJS viewport resize failed.");
    this.draw();
    this.drainOutbound();
    this.schedule();
  }

  allocBytes(text) {
    const bytes = encodeUtf8(text);
    const pointer = this.exports.web_alloc(bytes.length);
    if (!pointer) throw new Error("PocketJS WASM could not allocate an input buffer.");
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
    return { pointer, length: bytes.length };
  }

  withBytes(text, callback) {
    const buffer = this.allocBytes(text);
    try { return callback(buffer.pointer, buffer.length); }
    finally { this.exports.web_free(buffer.pointer, buffer.length); }
  }

  check(code, fallback) {
    if (code === 0) return;
    let detail = "";
    try {
      const pointer = this.exports.web_result_ptr(this.host);
      const length = this.exports.web_result_len(this.host);
      if (pointer && length) detail = decodeUtf8(new Uint8Array(this.exports.memory.buffer, pointer, length));
    } catch (_) { /* The host may have failed before it created a result string. */ }
    throw new Error(detail ? `${fallback} ${detail}` : fallback);
  }

  enqueueFromWasm(pointer, length) {
    if (!this.exports || length <= 0 || length > 64 * 1024 || this.outbound.length >= MAX_OUTBOUND) return 0;
    const line = decodeUtf8(new Uint8Array(this.exports.memory.buffer, pointer, length));
    this.outbound.push(line);
    return 1;
  }

  inputFrame(contacts) {
    if (!this.exports || this.disposed || !this.visible) return;
    this.stopScheduled();
    this.advance(contacts);
    this.schedule();
  }

  advance(contacts = []) {
    const facts = JSON.stringify({ buttons: 0, analog: 0x8080, rightAnalog: 0x8080, contacts, axisDeltas: [] });
    this.withBytes(facts, (pointer, length) => this.check(
      this.exports.web_advance(this.host, pointer, length, 1), "PocketJS guest frame failed.",
    ));
    this.check(this.exports.web_present(this.host), "PocketJS renderer failed to present DrawOps.");
    this.draw();
    this.drainOutbound();
  }

  draw() {
    if (!this.exports || !this.imageData || !this.context) return;
    const pointer = this.exports.web_pixels(this.host);
    const length = this.exports.web_pixels_len(this.host);
    if (!pointer || length !== this.imageData.data.length) return;
    this.imageData.data.set(new Uint8ClampedArray(this.exports.memory.buffer, pointer, length));
    this.context.putImageData(this.imageData, 0, 0);
  }

  workState() {
    this.check(this.exports.web_wechat_work_state(this.host), "PocketJS scheduler state is unavailable.");
    const pointer = this.exports.web_result_ptr(this.host);
    const length = this.exports.web_result_len(this.host);
    return JSON.parse(decodeUtf8(new Uint8Array(this.exports.memory.buffer, pointer, length)));
  }

  schedule() {
    if (!this.exports || !this.visible || this.disposed || this.running) return;
    let state;
    try { state = this.workState(); }
    catch (error) { this.onError(error); return; }
    if (state.continuous) {
      this.running = true;
      this.rafUsesCanvas = !!this.canvas.requestAnimationFrame;
      const scheduleFrame = this.rafUsesCanvas
        ? (callback) => this.canvas.requestAnimationFrame(callback)
        : (callback) => setTimeout(callback, 16);
      this.raf = scheduleFrame(() => {
        this.running = false;
        this.raf = 0;
        if (!this.visible || this.disposed) return;
        this.advance([]);
        this.schedule();
      });
      return;
    }
    const frames = Number(state.framesUntilTimer || 0);
    if (frames <= 0) return;
    this.running = true;
    this.exports.web_wechat_skip_idle_frames(this.host, Math.max(0, frames - 1));
    const delay = Math.max(1, Math.ceil(frames * 1000 / Math.max(1, Number(state.simulationHz) || 60)));
    this.timer = setTimeout(() => {
      this.running = false;
      this.timer = 0;
      if (!this.visible || this.disposed) return;
      this.advance([]);
      this.schedule();
    }, delay);
  }

  wake() {
    if (!this.exports || this.disposed || !this.visible) return;
    this.stopScheduled();
    this.advance([]);
    this.schedule();
  }

  stopScheduled() {
    if (this.raf) {
      if (this.rafUsesCanvas && this.canvas && this.canvas.cancelAnimationFrame) this.canvas.cancelAnimationFrame(this.raf);
      else clearTimeout(this.raf);
    }
    if (this.timer) clearTimeout(this.timer);
    this.raf = 0;
    this.rafUsesCanvas = false;
    this.timer = 0;
    this.running = false;
  }

  show() {
    if (this.disposed || !this.exports) return;
    this.visible = true;
    this.wake();
  }

  hide() {
    if (this.disposed) return;
    this.visible = false;
    this.stopScheduled();
    this.cancelPending("cancelled", "Mini Program page became inactive");
    this.imeDismiss({});
  }

  declared(capability) {
    const requires = this.config.requires || [];
    const optional = this.config.optional || [];
    if (capability.startsWith("platform.storage.")) {
      return requires.includes(capability) || optional.includes(capability)
        || requires.includes("platform.storage") || optional.includes("platform.storage");
    }
    return requires.includes(capability) || optional.includes(capability);
  }

  drainOutbound() {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      let passes = 0;
      while (this.outbound.length && passes++ < MAX_OUTBOUND * 2) {
        const line = this.outbound.shift();
        const event = parseLine(line);
        if (!event) continue;
        const name = event.name || event.method;
        const payload = event.payload || event.params || {};
        if (name === "host.request") this.handleRequest(payload);
        else if (name === "textInput.open") this.openInput(payload);
        else if (name === "textInput.update") this.updateInput(payload);
        else if (name === "textInput.close") this.closeInput(true);
      }
    } finally {
      this.draining = false;
    }
  }

  async handleRequest(request) {
    if (!isRecord(request) || typeof request.requestId !== "string" || typeof request.capability !== "string") return;
    if (this.pending.size >= MAX_REQUESTS) {
      this.respond(request, false, null, { code: "request_quota", message: "WeChat host request limit reached" });
      return;
    }
    if (!this.declared(request.capability)) {
      this.respond(request, false, null, { code: "permission_denied", message: `Capability is not declared: ${request.capability}` });
      return;
    }
    const generation = this.generation;
    const record = { request, generation, timer: 0, cancelled: false, controller: createAbortController() };
    this.pending.set(request.requestId, record);
    record.timer = setTimeout(() => {
      if (!this.pending.delete(request.requestId)) return;
      record.cancelled = true;
      record.controller.abort();
      this.respond(request, false, null, { code: "timeout", message: "WeChat host request timed out" });
    }, REQUEST_TIMEOUT_MS);
    try {
      const authorize = permissionHandler;
      if (typeof authorize === "function") {
        const allowed = await authorize(request.capability, request.params || {}, {
          wx: this.wx,
          signal: record.controller.signal,
        });
        if (!allowed) throw this.error("permission_denied", "Permission request was cancelled");
      } else if (!request.capability.startsWith("platform.storage.")) {
        throw this.error("unconfigured", `No WeChat handler is configured for ${request.capability}`);
      }
      if (record.cancelled || generation !== this.generation) return;
      const result = await this.dispatchCapability(request.capability, request.params || {}, record.controller.signal);
      if (!this.pending.delete(request.requestId) || generation !== this.generation || record.cancelled) return;
      clearTimeout(record.timer);
      this.respond(request, true, result, null);
    } catch (error) {
      if (!this.pending.delete(request.requestId) || generation !== this.generation || record.cancelled) return;
      clearTimeout(record.timer);
      const shape = error && error.code
        ? { code: String(error.code), message: String(error.message || error.code) }
        : { code: "host_error", message: String(error && error.message || error) };
      this.respond(request, false, null, shape);
    }
  }

  error(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async dispatchCapability(capability, params, signal) {
    if (capability.startsWith("platform.storage.")) return this.storage(capability, params);
    const handler = capabilityHandlers[capability];
    if (typeof handler !== "function") throw this.error("unconfigured", `No WeChat handler is configured for ${capability}`);
    return handler(params, { signal, wx: this.wx });
  }

  storageKey(namespace, key) {
    if (typeof key !== "string" || key.length < 1 || key.length > 512) throw this.error("invalid_argument", "Storage key must be 1 to 512 characters");
    if (namespace !== undefined && (typeof namespace !== "string" || namespace.length > 128)) throw this.error("invalid_argument", "Storage namespace must be at most 128 characters");
    return `pocketjs:v1:${this.config.appId}:${namespace || "app"}:${key}`;
  }

  storage(capability, params) {
    const operation = capability.slice("platform.storage.".length);
    if (operation === "get") {
      const key = this.storageKey(params.namespace, params.key);
      return new Promise((resolve, reject) => this.wx.getStorage({
        key,
        success: (result) => {
          try { resolve(JSON.parse(result.data)); }
          catch (_) { reject(this.error("storage_corrupt", "Stored PocketJS value is invalid JSON")); }
        },
        fail: (error) => {
          const message = String(error && error.errMsg || "");
          if (message.includes("not found") || message.includes("data not found")) resolve(null);
          else reject(this.error("storage_failed", message || "WeChat storage read failed"));
        },
      }));
    }
    if (operation === "set") {
      const key = this.storageKey(params.namespace, params.key);
      let value;
      try { value = JSON.stringify(params.value); }
      catch (_) { throw this.error("invalid_argument", "Storage value must be JSON serializable"); }
      if (value === undefined || utf8Length(value) > MAX_STORAGE_ITEM_BYTES) throw this.error("quota_exceeded", "WeChat storage values are limited to 1 MiB per key");
      return new Promise((resolve, reject) => this.wx.setStorage({
        key,
        data: value,
        success: () => resolve(null),
        fail: (error) => reject(this.error("storage_failed", String(error && error.errMsg || "WeChat storage write failed"))),
      }));
    }
    if (operation === "remove") {
      const key = this.storageKey(params.namespace, params.key);
      return new Promise((resolve, reject) => this.wx.removeStorage({
        key,
        success: () => resolve(null),
        fail: (error) => reject(this.error("storage_failed", String(error && error.errMsg || "WeChat storage removal failed"))),
      }));
    }
    if (operation === "keys") {
      const prefix = `pocketjs:v1:${this.config.appId}:${params.namespace || "app"}:`;
      return new Promise((resolve, reject) => this.wx.getStorageInfo({
        success: (info) => resolve((info.keys || []).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).sort()),
        fail: (error) => reject(this.error("storage_failed", String(error && error.errMsg || "WeChat storage listing failed"))),
      }));
    }
    throw this.error("unsupported", `Unsupported WeChat storage operation: ${operation}`);
  }

  respond(request, ok, result, error) {
    const packet = JSON.stringify({
      type: "event",
      name: "host.response",
      payload: {
        requestId: request.requestId,
        capability: request.capability,
        ok,
        ...(ok ? { result: result === undefined ? null : result } : { error }),
      },
    });
    this.deliverResponse(packet);
  }

  deliverResponse(packet) {
    if (!this.exports || this.disposed) return;
    this.withBytes(packet, (pointer, length) => this.check(
      this.exports.web_wechat_deliver(this.host, pointer, length), "PocketJS rejected a host response.",
    ));
    this.drainOutbound();
    this.wake();
  }

  deliverGuestEvent(method, params) {
    if (!this.exports || this.disposed) return;
    const methodBytes = this.allocBytes(method);
    const paramsBytes = this.allocBytes(JSON.stringify(params || {}));
    try {
      this.check(this.exports.web_wechat_guest_event(
        this.host,
        methodBytes.pointer,
        methodBytes.length,
        paramsBytes.pointer,
        paramsBytes.length,
      ), "PocketJS rejected a native input event.");
    } finally {
      this.exports.web_free(methodBytes.pointer, methodBytes.length);
      this.exports.web_free(paramsBytes.pointer, paramsBytes.length);
    }
    this.drainOutbound();
    this.wake();
  }

  inputStyle(value) {
    const rect = isRecord(value.rect) ? value.rect : { x: 8, y: 8, width: 240, height: 38 };
    const x = Math.max(0, Number(rect.x) || 0);
    const y = Math.max(0, Number(rect.y) || 0);
    const width = Math.max(40, Number(rect.width) || 240);
    const height = Math.max(28, Number(rect.height) || 38);
    const fontSize = [12, 14, 16].includes(value.fontSize) ? value.fontSize : 14;
    const radius = Math.max(0, Math.min(24, Number(value.borderRadius) || 8));
    const paddingH = Math.max(0, Number(value.paddingHorizontal) || 12);
    const paddingV = Math.max(0, Number(value.paddingVertical) || 8);
    return [
      `left:${x}px`, `top:${y}px`, `width:${width}px`, `height:${height}px`,
      `font-size:${fontSize}px`, `line-height:${Math.max(20, height - paddingV * 2)}px`,
      `color:${value.textColor || "#283444"}`, `background:${value.fillColor || "#ffffff"}`,
      `border:1px solid ${value.focusedBorderColor || value.borderColor || "#2676cb"}`,
      `border-radius:${radius}px`, `padding:0 ${paddingH}px`,
    ].join(";");
  }

  openInput(value) {
    const text = String(value.text ?? "");
    const requestedCursor = Number.isInteger(value.selectionExtent) ? value.selectionExtent : text.length;
    this.input = {
      id: value.id,
      editingSession: value.editingSession,
      revision: Number(value.revision) || 0,
      jsRevision: Number(value.jsRevision) || 0,
      text,
      cursor: Math.max(0, Math.min(text.length, requestedCursor)),
      placeholder: String(value.placeholder || ""),
      confirmType: value.action === "search" ? "search" : value.action === "next" ? "next" : "done",
      cursorSpacing: Math.max(0, Number(value.paddingVertical) || 8),
      style: this.inputStyle(value),
    };
    this.inputRevision = this.input.revision;
    this.onInput({ ...this.input, visible: true, focus: true });
  }

  updateInput(value) {
    if (!this.input || (value.id !== undefined && String(value.id) !== String(this.input.id))) return;
    if (value.editingSession && value.editingSession !== this.input.editingSession) return;
    const nextText = value.text !== undefined ? String(value.text) : this.input.text;
    const textChanged = nextText !== this.input.text;
    const requestedCursor = Number.isInteger(value.selectionExtent)
      ? value.selectionExtent
      : textChanged ? nextText.length : this.input.cursor;
    const nextCursor = Math.max(0, Math.min(nextText.length, requestedCursor));
    const cursorChanged = nextCursor !== this.input.cursor;
    this.input = {
      ...this.input,
      ...(textChanged || cursorChanged ? { text: nextText, cursor: nextCursor } : {}),
      ...(value.revision !== undefined ? { revision: Number(value.revision) || this.input.revision } : {}),
      ...(value.jsRevision !== undefined ? { jsRevision: Number(value.jsRevision) || this.input.jsRevision } : {}),
      ...(value.rect ? { style: this.inputStyle({ ...this.input, ...value }) } : {}),
    };
    this.inputRevision = this.input.revision;
    if (textChanged || cursorChanged || value.rect) this.onInput({ ...this.input, visible: true, focus: true });
  }

  closeInput(hideKeyboard) {
    if (!this.input) return;
    this.input = null;
    this.onInput({ visible: false });
    if (hideKeyboard && this.wx.hideKeyboard) this.wx.hideKeyboard({ complete: () => {} });
  }

  imeEdit(detail) {
    if (!this.input) return;
    this.inputRevision += 1;
    const text = String(detail.value ?? "");
    const requestedCursor = Number.isInteger(detail.cursor) ? detail.cursor : text.length;
    const cursor = Math.max(0, Math.min(text.length, requestedCursor));
    this.input.text = text;
    this.input.cursor = cursor;
    this.deliverGuestEvent("textInput.edit", {
      id: this.input.id,
      editingSession: this.input.editingSession,
      revision: this.inputRevision,
      jsRevision: this.input.jsRevision,
      text,
      selectionBase: cursor,
      selectionExtent: cursor,
      composingBase: -1,
      composingExtent: -1,
    });
  }

  imeSubmit(detail) {
    if (!this.input) return;
    const text = String(detail.value ?? this.input.text ?? "");
    this.deliverGuestEvent("textInput.submit", {
      id: this.input.id,
      editingSession: this.input.editingSession,
      revision: this.inputRevision,
      jsRevision: this.input.jsRevision,
      text,
      selectionBase: text.length,
      selectionExtent: text.length,
      composingBase: -1,
      composingExtent: -1,
      action: this.input.confirmType,
    });
  }

  imeDismiss(detail) {
    if (!this.input) return;
    const input = this.input;
    this.input = null;
    this.onInput({ visible: false });
    this.deliverGuestEvent("textInput.dismiss", {
      id: input.id,
      editingSession: input.editingSession,
      revision: this.inputRevision,
      jsRevision: input.jsRevision,
      reason: "blur",
      text: String(detail.value ?? input.text ?? ""),
    });
  }

  cancelPending(code, message) {
    this.generation += 1;
    for (const record of this.pending.values()) {
      clearTimeout(record.timer);
      record.cancelled = true;
      record.controller.abort();
      this.respond(record.request, false, null, { code, message });
    }
    this.pending.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.visible = false;
    this.stopScheduled();
    this.cancelPending("cancelled", "PocketJS host was disposed");
    if (this.exports && this.host) {
      this.exports.web_destroy(this.host);
      this.host = 0;
    }
    this.disposed = true;
    this.outbound.length = 0;
    this.instance = null;
    this.exports = null;
  }
}

function registerCapability(name, handler) {
  if (typeof name !== "string" || !name || typeof handler !== "function") throw new TypeError("Capability registration requires a name and handler");
  capabilityHandlers[name] = handler;
  return () => { if (capabilityHandlers[name] === handler) delete capabilityHandlers[name]; };
}

function setPermissionHandler(handler) {
  if (handler !== null && typeof handler !== "function") throw new TypeError("Permission handler must be a function or null");
  permissionHandler = handler;
}

module.exports = { PocketWechatHost, registerCapability, setPermissionHandler };
