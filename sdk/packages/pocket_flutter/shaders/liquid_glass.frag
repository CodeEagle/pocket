#version 460 core
#include <flutter/runtime_effect.glsl>

// Optical math reused from the original pocketjs_flutter_demo shader.
// The old fixed player/tab/search bodies are removed: one retained surface
// describes one JS component. No application layout belongs in this shader.
uniform vec2 uSize;          // 0, 1: engine-provided backdrop texture pixels
uniform vec2 uLensPos;       // 2, 3: lens center normalized to the retained canvas
uniform vec2 uSurfaceSize;   // 4, 5: retained canvas logical size
uniform vec4 uShapeParams;   // 6..9: normalized width, height, radius, shapeType (0=rounded, 1=pill, 2=circle)
uniform vec4 uGlassOptics;   // 10..13: edgeIntensity, rimIntensity, baseIntensity, tintOpacity
uniform vec4 uExtraOptics;   // 14..17: cornerBoost, rippleEffect, warpFlag, isPressedFlag

uniform float uBlur;         // 18: JS frosted radius in logical pixels

uniform sampler2D uTexture;  // Sampler 0: Pre-rasterized L1-cached background scene texture

out vec4 fragColor;

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float sdCircle(vec2 p, float r) {
  return length(p) - r;
}

// Generic single-component SDF; dimensions are supplied by its retained quad.
float sceneSDF(vec2 fragPos, vec2 lensCenter, vec2 halfSize, float radius, float shapeType) {
  vec2 rel = fragPos - lensCenter;
  float pressScale = (uExtraOptics.w > 0.5) ? 1.03 : 1.0;
  if (shapeType > 1.5) return sdCircle(rel * pressScale, min(halfSize.x, halfSize.y));
  float effectiveRadius = shapeType > 0.5 ? min(halfSize.x, halfSize.y) : radius;
  return sdRoundedBox(rel * pressScale, halfSize, min(effectiveRadius, min(halfSize.x, halfSize.y)));
}

void main() {
  vec2 fragPos = FlutterFragCoord().xy;
#ifdef IMPELLER_TARGET_OPENGLES
  fragPos.y = uSize.y - fragPos.y;
#endif
  vec2 uv = clamp(fragPos / max(uSize, vec2(1.0)), 0.001, 0.999);

  // Geometry is canvas-relative, not relative to the filter's clip. Work in
  // logical units so a high-density screen keeps the same optical thickness.
  fragPos = uv * uSurfaceSize;
  vec2 lensCenter = uLensPos * uSurfaceSize;
  vec2 halfSize = uShapeParams.xy * uSurfaceSize * 0.5;
  float radius = uShapeParams.z * uSurfaceSize.x;
  float shapeType = uShapeParams.w;

  float d = sceneSDF(fragPos, lensCenter, halfSize, radius, shapeType);
  vec3 rawBg = texture(uTexture, uv).rgb;

  // Fast-path 1: Pixels outside the 16px shadow band skip all extra SDF & exp() calls!
  if (d > 16.0) {
    fragColor = vec4(rawBg, 1.0);
    return;
  }

  // Fast-path 2: Narrow shadow band around glass silhouette (0.6 < d <= 16.0)
  if (d > 0.6) {
    float dShadow = sceneSDF(fragPos - vec2(0.0, 4.5), lensCenter, halfSize, radius, shapeType);
    float shadow = exp(-max(0.0, dShadow) / 8.0) * 0.30 * smoothstep(0.0, 1.4, d);
    fragColor = vec4(rawBg * (1.0 - shadow), 1.0);
    return;
  }

  float edgeIntensity = uGlassOptics.x;
  float rimIntensity  = uGlassOptics.y;
  float baseIntensity = uGlassOptics.z;
  float tintOpacity   = uGlassOptics.w;

  float cornerBoost   = uExtraOptics.x;
  float rippleEffect  = uExtraOptics.y;
  float warpFlag      = uExtraOptics.z;
  float isPressed     = uExtraOptics.w;

  // 2. 2-Sample Forward-Difference SDF Gradient (reuses `d`, cutting SDF evaluations by 50%!)
  float dx = sceneSDF(fragPos + vec2(1.0, 0.0), lensCenter, halfSize, radius, shapeType) - d;
  float dy = sceneSDF(fragPos + vec2(0.0, 1.0), lensCenter, halfSize, radius, shapeType) - d;
  vec2 grad2D = normalize(vec2(dx, dy) + vec2(1e-5));

  // 3. Apple iOS 26 Toroidal Bevel Profile (`bezelWidth = 14px`)
  float distFromEdge = max(0.0, -d);
  float bezelWidth = 14.0;
  float r = clamp(1.0 - distFromEdge / bezelWidth, 0.0, 1.0);
  float rCurve = r * r * (3.0 - 2.0 * r);
  float zHeight = sqrt(max(0.04, 1.0 - rCurve * rCurve * 0.90));
  float xySlope = (rCurve / max(0.22, zHeight)) * 1.48;

  vec3 normal = normalize(vec3(grad2D * min(xySlope, 2.2), 1.0));

  // 4. Snell's Law Bevel Refraction
  vec3 refr = refract(vec3(0.0, 0.0, -1.0), normal, 1.0 / 1.520);
  float pressBoost = (isPressed > 0.5) ? 1.18 : 1.0;
  float opticalThickness = (24.0 + edgeIntensity * 340.0 + rimIntensity * 130.0) *
                           (1.0 + cornerBoost * 2.0) * pressBoost;

  vec2 rippleOffset = vec2(
    sin(uv.x * 20.0 + uv.y * 8.0) * rippleEffect * 0.004 * r,
    cos(uv.y * 20.0 - uv.x * 8.0) * rippleEffect * 0.004 * r
  );
  float centerShift = (warpFlag > 0.5) ? (0.045 + baseIntensity * 1.8) * (1.0 - r) : 0.0;
  vec2 toLens = (fragPos - lensCenter) / max(uSurfaceSize, vec2(1.0));
  vec2 uvG = clamp(uv + (refr.xy * opticalThickness) / uSurfaceSize - toLens * centerShift + rippleOffset, 0.002, 0.998);

  // 5-Tap Hardware-Bilinear Gaussian Frosted Blur (50% fewer texture fetches, silky smooth)
  vec2 blurStep = vec2(uBlur * 0.56 / uSurfaceSize.x, uBlur * 0.48 / uSurfaceSize.y);
  vec3 glassColor = texture(uTexture, uvG).rgb * 0.36 +
                    texture(uTexture, clamp(uvG + vec2( blurStep.x,  blurStep.y), 0.002, 0.998)).rgb * 0.16 +
                    texture(uTexture, clamp(uvG + vec2(-blurStep.x,  blurStep.y), 0.002, 0.998)).rgb * 0.16 +
                    texture(uTexture, clamp(uvG + vec2( blurStep.x, -blurStep.y), 0.002, 0.998)).rgb * 0.16 +
                    texture(uTexture, clamp(uvG + vec2(-blurStep.x, -blurStep.y), 0.002, 0.998)).rgb * 0.16;

  // ============================================================================
  // 5. Pure Neutral iOS 26 Frosted Cushion & Razor-Sharp Specular Rim
  // ============================================================================
  // A) Neutral Milky-White Frosted Veil
  glassColor = mix(glassColor, vec3(0.96, 0.97, 1.0), 0.14 + tintOpacity * 0.22);

  // B) Soft Inner Bevel Cushion Glow (`distFromEdge` 1.2px .. 12px)
  float innerCushion = exp(-max(0.0, distFromEdge - 1.2) / 6.2) * 0.16;
  glassColor += vec3(innerCushion);

  // C) Razor-Sharp 1.15px Directional White Specular Rim Lip
  float rimBand = exp(-pow((distFromEdge - 1.0) / 0.68, 2.0));
  vec2 lightDirTL = normalize(vec2(-0.65, -0.76));
  vec2 lightDirBR = normalize(vec2( 0.65,  0.76));
  vec2 lightDirBL = normalize(vec2(-0.78,  0.62));
  float dirTL = pow(max(dot(grad2D, lightDirTL), 0.0), 1.6) * 0.56;
  float dirBR = pow(max(dot(grad2D, lightDirBR), 0.0), 2.0) * 0.40;
  float dirBL = pow(max(dot(grad2D, lightDirBL), 0.0), 2.0) * 0.34;
  float rimHighlight = rimBand * (0.22 + dirTL + dirBR + dirBL);
  glassColor += vec3(rimHighlight);

  // D) 0.85px Hairline Dark Outer Optical Contour
  float outerDarkContour = exp(-pow((d + 0.15) / 0.52, 2.0)) * 0.42;
  glassColor *= (1.0 - outerDarkContour);

  // Anti-aliased silhouette blend with background
  float edgeAA = 1.0 - smoothstep(-0.45, 0.55, d);
  fragColor = vec4(mix(rawBg, clamp(glassColor, 0.0, 1.0), edgeAA), 1.0);
}
