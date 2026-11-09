import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { NativeSession, readNativeArtifacts, textOps, textOf } from "./native_session.ts";

const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_SAFE_VN_GUEST_BYTECODE ??= `${directory}/app.qjbc`;
process.env.POCKET_SAFE_VN_GUEST_PAK ??= `${directory}/app.pak`;
process.env.POCKET_SAFE_VN_GUEST_METADATA ??= `${directory}/app.bytecode.json`;
const artifacts = readNativeArtifacts("POCKET_SAFE_VN");

test("mobile game header and toolbar follow safe-area updates and retain real pointer input", async () => {
  const session = new NativeSession(artifacts, { width: 390, height: 844, deadlineMs: 90_000 });
  try {
    let frame = await session.boot();
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 24);
    for (const device of [
      { width: 390, height: 844, safeArea: { top: 59, right: 0, bottom: 34, left: 0 } },
      { width: 412, height: 915, safeArea: { top: 32, right: 0, bottom: 24, left: 0 } },
      { width: 844, height: 390, safeArea: { top: 0, right: 59, bottom: 21, left: 59 } },
      { width: 390, height: 844, safeArea: { top: 59, right: 0, bottom: 34, left: 0 } },
    ]) {
      if (session.width !== device.width || session.height !== device.height) frame = await session.resize(device.width, device.height);
      session.sendEvent("display.viewport", { ...device, keyboardInset: 0, reservedRegions: [] });
      frame = await session.settle(await session.frame(), 4);
      for (const label of ["手札", "回声"]) {
        const op = textOps(frame, label)[0];
        expect(op, `${label} must be painted`).toBeDefined();
        expect(op!.x!).toBeGreaterThanOrEqual(device.safeArea.left);
        expect(op!.x! + op!.w!).toBeLessThanOrEqual(device.width - device.safeArea.right);
        expect(op!.y!).toBeGreaterThanOrEqual(device.safeArea.top);
        expect(op!.y! + op!.h!).toBeLessThanOrEqual(device.height - device.safeArea.bottom);
      }
      frame = await session.tap("手札", frame);
      frame = await session.settle(frame, 2);
      expect(textOf(frame)).toContain("旅途手札");
      frame = await session.tap("继续阅读", frame);
      frame = await session.settle(frame, 2);
      expect(textOf(frame)).not.toContain("旅途手札");
    }
    // A localized top-right status cluster must also reserve the host close
    // control after it moves inward. The page body remains full width.
    frame = await session.resize(844, 600);
    session.sendEvent("display.viewport", {
      width: 844, height: 600, safeArea: { top: 0, right: 100, bottom: 0, left: 0 }, keyboardInset: 0,
      reservedRegions: [
        { id: "status-cluster", kind: "occlusion", active: true, frame: { left: 744, top: 0, width: 100, height: 90 } },
        { id: "fold", kind: "division", active: false, frame: { left: 420, top: 0, width: 4, height: 600 } },
      ],
    });
    frame = await session.settle(await session.frame(), 4);
    const menu = textOps(frame, "手札")[0];
    expect(menu).toBeDefined();
    expect(menu!.x! + menu!.w!, "menu stays before the inward host-action band").toBeLessThanOrEqual(684);
    console.log(`localized mobile header: menu x=${menu!.x}, right=${menu!.x! + menu!.w!}, y=${menu!.y}`);
    // This coordinate belonged to the former menu target, underneath the
    // inward host-action band. It must no longer open the game's menu.
    frame = await session.tapPoint({ x: 730, y: 30 });
    frame = await session.settle(frame, 2);
    expect(textOf(frame)).not.toContain("旅途手札");
    frame = await session.tap("手札", frame);
    frame = await session.settle(frame, 2);
    expect(textOf(frame)).toContain("旅途手札");
  } finally { await session.quit(); }
}, 120_000);

test("mobile safe-area facts survive storage-delayed game view mounting", async () => {
  for (const device of [
    { width: 411, height: 731, safeArea: { top: 24, right: 0, bottom: 23.5714, left: 0 } },
    { width: 390, height: 844, safeArea: { top: 59, right: 0, bottom: 34, left: 0 } },
  ]) {
    const session = new NativeSession(artifacts, { ...device, deferCapabilities: ["platform.storage.get"], deadlineMs: 90_000 });
    try {
      let frame = await session.boot();
      expect(textOf(frame)).toContain("正在翻开雾港手札");
      session.sendEvent("display.viewport", { ...device, keyboardInset: 0, reservedRegions: [] });
      frame = await session.frame();
      let replied = 0;
      for (let attempt = 0; attempt < 80 && !textOf(frame).includes("启程 · 开始新的故事"); attempt++) {
        if (session.requests.filter(request => request.capability === "platform.storage.get").length > replied) {
          session.respondPending("platform.storage.get", null);
          replied++;
        }
        frame = await session.frame();
      }
      expect(textOf(frame)).toContain("启程 · 开始新的故事");
      frame = await session.tap("启程 · 开始新的故事", frame);
      frame = await session.settle(frame, 4);
      for (const label of ["手札", "回声"]) {
        const op = textOps(frame, label)[0];
        expect(op).toBeDefined();
        expect(op!.y!, `${label} retains the one early host fact`).toBeGreaterThanOrEqual(device.safeArea.top);
        expect(op!.y! + op!.h!).toBeLessThanOrEqual(device.height - device.safeArea.bottom);
      }
      frame = await session.tap("手札", frame);
      expect(textOf(frame)).toContain("旅途手札");
      frame = await session.tap("继续阅读", frame);
      expect(textOf(frame)).not.toContain("旅途手札");
    } finally { await session.quit(); }
  }
}, 120_000);
