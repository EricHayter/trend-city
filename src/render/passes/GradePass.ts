/**
 * GradePass — the final unifier. Everything the player sees passes through here,
 * which is what keeps characters, world, particles and HUD-adjacent glow inside
 * one palette.
 *
 * Order matters:
 *   FXAA (tuned weak, so ink lines stay crisp)
 *   → radial chromatic split (speed only)
 *   → highlight rolloff that preserves hue (neon must not clip to white)
 *   → 32³ LUT authored in Textures.gradeLUT()
 *   → duotone + halftone IMPACT FRAME (1–2 frames, used sparingly)
 *   → palette-tinted vignette + hit flash
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse, tLut, tHalftone;
uniform vec2 uTexel, uAspect;
uniform vec3 uVignette, uFlashColor, uImpactInk, uImpactHot;
uniform float uLutAmount, uChroma, uVigAmount, uFlash, uImpact, uFxaa, uExposure, uTime, uDesat;
varying vec2 vUv;

vec3 lut(vec3 c) {
  const float N = 32.0;
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (N - 1.0);
  float b0 = floor(b), b1 = min(b0 + 1.0, N - 1.0);
  float f = b - b0;
  vec2 uvA = vec2((b0 * N + c.r * (N - 1.0) + 0.5) / (N * N), (c.g * (N - 1.0) + 0.5) / N);
  vec2 uvB = vec2((b1 * N + c.r * (N - 1.0) + 0.5) / (N * N), (c.g * (N - 1.0) + 0.5) / N);
  return mix(texture2D(tLut, uvA).rgb, texture2D(tLut, uvB).rgb, f);
}

float lumOf(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// The whole pipeline works in linear light (cel colours are authored in sRGB and
// converted on upload), and the composer buffers are half-float linear. Nothing
// in Three encodes for us because these are hand-written shaders, so the final
// pass owns the linear -> sRGB transfer. Without it the game renders ~2.2x dark.
vec3 encodeSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;

  // ---- FXAA (weak on purpose) --------------------------------------------
  vec3 c;
  if (uFxaa > 0.001) {
    vec3 rgbNW = texture2D(tDiffuse, uv + vec2(-uTexel.x,  uTexel.y)).rgb;
    vec3 rgbNE = texture2D(tDiffuse, uv + vec2( uTexel.x,  uTexel.y)).rgb;
    vec3 rgbSW = texture2D(tDiffuse, uv + vec2(-uTexel.x, -uTexel.y)).rgb;
    vec3 rgbSE = texture2D(tDiffuse, uv + vec2( uTexel.x, -uTexel.y)).rgb;
    vec3 rgbM  = texture2D(tDiffuse, uv).rgb;
    float lNW = lumOf(rgbNW), lNE = lumOf(rgbNE), lSW = lumOf(rgbSW), lSE = lumOf(rgbSE), lM = lumOf(rgbM);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + max(lMax, 0.03) * 0.25 + 1e-5);
    dir = clamp(dir * rcp, -2.0, 2.0) * uTexel;
    vec3 a = 0.5 * (texture2D(tDiffuse, uv + dir * (1.0 / 3.0 - 0.5)).rgb
                  + texture2D(tDiffuse, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 b = a * 0.5 + 0.25 * (texture2D(tDiffuse, uv + dir * -0.5).rgb
                             + texture2D(tDiffuse, uv + dir *  0.5).rgb);
    float lB = lumOf(b);
    c = mix(rgbM, (lB < lMin || lB > lMax) ? a : b, uFxaa);
  } else {
    c = texture2D(tDiffuse, uv).rgb;
  }

  // ---- radial chromatic split (speed only) -------------------------------
  if (uChroma > 0.0005) {
    vec2 d = (uv - 0.5) * uAspect;
    vec2 off = d * uChroma * 0.012;
    c.r = texture2D(tDiffuse, uv + off).r;
    c.b = texture2D(tDiffuse, uv - off).b;
  }

  c *= uExposure;

  // ---- hue-preserving highlight rolloff ----------------------------------
  float mx = max(c.r, max(c.g, c.b));
  if (mx > 1.0) c *= (1.0 + (mx - 1.0) * 0.34) / mx;

  // ---- linear light ends here --------------------------------------------
  // Everything above works in linear light. The LUT and the stylised passes
  // below are authored against *display* values (the S-curve pivot, the floor
  // lift, the duotone inks), so the transfer happens here and the shader writes
  // its result straight out.
  c = encodeSrgb(c);

  // ---- grade -------------------------------------------------------------
  c = mix(c, lut(c), uLutAmount);

  // ---- impact frame: duotone posterise + halftone ------------------------
  if (uImpact > 0.002) {
    float l = lumOf(c);
    float q = floor(l * 3.0 + 0.5) / 3.0;
    vec2 huv = (uv * uAspect) * 34.0;
    float dot_ = texture2D(tHalftone, huv).r;
    float mask = step(dot_, q * 1.15);
    vec3 duo = mix(uImpactInk, uImpactHot, mask * q);
    c = mix(c, duo, uImpact);
  }

  // ---- desaturate (damage / death) ---------------------------------------
  if (uDesat > 0.002) c = mix(c, vec3(lumOf(c)), uDesat);

  // ---- vignette + flash ---------------------------------------------------
  vec2 vd = (uv - 0.5) * uAspect;
  float vig = 1.0 - smoothstep(0.55, 1.28, length(vd));
  c = mix(c * mix(vec3(1.0), uVignette, uVigAmount), c, vig);
  c += uFlashColor * uFlash;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export class GradePass extends Pass {
  readonly mat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  constructor(lut: THREE.Texture, halftone: THREE.Texture) {
    super();
    this.needsSwap = false;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tLut: { value: lut }, tHalftone: { value: halftone },
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uAspect: { value: new THREE.Vector2(1.777, 1) },
        uVignette: { value: new THREE.Color(0.34, 0.18, 0.42) },
        uFlashColor: { value: new THREE.Color(1, 1, 1) },
        uImpactInk: { value: new THREE.Color(0.07, 0.03, 0.13) },
        uImpactHot: { value: new THREE.Color(1.0, 0.95, 0.86) },
        uLutAmount: { value: 1.0 }, uChroma: { value: 0 }, uVigAmount: { value: 0.85 },
        uFlash: { value: 0 }, uImpact: { value: 0 }, uFxaa: { value: 0.85 },
        uExposure: { value: 1.0 }, uTime: { value: 0 }, uDesat: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }
  override setSize(w: number, h: number) {
    this.mat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.mat.uniforms.uAspect.value.set(w / h, 1);
  }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.mat.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  override dispose() { this.quad.dispose(); this.mat.dispose(); }
}
