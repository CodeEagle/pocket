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
const WEB_BLUETOOTH_STORAGE_KEY = "pocket.editor.webBluetooth";
const browserBluetoothSupported = window.isSecureContext && typeof navigator.bluetooth?.requestDevice === "function";
let webBluetoothSupported = browserBluetoothSupported;
let localBluetoothAvailable = false;
let bluetoothProvider = "web";
let webBluetoothEnabled = false;
try { webBluetoothEnabled = localStorage.getItem(WEB_BLUETOOTH_STORAGE_KEY) === "1"; } catch {}
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
    throw new Error(message || `${response.status} ${response.statusText}`);
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

function showNotice(message, tone = "error") {
  clearTimeout(noticeTimer);
  const kind = ["success", "info", "error"].includes(tone) ? tone : "error";
  noticeEl.dataset.tone = kind;
  noticeEl.setAttribute("role", kind === "error" ? "alert" : "status");
  $("notice-icon").textContent = { success: "✓", info: "i", error: "!" }[kind];
  $("notice-message").textContent = normalizeError(message).message;
  noticeEl.hidden = false;
  if (kind !== "error") noticeTimer = setTimeout(clearNotice, kind === "success" ? 3500 : 5000);
}

function clearNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = undefined;
  noticeEl.hidden = true;
  $("notice-message").textContent = "";
}

noticeEl.addEventListener("click", clearNotice);
noticeEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") clearNotice();
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
  setText("save-status", dirty ? "Unsaved changes" : "Saved");
  if (!currentId) setProjectState("No project");
  else if (dirty) setProjectState("Unsaved");
  else if (currentStatus?.busy) setProjectState("Building…", "good");
  else if (currentStatus?.error) setProjectState("Build failed", "bad");
  else if (currentStatus?.builtRevision === currentStatus?.revision) setProjectState("Built", "good");
  else setProjectState("Needs build");
  updateActionStates();
}

function updateActionStates() {
  const hasProject = Boolean(currentId);
  const busy = Boolean(currentStatus?.busy);
  const built = Boolean(currentStatus && currentStatus.builtRevision === currentStatus.revision && !currentStatus.error);
  const workLocked = busy || startingDeploy || Boolean(activeDeploy && activeDeploy.status !== "running") || publishing;
  $("save").disabled = !hasProject || !dirty || saving || workLocked;
  $("build").disabled = !hasProject || workLocked || saving;
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
    empty.textContent = "No projects yet.";
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
  setText("source-panel-title", picker.value || "No source file");
}

async function loadFile(filePath) {
  if (!currentId || !filePath) return;
  const content = await api(fileUrl(currentId, filePath));
  currentFile = content.path;
  sourceEl.value = content.content;
  $("file-picker").value = currentFile;
  setText("source-panel-title", currentFile);
  setText("source-bytes", `${Number(content.bytes || 0).toLocaleString()} bytes`);
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
  return label || appId || (currentId ? "Whole app" : "Select a project");
}

function renderWechatTargets(payload = {}) {
  const projectLabel = $("wechat-project-label");
  if (projectLabel) projectLabel.title = readWechatProjectLabel(payload);
}

function renderWechatState(nextState = wechatState) {
  wechatState = readWechatState(nextState);
  const chip = $("wechat-state");
  if (chip) {
    const labels = { idle: "Idle", building: "Building…", running: "Running", error: "Error", stopped: "Stopped" };
    const kind = wechatState.state === "running" ? "good" : wechatState.state === "error" ? "bad" : "";
    chip.textContent = labels[wechatState.state] || "Idle";
    chip.className = `meta-chip${kind ? ` ${kind}` : ""}`;
    const detail = wechatState.error || wechatState.logs.at(-1) || "";
    if (detail) chip.title = detail;
    else chip.removeAttribute("title");
    chip.setAttribute("aria-label", `WeChat ${chip.textContent}${detail ? `: ${detail}` : ""}`);
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
    wechatPreviewEmpty.querySelector("strong").textContent = "WeChat preview failed";
    wechatPreviewEmpty.querySelector("span").textContent = wechatState.error || "Check the WeChat run log.";
  } else if (state === "building") {
    wechatPreviewEmpty.querySelector("strong").textContent = "Starting WeChat preview";
    wechatPreviewEmpty.querySelector("span").textContent = "Building the whole app…";
  } else {
    wechatPreviewEmpty.querySelector("strong").textContent = "WeChat preview";
    wechatPreviewEmpty.querySelector("span").textContent = "Run WeChat to load the whole app.";
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
    renderWechatState({ ...wechatState, state: "error", error: "WeChat validation timed out." });
    showNotice("WeChat validation timed out.");
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
    showNotice("The server refreshed the file list. Your unsaved draft is still open; use Refresh files again to discard it.", "info");
    return;
  }
  await loadFile(projectFiles.includes(currentFile) ? currentFile : projectFiles[0]);
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
    publishStatus.textContent = "Not published";
  } else {
    const channel = publish.channel === "test" ? "Test package" : "Signed release";
    const identity = [publish.version ? `v${publish.version}` : "", publish.build !== undefined ? `build ${publish.build}` : ""].filter(Boolean).join(" · ");
    publishStatus.textContent = `${channel} ready${identity ? ` · ${identity}` : ""} · revision r${publish.revision ?? status.revision ?? "—"}`;
  }
  if (!status?.artifacts) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "Build output will appear after a real QuickJS build.";
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
    download.textContent = "download ↗";
    link.append(title, download);
    artifacts.append(link);
  }
  if (publish) {
    const key = document.createElement("span");
    key.textContent = `Key ${publish.keyId || "local"}`;
    publishInfo.append(key);
    if (publish.channel) {
      const channel = document.createElement("span");
      channel.textContent = publish.channel === "test" ? "Channel test" : "Channel release";
      publishInfo.append(channel);
    }
    if (publish.version || publish.build !== undefined) {
      const identity = document.createElement("span");
      identity.textContent = [publish.version ? `v${publish.version}` : "", publish.build !== undefined ? `build ${publish.build}` : ""].filter(Boolean).join(" · ");
      publishInfo.append(identity);
    }
    const links = [
      ["latest.json ↗", publish.manifestUrl || publish.updateUrl],
      ["host.json ↗", publish.hostConfigUrl],
      ["download tar.gz ↗", publish.archiveUrl],
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
      heading.textContent = `Test package ${publish.version ? `v${publish.version}` : ""}${publish.build !== undefined ? ` · build ${publish.build}` : ""} is ready.`;
      const first = document.createElement("span");
      first.textContent = "First time: use Editor Deploy to reinstall once so the simulator/desktop host receives the update URL and public key.";
      const second = document.createElement("span");
      second.textContent = "Then open Demo Host → Updates → Check → Apply. Later test packages do not require rebuilding Flutter.";
      const caveat = document.createElement("span");
      caveat.textContent = "Automatic update injection is currently limited to iOS Simulator and desktop; Android and physical-device URLs are not configured in this flow.";
      testPublishInfo.append(heading, first, second, caveat);
      testPublishInfo.hidden = false;
    }
  }
}

function renderStatus(status) {
  currentStatus = status || null;
  setText("source-revision", `revision ${status?.revision ?? "—"}`);
  const state = $("build-state");
  if (!status) {
    state.textContent = "Not built";
    state.className = "meta-chip";
  } else if (status.busy) {
    state.textContent = `Building r${status.revision}`;
    state.className = "meta-chip";
  } else if (status.error) {
    state.textContent = "Build failed";
    state.className = "meta-chip bad";
  } else if (status.builtRevision === status.revision) {
    state.textContent = `Built r${status.revision}`;
    state.className = "meta-chip good";
  } else {
    state.textContent = "Changes not built";
    state.className = "meta-chip";
  }
  logEl.textContent = status?.logs?.join("\n") || "No diagnostics yet.";
  logEl.scrollTop = logEl.scrollHeight;
  renderArtifacts(status);
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
  try {
    const status = await refreshStatus();
    if (status?.busy) {
      buildPollTimer = setTimeout(() => void pollBuild(attempt + 1), POLL_DELAY_MS);
    } else stopBuildPolling();
  } catch (error) {
    stopBuildPolling();
    showNotice(error);
  }
}

async function selectProject(id) {
  if (currentId === id) return;
  if (activeDeploy || startingDeploy) {
    showNotice("Finish or cancel the active deployment before switching projects.", "info");
    return;
  }
  if (dirty && currentId !== id && !window.confirm("Discard unsaved source changes?")) return;
  clearNotice();
  stopBuildPolling();
  stopDeployPolling();
  invalidateWechatRequests();
  const selectionGeneration = wechatGeneration;
  currentId = id;
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
  try {
    const [config, files, status] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(id)}/config`),
      api(`/api/projects/${encodeURIComponent(id)}/files`),
      api(`/api/projects/${encodeURIComponent(id)}/status`),
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
    setEnabled(true);
    renderStatus(status);
    if (status?.busy) buildPollTimer = setTimeout(() => void pollBuild(), POLL_DELAY_MS);
    await loadWechat(id, selectionGeneration);
    if (currentId !== id || selectionGeneration !== wechatGeneration) return;
    await resumeDeployment(id);
  } catch (error) {
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
    try { bluetoothProvider = localBluetoothAvailable && localStorage.getItem("pocket.editor.bluetoothProvider") !== "web" ? "local" : "web"; } catch { bluetoothProvider = localBluetoothAvailable ? "local" : "web"; }
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
    resetWechatPresentation();
    setEnabled(false);
    setText("project-title", "Select a project");
    setText("project-subtitle", "Create an SDK starter, edit its guest UI, and preview it locally.");
    setProjectState("No project");
  }
}

async function saveProject() {
  if (!currentId || saving) return;
  clearNotice();
  saving = true;
  setText("save-status", "Saving…");
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
    setText("source-bytes", `${Number(source.bytes || 0).toLocaleString()} bytes`);
    setText("project-title", config.name || currentId);
    markDirty(false);
    projects = (await api("/api/projects")) || projects;
    renderProjects();
    renderStatus(config.status);
  } catch (error) {
    setText("save-status", "Save failed");
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
  if (dirty) {
    showNotice("Save your source changes before publishing.", "info");
    return;
  }
  if (!currentStatus || currentStatus.builtRevision !== currentStatus.revision || currentStatus.error) {
    showNotice("Build the saved project before publishing it.", "info");
    return;
  }
  clearNotice();
  publishing = true;
  $("publish-status").textContent = channel === "test" ? "Publishing signed test package…" : "Publishing signed release…";
  updateActionStates();
  try {
    const result = await api(`/api/projects/${encodeURIComponent(currentId)}/publish`, {
      method: "POST",
      body: JSON.stringify(channel === "test" ? { channel: "test" } : {}),
    });
    renderStatus(result.status || result);
  } catch (error) {
    showNotice(error);
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
  setPreviewState("Waiting");
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
    if (!automatic) showNotice("Save your source changes before refreshing the preview.", "info");
    return;
  }
  if (!currentStatus || currentStatus.builtRevision !== currentStatus.revision || currentStatus.error) {
    if (!automatic) showNotice("Build the saved project before refreshing the preview.", "info");
    return;
  }
  clearNotice();
  previewReady = false;
  previewHasFrame = false;
  setPreviewState("Loading", "loading");
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
  if (webBluetoothEnabled) { url.searchParams.set("webBluetooth", "1"); url.searchParams.set("bluetoothProvider", bluetoothProvider); }
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
  if (!previewReady || previewFrame.hidden) throw new Error("Refresh the preview before capturing it.");
  const requestId = `capture-${Date.now()}-${++captureSequence}`;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captureWaiters.delete(requestId);
      reject(new Error("The preview did not return a screenshot. Refresh it and try again."));
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
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)) throw new Error("Preview capture must be a PNG, JPEG, or WebP image.");
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
    showNotice("Select a project before copying its preview URL.", "info");
    return;
  }
  if (!currentStatus || currentStatus.builtRevision !== currentStatus.revision || currentStatus.error || dirty) {
    showNotice("Build the saved project before copying its preview URL.", "info");
    return;
  }
  const urlObject = previewBrowserUrl();
  const url = urlObject.href;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
    await navigator.clipboard.writeText(url);
    showNotice("Preview URL copied. Open it directly in Codex browser.", "success");
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
    option.textContent = "No devices available";
    picker.append(option);
    setText("device-help", "No emulator or connected device is available.");
  } else {
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.id;
      option.disabled = device.supported === false || device.available === false;
      const kind = device.emulator ? "Emulator" : "Connected device";
      option.textContent = `${device.name || device.id} · ${device.platform || "unknown"} · ${kind}${option.disabled ? " · unsupported" : ""}`;
      picker.append(option);
    }
    setText("device-help", "Deploy sends the latest built package to the selected local target.");
  }
  updateActionStates();
}

async function loadDevices() {
  try {
    const response = await api("/api/devices");
    devices = Array.isArray(response) ? response : response.devices || [];
  } catch (error) {
    devices = [];
    setText("device-help", `Device discovery unavailable: ${normalizeError(error).message}`);
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
  state.textContent = status ? status[0].toUpperCase() + status.slice(1) : "Queued";
  state.className = `meta-chip${terminal && ["failed", "error"].includes(status) ? " bad" : terminal ? " good" : ""}`;
  const logs = Array.isArray(job?.logs) ? job.logs : job?.logs ? [job.logs] : [];
  $("deploy-log").textContent = logs.join("\n") || job?.error || (status ? `Job ${status}.` : "Waiting for deployment status…");
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
    showNotice("Build the saved project before deploying it.", "info");
    return;
  }
  clearNotice();
  startingDeploy = true;
  updateActionStates();
  try {
    setText("deploy-state", "Starting…");
    const result = await api(`/api/projects/${encodeURIComponent(currentId)}/deploy`, {
      method: "POST",
      body: JSON.stringify({ deviceId: $("device-picker").value }),
    });
    const job = result.job || result;
    const jobId = job.id || result.id;
    if (!jobId) throw new Error("Deployment did not return a job id.");
    activeDeploy = { id: jobId };
    renderDeploy(job);
    void pollDeploy();
    updateActionStates();
  } catch (error) {
    setText("deploy-state", "Failed");
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
    renderDeploy({ status: "cancelled", logs: ["Deployment cancelled."] });
  } catch (error) {
    showNotice(error);
  } finally {
    stopDeployPolling();
  }
}

function refreshSourceFromServer() {
  if (!currentId) return;
  if (dirty && !window.confirm("Discard the current unsaved draft and reload source files?")) return;
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
    setPreviewState("Starting", "loading");
    updateActionStates();
  }
  if (data.type === "preview.frame") {
    previewHasFrame = true;
    previewReady = true;
    sendPreviewRegions();
    setPreviewState("Ready", "ready");
    updateActionStates();
  }
  if (data.type === "preview.status") {
    const status = typeof data.status === "string" ? data.status : data.status?.state;
    if (status === "error" || status === "stopped") {
      previewReady = false;
      setPreviewState(status === "error" ? "Preview error" : "Stopped", "loading");
      if (status === "error") showNotice(data.error || data.status?.error || "The native preview reported an error.");
    } else if (status === "starting") {
      previewReady = false;
      setPreviewState("Starting", "loading");
    } else if (status === "ready" && previewHasFrame) {
      previewReady = true;
      setPreviewState("Ready", "ready");
    }
    updateActionStates();
  }
  if (data.type === "preview.error") {
    previewReady = false;
    setPreviewState("Preview error", "loading");
    showNotice(data.error || "The native preview reported an error.");
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
  setPreviewState("Starting", "loading");
  updateActionStates();
});
previewFrame.addEventListener("error", () => {
  previewReady = false;
  setPreviewState("Preview error", "loading");
  showNotice("The project preview could not be loaded.");
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
      body: JSON.stringify({ id: form.get("id"), name: form.get("name"), appId: form.get("appId"), version: form.get("version"), tickHz: Number(form.get("tickHz")) }),
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
$("refresh-preview").addEventListener("click", () => { void refreshPreview(); });
$("preview-open").addEventListener("click", () => { if (previewPath) window.open(previewBrowserUrl().href, "_blank", "noopener"); });
$("clear-log").addEventListener("click", () => { logEl.textContent = ""; });
$("refresh-source").addEventListener("click", refreshSourceFromServer);
$("file-picker").addEventListener("change", async (event) => {
  const nextFile = event.currentTarget.value;
  if (dirty && !window.confirm("Discard unsaved source changes?")) {
    event.currentTarget.value = currentFile;
    return;
  }
  try { clearNotice(); await loadFile(nextFile); } catch (error) { showNotice(error); }
});
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
  webBluetoothSupported = bluetoothProvider === "local" ? localBluetoothAvailable : browserBluetoothSupported;
  if (webBluetoothToggle) {
    webBluetoothToggle.checked = webBluetoothEnabled;
    webBluetoothToggle.disabled = !webBluetoothSupported;
  }
  if (bluetoothProviderPicker) {
    bluetoothProviderPicker.hidden = !localBluetoothAvailable;
    bluetoothProviderPicker.value = bluetoothProvider;
    bluetoothProviderPicker.querySelector('option[value="web"]').disabled = !browserBluetoothSupported;
  }
  setText("bluetooth-provider-label", bluetoothProvider === "local" ? "Local Bluetooth" : "Web Bluetooth");
  setText("web-bluetooth-help", bluetoothProvider === "local"
    ? "Request grants macOS Bluetooth access. Scan BLE discovers nearby devices inside the app."
    : webBluetoothSupported ? "Authorize a device with Request, then use Scan BLE in the app." : "Requires a browser with Web Bluetooth on localhost or HTTPS.");
}
if (webBluetoothToggle) {
  updateBluetoothSettings();
  webBluetoothToggle.addEventListener("change", () => {
    webBluetoothEnabled = webBluetoothToggle.checked && webBluetoothSupported;
    try { localStorage.setItem(WEB_BLUETOOTH_STORAGE_KEY, webBluetoothEnabled ? "1" : "0"); } catch {}
    sendPreviewPlugins();
  });
}
bluetoothProviderPicker?.addEventListener("change", () => {
  bluetoothProvider = bluetoothProviderPicker.value === "local" && localBluetoothAvailable ? "local" : "web";
  try { localStorage.setItem("pocket.editor.bluetoothProvider", bluetoothProvider); } catch {}
  updateBluetoothSettings();
  sendPreviewPlugins();
});
$("capture-preview").addEventListener("click", async () => {
  try {
    const capture = await capturePreview();
    downloadPreviewCapture(capture);
    showNotice("Preview screenshot downloaded.", "success");
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
  if (dirty) {
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
