/* GPU projection of Pocket's existing optical surface. The manager embeds the
 * same shader asset Flutter uses; this is not a DOM capture or layout engine. */
(function installPocketLiquidGlass(global) {
  "use strict";
  const opticalSource = "" /* pocket-liquid-glass-shader */;

  function finite(value, fallback, low, high) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(low, Math.min(high, value)) : fallback;
  }

  function create(capture, captureContext, onReady) {
    if (!opticalSource) return null;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    if (!gl) return null;
    let program, buffer, texture;
    let failed = false;
    let ready = false, pendingFrame = 0;
    const parallel = gl.getExtension("KHR_parallel_shader_compile");
    const locations = {};
    let textureKey = null, captureRect = "", outputKey = "";
    let textureWidth = 0, textureHeight = 0;
    // One GPU program/texture serves all surfaces. Keep bounded, already
    // projected static results so an animated neighbour cannot evict every
    // other surface's optical work on each frame.
    const outputs = new Map();
    const maxOutputPixels = 4 * 1024 * 1024;
    let outputPixels = 0;
    const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));

    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!parallel && !gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(message || "Liquid Glass shader compilation failed");
      }
      return shader;
    }
    function dispose() {
      failed = true;
      if (pendingFrame) global.cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
      if (texture) gl.deleteTexture(texture);
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      canvas.width = canvas.height = 0;
      textureKey = null;
      for (const entry of outputs.values()) {
        if (entry.canvas) entry.canvas.width = entry.canvas.height = 0;
      }
      outputs.clear();
      outputPixels = 0;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    function finishCompilation() {
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "aPosition");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
      for (const name of ["uSize", "uLensPos", "uSurfaceSize", "uShapeParams", "uGlassOptics", "uExtraOptics", "uBlur", "uMaterial", "uMaterialVariant", "uDeformation", "uDeformationRadius", "uMagnification", "uOutputSize", "uOutputOrigin", "uCapture"]) {
        locations[name] = gl.getUniformLocation(program, name);
      }
      ready = true;
    }
    try {
      // Only adapt texture/coordinate IO. SDF, Snell refraction, frost and rim
      // math remain byte-for-byte in the single retained Flutter shader asset.
      const fragment = `precision highp float;
uniform vec2 uOutputSize;
uniform vec2 uOutputOrigin;
uniform vec4 uCapture;
uniform sampler2D uTexture;
vec4 sampleBackdrop(vec2 uv) {
  return texture2D(uTexture, clamp((uv - uCapture.xy) / uCapture.zw, 0.0, 1.0));
}
` + opticalSource
        .replace(/^#version[^\n]*\n/m, "")
        .replace(/^#include[^\n]*\n/m, "")
        .replace(/uniform sampler2D uTexture[^\n]*\n/, "")
        .replace(/out vec4 fragColor;/, "")
        .replace(/FlutterFragCoord\(\)/g, "vec4(vec2(gl_FragCoord.x, uOutputSize.y - gl_FragCoord.y) + uOutputOrigin, 0.0, 1.0)")
        .replace(/texture\s*\(\s*uTexture\s*,/g, "sampleBackdrop(")
        .replace(/\bfragColor\b/g, "gl_FragColor");
      const vertex = compile(gl.VERTEX_SHADER, "attribute vec2 aPosition; void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }");
      let pixel;
      try { pixel = compile(gl.FRAGMENT_SHADER, fragment); }
      catch (error) { gl.deleteShader(vertex); throw error; }
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, pixel);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(pixel);
      if (!parallel) finishCompilation();
      else {
        const started = performance.now();
        const poll = () => {
          pendingFrame = 0;
          if (failed || gl.isContextLost()) return;
          try {
            // This query is explicitly non-blocking. Do not ask LINK_STATUS,
            // attributes or uniforms until the driver has finished compiling.
            if (gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) {
              finishCompilation();
              onReady?.();
            } else if (performance.now() - started < 10000) {
              pendingFrame = global.requestAnimationFrame(poll);
            } else {
              dispose();
              console.warn("Pocket Liquid Glass: shader preparation timed out; using frost");
            }
          } catch (error) {
            dispose();
            console.warn("Pocket Liquid Glass: using frosted projection", error.message);
          }
        };
        pendingFrame = global.requestAnimationFrame(poll);
      }
    } catch (error) {
      dispose();
      console.warn("Pocket Liquid Glass: using frosted projection", error.message);
      return null;
    }
    canvas.addEventListener("webglcontextlost", (event) => { event.preventDefault(); failed = true; });

    return {
      draw(source, frameWidth, frameHeight, op, p, backdropKey) {
        if (failed || !ready || gl.isContextLost()) return null;
        const width = Math.max(0, Number(op.w ?? op.width) || 0);
        const height = Math.max(0, Number(op.h ?? op.height) || 0);
        const x = Number(op.x) || 0, y = Number(op.y) || 0;
        const opticalInset = finite(p.opticalInset, 0, 0, Math.min(width, height) / 2);
        // The compositor quad may include a symmetric optical halo. Keep the
        // SDF geometry at the original layout size while painting into that
        // already-expanded quad; this preserves the implicit self-clip.
        const shapeWidth = Math.max(0, width - opticalInset * 2);
        const shapeHeight = Math.max(0, height - opticalInset * 2);
        const sx = source.width / frameWidth, sy = source.height / frameHeight;
        const boundsLeft = Math.max(0, Math.floor(x * sx)), boundsTop = Math.max(0, Math.floor(y * sy));
        const boundsRight = Math.min(source.width, Math.ceil((x + width) * sx));
        const boundsBottom = Math.min(source.height, Math.ceil((y + height) * sy));
        if (boundsRight <= boundsLeft || boundsBottom <= boundsTop) return null;
        const edge = finite(p.edgeIntensity, .015, 0, .2), rim = finite(p.rimIntensity, .05, 0, .3);
        const base = finite(p.baseIntensity, .01, 0, .1), tint = finite(p.tintOpacity, .16, 0, 1);
        const corner = finite(p.cornerBoost, .02, 0, .5), ripple = finite(p.rippleEffect, .08, 0, 1);
        const blur = finite(p.blur, 5, 0, 20), radius = finite(p.radius, 24, 0, 200);
        const materialVariant = p.material === "regular" ? 1 : p.material === "clear" ? 2 : 0;
        const deformation = p.deformation && typeof p.deformation === "object" ? p.deformation : null;
        const anchorX = deformation ? finite(deformation.anchorX, 0, -Math.max(width, height), Math.max(width, height)) : 0;
        const anchorY = deformation ? finite(deformation.anchorY, 0, -Math.max(width, height), Math.max(width, height)) : 0;
        const offsetX = deformation ? finite(deformation.offsetX, 0, -12, 12) : 0;
        const offsetY = deformation ? finite(deformation.offsetY, 0, -12, 12) : 0;
        const deformationRadius = deformation ? finite(deformation.radius, 0, 0, 128) : 0;
        const magnification = materialVariant === 0 ? 1 : finite(p.magnification, 1, 1, 1.35);
        // Keep the layout/hit rect unchanged while giving the optical quad a
        // small visual halo for a local pull near an edge.
        // Bound the sampling halo by the shader's maximum refracted ray length,
        // warp, frost and ripple. Crop before upload; never read pixels to JS.
        const thickness = materialVariant === 0
          ? (24 + edge * 340 + rim * 130) * (1 + corner * 2) * (p.pressed ? 1.18 : 1)
          : ((materialVariant === 2 ? 5 : 8) + edge * 80 + rim * 36) *
            (1 + corner * .8) * (materialVariant === 2 ? .78 : 1) * (p.pressed ? 1.18 : 1);
        // Keep the capture halo stable while a gesture changes its offset or
        // lens scale; only the shader uniforms change per frame, so the
        // backdrop upload remains reusable.  The compositor quad already
        // includes `opticalInset` for opt-in glass.  Crop only the additional
        // sampling halo that falls outside that quad; otherwise the same
        // shadow/refraction budget is uploaded twice on every surface.
        const deformationPadding = materialVariant === 0 ? 0 : 16;
        const requiredSampleHalo = thickness + blur + deformationPadding
          + Math.max(width, height) * (p.warp ? .045 + base * 1.8 : 0) / 2
          + Math.max(frameWidth, frameHeight) * ripple * .004 + 2;
        const padding = Math.max(0, requiredSampleHalo - opticalInset);
        const outputX = x, outputY = y;
        const outputRight = x + width, outputBottom = y + height;
        const left = Math.max(0, Math.floor(outputX * sx)), top = Math.max(0, Math.floor(outputY * sy));
        const right = Math.min(source.width, Math.ceil(outputRight * sx));
        const bottom = Math.min(source.height, Math.ceil(outputBottom * sy));
        const ow = right - left, oh = bottom - top;
        const cx = Math.max(0, Math.floor((x - padding) * sx)), cy = Math.max(0, Math.floor((y - padding) * sy));
        const cr = Math.min(source.width, Math.ceil((x + width + padding) * sx));
        const cb = Math.min(source.height, Math.ceil((y + height + padding) * sy));
        const cw = cr - cx, ch = cb - cy;
        if (cw <= 0 || ch <= 0 || Math.max(cw, ch, ow, oh) > limit) return null;
        const rectangle = `${cx},${cy},${cw},${ch}`;
        // The caller can resolve its ordered backdrop prefix against the
        // exact sample ROI. Distant changes then leave this surface reusable.
        if (typeof backdropKey === "function") backdropKey = backdropKey({
          x: cx / sx, y: cy / sy, w: cw / sx, h: ch / sy,
        });
        const uniforms = JSON.stringify([x, y, width, height, p]);
        const identity = op.id ?? op.surfaceHandle ?? `${x},${y},${width},${height}`;
        const signature = backdropKey === null ? null
          : JSON.stringify([uniforms, backdropKey, rectangle, source.width, source.height, frameWidth, frameHeight]);
        let retained = outputs.get(identity);
        const repeated = signature !== null && retained?.signature === signature;
        if (repeated && retained.canvas) {
          outputs.delete(identity);
          outputs.set(identity, retained);
          return { canvas: retained.canvas, x: left / sx, y: top / sy, width: ow / sx, height: oh / sy };
        }
        if (retained?.canvas) {
          outputPixels -= retained.canvas.width * retained.canvas.height;
          retained.canvas.width = retained.canvas.height = 0;
        }
        retained = { signature, canvas: null };
        outputs.delete(identity);
        outputs.set(identity, retained);
        const captureChanged = backdropKey === null || textureKey !== backdropKey || captureRect !== rectangle;
        try {
          if (captureChanged) {
            if (capture.width !== cw) capture.width = cw;
            if (capture.height !== ch) capture.height = ch;
            captureContext.setTransform(1, 0, 0, 1, 0, 0);
            captureContext.globalAlpha = 1;
            captureContext.filter = "none";
            captureContext.globalCompositeOperation = "copy";
            captureContext.drawImage(source, cx, cy, cw, ch, 0, 0, cw, ch);
            captureContext.globalCompositeOperation = "source-over";
            if (textureWidth !== cw || textureHeight !== ch) {
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, capture);
              textureWidth = cw; textureHeight = ch;
            } else {
              gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, capture);
            }
            textureKey = backdropKey;
            captureRect = rectangle;
          }
          if (captureChanged || outputKey !== uniforms || canvas.width !== ow || canvas.height !== oh) {
            if (canvas.width !== ow) canvas.width = ow;
            if (canvas.height !== oh) canvas.height = oh;
            gl.viewport(0, 0, ow, oh);
            gl.uniform2f(locations.uSize, source.width, source.height);
            gl.uniform2f(locations.uOutputSize, ow, oh);
            gl.uniform2f(locations.uOutputOrigin, left, top);
            gl.uniform4f(locations.uCapture, cx / source.width, cy / source.height, cw / source.width, ch / source.height);
            gl.uniform2f(locations.uSurfaceSize, frameWidth, frameHeight);
            gl.uniform2f(locations.uLensPos, (x + width / 2) / frameWidth, (y + height / 2) / frameHeight);
            gl.uniform4f(locations.uShapeParams, shapeWidth / frameWidth, shapeHeight / frameHeight, radius / frameWidth,
              p.shape === "circle" ? 2 : p.shape === "pill" ? 1 : 0);
            gl.uniform4f(locations.uGlassOptics, edge, rim, base, tint);
            gl.uniform4f(locations.uExtraOptics, corner, ripple, p.warp ? 1 : 0, p.pressed ? 1 : 0);
            gl.uniform1f(locations.uBlur, blur);
            const materialTint = finite(p.materialTint, 0xfff2f2f7, 0, 0xffffffff) >>> 0;
            gl.uniform4f(locations.uMaterial, finite(p.materialStrength, 0, 0, 1),
              (materialTint >>> 16 & 255) / 255, (materialTint >>> 8 & 255) / 255, (materialTint & 255) / 255);
            gl.uniform1f(locations.uMaterialVariant, materialVariant);
            gl.uniform4f(locations.uDeformation, anchorX, anchorY, offsetX, offsetY);
            gl.uniform1f(locations.uDeformationRadius, deformationRadius);
            gl.uniform1f(locations.uMagnification, magnification);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            outputKey = uniforms;
          }
          // Moving fields draw directly from the GL canvas. Snapshot resting
          // surfaces, or a held field seen unchanged twice, once; never add a
          // GPU-to-2D copy to every spring frame.
          const resting = Math.abs(offsetX) + Math.abs(offsetY) < .001 && magnification === 1;
          if (signature !== null && (resting || repeated) && ow * oh <= maxOutputPixels) {
            const snapshot = document.createElement("canvas");
            snapshot.width = ow; snapshot.height = oh;
            const context = snapshot.getContext("2d");
            if (context) {
              context.drawImage(canvas, 0, 0);
              retained.canvas = snapshot;
              outputPixels += ow * oh;
            }
          }
          while (outputs.size > 8 || outputPixels > maxOutputPixels) {
            const oldest = outputs.keys().next().value;
            const retired = outputs.get(oldest);
            outputs.delete(oldest);
            if (retired.canvas) {
              outputPixels -= retired.canvas.width * retired.canvas.height;
              retired.canvas.width = retired.canvas.height = 0;
            }
          }
          return { canvas, x: left / sx, y: top / sy, width: ow / sx, height: oh / sy };
        } catch (error) {
          dispose();
          console.warn("Pocket Liquid Glass: using frosted projection", error.message);
          return null;
        }
      },
      dispose,
    };
  }
  global.PocketLiquidGlass = { create };
})(typeof window !== "undefined" ? window : globalThis);
