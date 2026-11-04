import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

test("a missing SystemUI response is handled without an unhandled rejection", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-editor-system-request-failure-"));
  const project = join(root, "project");
  const probePath = join(root, "probe.mjs");
  const bytecodePath = join(root, "app.qjbc");
  const pakPath = join(root, "app.pak");
  mkdirSync(project);
  await writeFile(bytecodePath, new Uint8Array([0]));
  await writeFile(pakPath, new Uint8Array([0]));
  await writeFile(join(project, "pocket.system.json"), JSON.stringify({
    roles: { systemUI: "pocket.test.system" },
    applications: { catalog: [] },
    installation: { installedPackages: [] },
  }));
  await writeFile(probePath, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
let frame = 0;
let firstRequest = true;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "quit") {
    reply({ ok: true });
    setTimeout(() => process.exit(0), 0);
    return;
  }
  if (command.op === "schedule") {
    reply({ ok: true, nextWakeDelayMs: -1 });
    return;
  }
  if (command.op === "frame") {
    frame += 1;
    const events = firstRequest ? [{ name: "host.request", payload: {
      requestId: "guest-request-1",
      capability: "platform.apps.list",
      params: {},
    } }] : [];
    firstRequest = false;
    reply({ ok: true, frame: { frame, width: 390, height: 360, ops: [], events, resources: [] } });
    return;
  }
  reply({ ok: true });
});
`, "utf8");
  await chmod(probePath, 0o755);

  const manager = createPreviewManager({
    probePath,
    projectDirectory: project,
    commandTimeoutMs: 5_000,
    artifacts: { bytecode: bytecodePath, pak: pakPath, revision: 1, tickHz: 60 },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const response = await manager.handle(
      new Request("http://127.0.0.1/api/projects/system-timeout/preview/stream"),
      "system-timeout",
      "stream",
    );
    assert.equal(response.status, 400);
    assert.match(await response.text(), /SystemUI did not respond to platform\.apps\.list/);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    assert.deepEqual(unhandled, [], `unexpected unhandled rejection: ${String(unhandled[0])}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await manager.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
