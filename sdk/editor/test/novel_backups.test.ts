import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import { createNovelBackup, listNovelBackups, NovelBackupError, restoreNovelBackup } from "../novel-backups.ts";

async function makeFixture(): Promise<{ root: string; project: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "pocket-editor-backup-"));
  const project = join(root, "project");
  const workspace = join(root, "editor-workspace");
  await mkdir(project);
  await mkdir(workspace);
  return { root, project, workspace };
}

function options(projectRoot: string, workspaceRoot: string) {
  return { projectRoot, workspaceRoot, projectId: "backup-test" } as const;
}

test("backup restores authored source and binary assets while generated output stays outside the snapshot", async () => {
  const fixture = await makeFixture();
  const projectOptions = options(fixture.project, fixture.workspace);
  try {
    const authored = {
      "story.json": Buffer.from('{"title":"before"}\n'),
      "src/build/custom-consumer.ts": Buffer.from("export const source = true;\n"),
      "assets/keys/public.png": Buffer.from([137, 80, 78, 71, 1, 2, 3]),
      "assets/runtime.wasm": Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
      "assets/game.pak": Buffer.from([0, 1, 2, 255]),
      "assets/model.moc3": Buffer.from([0, 77, 79, 67, 51, 1, 2]),
      "assets/app.qjbc": Buffer.from("consumer-owned nested artifact"),
    };
    for (const [path, content] of Object.entries(authored)) {
      const fullPath = join(fixture.project, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }
    const executable = join(fixture.project, "src", "run.sh");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await mkdir(join(fixture.project, "build"));
    await writeFile(join(fixture.project, "build", "generated.js"), "generated build output");
    await mkdir(join(fixture.project, "node_modules", "sample"), { recursive: true });
    await writeFile(join(fixture.project, "node_modules", "sample", "index.js"), "dependency cache");
    await writeFile(join(fixture.project, "app.qjbc"), "generated guest bytecode");

    const backup = await createNovelBackup(projectOptions);
    assert.equal(backup.manifestValid, true);
    assert.equal(backup.fileCount, Object.keys(authored).length + 1);
    assert.equal(await readFile(join(fixture.workspace, "backups", "backup-test", backup.id, "files", "assets", "runtime.wasm")).then(bytes => bytes.equals(authored["assets/runtime.wasm"])), true);
    assert.equal(await readFile(join(fixture.workspace, "backups", "backup-test", backup.id, "files", "assets", "game.pak")).then(bytes => bytes.equals(authored["assets/game.pak"])), true);
    assert.equal(await readFile(join(fixture.workspace, "backups", "backup-test", backup.id, "files", "src", "build", "custom-consumer.ts"), "utf8"), "export const source = true;\n");

    await writeFile(join(fixture.project, "story.json"), '{"title":"changed"}\n');
    await writeFile(join(fixture.project, "assets", "runtime.wasm"), Buffer.from("changed"));
    await rm(join(fixture.project, "assets", "game.pak"));
    await writeFile(join(fixture.project, "added.txt"), "remove me on restore");
    const restored = await restoreNovelBackup(projectOptions, backup.id);
    assert.equal(restored.restored.id, backup.id);
    assert.notEqual(restored.recoveryBackupId, backup.id);
    assert.deepEqual(await readFile(join(fixture.project, "story.json")), authored["story.json"]);
    assert.deepEqual(await readFile(join(fixture.project, "assets", "runtime.wasm")), authored["assets/runtime.wasm"]);
    assert.deepEqual(await readFile(join(fixture.project, "assets", "game.pak")), authored["assets/game.pak"]);
    assert.deepEqual(await readFile(join(fixture.project, "assets", "model.moc3")), authored["assets/model.moc3"]);
    assert.deepEqual(await readFile(join(fixture.project, "assets", "keys", "public.png")), authored["assets/keys/public.png"]);
    assert.deepEqual(await readFile(join(fixture.project, "assets", "app.qjbc")), authored["assets/app.qjbc"]);
    assert.equal(await readFile(executable, "utf8"), "#!/bin/sh\nexit 0\n");
    assert.equal((await stat(executable)).mode & 0o777, 0o755);
    await assert.rejects(readFile(join(fixture.project, "added.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(fixture.project, "build", "generated.js"), "utf8"), "generated build output");
    assert.equal(await readFile(join(fixture.project, "app.qjbc"), "utf8"), "generated guest bytecode");
    assert.equal(await readFile(join(fixture.project, "node_modules", "sample", "index.js"), "utf8"), "dependency cache");
    assert.ok((await listNovelBackups(projectOptions)).some(item => item.id === restored.recoveryBackupId));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("automatic checkpoints reuse identical complete snapshots, while manual checkpoints remain explicit", async () => {
  const fixture = await makeFixture();
  const projectOptions = options(fixture.project, fixture.workspace);
  try {
    await writeFile(join(fixture.project, "story.json"), "same source\n");
    const first = await createNovelBackup(projectOptions);
    const unchanged = await createNovelBackup({ ...projectOptions, skipUnchanged: true });
    const manual = await createNovelBackup(projectOptions);
    assert.equal(unchanged.id, first.id);
    assert.notEqual(manual.id, first.id);
    const listed = await listNovelBackups(projectOptions);
    assert.equal(listed.length, 2);
    assert.ok(listed.every(item => item.manifestValid));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("corrupt payloads and path traversal are rejected before project mutation", async () => {
  const fixture = await makeFixture();
  const projectOptions = options(fixture.project, fixture.workspace);
  try {
    await writeFile(join(fixture.project, "story.json"), "original\n");
    const backup = await createNovelBackup(projectOptions);
    const payloadFile = join(fixture.workspace, "backups", "backup-test", backup.id, "files", "story.json");
    await writeFile(join(fixture.project, "story.json"), "keep current value\n");
    await writeFile(payloadFile, "corrupted backup\n");
    await assert.rejects(restoreNovelBackup(projectOptions, backup.id), NovelBackupError);
    assert.equal(await readFile(join(fixture.project, "story.json"), "utf8"), "keep current value\n");

    const manifestPath = join(fixture.workspace, "backups", "backup-test", backup.id, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].path = "../escape.txt";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(restoreNovelBackup(projectOptions, backup.id), NovelBackupError);
    await assert.rejects(readFile(join(fixture.root, "escape.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(fixture.project, "story.json"), "utf8"), "keep current value\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unsupported project symlinks are never followed into an external target", async () => {
  const fixture = await makeFixture();
  const projectOptions = options(fixture.project, fixture.workspace);
  try {
    const outside = join(fixture.root, "secret.txt");
    await writeFile(outside, "outside project");
    await symlink(outside, join(fixture.project, "linked.txt"));
    await assert.rejects(createNovelBackup(projectOptions), NovelBackupError);
    assert.equal(await readFile(outside, "utf8"), "outside project");
    assert.deepEqual(await listNovelBackups(projectOptions), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
