/**
 * CelMaterial — the one material every solid surface in TREND CITY uses.
 *
 * It is a RawShaderMaterial on purpose: we need exact control of the GLSL3
 * multi-render-target outputs (colour + view-normal/linear-depth) so the whole
 * scene is drawn in a *single* geometry pass and the screen-space ink pass can
 * read perfect normals and depth afterwards.
 *
 * The cel response is built from, in order:
 *   1. a quantised diffuse term looked up in a per-material-class ramp texture
 *      (NearestFilter — the steps are real steps, not a gradient),
 *   2. a hard 1-tap directional shadow term folded in *before* the lookup so
 *      cast shadows land exactly on a band boundary,
 *   3. banded Blinn specular (1 or 2 hard steps, never a smooth falloff),
 *   4. a hard-cut Fresnel rim that lives mostly on the unlit side,
 *   5. a stylised matcap standing in for environment reflection,
 *   6. screen-aligned pen hatching mixed into the darkest band only,
 *   7. band-quantised atmospheric perspective toward the sky gradient.
 */
import * as THREE from 'three';
import { Shared } from './Shared';
import {
  MAT_CLASSES, type MatClassName, type MatClass, hexToRgb, C,
} from './Palette';
import { rampTexture, matcapTexture, hatchTexture } from './Textures';

const srgb = (h: string) => new THREE.Color().setRGB(...hexToRgb(h), THREE.SRGBColorSpace);

export type UvMode = 'mesh' | 'triplanar';

export interface CelOptions {
  cls: MatClassName;
  color?: string;
  map?: THREE.Texture | null;
  emissiveMap?: THREE.Texture | null;
  emissive?: string;
  emissiveIntensity?: number;
  uvMode?: UvMode;
  /** world-units per texture tile when uvMode === 'triplanar' */
  uvScale?: number;
  /** mesh-uv repeat */
  uvRepeat?: [number, number];
  matcapKey?: 'sky' | 'chrome' | 'digital' | 'warm';
  matcap?: number;
  hatch?: number;
  vertexColors?: boolean;
  instanced?: boolean;
  instanceColors?: boolean;
  unlit?: boolean;
  transparent?: boolean;
  opacity?: number;
  additive?: boolean;
  depthWrite?: boolean;
  side?: THREE.Side;
  /** scroll uv.y at this rate (energy rails, data streams) */
  scroll?: number;
  /** pulse emissive: [amount, hz] */
  pulse?: [number, number];
  /** shifts the whole ramp lookup: negative = darker, positive = flatter/brighter */
  rampOffset?: number;
  rampScale?: number;
  /** how much the diffuse term wraps around the terminator (0 = hard lambert) */
  wrap?: number;
  fog?: boolean;
  /** disables shadow *receiving* (used for thin fx geometry) */
  shadow?: boolean;
  dither?: number;
}

const MATCAPS: Record<string, () => THREE.Texture> = {
  sky: () => matcapTexture('#cfa8ff', '#2a1240', C.cream, 'sky'),
  chrome: () => matcapTexture('#a8dcff', '#101c30', C.white, 'chrome'),
  digital: () => matcapTexture('#35e8ff', '#0a0524', '#ffffff', 'digital'),
  warm: () => matcapTexture('#ffd0a0', '#3a1a20', C.gold, 'warm'),
};

const VERT = /* glsl */ `
precision highp float;

in vec3 position;
in vec3 normal;
in vec2 uv;
#ifdef USE_VCOLOR
in vec3 color;
#endif
#ifdef USE_INSTANCING
in mat4 instanceMatrix;
#ifdef USE_ICOLOR
in vec3 instanceColor;
#endif
#endif

uniform mat4 modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;

out vec3 vWorld;
out vec3 vNw;      // world normal
out vec3 vNv;      // view normal
out vec2 vUv;
out vec3 vTint;
out float vViewZ;

void main() {
  vec3 pos = position;
  vec3 nrm = normal;
  vTint = vec3(1.0);
#ifdef USE_VCOLOR
  vTint *= color;
#endif

  mat4 model = modelMatrix;
#ifdef USE_INSTANCING
  model = modelMatrix * instanceMatrix;
  // correct normal for a rotation*scale instance matrix without an inverse:
  // (R*S)^-T == R * S^-1  ==  mat3(M) * n / (s*s)
  mat3 im = mat3(instanceMatrix);
  vec3 isc = vec3(length(im[0]), length(im[1]), length(im[2]));
  nrm = im * (nrm / max(isc * isc, vec3(1e-6)));
  #ifdef USE_ICOLOR
    vTint *= instanceColor;
  #endif
#endif

  vec4 wp = model * vec4(pos, 1.0);
  vWorld = wp.xyz;

  mat3 mn = mat3(model);
  vec3 msc = vec3(length(mn[0]), length(mn[1]), length(mn[2]));
  vNw = normalize(mn * (nrm / max(msc * msc, vec3(1e-6))));
  vNv = normalize(mat3(viewMatrix) * vNw);

  vec4 vp = viewMatrix * wp;
  vViewZ = -vp.z;
  vUv = uv;
  gl_Position = projectionMatrix * vp;
}
`;

const FRAG = /* glsl */ `
precision highp float;

layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gNormalDepth;

in vec3 vWorld;
in vec3 vNw;
in vec3 vNv;
in vec2 vUv;
in vec3 vTint;
in float vViewZ;

uniform vec3 cameraPosition;
uniform vec2 resolution;
uniform float time, gtime, cameraFar;

uniform vec3 uColor;
uniform sampler2D uRamp;
uniform float uRampScale, uRampOffset, uWrap, uLightGain;

uniform vec3 sunDir, sunColor, ambSky, ambGround;

uniform vec3 uRimColor;  uniform float uRimPower, uRimCut, uRimStr;
uniform vec3 uSpecColor; uniform float uSpecPower, uSpecSteps, uSpecStr;

uniform sampler2D uMatcap; uniform float uMatcapStr;
uniform sampler2D hatchMap; uniform float hatchScale, uHatchStr;

uniform vec3 fogColor, fogColorHi, inkTint;
uniform float fogNear, fogFar, fogBands, fogStrength, flash;

uniform sampler2D shadowMap;
uniform mat4 shadowMatrix;
uniform float shadowTexel, shadowStrength, shadowBias, uShadowRecv;

uniform float uOpacity, uDither;

#ifdef USE_MAP
uniform sampler2D uMap;
uniform vec2 uUvRepeat;
#endif
#ifdef USE_EMAP
uniform sampler2D uEmissiveMap;
#endif
uniform vec3 uEmissive;
uniform float uEmissiveInt, uPulseAmt, uPulseHz, uScroll, uUvScale;

// --- hash for dithering / breakup, cheap and stable ---
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// Triplanar UV: pick the dominant axis of the world normal. Lets every piece of
// procedural architecture share one texture scale with no authored UVs.
vec2 triUv(vec3 wp, vec3 n, float s) {
  vec3 a = abs(n);
  if (a.y >= a.x && a.y >= a.z) return wp.xz / s;
  if (a.x >= a.z)               return wp.zy / s;
  return wp.xy / s;
}

float shadowAt(vec3 wp, float ndl) {
  if (uShadowRecv < 0.5 || shadowStrength <= 0.0) return 1.0;
  vec4 sc = shadowMatrix * vec4(wp, 1.0);
  vec3 p = sc.xyz / sc.w;
  if (p.x < 0.002 || p.x > 0.998 || p.y < 0.002 || p.y > 0.998 || p.z > 1.0) return 1.0;
  // slope-scaled bias: grazing surfaces need much more or they self-shadow into stripes
  float bias = shadowBias * (1.0 + 3.2 * (1.0 - ndl));
  float d = p.z - bias;
  // 4-tap rotated cross. Enough to kill jaggies while keeping the edge HARD,
  // which is the whole point of a cel shadow.
  float s = 0.0;
  vec2 o = vec2(shadowTexel);
  s += step(d, texture(shadowMap, p.xy + vec2( o.x,  o.y) * 0.9).r);
  s += step(d, texture(shadowMap, p.xy + vec2(-o.x,  o.y) * 0.9).r);
  s += step(d, texture(shadowMap, p.xy + vec2( o.x, -o.y) * 0.9).r);
  s += step(d, texture(shadowMap, p.xy + vec2(-o.x, -o.y) * 0.9).r);
  s *= 0.25;
  // fade the shadow out at the edge of the cascade so it never pops
  vec2 e = abs(p.xy - 0.5) * 2.0;
  float fade = 1.0 - smoothstep(0.80, 0.99, max(e.x, e.y));
  return mix(1.0, s, shadowStrength * fade);
}

void main() {
  vec3 N = normalize(vNw);
  vec3 V = normalize(cameraPosition - vWorld);
  if (!gl_FrontFacing) N = -N;

  // ---- albedo -------------------------------------------------------------
  vec3 albedo = uColor * vTint;
#ifdef USE_MAP
  #ifdef TRIPLANAR
    vec2 muv = triUv(vWorld, N, uUvScale);
  #else
    vec2 muv = vUv * uUvRepeat;
  #endif
  muv.y += uScroll * time;
  albedo *= texture(uMap, muv).rgb;
#endif

#ifdef UNLIT
  vec3 lit = albedo;
#else
  // ---- quantised diffuse --------------------------------------------------
  float ndl = dot(N, normalize(sunDir));
  float sh = shadowAt(vWorld, max(ndl, 0.0));
  // wrap softens *where the terminator sits*, it never softens the step itself
  float t = clamp(ndl * (1.0 - uWrap) + uWrap, 0.0, 1.0);
  t *= mix(0.34, 1.0, sh);               // shadowed pixels drop a whole band
  t = clamp(t * uRampScale + uRampOffset, 0.0, 1.0);
  vec3 ramp = texture(uRamp, vec2(t, 0.5)).rgb * uLightGain;

  // hemisphere fill keeps the darkest band coloured instead of dead
  vec3 amb = mix(ambGround, ambSky, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 lit = albedo * (ramp * sunColor + amb * 0.42);

  // ---- banded specular ---------------------------------------------------
  vec3 H = normalize(normalize(sunDir) + V);
  float sp = pow(max(dot(N, H), 0.0), uSpecPower);
  float sq = step(0.35, sp);
  if (uSpecSteps > 1.5) sq = sq * 0.55 + step(0.72, sp) * 0.45;
  lit += uSpecColor * sq * uSpecStr * sh * step(0.02, ndl);

  // ---- matcap (stylised fake env reflection) -----------------------------
  if (uMatcapStr > 0.001) {
    vec3 nv = normalize(vNv);
    vec2 mc = nv.xy * 0.48 + 0.5;
    vec3 env = texture(uMatcap, mc).rgb;
    // screen-blend so it lifts highlights without washing out the bands
    lit = 1.0 - (1.0 - lit) * (1.0 - env * uMatcapStr);
  }

  // ---- rim ----------------------------------------------------------------
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uRimPower);
  float rim = smoothstep(uRimCut - 0.035, uRimCut + 0.035, fres);
  // strongest away from the sun -> reads as a bounce/backlight, not a glow shell
  rim *= mix(1.0, 0.30, clamp(ndl, 0.0, 1.0));
  lit += uRimColor * rim * uRimStr;
  // hot sun-side edge
  float back = pow(clamp(-dot(normalize(sunDir), V), 0.0, 1.0), 3.0);
  lit += sunColor * fres * back * 0.55;

  // ---- hatching in the darkest band only ---------------------------------
  if (uHatchStr > 0.001) {
    vec2 huv = gl_FragCoord.xy / (hatchScale * 42.0);
    vec3 hv = texture(hatchMap, huv).rgb;
    float dark = 1.0 - smoothstep(0.10, 0.44, t);
    float dens = mix(hv.r, hv.b, clamp(dark * 1.4 - 0.2, 0.0, 1.0));
    lit *= 1.0 - dens * dark * uHatchStr * 0.55;
  }
#endif

  // ---- emissive ----------------------------------------------------------
  float pulse = 1.0 + uPulseAmt * sin(gtime * uPulseHz * 6.2831853);
#ifdef USE_EMAP
  #ifdef TRIPLANAR
    vec2 euv = triUv(vWorld, N, uUvScale);
  #else
    vec2 euv = vUv * uUvRepeat;
  #endif
  euv.y += uScroll * time;
  lit += uEmissive * texture(uEmissiveMap, euv).rgb * uEmissiveInt * pulse;
#else
  lit += uEmissive * uEmissiveInt * pulse;
#endif

  // ---- atmospheric perspective, quantised into graphic bands -------------
#ifdef USE_FOG
  float fd = clamp((vViewZ - fogNear) / max(fogFar - fogNear, 1.0), 0.0, 1.0);
  fd = pow(fd, 0.80);
  // hard steps + a hair of dither so huge flat facades don't show a seam
  float dth = (h21(gl_FragCoord.xy) - 0.5) * (0.85 / max(fogBands, 1.0));
  float band = floor(clamp(fd + dth, 0.0, 1.0) * fogBands + 0.5) / fogBands;
  vec3 sky = mix(fogColor, fogColorHi, clamp(normalize(vWorld - cameraPosition).y * 1.6 + 0.34, 0.0, 1.0));
  lit = mix(lit, sky, band * fogStrength);
#endif

  lit = mix(lit, vec3(1.0), flash);

  float alpha = uOpacity;
#ifdef USE_DITHER_FADE
  if (uDither > 0.0 && h21(gl_FragCoord.xy + vec2(time)) < uDither) discard;
#endif

  gColor = vec4(lit, alpha);
#ifdef FX_PASSTHROUGH
  // transparent fx must not disturb the normal/depth target: alpha 0 with the
  // standard blend equation leaves attachment 1 exactly as it was.
  gNormalDepth = vec4(0.0);
#else
  gNormalDepth = vec4(normalize(vNv) * 0.5 + 0.5, clamp(vViewZ / cameraFar, 0.0, 1.0));
#endif
}
`;

let matCount = 0;

export function celMaterial(o: CelOptions): THREE.RawShaderMaterial {
  const mc: MatClass = MAT_CLASSES[o.cls];
  const uvMode = o.uvMode ?? (o.cls === 'character' || o.cls === 'enemy' || o.cls === 'boss' ? 'mesh' : 'triplanar');
  const unlit = o.unlit ?? o.cls === 'emissive';
  const fx = !!o.transparent;

  const defines: Record<string, string> = {};
  if (o.map) defines.USE_MAP = '';
  if (o.emissiveMap) defines.USE_EMAP = '';
  if (uvMode === 'triplanar') defines.TRIPLANAR = '';
  if (o.vertexColors) defines.USE_VCOLOR = '';
  if (o.instanced) defines.USE_INSTANCING = '';
  if (o.instanceColors) defines.USE_ICOLOR = '';
  if (unlit) defines.UNLIT = '';
  if (o.fog !== false) defines.USE_FOG = '';
  if (fx) defines.FX_PASSTHROUGH = '';
  if (o.dither !== undefined) defines.USE_DITHER_FADE = '';

  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      // shared (same object references across every material)
      time: Shared.time, gtime: Shared.gtime, resolution: Shared.resolution,
      cameraFar: Shared.cameraFar,
      sunDir: Shared.sunDir, sunColor: Shared.sunColor,
      ambSky: Shared.ambSky, ambGround: Shared.ambGround,
      uLightGain: Shared.lightGain,
      fogColor: Shared.fogColor, fogColorHi: Shared.fogColorHi,
      fogNear: Shared.fogNear, fogFar: Shared.fogFar,
      fogBands: Shared.fogBands, fogStrength: Shared.fogStrength,
      shadowMap: Shared.shadowMap, shadowMatrix: Shared.shadowMatrix,
      shadowTexel: Shared.shadowTexel, shadowStrength: Shared.shadowStrength,
      shadowBias: Shared.shadowBias,
      hatchMap: { value: hatchTexture() }, hatchScale: Shared.hatchScale,
      inkTint: Shared.inkTint, flash: Shared.flash,
      // per-material
      uColor: { value: srgb(o.color ?? '#ffffff') },
      uRamp: { value: rampTexture(mc.ramp, o.cls) },
      uRampScale: { value: o.rampScale ?? 1 },
      uRampOffset: { value: o.rampOffset ?? 0 },
      uWrap: { value: o.wrap ?? (o.cls === 'character' || o.cls === 'boss' ? 0.34 : 0.18) },
      uRimColor: { value: srgb(mc.rim.color) },
      uRimPower: { value: mc.rim.power },
      uRimCut: { value: mc.rim.cut },
      uRimStr: { value: mc.rim.strength },
      uSpecColor: { value: srgb(mc.spec.color) },
      uSpecPower: { value: mc.spec.power },
      uSpecSteps: { value: mc.spec.steps },
      uSpecStr: { value: mc.spec.strength },
      uMatcap: { value: MATCAPS[o.matcapKey ?? (o.cls === 'metal' || o.cls === 'glass' ? 'chrome' : o.cls === 'digital' ? 'digital' : 'sky')]() },
      uMatcapStr: { value: o.matcap ?? mc.matcap },
      uHatchStr: { value: o.hatch ?? mc.hatch },
      uMap: { value: o.map ?? null },
      uUvRepeat: { value: new THREE.Vector2(...(o.uvRepeat ?? [1, 1])) },
      uUvScale: { value: o.uvScale ?? 6 },
      uEmissiveMap: { value: o.emissiveMap ?? null },
      uEmissive: { value: srgb(o.emissive ?? '#000000') },
      uEmissiveInt: { value: o.emissiveIntensity ?? (o.emissive ? 1 : 0) },
      uPulseAmt: { value: o.pulse ? o.pulse[0] : 0 },
      uPulseHz: { value: o.pulse ? o.pulse[1] : 0 },
      uScroll: { value: o.scroll ?? 0 },
      uOpacity: { value: o.opacity ?? 1 },
      uShadowRecv: { value: o.shadow === false ? 0 : 1 },
      uDither: { value: o.dither ?? 0 },
    },
    side: o.side ?? THREE.FrontSide,
    transparent: fx,
    depthWrite: o.depthWrite ?? !fx,
    depthTest: true,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  m.name = `cel:${o.cls}:${matCount++}`;
  (m as any).celClass = o.cls;
  return m;
}

/** Cached variants — geometry reuse is worthless if every mesh compiles a shader. */
const shared = new Map<string, THREE.RawShaderMaterial>();
export function celShared(key: string, o: CelOptions): THREE.RawShaderMaterial {
  let m = shared.get(key);
  if (!m) { m = celMaterial(o); shared.set(key, m); }
  return m;
}
export function clearSharedMaterials() {
  for (const m of shared.values()) m.dispose();
  shared.clear();
}
export function sharedMaterialCount() { return shared.size; }
