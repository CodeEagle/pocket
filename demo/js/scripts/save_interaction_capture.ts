/** Retain the real-device integration report and optional replayable capture. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const demo = resolve(import.meta.dir, "../..");
const reportPath = resolve(process.argv[2] ?? join(demo, "build/integration_response_data.json"));
const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (!Array.isArray(report.interactionPerformance)) throw new Error("Not an interaction performance report");
const assets: Array<[string, Buffer]> = [];
if (report.recordingManifest) {
  if (report.recordingManifest.schema !== "pocket.recording.archive") throw new Error("Invalid recording manifest");
  for (const [name, encoded] of Object.entries(report.recordingAssets ?? {})) {
    if (!/^[a-f0-9]{64}\.bin$/.test(name) || typeof encoded !== "string") throw new Error("Invalid recording asset");
    const bytes = Buffer.from(encoded, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== name.slice(0, -4)) throw new Error(`Asset hash mismatch: ${name}`);
    assets.push([name, bytes]);
  }
}
const artifactRoot = join(demo, "artifacts/performance");
mkdirSync(artifactRoot, { recursive: true });
const output = process.argv[3] ? resolve(process.argv[3]) : mkdtempSync(join(artifactRoot, "interaction-"));
if (process.argv[3]) {
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output); // Each run owns a new directory; never mix it with an older tape.
}
const { recordingAssets: _assets, recordingManifest, ...metrics } = report;
writeFileSync(join(output, "performance.json"), JSON.stringify(metrics, null, 2));
if (recordingManifest) {
  mkdirSync(join(output, "assets"));
  writeFileSync(join(output, "recordings.json"), JSON.stringify(recordingManifest, null, 2));
  for (const [name, bytes] of assets) writeFileSync(join(output, "assets", name), bytes);
}
console.log(JSON.stringify({ output, scenes: report.interactionPerformance.length, assets: assets.length, replay: report.recordingReplay ?? null }));
