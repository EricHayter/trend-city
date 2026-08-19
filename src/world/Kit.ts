/**
 * Kit — the ONLY way geometry enters the world.
 *
 * Every procedural module, prop, landmark and set piece is built through these
 * calls. One call produces, together and consistently:
 *
 *   • merged visual geometry in a material bucket (few draw calls per module)
 *   • the matching collision triangles with surface flags
 *   • outline attributes (oNormal / oCurv) authored at emit time
 *
 * Authoring outline attributes here instead of welding afterwards is a big win:
 * we already know the smooth normal and the corner sharpness for every vertex we
 * emit, so the ink hull is exactly right and costs no load-time weld pass.
 *
 * CONVENTIONS (see Types.ts): metres, Y up, module-local space with the entry
 * frame at the origin facing +Z. `begin(id, kind, base)` installs the placement
 * matrix, so modules always author locally and the Kit bakes to world space.
 */
import * as THREE from 'three';
import { celShared, type CelOptions } from '../render/CelMaterial';
import { addOutline } from '../render/Outline';
import {
  concreteTexture, metalTexture, gridTexture, hazardTexture, energyTexture, facadeTextures,
} from '../render/Textures';
import type { MatClassName, Biome } from '../render/Palette';
import { C } from '../render/Palette';
import type { Rng } from '../core/Rng';
import { CollisionWorld } from './Collision';
import { SF, type V3, type RailSpec, type VolumeSpec, type EnemySpawn, type PickupSpawn, type RouteSpec, type ModuleKind } from './Types';

export type TexKind = 'none' | 'concrete' | 'metal' | 'grid' | 'hazard' | 'energy' | 'facade' | 'panel';

/** Everything that decides what a surface looks like and how it behaves. */
export interface SurfOpt {
  cls?: MatClassName;
  tex?: TexKind;
  /** multiplies the generated texture; the main per-zone colour knob */
  tint?: string;
  /** flat colour multiplier applied on top of the map */
  color?: string;
  /** world units per texture tile (triplanar) */
  uvScale?: number;
  emissive?: string;
  emissiveIntensity?: number;
  /** SF bitmask written onto every collision triangle this call emits */
  flags?: number;
  /** side/vertical faces get these instead (walls of a deck, sides of a box) */
  sideFlags?: number;
  collide?: boolean;
  ink?: boolean;
  inkWidth?: number;
  unlit?: boolean;
  matcap?: number;
  scroll?: number;
  pulse?: [number, number];
  transparent?: boolean;
  opacity?: number;
  additive?: boolean;
  /** facade variation / grid divisions */
  seed?: number;
  div?: number;
  /** ink hull sharpness multiplier for this call */
  curv?: number;
  /** render order nudge (glass, decals) */
  order?: number;
}

interface Bucket {
  key: string;
  mat: THREE.RawShaderMaterial;
  ink: boolean;
  inkWidth: number | undefined;
  cls: MatClassName;
  order: number;
  pos: Float32Array; nrm: Float32Array; uv: Float32Array;
  on: Float32Array; oc: Float32Array;
  idx: Uint32Array;
  vc: number; ic: number;
}

interface PropBank {
  geo: THREE.BufferGeometry;
  mat: THREE.RawShaderMaterial;
  cls: MatClassName;
  ink: boolean;
  m: number[];      // flat 16-per-instance
}

function growF(a: Float32Array, need: number) {
  if (need <= a.length) return a;
  const b = new Float32Array(Math.max(need, a.length * 2 + 1024));
  b.set(a); return b;
}
function growU(a: Uint32Array, need: number) {
  if (need <= a.length) return a;
  const b = new Uint32Array(Math.max(need, a.length * 2 + 1024));
  b.set(a); return b;
}

/** Result of one module build, ready for the assembler. */
export interface KitModule {
  id: string;
  kind: ModuleKind;
  group: THREE.Group;
  tris: number;
  colliderTris: number;
  bounds: THREE.Box3;
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

export class Kit {
  readonly collision: CollisionWorld;
  biome: Biome;
  rng: Rng;

  /** matrix stack — [0] is the module placement matrix */
  private stack: THREE.Matrix4[] = [];
  private sp = 0;
  private nrmMat = new THREE.Matrix3();

  private buckets = new Map<string, Bucket>();
  private props = new Map<string, PropBank>();

  private curId = '';
  private curKind: ModuleKind = 'straight';
  private bounds = new THREE.Box3();

  // gameplay collectors, world space, cleared per module
  rails: RailSpec[] = [];
  volumes: VolumeSpec[] = [];
  enemies: EnemySpawn[] = [];
  pickups: PickupSpawn[] = [];
  routes: RouteSpec[] = [];

  stats = { tris: 0, colliderTris: 0, drawCalls: 0, props: 0 };

  constructor(collision: CollisionWorld, biome: Biome, rng: Rng) {
    this.collision = collision;
    this.biome = biome;
    this.rng = rng;
    for (let i = 0; i < 24; i++) this.stack.push(new THREE.Matrix4());
  }

  // ─────────────────────────────────────────────── lifecycle

  begin(id: string, kind: ModuleKind, base: THREE.Matrix4) {
    this.curId = id; this.curKind = kind;
    this.sp = 0;
    this.stack[0].copy(base);
    this.nrmMat.setFromMatrix4(this.stack[0]).invert().transpose();
    this.buckets.clear();
    this.rails.length = 0; this.volumes.length = 0;
    this.enemies.length = 0; this.pickups.length = 0; this.routes.length = 0;
    this.bounds.makeEmpty();
  }

  end(): KitModule {
    const g = new THREE.Group();
    g.name = this.curId;
    g.matrixAutoUpdate = false;   // verts are already world space
    let tris = 0;
    for (const b of this.buckets.values()) {
      if (b.vc === 0 || b.ic === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b.pos.subarray(0, b.vc * 3), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(b.nrm.subarray(0, b.vc * 3), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(b.uv.subarray(0, b.vc * 2), 2));
      geo.setAttribute('oNormal', new THREE.BufferAttribute(b.on.subarray(0, b.vc * 3), 3));
      geo.setAttribute('oCurv', new THREE.BufferAttribute(b.oc.subarray(0, b.vc), 1));
      geo.setIndex(new THREE.BufferAttribute(b.idx.subarray(0, b.ic), 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, b.mat);
      mesh.name = `${this.curId}:${b.cls}`;
      mesh.layers.set(0);
      mesh.layers.enable(2);        // casts into the cel shadow map
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = b.order;
      g.add(mesh);
      if (b.ink) addOutline(mesh, { cls: b.cls, width: b.inkWidth });
      if (geo.boundingBox) this.bounds.union(geo.boundingBox);
      tris += b.ic / 3;
      this.stats.drawCalls++;
    }
    this.stats.tris += tris;
    return {
      id: this.curId, kind: this.curKind, group: g, tris,
      colliderTris: 0, bounds: this.bounds.clone(),
    };
  }

  /** Builds one InstancedMesh per prop type. Call once, after all modules. */
  finalizeProps(root: THREE.Object3D) {
    for (const [key, p] of this.props) {
      const n = p.m.length / 16;
      if (n === 0) continue;
      const im = new THREE.InstancedMesh(p.geo, p.mat, n);
      const arr = im.instanceMatrix.array as Float32Array;
      for (let i = 0; i < n * 16; i++) arr[i] = p.m[i];
      im.instanceMatrix.needsUpdate = true;
      im.name = 'prop:' + key;
      im.layers.set(0);
      im.layers.enable(2);
      im.matrixAutoUpdate = false;
      im.frustumCulled = false;      // spans the stage; culled per-module instead
      root.add(im);
      if (p.ink) addOutline(im, { cls: p.cls });
      this.stats.props += n;
      this.stats.tris += n * (p.geo.index ? p.geo.index.count / 3 : 0);
      this.stats.drawCalls++;
    }
    this.props.clear();
  }

  // ─────────────────────────────────────────────── transform stack

  push(): THREE.Matrix4 {
    const cur = this.stack[this.sp];
    this.sp++;
    this.stack[this.sp].copy(cur);
    return this.stack[this.sp];
  }
  /** push a local translate/rotate/scale onto the stack */
  pushTRS(x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0, sx = 1, sy = 1, sz = 1) {
    const m = this.push();
    _m.makeRotationFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    _m.setPosition(x, y, z);
    _m.scale(_v.set(sx, sy, sz));
    m.multiply(_m);
    this.nrmMat.setFromMatrix4(m).invert().transpose();
    return m;
  }
  pop() {
    if (this.sp > 0) this.sp--;
    this.nrmMat.setFromMatrix4(this.stack[this.sp]).invert().transpose();
  }
  get xf() { return this.stack[this.sp]; }

  // world-space transform of a local point, into tx/ty/tz
  private tx = 0; private ty = 0; private tz = 0;
  private pt(x: number, y: number, z: number) {
    const e = this.stack[this.sp].elements;
    this.tx = e[0] * x + e[4] * y + e[8] * z + e[12];
    this.ty = e[1] * x + e[5] * y + e[9] * z + e[13];
    this.tz = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  private nx2 = 0; private ny2 = 0; private nz2 = 0;
  private nv(x: number, y: number, z: number) {
    const e = this.nrmMat.elements;
    let a = e[0] * x + e[3] * y + e[6] * z;
    let b = e[1] * x + e[4] * y + e[7] * z;
    let c = e[2] * x + e[5] * y + e[8] * z;
    const l = Math.sqrt(a * a + b * b + c * c) || 1;
    this.nx2 = a / l; this.ny2 = b / l; this.nz2 = c / l;
  }
  /** public: local point to world, into a caller Vector3 */
  toWorld(x: number, y: number, z: number, out: THREE.Vector3) {
    this.pt(x, y, z); return out.set(this.tx, this.ty, this.tz);
  }

  // ─────────────────────────────────────────────── material resolution

  private matKey(o: SurfOpt): string {
    return [
      o.cls ?? 'concrete', o.tex ?? 'none', o.tint ?? '-', o.color ?? '-',
      o.uvScale ?? 0, o.emissive ?? '-', o.emissiveIntensity ?? 1,
      o.unlit ? 1 : 0, o.matcap ?? -1, o.scroll ?? 0,
      o.pulse ? o.pulse.join(',') : '-', o.transparent ? 1 : 0, o.opacity ?? 1,
      o.additive ? 1 : 0, o.seed ?? 0, o.div ?? 0,
    ].join('|');
  }

  /** Single place where a SurfOpt becomes CelOptions (textures included). */
  private celOpts(o: SurfOpt): CelOptions {
    const cls: MatClassName = o.cls ?? 'concrete';
    const tint = o.tint ?? '#ffffff';
    const co: CelOptions = {
      cls,
      color: o.color,
      uvMode: 'triplanar',
      uvScale: o.uvScale ?? 6,
      unlit: o.unlit,
      matcap: o.matcap,
      scroll: o.scroll,
      pulse: o.pulse,
      transparent: o.transparent,
      opacity: o.opacity,
      additive: o.additive,
      emissive: o.emissive,
      emissiveIntensity: o.emissiveIntensity,
    };
    switch (o.tex ?? 'none') {
      case 'concrete': co.map = concreteTexture(tint); break;
      case 'metal': co.map = metalTexture(tint); co.uvScale = o.uvScale ?? 4; break;
      case 'hazard': co.map = hazardTexture(o.tint ?? C.gold); co.uvScale = o.uvScale ?? 2.4; break;
      case 'energy': co.map = energyTexture(o.tint ?? C.volt, '#08040f'); co.uvScale = o.uvScale ?? 3; break;
      case 'grid': {
        const g = gridTexture(o.tint ?? C.volt, '#0a0618', o.div ?? 8);
        co.map = g.albedo; co.emissiveMap = g.emissive;
        co.emissive = o.emissive ?? (o.tint ?? C.volt);
        co.emissiveIntensity = o.emissiveIntensity ?? 1.1;
        co.uvScale = o.uvScale ?? 8;
        break;
      }
      case 'facade': {
        const fa = this.biome.facade;
        const f = facadeTextures(
          o.tint ?? fa.body, fa.frame, o.emissive ?? fa.lit,
          o.seed ?? 1, fa.cols, fa.rows, fa.litChance,
        );
        co.map = f.albedo; co.emissiveMap = f.emissive;
        co.emissive = o.emissive ?? fa.lit;
        co.emissiveIntensity = o.emissiveIntensity ?? 1.35;
        co.uvScale = o.uvScale ?? 14;
        break;
      }
      case 'panel': co.map = metalTexture(tint); co.uvScale = o.uvScale ?? 1.6; break;
    }
    return co;
  }

  private buildMat(o: SurfOpt, key: string): THREE.RawShaderMaterial {
    return celShared('kit:' + key, this.celOpts(o));
  }

  private bucket(o: SurfOpt): Bucket {
    const key = this.matKey(o);
    let b = this.buckets.get(key);
    if (b) return b;
    b = {
      key, mat: this.buildMat(o, key),
      ink: o.ink !== false, inkWidth: o.inkWidth,
      cls: o.cls ?? 'concrete',
      order: o.order ?? 0,
      pos: new Float32Array(3072), nrm: new Float32Array(3072), uv: new Float32Array(2048),
      on: new Float32Array(3072), oc: new Float32Array(1024),
      idx: new Uint32Array(4096), vc: 0, ic: 0,
    };
    this.buckets.set(key, b);
    return b;
  }

  // ─────────────────────────────────────────────── raw vertex writing

  private cb: Bucket | null = null;
  private cFlags: number = SF.SOLID;
  private cCollide = true;
  private cCurv = 1;

  private open(o: SurfOpt) {
    this.cb = this.bucket(o);
    this.cFlags = o.flags ?? SF.SOLID;
    this.cCollide = o.collide !== false;
    this.cCurv = o.curv ?? 1;
  }

  /** emit one vertex (local space in, world space stored); returns its index */
  private v(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, vv: number,
    ox: number, oy: number, oz: number, oc: number,
  ): number {
    const b = this.cb!;
    const i = b.vc++;
    b.pos = growF(b.pos, b.vc * 3); b.nrm = growF(b.nrm, b.vc * 3);
    b.on = growF(b.on, b.vc * 3); b.uv = growF(b.uv, b.vc * 2);
    b.oc = growF(b.oc, b.vc);
    this.pt(x, y, z);
    b.pos[i * 3] = this.tx; b.pos[i * 3 + 1] = this.ty; b.pos[i * 3 + 2] = this.tz;
    this.nv(nx, ny, nz);
    b.nrm[i * 3] = this.nx2; b.nrm[i * 3 + 1] = this.ny2; b.nrm[i * 3 + 2] = this.nz2;
    this.nv(ox, oy, oz);
    b.on[i * 3] = this.nx2; b.on[i * 3 + 1] = this.ny2; b.on[i * 3 + 2] = this.nz2;
    b.uv[i * 2] = u; b.uv[i * 2 + 1] = vv;
    b.oc[i] = oc * this.cCurv;
    return i;
  }

  /**
   * Emit one triangle into the open bucket, and its collision twin.
   *
   * The winding is CORRECTED HERE rather than trusted from the caller. Every
   * vertex already carries the outward normal we want the surface to shade
   * with, so if the triangle's geometric normal disagrees with the average of
   * its three shading normals, the triangle is wound inward and we swap two
   * indices. That matters much more than it sounds: with inverted winding the
   * FrontSide cel material draws the *far* faces of a solid (which still looks
   * plausible, because shading comes from the normal attribute), while the
   * BackSide ink hull draws the *near* faces pushed outward — so the ink lands
   * in front of the surface and floods it solid. Making f3 self-correcting
   * immunises every primitive, present and future, against that whole class of
   * bug, including mirrored placement matrices that flip handedness.
   */
  private f3(a: number, b2: number, c: number, flags: number = this.cFlags) {
    const b = this.cb!;
    const p = b.pos, nr = b.nrm;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const e1x = p[b2 * 3] - ax, e1y = p[b2 * 3 + 1] - ay, e1z = p[b2 * 3 + 2] - az;
    const e2x = p[c * 3] - ax, e2y = p[c * 3 + 1] - ay, e2z = p[c * 3 + 2] - az;
    const gx = e1y * e2z - e1z * e2y, gy = e1z * e2x - e1x * e2z, gz = e1x * e2y - e1y * e2x;
    const sx = nr[a * 3] + nr[b2 * 3] + nr[c * 3];
    const sy = nr[a * 3 + 1] + nr[b2 * 3 + 1] + nr[c * 3 + 1];
    const sz = nr[a * 3 + 2] + nr[b2 * 3 + 2] + nr[c * 3 + 2];
    if (gx * sx + gy * sy + gz * sz < 0) { const t = b2; b2 = c; c = t; }

    b.idx = growU(b.idx, b.ic + 3);
    b.idx[b.ic++] = a; b.idx[b.ic++] = b2; b.idx[b.ic++] = c;
    if (this.cCollide) {
      this.collision.addTri(
        ax, ay, az,
        p[b2 * 3], p[b2 * 3 + 1], p[b2 * 3 + 2],
        p[c * 3], p[c * 3 + 1], p[c * 3 + 2],
        flags,
      );
      this.stats.colliderTris++;
    }
  }
  private f4(a: number, b: number, c: number, d: number, flags: number = this.cFlags) {
    this.f3(a, b, c, flags); this.f3(a, c, d, flags);
  }

  // ─────────────────────────────────────────────── primitives

  /**
   * Axis-aligned-in-local-space box, centre (cx,cy,cz), full sizes (sx,sy,sz).
   * Corner ink normals point along the body diagonal, which is what a welded
   * pass would produce — sharp, even ink on every silhouette.
   */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, o: SurfOpt = {}) {
    this.open(o);
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const s = o.sideFlags ?? this.cFlags;
    const top = this.cFlags;
    const K = 0.5773502692;
    // face table: normal, then 4 corners as sign triples, uv axes
    const F: Array<[number, number, number, number[], number, number]> = [
      [0, 1, 0, [-1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1], 0, 2],   // +Y
      [0, -1, 0, [-1, -1, 1, 1, -1, 1, 1, -1, -1, -1, -1, -1], 0, 2], // -Y
      [1, 0, 0, [1, -1, 1, 1, 1, 1, 1, 1, -1, 1, -1, -1], 2, 1],   // +X
      [-1, 0, 0, [-1, -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1], 2, 1], // -X
      [0, 0, 1, [-1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1, 1], 0, 1],   // +Z
      [0, 0, -1, [1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, -1], 0, 1], // -Z
    ];
    const sizes = [sx, sy, sz];
    for (let fi = 0; fi < 6; fi++) {
      const [nx, ny, nz, corners, ua, va] = F[fi];
      const iv: number[] = [];
      for (let k = 0; k < 4; k++) {
        const gx = corners[k * 3], gy = corners[k * 3 + 1], gz = corners[k * 3 + 2];
        const px = cx + gx * hx, py = cy + gy * hy, pz = cz + gz * hz;
        const lp = [px, py, pz];
        iv.push(this.v(px, py, pz, nx, ny, nz, lp[ua], lp[va], gx * K, gy * K, gz * K, 1));
      }
      this.f4(iv[0], iv[1], iv[2], iv[3], ny > 0.5 ? top : ny < -0.5 ? s : s);
    }
    void sizes;
  }

  /**
   * Solid deck swept along a centreline. This is the universal traversal
   * surface: roads, ramps, bridges, banked curves and platforms are all this
   * call with different sample arrays. Closed (top + bottom + both sides + end
   * caps) so the inverted hull produces a real silhouette line.
   *
   * @param pts   x,y,z per section (n * 3)
   * @param hw    half width, per section or scalar
   * @param roll  bank angle in radians, per section or scalar
   */
  deck(
    pts: Float32Array, n: number,
    hw: number | Float32Array,
    thick: number,
    o: SurfOpt & { roll?: number | Float32Array; wsegs?: number; capStart?: boolean; capEnd?: boolean } = {},
  ) {
    if (n < 2) return;
    this.open(o);
    const side = o.sideFlags ?? SF.SOLID;
    const top = this.cFlags;
    const HW = (i: number) => (typeof hw === 'number' ? hw : hw[i]);
    const RL = (i: number) => (o.roll === undefined ? 0 : typeof o.roll === 'number' ? o.roll : o.roll[i]);
    const ws = Math.max(1, o.wsegs ?? Math.min(6, Math.max(1, Math.round(HW(0) * 2 / 7))));

    // per-section frame + the 4 corner ink normals
    const rt = new Float32Array(n * 3), up = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = pts[b * 3] - pts[a * 3], ty = pts[b * 3 + 1] - pts[a * 3 + 1], tz = pts[b * 3 + 2] - pts[a * 3 + 2];
      let tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      // right = normalize(cross(worldUp, tangent)); with FORWARD = +Z this is
      // +X, matching the authoring convention in Types.ts. Getting the sign
      // wrong here inverts `up` below and builds the whole deck upside down.
      let rx = tz, rz = -tx, ry = 0;
      let rl = Math.hypot(rx, ry, rz);
      if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; }
      rx /= rl; ry /= rl; rz /= rl;
      // up = cross(tangent, right)
      let ux = ty * rz - tz * ry, uy = tz * rx - tx * rz, uz = tx * ry - ty * rx;
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const r = RL(i);
      if (r !== 0) {
        const c = Math.cos(r), s2 = Math.sin(r);
        const nrx = rx * c + ux * s2, nry = ry * c + uy * s2, nrz = rz * c + uz * s2;
        const nux = ux * c - rx * s2, nuy = uy * c - ry * s2, nuz = uz * c - rz * s2;
        rx = nrx; ry = nry; rz = nrz; ux = nux; uy = nuy; uz = nuz;
      }
      rt[i * 3] = rx; rt[i * 3 + 1] = ry; rt[i * 3 + 2] = rz;
      up[i * 3] = ux; up[i * 3 + 1] = uy; up[i * 3 + 2] = uz;
    }

    // ---- top surface (subdivided across width so collision cells stay tight)
    const rowTop: number[] = [], rowBot: number[] = [];
    const K = 0.7071;
    for (let i = 0; i < n; i++) {
      const cxp = pts[i * 3], cyp = pts[i * 3 + 1], czp = pts[i * 3 + 2];
      const rx = rt[i * 3], ry = rt[i * 3 + 1], rz = rt[i * 3 + 2];
      const ux = up[i * 3], uy = up[i * 3 + 1], uz = up[i * 3 + 2];
      const w = HW(i);
      for (let j = 0; j <= ws; j++) {
        const t = j / ws * 2 - 1;               // -1 .. +1 across the deck
        const px = cxp + rx * w * t, py = cyp + ry * w * t, pz = czp + rz * w * t;
        const edge = j === 0 ? -1 : j === ws ? 1 : 0;
        const oc = edge === 0 ? 0.06 : 0.9;
        const ox = ux + rx * edge * K * 1.3, oy = uy + ry * edge * K * 1.3, oz = uz + rz * edge * K * 1.3;
        rowTop.push(this.v(px, py, pz, ux, uy, uz, px, pz, ox, oy, oz, oc));
        rowBot.push(this.v(
          px - ux * thick, py - uy * thick, pz - uz * thick,
          -ux, -uy, -uz, px, pz,
          -ux + rx * edge * K * 1.3, -uy + ry * edge * K * 1.3, -uz + rz * edge * K * 1.3, oc,
        ));
      }
    }
    const stride = ws + 1;
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < ws; j++) {
        const a = i * stride + j, b = a + 1, c = (i + 1) * stride + j + 1, d = (i + 1) * stride + j;
        this.f4(rowTop[a], rowTop[d], rowTop[c], rowTop[b], top);
        this.f4(rowBot[a], rowBot[b], rowBot[c], rowBot[d], side);
      }
    }
    // ---- side walls, using dedicated verts so the normal is the wall normal
    for (const s of [-1, 1] as const) {
      const j = s < 0 ? 0 : ws;
      const vt: number[] = [], vb: number[] = [];
      for (let i = 0; i < n; i++) {
        const cxp = pts[i * 3], cyp = pts[i * 3 + 1], czp = pts[i * 3 + 2];
        const rx = rt[i * 3], ry = rt[i * 3 + 1], rz = rt[i * 3 + 2];
        const ux = up[i * 3], uy = up[i * 3 + 1], uz = up[i * 3 + 2];
        const w = HW(i);
        const t = j / ws * 2 - 1;
        const px = cxp + rx * w * t, py = cyp + ry * w * t, pz = czp + rz * w * t;
        const nx = rx * s, ny = ry * s, nz = rz * s;
        vt.push(this.v(px, py, pz, nx, ny, nz, px + pz, py, ux + nx * K * 1.3, uy + ny * K * 1.3, uz + nz * K * 1.3, 0.9));
        vb.push(this.v(px - ux * thick, py - uy * thick, pz - uz * thick, nx, ny, nz, px + pz, py - thick,
          -ux + nx * K * 1.3, -uy + ny * K * 1.3, -uz + nz * K * 1.3, 0.9));
      }
      for (let i = 0; i < n - 1; i++) {
        if (s > 0) this.f4(vt[i], vb[i], vb[i + 1], vt[i + 1], side);
        else this.f4(vt[i], vt[i + 1], vb[i + 1], vb[i], side);
      }
    }
    // ---- end caps keep the hull closed at module joins
    if (o.capStart !== false) this.deckCap(pts, rt, up, HW(0), thick, 0, -1, ws, side);
    if (o.capEnd !== false) this.deckCap(pts, rt, up, HW(n - 1), thick, n - 1, 1, ws, side);
  }

  private deckCap(
    pts: Float32Array, rt: Float32Array, up: Float32Array,
    w: number, thick: number, i: number, dir: number, ws: number, flags: number,
  ) {
    const cxp = pts[i * 3], cyp = pts[i * 3 + 1], czp = pts[i * 3 + 2];
    const rx = rt[i * 3], ry = rt[i * 3 + 1], rz = rt[i * 3 + 2];
    const ux = up[i * 3], uy = up[i * 3 + 1], uz = up[i * 3 + 2];
    // cap normal = tangent * dir; tangent = cross(right, up)
    let nx = ry * uz - rz * uy, ny = rz * ux - rx * uz, nz = rx * uy - ry * ux;
    const l = Math.hypot(nx, ny, nz) || 1; nx = nx / l * dir; ny = ny / l * dir; nz = nz / l * dir;
    const K = 0.7071;
    const q: number[] = [];
    for (const [t, dy] of [[-1, 0], [1, 0], [1, -1], [-1, -1]] as Array<[number, number]>) {
      const px = cxp + rx * w * t + ux * thick * dy;
      const py = cyp + ry * w * t + uy * thick * dy;
      const pz = czp + rz * w * t + uz * thick * dy;
      const oy2 = dy === 0 ? 1 : -1;
      q.push(this.v(px, py, pz, nx, ny, nz, px + pz, py,
        nx + rx * t * K + ux * oy2 * K, ny + ry * t * K + uy * oy2 * K, nz + rz * t * K + uz * oy2 * K, 1));
    }
    if (dir > 0) this.f4(q[0], q[1], q[2], q[3], flags);
    else this.f4(q[0], q[3], q[2], q[1], flags);
    void ws;
  }

  /**
   * Vertical wall between two XZ points. The two long faces get WALLRUN unless
   * overridden, which is how every wall-run section is authored.
   */
  wall(
    x0: number, z0: number, x1: number, z1: number,
    baseY: number, height: number, thick: number,
    o: SurfOpt = {},
  ) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    const yaw = Math.atan2(dx, dz);
    this.pushTRS((x0 + x1) / 2, baseY + height / 2, (z0 + z1) / 2, yaw);
    this.box(0, 0, 0, thick, height, len, {
      flags: SF.SOLID,
      sideFlags: SF.SOLID | SF.WALLRUN,
      ...o,
    });
    this.pop();
  }

  /** Cylinder / cone / tower. rTop === 0 gives a cone. */
  cyl(
    cx: number, cy: number, cz: number,
    rBot: number, rTop: number, h: number, seg: number,
    o: SurfOpt & { caps?: boolean; open?: boolean } = {},
  ) {
    this.open(o);
    const side = o.sideFlags ?? this.cFlags;
    const sharp = seg <= 8 ? 0.95 : seg <= 16 ? 0.55 : 0.3;
    const bot: number[] = [], topR: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const u = i / seg * Math.max(rBot, rTop) * 2;
      bot.push(this.v(cx + ca * rBot, cy, cz + sa * rBot, ca, 0, sa, u, 0, ca * 0.86, -0.5, sa * 0.86, sharp));
      topR.push(this.v(cx + ca * rTop, cy + h, cz + sa * rTop, ca, 0, sa, u, h, ca * 0.86, 0.5, sa * 0.86, sharp));
    }
    for (let i = 0; i < seg; i++) this.f4(bot[i], bot[i + 1], topR[i + 1], topR[i], side);
    if (o.caps !== false) {
      if (rTop > 1e-4) {
        const cIdx = this.v(cx, cy + h, cz, 0, 1, 0, cx, cz, 0, 1, 0, 0.05);
        const ring: number[] = [];
        for (let i = 0; i <= seg; i++) {
          const a = i / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          ring.push(this.v(cx + ca * rTop, cy + h, cz + sa * rTop, 0, 1, 0, cx + ca * rTop, cz + sa * rTop, ca * 0.7, 0.7, sa * 0.7, 1));
        }
        for (let i = 0; i < seg; i++) this.f3(cIdx, ring[i], ring[i + 1], this.cFlags);
      }
      if (rBot > 1e-4 && o.open !== true) {
        const cIdx = this.v(cx, cy, cz, 0, -1, 0, cx, cz, 0, -1, 0, 0.05);
        const ring: number[] = [];
        for (let i = 0; i <= seg; i++) {
          const a = i / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          ring.push(this.v(cx + ca * rBot, cy, cz + sa * rBot, 0, -1, 0, cx + ca * rBot, cz + sa * rBot, ca * 0.7, -0.7, sa * 0.7, 1));
        }
        for (let i = 0; i < seg; i++) this.f3(cIdx, ring[i + 1], ring[i], side);
      }
    }
  }

  /** Swept ring along a path: pipes, ducts, cables, tube rails. */
  tube(pts: Float32Array, n: number, r: number, seg: number, o: SurfOpt = {}) {
    if (n < 2) return;
    this.open(o);
    const sharp = seg <= 6 ? 0.9 : seg <= 12 ? 0.5 : 0.28;
    const rings: number[][] = [];
    let px2 = 0, py2 = 1, pz2 = 0;   // carried reference up-vector
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = pts[b * 3] - pts[a * 3], ty = pts[b * 3 + 1] - pts[a * 3 + 1], tz = pts[b * 3 + 2] - pts[a * 3 + 2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      // parallel transport: keep the frame from twisting along the path
      let ux = px2, uy = py2, uz = pz2;
      const d = ux * tx + uy * ty + uz * tz;
      ux -= tx * d; uy -= ty * d; uz -= tz * d;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-3) { ux = 0; uy = 0; uz = 1; ul = 1; }
      ux /= ul; uy /= ul; uz /= ul;
      px2 = ux; py2 = uy; pz2 = uz;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      const ring: number[] = [];
      const cxp = pts[i * 3], cyp = pts[i * 3 + 1], czp = pts[i * 3 + 2];
      for (let j = 0; j <= seg; j++) {
        const ang = j / seg * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
        const nx = ux * ca + vx * sa, ny = uy * ca + vy * sa, nz = uz * ca + vz * sa;
        ring.push(this.v(cxp + nx * r, cyp + ny * r, czp + nz * r, nx, ny, nz, j / seg * r * 6.283, i, nx, ny, nz, sharp));
      }
      rings.push(ring);
    }
    for (let i = 0; i < n - 1; i++)
      for (let j = 0; j < seg; j++)
        this.f4(rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]);
  }

  /**
   * Thin decorative panel from four explicit corners. No collision, no ink by
   * default — signage, glass, banners, solar arrays, holograms.
   */
  panel(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    o: SurfOpt = {},
  ) {
    this.open({ collide: false, ink: false, ...o });
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const i0 = this.v(ax, ay, az, nx, ny, nz, ax, az, nx, ny, nz, 0.04);
    const i1 = this.v(bx, by, bz, nx, ny, nz, bx, bz, nx, ny, nz, 0.04);
    const i2 = this.v(cx, cy, cz, nx, ny, nz, cx, cz, nx, ny, nz, 0.04);
    const i3 = this.v(dx, dy, dz, nx, ny, nz, dx, dz, nx, ny, nz, 0.04);
    this.f4(i0, i1, i2, i3);
    // backface so a panel is never invisible from one side
    const j0 = this.v(ax, ay, az, -nx, -ny, -nz, ax, az, -nx, -ny, -nz, 0.04);
    const j1 = this.v(bx, by, bz, -nx, -ny, -nz, bx, bz, -nx, -ny, -nz, 0.04);
    const j2 = this.v(cx, cy, cz, -nx, -ny, -nz, cx, cz, -nx, -ny, -nz, 0.04);
    const j3 = this.v(dx, dy, dz, -nx, -ny, -nz, dx, dz, -nx, -ny, -nz, 0.04);
    this.f4(j0, j3, j2, j1);
  }

  /** Collision-only surface: invisible walls, kill volumes floors, guides. */
  clip(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, flags: number = SF.SOLID) {
    const e = this.stack[this.sp];
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const P: number[][] = [];
    for (let i = 0; i < 8; i++) {
      const gx = (i & 1) ? 1 : -1, gy = (i & 2) ? 1 : -1, gz = (i & 4) ? 1 : -1;
      _v.set(cx + gx * hx, cy + gy * hy, cz + gz * hz).applyMatrix4(e);
      P.push([_v.x, _v.y, _v.z]);
    }
    // Collision normals come from the winding, so each face has to be wound
    // outward. The box is convex, so "outward" is just centre -> centroid; that
    // stays correct even under a mirroring placement matrix.
    _v.set(cx, cy, cz).applyMatrix4(e);
    const bx = _v.x, by = _v.y, bz = _v.z;
    const Q = [[2, 3, 7, 6], [0, 4, 5, 1], [1, 5, 7, 3], [0, 2, 6, 4], [4, 6, 7, 5], [0, 1, 3, 2]];
    const emit = (a: number[], b: number[], c: number[]) => {
      const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
      const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
      const gx = e1y * e2z - e1z * e2y, gy = e1z * e2x - e1x * e2z, gz = e1x * e2y - e1y * e2x;
      const ox = (a[0] + b[0] + c[0]) / 3 - bx, oy = (a[1] + b[1] + c[1]) / 3 - by, oz = (a[2] + b[2] + c[2]) / 3 - bz;
      if (gx * ox + gy * oy + gz * oz < 0) { const t = b; b = c; c = t; }
      this.collision.addTri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], flags);
      this.stats.colliderTris++;
    };
    for (const [a, b, c, d] of Q) {
      emit(P[a], P[b], P[c]);
      emit(P[a], P[c], P[d]);
    }
  }

  // ─────────────────────────────────────────────── instanced props

  /**
   * Instanced decoration. All copies of one key across the whole stage collapse
   * into a single InstancedMesh at finalizeProps().
   */
  prop(
    key: string, geo: THREE.BufferGeometry, o: SurfOpt,
    x: number, y: number, z: number,
    yaw = 0, sx = 1, sy = 1, sz = 1, pitch = 0,
  ) {
    const mk = this.matKey(o);
    const bankKey = key + '|' + mk;
    let p = this.props.get(bankKey);
    if (!p) {
      p = {
        geo,
        mat: celShared('kitInst:' + mk, { ...this.celOpts(o), instanced: true }),
        cls: o.cls ?? 'metal', ink: o.ink !== false, m: [],
      };
      this.props.set(bankKey, p);
    }
    _m.makeRotationFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    _m.scale(_v.set(sx, sy, sz));
    _m.setPosition(x, y, z);
    _m.premultiply(this.stack[this.sp]);
    const e = _m.elements;
    for (let i = 0; i < 16; i++) p.m.push(e[i]);
  }

  // ─────────────────────────────────────────────── gameplay markers

  /** Register a grind rail. Points come in local; stored in world space. */
  rail(spec: RailSpec): RailSpec {
    const points: V3[] = spec.points.map((p) => {
      this.pt(p.x, p.y, p.z);
      return { x: this.tx, y: this.ty, z: this.tz };
    });
    const placed: RailSpec = { ...spec, points };
    this.rails.push(placed);
    return placed;
  }

  /** Trigger / behaviour volume. Centre is transformed; half-extents are yawed. */
  volume(spec: VolumeSpec): VolumeSpec {
    this.pt(spec.center.x, spec.center.y, spec.center.z);
    const e = this.stack[this.sp].elements;
    const yaw = Math.atan2(e[8], e[10]);
    const placed: VolumeSpec = {
      ...spec,
      center: { x: this.tx, y: this.ty, z: this.tz },
      yaw: (spec.yaw ?? 0) + yaw,
    };
    this.volumes.push(placed);
    return placed;
  }

  enemy(spawn: EnemySpawn): EnemySpawn {
    const e = this.stack[this.sp].elements;
    const yaw = Math.atan2(e[8], e[10]);
    const patrol = spawn.patrol?.map((p) => {
      this.pt(p.x, p.y, p.z);
      return { x: this.tx, y: this.ty, z: this.tz };
    });
    this.pt(spawn.pos.x, spawn.pos.y, spawn.pos.z);
    const placed: EnemySpawn = {
      ...spawn, pos: { x: this.tx, y: this.ty, z: this.tz },
      yaw: (spawn.yaw ?? 0) + yaw, patrol,
    };
    this.enemies.push(placed);
    return placed;
  }

  pickup(spawn: PickupSpawn): PickupSpawn {
    this.pt(spawn.pos.x, spawn.pos.y, spawn.pos.z);
    const placed: PickupSpawn = { ...spawn, pos: { x: this.tx, y: this.ty, z: this.tz } };
    this.pickups.push(placed);
    return placed;
  }

  /** Declares a traversal route through this module for the validator. */
  route(spec: RouteSpec): RouteSpec {
    const path: V3[] = spec.path.map((p) => {
      this.pt(p.x, p.y, p.z);
      return { x: this.tx, y: this.ty, z: this.tz };
    });
    const placed: RouteSpec = { ...spec, path };
    this.routes.push(placed);
    return placed;
  }
}

export { SF };
