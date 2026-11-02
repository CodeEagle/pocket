/**
 * Run the real signed QuickJS update lifecycle against a macOS Flutter host.
 *
 * The update directory and control server are loopback-only. The control
 * endpoint copies one already-signed release into `public/latest.json`; it
 * never signs, edits, or serves private key material.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serveUpdates, type PocketUpdateServer } from "../../../sdk/scripts/serve_updates.ts";

const root = resolve(import.meta.dir, "..");
const updateRoot = join(root, ".pocket-updates");
const releasesRoot = join(updateRoot, "releases");
const publicRoot = join(updateRoot, "public");

type ControlServer = {
  url: string;
  stop: (closeActiveConnections?: boolean) => void;
};

type FlutterProcess = ReturnType<typeof Bun.spawn>;

let runningFlutter: FlutterProcess | undefined;

function stopFlutter(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  try {
    runningFlutter?.kill(signal);
  } catch {
    // The process may have exited between the signal handler and cleanup.
  }
}

function runSetup(): void {
  const result = spawnSync("bun", [join(root, "scripts/dev_updates.ts"), "setup", "1"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`dev_updates.ts setup exited with ${result.status ?? "unknown"}`);
}

function publish(version: string): void {
  if (!/^(1|2|broken)$/.test(version)) throw new Error(`unsupported release ${version}`);
  const source = join(releasesRoot, version, "signed-manifest.json");
  if (!existsSync(source)) throw new Error(`missing signed release: ${source}`);
  copyFileSync(source, join(publicRoot, "latest.json"));
}

function startControlServer(): ControlServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const match = /^\/publish\/(1|2|broken)$/.exec(url.pathname);
      if (request.method !== "POST" || !match) {
        return new Response("Not Found", { status: 404 });
      }
      try {
        publish(match[1]);
        return Response.json({ ok: true, version: match[1] });
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: (closeActiveConnections = true) => server.stop(closeActiveConnections),
  };
}

function parseDevice(argv: string[]): { device: string; flutterArgs: string[] } {
  const args = [...argv];
  let device = "macos";
  const deviceIndex = args.findIndex((value) => value === "--device" || value === "-d");
  if (deviceIndex >= 0) {
    const value = args[deviceIndex + 1];
    if (!value) throw new Error("--device requires a Flutter device id");
    device = value;
    args.splice(deviceIndex, 2);
  } else if (args[0] && !args[0].startsWith("-")) {
    device = args.shift()!;
  }
  return { device, flutterArgs: args };
}

async function runFlutterTest(device: string, definePath: string, extraArgs: string[]): Promise<number> {
  const child = Bun.spawn([
    "flutter",
    "test",
    "-d",
    device,
    `--dart-define-from-file=${definePath}`,
    "integration_test/update_lifecycle_test.dart",
    ...extraArgs,
  ], {
    cwd: resolve(root, ".."),
    stdout: "inherit",
    stderr: "inherit",
  });
  runningFlutter = child;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = Number(process.env.POCKET_UPDATE_TEST_TIMEOUT_MS ?? "900000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("POCKET_UPDATE_TEST_TIMEOUT_MS must be positive");
  const timeoutTimer = setTimeout(() => {
    console.error(`test_updates: Flutter test exceeded ${timeoutMs}ms; sending SIGTERM`);
    stopFlutter("SIGTERM");
    forceKillTimer = setTimeout(() => {
      console.error("test_updates: Flutter did not exit after SIGTERM; sending SIGKILL");
      stopFlutter("SIGKILL");
    }, 5000);
  }, timeoutMs);
  try {
    return await child.exited;
  } finally {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (runningFlutter === child) runningFlutter = undefined;
  }
}

async function main(): Promise<void> {
  const { device, flutterArgs } = parseDevice(process.argv.slice(2));
  let updateServer: PocketUpdateServer | undefined;
  let controlServer: ControlServer | undefined;
  let defineDirectory: string | undefined;
  let exitCode = 1;
  try {
    // This command builds all three signed bytecode releases and publishes v1
    // before Flutter launches. It must not run concurrently with another Rust
    // or Flutter build using the same workspace.
    runSetup();
    publish("1");
    updateServer = serveUpdates({ rootDir: publicRoot, port: 0 });
    controlServer = startControlServer();

    const keyPath = join(updateRoot, "dev-key.json");
    const key = JSON.parse(readFileSync(keyPath, "utf8")) as {
      keyId?: unknown;
      publicKeyBase64?: unknown;
    };
    if (typeof key.keyId !== "string" || typeof key.publicKeyBase64 !== "string") {
      throw new Error("dev-updates key file did not contain public key configuration");
    }
    defineDirectory = mkdtempSync(join(tmpdir(), "pocket-update-test-"));
    // PocketSession validates this as a single safe namespace and resolves it
    // below getApplicationSupportDirectory()/pocket-packages/<appId>. The Flutter
    // integration test removes that real directory in its finally block.
    const storeNamespace = `test-${randomUUID().replaceAll("-", "")}`;
    const definePath = join(defineDirectory, "defines.json");
    writeFileSync(definePath, JSON.stringify({
      POCKET_UPDATE_URL: `${updateServer.url}latest.json`,
      POCKET_UPDATE_KEY_ID: key.keyId,
      POCKET_UPDATE_PUBLIC_KEY: key.publicKeyBase64,
      POCKET_STORE_NAMESPACE: storeNamespace,
      POCKET_TEST_CONTROL_URL: controlServer.url,
    }, null, 2) + "\n");

    console.log(`test_updates: update=${updateServer.url}latest.json`);
    console.log(`test_updates: control=${controlServer.url}`);
    console.log(`test_updates: device=${device}`);
    exitCode = await runFlutterTest(device, definePath, flutterArgs);
  } finally {
    stopFlutter("SIGTERM");
    controlServer?.stop(true);
    updateServer?.stop(true);
    if (defineDirectory) rmSync(defineDirectory, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

if (import.meta.main) {
  const signalCleanup = () => stopFlutter("SIGTERM");
  process.on("SIGINT", signalCleanup);
  process.on("SIGTERM", signalCleanup);
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
