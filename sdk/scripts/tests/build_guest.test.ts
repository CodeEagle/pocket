import { expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "../build_guest.ts";

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
});

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
});

test("build_guest carries editor release identity into bytecode metadata", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-release-identity-"));
  const output = join(project, "out");
  writeFileSync(join(project, "app.tsx"), "export default function App(){ return <text value='release'/>; }\n");
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ version: "2.4.0", app: { entry: "app.tsx" } }));
  writeFileSync(join(project, "editor.json"), JSON.stringify({ version: "2.4.0", build: 42 }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  const result = await buildGuest({ projectRoot: project, outDir: output });
  const metadata = JSON.parse(readFileSync(result.metadata, "utf8")) as Record<string, unknown>;
  expect(metadata.version).toBe("2.4.0");
  expect(metadata.build).toBe(42);
});

test("build_guest rejects an invalid explicit release build instead of falling back", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-invalid-release-"));
  const output = join(project, "out");
  writeFileSync(join(project, "app.tsx"), "export default function App(){ return <text value='invalid'/>; }\n");
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ version: "2.4.0", app: { entry: "app.tsx" } }));
  writeFileSync(join(project, "editor.json"), JSON.stringify({ version: "2.4.0", build: 42 }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ version: "2.4.0", build: 0, capabilities: { requires: [] } }));
  await expect(buildGuest({ projectRoot: project, outDir: output })).rejects.toThrow(/release build must be a positive safe integer/);
});
