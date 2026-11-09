import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { createCubismPhysics3Simulation } from "../src/physics.ts";
import { CubismPose3Simulation } from "../src/pose.ts";
import type { Live2dPartDefault, Live2dParameterMetadata } from "../src/transport.ts";

const reference = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/cubism-web-5-r5-dynamics-reference.json`, "utf8")) as {
  source: string;
  tag: string;
  commit: string;
  physics3: unknown;
  parameterMetadata: Live2dParameterMetadata[];
  physicsReferenceFrames: { frame: number; ParamHairFront: number }[];
  pose3: unknown;
  parts: Live2dPartDefault[];
  poseReferenceFrames: { state: string; PartArmA: number; PartArmB: number }[];
};

test("Pocket JS physics matches CubismWebFramework 5-r.5 output reference frames", () => {
  expect(reference.source).toBe("Live2D/CubismWebFramework");
  expect(reference.tag).toBe("5-r.5");
  expect(reference.commit).toBe("198a3769c26ca3d7b600e932590433badd392edd");
  const physics = createCubismPhysics3Simulation(reference.physics3, reference.parameterMetadata);
  let parameters: Readonly<Record<string, number>> = {};
  const expected = new Map(reference.physicsReferenceFrames.map((frame) => [frame.frame, frame.ParamHairFront]));
  for (let frame = 0; frame < 60; frame++) {
    parameters = physics.advance({ ...parameters, ParamAngleX: frame < 2 ? 0 : 30 }, 1 / 30);
    if (expected.has(frame)) expect(parameters.ParamHairFront).toBeCloseTo(expected.get(frame)!, 6);
  }

  const beforePause = parameters.ParamHairFront!;
  const paused = physics.advance({ ...parameters, ParamAngleX: -30 }, 0);
  expect(paused.ParamHairFront).toBe(beforePause);
  const afterBoundedHitch = physics.advance({ ...paused, ParamAngleX: 20 }, 1000);
  expect(Number.isFinite(afterBoundedHitch.ParamHairFront)).toBe(true);
  physics.dispose();
  expect(() => physics.advance(afterBoundedHitch, 1 / 30)).toThrow("disposed");
});

test("Pocket JS pose matches CubismPose reset and fade reference frames", () => {
  const pose = new CubismPose3Simulation(reference.pose3, reference.parts, []);
  const first = pose.update({}, {}, new Set(), 0);
  const half = pose.update({}, { PartArmA: 0, PartArmB: 1 }, new Set(["PartArmA", "PartArmB"]), 0.25);
  const complete = pose.update({}, { PartArmA: 0, PartArmB: 1 }, new Set(["PartArmA", "PartArmB"]), 0.25);
  const actual = [first, half, complete].map((frame, index) => ({
    state: reference.poseReferenceFrames[index]!.state,
    PartArmA: frame.partOpacities.PartArmA,
    PartArmB: frame.partOpacities.PartArmB,
  }));
  for (let index = 0; index < actual.length; index++) {
    expect(actual[index]!.state).toBe(reference.poseReferenceFrames[index]!.state);
    expect(actual[index]!.PartArmA).toBeCloseTo(reference.poseReferenceFrames[index]!.PartArmA, 6);
    expect(actual[index]!.PartArmB).toBeCloseTo(reference.poseReferenceFrames[index]!.PartArmB, 6);
  }
  expect(half.parameters).toEqual({}); // PartOpacity curves remain virtual pose parameters.
  pose.dispose();
  expect(() => pose.update({}, {}, new Set(), 0)).toThrow("disposed");
});

test("physics rejects unknown Core IDs and inconsistent exported counts", () => {
  expect(() => createCubismPhysics3Simulation(reference.physics3, [])).toThrow("absent from Core parameter facts");
  const invalid = JSON.parse(JSON.stringify(reference.physics3)) as { Meta: { TotalInputCount: number } };
  invalid.Meta.TotalInputCount++;
  expect(() => createCubismPhysics3Simulation(invalid, reference.parameterMetadata)).toThrow("TotalInputCount does not match");
});
