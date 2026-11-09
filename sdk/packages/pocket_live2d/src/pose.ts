import { CubismManifestError } from "./manifest.ts";
import type { Live2dPartDefault, Live2dParameterMetadata } from "./transport.ts";

const Epsilon = 0.001;
const DefaultFadeInSeconds = 0.5;

export interface CubismPose3Frame {
  readonly parameters: Readonly<Record<string, number>>;
  readonly partOpacities: Readonly<Record<string, number>>;
}

interface PosePart {
  readonly id: string;
  readonly links: readonly string[];
}

interface PoseGroup {
  readonly parts: readonly PosePart[];
}

/**
 * CubismPose update/reset/fade/link operations, adapted from
 * Live2D/CubismWebFramework 5-r.5 at
 * 198a3769c26ca3d7b600e932590433badd392edd. It keeps virtual same-ID
 * selection parameters in JS and returns only real Core part/parameter facts.
 */
export class CubismPose3Simulation {
  private readonly groups: readonly PoseGroup[];
  private readonly fadeInSeconds: number;
  private readonly realPartIds: ReadonlySet<string>;
  private readonly realParameterIds: ReadonlySet<string>;
  private readonly selectionValues = new Map<string, number>();
  private readonly partOpacities = new Map<string, number>();
  private readonly defaultPartOpacities = new Map<string, number>();
  private disposed = false;

  constructor(
    input: unknown,
    parts: readonly Live2dPartDefault[],
    parameters: readonly Pick<Live2dParameterMetadata, "id">[],
  ) {
    const parsed = parsePose3(input);
    this.groups = parsed.groups;
    this.fadeInSeconds = parsed.fadeInSeconds;
    this.realPartIds = new Set(parts.map((part) => part.id));
    this.realParameterIds = new Set(parameters.map((parameter) => parameter.id));
    for (const part of parts) this.defaultPartOpacities.set(part.id, part.defaultOpacity);
    this.reset();
  }

  /** Initialize the pose like CubismPose::Reset for this model. */
  reset(): void {
    this.ensureLive();
    this.selectionValues.clear();
    this.partOpacities.clear();
    for (const [id, opacity] of this.defaultPartOpacities) this.partOpacities.set(id, opacity);
    for (const group of this.groups) {
      group.parts.forEach((part, index) => {
        const selected = index === 0 ? 1 : 0;
        this.selectionValues.set(part.id, selected);
        if (this.realPartIds.has(part.id)) this.partOpacities.set(part.id, selected);
        for (const link of part.links) this.selectionValues.set(link, 1);
      });
    }
  }

  /** Execute CubismPose::UpdateParameters with JS model values and Core facts. */
  update(
    parameters: Readonly<Record<string, number>>,
    partOpacityParameters: Readonly<Record<string, number>>,
    parameterWrites: ReadonlySet<string>,
    deltaSeconds: number,
  ): CubismPose3Frame {
    this.ensureLive();
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError("Pose delta must be finite and non-negative");
    for (const id of parameterWrites) {
      const value = parameters[id];
      if (value !== undefined) this.selectionValues.set(id, value);
    }
    // CubismMotion applies Target=PartOpacity as a same-ID parameter write.
    for (const [id, value] of Object.entries(partOpacityParameters)) this.selectionValues.set(id, value);

    const boundedDelta = Math.min(deltaSeconds, 5);
    for (const group of this.groups) this.doFade(group, boundedDelta);
    this.copyPartOpacities();

    const outputParameters: Record<string, number> = { ...parameters };
    for (const group of this.groups) for (const part of group.parts) {
      if (this.realParameterIds.has(part.id)) outputParameters[part.id] = this.selectionValues.get(part.id) ?? 0;
      for (const link of part.links) if (this.realParameterIds.has(link)) {
        outputParameters[link] = this.selectionValues.get(link) ?? 0;
      }
    }
    const outputPartOpacities: Record<string, number> = {};
    for (const id of this.realPartIds) outputPartOpacities[id] = this.partOpacities.get(id) ?? 0;
    return { parameters: outputParameters, partOpacities: outputPartOpacities };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selectionValues.clear();
    this.partOpacities.clear();
    this.defaultPartOpacities.clear();
  }

  private doFade(group: PoseGroup, deltaSeconds: number): void {
    let visiblePartIndex = -1;
    let newOpacity = 1;
    const phi = 0.5;
    const backOpacityThreshold = 0.15;

    for (let index = 0; index < group.parts.length; index++) {
      const part = group.parts[index]!;
      if ((this.selectionValues.get(part.id) ?? 0) > Epsilon) {
        if (visiblePartIndex >= 0) break;
        visiblePartIndex = index;
        if (this.fadeInSeconds === 0) {
          newOpacity = 1;
          continue;
        }
        newOpacity = this.partOpacities.get(part.id) ?? 0;
        newOpacity += deltaSeconds / this.fadeInSeconds;
        if (newOpacity > 1) newOpacity = 1;
      }
    }

    if (visiblePartIndex < 0) {
      visiblePartIndex = 0;
      newOpacity = 1;
    }

    for (let index = 0; index < group.parts.length; index++) {
      const part = group.parts[index]!;
      if (visiblePartIndex === index) {
        this.partOpacities.set(part.id, newOpacity);
      } else {
        let opacity = this.partOpacities.get(part.id) ?? 0;
        let a1: number;
        if (newOpacity < phi) a1 = newOpacity * (phi - 1) / phi + 1;
        else a1 = (1 - newOpacity) * phi / (1 - phi);
        const backOpacity = (1 - a1) * (1 - newOpacity);
        if (backOpacity > backOpacityThreshold) a1 = 1 - backOpacityThreshold / (1 - newOpacity);
        if (opacity > a1) opacity = a1;
        this.partOpacities.set(part.id, opacity);
      }
    }
  }

  private copyPartOpacities(): void {
    for (const group of this.groups) for (const part of group.parts) {
      if (part.links.length === 0) continue;
      const opacity = this.partOpacities.get(part.id) ?? 0;
      for (const link of part.links) if (this.realPartIds.has(link)) this.partOpacities.set(link, opacity);
    }
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error("Cubism pose simulation is disposed");
  }
}

function parsePose3(input: unknown): { fadeInSeconds: number; groups: PoseGroup[] } {
  const root = object(typeof input === "string" ? parseJson(input) : input, "pose3");
  if (root.Type !== "Live2D Pose") throw new CubismManifestError("pose3.Type must be Live2D Pose");
  let fadeInSeconds = root.FadeInTime === undefined ? DefaultFadeInSeconds : finite(root.FadeInTime, "pose3.FadeInTime");
  if (fadeInSeconds < 0) fadeInSeconds = DefaultFadeInSeconds;
  if (!Array.isArray(root.Groups)) throw new CubismManifestError("pose3.Groups must be an array");
  const groups = root.Groups.map((rawGroup, groupIndex): PoseGroup => {
    if (!Array.isArray(rawGroup)) throw new CubismManifestError(`pose3.Groups[${groupIndex}] must be an array`);
    const parts = rawGroup.map((rawPart, partIndex): PosePart => {
      const path = `pose3.Groups[${groupIndex}][${partIndex}]`;
      const part = object(rawPart, path);
      const id = nonEmptyString(part.Id, `${path}.Id`);
      const linkValue = part.Link === undefined ? [] : part.Link;
      if (!Array.isArray(linkValue)) throw new CubismManifestError(`${path}.Link must be an array`);
      return { id, links: linkValue.map((link, linkIndex) => nonEmptyString(link, `${path}.Link[${linkIndex}]`)) };
    });
    return { parts };
  });
  return { fadeInSeconds, groups };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CubismManifestError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CubismManifestError(`${path} must be a non-empty string`);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CubismManifestError(`${path} must be finite`);
  return value;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch (error) { throw new CubismManifestError(`pose3 is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
