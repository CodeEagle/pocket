import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { validateSystemDocument, validateSystemFile } from "../build_system.ts";

const systemDocument = {
  $schema: "https://pocketjs.dev/schema/pocket-system-1.json",
  pocketSystem: 1,
  id: "test.font-system",
  name: "test-font-system",
  title: "Font System",
  version: "1.0.0",
  roles: { systemUI: "test.font-app" },
  applications: {
    installPolicy: { model: "managed", mutable: false },
    backgroundExecution: "suspend",
    catalog: [{ package: "test.font-app", manifest: "apps/font-app/pocket.json", required: true }],
  },
  installation: { installedPackages: ["test.font-app"] },
};

function makePocketManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "test.font-app",
    name: "test-font-app",
    title: "Font App",
    version: "1.0.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"] } },
    app: {
      entry: "app.tsx",
      framework: "solid",
      viewport: { fixed: { logical: [360, 640], presentation: "native" } },
    },
    ...extra,
  };
}

function makeProject(fonts: unknown, extra: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pocket-system-fonts-"));
  const app = join(root, "apps/font-app");
  mkdirSync(join(app, "fonts"), { recursive: true });
  writeFileSync(join(app, "fonts/custom.otf"), Buffer.from("nonempty font fixture"));
  writeFileSync(join(app, "pocket.json"), `${JSON.stringify(makePocketManifest({ ...extra, fonts }), null, 2)}\n`);
  writeFileSync(join(root, "pocket.system.json"), `${JSON.stringify(systemDocument, null, 2)}\n`);
  return root;
}

test("System validation accepts project-local fonts, strips only the extension copy, and leaves the manifest unchanged", { timeout: 120_000 }, async () => {
  const project = makeProject({ regular: "fonts/custom.otf", bold: "fonts/custom.otf" });
  const pocketPath = join(project, "apps/font-app/pocket.json");
  const original = readFileSync(pocketPath, "utf8");
  try {
    const result = await validateSystemFile(join(project, "pocket.system.json"));
    if (!result.ok) throw new Error(result.diagnostics.map(item => `${item.code} ${item.path}: ${item.message}`).join("\n"));
    expect(result.value.packages[0]?.manifest.id).toBe("test.font-app");
    expect(result.value.packages[0]?.manifest).not.toHaveProperty("fonts");
    expect(readFileSync(pocketPath, "utf8")).toBe(original);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("System validation diagnoses unsafe font paths and still rejects unrelated unknown manifest fields", { timeout: 120_000 }, async () => {
  const invalidFontProject = makeProject({ regular: "../outside.otf" });
  const invalidFontPath = join(invalidFontProject, "apps/font-app/pocket.json");
  const invalidFontOriginal = readFileSync(invalidFontPath, "utf8");
  try {
    const result = await validateSystemFile(join(invalidFontProject, "pocket.system.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(item => item.code === "system.invalidProjectFont"
        && item.path === "/applications/catalog/0/resolved/fonts.regular"
        && item.message.includes("must stay inside projectRoot"))).toBe(true);
    }
    expect(readFileSync(invalidFontPath, "utf8")).toBe(invalidFontOriginal);
  } finally {
    rmSync(invalidFontProject, { recursive: true, force: true });
  }

  const unknownProject = makeProject({ regular: "fonts/custom.otf" }, { unexpectedEditorFlag: true });
  const unknownPath = join(unknownProject, "apps/font-app/pocket.json");
  const unknownOriginal = readFileSync(unknownPath, "utf8");
  try {
    const result = await validateSystemDocument(systemDocument, { appRoot: unknownProject });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some(item => item.code === "schema.additionalProperty"
        && item.path === "/applications/catalog/0/resolved/unexpectedEditorFlag"
        && item.message.includes("unknown property")), JSON.stringify(result.diagnostics)).toBe(true);
      expect(result.diagnostics.some(item => item.code === "system.invalidProjectFont")).toBe(false);
    }
    expect(readFileSync(unknownPath, "utf8")).toBe(unknownOriginal);
  } finally {
    rmSync(unknownProject, { recursive: true, force: true });
  }
});

test("the retained Lantern System catalog validates cleanly on host-native fonts without rewriting Demo sources", { timeout: 120_000 }, async () => {
  const demoRoot = resolve(import.meta.dir, "../../../demo/js");
  const systemPath = join(demoRoot, "pocket.system.json");
  const lanternPocketPath = join(demoRoot, "apps/lantern/pocket.json");
  const original = readFileSync(lanternPocketPath, "utf8");
  const result = await validateSystemFile(systemPath);
  if (!result.ok) throw new Error(result.diagnostics.map(item => `${item.code} ${item.path}: ${item.message}`).join("\n"));
  const lantern = result.value.packages.find(item => item.package === "pocket.demo.lantern");
  expect(lantern?.manifest.id).toBe("pocket.demo.lantern");
  expect(lantern?.manifest).not.toHaveProperty("fonts");
  expect(readFileSync(lanternPocketPath, "utf8")).toBe(original);
});
