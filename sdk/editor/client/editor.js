const $ = (id) => document.getElementById(id);

const POLL_DELAY_MS = 1200;
const MAX_BUILD_POLL_ATTEMPTS = 300;
const MAX_DEPLOY_POLL_ATTEMPTS = 300;
const MAX_WECHAT_POLL_ATTEMPTS = 300;
const WECHAT_STATES = new Set(["idle", "building", "running", "error", "stopped"]);
const VIEWPORTS = {
  // The mobile dimensions are filled from the runner's device profile before
  // projects are loaded. Keep no second device definition in the editor.
  mobile: { width: 0, height: 0, label: "Mobile", safeArea: null },
  tablet: { width: 768, height: 1023, label: "Tablet", safeArea: null },
  desktop: { width: 1023, height: 768, label: "Desktop", safeArea: null },
};

const projectsEl = $("projects");
const projectSwitcher = $("project-switcher");
const sourceEl = $("source");
const noticeEl = $("notice");
const logEl = $("log");
const createDialog = $("create-dialog");
const previewFrame = $("preview-frame");
const previewStage = $("preview-stage");
const previewStageWrap = $("preview-stage-wrap") || document.querySelector(".preview-stage-wrap");
const previewSurfaces = $("preview-surfaces");
const previewPhoneShell = $("preview-phone-shell");
const wechatPreviewPane = $("wechat-preview-pane");
const wechatPreviewShell = $("wechat-preview-shell");
const wechatPreviewFrame = $("wechat-preview-frame");
const wechatPreviewEmpty = $("wechat-preview-empty");

let projects = [];
let currentId = null;
let currentStatus = null;
let currentFile = "app.tsx";
let projectFiles = [];
let buildPollTimer = null;
let deployPollTimer = null;
let startingBuild = false;
let dirty = false;
let saving = false;
let publishing = false;
let csrfToken = "";
let previewPath = "";
let previewReady = false;
let previewHasFrame = false;
let previewStarted = false;
let previewRevision = null;
let previewGeneration = null;
let previewRegionsEnabled = false;
let captureSequence = 0;
const captureWaiters = new Map();
const PREVIEW_HEIGHT_STORAGE_KEY = "pocket.editor.previewPaneHeight";
const PREVIEW_BEZEL_STORAGE_KEY = "pocket.editor.previewShowBezel";
const NOBLE_BLUETOOTH_STORAGE_KEY = "pocket.editor.webBluetooth";
let nobleBluetoothSupported = false;
let localBluetoothAvailable = false;
let bluetoothProvider = "local";
let webBluetoothEnabled = false;
try { webBluetoothEnabled = localStorage.getItem(NOBLE_BLUETOOTH_STORAGE_KEY) === "1"; } catch {}
let previewDeviceProfile = null;
let previewDevicePromise = null;
let devices = [];
let activeDeploy = null;
let startingDeploy = false;
let wechatState = { state: "idle", url: "", error: "", logs: [] };
let wechatPollTimer = null;
let wechatGeneration = 0;
let startingWechat = false;
let stoppingWechat = false;
let resourceInventory = null;
let resourcePackageId = "";
let resourceDraft = new Map();
let resourcesDirty = false;
let resourcesLoading = false;
let resourcesSaving = false;
let resourcesGeneration = 0;
let versionSnapshot = null;
let versionsLoading = false;
let versionsGeneration = 0;
let publishTargets = null;
let publishTargetsLoading = false;
let publishTargetsError = "";
let publishTargetsGeneration = 0;
let publishTargetChannel = "test";
let publishTargetContext = null;
let studioUpgradeState = null;
let studioUpgradePollTimer = null;
let studioUpgradePeriodicTimer = null;
let studioUpgradePendingReloadVersion = null;
let studioUpgradeDeferredAutoApply = false;
const STUDIO_UPGRADE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function storedPreviewPaneHeight() {
  try {
    const value = Number(localStorage.getItem(PREVIEW_HEIGHT_STORAGE_KEY));
    return Number.isFinite(value) && value >= 240 && value <= 1200 ? value : null;
  } catch {
    return null;
  }
}

let previewPaneHeight = storedPreviewPaneHeight();

function storedPreviewBezel() {
  try {
    return localStorage.getItem(PREVIEW_BEZEL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let previewBezelEnabled = storedPreviewBezel();

function normalizeError(error) {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

function localizedMessage(error) {
  const message = normalizeError(error).message;
  const replacements = [
    ["Preview device profile is unavailable.", "预览设备配置不可用。"],
    ["Preview device profile is missing safeArea.", "预览设备配置缺少安全区信息。"],
    ["Preview device profile is missing shell geometry.", "预览设备配置缺少设备外壳尺寸。"],
    ["Preview device profile has inconsistent safeArea.bottom.", "预览设备配置的底部安全区不一致。"],
    ["Preview capture must be a PNG, JPEG, or WebP image.", "预览截图必须是 PNG、JPEG 或 WebP 图片。"],
    ["Refresh the preview before capturing it.", "请先刷新预览，再截取截图。"],
    ["The preview did not return a screenshot. Refresh it and try again.", "预览没有返回截图，请刷新后重试。"],
    ["Clipboard access is unavailable in this browser.", "此浏览器不支持剪贴板访问。"],
    ["No project selected.", "尚未选择项目。"],
    ["No diagnostics yet.", "暂无诊断信息。"],
    ["The native preview reported an error.", "原生预览报告了错误。"],
    ["The project preview could not be loaded.", "项目预览无法加载。"],
    ["WeChat validation timed out.", "微信验证超时。"],
    ["Resource inventory is unavailable.", "资源清单不可用。"],
    ["Editor backend is outdated. Restart the Editor server and reload this page.", "编辑器后端版本过旧，请重启编辑器服务并刷新页面。"],
  ];
  for (const [source, target] of replacements) if (message === source) return target;
  return message;
}

async function api(path, options = {}) {
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = {
    ...(options.body && !isForm ? { "content-type": "application/json" } : {}),
    "x-pocket-editor": "1",
    ...(csrfToken ? { "x-pocket-csrf": csrfToken } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(path, { ...options, headers });
  const type = response.headers.get("content-type") || "";
  let value;
  try {
    value = type.includes("application/json") ? await response.json() : await response.text();
  } catch {
    value = "";
  }
  if (!response.ok) {
    const message = value && typeof value === "object" ? value.error : value;
    const error = new Error(message || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.payload = value;
    throw error;
  }
  return value;
}

function requiredProfileNumber(value, field, { min = 0, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new Error(`Preview device profile has an invalid ${field}.`);
  }
  return parsed;
}

function normalizePreviewDeviceProfile(payload) {
  const profile = payload && typeof payload === "object" && payload.device && typeof payload.device === "object"
    ? payload.device
    : payload;
  if (!profile || typeof profile !== "object") throw new Error("Preview device profile is unavailable.");
  const safe = profile.safeArea;
  const shell = profile.shell;
  if (!safe || typeof safe !== "object") throw new Error("Preview device profile is missing safeArea.");
  if (!shell || typeof shell !== "object") throw new Error("Preview device profile is missing shell geometry.");
  const normalized = {
    ...profile,
    model: typeof profile.model === "string" && profile.model ? profile.model : "Mobile",
    screenWidth: requiredProfileNumber(profile.screenWidth, "screenWidth", { min: 1, integer: true }),
    screenHeight: requiredProfileNumber(profile.screenHeight, "screenHeight", { min: 1, integer: true }),
    pixelRatio: requiredProfileNumber(profile.pixelRatio, "pixelRatio", { min: 1 }),
    statusBarHeight: requiredProfileNumber(profile.statusBarHeight, "statusBarHeight", { min: 0, integer: true }),
    safeAreaBottom: requiredProfileNumber(profile.safeAreaBottom, "safeAreaBottom", { min: 0, integer: true }),
    safeArea: {
      top: requiredProfileNumber(safe.top, "safeArea.top", { min: 0, integer: true }),
      right: requiredProfileNumber(safe.right, "safeArea.right", { min: 0, integer: true }),
      bottom: requiredProfileNumber(safe.bottom, "safeArea.bottom", { min: 0, integer: true }),
      left: requiredProfileNumber(safe.left, "safeArea.left", { min: 0, integer: true }),
    },
    shell: {
      bezel: requiredProfileNumber(shell.bezel, "shell.bezel", { min: 0 }),
      borderRadius: requiredProfileNumber(shell.borderRadius, "shell.borderRadius", { min: 0 }),
      notchWidth: requiredProfileNumber(shell.notchWidth, "shell.notchWidth", { min: 0 }),
      notchHeight: requiredProfileNumber(shell.notchHeight, "shell.notchHeight", { min: 0 }),
      homeIndicatorWidth: requiredProfileNumber(shell.homeIndicatorWidth, "shell.homeIndicatorWidth", { min: 0 }),
      homeIndicatorHeight: requiredProfileNumber(shell.homeIndicatorHeight, "shell.homeIndicatorHeight", { min: 0 }),
      homeIndicatorBottom: requiredProfileNumber(shell.homeIndicatorBottom, "shell.homeIndicatorBottom", { min: 0 }),
    },
  };
  if (normalized.safeArea.bottom !== normalized.safeAreaBottom) {
    throw new Error("Preview device profile has inconsistent safeArea.bottom.");
  }
  return normalized;
}

function applyPreviewDeviceProfile(profile) {
  previewDeviceProfile = profile;
  VIEWPORTS.mobile = {
    ...VIEWPORTS.mobile,
    width: profile.screenWidth,
    height: profile.screenHeight,
    label: profile.model,
    safeArea: { ...profile.safeArea },
  };
  const mobileOption = $("viewport-picker")?.querySelector('option[value="mobile"]');
  if (mobileOption) mobileOption.textContent = `${profile.model} · ${profile.screenWidth} × ${profile.screenHeight}`;
  if (previewStage) {
    previewStage.style.setProperty("--preview-phone-width", `${profile.screenWidth}px`);
    previewStage.style.setProperty("--preview-phone-height", `${profile.screenHeight}px`);
    previewStage.style.setProperty("--preview-phone-radius", `${profile.shell.borderRadius}px`);
    previewStage.style.setProperty("--preview-phone-bezel", `${profile.shell.bezel}px`);
    previewStage.style.setProperty("--preview-phone-notch-width", `${profile.shell.notchWidth}px`);
    previewStage.style.setProperty("--preview-phone-notch-height", `${profile.shell.notchHeight}px`);
    previewStage.style.setProperty("--preview-phone-statusbar-height", `${profile.statusBarHeight}px`);
    previewStage.style.setProperty("--preview-phone-home-width", `${profile.shell.homeIndicatorWidth}px`);
    previewStage.style.setProperty("--preview-phone-home-height", `${profile.shell.homeIndicatorHeight}px`);
    previewStage.style.setProperty("--preview-phone-home-bottom", `${profile.shell.homeIndicatorBottom}px`);
  }
  if (wechatPreviewFrame) wechatPreviewFrame.style.setProperty("--wechat-device-radius", `${profile.shell.borderRadius}px`);
  setText("preview-device-label", `${profile.model} · ${profile.screenWidth} × ${profile.screenHeight}`);
  setText("wechat-device-label", `${profile.model} · ${profile.screenWidth} × ${profile.screenHeight}`);
  updatePreviewBezelPresentation();
  layoutPreviewFrame();
}

async function loadPreviewDevice() {
  if (previewDevicePromise) return previewDevicePromise;
  previewDevicePromise = api("/api/preview/device").then((payload) => {
    const profile = normalizePreviewDeviceProfile(payload);
    applyPreviewDeviceProfile(profile);
    return profile;
  });
  return previewDevicePromise;
}

let noticeTimer;
let noticeCopyText = "";

function persistBrowserDiagnostic(kind, error, unhandled = false) {
  if (!currentId) return;
  let normalized;
  try { normalized = normalizeError(error); }
  catch { normalized = new Error(String(error)); }
  // Reporting failures go to the browser console, avoiding a recursive error toast.
  void api(`/api/projects/${encodeURIComponent(currentId)}/diagnostics`, {
    method: "POST",
    body: JSON.stringify({ kind, message: normalized.message.slice(0, 8192), unhandled,
      error: { name: normalized.name, message: normalized.message.slice(0, 8192), stack: normalized.stack?.slice(0, 16384) } }),
  }).catch((failure) => console.warn("Diagnostic record could not be persisted", failure));
}

window.addEventListener("error", (event) => {
  if (event.error || event.message) persistBrowserDiagnostic("crash", event.error || event.message, true);
});
window.addEventListener("unhandledrejection", (event) => persistBrowserDiagnostic("crash", event.reason, true));

$("export-diagnostics")?.addEventListener("click", () => {
  if (!currentId) return;
  const link = document.createElement("a");
  link.href = `/api/projects/${encodeURIComponent(currentId)}/diagnostics?download=1`;
  link.download = `${currentId}-diagnostics.json`;
  link.click();
});

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  try {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    return Boolean(copied);
  } catch {
    return false;
  }
}

async function copyErrorNotice() {
  if (noticeEl.hidden || noticeEl.dataset.tone !== "error" || !noticeCopyText) return;
  const text = noticeCopyText;
  const copied = await writeClipboardText(text);
  if (noticeEl.hidden || noticeEl.dataset.tone !== "error" || noticeCopyText !== text) return;
  clearTimeout(noticeTimer);
  const messageEl = $("notice-message");
  const iconEl = $("notice-icon");
  if (!copied) {
    noticeEl.dataset.copied = "failed";
    messageEl.textContent = `${text}\n（自动复制失败，请手动选择复制）`;
    return;
  }
  noticeEl.dataset.copied = "true";
  iconEl.textContent = "✓";
  messageEl.textContent = `已复制错误信息：${text}`;
  noticeTimer = setTimeout(() => {
    if (noticeEl.hidden || noticeEl.dataset.tone !== "error" || noticeCopyText !== text) return;
    delete noticeEl.dataset.copied;
    iconEl.textContent = "!";
    messageEl.textContent = text;
  }, 1800);
}

function showNotice(message, tone = "error") {
  clearTimeout(noticeTimer);
  const kind = ["success", "info", "error"].includes(tone) ? tone : "error";
  const text = localizedMessage(message);
  if (kind === "error") persistBrowserDiagnostic("log", normalizeError(message));
  noticeCopyText = kind === "error" ? text : "";
  delete noticeEl.dataset.copied;
  noticeEl.dataset.tone = kind;
  noticeEl.setAttribute("role", kind === "error" ? "alert" : "status");
  if (kind === "error") {
    noticeEl.title = "点击复制错误信息";
  } else {
    noticeEl.removeAttribute("title");
  }
  $("notice-icon").textContent = { success: "✓", info: "i", error: "!" }[kind];
  const messageEl = $("notice-message");
  messageEl.textContent = text;
  if (kind === "error") {
    messageEl.setAttribute("role", "button");
    messageEl.tabIndex = 0;
    messageEl.setAttribute("aria-label", "点击复制错误信息");
  } else {
    messageEl.removeAttribute("role");
    messageEl.removeAttribute("tabindex");
    messageEl.removeAttribute("aria-label");
  }
  noticeEl.hidden = false;
  if (kind !== "error") noticeTimer = setTimeout(clearNotice, kind === "success" ? 3500 : 5000);
}

function clearNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = undefined;
  noticeCopyText = "";
  delete noticeEl.dataset.copied;
  noticeEl.hidden = true;
  noticeEl.removeAttribute("title");
  const messageEl = $("notice-message");
  messageEl.textContent = "";
  messageEl.removeAttribute("role");
  messageEl.removeAttribute("tabindex");
  messageEl.removeAttribute("aria-label");
}

$("notice-close")?.addEventListener("click", (event) => {
  event.stopPropagation();
  clearNotice();
});
noticeEl.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("#notice-close")) {
    clearNotice();
    return;
  }
  if (noticeEl.dataset.tone === "error") {
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && noticeEl.contains(selection.anchorNode)) return;
    void copyErrorNotice();
    return;
  }
  clearNotice();
});
noticeEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearNotice();
    return;
  }
  if (noticeEl.dataset.tone === "error" && (event.key === "Enter" || event.key === " ") && !(event.target instanceof Element && event.target.closest("#notice-close"))) {
    event.preventDefault();
    void copyErrorNotice();
  }
});

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setProjectState(label, kind = "") {
  const state = $("project-state");
  state.textContent = label;
  state.className = `state-chip${kind ? ` ${kind}` : ""}`;
}

function markDirty(value = true) {
  dirty = value;
  setText("save-status", dirty ? "有未保存修改" : "已保存");
  if (!currentId) setProjectState("未选择项目");
  else if (dirty) setProjectState("有未保存修改");
  else if (currentStatus?.busy) setProjectState("构建中…", "good");
  else if (currentStatus?.error) setProjectState("构建失败", "bad");
  else if (currentStatus?.builtRevision === currentStatus?.revision) setProjectState("已构建", "good");
  else setProjectState("需要构建");
  updateActionStates();
}

function updateActionStates() {
  if ($("export-diagnostics")) $("export-diagnostics").disabled = !currentId;
  const hasProject = Boolean(currentId);
  const busy = Boolean(currentStatus?.busy);
  const built = Boolean(currentStatus && currentStatus.builtRevision === currentStatus.revision && !currentStatus.error);
  const publishTarget = activePublishTarget();
  const publishTargetAvailable = publishTargetContext
    ? Boolean(publishTarget && publishTarget.canSelect !== false && publishTarget.ownerProjectId && publishTarget.projectId === currentId)
    : !publishTarget || publishTarget.kind !== "reused" || (publishTarget.canSelect !== false && publishTarget.ownerProjectId && publishTarget.projectId === currentId);
  const canPublishCurrentTarget = hasProject && built && publishTargetAvailable && publishTarget?.canPublish !== false && !publishTargetsLoading && !dirty && !resourcesDirty;
  const workLocked = busy || startingBuild || startingDeploy || Boolean(activeDeploy && activeDeploy.status !== "running") || saving || publishing || resourcesSaving;
  $("save").disabled = !hasProject || !dirty || saving || workLocked;
  $("build").disabled = !hasProject || !publishTargetAvailable || workLocked || saving;
  if ($("novel-open")) $("novel-open").disabled = !hasProject || workLocked;
  $("refresh-source").disabled = !hasProject || workLocked;
  $("refresh-preview").disabled = !hasProject || busy;
  previewFrame.style.pointerEvents = busy ? "none" : "";
  $("preview-open").disabled = !previewPath;
  if ($("copy-preview-link")) $("copy-preview-link").disabled = !previewPath;
  if ($("source-toggle")) $("source-toggle").disabled = !hasProject;
  if ($("source-split-toggle")) $("source-split-toggle").disabled = !hasProject;
  $("capture-preview").disabled = !previewReady;
  if ($("toggle-regions")) {
    $("toggle-regions").disabled = !previewReady;
    $("toggle-regions").setAttribute("aria-pressed", String(previewRegionsEnabled));
  }
  $("device-picker").disabled = !hasProject || !devices.length || Boolean(activeDeploy);
  $("deploy").disabled = !hasProject || !built || busy || startingDeploy || !$("device-picker").value || Boolean(activeDeploy);
  $("deploy-cancel").hidden = !activeDeploy;
  const wechatStart = $("wechat-start");
  const wechatStop = $("wechat-stop");
  const wechatOpen = $("wechat-open");
  const wechatRunning = wechatState.state === "running";
  const wechatBuilding = wechatState.state === "building";
  const wechatBusy = startingWechat || stoppingWechat || wechatBuilding;
  if (wechatStart) wechatStart.disabled = !hasProject || wechatBusy || wechatRunning || workLocked;
  if (wechatStop) {
    wechatStop.hidden = !wechatBuilding && !wechatRunning;
    wechatStop.disabled = !hasProject || startingWechat || stoppingWechat || (!wechatBuilding && !wechatRunning);
  }
  if (wechatOpen) {
    const url = wechatRunning && wechatState.url ? wechatState.url : "";
    wechatOpen.hidden = !url;
    if (url) wechatOpen.href = url;
    else wechatOpen.removeAttribute("href");
  }
  $("publish-test").disabled = !canPublishCurrentTarget || workLocked;
  if ($("open-version-manager-from-signing")) $("open-version-manager-from-signing").disabled = !hasProject;
  if ($("publish-target-picker")) $("publish-target-picker").disabled = !hasProject || publishTargetsLoading || workLocked;
  if ($("publish-target-channel")) $("publish-target-channel").disabled = !hasProject || publishTargetsLoading || workLocked;
  $("versions-open").disabled = !hasProject;
  $("versions-refresh").disabled = !hasProject || versionsLoading;
  updatePublishTargetIndicators();
  updateResourceActionStates(workLocked);
}

function setPublishEditorLocked(locked) {
  sourceEl.readOnly = locked;
  if ($("file-picker")) $("file-picker").disabled = locked || !currentId;
  for (const id of ["config-name", "config-app-id", "config-version", "config-build", "config-tick"]) {
    const field = $(id);
    if (field) field.disabled = locked || !currentId;
  }
}

function currentProjectTitle() {
  return $("config-name")?.value || projects.find((project) => project.id === currentId)?.name || currentId || "项目";
}

function currentProjectAppId() {
  return $("config-app-id")?.value || projects.find((project) => project.id === currentId)?.appId || "—";
}

function updateProjectHeading(project, config = project) {
  const name = config?.name || project?.name || currentId || "项目";
  const appId = config?.appId || project?.appId || "—";
  const source = project?.source?.kind === "catalog-miniapp" ? project.source : null;
  if (source) {
    setText("project-title", `${source.sourceProjectTitle} › MiniApp ${name}`);
    setText("project-subtitle", `${source.sourceProjectTitle} 内 MiniApp · 源码 ${source.sourcePath} · ${appId}`);
    return;
  }
  setText("project-title", name);
  setText("project-subtitle", `${appId} · ${config?.framework || "solid"} · ${config?.entry || "app.tsx"}`);
}

function activePublishTarget() {
  const targets = Array.isArray(publishTargets?.targets) ? publishTargets.targets : [];
  if (publishTargetContext && publishTargets && publishTargetContext.sourceProjectId === publishTargets.currentProjectId) {
    return targets.find((target) => target.appId === publishTargetContext.appId) || null;
  }
  return targets.find((target) => target.kind === "root" && target.projectId === currentId)
    || targets.find((target) => target.projectId === currentId)
    || null;
}

function publishChannelLabel(channel = publishTargetChannel) {
  return channel === "release" ? "稳定版" : "测试版";
}

function publishTargetLabel() {
  if (publishTargetContext && publishTargets && publishTargetContext.sourceProjectId === publishTargets.currentProjectId) {
    const target = activePublishTarget();
    const title = `MiniApp ${target?.title || publishTargetContext.appId}`;
    const sourceTitle = target?.sourceProjectTitle || publishTargetContext.sourceProjectTitle;
    return sourceTitle ? `${sourceTitle} › ${title}` : `${title} (${publishTargetContext.appId})`;
  }
  return `主应用 ${currentProjectAppId()} · ${currentProjectTitle()}`;
}

function publishTargetStatusLabel() {
  if (!currentId) return "请选择项目";
  if (publishTargetsLoading) return "正在读取发布目标…";
  const target = activePublishTarget();
  if (target?.kind === "reused" && target.canSelect === false) return target.reason || "此应用暂不可发布";
  if (target?.kind === "reused" && target.projectId !== currentId) return "MiniApp 源码上下文已变化，请重新选择目标";
  if (target?.busy) return "构建中";
  if (target?.canPublish === false && target.built === false) return "需先构建";
  if (target?.kind === "root" && target.canPublish === false && target.reason) return target.reason;
  if (dirty) return "有未保存修改，请先保存并构建";
  if (resourcesDirty) return "资源策略尚未保存";
  const status = currentStatus;
  if (status?.busy) return "构建中";
  if (status?.error) return "最近构建失败，请重新构建";
  if (status && status.builtRevision === status.revision) return "已构建，可发布";
  return "需先构建";
}

function publishTargetScopeLabel() {
  const target = activePublishTarget();
  const channel = `当前显示：${publishChannelLabel()}发布状态。`;
  if (target?.kind === "reused" || (publishTargetContext && publishTargets && publishTargetContext.sourceProjectId === publishTargets.currentProjectId)) {
    const sourceTitle = target?.sourceProjectTitle || publishTargetContext?.sourceProjectTitle;
    const sourcePath = target?.sourcePath || publishTargetContext?.sourcePath;
    const sourceLabel = sourcePath
      ? `${sourceTitle || publishTargetContext?.sourceProjectId} 内 MiniApp ${target?.title || publishTargetContext?.appId} · 源码 ${sourcePath}`
      : `MiniApp 发布记录 ${target?.ownerTitle || publishTargetContext?.ownerTitle || currentProjectTitle()}`;
    const version = target?.publishedVersion
      ? `当前已发布 v${target.publishedVersion}${target.publishedBuild !== undefined ? ` build ${target.publishedBuild}` : ""}`
      : `此频道暂无已发布版本`;
    return `发布范围：${sourceLabel} · ${version}。${channel}`;
  }
  return `发布范围：主应用 ${currentProjectAppId()}，并包含此项目内普通子包；复用 MiniApp 使用各自所属项目的已发布版本。${channel}`;
}

function renderPublishTargetPicker() {
  const picker = $("publish-target-picker");
  const channelPicker = $("publish-target-channel");
  const reusedList = $("publish-target-reused");
  if (channelPicker) channelPicker.value = publishTargetChannel;
  if (!picker) return;
  picker.replaceChildren();
  const targets = Array.isArray(publishTargets?.targets) ? publishTargets.targets : [];
  const contextSourceProjectId = publishTargetContext?.sourceProjectId;
  const fallbackSourceRoot = contextSourceProjectId && contextSourceProjectId !== currentId
    ? {
      projectId: contextSourceProjectId,
      appId: projects.find((project) => project.id === contextSourceProjectId)?.appId || contextSourceProjectId,
      title: projects.find((project) => project.id === contextSourceProjectId)?.name || contextSourceProjectId,
      kind: "root",
    }
    : null;
  const contextRoot = fallbackSourceRoot
    ? targets.find((target) => target.kind === "root" && target.projectId === contextSourceProjectId) || fallbackSourceRoot
    : null;
  const root = targets.find((target) => target.kind === "root" && target.projectId === currentId)
    || targets.find((target) => target.kind === "root" && target.projectId === publishTargets?.currentProjectId)
    || contextRoot
    || targets.find((target) => target.projectId === currentId)
    || {
      projectId: currentId,
      appId: currentProjectAppId(),
      title: currentProjectTitle(),
      kind: "root",
    };
  const optionTargets = targets.length ? [...targets] : currentId ? [root] : [];
  if (contextRoot && !optionTargets.some((target) => target.kind === "root" && target.projectId === contextSourceProjectId)) {
    optionTargets.unshift(contextRoot);
  }
  const selectedContextTargetExists = Boolean(
    publishTargetContext
    && optionTargets.some((target) => target.appId === publishTargetContext.appId),
  );
  const needsReturnPlaceholder = Boolean(
    publishTargetContext
    && contextSourceProjectId !== currentId
    && !selectedContextTargetExists,
  );
  if (needsReturnPlaceholder) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = `MiniApp ${publishTargetContext.appId} 暂不可用 · 选择主应用返回`;
    picker.append(option);
  }
  for (const target of optionTargets) {
    const option = document.createElement("option");
    option.value = target.appId || target.projectId || "";
    if (target.kind === "reused") {
      const latest = target.publishedVersion
        ? ` · 当前已发布 v${target.publishedVersion}${target.publishedBuild !== undefined ? ` build ${target.publishedBuild}` : ""}`
        : " · 尚无此频道发布记录";
      const sourceLabel = target.sourcePath
        ? `${target.sourceProjectTitle || publishTargets?.currentProjectId} 内 MiniApp ${target.title || target.appId} · 源码 ${target.sourcePath}`
        : `MiniApp ${target.title || target.appId} (${target.appId}) · 发布项目 ${target.ownerTitle || target.ownerProjectId}`;
      option.textContent = `${sourceLabel}${latest}`;
      option.title = `${sourceLabel} · ${target.appId}`;
      option.disabled = target.canSelect === false || !target.ownerProjectId;
    } else {
      option.textContent = `主应用 ${target.appId || currentProjectAppId()} · ${target.title || currentProjectTitle()}`;
    }
    picker.append(option);
  }
  if (!optionTargets.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = publishTargetsLoading ? "正在加载发布目标…" : "无可用发布目标";
    picker.append(option);
  }
  const preferredAppId = needsReturnPlaceholder
    ? ""
    : publishTargetContext && publishTargets && publishTargetContext.sourceProjectId === publishTargets.currentProjectId
    ? publishTargetContext.appId
    : root.appId || currentProjectAppId();
  picker.value = preferredAppId;
  if (picker.selectedIndex < 0 && picker.options.length) picker.selectedIndex = 0;

  if (reusedList) {
    reusedList.replaceChildren();
    const reused = targets.filter((target) => target.kind === "reused");
    reusedList.hidden = reused.length === 0;
    for (const target of reused) {
      const row = document.createElement("div");
      row.className = "publish-target-reused-item";
      const title = document.createElement("strong");
      title.textContent = target.sourcePath
        ? `${target.sourceProjectTitle || publishTargets?.currentProjectId} 内 MiniApp · ${target.title || target.appId}`
        : `MiniApp ${target.title || target.appId} (${target.appId})`;
      const detail = document.createElement("span");
      const owner = target.ownerTitle || target.ownerProjectId || "所属项目未解析";
      const ownerIdentity = target.ownerProjectId ? ` (${target.ownerProjectId})` : "";
      const ownerVersion = target.version ? ` · 项目 v${target.version}` : "";
      const ownerBuild = target.build !== undefined ? ` build ${target.build}` : "";
      const published = target.publishedVersion
        ? ` · ${publishChannelLabel()}当前已发布 v${target.publishedVersion}${target.publishedBuild !== undefined ? ` build ${target.publishedBuild}` : ""}`
        : " · 尚无此频道发布版本";
      const buildState = target.busy ? " · 正在构建" : target.built ? " · 已构建" : " · 需先构建";
      detail.textContent = target.canSelect === false || !target.ownerProjectId
        ? `${target.reason || "无法解析此 MiniApp 的所属项目。"}`
        : target.sourcePath
          ? `源码：${target.sourcePath} · ${buildState}${published}`
          : `发布项目：${owner}${ownerIdentity}${ownerVersion}${ownerBuild}${buildState}${published}`;
      row.append(title, detail);
      reusedList.append(row);
    }
  }
  updatePublishTargetIndicators();
}

function updatePublishTargetIndicators() {
  const targetName = publishTargetLabel();
  const full = currentId ? `目标：${targetName} · ${publishChannelLabel()}` : "目标：请选择项目";
  const label = $("publish-target-action-label");
  if (label) {
    label.textContent = full;
    label.title = full;
  }
  const summary = $("publish-target-summary");
  if (summary) {
    summary.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = targetName;
    const detail = document.createElement("span");
    detail.textContent = publishTargetStatusLabel();
    summary.append(title, detail);
  }
  const scope = $("publish-target-scope");
  if (scope) {
    scope.textContent = publishTargetsError
      ? `${publishTargetScopeLabel()} MiniApp 目标读取失败：${publishTargetsError}`
      : publishTargetScopeLabel();
  }
  const testInfo = $("test-publish-info");
  if (testInfo && currentStatus?.publish?.channel === "test") {
    testInfo.hidden = publishTargetChannel !== "test";
  }
  const build = $("build");
  if (build) build.title = `构建当前源码上下文：${currentProjectTitle()}（⌘B）`;
  const action = $("publish-test");
  if (action) action.textContent = publishTargetChannel === "test" ? "发布测试包" : "发布稳定版";
  setText("publish-channel-eyebrow", publishTargetChannel === "test" ? "测试包 / 热更新" : "稳定版");
  setText("test-publish-title", publishTargetChannel === "test" ? "发布到本地版本后端" : "发布到稳定频道");
  setText("publish-channel-description", publishTargetChannel === "test"
    ? "为递增的测试构建签名，并以只读方式提供给同一局域网中的模拟器和设备。"
    : "将此构建签名并更新稳定频道。版本状态来自所选应用当前源码上下文。");
}

function setPublishTargets(payload, error = "") {
  publishTargets = payload && Array.isArray(payload.targets) ? payload : null;
  publishTargetsError = error ? String(error.message || error) : "";
  publishTargetsLoading = false;
  renderPublishTargetPicker();
  updateActionStates();
}

function publishTargetsProjectId() {
  return publishTargetContext?.sourceProjectId || currentId;
}

async function refreshPublishTargets(projectId = publishTargetsProjectId(), channel = publishTargetChannel) {
  if (!projectId) return null;
  const editorProjectId = currentId;
  const generation = ++publishTargetsGeneration;
  publishTargetsLoading = true;
  publishTargetsError = "";
  updateActionStates();
  try {
    const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/publish-targets?channel=${encodeURIComponent(channel)}`);
    if (currentId !== editorProjectId || generation !== publishTargetsGeneration) return null;
    setPublishTargets(payload);
    return payload;
  } catch (error) {
    if (currentId !== editorProjectId || generation !== publishTargetsGeneration) return null;
    setPublishTargets(null, error);
    return null;
  }
}

async function switchPublishTargetChannel(channel) {
  if (channel !== "test" && channel !== "release") return;
  if (channel === publishTargetChannel && !publishTargetsLoading) return publishTargets;
  publishTargetChannel = channel;
  if ($("publish-target-channel")) $("publish-target-channel").value = channel;
  updateActionStates();
  const payload = await refreshPublishTargets();
  if (!payload) {
    showNotice(`无法读取${publishChannelLabel(channel)}频道的发布目标。请刷新后重试。`, "error");
    return null;
  }
  const context = publishTargetContext;
  const target = context && payload?.targets?.find((entry) => entry.appId === context.appId && entry.kind === "reused");
  let projectAligned = true;
  if (context && target) {
    if (target.canSelect === false || !target.ownerProjectId) {
      showNotice(target.reason || `MiniApp ${target.appId} 在${publishChannelLabel(channel)}频道尚无可用的所属项目。`, "info");
      return payload;
    }
    const ownerProjectId = target.ownerProjectId;
    if (ownerProjectId !== currentId) {
      const nextContext = {
        ...context,
        ownerProjectId,
        ownerTitle: target.ownerTitle || target.title || ownerProjectId,
        sourceProjectTitle: target.sourceProjectTitle || context.sourceProjectTitle,
        sourcePath: target.sourcePath || context.sourcePath,
      };
      await selectProject(ownerProjectId, { publishTargetContext: nextContext });
      projectAligned = currentId === ownerProjectId && !sourceEl.disabled;
    } else if (ownerProjectId === currentId) {
      publishTargetContext = {
        ...context,
        ownerProjectId,
        ownerTitle: target.ownerTitle || target.title || ownerProjectId,
        sourceProjectTitle: target.sourceProjectTitle || context.sourceProjectTitle,
        sourcePath: target.sourcePath || context.sourcePath,
      };
      updatePublishTargetIndicators();
    }
  } else if (context) {
    projectAligned = false;
  }
  const active = context && payload?.targets?.find((entry) => entry.appId === context.appId);
  if (!projectAligned) {
    showNotice(`已切换至${publishChannelLabel(channel)}频道，但所选 MiniApp 所属项目尚未打开。请处理未保存修改后再点“切换到所选应用”。`, "info");
    return payload;
  }
  const projectText = active?.kind === "reused"
    ? `MiniApp ${active.appId} · 所属项目 ${active.ownerTitle || active.projectId} · ${active.busy ? "构建中" : active.built ? "已构建" : "需先构建"}${active.publishedVersion ? ` · 当前已发布 v${active.publishedVersion}${active.publishedBuild !== undefined ? ` build ${active.publishedBuild}` : ""}` : " · 此频道暂无已发布版本"}。`
    : `主应用 ${currentProjectAppId()}。`;
  showNotice(`已切换至${publishChannelLabel(channel)}频道。${projectText}请确认目标和状态后再点击发布。`, "info");
  return payload;
}

function renderProjects() {
  projectsEl.replaceChildren();
  const renderProjectButton = (project, nested = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `project-item${nested ? " project-item-nested" : ""}${project.id === currentId ? " active" : ""}`;
    const name = document.createElement("strong");
    name.textContent = nested ? `MiniApp · ${project.name || project.id}` : project.name || project.id;
    const detail = document.createElement("small");
    detail.textContent = nested && project.source?.kind === "catalog-miniapp"
      ? `${project.source.sourcePath} · ${project.appId} · v${project.version || "—"}`
      : `${project.appId || project.id} · v${project.version || "—"}`;
    button.append(name, detail);
    button.addEventListener("click", () => {
      const source = project.source?.kind === "catalog-miniapp" ? project.source : null;
      const publishTargetContext = source ? {
        sourceProjectId: source.parentProjectId,
        sourceProjectTitle: source.sourceProjectTitle,
        sourcePath: source.sourcePath,
        appId: project.appId,
        ownerProjectId: project.id,
        ownerTitle: project.name || project.id,
      } : null;
      void selectProject(project.id, publishTargetContext ? { publishTargetContext } : {});
    });
    return button;
  };

  const sourceProjects = projects.filter((project) => project.source?.kind === "catalog-miniapp");
  const parentProjects = projects.filter((project) => project.source?.kind !== "catalog-miniapp");
  const renderedSourceIds = new Set();
  const renderSourceGroup = (title, children) => {
    if (!children.length) return;
    const group = document.createElement("section");
    group.className = "project-child-group";
    const heading = document.createElement("span");
    heading.className = "project-child-heading";
    heading.textContent = `${title} · MiniApps`;
    group.append(heading);
    for (const child of children) {
      renderedSourceIds.add(child.id);
      group.append(renderProjectButton(child, true));
    }
    projectsEl.append(group);
  };

  for (const project of parentProjects) {
    projectsEl.append(renderProjectButton(project));
    renderSourceGroup(
      project.name || project.id,
      sourceProjects.filter((source) => source.source.parentProjectId === project.id),
    );
  }
  const ungroupedSources = sourceProjects.filter((project) => !renderedSourceIds.has(project.id));
  if (ungroupedSources.length) {
    const first = ungroupedSources[0].source;
    renderSourceGroup(first.sourceProjectTitle, ungroupedSources);
  }
  if (!projects.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "还没有项目。";
    projectsEl.append(empty);
  }
}

function fileUrl(projectId, filePath) {
  const encoded = filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `/api/projects/${encodeURIComponent(projectId)}/files/${encoded}`;
}

function renderFilePicker(files) {
  projectFiles = (files || []).map((file) => typeof file === "string" ? file : file.path).filter(Boolean);
  const picker = $("file-picker");
  picker.replaceChildren();
  for (const file of projectFiles) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file;
    picker.append(option);
  }
  picker.value = projectFiles.includes(currentFile) ? currentFile : projectFiles[0] || "";
  setText("source-panel-title", picker.value || "没有源文件");
}

async function loadFile(filePath) {
  if (!currentId || !filePath) return;
  const content = await api(fileUrl(currentId, filePath));
  currentFile = content.path;
  sourceEl.value = content.content;
  $("file-picker").value = currentFile;
  setText("source-panel-title", currentFile);
  setText("source-bytes", `${Number(content.bytes || 0).toLocaleString()} 字节`);
  markDirty(false);
}

function wechatPath(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/wechat`;
}

function readWechatState(payload) {
  const value = payload && typeof payload === "object" && payload.state && typeof payload.state === "object"
    ? payload.state
    : payload;
  const state = WECHAT_STATES.has(value?.state) ? value.state : "idle";
  const logs = Array.isArray(value?.logs) ? value.logs.map((entry) => String(entry)) : [];
  return {
    state,
    targetId: typeof value?.targetId === "string" ? value.targetId : "",
    url: typeof value?.url === "string" ? value.url : "",
    error: typeof value?.error === "string" ? value.error : "",
    logs,
  };
}

function readWechatProjectLabel(payload) {
  const target = Array.isArray(payload?.targets) ? payload.targets[0] : null;
  const label = typeof target?.label === "string" ? target.label : "";
  const appId = typeof target?.appId === "string" ? target.appId : "";
  return label || appId || (currentId ? "整个应用" : "请选择项目");
}

function renderWechatTargets(payload = {}) {
  const projectLabel = $("wechat-project-label");
  if (projectLabel) projectLabel.title = readWechatProjectLabel(payload);
}

function renderWechatState(nextState = wechatState) {
  wechatState = readWechatState(nextState);
  const chip = $("wechat-state");
  if (chip) {
    const labels = { idle: "空闲", building: "构建中…", running: "运行中", error: "错误", stopped: "已停止" };
    const kind = wechatState.state === "running" ? "good" : wechatState.state === "error" ? "bad" : "";
    chip.textContent = labels[wechatState.state] || "空闲";
    chip.className = `meta-chip${kind ? ` ${kind}` : ""}`;
    const detail = wechatState.error || wechatState.logs.at(-1) || "";
    if (detail) chip.title = detail;
    else chip.removeAttribute("title");
    chip.setAttribute("aria-label", `微信${chip.textContent}${detail ? `：${detail}` : ""}`);
  }
  renderWechatPreview();
  updateActionStates();
}

function renderWechatPreview() {
  if (!wechatPreviewPane || !wechatPreviewFrame || !wechatPreviewEmpty) return;
  const state = wechatState.state;
  const visible = state === "building" || state === "running" || state === "error";
  wechatPreviewPane.hidden = !visible;
  previewSurfaces?.classList.toggle("wechat-visible", visible);
  if (!visible) wechatPreviewPane.style.removeProperty("width");
  if (state === "running" && wechatState.url) {
    const url = wechatState.url;
    if (wechatPreviewFrame.dataset.url !== url) {
      wechatPreviewFrame.dataset.url = url;
      const embedded = new URL(url, window.location.href);
      embedded.pathname = "/pocket-embed";
      wechatPreviewFrame.src = embedded.href;
    }
    wechatPreviewFrame.hidden = false;
    wechatPreviewEmpty.hidden = true;
    return;
  }
  wechatPreviewFrame.hidden = true;
  wechatPreviewEmpty.hidden = false;
  if (state === "error") {
    wechatPreviewEmpty.querySelector("strong").textContent = "微信预览失败";
    wechatPreviewEmpty.querySelector("span").textContent = wechatState.error || "请查看微信运行日志。";
  } else if (state === "building") {
    wechatPreviewEmpty.querySelector("strong").textContent = "正在启动微信预览";
    wechatPreviewEmpty.querySelector("span").textContent = "正在构建整个应用…";
  } else {
    wechatPreviewEmpty.querySelector("strong").textContent = "微信预览";
    wechatPreviewEmpty.querySelector("span").textContent = "运行微信以加载整个应用。";
  }
  if (!visible || state === "error" || state === "building") {
    wechatPreviewFrame.dataset.url = "";
    if (wechatPreviewFrame.src !== "about:blank") wechatPreviewFrame.src = "about:blank";
  }
  layoutPreviewFrame();
}

function stopWechatPolling() {
  if (wechatPollTimer) clearTimeout(wechatPollTimer);
  wechatPollTimer = null;
}

function invalidateWechatRequests() {
  wechatGeneration += 1;
  stopWechatPolling();
  startingWechat = false;
  stoppingWechat = false;
}

function resetWechatPresentation() {
  wechatState = { state: "idle", url: "", error: "", logs: [] };
  renderWechatTargets();
  renderWechatState();
}

async function loadWechat(projectId, generation) {
  try {
    const response = await api(wechatPath(projectId));
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatTargets(response);
    renderWechatState(response);
    if (wechatState.state === "building") void pollWechat(0, projectId, generation);
  } catch (error) {
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatTargets();
    renderWechatState({ state: "error", error: normalizeError(error).message, logs: [] });
    showNotice(error);
  }
}

async function pollWechat(attempt = 0, projectId = currentId, generation = wechatGeneration) {
  if (!projectId || currentId !== projectId || generation !== wechatGeneration) return;
  wechatPollTimer = null;
  if (attempt > MAX_WECHAT_POLL_ATTEMPTS) {
    renderWechatState({ ...wechatState, state: "error", error: "微信验证超时。" });
    showNotice("微信验证超时。");
    return;
  }
  try {
    const response = await api(wechatPath(projectId));
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatTargets(response);
    renderWechatState(response);
    if (wechatState.state === "building") {
      wechatPollTimer = setTimeout(() => void pollWechat(attempt + 1, projectId, generation), POLL_DELAY_MS);
    } else if (wechatState.state === "error" && wechatState.error) {
      showNotice(wechatState.error);
    }
  } catch (error) {
    if (currentId !== projectId || generation !== wechatGeneration) return;
    stopWechatPolling();
    renderWechatState({ ...wechatState, state: "error", error: normalizeError(error).message });
    showNotice(error);
  }
}

async function startWechat() {
  const projectId = currentId;
  const generation = wechatGeneration;
  const targetId = "main";
  if (!projectId || startingWechat || stoppingWechat || wechatState.state === "building" || wechatState.state === "running") return;
  clearNotice();
  startingWechat = true;
  renderWechatState({ state: "building", logs: [] });
  try {
    const response = await api(wechatPath(projectId), {
      method: "POST",
      body: JSON.stringify({ targetId }),
    });
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatTargets(response);
    renderWechatState(response);
    if (wechatState.state === "building") void pollWechat(0, projectId, generation);
  } catch (error) {
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatState({ state: "error", error: normalizeError(error).message, logs: [] });
    showNotice(error);
  } finally {
    if (currentId === projectId && generation === wechatGeneration) {
      startingWechat = false;
      updateActionStates();
    }
  }
}

async function stopWechat() {
  const projectId = currentId;
  if (!projectId || stoppingWechat || !["building", "running"].includes(wechatState.state)) return;
  const generation = ++wechatGeneration;
  clearNotice();
  stopWechatPolling();
  stoppingWechat = true;
  updateActionStates();
  try {
    const response = await api(wechatPath(projectId), { method: "DELETE" });
    if (currentId !== projectId || generation !== wechatGeneration) return;
    renderWechatState(response);
    if (wechatState.state === "building") void pollWechat(0, projectId, generation);
  } catch (error) {
    if (currentId !== projectId || generation !== wechatGeneration) return;
    showNotice(error);
  } finally {
    if (currentId === projectId && generation === wechatGeneration) {
      stoppingWechat = false;
      updateActionStates();
    }
  }
}

async function refreshFiles({ preserveDraft = dirty } = {}) {
  if (!currentId) return;
  const filesResponse = await api(`/api/projects/${encodeURIComponent(currentId)}/files`);
  const files = filesResponse.files || filesResponse;
  renderFilePicker(files);
  if (preserveDraft) {
    showNotice("服务器已刷新文件列表。当前未保存草稿仍然打开；再次点击“刷新文件”可丢弃草稿。", "info");
    return;
  }
  await loadFile(projectFiles.includes(currentFile) ? currentFile : projectFiles[0]);
}

function resourcesUrl(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/resources`;
}

function unavailableResourceInventory(error = "") {
  return { revision: 0, packages: [], unavailable: true, error: error ? String(error) : "" };
}

const RESOURCE_BACKEND_OUTDATED_MESSAGE = "编辑器后端版本过旧，请重启编辑器服务并刷新页面。";

function sameOriginResourceUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol)) return "";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "";
  }
}

function normalizeResourceInventory(payload) {
  const packages = Array.isArray(payload?.packages) ? payload.packages : [];
  const seenPackages = new Set();
  return {
    revision: Number.isFinite(Number(payload?.revision)) ? Number(payload.revision) : 0,
    builtRevision: Number.isInteger(payload?.builtRevision) ? payload.builtRevision : undefined,
    unavailable: payload?.unavailable === true,
    error: typeof payload?.error === "string" ? payload.error : "",
    packages: packages.map((entry) => {
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (!id || seenPackages.has(id)) return null;
      seenPackages.add(id);
      const seenResources = new Set();
      const resources = (Array.isArray(entry?.resources) ? entry.resources : []).map((resource) => {
        const key = typeof resource?.key === "string" ? resource.key : "";
        if (!key || seenResources.has(key)) return null;
        seenResources.add(key);
        const kind = resource?.kind === "asset" ? "asset" : "pak";
        const placement = resource?.placement === "network" ? "network" : "pak";
        const bytes = Number(resource?.bytes);
        return {
          key,
          kind,
          bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : null,
          placement,
          locked: resource?.locked === true,
          reason: typeof resource?.reason === "string" ? resource.reason : "",
          previewUrl: sameOriginResourceUrl(resource?.previewUrl),
        };
      }).filter(Boolean);
      return {
        id,
        title: typeof entry?.title === "string" && entry.title ? entry.title : id,
        manifest: typeof entry?.manifest === "string" ? entry.manifest : "",
        updateUrl: sameOriginResourceUrl(entry?.updateUrl),
        hostConfigUrl: sameOriginResourceUrl(entry?.hostConfigUrl),
        resources,
      };
    }).filter(Boolean),
  };
}

function copyResourceDraft(inventory) {
  const draft = new Map();
  for (const entry of inventory?.packages || []) {
    draft.set(entry.id, new Map(entry.resources.map((resource) => [resource.key, resource.placement])));
  }
  return draft;
}

function resourcePackage(packageId = resourcePackageId) {
  return resourceInventory?.packages.find((entry) => entry.id === packageId) || null;
}

function formatResourceBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MiB`;
}

function isFontAtlasResource(resource) {
  return typeof resource?.key === "string" && /(?:^|:)ui:font\./.test(resource.key);
}

function resourceTypeLabel(resource) {
  return resource?.kind === "asset" ? "独立资源" : "PAK 资源";
}

function resourceFontSlot(resource) {
  const match = typeof resource?.key === "string" ? resource.key.match(/(?:^|:)ui:font\.(\d+)(?:$|[^\d])/i) : null;
  return match ? Number(match[1]) : null;
}

function compareResourceCards(left, right) {
  const previewOrder = Number(Boolean(right.previewUrl)) - Number(Boolean(left.previewUrl));
  if (previewOrder) return previewOrder;
  const leftSlot = resourceFontSlot(left);
  const rightSlot = resourceFontSlot(right);
  if (leftSlot !== null && rightSlot !== null && leftSlot !== rightSlot) return leftSlot - rightSlot;
  return String(left.key).localeCompare(String(right.key), undefined, { numeric: true, sensitivity: "base" });
}

function resourcePreviewPlaceholder(resource, unavailable = false) {
  const placeholder = document.createElement("div");
  placeholder.className = `resource-preview-placeholder${isFontAtlasResource(resource) ? " resource-preview-font" : ""}`;
  const icon = document.createElement("span");
  icon.className = "resource-preview-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = isFontAtlasResource(resource) ? "Aa" : "◇";
  const title = document.createElement("strong");
  title.textContent = isFontAtlasResource(resource)
    ? "已编译字形图集"
    : unavailable
      ? "预览不可用"
      : "没有图片预览";
  const detail = document.createElement("span");
  detail.textContent = isFontAtlasResource(resource)
    ? "不是独立字体文件"
    : `${resourceTypeLabel(resource)} · 未提供预览`;
  placeholder.append(icon, title, detail);
  return placeholder;
}

function resourcePreview(resource) {
  const preview = document.createElement("div");
  preview.className = "resource-preview";
  if (!resource.previewUrl) {
    preview.append(resourcePreviewPlaceholder(resource));
    return preview;
  }
  const image = document.createElement("img");
  image.className = "resource-preview-image";
  image.alt = `资源预览：${resource.key}`;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.src = resource.previewUrl;
  image.addEventListener("error", () => {
    preview.replaceChildren(resourcePreviewPlaceholder(resource, true));
  }, { once: true });
  preview.append(image);
  return preview;
}

function renderResourceState() {
  const state = $("resources-state");
  const saveStatus = $("resources-save-status");
  if (!state || !saveStatus) return;
  let label = "请选择项目";
  let kind = "";
  let detail = "尚未加载策略";
  if (currentId && resourcesLoading) {
    label = "加载中…";
    kind = "loading";
    detail = "正在加载资源包清单…";
  } else if (currentId && !resourceInventory) {
    label = "不可用";
    detail = "资源清单不可用";
  } else if (currentId && resourcesDirty) {
    label = "策略未保存";
    kind = "warn";
    detail = "资源策略未保存";
  } else if (currentId && currentStatus?.busy) {
    label = "构建中…";
    kind = "loading";
    detail = "正在构建";
  } else if (currentId && currentStatus?.error) {
    label = "构建失败";
    kind = "bad";
    detail = "构建失败，请查看诊断信息";
  } else if (currentId && resourceInventory?.unavailable) {
    label = resourceInventory.error ? "不可用" : "需要构建";
    kind = "warn";
    detail = resourceInventory.error || "构建后才能生成资源包清单";
  } else if (currentId && currentStatus && currentStatus.builtRevision !== currentStatus.revision) {
    label = "需要构建";
    kind = "warn";
    detail = "保存后再构建以应用此策略";
  } else if (currentId && resourceInventory) {
    label = resourceInventory.packages.some((entry) => entry.resources.length) ? "就绪" : "清单已就绪";
    kind = "good";
    detail = resourcesDirty ? "资源策略未保存" : "策略已保存";
  }
  state.textContent = label;
  state.className = `meta-chip${kind ? ` ${kind}` : ""}`;
  saveStatus.textContent = detail;
}

function resourcePackageHasDraftChanges(entry) {
  const draft = resourceDraft.get(entry?.id);
  return Boolean(entry?.resources.some((resource) => (draft?.get(resource.key) || resource.placement) !== resource.placement));
}

function hasResourceDraftChanges() {
  return Boolean(resourceInventory?.packages.some((entry) => resourcePackageHasDraftChanges(entry)));
}

function updateResourceActionStates(workLocked = false) {
  const hasProject = Boolean(currentId);
  const controlsLocked = !hasProject || resourcesLoading || workLocked;
  const picker = $("resource-package-picker");
  const save = $("save-resources");
  if (picker) picker.disabled = controlsLocked || !resourceInventory?.packages.length;
  if (save) save.disabled = controlsLocked || resourcesSaving || !resourcesDirty;
  for (const select of document.querySelectorAll("#resource-list select[data-resource-key]")) {
    select.disabled = controlsLocked || select.dataset.locked === "true";
  }
  renderResourcePackages();
}

function renderResourcePackages() {
  const list = $("resource-package-list");
  const count = $("resource-package-count");
  if (!list) return;
  const packages = resourceInventory?.packages || [];
  list.replaceChildren();
  if (count) count.textContent = packages.length ? `${packages.length} 个资源包` : "";
  if (!packages.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = currentId && resourcesLoading
      ? "正在加载资源包…"
      : "请选择项目以查看资源包。";
    list.append(empty);
    return;
  }
  const controlsLocked = !currentId || resourcesLoading || resourcesSaving;
  for (const entry of packages) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "resource-package-button";
    button.dataset.resourcePackage = entry.id;
    button.dataset.packageId = entry.id;
    button.setAttribute("aria-pressed", String(entry.id === resourcePackageId));
    button.disabled = controlsLocked;
    button.title = `${entry.title} · ${entry.id}`;
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const id = document.createElement("code");
    id.textContent = entry.id;
    const details = document.createElement("span");
    details.className = "resource-package-button-meta";
    details.textContent = `${entry.resources.length} 个资源`;
    button.append(title, id, details);
    button.addEventListener("click", () => { selectResourcePackage(entry.id); });
    list.append(button);
  }
}

function selectResourcePackage(nextPackage) {
  if (!resourceInventory?.packages.some((entry) => entry.id === nextPackage)) return false;
  const currentEntry = resourcePackage();
  if (resourcePackageId !== nextPackage && resourcesDirty && resourcePackageHasDraftChanges(currentEntry)) {
    const picker = $("resource-package-picker");
    if (picker) picker.value = resourcePackageId;
    renderResourcePackages();
    showNotice("切换资源包前请先保存当前资源策略。", "info");
    return false;
  }
  resourcePackageId = nextPackage;
  const picker = $("resource-package-picker");
  if (picker) picker.value = nextPackage;
  renderResourcePackages();
  renderResourcePackage();
  updateResourceActionStates();
  return true;
}

function renderResourcePackage() {
  const list = $("resource-list");
  const meta = $("resource-package-meta");
  if (!list || !meta) return;
  list.replaceChildren();
  const entry = resourcePackage();
  const title = $("resource-detail-title");
  if (!entry) {
    if (title) title.textContent = resourceInventory?.unavailable ? "资源包清单不可用" : "请选择资源包";
    meta.textContent = "";
    const empty = document.createElement("div");
    empty.className = "resource-empty";
    empty.textContent = resourceInventory?.unavailable
      ? resourceInventory.error || "请先构建项目以生成 PAK 和签名网络资源清单。"
      : resourceInventory
        ? "清单中没有小应用资源包。"
        : "请选择项目以查看资源包。";
    list.append(empty);
    return;
  }
  if (title) {
    title.textContent = entry.title;
    title.title = entry.id;
  }
  const resourceCount = entry.resources.length;
  meta.replaceChildren();
  const summary = document.createElement("span");
  summary.textContent = [
    entry.manifest ? `清单 ${entry.manifest}` : "清单不可用",
    `${resourceCount} 个资源`,
  ].join(" · ");
  meta.append(summary);
  if (!resourceCount) {
    const empty = document.createElement("div");
    empty.className = "resource-empty";
    empty.textContent = resourceInventory?.builtRevision === undefined || resourceInventory?.unavailable
      ? resourceInventory?.error || "请先构建项目以生成此资源包的 PAK 和签名网络资源清单。"
      : "此资源包在当前构建中没有资源。";
    list.append(empty);
    return;
  }
  const draft = resourceDraft.get(entry.id) || new Map();
  resourceDraft.set(entry.id, draft);
  const resources = [...entry.resources].sort(compareResourceCards);
  for (const resource of resources) {
    const row = document.createElement("div");
    row.className = `resource-row${resource.locked ? " resource-locked" : ""}`;
    row.dataset.resourceKey = resource.key;
    row.setAttribute("role", "listitem");
    if (!resource.locked) row.append(resourcePreview(resource));
    const main = document.createElement("div");
    main.className = "resource-row-main";
    const key = document.createElement("code");
    key.className = "resource-row-key";
    key.textContent = resource.key;
    key.title = resource.key;
    const info = document.createElement("span");
    info.className = "resource-row-meta";
    info.textContent = `${resourceTypeLabel(resource)} · ${formatResourceBytes(resource.bytes)}`;
    main.append(key, info);
    if (isFontAtlasResource(resource)) {
      const fontNote = document.createElement("span");
      fontNote.className = "resource-font-note";
      fontNote.textContent = "类型 · 字形图集";
      fontNote.title = "ui:font.N 是已编译字形图集，不是独立字体文件。";
      main.append(fontNote);
    }
    if (resource.locked) {
      const required = document.createElement("span");
      required.className = "resource-required-badge";
      required.textContent = "基础包 · 必需";
      required.title = resource.reason || "资源包必需项，位置已锁定。";
      row.append(main, required);
    } else {
      const placement = document.createElement("label");
      placement.className = "resource-placement";
      const placementLabel = document.createElement("span");
      placementLabel.className = "resource-placement-hint";
      placementLabel.textContent = "交付方式";
      const picker = document.createElement("select");
      picker.dataset.resourceKey = resource.key;
      picker.dataset.locked = String(resource.locked);
      picker.setAttribute("aria-label", `资源交付方式：${resource.key}`);
      for (const [value, label] of [["pak", "基础包"], ["network", "网络"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        picker.append(option);
      }
      picker.value = draft.get(resource.key) || resource.placement;
      picker.addEventListener("change", () => {
        draft.set(resource.key, picker.value === "network" ? "network" : "pak");
        resourcesDirty = hasResourceDraftChanges();
        renderResourceState();
        updateActionStates();
      });
      placement.append(placementLabel, picker);
      row.append(main, placement);
    }
    list.append(row);
  }
}

function renderResourceInventory() {
  const picker = $("resource-package-picker");
  if (!picker) return;
  picker.replaceChildren();
  if (resourceInventory?.packages.length) {
    if (!resourceInventory.packages.some((entry) => entry.id === resourcePackageId)) resourcePackageId = resourceInventory.packages[0].id;
    for (const entry of resourceInventory.packages) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.title === entry.id ? entry.id : `${entry.title} · ${entry.id}`;
      picker.append(option);
    }
    picker.value = resourcePackageId;
  } else {
    resourcePackageId = "";
  }
  renderResourcePackages();
  renderResourcePackage();
  renderResourceState();
  updateResourceActionStates();
}

function setResourceInventory(payload) {
  const normalized = normalizeResourceInventory(payload);
  const selected = resourcePackageId;
  resourceInventory = normalized;
  resourcePackageId = normalized.packages.some((entry) => entry.id === selected) ? selected : (normalized.packages[0]?.id || "");
  resourceDraft = copyResourceDraft(normalized);
  resourcesDirty = false;
  renderResourceInventory();
}

async function fetchResources(projectId) {
  try {
    return await api(resourcesUrl(projectId));
  } catch (error) {
    if (error?.status === 404) return unavailableResourceInventory(RESOURCE_BACKEND_OUTDATED_MESSAGE);
    // Resource inventory is supplemental to source editing and preview. Keep
    // those workflows usable while an unbuilt/stale server reports the
    // inventory error inside this panel only.
    return unavailableResourceInventory(error?.message || "资源清单不可用。");
  }
}

async function loadResources(projectId = currentId) {
  if (!projectId) return null;
  const generation = ++resourcesGeneration;
  resourcesLoading = true;
  renderResourceState();
  updateActionStates();
  try {
    const payload = await fetchResources(projectId);
    if (currentId !== projectId || generation !== resourcesGeneration) return null;
    setResourceInventory(payload);
    return resourceInventory;
  } finally {
    if (currentId === projectId && generation === resourcesGeneration) {
      resourcesLoading = false;
      renderResourceState();
      updateActionStates();
    }
  }
}

function resetResources() {
  resourcesGeneration += 1;
  resourceInventory = null;
  resourcePackageId = "";
  resourceDraft = new Map();
  resourcesDirty = false;
  resourcesLoading = false;
  renderResourceInventory();
  renderResourceState();
  updateResourceActionStates();
}

async function saveResources() {
  if (!currentId || !resourceInventory || !resourcesDirty || resourcesSaving) return;
  const projectId = currentId;
  const generation = resourcesGeneration;
  const entry = resourcePackage();
  if (!entry) return;
  const draft = resourceDraft.get(entry.id) || new Map();
  resourcesSaving = true;
  setText("resources-save-status", "正在保存资源策略…");
  updateActionStates();
  try {
    const response = await api(resourcesUrl(projectId), {
      method: "PUT",
      body: JSON.stringify({
        revision: resourceInventory.revision,
        packageId: entry.id,
        placements: entry.resources.map((resource) => ({ key: resource.key, placement: draft.get(resource.key) || resource.placement })),
      }),
    });
    if (currentId !== projectId || generation !== resourcesGeneration) return;
    setResourceInventory(response);
    try { await refreshStatus(); } catch {}
    showNotice("资源策略已保存。请构建项目以应用。", "success");
  } catch (error) {
    if (error?.status === 409 || error?.status === 412) {
      try {
        if (currentId === projectId) {
          await loadResources(projectId);
          await refreshStatus();
        }
      } catch {}
      showNotice("服务器上的资源策略已变化。已加载最新清单，请检查后再保存。", "info");
      return;
    }
    showNotice(error);
    throw error;
  } finally {
    resourcesSaving = false;
    renderResourceState();
    updateActionStates();
    resumeDeferredStudioUpgrade();
  }
}

function versionHistoryEntries(snapshot) {
  const raw = Array.isArray(snapshot?.history) ? snapshot.history : [];
  return raw
    .filter((item) => item && typeof item === "object" && Array.isArray(item.packages))
    .map((item) => {
      const channel = String(item.channel || "release").toLowerCase();
      return {
        id: String(item.releaseId || item.id || "release"),
        version: typeof item.version === "string" ? item.version : "",
        build: Number.isSafeInteger(item.build) ? item.build : null,
        channel: channel === "test" ? "test" : "stable",
        slot: item.slot === "stable" ? "stable" : item.slot === "test" ? "test" : "",
        publishedAt: typeof item.publishedAt === "string" ? item.publishedAt : "",
        archiveUrl: typeof item.archiveUrl === "string" ? item.archiveUrl : "",
        appConfigUrl: typeof item.appConfigUrl === "string" ? item.appConfigUrl : "",
        packages: item.packages
          .filter((pkg) => pkg && typeof pkg === "object")
          .map((pkg) => ({
            id: String(pkg.id || "package"),
            version: typeof pkg.version === "string" ? pkg.version : "",
            build: Number.isSafeInteger(pkg.build) ? pkg.build : null,
          })),
        reusedPackages: Array.isArray(item.reusedPackages)
          ? item.reusedPackages.filter((pkg) => pkg && typeof pkg === "object").map((pkg) => ({
            id: String(pkg.id || "MiniApp"),
            version: typeof pkg.version === "string" ? pkg.version : "",
            build: Number.isSafeInteger(pkg.build) ? pkg.build : null,
            ownerProjectId: typeof pkg.ownerProjectId === "string" ? pkg.ownerProjectId : "",
            releaseId: typeof pkg.releaseId === "string" ? pkg.releaseId : "",
          }))
          : [],
      };
    });
}

function createArchiveDownloadControl(entry, label) {
  const hasArchive = Boolean(entry?.archiveUrl);
  const control = document.createElement(hasArchive ? "a" : "button");
  control.className = "version-download-icon";
  control.textContent = "↧";
  control.title = hasArchive ? `下载${label}完整包` : `${label}暂无已发布完整包`;
  control.setAttribute("aria-label", control.title);
  if (hasArchive) {
    control.href = entry.archiveUrl;
    control.download = "";
  } else {
    control.type = "button";
    control.disabled = true;
  }
  return control;
}

function versionIdentityLabel(label, entry) {
  return [
    label,
    entry?.version ? `v${entry.version}` : "",
    entry?.build !== null && entry?.build !== undefined ? `build ${entry.build}` : "",
  ].filter(Boolean).join(" ");
}

function slotReleaseEntry(slot, historyEntries) {
  const releaseId = typeof slot?.releaseId === "string" ? slot.releaseId : "";
  const version = typeof slot?.version === "string" ? slot.version : "";
  const build = Number.isSafeInteger(slot?.build) ? slot.build : null;
  return historyEntries.find((entry) => releaseId && entry.id === releaseId)
    || historyEntries.find((entry) => entry.slot === slot?.name
      && (!version || entry.version === version)
      && (build === null || entry.build === build));
}

function renderVersionHistory(snapshot) {
  const section = $("version-history");
  const list = $("version-history-list");
  const count = $("version-history-count");
  if (!section || !list || !count) return;
  list.replaceChildren();
  const entries = versionHistoryEntries(snapshot);
  count.textContent = entries.length ? `${entries.length} 个发布版本` : "没有历史记录";
  section.hidden = !snapshot || entries.length === 0;
  if (!entries.length) return;
  for (const entry of entries) {
    const item = document.createElement("article");
    item.className = "version-history-item";
    const main = document.createElement("div");
    main.className = "version-history-item-main";
    const title = document.createElement("div");
    title.className = "version-history-item-title";
    const id = document.createElement("strong");
    id.textContent = entry.id;
    id.title = entry.id;
    const identity = document.createElement("span");
    const channelLabel = entry.channel === "test" ? "测试" : entry.channel === "stable" ? "稳定版" : "发布";
    identity.textContent = [
      channelLabel,
      entry.version ? `v${entry.version}` : "",
      entry.build !== null ? `build ${entry.build}` : "",
    ].filter(Boolean).join(" · ");
    title.append(id, identity);
    const meta = document.createElement("span");
    meta.className = "version-history-item-meta";
    meta.textContent = entry.publishedAt ? `发布时间：${entry.publishedAt}` : "已发布版本";
    const packageSummary = document.createElement("div");
    packageSummary.className = "version-history-item-packages";
    packageSummary.textContent = [
      ...entry.packages.map((pkg) => [
        pkg.id,
        pkg.version ? `v${pkg.version}` : "",
        pkg.build !== null ? `build ${pkg.build}` : "",
      ].filter(Boolean).join(" · ")),
      ...entry.reusedPackages.map((pkg) => [
        `复用 MiniApp ${pkg.id}`,
        pkg.version ? `v${pkg.version}` : "",
        pkg.build !== null ? `build ${pkg.build}` : "",
        pkg.ownerProjectId ? `所属项目 ${pkg.ownerProjectId}` : "",
        pkg.releaseId ? `版本 ${pkg.releaseId}` : "",
      ].filter(Boolean).join(" · ")),
    ].join("；");
    main.append(title, meta, packageSummary);
    const links = document.createElement("div");
    links.className = "version-history-item-links";
    if (entry.appConfigUrl) {
      const configLink = document.createElement("a");
      configLink.href = entry.appConfigUrl;
      configLink.target = "_blank";
      configLink.rel = "noopener";
      configLink.textContent = "版本配置 ↗";
      links.append(configLink);
    }
    if (entry.archiveUrl) {
      links.append(createArchiveDownloadControl(entry, versionIdentityLabel(channelLabel, entry)));
    }
    item.append(main, links);
    list.append(item);
  }
}

async function copyVersionUrl(url, button, label) {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      copied = true;
    } else {
      const input = document.createElement("textarea");
      input.value = url;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      copied = document.execCommand("copy");
      input.remove();
    }
  } catch {}
  if (!copied) {
    showNotice(`无法复制 ${label}，请手动选择完整地址。`, "error");
    return;
  }
  const original = button.textContent;
  button.textContent = "已复制";
  button.setAttribute("aria-label", `${label}已复制`);
  showNotice(`${label}已复制。`, "success");
  setTimeout(() => {
    if (!button.isConnected) return;
    button.textContent = original;
    button.setAttribute("aria-label", `复制 ${label}`);
  }, 1800);
}

function renderVersionManagement() {
  const state = $("version-manager-state");
  const origin = $("version-backend-origin");
  const detail = $("version-backend-detail");
  const slots = $("version-slots");
  const appConfig = $("version-app-config");
  const appConfigLink = $("version-app-config-link");
  const appConfigCopy = $("version-app-config-copy");
  slots.replaceChildren();
  if (appConfig) appConfig.hidden = true;
  if (appConfigLink) {
    appConfigLink.removeAttribute("href");
    appConfigLink.textContent = "";
    appConfigLink.removeAttribute("title");
  }
  if (appConfigCopy) {
    appConfigCopy.disabled = true;
    appConfigCopy.textContent = "复制 App 接入地址";
    appConfigCopy.setAttribute("aria-label", "复制 App 接入地址");
  }
  if (!currentId) {
    renderVersionHistory(null);
    state.textContent = "请选择项目";
    origin.textContent = "尚未启动";
    detail.textContent = "请选择项目以查看已发布版本。";
    slots.append(Object.assign(document.createElement("span"), { className: "muted", textContent: "尚未选择项目。" }));
    return;
  }
  if (versionsLoading) {
    renderVersionHistory(null);
    state.textContent = "加载中…";
    detail.textContent = "正在启动或刷新只读版本服务。";
    slots.append(Object.assign(document.createElement("span"), { className: "muted", textContent: "正在加载版本槽…" }));
    return;
  }
  if (!versionSnapshot) {
    renderVersionHistory(null);
    state.textContent = "打开后加载";
    origin.textContent = "尚未启动";
    detail.textContent = "打开此面板以启动只读版本服务。";
    slots.append(Object.assign(document.createElement("span"), { className: "muted", textContent: "发布测试版或稳定版包后会创建版本槽。" }));
    return;
  }
  origin.textContent = versionSnapshot.origin || "不可用";
  detail.textContent = versionSnapshot.error
    ? `局域网不可用：${versionSnapshot.error}。本机回环地址仍可用。`
    : `${versionSnapshot.lan ? "局域网" : "本机回环"} · 宿主 ${versionSnapshot.hostVersion || "editor"} · 仅签名产物`;
  const publishedCount = (versionSnapshot.slots || []).reduce((count, slot) => count + (slot.packages?.length || 0), 0);
  const historyCount = versionHistoryEntries(versionSnapshot).length;
  state.textContent = historyCount
    ? `${historyCount} 个已发布版本`
    : publishedCount ? `${publishedCount} 个资源包` : "没有版本";
  const appConfigUrl = typeof versionSnapshot.appConfigUrl === "string" ? versionSnapshot.appConfigUrl : "";
  if (appConfig && appConfigLink && appConfigCopy && appConfigUrl) {
    appConfig.hidden = false;
    appConfigLink.href = appConfigUrl;
    appConfigLink.textContent = appConfigUrl;
    appConfigLink.title = appConfigUrl;
    appConfigCopy.disabled = false;
  }
  const historyEntries = versionHistoryEntries(versionSnapshot);
  const rootAppId = $("config-app-id")?.value || "";
  for (const slot of versionSnapshot.slots || []) {
    const card = document.createElement("section");
    card.className = "version-slot";
    const heading = document.createElement("div");
    heading.className = "version-slot-heading";
    const title = document.createElement("strong");
    const slotLabel = slot.name === "test" ? "测试版" : slot.name === "stable" ? "稳定版" : slot.name;
    const rootPackage = (slot.packages || []).find((pkg) => rootAppId && pkg.id === rootAppId) || slot.packages?.[0];
    const slotVersion = typeof slot.version === "string" ? slot.version : rootPackage?.version;
    const slotBuild = Number.isSafeInteger(slot.build) ? slot.build : rootPackage?.build;
    title.textContent = [slotLabel, slotVersion ? `v${slotVersion}` : "", slotBuild !== undefined ? `构建 ${slotBuild}` : ""].filter(Boolean).join(" · ");
    const count = document.createElement("span");
    count.className = "meta-chip";
    const packageCount = slot.packages?.length || 0;
    const reusedPackageCount = slot.reusedPackages?.length || 0;
    count.textContent = reusedPackageCount
      ? `${packageCount} 个自有包 · ${reusedPackageCount} 个复用 MiniApp`
      : `${packageCount} 个资源包`;
    const headingActions = document.createElement("div");
    headingActions.className = "version-slot-heading-actions";
    headingActions.append(count);
    const currentEntry = slotReleaseEntry(slot, historyEntries);
    const archiveEntry = typeof slot.archiveUrl === "string" && slot.archiveUrl
      ? { ...(currentEntry || {}), archiveUrl: slot.archiveUrl, version: slotVersion || currentEntry?.version, build: slotBuild ?? currentEntry?.build }
      : currentEntry;
    headingActions.append(createArchiveDownloadControl(archiveEntry, versionIdentityLabel(slotLabel, archiveEntry || { version: slotVersion, build: slotBuild })));
    heading.append(title, headingActions);
    card.append(heading);
    if (!slot.packages?.length) {
      const slotLabel = slot.name === "test" ? "测试版" : slot.name === "stable" ? "稳定版" : slot.name;
      card.append(Object.assign(document.createElement("span"), { className: "muted", textContent: `尚未发布 ${slotLabel} 资源包。` }));
    }
    for (const pkg of slot.packages || []) {
      const item = document.createElement("div");
      item.className = "version-package";
      const packageTitle = document.createElement("div");
      packageTitle.className = "version-package-title";
      const id = document.createElement("strong");
      id.textContent = pkg.id;
      id.title = pkg.id;
      const identity = document.createElement("span");
      const role = rootAppId && pkg.id === rootAppId ? "主包" : "关联 mini app";
      identity.textContent = `${role} · v${pkg.version} · 构建 ${pkg.build}`;
      packageTitle.append(id, identity);
      item.append(packageTitle);
      card.append(item);
    }
    for (const pkg of slot.reusedPackages || []) {
      const item = document.createElement("div");
      item.className = "version-package";
      const packageTitle = document.createElement("div");
      packageTitle.className = "version-package-title";
      const id = document.createElement("strong");
      id.textContent = `MiniApp ${pkg.id}`;
      id.title = `MiniApp ${pkg.id}`;
      const identity = document.createElement("span");
      identity.textContent = [
        pkg.version ? `v${pkg.version}` : "",
        Number.isSafeInteger(pkg.build) ? `构建 ${pkg.build}` : "",
      ].filter(Boolean).join(" · ");
      packageTitle.append(id, identity);
      item.append(packageTitle);
      const owner = document.createElement("span");
      owner.className = "version-history-item-meta";
      owner.textContent = [
        pkg.ownerProjectId ? `所属项目 ${pkg.ownerProjectId}` : "",
        pkg.releaseId ? `已发布版本 ${pkg.releaseId}` : "",
      ].filter(Boolean).join(" · ");
      item.append(owner);
      card.append(item);
    }
    slots.append(card);
  }
  renderVersionHistory(versionSnapshot);
}

async function loadVersions() {
  if (!currentId || versionsLoading) return;
  const projectId = currentId;
  const generation = ++versionsGeneration;
  versionsLoading = true;
  renderVersionManagement();
  updateActionStates();
  try {
    const snapshot = await api(`/api/projects/${encodeURIComponent(projectId)}/versions`);
    if (currentId !== projectId || generation !== versionsGeneration) return;
    versionSnapshot = snapshot;
  } catch (error) {
    if (currentId === projectId && generation === versionsGeneration) {
      // A failed refresh must not leave a previous project's successful slots/history visible.
      versionSnapshot = null;
      showNotice(error);
    }
  } finally {
    if (currentId === projectId && generation === versionsGeneration) {
      versionsLoading = false;
      renderVersionManagement();
      updateActionStates();
    }
  }
}

function renderArtifacts(status) {
  const artifacts = $("artifacts");
  artifacts.replaceChildren();
  const runtimeAbi = $("runtime-abi");
  const publishInfo = $("publish-info");
  const publishStatus = $("publish-status");
  const testPublishInfo = $("test-publish-info");
  const publish = status?.publish;
  runtimeAbi.textContent = status?.publish?.runtimeAbi || "ABI —";
  publishInfo.replaceChildren();
  publishInfo.hidden = true;
  testPublishInfo.replaceChildren();
  testPublishInfo.hidden = true;
  if (!publish) {
    publishStatus.textContent = "尚未发布";
  } else {
    const channel = publish.channel === "test" ? "测试包" : "稳定版";
    const identity = [publish.version ? `v${publish.version}` : "", publish.build !== undefined ? `build ${publish.build}` : ""].filter(Boolean).join(" · ");
    publishStatus.textContent = `最近${channel}已就绪${identity ? ` · ${identity}` : ""} · 修订版 r${publish.revision ?? status.revision ?? "—"}`;
  }
  if (!status?.artifacts) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "完成真实 QuickJS 构建后，构建产物会显示在这里。";
    artifacts.append(empty);
    return;
  }
  const names = [
    ["app.qjbc", status.artifacts.bytecode],
    ["app.bytecode.json", status.artifacts.metadata],
    ["app.pak", status.artifacts.pak],
    ["guest-manifest.json", status.artifacts.manifest],
    ["app.js (inspection)", status.artifacts.appJs],
    ["build.json", status.artifacts.build],
  ];
  for (const [name, href] of names) {
    if (!href) continue;
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
    const title = document.createElement("span");
    title.textContent = name;
    const download = document.createElement("small");
    download.textContent = "下载 ↗";
    link.append(title, download);
    artifacts.append(link);
  }
  if (publish) {
    const key = document.createElement("span");
    key.textContent = `密钥 ${publish.keyId || "本地"}`;
    publishInfo.append(key);
    if (publish.channel) {
      const channel = document.createElement("span");
      channel.textContent = publish.channel === "test" ? "频道：测试" : "频道：发布";
      publishInfo.append(channel);
    }
    if (publish.lanOrigin) {
      const lan = document.createElement("span");
      lan.textContent = `局域网 ${publish.lanOrigin}`;
      publishInfo.append(lan);
    }
    if (publish.version || publish.build !== undefined) {
      const identity = document.createElement("span");
      identity.textContent = [publish.version ? `v${publish.version}` : "", publish.build !== undefined ? `构建 ${publish.build}` : ""].filter(Boolean).join(" · ");
      publishInfo.append(identity);
    }
    const links = [
      ["下载 tar.gz ↗", publish.archiveUrl],
    ];
    for (const [label, href] of links) {
      if (!href) continue;
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = label;
      publishInfo.append(link);
    }
    publishInfo.hidden = false;
    if (publish.channel === "test") {
      const heading = document.createElement("strong");
      heading.textContent = `测试包 ${publish.version ? `v${publish.version}` : ""}${publish.build !== undefined ? ` · 构建 ${publish.build}` : ""} 已就绪。`;
      const first = document.createElement("span");
      first.textContent = publish.lanOrigin
        ? `局域网版本服务：${publish.lanOrigin}。仅配置版本面板的固定 latest.json 接入地址，容器会自动读取最新版本及关联子包。`
        : "没有可用的局域网接口，因此此包通过本机回环地址提供，用于模拟器/桌面测试。";
      const second = document.createElement("span");
      second.textContent = "然后打开 Demo Host → 更新 → 检查 → 应用。后续测试包不需要重新构建 Flutter。";
      const caveat = document.createElement("span");
      caveat.textContent = "局域网只暴露签名资源包；编辑器 API、源文件和签名密钥仍仅限本机回环地址。";
      testPublishInfo.append(heading, first, second, caveat);
      testPublishInfo.hidden = false;
    }
  }
}

function renderStatus(status) {
  currentStatus = status || null;
  const publishTarget = activePublishTarget();
  if (publishTarget?.projectId === currentId && currentStatus) {
    publishTarget.revision = currentStatus.revision;
    publishTarget.builtRevision = currentStatus.builtRevision;
    publishTarget.busy = Boolean(currentStatus.busy);
    publishTarget.built = currentStatus.builtRevision === currentStatus.revision && !currentStatus.error;
    if (publishTarget.kind === "root") {
      publishTarget.version = $("config-version")?.value || publishTarget.version;
      publishTarget.build = Number($("config-build")?.value ?? publishTarget.build);
    }
    renderPublishTargetPicker();
  }
  setText("source-revision", `修订版 ${status?.revision ?? "—"}`);
  const state = $("build-state");
  if (!status) {
    state.textContent = "尚未构建";
    state.className = "meta-chip";
  } else if (status.busy) {
    state.textContent = `正在构建 r${status.revision}`;
    state.className = "meta-chip";
  } else if (status.error) {
    state.textContent = "构建失败";
    state.className = "meta-chip bad";
  } else if (status.builtRevision === status.revision) {
    state.textContent = `已构建 r${status.revision}`;
    state.className = "meta-chip good";
  } else {
    state.textContent = "修改尚未构建";
    state.className = "meta-chip";
  }
  logEl.textContent = status?.logs?.join("\n") || "暂无诊断信息。";
  logEl.scrollTop = logEl.scrollHeight;
  renderArtifacts(status);
  renderResourceState();
  if (!dirty) markDirty(false);
  else updateActionStates();
  maybeRefreshPreview(status);
}

async function refreshStatus(projectId = currentId) {
  if (!projectId) return null;
  const status = await api(`/api/projects/${encodeURIComponent(projectId)}/status`);
  if (currentId !== projectId) return null;
  renderStatus(status);
  return status;
}

function stopBuildPolling() {
  if (buildPollTimer) clearTimeout(buildPollTimer);
  buildPollTimer = null;
}

async function pollBuild(attempt = 0) {
  if (!currentId || attempt > MAX_BUILD_POLL_ATTEMPTS) {
    stopBuildPolling();
    return;
  }
  const projectId = currentId;
  try {
    const status = await refreshStatus(projectId);
    if (currentId !== projectId) return;
    if (status?.busy) {
      buildPollTimer = setTimeout(() => void pollBuild(attempt + 1), POLL_DELAY_MS);
    } else {
      stopBuildPolling();
      if (status?.builtRevision === status?.revision && !status?.error) {
        void loadResources(projectId).catch(showNotice);
      }
      void refreshPublishTargets();
    }
  } catch (error) {
    stopBuildPolling();
    showNotice(error);
  }
}

async function selectProject(id, options = {}) {
  if (currentId === id) return;
  if (saving || publishing || startingBuild || currentStatus?.busy || publishTargetsLoading) {
    showNotice("请先等待当前保存、构建、发布或目标刷新完成，再切换项目。", "info");
    return;
  }
  if (activeDeploy || startingDeploy) {
    showNotice("请先完成或取消当前部署，再切换项目。", "info");
    return;
  }
  if ((dirty || resourcesDirty) && currentId !== id && !window.confirm("放弃未保存的源文件或资源修改？")) return;
  clearNotice();
  publishTargetContext = options.publishTargetContext || null;
  if (projectSwitcher) projectSwitcher.open = false;
  stopBuildPolling();
  stopDeployPolling();
  invalidateWechatRequests();
  const selectionGeneration = wechatGeneration;
  currentId = id;
  const targetsProjectId = options.publishTargetContext?.sourceProjectId || id;
  publishTargets = null;
  publishTargetsLoading = true;
  publishTargetsError = "";
  const targetGeneration = ++publishTargetsGeneration;
  renderPublishTargetPicker();
  versionSnapshot = null;
  versionsLoading = false;
  versionsGeneration += 1;
  renderVersionManagement();
  resetResources();
  currentFile = "app.tsx";
  currentStatus = null;
  previewPath = `/api/projects/${encodeURIComponent(id)}/preview`;
  previewReady = false;
  previewHasFrame = false;
  previewStarted = false;
  previewRevision = null;
  previewGeneration = null;
  resetPreviewSurface();
  resetWechatPresentation();
  markDirty(false);
  renderProjects();
  setEnabled(false);
  resourcesLoading = true;
  renderResourceState();
  try {
    const [config, files, status, resources, targetResult] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(id)}/config`),
      api(`/api/projects/${encodeURIComponent(id)}/files`),
      api(`/api/projects/${encodeURIComponent(id)}/status`),
      fetchResources(id),
      api(`/api/projects/${encodeURIComponent(targetsProjectId)}/publish-targets?channel=${encodeURIComponent(publishTargetChannel)}`)
        .then((payload) => ({ payload }))
        .catch((error) => ({ error })),
    ]);
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    updateProjectHeading(projects.find((project) => project.id === id), config);
    $("config-name").value = config.name || "";
    $("config-app-id").value = config.appId || "";
    $("config-version").value = config.version || "";
    $("config-build").value = config.build ?? 0;
    $("config-tick").value = config.tickHz ?? 60;
    if (targetGeneration === publishTargetsGeneration) {
      setPublishTargets(targetResult.payload, targetResult.error);
      publishTargetsLoading = true;
      updateActionStates();
    }
    const fileList = files.files || files;
    renderFilePicker(fileList);
    await loadFile(projectFiles.includes(config.entry) ? config.entry : projectFiles.includes("app.tsx") ? "app.tsx" : projectFiles[0]);
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    resourcesLoading = false;
    setResourceInventory(resources);
    setEnabled(true);
    renderStatus(status);
    if (targetGeneration === publishTargetsGeneration) {
      publishTargetsLoading = false;
      updateActionStates();
    }
    if (status?.busy) buildPollTimer = setTimeout(() => void pollBuild(), POLL_DELAY_MS);
    await loadWechat(id, selectionGeneration);
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    await resumeDeployment(id);
  } catch (error) {
    if (targetGeneration === publishTargetsGeneration) {
      publishTargetsLoading = false;
      publishTargets = null;
      publishTargetsError = String(error?.message || error);
      renderPublishTargetPicker();
    }
    resourcesLoading = false;
    resetResources();
    setEnabled(false);
    showNotice(error);
  }
}

function setEnabled(enabled) {
  sourceEl.disabled = !enabled;
  $("file-picker").disabled = !enabled;
  for (const id of ["config-name", "config-app-id", "config-version", "config-build", "config-tick"]) $(id).disabled = !enabled;
  if ($("source-toggle")) $("source-toggle").disabled = !enabled;
  if ($("source-split-toggle")) $("source-split-toggle").disabled = !enabled;
  updateActionStates();
}

async function loadProjects(preferred) {
  let configuredProjectId;
  try {
    const health = await api("/health");
    if (health?.csrfToken) csrfToken = health.csrfToken;
    if (health?.version && !studioUpgradeState) {
      renderStudioUpgrade({ currentVersion: health.version, status: "checking" });
    }
    configuredProjectId = health?.projectId;
    localBluetoothAvailable = health?.bluetooth?.local === true;
    bluetoothProvider = "local";
    nobleBluetoothSupported = localBluetoothAvailable;
    updateBluetoothSettings();
  } catch {
    // The editor credential still lets local development continue.
  }
  const response = await api("/api/projects");
  projects = Array.isArray(response) ? response : response.projects || [];
  renderProjects();
  const id = preferred || currentId || configuredProjectId || projects[0]?.id;
  if (id && projects.some((project) => project.id === id)) await selectProject(id);
  else {
    invalidateWechatRequests();
    currentId = null;
    publishTargetContext = null;
    publishTargets = null;
    publishTargetsLoading = false;
    publishTargetsError = "";
    publishTargetsGeneration += 1;
    renderPublishTargetPicker();
    versionSnapshot = null;
    versionsLoading = false;
    versionsGeneration += 1;
    renderVersionManagement();
    resetResources();
    resetWechatPresentation();
    setEnabled(false);
    setText("project-title", "请选择项目");
    setText("project-subtitle", "创建 SDK 项目、编辑 JS 界面并在本地预览。");
    setProjectState("未选择项目");
  }
}

async function saveProject() {
  if (!currentId || saving) return;
  clearNotice();
  saving = true;
  setText("save-status", "保存中…");
  updateActionStates();
  try {
    const source = await api(fileUrl(currentId, currentFile), {
      method: "PUT",
      body: JSON.stringify({ content: sourceEl.value }),
    });
    const config = await api(`/api/projects/${encodeURIComponent(currentId)}/config`, {
      method: "PUT",
      body: JSON.stringify({
        name: $("config-name").value,
        appId: $("config-app-id").value,
        version: $("config-version").value,
        build: Number($("config-build").value),
        tickHz: Number($("config-tick").value),
      }),
    });
    setText("source-bytes", `${Number(source.bytes || 0).toLocaleString()} 字节`);
    updateProjectHeading(projects.find((project) => project.id === currentId), config);
    markDirty(false);
    projects = (await api("/api/projects")) || projects;
    renderProjects();
    renderStatus(config.status);
    void refreshPublishTargets();
  } catch (error) {
    setText("save-status", "保存失败");
    showNotice(error);
    throw error;
  } finally {
    saving = false;
    updateActionStates();
    resumeDeferredStudioUpgrade();
  }
}

async function buildProject() {
  if (!currentId || currentStatus?.busy || startingBuild) return;
  const projectId = currentId;
  clearNotice();
  try {
    if (dirty) await saveProject();
    if (currentId !== projectId) return;
    if (resourcesDirty) {
      showNotice("构建前请先保存资源策略。", "info");
      return;
    }
    startingBuild = true;
    updateActionStates();
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/build`, { method: "POST", body: "{}" });
    if (currentId !== projectId) return;
    renderStatus(result.status || result);
    stopBuildPolling();
    void pollBuild();
  } catch (error) {
    if (currentId === projectId) showNotice(error);
  } finally {
    startingBuild = false;
    updateActionStates();
  }
}

async function publishProject(channel = publishTargetChannel) {
  if (!currentId || publishing) return;
  const selectedTarget = activePublishTarget();
  if (selectedTarget?.kind === "reused") {
    if (selectedTarget.canSelect === false || !selectedTarget.ownerProjectId) {
      showNotice(selectedTarget.reason || `MiniApp ${selectedTarget.appId} 没有可用的所属项目。`, "error");
      return;
    }
    const ownerProjectId = selectedTarget.ownerProjectId;
    if (ownerProjectId !== currentId) {
      showNotice(`请从发布目标中选择 MiniApp ${selectedTarget.title || selectedTarget.appId}，先打开其所属项目。`, "info");
      return;
    }
  }
  const projectId = currentId;
  if (dirty) {
    showNotice("发布前请先保存源文件修改。", "info");
    return;
  }
  clearNotice();
  publishing = true;
  setPublishEditorLocked(true);
  $("publish-status").textContent = channel === "test" ? "正在发布签名测试包…" : "正在发布签名版本…";
  updateActionStates();
  try {
    const freshStatus = await api(`/api/projects/${encodeURIComponent(projectId)}/status`);
    if (currentId !== projectId) return;
    renderStatus(freshStatus);
    if (dirty) {
      showNotice("发布前请先保存源文件修改。", "info");
      return;
    }
    if (!freshStatus || freshStatus.busy || freshStatus.builtRevision !== freshStatus.revision || freshStatus.error) {
      showNotice("发布前请先构建已保存的项目。", "info");
      return;
    }
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/publish`, {
      method: "POST",
      body: JSON.stringify({ channel }),
    });
    if (currentId !== projectId) return;
    renderStatus(result.status || result);
    versionSnapshot = null;
    if (versionsLoading) {
      versionsGeneration += 1;
      versionsLoading = false;
    }
    void loadVersions();
    if (!resourcesDirty) {
      void loadResources(projectId).catch(showNotice);
    }
    void refreshPublishTargets();
    showNotice(`${channel === "test" ? "测试" : "稳定版"}资源包已发布。`, "success");
  } catch (error) {
    if (currentId === projectId) {
      setText("publish-status", `${channel === "test" ? "测试" : "稳定版"}发布失败`);
      showNotice(error);
    }
  } finally {
    publishing = false;
    setPublishEditorLocked(false);
    updateActionStates();
  }
}

function setPreviewState(label, kind = "") {
  const state = $("preview-state");
  state.innerHTML = `<i></i>${label}`;
  state.className = `live-chip${kind ? ` ${kind}` : ""}`;
}

function resetPreviewSurface() {
  previewFrame.hidden = true;
  previewFrame.src = "about:blank";
  previewRegionsEnabled = false;
  $("preview-empty").hidden = false;
  setPreviewState("等待中");
  updateActionStates();
}

function maybeRefreshPreview(status) {
  if (!status || status.busy || status.error || status.builtRevision !== status.revision || dirty) return;
  if (previewStarted && previewRevision === status.builtRevision && previewGeneration === (status.artifacts?.generation ?? status.finishedAt ?? null)) return;
  void refreshPreview({ automatic: true });
}

async function refreshPreview({ automatic = false } = {}) {
  if (!currentId) return;
  if (dirty) {
    if (!automatic) showNotice("刷新预览前请先保存源文件修改。", "info");
    return;
  }
  if (!currentStatus || currentStatus.builtRevision !== currentStatus.revision || currentStatus.error) {
    if (!automatic) showNotice("刷新预览前请先构建已保存的项目。", "info");
    return;
  }
  clearNotice();
  previewReady = false;
  previewHasFrame = false;
  setPreviewState("加载中", "loading");
  $("preview-empty").hidden = true;
  previewFrame.hidden = false;
  layoutPreviewFrame();
  const url = previewBrowserUrl();
  url.searchParams.set("t", String(Date.now()));
  previewFrame.src = url.href;
  previewStarted = true;
  previewRevision = currentStatus.builtRevision;
  previewGeneration = currentStatus.artifacts?.generation ?? currentStatus.finishedAt ?? null;
  updateActionStates();
}

function previewBrowserUrl() {
  const url = new URL(previewPath, window.location.origin);
  if (previewRegionsEnabled) url.searchParams.set("regions", "1");
  if (webBluetoothEnabled) { url.searchParams.set("webBluetooth", "1"); url.searchParams.set("bluetoothProvider", "local"); }
  return url;
}

function sendPreviewPlugins() {
  previewFrame.contentWindow?.postMessage({ source: "pocket-editor", type: "preview.plugins", webBluetooth: webBluetoothEnabled, bluetoothProvider }, window.location.origin);
}

function captureFromMessage(message) {
  const requestId = message.requestId || message.id;
  const dataUrl = message.dataUrl || message.imageDataUrl || message.screenshot || (typeof message.data === "string" && message.data.startsWith("data:image/") ? message.data : "");
  if (!requestId || !dataUrl) return false;
  const waiter = captureWaiters.get(requestId);
  if (!waiter) return false;
  captureWaiters.delete(requestId);
  waiter.resolve({
    dataUrl,
    width: Number.isFinite(Number(message.width)) ? Number(message.width) : undefined,
    height: Number.isFinite(Number(message.height)) ? Number(message.height) : undefined,
    logicalWidth: Number.isFinite(Number(message.logicalWidth)) ? Number(message.logicalWidth) : undefined,
    logicalHeight: Number.isFinite(Number(message.logicalHeight)) ? Number(message.logicalHeight) : undefined,
  });
  return true;
}

async function capturePreview() {
  if (!previewReady || previewFrame.hidden) throw new Error("请先刷新预览，再截取截图。");
  const requestId = `capture-${Date.now()}-${++captureSequence}`;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captureWaiters.delete(requestId);
      reject(new Error("预览没有返回截图，请刷新后重试。"));
    }, 1800);
    captureWaiters.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
  previewFrame.contentWindow?.postMessage({ source: "pocket-editor", type: "preview.capture", requestId, scale: 1 }, window.location.origin);
  const result = await promise;
  const capture = typeof result === "string" ? { dataUrl: result } : result;
  const dataUrl = capture.dataUrl;
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)) throw new Error("预览截图必须是 PNG、JPEG 或 WebP 图片。");
  return { ...capture, dataUrl, type: dataUrl.slice(5, dataUrl.indexOf(";")) };
}

function downloadPreviewCapture(capture) {
  const link = document.createElement("a");
  link.href = capture.dataUrl;
  link.download = `${currentId || "pocket-preview"}.png`;
  link.click();
}

async function copyPreviewLink() {
  if (!previewPath) {
    showNotice("复制预览地址前请先选择项目。", "info");
    return;
  }
  if (!currentStatus || currentStatus.builtRevision !== currentStatus.revision || currentStatus.error || dirty) {
    showNotice("复制预览地址前请先构建已保存的项目。", "info");
    return;
  }
  const urlObject = previewBrowserUrl();
  const url = urlObject.href;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("此浏览器不支持剪贴板访问。");
    await navigator.clipboard.writeText(url);
    showNotice("预览地址已复制，可直接在 Codex 浏览器中打开。", "success");
  } catch (error) {
    showNotice(error);
  }
}

function setViewport(value) {
  previewStage.classList.remove("viewport-mobile", "viewport-tablet", "viewport-desktop");
  previewStage.classList.add(`viewport-${value}`);
  updatePreviewPhoneShell(value);
  layoutPreviewFrame();
  resizePreviewRuntime();
  sendPreviewRegions();
}

function safeAreaForViewport(viewportKey) {
  const safeArea = VIEWPORTS[viewportKey]?.safeArea;
  return safeArea ? { ...safeArea } : { top: 0, right: 0, bottom: 0, left: 0 };
}

function updatePreviewPhoneShell(viewportKey = $("viewport-picker")?.value || "mobile") {
  const visible = viewportKey === "mobile" && Boolean(previewDeviceProfile);
  previewPhoneShell?.toggleAttribute("hidden", !visible);
  previewStage?.classList.toggle("preview-phone-frame", visible);
  if (previewPhoneShell) previewPhoneShell.setAttribute("aria-hidden", "true");
}

function updatePreviewBezelPresentation(viewportKey = $("viewport-picker")?.value || "mobile") {
  const canvasBezel = Boolean(previewDeviceProfile) && viewportKey === "mobile" && previewBezelEnabled;
  previewStage?.classList.toggle("preview-bezel-enabled", canvasBezel);
  wechatPreviewShell?.classList.toggle("preview-bezel-enabled", previewBezelEnabled);
}

function layoutPreviewFrame() {
  const viewportKey = $("viewport-picker").value;
  const viewport = VIEWPORTS[viewportKey] || VIEWPORTS.mobile;
  if (!viewport || !Number.isFinite(viewport.width) || viewport.width <= 0 || !Number.isFinite(viewport.height) || viewport.height <= 0) return;
  updatePreviewPhoneShell(viewportKey);
  updatePreviewBezelPresentation(viewportKey);
  const wrapStyle = previewStageWrap ? getComputedStyle(previewStageWrap) : null;
  const horizontalPadding = wrapStyle ? Number.parseFloat(wrapStyle.paddingLeft || "0") + Number.parseFloat(wrapStyle.paddingRight || "0") : 0;
  const verticalPadding = wrapStyle ? Number.parseFloat(wrapStyle.paddingTop || "0") + Number.parseFloat(wrapStyle.paddingBottom || "0") : 0;
  const availableWidth = Math.max(1, (previewStageWrap?.clientWidth || previewStage.getBoundingClientRect().width) - horizontalPadding);
  const gridStyle = previewSurfaces ? getComputedStyle(previewSurfaces) : null;
  const gridColumns = gridStyle?.gridTemplateColumns.split(/\s+/).map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value) && value > 0) || [];
  const stageWidth = gridColumns[0] || availableWidth;
  const targetWrapHeight = Number.isFinite(previewPaneHeight) && previewPaneHeight > 0
    ? previewPaneHeight
    : (previewStageWrap?.clientHeight || previewStage.getBoundingClientRect().height);
  const availableHeight = Math.max(1, targetWrapHeight - verticalPadding);
  // The selected viewport remains the logical width/height sent to the
  // guest. Only the presentation scale changes with the available pane size;
  // cap it at 1 so a tall pane never invents a larger logical viewport.
  const scale = Math.min(stageWidth / viewport.width, availableHeight / viewport.height, 1);
  if (!Number.isFinite(scale) || scale <= 0) return;
  const targetStageWidth = Math.round(viewport.width * scale);
  const targetStageHeight = Math.round(viewport.height * scale);
  previewStage.style.transition = "none";
  previewStage.style.width = `${targetStageWidth}px`;
  previewStage.style.height = `${targetStageHeight}px`;
  previewStage.style.aspectRatio = "auto";
  previewFrame.style.width = `${viewport.width}px`;
  previewFrame.style.height = `${viewport.height}px`;
  previewFrame.style.transform = `scale(${scale})`;
  if (viewportKey === "mobile" && previewDeviceProfile && previewPhoneShell) {
    const { screenWidth, screenHeight, shell } = previewDeviceProfile;
    // The shell is kept in the runner's logical coordinate space and scaled
    // exactly like the guest iframe. This keeps notch/status/home geometry and
    // pointer coordinates aligned when the pane is narrow or short.
    previewPhoneShell.style.width = `${screenWidth}px`;
    previewPhoneShell.style.height = `${screenHeight}px`;
    previewPhoneShell.style.borderRadius = `${shell.borderRadius}px`;
    previewPhoneShell.style.transformOrigin = "top left";
    previewPhoneShell.style.transform = `scale(${scale})`;
    previewStage.style.setProperty("--preview-phone-radius", `${shell.borderRadius * scale}px`);
    previewStage.style.setProperty("--preview-phone-bezel", `${shell.bezel * scale}px`);
  } else if (previewPhoneShell) {
    previewPhoneShell.style.removeProperty("width");
    previewPhoneShell.style.removeProperty("height");
    previewPhoneShell.style.removeProperty("border-radius");
    previewPhoneShell.style.removeProperty("transform");
    previewPhoneShell.style.removeProperty("transform-origin");
    previewStage.style.removeProperty("--preview-phone-radius");
    previewStage.style.removeProperty("--preview-phone-bezel");
  }
  layoutWechatPreview();
}

function layoutWechatPreview() {
  if (!wechatPreviewPane || wechatPreviewPane.hidden || !previewStageWrap || !previewSurfaces) return;
  const slot = previewStage.getBoundingClientRect();
  const width = Math.max(1, Math.round(slot.width));
  const height = Math.max(1, Math.round(slot.height));
  wechatPreviewPane.style.width = `${width}px`;
  wechatPreviewPane.style.height = `${height}px`;
  const viewport = wechatPreviewPane.querySelector(".wechat-preview-viewport");
  if (viewport) {
    viewport.style.width = `${width}px`;
    viewport.style.height = `${height}px`;
    viewport.style.aspectRatio = "auto";
  }
  layoutWechatFrame();
}

function layoutWechatFrame() {
  if (!wechatPreviewFrame || !wechatPreviewPane || wechatPreviewPane.hidden) return;
  const viewport = wechatPreviewPane.querySelector(".wechat-preview-viewport");
  const width = viewport?.clientWidth || wechatPreviewPane.clientWidth;
  const height = viewport?.clientHeight || wechatPreviewPane.clientHeight;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;
  const device = previewDeviceProfile;
  if (!device) return;
  const screenWidth = device.screenWidth;
  const screenHeight = device.screenHeight;
  const scale = Math.min(width / screenWidth, height / screenHeight);
  const renderedWidth = screenWidth * scale;
  const renderedHeight = screenHeight * scale;
  wechatPreviewFrame.style.width = `${screenWidth}px`;
  wechatPreviewFrame.style.height = `${screenHeight}px`;
  wechatPreviewFrame.style.left = `${Math.max(0, (width - renderedWidth) / 2)}px`;
  wechatPreviewFrame.style.top = `${Math.max(0, (height - renderedHeight) / 2)}px`;
  wechatPreviewFrame.style.transformOrigin = "top left";
  wechatPreviewFrame.style.transform = `scale(${scale})`;
  if (wechatPreviewShell) {
    wechatPreviewShell.style.setProperty("--wechat-device-radius", `${device.shell.borderRadius * scale}px`);
    wechatPreviewShell.style.setProperty("--wechat-device-bezel", `${device.shell.bezel * scale}px`);
  }
}

function resizePreviewRuntime() {
  const viewport = VIEWPORTS[$("viewport-picker").value] || VIEWPORTS.mobile;
  if (!viewport || !Number.isFinite(viewport.width) || viewport.width <= 0 || !Number.isFinite(viewport.height) || viewport.height <= 0) return;
  previewFrame.contentWindow?.postMessage({
    source: "pocket-editor",
    type: "preview.resize",
    width: viewport.width,
    height: viewport.height,
    safeArea: safeAreaForViewport($("viewport-picker").value),
  }, window.location.origin);
}

function sendPreviewRegions() {
  previewFrame.contentWindow?.postMessage({ source: "pocket-editor", type: "preview.regions", enabled: previewRegionsEnabled }, window.location.origin);
}

function setupPreviewHeightControl() {
  const handle = $("resize-preview-height");
  if (!handle || !previewStageWrap) return;
  const min = 240;
  const max = 1200;
  const read = () => previewPaneHeight ?? Math.round(previewStageWrap.getBoundingClientRect().height || 390);
  const apply = (value, persist = true) => {
    const next = Math.round(Math.max(min, Math.min(max, Number(value) || min)));
    previewPaneHeight = next;
    previewStageWrap.style.setProperty("--preview-height", `${next}px`);
    handle.setAttribute("aria-valuenow", String(next));
    if (persist) {
      try { localStorage.setItem(PREVIEW_HEIGHT_STORAGE_KEY, String(next)); } catch {}
    }
    layoutPreviewFrame();
  };
  let drag;
  const finish = (event) => {
    if (!drag) return;
    apply(drag.initial + event.clientY - drag.start);
    drag = undefined;
    handle.classList.remove("dragging");
    handle.releasePointerCapture?.(event.pointerId);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { initial: read(), start: event.clientY };
    handle.classList.add("dragging");
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag) apply(drag.initial + event.clientY - drag.start, false);
  });
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", (event) => {
    const current = read();
    let next = current;
    if (event.key === "ArrowUp") next = current - 20;
    else if (event.key === "ArrowDown") next = current + 20;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else return;
    event.preventDefault();
    apply(next);
  });
  if (previewPaneHeight !== null) apply(previewPaneHeight, false);
  else handle.setAttribute("aria-valuenow", String(read()));
}

function renderDevices() {
  const picker = $("device-picker");
  picker.replaceChildren();
  if (!devices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有可用设备";
    picker.append(option);
    setText("device-help", "没有可用的模拟器或已连接设备。");
  } else {
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.id;
      option.disabled = device.supported === false || device.available === false;
      const kind = device.emulator ? "模拟器" : "已连接设备";
      option.textContent = `${device.name || device.id} · ${device.platform || "未知平台"} · ${kind}${option.disabled ? " · 不支持" : ""}`;
      picker.append(option);
    }
    setText("device-help", "部署会把最新构建包发送到选中的本地目标。");
  }
  updateActionStates();
}

async function loadDevices() {
  try {
    const response = await api("/api/devices");
    devices = Array.isArray(response) ? response : response.devices || [];
  } catch (error) {
    devices = [];
    setText("device-help", `设备发现不可用：${normalizeError(error).message}`);
  }
  renderDevices();
}

function stopDeployPolling() {
  if (deployPollTimer) clearTimeout(deployPollTimer);
  deployPollTimer = null;
  activeDeploy = null;
  updateActionStates();
}

function renderDeploy(job) {
  const status = String(job?.status || "").toLowerCase();
  const terminal = ["completed", "success", "succeeded", "failed", "error", "cancelled", "canceled"].includes(status);
  const state = $("deploy-state");
  const statusLabels = { queued: "排队中", building: "构建中", starting: "启动中", running: "运行中", completed: "已完成", success: "成功", succeeded: "成功", failed: "失败", error: "错误", cancelled: "已取消", canceled: "已取消", stopping: "停止中" };
  state.textContent = statusLabels[status] || (status ? status : "排队中");
  state.className = `meta-chip${terminal && ["failed", "error"].includes(status) ? " bad" : terminal ? " good" : ""}`;
  const logs = Array.isArray(job?.logs) ? job.logs : job?.logs ? [job.logs] : [];
  $("deploy-log").textContent = logs.join("\n") || job?.error || (status ? `任务状态：${status}` : "等待部署状态…");
  $("deploy-log").scrollTop = $("deploy-log").scrollHeight;
}

async function resumeDeployment(projectId) {
  const result = await api(`/api/projects/${encodeURIComponent(projectId)}/deploy`);
  if (currentId !== projectId) return;
  const jobs = result.jobs || [];
  const job = jobs.find((item) => ["queued", "building", "starting", "running", "stopping"].includes(item.status));
  if (!job) return;
  activeDeploy = { id: job.id, status: job.status };
  renderDeploy(job);
  updateActionStates();
  if (job.status !== "running") void pollDeploy();
}

async function pollDeploy(attempt = 0) {
  if (!currentId || !activeDeploy || attempt > MAX_DEPLOY_POLL_ATTEMPTS) {
    stopDeployPolling();
    return;
  }
  try {
    const job = await api(`/api/projects/${encodeURIComponent(currentId)}/deploy/${encodeURIComponent(activeDeploy.id)}`);
    renderDeploy(job);
    const status = String(job?.status || "").toLowerCase();
    activeDeploy.status = status;
    if (["completed", "success", "succeeded", "failed", "error", "cancelled", "canceled"].includes(status)) {
      activeDeploy = null;
      deployPollTimer = null;
      updateActionStates();
      return;
    }
    // A running Flutter process is a successful deploy. Keep the Stop button
    // available, but stop polling its logs to avoid a background hot loop.
    if (status === "running") {
      deployPollTimer = null;
      updateActionStates();
      return;
    }
    deployPollTimer = setTimeout(() => void pollDeploy(attempt + 1), POLL_DELAY_MS);
  } catch (error) {
    stopDeployPolling();
    showNotice(error);
  }
}

async function deployProject() {
  if (!currentId || !$("device-picker").value || activeDeploy || startingDeploy) return;
  if (dirty) {
    try { await saveProject(); } catch { return; }
  }
  if (currentStatus?.builtRevision !== currentStatus?.revision || currentStatus?.error) {
    showNotice("部署前请先构建已保存的项目。", "info");
    return;
  }
  clearNotice();
  startingDeploy = true;
  updateActionStates();
  try {
    setText("deploy-state", "启动中…");
    const result = await api(`/api/projects/${encodeURIComponent(currentId)}/deploy`, {
      method: "POST",
      body: JSON.stringify({ deviceId: $("device-picker").value }),
    });
    const job = result.job || result;
    const jobId = job.id || result.id;
    if (!jobId) throw new Error("部署没有返回任务 ID。");
    activeDeploy = { id: jobId };
    renderDeploy(job);
    void pollDeploy();
    updateActionStates();
  } catch (error) {
    setText("deploy-state", "失败");
    showNotice(error);
  } finally {
    startingDeploy = false;
    updateActionStates();
  }
}

async function cancelDeploy() {
  if (!currentId || !activeDeploy) return;
  const id = activeDeploy.id;
  try {
    await api(`/api/projects/${encodeURIComponent(currentId)}/deploy/${encodeURIComponent(id)}`, { method: "DELETE" });
    renderDeploy({ status: "cancelled", logs: ["部署已取消。"] });
  } catch (error) {
    showNotice(error);
  } finally {
    stopDeployPolling();
  }
}

function refreshSourceFromServer() {
  if (!currentId) return;
  if (dirty && !window.confirm("放弃当前未保存草稿并重新加载源文件？")) return;
  clearNotice();
  void refreshFiles({ preserveDraft: false }).catch(showNotice);
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== previewFrame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "preview.ready") {
    previewReady = false;
    previewHasFrame = false;
    resizePreviewRuntime();
    sendPreviewRegions();
    sendPreviewPlugins();
    setPreviewState("启动中", "loading");
    updateActionStates();
  }
  if (data.type === "preview.frame") {
    previewHasFrame = true;
    previewReady = true;
    sendPreviewRegions();
    setPreviewState("就绪", "ready");
    updateActionStates();
  }
  if (data.type === "preview.status") {
    const status = typeof data.status === "string" ? data.status : data.status?.state;
    if (status === "error" || status === "stopped") {
      previewReady = false;
      setPreviewState(status === "error" ? "预览错误" : "已停止", "loading");
      if (status === "error") showNotice(data.error || data.status?.error || "原生预览报告了错误。");
    } else if (status === "starting") {
      previewReady = false;
      setPreviewState("启动中", "loading");
    } else if (status === "reconnecting") {
      previewReady = false;
      setPreviewState("重连中…", "loading");
    } else if (status === "ready" && previewHasFrame) {
      previewReady = true;
      setPreviewState("就绪", "ready");
    }
    updateActionStates();
  }
  if (data.type === "preview.error") {
    previewReady = false;
    setPreviewState("预览错误", "loading");
    showNotice(data.error || "原生预览报告了错误。");
    updateActionStates();
  }
  if (data.type === "preview.capture.result") captureFromMessage(data);
});

previewFrame.addEventListener("load", () => {
  if (previewFrame.src === "about:blank") return;
  layoutPreviewFrame();
  previewReady = false;
  previewHasFrame = false;
  sendPreviewRegions();
  setPreviewState("启动中", "loading");
  updateActionStates();
});
previewFrame.addEventListener("error", () => {
  previewReady = false;
  setPreviewState("预览错误", "loading");
  showNotice("项目预览无法加载。");
  updateActionStates();
});
window.addEventListener("resize", layoutPreviewFrame);
if (typeof ResizeObserver === "function") {
  const previewObserver = new ResizeObserver(layoutPreviewFrame);
  previewObserver.observe(previewStage);
  if (previewStageWrap) previewObserver.observe(previewStageWrap);
  if (previewSurfaces) previewObserver.observe(previewSurfaces);
}

$("new-project").addEventListener("click", () => { $("create-form").reset(); createDialog.showModal(); });
$("cancel-create").addEventListener("click", () => createDialog.close());
$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    clearNotice();
    const result = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ id: form.get("id"), name: form.get("name"), appId: form.get("appId"), template: form.get("template") || "app", version: form.get("version"), tickHz: Number(form.get("tickHz")) }),
    });
    createDialog.close();
    await loadProjects(result.id);
  } catch (error) {
    showNotice(error);
  }
});

$("save").addEventListener("click", () => { void saveProject().catch(() => {}); });
$("build").addEventListener("click", () => { void buildProject(); });
$("publish-target-channel")?.addEventListener("change", (event) => {
  void switchPublishTargetChannel(event.currentTarget.value).catch(showNotice);
});
$("publish-target-picker")?.addEventListener("change", (event) => {
  const appId = event.currentTarget.value;
  const target = publishTargets?.targets?.find((entry) => entry.appId === appId);
  if (!target) {
    const sourceProjectId = publishTargetContext?.sourceProjectId;
    const sourceProject = projects.find((project) => project.id === sourceProjectId);
    if (sourceProjectId && currentId !== sourceProjectId && (appId === sourceProjectId || appId === sourceProject?.appId)) {
      void selectProject(sourceProjectId).then(() => {
        if (currentId === sourceProjectId) showNotice(`已返回主应用 ${sourceProject?.name || sourceProject?.appId || sourceProjectId}。`, "info");
        else renderPublishTargetPicker();
      });
      return;
    }
    renderPublishTargetPicker();
    return;
  }
  if (target.kind !== "reused") {
    const sourceProjectId = publishTargetContext?.sourceProjectId;
    if (sourceProjectId && target.projectId === sourceProjectId && currentId !== sourceProjectId) {
      void selectProject(sourceProjectId).then(() => {
        if (currentId === sourceProjectId) showNotice(`已返回主应用项目 ${target.appId}。`, "info");
        else renderPublishTargetPicker();
      });
      return;
    }
    renderPublishTargetPicker();
    return;
  }
  if (target.canSelect === false || !target.ownerProjectId) {
    showNotice(target.reason || `无法解析 ${target.appId} 的所属项目。`, "error");
    renderPublishTargetPicker();
    return;
  }
  const ownerProjectId = target.ownerProjectId;
  const context = {
    sourceProjectId: publishTargets?.currentProjectId || currentId,
    sourceProjectTitle: target.sourceProjectTitle || projects.find((project) => project.id === publishTargets?.currentProjectId)?.name || publishTargets?.currentProjectId || currentId,
    sourcePath: target.sourcePath || "",
    appId: target.appId,
    ownerProjectId,
    ownerTitle: target.ownerTitle || target.title || ownerProjectId,
  };
  void selectProject(ownerProjectId, { publishTargetContext: context }).then(() => {
    if (currentId !== ownerProjectId) {
      renderPublishTargetPicker();
      return;
    }
    const sourceLabel = target.sourcePath
      ? `${context.sourceProjectTitle} 内 MiniApp ${target.title || target.appId}（${target.sourcePath}）`
      : `MiniApp ${target.title || target.appId} 的源码 ${target.ownerTitle || ownerProjectId}`;
    showNotice(`已打开 ${sourceLabel}。当前编辑、预览、构建和发布均针对该源码；可从项目列表返回主应用。`, "info");
  });
});
$("publish-test").addEventListener("click", () => { void publishProject(publishTargetChannel); });
$("open-version-manager-from-signing")?.addEventListener("click", () => $("versions-open")?.click());
$("version-app-config-copy")?.addEventListener("click", () => {
  const button = $("version-app-config-copy");
  const url = $("version-app-config-link")?.getAttribute("href");
  if (button && url) void copyVersionUrl(url, button, "App 接入地址");
});
$("versions-open").addEventListener("click", () => {
  switchInspectorTab("versions");
});
$("versions-refresh").addEventListener("click", () => { void loadVersions(); });
for (const [tab, sel] of [
  ["versions", "#version-manager > summary"],
  ["resources", "#resources-panel > summary"],
  ["settings", "#editor-tools > summary"],
]) {
  document.querySelector(sel)?.addEventListener("click", (event) => {
    const details = event.currentTarget?.parentElement;
    if (!(details instanceof HTMLDetailsElement)) return;
    if (details.open) {
      // It is about to close!
      const othersOpen = ["resources-panel", "version-manager", "editor-tools"]
        .filter((id) => id !== details.id)
        .some((id) => $(id)?.open);
      if (!othersOpen) {
        clearInspectorActiveUi();
      }
    } else {
      syncInspectorAccordion(tab);
    }
  });
}
$("version-manager").addEventListener("toggle", (event) => {
  handleInspectorPanelToggle("versions", event.currentTarget);
});
$("resources-panel")?.addEventListener("toggle", (event) => {
  handleInspectorPanelToggle("resources", event.currentTarget);
});
$("editor-tools")?.addEventListener("toggle", (event) => {
  handleInspectorPanelToggle("settings", event.currentTarget);
});
$("refresh-preview").addEventListener("click", () => { void refreshPreview(); });
$("preview-open").addEventListener("click", () => { if (previewPath) window.open(previewBrowserUrl().href, "_blank", "noopener"); });
$("clear-log").addEventListener("click", () => { logEl.textContent = ""; });
$("refresh-source").addEventListener("click", refreshSourceFromServer);
$("file-picker").addEventListener("change", async (event) => {
  const nextFile = event.currentTarget.value;
  if (dirty && !window.confirm("放弃未保存的源文件修改？")) {
    event.currentTarget.value = currentFile;
    return;
  }
  try { clearNotice(); await loadFile(nextFile); } catch (error) { showNotice(error); }
});
$("resource-package-picker").addEventListener("change", (event) => {
  const nextPackage = event.currentTarget.value;
  selectResourcePackage(nextPackage);
});
$("save-resources").addEventListener("click", () => { void saveResources().catch(() => {}); });
sourceEl.addEventListener("input", () => markDirty());
for (const id of ["config-name", "config-app-id", "config-version", "config-build", "config-tick"]) $(id).addEventListener("input", () => markDirty());
$("viewport-picker").addEventListener("change", (event) => setViewport(event.currentTarget.value));
const previewBezelToggle = $("preview-bezel-toggle");
if (previewBezelToggle) {
  previewBezelToggle.setAttribute("aria-pressed", String(previewBezelEnabled));
  previewBezelToggle.addEventListener("click", (event) => {
    previewBezelEnabled = !previewBezelEnabled;
    event.currentTarget.setAttribute("aria-pressed", String(previewBezelEnabled));
    try {
      localStorage.setItem(PREVIEW_BEZEL_STORAGE_KEY, previewBezelEnabled ? "1" : "0");
    } catch {}
    updatePreviewBezelPresentation();
  });
}
const webBluetoothToggle = $("web-bluetooth-toggle");
const bluetoothProviderPicker = $("bluetooth-provider");
function updateBluetoothSettings() {
  bluetoothProvider = "local";
  nobleBluetoothSupported = localBluetoothAvailable;
  if (webBluetoothToggle) {
    webBluetoothToggle.checked = webBluetoothEnabled;
    webBluetoothToggle.disabled = !nobleBluetoothSupported;
  }
  if (bluetoothProviderPicker) {
    bluetoothProviderPicker.hidden = true;
    bluetoothProviderPicker.value = "local";
  }
  setText("bluetooth-provider-label", "Noble 蓝牙");
  setText("web-bluetooth-help", nobleBluetoothSupported
    ? "使用本机 @abandonware/noble 适配器。请在宿主项目中安装，然后请求蓝牙权限并扫描 BLE。"
    : "请在宿主项目中安装 @abandonware/noble，并在 macOS 或 Windows 上运行编辑器。");
}
if (webBluetoothToggle) {
  updateBluetoothSettings();
  webBluetoothToggle.addEventListener("change", () => {
    webBluetoothEnabled = webBluetoothToggle.checked && nobleBluetoothSupported;
    try { localStorage.setItem(NOBLE_BLUETOOTH_STORAGE_KEY, webBluetoothEnabled ? "1" : "0"); } catch {}
    sendPreviewPlugins();
  });
}
bluetoothProviderPicker?.addEventListener("change", () => {
  bluetoothProvider = "local";
  updateBluetoothSettings();
  sendPreviewPlugins();
});
$("capture-preview").addEventListener("click", async () => {
  try {
    const capture = await capturePreview();
    downloadPreviewCapture(capture);
    showNotice("预览截图已下载。", "success");
  } catch (error) { showNotice(error); }
});
$("toggle-regions")?.addEventListener("click", (event) => {
  previewRegionsEnabled = !previewRegionsEnabled;
  event.currentTarget.setAttribute("aria-pressed", String(previewRegionsEnabled));
  sendPreviewRegions();
});
$("copy-preview-link")?.addEventListener("click", () => { void copyPreviewLink(); });

$("device-picker").addEventListener("change", () => updateActionStates());
$("deploy").addEventListener("click", () => { void deployProject(); });
$("deploy-cancel").addEventListener("click", () => { void cancelDeploy(); });
$("wechat-start")?.addEventListener("click", () => { void startWechat(); });
$("wechat-stop")?.addEventListener("click", () => { void stopWechat(); });
setupPreviewHeightControl();

const sourceDock = $("source-dock");
const consoleDock = $("console-dock");

function clearInspectorActiveUi() {
  syncInspectorAccordion(null);
}

function syncInspectorAccordion(activeTab) {
  const resourcesPanel = $("resources-panel");
  const versionManager = $("version-manager");
  const editorTools = $("editor-tools");
  if (activeTab === "resources") {
    if (versionManager?.open) versionManager.open = false;
    if (editorTools?.open) editorTools.open = false;
  } else if (activeTab === "versions") {
    if (resourcesPanel?.open) resourcesPanel.open = false;
    if (editorTools?.open) editorTools.open = false;
  } else if (activeTab === "settings") {
    if (resourcesPanel?.open) resourcesPanel.open = false;
    if (versionManager?.open) versionManager.open = false;
  }
  const tabMap = {
    resources: $("inspector-tab-resources"),
    versions: $("inspector-tab-versions"),
    settings: $("inspector-tab-settings"),
  };
  for (const [key, btn] of Object.entries(tabMap)) {
    if (!btn) continue;
    const selected = key === activeTab;
    btn.classList.toggle("active", selected);
    btn.setAttribute("aria-selected", String(selected));
  }
  const railMap = {
    resources: $("rail-resources"),
    versions: $("rail-versions"),
    settings: $("rail-settings"),
  };
  for (const [key, btn] of Object.entries(railMap)) {
    if (!btn) continue;
    const selected = key === activeTab;
    btn.classList.toggle("active", selected);
    btn.setAttribute("aria-pressed", String(selected));
  }
}

function handleInspectorPanelToggle(tab, panel) {
  if (!panel) return;
  if (panel.open) {
    syncInspectorAccordion(tab);
    if (tab === "versions" && !versionSnapshot) void loadVersions();
  } else if (!$("resources-panel")?.open && !$("version-manager")?.open && !$("editor-tools")?.open) {
    clearInspectorActiveUi();
  }
}

function switchInspectorTab(tab) {
  const resourcesPanel = $("resources-panel");
  const versionManager = $("version-manager");
  const editorTools = $("editor-tools");
  if (tab === "resources" && resourcesPanel) {
    if (versionManager) versionManager.open = false;
    if (editorTools) editorTools.open = false;
    resourcesPanel.open = true;
    syncInspectorAccordion("resources");
    resourcesPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (tab === "versions" && versionManager) {
    if (resourcesPanel) resourcesPanel.open = false;
    if (editorTools) editorTools.open = false;
    versionManager.open = true;
    syncInspectorAccordion("versions");
    versionManager.scrollIntoView({ behavior: "smooth", block: "nearest" });
    void loadVersions();
  } else if (tab === "settings" && editorTools) {
    if (resourcesPanel) resourcesPanel.open = false;
    if (versionManager) versionManager.open = false;
    editorTools.open = true;
    syncInspectorAccordion("settings");
    editorTools.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function toggleSourceDock(force) {
  if (!sourceDock) return;
  const nextOpen = typeof force === "boolean" ? force : sourceDock.hidden;
  sourceDock.hidden = !nextOpen;
  for (const id of ["source-split-toggle", "rail-source"]) {
    const btn = $(id);
    if (btn) {
      btn.classList.toggle("active", nextOpen);
      btn.setAttribute("aria-pressed", String(nextOpen));
    }
  }
  if (nextOpen && sourceEl && !sourceEl.disabled) {
    sourceEl.focus();
  }
  requestAnimationFrame(() => layoutPreviewFrame());
}

function switchConsoleTab(tabKey) {
  for (const btn of document.querySelectorAll("[data-console-tab]")) {
    const active = btn.dataset.consoleTab === tabKey;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  for (const pane of document.querySelectorAll("[data-console-pane]")) {
    pane.hidden = pane.dataset.consolePane !== tabKey;
  }
  if (consoleDock?.classList.contains("collapsed")) {
    toggleConsoleDock(false);
  }
}

function toggleConsoleDock(forceCollapsed) {
  if (!consoleDock) return;
  const collapsed = typeof forceCollapsed === "boolean"
    ? forceCollapsed
    : !consoleDock.classList.contains("collapsed");
  consoleDock.classList.toggle("collapsed", collapsed);
  const consoleCollapseToggle = $("console-collapse-toggle");
  if (consoleCollapseToggle) {
    consoleCollapseToggle.setAttribute("aria-expanded", String(!collapsed));
  }
  const railConsole = $("rail-console");
  if (railConsole) {
    railConsole.classList.toggle("active", !collapsed);
    railConsole.setAttribute("aria-pressed", String(!collapsed));
  }
  requestAnimationFrame(() => layoutPreviewFrame());
}

for (const btn of document.querySelectorAll("[data-console-tab]")) {
  btn.addEventListener("click", () => switchConsoleTab(btn.dataset.consoleTab));
}
$("console-collapse-toggle")?.addEventListener("click", () => toggleConsoleDock());
$("rail-console")?.addEventListener("click", () => toggleConsoleDock());

$("inspector-tab-resources")?.addEventListener("click", () => switchInspectorTab("resources"));
$("inspector-tab-versions")?.addEventListener("click", () => switchInspectorTab("versions"));
$("inspector-tab-settings")?.addEventListener("click", () => switchInspectorTab("settings"));

$("rail-stage")?.addEventListener("click", () => {
  previewStageWrap?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("rail-source")?.addEventListener("click", () => toggleSourceDock());
$("rail-resources")?.addEventListener("click", () => switchInspectorTab("resources"));
$("rail-versions")?.addEventListener("click", () => $("versions-open")?.click());
$("rail-settings")?.addEventListener("click", () => switchInspectorTab("settings"));

$("novel-open")?.addEventListener("click", () => {
  if (currentId) window.open(`/novel?project=${encodeURIComponent(currentId)}`, "_blank", "noopener");
});
$("source-toggle")?.addEventListener("click", () => {
  const options = document.querySelector(".preview-options");
  if (options instanceof HTMLDetailsElement) options.open = false;
  toggleSourceDock(true);
});
$("source-split-toggle")?.addEventListener("click", () => toggleSourceDock());
$("source-close")?.addEventListener("click", () => toggleSourceDock(false));

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (createDialog?.open || Boolean(document.querySelector("dialog[open], #novel-studio-modal:not([hidden])"))) return;
  if (!(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === "s") {
    event.preventDefault();
    if (!$("save")?.disabled) $("save")?.click();
    else void saveProject().catch(() => {});
  } else if (key === "b") {
    if (!$("build")?.disabled) {
      event.preventDefault();
      $("build")?.click();
    }
  } else if (key === "j") {
    event.preventDefault();
    toggleConsoleDock();
  } else if (key === "e") {
    if (!$("source-split-toggle")?.disabled) {
      event.preventDefault();
      toggleSourceDock();
    }
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dirty || resourcesDirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

function stopStudioUpgradePolling() {
  if (studioUpgradePollTimer) {
    clearTimeout(studioUpgradePollTimer);
    studioUpgradePollTimer = null;
  }
}

function isStudioUpgradeWorkDeferred() {
  return Boolean(
    dirty ||
    resourcesDirty ||
    saving ||
    resourcesSaving ||
    publishing ||
    startingDeploy ||
    startingWechat ||
    currentStatus?.busy ||
    wechatState?.state === "building" ||
    (activeDeploy && ["queued", "building", "starting", "stopping"].includes(String(activeDeploy.status || "").toLowerCase()))
  );
}

function resumeDeferredStudioUpgrade() {
  if (isStudioUpgradeWorkDeferred()) {
    if (studioUpgradeState) renderStudioUpgrade(studioUpgradeState);
    return;
  }
  if (studioUpgradePendingReloadVersion) {
    studioUpgradePendingReloadVersion = null;
    window.location.reload();
    return;
  }
  if (studioUpgradeDeferredAutoApply) {
    studioUpgradeDeferredAutoApply = false;
    void checkStudioUpgrade({ autoApply: true });
  } else if (studioUpgradeState) {
    renderStudioUpgrade(studioUpgradeState);
  }
}

function formatStudioUpgradeBytes(value) {
  const bytes = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let scaled = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && scaled >= 1024; index += 1) {
    scaled /= 1024;
    unit = units[index];
  }
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${unit}`;
}

function renderStudioUpgrade(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  studioUpgradeState = { ...(studioUpgradeState || {}), ...snapshot };
  const bar = $("studio-upgrade-bar");
  const modeEl = $("studio-upgrade-mode");
  const versionEl = $("studio-upgrade-version");
  const statusEl = $("studio-upgrade-status");
  const reasonEl = $("studio-upgrade-reason");
  const progressEl = $("studio-upgrade-progress");
  const progressFill = $("studio-upgrade-progress-fill");
  const progressText = $("studio-upgrade-progress-text");
  const actionBtn = $("studio-upgrade-action");
  const releaseLink = $("studio-upgrade-release");
  if (!bar || !versionEl || !statusEl || !actionBtn) return;

  const currentVersion = studioUpgradeState.currentVersion || "—";
  const latestVersion = studioUpgradeState.latestVersion || "";
  const status = studioUpgradeState.status || "idle";
  const upgradeAvailable = Boolean(studioUpgradeState.upgradeAvailable);
  const autoUpgradeSupported = studioUpgradeState.autoUpgradeSupported === true;
  const error = studioUpgradeState.error || "";
  const deferredReason = studioUpgradeState.deferredReason || "";
  const releaseUrl = studioUpgradeState.releaseUrl || "";
  const isInProgress = ["downloading", "applying", "restarting"].includes(status);
  const localDraftReason = dirty
    ? "编辑器有未保存修改；保存后可继续自动升级。"
    : resourcesDirty
      ? "资源策略有未保存修改；保存后可继续自动升级。"
      : "";
  const isDeferred = autoUpgradeSupported && upgradeAvailable && !isInProgress && Boolean(deferredReason || localDraftReason);
  const reasonText = deferredReason || (
    upgradeAvailable && !isInProgress && localDraftReason
      ? localDraftReason
      : !autoUpgradeSupported
        ? studioUpgradeState.modeReason || "当前安装方式不支持自动升级。"
        : ""
  );

  if (modeEl) {
    modeEl.textContent = !autoUpgradeSupported
      ? "自动升级不可用"
      : isDeferred
        ? "自动升级已暂缓"
        : "自动升级已开启";
    modeEl.dataset.state = !autoUpgradeSupported ? "unsupported" : isDeferred ? "deferred" : "enabled";
    modeEl.title = reasonText || modeEl.textContent;
  }

  versionEl.textContent = latestVersion && latestVersion !== currentVersion
    ? `v${currentVersion} → v${latestVersion}`
    : `v${currentVersion}`;

  if (releaseLink) {
    if (releaseUrl && /^https?:\/\//i.test(releaseUrl)) {
      releaseLink.href = releaseUrl;
      releaseLink.hidden = false;
    } else {
      releaseLink.hidden = true;
    }
  }

  let statusText = "等待检查更新";
  let tone = "";
  let buttonLabel = "检查更新";
  let buttonDisabled = false;

  if (studioUpgradePendingReloadVersion) {
    statusText = `已升级至 v${studioUpgradePendingReloadVersion}（保存未保存修改后将自动刷新页面）`;
    tone = "warn";
    buttonLabel = "立即刷新";
    buttonDisabled = false;
  } else if (status === "checking") {
    statusText = "正在检查 GitHub 稳定版更新…";
    tone = "warn";
    buttonLabel = "检查中…";
    buttonDisabled = true;
  } else if (status === "downloading") {
    statusText = `正在下载 v${studioUpgradeState.targetVersion || latestVersion} 升级包…`;
    tone = "warn";
    buttonLabel = "升级中…";
    buttonDisabled = true;
  } else if (status === "applying") {
    statusText = `下载完成（${formatStudioUpgradeBytes(studioUpgradeState.downloadedBytes)}），正在校验并暂存 v${studioUpgradeState.targetVersion || latestVersion}…`;
    tone = "warn";
    buttonLabel = "升级中…";
    buttonDisabled = true;
  } else if (status === "restarting") {
    statusText = `正在应用 v${studioUpgradeState.targetVersion || latestVersion} 并重启 Studio…`;
    tone = "warn";
    buttonLabel = "重启中…";
    buttonDisabled = true;
  } else if (status === "error") {
    statusText = error || "升级检查失败";
    tone = "bad";
    buttonLabel = autoUpgradeSupported && upgradeAvailable ? "重试升级" : "重试检查";
  } else if (upgradeAvailable) {
    if (!autoUpgradeSupported) {
      statusText = `发现新版本 v${latestVersion}`;
      tone = "warn";
      buttonLabel = "重新检查";
    } else if (deferredReason) {
      statusText = `发现新版本 v${latestVersion}`;
      tone = "warn";
      buttonLabel = "重新检查";
    } else if (dirty || resourcesDirty) {
      statusText = `发现新版本 v${latestVersion}`;
      tone = "warn";
      buttonLabel = "保存后升级";
    } else {
      statusText = `发现新版本 v${latestVersion}`;
      tone = "warn";
      buttonLabel = "立即升级";
    }
  } else if (status === "up-to-date") {
    statusText = autoUpgradeSupported ? "已是最新稳定版" : "已是最新稳定版（当前安装方式不支持自动升级）";
    tone = "good";
    buttonLabel = "检查更新";
  }

  if (tone) bar.dataset.state = tone;
  else delete bar.dataset.state;
  statusEl.textContent = statusText;
  statusEl.title = statusText;
  if (reasonEl) {
    reasonEl.textContent = reasonText;
    reasonEl.hidden = !reasonText || isInProgress;
    reasonEl.title = reasonText;
  }
  if (progressEl && progressFill && progressText) {
    const isDownloading = status === "downloading";
    progressEl.hidden = !isDownloading;
    if (isDownloading) {
      const downloadedBytes = Number.isSafeInteger(studioUpgradeState.downloadedBytes) && studioUpgradeState.downloadedBytes >= 0
        ? studioUpgradeState.downloadedBytes
        : 0;
      const totalBytes = Number.isSafeInteger(studioUpgradeState.downloadTotalBytes) && studioUpgradeState.downloadTotalBytes > 0
        ? studioUpgradeState.downloadTotalBytes
        : null;
      const determinate = totalBytes !== null && downloadedBytes <= totalBytes;
      if (determinate) {
        const percent = Math.min(100, Math.floor(downloadedBytes / totalBytes * 100));
        progressFill.style.width = `${percent}%`;
        delete progressFill.dataset.indeterminate;
        progressEl.setAttribute("aria-valuenow", String(percent));
        progressEl.setAttribute("aria-valuetext", `${percent}%，${formatStudioUpgradeBytes(downloadedBytes)} / ${formatStudioUpgradeBytes(totalBytes)}`);
        progressText.textContent = `${formatStudioUpgradeBytes(downloadedBytes)} / ${formatStudioUpgradeBytes(totalBytes)} · ${percent}%`;
      } else {
        progressFill.style.width = "35%";
        progressFill.dataset.indeterminate = "true";
        progressEl.removeAttribute("aria-valuenow");
        progressEl.setAttribute("aria-valuetext", `已接收 ${formatStudioUpgradeBytes(downloadedBytes)}`);
        progressText.textContent = `已接收 ${formatStudioUpgradeBytes(downloadedBytes)}`;
      }
    } else {
      progressFill.style.width = "0";
      delete progressFill.dataset.indeterminate;
      progressEl.removeAttribute("aria-valuenow");
      progressEl.removeAttribute("aria-valuetext");
      progressText.textContent = "";
    }
  }
  actionBtn.textContent = buttonLabel;
  actionBtn.disabled = buttonDisabled;
}

async function pollStudioRestart(targetVersion, previousVersion, attempt = 0) {
  stopStudioUpgradePolling();
  if (attempt > 120) {
    renderStudioUpgrade({
      status: "error",
      error: `等待 Studio 重启到 v${targetVersion} 超时，请手动检查服务状态。`,
    });
    return;
  }
  try {
    const response = await fetch("/health", {
      cache: "no-store",
      headers: { "x-pocket-editor": "1" },
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      const health = await response.json();
      if (health?.ok === true && health.service === "pocket-editor") {
        if (health.csrfToken) csrfToken = health.csrfToken;
        if (health.version === targetVersion) {
          if (dirty || resourcesDirty) {
            studioUpgradePendingReloadVersion = targetVersion;
            renderStudioUpgrade({
              currentVersion: targetVersion,
              latestVersion: targetVersion,
              status: "up-to-date",
              upgradeAvailable: false,
              error: null,
            });
            return;
          }
          renderStudioUpgrade({
            currentVersion: targetVersion,
            latestVersion: targetVersion,
            status: "up-to-date",
            upgradeAvailable: false,
            error: null,
          });
          window.location.reload();
          return;
        }
        if (attempt >= 2 && health.version === previousVersion) {
          const latestStatus = await api("/api/studio/upgrade").catch(() => null);
          if (latestStatus && latestStatus.status === "error") {
            renderStudioUpgrade(latestStatus);
            if (latestStatus.error) showNotice(latestStatus.error, "error");
            return;
          }
        }
      }
    }
  } catch {
    // Server is mid-restart; continue polling.
  }
  studioUpgradePollTimer = setTimeout(() => {
    void pollStudioRestart(targetVersion, previousVersion, attempt + 1);
  }, 350);
}

async function checkStudioUpgrade({ autoApply = true, forceApply = false } = {}) {
  if (studioUpgradePollTimer) return null;
  let checkPending = true;
  const pollCheckStatus = async () => {
    if (!checkPending) return;
    try {
      const snapshot = await api("/api/studio/upgrade", {
        cache: "no-store",
        signal: AbortSignal.timeout(2000),
      });
      if (checkPending && snapshot && typeof snapshot === "object") {
        renderStudioUpgrade(snapshot.status === "available"
          ? { ...snapshot, status: "checking" }
          : snapshot);
      }
    } catch {
      // Keep the latest visible phase while the check request continues.
    }
    if (checkPending) {
      studioUpgradePollTimer = setTimeout(() => {
        void pollCheckStatus();
      }, 250);
    }
  };
  try {
    const deferAutoApply = autoApply && !forceApply && isStudioUpgradeWorkDeferred();
    renderStudioUpgrade({ status: "checking", error: null });
    const previousVersion = studioUpgradeState?.currentVersion;
    studioUpgradePollTimer = setTimeout(() => {
      void pollCheckStatus();
    }, 150);
    const result = await api("/api/studio/upgrade/check", {
      method: "POST",
      body: JSON.stringify({ autoApply: deferAutoApply ? false : autoApply, forceApply }),
    });
    checkPending = false;
    stopStudioUpgradePolling();
    studioUpgradeDeferredAutoApply = Boolean(
      result?.upgradeAvailable &&
      result?.autoUpgradeSupported === true &&
      (deferAutoApply || result?.deferredReason)
    );
    renderStudioUpgrade(result);
    if (result?.status === "restarting" || result?.status === "applying" || result?.status === "downloading") {
      studioUpgradeDeferredAutoApply = false;
      const targetVersion = result.targetVersion || result.latestVersion;
      if (targetVersion) {
        void pollStudioRestart(targetVersion, previousVersion || result.currentVersion);
      }
    } else if (result?.status === "error" && result.rolledBack && result.error) {
      showNotice(result.error, "error");
    }
    return result;
  } catch (error) {
    checkPending = false;
    stopStudioUpgradePolling();
    if (studioUpgradeState?.status === "restarting") {
      const targetVersion = studioUpgradeState.targetVersion || studioUpgradeState.latestVersion;
      if (targetVersion) {
        void pollStudioRestart(targetVersion, studioUpgradeState.currentVersion || "");
        return null;
      }
    }
    renderStudioUpgrade({ status: "error", error: normalizeError(error).message });
    return null;
  }
}

function startPeriodicStudioUpgradeChecks() {
  if (studioUpgradePeriodicTimer) clearInterval(studioUpgradePeriodicTimer);
  studioUpgradePeriodicTimer = setInterval(() => {
    if (studioUpgradePollTimer || studioUpgradePendingReloadVersion) return;
    if (["checking", "downloading", "applying", "restarting"].includes(studioUpgradeState?.status)) return;
    void checkStudioUpgrade({ autoApply: true });
  }, STUDIO_UPGRADE_CHECK_INTERVAL_MS);
}

$("studio-upgrade-action")?.addEventListener("click", () => {
  if (studioUpgradePendingReloadVersion) {
    if ((dirty || resourcesDirty) && !window.confirm("当前仍有未保存修改，立即刷新会丢弃草稿，是否继续？")) return;
    studioUpgradePendingReloadVersion = null;
    window.location.reload();
    return;
  }
  if ((dirty || resourcesDirty) && studioUpgradeState?.autoUpgradeSupported === true && studioUpgradeState?.upgradeAvailable) {
    studioUpgradeDeferredAutoApply = true;
    renderStudioUpgrade(studioUpgradeState);
    showNotice("请先保存源文件或资源策略修改，保存后将自动升级。", "info");
    return;
  }
  const upgradeAvailable = Boolean(studioUpgradeState?.upgradeAvailable);
  const forceApply = studioUpgradeState?.autoUpgradeSupported === true && upgradeAvailable;
  void checkStudioUpgrade({ autoApply: true, forceApply });
});

// The runner owns the mobile device profile. Load it before selecting a
// project so Canvas and WeChat keep the same logical screen and safe-area
// contract. The Studio update check is independent of that device request.
void loadPreviewDevice()
  .then(() => Promise.all([loadProjects(), loadDevices()]))
  .catch(showNotice);
void checkStudioUpgrade({ autoApply: true })
  .then(() => startPeriodicStudioUpgradeChecks());
