import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { NativeSession, textOf, type Frame } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");

test("pinned guest slot manager preserves saves and uses host atomic batch without a fallback", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-slots-native-"));
  const sessions: NativeSession[] = [];
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-vn-slots-native-fixture",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${join(repositoryRoot, "sdk/packages/pocket_ui")}`,
        "@pocket/vn": `file:${join(repositoryRoot, "sdk/packages/pocket_vn")}`,
      },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.vn-slots-fixture",
      version: "0.1.0",
      app: {
        entry: "app.tsx",
        output: "vn-slots-fixture",
        framework: "solid",
        viewport: { fixed: { logical: [360, 640], presentation: "native" } },
      },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [
      "platform.storage.get",
      "platform.storage.set",
      "platform.storage.remove",
      "platform.storage.keys",
      "platform.storage.batch",
    ] } }));

    const rawSave = {
      storyId: "retained-lantern",
      storyVersion: 7,
      state: {
        location: "chapter:3",
        variables: { trust: 4 },
        stage: { background: "harbor", characters: ["mira", "jo"] },
        meta: { completed: ["ending-dawn"] },
        rollback: [{ location: "chapter:2", typedValue: false }],
      },
      extension: {
        canonicalLocale: "ja",
        opaque: { ordered: ["保留", false, null, 4.25], labels: { source: "canonical" } },
      },
    };
    const alternateSave = {
      storyId: "retained-lantern",
      storyVersion: 8,
      state: { location: "chapter:5", variables: { trust: 8 } },
      extension: { canonicalLocale: "fr", opaque: ["retain", 2] },
    };
    writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { createNovelSlotManager } from "@pocket/vn";

const host = createHostBridge();
const platform = createPocketPlatformClient(undefined, { bridge: host });
const slots = createNovelSlotManager(platform.storage, { prefix: "fixture.slot." });
const rawSave = ${JSON.stringify(rawSave)};
const alternateSave = ${JSON.stringify(alternateSave)};

function codeOf(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "unknown";
}

function canonical(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}

function App() {
  const [status, setStatus] = createSignal("booting");
  void (async () => {
    await slots.write("1", rawSave);
    await slots.copy("1", "2");
    const copied = await slots.read("2");
    const roundTrip = canonical(copied) === canonical(rawSave);
    await slots.write("4", alternateSave);
    const before = await slots.list();

    let swapCode = "unexpected-success";
    try { await slots.swap("2", "4"); swapCode = "ok"; } catch (error) { swapCode = codeOf(error); }
    let moveCode = "unexpected-success";
    try { await slots.move("1", "3"); moveCode = "ok"; } catch (error) { moveCode = codeOf(error); }
    const after = await slots.list();

    await slots.delete("4");
    const finalIds = await slots.list();
    let malformedCode = "unexpected-success";
    try {
      await host.request("platform.storage.batch", { operations: [
        { type: "set", key: "fixture.slot.2", value: { shouldNotCommit: true } },
        { type: "invalid", key: "fixture.slot.bad" },
      ] });
    } catch (error) { malformedCode = codeOf(error); }
    setStatus("done:" + roundTrip + ":" + swapCode + ":" + moveCode + ":" + malformedCode + ":" +
      before.join(",") + ":" + after.join(",") + ":" + finalIds.join(","));
  })().catch(error => setStatus("failed:" + String(error)));

  return <View class="w-full h-full bg-[#08151D]"><Text>{status()}</Text></View>;
}

mount(App);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "fixture must execute pinned QJBC, not source JS");
    const artifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    const initialStorage = {
      "fixture.slotter.keep-out": { owner: "unrelated-prefix" },
      "unrelated.key": { untouched: true },
    };

    const run = async (supportsStorageBatch: boolean): Promise<{ session: NativeSession; label: string }> => {
      const session = new NativeSession(artifacts, {
        width: 360,
        height: 640,
        deadlineMs: 60_000,
        supportsStorageBatch,
        // NativeSession models the host callback with an in-memory map. This
        // verifies guest/platform behavior, not Flutter's disk-reopen boundary.
        storage: JSON.parse(JSON.stringify(initialStorage)) as Record<string, any>,
      });
      sessions.push(session);
      let frame: Frame = await session.boot();
      for (let index = 0; index < 120 && !textOf(frame).includes("done:"); index += 1) {
        frame = await session.frame();
      }
      return { session, label: textOf(frame) };
    };

    const unsupported = await run(false);
    assert.equal(unsupported.label, "done:true:capability_unavailable:capability_unavailable:capability_unavailable:1,2,4:1,2,4:1,2",
      "an unsupported host must reject swap/move and malformed batch without changing slots");
    expect(unsupported.session.storage["fixture.slot.1"]).toEqual(rawSave);
    expect(unsupported.session.storage["fixture.slot.2"]).toEqual(rawSave);
    expect(unsupported.session.storage["fixture.slot.3"]).toBeUndefined();
    expect(unsupported.session.storage["fixture.slot.4"]).toBeUndefined();
    expect(unsupported.session.storage["fixture.slotter.keep-out"]).toEqual({ owner: "unrelated-prefix" });
    expect(unsupported.session.storage["unrelated.key"]).toEqual({ untouched: true });
    expect(unsupported.session.storageBatches).toEqual([]);
    expect(unsupported.session.requests
      .filter(request => request.capability === "platform.storage.set")
      .map(request => request.params.key))
      .toEqual(["fixture.slot.1", "fixture.slot.2", "fixture.slot.4"]);
    expect(unsupported.session.requests
      .filter(request => request.capability === "platform.storage.remove")
      .map(request => request.params.key))
      .toEqual(["fixture.slot.4"]);
    expect(unsupported.session.requests.filter(request => request.capability === "platform.storage.batch"))
      .toHaveLength(3);
    await unsupported.session.quit();
    sessions.splice(sessions.indexOf(unsupported.session), 1);

    const supported = await run(true);
    assert.equal(supported.label, "done:true:ok:ok:invalid_storage_operation:1,2,4:2,3,4:2,3",
      "a supported host must commit swap/move and reject a malformed batch atomically");
    expect(supported.session.storage["fixture.slot.1"]).toBeUndefined();
    expect(supported.session.storage["fixture.slot.2"]).toEqual(alternateSave);
    expect(supported.session.storage["fixture.slot.3"]).toEqual(rawSave);
    expect(supported.session.storage["fixture.slot.4"]).toBeUndefined();
    expect(supported.session.storage["fixture.slotter.keep-out"]).toEqual({ owner: "unrelated-prefix" });
    expect(supported.session.storage["unrelated.key"]).toEqual({ untouched: true });
    expect(supported.session.storageBatches).toEqual([
      [
        { type: "set", key: "fixture.slot.2", value: alternateSave },
        { type: "set", key: "fixture.slot.4", value: rawSave },
      ],
      [
        { type: "set", key: "fixture.slot.3", value: rawSave },
        { type: "remove", key: "fixture.slot.1" },
      ],
    ]);
    expect(supported.session.requests.filter(request => request.capability === "platform.storage.batch"))
      .toHaveLength(3);
    expect(supported.session.requests
      .filter(request => request.capability === "platform.storage.remove")
      .map(request => request.params.key))
      .toEqual(["fixture.slot.4"]);
  } finally {
    for (const session of sessions) await session.quit();
    rmSync(project, { recursive: true, force: true });
  }
}, 120_000);
