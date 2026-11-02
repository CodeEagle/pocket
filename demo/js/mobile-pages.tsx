import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  GlassSurface,
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
  buildLiquidGlassRecipe,
  computeTransitionDescriptor,
  type GlassShape,
  type TransitionMode,
} from "@pocket/ui";
import type { JsonValue } from "./host.ts";
import type { CapabilityKey, CapabilityState, DemoEvent, DemoState, HardwareCapability, HardwarePermission } from "./state.ts";

export type MobilePageProps = {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  requestCapability: (key: CapabilityKey, capability: string, params?: Record<string, JsonValue>) => void;
};

function capabilityText(state: CapabilityState): string {
  if (state.phase === "idle") return "Not requested";
  if (state.phase === "loading") return "Waiting for host.response…";
  if (state.phase === "error") return `${state.error?.code ?? "host_error"}: ${state.error?.message ?? "Host request failed"}`;
  if (state.result === null || state.result === undefined) return "Host returned no result";
  try {
    const encoded = JSON.stringify(state.result);
    return encoded && encoded.length > 180 ? `${encoded.slice(0, 177)}…` : encoded ?? String(state.result);
  } catch {
    return String(state.result);
  }
}

function capabilityTone(state: CapabilityState): "accent" | "success" | "warning" | "danger" {
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
    <MobileThemeProvider theme={() => dark() ? MOBILE_THEME_DARK : MOBILE_THEME_LIGHT}>
      <MobileScaffold class={dark() ? "flex-col gap-2 p-2 bg-[#0d1726]" : "flex-col gap-2 p-2 bg-slate-50"}>
        <MobileAppBar
          title="Mobile UI"
          subtitle="Components · JS-owned"
          leading={<MobileButton label="Back" kind="text" compact onPress={() => props.dispatch({ type: "popRoute" })} />}
          dark={dark()}
          trailing={<View class="flex-row items-center gap-1"><MobileBadge label="JS" tone="success" /><MobileButton class={dark() ? "h-[48] w-[64] mt-3 items-center justify-center rounded-lg bg-[#22314a]" : "h-[48] w-[64] items-center justify-center rounded-lg bg-slate-100"} label={dark() ? "Light" : "Dark"} kind="text" onPress={toggleTheme} /></View>}
        />
        <MobileSegmentedControl
          items={[{ id: "overview", label: "Overview" }, { id: "controls", label: "Controls" }]}
          active={selected()}
          onChange={setSelected}
        />
        <Show when={selected() === "overview"}>
          <MobileCard title="Scaffold + AppBar" detail="Shared theme tokens.">
            <MobileListTile title="ListTile" detail="JS-owned press semantics." leading={<MobileBadge label="UI" />} trailing={<MobileButton label="Open" kind="text" compact onPress={() => setDialogOpen(true)} />} onPress={() => setDialogOpen(true)} />
            <View class="flex-row gap-2">
              <MobileFilledButton label="Primary" onPress={() => props.dispatch({ type: "setTransitionMode", mode: "IOS_SPRING_PARALLAX" })} />
              <MobileButton label="Transitions" kind="outlined" onPress={() => props.dispatch({ type: "navigate", route: "transitions" })} />
            </View>
          </MobileCard>
          <MobileCard title="Flutter widget vocabulary" detail="Public @pocket/ui adapters composed from official View/Text/Focusable.">
            <View class="flex-row items-center gap-2">
              <FlutterChip label="Chip" selected={enabled()} onPress={() => setEnabled((value) => !value)} />
              <FlutterIconButton icon="⋯" tooltip="More" onPress={() => setDialogOpen(true)} />
              <FlutterFloatingActionButton icon="+" tooltip="Increment" onPress={() => props.dispatch({ type: "increment" })} />
            </View>
            <FlutterDivider />
            <Text class={dark() ? "text-xs text-slate-300" : "text-xs text-slate-600"}>LinearProgressIndicator · {level()}/10</Text>
            <FlutterLinearProgressIndicator value={level() / 10} />
            <View class="flex-row items-center gap-1">
              <FlutterNavigationDestination icon="⌂" label="Home" selected={destination() === "home"} onPress={() => setDestination("home")} />
              <FlutterNavigationDestination icon="◉" label="Library" selected={destination() === "library"} onPress={() => setDestination("library")} />
            </View>
          </MobileCard>
        </Show>
        <Show when={selected() === "controls"}>
          <MobileCard title="Controls" detail="Callbacks and input stay in JS.">
            <MobileSwitch value={enabled()} label={enabled() ? "Enabled" : "Disabled"} onChange={setEnabled} />
            <MobileStepper value={level()} min={0} max={10} onChange={setLevel} />
            <InputField value={draft} onInput={setDraft} onSubmit={setDraft} placeholder="System keyboard input" />
            <Text class={dark() ? "text-xs text-slate-300" : "text-xs text-slate-600"}>Local control state: {enabled() ? "on" : "off"} · level {String(level())}</Text>
            <Text class={dark() ? "text-xs text-slate-300" : "text-xs text-slate-600"}>Draft: {draft() || "(empty)"}</Text>
            <MobileFilledButton label="Show dialog" onPress={() => setDialogOpen(true)} />
          </MobileCard>
        </Show>
        <MobileDialog open={dialogOpen()} title="JS-owned dialog" body="The official Modal portal paints this sheet; the signal and close action are guest-owned." onClose={() => setDialogOpen(false)} />
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

export function TransitionsPage(props: MobilePageProps): JSX.Element {
  const [progress, setProgress] = createSignal(0.55);
  const descriptor = () => computeTransitionDescriptor(props.state().transitionMode, progress(), false, 360);
  const modeItems = TRANSITION_MODES.map((id) => ({ id, label: transitionLabels[id].slice(0, 10) }));
  return (
    <MobileThemeProvider>
      <MobileScaffold class="flex-col gap-2 p-2 bg-slate-50">
        <MobileAppBar title="Transitions" subtitle="Route motion" leading={<MobileButton label="Back" kind="text" compact onPress={() => props.dispatch({ type: "popRoute" })} />} trailing={<MobileBadge label={props.state().transitionMode} />} />
        <MobileCard title="Mode" detail="Pure JS descriptor from the old router.">
          <MobileSegmentedControl items={modeItems} active={props.state().transitionMode} onChange={(id) => props.dispatch({ type: "setTransitionMode", mode: id as TransitionMode })} />
          <MobileStepper value={Math.round(progress() * 100)} min={0} max={100} onChange={(value) => setProgress(value / 100)} />
          <Text class="text-xs text-slate-600">progress {progress().toFixed(2)} · incoming x {descriptor().inTx.toFixed(1)} · outgoing x {descriptor().outTx.toFixed(1)}</Text>
          <View class="relative h-[56] overflow-hidden rounded-lg bg-slate-200">
            <View class="absolute inset-2 flex-col justify-center rounded-lg bg-blue-600 px-3" style={{ translateX: descriptor().inTx, translateY: descriptor().inTy, scale: descriptor().inScale }}>
              <Text class="text-xs text-white font-bold">Incoming route preview</Text>
              <Text class="text-xs text-blue-100">{transitionLabels[props.state().transitionMode]}</Text>
            </View>
          </View>
        </MobileCard>
        <MobileCard title="Route stack" detail="Push/pop in the guest reducer.">
          <View class="flex-row flex-wrap gap-1">
            <For each={props.state().routeStack}>{(route) => <MobileBadge label={route} tone={route === props.state().route ? "success" : "accent"} />}</For>
          </View>
          <View class="flex-row gap-2">
            <MobileFilledButton label="Push Mobile" onPress={() => props.dispatch({ type: "navigate", route: "mobile" })} />
            <MobileButton label="Back" kind="outlined" onPress={() => props.dispatch({ type: "popRoute" })} />
          </View>
        </MobileCard>
      </MobileScaffold>
    </MobileThemeProvider>
  );
}
const glassShapes: readonly GlassShape[] = ["rounded", "pill", "circle"];

export function LiquidGlassPage(props: MobilePageProps): JSX.Element {
  const [shape, setShape] = createSignal<GlassShape>("rounded");
  const [pressed, setPressed] = createSignal(false);
  const recipe = () => buildLiquidGlassRecipe({ shape: shape(), focused: pressed(), warp: true });
  return (
    <MobileThemeProvider>
      <MobileScaffold class="flex-col gap-2 p-2 bg-slate-50">
        <MobileAppBar title="Liquid Glass" subtitle="Native bridge or fallback" leading={<MobileButton label="Back" kind="text" compact onPress={() => props.dispatch({ type: "popRoute" })} />} trailing={<MobileBadge label="glass bridge" tone="accent" />} />
        <MobileCard title="Surface parameters" detail="Recipe values are sent to the host.">
          <MobileSegmentedControl items={glassShapes.map((id) => ({ id, label: id }))} active={shape()} onChange={(id) => setShape(id as GlassShape)} />
          <MobileSwitch value={pressed()} label="Pressed / focused" onChange={setPressed} />
          <Text class="text-xs text-slate-600">blurSigma {recipe().blurSigma} · tint {recipe().tintOpacity.toFixed(2)} · sample refraction {recipe().sample.totalRefraction.toFixed(3)}</Text>
        </MobileCard>
        <View class="relative mx-2 h-[160] overflow-hidden rounded-xl bg-gradient-to-r from-purple-700 via-cyan-500 to-amber-300">
          <View class="absolute inset-3 rounded-xl bg-[#fef08a80]" />
          <GlassSurface shape={shape()} pressed={pressed()} class="relative flex-col gap-2 p-4 rounded-xl border-slate-200">
            <Text class="text-lg text-slate-950 font-bold">Glass region</Text>
            <Text class="text-xs text-slate-700">Registered bridge uses blur/refraction.</Text>
            <Text class="text-xs text-slate-700">Fallback is a gradient only.</Text>
            <MobileButton label="Open hardware surface lane" kind="outlined" onPress={() => props.dispatch({ type: "navigate", route: "hardware" })} />
          </GlassSurface>
        </View>
      </MobileScaffold>
    </MobileThemeProvider>
  );
}

const hardwarePermissions: readonly { name: HardwarePermission; label: string }[] = [
  { name: "hardware.camera", label: "Camera" },
  { name: "hardware.photos", label: "Photos" },
  { name: "hardware.bluetooth", label: "Bluetooth" },
  { name: "hardware.sensors", label: "Sensors" },
  { name: "hardware.biometrics", label: "Biometrics" },
  { name: "hardware.location", label: "Location" },
  { name: "hardware.microphone", label: "Microphone" },
  { name: "hardware.network", label: "Network" },
];

function objectResult(state: CapabilityState): Record<string, unknown> | undefined {
  return state.result && typeof state.result === "object" && !Array.isArray(state.result)
    ? state.result as Record<string, unknown>
    : undefined;
}

function resultString(state: CapabilityState, key: string): string {
  const result = objectResult(state);
  return result?.[key] === undefined ? "" : String(result[key]);
}

function resultInt(state: CapabilityState, key: string): number | undefined {
  const value = objectResult(state)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function photosFrom(state: CapabilityState): { id: string; path: string; title: string }[] {
  const result = state.result;
  const items = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { photos?: unknown }).photos)
      ? (result as { photos: unknown[] }).photos
      : [];
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    const path = String(value.filePath ?? value.path ?? value.id ?? "");
    if (!path) return [];
    return [{ id: `${index}-${path}`, path, title: String(value.name ?? value.title ?? path) }];
  });
}

function bluetoothDevicesFrom(state: CapabilityState): { id: string; name: string }[] {
  const result = objectResult(state);
  const items = Array.isArray(result?.devices) ? result.devices : [];
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    const id = String(value.deviceId ?? value.id ?? "");
    if (!id) return [];
    return [{ id, name: String(value.name ?? `Device ${index + 1}`) }];
  });
}

function HardwareResult(props: { label: string; capability: string; state: CapabilityState; onRefresh?: () => void }): JSX.Element {
  return (
    <View class="flex-col gap-1 px-2 py-1 rounded-lg bg-slate-100">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-xs text-slate-950 font-bold">{props.label}</Text>
        <MobileBadge label={props.state.phase} tone={capabilityTone(props.state)} />
      </View>
      <Text class={props.state.phase === "error" ? "text-xs text-rose-700" : "text-xs text-slate-600"}>{props.capability} · {capabilityText(props.state)}</Text>
      <Show when={props.onRefresh !== undefined}>
        <MobileButton label={props.state.phase === "loading" ? "Waiting" : "Refresh"} kind="text" compact onPress={props.onRefresh} />
      </Show>
    </View>
  );
}

export function HardwarePage(props: MobilePageProps): JSX.Element {
  const [lens, setLens] = createSignal<"back" | "front">("back");
  const [flash, setFlash] = createSignal<"auto" | "on" | "off">("auto");
  const [deletePath, setDeletePath] = createSignal<string | undefined>(undefined);
  const permissions = () => props.state().hardwarePermissions;
  const preview = () => props.state().hardwareCameraPreviewStart;
  const previewTexture = () => {
    const textureId = resultInt(preview(), "textureId");
    const width = resultInt(preview(), "width");
    const height = resultInt(preview(), "height");
    const rotationDegrees = resultInt(preview(), "previewRotationDegrees") ?? 0;
    const mirrorX = objectResult(preview())?.previewMirrorX === true;
    return textureId === undefined || width === undefined || height === undefined
      ? undefined
      : { textureId, width, height, rotationDegrees, mirrorX };
  };
  const previewReady = () => preview().phase === "ready" && previewTexture() !== undefined;
  onCleanup(() => {
    if (previewReady()) props.requestCapability("hardwareCameraPreviewStop", "hardware.camera.preview.stop");
  });
  return (
    <MobileThemeProvider>
      <MobileScaffold class="flex-col gap-2 p-2 bg-slate-50">
        <MobileAppBar title="Hardware" subtitle="Camera, sensors, permissions" leading={<MobileButton label="Back" kind="text" compact onPress={() => props.dispatch({ type: "popRoute" })} />} trailing={<MobileBadge label="host" tone="warning" />} />
        <MobileCard title="Permissions" detail="Query or request one permission.">
          <HardwareResult label="Current state" capability="hardware.permissions" state={permissions()} onRefresh={() => props.requestCapability("hardwarePermissions", "hardware.permissions")} />
          <For each={hardwarePermissions}>
            {(item) => <MobileListTile title={item.label} detail={item.name} trailing={<MobileButton label={props.state().hardwarePermissionRequest.phase === "loading" ? "Waiting" : "Request"} kind="text" compact disabled={props.state().hardwarePermissionRequest.phase === "loading"} onPress={() => props.requestCapability("hardwarePermissionRequest", "hardware.permissions.request", { permission: item.name })} />} />}
          </For>
        </MobileCard>
        <MobileCard title="Camera" detail="Preview binds the returned authorized Texture.">
          <View class="flex-row gap-2">
            <MobileButton label={preview().phase === "loading" ? "Starting" : previewReady() ? "Preview on" : "Start preview"} disabled={preview().phase === "loading" || previewReady()} onPress={() => {
              props.requestCapability("hardwareCameraPreviewStart", "hardware.camera.preview.start", { lens: lens() });
            }} />
            <MobileButton label={props.state().hardwareCameraPreviewStop.phase === "loading" ? "Stopping" : "Stop"} kind="outlined" disabled={props.state().hardwareCameraPreviewStop.phase === "loading"} onPress={() => {
              props.requestCapability("hardwareCameraPreviewStop", "hardware.camera.preview.stop");
            }} />
          </View>
          <Show when={previewTexture()}>
            {(texture) => <PlatformTextureSurface textureId={texture().textureId} sourceWidth={texture().width} sourceHeight={texture().height} rotationDegrees={texture().rotationDegrees} mirrorX={texture().mirrorX} class="relative w-full h-[150] rounded-xl bg-slate-900" />}
          </Show>
          <View class="flex-row gap-2">
            <MobileButton label={`Lens ${lens()}`} kind="text" compact onPress={() => {
              const next = lens() === "back" ? "front" : "back";
              setLens(next);
              props.requestCapability("hardwareCameraLensSwitch", "hardware.camera.lens.switch", { lens: next });
            }} />
            <MobileButton label={`Flash ${flash()}`} kind="text" compact onPress={() => {
              const next = flash() === "auto" ? "on" : flash() === "on" ? "off" : "auto";
              setFlash(next);
              props.requestCapability("hardwareCameraFlashToggle", "hardware.camera.flash.toggle", { flash: next });
            }} />
            <MobileButton label={props.state().hardwareCameraCapture.phase === "loading" ? "Capturing" : "Capture"} kind="outlined" compact disabled={props.state().hardwareCameraCapture.phase === "loading"} onPress={() => props.requestCapability("hardwareCameraCapture", "hardware.camera.capture")} />
          </View>
          <HardwareResult label="Preview" capability="hardware.camera.preview.start" state={preview()} onRefresh={() => props.requestCapability("hardwareCameraPreviewStart", "hardware.camera.preview.start", { lens: lens() })} />
          <HardwareResult label="Capture" capability="hardware.camera.capture" state={props.state().hardwareCameraCapture} onRefresh={() => props.requestCapability("hardwareCameraCapture", "hardware.camera.capture")} />
        </MobileCard>
        <MobileCard title="Photos" detail="Delete always requires confirmation.">
          <View class="flex-row gap-2">
            <MobileButton label={props.state().hardwarePhotosList.phase === "loading" ? "Loading" : "List photos"} disabled={props.state().hardwarePhotosList.phase === "loading"} onPress={() => props.requestCapability("hardwarePhotosList", "hardware.photos.list")} />
          </View>
          <HardwareResult label="Photo provider" capability="hardware.photos.list" state={props.state().hardwarePhotosList} onRefresh={() => props.requestCapability("hardwarePhotosList", "hardware.photos.list")} />
          <For each={photosFrom(props.state().hardwarePhotosList)}>
            {(photo) => <MobileListTile title={photo.title} detail={photo.path} trailing={<MobileButton label="Delete" kind="danger" compact onPress={() => setDeletePath(photo.path)} />} />}
          </For>
          <HardwareResult label="Delete" capability="hardware.photos.delete" state={props.state().hardwarePhotosDelete} />
        </MobileCard>
        <MobileCard title="Connectivity" detail="BLE scan and connect use host-owned permissions.">
          <View class="flex-row gap-2">
            <MobileButton label={props.state().hardwareBluetoothScan.phase === "loading" ? "Scanning" : "Scan BLE"} disabled={props.state().hardwareBluetoothScan.phase === "loading"} onPress={() => props.requestCapability("hardwareBluetoothScan", "hardware.bluetooth.scan", { timeoutMs: 1600 })} />
            <MobileButton label={props.state().hardwareSensorsRead.phase === "loading" ? "Reading" : "Read sensors"} kind="outlined" disabled={props.state().hardwareSensorsRead.phase === "loading"} onPress={() => props.requestCapability("hardwareSensorsRead", "hardware.sensors.read")} />
          </View>
          <HardwareResult label="BLE" capability="hardware.bluetooth.scan" state={props.state().hardwareBluetoothScan} onRefresh={() => props.requestCapability("hardwareBluetoothScan", "hardware.bluetooth.scan", { timeoutMs: 1600 })} />
          <For each={bluetoothDevicesFrom(props.state().hardwareBluetoothScan)}>
            {(device) => <MobileListTile title={device.name} detail={device.id} trailing={<MobileButton label="Connect" kind="text" compact onPress={() => props.requestCapability("hardwareBluetoothConnect", "hardware.bluetooth.connect", { deviceId: device.id })} />} />}
          </For>
          <HardwareResult label="Sensors" capability="hardware.sensors.read" state={props.state().hardwareSensorsRead} onRefresh={() => props.requestCapability("hardwareSensorsRead", "hardware.sensors.read")} />
          <HardwareResult label="BLE connect" capability="hardware.bluetooth.connect" state={props.state().hardwareBluetoothConnect} />
        </MobileCard>
        <MobileCard title="Device services" detail="Each action remains a real host request.">
          <View class="flex-row flex-wrap gap-2">
            <MobileButton label="Biometrics" onPress={() => props.requestCapability("hardwareBiometricsAuthenticate", "hardware.biometrics.authenticate", { reason: "Pocket Host Lab" })} />
            <MobileButton label="Location" kind="outlined" onPress={() => props.requestCapability("hardwareLocationCurrent", "hardware.location.current")} />
            <MobileButton label="Weather" kind="outlined" onPress={() => props.requestCapability("hardwareWeatherCurrent", "hardware.weather.current")} />
          </View>
          <HardwareResult label="Biometrics" capability="hardware.biometrics.authenticate" state={props.state().hardwareBiometricsAuthenticate} onRefresh={() => props.requestCapability("hardwareBiometricsAuthenticate", "hardware.biometrics.authenticate", { reason: "Pocket Host Lab" })} />
          <HardwareResult label="Location" capability="hardware.location.current" state={props.state().hardwareLocationCurrent} onRefresh={() => props.requestCapability("hardwareLocationCurrent", "hardware.location.current")} />
          <HardwareResult label="Weather" capability="hardware.weather.current" state={props.state().hardwareWeatherCurrent} onRefresh={() => props.requestCapability("hardwareWeatherCurrent", "hardware.weather.current")} />
        </MobileCard>
        <MobileDialog
          open={() => deletePath() !== undefined}
          title="Delete photo?"
          body={deletePath() ?? "Choose a photo first."}
          onClose={() => setDeletePath(undefined)}
        >
          <MobileButton label="Confirm delete" kind="danger" onPress={() => {
            const path = deletePath();
            if (path) props.requestCapability("hardwarePhotosDelete", "hardware.photos.delete", { filePath: path });
            setDeletePath(undefined);
          }} />
        </MobileDialog>
      </MobileScaffold>
    </MobileThemeProvider>
  );
}
