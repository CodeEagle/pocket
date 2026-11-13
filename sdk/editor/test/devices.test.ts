import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceManagerError,
  EditorDeviceManager,
  type ProcessLike,
  type SpawnProcess,
  parseFlutterDevices,
} from "../devices.ts";

function temporaryDirectory(prefix = "pocket-editor-devices-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function chunks(value: string): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      if (value) yield value;
    },
  };
}

function immediateProcess(exitCode = 0, stdout = "", stderr = ""): ProcessLike {
  return { stdout: chunks(stdout), stderr: chunks(stderr), exited: Promise.resolve(exitCode), kill: () => {} };
}

function consumerFixture(system = true): { root: string; js: string } {
  const root = temporaryDirectory("pocket-editor-consumer-");
  const js = join(root, "js");
  mkdirSync(js, { recursive: true });
  writeFileSync(join(root, "pubspec.yaml"), [
    "name: fixture_host",
    "flutter:",
    "  assets:",
    "    - assets/app.qjbc",
    "    - assets/app.pak",
    "    - assets/app.bytecode.json",
    "    - assets/guest-manifest.json",
    ...(system ? ["    - assets/apps/profile/"] : []),
    "",
  ].join("\n"));
  writeFileSync(join(js, "package.json"), JSON.stringify({
    name: "fixture-js",
    scripts: system ? { "build:system": "bun scripts/build_mini_apps.ts && bun run build" } : {},
  }));
  writeFileSync(join(js, "manifest.json"), JSON.stringify({ protocolVersion: 1, capabilities: { requires: [], optional: [] } }));
  writeFileSync(join(js, "pocket.json"), JSON.stringify({ pocket: 2, app: { entry: "app.tsx" } }));
  writeFileSync(join(js, "app.tsx"), "export const fixture = true;\n");
  return { root, js };
}

function machineDevices(): string {
  return JSON.stringify([
    {
      id: "ios-sim-1",
      name: "iPhone 17 Simulator",
      targetPlatform: "darwin-arm64",
      sdk: "iOS 26.0",
      deviceClass: "mobile",
      emulator: true,
      available: true,
      isSupported: true,
    },
    {
      id: "emulator-5554",
      name: "Android Emulator",
      targetPlatform: "android-arm64",
      sdk: "Android 35",
      emulator: true,
      available: true,
      isSupported: true,
    },
    {
      id: "00008101-000000000000001E",
      name: "Lincoln iPhone",
      targetPlatform: "ios-arm64",
      sdk: "iOS 26.0",
      deviceClass: "mobile",
      emulator: false,
      available: true,
      isSupported: true,
    },
  ]);
}

test("parses Flutter machine devices and classifies simulator, emulator, and real device", () => {
  const devices = parseFlutterDevices(machineDevices());
  expect(devices.map((device) => [device.id, device.platform, device.kind])).toEqual([
    ["ios-sim-1", "ios", "ios-simulator"],
    ["emulator-5554", "android", "android-emulator"],
    ["00008101-000000000000001E", "ios", "ios-device"],
  ]);
});

test("keeps Flutter web targets visible but unsupported", () => {
  const [chrome] = parseFlutterDevices(JSON.stringify([{
    id: "chrome",
    name: "Chrome",
    targetPlatform: "web-javascript",
    isSupported: true,
    emulator: false,
  }]));
  expect(chrome?.platform).toBe("web");
  expect(chrome?.supported).toBe(false);
});

test("plan uses only fixed build/run argv and the trusted consumer roots", async () => {
  const fixture = consumerFixture();
  const calls: string[][] = [];
  const spawn: SpawnProcess = (command, options) => {
    calls.push([...command]);
    expect(options.cwd).toBeTruthy();
    return immediateProcess(0, command[1] === "devices" ? machineDevices() : "");
  };
  const manager = new EditorDeviceManager({
    projectDirectory: () => fixture.js,
    flutterDirectory: () => fixture.root,
    commandDirectory: fixture.root,
    flutterCommand: "flutter",
    spawn,
  });
  try {
    const plan = await manager.planDeployment({ projectId: "fixture-app", deviceId: "ios-sim-1", target: "ios-sim" });
    expect(plan.build.command).toEqual(["bun", "run", "build:system"]);
    expect(plan.run.command).toEqual(["flutter", "run", "--machine", "-d", "ios-sim-1", "--no-pub"]);
    expect(calls).toEqual([["flutter", "devices", "--machine"]]);
    expect(plan.projectRoot).toBe(realpathSync(fixture.js));
    expect(plan.flutterRoot).toBe(realpathSync(fixture.root));
  } finally {
    await manager.dispose();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("one fixed Editor index reaches the simulator command", async () => {
  const fixture = consumerFixture();
  const manager = new EditorDeviceManager({
    projectDirectory: () => fixture.js,
    flutterDirectory: () => fixture.root,
    commandDirectory: fixture.root,
    spawn: () => immediateProcess(0, machineDevices()),
    updateConfig: async () => ({ hostConfigUrl: "http://127.0.0.1:8791/test/pocket/0.1.0/fixture.app/latest.json" }),
  });
  try {
    const plan = await manager.planDeployment({ projectId: "fixture-app", deviceId: "ios-sim-1" });
    expect(plan.run.command.filter((arg) => arg.startsWith("--dart-define=POCKET_"))).toEqual(["--dart-define=POCKET_HOST_CONFIG_URL=http://127.0.0.1:8791/test/pocket/0.1.0/fixture.app/latest.json"]);
    expect(plan.run.command.some((arg) => /private|pem/.test(arg))).toBe(false);
  } finally {
    await manager.dispose();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("physical device plans receive only the fixed LAN host index", async () => {
  const fixture = consumerFixture();
  const manager = new EditorDeviceManager({
    projectDirectory: () => fixture.js, flutterDirectory: () => fixture.root,
    commandDirectory: fixture.root, spawn: () => immediateProcess(0, machineDevices()),
    updateConfig: async () => ({ hostConfigUrl: "http://192.168.50.230:8791/test/pocket/0.1.0/fixture.app/latest.json" }),
  });
  try {
    for (const deviceId of ["00008101-000000000000001E", "emulator-5554"]) {
      const plan = await manager.planDeployment({ projectId: "fixture-app", deviceId });
      expect(plan.run.command.filter((arg) => arg.startsWith("--dart-define=POCKET_"))).toEqual(["--dart-define=POCKET_HOST_CONFIG_URL=http://192.168.50.230:8791/test/pocket/0.1.0/fixture.app/latest.json"]);
    }
  } finally { await manager.dispose(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("unbound projects fail honestly instead of fabricating a deployment", async () => {
  const fixture = consumerFixture(false);
  const spawn: SpawnProcess = (command) => immediateProcess(0, command[1] === "devices" ? machineDevices() : "");
  const manager = new EditorDeviceManager({
    projectDirectory: () => fixture.js,
    flutterDirectory: () => undefined,
    commandDirectory: fixture.root,
    spawn,
  });
  try {
    await expect(manager.planDeployment({ projectId: "fixture-app", deviceId: "ios-sim-1" })).rejects.toMatchObject({ code: "flutter_binding_missing" });
  } finally {
    await manager.dispose();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent starts reserve one project/capacity slot and cancel only the owned Flutter child", async () => {
  const fixture = consumerFixture(false);
  const assets = join(fixture.root, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "app.qjbc"), Buffer.from("PJBCfixture"));
  writeFileSync(join(assets, "app.pak"), Buffer.from("DCPKfixture"));
  writeFileSync(join(assets, "app.bytecode.json"), JSON.stringify({ entryFormat: "quickjs-bytecode", bytecodeBytes: 11 }));
  writeFileSync(join(assets, "guest-manifest.json"), "{}\n");
  let releaseRun!: (code: number) => void;
  let runExited = new Promise<number>((resolve) => { releaseRun = resolve; });
  const calls: string[][] = [];
  let flutterProcess: ProcessLike | undefined;
  const spawn: SpawnProcess = (command) => {
    calls.push([...command]);
    if (command[1] === "devices") return immediateProcess(0, machineDevices());
    if (command[1] === "run") {
      flutterProcess = { stdout: chunks('[{"event":"app.started"}]\n'), stderr: chunks(""), exited: runExited, kill: () => releaseRun(130) };
      return flutterProcess;
    }
    return immediateProcess(0);
  };
  const manager = new EditorDeviceManager({
    projectDirectory: () => fixture.js,
    flutterDirectory: () => fixture.root,
    commandDirectory: fixture.root,
    flutterCommand: "flutter",
    spawn,
  });
  try {
    const first = await manager.startDeployment({ projectId: "fixture-app", deviceId: "ios-sim-1" });
    const second = manager.startDeployment({ projectId: "fixture-app", deviceId: "ios-sim-1" });
    const secondError = await second.then(() => undefined, (error) => error as DeviceManagerError);
    expect(secondError).toBeDefined();
    expect(["deployment_busy", "deployment_limit"]).toContain(secondError?.code);
    expect(manager.isBusy("fixture-app")).toBe(true);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (calls.some((command) => command[1] === "run" && command.includes("--machine"))) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(calls.some((command) => command[1] === "run" && command.includes("--machine"))).toBe(true);
    expect(manager.getStatus(first.id).state).toBe("running");
    await manager.cancel(first.id);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!manager.isBusy("fixture-app")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(manager.getStatus(first.id).state).toBe("canceled");
    expect(flutterProcess).toBeDefined();
  } finally {
    releaseRun?.(130);
    await manager.dispose();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects unsafe project ids before resolving a directory", async () => {
  let resolved = false;
  const manager = new EditorDeviceManager({
    projectDirectory: () => { resolved = true; return "/tmp/project"; },
    flutterDirectory: () => "/tmp/flutter",
  });
  try {
    await expect(manager.startDeployment({ projectId: "../escape", deviceId: "ios-sim-1" })).rejects.toBeInstanceOf(DeviceManagerError);
    expect(resolved).toBe(false);
  } finally {
    await manager.dispose();
  }
});
