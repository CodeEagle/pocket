import type { JsonValue, StoryDefinition } from "./types.ts";
import { isNovelVariableName } from "./variables.ts";

/** One display collection in the project's shared VN data catalog. */
export interface NovelCollection {
  readonly title: string;
  readonly entries: Readonly<Record<string, NovelCollectionEntry>>;
}

/** A catalog entry refers to registered art by stable key, never by file path. */
export interface NovelCollectionEntry {
  readonly title: string;
  readonly body: string;
  readonly portrait?: NovelCollectionPortrait;
  /** A declared persistent boolean variable controls whether the entry is open. */
  readonly unlockVariable?: string;
}

export interface NovelCollectionPortrait {
  readonly character: string;
  readonly expression: string;
}

/** Catalogs are ordinary project data; progress remains in story variables. */
export type NovelCollections = Readonly<Record<string, NovelCollection>>;

export interface NovelCollectionsValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface NovelCollectionsValidationContext {
  readonly story?: Pick<StoryDefinition, "variableDefinitions">;
  readonly characters?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const collectionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_COLLECTIONS = 64;
const MAX_ENTRIES_PER_COLLECTION = 2048;
const MAX_TOTAL_ENTRIES = 8192;
const MAX_TITLE_LENGTH = 512;
const MAX_BODY_LENGTH = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key));
}

function validId(value: string): boolean {
  return collectionIdPattern.test(value);
}

function addIssue(
  issues: NovelCollectionsValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

/**
 * Validate the portable data-catalog shape. Supplying context also checks
 * story unlock declarations and portrait references against existing data.
 */
export function validateNovelCollections(
  value: unknown,
  context: NovelCollectionsValidationContext = {},
): readonly NovelCollectionsValidationIssue[] {
  const issues: NovelCollectionsValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ code: "collections.schema", path: "collections", message: "Collections must be a plain object keyed by collection ID." }];
  }

  const collectionIds = Reflect.ownKeys(value);
  if (collectionIds.some(key => typeof key !== "string")) {
    addIssue(issues, "collections.schema", "collections", "Collection IDs must be string keys.");
  }
  const stringCollectionIds = collectionIds.filter((key): key is string => typeof key === "string");
  if (stringCollectionIds.length > MAX_COLLECTIONS) {
    addIssue(issues, "collections.limit", "collections", `A project may define at most ${MAX_COLLECTIONS} collections.`);
  }

  let totalEntries = 0;
  for (const collectionId of stringCollectionIds.slice(0, MAX_COLLECTIONS)) {
    const collectionPath = `collections.${collectionId}`;
    if (!validId(collectionId)) {
      addIssue(issues, "collections.id", collectionPath, "Collection IDs must be 1–128 letters, digits, dots, underscores, colons, or dashes and start with a letter or digit.");
    }
    const collection = value[collectionId];
    if (!isRecord(collection)) {
      addIssue(issues, "collections.schema", collectionPath, "A collection must be an object with title and entries.");
      continue;
    }
    if (!hasOnlyFields(collection, ["title", "entries"])) {
      addIssue(issues, "collections.fields", collectionPath, "A collection may contain only title and entries.");
    }
    if (typeof collection.title !== "string" || collection.title.trim().length === 0 || collection.title.length > MAX_TITLE_LENGTH) {
      addIssue(issues, "collections.title", `${collectionPath}.title`, `Collection titles must be non-empty text up to ${MAX_TITLE_LENGTH} characters.`);
    }
    if (!isRecord(collection.entries)) {
      addIssue(issues, "collections.entries", `${collectionPath}.entries`, "Collection entries must be a plain object keyed by entry ID.");
      continue;
    }

    const entryIds = Reflect.ownKeys(collection.entries);
    if (entryIds.some(key => typeof key !== "string")) {
      addIssue(issues, "collections.entries", `${collectionPath}.entries`, "Entry IDs must be string keys.");
    }
    const stringEntryIds = entryIds.filter((key): key is string => typeof key === "string");
    if (stringEntryIds.length > MAX_ENTRIES_PER_COLLECTION) {
      addIssue(issues, "collections.limit", `${collectionPath}.entries`, `A collection may define at most ${MAX_ENTRIES_PER_COLLECTION} entries.`);
    }
    totalEntries += stringEntryIds.length;
    for (const entryId of stringEntryIds.slice(0, MAX_ENTRIES_PER_COLLECTION)) {
      const entryPath = `${collectionPath}.entries.${entryId}`;
      if (!validId(entryId)) {
        addIssue(issues, "collections.id", entryPath, "Entry IDs must be 1–128 letters, digits, dots, underscores, colons, or dashes and start with a letter or digit.");
      }
      const entry = collection.entries[entryId];
      if (!isRecord(entry)) {
        addIssue(issues, "collections.entry", entryPath, "An entry must be an object with title and body.");
        continue;
      }
      if (!hasOnlyFields(entry, ["title", "body", "portrait", "unlockVariable"])) {
        addIssue(issues, "collections.fields", entryPath, "An entry may contain only title, body, portrait, and unlockVariable.");
      }
      if (typeof entry.title !== "string" || entry.title.trim().length === 0 || entry.title.length > MAX_TITLE_LENGTH) {
        addIssue(issues, "collections.title", `${entryPath}.title`, `Entry titles must be non-empty text up to ${MAX_TITLE_LENGTH} characters.`);
      }
      if (typeof entry.body !== "string" || entry.body.length > MAX_BODY_LENGTH) {
        addIssue(issues, "collections.body", `${entryPath}.body`, `Entry body must be text up to ${MAX_BODY_LENGTH} characters.`);
      }

      if (entry.unlockVariable !== undefined) {
        if (typeof entry.unlockVariable !== "string" || !isNovelVariableName(entry.unlockVariable)) {
          addIssue(issues, "collections.unlockVariable", `${entryPath}.unlockVariable`, "unlockVariable must use a valid Pocket story variable name.");
        } else if (context.story !== undefined) {
          const definition = context.story.variableDefinitions?.[entry.unlockVariable];
          if (!definition) {
            addIssue(issues, "collections.unlockVariable.missing", `${entryPath}.unlockVariable`, `Story variable '${entry.unlockVariable}' is not declared.`);
          } else if (definition.lifetime !== "persistent" || definition.defaultValue !== false) {
            addIssue(issues, "collections.unlockVariable.persistent", `${entryPath}.unlockVariable`, "Unlock variables must be declared persistent with defaultValue false.");
          }
        }
      }

      if (entry.portrait !== undefined) {
        const portraitPath = `${entryPath}.portrait`;
        if (!isRecord(entry.portrait)) {
          addIssue(issues, "collections.portrait", portraitPath, "portrait must reference a registered character and expression.");
        } else {
          if (!hasOnlyFields(entry.portrait, ["character", "expression"])) {
            addIssue(issues, "collections.fields", portraitPath, "A portrait may contain only character and expression keys.");
          }
          if (typeof entry.portrait.character !== "string" || !validId(entry.portrait.character)) {
            addIssue(issues, "collections.portrait", `${portraitPath}.character`, "Portrait character must be a valid registered character ID.");
          }
          if (typeof entry.portrait.expression !== "string" || !validId(entry.portrait.expression)) {
            addIssue(issues, "collections.portrait", `${portraitPath}.expression`, "Portrait expression must be a valid registered expression ID.");
          }
          if (context.characters !== undefined &&
              typeof entry.portrait.character === "string" &&
              typeof entry.portrait.expression === "string" &&
              (!Object.hasOwn(context.characters, entry.portrait.character) ||
                !Object.hasOwn(context.characters[entry.portrait.character] ?? {}, entry.portrait.expression))) {
            addIssue(issues, "collections.portrait.missing", portraitPath, `Portrait '${entry.portrait.character}.${entry.portrait.expression}' is not registered.`);
          }
        }
      }
    }
  }
  if (totalEntries > MAX_TOTAL_ENTRIES) {
    addIssue(issues, "collections.limit", "collections", `A project may define at most ${MAX_TOTAL_ENTRIES} entries across all collections.`);
  }
  return issues;
}

/** Whether the current effective story-variable projection reveals an entry. */
export function isNovelCollectionEntryUnlocked(
  entry: NovelCollectionEntry,
  variables: Readonly<Record<string, JsonValue>>,
): boolean {
  return entry.unlockVariable === undefined || variables[entry.unlockVariable] === true;
}

/** Resolve a stable portrait key through the existing character asset registry. */
export function resolveNovelCollectionPortrait(
  entry: NovelCollectionEntry,
  characters: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | undefined {
  const portrait = entry.portrait;
  if (!portrait) return undefined;
  if (!Object.hasOwn(characters, portrait.character)) return undefined;
  const expressions = characters[portrait.character];
  if (!expressions || !Object.hasOwn(expressions, portrait.expression)) return undefined;
  const image = expressions[portrait.expression];
  return typeof image === "string" && image.length > 0 ? image : undefined;
}
