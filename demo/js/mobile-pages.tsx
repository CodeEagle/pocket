import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  InputField,
  MobileAppBar,
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileDialog,
  MobileFilledButton,
  MobileListTile,
  MobileScaffold,
  MobileSegmentedControl,
  MobileStepper,
  MobileSwitch,
  PlatformTextureSurface,
  MOBILE_THEME_DARK,
  MOBILE_THEME_LIGHT,
  MobileThemeProvider,
  FlutterChip,
  FlutterDivider,
  FlutterFloatingActionButton,
  FlutterIconButton,
  FlutterLinearProgressIndicator,
  FlutterNavigationDestination,
} from "@pocket/ui";
import {
  TRANSITION_MODES,
  computeTransitionDescriptor,
  type TransitionMode,
} from "@pocket/ui";
import type { JsonValue } from "@pocket/ui/host";
import type { HostBridge } from "@pocket/ui/host";
import type { PlatformExperience } from "@pocket/ui/platform-experience";
import {
  createPocketStreamAdapter,
  type PocketStreamAdapter,
} from "@pocket/ui/streams";
import type {
  CapabilityKey,
  CapabilityState,
  DemoEvent,
  DemoState,
  HardwareCapability,
  HardwarePermission,
} from "./state.ts";
import {
  HardwareStreamsPanel,
  PlatformExperiencePanel,
} from "./capability-panels.tsx";

export type MobilePageProps = {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  requestCapability: (
    key: CapabilityKey,
    capability: string,
    params?: Record<string, JsonValue>,
  ) => void;
  host?: HostBridge;
  experience?: PlatformExperience;
};

function capabilityTone(
  state: CapabilityState,
): "accent" | "success" | "warning" | "danger" {
  if (state.phase === "ready") return "success";
  if (state.phase === "loading") return "warning";
  if (state.phase === "error") return "danger";
  return "accent";
}

export function MobileUiPage(props: MobilePageProps): JSX.Element {
  const [selected, setSelected] = createSignal("overview");
  const dark = () => props.state().mobileDark;
  const [enabled, setEnabled] = createSignal(true);
  const [level, setLevel] = createSignal(3);
  const [draft, setDraft] = createSignal("");
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [destination, setDestination] = createSignal("home");
  const toggleTheme = (): void => {
    const next = !dark();
    props.dispatch({ type: "setMobileDark", value: next });
  };
  return (
    <MobileThemeProvider
      theme={() => (dark() ? MOBILE_THEME_DARK : MOBILE_THEME_LIGHT)}
    >
      <MobileScaffold
        class={
          dark()
            ? "flex-col gap-4 p-4 bg-[#0E1728]"
            : "flex-col gap-4 p-4 bg-[#F5F6FA]"
        }
      >
        <MobileAppBar
          title="Mobile UI"
          subtitle="JS-owned components"
          leading={
            <MobileButton
              label="Back"
              kind="text"
              compact
              onPress={() => props.dispatch({ type: "popRoute" })}
            />
          }
          dark={dark()}
          trailing={
            <View class="flex-row items-center gap-1">
              <MobileBadge label="JS" tone="success" />
              <MobileButton
                label={dark() ? "Light" : "Dark"}
                kind="text"
                compact
                onPress={toggleTheme}
              />
            </View>
          }
        />
        <MobileSegmentedControl
          items={[
            { id: "overview", label: "Overview" },
            { id: "controls", label: "Controls" },
          ]}
          active={selected()}
          onChange={setSelected}
        />
        <Show when={selected() === "overview"}>
          <MobileCard
            title="Scaffold + AppBar"
            detail="Shared mobile primitives."
            class={
              dark()
                ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
                : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
            }
          >
            <MobileListTile
              title="ListTile"
              detail="JS-owned press semantics."
              leading={<MobileBadge label="UI" />}
              trailing={
                <MobileButton
                  label="Open"
                  kind="text"
                  compact
                  onPress={() => setDialogOpen(true)}
                />
              }
              onPress={() => setDialogOpen(true)}
            />
            <View class="flex-row flex-wrap gap-2">
              <MobileFilledButton
                label="Primary"
                compact
                onPress={() =>
                  props.dispatch({
                    type: "setTransitionMode",
                    mode: "IOS_SPRING_PARALLAX",
                  })
                }
              />
              <MobileButton
                label="Transitions"
                kind="outlined"
                compact
                onPress={() =>
                  props.dispatch({ type: "navigate", route: "transitions" })
                }
              />
            </View>
          </MobileCard>
          <MobileCard
            title="Flutter widgets"
            detail="Official @pocket/ui adapters."
            class={
              dark()
                ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
                : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
            }
          >
            <Text
              class={
                dark() ? "text-xs text-[#B9C5D8]" : "text-xs text-[#17233B]"
              }
            >
              Widget actions
            </Text>
            <View class="flex-row items-center gap-2">
              <FlutterChip
                label="Chip"
                selected={enabled()}
                onPress={() => setEnabled((value) => !value)}
              />
              <FlutterIconButton
                icon="⋯"
                tooltip="More"
                onPress={() => setDialogOpen(true)}
              />
              <FlutterFloatingActionButton
                icon="+"
                tooltip="Increment"
                onPress={() => props.dispatch({ type: "increment" })}
              />
            </View>
            <FlutterDivider />
            <Text
              class={
                dark() ? "text-xs text-[#B9C5D8]" : "text-xs text-[#17233B]"
              }
            >
              Progress · {level()}/10
            </Text>
            <FlutterLinearProgressIndicator value={level() / 10} />
            <View class="flex-row items-center gap-1">
              <FlutterNavigationDestination
                icon="⌂"
                label="Home"
                selected={destination() === "home"}
                onPress={() => setDestination("home")}
              />
              <FlutterNavigationDestination
                icon="◉"
                label="Library"
                selected={destination() === "library"}
                onPress={() => setDestination("library")}
              />
            </View>
          </MobileCard>
        </Show>
        <Show when={selected() === "controls"}>
          <MobileCard
            title="Controls"
            detail="Signals and input stay in JS."
            class={
              dark()
                ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
                : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
            }
          >
            <MobileSwitch
              value={enabled()}
              label={enabled() ? "Enabled" : "Disabled"}
              onChange={setEnabled}
            />
            <MobileStepper
              value={level()}
              min={0}
              max={10}
              onChange={setLevel}
            />
            <InputField
              value={draft}
              onInput={setDraft}
              onSubmit={setDraft}
              placeholder="System keyboard input"
            />
            <Text
              class={
                dark() ? "text-xs text-[#B9C5D8]" : "text-xs text-[#17233B]"
              }
            >
              State · {enabled() ? "on" : "off"} · level {String(level())}
            </Text>
            <Text
              class={
                dark() ? "text-xs text-[#B9C5D8]" : "text-xs text-[#17233B]"
              }
            >
              Draft · {draft() || "(empty)"}
            </Text>
            <MobileFilledButton
              label="Show dialog"
              onPress={() => setDialogOpen(true)}
            />
          </MobileCard>
        </Show>
        <MobileDialog
          open={dialogOpen()}
          title="JS-owned dialog"
          body="Modal portal; state stays in JS."
          onClose={() => setDialogOpen(false)}
        />
      </MobileScaffold>
    </MobileThemeProvider>
  );
}
const transitionLabels: Record<TransitionMode, string> = {
  IOS_SPRING_PARALLAX: "iOS parallax",
  SHARED_AXIS_Z: "Shared axis",
  LIQUID_GLASS_MORPH: "Glass morph",
  PORTAL_EXPAND: "Portal expand",
};

const transitionModeLabels: Record<TransitionMode, string> = {
  IOS_SPRING_PARALLAX: "iOS spring",
  SHARED_AXIS_Z: "Shared axis",
  LIQUID_GLASS_MORPH: "Glass",
  PORTAL_EXPAND: "Portal",
};

// Keep the shared transition enum intact, but do not expose the deferred
// glass mode as a selectable Demo route-motion option.
const demoTransitionModes = TRANSITION_MODES.filter(
  (id) => id !== "LIQUID_GLASS_MORPH",
);

export function TransitionsPage(props: MobilePageProps): JSX.Element {
  const [progress, setProgress] = createSignal(0.55);
  const descriptor = () =>
    computeTransitionDescriptor(
      props.state().transitionMode,
      progress(),
      false,
      360,
    );
  const dark = () => props.state().mobileDark;
  const modeItems = demoTransitionModes.map((id) => ({
    id,
    label: transitionModeLabels[id],
  }));
  return (
    <MobileThemeProvider
      theme={() => (dark() ? MOBILE_THEME_DARK : MOBILE_THEME_LIGHT)}
    >
      <MobileScaffold
        class={
          dark()
            ? "flex-col gap-4 p-4 bg-[#0E1728]"
            : "flex-col gap-4 p-4 bg-[#F5F6FA]"
        }
      >
        <MobileAppBar
          title="Transitions"
          subtitle="Route motion"
          leading={
            <MobileButton
              label="Back"
              kind="text"
              compact
              onPress={() => props.dispatch({ type: "popRoute" })}
            />
          }
          dark={dark()}
          trailing={
            <MobileBadge
              label={transitionModeLabels[props.state().transitionMode]}
            />
          }
        />
        <MobileCard
          title="Mode"
          detail="JS route descriptor."
          class={
            dark()
              ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
              : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
          }
        >
          <MobileSegmentedControl
            items={modeItems}
            active={props.state().transitionMode}
            onChange={(id) =>
              props.dispatch({
                type: "setTransitionMode",
                mode: id as TransitionMode,
              })
            }
          />
          <MobileStepper
            value={Math.round(progress() * 100)}
            min={0}
            max={100}
            onChange={(value) => setProgress(value / 100)}
          />
          <Text
            class={dark() ? "text-xs text-[#B9C5D8]" : "text-xs text-[#17233B]"}
          >
            Progress {Math.round(progress() * 100)}% · in{" "}
            {descriptor().inTx.toFixed(1)} · out {descriptor().outTx.toFixed(1)}
          </Text>
          <View
            class={
              dark()
                ? "relative h-[64] overflow-hidden rounded-xl bg-[#22314A]"
                : "relative h-[64] overflow-hidden rounded-xl bg-[#EEF1F6]"
            }
          >
            <View
              class="absolute inset-2 flex-col justify-center rounded-lg bg-[#315DEB] px-3"
              style={{
                translateX: descriptor().inTx,
                translateY: descriptor().inTy,
                scale: descriptor().inScale,
              }}
            >
              <Text class="text-xs text-white font-bold">Incoming preview</Text>
              <Text class="text-xs text-[#E8EDFF]">
                {transitionLabels[props.state().transitionMode]}
              </Text>
            </View>
          </View>
        </MobileCard>
        <MobileCard
          title="Route stack"
          detail="Push/pop in the guest reducer."
          class={
            dark()
              ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
              : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
          }
        >
          <View class="flex-row flex-wrap gap-1">
            <For each={props.state().routeStack}>
              {(route) => (
                <MobileBadge
                  label={route}
                  tone={route === props.state().route ? "success" : "accent"}
                />
              )}
            </For>
          </View>
          <View class="flex-row flex-wrap gap-2">
            <MobileFilledButton
              label="Push Mobile"
              onPress={() =>
                props.dispatch({ type: "navigate", route: "mobile" })
              }
            />
            <MobileButton
              label="Back"
              kind="outlined"
              compact
              onPress={() => props.dispatch({ type: "popRoute" })}
            />
          </View>
        </MobileCard>
      </MobileScaffold>
    </MobileThemeProvider>
  );
}
const hardwarePermissions: readonly {
  name: HardwarePermission;
  label: string;
}[] = [
  { name: "hardware.camera", label: "Camera" },
  { name: "hardware.photos", label: "Photos" },
  { name: "hardware.bluetooth", label: "Bluetooth" },
  { name: "hardware.sensors", label: "Sensors" },
  { name: "hardware.biometrics", label: "Biometrics" },
  { name: "hardware.location", label: "Location" },
  { name: "hardware.microphone", label: "Microphone" },
  { name: "hardware.network", label: "Network" },
];

function objectResult(
  state: CapabilityState,
): Record<string, unknown> | undefined {
  return state.result &&
    typeof state.result === "object" &&
    !Array.isArray(state.result)
    ? (state.result as Record<string, unknown>)
    : undefined;
}

function compactText(value: unknown, limit = 44): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit
    ? `${text.slice(0, Math.max(1, limit - 1))}…`
    : text;
}

const hardwareCapabilityLabels: Record<HardwareCapability, string> = {
  "hardware.permissions": "Permission check",
  "hardware.permissions.request": "Permission request",
  "hardware.camera.preview.start": "Preview start",
  "hardware.camera.preview.stop": "Preview stop",
  "hardware.camera.lens.switch": "Lens switch",
  "hardware.camera.flash.toggle": "Flash mode",
  "hardware.camera.capture": "Photo capture",
  "hardware.photos.list": "Photo list",
  "hardware.photos.delete": "Photo delete",
  "hardware.bluetooth.scan": "BLE scan",
  "hardware.bluetooth.connect": "BLE connect",
  "hardware.sensors.read": "Sensor read",
  "hardware.biometrics.authenticate": "Biometric check",
  "hardware.location.current": "Current location",
  "hardware.weather.current": "Current weather",
};

function permissionLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = Object.entries(value as Record<string, unknown>);
  const granted = entries.filter(
    ([, item]) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).granted === true,
  ).length;
  const lines = [`${granted}/${entries.length} permissions granted`];
  for (const [name, item] of entries.slice(0, 3)) {
    const record =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    const status =
      record.granted === true
        ? "Granted"
        : compactText(record.status ?? "Unavailable", 24);
    lines.push(`${name} · ${status}`);
  }
  if (entries.length > 3) lines.push(`+${entries.length - 3} more`);
  return lines;
}

function capabilityLines(
  state: CapabilityState,
  capability: HardwareCapability,
): string[] {
  if (state.phase === "idle") return ["Not requested"];
  if (state.phase === "loading") return ["Waiting for host response…"];
  if (state.phase === "error")
    return [
      state.error?.code ?? "host_error",
      compactText(state.error?.message ?? "Host request failed", 34),
    ];
  if (state.result === null || state.result === undefined)
    return ["Host returned no result"];
  if (Array.isArray(state.result))
    return [
      `${state.result.length} item${state.result.length === 1 ? "" : "s"}`,
    ];

  const result = objectResult(state);
  if (!result) return [compactText(state.result, 34) || "Completed"];
  const lines: string[] = [];
  if (result.permissions) lines.push(...permissionLines(result.permissions));
  if (Array.isArray(result.photos))
    lines.push(
      `${result.photos.length} saved photo${result.photos.length === 1 ? "" : "s"}`,
    );
  if (Array.isArray(result.devices))
    lines.push(
      `${result.devices.length} device${result.devices.length === 1 ? "" : "s"} found`,
    );
  if (
    typeof result.textureId === "number" &&
    typeof result.width === "number" &&
    typeof result.height === "number"
  ) {
    lines.push(
      `Texture ${result.textureId} · ${result.width}×${result.height}`,
    );
  }
  if (typeof result.fileName === "string")
    lines.push(compactText(result.fileName, 28));
  if (result.deleted === true) lines.push("Deleted");
  if (typeof result.authenticated === "boolean")
    lines.push(result.authenticated ? "Authenticated" : "Not authenticated");
  if (typeof result.status === "string")
    lines.push(`Status · ${compactText(result.status, 30)}`);
  if (
    typeof result.latitude === "number" &&
    typeof result.longitude === "number"
  ) {
    lines.push(
      `Location ${result.latitude.toFixed(3)}, ${result.longitude.toFixed(3)}`,
    );
  }
  if (typeof result.temperature_2m === "number")
    lines.push(`Temperature ${result.temperature_2m.toFixed(1)}°`);
  const currentWeather =
    result.current &&
    typeof result.current === "object" &&
    !Array.isArray(result.current)
      ? (result.current as Record<string, unknown>)
      : undefined;
  if (currentWeather) {
    const temperature =
      typeof currentWeather.temperature_2m === "number"
        ? `${currentWeather.temperature_2m.toFixed(1)}°`
        : "—";
    const wind =
      typeof currentWeather.wind_speed_10m === "number"
        ? `${currentWeather.wind_speed_10m.toFixed(0)} wind`
        : "";
    lines.push(`Current ${temperature}${wind ? ` · ${wind}` : ""}`);
  }
  const motion = ["accelX", "accelY", "accelZ"]
    .map((key) => result[key])
    .filter((value): value is number => typeof value === "number");
  if (motion.length === 3)
    lines.push(`Motion ${motion.map((value) => value.toFixed(2)).join(" · ")}`);
  if (typeof result.pressureHpa === "number")
    lines.push(`Pressure ${result.pressureHpa.toFixed(1)} hPa`);
  if (result.ok === true && lines.length === 0) lines.push("Completed");
  if (
    result.realHardware === true ||
    result.realHardwareCamera === true ||
    result.realSensors === true ||
    result.realBiometrics === true ||
    result.realGps === true ||
    result.realNetwork === true
  ) {
    lines.push("Live host result");
  }
  if (lines.length === 0) {
    const summary = Object.entries(result)
      .filter(([key]) => key !== "ok" && key !== "provider" && key !== "source")
      .slice(0, 2)
      .map(([key, value]) => `${key} · ${compactText(value, 28)}`);
    lines.push(...summary);
  }
  return lines.length > 0
    ? lines.slice(0, 5)
    : [hardwareCapabilityLabels[capability]];
}

function resultInt(state: CapabilityState, key: string): number | undefined {
  const value = objectResult(state)?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function photosFrom(
  state: CapabilityState,
): { id: string; path: string; title: string }[] {
  const result = state.result;
  const items = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { photos?: unknown }).photos)
      ? (result as { photos: unknown[] }).photos
      : [];
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    const path = String(value.filePath ?? value.path ?? value.id ?? "");
    if (!path) return [];
    return [
      {
        id: `${index}-${path}`,
        path,
        title: String(value.name ?? value.title ?? path),
      },
    ];
  });
}

function compactPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) ?? normalized;
  return compactText(name || normalized, 32);
}

function compactIdentifier(value: string): string {
  if (value.length <= 28) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function bluetoothDevicesFrom(
  state: CapabilityState,
): { id: string; name: string }[] {
  const result = objectResult(state);
  const items = Array.isArray(result?.devices) ? result.devices : [];
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    const id = String(value.deviceId ?? value.id ?? "");
    if (!id) return [];
    return [
      {
        id,
        name: compactText(String(value.name ?? `Device ${index + 1}`), 28),
      },
    ];
  });
}

function HardwareResult(props: {
  label: string;
  capability: HardwareCapability;
  state: CapabilityState;
  onRefresh?: () => void;
  dark?: boolean;
}): JSX.Element {
  return (
    <View
      class={
        props.dark
          ? "flex-col gap-1 px-3 py-2 rounded-xl bg-[#22314A] border-[#30405A]"
          : "flex-col gap-1 px-3 py-2 rounded-xl bg-[#F1F3F8] border-[#E5E9F2]"
      }
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text
          class={
            props.dark
              ? "text-xs text-white font-bold"
              : "text-xs text-[#17233B] font-bold"
          }
        >
          {props.label}
        </Text>
        <MobileBadge
          label={props.state.phase}
          tone={capabilityTone(props.state)}
        />
      </View>
      <Text
        class={props.dark ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}
      >
        {hardwareCapabilityLabels[props.capability]}
      </Text>
      <For each={capabilityLines(props.state, props.capability)}>
        {(line) => (
          <Text
            class={
              props.state.phase === "error"
                ? props.dark
                  ? "text-xs text-rose-300"
                  : "text-xs text-rose-700"
                : props.dark
                  ? "text-xs text-white"
                  : "text-xs text-[#17233B]"
            }
          >
            {line}
          </Text>
        )}
      </For>
      <Show when={props.onRefresh !== undefined}>
        <MobileButton
          label={props.state.phase === "loading" ? "Waiting" : "Refresh"}
          kind="text"
          compact
          onPress={props.onRefresh}
        />
      </Show>
    </View>
  );
}

export function HardwarePage(props: MobilePageProps): JSX.Element {
  const [lens, setLens] = createSignal<"back" | "front">("back");
  const [flash, setFlash] = createSignal<"auto" | "on" | "off">("auto");
  const [deletePath, setDeletePath] = createSignal<string | undefined>(
    undefined,
  );
  const dark = () => props.state().mobileDark;
  const permissions = () => props.state().hardwarePermissions;
  const preview = () => props.state().hardwareCameraPreviewStart;
  let streamAdapter: PocketStreamAdapter | undefined;
  if (props.host) {
    try {
      streamAdapter = createPocketStreamAdapter(props.host, {
        maxActiveStreams: 4,
        maxBufferedMessages: 8,
      });
    } catch {
      streamAdapter = undefined;
    }
  }
  const deleteDescription = () => {
    const path = deletePath();
    return path ? `Delete ${compactPath(path)}?` : "Choose a photo first.";
  };
  const previewTexture = () => {
    const textureId = resultInt(preview(), "textureId");
    const width = resultInt(preview(), "width");
    const height = resultInt(preview(), "height");
    const rotationDegrees = resultInt(preview(), "previewRotationDegrees") ?? 0;
    const mirrorX = objectResult(preview())?.previewMirrorX === true;
    return textureId === undefined ||
      width === undefined ||
      height === undefined
      ? undefined
      : { textureId, width, height, rotationDegrees, mirrorX };
  };
  const previewReady = () =>
    preview().phase === "ready" && previewTexture() !== undefined;
  onCleanup(() => {
    if (previewReady())
      props.requestCapability(
        "hardwareCameraPreviewStop",
        "hardware.camera.preview.stop",
      );
    streamAdapter?.dispose("hardware_page_unmounted");
  });
  return (
    <MobileThemeProvider
      theme={() => (dark() ? MOBILE_THEME_DARK : MOBILE_THEME_LIGHT)}
    >
      <MobileScaffold
        class={
          dark()
            ? "flex-col gap-4 p-4 bg-[#0E1728]"
            : "flex-col gap-4 p-4 bg-[#F5F6FA]"
        }
      >
        <MobileAppBar
          title="Hardware"
          subtitle="Camera · sensors · access"
          leading={
            <MobileButton
              label="Back"
              kind="text"
              compact
              onPress={() => props.dispatch({ type: "popRoute" })}
            />
          }
          dark={dark()}
          trailing={<MobileBadge label="host" tone="warning" />}
        />
        <MobileCard
          title="Permissions"
          detail="Check access or request one item."
          class={
            dark()
              ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
              : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
          }
        >
          <HardwareResult
            label="Current state"
            capability="hardware.permissions"
            state={permissions()}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwarePermissions",
                "hardware.permissions",
              )
            }
          />
          <For each={hardwarePermissions}>
            {(item) => (
              <MobileListTile
                title={item.label}
                detail={`${item.label} access`}
                trailing={
                  <MobileButton
                    label={
                      props.state().hardwarePermissionRequest.phase ===
                      "loading"
                        ? "Waiting"
                        : "Request"
                    }
                    kind="text"
                    compact
                    disabled={
                      props.state().hardwarePermissionRequest.phase ===
                      "loading"
                    }
                    onPress={() =>
                      props.requestCapability(
                        "hardwarePermissionRequest",
                        "hardware.permissions.request",
                        { permission: item.name },
                      )
                    }
                  />
                }
              />
            )}
          </For>
        </MobileCard>
        <MobileCard
          title="Camera"
          detail="Preview uses host texture."
          class={
            dark()
              ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
              : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
          }
        >
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label={
                preview().phase === "loading"
                  ? "Starting"
                  : previewReady()
                    ? "Preview on"
                    : "Start preview"
              }
              compact
              disabled={preview().phase === "loading" || previewReady()}
              onPress={() => {
                props.requestCapability(
                  "hardwareCameraPreviewStart",
                  "hardware.camera.preview.start",
                  { lens: lens() },
                );
              }}
            />
            <MobileButton
              label={
                props.state().hardwareCameraPreviewStop.phase === "loading"
                  ? "Stopping"
                  : "Stop"
              }
              kind="outlined"
              compact
              disabled={
                props.state().hardwareCameraPreviewStop.phase === "loading"
              }
              onPress={() => {
                props.requestCapability(
                  "hardwareCameraPreviewStop",
                  "hardware.camera.preview.stop",
                );
              }}
            />
          </View>
          <Show when={previewTexture()}>
            {(texture) => (
              <PlatformTextureSurface
                textureId={texture().textureId}
                sourceWidth={texture().width}
                sourceHeight={texture().height}
                rotationDegrees={texture().rotationDegrees}
                mirrorX={texture().mirrorX}
                class="relative w-full h-[150] rounded-xl bg-[#17233B]"
              />
            )}
          </Show>
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label={`Lens ${lens()}`}
              kind="text"
              compact
              onPress={() => {
                const next = lens() === "back" ? "front" : "back";
                setLens(next);
                props.requestCapability(
                  "hardwareCameraLensSwitch",
                  "hardware.camera.lens.switch",
                  { lens: next },
                );
              }}
            />
            <MobileButton
              label={`Flash ${flash()}`}
              kind="text"
              compact
              onPress={() => {
                const next =
                  flash() === "auto" ? "on" : flash() === "on" ? "off" : "auto";
                setFlash(next);
                props.requestCapability(
                  "hardwareCameraFlashToggle",
                  "hardware.camera.flash.toggle",
                  { flash: next },
                );
              }}
            />
            <MobileButton
              label={
                props.state().hardwareCameraCapture.phase === "loading"
                  ? "Capturing"
                  : "Capture"
              }
              kind="outlined"
              compact
              disabled={props.state().hardwareCameraCapture.phase === "loading"}
              onPress={() =>
                props.requestCapability(
                  "hardwareCameraCapture",
                  "hardware.camera.capture",
                )
              }
            />
          </View>
          <HardwareResult
            label="Preview"
            capability="hardware.camera.preview.start"
            state={preview()}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareCameraPreviewStart",
                "hardware.camera.preview.start",
                { lens: lens() },
              )
            }
          />
          <HardwareResult
            label="Capture"
            capability="hardware.camera.capture"
            state={props.state().hardwareCameraCapture}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareCameraCapture",
                "hardware.camera.capture",
              )
            }
          />
        </MobileCard>
        <MobileCard
          title="Photos"
          detail="Delete always requires confirmation."
          class={
            dark()
              ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
              : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
          }
        >
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label={
                props.state().hardwarePhotosList.phase === "loading"
                  ? "Loading"
                  : "List photos"
              }
              compact
              disabled={props.state().hardwarePhotosList.phase === "loading"}
              onPress={() =>
                props.requestCapability(
                  "hardwarePhotosList",
                  "hardware.photos.list",
                )
              }
            />
          </View>
          <HardwareResult
            label="Photo provider"
            capability="hardware.photos.list"
            state={props.state().hardwarePhotosList}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwarePhotosList",
                "hardware.photos.list",
              )
            }
          />
          <For each={photosFrom(props.state().hardwarePhotosList)}>
            {(photo) => (
              <MobileListTile
                title={compactText(photo.title, 28)}
                detail={compactPath(photo.path)}
                trailing={
                  <MobileButton
                    label="Delete"
                    kind="danger"
                    compact
                    onPress={() => setDeletePath(photo.path)}
                  />
                }
              />
            )}
          </For>
          <HardwareResult
            label="Delete"
            capability="hardware.photos.delete"
            state={props.state().hardwarePhotosDelete}
            dark={dark()}
          />
        </MobileCard>
        <MobileCard
          title="Connectivity"
          detail="BLE and sensors use host permissions."
          class={
            dark()
              ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
              : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
          }
        >
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label={
                props.state().hardwareBluetoothScan.phase === "loading"
                  ? "Scanning"
                  : "Scan BLE"
              }
              compact
              disabled={props.state().hardwareBluetoothScan.phase === "loading"}
              onPress={() =>
                props.requestCapability(
                  "hardwareBluetoothScan",
                  "hardware.bluetooth.scan",
                  { timeoutMs: 1600 },
                )
              }
            />
            <MobileButton
              label={
                props.state().hardwareSensorsRead.phase === "loading"
                  ? "Reading"
                  : "Read sensors"
              }
              kind="outlined"
              disabled={props.state().hardwareSensorsRead.phase === "loading"}
              onPress={() =>
                props.requestCapability(
                  "hardwareSensorsRead",
                  "hardware.sensors.read",
                )
              }
            />
          </View>
          <HardwareResult
            label="BLE"
            capability="hardware.bluetooth.scan"
            state={props.state().hardwareBluetoothScan}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareBluetoothScan",
                "hardware.bluetooth.scan",
                { timeoutMs: 1600 },
              )
            }
          />
          <For each={bluetoothDevicesFrom(props.state().hardwareBluetoothScan)}>
            {(device) => (
              <MobileListTile
                title={device.name}
                detail={compactIdentifier(device.id)}
                trailing={
                  <MobileButton
                    label="Connect"
                    kind="text"
                    compact
                    onPress={() =>
                      props.requestCapability(
                        "hardwareBluetoothConnect",
                        "hardware.bluetooth.connect",
                        { deviceId: device.id },
                      )
                    }
                  />
                }
              />
            )}
          </For>
          <HardwareResult
            label="Sensors"
            capability="hardware.sensors.read"
            state={props.state().hardwareSensorsRead}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareSensorsRead",
                "hardware.sensors.read",
              )
            }
          />
          <HardwareResult
            label="BLE connect"
            capability="hardware.bluetooth.connect"
            state={props.state().hardwareBluetoothConnect}
            dark={dark()}
          />
        </MobileCard>
        <MobileCard
          title="Device services"
          detail="Each action calls the host."
          class={
            dark()
              ? "flex-col gap-3 p-4 rounded-xl bg-[#17233B] border-[#30405A]"
              : "flex-col gap-3 p-4 rounded-xl bg-white border-[#E5E9F2]"
          }
        >
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label="Biometrics"
              compact
              onPress={() =>
                props.requestCapability(
                  "hardwareBiometricsAuthenticate",
                  "hardware.biometrics.authenticate",
                  { reason: "Pocket Host Lab" },
                )
              }
            />
            <MobileButton
              label="Location"
              kind="outlined"
              compact
              onPress={() =>
                props.requestCapability(
                  "hardwareLocationCurrent",
                  "hardware.location.current",
                )
              }
            />
            <MobileButton
              label="Weather"
              kind="outlined"
              compact
              onPress={() =>
                props.requestCapability(
                  "hardwareWeatherCurrent",
                  "hardware.weather.current",
                )
              }
            />
          </View>
          <HardwareResult
            label="Biometrics"
            capability="hardware.biometrics.authenticate"
            state={props.state().hardwareBiometricsAuthenticate}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareBiometricsAuthenticate",
                "hardware.biometrics.authenticate",
                { reason: "Pocket Host Lab" },
              )
            }
          />
          <HardwareResult
            label="Location"
            capability="hardware.location.current"
            state={props.state().hardwareLocationCurrent}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareLocationCurrent",
                "hardware.location.current",
              )
            }
          />
          <HardwareResult
            label="Weather"
            capability="hardware.weather.current"
            state={props.state().hardwareWeatherCurrent}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareWeatherCurrent",
                "hardware.weather.current",
              )
            }
          />
        </MobileCard>
        <PlatformExperiencePanel dark={dark()} experience={props.experience} />
        <HardwareStreamsPanel
          dark={dark()}
          host={props.host}
          adapter={streamAdapter}
          bluetoothConnect={props.state().hardwareBluetoothConnect}
        />
        <MobileDialog
          open={() => deletePath() !== undefined}
          title="Delete photo?"
          body={deleteDescription()}
          onClose={() => setDeletePath(undefined)}
        >
          <MobileButton
            label="Confirm delete"
            kind="danger"
            onPress={() => {
              const path = deletePath();
              if (path)
                props.requestCapability(
                  "hardwarePhotosDelete",
                  "hardware.photos.delete",
                  { filePath: path },
                );
              setDeletePath(undefined);
            }}
          />
        </MobileDialog>
      </MobileScaffold>
    </MobileThemeProvider>
  );
}
