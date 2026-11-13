import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEditorArgs } from "../../pocket.ts";
import { NON_MACOS_MESSAGE, planPocketStudioLaunch, type PocketStudioLaunchEnvironment } from "../pocket_studio_launcher.ts";

// Argument handling and launch planning only: Flutter is never started here.
const pocketTs = join(import.meta.dir, "../../pocket.ts");

function layout(): { root: string; sdk: string; project: string; studioJs: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pocket-launcher-"));
  const sdk = join(root, "sdk");
  const studioJs = join(root, "studio/js");
  const project = join(root, "my-app");
  for (const dir of [sdk, studioJs, join(root, "studio/assets"), project]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "studio/pubspec.yaml"), "name: x\n");
  writeFileSync(join(studioJs, "pocket.json"), "{}");
  writeFileSync(join(root, "studio/assets/app.qjbc"), "x");
  writeFileSync(join(project, "pocket.json"), "{}");
  return { root, sdk, project, studioJs, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const real = (): PocketStudioLaunchEnvironment => ({
  platform: "darwin", cwd: "/", bun: "/usr/local/bin/bun", flutter: "flutter",
  exists: (path) => require("node:fs").existsSync(path), realpath: (path) => require("node:fs").realpathSync(path),
});

test("plain editor arguments keep the web Studio contract; --pocket makes the directory optional", () => {
  expect(parseEditorArgs(["app", "--port=9000"])).toMatchObject({ directory: "app", pocket: false, port: 9000 });
  expect(() => parseEditorArgs(["--port=9000"])).toThrow(/project directory is required|project directory/);
  expect(parseEditorArgs(["--pocket"])).toMatchObject({ pocket: true, directory: undefined });
  expect(parseEditorArgs(["--pocket", "app", "--port", "8801", "--workspace=/w"])).toMatchObject({ pocket: true, directory: "app", port: 8801, workspace: "/w" });
  expect(parseEditorArgs(["app", "--pocket"])).toMatchObject({ pocket: true, directory: "app" });
  expect(parseEditorArgs(["--pocket", "--port=8801"])).toMatchObject({ pocket: true, directory: undefined, port: 8801 });
});

test("service-side options parse for the Studio host's own spawn and are rejected with --pocket", () => {
  const parsed = parseEditorArgs(["app", "--extra-project-root=/a", "--extra-project-root", "/b", "--provision-update-key", "--update-host-version=studio"]);
  expect(parsed.extraProjectRoots).toEqual(["/a", "/b"]);
  expect(parsed.provisionUpdateKey).toBe(true);
  expect(parsed.updateHostVersion).toBe("studio");
  expect(() => parseEditorArgs(["--pocket", "app", "--extra-project-root=/a"])).toThrow(/--pocket/);
  expect(() => parseEditorArgs(["--pocket", "--update-host-version=x"])).toThrow(/--pocket/);
  expect(() => parseEditorArgs(["--pocket", "app", "--port=70000"])).toThrow(/--port/);
  expect(() => parseEditorArgs(["--pocket", "a", "b"])).toThrow(/unknown option/);
});

test("non-macOS exits with the clear macOS-only error before touching anything", () => {
  const l = layout();
  try {
    for (const platform of ["linux", "win32"]) {
      expect(() => planPocketStudioLaunch({ directory: l.project, sdkRoot: l.sdk }, { ...real(), platform })).toThrow(NON_MACOS_MESSAGE);
    }
    expect(NON_MACOS_MESSAGE).toBe("Pocket Studio host is macOS-only; use the web Studio (bun pocket.ts editor) on this platform");
    if (process.platform !== "darwin") {
      const run = spawnSync(process.execPath, [pocketTs, "editor", "--pocket", l.project], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(NON_MACOS_MESSAGE);
    }
  } finally {
    l.dispose();
  }
});

test("macOS plan: trusted config file, flutter run, the Studio's own project as an extra root", () => {
  const l = layout();
  try {
    const plan = planPocketStudioLaunch({ directory: l.project, port: 8811, sdkRoot: l.sdk }, { ...real(), cwd: l.root });
    expect(plan.command).toBe("flutter");
    expect(plan.args).toEqual(["run", "-d", "macos", `--dart-define-from-file=${plan.configFile}`]);
    expect(plan.cwd).toBe(join(l.root, "studio"));
    expect(plan.config).toMatchObject({
      POCKET_STUDIO_PORT: 8811, POCKET_STUDIO_SDK_ROOT: l.sdk, POCKET_STUDIO_PROJECT_ROOT: l.project,
      POCKET_STUDIO_WORKSPACE: join(l.project, ".pocket-editor"), POCKET_STUDIO_BUN: "/usr/local/bin/bun",
      POCKET_STUDIO_EXTRA_PROJECT_ROOTS: l.studioJs, POCKET_STUDIO_AUTOSTART: true,
    });
    expect(plan.configFile).toBe(join(l.project, ".pocket-editor", "pocket-studio-host.config.json"));
    // Default project is the current directory; default port is the host's.
    const inCwd = planPocketStudioLaunch({ sdkRoot: l.sdk }, { ...real(), cwd: l.project });
    expect(inCwd.project).toBe(l.project);
    expect(inCwd.config.POCKET_STUDIO_PORT).toBe(8795);
    // Editing the Studio itself adds no duplicate root.
    const self = planPocketStudioLaunch({ directory: l.studioJs, sdkRoot: l.sdk, workspace: join(l.root, "ws") }, { ...real(), cwd: l.root });
    expect(self.extraProjectRoots).toEqual([]);
    expect(self.config.POCKET_STUDIO_EXTRA_PROJECT_ROOTS).toBe("");
    expect(self.config.POCKET_STUDIO_WORKSPACE).toBe(join(l.root, "ws"));
  } finally {
    l.dispose();
  }
});

test("macOS plan rejects a missing project, missing Studio sources and missing bytecode", () => {
  const l = layout();
  try {
    expect(() => planPocketStudioLaunch({ directory: join(l.root, "nope"), sdkRoot: l.sdk }, { ...real(), cwd: l.root })).toThrow(/not an initialized PocketJS project/);
    expect(() => planPocketStudioLaunch({ sdkRoot: l.sdk }, { ...real(), cwd: l.root })).toThrow(/pass <project> or run inside one/);
    expect(() => planPocketStudioLaunch({ directory: l.project, sdkRoot: l.sdk, port: 0 }, { ...real(), cwd: l.root })).toThrow(/--port/);
    expect(() => planPocketStudioLaunch({ directory: l.project, sdkRoot: join(l.root, "elsewhere", "sdk") }, { ...real(), cwd: l.root })).toThrow(/sources not found/);
    rmSync(join(l.root, "studio/assets/app.qjbc"));
    expect(() => planPocketStudioLaunch({ directory: l.project, sdkRoot: l.sdk }, { ...real(), cwd: l.root })).toThrow(/bytecode is missing/);
  } finally {
    l.dispose();
  }
});
