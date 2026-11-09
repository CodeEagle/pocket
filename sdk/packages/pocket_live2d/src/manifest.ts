export interface CubismMotionReference {
  readonly file: string;
  readonly sound?: string;
  readonly fadeInTime?: number;
  readonly fadeOutTime?: number;
}

export interface CubismExpressionReference {
  readonly name: string;
  readonly file: string;
}

export interface CubismModel3Manifest {
  readonly version: 3;
  readonly moc: string;
  readonly textures: readonly string[];
  readonly physics?: string;
  readonly pose?: string;
  readonly userData?: string;
  readonly displayInfo?: string;
  readonly expressions: readonly CubismExpressionReference[];
  readonly motions: Readonly<Record<string, readonly CubismMotionReference[]>>;
  readonly groups: readonly {
    readonly target: "Parameter";
    readonly name: string;
    readonly ids: readonly string[];
  }[];
}

export class CubismManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CubismManifestError";
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CubismManifestError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CubismManifestError(`${path} must be a non-empty string`);
  }
  return value;
}

/** Rejects path escapes and URLs; the host must resolve only packaged assets. */
export function validateCubismAssetReference(value: unknown, path = "asset"): string {
  const asset = nonEmptyString(value, path);
  if (
    asset.startsWith("/") ||
    asset.startsWith("\\") ||
    /^[A-Za-z]:/.test(asset) ||
    asset.includes("\\") ||
    asset.includes("://") ||
    asset.includes("\0") ||
    asset.split("/").some((part) => part === ".." || part === "" || part === ".")
  ) {
    throw new CubismManifestError(`${path} must be a safe relative asset key`);
  }
  return asset;
}

function optionalReference(source: Record<string, unknown>, key: string, path: string): string | undefined {
  return source[key] === undefined ? undefined : validateCubismAssetReference(source[key], `${path}.${key}`);
}

/** Parses the JSON part of a .model3 document. Actual MOC deformation is native Core work. */
export function parseCubismModel3(input: unknown): CubismModel3Manifest {
  const document = typeof input === "string" ? parseJson(input, "model3") : input;
  const model = object(document, "model3");
  if (model.Version !== 3) throw new CubismManifestError("model3.Version must be 3");
  const references = object(model.FileReferences, "model3.FileReferences");
  const texturesValue = references.Textures;
  if (!Array.isArray(texturesValue) || texturesValue.length === 0) {
    throw new CubismManifestError("model3.FileReferences.Textures must be a non-empty array");
  }
  const textures = texturesValue.map((entry, index) => validateCubismAssetReference(entry, `model3.FileReferences.Textures[${index}]`));

  const expressionsValue = references.Expressions === undefined ? [] : references.Expressions;
  if (!Array.isArray(expressionsValue)) throw new CubismManifestError("model3.FileReferences.Expressions must be an array");
  const expressions = expressionsValue.map((entry, index) => {
    const expression = object(entry, `model3.FileReferences.Expressions[${index}]`);
    return {
      name: nonEmptyString(expression.Name, `model3.FileReferences.Expressions[${index}].Name`),
      file: validateCubismAssetReference(expression.File, `model3.FileReferences.Expressions[${index}].File`),
    };
  });

  const motionsValue = references.Motions === undefined ? {} : object(references.Motions, "model3.FileReferences.Motions");
  const motions: Record<string, CubismMotionReference[]> = {};
  for (const [group, entries] of Object.entries(motionsValue)) {
    if (!Array.isArray(entries)) throw new CubismManifestError(`model3.FileReferences.Motions.${group} must be an array`);
    motions[group] = entries.map((entry, index) => {
      const path = `model3.FileReferences.Motions.${group}[${index}]`;
      const motion = object(entry, path);
      const fadeInTime = motion.FadeInTime;
      const fadeOutTime = motion.FadeOutTime;
      if (fadeInTime !== undefined && (typeof fadeInTime !== "number" || !Number.isFinite(fadeInTime) || fadeInTime < 0)) {
        throw new CubismManifestError(`${path}.FadeInTime must be a non-negative number`);
      }
      if (fadeOutTime !== undefined && (typeof fadeOutTime !== "number" || !Number.isFinite(fadeOutTime) || fadeOutTime < 0)) {
        throw new CubismManifestError(`${path}.FadeOutTime must be a non-negative number`);
      }
      return {
        file: validateCubismAssetReference(motion.File, `${path}.File`),
        ...(motion.Sound === undefined ? {} : { sound: validateCubismAssetReference(motion.Sound, `${path}.Sound`) }),
        ...(fadeInTime === undefined ? {} : { fadeInTime }),
        ...(fadeOutTime === undefined ? {} : { fadeOutTime }),
      };
    });
  }

  const groupsValue = model.Groups === undefined ? [] : model.Groups;
  if (!Array.isArray(groupsValue)) throw new CubismManifestError("model3.Groups must be an array");
  const groups = groupsValue.flatMap((entry, index) => {
    const path = `model3.Groups[${index}]`;
    const group = object(entry, path);
    if (group.Target !== "Parameter") return [];
    if (!Array.isArray(group.Ids) || !group.Ids.every((id) => typeof id === "string" && id.length > 0)) {
      throw new CubismManifestError(`${path}.Ids must be an array of parameter IDs`);
    }
    return [{ target: "Parameter" as const, name: nonEmptyString(group.Name, `${path}.Name`), ids: group.Ids as string[] }];
  });

  return {
    version: 3,
    moc: validateCubismAssetReference(references.Moc, "model3.FileReferences.Moc"),
    textures,
    ...(optionalReference(references, "Physics", "model3.FileReferences") === undefined ? {} : { physics: optionalReference(references, "Physics", "model3.FileReferences")! }),
    ...(optionalReference(references, "Pose", "model3.FileReferences") === undefined ? {} : { pose: optionalReference(references, "Pose", "model3.FileReferences")! }),
    ...(optionalReference(references, "UserData", "model3.FileReferences") === undefined ? {} : { userData: optionalReference(references, "UserData", "model3.FileReferences")! }),
    ...(optionalReference(references, "DisplayInfo", "model3.FileReferences") === undefined ? {} : { displayInfo: optionalReference(references, "DisplayInfo", "model3.FileReferences")! }),
    expressions,
    motions,
    groups,
  };
}

function parseJson(input: string, label: string): unknown {
  try { return JSON.parse(input) as unknown; }
  catch (error) { throw new CubismManifestError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
