import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const clientRoot = resolve(import.meta.dir, "../client");
const html = readFileSync(join(clientRoot, "index.html"), "utf8");
const script = readFileSync(join(clientRoot, "editor.js"), "utf8");
const css = readFileSync(join(clientRoot, "editor.css"), "utf8");

test("editor exposes the non-popup WeChat validation controls alongside the local project editor", () => {
  for (const id of ["wechat-project-label", "wechat-state", "wechat-start", "wechat-stop", "wechat-open", "wechat-validation-hint"]) {
    expect(html).toContain(`id="${id}"`);
  }
  expect(html).toContain("Whole app");
  expect(html).toContain("Run WeChat");
  expect(html).toContain("WeChat 整个 App 验证；硬件能力仍需真机验证");
  expect(html).not.toContain("wechat-target-picker");
  expect(html).toContain('id="wechat-open" class="button secondary small-button" href="#" target="_blank" rel="noopener" hidden');
  expect(script).toContain('return `/api/projects/${encodeURIComponent(projectId)}/wechat`;');
  expect(script).toContain('method: "POST"');
  expect(script).toContain('body: JSON.stringify({ targetId })');
  expect(script).toContain('const targetId = "main";');
  expect(script).toContain('method: "DELETE"');
  expect(script).toContain('targetId: typeof value?.targetId === "string" ? value.targetId : ""');
  expect(script).toContain("pollWechat");
  expect(script).toContain("generation !== wechatGeneration");
  expect(css).toContain(".wechat-validation-controls");
  expect(css).toContain(".wechat-validation-hint");
});
