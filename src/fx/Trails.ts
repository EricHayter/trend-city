import { BufferGeometry, BufferAttribute, Mesh, ShaderMaterial, Vector3, Color, AdditiveBlending, DoubleSide } from 'three';
import { LAYER_FX } from '../render/Pipeline';

// MOTION SMEAR
// A ribbon built from a rolling history of a tracked point. Used for the body trail at
// speed and for hand and foot smears during dashes and attacks. Width and opacity are
// driven by speed so the effect only exists when the movement earns it.

const TRAIL_VERT = /* glsl */ `
attribute float aT;
attribute float aSide;
varying float vT;
void main() {
  vT = aT;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRAIL_FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uStrength;
varying float vT;
void main() {
  // Stepped along its length so the smear reads as stacked frames, not a soft blur.
  float band = floor(vT * 5.0) / 5.0;
  vec3 c = mix(uColorB, uColorA, band);
  float a = pow(vT, 1.4) * uStrength;
  gl_FragColor = vec4(c, a);
}
`;

export class Trail {
  mesh: Mesh;
  private positions: Float32Array;
  private history: Vector3[] = [];
  private mat: ShaderMaterial;
  private segments: number;
  private width: number;

  constructor(segments = 26, width = 0.55, colorA = 0x9ef0ff, colorB = 0x7b3bff) {
    this.segments = segments;
    this.width = width;
    const geo = new BufferGeometry();
    this.positions = new Float32Array(segments * 2 * 3);
    const ts = new Float32Array(segments * 2);
    const sides = new Float32Array(segments * 2);
    const idx: number[] = [];
    for (let i = 0; i < segments; i++) {
      const t = 1 - i / (segments - 1);
      ts[i * 2] = t; ts[i * 2 + 1] = t;
      sides[i * 2] = -1; sides[i * 2 + 1] = 1;
      if (i < segments - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      this.history.push(new Vector3());
    }
    geo.setAttribute('position', new BufferAttribute(this.positions, 3));
    geo.setAttribute('aT', new BufferAttribute(ts, 1));
    geo.setAttribute('aSide', new BufferAttribute(sides, 1));
    geo.setIndex(idx);
    this.mat = new ShaderMaterial({
      vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
      uniforms: {
        uColorA: { value: new Color(colorA) },
        uColorB: { value: new Color(colorB) },
        uStrength: { value: 0 },
      },
      transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending,
    });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_FX);
    (this.mesh as any).noOutline = true;
  }

  reset(pos: Vector3) {
    for (const h of this.history) h.copy(pos);
  }

  setColors(a: number, b: number) {
    (this.mat.uniforms.uColorA.value as Color).setHex(a);
    (this.mat.uniforms.uColorB.value as Color).setHex(b);
  }

  /**
   * @param pos current world position of the tracked point
   * @param up  ribbon orientation reference (usually camera right or velocity cross up)
   * @param strength 0..1 visibility, driven by speed or attack state
   */
  update(pos: Vector3, up: Vector3, strength: number, widthScale = 1) {
    this.mat.uniforms.uStrength.value += (strength - this.mat.uniforms.uStrength.value) * 0.3;
    for (let i = this.history.length - 1; i > 0; i--) this.history[i].copy(this.history[i - 1]);
    this.history[0].copy(pos);
    const p = this.positions;
    for (let i = 0; i < this.segments; i++) {
      const h = this.history[i];
      const taper = (1 - i / this.segments) * this.width * widthScale;
      p[i * 6 + 0] = h.x - up.x * taper;
      p[i * 6 + 1] = h.y - up.y * taper;
      p[i * 6 + 2] = h.z - up.z * taper;
      p[i * 6 + 3] = h.x + up.x * taper;
      p[i * 6 + 4] = h.y + up.y * taper;
      p[i * 6 + 5] = h.z + up.z * taper;
    }
    (this.mesh.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }
}
