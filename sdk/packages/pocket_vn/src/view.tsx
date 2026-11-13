import { For, Show, createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type JSX } from "solid-js";
import { Focusable, FocusScope, Image, Text, View, type NodeMirror, type ViewProps } from "@pocketjs/framework/solid/components";
import { BTN, focusNode } from "@pocketjs/framework/input";
import { onButtonPress } from "@pocketjs/framework/solid/lifecycle";
import { ScrollablePage, avoidDisplayOcclusions, sideContourReservesForBand, MINI_APP_HOST_ACTION_RESERVE, createDisplayGeometry, createSystemPresets, deliverTextInputEvent, EMPTY_DISPLAY_GEOMETRY, InputField, pageInsets, useAccessibilityPreferences, wrapTextLines } from "@pocket/ui";
import { Video } from "@pocket/ui/video";
import { PocketStoredImage, type PocketImagesClient } from "@pocket/ui/images";
import type { HostBridge } from "@pocket/ui/host";
import type { EngineSnapshot, InputState, NovelEngine, NovelReplayEntry, NovelSaveData, NovelSlotThumbnail, RevealTransitionDirection, StageComposition, JsonValue, NovelSceneObject } from "./types.ts";
import { NOVEL_UI_DEFAULT_MESSAGES, NOVEL_UI_EN_MESSAGES, novelCollectionTextKey, novelInventoryTextKey, novelSceneObjectTextKey } from "./localization.ts";
import { readNovelSlotThumbnail, type NovelSlotOperationOptions } from "./slots.ts";
import type { NovelAudioGroup, NovelAudioMix } from "./audio.ts";
import type { NovelModelDefinition, NovelModelFactory, NovelAnimationDriver } from "./models.ts";
import { NovelModelView } from "./model-view.tsx";
import { resolveNovelCameraPose } from "./camera.ts";
import { resolveNovelBackgroundLayerPose } from "./background-layers.ts";
import { resolveNovelCharacterPlacement, screenPointToNovelModelPoint } from "./scene.ts";
import { orderedNovelStageItems, resolveNovelSceneObjectGeometry, isNovelSceneObjectInteractive } from "./scene-objects.ts";
import { createNovelViewportLayout, novelCharacterBounds, novelImageContainBounds, novelImageCoverBounds, type NovelImageBounds, type NovelImageDimensions } from "./viewport.ts";
import { NovelAtmosphereView } from "./atmosphere-view.tsx";
import type { NovelAtmosphere } from "./atmosphere.ts";
import { createNovelChoiceSurfaceLayout, type NovelChoiceSurface, type NovelChoiceSurfaceLayout } from "./choice-surface.ts";
import { NovelChoiceSurfaceView } from "./choice-surface-view.tsx";
import { NovelSkinFrame, NovelSkinIcon } from "./skin-view.tsx";
import { NovelRichTextView } from "./rich-text-view.tsx";
import type { NovelAssetSkin, NovelAssetSkinFrame } from "./skin.ts";
import type { NovelVideoAdapter } from "./video.ts";
import type { NovelInventory } from "./inventory.ts";
import { isNovelCollectionEntryUnlocked, resolveNovelCollectionPortrait, type NovelCollections } from "./collections.ts";

export interface NovelAssets {
  /** Shared authored records; unlocks use the engine's existing persistent variables. */
  collections?: NovelCollections;
  /** Presentation layers keyed by the canonical background ID. */
  atmospheres?: Readonly<Record<string, NovelAtmosphere>>;
  /** Optional image-backed spatial controls keyed by the story choice ID. */
  choiceSurfaces?: Readonly<Record<string, NovelChoiceSurface>>;
  models?: Readonly<Record<string, NovelModelDefinition>>;
  backgrounds: Readonly<Record<string, string>>;
  characters: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Optional stable video cue aliases resolved to consumer-bundled asset paths. */
  videos?: Readonly<Record<string, string>>;
  cgs: Readonly<Record<string, { image: string; title: string }>>;
  /** Optional intrinsic image sizes keyed by the resolved asset path. */
  imageDimensions?: Readonly<Record<string, NovelImageDimensions>>;
  /** Optional image-based game chrome. Without it the controls remain usable and unskinned. */
  skin?: NovelAssetSkin;
}

function sameChoiceSurfaceLayout(left: NovelChoiceSurfaceLayout | null, right: NovelChoiceSurfaceLayout | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.width !== right.width || left.height !== right.height || left.targets.length !== right.targets.length) return false;
  const sameRect = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  if (Boolean(left.image) !== Boolean(right.image) || (left.image && right.image && (left.image.src !== right.image.src || !sameRect(left.image, right.image)))) return false;
  return left.targets.every((target, index) => {
    const other = right.targets[index]!;
    return target.option.id === other.option.id && target.displayCaption === other.displayCaption && sameRect(target, other);
  });
}
export interface NovelStorage {
  read(slot: string): Promise<unknown>;
  write(slot: string, data: NovelSaveData): Promise<void>;
  /** Optional raw manager surface. Existing read/write consumers remain valid. */
  list?(): Promise<readonly string[]>;
  delete?(slot: string): Promise<void>;
  copy?(source: string, destination: string, options?: NovelSlotOperationOptions): Promise<void>;
  move?(source: string, destination: string, options?: NovelSlotOperationOptions): Promise<void>;
  swap?(first: string, second: string): Promise<void>;
}
export interface NovelViewProps {
  engine: NovelEngine;
  /** Existing retained media adapter for the one stage video overlay. */
  videoAdapter?: NovelVideoAdapter;
  /** Official native text input events for the existing @pocket/ui InputField. */
  host?: Pick<HostBridge, "onEvent">;
  assets: NovelAssets;
  /** Canonical story inventory; quantities remain in engine variables. */
  inventory?: NovelInventory;
  title: string;
  /** Optional compact title for the in-game header; the title page keeps title. */
  shortTitle?: string;
  subtitle?: string;
  storage?: NovelStorage;
  /** App-private captured images referenced by the canonical slot records. */
  slotImages?: PocketImagesClient;
  /** Starts a new game while preserving the declared persistent meta progress. */
  onNewGame(): void;
  onExit?(): void;
  audioStatus?: string;
  muted?: boolean;
  onMute?(muted: boolean): void;
  /** Current validated mix from the JS audio adapter. */
  audioMix?: NovelAudioMix;
  /** Change one normalized channel gain; policy and persistence stay with the owner. */
  onAudioMixChange?(group: "master" | NovelAudioGroup, value: number): void;
  /** Optional JS-owned preference for synthesized dialogue reveal cues. */
  textSoundsEnabled?: boolean;
  onTextSoundsEnabledChange?(enabled: boolean): void;
  /** Current locale plus available choices; the owner swaps the existing engine. */
  locale?: string;
  locales?: readonly { readonly id: string; readonly label: string }[];
  onLocale?(locale: string): void;
  /** Resolved by localizeStory through the same catalog fallback chain. */
  ui?: Readonly<Record<string, string>>;
  /** Optional replay declarations to expose in the existing memories gallery. */
  replayEntries?: readonly NovelReplayEntry[];
  /** Optional backward-compatible single title shortcut to a declared, unlocked replay. */
  featuredReplayId?: string;
  /** Additional title shortcuts to declared, unlocked replays. Rendered before featuredReplayId. */
  featuredReplayIds?: readonly string[];
  replayMode?: boolean;
  onReplayStart?(entryId: string): void;
  onReplayExit?(): void;
  /** Consumer-registered music cue IDs; the view intersects them with engine metadata. */
  registeredMusicIds?: readonly string[];
  musicTitles?: Readonly<Record<string, string>>;
  onMusicPreviewPlay?(cue: string): void;
  onMusicPreviewStop?(): void;
  modelFactory?: NovelModelFactory;
  animations?: NovelAnimationDriver;
}

type Panel = "none" | "menu" | "save" | "load" | "slots" | "log" | "settings" | "gallery" | "collections" | "inventory" | "note";
type NoteSelection = { source: "active"; lineId: string; spanId: string } | { source: "backlog"; sequence: number; spanId: string };
type MessageFormatter = (key: string, values?: Readonly<Record<string, string | number>>) => string;
type SlotSummary = { readonly exists: boolean; readonly text: string; readonly thumbnail?: NovelSlotThumbnail };
type PendingSlotAction =
  | { readonly kind: "save" | "delete"; readonly slot: string }
  | { readonly kind: "copy" | "move"; readonly source: string; readonly destination: string; readonly overwrite: boolean }
  | { readonly kind: "swap"; readonly first: string; readonly second: string };

const SLOT_PAGE_SIZE = 4;
const MAX_LISTED_SLOTS = 512;
const LEGACY_NAMED_SLOTS = ["1", "2", "3"] as const;

interface NovelSkinContextValue {
  frame: () => NovelAssetSkinFrame | undefined;
  accentFrame: () => NovelAssetSkinFrame | undefined;
  icons: () => NovelAssetSkin["icons"];
  actionWidth: () => number;
}

const NovelSkinContext = createContext<NovelSkinContextValue>();

type FocusTargetProps = Partial<Pick<ViewProps, "class" | "style" | "debugName">> & Pick<ViewProps, "children"> & {
  autoFocus?: boolean;
  onNode?: (node: NodeMirror | undefined, previous?: NodeMirror) => void;
  onPress?: () => void;
  skinWidth?: number;
  skinHeight?: number;
  skinBorder?: number;
  skinOpacity?: number;
  skinAccent?: boolean;
};

/** Use the shared focus manager after the rendered Focusable has registered. */
function FocusTarget(props: FocusTargetProps): JSX.Element {
  const skin = useContext(NovelSkinContext);
  const skinFrame = () => skin?.frame();
  const renderedFrame = () => props.skinAccent ? skin?.accentFrame() ?? skinFrame() : skinFrame();
  let node: NodeMirror | undefined;
  // Capture callback props while a Show/For child is live. Reading a dynamic
  // props getter during cleanup can touch its already-invalid Show accessor.
  const onNode = props.onNode;
  const autoFocus = props.autoFocus === true;
  onCleanup(() => { if (node) onNode?.(undefined, node); });
  return <Focusable class={props.class} style={{ ...props.style, ...(props.skinWidth === undefined ? {} : { width: props.skinWidth }), ...(props.skinHeight === undefined ? {} : { height: props.skinHeight }) }} debugName={props.debugName} onPress={props.onPress} ref={value => { node = value; onNode?.(value); if (autoFocus) focusNode(value); }}>
    {renderedFrame() && props.skinWidth !== undefined && props.skinHeight !== undefined && <NovelSkinFrame frame={renderedFrame()!} width={props.skinWidth} height={props.skinHeight} border={props.skinBorder ?? 16} style={{ opacity: props.skinOpacity ?? 1 }} debugName={props.debugName ? `${props.debugName}-skin` : undefined} />}
    {props.children}
  </Focusable>;
}

function Action(props: { label: string; detail?: string; icon?: string; onPress(): void; disabled?: boolean; autoFocus?: boolean; debugName?: string; onNode?: FocusTargetProps["onNode"]; skinWidth?: number; primary?: boolean; quiet?: boolean; thumbnail?: NovelSlotThumbnail; images?: PocketImagesClient }): JSX.Element {
  const skin = useContext(NovelSkinContext);
  const skinWidth = () => props.skinWidth ?? skin?.actionWidth() ?? 280;
  const hasPreview = () => Boolean(props.images && props.thumbnail);
  const previewWidth = () => Math.min(104, Math.max(48, (skinWidth() - 32) * 0.3));
  const contentWidth = () => Math.max(1, skinWidth() - 32 - (hasPreview() ? previewWidth() + 12 : 0));
  const labelWidth = () => Math.max(1, contentWidth() - (props.icon ? 32 : 0));
  const labelFontSlot = () => props.primary ? 9 : 1;
  const labelText = () => wrapTextLines(props.label, Math.max(1, Math.floor(labelWidth() / 7)), labelWidth(), labelFontSlot());
  const detailText = () => props.detail ? wrapTextLines(props.detail, Math.max(1, Math.floor(contentWidth() / 7)), contentWidth(), 0) : "";
  const labelLines = () => labelText().split("\n").length;
  const detailLines = () => detailText().split("\n").length;
  const height = () => Math.max(
    props.primary ? 60 : props.quiet ? 44 : 48,
    hasPreview() ? 76 : 0,
    labelLines() * (props.primary ? 24 : 20) + (props.detail ? detailLines() * 16 + 4 : 0) + 12,
  );
  return <FocusTarget autoFocus={props.autoFocus} onNode={props.onNode} debugName={props.debugName} skinWidth={skinWidth()} skinHeight={height()} skinAccent={props.primary} skinOpacity={props.quiet ? 0.32 : 1} class="relative flex-col justify-center gap-1 px-4 transition-transform duration-150 ease-out active:scale-98" onPress={() => { if (!props.disabled) props.onPress(); }} style={{ opacity: props.disabled ? 0.4 : 1 }}>
    <View class="flex-row items-center gap-3" style={{ width: Math.max(1, skinWidth() - 32) }}>
    <Show when={hasPreview()}>
      <PocketStoredImage client={props.images!} imageId={props.thumbnail!.id} width={previewWidth()} height={60} debugName={props.debugName ? `${props.debugName}-thumbnail` : "vn-slot-thumbnail"} />
    </Show>
    <View class="flex-col gap-1" style={{ width: contentWidth() }}>
    <View class="flex-row items-start gap-3" style={{ width: contentWidth() }}>
      <Show when={props.icon ? skin?.icons() : undefined}>{atlas => <NovelSkinIcon atlas={atlas()} name={props.icon!} width={20} height={20} debugName={props.debugName ? `${props.debugName}-icon` : undefined} />}</Show>
      <Show when={props.primary} fallback={<Text class="text-sm text-[#F5ECD9]" style={{ width: labelWidth() }}>{labelText()}</Text>}>
        <Text class="text-base text-[#FFE1A3] font-bold" style={{ width: labelWidth() }}>{labelText()}</Text>
      </Show>
    </View>
    <Show when={props.detail}><Text class="text-xs text-[#9EB2B5]" style={{ width: contentWidth() }}>{detailText()}</Text></Show>
    </View>
    </View>
  </FocusTarget>;
}

function IconLabel(props: { label: string; icon?: string; width?: number; height?: number; labelWidth?: number; tone?: "default" | "accent" | "heading" }): JSX.Element {
  const skin = useContext(NovelSkinContext);
  const bodyText = () => props.labelWidth === undefined
    ? props.label
    : wrapTextLines(props.label, Math.max(1, Math.floor(props.labelWidth / 6)), props.labelWidth, 0);
  const headingText = () => props.labelWidth === undefined
    ? props.label
    : wrapTextLines(props.label, Math.max(1, Math.floor(props.labelWidth / 12)), props.labelWidth, 11);
  return <View class={props.tone === "heading" ? "flex-row items-start gap-2" : "flex-row items-center gap-2"}>
    <Show when={props.icon ? skin?.icons() : undefined}>{atlas => <NovelSkinIcon atlas={atlas()} name={props.icon!} width={props.width ?? 18} height={props.height ?? 18} />}</Show>
    <Show when={props.tone === "heading"} fallback={<Show when={props.tone === "accent"} fallback={<Text class="text-xs text-[#F5ECD9]">{bodyText()}</Text>}><Text class="text-base text-[#FFE1A3] font-bold">{props.label}</Text></Show>}>
      <Text class="text-xl text-[#F3E4C3] font-bold" style={props.labelWidth === undefined ? {} : { width: props.labelWidth }}>{headingText()}</Text>
    </Show>
  </View>;
}

function CompactAction(props: { label: string; onPress(): void; disabled?: boolean; debugName?: string; skinWidth?: number }): JSX.Element {
  return <FocusTarget debugName={props.debugName} skinWidth={props.skinWidth} skinHeight={44} class="relative shrink-0 min-h-[44] px-2 items-center justify-center transition-transform duration-150 ease-out active:scale-98" onPress={() => { if (!props.disabled) props.onPress(); }} style={{ opacity: props.disabled ? 0.4 : 1 }}>
    <Text class="text-xs text-[#F5ECD9]">{props.label}</Text>
  </FocusTarget>;
}

function MixAction(props: { label: string; value: number; group: "master" | NovelAudioGroup; onChange(group: "master" | NovelAudioGroup, value: number): void }): JSX.Element {
  const skin = useContext(NovelSkinContext);
  const nextLevel = (): number => {
    const next = [0.25, 0.5, 0.75, 1].find(level => level > props.value + 0.001);
    return next ?? 0;
  };
  return <FocusTarget debugName={`vn-audio-${props.group}`} skinWidth={skin?.actionWidth()} skinHeight={40} skinOpacity={0.32} class="relative flex-row items-center justify-between h-[40] px-4" onPress={() => props.onChange(props.group, nextLevel())}>
    <Text class="text-sm text-[#F5ECD9]">{props.label}</Text>
  </FocusTarget>;
}

function TextSoundsAction(props: { enabled: boolean; label: string; onChange(enabled: boolean): void }): JSX.Element {
  const skin = useContext(NovelSkinContext);
  return <FocusTarget debugName="vn-text-sounds" skinWidth={skin?.actionWidth()} skinHeight={36} skinOpacity={0.32} class="relative flex-row items-center h-[36] px-4" onPress={() => props.onChange(!props.enabled)}>
    <Text class="text-sm text-[#F5ECD9]">{props.label}</Text>
  </FocusTarget>;
}

function VideoControlAction(props: { label: string; debugName: string; width: number; icon?: string; disabled?: boolean; onPress(): void }): JSX.Element {
  return <Show when={props.disabled} fallback={<FocusTarget debugName={props.debugName} skinWidth={props.width} skinHeight={44} class="relative shrink-0 h-[44] items-center justify-center px-1" style={{ width: props.width }} onPress={props.onPress}>
    <IconLabel label={props.label} icon={props.icon} width={16} height={16} />
  </FocusTarget>}>
    <View class="relative shrink-0 h-[44] items-center justify-center px-1" style={{ width: props.width, opacity: 0.4 }}>
      <SkinBackground width={props.width} height={44} border={10} debugName={`${props.debugName}-disabled-skin`} />
      <IconLabel label={props.label} icon={props.icon} width={16} height={16} />
    </View>
  </Show>;
}

function SkinBackground(props: { width: number; height: number; border?: number; opacity?: number; debugName?: string }): JSX.Element {
  const skin = useContext(NovelSkinContext);
  return <Show when={skin?.frame()}>{frame => <NovelSkinFrame frame={frame()} width={props.width} height={props.height} border={props.border ?? 22} style={{ opacity: props.opacity ?? 1 }} debugName={props.debugName} />}</Show>;
}

function imageBoundsStyle(bounds: NovelImageBounds) {
  return { insetL: bounds.insetL, insetT: bounds.insetT, width: bounds.width, height: bounds.height };
}

function revealClipBounds(direction: RevealTransitionDirection, progress: number, width: number, height: number) {
  const fraction = Math.min(1, Math.max(0, progress));
  const clipWidth = direction === "left" || direction === "right" ? width * fraction : width;
  const clipHeight = direction === "up" || direction === "down" ? height * fraction : height;
  const insetL = direction === "right" ? width - clipWidth : 0;
  const insetT = direction === "down" ? height - clipHeight : 0;
  return { insetL, insetT, width: clipWidth, height: clipHeight, contentInsetL: -insetL, contentInsetT: -insetT };
}

type CameraPose = ReturnType<typeof resolveNovelCameraPose>;
type NovelLayout = ReturnType<typeof createNovelViewportLayout>;
type ViewportSize = { width: number; height: number };

function localCameraStyle(pose: CameraPose) {
  return { translateX: pose.x, translateY: pose.y, scale: pose.scale, originX: 0, originY: 0 };
}

function fullViewportCameraStyle(pose: CameraPose, safe: NovelLayout, viewport: ViewportSize) {
  return {
    ...localCameraStyle(pose),
    originX: (safe.insetL + safe.width / 2) / viewport.width - 0.5,
    originY: (safe.insetT + safe.height / 2) / viewport.height - 0.5,
  };
}

function safeStageClipBounds(layout: NovelLayout) {
  return { insetL: layout.insetL, insetT: layout.insetT, width: layout.width, height: layout.height };
}

function StageBackground(props: { stage: StageComposition; assets: NovelAssets; layout: ViewportSize; safeLayout: NovelLayout; reduceMotion: boolean }): JSX.Element {
  const cameraPose = () => resolveNovelCameraPose(props.stage.camera, { reduceMotion: props.reduceMotion });
  const layerTransform = (parallax: number) => {
    if (parallax === 1) return {};
    const camera = cameraPose();
    const layer = resolveNovelBackgroundLayerPose(props.stage.camera, parallax, { reduceMotion: props.reduceMotion });
    // StageBackground remains beneath the existing stage camera transform.
    // This local inverse/target delta composes to the requested layer pose.
    return {
      translateX: (layer.x - camera.x) / camera.scale,
      translateY: (layer.y - camera.y) / camera.scale,
      scale: layer.scale / camera.scale,
      originX: (props.safeLayout.insetL + props.safeLayout.width / 2) / props.layout.width - 0.5,
      originY: (props.safeLayout.insetT + props.safeLayout.height / 2) / props.layout.height - 0.5,
    };
  };
  const coverStyle = (source: string) => imageBoundsStyle(novelImageCoverBounds(
    props.layout.width,
    props.layout.height,
    props.assets.imageDimensions?.[source],
  ));
  const baseSource = () => props.stage.background ? props.assets.backgrounds[props.stage.background] : undefined;
  return <>
    <Show when={baseSource()}>{source => <Image src={source()} class="absolute" style={coverStyle(source())} />}</Show>
    <For each={props.stage.backgroundLayers ?? []}>{layer => {
      const source = () => props.assets.backgrounds[layer.background];
      return <Show when={source()}>{asset => <View class="absolute inset-0 w-full h-full" style={layerTransform(layer.parallax)}>
        <Image src={asset()} class="absolute" style={coverStyle(asset())} />
      </View>}</Show>;
    }}</For>
  </>;
}

type StageItemsProps = { stage: StageComposition; assets: NovelAssets; layout: ReturnType<typeof createNovelViewportLayout>; modelFactory?: NovelModelFactory; animations?: NovelAnimationDriver; message: MessageFormatter; variables?: Readonly<Record<string, JsonValue>>; interactive?: boolean; modelInteractive?: boolean; reduceMotion?: boolean; onObjectPress?: (id: string) => void };

function StageCharacter(props: StageItemsProps & { id: string }): JSX.Element {
  const character = () => props.stage.characters[props.id]!;
  const source = () => props.assets.characters[props.id]?.[character().expression] ?? props.assets.characters[props.id]?.neutral;
  const model = () => character().model;
  const definition = () => model() && props.assets.models?.[model()!.key];
  const placement = () => resolveNovelCharacterPlacement(character());
  const bounds = () => novelCharacterBounds(character().position, placement(), props.layout.width, props.layout.artScale);
  const cameraPose = () => resolveNovelCameraPose(props.stage.camera, { reduceMotion: props.reduceMotion === true });
  const screenToModelPoint = (point: { readonly x: number; readonly y: number }) =>
    screenPointToNovelModelPoint(point, props.layout, cameraPose(), { ...bounds(), ...placement() }, props.layout.artScale);
  const modelInteractive = () => props.modelInteractive === true && definition()?.interactive === true;
  const imageBounds = () => {
    const frame = bounds();
    const item = character();
    const placementIsAuthored = typeof item.position === "object" || item.scale !== undefined || item.rotation !== undefined || item.layer !== undefined;
    if (placementIsAuthored) return { insetL: 0, insetT: 0, width: frame.width, height: frame.height };
    return novelImageContainBounds(frame.width, frame.height, props.assets.imageDimensions?.[source() ?? ""]);
  };
  return <View class="absolute" style={{ insetL: bounds().insetL, insetT: bounds().insetT, width: bounds().width, height: bounds().height, scale: placement().scale, rotate: placement().rotation, originX: -0.5, originY: -0.5 }}>
    <Show when={model()} fallback={<Show when={source()}>{asset => <Image src={asset()} class="absolute" style={imageBoundsStyle(imageBounds())} />}</Show>}>
    <Show when={definition()} fallback={<Text class="text-xs text-[#F0B78F]">{props.message("stage.missingModel", { key: model()?.key ?? "" })}</Text>}>{asset =>
        <View class="absolute" style={{ insetL: 0, insetT: 0, width: 240, height: 350, scale: props.layout.artScale, originX: -0.5, originY: -0.5 }}>
          <NovelModelView definition={asset()} intent={model()!} factory={props.modelFactory} animations={props.animations}
            interactive={modelInteractive()} screenToModelPoint={screenToModelPoint} />
        </View>
      }</Show>
    </Show>
  </View>;
}

function StageObject(props: StageItemsProps & { object: NovelSceneObject }): JSX.Element {
  const rawGeometry = () => resolveNovelSceneObjectGeometry(props.object, props.layout.width, props.layout.height);
  const source = () => props.assets.backgrounds[props.object.image];
  const interactive = () => props.interactive === true && isNovelSceneObjectInteractive(props.object, props.variables ?? {});
  const label = () => {
    const key = novelSceneObjectTextKey(props.object.id);
    const localized = props.message(key);
    return localized === key ? props.object.interaction?.label ?? props.object.id : localized;
  };
  return <Show when={rawGeometry()}>{resolved => {
    const geometry = () => resolved();
  const caption = () => <View class="absolute bg-[#08151DCC] px-2 py-1" style={{ insetL: 0, insetR: 0, insetB: 0 }}><Text class="text-xs text-[#FFE1A3]">{wrapTextLines(label(), Math.max(1, Math.floor((geometry().hit.width - 16) / 7)), Math.max(1, geometry().hit.width - 16), 0)}</Text></View>;
    return <View class="absolute overflow-hidden" style={{ insetL: geometry().frame.x, insetT: geometry().frame.y, width: geometry().frame.width, height: geometry().frame.height }} debugName={`vn-object-${props.object.id}`}>
    <Show when={source()}>{asset => <Image src={asset()} class="absolute" style={{ insetL: geometry().image.x, insetT: geometry().image.y, width: geometry().image.width, height: geometry().image.height }} />}</Show>
    <Show when={props.object.interaction}>
      <Show when={interactive()} fallback={<View class="absolute" style={{ insetL: geometry().hit.x, insetT: geometry().hit.y, width: geometry().hit.width, height: geometry().hit.height, opacity: 0.45 }}>{caption()}</View>}>
        <FocusTarget class="absolute" debugName={`vn-object-hit-${props.object.id}`} style={{ insetL: geometry().hit.x, insetT: geometry().hit.y, width: geometry().hit.width, height: geometry().hit.height }} onPress={() => { if (interactive()) props.onObjectPress?.(props.object.id); }}>{caption()}</FocusTarget>
      </Show>
    </Show>
    </View>;
  }}</Show>;
}

function StageItems(props: StageItemsProps): JSX.Element {
  // Primitive keys preserve existing model nodes when a camera/timeline tick replaces stage state.
  const keys = () => orderedNovelStageItems(props.stage).map(item => `${item.kind}:${item.id}`);
  return <For each={keys()}>{key => key.startsWith("character:")
    ? <StageCharacter {...props} id={key.slice(10)} />
    : <Show when={props.stage.objects?.find(object => object.id === key.slice(7))}>{object => <StageObject {...props} object={object()} />}</Show>
  }</For>;
}

function StageArt(props: { stage: StageComposition; assets: NovelAssets; layout: ReturnType<typeof createNovelViewportLayout>; visualViewport: { width: number; height: number }; reduceMotion: boolean; opacity?: number; modelFactory?: NovelModelFactory; animations?: NovelAnimationDriver; message: MessageFormatter }): JSX.Element {
  const cameraPose = () => resolveNovelCameraPose(props.stage.camera, { reduceMotion: props.reduceMotion });
  return <View class="absolute inset-0 w-full h-full bg-[#08151D]" style={{ opacity: props.opacity ?? 1, hitPass: 1 }}>
    <View class="absolute inset-0 w-full h-full" style={{ ...fullViewportCameraStyle(cameraPose(), props.layout, props.visualViewport), hitPass: 1 }}>
      <StageBackground stage={props.stage} assets={props.assets} layout={props.visualViewport} safeLayout={props.layout} reduceMotion={props.reduceMotion} />
    </View>
    <View class="absolute overflow-hidden" style={{ ...safeStageClipBounds(props.layout), hitPass: 1 }}>
      <View class="absolute inset-0 w-full h-full" style={{ ...localCameraStyle(cameraPose()), hitPass: 1 }}>
        <StageItems stage={props.stage} assets={props.assets} layout={props.layout} modelFactory={props.modelFactory} animations={props.animations} message={props.message} reduceMotion={props.reduceMotion} />
      </View>
    </View>
  </View>;
}

/** JS-owned stage and player UI. All narrative decisions remain in NovelEngine. */
export function NovelView(props: NovelViewProps): JSX.Element {
  const accessibility = useAccessibilityPreferences();
  const reduceMotion = () => accessibility().reduceMotion;
  const display = createDisplayGeometry({ fallback: { ...EMPTY_DISPLAY_GEOMETRY, width: 360, height: 640 } });
  const presets = createSystemPresets();
  const visualViewport = createMemo(() => ({ width: display().width, height: display().height }));
  const layout = createMemo(() => {
    const geometry = display();
    const insets = pageInsets(geometry);
    return createNovelViewportLayout({ width: geometry.width, height: geometry.height, keyboardInset: geometry.keyboardInset }, insets);
  });
  const stageBounds = () => {
    const current = layout();
    return { width: current.width, height: current.height, insetL: current.insetL, insetT: current.insetT };
  };
  const headerBounds = createMemo(() => {
    const geometry = display();
    const current = layout();
    const isPage = presets().presentationStyle === "page";
    const globalRight = geometry.width - current.insetL - current.width;
    const top = current.insetT + 8;
    // Page insets deliberately release local corner occlusions. Reuse the
    // framework contour contract for this control band, including space for
    // the host back/close target when that target moves inward around a cutout.
    const contour = sideContourReservesForBand(geometry, top, top + 44, { rampPx: 0, bottomTrim: 0 });
    const leftActionReserve = isPage ? MINI_APP_HOST_ACTION_RESERVE : 20;
    const rightActionReserve = isPage ? 20 : MINI_APP_HOST_ACTION_RESERVE;
    const left = current.insetL + leftActionReserve + Math.max(0, contour.left - current.insetL);
    const right = geometry.width - globalRight - rightActionReserve - Math.max(0, contour.right - globalRight);
    const target = { left, top, width: Math.max(1, right - left), height: 44 };
    const safe = avoidDisplayOcclusions(geometry, target, { prefer: "vertical" }).rect;
    return { insetL: safe.left - current.insetL, insetT: safe.top - current.insetT, width: safe.width, height: safe.height };
  });
  const [snapshot, setSnapshot] = createSignal<EngineSnapshot>(props.engine.getSnapshot());
  const presentationStage = createMemo(() => {
    const canonicalStage = snapshot().stage;
    return reduceMotion()
      ? props.engine.getStagePresentation({ reduceMotion: true })
      : canonicalStage;
  });
  const [titleScreen, setTitleScreen] = createSignal(true);
  const [panel, setPanel] = createSignal<Panel>("none");
  const [noteSelection, setNoteSelection] = createSignal<NoteSelection | null>(null);
  let noteReturnPanel: "none" | "log" = "none";
  const [notice, setNotice] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [logPage, setLogPage] = createSignal(0);
  const [galleryPage, setGalleryPage] = createSignal(0);
  const [inventoryPage, setInventoryPage] = createSignal(0);
  const [inventorySelection, setInventorySelection] = createSignal<string | null>(null);
  const [collectionPage, setCollectionPage] = createSignal(0);
  const [collectionSelection, setCollectionSelection] = createSignal<{ collection: string; entry: string } | null>(null);
  const [musicPreviewCue, setMusicPreviewCue] = createSignal<string | null>(null);
  const [storedSlots, setStoredSlots] = createSignal<readonly string[]>([]);
  const [slotSummaries, setSlotSummaries] = createSignal<Record<string, SlotSummary>>({});
  const [capturingSlotImage, setCapturingSlotImage] = createSignal(false);
  const [slotListOverflow, setSlotListOverflow] = createSignal(0);
  const [slotDataStatus, setSlotDataStatus] = createSignal<"idle" | "loading" | "ready" | "error">("idle");
  const [slotPage, setSlotPage] = createSignal(0);
  const [selectedSlot, setSelectedSlot] = createSignal<string | null>(null);
  const [slotIdDraft, setSlotIdDraft] = createSignal("");
  const [pendingSlotAction, setPendingSlotAction] = createSignal<PendingSlotAction | null>(null);
  let slotReturnPanel: Panel = "save";
  let slotRefreshRevision = 0;
  const slotDataReady = (): boolean => slotDataStatus() === "ready";
  const [inputFieldRevision, setInputFieldRevision] = createSignal(0);
  let replayReturn: { titleScreen: boolean; panel: Panel; resumeAfterPanel: boolean } | null = null;
  const fail = (error: unknown): void => { setNotice(error instanceof Error ? error.message : String(error)); };
  const message = (key: string, values: Readonly<Record<string, string | number>> = {}): string => {
    const englishInputCopy = props.locale?.toLowerCase().split(/[-_]/, 1)[0] === "en" ? NOVEL_UI_EN_MESSAGES[key] : undefined;
    const template = props.ui?.[key] ?? englishInputCopy ?? NOVEL_UI_DEFAULT_MESSAGES[key] ?? key;
    return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (_match, name: string) => String(values[name] ?? ""));
  };
  const featuredReplays = createMemo(() => {
    const requested = [...(props.featuredReplayIds ?? []), ...(props.featuredReplayId ? [props.featuredReplayId] : [])];
    const seen = new Set<string>();
    const endingIds = snapshot().meta.endingIds;
    const entries = props.replayEntries ?? [];
    const result: NovelReplayEntry[] = [];
    for (const id of requested) {
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = entries.find(candidate => candidate.id === id);
      if (!entry || (entry.unlockEndingId && !endingIds.includes(entry.unlockEndingId))) continue;
      result.push(entry);
    }
    return result;
  });
  const localeChoices = () => props.locales ?? [];
  const localeLabel = () => localeChoices().find(item => item.id === props.locale)?.label ?? props.locale ?? "";
  const nextLocale = (): string => {
    const locales = localeChoices();
    const index = locales.findIndex(item => item.id === props.locale);
    return locales[(index + 1 + locales.length) % locales.length]?.id ?? props.locale ?? "";
  };
  let interactionFocusNode: NodeMirror | undefined;
  const rememberInteractionFocus = (node: NodeMirror | undefined, previous?: NodeMirror): void => {
    if (node) interactionFocusNode = node;
    else if (interactionFocusNode === previous) interactionFocusNode = undefined;
  };
  const restoreInteractionFocus = (): void => {
    if (interactionFocusNode?.parent) focusNode(interactionFocusNode);
  };
  // Title and journal pages own modal focus scopes. Restore the game cursor
  // once the outermost overlay closes, after the target has registered and
  // the modal scope has been removed.
  let previousOverlayOpen = titleScreen() || panel() !== "none";
  createEffect(() => {
    const overlayOpen = titleScreen() || panel() !== "none";
    if (previousOverlayOpen && !overlayOpen) restoreInteractionFocus();
    previousOverlayOpen = overlayOpen;
  });
  let resumeAfterPanel = false;
  createEffect(() => {
    const engine = props.engine;
    setSnapshot(engine.getSnapshot());
    const unsubscribe = engine.subscribe(update => setSnapshot(update.snapshot));
    const unbindVideo = props.videoAdapter?.bind(engine, fail);
    onCleanup(() => { unsubscribe(); unbindVideo?.(); });
  });
  createEffect(() => {
    if (props.replayMode === true) {
      if (replayReturn === null) {
        replayReturn = { titleScreen: titleScreen(), panel: panel(), resumeAfterPanel };
        setTitleScreen(false);
        setPanel("none");
        setMusicPreviewCue(null);
      }
      return;
    }
    if (replayReturn !== null) {
      const previous = replayReturn;
      replayReturn = null;
      setTitleScreen(previous.titleScreen);
      setPanel(previous.panel);
      resumeAfterPanel = previous.resumeAfterPanel;
    }
  });
  createEffect(() => {
    const host = props.host;
    if (typeof host?.onEvent !== "function") return;
    const unsubscribe = host.onEvent(event => {
      if (event.method.startsWith("textInput.")) deliverTextInputEvent(event.method, event.params);
    });
    onCleanup(unsubscribe);
  });
  const active = () => snapshot().active;
  const heardMusicIds = () => (props.registeredMusicIds ?? []).filter(cue => snapshot().meta.musicIds?.includes(cue) ?? false);
  const say = () => { const value = active(); return value?.kind === "say" ? value : undefined; };
  // Size once from the full line, so revealing glyphs never moves the plate.
  const dialogueText = createMemo(() => say()?.text ?? "");
  const [richDialogueMeasure, setRichDialogueMeasure] = createSignal<{ lineId: string; height: number } | null>(null);
  const dialogueHeight = createMemo(() => {
    const current = layout();
    const line = say();
    if (line?.rich) {
      const measure = richDialogueMeasure();
      const height = measure?.lineId === line.id ? measure.height : 0;
      return Math.min(Math.max(current.dialogueHeight, height + 72), Math.max(1, current.height - current.dialogueBottom - 76));
    }
    const lines = wrapTextLines(dialogueText(), Math.max(1, Math.floor(current.dialogueTextWidth / 9)), current.dialogueTextWidth, 2).split("\n").length;
    return Math.min(Math.max(current.dialogueHeight, lines * 22 + 64), Math.max(1, current.height - current.dialogueBottom - 76));
  });
  const sayPresentation = () => say()?.presentation ?? "dialogue";
  const sayFrame = createMemo(() => {
    const current = layout();
    const presentation = sayPresentation();
    if (presentation === "fullscreen") {
      const top = Math.min(72, Math.max(52, current.height * 0.1));
      return {
        left: 12,
        top,
        width: Math.max(1, current.width - 24),
        // Keep the continue/reveal target above the player toolbar. The say
        // FocusTarget owns its entire plate, so extending it behind the
        // bottom toolbar would make the hint look tappable while the toolbar
        // actually receives the pointer.
        height: Math.max(1, current.height - top - current.toolbarHeight - 12),
        headerTop: 8,
        bodyTop: 48,
      };
    }
    if (presentation === "floating") {
      const width = Math.min(480, Math.max(1, current.width - 32), Math.max(240, current.width * 0.76));
      const top = Math.min(112, Math.max(64, current.height * 0.14));
      const desiredHeight = Math.max(184, Math.min(360, current.height * 0.58));
      return {
        left: 16,
        top,
        width,
        height: Math.max(
          1,
          Math.min(
            desiredHeight,
            current.height - top - current.toolbarHeight - 12,
          ),
        ),
        headerTop: 8,
        bodyTop: 48,
      };
    }
    const height = dialogueHeight();
    return {
      left: current.dialogueLeft,
      top: Math.max(0, current.height - current.dialogueBottom - height),
      width: current.dialogueWidth,
      height,
      headerTop: -16,
      bodyTop: 16,
    };
  });
  const sayTextWidth = (): number => {
    const frame = sayFrame();
    if (sayPresentation() === "dialogue") return layout().dialogueTextWidth;
    const readableWidth = sayPresentation() === "fullscreen" ? Math.min(840, frame.width - 48) : frame.width - 48;
    return Math.max(1, readableWidth);
  };
  const saySpeakerWidth = (): number => Math.min(164, Math.max(100, sayFrame().width * 0.42));
  const sayVoiceWidth = (): number => Math.min(122, Math.max(88, sayFrame().width * 0.34));
  const choice = () => { const value = active(); return value?.kind === "choice" ? value : undefined; };
  const playerInput = () => { const value = active(); return value?.kind === "input" ? value : undefined; };
  const ending = () => { const value = active(); return value?.kind === "ending" ? value : undefined; };
  const updatePlayerInput = (id: string, value: string | boolean): void => {
    const current = playerInput();
    if (snapshot().paused || titleScreen() || panel() !== "none" || current?.id !== id) return;
    try { props.engine.updateInput(value); } catch (error) {
      // The engine owns the only draft. If it rejects an over-cap native edit,
      // remount the controlled field to restore that canonical value.
      if (error instanceof RangeError) setInputFieldRevision(revision => revision + 1);
      fail(error);
    }
  };
  const submitPlayerInput = (id: string): void => {
    const current = playerInput();
    if (snapshot().paused || titleScreen() || panel() !== "none" || current?.id !== id) return;
    try { props.engine.submitInput(); } catch (error) { fail(error); }
  };
  const cancelPlayerInput = (id: string): void => {
    const current = playerInput();
    if (snapshot().paused || titleScreen() || panel() !== "none" || current?.id !== id || !current.canCancel) return;
    try { props.engine.cancelInput(); } catch (error) { fail(error); }
  };
  const inputErrorMessage = (error: InputState["error"]): string => {
    if (!error) return "";
    return message(`input.error.${error.code}`, error.limit === undefined ? {} : { limit: error.limit });
  };
  const background = () => props.assets.backgrounds[snapshot().stage.background ?? "station"] ?? Object.values(props.assets.backgrounds)[0];
  const stageVideo = () => snapshot().stage.video;
  // A short window still needs complete toolbar words inside their image skins.
  const toolbarHasIcons = () => layout().toolbarButtonWidth >= 88;
  const toolbarLabelWidth = () => Math.max(1, layout().toolbarButtonWidth - 8 - (toolbarHasIcons() ? 24 : 0));
  const panelContentWidth = () => Math.max(1, layout().panelWidth - 32);
  const panelContentHeight = () => Math.max(1, layout().panelHeight - 32);
  const panelContentLeft = () => 16;
  const panelContentTop = () => 16;
  const videoSeekingAvailable = () => {
    const video = stageVideo();
    return video !== null && video.positionMs !== null && video.durationMs !== null;
  };
  const videoControlVisible = () => Boolean(stageVideo() && !titleScreen() && panel() === "none" && !snapshot().paused && snapshot().phase !== "disposed" && !playerInput() && !ending());
  const videoControlWidth = () => Math.max(1, (layout().toolbarWidth - 32) / 5);
  const seekVideoBy = async (deltaMs: number): Promise<void> => {
    const engine = props.engine;
    try {
      await props.videoAdapter?.seekBy(engine, deltaMs, () => props.engine === engine);
    } catch (error) { fail(error); }
  };
  const seekVideoToStart = async (replay = false): Promise<void> => {
    const engine = props.engine;
    const initial = engine.getSnapshot().stage.video;
    if (!initial || !props.videoAdapter) return;
    try {
      await props.videoAdapter.seekTo(engine, 0, () => props.engine === engine);
      if (replay && initial.status === "ended" && props.engine === engine) {
        engine.controlVideo({ type: "video", action: "play", cue: initial.cue, loop: initial.loop });
      }
    } catch (error) { fail(error); }
  };
  const toggleStageVideo = (): void => {
    const video = stageVideo();
    if (!video) return;
    try {
      if (video.status === "playing") props.engine.controlVideo({ type: "video", action: "pause" });
      else if (video.status === "ended") void seekVideoToStart(true);
      else props.engine.controlVideo({ type: "video", action: "play", cue: video.cue, loop: video.loop });
    } catch (error) { fail(error); }
  };
  const closeStageVideo = (): void => {
    try { props.engine.controlVideo({ type: "video", action: "close" }); }
    catch (error) { fail(error); }
  };
  const closePanel = (): void => {
    if (panel() === "note") {
      setNoteSelection(null);
      if (noteReturnPanel === "log") { setPanel("log"); return; }
    }
    if (panel() === "inventory" && inventorySelection()) { setInventorySelection(null); return; }
    if (panel() === "collections" && collectionSelection()) {
      setCollectionSelection(null);
      return;
    }
    if (panel() === "gallery" && musicPreviewCue() !== null) {
      props.onMusicPreviewStop?.();
      setMusicPreviewCue(null);
    }
    setPanel("none");
    if (resumeAfterPanel && !titleScreen()) props.engine.resume();
    resumeAfterPanel = false;
    setNotice("");
  };
  const stopMusicPreview = (): void => {
    if (musicPreviewCue() === null) return;
    props.onMusicPreviewStop?.();
    setMusicPreviewCue(null);
  };
  const openPanel = (next: Panel): void => {
    if (panel() === "none") resumeAfterPanel = !snapshot().paused;
    props.engine.pause();
    setLogPage(0);
    setGalleryPage(0);
    if (next === "inventory") { setInventorySelection(null); setInventoryPage(0); }
    if (next === "collections") { setCollectionSelection(null); setCollectionPage(0); }
    if (next === "save" || next === "load" || next === "slots") setSlotPage(0);
    setNotice("");
    setPanel(next);
    if (next !== "gallery") stopMusicPreview();
    if (next === "save" || next === "load" || next === "slots") void refreshSlots(next, 0);
  };
  const currentNote = createMemo(() => {
    const selection = noteSelection();
    if (!selection) return undefined;
    const line = selection.source === "active"
      ? (say()?.id === selection.lineId ? say() : undefined)
      : snapshot().backlog.find(entry => entry.sequence === selection.sequence);
    return line?.rich?.spans.find(span => span.id === selection.spanId)?.link;
  });
  const activateNote = (spanId: string): void => {
    const update = props.engine.activateSayLink(spanId);
    const event = update.events.find(event => event.type === "sayLink");
    if (!event || event.type !== "sayLink") return;
    noteReturnPanel = "none";
    setNoteSelection({ source: "active", lineId: event.lineId, spanId: event.spanId });
    openPanel("note");
  };
  const openHistoricalNote = (sequence: number, spanId: string): void => {
    if (panel() !== "log") return;
    const entry = snapshot().backlog.find(entry => entry.sequence === sequence);
    if (!entry?.rich?.spans.some(span => span.id === spanId && span.link)) return;
    noteReturnPanel = "log";
    setNoteSelection({ source: "backlog", sequence, spanId });
    // Preserve the existing journal page and its outer pause/resume policy.
    setPanel("note");
  };
  const openSlotManagement = (returnPanel: "save" | "load"): void => {
    slotReturnPanel = returnPanel;
    setSelectedSlot(null);
    setSlotIdDraft("");
    setPendingSlotAction(null);
    openPanel("slots");
  };
  const back = (): void => {
    if (panel() === "note") { closePanel(); return; }
    if (panel() === "inventory" && inventorySelection()) { setInventorySelection(null); return; }
    if (panel() === "collections" && collectionSelection()) {
      setCollectionSelection(null);
      return;
    }
    if (panel() === "none") {
      if (!titleScreen()) openPanel("menu");
      return;
    }
    if (titleScreen() || panel() === "menu") {
      closePanel();
      return;
    }
    if (panel() === "slots") {
      setPanel(slotReturnPanel);
      setSlotPage(0);
      setNotice("");
      void refreshSlots(slotReturnPanel, 0);
      return;
    }
    if (panel() === "gallery") stopMusicPreview();
    // Subpages return to the journey menu. The engine stays paused until the
    // player explicitly chooses Continue or closes the menu.
    setPanel("menu");
    setNotice("");
    setLogPage(0);
    setGalleryPage(0);
  };
  onButtonPress(BTN.CROSS, back, {
    active: () => panel() !== "none" || !titleScreen(),
  });
  const validDisplayedSlotId = (slot: string): boolean => slot.length > 0 && slot.length <= 256 &&
    slot !== "." && slot !== ".." && !slot.includes("/") && !slot.includes("\\") && !/[\u0000-\u001f\u007f]/.test(slot);
  const namedSlotIdsFor = (ids: readonly string[]): string[] => [
    ...LEGACY_NAMED_SLOTS,
    ...[...new Set(ids.filter(slot => slot !== "auto" && slot !== "quick" && !(LEGACY_NAMED_SLOTS as readonly string[]).includes(slot)))].sort(),
  ];
  const managementSlotIdsFor = (ids: readonly string[]): string[] => [
    ...namedSlotIdsFor(ids),
    ...(ids.includes("quick") ? ["quick"] : []),
  ];
  const pageSlotIdsFor = (targetPanel: Panel, ids: readonly string[], page: number): string[] => {
    const candidates = targetPanel === "slots" ? managementSlotIdsFor(ids) : namedSlotIdsFor(ids);
    return candidates.slice(page * SLOT_PAGE_SIZE, page * SLOT_PAGE_SIZE + SLOT_PAGE_SIZE);
  };
  const pageCountFor = (targetPanel: Panel, ids: readonly string[]): number =>
    Math.max(1, Math.ceil((targetPanel === "slots" ? managementSlotIdsFor(ids) : namedSlotIdsFor(ids)).length / SLOT_PAGE_SIZE));
  const slotManagementAvailable = (): boolean => !!props.storage?.list &&
    (!!props.storage.delete || !!props.storage.copy || !!props.storage.move || !!props.storage.swap);
  const slotExists = (slot: string): boolean => props.storage?.list
    ? storedSlots().includes(slot)
    : storedSlots().includes(slot) || slotSummaries()[slot]?.exists === true;
  const slotLabel = (slot: string): string => slot === "auto" ? message("slot.auto") :
    slot === "quick" ? message("slot.quick") : message("slot.named", { slot });
  const refreshSlots = async (targetPanel: Panel = panel(), requestedPage: number = slotPage()): Promise<void> => {
    const revision = ++slotRefreshRevision;
    setSlotDataStatus("loading");
    const storage = props.storage;
    if (!storage) return;
    try {
      let found: string[] = [];
      const probed = new Map<string, unknown>();
      if (storage.list) {
        const listed = await storage.list();
        const unique = [...new Set(listed.filter(slot => typeof slot === "string" && validDisplayedSlotId(slot)))].sort();
        const essentials = ["auto", "quick", ...LEGACY_NAMED_SLOTS].filter(slot => unique.includes(slot));
        const extras = unique.filter(slot => !essentials.includes(slot));
        found = [...essentials, ...extras.slice(0, Math.max(0, MAX_LISTED_SLOTS - essentials.length))];
        setSlotListOverflow(Math.max(0, extras.length - Math.max(0, MAX_LISTED_SLOTS - essentials.length)));
      } else {
        // Older custom consumers expose only read/write; probe the legacy keys
        // and the dedicated quick-save key without inventing a catalog.
        for (const slot of ["auto", "quick", ...LEGACY_NAMED_SLOTS]) {
          const value = await storage.read(slot);
          probed.set(slot, value);
          if (value !== null && value !== undefined) found.push(slot);
        }
        setSlotListOverflow(0);
      }
      setStoredSlots(found);
      const maxPage = pageCountFor(targetPanel, found) - 1;
      const page = Math.max(0, Math.min(requestedPage, maxPage));
      if (slotPage() !== page) setSlotPage(page);
      const rows = pageSlotIdsFor(targetPanel, found, page);
      const toRead = targetPanel === "save" ? ["quick", ...rows] :
        targetPanel === "load" ? ["auto", "quick", ...rows] : rows;
      const summaries: Record<string, SlotSummary> = {};
      for (const slot of new Set(toRead)) {
        try {
          const data = probed.has(slot) ? probed.get(slot) : await storage.read(slot);
          const record = data as NovelSaveData | null;
          const current = record?.state?.active;
          const text = current?.kind === "say"
            ? `${current.speaker ?? message("player.narrator")} · ${current.text.slice(0, 18)}`
            : data !== null && data !== undefined ? message("slot.currentJourney") : message("slot.empty");
          summaries[slot] = {
            exists: found.includes(slot) || (data !== null && data !== undefined),
            text,
            thumbnail: readNovelSlotThumbnail(data) ?? undefined,
          };
        } catch { summaries[slot] = { exists: true, text: message("slot.readError") }; }
      }
      if (revision !== slotRefreshRevision) return;
      setSlotSummaries(summaries);
      setSlotDataStatus("ready");
    } catch (error) {
      if (revision !== slotRefreshRevision) return;
      setSlotDataStatus("error");
      fail(error);
    }
  };
  const saveNow = async (slot: string): Promise<void> => {
    if (!props.storage || busy() || slot !== "quick" && !slotDataReady()) return;
    setBusy(true);
    try {
      const engine = props.engine;
      const data = props.videoAdapter && engine.getSnapshot().stage.video !== null
        ? await props.videoAdapter.captureForSave(engine, () => props.engine === engine)
        : engine.save();
      // A menu pause is presentation state, not the player's saved preference.
      // Remove menu paint while the host captures the existing paused stage.
      // The engine and canonical save stay unchanged; the view is input-blocked
      // until this write finishes, including any image IO it requested.
      if (props.slotImages) setCapturingSlotImage(true);
      await props.storage.write(slot, { ...data, state: { ...data.state, paused: false } });
      setPendingSlotAction(null);
      setNotice(message(slot === "quick" ? "slot.quickSaved" : "slot.saved", { slot }));
      await refreshSlots(panel(), slotPage());
      setCapturingSlotImage(false);
    } catch (error) { fail(error); } finally { setCapturingSlotImage(false); setBusy(false); }
  };
  const save = async (slot: string, quick = false): Promise<void> => {
    if (!props.storage || busy() || !quick && !slotDataReady()) return;
    if (!quick && slotExists(slot)) {
      setPendingSlotAction({ kind: "save", slot });
      return;
    }
    await saveNow(slot);
  };
  const load = async (slot: string): Promise<void> => {
    if (!props.storage || busy()) return;
    setBusy(true);
    try {
      const data = await props.storage.read(slot);
      if (!data) { setNotice(message("slot.missing")); return; }
      props.engine.load(data);
      setTitleScreen(false);
      setPanel("none");
      setPendingSlotAction(null);
      props.engine.resume();
      resumeAfterPanel = false;
      setNotice("");
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const mutateSlots = async (operation: () => Promise<void>, successKey: string, values: Readonly<Record<string, string | number>> = {}): Promise<boolean> => {
    if (!props.storage || busy()) return false;
    setBusy(true);
    try {
      await operation();
      setPendingSlotAction(null);
      setNotice(message(successKey, values));
      await refreshSlots(panel(), slotPage());
      return true;
    } catch (error) { fail(error); } finally { setBusy(false); }
    return false;
  };
  const createSlot = (): void => {
    const slot = slotIdDraft();
    if (!slotDataReady()) return;
    if (!slot.trim() || slot === "auto" || !validDisplayedSlotId(slot)) {
      setNotice(message(slot === "auto" ? "slot.reservedAuto" : "slot.invalidId"));
      return;
    }
    void save(slot);
  };
  const copyOrMoveSlot = (kind: "copy" | "move"): void => {
    const source = selectedSlot();
    const destination = slotIdDraft();
    const operation = props.storage?.[kind];
    if (!slotDataReady()) return;
    if (!source || !destination.trim() || !operation || destination === "auto" || !validDisplayedSlotId(destination)) {
      setNotice(message(destination === "auto" ? "slot.reservedAuto" : "slot.invalidId"));
      return;
    }
    if (destination === source) { setNotice(message("slot.sameId")); return; }
    const overwrite = slotExists(destination);
    if (overwrite) {
      setPendingSlotAction({ kind, source, destination, overwrite: true });
      return;
    }
    void mutateSlots(() => operation.call(props.storage, source, destination), kind === "copy" ? "slot.copyDone" : "slot.moveDone", { source, destination })
      .then(succeeded => { if (succeeded && kind === "move") setSelectedSlot(null); });
  };
  const swapSlot = (): void => {
    const first = selectedSlot();
    const second = slotIdDraft();
    if (!slotDataReady()) return;
    if (second === "auto") { setNotice(message("slot.reservedAuto")); return; }
    if (!first || !second.trim() || !props.storage?.swap || !slotExists(second)) {
      setNotice(message("slot.selectTwoExisting"));
      return;
    }
    if (first === second) { setNotice(message("slot.sameId")); return; }
    setPendingSlotAction({ kind: "swap", first, second });
  };
  const requestDeleteSlot = (): void => {
    const slot = selectedSlot();
    if (!slotDataReady() || !slot || !props.storage?.delete) return;
    setPendingSlotAction({ kind: "delete", slot });
  };
  const confirmPendingSlotAction = async (): Promise<void> => {
    const action = pendingSlotAction();
    const storage = props.storage;
    if (!action || !storage) return;
    switch (action.kind) {
      case "save": await saveNow(action.slot); return;
      case "delete":
        if (!storage.delete) return;
        if (await mutateSlots(() => storage.delete!(action.slot), "slot.deleteDone", { slot: action.slot }) && selectedSlot() === action.slot) setSelectedSlot(null);
        return;
      case "copy":
        if (!storage.copy) return;
        await mutateSlots(() => storage.copy!(action.source, action.destination, { overwrite: action.overwrite }), "slot.copyDone", { source: action.source, destination: action.destination });
        return;
      case "move":
        if (!storage.move) return;
        if (await mutateSlots(() => storage.move!(action.source, action.destination, { overwrite: action.overwrite }), "slot.moveDone", { source: action.source, destination: action.destination })) setSelectedSlot(null);
        return;
      case "swap":
        if (!storage.swap) return;
        await mutateSlots(() => storage.swap!(action.first, action.second), "slot.swapDone", { first: action.first, second: action.second });
        return;
    }
  };
  const start = (): void => {
    setPanel("none"); setTitleScreen(false); setNotice(""); resumeAfterPanel = false;
    props.onNewGame();
  };
  const toggleMode = (mode: "auto" | "skip"): void => {
    props.engine.setPreferences({ mode: snapshot().preferences.mode === mode ? "manual" : mode, skipSeenOnly: true });
  };
  const visibleLog = () => [...snapshot().backlog].reverse().slice(logPage() * 4, logPage() * 4 + 4);
  const visibleSlots = () => pageSlotIdsFor(panel(), storedSlots(), slotPage());
  const slotPageCount = () => pageCountFor(panel(), storedSlots());
  const changeSlotPage = (offset: number): void => {
    const next = Math.max(0, Math.min(slotPageCount() - 1, slotPage() + offset));
    if (next === slotPage()) return;
    setSlotPage(next);
    setNotice("");
    void refreshSlots(panel(), next);
  };
  const pendingSlotMessage = (action: PendingSlotAction): string => {
    switch (action.kind) {
      case "save": return message("slot.confirmSave", { slot: action.slot });
      case "delete": return message("slot.confirmDelete", { slot: action.slot });
      case "copy": return message("slot.confirmCopy", { source: action.source, destination: action.destination });
      case "move": return message("slot.confirmMove", { source: action.source, destination: action.destination });
      case "swap": return message("slot.confirmSwap", { first: action.first, second: action.second });
    }
  };
  const panelTitle = () => ({ none: "", menu: message("panel.menu"), save: message("panel.save"), load: message("panel.load"), slots: message("panel.slots"), log: message("panel.log"), settings: message("panel.settings"), gallery: message("panel.gallery"), inventory: message("panel.inventory"), collections: message("panel.collections"), note: message("panel.note") })[panel()];
  const panelIcon = () => ({ none: undefined, menu: "book", save: "save", load: "envelope", slots: "download", log: "wave", settings: "settings", gallery: "gallery", inventory: "book", collections: "book", note: "book" })[panel()];
  const inventoryRows = createMemo(() => panel() === "inventory" ? Object.entries(props.inventory?.items ?? {}) : []);
  const inventoryPageCount = () => Math.max(1, Math.ceil(inventoryRows().length / 8));
  const currentInventoryPage = () => Math.min(inventoryPage(), inventoryPageCount() - 1);
  const inventoryPageRows = createMemo(() => inventoryRows().slice(currentInventoryPage() * 8, (currentInventoryPage() + 1) * 8));
  const selectedInventoryItem = createMemo(() => {
    const id = inventorySelection();
    return id && props.inventory && Object.hasOwn(props.inventory.items, id) ? { id, value: props.inventory.items[id]! } : null;
  });
  const inventoryCount = (variable: string): string => {
    const count = snapshot().variables[variable];
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? String(count) : message("inventory.invalid");
  };
  const inventoryText = (id: string | null, field: "title" | "body", fallback: string): string => props.ui?.[novelInventoryTextKey(id, field)] ?? fallback;
  const inventoryBalance = () => props.inventory ? wrapTextLines(message("inventory.balance", { currency: inventoryText(null, "title", props.inventory.currency.title), count: inventoryCount(props.inventory.currency.variable) }), Math.max(1, Math.floor(panelContentWidth() / 8)), panelContentWidth(), 1) : "";
  const collections = createMemo(() => Object.entries(props.assets.collections ?? {}));
  // Bound mounted controls, as the gallery already bounds decoded cards.
  const collectionRows = createMemo(() => panel() === "collections" ? collections().flatMap(([collectionId, collection]) =>
    Object.entries(collection.entries).map(([entryId, entry]) => ({ collectionId, entryId, entry }))) : []);
  const collectionPageCount = createMemo(() => Math.max(1, Math.ceil(collectionRows().length / 8)));
  const currentCollectionPage = () => Math.min(collectionPage(), collectionPageCount() - 1);
  const collectionPageRows = createMemo(() => collectionRows().slice(currentCollectionPage() * 8, (currentCollectionPage() + 1) * 8));
  const visibleCollections = createMemo(() => collections().filter(([id]) => collectionPageRows().some(row => row.collectionId === id)));
  const collectionText = (key: string, fallback: string): string => props.ui?.[key] ?? fallback;
  const selectedCollectionEntry = createMemo(() => {
    const selection = collectionSelection();
    const entry = selection && props.assets.collections?.[selection.collection]?.entries[selection.entry];
    return selection && entry && isNovelCollectionEntryUnlocked(entry, snapshot().variables) ? { ...selection, value: entry } : null;
  });
  const panelHeaderTextWidth = () => Math.max(1, panelContentWidth() - 126);
  const panelHeaderLabel = () => wrapTextLines(
    panelTitle(),
    Math.max(1, Math.floor(panelHeaderTextWidth() / 12)),
    panelHeaderTextWidth(),
    11,
  );
  const panelHeaderHeight = () => Math.max(44, panelHeaderLabel().split("\n").length * 25);
  // Motion transitions become visual cuts while reduced motion is active;
  // canonical transition time continues to advance inside the engine.
  const transition = () => reduceMotion() ? null : snapshot().stage.transition;
  const progress = () => Math.min(1, Math.max(0, (transition()?.elapsedMs ?? 1) / (transition()?.durationMs || 1)));
  const revealing = () => {
    const active = transition();
    return active?.kind === "reveal" ? active : undefined;
  };
  const revealClip = () => revealClipBounds(revealing()?.direction ?? "left", progress(), visualViewport().width, visualViewport().height);
  const fadingOut = () => transition()?.kind === "fade" && !!transition()?.from && progress() < 0.5;
  const fadeOpacity = () => transition()?.kind === "fade" ? (transition()?.from ? (fadingOut() ? progress() * 2 : (1 - progress()) * 2) : 1 - progress()) : 0;
  const backgroundImageStyle = (source: string) => imageBoundsStyle(novelImageCoverBounds(visualViewport().width, visualViewport().height, props.assets.imageDimensions?.[source]));
  const choiceHeight = () => {
    const current = choice();
    if (!current) return 1;
    const estimated = 40 + current.options.length * 56 + (props.replayMode && props.inventory ? 56 : 0) + (current.prompt ? 48 : 0) + (current.timeRemainingMs !== null ? 20 : 0);
    return Math.min(layout().choiceMaxHeight, estimated);
  };
  const endingImageWidth = () => Math.max(1, Math.min(300, layout().endingWidth - 48));
  const endingImageHeight = () => Math.max(1, Math.min(190, layout().height * 0.3));
  const galleryImageWidth = () => Math.max(1, Math.min(320, panelContentWidth() - 24));
  const unlockedGalleryEntries = createMemo(() => Object.entries(props.assets.cgs).filter(([id]) => snapshot().meta.cgIds.includes(id)));
  const lockedGalleryEntries = createMemo(() => Object.entries(props.assets.cgs).filter(([id]) => !snapshot().meta.cgIds.includes(id)));
  // Keep the original two-card resource bound even for a large unlocked gallery.
  // One existing page index visits collected pages first, then sealed pages.
  const unlockedGalleryPageCount = () => Math.ceil(unlockedGalleryEntries().length / 2);
  const galleryPageCount = createMemo(() => Math.max(1, unlockedGalleryPageCount() + Math.ceil(lockedGalleryEntries().length / 2)));
  const currentGalleryPage = createMemo(() => Math.min(galleryPage(), galleryPageCount() - 1));
  const galleryShowsUnlocked = () => currentGalleryPage() < unlockedGalleryPageCount();
  const galleryPageEntries = createMemo(() => {
    const unlocked = galleryShowsUnlocked();
    const page = currentGalleryPage() - (unlocked ? 0 : unlockedGalleryPageCount());
    return (unlocked ? unlockedGalleryEntries() : lockedGalleryEntries()).slice(page * 2, page * 2 + 2);
  });
  const galleryCard = ([id, cg]: [string, NovelAssets["cgs"][string]]) => <View class="flex-col items-center gap-2 mb-1">
    <Show when={snapshot().meta.cgIds.includes(id)} fallback={<View class="relative w-full h-[145] items-center justify-center overflow-hidden" style={{ width: panelContentWidth(), height: 145 }}><SkinBackground width={panelContentWidth()} height={145} border={18} debugName={`vn-cg-sealed-${id}-skin`} /><Text class="text-sm text-[#70888B]">{message("gallery.notCollected")}</Text></View>}>
      <View class="relative overflow-hidden" style={{ width: galleryImageWidth(), height: 145 }}>
        <SkinBackground width={galleryImageWidth()} height={145} border={16} debugName={`vn-cg-${id}-skin`} />
        <View class="absolute overflow-hidden" style={{ insetL: 16, insetT: 16, width: Math.max(1, galleryImageWidth() - 32), height: 113 }}>
          <Image src={cg.image} class="absolute" style={imageBoundsStyle(novelImageCoverBounds(Math.max(1, galleryImageWidth() - 32), 113, props.assets.imageDimensions?.[cg.image]))} />
        </View>
      </View>
    </Show>
    <Text class="text-sm text-[#E4CF9E]">{snapshot().meta.cgIds.includes(id) ? cg.title : message("gallery.sealed")}</Text>
  </View>;
  const skinContext: NovelSkinContextValue = {
    frame: () => props.assets.skin?.frame,
    accentFrame: () => props.assets.skin?.accentFrame,
    icons: () => props.assets.skin?.icons,
    actionWidth: () => panel() !== "none"
      ? panelContentWidth()
      : titleScreen()
      ? Math.max(1, layout().titleMenuWidth - 24)
      : ending()
        ? Math.max(1, layout().endingWidth - 40)
        : panelContentWidth(),
  };
  const compactPairWidth = (horizontalInset = 0) => Math.max(1, (panelContentWidth() - horizontalInset - 8) / 2);
  const pageActionWidth = () => Math.max(1, (panelContentWidth() - 100 - 16) / 2);
  const visualStage = () => fadingOut() ? transition()!.from! : presentationStage();
  const artCameraPose = () => resolveNovelCameraPose(visualStage().camera, { reduceMotion: reduceMotion() });
  const artCameraStyle = () => localCameraStyle(artCameraPose());
  const fullArtCameraStyle = () => fullViewportCameraStyle(artCameraPose(), layout(), visualViewport());
  const choiceOptionText = (text: string) => wrapTextLines(text, Math.max(1, Math.floor((layout().choiceWidth - 58) / 8)), layout().choiceWidth - 58, 1);
  const choiceOptionHeight = (text: string) => Math.max(40, choiceOptionText(text).split("\n").length * 20 + 16);
  const choiceSurface = createMemo(() => {
    const current = choice();
    if (!current || panel() !== "none" || snapshot().paused) return null;
    const promptLines = current.prompt ? wrapTextLines(current.prompt,
      Math.max(1, Math.floor((layout().choiceWidth - 32) / 8)), layout().choiceWidth - 32, 1).split("\n").length : 0;
    if (promptLines * 20 + 16 + (current.timeRemainingMs === null ? 0 : 20) > 64) return null;
    const surface = props.assets.choiceSurfaces?.[current.id];
    const dimensions = surface?.kind === "dial" ? props.assets.imageDimensions?.[surface.image] : undefined;
    const pose = resolveNovelCameraPose(presentationStage().camera, { reduceMotion: reduceMotion() });
    const resolved = createNovelChoiceSurfaceLayout(surface, current.options, layout().width, layout().height, dimensions, 44 / pose.scale);
    if (resolved?.targets.some(target => {
      const left = layout().width / 2 + (target.x - layout().width / 2) * pose.scale + pose.x;
      const top = layout().height / 2 + (target.y - layout().height / 2) * pose.scale + pose.y;
      return Math.min(layout().width, left + target.width * pose.scale) - Math.max(0, left) < 44
        || Math.min(layout().height, top + target.height * pose.scale) - Math.max(0, top) < 44;
    })) return null;
    // Keep the ordinary scrollable choices whenever localized captions would
    // overflow a spatial target. Legal options must remain readable and usable.
    if (resolved?.targets.some(target => wrapTextLines(target.displayCaption,
      Math.max(1, Math.floor((target.width - 16) / 8)), target.width - 16, 1).split("\n").length * 20 + 16 > target.height)) return null;
    return resolved;
  }, null, { equals: sameChoiceSurfaceLayout });
  const activeStage = () => <View class="absolute inset-0 w-full h-full bg-[#08151D]" style={{ opacity: transition()?.kind === "dissolve" ? progress() : 1, hitPass: 1 }}>
    <View class="absolute inset-0 w-full h-full" style={{ ...fullArtCameraStyle(), hitPass: 1 }}>
    <StageBackground stage={visualStage()} assets={props.assets} layout={visualViewport()} safeLayout={layout()} reduceMotion={reduceMotion()} />
    <Show when={snapshot().phase !== "disposed" ? stageVideo() : undefined}>{video => {
      const asset = () => props.assets.videos?.[video().cue];
      return <Show when={asset()} fallback={<View class="absolute inset-0 items-center justify-center bg-[#08151D]"><Text class="text-xs text-[#F0B78F]">{message("video.error", { detail: `Unknown video cue: ${video().cue}` })}</Text></View>}>
        <Show when={props.videoAdapter} fallback={<View class="absolute inset-0 items-center justify-center bg-[#08151D]"><Text class="text-xs text-[#F0B78F]">{message("video.error", { detail: "Video adapter unavailable" })}</Text></View>}>
          {adapter => <Video
            id={adapter().surfaceId}
            asset={asset()!}
            media={adapter().media}
            token={snapshot().videoToken}
            loop={video().loop}
            active={!snapshot().paused && panel() === "none" && snapshot().phase !== "disposed"}
            playing={video().status === "playing"}
            fit="cover"
            class="w-full h-full"
            style={{ width: visualViewport().width, height: visualViewport().height }}
          />}
        </Show>
      </Show>;
    }}</Show>
    <Show when={props.assets.atmospheres?.[visualStage().background ?? ""]}>{config => <NovelAtmosphereView config={config()} width={visualViewport().width} height={visualViewport().height} active={!snapshot().paused && panel() === "none"} animations={props.animations} />}</Show>
    </View>
    <View class="absolute overflow-hidden" style={{ ...safeStageClipBounds(layout()), hitPass: 1 }}>
    <View class="absolute inset-0 w-full h-full" style={{ ...artCameraStyle(), hitPass: 1 }}>
      <StageItems stage={visualStage()} assets={props.assets} layout={layout()} modelFactory={props.modelFactory} animations={props.animations} message={message} variables={snapshot().variables} interactive={!titleScreen() && panel() === "none" && !snapshot().paused && snapshot().phase === "say" && !transition()} modelInteractive={!titleScreen() && panel() === "none" && !snapshot().paused && (snapshot().phase === "say" || snapshot().phase === "wait" || snapshot().phase === "choice") && !transition()} reduceMotion={reduceMotion()} onObjectPress={id => { try { props.engine.interactSceneObject(id); } catch (error) { fail(error); } }} />
      <Show when={choiceSurface()}>{surface => <NovelChoiceSurfaceView layout={surface()} renderOption={(option, geometry, caption) =>
        <FocusTarget autoFocus={option.id === choice()?.options[0]?.id} onNode={option.id === choice()?.options[0]?.id ? rememberInteractionFocus : undefined}
          debugName={`vn-choice-${option.id}`} class="absolute flex-col items-center justify-center px-2"
          skinWidth={surface().image ? undefined : geometry.width} skinHeight={surface().image ? undefined : geometry.height}
          style={{ insetL: geometry.x, insetT: geometry.y, width: geometry.width, height: geometry.height }}
          onPress={() => { try { props.engine.selectChoice(option.id); } catch (error) { fail(error); } }}>
          <Text class="text-sm text-[#FFE1A3]">{wrapTextLines(caption, Math.max(1, Math.floor((geometry.width - 16) / 8)), geometry.width - 16, 1)}</Text>
        </FocusTarget>
      } />}</Show>
    </View>
    </View>
  </View>;
  return <NovelSkinContext.Provider value={skinContext}><View class="relative w-full h-full overflow-hidden bg-[#08151D]">
    <View class="absolute inset-0 overflow-hidden bg-[#08151D]" style={{ hitPass: 1 }}>
      <Show when={titleScreen()}><Show when={background()}>{source => <Image src={source()} class="absolute" style={backgroundImageStyle(source())} />}</Show></Show>
      <Show when={titleScreen() && panel() === "none"}><View class="absolute inset-0 bg-[#08151D]" style={{ opacity: 0.28 }} /></Show>
      <Show when={!titleScreen()}>
      <Show when={revealing()} fallback={<>
        <Show when={transition()?.kind === "dissolve" ? transition()?.from : undefined}>{previous => <StageArt stage={previous()} assets={props.assets} layout={layout()} visualViewport={visualViewport()} reduceMotion={reduceMotion()} modelFactory={props.modelFactory} animations={props.animations} message={message} />}</Show>
        {activeStage()}
      </>}>
        {current => {
          const clip = () => revealClip();
          return <>
            <Show when={current().from}>{previous => <StageArt stage={previous()} assets={props.assets} layout={layout()} visualViewport={visualViewport()} reduceMotion={reduceMotion()} modelFactory={props.modelFactory} animations={props.animations} message={message} />}</Show>
            <View class="absolute overflow-hidden" style={{ insetL: clip().insetL, insetT: clip().insetT, width: clip().width, height: clip().height }}>
              <View class="absolute" style={{ insetL: clip().contentInsetL, insetT: clip().contentInsetT, width: visualViewport().width, height: visualViewport().height }}>
                {activeStage()}
              </View>
            </View>
          </>;
        }}
      </Show>

      <Show when={transition()?.kind === "fade"}><View class="absolute inset-0 bg-[#08151D]" style={{ opacity: fadeOpacity() }} /></Show>
      </Show>
    </View>
    <View class="absolute overflow-hidden" style={{ ...stageBounds(), hitPass: 1 }}>
    <Show when={!titleScreen()}>
      <View class="absolute flex-row items-center justify-between" style={headerBounds()}>
        <IconLabel label={props.shortTitle ?? props.title} icon="compass" width={22} height={22} tone="accent" />
        <FocusTarget skinWidth={120} skinHeight={44} class="relative shrink-0 h-[44] px-2 items-center justify-center" onPress={() => props.replayMode ? props.onReplayExit?.() : openPanel("menu")}>
          <IconLabel label={message(props.replayMode ? "replay.exit" : "player.menu")} icon="envelope" width={18} height={18} />
        </FocusTarget>
      </View>
      <Show when={videoControlVisible()}><View class="absolute flex-row items-center justify-center gap-2 overflow-hidden" style={{ insetL: layout().toolbarLeft, insetT: 56, width: layout().toolbarWidth, height: 44 }}>
        <VideoControlAction label={stageVideo()?.status === "playing" ? message("video.pause") : stageVideo()?.status === "ended" ? message("video.restart") : message("video.resume")} debugName="vn-video-pause" width={videoControlWidth()} onPress={toggleStageVideo} />
        <VideoControlAction label={message("video.seekBack")} debugName="vn-video-back" width={videoControlWidth()} disabled={!props.videoAdapter || !videoSeekingAvailable()} onPress={() => { void seekVideoBy(-1_000); }} />
        <VideoControlAction label={message("video.seekStart")} debugName="vn-video-start" width={videoControlWidth()} disabled={!props.videoAdapter || !videoSeekingAvailable()} onPress={() => { void seekVideoToStart(); }} />
        <VideoControlAction label={message("video.seekForward")} debugName="vn-video-forward" width={videoControlWidth()} disabled={!props.videoAdapter || !videoSeekingAvailable()} onPress={() => { void seekVideoBy(1_000); }} />
        <VideoControlAction label={message("video.close")} debugName="vn-video-close" width={videoControlWidth()} onPress={closeStageVideo} />
      </View></Show>
      <Show when={say()}>{value => <View class="absolute p-4 flex-col min-h-[0]" style={{ insetL: sayFrame().left, insetT: sayFrame().top, width: sayFrame().width, height: sayFrame().height }}>
        <SkinBackground width={sayFrame().width} height={sayFrame().height} border={24} debugName={`vn-say-${sayPresentation()}-skin`} />
        <FocusTarget autoFocus onNode={rememberInteractionFocus} class="absolute inset-0 flex-col min-h-[0] overflow-hidden px-6 pt-5 pb-6" onPress={() => props.engine.advance()} debugName={`vn-say-${sayPresentation()}`}>
          <Show keyed when={value().id}>{_sayId =>
            <ScrollablePage class="flex-1 min-h-[0] overflow-hidden" style={{ width: sayTextWidth(), marginL: Math.max(0, (sayFrame().width - 48 - sayTextWidth()) / 2), marginT: sayFrame().bodyTop }}>
              <Show when={value().rich} fallback={<Text class="text-base text-[#F5ECD9]">{wrapTextLines(value().visibleText, Math.max(1, Math.floor(sayTextWidth() / 9)), sayTextWidth(), 2)}</Text>}>{rich =>
                <NovelRichTextView text={value().text} rich={rich()} revealedCharacters={value().revealedCharacters} width={sayTextWidth()} debugName={`vn-rich-${value().id}`} onLink={activateNote} onHeight={height => setRichDialogueMeasure({ lineId: value().id, height })} />
              }</Show>
            </ScrollablePage>
          }</Show>
          <View class="absolute bottom-[12] right-[16]"><Text class="text-xs text-[#C7C4B6]">{value().pause ? message("player.resumeText") : value().complete ? message("player.continue") : message("player.reveal")}</Text></View>
        </FocusTarget>
        <View class="absolute flex-row items-center justify-between" style={{ insetL: sayPresentation() === "dialogue" ? 18 : 12, insetT: sayFrame().headerTop, width: Math.max(1, sayFrame().width - (sayPresentation() === "dialogue" ? 36 : 24)), height: 36 }}>
          <View class="relative h-[36] flex-row items-center px-3" style={{ width: saySpeakerWidth(), height: 36 }}>
            <SkinBackground width={saySpeakerWidth()} height={36} border={16} debugName={`vn-say-${sayPresentation()}-speaker-skin`} />
            <IconLabel label={value().speaker ?? message("player.narrator")} icon="book" width={18} height={18} tone="accent" />
          </View>
          <Show when={snapshot().voice?.lineId === value().id}>
            <FocusTarget skinWidth={sayVoiceWidth()} skinHeight={36} class="relative shrink-0 h-[36] px-2 items-center justify-center" onPress={() => props.engine.replayVoice()} debugName="vn-voice-replay">
              <IconLabel label={message("player.voiceReplay")} icon="wave" width={16} height={16} />
            </FocusTarget>
          </Show>
        </View>
      </View>}</Show>
      <Show when={choiceSurface() && choice()}>{value => <View class="absolute px-4 py-2" style={{ insetL: layout().choiceLeft, insetT: 64, width: layout().choiceWidth, height: 64 }} debugName="vn-spatial-choice-prompt">
        <SkinBackground width={layout().choiceWidth} height={64} border={16} />
        <Text class="text-sm text-[#E4CF9E]">{wrapTextLines(value().prompt ?? "", Math.max(1, Math.floor((layout().choiceWidth - 32) / 8)), layout().choiceWidth - 32, 1)}</Text>
        <Show when={value().timeRemainingMs !== null}><Text class="text-xs text-[#F0B78F]">{message("player.choiceTimer", { seconds: Math.ceil((value().timeRemainingMs ?? 0) / 1000) })}</Text></Show>
      </View>}</Show>
      <Show when={!choiceSurface() && choice()}>{value => <View class="absolute flex-col p-3 min-h-[0] overflow-hidden" style={{ insetL: layout().choiceLeft, insetB: layout().choiceBottom, width: layout().choiceWidth, height: choiceHeight() }} debugName="vn-choices">
        <SkinBackground width={layout().choiceWidth} height={choiceHeight()} border={24} debugName="vn-choices-skin" />
        <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
          <View class="flex-col gap-2 pb-1">
            <Show when={value().prompt}><Text class="text-sm text-[#E4CF9E] mb-2">{wrapTextLines(value().prompt!, Math.max(1, Math.floor((layout().choiceWidth - 32) / 8)), layout().choiceWidth - 32, 1)}</Text></Show>
            <Show when={value().timeRemainingMs !== null}><Text class="text-xs text-[#F0B78F]">{message("player.choiceTimer", { seconds: Math.ceil((value().timeRemainingMs ?? 0) / 1000) })}</Text></Show>
            <Show when={props.replayMode && props.inventory}><Action label={message("panel.inventory")} icon="book" quiet skinWidth={Math.max(1, layout().choiceWidth - 24)} onPress={() => openPanel("inventory")} debugName="vn-replay-inventory" /></Show>
            <For each={value().options}>{option => {
              const wrapped = () => choiceOptionText(option.text);
              const height = () => choiceOptionHeight(option.text);
              return <FocusTarget autoFocus={option.id === value().options[0]?.id} onNode={option.id === value().options[0]?.id ? rememberInteractionFocus : undefined} debugName={`vn-choice-${option.id}`} skinWidth={Math.max(1, layout().choiceWidth - 24)} skinHeight={height()} class="relative flex-col justify-center py-2 px-3" style={{ height: height() }} onPress={() => { try { props.engine.selectChoice(option.id); } catch (error) { fail(error); } }}><Text class="text-sm text-[#F5ECD9]">{wrapped()}</Text></FocusTarget>;
            }}</For>
          </View>
        </ScrollablePage>
      </View>}</Show>
      <Show keyed when={!titleScreen() && panel() === "none" && !snapshot().paused ? playerInput()?.id : undefined}>{inputId => {
        const currentInput = (): InputState | undefined => {
          const current = playerInput();
          return current?.id === inputId ? current : undefined;
        };
        const fallbackHint = (): string => {
          const kind = currentInput()?.inputType;
          return message(kind === "number" ? "input.defaultNumber" : kind === "boolean" ? "input.defaultBoolean" : "input.defaultText");
        };
        const inputContentWidth = (): number => Math.max(1, layout().inputWidth - 32);
        const inputChoiceWidth = (): number => Math.max(1, (inputContentWidth() - 12) / 2);
        const inputActionWidth = (): number => currentInput()?.canCancel ? inputChoiceWidth() : inputContentWidth();
        return <View class="absolute" style={{ insetL: layout().inputLeft, insetT: layout().inputTop, insetB: layout().inputBottom, width: layout().inputWidth, height: layout().inputHeight }}>
          <View class="relative w-full h-full flex-col gap-3 p-4 min-h-[0] overflow-hidden" debugName={`vn-input-${inputId}`}>
            <SkinBackground width={layout().inputWidth} height={layout().inputHeight} border={24} debugName={`vn-input-${inputId}-skin`} />
            <Text class="text-sm text-[#E4CF9E]">{currentInput()?.prompt ?? fallbackHint()}</Text>
            <Show when={currentInput()?.inputType === "boolean"} fallback={<Show keyed when={String(inputFieldRevision())}>{_revision => <View class="relative w-full" style={{ width: inputContentWidth(), height: 44 }}>
              <SkinBackground width={inputContentWidth()} height={44} border={10} debugName={`vn-input-${inputId}-field-skin`} />
              <InputField
                value={() => {
                  const current = currentInput();
                  return typeof current?.draft === "string" ? current.draft : "";
                }}
                onInput={value => updatePlayerInput(inputId, value)}
                placeholder={currentInput()?.placeholder ?? fallbackHint()}
                appearance={{
                  textColor: "#F5ECD9",
                  placeholderColor: "#9EB2B5",
                  fillColor: "transparent",
                  borderColor: "transparent",
                  focusedBorderColor: "transparent",
                  borderRadius: 0,
                  fontSize: 14,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
              />
            </View>}</Show>}>
              <View class="flex-row gap-3">
                <FocusTarget autoFocus={currentInput()?.draft === false} debugName={`vn-input-${inputId}-false`} skinWidth={inputChoiceWidth()} skinHeight={48} class="relative shrink-0 h-[48] items-center justify-center" style={{ width: inputChoiceWidth(), opacity: currentInput()?.draft === false ? 1 : 0.7 }} onPress={() => updatePlayerInput(inputId, false)}><Text class="text-sm text-[#F5ECD9]">{message("input.false")}</Text></FocusTarget>
                <FocusTarget autoFocus={currentInput()?.draft === true} debugName={`vn-input-${inputId}-true`} skinWidth={inputChoiceWidth()} skinHeight={48} class="relative shrink-0 h-[48] items-center justify-center" style={{ width: inputChoiceWidth(), opacity: currentInput()?.draft === true ? 1 : 0.7 }} onPress={() => updatePlayerInput(inputId, true)}><Text class="text-sm text-[#F5ECD9]">{message("input.true")}</Text></FocusTarget>
              </View>
            </Show>
            <Show when={currentInput()?.error}>{error => <Text class="text-xs text-[#F0B78F]">{inputErrorMessage(error())}</Text>}</Show>
            <View class="flex-row gap-3 mt-1">
              <FocusTarget debugName={`vn-input-${inputId}-submit`} skinWidth={inputActionWidth()} skinHeight={44} class="relative shrink-0 h-[44] items-center justify-center" style={{ width: inputActionWidth() }} onPress={() => submitPlayerInput(inputId)}><Text class="text-sm text-[#F5ECD9]">{message("input.submit")}</Text></FocusTarget>
              <Show when={currentInput()?.canCancel}><FocusTarget debugName={`vn-input-${inputId}-cancel`} skinWidth={inputActionWidth()} skinHeight={44} class="relative shrink-0 h-[44] items-center justify-center" style={{ width: inputActionWidth() }} onPress={() => cancelPlayerInput(inputId)}><Text class="text-sm text-[#F5ECD9]">{message("input.cancel")}</Text></FocusTarget></Show>
            </View>
          </View>
        </View>;
      }}</Show>
      <Show when={snapshot().phase === "wait"}><View class="absolute" style={{ insetL: 18, insetB: layout().toolbarHeight + 28 }}><Text class="text-xs text-[#E4CF9E]">{message("player.wait")}</Text></View></Show>
      <Show when={ending()}>{value => <View class="absolute p-5 flex-col items-center gap-3 min-h-[0] overflow-hidden" style={{ insetL: layout().endingLeft, insetT: layout().endingTop, insetB: layout().endingBottom, width: layout().endingWidth, height: layout().endingHeight }}>
        <SkinBackground width={layout().endingWidth} height={layout().endingHeight} border={24} debugName="vn-ending-skin" />
        <Text class="text-xs text-[#DBBD80]">{message("player.endingTitle")}</Text>
        <Show when={value().cg ? props.assets.cgs[value().cg!] : undefined}>{cg => {
          const source = () => cg().image;
          const width = endingImageWidth();
          const height = endingImageHeight();
          const inset = 12;
          const imageWidth = Math.max(1, width - inset * 2);
          const imageHeight = Math.max(1, height - inset * 2);
          const bounds = () => novelImageCoverBounds(imageWidth, imageHeight, props.assets.imageDimensions?.[source()]);
          return <View class="relative overflow-hidden" style={{ width, height }}>
            <SkinBackground width={width} height={height} border={12} debugName="vn-ending-image-skin" />
            <View class="absolute overflow-hidden" style={{ insetL: inset, insetT: inset, width: imageWidth, height: imageHeight }}><Image src={source()} class="absolute" style={{ insetL: bounds().insetL, insetT: bounds().insetT, width: bounds().width, height: bounds().height }} /></View>
          </View>;
        }}</Show>
        <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden"><Text class="text-base text-[#F5ECD9]">{wrapTextLines(value().text, Math.max(1, Math.floor((layout().endingWidth - 48) / 9)), layout().endingWidth - 48, 2)}</Text></ScrollablePage>
        <Text class="text-xs text-[#9EB2B5]">{message("player.endingCount", { count: snapshot().meta.endingIds.length })}</Text>
        <Show when={props.replayMode} fallback={<>
          <Action label={message("player.newStory")} onPress={start} autoFocus onNode={rememberInteractionFocus} />
          <Action label={message("player.titlePage")} onPress={() => { props.engine.pause(); setTitleScreen(true); }} />
        </>}>
          <Action label={message("replay.exit")} onPress={() => props.onReplayExit?.()} autoFocus onNode={rememberInteractionFocus} />
        </Show>
      </View>}</Show>
      <View class="absolute flex-row items-center justify-center gap-2" style={{ insetL: layout().toolbarLeft, insetB: 0, width: layout().toolbarWidth, height: layout().toolbarHeight }}>
        <FocusTarget skinWidth={layout().toolbarButtonWidth} skinHeight={44} class="relative shrink-0 h-[44] items-center justify-center px-1" style={{ width: layout().toolbarButtonWidth }} onPress={() => { if (snapshot().rollbackAvailable) props.engine.rollback(); }}><IconLabel icon={toolbarHasIcons() ? "rewind" : undefined} labelWidth={toolbarLabelWidth()} label={message("player.rollback")} width={16} height={16} /></FocusTarget>
        <FocusTarget skinWidth={layout().toolbarButtonWidth} skinHeight={44} class="relative shrink-0 h-[44] items-center justify-center px-1" style={{ width: layout().toolbarButtonWidth }} onPress={() => openPanel("log")}><IconLabel icon={toolbarHasIcons() ? "wave" : undefined} labelWidth={toolbarLabelWidth()} label={message("player.log")} width={16} height={16} /></FocusTarget>
        <FocusTarget skinWidth={layout().toolbarButtonWidth} skinHeight={44} class="relative shrink-0 h-[44] items-center justify-center px-1" style={{ width: layout().toolbarButtonWidth }} onPress={() => toggleMode("auto")}><IconLabel icon={toolbarHasIcons() ? "play" : undefined} labelWidth={toolbarLabelWidth()} label={message(snapshot().preferences.mode === "auto" ? "player.autoActive" : "player.auto")} width={16} height={16} /></FocusTarget>
        <FocusTarget skinWidth={layout().toolbarButtonWidth} skinHeight={44} class="relative shrink-0 h-[44] items-center justify-center px-1" style={{ width: layout().toolbarButtonWidth }} onPress={() => toggleMode("skip")}><IconLabel icon={toolbarHasIcons() ? "skip" : undefined} labelWidth={toolbarLabelWidth()} label={message(snapshot().preferences.mode === "skip" ? "player.skipActive" : "player.skip")} width={16} height={16} /></FocusTarget>
      </View>
    </Show>
    </View>
    <Show when={panel() !== "none" && !capturingSlotImage()}><View class="absolute inset-0 bg-[#08151D]" style={{ opacity: 0.96 }} /></Show>
    <View class="absolute overflow-hidden" style={{ ...stageBounds(), hitPass: 1 }}>
    <Show when={titleScreen() && panel() === "none"}>
      <FocusScope class="absolute inset-0 w-full h-full" autoFocus restoreFocus={false}>
      <View class="absolute flex-col min-h-[0] overflow-hidden" style={{ insetL: layout().titleMenuLeft, insetT: layout().titleMenuTop, width: layout().titleMenuWidth, height: layout().titleMenuMaxHeight }}>
        <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
          <View class="flex-col gap-2 pb-2">
            <IconLabel label={message("player.brand")} icon="compass" width={22} height={22} />
            <Text class="text-4xl text-[#FFF2D5] font-bold">{wrapTextLines(props.title, Math.max(1, Math.floor(layout().titleMenuWidth / 20)), layout().titleMenuWidth, 13)}</Text>
            <Text class="text-xs text-[#E6E0D2]">{wrapTextLines(props.subtitle ?? message("player.subtitle"), Math.max(1, Math.floor(layout().titleMenuWidth / 7)), layout().titleMenuWidth, 1)}</Text>
            <View class="h-[8]" />
            <View class="flex-col gap-2">
              <Action label={message("title.start")} icon="compass" primary onPress={start} autoFocus debugName="vn-title-start" skinWidth={layout().titleMenuWidth} />
              <Action label={message("title.resume")} icon="quill" quiet onPress={() => { void load("auto"); }} disabled={!props.storage || busy()} skinWidth={layout().titleMenuWidth} />
              <Action label={message("title.load")} icon="envelope" quiet onPress={() => openPanel("load")} skinWidth={layout().titleMenuWidth} />
              <Show when={props.onReplayStart && featuredReplays().length > 0}><For each={featuredReplays()}>{entry =>
                <Action
                  label={entry.title}
                  icon="play"
                  quiet
                  onPress={() => props.onReplayStart?.(entry.id)}
                  debugName={entry.id === props.featuredReplayId ? "vn-title-featured-replay" : `vn-title-featured-replay-${entry.id}`}
                  skinWidth={layout().titleMenuWidth}
                />
              }</For></Show>
              <Action label={message("title.gallery")} icon="gallery" quiet onPress={() => openPanel("gallery")} skinWidth={layout().titleMenuWidth} />
              <Show when={props.inventory}><Action label={message("panel.inventory")} icon="book" quiet onPress={() => openPanel("inventory")} skinWidth={layout().titleMenuWidth} /></Show>
              <Show when={collections().length > 0}><Action label={message("panel.collections")} icon="book" quiet onPress={() => openPanel("collections")} skinWidth={layout().titleMenuWidth} /></Show>
              <Action label={message("title.settings")} icon="settings" quiet onPress={() => openPanel("settings")} skinWidth={layout().titleMenuWidth} />
              <Show when={props.onExit}><Action label={message("title.exit")} icon="anchor" quiet onPress={() => props.onExit?.()} skinWidth={layout().titleMenuWidth} /></Show>
            </View>
          </View>
        </ScrollablePage>
      </View>
      </FocusScope>
    </Show>
    <Show when={panel() !== "none" && !capturingSlotImage()}>
      <FocusScope class="absolute inset-0 w-full h-full" autoFocus restoreFocus={false}>
      <View class="absolute min-h-[0] overflow-hidden" style={{ insetL: layout().panelLeft, insetT: layout().panelTop, width: layout().panelWidth, height: layout().panelHeight }}>
        <SkinBackground width={layout().panelWidth} height={layout().panelHeight} border={24} debugName="vn-panel-skin" />
        <View class="absolute flex-col gap-3 min-h-[0] overflow-hidden" style={{ insetL: panelContentLeft(), insetT: panelContentTop(), width: panelContentWidth(), height: panelContentHeight() }}>
        <View class="flex-row items-start gap-2" style={{ width: panelContentWidth(), height: panelHeaderHeight() }}>
          <IconLabel label={panelTitle()} icon={panelIcon()} width={22} height={22} labelWidth={panelHeaderTextWidth()} tone="heading" />
          <FocusTarget skinWidth={88} skinHeight={44} class="relative shrink-0 h-[44] px-2 items-center justify-center" onPress={closePanel}><IconLabel icon="back" label={message("panel.back")} width={16} height={16} /></FocusTarget>
        </View>
        <Show when={panel() === "menu"}>
          <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
            <View class="flex-col gap-2">
              <Action label={message("menu.continue")} icon="book" quiet onPress={closePanel} autoFocus />
              <Show when={!props.replayMode}>
                <Action label={message("menu.save")} icon="save" quiet onPress={() => openPanel("save")} />
                <Show when={props.storage}><Action label={message("slot.quickSave")} icon="download" quiet disabled={busy()} onPress={() => { void save("quick", true); }} /></Show>
                <Action label={message("menu.load")} icon="envelope" quiet onPress={() => openPanel("load")} />
              </Show>
              <Action label={message("menu.log")} icon="wave" quiet onPress={() => openPanel("log")} />
              <Action label={message("menu.settings")} icon="settings" quiet onPress={() => openPanel("settings")} />
              <Show when={props.inventory}><Action label={message("panel.inventory")} icon="book" quiet onPress={() => openPanel("inventory")} /></Show>
              <Show when={collections().length > 0}><Action label={message("panel.collections")} icon="book" quiet onPress={() => openPanel("collections")} /></Show>
              <Show when={!props.replayMode}>
                <Action label={message("menu.gallery")} icon="gallery" quiet onPress={() => openPanel("gallery")} />
                <Action label={message("menu.title")} icon="home" quiet onPress={() => { setTitleScreen(true); setPanel("none"); resumeAfterPanel = false; }} />
              </Show>
            </View>
          </ScrollablePage>
        </Show>
        <Show when={pendingSlotAction()}>{action => {
          const text = () => wrapTextLines(pendingSlotMessage(action()), Math.max(1, Math.floor((panelContentWidth() - 16) / 7)), panelContentWidth() - 16, 1);
          const height = () => 68 + text().split("\n").length * 16;
          return <View class="relative flex-col gap-2 p-2 overflow-hidden" style={{ width: panelContentWidth(), height: height() }}>
          <SkinBackground width={panelContentWidth()} height={height()} border={16} debugName="vn-slot-confirm-skin" />
          <Text class="text-xs text-[#F5ECD9]">{text()}</Text>
          <View class="flex-row gap-2">
            <CompactAction label={message("slot.confirm")} skinWidth={compactPairWidth(16)} disabled={busy()} onPress={() => { void confirmPendingSlotAction(); }} />
            <CompactAction label={message("slot.cancel")} skinWidth={compactPairWidth(16)} disabled={busy()} onPress={() => setPendingSlotAction(null)} />
          </View>
        </View>;
        }}</Show>
        <Show when={panel() === "save" || panel() === "load"}>
          <Text class="text-xs text-[#9EB2B5]">{panel() === "save" ? message("save.hint") : message("load.hint")}</Text>
          <Show when={slotDataStatus() === "loading"}><Text class="text-xs text-[#9EB2B5]">{message("slot.loading")}</Text></Show>
          <Show when={panel() === "save"}>
            <Action images={props.slotImages} thumbnail={slotSummaries().quick?.thumbnail} debugName="vn-slot-quick-save" label={message("slot.quickSave")} icon="download" quiet detail={slotSummaries().quick?.text ?? message("slot.loading")} disabled={!props.storage || busy()} onPress={() => { void save("quick", true); }} />
          </Show>
          <Show when={panel() === "load"}>
            <Action images={props.slotImages} thumbnail={slotSummaries().auto?.thumbnail} debugName="vn-slot-auto-load" label={slotLabel("auto")} icon="envelope" quiet detail={slotSummaries().auto?.text ?? message("slot.loading")} disabled={!props.storage || busy() || !slotDataReady() || !slotExists("auto")} onPress={() => { void load("auto"); }} />
            <Action images={props.slotImages} thumbnail={slotSummaries().quick?.thumbnail} debugName="vn-slot-quick-load" label={slotLabel("quick")} icon="envelope" quiet detail={slotSummaries().quick?.text ?? message("slot.loading")} disabled={!props.storage || busy() || !slotDataReady() || !slotExists("quick")} onPress={() => { void load("quick"); }} />
          </Show>
          <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
            <View class="flex-col gap-2 pb-2">
              <For each={visibleSlots()}>{slot => <Action
                images={props.slotImages}
                thumbnail={slotSummaries()[slot]?.thumbnail}
                debugName={`vn-slot-${slot}`}
                label={slotLabel(slot)}
                detail={slotSummaries()[slot]?.text ?? message("slot.loading")}
                icon={panel() === "save" ? "save" : "envelope"}
                quiet
                disabled={!props.storage || busy() || !slotDataReady() || panel() === "load" && !slotExists(slot)}
                onPress={() => { if (panel() === "save") void save(slot); else void load(slot); }}
              />}</For>
              <Show when={slotListOverflow() > 0}><Text class="text-xs text-[#9EB2B5]">{message("slot.listLimited", { count: slotListOverflow() })}</Text></Show>
            </View>
          </ScrollablePage>
          <View class="flex-row gap-2">
            <CompactAction label={message("slot.previousPage")} skinWidth={pageActionWidth()} disabled={busy() || !slotDataReady() || slotPage() === 0} onPress={() => changeSlotPage(-1)} />
            <Text class="text-xs text-[#9EB2B5]" style={{ width: 100 }}>{message("slot.page", { current: slotPage() + 1, total: slotPageCount() })}</Text>
            <CompactAction label={message("slot.nextPage")} skinWidth={pageActionWidth()} disabled={busy() || !slotDataReady() || slotPage() + 1 >= slotPageCount()} onPress={() => changeSlotPage(1)} />
          </View>
          <Show when={slotManagementAvailable()}><Action label={message("slot.manage")} icon="settings" quiet disabled={busy() || !slotDataReady()} onPress={() => openSlotManagement(panel() as "save" | "load")} /></Show>
        </Show>
        <Show when={panel() === "slots"}>
          <Text class="text-xs text-[#9EB2B5]">{message("slot.manageHint")}</Text>
          <Show when={slotDataStatus() === "loading"}><Text class="text-xs text-[#9EB2B5]">{message("slot.loading")}</Text></Show>
          <Show when={selectedSlot()}>{slot => <Text class="text-xs text-[#DBBD80]">{message("slot.selected", { slot: slot() })}</Text>}</Show>
          <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
            <View class="flex-col gap-2 pb-2">
              <For each={visibleSlots()}>{slot => <Action
                images={props.slotImages}
                thumbnail={slotSummaries()[slot]?.thumbnail}
                debugName={`vn-slot-${slot}`}
                label={slotLabel(slot)}
                detail={selectedSlot() === slot ? message("slot.selectedShort") : slotSummaries()[slot]?.text ?? message("slot.loading")}
                icon="save"
                quiet
                disabled={busy() || !slotDataReady() || !slotExists(slot)}
                onPress={() => { setSelectedSlot(slot); setNotice(""); }}
              />}</For>
              <View class="relative" style={{ width: panelContentWidth(), height: 44 }}>
                <SkinBackground width={panelContentWidth()} height={44} border={10} debugName="vn-slot-input-skin" />
                <InputField
                  value={slotIdDraft}
                  onInput={value => {
                    const bounded = value.slice(0, 256);
                    setSlotIdDraft(bounded.length > 0 && /[\uD800-\uDBFF]/.test(bounded.at(-1)!) ? bounded.slice(0, -1) : bounded);
                  }}
                  placeholder={message("slot.idPlaceholder")}
                  appearance={{
                    textColor: "#F5ECD9",
                    placeholderColor: "#9EB2B5",
                    fillColor: "transparent",
                    borderColor: "transparent",
                    focusedBorderColor: "transparent",
                    borderRadius: 0,
                    fontSize: 14,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                  }}
                />
              </View>
              <Action label={message("slot.create")} icon="save" quiet disabled={busy() || !slotDataReady() || !slotIdDraft().trim()} onPress={createSlot} />
              <View class="flex-row gap-2">
                <CompactAction label={message("slot.copy")} skinWidth={compactPairWidth()} disabled={busy() || !slotDataReady() || !selectedSlot() || !props.storage?.copy} onPress={() => copyOrMoveSlot("copy")} />
                <CompactAction label={message("slot.move")} skinWidth={compactPairWidth()} disabled={busy() || !slotDataReady() || !selectedSlot() || !props.storage?.move} onPress={() => copyOrMoveSlot("move")} />
              </View>
              <View class="flex-row gap-2">
                <CompactAction label={message("slot.swap")} skinWidth={compactPairWidth()} disabled={busy() || !slotDataReady() || !selectedSlot() || !props.storage?.swap} onPress={swapSlot} />
                <CompactAction label={message("slot.delete")} skinWidth={compactPairWidth()} disabled={busy() || !slotDataReady() || !selectedSlot() || !props.storage?.delete} onPress={requestDeleteSlot} />
              </View>
              <Show when={slotListOverflow() > 0}><Text class="text-xs text-[#9EB2B5]">{message("slot.listLimited", { count: slotListOverflow() })}</Text></Show>
            </View>
          </ScrollablePage>
          <View class="flex-row gap-2">
            <CompactAction label={message("slot.previousPage")} skinWidth={pageActionWidth()} disabled={busy() || !slotDataReady() || slotPage() === 0} onPress={() => changeSlotPage(-1)} />
            <Text class="text-xs text-[#9EB2B5]" style={{ width: 100 }}>{message("slot.page", { current: slotPage() + 1, total: slotPageCount() })}</Text>
            <CompactAction label={message("slot.nextPage")} skinWidth={pageActionWidth()} disabled={busy() || !slotDataReady() || slotPage() + 1 >= slotPageCount()} onPress={() => changeSlotPage(1)} />
          </View>
        </Show>
        <Show when={panel() === "log"}>
          <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
            <View class="flex-col gap-2">
              <For each={visibleLog()}>{entry => {
                const [richHeight, setRichHeight] = createSignal(0);
                const body = () => wrapTextLines(entry.text, Math.max(1, Math.floor((panelContentWidth() - 48) / 8)), panelContentWidth() - 48, 1);
                const height = () => 52 + (entry.rich ? richHeight() : body().split("\n").length * 20);
                return <View class="relative flex-col gap-2 p-2 overflow-hidden" style={{ width: panelContentWidth(), height: height() }}>
                  <SkinBackground width={panelContentWidth()} height={height()} border={16} opacity={0.18} debugName={`vn-log-entry-${entry.lineId}-skin`} />
                  <Text class="text-xs text-[#DBBD80]">{entry.speaker ?? message("player.narrator")}</Text>
                  <Show when={entry.rich} fallback={<Text class="text-sm text-[#F5ECD9]">{body()}</Text>}>{rich =>
                    <NovelRichTextView text={entry.text} rich={rich()} revealedCharacters={Array.from(entry.text).length} width={Math.max(1, panelContentWidth() - 48)} debugName={`vn-log-rich-${entry.sequence}`} onLink={spanId => openHistoricalNote(entry.sequence, spanId)} onHeight={setRichHeight} />
                  }</Show>
                </View>;
              }}</For>
            </View>
          </ScrollablePage>
          <Action label={message("log.older")} icon="rewind" quiet onPress={() => { if ((logPage() + 1) * 4 < snapshot().backlog.length) setLogPage(logPage() + 1); }} />
          <Action label={message("log.newer")} icon="skip" quiet onPress={() => setLogPage(Math.max(0, logPage() - 1))} />
        </Show>
        <Show when={panel() === "note"}>
          <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
            <View class="flex-col gap-4 p-2" style={{ width: Math.max(1, panelContentWidth() - 16) }}>
              <Show when={currentNote()} fallback={<Text class="text-sm text-[#C7C4B6]">{message("note.unavailable")}</Text>}>{note => <>
                <Text class="text-base font-bold text-[#FFE1A3]">{wrapTextLines(note().title, 30, Math.max(1, panelContentWidth() - 32), 9)}</Text>
                <Text class="text-sm text-[#F5ECD9]">{wrapTextLines(note().text, 30, Math.max(1, panelContentWidth() - 32), 1)}</Text>
              </>}</Show>
            </View>
          </ScrollablePage>
        </Show>
        <Show when={panel() === "settings"}>
          <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
            <View class="flex-col gap-1 pb-1">
              <Action label={message("settings.textSpeed", { speed: snapshot().preferences.textSpeedCharsPerSecond === 0 ? message("settings.textSpeedInstant") : snapshot().preferences.textSpeedCharsPerSecond })} icon="quill" quiet detail={message("settings.textSpeedHelp", { slow: message("settings.textSpeedSlow"), standard: message("settings.textSpeedStandard"), fast: message("settings.textSpeedFast"), instant: message("settings.textSpeedInstant") })} onPress={() => { const speeds = [18, 32, 60, 0]; props.engine.setPreferences({ textSpeedCharsPerSecond: speeds[(speeds.indexOf(snapshot().preferences.textSpeedCharsPerSecond) + 1) % speeds.length] }); }} />
              <Action label={message("settings.autoDelay", { seconds: snapshot().preferences.autoDelayMs / 1000 })} icon="play" quiet onPress={() => props.engine.setPreferences({ autoDelayMs: snapshot().preferences.autoDelayMs >= 4000 ? 1500 : snapshot().preferences.autoDelayMs + 500 })} />
              <Show when={props.audioMix && props.onAudioMixChange} fallback={<Action label={message(props.muted ? "settings.muted" : "settings.unmuted")} icon="wave" quiet onPress={() => props.onMute?.(!props.muted)} disabled={!props.onMute} />}>
                <>
                  <MixAction group="master" label={message("settings.audio.master", { percent: Math.round((props.audioMix?.master ?? 0) * 100) })} value={props.audioMix?.master ?? 0} onChange={(group, value) => props.onAudioMixChange?.(group, value)} />
                  <MixAction group="music" label={message("settings.audio.music", { percent: Math.round((props.audioMix?.music ?? 0) * 100) })} value={props.audioMix?.music ?? 0} onChange={(group, value) => props.onAudioMixChange?.(group, value)} />
                  <MixAction group="effects" label={message("settings.audio.effects", { percent: Math.round((props.audioMix?.effects ?? 0) * 100) })} value={props.audioMix?.effects ?? 0} onChange={(group, value) => props.onAudioMixChange?.(group, value)} />
                  <MixAction group="voice" label={message("settings.audio.voice", { percent: Math.round((props.audioMix?.voice ?? 0) * 100) })} value={props.audioMix?.voice ?? 0} onChange={(group, value) => props.onAudioMixChange?.(group, value)} />
                </>
              </Show>
              <Show when={props.onTextSoundsEnabledChange}>
                <TextSoundsAction enabled={props.textSoundsEnabled ?? false} label={message(props.textSoundsEnabled ? "settings.textSounds.on" : "settings.textSounds.off")} onChange={enabled => props.onTextSoundsEnabledChange?.(enabled)} />
              </Show>
              <Show when={props.onLocale && localeChoices().length > 1}>
                <Show when={!props.replayMode}><Action label={message("settings.locale", { language: localeLabel() })} icon="book" quiet detail={message("settings.localeHelp")} onPress={() => props.onLocale?.(nextLocale())} /></Show>
              </Show>
              <Text class="text-xs text-[#9EB2B5]">{props.audioStatus ?? message("settings.hostAudio")}</Text>
              <Text class="text-xs text-[#9EB2B5]">{wrapTextLines(message("settings.readingPolicy"), 25, 310, 0)}</Text>
            </View>
          </ScrollablePage>
        </Show>
        <Show when={panel() === "gallery"}>
          <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
            <View class="flex-col gap-3 pb-3">
              <Text class="text-xs text-[#9EB2B5]">{message("gallery.count", { count: snapshot().meta.cgIds.length, total: Object.keys(props.assets.cgs).length })}</Text>
              <Show when={galleryShowsUnlocked()}><For each={galleryPageEntries()}>{galleryCard}</For></Show>
              <Show when={(props.replayEntries?.length ?? 0) > 0}>
                <Text class="text-xs text-[#DBBD80] mt-2">{message("gallery.replaySection")}</Text>
                <For each={props.replayEntries ?? []}>{(entry, index) => {
                  const unlocked = (): boolean => !entry.unlockEndingId || snapshot().meta.endingIds.includes(entry.unlockEndingId);
                  return <Action
                    label={message("gallery.replay", { title: entry.title })}
                    detail={unlocked() ? undefined : message("gallery.replayLocked")}
                    disabled={!unlocked() || !props.onReplayStart}
                    autoFocus={index() === 0}
                    debugName={`vn-replay-${entry.id}`}
                    icon="play"
                    quiet
                    onPress={() => props.onReplayStart?.(entry.id)}
                  />;
                }}</For>
              </Show>
              <Show when={heardMusicIds().length > 0 && props.onMusicPreviewPlay}>
                <Text class="text-xs text-[#DBBD80] mt-2">{message("gallery.musicSection")}</Text>
                <For each={heardMusicIds()}>{(cue, index) => {
                  const selected = (): boolean => musicPreviewCue() === cue;
                  const title = (): string => props.musicTitles?.[cue] ?? cue;
                  return <Action
                    label={message(selected() ? "gallery.stopMusicPreview" : "gallery.previewMusic", { title: title() })}
                    autoFocus={index() === 0 && (props.replayEntries?.length ?? 0) === 0}
                    debugName={`vn-music-preview-${cue}`}
                    icon="wave"
                    quiet
                    onPress={() => {
                      if (selected()) stopMusicPreview();
                      else {
                        props.onMusicPreviewPlay?.(cue);
                        setMusicPreviewCue(cue);
                      }
                    }}
                  />;
                }}</For>
              </Show>
              <Show when={!galleryShowsUnlocked() && lockedGalleryEntries().length > 0}>
                <Text class="text-xs text-[#DBBD80] mt-2">{message("gallery.notCollected")}</Text>
                <For each={galleryPageEntries()}>{galleryCard}</For>
              </Show>
              <Show when={galleryPageCount() > 1}>
                <Action label={message("gallery.nextPage")} icon="gallery" quiet onPress={() => setGalleryPage((currentGalleryPage() + 1) % galleryPageCount())} />
              </Show>
            </View>
          </ScrollablePage>
        </Show>
        <Show when={panel() === "inventory" && props.inventory}>
          <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
            <View class="flex-col gap-3 pb-3">
            <Text class="text-sm text-[#DBBD80] shrink-0" style={{ width: panelContentWidth(), height: inventoryBalance().split("\n").length * 20 }}>{inventoryBalance()}</Text>
            <Show when={selectedInventoryItem()} fallback={
              <View class="flex-col gap-2 pb-3"><For each={inventoryPageRows()}>{([id, item]) => <Action
                label={inventoryText(id, "title", item.title)} detail={`${message("inventory.quantity", { count: inventoryCount(item.quantityVariable) })} · ${message("inventory.prices", { buy: item.buyPrice, sell: item.sellPrice ?? message("inventory.notSellable") })}`}
                icon="book" quiet debugName={`vn-inventory-${id}`} onPress={() => setInventorySelection(id)}
              />}</For></View>
            }>{selected => {
              const width = () => Math.max(1, panelContentWidth() - 32);
              const title = () => wrapTextLines(inventoryText(selected().id, "title", selected().value.title), Math.max(1, Math.floor(width() / 8)), width(), 1);
              const body = () => wrapTextLines(inventoryText(selected().id, "body", selected().value.body), Math.max(1, Math.floor(width() / 8)), width(), 1);
              const prices = () => wrapTextLines(message("inventory.prices", { buy: selected().value.buyPrice, sell: selected().value.sellPrice ?? message("inventory.notSellable") }), Math.max(1, Math.floor(width() / 7)), width(), 0);
              return <View class="flex-col gap-3 pb-3 items-center" style={{ width: panelContentWidth() }}>
                <Text class="text-sm text-[#E4CF9E] shrink-0" style={{ width: width(), height: title().split("\n").length * 20 }}>{title()}</Text>
                <Text class="text-sm text-[#DBBD80]">{message("inventory.quantity", { count: inventoryCount(selected().value.quantityVariable) })}</Text>
                <Text class="text-xs text-[#9EB2B5] shrink-0" style={{ width: width(), height: prices().split("\n").length * 16 }}>{prices()}</Text>
                <Show when={selected().value.maxQuantity !== undefined}><Text class="text-xs text-[#9EB2B5]">{message("inventory.limit", { count: selected().value.maxQuantity! })}</Text></Show>
                <Text class="text-sm text-[#F5ECD9] shrink-0" style={{ width: width(), height: body().split("\n").length * 20 }}>{body()}</Text>
                <Action label={message("inventory.list")} icon="back" quiet onPress={() => setInventorySelection(null)} />
              </View>;
            }}</Show>
            </View>
          </ScrollablePage>
          <Show when={!selectedInventoryItem() && inventoryPageCount() > 1}><Action label={message("inventory.next", { page: currentInventoryPage() + 1, total: inventoryPageCount() })} icon="book" quiet onPress={() => setInventoryPage((currentInventoryPage() + 1) % inventoryPageCount())} /></Show>
        </Show>
        <Show when={panel() === "collections"}>
          <ScrollablePage class="flex-1 w-full min-h-[0] overflow-hidden">
            <Show when={selectedCollectionEntry()} fallback={
              <View class="flex-col gap-3 pb-3">
                <For each={visibleCollections()}>{([collectionId, collection]) => <View class="flex-col gap-2">
                  <Text class="text-sm text-[#DBBD80]">{wrapTextLines(collectionText(novelCollectionTextKey(collectionId, null), collection.title), Math.max(1, Math.floor(panelContentWidth() / 8)), panelContentWidth(), 1)}</Text>
                  <Text class="text-xs text-[#9EB2B5]">{message("collections.count", { count: Object.values(collection.entries).filter(entry => isNovelCollectionEntryUnlocked(entry, snapshot().variables)).length, total: Object.keys(collection.entries).length })}</Text>
                  <For each={collectionPageRows().filter(row => row.collectionId === collectionId)}>{({ entryId, entry }) => <Action
                    label={collectionText(novelCollectionTextKey(collectionId, entryId), entry.title)}
                    detail={isNovelCollectionEntryUnlocked(entry, snapshot().variables) ? undefined : message("collections.locked")}
                    disabled={!isNovelCollectionEntryUnlocked(entry, snapshot().variables)}
                    debugName={`vn-collection-${collectionId}-${entryId}`}
                    icon="book" quiet
                    onPress={() => setCollectionSelection({ collection: collectionId, entry: entryId })}
                  />}</For>
                </View>}</For>
              </View>
            }>{selected => {
              const entry = () => selected().value;
              const width = () => Math.max(1, panelContentWidth() - 32);
              const title = () => wrapTextLines(collectionText(novelCollectionTextKey(selected().collection, selected().entry), entry().title), Math.max(1, Math.floor(width() / 8)), width(), 1);
              const body = () => wrapTextLines(collectionText(novelCollectionTextKey(selected().collection, selected().entry, "body"), entry().body), Math.max(1, Math.floor(width() / 8)), width(), 1);
              const portrait = () => resolveNovelCollectionPortrait(entry(), props.assets.characters);
              const portraitHeight = () => Math.min(220, Math.max(120, layout().height * 0.3));
              return <View class="flex-col gap-3 pb-3 items-center" style={{ width: panelContentWidth() }}>
                <Text class="text-sm text-[#E4CF9E] shrink-0" style={{ width: width(), height: title().split("\n").length * 20 }}>{title()}</Text>
                <Show when={portrait()}>{source => <View class="relative overflow-hidden shrink-0" style={{ width: width(), height: portraitHeight() }}>
                  <SkinBackground width={width()} height={portraitHeight()} border={16} debugName="vn-collection-portrait-skin" />
                  <Image src={source()} class="absolute" style={imageBoundsStyle(novelImageContainBounds(width(), portraitHeight(), props.assets.imageDimensions?.[source()]))} />
                </View>}</Show>
                <Text class="text-sm text-[#F5ECD9] shrink-0" style={{ width: width(), height: body().split("\n").length * 20 }}>{body()}</Text>
                <Action label={message("collections.list")} icon="back" quiet onPress={() => setCollectionSelection(null)} />
              </View>;
            }}</Show>
          </ScrollablePage>
          <Show when={!selectedCollectionEntry() && collectionPageCount() > 1}><Action label={message("collections.next", { page: currentCollectionPage() + 1, total: collectionPageCount() })} icon="book" quiet onPress={() => setCollectionPage((currentCollectionPage() + 1) % collectionPageCount())} /></Show>
        </Show>
        <Show when={notice()}><View class="relative p-2 overflow-hidden" style={{ width: panelContentWidth(), height: 48 }}><SkinBackground width={panelContentWidth()} height={48} border={14} debugName="vn-panel-notice-skin" /><Text class="text-xs text-[#F0B78F]">{wrapTextLines(notice(), Math.max(1, Math.floor((panelContentWidth() - 32) / 7)), panelContentWidth() - 32, 1)}</Text></View></Show>
        </View>
      </View>
      </FocusScope>
    </Show>
    <Show when={capturingSlotImage()}><Focusable class="absolute inset-0" debugName="vn-slot-capture-input-block" onPress={() => {}} /></Show>
    <Show when={notice() && panel() === "none"}><View class="absolute p-2 overflow-hidden" style={{ insetL: 22, insetR: 22, insetB: 12, width: Math.max(1, layout().width - 44), height: 52 }}><SkinBackground width={Math.max(1, layout().width - 44)} height={52} border={14} debugName="vn-notice-skin" /><Text class="text-xs text-[#F0B78F]">{wrapTextLines(notice(), Math.max(1, Math.floor((layout().width - 68) / 7)), layout().width - 68, 1)}</Text></View></Show>
    </View>
  </View></NovelSkinContext.Provider>;
}
