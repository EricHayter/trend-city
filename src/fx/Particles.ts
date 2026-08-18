import { InstancedMesh, InstancedBufferAttribute, BufferGeometry, BufferAttribute, ShaderMaterial,
  Matrix4, Vector3, Quaternion, Color, AdditiveBlending, DoubleSide, Object3D } from 'three';
import { LAYER_FX } from '../render/Pipeline';
import { clamp01 } from '../core/MathX';

// STYLISED PARTICLES
// Hard-edged shard and chevron shapes, flat banded colour, no soft sprites anywhere.
// One InstancedMesh, one pool, zero allocation per frame.

function shardGeo(): BufferGeometry {
  const g = new BufferGeometry();
  const v = [
    0, 0.5, 0, -0.28, -0.1, 0.16, 0.28, -0.1, 0.16,
    0, 0.5, 0, 0.28, -0.1, 0.16, 0.28, -0.1, -0.16,
    0, 0.5, 0, 0.28, -0.1, -0.16, -0.28, -0.1, -0.16,
    0, 0.5, 0, -0.28, -0.1, -0.16, -0.28, -0.1, 0.16,
    -0.28, -0.1, 0.16, -0.28, -0.1, -0.16, 0.28, -0.1, 0.16,
    0.28, -0.1, 0.16, -0.28, -0.1, -0.16, 0.28, -0.1, -0.16,
  ];
  g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

const PARTICLE_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aFade;
varying vec3 vCol;
varying float vFade;
varying vec3 vN;
void main() {
  vCol = aColor;
  vFade = aFade;
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const PARTICLE_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vFade;
varying vec3 vN;
void main() {
  // Two hard tonal steps across the shape: never a soft gradient.
  float k = step(0.1, vN.y) * 0.35 + 0.65;
  vec3 c = vCol * k;
  // Fade in discrete steps so dissipation reads as drawn frames, not alpha mush.
  float f = floor(vFade * 4.0 + 0.35) / 4.0;
  gl_FragColor = vec4(c * (0.55 + f * 0.85), f);
}
`;

interface P {
  active: boolean;
  pos: Vector3; vel: Vector3; spin: Vector3; rot: Quaternion;
  life: number; maxLife: number; size: number; growth: number;
  gravity: number; drag: number; color: Color; stretch: number;
}

export type FxKind = 'dust' | 'spark' | 'shard' | 'debris' | 'ring' | 'flame' | 'ember' | 'shock';

export class Particles {
  mesh: InstancedMesh;
  private items: P[] = [];
  private colors: Float32Array;
  private fades: Float32Array;
  private cursor = 0;
  private tmp = new Matrix4();
  private scale = new Vector3();
  private material: ShaderMaterial;

  constructor(public capacity = 1200) {
    const geo = shardGeo();
    this.material = new ShaderMaterial({
      vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
      transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending,
    });
    this.mesh = new InstancedMesh(geo, this.material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_FX);
    (this.mesh as any).noOutline = true;
    this.colors = new Float32Array(capacity * 3);
    this.fades = new Float32Array(capacity);
    geo.setAttribute('aColor', new InstancedBufferAttribute(this.colors, 3));
    geo.setAttribute('aFade', new InstancedBufferAttribute(this.fades, 1));
    for (let i = 0; i < capacity; i++) {
      this.items.push({
        active: false, pos: new Vector3(), vel: new Vector3(), spin: new Vector3(), rot: new Quaternion(),
        life: 0, maxLife: 1, size: 1, growth: 0, gravity: 0, drag: 0, color: new Color(), stretch: 1,
      });
      this.tmp.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.tmp);
    }
  }

  private next(): P {
    // Ring allocation: the oldest particle is recycled when the pool is saturated.
    for (let i = 0; i < 24; i++) {
      this.cursor = (this.cursor + 1) % this.capacity;
      if (!this.items[this.cursor].active) return this.items[this.cursor];
    }
    this.cursor = (this.cursor + 1) % this.capacity;
    return this.items[this.cursor];
  }

  emit(kind: FxKind, pos: Vector3, dir: Vector3, count: number, colorA: number, colorB: number, power = 1) {
    for (let i = 0; i < count; i++) {
      const p = this.next();
      p.active = true;
      p.pos.copy(pos);
      p.rot.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random()).normalize();
      p.color.setHex(Math.random() < 0.5 ? colorA : colorB);
      p.stretch = 1;
      const jitter = () => (Math.random() - 0.5) * 2;
      switch (kind) {
        case 'dust':
          p.vel.set(dir.x * 3 + jitter() * 3, 1.5 + Math.random() * 3, dir.z * 3 + jitter() * 3).multiplyScalar(power);
          p.maxLife = 0.34 + Math.random() * 0.3; p.size = 0.5 + Math.random() * 0.7;
          p.gravity = -6; p.drag = 2.6; p.growth = 1.9;
          break;
        case 'spark':
          p.vel.set(jitter() * 16, 4 + Math.random() * 14, jitter() * 16).multiplyScalar(power);
          p.maxLife = 0.28 + Math.random() * 0.24; p.size = 0.26 + Math.random() * 0.3;
          p.gravity = -34; p.drag = 0.6; p.growth = -0.5; p.stretch = 2.4;
          break;
        case 'shard':
          p.vel.copy(dir).multiplyScalar(6 + Math.random() * 16 * power);
          p.vel.x += jitter() * 7; p.vel.y += 4 + Math.random() * 10; p.vel.z += jitter() * 7;
          p.maxLife = 0.5 + Math.random() * 0.4; p.size = 0.5 + Math.random() * 0.8;
          p.gravity = -40; p.drag = 0.4; p.growth = -0.4;
          break;
        case 'debris':
          p.vel.set(jitter() * 12, 6 + Math.random() * 16, jitter() * 12).multiplyScalar(power);
          p.maxLife = 0.8 + Math.random() * 0.7; p.size = 0.7 + Math.random() * 1.4;
          p.gravity = -48; p.drag = 0.25; p.growth = -0.2;
          break;
        case 'ring':
          p.vel.set(0, 0, 0);
          p.maxLife = 0.32; p.size = 1.6 * power; p.gravity = 0; p.drag = 0; p.growth = 34 * power; p.stretch = 0.12;
          break;
        case 'shock':
          p.vel.copy(dir).multiplyScalar(2);
          p.maxLife = 0.26; p.size = 2.4 * power; p.gravity = 0; p.drag = 0; p.growth = 52 * power; p.stretch = 0.08;
          break;
        case 'flame':
          p.vel.copy(dir).multiplyScalar(-8 - Math.random() * 10);
          p.vel.y += 2 + Math.random() * 3;
          p.maxLife = 0.2 + Math.random() * 0.18; p.size = 0.7 + Math.random() * 0.9;
          p.gravity = 4; p.drag = 3.4; p.growth = -1.6; p.stretch = 1.8;
          break;
        case 'ember':
          p.vel.set(jitter() * 2, 1 + Math.random() * 3, jitter() * 2);
          p.maxLife = 1.2 + Math.random(); p.size = 0.2 + Math.random() * 0.3;
          p.gravity = 1.2; p.drag = 0.8; p.growth = -0.1;
          break;
      }
      p.spin.set(jitter() * 9, jitter() * 9, jitter() * 9);
      p.life = p.maxLife;
    }
  }

  update(dt: number) {
    const q = new Quaternion();
    let visible = 0;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.items[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.tmp.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.tmp);
        this.fades[i] = 0;
        continue;
      }
      p.vel.y += p.gravity * dt;
      const dragK = Math.exp(-p.drag * dt);
      p.vel.multiplyScalar(dragK);
      p.pos.addScaledVector(p.vel, dt);
      q.setFromAxisAngle(_axis.set(p.spin.x, p.spin.y, p.spin.z).normalize(), p.spin.length() * dt);
      p.rot.multiply(q);
      const t = clamp01(p.life / p.maxLife);
      const size = Math.max(0.01, p.size + p.growth * (1 - t) * (p.growth > 2 ? 1 : 0.5));
      this.scale.set(size, size * p.stretch, size);
      this.tmp.compose(p.pos, p.rot, this.scale);
      this.mesh.setMatrixAt(i, this.tmp);
      this.colors[i * 3] = p.color.r;
      this.colors[i * 3 + 1] = p.color.g;
      this.colors[i * 3 + 2] = p.color.b;
      this.fades[i] = t;
      visible++;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.mesh.geometry.getAttribute('aColor') as InstancedBufferAttribute).needsUpdate = true;
    (this.mesh.geometry.getAttribute('aFade') as InstancedBufferAttribute).needsUpdate = true;
    this.activeCount = visible;
  }

  activeCount = 0;

  clear() {
    for (let i = 0; i < this.capacity; i++) {
      this.items[i].active = false;
      this.tmp.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.tmp);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const _axis = new Vector3(0, 1, 0);
