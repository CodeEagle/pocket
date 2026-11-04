import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

test("preview media route resolves root and child scoped source directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-media-route-"));
  const child = join(root, "child-source");
  const artifacts = join(root, "artifacts");
  await mkdir(join(root, "assets/videos"), { recursive: true });
  await mkdir(join(child, "assets/videos"), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(root, "assets/videos/root.mp4"), "root-video");
  await writeFile(join(child, "assets/videos/child.mp4"), "child-video");
  const bytecodePath = join(artifacts, "app.qjbc");
  const pakPath = join(artifacts, "app.pak");
  const childBytecodePath = join(artifacts, "child.qjbc");
  const childPakPath = join(artifacts, "child.pak");
  await Promise.all([bytecodePath, pakPath, childBytecodePath, childPakPath].map((path) => writeFile(path, "fixture")));
  const manager = createPreviewManager({
    projectDirectory: root,
    artifacts: {
      bytecodePath,
      pakPath,
      applications: {
        "pocket.test.child": {
          bytecodePath: childBytecodePath,
          pakPath: childPakPath,
          appId: "pocket.test.child",
          projectDirectory: child,
        },
      },
    },
  });
  const projectId = "media-route";
  const endpoint = `http://127.0.0.1/api/projects/${projectId}/preview/media`;
  try {
    const rootResponse = await manager.handle(
      new Request(`${endpoint}?asset=${encodeURIComponent("assets/videos/root.mp4")}`),
      projectId,
      "media",
    );
    assert.equal(rootResponse.status, 200);
    assert.equal(await rootResponse.text(), "root-video");

    const scopedAsset = "pocket.runtime.pocket.test.child.assets/videos/child.mp4";
    const childResponse = await manager.handle(
      new Request(`${endpoint}?asset=${encodeURIComponent(scopedAsset)}`),
      projectId,
      "media",
    );
    assert.equal(childResponse.status, 200);
    assert.equal(await childResponse.text(), "child-video");

    const unknownChild = await manager.handle(
      new Request(`${endpoint}?asset=${encodeURIComponent("pocket.runtime.pocket.unknown.assets/videos/child.mp4")}`),
      projectId,
      "media",
    );
    assert.equal(unknownChild.status, 404);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
