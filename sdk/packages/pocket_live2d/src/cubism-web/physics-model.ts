/**
 * Shape consumed by the official CubismPhysics implementation. Pocket passes
 * a JS-owned float-array snapshot with real parameter ranges captured by Core.
 */
export interface CubismPhysicsModel {
  getModel(): {
    parameters: {
      values: Float32Array;
      minimumValues: Float32Array;
      maximumValues: Float32Array;
      defaultValues: Float32Array;
    };
  };
  getParameterCount(): number;
  getParameterIndex(id: string): number;
}
