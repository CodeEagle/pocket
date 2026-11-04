import { expect, test } from "bun:test";
import { PocketWechatHost } from "../../targets/wechat/template/wechat-host.js";
import { PocketWechatSystem, wechatBuiltinCapability } from "../../targets/wechat/template/wechat-system.js";

function fixture() {
  const events: any[] = [], destroyed: string[] = [];
  const root: any = {
    config: { appId: "host", system: { apps: [{ appId: "host", index: 0 }, { appId: "profile", index: 1, surfaceHandle: 2 }, { appId: "lobby", index: 2, surfaceHandle: 3 }] } },
    logicalWidth: 390, logicalHeight: 844, visible: true,
    error: (code: string, message: string) => Object.assign(new Error(message), { code }),
    deliverGuestEvent: (name: string, payload: any) => events.push({ name, payload }),
    exports: { web_free_surface: () => {} },
  };
  const system = new PocketWechatSystem(root, (app: any) => ({ config: app,
    start: async () => {}, stopScheduled: () => {}, dispose: () => destroyed.push(app.appId) }));
  const request = (source: any, capability: string, params: any = {}, controller = new AbortController()) => system.request(source, { capability, params }, controller.signal);
  return { root, system, request, events, destroyed };
}

test("System transport rejects child control calls and catalog escapes", async () => {
  const { root, request } = fixture();
  await expect(request({}, "system.runtime.configure", { systemUI: "host" })).rejects.toMatchObject({ code: "system_context_denied" });
  await expect(request(root, "system.runtime.configure", { systemUI: "other" })).rejects.toMatchObject({ code: "system_context_denied" });
  await request(root, "system.runtime.configure", { systemUI: "host" });
  await expect(request(root, "system.runtime.create", { appId: "outside" })).rejects.toMatchObject({ code: "app_not_found" });
});

test("creating a second mini app retains the first independent runtime", async () => {
  const { root, system, request, destroyed } = fixture();
  await request(root, "system.runtime.configure", { systemUI: "host" });
  const first = await request(root, "system.runtime.create", { appId: "profile" });
  const second = await request(root, "system.runtime.create", { appId: "lobby" });
  expect(first.instanceId).not.toBe(second.instanceId);
  expect(system.runtimes.size).toBe(2);
  expect(destroyed).toEqual([]);
  await request(root, "system.runtime.destroy", { instanceId: second.instanceId });
  expect(system.runtimes.has("profile")).toBe(true);
  expect(destroyed).toEqual(["lobby"]);
  system.dispose();
});

test("platform requests use the real SystemUI response contract and abort removes pending work", async () => {
  const { root, system, request, events } = fixture();
  await request(root, "system.runtime.configure", { systemUI: "host" });
  const created = await request(root, "system.runtime.create", { appId: "profile" });
  const child = system.runtimes.get("profile");
  const result = request(child, "platform.storage.get", { namespace: "identity", key: "selected" });
  const event = events[0];
  expect(event.name).toBe("system.request");
  expect(event.payload.sourceAppId).toBe("profile");
  expect(event.payload.sourceInstanceId).toBe(created.instanceId);
  expect(event.payload.sourceGeneration).toBe(created.generation);
  await request(root, "system.runtime.respond", { requestId: event.payload.requestId, ok: true, value: { name: "selected user" } });
  expect(await result).toEqual({ name: "selected user" });
  const controller = new AbortController();
  const cancelled = request(child, "platform.apps.open", { appId: "lobby" }, controller);
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
  expect(system.pending.size).toBe(0);
  system.dispose();
});

test("SystemUI instance receives kernel posts and cannot be destroyed as a child", async () => {
  const { root, request, events } = fixture();
  await request(root, "system.runtime.configure", { systemUI: "host" });
  await request(root, "system.runtime.post", { instanceId: "system-ui", event: "platform.ready", params: { ready: true } });
  expect(events).toEqual([{ name: "platform.ready", payload: { ready: true } }]);
  await expect(request(root, "system.runtime.destroy", { instanceId: "system-ui" })).rejects.toMatchObject({ code: "runtime_destroyed" });
});

test("WeChat builtins report embedded Guest metadata without claiming Flutter services", () => {
  const source: any = {
    config: {
      appId: "pocket.host.demo",
      tickHz: 60,
      metadata: {
        package: { id: "pocket.host.demo", name: "pocket-host-showcase", title: "Pocket Host", version: "0.1.0" },
        qjbc: { entryFormat: "quickjs-bytecode", runtimeAbi: "quickjs-bytecode-v1:test", engineAbi: "engine-test", bytecodeBytes: 1234, version: "0.1.0", build: 7, tickHz: 60 },
      },
    },
    logicalWidth: 390,
    logicalHeight: 844,
    scale: 3,
    wx: { getAccountInfoSync: () => ({ miniProgram: { appId: "wx-test", envVersion: "develop", version: "1.2.3" } }) },
    error: (code: string, message: string) => Object.assign(new Error(message), { code }),
  };
  const runtime = wechatBuiltinCapability(source, "runtime.info", {});
  expect(runtime).toMatchObject({ appId: "pocket.host.demo", provider: "wechat", host: "wechat", scale: 3, nativeFlutterTiming: false, build: 7 });
  expect(runtime.features).toEqual({ recording: false, flutterFrameTiming: false, nativeHardware: false });
  const packageInfo = wechatBuiltinCapability(source, "plugins.packageInfo", {});
  expect(packageInfo).toMatchObject({ appId: "pocket.host.demo", packageName: "pocket.host.demo", version: "0.1.0", buildNumber: "7" });
  expect(packageInfo.miniProgram).toEqual({ appId: "wx-test", envVersion: "develop", version: "1.2.3" });
  expect(wechatBuiltinCapability(source, "plugins.list", {})).toEqual({ protocolVersion: 1, appId: "pocket.host.demo", provider: "wechat", plugins: [] });
  expect(wechatBuiltinCapability(source, "updates.status", {})).toMatchObject({ configured: false, stage: "disabled", activeVersion: "0.1.0", activeBuild: 7 });
});


test("single Guest builtin requests cross the declared host boundary without a permission callback", async () => {
  const host: any = new PocketWechatHost({ wx: {}, config: {
    appId: "single", optional: ["runtime.info", "plugins.packageInfo"],
    metadata: { qjbc: { runtimeAbi: "quickjs-bytecode-v1:single", version: "2.0", build: 3 } },
  }, canvas: {}, context: {}, isActive: () => true });
  host.exports = {};
  host.host = 1;
  host.visible = true;
  const responses: any[] = [];
  host.respond = (request: any, ok: boolean, result: any, error: any) => responses.push({ request, ok, result, error });
  await host.handleRequest({ requestId: "runtime", capability: "runtime.info" });
  await host.handleRequest({ requestId: "package", capability: "plugins.packageInfo" });
  await host.handleRequest({ requestId: "denied", capability: "plugins.list" });
  expect(responses[0]).toMatchObject({ ok: true, result: { appId: "single", runtimeAbi: "quickjs-bytecode-v1:single" } });
  expect(responses[1]).toMatchObject({ ok: true, result: { packageName: "single", version: "2.0", buildNumber: "3" } });
  expect(responses[2]).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  expect(host.pending.size).toBe(0);
});
