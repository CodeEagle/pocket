import { test as bunTest } from "bun:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function test(name: string, fn: () => void): void {
  try {
    bunTest(name, fn);
  } catch {
    fn();
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Video Lab keeps the real Video API and local MP4 assets source-visible", () => {
  const source = readFileSync(join(root, "video-page.tsx"), "utf8");
  assert.match(source, /export function VideoPage/);
  assert.match(source, /host: HostBridge/);
  assert.match(source, /platform: VideoPagePlatform/);
  assert.match(source, /onNavigate: \(route: Route\)/);
  assert.match(source, /Video\n\s+id=\{props\.id\}/);
  assert.match(source, /media=\{props\.media\}/);
  assert.match(source, /assets\/videos\/clip-a\.mp4/);
  assert.match(source, /assets\/videos\/clip-b\.mp4/);
  assert.match(source, /missing-video\.mp4/);
  assert.match(source, /platform\.openApp\("pocket\.demo\.profile"/);
  assert.match(readFileSync(join(root, "app.tsx"), "utf8"), /"Video Lab"/);
  assert.match(source, /const HERO_ID = "video-lab-hero"/);
  assert.match(source, /nativeLabelFor\(HERO_ID\)/);
  assert.match(source, /Native controllers ·/);
  assert.match(source, /label="Inspect native state"/);
  assert.match(source, /host\.emit\?\.\("video\.inspect"/);
  assert.match(source, /label="Cover fit"/);
  assert.match(source, /label="Contain fit"/);
  assert.match(source, /label="Fill fit"/);
});
test("Video Lab uses a reusable intent model and explicit teardown", () => {
  const source = readFileSync(join(root, "video-page.tsx"), "utf8");
  assert.match(source, /const intentModel = new Map/);
  assert.match(source, /export function videoLabIntent/);
  assert.match(source, /export function resetVideoLabModel/);
  assert.match(source, /onCleanup\(\(\) => removeHostEvent/);
  assert.match(source, /rememberIntent\(SWAP_ID, false\)/);
  assert.match(source, /setShowHero\(false\)/);
  assert.match(source, /setShowHero\(true\)/);
});

test("Video Lab separates expected policy from native observation and bounds its log", () => {
  const source = readFileSync(join(root, "video-page.tsx"), "utf8");
  assert.match(source, /Expected policy state/);
  assert.match(source, /Native video\.state/);
  assert.match(source, /unknown \(host snapshot not observed\)/);
  assert.match(source, /video\.snapshot/);
  assert.match(source, /Supported: bundled local MP4 assets/);
  assert.match(source, /Not exposed: seek\/progress, volume/);
  assert.match(source, /Resize \/ Duo \/ BoxFit/);
  assert.match(source, /Background \/ foreground/);
  assert.match(source, /nativeLabelFor\(FEED_A_ID\)/);
  assert.match(source, /nativeLabelFor\(FEED_B_ID\)/);
  assert.match(source, /nativeLabelFor\(SWAP_ID\)/);
  assert.match(source, /nativeLabelFor\(RETRY_ID\)/);
  assert.match(source, /nativeLabelFor\(SCROLL_ID\)/);
  assert.match(source, /const RECENT_LIMIT = 8/);
  assert.match(source, /items\.slice\(-\(RECENT_LIMIT - 1\)\)/);
  assert.match(source, /no polling loop/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /setTimeout\s*\(/);
  assert.doesNotMatch(source, /requestAnimationFrame\s*\(/);
  assert.doesNotMatch(source, /fake|synthetic|counter/i);
});
