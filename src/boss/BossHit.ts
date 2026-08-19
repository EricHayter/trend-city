/**
 * BossHit — swept intersection tests.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `RUN.max` is 74 m/s and the physics step is 120 Hz, so the player advances
 * 0.62 m per step and 0.92 m while dashing. Every boss hazard and every weak
 * point in this subsystem is therefore tested against the SWEPT SEGMENT from
 * the player's previous position to their current one, never against a point.
 *
 * That is not belt-and-braces. A point test against a 2.6 m orb at closing
 * speeds of 120 m/s samples the orb's neighbourhood once every metre, and the
 * orb is 5.2 m across — so it works, until the player dashes, and then it
 * silently stops working in exactly the situations the fight is about. Worse,
 * the hazards MOVE: a shock ring travelling at 62 m/s and a player running at
 * 74 m/s into it close at 136 m/s, which is 1.13 m per step against a 6.8 m
 * band. Both objects have to be swept, not just one.
 *
 * ── ZERO ALLOCATION ─────────────────────────────────────────────────────────
 *
 * Every function here is called several times per hazard per physics step.
 * All scratch is at module scope and no function in this file constructs
 * anything.
 *
 * ── THE RETURN CONVENTION ───────────────────────────────────────────────────
 *
 * Tests return the parameter `t` in [0,1] along the player's swept segment at
 * which contact first occurs, or -1 for no contact. `t` is used to place the
 * impact FX at the point of contact rather than at the end of the step, which
 * at 74 m/s is up to 0.62 m — about a third of the character's height — away
 * from where the hit actually happened.
 */

import { Vector3 } from 'three';

const _pa = new Vector3();
const _pb = new Vector3();
const _rel = new Vector3();
const _relV = new Vector3();
const _seg = new Vector3();
const _w = new Vector3();
const _q = new Vector3();

/** Player capsule radius used by every test here, metres. See HULL.radius. */
export const PLAYER_RADIUS = 0.42;
/** Player capsule height, metres. See HULL.height. */
export const PLAYER_HEIGHT = 1.72;

/**
 * Swept point against a swept sphere.
 *
 * Both objects move linearly over the step, so the relative motion is linear
 * too and this closes analytically: solve |rel0 + relV*t| = radius for the
 * smallest t in [0,1].
 *
 * `pa`/`pb` are the player's feet at the start and end of the step. The test
 * uses the player's CENTRE, so the caller's radius should already include
 * `PLAYER_RADIUS`; the half-height offset is applied here so callers never
 * have to remember that `PlayerState.position` is the feet and not the middle.
 */
export function sweptPointVsMovingSphere(
  pa: Vector3,
  pb: Vector3,
  ca: Vector3,
  cb: Vector3,
  radius: number,
): number {
  _pa.copy(pa);
  _pa.y += PLAYER_HEIGHT * 0.5;
  _pb.copy(pb);
  _pb.y += PLAYER_HEIGHT * 0.5;

  _rel.subVectors(_pa, ca);
  _relV.set(pb.x - pa.x - (cb.x - ca.x), _pb.y - _pa.y - (cb.y - ca.y), pb.z - pa.z - (cb.z - ca.z));

  const r = radius + PLAYER_RADIUS;
  const c = _rel.lengthSq() - r * r;
  // Already overlapping at the start of the step.
  if (c <= 0) return 0;

  const a = _relV.lengthSq();
  if (a < 1e-12) return -1;
  const b = 2 * _rel.dot(_relV);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > 1) return -1;
  return t;
}

/**
 * Squared distance from a point to a segment, and the parameter along it.
 * `_q` is left holding the closest point on the segment.
 */
function pointSegmentSq(p: Vector3, s0: Vector3, s1: Vector3): number {
  _seg.subVectors(s1, s0);
  _w.subVectors(p, s0);
  const len2 = _seg.lengthSq();
  let u = len2 > 1e-12 ? _w.dot(_seg) / len2 : 0;
  if (u < 0) u = 0;
  else if (u > 1) u = 1;
  _q.copy(s0).addScaledVector(_seg, u);
  return _q.distanceToSquared(p);
}

/**
 * Swept point against a MOVING segment — the arm sweep, the beam, a falling
 * slab. The segment's endpoints move from (`s0a`,`s1a`) to (`s0b`,`s1b`) over
 * the step.
 *
 * Solved by substepping rather than analytically: the closed form for a point
 * against a segment whose endpoints both translate is a quartic, and the
 * substep version is exact enough here because the caller chooses `samples` so
 * that neither body moves more than a fraction of `radius` per sample. The
 * assert on that is in the caller's constants, not here.
 */
export function sweptPointVsMovingSegment(
  pa: Vector3,
  pb: Vector3,
  s0a: Vector3,
  s1a: Vector3,
  s0b: Vector3,
  s1b: Vector3,
  radius: number,
  samples: number,
): number {
  const r = radius + PLAYER_RADIUS;
  const r2 = r * r;
  const n = samples < 2 ? 2 : samples;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    _pa.set(
      pa.x + (pb.x - pa.x) * t,
      pa.y + (pb.y - pa.y) * t + PLAYER_HEIGHT * 0.5,
      pa.z + (pb.z - pa.z) * t,
    );
    _pb.set(s0a.x + (s0b.x - s0a.x) * t, s0a.y + (s0b.y - s0a.y) * t, s0a.z + (s0b.z - s0a.z) * t);
    _rel.set(s1a.x + (s1b.x - s1a.x) * t, s1a.y + (s1b.y - s1a.y) * t, s1a.z + (s1b.z - s1a.z) * t);
    if (pointSegmentSq(_pa, _pb, _rel) <= r2) return t;
  }
  return -1;
}

/**
 * Swept point against an EXPANDING GROUND RING — the shock wave.
 *
 * The hazard is an annulus in XZ of half-width `halfWidth` about a radius that
 * grows from `r0` to `r1` across the step, and a height band from the local
 * ground up to `height`.
 *
 * Both the player and the ring move, and they close at up to 136 m/s, so this
 * substeps in the RELATIVE RADIAL COORDINATE: at each sample the ring's radius
 * is interpolated alongside the player's position, and the test is a single
 * scalar comparison. With the band 6.8 m across and 6 samples the worst-case
 * gap between samples is 0.19 m, which is 3% of the band.
 *
 * `groundY` is the terrain height under the player, so the height band is
 * measured from the floor rather than from the ring's origin — the arena floor
 * is a mountain, not a plane, and a ring emitted on the dais would otherwise
 * pass harmlessly overhead 7 m up.
 */
export function sweptPointVsRing(
  pa: Vector3,
  pb: Vector3,
  centre: Vector3,
  r0: number,
  r1: number,
  halfWidth: number,
  height: number,
  groundYa: number,
  groundYb: number,
  samples: number,
): number {
  const n = samples < 2 ? 2 : samples;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = pa.x + (pb.x - pa.x) * t;
    const pz = pa.z + (pb.z - pa.z) * t;
    const py = pa.y + (pb.y - pa.y) * t;
    const gy = groundYa + (groundYb - groundYa) * t;
    // Feet above the band and the whole capsule clear of it.
    if (py - gy > height) continue;
    // Deep under the ground (fell through a hole, or the sample is stale).
    if (py - gy < -PLAYER_HEIGHT) continue;
    const dx = px - centre.x;
    const dz = pz - centre.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const r = r0 + (r1 - r0) * t;
    if (Math.abs(d - r) <= halfWidth + PLAYER_RADIUS) return t;
  }
  return -1;
}

/**
 * Swept point against a moving vertical CAPSULE — the boss's own body while it
 * is charging. The capsule stands from `base` to `base + height` and the base
 * translates from `ba` to `bb`.
 */
export function sweptPointVsMovingColumn(
  pa: Vector3,
  pb: Vector3,
  ba: Vector3,
  bb: Vector3,
  radius: number,
  height: number,
  samples: number,
): number {
  const r = radius + PLAYER_RADIUS;
  const r2 = r * r;
  const n = samples < 2 ? 2 : samples;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = pa.x + (pb.x - pa.x) * t;
    const pz = pa.z + (pb.z - pa.z) * t;
    const py = pa.y + (pb.y - pa.y) * t + PLAYER_HEIGHT * 0.5;
    const bx = ba.x + (bb.x - ba.x) * t;
    const by = ba.y + (bb.y - ba.y) * t;
    const bz = ba.z + (bb.z - ba.z) * t;
    if (py < by - PLAYER_HEIGHT * 0.5 || py > by + height) continue;
    const dx = px - bx;
    const dz = pz - bz;
    if (dx * dx + dz * dz <= r2) return t;
  }
  return -1;
}

/**
 * Swept point against a static horizontal SLAB BAND — used for the arc sweep,
 * where the hazard is a rotating radial segment with a vertical band that the
 * player answers by sliding under or jumping over.
 *
 * The band test is separate from the segment test because the ANSWER to the
 * move lives in the band: `bandLow` is above a standing character and
 * `bandHigh` is under a double jump, and that is the entire design of the
 * move. Folding it into a capsule radius would blur both edges.
 */
export function bandOverlaps(
  pa: Vector3,
  pb: Vector3,
  t: number,
  groundY: number,
  bandLow: number,
  bandHigh: number,
): boolean {
  const feet = pa.y + (pb.y - pa.y) * t - groundY;
  const head = feet + PLAYER_HEIGHT;
  return head >= bandLow && feet <= bandHigh;
}

/** Lerp a point along the player's swept segment into `out`. */
export function pointAt(pa: Vector3, pb: Vector3, t: number, out: Vector3): Vector3 {
  return out.set(
    pa.x + (pb.x - pa.x) * t,
    pa.y + (pb.y - pa.y) * t,
    pa.z + (pb.z - pa.z) * t,
  );
}
