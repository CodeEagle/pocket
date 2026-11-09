import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";

export interface PocketProjectFontIssue {
  readonly path: string;
  readonly message: string;
}

export type PocketProjectFontValidation =
  | {
      readonly ok: true;
      /** Pinned build_guest compiler flags for the validated project-local faces. */
      readonly compilerArguments: readonly string[];
      /** A detached schema input with only the accepted SDK extension removed. */
      readonly schemaInput: unknown;
    }
  | {
      readonly ok: false;
      readonly compilerArguments: readonly [];
      /** Invalid extensions are never removed before official schema validation. */
      readonly schemaInput: unknown;
      readonly issues: readonly PocketProjectFontIssue[];
    };

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(path: string, message: string, schemaInput: unknown): PocketProjectFontValidation {
  return { ok: false, compilerArguments: [], schemaInput, issues: [{ path, message }] };
}

/**
 * Validate Pocket's build-time `fonts` extension once for both standalone
 * guests and System catalog manifests. This deliberately validates only the
 * extension; the pinned schema remains authoritative for every other field.
 */
export function validatePocketProjectFonts(
  pocketDocument: unknown,
  projectRoot: string,
): PocketProjectFontValidation {
  if (!isRecord(pocketDocument)) {
    return { ok: true, compilerArguments: [], schemaInput: pocketDocument };
  }
  const raw = pocketDocument.fonts;
  if (raw === undefined) {
    return { ok: true, compilerArguments: [], schemaInput: pocketDocument };
  }
  if (!isRecord(raw)) {
    return invalid("fonts", "pocket.json fonts must be an object with regular and/or bold paths", pocketDocument);
  }

  const keys = Object.keys(raw);
  for (const key of keys) {
    if (key !== "regular" && key !== "bold") {
      return invalid("fonts", `pocket.json fonts has unknown field ${key}`, pocketDocument);
    }
  }
  if (keys.length === 0) {
    return invalid("fonts", "pocket.json fonts must declare regular and/or bold", pocketDocument);
  }

  let realProjectRoot: string;
  try {
    realProjectRoot = realpathSync(projectRoot);
  } catch {
    return invalid("fonts", `pocket.json project root does not exist: ${projectRoot}`, pocketDocument);
  }

  const compilerArguments: string[] = [];
  for (const key of ["regular", "bold"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    const source = raw[key];
    if (typeof source !== "string" || source.length === 0 || source.trim() !== source) {
      return invalid(`fonts.${key}`, `pocket.json fonts.${key} must be a nonempty project-relative .ttf or .otf path`, pocketDocument);
    }
    // Manifests are portable across build hosts: use forward slashes, and do
    // not admit absolute paths, drive-relative paths, or traversal segments.
    if (source.includes("\\") || isAbsolute(source) || win32.isAbsolute(source) || /^[A-Za-z]:/.test(source)
      || source.split("/").some((part) => part === "" || part === "." || part === "..")) {
      return invalid(`fonts.${key}`, `pocket.json fonts.${key} must stay inside projectRoot: ${source}`, pocketDocument);
    }
    if (!/\.(?:ttf|otf)$/i.test(source)) {
      return invalid(`fonts.${key}`, `pocket.json fonts.${key} must use a .ttf or .otf font file: ${source}`, pocketDocument);
    }

    const candidate = resolve(projectRoot, source);
    const lexical = relative(resolve(projectRoot), candidate);
    if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) {
      return invalid(`fonts.${key}`, `pocket.json fonts.${key} must stay inside projectRoot: ${source}`, pocketDocument);
    }

    let stat;
    let realCandidate: string;
    try {
      stat = lstatSync(candidate);
      realCandidate = realpathSync(candidate);
    } catch {
      return invalid(`fonts.${key}`, `pocket.json fonts.${key} file does not exist: ${source}`, pocketDocument);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
      return invalid(`fonts.${key}`, `pocket.json fonts.${key} must be a nonempty regular font file: ${source}`, pocketDocument);
    }
    const realRelative = relative(realProjectRoot, realCandidate);
    if (!realRelative || realRelative.startsWith("..") || isAbsolute(realRelative)) {
      return invalid(`fonts.${key}`, `pocket.json fonts.${key} resolves outside projectRoot: ${source}`, pocketDocument);
    }
    compilerArguments.push(`--font-${key}=${realCandidate}`);
  }

  const schemaInput = { ...pocketDocument };
  delete schemaInput.fonts;
  return { ok: true, compilerArguments, schemaInput };
}
