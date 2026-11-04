import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWechatPreviewManager, type WechatPreviewProcess, type WechatPreviewSpawn } from "../wechat.ts";

class PushStream implements AsyncIterable<string> {
  private readonly queue: string[] = [];
  private readonly waiters: Array<(result: IteratorResult<string>) => void> = [];
  private closed = false;
  push(value: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value }); else this.queue.push(value);
  }
  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ done: true, value: undefined });
  }
  next(): Promise<IteratorResult<string>> {
    const value = this.queue.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  [Symbol.asyncIterator](): AsyncIterator<string> { return this; }
}

class FakeChild implements WechatPreviewProcess {
  readonly stdout = new PushStream();
  readonly stderr = new PushStream();
  readonly kills: Array<string | number | undefined> = [];
  readonly exited: Promise<number>;
  onKill?: () => void;
  private readonly resolveExit: (code: number) => void;
  constructor() { this.exited = new Promise((resolve) => { this.resolveExit = resolve; }); }
  kill(signal?: string | number): void {
    this.kills.push(signal);
    this.onKill?.();
    this.stdout.close();
    this.stderr.close();
    this.resolveExit(signal === "SIGKILL" ? 137 : 143);
  }
}

function writeApp(root: string, appId: string): void {
  writeFileSync(join(root, "pocket.json"), JSON.stringify({ pocket: 2, id: appId }));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
}

function writeSystemProject(root: string): string {
  writeApp(root, "pocket.demo.host");
  const child = join(root, "apps/lobby");
  mkdirSync(child, { recursive: true });
  writeApp(child, "pocket.demo.lobby");
  writeFileSync(join(root, "pocket.system.json"), JSON.stringify({
    pocketSystem: 1,
    roles: { systemUI: "pocket.demo.host" },
    applications: { catalog: [
      { package: "pocket.demo.host", manifest: "pocket.json" },
      { package: "pocket.demo.lobby", manifest: "apps/lobby/pocket.json" },
    ] },
  }));
  return child;
}

function managerFor(root: string, workspaceRoot: string, spawn: WechatPreviewSpawn) {
  return createWechatPreviewManager({
    projectDirectory: () => root,
    workspaceRoot,
    scriptPath: "/trusted/preview_wechat.ts",
    idFactory: () => "run-1",
    spawn,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("discovers one whole-app target for system and main projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-wechat-target-"));
  const workspace = mkdtempSync(join(tmpdir(), "pocket-wechat-workspace-"));
  try {
    writeSystemProject(root);
    const manager = managerFor(root, workspace, () => { throw new Error("spawn must not run during status"); });
    expect((await manager.status("demo")).targets).toEqual([
      { id: "main", label: "pocket.demo.host", appId: "pocket.demo.host" },
    ]);
    manager.dispose();
    const mainRoot = join(root, "main");
    mkdirSync(mainRoot);
    writeApp(mainRoot, "pocket.demo.main");
    const mainManager = createWechatPreviewManager({ projectDirectory: () => mainRoot, workspaceRoot: workspace });
    expect((await mainManager.status("main-project")).targets).toEqual([
      { id: "main", label: "pocket.demo.main", appId: "pocket.demo.main" },
    ]);
    mainManager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("starts immediately, reports readiness, bounds logs, and stops the owned child", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-wechat-life-") );
  const workspace = mkdtempSync(join(tmpdir(), "pocket-wechat-life-work-") );
  let child: FakeChild | undefined;
  let argv: readonly string[] | undefined;
  let spawnOptions: unknown;
  try {
    writeApp(root, "pocket.demo.main");
    const manager = managerFor(root, workspace, (nextArgv, options) => {
      argv = nextArgv;
      spawnOptions = options;
      child = new FakeChild();
      return child;
    });
    const building = await manager.start("demo", "main");
    expect(building.state).toEqual({ state: "building", targetId: "main", logs: [] });
    expect(manager.isBuilding("demo")).toBe(true);
    expect(argv).toEqual([
      process.execPath,
      "/trusted/preview_wechat.ts",
      `--project-root=${root}`,
      `--outdir=${join(workspace, "demo", "run-1")}`,
    ]);
    expect(spawnOptions).toEqual({ cwd: workspace, stdout: "pipe", stderr: "pipe", detached: true });

    for (let index = 0; index < 1_005; index += 1) child!.stdout.push(`log-${index}\n`);
    child!.stderr.push("compiler warning\n");
    child!.stdout.push("POCKET_WECHAT_PREVIEW_URL=http://127.0.0.1:4321\n");
    await flush();
    const running = await manager.status("demo");
    expect(running.state.state).toBe("running");
    expect(running.state.targetId).toBe("main");
    expect(running.state.url).toBe("http://127.0.0.1:4321");
    expect(running.state.logs).toHaveLength(1_000);
    expect(running.state.logs.at(-1)).toBe("log-1004");

    const stopped = await manager.stop("demo");
    expect(stopped.state.state).toBe("stopped");
    expect(stopped.state.targetId).toBe("main");
    expect(child!.kills).toContain("SIGTERM");
    expect(manager.isBuilding("demo")).toBe(false);
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects non-loopback readiness and ignores a late URL after stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-wechat-url-"));
  const workspace = mkdtempSync(join(tmpdir(), "pocket-wechat-url-work-"));
  let child: FakeChild | undefined;
  try {
    writeApp(root, "pocket.demo.main");
    const manager = managerFor(root, workspace, () => {
      child = new FakeChild();
      child.onKill = () => child!.stdout.push("POCKET_WECHAT_PREVIEW_URL=http://127.0.0.1:9999\n");
      return child;
    });
    await manager.start("demo", "main");
    child!.stdout.push("POCKET_WECHAT_PREVIEW_URL=http://localhost:4321\n");
    await flush();
    const rejected = await manager.status("demo");
    expect(rejected.state.state).toBe("error");
    expect(rejected.state.error).toContain("127.0.0.1");
    expect(child!.kills).toContain("SIGTERM");

    const stopped = await manager.stop("demo");
    expect(stopped.state.state).toBe("stopped");
    expect(stopped.state.url).toBeUndefined();
    manager.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("surfaces child stream failures and rejects malformed whole-app roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-wechat-errors-"));
  const workspace = mkdtempSync(join(tmpdir(), "pocket-wechat-errors-work-"));
  try {
    writeApp(root, "pocket.demo.main");
    class BrokenStream implements AsyncIterable<string> {
      async *[Symbol.asyncIterator](): AsyncIterator<string> {
        throw new Error("pipe closed");
      }
    }
    const child = new FakeChild();
    (child as { stdout: unknown }).stdout = new BrokenStream();
    const manager = managerFor(root, workspace, () => child);
    await manager.start("demo", "main");
    await flush();
    const failed = await manager.status("demo");
    expect(failed.state.state).toBe("error");
    expect(failed.state.error).toContain("stdout failed");
    expect(child.kills).toContain("SIGTERM");
    manager.dispose();

    const unsafeRoot = mkdtempSync(join(tmpdir(), "pocket-wechat-unsafe-"));
    try {
      writeApp(unsafeRoot, "pocket.demo.host");
      writeFileSync(join(unsafeRoot, "pocket.system.json"), JSON.stringify({
        pocketSystem: 1,
        roles: { systemUI: "pocket.demo.host" },
        applications: { catalog: [] },
      }));
      const unsafeManager = createWechatPreviewManager({ projectDirectory: () => unsafeRoot, workspaceRoot: workspace });
      await expect(unsafeManager.status("demo")).rejects.toMatchObject({ code: "invalid_target_manifest" });
      unsafeManager.dispose();
    } finally {
      rmSync(unsafeRoot, { recursive: true, force: true });
    }

    const symlinkRoot = mkdtempSync(join(tmpdir(), "pocket-wechat-symlink-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "pocket-wechat-outside-"));
    try {
      writeApp(symlinkRoot, "pocket.demo.host");
      rmSync(join(symlinkRoot, "manifest.json"));
      symlinkSync(join(outsideRoot, "manifest.json"), join(symlinkRoot, "manifest.json"), "file");
      writeFileSync(join(symlinkRoot, "pocket.system.json"), JSON.stringify({
        pocketSystem: 1,
        roles: { systemUI: "pocket.demo.host" },
        applications: { catalog: [{ package: "pocket.demo.host", manifest: "manifest.json" }] },
      }));
      const symlinkManager = createWechatPreviewManager({ projectDirectory: () => symlinkRoot, workspaceRoot: workspace });
      await expect(symlinkManager.status("demo")).rejects.toMatchObject({ code: "invalid_target_manifest" });
      symlinkManager.dispose();
    } finally {
      rmSync(symlinkRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
