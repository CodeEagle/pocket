import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../pocket.ts";

const sdkRoot = join(import.meta.dir, "../..");

function withFlutterUnavailable<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = "/usr/bin/false";
  return run().finally(() => {
    if (previous === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previous;
  });
}

test("init defaults to the app template and records the selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-template-app-"));
  try {
    await withFlutterUnavailable(async () => {
      const project = await initProject(join(root, "app"));
      const editor = JSON.parse(readFileSync(join(project, "editor.json"), "utf8"));
      expect(editor.template).toBe("app");
      expect(readFileSync(join(project, "app.tsx"), "utf8")).toBe(readFileSync(join(sdkRoot, "templates/app/app.tsx"), "utf8"));
      expect(readFileSync(join(project, "README.md"), "utf8")).toContain("app template");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init copies the game template when selected", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-template-game-"));
  try {
    await withFlutterUnavailable(async () => {
      const project = await initProject(join(root, "game"), { template: "game" });
      const editor = JSON.parse(readFileSync(join(project, "editor.json"), "utf8"));
      expect(editor.template).toBe("game");
      expect(readFileSync(join(project, "app.tsx"), "utf8")).toBe(readFileSync(join(sdkRoot, "templates/game/app.tsx"), "utf8"));
      expect(readFileSync(join(project, "README.md"), "utf8")).toContain("game template");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid template is rejected before creating the target", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-template-invalid-"));
  const target = join(root, "invalid");
  try {
    await expect(initProject(target, { template: "board" as any })).rejects.toThrow(/template/i);
    expect(existsSync(target)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init still rejects a non-empty target", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-template-nonempty-"));
  const target = join(root, "existing");
  try {
    mkdirSync(target);
    writeFileSync(join(target, "custom.tsx"), "keep");
    await expect(initProject(target, { template: "game" })).rejects.toThrow(/empty/i);
    expect(readFileSync(join(target, "custom.tsx"), "utf8")).toBe("keep");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
