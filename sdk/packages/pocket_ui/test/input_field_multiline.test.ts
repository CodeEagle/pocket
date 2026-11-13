import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The probe installs process-wide module mocks, so it runs in its own bun
// process and cannot leak them into other test files.
const probe = join(dirname(fileURLToPath(import.meta.url)), "probe/input_field_multiline.probe.ts");
const run = spawnSync("bun", [probe], { encoding: "utf8" });
assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
assert.match(run.stdout, /multiline payload passed/);
console.log("input_field_multiline.test: payload probe passed");
