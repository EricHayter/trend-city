import { Vector3, Quaternion, Euler, Matrix4 } from 'three';
import { PhysicsWorld } from './Physics';
import { WorldBuilder, GeoKey } from './Builder';
import { MatClass } from '../render/CelMaterial';
import { DistrictStyle, shade } from '../render/Palette';
import { Rng } from '../core/Rng';
import { Solid, Surface, Pickup, PickupKind, EnemySpawn, EnemyKind, TraversalNode } from './Types';

export type Variant = 'plain' | 'facade' | 'roof' | 'metal' | 'glass' | 'panel' | 'duct' | 'neon' | 'rail' | 'hazard' | 'digital' | 'foliage' | 'decor' | 'boost';

/** Everything a generated stage owns. Modules write into this; nothing else may. */
export class WorldData {
  physics = new PhysicsWorld();
  pickups: Pickup[] = [];
  enemies: EnemySpawn[] = [];
  nodes: TraversalNode[] = [];
  matSpecs = new Map<string, any>();
  goal = new Vector3();
  repairs: { pos: Vector3; reason: string }[] = [];
  bossCenter = new Vector3();
  private pickupId = 1;

  constructor(public builder: WorldBuilder) {}

  registerMat(key: string, overrides: any) {
    if (!this.matSpecs.has(key)) this.matSpecs.set(key, overrides);
  }

  addPickup(kind: PickupKind, pos: Vector3, chunk: number, risky: boolean, value: number): Pickup {
    const p: Pickup = { id: this.pickupId++, kind, pos: pos.clone(), taken: false, chunk, value, risky, bob: Math.random() * 6.28 };
    this.pickups.push(p);
    return p;
  }
}

const _q = new Quaternion();
const _e = new Euler();
const _v = new Vector3();
const _s = new Vector3();
const _m = new Matrix4();

export interface SlabOpts {
  x?: number; y?: number; z?: number;          // local position (right, up, forward)
  w?: number; h?: number; l?: number;          // size
  kind?: Surface;
  variant?: Variant;
  geo?: GeoKey;
  pitch?: number;                              // radians, positive tips the far edge down
  roll?: number;                               // banking
  yawOffset?: number;
  boost?: number;
  bounce?: number;
  hazard?: boolean;
  breakable?: boolean;
  grindable?: boolean;
  collapse?: number;                           // delay in seconds, enables collapse
  moving?: { axis: Vector3; amplitude: number; speed: number; phase?: number; mode?: 'sine' | 'loop' | 'orbit' };
  noCollide?: boolean;
  outline?: boolean;
  outlineWidth?: number;
  emissive?: number;
}

/**
 * The authoring surface every level module draws through. Coordinates are local to the
 * module frame (x = right, y = up, z = forward along the stage), so a module can be
 * written as if it were hand-placed and then dropped anywhere on the path.
 */
export class Canvas {
  readonly forward = new Vector3();
  readonly right = new Vector3();

  constructor(
    public data: WorldData,
    public chunk: number,
    public origin: Vector3,
    public heading: number,
    public district: DistrictStyle,
    public rng: Rng,
  ) {
    this.forward.set(Math.sin(heading), 0, Math.cos(heading));
    this.right.set(Math.cos(heading), 0, -Math.sin(heading));
  }

  toWorld(x: number, y: number, z: number, out = new Vector3()): Vector3 {
    out.copy(this.origin);
    out.x += this.right.x * x + this.forward.x * z;
    out.z += this.right.z * x + this.forward.z * z;
    out.y += y;
    return out;
  }

  /** Material description for a surface family, tinted by the current district. */
  mat(kind: Surface, variant: Variant = 'plain'): { cls: MatClass; key: string; overrides: any } {
    const d = this.district;
    const key = variant + '_' + kind + '_' + d.id;
    let cls: MatClass = 'concrete';
    let ov: any = {};
    switch (variant) {
      case 'facade':
        cls = 'concrete';
        ov = { base: d.concrete, pattern: 1, patternScale: 1, patternA: d.concreteShade, patternB: d.glass, patternGlow: d.signDensity * 1.15, hatch: 0.3 };
        break;
      case 'roof':
        cls = 'concrete';
        ov = { base: shade(d.concrete, -0.12), pattern: 6, patternA: d.concreteShade };
        break;
      case 'metal':
        cls = 'metal';
        ov = { base: d.metal };
        break;
      case 'glass':
        cls = 'glass';
        ov = { base: d.glass, emissiveColor: d.glass, emissive: 0.14 };
        break;
      case 'panel':
        cls = 'panel';
        ov = { base: shade(d.metal, -0.24), patternA: shade(d.metal, 0.1), patternB: d.accent2, patternGlow: 0.6 };
        break;
      case 'duct':
        cls = 'duct';
        ov = { base: shade(d.metal, 0.06), patternA: shade(d.metal, -0.16), patternB: shade(d.concrete, 0.05) };
        break;
      case 'neon':
        cls = 'neon';
        ov = { emissiveColor: this.rng.chance(0.5) ? d.accent : d.accent2, emissive: 1.5 };
        break;
      case 'rail':
        cls = 'rail';
        ov = { emissiveColor: d.accent2, emissive: 1.25 };
        break;
      case 'hazard':
        cls = 'hazard';
        ov = { base: 0xffb03a, patternA: 0x1a1030 };
        break;
      case 'digital':
        cls = 'digital';
        ov = { base: shade(d.concrete, -0.5), patternA: d.accent2, patternGlow: 1.0 };
        break;
      case 'foliage':
        cls = 'foliage';
        ov = {};
        break;
      case 'decor':
        cls = 'decor';
        ov = { base: shade(d.concrete, -0.06) };
        break;
      case 'boost':
        cls = 'neon';
        ov = { emissiveColor: d.accent2, emissive: 1.9 };
        break;
      default:
        cls = kind === 'metal' ? 'metal' : kind === 'glass' ? 'glass' : 'concrete';
        ov = { base: kind === 'metal' ? d.metal : kind === 'glass' ? d.glass : d.concrete, patternA: d.concreteShade };
    }
    this.data.registerMat(key, ov);
    return { cls, key, overrides: ov };
  }

  /** Places one box (or primitive) in both the collision world and the render batches. */
  slab(o: SlabOpts): Solid | null {
    const x = o.x || 0, y = o.y || 0, z = o.z || 0;
    const w = o.w !== undefined ? o.w : 4;
    const h = o.h !== undefined ? o.h : 1;
    const l = o.l !== undefined ? o.l : 4;
    const kind = o.kind || 'concrete';
    const variant = o.variant || 'plain';
    const geo = o.geo || 'box';

    const pos = this.toWorld(x, y, z, new Vector3());
    _e.set(o.pitch || 0, this.heading + (o.yawOffset || 0), o.roll || 0, 'YXZ');
    _q.setFromEuler(_e);
    _s.set(w, h, l);

    const desc = this.mat(kind, variant);
    const outline = o.outline !== undefined ? o.outline : (variant === 'panel' || variant === 'duct' || variant === 'hazard' || variant === 'rail' || variant === 'digital' || variant === 'decor' || variant === 'boost');
    this.data.builder.pushTRS(this.chunk, geo, desc.cls, desc.key, pos, _s, _q, outline, o.outlineWidth || 1);

    if (o.noCollide) return null;
    const half = new Vector3(w / 2, h / 2, l / 2);
    // Cylinders and spheres collide as their inscribed box, which is close enough for
    // pipes and tanks and keeps the solver uniform.
    if (geo === 'cyl' || geo === 'tube' || geo === 'pole') half.set(w / 2 * 0.86, h / 2, l / 2 * 0.86);
    const solid = this.data.physics.addSolid(pos, half, _q, kind, this.chunk, {
      boost: o.boost !== undefined ? o.boost : 1,
      bounce: o.bounce || 0,
      hazard: !!o.hazard,
      breakable: !!o.breakable,
      grindable: !!o.grindable,
      moving: o.moving ? {
        origin: pos.clone(), axis: o.moving.axis.clone(), amplitude: o.moving.amplitude,
        speed: o.moving.speed, phase: o.moving.phase || 0, mode: o.moving.mode || 'sine', velocity: new Vector3(),
      } : null,
      collapse: o.collapse !== undefined ? { delay: o.collapse, triggered: false, timer: 0, fallSpeed: 0, spin: this.rng.range(-1, 1) } : null,
    });
    return solid;
  }

  /** Visual-only instance: signage, cables, vents, antennas, crowd of background props. */
  decor(o: SlabOpts) {
    o.noCollide = true;
    return this.slab(o);
  }

  rail(localPoints: number[][], boost = 1.03, launchAtEnd = 0) {
    const pts = localPoints.map((p) => this.toWorld(p[0], p[1], p[2], new Vector3()));
    const rail = this.data.physics.addRail(pts, this.chunk, boost, launchAtEnd);
    // Visual rail: a chain of thin emissive tubes plus support struts.
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const mid = _v.copy(a).add(b).multiplyScalar(0.5);
      const len = a.distanceTo(b);
      const dir = new Vector3().subVectors(b, a).normalize();
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);
      const desc = this.mat('rail', 'rail');
      _s.set(0.34, len, 0.34);
      this.data.builder.pushTRS(this.chunk, 'tube', desc.cls, desc.key, mid, _s, q, true, 1.1);
      if (i % 3 === 0) {
        const desc2 = this.mat('metal', 'metal');
        _s.set(0.3, 2.4, 0.3);
        this.data.builder.pushTRS(this.chunk, 'pole', desc2.cls, desc2.key, new Vector3(mid.x, mid.y - 1.2, mid.z), _s, new Quaternion(), true, 0.8);
      }
    }
    return rail;
  }

  pickup(kind: PickupKind, x: number, y: number, z: number, risky = false, value = 1) {
    return this.data.addPickup(kind, this.toWorld(x, y, z, new Vector3()), this.chunk, risky, value);
  }

  /** Collectible line following a curve: the readable reward trail along a fast route. */
  pickupArc(kind: PickupKind, from: number[], to: number[], count: number, arc = 0, risky = false) {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const x = from[0] + (to[0] - from[0]) * t;
      const y = from[1] + (to[1] - from[1]) * t + Math.sin(t * Math.PI) * arc;
      const z = from[2] + (to[2] - from[2]) * t;
      this.pickup(kind, x, y, z, risky, 1);
    }
  }

  enemy(kind: EnemyKind, x: number, y: number, z: number, traversal = false, patrol = 6) {
    this.data.enemies.push({ kind, pos: this.toWorld(x, y, z, new Vector3()), chunk: this.chunk, patrol, traversal });
  }

  node(x: number, y: number, z: number, route: any, kind: TraversalNode['kind'], requiredSpeed = 0) {
    this.data.nodes.push({ pos: this.toWorld(x, y, z, new Vector3()), route, kind, requiredSpeed });
  }

  /**
   * PROCEDURAL BUILDING
   * A tower is never a single box: it is a stack of setbacks with a facade pattern, a
   * roof deck, a parapet, and a deterministic set of roof furniture. Silhouettes vary
   * by rule (setback count, crown type, sign placement) rather than by pure noise.
   */
  building(x: number, z: number, w: number, d: number, height: number, opts?: { roofKind?: 'flat' | 'slope' | 'crown' | 'tank'; sign?: boolean; baseY?: number }) {
    const rng = this.rng;
    const baseY = (opts && opts.baseY) || 0;
    const setbacks = height > 60 ? rng.int(2, 3) : height > 30 ? rng.int(1, 2) : 1;
    let y = baseY;
    let cw = w, cd = d;
    let remaining = height;
    for (let i = 0; i < setbacks; i++) {
      const seg = i === setbacks - 1 ? remaining : remaining * rng.range(0.42, 0.66);
      this.slab({ x, y: y + seg / 2, z, w: cw, h: seg, l: cd, kind: 'concrete', variant: 'facade' });
      y += seg;
      remaining -= seg;
      cw *= rng.range(0.72, 0.9);
      cd *= rng.range(0.72, 0.9);
      if (remaining < 3) break;
    }
    const topY = baseY + height;
    // Roof deck, always walkable: rooftops are the primary traversal layer.
    this.slab({ x, y: topY + 0.4, z, w: cw + 1.2, h: 0.8, l: cd + 1.2, kind: 'concrete', variant: 'roof' });
    const roofKind = (opts && opts.roofKind) || rng.weighted([['flat', 5], ['slope', 3], ['crown', 2], ['tank', 2]] as [any, number][]);
    if (roofKind === 'slope') {
      const pitch = rng.range(0.2, 0.42);
      this.slab({ x, y: topY + 1.2 + Math.sin(pitch) * cd * 0.25, z, w: cw, h: 0.6, l: cd * 1.02, pitch, kind: 'metal', variant: 'panel', boost: 1.06 });
    } else if (roofKind === 'crown') {
      this.slab({ x, y: topY + 3, z, w: cw * 0.4, h: 6, l: cd * 0.4, kind: 'metal', variant: 'metal' });
      this.decor({ x, y: topY + 9, z, w: 0.5, h: 8, l: 0.5, geo: 'pole', kind: 'metal', variant: 'metal' });
      this.decor({ x, y: topY + 13.5, z, w: 1.6, h: 1.6, l: 1.6, geo: 'sphere', kind: 'neon', variant: 'neon' });
    } else if (roofKind === 'tank') {
      this.slab({ x: x + cw * 0.2, y: topY + 2.6, z: z - cd * 0.15, w: 4, h: 4, l: 4, geo: 'cyl', kind: 'metal', variant: 'duct' });
    }
    // Roof furniture: AC units, ducts, cable spools. Placement is jittered but always
    // leaves a clear running lane through the middle of the deck.
    const props = rng.int(2, 5);
    for (let i = 0; i < props; i++) {
      const px = rng.range(-cw * 0.42, cw * 0.42);
      const pz = rng.range(-cd * 0.42, cd * 0.42);
      if (Math.abs(px) < cw * 0.16) continue;
      const t = rng.float();
      if (t < 0.5) this.slab({ x: x + px, y: topY + 1.6, z: z + pz, w: rng.range(1.6, 3), h: 1.6, l: rng.range(1.6, 3), kind: 'metal', variant: 'duct' });
      else if (t < 0.8) this.decor({ x: x + px, y: topY + 1.4, z: z + pz, w: 1.2, h: 1.2, l: 1.2, geo: 'cyl', kind: 'metal', variant: 'metal' });
      else this.decor({ x: x + px, y: topY + 2.4, z: z + pz, w: 0.3, h: 4.4, l: 0.3, geo: 'pole', kind: 'metal', variant: 'metal' });
    }
    if (!opts || opts.sign !== false) {
      if (rng.chance(0.55 * this.district.signDensity)) {
        const side = rng.sign();
        const sh = rng.range(6, 16);
        this.decor({ x: x + side * (cw / 2 + 0.4), y: baseY + height * rng.range(0.4, 0.8), z, w: 0.4, h: sh, l: rng.range(2.5, 5), kind: 'neon', variant: 'neon' });
      }
    }
    return { topY: topY + 0.8, width: cw, depth: cd };
  }
}
