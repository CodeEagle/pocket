import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
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
          if (storageStatus() === "thumbnail") setStorageStatus("");
          return { version: 1 as const, ...image };
        } catch {
          // A video/platform texture or unavailable image provider must not
          // prevent the player from saving the canonical game progress.
          setStorageStatus("thumbnail");
          return null;
        }
      },
      list: async () => {
        const items = await images.list();
        setSlotImagesAvailable(true);
        return items.map(item => item.id);
      },
      remove: async id => { await images.remove(id); },
      onCleanupError: () => setStorageStatus("thumbnail"),
    },
  });
  const storage = {
    read: async (slot: string) => {
      const data = await slots.read(slot);
      if (data === null) return null;
      const sourceVersion = typeof data === "object" && "storyVersion" in data ? data.storyVersion : undefined;
      const sourceMap = [revisionMap, revisionMapV2, revisionMapV3, revisionMapV4, revisionMapV5].find(map => map.fromVersion === sourceVersion);
      return rebaseNovelSaveDataForLocale(migrateNovelSaveRevision(data, sourceMap, lanternStory), lanternStory, localized().story);
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
    onStatus: (status, detail) => setAudioStatus({ status, detail }),
    onVoicePlayback: fact => activeEngine().reportVoice(fact),
  });
  let audioMixWriteQueue: Promise<void> = Promise.resolve();
  const changeAudioMix = (group: "master" | NovelAudioGroup, value: number): void => {
    const next = audio.setMix({ [group]: value });
    setAudioMix(next);
    audioMixWriteQueue = audioMixWriteQueue.catch(() => {}).then(() =>
      platform.storage.set("lantern.audio.mix", next as unknown as BridgeValue),
    ).then(() => {
      if (storageStatus() === "audioMix") setStorageStatus("");
    }).catch(() => setStorageStatus("audioMix"));
  };
  let textSoundsWriteQueue: Promise<void> = Promise.resolve();
  const changeTextSoundsEnabled = (enabled: boolean): void => {
    audio.setTextSoundsEnabled(enabled);
    setTextSoundsEnabled(enabled);
    textSoundsWriteQueue = textSoundsWriteQueue.catch(() => {}).then(() =>
      platform.storage.set("lantern.audio.textSoundsEnabled", enabled),
    ).then(() => {
      if (storageStatus() === "textSounds") setStorageStatus("");
    }).catch(() => setStorageStatus("textSounds"));
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
  let disposed = false;
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
      setStorageStatus("");
    } catch { setStorageStatus("autosave"); }
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
    // One startup sweep recovers orphan PNGs from interrupted writes. Slot
    // references remain the only catalog; autosaves do not rescan image files.
    try { await slots.collectThumbnails?.(); } catch { /* Older hosts keep text-only saves. */ }
    try {
      const storedMix = await platform.storage.get("lantern.audio.mix");
      if (storedMix && typeof storedMix === "object" && !Array.isArray(storedMix)) {
        const restored = audio.setMix(storedMix as Partial<NovelAudioMix>);
        setAudioMix(restored);
      }
    } catch { setStorageStatus("audioMix"); }
    try {
      const storedTextSoundsEnabled = await platform.storage.get("lantern.audio.textSoundsEnabled");
      if (typeof storedTextSoundsEnabled === "boolean") {
        audio.setTextSoundsEnabled(storedTextSoundsEnabled);
        setTextSoundsEnabled(storedTextSoundsEnabled);
      }
    } catch { setStorageStatus("textSounds"); }
    try {
      const savedLocale = await platform.storage.get("lantern.locale");
      if (typeof savedLocale === "string" && locales.some(item => item.id === savedLocale)) {
        setLocale(savedLocale); audio.setAssets(assets().audio); setEngine(newEngine());
      }
      const saved = await storage.read("auto") as NovelSaveData | null;
      if (saved?.storyId === lanternStory.id && saved?.storyVersion === lanternStory.version) {
        // Validate with the actual engine before trusting persisted meta.
        const validator = newEngine();
        validator.load(saved);
        const progress = validator.getSnapshot().meta;
        validator.dispose();
        if (!disposed) setEngine(newEngine(progress));
      }
    } catch { setStorageStatus("read"); }
    finally { if (!disposed) setReady(true); }
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
  return <AccessibilityPreferencesProvider value={accessibility}><Show when={ready()} fallback={<View class="w-full h-full bg-[#08151D] items-center justify-center"><Text class="text-sm text-[#E4CF9E]">{text("正在翻开雾港手札……", "Opening the Mist Harbor journal…")}</Text></View>}>
    <NovelView featuredReplayId="model_showcase" featuredReplayIds={["rich_letter_showcase", "scene_objects_showcase", "feature_tour", "inventory_showcase", "parallax_showcase", "letter_showcase", "transition_showcase", "timeline_showcase"]} engine={activeEngine()} inventory={lanternStory.inventory} assets={assets() satisfies NovelAssets} modelFactory={modelFactory} animations={animations} title={text("雾港末班信", "The Last Letter of Mist Harbor")} shortTitle={text("雾港末班信", "MIST HARBOR")} subtitle={text("把未能抵达的昨天，寄向天亮。", "Send an undelivered yesterday toward dawn.")} storage={storage} slotImages={slotImagesAvailable() ? images : undefined} host={host} videoAdapter={video} audioMix={audioMix()} onAudioMixChange={changeAudioMix} textSoundsEnabled={textSoundsEnabled()} onTextSoundsEnabledChange={changeTextSoundsEnabled} audioStatus={storageMessage() || audioMessage()}
      replayEntries={replayEntries()} replayMode={replayEngine() !== null} onReplayStart={startReplay} onReplayExit={exitReplay}
      registeredMusicIds={registeredMusicIds()} musicTitles={musicTitles()} onMusicPreviewPlay={cue => audio.previewMusic(cue)} onMusicPreviewStop={() => audio.stopMusicPreview()}
      locale={locale()} locales={locales} onLocale={changeLocale} ui={localized().ui}
      onNewGame={() => { engine().newGame(); }}
      onExit={() => { void platform.returnResult({ endings: [...engine().getSnapshot().meta.endingIds] }); }} />
  </Show></AccessibilityPreferencesProvider>;
}

mount(() => <LanternApp />);
