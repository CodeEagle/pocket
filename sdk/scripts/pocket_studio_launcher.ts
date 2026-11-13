/**
 * `bun pocket.ts editor --pocket [<project>] [--port=N] [--workspace=DIR]`
 *
 * Launches the Pocket Studio macOS host (a thin Flutter app that runs the Studio guest) for a project. The host
 * itself attaches to a healthy editor service or starts one (`PocketStudioService`), so this module only decides
 * the trusted configuration and writes it to a `--dart-define-from-file` JSON; it contains no Studio logic.
 * The Studio's own guest project is added as an additional trusted project root, so the Studio can open and
 * build itself. Plain `bun pocket.ts editor <project>` remains the web Studio.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, join, resolve } from "node:path";

export const DEFAULT_POCKET_STUDIO_PORT = 8795;
export const NON_MACOS_MESSAGE = "Pocket Studio host is macOS-only; use the web Studio (bun pocket.ts editor) on this platform";

export interface PocketStudioLaunchOptions {
  directory?: string;
  port?: number;
  workspace?: string;
  sdkRoot: string;
}

export interface PocketStudioLaunchEnvironment {
  platform: string;
  cwd: string;
  bun: string;
  flutter: string;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
}

export interface PocketStudioLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  configFile: string;
  /** Contents of the `--dart-define-from-file` JSON (the host's trusted configuration). */
  config: Record<string, string | number | boolean>;
  project: string;
  studioProject: string;
  extraProjectRoots: string[];
}

const hostEnvironment = (): PocketStudioLaunchEnvironment => ({
  platform: process.platform,
  cwd: process.cwd(),
  bun: process.execPath,
  flutter: process.env.POCKET_FLUTTER ?? "flutter",
  exists: existsSync,
  realpath: realpathSync,
});

/** Pure planning step: validates the platform and paths and returns exactly what would be run. */
export function planPocketStudioLaunch(options: PocketStudioLaunchOptions, env: PocketStudioLaunchEnvironment = hostEnvironment()): PocketStudioLaunchPlan {
  if (env.platform !== "darwin") throw new Error(NON_MACOS_MESSAGE);
  const port = options.port ?? DEFAULT_POCKET_STUDIO_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 through 65535 for the Pocket Studio host");
  const project = resolve(env.cwd, options.directory ?? env.cwd);
  if (!env.exists(join(project, "pocket.json"))) {
    throw new Error(`not an initialized PocketJS project: ${project}${options.directory ? "" : " (pass <project> or run inside one)"}`);
  }
  const repoRoot = resolve(options.sdkRoot, "..");
  const studioHost = join(repoRoot, "studio");
  const studioProject = join(studioHost, "js");
  if (!env.exists(join(studioHost, "pubspec.yaml")) || !env.exists(join(studioProject, "pocket.json"))) {
    throw new Error(`Pocket Studio host sources not found at ${studioHost}`);
  }
  if (!env.exists(join(studioHost, "assets", "app.qjbc"))) {
    throw new Error("Studio bytecode is missing: run `cd studio/js && bun install && bun run build` first");
  }
  // The Studio's own project is a second trusted root, unless the user is already editing the Studio itself.
  const sameProject = env.realpath(project) === env.realpath(studioProject);
  const extraProjectRoots = sameProject ? [] : [studioProject];
  const workspace = resolve(env.cwd, options.workspace ?? join(project, ".pocket-editor"));
  const config: PocketStudioLaunchPlan["config"] = {
    POCKET_STUDIO_PORT: port,
    POCKET_STUDIO_SDK_ROOT: resolve(options.sdkRoot),
    POCKET_STUDIO_PROJECT_ROOT: project,
    POCKET_STUDIO_WORKSPACE: workspace,
    POCKET_STUDIO_BUN: env.bun,
    POCKET_STUDIO_EXTRA_PROJECT_ROOTS: extraProjectRoots.join(delimiter),
    POCKET_STUDIO_AUTOSTART: true,
  };
  const configFile = join(workspace, "pocket-studio-host.config.json");
  return {
    command: env.flutter,
    args: ["run", "-d", "macos", `--dart-define-from-file=${configFile}`],
    cwd: studioHost,
    configFile,
    config,
    project,
    studioProject,
    extraProjectRoots,
  };
}

async function serviceHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json() as { service?: string }).service === "pocket-editor";
  } catch {
    return false;
  }
}

/** Writes the trusted config and runs `flutter run -d macos`; resolves with the child's exit code (set on `process`). */
export async function launchPocketStudio(options: PocketStudioLaunchOptions): Promise<void> {
  const plan = planPocketStudioLaunch(options);
  mkdirSync(join(plan.configFile, ".."), { recursive: true });
  writeFileSync(plan.configFile, `${JSON.stringify(plan.config, null, 2)}\n`);
  const port = plan.config.POCKET_STUDIO_PORT as number;
  console.log(`Pocket Studio host: project ${plan.project}`);
  console.log((await serviceHealthy(port))
    ? `editor service already running on 127.0.0.1:${port}: the host attaches to it`
    : `editor service not running on 127.0.0.1:${port}: the host starts it (stopped when the app exits)`);
  console.log(`$ ${plan.command} ${plan.args.join(" ")}  (cwd ${plan.cwd})`);
  await new Promise<void>((done, fail) => {
    const child = spawn(plan.command, plan.args, { cwd: plan.cwd, stdio: "inherit" });
    child.once("error", (error) => fail(new Error(`cannot start ${plan.command}: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code) process.exitCode = code;
      else if (signal) process.exitCode = 1;
      done();
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
  });
}
