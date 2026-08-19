/**
 * Sweep — the swept-volume tests every combat query in this subsystem runs on.
 *
 * WHY THIS FILE EXISTS
 *
 * `RUN.max` is 74 m/s and physics is a fixed 120 Hz step, so the player moves
 * 0.62 m between two consecutive samples and a dash moves 0.73 m. A point test
 * — "is the player inside this enemy right now?" — therefore misses on almost
 * every step in which it should have hit, and the failure is silent: nothing
 * throws, nothing looks broken, the player simply runs THROUGH enemies and
 * their attacks and the combat system appears to be "not wired up".
 *
 * Every test in here takes the segment from the previous position to the
 * current one. That covers the whole step, which is the only thing that is
 * true at this speed.
 *
 * SHAPE MODEL
 *
 * Everything in combat is a VERTICAL CAPSULE: an axis segment from `base` to
 * `base + height` with a radius. That is what the player is (`HULL`), what an
 * enemy body is, and what a projectile is (with height 0). For two vertical
 * capsules the overlap test factors cleanly:
 *
 *   • horizontally it is a 2D segment-vs-segment distance in XZ, and
 *   • vertically it is an interval overlap.
 *
 * The vertical half is deliberately CONSERVATIVE — it takes the union of the
 * whole sweep's vertical extent rather than the extent at the horizontally
 * closest parameter. Being generous by a fraction of a metre on a body that is
 * ~2 m tall costs nothing perceptible; missing a hit costs the whole feature.
 *
 * ZERO ALLOCATION
 *
 * Everything here is scalar in, scalar out. No Vector3 is constructed, no
 * object is returned. The one piece of returned state is `SWEEP_T`, the
 * parameter along the first segment at which the closest approach happened,
 * written to a module-scope slot by the routines that compute it. Callers that
 * want a contact point read it immediately after a `true` result.
 */

/** Parameter 0..1 along the FIRST segment at the closest approach. */
export let SWEEP_T = 0;
/** Squared XZ distance at the closest approach, metres². */
export let SWEEP_DIST_SQ = 0;

const EPS = 1e-9;

/**
 * Squared distance between two 2D segments, and the parameter along the first.
 * Ericson, Real-Time Collision Detection, 5.1.9, reduced to two dimensions.
 */
export function segSegDistSq2D(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number {
  const d1x = bx - ax, d1z = bz - az;   // first segment direction
  const d2x = dx - cx, d2z = dz - cz;   // second segment direction
  const rx = ax - cx, rz = az - cz;

  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;

  let s: number;
  let t: number;

  if (a <= EPS && e <= EPS) {
    // Both degenerate: two points.
    SWEEP_T = 0;
    SWEEP_DIST_SQ = rx * rx + rz * rz;
    return SWEEP_DIST_SQ;
  }
  if (a <= EPS) {
    s = 0;
    t = f / e;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  } else {
    const c = d1x * rx + d1z * rz;
    if (e <= EPS) {
      t = 0;
      s = -c / a;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
    } else {
      const b = d1x * d2x + d1z * d2z;
      const denom = a * e - b * b;
      if (denom > EPS) {
        s = (b * f - c * e) / denom;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
      } else {
        // Parallel: any s is as good; take the start and let t clamp.
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = -c / a;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
      } else if (t > 1) {
        t = 1;
        s = (b - c) / a;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
      }
    }
  }

  const px = ax + d1x * s, pz = az + d1z * s;
  const qx = cx + d2x * t, qz = cz + d2z * t;
  const ex = px - qx, ez = pz - qz;
  SWEEP_T = s;
  SWEEP_DIST_SQ = ex * ex + ez * ez;
  return SWEEP_DIST_SQ;
}

/** Squared distance from a 2D segment to a 2D point. Sets `SWEEP_T`. */
export function segPointDistSq2D(
  ax: number, az: number, bx: number, bz: number,
  px: number, pz: number,
): number {
  const dx = bx - ax, dz = bz - az;
  const len = dx * dx + dz * dz;
  let t = 0;
  if (len > EPS) {
    t = ((px - ax) * dx + (pz - az) * dz) / len;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const ex = ax + dx * t - px, ez = az + dz * t - pz;
  SWEEP_T = t;
  SWEEP_DIST_SQ = ex * ex + ez * ez;
  return SWEEP_DIST_SQ;
}

/**
 * Do two swept vertical capsules overlap at any point in the step?
 *
 * A is swept from (ax0,ay0,az0) to (ax1,ay1,az1); B from (bx0,…) to (bx1,…).
 * `ay`/`by` are the BASE of each capsule and `ah`/`bh` its height above that.
 * Returns true on overlap and leaves `SWEEP_T` at the parameter along A.
 */
export function sweptCapsulesOverlap(
  ax0: number, ay0: number, az0: number, ax1: number, ay1: number, az1: number, ar: number, ah: number,
  bx0: number, by0: number, bz0: number, bx1: number, by1: number, bz1: number, br: number, bh: number,
): boolean {
  const r = ar + br;
  if (segSegDistSq2D(ax0, az0, ax1, az1, bx0, bz0, bx1, bz1) > r * r) return false;
  const aLo = (ay0 < ay1 ? ay0 : ay1);
  const aHi = (ay0 > ay1 ? ay0 : ay1) + ah;
  const bLo = (by0 < by1 ? by0 : by1);
  const bHi = (by0 > by1 ? by0 : by1) + bh;
  return aHi >= bLo && bHi >= aLo;
}

/**
 * The common case: a swept capsule against a capsule that barely moved within
 * the step (an enemy at 20 m/s covers 0.17 m). Same maths, one fewer segment.
 */
export function sweptCapsuleVsCapsule(
  ax0: number, ay0: number, az0: number, ax1: number, ay1: number, az1: number, ar: number, ah: number,
  bx: number, by: number, bz: number, br: number, bh: number,
): boolean {
  const r = ar + br;
  if (segPointDistSq2D(ax0, az0, ax1, az1, bx, bz) > r * r) return false;
  const aLo = (ay0 < ay1 ? ay0 : ay1);
  const aHi = (ay0 > ay1 ? ay0 : ay1) + ah;
  return aHi >= by && by + bh >= aLo;
}

/**
 * Did a swept segment cross an expanding ground ring during this step?
 *
 * The ring grew from `r0` to `r1` around `(cx, cz)`. A shockwave at 55 m/s
 * sweeps 0.46 m of radius per step, which is thinner than the player is wide,
 * so this is tested as a BAND [r0 - pad, r1 + pad] against the closest and
 * furthest points of the player's own sweep — the two sweeps are only
 * comparable as intervals, and taking both extremes is what stops a fast
 * player from passing through the wavefront between two samples.
 */
export function sweptCrossesRing(
  ax0: number, az0: number, ax1: number, az1: number,
  cx: number, cz: number, r0: number, r1: number, pad: number,
): boolean {
  const d0 = Math.hypot(ax0 - cx, az0 - cz);
  const d1 = Math.hypot(ax1 - cx, az1 - cz);
  const near = d0 < d1 ? d0 : d1;
  const far = d0 > d1 ? d0 : d1;
  return far >= r0 - pad && near <= r1 + pad;
}
