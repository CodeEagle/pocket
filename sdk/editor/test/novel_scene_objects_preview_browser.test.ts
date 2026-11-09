import { strict as assert } from "node:assert";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

const repository = resolve(import.meta.dir, "../../..");
const lantern = join(repository, "demo/js/apps/lantern");

const validObject = {
  id: "inspectable-lamp",
  image: "station",
  frame: { x: 0.2, y: 0.2, w: 0.24, h: 0.2 },
  interaction: {
    label: "Inspect lamp",
    effects: [{ type: "inc", variable: "hitCount", amount: 1 }],
    when: { op: "falsy", value: { type: "variable", name: "hitCount" } },
  },
};

const story = {
  id: "scene-objects-preview",
  version: 1,
  start: "start",
  variableDefinitions: { hitCount: { lifetime: "save", defaultValue: 0 } },
  replayEntries: [{ id: "lamp-memory", title: "Lamp memory", location: { label: "replay_entry", index: 0 }, unlockEndingId: "main-end" }],
  script: {
    start: [
      { type: "scene", background: "station", objects: [validObject] },
      { type: "say", id: "main-line", text: "The lamp waits for an inspection." },
      { type: "ending", id: "main-end", text: "The main route ends." },
    ],
    replay_entry: [
      { type: "scene", background: "station", objects: [validObject] },
      { type: "say", id: "replay-line", text: "A separate memory of the lamp." },
      { type: "ending", id: "replay-end", text: "The replay route ends." },
    ],
  },
};

test("Editor live preview applies guarded scene-object hits, keeps real sources across root selection, and blocks invalid drafts", { timeout: 120_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-scene-object-preview-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "scene-objects-preview";
  await mkdir(join(project, "art"), { recursive: true });
  await cp(join(lantern, "art/station.png"), join(project, "art/station.png"));
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: projectId, name: "Scene Object Preview", app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: projectId, capabilities: { requires: [], optional: [] } }));
  await writeFile(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: projectId, name: "Scene Object Preview", version: "0.1.0", build: 1 }));
  await writeFile(join(project, "package.json"), JSON.stringify({ type: "module", dependencies: {} }));
  await writeFile(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  await writeFile(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: { station: "art/station.png" }, characters: {}, cgs: {}, audio: {} }));

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const pageErrors: string[] = [];
  page.setDefaultTimeout(12_000);
  page.on("pageerror", error => pageErrors.push(error.message));

  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await page.locator('[data-scene-objects-json="true"][data-location="start:0"]').waitFor();
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    const roots = page.locator("#novel-context-preview-root");
    await page.waitForFunction(() => {
      const select = document.querySelector<HTMLSelectElement>("#novel-context-preview-root");
      return !!select && !select.disabled && [...select.options].some(option => option.value === "replay:lamp-memory");
    });

    await page.locator(".nv-jump-control select").selectOption("start");
    await page.locator(".nv-jump-control input").fill("1");
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached");
    const status = page.locator("#novel-context-preview-status");
    assert.equal(await status.getAttribute("data-root-kind"), "main");
    assert.equal(await status.getAttribute("data-root-location"), "start:0");
    const hitCount = async () => JSON.parse(await page.locator("#novel-variables").innerText()).hitCount;
    assert.equal(await hitCount(), 0);
    assert.equal(await page.locator("#novel-preview-location").innerText(), "start:1");

    const hit = page.locator('#novel-live-view [data-scene-object-hit="inspectable-lamp"]');
    await hit.waitFor();
    const pause = page.locator("#novel-preview-pause");
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "继续");
    await pause.click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "暂停");
    await pause.click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "继续");
    assert.equal(await hit.isDisabled(), true, "paused preview disables otherwise eligible scene-object interaction");
    await hit.evaluate(button => (button as HTMLButtonElement).click());
    assert.equal(await hitCount(), 0, "disabled interaction cannot mutate the running preview");

    await pause.click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "暂停");
    await hit.click();
    await page.waitForFunction(() => JSON.parse(document.querySelector("#novel-variables")?.textContent ?? "{}").hitCount === 1);
    assert.equal(await page.locator("#novel-preview-location").innerText(), "start:1", "object interaction does not advance the active say");
    assert.equal(await hit.isDisabled(), true, "the false `when` guard closes the interaction after its first committed hit");
    await hit.evaluate(button => (button as HTMLButtonElement).click());
    assert.equal(await hitCount(), 1, "repeating a guarded hit cannot apply its effect twice");

    const source = page.locator('#novel-live-view .nv-preview-source-object[data-source-location="start:0"]');
    await source.waitFor();
    assert.equal(await source.isDisabled(), false, "object provenance points at an actually executed scene instruction");
    await source.click();
    assert.equal(await page.locator(".nv-label.active .nv-label-name").innerText(), "start");
    assert.equal(await page.locator(".nv-instruction").first().locator(".nv-type-select").inputValue(), "scene", "clicking the visible object's source navigates to its committed scene configuration");

    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    const sourceBeforeRootChange = await source.evaluate(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const object = element.closest(".nv-stage-object") as HTMLElement | null;
      const objectRect = object?.getBoundingClientRect();
      return {
        source: {
          tag: element.tagName,
          className: element.getAttribute("class"),
          sourceKind: element.getAttribute("data-source-kind"),
          sourceLocation: element.getAttribute("data-source-location"),
          sourceExecutionLocation: element.getAttribute("data-source-execution-location"),
          targetStoryRevision: element.getAttribute("data-target-story-revision"),
          disabled: (element as HTMLButtonElement).disabled,
          ariaLabel: element.getAttribute("aria-label"),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          computed: { display: style.display, visibility: style.visibility, opacity: style.opacity, position: style.position, zIndex: style.zIndex },
          hidden: (element as HTMLElement).hidden,
        },
        stageObject: object ? {
          id: object.dataset.sceneObjectId,
          image: object.dataset.image,
          frame: object.dataset.frame,
          crop: object.dataset.crop,
          hit: object.dataset.hit,
          layer: object.dataset.layer,
          rect: objectRect ? { x: objectRect.x, y: objectRect.y, width: objectRect.width, height: objectRect.height } : null,
        } : null,
      };
    });
    assert.equal(sourceBeforeRootChange.source.sourceLocation, "start:0");
    assert.equal(sourceBeforeRootChange.stageObject?.id, validObject.id);
    assert.equal(sourceBeforeRootChange.stageObject?.image, validObject.image);
    await roots.selectOption("replay:lamp-memory");
    assert.equal(await status.getAttribute("data-root-kind"), "main", "choosing a future replay root does not relabel the current engine");
    assert.equal(await status.getAttribute("data-root-location"), "start:0");
    const retainedSource = page.locator('#novel-live-view .nv-preview-source-object[data-source-location="start:0"]');
    const retainedSourceDiagnostics = await page.evaluate(() => {
      const describe = (element: Element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          className: element.getAttribute("class"),
          sourceKind: element.getAttribute("data-source-kind"),
          sourceLocation: element.getAttribute("data-source-location"),
          sourceExecutionLocation: element.getAttribute("data-source-execution-location"),
          targetStoryRevision: element.getAttribute("data-target-story-revision"),
          disabled: (element as HTMLButtonElement).disabled,
          ariaLabel: element.getAttribute("aria-label"),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          computed: { display: style.display, visibility: style.visibility, opacity: style.opacity, position: style.position, zIndex: style.zIndex },
          hidden: (element as HTMLElement).hidden,
        };
      };
      const objects = [...document.querySelectorAll<HTMLElement>("#novel-live-view .nv-stage-object")];
      return {
        root: (document.querySelector<HTMLSelectElement>("#novel-context-preview-root")?.value ?? ""),
        status: {
          kind: document.querySelector("#novel-context-preview-status")?.getAttribute("data-root-kind"),
          location: document.querySelector("#novel-context-preview-status")?.getAttribute("data-root-location"),
        },
        sourceControls: [...document.querySelectorAll("#novel-live-view .nv-preview-source-object")].map(describe),
        stageObjects: objects.map(object => ({
          id: object.dataset.sceneObjectId,
          image: object.dataset.image,
          frame: object.dataset.frame,
          crop: object.dataset.crop,
          hit: object.dataset.hit,
          layer: object.dataset.layer,
          rect: (() => { const rect = object.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })(),
        })),
      };
    });
    assert.equal(
      retainedSourceDiagnostics.sourceControls.filter(source => source.sourceLocation === "start:0").length,
      1,
      `future-root selection must preserve the committed source fact: ${JSON.stringify({
        beforeRootChange: sourceBeforeRootChange,
        rendered: retainedSourceDiagnostics,
        committedScenePayload: { location: "start:0", op: "scene", objects: [{ ...validObject }] },
      })}`,
    );
    const retainedSourceFact = retainedSourceDiagnostics.sourceControls.find(source => source.sourceLocation === "start:0");
    assert.deepEqual(
      retainedSourceFact && {
        sourceKind: retainedSourceFact.sourceKind,
        sourceLocation: retainedSourceFact.sourceLocation,
        sourceExecutionLocation: retainedSourceFact.sourceExecutionLocation,
        targetStoryRevision: retainedSourceFact.targetStoryRevision,
        disabled: retainedSourceFact.disabled,
      },
      sourceBeforeRootChange.source && {
        sourceKind: sourceBeforeRootChange.source.sourceKind,
        sourceLocation: sourceBeforeRootChange.source.sourceLocation,
        sourceExecutionLocation: sourceBeforeRootChange.source.sourceExecutionLocation,
        targetStoryRevision: sourceBeforeRootChange.source.targetStoryRevision,
        disabled: sourceBeforeRootChange.source.disabled,
      },
      "the exact source fact stays tied to the same committed scene",
    );
    const retainedStageObject = retainedSourceDiagnostics.stageObjects[0];
    assert.deepEqual(
      retainedStageObject && { id: retainedStageObject.id, image: retainedStageObject.image, frame: retainedStageObject.frame, crop: retainedStageObject.crop, hit: retainedStageObject.hit, layer: retainedStageObject.layer },
      sourceBeforeRootChange.stageObject && { id: sourceBeforeRootChange.stageObject.id, image: sourceBeforeRootChange.stageObject.image, frame: sourceBeforeRootChange.stageObject.frame, crop: sourceBeforeRootChange.stageObject.crop, hit: sourceBeforeRootChange.stageObject.hit, layer: sourceBeforeRootChange.stageObject.layer },
    );
    await retainedSource.waitFor();
    assert.equal(await retainedSource.isDisabled(), false, "changing the future root preserves the current executed object's source fact");

    await page.locator(".nv-jump-control select").selectOption("replay_entry");
    await page.locator(".nv-jump-control input").fill("1");
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => {
      const status = document.querySelector("#novel-context-preview-status");
      return status?.getAttribute("data-status") === "reached" && status.getAttribute("data-root-identity") === "lamp-memory";
    });
    assert.equal(await page.locator("#novel-context-preview-status").getAttribute("data-root-location"), "replay_entry:0");
    const rebuiltSource = page.locator('#novel-live-view .nv-preview-source-object[data-source-location="replay_entry:0"]');
    await rebuiltSource.waitFor();
    assert.equal(await page.locator('#novel-live-view .nv-preview-source-object[data-source-location="start:0"]').count(), 0, "rebuilding replaces the prior source facts with committed facts from the new root");

    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    const objectsField = page.locator('[data-scene-objects-json="true"][data-location="start:0"]');
    await objectsField.waitFor();
    const valid = [{ ...validObject, frame: { ...validObject.frame } }];
    const invalidDrafts = [
      {
        name: "image reference",
        expected: "missing-image",
        objects: [{ ...valid[0], image: "missing-image" }],
      },
      {
        name: "crop rectangle",
        expected: "script.start[0].objects[0].crop",
        objects: [{ ...valid[0], crop: { x: 0.8, y: 0, w: 0.4, h: 0.5 } }],
      },
      {
        name: "interaction condition",
        expected: "script.start[0].objects[0].interaction.when",
        objects: [{ ...valid[0], interaction: { ...valid[0].interaction, when: { op: "unknown", value: { type: "literal", value: true } } } }],
      },
      {
        name: "interaction effect",
        expected: "script.start[0].objects[0].interaction.effects[0]",
        objects: [{ ...valid[0], interaction: { ...valid[0].interaction, effects: [{ type: "delete", variable: "hitCount" }] } }],
      },
    ];
    for (const invalid of invalidDrafts) {
      await objectsField.fill(JSON.stringify(invalid.objects, null, 2));
      await page.waitForFunction(expected => document.querySelector("#novel-diagnostics")?.textContent?.includes(expected), invalid.expected);
      const diagnostics = await page.locator("#novel-diagnostics").innerText();
      assert.match(diagnostics, /个错误/ , `${invalid.name} must show an Editor field diagnostic`);
      assert.equal(await page.locator("#novel-build").isDisabled(), true, `${invalid.name} must block Guest build`);
      await objectsField.fill(JSON.stringify(valid, null, 2));
      await page.waitForFunction(expected => !document.querySelector("#novel-diagnostics")?.textContent?.includes(expected), invalid.expected);
      const restoredDiagnostics = await page.locator("#novel-diagnostics").innerText();
      console.log(`restored ${invalid.name} draft diagnostics: ${restoredDiagnostics}`);
      assert.doesNotMatch(restoredDiagnostics, new RegExp(invalid.expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${invalid.name} diagnostic clears when valid JSON is restored`);
      assert.equal(await page.locator("#novel-build").isDisabled(), true, "restored drafts still require an explicit save before build");
    }
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    assert.equal(await page.locator("#novel-build").isDisabled(), false, "valid saved object configuration re-enables build");
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")).script.start[0].objects, valid);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});
