import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { NativeSession, textOf, type Frame } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const storageKey = "codec.acceptance.save";
const backlogLimit = 128;
const rollbackLimit = 48;
const deepValue: Record<string, unknown> = {};
let deepCursor = deepValue;
for (let index = 0; index < 140; index += 1) {
  const child: Record<string, unknown> = {};
  deepCursor.next = child;
  deepCursor = child;
}
deepCursor.done = true;
const deepStory = {
  id: "native-save-codec-deep-json",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "say", id: "deep-first", text: "The first deep-value line." },
      { type: "say", id: "deep-second", text: "The second deep-value line." },
      { type: "ending", id: "deep-finish" },
    ],
  },
};
const story = {
  id: "native-save-codec-acceptance",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: `station-${"x".repeat(900)}` },
      { type: "audio", cue: `music-${"a".repeat(500)}`, channel: "music", loop: true },
      ...Array.from({ length: 140 }, (_, index) => ({
        type: "say",
        id: `line-${index}`,
        speaker: "Mira",
        text: "A repeated dialogue sentence exercises bounded backlog and rollback history.",
      })),
      { type: "ending", id: "finish", text: "The letter is sealed." },
    ],
  },
};

test("pinned QuickJS guest stores V4, reloads it, and rolls back the complete history", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-save-codec-native-"));
  let session: NativeSession | undefined;
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-vn-save-codec-native-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${join(repositoryRoot, "sdk/packages/pocket_ui")}`,
        "@pocket/vn": `file:${join(repositoryRoot, "sdk/packages/pocket_vn")}`,
      },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.vn-save-codec-native-fixture",
      version: "0.1.0",
      app: {
        entry: "app.tsx",
        output: "vn-save-codec-fixture",
        framework: "solid",
        viewport: { fixed: { logical: [360, 640], presentation: "native" } },
      },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [
      "platform.storage.get",
      "platform.storage.set",
    ] } }));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { createNovelEngine, decodeNovelSaveData, encodeNovelSaveData } from "@pocket/vn";

const story = ${JSON.stringify(story)};
const deepStory = ${JSON.stringify(deepStory)};
const deepValue = ${JSON.stringify(deepValue)};
const platform = createPocketPlatformClient(undefined, { bridge: createHostBridge() });
const storageKey = ${JSON.stringify(storageKey)};
const engineOptions = { maxBacklogEntries: ${backlogLimit}, maxRollbackEntries: ${rollbackLimit}, initialVariables: {
  trust: 3,
  archiveToken: "${"v".repeat(256)}",
} };
let deepCodecDepth = -1;

function depthOf(value: any): number {
  let depth = 0;
  let current = value;
  while (current && typeof current === "object" && Object.hasOwn(current, "next")) {
    depth += 1;
    current = current.next;
  }
  return current?.done === true ? depth : -1;
}

function activeLabel(engine: ReturnType<typeof createNovelEngine>): string {
  const active = engine.getSnapshot().active;
  return active ? active.kind + ":" + active.id : "none";
}

function exerciseDeepJsonInGuest(): number {
  const source = createNovelEngine(deepStory, { initialVariables: { deepValue } });
  const restored = createNovelEngine(deepStory);
  try {
    source.start();
    source.advance();
    source.advance(); // Keep the 140-layer value in a rollback pool.
    const compact = encodeNovelSaveData(source.save());
    const expanded = decodeNovelSaveData(compact);
    if (depthOf(expanded.state.variables.deepValue) !== 140) throw new Error("deep V4 decode changed the 140-layer variable");
    restored.load(compact);
    deepCodecDepth = depthOf(restored.getSnapshot().variables.deepValue);
    restored.rollback();
    if (restored.getSnapshot().active?.id !== "deep-first"
        || depthOf(restored.getSnapshot().variables.deepValue) !== 140) {
      throw new Error("deep V4 engine load and rollback did not retain the variable");
    }
    return deepCodecDepth;
  } finally {
    source.dispose();
    restored.dispose();
  }
}

function App() {
  const [status, setStatus] = createSignal("booting");
  const [paintedActive, setPaintedActive] = createSignal("none");

  async function prepareSave(): Promise<void> {
    const guestDeepDepth = exerciseDeepJsonInGuest();
    if (guestDeepDepth !== 140) throw new Error("QuickJS codec did not retain the deep JSON value");
    const source = createNovelEngine(story, engineOptions);
    source.start();
    for (let index = 0; index < 200; index += 1) {
      const active = source.getSnapshot().active;
      if (active?.kind === "ending") break;
      if (active?.kind !== "say") throw new Error("long story stopped at an unexpected instruction");
      if (!active.complete) source.advance();
      source.advance();
    }
    const sourceSnapshot = source.getSnapshot();
    if (sourceSnapshot.active?.kind !== "ending" || sourceSnapshot.backlog.length !== ${backlogLimit}
        || sourceSnapshot.rollbackAvailable !== ${rollbackLimit}) {
      throw new Error("fixture did not fill both configured history caps");
    }

    const compact = encodeNovelSaveData(source.save());
    // V3 persisted backlog and rollback-active text independently. Keep its
    // deployed tuple shape and earlier object-active shape readable.
    const deployedV3 = JSON.parse(JSON.stringify(compact)) as any;
    const oldTextPool = deployedV3.state.textPool as string[];
    deployedV3.state.backlog = deployedV3.state.backlog.map((entry: unknown[]) => [
      ...entry.slice(0, 6),
      oldTextPool[entry[6] as number],
    ]);
    deployedV3.state.rollbackHistory.pools.active = deployedV3.state.rollbackHistory.pools.active.map((entry: unknown[]) => [
      ...entry.slice(0, 5),
      oldTextPool[entry[5] as number],
      entry[6],
      entry[7],
    ]);
    delete deployedV3.state.textPool;
    deployedV3.formatVersion = 3;
    const firstV3 = JSON.parse(JSON.stringify(deployedV3)) as any;
    firstV3.state.rollbackHistory.pools.active = firstV3.state.rollbackHistory.pools.active.map((entry: unknown[]) => ({
      kind: "say",
      location: { label: entry[0], index: entry[1] },
      id: entry[2],
      speaker: entry[3],
      portrait: entry[4],
      text: entry[5],
      revealProgress: entry[6],
      visibleText: entry[5],
      revealedCharacters: Array.from(entry[5] as string).length,
      complete: true,
      autoRemainingMs: entry[7],
    }));
    const compatible = createNovelEngine(story, engineOptions);
    const compatibleTuple = createNovelEngine(story, engineOptions);
    try {
      compatible.load(firstV3);
      if (JSON.stringify(compatible.getSnapshot()) !== JSON.stringify(sourceSnapshot)) {
        throw new Error("the previously persisted object-active V3 save changed after loading");
      }
      compatibleTuple.load(deployedV3);
      if (JSON.stringify(compatibleTuple.getSnapshot()) !== JSON.stringify(sourceSnapshot)) {
        throw new Error("the deployed tuple-active V3 save changed after loading");
      }
    } finally {
      compatible.dispose();
      compatibleTuple.dispose();
    }
    await platform.storage.set(storageKey, compact);
    const stored = await platform.storage.get(storageKey);
    if (!stored || typeof stored !== "object") throw new Error("host did not return the stored V4 save");
    const activePool = (stored as any).state.rollbackHistory.pools.active as unknown[];
    if (!activePool.length || !activePool.every(entry => Array.isArray(entry) && entry.length === 8
        && Number.isSafeInteger(entry[5]) && Number.isSafeInteger(entry[6]))) {
      throw new Error("V4 active checkpoints must use eight-field say tuples with shared text references");
    }

    // Exercise the production atomic load path against an invalid pool ref.
    // The live engine must keep its previous snapshot when compact decode fails.
    function failedLoadIsAtomic(tampered: unknown): boolean {
      const atomicEngine = createNovelEngine(story, engineOptions);
      atomicEngine.start();
      const beforeTamperedLoad = JSON.stringify(atomicEngine.save());
      let rejected = false;
      try { atomicEngine.load(tampered); } catch { rejected = true; }
      const unchanged = rejected && JSON.stringify(atomicEngine.save()) === beforeTamperedLoad;
      atomicEngine.dispose();
      return unchanged;
    }
    const badReference = JSON.parse(JSON.stringify(stored)) as any;
    badReference.state.rollbackHistory.entries[0][4] = 99999;
    const badLength = JSON.parse(JSON.stringify(stored)) as any;
    badLength.state.rollbackHistory.entries[0].pop();
    const badActiveLength = JSON.parse(JSON.stringify(stored)) as any;
    badActiveLength.state.rollbackHistory.pools.active[0].pop();
    const inconsistentActiveReveal = JSON.parse(JSON.stringify(stored)) as any;
    inconsistentActiveReveal.state.rollbackHistory.pools.active[0][6] += 1;
    const badBacklogTextReference = JSON.parse(JSON.stringify(stored)) as any;
    badBacklogTextReference.state.backlog[0][6] = 99999;
    const badActiveTextReference = JSON.parse(JSON.stringify(stored)) as any;
    badActiveTextReference.state.rollbackHistory.pools.active[0][5] = 99999;
    const mixedActivePool = JSON.parse(JSON.stringify(stored)) as any;
    mixedActivePool.state.rollbackHistory.pools.active[0] = firstV3.state.rollbackHistory.pools.active[0];
    const atomic = failedLoadIsAtomic(badReference) && failedLoadIsAtomic(badLength)
      && failedLoadIsAtomic(badActiveLength) && failedLoadIsAtomic(inconsistentActiveReveal)
      && failedLoadIsAtomic(badBacklogTextReference) && failedLoadIsAtomic(badActiveTextReference)
      && failedLoadIsAtomic(mixedActivePool);
    source.dispose();
    if (!atomic) throw new Error("malformed V4 pool/text reference, tuple length or active reveal changed live engine state");

    setPaintedActive("ending:finish");
    setStatus("ready:" + compact.formatVersion + ":" + compact.state.backlog.length + ":" +
      compact.state.rollbackHistory.entries.length + ":deep=" + guestDeepDepth + ":atomic");
  }

  async function loadAndRollback(): Promise<void> {
    const stored = await platform.storage.get(storageKey);
    if (!stored || typeof stored !== "object") throw new Error("stored V4 save is missing");
    const restored = createNovelEngine(story, engineOptions);
    restored.load(stored);
    const loaded = restored.save();
    if (loaded.state.backlog.length !== ${backlogLimit} || loaded.state.rollbackHistory.length !== ${rollbackLimit}) {
      throw new Error("V4 load did not retain every bounded backlog entry and checkpoint");
    }
    restored.rollback();
    const snapshot = restored.getSnapshot();
    const active = activeLabel(restored);
    setPaintedActive(active);
    setStatus("restored:" + active + ":" + loaded.state.backlog.length + ":" +
      loaded.state.rollbackHistory.length + ":" + snapshot.backlog.length + ":" + snapshot.rollbackAvailable +
      ":trust=" + String(snapshot.variables.trust) + ":deep=" + deepCodecDepth);
  }

  void prepareSave().catch(error => setStatus("failed:" + String(error)));

  return <View class="flex-col w-full h-full bg-[#08151D] p-6">
    <Text>{status()}</Text>
    <Text>{paintedActive()}</Text>
    <Focusable onPress={() => { void loadAndRollback().catch(error => setStatus("failed:" + String(error))); }}>
      <View class="w-full h-[48] justify-center px-4 border border-[#31454B]">
        <Text>Load V4 and rollback</Text>
      </View>
    </Focusable>
  </View>;
}

mount(App);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the codec must run through pinned QuickJS bytecode");
    session = new NativeSession({
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    }, {
      width: 360,
      height: 640,
      deadlineMs: 90_000,
      // This injected map models the host callback only. Durable OS-file and
      // host-recreation persistence are covered by Flutter platform tests.
      storage: { "unrelated.key": { keep: true } },
    });

    let frame: Frame = await session.boot();
    for (let index = 0; index < 120 && !textOf(frame).includes("ready:"); index += 1) {
      frame = await session.frame();
    }
    assert.match(textOf(frame), /ready:4:128:48:deep=140:atomic/, "guest should store compact V4 after a bounded real-engine route with deep JSON");
    assert.match(textOf(frame), /ending:finish/, "the saved story ending should be visible in the native draw list");

    const save = session.storage[storageKey] as Record<string, any> | undefined;
    assert.ok(save, "the real guest platform.storage.set call must reach the injected host store");
    assert.equal(save!.format, "pocket-vn-save");
    assert.equal(save!.formatVersion, 4, "the actual persisted record must advertise V4");
    assert.equal(save!.state.backlog.length, backlogLimit, "all bounded backlog records must be present in the persisted JSON");
    assert.equal(save!.state.rollbackHistory.entries.length, rollbackLimit, "all bounded rollback checkpoints must be present in the persisted JSON");
    assert.ok(session.storageGets.some(params => params.key === storageKey), "the guest must read the host-returned save before load");
    assert.ok(session.storageSets.some(params => params.key === storageKey), "the guest must write V4 through the platform storage boundary");
    const serializedBytes = Buffer.byteLength(JSON.stringify(save), "utf8");
    assert.ok(serializedBytes <= 65_536,
      `the host-observed UTF-8 JSON value must fit the native per-record limit (got ${serializedBytes})`);
    console.log(`novel_save_codec_native: host-observed V4=${serializedBytes}B, backlog=${save!.state.backlog.length}, rollback=${save!.state.rollbackHistory.entries.length}`);
    assert.deepEqual(session.storage["unrelated.key"], { keep: true }, "the save route must not mutate unrelated host storage");

    frame = await session.tap("Load V4 and rollback", frame);
    for (let index = 0; index < 120 && !textOf(frame).includes("restored:"); index += 1) {
      frame = await session.frame();
    }
    assert.match(textOf(frame), /restored:say:line-139:128:48:127:47:trust=3:deep=140/,
      "the UI must paint the reloaded dialogue after one real engine rollback, with typed variables and remaining history intact");
  } finally {
    if (session) await session.quit();
    rmSync(project, { recursive: true, force: true });
  }
}, 120_000);
