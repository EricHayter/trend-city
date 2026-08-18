import { Vector3, Quaternion, Matrix4 } from 'three';
import { SpatialHash } from '../core/SpatialHash';
import { Solid, Rail, Surface, MovingSpec, CollapseSpec } from './Types';

const _v = new Vector3();
const _v2 = new Vector3();
const _local = new Vector3();
const _closest = new Vector3();
const _n = new Vector3();
const _q = new Quaternion();

export interface HitResult {
  hit: boolean;
  grounded: boolean;
  groundNormal: Vector3;
  groundSolid: Solid | null;
  wall: boolean;
  wallNormal: Vector3;
  wallSolid: Solid | null;
  ceiling: boolean;
  pushed: Vector3;
  hazard: boolean;
}

export function newHitResult(): HitResult {
  return {
    hit: false, grounded: false, groundNormal: new Vector3(0, 1, 0), groundSolid: null,
    wall: false, wallNormal: new Vector3(), wallSolid: null, ceiling: false,
    pushed: new Vector3(), hazard: false,
  };
}

/**
 * Collision world. Static solids live in a spatial hash; moving and collapsing solids
 * live in a short dynamic list that is re-hashed every frame. All queries write into
 * caller-owned scratch, so a full frame of collision allocates nothing.
 */
export class PhysicsWorld {
  solids: Solid[] = [];
  rails: Rail[] = [];
  dynamic: Solid[] = [];
  private hash = new SpatialHash<Solid>(16);
  private railHash = new SpatialHash<Rail>(24);
  private scratch: Solid[] = new Array(512);
  private railScratch: Rail[] = new Array(64);
  private nextId = 1;
  time = 0;

  addSolid(center: Vector3, half: Vector3, quat: Quaternion, kind: Surface, chunk: number, opts?: Partial<Solid>): Solid {
    const s: Solid = {
      id: this.nextId++,
      center: center.clone(),
      half: half.clone(),
      quat: quat.clone(),
      mat: new Matrix4(),
      inv: new Matrix4(),
      radius: half.length(),
      kind,
      chunk,
      boost: 1,
      bounce: 0,
      hazard: false,
      breakable: false,
      broken: false,
      wallrun: kind !== 'foliage' && kind !== 'neon',
      grindable: false,
      moving: null,
      collapse: null,
    };
    if (opts) Object.assign(s, opts);
    this.refresh(s);
    this.solids.push(s);
    if (s.moving || s.collapse) this.dynamic.push(s);
    return s;
  }

  refresh(s: Solid) {
    s.mat.compose(s.center, s.quat, _v.set(1, 1, 1));
    s.inv.copy(s.mat).invert();
    s.radius = s.half.length();
  }

  addRail(points: Vector3[], chunk: number, boost = 1.02, launchAtEnd = 0): Rail {
    const lengths: number[] = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += points[i].distanceTo(points[i - 1]);
      lengths.push(total);
    }
    const rail: Rail = { id: this.nextId++, points, lengths, total, chunk, boost, launchAtEnd };
    this.rails.push(rail);
    return rail;
  }

  /** Called once after generation: bakes the static broadphase. */
  build() {
    this.hash.clear();
    this.railHash.clear();
    for (const s of this.solids) {
      if (s.moving || s.collapse) continue;
      const r = s.radius;
      this.hash.insert(s, s.center.x - r, s.center.z - r, s.center.x + r, s.center.z + r);
    }
    for (const rail of this.rails) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const p of rail.points) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      this.railHash.insert(rail, minX - 2, minZ - 2, maxX + 2, maxZ + 2);
    }
    if (this.scratch.length < 1024) this.scratch = new Array(1024);
  }

  /** Advances moving platforms and collapsing geometry. */
  update(dt: number) {
    this.time += dt;
    for (let i = 0; i < this.dynamic.length; i++) {
      const s = this.dynamic[i];
      if (s.moving) {
        const m = s.moving;
        const prevX = s.center.x, prevY = s.center.y, prevZ = s.center.z;
        if (m.mode === 'sine') {
          const k = Math.sin(this.time * m.speed + m.phase) * m.amplitude;
          s.center.copy(m.origin).addScaledVector(m.axis, k);
        } else if (m.mode === 'loop') {
          const k = ((this.time * m.speed + m.phase) % 2) - 1;
          s.center.copy(m.origin).addScaledVector(m.axis, k * m.amplitude);
        } else {
          const a = this.time * m.speed + m.phase;
          s.center.copy(m.origin);
          s.center.x += Math.cos(a) * m.amplitude;
          s.center.z += Math.sin(a) * m.amplitude;
        }
        m.velocity.set((s.center.x - prevX) / dt, (s.center.y - prevY) / dt, (s.center.z - prevZ) / dt);
        this.refresh(s);
      }
      if (s.collapse && s.collapse.triggered) {
        const c = s.collapse;
        c.timer += dt;
        if (c.timer > c.delay) {
          const t = c.timer - c.delay;
          c.fallSpeed += 42 * dt;
          s.center.y -= c.fallSpeed * dt;
          _q.setFromAxisAngle(_v.set(0.3, 0.1, 0.8).normalize(), c.spin * t * dt * 6);
          s.quat.multiply(_q);
          this.refresh(s);
          if (s.center.y < -400) s.broken = true;
        }
      }
    }
  }

  triggerCollapse(chunk: number, radiusFrom: Vector3, radius: number) {
    for (const s of this.dynamic) {
      if (!s.collapse || s.collapse.triggered) continue;
      if (s.chunk !== chunk) continue;
      if (s.center.distanceTo(radiusFrom) > radius) continue;
      s.collapse.triggered = true;
    }
  }

  /** Broadphase: fills scratch with solids near a box and returns the count. */
  gather(x: number, z: number, r: number): number {
    const n = this.hash.query(x - r, z - r, x + r, z + r, this.scratch);
    let count = n;
    for (let i = 0; i < this.dynamic.length; i++) {
      const s = this.dynamic[i];
      if (s.broken) continue;
      const dx = s.center.x - x, dz = s.center.z - z;
      if (dx * dx + dz * dz < (r + s.radius) * (r + s.radius)) this.scratch[count++] = s;
    }
    return count;
  }

  get scratchArray() { return this.scratch; }

  /**
   * Sphere vs oriented boxes with iterative separation. Ground, wall and ceiling
   * contacts are classified by the contact normal, which is how slopes, banked ramps,
   * duct tubes and wall-run faces all fall out of one solver instead of special cases.
   */
  resolveSphere(pos: Vector3, radius: number, res: HitResult, iterations = 3): HitResult {
    res.hit = false; res.grounded = false; res.wall = false; res.ceiling = false; res.hazard = false;
    res.groundSolid = null; res.wallSolid = null; res.pushed.set(0, 0, 0);
    let bestGroundY = -2;

    const count = this.gather(pos.x, pos.z, radius + 3);
    for (let it = 0; it < iterations; it++) {
      let moved = false;
      for (let i = 0; i < count; i++) {
        const s = this.scratch[i];
        if (s.broken) continue;
        const dx = pos.x - s.center.x, dy = pos.y - s.center.y, dz = pos.z - s.center.z;
        const rr = radius + s.radius;
        if (dx * dx + dy * dy + dz * dz > rr * rr) continue;

        _local.set(pos.x, pos.y, pos.z).applyMatrix4(s.inv);
        _closest.set(
          Math.max(-s.half.x, Math.min(s.half.x, _local.x)),
          Math.max(-s.half.y, Math.min(s.half.y, _local.y)),
          Math.max(-s.half.z, Math.min(s.half.z, _local.z)),
        );
        _n.subVectors(_local, _closest);
        let dist = _n.length();
        if (dist > radius) continue;

        if (dist < 1e-5) {
          // Centre is inside the box: escape along the axis of least penetration.
          const px = s.half.x - Math.abs(_local.x);
          const py = s.half.y - Math.abs(_local.y);
          const pz = s.half.z - Math.abs(_local.z);
          if (py <= px && py <= pz) _n.set(0, Math.sign(_local.y) || 1, 0).multiplyScalar(1);
          else if (px <= pz) _n.set(Math.sign(_local.x) || 1, 0, 0);
          else _n.set(0, 0, Math.sign(_local.z) || 1);
          dist = 0.0001;
        }
        _n.divideScalar(dist);
        const depth = radius - dist;

        // Local normal -> world (rotation only).
        _v.copy(_n).applyQuaternion(s.quat);
        pos.addScaledVector(_v, depth);
        res.pushed.addScaledVector(_v, depth);
        res.hit = true;
        moved = true;

        if (s.hazard) res.hazard = true;
        if (_v.y > 0.5) {
          if (_v.y > bestGroundY) {
            bestGroundY = _v.y;
            res.groundNormal.copy(_v);
            res.groundSolid = s;
          }
          res.grounded = true;
        } else if (_v.y < -0.5) {
          res.ceiling = true;
        } else {
          res.wall = true;
          res.wallNormal.copy(_v);
          res.wallSolid = s;
        }
      }
      if (!moved) break;
    }
    return res;
  }

  /**
   * Downward probe used for coyote-time ground checks, shadow placement, enemy
   * grounding and generator validation. Returns the surface height or -Infinity.
   */
  groundHeight(x: number, z: number, fromY: number, maxDrop = 60): { y: number; solid: Solid | null; normal: Vector3 } {
    const count = this.gather(x, z, 3.5);
    let bestY = -Infinity;
    let best: Solid | null = null;
    const normal = new Vector3(0, 1, 0);
    for (let i = 0; i < count; i++) {
      const s = this.scratch[i];
      if (s.broken) continue;
      // Ray from (x, fromY, z) straight down in the box local frame.
      _local.set(x, fromY, z).applyMatrix4(s.inv);
      _v2.set(0, -1, 0).applyQuaternion(_q.copy(s.quat).invert());
      let t0 = -Infinity, t1 = Infinity;
      const o = [_local.x, _local.y, _local.z];
      const d = [_v2.x, _v2.y, _v2.z];
      const h = [s.half.x, s.half.y, s.half.z];
      let ok = true;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-6) {
          if (Math.abs(o[a]) > h[a]) { ok = false; break; }
        } else {
          let ta = (-h[a] - o[a]) / d[a];
          let tb = (h[a] - o[a]) / d[a];
          if (ta > tb) { const t = ta; ta = tb; tb = t; }
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) { ok = false; break; }
        }
      }
      if (!ok || t1 < 0) continue;
      const t = Math.max(0, t0);
      if (t > maxDrop) continue;
      const y = fromY - t;
      if (y > bestY) {
        bestY = y;
        best = s;
        _local.set(x, fromY, z).applyMatrix4(s.inv).addScaledVector(_v2, t);
        const px = s.half.x - Math.abs(_local.x);
        const py = s.half.y - Math.abs(_local.y);
        const pz = s.half.z - Math.abs(_local.z);
        if (py <= px && py <= pz) normal.set(0, Math.sign(_local.y) || 1, 0);
        else if (px <= pz) normal.set(Math.sign(_local.x) || 1, 0, 0);
        else normal.set(0, 0, Math.sign(_local.z) || 1);
        normal.applyQuaternion(s.quat);
      }
    }
    return { y: bestY, solid: best, normal };
  }

  /** Nearest point on any nearby rail. Used for grind snapping and generator checks. */
  nearestRail(pos: Vector3, maxDist: number, out: { rail: Rail | null; t: number; point: Vector3; dist: number }) {
    out.rail = null; out.dist = Infinity;
    const n = this.railHash.query(pos.x - maxDist, pos.z - maxDist, pos.x + maxDist, pos.z + maxDist, this.railScratch);
    for (let i = 0; i < n; i++) {
      const rail = this.railScratch[i];
      for (let k = 1; k < rail.points.length; k++) {
        const a = rail.points[k - 1], b = rail.points[k];
        _v.subVectors(b, a);
        const len2 = _v.lengthSq();
        const t = len2 > 0 ? Math.max(0, Math.min(1, _v2.subVectors(pos, a).dot(_v) / len2)) : 0;
        _v2.copy(a).addScaledVector(_v, t);
        const dist = _v2.distanceTo(pos);
        if (dist < out.dist) {
          out.dist = dist;
          out.rail = rail;
          out.point.copy(_v2);
          out.t = rail.lengths[k - 1] + t * (rail.lengths[k] - rail.lengths[k - 1]);
        }
      }
    }
    if (out.dist > maxDist) out.rail = null;
    return out;
  }

  /** Ray march used by the camera to avoid clipping through architecture. */
  raycastFirst(origin: Vector3, dir: Vector3, maxDist: number): number {
    const steps = 12;
    const step = maxDist / steps;
    for (let i = 1; i <= steps; i++) {
      _v.copy(origin).addScaledVector(dir, step * i);
      const count = this.gather(_v.x, _v.z, 2.2);
      for (let k = 0; k < count; k++) {
        const s = this.scratch[k];
        if (s.broken || s.kind === 'foliage' || s.kind === 'neon') continue;
        _local.copy(_v).applyMatrix4(s.inv);
        if (Math.abs(_local.x) < s.half.x + 0.6 && Math.abs(_local.y) < s.half.y + 0.6 && Math.abs(_local.z) < s.half.z + 0.6) {
          return step * (i - 1);
        }
      }
    }
    return maxDist;
  }
}
