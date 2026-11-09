import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import type { NativeArtifacts } from "./native_session.ts";
import {
  materializeNovelCollectionsFixture,
  runNativeCollectionsLayoutAcceptance,
  runNativeCollectionsAcceptance,
  type NovelCollectionsExpectation,
} from "./novel_collections_acceptance.ts";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const expected: NovelCollectionsExpectation = {
  collectionTitle: "港口人物档案",
  publicTitle: "旧车站",
  publicBody: "旧车站公示牌上留下了 preview.png 字样，那只是故事正文，不是图片资源。",
  privateTitle: "Mira 的档案",
  privateBody: "PRIVATE_RECORD_BODY：Mira 曾在雾港灯塔守夜，直到最后一班列车离开。",
  portraitAsset: "art/mira.svg",
};

test("collections unlocks through a real story and persistent progress survives an older manual slot, Guest reload and newGame", { timeout: 240_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-vn-collections-native-"));
  const project = join(temporary, "project");
  const evidenceRoot = process.env.POCKET_COLLECTIONS_ACCEPTANCE_OUTPUT?.trim();
  if (evidenceRoot) mkdirSync(evidenceRoot, { recursive: true });
  const output = evidenceRoot ? join(evidenceRoot, "native-guest") : join(temporary, "guest");
  try {
    materializeNovelCollectionsFixture(project);
    const built = await buildGuest({ projectRoot: project, outDir: output, tickHz: 60 });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the journey must execute the pinned QuickJS bytecode Guest");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    const result = await runNativeCollectionsAcceptance(artifacts, expected);
    assert.equal(result.autoSave.state.meta.persistentVariables.miraRecordUnlocked, true);
    assert.ok((result.finalFrame.ops ?? []).some(op => op.type === "image" && (op as typeof op & { asset?: string }).asset === expected.portraitAsset));
    const wideShortFrame = await runNativeCollectionsLayoutAcceptance(artifacts, result.autoSave, expected);
    if (evidenceRoot) writeFileSync(join(evidenceRoot, "native-result.json"), JSON.stringify({
      compiler: process.env.POCKET_COMPILER_PATH,
      bytecode: built.bytecode,
      pak: built.pak,
      metadata: built.metadata,
      sha256: { bytecode: sha256(built.bytecode), pak: sha256(built.pak), metadata: sha256(built.metadata) },
      persistentUnlock: result.autoSave.state.meta.persistentVariables.miraRecordUnlocked,
      autoActiveAfterNewGame: result.autoSave.state.active?.id,
      manualSlot: "collections.slot.quick",
      layoutViewports: [[360, 800], [800, 600]],
      wideShortFrame: { width: wideShortFrame.width, height: wideShortFrame.height },
    }, null, 2));
    console.info("[novel-collections-native]", JSON.stringify({
      guest: built.bytecode,
      pak: built.pak,
      persistentUnlock: result.autoSave.state.meta.persistentVariables.miraRecordUnlocked,
      finalActive: result.autoSave.state.active?.id,
      manualSlot: "collections.slot.quick",
      layoutViewports: [[360, 800], [800, 600]],
      wideShortFrame: { width: wideShortFrame.width, height: wideShortFrame.height },
    }));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
