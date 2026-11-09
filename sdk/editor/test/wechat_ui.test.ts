import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const clientRoot = resolve(import.meta.dir, "../client");
const html = readFileSync(join(clientRoot, "index.html"), "utf8");
const script = readFileSync(join(clientRoot, "editor.js"), "utf8");
const css = readFileSync(join(clientRoot, "editor.css"), "utf8");

test("editor exposes the non-popup WeChat validation controls alongside Canvas/device preview", () => {
  for (const id of ["wechat-project-label", "wechat-state", "wechat-start", "wechat-stop", "wechat-open", "wechat-validation-hint"]) {
    expect(html).toContain(`id="${id}"`);
  }
  expect(html).toContain('class="control-label">微信</span>');
  expect(html).toContain("运行");
  expect(html).toContain("构建会准备 Flutter 包。各平台有独立的预览控制。蓝牙预览使用宿主的可选 Noble 适配器；平台验收请连接真实设备。");
  expect(html).not.toContain("wechat-target-picker");
  expect(html).toContain('id="wechat-open" class="button secondary small-button" href="#" target="_blank" rel="noopener" hidden');
  expect(html).toContain('id="preview-frame"');
  expect(html).toContain('id="device-picker"');
  expect(script).toContain('return `/api/projects/${encodeURIComponent(projectId)}/wechat`;');
  expect(script).toContain('method: "POST"');
  expect(script).toContain('body: JSON.stringify({ targetId })');
  expect(script).toContain('const targetId = "main";');
  expect(script).toContain('method: "DELETE"');
  expect(script).toContain('targetId: typeof value?.targetId === "string" ? value.targetId : ""');
  expect(script).toContain("pollWechat");
  expect(script).toContain("generation !== wechatGeneration");
  expect(css).toContain(".wechat-validation-controls");
  expect(css).toContain(".preview-options-content");
});
