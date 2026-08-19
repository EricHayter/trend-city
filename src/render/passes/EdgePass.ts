/**
 * EdgePass — screen-space ink for the lines an inverted hull physically cannot
 * draw: creases between two faces of the same object, window mullions, panel
 * seams, the line where a pipe meets a wall.
 *
 * Reads the MRT normal/linear-depth attachment. Depth gives object-boundary
 * lines, normals give interior creases. Both are thresholded relative to the
 * local depth so a line is as crisp 400 m away as it is at the player's feet.
 *
 * It is deliberately tuned to *stay out of the way* of the hull outlines:
 * pixels that are already ink-dark get their edge response cut, which is what
 * stops the two systems doubling up into a muddy smear.
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { Shared } from '../Shared';

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tND;
uniform vec2 uTexel;
uniform vec3 uInk;
uniform float uDepthScale, uNormalScale, uStrength, uWidth, uFar, uFade, uCreaseMin;
varying vec2 vUv;

vec4 nd(vec2 uv) { return texture2D(tND, uv); }

void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  vec2 o = uTexel * uWidth;

  vec4 C = nd(vUv);
  float dC = C.a;

  // 8-neighbour taps (one fetch set reused for both operators)
  vec4 n0 = nd(vUv + vec2(-o.x, -o.y));
  vec4 n1 = nd(vUv + vec2( 0.0, -o.y));
  vec4 n2 = nd(vUv + vec2( o.x, -o.y));
  vec4 n3 = nd(vUv + vec2(-o.x,  0.0));
  vec4 n4 = nd(vUv + vec2( o.x,  0.0));
  vec4 n5 = nd(vUv + vec2(-o.x,  o.y));
  vec4 n6 = nd(vUv + vec2( 0.0,  o.y));
  vec4 n7 = nd(vUv + vec2( o.x,  o.y));

  // --- depth Sobel, normalised by local depth so it is scale invariant -----
  float gx = (n0.a + 2.0 * n3.a + n5.a) - (n2.a + 2.0 * n4.a + n7.a);
  float gy = (n0.a + 2.0 * n1.a + n2.a) - (n5.a + 2.0 * n6.a + n7.a);
  float dg = sqrt(gx * gx + gy * gy) / max(dC, 0.0006);
  float depthEdge = smoothstep(uDepthScale, uDepthScale * 2.4, dg);

  // --- normal discontinuity: worst neighbour wins, gives clean single lines -
  vec3 N = C.rgb * 2.0 - 1.0;
  float worst = 1.0;
  worst = min(worst, dot(N, n1.rgb * 2.0 - 1.0));
  worst = min(worst, dot(N, n3.rgb * 2.0 - 1.0));
  worst = min(worst, dot(N, n4.rgb * 2.0 - 1.0));
  worst = min(worst, dot(N, n6.rgb * 2.0 - 1.0));
  // ignore creases shallower than uCreaseMin so smooth curvature stays clean
  float normEdge = smoothstep(uCreaseMin, uCreaseMin - uNormalScale, worst);

  // sky (depth == 1) must never be inked, and neither should the silhouette
  // *against* the sky — the hull already owns that line.
  float skyMask = step(dC, 0.9985);
  float skyNear = step(max(max(n1.a, n3.a), max(n4.a, n6.a)), 0.9985);

  float edge = max(depthEdge * skyNear, normEdge) * skyMask;

  // atmospheric fade: distant geometry keeps its silhouette but loses detail
  edge *= 1.0 - smoothstep(uFade, 1.0, dC);

  // don't double up on the inverted-hull ink or on already-black pixels
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  edge *= smoothstep(0.045, 0.20, lum);

  // coloured ink: part flat ink tint, part a deep version of the local colour.
  // Pure black lines look pasted on; this keeps them inside the palette.
  vec3 ink = mix(uInk, c * 0.20, 0.42);
  gl_FragColor = vec4(mix(c, ink, clamp(edge * uStrength, 0.0, 1.0)), 1.0);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class EdgePass extends Pass {
  private quad: FullScreenQuad;
  readonly mat: THREE.ShaderMaterial;
  constructor(private mrt: THREE.WebGLRenderTarget) {
    super();
    this.needsSwap = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: mrt.textures[0] },
        tND: { value: mrt.textures[1] },
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uInk: { value: Shared.inkTint.value },
        uDepthScale: { value: 0.030 },
        uNormalScale: { value: 0.34 },
        uCreaseMin: { value: 0.82 },
        uStrength: { value: 0.92 },
        uWidth: { value: 1.0 },
        uFar: { value: 3000 },
        uFade: { value: 0.30 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }
  override setSize(w: number, h: number) {
    this.mat.uniforms.uTexel.value.set(1 / w, 1 / h);
    // keep the stroke ~1.15 device px regardless of render scale
    this.mat.uniforms.uWidth.value = 1.0;
  }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget) {
    this.mat.uniforms.tColor.value = this.mrt.textures[0];
    this.mat.uniforms.tND.value = this.mrt.textures[1];
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  override dispose() { this.quad.dispose(); this.mat.dispose(); }
}
