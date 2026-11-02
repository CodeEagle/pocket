import { strict as assert } from "node:assert";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const testDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(testDir, "../src/flutter-widgets.tsx"), "utf8");

for (const name of [
  "FlutterDivider",
  "FlutterLinearProgressIndicator",
  "FlutterChip",
  "FlutterIconButton",
  "FlutterFloatingActionButton",
  "FlutterNavigationDestination",
]) {
  assert.match(source, new RegExp(`export function ${name}`));
}

assert.match(source, /from "@pocketjs\/framework\/solid\/components"/);
assert.match(source, /Focusable/);
assert.match(source, /<View/);
assert.match(source, /<Text/);
assert.match(source, /scaleX: value/);
assert.match(source, /originX: -0\.5/);
assert.match(source, /value: number/);
assert.match(source, /focusable=\{!disabled\(\)\}/);
assert.match(source, /export const Divider = FlutterDivider/);
assert.match(source, /export const NavigationDestination = FlutterNavigationDestination/);

// Compile an independent consumer fixture through the pinned guest pipeline.
// This keeps the SDK test self-contained and verifies that public exports are
// consumable without importing demo internals.
// build_guest materializes @pocket/ui under the consumer's node_modules. Keep
// the consumer outside the package source tree: otherwise copying the SDK
// package would recursively copy its own fixture into itself.
const fixture = join(testDir, "fixture");
const consumer = mkdtempSync(join(tmpdir(), "pocket-ui-flutter-widgets-"));
cpSync(fixture, consumer, { recursive: true });
const buildGuest = join(testDir, "../../../scripts/build_guest.ts");
const retainedOutdir = process.env.POCKET_WIDGET_FIXTURE_OUTDIR;
const output = retainedOutdir ?? mkdtempSync(join(tmpdir(), "pocket-ui-flutter-widgets-build-"));
try {
  const build = spawnSync("bun", [buildGuest, `--project-root=${consumer}`, `--outdir=${output}`], {
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  assert.match(`${build.stdout}\n${build.stderr}`, /QuickJS bytecode|PocketJS build: done/);
} finally {
  rmSync(consumer, { recursive: true, force: true });
  if (!retainedOutdir) rmSync(output, { recursive: true, force: true });
}

if (retainedOutdir) console.log(`flutter_widgets.test: retained fixture artifacts at ${retainedOutdir}`);

console.log("flutter_widgets.test: public Flutter vocabulary adapters and independent guest consumer passed");
