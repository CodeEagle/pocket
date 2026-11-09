import { CubismManifestError } from "./manifest.ts";
import { CubismPhysics } from "./cubism-web/physics.ts";
import type { Live2dParameterMetadata } from "./transport.ts";

export interface CubismPhysicsSimulation {
  readonly outputParameterIds: ReadonlySet<string>;
  advance(parameters: Readonly<Record<string, number>>, deltaSeconds: number): Readonly<Record<string, number>>;
  dispose(): void;
}

/**
 * Runs Live2D's official CubismPhysics R5 solver against a JS-owned snapshot
 * of parameters. Core supplies only the real parameter IDs, ranges and
 * defaults; output IDs outside that Core set are rejected before simulation.
 */
export function createCubismPhysics3Simulation(
  input: unknown,
  parameterMetadata: readonly Live2dParameterMetadata[],
): CubismPhysicsSimulation {
  const parametersById = new Map(parameterMetadata.map((parameter, index) => [parameter.id, { ...parameter, index }]));
  const physics = CubismPhysics.create(input);
  const ids = new Set<string>();
  for (const entry of physics._physicsRig.inputs) ids.add(entry.source.id);
  for (const entry of physics._physicsRig.outputs) ids.add(entry.destination.id);
  for (const id of ids) {
    if (!parametersById.has(id)) {
      physics.release();
      throw new CubismManifestError(`physics3 parameter '${id}' is absent from Core parameter facts`);
    }
  }

  const outputParameterIds = new Set(physics._physicsRig.outputs.map((entry) => entry.destination.id));
  const values = new Float32Array(parameterMetadata.map((parameter) => parameter.defaultValue));
  const minimumValues = new Float32Array(parameterMetadata.map((parameter) => parameter.minimum));
  const maximumValues = new Float32Array(parameterMetadata.map((parameter) => parameter.maximum));
  const defaultValues = new Float32Array(parameterMetadata.map((parameter) => parameter.defaultValue));
  const modelValues = { values, minimumValues, maximumValues, defaultValues };
  const model = {
    getModel: () => ({ parameters: modelValues }),
    getParameterCount: () => parameterMetadata.length,
    getParameterIndex: (id: string) => parametersById.get(id)?.index ?? -1,
  };
  const previousPhysicsOutputs = new Map<string, number>();
  for (const id of outputParameterIds) previousPhysicsOutputs.set(id, parametersById.get(id)!.defaultValue);
  let disposed = false;

  return {
    outputParameterIds,
    advance(parameters, deltaSeconds) {
      if (disposed) throw new Error("Cubism physics simulation is disposed");
      if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError("Physics delta must be finite and non-negative");
      if (Object.values(parameters).some((value) => !Number.isFinite(value))) throw new RangeError("Physics parameters must be finite");
      for (let index = 0; index < parameterMetadata.length; index++) {
        const parameter = parameterMetadata[index]!;
        const value = parameters[parameter.id] ?? parameter.defaultValue;
        values[index] = Math.max(parameter.minimum, Math.min(parameter.maximum, value));
      }
      const boundedDelta = Math.min(deltaSeconds, 5);
      if (boundedDelta > 0) physics.evaluate(model, boundedDelta);
      else {
        for (const [id, value] of previousPhysicsOutputs) values[parametersById.get(id)!.index] = value;
      }
      for (const id of outputParameterIds) previousPhysicsOutputs.set(id, values[parametersById.get(id)!.index]!);
      const result: Record<string, number> = { ...parameters };
      for (let index = 0; index < parameterMetadata.length; index++) {
        result[parameterMetadata[index]!.id] = values[index]!;
      }
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      physics.release();
      previousPhysicsOutputs.clear();
    },
  };
}
