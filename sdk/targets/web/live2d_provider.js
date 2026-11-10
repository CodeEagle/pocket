(function exposeLive2dProvider(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PocketLive2dProvider = factory();
})(globalThis, function createLive2dProviderModule() {
  "use strict";

  const LOAD = "media.live2d.model.load";
  const UPDATE = "media.live2d.model.update";
  const RELEASE = "media.live2d.model.release";
  const PMS1_MAGIC = 0x31534d50;
  const MAX_MODELS = 4;
  const MAX_MOC_BYTES = 32 * 1024 * 1024;
  const MAX_PROVIDER_BYTES = 128 * 1024 * 1024;
  const MAX_TEXTURES = 16;
  const MAX_IDENTIFIER_LENGTH = 64;
  const MAX_VERTICES = 16_384;
  const MAX_INDICES = 98_304;
  const MAX_FRAME_BYTES = 3 * 1024 * 1024;

  function error(code, message, cause) {
    const value = new Error(message, cause === undefined ? undefined : { cause });
    value.code = code;
    return value;
  }

  function ensureRecord(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw error("invalid_request", `${name} must be an object`);
    }
    return value;
  }

  function identifier(value, name) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
      throw error("invalid_request", `${name} must be a short non-empty identifier`);
    }
    return value;
  }

  function assetKey(value, name) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256 ||
        !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("/") || value.includes("://") ||
        value.split("/").some(part => part.length === 0 || part === "." || part === "..")) {
      throw error("invalid_request", `${name} must be a safe relative asset key`);
    }
    return value;
  }

  function arrayLike(value, name, expectedLength) {
    if (value === null || value === undefined || !Number.isSafeInteger(value.length) || value.length < 0 ||
        (expectedLength !== undefined && value.length !== expectedLength)) {
      throw error("live2d_core_invalid", `Cubism Core returned an invalid ${name} array`);
    }
    return value;
  }

  function finite(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw error("live2d_core_invalid", `Cubism Core returned a non-finite ${name}`);
    }
    return value;
  }

  function integer(value, name, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw error("live2d_core_invalid", `Cubism Core returned an invalid ${name}`);
    }
    return value;
  }

  function isUint8Array(value) {
    return value !== null && typeof value === "object" &&
      Object.prototype.toString.call(value) === "[object Uint8Array]";
  }

  function bytesFromAsset(value, key) {
    if (!isUint8Array(value)) throw error("live2d_asset_invalid", `Asset "${key}" must resolve to Uint8Array bytes`);
    if (value.byteLength === 0) throw error("live2d_asset_empty", `Asset "${key}" is empty`);
    if (value.byteLength > MAX_MOC_BYTES) throw error("live2d_resource_limit", "MOC3 asset exceeds the 32 MiB model input limit");
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(value);
    return bytes;
  }

  function checkSignal(signal) {
    if (signal?.aborted) throw error("cancelled", "Live2D request was cancelled");
  }

  function visibleBufferBytes(mocBytes, model) {
    const parameters = model.parameters;
    const parts = model.parts;
    const drawables = model.drawables;
    let bytes = mocBytes.byteLength;
    const addView = value => {
      if (value && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0) bytes += value.byteLength;
    };
    for (const value of [parameters.minimumValues, parameters.maximumValues, parameters.defaultValues,
      parameters.values, parameters.types, parts.opacities, parts.parentIndices,
      drawables.constantFlags, drawables.dynamicFlags, drawables.textureIndices, drawables.drawOrders,
      drawables.renderOrders, drawables.opacities, drawables.maskCounts, drawables.vertexCounts,
      drawables.indexCounts, drawables.multiplyColors, drawables.screenColors, drawables.parentPartIndices]) {
      addView(value);
    }
    const drawableCount = integer(drawables.count, "drawable count");
    for (let index = 0; index < drawableCount; index++) {
      addView(drawables.masks[index]);
      addView(drawables.vertexPositions[index]);
      addView(drawables.vertexUvs[index]);
      addView(drawables.indices[index]);
    }
    // Core Web does not expose its per-model WebAssembly allocation size.
    // Report only the input MOC and the typed-array bytes observable through
    // the official Core object; this is not a total heap estimate.
    return bytes;
  }

  function floatBytes(values, name) {
    arrayLike(values, name);
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < values.length; index++) {
      view.setFloat32(index * 4, finite(values[index], `${name}[${index}]`), true);
    }
    return bytes;
  }

  function uint32Bytes(values, name) {
    arrayLike(values, name);
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < values.length; index++) {
      const value = integer(values[index], `${name}[${index}]`);
      view.setUint32(index * 4, value, true);
    }
    return bytes;
  }

  function responseIdentifier(value) {
    return identifier(value, "Core identifier");
  }

  function createLive2dProvider(options) {
    const settings = ensureRecord(options, "options");
    if (typeof settings.core !== "function") throw new TypeError("createLive2dProvider requires core() to load an official Cubism Web Core");
    if (typeof settings.readAsset !== "function") throw new TypeError("createLive2dProvider requires a packaged readAsset(key, signal) resolver");

    const maxModels = settings.maxModels ?? MAX_MODELS;
    const maxMocBytes = settings.maxMocBytes ?? MAX_MOC_BYTES;
    const maxProviderBytes = settings.maxProviderBytes ?? MAX_PROVIDER_BYTES;
    const maxTextures = settings.maxTextures ?? MAX_TEXTURES;
    if (!Number.isSafeInteger(maxModels) || maxModels < 1 || maxModels > MAX_MODELS ||
        !Number.isSafeInteger(maxMocBytes) || maxMocBytes < 1 || maxMocBytes > MAX_MOC_BYTES ||
        !Number.isSafeInteger(maxProviderBytes) || maxProviderBytes < 1 || maxProviderBytes > MAX_PROVIDER_BYTES ||
        !Number.isSafeInteger(maxTextures) || maxTextures < 1 || maxTextures > MAX_TEXTURES) {
      throw new RangeError("Live2D Web limits may not exceed the native provider limits");
    }

    const models = new Map();
    const pendingLoads = new Set();
    let pendingLoadCount = 0;
    let totalBytes = 0;
    let nextModelId = 0;
    let corePromise;
    let disposed = false;

    async function getCore() {
      if (!corePromise) {
        corePromise = Promise.resolve().then(() => settings.core()).then(core => {
          if (!core?.Moc?.fromArrayBuffer || !core?.Model?.fromMoc ||
              typeof core?.Version?.csmGetVersion !== "function" ||
              typeof core?.Version?.csmGetMocVersion !== "function" || core.Version.csmGetVersion() <= 0) {
            throw error("live2d_core_unavailable", "The supplied Cubism Web Core is missing required model APIs");
          }
          return core;
        }).catch(cause => {
          corePromise = undefined;
          throw cause?.code ? cause : error("live2d_core_unavailable", "Could not initialize Cubism Web Core", cause);
        });
      }
      return corePromise;
    }

    function validateValues(value, name, { opacity = false } = {}) {
      if (!Array.isArray(value)) throw error("invalid_request", `${name} must be an array`);
      const seen = new Set();
      return value.map((entry, index) => {
        const item = ensureRecord(entry, `${name}[${index}]`);
        const id = identifier(item.id, `${name}[${index}].id`);
        const number = finite(item.value, `${name}.${id} value`);
        if (opacity && (number < 0 || number > 1)) throw error("invalid_request", `${name}.${id} must be between zero and one`);
        if (seen.has(id)) throw error("invalid_request", `${name} contains duplicate id "${id}"`);
        seen.add(id);
        return { id, value: number };
      });
    }

    function validatePlacement(value) {
      if (value === undefined || value === null) return { dx: 0, dy: 0, scale: 1, opacity: 1 };
      const placement = ensureRecord(value, "placement");
      const dx = finite(placement.dx, "placement.dx");
      const dy = finite(placement.dy, "placement.dy");
      const scale = finite(placement.scale, "placement.scale");
      const opacity = placement.opacity === undefined ? 1 : finite(placement.opacity, "placement.opacity");
      if (scale <= 0) throw error("invalid_request", "placement.scale must be positive");
      return { dx, dy, scale, opacity: Math.max(0, Math.min(1, opacity)) };
    }

    function queue(slot, operation) {
      const previous = slot.tail || Promise.resolve();
      const next = previous.catch(() => {}).then(operation);
      slot.tail = next;
      next.then(
        () => { if (slot.tail === next) slot.tail = undefined; },
        () => { if (slot.tail === next) slot.tail = undefined; },
      );
      return next;
    }

    function destroySlot(slot) {
      if (slot.destroyed) return;
      slot.destroyed = true;
      let failure;
      try { slot.model.release(); } catch (cause) { failure = cause; }
      try { slot.moc._release(); } catch (cause) { failure ??= cause; }
      totalBytes = Math.max(0, totalBytes - slot.bytes);
      if (failure) throw error("live2d_model_release_failed", `Could not release model "${slot.modelId}": ${failure.message || failure}`, failure);
    }

    async function loadModel(rawParams, signal) {
      if (disposed) throw error("live2d_provider_disposed", "Live2D provider is disposed");
      const params = ensureRecord(rawParams, "load params");
      const requestedId = identifier(params.id, "id");
      const mocAsset = assetKey(params.mocAsset, "mocAsset");
      if (!mocAsset.toLowerCase().endsWith(".moc3")) throw error("invalid_request", "mocAsset must name a MOC3 asset");
      if (!Array.isArray(params.textures) || params.textures.length === 0 || params.textures.length > maxTextures) {
        throw error("invalid_request", `textures must contain between 1 and ${maxTextures} packaged asset keys`);
      }
      const textures = params.textures.map((value, index) => assetKey(value, `textures[${index}]`));
      if (models.size + pendingLoadCount >= maxModels) throw error("live2d_model_limit", "Live2D model limit reached");
      pendingLoadCount++;
      let moc;
      let model;
      try {
        checkSignal(signal);
        let loaded;
        try { loaded = await settings.readAsset(mocAsset, signal); }
        catch (cause) {
          if (signal?.aborted || cause?.name === "AbortError" || cause?.code === "cancelled") throw cause;
          throw cause?.code ? cause : error("live2d_asset_load_failed", `Could not load packaged MOC3 asset "${mocAsset}"`, cause);
        }
        checkSignal(signal);
        const mocBytes = bytesFromAsset(loaded, mocAsset);
        if (mocBytes.byteLength > maxMocBytes) throw error("live2d_resource_limit", `MOC3 asset exceeds the ${maxMocBytes}-byte model input limit`);
        const core = await getCore();
        checkSignal(signal);
        // bytesFromAsset owns an exact, offset-zero buffer. Official Core Web's
        // Moc constructor copies that input synchronously into its WASM heap.
        try { moc = core.Moc.fromArrayBuffer(mocBytes.buffer); }
        catch (cause) { throw error("live2d_core_create_failed", `Cubism Core rejected model "${requestedId}": ${cause.message || cause}`, cause); }
        if (!moc) throw error("live2d_core_create_failed", `Cubism Core rejected model "${requestedId}"`);
        const mocVersion = integer(core.Version.csmGetMocVersion(moc, mocBytes), "MOC version");
        if (mocVersion === 0) throw error("live2d_core_create_failed", "Cubism Core returned an unknown MOC version");
        try { model = core.Model.fromMoc(moc); }
        catch (cause) { throw error("live2d_core_create_failed", `Cubism Core could not create model "${requestedId}": ${cause.message || cause}`, cause); }
        if (!model) throw error("live2d_core_create_failed", `Cubism Core could not create model "${requestedId}"`);
        checkSignal(signal);

        const p = model.parameters, part = model.parts, d = model.drawables, canvasInfo = model.canvasinfo;
        if (!p || !part || !d || !canvasInfo) throw error("live2d_core_invalid", "Cubism Core returned incomplete model data");
        const parameterCount = integer(p.count, "parameter count");
        const partCount = integer(part.count, "part count");
        const drawableCount = integer(d.count, "drawable count");
        const parameterIds = arrayLike(p.ids, "parameter IDs", parameterCount);
        const parameterMinimums = arrayLike(p.minimumValues, "parameter minimums", parameterCount);
        const parameterMaximums = arrayLike(p.maximumValues, "parameter maximums", parameterCount);
        const parameterDefaults = arrayLike(p.defaultValues, "parameter defaults", parameterCount);
        const parameterValues = arrayLike(p.values, "parameter values", parameterCount);
        const partIds = arrayLike(part.ids, "part IDs", partCount);
        const partValues = arrayLike(part.opacities, "part opacities", partCount);
        const drawableIds = arrayLike(d.ids, "drawable IDs", drawableCount);
        const textureIndices = arrayLike(d.textureIndices, "drawable texture indices", drawableCount);
        const ids = new Map();
        const partIdIndices = new Map();
        const defaults = new Float32Array(parameterCount);
        const metadata = new Array(parameterCount);
        const partDefaults = new Float32Array(partCount);
        const parts = new Array(partCount);
        for (let index = 0; index < parameterCount; index++) {
          const id = responseIdentifier(parameterIds[index]);
          if (ids.has(id)) throw error("live2d_core_invalid", `Cubism Core returned duplicate parameter id "${id}"`);
          const minimum = finite(parameterMinimums[index], `${id} minimum`);
          const maximum = finite(parameterMaximums[index], `${id} maximum`);
          const value = finite(parameterDefaults[index], `${id} default`);
          if (minimum > maximum || value < minimum || value > maximum) throw error("live2d_core_invalid", `Cubism Core returned invalid parameter bounds for "${id}"`);
          ids.set(id, index); defaults[index] = value;
          metadata[index] = { id, minimum, maximum, defaultValue: value };
        }
        for (let index = 0; index < partCount; index++) {
          const id = responseIdentifier(partIds[index]);
          if (partIdIndices.has(id)) throw error("live2d_core_invalid", `Cubism Core returned duplicate part id "${id}"`);
          const value = finite(partValues[index], `${id} opacity`);
          if (value < 0 || value > 1) throw error("live2d_core_invalid", `Cubism Core returned invalid part opacity for "${id}"`);
          partIdIndices.set(id, index); partDefaults[index] = value;
          parts[index] = { id, defaultOpacity: value };
        }
        const canvas = {
          widthPixels: finite(canvasInfo.CanvasWidth, "canvas width"),
          heightPixels: finite(canvasInfo.CanvasHeight, "canvas height"),
          originXPixels: finite(canvasInfo.CanvasOriginX, "canvas origin x"),
          originYPixels: finite(canvasInfo.CanvasOriginY, "canvas origin y"),
          pixelsPerUnit: finite(canvasInfo.PixelsPerUnit, "canvas pixels per unit"),
        };
        if (canvas.widthPixels <= 0 || canvas.heightPixels <= 0 || canvas.pixelsPerUnit <= 0) throw error("live2d_core_invalid", "Cubism Core returned an invalid model canvas");
        for (let index = 0; index < drawableCount; index++) {
          const textureIndex = integer(textureIndices[index], `drawable ${index} texture index`, -0x7fffffff);
          const indexCount = integer(d.indexCounts[index], `drawable ${index} index count`);
          if (indexCount > 0 && textureIndex >= textures.length) throw error("live2d_texture_not_found", `Core drawable "${drawableIds[index]}" references texture ${textureIndex}, but only ${textures.length} textures were provided`);
        }
        const bytes = visibleBufferBytes(mocBytes, model);
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxProviderBytes || totalBytes + bytes > maxProviderBytes) {
          throw error("live2d_resource_limit", "The MOC input and Core-visible buffers would exceed the 128 MiB Web provider byte budget");
        }
        if (disposed) throw error("live2d_provider_disposed", "Live2D provider was disposed while a model was loading");
        const modelId = `live2d-web-${++nextModelId}`;
        const slot = {
          modelId, requestedId, moc, model, mocBytes, bytes, mocVersion, textures,
          parameterIds: ids, parameterDefaults: defaults, parameterMetadata: metadata,
          partIds: partIdIndices, partDefaults, parts, canvas, drawableCount,
          topology: undefined, tail: undefined, destroyed: false,
        };
        models.set(modelId, slot); totalBytes += bytes;
        // Keep ownership in the slot; the catch cleanup below must not release
        // a successfully admitted model.
        moc = undefined; model = undefined;
        return {
          modelId, drawableCount, mocVersion, nativeBytes: bytes, parameterCount,
          parameterDefaults: metadata.map(({ id, defaultValue }) => ({ id, value: defaultValue })),
          parameterMetadata: metadata, parts, canvas, textures,
          memoryAccounting: "core-visible-buffers",
        };
      } catch (cause) {
        if (model) { try { model.release(); } catch (_) {} }
        if (moc) { try { moc._release(); } catch (_) {} }
        throw cause;
      } finally {
        pendingLoadCount--;
      }
    }

    function makePms1(slot, drawable, index, placement, modelOpacity) {
      const positions = arrayLike(drawable.vertexPositions[index], `drawable ${index} positions`);
      const uvs = arrayLike(drawable.vertexUvs[index], `drawable ${index} UVs`);
      const indices = arrayLike(drawable.indices[index], `drawable ${index} indices`);
      const vertexCount = integer(drawable.vertexCounts[index], `drawable ${index} vertex count`);
      const indexCount = integer(drawable.indexCounts[index], `drawable ${index} index count`);
      if (positions.length !== vertexCount * 2 || uvs.length !== vertexCount * 2 || indices.length !== indexCount) {
        throw error("live2d_topology_changed", `Core drawable ${index} returned inconsistent mesh arrays`);
      }
      if (vertexCount === 0 || indexCount === 0) return new Uint8Array(0);
      if (vertexCount > MAX_VERTICES || indexCount < 3 || indexCount > MAX_INDICES || indexCount % 3 !== 0) {
        throw error("live2d_resource_limit", `Core drawable ${index} exceeds Pocket mesh limits`);
      }
      if (drawable.textureIndices[index] < 0 || drawable.textureIndices[index] >= slot.textures.length) {
        throw error("live2d_texture_not_found", `Core drawable ${index} references an unavailable model texture`);
      }
      const byteLength = 16 + vertexCount * 16 + indexCount * 4;
      const bytes = new Uint8Array(byteLength);
      const view = new DataView(bytes.buffer);
      const opacity = Math.max(0, Math.min(1, finite(drawable.opacities[index], `drawable ${index} opacity`) * modelOpacity));
      const opacityByte = Math.floor(opacity * 255 + 0.5);
      view.setUint32(0, PMS1_MAGIC, true);
      view.setUint32(4, vertexCount, true);
      view.setUint32(8, indexCount, true);
      view.setUint32(12, ((opacityByte << 24) | 0x00ffffff) >>> 0, true);
      const originX = slot.canvas.originXPixels;
      const originY = slot.canvas.originYPixels;
      const pixelsPerUnit = slot.canvas.pixelsPerUnit;
      let offset = 16;
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        const pair = vertex * 2;
        const x = originX + finite(positions[pair], `drawable ${index} x`) * pixelsPerUnit;
        const y = originY - finite(positions[pair + 1], `drawable ${index} y`) * pixelsPerUnit;
        const placedX = placement.dx + x * placement.scale;
        const placedY = placement.dy + y * placement.scale;
        const u = finite(uvs[pair], `drawable ${index} u`);
        const v = 1 - finite(uvs[pair + 1], `drawable ${index} v`);
        if (![placedX, placedY, u, v].every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000)) {
          throw error("live2d_mesh_invalid", `Core drawable ${index} contains out-of-range mesh coordinates`);
        }
        view.setFloat32(offset, placedX, true);
        view.setFloat32(offset + 4, placedY, true);
        view.setFloat32(offset + 8, u, true);
        view.setFloat32(offset + 12, v, true);
        offset += 16;
      }
      for (let item = 0; item < indexCount; item++) {
        const vertexIndex = integer(indices[item], `drawable ${index} index ${item}`);
        if (vertexIndex >= vertexCount) throw error("live2d_mesh_invalid", `Core drawable ${index} has an index outside its vertex range`);
        view.setUint32(offset, vertexIndex, true);
        offset += 4;
      }
      return bytes;
    }

    function makeDrawable(slot, index, placement, cacheTopology) {
      const model = slot.model;
      const d = model.drawables;
      const vertexCount = integer(d.vertexCounts[index], `drawable ${index} vertex count`);
      const indexCount = integer(d.indexCounts[index], `drawable ${index} index count`);
      const maskCount = integer(d.maskCounts[index], `drawable ${index} mask count`);
      const id = responseIdentifier(d.ids[index]);
      const masks = arrayLike(d.masks[index], `drawable ${index} masks`, maskCount);
      const previous = cacheTopology ? slot.topology?.[index] : undefined;
      if (previous && (previous.id !== id || previous.vertexCount !== vertexCount ||
          previous.indexCount !== indexCount || previous.maskCount !== maskCount)) {
        throw error("live2d_topology_changed", "Drawable identity or static topology changed while the model was loaded");
      }
      const meshBytes = makePms1(slot, d, index, placement, placement.opacity);
      const maskIndices = previous ? undefined : uint32Bytes(masks, `drawable ${index} masks`);
      const multiplyColorRgba = floatBytes(d.multiplyColors.subarray(index * 4, index * 4 + 4), `drawable ${index} multiply color`);
      const screenColorRgba = floatBytes(d.screenColors.subarray(index * 4, index * 4 + 4), `drawable ${index} screen color`);
      const blendModes = d.blendModes;
      const constantFlags = integer(d.constantFlags[index], `drawable ${index} constant flags`);
      let blendMode;
      if (blendModes && blendModes.length === slot.drawableCount) {
        blendMode = integer(blendModes[index], `drawable ${index} blend mode`);
        const colorBlend = blendMode & 0xff;
        const alphaBlend = (blendMode >>> 8) & 0xff;
        if (![0, 3, 6, 10].includes(colorBlend) || alphaBlend !== 0 || (blendMode >>> 16) !== 0) {
          throw error("live2d_blend_mode_unsupported", `Core drawable "${id}" uses unsupported Cubism color/alpha blend ${colorBlend}/${alphaBlend}`);
        }
      } else {
        const additive = (constantFlags & 1) !== 0;
        const multiplicative = (constantFlags & 2) !== 0;
        if (additive && multiplicative) throw error("live2d_core_invalid", `Core drawable "${id}" has conflicting legacy blend flags`);
        // Legacy Web Core exposes only the pre-5.3 constant flags. Translate
        // those bits into the compatibility blend values understood by the
        // existing Pocket renderer; do not return the bit masks themselves.
        blendMode = additive ? 3 : multiplicative ? 6 : 0;
      }
      return {
        id,
        textureIndex: integer(d.textureIndices[index], `drawable ${index} texture index`, -0x7fffffff),
        drawOrder: integer(d.drawOrders[index], `drawable ${index} draw order`, -0x7fffffff),
        renderOrder: integer(d.renderOrders[index], `drawable ${index} render order`, -0x7fffffff),
        blendMode,
        constantFlags,
        dynamicFlags: integer(d.dynamicFlags[index], `drawable ${index} dynamic flags`),
        opacity: finite(d.opacities[index], `drawable ${index} opacity`),
        meshBytes,
        ...(previous ? {} : { maskIndices }),
        multiplyColorRgba,
        screenColorRgba,
      };
    }

    async function updateModel(rawParams, signal) {
      if (disposed) throw error("live2d_provider_disposed", "Live2D provider is disposed");
      const params = ensureRecord(rawParams, "update params");
      const modelId = identifier(params.modelId, "modelId");
      const slot = models.get(modelId);
      if (!slot) throw error("live2d_model_not_found", `modelId "${modelId}" does not identify a loaded Live2D model`);
      const parameters = validateValues(params.parameters, "parameters");
      const partOpacities = validateValues(params.partOpacities, "partOpacities", { opacity: true });
      const placement = validatePlacement(params.placement);
      if (params.cacheStaticTopology !== undefined && typeof params.cacheStaticTopology !== "boolean") {
        throw error("invalid_request", "cacheStaticTopology must be a boolean when present");
      }
      const cacheTopology = params.cacheStaticTopology === true;
      return queue(slot, async () => {
        checkSignal(signal);
        if (disposed || models.get(modelId) !== slot) throw error("live2d_model_not_found", `modelId "${modelId}" does not identify a loaded Live2D model`);
        const p = slot.model.parameters;
        const part = slot.model.parts;
        for (let index = 0; index < slot.parameterDefaults.length; index++) p.values[index] = slot.parameterDefaults[index];
        for (let index = 0; index < slot.partDefaults.length; index++) part.opacities[index] = slot.partDefaults[index];
        for (const entry of parameters) {
          const index = slot.parameterIds.get(entry.id);
          if (index === undefined) throw error("live2d_parameter_not_found", `Core parameter "${entry.id}" does not exist`);
          p.values[index] = entry.value;
        }
        for (const entry of partOpacities) {
          const index = slot.partIds.get(entry.id);
          if (index === undefined) throw error("live2d_parameter_not_found", `Core part "${entry.id}" does not exist`);
          part.opacities[index] = entry.value;
        }
        try { slot.model.update(); }
        catch (cause) { throw error("live2d_update_failed", `Cubism Core could not update model "${modelId}": ${cause.message || cause}`, cause); }
        const drawables = new Array(slot.drawableCount);
        let frameBytes = 0;
        const topologies = cacheTopology && !slot.topology ? new Array(slot.drawableCount) : undefined;
        for (let index = 0; index < slot.drawableCount; index++) {
          const drawable = makeDrawable(slot, index, placement, cacheTopology);
          frameBytes += drawable.meshBytes.byteLength + drawable.multiplyColorRgba.byteLength + drawable.screenColorRgba.byteLength + (drawable.maskIndices?.byteLength || 0);
          if (frameBytes > MAX_FRAME_BYTES) throw error("live2d_resource_limit", "Live2D frame exceeds the 3 MiB browser response limit");
          drawables[index] = drawable;
          if (topologies) topologies[index] = {
            id: drawable.id,
            vertexCount: slot.model.drawables.vertexCounts[index],
            indexCount: slot.model.drawables.indexCounts[index],
            maskCount: slot.model.drawables.maskCounts[index],
          };
        }
        if (topologies) slot.topology = topologies;
        return { modelId, drawables, ...(cacheTopology ? { topologyMode: topologies ? "full" : "cached-v1" } : {}) };
      });
    }

    async function releaseModel(rawParams, internal = false) {
      if (disposed && !internal) throw error("live2d_provider_disposed", "Live2D provider is disposed");
      const params = ensureRecord(rawParams, "release params");
      const modelId = identifier(params.modelId, "modelId");
      const slot = models.get(modelId);
      if (!slot) throw error("live2d_model_not_found", `modelId "${modelId}" does not identify a loaded Live2D model`);
      return queue(slot, async () => {
        if (models.get(modelId) !== slot) throw error("live2d_model_not_found", `modelId "${modelId}" does not identify a loaded Live2D model`);
        models.delete(modelId);
        try { destroySlot(slot); }
        catch (cause) { throw cause; }
        return { modelId, released: true };
      });
    }

    async function invoke(capability, params, context = {}) {
      if (disposed) throw error("live2d_provider_disposed", "Live2D provider is disposed");
      checkSignal(context?.signal);
      if (capability === LOAD) {
        const pending = loadModel(params, context?.signal);
        pendingLoads.add(pending);
        try { return await pending; }
        finally { pendingLoads.delete(pending); }
      }
      if (capability === UPDATE) return updateModel(params, context?.signal);
      if (capability === RELEASE) return releaseModel(params);
      throw error("unsupported", `Unsupported Live2D capability "${String(capability)}"`);
    }

    async function dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([...pendingLoads]);
      const ids = [...models.keys()];
      const results = await Promise.allSettled(ids.map(modelId => releaseModel({ modelId }, true)));
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    }

    return { invoke, dispose };
  }

  return { createLive2dProvider };
});
