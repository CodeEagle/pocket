const STAGE_WIDTH = 360;
const STAGE_HEIGHT = 640;

const element = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = String(text);
  return value;
};

const button = (label, action, className = "") => {
  const value = element("button", `nv-button quiet ${className}`.trim(), label);
  value.type = "button";
  if (action) value.addEventListener("click", action);
  return value;
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const round = value => Math.round(value * 10) / 10;
const roundNormalized = value => Math.round(value * 1000) / 1000;

function resourceUrl(projectId, kind, key, expression) {
  const params = new URLSearchParams({ project: projectId, kind, key });
  if (expression) params.set("expression", expression);
  return `/novel/resource?${params.toString()}`;
}

function sceneAt(story, selection) {
  if (!story || !selection || typeof selection.label !== "string" || !Number.isInteger(selection.index)) return null;
  const instruction = story.script?.[selection.label]?.[selection.index];
  return instruction?.type === "scene" ? instruction : null;
}

function addressMatches(location, label, index) {
  return location?.label === label && location?.index === index;
}

function deriveSceneStage(engineModule, story, selection, instruction) {
  if (!engineModule || typeof engineModule.createNovelEngine !== "function") {
    return { reachable: false, stage: null, message: "Pocket VN 核心尚未加载，无法推演场景上下文。" };
  }
  const labelInstructions = story.script?.[selection.label];
  if (!Array.isArray(labelInstructions)) return { reachable: false, stage: null, message: "所选标签已不存在。" };

  let engine;
  try {
    engine = engineModule.createNovelEngine(story);
    const target = { label: selection.label, index: selection.index };
    const after = { label: selection.label, index: selection.index + 1 };
    const breakpoints = [target];
    if (after.index < labelInstructions.length) breakpoints.push(after);
    engine.debug.setBreakpoints(breakpoints);
    engine.start();

    let snapshot = engine.getSnapshot();
    if (addressMatches(snapshot.location, target.label, target.index) && snapshot.active === null) {
      // The core stops before the selected instruction. Step the real scene
      // instruction once, then the second breakpoint stops before its successor.
      engine.debug.step();
      snapshot = engine.getSnapshot();
    }

    const reachedAfter = after.index < labelInstructions.length
      ? addressMatches(snapshot.location, after.label, after.index)
      : snapshot.location?.label === selection.label && snapshot.location?.index >= labelInstructions.length;
    if (reachedAfter) return { reachable: true, stage: snapshot.stage, message: "由 Pocket VN 核心按故事实际路径推演至该场景之后。" };

    const blocker = snapshot.active?.kind;
    const where = snapshot.active?.location ?? snapshot.location;
    const message = blocker
      ? `核心实际路径在 ${where?.label ?? "?"}:${where?.index ?? "?"} 遇到${blocker === "choice" ? "选择" : blocker === "wait" ? "等待" : "对白/结局"}；只显示此场景自身显式角色和对象。`
      : "核心执行路径未到达该场景；只显示此场景自身显式角色和对象。";
    let isolated;
    try {
      // When story control flow cannot reach this address, execute just this
      // authored scene through the same core. That supplies its real defaults
      // and removal/visibility semantics without implying inherited context.
      isolated = engineModule.createNovelEngine({
        id: story.id,
        version: story.version,
        start: selection.label,
        script: { [selection.label]: [structuredClone(instruction)] },
      });
      isolated.start();
      return { reachable: false, stage: isolated.getSnapshot().stage, message };
    } catch (isolatedError) {
      return { reachable: false, stage: null, message: `${message} 此场景独立推演也失败：${isolatedError instanceof Error ? isolatedError.message : String(isolatedError)}` };
    } finally {
      isolated?.dispose?.();
    }
  } catch (error) {
    return { reachable: false, stage: null, message: `核心无法推演该场景：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    engine?.dispose?.();
  }
}

function placementOf(character, helpers) {
  if (!character || typeof helpers?.resolveNovelCharacterPlacement !== "function") return null;
  return helpers.resolveNovelCharacterPlacement(character);
}

function characterIds(stage, helpers) {
  if (!stage || typeof helpers?.orderedNovelCharacterIds !== "function") return [];
  return helpers.orderedNovelCharacterIds(stage);
}

function cameraPose(stage, helpers) {
  return typeof helpers?.resolveNovelCameraPose === "function"
    ? helpers.resolveNovelCameraPose(stage?.camera)
    : { x: 0, y: 0, scale: 1 };
}

function layerPose(stage, helpers, parallax) {
  return typeof helpers?.resolveNovelBackgroundLayerPose === "function"
    ? helpers.resolveNovelBackgroundLayerPose(stage?.camera, parallax)
    : cameraPose(stage, helpers);
}

function cameraTransform(pose) {
  return `translate(${pose.x}px, ${pose.y}px) scale(${pose.scale})`;
}

export function mount(container, options) {
  let disposed = false;
  let generation = 0;
  let selectedId = "";
  let selectedObjectId = "";
  let current = null;
  let drag = null;
  let renderVersion = 0;
  let modelPreviews = new Map();

  const contextStatus = element("p", "nv-field-help nv-stage-context");
  const frame = element("div", "nv-stage-frame");
  const stage = element("div", "nv-authoring-stage");
  stage.setAttribute("aria-label", "360 × 640 可编辑角色与对象舞台");
  const inspector = element("div", "nv-stage-inspector");
  const selectionList = element("div", "nv-stage-character-list");
  selectionList.setAttribute("aria-label", "舞台角色与对象");
  const controls = element("div", "nv-stage-controls");
  frame.append(stage);
  container.replaceChildren();
  const layout = element("div", "nv-stage-workspace");
  const canvasColumn = element("div", "nv-stage-canvas-column");
  const editColumn = element("div", "nv-stage-edit-column");
  const header = element("div", "nv-stage-heading");
  header.append(element("h2", "", "可编辑舞台"), element("span", "", "360 × 640"));
  editColumn.append(header, contextStatus, selectionList, controls);
  canvasColumn.append(frame);
  layout.append(canvasColumn, editColumn);
  container.append(layout);

  function inputField(labelText, value, limits, onCommit) {
    const label = element("label", "nv-stage-field");
    label.append(element("span", "", labelText));
    const input = element("input", "nv-input");
    input.type = "number";
    input.value = String(value);
    input.min = String(limits.min);
    input.max = String(limits.max);
    input.step = String(limits.step);
    input.addEventListener("change", () => {
      const next = Number(input.value);
      if (!Number.isFinite(next)) {
        input.value = String(value);
        return;
      }
      onCommit(clamp(next, limits.min, limits.max));
    });
    label.append(input);
    return label;
  }

  function assetImage(kind, key, expression, alt) {
    const image = element("img", kind === "background" ? "nv-authoring-background" : "nv-authoring-character-image");
    image.alt = alt;
    image.draggable = false;
    image.src = resourceUrl(options.projectId, kind, key, expression);
    image.addEventListener("error", () => {
      image.hidden = true;
      const issue = element("span", "nv-stage-asset-error", kind === "background" ? `背景资源不可用 · ${key}` : `立绘资源不可用 · ${key}.${expression || "neutral"}`);
      image.parentElement?.append(issue);
    }, { once: true });
    return image;
  }

  function displayedScene(state, selectedInstruction) {
    return state.derived.stage ?? { background: null, characters: Object.create(null) };
  }

  function disposeModelPreview(preview) {
    try { preview?.handle?.dispose(); } catch {}
    if (preview?.canvas) preview.canvas.width = preview.canvas.height = 0;
  }

  function disposeModelPreviews() {
    for (const preview of modelPreviews.values()) disposeModelPreview(preview);
    modelPreviews.clear();
  }

  function getEditableCharacter(id) {
    const instruction = current?.instruction;
    if (!instruction || !id) return null;
    const existing = (instruction.characters ?? []).find(character => character?.id === id);
    if (existing) return existing;
    return current?.stage?.characters?.[id] ?? null;
  }

  function writeCharacter(id, key, patch) {
    const state = current;
    const instruction = state?.instruction;
    if (!instruction || !id) return;
    const source = getEditableCharacter(id);
    if (!source) return;
    const historyKey = `scene:character:${key}:${state.selection.label}:${state.selection.index}:${id}`;
    try {
      options.commitScene(historyKey, () => {
        const characters = [...(instruction.characters ?? [])];
        let target = characters.find(character => character?.id === id);
        if (!target) {
          target = structuredClone(source);
          characters.push(target);
          instruction.characters = characters;
        }
        Object.assign(target, patch);
      });
      render();
    } catch (error) {
      contextStatus.textContent = `无法保存角色编辑：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function writeSceneObject(id, key, patch) {
    const state = current;
    const instruction = state?.instruction;
    const source = (state?.stage?.objects ?? []).find(object => object?.id === id);
    if (!instruction || !source || !id) return;
    const historyKey = `scene:object:${key}:${state.selection.label}:${state.selection.index}:${id}`;
    try {
      options.commitScene(historyKey, () => {
        const objects = Array.isArray(instruction.objects)
          ? structuredClone(instruction.objects)
          : structuredClone(state.stage.objects ?? []);
        const target = objects.find(object => object?.id === id);
        if (!target) return;
        Object.assign(target, patch);
        instruction.objects = objects;
      });
      render();
    } catch (error) {
      contextStatus.textContent = `无法保存对象编辑：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function objectGeometry(object) {
    if (typeof current?.helpers?.resolveNovelSceneObjectGeometry !== "function") return null;
    return current.helpers.resolveNovelSceneObjectGeometry(object, STAGE_WIDTH, STAGE_HEIGHT);
  }

  function stageItems(stage, helpers) {
    if (typeof helpers?.orderedNovelStageItems === "function") return helpers.orderedNovelStageItems(stage);
    return [
      ...Object.keys(stage?.characters ?? {}).filter(id => stage.characters[id]?.visible !== false).map(id => ({ kind: "character", id })),
      ...(stage?.objects ?? []).map(object => ({ kind: "object", id: object.id })),
    ];
  }

  function itemDown(event) {
    const item = event.currentTarget;
    const id = item.dataset.stageItemId;
    const kind = item.dataset.stageItemKind;
    if (!id || !current || (kind !== "character" && kind !== "object")) return;
    event.preventDefault();
    if (kind === "character") { selectedId = id; selectedObjectId = ""; }
    else { selectedId = ""; selectedObjectId = id; }
    const source = kind === "character" ? current.stage.characters[id] : (current.stage.objects ?? []).find(object => object.id === id);
    const placement = kind === "character" ? placementOf(source, current.helpers) : objectGeometry(source)?.frame;
    if (!placement) return;
    const rect = stage.getBoundingClientRect();
    drag = {
      kind,
      id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: placement.x,
      startY: placement.y,
      boxStartX: kind === "object" ? source.frame.x * STAGE_WIDTH : placement.x,
      boxStartY: kind === "object" ? source.frame.y * STAGE_HEIGHT : placement.y,
      rect,
      cameraScale: cameraPose(current.stage, current.helpers).scale,
      moved: false,
    };
    item.setPointerCapture?.(event.pointerId);
    item.classList.add("is-dragging");
  }

  function itemMove(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startClientX) * STAGE_WIDTH / drag.rect.width / drag.cameraScale;
    const dy = (event.clientY - drag.startClientY) * STAGE_HEIGHT / drag.rect.height / drag.cameraScale;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    const x = round(drag.startX + dx);
    const y = round(drag.startY + dy);
    const item = stage.querySelector(`[data-stage-item-kind="${drag.kind}"][data-stage-item-id="${CSS.escape(drag.id)}"]`);
    if (item) {
      item.style.left = `${x / STAGE_WIDTH * 100}%`;
      item.style.top = `${y / STAGE_HEIGHT * 100}%`;
    }
  }

  function itemUp(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const activeDrag = drag;
    drag = null;
    const item = stage.querySelector(`[data-stage-item-kind="${activeDrag.kind}"][data-stage-item-id="${CSS.escape(activeDrag.id)}"]`);
    item?.classList.remove("is-dragging");
    if (!activeDrag.moved) {
      renderControls();
      return;
    }
    const dx = (event.clientX - activeDrag.startClientX) * STAGE_WIDTH / activeDrag.rect.width / activeDrag.cameraScale;
    const dy = (event.clientY - activeDrag.startClientY) * STAGE_HEIGHT / activeDrag.rect.height / activeDrag.cameraScale;
    if (activeDrag.kind === "character") {
      writeCharacter(activeDrag.id, "position", { position: { x: round(activeDrag.startX + dx), y: round(activeDrag.startY + dy) } });
    } else {
      const object = (current?.stage.objects ?? []).find(value => value.id === activeDrag.id);
      if (!object) return;
      const frame = object.frame;
      writeSceneObject(activeDrag.id, "frame", {
        frame: {
          ...frame,
          x: clamp(roundNormalized((activeDrag.boxStartX + dx) / STAGE_WIDTH), 0, 1 - frame.w),
          y: clamp(roundNormalized((activeDrag.boxStartY + dy) / STAGE_HEIGHT), 0, 1 - frame.h),
        },
      });
    }
  }

  function renderControls() {
    selectionList.replaceChildren();
    controls.replaceChildren();
    if (!current) return;
    const ids = characterIds(current.stage, current.helpers);
    for (const id of ids) {
      const buttonValue = button(id, () => { selectedId = id; renderControls(); renderStageItems(); }, selectedId === id ? "is-active" : "");
      buttonValue.setAttribute("aria-pressed", String(selectedId === id));
      buttonValue.dataset.characterChoice = id;
      selectionList.append(buttonValue);
    }
    const objects = current.stage.objects ?? [];
    for (const object of objects) {
      const buttonValue = button(object.id, () => { selectedId = ""; selectedObjectId = object.id; renderControls(); renderStageItems(); }, selectedObjectId === object.id ? "is-active" : "");
      buttonValue.setAttribute("aria-pressed", String(selectedObjectId === object.id));
      buttonValue.dataset.sceneObjectChoice = object.id;
      selectionList.append(buttonValue);
    }

    const object = objects.find(value => value.id === selectedObjectId);
    if (object) {
      const geometry = objectGeometry(object);
      const inspectorPanel = element("div", "nv-stage-inspector");
      inspectorPanel.dataset.sceneObjectInspector = "";
      inspectorPanel.append(element("strong", "nv-stage-item-title", `对象 · ${object.id}`));
      const authoredHere = Array.isArray(current.instruction.objects) && current.instruction.objects.some(value => value?.id === object.id);
      const source = element("p", "nv-field-help nv-stage-object-source", authoredHere
        ? `当前来源已确认：${current.selection.label}:${current.selection.index} · scene.objects`
        : "该对象由前文场景继承；当前编辑器没有确认其原始配置位置。编辑时会在本场景显式保存完整对象集。");
      if (authoredHere) source.dataset.sourceLocation = `${current.selection.label}:${current.selection.index}`;
      inspectorPanel.append(source);

      const imageLabel = element("label", "nv-stage-field");
      imageLabel.append(element("span", "", "图片键"));
      const imageSelect = element("select", "nv-input");
      const imageKeys = Object.keys(current.assets?.backgrounds ?? {}).sort();
      if (object.image && !imageKeys.includes(object.image)) imageKeys.unshift(object.image);
      for (const key of imageKeys) {
        const option = element("option", "", current.assets?.backgrounds?.[key] ? key : `缺失：${key}`);
        option.value = key;
        imageSelect.append(option);
      }
      imageSelect.value = object.image;
      imageSelect.addEventListener("change", () => writeSceneObject(object.id, "image", { image: imageSelect.value }));
      imageLabel.append(imageSelect);
      inspectorPanel.append(imageLabel);
      if (geometry) {
        inspectorPanel.append(
          inputField("X (0–1)", object.frame.x, { min: 0, max: 1 - object.frame.w, step: 0.005 }, value => writeSceneObject(object.id, "frame", { frame: { ...object.frame, x: roundNormalized(value) } })),
          inputField("Y (0–1)", object.frame.y, { min: 0, max: 1 - object.frame.h, step: 0.005 }, value => writeSceneObject(object.id, "frame", { frame: { ...object.frame, y: roundNormalized(value) } })),
        );
      }
      const layerLimits = current.helpers?.NOVEL_SCENE_OBJECT_LIMITS ?? { minLayer: -1024, maxLayer: 1024 };
      inspectorPanel.append(inputField("图层", object.layer ?? 0, { min: layerLimits.minLayer, max: layerLimits.maxLayer, step: 1 }, value => writeSceneObject(object.id, "layer", { layer: Math.trunc(value) })));
      inspectorPanel.append(element("p", "nv-field-help", `裁剪：${object.crop ? `${object.crop.x}, ${object.crop.y}, ${object.crop.w}, ${object.crop.h}` : "完整图片"} · 命中区：${object.interaction?.hit ? `${object.interaction.hit.x}, ${object.interaction.hit.y}, ${object.interaction.hit.w}, ${object.interaction.hit.h}` : object.interaction ? "整个对象框" : "未配置交互"}`));
      inspectorPanel.append(button("移除此对象", () => {
        const existing = Array.isArray(current.instruction.objects)
          ? structuredClone(current.instruction.objects)
          : structuredClone(current.stage.objects ?? []);
        options.commitScene(`scene:object:remove:${current.selection.label}:${current.selection.index}:${object.id}`, () => {
          current.instruction.objects = existing.filter(value => value?.id !== object.id);
        });
        selectedObjectId = "";
        render();
      }, "danger quiet"));
      controls.append(inspectorPanel);
    }

    const backgroundKeys = Object.keys(current.assets?.backgrounds ?? {}).sort();
    const addObject = button("＋ 添加自由对象", () => {
      if (!backgroundKeys.length) return;
      const objectLimit = current.helpers?.NOVEL_SCENE_OBJECT_LIMITS?.maxObjects ?? 32;
      if (objects.length >= objectLimit) return;
      let suffix = objects.length + 1;
      let id = `scene_object_${suffix}`;
      while (objects.some(value => value?.id === id)) id = `scene_object_${++suffix}`;
      const inherited = structuredClone(objects);
      options.commitScene(`scene:object:add:${current.selection.label}:${current.selection.index}:${id}`, () => {
        const existing = Array.isArray(current.instruction.objects)
          ? structuredClone(current.instruction.objects)
          : inherited;
        current.instruction.objects = [...existing, {
          id,
          image: backgroundKeys[0],
          frame: { x: 0.375, y: 0.375, w: 0.25, h: 0.25 },
          layer: 1,
        }];
      });
      selectedId = "";
      selectedObjectId = id;
      render();
    });
    addObject.id = "novel-scene-object-add";
    addObject.disabled = !backgroundKeys.length || objects.length >= (current.helpers?.NOVEL_SCENE_OBJECT_LIMITS?.maxObjects ?? 32);
    if (!backgroundKeys.length) addObject.title = "请先登记一张背景图片作为对象素材。";
    else if (addObject.disabled) addObject.title = "当前场景最多可显示 32 个对象。";
    controls.append(addObject);

    const character = getEditableCharacter(selectedId);
    const placement = placementOf(character, current.helpers);
    if (!character || !placement) {
      controls.append(element("p", "nv-field-help", ids.length ? "选择一个角色以编辑位置、缩放、旋转和层级。" : objects.length ? "选择一个对象以编辑图片、位置和层级；在剧本的对象 JSON 中设置裁剪与命中区。" : "此场景尚无角色或对象；可以先添加自由对象，或在剧本中添加角色。"));
      return;
    }

    const limits = current.helpers.NOVEL_CHARACTER_TRANSFORM_LIMITS;
    if (!limits) {
      controls.append(element("p", "nv-runtime-error", "当前核心未导出角色变换约束，无法安全编辑缩放、旋转与层级。"));
      return;
    }
    const transformFields = element("div", "nv-stage-transform-fields");
    transformFields.append(
      inputField("X", placement.x, { min: -STAGE_WIDTH, max: STAGE_WIDTH * 2, step: 1 }, value => writeCharacter(selectedId, "position", { position: { x: value, y: placement.y } })),
      inputField("Y", placement.y, { min: -STAGE_HEIGHT, max: STAGE_HEIGHT * 2, step: 1 }, value => writeCharacter(selectedId, "position", { position: { x: placement.x, y: value } })),
      inputField("均匀缩放", placement.scale, { min: limits.scale.min, max: limits.scale.max, step: 0.05 }, value => writeCharacter(selectedId, "scale", { scale: value })),
      inputField("旋转 °", placement.rotation, { min: limits.rotation.min, max: limits.rotation.max, step: 1 }, value => writeCharacter(selectedId, "rotation", { rotation: value })),
      inputField("层级", placement.layer, { min: limits.layer.min, max: limits.layer.max, step: 1 }, value => writeCharacter(selectedId, "layer", { layer: Math.trunc(value) })),
    );
    controls.append(transformFields);

    const layers = ids.filter(id => id !== selectedId).map(id => placementOf(current.stage.characters[id], current.helpers)?.layer).filter(Number.isFinite);
    const ownLayer = placement.layer;
    const frontLayer = Math.max(limits.layer.min, ...layers) + 1;
    const backLayer = Math.min(limits.layer.max, ...layers) - 1;
    const order = element("div", "nv-stage-order-controls");
    const front = button("置于最前", () => writeCharacter(selectedId, "layer", { layer: clamp(frontLayer, limits.layer.min, limits.layer.max) }));
    const back = button("置于最后", () => writeCharacter(selectedId, "layer", { layer: clamp(backLayer, limits.layer.min, limits.layer.max) }));
    front.disabled = ownLayer >= limits.layer.max || layers.every(layer => layer < ownLayer);
    back.disabled = ownLayer <= limits.layer.min || layers.every(layer => layer > ownLayer);
    order.append(back, front);
    controls.append(order);
    if (character.model?.key) {
      const definition = current.assets?.models?.[character.model.key];
      if (definition?.kind === "live2d") controls.append(element("p", "nv-field-help", "舞台实时预览仅支持官方 Spine；Live2D 需要原生 Guest host，请在真实试玩中核对姿态。"));
      else if (!definition) controls.append(element("p", "nv-stage-asset-error", `未登记动态模型资源 · ${character.model.key}`));
      else controls.append(element("p", "nv-field-help", "舞台使用官方 Spine 运行库预览该场景的真实网格与动作。"));
    }
  }

  function renderStageItems() {
    const state = current;
    const previousPreviews = modelPreviews;
    const nextPreviews = new Map();
    const previewsToStart = [];
    stage.replaceChildren();
    stage.classList.toggle("is-context-unavailable", !state?.derived.reachable);
    if (!state) return;
    const fullPose = cameraPose(state.stage, state.helpers);
    const backgroundKey = state.stage.background;
    if (backgroundKey && state.assets?.backgrounds?.[backgroundKey]) {
      const base = assetImage("background", backgroundKey, undefined, `背景：${backgroundKey}`);
      base.style.transform = cameraTransform(fullPose);
      base.style.transformOrigin = "0 0";
      base.dataset.backgroundRole = "base";
      stage.append(base);
    } else if (!state.derived.reachable && !Object.hasOwn(state.instruction, "background")) {
      stage.append(element("div", "nv-stage-context-overlay", "前文背景未知"));
    } else if (!backgroundKey) {
      stage.append(element("div", "nv-stage-context-overlay", state.instruction.background === null ? "已清空背景" : "背景未设置"));
    } else {
      stage.append(element("div", "nv-stage-context-overlay", `缺少已登记背景 · ${backgroundKey}`));
    }

    for (const [layerIndex, layer] of (state.stage.backgroundLayers ?? []).entries()) {
      const path = state.assets?.backgrounds?.[layer.background];
      if (!path) continue;
      const image = assetImage("background", layer.background, undefined, `背景叠加层 ${layerIndex + 1}：${layer.background}`);
      const pose = layerPose(state.stage, state.helpers, layer.parallax);
      image.classList.add("nv-authoring-background-layer");
      image.style.zIndex = String(layerIndex + 1);
      image.style.transform = cameraTransform(pose);
      image.style.transformOrigin = "0 0";
      image.dataset.backgroundRole = "layer";
      image.dataset.layerIndex = String(layerIndex);
      image.dataset.background = layer.background;
      image.dataset.parallax = String(layer.parallax);
      stage.append(image);
    }

    const ids = characterIds(state.stage, state.helpers);
    const objects = state.stage.objects ?? [];
    if (!objects.some(object => object?.id === selectedObjectId)) selectedObjectId = "";
    if (selectedObjectId) selectedId = "";
    const cast = element("div", "nv-authoring-cast");
    cast.style.transform = cameraTransform(fullPose);
    cast.style.transformOrigin = "0 0";
    cast.dataset.cameraX = String(fullPose.x);
    cast.dataset.cameraY = String(fullPose.y);
    cast.dataset.cameraScale = String(fullPose.scale);
    for (const orderedItem of stageItems(state.stage, state.helpers)) {
      if (orderedItem.kind === "object") {
        const object = objects.find(value => value?.id === orderedItem.id);
        const geometry = object && objectGeometry(object);
        if (!object || !geometry) continue;
        const frameRect = geometry.frame;
        const item = element("div", `nv-authoring-scene-object ${selectedObjectId === object.id ? "is-selected" : ""}`);
        item.dataset.sceneObjectId = object.id;
        item.dataset.frame = JSON.stringify(object.frame);
        item.dataset.crop = JSON.stringify(object.crop ?? null);
        item.dataset.hit = JSON.stringify(object.interaction?.hit ?? { x: 0, y: 0, w: 1, h: 1 });
        item.dataset.image = object.image;
        item.dataset.layer = String(object.layer ?? 0);
        item.dataset.stageItemKind = "object";
        item.dataset.stageItemId = object.id;
        item.style.left = `${frameRect.x / STAGE_WIDTH * 100}%`;
        item.style.top = `${frameRect.y / STAGE_HEIGHT * 100}%`;
        item.style.width = `${frameRect.width / STAGE_WIDTH * 100}%`;
        item.style.height = `${frameRect.height / STAGE_HEIGHT * 100}%`;
        item.style.zIndex = String(object.layer ?? 0);
        item.setAttribute("role", "button");
        item.setAttribute("aria-label", `拖动场景对象 ${object.id}`);
        item.setAttribute("aria-pressed", String(selectedObjectId === object.id));
        const imagePath = state.assets?.backgrounds?.[object.image];
        if (imagePath) {
          const image = assetImage("background", object.image, undefined, `场景对象 ${object.id} · ${object.image}`);
          image.classList.add("nv-authoring-scene-object-image");
          image.style.left = `${geometry.image.x / frameRect.width * 100}%`;
          image.style.top = `${geometry.image.y / frameRect.height * 100}%`;
          image.style.width = `${geometry.image.width / frameRect.width * 100}%`;
          image.style.height = `${geometry.image.height / frameRect.height * 100}%`;
          image.style.right = "auto";
          image.style.bottom = "auto";
          item.append(image);
        } else item.append(element("span", "nv-stage-missing-character", `缺少已登记背景图片 · ${object.image}`));
        if (object.interaction) {
          const hit = element("span", "nv-authoring-scene-object-hit", object.interaction.label);
          hit.style.left = `${geometry.hit.x / frameRect.width * 100}%`;
          hit.style.top = `${geometry.hit.y / frameRect.height * 100}%`;
          hit.style.width = `${geometry.hit.width / frameRect.width * 100}%`;
          hit.style.height = `${geometry.hit.height / frameRect.height * 100}%`;
          hit.dataset.hit = `${object.interaction.hit?.x ?? 0},${object.interaction.hit?.y ?? 0},${object.interaction.hit?.w ?? 1},${object.interaction.hit?.h ?? 1}`;
          item.append(hit);
        }
        item.append(element("span", "nv-authoring-scene-object-label", object.id));
        if (Array.isArray(state.instruction.objects) && state.instruction.objects.some(value => value?.id === object.id)) {
          item.dataset.sourceLocation = `${state.selection.label}:${state.selection.index}`;
          item.dataset.sourceField = "objects";
        } else item.dataset.sourceLocation = "";
        item.addEventListener("pointerdown", itemDown);
        item.addEventListener("pointermove", itemMove);
        item.addEventListener("pointerup", itemUp);
        item.addEventListener("pointercancel", itemUp);
        item.addEventListener("click", () => { selectedId = ""; selectedObjectId = object.id; renderControls(); renderStageItems(); });
        cast.append(item);
        continue;
      }
      const id = orderedItem.id;
      const character = state.stage.characters[id];
      if (!character || character.visible === false) continue;
      const placement = placementOf(character, state.helpers);
      if (!placement) continue;
      const item = element("div", `nv-authoring-character ${selectedId === id ? "is-selected" : ""}`);
      item.dataset.characterId = id;
      item.dataset.stageItemKind = "character";
      item.dataset.stageItemId = id;
      item.style.left = `${placement.x / STAGE_WIDTH * 100}%`;
      item.style.top = `${placement.y / STAGE_HEIGHT * 100}%`;
      item.style.width = `${placement.width / STAGE_WIDTH * 100}%`;
      item.style.height = `${placement.height / STAGE_HEIGHT * 100}%`;
      item.style.zIndex = String(placement.layer);
      item.style.transform = `rotate(${placement.rotation}deg) scale(${placement.scale})`;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", `拖动角色 ${id}`);
      item.setAttribute("aria-pressed", String(selectedId === id));
      const variants = state.assets?.characters?.[id];
      const expression = character.expression ?? "neutral";
      const imageKey = variants?.[expression] ? expression : variants?.neutral ? "neutral" : "";
      if (character.model?.key) {
        const modelKey = character.model.key;
        const definition = state.assets?.models?.[modelKey];
        if (definition?.kind === "spine") {
          const signature = JSON.stringify({ model: character.model, definition });
          let preview = previousPreviews.get(id);
          if (preview && preview.signature !== signature) {
            disposeModelPreview(preview);
            preview = null;
          }
          if (!preview) {
            const canvas = element("canvas", "nv-authoring-model-canvas");
            canvas.width = 480;
            canvas.height = 700;
            canvas.setAttribute("aria-hidden", "true");
            const status = element("span", "nv-authoring-model-status", "正在加载官方 Spine 预览…");
            preview = { signature, canvas, status, handle: null };
            previewsToStart.push({ id, character, preview });
          }
          preview.canvas.dataset.modelPreviewCharacter = id;
          nextPreviews.set(id, preview);
          item.append(preview.canvas, preview.status);
        } else if (definition?.kind === "live2d") {
          item.append(element("span", "nv-stage-missing-character", `Live2D 需要原生 Guest host · ${id}`));
        } else {
          item.append(element("span", "nv-stage-missing-character", `未登记动态模型资源 · ${modelKey}`));
        }
      }
      else if (imageKey) item.append(assetImage("character", id, imageKey, `${id} · ${expression}`));
      else item.append(element("span", "nv-stage-missing-character", `缺少已登记立绘 · ${id}.${expression}`));
      item.append(element("span", "nv-authoring-character-label", id));
      item.addEventListener("pointerdown", itemDown);
      item.addEventListener("pointermove", itemMove);
      item.addEventListener("pointerup", itemUp);
      item.addEventListener("pointercancel", itemUp);
      item.addEventListener("click", () => { selectedObjectId = ""; selectedId = id; renderControls(); renderStageItems(); });
      cast.append(item);
    }
    stage.append(cast);
    for (const [id, previous] of previousPreviews) {
      if (nextPreviews.get(id) !== previous) disposeModelPreview(previous);
    }
    modelPreviews = nextPreviews;
    for (const { id, character, preview } of previewsToStart) {
      if (typeof options.createSpinePreview !== "function") {
        preview.status.textContent = "Pocket Spine 预览未连接。";
        continue;
      }
      const isCurrentPreview = () => !disposed && modelPreviews.get(id) === preview && preview.canvas.isConnected;
      preview.handle = options.createSpinePreview({
        canvas: preview.canvas,
        character,
        onFrame: ({ frameCount, meshCount }) => {
          if (!isCurrentPreview()) return;
          const firstFrame = preview.canvas.dataset.frameCount === undefined;
          preview.canvas.dataset.frameCount = String(frameCount);
          preview.canvas.dataset.meshCount = String(meshCount);
          if (firstFrame) {
            preview.status.textContent = "Spine 动画预览中";
            preview.status.dataset.kind = "success";
          }
        },
        onError: error => {
          if (!isCurrentPreview()) return;
          preview.status.textContent = `Spine 预览失败：${error.message}`;
          preview.status.dataset.kind = "error";
        },
      });
      void preview.handle.start();
    }
  }

  async function render() {
    if (disposed) return;
    const ticket = ++generation;
    const story = options.getStory?.();
    const assets = options.getAssets?.() ?? {};
    const selection = options.getSelection?.();
    const instruction = sceneAt(story, selection);
    if (!instruction) {
      disposeModelPreviews();
      current = null;
      contextStatus.textContent = "选择一个 scene 指令后，可预览并拖动其中的角色与场景对象。";
      selectionList.replaceChildren();
      controls.replaceChildren();
      stage.replaceChildren(element("div", "nv-stage-context-overlay", "请选择一个场景指令"));
      return;
    }

    const helpers = await Promise.resolve(options.getEngineModule?.());
    if (disposed || ticket !== generation) return;
    const derived = deriveSceneStage(helpers, story, selection, instruction);
    const state = { story, assets, selection, instruction, helpers, derived, stage: null };
    state.stage = displayedScene(state, instruction);
    current = state;

    const ids = characterIds(state.stage, helpers);
    if (!(state.stage.objects ?? []).some(object => object?.id === selectedObjectId)) selectedObjectId = "";
    if (selectedObjectId) selectedId = "";
    else if (!ids.includes(selectedId)) selectedId = ids[0] ?? instruction.characters?.[0]?.id ?? "";
    contextStatus.textContent = derived.message;
    renderStageItems();
    renderControls();
  }

  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    const width = frame.clientWidth;
    frame.style.setProperty("--nv-stage-factor", String(width / STAGE_WIDTH));
  }) : null;
  resizeObserver?.observe(frame);
  frame.style.setProperty("--nv-stage-factor", String(frame.clientWidth / STAGE_WIDTH || 1));

  const unsubscribe = options.subscribe?.(() => { void render(); });
  void render();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      drag = null;
      disposeModelPreviews();
      resizeObserver?.disconnect();
      if (typeof unsubscribe === "function") unsubscribe();
      container.replaceChildren();
    },
  };
}
