import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fetchSourceReleaseCommit,
  inspectSourceUpdate,
  validateInstalledSourceTools,
  validateSourceReleaseStage,
} from "../../scripts/studio_upgrade.mjs";

const origin = "https://github.com/CodeEagle/pocket.git";
const upstream = "a".repeat(40);
const abi = "fixture-qjbc-v1";

function git(repo: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd: repo, encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]}: ${result.error || result.stderr}`);
  return result.stdout.trim();
}

function json(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function constants(version: string) {
  return `export const SDK_VERSION = '${version}';\nexport const UPSTREAM_REVISION = '${upstream}';\nexport const BYTECODE_ABI = '${abi}';\n`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pocket-source-upgrade-git-"));
  const repo = join(root, "repo");
  const sdk = join(repo, "sdk");
  mkdirSync(sdk, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Pocket Upgrade Test");
  git(repo, "config", "user.email", "upgrade@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "tag.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.hooksPath", join(root, "no-hooks"));
  git(repo, "remote", "add", "origin", origin);
  function version(value: string) {
    json(join(sdk, "package.json"), { name: "pocketjs-sdk", version: value, dependencies: { example: "1.0.0" } });
    json(join(sdk, "package-lock.json"), {
      name: "pocketjs-sdk", version: value, lockfileVersion: 3,
      packages: { "": { version: value, dependencies: { example: "1.0.0" } }, "node_modules/example": { version: "1.0.0" } },
    });
    mkdirSync(join(sdk, "scripts"), { recursive: true });
    writeFileSync(join(sdk, "scripts", "prebuilt_tools.mjs"), constants(value));
  }
  function commit(message: string) {
    git(repo, "add", ".");
    git(repo, "commit", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  }
  version("1.0.0");
  const before = commit("baseline");
  version("1.0.1");
  const target = commit("release");
  git(repo, "tag", "sdk-v1.0.1", target);
  git(repo, "reset", "--hard", before);
  return { root, repo, sdk, before, target, version, commit, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("source SDK upgrade Git boundaries", () => {
  test("accepts a clean main fast-forward across version-only lock changes without changing HEAD", () => {
    const f = fixture();
    try {
      const result = inspectSourceUpdate(f.sdk, f.target);
      expect(result.canApply).toBe(true);
      expect(result.head).toBe(f.before);
      expect(result.targetCommit).toBe(f.target);
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.before);
      expect(git(f.repo, "status", "--porcelain")).toBe("");
    } finally { f.close(); }
  });

  test.each(["tracked", "staged", "untracked"])("defers %s changes and preserves their bytes and HEAD", kind => {
    const f = fixture();
    try {
      const path = join(f.sdk, kind === "untracked" ? "consumer-custom.ts" : "package.json");
      const content = kind === "untracked" ? "export const keep = true;" : readFileSync(path, "utf8") + "\n";
      writeFileSync(path, content);
      if (kind === "staged") git(f.repo, "add", path);
      const result = inspectSourceUpdate(f.sdk, f.target);
      expect(result.canApply).toBe(false);
      expect(result.deferredReason).toMatch(/暂存|修改|未跟踪/);
      expect(readFileSync(path, "utf8")).toBe(content);
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.before);
    } finally { f.close(); }
  });

  test.each(["branch", "detached", "origin", "rewritten origin", "diverged"])("defers an unsafe %s state", kind => {
    const f = fixture();
    try {
      if (kind === "branch") git(f.repo, "switch", "-c", "consumer-work");
      if (kind === "detached") git(f.repo, "checkout", "--detach", f.before);
      if (kind === "origin") git(f.repo, "remote", "set-url", "origin", "https://example.invalid/CodeEagle/pocket.git");
      if (kind === "rewritten origin") git(f.repo, "config", "url.https://example.invalid/pocket.git.insteadOf", origin);
      if (kind === "diverged") { writeFileSync(join(f.sdk, "local.ts"), "local"); f.commit("local work"); }
      const head = git(f.repo, "rev-parse", "HEAD");
      expect(inspectSourceUpdate(f.sdk, f.target).canApply).toBe(false);
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(head);
    } finally { f.close(); }
  });

  test.each(["package", "lock"])("defers changed %s dependencies", kind => {
    const f = fixture();
    try {
      git(f.repo, "reset", "--hard", f.target);
      const path = join(f.sdk, kind === "package" ? "package.json" : "package-lock.json");
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (kind === "package") value.dependencies.example = "2.0.0";
      else value.packages["node_modules/example"].version = "2.0.0";
      json(path, value);
      const target = f.commit("dependency change");
      git(f.repo, "reset", "--hard", f.before);
      const result = inspectSourceUpdate(f.sdk, target);
      expect(result.canApply).toBe(false);
      expect(result.deferredReason).toMatch(/依赖/);
    } finally { f.close(); }
  });

  test("defers a release that would replace an ignored consumer file", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, ".gitignore"), "sdk/local-cache.txt\n");
      const before = f.commit("ignore consumer cache");
      f.version("1.0.1");
      const path = join(f.sdk, "local-cache.txt");
      writeFileSync(path, "new tracked release content");
      git(f.repo, "add", "-f", path);
      const target = f.commit("release adds a formerly ignored path");
      git(f.repo, "reset", "--hard", before);
      writeFileSync(path, "consumer ignored bytes");
      expect(git(f.repo, "status", "--porcelain")).toBe("");
      expect(inspectSourceUpdate(f.sdk, target).canApply).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("consumer ignored bytes");
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(before);
    } finally { f.close(); }
  });

  test("fetches the official tag via a temporary ref and leaves the checkout and local tags unchanged", async () => {
    const f = fixture();
    const previousSsh = process.env.GIT_SSH_COMMAND;
    const previousVariant = process.env.GIT_SSH_VARIANT;
    try {
      const remote = join(f.root, "remote.git");
      git(f.root, "clone", "--bare", f.repo, remote);
      // Keep the canonical URL validator active. Replace only the SSH transport
      // with a real local upload-pack, so this test never contacts GitHub.
      git(f.repo, "remote", "set-url", "origin", "git@github.com:CodeEagle/pocket.git");
      const ssh = join(f.root, "ssh.mjs");
      writeFileSync(ssh, `import {spawn} from 'node:child_process';
const p=spawn('git',['upload-pack',process.argv[2]],{stdio:'inherit',windowsHide:true});
p.on('error',()=>process.exit(1));p.on('close',code=>process.exit(code ?? 1));\n`);
      const quote = (value: string) => "'" + value.replaceAll("\\", "/").replaceAll("'", "'\"'\"'") + "'";
      process.env.GIT_SSH_COMMAND = [process.execPath, ssh, remote].map(quote).join(" ");
      process.env.GIT_SSH_VARIANT = "ssh";
      git(f.repo, "tag", "-d", "sdk-v1.0.1");
      expect(await fetchSourceReleaseCommit(f.sdk, "sdk-v1.0.1", { gitTimeoutMs: 10_000 })).toBe(f.target);
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.before);
      expect(git(f.repo, "tag", "--list")).toBe("");
      expect(git(f.repo, "for-each-ref", "refs/pocket-studio/source-upgrade/")).toBe("");
      await expect(fetchSourceReleaseCommit(f.sdk, "sdk-v1.0.1-beta")).rejects.toThrow();
      await expect(fetchSourceReleaseCommit(f.sdk, "sdk-v9.9.9", { gitTimeoutMs: 10_000 })).rejects.toThrow();
      expect(git(f.repo, "for-each-ref", "refs/pocket-studio/source-upgrade/")).toBe("");
    } finally {
      if (previousSsh === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = previousSsh;
      if (previousVariant === undefined) delete process.env.GIT_SSH_VARIANT;
      else process.env.GIT_SSH_VARIANT = previousVariant;
      f.close();
    }
  }, 30_000);

  test("requires Git tag, archive source commit, SDK version and tools ABI to agree", () => {
    const f = fixture();
    try {
      const stage = join(f.root, "stage");
      json(join(stage, "package.json"), { version: "1.0.1" });
      mkdirSync(join(stage, "scripts"), { recursive: true });
      writeFileSync(join(stage, "scripts", "prebuilt_tools.mjs"), constants("1.0.1"));
      const provenance = { sourceCommit: f.target, pinnedPocketJsRevision: upstream };
      const manifest = { sdkVersion: "1.0.1", bytecodeAbi: abi };
      const provenancePath = join(stage, "provenance.json");
      const manifestPath = join(stage, ".staged-tools", "darwin-arm64", "manifest.json");
      json(provenancePath, provenance);
      json(manifestPath, manifest);
      expect(validateSourceReleaseStage(f.sdk, f.target, "1.0.1", stage, "darwin", "arm64").canApply).toBe(true);
      json(provenancePath, { ...provenance, sourceCommit: f.before });
      expect(() => validateSourceReleaseStage(f.sdk, f.target, "1.0.1", stage, "darwin", "arm64")).toThrow();
      json(provenancePath, provenance);
      json(manifestPath, { ...manifest, bytecodeAbi: "wrong-abi" });
      expect(() => validateSourceReleaseStage(f.sdk, f.target, "1.0.1", stage, "darwin", "arm64")).toThrow();
      json(manifestPath, manifest);
      expect(() => validateSourceReleaseStage(f.sdk, f.target, "1.0.2", stage, "darwin", "arm64")).toThrow();
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.before);
    } finally { f.close(); }
  });

  test("reports absent or mismatched installed tools instead of claiming readiness", () => {
    const f = fixture();
    try {
      expect(validateInstalledSourceTools(f.sdk, "darwin", "arm64").ready).toBe(false);
      json(join(f.sdk, "node_modules", "@pocket", "tools-darwin-arm64", "manifest.json"), { sdkVersion: "0.9.0" });
      const result = validateInstalledSourceTools(f.sdk, "darwin", "arm64");
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/工具/);
    } finally { f.close(); }
  });
});
