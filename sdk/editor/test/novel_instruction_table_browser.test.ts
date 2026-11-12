import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";
import { NativeSession, textOf } from "../../../demo/js/tests/native_session.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";

function minimalPcmWav(): Buffer {
  const sampleRate = 8_000;
  const sampleBytes = 2;
  const dataBytes = sampleBytes;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * sampleBytes, 28);
  bytes.writeUInt16LE(sampleBytes, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  bytes.writeInt16LE(0, 44);
  return bytes;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("all-instruction table preserves the canonical story and builds the edited route into a real Guest", { timeout: 240_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const lantern = join(repository, "demo/js/apps/lantern");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-instruction-table-browser-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "instruction-table-browser";
  const artifactRoot = resolve(process.env.POCKET_INSTRUCTION_TABLE_ARTIFACT_DIR?.trim() || join(repository, "sdk/.pocket-build/instruction-table-20261108/captures"));
  mkdirSync(project, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });

  for (const name of ["pocket.json", "manifest.json", "package.json"]) {
    cpSync(join(lantern, name), join(project, name), { recursive: true });
  }
  mkdirSync(join(project, "art"), { recursive: true });
  copyFileSync(join(lantern, "art/station.png"), join(project, "art/station.png"));
  copyFileSync(join(lantern, "art/mira-neutral.png"), join(project, "art/mira-neutral.png"));
  mkdirSync(join(project, "assets/audio"), { recursive: true });
  writeFileSync(join(project, "assets/audio/table-tone.wav"), minimalPcmWav());

  writeFileSync(join(project, "editor.json"), JSON.stringify({
    id: projectId,
    appId: projectId,
    name: "Instruction Table Acceptance",
    version: "0.1.0",
    entry: "app.tsx",
    framework: "solid",
    build: 1,
    tickHz: 60,
  }, null, 2));

  const nestedChoiceOptions = [
    {
      id: "take-archive",
      text: "Take the archive route",
      target: "target",
      when: {
        op: "and",
        conditions: [
          { op: "eq", left: { type: "variable", name: "flag" }, right: { type: "literal", value: false } },
          { op: "gt", left: { type: "variable", name: "score" }, right: { type: "literal", value: 0 } },
        ],
      },
      editorial: { retained: ["condition", { nested: true }] },
    },
    { id: "leave", text: "Leave", target: "detour" },
  ];
  const story = {
    id: projectId,
    version: 1,
    start: "start",
    locale: "zh-CN",
    metadata: { source: "retained-parent-adapted-browser-acceptance", chapterOrder: ["start", "chapterArchive", "target", "detour"] },
    variableDefinitions: {
      score: { lifetime: "save", defaultValue: 0, authoring: { keep: true } },
      flag: { lifetime: "save", defaultValue: false },
      word: { lifetime: "save", defaultValue: "" },
      emptyWord: { lifetime: "save", defaultValue: "" },
      credits: { lifetime: "save", defaultValue: 10 },
      tokens: { lifetime: "save", defaultValue: 0 },
    },
    inventory: {
      currency: { title: "Credits", variable: "credits" },
      items: { token: { title: "Brass token", body: "A small brass token.", quantityVariable: "tokens", buyPrice: 1, sellPrice: 1, maxQuantity: 99 } },
    },
    script: {
      start: [
        { type: "set", variable: "score", value: 0, authoring: { note: "retain this unknown field", nested: { rank: 1 } } },
        { type: "set", variable: "flag", value: false },
        { type: "inc", variable: "score", amount: 2, authoring: { source: "table-fixture" } },
        { type: "wait", durationMs: 1, authoring: { unit: "milliseconds" } },
        { type: "jump", target: "detour", authoring: { intendedTarget: "changed in the table" } },
        {
          type: "scene",
          background: "station",
          backgroundLayers: [{ background: "station", parallax: 0.35, editorial: { retained: true } }],
          characters: [{ id: "mira", expression: "neutral", position: { x: 24, y: 90 }, visible: true, customPose: { source: "nested scene" } }],
          transition: { kind: "fade", durationMs: 0 },
          camera: { x: 0, y: 0, scale: 1 },
          authoringScene: { lens: "35mm", tags: ["keep", { nested: "scene metadata" }] },
        },
        { type: "choice", id: "nested-choice", prompt: "Where should we go?", options: nestedChoiceOptions, editorial: { note: "choice extension" } },
        {
          type: "branch",
          when: { op: "not", condition: { op: "falsy", value: { type: "variable", name: "flag" } } },
          then: "target",
          else: "detour",
          authoringBranch: { retained: true },
        },
        { type: "call", target: "helper", authoring: { source: "all-types fixture" } },
        { type: "say", id: "author-line", text: "An authored line with no speaker field.", authoring: { nested: { keep: true } } },
        { type: "audio", cue: "table-tone", action: "play", channel: "ambience", loop: true, authoringAudio: { retained: true } },
        { type: "video", action: "close", authoringVideo: { retained: true } },
        { type: "input", id: "unused-input", variable: "unusedInput", inputType: "text", prompt: "An unreachable but valid input." },
        { type: "trade", item: "token", action: "buy", quantity: 1, onFailure: "detour" },
        { type: "say", id: "gate-line", text: "A valid line after the call site." },
        { type: "ending", id: "unreachable-ending", text: "This ending is visible in the table." },
        ...Array.from({ length: 14 }, (_, index) => ({
          type: "say",
          id: `filler-${String(index).padStart(2, "0")}`,
          text: `Mixed-page filler ${index}.`,
          extension: { chapter: "start", ordinal: index, nested: { retained: true } },
        })),
      ],
      chapterArchive: [
        { type: "set", variable: "emptyWord", value: "", sourceMeta: { explicitEmpty: true } },
        { type: "say", id: "archive-token", text: "An archived line used by the table filter." },
        { type: "scene", background: "station", characters: [{ id: "mira", expression: "neutral", visible: true, position: "left" }], camera: { x: 0, y: 0, scale: 1 } },
      ],
      target: [
        { type: "set", variable: "word", value: "original", authoring: { chapter: "target", preserve: ["typed", "value"] } },
        { type: "scene", background: "station", characters: [{ id: "mira", expression: "neutral", position: "left", visible: true }], transition: { kind: "cut", durationMs: 0 }, camera: { x: 0, y: 0, scale: 1 } },
        { type: "say", id: "route-proof", text: "score={{score}}; flag={{flag}}; word={{word}}.", authoringLine: { stable: "localization key" } },
        { type: "ending", id: "edited-target-ending", text: "Edited target ending: score={{score}}; word={{word}}." },
      ],
      detour: [{ type: "ending", id: "decoy-ending", text: "WRONG ROUTE: the unedited target is still active." }],
      helper: [{ type: "return" }],
    },
  };
  const localeDocument = {
    format: "pocket-vn-locales",
    formatVersion: 1,
    catalogs: {
      en: {
        format: "pocket-vn-locale",
        formatVersion: 1,
        locale: "en",
        lines: { "route-proof": "Original localized route text." },
        speakers: {},
        choices: {},
        endings: {},
        ui: {},
      },
    },
  };
  const localeBytes = JSON.stringify(localeDocument, null, 2) + "\n";
  writeFileSync(join(project, "story.json"), JSON.stringify(story, null, 2) + "\n");
  writeFileSync(join(project, "novel.assets.json"), JSON.stringify({
    backgrounds: { station: "art/station.png" },
    characters: { mira: { neutral: "art/mira-neutral.png" } },
    cgs: {},
    audio: { "table-tone": "audio/table-tone.wav" },
  }, null, 2) + "\n");
  writeFileSync(join(project, "novel.locales.json"), localeBytes);
  writeFileSync(join(project, "images.json"), "{}\n");
  writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { onCleanup } from "solid-js";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";

const engine = createNovelEngine(story as StoryDefinition, { preferences: { textSpeedCharsPerSecond: 0 } });
function App() {
  const removeClock = attachNovelClock(engine);
  onCleanup(() => { removeClock(); engine.dispose(); });
  return <NovelView engine={engine} assets={assets as NovelAssets} title="Instruction table" onNewGame={() => engine.start()} />;
}
mount(App);
`);

  const server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(15_000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  let native: NativeSession | undefined;
  let phase = "browser launch";
  const storyPath = join(project, "story.json");
  const localePath = join(project, "novel.locales.json");
  const readStory = () => JSON.parse(readFileSync(storyPath, "utf8"));
  try {
    phase = "opening full instruction table";
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.waitForFunction(() => document.querySelector("#novel-diagnostics") !== null);
    assert.equal(await page.locator("#novel-save-state").innerText(), "已保存");
    assert.equal(await page.locator("#novel-save").isDisabled(), true);
    await page.getByRole("button", { name: "对白表格", exact: true }).click();
    const table = page.locator("#novel-dialogue-table-grid");
    await table.waitFor();
    await page.getByLabel("指令范围", { exact: true }).selectOption("all");
    assert.equal(await table.getAttribute("aria-label"), "全部指令");
    const rows = page.locator("#novel-dialogue-table-body [data-instruction-row]");
    assert.equal(await rows.count(), 25, "the all-instruction view mounts only one bounded page");
    assert.equal(await rows.first().getAttribute("data-instruction-row"), "start:0");
    assert.equal(await rows.last().getAttribute("data-instruction-row"), "start:24");
    assert.equal(await page.getByLabel("值 start:0", { exact: true }).inputValue(), "0", "numeric JSON zero stays typed");
    assert.equal(await page.getByLabel("值 start:1", { exact: true }).inputValue(), "false", "boolean JSON false stays typed");
    assert.equal(await page.locator('[data-instruction-row="start:11"] [data-instruction-field="action"]').evaluate(element => (element as HTMLInputElement).readOnly), true, "video action remains read-only in the compact table");
    assert.equal(await page.locator('[data-instruction-row="start:12"] [data-instruction-field="inputType"]').evaluate(element => (element as HTMLInputElement).readOnly), true, "input type remains read-only in the compact table");
    assert.equal(await page.locator("#novel-save-state").innerText(), "已保存", "changing table scope is a view change, not a story edit");
    assert.equal(await page.locator("#novel-save").isDisabled(), true);

    phase = "cross-chapter paging and filtering";
    const visibleTypes = new Set(await page.locator("#novel-dialogue-table-body .nv-instruction-type").allTextContents());
    await page.locator("#novel-dialogue-next").click();
    assert.equal(await rows.count(), 14);
    assert.equal(await rows.first().getAttribute("data-instruction-row"), "start:25");
    for (const type of await page.locator("#novel-dialogue-table-body .nv-instruction-type").allTextContents()) visibleTypes.add(type);
    for (const type of ["say", "scene", "audio", "wait", "set", "inc", "trade", "branch", "jump", "call", "return", "choice", "input", "video", "ending"]) {
      assert.equal(visibleTypes.has(type), true, `all fifteen supported instruction types must be visible; missing ${type}`);
    }
    assert.match(await page.locator("#novel-dialogue-table-page-status").innerText(), /第 2 \/ 2 页.*25 条/);
    await page.locator("#novel-dialogue-previous").click();
    const filter = page.getByLabel("筛选指令", { exact: true });
    await filter.fill("archive-token");
    await page.locator("#novel-dialogue-filter").click();
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.first().getAttribute("data-instruction-row"), "chapterArchive:1", "filter results retain the original label and array position");
    await filter.fill("");
    await page.locator("#novel-dialogue-filter").click();

    phase = "typed edits and nested JSON validation";
    const expectedSceneCharacters = [{
      ...story.script.start[5].characters[0],
      position: { x: 72, y: 96 },
    }];
    const expectedChoiceOptions = structuredClone(nestedChoiceOptions);
    expectedChoiceOptions[0].when = {
      op: "and",
      conditions: [
        { op: "eq", left: { type: "variable", name: "flag" }, right: { type: "literal", value: true } },
        { op: "gt", left: { type: "variable", name: "score" }, right: { type: "literal", value: 0 } },
      ],
    };
    await page.getByLabel("值 start:0", { exact: true }).fill("7");
    await page.getByLabel("值 start:1", { exact: true }).fill("true");
    await page.getByLabel("增量 start:2", { exact: true }).fill("5");
    await page.getByLabel("等待时长 ms start:3", { exact: true }).fill("35");
    await page.getByLabel("目标 start:4", { exact: true }).selectOption("target");
    await page.getByLabel("角色 JSON start:5", { exact: true }).fill(JSON.stringify(expectedSceneCharacters));
    const optionsField = page.getByLabel("选项 JSON start:6", { exact: true });
    await optionsField.fill("{bad JSON");
    await optionsField.waitFor({ state: "visible" });
    assert.equal(await optionsField.getAttribute("aria-invalid"), "true", "malformed nested choice JSON is rejected in the editor field");
    assert.deepEqual(readStory(), story, "table edits remain an in-memory draft until Save");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-notice")?.textContent === "请先修复红色字段中的 JSON 或数字格式。");
    assert.deepEqual(readStory(), story, "invalid JSON must block Save without mutating the source file");
    await optionsField.fill(JSON.stringify(expectedChoiceOptions));
    assert.equal(await optionsField.getAttribute("aria-invalid"), null);

    const targetRows = page.locator("#novel-dialogue-table-body [data-instruction-row]");
    assert.equal(await targetRows.count(), 25);
    await page.locator("#novel-dialogue-next").click();
    assert.equal(await page.locator('[data-instruction-row="target:0"]').count(), 1);
    assert.equal(await page.getByLabel("值 target:0", { exact: true }).inputValue(), '"original"');
    await page.getByLabel("值 target:0", { exact: true }).fill('"Typed value"');
    assert.equal(await page.getByLabel("值 chapterArchive:0", { exact: true }).inputValue(), '""', "explicit empty string remains distinct from an absent JSON field");
    await page.getByLabel("值 chapterArchive:0", { exact: true }).fill('"Archive memo"');

    const routeText = "score={{score}}; flag={{flag}}; word={{word}}";
    const routeTextField = page.getByLabel("对白文本 target:2", { exact: true });
    assert.equal(await page.getByLabel("对白文本 target:2", { exact: true }).inputValue(), "score={{score}}; flag={{flag}}; word={{word}}.");
    await routeTextField.click();
    await routeTextField.press("ControlOrMeta+A");
    await routeTextField.pressSequentially(routeText);
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("对白文本 target:2", { exact: true }).inputValue(), "score={{score}}; flag={{flag}}; word={{word}}.", "one grouped undo restores the typed line as one action");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("对白文本 target:2", { exact: true }).inputValue(), routeText, "redo reapplies the complete grouped text entry");

    const expected = structuredClone(story);
    expected.script.start[0].value = 7;
    expected.script.start[1].value = true;
    expected.script.start[2].amount = 5;
    expected.script.start[3].durationMs = 35;
    expected.script.start[4].target = "target";
    expected.script.start[5].characters = expectedSceneCharacters;
    expected.script.start[6].options = expectedChoiceOptions;
    expected.script.target[0].value = "Typed value";
    expected.script.target[2].text = routeText;
    expected.script.chapterArchive[0].value = "Archive memo";

    phase = "saving and verifying lossless story persistence";
    await page.locator("#novel-dialogue-previous").click();
    await page.screenshot({ path: join(artifactRoot, "mixed-instructions.png"), fullPage: false });
    await page.locator("#novel-dialogue-next").click();
    await page.screenshot({ path: join(artifactRoot, "instruction-table.png"), fullPage: true });
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    assert.deepEqual(readStory(), expected, "Save changes only the fields authored through the table and retains custom/nested source data");
    assert.equal(Object.hasOwn(readStory().script.target[2], "speaker"), false, "editing the say text does not materialize an absent optional speaker");
    assert.equal(readStory().script.target[2].id, "route-proof", "the localization key remains stable");
    assert.equal(readFileSync(localePath, "utf8"), localeBytes, "editing table text does not rewrite the locale catalog");
    assert.deepEqual(readStory().metadata, story.metadata, "story-level unknown metadata remains intact");

    phase = "reopening saved table data";
    await page.reload();
    await page.getByRole("button", { name: "对白表格", exact: true }).click();
    await page.getByLabel("指令范围", { exact: true }).selectOption("all");
    await page.locator("#novel-dialogue-next").click();
    assert.equal(await page.getByLabel("值 target:0", { exact: true }).inputValue(), '"Typed value"');
    assert.equal(await page.getByLabel("对白文本 target:2", { exact: true }).inputValue(), routeText);
    assert.deepEqual(readStory(), expected);
    assert.equal(readFileSync(localePath, "utf8"), localeBytes);

    phase = "pinned Guest build";
    await page.locator("#novel-build").click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120_000 });
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/);
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`)).json() as { revision: number; builtRevision: number };
    assert.equal(status.builtRevision, status.revision, "the saved story must go through the Editor's pinned buildGuest pipeline");
    const guestRoot = join(workspace, "builds", projectId, String(status.builtRevision));
    const metadataPath = join(guestRoot, "app.bytecode.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { entryFormat: string; runtimeAbi: string };
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    native = new NativeSession({
      bytecodePath: join(guestRoot, "app.qjbc"),
      pakPath: join(guestRoot, "app.pak"),
      metadataPath,
      runtimeAbi: metadata.runtimeAbi,
    }, { width: 360, height: 640, deadlineMs: 45_000 });

    phase = "native pointer route and interpolation";
    let frame = await native.boot();
    frame = await native.tap("启程 · 开始新的故事", frame);
    const renderedText = "score=12; flag=true; word=Typed value";
    const normalizeNativeText = (value: string): string => value.replace(/\s+/g, " ").trim();
    for (let attempt = 0; attempt < 120 && !normalizeNativeText(textOf(frame)).includes(renderedText); attempt++) frame = await native.frame();
    const dialogueFrameRaw = textOf(frame);
    const dialogueFrameNormalized = normalizeNativeText(dialogueFrameRaw);
    assert.ok(dialogueFrameNormalized.includes(renderedText), `native Guest must execute edited set/inc/wait/jump and interpolate the saved value; actual text: ${dialogueFrameRaw}`);
    frame = await native.tap("轻触继续  ›", frame);
    const expectedEnding = "Edited target ending: score=12; word=Typed value.";
    for (let attempt = 0; attempt < 40 && !normalizeNativeText(textOf(frame)).includes(expectedEnding); attempt++) frame = await native.frame();
    const endingFrameRaw = textOf(frame);
    const endingFrameNormalized = normalizeNativeText(endingFrameRaw);
    assert.ok(endingFrameNormalized.includes(expectedEnding), `native pointer progression must reach the edited target ending: ${endingFrameRaw}`);
    assert.equal(endingFrameNormalized.includes("WRONG ROUTE"), false, "the original jump target must remain unreachable after the saved edit");
    assert.deepEqual(pageErrors, [], "the all-instruction Editor must not raise browser errors");

    const savedStoryBytes = readFileSync(storyPath);
    writeFileSync(join(artifactRoot, "final-story.json"), savedStoryBytes);
    writeFileSync(join(artifactRoot, "final-locales.json"), readFileSync(localePath));
    writeFileSync(join(artifactRoot, "dialogue-frame.txt"), `${dialogueFrameRaw}\n`);
    writeFileSync(join(artifactRoot, "ending-frame.txt"), `${endingFrameRaw}\n`);
    writeFileSync(join(artifactRoot, "rendered-guest-text.txt"), `Dialogue frame:\n${dialogueFrameRaw}\n\nEnding frame:\n${endingFrameRaw}\n`);
    const guestArtifactManifest: Record<string, unknown> = {
      projectId,
      revision: status.builtRevision,
      runtimeAbi: metadata.runtimeAbi,
      entryFormat: metadata.entryFormat,
      savedStorySha256: createHash("sha256").update(savedStoryBytes).digest("hex"),
      localeBytesUnchanged: true,
      renderedText,
      normalizedDialogueText: dialogueFrameNormalized,
      ending: expectedEnding,
      normalizedEndingText: endingFrameNormalized,
      dialogueFrame: "dialogue-frame.txt",
      endingFrame: "ending-frame.txt",
      artifacts: {} as Record<string, unknown>,
    };
    const artifactEntries = [
      ["bytecode", join(guestRoot, "app.qjbc")],
      ["pak", join(guestRoot, "app.pak")],
      ["metadata", metadataPath],
    ] as const;
    for (const [key, source] of artifactEntries) {
      const destination = join(artifactRoot, `guest-${key}${key === "bytecode" ? ".qjbc" : key === "pak" ? ".pak" : ".bytecode.json"}`);
      copyFileSync(source, destination);
      (guestArtifactManifest.artifacts as Record<string, unknown>)[key] = {
        file: destination,
        bytes: readFileSync(destination).byteLength,
        sha256: sha256(destination),
      };
    }
    writeFileSync(join(artifactRoot, "guest-manifest.json"), JSON.stringify(guestArtifactManifest, null, 2) + "\n");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; phase=${phase}; browserErrors=${JSON.stringify(pageErrors)}`);
  } finally {
    await native?.quit();
    await browser.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
