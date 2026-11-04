import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewManager } from "../preview.ts";

test("reloading a preview page reads the updated client script", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocket-preview-reload-"));
  const clientPath = join(directory, "preview.js");
  const manager = createPreviewManager({ clientPath });
  const url = "http://127.0.0.1/api/projects/reload/preview";
  try {
    await writeFile(clientPath, "globalThis.previewVersion = 1;");
    const first = await manager.handle(new Request(url), "reload", "page");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.text()).toContain("previewVersion = 1");
    await writeFile(clientPath, "globalThis.previewVersion = 2;");
    const second = await manager.handle(new Request(url), "reload", "page");
    expect(await second.text()).toContain("previewVersion = 2");
  } finally {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
