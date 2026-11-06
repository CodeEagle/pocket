import { test, expect } from 'bun:test';
import { TftcClient, DATA_KEY, getDeviceProfile, buildProtocolFrame, parseProtocolFrame, decodeAttributes } from '../src/index.js';

function deviceClient() {
  const client = new TftcClient();
  client.profile = getDeviceProfile('DK-META2');
  client.device = { gatt: { connected: true } };
  client.businessReady = true;
  client.securityState = 'plain';
  return client;
}

test('battery query resolves only a matching checked reply and reports observed compact state', async () => {
  const client = deviceClient();
  const states = [];
  client.on('state', event => states.push(event.detail));
  client.writeChar = { async writeValueWithResponse(frame) {
    const query = parseProtocolFrame(frame);
    expect(query.command).toBe(6);
    expect(query.payload).toEqual([0x20, 0xe0]);
    client.handleStandardNotify(buildProtocolFrame(7, [0x20, (42 << 2) | 2], { msgId: query.msgId, includeChecksum: true }));
  } };
  const result = await client.queryKeys([DATA_KEY.BATTERY_COMPACT_STATUS]);
  expect(result.battery).toBe(42);
  expect(result.batteryStatus).toBe(2);
  expect(result.isWorking).toBeNull();
  expect(states.length).toBe(1);
});

test('corrupt generic reply rejects query without changing device facts', async () => {
  const client = deviceClient();
  client.writeChar = { async writeValueWithResponse(frame) {
    const query = parseProtocolFrame(frame);
    client.handleStandardNotify(buildProtocolFrame(7, [0x21, 0x15, 0], { msgId: query.msgId }));
  } };
  await expect(client.queryKeys([DATA_KEY.DEVICE_COMPACT_STATUS])).rejects.toThrow('checksum');
  expect(client.status().isWorking).toBeNull();
  expect(client.pendingRequests.size).toBe(0);
});

test('generic query timeout and disconnect clean pending requests', async () => {
  const client = deviceClient();
  client.writeChar = { async writeValueWithResponse() {} };
  await expect(client.queryKeys([DATA_KEY.BATTERY], { timeout: 5 })).rejects.toThrow();
  expect(client.pendingRequests.size).toBe(0);
  const pending = client.queryKeys([DATA_KEY.DEVICE_COMPACT_STATUS]);
  client.handleConnectionLost('test');
  await expect(pending).rejects.toThrow();
  expect(client.pendingRequests.size).toBe(0);
});

test('attributes retain little-endian source semantics and reject truncation', () => {
  expect(decodeAttributes([0x23, 0x34, 0x12]).get(DATA_KEY.LINER_LIFE)).toBe(0x1234);
  expect(() => decodeAttributes([0x23, 0x34])).toThrow('Truncated');
  expect(() => decodeAttributes([0x77, 1])).toThrow('Unknown');
});

test('parallel clients allocate IDs independently and reject non-finite controls before a write', async () => {
  const first = deviceClient();
  const second = deviceClient();
  expect(first.allocateMessageId()).toBe(1);
  expect(first.allocateMessageId()).toBe(2);
  expect(second.allocateMessageId()).toBe(1);
  await expect(first.setLinear(NaN)).rejects.toThrow('finite');
  await expect(first.writeSingle('unknown', 1)).rejects.toThrow('Unsupported');
});

test('chooser rejection leaves an observable failed state and permits a later attempt', async () => {
  let attempts = 0;
  const client = new TftcClient({ bluetooth: { async requestDevice() { attempts++; throw new Error('cancelled'); } } });
  await expect(client.connect()).rejects.toThrow('cancelled');
  expect(client.status().connectionState).toBe('failed');
  expect(client.status().connected).toBe(false);
  await expect(client.connect()).rejects.toThrow('cancelled');
  expect(attempts).toBe(2);
});

test('unsupported YXL capability rejects before starting work control', async () => {
  const client = deviceClient();
  client.profile = getDeviceProfile('TRYFUN-ONE');
  const writes = [];
  client.writeChar = { async writeValueWithResponse(frame) { writes.push([...frame]); } };
  await expect(client.setVibration(30)).rejects.toThrow('不支持');
  expect(writes).toEqual([]);
});

test('NAV app commands preserve standalone writes through the real client queue', async () => {
  const client = deviceClient();
  client.profile = { name: 'NAV', protocol: 'dokidoki', commands: { vibration: 9, linear: 12 } };
  const payloads = [];
  client.writeChar = { async writeValueWithResponse(frame) { payloads.push(parseProtocolFrame(frame).payload); } };
  await client.executeCommands({ CUSTOM_FE: 1, vibration: 0, CUSTOM_FF: 99 });
  expect(payloads).toEqual([[0xfe,1,1], [7,2,247], [0xff,0,1]]);
  payloads.length = 0;
  client.attributes.set(DATA_KEY.VIBRATION_SWITCH, 1);
  client.attributes.set(DATA_KEY.TELESCOPIC_SWITCH, 3);
  await client.pause();
  expect(payloads).toEqual([[7,2,247]]);
  payloads.length = 0;
  await client.stop();
  expect(payloads).toEqual([[0xff,0,1]]);
});

test('unmigrated app batch mappings reject while raw attribute writes remain explicit', async () => {
  const client = deviceClient();
  const payloads = [];
  client.writeChar = { async writeValueWithResponse(frame) { payloads.push(parseProtocolFrame(frame).payload); } };
  await expect(client.executeCommands({ vibration: 20 })).rejects.toThrow('mapping is unavailable');
  expect(payloads).toEqual([]);
  await client.writePairs({ vibration: 20 });
  expect(payloads).toEqual([[8,20,228]]);
});
