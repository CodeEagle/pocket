import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startEditor } from "../server.ts";

test("Novel saves participate in Editor revisions and rejected edits preserve the source", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-novel-service-"));
  const project = mkdtempSync(join(tmpdir(), "pocket-novel-project-"));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "example.novel", name: "novel-project", version: "0.1.0", app: { entry: "app.tsx", framework: "solid" } }));
  writeFileSync(join(project, "app.tsx"), "export {};\n");
  const story = { id: "example-novel", version: 1, start: "start", script: { start: [{ type: "say", id: "intro", text: "Before editing." }, { type: "ending", id: "end" }] } };
  writeFileSync(join(project, "story.json"), JSON.stringify(story));
  writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }));
  const server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
  const origin = `http://127.0.0.1:${server.port}`;
  const base = "/api/projects/novel-project";
  const request = (path: string, body?: unknown) => fetch(origin + path, body === undefined ? undefined : { method: "PUT", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify(body) });
  const status = async () => (await (await request(base)).json()).status;
  try {
    const initial = await status();
    const page = await request("/novel?project=novel-project");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-project-id="novel-project"');
    expect((await request("/novel?project=missing-project")).status).toBe(404);
    story.script.start[0]!.text = "Changed in the authoring document.";
    expect((await request(base + "/novel/story", story)).status).toBe(200);
    expect((await status()).revision).toBe(initial.revision + 1);
    expect(JSON.parse(readFileSync(join(project, "story.json"), "utf8"))).toEqual(story);
    const assets = { backgrounds: { station: "art/station.png" }, characters: {}, cgs: {}, audio: {} };
    expect((await request(base + "/novel/assets", assets)).status).toBe(200);
    expect((await status()).revision).toBe(initial.revision + 2);
    expect((await request(base + "/novel/assets", { ...assets, backgrounds: { station: "../outside.png" } })).status).toBe(422);
    expect((await status()).revision).toBe(initial.revision + 2);
    expect(JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8"))).toEqual(assets);
    const runtime = await request(base + "/novel/runtime.js");
    expect(runtime.status).toBe(200);
    // Execute the actual browser bundle, rather than accepting its presence as proof.
    const file = join(project, "preview-runtime.mjs");
    writeFileSync(file, await runtime.text());
    const { createNovelEngine } = await import(file);
    const engine = createNovelEngine(JSON.parse(readFileSync(join(project, "story.json"), "utf8")));
    expect(engine.start().snapshot.active.text).toBe("Changed in the authoring document.");
    engine.advance(); engine.advance();
    expect(engine.getSnapshot().active.id).toBe("end");
    engine.dispose();
  } finally {
    await server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("Novel registry retains one image skin and resolves bundled video cues through the shared Guest paths", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-novel-video-registry-"));
  const project = mkdtempSync(join(tmpdir(), "pocket-novel-video-project-"));
  mkdirSync(join(project, "art/ui"), { recursive: true });
  mkdirSync(join(project, "assets/video"), { recursive: true });
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "example.novel", name: "novel-video-project", version: "0.1.0", app: { entry: "app.tsx", framework: "solid" } }));
  writeFileSync(join(project, "app.tsx"), "export {};\n");
  writeFileSync(join(project, "art/ui/frame.png"), "frame-bytes");
  writeFileSync(join(project, "assets/video/loop.mp4"), "mp4-bytes");
  const story = { id: "example-novel-video", version: 1, start: "start", script: { start: [{ type: "say", id: "intro", text: "Before video." }, { type: "ending", id: "end" }] } };
  writeFileSync(join(project, "story.json"), JSON.stringify(story));
  writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }));
  const server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
  const origin = `http://127.0.0.1:${server.port}`;
  const base = "/api/projects/novel-video-project/novel";
  const request = (path: string, body?: unknown) => fetch(origin + path, body === undefined ? undefined : { method: "PUT", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify(body) });
  try {
    const assets = {
      backgrounds: {}, characters: {}, cgs: {}, audio: {},
      videos: { atmosphere: "video/loop.mp4" },
      skin: { frame: { image: "art/ui/frame.png", width: 1254, height: 1254, inset: 300 } },
    };
    expect((await request(base + "/assets", assets)).status).toBe(200);
    expect(JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8"))).toEqual(assets);
    expect((await (await request(base + "/assets")).json()).assets).toEqual(assets);

    const storyWithVideo = {
      ...story,
      script: { start: [{ type: "say", id: "intro", text: "Before video." }, { type: "video", action: "play", cue: "atmosphere", loop: true }, { type: "ending", id: "end" }] },
    };
    expect((await request(base + "/story", storyWithVideo)).status).toBe(200);
    const runtimeFile = join(project, "preview-runtime.mjs");
    const runtimeResponse = await request(base + "/runtime.js");
    expect(runtimeResponse.status).toBe(200);
    writeFileSync(runtimeFile, await runtimeResponse.text());
    const runtime = await import(pathToFileURL(runtimeFile).href);
    const engine = runtime.createNovelEngine(storyWithVideo);
    try {
      engine.start();
      engine.advance();
      engine.advance();
      expect(engine.getSnapshot().stage.video).toMatchObject({ cue: "atmosphere", loop: true, status: "playing" });
      expect(engine.getSnapshot().active).toMatchObject({ kind: "ending", id: "end" });
    } finally { engine.dispose(); }

    for (const invalid of [
      { ...assets, skin: { frame: { ...assets.skin.frame, width: 0 } } },
      { ...assets, skin: { frame: { ...assets.skin.frame, inset: 627 } } },
      { ...assets, skin: { ...assets.skin, button: { image: "art/ui/button.png" } } },
      { ...assets, videos: { atmosphere: "video/loop.webm" } },
    ]) {
      expect((await request(base + "/assets", invalid)).status).toBe(422);
      expect(JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8"))).toEqual(assets);
    }
  } finally {
    await server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
