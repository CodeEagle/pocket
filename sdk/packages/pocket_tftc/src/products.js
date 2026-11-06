/**
 * Application product resolver for the two newer DokiDoki products.
 *
 * The mappings are copied from the retained funapp controllers:
 * `configs/products/dk/11.dk_pt_3_max_device.dart` and
 * `configs/products/dk/12.dk_nav_device.dart`.  This module only resolves
 * application KV commands.  It does not pretend that an arbitrary product's
 * raw `executeCommands` contract is interchangeable with these profiles.
 */

import { DATA_KEY } from "./data.js";
export const DATA_KEYS = DATA_KEY;

export const PRODUCT_IDS = Object.freeze({
  DKPT3MAX: 'dk-mastrb8-hqm04',
  DKASTP: 'dk-mastrb8-xq01',
});

const PT3MAX = Object.freeze({
  id: PRODUCT_IDS.DKPT3MAX,
  name: 'DK-PT3MAX',
  aliases: Object.freeze(['DK-PT3MAX', 'PT3MAX', 'DKPT3MAX', PRODUCT_IDS.DKPT3MAX]),
  kind: 'pt3max',
  supportedOperations: Object.freeze(['commands', 'pause', 'resume', 'stop']),
  limitations: Object.freeze([
    'Application suction levels are 0..4; protocol CVT level 5 is not exposed as a level.',
    'Application vibration levels are 0..7; protocol CVT level 8 is not exposed as a level.',
    'SUCTION_AMP is a two-state CVT flag and is clamped to 0..1.',
  ]),
});

const NAV = Object.freeze({
  id: PRODUCT_IDS.DKASTP,
  name: 'DK-ASTP',
  aliases: Object.freeze(['DK-ASTP', 'NAV', 'DKNAV', 'DKASTP', PRODUCT_IDS.DKASTP]),
  kind: 'nav',
  supportedOperations: Object.freeze(['commands', 'pause', 'resume', 'stop']),
  limitations: Object.freeze([
    'CUSTOM_FE (burst) and CUSTOM_FF (all stop) are standalone writes.',
    'Application levels are 0..9; protocol CVT level 10 is driven by amplitude.',
    'A burst-mode pause uses CUSTOM_FF because motor pause writes are ignored in burst mode.',
  ]),
});

export const PRODUCT_PROFILES = Object.freeze([PT3MAX, NAV]);
export const SUPPORTED_PRODUCT_BEHAVIORS = Object.freeze({
  [PRODUCT_IDS.DKPT3MAX]: PT3MAX,
  [PRODUCT_IDS.DKASTP]: NAV,
});
export const UNSUPPORTED_PRODUCT_BEHAVIORS = Object.freeze([
  'Legacy BBW/LC devices use a separate raw payload protocol and are intentionally not routed through this KV resolver.',
  'YXL-ONE uses its dedicated 0xAA protocol and is intentionally not routed through this resolver.',
  'Other DokiDoki products retain their existing generic profile until their app controller mapping is explicitly migrated.',
]);

const PROFILE_BY_ALIAS = new Map();
for (const profile of PRODUCT_PROFILES) {
  PROFILE_BY_ALIAS.set(profile.id.toLowerCase(), profile);
  PROFILE_BY_ALIAS.set(profile.name.toLowerCase(), profile);
  for (const alias of profile.aliases) PROFILE_BY_ALIAS.set(alias.toLowerCase(), profile);
}

const KEY_BY_CODE = new Map(Object.entries(DATA_KEYS).map(([name, code]) => [code, name]));
const KEY_ALIASES = Object.freeze({
  VIBRATION: 'VIBRATION_LEVEL',
  SUCTION: 'SUCTION_LEVEL',
  TELESCOPIC: 'TELESCOPIC_LEVEL',
  LINEAR: 'TELESCOPIC_LEVEL',
});

function integer(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) throw new TypeError(`${label} must be a finite integer`);
  return value;
}

function clamp(value, min, max, label) {
  return Math.max(min, Math.min(max, integer(value, label)));
}

function normalizeKey(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xff) {
    return KEY_BY_CODE.get(value) || `DATA_KEY_0x${value.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim().replace(/[\s.-]+/g, '_').toUpperCase();
  return KEY_ALIASES[raw] || raw;
}

function codeFor(key) {
  if (Object.prototype.hasOwnProperty.call(DATA_KEYS, key)) return DATA_KEYS[key];
  const match = /^DATA_KEY_0X([0-9A-F]{2})$/.exec(key);
  return match ? Number.parseInt(match[1], 16) : null;
}

function normalizeCommands(commands) {
  const source = commands && typeof commands === 'object' && !Array.isArray(commands) &&
    Object.prototype.hasOwnProperty.call(commands, 'commands') ? commands.commands : commands;
  if (source == null) return [];
  if (Array.isArray(source)) {
    return source.map((item, index) => {
      if (Array.isArray(item)) return { key: item[0], value: item[1], index };
      if (item && typeof item === 'object') {
        return { key: item.key ?? item.channel ?? item.name, value: item.value, index };
      }
      throw new TypeError(`command ${index} must be [key, value] or an object`);
    });
  }
  if (typeof source === 'object') {
    return Object.entries(source).map(([key, value], index) => ({ key, value, index }));
  }
  throw new TypeError('commands must be an array or object');
}

function stateValue(observed, ...keys) {
  const roots = [observed, observed?.state].filter((value) => value && typeof value === 'object');
  for (const key of keys) {
    for (const root of roots) {
      if (Object.prototype.hasOwnProperty.call(root, key)) {
        const value = root[key];
        if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
          return value.value;
        }
        return value;
      }
    }
  }
  return undefined;
}

function switchIs(observed, channel, expected) {
  const value = stateValue(observed, `${channel}Switch`, `${channel}_switch`);
  return expected === 'on' ? value === 1 : value === 2;
}

function makeWrite(key, value, sourceKey, { standalone = false, reason = undefined } = {}) {
  const code = codeFor(key);
  const write = {
    key,
    code,
    value,
    pair: code === null ? null : [code, value],
    sourceKey,
    transport: 'kv',
    standalone: Boolean(standalone),
  };
  if (reason) write.reason = reason;
  return write;
}

function batchesFor(writes) {
  const batches = [];
  let current = [];
  for (const write of writes) {
    if (write.standalone) {
      if (current.length) batches.push(current);
      current = [];
      batches.push([write]);
    } else {
      current.push(write);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function result(profile, writes, unsupported = []) {
  return {
    profile,
    writes,
    batches: batchesFor(writes),
    unsupported,
    limitations: profile?.limitations ? [...profile.limitations] : [...UNSUPPORTED_PRODUCT_BEHAVIORS],
    noOp: writes.length === 0,
  };
}

/** Resolve an app product id or a symbolic resolver alias. These are not verified BLE advertisement names or wire PIDs. */
export function getProductProfile(profileOrName) {
  if (profileOrName && typeof profileOrName === 'object') {
    if (profileOrName.kind === 'pt3max' || profileOrName.kind === 'nav') return profileOrName;
    return getProductProfile(profileOrName.id ?? profileOrName.productId ?? profileOrName.name ?? profileOrName.expectedPid);
  }
  if (Number.isInteger(profileOrName)) return null;
  if (typeof profileOrName !== 'string') return null;
  return PROFILE_BY_ALIAS.get(profileOrName.trim().toLowerCase()) || null;
}

export const resolveProductProfile = getProductProfile;

function resolvePt3Max(commands) {
  const writes = [];
  const unsupported = [];
  for (const command of commands) {
    const key = normalizeKey(command.key);
    if (!key || codeFor(key) === null) {
      unsupported.push({ ...command, reason: 'unknown_data_key' });
      continue;
    }
    const sourceKey = key;
    switch (key) {
      case 'SUCTION_LEVEL': {
        const value = clamp(command.value, 0, 4, key);
        writes.push(makeWrite(value === 0 ? 'SUCTION_SWITCH' : key, value === 0 ? 2 : value, sourceKey));
        break;
      }
      case 'VIBRATION_LEVEL': {
        const value = clamp(command.value, 0, 7, key);
        writes.push(makeWrite(value === 0 ? 'VIBRATION_SWITCH' : key, value === 0 ? 2 : value, sourceKey));
        break;
      }
      case 'SUCTION_AMP':
        writes.push(makeWrite(key, clamp(command.value, 0, 1, key), sourceKey));
        break;
      case 'VIBRATION_AMP':
        writes.push(makeWrite(key, clamp(command.value, 0, 100, key), sourceKey));
        break;
      case 'VIBRATION_SWITCH':
      case 'SUCTION_SWITCH': {
        const value = integer(command.value, key);
        writes.push(makeWrite(key, value <= 0 ? 2 : clamp(value, 1, 2, key), sourceKey));
        break;
      }
      default:
        writes.push(makeWrite(key, integer(command.value, key), sourceKey));
    }
  }
  return { writes, unsupported };
}

function resolveNav(commands) {
  const writes = [];
  const unsupported = [];
  for (const command of commands) {
    const key = normalizeKey(command.key);
    if (!key || codeFor(key) === null) {
      unsupported.push({ ...command, reason: 'unknown_data_key' });
      continue;
    }
    const sourceKey = key;
    switch (key) {
      case 'CUSTOM_FE':
        writes.push(makeWrite(key, clamp(command.value, 0, 1, key), sourceKey, { standalone: true }));
        break;
      case 'CUSTOM_FF':
        writes.push(makeWrite(key, 0, sourceKey, { standalone: true }));
        break;
      case 'VIBRATION_LEVEL': {
        const value = clamp(command.value, 0, 9, key);
        writes.push(makeWrite(value === 0 ? 'VIBRATION_SWITCH' : key, value === 0 ? 2 : value, sourceKey));
        break;
      }
      case 'TELESCOPIC_LEVEL': {
        const value = clamp(command.value, 0, 9, key);
        writes.push(makeWrite(value === 0 ? 'TELESCOPIC_SWITCH' : key, value === 0 ? 2 : value, sourceKey));
        break;
      }
      case 'VIBRATION_AMP':
      case 'TELESCOPIC_AMP':
        writes.push(makeWrite(key, clamp(command.value, 0, 100, key), sourceKey));
        break;
      case 'VIBRATION_SWITCH':
      case 'TELESCOPIC_SWITCH': {
        const value = integer(command.value, key);
        writes.push(makeWrite(key, value <= 0 ? 2 : value === 1 ? 3 : clamp(value, 2, 3, key), sourceKey));
        break;
      }
      default:
        writes.push(makeWrite(key, integer(command.value, key), sourceKey));
    }
  }
  return { writes, unsupported };
}

/** Resolve product-specific application command mappings into KV writes. */
export function resolveProductCommands(profileOrName, commandPairs, observedAttrs = {}) {
  const profile = getProductProfile(profileOrName);
  if (!profile) {
    return result(null, [], [{ profile: profileOrName, reason: 'unsupported_product' }]);
  }
  const commands = normalizeCommands(commandPairs);
  const resolved = profile.kind === 'pt3max' ? resolvePt3Max(commands) : resolveNav(commands);
  return result(profile, resolved.writes, resolved.unsupported);
}

/** Resolve the app's product-specific pause, resume, and all-stop operations. */
export function resolveProductOperation(profileOrName, operation, observedAttrs = {}) {
  const profile = getProductProfile(profileOrName);
  if (!profile) return result(null, [], [{ operation, reason: 'unsupported_product' }]);
  const op = String(operation || '').toLowerCase();
  const writes = [];
  if (profile.kind === 'pt3max') {
    if (op === 'stop') writes.push(makeWrite('CUSTOM_FF', 0, 'stop'));
    if (op === 'pause') {
      if (switchIs(observedAttrs, 'vibration', 'on')) writes.push(makeWrite('VIBRATION_SWITCH', 2, 'pause'));
      if (switchIs(observedAttrs, 'suction', 'on')) writes.push(makeWrite('SUCTION_SWITCH', 2, 'pause'));
    }
    if (op === 'resume') {
      if (switchIs(observedAttrs, 'vibration', 'pause')) writes.push(makeWrite('VIBRATION_SWITCH', 1, 'resume'));
      if (switchIs(observedAttrs, 'suction', 'pause')) writes.push(makeWrite('SUCTION_SWITCH', 1, 'resume'));
    }
  } else if (profile.kind === 'nav') {
    if (op === 'stop') writes.push(makeWrite('CUSTOM_FF', 0, 'stop', { standalone: true }));
    if (op === 'pause') {
      const burst = Number(stateValue(observedAttrs, 'customFE', 'custom_fe') || 0) > 0;
      if (burst) writes.push(makeWrite('CUSTOM_FF', 0, 'pause', { standalone: true }));
      else {
        if (switchIs(observedAttrs, 'vibration', 'on')) writes.push(makeWrite('VIBRATION_SWITCH', 2, 'pause'));
        if (switchIs(observedAttrs, 'telescopic', 'on')) writes.push(makeWrite('TELESCOPIC_SWITCH', 2, 'pause'));
      }
    }
    if (op === 'resume') {
      if (switchIs(observedAttrs, 'vibration', 'pause')) writes.push(makeWrite('VIBRATION_SWITCH', 3, 'resume'));
      if (switchIs(observedAttrs, 'telescopic', 'pause')) writes.push(makeWrite('TELESCOPIC_SWITCH', 3, 'resume'));
    }
  }
  const supported = profile.supportedOperations.includes(op);
  return result(profile, writes, supported ? [] : [{ operation, reason: 'unsupported_operation' }]);
}

export function productSupports(profileOrName, operation) {
  const profile = getProductProfile(profileOrName);
  return Boolean(profile && profile.supportedOperations.includes(String(operation || '').toLowerCase()));
}
