import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { TftcClient } from '../src/client.js';
import * as protocolModule from '../src/protocol.js';

const SECURITY_VECTOR = {
  initPayload: [0x01, 0x01, 0x00, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30],
  challengePayload: [0x01, 0x00, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x67, 0xec, 0xb3, 0x53, 0x8e, 0xab],
  authPayload: [0x02, 0x01, 0x00, 0xf2, 0xfc, 0x30, 0x9a, 0x35, 0xc2]
};

// Retained SyncDo regression scenarios, executed against the imported ESM package.
function loadRuntime({ syncdo = {}, bluetooth = null, timers = {} } = {}) {
  const events = [];
  let messageId = 0;
  const protocol = { ...protocolModule,
    DEVICE_PROFILES: protocolModule.DEVICE_PROFILES.map(p => p.name),
    resetMessageId() { messageId = 0; },
    buildCommandFrame(cmd, value) { messageId = messageId % 15 + 1; return protocolModule.buildCommandFrame(cmd, value, { msgId: messageId }); },
  };
  class DokiDokiWebBluetooth extends TftcClient {
    constructor() {
      super({ bluetooth, security: syncdo, timers, now: () => 1000 });
      this.dispatchEvent = (event) => events.push({ ...event, type: event.type.replace('tftc:', 'dokidoki:') });
    }
  }
  return { events, protocol, DokiDokiWebBluetooth };
}

function createGattMock({
  deviceName = 'DK-META2',
  onWrite,
  includeNotify = true,
  includeRead = false,
  readValue
} = {}) {
  const writes = [];
  let notifyCharacteristic;

  const emitNotify = (frame) => {
    if (!notifyCharacteristic?.listener) return;
    const value = new Uint8Array(frame);
    notifyCharacteristic.listener({ target: { value } });
  };

  const makeCharacteristic = (uuid, options = {}) => {
    const characteristic = {
      uuid,
      listener: null,
      async startNotifications() {
        return characteristic;
      },
      addEventListener(type, callback) {
        if (type === 'characteristicvaluechanged') characteristic.listener = callback;
      },
      async writeValueWithResponse(frame) {
        const bytes = Array.from(frame);
        writes.push(bytes);
        await onWrite?.(bytes, emitNotify);
      },
    };
    if (options.readValue) {
      characteristic.readValue = options.readValue;
    }
    return characteristic;
  };

  const isYxlOne = deviceName === 'TRYFUN-ONE';
  const writeCharacteristic = makeCharacteristic(isYxlOne ? 'fff1' : 'ffb5');
  const readCharacteristic = !isYxlOne && includeRead
    ? makeCharacteristic('ffb4', { readValue })
    : null;
  notifyCharacteristic = includeNotify ? makeCharacteristic(isYxlOne ? 'ff14' : 'ffb8') : null;
  const standardService = {
    async getCharacteristics() {
      return [
        writeCharacteristic,
        ...(readCharacteristic ? [readCharacteristic] : []),
        ...(notifyCharacteristic ? [notifyCharacteristic] : [])
      ];
    }
  };
  const server = {
    async getPrimaryService(uuid) {
      if (!isYxlOne) return standardService;
      return standardService;
    }
  };
  const deviceListeners = new Map();
  const device = {
    name: deviceName,
    id: `${deviceName}-test-id`,
    gatt: {
      connected: false,
      async connect() {
        device.gatt.connected = true;
        return server;
      },
      disconnect() {
        device.gatt.connected = false;
      }
    },
    addEventListener(type, callback) {
      deviceListeners.set(type, callback);
    },
    emitDisconnect() {
      device.gatt.connected = false;
      deviceListeners.get('gattserverdisconnected')?.();
    }
  };
  return {
    bluetooth: {
      async requestDevice() {
        return device;
      }
    },
    device,
    writes,
    emitNotify,
    notifyCharacteristic
  };
}

function buildRawFrame({ contentType, msgId, command, payload }) {
  return new Uint8Array([
    ((contentType & 0x0f) << 4) | (msgId & 0x0f),
    command,
    0x00,
    payload.length,
    ...payload
  ]);
}

function checksum(payload) {
  return (0 - payload.reduce((sum, byte) => (sum + byte) & 0xff, 0)) & 0xff;
}

function framePayload(frame) {
  return frame.slice(4, 4 + frame[3]);
}

function assertWireHeader(frame, { command, payloadLength, contentType = 0 }) {
  assert.equal(frame[1], command);
  assert.equal(frame[0] >> 4, contentType);
  assert.equal(frame[2], 0, 'single-frame request must have frame index 0');
  assert.equal(frame[3], payloadLength);
  assert.equal(frame.length, payloadLength + 4);
}

function hasConnectionState(events, state) {
  return events.some((event) => event.type === 'dokidoki:connection-state' && event.detail.state === state);
}

function encryptV1(payload, shiftValue, algorithmIndex) {
  return payload.map((value, index) => {
    const delta = algorithmIndex === 0
      ? shiftValue
      : algorithmIndex === 1
        ? shiftValue + index
        : algorithmIndex === 2
          ? -shiftValue
          : index % 2 === 0
            ? shiftValue
            : -shiftValue;
    return (value + delta) & 0xff;
  });
}

function manufacturerPayload({ fmsk = 0x00 } = {}) {
  return [
    0xff,
    0xc5,
    0x5f,
    0xb3,
    fmsk,
    0x00,
    0x01,
    0x14,
    0x01,
    0x20,
    0x21,
    0x22,
    0x23,
    0x24,
    0x25
  ];
}

function standardDevice(DokiDokiWebBluetooth, protocol) {
  const device = new DokiDokiWebBluetooth();
  device.profile = protocol.getDeviceProfile('DK-META2');
  device.device = { gatt: { connected: true } };
  device.connectionGeneration = 1;
  return device;
}

function encryptedFfb4Value({ framed = true, validChecksum = true } = {}) {
  const body = [0x42, 0x10];
  const plainPayload = [...body, validChecksum ? checksum(body) : 0x00];
  const wirePayload = encryptV1(plainPayload, 202, 1);
  if (!framed) return new Uint8Array(wirePayload);
  return buildRawFrame({
    contentType: 0,
    msgId: 0,
    command: 0x01,
    payload: wirePayload
  });
}

function createSecureReadGatt(readValue) {
  return createGattMock({
    includeRead: true,
    readValue,
    onWrite: async (frame, emitNotify) => {
      const payload = framePayload(frame);
      if (frame[1] === 0x0c) {
        emitNotify(buildRawFrame({
          contentType: 2,
          msgId: frame[0] & 0x0f,
          command: 0x0d,
          payload: manufacturerPayload({ fmsk: 0x08 })
        }));
      } else if (frame[1] === 0x0b && payload[0] === 0x01) {
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x0a,
          payload: SECURITY_VECTOR.challengePayload
        }));
      } else if (frame[1] === 0x0b && payload[0] === 0x02) {
        // The initial business transaction is read from FFB4, so Auth has no notify reply.
      }
    }
  });
}

for (const contentType of [0, 2]) {
  test(`unknown-device Manufacturer query falls back to legacy 0x0A/0x0B content type ${contentType}`, async () => {
    const { protocol, DokiDokiWebBluetooth } = loadRuntime();
    const device = standardDevice(DokiDokiWebBluetooth, protocol);
    const writes = [];
    device.writeFrame = async (frame) => {
      const bytes = Array.from(frame);
      writes.push(bytes);
      if (bytes[1] === 0x0a) {
        device.handleStandardNotify(buildRawFrame({
          contentType,
          msgId: bytes[0] & 0x0f,
          command: 0x0b,
          payload: manufacturerPayload()
        }));
      }
    };

    const result = await device.queryManufacturerData({ generation: 1, timeout: 10 });

    assert.deepEqual(writes.map((frame) => frame[1]), [0x0c, 0x0a]);
    assertWireHeader(writes[0], { command: 0x0c, payloadLength: 0, contentType: 2 });
    assertWireHeader(writes[1], { command: 0x0a, payloadLength: 0, contentType: 0 });
    assert.equal(result.productId, 0x00011401);
    assert.equal(result.requiresSecurity, false);
    assert.deepEqual(Array.from(result.mac), [0x20, 0x21, 0x22, 0x23, 0x24, 0x25]);
  });
}

test('Manufacturer reply requires a 15-byte raw payload and accepts legacy MsgID zero only while pending', async () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const device = standardDevice(DokiDokiWebBluetooth, protocol);
  device.writeFrame = async () => {};

  const pending = device.queryManufacturerData({ generation: 1, timeout: 100 });
  await Promise.resolve();
  device.handleStandardNotify(buildRawFrame({
    contentType: 2,
    msgId: 0,
    command: 0x0d,
    payload: manufacturerPayload().slice(0, 14)
  }));

  device.handleStandardNotify(buildRawFrame({
    contentType: 2,
    msgId: 0,
    command: 0x0d,
    payload: manufacturerPayload()
  }));
  const result = await pending;
  assert.equal(result.productId, 0x00011401);
  assert.equal(result.requiresSecurity, false);
  assert.deepEqual(Array.from(result.mac), [0x20, 0x21, 0x22, 0x23, 0x24, 0x25]);

  // A late reply after the request context is closed must be ignored.
  const eventCount = device.pendingManufacturerQuery;
  device.handleStandardNotify(buildRawFrame({
    contentType: 2,
    msgId: 0,
    command: 0x0d,
    payload: manufacturerPayload()
  }));
  assert.equal(device.pendingManufacturerQuery, eventCount);
});

test('shipped query format and legacy PID order resolve the same canonical product', async () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const device = standardDevice(DokiDokiWebBluetooth, protocol);
  device.writeFrame = async () => {};
  const pending = device.queryManufacturerData({ generation: 1, timeout: 100 });
  await Promise.resolve();
  const shipped = [...manufacturerPayload({ fmsk: 0x08 }).slice(1), 0, 0];
  // v2 preserves the historical PID wire order; the trusted product table resolves it.
  shipped[2] = 0xb2;
  device.handleStandardNotify(buildRawFrame({
    contentType: 0, msgId: 0, command: 0x0d,
    payload: [...shipped.slice(0, 15), 1]
  }));
  assert.notEqual(device.pendingManufacturerQuery, null);
  device.handleStandardNotify(buildRawFrame({
    contentType: 0, msgId: 0, command: 0x0d, payload: shipped
  }));
  device.manufacturerData = await pending;
  device.validateProfileAgainstManufacturer();
  assert.equal(device.manufacturerData.productId, 0x01140100);
  assert.equal(device.manufacturerData.canonicalProductId, 0x00011401);
  assert.equal(device.manufacturerData.requiresSecurity, true);
  const modern = [...manufacturerPayload()];
  modern.splice(5, 4, 0x01, 0x14, 0x01, 0x00);
  device.manufacturerData = protocol.parseManufacturerDataPayload(modern);
  assert.throws(() => device.validateProfileAgainstManufacturer(), /PID/);
});

test('V1 payload transform is reversible and secure payload is blocked before authentication', () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const device = standardDevice(DokiDokiWebBluetooth, protocol);
  device.manufacturerData = { requiresSecurity: true };
  device.securityState = 'secure';
  device.securitySession = { shiftValue: 2, algorithmIndex: 1 };

  const encrypted = device.transformPayload([0x00, 0x7f, 0xff], true);
  assert.deepEqual(encrypted, [0x02, 0x82, 0x03]);
  assert.deepEqual(device.transformPayload(encrypted, false), [0x00, 0x7f, 0xff]);

  device.securityState = 'unknown';
  assert.throws(() => device.normalizeIncomingPayload({ command: 0x02, payload: [0x01] }), /安全会话/);
});

test('secure connect performs query, authentication, confirmation, then reaches ready', async () => {
  let device;
  const clearedSessions = [];
  const mock = createGattMock({
    onWrite: async (frame, emitNotify) => {
      const command = frame[1];
      const payload = framePayload(frame);
      if (command === 0x0c) {
        assertWireHeader(frame, { command: 0x0c, payloadLength: 0, contentType: 2 });
        emitNotify(buildRawFrame({
          contentType: 2,
          msgId: frame[0] & 0x0f,
          command: 0x0d,
          payload: manufacturerPayload({ fmsk: 0x08 })
        }));
      } else if (command === 0x0b && payload[0] === 0x01) {
        assertWireHeader(frame, { command: 0x0b, payloadLength: SECURITY_VECTOR.initPayload.length });
        assert.deepEqual(payload, SECURITY_VECTOR.initPayload);
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x0a,
          payload: SECURITY_VECTOR.challengePayload
        }));
      } else if (command === 0x0b && payload[0] === 0x02) {
        assertWireHeader(frame, { command: 0x0b, payloadLength: SECURITY_VECTOR.authPayload.length });
        assert.deepEqual(payload, SECURITY_VECTOR.authPayload);
      } else if (command === 0x02 && device?.securitySession) {
        const plain = [0xef, 0x01];
        const expectedWirePayload = encryptV1([...plain, checksum(plain)], 202, 1);
        assertWireHeader(frame, { command: 0x02, payloadLength: expectedWirePayload.length });
        assert.deepEqual(payload, expectedWirePayload);
        const responsePayload = [...expectedWirePayload];
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x03,
          payload: responsePayload
        }));
      }
    }
  });
  const { events, protocol, DokiDokiWebBluetooth } = loadRuntime({
    bluetooth: mock.bluetooth,
    syncdo: {
      async beginBleSecurity() {
        return { sessionId: 'connect-session', initPayload: SECURITY_VECTOR.initPayload };
      },
      async completeBleSecurity({ challengePayload }) {
        assert.deepEqual(Array.from(challengePayload), SECURITY_VECTOR.challengePayload);
        return { authPayload: SECURITY_VECTOR.authPayload, shiftValue: 202, algorithmIndex: 1 };
      },
      async clearBleSecurity(sessionId) {
        clearedSessions.push(sessionId);
      }
    }
  });
  device = new DokiDokiWebBluetooth();
  const result = await device.connect();
  device.stopHeartbeat();

  assert.equal(result.securityState, 'secure');
  assert.equal(result.manufacturerData.requiresSecurity, true);
  assert.deepEqual(mock.writes.map((frame) => frame[1]).slice(0, 4), [0x0c, 0x0b, 0x0b, 0x02]);
  const states = events
    .filter((event) => event.type === 'dokidoki:connection-state')
    .map((event) => event.detail.state);
  assert.deepEqual(states.slice(0, 5), ['connecting', 'identifying', 'authenticating', 'ready']);
  const writesBeforeDisconnect = mock.writes.length;
  await device.disconnect({ skipPause: true });
  assert.deepEqual(clearedSessions, ['connect-session']);
  assert.equal(device.securitySession, null);
  await assert.rejects(device.sendCommand(0x02, 0x01), /未连接|连接/i);
  assert.equal(mock.writes.length, writesBeforeDisconnect);
});

for (const [label, framed] of [
  ['framed', true],
  ['legacy unframed', false]
]) {
  test(`secure connect accepts ${label} encrypted FFB4 MCU_UPLOAD and skips the EF probe`, async () => {
    const mock = createSecureReadGatt(() => encryptedFfb4Value({ framed }));
    const { events, DokiDokiWebBluetooth } = loadRuntime({
      bluetooth: mock.bluetooth,
      syncdo: {
        async beginBleSecurity() {
          return { sessionId: `ffb4-${label}`, initPayload: SECURITY_VECTOR.initPayload };
        },
        async completeBleSecurity({ challengePayload }) {
          assert.deepEqual(Array.from(challengePayload), SECURITY_VECTOR.challengePayload);
          return { authPayload: SECURITY_VECTOR.authPayload, shiftValue: 202, algorithmIndex: 1 };
        },
        async clearBleSecurity() {}
      }
    });
    const device = new DokiDokiWebBluetooth();
    const result = await device.connect();
    device.stopHeartbeat();

    assert.equal(result.securityState, 'secure');
    assert.deepEqual(mock.writes.map((frame) => frame[1]), [0x0c, 0x0b, 0x0b]);
    assert.equal(mock.writes.some((frame) => frame[1] === 0x02), false);
    assert.equal(hasConnectionState(events, 'ready'), true);
    await device.disconnect({ skipPause: true });
  });
}

test('invalid encrypted FFB4 checksum fails before ready and never falls back to EF', async () => {
  const mock = createSecureReadGatt(() => encryptedFfb4Value({ framed: true, validChecksum: false }));
  const { events, DokiDokiWebBluetooth } = loadRuntime({
    bluetooth: mock.bluetooth,
    syncdo: {
      async beginBleSecurity() {
        return { sessionId: 'ffb4-bad-checksum', initPayload: SECURITY_VECTOR.initPayload };
      },
      async completeBleSecurity() {
        return { authPayload: SECURITY_VECTOR.authPayload, shiftValue: 202, algorithmIndex: 1 };
      },
      async clearBleSecurity() {}
    }
  });
  const device = new DokiDokiWebBluetooth();

  await assert.rejects(device.connect(), /FFB4|checksum/i);
  assert.deepEqual(mock.writes.map((frame) => frame[1]), [0x0c, 0x0b, 0x0b]);
  assert.equal(mock.writes.some((frame) => frame[1] === 0x02), false);
  assert.equal(hasConnectionState(events, 'ready'), false);
  assert.equal(hasConnectionState(events, 'failed'), true);
});

test('FFB4 read timeout fails before ready and never falls back to EF', async () => {
  const mock = createSecureReadGatt(() => new Promise(() => {}));
  const { events, DokiDokiWebBluetooth } = loadRuntime({
    bluetooth: mock.bluetooth,
    syncdo: {
      async beginBleSecurity() {
        return { sessionId: 'ffb4-timeout', initPayload: SECURITY_VECTOR.initPayload };
      },
      async completeBleSecurity() {
        return { authPayload: SECURITY_VECTOR.authPayload, shiftValue: 202, algorithmIndex: 1 };
      },
      async clearBleSecurity() {}
    }
  });
  const device = new DokiDokiWebBluetooth();

  await assert.rejects(device.connect(), /FFB4.*超时|超时/i);
  assert.deepEqual(mock.writes.map((frame) => frame[1]), [0x0c, 0x0b, 0x0b]);
  assert.equal(mock.writes.some((frame) => frame[1] === 0x02), false);
  assert.equal(hasConnectionState(events, 'ready'), false);
  assert.equal(hasConnectionState(events, 'failed'), true);
});

test('secure proof failure rejects connect before Auth or business writes', async () => {
  let device;
  const mock = createGattMock({
    onWrite: async (frame, emitNotify) => {
      if (frame[1] === 0x0c) {
        emitNotify(buildRawFrame({
          contentType: 2,
          msgId: frame[0] & 0x0f,
          command: 0x0d,
          payload: manufacturerPayload({ fmsk: 0x08 })
        }));
      } else if (frame[1] === 0x0b && framePayload(frame)[0] === 0x01) {
        const badChallenge = [...SECURITY_VECTOR.challengePayload];
        badChallenge[15] ^= 0xff;
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x0a,
          payload: badChallenge
        }));
      }
    }
  });
  const { events, DokiDokiWebBluetooth } = loadRuntime({
    bluetooth: mock.bluetooth,
    syncdo: {
      async beginBleSecurity() {
        return { sessionId: 'proof-failure', initPayload: SECURITY_VECTOR.initPayload };
      },
      async completeBleSecurity() {
        throw new Error('device proof rejected');
      },
      async clearBleSecurity() {}
    }
  });
  device = new DokiDokiWebBluetooth();
  await assert.rejects(device.connect(), /proof|安全|Challenge/i);
  device.stopHeartbeat();
  assert.deepEqual(mock.writes.map((frame) => frame[1]), [0x0c, 0x0b]);
  assert.equal(hasConnectionState(events, 'ready'), false);
  assert.equal(hasConnectionState(events, 'failed'), true);
});

test('authentication 0x0F failure rejects immediately before the confirmation business request', async () => {
  let device;
  let authErrorObservedWhileNativeWritePending = false;
  const mock = createGattMock({
    onWrite: async (frame, emitNotify) => {
      if (frame[1] === 0x0c) {
        emitNotify(buildRawFrame({
          contentType: 2,
          msgId: frame[0] & 0x0f,
          command: 0x0d,
          payload: manufacturerPayload({ fmsk: 0x08 })
        }));
      } else if (frame[1] === 0x0b && framePayload(frame)[0] === 0x01) {
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x0a,
          payload: SECURITY_VECTOR.challengePayload
        }));
      } else if (frame[1] === 0x0b && framePayload(frame)[0] === 0x02) {
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x0f,
          payload: [0xe5, 0x01, 0x00]
        }));
        // The notify error arrives before the native write promise settles. This catches
        // implementations that only inspect errors after replacing the pending auth context.
        authErrorObservedWhileNativeWritePending = Boolean(device?.pendingSecurityAuth?.error);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  });
  const { events, DokiDokiWebBluetooth } = loadRuntime({
    bluetooth: mock.bluetooth,
    syncdo: {
      async beginBleSecurity() {
        return { sessionId: 'auth-error', initPayload: SECURITY_VECTOR.initPayload };
      },
      async completeBleSecurity() {
        return { authPayload: SECURITY_VECTOR.authPayload, shiftValue: 202, algorithmIndex: 1 };
      },
      async clearBleSecurity() {}
    }
  });
  device = new DokiDokiWebBluetooth();
  await assert.rejects(device.connect(), /认证|安全|协议|0xE5|0xe5|失败/i);
  assert.equal(authErrorObservedWhileNativeWritePending, true);
  assert.deepEqual(mock.writes.map((frame) => frame[1]), [0x0c, 0x0b, 0x0b]);
  assert.equal(hasConnectionState(events, 'ready'), false);
  assert.equal(hasConnectionState(events, 'failed'), true);
});

test('connect timeout for unknown security state falls back to legacy 0x0A before failing', async () => {
  const mock = createGattMock({ onWrite: async () => {} });
  const { events, protocol, DokiDokiWebBluetooth } = loadRuntime({ bluetooth: mock.bluetooth });
  const device = new DokiDokiWebBluetooth();
  const originalQuery = device.queryManufacturerData.bind(device);
  device.queryManufacturerData = ({ generation }) => originalQuery({ generation, timeout: 10 });

  await assert.rejects(device.connect(), /超时/);
  assert.deepEqual(mock.writes.map((frame) => frame[1]), [0x0c, 0x0a]);
  assertWireHeader(mock.writes[1], { command: 0x0a, payloadLength: 0, contentType: 0 });
  assert.equal(hasConnectionState(events, 'ready'), false);
  assert.equal(hasConnectionState(events, 'failed'), true);
  assert.equal(protocol.getDeviceProfile('DK-META2').securityMode, undefined);
});

test('unsupported 0x0C query falls back to legacy discovery without sending business traffic', async () => {
  const mock = createGattMock({
    onWrite: async (frame, emitNotify) => {
      if (frame[1] === 0x0c) {
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x0f,
          payload: [0x01, 0x0c]
        }));
      }
    }
  });
  const { events, DokiDokiWebBluetooth } = loadRuntime({ bluetooth: mock.bluetooth });
  const device = new DokiDokiWebBluetooth();
  const originalQuery = device.queryManufacturerData.bind(device);
  device.queryManufacturerData = ({ generation }) => originalQuery({ generation, timeout: 10 });

  await assert.rejects(device.connect(), /超时/);
  assert.deepEqual(mock.writes.map((frame) => frame[1]), [0x0c, 0x0a]);
  assert.equal(mock.writes.some((frame) => frame[1] === 0x02), false);
  assert.equal(hasConnectionState(events, 'ready'), false);
  assert.equal(hasConnectionState(events, 'failed'), true);
});

test('known secure manufacturer metadata never falls back after a modern query timeout', async () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const device = standardDevice(DokiDokiWebBluetooth, protocol);
  const writes = [];
  device.manufacturerData = { requiresSecurity: true };
  device.writeFrame = async (frame) => writes.push(Array.from(frame));

  await assert.rejects(
    device.queryManufacturerData({ generation: 1, timeout: 10 }),
    /超时/
  );

  assert.deepEqual(writes.map((frame) => frame[1]), [0x0c]);
});

test('disconnect during authentication rejects the old connection and ignores its late challenge', async () => {
  let device;
  let challengeEmitter;
  const mock = createGattMock({
    onWrite: async (frame, emitNotify) => {
      if (frame[1] === 0x0c) {
        emitNotify(buildRawFrame({
          contentType: 2,
          msgId: frame[0] & 0x0f,
          command: 0x0d,
          payload: manufacturerPayload({ fmsk: 0x08 })
        }));
      } else if (frame[1] === 0x0b && framePayload(frame)[0] === 0x01) {
        challengeEmitter = () => emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x0a,
          payload: SECURITY_VECTOR.challengePayload
        }));
      }
    }
  });
  const { events, DokiDokiWebBluetooth } = loadRuntime({
    bluetooth: mock.bluetooth,
    syncdo: {
      async beginBleSecurity() {
        return { sessionId: 'disconnect-auth', initPayload: SECURITY_VECTOR.initPayload };
      },
      async completeBleSecurity() {
        return { authPayload: SECURITY_VECTOR.authPayload, shiftValue: 202, algorithmIndex: 1 };
      },
      async clearBleSecurity() {}
    }
  });
  device = new DokiDokiWebBluetooth();
  const connectPromise = device.connect();
  for (let attempt = 0; attempt < 20 && !challengeEmitter; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(typeof challengeEmitter, 'function');
  mock.device.emitDisconnect();
  challengeEmitter();
  await assert.rejects(connectPromise, /断开|失效|Challenge|连接/i);
  assert.equal(hasConnectionState(events, 'ready'), false);
  assert.equal(hasConnectionState(events, 'failed'), true);
  assert.equal(mock.writes.some((frame) => frame[1] === 0x02), false);
});

test('late IPC completion from an old connection cannot overwrite a new connection', async () => {
  let firstCompleteStarted = false;
  let releaseFirstComplete;
  const firstComplete = new Promise((resolve) => {
    releaseFirstComplete = resolve;
  });
  const firstMock = createGattMock({
    onWrite: async (frame, emitNotify) => {
      const payload = framePayload(frame);
      if (frame[1] === 0x0c) {
        emitNotify(buildRawFrame({
          contentType: 2,
          msgId: frame[0] & 0x0f,
          command: 0x0d,
          payload: manufacturerPayload({ fmsk: 0x08 })
        }));
      } else if (frame[1] === 0x0b && payload[0] === 0x01) {
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x0a,
          payload: SECURITY_VECTOR.challengePayload
        }));
      }
    }
  });
  const secondMock = createGattMock({
    onWrite: async (frame, emitNotify) => {
      const payload = framePayload(frame);
      if (frame[1] === 0x0c) {
        emitNotify(buildRawFrame({
          contentType: 2,
          msgId: frame[0] & 0x0f,
          command: 0x0d,
          payload: manufacturerPayload({ fmsk: 0x08 })
        }));
      } else if (frame[1] === 0x0b && payload[0] === 0x01) {
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x0a,
          payload: SECURITY_VECTOR.challengePayload
        }));
      } else if (frame[1] === 0x02) {
        const body = [0xef, 0x01];
        const encrypted = encryptV1([...body, checksum(body)], 202, 1);
        emitNotify(buildRawFrame({
          contentType: 0,
          msgId: frame[0] & 0x0f,
          command: 0x03,
          payload: encrypted
        }));
      }
    }
  });
  const devices = [firstMock.device, secondMock.device];
  let beginCount = 0;
  const { events, DokiDokiWebBluetooth } = loadRuntime({
    bluetooth: {
      async requestDevice() {
        return devices.shift();
      }
    },
    syncdo: {
      async beginBleSecurity() {
        const sessionId = beginCount++ === 0 ? 'old-ipc-session' : 'new-ipc-session';
        return { sessionId, initPayload: SECURITY_VECTOR.initPayload };
      },
      async completeBleSecurity({ sessionId }) {
        if (sessionId === 'old-ipc-session') {
          firstCompleteStarted = true;
          return firstComplete;
        }
        return { authPayload: SECURITY_VECTOR.authPayload, shiftValue: 202, algorithmIndex: 1 };
      },
      async clearBleSecurity() {}
    }
  });
  const device = new DokiDokiWebBluetooth();
  const oldConnect = device.connect();
  for (let attempt = 0; attempt < 50 && !firstCompleteStarted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(firstCompleteStarted, true);

  await device.disconnect({ skipPause: true, silent: true });
  const newConnect = device.connect();
  const newResult = await newConnect;
  device.stopHeartbeat();
  assert.equal(newResult.securityState, 'secure');
  assert.deepEqual(secondMock.writes.map((frame) => frame[1]), [0x0c, 0x0b, 0x0b, 0x02]);
  const failedStatesBeforeOldResolve = events.filter(
    (event) => event.type === 'dokidoki:connection-state' && event.detail.state === 'failed'
  ).length;

  releaseFirstComplete({ authPayload: SECURITY_VECTOR.authPayload, shiftValue: 17, algorithmIndex: 2 });
  await assert.rejects(oldConnect, /失效|断开|连接/i);
  assert.equal(device.securityState, 'secure');
  assert.equal(device.businessReady, true);
  assert.equal(
    events.filter((event) => event.type === 'dokidoki:connection-state' && event.detail.state === 'failed').length,
    failedStatesBeforeOldResolve
  );
  assert.equal(firstMock.writes.some((frame) => frame[1] === 0x02), false);
  await device.disconnect({ skipPause: true });
});

test('standard connect fails when the required Notify characteristic is missing', async () => {
  const mock = createGattMock({ includeNotify: false });
  const { events, DokiDokiWebBluetooth } = loadRuntime({ bluetooth: mock.bluetooth });
  const device = new DokiDokiWebBluetooth();

  // Missing notify is a characteristic contract failure. A generic query timeout would hide
  // that the connection was left half-initialized, so require the implementation to report the
  // missing characteristic itself.
  await assert.rejects(device.connect(), /通知|notify|特征/i);
  assert.equal(hasConnectionState(events, 'ready'), false);
  assert.equal(hasConnectionState(events, 'failed'), true);
});

test('plain and TRYFUN-ONE connections reach ready without the security handshake', async () => {
  const plainMock = createGattMock({
    onWrite: async (frame, emitNotify) => {
      if (frame[1] === 0x0c) {
        emitNotify(buildRawFrame({
          contentType: 2,
          msgId: frame[0] & 0x0f,
          command: 0x0d,
          payload: manufacturerPayload({ fmsk: 0x00 })
        }));
      }
    }
  });
  const plainRuntime = loadRuntime({ bluetooth: plainMock.bluetooth });
  const plain = new plainRuntime.DokiDokiWebBluetooth();
  const plainResult = await plain.connect();
  plain.stopHeartbeat();
  assert.equal(plainResult.securityState, 'plain');
  assert.deepEqual(plainMock.writes.map((frame) => frame[1]), [0x0c]);
  await plain.disconnect({ skipPause: true });

  const yxlMock = createGattMock({ deviceName: 'TRYFUN-ONE', includeNotify: true });
  const yxlRuntime = loadRuntime({ bluetooth: yxlMock.bluetooth });
  const yxl = new yxlRuntime.DokiDokiWebBluetooth();
  const yxlResult = await yxl.connect();
  assert.equal(yxlResult.securityState, 'plain');
  assert.equal(yxlResult.profile, 'TRYFUN-ONE');
  assert.equal(yxlMock.writes.some((frame) => frame[1] === 0x0c), false);
  await yxl.disconnect({ skipPause: true });
});

test('standard disconnect sends a plain-device stop sequence before clearing the connection', async () => {
  const mock = createGattMock({
    onWrite: async (frame, emitNotify) => {
      if (frame[1] === 0x0c) {
        emitNotify(buildRawFrame({
          contentType: 2,
          msgId: frame[0] & 0x0f,
          command: 0x0d,
          payload: manufacturerPayload({ fmsk: 0x00 })
        }));
      }
    }
  });
  const { DokiDokiWebBluetooth } = loadRuntime({ bluetooth: mock.bluetooth });
  const device = new DokiDokiWebBluetooth();
  await device.connect();
  device.stopHeartbeat();
  await device.disconnect();

  const stopFrames = mock.writes.slice(1).filter((frame) => frame[1] === 0x02);
  assert.ok(stopFrames.length >= 3);
  assert.deepEqual(stopFrames.map((frame) => frame[4]), [0x0b, 0x0e, 0x08]);
  assert.equal(device.profile, null);
  assert.equal(device.securityState, 'unknown');
});

test('a reconnect waits for an in-flight disconnect before replacing the connection', async () => {
  let requestCount = 0;
  const oldGatt = {
    connected: true,
    disconnect() {
      this.connected = false;
    }
  };
  const newDevice = {
    name: 'DK-META2',
    id: 'new-device',
    gatt: {
      connected: false,
      disconnect() {
        this.connected = false;
      }
    },
    addEventListener() {}
  };
  const { protocol, DokiDokiWebBluetooth } = loadRuntime({
    bluetooth: {
      async requestDevice() {
        requestCount += 1;
        return newDevice;
      }
    }
  });
  const device = new DokiDokiWebBluetooth();
  device.device = { name: 'DK-META2', id: 'old-device', gatt: oldGatt };
  device.profile = protocol.getDeviceProfile('DK-META2');
  device.connectionGeneration = 1;
  device.connectionState = 'ready';
  device.businessReady = true;
  device.securityState = 'plain';

  let releasePause;
  let pauseStarted;
  const pauseStartedPromise = new Promise((resolve) => {
    pauseStarted = resolve;
  });
  const pauseGate = new Promise((resolve) => {
    releasePause = resolve;
  });
  device.actionPause = async () => {
    pauseStarted();
    await pauseGate;
  };
  device.connectGattWithRetry = async () => {
    device.device.gatt.connected = true;
    return {};
  };
  device.resolveCharacteristics = async () => {};
  device.queryManufacturerData = async () => ({
    requiresSecurity: false,
    productId: 0x00011401,
    canonicalProductId: 0x00011401,
    mac: [0x20, 0x21, 0x22, 0x23, 0x24, 0x25]
  });
  device.validateProfileAgainstManufacturer = () => {};
  device.startHeartbeat = () => {};

  const oldDisconnect = device.disconnect({ silent: true });
  await pauseStartedPromise;
  const reconnect = device.connect();
  await Promise.resolve();
  assert.equal(requestCount, 0, 'reconnect must wait for the old disconnect operation');

  releasePause();
  await oldDisconnect;
  const result = await reconnect;
  assert.equal(result.id, 'new-device');
  assert.equal(device.device.id, 'new-device');
  assert.equal(device.profile.name, 'DK-META2');
  assert.equal(device.connectionState, 'ready');
  assert.equal(device.businessReady, true);
});

test('an old disconnect only clears the session it captured before waiting', async () => {
  const clearedSessions = [];
  const { protocol, DokiDokiWebBluetooth } = loadRuntime({
    syncdo: {
      async clearBleSecurity(sessionId) {
        clearedSessions.push(sessionId);
      }
    }
  });
  const device = new DokiDokiWebBluetooth();
  device.device = {
    name: 'DK-META2',
    id: 'old-device',
    gatt: {
      connected: true,
      disconnect() {
        this.connected = false;
      }
    }
  };
  device.profile = protocol.getDeviceProfile('DK-META2');
  device.connectionGeneration = 1;
  device.connectionState = 'ready';
  device.securitySessionId = 'old-session';
  device.securitySessionGeneration = 1;

  let releasePause;
  let pauseStarted;
  const pauseStartedPromise = new Promise((resolve) => {
    pauseStarted = resolve;
  });
  const pauseGate = new Promise((resolve) => {
    releasePause = resolve;
  });
  device.actionPause = async () => {
    pauseStarted();
    await pauseGate;
  };

  const disconnect = device.disconnect({ silent: true });
  await pauseStartedPromise;
  // Model a newer lifecycle publishing its session before the old teardown resumes.
  device.securitySessionId = 'new-session';
  device.securitySessionGeneration = 2;
  releasePause();
  await disconnect;

  assert.deepEqual(clearedSessions, ['old-session']);
});

test('a stale heartbeat cannot stop or fail the replacement connection', async () => {
  const heartbeatCallbacks = new Map();
  let nextHeartbeatId = 0;
  const clearedSessions = [];
  const { protocol, DokiDokiWebBluetooth } = loadRuntime({
    timers: {
      setInterval(callback) {
        const id = ++nextHeartbeatId;
        heartbeatCallbacks.set(id, callback);
        return id;
      },
      clearInterval(id) {
        heartbeatCallbacks.delete(id);
      }
    },
    syncdo: {
      async clearBleSecurity(sessionId) {
        clearedSessions.push(sessionId);
      }
    }
  });
  const device = new DokiDokiWebBluetooth();
  device.profile = protocol.getDeviceProfile('DK-META2');
  device.device = { gatt: { connected: true } };
  device.connectionGeneration = 1;
  device.connectionState = 'ready';
  device.businessReady = true;
  device.manufacturerData = {
    cid: 0x5fc5,
    version: 3,
    fmsk: 0x08,
    productId: 0x00011401,
    mac: [0x20, 0x21, 0x22, 0x23, 0x24, 0x25],
    requiresSecurity: true
  };
  device.securityState = 'secure';
  device.securitySession = { shiftValue: 202, algorithmIndex: 1 };
  device.securitySessionId = 'new-session';
  device.securitySessionGeneration = 2;

  let rejectOldHeartbeat;
  let heartbeatCalls = 0;
  device.sendCommandWithResponse = () => {
    heartbeatCalls += 1;
    if (heartbeatCalls === 1) {
      return new Promise((resolve, reject) => {
        rejectOldHeartbeat = reject;
      });
    }
    return Promise.resolve();
  };

  device.startHeartbeat(1);
  const oldHeartbeatId = device.heartbeatInterval;
  const oldHeartbeat = heartbeatCallbacks.get(oldHeartbeatId)();
  device.connectionGeneration = 2;
  device.device = { gatt: { connected: true } };
  device.startHeartbeat(2);
  const newHeartbeatId = device.heartbeatInterval;

  rejectOldHeartbeat(new Error('stale heartbeat'));
  await oldHeartbeat;
  await Promise.resolve();

  assert.equal(device.connectionGeneration, 2);
  assert.equal(device.connectionState, 'ready');
  assert.equal(device.securitySessionId, 'new-session');
  assert.equal(device.heartbeatInterval, newHeartbeatId);
  assert.equal(heartbeatCallbacks.has(newHeartbeatId), true);
  assert.deepEqual(clearedSessions, []);
  device.stopHeartbeat();
});

test('a protocol error with unrelated MsgID zero does not finish Manufacturer Data query', async () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const device = new DokiDokiWebBluetooth();
  device.profile = protocol.getDeviceProfile('DK-META2');
  device.device = { gatt: { connected: true } };
  device.connectionGeneration = 1;
  device.writeFrame = async () => {};

  const pending = device.queryManufacturerData({ generation: 1, timeout: 100 });
  await Promise.resolve();
  const queryMsgId = device.pendingManufacturerQuery.msgId;
  device.handleStandardNotify(buildRawFrame({
    contentType: 0,
    msgId: 0,
    command: 0x0f,
    payload: [0xe1]
  }));
  assert.equal(device.pendingManufacturerQuery.msgId, queryMsgId);

  device.handleStandardNotify(buildRawFrame({
    contentType: 2,
    msgId: queryMsgId,
    command: 0x0d,
    payload: manufacturerPayload()
  }));
  const result = await pending;
  assert.equal(result.productId, 0x00011401);
});

test('legacy advertisement metadata connects without unsupported modern query and preserves secure gating', async () => {
  const mock = createGattMock({});
  mock.device.manufacturerData = manufacturerPayload({ fmsk: 0 }).slice(1);
  const { DokiDokiWebBluetooth } = loadRuntime({ bluetooth: mock.bluetooth });
  const client = new DokiDokiWebBluetooth();
  const result = await client.connect();
  client.stopHeartbeat();
  assert.equal(result.securityState, 'plain');
  assert.equal(result.manufacturerData.source, 'advertisement');
  assert.equal(mock.writes.some(frame => frame[1] === 0x0c), false);
  await client.disconnect({ skipPause: true });

  const secureMock = createGattMock({});
  secureMock.device.manufacturerData = manufacturerPayload({ fmsk: 8 }).slice(1);
  const secure = loadRuntime({ bluetooth: secureMock.bluetooth });
  const secureClient = new secure.DokiDokiWebBluetooth();
  await assert.rejects(secureClient.connect(), /安全密钥服务/);
  assert.equal(secureClient.businessReady, false);
  assert.equal(secureMock.writes.some(frame => frame[1] === 2), false);
});
