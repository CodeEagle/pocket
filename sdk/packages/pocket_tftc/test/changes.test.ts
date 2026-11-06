import { expect, test } from "bun:test";
import { DATA_KEY } from "../src/data.js";
import { describeAttributeChanges } from "../src/changes.js";

test("suppresses unchanged raw and derived values", () => {
  const attributes = new Map([
    [DATA_KEY.BATTERY_COMPACT_STATUS, 132],
    [DATA_KEY.DEVICE_COMPACT_STATUS, 0],
    [DATA_KEY.LINER_COMPACT_STATUS, 35],
    [DATA_KEY.VIBRATION_LEVEL, 8],
  ]);
  expect(describeAttributeChanges(attributes, new Map(attributes))).toEqual([]);
});

test("splits an initial compact battery notification into raw and semantic changes", () => {
  expect(describeAttributeChanges(
    new Map(),
    new Map([[DATA_KEY.BATTERY_COMPACT_STATUS, 134]]),
  )).toEqual([
    {
      key: DATA_KEY.BATTERY_COMPACT_STATUS,
      dataKey: "BATTERY_COMPACT_STATUS",
      field: "batteryCompactStatus",
      kind: "raw",
      previous: null,
      current: 134,
    },
    {
      key: DATA_KEY.BATTERY_COMPACT_STATUS,
      dataKey: "BATTERY_COMPACT_STATUS",
      field: "battery",
      kind: "derived",
      previous: null,
      current: 33,
    },
    {
      key: DATA_KEY.BATTERY_COMPACT_STATUS,
      dataKey: "BATTERY_COMPACT_STATUS",
      field: "batteryStatus",
      kind: "derived",
      previous: null,
      current: 2,
    },
  ]);
});

test("emits only the changed derived device and liner fields", () => {
  const previous = new Map([
    [DATA_KEY.DEVICE_COMPACT_STATUS, 0x12],
    [DATA_KEY.LINER_COMPACT_STATUS, 0x23],
  ]);
  const next = new Map([
    [DATA_KEY.DEVICE_COMPACT_STATUS, 0x23],
    [DATA_KEY.LINER_COMPACT_STATUS, 0x13],
  ]);
  expect(describeAttributeChanges(previous, next)).toEqual([
    {
      key: DATA_KEY.DEVICE_COMPACT_STATUS,
      dataKey: "DEVICE_COMPACT_STATUS",
      field: "deviceCompactStatus",
      kind: "raw",
      previous: 0x12,
      current: 0x23,
    },
    {
      key: DATA_KEY.DEVICE_COMPACT_STATUS,
      dataKey: "DEVICE_COMPACT_STATUS",
      field: "isWorking",
      kind: "derived",
      previous: false,
      current: true,
    },
    {
      key: DATA_KEY.DEVICE_COMPACT_STATUS,
      dataKey: "DEVICE_COMPACT_STATUS",
      field: "commandFlag",
      kind: "derived",
      previous: 1,
      current: 2,
    },
    {
      key: DATA_KEY.LINER_COMPACT_STATUS,
      dataKey: "LINER_COMPACT_STATUS",
      field: "linerCompactStatus",
      kind: "raw",
      previous: 0x23,
      current: 0x13,
    },
    {
      key: DATA_KEY.LINER_COMPACT_STATUS,
      dataKey: "LINER_COMPACT_STATUS",
      field: "linerId",
      kind: "derived",
      previous: 2,
      current: 1,
    },
  ]);
});

test("represents removal as a null current value and rejects non-Maps", () => {
  expect(describeAttributeChanges(
    new Map([[DATA_KEY.VIBRATION_LEVEL, 8]]),
    new Map(),
  )).toEqual([{
    key: DATA_KEY.VIBRATION_LEVEL,
    dataKey: "VIBRATION_LEVEL",
    field: "vibrationLevel",
    kind: "raw",
    previous: 8,
    current: null,
  }]);
  expect(() => describeAttributeChanges({}, new Map())).toThrow("Map");
});
