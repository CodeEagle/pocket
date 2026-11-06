import type { BridgeObject, HostBridge } from "@pocket/ui/host";
import {
  createPocketStreamAdapter,
  type PocketStream,
  type PocketStreamAdapter,
} from "@pocket/ui/streams";

/** The Pocket capability exposed by the Flutter host. */
export const POCKET_BLUETOOTH_NOTIFICATIONS = "hardware.bluetooth.notifications";

type ScanDevice = {
  id?: unknown;
  deviceId?: unknown;
  name?: unknown;
  deviceName?: unknown;
  rssi?: unknown;
  /** Raw CoreBluetooth manufacturer payload (company id included). */
  manufacturerData?: unknown;
};

type CharacteristicRecord = {
  uuid?: unknown;
  canRead?: unknown;
  canWrite?: unknown;
  canWriteWithoutResponse?: unknown;
  canNotify?: unknown;
  canIndicate?: unknown;
  properties?: Record<string, unknown>;
};

type ServiceRecord = { uuid?: unknown; characteristics?: unknown };

type ConnectResult = {
  ok?: unknown;
  state?: unknown;
  device?: unknown;
  services?: unknown;
  serviceUuids?: unknown;
};

type ScanResult = { ok?: unknown; devices?: unknown };

export interface PocketBluetoothRequestOptions {
  /** Scan duration forwarded to the native provider (250..30000 ms). */
  timeoutMs?: number;
  /** Select one device when a scan returns several devices. */
  selectDevice?: (
    devices: readonly PocketBluetoothDevice[],
    request: BluetoothRequestDeviceOptions,
  ) => PocketBluetoothDevice | string | Promise<PocketBluetoothDevice | string>;
  stream?: {
    maxBufferedMessages?: number;
    deadlineFrames?: number;
  };
}

/** A deliberately small subset of the request options used by the GATT adapter. */
export interface BluetoothRequestDeviceOptions {
  filters?: readonly BluetoothRequestFilter[];
  acceptAllDevices?: boolean;
  optionalServices?: readonly (string | number)[];
  services?: readonly (string | number)[];
}

export interface BluetoothRequestFilter {
  name?: string;
  namePrefix?: string;
  services?: readonly (string | number)[];
}

export interface PocketBluetoothDevice {
  readonly id: string;
  readonly name: string;
  /** Raw manufacturer payload captured during discovery, when advertised. */
  readonly manufacturerData: readonly number[] | undefined;
  readonly gatt: PocketBluetoothRemoteGATTServer;
  addEventListener(type: "gattserverdisconnected", listener: (event: PocketBluetoothDisconnectedEvent) => void): void;
  removeEventListener(type: "gattserverdisconnected", listener: (event: PocketBluetoothDisconnectedEvent) => void): void;
}

export interface PocketBluetoothDisconnectedEvent {
  readonly type: "gattserverdisconnected";
  readonly target: PocketBluetoothDevice;
}

export interface PocketBluetoothRemoteGATTServer {
  readonly device: PocketBluetoothDevice;
  readonly connected: boolean;
  connect(): Promise<PocketBluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string | number): Promise<PocketBluetoothRemoteGATTService>;
  getPrimaryServices(): Promise<readonly PocketBluetoothRemoteGATTService[]>;
}

export interface PocketBluetoothRemoteGATTService {
  readonly device: PocketBluetoothDevice;
  readonly uuid: string;
  getCharacteristic(uuid: string | number): Promise<PocketBluetoothRemoteGATTCharacteristic>;
  getCharacteristics(): Promise<readonly PocketBluetoothRemoteGATTCharacteristic[]>;
}

export interface PocketBluetoothRemoteGATTCharacteristic {
  readonly service: PocketBluetoothRemoteGATTService;
  readonly uuid: string;
  readonly properties: {
    readonly broadcast: boolean;
    readonly read: boolean;
    readonly writeWithoutResponse: boolean;
    readonly write: boolean;
    readonly notify: boolean;
    readonly indicate: boolean;
  };
  readonly value: DataView | undefined;
  readValue(): Promise<DataView>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<PocketBluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<PocketBluetoothRemoteGATTCharacteristic>;
  addEventListener(type: "characteristicvaluechanged", listener: (event: PocketBluetoothCharacteristicValueEvent) => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: (event: PocketBluetoothCharacteristicValueEvent) => void): void;
}

export interface PocketBluetoothCharacteristicValueEvent {
  readonly type: "characteristicvaluechanged";
  readonly target: PocketBluetoothRemoteGATTCharacteristic;
}

export interface PocketBluetooth {
  readonly requestDevice: (options?: BluetoothRequestDeviceOptions) => Promise<PocketBluetoothDevice>;
  dispose(reason?: string): void;
}

type State = {
  id: string;
  name: string;
  manufacturerData: readonly number[] | undefined;
  device: PocketBluetoothDeviceImpl;
  server: PocketBluetoothRemoteGATTServerImpl;
  connected: boolean;
  services: Map<string, ServiceInfo>;
  streams: Set<PocketStream<BridgeObject>>;
  host: HostBridge;
  streamAdapter: PocketStreamAdapter;
  streamOptions: { maxBufferedMessages?: number; deadlineFrames?: number };
  epoch: number;
  guard(): void;
  isDisposed(): boolean;
};

type ServiceInfo = { uuid: string; characteristics: Map<string, CharacteristicInfo> };
type CharacteristicInfo = {
  uuid: string;
  canRead: boolean;
  canWrite: boolean;
  canWriteWithoutResponse: boolean;
  canNotify: boolean;
  canIndicate: boolean;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function invalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "invalid_argument" });
}

function unavailable(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "hardware_unsupported" });
}

function notFound(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "hardware_not_found" });
}

function disposedError(): Error & { code: string } {
  return Object.assign(new Error("Pocket Bluetooth adapter is disposed"), {
    code: "hardware_bluetooth_disconnected",
  });
}

function normalizeUuid(value: string | number): string {
  const raw = String(value).trim().toLowerCase();
  if (!raw) throw invalid("Bluetooth UUID must not be empty");
  if (/^[0-9a-f]{4}$/.test(raw)) return `0000${raw}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(raw)) return `${raw}-0000-1000-8000-00805f9b34fb`;
  return raw;
}

function uuidEquals(a: string, b: string | number): boolean {
  return normalizeUuid(a) === normalizeUuid(b);
}

function manufacturerBytes(value: unknown): readonly number[] | undefined {
  if (value === undefined || value === null) return undefined;
  let bytes: unknown[];
  if (Array.isArray(value)) bytes = value;
  else if (typeof value === "object") {
    // flutter_blue_plus exposes Map<companyId, payload>, with CID excluded
    // from each value. Accept its JSON projection without adding Dart policy.
    const entries = Object.entries(value);
    if (!entries.length) return undefined;
    bytes = [];
    for (const [key, payload] of entries) {
      const companyId = Number(key);
      if (!/^\d+$/.test(key) || !Number.isInteger(companyId) || companyId < 0 || companyId > 65535 || !Array.isArray(payload)) {
        throw invalid("Bluetooth scan returned invalid manufacturerData map");
      }
      bytes.push(companyId & 255, companyId >>> 8, ...payload);
    }
  } else throw invalid("Bluetooth scan returned invalid manufacturerData");
  if (!bytes.every(item => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)) {
    throw invalid("Bluetooth scan returned invalid manufacturerData bytes");
  }
  return Object.freeze(bytes as number[]);
}

function deviceFrom(value: ScanDevice, stateFactory: (id: string, name: string, manufacturerData: readonly number[] | undefined) => State): PocketBluetoothDeviceImpl {
  const id = text(value.id ?? value.deviceId);
  if (!id) throw notFound("Bluetooth scan returned a device without an id");
  const name = text(value.name ?? value.deviceName, "Unnamed Bluetooth device");
  return stateFactory(id, name, manufacturerBytes(value.manufacturerData)).device;
}

function asByteArray(value: BufferSource): number[] {
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw invalid("Bluetooth write value must be an ArrayBuffer or view");
  return [...bytes];
}

function dataView(value: unknown): DataView {
  if (!Array.isArray(value)) throw new Error("Bluetooth notification did not contain byte data");
  const bytes = value.map((item) => Number(item));
  if (!bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    throw new Error("Bluetooth notification contained an invalid byte");
  }
  const copy = Uint8Array.from(bytes);
  return new DataView(copy.buffer);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

class PocketBluetoothDeviceImpl implements PocketBluetoothDevice {
  readonly gatt: PocketBluetoothRemoteGATTServerImpl;
  private readonly listeners = new Set<(event: PocketBluetoothDisconnectedEvent) => void>();

  constructor(readonly state: State) {
    this.gatt = new PocketBluetoothRemoteGATTServerImpl(state);
  }

  get id(): string { return this.state.id; }
  get name(): string { return this.state.name; }
  get manufacturerData(): readonly number[] | undefined { return this.state.manufacturerData; }

  addEventListener(_type: "gattserverdisconnected", listener: (event: PocketBluetoothDisconnectedEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "gattserverdisconnected", listener: (event: PocketBluetoothDisconnectedEvent) => void): void {
    this.listeners.delete(listener);
  }

  emitDisconnected(): void {
    const event: PocketBluetoothDisconnectedEvent = { type: "gattserverdisconnected", target: this };
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* consumer errors never tear down host transport */ }
    }
  }
}

class PocketBluetoothRemoteGATTServerImpl implements PocketBluetoothRemoteGATTServer {
  constructor(private readonly state: State) {}
  get device(): PocketBluetoothDevice { return this.state.device; }
  get connected(): boolean { return this.state.connected; }

  async connect(): Promise<PocketBluetoothRemoteGATTServer> {
    this.state.guard();
    const result = await request<BridgeObject>(this.state.host, "hardware.bluetooth.connect", { deviceId: this.state.id });
    this.state.guard();
    populateInventory(this.state, result as unknown as ConnectResult);
    this.state.connected = true;
    return this;
  }

  disconnect(): void {
    // The native capability owns the GATT session and currently has no
    // disconnect request. Cancel guest-owned notification streams and reflect
    // the local GATT state; never report a fabricated native success.
    if (!this.state.connected || this.state.isDisposed()) return;
    for (const stream of [...this.state.streams]) stream.cancel("bluetooth_disconnect");
    this.state.streams.clear();
    this.state.connected = false;
    this.state.device.emitDisconnected();
  }

  async getPrimaryService(uuid: string | number): Promise<PocketBluetoothRemoteGATTService> {
    await this.ensureConnected();
    this.state.guard();
    const service = findService(this.state, uuid);
    if (!service) throw notFound(`Bluetooth service was not discovered: ${String(uuid)}`);
    return new PocketBluetoothRemoteGATTServiceImpl(this.state, service);
  }

  async getPrimaryServices(): Promise<readonly PocketBluetoothRemoteGATTService[]> {
    await this.ensureConnected();
    this.state.guard();
    return [...this.state.services.values()].map((service) => new PocketBluetoothRemoteGATTServiceImpl(this.state, service));
  }

  private async ensureConnected(): Promise<void> {
    this.state.guard();
    if (!this.state.connected) await this.connect();
    this.state.guard();
  }
}

class PocketBluetoothRemoteGATTServiceImpl implements PocketBluetoothRemoteGATTService {
  readonly uuid: string;
  constructor(private readonly state: State, private readonly info: ServiceInfo) { this.uuid = info.uuid; }
  get device(): PocketBluetoothDevice { return this.state.device; }

  async getCharacteristic(uuid: string | number): Promise<PocketBluetoothRemoteGATTCharacteristic> {
    this.state.guard();
    const info = findCharacteristic(this.info, uuid);
    if (!info) throw notFound(`Bluetooth characteristic was not discovered: ${String(uuid)}`);
    return new PocketBluetoothRemoteGATTCharacteristicImpl(this.state, this, info);
  }

  async getCharacteristics(): Promise<readonly PocketBluetoothRemoteGATTCharacteristic[]> {
    this.state.guard();
    return [...this.info.characteristics.values()].map((info) => new PocketBluetoothRemoteGATTCharacteristicImpl(this.state, this, info));
  }
}

class PocketBluetoothRemoteGATTCharacteristicImpl implements PocketBluetoothRemoteGATTCharacteristic {
  private readonly listeners = new Set<(event: PocketBluetoothCharacteristicValueEvent) => void>();
  private stream?: PocketStream<BridgeObject>;
  private currentValue?: DataView;
  readonly uuid: string;
  readonly properties: {
    readonly broadcast: boolean;
    readonly read: boolean;
    readonly writeWithoutResponse: boolean;
    readonly write: boolean;
    readonly notify: boolean;
    readonly indicate: boolean;
  };

  constructor(private readonly state: State, readonly service: PocketBluetoothRemoteGATTServiceImpl, private readonly info: CharacteristicInfo) {
    this.uuid = info.uuid;
    this.properties = {
      broadcast: false,
      read: info.canRead,
      writeWithoutResponse: info.canWriteWithoutResponse,
      write: info.canWrite,
      notify: info.canNotify,
      indicate: info.canIndicate,
    };
  }

  get value(): DataView | undefined { return this.currentValue; }

  async readValue(): Promise<DataView> {
    await this.ensureConnected();
    this.state.guard();
    const result = await request<BridgeObject>(this.state.host, "hardware.bluetooth.read", this.selector());
    this.state.guard();
    const value = dataView(object(result).value);
    this.currentValue = value;
    return value;
  }

  async writeValue(value: BufferSource): Promise<void> { await this.write(value, true); }
  async writeValueWithResponse(value: BufferSource): Promise<void> { await this.write(value, true); }
  async writeValueWithoutResponse(value: BufferSource): Promise<void> { await this.write(value, false); }

  async startNotifications(): Promise<PocketBluetoothRemoteGATTCharacteristic> {
    await this.ensureConnected();
    this.state.guard();
    if (this.stream) return this;
    const stream = this.state.streamAdapter.open<BridgeObject>(
      POCKET_BLUETOOTH_NOTIFICATIONS,
      this.selector(),
      this.state.streamOptions,
    );
    this.stream = stream;
    this.state.streams.add(stream);
    stream.onData((payload) => {
      try {
        const value = dataView(payload.value ?? payload.data ?? payload);
        this.currentValue = value;
        const event: PocketBluetoothCharacteristicValueEvent = { type: "characteristicvaluechanged", target: this };
        for (const listener of [...this.listeners]) {
          try { listener(event); } catch { /* isolate consumer callbacks */ }
        }
      } catch {
        // A malformed native event is treated as a transport failure. The
        // stream error path below is authoritative for disconnect semantics.
      }
    });
    stream.onError(() => {
      this.stream = undefined;
      this.state.streams.delete(stream);
      if (this.state.connected) {
        this.state.connected = false;
        this.state.device.emitDisconnected();
      }
    });
    stream.onEnd((close) => {
      this.stream = undefined;
      this.state.streams.delete(stream);
      if (close.error && this.state.connected) {
        this.state.connected = false;
        this.state.device.emitDisconnected();
      }
    });
    return this;
  }

  async stopNotifications(): Promise<PocketBluetoothRemoteGATTCharacteristic> {
    this.state.guard();
    const stream = this.stream;
    this.stream = undefined;
    if (stream) {
      this.state.streams.delete(stream);
      stream.cancel("bluetooth_notifications_stopped");
    }
    return this;
  }

  addEventListener(_type: "characteristicvaluechanged", listener: (event: PocketBluetoothCharacteristicValueEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "characteristicvaluechanged", listener: (event: PocketBluetoothCharacteristicValueEvent) => void): void {
    this.listeners.delete(listener);
  }

  private selector(): BridgeObject {
    return { deviceId: this.state.id, serviceUuid: this.service.uuid, characteristicUuid: this.uuid };
  }

  private async ensureConnected(): Promise<void> {
    this.state.guard();
    if (!this.state.connected) await this.state.device.gatt.connect();
    this.state.guard();
  }

  private async write(value: BufferSource, withResponse: boolean): Promise<void> {
    await this.ensureConnected();
    this.state.guard();
    const bytes = asByteArray(value);
    await request(this.state.host, "hardware.bluetooth.write", { ...this.selector(), value: bytes, withResponse });
    this.state.guard();
  }
}

function findService(state: State, uuid: string | number): ServiceInfo | undefined {
  return [...state.services.values()].find((service) => uuidEquals(service.uuid, uuid));
}

function findCharacteristic(service: ServiceInfo, uuid: string | number): CharacteristicInfo | undefined {
  return [...service.characteristics.values()].find((characteristic) => uuidEquals(characteristic.uuid, uuid));
}

function populateInventory(state: State, result: ConnectResult): void {
  if (result.ok === false) throw unavailable("Bluetooth connection was rejected by the host");
  const services = Array.isArray(result.services) ? result.services : [];
  const inventory = new Map<string, ServiceInfo>();
  for (const raw of services) {
    const record = object(raw as unknown);
    const uuid = text(record.uuid);
    if (!uuid) continue;
    const characteristics = new Map<string, CharacteristicInfo>();
    const rawCharacteristics = Array.isArray(record.characteristics) ? record.characteristics : [];
    for (const rawCharacteristic of rawCharacteristics) {
      const characteristic = object(rawCharacteristic as unknown) as CharacteristicRecord;
      const characteristicUuid = text(characteristic.uuid);
      if (!characteristicUuid) continue;
      const properties = object(characteristic.properties);
      const info: CharacteristicInfo = {
        uuid: characteristicUuid,
        canRead: bool(characteristic.canRead) || bool(properties.read),
        canWrite: bool(characteristic.canWrite) || bool(properties.write),
        canWriteWithoutResponse: bool(characteristic.canWriteWithoutResponse) || bool(properties.writeWithoutResponse),
        canNotify: bool(characteristic.canNotify) || bool(properties.notify),
        canIndicate: bool(characteristic.canIndicate) || bool(properties.indicate),
      };
      characteristics.set(normalizeUuid(characteristicUuid), info);
    }
    inventory.set(normalizeUuid(uuid), { uuid, characteristics });
  }
  state.services = inventory;
}

async function request<T extends import("@pocket/ui/host").BridgeValue>(host: HostBridge, capability: string, params: BridgeObject): Promise<T> {
  const result = await host.request<T>(capability, params);
  const value = object(result);
  if (value.ok === false) {
    const code = text(value.code ?? value.errorCode, "hardware_bluetooth_error");
    const message = text(value.message ?? value.error, "Bluetooth host request failed");
    throw Object.assign(new Error(message), { code });
  }
  return result;
}

/**
 * Adapt Pocket's capability bridge to the small GATT object shape consumed by
 * the TFTC client. Native discovery, GATT IO, and notification streams stay
 * in the host; this package only translates their wire values and lifecycle.
 */
export function createPocketBluetooth(host: HostBridge, options: PocketBluetoothRequestOptions = {}): PocketBluetooth {
  const streamAdapter: PocketStreamAdapter = createPocketStreamAdapter(host, { idPrefix: "tftc-", ...options.stream });
  const states = new Map<string, State>();
  let disposed = false;
  let epoch = 0;

  const guard = (expectedEpoch: number): void => {
    if (disposed || expectedEpoch !== epoch) throw disposedError();
  };

  const stateFor = (id: string, name: string, manufacturerData: readonly number[] | undefined): State => {
    const existing = states.get(id);
    if (existing) {
      if (manufacturerData !== undefined) existing.manufacturerData = manufacturerData;
      return existing;
    }
    const state = {} as State;
    const device = new PocketBluetoothDeviceImpl(state);
    state.id = id;
    state.name = name;
    state.manufacturerData = manufacturerData;
    state.device = device;
    state.server = device.gatt;
    state.connected = false;
    state.services = new Map();
    state.streams = new Set();
    state.host = host;
    state.streamAdapter = streamAdapter;
    state.streamOptions = { maxBufferedMessages: options.stream?.maxBufferedMessages, deadlineFrames: options.stream?.deadlineFrames };
    state.epoch = epoch;
    state.guard = () => guard(state.epoch);
    state.isDisposed = () => disposed || state.epoch !== epoch;
    states.set(id, state);
    return state;
  };

  const requestDevice = async (request: BluetoothRequestDeviceOptions = {}): Promise<PocketBluetoothDevice> => {
    const requestEpoch = epoch;
    guard(requestEpoch);
    const services = [...(request.services ?? []), ...(request.optionalServices ?? [])].map(normalizeUuid);
    const timeoutMs = options.timeoutMs ?? 1600;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30000) throw invalid("timeoutMs must be between 250 and 30000");
    const result = await requestResult<BridgeObject>(host, "hardware.bluetooth.scan", {
      timeoutMs,
      ...(services.length ? { services } : {}),
      ...(request.filters ? { filters: request.filters as unknown as BridgeObject["filters"] } : {}),
    });
    guard(requestEpoch);
    const rawDevices = Array.isArray(result.devices) ? result.devices : [];
    const devices = rawDevices.map((value) => deviceFrom(object(value) as ScanDevice, stateFor));
    const matches = devices.filter((device) => matchesFilters(device, request.filters));
    if (matches.length === 0) throw notFound("No Bluetooth device matched the request");
    const selected = options.selectDevice
      ? await options.selectDevice(matches, request)
      : matches[0];
    if (typeof selected === "string") {
      const device = matches.find((candidate) => candidate.id === selected);
      if (!device) throw notFound("The selected Bluetooth device was not returned by the scan");
      return device;
    }
    if (!selected || !matches.some((candidate) => candidate.id === selected.id)) throw notFound("The selected Bluetooth device was not returned by the scan");
    return selected;
  };

  return {
    requestDevice,
    dispose(reason = "bluetooth_adapter_disposed") {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      for (const state of states.values()) {
        for (const stream of [...state.streams]) stream.cancel(reason);
        state.streams.clear();
        if (state.connected) {
          state.connected = false;
          state.device.emitDisconnected();
        }
      }
      streamAdapter.dispose(reason);
      states.clear();
    },
  };
}

async function requestResult<T extends import("@pocket/ui/host").BridgeValue>(host: HostBridge, capability: string, params: BridgeObject): Promise<T> {
  const result = await host.request<T>(capability, params);
  const record = object(result);
  if (record.ok === false) {
    const code = text(record.code ?? record.errorCode, "hardware_bluetooth_error");
    throw Object.assign(new Error(text(record.message ?? record.error, "Bluetooth host request failed")), { code });
  }
  return result;
}

function matchesFilters(device: PocketBluetoothDevice, filters: readonly BluetoothRequestFilter[] | undefined): boolean {
  if (!filters || filters.length === 0) return true;
  return filters.some((filter) => {
    if (filter.name !== undefined && device.name !== filter.name) return false;
    if (filter.namePrefix !== undefined && !device.name.startsWith(filter.namePrefix)) return false;
    // Native scan inventory is intentionally discovered by connect. Service
    // filters therefore remain a host-side admission hint, not a guessed match.
    return true;
  });
}
