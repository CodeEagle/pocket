import { describeAttributeChanges } from "./changes.js";
import { getProductProfile, resolveProductCommands, resolveProductOperation } from "./products.js";
import { DATA_KEY, resolveDataKey, decodeAttributes, attributeSnapshot } from "./data.js";
// Adapted from SyncDo/src/renderer/dokidoki-web-bluetooth.js; see sdk/docs/tftc-migration.md.
import { parseManufacturerAdvertisement, isGattDisconnectedError, getErrorDetail, writeCharacteristicValue, SERVICE_UUID, SERVICE_SHORT_UUID, CHAR_READ, CHAR_WRITE_RESPONSE, CHAR_WRITE_NO_RESPONSE, CHAR_NOTIFY, YXL_ONE_WRITE_SERVICE_UUID, YXL_ONE_NOTIFY_SERVICE_UUID, YXL_ONE_CHAR_WRITE, YXL_ONE_CHAR_NOTIFY, CMD_APP_REQUEST, CMD_MCU_REPLY, CMD_SECURITY_CHALLENGE, CMD_SECURITY_DATA, CMD_MANUFACTURER_QUERY, CMD_MANUFACTURER_REPLY, CMD_PROTOCOL_ERROR, CMD_HEARTBEAT, YXL_ONE_CMD_WORK_CONTROL, YXL_ONE_CMD_TELESCOPIC, YXL_ONE_CMD_ROTATING, YXL_ONE_STOP_COMMAND_DELAY_MS, DEVICE_PREFIXES, DEFAULT_DEVICE_NAME, DEFAULT_MOTION_OPTIONS, GATT_CONNECT_ATTEMPTS, GATT_SERVICE_ATTEMPTS, YXL_ONE_ACK_TIMEOUT_MS, YXL_ONE_STOP_ATTEMPTS, MANUFACTURER_QUERY_TIMEOUT_MS, SECURITY_CHALLENGE_TIMEOUT_MS, STANDARD_RESPONSE_TIMEOUT_MS, ACTIONS_TO_ZERO, calculateChecksum, validateByteArray, buildProtocolFrame, parseProtocolFrame, hasValidChecksum, parseManufacturerDataPayload, reverseUint32Bytes, buildYxlOneFrame, clampPercent, rotaryToBLE, getDeviceProfile, isBluetoothUuid } from "./protocol.js";

function tftcEvent(type, init = {}) { return { type, detail: init.detail }; }

  export class TftcClient {
    constructor({ bluetooth = null, security = {}, profileForDevice = getDeviceProfile, timers = {}, now = () => Date.now() } = {}) {
      this.bluetooth = bluetooth;
      this.security = security;
      this.profileForDevice = profileForDevice;
      this.now = now;
      this.timers = {
        setTimeout: timers.setTimeout || globalThis.setTimeout?.bind(globalThis),
        clearTimeout: timers.clearTimeout || globalThis.clearTimeout?.bind(globalThis),
        setInterval: timers.setInterval || globalThis.setInterval?.bind(globalThis),
        clearInterval: timers.clearInterval || globalThis.clearInterval?.bind(globalThis),
      };
      this.listeners = new Map();
      this.messageId = 0;
      this.attributes = new Map();
      this.device = null;
      this.server = null;
      this.profile = null;
      this.manufacturerData = null;
      this.securityState = 'unknown';
      this.securitySession = null;
      this.securitySessionId = null;
      this.securitySessionGeneration = null;
      this.connectionGeneration = 0;
      this.connectionState = 'disconnected';
      this.connectionFailed = false;
      this.businessReady = false;
      this.disconnecting = false;
      this.disconnectPromise = null;
      this.connectOperation = null;
      this.pendingSecurityAuth = null;
      this.writeChar = null;
      this.writeNoRespChar = null;
      this.readChar = null;
      this.notifyChar = null;
      this.heartbeatInterval = null;
      this.lastMotionSentAt = 0;
      this.lastMotionValues = new Map();
      this.pendingYxlOneAcks = new Map();
      this.queuedYxlOneMotion = null;
      this.motionBusy = false;
      this.pauseBusy = false;
      this.motionOptions = { ...DEFAULT_MOTION_OPTIONS };
      this.yxlOneRunning = false;
      this.yxlOneMotionEpoch = 0;
      this.heartbeatSuccessLogged = false;
      this.heartbeatToken = null;
      this.writeQueue = Promise.resolve();
      this.pendingRequests = new Map();
      this.pendingManufacturerQuery = null;
      this.pendingSecurityChallenge = null;
      this.messageAssemblies = new Map();
      this.standardNotifyListener = null;
    }

    on(type, listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      const name = type.startsWith('tftc:') ? type : `tftc:${type}`;
      const listeners = this.listeners.get(name) || new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      return () => listeners.delete(listener);
    }

    dispatchEvent(event) {
      for (const listener of this.listeners.get(event.type) || []) {
        try { listener(event); } catch { /* Observers cannot interrupt protocol cleanup. */ }
      }
    }

    delay(ms) { return new Promise(resolve => this.timers.setTimeout(resolve, ms)); }

    get isSupported() {
      return Boolean(this.bluetooth);
    }

    get isConnected() {
      return Boolean(this.device && this.device.gatt && this.device.gatt.connected);
    }

    emitDiagnostic(event, detail = {}) {
      this.dispatchEvent({ type: 'tftc:diagnostic', detail: { event, detail: {
        profile: this.profile?.name || null,
        protocol: this.profile?.protocol || null,
        deviceName: this.device?.name || '',
        deviceId: this.device?.id || '',
        ...detail, at: this.now()
      } } });
    }

    emitConnectionState(state, detail = {}) {
      this.connectionState = state;
      this.dispatchEvent(
        tftcEvent('tftc:connection-state', {
          detail: {
            state,
            generation: this.connectionGeneration,
            securityState: this.securityState,
            profile: this.profile?.name || null,
            manufacturerData: this.manufacturerData
              ? {
                  cid: this.manufacturerData.cid,
                  version: this.manufacturerData.version,
                  fmsk: this.manufacturerData.fmsk,
                  productId: this.manufacturerData.productId,
                  mac: [...this.manufacturerData.mac]
                }
              : null,
            ...detail
          }
        })
      );
    }

    async connect() {
      if (!this.isSupported) {
        this.emitDiagnostic('connect_unsupported_environment');
        throw new Error('当前传输不支持蓝牙。');
      }

      if (this.connectOperation) {
        return this.connectOperation.promise;
      }

      const operationRecord = { cancelled: false, promise: null };
      const operation = (async () => {
        await this.disconnect({ skipPause: true, silent: true, internal: true }).catch(() => {});
        if (operationRecord.cancelled) {
          throw new Error('连接已失效。');
        }
        return this.connectInternal();
      })();
      const tracked = operation.finally(() => {
        if (this.connectOperation === operationRecord) {
          this.connectOperation = null;
        }
      });
      operationRecord.promise = tracked;
      this.connectOperation = operationRecord;
      return tracked;
    }

    async connectInternal() {
      this.connectionGeneration += 1;
      const generation = this.connectionGeneration;
      this.connectionFailed = false;
      this.disconnecting = false;
      this.businessReady = false;
      this.securityState = 'unknown';
      this.securitySession = null;
      this.securitySessionId = null;
      this.securitySessionGeneration = null;
      this.manufacturerData = null;
      this.pendingRequests.clear();
      this.pendingManufacturerQuery = null;
      this.pendingSecurityChallenge = null;
      this.pendingSecurityAuth = null;
      this.messageAssemblies.clear();
      this.writeQueue = Promise.resolve();
      this.messageId = 0;
      this.attributes.clear();
      this.emitConnectionState('connecting');
      this.emitDiagnostic('connect_request_device_start', {
        prefixes: DEVICE_PREFIXES,
        optionalServices: [SERVICE_UUID, YXL_ONE_WRITE_SERVICE_UUID, YXL_ONE_NOTIFY_SERVICE_UUID]
      });
      let requestedDevice;
      try {
        requestedDevice = await this.bluetooth.requestDevice({
        filters: DEVICE_PREFIXES.map((namePrefix) => ({ namePrefix })),
        optionalServices: [SERVICE_UUID, YXL_ONE_WRITE_SERVICE_UUID, YXL_ONE_NOTIFY_SERVICE_UUID]
      });
      } catch (error) {
        if (generation === this.connectionGeneration) {
          this.connectionFailed = true;
          this.emitConnectionState('failed', { error: getErrorDetail(error) });
        }
        throw error;
      }
      if (generation !== this.connectionGeneration) {
        throw new Error('连接已失效。');
      }
      this.device = requestedDevice;
      this.emitDiagnostic('connect_request_device_success');

      this.profile = this.profileForDevice(this.device.name);
      if (!this.profile) {
        this.emitDiagnostic('connect_unsupported_profile');
        await this.disconnectInternal();
        throw new Error(`不支持的心跳DOKIDOKI设备型号：${this.device.name || 'Unknown'}`);
      }
      this.emitDiagnostic('connect_profile_resolved');

      this.device.addEventListener('gattserverdisconnected', () => {
        if (generation !== this.connectionGeneration) return;
        this.emitDiagnostic('gattserverdisconnected');
        this.handleConnectionLost('gattserverdisconnected');
      });

      try {
        const connectedServer = await this.connectGattWithRetry(generation);
        if (generation !== this.connectionGeneration) {
          throw new Error('连接已失效。');
        }
        this.server = connectedServer;
        await this.resolveCharacteristics(generation);
        if (generation !== this.connectionGeneration) {
          throw new Error('连接已失效。');
        }

        if (this.profile.protocol === 'yxlone') {
          if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
          this.securityState = 'plain';
          this.businessReady = true;
          this.emitConnectionState('ready');
        } else {
          this.emitConnectionState('identifying');
          // App initializes its security policy from the observed advertisement.
          // Older firmware has no 0x0C reply; use complete validated scan facts
          // when the transport provides them, otherwise keep the modern query.
          const manufacturerData = this.device.manufacturerData != null
            ? parseManufacturerAdvertisement(this.device.manufacturerData)
            : await this.queryManufacturerData({ generation });
          if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
          this.manufacturerData = manufacturerData;
          this.validateProfileAgainstManufacturer();
          if (this.manufacturerData.requiresSecurity) {
            await this.authenticateStandardDevice(generation);
          } else {
            this.securityState = 'plain';
          }
          if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
          this.businessReady = true;
          this.emitConnectionState('ready');
          this.startHeartbeat(generation);
        }

        return {
          name: this.device.name || DEFAULT_DEVICE_NAME,
          id: this.device.id,
          profile: this.profile.name,
          writable: Boolean(this.writeChar || this.writeNoRespChar),
          capabilities: Object.keys(this.profile.commands).filter((command) => command !== 'stop'),
          manufacturerData: this.manufacturerData,
          securityState: this.securityState
        };
      } catch (error) {
        if (generation !== this.connectionGeneration) {
          throw error;
        }
        const oldSessionId = this.securitySessionId;
        this.stopHeartbeat();
        this.connectionGeneration += 1;
        this.rejectPendingRequests(error);
        this.clearMessageAssemblies();
        this.pendingSecurityAuth = null;
        this.connectionFailed = true;
        this.securityState = 'failed';
        this.businessReady = false;
        this.emitConnectionState('failed', { error: getErrorDetail(error) });
        await this.clearSecurityBackend(oldSessionId, generation).catch(() => {});
        try {
          if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        } catch {
          // Cleanup is best effort; preserve the original connection error.
        }
        this.server = null;
        this.profile = null;
        this.manufacturerData = null;
        this.securitySession = null;
        this.securitySessionId = null;
        this.securitySessionGeneration = null;
        this.writeChar = null;
        this.writeNoRespChar = null;
        this.readChar = null;
        this.notifyChar = null;
        this.disconnecting = false;
        throw error;
      }
    }

    disconnect(options = {}) {
      const { internal = false, ...disconnectOptions } = options;
      if (!internal && this.connectOperation) {
        this.connectOperation.cancelled = true;
        this.connectOperation = null;
      }
      if (this.disconnectPromise) {
        return this.disconnectPromise;
      }
      const operation = this.disconnectInternal(disconnectOptions);
      const tracked = operation.finally(() => {
        if (this.disconnectPromise === tracked) {
          this.disconnectPromise = null;
        }
      });
      this.disconnectPromise = tracked;
      return tracked;
    }

    async disconnectInternal({ skipPause = false, silent = false } = {}) {
      this.emitDiagnostic('disconnect_start', { connected: this.isConnected });
      this.stopHeartbeat();
      const previousProfile = this.profile;
      const previousConnected = this.isConnected;
      const previousGeneration = this.connectionGeneration;
      const previousState = this.connectionState;
      const previousSessionId = this.securitySessionId;
      this.disconnecting = true;
      if (!skipPause && previousConnected && previousProfile && previousState === 'ready') {
        // Keep the old generation alive while the valid session receives its stop command. All
        // new motion writes are rejected by disconnecting; queued motion is allowed to drain only
        // until actionPause has sent the final stop sequence.
        await this.actionPause({
          allowDuringDisconnect: true,
          generation: previousGeneration
        }).catch(() => {});
      }
      this.connectionGeneration += 1;
      this.rejectPendingRequests(new Error('连接已断开。'));
      this.clearMessageAssemblies();
      this.pendingSecurityAuth = null;
      await this.clearSecurityBackend(previousSessionId, previousGeneration).catch(() => {});
      if (this.device && this.device.gatt && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
      this.server = null;
      this.profile = null;
      this.manufacturerData = null;
      this.securityState = 'unknown';
      this.securitySession = null;
      this.securitySessionId = null;
      this.securitySessionGeneration = null;
      this.writeChar = null;
      this.writeNoRespChar = null;
      this.readChar = null;
      this.notifyChar = null;
      this.lastMotionSentAt = 0;
      this.lastMotionValues.clear();
      this.clearPendingYxlOneAcks();
      this.queuedYxlOneMotion = null;
      this.pauseBusy = false;
      this.yxlOneRunning = false;
      this.yxlOneMotionEpoch += 1;
      this.heartbeatSuccessLogged = false;
      this.connectionFailed = false;
      this.businessReady = false;
      this.connectionState = 'disconnected';
      this.disconnecting = false;
      if (!silent) {
        this.emitDiagnostic('disconnect_complete');
        this.dispatchEvent(tftcEvent('tftc:disconnected'));
        this.emitConnectionState('disconnected');
      }
    }

    setMotionOptions(options = {}) {
      this.motionOptions = {
        ...this.motionOptions,
        ...options,
        maxOutput: clampPercent(options.maxOutput ?? this.motionOptions.maxOutput),
        sensitivity: Math.max(0.5, Math.min(1.5, options.sensitivity ?? this.motionOptions.sensitivity)),
        minInterval: Math.max(120, Math.min(500, Math.round(options.minInterval ?? this.motionOptions.minInterval))),
        minDelta: Math.max(1, Math.min(15, Math.round(options.minDelta ?? this.motionOptions.minDelta)))
      };
    }

    async resolveCharacteristics(generation = this.connectionGeneration) {
      if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
      this.writeChar = null;
      this.writeNoRespChar = null;
      this.readChar = null;
      this.notifyChar = null;
      if (this.profile.protocol === 'yxlone') {
        await this.resolveYxlOneCharacteristics(generation);
        return;
      }

      const service = await this.getPrimaryServiceWithRetry(SERVICE_UUID, generation);
      if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
      const characteristics = await service.getCharacteristics();
      if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
      this.emitDiagnostic('characteristics_discovered', {
        service: SERVICE_SHORT_UUID,
        count: characteristics.length,
        uuids: characteristics.map((characteristic) => characteristic.uuid)
      });
      for (const characteristic of characteristics) {
        const uuid = characteristic.uuid.toLowerCase();
        if (isBluetoothUuid(uuid, CHAR_READ)) {
          this.readChar = characteristic;
        } else if (isBluetoothUuid(uuid, CHAR_WRITE_RESPONSE)) {
          this.writeChar = characteristic;
        } else if (isBluetoothUuid(uuid, CHAR_WRITE_NO_RESPONSE)) {
          this.writeNoRespChar = characteristic;
        } else if (isBluetoothUuid(uuid, CHAR_NOTIFY)) {
          this.notifyChar = characteristic;
        }
      }

      if (!this.writeChar) {
        this.emitDiagnostic('characteristic_missing', { required: CHAR_WRITE_RESPONSE });
        throw new Error('未找到 DokiDoki 写入特征 ffb5。');
      }

      if (this.notifyChar && this.notifyChar.startNotifications) {
        const notifyCharacteristic = this.notifyChar;
        const subscribedDevice = this.device;
        try {
          await notifyCharacteristic.startNotifications();
          if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
          this.emitDiagnostic('notify_started', { uuid: notifyCharacteristic.uuid });
        } catch (error) {
          this.emitDiagnostic('notify_start_failed', {
            uuid: notifyCharacteristic.uuid,
            error: getErrorDetail(error)
          });
          throw error;
        }
        notifyCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
          if (generation !== this.connectionGeneration || this.device !== subscribedDevice ||
              this.notifyChar !== notifyCharacteristic) return;
          const value = event.target.value;
          const detail = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          if (this.profile?.protocol === 'yxlone') {
            this.handleYxlOneNotify(detail);
            this.dispatchEvent(tftcEvent('tftc:notify', { detail }));
            return;
          }
          this.handleStandardNotify(detail);
        });
      } else {
        this.emitDiagnostic('notify_unavailable', { service: SERVICE_SHORT_UUID });
        throw new Error('未找到 DokiDoki 通知特征 ffb8。');
      }
      this.emitDiagnostic('characteristics_resolved', {
        read: this.readChar?.uuid || null,
        writeWithResponse: this.writeChar?.uuid || null,
        writeWithoutResponse: this.writeNoRespChar?.uuid || null,
        notify: this.notifyChar?.uuid || null
      });
    }

    async resolveYxlOneCharacteristics(generation = this.connectionGeneration) {
      if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
      const writeService = await this.getPrimaryServiceWithRetry(YXL_ONE_WRITE_SERVICE_UUID, generation);
      if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
      const writeCharacteristics = await writeService.getCharacteristics();
      if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
      this.emitDiagnostic('characteristics_discovered', {
        service: YXL_ONE_WRITE_SERVICE_UUID,
        count: writeCharacteristics.length,
        uuids: writeCharacteristics.map((characteristic) => characteristic.uuid)
      });
      this.writeChar = writeCharacteristics.find((characteristic) => isBluetoothUuid(characteristic.uuid, YXL_ONE_CHAR_WRITE));

      try {
        const notifyService = await this.getPrimaryServiceWithRetry(YXL_ONE_NOTIFY_SERVICE_UUID, generation);
        if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
        const notifyCharacteristics = await notifyService.getCharacteristics();
        if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
        this.emitDiagnostic('characteristics_discovered', {
          service: YXL_ONE_NOTIFY_SERVICE_UUID,
          count: notifyCharacteristics.length,
          uuids: notifyCharacteristics.map((characteristic) => characteristic.uuid)
        });
        this.notifyChar = notifyCharacteristics.find((characteristic) => isBluetoothUuid(characteristic.uuid, YXL_ONE_CHAR_NOTIFY));
      } catch (error) {
        this.emitDiagnostic('notify_service_unavailable', {
          service: YXL_ONE_NOTIFY_SERVICE_UUID,
          error: getErrorDetail(error)
        });
        this.notifyChar = null;
      }
      if (generation !== this.connectionGeneration) throw new Error('连接已失效。');

      if (!this.writeChar) {
        this.emitDiagnostic('characteristic_missing', { required: YXL_ONE_CHAR_WRITE });
        throw new Error('未找到 TRYFUN-ONE 写入特征 fff1。');
      }

      if (this.notifyChar && this.notifyChar.startNotifications) {
        const notifyCharacteristic = this.notifyChar;
        const subscribedDevice = this.device;
        try {
          await notifyCharacteristic.startNotifications();
          if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
          this.emitDiagnostic('notify_started', { uuid: notifyCharacteristic.uuid });
        } catch (error) {
          this.emitDiagnostic('notify_start_failed', {
            uuid: notifyCharacteristic.uuid,
            error: getErrorDetail(error)
          });
          throw error;
        }
        notifyCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
          if (generation !== this.connectionGeneration || this.device !== subscribedDevice ||
              this.notifyChar !== notifyCharacteristic) return;
          const value = event.target.value;
          const detail = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          this.handleYxlOneNotify(detail);
          this.dispatchEvent(
            tftcEvent('tftc:notify', {
              detail
            })
          );
        });
      } else {
        this.emitDiagnostic('notify_unavailable', { service: YXL_ONE_NOTIFY_SERVICE_UUID });
      }
      this.emitDiagnostic('characteristics_resolved', {
        write: this.writeChar?.uuid || null,
        notify: this.notifyChar?.uuid || null
      });
    }

    isStandardControlCommand(command) {
      return command === CMD_SECURITY_CHALLENGE || command === CMD_SECURITY_DATA ||
        command === CMD_MANUFACTURER_QUERY || command === CMD_MANUFACTURER_REPLY ||
        command === CMD_PROTOCOL_ERROR;
    }

    isEncryptedBusinessCommand(command) {
      return !this.isStandardControlCommand(command) && !this.isOtaCommand(command);
    }

    isOtaCommand(command) {
      return command >= 0x20 && command <= 0x2f;
    }

    isSupportedBusinessCommand(command) {
      return command === 0x01 || command === CMD_MCU_REPLY || command === 0x04 ||
        command === 0x07 || command === 0x09;
    }

    allocateMessageId() {
      const reserved = new Set(this.pendingRequests.keys());
      if (this.pendingManufacturerQuery?.msgId !== undefined) {
        reserved.add(this.pendingManufacturerQuery.msgId);
      }
      if (this.pendingSecurityChallenge?.msgId !== undefined) {
        reserved.add(this.pendingSecurityChallenge.msgId);
      }
      if (this.pendingSecurityAuth?.msgId !== undefined) {
        reserved.add(this.pendingSecurityAuth.msgId);
      }
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const candidate = this.messageId = this.messageId % 15 + 1;
        if (candidate !== 0 && !reserved.has(candidate)) {
          return candidate;
        }
      }
      throw new Error('协议消息 ID 已耗尽，等待现有请求完成。');
    }

    buildBusinessFrame(cmd, value) {
      return buildProtocolFrame(CMD_APP_REQUEST, [cmd, value], {
        msgId: this.allocateMessageId(),
        includeChecksum: true
      });
    }

    buildMultiBusinessFrame(pairs) {
      return buildProtocolFrame(CMD_APP_REQUEST, pairs.flat(), {
        msgId: this.allocateMessageId(),
        includeChecksum: true
      });
    }

    async queryManufacturerData({ generation = this.connectionGeneration, timeout = MANUFACTURER_QUERY_TIMEOUT_MS } = {}) {
      try { return await this.runManufacturerQuery({ generation, timeout, legacy: false }); }
      catch (error) {
        // App tf_device_security.dart: only a modern timeout/associated unsupported reply
        // may enter legacy discovery. A known security requirement is never downgraded.
        if (!error.canFallback || this.manufacturerData?.requiresSecurity ||
            generation !== this.connectionGeneration || !this.isConnected) throw error;
        return this.runManufacturerQuery({ generation, timeout, legacy: true });
      }
    }

    async runManufacturerQuery({ generation, timeout, legacy }) {
      if (!this.profile || this.profile.protocol === 'yxlone') {
        throw new Error('当前设备协议不支持 Manufacturer Specific Data 查询。');
      }
      if (generation !== this.connectionGeneration || !this.isConnected) {
        throw new Error('连接已失效。');
      }
      if (this.pendingManufacturerQuery) {
        throw new Error('设备信息查询已在进行中。');
      }
      const msgId = this.allocateMessageId();
      const frame = buildProtocolFrame(legacy ? 0x0a : CMD_MANUFACTURER_QUERY, [], {
        contentType: legacy ? 0 : 2,
        msgId,
        includeChecksum: false
      });
      const context = {
        generation,
        msgId,
        timer: null,
        completed: false,
        resolve: null,
        reject: null,
        promise: null
      };
      context.promise = new Promise((resolve, reject) => {
        context.resolve = resolve;
        context.reject = reject;
      });
      // Disconnect/error routing can reject this context during the write await.
      context.promise.catch(() => {});
      context.legacy = legacy;
      this.pendingManufacturerQuery = context;
      try {
        await this.writeFrame(frame, { generation, bypassSecurity: true });
        if (context.completed) return context.promise;
        context.timer = this.timers.setTimeout(() => {
          if (context.completed) return;
          context.completed = true;
          if (this.pendingManufacturerQuery === context) this.pendingManufacturerQuery = null;
          context.reject(Object.assign(new Error('Manufacturer Specific Data 查询超时。'), { canFallback: !legacy }));
        }, timeout);
        return await context.promise;
      } catch (error) {
        if (!context.completed) {
          context.completed = true;
          if (this.pendingManufacturerQuery === context) this.pendingManufacturerQuery = null;
          context.reject(error);
        }
        throw error;
      } finally {
        if (context.timer) this.timers.clearTimeout(context.timer);
        if (this.pendingManufacturerQuery === context) this.pendingManufacturerQuery = null;
      }
    }

    validateProfileAgainstManufacturer() {
      const data = this.manufacturerData;
      if (!data) throw new Error('设备 Manufacturer Specific Data 尚未解析。');
      if (!this.profile || this.profile.protocol === 'yxlone') return;
      if (this.profile.productId === undefined) {
        throw new Error(`设备 profile 未配置 canonical PID：${this.profile.name}`);
      }
      const canonicalProductId = this.profile.productId >>> 0;
      const legacyProductId = reverseUint32Bytes(canonicalProductId);
      // v1/v2 shipped both the canonical and historical reverse byte order. The App resolver
      // permits that pair only for those protocol versions; v3+ must match the canonical
      // semantic PID exactly. Keep the wire value for diagnostics, but pass the canonical
      // profile PID to the injected key service.
      const matches = data.version < 3
        ? data.productId === canonicalProductId || data.productId === legacyProductId
        : data.productId === canonicalProductId;
      if (!matches) {
        throw new Error(
          `设备名称与 PID 不匹配：name=${this.device?.name || 'Unknown'} ` +
          `pid=0x${data.productId.toString(16).padStart(8, '0')} ` +
          `wirePid=0x${data.wireProductId.toString(16).padStart(8, '0')} ` +
          `version=${data.version}`
        );
      }
      data.canonicalProductId = canonicalProductId;
      data.legacyProductId = legacyProductId;
    }

    async authenticateStandardDevice(generation) {
      this.securityState = 'authenticating';
      this.emitConnectionState('authenticating');
      const api = this.security;
      if (typeof api.beginBleSecurity !== 'function' || typeof api.completeBleSecurity !== 'function') {
        throw new Error('需要提供 BLE 安全密钥服务。');
      }
      let sessionId = null;
      let securityMessageId = null;
      const clearOwnSession = async () => {
        if (sessionId === null || sessionId === undefined || sessionId === '') return;
        try {
          if (typeof api.clearBleSecurity === 'function') {
            await api.clearBleSecurity(sessionId);
          }
        } finally {
          // A stale completion must not clear a newer connection's session.
          if (this.securitySessionId === sessionId && this.securitySessionGeneration === generation) {
            this.securitySessionId = null;
            this.securitySession = null;
            this.securitySessionGeneration = null;
          }
        }
      };
      try {
        const begin = await api.beginBleSecurity({
          productId: this.manufacturerData.canonicalProductId ?? this.profile.productId,
          mac: [...this.manufacturerData.mac]
        });
        sessionId = begin?.sessionId;
        const initPayload = validateByteArray(begin?.initPayload, 11, 'Security Init');
        if (sessionId === undefined || sessionId === null || sessionId === '') {
          throw new Error('安全服务未返回 sessionId。');
        }
        if (generation !== this.connectionGeneration) {
          await clearOwnSession();
          throw new Error('连接已失效。');
        }
        this.securitySessionId = sessionId;
        this.securitySessionGeneration = generation;
        securityMessageId = this.allocateMessageId();
        const challengeContext = this.createPendingSecurityChallenge(generation, securityMessageId);
        this.pendingSecurityChallenge = challengeContext;
        await this.writeFrame(buildProtocolFrame(CMD_SECURITY_DATA, initPayload, {
          contentType: 0,
          msgId: securityMessageId,
          includeChecksum: false
        }), { generation, bypassSecurity: true });
        if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
        const challenge = await challengeContext.promise;
        if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
        const complete = await api.completeBleSecurity({
          sessionId,
          challengePayload: [...challenge]
        });
        if (generation !== this.connectionGeneration) {
          await clearOwnSession();
          throw new Error('连接已失效。');
        }
        const authPayload = validateByteArray(complete?.authPayload, 9, 'Security Auth');
        const shiftValue = Number(complete?.shiftValue);
        const algorithmIndex = Number(complete?.algorithmIndex);
        if (!Number.isInteger(shiftValue) || shiftValue < 1 || shiftValue > 255 ||
            !Number.isInteger(algorithmIndex) || algorithmIndex < 0 || algorithmIndex >= 4) {
          throw new Error('安全服务返回的会话参数无效。');
        }
        this.securitySession = { shiftValue, algorithmIndex };
        this.securityState = 'secure';
        const authContext = {
          generation,
          msgId: securityMessageId,
          error: null
        };
        this.pendingSecurityAuth = authContext;
        await this.writeFrame(buildProtocolFrame(CMD_SECURITY_DATA, authPayload, {
          contentType: 0,
          msgId: securityMessageId,
          includeChecksum: false
        }), { generation, bypassSecurity: true });
        if (authContext.error) throw authContext.error;
        // App performs the first no-motion business transaction through FFB4. Older desktop test
        // doubles and devices without the optional read characteristic use the existing EF01/03
        // request-response probe instead; either path must validate the response checksum before
        // the connection can become ready.
        await this.sendInitialBusinessProbe(generation, authContext);
        if (authContext.error) throw authContext.error;
      } catch (error) {
        if (generation === this.connectionGeneration) {
          this.securityState = 'failed';
          this.securitySession = null;
          this.businessReady = false;
        }
        await clearOwnSession().catch(() => {});
        throw error;
      } finally {
        if (this.pendingSecurityChallenge?.generation === generation) {
          this.pendingSecurityChallenge = null;
        }
        if (this.pendingSecurityAuth?.generation === generation) {
          this.pendingSecurityAuth = null;
        }
      }
    }

    async sendInitialBusinessProbe(generation, authContext) {
      if (generation !== this.connectionGeneration || authContext?.error) {
        throw authContext?.error || new Error('连接已失效。');
      }
      if (this.readChar && typeof this.readChar.readValue === 'function') {
        await this.readInitialBusinessStatus(generation);
        return;
      }
      await this.sendCommandWithResponse(CMD_HEARTBEAT, 0x01, {
        generation,
        timeout: STANDARD_RESPONSE_TIMEOUT_MS,
        allowBeforeReady: true,
        waitForResponse: true
      });
    }

    async readInitialBusinessStatus(generation) {
      if (generation !== this.connectionGeneration || !this.isConnected) {
        throw new Error('连接已失效。');
      }
      let readResult;
      let readDeadline;
      try {
        const readPromise = Promise.resolve().then(() => this.readChar.readValue());
        // The host GATT bridge has no cancellation primitive for an in-flight read. Race it with the
        // connection timeout while observing the underlying promise to avoid a late rejection.
        readPromise.catch(() => {});
        readResult = await Promise.race([
          readPromise,
          new Promise((_, reject) => {
            readDeadline = this.timers.setTimeout(() => reject(new Error('FFB4 首个业务读取超时。')), STANDARD_RESPONSE_TIMEOUT_MS);
          })
        ]);
      } catch (error) {
        throw new Error(`FFB4 首个业务读取失败：${error?.message || error}`);
      } finally {
        if (readDeadline !== undefined) this.timers.clearTimeout(readDeadline);
      }
      if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
      const raw = readResult && ArrayBuffer.isView(readResult)
        ? new Uint8Array(readResult.buffer, readResult.byteOffset || 0, readResult.byteLength)
        : new Uint8Array(readResult || []);
      let frame;
      try {
        frame = parseProtocolFrame(raw);
      } catch (error) {
        // App keeps a legacy unframed FFB4 value on some firmware. It is still subject to the
        // same security transform and checksum boundary; there is no business event dispatch.
        let payload = [...raw];
        if (this.manufacturerData?.requiresSecurity) {
          if (this.securityState !== 'secure' || !this.securitySession) {
            throw new Error('FFB4 首个业务读取缺少安全会话。');
          }
          payload = this.transformPayload(payload, false);
        }
        if (!hasValidChecksum(payload)) {
          throw new Error(`FFB4 首个业务响应帧无效：${error?.message || error}`);
        }
        return payload;
      }
      if (frame.command !== 0x01 || frame.contentType !== 0 || frame.msgId !== 0 ||
          frame.totalFrames !== 1 || frame.currentFrame !== 0) {
        throw new Error('FFB4 首个业务响应不是设备主动上报。');
      }
      const payload = this.normalizeIncomingPayload(frame);
      if (!hasValidChecksum(payload)) {
        throw new Error('FFB4 首个业务响应 checksum 校验失败。');
      }
      return payload;
    }

    createPendingSecurityChallenge(generation, msgId) {
      const context = {
        generation,
        msgId,
        timer: null,
        completed: false,
        resolve: null,
        reject: null,
        promise: null
      };
      context.promise = new Promise((resolve, reject) => {
        context.resolve = resolve;
        context.reject = reject;
      });
      // Disconnect/error routing may reject this promise while the caller is still awaiting the
      // physical write. Keep an observer attached so stale connection failures are never emitted
      // as unhandled rejections.
      context.promise.catch(() => {});
      context.timer = this.timers.setTimeout(() => {
        if (context.completed) return;
        context.completed = true;
        context.reject(new Error('Security Challenge 超时。'));
      }, SECURITY_CHALLENGE_TIMEOUT_MS);
      return context;
    }

    async clearSecurityBackend(sessionId = this.securitySessionId, generation = null) {
      const ownsSession = sessionId !== undefined && sessionId !== null &&
        sessionId !== '' && this.securitySessionId === sessionId &&
        (generation === null || this.securitySessionGeneration === generation);
      if (ownsSession) {
        this.securitySessionId = null;
        this.securitySession = null;
        this.securitySessionGeneration = null;
      }
      if (sessionId === undefined || sessionId === null || sessionId === '') return;
      const clear = this.security?.clearBleSecurity;
      if (typeof clear === 'function') {
        await clear(sessionId);
      }
    }

    handleStandardNotify(raw) {
      let frame;
      try {
        frame = parseProtocolFrame(raw);
      } catch (error) {
        this.emitDiagnostic('notify_frame_rejected', { error: getErrorDetail(error) });
        return;
      }
      if (frame.command === CMD_MANUFACTURER_REPLY || (frame.command === 0x0b && this.pendingManufacturerQuery?.legacy)) {
        this.routeManufacturerReply(frame);
        return;
      }
      if (frame.command === CMD_SECURITY_CHALLENGE) {
        this.routeSecurityChallenge(frame);
        return;
      }
      if (frame.command === CMD_PROTOCOL_ERROR) {
        this.routeProtocolError(frame);
        return;
      }
      if (this.isStandardControlCommand(frame.command)) {
        // Security/manufacturer control traffic is deliberately kept out of the business stream.
        return;
      }
      let payload;
      try {
        payload = this.normalizeIncomingPayload(frame);
      } catch (error) {
        this.emitDiagnostic('notify_payload_rejected', { command: frame.command, error: getErrorDetail(error) });
        return;
      }
      this.routeBusinessFrame(frame, payload);
    }

    normalizeIncomingPayload(frame) {
      let payload = [...frame.payload];
      if (this.manufacturerData?.requiresSecurity) {
        // OTA frames are explicitly plaintext in the App protocol and are handled before the
        // business security gate.
        if (this.isOtaCommand(frame.command)) {
          return payload;
        }
        if (this.securityState !== 'secure' || !this.securitySession) {
          throw new Error('安全会话尚未就绪。');
        }
        if (this.isEncryptedBusinessCommand(frame.command)) {
          payload = this.transformPayload(payload, false);
        }
      }
      return payload;
    }

    routeManufacturerReply(frame) {
      const context = this.pendingManufacturerQuery;
      if (!context || context.generation !== this.connectionGeneration) return;
      if (frame.command !== (context.legacy ? 0x0b : CMD_MANUFACTURER_REPLY) || frame.totalFrames !== 1 || frame.currentFrame !== 0) {
        this.emitDiagnostic('manufacturer_reply_rejected', { reason: 'shape_or_command' });
        return;
      }
      const msgIdMatches = frame.msgId === context.msgId ||
        (frame.msgId === 0 && this.pendingManufacturerQuery === context);
      if (!msgIdMatches) {
        this.emitDiagnostic('manufacturer_reply_rejected', { reason: 'msg_id_mismatch', msgId: frame.msgId });
        return;
      }
      const isShippedCurrentResponse = !context.legacy && frame.msgId === 0 &&
        frame.contentType === 0 && frame.frameLength === 16 && frame.payload.length === 16 &&
        frame.payload[14] === 0 && frame.payload[15] === 0;
      const isCurrentResponse = (frame.contentType === 2 || (context.legacy && frame.contentType === 0)) &&
        frame.frameLength === 15 && frame.payload.length === 15;
      if (!isShippedCurrentResponse && !isCurrentResponse) {
        this.emitDiagnostic('manufacturer_reply_rejected', { reason: 'length_or_content_type' });
        return;
      }
      try {
        const payload = isShippedCurrentResponse
          ? [0xff, ...frame.payload.slice(0, 14)]
          : frame.payload;
        const parsed = parseManufacturerDataPayload(payload);
        context.completed = true;
        if (context.timer) this.timers.clearTimeout(context.timer);
        if (this.pendingManufacturerQuery === context) this.pendingManufacturerQuery = null;
        context.resolve(parsed);
      } catch (error) {
        this.emitDiagnostic('manufacturer_reply_rejected', { reason: 'payload_invalid', error: getErrorDetail(error) });
      }
    }

    routeSecurityChallenge(frame) {
      const context = this.pendingSecurityChallenge;
      if (!context || context.generation !== this.connectionGeneration) return;
      if ((frame.msgId !== context.msgId && frame.msgId !== 0) || frame.totalFrames !== 1 ||
          frame.currentFrame !== 0 || frame.frameLength !== 16 || frame.payload.length !== 16) {
        context.completed = true;
        this.timers.clearTimeout(context.timer);
        context.reject(new Error('Security Challenge 帧格式或 MsgID 无效。'));
        return;
      }
      context.completed = true;
      this.timers.clearTimeout(context.timer);
      context.resolve([...frame.payload]);
    }

    routeProtocolError(frame) {
      const payload = [...frame.payload];
      const code = payload.length > 0 ? payload[0] : 0xe8;
      const securityError = code >= 0xe1 && code <= 0xe8;
      const context = this.pendingManufacturerQuery;
      if (context && context.generation === this.connectionGeneration &&
          frame.msgId === context.msgId) {
        context.completed = true;
        if (context.timer) this.timers.clearTimeout(context.timer);
        if (this.pendingManufacturerQuery === context) this.pendingManufacturerQuery = null;
        const unsupported = payload.length === 2 && payload[0] === 0x01 && payload[1] === CMD_MANUFACTURER_QUERY;
        context.reject(Object.assign(new Error(unsupported ? '设备不支持 0x0C Manufacturer Data 查询。' : '设备返回协议错误。'), { canFallback: !context.legacy && !this.manufacturerData?.requiresSecurity }));
        return;
      }

      // Security errors are control traffic. During Challenge they reject its sole waiter;
      // during Auth they are retained on the auth context so a failed session cannot become
      // ready after a late write or business response.
      if (securityError) {
        const request = this.pendingRequests.get(frame.msgId);
        const matches = frame.msgId === 0 ||
          frame.msgId === this.pendingSecurityChallenge?.msgId ||
          frame.msgId === this.pendingSecurityAuth?.msgId ||
          (request && request.generation === this.connectionGeneration);
        if (!matches) return;
        const error = new Error(`设备安全协议错误 0x${code.toString(16)}`);
        if (this.pendingSecurityChallenge?.generation === this.connectionGeneration &&
            (frame.msgId === 0 || frame.msgId === this.pendingSecurityChallenge.msgId)) {
          const challenge = this.pendingSecurityChallenge;
          challenge.completed = true;
          this.timers.clearTimeout(challenge.timer);
          this.pendingSecurityChallenge = null;
          challenge.reject(error);
        }
        if (this.pendingSecurityAuth?.generation === this.connectionGeneration &&
            (frame.msgId === 0 || frame.msgId === this.pendingSecurityAuth.msgId)) {
          this.pendingSecurityAuth.error = error;
          this.securityState = 'failed';
          this.securitySession = null;
          this.businessReady = false;
          this.clearSecurityBackend(this.securitySessionId, this.connectionGeneration).catch(() => {});
        }
        if (request && request.generation === this.connectionGeneration) {
          this.pendingRequests.delete(frame.msgId);
          this.timers.clearTimeout(request.timer);
          request.reject(error);
        }
        if (this.manufacturerData?.requiresSecurity && this.securityState !== 'plain') {
          const oldSessionId = this.securitySessionId;
          this.securityState = 'failed';
          this.securitySession = null;
          this.businessReady = false;
          this.clearSecurityBackend(oldSessionId, this.connectionGeneration).catch(() => {});
        }
        return;
      }
      const request = this.pendingRequests.get(frame.msgId);
      if (request && request.generation === this.connectionGeneration) {
        this.pendingRequests.delete(frame.msgId);
        this.timers.clearTimeout(request.timer);
        request.reject(new Error(`设备返回协议错误 0x${(payload[0] || 0xe8).toString(16)}`));
      }
    }

    routeBusinessFrame(frame, payload) {
      if (!this.isOtaCommand(frame.command) && !this.isSupportedBusinessCommand(frame.command)) {
        this.emitDiagnostic('notify_payload_rejected', {
          command: frame.command,
          reason: 'unsupported_business_command'
        });
        return;
      }
      const assembled = this.acceptBusinessFragment(frame, payload);
      if (!assembled) return;
      const request = this.pendingRequests.get(frame.msgId);
      const matchesRequest = request && request.generation === this.connectionGeneration && request.expectedCommand === frame.command;
      if (!this.isOtaCommand(frame.command) && !hasValidChecksum(assembled.payload)) {
        if (matchesRequest) {
          this.pendingRequests.delete(frame.msgId);
          this.timers.clearTimeout(request.timer);
          request.reject(new Error('设备回复 checksum 校验失败。'));
        }
        this.emitDiagnostic('notify_payload_rejected', { command: frame.command, reason: 'checksum_invalid' });
        return;
      }
      let changes = [];
      if ([0x01, 0x03, 0x07].includes(frame.command)) {
        try {
          changes = this.observeAttributes(assembled.payload.slice(0, -1), {
            source: 'notify', command: frame.command, msgId: frame.msgId, raw: frame.raw,
          });
        } catch (error) { this.emitDiagnostic('attributes_rejected', { message: error.message }); }
      }
      const detail = {
        source: 'notify',
        msgId: frame.msgId,
        command: frame.command,
        contentType: frame.contentType,
        totalFrames: assembled.totalFrames,
        payload: new Uint8Array(assembled.payload),
        raw: frame.raw,
        changes,
        state: this.status(),
      };
      // Message reports every valid notification, including repeated values;
      // change reports only observed differences. Raw notify stays compatible.
      this.dispatchEvent(tftcEvent('tftc:message', { detail }));
      this.dispatchEvent(tftcEvent('tftc:notify', { detail: frame.raw }));
      if (matchesRequest) {
        this.pendingRequests.delete(frame.msgId);
        this.timers.clearTimeout(request.timer);
        if (request.expectedPayload && !request.expectedPayload(assembled.payload)) {
          request.reject(new Error('设备回复内容与请求不匹配。'));
          return;
        }
        request.resolve(assembled);
      }
    }

    observeAttributes(payload, context) {
      // Decode the whole packet before changing any observed fact.
      const next = new Map(this.attributes);
      for (const [key, value] of decodeAttributes(payload)) next.set(key, value);
      const changes = describeAttributeChanges(this.attributes, next);
      this.attributes = next;
      const detail = { ...context, timestampMs: this.now(), changes, state: this.status() };
      this.dispatchEvent(tftcEvent('tftc:state', { detail: detail.state }));
      if (changes.length) this.dispatchEvent(tftcEvent('tftc:change', { detail }));
      return changes;
    }

    acceptBusinessFragment(frame, payload) {
      if (frame.totalFrames === 1) {
        return { totalFrames: 1, payload };
      }
      const key = `${this.connectionGeneration}:${frame.msgId}:${frame.command}:${frame.contentType}`;
      let assembly = this.messageAssemblies.get(key);
      if (!assembly) {
        assembly = {
          totalFrames: frame.totalFrames,
          fragments: new Map(),
          timer: this.timers.setTimeout(() => this.messageAssemblies.delete(key), 3000)
        };
        this.messageAssemblies.set(key, assembly);
      }
      if (assembly.totalFrames !== frame.totalFrames) {
        this.timers.clearTimeout(assembly.timer);
        this.messageAssemblies.delete(key);
        return null;
      }
      const existing = assembly.fragments.get(frame.currentFrame);
      if (existing) {
        if (existing.length === payload.length && existing.every((byte, index) => byte === payload[index])) return null;
        this.timers.clearTimeout(assembly.timer);
        this.messageAssemblies.delete(key);
        return null;
      }
      assembly.fragments.set(frame.currentFrame, payload);
      if (assembly.fragments.size !== assembly.totalFrames) return null;
      this.timers.clearTimeout(assembly.timer);
      this.messageAssemblies.delete(key);
      const complete = [];
      for (let index = 0; index < assembly.totalFrames; index += 1) {
        const fragment = assembly.fragments.get(index);
        if (!fragment) return null;
        complete.push(...fragment);
      }
      return { totalFrames: assembly.totalFrames, payload: complete };
    }

    transformPayload(payload, encrypt) {
      if (!this.securitySession) throw new Error('安全会话不存在。');
      const { shiftValue, algorithmIndex } = this.securitySession;
      return payload.map((value, index) => {
        let delta;
        switch (algorithmIndex) {
          case 0:
            delta = shiftValue;
            break;
          case 1:
            delta = shiftValue + index;
            break;
          case 2:
            delta = -shiftValue;
            break;
          case 3:
            delta = index % 2 === 0 ? shiftValue : -shiftValue;
            break;
          default:
            throw new Error('安全算法编号无效。');
        }
        return (value + (encrypt ? delta : -delta)) & 0xff;
      });
    }

    createPendingRequest({ generation, msgId, expectedCommand, expectedPayload, timeout = STANDARD_RESPONSE_TIMEOUT_MS }) {
      const context = {
        generation,
        msgId,
        expectedCommand,
        expectedPayload,
        timer: null,
        resolve: null,
        reject: null,
        promise: null
      };
      context.promise = new Promise((resolve, reject) => {
        context.resolve = resolve;
        context.reject = reject;
      });
      // Disconnect/protocol error routing may reject the context while the caller is still
      // awaiting a physical write. Keep a rejection observer attached immediately.
      context.promise.catch(() => {});
      context.timer = this.timers.setTimeout(() => {
        if (this.pendingRequests.get(msgId) !== context) return;
        this.pendingRequests.delete(msgId);
        context.reject(new Error('设备回复超时。'));
      }, timeout);
      this.pendingRequests.set(msgId, context);
      return context;
    }

    rejectPendingRequests(error) {
      for (const context of this.pendingRequests.values()) {
        this.timers.clearTimeout(context.timer);
        context.reject(error);
      }
      this.pendingRequests.clear();
      if (this.pendingManufacturerQuery) {
        const context = this.pendingManufacturerQuery;
        context.completed = true;
        if (context.timer) this.timers.clearTimeout(context.timer);
        context.reject(error);
        this.pendingManufacturerQuery = null;
      }
      if (this.pendingSecurityChallenge) {
        const context = this.pendingSecurityChallenge;
        context.completed = true;
        this.timers.clearTimeout(context.timer);
        context.reject(error);
        this.pendingSecurityChallenge = null;
      }
    }

    clearMessageAssemblies() {
      for (const assembly of this.messageAssemblies.values()) {
        this.timers.clearTimeout(assembly.timer);
      }
      this.messageAssemblies.clear();
    }

    handleConnectionLost(reason) {
      this.stopHeartbeat();
      const oldSessionId = this.securitySessionId;
      const oldGeneration = this.connectionGeneration;
      this.connectionGeneration += 1;
      this.rejectPendingRequests(new Error(`连接已断开：${reason}`));
      this.clearMessageAssemblies();
      this.connectionFailed = true;
      this.disconnecting = true;
      this.securityState = 'failed';
      this.securitySession = null;
      this.businessReady = false;
      this.pendingSecurityAuth = null;
      this.clearSecurityBackend(oldSessionId, oldGeneration).catch(() => {});
      this.dispatchEvent(tftcEvent('tftc:disconnected'));
      this.emitConnectionState('failed', { reason });
    }

    status() {
      return {
        connected: this.isConnected,
        connectionState: this.connectionState,
        ready: this.businessReady,
        productId: this.manufacturerData?.canonicalProductId ?? this.profile?.productId ?? null,
        productName: this.profile?.name ?? null,
        securityState: this.securityState,
        ...attributeSnapshot(this.attributes),
      };
    }

    async queryKeys(keys, { timeout = STANDARD_RESPONSE_TIMEOUT_MS } = {}) {
      if (this.profile?.protocol !== 'dokidoki') throw new Error('Generic queries require the standard TFTC protocol');
      if (!Array.isArray(keys) || keys.length === 0) throw new RangeError('keys must not be empty');
      const msgId = this.allocateMessageId();
      const resolvedKeys = keys.map(resolveDataKey);
      const frame = buildProtocolFrame(0x06, resolvedKeys, { msgId, includeChecksum: true });
      const context = this.createPendingRequest({
        generation: this.connectionGeneration, msgId, expectedCommand: 0x07, timeout,
        expectedPayload(payload) {
          try {
            const attributes = decodeAttributes(payload.slice(0, -1));
            return resolvedKeys.every(key => attributes.has(key));
          } catch { return false; }
        },
      });
      try {
        await this.writeFrame(frame, { forceResponseCharacteristic: true });
        await context.promise;
        return this.status();
      } catch (error) {
        if (this.pendingRequests.get(msgId) === context) {
          this.pendingRequests.delete(msgId);
          this.timers.clearTimeout(context.timer);
          context.reject(error);
        }
        throw error;
      }
    }


    async writeSingle(channel, value) {
      if (this.profile?.protocol !== 'dokidoki') throw new Error('Raw attributes require the standard TFTC protocol');
      if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Attribute value must be a byte');
      return this.sendCommand(resolveDataKey(channel), value);
    }

    // Raw attributes deliberately bypass application product policies.
    async writePairs(commands) {
      if (this.profile?.protocol !== 'dokidoki') throw new Error('Batch attributes require the standard TFTC protocol');
      const pairs = Object.entries(commands).map(([key, value]) => {
        if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Attribute value must be a byte');
        return [resolveDataKey(key), value];
      });
      if (!pairs.length) throw new RangeError('commands must not be empty');
      return this.sendCommands(pairs);
    }

    productResolver() { return getProductProfile(this.profile?.productKey ?? this.profile?.name); }

    productAttributes() {
      return {
        vibrationSwitch: this.attributes.get(DATA_KEY.VIBRATION_SWITCH),
        suctionSwitch: this.attributes.get(DATA_KEY.SUCTION_SWITCH),
        telescopicSwitch: this.attributes.get(DATA_KEY.TELESCOPIC_SWITCH),
        customFE: this.attributes.get(DATA_KEY.CUSTOM_FE),
      };
    }

    async writeProductPlan(plan, options = {}) {
      if (!this.isConnected || !this.businessReady) throw new Error('设备业务会话尚未就绪。');
      if (plan.unsupported.length) throw new Error('Unsupported TFTC product operation or data key');
      for (const write of plan.writes) validateByteArray(write.pair, 2, 'Product command');
      for (const batch of plan.batches) await this.sendCommands(batch.map(write => write.pair), options);
    }

    async executeCommands(commands) {
      const product = this.productResolver();
      if (!product) throw new Error('App product mapping is unavailable; use set controls or explicit writePairs');
      const pairs = Object.entries(commands).map(([key, value]) => [resolveDataKey(key), value]);
      if (!pairs.length) throw new RangeError('commands must not be empty');
      return this.writeProductPlan(resolveProductCommands(product, pairs, this.productAttributes()));
    }

    pause() { return this.actionPause(); }
    resume() { return this.actionResume(); }
    stop() {
      const product = this.productResolver();
      return product ? this.writeProductPlan(resolveProductOperation(product, 'stop', this.productAttributes())) : this.actionPause();
    }

    async setLinear(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Control value must be finite');
      await this.sendAction('linear', this.profile?.protocol === 'yxlone' ? Math.min(9, clampPercent(value)) : clampPercent(value));
    }

    async setRotary(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Control value must be finite');
      await this.sendAction('rotary', this.profile?.protocol === 'yxlone' ? Math.min(9, clampPercent(value)) : rotaryToBLE(value));
    }

    async setVibration(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Control value must be finite');
      await this.sendAction('vibration', clampPercent(value));
    }

    async setSuction(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Control value must be finite');
      await this.sendAction('suction', clampPercent(value));
    }

    async setHeat(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Control value must be finite');
      await this.sendAction('heat', value > 0 ? 0x01 : 0x00);
    }

    async actionPause({ allowDuringDisconnect = false, generation = this.connectionGeneration } = {}) {
      const product = this.productResolver();
      if (product) return this.writeProductPlan(resolveProductOperation(product, allowDuringDisconnect ? 'stop' : 'pause', this.productAttributes()), { allowDuringDisconnect, generation });
      if (!this.profile) {
        return;
      }

      if (this.pauseBusy) {
        return;
      }

      if (this.profile.protocol === 'yxlone') {
        this.yxlOneMotionEpoch += 1;
        this.queuedYxlOneMotion = null;
      }

      for (let attempt = 0; this.motionBusy && attempt < 6; attempt += 1) {
        await this.delay(80);
      }

      if (this.motionBusy && this.profile.protocol !== 'yxlone') {
        return;
      }

      this.pauseBusy = true;
      this.motionBusy = true;
      const transportOptions = { allowDuringDisconnect, generation };
      try {
        if (this.profile.protocol === 'yxlone') {
          const stopPairs = await this.sendYxlOneHardStop(transportOptions);
          this.emitCommand('pause', 0, stopPairs);
          this.lastMotionValues.clear();
          this.lastMotionValues.set('linear', 0);
          this.lastMotionValues.set('rotary', 0);
          this.yxlOneRunning = false;
          return;
        }

        if (this.profile.stopSequence) {
          await this.sendCommands(this.profile.stopSequence, transportOptions);
          this.emitCommand('pause', 0, this.profile.stopSequence);
          this.lastMotionValues.clear();
          this.yxlOneRunning = false;
          return;
        }

        const stopCommand = this.profile.commands.stop;
        if (stopCommand !== undefined) {
          await this.sendCommand(stopCommand, 0x00, transportOptions);
          this.emitCommand('pause', 0, [[stopCommand, 0x00]]);
          this.lastMotionValues.clear();
          this.yxlOneRunning = false;
          return;
        }

        for (const [action, value] of ACTIONS_TO_ZERO) {
          if (this.profile.commands[action] !== undefined) {
            await this.sendAction(action, value, null, transportOptions);
          }
        }
        this.lastMotionValues.clear();
        this.yxlOneRunning = false;
      } finally {
        this.motionBusy = false;
        this.pauseBusy = false;
        if (this.profile?.protocol === 'yxlone') {
          this.flushQueuedYxlOneMotion();
        }
      }
    }

    queueYxlOneMotion(metrics, options) {
      if (this.profile?.protocol !== 'yxlone' || metrics?.status !== 'tracking') {
        return false;
      }
      this.queuedYxlOneMotion = {
        metrics: { ...metrics },
        options: { ...options },
        at: this.now()
      };
      this.emitCommand('queued', 1, []);
      return true;
    }

    flushQueuedYxlOneMotion() {
      if (!this.queuedYxlOneMotion || this.motionBusy || this.pauseBusy || !this.isConnected || this.profile?.protocol !== 'yxlone') {
        return;
      }
      const queued = this.queuedYxlOneMotion;
      this.queuedYxlOneMotion = null;
      if (this.now() - queued.at > 2500) {
        return;
      }
      this.timers.setTimeout(() => {
        this.applyMotionMetrics(queued.metrics, queued.options).catch(() => {});
      }, 0);
    }

    async sendYxlOneHardStop(transportOptions = {}) {
      const stopPairs = [
        [YXL_ONE_CMD_WORK_CONTROL, 0x00],
        [YXL_ONE_CMD_ROTATING, 0x00],
        [YXL_ONE_CMD_TELESCOPIC, 0x00],
        [YXL_ONE_CMD_ROTATING, 0x00],
        [YXL_ONE_CMD_WORK_CONTROL, 0x00],
        [YXL_ONE_CMD_ROTATING, 0x00],
        [YXL_ONE_CMD_TELESCOPIC, 0x00],
        [YXL_ONE_CMD_ROTATING, 0x00]
      ];
      for (const [index, [cmd, value]] of stopPairs.entries()) {
        const attempts = cmd === YXL_ONE_CMD_ROTATING ? YXL_ONE_STOP_ATTEMPTS : 1;
        try {
          await this.sendYxlOneCommand(cmd, value, {
            attempts,
            waitAck: false,
            ...transportOptions
          });
        } catch {
          // Stop commands are best-effort but must continue through the full sequence.
        }
        if (index < stopPairs.length - 1) {
          await this.delay(YXL_ONE_STOP_COMMAND_DELAY_MS);
        }
      }
      return stopPairs;
    }

    async actionResume() {
      const product = this.productResolver();
      if (product) return this.writeProductPlan(resolveProductOperation(product, 'resume', this.productAttributes()));
      if (!this.profile || !this.isConnected) {
        return { sent: false, reason: 'not-ready' };
      }

      if (this.profile.protocol !== 'yxlone') {
        return { sent: false, reason: 'not-required' };
      }

      if (this.yxlOneRunning) {
        return { sent: false, reason: 'already-running' };
      }

      for (let attempt = 0; (this.motionBusy || this.pauseBusy) && attempt < 8; attempt += 1) {
        await this.delay(80);
      }

      if (this.motionBusy || this.pauseBusy) {
        return { sent: false, reason: 'busy' };
      }

      this.motionBusy = true;
      try {
        await this.sendYxlOneCommand(YXL_ONE_CMD_WORK_CONTROL, 0x01);
        this.yxlOneRunning = true;
        this.lastMotionValues.clear();
        this.lastMotionSentAt = 0;
        this.emitCommand('resume', 1, [[YXL_ONE_CMD_WORK_CONTROL, 0x01]]);
        return { sent: true };
      } finally {
        this.motionBusy = false;
      }
    }

    async applyMotionMetrics(metrics, options = {}) {
      if (!this.isConnected || !this.profile || this.disconnecting || !this.businessReady) {
        return { sent: false, reason: 'not-ready' };
      }

      if (this.motionBusy || this.pauseBusy) {
        if (this.queueYxlOneMotion(metrics, options)) {
          return { sent: false, reason: 'queued' };
        }
        return { sent: false, reason: 'not-ready' };
      }

      if (this.profile.protocol === 'yxlone' && !this.yxlOneRunning) {
        const resumeEpoch = this.yxlOneMotionEpoch;
        const resumeResult = await this.actionResume();
        if (!resumeResult.sent) {
          return resumeResult;
        }
        if (resumeEpoch !== this.yxlOneMotionEpoch) {
          return { sent: false, reason: 'paused' };
        }
      }

      const mergedOptions = { ...this.motionOptions, ...options };
      const now = this.now();
      const minInterval = mergedOptions.minInterval;
      if (now - this.lastMotionSentAt < minInterval) {
        return { sent: false, reason: 'rate-limited' };
      }

      const mapped = this.mapMotionToActions(metrics, mergedOptions);
      const changed = mapped.filter(([action, value]) => {
        const previous = this.lastMotionValues.get(action);
        if (previous === undefined) {
          return true;
        }
        return Math.abs(previous - value) >= mergedOptions.minDelta || value === 0 || previous === 0;
      });

      if (changed.length === 0) {
        return { sent: false, reason: 'unchanged' };
      }

      this.motionBusy = true;
      const motionEpoch = this.profile.protocol === 'yxlone' ? this.yxlOneMotionEpoch : null;
      try {
        for (const [action, value] of changed) {
          if (motionEpoch !== null && motionEpoch !== this.yxlOneMotionEpoch) {
            return { sent: false, reason: 'paused' };
          }
          const actionSent = await this.sendAction(action, value, motionEpoch);
          if (actionSent === false) {
            return { sent: false, reason: 'paused' };
          }
          this.lastMotionValues.set(action, value);
        }
        this.lastMotionSentAt = now;
        return { sent: true, actions: changed };
      } finally {
        this.motionBusy = false;
      }
    }

    mapMotionToActions(metrics, options = this.motionOptions) {
      const sensitivity = options.sensitivity ?? 1;
      const maxOutput = clampPercent(options.maxOutput ?? DEFAULT_MOTION_OPTIONS.maxOutput);
      const normalize = (value) => clampPercent(value * sensitivity);
      const scaleOutput = (value) => clampPercent(value * (maxOutput / 100));
      const intensity = normalize(metrics.intensity || 0);
      const speed = normalize(metrics.speed || 0);
      const depth = normalize(metrics.depth || 0);
      const commands = this.profile.commands;
      const actions = [];

      if (this.profile.protocol === 'yxlone') {
        const maxLevel = this.maxOutputToYxlOneLevel(maxOutput);
        const linearLevel = this.percentToYxlOneLevel(depth * 0.72 + speed * 0.18 + intensity * 0.1, maxLevel);
        const rotaryLevel = this.percentToYxlOneLevel(speed * 0.58 + intensity * 0.28 + depth * 0.14, maxLevel);
        actions.push(['linear', linearLevel]);
        actions.push(['rotary', rotaryLevel]);
        return actions;
      }

      const linearValue = scaleOutput(depth * 0.68 + speed * 0.22 + intensity * 0.1);
      const vibrationValue = scaleOutput(intensity * 0.72 + speed * 0.2 + depth * 0.08);
      const rotaryValue = scaleOutput(speed * 0.65 + intensity * 0.2);
      const suctionValue = intensity >= 28 || speed >= 35 ? scaleOutput(intensity * 0.58 + depth * 0.22) : 0;

      if (commands.linear !== undefined) {
        actions.push(['linear', linearValue]);
      }
      if (commands.vibration !== undefined) {
        actions.push(['vibration', vibrationValue]);
      }
      if (commands.rotary !== undefined) {
        actions.push(['rotary', rotaryValue]);
      }
      if (commands.suction !== undefined && commands.linear === undefined) {
        actions.push(['suction', suctionValue]);
      }

      if (actions.length === 0) {
        return [];
      }
      return actions;
    }

    maxOutputToYxlOneLevel(maxOutput) {
      const percent = clampPercent(maxOutput);
      return percent === 0 ? 0 : Math.max(1, Math.min(9, Math.floor((percent / 100) * 9)));
    }

    percentToYxlOneLevel(value, maxLevel = 9) {
      const percent = clampPercent(value);
      const level = percent === 0 ? 0 : Math.max(1, Math.min(9, Math.trunc((percent / 100) * 10)));
      return Math.min(level, maxLevel);
    }

    previewMotionMetrics(metrics, options = {}) {
      if (!this.profile) {
        return [];
      }
      return this.mapMotionToActions(metrics, { ...this.motionOptions, ...options });
    }

    async sendAction(action, value, expectedYxlOneEpoch = null, transportOptions = {}) {
      if (!this.profile) {
        throw new Error('设备 profile 尚未初始化。');
      }

      if (this.profile.commands[action] === undefined && !this.profile.actionSequences?.[action]) {
        throw new Error(`${this.profile.name} 不支持 ${action}。`);
      }

      if (this.profile.protocol === 'yxlone' && expectedYxlOneEpoch !== null && expectedYxlOneEpoch !== this.yxlOneMotionEpoch) {
        return false;
      }

      if (this.profile.protocol === 'yxlone' && value > 0 && !this.yxlOneRunning) {
        await this.sendYxlOneCommand(YXL_ONE_CMD_WORK_CONTROL, 0x01);
        if (expectedYxlOneEpoch !== null && expectedYxlOneEpoch !== this.yxlOneMotionEpoch) {
          return false;
        }
        this.yxlOneRunning = true;
      }

      const product = this.productResolver();
      if (product) {
        const key = { vibration: DATA_KEY.VIBRATION_AMP, linear: DATA_KEY.TELESCOPIC_AMP, suction: DATA_KEY.SUCTION_AMP }[action];
        if (key === undefined) throw new Error(`Unsupported product action: ${action}`);
        await this.writeProductPlan(resolveProductCommands(product, [[key, value]], this.productAttributes()), transportOptions);
        return true;
      }

      const sequence = this.profile.actionSequences && this.profile.actionSequences[action];
      if (sequence) {
        const actionSequence = typeof sequence === 'function' ? sequence(value) : sequence;
        const pairs = actionSequence.map(([cmd, nextValue]) => [cmd, nextValue === 'value' ? value : nextValue]);
        await this.sendCommands(pairs, transportOptions);
        this.emitCommand(action, value, pairs);
        return;
      }

      const cmd = this.profile.commands[action];
      if (cmd === undefined) {
        throw new Error(`${this.profile.name} 不支持 ${action}。`);
      }
      if (this.profile.protocol === 'yxlone' && (cmd === YXL_ONE_CMD_TELESCOPIC || cmd === YXL_ONE_CMD_ROTATING)) {
        if (expectedYxlOneEpoch !== null && expectedYxlOneEpoch !== this.yxlOneMotionEpoch) {
          return false;
        }
        await this.sendYxlOneCommand(cmd, value, { waitAck: false, ...transportOptions });
        this.emitCommand(action, value, [[cmd, value]]);
        return true;
      }
      await this.sendCommand(cmd, value, transportOptions);
      this.emitCommand(action, value, [[cmd, value]]);
      return true;
    }

    async sendYxlOneFrame(cmd, ...params) {
      if (!this.isConnected) {
        throw new Error('设备未连接。');
      }
      await this.writeFrame(buildYxlOneFrame(cmd, ...params));
    }

    async sendYxlOneFrameWithOptions(cmd, params, options = {}) {
      if (!this.isConnected) {
        throw new Error('设备未连接。');
      }
      await this.writeFrame(buildYxlOneFrame(cmd, ...params), options);
    }

    async sendYxlOneCommand(cmd, value, {
      attempts = 1,
      waitAck = true,
      generation = this.connectionGeneration,
      allowDuringDisconnect = false
    } = {}) {
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const pendingAck = waitAck ? this.waitForYxlOneAck(cmd) : null;
        try {
          const params = value === undefined ? [] : [value];
          await this.sendYxlOneFrameWithOptions(cmd, params, {
            generation,
            allowDuringDisconnect
          });
          if (!pendingAck) {
            return true;
          }
          const success = await pendingAck;
          if (success) {
            return true;
          }
          lastError = new Error(`TRYFUN-ONE command 0x${cmd.toString(16)} rejected`);
          this.emitDiagnostic('write_rejected', {
            cmd,
            value,
            attempt,
            error: getErrorDetail(lastError)
          });
        } catch (error) {
          lastError = error;
          this.emitDiagnostic('write_failed', {
            cmd,
            value,
            attempt,
            waitAck,
            error: getErrorDetail(error)
          });
        }
        if (attempt < attempts) {
          await this.delay(YXL_ONE_STOP_COMMAND_DELAY_MS);
        }
      }
      throw lastError || new Error(`TRYFUN-ONE command 0x${cmd.toString(16)} failed`);
    }

    waitForYxlOneAck(cmd) {
      return new Promise((resolve) => {
        const callbacks = this.pendingYxlOneAcks.get(cmd) || [];
        const timer = this.timers.setTimeout(() => {
          const nextCallbacks = (this.pendingYxlOneAcks.get(cmd) || []).filter((item) => item.resolve !== resolve);
          if (nextCallbacks.length) {
            this.pendingYxlOneAcks.set(cmd, nextCallbacks);
          } else {
            this.pendingYxlOneAcks.delete(cmd);
          }
          resolve(false);
        }, YXL_ONE_ACK_TIMEOUT_MS);
        callbacks.push({ resolve, timer });
        this.pendingYxlOneAcks.set(cmd, callbacks);
      });
    }

    handleYxlOneNotify(raw) {
      if (!raw || raw.length < 4 || raw[0] !== 0xaa || raw.length !== raw[1] + 3) {
        return;
      }
      const checksumPayload = raw.slice(2, raw.length - 1);
      if (calculateChecksum(checksumPayload) !== raw[raw.length - 1]) {
        return;
      }

      let command = raw[2];
      let success = true;
      if (raw[2] === 0x0b && raw.length >= 6) {
        command = raw[3];
        success = raw[4] === 0x01;
      }

      const callbacks = this.pendingYxlOneAcks.get(command);
      if (!callbacks || callbacks.length === 0) {
        return;
      }
      const callback = callbacks.shift();
      this.timers.clearTimeout(callback.timer);
      callback.resolve(success);
      if (callbacks.length) {
        this.pendingYxlOneAcks.set(command, callbacks);
      } else {
        this.pendingYxlOneAcks.delete(command);
      }
    }

    clearPendingYxlOneAcks() {
      for (const callbacks of this.pendingYxlOneAcks.values()) {
        callbacks.forEach((callback) => {
          this.timers.clearTimeout(callback.timer);
          callback.resolve(false);
        });
      }
      this.pendingYxlOneAcks.clear();
    }

    async sendCommand(cmd, value, options = {}) {
      if (!this.isConnected || !this.profile) {
        throw new Error('设备未连接。');
      }
      if (this.profile.protocol === 'yxlone') {
        await this.sendYxlOneCommand(cmd, value, options);
        return;
      }
      await this.writeFrame(this.buildBusinessFrame(cmd, value), options);
    }

    async sendCommands(pairs, options = {}) {
      if (!this.isConnected || !this.profile) {
        throw new Error('设备未连接。');
      }
      if (this.profile.protocol === 'yxlone') {
        for (const [cmd, value] of pairs) {
          await this.sendYxlOneCommand(cmd, value, options);
        }
        return;
      }
      await this.writeFrame(this.buildMultiBusinessFrame(pairs), options);
    }

    async sendCommandWithResponse(cmd, value, {
      generation = this.connectionGeneration,
      timeout = STANDARD_RESPONSE_TIMEOUT_MS,
      expectedPayload = null,
      allowBeforeReady = false,
      allowDuringDisconnect = false,
      waitForResponse = false
    } = {}) {
      if (!this.isConnected || !this.profile) {
        throw new Error('设备未连接。');
      }
      if (this.profile.protocol === 'yxlone') {
        await this.sendYxlOneCommand(cmd, value, { allowDuringDisconnect, generation });
        return;
      }
      const frame = this.buildBusinessFrame(cmd, value);
      const parsed = parseProtocolFrame(frame);
      if (!waitForResponse) {
        await this.writeFrame(frame, {
          generation,
          allowBeforeReady,
          allowDuringDisconnect,
          forceResponseCharacteristic: true
        });
        return;
      }
      const context = this.createPendingRequest({
        generation,
        msgId: parsed.msgId,
        expectedCommand: CMD_MCU_REPLY,
        expectedPayload,
        timeout
      });
      try {
        await this.writeFrame(frame, {
          generation,
          allowBeforeReady,
          allowDuringDisconnect,
          forceResponseCharacteristic: true
        });
        return await context.promise;
      } catch (error) {
        if (this.pendingRequests.get(parsed.msgId) === context) {
          this.pendingRequests.delete(parsed.msgId);
          this.timers.clearTimeout(context.timer);
          context.reject(error);
        }
        throw error;
      }
    }

    async writeFrame(frame, {
      generation = this.connectionGeneration,
      bypassSecurity = false,
      allowBeforeReady = false,
      allowDuringDisconnect = false,
      forceResponseCharacteristic = false
    } = {}) {
      if (!this.isConnected || !this.profile) {
        throw new Error('设备未连接。');
      }
      if (generation !== this.connectionGeneration) {
        throw new Error('连接已失效。');
      }
      if (this.disconnecting && !allowDuringDisconnect) {
        throw new Error('设备正在断开连接。');
      }

      let wireFrame = frame instanceof Uint8Array ? frame : new Uint8Array(frame || []);
      let parsed = null;
      let characteristic = this.writeChar;
      let withoutResponse = false;
      let isBusiness = false;
      let requiresSecurity = false;
      if (this.profile.protocol === 'yxlone') {
        if (wireFrame[0] !== 0xaa) {
          throw new Error('TRYFUN-ONE 帧格式无效。');
        }
        characteristic = this.writeChar;
      } else {
        parsed = parseProtocolFrame(wireFrame);
        const isControl = this.isStandardControlCommand(parsed.command);
        const isOta = this.isOtaCommand(parsed.command);
        isBusiness = !isControl && !isOta;
        requiresSecurity = Boolean(this.manufacturerData?.requiresSecurity);
        if (isBusiness && !bypassSecurity) {
          if (requiresSecurity && (this.securityState !== 'secure' || !this.securitySession)) {
            throw new Error('安全会话尚未就绪。');
          }
          if (!allowBeforeReady && !this.businessReady) {
            throw new Error('设备业务会话尚未就绪。');
          }
          if (requiresSecurity && this.isEncryptedBusinessCommand(parsed.command)) {
            const payload = this.transformPayload(parsed.payload, true);
            wireFrame = new Uint8Array([...parsed.raw.slice(0, 4), ...payload]);
          }
        }
        // Security/manufacturer controls and OTA use FFB5. Plain business traffic retains the
        // historical FFB7 preference when the device exposes it.
        if (isBusiness && !requiresSecurity && !isOta && !forceResponseCharacteristic && this.writeNoRespChar) {
          characteristic = this.writeNoRespChar;
          withoutResponse = true;
        } else {
          characteristic = this.writeChar;
        }
      }
      if (!characteristic) {
        throw new Error('设备写入特征不可用。');
      }

      const task = this.writeQueue.then(async () => {
        if (!this.isConnected || generation !== this.connectionGeneration) {
          throw new Error('连接已失效。');
        }
        if (this.disconnecting && !allowDuringDisconnect) {
          throw new Error('设备正在断开连接。');
        }
        if (parsed && isBusiness && !bypassSecurity) {
          if (requiresSecurity && (this.securityState !== 'secure' || !this.securitySession)) {
            throw new Error('安全会话尚未就绪。');
          }
          if (!allowBeforeReady && !this.businessReady) {
            throw new Error('设备业务会话尚未就绪。');
          }
        }
        try {
          await writeCharacteristicValue(characteristic, wireFrame, withoutResponse);
          if (generation !== this.connectionGeneration) {
            throw new Error('连接已失效。');
          }
        } catch (error) {
          this.emitDiagnostic('write_failed', {
            uuid: characteristic?.uuid || null,
            withoutResponse,
            frameLength: wireFrame.length,
            error: getErrorDetail(error)
          });
          throw error;
        }
      });
      this.writeQueue = task.catch(() => {});
      return task;
    }

    emitCommand(action, value, pairs) {
      this.dispatchEvent(
        tftcEvent('tftc:command', {
          detail: {
            action,
            value,
            pairs,
            profile: this.profile ? this.profile.name : null,
            at: this.now()
          }
        })
      );
    }

    startHeartbeat(generation = this.connectionGeneration) {
      this.stopHeartbeat();
      this.heartbeatSuccessLogged = false;
      const heartbeatToken = {};
      this.heartbeatToken = heartbeatToken;
      const isCurrentHeartbeat = () =>
        generation === this.connectionGeneration &&
        this.heartbeatToken === heartbeatToken &&
        this.isConnected;
      this.emitDiagnostic('heartbeat_started');
      this.heartbeatInterval = this.timers.setInterval(async () => {
        if (!isCurrentHeartbeat()) return;
        try {
          if (this.profile?.protocol === 'yxlone') {
            await this.sendYxlOneCommand(0x02, undefined, { waitAck: false });
          } else {
            await this.sendCommandWithResponse(CMD_HEARTBEAT, 0x01);
          }
          if (!isCurrentHeartbeat()) return;
          if (!this.heartbeatSuccessLogged) {
            this.heartbeatSuccessLogged = true;
            this.emitDiagnostic('heartbeat_success');
          }
        } catch (error) {
          if (!isCurrentHeartbeat()) return;
          this.emitDiagnostic('heartbeat_failed', { error: getErrorDetail(error) });
          this.stopHeartbeat();
          if (this.profile?.protocol === 'yxlone') {
            this.dispatchEvent(tftcEvent('tftc:disconnected'));
          } else {
            this.handleConnectionLost('heartbeat_failed');
          }
        }
      }, 2000);
    }

    stopHeartbeat() {
      this.heartbeatToken = null;
      if (this.heartbeatInterval) {
        this.timers.clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
        this.emitDiagnostic('heartbeat_stopped');
      }
    }

    async connectGattWithRetry(generation = this.connectionGeneration) {
      let lastError = null;
      const targetDevice = this.device;
      for (let attempt = 1; attempt <= GATT_CONNECT_ATTEMPTS; attempt += 1) {
        if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
        this.emitDiagnostic('gatt_connect_attempt', { attempt, maxAttempts: GATT_CONNECT_ATTEMPTS });
        try {
          const server = await targetDevice.gatt.connect();
          if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
          if (server && targetDevice.gatt.connected) {
            this.emitDiagnostic('gatt_connect_success', { attempt });
            return server;
          }
          this.emitDiagnostic('gatt_connect_incomplete', { attempt });
        } catch (error) {
          lastError = error;
          this.emitDiagnostic('gatt_connect_failed', { attempt, error: getErrorDetail(error) });
        }
        await this.delay(250 * attempt);
      }
      this.emitDiagnostic('gatt_connect_give_up', { error: getErrorDetail(lastError) });
      throw lastError || new Error('无法连接 DokiDoki GATT 服务。');
    }

    async getPrimaryServiceWithRetry(uuid, generation = this.connectionGeneration) {
      let lastError = null;
      for (let attempt = 1; attempt <= GATT_SERVICE_ATTEMPTS; attempt += 1) {
        if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
        this.emitDiagnostic('gatt_service_attempt', { uuid, attempt, maxAttempts: GATT_SERVICE_ATTEMPTS });
        try {
          if (!this.device?.gatt?.connected) {
            const server = await this.connectGattWithRetry(generation);
            if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
            this.server = server;
          }
          const service = await this.server.getPrimaryService(uuid);
          if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
          this.emitDiagnostic('gatt_service_success', { uuid, attempt });
          return service;
        } catch (error) {
          lastError = error;
          this.emitDiagnostic('gatt_service_failed', { uuid, attempt, error: getErrorDetail(error) });
          if (!isGattDisconnectedError(error)) {
            throw error;
          }
          try {
            if (this.device?.gatt?.connected) {
              this.device.gatt.disconnect();
            }
          } catch {
            // Ignore cleanup errors before retrying.
          }
          await this.delay(300 * attempt);
          if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
          const server = await this.connectGattWithRetry(generation);
          if (generation !== this.connectionGeneration) throw new Error('连接已失效。');
          this.server = server;
        }
      }
      throw lastError || new Error('无法读取 DokiDoki GATT 服务。');
    }
  }
