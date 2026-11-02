const $ = (id) => document.getElementById(id);
const projectsEl = $("projects");
const sourceEl = $("source");
const noticeEl = $("notice");
const logEl = $("log");
const createDialog = $("create-dialog");
let projects = [];
let currentId = null;
let currentRevision = 0;
let currentStatus = null;
let currentFile = "app.tsx";
let projectFiles = [];
let polling = null;
let dirty = false;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
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
  clearNotice();
  currentId = id;
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
  } catch (error) { showNotice(error); }
}

async function loadProjects(preferred) {
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

void loadProjects().catch(showNotice);
