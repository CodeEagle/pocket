import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSystemDocument } from "../build_system.ts";
import {
  loadPocketFlutterPlatformContracts,
  POCKET_FLUTTER_TARGET_ID,
} from "../flutter_target.ts";

const demoJsRoot = resolve(import.meta.dir, "../../../demo/js");
const systemDocument = JSON.parse(
  readFileSync(join(demoJsRoot, "pocket.system.json"), "utf8"),
) as Record<string, any>;
const fixtureRoots: string[] = [];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fixture(): { readonly root: string; readonly document: Record<string, any> } {
  const root = mkdtempSync(join(tmpdir(), "pocket-flutter-target-"));
  fixtureRoots.push(root);
  mkdirSync(join(root, "apps/profile"), { recursive: true });
  mkdirSync(join(root, "apps/lobby"), { recursive: true });
  for (const relativePath of [
    "pocket.json",
    "apps/profile/pocket.json",
    "apps/lobby/pocket.json",
  ]) {
    writeFileSync(join(root, relativePath), readFileSync(join(demoJsRoot, relativePath)));
  }

  const systemUi = JSON.parse(readFileSync(join(root, "pocket.json"), "utf8")) as Record<string, any>;
  const required = systemUi.engine.capabilities.requires as string[];
  if (!required.includes("ui.compositor-surfaces")) required.push("ui.compositor-surfaces");
  writeFileSync(join(root, "pocket.json"), JSON.stringify(systemUi, null, 2));
  const document = clone(systemDocument);
  // This target-contract fixture owns only these three manifests. Showcase
  // additions must not turn it into a second copy of the full demo catalog.
  const fixturePackages = new Set(["pocket.host.demo", "pocket.demo.profile", "pocket.demo.lobby"]);
  document.applications.catalog = document.applications.catalog.filter(
    (entry: { package: string }) => fixturePackages.has(entry.package),
  );
  if (document.installation?.installedPackages) {
    document.installation.installedPackages = document.installation.installedPackages.filter(
      (id: string) => fixturePackages.has(id),
    );
  }
  return { root, document };
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Pocket Flutter target is a real Flutter registry entry with implemented host capabilities", async () => {
  const registry = await loadPocketFlutterPlatformContracts();
  const profile = registry.targets[POCKET_FLUTTER_TARGET_ID];
  if (!profile) throw new Error(`missing ${POCKET_FLUTTER_TARGET_ID} target`);
  expect(profile).toBeDefined();
  expect(profile.platform).toBe("flutter");
  expect(profile.form).toBe("window");
  expect(profile.display.dynamicViewport?.max).toEqual([1024, 1024]);
  expect(profile.capabilities).toEqual(expect.arrayContaining([
    "text.glyphs.baked",
    "runtime.worker",
    "input.touch",
    "display.viewport.live",
    "platform.apps.open",
    "platform.storage.get",
    "platform.storage.batch",
    "platform.messages.send",
  ]));
  expect(profile.capabilities).not.toContain("input.pointer");
  expect(profile.capabilities).not.toContain("input.text");
  expect(profile.capabilities).not.toContain("input.ime");
  expect(profile.capabilities).not.toContain("io.offload");
  expect(profile.capabilities).not.toContain("net.http");
  expect(profile.roleCapabilities?.systemUI).toEqual(["ui.compositor-surfaces"]);
  expect(profile.display.animation).toBe("composited");
  expect(registry.capabilities).toContain("platform.apps.list");
});

test("Flutter child can negotiate the implemented atomic storage batch capability", async () => {
  const { root, document } = fixture();
  const path = join(root, "apps/profile/pocket.json");
  const app = JSON.parse(readFileSync(path, "utf8"));
  app.engine.capabilities.requires.push("platform.storage.batch");
  writeFileSync(path, JSON.stringify(app));
  const result = await resolveSystemDocument(document, {
    appRoot: root, target: POCKET_FLUTTER_TARGET_ID,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.plan.applications.some(app => app.package === "pocket.demo.profile")).toBe(true);
});

test("Flutter child negotiates the app-private image resource capabilities", async () => {
  const { root, document } = fixture();
  const path = join(root, "apps/profile/pocket.json");
  const app = JSON.parse(readFileSync(path, "utf8"));
  app.engine.capabilities.requires.push(
    "platform.images.capture", "platform.images.read",
    "platform.images.list", "platform.images.remove",
  );
  writeFileSync(path, JSON.stringify(app));
  const result = await resolveSystemDocument(document, {
    appRoot: root, target: POCKET_FLUTTER_TARGET_ID,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.plan.applications.some(app => app.package === "pocket.demo.profile")).toBe(true);
});

test("resolved Flutter plan emits application handles in official catalog order", async () => {
  const { root, document } = fixture();
  const result = await resolveSystemDocument(document, {
    appRoot: root,
    target: POCKET_FLUTTER_TARGET_ID,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

  expect(result.plan.target.id).toBe(POCKET_FLUTTER_TARGET_ID);
  expect(result.plan.systemUI.plan.animation).toBe("composited");
  expect(result.plan.applications.every((application) => application.plan.animation === "composited")).toBe(true);
  expect(result.plan.applications.map((application) => application.package)).toEqual([
    "pocket.demo.profile",
    "pocket.demo.lobby",
  ]);
  expect(result.compositorSurfaces).toEqual({
    "pocket.demo.profile": 2,
    "pocket.demo.lobby": 3,
  });
});

test("uninstalled optional entries reserve catalog handle positions", async () => {
  const { root, document } = fixture();
  mkdirSync(join(root, "apps/optional"), { recursive: true });
  const optional = JSON.parse(
    readFileSync(join(root, "apps/profile/pocket.json"), "utf8"),
  ) as Record<string, any>;
  optional.id = "pocket.demo.optional";
  optional.name = "pocket-demo-optional";
  optional.app.output = "optional-app";
  writeFileSync(join(root, "apps/optional/pocket.json"), JSON.stringify(optional, null, 2));
  const lobbyIndex = document.applications.catalog.findIndex(
    (entry: { package: string }) => entry.package === "pocket.demo.lobby",
  );
  document.applications.catalog.splice(lobbyIndex, 0, {
    package: "pocket.demo.optional",
    manifest: "apps/optional/pocket.json",
    required: false,
  });

  const result = await resolveSystemDocument(document, {
    appRoot: root,
    target: POCKET_FLUTTER_TARGET_ID,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.compositorSurfaces).toEqual({
    "pocket.demo.profile": 2,
    "pocket.demo.lobby": 4,
  });
});


test("System child can require an isolated worker without receiving HTTP grants", async () => {
  const { root, document } = fixture();
  const path = join(root, "apps/profile/pocket.json");
  const app = JSON.parse(readFileSync(path, "utf8"));
  app.engine.capabilities.requires.push("runtime.worker");
  app.domains = { worker: { entry: "worker.ts", nodes: [], channels: [] } };
  writeFileSync(path, JSON.stringify(app));
  const result = await resolveSystemDocument(document, { appRoot: root, target: POCKET_FLUTTER_TARGET_ID });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.plan.applications.find(app => app.package === "pocket.demo.profile")?.plan.domains?.worker?.entry).toBe("worker.ts");

  app.engine.capabilities.requires.push("net.http");
  app.domains.worker.nodes.push({ name: "network", kind: "http" });
  writeFileSync(path, JSON.stringify(app));
  const denied = await resolveSystemDocument(document, { appRoot: root, target: POCKET_FLUTTER_TARGET_ID });
  expect(denied.ok).toBe(false);
});
