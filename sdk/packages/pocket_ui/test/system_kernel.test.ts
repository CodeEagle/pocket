import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { join } from "node:path";

test("Pocket System kernel protocol runs in an isolated Bun process", () => {
  const fixture = join(import.meta.dir, "system_kernel.fixture.ts");
  const bun = Bun.which("bun") ?? process.execPath;
  const result = Bun.spawnSync({
    cmd: [bun, fixture],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assert.equal(
    result.exitCode,
    0,
    `system kernel fixture failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  assert.match(stdout, /SYSTEM_KERNEL_FIXTURE_OK/);
});
