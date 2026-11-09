import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient, type PlatformStorageOperation } from "@pocket/ui/platform";
import { createNovelEngine, createNovelSlotManager, type JsonValue, type StoryDefinition } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import storyDocument from "./story.json";
import assetDocument from "./novel.assets.json";

const host = createHostBridge();
const platform = createPocketPlatformClient(undefined, { bridge: host, media: false });
const slots = createNovelSlotManager({
  get: key => platform.storage.get(key),
  set: (key, value) => platform.storage.set(key, value as any),
  remove: key => platform.storage.remove(key),
  keys: () => platform.storage.keys(),
  batch: operations => platform.storage.batch(operations as unknown as readonly PlatformStorageOperation[]),
}, { prefix: "inventory.slot." });

const storage = {
  read: slots.read,
  write: async (slot: string, value: any) => slots.write(slot, value as JsonValue),
  list: slots.list,
  delete: slots.delete,
  copy: slots.copy,
  move: slots.move,
  swap: slots.swap,
};
const story = storyDocument as StoryDefinition;
const assets = assetDocument as NovelAssets;

function App() {
  const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
  const removeClock = attachNovelClock(engine);
  let autoSaveQueue: Promise<void> = Promise.resolve();
  const removeUpdates = engine.subscribe(update => {
    if (!update.snapshot.started || update.snapshot.phase === "disposed") return;
    const save = engine.save();
    autoSaveQueue = autoSaveQueue.catch(() => undefined).then(() => slots.write("auto", save));
  });
  onCleanup(() => {
    removeUpdates();
    removeClock();
    engine.dispose();
    platform.dispose();
    host.dispose();
  });
  return <NovelView
    engine={engine}
    host={host}
    storage={storage}
    assets={assets}
    inventory={story.inventory}
    title="雾港交易路"
    onNewGame={() => engine.newGame()}
  />;
}

mount(App);
