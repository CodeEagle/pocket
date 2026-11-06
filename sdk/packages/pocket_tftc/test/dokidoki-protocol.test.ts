import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { TftcClient } from '../src/client.js';
import * as protocolModule from '../src/protocol.js';

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

function loadProtocol() {
  return loadRuntime().protocol;
}

test('buildCommandFrame matches dokidoki BLE frame layout and checksum', () => {
  const protocol = loadProtocol();
  protocol.resetMessageId();

  const frame = Array.from(protocol.buildCommandFrame(0x0b, 50));

  assert.deepEqual(frame, [0x01, 0x02, 0x00, 0x03, 0x0b, 0x32, 0xc3]);
});

test('message id increments and wraps in the low nibble', () => {
  const protocol = loadProtocol();
  protocol.resetMessageId();

  const ids = [];
  for (let index = 0; index < 17; index += 1) {
    ids.push(protocol.buildCommandFrame(0x08, index)[0] & 0x0f);
  }

  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1, 2]);
});

test('device profile names and TF aliases match dokidoki source expectations', () => {
  const protocol = loadProtocol();

  assert.equal(protocol.SERVICE_UUID, '0000ffac-0000-1000-8000-00805f9b34fb');
  assert.equal(protocol.SERVICE_SHORT_UUID, 'ffac');
  assert.equal(protocol.getDeviceProfile('TF-BHSE').name, 'DK-BHSE');
  assert.equal(protocol.getDeviceProfile('TRYFUN-ONE').name, 'TRYFUN-ONE');
  assert.deepEqual(JSON.parse(JSON.stringify(protocol.getDeviceProfile('DK-META2').commands)), {
    vibration: 0x08,
    linear: 0x0b,
    rotary: 0x0e
  });
  assert.equal(protocol.getDeviceProfile('DK-META3'), undefined);
});

test('buildYxlOneFrame matches TRYFUN-ONE 0xaa frame layout and checksum', () => {
  const protocol = loadProtocol();

  assert.deepEqual(Array.from(protocol.buildYxlOneFrame(0x03, 0x00)), [0xaa, 0x02, 0x03, 0x00, 0xfd]);
  assert.deepEqual(Array.from(protocol.buildYxlOneFrame(0x03, 0x01)), [0xaa, 0x02, 0x03, 0x01, 0xfc]);
  assert.deepEqual(Array.from(protocol.buildYxlOneFrame(0x07, 0x09)), [0xaa, 0x02, 0x07, 0x09, 0xf0]);
});

test('motion mapping includes rotary when a profile supports linear and rotary', () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const dokidoki = new DokiDokiWebBluetooth();
  dokidoki.profile = protocol.getDeviceProfile('DK-META2');

  const actions = dokidoki.mapMotionToActions(
    { intensity: 50, speed: 60, depth: 70 },
    { maxOutput: 100, sensitivity: 1 }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(actions.map(([action]) => action))), ['linear', 'vibration', 'rotary']);
  assert.ok(actions.find(([action, value]) => action === 'rotary' && value > 0));
});

test('DokiDoki profile max output scales final action values', () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const dokidoki = new DokiDokiWebBluetooth();
  dokidoki.profile = protocol.getDeviceProfile('DK-META2');

  const fullOutput = dokidoki.mapMotionToActions(
    { intensity: 45, speed: 60, depth: 55 },
    { maxOutput: 100, sensitivity: 1 }
  );
  const limitedOutput = dokidoki.mapMotionToActions(
    { intensity: 45, speed: 60, depth: 55 },
    { maxOutput: 60, sensitivity: 1 }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(fullOutput)), [
    ['linear', 55],
    ['vibration', 49],
    ['rotary', 48]
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(limitedOutput)), [
    ['linear', 33],
    ['vibration', 29],
    ['rotary', 29]
  ]);
});

test('motion mapping converts TRYFUN-ONE motion to 0..9 telescopic and rotation levels', () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const dokidoki = new DokiDokiWebBluetooth();
  dokidoki.profile = protocol.getDeviceProfile('TRYFUN-ONE');

  const actions = dokidoki.mapMotionToActions(
    { intensity: 50, speed: 60, depth: 70 },
    { maxOutput: 100, sensitivity: 1 }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(actions.map(([action]) => action))), ['linear', 'rotary']);
  assert.ok(actions.every(([, value]) => Number.isInteger(value) && value >= 0 && value <= 9));
  assert.ok(actions.find(([action, value]) => action === 'linear' && value > 0));
  assert.ok(actions.find(([action, value]) => action === 'rotary' && value > 0));
});

test('TRYFUN-ONE max output limits final motor levels', () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const dokidoki = new DokiDokiWebBluetooth();
  dokidoki.profile = protocol.getDeviceProfile('TRYFUN-ONE');

  const actions = dokidoki.mapMotionToActions(
    { intensity: 100, speed: 100, depth: 100 },
    { maxOutput: 60, sensitivity: 1 }
  );

  assert.ok(actions.every(([, value]) => value <= 5));
  assert.ok(actions.every(([, value]) => value > 0));
});

test('TRYFUN-ONE notify ack resolves pending command callbacks', async () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const dokidoki = new DokiDokiWebBluetooth();
  const pending = dokidoki.waitForYxlOneAck(0x08);

  dokidoki.handleYxlOneNotify(protocol.buildYxlOneFrame(0x0b, 0x08, 0x01));

  assert.equal(await pending, true);
});

test('TRYFUN-ONE motion epoch cancels stale motor commands after pause', async () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const dokidoki = new DokiDokiWebBluetooth();
  const frames = [];
  dokidoki.profile = protocol.getDeviceProfile('TRYFUN-ONE');
  dokidoki.device = { gatt: { connected: true } };
  dokidoki.businessReady = true;
  dokidoki.yxlOneRunning = true;
  dokidoki.writeChar = {
    async writeValue(frame) {
      const bytes = Array.from(frame);
      frames.push(bytes);
      const cmd = bytes[2];
      const value = bytes[3];
      if (cmd === 0x07 && value > 0) {
        dokidoki.yxlOneMotionEpoch += 1;
      }
    }
  };

  const result = await dokidoki.applyMotionMetrics(
    { status: 'tracking', intensity: 70, speed: 75, depth: 80 },
    { maxOutput: 100, sensitivity: 1, minInterval: 0, minDelta: 1 }
  );

  assert.equal(result.reason, 'paused');
  assert.ok(frames.some((frame) => frame[2] === 0x07 && frame[3] > 0));
  assert.equal(frames.some((frame) => frame[2] === 0x08 && frame[3] > 0), false);
});

test('TRYFUN-ONE hard stop sends all stop commands without notify ack', async () => {
  const { protocol, DokiDokiWebBluetooth } = loadRuntime();
  const dokidoki = new DokiDokiWebBluetooth();
  const frames = [];
  dokidoki.profile = protocol.getDeviceProfile('TRYFUN-ONE');
  dokidoki.device = { gatt: { connected: true } };
  dokidoki.yxlOneRunning = true;
  dokidoki.writeChar = {
    async writeValue(frame) {
      frames.push(Array.from(frame));
    }
  };

  await dokidoki.actionPause();

  assert.equal(dokidoki.yxlOneRunning, false);
  assert.ok(frames.some((frame) => frame[2] === 0x03 && frame[3] === 0));
  assert.ok(frames.filter((frame) => frame[2] === 0x08 && frame[3] === 0).length >= 3);
  assert.ok(frames.some((frame) => frame[2] === 0x07 && frame[3] === 0));
});
