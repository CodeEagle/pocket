import type {
  ActiveNovelState,
  BacklogEntry,
  JsonValue,
  NovelSaveData,
  NovelSaveDataV2,
  NovelSaveDataV3,
  NovelSaveDataV4,
  NovelSayRich,
  RollbackCheckpoint,
  ScriptPosition,
  StoryDefinition,
  StoryInstruction,
} from "./types.ts";
import { decodeNovelSaveData } from "./save-codec.ts";
import type { NovelCollections } from "./collections.ts";
import { interpolateNovelText, novelSayRichTemplateIssue, resolveNovelSayRich } from "./rich-text.ts";

export interface StoryLocaleChoice {
  readonly prompt?: string;
  readonly options?: Readonly<Record<string, string>>;
}

/** Stable-ID translations for player-provided input prompts and hints. */
export interface StoryLocaleInput {
  readonly prompt?: string;
  readonly placeholder?: string;
}

/** Asset values refer to other entries in the same host asset registry. */
export interface StoryLocaleAssetOverrides {
  readonly backgrounds?: Readonly<Record<string, string>>;
  readonly characters?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly cgs?: Readonly<Record<string, { readonly asset: string; readonly title?: string }>>;
  readonly audio?: Readonly<Record<string, string>>;
  /** Stable video cue aliases resolve through the same host registry boundary as audio cues. */
  readonly videos?: Readonly<Record<string, string>>;
}

/** A JSON-only locale catalog keyed by stable story, line, choice and ending IDs. */
export interface StoryLocaleCatalog {
  readonly format: "pocket-vn-locale";
  readonly formatVersion: 1;
  readonly locale: string;
  readonly fallbackLocale?: string;
  readonly lines?: Readonly<Record<string, string>>;
  /** Optional inline annotations whose ranges are authored against the same catalog's translated line. */
  readonly sayRich?: Readonly<Record<string, NovelSayRich>>;
  readonly speakers?: Readonly<Record<string, string>>;
  readonly choices?: Readonly<Record<string, StoryLocaleChoice>>;
  readonly inputs?: Readonly<Record<string, StoryLocaleInput>>;
  readonly endings?: Readonly<Record<string, string>>;
  /** Stable-ID titles for optional gallery replay entries. */
  readonly replays?: Readonly<Record<string, string>>;
  /** Stable display keys for the Pocket player shell (menus, settings and prompts). */
  readonly ui?: Readonly<Record<string, string>>;
  readonly assets?: StoryLocaleAssetOverrides;
}

export type StoryLocaleCatalogCollection = Readonly<Record<string, StoryLocaleCatalog>>;

/** Canonical project file shape stored at `novel.locales.json`. */
export interface StoryLocaleCatalogCollectionDocument {
  readonly format: "pocket-vn-locales";
  readonly formatVersion: 1;
  readonly catalogs: StoryLocaleCatalogCollection;
}

/** Structural asset registry accepted from the renderer/audio integration. */
export interface StoryAssetRegistry {
  readonly collections?: NovelCollections;
  readonly backgrounds?: Readonly<Record<string, string>>;
  readonly characters?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly cgs?: Readonly<Record<string, { readonly image: string; readonly title: string }>>;
  readonly audio?: Readonly<Record<string, string>>;
  readonly videos?: Readonly<Record<string, string>>;
}

export type StoryLocaleDiagnosticCode =
  | "invalid-locale"
  | "fallback-cycle"
  | "missing-line"
  | "missing-rich-annotations"
  | "missing-speaker"
  | "missing-choice"
  | "missing-input"
  | "missing-prompt"
  | "missing-option"
  | "missing-input-prompt"
  | "missing-input-placeholder"
  | "missing-ending"
  | "extra-line"
  | "extra-rich-annotations"
  | "extra-speaker"
  | "extra-choice"
  | "extra-input"
  | "extra-prompt"
  | "extra-option"
  | "extra-input-prompt"
  | "extra-input-placeholder"
  | "extra-ending"
  | "missing-replay"
  | "extra-replay"
  | "missing-ui"
  | "extra-ui"
  | "placeholder-mismatch"
  | "input-placeholder-mismatch"
  | "ui-placeholder-mismatch"
  | "asset-registry-required"
  | "unknown-asset-target"
  | "unknown-asset-reference";

export interface StoryLocaleDiagnostic {
  readonly severity: "warning" | "error";
  readonly code: StoryLocaleDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface DiagnoseStoryLocaleOptions {
  readonly assetRegistry?: StoryAssetRegistry;
}

export interface LocalizeStoryOptions extends DiagnoseStoryLocaleOptions {
  /** Used when the requested locale is absent or its chain has no fallback. */
  readonly fallbackLocale?: string;
}

export interface LocalizedStory {
  readonly locale: string;
  /** Requested locale followed by available fallback catalogs, in precedence order. */
  readonly fallbackChain: readonly string[];
  readonly story: StoryDefinition;
  /** Merged by logical registry key; the host resolves them against its existing asset registry. */
  readonly assetOverrides: StoryLocaleAssetOverrides;
  /** Pocket player-shell messages resolved through the same catalog fallback chain. */
  readonly ui: Readonly<Record<string, string>>;
  readonly diagnostics: readonly StoryLocaleDiagnostic[];
}

export class StoryLocaleCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryLocaleCatalogError";
  }
}

const CATALOG_FORMAT = "pocket-vn-locale";
const CATALOG_VERSION = 1;
const COLLECTION_FORMAT = "pocket-vn-locales";
const COLLECTION_VERSION = 1;
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

/** Required player-shell strings. Missing translations use these Chinese defaults. */
export const NOVEL_UI_DEFAULT_MESSAGES: Readonly<Record<string, string>> = {
  "panel.inventory": "随身行囊",
  "inventory.balance": "{{currency}} · {{count}}",
  "inventory.quantity": "持有 {{count}}",
  "inventory.prices": "买入 {{buy}} · 退回 {{sell}}",
  "inventory.notSellable": "不可退回",
  "inventory.limit": "最多持有 {{count}}",
  "inventory.invalid": "数据无效",
  "inventory.list": "返回行囊列表",
  "inventory.next": "更多物品 · {{page}} / {{total}}",
  "panel.collections": "旅人档案",
  "collections.count": "已收集 {{count}} / {{total}}",
  "collections.locked": "尚未解锁，继续旅程后再来看看",
  "collections.list": "返回档案列表",
  "collections.next": "更多记录 · {{page}} / {{total}}",
  "player.brand": "POCKET STORIES / 01",
  "player.subtitle": "每一封未寄出的信，都在等待一盏灯。",
  "player.menu": "手札",
  "player.narrator": "雾港纪事",
  "player.reveal": "轻触显全",
  "player.continue": "轻触继续  ›",
  "player.resumeText": "轻触续读  ›",
  "player.voiceReplay": "重听配音",
  "video.pause": "暂停视频",
  "video.resume": "继续视频",
  "video.seekBack": "后退 1 秒",
  "video.seekStart": "回到开头",
  "video.seekForward": "前进 1 秒",
  "video.restart": "从头播放",
  "video.close": "关闭视频",
  "video.error": "视频不可用：{{detail}}",
  "player.choiceTimer": "风暴迫近 · {{seconds}} 秒",
  "player.wait": "听，雾里有回声……",
  "player.endingTitle": "一封信的终点",
  "player.endingCount": "已抵达 {{count}} 个结局",
  "player.newStory": "再写一封信",
  "player.titlePage": "返回扉页",
  "player.rollback": "回溯",
  "player.log": "回声",
  "player.auto": "自动",
  "player.autoActive": "自动中",
  "player.skip": "已读跳过",
  "player.skipActive": "跳读中",
  "title.start": "启程 · 开始新的故事",
  "title.resume": "续写 · 继续旅程",
  "title.load": "重读信笺",
  "title.gallery": "雾港纪念",
  "title.settings": "阅读偏好",
  "title.exit": "离开雾港",
  "panel.menu": "旅途手札",
  "panel.save": "封存此刻",
  "panel.load": "重读信笺",
  "panel.slots": "管理存档",
  "panel.log": "沿途回声",
  "panel.note": "信笺注记",
  "note.unavailable": "这条注记已不在当前记录中。",
  "panel.settings": "阅读偏好",
  "panel.gallery": "雾港纪念",
  "panel.back": "返回",
  "menu.continue": "继续阅读",
  "menu.save": "封存此刻",
  "menu.load": "重读信笺",
  "menu.log": "沿途回声",
  "menu.settings": "阅读偏好",
  "menu.gallery": "雾港纪念",
  "menu.title": "返回扉页",
  "save.hint": "选择信笺将覆盖原有记录。",
  "load.hint": "从记录中的那个瞬间继续。",
  "slot.auto": "自动记录",
  "slot.quick": "快速存档",
  "slot.quickSave": "快速保存此刻",
  "slot.quickSaved": "快速存档已更新",
  "slot.named": "信笺 {{slot}}",
  "slot.saved": "信笺 {{slot}} 已封存",
  "slot.currentJourney": "已保存的旅程",
  "slot.empty": "空白信笺",
  "slot.loading": "正在读取",
  "slot.readError": "无法读取",
  "slot.missing": "这张信笺还没有记录",
  "slot.manage": "管理存档",
  "slot.manageHint": "选择一个来源，再输入目标 ID。覆盖、删除和交换前会再次确认。",
  "slot.selected": "来源 · {{slot}}",
  "slot.selectedShort": "当前来源",
  "slot.idPlaceholder": "输入存档 ID",
  "slot.create": "保存到此 ID",
  "slot.copy": "复制到 ID",
  "slot.move": "移动到 ID",
  "slot.swap": "与 ID 交换",
  "slot.delete": "删除来源",
  "slot.confirm": "确认",
  "slot.cancel": "取消",
  "slot.confirmSave": "覆盖存档 {{slot}}？",
  "slot.confirmDelete": "删除存档 {{slot}}？",
  "slot.confirmCopy": "将 {{source}} 覆盖到 {{destination}}？",
  "slot.confirmMove": "将 {{source}} 移动并覆盖到 {{destination}}？",
  "slot.confirmSwap": "交换 {{first}} 与 {{second}}？",
  "slot.copyDone": "已将 {{source}} 复制到 {{destination}}",
  "slot.moveDone": "已将 {{source}} 移动到 {{destination}}",
  "slot.swapDone": "已交换 {{first}} 与 {{second}}",
  "slot.deleteDone": "已删除存档 {{slot}}",
  "slot.invalidId": "请输入有效的存档 ID。",
  "slot.reservedAuto": "auto 由自动存档保留，不能用作手动存档目标。",
  "slot.sameId": "来源和目标 ID 必须不同。",
  "slot.selectTwoExisting": "请选择两个已存在且不同的存档。",
  "slot.previousPage": "上一页",
  "slot.nextPage": "下一页",
  "slot.page": "第 {{current}} / {{total}} 页",
  "slot.listLimited": "仅显示前 512 个存档 ID，另有 {{count}} 个未显示。",
  "log.older": "较早的回声",
  "log.newer": "较新的回声",
  "settings.textSpeed": "文字速度 · {{speed}} 字/秒",
  "settings.textSpeedHelp": "轻触切换：{{slow}} / {{standard}} / {{fast}} / {{instant}}",
  "settings.textSpeedSlow": "慢",
  "settings.textSpeedStandard": "标准",
  "settings.textSpeedFast": "快",
  "settings.textSpeedInstant": "即时",
  "settings.autoDelay": "自动间隔 · {{seconds}} 秒",
  "settings.audio.master": "总音量 · {{percent}}%",
  "settings.audio.music": "音乐 · {{percent}}%",
  "settings.audio.effects": "音效 · {{percent}}%",
  "settings.audio.voice": "语音 · {{percent}}%",
  "settings.textSounds.on": "文字提示音 · 开启",
  "settings.textSounds.off": "文字提示音 · 关闭",
  "settings.muted": "声音 · 已静音",
  "settings.unmuted": "声音 · 开启",
  "settings.hostAudio": "声音由宿主提供",
  "settings.readingPolicy": "跳读始终停在未读文字和选择处。打开手札时，剧情与限时选择会暂停。",
  "settings.locale": "游戏语言 · {{language}}",
  "settings.localeHelp": "轻触切换语言",
  "gallery.count": "已收集 {{count}} / {{total}} 张记忆",
  "gallery.notCollected": "尚未寄达的记忆",
  "gallery.sealed": "封存中",
  "gallery.nextPage": "翻阅下一页",
  "gallery.replaySection": "结局回看",
  "gallery.replay": "回看 · {{title}}",
  "gallery.replayLocked": "抵达对应结局后解锁",
  "gallery.musicSection": "已聆听的配乐",
  "gallery.previewMusic": "试听 · {{title}}",
  "gallery.stopMusicPreview": "停止试听",
  "replay.exit": "返回原旅程",
  "stage.missingModel": "模型资源不存在：{{key}}",
  "input.submit": "提交",
  "input.cancel": "取消",
  "input.defaultText": "请输入文本",
  "input.defaultNumber": "请输入数字",
  "input.defaultBoolean": "请选择一项",
  "input.true": "是",
  "input.false": "否",
  "input.error.required": "请填写此项。",
  "input.error.tooShort": "至少输入 {{limit}} 个字符。",
  "input.error.tooLong": "最多输入 {{limit}} 个字符。",
  "input.error.number": "请输入有效数字。",
  "input.error.integer": "请输入整数。",
  "input.error.min": "数值不能小于 {{limit}}。",
  "input.error.max": "数值不能大于 {{limit}}。",
};

/** English player-shell copy for native input actions and validation. */
export const NOVEL_UI_EN_MESSAGES: Readonly<Record<string, string>> = {
  "panel.inventory": "Travel bag",
  "inventory.balance": "{{currency}} · {{count}}",
  "inventory.quantity": "Owned: {{count}}",
  "inventory.prices": "Buy {{buy}} · Sell {{sell}}",
  "inventory.notSellable": "Not for resale",
  "inventory.limit": "Carry up to {{count}}",
  "inventory.invalid": "Invalid value",
  "inventory.list": "Back to items",
  "inventory.next": "More items · {{page}} / {{total}}",
  "panel.collections": "Journey records",
  "collections.count": "Collected {{count}} / {{total}}",
  "collections.locked": "Continue your journey to unlock this record",
  "collections.list": "Back to records",
  "collections.next": "More records · {{page}} / {{total}}",
  "panel.slots": "Manage saves",
  "panel.note": "Note",
  "player.resumeText": "Tap to continue reading  ›",
  "note.unavailable": "This note is no longer in the current record.",
  "settings.audio.master": "Master · {{percent}}%",
  "settings.audio.music": "Music · {{percent}}%",
  "settings.audio.effects": "Effects · {{percent}}%",
  "settings.audio.voice": "Voice · {{percent}}%",
  "settings.textSounds.on": "Text reveal sounds · On",
  "settings.textSounds.off": "Text reveal sounds · Off",
  "gallery.replaySection": "Story replays",
  "gallery.replay": "Replay · {{title}}",
  "gallery.replayLocked": "Unlock by reaching this ending",
  "gallery.musicSection": "Heard music",
  "gallery.previewMusic": "Preview · {{title}}",
  "gallery.stopMusicPreview": "Stop preview",
  "replay.exit": "Return to journey",
  "slot.auto": "Autosave",
  "slot.quick": "Quick save",
  "slot.quickSave": "Quick save now",
  "slot.quickSaved": "Quick save updated",
  "slot.named": "Save {{slot}}",
  "slot.saved": "Saved {{slot}}",
  "slot.currentJourney": "Saved journey",
  "slot.empty": "Empty save slot",
  "slot.loading": "Loading",
  "slot.readError": "Could not read save",
  "slot.missing": "This save slot is empty",
  "slot.manage": "Manage saves",
  "slot.manageHint": "Choose a source, then enter a destination ID. Overwrite, delete, and swap ask for confirmation.",
  "slot.selected": "Source · {{slot}}",
  "slot.selectedShort": "Selected source",
  "slot.idPlaceholder": "Enter a save ID",
  "slot.create": "Save to this ID",
  "slot.copy": "Copy to ID",
  "slot.move": "Move to ID",
  "slot.swap": "Swap with ID",
  "slot.delete": "Delete source",
  "slot.confirm": "Confirm",
  "slot.cancel": "Cancel",
  "slot.confirmSave": "Overwrite save {{slot}}?",
  "slot.confirmDelete": "Delete save {{slot}}?",
  "slot.confirmCopy": "Overwrite {{destination}} with a copy of {{source}}?",
  "slot.confirmMove": "Move {{source}} to {{destination}} and overwrite it?",
  "slot.confirmSwap": "Swap {{first}} and {{second}}?",
  "slot.copyDone": "Copied {{source}} to {{destination}}",
  "slot.moveDone": "Moved {{source}} to {{destination}}",
  "slot.swapDone": "Swapped {{first}} and {{second}}",
  "slot.deleteDone": "Deleted save {{slot}}",
  "slot.invalidId": "Enter a valid save ID.",
  "slot.reservedAuto": "auto is reserved for autosave.",
  "slot.sameId": "The source and destination IDs must differ.",
  "slot.selectTwoExisting": "Choose two different saved slots.",
  "slot.previousPage": "Previous page",
  "slot.nextPage": "Next page",
  "slot.page": "Page {{current}} of {{total}}",
  "slot.listLimited": "Showing the first 512 save IDs; {{count}} more are hidden.",
  "input.submit": "Submit",
  "input.cancel": "Cancel",
  "input.defaultText": "Enter text",
  "input.defaultNumber": "Enter a number",
  "input.defaultBoolean": "Choose a value",
  "input.true": "True",
  "input.false": "False",
  "input.error.required": "This field is required.",
  "input.error.tooShort": "Enter at least {{limit}} characters.",
  "input.error.tooLong": "Enter no more than {{limit}} characters.",
  "input.error.number": "Enter a valid number.",
  "input.error.integer": "Enter a whole number.",
  "input.error.min": "The value must be at least {{limit}}.",
  "input.error.max": "The value must be no more than {{limit}}.",
  "video.pause": "Pause video",
  "video.resume": "Resume video",
  "video.seekBack": "Back 1s",
  "video.seekStart": "Go to start",
  "video.seekForward": "Forward 1s",
  "video.restart": "Replay",
  "video.close": "Close video",
  "video.error": "Video unavailable: {{detail}}",
};

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyJson(value: unknown, path: string, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoryLocaleCatalogError(`${path} must contain finite numbers`);
    return value;
  }
  if (typeof value !== "object") throw new StoryLocaleCatalogError(`${path} must contain JSON data only`);
  if (seen.has(value)) throw new StoryLocaleCatalogError(`${path} must not be cyclic`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(value).length > 0) throw new StoryLocaleCatalogError(`${path} must not contain symbol keys`);
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new StoryLocaleCatalogError(`${path}[${index}] must be a plain JSON array entry`);
        }
        result.push(copyJson(descriptor.value, `${path}[${index}]`, seen));
      }
      for (const key of Object.keys(descriptors)) {
        if (key !== "length" && !/^\d+$/.test(key)) throw new StoryLocaleCatalogError(`${path} must not have custom array properties`);
      }
      return result;
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new StoryLocaleCatalogError(`${path} must be a plain JSON object`);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new StoryLocaleCatalogError(`${path}.${key} must be a plain JSON property`);
      }
      result[key] = copyJson(descriptor.value, `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function expectObject(value: unknown, path: string): PlainRecord {
  if (!isPlainRecord(value)) throw new StoryLocaleCatalogError(`${path} must be an object`);
  return value;
}

function expectString(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new StoryLocaleCatalogError(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function normalizeLocale(locale: string): string {
  return locale.replaceAll("_", "-").toLowerCase();
}

function validateLocale(locale: unknown, path: string): string {
  if (typeof locale !== "string" || !LOCALE_PATTERN.test(locale)) {
    throw new StoryLocaleCatalogError(`${path} must be a BCP-47-like locale tag`);
  }
  return locale;
}

function stringMap(value: unknown, path: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const map = expectObject(value, path);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(map)) result[key] = expectString(entry, `${path}.${key}`);
  return result;
}

function localeAssets(value: unknown): StoryLocaleAssetOverrides | undefined {
  if (value === undefined) return undefined;
  const assets = expectObject(value, "catalog.assets");
  const unknown = Object.keys(assets).filter((key) => !["backgrounds", "characters", "cgs", "audio", "videos"].includes(key));
  if (unknown.length > 0) throw new StoryLocaleCatalogError(`unknown catalog.assets fields: ${unknown.join(", ")}`);
  const backgrounds = stringMap(assets.backgrounds, "catalog.assets.backgrounds");
  const audio = stringMap(assets.audio, "catalog.assets.audio");
  const videos = stringMap(assets.videos, "catalog.assets.videos");
  const charactersValue = assets.characters === undefined ? {} : expectObject(assets.characters, "catalog.assets.characters");
  const characters: Record<string, Record<string, string>> = {};
  for (const [characterId, expressions] of Object.entries(charactersValue)) {
    characters[characterId] = { ...stringMap(expressions, `catalog.assets.characters.${characterId}`) };
  }
  const cgsValue = assets.cgs === undefined ? {} : expectObject(assets.cgs, "catalog.assets.cgs");
  const cgs: Record<string, { asset: string; title?: string }> = {};
  for (const [cgId, overrideValue] of Object.entries(cgsValue)) {
    const override = expectObject(overrideValue, `catalog.assets.cgs.${cgId}`);
    const unknown = Object.keys(override).filter((key) => key !== "asset" && key !== "title");
    if (unknown.length > 0) throw new StoryLocaleCatalogError(`unknown fields in catalog.assets.cgs.${cgId}: ${unknown.join(", ")}`);
    cgs[cgId] = {
      asset: expectString(override.asset, `catalog.assets.cgs.${cgId}.asset`, false),
      ...(override.title === undefined ? {} : { title: expectString(override.title, `catalog.assets.cgs.${cgId}.title`) }),
    };
  }
  return {
    ...(Object.keys(backgrounds).length === 0 ? {} : { backgrounds }),
    ...(Object.keys(characters).length === 0 ? {} : { characters }),
    ...(Object.keys(cgs).length === 0 ? {} : { cgs }),
    ...(Object.keys(audio).length === 0 ? {} : { audio }),
    ...(Object.keys(videos).length === 0 ? {} : { videos }),
  };
}

/** Parses and validates a JSON locale catalog, rejecting functions and exotic objects. */
export function parseStoryLocaleCatalog(input: unknown): StoryLocaleCatalog {
  let raw: unknown = input;
  if (typeof input === "string") {
    try { raw = JSON.parse(input) as unknown; }
    catch (error) { throw new StoryLocaleCatalogError(`catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const copied = copyJson(raw, "catalog");
  const catalog = expectObject(copied, "catalog");
  if (catalog.format !== CATALOG_FORMAT || catalog.formatVersion !== CATALOG_VERSION) {
    throw new StoryLocaleCatalogError(`catalog format must be ${CATALOG_FORMAT} version ${CATALOG_VERSION}`);
  }
  const allowed = new Set(["format", "formatVersion", "locale", "fallbackLocale", "lines", "sayRich", "speakers", "choices", "inputs", "endings", "replays", "ui", "assets"]);
  const unknown = Object.keys(catalog).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new StoryLocaleCatalogError(`unknown catalog fields: ${unknown.join(", ")}`);

  const locale = validateLocale(catalog.locale, "catalog.locale");
  const fallbackLocale = catalog.fallbackLocale === undefined ? undefined : validateLocale(catalog.fallbackLocale, "catalog.fallbackLocale");
  const lines = stringMap(catalog.lines, "catalog.lines");
  const sayRichValue = catalog.sayRich === undefined ? undefined : expectObject(catalog.sayRich, "catalog.sayRich");
  const sayRich: Record<string, NovelSayRich> = {};
  for (const [lineId, richValue] of Object.entries(sayRichValue ?? {})) {
    const line = lines?.[lineId];
    if (!hasTranslation(line)) throw new StoryLocaleCatalogError(`catalog.sayRich.${lineId} requires a translated line in catalog.lines.${lineId}`);
    const issue = novelSayRichTemplateIssue(line, richValue);
    if (issue !== null) throw new StoryLocaleCatalogError(`catalog.sayRich.${lineId} is invalid: ${issue}`);
    sayRich[lineId] = richValue as unknown as NovelSayRich;
  }
  const choicesValue = catalog.choices === undefined ? {} : expectObject(catalog.choices, "catalog.choices");
  const choices: Record<string, StoryLocaleChoice> = {};
  for (const [choiceId, choiceValue] of Object.entries(choicesValue)) {
    const choice = expectObject(choiceValue, `catalog.choices.${choiceId}`);
    const choiceUnknown = Object.keys(choice).filter((key) => key !== "prompt" && key !== "options");
    if (choiceUnknown.length > 0) throw new StoryLocaleCatalogError(`unknown fields in catalog.choices.${choiceId}: ${choiceUnknown.join(", ")}`);
    choices[choiceId] = {
      ...(choice.prompt === undefined ? {} : { prompt: expectString(choice.prompt, `catalog.choices.${choiceId}.prompt`) }),
      ...(choice.options === undefined ? {} : { options: stringMap(choice.options, `catalog.choices.${choiceId}.options`) }),
    };
  }
  const inputsValue = catalog.inputs === undefined ? {} : expectObject(catalog.inputs, "catalog.inputs");
  const inputs: Record<string, StoryLocaleInput> = {};
  for (const [inputId, inputValue] of Object.entries(inputsValue)) {
    const input = expectObject(inputValue, `catalog.inputs.${inputId}`);
    const inputUnknown = Object.keys(input).filter((key) => key !== "prompt" && key !== "placeholder");
    if (inputUnknown.length > 0) throw new StoryLocaleCatalogError(`unknown fields in catalog.inputs.${inputId}: ${inputUnknown.join(", ")}`);
    inputs[inputId] = {
      ...(input.prompt === undefined ? {} : { prompt: expectString(input.prompt, `catalog.inputs.${inputId}.prompt`) }),
      ...(input.placeholder === undefined ? {} : { placeholder: expectString(input.placeholder, `catalog.inputs.${inputId}.placeholder`) }),
    };
  }
  return {
    format: CATALOG_FORMAT,
    formatVersion: CATALOG_VERSION,
    locale,
    ...(fallbackLocale === undefined ? {} : { fallbackLocale }),
    lines,
    ...(catalog.sayRich === undefined ? {} : { sayRich }),
    speakers: stringMap(catalog.speakers, "catalog.speakers"),
    choices,
    ...(catalog.inputs === undefined ? {} : { inputs }),
    endings: stringMap(catalog.endings, "catalog.endings"),
    ...(catalog.replays === undefined ? {} : { replays: stringMap(catalog.replays, "catalog.replays") }),
    ui: stringMap(catalog.ui, "catalog.ui"),
    ...(catalog.assets === undefined ? {} : { assets: localeAssets(catalog.assets) }),
  };
}

/** Serializes a checked catalog for Editor export or persistent JSON storage. */
export function serializeStoryLocaleCatalog(catalog: StoryLocaleCatalog, pretty = true): string {
  const validated = parseStoryLocaleCatalog(catalog);
  return JSON.stringify(validated, null, pretty ? 2 : undefined);
}

/** Parses the single canonical multi-locale project file. */
export function parseStoryLocaleCatalogCollection(input: unknown): StoryLocaleCatalogCollectionDocument {
  let raw: unknown = input;
  if (typeof input === "string") {
    try { raw = JSON.parse(input) as unknown; }
    catch (error) { throw new StoryLocaleCatalogError(`locale collection is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const copied = copyJson(raw, "locales");
  const document = expectObject(copied, "locales");
  if (document.format !== COLLECTION_FORMAT || document.formatVersion !== COLLECTION_VERSION) {
    throw new StoryLocaleCatalogError(`locale collection format must be ${COLLECTION_FORMAT} version ${COLLECTION_VERSION}`);
  }
  const unknown = Object.keys(document).filter((key) => !["format", "formatVersion", "catalogs"].includes(key));
  if (unknown.length > 0) throw new StoryLocaleCatalogError(`unknown locale collection fields: ${unknown.join(", ")}`);
  const rawCatalogs = expectObject(document.catalogs, "locales.catalogs");
  const catalogs: Record<string, StoryLocaleCatalog> = {};
  const normalizedTags = new Set<string>();
  for (const [key, value] of Object.entries(rawCatalogs)) {
    validateLocale(key, `locales.catalogs.${key}`);
    const catalog = parseStoryLocaleCatalog(value);
    if (normalizeLocale(key) !== normalizeLocale(catalog.locale)) {
      throw new StoryLocaleCatalogError(`locales.catalogs.${key}.locale must match its collection key`);
    }
    const normalized = normalizeLocale(key);
    if (normalizedTags.has(normalized)) throw new StoryLocaleCatalogError(`locale '${key}' duplicates a catalog after case normalization`);
    normalizedTags.add(normalized);
    catalogs[key] = catalog;
  }
  return { format: COLLECTION_FORMAT, formatVersion: COLLECTION_VERSION, catalogs };
}

/** Serializes the canonical multi-locale project file after validating every catalog. */
export function serializeStoryLocaleCatalogCollection(
  collection: StoryLocaleCatalogCollectionDocument,
  pretty = true,
): string {
  return JSON.stringify(parseStoryLocaleCatalogCollection(collection), null, pretty ? 2 : undefined);
}

function placeholders(text: string): string[] {
  const result: string[] = [];
  PLACEHOLDER_PATTERN.lastIndex = 0;
  for (let match = PLACEHOLDER_PATTERN.exec(text); match; match = PLACEHOLDER_PATTERN.exec(text)) result.push(match[1]!);
  return result.sort();
}

function addPlaceholderDiagnostic(
  diagnostics: StoryLocaleDiagnostic[],
  path: string,
  source: string,
  translated: string | undefined,
  code: StoryLocaleDiagnosticCode = "placeholder-mismatch",
): void {
  if (!hasTranslation(translated)) return;
  const expected = placeholders(source);
  const actual = placeholders(translated);
  if (expected.join("\u0000") !== actual.join("\u0000")) {
    diagnostics.push({
      severity: "error",
      code,
      path,
      message: `Expected placeholders [${expected.join(", " )}], found [${actual.join(", ")}].`,
    });
  }
}

function hasTranslation(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function checkAssetOverrides(
  catalog: StoryLocaleCatalog,
  diagnostics: StoryLocaleDiagnostic[],
  registry?: StoryAssetRegistry,
): void {
  const assets = catalog.assets;
  if (!assets) return;
  if (!registry) {
    diagnostics.push({
      severity: "warning",
      code: "asset-registry-required",
      path: "assets",
      message: "Pass the host asset registry to validate locale asset references.",
    });
    return;
  }
  const checkRecord = (
    category: "backgrounds" | "audio" | "videos",
    overrides: Readonly<Record<string, string>> | undefined,
  ): void => {
    if (!overrides) return;
    const base = registry[category] ?? {};
    for (const [target, reference] of Object.entries(overrides)) {
      if (!Object.hasOwn(base, target)) diagnostics.push({ severity: "error", code: "unknown-asset-target", path: `assets.${category}.${target}`, message: `Target asset '${target}' is not registered.` });
      if (!Object.hasOwn(base, reference)) diagnostics.push({ severity: "error", code: "unknown-asset-reference", path: `assets.${category}.${target}`, message: `Replacement asset '${reference}' is not registered.` });
    }
  };
  checkRecord("backgrounds", assets.backgrounds);
  checkRecord("audio", assets.audio);
  checkRecord("videos", assets.videos);
  for (const [characterId, expressions] of Object.entries(assets.characters ?? {})) {
    const base = registry.characters?.[characterId];
    for (const [target, reference] of Object.entries(expressions)) {
      if (!base || !Object.hasOwn(base, target)) diagnostics.push({ severity: "error", code: "unknown-asset-target", path: `assets.characters.${characterId}.${target}`, message: `Target character expression '${characterId}.${target}' is not registered.` });
      if (!base || !Object.hasOwn(base, reference)) diagnostics.push({ severity: "error", code: "unknown-asset-reference", path: `assets.characters.${characterId}.${target}`, message: `Replacement expression '${characterId}.${reference}' is not registered.` });
    }
  }
  for (const [cgId, override] of Object.entries(assets.cgs ?? {})) {
    const target = registry.cgs?.[cgId];
    const reference = registry.cgs?.[override.asset];
    if (!target) diagnostics.push({ severity: "error", code: "unknown-asset-target", path: `assets.cgs.${cgId}`, message: `Target CG '${cgId}' is not registered.` });
    if (!reference) diagnostics.push({ severity: "error", code: "unknown-asset-reference", path: `assets.cgs.${cgId}`, message: `Replacement CG '${override.asset}' is not registered.` });
    if (target?.title !== undefined && override.title !== undefined) addPlaceholderDiagnostic(diagnostics, `assets.cgs.${cgId}.title`, target.title, override.title);
  }
}

/** Escaped stable IDs keep dotted collection and entry IDs unambiguous. */
export function novelCollectionTextKey(collectionId: string, entryId: string | null, field: "title" | "body" = "title"): string {
  const segment = (id: string): string => encodeURIComponent(id).replace(/\./g, "%2E");
  return `collection.${segment(collectionId)}.${entryId === null ? "" : `${segment(entryId)}.`}${field}`;
}

/** Inventory IDs share the same escaped locale.ui convention as records. */
export function novelInventoryTextKey(itemId: string | null, field: "title" | "body" = "title"): string {
  return itemId === null ? "inventory.currency.title" : `inventory.item.${encodeURIComponent(itemId).replace(/\./g, "%2E")}.${field}`;
}

/** Scene-object labels use the existing UI catalog and remain stable across source moves. */
export function novelSceneObjectTextKey(objectId: string): string {
  return `sceneObject.${encodeURIComponent(objectId).replace(/\./g, "%2E")}.label`;
}

/** Source strings share the existing locale.ui catalog, including authored records. */
export function novelSourceUiMessages(assets?: StoryAssetRegistry, story?: Pick<StoryDefinition, "inventory"> & Partial<Pick<StoryDefinition, "script">>): Readonly<Record<string, string>> {
  const messages: Record<string, string> = { ...NOVEL_UI_DEFAULT_MESSAGES };
  for (const [collectionId, collection] of Object.entries(assets?.collections ?? {})) {
    messages[novelCollectionTextKey(collectionId, null)] = collection.title;
    for (const [entryId, entry] of Object.entries(collection.entries)) {
      messages[novelCollectionTextKey(collectionId, entryId)] = entry.title;
      messages[novelCollectionTextKey(collectionId, entryId, "body")] = entry.body;
    }
  }
  if (story?.inventory) {
    messages[novelInventoryTextKey(null)] = story.inventory.currency.title;
    for (const [id, item] of Object.entries(story.inventory.items)) {
      messages[novelInventoryTextKey(id)] = item.title;
      messages[novelInventoryTextKey(id, "body")] = item.body;
    }
  }
  for (const instructions of Object.values(story?.script ?? {})) {
    for (const instruction of instructions) {
      if (instruction.type !== "scene") continue;
      for (const object of instruction.objects ?? []) {
        if (object.interaction) messages[novelSceneObjectTextKey(object.id)] = object.interaction.label;
      }
    }
  }
  return messages;
}

/** Reports missing and extra stable keys, placeholder drift, and asset registry references. */
export function diagnoseStoryLocale(
  story: StoryDefinition,
  catalogInput: StoryLocaleCatalog,
  options: DiagnoseStoryLocaleOptions = {},
): readonly StoryLocaleDiagnostic[] {
  const catalog = parseStoryLocaleCatalog(catalogInput);
  const diagnostics: StoryLocaleDiagnostic[] = [];
  const lines = catalog.lines ?? {};
  const speakers = catalog.speakers ?? {};
  const choices = catalog.choices ?? {};
  const endings = catalog.endings ?? {};
  const ui = catalog.ui ?? {};
  const sourceLines = new Set<string>();
  const sourceRichLines = new Set<string>();
  const sourceSpeakers = new Set<string>();
  const sourceChoices = new Map<string, Extract<StoryInstruction, { type: "choice" }>>();
  const sourceInputs = new Map<string, Extract<StoryInstruction, { type: "input" }>>();
  const sourceEndings = new Map<string, Extract<StoryInstruction, { type: "ending" }>>();
  const sourceReplays = new Set((story.replayEntries ?? []).map(entry => entry.id));

  for (const instructions of Object.values(story.script)) {
    for (const instruction of instructions) {
      if (instruction.type === "say") {
        sourceLines.add(instruction.id);
        if (instruction.rich !== undefined) sourceRichLines.add(instruction.id);
        if (instruction.speaker !== undefined) sourceSpeakers.add(instruction.speaker);
        if (!hasTranslation(lines[instruction.id])) diagnostics.push({ severity: "warning", code: "missing-line", path: `lines.${instruction.id}`, message: `No translation exists for dialogue line '${instruction.id}'.` });
        else addPlaceholderDiagnostic(diagnostics, `lines.${instruction.id}`, instruction.text, lines[instruction.id]);
        if (instruction.rich !== undefined && hasTranslation(lines[instruction.id]) && catalog.sayRich?.[instruction.id] === undefined) {
          diagnostics.push({ severity: "warning", code: "missing-rich-annotations", path: `sayRich.${instruction.id}`, message: `Translated line '${instruction.id}' has no locale-specific annotations; it will be displayed as plain text.` });
        }
        if (instruction.speaker !== undefined && !hasTranslation(speakers[instruction.speaker])) diagnostics.push({ severity: "warning", code: "missing-speaker", path: `speakers.${instruction.speaker}`, message: `No display name exists for speaker '${instruction.speaker}'.` });
      } else if (instruction.type === "choice") {
        sourceChoices.set(instruction.id, instruction);
        const translatedChoice = choices[instruction.id];
        if (!translatedChoice) {
          diagnostics.push({ severity: "warning", code: "missing-choice", path: `choices.${instruction.id}`, message: `No translations exist for choice '${instruction.id}'.` });
          continue;
        }
        if (instruction.prompt !== undefined && !hasTranslation(translatedChoice.prompt)) diagnostics.push({ severity: "warning", code: "missing-prompt", path: `choices.${instruction.id}.prompt`, message: `No translated prompt exists for choice '${instruction.id}'.` });
        else if (instruction.prompt !== undefined) addPlaceholderDiagnostic(diagnostics, `choices.${instruction.id}.prompt`, instruction.prompt, translatedChoice.prompt);
        if (instruction.prompt === undefined && hasTranslation(translatedChoice.prompt)) diagnostics.push({ severity: "warning", code: "extra-prompt", path: `choices.${instruction.id}.prompt`, message: `Catalog defines a prompt where the story has none.` });
        const optionTranslations = translatedChoice.options ?? {};
        const sourceOptions = new Set(instruction.options.map((option) => option.id));
        for (const option of instruction.options) {
          const translated = optionTranslations[option.id];
          if (!hasTranslation(translated)) diagnostics.push({ severity: "warning", code: "missing-option", path: `choices.${instruction.id}.options.${option.id}`, message: `No translated text exists for option '${option.id}'.` });
          else addPlaceholderDiagnostic(diagnostics, `choices.${instruction.id}.options.${option.id}`, option.text, translated);
        }
        for (const optionId of Object.keys(optionTranslations)) if (!sourceOptions.has(optionId)) diagnostics.push({ severity: "warning", code: "extra-option", path: `choices.${instruction.id}.options.${optionId}`, message: `Catalog option '${optionId}' is not present in the story.` });
      } else if (instruction.type === "input") {
        sourceInputs.set(instruction.id, instruction);
        const translatedInput = catalog.inputs?.[instruction.id];
        const sourcePlaceholder = instruction.inputType === "boolean" ? undefined : instruction.placeholder;
        if (!translatedInput) {
          diagnostics.push({ severity: "warning", code: "missing-input", path: `inputs.${instruction.id}`, message: `No translations exist for input '${instruction.id}'.` });
          continue;
        }
        if (instruction.prompt !== undefined && !hasTranslation(translatedInput.prompt)) diagnostics.push({ severity: "warning", code: "missing-input-prompt", path: `inputs.${instruction.id}.prompt`, message: `No translated prompt exists for input '${instruction.id}'.` });
        else if (instruction.prompt !== undefined) addPlaceholderDiagnostic(diagnostics, `inputs.${instruction.id}.prompt`, instruction.prompt, translatedInput.prompt, "input-placeholder-mismatch");
        if (instruction.prompt === undefined && hasTranslation(translatedInput.prompt)) diagnostics.push({ severity: "warning", code: "extra-input-prompt", path: `inputs.${instruction.id}.prompt`, message: `Catalog defines a prompt where the story has none.` });
        if (sourcePlaceholder !== undefined && !hasTranslation(translatedInput.placeholder)) diagnostics.push({ severity: "warning", code: "missing-input-placeholder", path: `inputs.${instruction.id}.placeholder`, message: `No translated placeholder exists for input '${instruction.id}'.` });
        else if (sourcePlaceholder !== undefined) addPlaceholderDiagnostic(diagnostics, `inputs.${instruction.id}.placeholder`, sourcePlaceholder, translatedInput.placeholder, "input-placeholder-mismatch");
        if (sourcePlaceholder === undefined && hasTranslation(translatedInput.placeholder)) diagnostics.push({ severity: "warning", code: "extra-input-placeholder", path: `inputs.${instruction.id}.placeholder`, message: `Catalog defines a placeholder where the story has none.` });
      } else if (instruction.type === "ending") {
        sourceEndings.set(instruction.id, instruction);
        if (instruction.text !== undefined && !hasTranslation(endings[instruction.id])) diagnostics.push({ severity: "warning", code: "missing-ending", path: `endings.${instruction.id}`, message: `No translated text exists for ending '${instruction.id}'.` });
        else if (instruction.text !== undefined) addPlaceholderDiagnostic(diagnostics, `endings.${instruction.id}`, instruction.text, endings[instruction.id]);
      }
    }
  }

  for (const key of Object.keys(lines)) if (!sourceLines.has(key)) diagnostics.push({ severity: "warning", code: "extra-line", path: `lines.${key}`, message: `Catalog line '${key}' is not present in the story.` });
  for (const key of Object.keys(catalog.sayRich ?? {})) if (!sourceRichLines.has(key)) diagnostics.push({ severity: "warning", code: "extra-rich-annotations", path: `sayRich.${key}`, message: `Rich annotations '${key}' do not correspond to a rich dialogue line in the story.` });
  for (const key of Object.keys(speakers)) if (!sourceSpeakers.has(key)) diagnostics.push({ severity: "warning", code: "extra-speaker", path: `speakers.${key}`, message: `Catalog speaker '${key}' is not present in the story.` });
  for (const key of Object.keys(choices)) if (!sourceChoices.has(key)) diagnostics.push({ severity: "warning", code: "extra-choice", path: `choices.${key}`, message: `Catalog choice '${key}' is not present in the story.` });
  for (const key of Object.keys(catalog.inputs ?? {})) if (!sourceInputs.has(key)) diagnostics.push({ severity: "warning", code: "extra-input", path: `inputs.${key}`, message: `Catalog input '${key}' is not present in the story.` });
  for (const key of Object.keys(endings)) if (!sourceEndings.has(key)) diagnostics.push({ severity: "warning", code: "extra-ending", path: `endings.${key}`, message: `Catalog ending '${key}' is not present in the story.` });
  for (const id of sourceReplays) {
    if (!hasTranslation(catalog.replays?.[id])) diagnostics.push({ severity: "warning", code: "missing-replay", path: `replays.${id}`, message: `No translated title exists for replay '${id}'.` });
  }
  for (const id of Object.keys(catalog.replays ?? {})) {
    if (!sourceReplays.has(id)) diagnostics.push({ severity: "warning", code: "extra-replay", path: `replays.${id}`, message: `Replay '${id}' is not present in the story.` });
  }

  const sourceUi = novelSourceUiMessages(options.assetRegistry, story);
  for (const [key, source] of Object.entries(sourceUi)) {
    if (!hasTranslation(ui[key])) diagnostics.push({ severity: "warning", code: "missing-ui", path: `ui.${key}`, message: `No translation exists for Pocket UI message '${key}'.` });
    else addPlaceholderDiagnostic(diagnostics, `ui.${key}`, source, ui[key], "ui-placeholder-mismatch");
  }
  for (const key of Object.keys(ui)) if (!Object.hasOwn(sourceUi, key)) {
    diagnostics.push({ severity: "warning", code: "extra-ui", path: `ui.${key}`, message: `UI message '${key}' is not used by the Pocket player.` });
  }

  checkAssetOverrides(catalog, diagnostics, options.assetRegistry);
  diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  return diagnostics;
}

function localeLookup(catalogs: StoryLocaleCatalogCollection, locale: string): StoryLocaleCatalog | undefined {
  const normalized = normalizeLocale(locale);
  for (const [key, catalog] of Object.entries(catalogs)) {
    if (normalizeLocale(key) === normalized || normalizeLocale(catalog.locale) === normalized) return parseStoryLocaleCatalog(catalog);
  }
  return undefined;
}

function fallbackChain(
  catalogs: StoryLocaleCatalogCollection,
  requestedLocale: string,
  defaultLocale: string | undefined,
): { chain: StoryLocaleCatalog[]; diagnostics: StoryLocaleDiagnostic[] } {
  const chain: StoryLocaleCatalog[] = [];
  const diagnostics: StoryLocaleDiagnostic[] = [];
  const visited = new Set<string>();
  let current: string | undefined = requestedLocale;
  let usedDefault = false;
  while (current !== undefined) {
    const normalized = normalizeLocale(current);
    if (visited.has(normalized)) {
      diagnostics.push({ severity: "error", code: "fallback-cycle", path: `fallback.${current}`, message: `Locale fallback cycle reached '${current}'.` });
      break;
    }
    visited.add(normalized);
    const catalog = localeLookup(catalogs, current);
    if (catalog) {
      chain.push(catalog);
      if (catalog.fallbackLocale !== undefined) {
        current = catalog.fallbackLocale;
        continue;
      }
    }
    const parent: string | undefined = current.includes("-") ? current.slice(0, current.lastIndexOf("-")) : undefined;
    if (parent !== undefined) {
      current = parent;
      continue;
    }
    if (!usedDefault && defaultLocale !== undefined && !visited.has(normalizeLocale(defaultLocale))) {
      current = defaultLocale;
      usedDefault = true;
      continue;
    }
    current = undefined;
  }
  return { chain, diagnostics };
}

function mergedAssetOverrides(chain: readonly StoryLocaleCatalog[]): StoryLocaleAssetOverrides {
  const backgrounds: Record<string, string> = {};
  const characters: Record<string, Record<string, string>> = {};
  const cgs: Record<string, { asset: string; title?: string }> = {};
  const audio: Record<string, string> = {};
  const videos: Record<string, string> = {};
  for (const catalog of [...chain].reverse()) {
    for (const [key, value] of Object.entries(catalog.assets?.backgrounds ?? {})) backgrounds[key] = value;
    for (const [character, expressions] of Object.entries(catalog.assets?.characters ?? {})) {
      characters[character] ??= {};
      Object.assign(characters[character], expressions);
    }
    for (const [key, value] of Object.entries(catalog.assets?.cgs ?? {})) cgs[key] = { ...cgs[key], ...value };
    for (const [key, value] of Object.entries(catalog.assets?.audio ?? {})) audio[key] = value;
    for (const [key, value] of Object.entries(catalog.assets?.videos ?? {})) videos[key] = value;
  }
  return {
    ...(Object.keys(backgrounds).length === 0 ? {} : { backgrounds }),
    ...(Object.keys(characters).length === 0 ? {} : { characters }),
    ...(Object.keys(cgs).length === 0 ? {} : { cgs }),
    ...(Object.keys(audio).length === 0 ? {} : { audio }),
    ...(Object.keys(videos).length === 0 ? {} : { videos }),
  };
}

function lookupText<T>(chain: readonly StoryLocaleCatalog[], lookup: (catalog: StoryLocaleCatalog) => string | undefined, fallback: T): string | T {
  for (const catalog of chain) {
    const value = lookup(catalog);
    if (hasTranslation(value)) return value;
  }
  return fallback;
}

/** Applies catalog text by stable IDs while retaining all story flow and conditions. */
export function localizeStory(
  story: StoryDefinition,
  catalogs: StoryLocaleCatalogCollection,
  requestedLocale: string,
  options: LocalizeStoryOptions = {},
): LocalizedStory {
  validateLocale(requestedLocale, "requestedLocale");
  const resolved = fallbackChain(catalogs, requestedLocale, options.fallbackLocale);
  const chain = resolved.chain;
  const localizedScript: Record<string, readonly StoryInstruction[]> = {};
  for (const [label, instructions] of Object.entries(story.script)) {
    localizedScript[label] = instructions.map((instruction): StoryInstruction => {
      if (instruction.type === "say") {
        const lineCatalog = chain.find(catalog => hasTranslation(catalog.lines?.[instruction.id]));
        const localizedText = lineCatalog?.lines?.[instruction.id] ?? instruction.text;
        const localizedRich = lineCatalog === undefined ? instruction.rich : lineCatalog.sayRich?.[instruction.id];
        const { rich: _sourceRich, ...plainInstruction } = instruction;
        return {
          ...plainInstruction,
          text: localizedText,
          ...(localizedRich === undefined ? {} : { rich: localizedRich }),
          ...(instruction.speaker === undefined ? {} : {
            speaker: lookupText(chain, (catalog) => catalog.speakers?.[instruction.speaker!], instruction.speaker),
          }),
        };
      }
      if (instruction.type === "choice") {
        const localizedChoice = (catalog: StoryLocaleCatalog): StoryLocaleChoice | undefined => catalog.choices?.[instruction.id];
        const prompt = instruction.prompt === undefined
          ? undefined
          : lookupText(chain, (catalog) => localizedChoice(catalog)?.prompt, instruction.prompt);
        const options = instruction.options.map((option) => ({
          ...option,
          text: lookupText(chain, (catalog) => localizedChoice(catalog)?.options?.[option.id], option.text),
        }));
        return { ...instruction, ...(prompt === undefined ? {} : { prompt }), options };
      }
      if (instruction.type === "input") {
        const localizedInput = (catalog: StoryLocaleCatalog): StoryLocaleInput | undefined => catalog.inputs?.[instruction.id];
        const sourcePlaceholder = instruction.inputType === "boolean" ? undefined : instruction.placeholder;
        const prompt = instruction.prompt === undefined
          ? undefined
          : lookupText(chain, (catalog) => localizedInput(catalog)?.prompt, instruction.prompt);
        const placeholder = sourcePlaceholder === undefined
          ? undefined
          : lookupText(chain, (catalog) => localizedInput(catalog)?.placeholder, sourcePlaceholder);
        return {
          ...instruction,
          ...(prompt === undefined ? {} : { prompt }),
          ...(placeholder === undefined ? {} : { placeholder }),
        };
      }
      if (instruction.type === "ending" && instruction.text !== undefined) {
        return {
          ...instruction,
          text: lookupText(chain, (catalog) => catalog.endings?.[instruction.id], instruction.text),
        };
      }
      return instruction;
    });
  }
  const localizedReplays = story.replayEntries?.map(entry => ({
    ...entry,
    title: lookupText(chain, catalog => catalog.replays?.[entry.id], entry.title),
  }));
  const localizedStory: StoryDefinition = {
    ...story,
    script: localizedScript,
    ...(localizedReplays === undefined ? {} : { replayEntries: localizedReplays }),
  };
  const sourceUi = novelSourceUiMessages(options.assetRegistry, story);
  const uiKeys = new Set(["panel.note", "player.resumeText", "note.unavailable", ...Object.keys(sourceUi), ...chain.flatMap((catalog) => Object.keys(catalog.ui ?? {}))]);
  const ui: Record<string, string> = {};
  const uiLocale = chain[0]?.locale ?? requestedLocale;
  const defaultMessages = normalizeLocale(uiLocale).split("-")[0] === "en" ? NOVEL_UI_EN_MESSAGES : NOVEL_UI_DEFAULT_MESSAGES;
  for (const key of uiKeys) {
    const fallback = defaultMessages[key] ?? sourceUi[key] ?? key;
    ui[key] = String(lookupText(chain, (catalog) => catalog.ui?.[key], fallback));
  }
  const selected = chain[0];
  const completenessDiagnostics = selected
    ? diagnoseStoryLocale(story, selected, { assetRegistry: options.assetRegistry })
    : [{ severity: "warning" as const, code: "invalid-locale" as const, path: requestedLocale, message: `No catalog was found for locale '${requestedLocale}'. Source story text is used.` }];
  const fallbackRichDiagnostics: StoryLocaleDiagnostic[] = [];
  for (const instructions of Object.values(story.script)) {
    for (const instruction of instructions) {
      if (instruction.type !== "say" || instruction.rich === undefined) continue;
      const lineCatalog = chain.find(catalog => hasTranslation(catalog.lines?.[instruction.id]));
      if (lineCatalog && lineCatalog.sayRich?.[instruction.id] === undefined) {
        fallbackRichDiagnostics.push({
          severity: "warning", code: "missing-rich-annotations", path: `sayRich.${instruction.id}`,
          message: `Translated line '${instruction.id}' in locale '${lineCatalog.locale}' has no matching annotations; the localized line will be displayed as plain text.`,
        });
      }
    }
  }
  const diagnostics = [...resolved.diagnostics, ...completenessDiagnostics];
  for (const diagnostic of fallbackRichDiagnostics) {
    if (!diagnostics.some(existing => existing.code === diagnostic.code && existing.path === diagnostic.path)) diagnostics.push(diagnostic);
  }
  return {
    locale: requestedLocale,
    fallbackChain: chain.map((catalog) => catalog.locale),
    story: localizedStory,
    assetOverrides: mergedAssetOverrides(chain),
    ui,
    diagnostics,
  };
}

function positionKey(position: ScriptPosition): string {
  return `${position.label}\u0000${position.index}`;
}

function instructionAt(story: StoryDefinition, position: ScriptPosition): StoryInstruction | undefined {
  return story.script[position.label]?.[position.index];
}

function interpolateText(text: string, variables: Readonly<Record<string, JsonValue>>): string {
  return interpolateNovelText(text, variables);
}

/** Recover old rendered placeholder text for backlog entries, which lack historical variable snapshots. */
function recoverRenderedVariables(template: string, rendered: string): ReadonlyMap<string, string> | undefined {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const parts: Array<{ literal?: string; name?: string }> = [];
  let cursor = 0;
  for (let match = PLACEHOLDER_PATTERN.exec(template); match; match = PLACEHOLDER_PATTERN.exec(template)) {
    parts.push({ literal: template.slice(cursor, match.index) });
    parts.push({ name: match[1]! });
    cursor = match.index + match[0].length;
  }
  parts.push({ literal: template.slice(cursor) });
  if (!parts.some((part) => part.name !== undefined)) return rendered === template ? new Map() : undefined;

  let pattern = "^";
  let group = 0;
  const groupForName = new Map<string, number>();
  for (const part of parts) {
    if (part.literal !== undefined) {
      pattern += part.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    const name = part.name!;
    const existing = groupForName.get(name);
    if (existing !== undefined) pattern += `\\k<g${existing}>`;
    else {
      group += 1;
      groupForName.set(name, group);
      pattern += `(?<g${group}>[\\s\\S]*?)`;
    }
  }
  pattern += "$";
  const matched = new RegExp(pattern).exec(rendered);
  if (!matched?.groups) return undefined;
  const values = new Map<string, string>();
  for (const [name, index] of groupForName) values.set(name, matched.groups[`g${index}`]!);
  return values;
}

function interpolationValuesForHistory(
  oldTemplate: string,
  renderedText: string,
  variables: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const values: Record<string, JsonValue> = Object.assign(Object.create(null) as Record<string, JsonValue>, variables);
  for (const [name, value] of recoverRenderedVariables(oldTemplate, renderedText) ?? []) values[name] = value;
  return values;
}

function rebaseSayState(
  active: Extract<ActiveNovelState, { kind: "say" }>,
  oldInstruction: Extract<StoryInstruction, { type: "say" }>,
  newInstruction: Extract<StoryInstruction, { type: "say" }>,
  variables: Readonly<Record<string, JsonValue>>,
  preserveHistoricalInterpolation = false,
): Extract<ActiveNovelState, { kind: "say" }> {
  const resolvedValues = preserveHistoricalInterpolation
    ? interpolationValuesForHistory(oldInstruction.text, active.text, variables)
    : variables;
  const resolved = resolveNovelSayRich(newInstruction.text, resolvedValues, newInstruction.rich);
  const text = resolved.text;
  const points = Array.from(text);
  const oldPointsLength = Array.from(active.text).length;
  const fraction = active.complete ? 1 : oldPointsLength === 0 ? 0 : active.revealProgress / oldPointsLength;
  let revealProgress = active.complete ? points.length : Math.min(points.length, Math.max(0, fraction * points.length));
  let pauseCursor = 0;
  let pause: Extract<ActiveNovelState, { kind: "say" }>["pause"] = null;
  const rich = resolved.rich;
  if (rich !== undefined) {
    const consumedIds = new Set(active.rich?.pauses.slice(0, active.pauseCursor ?? 0).map(marker => marker.id) ?? []);
    if (active.rich === undefined && active.complete) {
      // A legacy completed history entry predates local pause state. Treat its
      // markers as passed instead of reopening old text while rebasing.
      pauseCursor = rich.pauses.length;
    } else {
      while (pauseCursor < rich.pauses.length && consumedIds.has(rich.pauses[pauseCursor]!.id)) pauseCursor++;
    }
    const marker = rich.pauses[pauseCursor];
    if (marker && marker.at <= Math.floor(revealProgress)) {
      revealProgress = marker.at;
      const previous = active.pause?.id === marker.id ? active.pause : undefined;
      pause = marker.durationMs === null
        ? { id: marker.id, remainingMs: null }
        : { id: marker.id, remainingMs: previous?.remainingMs === null || previous?.remainingMs === undefined
          ? marker.durationMs
          : Math.min(marker.durationMs, previous.remainingMs) };
    }
  }
  const revealedCharacters = Math.floor(revealProgress);
  const complete = revealedCharacters >= points.length;
  const readyForAdvance = complete && pause === null && (rich === undefined || pauseCursor >= rich.pauses.length);
  const { rich: _oldRich, pauseCursor: _oldPauseCursor, pause: _oldPause, ...base } = active;
  return {
    ...base,
    speaker: newInstruction.speaker ?? null,
    text,
    ...(rich === undefined ? {} : { rich, pauseCursor, pause }),
    revealProgress,
    revealedCharacters,
    visibleText: points.slice(0, revealedCharacters).join(""),
    complete,
    autoRemainingMs: readyForAdvance ? active.autoRemainingMs : null,
  };
}

function rebaseActiveState(
  active: ActiveNovelState | null,
  sourceStory: StoryDefinition,
  targetStory: StoryDefinition,
  variables: Readonly<Record<string, JsonValue>>,
): ActiveNovelState | null {
  if (active === null) return null;
  const source = instructionAt(sourceStory, active.location);
  const target = instructionAt(targetStory, active.location);
  if (!source || !target || source.type !== active.kind || target.type !== active.kind) {
    throw new StoryLocaleCatalogError(`save active instruction no longer matches ${positionKey(active.location).replaceAll("\u0000", ":")}`);
  }
  if (active.kind === "say" && source.type === "say" && target.type === "say") {
    if (source.id !== active.id || target.id !== active.id) throw new StoryLocaleCatalogError(`say id changed at ${active.location.label}:${active.location.index}`);
    return rebaseSayState(active, source, target, variables);
  }
  if (active.kind === "choice" && source.type === "choice" && target.type === "choice") {
    if (source.id !== active.id || target.id !== active.id) throw new StoryLocaleCatalogError(`choice id changed at ${active.location.label}:${active.location.index}`);
    const targetOptions = new Map(target.options.map((option) => [option.id, option]));
    const options = active.options.map((current) => {
      const option = targetOptions.get(current.id);
      if (!option || option.target !== current.target) throw new StoryLocaleCatalogError(`choice option '${current.id}' changed at ${active.location.label}:${active.location.index}`);
      return { ...current, text: interpolateText(option.text, variables) };
    });
    return { ...active, prompt: target.prompt === undefined ? null : interpolateText(target.prompt, variables), options };
  }
  if (active.kind === "input" && source.type === "input" && target.type === "input") {
    if (source.id !== active.id || target.id !== active.id) throw new StoryLocaleCatalogError(`input id changed at ${active.location.label}:${active.location.index}`);
    if (source.variable !== active.variable || target.variable !== active.variable || source.inputType !== active.inputType || target.inputType !== active.inputType) {
      throw new StoryLocaleCatalogError(`input '${active.id}' changed its variable or type while rebasing a locale`);
    }
    return {
      ...active,
      prompt: target.prompt === undefined ? null : interpolateText(target.prompt, variables),
      placeholder: target.inputType === "boolean" || target.placeholder === undefined ? null : interpolateText(target.placeholder, variables),
    };
  }
  if (active.kind === "ending" && source.type === "ending" && target.type === "ending") {
    if (source.id !== active.id || target.id !== active.id) throw new StoryLocaleCatalogError(`ending id changed at ${active.location.label}:${active.location.index}`);
    return { ...active, text: target.text === undefined ? "" : interpolateText(target.text, variables), cg: target.cg ?? null };
  }
  return active;
}

function rebaseBacklogEntry(
  entry: BacklogEntry,
  sourceStory: StoryDefinition,
  targetStory: StoryDefinition,
  variables: Readonly<Record<string, JsonValue>>,
): BacklogEntry {
  const source = instructionAt(sourceStory, entry.location);
  const target = instructionAt(targetStory, entry.location);
  if (source?.type !== "say" || target?.type !== "say" || source.id !== entry.lineId || target.id !== entry.lineId) {
    throw new StoryLocaleCatalogError(`backlog line '${entry.lineId}' no longer matches ${entry.location.label}:${entry.location.index}`);
  }
  const activeLike = {
    kind: "say" as const,
    location: entry.location,
    id: entry.lineId,
    speaker: entry.speaker,
    portrait: entry.portrait,
    text: entry.text,
    revealProgress: Array.from(entry.text).length,
    visibleText: entry.text,
    revealedCharacters: Array.from(entry.text).length,
    complete: true,
    autoRemainingMs: null,
    ...(entry.rich === undefined ? {} : { rich: entry.rich, pauseCursor: entry.rich.pauses.length, pause: null }),
  };
  const rebased = rebaseSayState(activeLike, source, target, variables, true);
  const { rich: _oldRich, ...plainEntry } = entry;
  return {
    ...plainEntry,
    speaker: rebased.speaker,
    text: rebased.text,
    ...(rebased.rich === undefined ? {} : { rich: rebased.rich }),
  };
}

/**
 * Rebase saved display text onto a localized story without resetting gameplay.
 * Story identity/version, addresses, variables, meta progress, timers, choices,
 * stage, audio intent and rollback cursors are retained. Backlog interpolation
 * is recovered from each entry's old rendered text where its source template
 * makes the values unambiguous; older save data does not retain per-line vars.
 */
export function rebaseNovelSaveDataForLocale(
  savedData: NovelSaveData | NovelSaveDataV2 | NovelSaveDataV3 | NovelSaveDataV4,
  sourceStory: StoryDefinition,
  targetStory: StoryDefinition,
): NovelSaveData {
  const save = decodeNovelSaveData(savedData);
  if (save.storyId !== sourceStory.id || save.storyId !== targetStory.id
    || save.storyVersion !== sourceStory.version || save.storyVersion !== targetStory.version) {
    throw new StoryLocaleCatalogError("save, source story and localized story must have the same id and version");
  }
  const backlog = save.state.backlog.map((entry) => rebaseBacklogEntry(entry, sourceStory, targetStory, save.state.variables));
  const rollbackHistory: RollbackCheckpoint[] = save.state.rollbackHistory.map((checkpoint) => ({
    ...checkpoint,
    active: rebaseActiveState(checkpoint.active, sourceStory, targetStory, checkpoint.variables)!,
  }));
  return {
    ...save,
    state: {
      ...save.state,
      active: rebaseActiveState(save.state.active, sourceStory, targetStory, save.state.variables),
      backlog,
      rollbackHistory,
    },
  };
}

/** Resolves locale asset keys through an existing asset registry without inventing file paths. */
export function applyStoryAssetOverrides<T extends StoryAssetRegistry>(
  registry: T,
  overrides: StoryLocaleAssetOverrides,
): T {
  const diagnostics: StoryLocaleDiagnostic[] = [];
  checkAssetOverrides({
    format: CATALOG_FORMAT,
    formatVersion: CATALOG_VERSION,
    locale: "en",
    assets: overrides,
  }, diagnostics, registry);
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length > 0) throw new StoryLocaleCatalogError(errors.map((entry) => entry.message).join(" "));

  const backgrounds = registry.backgrounds ? { ...registry.backgrounds } : undefined;
  for (const [target, reference] of Object.entries(overrides.backgrounds ?? {})) backgrounds![target] = registry.backgrounds![reference]!;

  const characters = registry.characters ? Object.fromEntries(Object.entries(registry.characters).map(([id, expressions]) => [id, { ...expressions }])) as Record<string, Record<string, string>> : undefined;
  for (const [character, expressions] of Object.entries(overrides.characters ?? {})) {
    for (const [target, reference] of Object.entries(expressions)) characters![character]![target] = registry.characters![character]![reference]!;
  }

  const cgs = registry.cgs ? { ...registry.cgs } : undefined;
  for (const [target, override] of Object.entries(overrides.cgs ?? {})) {
    const current = registry.cgs![target]!;
    const alternate = registry.cgs![override.asset]!;
    cgs![target] = { image: alternate.image, title: override.title ?? current.title };
  }

  const audio = registry.audio ? { ...registry.audio } : undefined;
  for (const [target, reference] of Object.entries(overrides.audio ?? {})) audio![target] = registry.audio![reference]!;

  const videos = registry.videos ? { ...registry.videos } : undefined;
  for (const [target, reference] of Object.entries(overrides.videos ?? {})) videos![target] = registry.videos![reference]!;

  return {
    ...registry,
    ...(backgrounds === undefined ? {} : { backgrounds }),
    ...(characters === undefined ? {} : { characters }),
    ...(cgs === undefined ? {} : { cgs }),
    ...(audio === undefined ? {} : { audio }),
    ...(videos === undefined ? {} : { videos }),
  } as T;
}
