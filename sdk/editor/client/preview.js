/*
 * Pocket Studio preview projection.
 *
 * The iframe receives FrameResult DrawOps from the native PocketJS probe over
 * SSE and paints those operations directly. It does not evaluate guest source
 * or implement layout. The parent/editor integration can use the same
 * postMessage contract for captures and annotation rectangles:
 *
 * parent -> iframe
 *   {source:'pocket-editor', type:'preview.resize', width, height,
 *    safeArea:{top,right,bottom,left}}
 *   {source:'pocket-editor', type:'preview.capture', requestId, scale?}
 *   {source:'pocket-editor', type:'preview.regions', enabled:true|false}
 *   {source:'pocket-editor', type:'preview.annotation', requestId, rect,
 *    space:'logical'|'css'}
 *   {source:'pocket-editor', type:'preview.host-response', message}
 * iframe -> parent
 *   {source:'pocket-editor-preview', version:1, type:'preview.ready', ...}
 *   {source:'pocket-editor-preview', version:1, type:'preview.frame', frame}
 *   {source:'pocket-editor-preview', version:1, type:'preview.capture.result',
 *    requestId, dataUrl, width, height, logicalWidth, logicalHeight}
 *   {source:'pocket-editor-preview', version:1, type:'preview.annotation',
 *    requestId, rect:{x,y,width,height}, space:'logical'}
 *   {source:'pocket-editor-preview', version:1, type:'preview.status', status}
 *   {source:'pocket-editor-preview', version:1, type:'preview.error', error}
 *   {source:'pocket-editor-preview', version:1, type:'preview.unsupported', ...}
 *
 * Pointer/key input travels to the manager's POST /input route. Resize is
 * parent-owned for embedded device frames (standalone pages may use a
 * ResizeObserver); wheel gestures are translated to the engine's canonical
 * pointer drag path because the pinned runtime has no native wheel method.
 * The frame notification retains DrawOps/events and resource descriptors, but
 * omits raw resource pixels/palettes: the Editor parent uses it as a readiness
 * signal. The iframe renderer and getFrame() keep the complete native frame.
 * There is no fixed-interval browser polling.
 */
(function installPocketEditorPreview(global) {
  "use strict";

  const VERSION = 1;
  const SOURCE = "pocket-editor-preview";
  const PARENT_SOURCE = "pocket-editor";
  const MAX_DIMENSION = 32000;
  const tintedImageCache = new WeakMap();
  // A glass surface is painted in the same DrawOps order as the native host:
  // copy the already-painted backdrop, blur that copy, then let following
  // ops (the black scrim and the modal panel) paint above it. Keep one scratch
  // canvas per preview canvas so opening/closing a modal does not allocate a
  // new full-viewport buffer on every frame. Retain only its last filtered
  // backdrop: an opacity/scale change above the glass needs only compositing.
  const glassScratchCache = new WeakMap();

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function safeArea(value) {
    const record = value && typeof value === "object" && !Array.isArray(value) ? value : null;
    const inset = (key) => clamp(number(record?.[key], 0), 0, MAX_DIMENSION);
    return { top: inset("top"), right: inset("right"), bottom: inset("bottom"), left: inset("left") };
  }

  function argb(value) {
    const color = Number(value) >>> 0;
    const alpha = ((color >>> 24) & 0xff) / 255;
    return `rgba(${(color >>> 16) & 0xff},${(color >>> 8) & 0xff},${color & 0xff},${alpha})`;
  }

  function resourceBytes(value, encoding) {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (encoding !== "base64") return Array.isArray(value) ? new Uint8Array(value) : null;
    if (typeof value !== "string") return null;
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(value);
    const binary = global.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function previewStream(url, offMainThread) {
    if (!offMainThread || typeof global.Worker !== "function") return new EventSource(url);
    // Keep the browser's own SSE/reconnect implementation. Only its IO,
    // JSON parsing and byte unpacking move off the editor's rendering thread.
    function receive() {
      self.onmessage = ({ data: url }) => {
        const source = new EventSource(url);
        source.onopen = () => self.postMessage({ kind: "open", state: source.readyState });
        source.onerror = () => self.postMessage({ kind: "error", state: source.readyState });
        source.onmessage = ({ data }) => {
          try {
            const packet = JSON.parse(data);
            const buffers = [];
            for (const resource of packet.frame?.resources ?? []) {
              if (resource.bytesEncoding !== "base64") continue;
              for (const key of ["pixels", "palette"]) {
                if (typeof resource[key] !== "string") continue;
                const bytes = resourceBytes(resource[key], "base64");
                resource[key] = bytes;
                buffers.push(bytes.buffer);
              }
              delete resource.bytesEncoding;
            }
            self.postMessage({ kind: "message", packet }, buffers);
          } catch (error) {
            self.postMessage({ kind: "message", packet: { type: "error", error: String(error?.message || error) } });
          }
        };
      };
    }
    const blobUrl = URL.createObjectURL(new Blob([
      `const global=self;const resourceBytes=${resourceBytes.toString()};(${receive.toString()})();`,
    ], { type: "text/javascript" }));
    let worker;
    try { worker = new Worker(blobUrl); }
    catch { URL.revokeObjectURL(blobUrl); return new EventSource(url); }
    const stream = {
      readyState: 0, onopen: null, onmessage: null, onerror: null,
      close() { stream.readyState = 2; worker.terminate(); URL.revokeObjectURL(blobUrl); },
    };
    worker.onmessage = ({ data }) => {
      URL.revokeObjectURL(blobUrl);
      if (stream.readyState === 2) return;
      if (data.kind === "message") stream.onmessage?.({ data: data.packet });
      else {
        stream.readyState = data.state;
        if (data.kind === "open") stream.onopen?.();
        else stream.onerror?.();
      }
    };
    worker.onerror = () => { stream.close(); stream.onerror?.(); };
    worker.postMessage(new URL(url, global.location.href).href);
    return stream;
  }

  function decodeResource(resource) {
    if (!resource || !resource.width || !resource.height) return null;
    const width = Number(resource.width);
    const height = Number(resource.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > 16 * 1024 * 1024) return null;
    const source = resourceBytes(resource.pixels, resource.bytesEncoding);
    if (!source) return null;
    const expected = width * height;
    const rgba = new Uint8ClampedArray(expected * 4);
    const psm = Number(resource.psm);
    if (psm === 3) {
      if (source.length < expected * 4) return null;
      rgba.set(source.subarray(0, expected * 4));
    } else if (psm === 0) {
      if (source.length < expected * 2) return null;
      for (let index = 0; index < expected; index += 1) {
        const value = source[index * 2] | (source[index * 2 + 1] << 8);
        const r = value & 0x1f;
        const g = (value >>> 5) & 0x3f;
        const b = (value >>> 11) & 0x1f;
        const at = index * 4;
        rgba[at] = (r << 3) | (r >>> 2);
        rgba[at + 1] = (g << 2) | (g >>> 4);
        rgba[at + 2] = (b << 3) | (b >>> 2);
        rgba[at + 3] = 255;
      }
    } else if (psm === 2) {
      if (source.length < expected * 2) return null;
      for (let index = 0; index < expected; index += 1) {
        const value = source[index * 2] | (source[index * 2 + 1] << 8);
        const at = index * 4;
        rgba[at] = (value & 0x0f) * 17;
        rgba[at + 1] = ((value >>> 4) & 0x0f) * 17;
        rgba[at + 2] = ((value >>> 8) & 0x0f) * 17;
        rgba[at + 3] = ((value >>> 12) & 0x0f) * 17;
      }
    } else if (psm === 5) {
      const palette = resourceBytes(resource.palette, resource.bytesEncoding);
      if (!palette || palette.length < 1024 || source.length < expected) return null;
      // Glyph pages are indexed textures. Copy an RGBA palette entry as one
      // word instead of expanding four byte channels on the cold UI frame.
      // Both views use the same byte order, preserving the wire RGBA bytes.
      const colors = new Uint32Array(palette.buffer, palette.byteOffset, 256);
      const output = new Uint32Array(rgba.buffer);
      for (let index = 0; index < expected; index += 1) {
        output[index] = colors[source[index]];
      }
    } else {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
    return { canvas, rgba, width, height, revision: Number(resource.revision) || 0 };
  }

  function resourceNotification(resource) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return null;
    const byteLength = (value) => {
      if (Array.isArray(value)) return value.length;
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (resource.bytesEncoding === "base64" && typeof value === "string") {
        return value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
      }
      return null;
    };
    return {
      asset: resource.asset ?? null,
      revision: resource.revision ?? null,
      width: resource.width ?? null,
      height: resource.height ?? null,
      psm: resource.psm ?? null,
      linear: resource.linear ?? null,
      pixelsBytes: byteLength(resource.pixels),
      paletteBytes: resource.palette == null ? null : byteLength(resource.palette),
    };
  }

  function frameNotification(frame) {
    // `frame` remains the unmodified native value for Canvas drawing, the
    // presentation ACK barrier and getFrame(). Only the separate parent
    // notification gets a small descriptor in place of raw pixel arrays.
    return {
      ...frame,
      resources: Array.isArray(frame.resources)
        ? frame.resources.map(resourceNotification)
        : [],
    };
  }

  function tintedImage(image, tintValue) {
    if (!image || tintValue === undefined || tintValue === null) return image;
    const tint = Number(tintValue) >>> 0;
    if (tint === 0xffffffff) return image;
    let variants = tintedImageCache.get(image);
    if (!variants) {
      variants = new Map();
      tintedImageCache.set(image, variants);
    }
    const cached = variants.get(tint);
    if (cached) {
      variants.delete(tint);
      variants.set(tint, cached);
      return cached;
    }
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return image;
    // Retain the decoded CPU pixels: reading a rendered Canvas back for every
    // intermediate theme colour forces a GPU synchronisation on the UI thread.
    const data = new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height);
    const red = (tint >>> 16) & 0xff;
    const green = (tint >>> 8) & 0xff;
    const blue = tint & 0xff;
    const alpha = (tint >>> 24) & 0xff;
    for (let index = 0; index < data.data.length; index += 4) {
      data.data[index] = Math.round(data.data[index] * red / 255);
      data.data[index + 1] = Math.round(data.data[index + 1] * green / 255);
      data.data[index + 2] = Math.round(data.data[index + 2] * blue / 255);
      data.data[index + 3] = Math.round(data.data[index + 3] * alpha / 255);
    }
    context.putImageData(data, 0, 0);
    const result = { canvas, width: image.width, height: image.height, revision: image.revision };
    variants.set(tint, result);
    // Interrupted transitions can produce unlimited distinct colours. Keep a
    // small LRU, also bounded by pixel area for large textures.
    const pixelArea = Math.max(1, image.width * image.height);
    const maxVariants = pixelArea <= 16 ? 8 : 64;
    const memoryBudget = pixelArea <= 16 ? 1024 * 1024 : 16 * 1024 * 1024;
    const limit = Math.max(1, Math.min(maxVariants, Math.floor(memoryBudget / pixelArea)));
    while (variants.size > limit) {
      const oldest = variants.keys().next().value;
      const retired = variants.get(oldest);
      variants.delete(oldest);
      retired.canvas.width = retired.canvas.height = 0;
    }
    return result;
  }

  function disposeResource(image) {
    if (!image) return;
    for (const variant of tintedImageCache.get(image)?.values() ?? []) {
      variant.canvas.width = variant.canvas.height = 0;
    }
    tintedImageCache.delete(image);
    image.canvas.width = image.canvas.height = 0;
    image.rgba = null;
  }

  function clipRect(context, clip) {
    if (!clip) return;
    context.beginPath();
    context.rect(number(clip.x, 0), number(clip.y, 0), Math.max(0, number(clip.w, 0)), Math.max(0, number(clip.h, 0)));
    context.clip();
  }

  function drawImage(context, image, op) {
    if (!image) return;
    let alpha = 1;
    if (op.color !== undefined && op.color !== null) {
      const rawColor = Number(op.color) >>> 0;
      const alphaByte = (rawColor >>> 24) & 0xff;
      if (alphaByte === 0) return;
      alpha = alphaByte / 255;
      image = tintedImage(image, ((0xff000000 | (rawColor & 0x00ffffff)) >>> 0));
    }
    const uv = Array.isArray(op.uv) && op.uv.length === 4 ? op.uv : [0, 0, 1, 1];
    const sx = clamp(uv[0], 0, 1) * image.width;
    const sy = clamp(uv[1], 0, 1) * image.height;
    const sw = (clamp(uv[2], 0, 1) - clamp(uv[0], 0, 1)) * image.width;
    const sh = (clamp(uv[3], 0, 1) - clamp(uv[1], 0, 1)) * image.height;
    if (sw <= 0 || sh <= 0) return;
    if (alpha < 1) {
      const previousAlpha = context.globalAlpha;
      context.globalAlpha = previousAlpha * alpha;
      context.drawImage(image.canvas, sx, sy, sw, sh, number(op.x, 0), number(op.y, 0), number(op.w, 0), number(op.h, 0));
      context.globalAlpha = previousAlpha;
      return;
    }
    context.drawImage(image.canvas, sx, sy, sw, sh, number(op.x, 0), number(op.y, 0), number(op.w, 0), number(op.h, 0));
  }

  function videoKey(op) {
    return `${String(op?.asset ?? "")}\u0000${String(op?.id ?? "")}`;
  }

  function drawVideo(context, state, op) {
    const element = state?.element;
    if (!element || state.disposed || element.readyState < 2 || element.videoWidth <= 0 || element.videoHeight <= 0) return;
    const x = number(op.x, 0);
    const y = number(op.y, 0);
    const width = Math.max(0, number(op.w, 0));
    const height = Math.max(0, number(op.h, 0));
    if (width <= 0 || height <= 0) return;
    const sourceWidth = element.videoWidth;
    const sourceHeight = element.videoHeight;
    const fit = op.fit === "contain" || op.fit === "fill" ? op.fit : "cover";
    let sx = 0;
    let sy = 0;
    let sw = sourceWidth;
    let sh = sourceHeight;
    let dx = x;
    let dy = y;
    let dw = width;
    let dh = height;
    if (fit !== "fill") {
      const sourceRatio = sourceWidth / sourceHeight;
      const destinationRatio = width / height;
      if (fit === "cover") {
        if (sourceRatio > destinationRatio) {
          sw = sourceHeight * destinationRatio;
          sx = (sourceWidth - sw) / 2;
        } else if (sourceRatio < destinationRatio) {
          sh = sourceWidth / destinationRatio;
          sy = (sourceHeight - sh) / 2;
        }
      } else if (sourceRatio > destinationRatio) {
        dh = width / sourceRatio;
        dy = y + (height - dh) / 2;
      } else if (sourceRatio < destinationRatio) {
        dw = height * sourceRatio;
        dx = x + (width - dw) / 2;
      }
    }
    context.drawImage(element, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  function drawTriangle(context, op, image) {
    const points = Array.isArray(op.points) ? op.points : [];
    if (points.length !== 3) return;
    if (op.type === "textureTriangle" && (!image || !Array.isArray(op.uvs) || op.uvs.length !== 6)) return;
    if (!image || !Array.isArray(op.uvs) || op.uvs.length !== 6) {
      context.beginPath();
      context.moveTo(number(points[0].x, 0), number(points[0].y, 0));
      context.lineTo(number(points[1].x, 0), number(points[1].y, 0));
      context.lineTo(number(points[2].x, 0), number(points[2].y, 0));
      context.closePath();
      const colors = Array.isArray(op.colors) ? op.colors : [];
      context.fillStyle = argb(colors[0] ?? op.color ?? 0);
      context.fill();
      return;
    }
    let alpha = 1;
    if (op.color !== undefined && op.color !== null) {
      const tint = Number(op.color) >>> 0;
      alpha = ((tint >>> 24) & 0xff) / 255;
      if (alpha === 0) return;
      // Transformed glyphs use TEX_TRI during a dialog's scale animation.
      // Share the RGB texture through the fade instead of cloning and
      // uploading an entire font atlas for each intermediate alpha.
      image = tintedImage(image, (0xff000000 | (tint & 0x00ffffff)) >>> 0);
    }
    // Map source texture coordinates to the real triangle. Canvas2D has no
    // vertex primitive, so the path clip + affine texture draw is the direct
    // projection of the native TEX_TRI geometry.
    const p0 = points[0];
    const p1 = points[1];
    const p2 = points[2];
    const u0 = op.uvs[0] * image.width;
    const v0 = op.uvs[1] * image.height;
    const u1 = op.uvs[2] * image.width;
    const v1 = op.uvs[3] * image.height;
    const u2 = op.uvs[4] * image.width;
    const v2 = op.uvs[5] * image.height;
    const determinant = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-7) return;
    const a = (p0.x * (v1 - v2) + p1.x * (v2 - v0) + p2.x * (v0 - v1)) / determinant;
    const c = (p0.x * (u2 - u1) + p1.x * (u0 - u2) + p2.x * (u1 - u0)) / determinant;
    const e = (p0.x * (u1 * v2 - u2 * v1) + p1.x * (u2 * v0 - u0 * v2) + p2.x * (u0 * v1 - u1 * v0)) / determinant;
    const b = (p0.y * (v1 - v2) + p1.y * (v2 - v0) + p2.y * (v0 - v1)) / determinant;
    const d = (p0.y * (u2 - u1) + p1.y * (u0 - u2) + p2.y * (u1 - u0)) / determinant;
    const f = (p0.y * (u1 * v2 - u2 * v1) + p1.y * (u2 * v0 - u0 * v2) + p2.y * (u0 * v1 - u1 * v0)) / determinant;
    context.save();
    context.globalAlpha *= alpha;
    context.beginPath();
    context.moveTo(p0.x, p0.y);
    context.lineTo(p1.x, p1.y);
    context.lineTo(p2.x, p2.y);
    context.closePath();
    context.clip();
    context.transform(a, b, c, d, e, f);
    context.drawImage(image.canvas, 0, 0);
    context.restore();
  }

  function fontSize(slot) {
    const values = [12, 14, 16, 18, 20, 24, 36];
    const index = Number(slot);
    if (index >= 0 && index <= 6) return values[index];
    if (index >= 7 && index <= 13) return values[index - 7];
    if (index === 14 || index === 15) return 54;
    if (index >= 16 && index <= 18) return values[index - 16];
    if (index === 19 || index === 20) return 10;
    return 14;
  }

  function fontWeight(slot) {
    const index = Number(slot);
    return (index >= 7 && index <= 13) || index === 15 || index === 20 ? 700 : 400;
  }

  function surfaceDescriptor(op) {
    if (!op || typeof op !== "object") return null;
    if (op.kind === "glass" && op.parameters && typeof op.parameters === "object") {
      return { kind: "glass", parameters: op.parameters };
    }
    if (op.type !== "hostSurface" || typeof op.asset !== "string") return null;
    try {
      const descriptor = JSON.parse(op.asset);
      if (!descriptor || typeof descriptor !== "object" || descriptor.kind !== "glass" ||
          !descriptor.parameters || typeof descriptor.parameters !== "object") return null;
      return { kind: "glass", parameters: descriptor.parameters };
    } catch {
      return null;
    }
  }

  function glassScratchFor(canvas) {
    let scratch = glassScratchCache.get(canvas);
    if (scratch) return scratch;
    const element = document.createElement("canvas");
    const context = element.getContext("2d");
    if (!context) return null;
    scratch = { canvas: element, context, backdropKey: null, sigma: null, optics: null, opticsTried: false };
    glassScratchCache.set(canvas, scratch);
    return scratch;
  }

  function roundedClip(context, x, y, width, height, radius) {
    context.beginPath();
    if (radius > 0 && typeof context.roundRect === "function") {
      context.roundRect(x, y, width, height, radius);
    } else {
      context.rect(x, y, width, height);
    }
    context.clip();
  }

  /** Paint one real browser-side backdrop blur for a native `glass` surface. */
  function drawGlassSurface(context, op, frameWidth, frameHeight, descriptor, backdropKey = null) {
    descriptor = descriptor || surfaceDescriptor(op);
    if (!descriptor) return false;
    const parameters = descriptor.parameters;
    const opticalInset = clamp(number(parameters.opticalInset, 0), 0, 64);
    const effect = parameters.effect === "blur" ? "blur" : "glass";
    const opacity = effect === "blur" ? clamp(number(parameters.opacity, 1), 0, 1) : 1;
    // A transparent entrance frame has no filtered contribution. In
    // particular, do not allocate a DPR-sized canvas or initialize the blur
    // pipeline on the same input turn merely to discard all of its pixels.
    if (opacity === 0) return true;
    const source = context.canvas;
    const scratch = glassScratchFor(source);
    if (!scratch) return false;
    if (effect === "glass") {
      if (!scratch.opticsTried) {
        scratch.opticsTried = true;
        scratch.optics = global.PocketLiquidGlass?.create(scratch.canvas, scratch.context,
          () => source.dispatchEvent(new Event("pocket-optical-ready"))) ?? null;
      }
      const optical = scratch.optics?.draw(source, frameWidth, frameHeight, op, parameters, backdropKey);
      // Optical sampling shares the existing 2D scratch, invalidating its blur.
      scratch.backdropKey = null;
      source.dataset.glassRenderer = optical ? "webgl-refractive" : "frosted";
      if (optical) {
        context.save();
        const width = Math.max(0, number(op.w, op.width ?? 0));
        const height = Math.max(0, number(op.h, op.height ?? 0));
        const radius = opticalInset > 0 ? 0 : parameters.shape === "pill" || parameters.shape === "circle"
          ? Math.min(width, height) / 2
          : clamp(number(parameters.radius, 0), 0, Math.min(width, height) / 2);
        // The shader returns the untouched backdrop outside its original SDF;
        // the expanded rectangular clip only prevents the local optical halo
        // from leaking into unrelated draw ops.
        roundedClip(context, number(op.x, 0), number(op.y, 0), width, height, radius);
        context.drawImage(optical.canvas, optical.x, optical.y, optical.width, optical.height);
        context.restore();
        return true;
      }
    }
    if (typeof scratch.context.filter !== "string") return false;
    const backingWidth = source.width;
    const backingHeight = source.height;
    if (backingWidth <= 0 || backingHeight <= 0) return false;
    if (scratch.canvas.width !== backingWidth || scratch.canvas.height !== backingHeight) {
      scratch.canvas.width = backingWidth;
      scratch.canvas.height = backingHeight;
      scratch.backdropKey = null;
    }
    const scaleX = backingWidth / Math.max(1, frameWidth);
    const scaleY = backingHeight / Math.max(1, frameHeight);
    const scale = Math.min(scaleX, scaleY);
    const sigma = clamp(number(parameters.blur, 5), 0, 20);
    // Plain backdrop blur deliberately has no colour wash, even if a stale
    // recipe field is present. The native provider applies the same contract.
    const tintOpacity = effect === "blur" ? 0 : clamp(number(parameters.tintOpacity, 0), 0, 1);
    const x = number(op.x, 0);
    const y = number(op.y, 0);
    const width = Math.max(0, number(op.w, op.width ?? 0));
    const height = Math.max(0, number(op.h, op.height ?? 0));
    if (width <= 0 || height <= 0) return false;

    // Copy only the frame that has already been painted. The copy is the
    // browser equivalent of Flutter's BackdropFilter input texture; it does
    // not re-run guest layout or invent a screenshot of the modal itself.
    // Compare the exact ordered draw prefix, not a lossy hash. Only the most
    // recent sample is retained in the existing scratch canvas; multiple
    // glass surfaces safely recalculate when their prefixes differ.
    const scaledSigma = sigma * scale;
    if (typeof backdropKey === "function") backdropKey = backdropKey({ x: 0, y: 0, w: frameWidth, h: frameHeight });
    if (backdropKey === null || scratch.backdropKey !== backdropKey || scratch.sigma !== scaledSigma) {
      const scratchContext = scratch.context;
      scratchContext.setTransform(1, 0, 0, 1, 0, 0);
      scratchContext.globalAlpha = 1;
      scratchContext.globalCompositeOperation = "copy";
      scratchContext.filter = `blur(${scaledSigma}px)`;
      scratchContext.drawImage(source, 0, 0, backingWidth, backingHeight);
      scratchContext.filter = "none";
      scratchContext.globalCompositeOperation = "source-over";
      scratch.backdropKey = backdropKey;
      scratch.sigma = scaledSigma;
    }

    context.save();
    const clip = op.clip && typeof op.clip === "object" ? op.clip : null;
    if (clip) {
      context.beginPath();
      context.rect(number(clip.x, 0), number(clip.y, 0), Math.max(0, number(clip.w ?? clip.width, 0)), Math.max(0, number(clip.h ?? clip.height, 0)));
      context.clip();
    }
    const shapeX = x + opticalInset, shapeY = y + opticalInset;
    const shapeWidth = Math.max(0, width - opticalInset * 2);
    const shapeHeight = Math.max(0, height - opticalInset * 2);
    const radius = parameters.shape === "pill" || parameters.shape === "circle"
      ? Math.min(shapeWidth, shapeHeight) / 2
      : clamp(number(parameters.radius, 0), 0, Math.min(shapeWidth, shapeHeight) / 2);
    roundedClip(context, shapeX, shapeY, shapeWidth, shapeHeight, radius);
    context.globalAlpha = opacity;
    context.drawImage(scratch.canvas, 0, 0, backingWidth, backingHeight, 0, 0, frameWidth, frameHeight);
    if (tintOpacity > 0) {
      context.fillStyle = `rgba(255,255,255,${tintOpacity})`;
      context.fillRect(x, y, width, height);
    }
    const materialStrength = effect === "glass" ? clamp(number(parameters.materialStrength, 0), 0, 1) : 0;
    if (materialStrength > 0) {
      context.globalAlpha = opacity * materialStrength;
      context.fillStyle = argb(parameters.materialTint ?? 0xfff2f2f7);
      context.fillRect(x, y, width, height);
    }
    context.restore();
    return true;
  }

  function sameClip(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return number(a.x, 0) === number(b.x, 0) &&
      number(a.y, 0) === number(b.y, 0) &&
      number(a.w, 0) === number(b.w, 0) &&
      number(a.h, 0) === number(b.h, 0);
  }

  // Ordered paint dependencies for one optical sample, not the entire frame.
  // Unknown geometry stays a dependency. An overlapping preceding filter can
  // pull pixels in from outside this ROI, so retain its complete input prefix.
  function glassBackdropKey(context, ops, end, region, resourceEpoch, width, height) {
    const selected = [];
    let keepThrough = -1;
    const intersects = (bounds) => bounds.x < region.x + region.w && bounds.x + bounds.w > region.x &&
      bounds.y < region.y + region.h && bounds.y + bounds.h > region.y;
    for (let index = end - 1; index >= 0; index--) {
      const op = ops[index];
      if (!op || typeof op !== "object") continue;
      if (index <= keepThrough) { selected.push(op); continue; }
      let bounds = null;
      if (op.type === "triangle" || op.type === "textureTriangle") {
        if (Array.isArray(op.points) && op.points.length === 3) {
          const xs = op.points.map((point) => Number(point.x));
          const ys = op.points.map((point) => Number(point.y));
          bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        }
      } else if ([op.x, op.y, op.w, op.h].every((value) => Number.isFinite(Number(value)))) {
        bounds = { x: Number(op.x), y: Number(op.y), w: Number(op.w), h: Number(op.h) };
        if (op.type === "text") {
          const size = fontSize(op.fontSlot);
          if (bounds.y - size >= region.y + region.h || bounds.y + bounds.h + size <= region.y) continue;
          const previousFont = context.font;
          context.font = `${fontWeight(op.fontSlot)} ${size}px system-ui, -apple-system, sans-serif`;
          const lines = String(op.text ?? "").split("\n");
          const measured = Math.max(0, ...lines.map((line) => context.measureText(line).width));
          context.font = previousFont;
          const align = Number(op.align);
          const offset = align === 1 ? (bounds.w - measured) / 2 : align === 2 ? bounds.w - measured : 0;
          // Include glyph bearings/antialiasing beyond the advance box.
          bounds = { x: bounds.x + Math.min(0, offset) - size, y: bounds.y - size,
            w: Math.max(bounds.w, measured) + size * 2, h: bounds.h + size * 2 };
        }
      }
      if (bounds && op.clip) {
        const clip = op.clip;
        const right = Math.min(bounds.x + bounds.w, number(clip.x, 0) + number(clip.w, 0));
        const bottom = Math.min(bounds.y + bounds.h, number(clip.y, 0) + number(clip.h, 0));
        bounds.x = Math.max(bounds.x, number(clip.x, 0));
        bounds.y = Math.max(bounds.y, number(clip.y, 0));
        bounds.w = Math.max(0, right - bounds.x); bounds.h = Math.max(0, bottom - bounds.y);
      }
      if (bounds && !intersects(bounds)) continue;
      selected.push(op);
      if (op.type === "hostSurface") keepThrough = index - 1;
    }
    return JSON.stringify([resourceEpoch, width, height, selected.reverse()]);
  }

  function drawFrame(context, frame, resources, videos, resourceEpoch = 0) {
    const width = number(frame.width, 1);
    const height = number(frame.height, 1);
    const ops = Array.isArray(frame.ops) ? frame.ops : [];
    const unsupported = ops.find((op) => op && typeof op === "object" && (
      op.type === "meshLayerBegin" || op.type === "meshMaskBegin" || op.type === "meshLayerRestore"
      || op.type === "textureTriangleRepeat" || (op.type === "textureTriangle" && op.repeatTexture === true)
    ));
    if (unsupported) {
      throw new Error(`Canvas2D preview does not support Live2D mesh effects or repeat sampling (${unsupported.type})`);
    }
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    let hasGlass = false;
    let backdropHasVideo = false;
    let activeClip = null;
    for (let index = 0; index < ops.length; index += 1) {
      const op = ops[index];
      if (!op || typeof op !== "object") continue;
      const nextClip = op.clip && typeof op.clip === "object" ? op.clip : null;
      if (!sameClip(activeClip, nextClip)) {
        if (activeClip) context.restore();
        if (nextClip) {
          context.save();
          clipRect(context, nextClip);
        }
        activeClip = nextClip;
      }
      const kind = op.type;
      if (kind === "rect") {
        context.fillStyle = argb(op.color ?? 0);
        context.fillRect(number(op.x, 0), number(op.y, 0), number(op.w, 0), number(op.h, 0));
      } else if (kind === "gradient") {
        const x = number(op.x, 0);
        const y = number(op.y, 0);
        const w = number(op.w, 0);
        const h = number(op.h, 0);
        const direction = Number(op.direction);
        const horizontal = direction === 2 || direction === 3;
        const reverse = direction === 1 || direction === 3;
        const gradient = horizontal
          ? context.createLinearGradient(reverse ? x + w : x, y, reverse ? x : x + w, y)
          : context.createLinearGradient(x, reverse ? y + h : y, x, reverse ? y : y + h);
        gradient.addColorStop(0, argb(op.from ?? 0));
        gradient.addColorStop(1, argb(op.to ?? 0));
        context.fillStyle = gradient;
        context.fillRect(x, y, w, h);
      } else if (kind === "text") {
        const size = fontSize(op.fontSlot);
        context.font = `${fontWeight(op.fontSlot)} ${size}px system-ui, -apple-system, sans-serif`;
        context.fillStyle = argb(op.color ?? 0);
        context.textBaseline = "top";
        const text = String(op.text ?? "");
        const lines = text.split("\n");
        const lineHeight = number(op.h, size * 1.2) / Math.max(1, lines.length);
        for (let line = 0; line < lines.length; line += 1) {
          const value = lines[line];
          const align = Number(op.align);
          const offset = align === 1 ? (number(op.w, 0) - context.measureText(value).width) / 2 : align === 2 ? number(op.w, 0) - context.measureText(value).width : 0;
          context.fillText(value, number(op.x, 0) + offset, number(op.y, 0) + line * lineHeight);
        }
      } else if (kind === "image") {
        drawImage(context, resources.get(String(op.asset ?? "")), op);
      } else if (kind === "triangle" || kind === "textureTriangle") {
        drawTriangle(context, op, resources.get(String(op.asset ?? "")));
      } else if (kind === "video") {
        drawVideo(context, videos?.get(videoKey(op)), op);
        backdropHasVideo = true;
      } else if (kind === "hostSurface") {
        // Glass is a real browser projection of the native compositor
        // surface. Other host surfaces still have no browser-side provider;
        // do not paint fabricated rectangles or screenshots for them.
        const descriptor = surfaceDescriptor(op);
        if (descriptor) {
          hasGlass = true;
          // Videos can change pixels without a new DrawOp. Resource updates
          // invalidate even when an image keeps the same asset identity.
          const key = backdropHasVideo ? null : (region) => glassBackdropKey(context, ops, index, region, resourceEpoch, width, height);
          drawGlassSurface(context, op, width, height, descriptor, key);
        }
      }
    }
    if (!hasGlass) {
      const scratch = glassScratchCache.get(context.canvas);
      if (scratch) scratch.backdropKey = null;
    }
    if (activeClip) context.restore();
  }

  function visibleRegion(op, width, height) {
    if (!op || typeof op !== "object" || op.type === "hostSurface") return null;
    const x = Number(op.x);
    const y = Number(op.y);
    const w = Number(op.w);
    const h = Number(op.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    if (op.color !== undefined && ((Number(op.color) >>> 24) & 0xff) === 0) return null;
    // A full-viewport fill is the compositor background, not an inspectable
    // visual region. Test this before clip intersection so a clipped replay
    // of the same background does not get a misleading label.
    if (x <= 0 && y <= 0 && x + w >= width && y + h >= height) return null;
    const clip = op.clip && typeof op.clip === "object" ? op.clip : null;
    const clipX = clip && Number.isFinite(Number(clip.x)) ? Number(clip.x) : 0;
    const clipY = clip && Number.isFinite(Number(clip.y)) ? Number(clip.y) : 0;
    const clipRight = clip && Number.isFinite(Number(clip.w)) ? clipX + Math.max(0, Number(clip.w)) : width;
    const clipBottom = clip && Number.isFinite(Number(clip.h)) ? clipY + Math.max(0, Number(clip.h)) : height;
    const left = Math.max(0, x, clipX);
    const top = Math.max(0, y, clipY);
    const right = Math.min(width, x + w, clipRight);
    const bottom = Math.min(height, y + h, clipBottom);
    if (right - left < 1 || bottom - top < 1) return null;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  function regionKey(region) {
    return [region.x, region.y, region.w, region.h].map((value) => Math.round(value * 100) / 100).join(",");
  }

  function decorativeFillKey(op) {
    if (!op || typeof op !== "object") return null;
    // Rounded controls are emitted as a same-color rect plus tinted corner
    // mask images. They are one visual fill for inspection purposes; image
    // ops that are not connected to that fill remain independent regions.
    if (op.type === "rect" || op.type === "image") {
      if (op.color === undefined) return null;
      return `color:${Number(op.color) >>> 0}`;
    }
    if (op.type === "gradient") {
      return `gradient:${Number(op.from) >>> 0}:${Number(op.to) >>> 0}:${Number(op.direction)}`;
    }
    return null;
  }

  function touchingRegions(left, right) {
    const tolerance = 0.5;
    return left.x <= right.x + right.w + tolerance &&
      right.x <= left.x + left.w + tolerance &&
      left.y <= right.y + right.h + tolerance &&
      right.y <= left.y + left.h + tolerance;
  }

  function mergeDecorativeRegions(regions) {
    const merged = regions.map((entry) => ({ ...entry, region: { ...entry.region } }));
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < merged.length && !changed; index += 1) {
        const current = merged[index];
        if (!current.fillKey) continue;
        for (let next = index + 1; next < merged.length; next += 1) {
          const candidate = merged[next];
          if (candidate.fillKey !== current.fillKey || !touchingRegions(current.region, candidate.region)) continue;
          const left = Math.min(current.region.x, candidate.region.x);
          const top = Math.min(current.region.y, candidate.region.y);
          const right = Math.max(current.region.x + current.region.w, candidate.region.x + candidate.region.w);
          const bottom = Math.max(current.region.y + current.region.h, candidate.region.y + candidate.region.h);
          current.region = { x: left, y: top, w: right - left, h: bottom - top };
          merged.splice(next, 1);
          changed = true;
          break;
        }
      }
    }
    return merged;
  }

  function overlapsLabel(left, right) {
    const gap = 2;
    return left.x < right.x + right.w + gap &&
      right.x < left.x + left.w + gap &&
      left.y < right.y + right.h + gap &&
      right.y < left.y + left.h + gap;
  }

  function labelPosition(region, labelWidth, labelHeight, width, height, occupied) {
    const maxX = Math.max(0, width - labelWidth);
    const maxY = Math.max(0, height - labelHeight);
    const x = clamp(region.x, 0, maxX);
    const y = clamp(region.y, 0, maxY);
    const candidates = [
      { x, y: clamp(y - labelHeight - 2, 0, maxY) },
      { x, y },
      { x: clamp(x + labelWidth + 2, 0, maxX), y },
      { x, y: clamp(y + labelHeight + 2, 0, maxY) },
      { x: clamp(x - labelWidth - 2, 0, maxX), y },
    ];
    for (const candidate of candidates) {
      const placed = { ...candidate, w: labelWidth, h: labelHeight };
      if (!occupied.some((other) => overlapsLabel(placed, other))) return placed;
    }
    return { x, y, w: labelWidth, h: labelHeight };
  }

  function drawRegionOverlay(context, frame) {
    const width = number(frame.width, 0);
    const height = number(frame.height, 0);
    if (width <= 0 || height <= 0) return;
    const candidates = [];
    for (const op of Array.isArray(frame.ops) ? frame.ops : []) {
      const region = visibleRegion(op, width, height);
      if (!region) continue;
      candidates.push({ region, fillKey: decorativeFillKey(op) });
    }
    const regions = [];
    const seen = new Set();
    for (const candidate of mergeDecorativeRegions(candidates)) {
      const key = regionKey(candidate.region);
      if (seen.has(key)) continue;
      seen.add(key);
      regions.push(candidate.region);
    }
    if (!regions.length) return;
    context.save();
    context.strokeStyle = "rgba(220, 38, 38, 0.95)";
    context.fillStyle = "rgba(220, 38, 38, 0.95)";
    context.lineWidth = 1;
    context.font = "700 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "top";
    const occupiedLabels = [];
    for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index];
      context.strokeRect(region.x + 0.5, region.y + 0.5, Math.max(0, region.w - 1), Math.max(0, region.h - 1));
      const label = `S${index + 1}`;
      const labelWidth = Math.max(14, context.measureText(label).width + 6);
      const labelHeight = 13;
      const labelRect = labelPosition(region, labelWidth, labelHeight, width, height, occupiedLabels);
      occupiedLabels.push(labelRect);
      context.fillRect(labelRect.x, labelRect.y, labelWidth, labelHeight);
      context.fillStyle = "#ffffff";
      context.fillText(label, labelRect.x + 3, labelRect.y + 2);
      context.fillStyle = "rgba(220, 38, 38, 0.95)";
    }
    context.restore();
  }

  function client(root, options) {
    const projectId = String(options.projectId || root.dataset.projectId || "");
    const canvas = root.querySelector("canvas") || document.createElement("canvas");
    const onOpticalReady = () => { if (!closed) renderCurrentFrame(); };
    canvas.addEventListener("pocket-optical-ready", onOpticalReady);
    if (!canvas.parentNode) root.appendChild(canvas);
    canvas.id = canvas.id || "pocket-preview-surface";
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "PocketJS live preview");
    const status = root.querySelector("[data-preview-status]") || document.createElement("output");
    status.dataset.previewStatus = "";
    status.style.cssText = "display:block;color:#94a3b8;font:12px ui-monospace,monospace;padding:4px 0";
    if (!status.parentNode) root.appendChild(status);
    document.documentElement.style.margin = "0";
    document.documentElement.style.width = "100%";
    document.documentElement.style.height = "100%";
    document.body.style.margin = "0";
    document.body.style.width = "100%";
    document.body.style.height = "100%";
    document.body.style.overflow = "hidden";
    root.style.cssText += ";display:flex;flex-direction:column;align-items:stretch;min-height:100%;position:relative;background:#0b1020;color:#e5e7eb";
    canvas.style.cssText += ";display:block;width:100%;height:auto;max-width:100%;background:#fff;touch-action:none;outline:none;image-rendering:auto";
    const semanticLayer = document.createElement("div");
    semanticLayer.dataset.pocketSemanticLayer = "true";
    semanticLayer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:20";
    root.appendChild(semanticLayer);
    const semanticNodes = new Map();
    const resources = new Map();
    let resourceEpoch = 0;
    // Browser videos are real HTMLMediaElements used as Canvas sources. The
    // maps retain only bounded intent/retired identities when a DrawOp is
    // culled; the decoder element itself follows native visibility lifetime.
    const videos = new Map();
    const videoIntents = new Map();
    const pendingVideoIntents = new Map();
    const releasedVideoIds = new Set();
    // A release is scoped to the runtime generation that emitted it. Keeping
    // the legacy id-only set for untagged frames preserves older consumers,
    // while tagged HMR cleanup cannot retire a same-id replacement.
    const releasedVideoTokens = new Map();
    const videoScopes = new Set();
    const activeVideoIdentities = new Set();
    const MAX_VIDEO_IDENTITIES = 128;
    let frame = null;
    let stream = null;
    let closed = false;
    let webBluetoothEnabled = (() => {
      try { return new URL(global.location.href).searchParams.get("webBluetooth") === "1"; } catch { return false; }
    })();
    // The editor preview has one Bluetooth implementation: the server-side
    // Noble helper. Keep the legacy query key only so old preview links still
    // open; it can never select a browser Bluetooth adapter.
    let bluetoothProvider = "local";
    const webBluetoothClientId = (() => {
      try {
        const created = global.crypto?.randomUUID?.() || `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        return created;
      } catch {
        return `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      }
    })();
    let connectionGeneration = 0;
    const presentedTokens = new Set();
    let inputTail = Promise.resolve();
    let regionsEnabled = (() => {
      try { return new URL(global.location.href).searchParams.get("regions") === "1"; } catch { return false; }
    })();
    // Only the unsent tail move may be replaced. A queued move from another
    // contact, a terminal edge, or any non-pointer input is a barrier: native
    // must see those records in the browser's original order.
    let pendingMove = null;
    const MAX_POINTER_CONTACTS = 8;
    const pointerContacts = new Map();
    const reservedPointerSlots = new Set();
    let pointerGeneration = 0;
    let wheelContact = null;
    let wheelTimer = 0;
    let wheelTail = null;
    let resizeTimer = 0;
    const embedded = global.parent !== global;
    // Framework InputField sessions are host events, not raw key streams. The
    // browser owns one real editable control for the active session so the
    // platform supplies selection, paste and IME/composition facts. The
    // control is intentionally kept separate from the Canvas projection: the
    // canvas remains the visual shell while this element is the edit surface.
    let activeTextInput = null;
    let textInputElement = null;
    let textInputListenersInstalled = false;
    let suppressTextInputBlur = false;

    function announce(type, payload) {
      // The editor and preview are same-origin.  Never broadcast captures or
      // FrameResults to an arbitrary embedding origin.
      global.parent?.postMessage({ source: SOURCE, version: VERSION, type, projectId, ...payload }, global.location.origin);
    }

    function announceWebBluetoothState(extra = {}) {
      const available = bluetoothProvider === "local";
      announce("preview.plugins-state", {
        webBluetooth: {
          enabled: webBluetoothEnabled,
          provider: bluetoothProvider,
          available,
          secureContext: true,
          ...(available ? {} : { reason: "Noble Bluetooth adapter is unavailable" }),
          ...extra,
        },
      });
    }

    function setWebBluetoothEnabled(enabled, provider = bluetoothProvider) {
      const next = enabled === true;
      // Ignore the legacy provider argument. There is no browser adapter.
      const nextProvider = "local";
      if (next === webBluetoothEnabled && nextProvider === bluetoothProvider) {
        announceWebBluetoothState();
        return;
      }
      const replacingProvider = nextProvider !== bluetoothProvider;
      bluetoothProvider = nextProvider;
      webBluetoothEnabled = next;
      connectionGeneration += 1;
      stream?.close();
      stream = null;
      announceWebBluetoothState();
      if (!closed && (!next || replacingProvider)) {
        const disabled = input({ type: "plugin-disable", clientId: webBluetoothClientId });
        Promise.resolve(disabled).finally(() => { if (!closed) connect(); });
      } else if (!closed) {
        setTimeout(connect, 0);
      }
    }

    function mediaUrl(asset) {
      const base = String(options.basePath || `/api/projects/${encodeURIComponent(projectId)}/preview`).replace(/\/+$/, "");
      return `${base}/media?asset=${encodeURIComponent(asset)}`;
    }

    function scopeForAsset(asset) {
      for (const scope of videoScopes) {
        if (asset.startsWith(`pocket.runtime.${scope}.`)) return scope;
      }
      if (asset.startsWith("pocket.runtime.")) {
        const rest = asset.slice("pocket.runtime.".length);
        const assetMarker = rest.indexOf(".assets/");
        if (assetMarker > 0) return rest.slice(0, assetMarker);
      }
      return asset.startsWith("assets/") ? "" : undefined;
    }

    function assetMatchesScope(asset, scope) {
      return scope === "" ? asset.startsWith("assets/") : asset.startsWith(`pocket.runtime.${scope}.`);
    }

    function scopedVideoId(scope, id) {
      return `${scope}\u0000${id}`;
    }

    function trimVideoIdentityMaps() {
      while (videoIntents.size > MAX_VIDEO_IDENTITIES) {
        const stale = [...videoIntents.keys()].find((key) => !videos.has(key));
        if (stale === undefined) break;
        videoIntents.delete(stale);
      }
      while (pendingVideoIntents.size > MAX_VIDEO_IDENTITIES) {
        pendingVideoIntents.delete(pendingVideoIntents.keys().next().value);
      }
      while (releasedVideoIds.size > MAX_VIDEO_IDENTITIES) {
        const stale = [...releasedVideoIds].find((identity) => !activeVideoIdentities.has(identity));
        if (stale === undefined) break;
        releasedVideoIds.delete(stale);
      }
      while (releasedVideoTokens.size > MAX_VIDEO_IDENTITIES) {
        const stale = [...releasedVideoTokens.keys()].find((identity) => !activeVideoIdentities.has(identity)) ??
          releasedVideoTokens.keys().next().value;
        if (stale === undefined) break;
        releasedVideoTokens.delete(stale);
      }
      while (videoScopes.size > MAX_VIDEO_IDENTITIES) videoScopes.delete(videoScopes.values().next().value);
    }

    function eventPayload(event) {
      const payload = event?.payload ?? event?.params;
      return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    }

    function videoCommandMatches(entry, id, scope, runtimeToken) {
      return entry && entry.id === id && assetMatchesScope(entry.asset, scope) &&
        (!runtimeToken || entry.runtimeToken === runtimeToken);
    }

    function logicalVideoAsset(state) {
      if (!state?.scope) return state?.asset ?? "";
      const prefix = `pocket.runtime.${state.scope}.`;
      return state.asset.startsWith(prefix) ? state.asset.slice(prefix.length) : state.asset;
    }

    function sendVideoState(state, nextState, error) {
      if (closed) return;
      if (!state || state.reportedState === nextState && state.reportedError === String(error ?? "")) return;
      state.reportedState = nextState;
      state.reportedError = String(error ?? "");
      const playing = !state.element.paused && !state.element.ended;
      const payload = {
        id: state.id,
        asset: logicalVideoAsset(state),
        state: nextState,
        playing,
        visible: state.visible === true && !state.disposed,
        active: state.visible === true && !state.disposed,
        controllers: videos.size,
        loading: [...videos.values()].filter((entry) => !entry.disposed && entry.element.readyState < 2).length,
        ...(state.scope ? { runtime: state.scope } : {}),
        ...(state.runtimeToken ? { runtimeToken: state.runtimeToken } : {}),
        ...(error ? { error: String(error) } : {}),
      };
      void input({
        type: "message",
        ...(state.scope ? { runtime: state.scope } : state.runtimeToken ? { runtimeToken: state.runtimeToken } : {}),
        message: { type: "event", name: "video.state", payload },
      });
    }

    function reportVideoFailure(state, phase, error) {
      if (state.disposed || state.errorReported) return;
      state.errorReported = true;
      const detail = String(error?.message || error || "media error");
      status.textContent = `Video ${phase} failed: ${state.asset}`;
      sendVideoState(state, "error", detail);
      announce("preview.error", { error: `video ${phase} failed (${state.id}): ${detail}`, video: { id: state.id, asset: state.asset, phase } });
    }

    function cancelVideoFrameCallback(state) {
      if (state.callbackId === null) return;
      try { state.element.cancelVideoFrameCallback?.(state.callbackId); } catch { /* callback already delivered */ }
      state.callbackId = null;
    }

    function scheduleVideoFrameCallback(state) {
      if (state.disposed || state.callbackId !== null || state.element.paused) return;
      if (typeof state.element.requestVideoFrameCallback !== "function") return;
      state.callbackId = state.element.requestVideoFrameCallback(() => {
        state.callbackId = null;
        if (state.disposed || state.element.paused) return;
        renderCurrentFrame();
        scheduleVideoFrameCallback(state);
      });
    }

    function disposeVideo(state) {
      if (!state || state.disposed) return;
      sendVideoState(state, "disposed");
      state.disposed = true;
      cancelVideoFrameCallback(state);
      try { state.element.pause(); } catch { /* already detached */ }
      for (const [type, listener] of state.listeners) {
        try { state.element.removeEventListener(type, listener); } catch { /* already detached */ }
      }
      state.listeners.length = 0;
      try {
        state.element.removeAttribute("src");
        state.element.load?.();
      } catch { /* best effort resource cancellation */ }
      try { state.element.remove(); } catch { /* test DOM may not implement remove */ }
    }

    function createVideo(op, key, scope) {
      const element = document.createElement("video");
      element.muted = true;
      element.defaultMuted = true;
      element.playsInline = true;
      element.preload = "auto";
      element.loop = true;
      element.controls = false;
      element.setAttribute?.("aria-hidden", "true");
      element.style.cssText = "position:absolute;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none";
      root.appendChild(element);
      const state = {
        key,
        id: String(op.id),
        asset: String(op.asset),
        scope,
        runtimeToken: typeof op.runtimeToken === "string" && op.runtimeToken ? op.runtimeToken : undefined,
        element,
        desired: undefined,
        visible: true,
        disposed: false,
        callbackId: null,
        errorReported: false,
        playRequested: false,
        reportedState: undefined,
        reportedError: "",
        listeners: [],
      };
      const onLoaded = () => {
        if (state.disposed) return;
        sendVideoState(state, "ready");
        renderCurrentFrame();
        if (state.desired === true && state.visible) scheduleVideoFrameCallback(state);
      };
      const onPlaying = () => {
        if (!state.disposed) sendVideoState(state, "playing");
      };
      const onPause = () => {
        if (!state.disposed && state.element.readyState >= 2) sendVideoState(state, "paused");
      };
      const onTimeUpdate = () => {
        if (!state.disposed && !state.element.paused && typeof state.element.requestVideoFrameCallback !== "function") renderCurrentFrame();
      };
      const onError = () => reportVideoFailure(state, "load", state.element.error || "media source unavailable");
      for (const [type, listener] of [
        ["loadeddata", onLoaded], ["canplay", onLoaded], ["playing", onPlaying],
        ["pause", onPause], ["timeupdate", onTimeUpdate], ["error", onError],
      ]) {
        element.addEventListener(type, listener);
        state.listeners.push([type, listener]);
      }
      videos.set(key, state);
      sendVideoState(state, "loading");
      element.src = mediaUrl(state.asset);
      element.load?.();
      return state;
    }

    function applyVideoDesired(state, desired) {
      if (!state || state.disposed) return;
      state.desired = desired === true;
      if (!state.visible || state.desired !== true) {
        state.playRequested = false;
        cancelVideoFrameCallback(state);
        try { state.element.pause(); } catch { /* already paused */ }
        if (state.element.readyState >= 2) sendVideoState(state, "paused");
        return;
      }
      if (state.playRequested) {
        scheduleVideoFrameCallback(state);
        return;
      }
      state.playRequested = true;
      let result;
      try { result = state.element.play(); } catch (error) {
        state.playRequested = false;
        reportVideoFailure(state, "play", error);
        return;
      }
      Promise.resolve(result).then(() => {
        if (state.disposed || state.desired !== true || !state.visible) return;
        sendVideoState(state, "playing");
        scheduleVideoFrameCallback(state);
        renderCurrentFrame();
      }).catch((error) => {
        if (state.disposed || state.desired !== true) return;
        state.playRequested = false;
        reportVideoFailure(state, "play", error);
      });
    }

    function matchingVideoEntries(id, scope, runtimeToken) {
      const entries = [];
      for (const state of videos.values()) if (videoCommandMatches(state, id, scope, runtimeToken)) entries.push(state);
      for (const entry of videoIntents.values()) if (videoCommandMatches(entry, id, scope, runtimeToken) && !entries.some((state) => state.key === entry.key)) entries.push(entry);
      return entries;
    }

    function applyVideoCommand(event) {
      const name = typeof event?.name === "string" ? event.name : typeof event?.method === "string" ? event.method : "";
      if (name !== "video.play" && name !== "video.pause" && name !== "video.release") return;
      const payload = eventPayload(event);
      const id = typeof payload.id === "string" && payload.id ? payload.id : undefined;
      if (!id) return;
      const scope = typeof event.runtime === "string" && event.runtime ? event.runtime : "";
      if (scope) videoScopes.add(scope);
      const identity = scopedVideoId(scope, id);
      const runtimeToken = typeof event.runtimeToken === "string" && event.runtimeToken ? event.runtimeToken : undefined;
      const entries = matchingVideoEntries(id, scope, runtimeToken);
      const allEntries = runtimeToken ? matchingVideoEntries(id, scope) : entries;
      const pending = pendingVideoIntents.get(identity);
      // A late edge from an older generation must not overwrite a live
      // replacement's intent. An old release is still accepted when the old
      // element is present (so it can be disposed), but is ignored once the
      // same-id replacement has taken its token.
      if (runtimeToken && entries.length === 0 &&
        (allEntries.length > 0 || pending?.runtimeToken && pending.runtimeToken !== runtimeToken)) return;
      if (name === "video.release") {
        if (runtimeToken) releasedVideoTokens.set(identity, runtimeToken);
        else releasedVideoIds.add(identity);
        if (!runtimeToken || !pending?.runtimeToken || pending.runtimeToken === runtimeToken) pendingVideoIntents.delete(identity);
        for (const entry of entries) {
          if (videos.get(entry.key) === entry) {
            disposeVideo(entry);
            videos.delete(entry.key);
          }
          videoIntents.delete(entry.key);
        }
        return;
      }
      if (runtimeToken) releasedVideoTokens.delete(identity);
      else releasedVideoIds.delete(identity);
      const desired = name === "video.play";
      pendingVideoIntents.set(identity, { desired, runtimeToken });
      for (const entry of entries) {
        const intent = { key: entry.key, id: entry.id, asset: entry.asset, desired, runtimeToken: entry.runtimeToken ?? runtimeToken };
        videoIntents.set(entry.key, intent);
      }
    }

    function pendingIntentFor(op, scope) {
      const identity = scopedVideoId(scope ?? "", String(op.id));
      const runtimeToken = typeof op.runtimeToken === "string" && op.runtimeToken ? op.runtimeToken : undefined;
      if (scope !== undefined && pendingVideoIntents.has(identity)) {
        const pending = pendingVideoIntents.get(identity);
        if (pending?.runtimeToken && runtimeToken && pending.runtimeToken !== runtimeToken) return undefined;
        pendingVideoIntents.delete(identity);
        return pending?.desired;
      }
      for (const [candidate, pending] of pendingVideoIntents) {
        const separator = candidate.indexOf("\u0000");
        const candidateScope = candidate.slice(0, separator);
        const candidateId = candidate.slice(separator + 1);
        if (candidateId === String(op.id) && assetMatchesScope(String(op.asset), candidateScope) &&
          (!pending?.runtimeToken || !runtimeToken || pending.runtimeToken === runtimeToken)) {
          pendingVideoIntents.delete(candidate);
          return pending?.desired;
        }
      }
      return undefined;
    }

    function syncVideoOps(ops) {
      const seen = new Set();
      activeVideoIdentities.clear();
      for (const op of Array.isArray(ops) ? ops : []) {
        if (!op || typeof op !== "object" || op.type !== "video" || typeof op.id !== "string" || typeof op.asset !== "string" || !op.asset) continue;
        const scope = scopeForAsset(op.asset);
        if (scope !== undefined && scope) videoScopes.add(scope);
        const identity = scope === undefined ? undefined : scopedVideoId(scope, String(op.id));
        if (identity !== undefined) {
          if (activeVideoIdentities.size >= MAX_VIDEO_IDENTITIES && !activeVideoIdentities.has(identity)) continue;
          activeVideoIdentities.add(identity);
        }
        const key = videoKey(op);
        const runtimeToken = typeof op.runtimeToken === "string" && op.runtimeToken ? op.runtimeToken : undefined;
        if (identity !== undefined && (runtimeToken
          ? releasedVideoTokens.get(identity) === runtimeToken
          : releasedVideoIds.has(identity))) continue;
        if (identity !== undefined && runtimeToken && releasedVideoTokens.has(identity)) {
          // A same-id replacement starts a new generation; retire the old
          // generation's release tombstone before installing the new op.
          releasedVideoTokens.delete(identity);
        }
        let state = videos.get(key);
        if (state && runtimeToken && state.runtimeToken && state.runtimeToken !== runtimeToken) {
          disposeVideo(state);
          videos.delete(key);
          state = undefined;
        }
        if (!state) state = createVideo(op, key, scope);
        if (runtimeToken) state.runtimeToken = runtimeToken;
        state.visible = true;
        const prior = videoIntents.get(key);
        const pending = pendingIntentFor(op, scope);
        const priorMatches = !runtimeToken || !prior?.runtimeToken || prior.runtimeToken === runtimeToken;
        const desired = pending ?? (priorMatches ? prior?.desired : undefined) ?? state.desired ?? (op.autoplay !== false);
        const intent = { key, id: String(op.id), asset: String(op.asset), desired, runtimeToken };
        videoIntents.set(key, intent);
        state.desired = desired;
        applyVideoDesired(state, desired);
        seen.add(key);
      }
      for (const [key, state] of [...videos]) {
        if (seen.has(key)) continue;
        const scope = scopeForAsset(state.asset);
        if (scope !== undefined && state.desired !== undefined) {
          pendingVideoIntents.set(scopedVideoId(scope, state.id), {
            desired: state.desired,
            runtimeToken: state.runtimeToken,
          });
        }
        disposeVideo(state);
        videos.delete(key);
      }
      trimVideoIdentityMaps();
    }

    function resetVideoProjection(clearIntent = false) {
      for (const state of videos.values()) disposeVideo(state);
      videos.clear();
      activeVideoIdentities.clear();
      if (clearIntent) {
        videoIntents.clear();
        pendingVideoIntents.clear();
        releasedVideoIds.clear();
        releasedVideoTokens.clear();
        videoScopes.clear();
      }
    }

    async function sendInputPayload(payload) {
      const response = await fetch(`${options.basePath || `/api/projects/${encodeURIComponent(projectId)}/preview`}/input`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pocket-editor": "1" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error((await response.text()) || `preview input failed (${response.status})`);
    }

    function enqueueInput(operation, onFailure, guard, moveKey = null, reportFailure = true) {
      if (moveKey && pendingMove && !pendingMove.sent && pendingMove.key === moveKey) {
        pendingMove.operation = operation;
        pendingMove.onFailure = onFailure;
        pendingMove.guard = guard;
        return inputTail;
      }
      const entry = {
        key: moveKey,
        operation,
        onFailure,
        guard,
        reportFailure,
        sent: false,
      };
      // Any non-move or different-contact operation closes the coalescing
      // window. This keeps DOWN/UP/CANCEL, multi-touch, wheel, text and
      // resize messages as explicit barriers.
      pendingMove = moveKey ? entry : null;
      const queued = inputTail.then(async () => {
        entry.sent = true;
        if (pendingMove === entry) pendingMove = null;
        if (entry.guard && !entry.guard()) return;
        return entry.operation();
      });
      inputTail = queued.catch(async (error) => {
        if (entry.reportFailure) {
          status.textContent = `Input error: ${error.message || error}`;
          announce("preview.error", { error: String(error?.message || error) });
        }
        try { await entry.onFailure?.(error); } catch (callbackError) {
          announce("preview.error", { error: String(callbackError?.message || callbackError) });
        }
      });
      return inputTail;
    }

    function pointerMoveKey(payload) {
      if (!payload || payload.type !== "pointer" || payload.phase !== "move") return null;
      const surface = payload.surface === undefined ? "primary" : String(payload.surface);
      return `${surface}:${String(payload.id)}`;
    }

    function input(payload, onFailure, guard, reportFailure = true) {
      return enqueueInput(() => sendInputPayload(payload), onFailure, guard, pointerMoveKey(payload), reportFailure);
    }

    const MAX_SEMANTIC_CONTROLS = 128;
    const MAX_SEMANTIC_LABEL = 1024;

    function semanticEventPayload(event) {
      const payload = event?.payload ?? event?.params;
      return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
    }

    function semanticRect(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const x = number(value.x, NaN);
      const y = number(value.y, NaN);
      const width = number(value.width ?? value.w, NaN);
      const height = number(value.height ?? value.h, NaN);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
          Math.abs(x) > MAX_DIMENSION || Math.abs(y) > MAX_DIMENSION || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
      return { x, y, width, height };
    }

    function semanticDescriptor(event, control, runtime) {
      if (!control || typeof control !== "object" || Array.isArray(control)) return null;
      const guestId = typeof control.guestId === "string" ? control.guestId : typeof control.id === "string" ? control.id : "";
      const label = typeof control.label === "string" ? control.label.slice(0, MAX_SEMANTIC_LABEL) : null;
      const nativeId = Number(control.nativeId);
      const generation = Number(event.generation);
      const role = control.role === "tab" || control.role === "button" ? control.role : null;
      const rect = semanticRect(control.rect);
      if (!guestId || guestId.length > 256 || label === null || !role || !rect ||
          !Number.isInteger(nativeId) || nativeId < 0 || nativeId > 0x7fffffff ||
          !Number.isInteger(generation) || generation < 0 || generation > 0x7fffffff) return null;
      const runtimeToken = typeof event.runtimeToken === "string" ? event.runtimeToken : "";
      return {
        key: `${runtime}\u0000${guestId}`,
        runtime: runtime === "root" ? "" : runtime,
        runtimeToken,
        generation,
        guestId,
        nativeId,
        label,
        role,
        selected: control.selected === true,
        checked: typeof control.checked === "boolean" ? control.checked : undefined,
        disabled: control.disabled === true || control.enabled === false,
        rect,
      };
    }

    function sendSemanticAction(descriptor) {
      if (!descriptor || descriptor.disabled || closed) return;
      const payload = {
        type: "semantic",
        action: "activate",
        guestId: descriptor.guestId,
        nativeId: descriptor.nativeId,
        generation: descriptor.generation,
        ...(descriptor.runtime ? { runtime: descriptor.runtime } : {}),
        ...(descriptor.runtimeToken ? { runtimeToken: descriptor.runtimeToken } : {}),
      };
      void input(payload);
    }

    function updateSemanticElement(entry) {
      const descriptor = entry.descriptor;
      const element = entry.element;
      element.textContent = descriptor.label;
      element.setAttribute("aria-label", descriptor.label);
      element.setAttribute("role", descriptor.role);
      element.setAttribute("aria-disabled", String(descriptor.disabled));
      element.tabIndex = descriptor.disabled ? -1 : 0;
      element.disabled = descriptor.disabled;
      if (descriptor.role === "tab") {
        element.setAttribute("aria-selected", String(descriptor.selected));
        element.removeAttribute("aria-pressed");
      } else if (descriptor.checked !== undefined) {
        element.setAttribute("aria-pressed", String(descriptor.checked));
        element.removeAttribute("aria-selected");
      } else {
        element.removeAttribute("aria-pressed");
        element.removeAttribute("aria-selected");
      }
      if (descriptor.checked === undefined) element.removeAttribute("aria-checked");
      else element.setAttribute("aria-checked", String(descriptor.checked));
      element.dataset.pocketSemanticGuestId = descriptor.guestId;
      element.dataset.pocketSemanticRuntime = descriptor.runtime || "root";
    }

    function createSemanticElement(descriptor) {
      const element = document.createElement("button");
      element.type = "button";
      element.style.cssText = "position:absolute;box-sizing:border-box;margin:0;padding:0;border:0;background:transparent;color:transparent;font:inherit;line-height:normal;pointer-events:none;outline-offset:2px";
      const entry = { element, descriptor, suppressClick: false };
      element.addEventListener("click", () => {
        if (entry.suppressClick) { entry.suppressClick = false; return; }
        sendSemanticAction(entry.descriptor);
      });
      element.addEventListener("keydown", (event) => {
        if (entry.descriptor.disabled) return;
        if (event.key === "Enter") {
          event.preventDefault();
          entry.suppressClick = true;
          sendSemanticAction(entry.descriptor);
          setTimeout(() => { entry.suppressClick = false; }, 0);
        } else if (event.key === " ") {
          event.preventDefault();
        }
      });
      element.addEventListener("keyup", (event) => {
        if (entry.descriptor.disabled || event.key !== " ") return;
        event.preventDefault();
        entry.suppressClick = true;
        sendSemanticAction(entry.descriptor);
        setTimeout(() => { entry.suppressClick = false; }, 0);
      });
      updateSemanticElement(entry);
      semanticLayer.appendChild(element);
      return entry;
    }

    function layoutSemanticDOM() {
      const canvasRect = canvas.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const width = Math.max(1, logicalWidth());
      const height = Math.max(1, logicalHeight());
      const canvasWidth = Math.max(0, canvasRect.width);
      const canvasHeight = Math.max(0, canvasRect.height);
      const scaleX = canvasWidth / width;
      const scaleY = canvasHeight / height;
      semanticLayer.style.left = `${canvasRect.left - rootRect.left}px`;
      semanticLayer.style.top = `${canvasRect.top - rootRect.top}px`;
      semanticLayer.style.width = `${canvasWidth}px`;
      semanticLayer.style.height = `${canvasHeight}px`;
      for (const entry of semanticNodes.values()) {
        const rect = entry.descriptor.rect;
        entry.element.style.left = `${rect.x * scaleX}px`;
        entry.element.style.top = `${rect.y * scaleY}px`;
        entry.element.style.width = `${Math.max(1, rect.width * scaleX)}px`;
        entry.element.style.height = `${Math.max(1, rect.height * scaleY)}px`;
      }
    }

    function clearSemanticDOM() {
      for (const entry of semanticNodes.values()) {
        try { entry.element.blur?.(); } catch { /* already detached */ }
        entry.element.remove();
      }
      semanticNodes.clear();
      layoutSemanticDOM();
    }

    function reconcileSemanticDOM(events) {
      const next = new Map();
      const seenRuntimes = new Set();
      for (const event of Array.isArray(events) ? events : []) {
        const name = typeof event?.name === "string" ? event.name : typeof event?.method === "string" ? event.method : "";
        if (name !== "accessibility.snapshot") continue;
        const payload = semanticEventPayload(event);
        if (!payload || !Array.isArray(payload.controls)) continue;
        const runtime = typeof payload.runtime === "string" && payload.runtime ? payload.runtime : "root";
        if (seenRuntimes.has(runtime)) continue;
        seenRuntimes.add(runtime);
        const controls = payload.controls.slice(0, MAX_SEMANTIC_CONTROLS);
        const seenControls = new Set();
        for (const control of controls) {
          const descriptor = semanticDescriptor(payload, control, runtime);
          if (!descriptor || seenControls.has(descriptor.guestId)) continue;
          seenControls.add(descriptor.guestId);
          next.set(descriptor.key, descriptor);
        }
      }
      for (const [key, entry] of semanticNodes) {
        if (next.has(key)) continue;
        try { entry.element.blur?.(); } catch { /* already detached */ }
        entry.element.remove();
        semanticNodes.delete(key);
      }
      for (const [key, descriptor] of next) {
        const entry = semanticNodes.get(key) || createSemanticElement(descriptor);
        entry.descriptor = descriptor;
        updateSemanticElement(entry);
        semanticNodes.set(key, entry);
      }
      layoutSemanticDOM();
    }

    // Browser media queries are the only reliable accessibility facts exposed
    // by this projection. Keep the wire deliberately small and explicit: the
    // native host owns OS-only values such as Reduce Transparency, while the
    // guest receives `null` for facts this browser cannot observe. Text scale
    // has no portable browser equivalent, so 1 is the documented baseline;
    // it is not inferred from zoom or device-pixel density.
    function readAccessibilityPreferences() {
      const query = (expression) => {
        try {
          return typeof global.matchMedia === "function" ? global.matchMedia(expression) : null;
        } catch {
          return null;
        }
      };
      return {
        reduceMotion: query("(prefers-reduced-motion: reduce)")?.matches === true,
        increaseContrast: query("(prefers-contrast: more)")?.matches === true,
        textScale: 1,
        accessibleNavigation: false,
        reduceTransparency: null,
      };
    }

    let accessibilityPreferences = readAccessibilityPreferences();
    let accessibilityMediaQueryCleanups = [];
    let accessibilityMediaQueryListenersInstalled = false;

    function sameAccessibilityPreferences(left, right) {
      return left.reduceMotion === right.reduceMotion &&
        left.increaseContrast === right.increaseContrast &&
        left.textScale === right.textScale &&
        left.accessibleNavigation === right.accessibleNavigation &&
        left.reduceTransparency === right.reduceTransparency;
    }

    function publishAccessibilityPreferences() {
      void input({ type: "accessibility", preferences: { ...accessibilityPreferences } });
    }

    function onAccessibilityMediaChange() {
      const next = readAccessibilityPreferences();
      if (sameAccessibilityPreferences(accessibilityPreferences, next)) return;
      accessibilityPreferences = next;
      publishAccessibilityPreferences();
    }

    function installAccessibilityMediaQueryListeners() {
      if (accessibilityMediaQueryListenersInstalled) return;
      accessibilityMediaQueryListenersInstalled = true;
      for (const expression of ["(prefers-reduced-motion: reduce)", "(prefers-contrast: more)"]) {
        let media;
        try { media = typeof global.matchMedia === "function" ? global.matchMedia(expression) : null; } catch { media = null; }
        if (!media) continue;
        const listener = () => onAccessibilityMediaChange();
        if (typeof media.addEventListener === "function") {
          media.addEventListener("change", listener);
          accessibilityMediaQueryCleanups.push(() => media.removeEventListener("change", listener));
        } else if (typeof media.addListener === "function") {
          // Safari versions that predate MediaQueryList.addEventListener.
          media.addListener(listener);
          accessibilityMediaQueryCleanups.push(() => media.removeListener(listener));
        }
      }
    }

    function removeAccessibilityMediaQueryListeners() {
      for (const cleanup of accessibilityMediaQueryCleanups.splice(0)) {
        try { cleanup(); } catch { /* a disposed MediaQueryList is harmless */ }
      }
      accessibilityMediaQueryListenersInstalled = false;
    }

    function textInputPayload(event) {
      const payload = event?.payload ?? event?.params;
      return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
    }

    function textInputEventName(event) {
      return typeof event?.name === "string" ? event.name : typeof event?.method === "string" ? event.method : "";
    }

    function textInputNumber(value, fallback) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    }

    function textInputOffset(value, fallback, length, allowUnset = false) {
      const parsed = textInputNumber(value, fallback);
      if (allowUnset && parsed < 0) return -1;
      return clamp(parsed, 0, length);
    }

    function textInputIdentity(payload) {
      const id = payload && payload.id !== undefined && payload.id !== null ? String(payload.id) : "";
      const editingSession = typeof payload?.editingSession === "string" ? payload.editingSession : "";
      return { id, editingSession };
    }

    function textInputElementStyle(element) {
      element.setAttribute("aria-hidden", "true");
      element.setAttribute("autocomplete", "off");
      element.setAttribute("autocorrect", "off");
      element.setAttribute("autocapitalize", "off");
      element.setAttribute("spellcheck", "false");
      element.setAttribute("wrap", "off");
      element.rows = 1;
      // The DrawOps shell remains the visible control. The real DOM editor
      // stays transparent while retaining a native caret/selection/IME target.
      element.style.cssText = [
        "position:absolute",
        "display:none",
        "box-sizing:border-box",
        "margin:0",
        "padding:0",
        "border:0",
        "outline:0",
        "resize:none",
        "overflow:hidden",
        "background:transparent",
        "color:transparent",
        "caret-color:transparent",
        "z-index:10",
        "font:inherit",
        "line-height:normal",
        "white-space:pre",
      ].join(";");
    }

    function ensureTextInputElement() {
      if (textInputElement) return textInputElement;
      textInputElement = document.createElement("textarea");
      textInputElement.id = "pocket-preview-text-input";
      textInputElement.tabIndex = 0;
      textInputElementStyle(textInputElement);
      root.appendChild(textInputElement);
      textInputListenersInstalled = false;
      return textInputElement;
    }

    function textInputLogicalRect(payload) {
      const rect = payload?.rect;
      if (!rect || typeof rect !== "object" || Array.isArray(rect)) return null;
      const x = number(rect.x, NaN);
      const y = number(rect.y, NaN);
      const width = number(rect.width ?? rect.w, NaN);
      const height = number(rect.height ?? rect.h, NaN);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
      return { x, y, width, height };
    }

    function textInputLayout() {
      const state = activeTextInput;
      const element = textInputElement;
      if (!state || !element) return;
      const rect = textInputLogicalRect(state.params);
      if (!rect) return;
      const canvasRect = canvas.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const width = Math.max(1, logicalWidth());
      const height = Math.max(1, logicalHeight());
      const scaleX = canvasRect.width / width;
      const scaleY = canvasRect.height / height;
      element.style.left = `${canvasRect.left - rootRect.left + rect.x * scaleX}px`;
      element.style.top = `${canvasRect.top - rootRect.top + rect.y * scaleY}px`;
      element.style.width = `${Math.max(1, rect.width * scaleX)}px`;
      element.style.height = `${Math.max(1, rect.height * scaleY)}px`;
      element.style.display = "block";
    }

    function textInputSelection(element) {
      const length = element.value.length;
      const selectionStart = textInputOffset(element.selectionStart, length, length);
      const selectionEnd = textInputOffset(element.selectionEnd, selectionStart, length);
      const composition = activeTextInput?.composition;
      const composingBase = composition ? textInputOffset(composition.start, -1, length, true) : -1;
      const composingExtent = composition ? textInputOffset(composition.end, -1, length, true) : -1;
      return {
        text: element.value,
        selectionBase: selectionStart,
        selectionExtent: Math.max(selectionStart, selectionEnd),
        composingBase,
        composingExtent: Math.max(composingBase, composingExtent),
      };
    }

    function sameTextInputValue(left, right) {
      return !!left && !!right && left.text === right.text &&
        left.selectionBase === right.selectionBase &&
        left.selectionExtent === right.selectionExtent &&
        left.composingBase === right.composingBase &&
        left.composingExtent === right.composingExtent;
    }

    function textInputRoute(state) {
      const route = {};
      if (state?.runtime) route.runtime = state.runtime;
      if (state?.runtimeToken) route.runtimeToken = state.runtimeToken;
      return route;
    }

    function sendTextInputEvent(name, state, value) {
      if (!state || !state.id || !state.editingSession) return Promise.resolve();
      const next = value || textInputSelection(textInputElement);
      // Flutter increments the native revision before every edit/submit/close
      // callback. The guest's editingSession/jsRevision guards rely on the
      // same monotonic edge even though this browser host has no Dart layer.
      state.revision = Math.max(state.revision + 1, 1);
      state.lastSent = { ...next };
      return input({
        type: "message",
        ...textInputRoute(state),
        message: {
          type: "event",
          name,
          payload: {
            id: state.id,
            editingSession: state.editingSession,
            revision: state.revision,
            jsRevision: state.jsRevision,
            source: "native",
            ...next,
          },
        },
      });
    }

    function applyTextInputValue(state, params, force = false) {
      const element = ensureTextInputElement();
      if (!Object.prototype.hasOwnProperty.call(params, "text") &&
        !Object.prototype.hasOwnProperty.call(params, "selectionBase") &&
        !Object.prototype.hasOwnProperty.call(params, "selectionExtent") &&
        !Object.prototype.hasOwnProperty.call(params, "composingBase") &&
        !Object.prototype.hasOwnProperty.call(params, "composingExtent")) return;
      const text = typeof params.text === "string" ? params.text : element.value;
      const selectionStart = textInputOffset(params.selectionBase, text.length, text.length);
      const selectionEnd = textInputOffset(params.selectionExtent, selectionStart, text.length);
      const composingStart = textInputOffset(params.composingBase, -1, text.length, true);
      const composingEnd = textInputOffset(params.composingExtent, -1, text.length, true);
      if (force || element.value !== text) element.value = text;
      try {
        element.setSelectionRange(selectionStart, Math.max(selectionStart, selectionEnd));
      } catch { /* test DOMs may omit selection APIs */ }
      state.composition = composingStart >= 0 && composingEnd >= composingStart
        ? { start: composingStart, end: composingEnd }
        : null;
      state.lastSent = textInputSelection(element);
    }

    function closeTextInputElement(state = activeTextInput) {
      if (!state || activeTextInput !== state) return;
      suppressTextInputBlur = true;
      try { textInputElement?.blur?.(); } catch { /* already detached */ }
      suppressTextInputBlur = false;
      if (textInputElement) textInputElement.style.display = "none";
      try { textInputElement?.remove?.(); } catch { /* test DOM may not implement remove */ }
      textInputElement = null;
      textInputListenersInstalled = false;
      activeTextInput = null;
    }

    function openTextInput(event, params) {
      const identity = textInputIdentity(params);
      if (!identity.id) return;
      const runtime = typeof event?.runtime === "string" ? event.runtime : "";
      const runtimeToken = typeof event?.runtimeToken === "string" ? event.runtimeToken : "";
      if (activeTextInput &&
        (activeTextInput.id !== identity.id ||
          activeTextInput.editingSession !== identity.editingSession ||
          activeTextInput.runtime !== runtime ||
          activeTextInput.runtimeToken !== runtimeToken)) {
        // A new host session replaces the old native editor. Preserve the
        // Flutter close edge for the old guest before dropping its DOM node.
        void sendTextInputEvent("textInput.closed", activeTextInput);
        closeTextInputElement();
      }
      const state = activeTextInput ?? {
        id: identity.id,
        editingSession: identity.editingSession,
        runtime,
        runtimeToken,
        revision: Math.max(0, textInputNumber(params.revision, 0)),
        jsRevision: Math.max(0, textInputNumber(params.jsRevision, 0)),
        params: {},
        composition: null,
        lastSent: null,
      };
      state.id = identity.id;
      state.editingSession = identity.editingSession;
      state.runtime = runtime;
      state.runtimeToken = runtimeToken;
      state.revision = Math.max(state.revision, textInputNumber(params.revision, state.revision));
      state.jsRevision = Math.max(state.jsRevision, textInputNumber(params.jsRevision, state.jsRevision));
      state.params = { ...params };
      activeTextInput = state;
      applyTextInputValue(state, params, true);
      textInputLayout();
      const element = ensureTextInputElement();
      if (!textInputListenersInstalled) installTextInputListeners();
      // Only open/focus claims focus. Frame updates must never steal focus from
      // a user selection or an IME candidate window.
      try { element.focus?.({ preventScroll: true }); } catch { try { element.focus?.(); } catch { /* best effort */ } }
    }

    function updateTextInput(event, params) {
      const identity = textInputIdentity(params);
      const state = activeTextInput;
      if (!state) {
        // A fresh browser/SSE subscriber can receive the guest's next
        // full-value update without having seen the original open edge. A
        // value-bearing update has enough identity and geometry to recover
        // the native editor; a rect-only update must remain non-focusing.
        if (identity.id && identity.editingSession && textInputLogicalRect(params) && typeof params.text === "string") {
          openTextInput(event, params);
        }
        return;
      }
      if (!identity.id || state.id !== identity.id ||
        (identity.editingSession && state.editingSession !== identity.editingSession) ||
        (typeof event?.runtime === "string" && event.runtime !== state.runtime) ||
        (typeof event?.runtimeToken === "string" && event.runtimeToken !== state.runtimeToken)) return;
      const incomingRevision = textInputNumber(params.revision, state.revision);
      const incomingJsRevision = textInputNumber(params.jsRevision, state.jsRevision);
      const isJsCommand = params.force === true && params.source === "js" || params.source === "programmatic";
      const hasValue = ["text", "selectionBase", "selectionExtent", "composingBase", "composingExtent"]
        .some((key) => Object.prototype.hasOwnProperty.call(params, key));
      const staleNativeValue = hasValue && incomingRevision < state.revision && !isJsCommand;
      const staleJsValue = hasValue && incomingJsRevision < state.jsRevision;
      state.revision = Math.max(state.revision, incomingRevision);
      if (incomingJsRevision >= state.jsRevision) state.jsRevision = incomingJsRevision;
      state.params = { ...state.params, ...params };
      // Rect-only updates deliberately leave value, selection and composing
      // untouched. A stale native echo may still move/style the overlay, but
      // only a current forced JS command may replace browser edit facts.
      if (hasValue && !staleNativeValue && !staleJsValue) {
        applyTextInputValue(state, params, isJsCommand || typeof params.text === "string");
      }
      textInputLayout();
    }

    function handleTextInputEvent(event) {
      const name = textInputEventName(event);
      if (name !== "textInput.open" && name !== "textInput.update" && name !== "textInput.close") return;
      const params = textInputPayload(event);
      if (!params) return;
      if (name === "textInput.open") openTextInput(event, params);
      else if (name === "textInput.update") updateTextInput(event, params);
      else {
        const identity = textInputIdentity(params);
        const state = activeTextInput;
        if (state && identity.id === state.id &&
          (!identity.editingSession || identity.editingSession === state.editingSession) &&
          (!event.runtime || event.runtime === state.runtime) &&
          (!event.runtimeToken || event.runtimeToken === state.runtimeToken)) {
          closeTextInputElement(state);
        }
      }
    }

    function sendTextInputEdit() {
      const state = activeTextInput;
      const element = textInputElement;
      if (!state || !element) return;
      const value = textInputSelection(element);
      if (sameTextInputValue(state.lastSent, value)) return;
      void sendTextInputEvent("textInput.edit", state, value);
    }

    function submitTextInput() {
      const state = activeTextInput;
      const element = textInputElement;
      if (!state || !element) return;
      const value = textInputSelection(element);
      void sendTextInputEvent("textInput.submit", state, {
        ...value,
        action: typeof state.params.action === "string" ? state.params.action : "done",
      });
      closeTextInputElement(state);
    }

    function dismissTextInput() {
      const state = activeTextInput;
      const element = textInputElement;
      if (!state || !element) return;
      void sendTextInputEvent("textInput.closed", state);
      closeTextInputElement(state);
    }

    function installTextInputListeners() {
      if (textInputListenersInstalled) return;
      const element = ensureTextInputElement();
      element.addEventListener("input", () => {
        if (!activeTextInput) return;
        sendTextInputEdit();
      });
      element.addEventListener("compositionstart", (event) => {
        if (!activeTextInput) return;
        const text = String(event.data || "");
        const end = textInputOffset(element.selectionEnd, element.value.length, element.value.length);
        const start = Math.max(0, end - text.length);
        activeTextInput.composition = { start, end };
        sendTextInputEdit();
      });
      element.addEventListener("compositionupdate", (event) => {
        if (!activeTextInput) return;
        const text = String(event.data || "");
        const end = textInputOffset(element.selectionEnd, element.value.length, element.value.length);
        const start = Math.max(0, end - text.length);
        activeTextInput.composition = { start, end };
        sendTextInputEdit();
      });
      element.addEventListener("compositionend", () => {
        if (!activeTextInput) return;
        activeTextInput.composition = null;
        sendTextInputEdit();
      });
      element.addEventListener("select", sendTextInputEdit);
      element.addEventListener("keyup", (event) => {
        if (!activeTextInput) return;
        if (event.key === "Enter") return;
        sendTextInputEdit();
      });
      element.addEventListener("keydown", (event) => {
        if (!activeTextInput) return;
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          submitTextInput();
        } else if (event.key === "Escape") {
          event.preventDefault();
          dismissTextInput();
        }
      });
      element.addEventListener("blur", () => {
        if (!suppressTextInputBlur && activeTextInput) dismissTextInput();
      });
      textInputListenersInstalled = true;
    }

    installTextInputListeners();

    function nextPointerSlot() {
      for (let slot = 0; slot < MAX_POINTER_CONTACTS; slot += 1) {
        if (!reservedPointerSlots.has(slot)) {
          reservedPointerSlots.add(slot);
          return slot;
        }
      }
      return null;
    }

    function releasePointerCapture(pointerId) {
      try { canvas.releasePointerCapture?.(pointerId); } catch { /* already released */ }
    }

    function retireContact(pointerId, contact) {
      if (pointerContacts.get(pointerId) !== contact) return;
      pointerContacts.delete(pointerId);
      reservedPointerSlots.delete(contact.id);
      releasePointerCapture(pointerId);
    }

    async function cancelFailedContact(contact) {
      contact.failed = true;
      if (contact.generation !== pointerGeneration) return;
      // The request may have reached native even when its HTTP response was
      // lost. Cancel before the input queue admits another DOWN using this
      // slot; enqueueing this cleanup behind later inputs would be too late.
      try {
        await sendInputPayload({ type: "pointer", phase: "cancel", id: contact.id, x: contact.x ?? 0, y: contact.y ?? 0 });
      } catch { /* Original input error is already reported; a later DOWN also recovers stale native contact. */ }
    }

    async function failContact(pointerId, contact) {
      await cancelFailedContact(contact);
      retireContact(pointerId, contact);
    }

    function cancelPointerContacts() {
      finishWheel();
      for (const [pointerId, contact] of [...pointerContacts]) {
        input({ type: "pointer", phase: "cancel", id: contact.id, x: contact.x ?? 0, y: contact.y ?? 0 },
          () => failContact(pointerId, contact), contactGuard(contact));
        retireContact(pointerId, contact);
      }
    }

    function cancelPointerContactsAfterStreamLoss() {
      const contacts = [...pointerContacts.values()];
      if (wheelContact) contacts.push(wheelContact);
      // Invalidate queued MOVE/UP records before queuing cleanup. Cleanup
      // CANCELs are unconditional barriers, so a disconnected stream cannot
      // replay an old gesture after the next SSE connection opens.
      resetPointerContacts();
      for (const contact of contacts) {
        input({ type: "pointer", phase: "cancel", id: contact.id, x: contact.x ?? 0, y: contact.y ?? 0 }, undefined, undefined, false);
      }
    }

    function resetPointerContacts() {
      pointerGeneration += 1;
      for (const [pointerId, contact] of pointerContacts) {
        contact.failed = true;
        reservedPointerSlots.delete(contact.id);
        releasePointerCapture(pointerId);
      }
      pointerContacts.clear();
      clearTimeout(wheelTimer);
      wheelTimer = 0;
      wheelTail = null;
      if (wheelContact) wheelContact.failed = true;
      wheelContact = null;
      // Discard reservations from the previous runtime generation.
      reservedPointerSlots.clear();
    }

    function resize() {
      // The Editor parent owns the logical viewport for an embedded preview.
      // Its CSS box can be a scaled device frame (for example 288×623 while
      // the selected logical device is 375×812), so observing it here would
      // silently replace the requested runtime dimensions.
      if (embedded) return;
      const rect = canvas.getBoundingClientRect();
      const width = clamp(Math.round(rect.width || options.width || 375), 1, MAX_DIMENSION);
      const ratio = frame && frame.width > 0 ? frame.height / frame.width : 812 / 375;
      const height = clamp(Math.round((options.height || width * ratio)), 1, MAX_DIMENSION);
      if (frame && (frame.width !== width || frame.height !== height)) {
        finishWheel();
        void input({ type: "resize", width, height, safeArea: safeArea(null) });
      }
    }

    function installFrame(next) {
      // A fresh probe/runtime starts its frame counter over. Any browser
      // contact captured by the previous generation is no longer known to
      // native input, so discard it before accepting new moves.
      if (frame && Number(next.frame) < Number(frame.frame)) {
        resetPointerContacts();
        resetVideoProjection(true);
        closeTextInputElement();
        clearSemanticDOM();
      }
      frame = next;
      for (const resource of Array.isArray(next.resources) ? next.resources : []) {
        if (!resource || typeof resource !== "object") continue;
        const asset = String(resource.asset ?? "");
        if (!asset) continue;
        const decoded = decodeResource(resource);
        disposeResource(resources.get(asset));
        if (decoded) resources.set(asset, decoded);
        else resources.delete(asset);
        resourceEpoch += 1;
      }
      for (const asset of Array.isArray(next.releasedResources) ? next.releasedResources : []) {
        if (typeof asset === "string") {
          disposeResource(resources.get(asset));
          resources.delete(asset);
          resourceEpoch += 1;
        }
      }
      for (const event of Array.isArray(next.events) ? next.events : []) applyVideoCommand(event);
      syncVideoOps(next.ops);
      renderCurrentFrame();
      reconcileSemanticDOM(next.events);
      // The compositor exposes a child input rectangle only while a child
      // surface owns focus. Do not leave a root editor targeting SystemUI (or
      // a child editor targeting a vanished surface) active across that focus
      // hand-off; the guest receives the same close edge as Flutter's host.
      const childFocused = !!next.inputBounds;
      if (activeTextInput && (!!activeTextInput.runtime !== childFocused)) {
        void sendTextInputEvent("textInput.closed", activeTextInput);
        closeTextInputElement();
      }
      for (const event of Array.isArray(next.events) ? next.events : []) {
        // A composite frame may retain the previous runtime's lifecycle edge
        // beside the newly focused surface. Only the focused runtime may
        // claim the one browser editor for this frame.
        const name = textInputEventName(event);
        if (name === "textInput.open" || name === "textInput.update" || name === "textInput.close") {
          const eventRuntime = typeof event?.runtime === "string" ? event.runtime : "";
          if (childFocused !== Boolean(eventRuntime)) continue;
        }
        handleTextInputEvent(event);
      }
      textInputLayout();
      const tokens = (Array.isArray(next.presentationTokens) ? next.presentationTokens : [])
        .filter(token => typeof token === "string" && !presentedTokens.has(token));
      if (tokens.length) {
        for (const token of tokens) presentedTokens.add(token);
        // Resource decode and Canvas projection above are synchronous. Two
        // animation frames give the prepared bottom edge a real paint before
        // JS launch admission starts the entry animation.
        global.requestAnimationFrame(() => global.requestAnimationFrame(() => {
          if (closed) return;
          void input({ type: "presented", tokens }, () => {
            for (const token of tokens) presentedTokens.delete(token);
            // A failed ACK must not strand launch admission. Reconnect to
            // replay the real prepared frame and retry its presentation.
            stream?.close();
            setTimeout(() => { if (!closed) connect(); }, 250);
          });
        }));
      }
      status.textContent = `PocketJS native preview · frame ${next.frame} · ${next.width}×${next.height} · full FrameResult transport`;
      announce("preview.frame", { frame: frameNotification(next) });
      const requests = Array.isArray(next.events) ? next.events.filter((event) => event && event.name === "host.request") : [];
      const unsupportedOps = Array.isArray(next.ops)
        ? next.ops.filter((op) => op && op.type === "hostSurface" && !surfaceDescriptor(op))
        : [];
      if (requests.length) {
        status.textContent = `PocketJS preview · ${requests.length} host request(s) pending`;
        announce("preview.host-request", { requests });
        // No host capability is silently treated as successful.  The parent
        // may answer with a real adapter, or surface this structured pending
        // capability to the user; the preview never invents plugin values.
        const unsupported = requests.filter((event) => {
          const capability = event?.payload?.capability;
          if (webBluetoothEnabled && bluetoothProvider === "local" && (typeof capability === "string" && capability.startsWith("hardware.bluetooth.") || capability === "hardware.permissions.request" && event.payload?.params?.permission === "hardware.bluetooth")) return false;
          return typeof capability !== "string" || !capability.startsWith("platform.systemUi.");
        });
        if (unsupported.length) {
          announce("preview.unsupported", {
            capabilities: ["native hardware/plugins"],
            requests: unsupported,
            reason: "No browser host adapter is registered; no host.response was synthesized.",
          });
        }
      } else if (unsupportedOps.length) {
        status.textContent = `PocketJS preview · ${unsupportedOps.length} native surface op(s) unavailable in browser`;
        announce("preview.unsupported", { capabilities: ["hostSurface"], count: unsupportedOps.length });
      }
      resize();
    }

    // FrameResult and input remain in logical pixels. Only the browser's
    // raster target follows the display density, including screen/zoom changes.
    // Do not snap arbitrary DrawOps or infer rounded controls here: Mini App
    // layout must use its host slot's native viewport (preview.ts). Enlarging
    // the backing store improves sharpness but cannot fix a wrong viewport.
    // Cause, ablation and regression coverage: sdk/docs/EDITOR_PREVIEW_RENDERING.md.
    function logicalWidth() { return Math.max(1, Math.round(number(frame?.width, options.width || 375))); }
    function logicalHeight() { return Math.max(1, Math.round(number(frame?.height, options.height || 812))); }

    function renderCurrentFrame() {
      if (!frame) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const width = logicalWidth();
      const height = logicalHeight();
      // Use one integer supersampling factor for both axes. A fractional
      // browser DPR (normally produced by page zoom) makes independently
      // rounded backing dimensions differ in scale, so adjacent native fill
      // strips can land on different coverage rows and expose a dark seam.
      // Render the complete logical frame at the next integer density and
      // let the browser downsample one finished raster instead of snapping
      // arbitrary DrawOps or treating each tile as a separate component.
      const density = Math.max(1, Math.ceil(number(global.devicePixelRatio, 1)));
      const backingWidth = Math.min(MAX_DIMENSION, Math.max(1, Math.round(width * density)));
      const backingHeight = Math.min(MAX_DIMENSION, Math.max(1, Math.round(height * density)));
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      // Explicit logical aspect avoids rounded backing pixels changing CSS size.
      canvas.style.aspectRatio = `${width} / ${height}`;
      context.setTransform(backingWidth / width, 0, 0, backingHeight / height, 0, 0);
      drawFrame(context, frame, resources, videos, resourceEpoch);
      if (regionsEnabled) drawRegionOverlay(context, frame);
      layoutSemanticDOM();
    }

    function connect() {
      const generation = ++connectionGeneration;
      const endpoint = `${options.basePath || `/api/projects/${encodeURIComponent(projectId)}/preview`}/stream`;
      const params = new URLSearchParams({ presentation: "browser", resources: "base64", clientId: webBluetoothClientId });
      if (webBluetoothEnabled) { params.set("webBluetooth", "1"); params.set("bluetoothProvider", bluetoothProvider); }
      const current = previewStream(`${endpoint}?${params.toString()}`, root.dataset.streamWorker === "true");
      stream = current;
      current.onopen = () => {
        if (generation !== connectionGeneration || stream !== current || closed) return;
        installAccessibilityMediaQueryListeners();
        // Replay the current snapshot after every stream connection. The
        // server caches it for guests that mount after this page connects.
        publishAccessibilityPreferences();
      };
      current.onmessage = (event) => {
        if (generation !== connectionGeneration || stream !== current || closed) return;
        try {
          const packet = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
          if (packet.type === "frame") installFrame(packet.frame);
          else if (packet.type === "status") {
            const state = packet.status?.state;
            if (state === "error") cancelPointerContacts();
            else if (state === "starting" || state === "stopped") resetPointerContacts();
            status.textContent = `PocketJS preview · ${packet.status.state}`;
            announce("preview.status", { status: packet.status });
          } else if (packet.type === "error") {
            cancelPointerContacts();
            status.textContent = `Preview error: ${packet.error}`;
            announce("preview.error", { error: packet.error });
          }
        } catch (error) {
          status.textContent = `Preview stream error: ${error.message || error}`;
          announce("preview.error", { error: String(error?.message || error) });
        }
      };
      current.onerror = () => {
        if (generation !== connectionGeneration || stream !== current || closed) return;
        cancelPointerContactsAfterStreamLoss();
        if (current.readyState === global.EventSource.CLOSED || current.readyState === 2) {
          status.textContent = "PocketJS preview stream closed";
          announce("preview.error", { error: "preview stream closed" });
          return;
        }
        status.textContent = "PocketJS preview stream reconnecting…";
        announce("preview.status", { status: { state: "reconnecting" } });
      };
    }

    function logicalPoint(event) {
      return pointerCoordinates(event).point;
    }

    function pointerCoordinates(event) {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const rawX = (event.clientX - rect.left) * (logicalWidth() / width);
      const rawY = (event.clientY - rect.top) * (logicalHeight() / height);
      return {
        point: {
          x: clamp(rawX, 0, logicalWidth()),
          y: clamp(rawY, 0, logicalHeight()),
        },
        outside: rawX < 0 || rawX > logicalWidth() || rawY < 0 || rawY > logicalHeight(),
      };
    }

    function contactGuard(contact) {
      return () => !contact.failed && contact.generation === pointerGeneration;
    }

    function queuePointer(pointerId, contact, phase, event, outsidePhase) {
      const { point, outside } = pointerCoordinates(event);
      contact.x = point.x;
      contact.y = point.y;
      const sentPhase = outside && outsidePhase ? outsidePhase : phase;
      const payload = { type: "pointer", phase: sentPhase, id: contact.id, x: point.x, y: point.y };
      input(payload, () => failContact(pointerId, contact), contactGuard(contact));
      if (sentPhase === "up" || sentPhase === "cancel") retireContact(pointerId, contact);
    }

    canvas.addEventListener("pointerdown", (event) => {
      if (closed) return;
      finishWheel();
      canvas.focus();
      const pointerId = Number(event.pointerId);
      if (!Number.isFinite(pointerId) || pointerContacts.has(pointerId)) return;
      const id = nextPointerSlot();
      if (id === null) return; // Native accepts at most eight active contacts.
      const contact = { id, generation: pointerGeneration };
      pointerContacts.set(pointerId, contact);
      try { canvas.setPointerCapture?.(pointerId); } catch { /* synthetic event or capture already lost */ }
      queuePointer(pointerId, contact, "down", event);
    });
    canvas.addEventListener("pointermove", (event) => {
      const pointerId = Number(event.pointerId);
      const contact = pointerContacts.get(pointerId);
      if (!contact) return; // Ignore hover/trackpad moves with no native DOWN.
      queuePointer(pointerId, contact, "move", event, "cancel");
    });
    const endPointer = (event, phase) => {
      const pointerId = Number(event.pointerId);
      const contact = pointerContacts.get(pointerId);
      if (!contact) return;
      queuePointer(pointerId, contact, phase, event, phase === "up" ? "cancel" : undefined);
    };
    canvas.addEventListener("pointerup", (event) => endPointer(event, "up"));
    canvas.addEventListener("pointercancel", (event) => endPointer(event, "cancel"));
    canvas.addEventListener("lostpointercapture", (event) => endPointer(event, "cancel"));
    canvas.addEventListener("keydown", (event) => {
      // A real textarea owns all framework text input while it is open. The
      // canvas path remains the raw GuestFrame input.text compatibility lane.
      if (activeTextInput) return;
      void input({ type: "text", events: [{ kind: "keyDown", key: event.key, repeat: event.repeat }] });
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        void input({ type: "text", events: [{ kind: "commit", text: event.key }] });
      }
      if (["Backspace", "Delete", "Enter", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault();
    });
    canvas.addEventListener("keyup", (event) => {
      if (activeTextInput) return;
      void input({ type: "text", events: [{ kind: "keyUp", key: event.key, repeat: false }] });
    });
    canvas.addEventListener("compositionstart", (event) => {
      if (activeTextInput) return;
      const text = String(event.data || "");
      void input({ type: "text", events: [{ kind: "composition", text, selectionStart: 0, selectionEnd: text.length }] });
    });
    canvas.addEventListener("compositionupdate", (event) => {
      if (activeTextInput) return;
      const text = String(event.data || "");
      void input({ type: "text", events: [{ kind: "composition", text, selectionStart: 0, selectionEnd: text.length }] });
    });
    canvas.addEventListener("compositionend", (event) => {
      if (activeTextInput) return;
      const text = String(event.data || "");
      const events = [{ kind: "compositionEnd" }];
      if (text) events.push({ kind: "commit", text });
      void input({ type: "text", events });
    });
    function queueWheel(contact, phase) {
      return input({ type: "pointer", phase, id: contact.id, x: contact.x, y: contact.y }, async () => {
        await cancelFailedContact(contact);
        if (wheelContact === contact) {
          clearTimeout(wheelTimer);
          wheelTimer = 0;
          wheelContact = null;
        }
        if (contact.generation === pointerGeneration) reservedPointerSlots.delete(contact.id);
      }, contactGuard(contact));
    }

    function finishWheel(suppressTail = false) {
      clearTimeout(wheelTimer);
      wheelTimer = 0;
      const contact = wheelContact;
      if (!contact) return;
      wheelContact = null;
      if (suppressTail && contact.lastSign !== 0) {
        wheelTail = {
          axis: contact.axis,
          sign: contact.lastSign,
          lastAbs: contact.lastAbs,
          expiresAt: Date.now() + 96,
        };
      } else {
        wheelTail = null;
      }
      // macOS already sends the momentum tail as wheel deltas. CANCEL uses
      // the guest's endDrag(0): retain its edge spring, without another fling.
      void queueWheel(contact, "cancel").then(() => {
        if (contact.generation === pointerGeneration) reservedPointerSlots.delete(contact.id);
      });
    }

    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      if (closed) return;
      const rect = canvas.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      let dx = clamp(number(event.deltaX, 0) * unit * logicalWidth() / Math.max(1, rect.width), -MAX_DIMENSION, MAX_DIMENSION);
      let dy = clamp(number(event.deltaY, 0) * unit * logicalHeight() / Math.max(1, rect.height), -MAX_DIMENSION, MAX_DIMENSION);
      if (!dx && !dy) return;
      const dominantAxis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
      const activeAxis = wheelContact ? wheelContact.axis : dominantAxis;
      if (activeAxis === "y") dx = 0;
      else dy = 0;
      const primaryDelta = activeAxis === "y" ? dy : dx;
      const absDelta = Math.abs(primaryDelta);
      const sign = primaryDelta > 0 ? 1 : primaryDelta < 0 ? -1 : 0;
      if (!absDelta) return;

      const now = Date.now();
      if (!wheelContact && wheelTail) {
        if (
          now < wheelTail.expiresAt &&
          dominantAxis === wheelTail.axis &&
          sign === wheelTail.sign &&
          absDelta <= wheelTail.lastAbs * 1.15 + 0.5
        ) {
          wheelTail.lastAbs = Math.min(wheelTail.lastAbs, absDelta);
          wheelTail.expiresAt = now + 96;
          return;
        }
        wheelTail = null;
      }

      if (!wheelContact) {
        // Ignore isolated sub-pixel trackpad noise before opening a contact.
        if (absDelta < 0.5) return;
        const id = nextPointerSlot();
        if (id === null) return;
        const point = logicalPoint(event);
        // The compositor reports its focused child's native surface bounds;
        // its pointer transform clamps there, before the root canvas edge.
        const area = frame?.inputBounds;
        const inChild = area && point.x >= area.x && point.x <= area.x + area.w &&
          point.y >= area.y && point.y <= area.y + area.h;
        const minX = Math.round(inChild ? Math.max(0, area.x) : 0);
        const minY = Math.round(inChild ? Math.max(0, area.y) : 0);
        const maxX = Math.round(Math.min(logicalWidth(), 1023, inChild ? area.x + area.w : Infinity));
        const maxY = Math.round(Math.min(logicalHeight(), 1023, inChild ? area.y + area.h : Infinity));
        const midX = Math.round((minX + maxX) / 2);
        const midY = Math.round((minY + maxY) / 2);
        const startX = Math.round(clamp(point.x, minX, maxX));
        const startY = Math.round(clamp(point.y, minY, maxY));
        const anchor = {
          x: dominantAxis === "x" && ((dx > 0 && startX - minX < 32) || (dx < 0 && maxX - startX < 32)) ? midX : startX,
          y: dominantAxis === "y" && ((dy > 0 && startY - minY < 32) || (dy < 0 && maxY - startY < 32)) ? midY : startY,
        };
        wheelContact = {
          id,
          generation: pointerGeneration,
          axis: dominantAxis,
          ...anchor,
          anchor,
          minX,
          minY,
          maxX,
          maxY,
          midX,
          midY,
          remX: 0,
          remY: 0,
          lastSign: sign,
          lastAbs: absDelta,
          decaySteps: 0,
          reanchors: 0,
          moved: false,
        };
        void queueWheel(wheelContact, "down");
      } else {
        if (sign !== wheelContact.lastSign) {
          wheelContact.decaySteps = 0;
        } else if (absDelta < wheelContact.lastAbs * 0.98) {
          wheelContact.decaySteps += 1;
        } else if (absDelta > wheelContact.lastAbs * 1.15 + 0.5) {
          wheelContact.decaySteps = 0;
        }
        wheelContact.lastSign = sign;
        wheelContact.lastAbs = absDelta;
        // Once macOS enters its passive momentum decay tail and deltas drop to
        // sub-pixel noise, release the contact so the guest's edge spring or
        // rest state can settle immediately instead of jittering on 1px steps.
        if (wheelContact.decaySteps >= 4 && absDelta < 1.5) {
          finishWheel(true);
          return;
        }
      }

      // Native's canonical touch wire is bounded by the viewport and 10 bits.
      // Keep one contact across the burst; only re-anchor when that wire runs
      // out of room. Preserve the remaining delta rather than clipping it away.
      const contact = wheelContact;
      const { anchor, minX, minY, maxX, maxY, midX, midY } = contact;
      contact.remX = clamp(contact.remX + dx, -MAX_DIMENSION, MAX_DIMENSION);
      contact.remY = clamp(contact.remY + dy, -MAX_DIMENSION, MAX_DIMENSION);
      let stepX = Math.trunc(contact.remX);
      let stepY = Math.trunc(contact.remY);
      contact.remX -= stepX;
      contact.remY -= stepY;
      let emittedMove = false;

      while (stepX !== 0 || stepY !== 0) {
        const availX = stepX > 0 ? contact.x - minX : stepX < 0 ? maxX - contact.x : Infinity;
        const availY = stepY > 0 ? contact.y - minY : stepY < 0 ? maxY - contact.y : Infinity;
        const moveX = stepX > 0 ? Math.min(stepX, availX) : stepX < 0 ? -Math.min(-stepX, availX) : 0;
        const moveY = stepY > 0 ? Math.min(stepY, availY) : stepY < 0 ? -Math.min(-stepY, availY) : 0;
        if (moveX !== 0 || moveY !== 0) {
          contact.x = clamp(contact.x - moveX, minX, maxX);
          contact.y = clamp(contact.y - moveY, minY, maxY);
          contact.moved = true;
          emittedMove = true;
          stepX -= moveX;
          stepY -= moveY;
          void queueWheel(contact, "move");
        }
        if (stepX === 0 && stepY === 0) break;
        // During macOS's passive momentum decay, hitting the viewport edge
        // after an active swipe should release the contact rather than
        // repeatedly re-anchoring and holding overscroll open for seconds.
        if (contact.decaySteps >= 3 || (contact.reanchors >= 1 && contact.decaySteps >= 1)) {
          finishWheel(true);
          return;
        }
        // Keep a 1px remainder buffered so a re-anchor DOWN is always followed
        // by at least a 2px MOVE that crosses ScrollablePage's panSlop=1.
        if (Math.abs(stepX) < 2 && Math.abs(stepY) < 2) {
          contact.remX += stepX;
          contact.remY += stepY;
          break;
        }
        const reanchorX = stepX > 0 ? Math.max(anchor.x, midX) : stepX < 0 ? Math.min(anchor.x, midX) : anchor.x;
        const reanchorY = stepY > 0 ? Math.max(anchor.y, midY) : stepY < 0 ? Math.min(anchor.y, midY) : anchor.y;
        if ((stepX > 0 && reanchorX <= minX) || (stepX < 0 && reanchorX >= maxX)) stepX = 0;
        if ((stepY > 0 && reanchorY <= minY) || (stepY < 0 && reanchorY >= maxY)) stepY = 0;
        if (stepX === 0 && stepY === 0) break;
        contact.reanchors += 1;
        void queueWheel(contact, "cancel");
        contact.x = reanchorX;
        contact.y = reanchorY;
        void queueWheel(contact, "down");
      }

      if (emittedMove || !contact.moved) {
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(finishWheel, 80);
      }
    }, { passive: false });
    global.addEventListener("blur", cancelPointerContacts);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) finishWheel();
    });

    global.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.source !== PARENT_SOURCE || event.source !== global.parent || event.origin !== global.location.origin) return;
      if (message.type === "preview.resize") {
        finishWheel();
        const width = clamp(Math.round(number(message.width, logicalWidth())), 1, MAX_DIMENSION);
        const height = clamp(Math.round(number(message.height, logicalHeight())), 1, MAX_DIMENSION);
        // Missing insets deliberately mean zero. This prevents a prior phone
        // profile's notch/home-indicator padding from leaking into tablet or
        // desktop selections.
        void input({ type: "resize", width, height, safeArea: safeArea(message.safeArea) });
      } else if (message.type === "preview.regions") {
        const enabled = message.enabled === true;
        if (regionsEnabled !== enabled) {
          regionsEnabled = enabled;
          renderCurrentFrame();
        }
      } else if (message.type === "preview.capture") {
        const scale = clamp(Math.round(number(message.scale, 1)), 1, 4);
        let captureCanvas = canvas;
        if (scale !== 1) {
          captureCanvas = document.createElement("canvas");
          captureCanvas.width = canvas.width * scale;
          captureCanvas.height = canvas.height * scale;
          const captureContext = captureCanvas.getContext("2d");
          captureContext.imageSmoothingEnabled = false;
          captureContext.drawImage(canvas, 0, 0, captureCanvas.width, captureCanvas.height);
        }
        const dataUrl = captureCanvas.toDataURL("image/png", 1);
        announce("preview.capture.result", {
          requestId: message.requestId ?? null,
          dataUrl,
          width: captureCanvas.width,
          height: captureCanvas.height,
          logicalWidth: frame?.width ?? logicalWidth(),
          logicalHeight: frame?.height ?? logicalHeight(),
        });
      } else if (message.type === "preview.annotation") {
        const rect = message.rect || {};
        const space = message.space === "css" ? "css" : "logical";
        const logical = space === "logical" ? {
          x: number(rect.x, 0), y: number(rect.y, 0), width: number(rect.width, 0), height: number(rect.height, 0),
        } : {
          x: number(rect.x, 0) * (logicalWidth() / Math.max(1, canvas.getBoundingClientRect().width)),
          y: number(rect.y, 0) * (logicalHeight() / Math.max(1, canvas.getBoundingClientRect().height)),
          width: number(rect.width, 0) * (logicalWidth() / Math.max(1, canvas.getBoundingClientRect().width)),
          height: number(rect.height, 0) * (logicalHeight() / Math.max(1, canvas.getBoundingClientRect().height)),
        };
        announce("preview.annotation", { requestId: message.requestId ?? null, rect: logical, space: "logical" });
      } else if (message.type === "preview.host-response") {
        // The parent may provide a real local host adapter for declared
        // capabilities. This path forwards its canonical response unchanged;
        // the preview never invents a successful plugin result.
        void input({ type: "message", message: message.message });
      } else if (message.type === "preview.plugins" && Object.prototype.hasOwnProperty.call(message, "webBluetooth")) {
        setWebBluetoothEnabled(message.webBluetooth === true, message.bluetoothProvider);
      }
    });

    let densityQuery = null;
    function watchDensity() {
      densityQuery?.removeEventListener("change", onDensityChange);
      densityQuery = global.matchMedia?.(`(resolution: ${number(global.devicePixelRatio, 1)}dppx)`);
      densityQuery?.addEventListener("change", onDensityChange);
    }
    function onDensityChange() {
      renderCurrentFrame();
      textInputLayout();
      watchDensity();
    }
    watchDensity();
    const onPreviewResize = () => {
      renderCurrentFrame();
      textInputLayout();
      layoutSemanticDOM();
    };
    global.addEventListener("resize", onPreviewResize);

    if (!embedded && typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 50);
        textInputLayout();
        layoutSemanticDOM();
      });
      observer.observe(canvas);
    }
    announce("preview.ready", { width: logicalWidth(), height: logicalHeight(), transport: "native-probe-full-frames" });
    announceWebBluetoothState();
    connect();
    return { canvas, input, close: async () => {
      closed = true;
      canvas.removeEventListener("pocket-optical-ready", onOpticalReady);
      closeTextInputElement();
      textInputElement?.remove?.();
      textInputElement = null;
      resetVideoProjection(true);
      clearSemanticDOM();
      semanticLayer.remove();
      for (const image of resources.values()) disposeResource(image);
      resources.clear();
      const glassScratch = glassScratchCache.get(canvas);
      if (glassScratch) {
        glassScratch.optics?.dispose();
        glassScratch.canvas.width = glassScratch.canvas.height = 0;
        glassScratch.backdropKey = null;
      }
      glassScratchCache.delete(canvas);
      cancelPointerContacts();
      connectionGeneration += 1;
      stream?.close();
      global.removeEventListener("blur", cancelPointerContacts);
      removeAccessibilityMediaQueryListeners();
      densityQuery?.removeEventListener("change", onDensityChange);
      global.removeEventListener("resize", onPreviewResize);
      await inputTail;
      resetPointerContacts();
    }, getFrame: () => frame };
  }

  global.PocketEditorPreview = {
    version: VERSION,
    protocol: { version: VERSION, source: SOURCE },
    mount: client,
    /** Project an already-canonical TEX_TRI-shaped operation (also used by the Novel mesh inspector). */
    projectTriangle(context, operation, image) {
      if (!operation || operation.type !== "textureTriangle") return;
      drawTriangle(context, operation, image);
    },
  };
  if (typeof document !== "undefined") {
    const root = document.querySelector("[data-pocket-preview]");
    if (root && !global.PocketEditorPreviewInstance) {
      global.PocketEditorPreviewInstance = client(root, { projectId: root.dataset.projectId });
    }
  }
})(typeof window !== "undefined" ? window : globalThis);

