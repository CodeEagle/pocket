/**
 * Thin JSONL transport over @abandonware/noble (the dependency used by
 * dokidoki).
 *
 * Noble owns platform BLE (including its Windows WinRT binding). This file
 * only maps the editor's existing helper protocol to Noble's scan/GATT API;
 * TFTC decoding, security, and product policy remain in the JS package.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePrebuiltTools, nativeBindingEnvironment } from "../../scripts/prebuilt_tools.mjs";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 35_000;
const MIN_SCAN_MS = 250;
const MAX_SCAN_MS = 30_000;

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function bytes(value) {
  if (value === undefined || value === null) return [];
  if (Buffer.isBuffer(value)) return [...value];
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
  return [];
}

function uuid(value) {
  const raw = text(value).trim().toLowerCase().replace(/[{}-]/g, "");
  if (!raw) return "";
  if (/^[0-9a-f]{4}$/.test(raw)) return `0000${raw}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(raw)) return `${raw}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{32}$/.test(raw)) return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  return text(value).trim().toLowerCase();
}

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function nativeError(cause, fallbackCode = "hardware_bluetooth_error") {
  if (cause && cause.code && cause.message) return cause;
  return error(fallbackCode, cause?.message || String(cause || "Bluetooth operation failed"));
}

function timeoutPromise(promise, timeoutMs, cancel) {
  let timer;
  let settled = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { Promise.resolve(cancel?.()).catch(() => {}); } catch { /* best effort */ }
      reject(error("hardware_bluetooth_timeout", "Bluetooth operation timed out"));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise).then(value => {
    // Native connect/discovery may complete after its timeout. Release that
    // late physical result as well as the operation cancelled at timeout.
    if (settled) {
      try { Promise.resolve(cancel?.()).catch(() => {}); } catch { /* best effort */ }
    }
    settled = true;
    clearTimeout(timer);
    return value;
  }, cause => {
    settled = true;
    clearTimeout(timer);
    throw cause;
  }), timeout]);
}

function asyncOperation(target, name, args, timeoutMs, cancel) {
  if (typeof target?.[name] !== "function") {
    return Promise.reject(error("hardware_unsupported", `Noble object does not implement ${name}`));
  }
  try {
    return timeoutPromise(target[name](...args), timeoutMs, cancel);
  } catch (cause) {
    return Promise.reject(cause);
  }
}

function peripheralId(peripheral) {
  return text(peripheral?.id || peripheral?.address).toLowerCase();
}

function advertisement(peripheral) {
  const value = object(peripheral?.advertisement);
  const manufacturerData = value.manufacturerData;
  return {
    id: peripheralId(peripheral),
    name: text(value.localName || peripheral?.name, peripheralId(peripheral)),
    rssi: Number.isFinite(peripheral?.rssi) ? peripheral.rssi : null,
    // Keep the bytes exactly as reported by Noble. The protocol parser decides
    // whether a company prefix is present; this transport never guesses one.
    ...(manufacturerData ? { manufacturerData: bytes(manufacturerData) } : {}),
  };
}

function propertyNames(characteristic) {
  return Array.isArray(characteristic?.properties) ? characteristic.properties.map(String) : [];
}

function characteristicRecord(characteristic) {
  const properties = propertyNames(characteristic).map(value => value.toLowerCase());
  return {
    uuid: uuid(characteristic?.uuid),
    properties,
    canRead: properties.includes("read"),
    canWrite: properties.includes("write"),
    canWriteWithoutResponse: properties.includes("writewithoutresponse"),
    canNotify: properties.includes("notify"),
    canIndicate: properties.includes("indicate"),
    notifying: false,
  };
}

function serviceRecord(service) {
  const characteristics = Array.isArray(service?.characteristics) ? service.characteristics : [];
  return {
    uuid: uuid(service?.uuid),
    characteristics: characteristics.map(characteristicRecord),
  };
}

function inventory(peripheral, discovered) {
  const services = Array.isArray(discovered?.services)
    ? discovered.services
    : Array.isArray(peripheral?.services) ? peripheral.services : [];
  return services.map(serviceRecord).filter(service => service.uuid);
}

function findCharacteristic(peripheral, serviceUuid, characteristicUuid) {
  const serviceKey = uuid(serviceUuid);
  const characteristicKey = uuid(characteristicUuid);
  const services = Array.isArray(peripheral?.services) ? peripheral.services : [];
  const service = services.find(candidate => uuid(candidate?.uuid) === serviceKey);
  const characteristics = Array.isArray(service?.characteristics) ? service.characteristics : [];
  const characteristic = characteristics.find(candidate => uuid(candidate?.uuid) === characteristicKey);
  if (!characteristic) throw error("hardware_not_found", `Bluetooth characteristic was not discovered: ${characteristicUuid}`);
  return characteristic;
}

/**
 * Create the native transport around an already loaded Noble instance.
 * `emit` receives native event packets (`{event:{streamId,data|error}}`).
 */
export function createNobleBluetoothTransport(noble, emit = () => {}, options = {}) {
  if (!noble || typeof noble !== "object") throw new TypeError("noble instance is required");
  const timeoutMs = Math.max(1_000, Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 120_000));
  const scopes = new Map();
  const retiredScopes = new Set();
  let activeScan = null;
  let disposed = false;

  function scopeOf(id, create = true) {
    const key = text(id, "legacy");
    if (retiredScopes.has(key)) throw error("hardware_bluetooth_disconnected", "Bluetooth scope was disposed");
    let scope = scopes.get(key);
    if (!scope && create) {
      scope = { sessionId: key, generation: 0, devices: new Set(), peripherals: new Map(), streams: new Map() };
      scopes.set(key, scope);
    }
    return scope;
  }

  function assertScopeAlive(sessionId, scope, generation = scope.generation) {
    const key = text(sessionId, "legacy");
    if (disposed || retiredScopes.has(key) || scopes.get(key) !== scope || scope.generation !== generation) {
      throw error("hardware_bluetooth_disconnected", "Bluetooth scope was disposed");
    }
  }

  function assertDevice(params) {
    const scope = scopeOf(params?.sessionId);
    const id = text(params?.deviceId || params?.device);
    if (!id || !scope.devices.has(id) || !scope.peripherals.has(id)) throw error("hardware_not_found", "device was not discovered by this preview scope");
    const peripheral = scope.peripherals.get(id);
    if (peripheral.__pocketOwner && peripheral.__pocketOwner !== text(params?.sessionId, "legacy")) throw error("hardware_owner_mismatch", "device is owned by another hardware session");
    return { scope, id, peripheral };
  }

  function writeEvent(streamId, data, cause) {
    const packet = { streamId };
    if (cause) packet.error = { code: cause.code || "hardware_bluetooth_error", message: cause.message || String(cause) };
    else packet.data = data;
    try { emit({ event: packet }); } catch { /* transport output must not break BLE cleanup */ }
  }

  async function stopStream(scope, streamId) {
    const stream = scope.streams.get(streamId);
    if (!stream) return;
    scope.streams.delete(streamId);
    stream.characteristic.removeListener?.("data", stream.listener);
    try {
      await asyncOperation(stream.characteristic, "unsubscribeAsync", [], timeoutMs);
    } catch { /* disconnection/unsubscribe races are terminal */ }
    try { stream.characteristic.removeListener?.("data", stream.listener); } catch { /* ignore */ }
  }

  async function disconnectPeripheral(scope, peripheral) {
    for (const streamId of [...scope.streams.keys()]) {
      const stream = scope.streams.get(streamId);
      if (stream?.peripheral === peripheral) await stopStream(scope, streamId);
    }
    if (peripheral.__pocketOwner !== scope.sessionId) return;
    try {
      await asyncOperation(peripheral, "disconnectAsync", [], timeoutMs);
    } catch { /* teardown is best effort */ }
    peripheral.__pocketOwner = null;
    detachDisconnect(peripheral);
  }

  function detachDisconnect(peripheral) {
    const entry = peripheral.__pocketDisconnectEntry;
    if (!entry) return;
    try { peripheral.removeListener?.("disconnect", entry.listener); } catch { /* ignore */ }
    delete peripheral.__pocketDisconnectEntry;
  }

  function attachDisconnect(peripheral, scope) {
    detachDisconnect(peripheral);
    const entry = { scope };
    entry.listener = () => {
      if (peripheral.__pocketDisconnectEntry !== entry) return;
      for (const [streamId, stream] of [...scope.streams]) {
        if (stream.peripheral !== peripheral) continue;
        scope.streams.delete(streamId);
        try { stream.characteristic.removeListener?.("data", stream.listener); } catch { /* ignore */ }
        writeEvent(streamId, null, error("hardware_bluetooth_disconnected", "Bluetooth peripheral disconnected"));
      }
      peripheral.__pocketOwner = null;
      detachDisconnect(peripheral);
    };
    peripheral.__pocketDisconnectEntry = entry;
    peripheral.on?.("disconnect", entry.listener);
  }

  async function waitPowered() {
    const current = String(noble.state || "");
    if (current === "poweredOn") return;
    if (current === "poweredOff" || current === "unsupported") {
      throw error("hardware_bluetooth_unavailable", `BLE adapter state: ${current}`);
    }
    await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (cause) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        noble.removeListener?.("stateChange", onState);
        if (cause) reject(cause); else resolve();
      };
      const onState = state => {
        if (state === "poweredOn") finish();
        else if (state === "poweredOff" || state === "unsupported") finish(error("hardware_bluetooth_unavailable", `BLE adapter state: ${state}`));
      };
      const timer = setTimeout(() => finish(error("hardware_bluetooth_timeout", "Timed out waiting for Bluetooth adapter")), timeoutMs);
      noble.on?.("stateChange", onState);
      const afterAttach = String(noble.state || "");
      if (afterAttach === "poweredOn") finish();
      else if (afterAttach === "poweredOff" || afterAttach === "unsupported") finish(error("hardware_bluetooth_unavailable", `BLE adapter state: ${afterAttach}`));
    });
  }

  async function scan(params) {
    if (activeScan) throw error("hardware_busy", "Bluetooth scan is already running");
    await waitPowered();
    if (activeScan) throw error("hardware_busy", "Bluetooth scan is already running");
    if (disposed) throw error("hardware_bluetooth_disconnected", "Bluetooth transport is disposed");
    const sessionId = text(params?.sessionId, "legacy");
    const scope = scopeOf(sessionId);
    const generation = scope.generation;
    const found = new Map();
    const duration = Math.max(MIN_SCAN_MS, Math.min(MAX_SCAN_MS, Number(params?.timeoutMs) || 5_000));
    const onDiscover = peripheral => {
      if (disposed || retiredScopes.has(sessionId) || scopes.get(sessionId) !== scope || scope.generation !== generation || activeScan?.generation !== generation) return;
      const id = peripheralId(peripheral);
      if (!id) return;
      found.set(id, peripheral);
    };
    let resolveDuration;
    let rejectDuration;
    const durationPromise = new Promise((resolve, reject) => {
      resolveDuration = resolve;
      rejectDuration = reject;
    });
    const durationTimer = setTimeout(resolveDuration, duration);
    activeScan = {
      onDiscover,
      sessionId,
      scope,
      generation,
      cancel: reason => {
        clearTimeout(durationTimer);
        rejectDuration(reason);
      },
    };
    noble.on?.("discover", onDiscover);
    try {
      await asyncOperation(noble, "startScanningAsync", [[], false], timeoutMs);
      await durationPromise;
      assertScopeAlive(sessionId, scope, generation);
      const result = [];
      scope.devices.clear();
      scope.peripherals.clear();
      for (const peripheral of found.values()) {
        const id = peripheralId(peripheral);
        scope.devices.add(id);
        scope.peripherals.set(id, peripheral);
        result.push(advertisement(peripheral));
      }
      return { ok: true, realBle: true, state: "poweredOn", devices: result };
    } finally {
      clearTimeout(durationTimer);
      noble.removeListener?.("discover", onDiscover);
      try {
        await asyncOperation(noble, "stopScanningAsync", [], timeoutMs);
      } catch { /* scan cleanup must not mask the scan result */ }
      if (activeScan?.generation === generation && activeScan.scope === scope) activeScan = null;
    }
  }

  async function connect(params) {
    const { scope, id, peripheral } = assertDevice(params);
    const sessionId = text(params?.sessionId, "legacy");
    const generation = scope.generation;
    const ensureAlive = () => assertScopeAlive(sessionId, scope, generation);
    if (!peripheral.__pocketOwner) {
      try {
        await asyncOperation(peripheral, "connectAsync", [], timeoutMs, () => peripheral.disconnectAsync?.());
        ensureAlive();
        const discovered = await asyncOperation(peripheral, "discoverAllServicesAndCharacteristicsAsync", [], timeoutMs, () => peripheral.disconnectAsync?.());
        ensureAlive();
        const services = Array.isArray(discovered?.services) ? discovered.services : Array.isArray(peripheral.services) ? peripheral.services : [];
        peripheral.services = services;
        peripheral.__pocketOwner = sessionId;
        attachDisconnect(peripheral, scope);
      } catch (cause) {
        try { await asyncOperation(peripheral, "disconnectAsync", [], Math.min(timeoutMs, 5_000)); } catch { /* late connect cleanup */ }
        throw cause;
      }
    }
    ensureAlive();
    return { ok: true, realBle: true, device: id, state: "connected", services: inventory(peripheral, { services: peripheral.services }), serviceUuids: peripheral.services.map(service => uuid(service.uuid)) };
  }

  async function read(params) {
    const { peripheral } = assertDevice(params);
    const characteristic = findCharacteristic(peripheral, params.serviceUuid, params.characteristicUuid);
    const value = await asyncOperation(characteristic, "readAsync", [], timeoutMs);
    return { ok: true, realBle: true, value: bytes(value) };
  }

  async function write(params) {
    const { peripheral } = assertDevice(params);
    const characteristic = findCharacteristic(peripheral, params.serviceUuid, params.characteristicUuid);
    const value = Buffer.from(bytes(params.value));
    const withResponse = params.withResponse !== false;
    await asyncOperation(characteristic, "writeAsync", [value, !withResponse], timeoutMs);
    return { ok: true, realBle: true, bytesWritten: value.length, written: true, withResponse };
  }

  async function startStream(params) {
    const { scope, id, peripheral } = assertDevice(params);
    const streamId = text(params.streamId);
    if (!streamId) throw error("invalid_argument", "streamId must not be empty");
    if (scope.streams.has(streamId)) throw error("hardware_busy", "Bluetooth notification stream is already running");
    const generation = scope.generation;
    const characteristic = findCharacteristic(peripheral, params.serviceUuid, params.characteristicUuid);
    const properties = propertyNames(characteristic).map(value => value.toLowerCase());
    if (!properties.includes("notify") && !properties.includes("indicate")) throw error("hardware_unsupported", "BLE characteristic does not support notifications or indications");
    const listener = (value, isNotification) => {
      if (isNotification !== true || !scope.streams.has(streamId) || retiredScopes.has(scope.sessionId) || disposed) return;
      writeEvent(streamId, { realBle: true, device: id, deviceId: id, serviceUuid: uuid(params.serviceUuid), characteristicUuid: uuid(params.characteristicUuid), value: bytes(value), timestampMs: Date.now() });
    };
    // Register before subscribe so an immediate first notification cannot be lost.
    characteristic.on?.("data", listener);
    scope.streams.set(streamId, { streamId, peripheral, characteristic, listener });
    try {
      await asyncOperation(characteristic, "subscribeAsync", [], timeoutMs);
      assertScopeAlive(scope.sessionId, scope, generation);
      if (!scope.streams.has(streamId)) throw error("hardware_bluetooth_disconnected", "Bluetooth stream was cancelled");
    } catch (cause) {
      scope.streams.delete(streamId);
      try { characteristic.removeListener?.("data", listener); } catch { /* ignore */ }
      throw cause;
    }
    return { ok: true, realBle: true, streamId, kind: "ble.notifications" };
  }

  async function disposeSession(params) {
    const sessionId = text(params?.sessionId, "legacy");
    const scope = scopes.get(sessionId);
    const scan = activeScan?.sessionId === sessionId ? activeScan : null;
    retiredScopes.add(sessionId);
    if (scope) { scope.generation += 1; scopes.delete(sessionId); }
    if (scan) {
      scan.cancel(error("hardware_bluetooth_disconnected", "Bluetooth scope was disposed"));
      noble.removeListener?.("discover", scan.onDiscover);
      try { await asyncOperation(noble, "stopScanningAsync", [], timeoutMs); } catch { /* scan cleanup */ }
      if (activeScan === scan) activeScan = null;
    }
    if (!scope) return { ok: true, realBle: true, disposed: true };
    for (const streamId of [...scope.streams.keys()]) await stopStream(scope, streamId);
    for (const peripheral of new Set(scope.peripherals.values())) {
      if (peripheral.__pocketOwner === sessionId) await disconnectPeripheral(scope, peripheral);
    }
    return { ok: true, realBle: true, disposed: true };
  }

  async function handle(request) {
    if (disposed) throw error("hardware_bluetooth_disconnected", "Bluetooth transport is disposed");
    const method = text(request?.method);
    if (method === "requestBlePermission") {
      throw error("hardware_unsupported", "Noble has no explicit permission request API; the operating system handles access during Bluetooth operations");
    }
    if (method === "startBleScan") return scan(request.params);
    if (method === "connectBleDevice") return connect(request.params);
    if (method === "readBleCharacteristic") return read(request.params);
    if (method === "writeBleCharacteristic") return write(request.params);
    if (method === "startHardwareStream") return startStream(request.params);
    if (method === "stopHardwareStream") {
      const scope = scopeOf(request.params?.sessionId, false);
      if (!scope) return { ok: true, realBle: true, stopped: true };
      await stopStream(scope, text(request.params?.streamId));
      return { ok: true, realBle: true, stopped: true };
    }
    if (method === "disposeSession") return disposeSession(request.params);
    throw error("hardware_unsupported", `Unsupported Bluetooth helper method: ${method}`);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    const scan = activeScan;
    if (scan) {
      scan.cancel(error("hardware_bluetooth_disconnected", "Bluetooth transport was disposed"));
      noble.removeListener?.("discover", scan.onDiscover);
      try { await asyncOperation(noble, "stopScanningAsync", [], timeoutMs); } catch { /* ignore */ }
      if (activeScan === scan) activeScan = null;
    }
    for (const sessionId of [...scopes.keys()]) {
      await disposeSession({ sessionId });
    }
  }

  return { handle, dispose };
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const require = createRequire(import.meta.url);
  let noble;
  try {
    if (process.platform === "linux") throw new Error("unsupported: Linux Preview 尚未提供经过验收的 HCI 原生绑定；不会回退到本机编译。");
    const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    Object.assign(process.env, nativeBindingEnvironment(resolvePrebuiltTools(sdkRoot)));
    noble = require("@abandonware/noble");
  } catch (cause) {
    process.stderr.write(`Unable to load @abandonware/noble: ${cause?.message || cause}\n`);
    process.exitCode = 1;
  }
  if (noble) {
    const emit = packet => process.stdout.write(`${JSON.stringify(packet)}\n`);
    const transport = createNobleBluetoothTransport(noble, emit);
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await transport.dispose();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", line => {
      if (!line.trim() || shuttingDown) return;
      let request;
      try { request = JSON.parse(line); } catch {
        emit({ id: "", result: { ok: false, errorCode: "invalid_argument", error: "invalid JSON request" } });
        return;
      }
      Promise.resolve(transport.handle(request)).then(result => emit({ id: request.id, result }), cause => {
        const failure = nativeError(cause);
        emit({ id: request.id, result: { ok: false, errorCode: failure.code, error: failure.message } });
      });
    });
    lines.once("close", shutdown);
  }
}
