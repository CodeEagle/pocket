import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachBrowserErrorCollector,
  createDiagnosticsCollector,
  createKeyValueDiagnosticsStorage,
  createMemoryDiagnosticsStorage,
  normalizeDiagnosticData,
  normalizeDiagnosticError,
  type DiagnosticCrashRecord,
  type DiagnosticRecord,
  type DiagnosticsStorage,
} from "../src/index.ts";
import {
  createFileDiagnostics,
  createFileDiagnosticsStorage,
} from "../src/node.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pocket-diagnostics-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("@pocket/diagnostics portable core & normalization", () => {
  test("portable core files do not import node: or bun: built-in modules", async () => {
    const coreFiles = ["types.ts", "normalize.ts", "collector.ts", "browser.ts", "index.ts"];
    for (const file of coreFiles) {
      const content = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(content).not.toMatch(/from\s+["'](?:node:|bun:)/);
      expect(content).not.toMatch(/require\(["'](?:node:|bun:|fs|path|crypto)/);
    }
  });

  test("normalizes errors with nested causes, circular causes, cyclic properties, and throwing getters", () => {
    const rootCause = new Error("low-level socket reset") as Error & { code?: string };
    rootCause.code = "ECONNRESET";
    const midError = new Error("transport disconnected", { cause: rootCause });
    const topError = new TypeError("preview session failed", { cause: midError }) as Error & Record<string, unknown>;

    // Introduce circular cause loop and self-referencing metadata
    (rootCause as unknown as { cause: unknown }).cause = topError;
    const cyclicMeta: Record<string, unknown> = { stage: "tick", count: 42n };
    cyclicMeta.self = cyclicMeta;
    Object.defineProperty(cyclicMeta, "explosive", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    topError.meta = cyclicMeta;

    const normalized = normalizeDiagnosticError(topError);
    expect(normalized.name).toBe("TypeError");
    expect(normalized.message).toBe("preview session failed");
    expect(typeof normalized.stack).toBe("string");
    expect(normalized.cause?.message).toBe("transport disconnected");
    expect(normalized.cause?.cause?.message).toBe("low-level socket reset");
    expect(normalized.cause?.cause?.code).toBe("ECONNRESET");
    expect(normalized.cause?.cause?.cause?.name).toBe("CircularError");
    expect(normalized.cause?.cause?.cause?.message).toBe("[Circular Error Cause]");

    const details = normalized.details as Record<string, unknown>;
    expect(details).toBeDefined();
    const meta = details.meta as Record<string, unknown>;
    expect(meta.stage).toBe("tick");
    expect(meta.count).toBe("42n");
    expect(meta.self).toBe("[Circular]");
    expect(String(meta.explosive)).toContain("[Thrown: getter boom]");

    // Must be cleanly JSON-serializable
    const roundTrip = JSON.parse(JSON.stringify(normalized));
    expect(roundTrip.name).toBe("TypeError");
  });

  test("enforces data bounds (depth, array length, string length, byte budget)", () => {
    const hugeString = "x".repeat(10_000);
    const manyItems = Array.from({ length: 200 }, (_, i) => i);
    const normalized = normalizeDiagnosticData(
      {
        hugeString,
        manyItems,
        nanValue: Number.NaN,
        infValue: Number.POSITIVE_INFINITY,
        binary: new Uint8Array([1, 2, 3, 4]),
      },
      {
        maxStringLength: 120,
        maxArrayLength: 10,
        maxDataBytes: 2048,
      },
    ) as Record<string, unknown>;

    expect(typeof normalized.hugeString).toBe("string");
    expect((normalized.hugeString as string).length).toBeLessThanOrEqual(120);
    expect((normalized.hugeString as string)).toContain("[truncated");
    expect(Array.isArray(normalized.manyItems)).toBe(true);
    expect((normalized.manyItems as unknown[]).length).toBe(11); // 10 items + truncation marker
    expect(normalized.nanValue).toBe("NaN");
    expect(normalized.infValue).toBe("Infinity");
    expect(normalized.binary).toBe("[Uint8Array(4 bytes)]");
  });

  test("supports consumer-provided custom storage and query/export/clear operations", async () => {
    const customRecords: DiagnosticRecord[] = [];
    let flushes = 0;
    const customStorage: DiagnosticsStorage = {
      preservesLogHistory: false, // Test summary capture when storage does not preserve full log journal
      append(rec) {
        customRecords.push(rec);
      },
      readAll() {
        return [...customRecords];
      },
      clear() {
        const count = customRecords.length;
        customRecords.length = 0;
        return count;
      },
      flush() {
        flushes += 1;
      },
    };

    const diag = createDiagnosticsCollector({
      storage: customStorage,
      context: {
        source: "studio-server",
        projectId: "lantern",
        sessionId: "sess-1",
        revision: 7,
      },
      recentLogLimit: 3,
    });

    await diag.recordLog({ severity: "debug", tag: "boot", message: "step 1" });
    await diag.recordLog({ severity: "info", tag: "build", message: "step 2" });
    await diag.recordLog({ severity: "warn", tag: "build", message: "step 3" });
    await diag.recordLog({ severity: "info", tag: "build", message: "step 4" });

    const crash = await diag.recordCrash(new Error("compiler panic"), {
      runtimeId: "rt-main",
      unhandled: true,
      data: { exitCode: 134 },
    });

    expect(flushes).toBe(1);
    expect(crash.kind).toBe("crash");
    expect(crash.projectId).toBe("lantern");
    expect(crash.sessionId).toBe("sess-1");
    expect(crash.runtimeId).toBe("rt-main");
    expect(crash.revision).toBe(7);
    expect(crash.unhandled).toBe(true);
    // Because preservesLogHistory is false, crash carries recentLogs summaries directly
    expect(crash.recentLogs?.map((l) => l.message)).toEqual(["step 2", "step 3", "step 4"]);
    expect(crash.recentLogIds).toBeUndefined();

    const warningsAndAbove = await diag.list({ minSeverity: "warn" });
    expect(warningsAndAbove.length).toBe(2);

    const exported = await diag.exportRecords();
    expect(exported.format).toBe("pocket-diagnostics-export");
    expect(exported.totalRecords).toBe(5);
    expect(exported.logCount).toBe(4);
    expect(exported.crashCount).toBe(1);

    const cleared = await diag.clear();
    expect(cleared).toBe(5);
    expect((await diag.list()).length).toBe(0);
  });

  test("supports Web Storage / KeyValueDiagnosticsStorage adapter with bounds", async () => {
    const map = new Map<string, string>();
    const kvStorage = createKeyValueDiagnosticsStorage({
      storage: {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => { map.set(k, v); },
        removeItem: (k) => { map.delete(k); },
      },
      maxRecords: 3,
    });

    const diag = createDiagnosticsCollector({ storage: kvStorage });
    await diag.recordLog("log 1");
    await diag.recordLog("log 2");
    await diag.recordLog("log 3");
    await diag.recordLog("log 4");

    const listed = await diag.list();
    expect(listed.map((r) => r.message)).toEqual(["log 2", "log 3", "log 4"]);
  });

  test("opt-in browser error and unhandledrejection collector attaches and detaches cleanly without swallowing", async () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const fakeWindow = {
      addEventListener(type: string, fn: (event: unknown) => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: (event: unknown) => void) {
        listeners.get(type)?.delete(fn);
      },
    };

    const diag = createDiagnosticsCollector({
      storage: createMemoryDiagnosticsStorage(),
      context: { projectId: "web-preview" },
    });

    const recorded: DiagnosticCrashRecord[] = [];
    const handle = attachBrowserErrorCollector({
      collector: diag,
      target: fakeWindow,
      onCrashRecorded: (rec) => recorded.push(rec),
    });

    expect(handle.active).toBe(true);

    let defaultPrevented = false;
    for (const fn of listeners.get("error") ?? []) {
      fn({
        message: "Uncaught ReferenceError: foo is not defined",
        filename: "app.js",
        lineno: 14,
        colno: 5,
        error: new ReferenceError("foo is not defined"),
        preventDefault() {
          defaultPrevented = true;
        },
      });
    }

    for (const fn of listeners.get("unhandledrejection") ?? []) {
      fn({
        reason: new Error("async effect failed"),
        preventDefault() {
          defaultPrevented = true;
        },
      });
    }

    await diag.flush();
    const crashes = await diag.listCrashes();
    expect(crashes.length).toBe(2);
    expect(defaultPrevented).toBe(false);
    expect(crashes[0]!.error.name).toBe("ReferenceError");
    expect(crashes[0]!.data).toEqual({ filename: "app.js", lineno: 14, colno: 5 });
    expect(crashes[1]!.error.message).toBe("async effect failed");
    expect(recorded.length).toBe(2);

    handle.detach();
    expect(handle.active).toBe(false);
    expect(listeners.get("error")?.size ?? 0).toBe(0);
    expect(listeners.get("unhandledrejection")?.size ?? 0).toBe(0);
  });
});

describe("@pocket/diagnostics/node durable file persistence", () => {
  test("persists logs and crash records to disk and retains them across reopen", async () => {
    const dir = await makeTempDir();

    const first = createFileDiagnostics({
      directory: dir,
      context: {
        source: "editor",
        projectId: "showcase",
        sessionId: "s-100",
        revision: 12,
      },
      recentLogLimit: 5,
    });

    const log1 = await first.recordLog({
      severity: "info",
      tag: "build",
      message: "build started: revision 12",
    });
    const log2 = await first.recordLog({
      severity: "warn",
      tag: "preview",
      message: "slow frame 29.4ms",
      durationMs: 29.4,
    });
    const crash = await first.recordCrash(new Error("QuickJS realm out of memory"), {
      runtimeId: "guest-root",
      data: { heapBytes: 67108864 },
    });

    // Since file journal preservesLogHistory = true, crash stores lightweight recentLogIds
    expect(crash.recentLogIds).toEqual([log1.id, log2.id]);
    expect(crash.recentLogs).toBeUndefined();

    await first.close();

    // Reopen a brand new instance against the same directory
    const reopened = createFileDiagnostics({
      directory: dir,
    });

    const all = await reopened.list();
    expect(all.length).toBe(3);
    expect(all[0]!.id).toBe(log1.id);
    expect(all[1]!.id).toBe(log2.id);
    expect(all[2]!.id).toBe(crash.id);

    const crashes = await reopened.listCrashes();
    expect(crashes.length).toBe(1);
    expect(crashes[0]!.error.message).toBe("QuickJS realm out of memory");
    expect(crashes[0]!.projectId).toBe("showcase");
    expect(crashes[0]!.runtimeId).toBe("guest-root");

    // Resolve full recent log records from the journal for the crash
    const recentLogs = await reopened.getCrashRecentLogs(crashes[0]!.id);
    expect(recentLogs.map((l) => l.message)).toEqual([
      "build started: revision 12",
      "slow frame 29.4ms",
    ]);

    await reopened.close();
  });

  test("serializes concurrent writes without corrupting JSONL lines", async () => {
    const dir = await makeTempDir();
    const diag = createFileDiagnostics({
      directory: dir,
      maxRecords: 200,
      maxFileBytes: 1024 * 1024,
    });

    const writes: Promise<DiagnosticRecord>[] = [];
    for (let i = 0; i < 60; i += 1) {
      if (i % 15 === 14) {
        writes.push(
          diag.recordCrash(new Error(`crash-${i}`), {
            revision: i,
            data: { index: i },
          }),
        );
      } else {
        writes.push(
          diag.recordLog({
            severity: "info",
            message: `concurrent-log-${i}`,
            revision: i,
            data: { index: i, pad: "a".repeat(64) },
          }),
        );
      }
    }

    await Promise.all(writes);
    await diag.close();

    const reopened = createFileDiagnostics({ directory: dir, maxRecords: 200 });
    const records = await reopened.list();
    expect(records.length).toBe(60);
    expect(records.map((r) => r.revision)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect(records.filter((r) => r.kind === "crash").length).toBe(4);
    await reopened.close();
  });

  test("recovers cleanly from a partial/truncated final write on reopen", async () => {
    const dir = await makeTempDir();
    const diag = createFileDiagnostics({ directory: dir });

    await diag.recordLog({ message: "valid log before abrupt kill" });
    await diag.recordCrash(new Error("persisted crash before abrupt kill"));
    const journalPath = diag.journalPath;
    await diag.close();

    // Simulate an interrupted write (e.g. process killed mid-write without trailing newline)
    await appendFile(
      journalPath,
      '{"schemaVersion":1,"id":"broken","kind":"log","timestamp":"2026-11-11T00:00:00.000Z","message":"truncat',
      "utf8",
    );

    const reopened = createFileDiagnostics({ directory: dir });
    const records = await reopened.list();
    expect(records.length).toBe(2);
    expect(records[0]!.message).toBe("valid log before abrupt kill");
    expect(records[1]!.kind).toBe("crash");
    expect(reopened.storage.recoveredPartialLines).toBe(1);

    // Subsequent writes append cleanly after the healed journal
    await reopened.recordLog({ message: "log after recovery" });
    const afterRecovery = await reopened.list();
    expect(afterRecovery.length).toBe(3);
    expect(afterRecovery[2]!.message).toBe("log after recovery");
    await reopened.close();

    // Verify raw file on disk now has 3 valid JSONL lines
    const rawLines = (await readFile(journalPath, "utf8")).trim().split("\n");
    expect(rawLines.length).toBe(3);
    for (const line of rawLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("enforces file size rotation and maxRecords retention limits", async () => {
    const dir = await makeTempDir();
    const diag = createFileDiagnostics({
      directory: dir,
      maxFileBytes: 1500, // Small segment size to force multiple rotations
      maxRotatedFiles: 2,
      maxRecords: 12,
    });

    for (let i = 1; i <= 30; i += 1) {
      await diag.recordLog({
        message: `entry-${i}`,
        data: { index: i, payload: "p".repeat(120) },
      });
    }
    await diag.close();

    const files = await readdir(dir);
    // Should only have diagnostics.jsonl and at most .1, .2
    for (const file of files) {
      expect(["diagnostics.jsonl", "diagnostics.jsonl.1", "diagnostics.jsonl.2"]).toContain(file);
    }

    const reopened = createFileDiagnostics({
      directory: dir,
      maxFileBytes: 1500,
      maxRotatedFiles: 2,
      maxRecords: 12,
    });
    const retained = await reopened.list();
    expect(retained.length).toBeLessThanOrEqual(12);
    expect(retained.length).toBeGreaterThan(0);
    // Newest entries must be preserved
    expect(retained[retained.length - 1]!.message).toBe("entry-30");
    await reopened.close();
  });

  test("supports selective clear(filter) on file storage", async () => {
    const dir = await makeTempDir();
    const diag = createFileDiagnostics({ directory: dir });

    await diag.recordLog({ projectId: "alpha", message: "alpha log" });
    await diag.recordCrash(new Error("alpha crash"), { projectId: "alpha" });
    await diag.recordLog({ projectId: "beta", message: "beta log" });
    await diag.recordCrash(new Error("beta crash"), { projectId: "beta" });

    // Clear only project "alpha"
    const removed = await diag.clear({ projectId: "alpha" });
    expect(removed).toBe(2);

    const remaining = await diag.list();
    expect(remaining.length).toBe(2);
    expect(remaining.every((r) => r.projectId === "beta")).toBe(true);
    await diag.close();
  });

  test("rejects symbolic link journal paths", async () => {
    const dir = await makeTempDir();
    const targetFile = join(dir, "outside.txt");
    await writeFile(targetFile, "", "utf8");
    const journalLink = join(dir, "diagnostics.jsonl");
    await symlink(targetFile, journalLink);

    const storage = createFileDiagnosticsStorage({ directory: dir });
    await expect(storage.readAll()).rejects.toThrow(/not a regular file/);
  });
});
