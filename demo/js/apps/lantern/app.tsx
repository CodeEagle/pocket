import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import { after, simulationHz } from "@pocketjs/framework/clock";
import { AccessibilityPreferencesProvider, createAccessibilityPreferences } from "@pocket/ui";
import { createHostBridge, type BridgeValue } from "@pocket/ui/host";
import { createPocketPlatformClient, type PlatformStorageOperation } from "@pocket/ui/platform";
import { createPocketImagesClient } from "@pocket/ui/images";
import { createNovelEngine, createNovelReplayEngine, createNovelAnimationDriver, createNovelSlotManager, encodeNovelSaveData, migrateNovelSaveRevision, type JsonValue, type NovelEngine, type NovelMetaState, type NovelSaveData, type StoryDefinition } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { createNovelAudioAdapter, DEFAULT_NOVEL_AUDIO_MIX, type NovelAudioGroup, type NovelAudioMix } from "@pocket/vn/audio";
import { createNovelVideoAdapter } from "@pocket/vn/video";
import { NovelSkinFrame } from "@pocket/vn/skin-view";
import { createBundledNovelSpineFactory } from "@pocket/vn/spine";
import { createBundledNovelLive2dFactory } from "@pocket/vn/live2d";
import type { NovelModelFactory } from "@pocket/vn";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import { lanternStory } from "./story.ts";
import revisionMap from "./revision-map.json";
import revisionMapV2 from "./revision-map-v2.json";
import revisionMapV3 from "./revision-map-v3.json";
import revisionMapV4 from "./revision-map-v4.json";
import revisionMapV5 from "./revision-map-v5.json";
import projectAssets from "./novel.assets.json";
import localeDocument from "./novel.locales.json";
import { applyStoryAssetOverrides, localizeStory, rebaseNovelSaveDataForLocale, type StoryLocaleCatalogCollection } from "@pocket/vn/localization";

const catalogs = localeDocument.catalogs as StoryLocaleCatalogCollection;
const locales = [{ id: "zh", label: "中文" }, { id: "en", label: "English" }];
type StartupReadId = "locale" | "audioMix" | "textSounds" | "autosave";
type StartupReadStatus = "reading" | "read" | "validating" | "ready" | "empty" | "unavailable";
type StartupRead = { readonly id: StartupReadId; readonly status: StartupReadStatus };
// Intrinsic dimensions are read from the runtime PNG files (`file art/*.png`);
// the optional map lets the SDK preserve proportions without assuming all
// consumers' images share Lantern's square texture format.
const imageDimensions = Object.fromEntries([
  "art/station.png", "art/archive.png", "art/roof.png", "art/dawn.png",
  "art/mira-neutral.png", "art/mira-worried.png", "art/mira-hopeful.png",
  "art/ren-neutral.png", "art/ren-worried.png", "art/ren-hopeful.png",
  "art/truth-letter.png", "art/dawn-departure.png", "art/harbor-light.png",
  "art/ui/relay-dial.png", "art/fx/sea-mist.png",
].map(path => [path, { width: 512, height: 512 }]).concat([
  ["art/fx/parallax-lantern.png", { width: 2048, height: 1024 }],
]));

function LanternApp(): JSX.Element {
  const host = createHostBridge(undefined, { timeoutFrames: 10 * simulationHz(), scheduleTimeout: (frames, callback) => after(frames / simulationHz(), callback) });
  const accessibility = createAccessibilityPreferences({ bridge: host });
  const platform = createPocketPlatformClient(undefined, { bridge: host, media: false });
  const [locale, setLocale] = createSignal("zh");
  const localized = createMemo(() => localizeStory(lanternStory, catalogs, locale(), { assetRegistry: projectAssets }));
  const assets = createMemo(() => {
    const resolved = applyStoryAssetOverrides(projectAssets, localized().assetOverrides);
    return {
      ...resolved,
      videos: Object.fromEntries(Object.entries(resolved.videos ?? {}).map(([cue, path]) => [cue, `assets/apps/lantern/${path}`])),
      imageDimensions,
    };
  });
  const text = (chinese: string, english: string) => locale() === "en" ? english : chinese;
  const [ready, setReady] = createSignal(false);
  let disposed = false;
  const [startupReads, setStartupReads] = createSignal<StartupRead[]>([
    { id: "locale", status: "reading" },
    { id: "audioMix", status: "reading" },
    { id: "textSounds", status: "reading" },
    { id: "autosave", status: "reading" },
  ]);
  const startupReadCount = () => startupReads().filter(item => item.status !== "reading").length;
  const setStartupReadStatus = (id: StartupReadId, status: StartupReadStatus): void => {
    if (disposed) return;
    setStartupReads(current => current.map(item => item.id === id ? { ...item, status } : item));
  };
  const startupReadLabel = (id: StartupReadId): string => ({
    locale: text("语言偏好", "Language preference"),
    audioMix: text("声音混音偏好", "Audio mix preference"),
    textSounds: text("文字提示音偏好", "Text reveal sound preference"),
    autosave: text("自动记录", "Autosave"),
  })[id];
  const startupReadStatusLabel = (id: StartupReadId, status: StartupReadStatus): string => {
    if (status === "reading") return text("读取中…", "Reading…");
    if (status === "read") return text("已读取", "Read");
    if (status === "validating") return text("校验中…", "Validating…");
    if (status === "ready") return text("已就绪", "Ready");
    if (status === "empty") return id === "autosave"
      ? text("没有可恢复的自动记录", "No resumable autosave")
      : text("使用默认值", "Using defaults");
    return id === "autosave"
      ? text("读取失败，可开始新旅程", "Unavailable; a new journey is available")
      : text("读取失败，使用默认值", "Unavailable; using defaults");
  };
  const startupStageMessage = (): string => {
    const pending = startupReads().find(item => item.status === "reading");
    if (pending?.id === "locale") return text("正在读取语言偏好…", "Reading language…");
    if (pending?.id === "audioMix") return text("正在读取声音设置…", "Reading audio settings…");
    if (pending?.id === "textSounds") return text("正在读取文字提示音…", "Reading text sounds…");
    if (pending?.id === "autosave") return text("正在读取自动记录…", "Reading autosave…");
    if (startupReads().some(item => item.id === "autosave" && item.status === "validating")) {
      return text("正在校验自动记录…", "Validating the autosave…");
    }
    return text("正在准备手札…", "Preparing the journal…");
  };
  const [storageStatus, setStorageStatus] = createSignal<"" | "locale" | "autosave" | "read" | "audioMix" | "textSounds" | "thumbnail">("");
  const images = createPocketImagesClient(host);
  const [slotImagesAvailable, setSlotImagesAvailable] = createSignal(false);
  const storageMessage = () => ({
    "": "",
    locale: text("语言已切换，但偏好暂未保存", "Language changed, but the preference could not be saved"),
    autosave: text("自动记录暂不可用，可在手札中重试存档", "Autosave is unavailable; try a manual save in the journal"),
    read: text("没有可读取的自动记录，仍可开始新旅程", "No autosave could be read; a new journey is available"),
    audioMix: text("音量偏好暂未保存", "Audio mix preferences could not be saved"),
    textSounds: text("文字提示音偏好暂未保存", "Text reveal sound preference could not be saved"),
    thumbnail: text("进度仍可保存，画面预览暂不可用", "Progress can still be saved; the picture preview is unavailable"),
  })[storageStatus()];
  const [audioStatus, setAudioStatus] = createSignal<{ status: string; detail?: string }>({ status: "idle" });
  const [audioMix, setAudioMix] = createSignal<NovelAudioMix>({ ...DEFAULT_NOVEL_AUDIO_MIX });
  const [textSoundsEnabled, setTextSoundsEnabled] = createSignal(false);
  const engineForStory = (story: StoryDefinition, initialMeta?: NovelMetaState) => createNovelEngine(story, {
    initialMeta, maxRollbackEntries: 48, maxBacklogEntries: 128,
    preferences: { textSpeedCharsPerSecond: 32, autoDelayMs: 2500, skipSeenOnly: true },
  });
  const newEngine = (initialMeta?: NovelMetaState) => engineForStory(localized().story, initialMeta);
  const [engine, setEngine] = createSignal(newEngine());
  const [replayEngine, setReplayEngine] = createSignal<NovelEngine | null>(null);
  const activeEngine = createMemo(() => replayEngine() ?? engine());
  const replayEntries = createMemo(() => localized().story.replayEntries ?? []);
  const registeredMusicIds = createMemo(() => Object.keys(assets().audio));
  const musicTitles = createMemo<Readonly<Record<string, string>>>(() => locale() === "en" ? {
    music_storm: "Before the storm",
    music_letter: "A signal through the fog",
    music_dawn: "At dawn",
  } : {
    music_storm: "风暴将至",
    music_letter: "雾中信号",
    music_dawn: "天亮以后",
  });
  const animations = createNovelAnimationDriver();
  const spine = createBundledNovelSpineFactory();
  const live2d = createBundledNovelLive2dFactory(host, { cacheStaticTopology: true });
  const modelFactory: NovelModelFactory = (definition, intent) =>
    definition.kind === "spine" ? spine(definition, intent) : live2d(definition, intent);
  const video = createNovelVideoAdapter(host);
  const slots = createNovelSlotManager({
    get: key => platform.storage.get(key),
    set: (key, value) => platform.storage.set(key, value as BridgeValue),
    remove: key => platform.storage.remove(key),
    keys: () => platform.storage.keys(),
    batch: operations => platform.storage.batch(operations as unknown as readonly PlatformStorageOperation[]),
  }, {
    prefix: "lantern.slot.",
    thumbnails: {
      capture: async () => {
        try {
          const image = await images.capture({ maxWidth: 192, maxHeight: 108, maxPixels: 20_736 });
          if (disposed) return null;
          if (storageStatus() === "thumbnail") setStorageStatus("");
          return { version: 1 as const, ...image };
        } catch {
          // A video/platform texture or unavailable image provider must not
          // prevent the player from saving the canonical game progress.
          if (!disposed) setStorageStatus("thumbnail");
          return null;
        }
      },
      list: async () => {
        const items = await images.list();
        if (!disposed) setSlotImagesAvailable(true);
        return items.map(item => item.id);
      },
      remove: async id => { await images.remove(id); },
      onCleanupError: () => { if (!disposed) setStorageStatus("thumbnail"); },
    },
  });
  const rebaseStoredSave = (data: unknown, targetStory: StoryDefinition = localized().story): NovelSaveData => {
    const sourceVersion = typeof data === "object" && data !== null && "storyVersion" in data ? data.storyVersion : undefined;
    const sourceMap = [revisionMap, revisionMapV2, revisionMapV3, revisionMapV4, revisionMapV5].find(map => map.fromVersion === sourceVersion);
    const migrated = migrateNovelSaveRevision(data, sourceMap, lanternStory);
    return rebaseNovelSaveDataForLocale(migrated, lanternStory, targetStory);
  };
  const storage = {
    read: async (slot: string) => {
      const data = await slots.read(slot);
      if (data === null) return null;
      return rebaseStoredSave(data);
    },
    write: async (slot: string, data: NovelSaveData): Promise<void> => {
      await persistSave(slot, rebaseNovelSaveDataForLocale(data, localized().story, lanternStory));
    },
    list: slots.list,
    delete: slots.delete,
    copy: slots.copy,
    move: slots.move,
    swap: slots.swap,
  };
  const persistSave = async (slot: string, data: NovelSaveData): Promise<void> => {
    await slots.write(slot, encodeNovelSaveData(data) as unknown as JsonValue,
      { captureThumbnail: slot !== "auto" && slotImagesAvailable() });
  };
  const audio = createNovelAudioAdapter(host, assets().audio, {
    initialMix: audioMix(),
    textSounds: projectAssets.textSounds,
    initialTextSoundsEnabled: textSoundsEnabled(),
    onStatus: (status, detail) => { if (!disposed) setAudioStatus({ status, detail }); },
    onVoicePlayback: fact => { if (!disposed) activeEngine().reportVoice(fact); },
  });
  let audioMixWriteQueue: Promise<void> = Promise.resolve();
  const changeAudioMix = (group: "master" | NovelAudioGroup, value: number): void => {
    const next = audio.setMix({ [group]: value });
    setAudioMix(next);
    audioMixWriteQueue = audioMixWriteQueue.catch(() => {}).then(() =>
      platform.storage.set("lantern.audio.mix", next as unknown as BridgeValue),
    ).then(() => {
      if (!disposed && storageStatus() === "audioMix") setStorageStatus("");
    }).catch(() => { if (!disposed) setStorageStatus("audioMix"); });
  };
  let textSoundsWriteQueue: Promise<void> = Promise.resolve();
  const changeTextSoundsEnabled = (enabled: boolean): void => {
    audio.setTextSoundsEnabled(enabled);
    setTextSoundsEnabled(enabled);
    textSoundsWriteQueue = textSoundsWriteQueue.catch(() => {}).then(() =>
      platform.storage.set("lantern.audio.textSoundsEnabled", enabled),
    ).then(() => {
      if (!disposed && storageStatus() === "textSounds") setStorageStatus("");
    }).catch(() => { if (!disposed) setStorageStatus("textSounds"); });
  };
  const audioMessage = () => {
    const { status, detail } = audioStatus();
    return status === "ready" ? text("声音已连接", "Audio connected") : status === "unavailable" ? text("当前宿主未提供声音", "Audio is unavailable on this host") : status === "idle" ? text("声音尚未请求", "Audio has not started") : text(`声音未能播放：${detail ?? "未知原因"}`, `Audio could not play: ${detail ?? "unknown error"}`);
  };
  let localeCaptureSequence = 0;
  const changeLocale = async (nextLocale: string): Promise<void> => {
    if (nextLocale === locale() || !locales.some(item => item.id === nextLocale)) return;
    const previous = engine();
    const previousReplay = replayEngine();
    const previousVisible = previousReplay ?? previous;
    const previousLocale = locale();
    const source = localized().story;
    const sequence = ++localeCaptureSequence;
    const isCurrent = () => !disposed && sequence === localeCaptureSequence && engine() === previous && replayEngine() === previousReplay && activeEngine() === previousVisible && locale() === previousLocale;
    let saved: NovelSaveData;
    let replaySaved: NovelSaveData | undefined;
    try {
      // The main engine is frozen while its replay engine owns the one native
      // video surface. Its last real position was captured before replay began.
      saved = previousReplay ? previous.save() : await video.captureForSave(previous, isCurrent);
      if (previousReplay) replaySaved = await video.captureForSave(previousReplay, isCurrent);
    } catch (error) {
      if (isCurrent()) setAudioStatus({ status: "error", detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!isCurrent()) return;
    const target = localizeStory(lanternStory, catalogs, nextLocale, { assetRegistry: projectAssets });
    const targetStory = target.story;
    const nextMain = engineForStory(targetStory);
    nextMain.load(rebaseNovelSaveDataForLocale(saved, source, targetStory));
    let nextReplay: NovelEngine | null = null;
    if (previousReplay && replaySaved) {
      nextReplay = engineForStory(targetStory);
      nextReplay.load(rebaseNovelSaveDataForLocale(replaySaved, source, targetStory));
    }
    const targetAssets = applyStoryAssetOverrides(projectAssets, target.assetOverrides);
    audio.setAssets(targetAssets.audio);
    batch(() => {
      setLocale(nextLocale);
      setEngine(nextMain);
      if (previousReplay) setReplayEngine(nextReplay);
    });
    void platform.storage.set("lantern.locale", nextLocale).catch(() => {
      setStorageStatus("locale");
    });
  };
  let replayStarting = false;
  const startReplay = async (entryId: string): Promise<void> => {
    if (replayEngine() || replayStarting) return;
    replayStarting = true;
    const main = engine();
    const currentLocale = locale();
    const story = localized().story;
    const isCurrent = () => !disposed && engine() === main && locale() === currentLocale && replayEngine() === null;
    main.pause();
    try {
      await video.captureForSave(main, isCurrent);
      if (!isCurrent()) return;
      setReplayEngine(createNovelReplayEngine(story, main.getSnapshot(), entryId));
    } catch (error) {
      if (isCurrent()) setAudioStatus({ status: "error", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      replayStarting = false;
    }
  };
  let replayExiting = false;
  const exitReplay = async (): Promise<void> => {
    const replay = replayEngine();
    if (!replay || replayExiting) return;
    replayExiting = true;
    const main = engine();
    const currentLocale = locale();
    const isCurrent = () => !disposed && replayEngine() === replay && engine() === main && locale() === currentLocale;
    try {
      // Drain the replay's pending seek/native state before rebinding the
      // shared player to the parked main engine.
      await video.captureForSave(replay, isCurrent);
    } catch (error) {
      if (isCurrent()) setAudioStatus({ status: "error", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      if (isCurrent()) setReplayEngine(null);
      replayExiting = false;
    }
  };
  let pendingSave: { engine: NovelEngine; story: StoryDefinition; locale: string; videoToken: string | null } | undefined;
  let writing = false;
  const writeAutosave = async (): Promise<void> => {
    if (writing || disposed) return;
    writing = true;
    try {
      while (pendingSave && !disposed) {
        const pending = pendingSave; pendingSave = undefined;
        const isMainCurrent = () => !disposed && engine() === pending.engine && locale() === pending.locale;
        if (!isMainCurrent()) continue;
        const active = activeEngine() === pending.engine;
        const isCurrent = () => isMainCurrent() && activeEngine() === pending.engine && pending.engine.getSnapshot().videoToken === pending.videoToken;
        let data: NovelSaveData;
        try {
          // During replay the main engine is deliberately inactive; it was
          // captured before switching engines and must not inspect the replay
          // surface as if it belonged to main.
          data = active ? await video.captureForSave(pending.engine, isCurrent) : pending.engine.save();
        } catch (error) {
          if (!isMainCurrent()) continue;
          if (replayEngine() !== null) {
            data = pending.engine.save();
          } else if (pending.engine.getSnapshot().videoToken !== pending.videoToken || pendingSave) {
            continue;
          } else {
            throw error;
          }
        }
        if (!isMainCurrent()) continue;
        const canonical = rebaseNovelSaveDataForLocale(data, pending.story, lanternStory);
        await persistSave("auto", { ...canonical, state: { ...canonical.state, paused: false } });
      }
      if (!disposed) setStorageStatus("");
    } catch { if (!disposed) setStorageStatus("autosave"); }
    finally { writing = false; }
  };
  createEffect(() => {
    const current = engine();
    onCleanup(() => current.dispose());
  });
  createEffect(() => {
    const current = engine();
    const currentStory = untrack(localized).story;
    const currentLocale = untrack(locale);
    const checkpointFor = (state: ReturnType<NovelEngine["getSnapshot"]>): string => {
      const active = state.active;
      const inputSignature = active?.kind === "input"
        ? `${active.id}:${typeof active.draft}:${String(active.draft)}:${active.error?.code ?? ""}:${active.error?.limit ?? ""}`
        : "";
      const videoSignature = `${state.videoToken ?? ""}:${state.stage.video?.cue ?? ""}:${state.stage.video?.status ?? ""}`;
      return `${active?.location.label}:${active?.location.index}:${state.meta.readLineIds.length}:${state.meta.endingIds.length}:${inputSignature}:${videoSignature}`;
    };
    // Rebinding a localized engine preserves the same story checkpoint. Its
    // initial snapshot must not rewrite the parked save with partial animation
    // or typewriter progress; only subsequent checkpoint changes are saved.
    let checkpoint = checkpointFor(current.getSnapshot());
    const removeUpdates = current.subscribe(update => {
      const state = update.snapshot;
      const signature = checkpointFor(state);
      if (state.phase === "ready" || state.phase === "disposed" || !untrack(ready) || signature === checkpoint) return;
      checkpoint = signature;
      pendingSave = { engine: current, story: currentStory, locale: currentLocale, videoToken: state.videoToken };
      void writeAutosave();
    }, { emitCurrent: true });
    onCleanup(removeUpdates);
  });
  createEffect(() => {
    const current = activeEngine();
    const source = replayEngine() === null ? "main" : "replay";
    const removeClock = attachNovelClock(current, { animations });
    const removeUpdates = current.subscribe(update => audio.apply(update, source), { emitCurrent: true });
    onCleanup(() => {
      removeUpdates();
      removeClock();
      if (source === "replay") current.dispose();
    });
  });
  onMount(async () => {
    const readStartupValue = async (
      id: StartupReadId,
      read: () => Promise<unknown>,
    ): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> => {
      try {
        const value = await read();
        setStartupReadStatus(id, "read");
        return { ok: true, value };
      } catch {
        if (!disposed) {
          setStartupReadStatus(id, "unavailable");
          setStorageStatus(id === "autosave" ? "read" : id);
        }
        return { ok: false };
      }
    };

    try {
      // These four storage requests are independent. Start them together so
      // slow optional media cleanup cannot delay the title screen.
      const [mixRead, textSoundsRead, localeRead, autosaveRead] = await Promise.all([
        readStartupValue("audioMix", () => platform.storage.get("lantern.audio.mix")),
        readStartupValue("textSounds", () => platform.storage.get("lantern.audio.textSoundsEnabled")),
        readStartupValue("locale", () => platform.storage.get("lantern.locale")),
        readStartupValue("autosave", () => slots.read("auto")),
      ]);
      if (disposed) return;

      if (mixRead.ok) {
        try {
          const storedMix = mixRead.value;
          if (storedMix && typeof storedMix === "object" && !Array.isArray(storedMix)) {
            const restored = audio.setMix(storedMix as Partial<NovelAudioMix>);
            setAudioMix(restored);
          }
          setStartupReadStatus("audioMix", "ready");
        } catch {
          setStartupReadStatus("audioMix", "unavailable");
          setStorageStatus("audioMix");
        }
      }

      if (textSoundsRead.ok) {
        const storedTextSoundsEnabled = textSoundsRead.value;
        if (typeof storedTextSoundsEnabled === "boolean") {
          audio.setTextSoundsEnabled(storedTextSoundsEnabled);
          setTextSoundsEnabled(storedTextSoundsEnabled);
        }
        setStartupReadStatus("textSounds", "ready");
      }

      if (localeRead.ok) {
        try {
          const savedLocale = localeRead.value;
          if (typeof savedLocale === "string" && locales.some(item => item.id === savedLocale)) {
            setLocale(savedLocale);
            audio.setAssets(assets().audio);
            setEngine(newEngine());
          }
          setStartupReadStatus("locale", "ready");
        } catch {
          setStartupReadStatus("locale", "unavailable");
          setStorageStatus("locale");
        }
      }

      if (autosaveRead.ok) {
        if (autosaveRead.value === null) {
          setStartupReadStatus("autosave", "empty");
        } else {
          setStartupReadStatus("autosave", "validating");
          try {
            // Rebase only after the saved locale has been applied. The
            // revision migration and the real engine load remain the same
            // validation boundary used before startup was parallelized.
            const saved = rebaseStoredSave(autosaveRead.value, localized().story);
            if (saved.storyId === lanternStory.id && saved.storyVersion === lanternStory.version) {
              const validator = newEngine();
              let progress: NovelMetaState;
              try {
                validator.load(saved);
                progress = validator.getSnapshot().meta;
              } finally {
                validator.dispose();
              }
              if (!disposed) setEngine(newEngine(progress));
              setStartupReadStatus("autosave", "ready");
            } else {
              setStartupReadStatus("autosave", "empty");
            }
          } catch {
            setStartupReadStatus("autosave", "unavailable");
            setStorageStatus("read");
          }
        }
      }
    } catch {
      if (!disposed) setStorageStatus("read");
    } finally {
      if (!disposed) {
        setReady(true);
        // This is optional orphan cleanup, kept on the existing serialized
        // slot queue. Its completion is not part of title-screen readiness.
        void slots.collectThumbnails?.().catch(() => {
          if (!disposed) setStorageStatus("thumbnail");
        });
      }
    }
  });
  let lifecycleResume = false;
  const removeLifecycle = platform.onLifecycle(event => {
    if (event.state === "onHide" || event.state === "onPause" || event.state === "onWillDisappear") {
      const current = activeEngine();
      lifecycleResume ||= !current.getSnapshot().paused;
      current.pause(); audio.setSuspended(true);
    } else if (event.state === "onResume" || event.state === "onDidAppear") {
      audio.setSuspended(false);
      if (lifecycleResume) activeEngine().resume();
      lifecycleResume = false;
    }
  });
  onCleanup(() => { disposed = true; pendingSave = undefined; removeLifecycle(); video.dispose(); audio.dispose(); platform.dispose(); host.dispose(); });
  return <AccessibilityPreferencesProvider value={accessibility}><Show when={ready()} fallback={<View class="w-full h-full bg-[#08151D] items-center justify-center overflow-hidden p-3">
    <View class="relative flex-col items-center justify-center gap-2 px-5" style={{ width: 320, height: 280 }}>
      <NovelSkinFrame frame={projectAssets.skin.frame} width={320} height={280} border={20} debugName="lantern-startup-skin" />
      <Text class="text-xl font-bold text-[#FFE1A3] text-center">{text("雾港末班信", "The Last Letter of Mist Harbor")}</Text>
      <Text class="text-sm text-[#E4CF9E] text-center">{text("正在翻开雾港手札……", "Opening the Mist Harbor journal…")}</Text>
      <Text class="text-base font-bold text-[#F5ECD9] text-center mt-1">{startupStageMessage()}</Text>
      <Text class="text-xs text-[#9EB2B5] text-center mt-1">{text(`已完成 ${startupReadCount()} / 4 项启动读取`, `${startupReadCount()} / 4 startup requests completed`)}</Text>
      <View class="flex-col gap-1 mt-1" style={{ width: 280 }}>
        <For each={startupReads()}>{item => <View class="flex-col gap-0.5">
          <Text class="text-xs text-[#C7C4B6]">{startupReadLabel(item.id)}</Text>
          <Text class="text-xs text-[#DBBD80]">{startupReadStatusLabel(item.id, item.status)}</Text>
        </View>}</For>
      </View>
    </View>
  </View>}>
    <NovelView featuredReplayId="model_showcase" featuredReplayIds={["rich_letter_showcase", "scene_objects_showcase", "feature_tour", "inventory_showcase", "parallax_showcase", "letter_showcase", "transition_showcase", "timeline_showcase"]} engine={activeEngine()} inventory={lanternStory.inventory} assets={assets() satisfies NovelAssets} modelFactory={modelFactory} animations={animations} title={text("雾港末班信", "The Last Letter of Mist Harbor")} shortTitle={text("雾港末班信", "MIST HARBOR")} subtitle={text("把未能抵达的昨天，寄向天亮。", "Send an undelivered yesterday toward dawn.")} storage={storage} slotImages={slotImagesAvailable() ? images : undefined} host={host} videoAdapter={video} audioMix={audioMix()} onAudioMixChange={changeAudioMix} textSoundsEnabled={textSoundsEnabled()} onTextSoundsEnabledChange={changeTextSoundsEnabled} audioStatus={storageMessage() || audioMessage()}
      replayEntries={replayEntries()} replayMode={replayEngine() !== null} onReplayStart={startReplay} onReplayExit={exitReplay}
      registeredMusicIds={registeredMusicIds()} musicTitles={musicTitles()} onMusicPreviewPlay={cue => audio.previewMusic(cue)} onMusicPreviewStop={() => audio.stopMusicPreview()}
      locale={locale()} locales={locales} onLocale={changeLocale} ui={localized().ui}
      onNewGame={() => { engine().newGame(); }}
      onExit={() => { void platform.returnResult({ endings: [...engine().getSnapshot().meta.endingIds] }); }} />
  </Show></AccessibilityPreferencesProvider>;
}

mount(() => <LanternApp />);
