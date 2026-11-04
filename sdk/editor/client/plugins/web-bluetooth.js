/*
 * Optional Web Bluetooth adapter for the browser preview.
 *
 * The adapter intentionally speaks the existing Pocket hardware capability
 * protocol. It does not emulate a native result: every successful value comes
 * from the Web Bluetooth GATT object selected by the user. The parent preview
 * owns admission and calls `handle` only when this plugin has been enabled.
 */
(function installPocketWebBluetooth(global) {
  "use strict";

  const REQUEST_CAPABILITIES = new Set([
    "hardware.permissions.request",
    "hardware.bluetooth.scan",
    "hardware.bluetooth.connect",
    "hardware.bluetooth.read",
    "hardware.bluetooth.write",
  ]);
  const NOTIFICATION_TOPIC = "hardware.bluetooth.notifications";
  const MAX_WRITE_BYTES = 512;
  const MAX_PENDING = 8;
  const CHOOSER_TIMEOUT_MS = 120_000;

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function text(value) {
    return typeof value === "string" ? value : "";
  }

  function errorShape(code, message, details) {
    return { code, message, ...(details && typeof details === "object" ? { details } : {}) };
  }

  function errorCode(error) {
    const name = text(error?.name);
    if (name === "NotAllowedError" || name === "SecurityError") return "hardware_permission_denied";
    if (name === "NotSupportedError") return "hardware_unsupported";
    if (name === "NotFoundError") return "hardware_not_found";
    if (name === "NetworkError") return "hardware_bluetooth_unavailable";
    return "hardware_bluetooth_error";
  }

  function errorMessage(error, fallback = "Web Bluetooth operation failed") {
    return text(error?.message) || fallback;
  }

  function bytes(value, field = "value", max = MAX_WRITE_BYTES) {
    if (!Array.isArray(value) || value.length > max) {
      throw Object.assign(new Error(`${field} must contain at most ${max} bytes`), { code: "invalid_argument" });
    }
    const result = value.map((part) => Number(part));
    if (!result.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      throw Object.assign(new Error(`${field} must contain only bytes from 0 to 255`), { code: "invalid_argument" });
    }
    return result;
  }

  function uuidList(value, field) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw Object.assign(new Error(`${field} must be an array`), { code: "invalid_argument" });
    const list = value.map((entry) => {
      if (typeof entry !== "string" && typeof entry !== "number") {
        throw Object.assign(new Error(`${field} contains an invalid UUID`), { code: "invalid_argument" });
      }
      const result = String(entry).trim();
      if (!result) throw Object.assign(new Error(`${field} contains an empty UUID`), { code: "invalid_argument" });
      return result;
    });
    return [...new Set(list)];
  }

  function selector(params) {
    const value = object(params);
    const deviceId = text(value.deviceId || value.device);
    const serviceUuid = text(value.serviceUuid || value.service);
    const characteristicUuid = text(value.characteristicUuid || value.characteristic);
    if (!deviceId) throw Object.assign(new Error("deviceId must not be empty"), { code: "invalid_argument" });
    if (!serviceUuid) throw Object.assign(new Error("serviceUuid must not be empty"), { code: "invalid_argument" });
    if (!characteristicUuid) throw Object.assign(new Error("characteristicUuid must not be empty"), { code: "invalid_argument" });
    return { deviceId, serviceUuid, characteristicUuid };
  }

  function resultDevice(device) {
    return { id: text(device?.id), name: text(device?.name) || "Unnamed device" };
  }

  function characteristicInventory(characteristic) {
    const properties = object(characteristic?.properties);
    return {
      uuid: text(characteristic?.uuid),
      canRead: properties.read === true,
      canWrite: properties.write === true,
      canWriteWithoutResponse: properties.writeWithoutResponse === true,
      canNotify: properties.notify === true,
      canIndicate: properties.indicate === true,
    };
  }

  function servicesFor(params) {
    const value = object(params);
    return uuidList(value.services || value.serviceUuids, "services");
  }

  function optionalServicesFor(params) {
    const value = object(params);
    const fromParams = uuidList(value.optionalServices, "optionalServices");
    return [...new Set([...fromParams, ...servicesFor(params)])];
  }

  function filterList(params) {
    const value = object(params);
    if (value.filters === undefined) return [];
    if (!Array.isArray(value.filters)) throw Object.assign(new Error("filters must be an array"), { code: "invalid_argument" });
    return value.filters.map((filter) => {
      const record = object(filter);
      if (typeof filter !== "object" || Array.isArray(filter)) {
        throw Object.assign(new Error("filters contains an invalid entry"), { code: "invalid_argument" });
      }
      const copy = {};
      for (const key of ["name", "namePrefix", "manufacturerData", "serviceData"]) {
        if (record[key] !== undefined) copy[key] = record[key];
      }
      if (record.services !== undefined) copy.services = uuidList(record.services, "filters.services");
      return copy;
    });
  }

  function create(options = {}) {
    const send = typeof options.send === "function" ? options.send : () => {};
    const document = options.document === undefined ? global.document : options.document;
    const bluetooth = options.bluetooth === undefined ? global.navigator?.bluetooth : options.bluetooth;
    const secure = options.isSecureContext === undefined ? global.isSecureContext !== false : options.isSecureContext !== false;
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const scopes = new Map();
    const pending = new Map();
    let disposed = false;

    function keyFor(packet) {
      return text(packet?.scope) || "default";
    }

    function scopeFor(packet) {
      const key = keyFor(packet);
      let context = scopes.get(key);
      if (!context) {
        context = { key, scope: text(packet?.scope) || "default", devices: new Map(), streams: new Map(), disposed: false };
        scopes.set(key, context);
      }
      return context;
    }

    function emit(token, message) {
      if (disposed) return;
      try { send(token, message); } catch { /* parent transport owns diagnostics */ }
    }

    function respond(packet, ok, value, error) {
      const payload = {
        requestId: text(packet?.requestId),
        capability: text(packet?.capability),
        ok,
        ...(ok ? { result: value === undefined ? null : value } : { error }),
      };
      emit(text(packet?.token), { type: "event", name: "host.response", payload });
    }

    function streamMessage(context, name, streamId, payload, token) {
      const stream = context.streams.get(streamId);
      const body = name === "stream.data" ? { streamId, data: payload || {} } : { streamId, ...(payload || {}) };
      emit(text(token || stream?.token), { type: "event", name, payload: body });
    }

    function ensureAvailable() {
      if (!secure) throw Object.assign(new Error("Web Bluetooth requires a secure context"), { code: "hardware_unsupported" });
      if (!bluetooth || typeof bluetooth.requestDevice !== "function") {
        throw Object.assign(new Error("Web Bluetooth is unavailable in this browser"), { code: "hardware_unsupported" });
      }
    }

    function browserError(error, fallback) {
      const code = text(error?.code) || errorCode(error);
      return errorShape(code, errorMessage(error, fallback));
    }

    function removeChooser(entry) {
      if (!entry) return;
      clearTimeout(entry.timer);
      try { entry.button?.removeEventListener("click", entry.onChoose); } catch {}
      try { entry.cancel?.removeEventListener("click", entry.onCancel); } catch {}
      try { entry.input?.removeEventListener("keydown", entry.onKeyDown); } catch {}
      try { entry.root?.remove(); } catch {}
      pending.delete(entry.key);
    }

    function chooser(context, params, purpose = "scan") {
      ensureAvailable();
      if (!document?.createElement || !document.body?.appendChild) {
        throw Object.assign(new Error("Web Bluetooth needs a browser document to show its chooser"), { code: "hardware_unsupported" });
      }
      const old = pending.get(context.key);
      if (old) throw Object.assign(new Error("Bluetooth device selection is already pending"), { code: "hardware_busy" });
      if (pending.size >= MAX_PENDING) throw Object.assign(new Error("Too many Bluetooth operations are pending"), { code: "hardware_busy" });
      const root = document.createElement("div");
      const title = document.createElement("strong");
      const hint = document.createElement("p");
      const advanced = document.createElement("details");
      const advancedSummary = document.createElement("summary");
      const input = document.createElement("input");
      const button = document.createElement("button");
      const cancel = document.createElement("button");
      title.textContent = purpose === "permission" ? "Authorize a Bluetooth device" : "Choose a Bluetooth device";
      hint.textContent = purpose === "permission"
        ? "Chrome will ask you to choose one device. This grants access to that device for this preview, not to every nearby device."
        : "Choose a device in Chrome. The app can list only devices you authorize for this preview.";
      advancedSummary.textContent = "Advanced: optional services";
      advanced.append(advancedSummary);
      input.value = optionalServicesFor(params).join(", ");
      input.placeholder = "Optional service UUIDs";
      input.setAttribute("aria-label", "Optional Bluetooth service UUIDs");
      button.textContent = "Choose device";
      cancel.textContent = "Cancel";
      root.dataset.pocketWebBluetoothChooser = "";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "Choose a Bluetooth device");
      root.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483000;display:grid;gap:8px;width:min(360px,calc(100vw - 32px));padding:14px;border:1px solid #46618f;border-radius:10px;background:#101827;color:#eff4ff;box-shadow:0 12px 36px rgba(0,0,0,.35);font:12px system-ui,sans-serif";
      input.style.cssText = "width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #344766;border-radius:6px;background:#0b0e14;color:inherit";
      button.style.cssText = "padding:7px 10px;border:1px solid #46618f;border-radius:6px;background:#192941;color:inherit;cursor:pointer";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px";
      actions.append(button, cancel);
      advanced.append(input);
      root.append(title, hint, advanced, actions);
      document.body.appendChild(root);
      let settled = false;
      let resolvePromise;
      let rejectPromise;
      const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
      const entry = { key: context.key, root, input, button, cancel, timer: undefined, onChoose: undefined, onCancel: undefined, onKeyDown: undefined };
      const settle = (error, device) => {
        if (settled) {
          // requestDevice() may resolve after the chooser was cancelled or
          // its scope was disposed. Never let that late device become usable
          // by a future scope; disconnect it immediately instead.
          if (device?.gatt?.disconnect) {
            try { device.gatt.disconnect(); } catch {}
          }
          return;
        }
        settled = true;
        removeChooser(entry);
        if (error) rejectPromise(error); else resolvePromise(device);
      };
      entry.onChoose = () => {
        // Keep requestDevice in this click handler. Awaiting another promise
        // before this call would lose the browser's transient activation.
        if (button.disabled) return;
        button.disabled = true;
        let request;
        try {
          const services = input.value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
          const filters = filterList(params);
          const requestOptions = { ...(filters.length ? { filters } : { acceptAllDevices: true }), ...(services.length ? { optionalServices: services } : {}) };
          request = bluetooth.requestDevice(requestOptions);
        } catch (error) {
          settle(error);
          return;
        }
        Promise.resolve(request).then((device) => settle(null, device), (error) => settle(error));
      };
      entry.onCancel = () => settle(Object.assign(new Error("Bluetooth device selection was cancelled"), { code: "hardware_not_found" }));
      entry.onKeyDown = (event) => { if (event?.key === "Escape") entry.onCancel(); };
      button.addEventListener("click", entry.onChoose);
      cancel.addEventListener("click", entry.onCancel);
      input.addEventListener("keydown", entry.onKeyDown);
      entry.timer = setTimeout(() => settle(Object.assign(new Error("Bluetooth device selection timed out. Request access again and click Choose device."), { code: "hardware_bluetooth_error" })), CHOOSER_TIMEOUT_MS);
      pending.set(context.key, entry);
      return promise;
    }

    async function selectedDevice(context, params) {
      const id = text(object(params).deviceId || object(params).device);
      if (!id) throw Object.assign(new Error("deviceId must not be empty"), { code: "invalid_argument" });
      const state = context.devices.get(id);
      if (!state?.device) throw Object.assign(new Error("device was not selected by this preview"), { code: "hardware_not_found" });
      return state;
    }

    function authorizedDevices(context) {
      const devices = [];
      const seen = new Set();
      for (const state of context.devices.values()) {
        const device = state?.device;
        const id = text(device?.id);
        if (!device || !id || seen.has(id)) continue;
        seen.add(id);
        devices.push(device);
      }
      return devices;
    }

    function scanResult(devices, scanMode) {
      return {
        ok: true,
        realBle: true,
        source: "web-bluetooth",
        scanMode,
        state: scanMode === "authorized-devices" ? "authorized" : "poweredOn",
        devices: devices.map(resultDevice),
      };
    }

    async function disconnectState(context, state, code = "hardware_bluetooth_disconnected", message = "Bluetooth device disconnected") {
      if (!state || state.closed) return;
      state.closed = true;
      for (const streamId of [...state.streams]) await closeStream(context, streamId, code, message);
      if (state.listener) {
        try { state.device.removeEventListener("gattserverdisconnected", state.listener); } catch {}
      }
      try { if (state.server?.connected) state.device.gatt.disconnect(); } catch {}
      state.server = null;
    }

    async function connectDevice(context, params) {
      const state = await selectedDevice(context, params);
      if (state.server?.connected && !state.closed) return { state, result: state.inventoryResult };
      state.closed = false;
      const device = state.device;
      if (!device.gatt || typeof device.gatt.connect !== "function") throw Object.assign(new Error("Bluetooth GATT is unavailable"), { code: "hardware_bluetooth_unavailable" });
      state.server = await device.gatt.connect();
      if (disposed || context.disposed) {
        try { device.gatt.disconnect?.(); } catch {}
        throw Object.assign(new Error("Bluetooth scope was disposed while connecting"), { code: "hardware_bluetooth_disconnected" });
      }
      state.listener = () => { void disconnectState(context, state); };
      try { device.addEventListener?.("gattserverdisconnected", state.listener); } catch {}
      const serviceUuids = servicesFor(params);
      const services = serviceUuids.length
        ? (await Promise.all(serviceUuids.map((uuid) => state.server.getPrimaryService(uuid))))
        : await state.server.getPrimaryServices();
      if (disposed || context.disposed) {
        try { device.gatt.disconnect?.(); } catch {}
        throw Object.assign(new Error("Bluetooth scope was disposed while discovering services"), { code: "hardware_bluetooth_disconnected" });
      }
      state.services.clear();
      const inventory = [];
      for (const service of services || []) {
        const characteristics = typeof service.getCharacteristics === "function" ? await service.getCharacteristics() : [];
        if (disposed || context.disposed) {
          try { device.gatt.disconnect?.(); } catch {}
          throw Object.assign(new Error("Bluetooth scope was disposed while discovering characteristics"), { code: "hardware_bluetooth_disconnected" });
        }
        const records = characteristics.map((characteristic) => {
          state.services.set(`${service.uuid}\u0000${characteristic.uuid}`, characteristic);
          return characteristicInventory(characteristic);
        });
        inventory.push({ uuid: text(service.uuid), characteristics: records });
      }
      state.inventoryResult = { ok: true, realBle: true, source: "web-bluetooth", device: text(device.id), state: "connected", services: inventory, serviceUuids: inventory.map((entry) => entry.uuid) };
      return { state, result: state.inventoryResult };
    }

    async function characteristicFor(context, params) {
      const selected = selector(params);
      let state = await selectedDevice(context, selected);
      if (!state.server?.connected || state.closed) ({ state } = await connectDevice(context, selected));
      const key = `${selected.serviceUuid}\u0000${selected.characteristicUuid}`;
      let characteristic = state.services.get(key);
      if (!characteristic) {
        const service = await state.server.getPrimaryService(selected.serviceUuid);
        characteristic = await service.getCharacteristic(selected.characteristicUuid);
        if (disposed || context.disposed) {
          try { state.device.gatt?.disconnect?.(); } catch {}
          throw Object.assign(new Error("Bluetooth scope was disposed while resolving characteristic"), { code: "hardware_bluetooth_disconnected" });
        }
        state.services.set(key, characteristic);
      }
      return { selected, state, characteristic };
    }

    async function request(context, packet) {
      const capability = text(packet.capability);
      const params = object(packet.params);
      if (!REQUEST_CAPABILITIES.has(capability)) throw Object.assign(new Error(`unsupported Web Bluetooth capability: ${capability}`), { code: "hardware_unsupported" });
      ensureAvailable();
      const permissionRequest = capability === "hardware.permissions.request";
      if (permissionRequest || capability === "hardware.bluetooth.scan") {
        if (permissionRequest && text(params.permission) !== "hardware.bluetooth") {
          throw Object.assign(new Error("unsupported Web Bluetooth permission"), { code: "hardware_unsupported" });
        }
        const authorized = permissionRequest ? [] : authorizedDevices(context);
        if (authorized.length) return scanResult(authorized, "authorized-devices");
        const device = await chooser(context, params, permissionRequest ? "permission" : "scan");
        const state = { device, server: null, services: new Map(), streams: new Set(), listener: undefined, closed: false };
        if (!context.devices.has(text(device.id))) context.devices.set(text(device.id), state);
        if (permissionRequest) return { ok: true, permission: "hardware.bluetooth", status: "granted", granted: true, runtimePermissionRequired: false, realHardware: true };
        return scanResult([device], "chooser");
      }
      if (capability === "hardware.bluetooth.connect") return (await connectDevice(context, params)).result;
      const { selected, state, characteristic } = await characteristicFor(context, params);
      if (capability === "hardware.bluetooth.read") {
        const value = await characteristic.readValue();
        return { ok: true, realBle: true, source: "web-bluetooth", device: selected.deviceId, deviceId: selected.deviceId, serviceUuid: selected.serviceUuid, characteristicUuid: selected.characteristicUuid, value: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)), bytesRead: value.byteLength };
      }
      const value = bytes(params.value);
      if (params.withResponse === false) {
        if (typeof characteristic.writeValueWithoutResponse !== "function") throw Object.assign(new Error("characteristic does not support write without response"), { code: "hardware_bluetooth_characteristic" });
        await characteristic.writeValueWithoutResponse(new Uint8Array(value));
      } else {
        if (typeof characteristic.writeValueWithResponse === "function") await characteristic.writeValueWithResponse(new Uint8Array(value));
        else if (typeof characteristic.writeValue === "function") await characteristic.writeValue(new Uint8Array(value));
        else throw Object.assign(new Error("characteristic does not support write"), { code: "hardware_bluetooth_characteristic" });
      }
      return { ok: true, realBle: true, source: "web-bluetooth", device: selected.deviceId, deviceId: selected.deviceId, serviceUuid: selected.serviceUuid, characteristicUuid: selected.characteristicUuid, written: true, bytesWritten: value.length, withResponse: params.withResponse !== false };
    }

    async function openStream(context, packet) {
      ensureAvailable();
      const streamId = text(packet.streamId);
      if (!streamId) throw Object.assign(new Error("streamId must not be empty"), { code: "invalid_argument" });
      if (context.streams.has(streamId)) throw Object.assign(new Error("Bluetooth stream is already open"), { code: "hardware_busy" });
      const topic = text(packet.topic || packet.capability);
      // The preview server already routes this plugin's stream requests by
      // capability and therefore omits the topic from its compact packet.
      if (topic && topic !== NOTIFICATION_TOPIC) throw Object.assign(new Error("unsupported Bluetooth stream topic"), { code: "hardware_unsupported" });
      const { selected, state, characteristic } = await characteristicFor(context, packet.params);
      if (!(characteristic.properties?.notify || characteristic.properties?.indicate)) throw Object.assign(new Error("selected characteristic is not notifiable"), { code: "hardware_bluetooth_characteristic" });
      for (const existing of context.streams.values()) {
        if (existing.selected.deviceId === selected.deviceId &&
            existing.selected.serviceUuid === selected.serviceUuid &&
            existing.selected.characteristicUuid === selected.characteristicUuid) {
          throw Object.assign(new Error("Bluetooth notifications are already subscribed for this characteristic"), { code: "hardware_busy" });
        }
      }
      const stream = { context, streamId, token: text(packet.token), state, selected, characteristic, closed: false, listener: undefined };
      stream.listener = (event) => {
        if (stream.closed || disposed || context.disposed) return;
        const value = event?.target?.value;
        if (!value) return;
        streamMessage(context, "stream.data", streamId, { realBle: true, source: "web-bluetooth", device: selected.deviceId, deviceId: selected.deviceId, serviceUuid: selected.serviceUuid, characteristicUuid: selected.characteristicUuid, value: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)), timestampMs: now() }, stream.token);
      };
      context.streams.set(streamId, stream);
      state.streams.add(streamId);
      try {
        await characteristic.startNotifications();
        if (disposed || context.disposed || stream.closed) {
          try { await characteristic.stopNotifications?.(); } catch {}
          throw Object.assign(new Error("Bluetooth scope was disposed while starting notifications"), { code: "hardware_bluetooth_disconnected" });
        }
        characteristic.addEventListener("characteristicvaluechanged", stream.listener);
        streamMessage(context, "stream.open", streamId, { ok: true, result: { realBle: true, source: "web-bluetooth", state: "watching", deviceId: selected.deviceId, serviceUuid: selected.serviceUuid, characteristicUuid: selected.characteristicUuid } }, stream.token);
      } catch (error) {
        await closeStream(context, streamId, null, errorMessage(error, "Bluetooth notifications could not be started"));
        throw error;
      }
      return null;
    }

    async function closeStream(context, streamId, code = "hardware_bluetooth_disconnected", message = "Bluetooth notification stream ended") {
      const stream = context.streams.get(streamId);
      if (!stream || stream.closed) return;
      stream.closed = true;
      context.streams.delete(streamId);
      stream.state.streams.delete(streamId);
      try { stream.characteristic.removeEventListener("characteristicvaluechanged", stream.listener); } catch {}
      try { await stream.characteristic.stopNotifications?.(); } catch {}
      // The preview transport removes a stream lease after the first terminal
      // packet. Send one terminal packet only; a second packet would be stale.
      if (code && code !== "cancelled") streamMessage(context, "stream.error", streamId, { error: errorShape(code, message) }, stream.token);
    }

    async function handle(packet) {
      if (disposed || !packet || typeof packet !== "object") return false;
      const context = scopeFor(packet);
      if (context.disposed) return false;
      try {
        if (packet.kind === "request") {
          const result = await request(context, packet);
          respond(packet, true, result);
        } else if (packet.kind === "stream.open") {
          if (object(packet.params).action === "cancel") {
            await closeStream(context, text(packet.streamId), null, "Bluetooth notification stream cancelled");
          } else {
            await openStream(context, packet);
          }
        } else if (packet.kind === "stream.cancel") {
          await closeStream(context, text(packet.streamId), null, "Bluetooth notification stream cancelled");
        } else if (packet.kind === "scope.dispose") {
          await disposeContext(context);
        } else {
          throw Object.assign(new Error("unsupported Web Bluetooth packet kind"), { code: "invalid_argument" });
        }
      } catch (error) {
        if (disposed || context.disposed) return true;
        const shaped = browserError(error, "Web Bluetooth operation failed");
        if (packet.kind === "request") respond(packet, false, null, shaped);
        else emit(text(packet.token), { type: "event", name: "stream.error", payload: { streamId: text(packet.streamId), error: shaped } });
      }
      return true;
    }

    async function disposeContext(context) {
      if (!context || context.disposed) return;
      context.disposed = true;
      try { pending.get(context.key)?.onCancel?.(); } catch {}
      for (const streamId of [...context.streams]) await closeStream(context, streamId, null, "Bluetooth scope disposed");
      for (const state of context.devices.values()) await disconnectState(context, state, "cancelled", "Bluetooth scope disposed");
      scopes.delete(context.key);
    }

    async function dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of pending.values()) {
        try { entry.onCancel?.(); } catch {}
      }
      for (const context of [...scopes.values()]) await disposeContext(context);
      scopes.clear();
    }

    return { handle, dispose };
  }

  global.PocketWebBluetooth = Object.freeze({ create });
})(typeof globalThis === "object" ? globalThis : this);
