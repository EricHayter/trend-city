/**
 * Path — the arc-length polyline every piece of traversal furniture is built
 * on, and the swept queries that make it safe at 266 km/h.
 *
 * WHY A POLYLINE AND NOT A CURVE OBJECT
 *
 * Everything in here is queried from the physics step, 120 times a second, and
 * the physics step is a zero-allocation path. A `CatmullRomCurve3` allocates a
 * `Vector3` per `getPoint`, so it is used at BUILD time to smooth a control
 * cage and then baked into flat `Float32Array`s that can be walked without
 * touching the heap. Sampling is a binary search plus two lerps.
 *
 * WHY EVERY QUERY IS SWEPT
 *
 * `RUN.max` is 74 m/s. A 120 Hz step advances 0.62 m and a rail is 9 cm
 * across, so a point-in-radius test against the character's position samples a
 * rail in roughly one step out of seven that it should have hit — and the six
 * it misses are indistinguishable from "the rails just don't work sometimes".
 * Every test in this directory is therefore segment-vs-segment: the character's
 * whole step, from `from` to `to`, against the whole rail, never a point.
 *
 * `closestSegSeg` is the clamped closest-approach of two finite segments
 * (Ericson, Real-Time Collision Detection §5.1.9). It is exact, branch-cheap
 * and allocation-free, and it is the only reason a 9 cm rail is catchable.
 */

import { CatmullRomCurve3, Vector3 } from 'three';

import type { RailSample } from '../game/Contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Scratch — module scope, never allocated inside a query
// ─────────────────────────────────────────────────────────────────────────────
const _d1 = new Vector3();
const _d2 = new Vector3();
const _r = new Vector3();
const _c1 = new Vector3();
const _c2 = new Vector3();
const _tmp = new Vector3();

const EPS = 1e-9;

/** Result of a closest-approach between two segments. Reused; copy what you need. */
export interface SegSegResult {
  /** Parameter on the first segment, 0..1. */
  s: number;
  /** Parameter on the second segment, 0..1. */
  t: number;
  /** Squared distance between the two closest points. */
  dist2: number;
  /** Closest point on the first segment. */
  p1: Vector3;
  /** Closest point on the second segment. */
  p2: Vector3;
}

export function makeSegSegResult(): SegSegResult {
  return { s: 0, t: 0, dist2: 0, p1: new Vector3(), p2: new Vector3() };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Closest points between segment (p1→q1) and segment (p2→q2).
 * Writes into `out` and allocates nothing.
 */
export function closestSegSeg(
  p1: Vector3, q1: Vector3,
  p2: Vector3, q2: Vector3,
  out: SegSegResult,
): SegSegResult {
  _d1.subVectors(q1, p1);
  _d2.subVectors(q2, p2);
  _r.subVectors(p1, p2);

  const a = _d1.dot(_d1);
  const e = _d2.dot(_d2);
  const f = _d2.dot(_r);

  let s: number;
  let t: number;

  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = _d1.dot(_r);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = _d1.dot(_d2);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  out.s = s;
  out.t = t;
  out.p1.copy(p1).addScaledVector(_d1, s);
  out.p2.copy(p2).addScaledVector(_d2, t);
  out.dist2 = out.p1.distanceToSquared(out.p2);
  return out;
}

/** Squared distance from `p` to the segment a→b. Allocation-free. */
export function pointSegDist2(p: Vector3, a: Vector3, b: Vector3): number {
  _d1.subVectors(b, a);
  const aa = _d1.dot(_d1);
  if (aa <= EPS) return p.distanceToSquared(a);
  _r.subVectors(p, a);
  const t = clamp01(_r.dot(_d1) / aa);
  _tmp.copy(a).addScaledVector(_d1, t);
  return p.distanceToSquared(_tmp);
}

// ─────────────────────────────────────────────────────────────────────────────
// PolyPath
// ─────────────────────────────────────────────────────────────────────────────

/** A hit from `sweepPath`. Module-owned; consume it before the next sweep. */
export interface PathSweep {
  hit: boolean;
  /** Arc-length along the path of the closest point, metres. */
  distance: number;
  /** Squared distance at closest approach, with the vertical axis weighted. */
  dist2: number;
  /** Parameter along the QUERY segment, 0..1 — when in the step it happened. */
  s: number;
  /** Closest point on the path, world space. */
  point: Vector3;
  /** Closest point on the query segment, world space. */
  queryPoint: Vector3;
}

export function makePathSweep(): PathSweep {
  return { hit: false, distance: 0, dist2: 0, s: 0, point: new Vector3(), queryPoint: new Vector3() };
}

const _ss = makeSegSegResult();
const _pa = new Vector3();
const _pb = new Vector3();

/**
 * An arc-length parameterised polyline with a per-node up vector.
 *
 * Nodes are stored flat. `cum[i]` is the arc length at node i, so `cum[n-1]` is
 * the total length and a binary search on it turns a distance into a segment.
 */
export class PolyPath {
  readonly n: number;
  readonly pos: Float32Array;
  readonly tan: Float32Array;
  readonly up: Float32Array;
  readonly cum: Float32Array;
  readonly length: number;

  readonly minX: number; readonly minY: number; readonly minZ: number;
  readonly maxX: number; readonly maxY: number; readonly maxZ: number;

  constructor(points: Vector3[], ups?: Vector3[]) {
    const n = points.length;
    if (n < 2) throw new Error('PolyPath needs at least two points');
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.tan = new Float32Array(n * 3);
    this.up = new Float32Array(n * 3);
    this.cum = new Float32Array(n);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < n; i++) {
      const p = points[i];
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      if (i > 0) this.cum[i] = this.cum[i - 1] + p.distanceTo(points[i - 1]);
    }
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
    this.length = this.cum[n - 1];

    // Node tangents: the average of the two adjacent segment directions, so a
    // sample crossing a node does not step its tangent. A stepped tangent on a
    // rail shows up as the character's facing snapping at every control point.
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = this.pos[b * 3] - this.pos[a * 3];
      let ty = this.pos[b * 3 + 1] - this.pos[a * 3 + 1];
      let tz = this.pos[b * 3 + 2] - this.pos[a * 3 + 2];
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;
      this.tan[i * 3] = tx;
      this.tan[i * 3 + 1] = ty;
      this.tan[i * 3 + 2] = tz;

      const u = ups?.[i];
      if (u) {
        // Orthonormalise the supplied up against the tangent so the frame is
        // a real frame and the rig does not shear on a banked rail.
        let ux = u.x, uy = u.y, uz = u.z;
        const d = ux * tx + uy * ty + uz * tz;
        ux -= tx * d; uy -= ty * d; uz -= tz * d;
        const ul = Math.hypot(ux, uy, uz);
        if (ul > 1e-5) { ux /= ul; uy /= ul; uz /= ul; } else { ux = 0; uy = 1; uz = 0; }
        this.up[i * 3] = ux;
        this.up[i * 3 + 1] = uy;
        this.up[i * 3 + 2] = uz;
      } else {
        // World up, flattened against the tangent.
        let ux = -tx * ty, uy = 1 - ty * ty, uz = -tz * ty;
        const ul = Math.hypot(ux, uy, uz);
        if (ul > 1e-5) { ux /= ul; uy /= ul; uz /= ul; } else { ux = 1; uy = 0; uz = 0; }
        this.up[i * 3] = ux;
        this.up[i * 3 + 1] = uy;
        this.up[i * 3 + 2] = uz;
      }
    }
  }

  /** Node index whose segment contains `d`, clamped to the path. */
  private segmentFor(d: number): number {
    const n = this.n;
    if (d <= 0) return 0;
    if (d >= this.length) return n - 2;
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** Fill `out` with the frame at arc length `d`. Allocation-free. */
  sample(d: number, out: RailSample): RailSample {
    const i = this.segmentFor(d);
    const j = i + 1;
    const seg = this.cum[j] - this.cum[i];
    const u = seg > 1e-6 ? (d - this.cum[i]) / seg : 0;
    const uu = u < 0 ? 0 : u > 1 ? 1 : u;

    const i3 = i * 3;
    const j3 = j * 3;
    out.position.set(
      this.pos[i3] + (this.pos[j3] - this.pos[i3]) * uu,
      this.pos[i3 + 1] + (this.pos[j3 + 1] - this.pos[i3 + 1]) * uu,
      this.pos[i3 + 2] + (this.pos[j3 + 2] - this.pos[i3 + 2]) * uu,
    );

    let tx = this.tan[i3] + (this.tan[j3] - this.tan[i3]) * uu;
    let ty = this.tan[i3 + 1] + (this.tan[j3 + 1] - this.tan[i3 + 1]) * uu;
    let tz = this.tan[i3 + 2] + (this.tan[j3 + 2] - this.tan[i3 + 2]) * uu;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    out.tangent.set(tx, ty, tz);

    let ux = this.up[i3] + (this.up[j3] - this.up[i3]) * uu;
    let uy = this.up[i3 + 1] + (this.up[j3 + 1] - this.up[i3 + 1]) * uu;
    let uz = this.up[i3 + 2] + (this.up[j3 + 2] - this.up[i3 + 2]) * uu;
    const dot = ux * tx + uy * ty + uz * tz;
    ux -= tx * dot; uy -= ty * dot; uz -= tz * dot;
    const ul = Math.hypot(ux, uy, uz);
    if (ul > 1e-5) out.up.set(ux / ul, uy / ul, uz / ul);
    else out.up.set(0, 1, 0);

    out.distance = d;
    // Negative = descending, which is what `GRIND.gravityScale` multiplies.
    out.gradient = Math.asin(ty < -1 ? -1 : ty > 1 ? 1 : ty);
    return out;
  }

  /** World position of node `i` into `out`. */
  nodeInto(i: number, out: Vector3): Vector3 {
    return out.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
  }

  /** Does the AABB of a→b, grown by `pad`, overlap this path's AABB? */
  overlapsSegment(a: Vector3, b: Vector3, pad: number): boolean {
    const lx = (a.x < b.x ? a.x : b.x) - pad, hx = (a.x > b.x ? a.x : b.x) + pad;
    if (hx < this.minX || lx > this.maxX) return false;
    const ly = (a.y < b.y ? a.y : b.y) - pad, hy = (a.y > b.y ? a.y : b.y) + pad;
    if (hy < this.minY || ly > this.maxY) return false;
    const lz = (a.z < b.z ? a.z : b.z) - pad, hz = (a.z > b.z ? a.z : b.z) + pad;
    if (hz < this.minZ || lz > this.maxZ) return false;
    return true;
  }
}

/**
 * Sweep the segment a→b against every segment of `path` and report the closest
 * approach, with the vertical axis scaled by `yWeight` (a rail is easier to
 * catch from above than from the side, so vertical distance counts for less).
 *
 * Returns true if the weighted distance came inside `radius`.
 */
export function sweepPath(
  path: PolyPath,
  a: Vector3,
  b: Vector3,
  radius: number,
  yWeight: number,
  out: PathSweep,
): boolean {
  out.hit = false;
  const pad = radius + 0.5;
  if (!path.overlapsSegment(a, b, pad)) return false;

  const lx = (a.x < b.x ? a.x : b.x) - pad, hx = (a.x > b.x ? a.x : b.x) + pad;
  const ly = (a.y < b.y ? a.y : b.y) - pad, hy = (a.y > b.y ? a.y : b.y) + pad;
  const lz = (a.z < b.z ? a.z : b.z) - pad, hz = (a.z > b.z ? a.z : b.z) + pad;

  const r2 = radius * radius;
  let best = r2;
  const n = path.n;

  for (let i = 0; i < n - 1; i++) {
    const i3 = i * 3;
    const j3 = i3 + 3;
    const ax = path.pos[i3], ay = path.pos[i3 + 1], az = path.pos[i3 + 2];
    const bx = path.pos[j3], by = path.pos[j3 + 1], bz = path.pos[j3 + 2];

    // Per-segment AABB reject. This is what keeps a 400 m helix cheap.
    if ((ax < lx && bx < lx) || (ax > hx && bx > hx)) continue;
    if ((ay < ly && by < ly) || (ay > hy && by > hy)) continue;
    if ((az < lz && bz < lz) || (az > hz && bz > hz)) continue;

    _pa.set(ax, ay, az);
    _pb.set(bx, by, bz);
    closestSegSeg(a, b, _pa, _pb, _ss);

    const dx = _ss.p1.x - _ss.p2.x;
    const dy = (_ss.p1.y - _ss.p2.y) * yWeight;
    const dz = _ss.p1.z - _ss.p2.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= best) continue;

    best = d2;
    out.hit = true;
    out.dist2 = d2;
    out.s = _ss.s;
    out.distance = path.cum[i] + (path.cum[i + 1] - path.cum[i]) * _ss.t;
    out.point.copy(_ss.p2);
    out.queryPoint.copy(_ss.p1);
  }

  return out.hit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build-time helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Smooth a control cage into a dense polyline. Build time only — this
 * allocates, and it is the reason nothing at runtime has to.
 *
 * `spacing` is the target node spacing in metres. Rails are sampled at 2.5 m,
 * which at 74 m/s is four physics steps per node: fine enough that the
 * piecewise-linear tangent never reads as a kink, coarse enough that a 300 m
 * helix is 120 nodes rather than 1200.
 */
export function smoothCage(cage: Vector3[], spacing: number, closed = false): Vector3[] {
  if (cage.length < 3) {
    // Two points is already the smoothest it can be; just subdivide it.
    const out: Vector3[] = [];
    const a = cage[0];
    const b = cage[cage.length - 1];
    const steps = Math.max(1, Math.ceil(a.distanceTo(b) / spacing));
    for (let i = 0; i <= steps; i++) out.push(a.clone().lerp(b, i / steps));
    return out;
  }
  const curve = new CatmullRomCurve3(cage.map((p) => p.clone()), closed, 'centripetal', 0.5);
  let approx = 0;
  for (let i = 1; i < cage.length; i++) approx += cage[i].distanceTo(cage[i - 1]);
  const steps = Math.max(2, Math.ceil((approx * 1.06) / spacing));
  const pts = curve.getSpacedPoints(steps);
  return pts;
}
