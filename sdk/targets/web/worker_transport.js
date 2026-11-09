/*
 * Browser transport for the pinned QuickJS Worker ABI.
 *
 * This module never evaluates the generated Worker JavaScript bundle. The
 * browser Worker instantiates the same pocketjs.wasm artifact as the UI host,
 * boots app.worker.qjbc through web_worker_create, and returns official Worker
 * facts through web_worker_emit/web_worker_finish.
 */

function createPocketWorkerTransport(options = {}) {
  const descriptor = options.descriptor;
  if (!descriptor || typeof descriptor !== "object") throw new TypeError("Worker descriptor is required");
  const engineUrl = String(options.engineUrl || "");
  const qjbcUrl = String(options.qjbcUrl || "");
  if (!engineUrl || !qjbcUrl) throw new TypeError("Worker engineUrl and qjbcUrl are required");
  const workerScript = `
const descriptor = ${JSON.stringify(descriptor)};
const engineUrl = ${JSON.stringify(engineUrl)};
const qjbcUrl = ${JSON.stringify(qjbcUrl)};
const origins = new Set(${JSON.stringify(Array.isArray(options.workerHttpOrigins) ? options.workerHttpOrigins.map(String) : [])});
const FACT = { ready: 1, complete: 2, data: 3, end: 4, timer: 6, channel: 7, headers: 8, error: 9 };
const STATUS = { ok: 0, failed: -1, cancelled: -2, unknown: -3, busy: -4, invalid: -5, unsupported: -6 };
let exportsRef, memory, workerPtr = 0, scratch = 0;
let closed = false, active = true, pumping = false, timer = 0, clockOffset = 0, pausedAt = 0, outputSequence = 1;
const resources = new Map(), requests = new Map(), queuedMessages = [], pendingReceives = [], pendingActions = [], pendingOutputs = new Map();
const MAX_QUEUED_MESSAGES = 64, MAX_PENDING_ACTIONS = 512;
const encoder = new TextEncoder(), decoder = new TextDecoder();
function wallNowMicros() { return Math.max(1, Math.floor((self.performance?.timeOrigin || Date.now()) * 1000 + (self.performance?.now?.() || 0) * 1000)); }
function nowMicros() {
  const wall = wallNowMicros();
  if (!active) { if (!pausedAt) pausedAt = wall; return Math.max(1, pausedAt - clockOffset); }
  if (pausedAt) { clockOffset += Math.max(0, wall - pausedAt); pausedAt = 0; }
  return Math.max(1, wall - clockOffset);
}
function bytesAt(pointer, length) { return new Uint8Array(memory.buffer, pointer, length).slice(); }
function withBytes(bytes, callback) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const pointer = exportsRef.web_alloc(value.length || 1);
  if (!pointer) throw new Error("Worker WASM allocation failed");
  try { new Uint8Array(memory.buffer, pointer, value.length).set(value); return callback(pointer, value.length); }
  finally { exportsRef.web_free(pointer, value.length || 1); }
}
function allowed(url) { try { return origins.has(new URL(url).origin); } catch (_) { return false; } }
function errorMessage(status, action) { return "PocketJS Worker " + action + " failed with status " + status; }
function runtimeError(fallback) {
  const pointer = exportsRef?.web_worker_error?.(workerPtr);
  if (!pointer || !memory) return fallback;
  const view = new Uint8Array(memory.buffer);
  let end = pointer;
  while (end < view.length && view[end]) end += 1;
  const message = decoder.decode(view.subarray(pointer, end));
  return message || fallback;
}
function invokeAction(action) {
  if (action.type === "emit") {
    return withBytes(action.payload, (pointer, length) => exportsRef.web_worker_emit(
      workerPtr, action.request, action.kind, action.status, action.offset, pointer, length));
  }
  return exportsRef.web_worker_finish(workerPtr, action.request, action.handle, action.status, action.offset);
}
function flushActions() {
  if (closed || !workerPtr) return;
  while (pendingActions.length) {
    const action = pendingActions[0];
    let status;
    try { status = invokeAction(action); }
    catch (error) {
      pendingActions.shift(); action.reject?.(error);
      self.postMessage({ type: "error", message: String(error?.message || error) });
      continue;
    }
    if (status === STATUS.busy) break;
    pendingActions.shift();
    if (status !== STATUS.ok) {
      const error = new Error(errorMessage(status, action.type));
      action.reject?.(error);
      self.postMessage({ type: "error", message: error.message });
    } else action.resolve?.();
  }
}
function enqueueAction(action) {
  if (closed || !workerPtr) return Promise.reject(new Error("PocketJS Worker is closed"));
  if (pendingActions.length >= MAX_PENDING_ACTIONS) return Promise.reject(new Error("PocketJS Worker fact queue is full"));
  return new Promise((resolve, reject) => {
    action.resolve = resolve; action.reject = reject;
    pendingActions.push(action);
    if (active) { flushActions(); if (!pumping) pump(); }
  });
}
function emit(kind, handle, request, status, offset, payload) {
  const bytes = payload instanceof Uint8Array ? payload.slice() : new Uint8Array(payload || []);
  return enqueueAction({ type: "emit", kind, handle, request, status, offset, payload: bytes });
}
function finish(request, handle, status, offset) {
  return enqueueAction({ type: "finish", request, handle, status, offset });
}
function schedulePump() {
  if (closed || !active || timer || pumping || !workerPtr) return;
  if (pendingReceives.length || pendingActions.length) {
    timer = setTimeout(() => { timer = 0; pump(); }, 0);
    return;
  }
  const deadline = Number(exportsRef.web_worker_deadline(workerPtr));
  if (!Number.isFinite(deadline) || deadline < 0) return;
  const delay = Math.max(1, Math.ceil((deadline - nowMicros()) / 1000));
  timer = setTimeout(() => { timer = 0; pump(); }, delay);
}
function flushReceives() {
  if (closed || !workerPtr) return;
  while (pendingReceives.length) {
    const message = pendingReceives[0];
    const data = message.data instanceof Uint8Array ? message.data : new Uint8Array(message.data || []);
    let status;
    try {
      status = withBytes(data, (pointer, length) => exportsRef.web_worker_receive(
        workerPtr, Number(message.channel || 0), pointer, length));
    } catch (error) {
      pendingReceives.shift();
      self.postMessage({ type: "error", message: String(error?.message || error) });
      continue;
    }
    if (status === STATUS.busy) break;
    pendingReceives.shift();
    if (message.seq) self.postMessage({ type: "channelAck", seq: message.seq, status });
    if (status !== STATUS.ok) self.postMessage({ type: "error", message: errorMessage(status, "channel receive") });
  }
}
function drainChannels() {
  if (pendingOutputs.size >= 8) return;
  const channels = Array.isArray(descriptor.declaration?.channels) ? descriptor.declaration.channels : [];
  const output = new Uint8Array(1024);
  if (!scratch) scratch = exportsRef.web_alloc(output.length);
  if (!scratch) throw new Error("Worker channel buffer allocation failed");
  for (let id = 1; id <= channels.length; id += 1) {
    if (channels[id - 1]?.direction !== "worker-to-ui") continue;
    for (let count = 0; count < 8 && pendingOutputs.size < 8; count += 1) {
      const length = exportsRef.web_worker_take(workerPtr, id, scratch, output.length);
      if (length < 0) break;
      const bytes = new Uint8Array(memory.buffer, scratch, length).slice();
      const seq = outputSequence++;
      pendingOutputs.set(seq, true);
      self.postMessage({ type: "channel", seq, channel: id, data: bytes }, [bytes.buffer]);
      if (length === 0) break;
    }
  }
}
function pump() {
  if (closed || !active || pumping || !workerPtr) return;
  pumping = true;
  try {
    flushReceives(); flushActions();
    for (let count = 0; count < 128; count += 1) {
      const result = exportsRef.web_worker_step(workerPtr, nowMicros());
      drainChannels();
      flushReceives(); flushActions();
      if (result !== 1) {
        if (result < 0) {
          const pointer = exportsRef.web_worker_error(workerPtr);
          let message = "PocketJS Worker failed";
          if (pointer) message = runtimeError(message);
          self.postMessage({ type: "error", message });
        }
        break;
      }
    }
  } finally { pumping = false; schedulePump(); }
}
function startHttp(handle, request) {
  const resource = resources.get(handle);
  if (!resource || !allowed(resource.options.url)) {
    void emit(FACT.error, handle, request, STATUS.unsupported, 0, new Uint8Array())
      .then(() => finish(request, handle, STATUS.unsupported, 0)).catch(() => {});
    return;
  }
  const controller = new AbortController();
  requests.set(request, { handle, controller });
  const timeoutValue = Number(resource.options.timeoutMs);
  const timeout = Math.max(1, Math.min(0x7fffffff, Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 30000));
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  (async () => {
    let offset = 0;
    try {
      const response = await fetch(String(resource.options.url), { method: String(resource.options.method || "GET"), headers: resource.options.headers || {}, body: resource.options.body, redirect: "error", signal: controller.signal });
      const headers = {};
      response.headers?.forEach?.((value, key) => { if (Object.keys(headers).length < 32) headers[String(key).toLowerCase()] = String(value).slice(0, 256); });
      let headerBytes = encoder.encode(JSON.stringify({ status: response.status, url: response.url, headers }));
      if (headerBytes.length > 1024) headerBytes = encoder.encode(JSON.stringify({ status: response.status, url: response.url }));
      await emit(FACT.ready, handle, request, STATUS.ok, 0, new Uint8Array());
      await emit(FACT.headers, handle, request, STATUS.ok, 0, headerBytes);
      if (response.body && String(resource.options.method || "GET") !== "HEAD") {
        const reader = response.body.getReader();
        const maxValue = Number(resource.options.maxBytes);
        const maxBytes = Math.max(1, Math.min(262144, Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 262144));
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          const bytes = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value || []);
          if (offset + bytes.length > maxBytes) throw Object.assign(new Error("HTTP response exceeds maxBytes"), { code: STATUS.failed });
          for (let at = 0; at < bytes.length; at += 1024) {
            const chunk = bytes.slice(at, Math.min(bytes.length, at + 1024));
            await emit(FACT.data, handle, request, STATUS.ok, offset, chunk); offset += chunk.length;
          }
        }
      }
      // The pinned core owns END/COMPLETE ordering. web_worker_emit only
      // accepts non-terminal facts; web_worker_finish appends END followed
      // by the canonical completion once all queued headers/data are seen.
      await finish(request, handle, STATUS.ok, offset);
    } catch (error) {
      const status = error?.name === "AbortError" ? STATUS.cancelled : (Number(error?.code) || STATUS.failed);
      try { await emit(FACT.error, handle, request, status, offset, new Uint8Array()); await finish(request, handle, status, offset); }
      catch (_) { /* The worker realm is already faulted or being disposed. */ }
    } finally { clearTimeout(timeoutId); requests.delete(request); pump(); }
  })();
}
function operation(op, handle, request, opcode, payloadPointer, payloadLength, capacity) {
  if (closed) return STATUS.cancelled;
  const payload = payloadLength > 0 ? bytesAt(payloadPointer, payloadLength) : new Uint8Array();
  if (op === 0) {
    let options; try { options = JSON.parse(decoder.decode(payload)); } catch (_) { return STATUS.invalid; }
    if (typeof options.url !== "string" || !allowed(options.url)) return STATUS.unsupported;
    resources.set(handle, { options }); return STATUS.ok;
  }
  if (op === 1) {
    if (!resources.has(handle) || opcode !== 1) return STATUS.invalid;
    if (!request) return STATUS.invalid;
    startHttp(handle, request); return STATUS.ok;
  }
  if (op === 2) { const pending = requests.get(request); if (!pending) return STATUS.invalid; pending.controller.abort(); return STATUS.ok; }
  if (op === 3) { const resource = resources.get(handle); if (!resource) return STATUS.invalid; for (const [id, pending] of requests) if (pending.handle === handle) { pending.controller.abort(); requests.delete(id); } resources.delete(handle); return STATUS.ok; }
  if (op === 4) return STATUS.unsupported;
  if (op === 5) return resources.has(handle) && opcode === 1 && payloadLength === 0 && capacity === 0 ? STATUS.ok : STATUS.invalid;
  return STATUS.invalid;
}
function receiveChannel(message) {
  const id = Number(message.channel || 0);
  const channels = Array.isArray(descriptor.declaration?.channels) ? descriptor.declaration.channels : [];
  const channel = channels[id - 1];
  const data = message.data instanceof Uint8Array ? message.data.slice() : new Uint8Array(message.data || []);
  if (!channel || channel.direction !== "ui-to-worker" || data.length > Number(channel.recordBytes || 0)) {
    if (message.seq) self.postMessage({ type: "channelAck", seq: message.seq, status: STATUS.invalid });
    self.postMessage({ type: "error", message: "PocketJS Worker channel input violates its descriptor" }); return;
  }
  if (!workerPtr) {
    if (queuedMessages.length >= MAX_QUEUED_MESSAGES) { if (message.seq) self.postMessage({ type: "channelAck", seq: message.seq, status: STATUS.busy }); self.postMessage({ type: "error", message: "PocketJS Worker channel bootstrap queue is full" }); return; }
    queuedMessages.push({ channel: id, data, seq: message.seq }); return;
  }
  if (pendingReceives.length >= MAX_QUEUED_MESSAGES) { if (message.seq) self.postMessage({ type: "channelAck", seq: message.seq, status: STATUS.busy }); self.postMessage({ type: "error", message: "PocketJS Worker channel queue is full" }); return; }
  pendingReceives.push({ channel: id, data, seq: message.seq });
  if (active) { flushReceives(); if (!pumping) pump(); }
}
async function boot() {
  const [wasmResponse, qjbcResponse] = await Promise.all([fetch(engineUrl), fetch(qjbcUrl)]);
  if (!wasmResponse.ok || !qjbcResponse.ok) throw new Error("PocketJS Worker artifact fetch failed");
  const wasmBytes = await wasmResponse.arrayBuffer();
  const qjbc = new Uint8Array(await qjbcResponse.arrayBuffer());
  const imports = { env: { __rquickjs_host_now_us: nowMicros }, pocket_web_worker: { now_micros: nowMicros, operation }, pocket_wechat: { host_emit: () => 0 } };
  const loaded = await WebAssembly.instantiate(wasmBytes, imports);
  exportsRef = loaded.instance?.exports || loaded.exports; memory = exportsRef.memory;
  if (typeof exportsRef.web_worker_create !== "function") throw new Error("PocketJS Web engine has no pinned Worker ABI");
  const config = encoder.encode(JSON.stringify(descriptor));
  workerPtr = withBytes(qjbc, (qjbcPointer, qjbcLength) => withBytes(config, (configPointer, configLength) => exportsRef.web_worker_create(qjbcPointer, qjbcLength, configPointer, configLength, Number(descriptor.tickHz || 60))));
  if (!workerPtr) throw new Error(runtimeError("PocketJS Worker QJBC was rejected"));
  self.postMessage({ type: "ready" });
  while (queuedMessages.length) receiveChannel(queuedMessages.shift());
  pump();
}
self.onmessage = event => { const message = event.data || {}; if (message.type === "channel") receiveChannel(message); else if (message.type === "outputAck") { pendingOutputs.delete(Number(message.seq || 0)); if (active) pump(); } else if (message.type === "active") { if (message.active && !active) { active = true; nowMicros(); } else if (!message.active && active) { pausedAt = wallNowMicros(); active = false; if (timer) { clearTimeout(timer); timer = 0; } } if (active) pump(); } else if (message.type === "dispose") { if (timer) clearTimeout(timer); if (workerPtr) exportsRef.web_worker_destroy(workerPtr); workerPtr = 0; if (scratch) exportsRef?.web_free(scratch, 1024); scratch = 0; closed = true; close(); } };
boot().catch(error => self.postMessage({ type: "error", message: String(error?.message || error) }));
`;
  const blobUrl = URL.createObjectURL(new Blob([workerScript], { type: "text/javascript" }));
  const worker = new Worker(blobUrl);
  const listeners = new Set();
  const inbound = [], inflight = new Map();
  const maxInbound = 64, maxInflight = 8;
  let sequence = 1;
  const outbound = [];
  const maxOutbound = 64;
  let closed = false, active = true, outboundTimer = 0;
  let readyResolve, readyReject;
  let settled = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error) => {
    const value = error instanceof Error ? error : new Error(String(error?.message || error || "PocketJS Worker failed"));
    if (!settled) { settled = true; readyReject(value); }
    options.onError?.(value);
  };
  const flushOutbound = () => {
    if (closed || !active || outboundTimer) return;
    while (outbound.length) {
      const message = outbound[0];
      const accepted = listeners.size > 0 && [...listeners].every(listener => listener(message.channel, message.data) !== false);
      if (!accepted) {
        outboundTimer = setTimeout(() => { outboundTimer = 0; flushOutbound(); }, 16);
        return;
      }
      outbound.shift();
      worker.postMessage({ type: "outputAck", seq: message.seq });
    }
  };
  const pumpInbound = () => {
    if (closed) return;
    while (inflight.size < maxInflight && inbound.length) {
      const message = inbound.shift();
      const seq = sequence++;
      inflight.set(seq, message);
      const copy = message.data.slice();
      worker.postMessage({ type: "channel", seq, channel: message.channel, data: copy }, [copy.buffer]);
    }
  };
  worker.onmessage = event => {
    if (closed) return;
    const message = event.data || {};
    if (message.type === "ready") {
      if (!settled) { settled = true; readyResolve(); }
    } else if (message.type === "channelAck") {
      const pending = inflight.get(Number(message.seq || 0));
      if (!pending) return;
      inflight.delete(Number(message.seq || 0));
      const status = Number(message.status);
      if (status === -4) inbound.unshift(pending);
      else if (status !== 0) fail(new Error("PocketJS Worker channel receive failed with status " + status));
      if (active) pumpInbound();
    } else if (message.type === "channel") {
      if (outbound.length >= maxOutbound) { fail(new Error("PocketJS Worker output channel queue is full")); return; }
      outbound.push({ seq: Number(message.seq || 0), channel: Number(message.channel || 0), data: new Uint8Array(message.data || []) });
      flushOutbound();
    } else if (message.type === "error") fail(new Error(String(message.message || "PocketJS Worker failed")));
  };
  worker.onerror = error => fail(error);
  return {
    ready,
    setActive(value) {
      if (closed) return;
      active = !!value;
      if (!active && outboundTimer) { clearTimeout(outboundTimer); outboundTimer = 0; }
      worker.postMessage({ type: "active", active });
      if (active) { pumpInbound(); flushOutbound(); }
    },
    receive(channel, data) {
      if (closed) return false;
      if (inbound.length + inflight.size >= maxInbound) { fail(new Error("PocketJS Worker input channel queue is full")); return false; }
      const copy = data instanceof Uint8Array ? data.slice() : new Uint8Array(data || []);
      inbound.push({ channel, data: copy }); if (active) pumpInbound(); return true;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      if (closed) return;
      worker.postMessage({ type: "dispose" });
      closed = true;
      setTimeout(() => worker.terminate(), 1000);
      if (outboundTimer) clearTimeout(outboundTimer);
      URL.revokeObjectURL(blobUrl); listeners.clear(); outbound.length = 0; inbound.length = 0; inflight.clear();
    },
  };
}

module.exports = { createPocketWorkerTransport };
