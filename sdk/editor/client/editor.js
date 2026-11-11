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
  const workLocked = busy || startingDeploy || Boolean(activeDeploy && activeDeploy.status !== "running") || publishing || resourcesSaving;
  $("save").disabled = !hasProject || !dirty || saving || workLocked;
  $("build").disabled = !hasProject || workLocked || saving;
  if ($("novel-open")) $("novel-open").disabled = !hasProject || workLocked;
  $("refresh-source").disabled = !hasProject || workLocked;
  $("refresh-preview").disabled = !hasProject || busy;
  previewFrame.style.pointerEvents = busy ? "none" : "";
  $("preview-open").disabled = !previewPath;
  if ($("copy-preview-link")) $("copy-preview-link").disabled = !previewPath;
  if ($("source-toggle")) $("source-toggle").disabled = !hasProject;
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
  $("publish").disabled = !hasProject || !built || workLocked;
  $("publish-test").disabled = !hasProject || !built || workLocked;
  if ($("version-publish-test")) $("version-publish-test").disabled = !hasProject || !built || workLocked;
  if ($("version-publish-release")) $("version-publish-release").disabled = !hasProject || !built || workLocked;
  $("versions-open").disabled = !hasProject;
  $("versions-refresh").disabled = !hasProject || versionsLoading;
  updateResourceActionStates(workLocked);
}

function renderProjects() {
  projectsEl.replaceChildren();
  for (const project of projects) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `project-item${project.id === currentId ? " active" : ""}`;
    const name = document.createElement("strong");
    name.textContent = project.name || project.id;
    const detail = document.createElement("small");
    detail.textContent = `${project.id} · ${project.version || "—"}`;
    button.append(name, detail);
    button.addEventListener("click", () => {
      void selectProject(project.id);
    });
    projectsEl.append(button);
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
    packageSummary.textContent = entry.packages.map((pkg) => [
      pkg.id,
      pkg.version ? `v${pkg.version}` : "",
      pkg.build !== null ? `build ${pkg.build}` : "",
    ].filter(Boolean).join(" · ")).join("；");
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
    count.textContent = `${slot.packages?.length || 0} 个资源包`;
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
    const channel = publish.channel === "test" ? "测试包" : "签名发布";
    const identity = [publish.version ? `v${publish.version}` : "", publish.build !== undefined ? `build ${publish.build}` : ""].filter(Boolean).join(" · ");
    publishStatus.textContent = `${channel}已就绪${identity ? ` · ${identity}` : ""} · 修订版 r${publish.revision ?? status.revision ?? "—"}`;
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

async function refreshStatus() {
  if (!currentId) return null;
  const status = await api(`/api/projects/${encodeURIComponent(currentId)}/status`);
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
    const status = await refreshStatus();
    if (currentId !== projectId) return;
    if (status?.busy) {
      buildPollTimer = setTimeout(() => void pollBuild(attempt + 1), POLL_DELAY_MS);
    } else {
      stopBuildPolling();
      if (status?.builtRevision === status?.revision && !status?.error) {
        void loadResources(projectId).catch(showNotice);
      }
    }
  } catch (error) {
    stopBuildPolling();
    showNotice(error);
  }
}

async function selectProject(id) {
  if (currentId === id) return;
  if (activeDeploy || startingDeploy) {
    showNotice("请先完成或取消当前部署，再切换项目。", "info");
    return;
  }
  if ((dirty || resourcesDirty) && currentId !== id && !window.confirm("放弃未保存的源文件或资源修改？")) return;
  clearNotice();
  if (projectSwitcher) projectSwitcher.open = false;
  stopBuildPolling();
  stopDeployPolling();
  invalidateWechatRequests();
  const selectionGeneration = wechatGeneration;
  currentId = id;
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
    const [config, files, status, resources] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(id)}/config`),
      api(`/api/projects/${encodeURIComponent(id)}/files`),
      api(`/api/projects/${encodeURIComponent(id)}/status`),
      fetchResources(id),
    ]);
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    setText("project-title", config.name || id);
    setText("project-subtitle", `${config.appId || "—"} · ${config.framework || "solid"} · ${config.entry || "app.tsx"}`);
    $("config-name").value = config.name || "";
    $("config-app-id").value = config.appId || "";
    $("config-version").value = config.version || "";
    $("config-build").value = config.build ?? 0;
    $("config-tick").value = config.tickHz ?? 60;
    const fileList = files.files || files;
    renderFilePicker(fileList);
    await loadFile(projectFiles.includes(config.entry) ? config.entry : projectFiles.includes("app.tsx") ? "app.tsx" : projectFiles[0]);
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    resourcesLoading = false;
    setResourceInventory(resources);
    setEnabled(true);
    renderStatus(status);
    if (status?.busy) buildPollTimer = setTimeout(() => void pollBuild(), POLL_DELAY_MS);
    await loadWechat(id, selectionGeneration);
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    await resumeDeployment(id);
  } catch (error) {
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
  updateActionStates();
}

async function loadProjects(preferred) {
  let configuredProjectId;
  try {
    const health = await api("/health");
    if (health?.csrfToken) csrfToken = health.csrfToken;
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
    setText("project-title", config.name || currentId);
    markDirty(false);
    projects = (await api("/api/projects")) || projects;
    renderProjects();
    renderStatus(config.status);
  } catch (error) {
    setText("save-status", "保存失败");
    showNotice(error);
    throw error;
  } finally {
    saving = false;
    updateActionStates();
  }
}

async function buildProject() {
  if (!currentId || currentStatus?.busy) return;
  clearNotice();
  try {
    if (dirty) await saveProject();
    if (resourcesDirty) {
      showNotice("构建前请先保存资源策略。", "info");
      return;
    }
    const result = await api(`/api/projects/${encodeURIComponent(currentId)}/build`, { method: "POST", body: "{}" });
    renderStatus(result.status || result);
    stopBuildPolling();
    void pollBuild();
  } catch (error) {
    showNotice(error);
  }
}

async function publishProject(channel = "release") {
  if (!currentId || publishing) return;
  const projectId = currentId;
  if (dirty) {
    showNotice("发布前请先保存源文件修改。", "info");
    return;
  }
  if (!currentStatus || currentStatus.builtRevision !== currentStatus.revision || currentStatus.error) {
    showNotice("发布前请先构建已保存的项目。", "info");
    return;
  }
  clearNotice();
  publishing = true;
  $("publish-status").textContent = channel === "test" ? "正在发布签名测试包…" : "正在发布签名版本…";
  updateActionStates();
  try {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/publish`, {
      method: "POST",
      body: JSON.stringify(channel === "test" ? { channel: "test" } : {}),
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
    showNotice(`${channel === "test" ? "测试" : "稳定版"}资源包已发布。`, "success");
  } catch (error) {
    if (currentId === projectId) {
      setText("publish-status", `${channel === "test" ? "测试" : "稳定版"}发布失败`);
      showNotice(error);
    }
  } finally {
    publishing = false;
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
  const availableHeight = Math.max(1, (previewStageWrap?.clientHeight || previewStage.getBoundingClientRect().height) - verticalPadding);
  // The selected viewport remains the logical width/height sent to the
  // guest. Only the presentation scale changes with the available pane size;
  // cap it at 1 so a tall pane never invents a larger logical viewport.
  const scale = Math.min(stageWidth / viewport.width, availableHeight / viewport.height, 1);
  if (!Number.isFinite(scale) || scale <= 0) return;
  previewStage.style.width = `${Math.round(viewport.width * scale)}px`;
  previewStage.style.height = `${Math.round(viewport.height * scale)}px`;
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
$("publish").addEventListener("click", () => { void publishProject("release"); });
$("publish-test").addEventListener("click", () => { void publishProject("test"); });
$("version-publish-test")?.addEventListener("click", () => { void publishProject("test"); });
$("version-publish-release")?.addEventListener("click", () => { void publishProject("release"); });
$("version-app-config-copy")?.addEventListener("click", () => {
  const button = $("version-app-config-copy");
  const url = $("version-app-config-link")?.getAttribute("href");
  if (button && url) void copyVersionUrl(url, button, "App 接入地址");
});
$("versions-open").addEventListener("click", () => {
  const panel = $("version-manager");
  panel.open = true;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  void loadVersions();
});
$("versions-refresh").addEventListener("click", () => { void loadVersions(); });
$("version-manager").addEventListener("toggle", (event) => {
  if (event.currentTarget.open && !versionSnapshot) void loadVersions();
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

const sourceDialog = $("source-dialog");
$("novel-open")?.addEventListener("click", () => {
  if (currentId) window.open(`/novel?project=${encodeURIComponent(currentId)}`, "_blank", "noopener");
});
$("source-toggle")?.addEventListener("click", () => sourceDialog?.showModal());
$("source-close")?.addEventListener("click", () => sourceDialog?.close());
sourceDialog?.addEventListener("click", (event) => {
  if (event.target === sourceDialog) sourceDialog.close();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveProject().catch(() => {});
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dirty || resourcesDirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// The runner owns the mobile device profile. Load it once before selecting a
// project so both the Canvas presentation and the WeChat iframe use the same
// logical screen and safe-area contract.
void loadPreviewDevice()
  .then(() => Promise.all([loadProjects(), loadDevices()]))
  .catch(showNotice);
