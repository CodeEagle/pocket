import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servePreviewMedia } from "../preview_media_assets.ts";

test("preview video streams full, ranged and HEAD responses without loading source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-video-"));
  try {
    await mkdir(join(root, "assets/videos"), { recursive: true });
    await writeFile(join(root, "assets/videos/test.mp4"), "0123456789");
    const read = (range?: string, method = "GET") => servePreviewMedia(new Request("http://localhost/media", { method, headers: range ? { range } : {} }), root, "assets/videos/test.mp4");
    const full = await read();
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(await full.text()).toBe("0123456789");
    const partial = await read("bytes=2-5");
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");
    expect(await (await read("bytes=-3")).text()).toBe("789");
    expect(await (await read("bytes=8-")).text()).toBe("89");
    expect(await (await read("bytes=8-999")).text()).toBe("89");
    for (const range of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,4-5", "bytes=999999999999999999999-"]) {
      const response = await read(range);
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
    }
    const head = await read(undefined, "HEAD");
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preview video rejects traversal, source reads and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocket-preview-video-safe-"));
  const outside = await mkdtemp(join(tmpdir(), "pocket-preview-video-outside-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(outside, "secret.mp4"), "private");
    await symlink(join(outside, "secret.mp4"), join(root, "assets/link.mp4"));
    await symlink(outside, join(root, "assets/linked"));
    const read = (asset: string) => servePreviewMedia(new Request("http://localhost/media"), root, asset);
    for (const asset of ["../secret.mp4", "assets/../secret.mp4", "assets/./secret.mp4", "assets\\secret.mp4", "assets/a\0.mp4", "/assets/a.mp4"]) {
      expect((await read(asset)).status).toBe(400);
    }
    expect((await read("assets/source.ts")).status).toBe(415);
    expect((await read("assets/link.mp4")).status).toBe(403);
    expect((await read("assets/linked/secret.mp4")).status).toBe(403);
    expect((await read("assets/missing.mp4")).status).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
