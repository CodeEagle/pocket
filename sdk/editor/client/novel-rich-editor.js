function sayRichCodePointOffset(text, utf16Offset) {
  let codePoints = 0;
  let offset = 0;
  for (const character of text) {
    if (offset >= utf16Offset) break;
    offset += character.length;
    codePoints++;
  }
  return codePoints;
}

function nextSayRichId(instruction, prefix) {
  const used = new Set([
    ...(Array.isArray(instruction.rich?.spans) ? instruction.rich.spans : []),
    ...(Array.isArray(instruction.rich?.pauses) ? instruction.rich.pauses : []),
  ].map(item => item?.id).filter(value => typeof value === "string"));
  let id;
  do { id = `${prefix}_${Math.random().toString(36).slice(2, 9)}`; } while (used.has(id));
  return id;
}

function ensureSayRich(instruction) {
  if (!instruction.rich || typeof instruction.rich !== "object" || Array.isArray(instruction.rich)) {
    instruction.rich = { spans: [], pauses: [] };
  } else {
    if (!Array.isArray(instruction.rich.spans)) instruction.rich.spans = [];
    if (!Array.isArray(instruction.rich.pauses)) instruction.rich.pauses = [];
  }
  return instruction.rich;
}

function removeEmptySayRich(instruction) {
  if (instruction.rich && Array.isArray(instruction.rich.spans) && Array.isArray(instruction.rich.pauses)
      && instruction.rich.spans.length === 0 && instruction.rich.pauses.length === 0) {
    delete instruction.rich;
  }
}

function selectedSayRange(textInput, text) {
  if (!textInput) return null;
  const start = sayRichCodePointOffset(text, textInput.selectionStart ?? 0);
  const end = sayRichCodePointOffset(text, textInput.selectionEnd ?? 0);
  return end > start ? { start, end } : null;
}

export function renderRichEditor(parent, instruction, index, textInput, adapter) {
  const { node, button, field, issue, mutate, getInstruction, refresh, scope = "" } = adapter;
  const listeners = [];
  const listen = (event, callback) => {
    if (!textInput) return;
    textInput.addEventListener(event, callback);
    listeners.push(() => textInput.removeEventListener(event, callback));
  };
  const section = node("section", "nv-say-rich");
  section.dataset.sayRich = instruction.id ?? String(index);
  const heading = node("div", "nv-row-head", "富文本注记");
  const help = node("p", "nv-field-help", "对白正文仍是唯一文本来源。样式、注音、内部注释与停顿使用 Unicode 字符序号（从 0 开始；范围结束位置不包含该字符）。");
  const count = Array.from(String(instruction.text ?? "")).length;
  const currentRich = instruction.rich && typeof instruction.rich === "object" && !Array.isArray(instruction.rich) ? instruction.rich : null;
  const spans = Array.isArray(currentRich?.spans) ? currentRich.spans : [];
  const pauses = Array.isArray(currentRich?.pauses) ? currentRich.pauses : [];
  const diagnostic = node("p", "nv-rich-diagnostic");
  diagnostic.dataset.richDiagnostic = "true";
  const refreshRichDiagnostic = () => {
    const currentIssue = instruction.rich === undefined ? null
      : typeof issue === "function"
        ? issue(String(instruction.text ?? ""), instruction.rich)
        : "SDK 富文本校验器不可用；请重新打开编辑器后再保存或构建。";
    diagnostic.className = currentIssue ? "nv-rich-diagnostic error" : "nv-rich-diagnostic";
    diagnostic.textContent = currentIssue || `正文 ${Array.from(String(instruction.text ?? "")).length} 个 Unicode 字符 · ${Array.isArray(instruction.rich?.spans) ? instruction.rich.spans.length : 0} 个范围 · ${Array.isArray(instruction.rich?.pauses) ? instruction.rich.pauses.length : 0} 个停顿`;
  };
  const richField = (fieldParent, label, value, onChange, options = {}) => {
    const input = field(fieldParent, label, value, onChange, options);
    input.addEventListener("input", refreshRichDiagnostic);
    input.addEventListener("change", refreshRichDiagnostic);
    return input;
  };
  refreshRichDiagnostic();

  const actions = node("div", "nv-say-rich-actions");
  const addSpan = button("将选中文字设为富文本范围", "quiet", () => {
    const range = selectedSayRange(textInput, String(instruction.text ?? ""));
    if (!range) return;
    mutate( `say:rich:span:add:${scope}:${index}`, () => {
      const rich = ensureSayRich(getInstruction());
      rich.spans.push({ id: nextSayRichId(getInstruction(), "span"), ...range });
      rich.spans.sort((left, right) => left.start - right.start);
    });
    refresh();
  });
  addSpan.dataset.addSayRichSpan = "true";
  const refreshSpanButton = () => { addSpan.disabled = !selectedSayRange(textInput, String(instruction.text ?? "")); };
  listen("select", refreshSpanButton);
  listen("keyup", refreshSpanButton);
  listen("mouseup", refreshSpanButton);
  addSpan.addEventListener("pointerdown", event => event.preventDefault());
  refreshSpanButton();
  actions.append(addSpan);

  const addPause = button("在光标 / 选区后添加手动停顿", "quiet", () => {
    const text = String(instruction.text ?? "");
    const at = sayRichCodePointOffset(text, textInput?.selectionEnd ?? text.length);
    mutate( `say:rich:pause:add:${scope}:${index}`, () => {
      const target = getInstruction();
      ensureSayRich(target).pauses.push({ id: nextSayRichId(target, "pause"), at, durationMs: null });
      target.rich.pauses.sort((left, right) => left.at - right.at);
    });
    refresh();
  });
  addPause.dataset.addSayRichPause = "true";
  addPause.addEventListener("pointerdown", event => event.preventDefault());
  actions.append(addPause);

  if (instruction.rich !== undefined) {
    actions.append(button("移除全部富文本注记", "quiet danger", () => {
      mutate( `say:rich:remove:${scope}:${index}`, () => { delete getInstruction().rich; });
      refresh();
    }));
  }

  section.append(heading, help, diagnostic, actions);
  for (const [spanIndex, span] of spans.entries()) {
    const row = node("div", "nv-rich-span");
    row.dataset.richSpanIndex = String(spanIndex);
    if (typeof span?.id === "string") row.dataset.richSpanId = span.id;
    row.append(node("div", "nv-row-head", `范围 ${spanIndex + 1}`));
    if (!span || typeof span !== "object" || Array.isArray(span)) {
      row.append(node("p", "nv-rich-diagnostic error", "此范围数据无效；移除后可以重新添加。"), button("移除无效范围", "quiet danger", () => {
        mutate( `say:rich:span:remove:${scope}:${index}:${spanIndex}`, () => {
          getInstruction().rich.spans.splice(spanIndex, 1);
          removeEmptySayRich(getInstruction());
        });
        refresh();
      }));
      section.append(row);
      continue;
    }
    richField(row, "范围 ID", span.id ?? "", value => { span.id = value; }, { historyKey: `story:say-rich-span-id:${instruction.id}:${spanIndex}` });
    const startField = richField(row, "开始字符（含）", span.start, value => { span.start = value; }, { type: "number", integer: true, safeInteger: true, min: 0, historyKey: `story:say-rich-span-start:${instruction.id}:${span.id}` });
    const endField = richField(row, "结束字符（不含）", span.end, value => { span.end = value; }, { type: "number", integer: true, safeInteger: true, min: 0, historyKey: `story:say-rich-span-end:${instruction.id}:${span.id}` });
    startField.dataset.richBoundary = "true";
    endField.dataset.richBoundary = "true";
    startField.max = String(count);
    endField.max = String(count);
    const style = span.style && typeof span.style === "object" && !Array.isArray(span.style) ? span.style : {};
    richField(row, "文本颜色", style.color ?? "", value => {
      const next = { ...(span.style && typeof span.style === "object" && !Array.isArray(span.style) ? span.style : {}) };
      if (value) next.color = value; else delete next.color;
      if (Object.keys(next).length) span.style = next; else delete span.style;
    }, { select: [["", "默认"], ["accent", "强调色"], ["muted", "弱化色"], ["warning", "提醒色"]], historyKey: `story:say-rich-span-color:${instruction.id}:${span.id}` });
    richField(row, "字重", style.emphasis ?? "", value => {
      const next = { ...(span.style && typeof span.style === "object" && !Array.isArray(span.style) ? span.style : {}) };
      if (value) next.emphasis = value; else delete next.emphasis;
      if (Object.keys(next).length) span.style = next; else delete span.style;
    }, { select: [["", "常规"], ["strong", "加粗"]], historyKey: `story:say-rich-span-emphasis:${instruction.id}:${span.id}` });
    richField(row, "注音（Ruby）", span.ruby ?? "", value => { if (value) span.ruby = value; else delete span.ruby; }, { historyKey: `story:say-rich-span-ruby:${instruction.id}:${span.id}` });
    if (span.link && typeof span.link === "object" && !Array.isArray(span.link)) {
      richField(row, "内部注释标题", span.link.title ?? "", value => { span.link.title = value; }, { historyKey: `story:say-rich-span-link-title:${instruction.id}:${span.id}` });
      richField(row, "内部注释正文", span.link.text ?? "", value => { span.link.text = value; }, { multiline: true, wide: true, historyKey: `story:say-rich-span-link-text:${instruction.id}:${span.id}` });
      row.append(button("移除内部注释", "quiet", () => {
        mutate( `say:rich:link:remove:${scope}:${index}:${spanIndex}`, () => { delete getInstruction().rich.spans[spanIndex].link; });
        refresh();
      }));
    } else {
      row.append(button("添加内部注释", "quiet", () => {
        mutate( `say:rich:link:add:${scope}:${index}:${spanIndex}`, () => {
          getInstruction().rich.spans[spanIndex].link = { title: "", text: "" };
        });
        refresh();
      }));
    }
    row.append(button("移除范围", "quiet danger", () => {
      mutate( `say:rich:span:remove:${scope}:${index}:${spanIndex}`, () => {
        const target = getInstruction();
        target.rich.spans.splice(spanIndex, 1);
        removeEmptySayRich(target);
      });
      refresh();
    }));
    section.append(row);
  }

  for (const [pauseIndex, pause] of pauses.entries()) {
    const row = node("div", "nv-rich-pause");
    row.dataset.richPauseIndex = String(pauseIndex);
    if (typeof pause?.id === "string") row.dataset.richPauseId = pause.id;
    row.append(node("div", "nv-row-head", `停顿 ${pauseIndex + 1}`));
    if (!pause || typeof pause !== "object" || Array.isArray(pause)) {
      row.append(node("p", "nv-rich-diagnostic error", "此停顿数据无效；移除后可以重新添加。"), button("移除无效停顿", "quiet danger", () => {
        mutate( `say:rich:pause:remove:${scope}:${index}:${pauseIndex}`, () => {
          getInstruction().rich.pauses.splice(pauseIndex, 1);
          removeEmptySayRich(getInstruction());
        });
        refresh();
      }));
      section.append(row);
      continue;
    }
    richField(row, "停顿 ID", pause.id ?? "", value => { pause.id = value; }, { historyKey: `story:say-rich-pause-id:${instruction.id}:${pauseIndex}` });
    const pauseAtField = richField(row, "停顿位置（Unicode 字符）", pause.at, value => { pause.at = value; }, { type: "number", integer: true, safeInteger: true, min: 0, historyKey: `story:say-rich-pause-at:${instruction.id}:${pause.id}` });
    pauseAtField.dataset.richBoundary = "true";
    pauseAtField.max = String(count);
    richField(row, "停顿方式", pause.durationMs === null ? "manual" : "timed", value => {
      pause.durationMs = value === "manual" ? null : pause.durationMs === null ? 500 : pause.durationMs;
      refresh();
    }, { select: [["manual", "手动继续"], ["timed", "定时继续"]], historyKey: `story:say-rich-pause-kind:${instruction.id}:${pause.id}` });
    if (pause.durationMs !== null) {
      richField(row, "停顿时长（毫秒）", pause.durationMs, value => { pause.durationMs = value; }, { type: "number", integer: true, safeInteger: true, min: 1, max: 3_600_000, historyKey: `story:say-rich-pause-duration:${instruction.id}:${pause.id}` });
    }
    row.append(button("移除停顿", "quiet danger", () => {
      mutate( `say:rich:pause:remove:${scope}:${index}:${pauseIndex}`, () => {
        const target = getInstruction();
        target.rich.pauses.splice(pauseIndex, 1);
        removeEmptySayRich(target);
      });
      refresh();
    }));
    section.append(row);
  }

  listen("input", () => {
    const nextCount = Array.from(String(instruction.text ?? "")).length;
    for (const boundary of section.querySelectorAll("[data-rich-boundary]")) boundary.max = String(nextCount);
    refreshRichDiagnostic();
  });
  parent.append(section);
  return () => { for (const dispose of listeners) dispose(); };
}
