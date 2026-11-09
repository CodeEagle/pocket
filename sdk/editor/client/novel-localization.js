import { renderRichEditor } from "/novel-rich-editor.js";

const sessions = new Map();

const node = (tag, className = "", text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = String(text);
  return value;
};

const button = (text, className, action) => {
  const value = node("button", `nv-button ${className || ""}`, text);
  value.type = "button";
  value.addEventListener("click", action);
  return value;
};

function clone(value) {
  return structuredClone(value);
}

function emptyCatalog(locale) {
  return {
    format: "pocket-vn-locale",
    formatVersion: 1,
    locale,
    lines: {},
    speakers: {},
    choices: {},
    inputs: {},
    endings: {},
    ui: {},
  };
}

function collectStory(story) {
  const result = { lines: [], speakers: [], choices: [], inputs: [], endings: [] };
  if (!story || !story.script || typeof story.script !== "object") return result;
  const speakers = new Set();
  for (const [label, instructions] of Object.entries(story.script)) {
    if (!Array.isArray(instructions)) continue;
    instructions.forEach((instruction, index) => {
      if (!instruction || typeof instruction !== "object") return;
      const location = `${label}:${index}`;
      if (instruction.type === "say" && typeof instruction.id === "string") {
        result.lines.push({ id: instruction.id, label, location, text: instruction.text || "" });
        if (typeof instruction.speaker === "string") speakers.add(instruction.speaker);
      } else if (instruction.type === "choice" && typeof instruction.id === "string") {
        result.choices.push({
          id: instruction.id,
          label,
          location,
          prompt: instruction.prompt,
          options: Array.isArray(instruction.options) ? instruction.options.filter(option => option && typeof option.id === "string") : [],
        });
      } else if (instruction.type === "input" && typeof instruction.id === "string") {
        result.inputs.push({ id: instruction.id, location, prompt: instruction.prompt, placeholder: instruction.placeholder });
      } else if (instruction.type === "ending" && typeof instruction.id === "string" && instruction.text !== undefined) {
        result.endings.push({ id: instruction.id, label, location, text: instruction.text });
      }
    });
  }
  result.speakers = [...speakers].sort((a, b) => a.localeCompare(b));
  result.lines.sort((a, b) => a.location.localeCompare(b.location));
  result.choices.sort((a, b) => a.location.localeCompare(b.location));
  result.inputs.sort((a, b) => a.location.localeCompare(b.location));
  result.endings.sort((a, b) => a.location.localeCompare(b.location));
  return result;
}

function catalogsFrom(session) {
  return session.document?.catalogs || {};
}

function currentCatalog(session) {
  return catalogsFrom(session)[session.locale];
}

function setCatalogText(session, kind, id, field, value) {
  const next = clone(session.document);
  const catalog = next.catalogs[session.locale];
  const text = value.trim().length === 0 ? undefined : value;
  if (kind === "choice") {
    const choice = { ...(catalog.choices?.[id] || {}) };
    if (field === "prompt") {
      if (text === undefined) delete choice.prompt;
      else choice.prompt = value;
    } else {
      const options = { ...(choice.options || {}) };
      if (text === undefined) delete options[field];
      else options[field] = value;
      if (Object.keys(options).length) choice.options = options;
      else delete choice.options;
    }
    if (Object.keys(choice).length) catalog.choices[id] = choice;
    else delete catalog.choices[id];
  } else if (kind === "input") {
    const inputs = { ...(catalog.inputs || {}) };
    const input = { ...(inputs[id] || {}) };
    if (text === undefined) delete input[field];
    else input[field] = value;
    if (Object.keys(input).length) inputs[id] = input;
    else delete inputs[id];
    if (Object.keys(inputs).length) catalog.inputs = inputs;
    else delete catalog.inputs;
  } else {
    const target = catalog[kind] || {};
    if (text === undefined) delete target[id];
    else target[id] = value;
    if (Object.keys(target).length) catalog[kind] = target;
    else delete catalog[kind];
  }
  session.document = next;
  session.dirty = true;
  session.message = "有未保存的翻译";
  session.messageKind = "dirty";
}

function setAssetOverride(session, category, target, subKey, value) {
  const next = clone(session.document);
  const catalog = next.catalogs[session.locale];
  const assets = { ...(catalog.assets || {}) };
  if (category === "characters") {
    const characters = { ...(assets.characters || {}) };
    const expressions = { ...(characters[target] || {}) };
    if (value) expressions[subKey] = value;
    else delete expressions[subKey];
    if (Object.keys(expressions).length) characters[target] = expressions;
    else delete characters[target];
    if (Object.keys(characters).length) assets.characters = characters;
    else delete assets.characters;
  } else if (category === "cgs") {
    const cgs = { ...(assets.cgs || {}) };
    const override = { ...(cgs[target] || {}) };
    if (subKey === "asset") {
      if (value) override.asset = value;
      else if (override.title) override.asset = target;
      else delete override.asset;
    } else {
      if (value.trim()) { override.title = value; override.asset ||= target; }
      else delete override.title;
    }
    if (override.asset || override.title) cgs[target] = override;
    else delete cgs[target];
    if (Object.keys(cgs).length) assets.cgs = cgs;
    else delete assets.cgs;
  } else {
    const values = { ...(assets[category] || {}) };
    if (value) values[target] = value;
    else delete values[target];
    if (Object.keys(values).length) assets[category] = values;
    else delete assets[category];
  }
  if (Object.keys(assets).length) catalog.assets = assets;
  else delete catalog.assets;
  session.document = next;
  session.dirty = true;
  session.message = "有未保存的翻译";
  session.messageKind = "dirty";
}

function field({ label, source, value, path, multiline = true, onInput }) {
  const wrapper = node("label", "nv-locale-field");
  const labelNode = node("span", "nv-locale-field-label", label);
  const sourceNode = node("span", "nv-locale-source", source || "（原文为空）");
  const input = node(multiline ? "textarea" : "input", "nv-input nv-locale-input");
  input.setAttribute("aria-label", label);
  input.dataset.localePath = path;
  if (multiline) input.rows = 2;
  input.value = value || "";
  input.addEventListener("input", () => onInput(input.value));
  wrapper.append(labelNode, sourceNode, input);
  return wrapper;
}

function selectField({ label, source, value, path, options, onChange }) {
  const wrapper = node("label", "nv-locale-field");
  wrapper.append(node("span", "nv-locale-field-label", label), node("span", "nv-locale-source", source || "（未设置）"));
  const select = node("select", "nv-input nv-locale-input");
  select.setAttribute("aria-label", label);
  select.dataset.localePath = path;
  for (const [key, title] of options) {
    const option = node("option", "", title);
    option.value = key;
    option.selected = key === (value || "");
    select.append(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  wrapper.append(select);
  return wrapper;
}

function textSection(title, help, entries) {
  const section = node("section", "nv-locale-section");
  const heading = node("div", "nv-locale-section-head");
  heading.append(node("h3", "", title), node("p", "", help));
  const list = node("div", "nv-locale-fields");
  for (const entry of entries) list.append(entry);
  section.append(heading, list);
  return section;
}

function diagnosticTarget(container, path) {
  const fields = [...container.querySelectorAll("[data-locale-path]")];
  return fields.find(item => item.dataset.localePath === path)
    || (path.startsWith("sayRich.") ? fields.find(item => item.dataset.localePath === `lines.${path.slice("sayRich.".length)}`) : undefined);
}

function richCatalogDiagnostic(error) {
  const message = error?.message || String(error);
  const marker = "catalog.sayRich.";
  const start = message.indexOf(marker);
  if (start < 0) return null;
  const tail = message.slice(start + marker.length);
  const invalidMarker = " is invalid: ";
  const invalidAt = tail.indexOf(invalidMarker);
  if (invalidAt >= 0) {
    const id = tail.slice(0, invalidAt);
    return {
      severity: "error",
      code: "invalid-rich-annotation",
      path: `sayRich.${id}`,
      message: tail.slice(invalidAt + invalidMarker.length),
    };
  }
  const missingLineMarker = " requires a translated line in catalog.lines.";
  const missingLineAt = tail.indexOf(missingLineMarker);
  if (missingLineAt >= 0) {
    const id = tail.slice(0, missingLineAt);
    return {
      severity: "error",
      code: "missing-rich-translation",
      path: `sayRich.${id}`,
      message: "此行译文为空，现有译文注记无法对应文本范围。",
    };
  }
  return null;
}

function renderDiagnostics(session, container) {
  const box = container.querySelector("#novel-localization-diagnostics");
  if (!box) return;
  box.replaceChildren();
  const diagnostics = session.diagnostics || [];
  const errors = diagnostics.filter(item => item.severity === "error").length;
  const warnings = diagnostics.filter(item => item.severity === "warning").length;
  box.append(node("h3", "", `翻译校对 · ${errors} 个错误，${warnings} 项待翻译或提示`));
  if (!diagnostics.length) {
    box.append(node("p", "nv-locale-empty", "当前语言的剧情文本、界面文案和资源引用均通过校对。"));
    return;
  }
  const list = node("div", "nv-locale-diagnostic-list");
  for (const diagnostic of diagnostics) {
    const item = button("", `nv-locale-diagnostic ${diagnostic.severity}`, () => {
      const target = diagnosticTarget(container, diagnostic.path);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.focus();
      }
    });
    item.append(node("code", "", diagnostic.path), node("span", "", diagnostic.message));
    list.append(item);
  }
  box.append(list);
}

function render(session, container) {
  if (!container.isConnected) return;
  container.replaceChildren();
  if (session.loading) {
    container.append(node("p", "nv-locale-loading", "正在读取 canonical 翻译目录…"));
    return;
  }
  if (session.loadError) {
    container.append(node("p", "nv-locale-error", session.loadError));
    container.append(button("重新读取", "secondary", () => { void load(session, container); }));
    return;
  }

  const header = node("header", "nv-locale-header");
  const select = node("select", "nv-input nv-locale-select");
  select.setAttribute("aria-label", "当前翻译语言");
  const catalogTags = Object.keys(catalogsFrom(session)).sort((a, b) => a.localeCompare(b));
  for (const locale of catalogTags) {
    const option = node("option", "", `${catalogsFrom(session)[locale].locale} · ${catalogsFrom(session)[locale].fallbackLocale || "无回退"}`);
    option.value = locale;
    option.selected = locale === session.locale;
    select.append(option);
  }
  select.disabled = catalogTags.length === 0;
  select.addEventListener("change", () => { session.locale = select.value; session.diagnostics = session.diagnosticsByLocale?.[session.locale] || []; render(session, container); void refreshDiagnostics(session, container); });
  const newLocale = node("input", "nv-input nv-locale-new-tag");
  newLocale.placeholder = "例如 fr-FR";
  newLocale.setAttribute("aria-label", "新语言标签");
  const add = button("添加语言", "secondary", () => {
    const locale = newLocale.value.trim();
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale)) { showMessage(session, container, "请输入有效的语言标签，例如 fr-FR。", "error"); return; }
    if (Object.keys(catalogsFrom(session)).some(tag => tag.toLowerCase() === locale.toLowerCase())) { showMessage(session, container, "这个语言标签已经存在。", "error"); return; }
    const next = clone(session.document);
    next.catalogs[locale] = emptyCatalog(locale);
    session.document = next;
    session.locale = locale;
    session.dirty = true;
    session.diagnostics = [];
    session.message = "已添加空白翻译，请完成校对后保存。";
    session.messageKind = "dirty";
    render(session, container);
    void refreshDiagnostics(session, container);
  });
  header.append(select, newLocale, add);

  const actions = node("div", "nv-locale-actions");
  const save = button(session.saving ? "保存中…" : "保存翻译", "primary", () => { void saveCatalogs(session, container); });
  save.id = "novel-localization-save";
  save.disabled = session.saving || !session.dirty;
  const exportCurrent = button("导出当前语言", "quiet", () => {
    const catalog = currentCatalog(session);
    if (catalog) downloadJSON(`locale-${catalog.locale}.json`, catalog);
  });
  exportCurrent.disabled = !currentCatalog(session);
  const exportAll = button("导出全部语言", "quiet", () => downloadJSON("novel.locales.json", session.document));
  const importButton = button("导入 JSON", "quiet", () => container.querySelector("#novel-localization-import")?.click());
  const file = node("input", "nv-hidden-input");
  file.id = "novel-localization-import";
  file.type = "file";
  file.accept = ".json,application/json";
  file.setAttribute("aria-label", "导入翻译 JSON");
  file.addEventListener("change", () => { const selected = file.files?.[0]; if (selected) void importCatalogFile(session, container, selected); file.value = ""; });
  actions.append(save, exportCurrent, exportAll, importButton, file);

  const status = node("p", `nv-locale-status ${session.messageKind || ""}`, session.message || (session.dirty ? "有未保存的翻译" : "已保存"));
  status.id = "novel-localization-save-state";
  status.dataset.dirty = String(session.dirty);

  const catalog = currentCatalog(session);
  const body = node("div", "nv-locale-body");
  if (!catalog) {
    body.append(node("p", "nv-locale-empty", "尚未创建语言目录。输入语言标签后添加语言。"));
  } else {
    const fallbackLabel = node("label", "nv-locale-fallback");
    fallbackLabel.append(node("span", "", "回退语言"));
    const fallback = node("select", "nv-input");
    const noFallback = node("option", "", "不设置");
    noFallback.value = "";
    fallback.append(noFallback);
    for (const tag of catalogTags.filter(tag => tag !== session.locale)) {
      const option = node("option", "", tag);
      option.value = tag;
      option.selected = catalog.fallbackLocale === tag;
      fallback.append(option);
    }
    fallback.addEventListener("change", () => {
      const next = clone(session.document);
      const target = next.catalogs[session.locale];
      if (fallback.value) target.fallbackLocale = fallback.value;
      else delete target.fallbackLocale;
      session.document = next;
      session.dirty = true;
      session.message = "有未保存的翻译";
      session.messageKind = "dirty";
      status.textContent = session.message;
      status.dataset.dirty = "true";
      save.disabled = false;
      void refreshDiagnostics(session, container);
    });
    fallbackLabel.append(fallback);
    body.append(fallbackLabel);

    const story = collectStory(session.getStory?.());
    const textFields = [];
    for (const line of story.lines) {
      const lineField = node("div", "nv-locale-dialogue-field");
      lineField.append(field({ label: `对白 ${line.id}`, source: `${line.location} · ${line.text}`, value: catalog.lines?.[line.id], path: `lines.${line.id}`, onInput: value => changeField(session, container, "lines", line.id, undefined, value) }));
      const input = lineField.querySelector("textarea");
      const richHost = node("div", "nv-locale-rich-editor");
      const refreshRich = () => renderTranslatedRich(session, container, richHost, line.id, input);
      refreshRich();
      input.addEventListener("input", refreshRich);
      lineField.append(richHost);
      if (catalog.sayRich?.[line.id]) {
        const preservation = node("div", "nv-locale-rich-preserved");
        preservation.dataset.localeRichLine = line.id;
        preservation.append(node("p", "", "此译文已有独立注记，范围按当前译文计算；编辑文本时会保留注记并报告失效范围。"));
        preservation.append(button("清除此行译文注记，按纯文字翻译", "quiet", () => clearTranslatedRich(session, container, line.id)));
        lineField.append(preservation);
      }
      textFields.push(lineField);
    }
    body.append(textSection("剧情对白", "按稳定行 ID 编辑；缺项或空白会使用原文并显示在校对结果中。", textFields));

    const speakerFields = story.speakers.map(speaker => field({ label: `角色名 ${speaker}`, source: speaker, value: catalog.speakers?.[speaker], path: `speakers.${speaker}`, multiline: false, onInput: value => changeField(session, container, "speakers", speaker, undefined, value) }));
    body.append(textSection("角色名", "台词 speaker 值是稳定引用，这里只修改显示名称。", speakerFields));

    const choiceFields = [];
    for (const choice of story.choices) {
      if (choice.prompt !== undefined) choiceFields.push(field({ label: `选择问题 ${choice.id}`, source: `${choice.location} · ${choice.prompt}`, value: catalog.choices?.[choice.id]?.prompt, path: `choices.${choice.id}.prompt`, onInput: value => changeField(session, container, "choice", choice.id, "prompt", value) }));
      for (const option of choice.options) choiceFields.push(field({ label: `选项 ${choice.id} / ${option.id}`, source: option.text, value: catalog.choices?.[choice.id]?.options?.[option.id], path: `choices.${choice.id}.options.${option.id}`, onInput: value => changeField(session, container, "choice", choice.id, option.id, value) }));
    }
    body.append(textSection("选择与分支", "选项 ID、条件、目标和顺序仍由 story.json 决定。", choiceFields));

    const inputFields = [];
    for (const input of story.inputs) {
      if (input.prompt !== undefined) inputFields.push(field({ label: `输入提示 ${input.id}`, source: `${input.location} · ${input.prompt}`, value: catalog.inputs?.[input.id]?.prompt, path: `inputs.${input.id}.prompt`, onInput: value => changeField(session, container, "input", input.id, "prompt", value) }));
      if (input.placeholder !== undefined) inputFields.push(field({ label: `输入占位 ${input.id}`, source: `${input.location} · ${input.placeholder}`, value: catalog.inputs?.[input.id]?.placeholder, path: `inputs.${input.id}.placeholder`, onInput: value => changeField(session, container, "input", input.id, "placeholder", value) }));
    }
    body.append(textSection("玩家输入", "按稳定输入 ID 翻译提示和占位文字；变量、校验和取消目标仍由剧情配置。", inputFields));

    const endingFields = story.endings.map(ending => field({ label: `结局 ${ending.id}`, source: `${ending.location} · ${ending.text}`, value: catalog.endings?.[ending.id], path: `endings.${ending.id}`, onInput: value => changeField(session, container, "endings", ending.id, undefined, value) }));
    body.append(textSection("结局文案", "只替换展示文案，不改变结局 ID 或 CG。", endingFields));

    const registry = session.getAssets?.() || {};
    const mediaFields = [];
    const backgroundKeys = Object.keys(registry.backgrounds || {}).sort();
    for (const key of backgroundKeys) mediaFields.push(selectField({
      label: `背景替换 ${key}`,
      source: `原素材：${key}`,
      value: catalog.assets?.backgrounds?.[key],
      path: `assets.backgrounds.${key}`,
      options: [["", "使用原素材"], ...backgroundKeys.map(id => [id, id])],
      onChange: value => changeAsset(session, container, "backgrounds", key, undefined, value),
    }));
    for (const [character, expressions] of Object.entries(registry.characters || {}).sort(([a], [b]) => a.localeCompare(b))) {
      for (const expression of Object.keys(expressions || {}).sort()) {
        const candidates = Object.keys(expressions || {}).sort();
        mediaFields.push(selectField({
          label: `角色表情替换 ${character} / ${expression}`,
          source: `原素材：${character}.${expression}`,
          value: catalog.assets?.characters?.[character]?.[expression],
          path: `assets.characters.${character}.${expression}`,
          options: [["", "使用原素材"], ...candidates.map(id => [id, id])],
          onChange: value => changeAsset(session, container, "characters", character, expression, value),
        }));
      }
    }
    const cgKeys = Object.keys(registry.cgs || {}).sort();
    for (const key of cgKeys) {
      const cgOverride = catalog.assets?.cgs?.[key];
      const title = field({
        label: `CG 标题 ${key}`,
        source: registry.cgs[key]?.title || key,
        value: cgOverride?.title,
        path: `assets.cgs.${key}.title`,
        multiline: false,
        onInput: value => changeAsset(session, container, "cgs", key, "title", value),
      });
      mediaFields.push(selectField({
        label: `CG 替换 ${key}`,
        source: `原素材：${key}`,
        value: cgOverride?.asset,
        path: `assets.cgs.${key}`,
        options: [["", "使用原素材"], ...cgKeys.map(id => [id, id])],
        onChange: value => changeAsset(session, container, "cgs", key, "asset", value),
      }), title);
    }
    for (const key of Object.keys(registry.audio || {}).sort()) mediaFields.push(selectField({
      label: `音频替换 ${key}`,
      source: `原音频：${key}`,
      value: catalog.assets?.audio?.[key],
      path: `assets.audio.${key}`,
      options: [["", "使用原音频"], ...Object.keys(registry.audio || {}).sort().map(id => [id, id])],
      onChange: value => changeAsset(session, container, "audio", key, undefined, value),
    }));
    body.append(textSection("本地化素材", "只引用 novel.assets.json 中已登记的资源键，不写磁盘路径。", mediaFields));

    const uiDefaults = session.uiDefaults || {};
    const uiFields = Object.entries(uiDefaults).map(([key, source]) => field({ label: `界面 ${key}`, source, value: catalog.ui?.[key], path: `ui.${key}`, onInput: value => changeField(session, container, "ui", key, undefined, value) }));
    body.append(textSection("Pocket 玩家界面", "菜单、阅读设置、存读档和操作提示使用同一目录及回退规则。", uiFields));
  }

  const diagnostics = node("section", "nv-locale-diagnostics");
  diagnostics.id = "novel-localization-diagnostics";
  renderDiagnostics(session, diagnostics);
  const main = node("div", "nv-locale-workspace");
  main.append(status, header, actions, body, diagnostics);
  container.replaceChildren(main);
}

function changeField(session, container, kind, id, fieldName, value) {
  setCatalogText(session, kind, id, fieldName, value);
  const status = container.querySelector("#novel-localization-save-state");
  const save = container.querySelector("#novel-localization-save");
  if (status) { status.textContent = session.message; status.dataset.dirty = "true"; }
  if (save) save.disabled = false;
  scheduleDiagnostics(session, container);
}

function changeAsset(session, container, category, target, subKey, value) {
  setAssetOverride(session, category, target, subKey, value);
  const status = container.querySelector("#novel-localization-save-state");
  const save = container.querySelector("#novel-localization-save");
  if (status) { status.textContent = session.message; status.dataset.dirty = "true"; }
  if (save) save.disabled = false;
  scheduleDiagnostics(session, container);
}

function showMessage(session, container, message, kind = "info") {
  session.message = message;
  session.messageKind = kind;
  const status = container.querySelector("#novel-localization-save-state");
  if (status) { status.textContent = message; status.className = `nv-locale-status ${kind}`; }
}

function scheduleDiagnostics(session, container) {
  clearTimeout(session.diagnosticTimer);
  session.diagnosticTimer = setTimeout(() => { void refreshDiagnostics(session, container); }, 180);
}

async function refreshDiagnostics(session, container) {
  if (!currentCatalog(session) || !container.isConnected) return;
  const generation = (session.diagnosticGeneration || 0) + 1;
  session.diagnosticGeneration = generation;
  session.abortController?.abort();
  const controller = new AbortController();
  session.abortController = controller;
  const box = container.querySelector("#novel-localization-diagnostics");
  if (box) { box.replaceChildren(node("p", "nv-locale-loading", "正在校对当前草稿…")); }
  try {
    const result = await session.api(`${session.base}/locales/diagnostics`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ locale: session.locale, collection: session.document, story: session.getStory?.(), assets: session.getAssets?.() }),
    });
    if (controller.signal.aborted || generation !== session.diagnosticGeneration) return;
    session.diagnostics = result.diagnostics || [];
    session.diagnosticsByLocale ||= {};
    session.diagnosticsByLocale[session.locale] = session.diagnostics;
    renderDiagnostics(session, container);
  } catch (error) {
    if (controller.signal.aborted || generation !== session.diagnosticGeneration) return;
    const richDiagnostic = richCatalogDiagnostic(error);
    if (richDiagnostic) {
      session.diagnostics = [richDiagnostic];
      session.diagnosticsByLocale ||= {};
      session.diagnosticsByLocale[session.locale] = session.diagnostics;
      renderDiagnostics(session, container);
      showMessage(session, container, "译文注记范围需要修复或清除。", "error");
    } else {
      showMessage(session, container, error.message || String(error), "error");
    }
  }
}

// The source and translation panels share the same range controls and SDK validator.
// This wrapper is a transient view into the selected catalog, never a second body.
function renderTranslatedRich(session, container, host, lineId, input) {
  host.disposeRich?.();
  host.replaceChildren();
  const catalog = currentCatalog(session);
  const instruction = { id: lineId, text: catalog.lines?.[lineId] || "" };
  if (catalog.sayRich?.[lineId] !== undefined) instruction.rich = catalog.sayRich[lineId];
  const changed = () => {
    const target = currentCatalog(session);
    if (instruction.rich === undefined) {
      if (target.sayRich) {
        delete target.sayRich[lineId];
        if (!Object.keys(target.sayRich).length) delete target.sayRich;
      }
    } else {
      target.sayRich ||= {};
      target.sayRich[lineId] = instruction.rich;
    }
    session.dirty = true;
    session.message = "有未保存的翻译";
    session.messageKind = "dirty";
    const status = container.querySelector("#novel-localization-save-state");
    if (status) { status.textContent = session.message; status.dataset.dirty = "true"; }
    const save = container.querySelector("#novel-localization-save");
    if (save) save.disabled = false;
    scheduleDiagnostics(session, container);
  };
  const editField = (parent, label, value, onChange, options = {}) => {
    const wrapper = node("label", `nv-field ${options.wide ? "wide" : ""}`);
    wrapper.append(node("span", "nv-field-label", label));
    const control = node(options.multiline ? "textarea" : options.select ? "select" : "input", "nv-input");
    control.setAttribute("aria-label", label);
    if (options.select) {
      for (const [key, title] of options.select) {
        const option = node("option", "", title); option.value = key; control.append(option);
      }
    } else {
      if (!options.multiline) control.type = options.type || "text";
      if (options.min !== undefined) control.min = String(options.min);
      if (options.max !== undefined) control.max = String(options.max);
      if (options.type === "number") control.step = "1";
    }
    control.value = value == null ? "" : String(value);
    control.addEventListener(options.select ? "change" : "input", () => {
      const next = options.type === "number" ? Number(control.value) : control.value;
      if (options.type === "number" && (control.value === "" || !Number.isSafeInteger(next)
          || options.min !== undefined && next < options.min
          || options.max !== undefined && next > options.max)) {
        control.setAttribute("aria-invalid", "true"); return;
      }
      control.removeAttribute("aria-invalid");
      onChange(next);
      changed();
    });
    wrapper.append(control); parent.append(wrapper); return control;
  };
  host.disposeRich = renderRichEditor(host, instruction, 0, input, {
    node, button, field: editField, issue: session.richIssue,
    scope: `locale:${session.locale}:${lineId}`,
    getInstruction: () => instruction,
    mutate: (_key, action) => { action(); changed(); },
    refresh: () => renderTranslatedRich(session, container, host, lineId, input),
  });
}

function clearTranslatedRich(session, container, lineId) {
  const next = clone(session.document);
  const catalog = next.catalogs[session.locale];
  if (!catalog?.sayRich?.[lineId]) return;
  delete catalog.sayRich[lineId];
  if (Object.keys(catalog.sayRich).length === 0) delete catalog.sayRich;
  session.document = next;
  session.dirty = true;
  session.message = "已清除此行译文注记；译文将按纯文字显示。";
  session.messageKind = "dirty";
  render(session, container);
  void refreshDiagnostics(session, container);
}

async function load(session, container) {
  container = session.container || container;
  session.loading = true;
  session.loadError = "";
  render(session, container);
  try {
    const [result, runtime] = await Promise.all([
      session.api(`${session.base}/locales`),
      import(`${session.base}/runtime.js`),
    ]);
    session.richIssue = runtime.novelSayRichTemplateIssue;
    session.document = result.collection;
    session.uiDefaults = result.uiDefaults || {};
    session.diagnosticsByLocale = result.diagnostics || {};
    session.locale = session.locale && session.document.catalogs[session.locale]
      ? session.locale
      : Object.keys(session.document.catalogs)[0] || "";
    session.diagnostics = session.diagnosticsByLocale[session.locale] || [];
    session.dirty = false;
    session.loading = false;
    session.message = "已保存";
    session.messageKind = "saved";
    render(session, session.container || container);
    if (session.locale) void refreshDiagnostics(session, session.container || container);
  } catch (error) {
    session.loading = false;
    session.loadError = error.message || String(error);
    render(session, session.container || container);
  }
}

async function saveCatalogs(session, container) {
  if (!session.dirty || session.saving) return;
  session.saving = true;
  render(session, container);
  try {
    const result = await session.api(`${session.base}/locales`, { method: "PUT", body: JSON.stringify(session.document) });
    session.document = result.collection;
    session.diagnosticsByLocale = result.diagnostics || {};
    session.diagnostics = session.diagnosticsByLocale[session.locale] || [];
    session.dirty = false;
    session.message = "已保存";
    session.messageKind = "saved";
  } catch (error) {
    session.message = error.message || String(error);
    session.messageKind = "error";
  } finally {
    session.saving = false;
    render(session, container);
  }
}

async function importCatalogFile(session, container, file) {
  try {
    const parsed = JSON.parse(await file.text());
    let candidate;
    if (parsed?.format === "pocket-vn-locales" && parsed?.formatVersion === 1 && parsed?.catalogs && typeof parsed.catalogs === "object") {
      candidate = parsed;
    } else if (parsed?.format === "pocket-vn-locale" && parsed?.formatVersion === 1 && typeof parsed.locale === "string") {
      candidate = clone(session.document);
      candidate.catalogs[parsed.locale] = parsed;
    } else throw new Error("导入文件必须是一个语言目录或完整翻译集合。");
    const result = await session.api(`${session.base}/locales`, { method: "PUT", body: JSON.stringify(candidate) });
    session.document = result.collection;
    session.diagnosticsByLocale = result.diagnostics || {};
    session.locale = Object.keys(session.document.catalogs).find(tag => tag.toLowerCase() === parsed.locale?.toLowerCase()) || session.locale || Object.keys(session.document.catalogs)[0] || "";
    session.diagnostics = session.diagnosticsByLocale[session.locale] || [];
    session.dirty = false;
    session.message = "翻译已导入并保存";
    session.messageKind = "saved";
    render(session, container);
    if (session.locale) void refreshDiagnostics(session, container);
  } catch (error) {
    showMessage(session, container, error.message || String(error), "error");
  }
}

function downloadJSON(filename, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

export function mount(container, options) {
  const { projectId, base, getStory, getAssets, api } = options;
  let session = sessions.get(projectId);
  if (!session) {
    session = { loading: true, document: null, locale: "", dirty: false, diagnostics: [], diagnosticsByLocale: {}, uiDefaults: {}, message: "", messageKind: "" };
    sessions.set(projectId, session);
  }
  session.base = base;
  session.api = api;
  session.container = container;
  session.getStory = getStory;
  session.getAssets = getAssets;
  render(session, container);
  if (session.loading && !session.loadPromise) {
    session.loadPromise = load(session, container).finally(() => { session.loadPromise = undefined; });
  } else if (session.locale) void refreshDiagnostics(session, container);
  const beforeUnload = event => {
    if (!session.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);
  return () => {
    clearTimeout(session.diagnosticTimer);
    session.abortController?.abort();
    window.removeEventListener("beforeunload", beforeUnload);
  };
}

window.pocketNovelLocalization = Object.freeze({ mount });
