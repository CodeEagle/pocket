import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import {
  InputField,
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileListTile,
  MobileSwitch,
} from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import type { HostBridge, JsonObject, JsonValue } from "@pocket/ui/host";
import { hostError } from "@pocket/ui/host";
import type { PlatformExperience } from "@pocket/ui/platform-experience";
import type {
  PocketStream,
  PocketStreamAdapter,
  PocketStreamError,
} from "@pocket/ui/streams";
import type { CapabilityState } from "./state.ts";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function shortText(value: unknown, limit = 42): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit
    ? `${text.slice(0, Math.max(1, limit - 1))}…`
    : text;
}

function cardClass(dark: boolean): string {
  return dark
    ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
    : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]";
}

function bodyTextClass(dark: boolean): string {
  return dark ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]";
}

function valueTextClass(dark: boolean): string {
  return dark ? "text-xs text-white" : "text-xs text-[#17233B]";
}

function errorTextClass(dark: boolean): string {
  return dark ? "text-xs text-rose-300" : "text-xs text-rose-700";
}

function errorStatus(error: unknown): { code: string; message: string } {
  const value = hostError(error);
  return { code: value.code, message: shortText(value.message, 48) };
}

function resultSummary(value: unknown): string {
  const record = asRecord(value);
  if (record?.uri !== undefined)
    return record.uri
      ? `Link · ${shortText(record.uri, 46)}`
      : "Initial link · none";
  if (record?.applied === true) return "Applied";
  if (record?.reset === true) return "Reset";
  if (record?.performed === true)
    return `Performed · ${shortText(record.type ?? "haptic", 18)}`;
  if (record?.performed === false)
    return `Not performed · ${shortText(record.reason ?? "rate limited", 28)}`;
  return record
    ? "Host returned a structured result"
    : shortText(value, 44) || "Completed";
}

export interface PlatformExperiencePanelProps {
  dark: boolean;
  experience?: PlatformExperience;
}

/**
 * Explicit platform controls only. This deliberately does not subscribe to
 * links: the platform provider is opt-in and this panel never chooses a
 * route or app for a received URL.
 */
export function PlatformExperiencePanel(
  props: PlatformExperiencePanelProps,
): JSX.Element {
  const [busy, setBusy] = createSignal<string | undefined>(undefined);
  const [status, setStatus] = createSignal("No platform call yet");
  const [failure, setFailure] = createSignal<
    { code: string; message: string } | undefined
  >(undefined);

  const call = async (
    label: string,
    operation: () => Promise<JsonValue>,
  ): Promise<void> => {
    const experience = props.experience;
    if (!experience) {
      setFailure({
        code: "host_unavailable",
        message: "Platform experience was not provided",
      });
      return;
    }
    setBusy(label);
    setFailure(undefined);
    try {
      const result = await operation();
      setStatus(`${label} · ${resultSummary(result)}`);
    } catch (error) {
      const detail = errorStatus(error);
      setFailure(detail);
      setStatus(`${label} failed`);
    } finally {
      setBusy(undefined);
    }
  };

  const setSystemUi = (label: string, style: JsonObject): void => {
    void call(label, () => props.experience!.systemUi.set<JsonValue>(style));
  };

  return (
    <MobileCard
      title="Platform experience"
      detail="Explicit haptics and system UI; links stay opt-in."
      class={cardClass(props.dark)}
    >
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-col gap-1 flex-1">
          <Text class={valueTextClass(props.dark)}>Deep links</Text>
          <Text class={bodyTextClass(props.dark)}>Off by default</Text>
        </View>
        <MobileBadge label="Opt-in" tone="warning" />
      </View>
      <Text class={bodyTextClass(props.dark)}>
        No background URL listener or route selection. Check the initial link
        only when requested.
      </Text>
      <View class="flex-row flex-wrap gap-2">
        <MobileButton
          label={busy() === "Initial link" ? "Checking" : "Check initial link"}
          compact
          disabled={busy() !== undefined || props.experience === undefined}
          onPress={() =>
            void call("Initial link", () =>
              props.experience!.links.initial<JsonValue>(),
            )
          }
        />
      </View>
      <View class="flex-row flex-wrap gap-2">
        <MobileButton
          label="selection"
          kind="outlined"
          compact
          disabled={busy() !== undefined || props.experience === undefined}
          onPress={() =>
            void call("Haptic selection", () =>
              props.experience!.haptics.perform<JsonValue>({
                type: "selection",
              }),
            )
          }
        />
        <MobileButton
          label="light"
          kind="outlined"
          compact
          disabled={busy() !== undefined || props.experience === undefined}
          onPress={() =>
            void call("Haptic light", () =>
              props.experience!.haptics.perform<JsonValue>({ type: "light" }),
            )
          }
        />
        <MobileButton
          label="medium"
          kind="outlined"
          compact
          disabled={busy() !== undefined || props.experience === undefined}
          onPress={() =>
            void call("Haptic medium", () =>
              props.experience!.haptics.perform<JsonValue>({ type: "medium" }),
            )
          }
        />
      </View>
      <View class="flex-row flex-wrap gap-2">
        <MobileButton
          label="Light bar"
          kind="text"
          compact
          disabled={busy() !== undefined || props.experience === undefined}
          onPress={() =>
            setSystemUi("System UI light", {
              statusBarColor: 0xffffffff,
              statusBarIconBrightness: "dark",
              statusBarBrightness: "light",
              systemNavigationBarColor: 0xfff5f6fa,
              systemNavigationBarIconBrightness: "dark",
            })
          }
        />
        <MobileButton
          label="Dark bar"
          kind="text"
          compact
          disabled={busy() !== undefined || props.experience === undefined}
          onPress={() =>
            setSystemUi("System UI dark", {
              statusBarColor: 0xff0e1728,
              statusBarIconBrightness: "light",
              systemNavigationBarIconBrightness: "light",
              statusBarBrightness: "dark",
              systemNavigationBarColor: 0xff0e1728,
            })
          }
        />
        <MobileButton
          label="Reset"
          kind="text"
          compact
          disabled={busy() !== undefined || props.experience === undefined}
          onPress={() =>
            void call("System UI reset", () =>
              props.experience!.systemUi.set<JsonValue>({ reset: true }),
            )
          }
        />
      </View>
      <Show when={failure()}>
        {(detail) => (
          <Text class={errorTextClass(props.dark)}>
            {detail().code} · {detail().message}
          </Text>
        )}
      </Show>
      <Text class={valueTextClass(props.dark)}>{status()}</Text>
    </MobileCard>
  );
}

type StreamPhase = "idle" | "starting" | "watching" | "stopped" | "error";
type ActionPhase = "idle" | "loading" | "ready" | "error";

interface ActionState {
  phase: ActionPhase;
  code?: string;
  message?: string;
  result?: JsonValue;
}

function initialAction(): ActionState {
  return { phase: "idle" };
}

function actionStatus(state: ActionState): string {
  if (state.phase === "idle") return "Not requested";
  if (state.phase === "loading") return "Waiting for host response…";
  if (state.phase === "error")
    return `${state.code ?? "host_error"} · ${shortText(state.message ?? "Host request failed", 46)}`;
  return resultSummary(state.result);
}

function streamError(error: unknown): { code: string; message: string } {
  const value = error as Partial<PocketStreamError>;
  return {
    code: typeof value?.code === "string" ? value.code : "stream_error",
    message: shortText(
      typeof value?.message === "string" ? value.message : String(error),
      46,
    ),
  };
}

function sensorSampleSummary(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "Sample received";
  const axis = ["x", "y", "z"]
    .map((key) => record[key])
    .filter(
      (item): item is number =>
        typeof item === "number" && Number.isFinite(item),
    );
  if (axis.length === 3)
    return `x ${axis[0]!.toFixed(2)} · y ${axis[1]!.toFixed(2)} · z ${axis[2]!.toFixed(2)}`;
  const accel = ["accelX", "accelY", "accelZ"]
    .map((key) => record[key])
    .filter(
      (item): item is number =>
        typeof item === "number" && Number.isFinite(item),
    );
  if (accel.length === 3)
    return `accel ${accel.map((item) => item.toFixed(2)).join(" · ")}`;
  if (Array.isArray(record.values))
    return `values · ${record.values
      .slice(0, 3)
      .map((item) => shortText(item, 10))
      .join(", ")}`;
  return record.sensor
    ? `${shortText(record.sensor, 22)} sample`
    : "Sample received";
}

function bytesSummary(value: unknown): string {
  const record = asRecord(value);
  const raw = Array.isArray(value)
    ? value
    : record && Array.isArray(record.value)
      ? record.value
      : undefined;
  if (!raw) return shortText(value, 44) || "No bytes returned";
  const bytes = raw.filter(
    (item): item is number =>
      typeof item === "number" && Number.isInteger(item),
  );
  return `${bytes.length} bytes · ${bytes.slice(0, 8).join(", ")}${bytes.length > 8 ? "…" : ""}`;
}

function gattInventory(
  state: CapabilityState | undefined,
): GattCharacteristic[] {
  const result = asRecord(state?.result);
  const services = Array.isArray(result?.services) ? result.services : [];
  return services.flatMap((service) => {
    const serviceRecord = asRecord(service);
    const serviceUuid =
      typeof serviceRecord?.uuid === "string" ? serviceRecord.uuid : "";
    const chars = Array.isArray(serviceRecord?.characteristics)
      ? serviceRecord.characteristics
      : [];
    return chars.flatMap((characteristic) => {
      const record = asRecord(characteristic);
      const characteristicUuid =
        typeof record?.uuid === "string" ? record.uuid : "";
      if (!serviceUuid || !characteristicUuid) return [];
      return [
        {
          serviceUuid,
          characteristicUuid,
          canRead: record?.canRead === true,
          canWrite: record?.canWrite === true,
          canWriteWithoutResponse: record?.canWriteWithoutResponse === true,
          canNotify: record?.canNotify === true,
          canIndicate: record?.canIndicate === true,
        },
      ];
    });
  });
}

interface GattCharacteristic {
  serviceUuid: string;
  characteristicUuid: string;
  canRead: boolean;
  canWrite: boolean;
  canWriteWithoutResponse: boolean;
  canNotify: boolean;
  canIndicate: boolean;
}

function compactUuid(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function selectorParams(
  deviceId: string,
  selected: GattCharacteristic | undefined,
): JsonObject | undefined {
  if (!deviceId || !selected) return undefined;
  return {
    deviceId,
    serviceUuid: selected.serviceUuid,
    characteristicUuid: selected.characteristicUuid,
  };
}

function bytesFromInput(value: string): { bytes?: number[]; error?: string } {
  if (!value.trim()) return { bytes: [] };
  const parts = value.split(/[\s,]+/).filter(Boolean);
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part))
      return { error: `Invalid byte ${shortText(part, 12)}` };
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255)
      return { error: `Byte ${part} must be 0–255` };
    bytes.push(byte);
  }
  if (bytes.length > 512)
    return { error: "Write value is limited to 512 bytes" };
  return { bytes };
}

export interface HardwareStreamsPanelProps {
  dark: boolean;
  host?: HostBridge;
  adapter?: PocketStreamAdapter;
  bluetoothConnect?: CapabilityState;
}

/** Real sensor/BLE stream controls. No permissions or stream is opened on mount. */
export function HardwareStreamsPanel(
  props: HardwareStreamsPanelProps,
): JSX.Element {
  const [sensorPhase, setSensorPhase] = createSignal<StreamPhase>("idle");
  const [sensorLatest, setSensorLatest] =
    createSignal<string>("No samples yet");
  const [sensorHistory, setSensorHistory] = createSignal<string[]>([]);
  const [sensorCount, setSensorCount] = createSignal(0);
  const [sensorFailure, setSensorFailure] = createSignal<
    { code: string; message: string } | undefined
  >(undefined);
  const [sensorStream, setSensorStream] = createSignal<
    PocketStream | undefined
  >(undefined);
  let sensorDetach: Array<() => void> = [];

  const [deviceId, setDeviceId] = createSignal("");
  const [serviceUuid, setServiceUuid] = createSignal("");
  const [characteristicUuid, setCharacteristicUuid] = createSignal("");
  const [writeInput, setWriteInput] = createSignal("");
  const [withResponse, setWithResponse] = createSignal(true);
  const [readState, setReadState] = createSignal<ActionState>(initialAction());
  const [writeState, setWriteState] =
    createSignal<ActionState>(initialAction());
  const [notifyPhase, setNotifyPhase] = createSignal<StreamPhase>("idle");
  const [notifyLatest, setNotifyLatest] = createSignal("No notifications yet");
  const [notifyCount, setNotifyCount] = createSignal(0);
  const [notifyFailure, setNotifyFailure] = createSignal<
    { code: string; message: string } | undefined
  >(undefined);
  const [notifyStream, setNotifyStream] = createSignal<
    PocketStream | undefined
  >(undefined);
  let notifyDetach: Array<() => void> = [];

  const inventory = createMemo(() => gattInventory(props.bluetoothConnect));
  const selected = createMemo(() =>
    inventory().find(
      (item) =>
        item.serviceUuid === serviceUuid() &&
        item.characteristicUuid === characteristicUuid(),
    ),
  );

  createEffect(() => {
    const result = asRecord(props.bluetoothConnect?.result);
    const resultDevice =
      typeof result?.deviceId === "string"
        ? result.deviceId
        : typeof result?.device === "string"
          ? result.device
          : undefined;
    if (!deviceId() && resultDevice) setDeviceId(resultDevice);
    const list = inventory();
    const current = selected();
    if (!current && list[0]) {
      setServiceUuid(list[0].serviceUuid);
      setCharacteristicUuid(list[0].characteristicUuid);
    }
  });

  const stopSensor = (reason = "sensor_watch_stopped"): void => {
    const stream = sensorStream();
    for (const detach of sensorDetach) detach();
    sensorDetach = [];
    setSensorStream(undefined);
    if (stream && !stream.isClosed) stream.cancel(reason);
    if (sensorPhase() === "watching" || sensorPhase() === "starting")
      setSensorPhase("stopped");
  };

  const startSensor = (): void => {
    if (!props.adapter) {
      setSensorFailure({
        code: "stream_unavailable",
        message: "Host stream adapter is unavailable",
      });
      setSensorPhase("error");
      return;
    }
    stopSensor("sensor_watch_replaced");
    setSensorFailure(undefined);
    setSensorHistory([]);
    setSensorCount(0);
    setSensorLatest("Waiting for sensor samples…");
    setSensorPhase("starting");
    try {
      const stream = props.adapter.open<JsonValue>(
        "hardware.sensors.watch",
        { samplingHz: 10 },
        { maxBufferedMessages: 8 },
      );
      setSensorStream(stream);
      sensorDetach = [
        stream.onData((value) => {
          const summary = sensorSampleSummary(value);
          setSensorLatest(summary);
          setSensorCount((count) => Math.min(9999, count + 1));
          setSensorHistory((history) => [summary, ...history].slice(0, 3));
          setSensorPhase("watching");
        }),
        stream.onError((error) => {
          setSensorFailure(streamError(error));
          setSensorPhase("error");
        }),
        stream.onEnd((close) => {
          if (close.state === "ended") setSensorPhase("stopped");
          if (close.error) {
            setSensorFailure(streamError(close.error));
            setSensorPhase("error");
          }
        }),
      ];
    } catch (error) {
      const detail = streamError(error);
      setSensorFailure(detail);
      setSensorPhase("error");
    }
  };

  const stopNotifications = (
    reason = "bluetooth_notifications_stopped",
  ): void => {
    const stream = notifyStream();
    for (const detach of notifyDetach) detach();
    notifyDetach = [];
    setNotifyStream(undefined);
    if (stream && !stream.isClosed) stream.cancel(reason);
    if (notifyPhase() === "watching" || notifyPhase() === "starting")
      setNotifyPhase("stopped");
  };

  const runBleRequest = async (kind: "read" | "write"): Promise<void> => {
    if (!props.host) {
      const failure = {
        phase: "error" as const,
        code: "host_unavailable",
        message: "Host bridge is unavailable",
      };
      if (kind === "read") setReadState(failure);
      else setWriteState(failure);
      return;
    }
    const params = selectorParams(deviceId().trim(), selected());
    if (!params) {
      const failure = {
        phase: "error" as const,
        code: "invalid_selection",
        message: "Connect a device and select a characteristic",
      };
      if (kind === "read") setReadState(failure);
      else setWriteState(failure);
      return;
    }
    if (kind === "read" && !selected()?.canRead) {
      setReadState({
        phase: "error",
        code: "not_readable",
        message: "Selected characteristic cannot be read",
      });
      return;
    }
    if (
      kind === "write" &&
      !(selected()?.canWrite || selected()?.canWriteWithoutResponse)
    ) {
      setWriteState({
        phase: "error",
        code: "not_writable",
        message: "Selected characteristic cannot be written",
      });
      return;
    }
    const writeBytes =
      kind === "write" ? bytesFromInput(writeInput()) : undefined;
    if (writeBytes?.error) {
      setWriteState({
        phase: "error",
        code: "invalid_value",
        message: writeBytes.error,
      });
      return;
    }
    if (kind === "read") setReadState({ phase: "loading" });
    else setWriteState({ phase: "loading" });
    try {
      const result =
        kind === "read"
          ? await props.host.request<JsonValue>(
              "hardware.bluetooth.read",
              params,
            )
          : await props.host.request<JsonValue>("hardware.bluetooth.write", {
              ...params,
              value: writeBytes?.bytes ?? [],
              withResponse: withResponse(),
            });
      if (kind === "read") setReadState({ phase: "ready", result });
      else setWriteState({ phase: "ready", result });
    } catch (error) {
      const detail = errorStatus(error);
      if (kind === "read") setReadState({ phase: "error", ...detail });
      else setWriteState({ phase: "error", ...detail });
    }
  };

  const startNotifications = (): void => {
    if (!props.adapter) {
      setNotifyFailure({
        code: "stream_unavailable",
        message: "Host stream adapter is unavailable",
      });
      setNotifyPhase("error");
      return;
    }
    const params = selectorParams(deviceId().trim(), selected());
    if (!params) {
      setNotifyFailure({
        code: "invalid_selection",
        message: "Connect a device and select a characteristic",
      });
      setNotifyPhase("error");
      return;
    }
    if (!(selected()?.canNotify || selected()?.canIndicate)) {
      setNotifyFailure({
        code: "not_notifiable",
        message: "Selected characteristic has no notify or indicate flag",
      });
      setNotifyPhase("error");
      return;
    }
    stopNotifications("bluetooth_notifications_replaced");
    setNotifyFailure(undefined);
    setNotifyLatest("Waiting for notifications…");
    setNotifyCount(0);
    setNotifyPhase("starting");
    try {
      const stream = props.adapter.open<JsonValue>(
        "hardware.bluetooth.notifications",
        params,
        { maxBufferedMessages: 8 },
      );
      setNotifyStream(stream);
      notifyDetach = [
        stream.onData((value) => {
          setNotifyLatest(bytesSummary(value));
          setNotifyCount((count) => Math.min(9999, count + 1));
          setNotifyPhase("watching");
        }),
        stream.onError((error) => {
          setNotifyFailure(streamError(error));
          setNotifyPhase("error");
        }),
        stream.onEnd((close) => {
          if (close.state === "ended") setNotifyPhase("stopped");
          if (close.error) {
            setNotifyFailure(streamError(close.error));
            setNotifyPhase("error");
          }
        }),
      ];
    } catch (error) {
      setNotifyFailure(streamError(error));
      setNotifyPhase("error");
    }
  };

  onCleanup(() => {
    stopSensor("hardware_page_unmounted");
    stopNotifications("hardware_page_unmounted");
  });

  return (
    <MobileCard
      title="Hardware streams"
      detail="Start and stop real streams; no permission request runs automatically."
      class={cardClass(props.dark)}
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text class={valueTextClass(props.dark)}>Sensors</Text>
        <MobileBadge
          label={sensorPhase()}
          tone={
            sensorPhase() === "error"
              ? "danger"
              : sensorPhase() === "watching"
                ? "success"
                : "accent"
          }
        />
      </View>
      <View class="flex-row flex-wrap gap-2">
        <MobileButton
          label={sensorPhase() === "starting" ? "Starting" : "Start sensors"}
          compact
          disabled={
            sensorPhase() === "starting" ||
            sensorPhase() === "watching" ||
            props.adapter === undefined
          }
          onPress={startSensor}
        />
        <MobileButton
          label="Stop sensors"
          kind="outlined"
          compact
          disabled={sensorStream() === undefined}
          onPress={() => stopSensor()}
        />
      </View>
      <Text class={valueTextClass(props.dark)}>
        Latest · {sensorLatest()} · samples {sensorCount()}
      </Text>
      <For each={sensorHistory()}>
        {(sample) => <Text class={bodyTextClass(props.dark)}>{sample}</Text>}
      </For>
      <Show when={sensorFailure()}>
        {(detail) => (
          <Text class={errorTextClass(props.dark)}>
            {detail().code} · {detail().message}
          </Text>
        )}
      </Show>

      <Text class={valueTextClass(props.dark)}>Bluetooth characteristic</Text>
      <Text class={bodyTextClass(props.dark)}>
        Choose a connected service and characteristic before read, write, or
        notify.
      </Text>
      <InputField
        value={deviceId}
        onInput={setDeviceId}
        onSubmit={setDeviceId}
        placeholder="Device ID"
      />
      <Show
        when={inventory().length > 0}
        fallback={
          <Text class={bodyTextClass(props.dark)}>
            No service inventory in the connect result yet.
          </Text>
        }
      >
        <For each={inventory()}>
          {(item) => (
            <MobileListTile
              title={compactUuid(item.characteristicUuid)}
              detail={`${compactUuid(item.serviceUuid)} · ${[item.canRead ? "read" : "", item.canWrite || item.canWriteWithoutResponse ? "write" : "", item.canNotify || item.canIndicate ? "notify" : ""].filter(Boolean).join(" · ") || "no supported operation"}`}
              selected={
                selected()?.serviceUuid === item.serviceUuid &&
                selected()?.characteristicUuid === item.characteristicUuid
              }
              trailing={
                <MobileBadge
                  label={item.canNotify || item.canIndicate ? "notify" : "BLE"}
                  tone={
                    item.canRead ||
                    item.canWrite ||
                    item.canNotify ||
                    item.canIndicate
                      ? "accent"
                      : "warning"
                  }
                />
              }
              onPress={() => {
                setServiceUuid(item.serviceUuid);
                setCharacteristicUuid(item.characteristicUuid);
              }}
            />
          )}
        </For>
      </Show>
      <InputField
        value={serviceUuid}
        onInput={setServiceUuid}
        onSubmit={setServiceUuid}
        placeholder="Service UUID"
      />
      <InputField
        value={characteristicUuid}
        onInput={setCharacteristicUuid}
        onSubmit={setCharacteristicUuid}
        placeholder="Characteristic UUID"
      />
      <View class="flex-row flex-wrap gap-2">
        <MobileButton
          label="Read"
          compact
          disabled={
            readState().phase === "loading" || selected()?.canRead !== true
          }
          onPress={() => void runBleRequest("read")}
        />
        <MobileButton
          label="Start notify"
          kind="outlined"
          compact
          disabled={
            notifyPhase() === "starting" ||
            notifyPhase() === "watching" ||
            props.adapter === undefined
          }
          onPress={startNotifications}
        />
        <MobileButton
          label="Stop notify"
          kind="outlined"
          compact
          disabled={notifyStream() === undefined}
          onPress={() => stopNotifications()}
        />
      </View>
      <Text
        class={
          readState().phase === "error"
            ? errorTextClass(props.dark)
            : bodyTextClass(props.dark)
        }
      >
        Read · {actionStatus(readState())}
      </Text>
      <InputField
        value={writeInput}
        onInput={setWriteInput}
        onSubmit={setWriteInput}
        placeholder="Write bytes, e.g. 1, 2, 255"
      />
      <MobileSwitch
        value={withResponse()}
        label={
          withResponse() ? "Write with response" : "Write without response"
        }
        onChange={setWithResponse}
      />
      <View class="flex-row flex-wrap gap-2">
        <MobileButton
          label="Write"
          compact
          disabled={
            writeState().phase === "loading" ||
            !(selected()?.canWrite || selected()?.canWriteWithoutResponse)
          }
          onPress={() => void runBleRequest("write")}
        />
      </View>
      <Text
        class={
          writeState().phase === "error"
            ? errorTextClass(props.dark)
            : bodyTextClass(props.dark)
        }
      >
        Write · {actionStatus(writeState())}
      </Text>
      <Text class={valueTextClass(props.dark)}>
        Notifications · {notifyPhase()} · samples {notifyCount()} ·{" "}
        {notifyLatest()}
      </Text>
      <Show when={notifyFailure()}>
        {(detail) => (
          <Text class={errorTextClass(props.dark)}>
            {detail().code} · {detail().message}
          </Text>
        )}
      </Show>
    </MobileCard>
  );
}
