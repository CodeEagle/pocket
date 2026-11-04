import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startEditor } from "../server.ts";

const clientRoot = resolve(import.meta.dir, "../client");

test("editor page versions JS/CSS links from their mtimes and disables asset caching", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-editor-cache-busting-"));
  const server = await startEditor({ port: 0, workspace });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const cssVersion = String(Math.trunc(statSync(join(clientRoot, "editor.css")).mtimeMs));
    const jsVersion = String(Math.trunc(statSync(join(clientRoot, "editor.js")).mtimeMs));

    const firstPage = await fetch(`${origin}/`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.headers.get("cache-control")).toBe("no-store");
    const html = await firstPage.text();
    expect(html).toContain(`/editor.css?v=${cssVersion}`);
    expect(html).toContain(`/editor.js?v=${jsVersion}`);
    expect(html).not.toContain('href="/editor.css"');
    expect(html).not.toContain('src="/editor.js"');

    const [css, js] = await Promise.all([
      fetch(`${origin}/editor.css?v=${cssVersion}`),
      fetch(`${origin}/editor.js?v=${jsVersion}`),
    ]);
    expect(css.status).toBe(200);
    expect(js.status).toBe(200);
    expect(css.headers.get("cache-control")).toBe("no-store");
    expect(js.headers.get("cache-control")).toBe("no-store");

    // The route is keyed by pathname, so arbitrary cache keys still serve the
    // same real asset rather than falling through to a 404.
    expect((await fetch(`${origin}/editor.css?v=another-key`)).status).toBe(200);
    expect((await fetch(`${origin}/editor.js?v=another-key`)).status).toBe(200);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});
