import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import type { NativeArtifacts } from "./native_session.ts";
import {
  defaultInventoryCatalog,
  materializeNovelInventoryFixture,
  runNativeInventoryAcceptance,
} from "./novel_inventory_acceptance.ts";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("native inventory uses choice-driven trades and persists save-scoped currency/quantities", { timeout: 360_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-vn-inventory-native-"));
  const project = join(temporary, "project");
  const evidenceRoot = process.env.POCKET_INVENTORY_ACCEPTANCE_OUTPUT?.trim();
  if (evidenceRoot) mkdirSync(evidenceRoot, { recursive: true });
  const output = evidenceRoot ? join(evidenceRoot, "native-guest") : join(temporary, "guest");
  try {
    materializeNovelInventoryFixture(project);
    const built = await buildGuest({ projectRoot: project, outDir: output, tickHz: 60 });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "the shop journey must execute the pinned QuickJS bytecode Guest");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    const result = await runNativeInventoryAcceptance(artifacts);
    assert.deepEqual(result.finalSave.state.variables, {
      harborCoins: 30,
      lampCount: 0,
      editorLampStock: 0,
      rationCount: 1,
      chartCount: 0,
    });
    if (evidenceRoot) writeFileSync(join(evidenceRoot, "native-result.json"), JSON.stringify({
      compiler: process.env.POCKET_COMPILER_PATH,
      bytecode: built.bytecode,
      pak: built.pak,
      metadata: built.metadata,
      sha256: { bytecode: sha256(built.bytecode), pak: sha256(built.pak), metadata: sha256(built.metadata) },
      inventory: defaultInventoryCatalog,
      finalVariables: result.finalSave.state.variables,
      checks: ["default inventory panel", "buy", "sell", "consume", "insufficient funds", "insufficient stock", "max quantity", "all failed trades preserve all inventory variables", "old manual quick-slot load", "rollback", "newGame defaults"],
      viewport: { width: 360, height: 800 },
    }, null, 2));
    console.info("[novel-inventory-native]", JSON.stringify({
      guest: built.bytecode,
      pak: built.pak,
      finalVariables: result.finalSave.state.variables,
      viewport: { width: 360, height: 800 },
    }));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
