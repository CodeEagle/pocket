import { expect, test } from "bun:test";
import { createNovelChoiceSurfaceLayout, isNovelChoiceSurface, novelChoiceSurfaceIssue, type NovelChoiceSurfaceOption } from "../src/choice-surface.ts";

const sceneSurface = {
  kind: "scene" as const,
  frame: { x: 0.1, y: 0.2, w: 0.8, h: 0.5 },
  targets: {
    archive: { x: 0.2, y: 0.25, w: 0.2, h: 0.2 },
    clock: { x: 0.6, y: 0.25, w: 0.2, h: 0.2 },
    roof: { x: 0.4, y: 0.6, w: 0.2, h: 0.2 },
  },
};

const dialSurface = {
  kind: "dial" as const,
  image: "art/relay-dial.png",
  frame: { x: 0.2, y: 0.1, w: 0.6, h: 0.5 },
  targets: {
    route_7: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    route_1: { x: 0.05, y: 0.25, w: 0.3, h: 0.5 },
    route_4: { x: 0.65, y: 0.25, w: 0.3, h: 0.5 },
  },
};

const options: NovelChoiceSurfaceOption[] = [
  { id: "archive", text: "Check the archive" },
  { id: "clock", text: "Check the clock" },
];

test("choice-surface schema accepts scene and dial presentations and rejects malformed geometry or paths", () => {
  expect(isNovelChoiceSurface(sceneSurface)).toBe(true);
  expect(isNovelChoiceSurface({ kind: "scene", targets: { archive: { x: 0, y: 0, w: 1, h: 1 } } })).toBe(true);
  expect(isNovelChoiceSurface(dialSurface)).toBe(true);
  expect(novelChoiceSurfaceIssue({ ...sceneSurface, unsupported: true })).toContain("unknown fields");
  expect(novelChoiceSurfaceIssue({ ...sceneSurface, frame: { x: 0, y: 0, w: 0.5, h: 1.1 } })).toContain("normalized rectangle");
  expect(novelChoiceSurfaceIssue({ ...sceneSurface, targets: { archive: { x: 0.8, y: 0, w: 0.4, h: 0.2 } } })).toContain("normalized rectangles");
  expect(novelChoiceSurfaceIssue({ ...dialSurface, image: "../outside.png" })).toContain("project-relative");
  expect(novelChoiceSurfaceIssue({ ...dialSurface, image: "art/dial.gif" })).toContain("project-relative");
  expect(novelChoiceSurfaceIssue({ ...dialSurface, frame: undefined })).toContain("frame");
});

test("scene targets resolve in stable option order inside their normalized frame", () => {
  const layout = createNovelChoiceSurfaceLayout(sceneSurface, options, 360, 640)!;
  expect(layout).toMatchObject({ width: 360, height: 640 });
  expect(layout.image).toBeUndefined();
  expect(layout.targets.map(target => target.option.id)).toEqual(["archive", "clock"]);
  expect(layout.targets[0]).toMatchObject({
    x: 93.6,
    y: 208,
    width: 57.6,
    height: 64,
    displayCaption: "Check the archive",
    option: options[0],
  });
  expect(layout.targets[1]?.displayCaption).toBe("Check the clock");
});

test("dial image contain bounds and targets use that same visual content frame", () => {
  const dialOptions: NovelChoiceSurfaceOption[] = [
    { id: "route_7", text: "Route 7" },
    { id: "route_1", text: "Route 1" },
  ];
  const layout = createNovelChoiceSurfaceLayout(dialSurface, dialOptions, 360, 640, { width: 512, height: 256 })!;
  expect(layout.image).toEqual({ src: "art/relay-dial.png", x: 72, y: 170, width: 216, height: 108 });
  expect(layout.targets[0]).toMatchObject({ x: 126, y: 197, width: 108, height: 54, displayCaption: "Route 7" });
  expect(layout.targets[1]?.option.id).toBe("route_1");
});

test("missing current option targets and undersized touch regions request the original list fallback", () => {
  const onlyArchive = [{ id: "archive", text: "Archive" }];
  expect(createNovelChoiceSurfaceLayout(sceneSurface, [...onlyArchive, { id: "relay", text: "Relay" }], 360, 640)).toBeNull();
  const small = { kind: "scene" as const, targets: { archive: { x: 0, y: 0, w: 0.1, h: 0.2 } } };
  expect(createNovelChoiceSurfaceLayout(small, onlyArchive, 320, 640)).toBeNull();
  expect(createNovelChoiceSurfaceLayout(sceneSurface, options, 0, 640)).toBeNull();
  expect(createNovelChoiceSurfaceLayout(sceneSurface, [], 360, 640)).toBeNull();
});
