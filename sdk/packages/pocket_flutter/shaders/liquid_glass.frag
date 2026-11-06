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
uniform vec4 uMaterial;      // 19..22: optional JS neutral veil strength and RGB
uniform float uMaterialVariant; // 23: 0 legacy, 1 regular, 2 clear
// Local jelly pull, in logical surface coordinates relative to the lens
// centre.  The anchor and radius keep the deformation confined to the part
// of a control touched by the drag; zero values preserve the old rendering.
uniform vec4 uDeformation;      // 24..27: anchorX, anchorY, offsetX, offsetY
uniform float uDeformationRadius; // 28: local influence radius
uniform float uMagnification; // 29: optional local lens scale, 1.0 = disabled

uniform sampler2D uTexture;  // Sampler 0: Pre-rasterized L1-cached background scene texture

out vec4 fragColor;

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float sdCircle(vec2 p, float r) {
  return length(p) - r;
}

vec2 deformPosition(vec2 fragPos, vec2 lensCenter) {
  vec2 offset = uDeformation.zw;
  float radius = uDeformationRadius;
  if (radius <= 0.001 || dot(offset, offset) <= 0.000001) return fragPos;
  vec2 local = fragPos - lensCenter;
  float distanceToAnchor = length(local - uDeformation.xy);
  // A compact smooth kernel gives a soft jelly shoulder.  The falloff is
  // exactly zero at the radius, so untouched parts of the same control keep
  // their original silhouette and pixel values.
  float influence = 1.0 - smoothstep(0.0, radius, distanceToAnchor);
  return fragPos - offset * influence;
}

// Generic single-component SDF; dimensions are supplied by its retained quad.
float sceneSDF(vec2 fragPos, vec2 lensCenter, vec2 halfSize, float radius, float shapeType) {
  vec2 rel = fragPos - lensCenter;
  float pressScale = (uExtraOptics.w > 0.5) ? 1.03 : 1.0;
  if (shapeType > 1.5) return sdCircle(rel * pressScale, min(halfSize.x, halfSize.y));
  float effectiveRadius = shapeType > 0.5 ? min(halfSize.x, halfSize.y) : radius;
  return sdRoundedBox(rel * pressScale, halfSize, min(effectiveRadius, min(halfSize.x, halfSize.y)));
}

float deformedSceneSDF(vec2 fragPos, vec2 lensCenter, vec2 halfSize, float radius, float shapeType) {
  return sceneSDF(deformPosition(fragPos, lensCenter), lensCenter, halfSize, radius, shapeType);
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

  vec2 originalFragPos = fragPos;
  vec2 deformedFragPos = deformPosition(fragPos, lensCenter);
  vec2 deformationShift = deformedFragPos - originalFragPos;
  float d = deformedSceneSDF(fragPos, lensCenter, halfSize, radius, shapeType);
  vec3 rawBg = texture(uTexture, uv).rgb;
  float materialVariant = clamp(uMaterialVariant, 0.0, 2.0);
  bool optInMaterial = materialVariant > 0.5;

  // Fast-path 1: Pixels outside the 16px shadow band skip all extra SDF & exp() calls!
  if (d > 16.0) {
    fragColor = vec4(rawBg, 1.0);
    return;
  }

  // Fast-path 2: Narrow shadow band around glass silhouette (0.6 < d <= 16.0)
  if (d > 0.6) {
    float dShadow = deformedSceneSDF(fragPos - vec2(0.0, 4.5), lensCenter, halfSize, radius, shapeType);
    float shadowStrength = optInMaterial ? (materialVariant > 1.5 ? 0.08 : 0.12) : 0.30;
    float shadowFalloff = optInMaterial ? 5.0 : 8.0;
    float shadow = exp(-max(0.0, dShadow) / shadowFalloff) * shadowStrength * smoothstep(0.0, 1.4, d);
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
  float dx = deformedSceneSDF(fragPos + vec2(1.0, 0.0), lensCenter, halfSize, radius, shapeType) - d;
  float dy = deformedSceneSDF(fragPos + vec2(0.0, 1.0), lensCenter, halfSize, radius, shapeType) - d;
  vec2 grad2D = normalize(vec2(dx, dy) + vec2(1e-5));

  // 3. The retained legacy recipe uses a fixed 14px bevel. Opt-in Apple
  // materials use a thinner control-height-relative bevel so a compact
  // toolbar does not read as a thick frosted edge.
  float distFromEdge = max(0.0, -d);
  float controlHeight = uShapeParams.y * uSurfaceSize.y;
  float bezelWidth = optInMaterial
      ? clamp(controlHeight * (materialVariant > 1.5 ? 0.065 : 0.085),
              materialVariant > 1.5 ? 2.5 : 3.5,
              materialVariant > 1.5 ? 7.0 : 9.0)
      : 14.0;
  float r = clamp(1.0 - distFromEdge / bezelWidth, 0.0, 1.0);
  float rCurve = r * r * (3.0 - 2.0 * r);
  float zHeight = sqrt(max(0.04, 1.0 - rCurve * rCurve * 0.90));
  float xySlope = (rCurve / max(0.22, zHeight)) * 1.48;

  vec3 normal = normalize(vec3(grad2D * min(xySlope, 2.2), 1.0));

  // 4. Snell's Law Bevel Refraction
  vec3 refr = refract(vec3(0.0, 0.0, -1.0), normal, 1.0 / 1.520);
  float pressBoost = (isPressed > 0.5) ? 1.18 : 1.0;
  float opticalThickness = optInMaterial
      ? ((materialVariant > 1.5 ? 5.0 : 8.0) + edgeIntensity * 80.0 + rimIntensity * 36.0) *
        (1.0 + cornerBoost * 0.8) * (materialVariant > 1.5 ? 0.78 : 1.0) * pressBoost
      : (24.0 + edgeIntensity * 340.0 + rimIntensity * 130.0) *
        (1.0 + cornerBoost * 2.0) * pressBoost;

  vec2 rippleOffset = vec2(
    sin(uv.x * 20.0 + uv.y * 8.0) * rippleEffect * 0.004 * r,
    cos(uv.y * 20.0 - uv.x * 8.0) * rippleEffect * 0.004 * r
  );
  float centerShift = (warpFlag > 0.5) ? (0.045 + baseIntensity * 1.8) * (1.0 - r) : 0.0;
  vec2 toLens = (fragPos - lensCenter) / max(uSurfaceSize, vec2(1.0));
  // Move only the locally pulled pixels with the jelly.  This is a bounded
  // optical shift, rather than a transform of the whole surface.
  vec2 uvG = clamp(uv + deformationShift / max(uSurfaceSize, vec2(1.0)) * 0.72 +
    (refr.xy * opticalThickness) / uSurfaceSize - toLens * centerShift + rippleOffset, 0.002, 0.998);
  // Navigation lenses can magnify the icons directly beneath the selected
  // capsule. Keep this opt-in and bounded: the layout quad never moves and
  // the legacy material remains exactly at 1.0.
  float magnification = clamp(uMagnification, 1.0, 1.35);
  if (magnification > 1.0001) {
    vec2 lensUv = lensCenter / max(uSurfaceSize, vec2(1.0));
    uvG = clamp(uvG - (uvG - lensUv) * (1.0 - 1.0 / magnification), 0.002, 0.998);
  }

  vec3 glassColor;
  if (!optInMaterial) {
    // Legacy five-tap path. Keep this byte-for-byte equivalent for variant 0.
    vec2 blurStep = vec2(uBlur * 0.56 / uSurfaceSize.x, uBlur * 0.48 / uSurfaceSize.y);
    glassColor = texture(uTexture, uvG).rgb * 0.36 +
                 texture(uTexture, clamp(uvG + vec2( blurStep.x,  blurStep.y), 0.002, 0.998)).rgb * 0.16 +
                 texture(uTexture, clamp(uvG + vec2(-blurStep.x,  blurStep.y), 0.002, 0.998)).rgb * 0.16 +
                 texture(uTexture, clamp(uvG + vec2( blurStep.x, -blurStep.y), 0.002, 0.998)).rgb * 0.16 +
                 texture(uTexture, clamp(uvG + vec2(-blurStep.x, -blurStep.y), 0.002, 0.998)).rgb * 0.16;
  } else if (materialVariant < 1.5) {
    // Regular Apple material uses a dense fixed 7x7 weighted grid. The old
    // sparse corner taps left repeated glyphs in busy navigation bars; this
    // bounded kernel fills those gaps without a second backdrop surface.
    vec2 blurStep = vec2(
      uBlur * 0.28 / uSurfaceSize.x,
      uBlur * 0.24 / uSurfaceSize.y
    );
    // Explicit fixed taps avoid nested integer-loop lowering in WebGL1.
    vec3 accumulated = vec3(0.0);
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-3.0, -3.0), 0.002, 0.998)).rgb * 1.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-2.0, -3.0), 0.002, 0.998)).rgb * 3.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-1.0, -3.0), 0.002, 0.998)).rgb * 6.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(0.0, -3.0), 0.002, 0.998)).rgb * 8.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(1.0, -3.0), 0.002, 0.998)).rgb * 6.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(2.0, -3.0), 0.002, 0.998)).rgb * 3.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(3.0, -3.0), 0.002, 0.998)).rgb * 1.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-3.0, -2.0), 0.002, 0.998)).rgb * 3.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-2.0, -2.0), 0.002, 0.998)).rgb * 9.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-1.0, -2.0), 0.002, 0.998)).rgb * 18.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(0.0, -2.0), 0.002, 0.998)).rgb * 24.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(1.0, -2.0), 0.002, 0.998)).rgb * 18.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(2.0, -2.0), 0.002, 0.998)).rgb * 9.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(3.0, -2.0), 0.002, 0.998)).rgb * 3.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-3.0, -1.0), 0.002, 0.998)).rgb * 6.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-2.0, -1.0), 0.002, 0.998)).rgb * 18.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-1.0, -1.0), 0.002, 0.998)).rgb * 36.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(0.0, -1.0), 0.002, 0.998)).rgb * 48.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(1.0, -1.0), 0.002, 0.998)).rgb * 36.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(2.0, -1.0), 0.002, 0.998)).rgb * 18.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(3.0, -1.0), 0.002, 0.998)).rgb * 6.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-3.0, 0.0), 0.002, 0.998)).rgb * 8.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-2.0, 0.0), 0.002, 0.998)).rgb * 24.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-1.0, 0.0), 0.002, 0.998)).rgb * 48.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(0.0, 0.0), 0.002, 0.998)).rgb * 64.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(1.0, 0.0), 0.002, 0.998)).rgb * 48.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(2.0, 0.0), 0.002, 0.998)).rgb * 24.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(3.0, 0.0), 0.002, 0.998)).rgb * 8.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-3.0, 1.0), 0.002, 0.998)).rgb * 6.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-2.0, 1.0), 0.002, 0.998)).rgb * 18.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-1.0, 1.0), 0.002, 0.998)).rgb * 36.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(0.0, 1.0), 0.002, 0.998)).rgb * 48.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(1.0, 1.0), 0.002, 0.998)).rgb * 36.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(2.0, 1.0), 0.002, 0.998)).rgb * 18.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(3.0, 1.0), 0.002, 0.998)).rgb * 6.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-3.0, 2.0), 0.002, 0.998)).rgb * 3.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-2.0, 2.0), 0.002, 0.998)).rgb * 9.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-1.0, 2.0), 0.002, 0.998)).rgb * 18.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(0.0, 2.0), 0.002, 0.998)).rgb * 24.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(1.0, 2.0), 0.002, 0.998)).rgb * 18.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(2.0, 2.0), 0.002, 0.998)).rgb * 9.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(3.0, 2.0), 0.002, 0.998)).rgb * 3.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-3.0, 3.0), 0.002, 0.998)).rgb * 1.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-2.0, 3.0), 0.002, 0.998)).rgb * 3.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(-1.0, 3.0), 0.002, 0.998)).rgb * 6.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(0.0, 3.0), 0.002, 0.998)).rgb * 8.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(1.0, 3.0), 0.002, 0.998)).rgb * 6.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(2.0, 3.0), 0.002, 0.998)).rgb * 3.0;
    accumulated += texture(uTexture, clamp(uvG + blurStep * vec2(3.0, 3.0), 0.002, 0.998)).rgb * 1.0;
    glassColor = accumulated / 784.0;
  } else {
    // Clear keeps the lighter 13-tap bounded path. It preserves a sharper
    // local background than regular while avoiding the legacy ghosting.
    if (uBlur <= 0.001) {
      // The navigation foreground lens intentionally has no frost radius;
      // avoid thirteen identical texture reads in that mode.
      glassColor = texture(uTexture, uvG).rgb;
    } else {
      vec2 blurStep = vec2(
        uBlur * 0.24 / uSurfaceSize.x,
        uBlur * 0.20 / uSurfaceSize.y
      );
      vec3 center = texture(uTexture, uvG).rgb * 0.20;
      vec3 cardinal = (
        texture(uTexture, clamp(uvG + vec2( blurStep.x, 0.0), 0.002, 0.998)).rgb +
        texture(uTexture, clamp(uvG + vec2(-blurStep.x, 0.0), 0.002, 0.998)).rgb +
        texture(uTexture, clamp(uvG + vec2(0.0,  blurStep.y), 0.002, 0.998)).rgb +
        texture(uTexture, clamp(uvG + vec2(0.0, -blurStep.y), 0.002, 0.998)).rgb
      ) * 0.10;
      vec3 diagonal = (
        texture(uTexture, clamp(uvG + vec2( blurStep.x,  blurStep.y), 0.002, 0.998)).rgb +
        texture(uTexture, clamp(uvG + vec2(-blurStep.x,  blurStep.y), 0.002, 0.998)).rgb +
        texture(uTexture, clamp(uvG + vec2( blurStep.x, -blurStep.y), 0.002, 0.998)).rgb +
        texture(uTexture, clamp(uvG + vec2(-blurStep.x, -blurStep.y), 0.002, 0.998)).rgb
      ) * 0.06;
      vec3 outerCardinal = (
        texture(uTexture, clamp(uvG + vec2(2.0 * blurStep.x, 0.0), 0.002, 0.998)).rgb +
        texture(uTexture, clamp(uvG + vec2(-2.0 * blurStep.x, 0.0), 0.002, 0.998)).rgb +
        texture(uTexture, clamp(uvG + vec2(0.0,  2.0 * blurStep.y), 0.002, 0.998)).rgb +
        texture(uTexture, clamp(uvG + vec2(0.0, -2.0 * blurStep.y), 0.002, 0.998)).rgb
      ) * 0.04;
      glassColor = center + cardinal + diagonal + outerCardinal;
    }
  }

  // ============================================================================
  // 5. Pure Neutral iOS 26 Frosted Cushion & Razor-Sharp Specular Rim
  // ============================================================================
  // A) Keep the legacy veil for variant 0. Apple regular/clear preserve the
  // sampled backdrop hue and use only their explicit material tint strength.
  if (!optInMaterial) {
    glassColor = mix(glassColor, vec3(0.96, 0.97, 1.0), 0.14 + tintOpacity * 0.22);
  }
  glassColor = mix(glassColor, uMaterial.yzw, clamp(uMaterial.x, 0.0, 1.0));

  // B) Soft Inner Bevel Cushion Glow (`distFromEdge` 1.2px .. 12px)
  float innerCushionStrength = optInMaterial
      ? (materialVariant > 1.5 ? 0.018 : 0.045)
      : 0.16;
  float innerCushionFalloff = optInMaterial
      ? max(2.0, bezelWidth * 0.72)
      : 6.2;
  float innerCushion = exp(-max(0.0, distFromEdge - 1.2) / innerCushionFalloff) * innerCushionStrength;
  glassColor += vec3(innerCushion);

  // C) Razor-Sharp 1.15px Directional White Specular Rim Lip
  float rimBand = exp(-pow((distFromEdge - 1.0) / 0.68, 2.0));
  vec2 lightDirTL = normalize(vec2(-0.65, -0.76));
  vec2 lightDirBR = normalize(vec2( 0.65,  0.76));
  vec2 lightDirBL = normalize(vec2(-0.78,  0.62));
  float dirTL = pow(max(dot(grad2D, lightDirTL), 0.0), 1.6) * 0.56;
  float dirBR = pow(max(dot(grad2D, lightDirBR), 0.0), 2.0) * 0.40;
  float dirBL = pow(max(dot(grad2D, lightDirBL), 0.0), 2.0) * 0.34;
  float rimScale = optInMaterial ? (materialVariant > 1.5 ? 0.34 : 0.46) : 1.0;
  float rimHighlight = rimBand * (0.22 + dirTL + dirBR + dirBL) * rimScale;
  glassColor += vec3(rimHighlight);

  // D) 0.85px Hairline Dark Outer Optical Contour
  float outerContourStrength = optInMaterial
      ? (materialVariant > 1.5 ? 0.10 : 0.15)
      : 0.42;
  float outerDarkContour = exp(-pow((d + 0.15) / (optInMaterial ? 0.46 : 0.52), 2.0)) * outerContourStrength;
  glassColor *= (1.0 - outerDarkContour);

  // Anti-aliased silhouette blend with background
  float edgeAA = 1.0 - smoothstep(-0.45, 0.55, d);
  fragColor = vec4(mix(rawBg, clamp(glassColor, 0.0, 1.0), edgeAA), 1.0);
}
