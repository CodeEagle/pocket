import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest, parseBuildGuestArgs, resolveReleaseIdentity } from "../build_guest.ts";
import { buildProject } from "../../pocket.ts";

// These tests exercise the full pinned JSX compiler and the Rust QuickJS
// bytecode builder.  Bun's per-test default is 5 seconds, which is shorter
// than a cold native build (and becomes especially flaky when the editor or
// another package test is compiling concurrently).
const BUILD_GUEST_TEST_TIMEOUT_MS = 120_000;

test("build_guest validates and forwards the bounded raster density option", () => {
  expect(parseBuildGuestArgs(["--density=3"]).rasterDensity).toBe(3);
  expect(() => parseBuildGuestArgs(["--density=0"])).toThrow(/1 through 4/);
  expect(() => parseBuildGuestArgs(["--density=5"])).toThrow(/1 through 4/);
  expect(() => parseBuildGuestArgs(["--density=2.5"])).toThrow(/1 through 4/);
});

function linkPackageFiles(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) linkPackageFiles(sourcePath, targetPath);
    else if (entry.isFile()) symlinkSync(sourcePath, targetPath);
    else throw new Error(`unsupported package fixture entry: ${sourcePath}`);
  }
}

function packageFiles(root: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...packageFiles(path, relative));
    else result.push(relative);
  }
  return result.sort();
}

test("build_guest preserves an installed real @pocket/ui directory", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-installed-ui-"));
  const output = join(project, "out");
  const installed = join(project, "node_modules/@pocket/ui");
  try {
    cpSync(join(import.meta.dir, "../../packages/pocket_ui"), installed, { recursive: true });
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), `import { MobileButton } from "@pocket/ui";
import { mount } from "@pocketjs/framework/solid";

mount(() => <MobileButton label="Installed package" onPress={() => {}} />);
`);

    const result = await buildGuest({ projectRoot: project, outDir: output });
    const metadata = JSON.parse(readFileSync(result.metadata, "utf8")) as Record<string, unknown>;
    expect(metadata.entryFormat).toBe("quickjs-bytecode");
    expect(metadata.bytecodeBytes).toBeGreaterThan(0);
    expect(existsSync(join(project, ".pocket-ui.lock"))).toBe(false);
    // The package manager's source directory is restored after the build; the
    // compiler's transformed copy never leaks into the consumer project.
    expect(readFileSync(join(installed, "src/mobile.tsx"), "utf8")).toContain("<");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, BUILD_GUEST_TEST_TIMEOUT_MS);

test("build_guest preserves domains.worker as an admitted QuickJS bytecode artifact", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-worker-domain-"));
  const output = join(project, "out");
  const assets = join(project, "assets");
  try {
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      app: { entry: "app.tsx" },
      domains: { worker: {
        entry: "worker.ts",
        nodes: [{ name: "localHttp", kind: "http" }],
        channels: [{ name: "results", kind: "ring", direction: "worker-to-ui", recordBytes: 64, capacity: 2 }],
      } },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: ["net.http"] } }));
    writeFileSync(join(project, "app.tsx"), "export default function App(){ return <text value='worker build'/>; }\n");
    writeFileSync(join(project, "worker.ts"), `import { io } from "@pocketjs/framework/io";
const timer = io.timer(1000);
void timer.next();
`);

    const result = await buildGuest({ projectRoot: project, outDir: output, copyAssetsTo: assets });
    expect(result.worker).toBeDefined();
    expect(existsSync(result.worker!.source)).toBe(true);
    expect(existsSync(result.worker!.bytecode)).toBe(true);
    const workerMeta = JSON.parse(readFileSync(result.worker!.metadata, "utf8")) as Record<string, unknown>;
    expect(workerMeta.entryFormat).toBe("quickjs-bytecode");
    expect(workerMeta.kind).toBe("script");
    expect(workerMeta.bytecodeBytes).toBe(readFileSync(result.worker!.bytecode).byteLength);

    const appMeta = JSON.parse(readFileSync(result.metadata, "utf8")) as Record<string, unknown>;
    const descriptor = appMeta.worker as Record<string, unknown>;
    const bytecodeDescriptor = descriptor.bytecode as Record<string, unknown>;
    expect(descriptor.protocolVersion).toBe(1);
    expect(descriptor.kind).toBe("quickjs-bytecode");
    expect(bytecodeDescriptor.path).toBe("app.worker.qjbc");
    expect(bytecodeDescriptor.bytes).toBe(readFileSync(result.worker!.bytecode).byteLength);
    expect(bytecodeDescriptor.sha256).toBe(
      createHash("sha256").update(readFileSync(result.worker!.bytecode)).digest("hex"),
    );
    expect(descriptor.requiredCaps).toEqual(["net.http", "runtime.worker"]);
    expect(descriptor.declaration).toEqual((JSON.parse(readFileSync(join(project, "pocket.json"), "utf8")) as any).domains.worker);
    expect(existsSync(join(assets, "app.worker.qjbc"))).toBe(true);
    const outputManifest = JSON.parse(readFileSync(join(assets, "guest-manifest.json"), "utf8")) as Record<string, any>;
    expect(outputManifest.domains.worker.entry).toBe("worker.ts");
    expect(outputManifest.worker.bytecode.sha256).toBe(bytecodeDescriptor.sha256);
    expect(outputManifest.capabilities.requires).toContain("runtime.worker");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, BUILD_GUEST_TEST_TIMEOUT_MS);

test("build_guest rejects worker nodes whose capability is not required by the guest manifest", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-worker-capability-"));
  try {
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      app: { entry: "app.tsx" },
      domains: { worker: { entry: "worker.ts", nodes: [{ name: "remote", kind: "http" }] } },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), "export default function App(){ return <text value='capability check'/>; }\n");
    writeFileSync(join(project, "worker.ts"), "export {};\n");
    await expect(buildGuest({ projectRoot: project, outDir: join(project, "out") })).rejects.toThrow(/worker node requires declared capability net\.http/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, BUILD_GUEST_TEST_TIMEOUT_MS);

test("build_guest restores Bun file-symlinked @pocket/ui after a real build", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-symlink-ui-"));
  const output = join(project, "out");
  const installed = join(project, "node_modules/@pocket/ui");
  const sourcePackage = join(import.meta.dir, "../../packages/pocket_ui");
  try {
    // Bun can materialize a `file:` dependency as a real package directory
    // whose individual files point back to the SDK checkout. This is the
    // shape that must survive the temporary JSX-preparation replacement.
    linkPackageFiles(sourcePackage, installed);
    const before = packageFiles(installed);
    expect(before.length).toBeGreaterThan(1);
    for (const file of before) expect(lstatSync(join(installed, file)).isSymbolicLink()).toBe(true);

    writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "app.tsx"), `import { MobileButton } from "@pocket/ui";
import { mount } from "@pocketjs/framework/solid";

mount(() => <MobileButton label="Symlink package" onPress={() => {}} />);
`);

    const result = await buildGuest({ projectRoot: project, outDir: output });
    const metadata = JSON.parse(readFileSync(result.metadata, "utf8")) as Record<string, unknown>;
    const bytecode = readFileSync(result.bytecode);
    const pak = readFileSync(result.pak);
    expect(metadata.entryFormat).toBe("quickjs-bytecode");
    expect(metadata.bytecodeBytes).toBe(bytecode.byteLength);
    expect(bytecode.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4a, 0x42, 0x43]));
    expect(pak.byteLength).toBeGreaterThan(0);
    expect(existsSync(join(project, ".pocket-ui.lock"))).toBe(false);
    expect(readdirSync(project).filter((name) => name.startsWith(".pocket-ui-backup-")).length).toBe(0);

    // Cleanup must restore the package manager's exact file-symlink layout,
    // rather than leaving transformed source or a copied package in place.
    expect(packageFiles(installed)).toEqual(before);
    for (const file of before) expect(lstatSync(join(installed, file)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(installed, "src/mobile.tsx"), "utf8")).toContain("<");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, BUILD_GUEST_TEST_TIMEOUT_MS);

test("build_guest carries editor release identity into bytecode metadata", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-release-identity-"));
  const output = join(project, "out");
  const assets = join(project, "assets");
  try {
    writeFileSync(join(project, "app.tsx"), "export default function App(){ return <text value='release'/>; }\n");
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ version: "1.0.0", build: 1, app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "editor.json"), JSON.stringify({ version: "2.4.0", build: 42 }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ version: "1.0.0", build: 1, capabilities: { requires: [] } }));
    const result = await buildGuest({ projectRoot: project, outDir: output, copyAssetsTo: assets });
    const metadata = JSON.parse(readFileSync(result.metadata, "utf8")) as Record<string, unknown>;
    expect(metadata.version).toBe("2.4.0");
    expect(metadata.build).toBe(42);
    const generatedOutputManifest = JSON.parse(readFileSync(join(output, "guest-manifest.json"), "utf8")) as Record<string, unknown>;
    expect(generatedOutputManifest.version).toBe("2.4.0");
    expect(generatedOutputManifest.build).toBe(42);
    const generatedManifest = JSON.parse(readFileSync(join(assets, "guest-manifest.json"), "utf8")) as Record<string, unknown>;
    expect(generatedManifest.version).toBe("2.4.0");
    expect(generatedManifest.build).toBe(42);
    const sourceManifest = JSON.parse(readFileSync(join(project, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(sourceManifest.version).toBe("1.0.0");
    expect(sourceManifest.build).toBe(1);

    // An Editor update must be visible on the next build even when the older
    // project/manifest files are still present.
    writeFileSync(join(project, "editor.json"), JSON.stringify({ version: "2.4.0", build: 43 }));
    const next = await buildGuest({ projectRoot: project, outDir: output, copyAssetsTo: assets });
    const nextMetadata = JSON.parse(readFileSync(next.metadata, "utf8")) as Record<string, unknown>;
    expect(nextMetadata.version).toBe("2.4.0");
    expect(nextMetadata.build).toBe(43);
    const nextManifest = JSON.parse(readFileSync(join(assets, "guest-manifest.json"), "utf8")) as Record<string, unknown>;
    expect(nextManifest.version).toBe("2.4.0");
    expect(nextManifest.build).toBe(43);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, BUILD_GUEST_TEST_TIMEOUT_MS);

test("release identity chooses one source without mixing version and build fields", () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-release-identity-source-"));
  try {
    writeFileSync(join(project, "editor.json"), JSON.stringify({ version: "2.4.0" }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ version: "1.0.0", build: 42 }));
    const manifest = { version: "0.1.0", build: 1 };
    expect(resolveReleaseIdentity(project, manifest)).toEqual({ version: "2.4.0", build: 1 });
    rmSync(join(project, "editor.json"));
    expect(resolveReleaseIdentity(project, manifest)).toEqual({ version: "1.0.0", build: 42 });
    rmSync(join(project, "pocket.json"));
    expect(resolveReleaseIdentity(project, manifest)).toEqual(manifest);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("release identity rejects an invalid authoritative editor field instead of falling back", () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-release-identity-invalid-"));
  try {
    writeFileSync(join(project, "editor.json"), JSON.stringify({ build: 0 }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ build: 42 }));
    expect(() => resolveReleaseIdentity(project)).toThrow(/positive safe integer/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("projectConfig and build_guest emit the same complete identity for partial and absent release config", async () => {
  const cases = [
    {
      name: "partial-editor",
      editor: { version: "2.4.0" },
      pocket: { version: "1.0.0", build: 42 },
      expected: { version: "2.4.0", build: 1 },
    },
    {
      name: "no-release-source",
      editor: undefined,
      pocket: {},
      expected: { version: "0.1.0", build: 1 },
    },
  ] as const;

  for (const fixture of cases) {
    const project = mkdtempSync(join(tmpdir(), `pocket-release-artifact-${fixture.name}-`));
    const output = join(project, "build");
    try {
      writeFileSync(join(project, "app.tsx"), "export default function App(){ return <text value='identity'/>; }\n");
      writeFileSync(join(project, "pocket.json"), JSON.stringify({ id: "fixture-app", ...fixture.pocket, app: { entry: "app.tsx" } }));
      writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
      writeFileSync(join(project, "editor.json"), JSON.stringify(fixture.editor ?? {}));

      const result = await buildProject(project, { outDir: output });
      const buildInfo = JSON.parse(readFileSync(join(output, "build.json"), "utf8")) as Record<string, unknown>;
      const metadata = JSON.parse(readFileSync(result.metadata, "utf8")) as Record<string, unknown>;
      expect({ version: buildInfo.version, build: buildInfo.build }).toEqual(fixture.expected);
      expect({ version: metadata.version, build: metadata.build }).toEqual(fixture.expected);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
}, BUILD_GUEST_TEST_TIMEOUT_MS);

test("build_guest rejects an invalid explicit release build instead of falling back", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-invalid-release-"));
  const output = join(project, "out");
  try {
    writeFileSync(join(project, "app.tsx"), "export default function App(){ return <text value='invalid'/>; }\n");
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ version: "2.4.0", build: 42, app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "editor.json"), JSON.stringify({ version: "2.4.0", build: 0 }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ version: "1.0.0", build: 1, capabilities: { requires: [] } }));
    await expect(buildGuest({ projectRoot: project, outDir: output })).rejects.toThrow(/release build must be a positive safe integer/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, BUILD_GUEST_TEST_TIMEOUT_MS);
