const maxTextBytes = 2 * 1024 * 1024;

function cloneJson(value) {
  return structuredClone(value);
}

function countEntries(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function sourceLocationForValidation(error, story, sourceMap) {
  const message = error instanceof Error ? error.message : String(error);
  const instructionPath = message.match(/([A-Za-z0-9._:-]+)\[(\d+)\]/);
  if (instructionPath) {
    const location = sourceMap?.instructions?.[instructionPath[1]]?.[Number(instructionPath[2])];
    if (location) return location;
  }
  const stableId = message.match(/(say|choice) id '([^']+)'/);
  if (stableId && story?.script) {
    for (const [label, instructions] of Object.entries(story.script)) {
      const matches = instructions.flatMap((instruction, index) => instruction.type === stableId[1] && instruction.id === stableId[2] ? [index] : []);
      const index = message.includes("duplicated") ? matches[1] ?? matches[0] : matches[0];
      if (index >= 0) {
        const location = sourceMap?.instructions?.[label]?.[index];
        if (location) return location;
      }
    }
  }
  return sourceMap?.header ?? { line: 1, column: 1, offset: 0 };
}

function presentError(message, location) {
  return `第 ${location.line} 行，第 ${location.column} 列：${message}`;
}

function formatDiagnostic(diagnostic) {
  return presentError(diagnostic.message, diagnostic);
}

function downloadText(projectId, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${projectId || "story"}-story.pvn.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Mount the text view over the editor's current StoryDefinition and history. */
export async function mountNovelAuthoring(container, options) {
  const engineModule = await options.getEngineModule?.();
  if (!engineModule || typeof engineModule.parseStoryText !== "function" || typeof engineModule.formatStoryText !== "function") {
    throw new Error("Novel runtime bundle does not export parseStoryText() and formatStoryText().");
  }

  const element = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  };
  container.replaceChildren();
  container.dataset.projectId = options.projectId || "";
  const workspace = element("section", "nv-text-authoring");
  const toolbar = element("div", "nv-text-toolbar");
  const importButton = element("button", "nv-text-button", "导入文本");
  importButton.type = "button";
  importButton.title = "将 .pvn.txt 文本加载到本地草稿；应用后才会进入故事编辑历史";
  const exportButton = element("button", "nv-text-button", "导出当前文本");
  exportButton.type = "button";
  const applyButton = element("button", "nv-text-button nv-text-apply", "应用到剧情区块");
  applyButton.type = "button";
  toolbar.append(importButton, exportButton, applyButton);

  const fileInput = element("input", "nv-text-file");
  fileInput.type = "file";
  fileInput.accept = ".txt,.pvn,text/plain";
  fileInput.setAttribute("aria-label", "导入 Pocket VN 文本文件");
  fileInput.hidden = true;
  const help = element("p", "nv-text-help", "每个对白、选择和指令保留稳定 ID；用 label 切换剧情段。每条指令都能用 JSON 编辑完整字段和自定义元数据。支持 # 注释与 JSON 字符串标签。格式说明见 SDK 文档。");
  const textareaLabel = element("label", "nv-text-label", "Pocket VN authoring text");
  const textarea = element("textarea", "nv-text-source");
  textarea.id = `nv-text-source-${Math.random().toString(36).slice(2)}`;
  textarea.spellcheck = false;
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.setAttribute("aria-label", "Pocket VN 文本剧本");
  textarea.setAttribute("aria-describedby", "nv-text-status nv-text-diagnostics nv-text-asset-summary");
  textareaLabel.htmlFor = textarea.id;
  textareaLabel.textContent = "故事文本";
  const diagnostics = element("div", "nv-text-diagnostics");
  diagnostics.id = "nv-text-diagnostics";
  diagnostics.setAttribute("role", "status");
  diagnostics.setAttribute("aria-live", "polite");
  const status = element("p", "nv-text-status", "文本与剧情区块一致。");
  status.id = "nv-text-status";
  const assets = element("p", "nv-text-asset-summary");
  assets.id = "nv-text-asset-summary";
  const conflict = element("div", "nv-text-conflict");
  conflict.hidden = true;
  const conflictMessage = element("span", "nv-text-conflict-message");
  const reloadButton = element("button", "nv-text-button", "重新载入区块");
  reloadButton.type = "button";
  const keepButton = element("button", "nv-text-button", "保留文本草稿");
  keepButton.type = "button";
  conflict.append(conflictMessage, reloadButton, keepButton);
  workspace.append(toolbar, fileInput, help, textareaLabel, textarea, status, assets, conflict, diagnostics);
  container.append(workspace);

  let appliedBaseline = engineModule.formatStoryText(options.getStory());
  const savedDraft = options.getDraft?.();
  let draftBaseline = savedDraft?.baseline ?? appliedBaseline;
  textarea.value = savedDraft?.text ?? appliedBaseline;
  let latestParse = engineModule.parseStoryText(textarea.value);
  let localDraft = Boolean(savedDraft && savedDraft.text !== appliedBaseline);
  let conflictDetected = Boolean(savedDraft && savedDraft.baseline !== appliedBaseline);
  let allowOverwrite = false;
  let disposed = false;
  let unsubscribeStory = null;

  if (conflictDetected) {
    conflictMessage.textContent = "文本草稿对应的剧情区块已变化；重新载入或确认覆盖。";
    keepButton.hidden = false;
  }

  const currentAssetSummary = () => {
    const registry = options.getAssets?.() ?? {};
    const models = countEntries(registry.models);
    const collections = countEntries(registry.collections);
    const entries = collections
      ? Object.values(registry.collections).reduce((total, collection) => total + countEntries(collection?.entries), 0)
      : 0;
    assets.textContent = `资源索引 · 背景 ${countEntries(registry.backgrounds)} · 角色 ${countEntries(registry.characters)} · CG ${countEntries(registry.cgs)} · 音频 ${countEntries(registry.audio)} · 视频 ${countEntries(registry.videos)}${models ? ` · 模型 ${models}` : ""}${collections ? ` · 收藏集 ${collections} · 条目 ${entries}` : ""}`;
  };

  const setDiagnostic = (message = "", kind = "error") => {
    diagnostics.textContent = message;
    diagnostics.dataset.kind = kind;
    diagnostics.hidden = !message;
  };

  const render = () => {
    if (disposed) return;
    latestParse = engineModule.parseStoryText(textarea.value);
    const parseError = latestParse.diagnostics?.[0];
    if (parseError) {
      status.textContent = "文本格式有错误，修复后可以应用。";
      status.dataset.kind = "error";
      setDiagnostic(formatDiagnostic(parseError));
      applyButton.disabled = true;
    } else {
      status.textContent = localDraft ? "有未应用的文本草稿。" : "文本与剧情区块一致。";
      status.dataset.kind = localDraft ? "draft" : "ok";
      setDiagnostic("");
      applyButton.disabled = conflictDetected || !localDraft;
    }
    conflict.hidden = !conflictDetected;
    currentAssetSummary();
    exportButton.disabled = textarea.value.length === 0;
  };

  const reloadFromStory = (story = options.getStory()) => {
    appliedBaseline = engineModule.formatStoryText(story);
    draftBaseline = appliedBaseline;
    textarea.value = appliedBaseline;
    localDraft = false;
    conflictDetected = false;
    allowOverwrite = false;
    options.setDraft?.(null);
    conflictMessage.textContent = "";
    keepButton.hidden = true;
    render();
  };

  const onInput = () => {
    localDraft = textarea.value !== appliedBaseline;
    if (!localDraft) {
      conflictDetected = false;
      allowOverwrite = false;
      draftBaseline = appliedBaseline;
    }
    options.setDraft?.(localDraft ? { text: textarea.value, baseline: draftBaseline } : null);
    render();
  };
  const onImport = () => fileInput.click();
  const onFile = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (file.size > maxTextBytes) {
      setDiagnostic(`文本文件超过 ${maxTextBytes} 字节限制。`);
      return;
    }
    try {
      textarea.value = await file.text();
      localDraft = textarea.value !== appliedBaseline;
      if (!localDraft) {
        conflictDetected = false;
        allowOverwrite = false;
        draftBaseline = appliedBaseline;
      }
      options.setDraft?.(localDraft ? { text: textarea.value, baseline: draftBaseline } : null);
      render();
    } catch (error) {
      setDiagnostic(`无法读取文本文件：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const onExport = () => downloadText(options.projectId, textarea.value);
  const onApply = async () => {
    if (applyButton.disabled || conflictDetected) return;
    const parsed = engineModule.parseStoryText(textarea.value);
    latestParse = parsed;
    if (parsed.diagnostics?.length || !parsed.story) {
      render();
      return;
    }
    const currentText = engineModule.formatStoryText(options.getStory());
    if (currentText !== appliedBaseline && !allowOverwrite) {
      conflictDetected = true;
      conflictMessage.textContent = "剧情区块在本地草稿之后已变化。先重新载入，或保留草稿并确认覆盖。";
      keepButton.hidden = false;
      options.setDraft?.({ text: textarea.value, baseline: draftBaseline });
      render();
      return;
    }
    applyButton.disabled = true;
    status.textContent = "正在校验并应用到剧情区块…";
    status.dataset.kind = "busy";
    setDiagnostic("");
    const draftBeforeApply = options.getDraft?.() ?? { text: textarea.value, baseline: appliedBaseline };
    options.setDraft?.(null);
    try {
      const result = await options.commitStory(parsed.story, { source: "author-text" });
      if (disposed || !container.isConnected) return;
      const savedStory = result?.story ?? parsed.story;
      appliedBaseline = engineModule.formatStoryText(savedStory);
      draftBaseline = appliedBaseline;
      textarea.value = appliedBaseline;
      localDraft = false;
      conflictDetected = false;
      allowOverwrite = false;
      render();
      status.textContent = "文本已应用到共享的剧情区块；撤销与重做由编辑器管理。";
      status.dataset.kind = "ok";
    } catch (error) {
      options.setDraft?.(draftBeforeApply);
      const location = sourceLocationForValidation(error, parsed.story, parsed.sourceMap);
      const message = error instanceof Error ? error.message : String(error);
      setDiagnostic(presentError(message, location));
      status.textContent = "引擎校验未通过，剧情区块没有改变。";
      status.dataset.kind = "error";
      applyButton.disabled = false;
    }
  };
  const onReload = () => reloadFromStory();
  const onKeep = () => {
    conflictDetected = false;
    allowOverwrite = true;
    appliedBaseline = engineModule.formatStoryText(options.getStory());
    draftBaseline = appliedBaseline;
    options.setDraft?.({ text: textarea.value, baseline: draftBaseline });
    keepButton.hidden = true;
    conflictMessage.textContent = "文本草稿保留。应用时会以此草稿替换当前区块。";
    render();
    conflict.hidden = false;
  };
  const onKeydown = event => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void onApply();
    }
  };

  importButton.addEventListener("click", onImport);
  fileInput.addEventListener("change", onFile);
  exportButton.addEventListener("click", onExport);
  applyButton.addEventListener("click", onApply);
  reloadButton.addEventListener("click", onReload);
  keepButton.addEventListener("click", onKeep);
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("keydown", onKeydown);
  if (typeof options.subscribeStory === "function") {
    unsubscribeStory = options.subscribeStory(story => {
      if (disposed) return;
      const next = engineModule.formatStoryText(story);
      if (localDraft && textarea.value !== next) {
        conflictDetected = true;
        conflictMessage.textContent = "剧情区块已改变；文本框保留了未应用草稿。重新载入或确认覆盖。";
        keepButton.hidden = false;
        options.setDraft?.({ text: textarea.value, baseline: draftBaseline });
        render();
      } else reloadFromStory(story);
    });
  }
  if (options.base) container.dataset.apiBase = options.base;
  void options.api;
  render();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try { unsubscribeStory?.(); } catch {}
      importButton.removeEventListener("click", onImport);
      fileInput.removeEventListener("change", onFile);
      exportButton.removeEventListener("click", onExport);
      applyButton.removeEventListener("click", onApply);
      reloadButton.removeEventListener("click", onReload);
      keepButton.removeEventListener("click", onKeep);
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("keydown", onKeydown);
    },
  };
}

export const mount = mountNovelAuthoring;
