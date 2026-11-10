/**
 * Local Pocket Novel Editor routes.
 *
 * This module is deliberately independent from server.ts. The embedding
 * server supplies the already-authorized project root; this module only
 * reads/writes the fixed story.json path and bundles the SDK's real novel
 * engine for the browser preview.
 */

import { randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Condition, JsonValue, StoryDefinition, StoryInstruction, ValueExpression } from "../packages/pocket_vn/src/types.ts";
import { createSpineRig, getSpineAtlasInfo, type SpineSkeletonInput } from "@pocket/spine";
import { parseCubismModel3 } from "../packages/pocket_live2d/src/manifest.ts";
import type { NovelModelDefinition } from "../packages/pocket_vn/src/models.ts";
import { novelCharacterTransformIssue } from "../packages/pocket_vn/src/scene.ts";
import { novelCameraInstructionIssue } from "../packages/pocket_vn/src/camera.ts";
import { novelBackgroundLayersInstructionIssue } from "../packages/pocket_vn/src/background-layers.ts";
import { novelSceneObjectsIssue } from "../packages/pocket_vn/src/scene-objects.ts";
import { novelInputInstructionIssue } from "../packages/pocket_vn/src/input.ts";
import { novelVideoInstructionIssue } from "../packages/pocket_vn/src/video-schema.ts";
import { isNovelAssetSkin, type NovelAssetSkin } from "../packages/pocket_vn/src/skin.ts";
import { novelAtmosphereIssue, type NovelAtmosphere } from "../packages/pocket_vn/src/atmosphere.ts";
import { novelVariableDefinitionsIssue } from "../packages/pocket_vn/src/variables.ts";
import { novelReplayEntriesIssue } from "../packages/pocket_vn/src/replay-schema.ts";
import { novelConditionIssue } from "../packages/pocket_vn/src/conditions.ts";
import { validateNovelAssetReferences } from "../packages/pocket_vn/src/asset-references.ts";
import { novelBlueprintMetadataIssue, novelBlueprintMetadataIssueField } from "../packages/pocket_vn/src/blueprint.ts";
import { novelSayPresentationInstructionIssue } from "../packages/pocket_vn/src/say-presentation.ts";
import { novelSayRichTemplateIssue } from "../packages/pocket_vn/src/rich-text.ts";
import { novelAuthoredAudioGroupIssue, novelTimelineStoryIssue } from "../packages/pocket_vn/src/timeline.ts";
import { NOVEL_VOICE_CHANNEL } from "../packages/pocket_vn/src/voice.ts";
import { validateNovelTextSounds, type NovelTextSoundsConfig } from "../packages/pocket_vn/src/text-sounds.ts";
import { validateNovelCollections, type NovelCollections } from "../packages/pocket_vn/src/collections.ts";
import { validateNovelInventory } from "../packages/pocket_vn/src/inventory.ts";
import { isNovelChoiceSurface, novelChoiceSurfaceIssue, type NovelChoiceSurface } from "../packages/pocket_vn/src/choice-surface.ts";
import { createNovelBackup, listNovelBackups, restoreNovelBackup } from "./novel-backups.ts";
import { cubismWebCorePath } from "./live2d.ts";
import { getNovelHistory, NOVEL_HISTORY_MAX_BYTES, NovelHistoryError, putNovelHistory } from "./novel-history.ts";
import { createNovelWordDocument } from "./novel-word.ts";
import {
  localizeStory,
  novelSourceUiMessages,
  parseStoryLocaleCatalogCollection,
  serializeStoryLocaleCatalogCollection,
  type StoryAssetRegistry,
  type StoryLocaleCatalogCollectionDocument,
} from "../packages/pocket_vn/src/localization.ts";

const maxStoryBytes = 2 * 1024 * 1024;
const maxWordExportBytes = 8 * 1024 * 1024;
const maxAssetsBytes = 512 * 1024;
const maxLocalesBytes = 4 * 1024 * 1024;
const maxModelSourceBytes = 12 * 1024 * 1024;
const maxModelAtlasBytes = 2 * 1024 * 1024;
const maxLive2dMocBytes = 32 * 1024 * 1024;
const maxLive2dJsonBytes = 4 * 1024 * 1024;
const maxLive2dCoreBytes = 4 * 1024 * 1024;
const maxScriptLabels = 10_000;
const maxInstructionsPerLabel = 20_000;
const maxOptionsPerChoice = 128;
const maxValidationDepth = 32;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const projectIdPattern = /^[a-z][a-z0-9-]{0,47}$/;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type NovelDiagnosticSeverity = "error" | "warning" | "info";

export interface NovelDiagnostic {
  readonly severity: NovelDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly location?: { readonly label?: string; readonly index?: number; readonly field?: string };
}

export interface NovelValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly NovelDiagnostic[];
  readonly summary: {
    readonly labels: number;
    readonly instructions: number;
    readonly dialogueLines: number;
    readonly choices: number;
    readonly endings: number;
    readonly variables: number;
    readonly reachableLabels: number;
  };
}

export interface NovelAssetRegistry {
  readonly backgrounds: Readonly<Record<string, string>>;
  readonly characters: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly cgs: Readonly<Record<string, { readonly image: string; readonly title: string }>>;
  /** Loose WAV resource keys copied from projectRoot/assets into the Guest. */
  readonly audio: Readonly<Record<string, string>>;
  /** Optional stable video cue to asset-relative MP4 paths under projectRoot/assets. */
  readonly videos?: Readonly<Record<string, string>>;
  /** Optional weather layers keyed by a registered background ID. */
  readonly atmospheres?: Readonly<Record<string, NovelAtmosphere>>;
  /** Optional normalized hit regions keyed by a complete story choice ID. */
  readonly choiceSurfaces?: Readonly<Record<string, NovelChoiceSurface>>;
  /** One shared bitmap frame keeps game chrome styling in asset data without duplicate per-control images. */
  readonly skin?: NovelAssetSkin;
  /** Optional for compatibility with existing projects; writes include it once edited. */
  readonly models?: Readonly<Record<string, NovelModelDefinition>>;
  readonly textSounds?: NovelTextSoundsConfig;
  /** Optional gallery data whose references are stable story and asset IDs. */
  readonly collections?: NovelCollections;
}

export interface NovelEditorRouteOptions {
  /** A project root selected by the embedding Editor server, never a request path. */
  readonly projectRoot: string;
  readonly projectId: string;
  /** Trusted workspace selected by the embedding server; never supplied by a request. */
  readonly workspaceRoot?: string;
  /** Changes only after a successful project backup restore. */
  readonly novelRestoreEpoch?: number;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function failure(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, status);
}

async function readBoundedRequestBytes(request: Request, maxBytes: number, label: string): Promise<Buffer> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new NovelHistoryError(`${label} exceeds ${maxBytes} bytes`, 413);
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new NovelHistoryError(`${label} exceeds ${maxBytes} bytes`, 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectDirectory(projectRoot: string): { root: string; real: string } {
  const absolute = resolve(projectRoot);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("novel project root must be a real directory");
  return { root: absolute, real: realpathSync(absolute) };
}

/** Resolve only the fixed story.json file; never accept a caller-controlled path. */
function storyPath(projectRoot: string, mustExist: boolean): string {
  const project = projectDirectory(projectRoot);
  const target = join(project.root, "story.json");
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("story.json must not be a symbolic link");
    if (!info.isFile()) throw new Error("story.json must be a regular file");
    const real = realpathSync(target);
    const rel = relative(project.real, real);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("story.json escapes the project directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (mustExist) throw Object.assign(new Error("story.json not found"), { status: 404 });
  }
  return target;
}

/** Resolve only the canonical registry file; caller paths are never accepted. */
function assetsRegistryPath(projectRoot: string, mustExist: boolean): string {
  const project = projectDirectory(projectRoot);
  const target = join(project.root, "novel.assets.json");
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("novel.assets.json must not be a symbolic link");
    if (!info.isFile()) throw new Error("novel.assets.json must be a regular file");
    const real = realpathSync(target);
    const rel = relative(project.real, real);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("novel.assets.json escapes the project directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (mustExist) throw Object.assign(new Error("novel.assets.json not found"), { status: 404 });
  }
  return target;
}

/** Resolve only the canonical novel.locales.json file; caller paths are never accepted. */
function localesCatalogPath(projectRoot: string, mustExist: boolean): string {
  const project = projectDirectory(projectRoot);
  const target = join(project.root, "novel.locales.json");
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("novel.locales.json must not be a symbolic link");
    if (!info.isFile()) throw new Error("novel.locales.json must be a regular file");
    const real = realpathSync(target);
    const rel = relative(project.real, real);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("novel.locales.json escapes the project directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (mustExist) throw Object.assign(new Error("novel.locales.json not found"), { status: 404 });
  }
  return target;
}

async function readStory(projectRoot: string): Promise<StoryDefinition> {
  const path = storyPath(projectRoot, true);
  const info = await stat(path);
  if (info.size > maxStoryBytes) throw new Error(`story.json exceeds the ${maxStoryBytes}-byte editor limit`);
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`story.json is not valid JSON: ${errorText(error)}`);
  }
  if (!isStoryDefinition(parsed)) throw new Error("story.json does not contain a StoryDefinition");
  return parsed;
}

async function writeStory(projectRoot: string, story: StoryDefinition): Promise<void> {
  const project = projectDirectory(projectRoot);
  const path = storyPath(projectRoot, false);
  const content = `${JSON.stringify(story, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > maxStoryBytes) throw new Error(`story.json exceeds the ${maxStoryBytes}-byte editor limit`);
  const temporary = join(project.root, `.story.json.${randomUUID()}.tmp`);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    // Revalidate the fixed destination immediately before the atomic replace.
    if (path !== join(project.root, "story.json")) throw new Error("story path changed unexpectedly");
    storyPath(projectRoot, false);
    await rename(temporary, path);
    const directory = await open(dirname(path), fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readAssetRegistry(projectRoot: string): Promise<unknown> {
  let path: string;
  try { path = assetsRegistryPath(projectRoot, false); }
  catch (error) {
    if ((error as { status?: unknown })?.status === 404) return { backgrounds: {}, characters: {}, cgs: {}, audio: {} } satisfies NovelAssetRegistry;
    throw error;
  }
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { backgrounds: {}, characters: {}, cgs: {}, audio: {} } satisfies NovelAssetRegistry;
    throw error;
  }
  const info = await stat(path);
  if (info.size > maxAssetsBytes) throw new Error(`novel.assets.json exceeds the ${maxAssetsBytes}-byte editor limit`);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`novel.assets.json is not valid JSON: ${errorText(error)}`); }
  return parsed;
}

async function writeAssetRegistry(projectRoot: string, registry: NovelAssetRegistry): Promise<void> {
  const project = projectDirectory(projectRoot);
  const path = assetsRegistryPath(projectRoot, false);
  const content = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > maxAssetsBytes) throw new Error(`novel.assets.json exceeds the ${maxAssetsBytes}-byte editor limit`);
  const temporary = join(project.root, `.novel.assets.json.${randomUUID()}.tmp`);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (path !== join(project.root, "novel.assets.json")) throw new Error("asset registry path changed unexpectedly");
    assetsRegistryPath(projectRoot, false);
    await rename(temporary, path);
    const directory = await open(dirname(path), fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const emptyLocaleCollection: StoryLocaleCatalogCollectionDocument = {
  format: "pocket-vn-locales",
  formatVersion: 1,
  catalogs: {},
};

async function readLocaleCatalogCollection(projectRoot: string): Promise<StoryLocaleCatalogCollectionDocument> {
  const path = localesCatalogPath(projectRoot, false);
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLocaleCollection;
    throw error;
  }
  const info = await stat(path);
  if (info.size > maxLocalesBytes) throw new Error(`novel.locales.json exceeds the ${maxLocalesBytes}-byte editor limit`);
  let raw: unknown;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`novel.locales.json could not be read: ${errorText(error)}`); }
  try { return parseStoryLocaleCatalogCollection(raw); }
  catch (error) { throw new Error(`novel.locales.json is invalid: ${errorText(error)}`); }
}

async function writeLocaleCatalogCollection(
  projectRoot: string,
  collection: StoryLocaleCatalogCollectionDocument,
): Promise<void> {
  const project = projectDirectory(projectRoot);
  const path = localesCatalogPath(projectRoot, false);
  const content = `${serializeStoryLocaleCatalogCollection(collection)}\n`;
  if (Buffer.byteLength(content, "utf8") > maxLocalesBytes) throw new Error(`novel.locales.json exceeds the ${maxLocalesBytes}-byte editor limit`);
  const temporary = join(project.root, `.novel.locales.json.${randomUUID()}.tmp`);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    if (path !== join(project.root, "novel.locales.json")) throw new Error("locale catalog path changed unexpectedly");
    localesCatalogPath(projectRoot, false);
    await rename(temporary, path);
    const directory = await open(dirname(path), fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function storyLocaleAssetRegistry(assets: NovelAssetRegistry): StoryAssetRegistry {
  return {
    backgrounds: assets.backgrounds,
    characters: assets.characters,
    cgs: Object.fromEntries(Object.entries(assets.cgs).map(([key, value]) => [key, { image: value.image, title: value.title }])),
    audio: assets.audio,
    ...(assets.collections === undefined ? {} : { collections: assets.collections }),
    ...(assets.videos === undefined ? {} : { videos: assets.videos }),
  };
}

function storyForLocaleSourceText(story: StoryDefinition): StoryDefinition {
  if (story.inventory === undefined || validateNovelInventory(story.inventory).length === 0) return story;
  // Keep the locale Editor available while an invalid catalog is being repaired.
  return { ...story, inventory: undefined } as StoryDefinition;
}

function localeCollectionDiagnostics(
  story: StoryDefinition,
  assets: NovelAssetRegistry,
  collection: StoryLocaleCatalogCollectionDocument,
): Record<string, readonly unknown[]> {
  const result: Record<string, readonly unknown[]> = {};
  const assetRegistry = storyLocaleAssetRegistry(assets);
  const localeStory = storyForLocaleSourceText(story);
  for (const [locale, catalog] of Object.entries(collection.catalogs)) {
    result[locale] = localizeStory(localeStory, collection.catalogs, catalog.locale, { assetRegistry }).diagnostics;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > maxValidationDepth) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every(item => isJsonValue(item, depth + 1));
}

function isStoryDefinition(value: unknown): value is StoryDefinition {
  return isRecord(value) && typeof value.id === "string" && Number.isInteger(value.version) &&
    typeof value.start === "string" && isRecord(value.script);
}

function isSafeProjectPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && /^[\w./-]+$/.test(value) &&
    !value.includes("\\") && !isAbsolute(value) && value.split("/").every(segment => segment && segment !== "." && segment !== "..");
}

function isNovelModelDefinition(value: unknown): value is NovelModelDefinition {
  if (!isRecord(value) || (value.kind !== "spine" && value.kind !== "live2d") || !isSafeProjectPath(value.source) || !isRecord(value.textures)) return false;
  if (Object.keys(value).some(key => !["kind", "source", "atlas", "textures", "animations"].includes(key))) return false;
  if (value.atlas !== undefined && !isSafeProjectPath(value.atlas)) return false;
  if (value.kind === "spine" && typeof value.atlas !== "string") return false;
  if (!Object.entries(value.textures).every(([page, asset]) => typeof page === "string" && page.length > 0 && page.length <= 256 && !/[\u0000-\u001f]/.test(page) && isSafeProjectPath(asset))) return false;
  if (value.animations !== undefined && (!Array.isArray(value.animations) || value.animations.length > 4096 || !value.animations.every(isId))) return false;
  return true;
}

function novelCollectionDiagnostics(value: unknown, story?: StoryDefinition): NovelDiagnostic[] {
  if (!isRecord(value) || value.collections === undefined) return [];
  const context = {
    ...(story === undefined ? {} : { story }),
    ...(isRecord(value.characters) ? { characters: value.characters as Record<string, Record<string, string>> } : {}),
  };
  return validateNovelCollections(value.collections, context).map(issue => ({
    severity: "error",
    code: issue.code,
    message: `${issue.path}: ${issue.message}`,
    location: { field: issue.path },
  }));
}

function novelInventoryReferenceDiagnostics(story: StoryDefinition): NovelDiagnostic[] {
  const diagnostics: NovelDiagnostic[] = [];
  const knownLabels = new Set(Object.keys(story.script));
  if (story.inventory !== undefined) {
    for (const issue of validateNovelInventory(story.inventory, { story })) {
      if (!["inventory.variable.missing", "inventory.variable.save", "inventory.maxQuantity.default"].includes(issue.code)) continue;
      diagnostics.push({ severity: "error", code: issue.code, message: `${issue.path}: ${issue.message}`, location: { field: issue.path } });
    }
  }
  const items = story.inventory?.items;
  for (const [label, instructions] of Object.entries(story.script)) {
    if (!Array.isArray(instructions)) continue;
    for (const [index, instruction] of instructions.entries()) {
      if (!instruction || typeof instruction !== "object" || instruction.type !== "trade") continue;
      if (!items || !Object.hasOwn(items, instruction.item)) {
        diagnostics.push({ severity: "error", code: "instruction.inventory.item", message: `Trade instruction references unknown inventory item “${instruction.item}”.`, location: { label, index, field: "item" } });
      }
      if (!knownLabels.has(instruction.onFailure)) {
        diagnostics.push({ severity: "error", code: "instruction.inventory.failure-target", message: `Trade failure route references unknown label “${instruction.onFailure}”.`, location: { label, index, field: "onFailure" } });
      }
    }
  }
  return diagnostics;
}

function isAssetRegistry(value: unknown): value is NovelAssetRegistry {
  if (!isRecord(value) || !isRecord(value.backgrounds) || !isRecord(value.characters) || !isRecord(value.cgs) || !isRecord(value.audio)) return false;
  if (Object.keys(value).some(key => !["backgrounds", "characters", "cgs", "audio", "videos", "atmospheres", "choiceSurfaces", "models", "textSounds", "skin", "collections"].includes(key))) return false;
  if (!Object.entries(value.backgrounds).every(([key, image]) => isId(key) && typeof image === "string")) return false;
  if (!Object.entries(value.characters).every(([character, expressions]) => isId(character) && isRecord(expressions) &&
    Object.entries(expressions).every(([expression, image]) => isId(expression) && typeof image === "string"))) return false;
  if (!Object.entries(value.cgs).every(([key, cg]) => isId(key) && isRecord(cg) && typeof cg.image === "string" && isString(cg.title, 2048) &&
    Object.keys(cg).every(field => field === "image" || field === "title"))) return false;
  if (!Object.entries(value.audio).every(([cue, key]) => isId(cue) && typeof key === "string")) return false;
  if (value.videos !== undefined && (!isRecord(value.videos) || !Object.entries(value.videos).every(([cue, key]) => isId(cue) && typeof key === "string"))) return false;
  if (value.atmospheres !== undefined && (!isRecord(value.atmospheres) || !Object.keys(value.atmospheres).every(isId))) return false;
  if (value.choiceSurfaces !== undefined && (!isRecord(value.choiceSurfaces) ||
      !Object.entries(value.choiceSurfaces).every(([choiceId, surface]) => isId(choiceId) && isNovelChoiceSurface(surface)))) return false;
  if (value.skin !== undefined && !isNovelAssetSkin(value.skin)) return false;
  if (value.models !== undefined && (!isRecord(value.models) || !Object.entries(value.models).every(([key, model]) => isId(key) && isNovelModelDefinition(model)))) return false;
  if (value.textSounds !== undefined && validateNovelTextSounds(value.textSounds).length) return false;
  if (value.collections !== undefined && validateNovelCollections(value.collections).length) return false;
  return true;
}

function isHistoryInputInstruction(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "input" || !isId(value.id) ||
      (value.inputType !== "text" && value.inputType !== "number" && value.inputType !== "boolean")) return false;
  if (value.prompt !== undefined && typeof value.prompt !== "string") return false;
  if (value.placeholder !== undefined && typeof value.placeholder !== "string") return false;
  if (value.cancelTarget !== undefined && typeof value.cancelTarget !== "string") return false;
  if (value.inputType === "text" && value.defaultValue !== undefined && typeof value.defaultValue !== "string") return false;
  if (value.inputType === "number" && value.defaultValue !== undefined && (typeof value.defaultValue !== "number" || !Number.isFinite(value.defaultValue))) return false;
  if (value.inputType === "boolean" && value.defaultValue !== undefined && typeof value.defaultValue !== "boolean") return false;
  for (const field of ["minLength", "maxLength", "min", "max"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) return false;
  }
  if (value.integer !== undefined && typeof value.integer !== "boolean") return false;

  // Bounds and defaults can be temporarily contradictory while the author is
  // editing them. Validate the required/renderable input fields with the core
  // checker after omitting only those semantic constraints.
  const candidate = { ...value } as Record<string, unknown>;
  for (const field of ["defaultValue", "minLength", "maxLength", "min", "max", "integer"] as const) delete candidate[field];
  if (candidate.cancelTarget === "") delete candidate.cancelTarget;
  if (candidate.inputType === "boolean") delete candidate.placeholder;
  return novelInputInstructionIssue(candidate) === null;
}

function isHistoryStory(value: unknown): value is StoryDefinition {
  if (!isJsonValue(value) || !isStoryDefinition(value)) return false;
  // History must retain a structurally safe document while an author fixes
  // labels/replay references. Those reference diagnostics do not make its
  // saved edit snapshots unsafe to restore into the browser draft.
  const issues = storySchemaDiagnostics(value);
  for (const item of issues) {
    if (item.code === "story.start.missing" || item.code === "story.replayEntries") continue;
    if (item.code === "instruction.schema" && item.location?.label !== undefined && item.location.index !== undefined) {
      const instruction = value.script[item.location.label]?.[item.location.index];
      if (isHistoryInputInstruction(instruction)) continue;
    }
    return false;
  }
  return novelReplayEntriesIssue(value.replayEntries) === null;
}

function isHistoryAssets(value: unknown): value is NovelAssetRegistry {
  if (!isJsonValue(value) || !isRecord(value)) return false;
  const candidate = structuredClone(value) as unknown as Record<string, unknown>;
  if (candidate.models !== undefined) {
    if (!isRecord(candidate.models)) return false;
    for (const model of Object.values(candidate.models)) {
      if (!isRecord(model) || (model.kind !== "spine" && model.kind !== "live2d")) return false;
      if (model.source === undefined || typeof model.source === "string") {
        model.source = model.kind === "spine" ? "history.model.json" : "history.model3.json";
      } else return false;
      if (model.atlas === undefined || typeof model.atlas === "string") model.atlas = "history.atlas";
      else return false;
      if (isRecord(model.textures)) {
        for (const [page, path] of Object.entries(model.textures)) {
          if (typeof path !== "string") return false;
          model.textures[page] = "history-texture.png";
        }
      }
    }
  }
  // The registry schema checks its JSON/renderable shape. Resource paths are
  // editable draft values and are checked by the normal save/resource routes.
  return isAssetRegistry(candidate);
}

type RegisteredFileKind = "image" | "audio" | "video" | "spine-source" | "spine-atlas" | "live2d-source" | "live2d-resource";

function assetFileProblem(projectRoot: string, relativePath: string, kind: RegisteredFileKind): string | undefined {
  if (!relativePath || !/^[\w./-]+$/.test(relativePath) || relativePath.includes("\\") || isAbsolute(relativePath)) {
    return "path must be a relative path using letters, numbers, dot, underscore, dash and slash";
  }
  const segments = relativePath.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return "path contains an empty or traversal segment";
  if (kind === "audio" && (segments[0] !== "audio" || !relativePath.toLowerCase().endsWith(".wav"))) {
    return "audio keys must be WAV resource paths under assets/audio/";
  }
  if (kind === "video" && !/\.mp4$/i.test(relativePath)) return "video path must use the bundled local MP4 format";
  if (kind === "image" && !/\.(png|svg)$/i.test(relativePath)) return "image path must be PNG or SVG";
  if (kind === "spine-source" && !/\.(json|skel)$/i.test(relativePath)) return "Spine source must be .json or .skel";
  if (kind === "spine-atlas" && !/\.atlas$/i.test(relativePath)) return "Spine atlas must use the .atlas extension";
  if (kind === "live2d-source" && !/\.model3\.json$/i.test(relativePath)) return "Live2D source must use the .model3.json extension";
  const project = projectDirectory(projectRoot);
  const rootPath = kind === "audio" || kind === "video" ? join(project.root, "assets") : project.root;
  if (kind === "audio" || kind === "video") {
    try {
      const info = lstatSync(rootPath);
      if (info.isSymbolicLink()) return "project assets directory must not be a symbolic link";
      if (!info.isDirectory()) return "project assets path is not a directory";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "file is missing from the project";
      return errorText(error);
    }
  }
  let cursor = rootPath;
  try {
    for (const [index, segment] of segments.entries()) {
      cursor = join(cursor, segment);
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) return "symbolic links are not supported for registered assets";
      if (index < segments.length - 1 && !info.isDirectory()) return "an asset path segment is not a directory";
      if (index === segments.length - 1 && !info.isFile()) return "asset path is not a regular file";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "file is missing from the project";
    return errorText(error);
  }
  const resolved = realpathSync(cursor);
  const rel = relative(project.real, resolved);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) return "asset path escapes the project directory";
  return undefined;
}

export function validateAssetRegistry(value: unknown, projectRoot?: string, story?: StoryDefinition): NovelDiagnostic[] {
  const collectionIssues = novelCollectionDiagnostics(value, story);
  if (!isAssetRegistry(value)) {
    if (collectionIssues.length) return collectionIssues;
    if (isRecord(value) && isRecord(value.models)) {
      const missingSpineAtlas = Object.entries(value.models).find(([, model]) =>
        isRecord(model) && model.kind === "spine" && (typeof model.atlas !== "string" || model.atlas.length === 0),
      );
      if (missingSpineAtlas) {
        return [{
          severity: "error",
          code: "models.atlas.missing",
          message: `Spine model “${missingSpineAtlas[0]}” requires an atlas file.`,
          location: { field: `models.${missingSpineAtlas[0]}.atlas` },
        }];
      }
    }
    if (isRecord(value) && value.atmospheres !== undefined && (!isRecord(value.atmospheres) || !Object.keys(value.atmospheres).every(isId))) {
      return [{ severity: "error", code: "assets.atmospheres.schema", message: "atmospheres must be a map keyed by valid background IDs." }];
    }
    if (isRecord(value) && isRecord(value.backgrounds) && isRecord(value.characters) && isRecord(value.cgs) && isRecord(value.audio) &&
        value.skin !== undefined && !isNovelAssetSkin(value.skin)) {
      return [{ severity: "error", code: "assets.skin.schema", message: "skin requires frame {image,width,height,inset}; optional accentFrame uses the same shape; optional icons uses {image,width,height,columns,rows,names}, with a grid up to 16×16 and unique lower-case row-major names. Frame dimensions must be positive safe integers and inset must be non-negative and smaller than half the shorter side." }];
    }
    if (isRecord(value) && value.choiceSurfaces !== undefined) {
      if (!isRecord(value.choiceSurfaces)) return [{ severity: "error", code: "assets.choiceSurfaces.schema", message: "choiceSurfaces must map choice IDs to scene or dial surfaces." }];
      const invalid = Object.entries(value.choiceSurfaces).find(([choiceId, surface]) => !isId(choiceId) || !isNovelChoiceSurface(surface));
      if (invalid) {
        const [choiceId, surface] = invalid;
        return [{ severity: "error", code: "assets.choiceSurfaces.schema", message: `choiceSurfaces.${choiceId}: ${novelChoiceSurfaceIssue(surface) ?? "choice ID is invalid"}.`, location: { field: `choiceSurfaces.${choiceId}` } }];
      }
    }
    return [{ severity: "error", code: "assets.schema", message: "novel.assets.json must contain backgrounds, characters, cgs and audio maps with the Pocket VN registry shape." }];
  }
  const diagnostics: NovelDiagnostic[] = [...collectionIssues];
  if (value.textSounds !== undefined) {
    for (const issue of validateNovelTextSounds(value.textSounds, new Set(Object.keys(value.audio)))) {
      diagnostics.push({ severity: "error", code: `assets.textSounds.${issue.code}`, message: `${issue.path}: ${issue.message}`, location: { field: issue.path } });
    }
  }
  const checkPath = (key: string, path: string, kind: RegisteredFileKind): void => {
    const invalid = !path || !/^[\w./-]+$/.test(path) || path.includes("\\") || isAbsolute(path) ||
      path.split("/").some(part => !part || part === "." || part === "..") ||
      (kind === "image" && !/\.(png|svg)$/i.test(path)) ||
      (kind === "audio" && (path.split("/")[0] !== "audio" || !path.toLowerCase().endsWith(".wav"))) ||
      (kind === "video" && !/\.mp4$/i.test(path)) ||
      (kind === "spine-source" && !/\.(json|skel)$/i.test(path)) ||
      (kind === "spine-atlas" && !/\.atlas$/i.test(path)) ||
      (kind === "live2d-source" && !/\.model3\.json$/i.test(path));
    if (invalid) {
      diagnostics.push({ severity: "error", code: "assets.path", message: `Asset “${key}” must use a safe project relative ${kind === "image" ? "PNG/SVG" : kind === "audio" ? "assets/audio WAV" : kind === "video" ? "MP4 under assets/" : kind === "spine-source" ? "Spine JSON/binary" : kind === "spine-atlas" ? "Spine atlas" : "Live2D model3 JSON"} path.`, location: { field: key } });
      return;
    }
    if (!projectRoot) {
      return;
    }
    const problem = assetFileProblem(projectRoot, path, kind);
    if (problem) diagnostics.push({ severity: "error", code: problem === "file is missing from the project" ? "assets.missing" : "assets.path", message: `Asset “${key}” (${path}): ${problem}.`, location: { field: key } });
  };
  for (const [key, image] of Object.entries(value.backgrounds)) checkPath(`backgrounds.${key}`, image, "image");
  for (const [character, expressions] of Object.entries(value.characters)) {
    for (const [expression, image] of Object.entries(expressions)) checkPath(`characters.${character}.${expression}`, image, "image");
  }
  for (const [key, cg] of Object.entries(value.cgs)) checkPath(`cgs.${key}`, cg.image, "image");
  for (const [cue, path] of Object.entries(value.audio)) checkPath(`audio.${cue}`, path, "audio");
  for (const [cue, path] of Object.entries(value.videos ?? {})) checkPath(`videos.${cue}`, path, "video");
  for (const [backgroundId, config] of Object.entries(value.atmospheres ?? {})) {
    if (!Object.hasOwn(value.backgrounds, backgroundId)) {
      diagnostics.push({ severity: "error", code: "assets.atmosphere.background", message: `Atmosphere “${backgroundId}” must refer to a registered background.`, location: { field: `atmospheres.${backgroundId}` } });
    }
    const issue = novelAtmosphereIssue(config);
    if (issue) diagnostics.push({ severity: "error", code: "assets.atmosphere.schema", message: `atmospheres.${backgroundId}: ${issue}`, location: { field: `atmospheres.${backgroundId}` } });
    if (isRecord(config)) {
      for (const key of ["mist", "rain"] as const) {
        if (typeof config[key] === "string") checkPath(`atmospheres.${backgroundId}.${key}`, config[key] as string, "image");
      }
    }
  }
  for (const [choiceId, surface] of Object.entries(value.choiceSurfaces ?? {})) {
    if (surface.kind === "dial") checkPath(`choiceSurfaces.${choiceId}.image`, surface.image, "image");
  }
  if (value.skin) {
    checkPath("skin.frame", value.skin.frame.image, "image");
    if (value.skin.accentFrame) checkPath("skin.accentFrame", value.skin.accentFrame.image, "image");
    if (value.skin.icons) checkPath("skin.icons", value.skin.icons.image, "image");
  }
  for (const [key, model] of Object.entries(value.models ?? {})) {
    if (model.kind === "spine") {
      checkPath(`models.${key}.source`, model.source, "spine-source");
      if (model.atlas) checkPath(`models.${key}.atlas`, model.atlas, "spine-atlas");
      else diagnostics.push({ severity: "error", code: "models.atlas.missing", message: `Spine model “${key}” requires an atlas file.`, location: { field: `models.${key}.atlas` } });
    } else {
      checkPath(`models.${key}.source`, model.source, "live2d-source");
    }
    for (const [page, image] of Object.entries(model.textures)) checkPath(`models.${key}.textures.${page}`, image, "image");
  }
  return diagnostics;
}

function isString(value: unknown, max = 16_384): value is string {
  return typeof value === "string" && value.length <= max;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function isPosition(value: unknown): boolean {
  if (value === "left" || value === "center" || value === "right") return true;
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function isValueExpression(value: unknown, depth = 0): value is ValueExpression {
  if (depth > maxValidationDepth || !isRecord(value)) return false;
  if (value.type === "literal") return isJsonValue(value.value, depth + 1);
  return value.type === "variable" && isId(value.name);
}

function isCondition(value: unknown, depth = 0): value is Condition {
  if (depth > maxValidationDepth || !isRecord(value)) return false;
  switch (value.op) {
    case "truthy":
    case "falsy": return isValueExpression(value.value, depth + 1);
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": return isValueExpression(value.left, depth + 1) && isValueExpression(value.right, depth + 1);
    case "and":
    case "or": return Array.isArray(value.conditions) && value.conditions.length > 0 && value.conditions.length <= 128 && value.conditions.every(item => isCondition(item, depth + 1));
    case "not": return isCondition(value.condition, depth + 1);
    default: return false;
  }
}

function novelSceneTransitionIssue(value: unknown): string | null {
  if (!isRecord(value)) return "transition must be an object";
  if (!(value.kind === "cut" || value.kind === "fade" || value.kind === "dissolve" || value.kind === "reveal") ||
    !Number.isFinite(value.durationMs) || Number(value.durationMs) < 0) {
    return "transition kind or durationMs is invalid";
  }
  if (value.direction !== undefined && (value.kind !== "reveal" ||
    !(value.direction === "left" || value.direction === "right" || value.direction === "up" || value.direction === "down"))) {
    return "transition direction must be left, right, up or down and is only valid for reveal";
  }
  return null;
}

function isStoryInstruction(value: unknown): value is StoryInstruction {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "say": return isId(value.id) && isString(value.text) && novelSayPresentationInstructionIssue(value) === null &&
      (value.speaker === undefined || isString(value.speaker, 256)) &&
      (value.portrait === undefined || isId(value.portrait));
    case "scene": {
      if (value.background !== undefined && value.background !== null && !isId(value.background)) return false;
      if (novelCameraInstructionIssue(value) !== null) return false;
      if (novelBackgroundLayersInstructionIssue(value) !== null) return false;
      if (value.objects !== undefined && novelSceneObjectsIssue(value.objects) !== null) return false;
      if (value.characters !== undefined && (!Array.isArray(value.characters) || value.characters.length > 256 || !value.characters.every(character =>
        isRecord(character) && isId(character.id) &&
        (character.expression === undefined || isId(character.expression)) &&
        (character.position === undefined || isPosition(character.position)) &&
        novelCharacterTransformIssue(character) === null &&
        (character.model === undefined || character.model === null || isCharacterModelIntent(character.model)) &&
        (character.visible === undefined || typeof character.visible === "boolean")))) return false;
      if (value.remove !== undefined && (!Array.isArray(value.remove) || value.remove.length > 256 || !value.remove.every(isId))) return false;
      if (value.transition !== undefined && novelSceneTransitionIssue(value.transition) !== null) return false;
      return true;
    }
    case "audio": return isId(value.cue) &&
      (value.action === undefined || value.action === "play" || value.action === "stop") &&
      (value.channel === undefined || isId(value.channel) && value.channel !== NOVEL_VOICE_CHANNEL) &&
      novelAuthoredAudioGroupIssue(value.group, value.action, value.channel) === null &&
      (value.loop === undefined || typeof value.loop === "boolean");
    case "video": return novelVideoInstructionIssue(value) === null;
    case "wait": return Number.isFinite(value.durationMs) && Number(value.durationMs) >= 0;
    case "input": return isId(value.id) && novelInputInstructionIssue(value) === null;
    case "set": return isId(value.variable) && isJsonValue(value.value);
    case "inc": return isId(value.variable) && Number.isFinite(value.amount);
    case "trade": return Object.keys(value).every(key => ["type", "item", "action", "quantity", "onFailure"].includes(key)) &&
      isId(value.item) && (value.action === "buy" || value.action === "sell" || value.action === "consume") &&
      Number.isSafeInteger(value.quantity) && Number(value.quantity) > 0 && isId(value.onFailure);
    case "branch": return isCondition(value.when) && isId(value.then) && isId(value.else);
    case "jump":
    case "call": return isId(value.target);
    case "return": return true;
    case "choice": return isId(value.id) &&
      (value.prompt === undefined || isString(value.prompt)) &&
      Array.isArray(value.options) && value.options.length > 0 && value.options.length <= maxOptionsPerChoice &&
      value.options.every(option => isRecord(option) && isId(option.id) && isString(option.text) && isId(option.target) &&
        (option.when === undefined || isCondition(option.when))) &&
      (value.timeLimitMs === undefined || (Number.isFinite(value.timeLimitMs) && Number(value.timeLimitMs) > 0)) &&
      (value.timeoutTarget === undefined || isId(value.timeoutTarget));
    case "ending": return isId(value.id) && (value.text === undefined || isString(value.text)) &&
      (value.cg === undefined || isId(value.cg));
    default: return false;
  }
}

function isCharacterModelIntent(value: unknown): boolean {
  return isRecord(value) && isId(value.key) &&
    (value.animation === undefined || isId(value.animation)) &&
    (value.expression === undefined || isId(value.expression)) &&
    (value.loop === undefined || typeof value.loop === "boolean") &&
    (value.skin === undefined || isId(value.skin)) &&
    Object.keys(value).every(key => ["key", "animation", "expression", "loop", "skin"].includes(key));
}

function collectConditionVariables(condition: Condition, output: Set<string>): void {
  const expression = (value: ValueExpression): void => { if (value.type === "variable") output.add(value.name); };
  switch (condition.op) {
    case "truthy":
    case "falsy": expression(condition.value); break;
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": expression(condition.left); expression(condition.right); break;
    case "and":
    case "or": condition.conditions.forEach(child => collectConditionVariables(child, output)); break;
    case "not": collectConditionVariables(condition.condition, output); break;
  }
}

function instructionConditionDiagnostics(value: unknown, label: string, index: number): NovelDiagnostic[] {
  if (!isRecord(value)) return [];
  const diagnostics: NovelDiagnostic[] = [];
  const check = (condition: unknown, field: string): void => {
    const path = `script.${label}[${index}].${field}`;
    const issue = novelConditionIssue(condition, path);
    if (issue !== null) diagnostics.push({
      severity: "error",
      code: "instruction.condition",
      message: issue,
      location: { label, index, field },
    });
  };
  if (value.type === "branch") {
    check(value.when, "when");
  } else if (value.type === "choice" && Array.isArray(value.options)) {
    for (const [optionIndex, option] of value.options.entries()) {
      if (isRecord(option) && Object.hasOwn(option, "when")) check(option.when, `options[${optionIndex}].when`);
    }
  } else if (value.type === "scene" && Array.isArray(value.objects)) {
    for (const [objectIndex, object] of value.objects.entries()) {
      if (!isRecord(object) || !isRecord(object.interaction) || !Object.hasOwn(object.interaction, "when")) continue;
      check(object.interaction.when, `objects[${objectIndex}].interaction.when`);
    }
  }
  return diagnostics;
}

function storySchemaDiagnostics(value: unknown): NovelDiagnostic[] {
  const richDiagnostics: NovelDiagnostic[] = [];
  const conditionDiagnostics: NovelDiagnostic[] = [];
  if (isRecord(value) && isRecord(value.script)) {
    for (const [label, instructions] of Object.entries(value.script)) {
      if (!Array.isArray(instructions)) continue;
      for (const [index, instruction] of instructions.entries()) {
        conditionDiagnostics.push(...instructionConditionDiagnostics(instruction, label, index));
        if (!isRecord(instruction) || instruction.type !== "say" || instruction.rich === undefined) continue;
        const issue = novelSayRichTemplateIssue(typeof instruction.text === "string" ? instruction.text : "", instruction.rich);
        if (issue) richDiagnostics.push({
          severity: "error",
          code: "instruction.sayRich",
          message: `script.${label}[${index}].rich: ${issue}`,
          location: { label, index, field: "rich" },
        });
      }
    }
  }
  if (!isStoryDefinition(value)) return [
    { severity: "error", code: "story.schema", message: "story.json must contain id, integer version, start and script fields." },
    ...richDiagnostics,
    ...conditionDiagnostics,
  ];
  const diagnostics: NovelDiagnostic[] = [...richDiagnostics, ...conditionDiagnostics];
  if (value.editor !== undefined) {
    const issue = (field: string, message: string): void => {
      diagnostics.push({ severity: "error", code: "story.editor.graph", message, location: { field } });
    };
    if (!isRecord(value.editor)) issue("editor", "Story editor metadata must be an object.");
    else if (value.editor.graph !== undefined) {
      const graph = value.editor.graph;
      if (!isRecord(graph) || graph.version !== 1 || !isRecord(graph.positions)) {
        issue("editor.graph", "Story graph layout requires version 1 and a positions object.");
      } else for (const [label, position] of Object.entries(graph.positions)) {
        if (!isRecord(position) || ![position.x, position.y].every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate) && Math.abs(coordinate) <= 100000)) {
          issue(`editor.graph.positions.${label}`, "Graph coordinates must be finite numbers between -100000 and 100000.");
        }
      }
    }
    if (isRecord(value.editor)) {
      const blueprintIssue = novelBlueprintMetadataIssue(value.editor.blueprint, value.script);
      if (blueprintIssue !== null) {
        diagnostics.push({
          severity: "error",
          code: "story.editor.blueprint",
          message: blueprintIssue,
          location: { field: novelBlueprintMetadataIssueField(blueprintIssue) },
        });
      }
    }
  }
  const timelineIssue = novelTimelineStoryIssue(value);
  if (timelineIssue) {
    const path = timelineIssue.match(/^(?:story\.timelines|script\.[A-Za-z0-9_.:-]+\[\d+\]\.timeline)(?:\.[A-Za-z0-9_.:-]+|\[\d+\])*/)?.[0] ?? "timelines";
    diagnostics.push({ severity: "error", code: "story.timeline", message: timelineIssue, location: { field: path } });
  }
  const labelNames = Object.keys(value.script);
  if (value.inventory !== undefined) {
    diagnostics.push(...validateNovelInventory(value.inventory).map(issue => ({
      severity: "error" as const,
      code: issue.code,
      message: `${issue.path}: ${issue.message}`,
      location: { field: issue.path },
    })));
  }
  const variableIssue = novelVariableDefinitionsIssue(value.variableDefinitions);
  if (variableIssue) diagnostics.push({ severity: "error", code: "story.variableDefinitions", message: variableIssue, location: { field: "variableDefinitions" } });
  const replayIssue = novelReplayEntriesIssue(value.replayEntries, value.script);
  if (replayIssue) diagnostics.push({ severity: "error", code: "story.replayEntries", message: replayIssue, location: { field: "replayEntries" } });
  if (!isId(value.id)) diagnostics.push({ severity: "error", code: "story.id", message: "Story id must be 1–128 safe identifier characters.", location: { field: "id" } });
  if (!Number.isSafeInteger(value.version) || value.version < 1) diagnostics.push({ severity: "error", code: "story.version", message: "Story version must be a positive safe integer.", location: { field: "version" } });
  if (!isId(value.start)) diagnostics.push({ severity: "error", code: "story.start", message: "Start label is invalid.", location: { field: "start" } });
  if (labelNames.length === 0 || labelNames.length > maxScriptLabels) diagnostics.push({ severity: "error", code: "story.labels", message: `Story must contain 1–${maxScriptLabels} labels.` });
  if (value.start && !Object.prototype.hasOwnProperty.call(value.script, value.start)) diagnostics.push({ severity: "error", code: "story.start.missing", message: `Start label “${value.start}” does not exist.`, location: { field: "start" } });
  for (const label of labelNames) {
    if (!isId(label)) diagnostics.push({ severity: "error", code: "label.id", message: `Invalid label id “${label}”.`, location: { label } });
    const instructions = value.script[label];
    if (!Array.isArray(instructions) || instructions.length > maxInstructionsPerLabel) {
      diagnostics.push({ severity: "error", code: "label.instructions", message: `Label “${label}” must be an instruction array with at most ${maxInstructionsPerLabel} items.`, location: { label } });
      continue;
    }
    instructions.forEach((instruction, index) => {
      const cameraIssue = isRecord(instruction) && instruction.type === "scene" ? novelCameraInstructionIssue(instruction) : null;
      const backgroundLayersIssue = isRecord(instruction) && instruction.type === "scene" ? novelBackgroundLayersInstructionIssue(instruction) : null;
      const sceneObjectsIssue = isRecord(instruction) && instruction.type === "scene" && instruction.objects !== undefined
        ? novelSceneObjectsIssue(instruction.objects, `script.${label}[${index}].objects`)
        : null;
      const conditionIssues = instructionConditionDiagnostics(instruction, label, index);
      const sceneObjectConditionExplainsIssue = sceneObjectsIssue !== null && conditionIssues.some(item => item.message === sceneObjectsIssue);
      const transitionIssue = isRecord(instruction) && instruction.type === "scene" && instruction.transition !== undefined
        ? novelSceneTransitionIssue(instruction.transition)
        : null;
      const sayPresentationIssue = isRecord(instruction) && instruction.type === "say" ? novelSayPresentationInstructionIssue(instruction) : null;
      const audioGroupIssue = isRecord(instruction) && instruction.type === "audio"
        ? novelAuthoredAudioGroupIssue(instruction.group, instruction.action, instruction.channel, `script.${label}[${index}]`)
        : null;
      if (cameraIssue) diagnostics.push({ severity: "error", code: "instruction.camera", message: cameraIssue, location: { label, index, field: "camera" } });
      if (backgroundLayersIssue) diagnostics.push({ severity: "error", code: "instruction.backgroundLayers", message: backgroundLayersIssue, location: { label, index, field: "backgroundLayers" } });
      if (sceneObjectsIssue && !sceneObjectConditionExplainsIssue) diagnostics.push({ severity: "error", code: "instruction.sceneObjects", message: sceneObjectsIssue, location: { label, index, field: "objects" } });
      if (transitionIssue) diagnostics.push({ severity: "error", code: "instruction.transition", message: transitionIssue, location: { label, index, field: "transition" } });
      if (sayPresentationIssue) diagnostics.push({ severity: "error", code: "instruction.sayPresentation", message: sayPresentationIssue, location: { label, index, field: "presentation" } });
      if (audioGroupIssue) diagnostics.push({ severity: "error", code: "instruction.audioGroup", message: audioGroupIssue, location: { label, index, field: "group" } });
      if (!isStoryInstruction(instruction) && !cameraIssue && !backgroundLayersIssue && !sceneObjectsIssue && !transitionIssue && !sayPresentationIssue && !audioGroupIssue) diagnostics.push({ severity: "error", code: "instruction.schema", message: `Instruction ${index + 1} in “${label}” is invalid or unsupported.`, location: { label, index } });
    });
  }
  return diagnostics;
}

/**
 * Validate schema and references without executing story expressions. Cycles
 * and unreachable labels are diagnostics, not schema failures: authors may
 * intentionally create loops and optional routes.
 */
export function validateStoryDefinition(value: unknown): NovelValidationResult {
  const diagnostics = storySchemaDiagnostics(value);
  if (!isStoryDefinition(value)) {
    return { valid: false, diagnostics, summary: { labels: 0, instructions: 0, dialogueLines: 0, choices: 0, endings: 0, variables: 0, reachableLabels: 0 } };
  }

  const labels = Object.keys(value.script);
  diagnostics.push(...novelInventoryReferenceDiagnostics(value));
  const labelSet = new Set(labels);
  const edges = new Map<string, Set<string>>(labels.map(label => [label, new Set()]));
  const stableIds = new Map<string, { label: string; index: number; field: string }>();
  const reads = new Set<string>();
  const writes = new Set<string>();
  if (!novelVariableDefinitionsIssue(value.variableDefinitions)) {
    for (const [name, definition] of Object.entries(value.variableDefinitions ?? {})) {
      if (Object.hasOwn(definition, "defaultValue")) writes.add(name);
    }
  }
  const endings = new Set<string>();
  let instructionsCount = 0;
  let dialogueLines = 0;
  let choices = 0;

  const addTarget = (source: string, target: string, index: number, field: string): void => {
    if (!labelSet.has(target)) {
      diagnostics.push({ severity: "error", code: "reference.label", message: `Unknown label “${target}” referenced by ${field}.`, location: { label: source, index, field } });
    } else {
      edges.get(source)?.add(target);
    }
  };
  const addStableId = (id: string, label: string, index: number, field: string): void => {
    const previous = stableIds.get(id);
    if (previous) diagnostics.push({ severity: "error", code: "id.duplicate", message: `ID “${id}” is already used by ${previous.label}:${previous.index + 1} (${previous.field}).`, location: { label, index, field } });
    else stableIds.set(id, { label, index, field });
  };

  for (const [label, rawInstructions] of Object.entries(value.script)) {
    if (!Array.isArray(rawInstructions)) continue;
    const instructions = rawInstructions;
    instructionsCount += instructions.length;
    for (const [index, raw] of instructions.entries()) {
      if (!isStoryInstruction(raw)) continue;
      const instruction = raw;
      switch (instruction.type) {
        case "say": {
          addStableId(instruction.id, label, index, "dialogue line");
          dialogueLines++;
          for (const match of instruction.text.matchAll(/\{\{\s*([A-Za-z0-9._:-]+)\s*\}\}/g)) reads.add(match[1]!);
          break;
        }
        case "scene": {
          for (const object of instruction.objects ?? []) {
            const interaction = object.interaction;
            if (!interaction) continue;
            if (interaction.when) collectConditionVariables(interaction.when, reads);
            for (const effect of interaction.effects) {
              writes.add(effect.variable);
              if (effect.type === "inc") reads.add(effect.variable);
            }
          }
          break;
        }
        case "audio": break;
        case "video": break;
        case "wait": break;
        case "input":
          addStableId(instruction.id, label, index, "player input");
          writes.add(instruction.variable);
          for (const text of [instruction.prompt, instruction.inputType === "boolean" ? undefined : instruction.placeholder]) {
            for (const match of (text ?? "").matchAll(/\{\{\s*([A-Za-z0-9._:-]+)\s*\}\}/g)) reads.add(match[1]!);
          }
          if (instruction.cancelTarget) addTarget(label, instruction.cancelTarget, index, "input.cancelTarget");
          break;
        case "set": writes.add(instruction.variable); break;
        case "inc": writes.add(instruction.variable); reads.add(instruction.variable); break;
        case "trade": {
          addTarget(label, instruction.onFailure, index, "trade.onFailure");
          const item = value.inventory?.items[instruction.item];
          if (item) {
            reads.add(value.inventory!.currency.variable);
            writes.add(value.inventory!.currency.variable);
            reads.add(item.quantityVariable);
            writes.add(item.quantityVariable);
          }
          break;
        }
        case "branch":
          collectConditionVariables(instruction.when, reads);
          addTarget(label, instruction.then, index, "branch.then");
          addTarget(label, instruction.else, index, "branch.else");
          break;
        case "jump":
        case "call": addTarget(label, instruction.target, index, `${instruction.type}.target`); break;
        case "return": break;
        case "choice":
          addStableId(instruction.id, label, index, "choice");
          choices++;
          instruction.options.forEach((option, optionIndex) => {
            addStableId(`${instruction.id}/${option.id}`, label, index, `choice option ${optionIndex + 1}`);
            if (option.when) collectConditionVariables(option.when, reads);
            addTarget(label, option.target, index, `choice.options[${optionIndex}].target`);
          });
          if (instruction.timeoutTarget) addTarget(label, instruction.timeoutTarget, index, "choice.timeoutTarget");
          break;
        case "ending":
          addStableId(instruction.id, label, index, "ending");
          endings.add(label);
          break;
      }
    }
  }

  const reachable = new Set<string>();
  if (labelSet.has(value.start)) {
    const pending = [value.start];
    while (pending.length) {
      const label = pending.pop()!;
      if (reachable.has(label)) continue;
      reachable.add(label);
      for (const target of edges.get(label) ?? []) if (!reachable.has(target)) pending.push(target);
    }
  }
  for (const label of labels) {
    if (!reachable.has(label)) diagnostics.push({ severity: "warning", code: "label.unreachable", message: `Label “${label}” cannot be reached from the story start.`, location: { label } });
  }
  for (const variable of reads) {
    if (!writes.has(variable)) diagnostics.push({ severity: "warning", code: "variable.unwritten", message: `Variable “${variable}” is read but never written by this story.`, location: { field: variable } });
  }

  const cycle = findReachableCycle(value.start, edges, reachable);
  if (cycle) diagnostics.push({ severity: "info", code: "story.cycle", message: `Reachable cycle: ${cycle.join(" → ")}. Confirm that the cycle has a player exit or bounded condition.` });
  if (![...endings].some(label => reachable.has(label))) {
    diagnostics.push({ severity: "warning", code: "ending.unreachable", message: "No ending instruction is reachable from the story start." });
  }
  return {
    valid: !diagnostics.some(diagnostic => diagnostic.severity === "error"),
    diagnostics,
    summary: {
      labels: labels.length,
      instructions: instructionsCount,
      dialogueLines,
      choices,
      endings: [...endings].filter(label => reachable.has(label)).length,
      variables: writes.size,
      reachableLabels: reachable.size,
    },
  };
}

function storyAssetDiagnostics(story: StoryDefinition, assets: unknown): NovelDiagnostic[] {
  if (!isAssetRegistry(assets)) return [{ severity: "error", code: "assets.schema", message: "novel.assets.json is missing or invalid." }];
  return validateNovelAssetReferences(story, assets);
}

function combineValidation(story: StoryDefinition, assets: unknown, projectRoot?: string): NovelValidationResult {
  const base = validateStoryDefinition(story);
  const diagnostics = [
    ...base.diagnostics,
    ...validateAssetRegistry(assets, projectRoot, story),
    ...storyAssetDiagnostics(story, assets),
  ];
  return { ...base, valid: !diagnostics.some(item => item.severity === "error"), diagnostics };
}

function findReachableCycle(start: string, edges: Map<string, Set<string>>, reachable: Set<string>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: Array<{ label: string; edges: string[]; next: number }> = [];
  if (!reachable.has(start)) return undefined;
  visiting.add(start);
  stack.push({ label: start, edges: [...(edges.get(start) ?? [])], next: 0 });
  while (stack.length > 0) {
    const current = stack[stack.length - 1]!;
    if (current.next >= current.edges.length) {
      stack.pop();
      visiting.delete(current.label);
      visited.add(current.label);
      continue;
    }
    const target = current.edges[current.next++]!;
    if (!reachable.has(target) || visited.has(target)) continue;
    if (visiting.has(target)) {
      const index = stack.findIndex(frame => frame.label === target);
      return [...stack.slice(index).map(frame => frame.label), target];
    }
    visiting.add(target);
    stack.push({ label: target, edges: [...(edges.get(target) ?? [])], next: 0 });
  }
  return undefined;
}

async function runtimeBundle(): Promise<string> {
  const entry = join(root, "packages/pocket_vn/src/editor-runtime.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    write: false,
    sourcemap: "none",
    minify: false,
  });
  if (!build.success) throw new Error(build.logs.map(log => log.message).join("\n") || "Pocket VN core could not be bundled for editor preview");
  const output = build.outputs.find(item => item.path.endsWith(".js")) ?? build.outputs[0];
  if (!output) throw new Error("Pocket VN core build produced no browser module");
  return await output.text();
}

let runtimeBundlePromise: Promise<string> | undefined;
let spineBundlePromise: Promise<string> | undefined;

async function spineRuntimeBundle(): Promise<string> {
  const entry = join(root, "packages/pocket_vn/src/spine.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    write: false,
    sourcemap: "none",
    minify: false,
  });
  if (!build.success) throw new Error(build.logs.map(log => log.message).join("\n") || "Pocket Spine core could not be bundled for the editor preview");
  const output = build.outputs.find(item => item.path.endsWith(".js")) ?? build.outputs[0];
  if (!output) throw new Error("Pocket Spine core build produced no browser module");
  return await output.text();
}

let live2dBundlePromise: Promise<string> | undefined;

async function live2dRuntimeBundle(): Promise<string> {
  const entry = join(root, "editor/live2d-preview-runtime.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    write: false,
    sourcemap: "none",
    minify: false,
  });
  if (!build.success) throw new Error(build.logs.map(log => log.message).join("\n") || "Pocket Live2D preview could not be bundled for the editor");
  const output = build.outputs.find(item => item.path.endsWith(".js")) ?? build.outputs[0];
  if (!output) throw new Error("Pocket Live2D preview build produced no browser module");
  return await output.text();
}

/** Serve only the explicitly configured/cached Cubism Web Core host runtime. */
export async function serveNovelLive2dCore(): Promise<Response> {
  const corePath = cubismWebCorePath();
  try {
    const info = await stat(corePath);
    if (!info.isFile()) return failure("Cubism Web Core is not a regular file", 503);
    if (info.size > maxLive2dCoreBytes) return failure("Cubism Web Core exceeds the 4 MiB editor limit", 413);
    const bytes = await readFile(corePath);
    if (bytes.length > maxLive2dCoreBytes) return failure("Cubism Web Core exceeds the 4 MiB editor limit", 413);
    return new Response(bytes, { headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    } });
  } catch {
    return failure("Cubism Web Core is unavailable; configure POCKET_CUBISM_WEB_CORE or bootstrap the pinned Web Core cache", 503);
  }
}

function page(projectId: string): Response {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Pocket Novel Editor</title><link rel="stylesheet" href="/novel.css"></head>
<body data-pocket-novel data-project-id="${projectId}"><main id="novel-editor"><div class="novel-loading">正在打开故事项目…</div></main><script src="/preview.js"></script><script type="module" src="/novel.js"></script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
      "x-frame-options": "SAMEORIGIN",
    },
  });
}

async function staticClientAsset(filename: "novel.js" | "novel.css" | "preview.js" | "novel-localization.js" | "novel-localization.css" | "novel-rich-editor.js" | "novel-authoring.js" | "novel-authoring.css" | "novel-stage.js" | "novel-stage.css" | "novel-backups.js" | "novel-backups.css"): Promise<Response> {
  const path = join(dirname(fileURLToPath(import.meta.url)), "client", filename);
  const contents = await readFile(path);
  return new Response(contents, {
    headers: {
      "content-type": filename.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function registeredImage(projectRoot: string, relativePath: string): Promise<Response> {
  const problem = assetFileProblem(projectRoot, relativePath, "image");
  if (problem) return failure(`registered image unavailable: ${problem}`, 404);
  const path = resolve(projectRoot, relativePath);
  const bytes = await readFile(path);
  const mime = relativePath.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
  return new Response(bytes, {
    headers: {
      "content-type": mime,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

async function readRegisteredModelFile(
  projectRoot: string,
  relativePath: string,
  kind: "spine-source" | "spine-atlas" | "live2d-source" | "live2d-resource",
  maxBytes: number,
): Promise<Buffer> {
  const problem = assetFileProblem(projectRoot, relativePath, kind);
  if (problem) throw Object.assign(new Error(problem), { status: 404 });
  const project = projectDirectory(projectRoot);
  const path = resolve(project.root, relativePath);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Object.assign(new Error("registered model path is not a regular file"), { status: 404 });
    if (info.size > maxBytes) throw Object.assign(new Error(`registered model file exceeds the ${maxBytes}-byte editor limit`), { status: 413 });
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw Object.assign(new Error(`registered model file exceeds the ${maxBytes}-byte editor limit`), { status: 413 });
    return bytes;
  } finally {
    await handle.close();
  }
}

type LoadedSpineModelSource = {
  definition: NovelModelDefinition;
  kind: "spine";
  skeleton: { format: "json"; data: string } | { format: "binary"; base64: string };
  atlasText: string;
  atlasPages: readonly string[];
  missingTexturePages: readonly string[];
  premultipliedPages: readonly string[];
  animationNames: readonly string[];
  skinNames: readonly string[];
  unsupported: readonly { slot: string; reason: string; detail: string }[];
};

type LoadedLive2dModelSource = {
  definition: NovelModelDefinition;
  kind: "live2d";
  document: unknown;
  physics?: unknown;
  pose?: unknown;
  motions: Readonly<Record<string, unknown>>;
  expressions: Readonly<Record<string, unknown>>;
  atlasPages: readonly string[];
  missingTexturePages: readonly string[];
  premultipliedPages: readonly string[];
  animationNames: readonly string[];
  skinNames: readonly string[];
  expressionNames: readonly string[];
  unsupported: readonly { slot: string; reason: string; detail: string }[];
  browserConfig: { coreUrl: string; assets: Readonly<Record<string, string>> };
};

function modelDirectory(source: string): string {
  return posix.dirname(source);
}

function modelProviderPrefix(source: string): string {
  const nativeSource = source.replace(/^assets\//, "");
  const directory = posix.dirname(nativeSource);
  return directory === "." ? "" : directory;
}

function providerAssetKey(prefix: string, reference: string): string {
  return prefix ? `${prefix}/${reference}` : reference;
}

function parseReferencedModelJson(bytes: Buffer, reference: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch (error) {
    throw Object.assign(new Error(`Live2D referenced JSON ${reference} is invalid: ${errorText(error)}`), { status: 422 });
  }
}

async function readLive2dManifest(projectRoot: string, definition: NovelModelDefinition): Promise<{
  document: unknown;
  manifest: ReturnType<typeof parseCubismModel3>;
}> {
  const sourceBytes = await readRegisteredModelFile(projectRoot, definition.source, "live2d-source", maxModelSourceBytes);
  const document = parseReferencedModelJson(sourceBytes, definition.source);
  try { return { document, manifest: parseCubismModel3(document) }; }
  catch (error) {
    throw Object.assign(new Error(`Live2D Model3 document is invalid: ${errorText(error)}`), { status: 422 });
  }
}

function cubismManifestReferences(manifest: ReturnType<typeof parseCubismModel3>): Set<string> {
  const references = new Set<string>([manifest.moc, ...manifest.textures]);
  if (manifest.physics) references.add(manifest.physics);
  if (manifest.pose) references.add(manifest.pose);
  for (const entries of Object.values(manifest.motions)) for (const entry of entries) references.add(entry.file);
  for (const entry of manifest.expressions) references.add(entry.file);
  if (manifest.userData) references.add(manifest.userData);
  if (manifest.displayInfo) references.add(manifest.displayInfo);
  return references;
}

async function readLive2dReferenceJson(projectRoot: string, definition: NovelModelDefinition, reference: string): Promise<unknown> {
  const relativePath = posix.join(modelDirectory(definition.source), reference);
  const bytes = await readRegisteredModelFile(projectRoot, relativePath, "live2d-resource", maxLive2dJsonBytes);
  return parseReferencedModelJson(bytes, reference);
}

async function loadLive2dModelSource(
  projectRoot: string,
  key: string,
  projectId: string,
  definition: NovelModelDefinition,
): Promise<LoadedLive2dModelSource> {
  const { document, manifest } = await readLive2dManifest(projectRoot, definition);
  if (manifest.textures.length > 16) throw Object.assign(new Error("Live2D models may reference at most 16 textures"), { status: 422 });
  const references = cubismManifestReferences(manifest);
  const jsonCache = new Map<string, Promise<unknown>>();
  const readJson = (reference: string) => {
    let pending = jsonCache.get(reference);
    if (!pending) {
      pending = readLive2dReferenceJson(projectRoot, definition, reference);
      jsonCache.set(reference, pending);
    }
    return pending;
  };
  const motions: Record<string, unknown> = {};
  for (const [group, entries] of Object.entries(manifest.motions)) {
    for (const [index, entry] of entries.entries()) motions[`${group}:${index}`] = await readJson(entry.file);
  }
  const expressions: Record<string, unknown> = {};
  for (const entry of manifest.expressions) expressions[entry.name] = await readJson(entry.file);
  const physics = manifest.physics ? await readJson(manifest.physics) : undefined;
  const pose = manifest.pose ? await readJson(manifest.pose) : undefined;
  const missingPages = manifest.textures.filter(page => !definition.textures[page]);
  const prefix = modelProviderPrefix(definition.source);
  const assets: Record<string, string> = {};
  const resourceEndpoint = `/api/projects/${encodeURIComponent(projectId)}/novel/models/resource`;
  for (const reference of references) {
    if (manifest.textures.includes(reference) && !definition.textures[reference]) continue;
    const asset = providerAssetKey(prefix, reference);
    assets[asset] = `${resourceEndpoint}?key=${encodeURIComponent(key)}&asset=${encodeURIComponent(asset)}`;
  }
  return {
    definition,
    kind: "live2d",
    document,
    ...(physics === undefined ? {} : { physics }),
    ...(pose === undefined ? {} : { pose }),
    motions,
    expressions,
    atlasPages: manifest.textures,
    missingTexturePages: missingPages,
    premultipliedPages: [],
    animationNames: Object.keys(motions),
    skinNames: [],
    expressionNames: Object.keys(expressions),
    unsupported: [],
    browserConfig: { coreUrl: "/novel/live2d-core.js", assets },
  };
}

async function loadModelSource(projectRoot: string, key: string, projectId: string): Promise<LoadedSpineModelSource | LoadedLive2dModelSource> {
  const registry = await readAssetRegistry(projectRoot);
  if (!isAssetRegistry(registry)) throw Object.assign(new Error("novel asset registry is invalid"), { status: 409 });
  const definition = registry.models?.[key];
  if (!definition) throw Object.assign(new Error("registered model not found"), { status: 404 });
  if (definition.kind === "live2d") return loadLive2dModelSource(projectRoot, key, projectId, definition);
  if (!definition.atlas) throw Object.assign(new Error("Spine model requires an atlas"), { status: 422 });

  const sourceBytes = await readRegisteredModelFile(projectRoot, definition.source, "spine-source", maxModelSourceBytes);
  const atlasBytes = await readRegisteredModelFile(projectRoot, definition.atlas, "spine-atlas", maxModelAtlasBytes);
  const atlasText = atlasBytes.toString("utf8");
  const atlasInfo = getSpineAtlasInfo(atlasText);
  const atlasPages = atlasInfo.map(page => page.name);
  const skeleton: SpineSkeletonInput = definition.source.toLowerCase().endsWith(".skel")
    ? { format: "binary", data: new Uint8Array(sourceBytes) }
    : { format: "json", data: sourceBytes.toString("utf8") };

  const missingPages = atlasPages.filter(page => !definition.textures[page]);
  const textureKeys = { ...definition.textures, ...Object.fromEntries(missingPages.map(page => [page, `__unmapped/${page}`])) };
  const rig = createSpineRig({ skeleton, atlasText, textureKeys, yAxis: "down" });
  try {
    const unsupported = missingPages.length ? [] : rig.frame().flatMap(item => item.kind === "unsupported"
      ? [{ slot: item.slot, reason: item.reason, detail: item.detail }]
      : []);
    return {
      definition,
      kind: "spine",
      skeleton: skeleton.format === "binary"
        ? { format: "binary", base64: sourceBytes.toString("base64") }
        : { format: "json", data: skeleton.data },
      atlasText,
      atlasPages,
      missingTexturePages: missingPages,
      premultipliedPages: atlasInfo.filter(page => page.premultipliedAlpha).map(page => page.name),
      animationNames: rig.animationNames,
      skinNames: rig.skinNames,
      unsupported,
    };
  } finally {
    rig.dispose();
  }
}

async function registeredLive2dAsset(projectRoot: string, key: string, providerKey: string): Promise<Response> {
  const registry = await readAssetRegistry(projectRoot);
  if (!isAssetRegistry(registry)) return failure("novel asset registry is invalid", 409);
  const definition = registry.models?.[key];
  if (!definition || definition.kind !== "live2d") return failure("registered Live2D model not found", 404);
  const { manifest } = await readLive2dManifest(projectRoot, definition);
  const prefix = modelProviderPrefix(definition.source);
  const reference = [...cubismManifestReferences(manifest)].find(item => providerAssetKey(prefix, item) === providerKey);
  if (!reference) return failure("Live2D resource is not referenced by the registered Model3 document", 404);

  if (manifest.textures.includes(reference)) {
    const image = definition.textures[reference];
    if (!image) return failure("registered Live2D texture is not mapped", 404);
    return registeredImage(projectRoot, image);
  }

  const relativePath = posix.join(modelDirectory(definition.source), reference);
  const maxBytes = reference === manifest.moc ? maxLive2dMocBytes : maxLive2dJsonBytes;
  const bytes = await readRegisteredModelFile(projectRoot, relativePath, "live2d-resource", maxBytes);
  return new Response(bytes, { headers: {
    "content-type": "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}

/**
 * Handle `/novel`, its static client assets, and `/api/projects/:id/novel/*`.
 * `projectRoot` is supplied by the trusted local Editor server after project
 * lookup and project-write reservation; the request never selects a path.
 */
export async function handleNovelRoute(request: Request, options: NovelEditorRouteOptions): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (!projectIdPattern.test(options.projectId)) return failure("invalid novel project id", 400);
  if (path === "/novel-preview.js" && method === "GET") return staticClientAsset("preview.js");
  if (path === "/novel-localization.js" && method === "GET") return staticClientAsset("novel-localization.js");
  if (path === "/novel-localization.css" && method === "GET") return staticClientAsset("novel-localization.css");
  if (path === "/novel-rich-editor.js" && method === "GET") return staticClientAsset("novel-rich-editor.js");
  if (path === "/novel/live2d-core.js" && method === "GET") return serveNovelLive2dCore();
  for (const asset of ["novel-authoring.js", "novel-authoring.css", "novel-stage.js", "novel-stage.css", "novel-backups.js", "novel-backups.css"] as const) {
    if (path === `/${asset}` && method === "GET") return staticClientAsset(asset);
  }
  if (path === "/novel/resource" && method === "GET") {
    if (url.searchParams.get("project") !== options.projectId) return failure("novel project does not match the selected project", 404);
    try {
      const kind = url.searchParams.get("kind");
      if (kind === "skin" || kind === "atmosphere" || kind === "choice-surface") {
        const image = url.searchParams.get("path") ?? "";
        if (!image) return failure(`${kind} image path is required`, 400);
        return await registeredImage(options.projectRoot, image);
      }
      const key = url.searchParams.get("key") ?? "";
      if (!isId(key)) return failure("invalid registered asset key", 400);
      const registry = await readAssetRegistry(options.projectRoot);
      if (!isAssetRegistry(registry)) return failure("novel asset registry is invalid", 409);
      let image: string | undefined;
      if (kind === "background") image = registry.backgrounds[key];
      else if (kind === "cg") image = registry.cgs[key]?.image;
      else if (kind === "character") {
        const expression = url.searchParams.get("expression") ?? "neutral";
        if (!isId(expression)) return failure("invalid registered character expression", 400);
        const variants = registry.characters[key];
        image = variants?.[expression] ?? variants?.neutral;
      } else return failure("unsupported registered asset kind", 400);
      if (!image) return failure("registered asset not found", 404);
      return await registeredImage(options.projectRoot, image);
    } catch (error) {
      const status = Number((error as { status?: unknown })?.status);
      return failure(errorText(error), Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400);
    }
  }
  if (path === "/novel" && method === "GET") {
    if (url.searchParams.get("project") !== options.projectId) return failure("novel project does not match the selected project", 404);
    return page(options.projectId);
  }
  if (path === "/novel.js" && method === "GET") return staticClientAsset("novel.js");
  if (path === "/novel.css" && method === "GET") return staticClientAsset("novel.css");
  const match = path.match(/^\/api\/projects\/([a-z][a-z0-9-]{0,47})\/novel(?:\/(story|assets|history|backups(?:\/restore)?|locales(?:\/diagnostics)?|diagnostics|export|runtime\.js|spine\.js|live2d\.js|novel-(?:localization|rich-editor|authoring|stage|backups)\.js|models\/source|models\/resource))?$/);
  if (!match || match[1] !== options.projectId) return failure("not found", 404);
  const endpoint = match[2] ?? "editor";
  try {
    if (endpoint === "editor" && method === "GET") return page(options.projectId);
    if (endpoint === "novel-localization.js" && method === "GET") return staticClientAsset("novel-localization.js");
    if (endpoint === "novel-rich-editor.js" && method === "GET") return staticClientAsset("novel-rich-editor.js");
    if (endpoint === "novel-authoring.js" && method === "GET") return staticClientAsset("novel-authoring.js");
    if (endpoint === "novel-stage.js" && method === "GET") return staticClientAsset("novel-stage.js");
    if (endpoint === "novel-backups.js" && method === "GET") return staticClientAsset("novel-backups.js");
    if (endpoint === "live2d.js" && method === "GET") {
      live2dBundlePromise ??= live2dRuntimeBundle().catch(error => { live2dBundlePromise = undefined; throw error; });
      const source = await live2dBundlePromise;
      return new Response(source, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    if (endpoint === "history") {
      if (!options.workspaceRoot) return failure("Novel Editor history requires an Editor workspace", 503);
      const historyOptions = {
        workspaceRoot: options.workspaceRoot,
        projectRoot: options.projectRoot,
        projectId: options.projectId,
        restoreEpoch: options.novelRestoreEpoch ?? 0,
      };
      const historyValidators = { story: isHistoryStory, assets: isHistoryAssets };
      if (method === "GET") {
        return json(await getNovelHistory(historyOptions, historyValidators, url.searchParams.get("head") === "1"));
      }
      if (method === "PUT") {
        const content = (await readBoundedRequestBytes(request, NOVEL_HISTORY_MAX_BYTES, "Novel Editor history")).toString("utf8");
        let body: unknown;
        try { body = JSON.parse(content); } catch { return failure("Novel Editor history must be valid JSON", 400); }
        return json(await putNovelHistory(historyOptions, body, historyValidators));
      }
      return failure("Method not allowed", 405, { allow: "GET, PUT" });
    }
    if (endpoint === "backups" || endpoint === "backups/restore") {
      if (!options.workspaceRoot) return failure("Project backups require an Editor workspace", 503);
      const backupOptions = { workspaceRoot: options.workspaceRoot, projectRoot: options.projectRoot, projectId: options.projectId };
      if (endpoint === "backups" && method === "GET") return json({ backups: await listNovelBackups(backupOptions) });
      if (endpoint === "backups" && method === "POST") return json({ backup: await createNovelBackup(backupOptions) }, 201);
      if (endpoint === "backups/restore" && method === "POST") {
        const content = await request.text();
        if (Buffer.byteLength(content, "utf8") > 1024) return failure("Backup restore request is too large", 413);
        let body: unknown;
        try { body = JSON.parse(content); } catch { return failure("Invalid restore request", 400); }
        if (!isRecord(body) || typeof body.backupId !== "string" || Object.keys(body).some(key => key !== "backupId")) return failure("Restore requires one backup ID", 400);
        return json(await restoreNovelBackup(backupOptions, body.backupId));
      }
      return failure("Method not allowed", 405);
    }
    if (endpoint === "story" && method === "GET") {
      const story = await readStory(options.projectRoot);
      const assets = await readAssetRegistry(options.projectRoot);
      return json({ story, validation: combineValidation(story, assets, options.projectRoot) });
    }
    if (endpoint === "story" && (method === "PUT" || method === "POST")) {
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > maxStoryBytes) return failure(`story.json exceeds the ${maxStoryBytes}-byte editor limit`, 413);
      const input = await request.text();
      if (Buffer.byteLength(input, "utf8") > maxStoryBytes) return failure(`story.json exceeds the ${maxStoryBytes}-byte editor limit`, 413);
      let value: unknown;
      try { value = JSON.parse(input); } catch (error) { return failure(`invalid JSON: ${errorText(error)}`, 400); }
      if (!isStoryDefinition(value)) return failure("story.json does not contain a StoryDefinition", 422, { validation: validateStoryDefinition(value) });
      const structuralErrors = storySchemaDiagnostics(value);
      if (structuralErrors.length) return failure("story.json has structural errors", 422, { validation: validateStoryDefinition(value) });
      const inventoryReferenceErrors = novelInventoryReferenceDiagnostics(value);
      if (inventoryReferenceErrors.length) return failure("story.json has invalid inventory references", 422, { diagnostics: inventoryReferenceErrors, validation: validateStoryDefinition(value) });
      const assets = await readAssetRegistry(options.projectRoot);
      const collectionDiagnostics = novelCollectionDiagnostics(assets, value);
      if (collectionDiagnostics.length) {
        return failure("story.json would invalidate novel collection references", 422, {
          diagnostics: collectionDiagnostics,
          validation: combineValidation(value, assets, options.projectRoot),
        });
      }
      const validation = combineValidation(value, assets, options.projectRoot);
      const invalidTimelineAudioReferences = validation.diagnostics.filter(diagnostic =>
        diagnostic.code === "assets.reference" &&
        typeof diagnostic.location?.field === "string" &&
        diagnostic.location.field.startsWith("timelines.") &&
        /\.audio\[\d+\]\.cue$/.test(diagnostic.location.field));
      if (invalidTimelineAudioReferences.length) {
        return failure("story.json references timeline audio cues that are not registered", 422, {
          diagnostics: invalidTimelineAudioReferences,
          validation,
        });
      }
      await writeStory(options.projectRoot, value);
      return json({ story: value, validation, saved: true });
    }
    if (endpoint === "assets" && method === "GET") {
      const assets = await readAssetRegistry(options.projectRoot);
      const story = await readStory(options.projectRoot);
      return json({ assets, diagnostics: validateAssetRegistry(assets, options.projectRoot, story), validation: combineValidation(story, assets, options.projectRoot) });
    }
    if (endpoint === "assets" && (method === "PUT" || method === "POST")) {
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > maxAssetsBytes) return failure(`novel.assets.json exceeds the ${maxAssetsBytes}-byte editor limit`, 413);
      const input = await request.text();
      if (Buffer.byteLength(input, "utf8") > maxAssetsBytes) return failure(`novel.assets.json exceeds the ${maxAssetsBytes}-byte editor limit`, 413);
      let value: unknown;
      try { value = JSON.parse(input); } catch (error) { return failure(`invalid JSON: ${errorText(error)}`, 400); }
      const story = await readStory(options.projectRoot);
      if (!isAssetRegistry(value)) return failure("novel.assets.json does not match the Pocket VN registry shape", 422, { diagnostics: validateAssetRegistry(value, undefined, story) });
      const collectionDiagnostics = novelCollectionDiagnostics(value, story);
      if (collectionDiagnostics.length) return failure("novel.assets.json has invalid collection references", 422, { diagnostics: collectionDiagnostics });
      const structural = validateAssetRegistry(value);
      if (structural.some(item => item.severity === "error")) return failure("novel.assets.json has unsafe paths", 422, { diagnostics: structural });
      const diagnostics = validateAssetRegistry(value, options.projectRoot, story);
      const choiceSurfaceDiagnostics = storyAssetDiagnostics(story, value).filter(item => item.code.startsWith("assets.choiceSurface."));
      if (choiceSurfaceDiagnostics.length) return failure("novel.assets.json has invalid choice surface references", 422, { diagnostics: choiceSurfaceDiagnostics });
      const validation = combineValidation(story, value, options.projectRoot);
      await writeAssetRegistry(options.projectRoot, value);
      return json({ assets: value, diagnostics, validation, saved: true });
    }
    if (endpoint === "locales" && method === "GET") {
      const collection = await readLocaleCatalogCollection(options.projectRoot);
      const story = await readStory(options.projectRoot);
      const assets = await readAssetRegistry(options.projectRoot);
      if (!isAssetRegistry(assets)) return failure("novel.assets.json does not match the Pocket VN registry shape", 409);
      return json({ collection, uiDefaults: novelSourceUiMessages(storyLocaleAssetRegistry(assets), storyForLocaleSourceText(story)), diagnostics: localeCollectionDiagnostics(story, assets, collection) });
    }
    if (endpoint === "locales" && method === "PUT") {
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > maxLocalesBytes) return failure(`novel.locales.json exceeds the ${maxLocalesBytes}-byte editor limit`, 413);
      const input = await request.text();
      if (Buffer.byteLength(input, "utf8") > maxLocalesBytes) return failure(`novel.locales.json exceeds the ${maxLocalesBytes}-byte editor limit`, 413);
      let collection: StoryLocaleCatalogCollectionDocument;
      try { collection = parseStoryLocaleCatalogCollection(input); }
      catch (error) { return failure(`invalid locale collection: ${errorText(error)}`, 422); }
      const story = await readStory(options.projectRoot);
      const assets = await readAssetRegistry(options.projectRoot);
      if (!isAssetRegistry(assets)) return failure("novel.assets.json does not match the Pocket VN registry shape", 409);
      const diagnostics = localeCollectionDiagnostics(story, assets, collection);
      await writeLocaleCatalogCollection(options.projectRoot, collection);
      return json({ collection, uiDefaults: novelSourceUiMessages(storyLocaleAssetRegistry(assets), storyForLocaleSourceText(story)), diagnostics, saved: true });
    }
    if (endpoint === "locales/diagnostics" && method === "POST") {
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > maxLocalesBytes + maxStoryBytes + maxAssetsBytes) return failure("locale diagnostics request is too large", 413);
      const input = await request.text();
      if (Buffer.byteLength(input, "utf8") > maxLocalesBytes + maxStoryBytes + maxAssetsBytes) return failure("locale diagnostics request is too large", 413);
      let body: unknown;
      try { body = JSON.parse(input); } catch (error) { return failure(`invalid JSON: ${errorText(error)}`, 400); }
      if (!isRecord(body) || typeof body.locale !== "string") return failure("locale diagnostics requires a locale tag", 400);
      const collection = body.collection === undefined
        ? await readLocaleCatalogCollection(options.projectRoot)
        : (() => { try { return parseStoryLocaleCatalogCollection(body.collection); } catch (error) { throw new Error(`invalid locale collection: ${errorText(error)}`); } })();
      const catalog = collection.catalogs[body.locale];
      if (!catalog) return failure(`locale catalog '${body.locale}' not found`, 404);
      const story = body.story === undefined ? await readStory(options.projectRoot) : body.story;
      if (!isStoryDefinition(story) || storySchemaDiagnostics(story).length > 0) return failure("diagnostics story is not a structurally valid StoryDefinition", 422);
      const assetsValue = body.assets === undefined ? await readAssetRegistry(options.projectRoot) : body.assets;
      if (!isAssetRegistry(assetsValue)) return failure("diagnostics asset registry is invalid", 422);
      const assetRegistry = storyLocaleAssetRegistry(assetsValue);
      const diagnostics = localizeStory(story, collection.catalogs, catalog.locale, { assetRegistry }).diagnostics;
      return json({ locale: catalog.locale, diagnostics });
    }
    if (endpoint === "diagnostics" && method === "GET") {
      const story = await readStory(options.projectRoot);
      const assets = await readAssetRegistry(options.projectRoot);
      return json({ validation: combineValidation(story, assets, options.projectRoot) });
    }
    if (endpoint === "export" && method === "POST") {
      if (url.searchParams.get("format") !== "docx") return failure("Unsupported story export format", 400);
      const bytes = await readBoundedRequestBytes(request, maxWordExportBytes, "Word export story");
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { return failure("Word export requires valid UTF-8", 400); }
      let story: unknown;
      try { story = JSON.parse(content); } catch { return failure("Invalid story JSON for Word export", 400); }
      if (!isStoryDefinition(story)) return failure("Word export requires a StoryDefinition", 422);
      return new Response(createNovelWordDocument(story), {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-disposition": `attachment; filename="${options.projectId}-story.docx"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (endpoint === "export" && method === "GET") {
      const story = await readStory(options.projectRoot);
      return new Response(`${JSON.stringify(story, null, 2)}\n`, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${options.projectId}-story.json"`,
          "cache-control": "no-store",
        },
      });
    }
    if (endpoint === "runtime.js" && method === "GET") {
      runtimeBundlePromise ??= runtimeBundle().catch(error => { runtimeBundlePromise = undefined; throw error; });
      const source = await runtimeBundlePromise;
      return new Response(source, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    if (endpoint === "spine.js" && method === "GET") {
      spineBundlePromise ??= spineRuntimeBundle().catch(error => { spineBundlePromise = undefined; throw error; });
      const source = await spineBundlePromise;
      return new Response(source, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    if (endpoint === "models/source" && method === "GET") {
      const key = url.searchParams.get("key") ?? "";
      if (!isId(key)) return failure("invalid registered model key", 400);
      return json(await loadModelSource(options.projectRoot, key, options.projectId));
    }
    if (endpoint === "models/resource" && method === "GET") {
      const key = url.searchParams.get("key") ?? "";
      const assetKey = url.searchParams.get("asset");
      if (assetKey !== null) {
        if (!isId(key) || !assetKey || assetKey.length > 1024 || /[\u0000-\u001f]/.test(assetKey) || url.searchParams.has("page")) {
          return failure("invalid registered Live2D resource key", 400);
        }
        return await registeredLive2dAsset(options.projectRoot, key, assetKey);
      }
      const pageName = url.searchParams.get("page") ?? "";
      if (!isId(key) || !pageName || pageName.length > 256 || /[\u0000-\u001f]/.test(pageName)) return failure("invalid registered model texture key", 400);
      const registry = await readAssetRegistry(options.projectRoot);
      if (!isAssetRegistry(registry)) return failure("novel asset registry is invalid", 409);
      const model = registry.models?.[key];
      if (!model) return failure("registered model not found", 404);
      const image = model.textures[pageName];
      if (!image) return failure("registered model texture not found", 404);
      return await registeredImage(options.projectRoot, image);
    }
    return failure("method not allowed", 405, { allow: endpoint === "story" || endpoint === "assets" ? "GET, PUT, POST" : endpoint === "history" || endpoint === "locales" ? "GET, PUT" : endpoint === "locales/diagnostics" ? "POST" : endpoint === "export" ? "GET, POST" : "GET" });
  } catch (error) {
    if (error instanceof NovelHistoryError) return failure(errorText(error), error.status, error.code ? { code: error.code } : {});
    const status = Number((error as { status?: unknown })?.status);
    return failure(errorText(error), Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400);
  }
}
