import { renderRichEditor } from "/novel-rich-editor.js";

const root = document.getElementById("novel-editor");
const projectId = document.body.dataset.projectId || "";
const standalonePreview = new URLSearchParams(location.search).get("view") === "preview";
document.body.classList.toggle("nv-standalone-preview", standalonePreview);
const base = `/api/projects/${encodeURIComponent(projectId)}/novel`;
const state = {
  story: null,
  assets: { backgrounds: {}, characters: {}, cgs: {}, audio: {}, models: {} },
  selectedLabel: "",
  dirty: false,
  storyDirty: false,
  assetsDirty: false,
  saving: false,
  building: false,
  panel: standalonePreview ? "preview" : "story",
  interchangeFormat: "json",
  dialogueTableQuery: "",
  dialogueTablePage: 0,
  dialogueTableScope: "dialogue",
  validation: null,
  csrf: "",
  workspaceModules: new Map(),
  workspaceDispose: null,
  authoringDraft: null,
  selectedSceneIndex: 0,
  selectedTimelineId: "",
  engineModule: null,
  spineModule: null,
  live2dModule: null,
  modelSources: Object.create(null),
  modelPreview: { key: "", controller: null, canvas: null, animation: "", skin: "", expression: "", loop: true, running: false, error: "", frameCount: 0, generation: 0 },
  engine: null,
  engineUnsubscribe: null,
  noteDialog: null,
  lastSayLinkSequence: 0,
  executionTraceUnsubscribe: null,
  executionTrace: [],
  executionTraceSequence: 0,
  executionTraceStory: null,
  executionTraceSourceIndex: null,
  executionTraceSourceIndexRevision: -1,
  executionTraceSourceIndexStory: null,
  stageSourceFacts: { background: null, layers: [], characters: new Map() },
  contextPreview: null,
  contextPreviewRootValue: "main",
  contextPreviewEngineRoot: null,
  runtimeError: "",
  snapshot: null,
  audioEvents: [],
  breakpoints: new Set(),
  clockFrameId: 0,
  clockLastTime: 0,
  buildStatus: null,
  assetDiagnostics: [],
  notice: null,
  historyContext: "",
  history: { undo: [], redo: [] },
  historyReady: false,
  historyBlocked: false,
  historyBusy: false,
  historyToken: "",
  historyRevision: 0,
  historyGeneration: 0,
  historySavedGeneration: 0,
  historyTimer: 0,
  historyError: false,
  historyRetries: 0,
  diagnosticTimer: 0,
};

const AUDIO_GROUP_CHOICES = [["", "自动"], ["music", "配乐"], ["effects", "音效"]];

function audioGroupChoices(current) {
  const choices = AUDIO_GROUP_CHOICES.map(choice => [...choice]);
  if (current !== undefined && current !== null && current !== "" && !choices.some(([value]) => String(value) === String(current))) {
    choices.push([String(current), `无效：${current}`]);
  }
  return choices;
}

// A timeline drag edits the shared story draft in place. Its transient state
// contains only the starting value and pointer geometry; history is captured
// once, after release, by reconstructing that one starting atMs value.
let timelinePointerDrag = null;

// The graph canvas keeps only viewport and pointer interaction state here.
// Label positions remain in story.editor.graph.positions; temporary movement
// never mutates the story until a pointer is released.
let graphView = { x: 0, y: 0, scale: 1, initialized: false };
let graphViewBounds = null;
let graphDrag = null;
let graphPan = null;
let graphConnection = null;
let graphResizeObserver = null;
let graphMeasureFrame = 0;

const labels = () => Object.keys(state.story?.script ?? {});
const selectedInstructions = () => state.story?.script?.[state.selectedLabel] ?? [];
const byId = (id) => document.getElementById(id);
const node = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = String(text);
  return value;
};
const button = (text, className, onClick, title) => {
  const value = node("button", `nv-button ${className || ""}`, text);
  value.type = "button";
  if (title) value.title = title;
  value.addEventListener("click", onClick);
  return value;
};
const option = (select, value, label) => {
  const item = node("option", "", label);
  item.value = value;
  select.append(item);
  return item;
};

function ensureModelRegistry() {
  if (!state.assets.models || typeof state.assets.models !== "object" || Array.isArray(state.assets.models)) state.assets.models = {};
  return state.assets.models;
}

function ensureVideoRegistry() {
  if (!state.assets.videos || typeof state.assets.videos !== "object" || Array.isArray(state.assets.videos)) state.assets.videos = {};
  return state.assets.videos;
}

function ensureAtmosphereRegistry() {
  if (!state.assets.atmospheres || typeof state.assets.atmospheres !== "object" || Array.isArray(state.assets.atmospheres)) state.assets.atmospheres = {};
  return state.assets.atmospheres;
}

function ensureChoiceSurfaceRegistry() {
  if (!state.assets.choiceSurfaces || typeof state.assets.choiceSurfaces !== "object" || Array.isArray(state.assets.choiceSurfaces)) state.assets.choiceSurfaces = {};
  return state.assets.choiceSurfaces;
}

function normalizeAssetRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("资源注册表无效。");
  if (!value.models) value.models = {};
  if (typeof value.models !== "object" || Array.isArray(value.models)) throw new Error("模型资源映射无效。");
  if (value.videos !== undefined && (!value.videos || typeof value.videos !== "object" || Array.isArray(value.videos))) throw new Error("视频 cue 映射无效。");
  if (value.atmospheres !== undefined && (!value.atmospheres || typeof value.atmospheres !== "object" || Array.isArray(value.atmospheres))) throw new Error("天气氛围映射无效。");
  if (value.choiceSurfaces !== undefined && (!value.choiceSurfaces || typeof value.choiceSurfaces !== "object" || Array.isArray(value.choiceSurfaces))) throw new Error("剧情选择点击区域映射无效。");
  if (value.collections !== undefined && (!value.collections || typeof value.collections !== "object" || Array.isArray(value.collections))) throw new Error("视觉小说收藏集映射无效。");
  return value;
}

const HISTORY_LIMIT = 32;
const HISTORY_BYTES = 16 * 1024 * 1024;
let historyWrite = Promise.resolve();

function updateHistoryStatus() {
  const status = byId("novel-history-state");
  if (!status) return;
  const phase = state.historyBlocked ? "conflict" : !state.historyReady || state.historyError ? "unavailable" : state.historySavedGeneration < state.historyGeneration ? "pending" : "saved";
  status.dataset.phase = phase;
  status.textContent = { conflict: "历史上下文已改变", unavailable: "历史暂未保存", pending: "正在记住草稿…", saved: "草稿与历史已记住" }[phase];
}

function blockHistory(message) {
  state.historyBlocked = true;
  clearTimeout(state.historyTimer);
  updateHistoryStatus();
  setNotice(message || "源文件或另一窗口的编辑历史已改变，请重新打开项目后继续。当前草稿仍保留在此页，可先导出。", "warning");
}

function historyPayload() {
  const serialize = entries => entries.map(({ scope, key, restore }) => ({ scope, key, restore }));
  let pruned = false;
  for (;;) {
    const body = JSON.stringify({
      expectedToken: state.historyToken,
      expectedHistoryRevision: state.historyRevision,
      draft: { story: state.story, assets: state.assets, authoringDraft: state.authoringDraft },
      undo: serialize(state.history.undo), redo: serialize(state.history.redo),
    });
    if (new Blob([body]).size <= HISTORY_BYTES - 1024) {
      if (pruned) {
        updateHistoryButtons();
        setNotice("草稿与历史已达到体积上限，保留了最近可容纳的撤销与重做步骤。", "warning");
      }
      return body;
    }
    const stack = state.history.undo.length >= state.history.redo.length ? state.history.undo : state.history.redo;
    if (!stack.length) throw new Error("当前草稿超过历史存储体积上限，可导出后分章整理。");
    stack.shift();
    pruned = true;
  }
}

async function persistHistory(allowSaving = false) {
  clearTimeout(state.historyTimer);
  const write = async () => {
    if (timelinePointerDrag || !state.historyReady || state.historyBlocked || state.saving && !allowSaving || state.historySavedGeneration === state.historyGeneration) return;
    const generation = state.historyGeneration;
    try {
      const result = await api(`${base}/history`, { method: "PUT", body: historyPayload() });
      state.historyRevision = result.historyRevision;
      state.historySavedGeneration = generation;
      state.historyError = false;
      state.historyRetries = 0;
    } catch (error) {
      if (error.status === 409 && error.payload?.code === "novel_history_conflict") blockHistory();
      else {
        state.historyError = true;
        if (error.status === 409 && state.historyRetries < 6) {
          const delay = Math.min(30_000, 1000 * 2 ** state.historyRetries++);
          clearTimeout(state.historyTimer);
          state.historyTimer = setTimeout(() => { void persistHistory(); }, delay);
        } else setNotice(`草稿与历史暂未记住：${error.message}。当前页编辑仍保留。`, "warning");
      }
    }
    updateHistoryStatus();
  };
  historyWrite = historyWrite.then(write, write);
  await historyWrite;
}

function scheduleHistory() {
  state.historyGeneration++;
  state.historyRetries = 0;
  updateHistoryStatus();
  clearTimeout(state.historyTimer);
  if (state.historyReady && !state.historyBlocked) state.historyTimer = setTimeout(() => { void persistHistory(); }, 300);
}

async function checkHistoryContext() {
  if (!state.historyReady) return true; // Editing still works if local history IO is unavailable.
  await persistHistory(true);
  if (state.historyBlocked) return false;
  try {
    const current = await api(`${base}/history?head=1`);
    if (current.sourceToken !== state.historyToken || current.historyRevision !== state.historyRevision) {
      blockHistory();
      return false;
    }
    return true;
  } catch (error) {
    setNotice(`无法核对编辑历史：${error.message}。本次操作未执行。`, "warning");
    return false;
  }
}

async function withHistoryContext(action) {
  if (timelinePointerDrag) finishTimelinePointerDrag(false);
  if (state.historyBusy || state.saving || state.historyBlocked) return;
  state.historyBusy = true;
  updateHistoryButtons();
  try { if (await checkHistoryContext()) action(); }
  finally { state.historyBusy = false; updateHistoryButtons(); }
}

async function hydrateHistory() {
  try {
    const result = await api(`${base}/history`);
    state.historyToken = result.sourceToken;
    state.historyRevision = result.historyRevision;
    state.historyReady = true;
    if (result.history) {
      const { draft, undo, redo } = result.history;
      state.storyDirty = JSON.stringify(state.story) !== JSON.stringify(draft.story);
      state.assetsDirty = JSON.stringify(state.assets) !== JSON.stringify(draft.assets);
      state.story = draft.story;
      state.assets = normalizeAssetRegistry(draft.assets);
      state.authoringDraft = draft.authoringDraft ?? null;
      state.dirty = state.storyDirty || state.assetsDirty;
      const hydrate = entries => entries.map(entry => ({ ...entry, groupable: false, groupToken: null }));
      state.history = { undo: hydrate(undo), redo: hydrate(redo) };
      if (state.assetsDirty) state.assetDiagnostics = [];
      if (!Object.hasOwn(state.story.script, state.selectedLabel)) state.selectedLabel = Object.hasOwn(state.story.script, state.story.start) ? state.story.start : Object.keys(state.story.script)[0] || "";
    } else if (result.status) {
      state.notice = { kind: "warning", message: "旧草稿与历史已过期或损坏，本次打开保留磁盘源码。" };
    }
  } catch (error) {
    state.notice = { kind: "warning", message: `无法读取历史：${error.message}。当前页仍可编辑与撤销。` };
  }
}

function historyScope() { return state.panel === "assets" ? "assets" : "story"; }

function captureEditable(scope) {
  if (scope === "project") return { story: structuredClone(state.story), assets: structuredClone(state.assets) };
  return scope === "assets" ? structuredClone(state.assets) : structuredClone(state.story);
}

function updateHistoryButtons() {
  const undo = byId("novel-undo");
  const redo = byId("novel-redo");
  const manuscript = byId("novel-manuscript-button");
  if (manuscript) manuscript.disabled = state.saving || state.historyBusy || state.historyBlocked;
  if (undo) undo.disabled = state.saving || state.historyBusy || state.historyBlocked || state.history.undo.length === 0;
  if (redo) redo.disabled = state.saving || state.historyBusy || state.historyBlocked || state.history.redo.length === 0;
  if (undo) undo.setAttribute("aria-busy", String(state.historyBusy));
  if (redo) redo.setAttribute("aria-busy", String(state.historyBusy));
  if (state.historyBlocked && byId("novel-save")) byId("novel-save").disabled = true;
}

function continuesHistoryGroup(scope, key, groupToken) {
  const previous = state.history.undo.at(-1);
  return Boolean(previous?.groupable && previous.groupToken === groupToken && previous.scope === scope && previous.key === key);
}

function recordHistory(scope, key, before, groupable = false, groupToken = null) {
  const previous = state.history.undo.at(-1);
  const sameTypingAction = groupable && groupToken && previous?.groupable && previous.groupToken === groupToken && previous.scope === scope && previous.key === key;
  if (!sameTypingAction) {
    state.history.undo.push({ scope, key, restore: before, groupable, groupToken });
    if (state.history.undo.length > HISTORY_LIMIT) state.history.undo.shift();
  }
  state.history.redo.length = 0;
  updateHistoryButtons();
}

function applyHistoryValue(scope, value) {
  invalidateStageSourceFacts();
  if (scope === "project" || scope === "story") invalidateContextPreview();
  if (scope === "project") {
    state.story = structuredClone(value.story);
    state.assets = structuredClone(value.assets);
    state.storyDirty = true;
    state.assetsDirty = true;
    if (!Object.hasOwn(state.story.script, state.selectedLabel)) state.selectedLabel = Object.hasOwn(state.story.script, state.story.start) ? state.story.start : Object.keys(state.story.script)[0] || "";
  } else if (scope === "assets") {
    state.assets = structuredClone(value);
    state.assetsDirty = true;
  } else {
    state.story = structuredClone(value);
    state.storyDirty = true;
    if (!Object.hasOwn(state.story.script, state.selectedLabel)) state.selectedLabel = Object.hasOwn(state.story.script, state.story.start) ? state.story.start : Object.keys(state.story.script)[0] || "";
  }
  state.dirty = state.storyDirty || state.assetsDirty;
  state.notice = null;
  renderWorkspace();
  updateHistoryButtons();
  scheduleHistory();
}

function undoEdit() { return withHistoryContext(() => {
  const entry = state.history.undo.pop();
  if (!entry) return;
  state.history.redo.push({ scope: entry.scope, key: entry.key, restore: captureEditable(entry.scope), groupable: false, groupToken: null });
  if (state.history.redo.length > HISTORY_LIMIT) state.history.redo.shift();
  applyHistoryValue(entry.scope, entry.restore);
  updateHistoryButtons();
}); }

function redoEdit() { return withHistoryContext(() => {
  const entry = state.history.redo.pop();
  if (!entry) return;
  state.history.undo.push({ scope: entry.scope, key: entry.key, restore: captureEditable(entry.scope), groupable: false, groupToken: null });
  if (state.history.undo.length > HISTORY_LIMIT) state.history.undo.shift();
  applyHistoryValue(entry.scope, entry.restore);
  updateHistoryButtons();
}); }

function historyMutation(scope, key, mutate) {
  const before = captureEditable(scope);
  mutate();
  recordHistory(scope, key, before, false);
  markDirty(scope);
}

async function api(path, options = {}) {
  const { responseType, ...requestOptions } = options;
  const response = await fetch(path, {
    ...requestOptions,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      "x-pocket-editor": "1",
      ...(state.csrf ? { "x-pocket-csrf": state.csrf } : {}),
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const value = response.ok && responseType === "blob" ? await response.blob()
    : contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(value && typeof value === "object" ? value.error || `${response.status}` : value || `${response.status}`);
    error.payload = value;
    error.status = response.status;
    throw error;
  }
  return value;
}

function setNotice(message, kind = "info") {
  state.notice = message ? { message, kind } : null;
  const notice = byId("novel-notice");
  if (!notice) return;
  notice.hidden = !message;
  notice.textContent = message || "";
  notice.dataset.kind = kind;
}

function clearInvalidContextTargetNotice() {
  if (state.notice?.kind === "error" && state.notice.message === "上下文目标超出标签指令范围。") setNotice("");
}

function downloadJSON(filename, value) {
  downloadText(filename, `${JSON.stringify(value, null, 2)}\n`, "application/json");
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function markDirty(scope = historyScope()) {
  invalidateStageSourceFacts();
  if (scope === "project" || scope === "story") invalidateContextPreview();
  state.dirty = true;
  if (!state.historyBlocked) setNotice("");
  if (scope === "project") state.storyDirty = state.assetsDirty = true;
  else if (scope === "assets") state.assetsDirty = true;
  else state.storyDirty = true;
  if (scope === "project" || scope === "assets") state.assetDiagnostics = [];
  const status = byId("novel-save-state");
  if (status) {
    status.textContent = "未保存";
    status.dataset.dirty = "true";
  }
  const save = byId("novel-save");
  if (save) save.disabled = state.saving || state.historyBlocked;
  scheduleDiagnostics();
  scheduleHistory();
}

function scheduleDiagnostics() {
  clearTimeout(state.diagnosticTimer);
  state.diagnosticTimer = setTimeout(() => {
    const validation = localValidation();
    renderDiagnostics(validation);
    if (state.panel === "assets") {
      const container = byId("novel-asset-diagnostics");
      if (container) renderAssetDiagnostics(container.parentElement);
    }
  }, 160);
}

function localValidation() {
  const script = state.story?.script;
  if (!script || typeof script !== "object" || Array.isArray(script)) {
    return { valid: false, diagnostics: [{ severity: "error", code: "story.script", message: "剧情 script 必须是对象。" }], summary: {} };
  }
  const known = new Set(Object.keys(script));
  const diagnostics = [];
  diagnostics.push(...localCollectionDiagnostics());
  if (typeof state.engineModule?.novelBlueprintMetadataIssue === "function") {
    const issue = state.engineModule.novelBlueprintMetadataIssue(state.story.editor?.blueprint, script);
    if (issue) diagnostics.push({
      severity: "error", code: "story.editor.blueprint", message: issue,
      location: { field: "editor.blueprint" },
    });
  }
  if (typeof state.engineModule?.novelTimelineStoryIssue === "function") {
    const issue = state.engineModule.novelTimelineStoryIssue(state.story);
    if (issue) {
      const path = issue.match(/^(?:story\.timelines|script\.[A-Za-z0-9_.:-]+\[\d+\]\.timeline)(?:\.[A-Za-z0-9_.:-]+|\[\d+\])*/)?.[0] ?? "timelines";
      const sceneLocation = issue.match(/^script\.(.+?)\[(\d+)\]\.(?:timeline|cameraMotion)/);
      diagnostics.push({
        severity: "error",
        code: "story.timeline",
        message: issue,
        location: { field: path, ...(sceneLocation ? { label: sceneLocation[1], index: Number(sceneLocation[2]) } : {}) },
      });
    }
  } else if (state.story.timelines !== undefined) {
    diagnostics.push({ severity: "error", code: "story.timeline.validator", message: "时间轴 schema helper 不可用；请重新打开编辑器后再保存或构建。", location: { field: "timelines" } });
  }
  const assetReferencesCurrent = typeof state.engineModule?.validateNovelAssetReferences === "function";
  if (assetReferencesCurrent) diagnostics.push(...state.engineModule.validateNovelAssetReferences(state.story, state.assets));
  else diagnostics.push({ severity: "error", code: "assets.reference.validator", message: "资源引用 SDK 校验器不可用；请重新打开编辑器后再保存或构建。" });
  for (const [label, instructions] of Object.entries(script)) {
    if (!Array.isArray(instructions)) continue;
    for (const [index, instruction] of instructions.entries()) {
      if (instruction?.type !== "audio") continue;
      const groupIssue = state.engineModule?.novelAuthoredAudioGroupIssue?.(
        instruction.group,
        instruction.action,
        instruction.channel,
        `script.${label}[${index}]`,
      );
      if (groupIssue) diagnostics.push({ severity: "error", code: "instruction.audioGroup", message: groupIssue, location: { label, index, field: "group" } });
      if (state.engineModule?.NOVEL_VOICE_CHANNEL && instruction.channel === state.engineModule.NOVEL_VOICE_CHANNEL) {
        diagnostics.push({ severity: "error", code: "instruction.audioGroup", message: "Dialogue voice channel is reserved.", location: { label, index, field: "channel" } });
      }
    }
  }
  if (state.story.inventory !== undefined && typeof state.engineModule?.validateNovelInventory === "function") {
    const issues = state.engineModule.validateNovelInventory(state.story.inventory, { story: state.story });
    diagnostics.push(...issues.map(issue => ({
      severity: "error",
      code: issue.code,
      message: `${issue.path}: ${issue.message}`,
      location: { field: issue.path },
    })));
  }
  for (const [field, issue] of [
    ["variableDefinitions", state.engineModule.novelVariableDefinitionsIssue(state.story.variableDefinitions)],
    ["replayEntries", state.engineModule.novelReplayEntriesIssue(state.story.replayEntries, script)],
  ]) {
    if (issue) diagnostics.push({ severity: "error", code: `story.${field}`, message: issue, location: { field } });
  }
  const references = [];
  const ids = new Map();
  let lines = 0;
  let choices = 0;
  let endings = 0;
  for (const [label, instructions] of Object.entries(script)) {
    if (!Array.isArray(instructions)) {
      diagnostics.push({ severity: "error", code: "label.instructions", message: `标签 ${label} 的指令列表无效。`, location: { label } });
      continue;
    }
    for (const [index, instruction] of instructions.entries()) {
      if (!instruction || typeof instruction !== "object") {
        diagnostics.push({ severity: "error", code: "instruction.schema", message: `指令 ${index + 1} 无效。`, location: { label, index } });
        continue;
      }
      if (["say", "choice", "input", "ending"].includes(instruction.type)) {
        const id = String(instruction.id ?? "");
        if (!id) diagnostics.push({ severity: "error", code: "id.empty", message: `指令 ${index + 1} 缺少稳定 ID。`, location: { label, index } });
        else if (ids.has(id)) diagnostics.push({ severity: "error", code: "id.duplicate", message: `重复 ID：${id}`, location: { label, index } });
        else ids.set(id, { label, index });
      }
      if (instruction.type === "say") {
        lines++;
        if (instruction.rich !== undefined) {
          const richIssue = typeof state.engineModule?.novelSayRichTemplateIssue === "function"
            ? state.engineModule.novelSayRichTemplateIssue(String(instruction.text ?? ""), instruction.rich)
            : "SDK 富文本校验器不可用；请重新打开编辑器后再保存或构建。";
          if (richIssue) diagnostics.push({ severity: "error", code: "instruction.sayRich", message: `script.${label}[${index}].rich: ${richIssue}`, location: { label, index, field: "rich" } });
        }
      }
      if (instruction.type === "trade") {
        references.push([label, index, instruction.onFailure, "交易失败路由"]);
        if (!Object.hasOwn(state.story.inventory?.items ?? {}, String(instruction.item ?? ""))) {
          diagnostics.push({ severity: "error", code: "instruction.inventory.item", message: `交易指令引用了未登记的库存条目 ${String(instruction.item)}。`, location: { label, index, field: "item" } });
        }
      }
      if (instruction.type === "choice") {
        choices++;
        for (const candidate of instruction.options || []) references.push([label, index, candidate.target, "选项"]);
        if (instruction.timeoutTarget) references.push([label, index, instruction.timeoutTarget, "超时分支"]);
      }
      if (instruction.type === "scene") {
        const issue = state.engineModule?.novelCameraInstructionIssue?.(instruction);
        if (issue) diagnostics.push({ severity: "error", code: "instruction.camera", message: issue, location: { label, index, field: "camera" } });
        const backgroundLayersIssue = state.engineModule?.novelBackgroundLayersInstructionIssue?.(instruction);
        if (backgroundLayersIssue) diagnostics.push({ severity: "error", code: "instruction.backgroundLayers", message: backgroundLayersIssue, location: { label, index, field: "backgroundLayers" } });
        if (instruction.objects !== undefined) {
          const objectsIssue = state.engineModule?.novelSceneObjectsIssue?.(instruction.objects, `script.${label}[${index}].objects`);
          if (objectsIssue) diagnostics.push({ severity: "error", code: "instruction.sceneObjects", message: objectsIssue, location: { label, index, field: "objects" } });
          else if (typeof state.engineModule?.novelSceneObjectsIssue !== "function") diagnostics.push({ severity: "error", code: "instruction.sceneObjects.validator", message: "场景对象 SDK 校验器不可用；请重新打开编辑器后再保存或构建。", location: { label, index, field: "objects" } });
        }
      }
      if (instruction.type === "ending") endings++;
      if (instruction.type === "input") {
        if (instruction.cancelTarget) references.push([label, index, instruction.cancelTarget, "输入取消"]);
        const issue = state.engineModule?.novelInputInstructionIssue(instruction);
        if (issue) diagnostics.push({ severity: "error", code: "instruction.schema", message: issue, location: { label, index } });
      }
      if (instruction.type === "video") {
        const issue = state.engineModule?.novelVideoInstructionIssue(instruction);
        if (issue) diagnostics.push({ severity: "error", code: "instruction.schema", message: issue, location: { label, index } });
      }
      if (instruction.type === "jump" || instruction.type === "call") references.push([label, index, instruction.target, instruction.type]);
      if (instruction.type === "branch") {
        references.push([label, index, instruction.then, "条件为真"]);
        references.push([label, index, instruction.else, "条件为假"]);
      }
    }
  }
  for (const [label, index, target, kind] of references) {
    if (!known.has(target)) diagnostics.push({ severity: "error", code: "reference.label", message: `${kind}引用了不存在的标签 ${String(target)}。`, location: { label, index } });
  }
  if (state.story?.start && !known.has(state.story.start)) diagnostics.push({ severity: "error", code: "story.start.missing", message: `起始标签 ${state.story.start} 不存在。` });
  if (state.validation?.diagnostics) {
    const diagnosticKey = item => `${item.code}:${item.location?.label ?? ""}:${item.location?.index ?? ""}:${item.location?.field ?? ""}`;
    const localCodes = new Set(diagnostics.map(diagnosticKey));
    for (const item of state.validation.diagnostics) {
      if (assetReferencesCurrent && ["assets.reference", "assets.choiceSurface.choice", "assets.choiceSurface.options", "assets.atmosphere.background", "assets.model.animation"].includes(item.code)) continue;
      if (item.code === "story.editor.blueprint" && typeof state.engineModule?.novelBlueprintMetadataIssue === "function") continue;
      if (item.code === "instruction.camera" && typeof state.engineModule?.novelCameraInstructionIssue === "function") continue;
      if (item.code === "instruction.backgroundLayers" && typeof state.engineModule?.novelBackgroundLayersInstructionIssue === "function") continue;
      if (item.code === "instruction.sceneObjects" && typeof state.engineModule?.novelSceneObjectsIssue === "function") continue;
      if (item.code === "instruction.audioGroup" && typeof state.engineModule?.novelAuthoredAudioGroupIssue === "function" && state.engineModule?.NOVEL_VOICE_CHANNEL) continue;
      if (item.location?.field === "rich" && item.location?.label && Number.isInteger(item.location?.index)
          && typeof state.engineModule?.novelSayRichTemplateIssue === "function") continue;
      const key = diagnosticKey(item);
      if (!localCodes.has(key) && !["reference.label", "id.duplicate", "story.variableDefinitions", "story.replayEntries"].includes(item.code)) diagnostics.push(item);
    }
  }
  for (const [label, instructions] of Object.entries(script)) {
    if (!Array.isArray(instructions)) continue;
    for (const [index, instruction] of instructions.entries()) {
      if (instruction?.type !== "scene" || !Array.isArray(instruction.characters)) continue;
      for (const character of instruction.characters) {
        const intent = character?.model;
        const metadata = intent && state.modelSources[intent.key];
        if (!metadata) continue;
        const addModelProblem = (field, message) => {
          const key = `model.runtime.${field}:${label}:${index}:${character.id}`;
          if (!diagnostics.some(item => item.key === key)) diagnostics.push({ severity: "error", code: `model.runtime.${field}`, message, location: { label, index, field: `characters.${character.id}.model.${field}` }, key });
        };
        if (intent.animation && !metadata.animationNames.includes(intent.animation)) addModelProblem("animation", `模型 ${intent.key} 没有动画 ${intent.animation}。`);
        if (intent.skin && !metadata.skinNames.includes(intent.skin)) addModelProblem("skin", `模型 ${intent.key} 没有皮肤 ${intent.skin}。`);
      }
    }
  }
  return {
    valid: !diagnostics.some(item => item.severity === "error"),
    diagnostics,
    summary: { labels: Object.keys(script).length, instructions: Object.values(script).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0), dialogueLines: lines, choices, endings },
  };
}

function field(parent, label, value, onChange, options = {}) {
  const editScope = options.historyScope || historyScope();
  const editKey = options.historyKey || `${editScope}:${state.historyContext}:${label}`;
  const groupToken = {};
  const wrap = node("label", `nv-field ${options.wide ? "wide" : ""} ${options.className || ""}`);
  const caption = node("span", "nv-field-label", label);
  const input = options.multiline ? node("textarea", "nv-input nv-textarea") : node(options.select ? "select" : "input", "nv-input");
  input.setAttribute("aria-label", label);
  if (!options.multiline && !options.select) {
    input.type = options.type || "text";
    if (options.type === "number") {
      input.step = options.step || "1";
      if (options.min !== undefined) input.min = String(options.min);
      if (options.max !== undefined) input.max = String(options.max);
      input.inputMode = "decimal";
    }
  }
  if (options.select) {
    for (const [key, title] of options.select) option(input, key, title);
    input.value = String(value ?? "");
  } else input.value = value === undefined || value === null ? "" : String(value);
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.required) input.required = true;
  if (options.readOnly) input.readOnly = true;
  const eventName = options.select || options.onChangeOnly ? "change" : "input";
  input.addEventListener(eventName, () => {
    if (options.passive) return;
    const next = options.type === "number" ? options.optional && input.value === "" ? undefined : Number(input.value) : input.value;
    if (options.type === "number" && next !== undefined && (!Number.isFinite(next) || options.integer && !Number.isInteger(next) || options.safeInteger && !Number.isSafeInteger(next) || options.min !== undefined && next < options.min || options.max !== undefined && next > options.max)) {
      input.setAttribute("aria-invalid", "true");
      return;
    }
    input.removeAttribute("aria-invalid");
    const canGroup = eventName === "input" && options.type !== "number";
    const before = options.history === false || canGroup && continuesHistoryGroup(editScope, editKey, groupToken) ? null : captureEditable(editScope);
    const accepted = onChange(next);
    if (accepted === false) {
      input.setAttribute("aria-invalid", "true");
      return;
    }
    if (before) recordHistory(editScope, editKey, before, canGroup, groupToken);
    markDirty(editScope);
    if (options.rerender) rerenderWorkspace();
  });
  input.addEventListener("blur", () => {
    const last = state.history.undo.at(-1);
    if (last?.groupToken === groupToken) last.groupable = false;
  });
  wrap.append(caption, input);
  parent.append(wrap);
  return input;
}

function checkbox(parent, label, checked, onChange, options = {}) {
  const scope = options.historyScope || historyScope();
  const key = options.historyKey || `${scope}:${state.historyContext}:${label}`;
  const wrap = node("label", "nv-check");
  const input = node("input");
  input.type = "checkbox";
  input.checked = Boolean(checked);
  input.addEventListener("change", () => {
    const before = captureEditable(scope);
    onChange(input.checked);
    recordHistory(scope, key, before);
    markDirty(scope);
  });
  wrap.append(input, node("span", "", label));
  parent.append(wrap);
  return input;
}

function jsonField(parent, label, value, onChange, options = {}) {
  const scope = options.historyScope || historyScope();
  const historyKey = options.historyKey || `${scope}:${state.historyContext}:${label}`;
  const groupToken = {};
  const input = field(parent, label, JSON.stringify(value, null, 2), () => {}, {
    ...options,
    multiline: true,
    className: `nv-json-field ${options.className || ""}`,
    historyScope: scope,
    historyKey,
    passive: true,
  });
  const help = node("span", "nv-field-help", "使用 JSON 值；不执行脚本或表达式文本。");
  input.addEventListener("input", () => {
    try {
      const parsed = JSON.parse(input.value);
      input.removeAttribute("aria-invalid");
      const before = continuesHistoryGroup(scope, historyKey, groupToken) ? null : captureEditable(scope);
      onChange(parsed);
      if (before) recordHistory(scope, historyKey, before, true, groupToken);
      markDirty(scope);
    } catch {
      input.setAttribute("aria-invalid", "true");
    }
  });
  input.addEventListener("blur", () => {
    const last = state.history.undo.at(-1);
    if (last?.groupToken === groupToken) last.groupable = false;
  });
  input.parentElement.append(help);
  return input;
}

function targetField(parent, label, value, onChange) {
  const names = labels();
  const choices = names.map(name => [name, name]);
  if (value && !names.includes(value)) choices.unshift([value, `缺少：${value}`]);
  field(parent, label, value, onChange, { select: choices });
}

function defaultExpression() { return { type: "variable", name: "" }; }
function defaultCondition() { return { op: "truthy", value: defaultExpression() }; }

function expressionEditor(parent, label, expression, replace) {
  if (!expression || typeof expression !== "object") expression = defaultExpression();
  const box = node("div", "nv-nested");
  box.append(node("div", "nv-nested-title", label));
  field(box, "取值方式", expression.type, type => {
    replace(type === "literal" ? { type, value: null } : { type: "variable", name: "" });
    rerenderInstructionList();
  }, { select: [["variable", "变量"], ["literal", "常量"]] });
  if (expression.type === "variable") {
    field(box, "变量名", expression.name, name => { expression.name = name; });
  } else {
    jsonField(box, "常量值", expression.value, value => { expression.value = value; });
  }
  parent.append(box);
}

function conditionEditor(parent, label, condition, replace, depth = 0) {
  if (!condition || typeof condition !== "object") condition = defaultCondition();
  const box = node("div", "nv-nested");
  box.append(node("div", "nv-nested-title", label));
  const operators = [
    ["truthy", "变量/值为真"], ["falsy", "变量/值为假"], ["eq", "等于"], ["neq", "不等于"],
    ["gt", "大于"], ["gte", "大于或等于"], ["lt", "小于"], ["lte", "小于或等于"],
    ["and", "全部满足"], ["or", "任一满足"], ["not", "取反"],
  ];
  field(box, "条件类型", condition.op, op => {
    if (op === "truthy" || op === "falsy") replace({ op, value: defaultExpression() });
    else if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(op)) replace({ op, left: defaultExpression(), right: { type: "literal", value: null } });
    else if (op === "and" || op === "or") replace({ op, conditions: [defaultCondition(), defaultCondition()] });
    else replace({ op: "not", condition: defaultCondition() });
    rerenderInstructionList();
  }, { select: operators });
  if (condition.op === "truthy" || condition.op === "falsy") {
    expressionEditor(box, "判断值", condition.value, value => { condition.value = value; });
  } else if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(condition.op)) {
    expressionEditor(box, "左侧", condition.left, value => { condition.left = value; });
    expressionEditor(box, "右侧", condition.right, value => { condition.right = value; });
  } else if (condition.op === "not") {
    if (depth < 8) conditionEditor(box, "子条件", condition.condition, value => { condition.condition = value; }, depth + 1);
    else box.append(node("p", "nv-field-help", "条件嵌套已达到编辑上限。"));
  } else if (condition.op === "and" || condition.op === "or") {
    if (!Array.isArray(condition.conditions)) condition.conditions = [];
    condition.conditions.forEach((child, index) => {
      const row = node("div", "nv-condition-child");
      conditionEditor(row, `子条件 ${index + 1}`, child, value => { condition.conditions[index] = value; }, depth + 1);
      row.append(button("移除", "quiet", () => {
        historyMutation("story", `condition:remove:${state.selectedLabel}:${state.historyContext}:${index}`, () => { condition.conditions.splice(index, 1); });
        rerenderInstructionList();
      }));
      box.append(row);
    });
    box.append(button("添加子条件", "quiet", () => {
      historyMutation("story", `condition:add:${state.selectedLabel}:${state.historyContext}`, () => { condition.conditions.push(defaultCondition()); });
      rerenderInstructionList();
    }));
  }
  parent.append(box);
}

function mutateInstruction(index, mutator, rerender = false) {
  const instructions = selectedInstructions();
  const instruction = instructions[index];
  if (!instruction) return;
  mutator(instruction);
  markDirty();
  if (rerender) rerenderInstructionList();
}

function instructionFactory(type) {
  const id = `line_${Math.random().toString(36).slice(2, 8)}`;
  switch (type) {
    case "say": return { type, id, speaker: "旁白", text: "新的对白" };
    case "scene": return { type, background: null, characters: [], transition: { kind: "fade", durationMs: 500 } };
    case "audio": return { type, cue: "", action: "play", channel: "music", loop: true };
    case "video": return { type, action: "play", cue: Object.keys(state.assets.videos ?? {})[0] ?? "", loop: false };
    case "wait": return { type, durationMs: 500 };
    case "input": return { type, id: `input_${id}`, variable: "player_name", inputType: "text", prompt: "如何称呼你？", maxLength: 16 };
    case "set": return { type, variable: "new_variable", value: false };
    case "inc": return { type, variable: "new_variable", amount: 1 };
    case "trade": return { type, item: Object.keys(state.story.inventory?.items ?? {})[0] ?? "", action: "buy", quantity: 1, onFailure: labels()[0] || "" };
    case "branch": return { type, when: defaultCondition(), then: labels()[0] || "", else: labels()[0] || "" };
    case "jump": return { type, target: labels()[0] || "" };
    case "call": return { type, target: labels()[0] || "" };
    case "return": return { type };
    case "choice": return { type, id: `choice_${id}`, prompt: "选择", options: [{ id: "option_a", text: "选项 A", target: labels()[0] || "" }, { id: "option_b", text: "选项 B", target: labels()[0] || "" }] };
    case "ending": return { type, id: `ending_${id}`, text: "故事结束" };
    default: return { type: "say", id, speaker: "旁白", text: "新的对白" };
  }
}

function renderSayRichEditor(parent, instruction, index, textInput) {
  renderRichEditor(parent, instruction, index, textInput, {
    node, button, field,
    issue: state.engineModule?.novelSayRichTemplateIssue,
    scope: state.selectedLabel,
    getInstruction: () => selectedInstructions()[index],
    mutate: (key, action) => historyMutation("story", key, action),
    refresh: rerenderInstructionList,
  });
}

function instructionEditor(parent, instruction, index) {
  state.historyContext = `instruction:${state.selectedLabel}:${index}`;
  const card = node("article", "nv-instruction");
  const header = node("div", "nv-instruction-head");
  const number = node("span", "nv-instruction-number", String(index + 1).padStart(2, "0"));
  const type = node("select", "nv-input nv-type-select");
  const instructionTypes = [["say", "对白"], ["scene", "场景"], ["audio", "音频"], ["video", "视频"], ["wait", "等待"], ["input", "玩家输入"], ["set", "设置变量"], ["inc", "变量增量"], ["branch", "条件分支"], ["jump", "跳转"], ["call", "调用标签"], ["return", "返回"], ["choice", "玩家选择"], ["ending", "结局"]];
  if (Object.keys(state.story.inventory?.items ?? {}).length || instruction.type === "trade") instructionTypes.splice(8, 0, ["trade", "商店交易"]);
  for (const [key, title] of instructionTypes) option(type, key, title);
  type.value = instruction.type || "say";
  type.addEventListener("change", () => {
    historyMutation("story", `instruction:type:${state.selectedLabel}:${index}`, () => { selectedInstructions()[index] = instructionFactory(type.value); });
    rerenderInstructionList();
  });
  header.append(number, type);
  const controls = node("div", "nv-instruction-controls");
  controls.append(
    button("↑", "quiet icon", () => moveInstruction(index, -1), "上移"),
    button("↓", "quiet icon", () => moveInstruction(index, 1), "下移"),
    button("复制", "quiet", () => duplicateInstruction(index)),
    button("删除", "danger quiet", () => removeInstruction(index)),
  );
  header.append(controls);
  card.append(header);
  const fields = node("div", "nv-instruction-fields");
  const update = (key, value) => mutateInstruction(index, target => { target[key] = value; });
  switch (instruction.type) {
    case "say":
      field(fields, "稳定对白 ID", instruction.id, value => update("id", value));
      field(fields, "角色/旁白", instruction.speaker ?? "", value => update("speaker", value));
      {
        const cues = Object.keys(state.assets.audio ?? {}).sort();
        const voiceChoices = [["", "无配音"]];
        if (instruction.voice && !cues.includes(instruction.voice)) voiceChoices.push([instruction.voice, `缺失：${instruction.voice}`]);
        for (const cue of cues) voiceChoices.push([cue, cue]);
        field(fields, "语音 Cue", instruction.voice ?? "", value => {
          if (value) update("voice", value);
          else mutateInstruction(index, target => { delete target.voice; });
        }, { select: voiceChoices });
      }
      field(fields, "表情/肖像键", instruction.portrait ?? "", value => update("portrait", value || undefined));
      field(fields, "对白呈现", instruction.presentation ?? "dialogue", value => mutateInstruction(index, target => {
        if (value === "dialogue") delete target.presentation;
        else target.presentation = value;
      }), { select: [["dialogue", "普通对白"], ["fullscreen", "全屏段落"], ["floating", "浮动文字"]] });
      const textInput = field(fields, "对白文本", instruction.text, value => update("text", value), { multiline: true, wide: true });
      renderSayRichEditor(fields, instruction, index, textInput);
      break;
    case "scene": {
      field(fields, "背景键", instruction.background ?? "", value => update("background", value || null));
      const transition = node("div", "nv-scene-transition");
      const currentTransition = instruction.transition || {};
      field(transition, "转场", currentTransition.kind ?? "cut", value => {
        const next = { ...currentTransition, kind: value };
        if (value !== "reveal") delete next.direction;
        instruction.transition = next;
      }, { select: [["cut", "直接切换"], ["fade", "淡入淡出"], ["dissolve", "溶解"], ["reveal", "揭示"]], rerender: true });
      field(transition, "时长 ms", instruction.transition?.durationMs ?? 0, value => {
        instruction.transition = { ...(instruction.transition || { kind: "cut" }), durationMs: value };
      }, { type: "number", min: 0 });
      if (currentTransition.kind === "reveal") {
        field(transition, "揭示方向", currentTransition.direction ?? "left", value => {
          instruction.transition = { ...(instruction.transition || { kind: "reveal" }), direction: value };
        }, { select: [["left", "从左向右"], ["right", "从右向左"], ["up", "从上向下"], ["down", "从下向上"]] });
      }
      fields.append(transition);

      const timelineRegistry = state.story.timelines && typeof state.story.timelines === "object" && !Array.isArray(state.story.timelines)
        ? state.story.timelines
        : {};
      const timelineChoices = [["", "无时间轴 · 清除旧时间轴"]];
      if (instruction.timeline && !Object.hasOwn(timelineRegistry, instruction.timeline)) {
        timelineChoices.push([instruction.timeline, `缺少预设：${instruction.timeline}`]);
      }
      for (const timelineId of Object.keys(timelineRegistry).sort()) timelineChoices.push([timelineId, timelineId]);
      field(fields, "场景时间轴", instruction.timeline ?? "", value => {
        if (value) instruction.timeline = value;
        else if (Object.hasOwn(instruction, "timeline")) instruction.timeline = null;
      }, { select: timelineChoices });
      const openTimelineEditor = button("编辑时间轴预设", "quiet", () => {
        state.selectedTimelineId = instruction.timeline && Object.hasOwn(timelineRegistry, instruction.timeline) ? instruction.timeline : "";
        state.panel = "timelines";
        rerenderWorkspace();
      });
      fields.append(openTimelineEditor);

      const cameraPanel = node("div", "nv-scene-camera");
      cameraPanel.append(node("div", "nv-section-title", "镜头取景"));
      const cameraValue = instruction.camera && typeof instruction.camera === "object" && !Array.isArray(instruction.camera)
        ? instruction.camera
        : { x: 0, y: 0, scale: 1 };
      const writeCamera = patch => {
        const current = instruction.camera && typeof instruction.camera === "object" && !Array.isArray(instruction.camera)
          ? instruction.camera
          : { x: 0, y: 0, scale: 1 };
        instruction.camera = { ...current, ...patch };
      };
      field(cameraPanel, "镜头平移 X (px)", cameraValue.x ?? 0, value => writeCamera({ x: value }), {
        type: "number", min: -4096, max: 4096, step: "any",
      });
      field(cameraPanel, "镜头平移 Y (px)", cameraValue.y ?? 0, value => writeCamera({ y: value }), {
        type: "number", min: -4096, max: 4096, step: "any",
      });
      field(cameraPanel, "镜头缩放", cameraValue.scale ?? 1, value => writeCamera({ scale: value }), {
        type: "number", min: 0.1, max: 8, step: 0.05,
      });
      cameraPanel.append(node("p", "nv-field-help", "X/Y 是舞台逻辑像素平移；旧场景默认保持原取景。"));

      const currentMotion = () => instruction.cameraMotion && typeof instruction.cameraMotion === "object" && !Array.isArray(instruction.cameraMotion)
        ? instruction.cameraMotion
        : null;
      checkbox(cameraPanel, "镜头过渡", Boolean(currentMotion()), enabled => {
        if (enabled) {
          if (!instruction.camera || typeof instruction.camera !== "object" || Array.isArray(instruction.camera)) {
            instruction.camera = { x: 0, y: 0, scale: 1 };
          }
          const motion = currentMotion();
          instruction.cameraMotion = { ...(motion ?? {}), durationMs: motion?.durationMs ?? 500 };
        } else {
          delete instruction.cameraMotion;
        }
        rerenderInstructionList();
      });
      const motion = currentMotion();
      if (motion) {
        field(cameraPanel, "镜头过渡时长 (ms)", motion.durationMs, value => {
          instruction.cameraMotion = { ...currentMotion(), durationMs: value };
        }, { type: "number", min: 1, max: 30000, step: 1 });
        field(cameraPanel, "镜头缓动", motion.easing ?? "linear", value => {
          const next = { ...currentMotion() };
          if (value === "linear") delete next.easing;
          else next.easing = value;
          instruction.cameraMotion = next;
        }, { select: [["linear", "匀速"], ["easeInOut", "平滑进出"]] });
        checkbox(cameraPanel, "镜头抖动", Boolean(motion.shake), enabled => {
          const next = { ...currentMotion() };
          if (enabled) next.shake = { ...(next.shake ?? {}), amplitude: next.shake?.amplitude ?? 18, cycles: next.shake?.cycles ?? 3 };
          else delete next.shake;
          instruction.cameraMotion = next;
          rerenderInstructionList();
        });
        if (motion.shake) {
          field(cameraPanel, "抖动幅度 (px)", motion.shake.amplitude ?? 18, value => {
            const next = { ...currentMotion() };
            next.shake = { ...(next.shake ?? {}), amplitude: value };
            instruction.cameraMotion = next;
          }, { type: "number", min: 0, max: 512, step: 1 });
          field(cameraPanel, "抖动周期数", motion.shake.cycles ?? 3, value => {
            const next = { ...currentMotion() };
            next.shake = { ...(next.shake ?? {}), cycles: value };
            instruction.cameraMotion = next;
          }, { type: "number", min: 1, max: 20, step: 1 });
        }
      }
      if (instruction.camera !== undefined || instruction.cameraMotion !== undefined) {
        cameraPanel.append(button("移除镜头设置", "danger quiet", () => {
          historyMutation("story", `scene:camera:reset:${state.selectedLabel}:${index}`, () => {
            delete instruction.camera;
            delete instruction.cameraMotion;
          });
          rerenderInstructionList();
        }));
      }
      fields.append(cameraPanel);

      const backgroundLayersPanel = node("div", "nv-scene-background-layers");
      backgroundLayersPanel.append(node("div", "nv-section-title", "背景叠加层"));
      backgroundLayersPanel.append(node("p", "nv-field-help", "按从后到前的顺序叠放。视差 0 固定在视口，1 完整跟随本场景镜头。缺省会继承前一场景的叠加层；空数组会显式清空。"));
      const backgroundKeys = Object.keys(state.assets.backgrounds ?? {}).sort();
      const hasBackgroundLayerConfig = Object.hasOwn(instruction, "backgroundLayers");
      const backgroundLayers = Array.isArray(instruction.backgroundLayers) ? instruction.backgroundLayers : [];
      if (!hasBackgroundLayerConfig) {
        backgroundLayersPanel.append(node("p", "nv-field-help nv-background-layer-mode", "当前：继承上一场景的叠加层；起始场景没有可继承的叠加层。"));
      } else if (!Array.isArray(instruction.backgroundLayers)) {
        backgroundLayersPanel.append(node("p", "nv-runtime-error nv-background-layer-mode", "当前叠加层数据不是数组；可恢复继承或添加一层来修复。"));
      } else if (backgroundLayers.length === 0) {
        backgroundLayersPanel.append(node("p", "nv-field-help nv-background-layer-mode", "当前：显式清空，不继承上一场景的叠加层。"));
      } else {
        backgroundLayersPanel.append(node("p", "nv-field-help nv-background-layer-mode", `当前：显式设置 ${backgroundLayers.length} 层，不继承上一场景的叠加层。`));
      }
      if (hasBackgroundLayerConfig) {
        backgroundLayersPanel.append(button("继承上一场景", "quiet", () => {
          historyMutation("story", `scene:background-layer:inherit:${state.selectedLabel}:${index}`, () => { delete instruction.backgroundLayers; });
          rerenderInstructionList();
        }));
      } else {
        backgroundLayersPanel.append(button("清空并停止继承", "quiet", () => {
          historyMutation("story", `scene:background-layer:clear:${state.selectedLabel}:${index}`, () => { instruction.backgroundLayers = []; });
          rerenderInstructionList();
        }));
      }
      const writeBackgroundLayer = (layerIndex, patch) => {
        const next = Array.isArray(instruction.backgroundLayers) ? [...instruction.backgroundLayers] : [];
        const existing = next[layerIndex];
        const layerValue = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
        next[layerIndex] = { ...layerValue, ...patch };
        instruction.backgroundLayers = next;
      };
      backgroundLayers.forEach((layer, layerIndex) => {
        const row = node("div", "nv-background-layer-row");
        const cueChoices = [["", "选择背景键"]];
        if (layer?.background && !backgroundKeys.includes(layer.background)) cueChoices.push([layer.background, `缺少背景：${layer.background}`]);
        for (const key of backgroundKeys) cueChoices.push([key, key]);
        field(row, `背景层 ${layerIndex + 1} 背景键`, layer?.background ?? "", value => { writeBackgroundLayer(layerIndex, { background: value }); }, { select: cueChoices });
        field(row, `背景层 ${layerIndex + 1} 视差 (0–1)`, layer?.parallax ?? 0, value => { writeBackgroundLayer(layerIndex, { parallax: value }); }, { type: "number", min: 0, max: 1, step: "any" });
        const controls = node("div", "nv-inline-actions");
        const up = button("上移", "quiet", () => {
          historyMutation("story", `scene:background-layer:order:${state.selectedLabel}:${index}`, () => {
            [instruction.backgroundLayers[layerIndex - 1], instruction.backgroundLayers[layerIndex]] = [instruction.backgroundLayers[layerIndex], instruction.backgroundLayers[layerIndex - 1]];
          });
          rerenderInstructionList();
        });
        up.disabled = layerIndex === 0;
        const down = button("下移", "quiet", () => {
          historyMutation("story", `scene:background-layer:order:${state.selectedLabel}:${index}`, () => {
            [instruction.backgroundLayers[layerIndex + 1], instruction.backgroundLayers[layerIndex]] = [instruction.backgroundLayers[layerIndex], instruction.backgroundLayers[layerIndex + 1]];
          });
          rerenderInstructionList();
        });
        down.disabled = layerIndex === backgroundLayers.length - 1;
        controls.append(up, down, button("移除背景层", "danger quiet", () => {
          historyMutation("story", `scene:background-layer:remove:${state.selectedLabel}:${index}:${layerIndex}`, () => {
            instruction.backgroundLayers = instruction.backgroundLayers.filter((_item, currentIndex) => currentIndex !== layerIndex);
          });
          rerenderInstructionList();
        }));
        row.append(controls);
        backgroundLayersPanel.append(row);
      });
      if (hasBackgroundLayerConfig && Array.isArray(instruction.backgroundLayers) && !backgroundLayers.length) backgroundLayersPanel.append(node("div", "nv-empty", "叠加层列表为空。"));
      const backgroundLayerLimit = state.engineModule?.NOVEL_BACKGROUND_LAYER_LIMITS?.count ?? 8;
      const addBackgroundLayer = button("＋ 添加背景层", "quiet", () => {
        if (!backgroundKeys.length) return;
        historyMutation("story", `scene:background-layer:add:${state.selectedLabel}:${index}`, () => {
          const existing = Array.isArray(instruction.backgroundLayers) ? instruction.backgroundLayers : [];
          instruction.backgroundLayers = [...existing, { background: backgroundKeys[0], parallax: 0.5 }];
        });
        rerenderInstructionList();
      });
      addBackgroundLayer.disabled = backgroundKeys.length === 0 || backgroundLayers.length >= backgroundLayerLimit;
      if (backgroundLayers.length >= backgroundLayerLimit) addBackgroundLayer.title = `最多添加 ${backgroundLayerLimit} 层。`;
      backgroundLayersPanel.append(addBackgroundLayer);
      fields.append(backgroundLayersPanel);

      const sceneObjectsPanel = node("div", "nv-scene-objects");
      sceneObjectsPanel.append(node("div", "nv-section-title", "自由场景对象"));
      sceneObjectsPanel.append(node("p", "nv-field-help", "每个对象复用已登记背景图片键，frame 是归一化舞台矩形；crop 是归一化源图裁剪矩形。interaction.hit 独立于可见框，坐标相对对象 frame。省略 objects 会继承前一场景对象，[] 会显式清空，非空数组完整替换。仅运行中的对白可触发交互；effects 仅支持 set/inc，不推进对白。可在舞台编辑中添加、拖动和分层对象；此处 JSON 用于精确编辑来源图、裁剪和命中区域。"));
      const objectsField = jsonField(sceneObjectsPanel, "场景对象 JSON", instruction.objects ?? [], value => update("objects", value), {
        wide: true,
        className: "nv-scene-objects-json",
      });
      objectsField.dataset.location = `${state.selectedLabel}:${index}`;
      objectsField.dataset.sceneObjectsJson = "true";
      const objectActions = node("div", "nv-inline-actions nv-scene-object-actions");
      const inheritObjects = button("继承前一场景对象", "quiet", () => {
        historyMutation("story", `scene:objects:inherit:${state.selectedLabel}:${index}`, () => { delete instruction.objects; });
        rerenderInstructionList();
      });
      inheritObjects.dataset.sceneObjectsInherit = "true";
      inheritObjects.dataset.location = `${state.selectedLabel}:${index}`;
      inheritObjects.disabled = !Object.hasOwn(instruction, "objects");
      const clearObjects = button("清空对象", "quiet", () => {
        historyMutation("story", `scene:objects:clear:${state.selectedLabel}:${index}`, () => { instruction.objects = []; });
        rerenderInstructionList();
      });
      clearObjects.dataset.sceneObjectsClear = "true";
      clearObjects.dataset.location = `${state.selectedLabel}:${index}`;
      objectActions.append(inheritObjects, clearObjects);
      sceneObjectsPanel.append(objectActions);
      fields.append(sceneObjectsPanel);

      fields.append(node("div", "nv-section-title", "场景角色"));
      const characters = Array.isArray(instruction.characters) ? instruction.characters : [];
      characters.forEach((character, charIndex) => {
        const row = node("div", "nv-character-row");
        field(row, "角色 ID", character.id ?? "", value => { character.id = value; });
        field(row, "表情键", character.expression ?? "neutral", value => { character.expression = value; });
        const models = ensureModelRegistry();
        const modelChoices = [["", "静态立绘"]];
        for (const [key, definition] of Object.entries(models)) modelChoices.push([key, `${key} · ${definition.kind === "spine" ? "Spine" : "Live2D"}`]);
        const currentModelKey = character.model?.key ?? "";
        if (currentModelKey && !models[currentModelKey]) modelChoices.push([currentModelKey, `缺少模型：${currentModelKey}`]);
        field(row, "动态模型", currentModelKey, value => {
          if (!value) character.model = null;
          else {
            const definition = models[value];
            const info = state.modelSources[value];
            const animation = info?.animationNames?.[0] ?? definition?.animations?.[0];
            character.model = { key: value, loop: true, ...(animation ? { animation } : {}) };
          }
          rerenderInstructionList();
        }, { select: modelChoices });
        const model = character.model;
        if (model?.key) {
          const definition = models[model.key];
          const modelInfo = state.modelSources[model.key];
          const animations = modelInfo?.animationNames ?? definition?.animations ?? [];
          const animationChoices = [["", "使用默认动作"]];
          for (const animation of animations) animationChoices.push([animation, animation]);
          if (model.animation && !animationChoices.some(([key]) => key === model.animation)) animationChoices.push([model.animation, `缺少动作：${model.animation}`]);
          if (animations.length) {
            field(row, "动作", model.animation ?? "", value => { character.model = { ...model, animation: value || undefined }; }, { select: animationChoices });
          } else {
            field(row, "动作", model.animation ?? "", value => { character.model = { ...model, animation: value || undefined }; }, { placeholder: definition?.kind === "live2d" ? "Live2D 动作组索引，例如 Idle:0" : "读取模型信息或输入 Spine 动画名" });
          }
          checkbox(row, "循环动作", model.loop !== false, value => { character.model = { ...model, loop: value }; });
          if (definition?.kind === "live2d") {
            field(row, "Live2D 表情", model.expression ?? "", value => { character.model = { ...model, expression: value || undefined }; }, { placeholder: "模型中定义的表情名" });
          } else {
            const skins = modelInfo?.skinNames ?? [];
            if (skins.length) {
              const skinChoices = [["", "使用默认皮肤"]];
              for (const skin of skins) skinChoices.push([skin, skin]);
              if (model.skin && !skinChoices.some(([key]) => key === model.skin)) skinChoices.push([model.skin, `缺少皮肤：${model.skin}`]);
              field(row, "Spine 皮肤", model.skin ?? "", value => { character.model = { ...model, skin: value || undefined }; }, { select: skinChoices });
            } else {
              field(row, "Spine 皮肤", model.skin ?? "", value => { character.model = { ...model, skin: value || undefined }; }, { placeholder: "可先读取 Spine 模型信息" });
            }
          }
        }
        field(row, "位置", typeof character.position === "string" ? character.position : "custom", value => {
          if (value === "custom") character.position = { x: 0, y: 0 };
          else character.position = value;
          rerenderInstructionList();
        }, { select: [["left", "左"], ["center", "中"], ["right", "右"], ["custom", "自定义坐标"]] });
        if (character.position && typeof character.position === "object") {
          field(row, "X", character.position.x, value => { character.position.x = value; }, { type: "number" });
          field(row, "Y", character.position.y, value => { character.position.y = value; }, { type: "number" });
        }
        field(row, "缩放", character.scale ?? 1, value => { character.scale = value; }, { type: "number", min: 0.05, max: 8, step: 0.05 });
        field(row, "旋转角度", character.rotation ?? 0, value => { character.rotation = value; }, { type: "number", min: -360, max: 360, step: "any" });
        field(row, "图层", character.layer ?? 0, value => { if (!Number.isInteger(value)) return false; character.layer = value; }, { type: "number", min: -1024, max: 1024, step: 1 });
        checkbox(row, "显示", character.visible !== false, value => { character.visible = value; });
      row.append(button("移除角色", "danger quiet", () => {
        historyMutation("story", `scene:character:remove:${state.selectedLabel}:${index}:${charIndex}`, () => { characters.splice(charIndex, 1); instruction.characters = characters; });
        rerenderInstructionList();
      }));
        fields.append(row);
      });
      fields.append(button("添加角色", "quiet", () => {
        historyMutation("story", `scene:character:add:${state.selectedLabel}:${index}`, () => { instruction.characters = [...characters, { id: "new_character", expression: "neutral", position: "center", visible: true }]; });
        rerenderInstructionList();
      }));
      break;
    }
    case "audio": {
      field(fields, "音频 cue", instruction.cue, value => update("cue", value));
      let groupField;
      field(fields, "动作", instruction.action ?? "play", value => {
        mutateInstruction(index, target => {
          target.action = value;
          if (value === "stop") delete target.group;
        });
        if (value === "stop" && groupField) groupField.value = "";
      }, { select: [["play", "播放"], ["stop", "停止"]] });
      field(fields, "声道", instruction.channel ?? "", value => {
        mutateInstruction(index, target => {
          if (value) target.channel = value;
          else {
            delete target.channel;
            delete target.group;
          }
        });
        if (!value && groupField) groupField.value = "";
      }, { placeholder: "例如 music 或 sfx；使用混音分组时必填" });
      groupField = field(fields, "混音分组", instruction.group ?? "", value => mutateInstruction(index, target => {
        if (value) target.group = value;
        else delete target.group;
      }), { select: audioGroupChoices(instruction.group) });
      checkbox(fields, "循环播放", instruction.loop ?? false, value => update("loop", value));
      break;
    }
    case "video": {
      const action = instruction.action ?? "play";
      field(fields, "视频动作", action, value => {
        mutateInstruction(index, target => {
          target.action = value;
          if (value === "play") {
            delete target.positionMs;
            if (typeof target.cue !== "string") target.cue = Object.keys(state.assets.videos ?? {})[0] ?? "";
            if (typeof target.loop !== "boolean") target.loop = false;
          } else if (value === "seek") {
            delete target.cue;
            delete target.loop;
            if (!Number.isSafeInteger(target.positionMs) || target.positionMs < 0) target.positionMs = 0;
          } else {
            delete target.cue;
            delete target.loop;
            delete target.positionMs;
          }
        });
      }, { select: [["play", "播放"], ["pause", "暂停"], ["close", "关闭"], ["seek", "定位"]], rerender: true });
      if (action === "play") {
        const cues = Object.keys(state.assets.videos ?? {}).sort();
        const choices = [["", cues.length ? "选择视频 cue" : "尚未注册视频 cue"]];
        if (instruction.cue && !cues.includes(instruction.cue)) choices.push([instruction.cue, `缺失：${instruction.cue}`]);
        for (const cue of cues) choices.push([cue, cue]);
        field(fields, "稳定视频 cue", instruction.cue ?? "", value => update("cue", value), { select: choices });
        checkbox(fields, "循环播放", instruction.loop ?? false, value => update("loop", value));
        if (!cues.length) fields.append(node("p", "nv-field-help", "请先在视觉与音频资源中注册一个项目内 MP4。"));
      } else if (action === "seek") {
        field(fields, "定位毫秒", instruction.positionMs, value => update("positionMs", value), { type: "number", integer: true, min: 0, step: 1 });
        fields.append(node("p", "nv-field-help", "定位范围由实际播放器时长决定；超出当前视频时长的指令会被拒绝。"));
      } else {
        fields.append(node("p", "nv-field-help", action === "pause" ? "暂停当前视频；未播放时不改变舞台。" : "关闭当前视频浮层。"));
      }
      break;
    }
    case "wait": field(fields, "等待时长 ms", instruction.durationMs, value => update("durationMs", value), { type: "number" }); break;
    case "input": {
      if (!state.engineModule) void loadRuntime().then(scheduleDiagnostics).catch(error => setNotice(error.message, "error"));
      field(fields, "稳定输入 ID", instruction.id, value => update("id", value));
      field(fields, "写入变量", instruction.variable, value => update("variable", value));
      field(fields, "输入类型", instruction.inputType, value => {
        mutateInstruction(index, target => {
          target.inputType = value;
          for (const key of ["defaultValue", "minLength", "maxLength", "min", "max", "integer"]) delete target[key];
          if (value === "boolean") delete target.placeholder;
        });
      }, { select: [["text", "文本"], ["number", "数字"], ["boolean", "布尔确认"]], rerender: true });
      field(fields, "输入提示", instruction.prompt ?? "", value => update("prompt", value), { multiline: true, wide: true });
      const optional = (key, value) => mutateInstruction(index, target => { if (value === undefined) delete target[key]; else target[key] = value; });
      if (instruction.inputType !== "boolean") {
        field(fields, "输入占位提示", instruction.placeholder ?? "", value => update("placeholder", value));
        field(fields, "输入默认值", instruction.defaultValue, value => optional("defaultValue", value === "" ? undefined : value), instruction.inputType === "number" ? { type: "number", optional: true } : {});
      } else checkbox(fields, "布尔默认值", instruction.defaultValue ?? false, value => update("defaultValue", value));
      if (instruction.inputType === "text") {
        field(fields, "最少字符数", instruction.minLength, value => optional("minLength", value), { type: "number", optional: true, integer: true, min: 0, max: 4096 });
        field(fields, "最多字符数", instruction.maxLength, value => optional("maxLength", value), { type: "number", optional: true, integer: true, min: 0, max: 4096 });
      } else if (instruction.inputType === "number") {
        field(fields, "数值下限", instruction.min, value => optional("min", value), { type: "number", optional: true });
        field(fields, "数值上限", instruction.max, value => optional("max", value), { type: "number", optional: true });
        checkbox(fields, "仅允许整数", instruction.integer ?? false, value => update("integer", value));
      }
      field(fields, "输入取消目标", instruction.cancelTarget ?? "", value => mutateInstruction(index, target => { if (value) target.cancelTarget = value; else delete target.cancelTarget; }), { select: [["", "不允许取消"], ...labels().map(label => [label, label])] });
      fields.append(node("p", "nv-field-help", "校验通过并提交后才写入变量；取消不写入，自动和跳过会停在输入处。"));
      break;
    }
    case "set":
      field(fields, "变量名", instruction.variable, value => update("variable", value));
      jsonField(fields, "变量值", instruction.value, value => update("value", value));
      break;
    case "inc":
      field(fields, "变量名", instruction.variable, value => update("variable", value));
      field(fields, "增加量", instruction.amount, value => update("amount", value), { type: "number" });
      break;
    case "trade": {
      const items = state.story.inventory?.items ?? {};
      const itemChoices = [["", Object.keys(items).length ? "选择库存条目" : "尚未配置库存条目"]];
      if (instruction.item && !Object.hasOwn(items, instruction.item)) itemChoices.push([instruction.item, `缺失条目：${instruction.item}`]);
      for (const [itemId, item] of Object.entries(items)) itemChoices.push([itemId, `${item?.title || itemId} · ${itemId}`]);
      field(fields, "交易条目", instruction.item ?? "", value => update("item", value), { select: itemChoices });
      const actionChoices = [["buy", "购买"], ["sell", "出售"], ["consume", "消耗"]];
      if (instruction.action && !actionChoices.some(([action]) => action === instruction.action)) actionChoices.unshift([instruction.action, `缺失动作：${instruction.action}`]);
      field(fields, "交易动作", instruction.action, value => update("action", value), { select: actionChoices });
      field(fields, "交易数量", instruction.quantity, value => update("quantity", value), { type: "number", safeInteger: true, min: 1, step: 1 });
      targetField(fields, "失败时跳转", instruction.onFailure ?? "", value => update("onFailure", value));
      fields.append(node("p", "nv-field-help", "购买、出售或消耗失败时跳转到指定标签；条目和数量引用由共享故事校验器检查。"));
      if (!Object.keys(items).length) fields.append(button("打开库存与商店", "quiet", () => { state.panel = "inventory"; rerenderWorkspace(); }));
      break;
    }
    case "branch":
      conditionEditor(fields, "分支条件", instruction.when, value => { instruction.when = value; markDirty(); });
      targetField(fields, "条件为真时", instruction.then, value => update("then", value));
      targetField(fields, "条件为假时", instruction.else, value => update("else", value));
      break;
    case "jump":
    case "call": targetField(fields, "目标标签", instruction.target, value => update("target", value)); break;
    case "return": fields.append(node("p", "nv-field-help", "返回到最近一次调用此标签的位置。")); break;
    case "choice": {
      field(fields, "稳定选择 ID", instruction.id, value => update("id", value));
      field(fields, "选择提示", instruction.prompt ?? "", value => update("prompt", value));
      if (instruction.timeLimitMs !== undefined) {
        field(fields, "限时 ms", instruction.timeLimitMs, value => update("timeLimitMs", value), { type: "number" });
        targetField(fields, "超时目标", instruction.timeoutTarget ?? "", value => update("timeoutTarget", value));
      } else {
        fields.append(button("添加限时", "quiet", () => {
          historyMutation("story", `choice:timer:add:${state.selectedLabel}:${index}`, () => { instruction.timeLimitMs = 10_000; instruction.timeoutTarget = labels()[0] || ""; });
          rerenderInstructionList();
        }));
      }
      fields.append(node("div", "nv-section-title", "选择选项"));
      const options = Array.isArray(instruction.options) ? instruction.options : [];
      options.forEach((choiceOption, optionIndex) => {
        const row = node("div", "nv-choice-row");
        const rowHead = node("div", "nv-row-head", `选项 ${optionIndex + 1}`);
        rowHead.append(button("↑", "quiet icon", () => reorderChoice(index, optionIndex, -1)), button("↓", "quiet icon", () => reorderChoice(index, optionIndex, 1)), button("移除", "danger quiet", () => {
          historyMutation("story", `choice:option:remove:${state.selectedLabel}:${index}:${optionIndex}`, () => { options.splice(optionIndex, 1); instruction.options = options; });
          rerenderInstructionList();
        }));
        row.append(rowHead);
        field(row, "选项 ID", choiceOption.id, value => { choiceOption.id = value; });
        field(row, "选项文本", choiceOption.text, value => { choiceOption.text = value; }, { multiline: true });
        targetField(row, "目标标签", choiceOption.target, value => { choiceOption.target = value; });
        const conditionToggle = node("label", "nv-check");
        const conditionInput = node("input");
        conditionInput.type = "checkbox";
        conditionInput.checked = !!choiceOption.when;
        conditionInput.addEventListener("change", () => {
          historyMutation("story", `choice:condition:${state.selectedLabel}:${index}:${optionIndex}`, () => {
            if (conditionInput.checked) choiceOption.when = defaultCondition();
            else delete choiceOption.when;
          });
          rerenderInstructionList();
        });
        conditionToggle.append(conditionInput, node("span", "", "显示条件"));
        row.append(conditionToggle);
        if (choiceOption.when) conditionEditor(row, "选项条件", choiceOption.when, value => { choiceOption.when = value; markDirty(); });
        fields.append(row);
      });
      fields.append(button("添加选项", "quiet", () => {
        historyMutation("story", `choice:option:add:${state.selectedLabel}:${index}`, () => { instruction.options = [...options, { id: `option_${options.length + 1}`, text: "新选项", target: labels()[0] || "" }]; });
        rerenderInstructionList();
      }));
      break;
    }
    case "ending":
      field(fields, "结局 ID", instruction.id, value => update("id", value));
      field(fields, "结局文本", instruction.text ?? "", value => update("text", value), { multiline: true, wide: true });
      field(fields, "CG 键", instruction.cg ?? "", value => update("cg", value || undefined));
      break;
    default: {
      const fallback = node("p", "nv-field-help", `未知指令“${String(instruction.type)}”保留为 JSON；编辑后仍需通过 runtime 诊断。`);
      fields.append(fallback);
      jsonField(fields, "原始指令", instruction, value => { selectedInstructions()[index] = value; });
      break;
    }
  }
  card.append(fields);
  const moveLine = node("div", "nv-move-row");
  const destinations = node("select", "nv-input nv-destination");
  for (const label of labels()) option(destinations, label, label);
  destinations.value = state.selectedLabel;
  moveLine.append(node("span", "nv-field-help", "移动到标签"), destinations, button("移动", "quiet", () => moveInstructionTo(index, destinations.value)));
  card.append(moveLine);
  parent.append(card);
}

function moveInstruction(index, direction) {
  const instructions = selectedInstructions();
  const next = index + direction;
  if (next < 0 || next >= instructions.length) return;
  historyMutation("story", `instruction:order:${state.selectedLabel}`, () => { [instructions[index], instructions[next]] = [instructions[next], instructions[index]]; });
  rerenderInstructionList();
}

function moveInstructionTo(index, destination) {
  if (!destination || destination === state.selectedLabel) return;
  const instructions = selectedInstructions();
  historyMutation("story", `instruction:move:${state.selectedLabel}:${destination}`, () => {
    const [instruction] = instructions.splice(index, 1);
    if (instruction) state.story.script[destination].push(instruction);
  });
  rerenderWorkspace();
}

function removeInstruction(index) {
  historyMutation("story", `instruction:remove:${state.selectedLabel}:${index}`, () => { selectedInstructions().splice(index, 1); });
  rerenderWorkspace();
}

function duplicateInstruction(index) {
  const original = selectedInstructions()[index];
  if (!original) return;
  historyMutation("story", `instruction:duplicate:${state.selectedLabel}:${index}`, () => {
    const copy = JSON.parse(JSON.stringify(original));
    if (["say", "choice", "input", "ending"].includes(copy.type)) {
      const usedIds = new Set(Object.values(state.story.script).flatMap(instructions => instructions.map(item => item.id).filter(Boolean)));
      const stem = `${copy.id}_copy`;
      let candidate = stem;
      for (let suffix = 2; usedIds.has(candidate); suffix++) candidate = `${stem}_${suffix}`;
      copy.id = candidate;
    }
    selectedInstructions().splice(index + 1, 0, copy);
  });
  rerenderWorkspace();
}

function reorderChoice(instructionIndex, optionIndex, direction) {
  const options = selectedInstructions()[instructionIndex]?.options;
  const next = optionIndex + direction;
  if (!Array.isArray(options) || next < 0 || next >= options.length) return;
  historyMutation("story", `choice:order:${state.selectedLabel}:${instructionIndex}`, () => { [options[optionIndex], options[next]] = [options[next], options[optionIndex]]; });
  rerenderInstructionList();
}

function renderTopbar() {
  const header = node("header", "nv-header");
  const brand = node("div", "nv-brand");
  brand.append(node("span", "nv-mark", "P"), (() => {
    const text = node("div", "nv-brand-text");
    text.append(node("strong", "", "Pocket Novel Studio"), node("span", "", `${state.story.id} · story.json`));
    return text;
  })());
  const actions = node("div", "nv-header-actions");
  const saveStatus = node("span", "nv-save-state", state.dirty ? "未保存" : "已保存");
  saveStatus.id = "novel-save-state";
  saveStatus.dataset.dirty = String(state.dirty);
  const save = button(state.saving ? "保存中…" : "保存", "primary", () => { void saveStory(); });
  save.id = "novel-save";
  save.disabled = state.saving || state.historyBlocked || !state.dirty;
  const build = button(state.building ? "构建中…" : "构建 Guest", "secondary", () => { void buildGuest(); });
  build.id = "novel-build";
  build.disabled = state.saving || state.building || state.dirty || !localValidation().valid || state.assetDiagnostics.some(item => item.severity === "error");
  const importButton = button("导入剧本", "quiet", () => byId("novel-import-input")?.click(), "导入 JSON、Pocket VN CSV 或 Markdown");
  importButton.disabled = state.saving;
  const manuscriptButton = button("导入手稿", "quiet", () => byId("novel-manuscript-input")?.click(), "预览 UTF-8 普通文本，导入为新章节");
  manuscriptButton.id = "novel-manuscript-button";
  manuscriptButton.disabled = state.saving || state.historyBlocked || state.historyBusy;
  const exportFormat = node("select", "nv-input");
  exportFormat.setAttribute("aria-label", "剧本导出格式");
  for (const [value, label] of [["json", "JSON"], ["table-csv", "表格 CSV（可编辑列）"], ["docx", "Word 审阅稿"], ["csv", "Pocket VN CSV"], ["md", "Pocket VN Markdown"]]) option(exportFormat, value, label);
  exportFormat.value = state.interchangeFormat;
  const exportLabel = () => `导出 ${{ json: "JSON", "table-csv": "表格 CSV", docx: "Word", csv: "CSV", md: "Markdown" }[state.interchangeFormat]}`;
  const exportButton = button(exportLabel(), "quiet", () => { void exportStoryFile(); });
  exportFormat.addEventListener("change", () => { state.interchangeFormat = exportFormat.value; exportButton.textContent = exportLabel(); });
  const undo = button("撤销", "quiet", undoEdit, "撤销最近一次编辑（⌘/Ctrl+Z）");
  undo.id = "novel-undo";
  undo.disabled = state.history.undo.length === 0 || state.saving;
  const redo = button("重做", "quiet", redoEdit, "重做最近一次撤销（⌘/Ctrl+Shift+Z）");
  redo.id = "novel-redo";
  redo.disabled = state.history.redo.length === 0 || state.saving;
  const historyStatus = node("span", "nv-save-state");
  historyStatus.id = "novel-history-state";
  const input = node("input", "nv-hidden-input");
  input.id = "novel-import-input";
  input.type = "file";
  input.accept = ".json,.csv,.md,.markdown,application/json,text/csv,text/markdown";
  input.addEventListener("change", () => { const file = input.files?.[0]; if (file) void importStoryFile(file); input.value = ""; });
  const manuscriptInput = node("input", "nv-hidden-input");
  manuscriptInput.id = "novel-manuscript-input";
  manuscriptInput.type = "file";
  manuscriptInput.accept = ".txt,text/plain";
  manuscriptInput.addEventListener("change", () => { const file = manuscriptInput.files?.[0]; if (file) void importManuscriptFile(file); manuscriptInput.value = ""; });
  actions.append(saveStatus, historyStatus, undo, redo, save, build, importButton, manuscriptButton, exportFormat, exportButton, input, manuscriptInput);
  header.append(brand, actions);
  return header;
}

function renderToolbar() {
  const bar = node("nav", "nv-tabs");
  for (const [key, text] of [["story", "故事编辑"], ["dialogueTable", "对白表格"], ["variables", "变量声明"], ["inventory", "库存与商店"], ["replays", "鉴赏回放"], ["assets", "视觉与音频资源"], ["preview", "试玩与调试"], ["graph", "剧情地图"], ["stage", "舞台编辑"], ["timelines", "时间轴"], ["authoring", "文本剧本"], ["localization", "文本本地化"], ["backups", "项目备份"]]) {
    const item = button(text, state.panel === key ? "tab active" : "tab", () => { state.panel = key; rerenderWorkspace(); });
    item.setAttribute("aria-pressed", String(state.panel === key));
    bar.append(item);
  }
  const summary = state.validation?.summary ?? {};
  bar.append(node("span", "nv-toolbar-summary", `${summary.labels ?? labels().length} 个标签 · ${summary.dialogueLines ?? 0} 句对白 · ${summary.choices ?? 0} 处选择`));
  if (state.assetsDirty) bar.append(node("span", "nv-dirty-chip", "资源未保存"));
  return bar;
}

function renderLabelRail() {
  const rail = node("aside", "nv-label-rail");
  const heading = node("div", "nv-rail-heading");
  heading.append(node("strong", "", "剧情标签"), button("＋", "quiet icon", addLabel, "新增标签"));
  rail.append(heading);
  for (const label of labels()) {
    const list = state.story.script[label] || [];
    const card = button("", state.selectedLabel === label ? "nv-label active" : "nv-label", () => { state.selectedLabel = label; rerenderWorkspace(); });
    card.append(node("span", "nv-label-name", label), node("span", "nv-label-meta", `${list.length} 条指令${label === state.story.start ? " · 起点" : ""}`));
    rail.append(card);
  }
  rail.append(node("p", "nv-rail-hint", "选择标签后，在右侧编辑对白、条件、变量、演出与分支。标签名使用稳定标识。"));
  return rail;
}

function addLabel() {
  const name = window.prompt("新剧情标签 ID", `chapter_${labels().length + 1}`)?.trim();
  if (!name) return;
  if (Object.hasOwn(state.story.script, name)) { setNotice(`标签 ${name} 已存在。`, "error"); return; }
  historyMutation("story", "label:add", () => { state.story.script[name] = []; state.selectedLabel = name; });
  if (state.panel === "graph") graphView.initialized = false;
  rerenderWorkspace();
}

function renderLabelEditor() {
  const section = node("section", "nv-story-panel");
  const title = node("div", "nv-panel-heading");
  const titleCopy = node("div", "");
  titleCopy.append(node("h1", "", state.selectedLabel), node("p", "", state.selectedLabel === state.story.start ? "故事入口标签" : "剧情标签 · 编辑后保存至 story.json"));
  title.append(titleCopy);
  const controls = node("div", "nv-inline-actions");
  controls.append(button(state.story.start === state.selectedLabel ? "当前起点" : "设为起点", "quiet", () => {
    historyMutation("story", "story:start", () => { state.story.start = state.selectedLabel; });
    rerenderWorkspace();
  }), button("删除标签", "danger quiet", removeLabel));
  title.append(controls);
  section.append(title);
  const idRow = node("div", "nv-label-properties");
  field(idRow, "标签 ID", state.selectedLabel, next => renameLabel(state.selectedLabel, next), { onChangeOnly: true, historyKey: `label:${state.selectedLabel}:id` });
  section.append(idRow);
  const listHeader = node("div", "nv-instruction-list-header");
  listHeader.append(node("div", "", "剧情指令"));
  const addSelect = node("select", "nv-input nv-add-select");
  option(addSelect, "", "添加指令…");
  const addInstructionChoices = [["say", "对白"], ["choice", "玩家选择"], ["input", "玩家输入"], ["branch", "条件分支"], ["set", "设置变量"], ["inc", "变量增量"], ["scene", "场景/角色"], ["audio", "音频 cue"], ["wait", "等待"], ["jump", "跳转"], ["call", "调用标签"], ["return", "返回"], ["ending", "结局"]];
  if (Object.keys(state.story.inventory?.items ?? {}).length) addInstructionChoices.splice(6, 0, ["trade", "商店交易"]);
  for (const [key, title] of addInstructionChoices) option(addSelect, key, title);
  addSelect.addEventListener("change", () => {
    if (!addSelect.value) return;
    historyMutation("story", `instruction:add:${state.selectedLabel}`, () => { selectedInstructions().push(instructionFactory(addSelect.value)); });
    rerenderWorkspace();
  });
  listHeader.append(addSelect);
  section.append(listHeader);
  const list = node("div", "nv-instruction-list");
  list.id = "novel-instruction-list";
  section.append(list);
  renderInstructionList(list);
  return section;
}

function removeLabel() {
  if (state.selectedLabel === state.story.start) { setNotice("不能删除故事起点。请先将其他标签设为起点。", "error"); return; }
  if (!window.confirm(`删除标签 ${state.selectedLabel}？指向该标签的剧情引用会保留并显示为诊断。`)) return;
  historyMutation("story", `label:remove:${state.selectedLabel}`, () => {
    removeGraphPosition(state.selectedLabel);
    removeBlueprintNode(state.selectedLabel);
    delete state.story.script[state.selectedLabel];
    state.selectedLabel = labels()[0] || "";
  });
  rerenderWorkspace();
}

function renameLabel(oldName, nextName) {
  const clean = String(nextName).trim();
  if (!clean || clean === oldName) return;
  if (Object.hasOwn(state.story.script, clean)) { setNotice(`标签 ${clean} 已存在。`, "error"); return; }
  const next = {};
  for (const [label, script] of Object.entries(state.story.script)) next[label === oldName ? clean : label] = script;
  state.story.script = next;
  renameGraphPosition(oldName, clean);
  renameBlueprintNode(oldName, clean);
  for (const instructions of Object.values(state.story.script)) {
    for (const instruction of instructions) {
      if (instruction.type === "jump" || instruction.type === "call") { if (instruction.target === oldName) instruction.target = clean; }
      if (instruction.type === "branch") {
        if (instruction.then === oldName) instruction.then = clean;
        if (instruction.else === oldName) instruction.else = clean;
      }
      if (instruction.type === "choice") {
        for (const item of instruction.options || []) if (item.target === oldName) item.target = clean;
        if (instruction.timeoutTarget === oldName) instruction.timeoutTarget = clean;
      }
      if (instruction.type === "input" && instruction.cancelTarget === oldName) instruction.cancelTarget = clean;
      if (instruction.type === "trade" && instruction.onFailure === oldName) instruction.onFailure = clean;
    }
  }
  if (state.story.start === oldName) state.story.start = clean;
  for (const entry of state.story.replayEntries ?? []) if (entry.location?.label === oldName) entry.location.label = clean;
  state.selectedLabel = clean;
  markDirty();
  rerenderWorkspace();
}

function renderInstructionList(list) {
  if (!list) return;
  list.replaceChildren();
  selectedInstructions().forEach((instruction, index) => instructionEditor(list, instruction, index));
  if (selectedInstructions().length === 0) list.append(node("div", "nv-empty", "此标签还没有指令。使用上方菜单添加对白、条件或场景事件。"));
  const bottom = node("div", "nv-list-end");
  bottom.append(button("＋ 在末尾添加对白", "secondary", () => {
    historyMutation("story", `instruction:add:${state.selectedLabel}`, () => { selectedInstructions().push(instructionFactory("say")); });
    rerenderWorkspace();
  }));
  list.append(bottom);
}

function rerenderInstructionList() {
  renderInstructionList(byId("novel-instruction-list"));
}

const GRAPH_COLUMN_STEP = 390;
const GRAPH_ROW_GAP = 72;
const GRAPH_ZOOM_MIN = 0.015;
const GRAPH_ZOOM_MAX = 2.25;

function graphRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function graphOwnRecordCopy(value) {
  const copy = {};
  if (!graphRecord(value)) return copy;
  for (const key of Object.keys(value)) Object.defineProperty(copy, key, {
    value: value[key], enumerable: true, configurable: true, writable: true,
  });
  return copy;
}

function validGraphPosition(value) {
  return graphRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y) &&
    Math.abs(value.x) <= 100_000 && Math.abs(value.y) <= 100_000;
}

function savedGraphPositions() {
  const graph = state.story?.editor?.graph;
  if (!graphRecord(graph) || graph.version !== 1 || !graphRecord(graph.positions)) return Object.create(null);
  const positions = Object.create(null);
  for (const label of labels()) {
    if (Object.hasOwn(graph.positions, label) && validGraphPosition(graph.positions[label])) {
      positions[label] = { x: graph.positions[label].x, y: graph.positions[label].y };
    }
  }
  return positions;
}

function mutateGraphPositions(mutate) {
  const editor = graphOwnRecordCopy(state.story.editor);
  const previousGraph = graphRecord(editor.graph) ? editor.graph : {};
  const graph = graphOwnRecordCopy(previousGraph);
  const positions = graphOwnRecordCopy(graph.positions);
  graph.version = 1;
  mutate(positions);
  graph.positions = positions;
  editor.graph = graph;
  state.story.editor = editor;
}

function blueprintNodeForLabel(label) {
  const nodes = state.story?.editor?.blueprint?.nodes;
  if (!graphRecord(nodes) || !Object.hasOwn(nodes, label)) return null;
  const entry = nodes[label];
  return graphRecord(entry) ? entry : null;
}

function mutateBlueprintNodes(mutate) {
  const editor = graphOwnRecordCopy(state.story.editor);
  const blueprint = graphOwnRecordCopy(editor.blueprint);
  const nodes = graphOwnRecordCopy(blueprint.nodes);
  blueprint.version = 1;
  mutate(nodes);
  blueprint.nodes = nodes;
  editor.blueprint = blueprint;
  state.story.editor = editor;
}

function removeBlueprintNode(label) {
  const nodes = state.story?.editor?.blueprint?.nodes;
  if (!graphRecord(nodes) || !Object.hasOwn(nodes, label)) return;
  mutateBlueprintNodes(next => { delete next[label]; });
}

function renameBlueprintNode(oldName, nextName) {
  const nodes = state.story?.editor?.blueprint?.nodes;
  if (!graphRecord(nodes) || !Object.hasOwn(nodes, oldName)) return;
  mutateBlueprintNodes(next => {
    const entry = next[oldName];
    delete next[oldName];
    Object.defineProperty(next, nextName, { value: entry, enumerable: true, configurable: true, writable: true });
  });
}

function saveGraphCanvasPositions(overrideLabel, overridePosition) {
  const current = {};
  for (const card of document.querySelectorAll("[data-graph-node]")) {
    const label = card.dataset.graphNode;
    const position = label === overrideLabel && overridePosition
      ? overridePosition
      : { x: graphNumber(card.dataset.graphX), y: graphNumber(card.dataset.graphY) };
    if (Number.isFinite(position.x) && Number.isFinite(position.y) && Math.abs(position.x) <= 100_000 && Math.abs(position.y) <= 100_000) {
      Object.defineProperty(current, label, {
        value: { x: position.x, y: position.y }, enumerable: true, configurable: true, writable: true,
      });
    }
  }
  mutateGraphPositions(positions => {
    for (const label of Object.keys(current)) Object.defineProperty(positions, label, {
      value: current[label], enumerable: true, configurable: true, writable: true,
    });
  });
}

function removeGraphPosition(label) {
  const editor = state.story?.editor;
  const graph = editor?.graph;
  if (!graphRecord(editor) || !graphRecord(graph) || !graphRecord(graph.positions) || !Object.hasOwn(graph.positions, label)) return;
  mutateGraphPositions(positions => { delete positions[label]; });
}

function renameGraphPosition(oldName, nextName) {
  const editor = state.story?.editor;
  const graph = editor?.graph;
  if (!graphRecord(editor) || !graphRecord(graph) || !graphRecord(graph.positions) || !Object.hasOwn(graph.positions, oldName)) return;
  mutateGraphPositions(positions => {
    const position = positions[oldName];
    delete positions[oldName];
    if (validGraphPosition(position)) Object.defineProperty(positions, nextName, {
      value: { x: position.x, y: position.y }, enumerable: true, configurable: true, writable: true,
    });
  });
}

function graphRouteValue(sourceLabel, instructionIndex, routeKind) {
  if (!Object.hasOwn(state.story.script, sourceLabel)) return undefined;
  const instruction = state.story.script[sourceLabel]?.[instructionIndex];
  if (!instruction || typeof instruction !== "object") return undefined;
  if ((routeKind === "jump" || routeKind === "call") && instruction.type === routeKind) return instruction.target;
  if (instruction.type === "branch" && routeKind === "branch-then") return instruction.then;
  if (instruction.type === "branch" && routeKind === "branch-else") return instruction.else;
  if (instruction.type === "input" && routeKind === "input-cancel") return instruction.cancelTarget;
  if (instruction.type === "trade" && routeKind === "trade-failure") return instruction.onFailure;
  if (instruction.type === "choice" && routeKind === "choice-timeout") return instruction.timeoutTarget;
  const optionMatch = /^choice-option-(\d+)$/.exec(routeKind);
  if (instruction.type === "choice" && optionMatch) return instruction.options?.[Number(optionMatch[1])]?.target;
  return undefined;
}

function assignGraphRoute(sourceLabel, instructionIndex, routeKind, target) {
  if (!Object.hasOwn(state.story.script, sourceLabel)) return false;
  const instruction = state.story.script[sourceLabel]?.[instructionIndex];
  if (!instruction || typeof instruction !== "object") return false;
  if ((routeKind === "jump" || routeKind === "call") && instruction.type === routeKind) instruction.target = target;
  else if (instruction.type === "branch" && routeKind === "branch-then") instruction.then = target;
  else if (instruction.type === "branch" && routeKind === "branch-else") instruction.else = target;
  else if (instruction.type === "input" && routeKind === "input-cancel") {
    if (target) instruction.cancelTarget = target;
    else delete instruction.cancelTarget;
  } else if (instruction.type === "trade" && routeKind === "trade-failure") instruction.onFailure = target;
  else if (instruction.type === "choice" && routeKind === "choice-timeout") instruction.timeoutTarget = target;
  else {
    const optionMatch = /^choice-option-(\d+)$/.exec(routeKind);
    if (instruction.type !== "choice" || !optionMatch || !Array.isArray(instruction.options) || !instruction.options[Number(optionMatch[1])]) return false;
    instruction.options[Number(optionMatch[1])].target = target;
  }
  return true;
}

function graphInitialPositions(saved = savedGraphPositions()) {
  const positions = Object.create(null);
  let autoIndex = 0;
  for (const label of labels()) {
    if (Object.hasOwn(saved, label)) positions[label] = { x: saved[label].x, y: saved[label].y };
    else {
      positions[label] = { x: 48 + (autoIndex % 3) * GRAPH_COLUMN_STEP, y: 48 + Math.floor(autoIndex / 3) * 360 };
      autoIndex += 1;
    }
  }
  return positions;
}

function graphPortIdentity(sourceLabel, instructionIndex, routeKind) {
  return `${sourceLabel}:${instructionIndex}:${routeKind}`;
}

function updateGraphConnectionStatus() {
  const status = byId("novel-graph-connect-status");
  if (!status) return;
  if (!graphConnection) {
    status.textContent = "选择节点上的圆形端口，再选择目标标签；也可直接使用每条路由的下拉菜单。";
    status.dataset.active = "false";
  } else {
    status.textContent = `正在连接：${graphConnection.sourceLabel} · ${graphConnection.caption}。选择目标标签，按 Escape 取消。`;
    status.dataset.active = "true";
  }
  const activeIdentity = graphConnection && graphPortIdentity(graphConnection.sourceLabel, graphConnection.instructionIndex, graphConnection.routeKind);
  for (const port of document.querySelectorAll("[data-graph-port]")) {
    const active = port.dataset.graphPort === activeIdentity;
    port.classList.toggle("is-connecting-source", active);
    port.setAttribute("aria-pressed", String(active));
  }
  for (const target of document.querySelectorAll("[data-graph-connect-target]")) {
    target.classList.toggle("is-connect-target", Boolean(graphConnection));
    target.setAttribute("aria-label", graphConnection ? `将 ${graphConnection.caption} 连接到 ${target.dataset.graphConnectTarget}` : `打开标签 ${target.dataset.graphConnectTarget} 的指令`);
  }
}

function cancelGraphConnection(restoreFocus = true) {
  const previous = graphConnection;
  graphConnection = null;
  updateGraphConnectionStatus();
  if (!restoreFocus || !previous) return;
  const port = [...document.querySelectorAll("[data-graph-port]")].find(item =>
    item.dataset.graphLabel === previous.sourceLabel && item.dataset.graphIndex === String(previous.instructionIndex) && item.dataset.graphKind === previous.routeKind);
  port?.focus({ preventScroll: true });
}

function connectGraphRouteTo(targetLabel) {
  if (!graphConnection || !Object.hasOwn(state.story.script, targetLabel)) return;
  const { sourceLabel, instructionIndex, routeKind } = graphConnection;
  const current = graphRouteValue(sourceLabel, instructionIndex, routeKind);
  if (current !== targetLabel) {
    historyMutation("story", `graph:${sourceLabel}:${instructionIndex}:${routeKind}`, () => {
      assignGraphRoute(sourceLabel, instructionIndex, routeKind, targetLabel);
    });
  }
  graphConnection = null;
  rerenderWorkspace();
}

function graphTargetField(parent, sourceLabel, instructionIndex, routeKind, label, value, optional = false) {
  const row = node("div", "nv-graph-edge");
  const caption = node("span", "nv-graph-edge-label", label);
  const select = node("select", "nv-input nv-graph-target");
  select.setAttribute("aria-label", label);
  select.dataset.graphTarget = routeKind;
  select.dataset.graphLabel = sourceLabel;
  select.dataset.graphIndex = String(instructionIndex);
  option(select, "", optional ? "不允许取消" : "未设置");
  const names = labels();
  for (const name of names) option(select, name, name);
  if (value && !names.includes(value)) option(select, value, `缺失：${value}`);
  select.value = value == null ? "" : String(value);
  select.addEventListener("change", () => {
    const next = select.value;
    if (next === (value == null ? "" : String(value))) return;
    historyMutation("story", `graph:${sourceLabel}:${instructionIndex}:${routeKind}`, () => {
      assignGraphRoute(sourceLabel, instructionIndex, routeKind, next);
    });
    graphConnection = null;
    rerenderWorkspace();
  });
  const port = button("→", "quiet nv-graph-port", () => {
    graphConnection = { sourceLabel, instructionIndex, routeKind, caption: label };
    updateGraphConnectionStatus();
    const targets = [...document.querySelectorAll("[data-graph-connect-target]")];
    (targets.find(target => target.dataset.graphConnectTarget !== sourceLabel) || targets[0])?.focus({ preventScroll: true });
  }, `连接 ${label}，然后选择目标标签`);
  port.dataset.graphPort = graphPortIdentity(sourceLabel, instructionIndex, routeKind);
  port.dataset.graphLabel = sourceLabel;
  port.dataset.graphIndex = String(instructionIndex);
  port.dataset.graphKind = routeKind;
  port.setAttribute("aria-pressed", "false");
  row.append(caption, select, port);
  parent.append(row);
}

function setGraphStart(label) {
  if (state.story.start === label) return;
  historyMutation("story", "graph:story:start", () => { state.story.start = label; });
  rerenderWorkspace();
}

function renderGraphRoutes(parent, label, instructions) {
  const blueprint = blueprintNodeForLabel(label);
  const routes = node("div", "nv-graph-routes");
  for (const [index, instruction] of instructions.entries()) {
    if (!instruction || typeof instruction !== "object") continue;
    const context = `第 ${index + 1} 条`;
    if (instruction.type === "jump" || instruction.type === "call") {
      const kindName = instruction.type === "jump" ? "跳转" : "调用";
      const routeName = blueprintRouteName(blueprint, instruction, instruction.type, `${kindName}目标`);
      graphTargetField(routes, label, index, instruction.type, `${label} · ${context} · ${routeName}`, instruction.target);
    } else if (instruction.type === "branch") {
      graphTargetField(routes, label, index, "branch-then", `${label} · ${context} · ${blueprintRouteName(blueprint, instruction, "branch-then", "条件为真目标")}`, instruction.then);
      graphTargetField(routes, label, index, "branch-else", `${label} · ${context} · ${blueprintRouteName(blueprint, instruction, "branch-else", "条件为假目标")}`, instruction.else);
    } else if (instruction.type === "input") {
      graphTargetField(routes, label, index, "input-cancel", `${label} · ${context} · 输入取消目标`, instruction.cancelTarget, true);
    } else if (instruction.type === "trade") {
      graphTargetField(routes, label, index, "trade-failure", `${label} · ${context} · 交易失败目标`, instruction.onFailure);
    } else if (instruction.type === "choice") {
      for (const [optionIndex, choiceOption] of (Array.isArray(instruction.options) ? instruction.options : []).entries()) {
        if (!choiceOption || typeof choiceOption !== "object") continue;
        const optionName = choiceOption.text || choiceOption.id || `选项 ${optionIndex + 1}`;
        graphTargetField(routes, label, index, `choice-option-${optionIndex}`, `${label} · ${context} · ${optionName}目标`, choiceOption.target);
      }
      if (instruction.timeLimitMs !== undefined || instruction.timeoutTarget !== undefined) {
        graphTargetField(routes, label, index, "choice-timeout", `${label} · ${context} · 超时目标`, instruction.timeoutTarget);
      } else {
        routes.append(button("＋ 添加超时路由", "quiet nv-graph-timeout-add", () => {
          historyMutation("story", `graph:${label}:${index}:choice-timeout:add`, () => {
            instruction.timeLimitMs = 10_000;
            instruction.timeoutTarget = state.story.start || labels()[0] || "";
          });
          rerenderWorkspace();
        }));
      }
    }
  }
  if (!routes.childElementCount) routes.append(node("span", "nv-graph-no-routes", "没有标签跳转指令"));
  parent.append(routes);
}

function blueprintRouteName(blueprint, instruction, routeKind, fallback) {
  if (!blueprint) return fallback;
  if (blueprint.kind === "entry" && routeKind === "jump") return "流程入口出口";
  if (blueprint.kind === "chapter" && routeKind === "call") return "章内正文引用";
  if (blueprint.kind === "chapter" && routeKind === "jump") return "章节后续出口";
  if (blueprint.kind === "condition" && routeKind === "branch-then") return "条件为真出口";
  if (blueprint.kind === "condition" && routeKind === "branch-else") return "条件为假出口";
  if (blueprint.kind === "assignment" && routeKind === "jump") return "赋值后出口";
  return fallback;
}

function blueprintInput(parent, fieldName, label, value, options = {}) {
  const wrap = node("label", "nv-field nv-blueprint-field");
  wrap.append(node("span", "nv-field-label", label));
  const input = options.multiline ? node("textarea", `nv-input nv-textarea ${options.json ? "nv-json-field nv-blueprint-json" : ""}`) : node(options.select ? "select" : "input", "nv-input");
  if (!options.multiline && !options.select) input.type = options.type || "text";
  input.dataset.blueprintField = fieldName;
  input.setAttribute("aria-label", label);
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.select) {
    option(input, "", "选择已有标签…");
    const known = labels();
    for (const target of known) option(input, target, target);
    if (value && !known.includes(value)) option(input, value, `缺失：${value}`);
    input.value = value || "";
  } else input.value = value ?? "";
  if (options.required) input.required = true;
  wrap.append(input);
  parent.append(wrap);
  return input;
}

function blueprintFieldValue(dialog, fieldName) {
  const input = [...dialog.querySelectorAll("[data-blueprint-field]")].find(item => item.dataset.blueprintField === fieldName);
  return input?.value ?? "";
}

function blueprintKindTitle(kind) {
  return ({ entry: "流程入口", chapter: "章节", condition: "条件", choice: "玩家选择", assignment: "变量赋值", end: "流程终点" })[kind] || kind;
}

function nextBlueprintLabel() {
  let index = Object.keys(state.story.script).length + 1;
  let label = `blueprint_${index}`;
  while (Object.hasOwn(state.story.script, label)) { index += 1; label = `blueprint_${index}`; }
  return label;
}

function renderBlueprintFields(parent, kind, label) {
  parent.replaceChildren();
  const destination = state.story.start || labels()[0] || "";
  if (kind === "entry") {
    blueprintInput(parent, "target", "入口目标", destination, { select: true, required: true });
  } else if (kind === "chapter") {
    blueprintInput(parent, "target", "章内正文标签", labels()[0] || "", { select: true, required: true });
    blueprintInput(parent, "next", "章节后续出口", destination, { select: true, required: true });
  } else if (kind === "condition") {
    blueprintInput(parent, "when", "条件（Condition JSON）", JSON.stringify({ op: "truthy", value: { type: "literal", value: true } }, null, 2), { multiline: true, json: true, required: true });
    blueprintInput(parent, "then", "条件为真目标", destination, { select: true, required: true });
    blueprintInput(parent, "else", "条件为假目标", destination, { select: true, required: true });
  } else if (kind === "choice") {
    blueprintInput(parent, "prompt", "选择提示（可选）", "请选择后续章节", { placeholder: "留空时使用引擎默认提示" });
    const defaultOptions = [
      { id: "option_1", text: "选项一", target: destination },
      { id: "option_2", text: "选项二", target: destination },
    ];
    blueprintInput(parent, "options", "选项及目标（ChoiceOptionDefinition[] JSON）", JSON.stringify(defaultOptions, null, 2), { multiline: true, json: true, required: true });
  } else if (kind === "assignment") {
    blueprintInput(parent, "variable", "变量名", "story_flag", { required: true });
    blueprintInput(parent, "value", "变量值（JSON）", "true", { multiline: true, json: true, required: true });
    blueprintInput(parent, "next", "赋值后目标", destination, { select: true, required: true });
  } else if (kind === "end") {
    blueprintInput(parent, "text", "终点文本（可选）", "", { placeholder: "留空时仅结束流程" });
  }
  parent.setAttribute("data-blueprint-fields-kind", kind);
}

function openBlueprintNodeDialog(parent) {
  const dialog = node("dialog", "nv-blueprint-dialog");
  dialog.id = "novel-blueprint-dialog";
  dialog.setAttribute("aria-labelledby", "novel-blueprint-title");
  const heading = node("div", "nv-blueprint-dialog-heading");
  heading.append(node("h2", "", "添加蓝图节点"), node("p", "", "节点执行由现有标签指令和出口决定；章节正文继续保留在原标签中。"));
  heading.querySelector("h2").id = "novel-blueprint-title";
  const kindField = node("label", "nv-field nv-blueprint-field");
  kindField.append(node("span", "nv-field-label", "节点类型"));
  const kind = node("select", "nv-input");
  kind.dataset.blueprintKind = "true";
  kind.setAttribute("aria-label", "节点类型");
  for (const value of ["entry", "chapter", "condition", "choice", "assignment", "end"]) option(kind, value, blueprintKindTitle(value));
  kind.value = "chapter";
  kindField.append(kind);
  const identity = node("div", "nv-blueprint-identity");
  blueprintInput(identity, "label", "节点标签 ID", nextBlueprintLabel(), { required: true });
  blueprintInput(identity, "title", "节点标题（可选）", "", { placeholder: "显示给作者的说明标题" });
  const fields = node("div", "nv-blueprint-kind-fields");
  renderBlueprintFields(fields, kind.value, nextBlueprintLabel());
  kind.addEventListener("change", () => renderBlueprintFields(fields, kind.value, blueprintFieldValue(dialog, "label")));
  const status = node("p", "nv-blueprint-dialog-status");
  status.setAttribute("aria-live", "polite");
  const actions = node("div", "nv-inline-actions nv-blueprint-dialog-actions");
  const cancel = button("取消", "quiet", () => dialog.close());
  const submit = button("添加节点", "primary", () => {
    status.textContent = "";
    try {
      const kindValue = kind.value;
      const label = blueprintFieldValue(dialog, "label").trim();
      const title = blueprintFieldValue(dialog, "title").trim();
      const spec = { kind: kindValue, label, ...(title ? { title } : {}) };
      const parseJson = fieldName => {
        try { return JSON.parse(blueprintFieldValue(dialog, fieldName)); }
        catch { throw new Error(`${fieldName} 必须是合法 JSON。`); }
      };
      if (kindValue === "entry") spec.target = blueprintFieldValue(dialog, "target");
      else if (kindValue === "chapter") {
        spec.chapterTarget = blueprintFieldValue(dialog, "target");
        spec.next = blueprintFieldValue(dialog, "next");
      } else if (kindValue === "condition") {
        spec.when = parseJson("when");
        spec.then = blueprintFieldValue(dialog, "then");
        spec.else = blueprintFieldValue(dialog, "else");
      } else if (kindValue === "choice") {
        const prompt = blueprintFieldValue(dialog, "prompt").trim();
        if (prompt) spec.prompt = prompt;
        spec.options = parseJson("options");
      } else if (kindValue === "assignment") {
        spec.variable = blueprintFieldValue(dialog, "variable").trim();
        spec.value = parseJson("value");
        spec.next = blueprintFieldValue(dialog, "next");
      } else if (kindValue === "end") {
        const text = blueprintFieldValue(dialog, "text").trim();
        if (text) spec.text = text;
      }
      if (!label) throw new Error("请输入节点标签 ID。");
      if (typeof state.engineModule?.addNovelBlueprintNode !== "function") throw new Error("蓝图节点 SDK helper 不可用，请重新打开编辑器后重试。");
      historyMutation("story", `blueprint:add:${label}`, () => {
        state.story = state.engineModule.addNovelBlueprintNode(state.story, spec);
        state.selectedLabel = label;
      });
      graphView.initialized = false;
      dialog.close();
      rerenderWorkspace();
    } catch (error) {
      status.textContent = error.message || String(error);
    }
  });
  submit.dataset.blueprintSubmit = "true";
  actions.append(cancel, submit);
  dialog.append(heading, kindField, identity, fields, status, actions);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  parent.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-blueprint-field="label"]')?.focus();
}

function findGraphNode(label) {
  return [...document.querySelectorAll("[data-graph-node]")].find(item => item.dataset.graphNode === label) || null;
}

function graphNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function updateGraphNodePosition(card, x, y) {
  card.dataset.graphX = String(x);
  card.dataset.graphY = String(y);
  const bounds = graphViewBounds;
  card.style.left = `${x - (bounds?.minX ?? 0)}px`;
  card.style.top = `${y - (bounds?.minY ?? 0)}px`;
}

function fitGraphView() {
  const viewport = byId("novel-graph-canvas");
  const world = byId("novel-graph-world");
  if (!viewport || !world) return;
  const viewportWidth = Math.max(1, viewport.clientWidth - 64);
  const viewportHeight = Math.max(1, viewport.clientHeight - 64);
  const width = Math.max(1, world.offsetWidth);
  const height = Math.max(1, world.offsetHeight);
  graphView.scale = Math.max(GRAPH_ZOOM_MIN, Math.min(1.25, viewportWidth / width, viewportHeight / height));
  graphView.x = (viewport.clientWidth - width * graphView.scale) / 2;
  graphView.y = (viewport.clientHeight - height * graphView.scale) / 2;
  graphView.initialized = true;
  applyGraphView();
}

function centerGraphNode(label, scale = 1) {
  const viewport = byId("novel-graph-canvas");
  const world = byId("novel-graph-world");
  const card = findGraphNode(label);
  if (!viewport || !world || !card || !graphViewBounds) return;
  graphView.scale = Math.max(GRAPH_ZOOM_MIN, Math.min(GRAPH_ZOOM_MAX, scale));
  const centerX = graphNumber(card.dataset.graphX) - graphViewBounds.minX + card.offsetWidth / 2;
  const centerY = graphNumber(card.dataset.graphY) - graphViewBounds.minY + card.offsetHeight / 2;
  graphView.x = viewport.clientWidth / 2 - centerX * graphView.scale;
  graphView.y = viewport.clientHeight / 2 - centerY * graphView.scale;
  graphView.initialized = true;
  applyGraphView();
}

function initializeGraphView() {
  const viewport = byId("novel-graph-canvas");
  const world = byId("novel-graph-world");
  if (!viewport || !world) return;
  const fitScale = Math.min(
    1.25,
    Math.max(1, viewport.clientWidth - 64) / Math.max(1, world.offsetWidth),
    Math.max(1, viewport.clientHeight - 64) / Math.max(1, world.offsetHeight),
  );
  if (fitScale < 0.5) {
    const focusLabel = Object.hasOwn(state.story.script, state.selectedLabel) ? state.selectedLabel : state.story.start;
    centerGraphNode(focusLabel, 1);
  } else fitGraphView();
}

function applyGraphView() {
  const viewport = byId("novel-graph-canvas");
  const world = byId("novel-graph-world");
  if (!viewport || !world) return;
  world.style.transform = `translate(${graphView.x}px, ${graphView.y}px) scale(${graphView.scale})`;
  viewport.dataset.graphScale = String(graphView.scale);
  updateGraphEdges();
}

function graphZoomTo(scale, clientX, clientY) {
  const viewport = byId("novel-graph-canvas");
  if (!viewport) return;
  const next = Math.max(GRAPH_ZOOM_MIN, Math.min(GRAPH_ZOOM_MAX, scale));
  const rect = viewport.getBoundingClientRect();
  const anchorX = clientX === undefined ? viewport.clientWidth / 2 : clientX - rect.left;
  const anchorY = clientY === undefined ? viewport.clientHeight / 2 : clientY - rect.top;
  const worldX = (anchorX - graphView.x) / graphView.scale;
  const worldY = (anchorY - graphView.y) / graphView.scale;
  graphView.scale = next;
  graphView.x = anchorX - worldX * next;
  graphView.y = anchorY - worldY * next;
  graphView.initialized = true;
  applyGraphView();
}

function updateGraphEdges() {
  const world = byId("novel-graph-world");
  const svg = byId("novel-graph-edges");
  if (!world || !svg || !graphView.scale) return;
  const width = Math.max(1, world.offsetWidth);
  const height = Math.max(1, world.offsetHeight);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.id = "nv-graph-arrow";
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  marker.append(arrow);
  defs.append(marker);
  svg.replaceChildren(defs);
  const worldRect = world.getBoundingClientRect();
  const cards = new Map([...world.querySelectorAll("[data-graph-node]")].map(card => [card.dataset.graphNode, card]));
  const targetRects = new Map();
  for (const port of world.querySelectorAll("[data-graph-port]")) {
    const sourceLabel = port.dataset.graphLabel;
    const instructionIndex = Number(port.dataset.graphIndex);
    const routeKind = port.dataset.graphKind;
    const targetLabel = graphRouteValue(sourceLabel, instructionIndex, routeKind);
    if (typeof targetLabel !== "string" || !Object.hasOwn(state.story.script, targetLabel)) continue;
    const target = cards.get(targetLabel);
    if (!target) continue;
    const sourceRect = port.getBoundingClientRect();
    let targetRect = targetRects.get(targetLabel);
    if (!targetRect) {
      targetRect = target.getBoundingClientRect();
      targetRects.set(targetLabel, targetRect);
    }
    const x1 = (sourceRect.right - worldRect.left) / graphView.scale;
    const y1 = (sourceRect.top + sourceRect.height / 2 - worldRect.top) / graphView.scale;
    const x2 = (targetRect.left - worldRect.left) / graphView.scale;
    const y2 = (targetRect.top + Math.min(targetRect.height / 2, 54 * graphView.scale) - worldRect.top) / graphView.scale;
    const bend = Math.max(46, Math.abs(x2 - x1) * 0.42);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute("marker-end", "url(#nv-graph-arrow)");
    path.classList.add("nv-graph-edge-wire", `is-${routeKind.startsWith("choice") ? "choice" : routeKind.startsWith("branch") ? "branch" : routeKind}`);
    path.dataset.graphEdge = port.dataset.graphPort;
    path.dataset.graphTarget = targetLabel;
    svg.append(path);
  }
}

function layoutGraphCanvas() {
  const world = byId("novel-graph-world");
  const viewport = byId("novel-graph-canvas");
  if (!world || !viewport) return;
  const cards = [...world.querySelectorAll("[data-graph-node]")];
  if (world.dataset.graphLaidOut !== "true") {
    const autoCards = cards.filter(card => card.dataset.graphAuto === "true");
    const pinnedCards = cards.filter(card => card.dataset.graphAuto !== "true");
    const pinnedBottom = pinnedCards.reduce((bottom, card) => Math.max(bottom, graphNumber(card.dataset.graphY) + card.offsetHeight), 0);
    let y = pinnedCards.length ? pinnedBottom + 80 : 48;
    for (let start = 0; start < autoCards.length; start += 3) {
      const row = autoCards.slice(start, start + 3);
      const rowHeight = row.reduce((height, card) => Math.max(height, card.offsetHeight), 0);
      row.forEach((card, column) => updateGraphNodePosition(card, 48 + column * GRAPH_COLUMN_STEP, y));
      y += rowHeight + GRAPH_ROW_GAP;
    }
    world.dataset.graphLaidOut = "true";
  }
  let minX = 0;
  let minY = 0;
  let maxX = 1;
  let maxY = 1;
  for (const card of cards) {
    const x = graphNumber(card.dataset.graphX);
    const nodeY = graphNumber(card.dataset.graphY);
    minX = Math.min(minX, x - 36);
    minY = Math.min(minY, nodeY - 36);
    maxX = Math.max(maxX, x + card.offsetWidth + 36);
    maxY = Math.max(maxY, nodeY + card.offsetHeight + 36);
  }
  const previous = graphViewBounds;
  const next = { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  if (previous && graphView.initialized) {
    graphView.x += (next.minX - previous.minX) * graphView.scale;
    graphView.y += (next.minY - previous.minY) * graphView.scale;
  }
  graphViewBounds = next;
  world.style.width = `${next.width}px`;
  world.style.height = `${next.height}px`;
  for (const card of cards) {
    card.style.left = `${graphNumber(card.dataset.graphX) - minX}px`;
    card.style.top = `${graphNumber(card.dataset.graphY) - minY}px`;
  }
  if (!graphView.initialized) initializeGraphView();
  else applyGraphView();
}

function scheduleGraphMeasure() {
  if (graphMeasureFrame) cancelAnimationFrame(graphMeasureFrame);
  graphMeasureFrame = requestAnimationFrame(() => {
    graphMeasureFrame = 0;
    layoutGraphCanvas();
  });
}

function graphNodePointerDown(event, label) {
  if (event.button !== 0 || !event.isPrimary) return;
  const card = findGraphNode(label);
  if (!card) return;
  event.preventDefault();
  event.stopPropagation();
  card.dataset.graphAuto = "false";
  graphDrag = {
    label, handle: event.currentTarget, pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    originX: graphNumber(card.dataset.graphX), originY: graphNumber(card.dataset.graphY),
    x: graphNumber(card.dataset.graphX), y: graphNumber(card.dataset.graphY), moved: false,
  };
  event.currentTarget.classList.add("is-dragging");
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
}

function graphNodePointerMove(event) {
  if (!graphDrag || event.pointerId !== graphDrag.pointerId) return;
  const scale = graphView.scale || 1;
  graphDrag.x = Math.max(-100_000, Math.min(100_000, graphDrag.originX + (event.clientX - graphDrag.startX) / scale));
  graphDrag.y = Math.max(-100_000, Math.min(100_000, graphDrag.originY + (event.clientY - graphDrag.startY) / scale));
  graphDrag.moved = graphDrag.moved || Math.abs(graphDrag.x - graphDrag.originX) > 0.01 || Math.abs(graphDrag.y - graphDrag.originY) > 0.01;
  const card = findGraphNode(graphDrag.label);
  if (!card) return;
  updateGraphNodePosition(card, graphDrag.x, graphDrag.y);
  layoutGraphCanvas();
}

function finishGraphNodeDrag(commit) {
  if (!graphDrag) return;
  const drag = graphDrag;
  graphDrag = null;
  drag.handle.classList.remove("is-dragging");
  if (commit && drag.moved && (drag.x !== drag.originX || drag.y !== drag.originY)) {
    historyMutation("story", `graph:layout:${drag.label}`, () => saveGraphCanvasPositions(drag.label, { x: drag.x, y: drag.y }));
  }
  rerenderWorkspace();
}

function graphNodePointerUp(event) {
  if (!graphDrag || event.pointerId !== graphDrag.pointerId) return;
  finishGraphNodeDrag(true);
}

function graphNodePointerCancel(event) {
  if (!graphDrag || event.pointerId !== graphDrag.pointerId) return;
  finishGraphNodeDrag(false);
}

function cancelGraphNodeDrag() {
  if (!graphDrag) return;
  try { graphDrag.handle.releasePointerCapture(graphDrag.pointerId); } catch {}
  finishGraphNodeDrag(false);
}

function moveGraphNodeByKeyboard(event, label) {
  const delta = event.shiftKey ? 120 : 24;
  const moves = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] };
  const move = moves[event.key];
  if (!move) return;
  event.preventDefault();
  const card = findGraphNode(label);
  if (!card) return;
  const x = Math.max(-100_000, Math.min(100_000, graphNumber(card.dataset.graphX) + move[0]));
  const y = Math.max(-100_000, Math.min(100_000, graphNumber(card.dataset.graphY) + move[1]));
  if (x === graphNumber(card.dataset.graphX) && y === graphNumber(card.dataset.graphY)) return;
  historyMutation("story", `graph:layout:${label}:keyboard`, () => saveGraphCanvasPositions(label, { x, y }));
  card.dataset.graphAuto = "false";
  updateGraphNodePosition(card, x, y);
  layoutGraphCanvas();
  const status = byId("novel-graph-connect-status");
  if (status) status.textContent = `${label} 已移动到画布坐标 ${Math.round(x)}, ${Math.round(y)}。`;
}

function beginGraphPan(event, viewport) {
  if (event.button !== 0 || !event.isPrimary || event.target.closest("button, select, input, a, [data-graph-node]")) return;
  graphPan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: graphView.x, viewY: graphView.y };
  viewport.classList.add("is-panning");
  try { viewport.setPointerCapture(event.pointerId); } catch {}
  event.preventDefault();
}

function moveGraphPan(event) {
  if (!graphPan || event.pointerId !== graphPan.pointerId) return;
  graphView.x = graphPan.viewX + event.clientX - graphPan.startX;
  graphView.y = graphPan.viewY + event.clientY - graphPan.startY;
  applyGraphView();
}

function finishGraphPan(viewport) {
  graphPan = null;
  viewport?.classList.remove("is-panning");
}

function renderGraph() {
  const section = node("section", "nv-graph-panel");
  const heading = node("div", "nv-panel-heading");
  const copy = node("div", "");
  copy.append(node("h1", "", "剧情地图"), node("p", "", "蓝图节点用现有标签指令连接入口、章节、条件、选择、赋值和终点；点击标签可继续编辑正文。"));
  const actions = node("div", "nv-inline-actions nv-graph-actions");
  const locate = node("label", "nv-graph-locate");
  locate.append(node("span", "", "定位标签"));
  const locateSelect = node("select", "nv-input nv-graph-locate-select");
  locateSelect.dataset.graphLocateLabel = "true";
  locateSelect.setAttribute("aria-label", "定位标签");
  for (const label of labels()) option(locateSelect, label, label);
  locateSelect.value = Object.hasOwn(state.story.script, state.selectedLabel) ? state.selectedLabel : state.story.start;
  locateSelect.addEventListener("change", () => centerGraphNode(locateSelect.value, 1));
  locate.append(locateSelect);
  const add = button("＋ 新标签", "secondary", addLabel);
  add.dataset.graphAddNode = "true";
  const zoomOut = button("−", "quiet nv-graph-zoom-button", () => graphZoomTo(graphView.scale / 1.2), "缩小剧情地图");
  zoomOut.dataset.graphZoom = "out";
  const zoomIn = button("＋", "quiet nv-graph-zoom-button", () => graphZoomTo(graphView.scale * 1.2), "放大剧情地图");
  zoomIn.dataset.graphZoom = "in";
  const fit = button("适合视图", "quiet nv-graph-fit", fitGraphView);
  fit.dataset.graphZoom = "fit";
  const addBlueprint = button("＋ 蓝图节点", "secondary nv-graph-add-blueprint", () => openBlueprintNodeDialog(section));
  addBlueprint.dataset.graphAddBlueprintNode = "true";
  actions.append(locate, zoomOut, zoomIn, fit, addBlueprint, add);
  heading.replaceChildren(copy, actions);
  section.append(heading);
  const status = node("p", "nv-graph-connect-status");
  status.id = "novel-graph-connect-status";
  status.setAttribute("aria-live", "polite");
  section.append(status);
  const viewport = node("div", "nv-graph-canvas");
  viewport.id = "novel-graph-canvas";
  viewport.dataset.graphCanvas = "true";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "region");
  viewport.setAttribute("aria-label", "剧情节点画布。拖动空白处平移；方向键平移，按加减键缩放，按 0 适合视图。");
  const world = node("div", "nv-graph-world");
  world.id = "novel-graph-world";
  world.dataset.graphWorld = "true";
  const edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  edges.classList.add("nv-graph-edges");
  edges.id = "novel-graph-edges";
  edges.setAttribute("aria-hidden", "true");
  const savedPositions = savedGraphPositions();
  const positions = graphInitialPositions(savedPositions);
  for (const label of labels()) {
    const instructions = Array.isArray(state.story.script[label]) ? state.story.script[label] : [];
    const position = positions[label] || { x: 48, y: 48 };
    const card = node("article", `nv-graph-node ${label === state.story.start ? "is-start" : ""}`);
    card.dataset.graphNode = label;
    card.dataset.graphLabel = label;
    const blueprint = blueprintNodeForLabel(label);
    if (blueprint) card.dataset.blueprintNode = label;
    card.dataset.graphAuto = Object.hasOwn(savedPositions, label) ? "false" : "true";
    card.dataset.graphX = String(position.x);
    card.dataset.graphY = String(position.y);
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y}px`;
    const head = node("div", "nv-graph-node-head");
    const drag = button("⠿", "quiet nv-graph-drag-handle", () => {} , `拖动 ${label} 节点；方向键移动，Shift 加方向键移动较大距离`);
    drag.dataset.graphDragHandle = label;
    drag.addEventListener("pointerdown", event => graphNodePointerDown(event, label));
    drag.addEventListener("pointermove", graphNodePointerMove);
    drag.addEventListener("pointerup", graphNodePointerUp);
    drag.addEventListener("pointercancel", graphNodePointerCancel);
    drag.addEventListener("keydown", event => moveGraphNodeByKeyboard(event, label));
    const open = button(label, "quiet nv-graph-open", () => {
      if (graphConnection) { connectGraphRouteTo(label); return; }
      state.selectedLabel = label;
      state.panel = "story";
      rerenderWorkspace();
    });
    open.dataset.graphConnectTarget = label;
    open.setAttribute("aria-label", `打开标签 ${label} 的指令`);
    const start = button(label === state.story.start ? "当前起点" : "设为起点", label === state.story.start ? "secondary nv-graph-start" : "quiet nv-graph-start", () => setGraphStart(label));
    start.dataset.graphStart = label;
    start.disabled = label === state.story.start;
    head.append(drag, open, start);
    card.append(head, node("span", "nv-graph-count", `${instructions.length} 条指令`));
    if (blueprint) {
      const summary = node("div", "nv-graph-blueprint-summary");
      summary.append(node("span", "nv-graph-blueprint-kind", blueprintKindTitle(blueprint.kind)));
      if (typeof blueprint.title === "string" && blueprint.title) summary.append(node("strong", "nv-graph-blueprint-title", blueprint.title));
      if (blueprint.kind === "chapter") {
        const bodyLabel = graphRouteValue(label, 0, "call");
        if (typeof bodyLabel === "string") summary.append(node("span", "nv-graph-blueprint-body", `正文 · ${bodyLabel}`));
      }
      card.append(summary);
    }
    const trades = instructions.filter(item => item?.type === "trade");
    if (trades.length) card.append(node("span", "nv-graph-count", `交易：${trades.map(item => `${item.action} ${item.item}`).join("、")}`));
    renderGraphRoutes(card, label, instructions);
    world.append(card);
  }
  world.prepend(edges);
  viewport.append(world);
  viewport.addEventListener("pointerdown", event => beginGraphPan(event, viewport));
  viewport.addEventListener("pointermove", moveGraphPan);
  viewport.addEventListener("pointerup", () => finishGraphPan(viewport));
  viewport.addEventListener("pointercancel", () => finishGraphPan(viewport));
  viewport.addEventListener("wheel", event => {
    event.preventDefault();
    graphZoomTo(graphView.scale * Math.exp(-event.deltaY * 0.0014), event.clientX, event.clientY);
  }, { passive: false });
  viewport.addEventListener("keydown", event => {
    if (event.key === "Escape" && graphConnection) { event.preventDefault(); cancelGraphConnection(); return; }
    if (event.target !== viewport) return;
    const pan = { ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] }[event.key];
    if (pan) { event.preventDefault(); graphView.x += pan[0]; graphView.y += pan[1]; applyGraphView(); }
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); graphZoomTo(graphView.scale * 1.2); }
    else if (event.key === "-") { event.preventDefault(); graphZoomTo(graphView.scale / 1.2); }
    else if (event.key === "0") { event.preventDefault(); fitGraphView(); }
  });
  section.append(viewport);
  graphResizeObserver = new ResizeObserver(() => scheduleGraphMeasure());
  graphResizeObserver.observe(viewport);
  scheduleGraphMeasure();
  updateGraphConnectionStatus();
  return section;
}

const workspacePanels = {
  localization: { name: "文本本地化", file: "novel-localization" },
  authoring: { name: "文本剧本", file: "novel-authoring" },
  stage: { name: "舞台编辑", file: "novel-stage" },
  backups: { name: "项目备份", file: "novel-backups" },
};

function renderVariableDefinitions() {
  const panel = node("section", "nv-story-panel");
  panel.append(node("h1", "", "变量声明"), node("p", "nv-field-help", "未声明的变量按普通存档变量处理。普通变量在新游戏时重置；会话变量跨新游戏保留，但读档和回退会还原；持久变量跨新游戏保留，并优先使用当前持久记录。"));
  panel.append(button("添加变量声明", "secondary", () => {
    const name = window.prompt("变量名（字母或下划线开头）", "player_name")?.trim();
    if (!name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || Object.hasOwn(state.story.variableDefinitions ?? {}, name)) {
      setNotice("变量名无效或已存在。", "error"); return;
    }
    historyMutation("story", "variable:add", () => {
      state.story.variableDefinitions ??= {};
      Object.defineProperty(state.story.variableDefinitions, name, { value: { lifetime: "save" }, enumerable: true, writable: true, configurable: true });
    });
    rerenderWorkspace();
  }));
  for (const [name, definition] of Object.entries(state.story.variableDefinitions ?? {})) {
    const card = node("article", "nv-instruction");
    card.dataset.variableName = name;
    card.append(node("h2", "", name));
    field(card, `生命周期 ${name}`, definition.lifetime, value => { definition.lifetime = value; }, {
      select: [["save", "普通存档变量"], ["session", "会话变量"], ["persistent", "持久变量"]],
    });
    if (Object.hasOwn(definition, "defaultValue")) {
      jsonField(card, `默认值 ${name}`, definition.defaultValue, value => { definition.defaultValue = value; });
      card.append(button(`移除默认值 ${name}`, "quiet", () => {
        historyMutation("story", `variable:default:${name}`, () => { delete definition.defaultValue; });
        rerenderWorkspace();
      }));
    } else {
      card.append(button(`设置默认值 ${name}`, "quiet", () => {
        historyMutation("story", `variable:default:${name}`, () => { definition.defaultValue = null; });
        rerenderWorkspace();
      }));
    }
    card.append(button(`删除声明 ${name}`, "quiet danger", () => {
      historyMutation("story", `variable:remove:${name}`, () => {
        delete state.story.variableDefinitions[name];
        if (!Object.keys(state.story.variableDefinitions).length) delete state.story.variableDefinitions;
      });
      rerenderWorkspace();
    }));
    panel.append(card);
  }
  panel.append(node("p", "nv-field-help", "删除声明保留剧本中的变量引用，并恢复普通存档变量行为。默认值使用 JSON；已有自定义元数据会原样保留。"));
  return panel;
}

function inventoryVariableEligible(definition) {
  return definition?.lifetime === "save" && Number.isSafeInteger(definition.defaultValue) && definition.defaultValue >= 0;
}

function novelTimelineRegistry() {
  const timelines = state.story?.timelines;
  if (timelines === undefined) return {};
  return timelines && typeof timelines === "object" && !Array.isArray(timelines) ? timelines : null;
}

function timelineSceneReferences(timelineId) {
  const references = [];
  for (const [label, instructions] of Object.entries(state.story?.script ?? {})) {
    if (!Array.isArray(instructions)) continue;
    for (const [index, instruction] of instructions.entries()) {
      if (instruction?.type === "scene" && instruction.timeline === timelineId) references.push({ label, index });
    }
  }
  return references;
}

function nextTimelineId(registry) {
  let suffix = 1;
  while (Object.hasOwn(registry, `timeline_${suffix}`)) suffix++;
  return `timeline_${suffix}`;
}

function isObjectValue(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function timelineTrackRow(chart, title, frames, durationMs, className = "", trackKey = "") {
  const row = node("div", `nv-timeline-chart-row ${className}`);
  row.dataset.timelineTrackKey = trackKey;
  row.append(node("span", "nv-timeline-chart-label", title));
  const lane = node("div", "nv-timeline-chart-lane");
  lane.setAttribute("role", "group");
  lane.setAttribute("aria-label", `${title} 时间刻度，可聚焦关键帧并用方向键调整`);
  lane.addEventListener("pointerdown", event => {
    const marker = nearestTimelineMarker(lane, event.clientX);
    if (marker) beginTimelinePointerDrag(event, trackKey, Number(marker.dataset.frameIndex), marker);
  });
  const usableDuration = timelineUsableDuration(durationMs);
  for (const index of timelineSortedIndices(frames)) {
    const frame = frames[index];
    const atMs = Number(frame?.atMs ?? 0);
    lane.append(timelineChartMarker(frame, index, atMs, usableDuration, className === "is-audio-gain", title, trackKey, frames));
  }
  row.append(lane);
  chart.append(row);
}

function timelineUsableDuration(durationMs) {
  return Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : 1;
}

function timelineTrackFrames(timeline, trackKey) {
  if (!isObjectValue(timeline)) return [];
  if (trackKey === "camera") return Array.isArray(timeline.camera) ? timeline.camera : [];
  if (trackKey === "audio") return Array.isArray(timeline.audio) ? timeline.audio : [];
  if (trackKey.startsWith("actor:")) {
    const actor = timeline.actors?.[Number(trackKey.slice("actor:".length))];
    return Array.isArray(actor?.keyframes) ? actor.keyframes : [];
  }
  if (trackKey.startsWith("audioGain:")) {
    const track = timeline.audioGains?.[Number(trackKey.slice("audioGain:".length))];
    return Array.isArray(track?.keyframes) ? track.keyframes : [];
  }
  return [];
}

function timelineTrackMotion(trackKey) {
  return trackKey !== "audio";
}

function timelineTimeBounds(frames, index, durationMs, trackKey) {
  const duration = timelineUsableDuration(durationMs);
  if (!timelineTrackMotion(trackKey)) return { min: 0, max: duration, disabled: false };
  if (index === 0) return { min: 0, max: 0, disabled: true };
  const previous = Number(frames[index - 1]?.atMs);
  const next = Number(frames[index + 1]?.atMs);
  const min = Number.isSafeInteger(previous) ? Math.max(0, previous + 1) : 0;
  const max = Number.isSafeInteger(next) ? Math.min(duration, next - 1) : duration;
  return { min, max, disabled: min > max };
}

function timelineFrameAt(timeline, trackKey, index) {
  const frames = timelineTrackFrames(timeline, trackKey);
  return isObjectValue(frames[index]) ? frames[index] : null;
}

function updateTimelineChartMarker(marker, frame, index, atMs, durationMs, gain, title, trackKey, frames) {
  const duration = timelineUsableDuration(durationMs);
  const position = Number.isFinite(atMs) ? Math.max(0, Math.min(100, atMs / duration * 100)) : 0;
  const bounds = timelineTimeBounds(frames, index, duration, trackKey);
  marker.style.setProperty("--nv-timeline-position", `${position}%`);
  marker.dataset.frameIndex = String(index);
  marker.dataset.atMs = String(frame?.atMs ?? "invalid");
  marker.dataset.timelineTrackKey = trackKey;
  marker.disabled = bounds.disabled;
  marker.setAttribute("aria-valuemin", String(bounds.min));
  marker.setAttribute("aria-valuemax", String(bounds.max));
  marker.setAttribute("aria-valuenow", String(Number.isFinite(atMs) ? atMs : 0));
  marker.setAttribute("aria-valuetext", `${frame?.atMs ?? "?"} 毫秒`);
  const detail = gain && Number.isFinite(frame?.value) ? ` · ${Math.round(frame.value * 100)}%` : "";
  marker.title = `${frame?.atMs ?? "?"} ms${detail}${bounds.disabled && timelineTrackMotion(trackKey) ? " · 首帧固定或没有可用时间区间" : ""}`;
  marker.setAttribute("aria-label", `${title}关键帧 ${index + 1}，${frame?.atMs ?? "?"} 毫秒${detail}${bounds.disabled && timelineTrackMotion(trackKey) ? "，不可移动" : ""}`);
}

function timelineChartMarker(frame, index, atMs, durationMs, gain = false, title = "时间轴", trackKey = "", frames = []) {
  const marker = node("button", "nv-timeline-chart-marker", gain ? "◆" : "•");
  marker.type = "button";
  marker.setAttribute("role", "slider");
  marker.setAttribute("aria-orientation", "horizontal");
  marker.addEventListener("pointermove", moveTimelinePointerDrag);
  marker.addEventListener("pointerup", endTimelinePointerDrag);
  marker.addEventListener("pointercancel", cancelTimelinePointerDrag);
  marker.addEventListener("lostpointercapture", cancelTimelinePointerDrag);
  marker.addEventListener("keydown", event => moveTimelineMarkerByKeyboard(event, trackKey, index));
  updateTimelineChartMarker(marker, frame, index, atMs, durationMs, gain, title, trackKey, frames);
  return marker;
}

function timelineDragContext(trackKey, index, timelineId = state.selectedTimelineId) {
  const timeline = novelTimelineRegistry()?.[timelineId];
  const frames = timelineTrackFrames(timeline, trackKey);
  const frame = frames[index];
  if (!isObjectValue(frame)) return null;
  return { timeline, frames, frame, durationMs: timelineUsableDuration(Number(timeline.durationMs)) };
}

function updateTimelineFrameEditorTime(trackKey, index, atMs, timelineId = state.selectedTimelineId) {
  if (timelineId !== state.selectedTimelineId) return;
  for (const row of document.querySelectorAll(".nv-timeline-keyframe[data-timeline-track-key]")) {
    if (row.dataset.timelineTrackKey !== trackKey || row.dataset.timelineFrameIndex !== String(index)) continue;
    const input = row.querySelector("[data-timeline-at-ms]");
    if (input) {
      input.value = String(atMs);
      input.removeAttribute("aria-invalid");
    }
    const heading = row.querySelector(".nv-timeline-keyframe-title");
    if (heading) heading.textContent = heading.textContent.replace(/·\s*[-\d?.]+\s*ms/, `· ${atMs} ms`);
    return;
  }
}

function setTimelineFrameTime(trackKey, index, atMs, timelineId = state.selectedTimelineId) {
  const context = timelineDragContext(trackKey, index, timelineId);
  if (!context || context.frame.atMs === atMs) return false;
  context.frame.atMs = atMs;
  updateTimelineFrameEditorTime(trackKey, index, atMs, timelineId);
  if (timelineId === state.selectedTimelineId) refreshTimelineChart();
  return true;
}

function timelineSnappedTime(rawMs, shiftKey) {
  const step = shiftKey ? 1 : 10;
  return Math.round(rawMs / step) * step;
}

function nearestTimelineMarker(lane, clientX) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const marker of lane.querySelectorAll(".nv-timeline-chart-marker")) {
    const rect = marker.getBoundingClientRect();
    const distance = Math.abs(clientX - (rect.left + rect.width / 2));
    if (distance < nearestDistance) {
      nearest = marker;
      nearestDistance = distance;
    }
  }
  return nearest && nearestDistance <= 12 ? nearest : null;
}

function beginTimelinePointerDrag(event, trackKey, index, marker) {
  if (event.button !== 0 || timelinePointerDrag || state.saving || state.historyBusy || state.historyBlocked) return;
  const context = timelineDragContext(trackKey, index);
  if (!context || timelineTimeBounds(context.frames, index, context.durationMs, trackKey).disabled) return;
  const lane = marker.closest(".nv-timeline-chart-lane");
  const rect = lane?.getBoundingClientRect();
  const initialAtMs = Number(context.frame.atMs);
  if (!rect || rect.width <= 0 || !Number.isSafeInteger(initialAtMs)) return;
  event.preventDefault();
  const pointerAtMs = (event.clientX - rect.left) / rect.width * context.durationMs;
  timelinePointerDrag = {
    pointerId: event.pointerId,
    marker,
    trackKey,
    timelineId: state.selectedTimelineId,
    index,
    initialAtMs,
    durationMs: context.durationMs,
    laneLeft: rect.left,
    laneWidth: rect.width,
    pointerOffsetMs: initialAtMs - pointerAtMs,
    moved: false,
  };
  marker.focus({ preventScroll: true });
  marker.classList.add("is-dragging");
  try { marker.setPointerCapture(event.pointerId); } catch { /* the browser may have cancelled the initiating pointer */ }
}

function applyTimelinePointerPosition(event, drag) {
  if (event.cancelable) event.preventDefault();
  const context = timelineDragContext(drag.trackKey, drag.index);
  if (!context || state.selectedTimelineId !== drag.timelineId) return;
  const rawMs = (event.clientX - drag.laneLeft) / drag.laneWidth * drag.durationMs + drag.pointerOffsetMs;
  const snapped = timelineSnappedTime(rawMs, event.shiftKey);
  const bounds = timelineTimeBounds(context.frames, drag.index, drag.durationMs, drag.trackKey);
  const nextAtMs = Math.max(bounds.min, Math.min(bounds.max, snapped));
  if (nextAtMs === context.frame.atMs) return;
  drag.moved = true;
  setTimelineFrameTime(drag.trackKey, drag.index, nextAtMs);
}

function moveTimelinePointerDrag(event) {
  const drag = timelinePointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  applyTimelinePointerPosition(event, drag);
}

function timelineBeforePointerDrag(drag) {
  const before = structuredClone(state.story);
  const beforeFrame = timelineFrameAt(before.timelines?.[drag.timelineId], drag.trackKey, drag.index);
  if (!beforeFrame) return null;
  beforeFrame.atMs = drag.initialAtMs;
  return before;
}

function finishTimelinePointerDrag(commit) {
  const drag = timelinePointerDrag;
  if (!drag) return;
  if (state.selectedTimelineId !== drag.timelineId) commit = false;
  const context = timelineDragContext(drag.trackKey, drag.index, drag.timelineId);
  const currentAtMs = context?.frame?.atMs;
  timelinePointerDrag = null;
  drag.marker.classList.remove("is-dragging");
  try {
    if (drag.marker.hasPointerCapture(drag.pointerId)) drag.marker.releasePointerCapture(drag.pointerId);
  } catch { /* pointer capture can end before its loss event is delivered */ }
  if (!commit) {
    setTimelineFrameTime(drag.trackKey, drag.index, drag.initialAtMs, drag.timelineId);
    if (state.historySavedGeneration < state.historyGeneration) void persistHistory();
    return;
  }
  if (currentAtMs === drag.initialAtMs || !drag.moved) return;
  const before = timelineBeforePointerDrag(drag);
  if (!before) return;
  recordHistory("story", `timeline:${drag.timelineId}:${drag.trackKey}:${drag.index}:drag`, before);
  markDirty("story");
}

function endTimelinePointerDrag(event) {
  const drag = timelinePointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  applyTimelinePointerPosition(event, drag);
  finishTimelinePointerDrag(true);
}

function cancelTimelinePointerDrag(event) {
  const drag = timelinePointerDrag;
  if (!drag || event.pointerId !== undefined && drag.pointerId !== event.pointerId) return;
  finishTimelinePointerDrag(false);
}

function moveTimelineMarkerByKeyboard(event, trackKey, index) {
  const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
  if (!direction) return;
  event.preventDefault();
  if (timelinePointerDrag || state.saving || state.historyBusy || state.historyBlocked) return;
  const context = timelineDragContext(trackKey, index);
  if (!context) return;
  const bounds = timelineTimeBounds(context.frames, index, context.durationMs, trackKey);
  if (bounds.disabled) return;
  const currentAtMs = Number(context.frame.atMs);
  if (!Number.isSafeInteger(currentAtMs)) return;
  const step = event.shiftKey ? 1 : 10;
  const nextAtMs = Math.max(bounds.min, Math.min(bounds.max, currentAtMs + direction * step));
  if (nextAtMs === currentAtMs) return;
  historyMutation("story", `timeline:${state.selectedTimelineId}:${trackKey}:${index}:keyboard`, () => {
    const current = timelineFrameAt(novelTimelineRegistry()?.[state.selectedTimelineId], trackKey, index);
    if (current) current.atMs = nextAtMs;
  });
  updateTimelineFrameEditorTime(trackKey, index, nextAtMs);
  refreshTimelineChart();
}

function refreshTimelineChart() {
  const chart = byId("novel-timeline-chart");
  const timeline = novelTimelineRegistry()?.[state.selectedTimelineId];
  if (!chart || !isObjectValue(timeline)) return;
  const durationMs = Number(timeline.durationMs);
  const usableDuration = timelineUsableDuration(durationMs);
  const scales = chart.querySelectorAll(".nv-timeline-chart-scale");
  if (scales[0]) scales[0].textContent = "0 ms";
  if (scales[1]) scales[1].textContent = `${Number.isFinite(durationMs) ? durationMs : "?"} ms`;
  for (const row of chart.querySelectorAll(".nv-timeline-chart-row")) {
    const trackKey = row.dataset.timelineTrackKey ?? "";
    const frames = timelineTrackFrames(timeline, trackKey);
    if (trackKey.startsWith("audioGain:")) {
      const gainTrack = timeline.audioGains?.[Number(trackKey.slice("audioGain:".length))];
      const label = row.querySelector(".nv-timeline-chart-label");
      if (label) label.textContent = `音量 · ${gainTrack?.channel || "未命名声道"}`;
    }
    const lane = row.querySelector(".nv-timeline-chart-lane");
    if (!lane) continue;
    const existing = new Map([...lane.querySelectorAll(".nv-timeline-chart-marker")].map(marker => [Number(marker.dataset.frameIndex), marker]));
    const liveIndices = new Set(frames.map((_frame, index) => index));
    for (const [index, marker] of existing) {
      if (!liveIndices.has(index) && marker !== timelinePointerDrag?.marker) marker.remove();
    }
    for (const index of timelineSortedIndices(frames)) {
      const frame = frames[index];
      const atMs = Number(frame?.atMs ?? 0);
      let marker = existing.get(index);
      if (!marker) {
        marker = timelineChartMarker(frame, index, atMs, usableDuration, trackKey.startsWith("audioGain:"), row.querySelector(".nv-timeline-chart-label")?.textContent ?? "时间轴", trackKey, frames);
        lane.append(marker);
      } else {
        updateTimelineChartMarker(marker, frame, index, atMs, usableDuration, trackKey.startsWith("audioGain:"), row.querySelector(".nv-timeline-chart-label")?.textContent ?? "时间轴", trackKey, frames);
      }
    }
  }
}

function timelineSortedIndices(frames) {
  return frames.map((_frame, index) => index).sort((a, b) => Number(frames[a]?.atMs ?? 0) - Number(frames[b]?.atMs ?? 0) || a - b);
}

function timelineTimeField(parent, label, value, onChange, durationMs, bounds = null) {
  const duration = timelineUsableDuration(durationMs);
  const input = field(parent, label, value, onChange, {
    type: "number",
    min: bounds?.min ?? 0,
    max: bounds?.max ?? duration,
    step: 1,
    integer: true,
    safeInteger: true,
    readOnly: Boolean(bounds?.disabled),
  });
  input.dataset.timelineAtMs = "true";
  if (bounds?.disabled) input.title = "运动轨首帧固定在 0 ms。";
  return input;
}

function nextTimelineFrameTime(frames, durationMs) {
  if (!frames.length) return 0;
  const lastAtMs = Number(frames.at(-1)?.atMs);
  const nextAtMs = lastAtMs + 300;
  return Number.isSafeInteger(lastAtMs) && nextAtMs <= durationMs ? nextAtMs : null;
}

function updateTimelineFrame(frames, index, fallback, patch) {
  const current = isObjectValue(frames[index]) ? frames[index] : {};
  frames[index] = { ...fallback, ...current, ...patch };
  return frames[index];
}

function renderTimelinePanel() {
  const panel = node("section", "nv-story-panel nv-timelines-panel");
  const heading = node("div", "nv-panel-heading");
  const copy = node("div", "");
  copy.append(node("h1", "", "时间轴预设"), node("p", "", "相机、角色运动、音频 cue 和音量包络共用一个时间范围；关键帧位置按 atMs 同步显示。场景只保存预设 ID，所有编辑进入 story 草稿与撤销历史。"));
  heading.append(copy);
  const actions = node("div", "nv-inline-actions");
  actions.append(button("＋ 新建预设", "primary", () => {
    const registry = novelTimelineRegistry() ?? {};
    const id = nextTimelineId(registry);
    historyMutation("story", `timeline:create:${id}`, () => {
      state.story.timelines ??= {};
      state.story.timelines[id] = { durationMs: 1200 };
    });
    state.selectedTimelineId = id;
    rerenderWorkspace();
  }));
  heading.append(actions);
  panel.append(heading);

  const registry = novelTimelineRegistry();
  if (!registry) {
    panel.append(node("p", "nv-runtime-error", "时间轴表结构无效；请通过“修复为空表”恢复可编辑对象。"));
    panel.append(button("修复为空表", "quiet", () => {
      historyMutation("story", "timeline:repair-registry", () => { state.story.timelines = {}; });
      state.selectedTimelineId = "";
      rerenderWorkspace();
    }));
    return panel;
  }
  const ids = Object.keys(registry).sort();
  if (!ids.length) {
    panel.append(node("div", "nv-empty", "还没有时间轴预设。新建后可添加相机、角色和音频轨。"));
    return panel;
  }

  if (!ids.includes(state.selectedTimelineId)) state.selectedTimelineId = ids[0];
  const pickerRow = node("div", "nv-timeline-picker");
  const picker = node("select", "nv-input");
  picker.setAttribute("aria-label", "当前时间轴预设");
  for (const id of ids) option(picker, id, id);
  picker.value = state.selectedTimelineId;
  picker.addEventListener("change", () => {
    state.selectedTimelineId = picker.value;
    rerenderWorkspace();
  });
  const pickerLabel = node("label", "nv-field");
  pickerLabel.append(node("span", "nv-field-label", "选择预设"), picker);
  pickerRow.append(pickerLabel);
  panel.append(pickerRow);

  const timelineId = state.selectedTimelineId;
  const rawTimeline = registry[timelineId];
  if (!isObjectValue(rawTimeline)) {
    panel.append(node("p", "nv-runtime-error", `预设 ${timelineId} 不是对象，schema 诊断会定位此定义。`));
    panel.append(button("替换为 1200 ms 空预设", "quiet", () => {
      historyMutation("story", `timeline:repair:${timelineId}`, () => { registry[timelineId] = { durationMs: 1200 }; });
      rerenderWorkspace();
    }));
    return panel;
  }
  const timeline = rawTimeline;
  const references = timelineSceneReferences(timelineId);
  const definition = node("section", "nv-timeline-definition");
  const nameRow = node("div", "nv-timeline-name-row");
  state.historyContext = `timeline:${timelineId}`;
  field(nameRow, "预设 ID", timelineId, next => {
    const clean = String(next).trim();
    if (!clean || clean === timelineId) return true;
    if (Object.hasOwn(registry, clean)) {
      setNotice(`时间轴预设 ${clean} 已存在。`, "error");
      return false;
    }
    const entries = Object.entries(registry).map(([key, value]) => [key === timelineId ? clean : key, value]);
    for (const key of Object.keys(registry)) delete registry[key];
    for (const [key, value] of entries) registry[key] = value;
    for (const instructions of Object.values(state.story.script ?? {})) {
      if (!Array.isArray(instructions)) continue;
      for (const instruction of instructions) if (instruction?.type === "scene" && instruction.timeline === timelineId) instruction.timeline = clean;
    }
    state.selectedTimelineId = clean;
    return true;
  }, { onChangeOnly: true, rerender: true });
  const durationField = field(nameRow, "时长 (ms)", timeline.durationMs ?? "", value => { timeline.durationMs = value; refreshTimelineChart(); }, { type: "number", min: 1, step: 1, integer: true, safeInteger: true });
  durationField.setAttribute("data-timeline-field", "durationMs");
  nameRow.append(button("删除预设", "danger quiet", () => {
    if (references.length) return;
    historyMutation("story", `timeline:delete:${timelineId}`, () => {
      delete registry[timelineId];
      if (!Object.keys(registry).length) delete state.story.timelines;
    });
    state.selectedTimelineId = "";
    rerenderWorkspace();
  }, references.length ? `仍被 ${references.map(item => `${item.label}:${item.index + 1}`).join("、")} 使用` : "删除未引用预设"));
  nameRow.lastElementChild.disabled = references.length > 0;
  nameRow.lastElementChild.dataset.timelineDelete = timelineId;
  definition.append(nameRow);
  if (references.length) definition.append(node("p", "nv-field-help", `已被 ${references.map(item => `${item.label} · 第 ${item.index + 1} 条场景`).join("、")} 引用；先在场景中取消引用后才能删除。`));

  const durationMs = Number(timeline.durationMs);
  const chart = node("div", "nv-timeline-chart");
  chart.id = "novel-timeline-chart";
  chart.append(node("div", "nv-timeline-chart-scale", "0 ms"), node("div", "nv-timeline-chart-scale nv-timeline-chart-end", `${Number.isFinite(durationMs) ? durationMs : "?"} ms`));
  definition.append(chart);
  definition.append(node("p", "nv-timeline-chart-help", "拖动关键帧修改时间；松开后作为一步撤销。方向键按 10 ms 调整，Shift+方向键按 1 ms；拖动默认吸附 10 ms，按住 Shift 吸附 1 ms。按 Esc 取消拖动。相机、角色和音量轨首帧固定，其他关键帧保持至少 1 ms 间隔；音频 cue 可同刻。"));
  const cameraFrames = Array.isArray(timeline.camera) ? timeline.camera : [];
  timelineTrackRow(chart, "相机", cameraFrames, durationMs, "is-camera", "camera");
  const actors = Array.isArray(timeline.actors) ? timeline.actors : [];
  for (const [index, actor] of actors.entries()) timelineTrackRow(chart, `角色 · ${actor?.id || `轨道 ${index + 1}`}`, Array.isArray(actor?.keyframes) ? actor.keyframes : [], durationMs, "is-actor", `actor:${index}`);
  const audio = Array.isArray(timeline.audio) ? timeline.audio : [];
  timelineTrackRow(chart, "音频 cue", audio, durationMs, "is-audio", "audio");
  const audioGains = Array.isArray(timeline.audioGains) ? timeline.audioGains : [];
  for (const [index, track] of audioGains.entries()) {
    timelineTrackRow(chart, `音量 · ${track?.channel || "未命名声道"}`, Array.isArray(track?.keyframes) ? track.keyframes : [], durationMs, "is-audio-gain", `audioGain:${index}`);
  }
  const cameraSection = node("section", "nv-timeline-track-editor");
  const cameraHeading = node("div", "nv-model-subhead");
  cameraHeading.append(node("strong", "", "相机轨"), node("span", "", `${cameraFrames.length} 个关键帧`));
  cameraSection.append(cameraHeading);
  if (!Array.isArray(timeline.camera) && Object.hasOwn(timeline, "camera")) {
    cameraSection.append(node("p", "nv-runtime-error", "camera 必须是关键帧数组。"), button("替换为空相机轨", "quiet", () => {
      historyMutation("story", `timeline:camera:repair:${timelineId}`, () => { timeline.camera = []; });
      rerenderWorkspace();
    }));
  }
  if (!cameraFrames.length) cameraSection.append(node("div", "nv-empty", "尚无相机关键帧。"));
  for (const frameIndex of timelineSortedIndices(cameraFrames)) {
    const frame = isObjectValue(cameraFrames[frameIndex]) ? cameraFrames[frameIndex] : {};
    const value = isObjectValue(frame.value) ? frame.value : {};
    const row = node("div", "nv-timeline-keyframe nv-camera-keyframe");
    row.dataset.timelineTrackKey = "camera";
    row.dataset.timelineFrameIndex = String(frameIndex);
    row.append(node("div", "nv-timeline-keyframe-title", `相机关键帧 · ${frame.atMs ?? "?"} ms`));
    state.historyContext = `timeline:${timelineId}:camera:${frameIndex}`;
    timelineTimeField(row, `相机 atMs ${frameIndex + 1}`, frame.atMs ?? "", next => {
      updateTimelineFrame(timeline.camera, frameIndex, { atMs: 0, value: { x: 0, y: 0, scale: 1 } }, { atMs: next });
      refreshTimelineChart();
    }, durationMs, timelineTimeBounds(cameraFrames, frameIndex, durationMs, "camera"));
    field(row, `相机 easing ${frameIndex + 1}`, frame.easing ?? "linear", next => {
      const current = updateTimelineFrame(timeline.camera, frameIndex, { atMs: 0, value: { x: 0, y: 0, scale: 1 } }, {});
      if (next === "linear") delete current.easing; else current.easing = next;
    }, { select: [["linear", "匀速"], ["easeInOut", "平滑进出"]] });
    for (const key of ["x", "y", "scale"]) {
      field(row, `相机 ${key} ${frameIndex + 1}`, value[key] ?? (key === "scale" ? 1 : 0), next => {
        const current = updateTimelineFrame(timeline.camera, frameIndex, { atMs: 0, value: { x: 0, y: 0, scale: 1 } }, {});
        const pose = isObjectValue(current.value) ? current.value : { x: 0, y: 0, scale: 1 };
        current.value = { ...pose, [key]: next };
      }, { type: "number", min: key === "scale" ? 0.1 : -4096, max: key === "scale" ? 8 : 4096, step: "any" });
    }
    row.append(button("移除关键帧", "danger quiet", () => {
      historyMutation("story", `timeline:camera:remove:${timelineId}:${frameIndex}`, () => { timeline.camera = timeline.camera.filter((_item, index) => index !== frameIndex); });
      rerenderWorkspace();
    }));
    cameraSection.append(row);
  }
  cameraSection.append(button("＋ 添加相机关键帧", "quiet", () => {
    historyMutation("story", `timeline:camera:add:${timelineId}`, () => {
      const frames = Array.isArray(timeline.camera) ? timeline.camera : [];
      timeline.camera = [...frames, { atMs: frames.length ? Math.min(durationMs || 1, Number(frames.at(-1)?.atMs ?? 0) + 300) : 0, value: { x: 0, y: 0, scale: 1 } }];
    });
    rerenderWorkspace();
  }));
  definition.append(cameraSection);

  const actorSection = node("section", "nv-timeline-track-editor");
  const actorHeading = node("div", "nv-model-subhead");
  actorHeading.append(node("strong", "", "角色轨"), node("span", "", `${actors.length} 条轨道`));
  actorSection.append(actorHeading);
  if (!Array.isArray(timeline.actors) && Object.hasOwn(timeline, "actors")) {
    actorSection.append(node("p", "nv-runtime-error", "actors 必须是角色轨道数组。"), button("替换为空角色轨", "quiet", () => {
      historyMutation("story", `timeline:actors:repair:${timelineId}`, () => { timeline.actors = []; });
      rerenderWorkspace();
    }));
  }
  for (const [actorIndex, actorRaw] of actors.entries()) {
    const actor = isObjectValue(actorRaw) ? actorRaw : {};
    const track = node("div", "nv-timeline-actor-track");
    const trackHead = node("div", "nv-timeline-track-heading");
    state.historyContext = `timeline:${timelineId}:actor:${actorIndex}:id`;
    const actorId = field(trackHead, `角色轨道 ${actorIndex + 1} ID`, actor.id ?? "", next => {
      const current = isObjectValue(timeline.actors[actorIndex]) ? timeline.actors[actorIndex] : {};
      timeline.actors[actorIndex] = { ...current, id: next };
    }, { onChangeOnly: true, rerender: true });
    actorId.setAttribute("data-timeline-field", `actors.${actorIndex}.id`);
    trackHead.append(button("删除角色轨", "danger quiet", () => {
      historyMutation("story", `timeline:actor:remove:${timelineId}:${actorIndex}`, () => { timeline.actors = timeline.actors.filter((_item, index) => index !== actorIndex); });
      rerenderWorkspace();
    }));
    track.append(trackHead);
    const frames = Array.isArray(actor.keyframes) ? actor.keyframes : [];
    if (!Array.isArray(actor.keyframes) && Object.hasOwn(actor, "keyframes")) {
      track.append(node("p", "nv-runtime-error", "角色 keyframes 必须是关键帧数组。"), button("替换为空关键帧列表", "quiet", () => {
        historyMutation("story", `timeline:actor:repair:${timelineId}:${actorIndex}`, () => { actor.keyframes = []; });
        rerenderWorkspace();
      }));
    }
    if (!frames.length) track.append(node("div", "nv-empty", "尚无角色关键帧。"));
    for (const frameIndex of timelineSortedIndices(frames)) {
      const frame = isObjectValue(frames[frameIndex]) ? frames[frameIndex] : {};
      const value = isObjectValue(frame.value) ? frame.value : {};
      const position = isObjectValue(value.position) ? value.position : {};
      const row = node("div", "nv-timeline-keyframe nv-actor-keyframe");
      row.dataset.timelineTrackKey = `actor:${actorIndex}`;
      row.dataset.timelineFrameIndex = String(frameIndex);
      row.append(node("div", "nv-timeline-keyframe-title", `${actor.id || `角色轨道 ${actorIndex + 1}`} · ${frame.atMs ?? "?"} ms`));
      state.historyContext = `timeline:${timelineId}:actor:${actorIndex}:${frameIndex}`;
      timelineTimeField(row, `角色 ${actorIndex + 1} atMs ${frameIndex + 1}`, frame.atMs ?? "", next => {
        updateTimelineFrame(actor.keyframes, frameIndex, { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }, { atMs: next });
        refreshTimelineChart();
      }, durationMs, timelineTimeBounds(frames, frameIndex, durationMs, `actor:${actorIndex}`));
      field(row, `角色 ${actorIndex + 1} easing ${frameIndex + 1}`, frame.easing ?? "linear", next => {
        const current = updateTimelineFrame(actor.keyframes, frameIndex, { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }, {});
        if (next === "linear") delete current.easing; else current.easing = next;
      }, { select: [["linear", "匀速"], ["easeInOut", "平滑进出"]] });
      for (const key of ["x", "y"]) {
        field(row, `角色 ${actorIndex + 1} 位置 ${key} ${frameIndex + 1}`, position[key] ?? 0, next => {
          const current = updateTimelineFrame(actor.keyframes, frameIndex, { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }, {});
          const pose = isObjectValue(current.value) ? current.value : { position: { x: 0, y: 0 }, scale: 1, rotation: 0 };
          const point = isObjectValue(pose.position) ? pose.position : { x: 0, y: 0 };
          current.value = { ...pose, position: { ...point, [key]: next } };
        }, { type: "number", min: -4096, max: 4096, step: "any" });
      }
      field(row, `角色 ${actorIndex + 1} 缩放 ${frameIndex + 1}`, value.scale ?? 1, next => {
        const current = updateTimelineFrame(actor.keyframes, frameIndex, { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }, {});
        const pose = isObjectValue(current.value) ? current.value : { position: { x: 0, y: 0 }, scale: 1, rotation: 0 };
        current.value = { ...pose, scale: next };
      }, { type: "number", min: 0.05, max: 8, step: "any" });
      field(row, `角色 ${actorIndex + 1} 旋转 ° ${frameIndex + 1}`, value.rotation ?? 0, next => {
        const current = updateTimelineFrame(actor.keyframes, frameIndex, { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }, {});
        const pose = isObjectValue(current.value) ? current.value : { position: { x: 0, y: 0 }, scale: 1, rotation: 0 };
        current.value = { ...pose, rotation: next };
      }, { type: "number", min: -360, max: 360, step: "any" });
      row.append(button("移除关键帧", "danger quiet", () => {
        historyMutation("story", `timeline:actor:keyframe:remove:${timelineId}:${actorIndex}:${frameIndex}`, () => { actor.keyframes = actor.keyframes.filter((_item, index) => index !== frameIndex); });
        rerenderWorkspace();
      }));
      track.append(row);
    }
    track.append(button("＋ 添加角色关键帧", "quiet", () => {
      historyMutation("story", `timeline:actor:keyframe:add:${timelineId}:${actorIndex}`, () => {
        const current = isObjectValue(timeline.actors[actorIndex]) ? timeline.actors[actorIndex] : {};
        const keyframes = Array.isArray(current.keyframes) ? current.keyframes : [];
        timeline.actors[actorIndex] = { ...current, keyframes: [...keyframes, { atMs: keyframes.length ? Math.min(durationMs || 1, Number(keyframes.at(-1)?.atMs ?? 0) + 300) : 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }] };
      });
      rerenderWorkspace();
    }));
    actorSection.append(track);
  }
  actorSection.append(button("＋ 添加角色轨", "quiet", () => {
    const used = new Set(actors.map(actor => actor?.id).filter(Boolean));
    const characterIds = Object.keys(state.assets.characters ?? {}).sort();
    const id = characterIds.find(candidate => !used.has(candidate)) ?? `actor_${actors.length + 1}`;
    historyMutation("story", `timeline:actor:add:${timelineId}:${id}`, () => {
      const current = Array.isArray(timeline.actors) ? timeline.actors : [];
      timeline.actors = [...current, { id, keyframes: [{ atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } }] }];
    });
    rerenderWorkspace();
  }));
  definition.append(actorSection);

  const audioSection = node("section", "nv-timeline-track-editor");
  const audioHeading = node("div", "nv-model-subhead");
  audioHeading.append(node("strong", "", "音频 cue 轨"), node("span", "", `${audio.length} 个事件`));
  audioSection.append(audioHeading);
  if (!Array.isArray(timeline.audio) && Object.hasOwn(timeline, "audio")) {
    audioSection.append(node("p", "nv-runtime-error", "audio 必须是音频 cue 事件数组。"), button("替换为空音频轨", "quiet", () => {
      historyMutation("story", `timeline:audio:repair:${timelineId}`, () => { timeline.audio = []; });
      rerenderWorkspace();
    }));
  }
  if (!audio.length) audioSection.append(node("div", "nv-empty", "尚无音频 cue。"));
  const cues = Object.keys(state.assets.audio ?? {}).sort();
  for (const eventIndex of timelineSortedIndices(audio)) {
    const event = isObjectValue(audio[eventIndex]) ? audio[eventIndex] : {};
    const row = node("div", "nv-timeline-keyframe nv-audio-keyframe");
    row.dataset.timelineTrackKey = "audio";
    row.dataset.timelineFrameIndex = String(eventIndex);
    row.append(node("div", "nv-timeline-keyframe-title", `音频事件 ${eventIndex + 1} · ${event.atMs ?? "?"} ms`));
    state.historyContext = `timeline:${timelineId}:audio:${eventIndex}`;
    let groupField;
    timelineTimeField(row, `音频 atMs ${eventIndex + 1}`, event.atMs ?? "", next => {
      const current = isObjectValue(timeline.audio[eventIndex]) ? timeline.audio[eventIndex] : {};
      timeline.audio[eventIndex] = { atMs: 0, cue: cues[0] ?? "", action: "play", ...current, atMs: next };
      refreshTimelineChart();
    }, durationMs, timelineTimeBounds(audio, eventIndex, durationMs, "audio"));
    const cueChoices = [["", "选择已注册 Cue"]];
    if (event.cue && !cues.includes(event.cue)) cueChoices.push([event.cue, `未注册：${event.cue}`]);
    for (const cue of cues) cueChoices.push([cue, cue]);
    field(row, `音频 Cue ${eventIndex + 1}`, event.cue ?? "", next => {
      const current = isObjectValue(timeline.audio[eventIndex]) ? timeline.audio[eventIndex] : {};
      timeline.audio[eventIndex] = { atMs: 0, cue: "", action: "play", ...current, cue: next };
    }, { select: cueChoices });
    field(row, `音频动作 ${eventIndex + 1}`, event.action ?? "play", next => {
      const current = isObjectValue(timeline.audio[eventIndex]) ? timeline.audio[eventIndex] : {};
      const updated = { atMs: 0, cue: cues[0] ?? "", ...current, action: next };
      if (next === "stop") delete updated.group;
      timeline.audio[eventIndex] = updated;
      if (next === "stop" && groupField) groupField.value = "";
    }, { select: [["play", "播放"], ["stop", "停止"]] });
    field(row, `音频声道 ${eventIndex + 1}`, event.channel ?? "", next => {
      const current = isObjectValue(timeline.audio[eventIndex]) ? timeline.audio[eventIndex] : {};
      const updated = { atMs: 0, cue: cues[0] ?? "", action: "play", ...current };
      if (next) updated.channel = next;
      else {
        delete updated.channel;
        delete updated.group;
      }
      timeline.audio[eventIndex] = updated;
      if (!next && groupField) groupField.value = "";
    }, { placeholder: "例如 sfx 或 music；使用混音分组时必填" });
    groupField = field(row, `混音分组 ${eventIndex + 1}`, event.group ?? "", next => {
      const current = isObjectValue(timeline.audio[eventIndex]) ? timeline.audio[eventIndex] : {};
      const updated = { atMs: 0, cue: cues[0] ?? "", action: "play", ...current };
      if (next) updated.group = next;
      else delete updated.group;
      timeline.audio[eventIndex] = updated;
    }, { select: audioGroupChoices(event.group) });
    checkbox(row, `音频循环 ${eventIndex + 1}`, Boolean(event.loop), enabled => {
      const current = isObjectValue(timeline.audio[eventIndex]) ? timeline.audio[eventIndex] : {};
      timeline.audio[eventIndex] = { atMs: 0, cue: cues[0] ?? "", action: "play", ...current, ...(enabled ? { loop: true } : { loop: false }) };
    });
    row.append(button("移除音频事件", "danger quiet", () => {
      historyMutation("story", `timeline:audio:remove:${timelineId}:${eventIndex}`, () => { timeline.audio = timeline.audio.filter((_item, index) => index !== eventIndex); });
      rerenderWorkspace();
    }));
    audioSection.append(row);
  }
  const addAudioCue = button("＋ 添加音频 cue", "quiet", () => {
    historyMutation("story", `timeline:audio:add:${timelineId}`, () => {
      const current = Array.isArray(timeline.audio) ? timeline.audio : [];
      timeline.audio = [...current, { atMs: current.length ? Math.min(durationMs || 1, Number(current.at(-1)?.atMs ?? 0) + 300) : 0, cue: cues[0] ?? "", action: "play", channel: "sfx", loop: false }];
    });
    rerenderWorkspace();
  }, cues.length ? undefined : "先在“视觉与音频资源”中登记至少一个 WAV Cue");
  addAudioCue.disabled = cues.length === 0;
  audioSection.append(addAudioCue);
  if (!cues.length) audioSection.append(button("打开视觉与音频资源", "quiet", () => { state.panel = "assets"; rerenderWorkspace(); }));
  definition.append(audioSection);

  const gainSection = node("section", "nv-timeline-track-editor nv-timeline-gain-editor");
  const gainHeading = node("div", "nv-model-subhead");
  gainHeading.append(node("strong", "", "音量包络轨"), node("span", "", `${audioGains.length} 条轨道`));
  gainSection.append(gainHeading);
  if (!Array.isArray(timeline.audioGains) && Object.hasOwn(timeline, "audioGains")) {
    gainSection.append(node("p", "nv-runtime-error", "audioGains 必须是音量轨道数组。"), button("替换为空音量包络", "quiet", () => {
      historyMutation("story", `timeline:audio-gains:repair:${timelineId}`, () => { timeline.audioGains = []; });
      rerenderWorkspace();
    }));
  }
  if (!audioGains.length) gainSection.append(node("div", "nv-empty", "尚无音量包络。为声道添加 0 到 1 之间的关键帧增益。"));
  for (const [trackIndex, trackRaw] of audioGains.entries()) {
    const track = isObjectValue(trackRaw) ? trackRaw : {};
    const trackPanel = node("div", "nv-timeline-gain-track");
    const trackHead = node("div", "nv-timeline-track-heading");
    state.historyContext = `timeline:${timelineId}:audioGain:${trackIndex}:channel`;
    field(trackHead, `音量轨道 ${trackIndex + 1} 声道`, track.channel ?? "", next => {
      const current = isObjectValue(timeline.audioGains[trackIndex]) ? timeline.audioGains[trackIndex] : {};
      timeline.audioGains[trackIndex] = { ...current, channel: next };
      refreshTimelineChart();
    }, { placeholder: "例如 sfx 或 music", onChangeOnly: true });
    trackHead.append(button("删除音量轨", "danger quiet", () => {
      historyMutation("story", `timeline:audio-gains:remove:${timelineId}:${trackIndex}`, () => {
        timeline.audioGains = timeline.audioGains.filter((_item, index) => index !== trackIndex);
        if (!timeline.audioGains.length) delete timeline.audioGains;
      });
      rerenderWorkspace();
    }));
    trackPanel.append(trackHead);
    const frames = Array.isArray(track.keyframes) ? track.keyframes : [];
    if (!Array.isArray(track.keyframes) && Object.hasOwn(track, "keyframes")) {
      trackPanel.append(node("p", "nv-runtime-error", "音量轨 keyframes 必须是关键帧数组。"), button("重置音量关键帧", "quiet", () => {
        historyMutation("story", `timeline:audio-gains:repair:${timelineId}:${trackIndex}`, () => {
          timeline.audioGains[trackIndex] = { ...track, keyframes: [{ atMs: 0, value: 1 }] };
        });
        rerenderWorkspace();
      }));
    }
    if (!frames.length) trackPanel.append(node("div", "nv-empty", "尚无音量关键帧。"));
    for (const frameIndex of timelineSortedIndices(frames)) {
      const frame = isObjectValue(frames[frameIndex]) ? frames[frameIndex] : {};
      const row = node("div", "nv-timeline-keyframe nv-audio-gain-keyframe");
      row.dataset.timelineGainFrame = String(frameIndex);
      row.dataset.timelineTrackKey = `audioGain:${trackIndex}`;
      row.dataset.timelineFrameIndex = String(frameIndex);
      row.append(node("div", "nv-timeline-keyframe-title", `${track.channel || `音量轨道 ${trackIndex + 1}`} · ${frame.atMs ?? "?"} ms · ${frame.value ?? "?"}`));
      state.historyContext = `timeline:${timelineId}:audioGain:${trackIndex}:${frameIndex}`;
      timelineTimeField(row, `音量 ${trackIndex + 1} atMs ${frameIndex + 1}`, frame.atMs ?? "", next => {
        const current = isObjectValue(timeline.audioGains[trackIndex]) ? timeline.audioGains[trackIndex] : {};
        const keyframes = Array.isArray(current.keyframes) ? [...current.keyframes] : [];
        keyframes[frameIndex] = { atMs: 0, value: 1, ...keyframes[frameIndex], atMs: next };
        timeline.audioGains[trackIndex] = { ...current, keyframes };
        refreshTimelineChart();
      }, durationMs, timelineTimeBounds(frames, frameIndex, durationMs, `audioGain:${trackIndex}`));
      field(row, `音量 ${trackIndex + 1} easing ${frameIndex + 1}`, frame.easing ?? "linear", next => {
        const current = isObjectValue(timeline.audioGains[trackIndex]) ? timeline.audioGains[trackIndex] : {};
        const keyframes = Array.isArray(current.keyframes) ? [...current.keyframes] : [];
        const keyframe = { atMs: 0, value: 1, ...keyframes[frameIndex] };
        if (next === "linear") delete keyframe.easing; else keyframe.easing = next;
        keyframes[frameIndex] = keyframe;
        timeline.audioGains[trackIndex] = { ...current, keyframes };
      }, { select: [["linear", "匀速"], ["easeInOut", "平滑进出"]] });
      field(row, `音量 ${trackIndex + 1} gain ${frameIndex + 1}`, frame.value ?? 1, next => {
        const current = isObjectValue(timeline.audioGains[trackIndex]) ? timeline.audioGains[trackIndex] : {};
        const keyframes = Array.isArray(current.keyframes) ? [...current.keyframes] : [];
        keyframes[frameIndex] = { atMs: 0, value: 1, ...keyframes[frameIndex], value: next };
        timeline.audioGains[trackIndex] = { ...current, keyframes };
      }, { type: "number", min: 0, max: 1, step: "any" });
      row.append(button("移除音量关键帧", "danger quiet", () => {
        historyMutation("story", `timeline:audio-gains:frame:remove:${timelineId}:${trackIndex}:${frameIndex}`, () => {
          const current = isObjectValue(timeline.audioGains[trackIndex]) ? timeline.audioGains[trackIndex] : {};
          const keyframes = Array.isArray(current.keyframes) ? current.keyframes.filter((_item, index) => index !== frameIndex) : [];
          timeline.audioGains[trackIndex] = { ...current, keyframes };
        });
        rerenderWorkspace();
      }));
      trackPanel.append(row);
    }
    const nextAtMs = nextTimelineFrameTime(frames, durationMs);
    const canAddFrame = frames.length < 64 && nextAtMs !== null;
    trackPanel.append(button("＋ 添加音量关键帧", "quiet", () => {
      const current = isObjectValue(timeline.audioGains[trackIndex]) ? timeline.audioGains[trackIndex] : {};
      const keyframes = Array.isArray(current.keyframes) ? current.keyframes : [];
      const nextAtMs = nextTimelineFrameTime(keyframes, durationMs);
      if (keyframes.length >= 64 || nextAtMs === null) return;
      historyMutation("story", `timeline:audio-gains:frame:add:${timelineId}:${trackIndex}`, () => {
        timeline.audioGains[trackIndex] = { ...current, keyframes: [...keyframes, { atMs: nextAtMs, value: 1 }] };
      });
      rerenderWorkspace();
    }, canAddFrame ? undefined : frames.length >= 64 ? "每条音量轨最多 64 个关键帧" : "末尾关键帧已到达时间轴时长"));
    trackPanel.lastElementChild.disabled = !canAddFrame;
    gainSection.append(trackPanel);
  }
  const usedGainChannels = new Set(audioGains.map(track => track?.channel).filter(value => typeof value === "string" && value));
  const preferredGainChannel = audio.map(event => event?.channel).find(channel => typeof channel === "string" && channel && !usedGainChannels.has(channel)) || "sfx";
  let newGainChannel = preferredGainChannel;
  for (let suffix = 2; usedGainChannels.has(newGainChannel); suffix++) newGainChannel = `${preferredGainChannel}-${suffix}`;
  const addGainTrack = button("＋ 添加音量包络轨", "quiet", () => {
    historyMutation("story", `timeline:audio-gains:add:${timelineId}:${newGainChannel}`, () => {
      const current = Array.isArray(timeline.audioGains) ? timeline.audioGains : [];
      timeline.audioGains = [...current, { channel: newGainChannel, keyframes: [{ atMs: 0, value: 1 }] }];
    });
    rerenderWorkspace();
  }, audioGains.length < 32 ? undefined : "每个预设最多 32 条音量轨");
  addGainTrack.disabled = audioGains.length >= 32;
  gainSection.append(addGainTrack);
  definition.append(gainSection);

  if (typeof state.engineModule?.novelTimelineStoryIssue === "function") {
    const issue = state.engineModule.novelTimelineStoryIssue(state.story);
    if (issue) definition.append(node("p", "nv-runtime-error nv-timeline-schema-error", issue));
  }
  for (const [eventIndex, event] of (Array.isArray(timeline.audio) ? timeline.audio : []).entries()) {
    if (event && typeof event.cue === "string" && event.cue && !Object.hasOwn(state.assets.audio ?? {}, event.cue)) {
      definition.append(node("p", "nv-runtime-error", `story.timelines.${timelineId}.audio[${eventIndex}].cue 引用了未注册音频 Cue ${event.cue}。`));
    }
  }
  panel.append(definition);
  return panel;
}

function inventoryVariableChoices(current, owner) {
  const inventory = state.story.inventory ?? {};
  const occupied = new Map();
  if (owner !== "currency" && inventory.currency?.variable) occupied.set(inventory.currency.variable, "货币");
  for (const [itemId, item] of Object.entries(inventory.items ?? {})) {
    if (owner !== itemId && item?.quantityVariable) occupied.set(item.quantityVariable, `条目 ${itemId}`);
  }
  const choices = [["", "选择存档数量变量"]];
  for (const [name, definition] of Object.entries(state.story.variableDefinitions ?? {})) {
    const usedBy = occupied.get(name);
    if (!inventoryVariableEligible(definition)) continue;
    if (usedBy && name !== current) continue;
    choices.push([name, usedBy ? `${name}（当前已被${usedBy}占用）` : name]);
  }
  if (current && !choices.some(([name]) => name === current)) {
    const definition = state.story.variableDefinitions?.[current];
    const reason = !definition ? "未声明" : !inventoryVariableEligible(definition) ? "需为默认值非负安全整数的存档变量" : `已被${occupied.get(current) ?? "其他字段"}占用`;
    choices.splice(1, 0, [current, `${current}（需修复：${reason}）`]);
  }
  return choices;
}

function renderInventory() {
  const panel = node("section", "nv-story-panel");
  panel.append(node("h1", "", "库存与商店"), node("p", "nv-field-help", "货币和物品数量直接复用故事中的存档变量。每个数量变量需声明为 lifetime=save、默认值为非负安全整数，并且不能重复使用。交易失败会跳转到指令指定的标签。"));
  const inventory = state.story.inventory;
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    panel.append(button("创建库存与商店", "secondary", () => {
      const firstVariable = Object.entries(state.story.variableDefinitions ?? {}).find(([, definition]) => inventoryVariableEligible(definition))?.[0] ?? "";
      historyMutation("story", "inventory:create", () => {
        state.story.inventory = { currency: { title: "金币", variable: firstVariable }, items: {} };
      });
      rerenderWorkspace();
    }));
    panel.append(button("打开变量声明", "quiet", () => { state.panel = "variables"; rerenderWorkspace(); }));
    return panel;
  }

  if (!inventory.currency || typeof inventory.currency !== "object" || Array.isArray(inventory.currency)) {
    panel.append(node("p", "nv-runtime-error", "货币配置结构无效。请通过 story.json 修复后重新打开；保存和 Guest 构建会拒绝无效结构。"));
  } else {
    state.historyContext = "inventory:currency";
    const currency = node("article", "nv-instruction nv-inventory-currency");
    currency.append(node("h2", "", "货币"));
    field(currency, "货币标题", inventory.currency.title ?? "", value => { inventory.currency.title = value; });
    field(currency, "货币数量变量", inventory.currency.variable ?? "", value => { inventory.currency.variable = value; }, { select: inventoryVariableChoices(inventory.currency.variable, "currency"), rerender: true });
    panel.append(currency);
  }

  const items = inventory.items && typeof inventory.items === "object" && !Array.isArray(inventory.items) ? inventory.items : null;
  if (!items) {
    panel.append(node("p", "nv-runtime-error", "物品列表结构无效。请通过 story.json 修复后重新打开。"));
    return panel;
  }
  panel.append(node("div", "nv-section-title", "物品条目"));
  for (const [itemId, item] of Object.entries(items)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      const invalid = node("article", "nv-instruction nv-inventory-item");
      invalid.append(node("h2", "", `无效条目 ${itemId}`), node("p", "nv-runtime-error", "条目结构无效，可删除后重新创建。"), button(`删除无效条目 ${itemId}`, "danger quiet", () => {
        historyMutation("story", `inventory:item:remove:${itemId}`, () => { delete inventory.items[itemId]; });
        rerenderWorkspace();
      }));
      panel.append(invalid);
      continue;
    }
    state.historyContext = `inventory:item:${itemId}`;
    const card = node("article", "nv-instruction nv-inventory-item");
    card.dataset.inventoryItem = itemId;
    const head = node("div", "nv-instruction-head");
    const idField = field(head, `物品 ID ${itemId}`, itemId, value => {
      const nextId = String(value).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(nextId) || nextId !== itemId && Object.hasOwn(items, nextId)) {
        setNotice("物品 ID 无效或已存在。", "error");
        return false;
      }
      if (nextId === itemId) return true;
      const nextItems = Object.create(null);
      for (const [key, value] of Object.entries(items)) Object.defineProperty(nextItems, key === itemId ? nextId : key, { value, enumerable: true, writable: true, configurable: true });
      inventory.items = nextItems;
      for (const instructions of Object.values(state.story.script)) if (Array.isArray(instructions)) for (const instruction of instructions) {
        if (instruction?.type === "trade" && instruction.item === itemId) instruction.item = nextId;
      }
      return true;
    }, { rerender: true, onChangeOnly: true });
    idField.dataset.inventoryItemId = itemId;
    head.append(button(`删除物品 ${itemId}`, "danger quiet", () => {
      historyMutation("story", `inventory:item:remove:${itemId}`, () => { delete inventory.items[itemId]; });
      rerenderWorkspace();
    }));
    card.append(head);
    field(card, `物品标题 ${itemId}`, item.title ?? "", value => { item.title = value; });
    field(card, `物品正文 ${itemId}`, item.body ?? "", value => { item.body = value; }, { multiline: true, wide: true });
    field(card, `物品数量变量 ${itemId}`, item.quantityVariable ?? "", value => { item.quantityVariable = value; }, { select: inventoryVariableChoices(item.quantityVariable, itemId), rerender: true });
    field(card, `购买价格 ${itemId}`, item.buyPrice, value => { item.buyPrice = value; }, { type: "number", safeInteger: true, min: 0, step: 1 });
    field(card, `出售价格 ${itemId}`, item.sellPrice, value => { if (value === undefined) delete item.sellPrice; else item.sellPrice = value; }, { type: "number", optional: true, safeInteger: true, min: 0, step: 1 });
    field(card, `最大数量 ${itemId}`, item.maxQuantity, value => { if (value === undefined) delete item.maxQuantity; else item.maxQuantity = value; }, { type: "number", optional: true, safeInteger: true, min: 1, step: 1 });
    panel.append(card);
  }
  const addItem = button("添加物品", "quiet", () => {
    const available = inventoryVariableChoices("", "__new_item").filter(([name]) => name);
    if (!available.length) { setNotice("请先在变量声明中创建一个未占用的存档数量变量。", "warning"); return; }
    const id = nextCatalogId(items, "item");
    historyMutation("story", `inventory:item:add:${id}`, () => {
      Object.defineProperty(items, id, { value: { title: "新物品", body: "", quantityVariable: available[0][0], buyPrice: 0 }, enumerable: true, writable: true, configurable: true });
    });
    rerenderWorkspace();
  });
  addItem.disabled = Object.keys(items).length >= 2048 || inventoryVariableChoices("", "__new_item").filter(([name]) => name).length === 0;
  if (Object.keys(items).length >= 2048) addItem.title = "最多添加 2048 个物品。";
  else if (addItem.disabled) addItem.title = "请先创建一个未占用的存档数量变量。";
  panel.append(addItem, button("打开变量声明", "quiet", () => { state.panel = "variables"; rerenderWorkspace(); }));
  panel.append(button("删除库存与商店", "danger quiet", () => {
    historyMutation("story", "inventory:remove", () => { delete state.story.inventory; });
    rerenderWorkspace();
  }));
  return panel;
}

function renderReplayEntries() {
  const panel = node("section", "nv-story-panel");
  panel.append(node("h1", "", "剧情鉴赏回放"), node("p", "nv-field-help", "回放使用隔离的同核心引擎，不写入当前游戏进度。入口应包含自己的场景和角色设置；不会推测历史舞台。可要求先完成指定结局。"));
  const availableLabels = labels().filter(label => state.story.script[label].length);
  const endingIds = [...new Set(Object.values(state.story.script).flatMap(list => list.filter(item => item.type === "ending").map(item => item.id)))];
  panel.append(button("添加回放入口", "secondary", () => {
    if (!availableLabels.length) { setNotice("请先为标签添加剧情指令。", "error"); return; }
    const id = window.prompt("回放入口 ID", "memory_1")?.trim();
    if (!id) return;
    if ((state.story.replayEntries ?? []).some(entry => entry.id === id)) { setNotice("回放入口 ID 已存在。", "error"); return; }
    historyMutation("story", "replay:add", () => { (state.story.replayEntries ??= []).push({ id, title: id, location: { label: availableLabels[0], index: 0 } }); });
    rerenderWorkspace();
  }));
  for (const [index, entry] of (state.story.replayEntries ?? []).entries()) {
    const card = node("article", "nv-instruction");
    card.dataset.replayId = entry.id;
    state.historyContext = `replay:${index}`;
    field(card, `入口 ID ${index + 1}`, entry.id, value => { entry.id = value; });
    field(card, `回放标题 ${index + 1}`, entry.title, value => { entry.title = value; });
    field(card, `入口标签 ${index + 1}`, entry.location.label, value => { entry.location.label = value; entry.location.index = 0; }, {
      select: availableLabels.map(label => [label, label]), rerender: true,
    });
    field(card, `入口指令 ${index + 1}`, entry.location.index, value => { entry.location.index = value; }, { type: "number", integer: true, min: 0, max: Math.max(0, (state.story.script[entry.location.label]?.length ?? 1) - 1) });
    field(card, `解锁结局 ${index + 1}`, entry.unlockEndingId ?? "", value => { if (value) entry.unlockEndingId = value; else delete entry.unlockEndingId; }, { select: [["", "无条件开放"], ...endingIds.map(id => [id, id])] });
    card.append(button(`删除回放入口 ${index + 1}`, "quiet danger", () => {
      historyMutation("story", `replay:remove:${index}`, () => { state.story.replayEntries.splice(index, 1); if (!state.story.replayEntries.length) delete state.story.replayEntries; });
      rerenderWorkspace();
    }));
    panel.append(card);
  }
  return panel;
}

async function mountWorkspacePanel(container, key) {
  const definition = workspacePanels[key];
  const styleId = `${definition.file}-styles`;
  if (!byId(styleId)) {
    const link = node("link");
    link.id = styleId;
    link.rel = "stylesheet";
    link.href = `/${definition.file}.css`;
    document.head.append(link);
  }
  container.replaceChildren(node("p", "nv-field-help", `正在加载${definition.name}…`));
  try {
    if (!state.workspaceModules.has(key)) state.workspaceModules.set(key, import(`${base}/${definition.file}.js`).catch(error => { state.workspaceModules.delete(key); throw error; }));
    const module = await state.workspaceModules.get(key);
    if (!["localization", "backups"].includes(key)) await loadRuntime();
    if (!container.isConnected || state.panel !== key) return;
    const result = await module.mount(container, {
      projectId, base, api,
      getStory: () => state.story,
      getAssets: () => state.assets,
      getEngineModule: () => state.engineModule,
      createSpinePreview: values => createStageSpinePreview(values),
      createLive2dPreview: values => createStageLive2dPreview(values),
      getRuntime: () => ({ engine: state.engine }),
      getDraft: () => state.authoringDraft,
      hasUnsavedChanges: () => state.dirty || Boolean(state.authoringDraft),
      setDraft: draft => {
        if (state.authoringDraft?.text === draft?.text && state.authoringDraft?.baseline === draft?.baseline) return;
        state.authoringDraft = draft;
        scheduleHistory();
      },
      getSelection: () => ({ label: state.selectedLabel, index: state.selectedSceneIndex }),
      commitScene: (historyKey, mutate) => historyMutation("story", historyKey, mutate),
      commitStory: candidate => {
        const validation = state.engineModule.createNovelEngine(candidate);
        validation.dispose();
        historyMutation("story", "authoring:apply", () => {
          state.story = structuredClone(candidate);
          if (!Object.hasOwn(state.story.script, state.selectedLabel)) state.selectedLabel = state.story.start;
        });
        return { story: state.story };
      },
    });
    const dispose = typeof result === "function" ? result : result?.dispose;
    if (container.isConnected && state.panel === key) state.workspaceDispose = dispose;
    else dispose?.();
  } catch (error) {
    if (container.isConnected) container.replaceChildren(node("p", "nv-field-help", `无法打开${definition.name}：${error.message}`));
  }
}

function renderStageSelection(parent) {
  const controls = node("div", "nv-row");
  const label = node("select");
  label.setAttribute("aria-label", "舞台标签");
  for (const name of labels()) option(label, name, name);
  label.value = state.selectedLabel;
  label.addEventListener("change", () => { state.selectedLabel = label.value; state.selectedSceneIndex = 0; rerenderWorkspace(); });
  const scene = node("select");
  scene.setAttribute("aria-label", "舞台场景");
  const scenes = selectedInstructions().flatMap((instruction, index) => instruction.type === "scene" ? [index] : []);
  if (!scenes.includes(state.selectedSceneIndex)) state.selectedSceneIndex = scenes[0] ?? -1;
  for (const index of scenes) option(scene, String(index), `${state.selectedLabel}:${index} · ${selectedInstructions()[index].background ?? "保留背景"}`);
  scene.value = String(state.selectedSceneIndex);
  scene.addEventListener("change", () => { state.selectedSceneIndex = Number(scene.value); rerenderWorkspace(); });
  controls.append(label, scene);
  parent.append(controls);
}

function renameRecordKey(record, oldKey, nextKey) {
  const clean = String(nextKey).trim();
  if (!clean || clean === oldKey) return oldKey;
  if (Object.prototype.hasOwnProperty.call(record, clean)) {
    setNotice(`资源键 ${clean} 已存在。`, "error");
    rerenderWorkspace();
    return oldKey;
  }
  const entries = Object.entries(record).map(([key, value]) => [key === oldKey ? clean : key, value]);
  for (const key of Object.keys(record)) delete record[key];
  for (const [key, value] of entries) record[key] = value;
  return clean;
}

function addAssetKey(record, promptText, suggested) {
  const key = window.prompt(promptText, suggested)?.trim();
  if (!key) return;
  if (Object.prototype.hasOwnProperty.call(record, key)) { setNotice(`资源键 ${key} 已存在。`, "error"); return; }
  historyMutation("assets", `asset:add:${key}`, () => { record[key] = ""; });
  rerenderWorkspace();
}

function localCollectionDiagnostics() {
  if (state.assets.collections === undefined) return [];
  const validate = state.engineModule?.validateNovelCollections;
  if (typeof validate !== "function") {
    return [{ severity: "error", code: "assets.collections.validator", message: "视觉小说收藏集校验器不可用；请重新打开编辑器后再保存或构建。", location: { field: "collections" } }];
  }
  return validate(state.assets.collections, { story: state.story, characters: state.assets.characters })
    .map(issue => ({ severity: "error", code: issue.code, message: `${issue.path}: ${issue.message}`, location: { field: issue.path } }));
}

function localAssetDiagnostics() {
  const registry = state.assets;
  if (!registry || typeof registry !== "object" || !registry.backgrounds || !registry.characters || !registry.cgs || !registry.audio) {
    return [{ severity: "error", code: "assets.schema", message: "资源注册表需要 backgrounds、characters、cgs、audio 四个对象。" }];
  }
  const diagnostics = [];
  diagnostics.push(...localCollectionDiagnostics());
  const check = (label, path, kind) => {
    if (typeof path !== "string" || !path || !/^[\w./-]+$/.test(path) || path.includes("\\") || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) {
      diagnostics.push({ severity: "error", code: "assets.path", message: `${label} 使用了不安全的项目相对路径。` });
      return;
    }
    if (kind === "image" && !/\.(png|svg)$/i.test(path)) diagnostics.push({ severity: "error", code: "assets.path", message: `${label} 仅支持 PNG 或 SVG 图片。` });
    if (kind === "audio" && (!path.startsWith("audio/") || !/\.wav$/i.test(path))) diagnostics.push({ severity: "error", code: "assets.path", message: `${label} 应指向 assets/audio/ 下的 WAV 资源。` });
    if (kind === "video" && !/\.mp4$/i.test(path)) diagnostics.push({ severity: "error", code: "assets.path", message: `${label} 仅支持 assets/ 下的 MP4 视频。` });
    if (kind === "spine-source" && !/\.(json|skel)$/i.test(path)) diagnostics.push({ severity: "error", code: "assets.path", message: `${label} 应使用 Spine JSON 或 binary .skel 文件。` });
    if (kind === "spine-atlas" && !/\.atlas$/i.test(path)) diagnostics.push({ severity: "error", code: "assets.path", message: `${label} 应使用 .atlas 文件。` });
    if (kind === "live2d-source" && !/\.model3\.json$/i.test(path)) diagnostics.push({ severity: "error", code: "assets.path", message: `${label} 应使用 Live2D .model3.json 文件。` });
  };
  for (const [key, path] of Object.entries(registry.backgrounds)) check(`背景 ${key}`, path, "image");
  for (const [character, variants] of Object.entries(registry.characters)) {
    if (!variants || typeof variants !== "object" || Array.isArray(variants)) { diagnostics.push({ severity: "error", code: "assets.schema", message: `角色 ${character} 的表情映射无效。` }); continue; }
    for (const [expression, path] of Object.entries(variants)) check(`角色 ${character} / ${expression}`, path, "image");
  }
  for (const [key, cg] of Object.entries(registry.cgs)) check(`CG ${key}`, cg?.image, "image");
  for (const [key, path] of Object.entries(registry.audio)) check(`音频 ${key}`, path, "audio");
  for (const [key, path] of Object.entries(registry.videos ?? {})) check(`视频 cue ${key}`, path, "video");
  if (registry.atmospheres !== undefined) {
    if (!registry.atmospheres || typeof registry.atmospheres !== "object" || Array.isArray(registry.atmospheres)) {
      diagnostics.push({ severity: "error", code: "assets.atmospheres.schema", message: "天气氛围必须是按背景 ID 登记的对象。" });
    } else {
      for (const [backgroundId, config] of Object.entries(registry.atmospheres)) {
        if (!Object.hasOwn(registry.backgrounds, backgroundId)) diagnostics.push({ severity: "error", code: "assets.atmosphere.background", message: `天气氛围 ${backgroundId} 没有关联已登记背景。` });
        const issue = state.engineModule?.novelAtmosphereIssue?.(config);
        if (issue) diagnostics.push({ severity: "error", code: "assets.atmosphere.schema", message: `背景 ${backgroundId}：${issue}` });
        if (config && typeof config === "object" && !Array.isArray(config)) {
          for (const layer of ["mist", "rain"]) if (typeof config[layer] === "string") check(`背景 ${backgroundId} ${layer === "mist" ? "雾图" : "雨图"}`, config[layer], "image");
        }
      }
    }
  }
  if (registry.skin !== undefined) {
    if (typeof state.engineModule?.isNovelAssetSkin === "function" && !state.engineModule.isNovelAssetSkin(registry.skin)) {
      diagnostics.push({ severity: "error", code: "assets.skin.schema", message: "界面皮肤需要 frame {image,width,height,inset}；可选 accentFrame 使用相同结构；可选 icons 使用 {image,width,height,columns,rows,names}，网格最多 16×16，名称必须是唯一的小写行优先 ID。" });
    }
    if (registry.skin && typeof registry.skin === "object") {
      const frame = registry.skin.frame;
      if (frame && typeof frame === "object") check("界面皮肤 frame", frame.image, "image");
      const accentFrame = registry.skin.accentFrame;
      if (accentFrame && typeof accentFrame === "object") check("界面皮肤 accentFrame", accentFrame.image, "image");
      const icons = registry.skin.icons;
      if (icons && typeof icons === "object") check("界面皮肤 icons 图集", icons.image, "image");
    }
  }
  for (const [key, definition] of Object.entries(registry.models || {})) {
    if (!definition || typeof definition !== "object") { diagnostics.push({ severity: "error", code: "assets.schema", message: `模型 ${key} 的资源定义无效。` }); continue; }
    check(`模型 ${key} 源文件`, definition.source, definition.kind === "spine" ? "spine-source" : "live2d-source");
    if (definition.kind === "spine") {
      check(`模型 ${key} Atlas`, definition.atlas, "spine-atlas");
      const source = state.modelSources[key];
      for (const page of source?.atlasPages || []) if (!definition.textures?.[page]) diagnostics.push({ severity: "error", code: "models.texture.missing", message: `模型 ${key} 的 Atlas 页 ${page} 尚未映射项目图片。` });
      for (const page of source?.premultipliedPages || []) diagnostics.push({ severity: "error", code: "models.texture.pma", message: `模型 ${key} 的 Atlas 页 ${page} 使用 PMA；当前 Guest 纹理格式不支持安全显示。` });
      for (const item of source?.unsupported || []) diagnostics.push({ severity: "error", code: "models.runtime.unsupported", message: `模型 ${key} 的 slot ${item.slot} 使用不支持的 Spine 功能 ${item.reason}：${item.detail}` });
    } else {
      const source = state.modelSources[key];
      for (const page of source?.missingTexturePages || []) diagnostics.push({ severity: "error", code: "models.texture.missing", message: `Live2D 模型 ${key} 的纹理页 ${page} 尚未映射项目图片。` });
      for (const item of source?.unsupported || []) diagnostics.push({ severity: "error", code: "models.runtime.unsupported", message: `Live2D 模型 ${key} 的 ${item.slot} 使用不支持的功能 ${item.reason}：${item.detail}` });
    }
    for (const [page, path] of Object.entries(definition.textures || {})) check(`模型 ${key} 贴图 ${page}`, path, "image");
    for (const animation of definition.animations || []) {
      if (typeof animation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(animation)) diagnostics.push({ severity: "error", code: "assets.path", message: `模型 ${key} 的动作名 ${String(animation)} 不符合故事键格式。` });
    }
  }
  diagnostics.push(...state.assetDiagnostics.filter(item => item.code !== "models.runtime.unsupported"));
  return diagnostics;
}

function renderAssetDiagnostics(parent) {
  const diagnostics = localAssetDiagnostics();
  let box = byId("novel-asset-diagnostics");
  if (!box || !parent.contains(box)) box = node("aside", "nv-diagnostics nv-assets-diagnostics");
  box.id = "novel-asset-diagnostics";
  box.replaceChildren();
  const errors = diagnostics.filter(item => item.severity === "error").length;
  box.append(node("strong", "", errors ? `${errors} 个资源问题` : "资源路径结构有效"));
  if (!diagnostics.length) box.append(node("p", "nv-field-help", "所有已注册的图片、WAV key 和 MP4 cue 符合当前 Guest 资源打包规则。"));
  for (const item of diagnostics) box.append(node("p", `nv-asset-diagnostic ${item.severity}`, item.message));
  if (!box.parentElement) parent.append(box);
}

function disposeModelPreview() {
  const preview = state.modelPreview;
  preview.generation += 1;
  preview.running = false;
  try { preview.controller?.dispose(); } catch {}
  preview.controller = null;
}

function registeredModelCard(key) {
  return [...document.querySelectorAll(".nv-model-card")].find(card => card.dataset.modelKey === key) ?? null;
}

function modelPreviewStatus(key, message, kind = "info") {
  const status = registeredModelCard(key)?.querySelector(".nv-model-preview-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function stopModelPreviewForEdit(key, message = "模型资源已更改；保存后请重新预览。") {
  if (state.modelPreview.key !== key) return;
  disposeModelPreview();
  const card = registeredModelCard(key);
  const viewport = card?.querySelector(".nv-model-preview-viewport");
  if (viewport) viewport.hidden = true;
  const toggle = card?.querySelector("[data-action='toggle-model-preview']");
  if (toggle) toggle.textContent = "实时预览";
  modelPreviewStatus(key, message, "info");
}

function invalidateModelForPathEdit(key) {
  delete state.modelSources[key];
  stopModelPreviewForEdit(key, "模型源路径已更改；保存后请重新读取并预览。");
}

async function readModelInfo(key, { render = true } = {}) {
  if (state.assetsDirty) throw new Error("请先保存当前的模型资源注册表，再从 canonical 文件加载模型。保存后可继续检查或预览。");
  const result = await api(`${base}/models/source?key=${encodeURIComponent(key)}`);
  state.modelSources[key] = result;
  if (render && state.panel === "assets") renderWorkspace();
  return result;
}

function skeletonInputFromModelSource(source) {
  if (source.skeleton?.format === "json") return { format: "json", data: source.skeleton.data };
  if (source.skeleton?.format !== "binary" || typeof source.skeleton.base64 !== "string") throw new Error("模型源没有有效的 JSON 或 binary Skeleton 数据。");
  const binary = atob(source.skeleton.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { format: "binary", data: bytes };
}

async function loadModelTexture(key, pageName) {
  const response = await fetch(`${base}/models/resource?key=${encodeURIComponent(key)}&page=${encodeURIComponent(pageName)}`);
  if (!response.ok) throw new Error(`无法读取贴图 ${pageName}：${await response.text()}`);
  const bitmap = await createImageBitmap(await response.blob());
  if (!bitmap.width || !bitmap.height || bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 32 * 1024 * 1024) {
    bitmap.close();
    throw new Error(`贴图 ${pageName} 尺寸超出编辑器预览限制。`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) { bitmap.close(); throw new Error("浏览器无法创建贴图预览画布。"); }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  let rgba;
  try { rgba = context.getImageData(0, 0, canvas.width, canvas.height).data; }
  catch { canvas.width = canvas.height = 0; throw new Error(`无法读取贴图 ${pageName} 的像素。`); }
  return { canvas, rgba, width: canvas.width, height: canvas.height };
}

function paintModelMeshes(meshes, context, images) {
  const projector = window.PocketEditorPreview?.projectModelMeshes;
  if (typeof projector !== "function") throw new Error("Pocket Editor 的 PMS1/TEX_TRI compositor 未加载。");
  projector(context, meshes, images);
}

function createNovelSpineCanvasPreview({ canvas, modelKey, definition, source, loadTexture, loadFactory, animation, skin, loop = true, background = null, onFrame, onError }) {
  const preview = { generation: 0, frameId: 0, lastTime: 0, running: false, instance: null, images: Object.create(null), frameCount: 0 };
  const disposeImages = () => {
    for (const image of Object.values(preview.images)) {
      if (image?.canvas) image.canvas.width = image.canvas.height = 0;
    }
    preview.images = Object.create(null);
  };
  const dispose = () => {
    preview.generation += 1;
    preview.running = false;
    preview.lastTime = 0;
    if (preview.frameId) cancelAnimationFrame(preview.frameId);
    preview.frameId = 0;
    try { preview.instance?.dispose(); } catch {}
    preview.instance = null;
    disposeImages();
    if (canvas) canvas.width = canvas.height = 0;
  };
  const fail = error => {
    const value = error instanceof Error ? error : new Error(String(error));
    dispose();
    onError?.(value);
  };
  const draw = async (now, generation) => {
    if (!preview.running || preview.generation !== generation || !preview.instance) return;
    if (!canvas?.isConnected) { dispose(); return; }
    const delta = preview.lastTime ? Math.max(0, Math.min(100, now - preview.lastTime)) : 0;
    preview.lastTime = now;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法取得模型预览画布。");
    context.setTransform(2, 0, 0, 2, 0, 0);
    context.clearRect(0, 0, 240, 350);
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, 240, 350);
    }
    const meshes = await preview.instance.advance(delta);
    if (preview.generation !== generation || !preview.running) return;
    paintModelMeshes(meshes, context, preview.images);
    preview.frameCount += 1;
    onFrame?.({ frameCount: preview.frameCount, meshCount: meshes.length });
    preview.frameId = requestAnimationFrame(next => {
      void draw(next, generation).catch(fail);
    });
  };
  const start = async () => {
    const generation = ++preview.generation;
    try {
      if (!canvas || typeof canvas.getContext !== "function") throw new Error("无法取得模型预览画布。");
      if (!definition || definition.kind !== "spine") throw new Error("Spine 舞台预览需要 Spine 模型资源。");
      if (source?.premultipliedPages?.length) throw new Error(`Atlas 页面 ${source.premultipliedPages.join("、")} 使用 PMA；当前纹理解码链路不能安全转换预乘 alpha。`);
      if (source?.missingTexturePages?.length) throw new Error(`Atlas 页面尚未映射贴图：${source.missingTexturePages.join("、")}。`);
      if (source?.unsupported?.length) {
        const item = source.unsupported[0];
        throw new Error(`Spine 不支持 slot ${item.slot} 的 ${item.reason}：${item.detail}`);
      }
      const pageResults = await Promise.allSettled((source?.atlasPages ?? []).map(async pageName => [definition.textures[pageName], await loadTexture(pageName)]));
      for (const result of pageResults) if (result.status === "fulfilled") {
        const [key, image] = result.value;
        if (key) preview.images[key] = image;
      }
      const failedPage = pageResults.find(result => result.status === "rejected");
      if (failedPage?.status === "rejected") throw failedPage.reason;
      if (preview.generation !== generation) { disposeImages(); return; }
      const module = await loadFactory();
      if (preview.generation !== generation) { disposeImages(); return; }
      if (typeof module?.createNovelSpineFactory !== "function") throw new Error("打包的 Pocket Spine factory 未导出。");
      const factory = module.createNovelSpineFactory({ [definition.source]: { skeleton: skeletonInputFromModelSource(source), atlasText: source.atlasText } });
      const selectedAnimation = animation || definition.animations?.[0] || source.animationNames?.[0];
      const selectedSkin = skin || source.skinNames?.[0];
      const intent = { key: modelKey, loop: loop !== false, ...(selectedAnimation ? { animation: selectedAnimation } : {}), ...(selectedSkin ? { skin: selectedSkin } : {}) };
      preview.instance = await factory(definition, intent);
      if (preview.generation !== generation) { preview.instance.dispose(); preview.instance = null; disposeImages(); return; }
      canvas.width = 480;
      canvas.height = 700;
      preview.running = true;
      preview.lastTime = 0;
      preview.frameId = requestAnimationFrame(now => { void draw(now, generation).catch(fail); });
    } catch (error) {
      if (preview.generation === generation) dispose();
      throw error;
    }
  };
  return { start, dispose, get running() { return preview.running; }, get frameCount() { return preview.frameCount; } };
}

function createNovelLive2dCanvasPreview({ canvas, modelKey, definition, source, loadTexture, loadFactory, animation, expression, loop = true, background = null, onFrame, onError }) {
  const preview = { generation: 0, frameId: 0, lastTime: 0, running: false, instance: null, provider: null, images: Object.create(null), frameCount: 0 };
  const disposeImages = () => {
    for (const image of Object.values(preview.images)) if (image?.canvas) image.canvas.width = image.canvas.height = 0;
    preview.images = Object.create(null);
  };
  const dispose = () => {
    preview.generation += 1;
    preview.running = false;
    preview.lastTime = 0;
    if (preview.frameId) cancelAnimationFrame(preview.frameId);
    preview.frameId = 0;
    try { preview.instance?.dispose(); } catch {}
    preview.instance = null;
    try {
      const pending = preview.provider?.dispose();
      if (pending && typeof pending.catch === "function") void pending.catch(() => {});
    } catch {}
    preview.provider = null;
    disposeImages();
    if (canvas) canvas.width = canvas.height = 0;
  };
  const fail = error => {
    const value = error instanceof Error ? error : new Error(String(error));
    dispose();
    onError?.(value);
  };
  const draw = async (now, generation) => {
    if (!preview.running || preview.generation !== generation || !preview.instance) return;
    if (!canvas?.isConnected) { dispose(); return; }
    const delta = preview.lastTime ? Math.max(0, Math.min(100, now - preview.lastTime)) : 0;
    preview.lastTime = now;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法取得 Live2D 模型预览画布。");
    context.setTransform(2, 0, 0, 2, 0, 0);
    context.clearRect(0, 0, 240, 350);
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, 240, 350);
    }
    const meshes = await preview.instance.advance(delta);
    if (preview.generation !== generation || !preview.running) return;
    paintModelMeshes(meshes, context, preview.images);
    preview.frameCount += 1;
    onFrame?.({ frameCount: preview.frameCount, meshCount: meshes.length });
    preview.frameId = requestAnimationFrame(next => { void draw(next, generation).catch(fail); });
  };
  const start = async () => {
    const generation = ++preview.generation;
    try {
      if (!canvas || typeof canvas.getContext !== "function") throw new Error("无法取得模型预览画布。");
      if (!definition || definition.kind !== "live2d" || source?.kind !== "live2d") throw new Error("Live2D 预览需要已登记并读取的 Model3 资源。");
      if (source?.missingTexturePages?.length) throw new Error("Live2D 纹理尚未映射：" + source.missingTexturePages.join("、") + "。");
      const pageByImage = new Map();
      for (const pageName of source?.atlasPages ?? []) {
        const imageKey = definition.textures?.[pageName];
        if (!imageKey) throw new Error("Live2D 纹理尚未映射：" + pageName + "。");
        if (!pageByImage.has(imageKey)) pageByImage.set(imageKey, pageName);
      }
      const pageResults = await Promise.allSettled([...pageByImage].map(async ([imageKey, pageName]) => [imageKey, await loadTexture(pageName)]));
      for (const result of pageResults) if (result.status === "fulfilled") {
        const [imageKey, image] = result.value;
        preview.images[imageKey] = image;
      }
      const failedPage = pageResults.find(result => result.status === "rejected");
      if (failedPage?.status === "rejected") throw failedPage.reason;
      if (preview.generation !== generation) { disposeImages(); return; }
      const module = await loadFactory();
      if (typeof module?.createBrowserLive2d !== "function" || typeof module?.createNovelLive2dFactory !== "function") {
        throw new Error("Live2D 编辑器模块未导出浏览器 Core provider 和 Pocket VN factory。");
      }
      preview.provider = module.createBrowserLive2d(source.browserConfig, base + "/");
      const factory = module.createNovelLive2dFactory(
        { request: (capability, params) => preview.provider.invoke(capability, params) },
        { [definition.source]: source },
      );
      const intent = {
        key: modelKey,
        loop: loop !== false,
        ...(animation ? { animation } : {}),
        ...(expression ? { expression } : {}),
      };
      preview.instance = await factory(definition, intent);
      if (preview.generation !== generation) { dispose(); return; }
      canvas.width = 480;
      canvas.height = 700;
      preview.running = true;
      preview.lastTime = 0;
      preview.frameId = requestAnimationFrame(now => { void draw(now, generation).catch(fail); });
    } catch (error) {
      if (preview.generation === generation) dispose();
      throw error;
    }
  };
  return { start, dispose, get running() { return preview.running; }, get frameCount() { return preview.frameCount; } };
}

function createStageSpinePreview({ canvas, character, onFrame, onError }) {
  let disposed = false;
  let controller = null;
  const start = async () => {
    try {
      const key = character.model?.key;
      if (!key) throw new Error("所选角色没有模型资源键。");
      if (state.assetsDirty) throw new Error("请先保存当前的模型资源注册表，再预览 canonical 模型数据。");
      const definition = state.assets.models?.[key];
      if (!definition) throw new Error(`模型资源键 ${key} 不存在。`);
      if (definition.kind !== "spine") throw new Error("Spine 舞台预览需要 Spine 模型资源。");
      const source = state.modelSources[key] ?? await readModelInfo(key, { render: false });
      if (disposed) return;
      controller = createNovelSpineCanvasPreview({
        canvas,
        modelKey: key,
        definition,
        source,
        loadTexture: pageName => loadModelTexture(key, pageName),
        loadFactory: async () => state.spineModule ??= await import(`${base}/spine.js`),
        animation: character.model?.animation,
        skin: character.model?.skin,
        loop: character.model?.loop,
        background: null,
        onFrame,
        onError,
      });
      if (disposed) { controller.dispose(); controller = null; return; }
      await controller.start();
    } catch (error) {
      if (!disposed) onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { start, dispose() { disposed = true; controller?.dispose(); controller = null; } };
}

function createStageLive2dPreview({ canvas, character, onFrame, onError }) {
  let disposed = false;
  let controller = null;
  const start = async () => {
    try {
      const key = character.model?.key;
      if (!key) throw new Error("所选角色没有模型资源键。");
      if (state.assetsDirty) throw new Error("请先保存当前的模型资源注册表，再预览 canonical 模型数据。");
      const definition = state.assets.models?.[key];
      if (!definition) throw new Error("模型资源键 " + key + " 不存在。");
      if (definition.kind !== "live2d") throw new Error("所选模型不是 Live2D。");
      const source = state.modelSources[key] ?? await readModelInfo(key, { render: false });
      if (disposed) return;
      controller = createNovelLive2dCanvasPreview({
        canvas,
        modelKey: key,
        definition,
        source,
        loadTexture: pageName => loadModelTexture(key, pageName),
        loadFactory: async () => state.live2dModule ??= await import(base + "/live2d.js"),
        animation: character.model?.animation,
        expression: character.model?.expression,
        loop: character.model?.loop,
        background: null,
        onFrame,
        onError,
      });
      if (disposed) { controller.dispose(); controller = null; return; }
      await controller.start();
    } catch (error) {
      if (!disposed) onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { start, dispose() { disposed = true; controller?.dispose(); controller = null; } };
}

async function toggleModelPreview(key) {
  const preview = state.modelPreview;
  if (preview.running && preview.key === key) {
    disposeModelPreview();
    const toggle = registeredModelCard(key)?.querySelector("[data-action='toggle-model-preview']");
    if (toggle) toggle.textContent = "实时预览";
    const viewport = registeredModelCard(key)?.querySelector(".nv-model-preview-viewport");
    if (viewport) viewport.hidden = true;
    modelPreviewStatus(key, "模型预览已停止。", "info");
    return;
  }
  disposeModelPreview();
  preview.key = key;
  preview.error = "";
  preview.frameCount = 0;
  preview.canvas = registeredModelCard(key)?.querySelector(".nv-model-preview-canvas");
  const viewport = registeredModelCard(key)?.querySelector(".nv-model-preview-viewport");
  if (viewport) viewport.hidden = false;
  const toggle = registeredModelCard(key)?.querySelector("[data-action='toggle-model-preview']");
  if (toggle) toggle.textContent = "停止预览";
  const generation = preview.generation;
  modelPreviewStatus(key, "正在加载官方模型运行库与贴图…");
  try {
    if (state.assetsDirty) throw new Error("请先保存当前的模型资源注册表，再预览 canonical 模型数据。");
    const definition = state.assets.models?.[key];
    if (!definition) throw new Error("模型资源键不存在。");
    if (definition.kind !== "spine" && definition.kind !== "live2d") throw new Error("模型运行类型不受支持。");
    const source = state.modelSources[key] ?? await readModelInfo(key, { render: false });
    if (preview.generation !== generation) return;
    const onFrame = ({ frameCount, meshCount }) => {
      if (preview.generation !== generation) return;
      preview.frameCount = frameCount;
      const renderer = definition.kind === "live2d" ? "Live2D Cubism Core" : "Spine 官方运行库";
      modelPreviewStatus(key, `${renderer} · ${frameCount} 帧 · ${meshCount} 个 mesh`, "success");
    };
    const onError = error => {
      if (preview.generation !== generation) return;
      preview.error = error.message;
      disposeModelPreview();
      modelPreviewStatus(key, `模型预览失败：${error.message}`, "error");
    };
    const controller = definition.kind === "live2d"
      ? createNovelLive2dCanvasPreview({
        canvas: preview.canvas,
        modelKey: key,
        definition,
        source,
        loadTexture: pageName => loadModelTexture(key, pageName),
        loadFactory: async () => state.live2dModule ??= await import(base + "/live2d.js"),
        animation: preview.animation,
        expression: preview.expression,
        loop: preview.loop,
        background: "#101713",
        onFrame,
        onError,
      })
      : createNovelSpineCanvasPreview({
        canvas: preview.canvas,
        modelKey: key,
        definition,
        source,
        loadTexture: pageName => loadModelTexture(key, pageName),
        loadFactory: async () => state.spineModule ??= await import(base + "/spine.js"),
        animation: preview.animation,
        skin: preview.skin,
        loop: preview.loop,
        background: "#101713",
        onFrame,
        onError,
      });
    preview.controller = controller;
    await controller.start();
    if (preview.generation === generation) {
      preview.running = controller.running;
      modelPreviewStatus(key, definition.kind === "live2d" ? "正在绘制 Live2D 实际网格与遮罩…" : "正在绘制 Spine 实际 mesh…");
    }
  } catch (error) {
    if (preview.generation !== generation) return;
    preview.error = error.message;
    disposeModelPreview();
    modelPreviewStatus(key, `模型预览失败：${error.message}`, "error");
  }
}

function renameModelAndReferences(oldKey, nextKey) {
  const models = ensureModelRegistry();
  const clean = String(nextKey).trim();
  if (clean === oldKey) return true;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(clean)) {
    setNotice("模型键需以字母或数字开头，并只含字母、数字、点、下划线、冒号或连字符。", "error");
    return false;
  }
  if (Object.hasOwn(models, clean)) {
    setNotice(`模型键 ${clean} 已存在。`, "error");
    return false;
  }
  const renamed = Object.create(null);
  for (const [key, definition] of Object.entries(models)) renamed[key === oldKey ? clean : key] = definition;
  state.assets.models = renamed;
  for (const instructions of Object.values(state.story.script || {})) {
    if (!Array.isArray(instructions)) continue;
    for (const instruction of instructions) {
      if (instruction?.type !== "scene") continue;
      for (const character of instruction.characters || []) if (character.model?.key === oldKey) character.model.key = clean;
    }
  }
  if (Object.hasOwn(state.modelSources, oldKey)) {
    state.modelSources[clean] = state.modelSources[oldKey];
    delete state.modelSources[oldKey];
  }
  if (state.modelPreview.key === oldKey) state.modelPreview.key = clean;
  return true;
}

function addNovelModel() {
  const models = ensureModelRegistry();
  const key = window.prompt("模型资源键", `model_${Object.keys(models).length + 1}`)?.trim();
  if (!key) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) { setNotice("模型键格式无效。", "error"); return; }
  if (Object.hasOwn(models, key)) { setNotice(`模型键 ${key} 已存在。`, "error"); return; }
  historyMutation("assets", `model:add:${key}`, () => {
    models[key] = { kind: "spine", source: `models/${key}.spine.json`, atlas: `models/${key}.atlas`, textures: {}, animations: [] };
  });
  rerenderWorkspace();
}

function renderModelAssets(section) {
  const group = node("section", "nv-asset-group nv-model-assets");
  const header = node("div", "nv-asset-group-head");
  header.append(node("h2", "", "骨骼与动态模型"), button("＋ 添加模型", "quiet", addNovelModel));
  group.append(header);
  group.append(node("p", "nv-field-help", "Spine 与 Live2D 模型及贴图都从项目注册表读取。预览复用 Pocket VN factory 和现有 PMS1/TEX_TRI 投影器；Live2D 的遮罩、重复 UV、着色与混合由 Pocket Editor 网格 compositor 绘制。"));
  const models = ensureModelRegistry();
  if (!Object.keys(models).length) group.append(node("div", "nv-empty", "尚未登记动态模型。"));
  for (const [key, definition] of Object.entries(models)) {
    state.historyContext = `model:${key}`;
    const card = node("article", "nv-model-card");
    card.dataset.modelKey = key;
    const cardHead = node("div", "nv-character-assets-head");
    let liveKey = key;
    field(cardHead, "模型键", key, next => {
      const renamed = renameModelAndReferences(liveKey, next);
      if (renamed && next.trim() !== liveKey) {
        liveKey = next.trim();
        card.dataset.modelKey = liveKey;
        return true;
      }
      return renamed;
    }, { historyScope: "project", historyKey: `model:rename:${key}` });
    cardHead.append(button("移除模型", "danger quiet", () => {
      historyMutation("project", `model:remove:${key}`, () => {
        delete state.assets.models[key];
        for (const instructions of Object.values(state.story.script || {})) {
          if (!Array.isArray(instructions)) continue;
          for (const instruction of instructions) if (instruction?.type === "scene") {
            for (const character of instruction.characters || []) if (character.model?.key === key) character.model = null;
          }
        }
      });
      delete state.modelSources[key];
      rerenderWorkspace();
    }));
    card.append(cardHead);
    field(card, "运行类型", definition.kind, value => {
      if (value === "spine") {
        definition.kind = "spine";
        definition.source = definition.source?.endsWith(".model3.json") ? `models/${key}.spine.json` : definition.source;
        definition.atlas ||= `models/${key}.atlas`;
      } else {
        definition.kind = "live2d";
        definition.source = definition.source?.endsWith(".model3.json") ? definition.source : `models/${key}.model3.json`;
        delete definition.atlas;
      }
      delete state.modelSources[key];
    }, { select: [["spine", "Spine JSON / binary"], ["live2d", "Live2D Model3"]], rerender: true });
    field(card, definition.kind === "spine" ? "Spine Skeleton 路径" : "Live2D Model3 路径", definition.source, value => {
      definition.source = value;
      invalidateModelForPathEdit(key);
      card.querySelector(".nv-model-info")?.replaceChildren(node("p", "nv-field-help", "模型源路径已更改；保存后请重新读取官方模型信息。"));
    }, { placeholder: definition.kind === "spine" ? "models/character.spine.json 或 .skel" : "models/character.model3.json" });
    if (definition.kind === "spine") field(card, "Spine Atlas 路径", definition.atlas ?? "", value => {
      definition.atlas = value;
      invalidateModelForPathEdit(key);
      card.querySelector(".nv-model-info")?.replaceChildren(node("p", "nv-field-help", "Atlas 路径已更改；保存后请重新读取官方模型信息。"));
    }, { placeholder: "models/character.atlas" });

    const sourceInfo = state.modelSources[key];
    const discoveredPages = sourceInfo?.atlasPages || [];
    const texturePages = [...new Set([...Object.keys(definition.textures || {}), ...discoveredPages])];
    const textures = node("div", "nv-model-textures");
    const textureHead = node("div", "nv-model-subhead");
    textureHead.append(node("strong", "", definition.kind === "spine" ? "Atlas 贴图映射" : "Live2D 纹理映射"), button("＋ 添加映射", "quiet", () => {
      const page = window.prompt("Atlas 页面文件名，例如 character.png", "page.png")?.trim();
      if (!page) return;
      const path = window.prompt("项目内 PNG/SVG 相对路径", `art/${page}`)?.trim();
      if (!path) return;
      if (Object.hasOwn(definition.textures || {}, page)) { setNotice(`Atlas 页面 ${page} 已有映射。`, "error"); return; }
      stopModelPreviewForEdit(key);
      historyMutation("assets", `model:texture:add:${key}:${page}`, () => { definition.textures = { ...(definition.textures || {}), [page]: path }; });
      rerenderWorkspace();
    }));
    textures.append(textureHead);
    if (!texturePages.length) textures.append(node("p", "nv-field-help", "读取模型信息后会显示其纹理页。"));
    for (const pageName of texturePages) {
      const row = node("div", "nv-model-texture-row");
      row.append(node("code", "nv-model-page-name", pageName));
      field(row, "项目内贴图路径", definition.textures?.[pageName] ?? "", value => {
        stopModelPreviewForEdit(key);
        const next = { ...(definition.textures || {}) };
        if (value.trim()) next[pageName] = value.trim();
        else delete next[pageName];
        definition.textures = next;
      }, { placeholder: "art/character-page.png" });
      if (Object.hasOwn(definition.textures || {}, pageName)) row.append(button("移除映射", "danger quiet", () => {
        stopModelPreviewForEdit(key);
        historyMutation("assets", `model:texture:remove:${key}:${pageName}`, () => {
          const next = { ...(definition.textures || {}) };
          delete next[pageName];
          definition.textures = next;
        });
        rerenderWorkspace();
      }));
      textures.append(row);
    }
    card.append(textures);

    field(card, "动作清单（每行一个，也可逗号分隔）", (definition.animations || []).join("\n"), value => {
      definition.animations = [...new Set(value.split(/[\n,]/).map(name => name.trim()).filter(Boolean))];
    }, { multiline: true, placeholder: "idle\nwalk" });
    const info = node("div", "nv-model-info");
    if (sourceInfo) {
      const isLive2d = sourceInfo.kind === "live2d";
      info.append(node("strong", "", isLive2d
        ? `Cubism Model3：${sourceInfo.animationNames.length} 个动作 · ${sourceInfo.expressionNames.length} 个表情 · ${sourceInfo.atlasPages.length} 个纹理页`
        : `官方 Spine 解析：${sourceInfo.animationNames.length} 个动作 · ${sourceInfo.skinNames.length} 个皮肤 · ${sourceInfo.atlasPages.length} 个 Atlas 页`));
      info.append(node("p", "nv-field-help", isLive2d
        ? `动作：${sourceInfo.animationNames.join("、") || "（无）"}；表情：${sourceInfo.expressionNames.join("、") || "（无）"}`
        : `动作：${sourceInfo.animationNames.join("、") || "（无）"}；皮肤：${sourceInfo.skinNames.join("、") || "（无）"}`));
      if (sourceInfo.missingTexturePages.length) info.append(node("p", "nv-asset-diagnostic error", `尚未映射：${sourceInfo.missingTexturePages.join("、")}`));
      if (sourceInfo.premultipliedPages.length) info.append(node("p", "nv-asset-diagnostic error", `PMA 页当前不支持：${sourceInfo.premultipliedPages.join("、")}`));
      for (const item of sourceInfo.unsupported) info.append(node("p", "nv-asset-diagnostic error", `不支持 ${item.slot} / ${item.reason}：${item.detail}`));
    } else {
      info.append(node("p", "nv-field-help", definition.kind === "spine" ? "读取动作、皮肤和 Atlas 页会由官方 Spine 4.3 解析器完成。" : "读取 Model3 与已引用的动作、表情、物理和姿态文件后，可通过 Cubism Web Core 预览真实变形网格。"));
    }
    card.append(info);
    const actions = node("div", "nv-inline-actions nv-model-actions");
    actions.append(button(definition.kind === "spine" ? "读取模型信息" : "检查模型", "quiet", async () => {
      try {
        const loaded = await readModelInfo(key, { render: false });
        if (definition.kind === "spine") {
          const missing = loaded.atlasPages.filter(page => !definition.textures?.[page]);
          if (missing.length) {
            setNotice(`已读取官方 Spine 元信息。请为 ${missing.join("、")} 添加贴图映射。`, "warning");
          }
        } else if (loaded.missingTexturePages.length) {
          setNotice(`已读取 Live2D Model3。请为 ${loaded.missingTexturePages.join("、")} 添加纹理映射。`, "warning");
        }
        renderWorkspace();
      } catch (error) {
        modelPreviewStatus(key, `模型检查失败：${error.message}`, "error");
        setNotice(`模型信息读取失败：${error.message}`, "error");
      }
    }));
    if (definition.kind === "spine" || definition.kind === "live2d") {
      const previewToggle = button(state.modelPreview.running && state.modelPreview.key === key ? "停止预览" : "实时预览", "secondary", () => { void toggleModelPreview(key); });
      previewToggle.dataset.action = "toggle-model-preview";
      actions.append(previewToggle);
    }
    card.append(actions);
    if (sourceInfo?.animationNames?.length || sourceInfo?.skinNames?.length || sourceInfo?.expressionNames?.length) {
      const playback = node("div", "nv-model-playback-controls");
      const animation = node("label", "nv-field");
      animation.append(node("span", "nv-field-label", "预览动作"));
      const animationSelect = node("select", "nv-input");
      option(animationSelect, "", `默认${sourceInfo.animationNames[0] ? `（${sourceInfo.animationNames[0]}）` : ""}`);
      for (const name of sourceInfo.animationNames) option(animationSelect, name, name);
      animationSelect.value = state.modelPreview.key === key ? state.modelPreview.animation || "" : "";
      animationSelect.addEventListener("change", () => {
        state.modelPreview.key = key;
        state.modelPreview.animation = animationSelect.value;
        if (state.modelPreview.running) { disposeModelPreview(); void toggleModelPreview(key); }
      });
      animation.append(animationSelect);
      playback.append(animation);
      if (sourceInfo.skinNames?.length) {
        const skin = node("label", "nv-field");
        skin.append(node("span", "nv-field-label", "预览皮肤"));
        const skinSelect = node("select", "nv-input");
        option(skinSelect, "", `默认${sourceInfo.skinNames[0] ? `（${sourceInfo.skinNames[0]}）` : ""}`);
        for (const name of sourceInfo.skinNames) option(skinSelect, name, name);
        skinSelect.value = state.modelPreview.key === key ? state.modelPreview.skin || "" : "";
        skinSelect.addEventListener("change", () => {
          state.modelPreview.key = key;
          state.modelPreview.skin = skinSelect.value;
          if (state.modelPreview.running) { disposeModelPreview(); void toggleModelPreview(key); }
        });
        skin.append(skinSelect);
        playback.append(skin);
      }
      if (sourceInfo.expressionNames?.length) {
        const expression = node("label", "nv-field");
        expression.append(node("span", "nv-field-label", "预览表情"));
        const expressionSelect = node("select", "nv-input");
        option(expressionSelect, "", `默认${sourceInfo.expressionNames[0] ? `（${sourceInfo.expressionNames[0]}）` : ""}`);
        for (const name of sourceInfo.expressionNames) option(expressionSelect, name, name);
        expressionSelect.value = state.modelPreview.key === key ? state.modelPreview.expression || "" : "";
        expressionSelect.addEventListener("change", () => {
          state.modelPreview.key = key;
          state.modelPreview.expression = expressionSelect.value;
          if (state.modelPreview.running) { disposeModelPreview(); void toggleModelPreview(key); }
        });
        expression.append(expressionSelect);
        playback.append(expression);
      }
      const loop = node("label", "nv-check");
      const loopInput = node("input");
      loopInput.type = "checkbox";
      loopInput.checked = state.modelPreview.key === key ? state.modelPreview.loop !== false : true;
      loopInput.addEventListener("change", () => {
        state.modelPreview.key = key;
        state.modelPreview.loop = loopInput.checked;
        if (state.modelPreview.running) { disposeModelPreview(); void toggleModelPreview(key); }
      });
      loop.append(loopInput, node("span", "", "循环动作"));
      playback.append(loop);
      card.append(playback);
    }
    const viewport = node("div", "nv-model-preview-viewport");
    viewport.hidden = !(state.modelPreview.key === key && state.modelPreview.running);
    const canvas = node("canvas", "nv-model-preview-canvas");
    canvas.width = 480;
    canvas.height = 700;
    viewport.append(canvas);
    const status = node("p", "nv-model-preview-status", "预览尚未启动。");
    status.dataset.kind = "info";
    viewport.append(status);
    card.append(viewport);
    group.append(card);
  }
  section.append(group);
}

function renderSkinFrameEditor(skin, frameId) {
  const frame = skin[frameId];
  const section = node("section", "nv-asset-group");
  section.append(node("h3", "", frameId));
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    section.append(node("p", "nv-field-help", frameId + " 元数据无效。"));
    section.append(button("修复 " + frameId, "quiet", () => {
      historyMutation("assets", "skin:" + frameId + ":repair", () => {
        skin[frameId] = { image: "", width: 1, height: 1, inset: 0 };
      });
      rerenderWorkspace();
    }));
    return section;
  }

  state.historyContext = "skin:" + frameId;
  const fields = node("div", "nv-instruction-fields");
  const image = node("img", "");
  image.alt = "游戏界面皮肤 " + frameId + " 图片预览";
  image.hidden = true;
  image.style.display = "block";
  image.style.maxWidth = "min(100%, 360px)";
  image.style.maxHeight = "320px";
  image.style.objectFit = "contain";
  image.style.border = "1px solid #344239";
  image.style.borderRadius = "8px";
  const imageStatus = node("p", "nv-model-preview-status", "请填写项目内图片路径以查看预览和实际像素尺寸。");
  const readImageSize = button(frameId === "frame" ? "使用图片实际尺寸" : "使用 " + frameId + " 图片实际尺寸", "quiet", () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    historyMutation("assets", "skin:" + frameId + ":actual-size", () => {
      frame.width = image.naturalWidth;
      frame.height = image.naturalHeight;
    });
    rerenderWorkspace();
  });
  readImageSize.disabled = true;
  const updateImageStatus = () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const matches = frame.width === image.naturalWidth && frame.height === image.naturalHeight;
    imageStatus.dataset.kind = matches ? "success" : "warning";
    imageStatus.textContent = "图片实际尺寸：" + image.naturalWidth + " × " + image.naturalHeight +
      " px；当前登记：" + frame.width + " × " + frame.height + " px" +
      (matches ? "（一致）" : "（不一致，可使用实际尺寸）") + "。";
  };
  image.addEventListener("load", () => {
    image.hidden = false;
    readImageSize.disabled = false;
    updateImageStatus();
  });
  image.addEventListener("error", () => {
    image.hidden = true;
    readImageSize.disabled = true;
    imageStatus.dataset.kind = "error";
    imageStatus.textContent = "无法预览：请确认路径指向项目内已存在、无符号链接的 PNG/SVG 图片。";
  });
  const imagePath = field(fields, frameId + " 图片项目相对路径", frame.image, value => { frame.image = value; }, { wide: true, placeholder: "项目内 PNG/SVG 路径" });
  const refreshImage = () => {
    const path = frame.image;
    image.hidden = true;
    readImageSize.disabled = true;
    imageStatus.dataset.kind = "info";
    if (!path) {
      image.removeAttribute("src");
      imageStatus.textContent = "请填写项目内图片路径以查看预览和实际像素尺寸。";
      return;
    }
    imageStatus.textContent = "正在读取项目图片…";
    image.src = "/novel/resource?" + new URLSearchParams({ project: projectId, kind: "skin", path });
  };
  imagePath.addEventListener("input", refreshImage);
  const widthLabel = frameId === "frame" ? "图片宽度（实际源像素）" : frameId + " 图片宽度（实际源像素）";
  const heightLabel = frameId === "frame" ? "图片高度（实际源像素）" : frameId + " 图片高度（实际源像素）";
  const insetLabel = frameId === "frame" ? "四边 inset（源像素）" : frameId + " 四边 inset（源像素）";
  const width = field(fields, widthLabel, frame.width, value => { frame.width = value; updateImageStatus(); }, { type: "number", integer: true, safeInteger: true, min: 1, max: Number.MAX_SAFE_INTEGER });
  const height = field(fields, heightLabel, frame.height, value => { frame.height = value; updateImageStatus(); }, { type: "number", integer: true, safeInteger: true, min: 1, max: Number.MAX_SAFE_INTEGER });
  field(fields, insetLabel, frame.inset, value => { frame.inset = value; }, { type: "number", integer: true, safeInteger: true, min: 0, max: Number.MAX_SAFE_INTEGER });
  width.addEventListener("input", updateImageStatus);
  height.addEventListener("input", updateImageStatus);
  refreshImage();
  const preview = node("div", "nv-model-info");
  preview.append(node("strong", "", frameId + " 注册图片预览"), image, imageStatus, readImageSize);
  section.append(fields, preview);
  return section;
}

function renderSkinIconsEditor(skin) {
  const icons = skin.icons;
  const section = node("section", "nv-asset-group");
  section.append(node("h3", "", "icons 图集"));
  if (!icons || typeof icons !== "object" || Array.isArray(icons)) {
    section.append(node("p", "nv-field-help", "icons 图集元数据无效。"));
    section.append(button("修复 icons 图集", "quiet", () => {
      historyMutation("assets", "skin:icons:repair", () => {
        skin.icons = { image: "", width: 1, height: 1, columns: 1, rows: 1, names: ["icon_1"] };
      });
      rerenderWorkspace();
    }));
    return section;
  }

  state.historyContext = "skin:icons";
  const fields = node("div", "nv-instruction-fields");
  const image = node("img", "");
  image.alt = "游戏界面皮肤 icons 图集图片预览";
  image.hidden = true;
  image.style.display = "block";
  image.style.maxWidth = "min(100%, 360px)";
  image.style.maxHeight = "320px";
  image.style.objectFit = "contain";
  image.style.border = "1px solid #344239";
  image.style.borderRadius = "8px";
  const imageStatus = node("p", "nv-model-preview-status", "请填写项目内图片路径以查看预览和实际像素尺寸。");
  const readImageSize = button("使用图标图集图片实际尺寸", "quiet", () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    historyMutation("assets", "skin:icons:actual-size", () => {
      icons.width = image.naturalWidth;
      icons.height = image.naturalHeight;
    });
    rerenderWorkspace();
  });
  readImageSize.disabled = true;
  const updateImageStatus = () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const matches = icons.width === image.naturalWidth && icons.height === image.naturalHeight;
    imageStatus.dataset.kind = matches ? "success" : "warning";
    imageStatus.textContent = "图片实际尺寸：" + image.naturalWidth + " × " + image.naturalHeight +
      " px；当前登记：" + icons.width + " × " + icons.height + " px" +
      (matches ? "（一致）" : "（不一致，可使用实际尺寸）") + "。";
  };
  image.addEventListener("load", () => {
    image.hidden = false;
    readImageSize.disabled = false;
    updateImageStatus();
  });
  image.addEventListener("error", () => {
    image.hidden = true;
    readImageSize.disabled = true;
    imageStatus.dataset.kind = "error";
    imageStatus.textContent = "无法预览：请确认路径指向项目内已存在、无符号链接的 PNG/SVG 图片。";
  });
  const imagePath = field(fields, "icons 图集图片项目相对路径", icons.image, value => { icons.image = value; }, { wide: true, placeholder: "项目内 PNG/SVG 路径" });
  const refreshImage = () => {
    const path = icons.image;
    image.hidden = true;
    readImageSize.disabled = true;
    imageStatus.dataset.kind = "info";
    if (!path) {
      image.removeAttribute("src");
      imageStatus.textContent = "请填写项目内图片路径以查看预览和实际像素尺寸。";
      return;
    }
    imageStatus.textContent = "正在读取项目图片…";
    image.src = "/novel/resource?" + new URLSearchParams({ project: projectId, kind: "skin", path });
  };
  imagePath.addEventListener("input", refreshImage);
  const width = field(fields, "图标图集宽度（实际源像素）", icons.width, value => { icons.width = value; updateImageStatus(); }, { type: "number", integer: true, safeInteger: true, min: 1, max: Number.MAX_SAFE_INTEGER });
  const height = field(fields, "图标图集高度（实际源像素）", icons.height, value => { icons.height = value; updateImageStatus(); }, { type: "number", integer: true, safeInteger: true, min: 1, max: Number.MAX_SAFE_INTEGER });
  const names = Array.isArray(icons.names) ? icons.names : [];
  let addName;
  const updateAddNameDisabled = () => {
    if (addName) addName.disabled = names.length >= Number(icons.columns || 1) * Number(icons.rows || 1);
  };
  field(fields, "图标网格列数", icons.columns, value => { icons.columns = value; updateAddNameDisabled(); }, { type: "number", integer: true, safeInteger: true, min: 1, max: 16 });
  field(fields, "图标网格行数", icons.rows, value => { icons.rows = value; updateAddNameDisabled(); }, { type: "number", integer: true, safeInteger: true, min: 1, max: 16 });
  width.addEventListener("input", updateImageStatus);
  height.addEventListener("input", updateImageStatus);
  refreshImage();

  const namesGroup = node("section", "nv-asset-group");
  namesGroup.append(node("h3", "", "图标名称（从左到右、从上到下）"));
  for (const [index, iconName] of names.entries()) {
    state.historyContext = "skin:icons:name:" + index;
    const row = node("div", "nv-asset-row");
    field(row, "图标 ID " + (index + 1), iconName, value => { icons.names[index] = value; }, { wide: true });
    row.append(button("移除此图标名", "danger quiet", () => {
      historyMutation("assets", "skin:icons:name:remove:" + index, () => {
        icons.names.splice(index, 1);
      });
      rerenderWorkspace();
    }));
    namesGroup.append(row);
  }
  addName = button("＋ 添加图标名", "quiet", () => {
    historyMutation("assets", "skin:icons:name:add", () => {
      if (!Array.isArray(icons.names)) icons.names = [];
      let next = icons.names.length + 1;
      while (icons.names.includes("icon_" + next)) next++;
      icons.names.push("icon_" + next);
    });
    rerenderWorkspace();
  });
  updateAddNameDisabled();
  namesGroup.append(addName);

  const preview = node("div", "nv-model-info");
  preview.append(node("strong", "", "注册图标图集预览"), image, imageStatus, readImageSize);
  section.append(fields, preview, namesGroup);
  return section;
}

function renderAtmosphereImageEditor(parent, backgroundId, layer, config) {
  const layerName = layer === "mist" ? "雾图" : "雨图";
  const row = node("div", "nv-atmosphere-layer");
  const image = node("img", "");
  image.alt = `背景 ${backgroundId} ${layerName}预览`;
  image.hidden = true;
  image.style.display = "block";
  image.style.maxWidth = "min(100%, 320px)";
  image.style.maxHeight = "200px";
  image.style.objectFit = "contain";
  image.style.border = "1px solid #344239";
  image.style.borderRadius = "8px";
  const status = node("p", "nv-model-preview-status", "可选：填写项目内 PNG/SVG 路径以预览该天气图层。");
  image.addEventListener("load", () => {
    image.hidden = false;
    status.dataset.kind = "success";
    status.textContent = `图片预览已加载：${image.naturalWidth} × ${image.naturalHeight} px。`;
  });
  image.addEventListener("error", () => {
    image.hidden = true;
    status.dataset.kind = "error";
    status.textContent = "无法预览：请确认图片在项目内且是 PNG/SVG 文件。";
  });
  const input = field(row, `背景 ${backgroundId} ${layerName}项目相对路径`, config[layer] ?? "", value => {
    if (value) config[layer] = value;
    else delete config[layer];
  }, { wide: true, placeholder: "项目内 PNG/SVG 路径" });
  const refresh = () => {
    image.hidden = true;
    const path = config[layer];
    if (!path) {
      image.removeAttribute("src");
      status.dataset.kind = "info";
      status.textContent = "可选：填写项目内 PNG/SVG 路径以预览该天气图层。";
      return;
    }
    status.dataset.kind = "info";
    status.textContent = "正在读取项目图片…";
    image.src = "/novel/resource?" + new URLSearchParams({ project: projectId, kind: "atmosphere", path });
  };
  input.addEventListener("input", refresh);
  refresh();
  row.append(image, status);
  parent.append(row);
}

function renderAtmosphereAssets(parent) {
  const section = node("section", "nv-asset-group");
  section.append(
    node("h2", "", "天气与氛围"),
    node("p", "nv-field-help", "按已登记背景绑定雾图、雨图、强度和闪电。图片使用项目内 PNG/SVG；设置保存在同一 novel.assets.json，画面不影响剧情状态。"),
  );
  const backgrounds = Object.keys(state.assets.backgrounds);
  if (!backgrounds.length) section.append(node("div", "nv-empty", "请先登记背景，再为背景配置天气氛围。"));
  for (const backgroundId of backgrounds) {
    const atmospheres = state.assets.atmospheres;
    const config = atmospheres?.[backgroundId];
    const card = node("article", "nv-atmosphere-card");
    const head = node("div", "nv-asset-group-head");
    head.append(node("h3", "", `背景：${backgroundId}`));
    if (!config) {
      head.append(button("＋ 添加天气氛围", "quiet", () => {
        historyMutation("assets", `atmosphere:add:${backgroundId}`, () => {
          ensureAtmosphereRegistry()[backgroundId] = {};
        });
        rerenderWorkspace();
      }));
      card.append(head, node("p", "nv-field-help", "当前背景没有天气配置。添加后可选雾图/雨图，强度默认 0.65，闪电默认关闭。"));
    } else if (!config || typeof config !== "object" || Array.isArray(config)) {
      head.append(button("移除无效配置", "danger quiet", () => {
        historyMutation("assets", `atmosphere:remove:${backgroundId}`, () => {
          delete ensureAtmosphereRegistry()[backgroundId];
          if (!Object.keys(state.assets.atmospheres).length) delete state.assets.atmospheres;
        });
        rerenderWorkspace();
      }));
      card.append(head, node("p", "nv-field-help", "该背景的天气配置不是对象；移除后可重新创建。"));
    } else {
      state.historyContext = `atmosphere:${backgroundId}`;
      head.append(button("移除天气氛围", "danger quiet", () => {
        historyMutation("assets", `atmosphere:remove:${backgroundId}`, () => {
          delete ensureAtmosphereRegistry()[backgroundId];
          if (!Object.keys(state.assets.atmospheres).length) delete state.assets.atmospheres;
        });
        rerenderWorkspace();
      }));
      card.append(head);
      renderAtmosphereImageEditor(card, backgroundId, "mist", config);
      renderAtmosphereImageEditor(card, backgroundId, "rain", config);
      const controls = node("div", "nv-asset-row");
      field(controls, `背景 ${backgroundId} 氛围强度 (0–1)`, config.intensity ?? 0.65, value => {
        if (value === undefined) delete config.intensity;
        else config.intensity = value;
      }, { type: "number", step: "0.01", optional: true, min: 0, max: 1, placeholder: "0.65（默认）" });
      checkbox(controls, `背景 ${backgroundId} 闪电`, config.lightning === true, value => { config.lightning = value; });
      card.append(controls);
    }
    section.append(card);
  }
  parent.append(section);
}

function storyChoices() {
  const result = [];
  for (const [label, instructions] of Object.entries(state.story?.script ?? {})) {
    if (!Array.isArray(instructions)) continue;
    for (const [index, instruction] of instructions.entries()) {
      if (instruction?.type === "choice" && typeof instruction.id === "string" && Array.isArray(instruction.options)) {
        result.push({ label, index, instruction });
      }
    }
  }
  return result;
}

function defaultChoiceSurfaceTargets(options) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(options.length)));
  const rows = Math.max(1, Math.ceil(options.length / columns));
  const cellW = 0.88 / columns;
  const cellH = 0.76 / rows;
  return Object.fromEntries(options.map((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return [item.id, { x: 0.06 + column * cellW, y: 0.12 + row * cellH, w: cellW * 0.9, h: cellH * 0.9 }];
  }));
}

function isChoiceRect(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => ["x", "y", "w", "h"].includes(key)) && Object.keys(value).length === 4 &&
    [value.x, value.y, value.w, value.h].every(entry => typeof entry === "number" && Number.isFinite(entry)) &&
    value.x >= 0 && value.y >= 0 && value.w > 0 && value.h > 0 && value.x + value.w <= 1 && value.y + value.h <= 1;
}

function choiceSurfaceTargetsMatch(choice, targets) {
  if (!choice || !Array.isArray(choice.options) || !targets || typeof targets !== "object" || Array.isArray(targets)) return false;
  const expected = choice.options.map(item => item.id).sort();
  const actual = Object.keys(targets).sort();
  return expected.length > 0 && expected.length === actual.length && expected.every((id, index) => id === actual[index]) &&
    Object.values(targets).every(isChoiceRect);
}

function renderChoiceSurfaceImageEditor(parent, choiceId, config) {
  const row = node("div", "nv-atmosphere-layer");
  const image = node("img", "");
  image.alt = `剧情选择 ${choiceId} 轮盘图片预览`;
  image.hidden = true;
  image.style.display = "block";
  image.style.maxWidth = "min(100%, 320px)";
  image.style.maxHeight = "200px";
  image.style.objectFit = "contain";
  image.style.border = "1px solid #344239";
  image.style.borderRadius = "8px";
  const status = node("p", "nv-model-preview-status", "填写项目内 PNG/SVG 路径以预览轮盘图片。");
  image.addEventListener("load", () => {
    image.hidden = false;
    status.dataset.kind = "success";
    status.textContent = `图片预览已加载：${image.naturalWidth} × ${image.naturalHeight} px；游戏按 contain 边界放置点击区。`;
  });
  image.addEventListener("error", () => {
    image.hidden = true;
    status.dataset.kind = "error";
    status.textContent = "无法预览：请确认图片在项目内且是 PNG/SVG 文件。";
  });
  const input = field(row, `剧情选择 ${choiceId} 轮盘图片路径`, config.image ?? "", value => { config.image = value; }, { wide: true, placeholder: "项目内 PNG/SVG 路径" });
  const refresh = () => {
    image.hidden = true;
    const path = config.image;
    if (!path) {
      image.removeAttribute("src");
      status.dataset.kind = "info";
      status.textContent = "填写项目内 PNG/SVG 路径以预览轮盘图片。";
      return;
    }
    status.dataset.kind = "info";
    status.textContent = "正在读取项目图片…";
    image.src = "/novel/resource?" + new URLSearchParams({ project: projectId, kind: "choice-surface", path });
  };
  input.addEventListener("input", refresh);
  refresh();
  row.append(image, status);
  parent.append(row);
}

function renderChoiceSurfaceAssets(parent) {
  const section = node("section", "nv-asset-group");
  section.append(
    node("h2", "", "剧情选择点击区域"),
    node("p", "nv-field-help", "将已有 choice 的全部选项映射到舞台或轮盘图片上的归一化矩形。条件隐藏的选项也必须保留目标；缺少或多出的选项会阻止保存。轮盘图片仍是普通项目 PNG/SVG 资源。"),
  );
  const choices = storyChoices();
  const registry = state.assets.choiceSurfaces;
  const available = choices.filter(({ instruction }) => !Object.hasOwn(registry ?? {}, instruction.id));
  if (available.length) {
    const addRow = node("div", "nv-asset-row");
    field(addRow, "选择要配置的剧情 choice ID", available[0].instruction.id, () => {}, {
      select: available.map(({ instruction }) => [instruction.id, `${instruction.id} · ${instruction.prompt || instruction.options.length + " 个选项"}`]),
      passive: true,
    });
    const choiceSelect = addRow.querySelector("select");
    addRow.append(button("添加点击区域", "quiet", () => {
      const selected = choices.find(({ instruction }) => instruction.id === choiceSelect?.value);
      if (!selected) return;
      historyMutation("assets", `choiceSurface:add:${selected.instruction.id}`, () => {
        ensureChoiceSurfaceRegistry()[selected.instruction.id] = { kind: "scene", targets: defaultChoiceSurfaceTargets(selected.instruction.options) };
      });
      rerenderWorkspace();
    }));
    section.append(addRow);
  } else {
    section.append(node("div", "nv-empty", choices.length ? "所有剧情 choice 都已有点击区域。" : "故事中还没有可配置的 choice。"));
  }

  for (const [choiceId, config] of Object.entries(registry ?? {})) {
    const choice = choices.find(({ instruction }) => instruction.id === choiceId)?.instruction;
    const card = node("article", "nv-atmosphere-card");
    card.dataset.choiceSurfaceId = choiceId;
    state.historyContext = `choiceSurface:${choiceId}`;
    const head = node("div", "nv-asset-group-head");
    head.append(node("h3", "", `Choice：${choiceId}`));
    head.append(button("移除点击区域", "danger quiet", () => {
      historyMutation("assets", `choiceSurface:remove:${choiceId}`, () => {
        delete ensureChoiceSurfaceRegistry()[choiceId];
        if (!Object.keys(state.assets.choiceSurfaces).length) delete state.assets.choiceSurfaces;
      });
      rerenderWorkspace();
    }));
    card.append(head);
    if (!choice) {
      card.append(node("p", "nv-field-help", "此 choice ID 已不存在于 story.json；移除配置或恢复该 choice 后才能保存。"));
      section.append(card);
      continue;
    }
    field(card, `Choice ${choiceId} 表现形式`, config.kind, value => {
      if (value === "dial") {
        config.kind = "dial";
        config.image ??= "";
        config.frame ??= { x: 0, y: 0, w: 1, h: 1 };
      } else {
        config.kind = "scene";
        delete config.image;
      }
    }, { select: [["scene", "场景点击区"], ["dial", "轮盘图片"]], rerender: true });
    if (config.kind === "dial") renderChoiceSurfaceImageEditor(card, choiceId, config);
    const frameText = config.frame ? JSON.stringify(config.frame, null, 2) : "";
    field(card, `Choice ${choiceId} 舞台区域 JSON`, frameText, value => {
      if (!value.trim()) {
        if (config.kind === "dial") return false;
        delete config.frame;
        return true;
      }
      try {
        const parsed = JSON.parse(value);
        if (!isChoiceRect(parsed)) return false;
        config.frame = parsed;
        return true;
      } catch { return false; }
    }, { multiline: true, wide: true, placeholder: config.kind === "dial" ? "必填：{ x, y, w, h }" : "可选；留空使用整个舞台" });
    field(card, `Choice ${choiceId} 全部选项 targets JSON`, JSON.stringify(config.targets, null, 2), value => {
      try {
        const parsed = JSON.parse(value);
        if (!choiceSurfaceTargetsMatch(choice, parsed)) return false;
        config.targets = parsed;
        return true;
      } catch { return false; }
    }, { multiline: true, wide: true, placeholder: `必须包含 ${choice.options.map(item => item.id).join(", ")}` });
    card.append(node("p", "nv-field-help", `当前 choice 有 ${choice.options.length} 个完整选项（包含条件选项）：${choice.options.map(item => item.id).join(" · ")}`));
    section.append(card);
  }
  parent.append(section);
}

function nextCatalogId(record, prefix) {
  let suffix = Object.keys(record ?? {}).length + 1;
  let candidate = `${prefix}_${suffix}`;
  while (Object.hasOwn(record ?? {}, candidate)) candidate = `${prefix}_${++suffix}`;
  return candidate;
}

function addCatalogRecord(record, key, value) {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

function renameCatalogRecord(record, oldKey, nextValue, label) {
  const nextKey = String(nextValue).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(nextKey)) {
    setNotice(`${label}须以字母或数字开头，只能包含字母、数字、点、下划线、冒号和连字符。`, "error");
    return oldKey;
  }
  if (nextKey === oldKey) return oldKey;
  if (Object.hasOwn(record, nextKey)) {
    setNotice(`${label} ${nextKey} 已存在。`, "error");
    return oldKey;
  }
  const entries = Object.entries(record).map(([key, value]) => [key === oldKey ? nextKey : key, value]);
  for (const key of Object.keys(record)) delete record[key];
  for (const [key, value] of entries) addCatalogRecord(record, key, value);
  return nextKey;
}

function renderNovelCollectionAssets(parent) {
  const section = node("section", "nv-asset-group nv-novel-collections");
  section.dataset.assetGroup = "novel-collections";
  const head = node("div", "nv-asset-group-head");
  head.append(node("h2", "", "视觉小说收藏集"), button("＋ 添加收藏集", "quiet", () => {
    const collections = state.assets.collections ?? {};
    const suggested = nextCatalogId(collections, "collection");
    const id = window.prompt("收藏集 ID", suggested)?.trim();
    if (!id) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) { setNotice("收藏集 ID 须以字母或数字开头，只能包含字母、数字、点、下划线、冒号和连字符。", "error"); return; }
    if (Object.hasOwn(collections, id)) { setNotice(`收藏集 ID ${id} 已存在。`, "error"); return; }
    historyMutation("assets", `collection:add:${id}`, () => {
      state.assets.collections ??= {};
      addCatalogRecord(state.assets.collections, id, { title: "新收藏集", entries: {} });
    });
    rerenderWorkspace();
  }));
  section.append(head, node("p", "nv-field-help", "条目与对白、角色资源共用同一 novel.assets.json。解锁条件只能选择默认值为 false 的持久布尔变量；肖像只引用已登记角色和表情。"));
  section.append(button("打开变量声明", "quiet", () => { state.panel = "variables"; rerenderWorkspace(); }));

  for (const [collectionId, collection] of Object.entries(state.assets.collections ?? {})) {
    if (!collection || typeof collection !== "object" || Array.isArray(collection)) continue;
    const card = node("article", "nv-character-assets nv-novel-collection");
    card.dataset.collectionId = collectionId;
    const collectionHead = node("div", "nv-character-assets-head");
    state.historyContext = `collection:${collectionId}`;
    const collectionIdField = field(collectionHead, `收藏集 ID ${collectionId}`, collectionId, value => {
      const renamed = renameCatalogRecord(state.assets.collections, collectionId, value, "收藏集 ID");
      if (renamed === collectionId && String(value).trim() !== collectionId) return false;
      return true;
    }, { onChangeOnly: true, rerender: true });
    collectionIdField.dataset.collectionId = collectionId;
    field(collectionHead, `收藏集标题 ${collectionId}`, collection.title, value => { collection.title = value; });
    collectionHead.append(button(`删除收藏集 ${collectionId}`, "danger quiet", () => {
      historyMutation("assets", `collection:remove:${collectionId}`, () => {
        delete state.assets.collections[collectionId];
        if (!Object.keys(state.assets.collections).length) delete state.assets.collections;
      });
      rerenderWorkspace();
    }));
    card.append(collectionHead);
    card.append(button(`添加条目 ${collectionId}`, "quiet", () => {
      const entries = collection.entries && typeof collection.entries === "object" && !Array.isArray(collection.entries) ? collection.entries : {};
      const suggested = nextCatalogId(entries, "entry");
      const id = window.prompt(`条目 ID（${collectionId}）`, suggested)?.trim();
      if (!id) return;
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) { setNotice("条目 ID 须以字母或数字开头，只能包含字母、数字、点、下划线、冒号和连字符。", "error"); return; }
      if (Object.hasOwn(entries, id)) { setNotice(`条目 ID ${id} 已存在。`, "error"); return; }
      historyMutation("assets", `collection:entry:add:${collectionId}:${id}`, () => {
        if (!collection.entries || typeof collection.entries !== "object" || Array.isArray(collection.entries)) collection.entries = {};
        addCatalogRecord(collection.entries, id, { title: "新条目", body: "" });
      });
      rerenderWorkspace();
    }));

    const entries = collection.entries && typeof collection.entries === "object" && !Array.isArray(collection.entries) ? collection.entries : {};
    for (const [entryId, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const entryCard = node("article", "nv-instruction nv-novel-collection-entry");
      entryCard.dataset.collectionId = collectionId;
      entryCard.dataset.entryId = entryId;
      state.historyContext = `collection:${collectionId}:entry:${entryId}`;
      const entryIdField = field(entryCard, `条目 ID ${collectionId}.${entryId}`, entryId, value => {
        const renamed = renameCatalogRecord(collection.entries, entryId, value, "条目 ID");
        if (renamed === entryId && String(value).trim() !== entryId) return false;
        return true;
      }, { onChangeOnly: true, rerender: true });
      entryIdField.dataset.entryId = entryId;
      field(entryCard, `条目标题 ${collectionId}.${entryId}`, entry.title, value => { entry.title = value; });
      field(entryCard, `条目正文 ${collectionId}.${entryId}`, entry.body, value => { entry.body = value; }, { multiline: true, wide: true });

      const portrait = entry.portrait && typeof entry.portrait === "object" && !Array.isArray(entry.portrait) ? entry.portrait : undefined;
      const characterId = typeof portrait?.character === "string" ? portrait.character : "";
      const characterIds = Object.entries(state.assets.characters ?? {})
        .filter(([, variants]) => variants && typeof variants === "object" && !Array.isArray(variants) && Object.keys(variants).length > 0)
        .map(([id]) => id);
      const characterField = field(entryCard, `肖像角色 ${collectionId}.${entryId}`, characterId, value => {
        if (!value) { delete entry.portrait; return true; }
        const expressions = state.assets.characters[value];
        const choices = expressions && typeof expressions === "object" && !Array.isArray(expressions) ? Object.keys(expressions) : [];
        const expression = choices.includes(portrait?.character === value ? portrait.expression : "")
          ? portrait.expression
          : choices.includes("neutral") ? "neutral" : choices[0];
        if (expression) entry.portrait = { character: value, expression };
        else delete entry.portrait;
        return true;
      }, { select: [["", "不设置肖像"], ...characterIds.map(id => [id, id])], rerender: true });
      characterField.dataset.collectionId = collectionId;
      characterField.dataset.entryId = entryId;
      const currentCharacter = entry.portrait?.character;
      const expressions = currentCharacter && state.assets.characters[currentCharacter] && typeof state.assets.characters[currentCharacter] === "object"
        ? Object.keys(state.assets.characters[currentCharacter]) : [];
      const expressionField = field(entryCard, `肖像表情 ${collectionId}.${entryId}`, currentCharacter ? entry.portrait?.expression ?? "" : "", value => {
        if (!currentCharacter || !value) return false;
        entry.portrait = { character: currentCharacter, expression: value };
        return true;
      }, { select: [["", "选择表情"], ...expressions.map(id => [id, id])], rerender: true });
      expressionField.disabled = !currentCharacter || expressions.length === 0;
      expressionField.dataset.collectionId = collectionId;
      expressionField.dataset.entryId = entryId;

      const unlockVariables = Object.entries(state.story.variableDefinitions ?? {})
        .filter(([, definition]) => definition?.lifetime === "persistent" && definition?.defaultValue === false)
        .map(([name]) => [name, name]);
      field(entryCard, `解锁变量 ${collectionId}.${entryId}`, entry.unlockVariable ?? "", value => {
        if (value) entry.unlockVariable = value;
        else delete entry.unlockVariable;
      }, { select: [["", "始终开放"], ...unlockVariables] });
      entryCard.append(button(`删除条目 ${collectionId}.${entryId}`, "quiet danger", () => {
        historyMutation("assets", `collection:entry:remove:${collectionId}:${entryId}`, () => { delete collection.entries[entryId]; });
        rerenderWorkspace();
      }));
      card.append(entryCard);
    }
    section.append(card);
  }
  parent.append(section);
}

function renderAssetPanel() {
  const section = node("section", "nv-assets-panel");
  const heading = node("div", "nv-panel-heading");
  const copy = node("div", "");
  copy.append(node("h1", "", "项目资源注册表"), node("p", "", "编辑同一 novel.assets.json；图片按项目相对路径打入 Guest，音频使用 assets/audio 下的 WAV key，视频 cue 指向 assets/ 下的 MP4。"));
  heading.append(copy);
  const controls = node("div", "nv-inline-actions");
  controls.append(button("导入资源 JSON", "quiet", () => byId("novel-assets-import")?.click()), button("导出资源 JSON", "quiet", () => downloadJSON(`${state.story.id}-novel-assets.json`, state.assets)));
  const importInput = node("input", "nv-hidden-input");
  importInput.id = "novel-assets-import";
  importInput.type = "file";
  importInput.accept = ".json,application/json";
  importInput.addEventListener("change", () => { const file = importInput.files?.[0]; if (file) void importAssetFile(file); importInput.value = ""; });
  controls.append(importInput);
  heading.append(controls);
  section.append(heading);
  const help = node("p", "nv-asset-help", "图片请使用项目内 PNG/SVG；音频请使用 assets/audio 下的 WAV；视频只支持 assets/ 下的 MP4。保存资源后重新构建，即可在 Pocket Guest 中使用。路径必须留在项目内，不能使用符号链接。 ");
  section.append(help);
  renderNovelCollectionAssets(section);

  const skinGroup = node("section", "nv-asset-group");
  const skinHead = node("div", "nv-asset-group-head");
  skinHead.append(node("h2", "", "游戏界面图片皮肤"));
  if (state.assets.skin) {
    skinHead.append(button("移除图片皮肤", "danger quiet", () => {
      historyMutation("assets", "skin:remove", () => { delete state.assets.skin; });
      rerenderWorkspace();
    }));
  } else {
    skinHead.append(button("＋ 添加 frame 图片", "quiet", () => {
      historyMutation("assets", "skin:add", () => {
        state.assets.skin = { frame: { image: "", width: 1, height: 1, inset: 0 } };
      });
      rerenderWorkspace();
    }));
  }
  skinGroup.append(skinHead);
  if (!state.assets.skin) {
    skinGroup.append(
      node("p", "nv-field-help", "当前项目没有注册游戏界面皮肤。需要游戏 UI 使用图片皮肤时，请添加一张真实的项目内 PNG/SVG 并在此注册；不会回退到 App 组件的默认皮肤。未添加时旧项目保持原样。"),
    );
  } else {
    const skin = state.assets.skin;
    skinGroup.append(node("p", "nv-field-help", "图片路径必须是项目内 PNG/SVG。frame 与 accentFrame 的宽、高为运行时实际源像素，inset 是四边统一的源像素宽度。图标图集按等分网格从左到右、从上到下读取；图标 ID 必须唯一且使用小写字母、数字和连字符。保存时使用 Pocket VN 共用皮肤校验器。"));
    skinGroup.append(renderSkinFrameEditor(skin, "frame"));

    const optionalControls = node("div", "nv-inline-actions");
    if (skin.accentFrame === undefined) {
      optionalControls.append(button("＋ 添加 accentFrame", "quiet", () => {
        historyMutation("assets", "skin:accentFrame:add", () => {
          skin.accentFrame = { image: "", width: 1, height: 1, inset: 0 };
        });
        rerenderWorkspace();
      }));
    } else {
      optionalControls.append(button("移除 accentFrame", "danger quiet", () => {
        historyMutation("assets", "skin:accentFrame:remove", () => { delete skin.accentFrame; });
        rerenderWorkspace();
      }));
      skinGroup.append(renderSkinFrameEditor(skin, "accentFrame"));
    }

    if (skin.icons === undefined) {
      optionalControls.append(button("＋ 添加图标图集", "quiet", () => {
        historyMutation("assets", "skin:icons:add", () => {
          skin.icons = { image: "", width: 1, height: 1, columns: 1, rows: 1, names: ["icon_1"] };
        });
        rerenderWorkspace();
      }));
    } else {
      optionalControls.append(button("移除图标图集", "danger quiet", () => {
        historyMutation("assets", "skin:icons:remove", () => { delete skin.icons; });
        rerenderWorkspace();
      }));
      skinGroup.append(renderSkinIconsEditor(skin));
    }
    skinGroup.append(optionalControls);
  }
  section.append(skinGroup);

  const backgrounds = node("section", "nv-asset-group");
  const backgroundHead = node("div", "nv-asset-group-head");
  backgroundHead.append(node("h2", "", "背景"), button("＋ 添加背景", "quiet", () => addAssetKey(state.assets.backgrounds, "背景资源键", `background_${Object.keys(state.assets.backgrounds).length + 1}`)));
  backgrounds.append(backgroundHead);
  for (const [key, path] of Object.entries(state.assets.backgrounds)) {
    state.historyContext = `background:${key}`;
    const row = node("div", "nv-asset-row");
    field(row, "键", key, next => {
      const atmospheres = state.assets.atmospheres;
      if (next !== key && Object.hasOwn(atmospheres ?? {}, next)) {
        setNotice(`天气配置键 ${next} 已存在，请先处理该配置。`, "error");
        return false;
      }
      const changed = renameRecordKey(state.assets.backgrounds, key, next);
      if (changed !== key) {
        if (Object.hasOwn(atmospheres ?? {}, key)) renameRecordKey(atmospheres, key, changed);
        rerenderWorkspace();
      }
      return true;
    }, { onChangeOnly: true });
    field(row, "项目相对图片路径", path, next => { state.assets.backgrounds[key] = next; });
    row.append(button("移除", "danger quiet", () => { historyMutation("assets", `background:remove:${key}`, () => { delete state.assets.backgrounds[key]; if (state.assets.atmospheres) { delete state.assets.atmospheres[key]; if (!Object.keys(state.assets.atmospheres).length) delete state.assets.atmospheres; } }); rerenderWorkspace(); }));
    backgrounds.append(row);
  }
  section.append(backgrounds);
  renderAtmosphereAssets(section);
  renderChoiceSurfaceAssets(section);

  const characters = node("section", "nv-asset-group");
  const characterHead = node("div", "nv-asset-group-head");
  characterHead.append(node("h2", "", "角色立绘与表情"), button("＋ 添加角色", "quiet", () => {
    const key = window.prompt("角色资源键", `character_${Object.keys(state.assets.characters).length + 1}`)?.trim();
    if (!key) return;
    if (state.assets.characters[key]) { setNotice(`角色键 ${key} 已存在。`, "error"); return; }
    historyMutation("assets", `character:add:${key}`, () => { state.assets.characters[key] = { neutral: "" }; });
    rerenderWorkspace();
  }));
  characters.append(characterHead);
  for (const [character, expressions] of Object.entries(state.assets.characters)) {
    state.historyContext = `character:${character}`;
    const card = node("article", "nv-character-assets");
    const head = node("div", "nv-character-assets-head");
    field(head, "角色 ID", character, next => { const changed = renameRecordKey(state.assets.characters, character, next); if (changed !== character) rerenderWorkspace(); }, { onChangeOnly: true });
    head.append(button("移除角色", "danger quiet", () => { historyMutation("assets", `character:remove:${character}`, () => { delete state.assets.characters[character]; }); rerenderWorkspace(); }));
    card.append(head);
    for (const [expression, path] of Object.entries(expressions)) {
      state.historyContext = `character:${character}:expression:${expression}`;
      const row = node("div", "nv-asset-row nv-expression-row");
      field(row, "表情键", expression, next => { const changed = renameRecordKey(expressions, expression, next); if (changed !== expression) rerenderWorkspace(); }, { onChangeOnly: true });
      field(row, "项目相对图片路径", path, next => { expressions[expression] = next; });
      row.append(button("移除表情", "danger quiet", () => { historyMutation("assets", `expression:remove:${character}:${expression}`, () => { delete expressions[expression]; }); rerenderWorkspace(); }));
      card.append(row);
    }
    card.append(button("＋ 添加表情", "quiet", () => addAssetKey(expressions, `${character} 的表情键`, `expression_${Object.keys(expressions).length + 1}`)));
    characters.append(card);
  }
  section.append(characters);

  const cgs = node("section", "nv-asset-group");
  const cgHead = node("div", "nv-asset-group-head");
  cgHead.append(node("h2", "", "CG 与回忆图鉴"), button("＋ 添加 CG", "quiet", () => {
    const key = window.prompt("CG 资源键", `cg_${Object.keys(state.assets.cgs).length + 1}`)?.trim();
    if (!key) return;
    if (state.assets.cgs[key]) { setNotice(`CG 键 ${key} 已存在。`, "error"); return; }
    historyMutation("assets", `cg:add:${key}`, () => { state.assets.cgs[key] = { image: "", title: "新 CG" }; });
    rerenderWorkspace();
  }));
  cgs.append(cgHead);
  for (const [key, cg] of Object.entries(state.assets.cgs)) {
    state.historyContext = `cg:${key}`;
    const row = node("div", "nv-asset-row nv-cg-row");
    field(row, "CG 键", key, next => { const changed = renameRecordKey(state.assets.cgs, key, next); if (changed !== key) rerenderWorkspace(); }, { onChangeOnly: true });
    field(row, "标题", cg.title, next => { cg.title = next; });
    field(row, "项目相对图片路径", cg.image, next => { cg.image = next; });
    row.append(button("移除", "danger quiet", () => { historyMutation("assets", `cg:remove:${key}`, () => { delete state.assets.cgs[key]; }); rerenderWorkspace(); }));
    cgs.append(row);
  }
  section.append(cgs);

  const audio = node("section", "nv-asset-group");
  const audioHead = node("div", "nv-asset-group-head");
  audioHead.append(node("h2", "", "音频 cue"), button("＋ 添加音频 cue", "quiet", () => addAssetKey(state.assets.audio, "音频 cue 键", `cue_${Object.keys(state.assets.audio).length + 1}`)));
  audio.append(audioHead);
  for (const [cue, path] of Object.entries(state.assets.audio)) {
    state.historyContext = `audio:${cue}`;
    const row = node("div", "nv-asset-row");
    field(row, "Cue 键", cue, next => { const changed = renameRecordKey(state.assets.audio, cue, next); if (changed !== cue) rerenderWorkspace(); }, { onChangeOnly: true });
    field(row, "WAV resource key", path, next => { state.assets.audio[cue] = next; });
    row.append(button("移除", "danger quiet", () => { historyMutation("assets", `audio:remove:${cue}`, () => { delete state.assets.audio[cue]; }); rerenderWorkspace(); }));
    audio.append(row);
  }
  section.append(audio);
  const videos = node("section", "nv-asset-group");
  const videoHead = node("div", "nv-asset-group-head");
  videoHead.append(node("h2", "", "视频 cue"), button("＋ 添加视频 cue", "quiet", () => addAssetKey(ensureVideoRegistry(), "视频 cue 键", `video_${Object.keys(state.assets.videos ?? {}).length + 1}`)));
  videos.append(videoHead);
  for (const [cue, path] of Object.entries(state.assets.videos ?? {})) {
    state.historyContext = `video:${cue}`;
    const row = node("div", "nv-asset-row");
    field(row, "视频 Cue 键", cue, next => { const changed = renameRecordKey(state.assets.videos, cue, next); if (changed !== cue) rerenderWorkspace(); }, { onChangeOnly: true });
    field(row, "assets/ 下相对视频路径", path, next => { state.assets.videos[cue] = next; });
    row.append(button("移除", "danger quiet", () => { historyMutation("assets", `video:remove:${cue}`, () => { delete state.assets.videos[cue]; }); rerenderWorkspace(); }));
    videos.append(row);
  }
  section.append(videos);
  renderTextSoundAssets(section);
  renderModelAssets(section);
  renderAssetDiagnostics(section);
  return section;
}

function renderTextSoundAssets(parent) {
  const section = node("section", "nv-asset-group");
  section.append(node("h2", "", "逐字拟声配置"), node("p", "nv-field-help", "为默认旁白或角色绑定已注册的短音频。拟声跟随实际文字显示，受音效音量控制；玩家可自行开启，不用于朗读句子。"));
  const cueIds = Object.keys(state.assets.audio);
  const config = state.assets.textSounds;
  if (!config) {
    const add = button("添加拟声配置", "quiet", () => {
      historyMutation("assets", "textSounds:add", () => { state.assets.textSounds = { defaultCue: cueIds[0] }; });
      rerenderWorkspace();
    });
    add.disabled = !cueIds.length;
    section.append(add);
    if (!cueIds.length) section.append(node("p", "nv-field-help", "请先注册至少一个音频 cue。"));
  } else {
    state.historyContext = "textSounds";
    const cueOptions = [["", "不播放"], ...cueIds.map(cue => [cue, cue])];
    field(section, "默认拟声音频", config.defaultCue ?? "", value => { if (value) config.defaultCue = value; else delete config.defaultCue; }, { select: cueOptions });
    field(section, "拟声最小间隔（毫秒）", config.minIntervalMs, value => { if (value === undefined) delete config.minIntervalMs; else config.minIntervalMs = value; }, { type: "number", optional: true, integer: true, min: 40, max: 1000, placeholder: "100" });
    for (const [speaker, cue] of Object.entries(config.speakers ?? {})) {
      const row = node("div", "nv-asset-row");
      state.historyContext = `textSounds:speaker:${speaker}`;
      field(row, `角色拟声音频 ${speaker}`, cue, value => { if (value) config.speakers[speaker] = value; else delete config.speakers[speaker]; }, { select: [["", "使用默认拟声"], ...cueIds.map(cue => [cue, cue])] });
      row.append(button(`移除拟声角色 ${speaker}`, "quiet danger", () => {
        historyMutation("assets", `textSounds:remove:${speaker}`, () => { delete config.speakers[speaker]; if (!Object.keys(config.speakers).length) delete config.speakers; });
        rerenderWorkspace();
      }));
      section.append(row);
    }
    section.append(button("添加角色拟声", "quiet", () => {
      const speaker = window.prompt("角色显示名（需与对白 speaker 一致）", "Mira")?.trim();
      if (!speaker) return;
      if (Object.hasOwn(config.speakers ?? {}, speaker)) { setNotice("该角色已有拟声配置。", "error"); return; }
      if (!cueIds.length) { setNotice("请先注册音频 cue。", "error"); return; }
      historyMutation("assets", "textSounds:speaker:add", () => {
        config.speakers ??= {};
        Object.defineProperty(config.speakers, speaker, { value: cueIds[0], enumerable: true, writable: true, configurable: true });
      });
      rerenderWorkspace();
    }), button("移除拟声配置", "quiet danger", () => {
      historyMutation("assets", "textSounds:remove", () => { delete state.assets.textSounds; });
      rerenderWorkspace();
    }));
  }
  parent.append(section);
}

function renderDiagnostics(validation) {
  const container = byId("novel-diagnostics");
  if (!container) return;
  container.replaceChildren();
  const diagnostics = validation?.diagnostics ?? [];
  const counts = { error: 0, warning: 0, info: 0 };
  for (const item of diagnostics) counts[item.severity] = (counts[item.severity] || 0) + 1;
  const summary = node("div", "nv-diagnostics-summary");
  summary.append(node("strong", "", counts.error ? `${counts.error} 个错误` : "结构检查通过"), node("span", "", `${counts.warning} 个提醒 · ${counts.info} 条信息`));
  container.append(summary);
  if (!diagnostics.length) container.append(node("p", "nv-field-help", "引用、起点、变量和可达性检查没有发现问题。"));
  for (const item of diagnostics) {
    const entry = button("", `nv-diagnostic ${item.severity}`, () => {
      const field = String(item.location?.field ?? "");
      if (field.startsWith("story.timelines")) {
        const registry = novelTimelineRegistry() ?? {};
        const timelineId = Object.keys(registry).sort((a, b) => b.length - a.length)
          .find(id => field === `story.timelines.${id}` || field.startsWith(`story.timelines.${id}.`));
        state.selectedTimelineId = timelineId ?? "";
        state.panel = "timelines";
        rerenderWorkspace();
        return;
      }
      if (item.location?.label && state.story.script[item.location.label]) {
        state.selectedLabel = item.location.label;
        state.panel = "story";
        rerenderWorkspace();
        if (Number.isInteger(item.location.index)) {
          document.querySelectorAll(".nv-instruction")[item.location.index]?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    });
    const location = item.location?.label ? node("span", "nv-diagnostic-code", `${item.location.label}${Number.isInteger(item.location.index) ? ` · 第 ${item.location.index + 1} 条指令` : ""}`) : null;
    if (location) entry.append(location);
    if (item.location?.field) entry.append(node("span", "nv-diagnostic-code", item.location.field));
    entry.append(node("span", "", item.message));
    container.append(entry);
  }
  const build = byId("novel-build");
  if (build) build.disabled = state.building || state.dirty || !validation.valid;
}

function contextPreviewRootIdentity(root) {
  if (root?.kind === "main") return "main";
  if (root?.kind === "replay") return root.entryId;
  if (root?.kind === "blueprint") return root.label;
  return "";
}

function contextPreviewRootDisplay(root, location, story) {
  const address = location ? `${location.label}:${location.index}` : "位置未知";
  if (root?.kind === "main") return `故事起点 · ${address}`;
  if (root?.kind === "replay") {
    const entry = story?.replayEntries?.find(candidate => candidate.id === root.entryId);
    return `鉴赏回放「${entry?.title || root.entryId}」(${root.entryId}) · ${address}`;
  }
  if (root?.kind === "blueprint") {
    const metadata = story?.editor?.blueprint?.nodes?.[root.label];
    const title = metadata?.title || root.label;
    const kind = metadata?.kind === "chapter" ? "章节节点" : "蓝图入口";
    return `${kind}「${title}」(${root.label}) · ${address}`;
  }
  return `未识别的上下文入口 · ${address}`;
}

function contextPreviewRootOptionLabel(rootOption, story) {
  const root = rootOption.root;
  if (root?.kind === "blueprint") {
    const kind = rootOption.nodeKind === "chapter" ? "章节节点" : "蓝图入口";
    return `${kind}「${rootOption.title}」(${root.label}) · ${rootOption.location.label}:${rootOption.location.index}`;
  }
  return contextPreviewRootDisplay(root, rootOption.location, story);
}

function contextPreviewWaitingForInteraction() {
  const blocker = state.contextPreview?.status;
  return (blocker === "choice" || blocker === "input") && state.snapshot?.active?.kind === blocker;
}

function changeContextPreviewRoot(rootOption) {
  if (!rootOption || rootOption.value === state.contextPreviewRootValue) return;
  state.contextPreviewRootValue = rootOption.value;
  if (!state.contextPreview && !state.contextPreviewEngineRoot) {
    renderPreviewNow();
    return;
  }
  invalidateContextPreview();
}

function renderPreviewPanel() {
  const section = node("section", "nv-preview-panel");
  const heading = node("div", "nv-panel-heading");
  const copy = node("div", "");
  copy.append(node("h1", "", "试玩与调试"), node("p", "", "试玩使用与 Pocket 游戏相同的剧情规则；保存后重新运行会加载最新内容。"));
  heading.append(copy);
  const controls = node("div", "nv-inline-actions");
  const pause = button(state.snapshot?.paused ? "继续" : "暂停", "quiet", () => togglePreviewPause());
  pause.id = "novel-preview-pause";
  const contextBlocker = contextPreviewWaitingForInteraction() ? state.contextPreview.status : "";
  if (contextBlocker) {
    pause.disabled = true;
    pause.textContent = contextBlocker === "choice" ? "等待选择" : "等待输入";
    pause.title = "上下文重建停在真实玩家操作处；完成后请继续重建。";
  }
  const step = button("单步到下一阻塞点", "secondary", () => { void stepPreview(); });
  step.id = "novel-preview-step";
  if (["choice", "input", "breakpoint", "limit"].includes(state.contextPreview?.status) || state.contextPreview && ["choice", "input"].includes(state.snapshot?.active?.kind)) step.disabled = true;
  if (!standalonePreview) {
    const open = node("a", "nv-button secondary", "在新页面打开试玩 ↗");
    const target = new URL(window.location.href);
    target.searchParams.set("view", "preview");
    open.href = target.href;
    open.target = "_blank";
    open.rel = "noopener";
    open.id = "novel-preview-open-page";
    open.title = "在新标签页运行已保存的故事";
    controls.append(open);
  }
  controls.append(
    button("运行 / 重新开始", "primary", () => { void restartPreview(); }),
    pause,
    step,
  );
  if (standalonePreview) {
    const next = button("下一句", "primary", advancePreviewSay);
    next.id = "novel-preview-advance";
    controls.append(next);
  }
  heading.append(controls);
  section.append(heading);

  const body = node("div", "nv-preview-grid");
  const view = node("div", "nv-live-view");
  view.id = "novel-live-view";
  renderLiveView(view);
  body.append(view);
  const inspector = node("div", "nv-debug-inspector");
  const location = state.snapshot?.active?.location ?? state.snapshot?.location;
  const locRow = node("div", "nv-debug-location");
  const locationValue = node("code", "", location ? `${location.label}:${location.index}` : "尚未启动");
  locationValue.id = "novel-preview-location";
  locRow.append(node("strong", "", "执行位置"), locationValue);
  inspector.append(locRow);
  const jump = node("div", "nv-jump-control");
  jump.id = "novel-preview-jump";
  const jumpLabel = node("select", "nv-input");
  for (const label of labels()) option(jumpLabel, label, label);
  jumpLabel.value = location?.label && labels().includes(location.label) ? location.label : (labels().includes(state.story.start) ? state.story.start : labels()[0] || "");
  const jumpIndex = node("input", "nv-input");
  jumpIndex.type = "number"; jumpIndex.min = "0"; jumpIndex.step = "1"; jumpIndex.value = String(location?.index ?? 0);
  jump.append(
    jumpLabel,
    jumpIndex,
    button("跳到指令", "quiet", () => { void jumpPreview(jumpLabel.value, Number(jumpIndex.value)); }),
  );
  const contextRoots = typeof state.engineModule?.listNovelContextPreviewRoots === "function"
    ? state.engineModule.listNovelContextPreviewRoots(state.story)
    : [];
  const selectedRoot = contextRoots.find(root => root.value === state.contextPreviewRootValue)
    ?? contextRoots.find(root => root.value === "main")
    ?? contextRoots[0];
  if (selectedRoot) state.contextPreviewRootValue = selectedRoot.value;
  const rootField = node("label", "nv-field nv-context-preview-root-field");
  rootField.append(node("span", "nv-field-label", "上下文重建起点"));
  const rootSelect = node("select", "nv-input");
  rootSelect.id = "novel-context-preview-root";
  rootSelect.setAttribute("aria-label", "上下文重建起点");
  for (const candidate of contextRoots) option(rootSelect, candidate.value, contextPreviewRootOptionLabel(candidate, state.story));
  rootSelect.value = selectedRoot?.value ?? "";
  rootSelect.disabled = !selectedRoot;
  rootSelect.addEventListener("change", () => changeContextPreviewRoot(contextRoots.find(candidate => candidate.value === rootSelect.value)));
  rootField.append(rootSelect);
  const contextControls = node("div", "nv-context-preview-controls");
  const rebuildContext = button("从所选入口重建上下文", "secondary", () => {
    const rootOption = contextRoots.find(candidate => candidate.value === rootSelect.value);
    void reconstructPreviewContext(jumpLabel.value, Number(jumpIndex.value), rootOption);
  });
  rebuildContext.id = "novel-preview-context";
  rebuildContext.disabled = !selectedRoot;
  contextControls.append(rebuildContext);
  const continueContext = button("继续重建上下文", "quiet", () => { void continuePreviewContext(); });
  continueContext.id = "novel-context-preview-continue";
  continueContext.hidden = true;
  contextControls.append(continueContext);
  const contextStatus = node("div", "nv-context-preview-status", "尚未重建上下文。");
  contextStatus.id = "novel-context-preview-status";
  contextStatus.dataset.status = "idle";
  contextStatus.setAttribute("role", "status");
  contextStatus.setAttribute("aria-live", "polite");
  const contextFacts = node("pre", "nv-variables nv-context-preview-facts", "");
  contextFacts.id = "novel-context-preview-facts";
  contextFacts.hidden = true;
  inspector.append(node("div", "nv-section-title", "定位到标签 / 指令"), jump);
  inspector.append(rootField);
  inspector.append(node("p", "nv-context-preview-note", "跳到指令保留当前引擎状态。上下文从所选入口启动独立新引擎，使用新游戏默认变量与偏好，不继承主线舞台、调用栈或历史；章节需自行建立场景。作者可预览已锁定的鉴赏回放入口，此操作不改变玩家解锁状态。选择入口只影响下一次重建，当前舞台保持原样。"), contextControls, contextStatus, contextFacts);
  syncContextPreviewControls(contextStatus, continueContext, contextFacts, rebuildContext);
  const bpTitle = node("div", "nv-debug-subtitle");
  bpTitle.append(node("strong", "", "断点"), node("span", "", "在进入选中指令前暂停"));
  inspector.append(bpTitle);
  const breakpointList = node("div", "nv-breakpoint-list");
  for (const [label, instructions] of Object.entries(state.story.script)) {
    if (!Array.isArray(instructions)) continue;
    for (const [index, instruction] of instructions.entries()) {
      const key = `${label}:${index}`;
      const entry = node("label", "nv-breakpoint-row");
      const check = node("input"); check.type = "checkbox"; check.checked = state.breakpoints.has(key);
      check.addEventListener("change", () => {
        if (check.checked) state.breakpoints.add(key); else state.breakpoints.delete(key);
        if (state.contextPreview) invalidateContextPreview("断点设置已改变，已取消这次上下文目标；请重新重建上下文。");
        else void applyBreakpoints();
      });
      entry.append(check, node("span", "", `${label}:${index} · ${instruction.type}`));
      breakpointList.append(entry);
    }
  }
  inspector.append(breakpointList);
  const traceHeading = node("div", "nv-debug-subtitle nv-execution-trace-heading");
  traceHeading.append(node("strong", "", "实际执行 OP"), node("span", "", "提交后记录 · 最多保留最近 200 条"));
  const traceControls = node("div", "nv-inline-actions");
  const clearTrace = button("清空", "quiet", () => {
    state.executionTrace = [];
    renderExecutionTrace(traceList);
  });
  clearTrace.id = "novel-trace-clear";
  traceControls.append(clearTrace);
  traceHeading.append(traceControls);
  inspector.append(traceHeading);
  inspector.append(node("p", "nv-execution-trace-note", "时间轴只记录引擎实际执行并提交的指令。implicitReturn 表示运行到标签末尾时引擎自动返回，不是剧本中的指令。定位优先按稳定 id 匹配；无 id 指令被编辑且无法唯一匹配时会禁用。"));
  const traceList = node("div", "nv-execution-trace");
  traceList.id = "novel-execution-trace";
  renderExecutionTrace(traceList);
  inspector.append(traceList);
  inspector.append(node("div", "nv-section-title", "只读变量"));
  const variableBox = node("pre", "nv-variables");
  variableBox.id = "novel-variables";
  variableBox.textContent = JSON.stringify(state.snapshot?.variables ?? {}, null, 2);
  inspector.append(variableBox);
  inspector.append(node("div", "nv-section-title", "音频 cue 请求（编辑器不模拟播放）"));
  const audioFacts = node("pre", "nv-variables nv-audio-facts");
  audioFacts.id = "novel-audio-facts";
  audioFacts.textContent = JSON.stringify(state.snapshot?.audioIntents ?? {}, null, 2);
  inspector.append(audioFacts);
  const audioEventSummary = node("div", "nv-field-help");
  audioEventSummary.id = "novel-audio-event-summary";
  audioEventSummary.textContent = state.audioEvents.length ? `最近一步产生 ${state.audioEvents.length} 个音频请求。运行时会交给已注册的 Pocket 音频能力。` : "此刻没有新的音频请求。";
  inspector.append(audioEventSummary);
  if (state.runtimeError) inspector.append(node("div", "nv-runtime-error", state.runtimeError));
  body.append(inspector);
  section.append(body);
  return section;
}

function executionTraceSourceIndex() {
  const byId = new Map();
  const bySignature = new Map();
  for (const [label, instructions] of Object.entries(state.story?.script ?? {})) {
    if (!Array.isArray(instructions)) continue;
    instructions.forEach((instruction, index) => {
      const target = { label, index };
      const hasId = typeof instruction.id === "string";
      const indexBySource = hasId ? byId : bySignature;
      const signature = hasId ? `${instruction.type}\u0000${instruction.id}` : JSON.stringify(instruction);
      const matches = indexBySource.get(signature) ?? [];
      matches.push(target);
      indexBySource.set(signature, matches);
    });
  }
  return { byId, bySignature };
}

function currentExecutionTraceSourceIndex() {
  if (!state.executionTraceSourceIndex || state.executionTraceSourceIndexRevision !== state.historyGeneration || state.executionTraceSourceIndexStory !== state.story) {
    state.executionTraceSourceIndex = executionTraceSourceIndex();
    state.executionTraceSourceIndexRevision = state.historyGeneration;
    state.executionTraceSourceIndexStory = state.story;
  }
  return state.executionTraceSourceIndex;
}

function createStageSourceFacts() {
  return { background: null, layers: [], characters: new Map(), objects: new Map() };
}

function applyStageSourceFact(facts, entry, sourceStory) {
  if (entry.op !== "scene") return;
  const instruction = sourceStory?.script?.[entry.location.label]?.[entry.location.index];
  if (instruction?.type !== "scene") return;
  const source = {
    location: { label: entry.location.label, index: entry.location.index },
    op: entry.op,
    ...(entry.id ? { id: entry.id } : {}),
  };
  if (Object.hasOwn(instruction, "background")) {
    facts.background = typeof instruction.background === "string"
      ? { key: instruction.background, entry: source }
      : null;
  }
  if (Object.hasOwn(instruction, "backgroundLayers")) {
    facts.layers = (instruction.backgroundLayers ?? []).map((layer, index) => ({
      key: layer.background,
      index,
      entry: source,
    }));
  }
  if (Object.hasOwn(instruction, "objects")) {
    facts.objects.clear();
    for (const object of instruction.objects ?? []) facts.objects.set(object.id, { key: object.image, entry: source });
  }
  for (const id of instruction.remove ?? []) facts.characters.delete(id);
  for (const update of instruction.characters ?? []) {
    if (update.visible === false) facts.characters.delete(update.id);
    else {
      const previous = facts.characters.get(update.id);
      if (!previous || update.expression !== undefined) facts.characters.set(update.id, { key: update.id, entry: source });
    }
  }
}

function appendExecutionTrace(entries, target = state) {
  if (target === state && state.contextPreview?.driving) return;
  for (const entry of entries) {
    target.executionTrace.push({ ...entry, sequence: ++target.executionTraceSequence });
    applyStageSourceFact(target.stageSourceFacts, entry, target.executionTraceStory);
  }
  if (target.executionTrace.length > 200) target.executionTrace.splice(0, target.executionTrace.length - 200);
  if (target !== state) return;
  renderPreviewNow();
  syncExecutionTraceView();
}

function cloneStageSourceFacts(facts) {
  const copyFact = fact => fact ? { ...fact, entry: { ...fact.entry, location: { ...fact.entry.location } } } : fact;
  return {
    background: copyFact(facts.background),
    layers: facts.layers.map(copyFact),
    characters: new Map([...facts.characters].map(([id, fact]) => [id, copyFact(fact)])),
    objects: new Map([...(facts.objects ?? new Map())].map(([id, fact]) => [id, copyFact(fact)])),
  };
}

function createExecutionTraceCapture(story, seed = null) {
  return {
    executionTraceStory: seed?.executionTraceStory ?? structuredClone(story),
    executionTrace: seed ? seed.executionTrace.map(entry => ({ ...entry, location: { ...entry.location } })) : [],
    executionTraceSequence: seed?.executionTraceSequence ?? 0,
    stageSourceFacts: seed ? cloneStageSourceFacts(seed.stageSourceFacts) : createStageSourceFacts(),
  };
}

function invalidateStageSourceFacts() {
  state.stageSourceFacts = createStageSourceFacts();
}

function invalidateContextPreview(message = "", { pause = true } = {}) {
  const hadContext = Boolean(state.contextPreview);
  if (!hadContext && !state.contextPreviewEngineRoot) return;
  try {
    if (pause && (state.contextPreviewEngineRoot || hadContext) && state.engine) {
      const current = state.engine.getSnapshot();
      if (!current.paused) state.engine.debug.pause();
      state.snapshot = state.engine.getSnapshot();
    }
  } catch (error) {
    state.runtimeError = error.message;
    if (hadContext) {
      state.contextPreview = {
        ...state.contextPreview,
        status: "error",
        message: `无法暂停旧上下文引擎：${error.message}`,
        driving: false,
      };
    }
    renderPreviewNow();
    syncPreviewClock();
    return;
  }
  if (!hadContext) {
    renderPreviewNow();
    syncPreviewClock();
    return;
  }
  state.contextPreview = message
    ? { ...state.contextPreview, status: "error", message, driving: false }
    : null;
  void applyBreakpoints();
  renderPreviewNow();
  syncPreviewClock();
}

function executionTraceTarget(entry, index = currentExecutionTraceSourceIndex()) {
  const sourceInstructions = state.executionTraceStory?.script?.[entry.location.label];
  const sourceIndex = entry.op === "implicitReturn" ? entry.location.index - 1 : entry.location.index;
  const source = Array.isArray(sourceInstructions) ? sourceInstructions[sourceIndex] : null;
  if (!source || (entry.op !== "implicitReturn" && source.type !== entry.op)) return null;
  if (entry.id && source.id !== entry.id) return null;
  const sourceSignature = JSON.stringify(source);
  const candidates = typeof source.id === "string"
    ? index.byId.get(`${source.type}\u0000${source.id}`) ?? []
    : index.bySignature.get(sourceSignature) ?? [];
  const original = candidates.find(candidate => candidate.label === entry.location.label && candidate.index === sourceIndex);
  if (original) return original;
  return candidates.length === 1 ? candidates[0] : null;
}

function previewSourceEntry(location, op) {
  if (!location || !Number.isSafeInteger(location.index)) return null;
  const instruction = state.executionTraceStory?.script?.[location.label]?.[location.index];
  if (!instruction || instruction.type !== op) return null;
  return {
    location: { label: location.label, index: location.index },
    op,
    ...(typeof instruction.id === "string" ? { id: instruction.id } : {}),
  };
}

function previewSourceControl(entry, kind, className = "") {
  const target = entry ? executionTraceTarget(entry) : null;
  const sourceNames = { background: "背景配置来源", layer: "叠加层配置来源", character: "角色配置来源", object: "场景对象配置来源", dialogue: "对白源码", ending: "结局源码" };
  const sourceName = sourceNames[kind] || "执行来源";
  const control = button(target ? sourceName : "来源未知", `nv-preview-source nv-preview-source-${kind} ${className}`, () => {
    if (target) locateExecutionTraceEntry(entry);
  }, target ? `定位到实际执行的${sourceName}` : "没有可确认的执行来源");
  control.dataset.sourceKind = kind;
  if (target) {
    control.dataset.sourceLocation = `${target.label}:${target.index}`;
    control.dataset.sourceExecutionLocation = `${entry.location.label}:${entry.location.index}`;
    control.dataset.targetStoryRevision = String(state.historyGeneration);
  } else {
    control.disabled = true;
    control.dataset.sourceLocation = "";
  }
  control.setAttribute("aria-label", target ? `${sourceName} ${target.label}:${target.index}` : `${sourceName}未知`);
  return control;
}

function currentStageSourceControl(fact, key, kind, className = "") {
  return previewSourceControl(fact?.key === key ? fact.entry : null, kind, className);
}

function locateExecutionTraceEntry(entry) {
  const target = executionTraceTarget(entry);
  if (!target || !state.story.script[target.label]?.[target.index]) return;
  state.selectedLabel = target.label;
  state.panel = "story";
  rerenderWorkspace();
  requestAnimationFrame(() => document.querySelectorAll(".nv-instruction")[target.index]?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

function createExecutionTraceRow(entry) {
  const location = `${entry.location.label}:${entry.location.index}`;
  const row = button("", "nv-execution-trace-entry", () => locateExecutionTraceEntry(entry));
  row.dataset.sequence = String(entry.sequence);
  row.dataset.location = location;
  row.dataset.op = entry.op;
  row.setAttribute("aria-label", `执行记录 ${entry.sequence}，${location}，${entry.op}${entry.id ? `，${entry.id}` : ""}`);
  row.append(node("code", "nv-execution-trace-sequence", `#${entry.sequence}`));
  row.append(node("code", "nv-execution-trace-location", location));
  row.append(node("span", "nv-execution-trace-op", entry.op));
  if (entry.id) row.append(node("span", "nv-execution-trace-id", entry.id));
  if (entry.op === "implicitReturn" && entry.returnTo) {
    row.append(node("span", "nv-execution-trace-return", `→ ${entry.returnTo.label}:${entry.returnTo.index}`));
  }
  return row;
}

function refreshExecutionTraceTarget(row, entry, sourceRevision, index) {
  const target = executionTraceTarget(entry, index);
  row.disabled = !target;
  row.dataset.targetStoryRevision = sourceRevision;
}

function renderExecutionTrace(container) {
  const sourceRevision = String(state.historyGeneration);
  const firstSequence = state.executionTrace[0]?.sequence ?? "";
  const lastSequence = state.executionTrace.at(-1)?.sequence ?? "";
  const traceRevision = `${state.executionTraceSequence}/${state.executionTrace.length}/${firstSequence}/${lastSequence}`;
  if (container.dataset.traceRevision === traceRevision && container.dataset.sourceRevision === sourceRevision) return;

  if (state.executionTrace.length === 0) {
    container.replaceChildren(node("div", "nv-empty nv-execution-trace-empty", "尚无已提交的指令执行记录。"));
    container.dataset.traceRevision = traceRevision;
    container.dataset.sourceRevision = sourceRevision;
    return;
  }

  container.querySelector(".nv-execution-trace-empty")?.remove();
  const existingRows = new Map([...container.querySelectorAll(".nv-execution-trace-entry")].map(row => [row.dataset.sequence, row]));
  let sourceIndex;
  const getSourceIndex = () => sourceIndex ??= executionTraceSourceIndex();
  for (const [index, entry] of state.executionTrace.entries()) {
    const sequence = String(entry.sequence);
    let row = existingRows.get(sequence);
    if (row) {
      existingRows.delete(sequence);
      if (row.dataset.targetStoryRevision !== sourceRevision) refreshExecutionTraceTarget(row, entry, sourceRevision, getSourceIndex());
    } else {
      row = createExecutionTraceRow(entry);
      refreshExecutionTraceTarget(row, entry, sourceRevision, getSourceIndex());
    }
    const current = container.children[index] ?? null;
    if (current !== row) container.insertBefore(row, current);
  }
  for (const row of existingRows.values()) row.remove();
  container.dataset.traceRevision = traceRevision;
  container.dataset.sourceRevision = sourceRevision;
}

function syncExecutionTraceView({ reset = false } = {}) {
  const container = byId("novel-execution-trace");
  if (!container) return;
  if (reset) {
    container.replaceChildren();
    delete container.dataset.traceRevision;
    delete container.dataset.sourceRevision;
  }
  renderExecutionTrace(container);
}

function inputPreviewKey(active) {
  return JSON.stringify([active.location.label, active.location.index, active.id, active.inputType]);
}

function syncInputPreview(panel, active, paused) {
  panel.querySelector(".nv-preview-input-prompt").textContent = active.prompt || "玩家输入";
  const draft = panel.querySelector("input");
  draft.disabled = paused;
  if (active.inputType === "boolean") draft.checked = active.draft === true;
  else {
    if (draft.value !== active.draft) draft.value = active.draft;
    draft.placeholder = active.placeholder || "";
  }
  panel.querySelector(".nv-preview-input-submit").disabled = paused;
  const cancel = panel.querySelector(".nv-preview-input-cancel");
  cancel.disabled = paused;
  cancel.hidden = !active.canCancel;
  const error = panel.querySelector(".nv-preview-input-error");
  error.hidden = !active.error;
  const message = active.error ? state.engineModule.NOVEL_UI_DEFAULT_MESSAGES[`input.error.${active.error.code}`] : "";
  error.textContent = (message || "").replaceAll("{{limit}}", String(active.error?.limit ?? ""));
  panel.querySelector(".nv-preview-input-status").textContent = paused ? "试玩已暂停；继续后可编辑和提交。" : "草稿尚未写入变量，提交后才生效。";
}

function renderInputPreview(active, paused) {
  const panel = node("div", "nv-preview-choices nv-preview-input");
  panel.dataset.inputKey = inputPreviewKey(active);
  panel.append(node("strong", "nv-preview-input-prompt"));
  const label = node("label", "nv-field");
  const draft = node("input", "nv-input");
  draft.type = active.inputType === "boolean" ? "checkbox" : "text";
  draft.setAttribute("aria-label", active.inputType === "boolean" ? "玩家布尔输入" : "玩家输入草稿");
  if (active.inputType === "number") draft.inputMode = "decimal";
  draft.addEventListener(active.inputType === "boolean" ? "change" : "input", () => {
    try { state.engine.updateInput(active.inputType === "boolean" ? draft.checked : draft.value); }
    catch (error) {
      setNotice(error.message, "error");
      const current = state.snapshot?.active;
      if (current?.kind === "input" && inputPreviewKey(current) === panel.dataset.inputKey) syncInputPreview(panel, current, state.snapshot.paused);
    }
  });
  label.append(node("span", "", active.inputType === "boolean" ? "勾选为“是”，不勾选为“否”" : "输入草稿"), draft);
  panel.append(label);
  const error = node("p", "nv-field-help nv-preview-input-error");
  error.setAttribute("role", "alert");
  panel.append(error, node("p", "nv-field-help nv-preview-input-status"));
  panel.append(button("提交输入", "choice-button nv-preview-input-submit", () => { try { state.engine.submitInput(); } catch (error) { setNotice(error.message, "error"); } }));
  panel.append(button("取消输入", "choice-button nv-preview-input-cancel", () => { try { state.engine.cancelInput(); } catch (error) { setNotice(error.message, "error"); } }));
  syncInputPreview(panel, active, paused);
  return panel;
}

function resolvePreviewCamera(camera) {
  return typeof state.engineModule?.resolveNovelCameraPose === "function"
    ? state.engineModule.resolveNovelCameraPose(camera)
    : { x: 0, y: 0, scale: 1 };
}

function resolvePreviewLayer(camera, parallax) {
  return typeof state.engineModule?.resolveNovelBackgroundLayerPose === "function"
    ? state.engineModule.resolveNovelBackgroundLayerPose(camera, parallax)
    : resolvePreviewCamera(camera);
}

function previewCameraTransform(pose) {
  return `translate(${pose.x}px, ${pose.y}px) scale(${pose.scale})`;
}

function dismissPreviewNote(resumeEngine = false) {
  const dialog = state.noteDialog;
  if (!dialog) return;
  state.noteDialog = null;
  if (dialog.open) dialog.close();
  dialog.remove();
  if (resumeEngine && state.engine) {
    try {
      state.engine.debug.resume();
      state.snapshot = state.engine.getSnapshot();
      renderPreviewNow();
      syncPreviewClock();
    } catch (error) {
      state.runtimeError = error instanceof Error ? error.message : String(error);
      renderPreviewNow();
    }
  }
}

function openPreviewSayLinkNote(event) {
  if (!state.engine || state.noteDialog || event?.type !== "sayLink") return;
  const dialog = node("dialog", "nv-preview-note");
  dialog.setAttribute("aria-label", event.title || "对白注释");
  dialog.append(node("h2", "", event.title));
  const body = node("p", "nv-preview-note-body", event.text);
  body.dataset.sayLinkNote = event.spanId;
  dialog.append(body);
  const actions = node("div", "nv-actions");
  actions.append(button("关闭注释并继续", "primary", () => dialog.close()));
  dialog.append(actions);
  dialog.addEventListener("close", () => {
    if (state.noteDialog !== dialog) { dialog.remove(); return; }
    state.noteDialog = null;
    dialog.remove();
    if (state.engine) {
      try {
        state.engine.debug.resume();
        state.snapshot = state.engine.getSnapshot();
      } catch (error) {
        state.runtimeError = error instanceof Error ? error.message : String(error);
      }
    }
    renderPreviewNow();
    syncPreviewClock();
  }, { once: true });
  state.noteDialog = dialog;
  document.body.append(dialog);
  dialog.showModal();
  try {
    state.engine.debug.pause();
    state.snapshot = state.engine.getSnapshot();
  } catch (error) {
    state.runtimeError = error instanceof Error ? error.message : String(error);
  }
  renderPreviewNow();
  syncPreviewClock();
}

function handlePreviewEvents(events) {
  for (const event of events ?? []) {
    if (event?.type !== "sayLink" || !Number.isSafeInteger(event.sequence) || event.sequence <= state.lastSayLinkSequence) continue;
    state.lastSayLinkSequence = event.sequence;
    openPreviewSayLinkNote(event);
  }
}

function activatePreviewSayLink(spanId, event) {
  event.preventDefault();
  event.stopPropagation();
  if (!state.engine || !state.snapshot || state.snapshot.paused || state.noteDialog || state.contextPreview?.driving) return;
  try {
    const update = state.engine.activateSayLink(spanId);
    handlePreviewEvents(update?.events ?? []);
  } catch (error) {
    state.runtimeError = error instanceof Error ? error.message : String(error);
    renderPreviewNow();
  }
}

function advancePreviewSay(event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!state.engine || !state.snapshot || state.snapshot.paused || state.noteDialog || state.contextPreview?.driving) return;
  try {
    state.engine.advance();
  } catch (error) {
    state.runtimeError = error instanceof Error ? error.message : String(error);
    renderPreviewNow();
  }
}

function appendPreviewSayRun(parent, text, span, fullyRevealed, snapshot) {
  if (!text) return;
  const classes = ["nv-preview-rich-run"];
  if (span.style?.color === "accent") classes.push("accent");
  if (span.style?.color === "muted") classes.push("muted");
  if (span.style?.color === "warning") classes.push("warning");
  const wrapper = span.link
    ? button("", `nv-preview-rich-link ${classes.join(" ")}`, event => activatePreviewSayLink(span.id, event), span.link.title)
    : node("span", classes.join(" "));
  if (span.link) {
    wrapper.dataset.sayLinkId = span.id;
    wrapper.disabled = !fullyRevealed || Boolean(snapshot?.paused) || Boolean(state.noteDialog) || Boolean(state.contextPreview?.driving);
    wrapper.setAttribute("aria-haspopup", "dialog");
    wrapper.setAttribute("aria-label", `${text} · ${span.link.title}`);
  }
  const content = span.ruby && fullyRevealed ? document.createElement("ruby") : document.createElement("span");
  if (span.ruby && fullyRevealed) {
    content.append(document.createTextNode(text));
    content.append(node("rt", "", span.ruby));
  } else content.textContent = text;
  if (span.style?.emphasis === "strong") {
    const strong = document.createElement("strong");
    strong.append(content);
    wrapper.append(strong);
  } else wrapper.append(content);
  parent.append(wrapper);
}

function renderPreviewSayLine(active, snapshot) {
  const line = node("p", "nv-preview-rich-line");
  const visible = Array.from(String(active.visibleText ?? ""));
  const spans = Array.isArray(active.rich?.spans) ? active.rich.spans : [];
  if (!spans.length) {
    line.textContent = visible.join("");
    return line;
  }
  let cursor = 0;
  for (const span of spans) {
    const start = Math.min(visible.length, span.start);
    const end = Math.min(visible.length, span.end);
    if (start > cursor) line.append(document.createTextNode(visible.slice(cursor, start).join("")));
    if (end > start) appendPreviewSayRun(line, visible.slice(start, end).join(""), span, span.end <= visible.length, snapshot);
    cursor = Math.max(cursor, end);
  }
  if (cursor < visible.length) line.append(document.createTextNode(visible.slice(cursor).join("")));
  return line;
}

function contextSnapshotFacts(snapshot) {
  if (!snapshot) return null;
  const active = snapshot.active;
  return {
    location: active?.location ?? snapshot.location,
    phase: snapshot.phase,
    paused: snapshot.paused,
    active: active ? {
      kind: active.kind,
      id: active.id ?? null,
      location: active.location,
      ...(active.kind === "say" ? { complete: active.complete } : {}),
    } : null,
    variables: snapshot.variables,
    meta: snapshot.meta,
    stage: {
      background: snapshot.stage.background,
      backgroundLayers: snapshot.stage.backgroundLayers ?? [],
      characters: snapshot.stage.characters,
      objects: snapshot.stage.objects ?? [],
      camera: snapshot.stage.camera ?? null,
    },
    callStack: snapshot.callStack,
    audioIntents: snapshot.audioIntents,
  };
}

function syncContextPreviewControls(status, continuation, facts, rebuild = byId("novel-preview-context")) {
  const context = state.contextPreview;
  const waiting = context && ["choice", "input", "breakpoint", "limit"].includes(context.status);
  const engineRoot = state.contextPreviewEngineRoot;
  const root = engineRoot?.root ?? context?.root ?? null;
  const rootLocation = engineRoot?.location ?? context?.rootLocation ?? null;
  status.dataset.status = context?.status || "idle";
  status.dataset.targetLocation = context ? `${context.target.label}:${context.target.index}` : "";
  status.dataset.rootKind = root?.kind ?? "";
  status.dataset.rootIdentity = contextPreviewRootIdentity(root);
  status.dataset.rootLocation = rootLocation ? `${rootLocation.label}:${rootLocation.index}` : "";
  const pendingRoot = context?.status === "replaying" && !engineRoot ? context.root : null;
  const pendingLocation = pendingRoot ? context.rootLocation : null;
  status.dataset.pendingRootKind = pendingRoot?.kind ?? "";
  status.dataset.pendingRootIdentity = contextPreviewRootIdentity(pendingRoot);
  status.dataset.pendingRootLocation = pendingLocation ? `${pendingLocation.label}:${pendingLocation.index}` : "";
  const currentRoot = engineRoot
    ? `当前画面仍来自 ${contextPreviewRootDisplay(engineRoot.root, engineRoot.location, state.executionTraceStory)}；所选入口只影响下一次重建。`
    : "尚未重建上下文。";
  status.textContent = context?.message || currentRoot;
  continuation.hidden = !waiting;
  continuation.disabled = !state.engine;
  if (rebuild) rebuild.disabled = context?.status === "replaying";
  facts.hidden = !context || ["error", "replaying"].includes(context.status);
  const view = contextSnapshotFacts(state.snapshot);
  facts.textContent = context && !facts.hidden && view ? JSON.stringify(view, null, 2) : "";
}

function observeContextBlocker(snapshot) {
  const context = state.contextPreview;
  if (!context || context.driving || context.resolved || !["choice", "input"].includes(context.status)) return;
  const active = snapshot.active;
  if (active?.kind === context.status && active.location?.label === context.blockedAt?.label && active.location?.index === context.blockedAt?.index) return;
  context.resolved = true;
  context.message = `${context.status === "choice" ? "选择" : "输入"}已提交；点击“继续重建上下文”沿真实剧情继续。`;
}

function renderLiveView(view) {
  const snapshot = state.snapshot;
  const existingInput = view.querySelector(".nv-preview-input");
  if (snapshot?.active?.kind === "input" && existingInput?.dataset.inputKey === inputPreviewKey(snapshot.active)) {
    // Retain the actual DOM field through engine updates so an in-progress
    // composition and selection survive. The engine remains the draft owner.
    syncInputPreview(existingInput, snapshot.active, snapshot.paused);
    return;
  }
  view.previewResizeObserver?.disconnect();
  view.replaceChildren();
  const stage = node("div", "nv-stage-preview");
  const background = snapshot?.stage?.background ?? (state.contextPreviewEngineRoot ? null : Object.keys(state.assets.backgrounds)[0] ?? null);
  const composition = snapshot?.stage ?? { characters: {} };
  const camera = composition.camera;
  const fullPose = resolvePreviewCamera(camera);
  if (background && state.assets.backgrounds[background]) {
    const image = node("img", "nv-stage-background");
    image.src = resourceUrl("background", background);
    image.alt = `背景：${background}`;
    image.draggable = false;
    image.style.transform = previewCameraTransform(fullPose);
    image.style.transformOrigin = "0 0";
    image.dataset.backgroundRole = "base";
    image.dataset.background = background;
    image.addEventListener("error", () => { image.hidden = true; }, { once: true });
    stage.append(image);
    stage.append(node("span", "nv-stage-bg", `背景 · ${background}`));
    if (snapshot?.stage?.background) stage.append(currentStageSourceControl(state.stageSourceFacts.background, background, "background", "nv-preview-source-background"));
  } else {
    stage.append(node("span", "nv-stage-bg", background ? `缺少背景资源 · ${background}` : "背景未设置"));
    if (snapshot?.stage?.background) stage.append(currentStageSourceControl(state.stageSourceFacts.background, background, "background", "nv-preview-source-background"));
  }
  for (const [layerIndex, layer] of (composition.backgroundLayers ?? []).entries()) {
    const source = state.assets.backgrounds[layer.background];
    if (!source) continue;
    const image = node("img", "nv-stage-background nv-stage-background-layer");
    image.src = resourceUrl("background", layer.background);
    image.alt = `背景叠加层 ${layerIndex + 1}：${layer.background}`;
    image.draggable = false;
    image.style.zIndex = String(layerIndex + 1);
    image.style.transform = previewCameraTransform(resolvePreviewLayer(camera, layer.parallax));
    image.style.transformOrigin = "0 0";
    image.dataset.backgroundRole = "layer";
    image.dataset.layerIndex = String(layerIndex);
    image.dataset.background = layer.background;
    image.dataset.parallax = String(layer.parallax);
    image.addEventListener("error", () => { image.hidden = true; }, { once: true });
    stage.append(image);
    const layerSource = currentStageSourceControl(state.stageSourceFacts.layers[layerIndex], layer.background, "layer", "nv-preview-source-layer");
    layerSource.style.top = `${2.35 + layerIndex * 1.8}rem`;
    layerSource.dataset.backgroundLayer = String(layerIndex);
    stage.append(layerSource);
  }
  const cast = node("div", "nv-stage-cast");
  cast.style.transform = previewCameraTransform(fullPose);
  cast.style.transformOrigin = "0 0";
  cast.dataset.cameraX = String(fullPose.x);
  cast.dataset.cameraY = String(fullPose.y);
  cast.dataset.cameraScale = String(fullPose.scale);
  const stageItems = state.engineModule?.orderedNovelStageItems?.(composition)
    ?? [
      ...Object.keys(composition.characters ?? {}).filter(id => composition.characters[id]?.visible !== false).map(id => ({ kind: "character", id })),
      ...(composition.objects ?? []).map(object => ({ kind: "object", id: object.id })),
    ];
  const active = snapshot?.active;
  const canInteractWithObjects = active?.kind === "say" && !snapshot?.paused;
  if (!stageItems.length) cast.append(node("span", "nv-stage-empty", "角色和场景对象将在场景事件中进入"));
  for (const reference of stageItems) {
    if (reference.kind === "object") {
      const object = (composition.objects ?? []).find(value => value.id === reference.id);
      const geometry = object && state.engineModule?.resolveNovelSceneObjectGeometry?.(object, 360, 640);
      if (!object || !geometry) continue;
      const item = node("div", "nv-stage-object");
      const frame = geometry.frame;
      Object.assign(item.style, {
        left: `${frame.x / 360 * 100}%`, top: `${frame.y / 640 * 100}%`,
        width: `${frame.width / 360 * 100}%`, height: `${frame.height / 640 * 100}%`,
        zIndex: String(object.layer ?? 0),
      });
      item.dataset.sceneObjectId = object.id;
      item.dataset.image = object.image;
      item.dataset.frame = JSON.stringify(object.frame);
      item.dataset.crop = JSON.stringify(object.crop ?? null);
      item.dataset.hit = JSON.stringify(object.interaction?.hit ?? { x: 0, y: 0, w: 1, h: 1 });
      item.dataset.layer = String(object.layer ?? 0);
      const image = node("img", "nv-stage-object-image");
      image.src = resourceUrl("background", object.image);
      image.alt = `场景对象：${object.id}`;
      image.draggable = false;
      Object.assign(image.style, {
        left: `${geometry.image.x / frame.width * 100}%`, top: `${geometry.image.y / frame.height * 100}%`,
        width: `${geometry.image.width / frame.width * 100}%`, height: `${geometry.image.height / frame.height * 100}%`,
      });
      image.addEventListener("error", () => { image.hidden = true; }, { once: true });
      item.append(image);
      const objectSource = currentStageSourceControl(state.stageSourceFacts.objects?.get(object.id), object.image, "object", "nv-preview-source-object");
      item.append(objectSource);
      if (object.interaction) {
        const hit = geometry.hit;
        const interaction = node("button", "nv-stage-object-hit", object.interaction.label);
        interaction.type = "button";
        Object.assign(interaction.style, {
          left: `${hit.x / frame.width * 100}%`, top: `${hit.y / frame.height * 100}%`,
          width: `${hit.width / frame.width * 100}%`, height: `${hit.height / frame.height * 100}%`,
        });
        const conditionMatches = state.engineModule?.isNovelSceneObjectInteractive?.(object, snapshot?.variables ?? {}) === true;
        interaction.disabled = !canInteractWithObjects || !conditionMatches || typeof state.engine?.interactSceneObject !== "function";
        interaction.dataset.sceneObjectHit = object.id;
        interaction.dataset.interactive = String(!interaction.disabled);
        interaction.setAttribute("aria-label", object.interaction.label);
        interaction.addEventListener("click", () => {
          if (interaction.disabled) return;
          try { state.engine.interactSceneObject(object.id); }
          catch (error) { state.runtimeError = error instanceof Error ? error.message : String(error); renderPreviewNow(); }
        });
        item.append(interaction);
      }
      cast.append(item);
      continue;
    }

    const character = composition.characters?.[reference.id];
    if (!character || character.visible === false) continue;
    const item = node("div", "nv-stage-character");
    const placement = state.engineModule?.resolveNovelCharacterPlacement?.(character);
    if (!placement) continue;
    Object.assign(item.style, { left: `${placement.x / 360 * 100}%`, top: `${placement.y / 640 * 100}%`, width: `${placement.width / 360 * 100}%`, height: `${placement.height / 640 * 100}%`, transform: `rotate(${placement.rotation}deg) scale(${placement.scale})`, transformOrigin: "0 0", zIndex: String(placement.layer) });
    if (typeof character.position === "string") item.dataset.position = character.position;
    else {
      item.dataset.position = "custom";
      item.dataset.coordinates = `${character.position.x}, ${character.position.y}`;
    }
    item.dataset.previewCharacter = character.id;
    const variants = state.assets.characters[character.id];
    const imageKey = variants?.[character.expression] ? character.expression : variants?.neutral ? "neutral" : undefined;
    if (imageKey) {
      const characterImage = node("img", "nv-stage-character-image");
      characterImage.src = resourceUrl("character", character.id, imageKey);
      characterImage.alt = `${character.id} · ${character.expression}`;
      characterImage.draggable = false;
      characterImage.addEventListener("error", () => { characterImage.hidden = true; }, { once: true });
      item.append(characterImage);
    } else item.append(node("span", "nv-stage-character-missing", `缺少立绘 · ${character.id}.${character.expression}`));
    item.append(node("strong", "nv-character-label", character.id), node("span", "nv-character-expression", `${character.expression}${character.position && typeof character.position === "object" ? ` · ${item.dataset.coordinates}` : ""}`));
    item.append(currentStageSourceControl(state.stageSourceFacts.characters.get(character.id), character.id, "character", "nv-preview-source-character"));
    cast.append(item);
  }
  stage.append(cast);
  if (active?.kind === "say") {
    const dialogue = node("div", "nv-preview-dialogue");
    const source = previewSourceEntry(active.location, "say");
    dialogue.append(node("span", "nv-preview-speaker", active.speaker || "旁白"), renderPreviewSayLine(active, snapshot));
    const pause = active.pause;
    const status = pause
      ? pause.remainingMs === null ? "手动停顿 · 继续操作会释放此标记" : `定时停顿 · 剩余 ${Math.ceil(pause.remainingMs / 1000)} 秒`
      : active.complete ? "单步继续" : `${active.revealedCharacters ?? 0} 字已显示`;
    dialogue.append(node("span", "nv-field-help", status));
    if (pause?.remainingMs === null) {
      const release = button("释放手动停顿", "quiet nv-preview-say-advance", advancePreviewSay);
      release.dataset.sayPauseRelease = pause.id;
      release.disabled = Boolean(snapshot.paused) || Boolean(state.noteDialog) || Boolean(state.contextPreview?.driving);
      dialogue.append(release);
    }
    if (active.rich) dialogue.append(node("span", "nv-field-help nv-preview-rich-disclaimer", "富文本在浏览器中按 DOM inline 布局预览；Guest/Core 的行盒与换行以实际运行结果为准。"));
    dialogue.append(previewSourceControl(source, "dialogue"));
    stage.append(dialogue);
  } else if (active?.kind === "choice") {
    const choices = node("div", "nv-preview-choices");
    choices.append(node("strong", "", active.prompt || "请选择"));
    for (const choice of active.options || []) {
      const choiceButton = button(choice.text, "choice-button", () => { state.engine?.selectChoice(choice.id); renderPreviewNow(); });
      choiceButton.disabled = Boolean(snapshot.paused);
      choices.append(choiceButton);
    }
    stage.append(choices);
  } else if (active?.kind === "input") {
    stage.append(renderInputPreview(active, snapshot.paused));
  } else if (active?.kind === "wait") {
    stage.append(node("div", "nv-preview-dialogue", `等待 ${Math.ceil((active.remainingMs ?? 0) / 1000)} 秒 · 单步可继续`));
  } else if (active?.kind === "ending") {
    const ending = node("div", "nv-preview-ending");
    ending.append(node("strong", "", active.id), node("p", "", active.text || "故事结束"));
    if (active.cg && state.assets.cgs[active.cg]) {
      const cg = node("img", "nv-preview-cg");
      cg.src = resourceUrl("cg", active.cg);
      cg.alt = state.assets.cgs[active.cg].title || active.cg;
      cg.addEventListener("error", () => { cg.hidden = true; }, { once: true });
      ending.append(cg);
    }
    ending.append(previewSourceControl(previewSourceEntry(active.location, "ending"), "ending"));
    stage.append(ending);
  } else if (!snapshot) {
    stage.append(node("div", "nv-preview-dialogue", state.runtimeError || "点击“运行 / 重新开始”启动当前故事。"));
  } else {
    stage.append(node("div", "nv-preview-dialogue", `运行阶段：${snapshot.phase}`));
  }
  view.append(stage);
  const resize = () => {
    const { width, height } = stage.getBoundingClientRect();
    const layout = state.engineModule?.createNovelViewportLayout?.({ width, height }, { top: 0, right: 0, bottom: 0, left: 0 });
    if (!layout) return;
    for (const item of cast.querySelectorAll("[data-preview-character]")) {
      const character = composition.characters[item.dataset.previewCharacter];
      const placement = state.engineModule.resolveNovelCharacterPlacement(character);
      const bounds = state.engineModule.novelCharacterBounds(character.position, placement, width, layout.artScale);
      Object.assign(item.style, { left: `${bounds.insetL}px`, top: `${bounds.insetT}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    }
  };
  resize();
  view.previewResizeObserver = new ResizeObserver(resize);
  view.previewResizeObserver.observe(stage);
}

function resourceUrl(kind, key, expression) {
  const params = new URLSearchParams({ project: projectId, kind, key });
  if (expression) params.set("expression", expression);
  return `/novel/resource?${params.toString()}`;
}

function novelNeedsClock(snapshot) {
  if (!state.engine || !snapshot || !snapshot.started || snapshot.paused || snapshot.phase === "disposed" || state.contextPreview) return false;
  if (snapshot.stage?.transition && snapshot.stage.transition.kind !== "cut" && snapshot.stage.transition.durationMs > snapshot.stage.transition.elapsedMs) return true;
  const cameraMotion = snapshot.stage?.camera?.motion;
  if (cameraMotion && cameraMotion.elapsedMs < cameraMotion.durationMs) return true;
  if (snapshot.stage?.timeline) return true;
  const active = snapshot.active;
  if (active?.kind === "say") {
    if (active.pause) return active.pause.remainingMs !== null;
    if (!active.complete) return true;
    return snapshot.preferences.mode !== "manual" && active.autoRemainingMs !== null;
  }
  if (active?.kind === "wait") return active.remainingMs > 0;
  if (active?.kind === "choice") return active.timeRemainingMs !== null && active.timeRemainingMs > 0;
  return false;
}

function stopPreviewClock() {
  if (state.clockFrameId) cancelAnimationFrame(state.clockFrameId);
  state.clockFrameId = 0;
  state.clockLastTime = 0;
}

function syncPreviewClock() {
  if (!novelNeedsClock(state.snapshot)) {
    stopPreviewClock();
    return;
  }
  if (!state.clockFrameId) state.clockFrameId = requestAnimationFrame(tickPreviewFrame);
}

function tickPreviewFrame(now) {
  state.clockFrameId = 0;
  if (!novelNeedsClock(state.snapshot)) { stopPreviewClock(); return; }
  const delta = state.clockLastTime ? Math.max(0, Math.min(100, now - state.clockLastTime)) : 0;
  state.clockLastTime = now;
  try {
    state.engine.tick(delta);
    state.snapshot = state.engine.getSnapshot();
    renderPreviewNow();
  } catch (error) {
    state.runtimeError = error.message;
    state.engine.debug.pause();
    state.snapshot = state.engine.getSnapshot();
    renderPreviewNow();
  }
  syncPreviewClock();
}

function renderPreviewNow() {
  const advance = byId("novel-preview-advance");
  if (advance) advance.disabled = !state.snapshot || state.snapshot.paused || state.snapshot.active?.kind !== "say" || Boolean(state.noteDialog);
  const view = byId("novel-live-view");
  if (view) renderLiveView(view);
  const variables = byId("novel-variables");
  if (variables) variables.textContent = JSON.stringify(state.snapshot?.variables ?? {}, null, 2);
  const audioFacts = byId("novel-audio-facts");
  if (audioFacts) audioFacts.textContent = JSON.stringify(state.snapshot?.audioIntents ?? {}, null, 2);
  const audioSummary = byId("novel-audio-event-summary");
  if (audioSummary) audioSummary.textContent = state.audioEvents.length ? `最近一步产生 ${state.audioEvents.length} 个音频请求。运行时会交给已注册的 Pocket 音频能力。` : "此刻没有新的音频请求。";
  const toggle = byId("novel-preview-pause");
  if (toggle) {
    const waitingFor = contextPreviewWaitingForInteraction() ? state.snapshot.active.kind : "";
    toggle.disabled = Boolean(waitingFor) || Boolean(state.noteDialog);
    toggle.textContent = waitingFor ? waitingFor === "choice" ? "等待选择" : "等待输入" : state.snapshot?.paused ? "继续" : "暂停";
  }
  const step = byId("novel-preview-step");
  if (step) step.disabled = Boolean(state.noteDialog) || ["choice", "input", "breakpoint", "limit"].includes(state.contextPreview?.status) || state.contextPreview && ["choice", "input"].includes(state.snapshot?.active?.kind);
  const location = state.snapshot?.active?.location ?? state.snapshot?.location;
  const line = byId("novel-preview-location");
  if (line) line.textContent = location ? `${location.label}:${location.index}` : "尚未启动";
  const contextStatus = byId("novel-context-preview-status");
  const contextContinue = byId("novel-context-preview-continue");
  const contextFacts = byId("novel-context-preview-facts");
  if (contextStatus && contextContinue && contextFacts) syncContextPreviewControls(contextStatus, contextContinue, contextFacts, byId("novel-preview-context"));
}

const DIALOGUE_TABLE_PAGE_SIZE = 25;

const INSTRUCTION_TABLE_FIELDS = {
  say: [
    { key: "speaker", label: "说话人" },
    { key: "text", label: "对白文本", kind: "multiline" },
    { key: "voice", label: "语音 Cue", optional: true },
    { key: "portrait", label: "表情/肖像键", optional: true },
    { key: "presentation", label: "对白呈现", kind: "select", optional: true, choices: [["dialogue", "普通对白"], ["fullscreen", "全屏段落"], ["floating", "浮动文字"]] },
  ],
  scene: [
    { key: "background", label: "背景键" },
    { key: "transition", label: "转场 JSON", kind: "json", optional: true },
    { key: "characters", label: "角色 JSON", kind: "json", optional: true },
    { key: "backgroundLayers", label: "背景叠加层 JSON", kind: "json", optional: true },
    { key: "camera", label: "镜头 JSON", kind: "json", optional: true },
    { key: "cameraMotion", label: "镜头过渡 JSON", kind: "json", optional: true },
  ],
  audio: [
    { key: "cue", label: "音频 cue" },
    { key: "action", label: "动作", kind: "select", choices: [["play", "播放"], ["stop", "停止"]] },
    { key: "channel", label: "声道" },
    { key: "group", label: "混音分组", kind: "select", choices: AUDIO_GROUP_CHOICES },
    { key: "loop", label: "循环播放", kind: "boolean", optional: true },
  ],
  video: [
    { key: "action", label: "视频动作", readOnly: true },
    { key: "cue", label: "稳定视频 cue", optional: true },
    { key: "loop", label: "循环播放", kind: "boolean", optional: true },
    { key: "positionMs", label: "定位毫秒", kind: "optionalNumber", optional: true, min: 0, step: 1, integer: true },
  ],
  wait: [{ key: "durationMs", label: "等待时长 ms", kind: "number", min: 0, step: "any" }],
  input: [
    { key: "variable", label: "写入变量" },
    { key: "inputType", label: "输入类型", readOnly: true },
    { key: "prompt", label: "输入提示", kind: "multiline" },
    { key: "placeholder", label: "输入占位提示", optional: true },
    { key: "defaultValue", label: "默认值 JSON", kind: "json", optional: true },
    { key: "minLength", label: "最少字符数", kind: "optionalNumber", optional: true },
    { key: "maxLength", label: "最多字符数", kind: "optionalNumber", optional: true },
    { key: "min", label: "数值下限", kind: "optionalNumber", optional: true },
    { key: "max", label: "数值上限", kind: "optionalNumber", optional: true },
    { key: "integer", label: "仅允许整数", kind: "boolean", optional: true },
    { key: "cancelTarget", label: "输入取消目标", kind: "target", optional: true },
  ],
  set: [
    { key: "variable", label: "变量" },
    { key: "value", label: "值", kind: "json" },
  ],
  inc: [
    { key: "variable", label: "变量" },
    { key: "amount", label: "增量", kind: "number", step: "any" },
  ],
  trade: [
    { key: "item", label: "交易条目" },
    { key: "action", label: "交易动作", kind: "select", choices: [["buy", "购买"], ["sell", "出售"], ["consume", "消耗"]] },
    { key: "quantity", label: "交易数量", kind: "number", min: 1, step: 1, safeInteger: true },
    { key: "onFailure", label: "失败时跳转", kind: "target" },
  ],
  branch: [
    { key: "when", label: "条件 JSON", kind: "json" },
    { key: "then", label: "条件为真时", kind: "target" },
    { key: "else", label: "条件为假时", kind: "target" },
  ],
  jump: [{ key: "target", label: "目标", kind: "target" }],
  call: [{ key: "target", label: "目标", kind: "target" }],
  choice: [
    { key: "prompt", label: "选择提示" },
    { key: "options", label: "选项 JSON", kind: "json" },
    { key: "timeLimitMs", label: "限时 ms", kind: "optionalNumber", optional: true },
    { key: "timeoutTarget", label: "超时目标", kind: "target", optional: true },
  ],
  ending: [
    { key: "text", label: "结局文本", kind: "multiline" },
    { key: "cg", label: "CG 键", optional: true },
  ],
  return: [],
};

function instructionTableSourceRows() {
  const rows = [];
  for (const [label, instructions] of Object.entries(state.story?.script ?? {})) {
    if (!Array.isArray(instructions)) continue;
    instructions.forEach((instruction, index) => {
      rows.push({ label, index, instruction });
    });
  }
  return rows;
}

function instructionTableSearchText(instruction) {
  if (!instruction || typeof instruction !== "object") return String(instruction ?? "");
  return Object.entries(instruction).flatMap(([key, value]) => {
    let text = value;
    if (value && typeof value === "object") {
      try { text = JSON.stringify(value); } catch { text = ""; }
    }
    return [key, text];
  }).join(" ").toLocaleLowerCase();
}

function instructionTableTargetChoices(value) {
  const names = labels();
  const choices = [["", "未设置"]];
  if (value && !names.includes(value)) choices.push([value, `缺少：${value}`]);
  for (const name of names) choices.push([name, name]);
  return choices;
}

function instructionTableOpenStory(row) {
  state.panel = "story";
  state.selectedLabel = row.label;
  rerenderWorkspace();
  requestAnimationFrame(() => {
    const instruction = byId("novel-instruction-list")?.children?.[row.index];
    instruction?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  });
}

function renderInstructionTableFields(parent, row) {
  const { label, index, instruction } = row;
  const location = `${label}:${index}`;
  const fields = INSTRUCTION_TABLE_FIELDS[instruction?.type];
  if (!fields) {
    const summary = node("div", "nv-instruction-table-unknown");
    summary.append(node("span", "nv-field-help", "此指令类型不在当前表格支持列表中；原始数据保持只读。"));
    let source = "";
    try { source = JSON.stringify(instruction, null, 2) ?? String(instruction); } catch { source = String(instruction); }
    summary.append(node("pre", "", source.length > 600 ? `${source.slice(0, 600)}…` : source));
    parent.append(summary, button("在故事编辑器中打开完整表单", "quiet", () => instructionTableOpenStory(row)));
    return;
  }

  const editors = node("div", "nv-instruction-table-fields");
  let groupField;
  for (const spec of fields) {
    if (spec.optional && !Object.hasOwn(instruction, spec.key)) continue;
    const historyKey = `instruction-table:${location}:${spec.key}`;
    const ariaLabel = `${spec.label} ${location}`;
    const assign = value => {
      if (instruction?.type === "audio" && spec.key === "action" && value === "stop") {
        instruction.action = value;
        delete instruction.group;
        if (groupField) groupField.value = "";
      } else if (instruction?.type === "audio" && spec.key === "channel" && !value) {
        delete instruction.channel;
        delete instruction.group;
        if (groupField) groupField.value = "";
      } else if (instruction?.type === "audio" && spec.key === "group") {
        if (value) instruction.group = value;
        else delete instruction.group;
      } else if (value === undefined && spec.optional) delete instruction[spec.key];
      else if (spec.key === "background" && value === "") instruction[spec.key] = null;
      else instruction[spec.key] = value;
    };
    let input;
    if (spec.kind === "json") {
      input = jsonField(editors, ariaLabel, instruction[spec.key], value => assign(value), {
        historyScope: "story", historyKey, className: "nv-dialogue-table-field nv-instruction-table-field",
      });
    } else if (spec.kind === "boolean") {
      input = checkbox(editors, ariaLabel, instruction[spec.key], value => assign(value), { historyScope: "story", historyKey });
    } else {
      const choices = spec.readOnly ? undefined : spec.kind === "target" ? instructionTableTargetChoices(instruction[spec.key]) : spec.choices?.map(choice => [...choice]);
      if (choices && instruction[spec.key] != null && !choices.some(([value]) => value === String(instruction[spec.key]))) {
        choices.unshift([String(instruction[spec.key]), `未知值：${String(instruction[spec.key])}`]);
      }
      const kind = spec.kind || "text";
      const type = kind === "number" || kind === "optionalNumber" ? "number" : undefined;
      input = field(editors, ariaLabel, instruction[spec.key], assign, {
        historyScope: "story", historyKey, className: "nv-dialogue-table-field nv-instruction-table-field",
        ...(kind === "multiline" ? { multiline: true } : {}),
        ...(choices ? { select: choices } : {}),
        ...(type ? {
          type,
          ...(kind === "optionalNumber" ? { optional: true } : {}),
          ...(spec.min !== undefined ? { min: spec.min } : {}),
          ...(spec.max !== undefined ? { max: spec.max } : {}),
          ...(spec.step !== undefined ? { step: spec.step } : {}),
          ...(spec.integer ? { integer: true } : {}),
          ...(spec.safeInteger ? { safeInteger: true } : {}),
        } : {}),
        ...(spec.readOnly ? { readOnly: true, history: false } : {}),
      });
    }
    if (instruction?.type === "audio" && spec.key === "group") groupField = input;
    input.dataset.instructionField = spec.key;
    input.dataset.instructionLocation = location;
    if (spec.kind === "multiline" || spec.kind === "json") input.rows = spec.kind === "json" ? 5 : 2;
  }
  if (instruction?.type === "return") editors.append(node("span", "nv-field-help", "返回到最近一次调用此标签的位置。"));
  if (!fields.length && instruction?.type !== "return") editors.append(node("span", "nv-field-help", "此指令没有可在表格中编辑的常用字段。"));
  parent.append(editors, button("在故事编辑器中打开完整表单", "quiet", () => instructionTableOpenStory(row)));
}

function renderDialogueTableBody(body, summary, pageStatus, previous, next) {
  const mode = state.dialogueTableScope === "all" ? "all" : "dialogue";
  const sourceRows = instructionTableSourceRows().filter(({ instruction }) => mode === "all" || instruction?.type === "say");
  const query = state.dialogueTableQuery.trim().toLocaleLowerCase();
  const rows = sourceRows.filter(({ label, index, instruction }) => {
    const location = `${label}:${index}`;
    return !query || [
      label, location, instruction?.type, instruction?.id, instruction?.speaker, instruction?.text,
      ...(mode === "all" ? [instructionTableSearchText(instruction)] : []),
    ].some(value => String(value ?? "").toLocaleLowerCase().includes(query));
  });
  const pageCount = Math.max(1, Math.ceil(rows.length / DIALOGUE_TABLE_PAGE_SIZE));
  state.dialogueTablePage = Math.min(Math.max(0, state.dialogueTablePage), pageCount - 1);
  const start = state.dialogueTablePage * DIALOGUE_TABLE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + DIALOGUE_TABLE_PAGE_SIZE);
  body.replaceChildren();
  const table = byId("novel-dialogue-table-grid");
  const headerRow = table?.querySelector("thead tr");
  const headings = mode === "all" ? ["原位置（标签:index）", "类型", "稳定 ID", "指令字段"] : ["原位置（标签:index）", "稳定对白 ID", "说话人", "对白文本"];
  headerRow?.replaceChildren(...headings.map(label => node("th", "", label)));
  if (table) {
    table.setAttribute("aria-label", mode === "all" ? "全部指令" : "全部对白");
    table.classList.toggle("nv-instruction-table", mode === "all");
  }
  const title = byId("novel-dialogue-table-title");
  if (title) title.textContent = mode === "all" ? "全部指令" : "对白表格";
  const description = byId("novel-dialogue-table-description");
  if (description) description.textContent = mode === "all"
    ? "编辑所有标签中的已知指令；复杂结构使用安全 JSON，完整表单可在故事编辑器中打开。"
    : "直接编辑所有标签中的对白；标签与原指令位置只读，其他指令和自定义字段保留在原位。";

  for (const row of pageRows) {
    const location = `${row.label}:${row.index}`;
    const tr = node("tr", mode === "all" ? "nv-dialogue-row nv-instruction-table-row" : "nv-dialogue-row");
    if (mode === "all") tr.dataset.instructionRow = location;
    else tr.dataset.dialogueRow = location;
    const locationCell = node("td", "nv-dialogue-location-cell");
    locationCell.append(node("code", "nv-dialogue-location", location));
    tr.append(locationCell);

    if (mode === "all") {
      const typeCell = node("td", "nv-instruction-type-cell");
      typeCell.append(node("code", "nv-instruction-type", typeof row.instruction?.type === "string" ? row.instruction.type : "未知指令"));
      const idCell = node("td", "nv-instruction-id-cell");
      idCell.append(node("code", "nv-instruction-id", row.instruction && typeof row.instruction === "object" && row.instruction.id != null ? row.instruction.id : "—"));
      const fieldsCell = node("td", "nv-instruction-fields-cell");
      renderInstructionTableFields(fieldsCell, row);
      tr.append(typeCell, idCell, fieldsCell);
      body.append(tr);
      continue;
    }

    const appendField = (key, caption, value, multiline = false, readOnly = false) => {
      const cell = node("td", `nv-dialogue-cell nv-dialogue-cell-${key}`);
      const input = field(cell, `${caption} ${location}`, value, nextValue => {
        row.instruction[key] = nextValue;
      }, {
        historyScope: "story",
        historyKey: `dialogue-table:${location}:${key}`,
        multiline,
          readOnly,
        className: "nv-dialogue-table-field",
      });
      input.dataset.dialogueField = key;
      input.dataset.dialogueLocation = location;
      if (multiline) input.rows = 2;
      tr.append(cell);
    };
    appendField("id", "稳定对白 ID", row.instruction.id, false, true);
    appendField("speaker", "说话人", row.instruction.speaker ?? "");
    appendField("text", "对白文本", row.instruction.text, true);
    body.append(tr);
  }

  if (pageRows.length === 0) {
    const empty = node("tr", "nv-dialogue-empty-row");
    const noun = mode === "all" ? "指令" : "对白";
    const cell = node("td", "nv-empty", rows.length ? `此页没有${noun}。` : `没有匹配的${noun}。请调整筛选条件。`);
    cell.colSpan = 4;
    empty.append(cell);
    body.append(empty);
  }
  summary.textContent = mode === "all"
    ? query ? `筛选到 ${rows.length} 条指令，共 ${sourceRows.length} 条。` : `共 ${rows.length} 条指令。`
    : query ? `筛选到 ${rows.length} 句对白，共 ${sourceRows.length} 句。` : `共 ${rows.length} 句对白。`;
  pageStatus.textContent = `第 ${state.dialogueTablePage + 1} / ${pageCount} 页 · 每页最多 ${DIALOGUE_TABLE_PAGE_SIZE} ${mode === "all" ? "条" : "句"}`;
  previous.disabled = state.dialogueTablePage === 0;
  next.disabled = state.dialogueTablePage + 1 >= pageCount;
}

function renderDialogueTable() {
  const section = node("section", "nv-dialogue-table-panel");
  section.id = "novel-dialogue-table";
  const heading = node("div", "nv-panel-heading");
  const headingCopy = node("div", "");
  const title = node("h1", "", "对白表格");
  title.id = "novel-dialogue-table-title";
  const description = node("p", "", "直接编辑所有标签中的对白；标签与原指令位置只读，其他指令和自定义字段保留在原位。");
  description.id = "novel-dialogue-table-description";
  headingCopy.append(title, description);
  heading.append(headingCopy);
  section.append(heading);

  const tools = node("div", "nv-dialogue-table-tools");
  const scopeField = node("label", "nv-dialogue-scope-field");
  scopeField.append(node("span", "", "指令范围"));
  const scopeSelect = node("select", "nv-input");
  scopeSelect.setAttribute("aria-label", "指令范围");
  option(scopeSelect, "dialogue", "仅对白");
  option(scopeSelect, "all", "全部指令");
  scopeSelect.value = state.dialogueTableScope === "all" ? "all" : "dialogue";
  scopeField.append(scopeSelect);
  const queryField = node("label", "nv-dialogue-search-field");
  const queryCaption = node("span", "", scopeSelect.value === "all" ? "筛选指令" : "筛选对白");
  queryCaption.id = "novel-dialogue-filter-caption";
  queryField.append(queryCaption);
  const query = node("input", "nv-input");
  query.type = "search";
  query.setAttribute("aria-label", scopeSelect.value === "all" ? "筛选指令" : "筛选对白");
  query.placeholder = scopeSelect.value === "all" ? "标签、原位置、类型、ID 或字段内容" : "标签、稳定 ID、说话人或文本";
  query.value = state.dialogueTableQuery;
  queryField.append(query);
  const summary = node("span", "nv-dialogue-table-summary");
  const apply = button("筛选", "secondary", () => {
    state.dialogueTableQuery = query.value.trim();
    state.dialogueTablePage = 0;
    renderDialogueTableBody(body, summary, pageStatus, previous, next);
  });
  apply.id = "novel-dialogue-filter";
  query.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); apply.click(); }
  });
  const clear = button("清除", "quiet", () => {
    query.value = "";
    state.dialogueTableQuery = "";
    state.dialogueTablePage = 0;
    renderDialogueTableBody(body, summary, pageStatus, previous, next);
  });
  scopeSelect.addEventListener("change", () => {
    state.dialogueTableScope = scopeSelect.value === "all" ? "all" : "dialogue";
    state.dialogueTableQuery = query.value.trim();
    state.dialogueTablePage = 0;
    const all = state.dialogueTableScope === "all";
    queryCaption.textContent = all ? "筛选指令" : "筛选对白";
    query.setAttribute("aria-label", all ? "筛选指令" : "筛选对白");
    query.placeholder = all ? "标签、原位置、类型、ID 或字段内容" : "标签、稳定 ID、说话人或文本";
    renderDialogueTableBody(body, summary, pageStatus, previous, next);
  });
  tools.append(scopeField, queryField, apply, clear, summary);
  section.append(tools);

  const scroll = node("div", "nv-dialogue-table-scroll");
  const table = node("table", "nv-dialogue-table");
  table.id = "novel-dialogue-table-grid";
  table.setAttribute("aria-label", "全部对白");
  const head = node("thead");
  const headerRow = node("tr");
  for (const label of ["原位置（标签:index）", "稳定对白 ID", "说话人", "对白文本"]) headerRow.append(node("th", "", label));
  head.append(headerRow);
  const body = node("tbody");
  body.id = "novel-dialogue-table-body";
  table.append(head, body);
  scroll.append(table);
  section.append(scroll);

  const footer = node("div", "nv-dialogue-table-footer");
  const pageStatus = node("span", "nv-dialogue-table-page-status");
  pageStatus.id = "novel-dialogue-table-page-status";
  const previous = button("上一页", "quiet", () => {
    state.dialogueTablePage = Math.max(0, state.dialogueTablePage - 1);
    renderDialogueTableBody(body, summary, pageStatus, previous, next);
  });
  previous.id = "novel-dialogue-previous";
  const next = button("下一页", "quiet", () => {
    state.dialogueTablePage += 1;
    renderDialogueTableBody(body, summary, pageStatus, previous, next);
  });
  next.id = "novel-dialogue-next";
  footer.append(pageStatus, previous, next);
  section.append(footer);
  renderDialogueTableBody(body, summary, pageStatus, previous, next);
  return section;
}

function renderWorkspace() {
  if (timelinePointerDrag) finishTimelinePointerDrag(false);
  if (!root || !state.story) return;
  graphResizeObserver?.disconnect();
  graphResizeObserver = null;
  if (graphMeasureFrame) cancelAnimationFrame(graphMeasureFrame);
  graphMeasureFrame = 0;
  if (graphDrag) graphDrag.handle.classList.remove("is-dragging");
  graphDrag = null;
  graphPan = null;
  graphConnection = null;
  try { state.workspaceDispose?.(); } catch {}
  state.workspaceDispose = null;
  disposeModelPreview();
  if (standalonePreview) {
    const header = node("header", "nv-preview-page-header");
    header.append(node("strong", "", "独立试玩"));
    const back = node("a", "nv-button quiet", "返回编辑器");
    const target = new URL(window.location.href); target.searchParams.delete("view");
    back.href = target.href;
    header.append(back);
    root.replaceChildren(header);
  } else {
    root.replaceChildren(renderTopbar());
    root.append(renderToolbar());
  }
  const notice = node("div", "nv-notice");
  notice.id = "novel-notice";
  notice.hidden = true;
  root.append(notice);
  if (state.panel === "story") {
    const layout = node("div", "nv-story-layout");
    layout.append(renderLabelRail(), renderLabelEditor());
    const diagnostics = node("aside", "nv-diagnostics");
    diagnostics.id = "novel-diagnostics";
    layout.append(diagnostics);
    root.append(layout);
    renderDiagnostics(localValidation());
  } else if (state.panel === "dialogueTable") {
    root.append(renderDialogueTable());
  } else if (state.panel === "assets") {
    root.append(renderAssetPanel());
  } else if (state.panel === "preview") {
    root.append(renderPreviewPanel());
    renderPreviewNow();
  } else if (state.panel === "variables") {
    root.append(renderVariableDefinitions());
  } else if (state.panel === "inventory") {
    root.append(renderInventory());
  } else if (state.panel === "replays") {
    root.append(renderReplayEntries());
  } else if (state.panel === "timelines") {
    root.append(renderTimelinePanel());
  } else if (workspacePanels[state.panel]) {
    if (state.panel === "stage") renderStageSelection(root);
    const panel = node("section", `nv-${state.panel}-panel-host`);
    panel.id = `novel-${state.panel}-panel`;
    root.append(panel);
    void mountWorkspacePanel(panel, state.panel);
  } else {
    root.append(renderGraph());
    const diagnostics = node("aside", "nv-diagnostics nv-graph-diagnostics");
    diagnostics.id = "novel-diagnostics";
    root.append(diagnostics);
    renderDiagnostics(localValidation());
  }
  if (state.dirty && !state.notice) {
    setNotice("更改尚未保存。试玩和 Guest 构建仍使用上一次已保存的项目数据。", "warning");
  } else if (state.notice) {
    setNotice(state.notice.message, state.notice.kind);
  }
  // A completed save response replaces its document. Keep editing paused
  // during that request so it cannot overwrite new keystrokes or mutations.
  for (const child of [...root.children].slice(1)) child.inert = state.saving;
  updateHistoryButtons();
  updateHistoryStatus();
}

function rerenderWorkspace() {
  renderWorkspace();
}

async function refreshDiagnostics() {
  try {
    const result = await api(`${base}/diagnostics`);
    state.validation = result.validation;
    renderDiagnostics(localValidation());
  } catch (error) {
    setNotice(`读取剧情诊断失败：${error.message}`, "error");
  }
}

async function saveStory() {
  if (timelinePointerDrag) finishTimelinePointerDrag(false);
  if (!state.story || state.saving || state.historyBusy || state.historyBlocked) return;
  if (document.querySelector('[aria-invalid="true"]')) {
    setNotice("请先修复红色字段中的 JSON 或数字格式。", "error");
    return;
  }
  state.saving = true;
  renderWorkspace();
  let sourceChanged = false;
  try {
    if (!await checkHistoryContext()) return;
    if (state.storyDirty) {
      const result = await api(`${base}/story`, { method: "PUT", body: JSON.stringify(state.story) });
      state.story = result.story;
      state.validation = result.validation;
      state.storyDirty = false;
      if (!sourceChanged) scheduleHistory();
      sourceChanged = true;
    }
    if (state.assetsDirty) {
      const result = await api(`${base}/assets`, { method: "PUT", body: JSON.stringify(state.assets) });
      state.assets = normalizeAssetRegistry(result.assets);
      state.assetDiagnostics = result.diagnostics ?? [];
      if (result.validation) state.validation = result.validation;
      state.assetsDirty = false;
      if (!sourceChanged) scheduleHistory();
      sourceChanged = true;
    }
    state.dirty = state.storyDirty || state.assetsDirty;
    if (!state.historyBlocked && !state.historyError) setNotice("已保存至项目 story.json 与 novel.assets.json。", "success");
  } catch (error) {
    if (error.payload?.validation) state.validation = error.payload.validation;
    if (error.payload?.diagnostics) state.assetDiagnostics = error.payload.diagnostics;
    setNotice(`保存失败：${error.message}`, "error");
  } finally {
    // A story write can succeed before an assets write fails. Anchor recovery
    // to the files we actually wrote so fixing the remaining draft still works.
    if (sourceChanged && state.historyReady && !state.historyBlocked) {
      try {
        const context = await api(`${base}/history?head=1`);
        if (context.historyRevision !== state.historyRevision) blockHistory();
        else {
          state.historyToken = context.sourceToken;
          await persistHistory(true);
        }
      } catch (error) {
        blockHistory(`项目源码已写入，但无法核对历史上下文：${error.message}。请重新打开项目；当前草稿仍可导出。`);
      }
    }
    state.dirty = state.storyDirty || state.assetsDirty;
    state.saving = false;
    renderWorkspace();
  }
}

async function exportStoryFile() {
  try {
    const format = state.interchangeFormat;
    if (format === "json") { downloadJSON(`${state.story.id}-story.json`, state.story); return; }
    if (format === "docx") {
      const filename = `${state.story.id}-story.docx`;
      const document = await api(`${base}/export?format=docx`, { method: "POST", body: JSON.stringify(state.story), responseType: "blob" });
      downloadText(filename, document, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      return;
    }
    await loadRuntime();
    const isCsv = format === "csv" || format === "table-csv";
    const content = format === "table-csv" ? state.engineModule.formatStoryTableCsv(state.story)
      : format === "csv" ? state.engineModule.formatStoryCsv(state.story)
      : state.engineModule.formatStoryMarkdown(state.story);
    downloadText(`${state.story.id}-story${format === "table-csv" ? "-table" : ""}.${isCsv ? "csv" : "md"}`, content, isCsv ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8");
  } catch (error) { setNotice(`导出失败：${error.message}`, "error"); }
}

async function importManuscriptFile(file) {
  try {
    if (state.saving || state.historyBlocked || state.historyBusy) throw new Error("正在核对编辑历史或保存，请完成后再导入。");
    if (file.size > 2 * 1024 * 1024) throw new Error("手稿文件超过 2 MiB。");
    const sourceStory = state.story;
    const sourceGeneration = state.historyGeneration;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    await loadRuntime();
    if (state.story !== sourceStory || state.historyGeneration !== sourceGeneration || state.historyBusy) throw new Error("读取文件期间草稿已改变或正在核对历史，请重新导入。");
    let chapter = "manuscript";
    for (let ordinal = 2; Object.hasOwn(sourceStory.script, chapter); ordinal++) chapter = `manuscript_${ordinal}`;
    const allInstructions = Object.values(sourceStory.script).flat();
    const result = state.engineModule.parseNovelManuscript(text, {
      idPrefix: chapter,
      speakerNames: allInstructions.filter(item => item.type === "say" && item.speaker).map(item => item.speaker),
      existingLineIds: allInstructions.filter(item => typeof item.id === "string").map(item => item.id),
    });
    if (!result.instructions) throw new Error(result.diagnostics.map(item => `第 ${item.line} 行：${item.message}`).join("\n"));

    const dialog = node("dialog", "nv-manuscript-dialog");
    dialog.setAttribute("aria-label", "手稿导入预览");
    dialog.append(node("h2", "", "手稿导入预览"));
    dialog.append(node("p", "nv-field-help", `${file.name} · ${result.instructions.length} 句。每个非空行生成一句；【姓名】对白或已知说话人的“姓名：对白”会提取说话人。其余文字保留为旁白。`));
    const chapterField = node("label", "nv-field");
    chapterField.append(node("span", "nv-field-label", "新章节标签"));
    const chapterInput = node("input", "nv-input");
    chapterInput.setAttribute("aria-label", "新章节标签");
    chapterInput.value = chapter;
    chapterField.append(chapterInput);
    dialog.append(chapterField);
    const startField = node("label", "nv-field");
    const startInput = node("input");
    startInput.type = "checkbox";
    startInput.setAttribute("aria-label", "将导入章节设为故事起点");
    startField.append(startInput, document.createTextNode("将导入章节设为故事起点"));
    dialog.append(startField);
    dialog.append(node("p", "nv-field-help", "只新增章节，不覆盖已有标签。不会自动生成分支、转场或结局；加入后可继续编辑。{{变量}}沿用引擎现有的变量插值规则。保存前不会写入项目。"));
    const preview = node("textarea", "nv-input nv-textarea");
    preview.readOnly = true;
    preview.setAttribute("aria-label", "手稿转换预览");
    preview.value = result.instructions.map((line, index) => `${result.sourceLines[index]} · ${line.speaker ? `【${line.speaker}】` : "旁白 · "}${line.text}`).join("\n");
    preview.rows = 12;
    dialog.append(preview);
    if (result.diagnostics.length) dialog.append(node("pre", "nv-field-help", result.diagnostics.map(item => `第 ${item.line} 行：${item.message}`).join("\n")));
    const status = node("p", "nv-notice");
    status.setAttribute("role", "status");
    dialog.append(status);
    const actions = node("div", "nv-actions");
    actions.append(button("取消", "quiet", () => dialog.close()));
    actions.append(button("加入草稿", "primary", () => {
      try {
        if (state.story !== sourceStory || state.historyGeneration !== sourceGeneration || state.saving || state.historyBlocked || state.historyBusy) throw new Error("草稿已改变、正在核对历史或保存，请重新导入。");
        const label = chapterInput.value.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(label) || ["__proto__", "constructor", "prototype"].includes(label)) throw new Error("章节标签须为 1–80 位字母、数字、下划线、点或连字符，且不能以数字开头。");
        if (Object.hasOwn(state.story.script, label)) throw new Error("该章节标签已存在；不会覆盖原章节。");
        const next = { ...state.story, start: startInput.checked ? label : state.story.start, script: { ...state.story.script, [label]: result.instructions } };
        state.engineModule.formatStoryText(next);
        historyMutation("story", "story:manuscript-import", () => {
          state.story = next;
          state.selectedLabel = label;
          state.panel = "story";
        });
        state.validation = null;
        dialog.close();
        rerenderWorkspace();
        setNotice(`已将 ${result.instructions.length} 句加入新章节 ${label}；可撤销，保存后才写入项目。`, "success");
      } catch (error) { status.textContent = error.message; }
    }));
    dialog.append(actions);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    chapterInput.focus();
  } catch (error) { setNotice(`手稿导入失败：${error.message}`, "error"); }
}

async function importStoryFile(file) {
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error("导入文件超过 8 MiB。 ");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    let parsed;
    if (["csv", "md", "markdown"].includes(extension)) {
      await loadRuntime();
      const result = extension === "csv" ? state.engineModule.parseStoryCsv(text) : state.engineModule.parseStoryMarkdown(text);
      if (!result.story) throw new Error(result.diagnostics.map(item => item.message).join("\n") || "交换文件无效。");
      parsed = result.story;
    } else parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string" || typeof parsed.start !== "string" || !parsed.script || typeof parsed.script !== "object") {
      throw new Error("文件不是 StoryDefinition。");
    }
    // Reuse the authoring boundary before replacing the live draft. JSON
    // must have the same renderable document shape as CSV/Markdown imports.
    await loadRuntime();
    state.engineModule.formatStoryText(parsed);
    const before = captureEditable("story");
    invalidateStageSourceFacts();
    invalidateContextPreview();
    state.story = parsed;
    state.selectedLabel = Object.keys(parsed.script)[0] || "";
    state.storyDirty = true;
    state.dirty = true;
    recordHistory("story", "story:import", before);
    state.validation = null;
    rerenderWorkspace();
    setNotice("剧本已导入编辑器草稿；点击保存才会写入项目 story.json。", "success");
  } catch (error) { setNotice(`导入失败：${error.message}`, "error"); }
}

async function importAssetFile(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const expected = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      parsed.backgrounds && typeof parsed.backgrounds === "object" && !Array.isArray(parsed.backgrounds) &&
      parsed.characters && typeof parsed.characters === "object" && !Array.isArray(parsed.characters) &&
      parsed.cgs && typeof parsed.cgs === "object" && !Array.isArray(parsed.cgs) &&
      parsed.audio && typeof parsed.audio === "object" && !Array.isArray(parsed.audio) &&
      (parsed.videos === undefined || parsed.videos && typeof parsed.videos === "object" && !Array.isArray(parsed.videos)) &&
      (parsed.atmospheres === undefined || parsed.atmospheres && typeof parsed.atmospheres === "object" && !Array.isArray(parsed.atmospheres));
    if (!expected) throw new Error("JSON 文件不是 Pocket VN novel.assets.json 注册表。");
    const before = captureEditable("assets");
    state.assets = normalizeAssetRegistry(parsed);
    state.assetsDirty = true;
    state.dirty = true;
    recordHistory("assets", "assets:import", before);
    state.assetDiagnostics = [];
    rerenderWorkspace();
    setNotice("资源 JSON 已导入草稿；点击保存才会写入项目 novel.assets.json。", "success");
  } catch (error) { setNotice(`资源导入失败：${error.message}`, "error"); }
}

async function buildGuest() {
  if (state.dirty) { setNotice("请先保存 story.json，再构建。", "warning"); return; }
  if (state.building) return;
  state.building = true;
  rerenderWorkspace();
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/build`, { method: "POST", body: "{}" });
    for (let attempts = 0; attempts < 240; attempts++) {
      const result = await api(`/api/projects/${encodeURIComponent(projectId)}/status`);
      state.buildStatus = result;
      if (!result.busy) {
        if (result.error) throw new Error(result.error);
        if (result.builtRevision !== result.revision) throw new Error("构建完成但 bytecode revision 与 story.json 不一致。");
        setNotice("Pocket Guest 已构建完成，可以运行最新故事。", "success");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Guest 构建超时。");
  } catch (error) { setNotice(`构建失败：${error.message}`, "error"); }
  finally { state.building = false; rerenderWorkspace(); }
}

async function loadRuntime() {
  if (state.engineModule) return state.engineModule;
  const runtimeUrl = `${base}/runtime.js`;
  state.engineModule = await import(runtimeUrl);
  if (typeof state.engineModule.createNovelEngine !== "function") throw new Error("Novel core bundle does not export createNovelEngine().");
  return state.engineModule;
}

function disposeEngine() {
  dismissPreviewNote(false);
  stopPreviewClock();
  state.lastSayLinkSequence = 0;
  state.engineUnsubscribe?.();
  state.engineUnsubscribe = null;
  state.executionTraceUnsubscribe?.();
  state.executionTraceUnsubscribe = null;
  state.engine?.dispose?.();
  state.engine = null;
  state.snapshot = null;
  state.audioEvents = [];
  state.executionTrace = [];
  state.executionTraceSequence = 0;
  state.executionTraceStory = null;
  state.stageSourceFacts = createStageSourceFacts();
  state.contextPreview = null;
  state.contextPreviewEngineRoot = null;
}

function adoptPreviewEngine(engine, sourceStory, traceCapture = null, contextRoot = null) {
  disposeEngine();
  state.engine = engine;
  state.contextPreviewEngineRoot = contextRoot
    ? { root: contextRoot.root, location: { ...contextRoot.location } }
    : null;
  state.executionTraceStory = traceCapture?.executionTraceStory ?? structuredClone(sourceStory);
  if (traceCapture) {
    state.executionTrace = traceCapture.executionTrace;
    state.executionTraceSequence = traceCapture.executionTraceSequence;
    state.stageSourceFacts = traceCapture.stageSourceFacts;
  }
  state.executionTraceUnsubscribe = engine.debug.subscribeExecutionTrace(entries => appendExecutionTrace(entries));
  state.engineUnsubscribe = engine.subscribe(update => {
    state.snapshot = update.snapshot;
    state.audioEvents = update.events.filter(event => event.type === "audioCue");
    handlePreviewEvents(update.events);
    observeContextBlocker(update.snapshot);
    if (state.contextPreview?.driving) return;
    renderPreviewNow();
    syncPreviewClock();
  }, { emitCurrent: true });
  syncExecutionTraceView({ reset: true });
}

async function restartPreview() {
  state.runtimeError = "";
  disposeEngine();
  renderWorkspace();
  try {
    const module = await loadRuntime();
    const previewStory = structuredClone(state.story);
    adoptPreviewEngine(module.createNovelEngine(previewStory), previewStory);
    state.engine.start();
    state.engine.debug.pause();
    state.snapshot = state.engine.getSnapshot();
    await applyBreakpoints();
    renderPreviewNow();
    syncPreviewClock();
  } catch (error) {
    state.runtimeError = error.message;
    state.engineModule = null;
    renderWorkspace();
  }
}

function contextPreviewState(result, target) {
  const location = result.snapshot.active?.location ?? result.snapshot.location;
  const locationText = location ? `${location.label}:${location.index}` : "未知位置";
  const rootIdentity = result.root ?? state.contextPreviewEngineRoot?.root ?? null;
  const rootLocation = result.rootLocation ?? state.contextPreviewEngineRoot?.location ?? null;
  const root = contextPreviewRootDisplay(rootIdentity, rootLocation, state.executionTraceStory);
  const provenance = { root: rootIdentity, rootLocation: rootLocation ? { ...rootLocation } : null };
  const steps = result.steps;
  if (result.status === "blocked") {
    const blocker = result.blocker || "breakpoint";
    const labels = { choice: "等待玩家选择", input: "等待玩家输入", breakpoint: "在作者断点暂停" };
    return {
      ...provenance, target: { ...target }, status: blocker, blocker, blockedAt: location,
      steps,
      message: `${root} · ${labels[blocker] || "执行暂停"} · ${locationText}。完成操作后继续重建上下文；本轮自动执行 ${steps} 条指令。`,
    };
  }
  if (result.status === "reached") {
    const pauseText = result.blocker === "breakpoint" ? ` 随后在 ${locationText} 的作者断点暂停。` : "";
    return { ...provenance, target: { ...target }, status: "reached", steps, message: `已从 ${root} 独立执行并到达 ${target.label}:${target.index}。${pauseText}本轮自动执行 ${steps} 条指令。` };
  }
  if (result.status === "ended") {
    return { ...provenance, target: { ...target }, status: "ended", steps, message: `从 ${root} 执行的故事在到达 ${target.label}:${target.index} 前结束（${locationText}）；本轮自动执行 ${steps} 条指令。` };
  }
  return { ...provenance, target: { ...target }, status: "limit", steps, message: `从 ${root} 重建至 ${locationText} 时达到本轮执行上限；本轮自动执行 ${steps} 条指令。可继续重建。` };
}

function installExecutionTraceCapture(capture) {
  state.executionTraceStory = capture.executionTraceStory;
  state.executionTrace = capture.executionTrace;
  state.executionTraceSequence = capture.executionTraceSequence;
  state.stageSourceFacts = capture.stageSourceFacts;
  syncExecutionTraceView();
}

function pauseContextUnlessWaiting(engine) {
  const snapshot = engine.getSnapshot();
  if (!snapshot.paused && !["choice", "input"].includes(snapshot.active?.kind)) engine.debug.pause();
  return engine.getSnapshot();
}

async function reconstructPreviewContext(label, index, rootOption) {
  if (!state.story || !Number.isSafeInteger(index) || index < 0 || !Array.isArray(state.story.script[label]) || index > state.story.script[label].length) {
    setNotice("上下文目标超出标签指令范围。", "error");
    return;
  }
  if (!rootOption || rootOption.value !== state.contextPreviewRootValue) {
    setNotice("请选择一个仍然有效的上下文重建起点。", "error");
    return;
  }
  if (state.contextPreview?.status === "replaying") return;
  const sourceReference = state.story;
  const sourceGeneration = state.historyGeneration;
  const previewStory = structuredClone(sourceReference);
  const target = { label, index };
  const pendingRoot = rootOption.root;
  const pendingRootLocation = { ...rootOption.location };
  const rootText = contextPreviewRootDisplay(pendingRoot, pendingRootLocation, previewStory);
  const pendingContext = { target, root: pendingRoot, rootLocation: pendingRootLocation, status: "replaying", message: `正在从 ${rootText} 重建至 ${label}:${index}…` };
  state.contextPreview = pendingContext;
  syncPreviewClock();
  renderPreviewNow();
  let candidateEngine = null;
  let adopted = false;
  try {
    const module = await loadRuntime();
    if (state.story !== sourceReference || state.historyGeneration !== sourceGeneration || state.contextPreview !== pendingContext || state.contextPreviewRootValue !== rootOption.value) {
      throw new Error("草稿、起点选择或断点设置在重建期间发生变化；本次上下文未采用。");
    }
    if (typeof module.createNovelContextPreview !== "function") throw new Error("Novel core bundle does not export createNovelContextPreview().");
    const traceCapture = createExecutionTraceCapture(previewStory);
    const result = module.createNovelContextPreview(previewStory, target, {
      root: pendingRoot,
      breakpoints: authoredBreakpointPositions(),
      onExecutionTrace: entries => appendExecutionTrace(entries, traceCapture),
    });
    candidateEngine = result.engine;
    const settledResult = { ...result, snapshot: pauseContextUnlessWaiting(result.engine) };
    adoptPreviewEngine(candidateEngine, previewStory, traceCapture, { root: result.root, location: result.rootLocation });
    adopted = true;
    state.snapshot = settledResult.snapshot;
    state.contextPreview = contextPreviewState(settledResult, target);
    state.runtimeError = "";
    clearInvalidContextTargetNotice();
    renderPreviewNow();
    syncPreviewClock();
  } catch (error) {
    if (candidateEngine && !adopted) candidateEngine.dispose?.();
    if (state.contextPreview !== pendingContext) return;
    state.contextPreview = { ...pendingContext, status: "error", message: `无法从 ${rootText} 重建至 ${label}:${index} 的上下文：${error.message}` };
    renderPreviewNow();
    syncPreviewClock();
  }
}

function continuePreviewContext() {
  const previous = state.contextPreview;
  if (!state.engine || !previous || !["choice", "input", "breakpoint", "limit"].includes(previous.status)) return;
  const module = state.engineModule;
  if (typeof module?.continueNovelContextPreview !== "function") {
    state.contextPreview = { ...previous, status: "error", message: "Novel core bundle does not export continueNovelContextPreview()." };
    renderPreviewNow();
    return;
  }
  const capture = createExecutionTraceCapture(state.executionTraceStory, state);
  state.contextPreview = { ...previous, status: "replaying", driving: true, message: `沿真实剧情继续至 ${previous.target.label}:${previous.target.index}…` };
  syncPreviewClock();
  let result;
  try {
    result = module.continueNovelContextPreview(state.engine, previous.target, {
      onExecutionTrace: entries => appendExecutionTrace(entries, capture),
    });
    installExecutionTraceCapture(capture);
    const settledResult = { ...result, snapshot: pauseContextUnlessWaiting(state.engine) };
    state.snapshot = settledResult.snapshot;
    state.contextPreview = contextPreviewState(settledResult, previous.target);
    clearInvalidContextTargetNotice();
  } catch (error) {
    installExecutionTraceCapture(capture);
    state.snapshot = state.engine.getSnapshot();
    state.snapshot = pauseContextUnlessWaiting(state.engine);
    void applyBreakpoints();
    state.contextPreview = { ...previous, status: "error", driving: false, message: `继续重建时发生错误：${error.message}。已保留引擎最后一次提交状态。` };
  }
  renderPreviewNow();
  syncPreviewClock();
}

async function togglePreviewPause() {
  if (!state.engine) { setNotice("请先启动当前故事。", "warning"); return; }
  if (state.noteDialog) return;
  if (state.contextPreview && ["choice", "input"].includes(state.snapshot?.active?.kind)) return;
  if (state.contextPreview) invalidateContextPreview("", { pause: false });
  try {
    if (state.snapshot?.paused) state.engine.debug.resume();
    else state.engine.debug.pause();
    state.snapshot = state.engine.getSnapshot();
    renderPreviewNow();
    syncPreviewClock();
  } catch (error) { state.runtimeError = error.message; renderWorkspace(); }
}

async function stepPreview() {
  if (!state.engine) { await restartPreview(); return; }
  if (state.noteDialog) return;
  if (state.contextPreview && ["choice", "input"].includes(state.snapshot?.active?.kind)) return;
  if (state.contextPreview) invalidateContextPreview("", { pause: false });
  try {
    state.engine.debug.pause();
    await state.engine.debug.step();
    state.snapshot = state.engine.getSnapshot();
    renderPreviewNow();
    syncPreviewClock();
  } catch (error) { state.runtimeError = error.message; renderWorkspace(); }
}

async function jumpPreview(label, index) {
  if (!state.engine) { setNotice("请先启动当前故事。", "warning"); return; }
  if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(state.story.script[label]) || index > state.story.script[label].length) {
    setNotice("跳转位置超出标签指令范围。", "error");
    return;
  }
  if (state.contextPreview) invalidateContextPreview("", { pause: false });
  invalidateStageSourceFacts();
  try {
    state.engine.debug.pause();
    state.engine.debug.jump({ label, index });
    state.snapshot = state.engine.getSnapshot();
    renderPreviewNow();
    syncPreviewClock();
  } catch (error) { state.runtimeError = error.message; renderWorkspace(); }
}

async function applyBreakpoints() {
  if (!state.engine) return;
  try { state.engine.debug.setBreakpoints(authoredBreakpointPositions()); }
  catch (error) { state.runtimeError = error.message; }
}

function authoredBreakpointPositions() {
  return [...state.breakpoints].map(key => {
    const separator = key.lastIndexOf(":");
    return { label: key.slice(0, separator), index: Number(key.slice(separator + 1)) };
  });
}

async function loadProject() {
  try {
    const [health, result, assetResult] = await Promise.all([
      fetch("/health").then(response => response.json()),
      api(`${base}/story`),
      api(`${base}/assets`),
      loadRuntime(),
    ]);
    state.csrf = health.csrfToken || "";
    state.story = result.story;
    state.assets = normalizeAssetRegistry(assetResult.assets);
    state.assetDiagnostics = assetResult.diagnostics ?? [];
    state.validation = assetResult.validation ?? result.validation;
    state.selectedLabel = result.story.start;
    if (!Object.hasOwn(state.story.script, state.selectedLabel)) state.selectedLabel = Object.keys(state.story.script)[0] || "";
    const projectStatus = await api(`/api/projects/${encodeURIComponent(projectId)}/status`).catch(() => null);
    state.buildStatus = projectStatus;
    if (!standalonePreview) await hydrateHistory();
    renderWorkspace();
    if (standalonePreview) {
      await restartPreview();
      state.engine?.debug.resume();
      state.snapshot = state.engine?.getSnapshot();
      renderPreviewNow();
      syncPreviewClock();
    }
  } catch (error) {
    root?.replaceChildren(node("div", "nv-fatal", `无法打开可编辑 story.json：${error.message}`));
  }
}

window.addEventListener("beforeunload", event => {
  if (!state.dirty && !state.authoringDraft) return;
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("keydown", event => {
  if (event.key === "Escape" && timelinePointerDrag) {
    event.preventDefault();
    finishTimelinePointerDrag(false);
    return;
  }
  if (event.key === "Escape" && graphDrag) {
    event.preventDefault();
    cancelGraphNodeDrag();
    return;
  }
  if (event.key === "Escape" && graphConnection) {
    event.preventDefault();
    cancelGraphConnection();
    return;
  }
  if (event.key === "Escape" && graphPan) {
    event.preventDefault();
    finishGraphPan(byId("novel-graph-canvas"));
    return;
  }
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "z" && event.shiftKey || key === "y") {
    event.preventDefault();
    redoEdit();
  } else if (key === "z") {
    event.preventDefault();
    undoEdit();
  }
});

void loadProject();
