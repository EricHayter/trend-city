// THE CEL FRAGMENT STAGE
// Quantised diffuse from an authored ramp LUT (NearestFilter, zero interpolation),
// hard-edged banded specular, stepped fresnel rim, quantised atmospheric depth bands,
// screen-aligned ink hatching inside the darkest band only, a banded fake-environment
// matcap, and procedural surface patterns so architecture reads as designed rather
// than as scaled boxes. Nothing here is physically based on purpose.
export const CEL_FRAGMENT = /* glsl */ `
uniform sampler2D uRamp;
uniform sampler2D uMatcap;
uniform sampler2D uHatch;

uniform vec3  uBaseColor;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbientColor;
uniform float uAmbientStrength;

uniform vec3  uSpecColor;
uniform float uSpecPower;
uniform float uSpecCut;
uniform float uSpecStrength;

uniform vec3  uRimColor;
uniform float uRimPower;
uniform float uRimCut;
uniform float uRimStrength;

uniform float uMatcapStrength;
uniform float uHatchStrength;
uniform float uHatchScale;
uniform float uHatchBand;
uniform vec2  uResolution;

uniform vec3  uHaze;
uniform float uHazeNear;
uniform float uHazeFar;
uniform float uHazeBands;
uniform float uHazeMax;

uniform vec3  uEmissiveColor;
uniform float uEmissive;
uniform float uOpacity;
uniform float uTime;
uniform float uFlash;
uniform vec3  uFlashColor;

uniform float uPattern;
uniform float uPatternScale;
uniform vec3  uPatternA;
uniform vec3  uPatternB;
uniform float uPatternGlow;

varying vec3 vNormalV;
varying vec3 vWorldNormal;
varying vec3 vLocalNormal;
varying vec3 vLocalMetres;
varying vec3 vViewPos;
varying vec3 vWorldPos;
varying vec2 vUv;
varying float vPatternSeed;

float hash21(vec2 p) {
  p = fract(p * vec2(127.34, 311.21));
  p += dot(p, p + 42.17);
  return fract(p.x * p.y);
}

// Pick a 2D coordinate frame from the dominant object-space face so patterns wrap a
// box correctly instead of smearing across it.
vec2 faceCoords(out float faceKind) {
  vec3 an = abs(vLocalNormal);
  if (an.y >= an.x && an.y >= an.z) { faceKind = 0.0; return vLocalMetres.xz; }
  if (an.x >= an.z)                 { faceKind = 1.0; return vLocalMetres.zy; }
  faceKind = 2.0;                     return vLocalMetres.xy;
}

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uLightDir);

  // ---- RAMP / STEP LIGHTING -------------------------------------------------
  // Half-lambert domain keeps back faces inside the ramp instead of clipping to
  // black, which is what gives the shadow side an authored colour rather than mud.
  float lambert = dot(N, L) * 0.5 + 0.5;
  vec3 ramp = texture2D(uRamp, vec2(clamp(lambert, 0.02, 0.98), 0.5)).rgb;
  float shadowMask = 1.0 - step(uHatchBand, lambert);

  vec3 albedo = uBaseColor;
  float emissiveBoost = 0.0;
  vec3 emissiveTint = uEmissiveColor;

  // ---- PROCEDURAL SURFACE PATTERNS -----------------------------------------
  if (uPattern > 0.5) {
    float faceKind;
    vec2 fc = faceCoords(faceKind);
    float seed = fract(vPatternSeed + 0.317);

    if (uPattern < 1.5) {
      // 1: FACADE. Window grid on vertical faces, service panels on roofs.
      if (faceKind > 0.5) {
        vec2 cell = vec2(2.6, 3.4) * uPatternScale;
        vec2 id = floor(fc / cell);
        vec2 f = fract(fc / cell);
        float frame = step(0.09, f.x) * step(f.x, 0.91) * step(0.12, f.y) * step(f.y, 0.86);
        float h = hash21(id + seed * 37.0);
        float lit = step(0.52, h) * frame;
        float bandOut = step(0.62, hash21(vec2(id.y, seed * 11.0)));
        albedo = mix(uBaseColor, uPatternA, frame * 0.55);
        albedo = mix(albedo, uPatternB, lit * mix(0.75, 1.0, bandOut));
        emissiveBoost = lit * uPatternGlow * mix(0.5, 1.0, h);
        emissiveTint = uPatternB;
      } else {
        vec2 g = abs(fract(fc / (5.0 * uPatternScale)) - 0.5);
        float seam = 1.0 - step(0.47, max(g.x, g.y));
        albedo = mix(uPatternA * 0.9, uBaseColor, seam);
      }
    } else if (uPattern < 2.5) {
      // 2: SOLAR PANEL ARRAY. Cells, frames, and a hard graphic sheen streak.
      vec2 cell = vec2(1.1, 1.1) * uPatternScale;
      vec2 f = abs(fract(fc / cell) - 0.5);
      float frame = step(0.42, max(f.x, f.y));
      float sheen = step(0.72, fract((fc.x + fc.y) * 0.06 + 0.25));
      albedo = mix(uBaseColor, uPatternA, frame);
      albedo = mix(albedo, uPatternB, sheen * 0.5 * (1.0 - frame));
      emissiveBoost = sheen * uPatternGlow * 0.35;
      emissiveTint = uPatternB;
    } else if (uPattern < 3.5) {
      // 3: RIBBED DUCTWORK. Hard ribs across the flow direction.
      float rib = step(0.62, fract(fc.y / (0.9 * uPatternScale)));
      float rib2 = step(0.86, fract(fc.y / (0.9 * uPatternScale)));
      albedo = mix(uBaseColor, uPatternA, rib * 0.7);
      albedo = mix(albedo, uPatternB, rib2 * 0.5);
    } else if (uPattern < 4.5) {
      // 4: HAZARD STRIPES. Diagonal, hard, unmistakable.
      float s = step(0.5, fract((fc.x + fc.y) / (1.6 * uPatternScale)));
      albedo = mix(uBaseColor, uPatternA, s);
      emissiveBoost = s * uPatternGlow * 0.4;
      emissiveTint = uPatternA;
    } else if (uPattern < 5.5) {
      // 5: DIGITAL LATTICE. Scrolling energy grid for the final district.
      vec2 g = abs(fract(fc / (2.0 * uPatternScale) + vec2(0.0, uTime * 0.12)) - 0.5);
      float line = 1.0 - step(0.045, min(g.x, g.y));
      float pulse = 0.55 + 0.45 * sin(uTime * 2.4 + fc.y * 0.4 + seed * 6.28);
      albedo = mix(uBaseColor, uPatternA, line);
      emissiveBoost = line * uPatternGlow * pulse;
      emissiveTint = uPatternA;
    } else {
      // 6: CONCRETE PANELISATION. Large cast panels with occasional stained band.
      vec2 cell = vec2(4.2, 3.0) * uPatternScale;
      vec2 id = floor(fc / cell);
      vec2 f = abs(fract(fc / cell) - 0.5);
      float seam = step(0.46, max(f.x, f.y));
      float stain = step(0.82, hash21(id * 1.7 + seed * 5.0));
      albedo = mix(uBaseColor, uPatternA, seam * 0.85);
      albedo = mix(albedo, uPatternA * 0.86, stain * 0.5);
    }
  }

  vec3 lit = albedo * ramp * uLightColor;
  lit += albedo * uAmbientColor * uAmbientStrength;

  // ---- BANDED SPECULAR ------------------------------------------------------
  // Two hard steps: a broad clipped sheen and a tight hot chip. No smooth falloff.
  vec3 H = normalize(L + V);
  float sp = pow(max(dot(N, H), 0.0), uSpecPower);
  float specBroad = step(uSpecCut, sp);
  float specHot = step(uSpecCut + (1.0 - uSpecCut) * 0.55, sp);
  float spec = specBroad * 0.55 + specHot * 0.45;
  lit += uSpecColor * spec * uSpecStrength;

  // ---- FAKE ENVIRONMENT REFLECTION (banded matcap, never a probe) -----------
  vec2 muv = normalize(vNormalV).xy * 0.5 + 0.5;
  vec3 mc = texture2D(uMatcap, muv).rgb;
  mc = floor(mc * 4.0) / 4.0;
  lit += mc * uMatcapStrength;

  // ---- FRESNEL RIM ----------------------------------------------------------
  float fres = pow(1.0 - max(dot(N, V), 0.0), uRimPower);
  float rimA = step(uRimCut, fres);
  float rimB = step(uRimCut + (1.0 - uRimCut) * 0.45, fres);
  float rim = (rimA * 0.6 + rimB * 0.4) * clamp(dot(N, L) * 0.6 + 0.62, 0.0, 1.0);
  lit += uRimColor * rim * uRimStrength;

  // ---- EMISSIVE -------------------------------------------------------------
  lit += emissiveTint * (uEmissive + emissiveBoost);

  // ---- SHADOW-BAND HATCHING ------------------------------------------------
  // Screen-aligned so it reads as drawn shading, applied only where the ramp is dark.
  vec2 huv = (gl_FragCoord.xy / max(uResolution.y, 1.0)) * uHatchScale;
  float hatch = texture2D(uHatch, huv).r;
  lit *= 1.0 - (1.0 - hatch) * uHatchStrength * shadowMask;

  // ---- QUANTISED ATMOSPHERIC PERSPECTIVE -----------------------------------
  // Depth is stepped into discrete tonal plates so the skyline reads as layered
  // graphic silhouettes instead of a smooth photographic haze gradient.
  float dist = length(vViewPos);
  float f = clamp((dist - uHazeNear) / max(1.0, uHazeFar - uHazeNear), 0.0, 1.0);
  f = floor(f * uHazeBands + 0.35) / uHazeBands;
  lit = mix(lit, uHaze, f * uHazeMax);

  // Hit flash (characters, enemies, breakables).
  lit = mix(lit, uFlashColor, clamp(uFlash, 0.0, 1.0));

  gl_FragColor = vec4(lit, uOpacity);
}
`;
