import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";
import { NativeSession } from "../../../demo/js/tests/native_session.ts";

test("Editor authors glyph profiles and the rebuilt Guest requests the selected short audio cue", { timeout: 120_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const source = join(repository, "demo/js/apps/lantern");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-glyph-editor-"));
  const project = join(temporary, "project");
  const id = "glyph-author";
  mkdirSync(join(project, "assets/audio"), { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "fonts.json", "fonts"]) cpSync(join(source, name), join(project, name), { recursive: true });
  const sourceAudio = "audio/text_narrator.wav";
  for (const name of ["a.wav", "b.wav"]) cpSync(join(source, "assets", sourceAudio), join(project, "assets/audio", name));
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id, appId: "pocket.demo.lantern", name: id, version: "0.1.0", entry: "app.tsx", framework: "solid", build: 1, tickHz: 60 }));
  writeFileSync(join(project, "story.json"), JSON.stringify({ id, version: 1, start: "start", script: { start: [{ type: "say", id: "intro", speaker: "Ren", text: "Editor profiles select the sound of each visible character." }, { type: "ending", id: "end" }] } }));
  writeFileSync(join(project, "novel.locales.json"), JSON.stringify({ format: "pocket-vn-locales", formatVersion: 1, catalogs: {} }));
  writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: { tone_a: "audio/a.wav", tone_b: "audio/b.wav" } }));
  writeFileSync(join(project, "images.json"), "{}");
  writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { onCleanup } from "solid-js";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { createNovelAudioAdapter } from "@pocket/vn/audio";
import { NovelView } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";
function App() {
 const host=createHostBridge(); const engine=createNovelEngine(story as StoryDefinition);
 const audio=createNovelAudioAdapter(host,assets.audio,{textSounds:assets.textSounds,initialTextSoundsEnabled:true});
 const removeClock=attachNovelClock(engine); const removeAudio=engine.subscribe(update=>audio.apply(update),{emitCurrent:true});
 onCleanup(()=>{removeAudio();removeClock();audio.dispose();engine.dispose();host.dispose();});
 return <NovelView engine={engine} host={host} assets={assets} title="Glyph profiles" onNewGame={()=>engine.newGame()} />;
}
mount(App);
`);
  const server = await startEditor({ port: 0, updatePort: 0, workspace: join(temporary, "workspace"), projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  let native: NativeSession | undefined;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    await page.goto(`${origin}/novel?project=${id}`);
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    await page.getByRole("button", { name: "添加拟声配置", exact: true }).click();
    await page.getByLabel("默认拟声音频", { exact: true }).selectOption("tone_a");
    await page.getByLabel("拟声最小间隔（毫秒）", { exact: true }).fill("125");
    await page.getByLabel("拟声最小间隔（毫秒）", { exact: true }).press("Tab");
    page.once("dialog", dialog => dialog.accept("Ren"));
    await page.getByRole("button", { name: "添加角色拟声", exact: true }).click();
    await page.getByLabel("角色拟声音频 Ren", { exact: true }).selectOption("tone_b");
    await page.getByRole("button", { name: "移除拟声配置", exact: true }).click();
    await clickNovelHistory(page, "undo");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8"));
    assert.deepEqual(saved.textSounds, { defaultCue: "tone_a", minIntervalMs: 125, speakers: { Ren: "tone_b" } });
    for (const textSounds of [{ defaultCue: "missing" }, { defaultCue: "tone_a", minIntervalMs: 39 }]) {
      const rejected = await fetch(`${origin}/api/projects/${id}/novel/assets`, { method: "PUT", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify({ ...saved, textSounds }) });
      assert.equal(rejected.status, 422);
      assert.deepEqual(JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8")), saved);
    }
    await page.reload();
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    assert.equal(await page.getByLabel("角色拟声音频 Ren", { exact: true }).inputValue(), "tone_b");
    await page.locator("#novel-build").click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 90_000 });
    const status = await (await fetch(`${origin}/api/projects/${id}/status`)).json() as any;
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/, JSON.stringify(status));
    const artifact = join(temporary, "workspace/builds", id, String(status.builtRevision));
    const metadataPath = join(artifact, "app.bytecode.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    native = new NativeSession({ bytecodePath: join(artifact, "app.qjbc"), pakPath: join(artifact, "app.pak"), metadataPath, runtimeAbi: metadata.runtimeAbi }, { width: 360, height: 640, deadlineMs: 30_000 });
    let frame = await native.boot();
    assert.equal(native.requests.filter(item => item.capability === "media.audio.play").length, 0);
    frame = await native.tap("启程 · 开始新的故事", frame);
    await native.settle(frame, 45);
    const blips = native.requests.filter(item => item.capability === "media.audio.play");
    assert.ok(blips.length > 0, "visible text progress must produce an actual native request");
    assert.ok(blips.every(item => item.params.asset === "audio/b.wav" && item.params.volume === 0.7 && /^effect-[0-3]$/.test(String(item.params.channel))));
    assert.deepEqual(errors, []);
  } finally {
    await native?.quit(); await browser.close(); await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
