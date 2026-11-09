import { CubismManifestError } from "./manifest.ts";

export type CubismMotionTarget = "Parameter" | "PartOpacity" | "Model";
export type CubismMotionModelProperty = "EyeBlink" | "LipSync" | "Opacity";
export type CubismExpressionBlend = "Add" | "Multiply" | "Overwrite";

export interface CubismMotionCurve {
  readonly target: CubismMotionTarget;
  readonly id: string;
  readonly fadeInTime?: number;
  readonly fadeOutTime?: number;
  readonly segments: readonly number[];
}

export interface CubismMotion3 {
  readonly duration: number;
  readonly fps: number;
  readonly loop: boolean;
  readonly fadeInTime: number;
  readonly fadeOutTime: number;
  readonly areBeziersRestricted: boolean;
  readonly curves: readonly CubismMotionCurve[];
}

export interface CubismExpressionParameter {
  readonly id: string;
  readonly value: number;
  readonly blend: CubismExpressionBlend;
}

export interface CubismExpression3 {
  readonly fadeInTime: number;
  readonly fadeOutTime: number;
  readonly parameters: readonly CubismExpressionParameter[];
}

export interface CubismMotionFrame {
  readonly parameters: Readonly<Record<string, number>>;
  readonly partOpacities: Readonly<Record<string, number>>;
  /** Motion-owned Model target facts. The caller decides how group semantics apply. */
  readonly modelValues: Readonly<Partial<Record<CubismMotionModelProperty, number>>>;
}

export function parseCubismMotion3(input: unknown): CubismMotion3 {
  const document = typeof input === "string" ? parseJson(input, "motion3") : input;
  const root = object(document, "motion3");
  if (root.Version !== 3) throw new CubismManifestError("motion3.Version must be 3");
  const meta = object(root.Meta, "motion3.Meta");
  const duration = nonNegativeNumber(meta.Duration, "motion3.Meta.Duration");
  const fps = positiveNumber(meta.Fps, "motion3.Meta.Fps");
  const loop = meta.Loop;
  const restricted = meta.AreBeziersRestricted;
  if (typeof loop !== "boolean" || typeof restricted !== "boolean") {
    throw new CubismManifestError("motion3.Meta.Loop and AreBeziersRestricted must be booleans");
  }
  if (!Array.isArray(root.Curves)) throw new CubismManifestError("motion3.Curves must be an array");
  const curves = root.Curves.map((rawCurve, index): CubismMotionCurve => {
    const path = `motion3.Curves[${index}]`;
    const curve = object(rawCurve, path);
    if (curve.Target !== "Parameter" && curve.Target !== "PartOpacity" && curve.Target !== "Model") {
      throw new CubismManifestError(`${path}.Target must be Parameter, PartOpacity or Model`);
    }
    const id = nonEmptyString(curve.Id, `${path}.Id`);
    if (curve.Target === "Model" && !isModelProperty(id)) {
      throw new CubismManifestError(`${path}.Id is an unsupported Model target`);
    }
    if (!Array.isArray(curve.Segments) || curve.Segments.length < 2) {
      throw new CubismManifestError(`${path}.Segments must contain initial time and value`);
    }
    const segments = curve.Segments.map((entry, segmentIndex) => {
      if (typeof entry !== "number" || !Number.isFinite(entry)) throw new CubismManifestError(`${path}.Segments[${segmentIndex}] must be finite`);
      return entry;
    });
    validateSegments(segments, path);
    return {
      target: curve.Target,
      id,
      ...(curve.FadeInTime === undefined ? {} : { fadeInTime: nonNegativeNumber(curve.FadeInTime, `${path}.FadeInTime`) }),
      ...(curve.FadeOutTime === undefined ? {} : { fadeOutTime: nonNegativeNumber(curve.FadeOutTime, `${path}.FadeOutTime`) }),
      segments,
    };
  });
  return {
    duration,
    fps,
    loop,
    fadeInTime: meta.FadeInTime === undefined ? 0 : nonNegativeNumber(meta.FadeInTime, "motion3.Meta.FadeInTime"),
    fadeOutTime: meta.FadeOutTime === undefined ? 0 : nonNegativeNumber(meta.FadeOutTime, "motion3.Meta.FadeOutTime"),
    areBeziersRestricted: restricted,
    curves,
  };
}

export function parseCubismExpression3(input: unknown): CubismExpression3 {
  const document = typeof input === "string" ? parseJson(input, "expression3") : input;
  const root = object(document, "expression3");
  if (root.Type !== "Live2D Expression") throw new CubismManifestError("expression3.Type must be Live2D Expression");
  if (!Array.isArray(root.Parameters)) throw new CubismManifestError("expression3.Parameters must be an array");
  const parameters = root.Parameters.map((rawParameter, index): CubismExpressionParameter => {
    const path = `expression3.Parameters[${index}]`;
    const parameter = object(rawParameter, path);
    const blend = parameter.Blend ?? "Add";
    if (blend !== "Add" && blend !== "Multiply" && blend !== "Overwrite") {
      throw new CubismManifestError(`${path}.Blend is unsupported`);
    }
    return {
      id: nonEmptyString(parameter.Id, `${path}.Id`),
      value: finiteNumber(parameter.Value, `${path}.Value`),
      blend,
    };
  });
  return {
    fadeInTime: root.FadeInTime === undefined ? 0 : nonNegativeNumber(root.FadeInTime, "expression3.FadeInTime"),
    fadeOutTime: root.FadeOutTime === undefined ? 0 : nonNegativeNumber(root.FadeOutTime, "expression3.FadeOutTime"),
    parameters,
  };
}

/** Evaluates Cubism's serialized linear, Bezier, stepped and inverse-stepped segments. */
export function evaluateCubismMotion3(motion: CubismMotion3, seconds: number): CubismMotionFrame {
  if (!Number.isFinite(seconds)) throw new RangeError("Motion time must be finite");
  const time = motion.loop && motion.duration > 0
    ? ((seconds % motion.duration) + motion.duration) % motion.duration
    : Math.max(0, Math.min(motion.duration, seconds));
  const parameters: Record<string, number> = {};
  const partOpacities: Record<string, number> = {};
  const modelValues: Partial<Record<CubismMotionModelProperty, number>> = {};
  for (const curve of motion.curves) {
    const result = evaluateSegments(curve.segments, time);
    if (curve.target === "Parameter") parameters[curve.id] = result;
    else if (curve.target === "PartOpacity") partOpacities[curve.id] = result;
    else if (isModelProperty(curve.id)) modelValues[curve.id] = result;
  }
  return { parameters, partOpacities, modelValues };
}

function isModelProperty(value: string): value is CubismMotionModelProperty {
  return value === "EyeBlink" || value === "LipSync" || value === "Opacity";
}

/** Applies one already-selected expression to existing values with a crossfade weight. */
export function applyCubismExpression3(
  base: Readonly<Record<string, number>>,
  expression: CubismExpression3,
  weight = 1,
): Readonly<Record<string, number>> {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError("Expression weight must be between zero and one");
  const result: Record<string, number> = { ...base };
  for (const parameter of expression.parameters) {
    const current = result[parameter.id] ?? 0;
    switch (parameter.blend) {
      case "Add": result[parameter.id] = current + parameter.value * weight; break;
      case "Multiply": result[parameter.id] = current * (1 + (parameter.value - 1) * weight); break;
      case "Overwrite": result[parameter.id] = current * (1 - weight) + parameter.value * weight; break;
    }
  }
  return result;
}

function evaluateSegments(segments: readonly number[], time: number): number {
  let startTime = segments[0]!;
  let startValue = segments[1]!;
  if (time <= startTime) return startValue;
  for (let offset = 2; offset < segments.length;) {
    const type = segments[offset]!;
    if (type === 1) {
      const control1Time = segments[offset + 1]!;
      const control1Value = segments[offset + 2]!;
      const control2Time = segments[offset + 3]!;
      const control2Value = segments[offset + 4]!;
      const endTime = segments[offset + 5]!;
      const endValue = segments[offset + 6]!;
      if (time <= endTime) return cubicBezierValue(startTime, startValue, control1Time, control1Value, control2Time, control2Value, endTime, endValue, time);
      startTime = endTime;
      startValue = endValue;
      offset += 7;
      continue;
    }
    const endTime = segments[offset + 1]!;
    const endValue = segments[offset + 2]!;
    if (time <= endTime) {
      if (type === 0) return interpolate(startTime, startValue, endTime, endValue, time);
      if (type === 2) return startValue;
      if (type === 3) return endValue;
      throw new CubismManifestError(`Unknown Cubism motion segment type ${type}`);
    }
    startTime = endTime;
    startValue = endValue;
    offset += 3;
  }
  return startValue;
}

function cubicBezierValue(
  startTime: number, startValue: number,
  control1Time: number, control1Value: number,
  control2Time: number, control2Value: number,
  endTime: number, endValue: number,
  time: number,
): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 40; iteration++) {
    const t = (low + high) / 2;
    if (cubic(startTime, control1Time, control2Time, endTime, t) < time) low = t;
    else high = t;
  }
  return cubic(startValue, control1Value, control2Value, endValue, (low + high) / 2);
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const inverse = 1 - t;
  return inverse * inverse * inverse * a + 3 * inverse * inverse * t * b + 3 * inverse * t * t * c + t * t * t * d;
}

function interpolate(startTime: number, startValue: number, endTime: number, endValue: number, time: number): number {
  if (endTime <= startTime) return endValue;
  const weight = Math.max(0, Math.min(1, (time - startTime) / (endTime - startTime)));
  return startValue + (endValue - startValue) * weight;
}

function validateSegments(segments: readonly number[], path: string): void {
  let offset = 2;
  let previousTime = segments[0]!;
  while (offset < segments.length) {
    const type = segments[offset]!;
    if (!Number.isInteger(type) || type < 0 || type > 3) throw new CubismManifestError(`${path}.Segments has an unknown segment kind`);
    const size = type === 1 ? 7 : 3;
    if (offset + size > segments.length) throw new CubismManifestError(`${path}.Segments ends in an incomplete segment`);
    const endTime = segments[offset + (type === 1 ? 5 : 1)]!;
    if (endTime < previousTime) throw new CubismManifestError(`${path}.Segments times must be monotonic`);
    previousTime = endTime;
    offset += size;
  }
  if (offset !== segments.length) throw new CubismManifestError(`${path}.Segments contains trailing values`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CubismManifestError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new CubismManifestError(`${path} must be a non-empty string`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CubismManifestError(`${path} must be finite`);
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (number < 0) throw new CubismManifestError(`${path} must be non-negative`);
  return number;
}

function positiveNumber(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (number <= 0) throw new CubismManifestError(`${path} must be positive`);
  return number;
}

function parseJson(input: string, label: string): unknown {
  try { return JSON.parse(input) as unknown; }
  catch (error) { throw new CubismManifestError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
