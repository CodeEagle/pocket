import { expect, test } from "bun:test";
import {
  novelVideoInstructionIssue,
  novelVideoOverlayStateIssue,
  novelVideoSeekIssue,
} from "../src/video-schema.ts";

const overlay = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  cue: "harbor.bg-loop",
  loop: true,
  positionMs: 0,
  durationMs: 2_500,
  status: "playing",
  ...overrides,
});

test("video instructions validate action-specific fields and retain unrelated author metadata", () => {
  expect(novelVideoInstructionIssue({ type: "video", action: "play", cue: "harbor.bg-loop", loop: true, note: "wide shot" })).toBeNull();
  expect(novelVideoInstructionIssue({ type: "video", action: "play", cue: "cutscene" })).toBeNull();
  expect(novelVideoInstructionIssue({ type: "video", action: "pause" })).toBeNull();
  expect(novelVideoInstructionIssue({ type: "video", action: "close" })).toBeNull();
  expect(novelVideoInstructionIssue({ type: "video", action: "seek", positionMs: 1_200 })).toBeNull();

  expect(novelVideoInstructionIssue({ type: "video", action: "play", cue: "  " })).toContain("stable cue");
  expect(novelVideoInstructionIssue({ type: "video", action: "play", cue: "clip", loop: 1 })).toContain("loop");
  expect(novelVideoInstructionIssue({ type: "video", action: "play", cue: "clip", positionMs: 10 })).toContain("only by seek");
  expect(novelVideoInstructionIssue({ type: "video", action: "pause", cue: "clip" })).toContain("not supported");
  expect(novelVideoInstructionIssue({ type: "video", action: "seek", cue: "clip", positionMs: 10 })).toContain("not supported");
  expect(novelVideoInstructionIssue({ type: "video", action: "seek", positionMs: -1 })).toContain("safe integer");
  expect(novelVideoInstructionIssue({ type: "video", action: "seek", positionMs: 0.5 })).toContain("safe integer");
  expect(novelVideoInstructionIssue({ type: "video", action: "seek", positionMs: Number.MAX_SAFE_INTEGER + 1 })).toContain("safe integer");
  expect(novelVideoInstructionIssue({ type: "video", action: "play", cue: "clip", muted: false })).toContain("fixed");
  expect(novelVideoInstructionIssue({ type: "video", action: "play", cue: "clip", asset: "videos/clip.mp4" })).toContain("asset paths");
  expect(novelVideoInstructionIssue({ type: "video", action: "play", cue: "clip", status: "ended" })).toContain("state");
  expect(novelVideoInstructionIssue({ type: "video", action: "restart" })).toContain("action");
});

test("canonical overlay keeps one status and bounds real native time facts", () => {
  expect(novelVideoOverlayStateIssue(overlay())).toBeNull();
  expect(novelVideoOverlayStateIssue(overlay({ loop: false, status: "ended", positionMs: 2_500 }))).toBeNull();
  expect(novelVideoOverlayStateIssue(overlay({ loop: false, status: "paused", durationMs: null }))).toBeNull();

  expect(novelVideoOverlayStateIssue(overlay({ positionMs: -1 }))).toContain("positionMs");
  expect(novelVideoOverlayStateIssue(overlay({ positionMs: 1.2 }))).toContain("safe integer");
  expect(novelVideoOverlayStateIssue(overlay({ positionMs: Number.MAX_SAFE_INTEGER + 1 }))).toContain("safe integer");
  expect(novelVideoOverlayStateIssue(overlay({ durationMs: Infinity }))).toContain("durationMs");
  expect(novelVideoOverlayStateIssue(overlay({ durationMs: -1 }))).toContain("durationMs");
  expect(novelVideoOverlayStateIssue(overlay({ positionMs: 2_501 }))).toContain("must not exceed");
  expect(novelVideoOverlayStateIssue(overlay({ loop: true, status: "ended" }))).toContain("looping");
  expect(novelVideoOverlayStateIssue(overlay({ status: "loading" }))).toContain("status");
  expect(novelVideoOverlayStateIssue(overlay({ fact: "playing" }))).toContain("duplicates");
  expect(novelVideoOverlayStateIssue(overlay({ intent: "paused" }))).toContain("duplicates");
  expect(novelVideoOverlayStateIssue(overlay({ muted: true }))).toContain("fixed muted");
  expect(novelVideoOverlayStateIssue(overlay({ asset: "videos/clip.mp4" }))).toContain("asset path");
});

test("seek rejects unknown duration and out-of-range values without clamping", () => {
  expect(novelVideoSeekIssue(0, 2_500)).toBeNull();
  expect(novelVideoSeekIssue(2_500, 2_500)).toBeNull();
  expect(novelVideoSeekIssue(2_501, 2_500)).toContain("must not exceed");
  expect(novelVideoSeekIssue(1, null)).toContain("known before seeking");
  expect(novelVideoSeekIssue(-1, 2_500)).toContain("safe integer");
  expect(novelVideoSeekIssue(1.5, 2_500)).toContain("safe integer");
  expect(novelVideoSeekIssue(0, Infinity)).toContain("duration");
});
