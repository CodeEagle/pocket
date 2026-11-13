import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import {
  BYTECODE_ABI,
  UPSTREAM_REVISION,
  resolveManagedBun,
} from "../../scripts/prebuilt_tools.mjs";
import {
  acquireUpgradeApplyLock,
  applyStagedSdkFiles,
  compareStableSemver,
  computeSha256Hex,
  createStudioUpgradeManager,
  expectedSdkArchiveAssetNames,
  extractSafeTarGz,
  isSdkBackupComplete,
  parseStableSemver,
  prepareSdkUpgradeBackup,
  readInstalledSdkInfo,
  readPersistedUpgradeStatus,
  recoverInterruptedSdkUpgrade,
  restoreBackedUpSdkFiles,
  selectLatestStableRelease,
  validateReleaseOriginUrl,
  validateStagedStandaloneSdk,
  withBoundedFsRetries,
  writePersistedUpgradeStatus,
} from "../../scripts/studio_upgrade.mjs";
import { editorToolEnvironment, upgradeApply } from "../../scripts/editor_service.mjs";
// In a source checkout before `package_toolchain` is run for the new SDK_VERSION,
// point Studio's upstream import at the prepared `.cache/pocketjs` tree if needed.
if (!process.env.POCKET_UPSTREAM_ROOT && !process.env.POCKET_SOURCE_BUILD) {
  const cachedUpstream = resolve(import.meta.dir, "../../.cache/pocketjs");
  if (existsSync(join(cachedUpstream, "tools", "companion", "codex.ts"))) {
    process.env.POCKET_UPSTREAM_ROOT = cachedUpstream;
  }
}
const { startEditor } = await import("../server.ts");

const PLATFORM = process.platform;
const ARCH = process.arch;
const TUPLE = `${PLATFORM}-${ARCH}`;
const SDK_BUN = resolveManagedBun(resolve(import.meta.dir, "../.."));

function encodeTarOctal(value: number, length: number): string {
  const octal = Math.max(0, Math.trunc(value)).toString(8);
  return `${octal.padStart(length - 1, "0")}\0`;
}

function createTarGzFromDirectory(sourceDirectory: string, topLevelPrefix = "package"): Buffer {
  const root = resolve(sourceDirectory);
  const blocks: Buffer[] = [];
  const walk = (currentDir: string): void => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const rel = relative(root, fullPath).replaceAll("\\", "/");
      const archivePath = topLevelPrefix ? `${topLevelPrefix}/${rel}` : rel;
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(fullPath);
      const stat = statSync(fullPath);
      const header = Buffer.alloc(512, 0);
      let nameField = archivePath;
      let prefixField = "";
      if (Buffer.byteLength(archivePath, "utf8") > 100) {
        const splitIdx = archivePath.lastIndexOf("/");
        if (splitIdx <= 0) throw new Error(`归档路径过长：${archivePath}`);
        prefixField = archivePath.slice(0, splitIdx);
        nameField = archivePath.slice(splitIdx + 1);
      }
      header.write(nameField, 0, 100, "utf8");
      header.write(encodeTarOctal((stat.mode & 0o111) ? 0o755 : 0o644, 8), 100, 8, "utf8");
      header.write(encodeTarOctal(0, 8), 108, 8, "utf8");
      header.write(encodeTarOctal(0, 8), 116, 8, "utf8");
      header.write(encodeTarOctal(bytes.byteLength, 12), 124, 12, "utf8");
      header.write(encodeTarOctal(Math.floor(stat.mtimeMs / 1000), 12), 136, 12, "utf8");
      header.fill(0x20, 148, 156);
      header[156] = "0".charCodeAt(0);
      header.write("ustar\0", 257, 6, "utf8");
      header.write("00", 263, 2, "utf8");
      if (prefixField) header.write(prefixField, 345, 155, "utf8");
      let sum = 0;
      for (let i = 0; i < 512; i += 1) sum += header[i]!;
      header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
      blocks.push(header);
      blocks.push(bytes);
      const remainder = bytes.byteLength % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder, 0));
    }
  };
  walk(root);
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function buildRawTarEntry(name: string, payload: Buffer, typeFlag = "0", linkName = ""): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(100, Buffer.byteLength(name)), "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${payload.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, 12, "utf8");
  header.fill(0x20, 148, 156);
  header[156] = typeFlag.charCodeAt(0);
  if (linkName) header.write(linkName, 157, Math.min(100, Buffer.byteLength(linkName)), "utf8");
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i]!;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  const pad = payload.byteLength % 512 === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - (payload.byteLength % 512), 0);
  return Buffer.concat([header, payload, pad]);
}

function buildMaliciousTarGz(entryName: string, payloadText = "pwn", typeFlag = "0", linkName = ""): Buffer {
  const entry = buildRawTarEntry(entryName, Buffer.from(payloadText, "utf8"), typeFlag, linkName);
  return gzipSync(Buffer.concat([entry, Buffer.alloc(1024, 0)]));
}

function createSyntheticToolsDirectory(
  targetDir: string,
  version: string,
  platform = PLATFORM,
  arch = ARCH,
  options: { upstreamRevision?: string; bytecodeAbi?: string } = {},
): void {
  const suffix = platform === "win32" ? ".exe" : "";
  const upstreamRevision = options.upstreamRevision ?? UPSTREAM_REVISION;
  const bytecodeAbi = options.bytecodeAbi ?? BYTECODE_ABI;
  const manifest: {
    schemaVersion: number;
    sdkVersion: string;
    upstreamRevision: string;
    bytecodeAbi: string;
    platform: string;
    arch: string;
    files: Record<string, { size: number; sha256: string }>;
  } = {
    schemaVersion: 1,
    sdkVersion: version,
    upstreamRevision,
    bytecodeAbi,
    platform,
    arch,
    files: {},
  };
  const files = [
    `bin/pocketjs_bytecode${suffix}`,
    `bin/pocket_probe${suffix}`,
    "compiler/tools/build.ts",
    "compiler/framework/compiler/jsx-plugin.ts",
    "compiler/framework/compiler/subpaths.ts",
    "compiler/framework/src/inline-fonts.ts",
    "compiler/tools/inline-text-slots.ts",
  ];
  for (const rel of files) {
    const content = Buffer.from(`synthetic-${version}-${rel}\n`, "utf8");
    const dest = join(targetDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    manifest.files[rel] = {
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }
  writeFileSync(join(targetDir, "package.json"), JSON.stringify({
    name: `@pocket/tools-${platform}-${arch}`,
    version,
  }, null, 2));
  writeFileSync(join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function createStandaloneSdkTree(
  sdkRoot: string,
  version: string,
  options: {
    brokenToolsAbi?: boolean;
    upstreamRevision?: string;
    bytecodeAbi?: string;
    extraPackageFiles?: Record<string, string | Buffer>;
  } = {},
): {
  archiveBytes: Buffer;
  archiveSha256: string;
  archiveName: string;
  checksumName: string;
} {
  mkdirSync(sdkRoot, { recursive: true });
  writeFileSync(join(sdkRoot, ".pocket-studio-test-fixture"), "isolated-upgrade-lifecycle-test\n");
  const expected = expectedSdkArchiveAssetNames(version, PLATFORM, ARCH);
  const upstreamRevision = options.upstreamRevision ?? UPSTREAM_REVISION;
  const bytecodeAbi = options.bytecodeAbi ?? BYTECODE_ABI;

  const toolsStaging = mkdtempSync(join(tmpdir(), `pocket-synth-tools-${version}-`));
  try {
    createSyntheticToolsDirectory(toolsStaging, version, PLATFORM, ARCH, { upstreamRevision, bytecodeAbi });
    if (options.brokenToolsAbi) {
      const mPath = join(toolsStaging, "manifest.json");
      const m = JSON.parse(readFileSync(mPath, "utf8"));
      m.bytecodeAbi = "quickjs-bytecode-v1:corrupted-abi";
      writeFileSync(mPath, JSON.stringify(m, null, 2));
    }
    const toolsTgz = createTarGzFromDirectory(toolsStaging, "package");
    mkdirSync(join(sdkRoot, "prebuilt"), { recursive: true });
    writeFileSync(join(sdkRoot, "prebuilt", expected.toolsArchiveName), toolsTgz);

    const installedToolsDir = join(sdkRoot, "node_modules", "@pocket", `tools-${TUPLE}`);
    if (!options.brokenToolsAbi) {
      createSyntheticToolsDirectory(installedToolsDir, version, PLATFORM, ARCH, { upstreamRevision, bytecodeAbi });
    }
  } finally {
    rmSync(toolsStaging, { recursive: true, force: true });
  }

  writeFileSync(join(sdkRoot, "package.json"), `${JSON.stringify({
    name: `@pocket/web-sdk-tools-${TUPLE}`,
    version,
    private: false,
    type: "module",
  }, null, 2)}\n`);
  writeFileSync(join(sdkRoot, "provenance.json"), `${JSON.stringify({
    sourceRepository: "CodeEagle/pocket",
    sourceCommit: "a66b5a3",
    pinnedPocketJsRevision: upstreamRevision,
    runtime: "QuickJS QJBC + PAK + PocketJS WebAssembly + Canvas2D",
  }, null, 2)}\n`);
  mkdirSync(join(sdkRoot, "editor"), { recursive: true });
  writeFileSync(join(sdkRoot, "editor", "server.ts"), `// server ${version}\nexport const VERSION = "${version}";\n`);
  mkdirSync(join(sdkRoot, "scripts"), { recursive: true });
  writeFileSync(join(sdkRoot, "scripts", "editor_service.mjs"), `// service ${version}\n`);
  writeFileSync(
    join(sdkRoot, "scripts", "prebuilt_tools.mjs"),
    `export const SDK_VERSION = '${version}';\nexport const UPSTREAM_REVISION = '${upstreamRevision}';\nexport const BYTECODE_ABI = '${bytecodeAbi}';\n`,
  );
  mkdirSync(join(sdkRoot, "packages", "pocket_ui"), { recursive: true });
  writeFileSync(join(sdkRoot, "packages", "pocket_ui", "index.ts"), `export const UI_VERSION = "${version}";\n`);
  if (options.extraPackageFiles) {
    for (const [relPath, content] of Object.entries(options.extraPackageFiles)) {
      const full = join(sdkRoot, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  writeFileSync(join(sdkRoot, "README.md"), `# Pocket Web SDK (${TUPLE}) v${version}\n`);
  writeFileSync(join(sdkRoot, "LICENSE"), "MIT\n");

  const packStaging = mkdtempSync(join(tmpdir(), `pocket-synth-pack-${version}-`));
  try {
    const cleanPackRoot = join(packStaging, "clean");
    mkdirSync(cleanPackRoot, { recursive: true });
    for (const rel of ["package.json", "provenance.json", "README.md", "LICENSE"]) {
      writeFileSync(join(cleanPackRoot, rel), readFileSync(join(sdkRoot, rel)));
    }
    mkdirSync(join(cleanPackRoot, "editor"), { recursive: true });
    writeFileSync(join(cleanPackRoot, "editor", "server.ts"), readFileSync(join(sdkRoot, "editor", "server.ts")));
    mkdirSync(join(cleanPackRoot, "scripts"), { recursive: true });
    writeFileSync(join(cleanPackRoot, "scripts", "editor_service.mjs"), readFileSync(join(sdkRoot, "scripts", "editor_service.mjs")));
    writeFileSync(join(cleanPackRoot, "scripts", "prebuilt_tools.mjs"), readFileSync(join(sdkRoot, "scripts", "prebuilt_tools.mjs")));
    mkdirSync(join(cleanPackRoot, "packages", "pocket_ui"), { recursive: true });
    writeFileSync(join(cleanPackRoot, "packages", "pocket_ui", "index.ts"), readFileSync(join(sdkRoot, "packages", "pocket_ui", "index.ts")));
    if (options.extraPackageFiles) {
      for (const [relPath, content] of Object.entries(options.extraPackageFiles)) {
        const dst = join(cleanPackRoot, relPath);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, content);
      }
    }
    mkdirSync(join(cleanPackRoot, "prebuilt"), { recursive: true });
    writeFileSync(
      join(cleanPackRoot, "prebuilt", expected.toolsArchiveName),
      readFileSync(join(sdkRoot, "prebuilt", expected.toolsArchiveName)),
    );
    const archiveBytes = createTarGzFromDirectory(cleanPackRoot, "package");
    const archiveSha256 = computeSha256Hex(archiveBytes);
    return {
      archiveBytes,
      archiveSha256,
      archiveName: expected.archiveName,
      checksumName: expected.checksumName,
    };
  } finally {
    rmSync(packStaging, { recursive: true, force: true });
  }
}

describe("Studio built-in self-upgrade unit & security gates", () => {
  test("parses only stable semantic versions and rejects prereleases or malformed tags", () => {
    expect(parseStableSemver("0.1.10")).toEqual({ major: 0, minor: 1, patch: 10, version: "0.1.10" });
    expect(parseStableSemver("sdk-v0.1.11")).toEqual({ major: 0, minor: 1, patch: 11, version: "0.1.11" });
    expect(parseStableSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, version: "1.2.3" });
    expect(parseStableSemver("sdk-v0.1.11-rc.1")).toBeNull();
    expect(parseStableSemver("0.1.11-test.2")).toBeNull();
    expect(parseStableSemver("invalid")).toBeNull();
    expect(compareStableSemver("0.1.11", "0.1.10")).toBe(1);
    expect(compareStableSemver("0.1.10", "0.1.10")).toBe(0);
    expect(compareStableSemver("0.1.9", "0.1.10")).toBe(-1);
  });

  test("enforces HTTPS GitHub release provenance and rejects untrusted origins or embedded credentials", () => {
    expect(validateReleaseOriginUrl("https://api.github.com/repos/CodeEagle/pocket/releases").hostname).toBe("api.github.com");
    expect(validateReleaseOriginUrl("https://github.com/CodeEagle/pocket/releases/download/sdk-v0.1.11/a.tgz").hostname).toBe("github.com");
    expect(validateReleaseOriginUrl("https://objects.githubusercontent.com/github-production-release-asset/123").hostname).toBe("objects.githubusercontent.com");
    expect(() => validateReleaseOriginUrl("http://api.github.com/repos/CodeEagle/pocket/releases")).toThrow(/HTTPS/);
    expect(() => validateReleaseOriginUrl("https://evil.example.com/pocket.tgz")).toThrow(/不受信任的发布主机/);
    expect(() => validateReleaseOriginUrl("https://user:pass@api.github.com/repos/CodeEagle/pocket/releases")).toThrow(/凭据/);
    expect(() => validateReleaseOriginUrl("http://127.0.0.1:9999/releases", { allowLoopbackHttp: false })).toThrow(/HTTPS/);
    expect(validateReleaseOriginUrl("http://127.0.0.1:9999/releases", { allowLoopbackHttp: true }).hostname).toBe("127.0.0.1");
  });

  test("selects highest stable release matching platform and ignores drafts/prereleases", () => {
    const payload = [
      {
        tag_name: "sdk-v0.2.0-beta.1",
        draft: false,
        prerelease: true,
        assets: [],
      },
      {
        tag_name: "sdk-v0.1.12",
        draft: true,
        prerelease: false,
        assets: [],
      },
      {
        tag_name: "sdk-v0.1.11",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/CodeEagle/pocket/releases/tag/sdk-v0.1.11",
        assets: [
          {
            name: `pocket-web-sdk-tools-${TUPLE}-0.1.11.tgz`,
            browser_download_url: `https://github.com/CodeEagle/pocket/releases/download/sdk-v0.1.11/pocket-web-sdk-tools-${TUPLE}-0.1.11.tgz`,
          },
          {
            name: `pocket-web-sdk-tools-${TUPLE}-0.1.11.tgz.sha256`,
            browser_download_url: `https://github.com/CodeEagle/pocket/releases/download/sdk-v0.1.11/pocket-web-sdk-tools-${TUPLE}-0.1.11.tgz.sha256`,
          },
        ],
      },
      {
        tag_name: "sdk-v0.1.10",
        draft: false,
        prerelease: false,
        assets: [],
      },
    ];
    const selected = selectLatestStableRelease(payload, PLATFORM, ARCH);
    expect(selected).not.toBeNull();
    expect(selected?.version).toBe("0.1.11");
    expect(selected?.hasMatchingPlatformAsset).toBe(true);
  });

  test("rejects unsafe tar archives (path traversal, absolute paths, symlinks, non-package prefix)", () => {
    const out = mkdtempSync(join(tmpdir(), "pocket-unsafe-tar-test-"));
    try {
      expect(() => extractSafeTarGz(buildMaliciousTarGz("package/../../evil.txt"), out)).toThrow(/路径穿越/);
      expect(() => extractSafeTarGz(buildMaliciousTarGz("/etc/passwd"), out)).toThrow(/绝对路径/);
      expect(() => extractSafeTarGz(buildMaliciousTarGz("C:/Windows/win.ini"), out)).toThrow(/绝对路径|盘符/);
      expect(() => extractSafeTarGz(buildMaliciousTarGz("package\\evil.txt"), out)).toThrow(/反斜杠/);
      expect(() => extractSafeTarGz(buildMaliciousTarGz("outside/file.txt"), out)).toThrow(/顶层 package/);
      expect(() => extractSafeTarGz(buildMaliciousTarGz("package/link", "", "2", "/etc/passwd"), out)).toThrow(/链接或特殊设备/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("distinguishes source Git checkout mode from standalone SDK install and never auto-overwrites source checkout", async () => {
    const repoSdkRoot = resolve(import.meta.dir, "../..");
    const sourceInfo = readInstalledSdkInfo(repoSdkRoot);
    expect(sourceInfo.mode).toBe("source");
    expect(sourceInfo.autoUpgradeSupported).toBe(false);

    let archiveFetched = false;
    const manager = createStudioUpgradeManager({
      sdkRoot: repoSdkRoot,
      allowLoopbackHttp: true,
      releasesUrl: "http://127.0.0.1:65530/releases",
      fetchImpl: async (url: string) => {
        if (url.endsWith("/releases")) {
          return new Response(JSON.stringify([
            {
              tag_name: "sdk-v9.9.9",
              draft: false,
              prerelease: false,
              html_url: "https://github.com/CodeEagle/pocket/releases/tag/sdk-v9.9.9",
              assets: [
                {
                  name: `pocket-web-sdk-tools-${TUPLE}-9.9.9.tgz`,
                  browser_download_url: `http://127.0.0.1:65530/pocket-web-sdk-tools-${TUPLE}-9.9.9.tgz`,
                },
                {
                  name: `pocket-web-sdk-tools-${TUPLE}-9.9.9.tgz.sha256`,
                  browser_download_url: `http://127.0.0.1:65530/pocket-web-sdk-tools-${TUPLE}-9.9.9.tgz.sha256`,
                },
              ],
            },
          ]));
        }
        archiveFetched = true;
        return new Response("should not download in source mode", { status: 500 });
      },
    });

    const checkResult = await manager.check({ autoApply: true });
    expect(checkResult.mode).toBe("source");
    expect(checkResult.upgradeAvailable).toBe(true);
    expect(checkResult.latestVersion).toBe("9.9.9");
    expect(checkResult.status).toBe("available");
    expect(archiveFetched).toBe(false);
    await expect(manager.apply()).rejects.toThrow(/源码检出模式/);
  });

  test("validates staged SDK internal consistency and allows future compiler revision / bytecode ABI upgrades", () => {
    const futureRevision = "1111111111222222222233333333334444444444";
    const futureAbi = `quickjs-bytecode-v1:${"a".repeat(64)}`;
    const futureSrc = mkdtempSync(join(tmpdir(), "pocket-future-abi-src-"));
    const stageFuture = mkdtempSync(join(tmpdir(), "pocket-future-abi-stage-"));
    const mismatchSrc = mkdtempSync(join(tmpdir(), "pocket-mismatch-abi-src-"));
    const stageMismatch = mkdtempSync(join(tmpdir(), "pocket-mismatch-abi-stage-"));
    try {
      const futureArchive = createStandaloneSdkTree(futureSrc, "0.2.0", {
        upstreamRevision: futureRevision,
        bytecodeAbi: futureAbi,
      });
      extractSafeTarGz(futureArchive.archiveBytes, stageFuture, { stripTopLevelPackage: true });
      const validated = validateStagedStandaloneSdk(stageFuture, "0.2.0", PLATFORM, ARCH);
      expect(validated.version).toBe("0.2.0");

      const mismatchArchive = createStandaloneSdkTree(mismatchSrc, "0.2.0", {
        upstreamRevision: futureRevision,
        bytecodeAbi: futureAbi,
        brokenToolsAbi: true,
      });
      extractSafeTarGz(mismatchArchive.archiveBytes, stageMismatch, { stripTopLevelPackage: true });
      expect(() => validateStagedStandaloneSdk(stageMismatch, "0.2.0", PLATFORM, ARCH)).toThrow(/版本\/ABI 不匹配/);
    } finally {
      for (const dir of [futureSrc, stageFuture, mismatchSrc, stageMismatch]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("coalesces concurrent upgrade checks, enforces cross-process apply lock, and handles wrong-checksum / oversize archives cleanly", { timeout: 30_000 }, async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pocket-standalone-check-"));
    try {
      const v10 = createStandaloneSdkTree(tempRoot, "0.1.10");
      const v11Staging = mkdtempSync(join(tmpdir(), "pocket-standalone-v11-"));
      const v11 = createStandaloneSdkTree(v11Staging, "0.1.11");
      rmSync(v11Staging, { recursive: true, force: true });

      expect(readInstalledSdkInfo(tempRoot).mode).toBe("standalone");

      // Cross-process apply lock prevents overlapping apply calls
      const releaseExternalLock = acquireUpgradeApplyLock(tempRoot, { phase: "applying", targetVersion: "0.1.11" });
      expect(() => acquireUpgradeApplyLock(tempRoot, { phase: "spawning", targetVersion: "0.1.11" })).toThrow(/已有另一个升级进程正在执行/);
      releaseExternalLock();

      let releaseApiCalls = 0;
      let servedVersion = "0.1.10";
      let servedChecksum = `${v10.archiveSha256}  ${v10.archiveName}\n`;
      let servedArchive = v10.archiveBytes;

      const manager = createStudioUpgradeManager({
        sdkRoot: tempRoot,
        allowLoopbackHttp: true,
        releasesUrl: "http://127.0.0.1:65531/releases",
        fetchImpl: async (url: string) => {
          if (url.endsWith("/releases")) {
            releaseApiCalls += 1;
            await new Promise((r) => setTimeout(r, 40));
            const name = `pocket-web-sdk-tools-${TUPLE}-${servedVersion}.tgz`;
            return new Response(JSON.stringify([
              {
                tag_name: `sdk-v${servedVersion}`,
                draft: false,
                prerelease: false,
                html_url: `https://github.com/CodeEagle/pocket/releases/tag/sdk-v${servedVersion}`,
                assets: [
                  { name, browser_download_url: `http://127.0.0.1:65531/${name}` },
                  { name: `${name}.sha256`, browser_download_url: `http://127.0.0.1:65531/${name}.sha256` },
                ],
              },
            ]));
          }
          if (url.endsWith(".sha256")) return new Response(servedChecksum);
          return new Response(servedArchive);
        },
        triggerServiceUpgrade: async () => {},
      });

      const [first, second] = await Promise.all([
        manager.check({ autoApply: true }),
        manager.check({ autoApply: true }),
      ]);
      expect(releaseApiCalls).toBe(1);
      expect(first.status).toBe("up-to-date");
      expect(second.status).toBe("up-to-date");
      expect(first.upgradeAvailable).toBe(false);

      servedVersion = "0.1.11";
      servedChecksum = `${"0".repeat(64)}  ${v11.archiveName}\n`;
      servedArchive = v11.archiveBytes;
      const badChecksumResult = await manager.check({ autoApply: true });
      expect(badChecksumResult.status).toBe("error");
      expect(badChecksumResult.error).toContain("SHA-256 校验失败");
      expect(JSON.parse(readFileSync(join(tempRoot, "package.json"), "utf8")).version).toBe("0.1.10");

      const smallLimitManager = createStudioUpgradeManager({
        sdkRoot: tempRoot,
        allowLoopbackHttp: true,
        releasesUrl: "http://127.0.0.1:65531/releases",
        maxArchiveBytes: 64,
        fetchImpl: async (url: string) => {
          if (url.endsWith("/releases")) {
            const name = v11.archiveName;
            return new Response(JSON.stringify([
              {
                tag_name: "sdk-v0.1.11",
                draft: false,
                prerelease: false,
                assets: [
                  { name, browser_download_url: `http://127.0.0.1:65531/${name}` },
                  { name: `${name}.sha256`, browser_download_url: `http://127.0.0.1:65531/${name}.sha256` },
                ],
              },
            ]));
          }
          if (url.endsWith(".sha256")) return new Response(`${v11.archiveSha256}  ${v11.archiveName}\n`);
          return new Response(v11.archiveBytes);
        },
      });
      const oversizeResult = await smallLimitManager.check({ autoApply: true });
      expect(oversizeResult.status).toBe("error");
      expect(oversizeResult.error).toContain("超过大小上限");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("preserves consumer files nested inside managed directories, refuses incomplete backup rollback, and recovers interrupted upgrades on startup", { timeout: 30_000 }, () => {
    const installRoot = mkdtempSync(join(tmpdir(), "pocket-standalone-preserve-"));
    const stageGood = mkdtempSync(join(tmpdir(), "pocket-stage-good-"));
    const backupDir = join(installRoot, ".pocket-build", "sdk-upgrade-backup-0.1.10");
    try {
      createStandaloneSdkTree(installRoot, "0.1.10", {
        extraPackageFiles: {
          "packages/pocket_ui/legacy_only.ts": "export const LEGACY = true;\n",
        },
      });
      // Seed initial SDK manifest so obsolete SDK files are tracked while custom consumer files remain distinct
      mkdirSync(join(installRoot, ".pocket-build"), { recursive: true });
      writeFileSync(
        join(installRoot, ".pocket-build", ".pocket-sdk-manifest.json"),
        JSON.stringify({
          files: [
            "package.json",
            "provenance.json",
            "README.md",
            "LICENSE",
            "editor/server.ts",
            "scripts/editor_service.mjs",
            "scripts/prebuilt_tools.mjs",
            "packages/pocket_ui/index.ts",
            "packages/pocket_ui/legacy_only.ts",
            `prebuilt/pocket-tools-${TUPLE}-0.1.10.tgz`,
          ],
        }, null, 2),
      );

      // Populate custom consumer files both at root/workspace AND nested inside managed directories (packages/, docs/, etc.)
      const nestedCustomPackageFile = join(installRoot, "packages", "my-custom-package", "custom.ts");
      const nestedCustomUiPluginFile = join(installRoot, "packages", "pocket_ui", "consumer-extension.ts");
      const customProjectFile = join(installRoot, ".pocket-build", "editor-workspace-8791", "projects", "my-game", "app.tsx");
      const customDiagFile = join(installRoot, ".pocket-build", "editor-workspace-8791", "diagnostics", "crash.json");
      const customConsumerRootFile = join(installRoot, "consumer-custom.config.json");
      const customNodeModuleFile = join(installRoot, "node_modules", "find-process", "index.js");

      mkdirSync(dirname(nestedCustomPackageFile), { recursive: true });
      mkdirSync(dirname(nestedCustomUiPluginFile), { recursive: true });
      mkdirSync(dirname(customProjectFile), { recursive: true });
      mkdirSync(dirname(customDiagFile), { recursive: true });
      mkdirSync(dirname(customNodeModuleFile), { recursive: true });

      writeFileSync(nestedCustomPackageFile, 'export const customPkg = "preserved-in-packages";\n');
      writeFileSync(nestedCustomUiPluginFile, 'export const customExt = "preserved-in-pocket-ui";\n');
      writeFileSync(customProjectFile, 'export const game = "preserved-consumer-code";\n');
      writeFileSync(customDiagFile, '{"logs":["preserved-diagnostic"]}\n');
      writeFileSync(customConsumerRootFile, '{"customConsumerSetting":true}\n');
      writeFileSync(customNodeModuleFile, "module.exports = {};\n");

      // Incomplete backup (without backup-complete.json) must refuse destructive restore
      const incompleteBackupDir = join(installRoot, ".pocket-build", "incomplete-backup");
      mkdirSync(join(incompleteBackupDir, "sdk"), { recursive: true });
      expect(isSdkBackupComplete(incompleteBackupDir)).toBe(false);
      expect(() => restoreBackedUpSdkFiles(installRoot, incompleteBackupDir, PLATFORM, ARCH)).toThrow(/备份未完成/);
      expect(existsSync(join(installRoot, "editor", "server.ts"))).toBe(true);
      rmSync(incompleteBackupDir, { recursive: true, force: true });

      // Prepare valid 0.1.11 stage with a new file and without legacy_only.ts
      const v11Build = mkdtempSync(join(tmpdir(), "pocket-v11-src-"));
      const v11Archive = createStandaloneSdkTree(v11Build, "0.1.11", {
        extraPackageFiles: {
          "packages/pocket_ui/new_v11_feature.ts": "export const V11_FEATURE = true;\n",
        },
      });
      rmSync(v11Build, { recursive: true, force: true });

      extractSafeTarGz(v11Archive.archiveBytes, stageGood, { stripTopLevelPackage: true });
      validateStagedStandaloneSdk(stageGood, "0.1.11", PLATFORM, ARCH);

      prepareSdkUpgradeBackup(installRoot, stageGood, backupDir, PLATFORM, ARCH);
      expect(isSdkBackupComplete(backupDir)).toBe(true);
      applyStagedSdkFiles(installRoot, stageGood, backupDir, PLATFORM, ARCH);

      // Verify upgrade applied to 0.1.11, obsolete SDK file removed, new SDK file added, AND all nested consumer files preserved
      expect(JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")).version).toBe("0.1.11");
      expect(readFileSync(join(installRoot, "packages", "pocket_ui", "index.ts"), "utf8")).toContain("0.1.11");
      expect(existsSync(join(installRoot, "packages", "pocket_ui", "new_v11_feature.ts"))).toBe(true);
      expect(existsSync(join(installRoot, "packages", "pocket_ui", "legacy_only.ts"))).toBe(false);
      expect(readFileSync(nestedCustomPackageFile, "utf8")).toBe('export const customPkg = "preserved-in-packages";\n');
      expect(readFileSync(nestedCustomUiPluginFile, "utf8")).toBe('export const customExt = "preserved-in-pocket-ui";\n');
      expect(readFileSync(customProjectFile, "utf8")).toBe('export const game = "preserved-consumer-code";\n');
      expect(readFileSync(customDiagFile, "utf8")).toBe('{"logs":["preserved-diagnostic"]}\n');
      expect(readFileSync(customConsumerRootFile, "utf8")).toBe('{"customConsumerSetting":true}\n');
      expect(readFileSync(customNodeModuleFile, "utf8")).toBe("module.exports = {};\n");

      // Simulate interrupted apply (backup directory still present on next service startup) and verify automatic crash recovery
      writePersistedUpgradeStatus(installRoot, {
        status: "restarting",
        previousVersion: "0.1.10",
        currentVersion: "0.1.10",
        latestVersion: "0.1.11",
        targetVersion: "0.1.11",
      });
      const recovered = recoverInterruptedSdkUpgrade(installRoot, PLATFORM, ARCH);
      expect(recovered).toEqual({ restoredVersion: "0.1.10", targetVersion: "0.1.11" });
      expect(JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")).version).toBe("0.1.10");
      expect(existsSync(join(installRoot, "packages", "pocket_ui", "legacy_only.ts"))).toBe(true);
      expect(existsSync(join(installRoot, "packages", "pocket_ui", "new_v11_feature.ts"))).toBe(false);
      expect(readFileSync(nestedCustomPackageFile, "utf8")).toBe('export const customPkg = "preserved-in-packages";\n');
      expect(readFileSync(nestedCustomUiPluginFile, "utf8")).toBe('export const customExt = "preserved-in-pocket-ui";\n');
      expect(readPersistedUpgradeStatus(installRoot)?.rolledBack).toBe(true);
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
      rmSync(stageGood, { recursive: true, force: true });
    }
  });

  test("authenticates lock handoff with randomUUID token + targetVersion + stageDir and retries transient Windows EBUSY/EPERM errors", () => {
    const lockRoot = mkdtempSync(join(tmpdir(), "pocket-lock-auth-"));
    try {
      const stageA = resolve(lockRoot, "stage-a");
      const stageB = resolve(lockRoot, "stage-b");
      const releaseParent = acquireUpgradeApplyLock(lockRoot, {
        phase: "downloading",
        targetVersion: "0.1.11",
      });
      // While in 'downloading' phase, even a child with 'applying' is rejected
      expect(() =>
        acquireUpgradeApplyLock(lockRoot, {
          phase: "applying",
          targetVersion: "0.1.11",
          stageDir: stageA,
          handoffToken: "tok-secret-1",
        }),
      ).toThrow(/已有另一个升级进程正在执行/);

      // Transition to 'spawning' with handoffToken + stageDir + targetVersion right before handoff
      releaseParent.update({
        phase: "spawning",
        targetVersion: "0.1.11",
        stageDir: stageA,
        handoffToken: "tok-secret-1",
      });

      // Unauthenticated or mismatched token / stageDir / version must be rejected
      expect(() =>
        acquireUpgradeApplyLock(lockRoot, {
          phase: "applying",
          targetVersion: "0.1.11",
          stageDir: stageA,
          handoffToken: "wrong-token",
        }),
      ).toThrow(/已有另一个升级进程正在执行/);
      expect(() =>
        acquireUpgradeApplyLock(lockRoot, {
          phase: "applying",
          targetVersion: "0.1.11",
          stageDir: stageB,
          handoffToken: "tok-secret-1",
        }),
      ).toThrow(/已有另一个升级进程正在执行/);
      expect(() =>
        acquireUpgradeApplyLock(lockRoot, {
          phase: "applying",
          targetVersion: "0.1.12",
          stageDir: stageA,
          handoffToken: "tok-secret-1",
        }),
      ).toThrow(/已有另一个升级进程正在执行/);

      // Matching token + stageDir + targetVersion takes over the lock
      const releaseChild = acquireUpgradeApplyLock(lockRoot, {
        phase: "applying",
        targetVersion: "0.1.11",
        stageDir: stageA,
        handoffToken: "tok-secret-1",
      });
      releaseChild();

      // Bounded Windows file-release retry helper recovers from transient EBUSY/EPERM
      let attempts = 0;
      const result = withBoundedFsRetries(() => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error("resource busy or locked") as Error & { code?: string };
          err.code = attempts === 1 ? "EBUSY" : "EPERM";
          throw err;
        }
        return "ok";
      }, 5, 5);
      expect(result).toBe("ok");
      expect(attempts).toBe(3);
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test("defers upgrade apply when server work is active (canApplyUpgrade) and rejects direct apply with HTTP 409", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pocket-defer-busy-"));
    const v11Staging = mkdtempSync(join(tmpdir(), "pocket-defer-v11-"));
    try {
      createStandaloneSdkTree(tempRoot, "0.1.10");
      const v11 = createStandaloneSdkTree(v11Staging, "0.1.11");
      let busy = true;
      let triggered = 0;
      const manager = createStudioUpgradeManager({
        sdkRoot: tempRoot,
        allowLoopbackHttp: true,
        releasesUrl: "http://127.0.0.1:65532/releases",
        canApplyUpgrade: () =>
          busy
            ? { allowed: false, reason: "当前有正在执行的项目保存、构建、发布或部署任务，已暂缓自动升级" }
            : { allowed: true },
        fetchImpl: async (url: string) => {
          if (url.endsWith("/releases")) {
            return new Response(
              JSON.stringify([
                {
                  tag_name: "sdk-v0.1.11",
                  draft: false,
                  prerelease: false,
                  html_url: "https://github.com/CodeEagle/pocket/releases/tag/sdk-v0.1.11",
                  assets: [
                    { name: v11.archiveName, browser_download_url: `http://127.0.0.1:65532/${v11.archiveName}` },
                    { name: v11.checksumName, browser_download_url: `http://127.0.0.1:65532/${v11.checksumName}` },
                  ],
                },
              ]),
            );
          }
          if (url.endsWith(".sha256")) return new Response(`${v11.archiveSha256}  ${v11.archiveName}\n`);
          return new Response(v11.archiveBytes);
        },
        triggerServiceUpgrade: async () => {
          triggered += 1;
        },
      });

      const deferredCheck = await manager.check({ autoApply: true });
      expect(deferredCheck.status).toBe("available");
      expect(deferredCheck.upgradeAvailable).toBe(true);
      expect(deferredCheck.deferredReason).toContain("已暂缓自动升级");
      expect(triggered).toBe(0);

      await expect(manager.apply()).rejects.toMatchObject({ status: 409 });
      expect(triggered).toBe(0);

      busy = false;
      const resumedCheck = await manager.check({ autoApply: true });
      expect(resumedCheck.status).toBe("restarting");
      expect(resumedCheck.deferredReason).toBeNull();
      expect(triggered).toBe(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(v11Staging, { recursive: true, force: true });
    }
  });
});

async function allocateFreeLoopbackPort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const srv = createNetServer();
    srv.once("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

function buildRealMinimalStandaloneServerSource(options: { failOnVersion?: string } = {}): string {
  const clientDirLiteral = JSON.stringify(resolve(import.meta.dir, "../client"));
  const failOnVersionLiteral = JSON.stringify(options.failOnVersion || "");
  return `import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStudioUpgradeManager, readInstalledSdkInfo } from "../scripts/studio_upgrade.mjs";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = ${clientDirLiteral};
const failOnVersion = ${failOnVersionLiteral};

const args = process.argv.slice(2);
const readOpt = (name) => {
  const prefix = \`--\${name}=\`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
};
const host = readOpt("host") || "127.0.0.1";
const port = Number(readOpt("port") || process.env.POCKET_EDITOR_PORT || 8791);
const workspace = resolve(readOpt("workspace") || join(sdkRoot, ".pocket-build", "editor-workspace-8791"));
const projectRoot = process.env.POCKET_EDITOR_PROJECT_ROOT ? resolve(process.env.POCKET_EDITOR_PROJECT_ROOT) : undefined;
const updatePackageVersion = process.env.POCKET_EDITOR_PACKAGE_VERSION || undefined;

const installed = readInstalledSdkInfo(sdkRoot);
if (failOnVersion && installed.currentVersion === failOnVersion) {
  console.error(\`Simulated startup crash on version \${installed.currentVersion}\`);
  process.exit(1);
}

const projectFile = join(workspace, "projects", "bound-app", "app.tsx");
mkdirSync(dirname(projectFile), { recursive: true });
if (!existsSync(projectFile)) {
  writeFileSync(projectFile, "export default function App() { return null; }\\n");
}
let projectConfig = {
  id: "bound-app",
  name: "Bound App",
  title: "Bound App",
  appId: "dev.pocket.bound",
  version: "0.1.0",
  build: 1,
  tickHz: 60,
  entry: "app.tsx",
};
let projectRevision = 1;

const upgradeManager = createStudioUpgradeManager({
  sdkRoot,
  allowLoopbackHttp: true,
  releasesUrl: process.env.POCKET_TEST_RELEASES_URL,
});

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });

    if (path === "/health" && method === "GET") {
      return json({
        ok: true,
        service: "pocket-editor",
        pid: process.pid,
        version: installed.currentVersion,
        csrfToken: "csrf-standalone-e2e",
        workspace,
        bytecodeAbi: process.env.POCKET_BYTECODE_BIN || "",
        compilerPath: process.env.POCKET_COMPILER_PATH || "",
        ...(projectRoot ? { projectRoot, projectId: "bound-app" } : {}),
        ...(updatePackageVersion ? { updatePackageVersion } : {}),
      });
    }
    if (path === "/api/studio/upgrade" && method === "GET") {
      return json(upgradeManager.status());
    }
    if (path === "/api/studio/upgrade/check" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      return json(
        await upgradeManager.check({
          autoApply: body.autoApply !== false,
          forceApply: body.forceApply === true,
        }),
      );
    }
    if (path === "/api/studio/upgrade/apply" && method === "POST") {
      try {
        return json(await upgradeManager.apply());
      } catch (err) {
        return json({ error: err?.message || String(err) }, err?.status || 400);
      }
    }
    if (path === "/api/preview/device" && method === "GET") {
      return json({
        model: "iPhone",
        screenWidth: 390,
        screenHeight: 844,
        pixelRatio: 3,
        statusBarHeight: 47,
        safeAreaBottom: 34,
        safeArea: { top: 47, right: 0, bottom: 34, left: 0 },
        shell: {
          bezel: 12,
          borderRadius: 48,
          notchWidth: 126,
          notchHeight: 37,
          homeIndicatorWidth: 134,
          homeIndicatorHeight: 5,
          homeIndicatorBottom: 8,
        },
      });
    }
    if (path === "/api/devices" && method === "GET") return json({ devices: [] });
    if (path === "/api/projects" && method === "GET") {
      return json([{ id: "bound-app", name: projectConfig.name, version: projectConfig.version }]);
    }
    if (path === "/api/projects/bound-app/config") {
      if (method === "GET") return json(projectConfig);
      if (method === "PUT") {
        const body = await req.json().catch(() => ({}));
        projectConfig = { ...projectConfig, ...body };
        projectRevision += 1;
        return json({
          ...projectConfig,
          status: { revision: projectRevision, builtRevision: projectRevision, busy: false, logs: [] },
        });
      }
    }
    if (path === "/api/projects/bound-app/files" && method === "GET") {
      return json({ files: ["app.tsx"], revision: projectRevision });
    }
    if (path === "/api/projects/bound-app/files/app.tsx") {
      if (method === "GET") {
        const content = readFileSync(projectFile, "utf8");
        return json({ path: "app.tsx", content, bytes: Buffer.byteLength(content), revision: projectRevision });
      }
      if (method === "PUT") {
        const body = await req.json().catch(() => ({}));
        const content = String(body.content ?? "");
        writeFileSync(projectFile, content);
        projectRevision += 1;
        return json({ path: "app.tsx", bytes: Buffer.byteLength(content), revision: projectRevision });
      }
    }
    if (path === "/api/projects/bound-app/status" && method === "GET") {
      return json({ revision: projectRevision, builtRevision: projectRevision, busy: false, logs: [] });
    }
    if (path === "/api/projects/bound-app/resources" && method === "GET") {
      return json({ revision: projectRevision, builtRevision: projectRevision, packages: [] });
    }
    if (path === "/api/projects/bound-app/wechat" && method === "GET") {
      return json({ state: "idle", url: "", error: "", logs: [], targets: [] });
    }
    if (path === "/api/projects/bound-app/deploy" && method === "GET") {
      return json({ jobs: [] });
    }
    if (path === "/" && method === "GET") {
      const index = readFileSync(join(clientRoot, "index.html"), "utf8");
      return new Response(index, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (/^\\/[A-Za-z0-9_-]+\\.(?:css|js)$/.test(path) && method === "GET") {
      const file = join(clientRoot, path.slice(1));
      if (existsSync(file) && statSync(file).isFile()) {
        const type = file.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
        return new Response(readFileSync(file), { headers: { "content-type": type, "cache-control": "no-store" } });
      }
    }
    return new Response("not found", { status: 404 });
  },
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, () => {
    server.stop(true);
    process.exit(0);
  });
}
`;
}

function populateRealStandaloneScripts(
  targetSdkRoot: string,
  version: string,
  options: {
    upstreamRevision?: string;
    bytecodeAbi?: string;
    failOnVersion?: string;
    extraPackageFiles?: Record<string, string | Buffer>;
  } = {},
) {
  const repoScriptsDir = resolve(import.meta.dir, "../../scripts");
  const repoEditorDir = resolve(import.meta.dir, "..");
  const repoNodeModules = resolve(import.meta.dir, "../../node_modules");
  const upstreamRevision = options.upstreamRevision ?? UPSTREAM_REVISION;
  const bytecodeAbi = options.bytecodeAbi ?? BYTECODE_ABI;

  const prebuiltSource = readFileSync(join(repoScriptsDir, "prebuilt_tools.mjs"), "utf8")
    .replace(/export const SDK_VERSION = ['"][^'"]+['"];/, `export const SDK_VERSION = '${version}';`)
    .replace(/export const UPSTREAM_REVISION = ['"][^'"]+['"];/, `export const UPSTREAM_REVISION = '${upstreamRevision}';`)
    .replace(/export const BYTECODE_ABI = ['"][^'"]+['"];/, `export const BYTECODE_ABI = '${bytecodeAbi}';`);

  // Mirror export_web_sdk's editor source copy (which removes editor/test)
  // instead of maintaining a second hand-written list of CLI runtime imports.
  // The test's minimal server entry is overlaid below to keep lifecycle
  // behavior controlled while editor_service.mjs uses the real editor helpers.
  const editorRuntimeFiles: Record<string, Buffer> = {};
  const ignoredEditorPathParts = new Set(["test", "node_modules", "target", ".cache", ".pocket-build", ".git"]);
  const collectEditorRuntimeFiles = (currentDir: string): void => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(repoEditorDir, fullPath).replaceAll("\\", "/");
      if (relPath.split("/").some((part) => ignoredEditorPathParts.has(part))) continue;
      if (entry.isDirectory()) {
        collectEditorRuntimeFiles(fullPath);
      } else if (entry.isFile()) {
        editorRuntimeFiles[`editor/${relPath}`] = readFileSync(fullPath);
      }
    }
  };
  collectEditorRuntimeFiles(repoEditorDir);

  const archiveInfo = createStandaloneSdkTree(targetSdkRoot, version, {
    upstreamRevision,
    bytecodeAbi,
    extraPackageFiles: {
      ...editorRuntimeFiles,
      "scripts/editor_service.mjs": readFileSync(join(repoScriptsDir, "editor_service.mjs"), "utf8"),
      "scripts/studio_upgrade.mjs": readFileSync(join(repoScriptsDir, "studio_upgrade.mjs"), "utf8"),
      "scripts/prebuilt_tools.mjs": prebuiltSource,
      "scripts/native_probe_path.ts": readFileSync(join(repoScriptsDir, "native_probe_path.ts"), "utf8"),
      "editor/server.ts": buildRealMinimalStandaloneServerSource({ failOnVersion: options.failOnVersion }),
      ...(options.extraPackageFiles || {}),
    },
  });

  // Link find-process and tree-kill from repo node_modules so real editor_service.mjs CLI works in standaloneRoot
  const targetNodeModules = join(targetSdkRoot, "node_modules");
  mkdirSync(targetNodeModules, { recursive: true });
  for (const dep of ["find-process", "tree-kill"]) {
    const srcDep = join(repoNodeModules, dep);
    const dstDep = join(targetNodeModules, dep);
    if (existsSync(srcDep) && !existsSync(dstDep)) {
      symlinkSync(srcDep, dstDep, "dir");
    }
  }
  return archiveInfo;
}

function upgradeLifecycleProcessDiagnostics(sdkRoot: string): Record<string, unknown> {
  const buildRoot = join(sdkRoot, ".pocket-build");
  const readJson = (name: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(buildRoot, name), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const pidRecord = readJson("editor-service-8791.pid.json");
  const applyLock = readJson("sdk-upgrade-apply.lock.json");
  const observedPids = [pidRecord?.pid, applyLock?.pid]
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const pidStatus = observedPids.map((pid) => {
    try {
      process.kill(pid, 0);
      return { pid, alive: true };
    } catch (error) {
      return { pid, alive: (error as NodeJS.ErrnoException).code === "EPERM" };
    }
  });

  if (process.platform === "win32") {
    return { pidStatus, processTree: "ps is unavailable on win32" };
  }
  const ps = spawnSync("ps", ["-eo", "pid,ppid,stat,args"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (ps.error || ps.status !== 0) {
    return {
      pidStatus,
      processTreeError: ps.error?.message || ps.stderr || `ps exited ${ps.status}`,
    };
  }

  const rows = ps.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), state: match[3], command: match[4] }]
      : [];
  });
  const treePids = new Set(observedPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (treePids.has(row.ppid) && !treePids.has(row.pid)) {
        treePids.add(row.pid);
        changed = true;
      }
    }
  }
  const relevantProcesses = rows.filter((row) =>
    treePids.has(row.pid) || row.command.includes(sdkRoot),
  );
  return { pidStatus, processTree: relevantProcesses };
}

async function reportUpgradeLifecycleFailure(sdkRoot: string, browser: import("playwright").Browser): Promise<void> {
  console.error(`[upgrade lifecycle failure] ${sdkRoot}`);
  const buildRoot = join(sdkRoot, ".pocket-build");
  const files = ["editor-service-8791.log", "sdk-upgrade-status.json", "sdk-upgrade-apply.lock.json", "editor-service-8791.pid.json"];
  for (const file of files) {
    const source = join(buildRoot, file);
    if (existsSync(source)) console.error(`[upgrade lifecycle ${file}] ${readFileSync(source, "utf8").slice(-16000)}`);
  }
  console.error("[upgrade lifecycle processes]", JSON.stringify(upgradeLifecycleProcessDiagnostics(sdkRoot), null, 2));
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      console.error("[upgrade lifecycle UI]", await page.locator("#studio-upgrade-status").textContent({ timeout: 1000 }).catch(() => "unavailable"));
    }
  }

  try {
    const artifactDir = join(
      process.env.RUNNER_TEMP || tmpdir(),
      "pocket-studio-upgrade-diagnostics",
      basename(sdkRoot),
    );
    mkdirSync(artifactDir, { recursive: true });
    for (const file of files) {
      const source = join(buildRoot, file);
      if (existsSync(source)) copyFileSync(source, join(artifactDir, file));
    }
    writeFileSync(
      join(artifactDir, "process-tree.json"),
      `${JSON.stringify(upgradeLifecycleProcessDiagnostics(sdkRoot), null, 2)}\n`,
    );
    console.error(`[upgrade lifecycle diagnostics] ${artifactDir}`);
  } catch (error) {
    console.error("[upgrade lifecycle diagnostics copy failed]", error);
  }
}

describe("Studio self-upgrade end-to-end service lifecycle + Playwright Chromium UI integration", () => {
  test("executes real detached editor_service.mjs CLI upgrade-apply with future ABI validation, defers while dirty, and automatically navigates browser on completion", { timeout: 55_000 }, async () => {
    const standaloneRoot = mkdtempSync(join(tmpdir(), "pocket-e2e-real-cli-sdk-"));
    const workspaceRoot = join(standaloneRoot, ".pocket-build", "editor-workspace-8791");
    const v11BuildRoot = mkdtempSync(join(tmpdir(), "pocket-e2e-real-cli-v11-"));
    const testPort = await allocateFreeLoopbackPort();
    let releaseServer: ReturnType<typeof Bun.serve> | undefined;
    console.info(`[upgrade lifecycle] launching Chromium on ${PLATFORM}, runner ${Bun.version}, SDK Bun ${SDK_BUN}`);
    const browser = await chromium.launch({ headless: true, timeout: 15_000 });
    console.info("[upgrade lifecycle] Chromium ready");

    const futureRevision = "2222222222333333333344444444445555555555";
    const futureAbi = `quickjs-bytecode-v1:${"b".repeat(64)}`;

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      POCKET_STUDIO_TEST_PORT: String(testPort),
      POCKET_BUN: SDK_BUN,
      POCKET_EDITOR_BUN: SDK_BUN,
    };
    // Temporarily unset POCKET_SOURCE_BUILD for the child service so real prebuiltEnvironment & future ABI validation run!
    delete childEnv.POCKET_SOURCE_BUILD;

    try {
      populateRealStandaloneScripts(standaloneRoot, "0.1.10");
      const v11 = populateRealStandaloneScripts(v11BuildRoot, "0.1.11", {
        upstreamRevision: futureRevision,
        bytecodeAbi: futureAbi,
      });

      const preservedProjectMarker = join(workspaceRoot, "projects", "consumer-keep", "custom.txt");
      const nestedCustomPackage = join(standaloneRoot, "packages", "my-custom-package", "custom.ts");
      const configuredProjectRoot = join(workspaceRoot, "projects", "bound-app");
      mkdirSync(dirname(preservedProjectMarker), { recursive: true });
      mkdirSync(dirname(nestedCustomPackage), { recursive: true });
      mkdirSync(configuredProjectRoot, { recursive: true });
      writeFileSync(preservedProjectMarker, "keep-my-project-data\n");
      writeFileSync(nestedCustomPackage, "export const custom = 42;\n");
      writeFileSync(join(configuredProjectRoot, "pocket.json"), JSON.stringify({ name: "bound-app", title: "Bound App", entry: "app.tsx" }));
      writeFileSync(join(configuredProjectRoot, "app.tsx"), "export default function App() { return null; }\n");

      releaseServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          const origin = `http://127.0.0.1:${releaseServer!.port}`;
          if (url.pathname === "/releases") {
            return new Response(
              JSON.stringify([
                {
                  tag_name: "sdk-v0.1.11",
                  draft: false,
                  prerelease: false,
                  html_url: "https://github.com/CodeEagle/pocket/releases/tag/sdk-v0.1.11",
                  assets: [
                    { name: v11.archiveName, browser_download_url: `${origin}/download/${v11.archiveName}` },
                    { name: v11.checksumName, browser_download_url: `${origin}/download/${v11.checksumName}` },
                  ],
                },
              ]),
              { headers: { "content-type": "application/json" } },
            );
          }
          if (url.pathname === `/download/${v11.checksumName}`) {
            return new Response(`${v11.archiveSha256}  ${v11.archiveName}\n`, {
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          if (url.pathname === `/download/${v11.archiveName}`) {
            return new Response(v11.archiveBytes, {
              headers: { "content-type": "application/gzip" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      });

      childEnv.POCKET_TEST_RELEASES_URL = `http://127.0.0.1:${releaseServer.port}/releases`;

      console.info("[upgrade lifecycle] starting standalone CLI");
      // Start the initial 0.1.10 standalone service using the real editor_service.mjs CLI
      const startRes = spawnSync(
        "node",
        [
          join(standaloneRoot, "scripts", "editor_service.mjs"),
          "start",
          `--project-root=${configuredProjectRoot}`,
          "--update-package-version=1.0.0",
        ],
        { cwd: standaloneRoot, env: childEnv as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 },
      );
      if (startRes.status !== 0) throw new Error(`Standalone CLI failed: ${startRes.error || ""}\n${startRes.stdout}\n${startRes.stderr}`);
      expect(startRes.status).toBe(0);

      const initialHealth = (await (await fetch(`http://127.0.0.1:${testPort}/health`)).json()) as {
        pid: number;
        version: string;
        projectRoot?: string;
        updatePackageVersion?: string;
      };
      expect(initialHealth.version).toBe("0.1.10");
      expect(initialHealth.pid).toBeGreaterThan(0);
      expect(initialHealth.projectRoot).toBe(configuredProjectRoot);
      expect(initialHealth.updatePackageVersion).toBe("1.0.0");

      const page = await browser.newPage();
      let mainFrameNavigations = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) mainFrameNavigations += 1;
      });

      // Block automatic initial apply via dirty draft first to verify dirty deferral in the browser
      await page.route("**/api/studio/upgrade/check", async (route, request) => {
        const postBody = JSON.parse(request.postData() || "{}");
        // Let the first automatic startup check see autoApply=false so we can test dirty draft deferral and save-triggered resume
        if (mainFrameNavigations <= 1 && postBody.autoApply === true && !postBody.forceApply && !(await page.evaluate(() => Boolean((window as unknown as { __ALLOW_AUTO_APPLY__?: boolean }).__ALLOW_AUTO_APPLY__)))) {
          await route.continue({
            postData: JSON.stringify({ ...postBody, autoApply: false }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto(`http://127.0.0.1:${testPort}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => (document.getElementById("studio-upgrade-version")?.textContent || "").includes("v0.1.10 → v0.1.11"),
        undefined,
        { timeout: 10_000 },
      );

      // Make source editor dirty and verify clicking upgrade defers apply while dirty
      await page.evaluate(() => {
        (window as unknown as { __ALLOW_AUTO_APPLY__?: boolean }).__ALLOW_AUTO_APPLY__ = true;
        const source = document.getElementById("source") as HTMLTextAreaElement | null;
        if (source) {
          source.value = "// unsaved user draft\nexport default function App() { return null; }\n";
          source.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await page.locator("#studio-upgrade-action").click();
      await page.waitForFunction(
        () => (document.getElementById("studio-upgrade-status")?.textContent || "").includes("未保存修改"),
        undefined,
        { timeout: 10_000 },
      );
      const deferredBarText = await page.locator("#studio-upgrade-status").textContent();
      expect(deferredBarText).toContain("未保存修改");

      // Now save the project in the UI; saving clears dirty state and automatically resumes the deferred upgrade,
      // which spawns the real detached editor_service.mjs upgrade-apply process, replaces the PID with v0.1.11 (future ABI),
      // and triggers a real automatic window.location.reload() navigation in Chromium!
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
        page.locator("#save").dispatchEvent("click"),
      ]);

      await page.waitForFunction(
        () => {
          const v = document.getElementById("studio-upgrade-version")?.textContent || "";
          const s = document.getElementById("studio-upgrade-status")?.textContent || "";
          return v.includes("v0.1.11") && s.includes("已是最新稳定版");
        },
        undefined,
        { timeout: 15_000 },
      );

      const upgradedHealth = (await (await fetch(`http://127.0.0.1:${testPort}/health`)).json()) as {
        ok: boolean;
        pid: number;
        version: string;
        projectRoot?: string;
        updatePackageVersion?: string;
        compilerPath?: string;
      };
      expect(upgradedHealth.ok).toBe(true);
      expect(upgradedHealth.version).toBe("0.1.11");
      expect(upgradedHealth.pid).not.toBe(initialHealth.pid);
      expect(upgradedHealth.projectRoot).toBe(configuredProjectRoot);
      expect(upgradedHealth.updatePackageVersion).toBe("1.0.0");

      // Also verify in-process editorToolEnvironment(options, standaloneRoot) with POCKET_SOURCE_BUILD unset
      // validates the newly applied future ABI on disk without stale module constant mismatch
      const prevSourceBuild = process.env.POCKET_SOURCE_BUILD;
      delete process.env.POCKET_SOURCE_BUILD;
      try {
        const prevBun = process.env.POCKET_BUN;
        process.env.POCKET_BUN = process.execPath;
        try {
          const resolvedEnv = editorToolEnvironment({}, standaloneRoot);
          expect(resolvedEnv.POCKET_TOOLS_PACKAGE).toContain(join(standaloneRoot, "node_modules", "@pocket", `tools-${TUPLE}`));
        } finally {
          if (prevBun === undefined) delete process.env.POCKET_BUN;
          else process.env.POCKET_BUN = prevBun;
        }
      } finally {
        if (prevSourceBuild !== undefined) process.env.POCKET_SOURCE_BUILD = prevSourceBuild;
      }

      expect(JSON.parse(readFileSync(join(standaloneRoot, "package.json"), "utf8")).version).toBe("0.1.11");
      expect(readFileSync(preservedProjectMarker, "utf8")).toBe("keep-my-project-data\n");
      expect(readFileSync(nestedCustomPackage, "utf8")).toBe("export const custom = 42;\n");
      expect(readFileSync(join(configuredProjectRoot, "app.tsx"), "utf8")).toContain("unsaved user draft");
    } catch (error) {
      await reportUpgradeLifecycleFailure(standaloneRoot, browser);
      throw error;
    } finally {
      await browser.close();
      spawnSync("node", [join(standaloneRoot, "scripts", "editor_service.mjs"), "stop"], {
        cwd: standaloneRoot,
        env: childEnv as NodeJS.ProcessEnv,
        stdio: "ignore",
        timeout: 10_000,
      });
      if (releaseServer) releaseServer.stop(true);
      rmSync(standaloneRoot, { recursive: true, force: true });
      rmSync(v11BuildRoot, { recursive: true, force: true });
    }
  });

  test("handles post-stage startup failure with real detached CLI rollback and recovers interrupted upgrades only during restart", { timeout: 55_000 }, async () => {
    const standaloneRoot = mkdtempSync(join(tmpdir(), "pocket-e2e-real-rollback-sdk-"));
    const v11BuildRoot = mkdtempSync(join(tmpdir(), "pocket-e2e-real-rollback-v11-"));
    const testPort = await allocateFreeLoopbackPort();
    let releaseServer: ReturnType<typeof Bun.serve> | undefined;
    console.info(`[upgrade lifecycle] launching Chromium on ${PLATFORM}, runner ${Bun.version}, SDK Bun ${SDK_BUN}`);
    const browser = await chromium.launch({ headless: true, timeout: 15_000 });
    console.info("[upgrade lifecycle] Chromium ready");

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      POCKET_STUDIO_TEST_PORT: String(testPort),
      POCKET_STUDIO_UPGRADE_HEALTH_TIMEOUT_MS: "2500",
      POCKET_BUN: SDK_BUN,
      POCKET_EDITOR_BUN: SDK_BUN,
    };
    delete childEnv.POCKET_SOURCE_BUILD;

    try {
      populateRealStandaloneScripts(standaloneRoot, "0.1.10");
      // Build 0.1.11 archive whose server.ts exits immediately on startup (failOnVersion: "0.1.11")
      const v11 = populateRealStandaloneScripts(v11BuildRoot, "0.1.11", {
        failOnVersion: "0.1.11",
      });
      const nestedCustomFile = join(standaloneRoot, "packages", "my-custom-package", "custom.ts");
      mkdirSync(dirname(nestedCustomFile), { recursive: true });
      writeFileSync(nestedCustomFile, 'export const keep = "nested-consumer-file";\n');

      // 1. Verify status() does NOT run recoverInterruptedSdkUpgrade, while restart() DOES recover after stopping owned service
      const stageForInterrupt = mkdtempSync(join(tmpdir(), "pocket-stage-interrupt-"));
      const backupDir = join(standaloneRoot, ".pocket-build", "sdk-upgrade-backup-0.1.10");
      extractSafeTarGz(v11.archiveBytes, stageForInterrupt, { stripTopLevelPackage: true });
      prepareSdkUpgradeBackup(standaloneRoot, stageForInterrupt, backupDir, PLATFORM, ARCH);
      applyStagedSdkFiles(standaloneRoot, stageForInterrupt, backupDir, PLATFORM, ARCH);
      rmSync(stageForInterrupt, { recursive: true, force: true });
      expect(JSON.parse(readFileSync(join(standaloneRoot, "package.json"), "utf8")).version).toBe("0.1.11");

      // Calling `status` must NOT mutate or recover the interrupted backup
      spawnSync("node", [join(standaloneRoot, "scripts", "editor_service.mjs"), "status"], {
        cwd: standaloneRoot,
        env: childEnv as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(existsSync(backupDir)).toBe(true);
      expect(JSON.parse(readFileSync(join(standaloneRoot, "package.json"), "utf8")).version).toBe("0.1.11");

      // Calling `restart` stops any owned process, recovers the backup to 0.1.10, re-execs cold service, and boots 0.1.10 healthy
      releaseServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          const origin = `http://127.0.0.1:${releaseServer!.port}`;
          if (url.pathname === "/releases") {
            return new Response(
              JSON.stringify([
                {
                  tag_name: "sdk-v0.1.11",
                  draft: false,
                  prerelease: false,
                  html_url: "https://github.com/CodeEagle/pocket/releases/tag/sdk-v0.1.11",
                  assets: [
                    { name: v11.archiveName, browser_download_url: `${origin}/download/${v11.archiveName}` },
                    { name: v11.checksumName, browser_download_url: `${origin}/download/${v11.checksumName}` },
                  ],
                },
              ]),
              { headers: { "content-type": "application/json" } },
            );
          }
          if (url.pathname === `/download/${v11.checksumName}`) {
            return new Response(`${v11.archiveSha256}  ${v11.archiveName}\n`);
          }
          if (url.pathname === `/download/${v11.archiveName}`) {
            return new Response(v11.archiveBytes);
          }
          return new Response("not found", { status: 404 });
        },
      });
      childEnv.POCKET_TEST_RELEASES_URL = `http://127.0.0.1:${releaseServer.port}/releases`;

      const restartRes = spawnSync("node", [join(standaloneRoot, "scripts", "editor_service.mjs"), "restart"], {
        cwd: standaloneRoot,
        env: childEnv as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 25_000,
      });
      expect(restartRes.status).toBe(0);
      expect(existsSync(backupDir)).toBe(false);
      expect(JSON.parse(readFileSync(join(standaloneRoot, "package.json"), "utf8")).version).toBe("0.1.10");

      // Clear persisted status before testing live detached upgrade failure + automatic rollback
      rmSync(join(standaloneRoot, ".pocket-build", "sdk-upgrade-status.json"), { force: true });

      const page = await browser.newPage();
      let navigations = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });

      await page.goto(`http://127.0.0.1:${testPort}/`, { waitUntil: "domcontentloaded" });
      const navAfterInitialLoad = navigations;

      await page.waitForFunction(
        () => {
          const status = document.getElementById("studio-upgrade-status")?.textContent || "";
          return status.includes("已自动回滚到 v0.1.10");
        },
        undefined,
        { timeout: 25_000 },
      );

      expect(navigations).toBe(navAfterInitialLoad);
      expect(JSON.parse(readFileSync(join(standaloneRoot, "package.json"), "utf8")).version).toBe("0.1.10");
      expect(readFileSync(nestedCustomFile, "utf8")).toBe('export const keep = "nested-consumer-file";\n');
      expect(readPersistedUpgradeStatus(standaloneRoot)?.rolledBack).toBe(true);
    } catch (error) {
      await reportUpgradeLifecycleFailure(standaloneRoot, browser);
      throw error;
    } finally {
      await browser.close();
      spawnSync("node", [join(standaloneRoot, "scripts", "editor_service.mjs"), "stop"], {
        cwd: standaloneRoot,
        env: childEnv as NodeJS.ProcessEnv,
        stdio: "ignore",
        timeout: 10_000,
      });
      if (releaseServer) releaseServer.stop(true);
      rmSync(standaloneRoot, { recursive: true, force: true });
      rmSync(v11BuildRoot, { recursive: true, force: true });
    }
  });
});
