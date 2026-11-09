/** JSON values accepted by story variables and persisted save data. */
import type { NovelVoicePlaybackFact, NovelVoicePlaybackState } from "./voice.ts";
export type { NovelVoicePlaybackFact, NovelVoicePlaybackState, NovelVoiceStatus } from "./voice.ts";
import type {
  NovelVideoInstruction,
  NovelVideoOverlayState,
  NovelVideoPlaybackFact,
} from "./video-schema.ts";
export type { NovelVideoInstruction, NovelVideoOverlayState, NovelVideoPlaybackFact } from "./video-schema.ts";
import type { NovelInventory, NovelTradeInstruction } from "./inventory.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Host-owned immutable PNG captured for a save-slot summary. */
export interface NovelSlotThumbnail {
  readonly version: 1;
  /** Opaque host ID for the immutable app-private PNG. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface StoryDefinition {
  readonly id: string;
  readonly version: number;
  readonly start: string;
  /** Authoring-only layout; ignored by narrative execution and save cursors. */
  readonly editor?: NovelStoryEditorMetadata;
  /** Variable lifetimes and static defaults; undeclared variables use the `save` lifetime. */
  readonly variableDefinitions?: Readonly<Record<string, NovelVariableDefinition>>;
  /** Optional catalog; item quantities and currency are stored in declared save variables. */
  readonly inventory?: NovelInventory;
  /** Reusable multi-track scene animations keyed by authoring preset id. */
  readonly timelines?: Readonly<Record<string, NovelTimelineDefinition>>;
  /** Optional isolated replay entrypoints displayed by a consumer's gallery. */
  readonly replayEntries?: readonly NovelReplayEntry[];
  /** Each key is a label; instruction positions are zero based. */
  readonly script: Readonly<Record<string, readonly StoryInstruction[]>>;
}

export type NovelSayColorToken = "accent" | "muted" | "warning";

/** Semantic emphasis and color inputs; the renderer maps tokens to its registered slots. */
export interface NovelSayRichStyle {
  readonly color?: NovelSayColorToken;
  readonly emphasis?: "strong";
}

/** Inline annotation range uses Unicode code-point offsets into the canonical say.text. */
export interface NovelSaySpan {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly style?: NovelSayRichStyle;
  /** Short pronunciation text shown above the annotated range. */
  readonly ruby?: string;
  /** Internal note action. Links never contain URLs or executable code. */
  readonly link?: { readonly title: string; readonly text: string };
}

/** A local pause marker. Null duration waits for player input; positive duration uses the shared NovelClock. */
export interface NovelSayPause {
  readonly id: string;
  readonly at: number;
  readonly durationMs: number | null;
}

/** Optional inline annotations share the one canonical say.text source. */
export interface NovelSayRich {
  readonly spans: readonly NovelSaySpan[];
  readonly pauses: readonly NovelSayPause[];
}

/** Current local pause state saved with the active line and its rollback checkpoint. */
export interface NovelSayPauseState {
  readonly id: string;
  /** Null denotes an input-gated pause; timed pauses retain their real remaining milliseconds. */
  readonly remainingMs: number | null;
}

export interface NovelStoryEditorMetadata {
  readonly graph?: {
    readonly version: 1;
    /** World coordinates; absent labels use the editor's automatic layout. */
    readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  };
  /** Role and display title only; executable routes remain in `script`. */
  readonly blueprint?: NovelStoryBlueprintMetadata;
  /** Preserve unrelated editor metadata when changing the graph layout. */
  readonly [metadata: string]: unknown;
}

export type NovelBlueprintNodeKind = "entry" | "chapter" | "condition" | "choice" | "assignment" | "end";

export interface NovelBlueprintNodeMetadata {
  readonly kind: NovelBlueprintNodeKind;
  readonly title?: string;
}

export interface NovelStoryBlueprintMetadata {
  readonly version: 1;
  readonly nodes: Readonly<Record<string, NovelBlueprintNodeMetadata>>;
}

export type NovelVariableLifetime = "session" | "save" | "persistent";

export interface NovelVariableDefinition {
  readonly lifetime: NovelVariableLifetime;
  readonly defaultValue?: JsonValue;
  /** Authoring metadata is preserved by the story format but ignored by the engine. */
  readonly [metadata: string]: unknown;
}

export interface NovelReplayEntry {
  readonly id: string;
  readonly title: string;
  readonly location: ScriptPosition;
  /** If present, the replay is available only after this ending has been reached. */
  readonly unlockEndingId?: string;
  /** Other JSON authoring metadata is preserved but ignored by the engine. */
  readonly [metadata: string]: unknown;
}

export type ValueExpression =
  | { readonly type: "literal"; readonly value: JsonValue }
  | { readonly type: "variable"; readonly name: string };

export type Condition =
  | { readonly op: "truthy" | "falsy"; readonly value: ValueExpression }
  | {
      readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
      readonly left: ValueExpression;
      readonly right: ValueExpression;
    }
  | { readonly op: "and" | "or"; readonly conditions: readonly Condition[] }
  | { readonly op: "not"; readonly condition: Condition };

export type CharacterPosition =
  | "left"
  | "center"
  | "right"
  | { readonly x: number; readonly y: number };

export interface CharacterModelIntent {
  readonly key: string;
  readonly animation?: string;
  readonly loop?: boolean;
  readonly skin?: string;
  readonly expression?: string;
}

export interface SceneCharacterUpdate {
  readonly id: string;
  readonly expression?: string;
  readonly position?: CharacterPosition;
  readonly visible?: boolean;
  /** Uniform scale about the character's top-left corner, from 0.05 to 8. */
  readonly scale?: number;
  /** Clockwise degrees about the top-left corner, from -360 to 360. */
  readonly rotation?: number;
  /** Back-to-front order; ties retain character insertion order. */
  readonly layer?: number;
  /** Omitted keeps the model; null returns to the image expression. */
  readonly model?: CharacterModelIntent | null;
}

/** A normalized rectangle with its origin and extent in the 0..1 range. */
export interface NovelSceneObjectRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The existing variable-only story operations that a scene object may apply. */
export type NovelVariableInstruction =
  | {
      readonly type: "set";
      readonly variable: string;
      readonly value: JsonValue;
    }
  | { readonly type: "inc"; readonly variable: string; readonly amount: number };

export type NovelSceneObjectEffect = Extract<NovelVariableInstruction, { readonly type: "set" | "inc" }>;

export interface NovelSceneObjectInteraction {
  /** Human-readable label used by accessible controls and localized by the view. */
  readonly label: string;
  /** A small transaction of existing set/inc operations; no story route is executed. */
  readonly effects: readonly NovelSceneObjectEffect[];
  /** The interaction is offered only while this existing story condition is true. */
  readonly when?: Condition;
  /** Normalized rectangular hit region relative to the visible frame; omitted means the full frame. */
  readonly hit?: NovelSceneObjectRect;
}

/** A bounded, image-backed object placed directly on the visual novel stage. */
export interface NovelSceneObject {
  readonly id: string;
  /** Key in the consumer's existing background asset registry. */
  readonly image: string;
  /** Normalized position and clipping frame relative to the stage. */
  readonly frame: NovelSceneObjectRect;
  /** Optional contained display width/height ratio for the cropped image window. */
  readonly aspectRatio?: number;
  /** Normalized source-image window, positioned inside and clipped by `frame`. */
  readonly crop?: NovelSceneObjectRect;
  /** Back-to-front order; ties retain the authored declaration order. */
  readonly layer?: number;
  readonly interaction?: NovelSceneObjectInteraction;
}

export type RevealTransitionDirection = "left" | "right" | "up" | "down";

export type SceneTransition =
  | { readonly kind: "cut" | "fade" | "dissolve"; readonly durationMs: number }
  | { readonly kind: "reveal"; readonly durationMs: number; readonly direction?: RevealTransitionDirection };

/** Stage-space pan and zoom. Coordinates are logical pixels; scale is uniform around stage center. */
export interface NovelCameraTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export type NovelCameraEasing = "linear" | "easeInOut";

export type NovelTimelineEasing = NovelCameraEasing;

export interface NovelTimelineKeyframe {
  readonly atMs: number;
  /** Easing for the segment from the prior keyframe to this keyframe. */
  readonly easing?: NovelTimelineEasing;
}

export interface NovelTimelineCameraKeyframe extends NovelTimelineKeyframe {
  readonly value: NovelCameraTransform;
}

export interface NovelTimelineActorTransform {
  /** Logical stage pixels, matching the numeric scene character position form. */
  readonly position: { readonly x: number; readonly y: number };
  readonly scale: number;
  readonly rotation: number;
}

export interface NovelTimelineActorKeyframe extends NovelTimelineKeyframe {
  readonly value: NovelTimelineActorTransform;
}

export interface NovelTimelineActorTrack {
  readonly id: string;
  readonly keyframes: readonly NovelTimelineActorKeyframe[];
}

/** Optional authored routing for named story audio; voice remains a reserved channel. */
export type NovelAuthoredAudioGroup = "music" | "effects";

export interface NovelTimelineAudioCue {
  readonly atMs: number;
  readonly cue: string;
  readonly action?: "play" | "stop";
  readonly channel?: string;
  readonly loop?: boolean;
  readonly group?: NovelAuthoredAudioGroup;
}

export interface NovelTimelineAudioGainKeyframe extends NovelTimelineKeyframe {
  readonly value: number;
}

export interface NovelTimelineAudioGainTrack {
  readonly channel: string;
  readonly keyframes: readonly NovelTimelineAudioGainKeyframe[];
}

export interface NovelTimelineDefinition {
  readonly durationMs: number;
  readonly camera?: readonly NovelTimelineCameraKeyframe[];
  readonly actors?: readonly NovelTimelineActorTrack[];
  readonly audio?: readonly NovelTimelineAudioCue[];
  readonly audioGains?: readonly NovelTimelineAudioGainTrack[];
}

/** Canonical elapsed time for a story-owned timeline preset. */
export interface NovelTimelineState {
  readonly id: string;
  readonly elapsedMs: number;
}

export interface NovelCameraShake {
  /** Peak stage-space displacement in logical pixels; fades to zero at both ends. */
  readonly amplitude: number;
  /** Whole oscillation cycles over the camera motion duration. */
  readonly cycles: number;
}

/** Authoring settings applied when a scene sets a camera target. */
export interface NovelCameraMotion {
  readonly durationMs: number;
  readonly easing?: NovelCameraEasing;
  readonly shake?: NovelCameraShake;
}

/** Canonical in-flight motion. The destination is the containing camera's x/y/scale. */
export interface NovelCameraMotionState {
  readonly from: NovelCameraTransform;
  readonly elapsedMs: number;
  readonly durationMs: number;
  readonly easing: NovelCameraEasing;
  readonly shake?: NovelCameraShake;
}

/** Saved target pose plus the deterministic progress needed to resolve its current pose. */
export interface StageCameraState extends NovelCameraTransform {
  readonly motion: NovelCameraMotionState | null;
}

/** A transparent image plane drawn over the scene's base background. */
export interface NovelBackgroundLayer {
  /** Stable key from the existing background asset registry. */
  readonly background: string;
  /** Fraction of the stage camera followed by this plane; 0 is fixed, 1 is full camera. */
  readonly parallax: number;
}

interface NovelInputInstructionFields {
  readonly type: "input";
  readonly id: string;
  readonly variable: string;
  readonly prompt?: string;
  readonly cancelTarget?: string;
}

export type NovelInputInstruction = NovelInputInstructionFields & (
  | {
      readonly inputType: "text";
      readonly placeholder?: string;
      readonly defaultValue?: string;
      readonly minLength?: number;
      readonly maxLength?: number;
    }
  | {
      readonly inputType: "number";
      readonly placeholder?: string;
      readonly defaultValue?: number;
      readonly min?: number;
      readonly max?: number;
      readonly integer?: boolean;
    }
  | {
      readonly inputType: "boolean";
      readonly defaultValue?: boolean;
    }
);

/** One of the three built-in layouts used by the shared say renderer. */
export type NovelSayPresentation = "dialogue" | "fullscreen" | "floating";

export type StoryInstruction =
  | {
      readonly type: "say";
      /** Stable and unique within this story; used by read/skip metadata. */
      readonly id: string;
      /** Optional visual layout for this line; omitted keeps the legacy dialogue panel. */
      readonly presentation?: NovelSayPresentation;
      readonly speaker?: string;
      readonly portrait?: string;
      /** Audio registry cue played for this line; auto mode waits for its real completion. */
      readonly voice?: string;
      /** Supports literal text and `{{variableName}}` interpolation. */
      readonly text: string;
      /** Optional stable inline annotation ranges measured against this canonical text. */
      readonly rich?: NovelSayRich;
    }
  | {
      readonly type: "scene";
      /** Omitted keeps the current background; null clears it. */
      readonly background?: string | null;
      /** Omitted preserves the current overlay planes; [] removes them. Array order is back-to-front. */
      readonly backgroundLayers?: readonly NovelBackgroundLayer[];
      readonly characters?: readonly SceneCharacterUpdate[];
      readonly remove?: readonly string[];
      /** Omitted preserves the current objects; [] clears them; otherwise replaces the object set. */
      readonly objects?: readonly NovelSceneObject[];
      readonly transition?: SceneTransition;
      /** Omitted preserves the current camera. Without cameraMotion, setting it is immediate. */
      readonly camera?: NovelCameraTransform;
      /** Camera movement can run independently of the scene fade/dissolve. Requires camera. */
      readonly cameraMotion?: NovelCameraMotion;
      /** Starts a reusable timeline preset; omitted or null interrupts the current one. */
      readonly timeline?: string | null;
    }
  | {
      readonly type: "audio";
      readonly cue: string;
      readonly action?: "play" | "stop";
      readonly channel?: string;
      readonly loop?: boolean;
      readonly group?: NovelAuthoredAudioGroup;
    }
  | { readonly type: "wait"; readonly durationMs: number }
  | NovelVariableInstruction
  | {
      readonly type: "branch";
      readonly when: Condition;
      readonly then: string;
      readonly else: string;
    }
  | { readonly type: "jump"; readonly target: string }
  | { readonly type: "call"; readonly target: string }
  | { readonly type: "return" }
  | {
      readonly type: "choice";
      readonly id: string;
      readonly prompt?: string;
      readonly options: readonly ChoiceOptionDefinition[];
      readonly timeLimitMs?: number;
      /** Label selected when the timer expires. */
      readonly timeoutTarget?: string;
    }
  | NovelInputInstruction
  | NovelTradeInstruction
  | NovelVideoInstruction
  | { readonly type: "ending"; readonly id: string; readonly text?: string; readonly cg?: string };

export interface ChoiceOptionDefinition {
  readonly id: string;
  readonly text: string;
  readonly target: string;
  readonly when?: Condition;
}

export type NovelMode = "manual" | "auto" | "skip";

export interface NovelPreferences {
  readonly mode: NovelMode;
  readonly textSpeedCharsPerSecond: number;
  readonly autoDelayMs: number;
  readonly skipSeenOnly: boolean;
}

export interface NovelEngineOptions {
  readonly initialVariables?: Readonly<Record<string, JsonValue>>;
  readonly initialMeta?: NovelMetaState;
  readonly preferences?: Partial<NovelPreferences>;
  readonly maxBacklogEntries?: number;
  readonly maxRollbackEntries?: number;
  readonly maxStepBudget?: number;
}

export interface ScriptPosition {
  readonly label: string;
  readonly index: number;
}

export interface StageCharacter {
  readonly id: string;
  readonly expression: string;
  readonly position: CharacterPosition;
  readonly visible: boolean;
  readonly scale?: number;
  readonly rotation?: number;
  readonly layer?: number;
  readonly model?: CharacterModelIntent;
}

export type StageTransitionState = SceneTransition & {
  readonly id: number;
  readonly elapsedMs: number;
  /** One previous composition, without another transition or runtime state. */
  readonly from?: StageComposition;
};

export interface StageComposition {
  readonly background: string | null;
  /** Optional additive overlay planes; omitted keeps legacy saves compact. */
  readonly backgroundLayers?: readonly NovelBackgroundLayer[];
  readonly characters: Readonly<Record<string, StageCharacter>>;
  /** The object declaration currently composed on the stage. */
  readonly objects?: readonly NovelSceneObject[];
  /** The frozen pose used to paint a previous composition during scene transitions. */
  readonly camera?: NovelCameraTransform;
}

export interface StageState extends StageComposition {
  readonly transition: StageTransitionState | null;
  /** Runtime cursor only; the immutable definition stays in the story catalog. */
  readonly timeline?: NovelTimelineState | null;
  /** The one bundled, muted VN video overlay; null means closed. */
  readonly video: NovelVideoOverlayState | null;
  readonly camera: StageCameraState;
}

export interface SayState {
  readonly kind: "say";
  readonly location: ScriptPosition;
  readonly id: string;
  /** Derived from the active story instruction for rendering; never persisted in save state. */
  readonly presentation?: NovelSayPresentation;
  readonly speaker: string | null;
  readonly portrait: string | null;
  readonly text: string;
  /** Active locale/interpolation ranges resolved against `text`; absent in legacy saves. */
  readonly rich?: NovelSayRich;
  /** Index of the first pause marker not yet consumed. */
  readonly pauseCursor?: number;
  /** Current timed or manual pause, if reveal is stopped at that marker. */
  readonly pause?: NovelSayPauseState | null;
  /** Fractional code-point progress; visibleText and complete are derived. */
  readonly revealProgress: number;
  readonly visibleText: string;
  readonly revealedCharacters: number;
  readonly complete: boolean;
  readonly autoRemainingMs: number | null;
}

export interface ChoiceOptionState {
  readonly id: string;
  readonly text: string;
  readonly target: string;
}

export interface ChoiceState {
  readonly kind: "choice";
  readonly location: ScriptPosition;
  readonly id: string;
  readonly prompt: string | null;
  readonly options: readonly ChoiceOptionState[];
  readonly timeRemainingMs: number | null;
}

export type NovelInputValidationCode = "required" | "tooShort" | "tooLong" | "number" | "integer" | "min" | "max";

export interface NovelInputValidationError {
  readonly code: NovelInputValidationCode;
  /** The violated text length or numeric bound; omitted for required/format/integer errors. */
  readonly limit?: number;
}

export interface InputState {
  readonly kind: "input";
  readonly location: ScriptPosition;
  readonly id: string;
  readonly variable: string;
  readonly inputType: "text" | "number" | "boolean";
  readonly prompt: string | null;
  readonly placeholder: string | null;
  readonly draft: string | boolean;
  readonly canCancel: boolean;
  readonly error: NovelInputValidationError | null;
}

export interface WaitState {
  readonly kind: "wait";
  readonly location: ScriptPosition;
  readonly durationMs: number;
  readonly remainingMs: number;
}

export interface EndingState {
  readonly kind: "ending";
  readonly location: ScriptPosition;
  readonly id: string;
  readonly text: string;
  readonly cg: string | null;
}

export type ActiveNovelState = SayState | ChoiceState | InputState | WaitState | EndingState;

export interface BacklogEntry {
  readonly sequence: number;
  readonly lineId: string;
  readonly location: ScriptPosition;
  readonly speaker: string | null;
  readonly portrait: string | null;
  readonly text: string;
  /** Resolved inline annotations captured when this line completed; absent in legacy saves. */
  readonly rich?: NovelSayRich;
}

export interface NovelMetaState {
  /** Read line IDs survive rollback and are used by seen-only skip. */
  readonly readLineIds: readonly string[];
  readonly endingIds: readonly string[];
  readonly cgIds: readonly string[];
  /** Music cues played by an authored `audio` instruction on the `music` channel. */
  readonly musicIds?: readonly string[];
  /** Canonical values for persistent variables. Omitted in legacy metadata. */
  readonly persistentVariables?: Readonly<Record<string, JsonValue>>;
}

/** Last requested per-channel audio intent, never a playback success report. */
export interface NovelAudioIntent {
  readonly action: "play" | "stop";
  readonly cue: string;
  readonly loop: boolean;
  /** Explicit authored music/effects routing; absent values keep legacy channel routing. */
  readonly group?: NovelAuthoredAudioGroup;
  /** Current normalized gain for a play intent; omitted means 1. */
  readonly gain?: number;
}

/** Reversible gameplay state captured at completed dialogue lines. */
export interface RollbackCheckpoint {
  readonly location: ScriptPosition;
  /** Session/save values only; persistent values remain in `meta.persistentVariables`. */
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly stage: StageState;
  readonly active: ActiveNovelState;
  readonly callStack: readonly CallStackFrame[];
  /** Cursor into the one bounded canonical backlog, not a copied log. */
  readonly backlogSequence: number;
  readonly audioIntents: Readonly<Record<string, NovelAudioIntent>>;
}

export interface CallStackFrame {
  readonly returnTo: ScriptPosition;
}

export interface EngineSnapshot {
  readonly storyId: string;
  readonly storyVersion: number;
  readonly phase: "ready" | "say" | "choice" | "input" | "wait" | "ending" | "disposed";
  readonly started: boolean;
  readonly paused: boolean;
  /** Next instruction to execute; `active.location` identifies a blocking instruction. */
  readonly location: ScriptPosition;
  /** Effective projection: static seeds, session/save runtime values and persistent meta. */
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly stage: StageState;
  readonly audioIntents: Readonly<Record<string, NovelAudioIntent>>;
  /** Current line playback facts; deliberately absent from NovelSaveData. */
  readonly voice: NovelVoicePlaybackState | null;
  /** Ephemeral identity for native video facts; deliberately absent from saves. */
  readonly videoToken: string | null;
  readonly active: ActiveNovelState | null;
  readonly callStack: readonly CallStackFrame[];
  readonly backlog: readonly BacklogEntry[];
  readonly meta: NovelMetaState;
  readonly preferences: NovelPreferences;
  readonly rollbackAvailable: number;
  readonly eventSequence: number;
}

export type EngineEvent =
  | {
      /** A request for the host's audio adapter; it does not imply playback succeeded. */
      readonly type: "audioCue";
      readonly sequence: number;
      readonly cue: string;
      readonly action: "play" | "stop";
      readonly channel: string | null;
      readonly loop: boolean;
      readonly group?: NovelAuthoredAudioGroup;
      readonly location: ScriptPosition;
    }
  | {
      /** Transient command to the existing native video adapter; never save data. */
      readonly type: "videoCue";
      readonly sequence: number;
      readonly action: NovelVideoInstruction["action"];
      readonly token: string;
      readonly cue: string;
      readonly loop: boolean;
      readonly positionMs?: number;
      readonly location: ScriptPosition;
    }
  | {
      /** A fully revealed internal note link; handled by JS UI, never persisted as gameplay history. */
      readonly type: "sayLink";
      readonly sequence: number;
      readonly lineId: string;
      readonly spanId: string;
      readonly title: string;
      readonly text: string;
      readonly location: ScriptPosition;
    };

export interface EngineUpdate {
  /** A complete immutable snapshot after the transaction. */
  readonly snapshot: EngineSnapshot;
  /** Events emitted by this transaction only; events are not save data. */
  readonly events: readonly EngineEvent[];
}

export interface EngineSubscribeOptions {
  /** Immediately send a complete snapshot with an empty event list. */
  readonly emitCurrent?: boolean;
}

export type EngineListener = (update: EngineUpdate) => void;

/** One operation that actually executed inside a committed engine transaction. */
export interface NovelExecutionTraceEntry {
  /** Authored instruction address, or the label end boundary for an implicit return. */
  readonly location: ScriptPosition;
  /** The authored operation type, or `implicitReturn` for a call that falls off its label. */
  readonly op: StoryInstruction["type"] | "implicitReturn";
  /** Authored stable instruction id when the instruction defines one. */
  readonly id?: string;
  /** Present only when the engine returned from a call at the end of a label. */
  readonly returnTo?: ScriptPosition;
}

/** Receives a chronological batch of actual operations after its transaction commits. */
export type NovelExecutionTraceListener = (entries: readonly NovelExecutionTraceEntry[]) => void;

export interface NovelSaveData {
  readonly format: "pocket-vn-save";
  readonly formatVersion: 1;
  readonly storyId: string;
  readonly storyVersion: number;
  readonly state: {
    readonly started: boolean;
    readonly location: ScriptPosition;
    /** Serialized session/save values; canonical persistent values are in meta. */
    readonly variables: Readonly<Record<string, JsonValue>>;
    readonly stage: StageState;
    readonly active: ActiveNovelState | null;
    readonly callStack: readonly CallStackFrame[];
    readonly backlog: readonly BacklogEntry[];
    readonly nextBacklogSequence: number;
    readonly rollbackHistory: readonly RollbackCheckpoint[];
    readonly meta: NovelMetaState;
    readonly audioIntents: Readonly<Record<string, NovelAudioIntent>>;
    readonly preferences: NovelPreferences;
    readonly paused: boolean;
    readonly eventSequence: number;
    readonly transitionSequence: number;
  };
}

/** V2 compact rollback history; V3 changes the active pool to compact tuples. */
export interface NovelCompressedRollbackHistory {
  readonly pools: {
    readonly variables: readonly Readonly<Record<string, JsonValue>>[];
    readonly stages: readonly StageState[];
    readonly active: readonly Extract<ActiveNovelState, { kind: "say" }>[];
    readonly audioIntents: readonly Readonly<Record<string, NovelAudioIntent>>[];
  };
  readonly entries: readonly NovelCompressedRollbackCheckpoint[];
}

/**
 * Compact fixed-width checkpoint tuple. Field names live here rather than in
 * every persisted JSON record; the order is part of save formats v2 and v3.
 */
export type NovelCompressedRollbackCheckpoint = readonly [
  /** Script label. */ label: string,
  /** Instruction index within label. */ index: number,
  /** Caller positions. */ callStack: readonly CallStackFrame[],
  /** Cursor into the one root backlog. */ backlogSequence: number,
  /** Index into pools.variables. */ variablesRef: number,
  /** Index into pools.stages. */ stageRef: number,
  /** Index into pools.active. */ activeRef: number,
  /** Index into pools.audioIntents. */ audioIntentsRef: number,
];

/** V2 save with unique rollback values stored once in indexed pools. */
export interface NovelSaveDataV2 {
  readonly format: "pocket-vn-save";
  readonly formatVersion: 2;
  readonly storyId: string;
  readonly storyVersion: number;
  readonly state: Omit<NovelSaveData["state"], "rollbackHistory"> & {
    readonly rollbackHistory: NovelCompressedRollbackHistory;
  };
}

/**
 * Compact fixed-width backlog entry. Field names live here instead of in
 * every persisted JSON record; this order is part of save format version 3.
 */
export type NovelCompressedBacklogEntry = readonly [
  /** Monotonic backlog sequence. */ sequence: number,
  /** Stable dialogue ID. */ lineId: string,
  /** Script label containing the line. */ label: string,
  /** Instruction index within the label. */ index: number,
  /** Historical speaker label. */ speaker: string | null,
  /** Historical portrait key. */ portrait: string | null,
  /** Rendered historical dialogue text. */ text: string,
];

/**
 * Compact completed say state stored in the V3 rollback active pool. Fields
 * derivable from `text` are validated and reconstructed during decode.
 */
export type NovelCompressedRollbackActive = readonly [
  /** Script label. */ label: string,
  /** Instruction index within the label. */ index: number,
  /** Stable dialogue ID. */ id: string,
  /** Speaker label. */ speaker: string | null,
  /** Portrait key. */ portrait: string | null,
  /** Rendered dialogue text. */ text: string,
  /** Preserve the original completed reveal progress. */ revealProgress: number,
  /** Remaining auto delay, if any. */ autoRemainingMs: number | null,
];

/** V3 keeps the V2 rollback pools except that completed active states are tuples. */
export interface NovelCompressedRollbackHistoryV3 {
  readonly pools: Omit<NovelCompressedRollbackHistory["pools"], "active"> & {
    readonly active: readonly NovelCompressedRollbackActive[];
  };
  readonly entries: readonly NovelCompressedRollbackCheckpoint[];
}

/** A persisted save with compact backlog entries and V3 rollback pools. */
export interface NovelSaveDataV3 {
  readonly format: "pocket-vn-save";
  readonly formatVersion: 3;
  readonly storyId: string;
  readonly storyVersion: number;
  readonly state: Omit<NovelSaveData["state"], "backlog" | "rollbackHistory"> & {
    readonly backlog: readonly NovelCompressedBacklogEntry[];
    readonly rollbackHistory: NovelCompressedRollbackHistoryV3;
  };
}

/** V4 backlog rows refer to shared rendered text in state.textPool. */
export type NovelCompressedBacklogEntryV4 = readonly [
  /** Monotonic backlog sequence. */ sequence: number,
  /** Stable dialogue ID. */ lineId: string,
  /** Script label containing the line. */ label: string,
  /** Instruction index within the label. */ index: number,
  /** Historical speaker label. */ speaker: string | null,
  /** Historical portrait key. */ portrait: string | null,
  /** Index into the save-wide rendered-text pool. */ textRef: number,
  /** Optional index into the rich annotation pool; omitted for legacy plain rows. */ richRef?: number,
];

/** V4 completed rollback dialogue state with a shared rendered-text reference. */
export type NovelCompressedRollbackActiveV4 = readonly [
  /** Script label. */ label: string,
  /** Instruction index within the label. */ index: number,
  /** Stable dialogue ID. */ id: string,
  /** Speaker label. */ speaker: string | null,
  /** Portrait key. */ portrait: string | null,
  /** Index into the save-wide rendered-text pool. */ textRef: number,
  /** Preserve the original completed reveal progress. */ revealProgress: number,
  /** Remaining auto delay, if any. */ autoRemainingMs: number | null,
  /** Optional index into the rich annotation pool; omitted for legacy plain rows. */ richRef?: number,
];

/** Rich metadata tuple references every string through the V4 shared text pool. */
export type NovelCompressedSayRichV4 = readonly [
  /** Rendered line text reference; ranges are validated against this text. */ textRef: number,
  /** ID, range, style tokens, optional ruby ref, and optional link title/body refs. */
  spans: readonly (readonly [idRef: number, start: number, end: number, color: NovelSayColorToken | null, emphasis: "strong" | null, rubyRef: number | null, linkTitleRef: number | null, linkTextRef: number | null])[],
  /** Pause ID, code-point position, and null for manual or milliseconds for timed pauses. */
  pauses: readonly (readonly [idRef: number, at: number, durationMs: number | null])[],
];

/** V4 active state stores rich metadata by shared-pool reference. */
export type NovelCompressedSayStateV4 = Omit<SayState, "rich"> & { readonly richRef?: number };
export type NovelCompressedActiveStateV4 = NovelCompressedSayStateV4 | Exclude<ActiveNovelState, { kind: "say" }> | null;

/** V4 retains V3's rollback pools while sharing rendered text with the backlog. */
export interface NovelCompressedRollbackHistoryV4 {
  readonly pools: Omit<NovelCompressedRollbackHistoryV3["pools"], "active"> & {
    readonly active: readonly NovelCompressedRollbackActiveV4[];
  };
  readonly entries: readonly NovelCompressedRollbackCheckpoint[];
}

/** A persisted save with one shared text pool for backlog and rollback history. */
export interface NovelSaveDataV4 {
  readonly format: "pocket-vn-save";
  readonly formatVersion: 4;
  readonly storyId: string;
  readonly storyVersion: number;
  readonly state: Omit<NovelSaveData["state"], "backlog" | "rollbackHistory" | "active"> & {
    readonly active: NovelCompressedActiveStateV4;
    readonly textPool: readonly string[];
    readonly richPool?: readonly NovelCompressedSayRichV4[];
    readonly backlog: readonly NovelCompressedBacklogEntryV4[];
    readonly rollbackHistory: NovelCompressedRollbackHistoryV4;
  };
}

export interface NovelEngine {
  readonly debug: NovelDebugAPI;
  getSnapshot(): EngineSnapshot;
  /**
   * Return the immutable stage used for rendering. Reduced-motion projections
   * settle an active timeline for display without changing canonical state.
   */
  getStagePresentation(options?: { readonly reduceMotion?: boolean }): StageState;
  subscribe(listener: EngineListener, options?: EngineSubscribeOptions): () => void;
  start(): EngineUpdate;
  /** Reveal the current line, or advance a completed line to the next blocking instruction. */
  advance(): EngineUpdate;
  /** Activate a fully revealed link on the active say without advancing its text or story cursor. */
  activateSayLink(spanId: string): EngineUpdate;
  /** Deliver a real native voice fact. Stale request tokens are ignored. */
  reportVoice(fact: NovelVoicePlaybackFact): EngineUpdate;
  /** Deliver native video position/duration facts; stale generation tokens are ignored. */
  reportVideo(fact: NovelVideoPlaybackFact): EngineUpdate;
  /** Apply a player video command through the same canonical stage and validator. */
  controlVideo(instruction: NovelVideoInstruction): EngineUpdate;
  /** Replay the current voiced line with a fresh playback request token. */
  replayVoice(): EngineUpdate;
  selectChoice(optionId: string): EngineUpdate;
  /** Apply the active scene object's set/inc effects without advancing the current line. */
  interactSceneObject(objectId: string): EngineUpdate;
  /** Replace the active text/number raw draft, or set the active boolean value. */
  updateInput(value: string | boolean): EngineUpdate;
  /** Validate and commit the active input, then run to the next blocking instruction. */
  submitInput(): EngineUpdate;
  /** Follow the instruction's cancel label without changing its variable. */
  cancelInput(): EngineUpdate;
  /** Advances all engine time; callers pass the guest's real virtual-time delta. */
  tick(deltaMs: number): EngineUpdate;
  pause(): EngineUpdate;
  resume(): EngineUpdate;
  setPreferences(preferences: Partial<NovelPreferences>): EngineUpdate;
  /** Restore a previous dialogue checkpoint while retaining meta progress. */
  rollback(steps?: number): EngineUpdate;
  /** Reset save-lifetime state and restart while retaining session and persistent progress. */
  newGame(): EngineUpdate;
  save(): NovelSaveData;
  /** Validates story identity/version, instruction addresses and serialized state before replacing live state. */
  load(value: unknown): EngineUpdate;
  dispose(): void;
}

/** Safe editor controls over the same engine used for play; variables remain read-only. */
export interface NovelDebugAPI {
  /** Subscribe to actual OP execution. Disabled unless at least one observer is subscribed. */
  subscribeExecutionTrace(listener: NovelExecutionTraceListener): () => void;
  pause(): EngineUpdate;
  resume(): EngineUpdate;
  /** Advance to the next blocking instruction, then pause. */
  step(): EngineUpdate;
  /** Stop before executing an instruction at any listed address. */
  setBreakpoints(locations: readonly ScriptPosition[]): EngineUpdate;
  /** Jump to a validated instruction, preserving variables, stage, meta and backlog. */
  jump(location: ScriptPosition): EngineUpdate;
}
