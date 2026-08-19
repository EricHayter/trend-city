/**
 * SpeedPass — the effect that sells velocity.
 *
 * Three layered ideas, all driven off one `amount` (0 at walking pace, 1 at
 * boosted top speed) plus a `boost` flag:
 *
 *  1. RADIAL SMEAR — the frame is resampled along the vector away from a focus
 *     point that leads the player's motion. Kept short and strictly outside the
 *     centre so the readable part of the screen never blurs.
 *  2. RADIAL INK LINES — hard-edged streaks generated in polar space. They are
 *     *quantised*, not soft gradients, so they read as drawn speed lines.
 *  3. EDGE PUSH — a vignette-shaped saturation/darkening that tunnels vision.
 *
 * Everything fades to a literal no-op at amount 0 so slow play is untouched.
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 uFocus, uAspect;
uniform vec3 uLineColor, uBoostColor;
uniform float uAmount, uBoost, uTime, uSmear, uLines, uTunnel, uSpin;
varying vec2 vUv;

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 d = (vUv - uFocus) * uAspect;
  float r = length(d);
  vec3 c;

  // ---- 1. radial smear -----------------------------------------------------
  if (uSmear > 0.001) {
    // strength ramps in from the middle of the screen outward
    float w = smoothstep(0.16, 0.85, r) * uSmear;
    vec2 step_ = -normalize(d + 1e-5) * w * 0.055 / max(uAspect.x, 1.0);
    c  = texture2D(tDiffuse, vUv).rgb * 0.34;
    c += texture2D(tDiffuse, vUv + step_ * 1.0).rgb * 0.24;
    c += texture2D(tDiffuse, vUv + step_ * 2.0).rgb * 0.18;
    c += texture2D(tDiffuse, vUv + step_ * 3.2).rgb * 0.14;
    c += texture2D(tDiffuse, vUv + step_ * 4.6).rgb * 0.10;
  } else {
    c = texture2D(tDiffuse, vUv).rgb;
  }

  if (uAmount > 0.001) {
    // ---- 2. hard radial speed lines ---------------------------------------
    float a = atan(d.y, d.x) + uSpin;
    // three frequency bands so the lines never look like a single comb
    float seedA = floor(a * 30.0);
    float seedB = floor(a * 71.0);
    float seedC = floor(a * 143.0);
    float pa = h21(vec2(seedA, 1.0));
    float pb = h21(vec2(seedB, 7.0));
    float pc = h21(vec2(seedC, 13.0));
    // animate: each streak travels outward at its own speed
    float ta = fract(pa * 3.7 + uTime * (0.7 + pa * 1.7));
    float tb = fract(pb * 5.1 + uTime * (1.3 + pb * 2.4));
    float tc = fract(pc * 9.3 + uTime * (2.1 + pc * 3.1));
    float band = smoothstep(0.20, 0.62, r);
    float line = 0.0;
    line += step(0.968, pa) * step(0.35, band) * step(abs(fract(r * 0.9 - ta) - 0.5), 0.34);
    line += step(0.976, pb) * band * 0.75;
    line += step(0.988, pc) * band * 0.5;
    line = clamp(line, 0.0, 1.0);
    // hard-quantised streak profile
    float streak = line * smoothstep(0.18, 0.95, r) * uLines;
    vec3 lc = mix(uLineColor, uBoostColor, uBoost);
    c = mix(c, lc, clamp(streak, 0.0, 0.9));

    // ---- 3. tunnel: crush and desaturate the periphery --------------------
    float t = smoothstep(0.42, 1.15, r) * uTunnel;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, mix(vec3(lum) * 0.55, lc * 0.35, 0.35), t);
  }

  gl_FragColor = vec4(c, 1.0);
}
`;

export class SpeedPass extends Pass {
  readonly mat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  constructor() {
    super();
    this.needsSwap = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uFocus: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: { value: new THREE.Vector2(1.777, 1) },
        uLineColor: { value: new THREE.Color(1, 1, 1) },
        uBoostColor: { value: new THREE.Color(0.21, 0.91, 1.0) },
        uAmount: { value: 0 }, uBoost: { value: 0 }, uTime: { value: 0 },
        uSmear: { value: 0 }, uLines: { value: 0 }, uTunnel: { value: 0 },
        uSpin: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }
  override setSize(w: number, h: number) { this.mat.uniforms.uAspect.value.set(w / h, 1); }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    // full no-op path: when nothing is active, skip the whole shader
    const u = this.mat.uniforms;
    this.mat.uniforms.tDiffuse.value = readBuffer.texture;
    // Early-out only when we are an intermediate pass: skipping the draw leaves
    // readBuffer untouched and the next pass reads it directly. If we are the
    // pass that owns the screen, skipping would leave the default framebuffer
    // unwritten (it is never cleared), so always draw in that case.
    if (!this.renderToScreen && u.uAmount.value < 0.002 && u.uSmear.value < 0.002) {
      this.needsSwap = false; return;
    }
    this.needsSwap = true;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  override dispose() { this.quad.dispose(); this.mat.dispose(); }
}
