// Diagnostic DrawOp coverage only; use Flutter profile for GPU timings.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  NativeSession,
  readNativeArtifacts,
  type DrawOp,
  type Frame,
  type NativeArtifacts,
} from "../tests/native_session.ts";

const width = 390;
const height = 760;
const snapshotCount = 16;
const blockSizes = [16, 32, 64, 128];

type BlockMetric = {
  blockSize: number;
  totalBlocks: number;
  changedBlocks: number;
  redrawOps: number;
  staticOpsInChangedBlocks: number;
  retainedOps: number;
  staticRetention: number;
  changedOps: number;
  changedOpRatio: number;
};

type PairRow = {
  route: string;
  source: string;
  pair: number;
  frameA: number | undefined;
  frameB: number | undefined;
  opsA: number;
  opsB: number;
  changedOps: number;
  blockMetrics: Record<string, BlockMetric>;
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

function opSignature(op: DrawOp | undefined): string {
  return op === undefined ? "<missing>" : stable(op);
}

function metricForBlockSize(a: Frame, b: Frame, blockSize: number): BlockMetric {
  const opsA = a.ops ?? [];
  const opsB = b.ops ?? [];
  const totalBlocks = Math.ceil(opsB.length / blockSize);
  let changedBlocks = 0;
  let redrawOps = 0;
  let staticOpsInChangedBlocks = 0;
  let changedOps = 0;
  for (let index = 0; index < opsB.length; index += 1) {
    if (opSignature(opsA[index]) !== opSignature(opsB[index])) changedOps += 1;
  }
  for (let start = 0; start < opsB.length; start += blockSize) {
    const end = Math.min(start + blockSize, opsB.length);
    let changed = false;
    for (let index = start; index < end; index += 1) {
      if (opSignature(opsA[index]) !== opSignature(opsB[index])) {
        changed = true;
        break;
      }
    }
    if (!changed) continue;
    changedBlocks += 1;
    redrawOps += end - start;
    for (let index = start; index < end; index += 1) {
      if (opSignature(opsA[index]) === opSignature(opsB[index])) staticOpsInChangedBlocks += 1;
    }
  }
  const retainedOps = opsB.length - redrawOps;
  return {
    blockSize,
    totalBlocks,
    changedBlocks,
    redrawOps,
    staticOpsInChangedBlocks,
    retainedOps,
    staticRetention: opsB.length === 0 ? 1 : retainedOps / opsB.length,
    changedOps,
    changedOpRatio: opsB.length === 0 ? 0 : changedOps / opsB.length,
  };
}

async function captureTransition(
  artifacts: NativeArtifacts,
  route: "mobile" | "transitions" | "home",
): Promise<{ source: string; frames: Frame[]; handshake: Record<string, unknown> }> {
  const session = new NativeSession(artifacts, { width, height, deadlineMs: 30_000 });
  try {
    const boot = await session.boot();
    const source = route === "home" ? "transitions" : "home";
    if (route === "home") {
      session.sendEvent("demo.navigate", { route: "transitions" });
      let latest = await session.frame();
      for (let index = 0; index < 20; index += 1) latest = await session.frame();
      void latest;
    }
    session.sendEvent("demo.navigate", { route });
    const frames: Frame[] = [await session.frame()];
    for (let index = 1; index < snapshotCount; index += 1) frames.push(await session.frame());
    return {
      source,
      frames,
      handshake: {
        create: true,
        loadBytecode: true,
        bootFrame: boot.frame,
        bootOps: (boot.ops ?? []).length,
        firstTransitionFrame: frames[0]?.frame,
        firstTransitionOps: (frames[0]?.ops ?? []).length,
        dimensions: `${boot.width}x${boot.height}`,
      },
    };
  } finally {
    await session.quit();
  }
}

function rowFor(route: string, source: string, pair: number, a: Frame, b: Frame): PairRow {
  const blockMetrics: Record<string, BlockMetric> = {};
  for (const blockSize of blockSizes) blockMetrics[String(blockSize)] = metricForBlockSize(a, b, blockSize);
  return {
    route,
    source,
    pair,
    frameA: a.frame,
    frameB: b.frame,
    opsA: (a.ops ?? []).length,
    opsB: (b.ops ?? []).length,
    changedOps: blockMetrics["16"].changedOps,
    blockMetrics,
  };
}

function aggregate(rows: PairRow[], blockSize: number): Record<string, unknown> {
  const metrics = rows.map((row) => row.blockMetrics[String(blockSize)]);
  const count = metrics.length || 1;
  return {
    blockSize,
    pairs: rows.length,
    meanChangedBlocks: metrics.reduce((sum, item) => sum + item.changedBlocks, 0) / count,
    meanRedrawOps: metrics.reduce((sum, item) => sum + item.redrawOps, 0) / count,
    meanStaticRetention: metrics.reduce((sum, item) => sum + item.staticRetention, 0) / count,
    maxChangedBlocks: Math.max(...metrics.map((item) => item.changedBlocks), 0),
    maxRedrawOps: Math.max(...metrics.map((item) => item.redrawOps), 0),
  };
}

const artifacts = readNativeArtifacts();
const hashes = Object.fromEntries(
  [artifacts.bytecodePath, artifacts.pakPath, artifacts.metadataPath].map((path) => [path, sha256(path)]),
);
const allRows: PairRow[] = [];
const routeResults: Record<string, unknown> = {};
for (const route of ["mobile", "transitions", "home"] as const) {
  const capture = await captureTransition(artifacts, route);
  const rows: PairRow[] = [];
  for (let index = 1; index < capture.frames.length; index += 1) {
    rows.push(rowFor(route, capture.source, index, capture.frames[index - 1]!, capture.frames[index]!));
  }
  allRows.push(...rows);
  routeResults[route] = {
    source: capture.source,
    handshake: capture.handshake,
    frames: capture.frames.map((frame) => ({ frame: frame.frame, ops: (frame.ops ?? []).length })),
    rows,
    aggregate: Object.fromEntries(blockSizes.map((size) => [String(size), aggregate(rows, size)])),
  };
}

const output = {
  generatedAt: new Date().toISOString(),
  viewport: { width, height },
  snapshotCount,
  consecutivePairs: snapshotCount - 1,
  blockSizes,
  metricDefinition: {
    changedBlock: "target-frame block has at least one op signature change at the same index; missing/added ops count as changed",
    redrawOps: "all target-frame ops covered by changed blocks (block repaint coverage, not measured GPU work)",
    staticRetention: "1 - redrawOps / target-frame ops; static ops inside changed blocks are reported separately",
    changedOps: "target-frame op signatures changed at same index; not a paint or GPU timing measurement",
  },
  artifacts,
  hashes,
  routes: routeResults,
  aggregate: Object.fromEntries(blockSizes.map((size) => [String(size), aggregate(allRows, size)])),
};
console.log(JSON.stringify(output, null, 2));
