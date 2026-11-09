import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { decodeNovelSaveData } from "../../../sdk/packages/pocket_vn/src/save-codec.ts";
import type { NovelSaveData } from "../../../sdk/packages/pocket_vn/src/types.ts";
import { NativeSession, readNativeArtifacts, textOf, type Frame } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const guestDirectory = resolve(repositoryRoot, "demo/assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(guestDirectory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(guestDirectory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(guestDirectory, "app.bytecode.json");

const artifacts = readNativeArtifacts("POCKET_LANTERN");
const fixturePath = resolve(import.meta.dir, "fixtures/lantern-v5-registry-native-save.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  provenance: {
    bytecodeSha256: string;
    pakSha256: string;
    metadataSha256: string;
    storyVersion: number;
    saveFormatVersion: number;
    activeLineId: string;
    activeLocation: { label: string; index: number };
    activeInputDraft: string;
    nativeInputPath: string[];
  };
  storage: Record<string, unknown>;
};

const storyId = "demo.lantern.misty-last-letter";
const autosaveKey = "lantern.slot.auto";
const draft = "小满平安归港";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

assert.ok(existsSync(artifacts.bytecodePath), "the standard Lantern Guest bytecode artifact exists");
assert.ok(existsSync(artifacts.pakPath), "the standard Lantern Guest PAK artifact exists");
assert.equal(fixture.provenance.storyVersion, 5);
assert.equal(fixture.provenance.saveFormatVersion, 4);
assert.equal(fixture.provenance.activeLineId, "registry_recipient");
assert.deepEqual(fixture.provenance.activeLocation, { label: "registry_open", index: 1 });
assert.equal(fixture.provenance.activeInputDraft, draft);

type RuntimeSave = Record<string, any>;

function currentRawSave(session: NativeSession): RuntimeSave {
  const value = session.storage[autosaveKey] as RuntimeSave | undefined;
  assert.ok(value && value.storyId === storyId, "the saved Lantern journey remains available in native host storage");
  return value!;
}

function compact(value: string): string { return value.replace(/[\s\u200b\ufeff]/g, ""); }

async function waitForSave(
  session: NativeSession,
  initial: Frame,
  predicate: (save: NovelSaveData) => boolean,
  description: string,
): Promise<{ frame: Frame; save: NovelSaveData }> {
  let frame = initial;
  for (let attempt = 0; attempt < 240; attempt++) {
    const save = decodeNovelSaveData(currentRawSave(session));
    if (predicate(save)) return { frame, save };
    frame = await session.frame();
  }
  throw new Error(`native Guest did not reach ${description}: ${JSON.stringify(decodeNovelSaveData(currentRawSave(session)).state.active)}; ${textOf(frame)}`);
}

test("Lantern v5 input autosave migrates across the registry_open call insertion and submits in real v6 Guest", async () => {
  const legacy = decodeNovelSaveData(fixture.storage[autosaveKey]);
  assert.equal(legacy.storyVersion, 5);
  assert.equal(legacy.storyId, storyId);
  const legacyInput = legacy.state.active;
  assert.ok(legacyInput?.kind === "input");
  assert.equal(legacyInput.id, "registry_recipient");
  assert.equal(legacyInput.location.label, "registry_open");
  assert.equal(legacyInput.location.index, 1);
  assert.equal(legacyInput.draft, draft);
  assert.equal(legacy.state.variables.reply_name, undefined);

  const session = new NativeSession(artifacts, {
    width: 360,
    height: 640,
    storage: structuredClone(fixture.storage),
    deadlineMs: 120_000,
  });
  try {
    let frame = await session.boot();
    assert.ok(compact(textOf(frame)).includes(compact("续写 · 继续旅程")),
      "the actual title page offers Continue for the real v5 autosave");
    frame = await session.tap("续写 · 继续旅程", frame);

    const resumed = await waitForSave(session, frame, save => {
      const active = save.state.active;
      return save.storyVersion === 6 && active?.kind === "input" && active.id === "registry_recipient";
    }, "the migrated registry_recipient input");
    frame = resumed.frame;
    const migrated = resumed.save;
    const migratedInput = migrated.state.active;
    assert.ok(migratedInput?.kind === "input");
    assert.equal(migratedInput.location.label, "registry_open");
    assert.equal(migratedInput.location.index, 2,
      "the v5 registry_open[1] input address shifts to v6 registry_open[2] after the new leading call");
    assert.equal(migratedInput.draft, draft, "the six-character uncommitted draft survives revision migration");
    assert.equal(migrated.state.variables.reply_name, undefined, "migration does not commit an unsubmitted input draft");
    assert.deepEqual(migrated.state.callStack, legacy.state.callStack,
      "the inserted shop call is skipped by address migration and is not added to the saved stack");
    assert.deepEqual(migrated.state.variables, legacy.state.variables, "all original variables remain unchanged");
    assert.deepEqual(migrated.state.meta, legacy.state.meta, "all original journey metadata remains unchanged");
    assert.equal(migrated.state.location.label, "registry_open");
    assert.equal(migrated.state.location.index, 3, "the instruction cursor remains immediately after the remapped active input");
    assert.ok(compact(textOf(frame)).includes(compact("收件人姓名")), "the real input prompt is mounted after continue");
    assert.ok(compact(textOf(frame)).includes(compact("提交")), "the existing story Submit action remains available");
    assert.equal(textOf(frame).includes("邮务窗后，Ren 把两只木匣推到灯下"), false,
      "continuing the migrated input does not force the newly inserted shop call");

    frame = await session.tap("提交", frame);
    const submitted = await waitForSave(session, frame, save => {
      const active = save.state.active;
      return save.storyVersion === 6 && active?.kind === "say" && active.id === "registry_02"
        && save.state.variables.reply_name === draft;
    }, "the original post-input registry dialogue");
    frame = submitted.frame;
    assert.ok(String(submitted.save.state.active?.text).includes(draft),
      "the original story interpolates the preserved name after an actual player submit");
    for (let attempt = 0; attempt < 120 && !compact(textOf(frame)).includes(compact(draft)); attempt++) {
      frame = await session.frame();
    }
    assert.ok(compact(textOf(frame)).includes(compact(draft)), "the submitted answer is painted in the live Guest frame");

    console.log("LANTERN_INVENTORY_REVISION_NATIVE", JSON.stringify({
      guestQjbcPath: artifacts.bytecodePath,
      guestQjbcSha256: sha256(artifacts.bytecodePath),
      guestPakPath: artifacts.pakPath,
      guestPakSha256: sha256(artifacts.pakPath),
      guestMetadataPath: artifacts.metadataPath,
      guestMetadataSha256: sha256(artifacts.metadataPath),
      fixturePath,
      fixtureQjbcSha256: fixture.provenance.bytecodeSha256,
      fixturePakSha256: fixture.provenance.pakSha256,
      before: { storyVersion: legacy.storyVersion, active: legacyInput.id, location: legacyInput.location, draft: legacyInput.draft },
      afterContinue: { storyVersion: migrated.storyVersion, active: migratedInput.id, location: migratedInput.location, draft: migratedInput.draft, callStackDepth: migrated.state.callStack.length },
      afterSubmit: { active: submitted.save.state.active?.kind === "say" ? submitted.save.state.active.id : submitted.save.state.active?.kind, replyName: submitted.save.state.variables.reply_name },
      shopCallSkipped: true,
    }));
  } finally {
    await session.quit();
  }
}, 150_000);
