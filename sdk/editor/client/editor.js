const $ = (id) => document.getElementById(id);
const projectsEl = $("projects");
const sourceEl = $("source");
const noticeEl = $("notice");
const logEl = $("log");
const createDialog = $("create-dialog");
const VIEWPORTS = {
  mobile: { width: 390, height: 844, label: "Mobile" },
  tablet: { width: 768, height: 1023, label: "Tablet" },
  desktop: { width: 1023, height: 768, label: "Desktop" },
};

const previewFrame = $("preview-frame");
const previewStage = $("preview-stage");
const previewStageWrap = $("preview-stage-wrap") || document.querySelector(".preview-stage-wrap");
const previewSurfaces = $("preview-surfaces");
const wechatPreviewPane = $("wechat-preview-pane");
const wechatPreviewFrame = $("wechat-preview-frame");
const wechatPreviewEmpty = $("wechat-preview-empty");

let projects = [];
let currentId = null;
const PREVIEW_HEIGHT_STORAGE_KEY = "pocket.editor.previewPaneHeight";
function storedPreviewPaneHeight() {
  try {
    const value = Number(localStorage.getItem(PREVIEW_HEIGHT_STORAGE_KEY));
    return Number.isFinite(value) && value >= 240 && value <= 1200 ? value : null;
  } catch {
    return null;
  }
}

let previewPaneHeight = storedPreviewPaneHeight();
let currentRevision = 0;
let currentStatus = null;
let currentFile = "app.tsx";
let projectFiles = [];
let polling = null;
let dirty = false;
let csrfToken = "";
const WECHAT_STATES = new Set(["idle", "building", "running", "error", "stopped"]);
const MAX_WECHAT_POLL_ATTEMPTS = 600;
const WECHAT_POLL_DELAY_MS = 500;
let wechatState = { state: "idle", url: "", error: "", logs: [] };
let wechatPollTimer = null;
let wechatGeneration = 0;
let startingWechat = false;
let stoppingWechat = false;


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
  const value = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(value?.error || value || `${response.status} ${response.statusText}`);
  return value;
}

function showNotice(error) {
  noticeEl.textContent = error instanceof Error ? error.message : String(error);
  noticeEl.hidden = false;
}

function clearNotice() { noticeEl.hidden = true; noticeEl.textContent = ""; }

function markDirty(value = true) {
  dirty = value;
  $("save-status").textContent = dirty ? "Unsaved changes" : "Saved";
  if (dirty) $("publish").disabled = true;
}

function renderProjects() {
  projectsEl.replaceChildren();
  for (const project of projects) {
    const button = document.createElement("button");
    button.className = `project-item${project.id === currentId ? " active" : ""}`;
    button.innerHTML = `<strong></strong><small></small>`;
    button.querySelector("strong").textContent = project.name;
    button.querySelector("small").textContent = `${project.id} · ${project.version}`;
    button.addEventListener("click", () => selectProject(project.id));
    projectsEl.append(button);
  }
  if (!projects.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No projects yet.";
    projectsEl.append(empty);
  }
}

function setEnabled(enabled) {
  for (const id of ["save", "build", "publish"]) $(id).disabled = !enabled;
  sourceEl.disabled = !enabled;
  $("file-picker").disabled = !enabled;
}

function fileUrl(projectId, filePath) {
  const encoded = filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `/api/projects/${encodeURIComponent(projectId)}/files/${encoded}`;
}

function renderFilePicker(files) {
  projectFiles = files.map((file) => file.path);
  const picker = $("file-picker");
  picker.replaceChildren();
  for (const file of projectFiles) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file;
    picker.append(option);
  }
  picker.value = projectFiles.includes(currentFile) ? currentFile : projectFiles[0] || "";
  $("active-file").textContent = picker.value || "No source file";
}

async function loadFile(filePath) {
  if (!currentId || !filePath) return;
  const content = await api(fileUrl(currentId, filePath));
  currentFile = content.path;
  sourceEl.value = content.content;
  $("file-picker").value = currentFile;
  $("active-file").textContent = currentFile;
  $("source-bytes").textContent = `${content.bytes.toLocaleString()} bytes`;
  currentRevision = content.revision;
  markDirty(false);
}

function updateWechatActionStates() {
  const busy = startingWechat || stoppingWechat || wechatState.state === "building";
  $("wechat-start").disabled = !currentId || busy || wechatState.state === "running";
  $("wechat-stop").hidden = !["building", "running"].includes(wechatState.state);
  $("wechat-stop").disabled = startingWechat || stoppingWechat;
  const link = $("wechat-open");
  link.hidden = wechatState.state !== "running" || !wechatState.url;
  if (!link.hidden) link.href = wechatState.url;
  else link.removeAttribute("href");
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
  if (projectLabel) projectLabel.textContent = readWechatProjectLabel(payload);
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
  updateWechatActionStates();
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
    layoutPreviewFrame();
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
    renderWechatState({ state: "error", error: (error instanceof Error ? error.message : String(error)), logs: [] });
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
      wechatPollTimer = setTimeout(() => void pollWechat(attempt + 1, projectId, generation), WECHAT_POLL_DELAY_MS);
    } else if (wechatState.state === "error" && wechatState.error) {
      showNotice(wechatState.error);
    }
  } catch (error) {
    if (currentId !== projectId || generation !== wechatGeneration) return;
    stopWechatPolling();
    renderWechatState({ ...wechatState, state: "error", error: (error instanceof Error ? error.message : String(error)) });
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
    renderWechatState({ state: "error", error: (error instanceof Error ? error.message : String(error)), logs: [] });
    showNotice(error);
  } finally {
    if (currentId === projectId && generation === wechatGeneration) {
      startingWechat = false;
      updateWechatActionStates();
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
  updateWechatActionStates();
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
      updateWechatActionStates();
    }
  }
}

async function refreshFiles({ preserveDraft = dirty } = {}) {
  if (!currentId) return;
  const filesResponse = await api(`/api/projects/${encodeURIComponent(currentId)}/files`);
  const files = filesResponse.files || filesResponse;
  renderFilePicker(files);
  if (preserveDraft) {
    showNotice("The server refreshed the file list. Your unsaved draft is still open; use Refresh files again to discard it.");
    return;
  }
  await loadFile(projectFiles.includes(currentFile) ? currentFile : projectFiles[0]);
}

function refreshInlineCanvas() {
  if (!currentId || !currentStatus || currentStatus.busy || currentStatus.error || dirty || currentStatus.builtRevision !== currentStatus.revision) return;
  $("preview-empty").hidden = true;
  previewFrame.hidden = false;
  previewFrame.src = `/api/projects/${encodeURIComponent(currentId)}/preview?t=${Date.now()}`;
  layoutPreviewFrame();
}
function layoutPreviewFrame() {
  const viewportKey = $("viewport-picker").value;
  const viewport = VIEWPORTS[viewportKey] || VIEWPORTS.mobile;
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
  const scale = Math.min(width / 390, height / 844);
  const renderedWidth = 390 * scale;
  const renderedHeight = 844 * scale;
  wechatPreviewFrame.style.width = "390px";
  wechatPreviewFrame.style.height = "844px";
  wechatPreviewFrame.style.left = `${Math.max(0, (width - renderedWidth) / 2)}px`;
  wechatPreviewFrame.style.top = `${Math.max(0, (height - renderedHeight) / 2)}px`;
  wechatPreviewFrame.style.transformOrigin = "top left";
  wechatPreviewFrame.style.transform = `scale(${scale})`;
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


function renderArtifacts(status) {
  const artifacts = $("artifacts");
  artifacts.replaceChildren();
  $("publish-info").hidden = true;
  $("runtime-abi").textContent = "ABI —";
  if (!status?.artifacts) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "Build the project to produce real QuickJS bytecode.";
    artifacts.append(empty);
  } else {
    $("runtime-abi").textContent = status.publish?.runtimeAbi || "ABI in metadata";
    const names = [["app.qjbc", status.artifacts.bytecode], ["app.bytecode.json", status.artifacts.metadata], ["app.pak", status.artifacts.pak], ["guest-manifest.json", status.artifacts.manifest], ["app.js (inspection)", status.artifacts.appJs], ["build.json", status.artifacts.build]];
    for (const [name, href] of names) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener";
      link.innerHTML = `<span></span><small>download ↗</small>`;
      link.querySelector("span").textContent = name;
      artifacts.append(link);
    }
  }
  if (status?.publish) {
    const info = $("publish-info");
    info.innerHTML = `Signed update ready · key <code></code> · <a target="_blank" rel="noopener">latest.json ↗</a> · <a target="_blank" rel="noopener">host.json ↗</a> · <a target="_blank" rel="noopener">download tar.gz ↗</a>`;
    info.querySelector("code").textContent = status.publish.keyId;
    const links = info.querySelectorAll("a");
    links[0].href = status.publish.manifestUrl || status.publish.updateUrl;
    links[1].href = status.publish.hostConfigUrl;
    links[2].href = status.publish.archiveUrl;
    info.hidden = false;
  }
}

function renderStatus(status) {
  currentStatus = status;
  $("source-revision").textContent = `revision ${status?.revision ?? "—"}`;
  const state = $("build-state");
  if (!status) state.textContent = "Not built";
  else if (status.busy) state.textContent = `Building r${status.revision}`;
  else if (status.error) state.textContent = "Build failed";
  else if (status.builtRevision === status.revision) state.textContent = `Built r${status.revision}`;
  else state.textContent = "Changes not built";
  state.className = `pill${status?.error ? " bad" : status?.builtRevision === status?.revision ? " good" : ""}`;
  $("log").textContent = status?.logs?.join("\n") || "No diagnostics yet.";
  $("log").scrollTop = $("log").scrollHeight;
  $("publish").disabled = dirty || !status || status.busy || !!status.error || status.builtRevision !== status.revision;
  $("build").disabled = !currentId || !!status?.busy;
  renderArtifacts(status);
}

async function refreshStatus() {
  if (!currentId) return;
  try {
    const status = await api(`/api/projects/${encodeURIComponent(currentId)}/status`);
    renderStatus(status);
    if (!status.busy && polling) { clearInterval(polling); polling = null; }
  } catch (error) { showNotice(error); }
}

function beginPolling() {
  if (polling) clearInterval(polling);
  polling = setInterval(refreshStatus, 900);
}

async function selectProject(id) {
  if (dirty && currentId !== id && !window.confirm("Discard unsaved guest source changes?")) return;
  invalidateWechatRequests();
  clearNotice();
  currentId = id;
  resetWechatPresentation();
  previewFrame.hidden = true;
  previewFrame.src = "about:blank";
  $("preview-empty").hidden = false;
  currentFile = "app.tsx";
  markDirty(false);
  renderProjects();
  setEnabled(false);
  try {
    const [config, files, status] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(id)}/config`),
      api(`/api/projects/${encodeURIComponent(id)}/files`),
      api(`/api/projects/${encodeURIComponent(id)}/status`),
    ]);
    $("project-title").textContent = config.name;
    $("project-subtitle").textContent = `${config.appId} · ${config.framework} · ${config.entry}`;
    $("config-name").value = config.name;
    $("config-app-id").value = config.appId;
    $("config-version").value = config.version;
    $("config-build").value = config.build;
    $("config-tick").value = config.tickHz;
    renderFilePicker(files.files);
    await loadFile(projectFiles.includes("app.tsx") ? "app.tsx" : projectFiles[0]);
    setEnabled(true);
    renderStatus(status);
    refreshInlineCanvas();
    await loadWechat(id, wechatGeneration);
  } catch (error) { showNotice(error); }
}

async function loadProjects(preferred) {
  try {
    const health = await api("/health");
    if (health?.csrfToken) csrfToken = health.csrfToken;
  } catch {
    // Keep startup resilient
  }
  projects = await api("/api/projects");
  renderProjects();
  const id = preferred || currentId || projects[0]?.id;
  if (id && projects.some((project) => project.id === id)) await selectProject(id);
  else { currentId = null; setEnabled(false); }
}

async function saveProject() {
  if (!currentId) return;
  clearNotice();
  $("save-status").textContent = "Saving…";
  try {
    const source = await api(fileUrl(currentId, currentFile), { method: "PUT", body: JSON.stringify({ content: sourceEl.value }) });
    const config = await api(`/api/projects/${encodeURIComponent(currentId)}/config`, { method: "PUT", body: JSON.stringify({
      name: $("config-name").value,
      appId: $("config-app-id").value,
      version: $("config-version").value,
      build: Number($("config-build").value),
      tickHz: Number($("config-tick").value),
    }) });
    currentRevision = config.status.revision;
    $("source-bytes").textContent = `${source.bytes.toLocaleString()} bytes`;
    $("project-title").textContent = config.name;
    markDirty(false);
    projects = await api("/api/projects");
    renderProjects();
    renderStatus(config.status);
  } catch (error) {
    $("save-status").textContent = "Save failed";
    showNotice(error);
    throw error;
  }
}

async function buildProject() {
  if (!currentId) return;
  clearNotice();
  try {
    if (dirty) await saveProject();
    const result = await api(`/api/projects/${encodeURIComponent(currentId)}/build`, { method: "POST", body: "{}" });
    renderStatus(result.status);
    beginPolling();
  } catch (error) { showNotice(error); }
}

async function publishProject() {
  if (!currentId) return;
  clearNotice();
  try {
    const result = await api(`/api/projects/${encodeURIComponent(currentId)}/publish`, { method: "POST", body: "{}" });
    renderStatus(result.status);
  } catch (error) { showNotice(error); }
}

$("new-project").addEventListener("click", () => { $("create-form").reset(); createDialog.showModal(); });
$("cancel-create").addEventListener("click", () => createDialog.close());
$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    clearNotice();
    const result = await api("/api/projects", { method: "POST", body: JSON.stringify({ id: form.get("id"), name: form.get("name"), appId: form.get("appId"), version: form.get("version"), tickHz: Number(form.get("tickHz")) }) });
    createDialog.close();
    await loadProjects(result.id);
  } catch (error) { showNotice(error); }
});
$("save").addEventListener("click", () => { void saveProject().catch(() => {}); });
$("build").addEventListener("click", buildProject);
$("publish").addEventListener("click", publishProject);
$("clear-log").addEventListener("click", () => { logEl.textContent = ""; });
$("file-picker").addEventListener("change", async (event) => {
  const nextFile = event.currentTarget.value;
  if (dirty && !window.confirm("Discard unsaved guest source changes?")) {
    event.currentTarget.value = currentFile;
    return;
  }
  try {
    clearNotice();
    await loadFile(nextFile);
  } catch (error) { showNotice(error); }
});
sourceEl.addEventListener("input", () => markDirty());
for (const id of ["config-name", "config-app-id", "config-version", "config-build", "config-tick"]) $(id).addEventListener("input", () => markDirty());
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveProject().catch(() => {}); }
});

$("wechat-start").addEventListener("click", () => { void startWechat(); });
$("wechat-stop").addEventListener("click", () => { void stopWechat(); });
window.addEventListener("beforeunload", stopWechatPolling);

$("refresh-preview").addEventListener("click", refreshInlineCanvas);
$("viewport-picker").addEventListener("change", () => {
  layoutPreviewFrame();
  const viewport = VIEWPORTS[$("viewport-picker").value] || VIEWPORTS.mobile;
  previewFrame.contentWindow?.postMessage({source:"pocket-editor",type:"preview.resize",width:viewport.width,height:viewport.height},location.origin);
});
previewFrame.addEventListener("load", layoutPreviewFrame);
window.addEventListener("resize", layoutPreviewFrame);
if (typeof ResizeObserver === "function") {
 const observer = new ResizeObserver(layoutPreviewFrame);
 observer.observe(previewStage); observer.observe(previewStageWrap); observer.observe(previewSurfaces);
}
setupPreviewHeightControl();

loadProjects().catch(showNotice);
