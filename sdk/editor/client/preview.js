/*
 * Pocket Studio preview projection.
 *
 * The iframe receives FrameResult DrawOps from the native PocketJS probe over
 * SSE and paints those operations directly. It does not evaluate guest source
 * or implement layout. The parent/editor integration can use the same
 * postMessage contract for captures and annotation rectangles:
 *
 * parent -> iframe
 *   {source:'pocket-editor', type:'preview.resize', width, height}
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
 * There is no fixed-interval browser polling.
 */
(function installPocketEditorPreview(global) {
  "use strict";

  const VERSION = 1;
  const SOURCE = "pocket-editor-preview";
  const PARENT_SOURCE = "pocket-editor";
  const MAX_DIMENSION = 32000;
  const tintedImageCache = new WeakMap();

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function argb(value) {
    const color = Number(value) >>> 0;
    const alpha = ((color >>> 24) & 0xff) / 255;
    return `rgba(${(color >>> 16) & 0xff},${(color >>> 8) & 0xff},${color & 0xff},${alpha})`;
  }

  function decodeResource(resource) {
    if (!resource || !resource.width || !resource.height || !Array.isArray(resource.pixels)) return null;
    const width = Number(resource.width);
    const height = Number(resource.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > 16 * 1024 * 1024) return null;
    const source = new Uint8Array(resource.pixels);
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
      const palette = Array.isArray(resource.palette) ? new Uint8Array(resource.palette) : null;
      if (!palette || palette.length < 1024 || source.length < expected) return null;
      for (let index = 0; index < expected; index += 1) {
        const sourceAt = source[index] * 4;
        const at = index * 4;
        rgba[at] = palette[sourceAt];
        rgba[at + 1] = palette[sourceAt + 1];
        rgba[at + 2] = palette[sourceAt + 2];
        rgba[at + 3] = palette[sourceAt + 3];
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
    return { canvas, width, height, revision: Number(resource.revision) || 0 };
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
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return image;
    context.drawImage(image.canvas, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height);
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
    return result;
  }

  function clipRect(context, clip) {
    if (!clip) return;
    context.beginPath();
    context.rect(number(clip.x, 0), number(clip.y, 0), Math.max(0, number(clip.w, 0)), Math.max(0, number(clip.h, 0)));
    context.clip();
  }

  function drawImage(context, image, op) {
    if (!image) return;
    image = tintedImage(image, op.color);
    const uv = Array.isArray(op.uv) && op.uv.length === 4 ? op.uv : [0, 0, 1, 1];
    const sx = clamp(uv[0], 0, 1) * image.width;
    const sy = clamp(uv[1], 0, 1) * image.height;
    const sw = (clamp(uv[2], 0, 1) - clamp(uv[0], 0, 1)) * image.width;
    const sh = (clamp(uv[3], 0, 1) - clamp(uv[1], 0, 1)) * image.height;
    if (sw <= 0 || sh <= 0) return;
    context.drawImage(image.canvas, sx, sy, sw, sh, number(op.x, 0), number(op.y, 0), number(op.w, 0), number(op.h, 0));
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
    image = tintedImage(image, op.color);
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

  function drawFrame(context, frame, resources) {
    const width = number(frame.width, 1);
    const height = number(frame.height, 1);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    const ops = Array.isArray(frame.ops) ? frame.ops : [];
    for (const op of ops) {
      if (!op || typeof op !== "object") continue;
      context.save();
      clipRect(context, op.clip);
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
      } else if (kind === "hostSurface" || kind === "video") {
        // Native host surfaces/video have no browser-side provider. Do not
        // paint a fabricated rectangle or screenshot; the frame/status event
        // remains available to the parent for an explicit capability adapter.
      }
      context.restore();
    }
  }

  function visibleRegion(op, width, height) {
    if (!op || typeof op !== "object" || op.type === "hostSurface" || op.type === "video") return null;
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
    root.style.cssText += ";display:flex;flex-direction:column;align-items:stretch;min-height:100%;background:#0b1020;color:#e5e7eb";
    canvas.style.cssText += ";display:block;width:100%;height:auto;max-width:100%;background:#fff;touch-action:none;outline:none;image-rendering:auto";
    const resources = new Map();
    let frame = null;
    let stream = null;
    let closed = false;
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

    function announce(type, payload) {
      // The editor and preview are same-origin.  Never broadcast captures or
      // FrameResults to an arbitrary embedding origin.
      global.parent?.postMessage({ source: SOURCE, version: VERSION, type, projectId, ...payload }, global.location.origin);
    }

    async function sendInputPayload(payload) {
      const response = await fetch(`${options.basePath || `/api/projects/${encodeURIComponent(projectId)}/preview`}/input`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pocket-editor": "1" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error((await response.text()) || `preview input failed (${response.status})`);
    }

    function enqueueInput(operation, onFailure, guard, moveKey = null) {
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
        status.textContent = `Input error: ${error.message || error}`;
        announce("preview.error", { error: String(error?.message || error) });
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

    function input(payload, onFailure, guard) {
      return enqueueInput(() => sendInputPayload(payload), onFailure, guard, pointerMoveKey(payload));
    }

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
      // the selected logical device is 390×844), so observing it here would
      // silently replace the requested runtime dimensions.
      if (embedded) return;
      const rect = canvas.getBoundingClientRect();
      const width = clamp(Math.round(rect.width || options.width || 390), 1, MAX_DIMENSION);
      const ratio = frame && frame.width > 0 ? frame.height / frame.width : 844 / 390;
      const height = clamp(Math.round((options.height || width * ratio)), 1, MAX_DIMENSION);
      if (frame && (frame.width !== width || frame.height !== height)) {
        finishWheel();
        void input({ type: "resize", width, height });
      }
    }

    function installFrame(next) {
      // A fresh probe/runtime starts its frame counter over. Any browser
      // contact captured by the previous generation is no longer known to
      // native input, so discard it before accepting new moves.
      if (frame && Number(next.frame) < Number(frame.frame)) resetPointerContacts();
      frame = next;
      for (const resource of Array.isArray(next.resources) ? next.resources : []) {
        if (!resource || typeof resource !== "object") continue;
        const asset = String(resource.asset ?? "");
        if (!asset) continue;
        const decoded = decodeResource(resource);
        if (decoded) resources.set(asset, decoded);
        else resources.delete(asset);
      }
      for (const asset of Array.isArray(next.releasedResources) ? next.releasedResources : []) {
        if (typeof asset === "string") resources.delete(asset);
      }
      renderCurrentFrame();
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
      announce("preview.frame", { frame: next });
      const requests = Array.isArray(next.events) ? next.events.filter((event) => event && event.name === "host.request") : [];
      const unsupportedOps = Array.isArray(next.ops) ? next.ops.filter((op) => op && (op.type === "hostSurface" || op.type === "video")) : [];
      if (requests.length) {
        status.textContent = `PocketJS preview · ${requests.length} host request(s) pending (no fake plugin response)`;
        announce("preview.host-request", { requests });
        // No host capability is silently treated as successful.  The parent
        // may answer with a real adapter, or surface this structured pending
        // capability to the user; the preview never invents plugin values.
        const unsupported = requests.filter((event) => {
          const capability = event?.payload?.capability;
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
        status.textContent = `PocketJS preview · ${unsupportedOps.length} native surface/video op(s) unavailable in browser`;
        announce("preview.unsupported", { capabilities: ["hostSurface", "video"], count: unsupportedOps.length });
      }
      resize();
    }

    // FrameResult and input remain in logical pixels. Only the browser's
    // raster target follows the display density, including screen/zoom changes.
    // Do not snap arbitrary DrawOps or infer rounded controls here: Mini App
    // layout must use its host slot's native viewport (preview.ts). Enlarging
    // the backing store improves sharpness but cannot fix a wrong viewport.
    // Cause, ablation and regression coverage: sdk/docs/EDITOR_PREVIEW_RENDERING.md.
    function logicalWidth() { return Math.max(1, Math.round(number(frame?.width, options.width || 390))); }
    function logicalHeight() { return Math.max(1, Math.round(number(frame?.height, options.height || 844))); }

    function renderCurrentFrame() {
      if (!frame) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const width = logicalWidth();
      const height = logicalHeight();
      const density = Math.max(1, number(global.devicePixelRatio, 1));
      const backingWidth = Math.min(MAX_DIMENSION, Math.max(1, Math.round(width * density)));
      const backingHeight = Math.min(MAX_DIMENSION, Math.max(1, Math.round(height * density)));
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      // Explicit logical aspect avoids rounded backing pixels changing CSS size.
      canvas.style.aspectRatio = `${width} / ${height}`;
      context.setTransform(backingWidth / width, 0, 0, backingHeight / height, 0, 0);
      drawFrame(context, frame, resources);
      if (regionsEnabled) drawRegionOverlay(context, frame);
    }

    function connect() {
      const endpoint = `${options.basePath || `/api/projects/${encodeURIComponent(projectId)}/preview`}/stream`;
      stream = new EventSource(`${endpoint}?presentation=browser`);
      stream.onmessage = (event) => {
        try {
          const packet = JSON.parse(event.data);
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
      stream.onerror = () => {
        status.textContent = "PocketJS preview stream reconnecting…";
        announce("preview.error", { error: "preview stream reconnecting" });
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
      void input({ type: "text", events: [{ kind: "keyDown", key: event.key, repeat: event.repeat }] });
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        void input({ type: "text", events: [{ kind: "commit", text: event.key }] });
      }
      if (["Backspace", "Delete", "Enter", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault();
    });
    canvas.addEventListener("keyup", (event) => {
      void input({ type: "text", events: [{ kind: "keyUp", key: event.key, repeat: false }] });
    });
    canvas.addEventListener("compositionstart", (event) => {
      const text = String(event.data || "");
      void input({ type: "text", events: [{ kind: "composition", text, selectionStart: 0, selectionEnd: text.length }] });
    });
    canvas.addEventListener("compositionupdate", (event) => {
      const text = String(event.data || "");
      void input({ type: "text", events: [{ kind: "composition", text, selectionStart: 0, selectionEnd: text.length }] });
    });
    canvas.addEventListener("compositionend", (event) => {
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
        void input({ type: "resize", width, height });
      } else if (message.type === "preview.regions") {
        regionsEnabled = message.enabled === true;
        renderCurrentFrame();
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
      watchDensity();
    }
    watchDensity();
    global.addEventListener("resize", renderCurrentFrame);

    if (!embedded && typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 50);
      });
      observer.observe(canvas);
    }
    announce("preview.ready", { width: logicalWidth(), height: logicalHeight(), transport: "native-probe-full-frames" });
    connect();
    return { canvas, input, close: async () => {
      closed = true;
      cancelPointerContacts();
      stream?.close();
      global.removeEventListener("blur", cancelPointerContacts);
      densityQuery?.removeEventListener("change", onDensityChange);
      global.removeEventListener("resize", renderCurrentFrame);
      await inputTail;
      resetPointerContacts();
    }, getFrame: () => frame };
  }

  global.PocketEditorPreview = { version: VERSION, protocol: { version: VERSION, source: SOURCE }, mount: client };
  if (typeof document !== "undefined") {
    const root = document.querySelector("[data-pocket-preview]");
    if (root && !global.PocketEditorPreviewInstance) {
      global.PocketEditorPreviewInstance = client(root, { projectId: root.dataset.projectId });
    }
  }
})(typeof window !== "undefined" ? window : globalThis);

