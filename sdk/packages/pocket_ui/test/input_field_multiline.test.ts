import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The probe installs process-wide module mocks, so it runs in its own bun
// process and cannot leak them into other test files.
const probe = join(dirname(fileURLToPath(import.meta.url)), "probe/input_field_multiline.probe.ts");
let run: ReturnType<typeof spawnSync>;
let stdout = "";

beforeAll(() => {
  run = spawnSync(process.execPath, [probe], { encoding: "utf8" });
  stdout = String(run.stdout);
});

test("probe process exits cleanly", () => {
  expect({ status: run.status, stderr: String(run.stderr) }).toEqual({ status: 0, stderr: "" });
});

for (const name of [
  "single-line default payload is unchanged",
  "unbounded multiline uses explicit null maxLines",
  "bounded multiline clamps minLines",
  "invalid line counts fall back",
]) {
  test(name, () => {
    expect(stdout).toContain(`ok ${name}\n`);
  });
}
