import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { stepMotionSpring } from "../src/motion.ts";

test("scalar motion has the same position and velocity at equal time across host rates", () => {
  const samples = [30, 60, 120].map((hz) => {
    let state = { position: 0, velocity: 0 };
    for (let frame = 0; frame < hz / 5; frame++) {
      const next = stepMotionSpring(state.position, state.velocity, 20, 1 / hz, 280);
      assert.ok(next.position > state.position && next.position < 20, "a resting non-bouncy control must approach its target monotonically");
      state = next;
    }
    return state;
  });
  for (const sample of samples.slice(1)) {
    assert.ok(Math.abs(sample.position - samples[0]!.position) < 1e-10);
    assert.ok(Math.abs(sample.velocity - samples[0]!.velocity) < 1e-10);
  }
});

test("an interrupted scalar keeps its velocity and changes direction continuously", () => {
  const moving = stepMotionSpring(0, 0, 20, 0.08, 280);
  const boundary = stepMotionSpring(moving.position, moving.velocity, 0, 0, 280);
  assert.deepEqual(boundary, moving, "retargeting must not jump the current position or reset velocity");
  const justAfter = stepMotionSpring(moving.position, moving.velocity, 0, 0.00001, 280);
  assert.ok(Math.abs(justAfter.velocity - moving.velocity) < 0.2, "a destination change must not instantaneously reverse velocity");
  assert.ok(Math.abs(justAfter.position - moving.position) < 0.002);
  const returned = stepMotionSpring(moving.position, moving.velocity, 0, 0.4, 280);
  assert.ok(returned.position < 0.01 && returned.velocity < 0, "the latest target must still win");
});
