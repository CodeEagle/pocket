/* Main-thread surface/input boundary. The owning UI runtime lives in Worker. */
function errorFrom(value, fallback = "PocketJS rendering Worker failed") {
  return Object.assign(new Error(String(value?.message || value || fallback)),
    value?.code ? { code: String(value.code) } : {});
}

class PocketRenderWorkerHost {
  constructor(options) {
    if (typeof Worker !== "function" || typeof options.canvas.transferControlToOffscreen !== "function") {
      throw Object.assign(new Error("PocketJS renderWorker requires Worker and transferControlToOffscreen support"), { code: "unsupported" });
    }
    this.options = options;
    this.worker = null;
    this.pending = new Map();
    this.boundaries = new Map();
    this.nextId = 1;
    this.input = null;
    this.ready = false;
    this.disposed = false;
    this.disposeTimer = 0;
  }

  request(type, payload, transfer = []) {
    if (!this.worker || this.disposed) return Promise.reject(new Error("PocketJS rendering Worker is disposed"));
    if (this.pending.size >= 64 && payload.method !== "dispose") return Promise.reject(Object.assign(new Error("PocketJS rendering Worker command quota reached"), { code: "busy" }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("PocketJS rendering Worker command timed out"), { code: "timeout" }));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ type, id, ...payload }, transfer); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async start(width, height, devicePixelRatio) {
    if (this.disposed) throw new Error("PocketJS rendering Worker is disposed");
    this.worker = new Worker(this.options.workerUrl, { type: "module", name: "Pocket renderer" });
    this.worker.onmessage = (event) => this.message(event.data || {});
    this.worker.onerror = (event) => this.fail(errorFrom(event.error || event.message));
    this.worker.onmessageerror = () => this.fail(new Error("PocketJS rendering Worker message could not be decoded"));
    try {
      // Transfer only after the worker constructor succeeds. There is never
      // a second Canvas2D context or a silent main-thread fallback.
      const canvas = this.options.canvas.transferControlToOffscreen();
      const result = await this.request("init", { canvas, width, height, devicePixelRatio,
        engineUrl: this.options.engineUrl, qjbcUrl: this.options.qjbcUrl,
        pakUrl: this.options.pakUrl, cache: this.options.cache, config: this.options.config,
        capabilityNames: this.options.capabilityNames }, [canvas]);
      if (this.disposed) throw new Error("PocketJS rendering Worker was disposed while mounting");
      this.ready = true;
      return result;
    } catch (error) { this.dispose(); throw error; }
  }

  async message(message) {
    if (message.type === "reply") {
      const record = this.pending.get(message.id);
      if (!record) return;
      this.pending.delete(message.id); clearTimeout(record.timer);
      if (message.error) record.reject(errorFrom(message.error));
      else record.resolve(message.result);
      return;
    }
    if (this.disposed) return;
    if (message.type === "input") {
      this.input = message.value?.visible ? message.value : null;
      this.options.onInput?.(message.value);
    } else if (message.type === "error") this.options.onError?.(errorFrom(message.error));
    else if (message.type === "boundaryCancel") {
      this.boundaries.get(message.id)?.abort();
      this.boundaries.delete(message.id);
    } else if (message.type === "boundary") {
      if (this.boundaries.size >= 32 || this.boundaries.has(message.id)) {
        this.worker?.postMessage({ type: "boundaryResult", id: message.id, error: { code: "busy", message: "Browser boundary quota reached" } });
        return;
      }
      const controller = new AbortController();
      this.boundaries.set(message.id, controller);
      try {
        const result = await this.options.boundary(message.operation, message.params || {}, controller.signal);
        if (!this.disposed && this.boundaries.get(message.id) === controller) {
          try { this.worker.postMessage({ type: "boundaryResult", id: message.id, result }); }
          catch (error) { this.worker.postMessage({ type: "boundaryResult", id: message.id,
            error: { code: "invalid_result", message: String(error?.message || error) } }); }
        }
      } catch (error) {
        if (!this.disposed && this.boundaries.get(message.id) === controller) this.worker.postMessage({
          type: "boundaryResult", id: message.id, error: { code: String(error?.code || "host_error"), message: String(error?.message || error) },
        });
      } finally { if (this.boundaries.get(message.id) === controller) this.boundaries.delete(message.id); }
    }
  }

  command(method, args = {}) { return this.request("command", { method, args }); }
  notify(method, args = {}) {
    if (!this.ready || this.disposed) return;
    void this.command(method, args).catch((error) => { if (!this.disposed) this.options.onError?.(error); });
  }
  inputFrame(contacts) { this.notify("inputFrame", { contacts, inputSample: this.options.sampleInput?.() || {} }); }
  resize(width, height) { this.notify("resize", { width, height, devicePixelRatio: globalThis.devicePixelRatio || 1 }); }
  show() { this.notify("show"); }
  hide() {
    this.notify("hide");
    this.cancelBoundaries("Browser page inactive");
  }
  imeEdit(detail) { this.notify("imeEdit", { detail }); }
  imeSubmit(detail) { this.notify("imeSubmit", { detail }); }
  imeDismiss(detail) { this.notify("imeDismiss", { detail }); }
  inspect() { return this.command("inspect"); }
  stats() { return this.command("stats"); }

  cancelBoundaries(message) {
    for (const [id, controller] of this.boundaries) {
      controller.abort();
      this.worker?.postMessage({ type: "boundaryResult", id, error: { code: "cancelled", message } });
    }
    this.boundaries.clear();
  }

  fail(error) {
    for (const record of this.pending.values()) { clearTimeout(record.timer); record.reject(error); }
    this.pending.clear();
    this.options.onError?.(error);
    this.dispose();
  }
  dispose() {
    if (this.disposed) return;
    // Ask the owner to destroy the native runtime and nested IO Worker. If
    // guest execution is stuck, terminating releases the entire WASM heap.
    const worker = this.worker;
    const disposalId = this.nextId;
    if (worker) {
      void this.command("dispose").finally(() => { clearTimeout(this.disposeTimer); worker.terminate(); }).catch(() => {});
      this.disposeTimer = setTimeout(() => {
        worker.terminate();
        const record = this.pending.get(disposalId);
        if (record) { clearTimeout(record.timer); this.pending.delete(disposalId); record.reject(new Error("PocketJS rendering Worker terminated")); }
      }, 1000);
    }
    this.disposed = true; this.ready = false; this.input = null;
    this.cancelBoundaries("Browser host disposed");
    for (const [id, record] of this.pending) {
      if (id === disposalId && worker) continue;
      clearTimeout(record.timer); record.reject(new Error("PocketJS rendering Worker is disposed"));
      this.pending.delete(id);
    }
  }
}
module.exports = { PocketRenderWorkerHost };
