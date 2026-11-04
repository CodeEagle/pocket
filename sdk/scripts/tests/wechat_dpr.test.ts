import { expect, test } from "bun:test";
import { PocketWechatHost } from "../../targets/wechat/template/wechat-host.js";

function host(browser = false, browserRatio?: number): PocketWechatHost {
  return new PocketWechatHost({
    wx: browser ? {
      __pocketBrowserPreview: true,
      ...(browserRatio === undefined ? {} : { __pocketBrowserDevicePixelRatio: () => browserRatio }),
    } : {},
    config: { appId: "dpr-test", requires: [] },
    canvas: { width: 1, height: 1 },
    context: { createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) },
    onInput: () => {},
    onError: () => {},
    isActive: () => false,
  });
}

test("browser WeChat preview preserves device density while native Canvas keeps its package limit", () => {
  const browser = host(true);
  const native = host(false);
  expect(browser.pixelScale(375, 812, 3)).toBe(3);
  expect(native.pixelScale(375, 812, 3)).toBe(1);
  expect(host(true, 1.25).currentDevicePixelRatio(3)).toBe(1.25);
  expect(host(true, 1.25).pixelScale(375, 812, 3)).toBe(2);
  expect(host(true, 1.5).pixelScale(375, 812, 3)).toBe(2);
  expect(host(true, 2).pixelScale(375, 812, 3)).toBe(2);

  browser.logicalWidth = browser.width = 375;
  browser.logicalHeight = browser.height = 812;
  browser.scale = 3;
  browser.configureCanvas();
  expect(browser.canvas.width).toBe(1125);
  expect(browser.canvas.height).toBe(2436);
  expect(browser.imageData.data.length).toBe(1125 * 2436 * 4);
});
