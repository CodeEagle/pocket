import { For, Show, createSignal, onCleanup, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileListTile,
  MobileScaffold,
  MobileSegmentedControl,
  ScrollablePage,
  MobileAlert,
  useMobileTheme,
  Video,
} from "@pocket/ui";
import type { HostBridge, HostEvent } from "@pocket/ui/host";
import type { createPocketPlatformClient } from "@pocket/ui/platform";
import type { MediaController } from "@pocket/ui/media";
import type { VideoFit } from "@pocket/ui/video";
import type { Route } from "./state.ts";

/** Logical asset names supplied by the Demo's local Flutter asset bundle. */
export const VIDEO_LAB_ASSETS = Object.freeze({
  clipA: "assets/videos/clip-a.mp4",
  clipB: "assets/videos/clip-b.mp4",
  missing: "assets/videos/missing-video.mp4",
});

const HERO_ID = "video-lab-hero";
const FEED_A_ID = "video-lab-feed-a";
const FEED_B_ID = "video-lab-feed-b";
const SCROLL_ID = "video-lab-scroll";
const SWAP_ID = "video-lab-same-id";
const RETRY_ID = "video-lab-retry";
const FEED_GROUP = "video-lab-feed";
const VIDEO_PAGE = "video";
const RECENT_LIMIT = 8;

type VideoIntentRecord = { playing: boolean };
const intentModel = new Map<string, VideoIntentRecord>();

/**
 * The page is route-mounted, so this tiny JS model intentionally lives outside
 * the component. It preserves user intent across route disposal/rebuild while
 * the Video registrations themselves remain lifetime-bound to the retained
 * draw nodes.
 */
export function videoLabIntent(id: string, fallback = false): boolean {
  return intentModel.get(id)?.playing ?? fallback;
}
export function resetVideoLabModel(): void {
  intentModel.clear();
}

function rememberIntent(id: string, playing: boolean): void {
  intentModel.set(id, { playing });
}

type VideoPagePlatform = ReturnType<typeof createPocketPlatformClient>;

export interface VideoPageProps {
  host: HostBridge;
  platform: VideoPagePlatform;
  onNavigate: (route: Route) => void;
}

type VideoEntry = {
  id: string;
  asset: Accessor<string>;
  playing: Accessor<boolean>;
  active: Accessor<boolean>;
  setPlaying: (value: boolean) => void;
  setActive: (value: boolean) => void;
  group?: string;
};

function eventLabel(event: HostEvent): string {
  const params = event.params as Record<string, unknown>;
  const id = typeof params.id === "string" ? ` ${params.id}` : "";
  if (event.method === "platform.lifecycle") {
    return `lifecycle ${String(params.state ?? "unknown")}`;
  }
  if (event.method.startsWith("video.")) {
    return `${event.method}${id}`;
  }
  return event.method;
}

function VideoSurface(props: {
  media: MediaController;
  id: string;
  asset: string;
  playing: boolean;
  active: boolean;
  fit?: VideoFit;
  group?: string;
  class?: string;
}): JSX.Element {
  return (
    <Video
      id={props.id}
      asset={props.asset}
      media={props.media}
      group={props.group}
      page={VIDEO_PAGE}
      active={props.active}
      playing={props.playing}
      fit={props.fit ?? "cover"}
      class={props.class ?? "w-full h-[176] rounded-xl"}
      style={{ radius: 16 }}
    />
  );
}
function VideoStateSplit(props: {
  expected: string;
  native: string;
}): JSX.Element {
  const theme = useMobileTheme();
  return (
    <View class={theme().name === "dark" ? "flex-col gap-1 px-3 py-2 rounded-xl bg-[#22314A] border-[#30405A]" : "flex-col gap-1 px-3 py-2 rounded-xl bg-[#F1F3F8] border-[#E5E9F2]"}>
      <Text class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold"}>Expected policy state · {props.expected}</Text>
      <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>Native video.state · {props.native}</Text>
    </View>
  );
}

function TestMatrix(props: {
  rows: Accessor<readonly { label: string; expected: string; native: string; tone: "accent" | "success" | "warning" | "danger" }[]>;
}): JSX.Element {
  return (
    <MobileCard
      title="Manual test matrix"
      detail="Expected JS policy and native video.state are intentionally shown separately."
    >
      <For each={props.rows()}>
        {(row) => (
          <MobileListTile
            title={row.label}
            detail={`${row.expected} · native ${row.native}`}
            trailing={<MobileBadge label={row.tone === "success" ? "Observed" : "Manual"} tone={row.tone} />}
          />
        )}
      </For>
    </MobileCard>
  );
}

function VideoControls(props: {
  entry: VideoEntry;
  log: (message: string) => void;
  label: string;
  playLabel?: string;
  pauseLabel?: string;
}): JSX.Element {
  const setPlaying = (playing: boolean): void => {
    rememberIntent(props.entry.id, playing);
    props.entry.setPlaying(playing);
    props.log(`${props.label}: expected ${playing ? "playing" : "paused"}`);
  };
  return (
    <View class="flex-row flex-wrap gap-2">
      <MobileButton
        label={props.entry.playing() ? props.pauseLabel ?? "Pause" : props.playLabel ?? "Play"}
        onPress={() => setPlaying(!props.entry.playing())}
        compact
      />
      <MobileButton label="Explicit pause" kind="outlined" compact onPress={() => setPlaying(false)} />
      <MobileButton
        label="Fast play / pause"
        kind="text"
        compact
        onPress={() => {
          setPlaying(true);
          queueMicrotask(() => setPlaying(false));
        }}
      />
    </View>
  );
}

export function VideoPage(props: VideoPageProps): JSX.Element {
  const theme = useMobileTheme();
  const media = props.platform.media;
  const [tab, setTab] = createSignal("playback");
  const [recent, setRecent] = createSignal<string[]>([]);
  const [nativeStates, setNativeStates] = createSignal<Record<string, string>>({});
  const [nativeControllers, setNativeControllers] = createSignal("unknown (host snapshot not observed)");
  const [coverage, setCoverage] = createSignal<"idle" | "opening" | "settled" | "failed">("idle");
  const coverageLabel = () => ({
    idle: "No MiniApp coverage active",
    opening: "MiniApp launch coverage active; awaiting platform.result",
    settled: "Launch result received; media policy may restore original intent",
    failed: "Launch failed; verify coverage release path",
  })[coverage()];
  const [showHero, setShowHero] = createSignal(true);
  const [heroAsset, setHeroAsset] = createSignal(VIDEO_LAB_ASSETS.clipA);
  const [heroFit, setHeroFit] = createSignal<VideoFit>("cover");
  const [heroPlaying, setHeroPlaying] = createSignal(videoLabIntent(HERO_ID));
  const [feedAPlaying, setFeedAPlaying] = createSignal(videoLabIntent(FEED_A_ID));
  const [feedBPlaying, setFeedBPlaying] = createSignal(videoLabIntent(FEED_B_ID));
  const [feedAActive, setFeedAActive] = createSignal(true);
  const [feedBActive, setFeedBActive] = createSignal(true);
  const [scrollPlaying, setScrollPlaying] = createSignal(videoLabIntent(SCROLL_ID));
  const [swapAsset, setSwapAsset] = createSignal(VIDEO_LAB_ASSETS.clipA);
  const [swapPlaying, setSwapPlaying] = createSignal(videoLabIntent(SWAP_ID));
  const [retryAsset, setRetryAsset] = createSignal(VIDEO_LAB_ASSETS.missing);
  const [retryPlaying, setRetryPlaying] = createSignal(videoLabIntent(RETRY_ID));
  const [miniAppStatus, setMiniAppStatus] = createSignal("Not opened");

  const nativeStateFor = (id: string): string => nativeStates()[id] ?? "unknown";
  const nativeLabelFor = (id: string): string => `${id} · ${nativeStateFor(id)}`;

  const log = (message: string): void => {
    setRecent((items) => [...items.slice(-(RECENT_LIMIT - 1)), message]);
  };

  const hero: VideoEntry = {
    id: HERO_ID,
    asset: heroAsset,
    playing: heroPlaying,
    active: () => true,
    setPlaying: setHeroPlaying,
    setActive: () => {},
  };
  const feedA: VideoEntry = {
    id: FEED_A_ID,
    asset: () => VIDEO_LAB_ASSETS.clipA,
    playing: feedAPlaying,
    active: feedAActive,
    setPlaying: setFeedAPlaying,
    setActive: setFeedAActive,
    group: FEED_GROUP,
  };
  const feedB: VideoEntry = {
    id: FEED_B_ID,
    asset: () => VIDEO_LAB_ASSETS.clipB,
    playing: feedBPlaying,
    active: feedBActive,
    setPlaying: setFeedBPlaying,
    setActive: setFeedBActive,
    group: FEED_GROUP,
  };
  const scroll: VideoEntry = {
    id: SCROLL_ID,
    asset: () => VIDEO_LAB_ASSETS.clipB,
    playing: scrollPlaying,
    active: () => true,
    setPlaying: setScrollPlaying,
    setActive: () => {},
  };
  const swap: VideoEntry = {
    id: SWAP_ID,
    asset: swapAsset,
    playing: swapPlaying,
    active: () => true,
    setPlaying: setSwapPlaying,
    setActive: () => {},
  };
  const retry: VideoEntry = {
    id: RETRY_ID,
    asset: retryAsset,
    playing: retryPlaying,
    active: () => true,
    setPlaying: setRetryPlaying,
    setActive: () => {},
  };

  const setFeed = (id: string): void => {
    const isA = id === FEED_A_ID;
    rememberIntent(FEED_A_ID, isA);
    rememberIntent(FEED_B_ID, !isA);
    setFeedAPlaying(isA);
    setFeedBPlaying(!isA);
    log(`feed switch: ${isA ? "clip A" : "clip B"} selected; peer intent cleared`);
  };

  const setActive = (entry: VideoEntry, active: boolean): void => {
    entry.setActive(active);
    log(`${entry.id}: active=${String(active)}; native draw visibility remains separate`);
  };

  const openMiniApp = async (): Promise<void> => {
    setMiniAppStatus("Opening Profile; media coverage should pause the active item");
    setCoverage("opening");
    log("platform.openApp profile: expected pause while covered");
    try {
      const result = await props.platform.openApp("pocket.demo.profile", { from: "video-lab" });
      setMiniAppStatus(result.cancelled ? "Profile cancelled" : "Profile returned");
      setCoverage("settled");
      log(`platform.result: ${result.cancelled ? "cancelled" : "returned"}`);
    } catch (error) {
      setMiniAppStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
      setCoverage("failed");
      log("platform.openApp failed; native state not claimed");
    }
  };

  const swapSameIdAsset = (): void => {
    const next = swapAsset() === VIDEO_LAB_ASSETS.clipA ? VIDEO_LAB_ASSETS.clipB : VIDEO_LAB_ASSETS.clipA;
    setSwapAsset(next);
    log(`${SWAP_ID}: asset changed to ${next}; expected=${swapPlaying() ? "playing" : "paused"}`);
  };

  const retryMissingAsset = (): void => {
    const next = retryAsset() === VIDEO_LAB_ASSETS.missing ? VIDEO_LAB_ASSETS.clipA : VIDEO_LAB_ASSETS.missing;
    setRetryAsset(next);
    log(`${RETRY_ID}: retry asset ${next}; native load result is manual`);
  };

  const rows = (): readonly { label: string; expected: string; native: string; tone: "accent" | "success" | "warning" | "danger" }[] => [
    { label: "Default registration", expected: "paused", native: nativeLabelFor(HERO_ID), tone: "warning" },
    { label: "Explicit play / pause", expected: heroPlaying() ? "playing" : "paused", native: nativeLabelFor(HERO_ID), tone: "accent" },
    { label: "MiniApp coverage", expected: coverage() === "opening" ? "paused while covered" : "follow original intent", native: nativeLabelFor(HERO_ID), tone: "warning" },
    { label: "Feed group", expected: feedAPlaying() ? "clip A only" : feedBPlaying() ? "clip B only" : "paused", native: `${nativeLabelFor(FEED_A_ID)} / ${nativeLabelFor(FEED_B_ID)}`, tone: "accent" },
    { label: "Same-id asset swap", expected: swapPlaying() ? "retain playing intent" : "retain explicit pause", native: nativeLabelFor(SWAP_ID), tone: "accent" },
    { label: "Failed asset retry", expected: retryAsset() === VIDEO_LAB_ASSETS.missing ? "manual error" : "retry clip A", native: nativeLabelFor(RETRY_ID), tone: "warning" },
    { label: "Scroll visibility", expected: scrollPlaying() ? "intent playing; draw visibility gates native" : "paused", native: nativeLabelFor(SCROLL_ID), tone: "warning" },
    { label: "Resize / Duo / BoxFit", expected: `resize manually; hero fit=${heroFit()} (cover|contain|fill)`, native: nativeLabelFor(HERO_ID), tone: "warning" },
    { label: "Background / foreground", expected: "manual app background; pause then restore intent", native: nativeLabelFor(HERO_ID), tone: "warning" },
    { label: "Destroy / rebuild", expected: showHero() ? "registered" : "disposed requested; intent retained", native: nativeLabelFor(HERO_ID), tone: showHero() || nativeStateFor(HERO_ID) !== "disposed" ? "warning" : "success" },
  ];

  const removeHostEvent = props.host.onEvent?.((event) => {
    if (event.method === "video.state" || event.method === "video.error") {
      const id = typeof event.params.id === "string" ? event.params.id : "video-lab-unknown";
      const state = event.params.state ?? event.params.phase ?? event.params.message ?? event.method;
      setNativeStates((current) => ({ ...current, [id]: String(state) }));
      if (typeof event.params.controllers === "number") setNativeControllers(String(event.params.controllers));
    }
    if (event.method === "video.snapshot" && typeof event.params.controllers === "number") {
      setNativeControllers(String(event.params.controllers));
      // Inspect is an explicit fact refresh, including state changes that
      // happened before this page subscribed. Keep it on the existing event
      // lane; no timer or decoder polling is needed.
      const items = event.params.items;
      if (Array.isArray(items)) {
        setNativeStates((current) => {
          const next = { ...current };
          for (const item of items) {
            if (item && typeof item === "object" && !Array.isArray(item)
              && typeof item.id === "string" && typeof item.state === "string") {
              next[item.id] = item.state;
            }
          }
          return next;
        });
      }
    }
    if (event.method === "platform.lifecycle" || event.method.startsWith("video.")) {
      log(`host: ${eventLabel(event)}`);
    }
  });
  onCleanup(() => removeHostEvent?.());

  return (
      <MobileScaffold reservedActions="mini-app">
        <ScrollablePage>
          <View class="flex-col gap-3 p-4">
            <MobileAlert
              title="Playback status"
              body="Native video.state is reported only when the host emits it; expected policy is JS-owned."
              tone={media !== undefined ? "info" : "warning"}
            />
            <MobileSegmentedControl
              items={[
                { id: "playback", label: "Playback" },
                { id: "coverage", label: "Coverage" },
                { id: "scroll", label: "Scroll" },
              ]}
              active={tab()}
              onChange={setTab}
            />
            <Show
              when={media}
              fallback={<MobileCard title="Media unavailable" detail="The platform client was created with media disabled; no playback claim is made." />}
            >
              <MobileCard
                title="1 · Default / explicit control"
                detail="Starts paused. Play, explicit pause, fast play/pause, and remove/rebuild. This hero remains mounted while Coverage opens a MiniApp."
              >
                <Show
                  when={showHero()}
                  fallback={
                    <View class={theme().name === "dark" ? "flex-col gap-2 p-3 rounded-xl bg-[#3D2E10] border-[#F2D6A1]" : "flex-col gap-2 p-3 rounded-xl bg-[#FFF4DD] border-[#F2D6A1]"}>
                      <Text class={theme().name === "dark" ? "text-xs text-[#FCD34D]" : "text-xs text-[#936211]"}>Hero Video disposed; user intent is retained outside the component.</Text>
                      <MobileButton
                        label="Rebuild Video"
                        compact
                        onPress={() => {
                          setShowHero(true);
                          log("hero rebuilt; registration recreated from JS intent");
                        }}
                      />
                    </View>
                  }
                >
                  <VideoSurface
                    media={media!}
                    id={HERO_ID}
                    asset={heroAsset()}
                    playing={heroPlaying()}
                    active={true}
                    fit={heroFit()}
                  />
                </Show>
                <VideoControls entry={hero} log={log} label="hero" />
                <View class="flex-row flex-wrap gap-2">
                  <MobileButton
                    label="Remove Video"
                    kind="outlined"
                    compact
                    onPress={() => {
                      setShowHero(false);
                      log("hero removed; expected video registration dispose");
                    }}
                  />
                  <MobileButton
                    label={heroAsset() === VIDEO_LAB_ASSETS.clipA ? "Swap to clip B" : "Swap to clip A"}
                    kind="text"
                    compact
                    onPress={() => {
                      const next = heroAsset() === VIDEO_LAB_ASSETS.clipA ? VIDEO_LAB_ASSETS.clipB : VIDEO_LAB_ASSETS.clipA;
                      setHeroAsset(next);
                      log(`hero asset changed to ${next}`);
                    }}
                  />
                </View>
                {/* Keep launch next to the active player. Scrolling to a
                    distant launch button can hide/release the video before
                    coverage starts, making a lifecycle test inconclusive. */}
                <MobileButton label="Open Profile MiniApp" onPress={() => void openMiniApp()} compact />
                <Text class={theme().name === "dark" ? "text-xs text-white font-bold" : "text-xs text-[#17233B] font-bold"}>{nativeLabelFor(HERO_ID)}</Text>
                <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>Native controllers · {nativeControllers()}</Text>
                <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>BoxFit · {heroFit()} (cover / contain / fill)</Text>
                <View class="flex-row flex-wrap gap-2">
                  <MobileButton label="Cover fit" compact onPress={() => { setHeroFit("cover"); log("hero fit=cover"); }} />
                  <MobileButton label="Contain fit" kind="outlined" compact onPress={() => { setHeroFit("contain"); log("hero fit=contain"); }} />
                  <MobileButton label="Fill fit" kind="text" compact onPress={() => { setHeroFit("fill"); log("hero fit=fill"); }} />
                </View>
                <MobileButton
                  label="Inspect native state"
                  kind="text"
                  compact
                  onPress={() => {
                    const sent = props.host.emit?.("video.inspect", {}) === true;
                    log(`inspect ${sent ? "requested" : "unavailable"}: ${nativeLabelFor(HERO_ID)} · controllers ${nativeControllers()}`);
                  }}
                />
              </MobileCard>
              <Show when={tab() === "playback"}>
                <MobileCard title="2 · Feed group exclusivity" detail="Two real clips share one media group; selecting one clears the peer intent.">
                  <VideoSurface media={media!} id={FEED_A_ID} asset={VIDEO_LAB_ASSETS.clipA} playing={feedAPlaying()} active={feedAActive()} group={FEED_GROUP} class="w-full h-[132] rounded-xl" />
                  <View class="flex-row flex-wrap gap-2">
                    <MobileButton label="Play clip A" compact onPress={() => setFeed(FEED_A_ID)} />
                    <MobileButton label="Play clip B" compact onPress={() => setFeed(FEED_B_ID)} />
                    <MobileButton label={feedAActive() ? "Hide A" : "Show A"} kind="outlined" compact onPress={() => setActive(feedA, !feedAActive())} />
                    <MobileButton label={feedBActive() ? "Hide B" : "Show B"} kind="outlined" compact onPress={() => setActive(feedB, !feedBActive())} />
                  </View>
                  <VideoSurface media={media!} id={FEED_B_ID} asset={VIDEO_LAB_ASSETS.clipB} playing={feedBPlaying()} active={feedBActive()} group={FEED_GROUP} class="w-full h-[132] rounded-xl" />
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{nativeLabelFor(FEED_A_ID)} · {nativeLabelFor(FEED_B_ID)}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>Selection is expected policy; actual decode/playback is a separate native observation.</Text>
                </MobileCard>
                <MobileCard title="3 · Same id / asset swap + retry" detail="Asset identity changes must not resurrect an explicit pause. Missing asset is intentionally real and retryable.">
                  <VideoSurface media={media!} id={SWAP_ID} asset={swapAsset()} playing={swapPlaying()} active={true} class="w-full h-[120] rounded-xl" />
                  <View class="flex-row flex-wrap gap-2">
                    <MobileButton label={`Swap same id → ${swapAsset() === VIDEO_LAB_ASSETS.clipA ? "clip B" : "clip A"}`} compact onPress={swapSameIdAsset} />
                    <MobileButton label="Play same id" compact onPress={() => { rememberIntent(SWAP_ID, true); setSwapPlaying(true); log("same-id playing intent requested"); }} />
                    <MobileButton label="Pause same id" kind="outlined" compact onPress={() => { rememberIntent(SWAP_ID, false); setSwapPlaying(false); log("same-id explicit pause retained across asset swap"); }} />
                  </View>
                  <VideoSurface media={media!} id={RETRY_ID} asset={retryAsset()} playing={retryPlaying()} active={true} class="w-full h-[120] rounded-xl" />
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{nativeLabelFor(SWAP_ID)} · {nativeLabelFor(RETRY_ID)}</Text>
                  <View class="flex-row flex-wrap gap-2">
                    <MobileButton label={retryAsset() === VIDEO_LAB_ASSETS.missing ? "Retry with clip A" : "Restore failing asset"} kind="outlined" compact onPress={retryMissingAsset} />
                    <MobileButton label="Play retry" compact onPress={() => { rememberIntent(RETRY_ID, true); setRetryPlaying(true); log("retry playing intent requested"); }} />
                    <MobileButton label="Pause retry" kind="text" compact onPress={() => { rememberIntent(RETRY_ID, false); setRetryPlaying(false); log("retry asset paused"); }} />
                  </View>
                </MobileCard>
                <MobileCard title="Supported scope" detail="This page exposes the current Video API only.">
                  <Text class={theme().name === "dark" ? "text-xs text-white" : "text-xs text-[#17233B]"}>Supported: bundled local MP4 assets, fixed loop + muted playback, play/pause intent, lifecycle/coverage gates, feed exclusivity, and native draw visibility.</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>Not exposed: seek/progress, volume, playback-completion callbacks, and network URL assets. These are not part of this test page.</Text>
                </MobileCard>
              </Show>
              <Show when={tab() === "coverage"}>
                <MobileCard title="4 · MiniApp coverage" detail="Root SystemUI remains scheduled; platform.openApp media coverage pauses only registered video.">
                  <Text class={theme().name === "dark" ? "text-xs text-white" : "text-xs text-[#17233B]"}>{miniAppStatus()}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{coverageLabel()}</Text>
                  <View class="flex-row flex-wrap gap-2">
                    <MobileButton label="Other page" kind="outlined" compact onPress={() => { log("navigate away: expected page gate pause"); props.onNavigate("about"); }} />
                  </View>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>After leaving, use Home → Video Lab to return and verify the retained play or pause intent.</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>Background / foreground: send the app to background and return on a real iOS/Android host; this row is manual until native video.state confirms it.</Text>
                  <VideoStateSplit expected={heroPlaying() ? "hero intent playing" : "hero intent paused"} native={nativeLabelFor(HERO_ID)} />
                </MobileCard>
                <MobileCard title="5 · Recent bounded events" detail={`${recent().length}/${RECENT_LIMIT} entries; no polling loop.`}>
                  <For each={recent()}>
                    {(item) => <Text class={theme().name === "dark" ? "text-xs text-white" : "text-xs text-[#17233B]"}>{item}</Text>}
                  </For>
                  <MobileButton label="Clear event log" kind="text" compact onPress={() => setRecent([])} />
                </MobileCard>
              </Show>
              <Show when={tab() === "scroll"}>
                <MobileCard title="6 · Real scroll visibility" detail="Scroll the Video below the retained clip boundary, then return. Native draw visibility is not a JS timer.">
                  <View class="flex-col gap-2 h-[420] items-center justify-center rounded-xl bg-[#EEF1F6]">
                    <Text class={theme().name === "dark" ? "text-sm text-white font-bold" : "text-sm text-[#17233B] font-bold"}>Scroll down to the clip</Text>
                    <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>The content canvas is taller than the viewport.</Text>
                  </View>
                  <VideoSurface media={media!} id={SCROLL_ID} asset={VIDEO_LAB_ASSETS.clipB} playing={scrollPlaying()} active={true} class="w-full h-[176] rounded-xl" />
                  <VideoControls entry={scroll} log={log} label="scroll clip" playLabel="Play scroll clip" pauseLabel="Pause scroll clip" />
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>{nativeLabelFor(SCROLL_ID)}</Text>
                  <Text class={theme().name === "dark" ? "text-xs text-[#B9C5D8]" : "text-xs text-[#7C8799]"}>Expected: while offscreen the native PocketView visibility gate pauses decode; when visible again it follows the retained user intent.</Text>
                </MobileCard>
              </Show>
            </Show>
            <TestMatrix rows={rows} />
          </View>
        </ScrollablePage>
      </MobileScaffold>
  );
}
