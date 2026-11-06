import { DATA_KEY } from "./data.js";

const DATA_KEY_NAME = new Map(
  Object.entries(DATA_KEY).map(([name, key]) => [key, name]),
);

const COMPACT_FIELDS = new Map([
  [DATA_KEY.BATTERY_COMPACT_STATUS, [
    ["battery", (value) => value === null ? null : value >>> 2],
    ["batteryStatus", (value) => value === null ? null : value & 3],
  ]],
  [DATA_KEY.DEVICE_COMPACT_STATUS, [
    ["isWorking", (value) => value === null ? null : Boolean(value & 1)],
    ["workModeState", (value) => value === null ? null : (value >>> 1) & 7],
    ["commandFlag", (value) => value === null ? null : value >>> 4],
  ]],
  [DATA_KEY.LINER_COMPACT_STATUS, [
    ["linerStatus", (value) => value === null ? null : value & 0x0f],
    ["linerId", (value) => value === null ? null : (value >>> 4) & 0x0f],
  ]],
]);

function camelCase(name) {
  return name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function dataKeyName(key) {
  return DATA_KEY_NAME.get(key) ?? `UNKNOWN_0x${key.toString(16).padStart(2, "0").toUpperCase()}`;
}

function observedValue(attributes, key) {
  return attributes.has(key) ? attributes.get(key) : null;
}

function sameValue(left, right) {
  return Object.is(left, right);
}

/**
 * Describe only fields that changed between two checked TFTC attribute maps.
 *
 * A compact attribute produces one `raw` entry when its packed byte changes,
 * followed by `derived` entries for the individual semantic fields that
 * changed. Missing attributes are represented as `null`, including the first
 * observation and a field removed from a later map.
 */
export function describeAttributeChanges(previous, next) {
  if (!(previous instanceof Map) || !(next instanceof Map)) {
    throw new TypeError("previous and next attributes must be Map instances");
  }

  const keys = new Set([...previous.keys(), ...next.keys()]);
  const orderedKeys = [...keys]
    .map((key) => Number(key))
    .filter((key) => Number.isInteger(key) && key >= 0 && key <= 0xff)
    .sort((left, right) => left - right);
  const changes = [];

  for (const key of orderedKeys) {
    const previousValue = observedValue(previous, key);
    const currentValue = observedValue(next, key);
    if (sameValue(previousValue, currentValue)) continue;

    const dataKey = dataKeyName(key);
    changes.push({
      key,
      dataKey,
      field: camelCase(dataKey),
      kind: "raw",
      previous: previousValue,
      current: currentValue,
    });

    const derivedFields = COMPACT_FIELDS.get(key);
    if (!derivedFields) continue;
    for (const [field, derive] of derivedFields) {
      const prior = derive(Number.isInteger(previousValue) ? previousValue : null);
      const current = derive(Number.isInteger(currentValue) ? currentValue : null);
      if (sameValue(prior, current)) continue;
      changes.push({
        key,
        dataKey,
        field,
        kind: "derived",
        previous: prior,
        current,
      });
    }
  }
  return changes;
}
