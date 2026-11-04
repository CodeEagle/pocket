import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { wechatEmbedDocument } from "../preview_wechat.ts";

type Geometry = {
  viewport: { width: number; height: number };
  slot: { x: number; y: number; width: number; height: number };
  device: { x: number; y: number; width: number; height: number };
  toolbarDisplay: string;
  transform: string;
};

const officialPhoneShellFixture = `(() => {
  const root = document.getElementById('wxa-root');
  if (!root) throw new Error('missing official WXA root');
  root.innerHTML = '<div class="wxa-stage"><div class="wxa-toolbar">Phone shell controls</div>' +
    '<div class="wxa-device-slot" style="box-sizing:border-box;position:relative;width:401px;height:838px;padding:13px;overflow:hidden">' +
    '<div class="wxa-device" style="position:absolute;width:375px;height:812px;left:13px;top:13px;transform:scale(0.85);transform-origin:top left;background:#fff">' +
    '<main id="phone-shell-content">Official phone shell fixture</main></div></div></div>';
})();`;

async function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`missing ${selector}`);
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const device = document.querySelector<HTMLElement>(".wxa-device");
    const toolbar = document.querySelector<HTMLElement>(".wxa-toolbar");
    if (!device || !toolbar) throw new Error("missing WXA fixture nodes");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      slot: rect(".wxa-device-slot"),
      device: rect(".wxa-device"),
      toolbarDisplay: getComputedStyle(toolbar).display,
      transform: getComputedStyle(device).transform,
    };
  });
}

function assertContain(geometry: Geometry): void {
  const epsilon = 1;
  expect(geometry.slot.x).toBeGreaterThanOrEqual(-epsilon);
  expect(geometry.slot.y).toBeGreaterThanOrEqual(-epsilon);
  expect(geometry.slot.x + geometry.slot.width).toBeLessThanOrEqual(geometry.viewport.width + epsilon);
  expect(geometry.slot.y + geometry.slot.height).toBeLessThanOrEqual(geometry.viewport.height + epsilon);
  expect(geometry.device.x).toBeGreaterThanOrEqual(-epsilon);
  expect(geometry.device.y).toBeGreaterThanOrEqual(-epsilon);
  expect(geometry.device.x + geometry.device.width).toBeLessThanOrEqual(geometry.viewport.width + epsilon);
  expect(geometry.device.y + geometry.device.height).toBeLessThanOrEqual(geometry.viewport.height + epsilon);
  expect(geometry.toolbarDisplay).toBe("none");
}

test("WeChat embed bootstrap contains the official phone surface and reapplies fit after resize", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(wechatEmbedDocument(), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (path === "/__wxa__/runtime/host.js") return new Response(officialPhoneShellFixture, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      return new Response("not found", { status: 404 });
    },
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.port}/?fit=contain`);
    await page.locator(".wxa-device").waitFor({ state: "visible" });
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".wxa-toolbar")!).display === "none");
    const fitOne = await readGeometry(page);
    assertContain(fitOne);
    expect(fitOne.device.width).toBeCloseTo(375, 0);
    expect(fitOne.device.height).toBeCloseTo(812, 0);
    expect(fitOne.transform).not.toContain("0.85");

    await page.setViewportSize({ width: 450, height: 900 });
    await page.waitForFunction(() => {
      const device = document.querySelector<HTMLElement>(".wxa-device");
      return !!device && device.getBoundingClientRect().width > 375;
    });
    const resized = await readGeometry(page);
    assertContain(resized);
    const expectedScale = Math.min(450 / 375, 900 / 812);
    expect(resized.device.width).toBeCloseTo(375 * expectedScale, 0);
    expect(resized.device.height).toBeCloseTo(812 * expectedScale, 0);

    await page.setViewportSize({ width: 300, height: 700 });
    await page.waitForFunction(() => {
      const device = document.querySelector<HTMLElement>(".wxa-device");
      return !!device && device.getBoundingClientRect().width <= 300.5;
    });
    const narrow = await readGeometry(page);
    assertContain(narrow);
    expect(narrow.device.width).toBeCloseTo(375 * Math.min(300 / 375, 700 / 812), 0);
    expect(pageErrors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
  }
});
