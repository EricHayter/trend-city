import { Quaternion, InstancedBufferAttribute, InstancedMesh, IcosahedronGeometry, Mesh, BoxGeometry, ShaderMaterial, Matrix4, Vector3,
  Color, AdditiveBlending, Group, DoubleSide } from 'three';
import { MaterialLibrary } from '../render/CelMaterial';
import { LAYER_FX } from '../render/Pipeline';
import { prepareOutlineGeometry } from '../render/Outline';
import { clamp01 } from '../core/MathX';

interface Orb { active: boolean; pos: Vector3; vel: Vector3; life: number; size: number; hostile: boolean; }
interface Wave { active: boolean; pos: Vector3; radius: number; maxRadius: number; power: number; life: number; }

const ORB_FRAG = /* glsl */ `
varying vec3 vN;
varying float vFade;
uniform vec3 uColor;
uniform vec3 uCore;
void main() {
  // Two hard bands and a rim: reads as a drawn energy shape, not a glow sprite.
  float k = dot(normalize(vN), vec3(0.3, 0.7, 0.4));
  float band = step(0.25, k) * 0.4 + step(0.7, k) * 0.6;
  vec3 c = mix(uColor, uCore, band);
  gl_FragColor = vec4(c, vFade);
}
`;
const ORB_VERT = /* glsl */ `
attribute float aFade;
varying vec3 vN;
varying float vFade;
void main() {
  vN = normalize(mat3(instanceMatrix) * normal);
  vFade = aFade;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

/**
 * PROJECTILES, SHOCKWAVES AND BEAMS
 * All pooled, all instanced, all resolved against the player with cheap sphere and
 * line tests. Danger volumes are separated from visuals so telegraphs can be generous
 * while the actual hit windows stay honest.
 */
export class CombatFx {
  root = new Group();
  orbMesh: InstancedMesh;
  private orbs: Orb[] = [];
  private waves: Wave[] = [];
  private fades: Float32Array;
  private tmp = new Matrix4();
  private scale = new Vector3();
  beam: Mesh;
  beamActive = false;
  private beamFrom = new Vector3();
  private beamDir = new Vector3();
  private beamLength = 0;
  private beamWidth = 0;
  onPlayerHit: ((amount: number, from: Vector3) => void) | null = null;
  onWaveVisual: ((pos: Vector3, radius: number) => void) | null = null;

  constructor(lib: MaterialLibrary, capacity = 160) {
    const geo = new IcosahedronGeometry(0.5, 1);
    this.fades = new Float32Array(capacity);
    const mat = new ShaderMaterial({
      vertexShader: ORB_VERT, fragmentShader: ORB_FRAG,
      uniforms: { uColor: { value: new Color(0xff3d9a) }, uCore: { value: new Color(0xfff0ff) } },
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    this.orbMesh = new InstancedMesh(geo, mat, capacity);
    this.orbMesh.frustumCulled = false;
    this.orbMesh.layers.set(LAYER_FX);
    (this.orbMesh as any).noOutline = true;
    geo.setAttribute('aFade', new InstancedBufferAttribute(this.fades, 1));
    for (let i = 0; i < capacity; i++) {
      this.orbs.push({ active: false, pos: new Vector3(), vel: new Vector3(), life: 0, size: 1, hostile: true });
      this.tmp.makeScale(0, 0, 0);
      this.orbMesh.setMatrixAt(i, this.tmp);
    }
    for (let i = 0; i < 24; i++) this.waves.push({ active: false, pos: new Vector3(), radius: 0, maxRadius: 10, power: 1, life: 0 });
    this.root.add(this.orbMesh);

    // Beam: a single reused stretched box with a banded additive material.
    const bmat = new ShaderMaterial({
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform float uT; uniform vec3 uA; uniform vec3 uB;
        void main(){
          float band = step(0.5, fract(vUv.y * 14.0 - uT * 3.0));
          float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
          vec3 c = mix(uA, uB, band);
          gl_FragColor = vec4(c, edge * 0.9);
        }`,
      uniforms: { uT: { value: 0 }, uA: { value: new Color(0xff3d9a) }, uB: { value: new Color(0xfff0ff) } },
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
    });
    this.beam = new Mesh(new BoxGeometry(1, 1, 1), bmat);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.beam.layers.set(LAYER_FX);
    (this.beam as any).noOutline = true;
    this.root.add(this.beam);
  }

  fireOrb(pos: Vector3, dir: Vector3, speed: number, size: number, hostile = true) {
    for (const o of this.orbs) {
      if (o.active) continue;
      o.active = true;
      o.pos.copy(pos);
      o.vel.copy(dir).normalize().multiplyScalar(speed);
      o.life = 3.4;
      o.size = size;
      o.hostile = hostile;
      return;
    }
  }

  shockwave(pos: Vector3, radius: number, power: number) {
    for (const w of this.waves) {
      if (w.active) continue;
      w.active = true;
      w.pos.copy(pos);
      w.radius = 1;
      w.maxRadius = radius;
      w.power = power;
      w.life = 0.6;
      if (this.onWaveVisual) this.onWaveVisual(pos, radius);
      return;
    }
  }

  setBeam(from: Vector3, dir: Vector3, length: number, width: number) {
    this.beamActive = true;
    this.beamFrom.copy(from);
    this.beamDir.copy(dir).normalize();
    this.beamLength = length;
    this.beamWidth = width;
  }

  update(dt: number, playerPos: Vector3, playerRadius: number, invulnerable: boolean) {
    let i = 0;
    for (const o of this.orbs) {
      const idx = i++;
      if (!o.active) { this.fades[idx] = 0; continue; }
      o.life -= dt;
      o.pos.addScaledVector(o.vel, dt);
      if (o.hostile) {
        const d = o.pos.distanceTo(playerPos);
        if (d < playerRadius + o.size) {
          o.active = false;
          if (!invulnerable && this.onPlayerHit) this.onPlayerHit(1, o.pos);
        }
      }
      if (o.life <= 0) o.active = false;
      if (!o.active) {
        this.tmp.makeScale(0, 0, 0);
        this.orbMesh.setMatrixAt(idx, this.tmp);
        this.fades[idx] = 0;
        continue;
      }
      const s = o.size * (1 + Math.sin(o.life * 22) * 0.08);
      this.scale.set(s, s, s);
      this.tmp.compose(o.pos, _idQ, this.scale);
      this.orbMesh.setMatrixAt(idx, this.tmp);
      this.fades[idx] = clamp01(o.life * 2);
    }
    this.orbMesh.instanceMatrix.needsUpdate = true;
    (this.orbMesh.geometry.getAttribute('aFade') as any).needsUpdate = true;

    for (const w of this.waves) {
      if (!w.active) continue;
      w.life -= dt;
      w.radius += (w.maxRadius / 0.6) * dt;
      const dx = playerPos.x - w.pos.x, dz = playerPos.z - w.pos.z;
      const dist = Math.hypot(dx, dz);
      const dy = Math.abs(playerPos.y - w.pos.y);
      // Only the leading edge hurts, and only near the ground: jumping clears it.
      if (dy < 3.2 && Math.abs(dist - w.radius) < 2.6 && !invulnerable && this.onPlayerHit) {
        this.onPlayerHit(w.power > 0.8 ? 1 : 1, w.pos);
      }
      if (w.life <= 0) w.active = false;
    }

    if (this.beamActive) {
      const mat = this.beam.material as ShaderMaterial;
      mat.uniforms.uT.value += dt;
      this.beam.visible = true;
      const mid = _v.copy(this.beamFrom).addScaledVector(this.beamDir, this.beamLength * 0.5);
      this.beam.position.copy(mid);
      this.beam.scale.set(this.beamWidth, this.beamWidth, this.beamLength);
      this.beam.lookAt(_v2.copy(this.beamFrom).addScaledVector(this.beamDir, this.beamLength));
      // Point to line distance for the hit test.
      _v.subVectors(playerPos, this.beamFrom);
      const along = clamp01(_v.dot(this.beamDir) / this.beamLength) * this.beamLength;
      _v2.copy(this.beamFrom).addScaledVector(this.beamDir, along);
      if (_v2.distanceTo(playerPos) < this.beamWidth * 0.6 + playerRadius && !invulnerable && this.onPlayerHit) {
        this.onPlayerHit(1, _v2);
      }
      this.beamActive = false;
    } else {
      this.beam.visible = false;
    }
  }

  clear() {
    for (const o of this.orbs) o.active = false;
    for (const w of this.waves) w.active = false;
    this.beam.visible = false;
  }
}

const _v = new Vector3();
const _v2 = new Vector3();
const _idQ = new Quaternion();
