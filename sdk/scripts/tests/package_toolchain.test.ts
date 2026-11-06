import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { packageToolchain, readBytecodeAbi } from "../package_toolchain.ts";

function fixture(withNoble = true): string {
  const root = mkdtempSync(join(tmpdir(), "pocket-toolchain-package-test-"));
  const upstream = join(root, ".cache", "pocketjs");
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, ".pocketjs-revision"), "99924de47c62fa36f526a8791055d91cbbdb3836\n");
  for (const directory of ["framework", "contracts", "tools", "microts", "profiles", "assets"]) {
    mkdirSync(join(upstream, directory), { recursive: true });
    writeFileSync(join(upstream, directory, "entry.ts"), `export const ${directory.replace(/[^a-z]/g, "_")} = true;\n`);
  }
  writeFileSync(join(upstream, "pocket.json"), "{}\n");
  writeFileSync(join(upstream, "tsconfig.json"), "{}\n");
  writeFileSync(join(upstream, "LICENSE"), "license\n");
  writeFileSync(join(upstream, "package.json"), JSON.stringify({ name: "@pocketjs/framework", version: "0.15.0", dependencies: { typescript: "5.9.3" } }));
  mkdirSync(join(root, "native"), { recursive: true });
  writeFileSync(join(root, "native", "Cargo.toml"), "[package]\nname='fixture'\n");
  const release = join(root, "native", "target", "release");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "pocket_probe"), "probe\n");
  writeFileSync(join(release, "pocketjs_bytecode"), "bytecode\n");
  chmodSync(join(release, "pocket_probe"), 0o755);
  chmodSync(join(release, "pocketjs_bytecode"), 0o755);
  mkdirSync(join(root, ".pocket-build"), { recursive: true });
  writeFileSync(join(root, ".pocket-build", "app.bytecode.json"), JSON.stringify({ runtimeAbi: "quickjs-bytecode-v1:test-abi" }));
  mkdirSync(join(root, ".pocket-build", "web-engine"), { recursive: true });
  writeFileSync(join(root, ".pocket-build", "web-engine", "pocketjs.wasm"), "wasm\n");
  writeFileSync(join(root, ".pocket-build", "web-engine", "pocket-web.js"), "export {};\n");
  if (withNoble) {
    mkdirSync(join(root, "node_modules", "@abandonware", "noble", "build", "Release"), { recursive: true });
    writeFileSync(join(root, "node_modules", "@abandonware", "noble", "build", "Release", "binding.node"), "napi4-binding\n");
  }
  return root;
}

test("packages compiler sources and records payload hashes", () => {
  const root = fixture();
  const output = join(root, ".pocket-build", "out");
  try {
    packageToolchain({ sdkRoot: root, out: output, force: false, version: "0.1.1" }, { readAbi: () => "quickjs-bytecode-v1:test-abi" });
    expect(existsSync(join(output, "bin/pocketjs_bytecode"))).toBe(true);
    expect(existsSync(join(output, "compiler/framework/entry.ts"))).toBe(true);
    expect(existsSync(join(output, "engine/pocketjs.wasm"))).toBe(true);
    expect(existsSync(join(output, "web/pocket-web.js"))).toBe(true);
    expect(existsSync(join(output, "noble/prebuilds", `${process.platform}-${process.arch}`, "node.napi.node"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    expect(manifest.bytecodeAbi).toBe("quickjs-bytecode-v1:test-abi");
    expect(manifest.webEngine.included).toBe(true);
    expect(manifest.noble.included).toBe(true);
    expect(manifest.hci.included).toBe(false);
    const payload = readFileSync(join(output, "bin/pocketjs_bytecode"));
    expect(manifest.files["bin/pocketjs_bytecode"].size).toBe(payload.byteLength);
    expect(manifest.files["bin/pocketjs_bytecode"].sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    const packageJson = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
    expect(packageJson.name).toBe(`@pocket/tools-${process.platform}-${process.arch}`);
    expect(packageJson.dependencies.typescript).toBe("5.9.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails before creating an output package when a native binary is absent", () => {
  const root = fixture(false);
  const output = join(root, ".pocket-build", "out");
  rmSync(join(root, "native", "target", "release", "pocket_probe"));
  try {
    expect(() => packageToolchain({ sdkRoot: root, out: output, force: false, version: "0.1.1" }, { readAbi: () => "quickjs-bytecode-v1:test-abi" })).toThrow("missing release binary");
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the package usable when optional Noble binding is unavailable", () => {
  const root = fixture(false);
  const output = join(root, ".pocket-build", "out");
  try {
    packageToolchain({ sdkRoot: root, out: output, force: false, version: "0.1.1" }, { readAbi: () => "quickjs-bytecode-v1:test-abi" });
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    expect(manifest.noble.included).toBe(false);
    expect(manifest.hci.included).toBe(false);
    expect(existsSync(join(output, "noble"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads ABI by executing the supplied bytecode binary", () => {
  const root = fixture();
  try {
    const abi = readBytecodeAbi(root, (_binary, args) => {
      const metadata = args[args.indexOf("--metadata") + 1]!;
      writeFileSync(metadata, JSON.stringify({ runtimeAbi: "quickjs-bytecode-v1:executed" }));
      return { status: 0 };
    });
    expect(abi).toBe("quickjs-bytecode-v1:executed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
