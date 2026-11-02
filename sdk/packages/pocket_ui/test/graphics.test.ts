import { strict as assert } from "node:assert";
import {
  MAX_PARTICLE_COUNT,
  POCKET_SVG_ICON_SPECS,
  compute2dParticleFrame,
  compute3dMechaFrame,
} from "../src/graphics.ts";

const frame = compute3dMechaFrame(1.25, 12, -20);
assert.equal(frame.entities.length, 6);
assert.equal(frame.drawCommands.length, 12);
assert.deepEqual(frame.entities.map((entity) => entity.entityId), [100, 101, 102, 103, 104, 105]);
assert.equal(frame.drawCommands[0]?.op, "line");
assert.equal(frame.drawCommands[1]?.op, "arc");
assert.deepEqual(compute3dMechaFrame(Number.NaN), compute3dMechaFrame(0));

const particles = compute2dParticleFrame(2, 12, 8, 4);
assert.equal(particles.length, 12);
assert.ok(particles.every((command) => command.op === "arc" && command.r > 0));
assert.deepEqual(compute2dParticleFrame(2, 12, 8, 4), particles);
assert.equal(compute2dParticleFrame(2, -4).length, 0);
assert.equal(compute2dParticleFrame(2, MAX_PARTICLE_COUNT + 1).length, MAX_PARTICLE_COUNT);

assert.deepEqual(Object.keys(POCKET_SVG_ICON_SPECS).sort(), [
  "bleRadar",
  "cameraShutter",
  "trackpadRings",
  "weatherSunCloud",
]);
assert.match(POCKET_SVG_ICON_SPECS.weatherSunCloud.svgXml, /<svg/);
assert.equal(POCKET_SVG_ICON_SPECS.bleRadar.runePoints?.length, 6);

console.log("graphics.test: source-backed deterministic draw math and SVG specs passed");
