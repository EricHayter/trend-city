/**
 * BloomPass — stylised, not photographic.
 *
 * A hard threshold (neon and specular hits only), a wide separable blur across
 * two mips, and an additive combine that is *tinted* toward the palette so the
 * glow stays magenta/cyan instead of washing everything to white. No dirt
 * texture, no lens artefacts — this reads as printed ink halation.
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const THRESH = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse; uniform float uThresh, uKnee, uClamp;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  // soft knee so the bloom onset isn't a visible ring
  float w = clamp((l - uThresh) / max(uKnee, 1e-4), 0.0, 1.0);
  w *= w;
  gl_FragColor = vec4(min(c, vec3(uClamp)) * w, 1.0);
}
`;

const BLUR = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse; uniform vec2 uDir;
varying vec2 vUv;
void main() {
  // 9-tap gaussian, weights folded into 5 bilinear fetches
  vec3 s = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  s += texture2D(tDiffuse, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  s += texture2D(tDiffuse, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  s += texture2D(tDiffuse, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  s += texture2D(tDiffuse, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(s, 1.0);
}
`;

const COMBINE = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse, tA, tB;
uniform float uStrength; uniform vec3 uTint;
varying vec2 vUv;
void main() {
  vec3 base = texture2D(tDiffuse, vUv).rgb;
  vec3 g = texture2D(tA, vUv).rgb * 0.62 + texture2D(tB, vUv).rgb * 0.38;
  // tint toward the palette, then add. Screen-blend on the wide mip keeps
  // large glows from turning into flat white blobs.
  g *= uTint;
  gl_FragColor = vec4(base + g * uStrength, 1.0);
}
`;

export class BloomPass extends Pass {
  private rtA!: THREE.WebGLRenderTarget;
  private rtB!: THREE.WebGLRenderTarget;
  private rtC!: THREE.WebGLRenderTarget;
  private rtD!: THREE.WebGLRenderTarget;
  private mThresh: THREE.ShaderMaterial;
  private mBlur: THREE.ShaderMaterial;
  private mComb: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor(strength = 0.85, thresh = 0.72, tint = new THREE.Color(1.0, 0.86, 0.98)) {
    super();
    this.needsSwap = true;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(8, 8, opts);
    this.rtB = new THREE.WebGLRenderTarget(8, 8, opts);
    this.rtC = new THREE.WebGLRenderTarget(8, 8, opts);
    this.rtD = new THREE.WebGLRenderTarget(8, 8, opts);
    for (const rt of [this.rtA, this.rtB, this.rtC, this.rtD]) {
      rt.texture.minFilter = THREE.LinearFilter; rt.texture.magFilter = THREE.LinearFilter;
    }
    this.mThresh = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThresh: { value: thresh }, uKnee: { value: 0.45 }, uClamp: { value: 6.0 } },
      vertexShader: VERT, fragmentShader: THRESH, depthTest: false, depthWrite: false,
    });
    this.mBlur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: VERT, fragmentShader: BLUR, depthTest: false, depthWrite: false,
    });
    this.mComb = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tA: { value: this.rtB.texture }, tB: { value: this.rtD.texture },
        uStrength: { value: strength }, uTint: { value: tint },
      },
      vertexShader: VERT, fragmentShader: COMBINE, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mThresh);
  }

  get strength() { return this.mComb.uniforms.uStrength.value as number; }
  set strength(v: number) { this.mComb.uniforms.uStrength.value = v; }
  set threshold(v: number) { this.mThresh.uniforms.uThresh.value = v; }
  get tint(): THREE.Color { return this.mComb.uniforms.uTint.value; }

  override setSize(w: number, h: number) {
    const w2 = Math.max(2, Math.floor(w / 2)), h2 = Math.max(2, Math.floor(h / 2));
    const w4 = Math.max(2, Math.floor(w / 6)), h4 = Math.max(2, Math.floor(h / 6));
    this.rtA.setSize(w2, h2); this.rtB.setSize(w2, h2);
    this.rtC.setSize(w4, h4); this.rtD.setSize(w4, h4);
  }

  private blit(renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const A = this.rtA, B = this.rtB, Cc = this.rtC, D = this.rtD;
    this.mThresh.uniforms.tDiffuse.value = readBuffer.texture;
    this.blit(renderer, this.mThresh, A);

    // half-res H then V
    this.mBlur.uniforms.tDiffuse.value = A.texture;
    this.mBlur.uniforms.uDir.value.set(1 / A.width, 0);
    this.blit(renderer, this.mBlur, B);
    this.mBlur.uniforms.tDiffuse.value = B.texture;
    this.mBlur.uniforms.uDir.value.set(0, 1 / A.height);
    this.blit(renderer, this.mBlur, A);
    // keep the half-res result in B for the combine
    this.mBlur.uniforms.tDiffuse.value = A.texture;
    this.mBlur.uniforms.uDir.value.set(1.7 / A.width, 0);
    this.blit(renderer, this.mBlur, B);

    // sixth-res wide pass for the big halation
    this.mBlur.uniforms.tDiffuse.value = B.texture;
    this.mBlur.uniforms.uDir.value.set(0, 1.7 / Cc.height);
    this.blit(renderer, this.mBlur, Cc);
    this.mBlur.uniforms.tDiffuse.value = Cc.texture;
    this.mBlur.uniforms.uDir.value.set(2.4 / Cc.width, 0);
    this.blit(renderer, this.mBlur, D);
    this.mBlur.uniforms.tDiffuse.value = D.texture;
    this.mBlur.uniforms.uDir.value.set(0, 2.4 / Cc.height);
    this.blit(renderer, this.mBlur, Cc);

    this.mComb.uniforms.tDiffuse.value = readBuffer.texture;
    this.mComb.uniforms.tA.value = B.texture;
    this.mComb.uniforms.tB.value = Cc.texture;
    this.blit(renderer, this.mComb, this.renderToScreen ? null : writeBuffer);
  }

  override dispose() {
    this.rtA.dispose(); this.rtB.dispose(); this.rtC.dispose(); this.rtD.dispose();
    this.mThresh.dispose(); this.mBlur.dispose(); this.mComb.dispose(); this.quad.dispose();
  }
}
