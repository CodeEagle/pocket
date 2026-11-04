import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

test("compiler UI backups do not block project loading; backup symlinks remain rejected", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-editor-input-cache-"));
  const project = join(workspace, "projects/cache-test");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "cache-test", app: { entry: "app.tsx", framework: "solid" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(project, "app.tsx"), "export {};\n");
  const backup = join(project, ".pocket-ui-backup-Ab1234");
  mkdirSync(backup);
  symlinkSync("/nonexistent-generated-package", join(backup, "ui"));
  const server = await startEditor({ workspace, projectRoot: project, port: 0 });
  const url = `http://127.0.0.1:${server.port}/api/projects/cache-test/files`;
  try {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    rmSync(backup, { recursive: true });
    symlinkSync("/nonexistent-generated-package", backup);
    const rejected = await fetch(url);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("unsupported source symlink");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});
