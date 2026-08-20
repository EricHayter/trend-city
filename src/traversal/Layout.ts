/**
 * Layout — the procedural planner.
 *
 * This file reads the finished course (`ITrack`) and the finished mountain
 * (`ITerrain`) once, at build time, and emits plain descriptors for everything
 * the traversal systems own. Nothing here runs during a step, so it is allowed
 * to allocate; and nothing downstream has to know how a shortcut was chosen.
 *
 * THE DESIGN CONSTRAINT IS SPEED
 *
 * A player arriving at `RUN.max` covers 74 m per second and a jump carries them
 * 68 m. So:
 *
 *  • Every mount point sits at the trail EDGE and about a metre above the
 *    ribbon — reachable with a hop, not a platforming puzzle. A rail whose
 *    entry is 6 m in the air is decoration.
 *  • Rails are 70-260 m long. Anything shorter than about 40 m is over in half
 *    a second and reads as a stumble rather than as a line.
 *  • A `Shortcut` is only accepted where the route turns hard enough for the
 *    chord to genuinely be shorter, and only if the mountain does not stand in
 *    the way. Both are measured, not assumed.
 *  • A `Span` is only placed where the ground under the centreline actually
 *    falls away. If the course has no such gap, no spans are emitted.
 */

import { Vector3 } from 'three';

import {
  BoosterKind,
  PickupKind,
  RailKind,
  TrackSectionKind,
} from '../game/Contracts';
import type { ITerrain, ITrack, TrackSampleResult } from '../game/Contracts';
import { GRAVITY, GRIND, HULL, JUMP, RUN, WALL } from '../player/SparkConstants';
import { Rng } from '../core/RNG';
import { clamp, lerp } from '../core/MathX';
import { smoothCage } from './Path';

// ─────────────────────────────────────────────────────────────────────────────
// Descriptors
// ─────────────────────────────────────────────────────────────────────────────

export interface RailSpec {
  kind: RailKind;
  routeDistance: number;
  exitRouteDistance: number;
  /** The GRIND LINE — where the character's feet go, not the tube's axis. */
  cage: Vector3[];
  ups: Vector3[];
  /** Drop struts to the ground under the rail. */
  struts: boolean;
  /** Tube radius, metres. */
  radius: number;
}

export interface WallSpec {
  routeDistance: number;
  /** Nodes along the face, at the base of the runnable band. */
  nodes: Vector3[];
  /** Outward (player-side) horizontal unit normals, one per node. */
  normals: Vector3[];
  height: number;
  /** Half of a facing pair — the wall-jump chimneys. */
  chimney: boolean;
}

export interface BoosterSpec {
  kind: BoosterKind;
  position: Vector3;
  /** Direction of travel through the booster. */
  forward: Vector3;
  up: Vector3;
  routeDistance: number;
  radius: number;
  /**
   * Spring: launch speed, m/s. Booster: speed added, m/s.
   * DashRing: exit speed, m/s. Ramp: lip angle, radians.
   */
  power: number;
}

export interface PickupSpec {
  kind: PickupKind;
  position: Vector3;
  routeDistance: number;
}

export interface Layout {
  rails: RailSpec[];
  walls: WallSpec[];
  boosters: BoosterSpec[];
  pickups: PickupSpec[];
  /** Contiguous stretches with no ground under the centreline. */
  gaps: { from: number; to: number; depth: number }[];
  courseLength: number;
}

export interface LayoutOptions {
  seed?: string;
  /** Multiplier on every density in here. 0 disables a whole class. */
  railDensity?: number;
  wallDensity?: number;
  boosterDensity?: number;
  pickupDensity?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Track probe — our own sample slots, so nobody hands us a recycled frame
// ─────────────────────────────────────────────────────────────────────────────

function makeSample(): TrackSampleResult {
  return {
    position: new Vector3(),
    tangent: new Vector3(0, 0, 1),
    left: new Vector3(1, 0, 0),
    up: new Vector3(0, 1, 0),
    halfWidth: 4,
    bank: 0,
    curvature: 0,
    distance: 0,
    t: 0,
    section: TrackSectionKind.TechnicalStart,
  };
}

/** Metres of rail node spacing. Four physics steps at top speed. */
const NODE_SPACING = 2.5;

/** Feet height above the ribbon at a rail's mount ramp. A hop reaches it. */
const ENTRY_HEIGHT = 1.15;
/** Feet height above the ribbon along a route rail's body. */
const BODY_HEIGHT = 2.55;
/** Metres of rail spent ramping between the two. */
const RAMP_LENGTH = 16;

/**
 * Lateral-rise score above which a wall plate is backed by real terrain and can
 * afford to be taller. Calibrated against the measured profile in
 * `lateralRise`'s comment — 12 catches the two genuinely steep flanks on the
 * current course and leaves the rest as plain 8.5 m plates.
 */
const WALL_NATURAL_SCORE = 12;

/**
 * Metres of runnable band a plate must offer at its UPHILL end.
 *
 * `WallSet` gives a plate one `baseY` and one `topY` for the whole panel, and
 * gates a mount on the character being inside `[baseY + 0.6, topY - 0.3]`. That
 * is a horizontal band, but a plate on this mountain spans a DESCENT — so the
 * ground the player stands on rises across the plate while the band does not,
 * and the band's usable part is `height - drop - 0.9`, not `height`.
 *
 * That was the bug. `pushWall` took `baseY` from the MINIMUM ground under the
 * plate, which on a descent is its downhill end, and left `height` at the 8.5
 * the scorer asked for. A 34-68 m plate at this course's 27% average drops 9-18
 * m, so the usable band was negative for a third of the plates and under 3 m for
 * most of the rest. Measured with `tools/capture/_wallsite.mjs`: 3 of 12 plates
 * had no runnable band at all, one of them buried 11.5 m into its own 8.5 m
 * height, and a physics probe placed on the face mounted 2 of 12.
 *
 * 6 m is the target, which is about three of the character's own height and
 * enough that arriving on a jump arc does not need to be precise.
 */
const WALL_MIN_BAND = 6.0;

/**
 * Metres of drop a single plate may span before it is truncated.
 *
 * Covering the drop with height is the fix, but it cannot be the whole fix: at
 * 27% a 68 m plate drops 18 m, and covering that means a 25 m slab, which is not
 * an outcrop any more. Truncating the plate where the drop reaches this instead
 * keeps both the height and the length in the range the geometry was designed
 * for — a plate ends up roughly this over `this / grade` metres of route, so 9 m
 * gives a 33 m plate on the average pitch and a shorter one on the steep ones,
 * which is the right way round.
 */
const WALL_MAX_DROP = 9.0;

/**
 * Metres of lateral separation a plate needs from any rail on its own side.
 *
 * `probeTraversal` tries boosters, then RAILS, then walls, and returns on the
 * first mount. So a rail inside a plate's approach does not compete with the
 * wall run — it pre-empts it, every time, and the plate becomes scenery.
 *
 * That is what was happening. A route rail sits at `halfWidth + 1.5` and a
 * plate's nodes at `halfWidth + 1.3`: twenty centimetres apart. Rails go down
 * every 110 m alternating sides and run 80-190 m, plates every 230 m on
 * whichever side the terrain rears up, so the two schedules beat against each
 * other and land on the same side often. Measured with
 * `tools/capture/_railprobe.mjs`: plates 6 and 11 mounted `rail13` and `rail24`
 * instead of running, and plate 8 was grinding for 46 of 60 steps.
 *
 * The clearance needed is the rail's capture radius plus the plate's own
 * contact reach, because a mount is decided on the character's hull and not on
 * either centreline. Anything closer than that and the rail's window strictly
 * contains the wall's.
 *
 * This is a PREFERENCE, not a constraint — see the comment at the swap in
 * `planWalls`. The overlap that survives it is resolved in
 * `PlayerPhysics.probeTraversal`, which asks the wall first while the character
 * is airborne, on the grounds that a rail can be mounted from the ground and a
 * wall cannot.
 */
const WALL_RAIL_CLEARANCE = GRIND.snapRadius + HULL.radius + 0.34;

/**
 * Metres a plate stands proud of the trail edge.
 *
 * Read by `pushWall`, which builds the nodes, and by `planWalls`, which has to
 * know where the face will land to test it against the rails. Those two used to
 * state 1.3 separately, which is the failure this file has already been bitten
 * by twice: a constant that is restated rather than read goes stale silently.
 */
const WALL_TRAIL_OFFSET = 1.3;

/** Route metres between chimney search windows. Two on a 2 km course. */
const CHIMNEY_STRIDE = 620;
/** Length of a chimney's plates, metres. Four to six wall jumps of climb. */
const CHIMNEY_LENGTH = 56;
/** Chimney plate height. Tall enough that the climb is the point. */
const CHIMNEY_HEIGHT = 15.5;
/**
 * Widest trail half-width that still makes a crossable chimney.
 *
 * The corridor is about `2 * (halfWidth + WALL_STANDOFF)`, so 6 gives a 14.6 m
 * gap. Wider than that and a wall jump does not carry the character to the
 * facing plate, which turns the feature into two unrelated wall runs.
 */
const CHIMNEY_MAX_HALF_WIDTH = 6;

class Planner {
  private a = makeSample();
  private b = makeSample();
  private rng: Rng;
  readonly L: number;

  constructor(private track: ITrack, readonly terrain: ITerrain, seed: string) {
    this.rng = new Rng(seed);
    this.L = track.length;
  }

  sample(d: number, slot: 0 | 1 = 0): TrackSampleResult {
    return this.track.sampleAtDistance(clamp(d, 0, this.L), slot === 0 ? this.a : this.b);
  }

  /** A point `lateral` metres left of centre and `h` metres above the ribbon. */
  point(d: number, lateral: number, h: number, out = new Vector3()): Vector3 {
    const s = this.sample(d, 1);
    out.copy(s.position).addScaledVector(s.left, lateral).addScaledVector(s.up, h);
    return out;
  }

  groundAt(p: Vector3): number {
    return this.terrain.heightAt(p.x, p.z);
  }

  terrainHeightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /** Ribbon height minus ground height — positive where the trail bridges air. */
  voidDepth(d: number): number {
    const s = this.sample(d, 1);
    return s.position.y - this.terrain.heightAt(s.position.x, s.position.z);
  }

  /** Heading change, radians, between two track distances. */
  headingChange(d0: number, d1: number): number {
    const t0 = this.sample(d0, 0).tangent;
    const a0 = Math.atan2(t0.x, t0.z);
    const t1 = this.sample(d1, 1).tangent;
    const a1 = Math.atan2(t1.x, t1.z);
    let dd = a1 - a0;
    while (dd > Math.PI) dd -= Math.PI * 2;
    while (dd < -Math.PI) dd += Math.PI * 2;
    return dd;
  }

  next(): number { return this.rng.next(); }
  range(a: number, b: number): number { return this.rng.range(a, b); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared geometry conditioning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lift a cage so no node is closer than `clearance` to the ground, then smooth
 * the vertical channel.
 *
 * The lift alone produces a rail with a kink wherever a boulder pokes through,
 * and a kinked rail at 74 m/s throws the character's facing sideways for a
 * frame. Three box-blur passes on Y remove the kink while keeping the lift,
 * so the smoothing runs AFTER the constraint and is re-applied to it.
 */
function clearGround(cage: Vector3[], terrain: ITerrain, clearance: number, smoothPasses = 3): void {
  const n = cage.length;
  for (let i = 0; i < n; i++) {
    const g = terrain.heightAt(cage[i].x, cage[i].z) + clearance;
    if (cage[i].y < g) cage[i].y = g;
  }
  const tmp = new Float32Array(n);
  for (let pass = 0; pass < smoothPasses; pass++) {
    for (let i = 0; i < n; i++) {
      const a = cage[Math.max(0, i - 1)].y;
      const b = cage[i].y;
      const c = cage[Math.min(n - 1, i + 1)].y;
      tmp[i] = (a + b * 2 + c) * 0.25;
    }
    // Endpoints are mount points and are never moved — they are the contract
    // with the route, and drifting them is what makes an entry unreachable.
    for (let i = 1; i < n - 1; i++) cage[i].y = Math.max(tmp[i], terrain.heightAt(cage[i].x, cage[i].z) + clearance * 0.75);
  }
}

/** Height profile of a rail's body: low at both mounts, high in the middle. */
function rampHeight(u: number, len: number, body: number): number {
  const inRamp = Math.min(u, len - u);
  if (inRamp >= RAMP_LENGTH) return body;
  const k = Math.max(0, inRamp) / RAMP_LENGTH;
  return lerp(ENTRY_HEIGHT, body, k * k * (3 - 2 * k));
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

export function planLayout(track: ITrack, terrain: ITerrain, options: LayoutOptions = {}): Layout {
  const p = new Planner(track, terrain, options.seed ?? 'traversal-layout');
  const L = p.L;

  const layout: Layout = {
    rails: [],
    walls: [],
    boosters: [],
    pickups: [],
    gaps: findGaps(p, L),
    courseLength: L,
  };

  const railD = options.railDensity ?? 1;
  const wallD = options.wallDensity ?? 1;
  const boostD = options.boosterDensity ?? 1;
  const pickD = options.pickupDensity ?? 1;

  if (railD > 0) {
    planRouteRails(p, layout, railD);
    planShortcuts(p, layout, railD);
    planSpans(p, layout);
    planHelixes(p, layout);
  }
  if (wallD > 0) planWalls(p, layout, wallD);
  if (boostD > 0) planBoosters(p, layout, boostD);
  if (pickD > 0) planPickups(p, layout, pickD);

  layout.rails.sort((a, b) => a.routeDistance - b.routeDistance);
  layout.walls.sort((a, b) => a.routeDistance - b.routeDistance);
  layout.boosters.sort((a, b) => a.routeDistance - b.routeDistance);
  layout.pickups.sort((a, b) => a.routeDistance - b.routeDistance);
  return layout;
}

// ── Gaps ─────────────────────────────────────────────────────────────────────

/**
 * A gap is a stretch where the ribbon stands well clear of the ground beneath
 * it. The ravine is the obvious one, but the carve leaves smaller ones wherever
 * the trail bridges a gully, and those are exactly where a `Span` earns itself.
 */
function findGaps(p: Planner, L: number): { from: number; to: number; depth: number }[] {
  const gaps: { from: number; to: number; depth: number }[] = [];
  const step = 3;
  let open = -1;
  let depth = 0;

  for (let d = 0; d <= L; d += step) {
    const v = p.voidDepth(d);
    const isGap = v > 5.5 || (p.sample(d, 0).section === TrackSectionKind.RavineGap && v > 2.5);
    if (isGap) {
      if (open < 0) { open = d; depth = v; }
      else if (v > depth) depth = v;
    } else if (open >= 0) {
      if (d - open >= 7) gaps.push({ from: open, to: d, depth });
      open = -1;
    }
  }
  if (open >= 0 && L - open >= 7) gaps.push({ from: open, to: L, depth });
  return gaps;
}

// ── Route rails ──────────────────────────────────────────────────────────────

function planRouteRails(p: Planner, out: Layout, density: number): void {
  const L = p.L;
  // One rail every ~110 m of route at density 1, alternating sides so the
  // player is never following a single hand rail down the whole mountain.
  const stride = 110 / Math.max(0.15, density);
  let side = 1;

  for (let d0 = 45; d0 < L - 70; d0 += stride) {
    const len = clamp(p.range(80, 190), 60, L - d0 - 25);
    if (len < 55) continue;
    const start = d0 + p.range(-8, 8);
    const cage: Vector3[] = [];
    const ups: Vector3[] = [];

    for (let u = 0; u <= len; u += NODE_SPACING) {
      const d = start + u;
      const s = p.sample(d, 1);
      const lateral = side * (s.halfWidth + 1.5);
      const h = rampHeight(u, len, BODY_HEIGHT);
      cage.push(new Vector3()
        .copy(s.position)
        .addScaledVector(s.left, lateral)
        .addScaledVector(s.up, h));
      ups.push(s.up.clone());
    }

    clearGround(cage, p.terrain, 1.1);

    out.rails.push({
      kind: RailKind.Route,
      routeDistance: start,
      exitRouteDistance: start + len,
      cage,
      ups,
      struts: true,
      radius: 0.085,
    });
    side = -side;
  }
}

// ── Shortcuts ────────────────────────────────────────────────────────────────

/**
 * A shortcut leaves the route on the INSIDE of a corner and rejoins it further
 * down. It is only worth building where the chord is genuinely shorter than the
 * arc, so the corner has to turn: the acceptance test is a measured heading
 * change of more than ~1.0 rad and a chord that saves at least 12% of the arc.
 *
 * It is also rejected outright if the mountain is in the way — an eroded ridge
 * can easily stand 30 m above the chord between two points on a switchback, and
 * a rail tunnelling through rock is worse than no rail.
 */
function planShortcuts(p: Planner, out: Layout, density: number): void {
  const L = p.L;
  const stride = 140 / Math.max(0.15, density);
  const a = new Vector3();
  const b = new Vector3();
  const probe = new Vector3();

  for (let d0 = 60; d0 < L - 160; d0 += stride) {
    let best = -1;
    let bestTurn = 0;
    for (let span = 110; span <= 230; span += 20) {
      if (d0 + span > L - 30) break;
      const turn = Math.abs(p.headingChange(d0, d0 + span));
      if (turn > bestTurn) { bestTurn = turn; best = span; }
    }
    if (best < 0 || bestTurn < 1.0) continue;

    const d1 = d0 + best;
    const inside = p.headingChange(d0, d1) > 0 ? 1 : -1;   // turning left → inside is left

    const s0 = p.sample(d0, 0);
    const s1 = p.sample(d1, 1);
    a.copy(s0.position).addScaledVector(s0.left, inside * (s0.halfWidth + 1.4)).addScaledVector(s0.up, ENTRY_HEIGHT);
    b.copy(s1.position).addScaledVector(s1.left, inside * (s1.halfWidth + 1.4)).addScaledVector(s1.up, ENTRY_HEIGHT);

    const chord = a.distanceTo(b);
    if (chord > best * 0.88) continue;                     // not actually a shortcut

    // Reject if the ground between the two anchors stands proud of the chord.
    let blocked = false;
    let maxIntrusion = 0;
    const steps = Math.max(6, Math.round(chord / 6));
    for (let i = 1; i < steps; i++) {
      const u = i / steps;
      probe.copy(a).lerp(b, u);
      const g = p.groundAt(probe);
      const intrusion = g - probe.y;
      if (intrusion > maxIntrusion) maxIntrusion = intrusion;
      if (intrusion > 9) { blocked = true; break; }
    }
    if (blocked) continue;

    // Bow the chord out over the terrain and lift the middle so it clears.
    const cageCage: Vector3[] = [a.clone()];
    for (let i = 1; i < 4; i++) {
      const u = i / 4;
      const q = new Vector3().copy(a).lerp(b, u);
      const arch = Math.sin(u * Math.PI) * (2.4 + maxIntrusion * 0.8);
      q.y += arch;
      cageCage.push(q);
    }
    cageCage.push(b.clone());

    const cage = smoothCage(cageCage, NODE_SPACING);
    clearGround(cage, p.terrain, 1.4);
    // Re-seat the mounts: `clearGround` leaves the endpoints alone, but the
    // smoothing pass upstream can move them, and an entry that has drifted a
    // metre up is an entry the player misses.
    cage[0].copy(a);
    cage[cage.length - 1].copy(b);

    const ups: Vector3[] = cage.map(() => new Vector3(0, 1, 0));

    out.rails.push({
      kind: RailKind.Shortcut,
      routeDistance: d0,
      exitRouteDistance: d1,
      cage,
      ups,
      struts: true,
      radius: 0.10,
    });
    d0 = d1 - stride + 40;   // do not stack shortcuts on top of each other
  }
}

// ── Spans ────────────────────────────────────────────────────────────────────

/** One span per gap, offset to one side so the jump is still an option. */
function planSpans(p: Planner, out: Layout): void {
  for (const gap of out.gaps) {
    const lead = 14;
    const from = Math.max(0, gap.from - lead);
    const to = Math.min(p.L, gap.to + lead);
    if (to - from < 16) continue;

    const side = out.rails.length % 2 === 0 ? 1 : -1;
    const cage: Vector3[] = [];
    const ups: Vector3[] = [];
    const len = to - from;

    for (let u = 0; u <= len; u += NODE_SPACING) {
      const d = from + u;
      const s = p.sample(d, 1);
      const lateral = side * s.halfWidth * 0.62;
      // Flat over the void — a span is a bridge, and a bridge that sags reads
      // as a rope. The ends drop to the lips so the mounts stay reachable.
      const h = rampHeight(u, len, 1.9);
      cage.push(new Vector3()
        .copy(s.position)
        .addScaledVector(s.left, lateral)
        .addScaledVector(s.up, h));
      ups.push(s.up.clone());
    }

    out.rails.push({
      kind: RailKind.Span,
      routeDistance: from,
      exitRouteDistance: to,
      cage,
      ups,
      // No struts: there is nothing under a span, which is the point of it.
      struts: false,
      radius: 0.11,
    });
  }
}

// ── Helixes ──────────────────────────────────────────────────────────────────

/**
 * A helix spirals down a drop. The site is the steepest 90 m window on the
 * course, measured — not guessed — and the spiral's turn count comes from how
 * much height there is to lose.
 */
function planHelixes(p: Planner, out: Layout): void {
  const L = p.L;
  const window = 90;
  if (L < window * 2.2) return;

  const sites: { d: number; drop: number }[] = [];
  for (let d = 40; d < L - window - 40; d += 10) {
    const y0 = p.sample(d, 0).position.y;
    const y1 = p.sample(d + window, 1).position.y;
    sites.push({ d, drop: y0 - y1 });
  }
  sites.sort((s, t) => t.drop - s.drop);

  const used: number[] = [];
  let made = 0;
  for (const site of sites) {
    if (made >= 2) break;
    if (site.drop < 16) break;
    if (used.some((u) => Math.abs(u - site.d) < 260)) continue;

    const d0 = site.d;
    const d1 = d0 + window;
    const s0 = p.sample(d0, 0);
    const s1 = p.sample(d1, 1);

    const side = p.next() < 0.5 ? 1 : -1;
    const radius = 15;
    const entry = new Vector3()
      .copy(s0.position)
      .addScaledVector(s0.left, side * (s0.halfWidth + 1.4))
      .addScaledVector(s0.up, ENTRY_HEIGHT);
    const exit = new Vector3()
      .copy(s1.position)
      .addScaledVector(s1.left, side * (s1.halfWidth + 1.4))
      .addScaledVector(s1.up, ENTRY_HEIGHT);

    // Axis: out to the side of the route, midway down, so the spiral hangs off
    // the mountain rather than boring into it.
    const mid = p.sample((d0 + d1) * 0.5, 0);
    const centre = new Vector3()
      .copy(mid.position)
      .addScaledVector(mid.left, side * (mid.halfWidth + 1.4 + radius));

    const a0 = Math.atan2(entry.z - centre.z, entry.x - centre.x);
    const a1 = Math.atan2(exit.z - centre.z, exit.x - centre.x);
    const turns = clamp(Math.round(site.drop / 14), 1, 3);
    // Wind in the direction that ends at the exit angle after `turns` turns.
    const dir = side > 0 ? 1 : -1;
    let sweep = (a1 - a0) * dir;
    while (sweep < 0) sweep += Math.PI * 2;
    sweep += (turns - 1) * Math.PI * 2;

    const nodes = Math.max(24, Math.round((sweep * radius) / NODE_SPACING));
    const cage: Vector3[] = [];
    const ups: Vector3[] = [];
    let blocked = false;
    for (let i = 0; i <= nodes; i++) {
      const u = i / nodes;
      const ang = a0 + dir * sweep * u;
      const r = lerp(radius, radius, u);
      const q = new Vector3(
        centre.x + Math.cos(ang) * r,
        lerp(entry.y, exit.y, u * u * (3 - 2 * u)),
        centre.z + Math.sin(ang) * r,
      );
      if (p.groundAt(q) - q.y > 6) { blocked = true; break; }
      cage.push(q);
      ups.push(new Vector3(0, 1, 0));
    }
    if (blocked || cage.length < 12) continue;

    // Stitch the ends onto the route so the entry and exit are real mounts.
    cage[0].copy(entry);
    cage[cage.length - 1].copy(exit);
    clearGround(cage, p.terrain, 1.2, 2);
    cage[0].copy(entry);
    cage[cage.length - 1].copy(exit);

    out.rails.push({
      kind: RailKind.Helix,
      routeDistance: d0,
      exitRouteDistance: d1,
      cage,
      ups,
      struts: true,
      radius: 0.095,
    });
    used.push(d0);
    made++;
  }
}

// ── Walls ────────────────────────────────────────────────────────────────────

/**
 * Walls are sited where the mountain already rears up beside the trail — the
 * scan looks for a face steeper than about 50 degrees and at least 6 m tall
 * within 8 m of the trail edge — and are then BUILT as a true vertical plate
 * standing proud of that face.
 *
 * Registering the heightfield itself as the wall was tried first and is wrong:
 * an eroded slope is 50-70 degrees, so the vertical plane the wall run needs
 * would cut through the ground, and the terrain resolve and the wall stick
 * fight each other for the whole run. A plate standing 1.2 m off the face is
 * unambiguous, reads as built, and gives `runLength` a real meaning.
 *
 * Every ~230 m a wall is placed whether or not the scan found a face, because
 * a mechanic that is only sometimes available is a mechanic players stop
 * looking for.
 */
/**
 * Score the terrain's lateral rise beside the trail over the next 60 m.
 *
 * A positive score means the ground climbs away from the trail on that side, so
 * a plate put there reads as an outcrop rather than a fence in a field.
 *
 * The threshold this is compared against is MEASURED, not guessed. The trail is
 * carved into the mountain and the carve blends over a wide margin, so at
 * `halfWidth + 1.5` the ground is still nearly trail-level; sampled every 230 m
 * down the current 2 km course, the best score on either side is:
 *
 *     d      70   300   530   760   990  1220  1450  1680  1910
 *     left  3.9     0     0     0   3.4     0     0     0     0
 *     right 3.5  19.6   3.3     0     0   3.4   6.7     0     0
 *
 * The old test asked for 45. Nothing on the mountain reaches half that, so
 * EVERY wall came out as the 8.5 m fallback and `natural` was dead code — which
 * also killed the chimneys, because they were gated behind it.
 */
function lateralRise(p: Planner, d0: number, side: number, probe: Vector3): number {
  let score = 0;
  for (let u = 0; u < 60; u += 6) {
    const s = p.sample(d0 + u, 1);
    probe.copy(s.position).addScaledVector(s.left, side * (s.halfWidth + 1.5));
    const h0 = p.groundAt(probe);
    probe.addScaledVector(s.left, side * 6);
    const h1 = p.groundAt(probe);
    const rise = h1 - h0;
    if (rise > 2.4) score += rise;
  }
  return score;
}

/**
 * Signed lateral offset of a rail from the trail centreline, in metres.
 *
 * Positive is `left`, matching the `side` a plate is placed on. Taken at the
 * rail's midpoint, which is enough: a rail is built at a constant lateral
 * offset along its whole length, and the ones that are not (helixes, spans)
 * wander far enough that a midpoint sample still answers the only question
 * being asked — is this thing in the plate's way.
 *
 * Derived from the cage rather than recorded at build time on purpose. A rail
 * kind added later gets this for free, and cannot forget to declare a side.
 */
function railLateral(p: Planner, rail: { routeDistance: number; exitRouteDistance: number; cage: Vector3[] }): number {
  const mid = rail.cage[Math.floor(rail.cage.length / 2)];
  const s = p.sample((rail.routeDistance + rail.exitRouteDistance) * 0.5, 1);
  return (mid.x - s.position.x) * s.left.x + (mid.z - s.position.z) * s.left.z;
}

function planWalls(p: Planner, out: Layout, density: number): void {
  const L = p.L;
  const stride = 230 / Math.max(0.15, density);
  const probe = new Vector3();

  // Every rail already placed, as (from, to, lateral). Rails are planned before
  // walls, so this is the complete set — and it has to be the complete set
  // rather than just the route rails, because a shortcut or a helix pre-empts a
  // wall run exactly as hard. See `WALL_RAIL_CLEARANCE`.
  const railBands = out.rails.map((r) => ({
    from: r.routeDistance,
    to: r.exitRouteDistance,
    lateral: railLateral(p, r),
  }));

  /** Is a rail close enough to this plate's face to pre-empt every mount on it? */
  const railInTheWay = (d0: number, d1: number, side: number, lateral: number): boolean =>
    railBands.some(
      (b) =>
        b.to > d0 &&
        b.from < d1 &&
        Math.sign(b.lateral) === side &&
        Math.abs(Math.abs(b.lateral) - lateral) < WALL_RAIL_CLEARANCE,
    );

  // Chimneys first, so the plain plates can be told where not to go. A plain
  // plate overlapping a chimney's span would sit inside one of its faces:
  // z-fighting to look at, and two candidate mounts a metre apart for
  // `WallSet.probe` to pick between at 74 m/s.
  const claimed = planChimneys(p, out, density);

  for (let d0 = 70; d0 < L - 60; d0 += stride) {
    // Score both sides over the next 60 m and take the steeper.
    let bestSide = 0;
    let bestScore = 0;
    for (const side of [-1, 1]) {
      const score = lateralRise(p, d0, side, probe);
      if (score > bestScore) { bestScore = score; bestSide = side; }
    }
    let side = bestSide !== 0 ? bestSide : (p.next() < 0.5 ? 1 : -1);
    const natural = bestScore > WALL_NATURAL_SCORE;

    let len = clamp(p.range(34, 68), 30, L - d0 - 20);

    // Shorten, then drop, rather than shifting: moving the plate downhill would
    // put it wherever the next chimney is not, which is how a fence ends up in
    // the middle of a straight.
    let skip = false;
    for (const [c0, c1] of claimed) {
      if (d0 + len <= c0 - 8 || d0 >= c1 + 8) continue;
      if (d0 + 30 <= c0 - 8) len = c0 - 8 - d0;
      else { skip = true; break; }
    }
    if (skip) continue;

    // A plate on a side a rail already owns is worth AVOIDING but never worth
    // skipping a site for. Rails go down every 110 m alternating sides and run
    // 80-190 m, so on this course both sides of a 30-68 m plate span are usually
    // covered somewhere: rejecting overlaps outright took the wall count from 12
    // to 4 and deleted both chimneys, which is a worse game than an overlap. So
    // the preference is soft — swap sides if that clears the rail, otherwise
    // build anyway and let `PlayerPhysics.probeTraversal` resolve it. See
    // `WALL_RAIL_CLEARANCE` for why the overlap matters at all.
    //
    // Lateral offset the face will end up at, measured from the centreline the
    // rails are measured from. `halfWidth` varies down the course, so it has to
    // be sampled at the site rather than assumed.
    const lateral = p.sample(d0 + len * 0.5, 1).halfWidth + WALL_TRAIL_OFFSET;
    if (railInTheWay(d0, d0 + len, side, lateral) && !railInTheWay(d0, d0 + len, -side, lateral)) {
      side = -side;
    }

    const height = natural ? clamp(7 + bestScore * 0.28, 8, 13) : 8.5;

    pushWall(p, out, d0, len, side, height, false);
  }
}

/**
 * The wall-jump chimneys.
 *
 * BUILT, NOT FOUND. Chimneys used to be a side effect of the terrain search
 * above: a plate got a facing twin only where the mountain happened to be steep
 * on one side AND the trail happened to be narrow AND a coin flip came up. On
 * this course that conjunction never occurred, so `PlayerPhysics.tryWallJump` —
 * which is written, tested and explicitly commented for "chaining wall jumps up
 * a chimney" — had no geometry anywhere on the mountain to chain up.
 *
 * A chimney is a designed feature in the same sense a rail or a kicker is. The
 * plates already stand `WALL_STANDOFF` off the ground and carry their own base
 * height, so nothing about them requires the terrain to have dug the corridor
 * first. What the terrain does decide is WHERE: the trail's own width is the
 * constraint, because the corridor between two facing plates is about
 * `2 * (halfWidth + WALL_STANDOFF)` wide, and a chimney the character cannot
 * cross in one bank is not a chimney, it is two separate walls.
 *
 * So: scan each window for its narrowest point rather than sampling one distance
 * and hoping. On the current course that finds the 1575-1800 gorge (halfWidth
 * 3.2, a 9 m corridor) and the 900-1125 narrows (halfWidth 5.1, a 13 m
 * corridor), which are the two places a player would look at and expect to be
 * able to go up.
 */
function planChimneys(p: Planner, out: Layout, density: number): Array<[number, number]> {
  const claimed: Array<[number, number]> = [];
  const L = p.L;
  const stride = CHIMNEY_STRIDE / Math.max(0.15, density);
  // Start past the first stretch: a chimney in the opening 200 m is reached
  // before the player has the speed to mount a wall at all.
  const first = 260;

  for (let w0 = first; w0 + CHIMNEY_LENGTH + 40 < L; w0 += stride) {
    const w1 = Math.min(L - CHIMNEY_LENGTH - 40, w0 + stride - CHIMNEY_LENGTH);
    if (w1 <= w0) continue;

    // Narrowest point in the window. Sampled at 15 m, which is finer than the
    // 25 m at which the width profile has any structure.
    let bestD = w0;
    let bestHalf = Infinity;
    for (let d = w0; d <= w1; d += 15) {
      const hw = p.sample(d, 0).halfWidth;
      if (hw < bestHalf) { bestHalf = hw; bestD = d; }
    }

    // Too wide to bank across is not a chimney. Skipped out loud rather than
    // built badly — a window with no narrow point simply has no chimney.
    if (bestHalf > CHIMNEY_MAX_HALF_WIDTH) continue;

    // Nudge off the exact minimum so the plates start just BEFORE the pinch and
    // the corridor closes as the player travels down it, which is the shape that
    // reads as an entrance.
    const d0 = Math.max(w0, bestD - CHIMNEY_LENGTH * 0.35);
    const height = CHIMNEY_HEIGHT;

    pushWall(p, out, d0, CHIMNEY_LENGTH, 1, height, true);
    pushWall(p, out, d0, CHIMNEY_LENGTH, -1, height, true);
    claimed.push([d0, d0 + CHIMNEY_LENGTH]);
  }

  return claimed;
}

function pushWall(
  p: Planner,
  out: Layout,
  d0: number,
  len: number,
  side: number,
  height: number,
  chimney: boolean,
): void {
  const nodes: Vector3[] = [];
  const normals: Vector3[] = [];
  const step = 6;
  let baseY = Infinity;
  let topG = -Infinity;

  for (let u = 0; u <= len; u += step) {
    const s = p.sample(d0 + u, 1);
    const q = new Vector3()
      .copy(s.position)
      .addScaledVector(s.left, side * (s.halfWidth + WALL_TRAIL_OFFSET));
    const g = p.terrainHeightAt(q.x, q.z);
    q.y = Math.min(g, s.position.y);
    // Stop where the plate has spanned as much drop as one flat band can carry.
    // Checked BEFORE the node is kept, and only once there are enough nodes to
    // be a plate, so a steep pitch yields a short plate rather than a slab.
    if (nodes.length >= 3 && Math.max(topG, q.y) - Math.min(baseY, q.y) > WALL_MAX_DROP) break;
    if (q.y < baseY) baseY = q.y;
    if (q.y > topG) topG = q.y;
    nodes.push(q);
    // The runnable face looks back at the trail, so the outward normal is the
    // direction the player comes from: -side * left.
    normals.push(new Vector3(-side * s.left.x, 0, -side * s.left.z).normalize());
  }
  if (nodes.length < 3) return;

  // One base height for the whole plate. A plate that follows the ground has a
  // base edge that steps, and the run height then steps with it — and `WallSet`
  // could not use it anyway, since a panel carries a single base and top.
  for (const n of nodes) n.y = baseY - 0.6;

  // The band is flat and the ground under it is not, so the height has to pay
  // for the drop before any of it is runnable. See `WALL_MIN_BAND`.
  const drop = Math.max(0, topG - baseY);
  const runnable = Math.max(height, drop + WALL_MIN_BAND + 0.9);

  out.walls.push({ routeDistance: d0, nodes, normals, height: runnable, chimney });
}

// ── Boosters ─────────────────────────────────────────────────────────────────

function planBoosters(p: Planner, out: Layout, density: number): void {
  const L = p.L;

  // Boost pads on straights: measured, so a pad never sits mid-corner where it
  // would fire the player off the outside of the trail.
  const stride = 165 / Math.max(0.15, density);
  for (let d = 90; d < L - 60; d += stride) {
    let straightest = d;
    let bestTurn = Infinity;
    for (let o = -30; o <= 30; o += 10) {
      const turn = Math.abs(p.headingChange(d + o, d + o + 40));
      if (turn < bestTurn) { bestTurn = turn; straightest = d + o; }
    }
    if (bestTurn > 0.35) continue;
    const s = p.sample(straightest, 0);
    const lateral = p.range(-0.4, 0.4) * s.halfWidth;
    out.boosters.push({
      kind: BoosterKind.Booster,
      position: p.point(straightest, lateral, 0.06),
      forward: s.tangent.clone(),
      up: s.up.clone(),
      routeDistance: straightest,
      radius: 3.4,
      // Additive speed, as a FRACTION of top speed rather than an absolute.
      // These powers were authored as bare m/s when `RUN.max` was 74, so when the
      // unit error behind that number was corrected (`SPARK_UNIT_METRES`) a pad
      // that had been worth a third of top speed became worth 1.2x of it. The
      // ratio is the design; the metres per second are a consequence of it.
      power: RUN.max * 0.324,
    });
  }

  // Springs: on the outside of a hard corner, where a player who has run wide
  // gets thrown forward and up instead of losing the line entirely.
  const springStride = 320 / Math.max(0.15, density);
  for (let d = 140; d < L - 120; d += springStride) {
    const turn = p.headingChange(d, d + 60);
    if (Math.abs(turn) < 0.5) continue;
    const outside = turn > 0 ? -1 : 1;
    const s = p.sample(d, 0);
    out.boosters.push({
      kind: BoosterKind.Spring,
      position: p.point(d, outside * (s.halfWidth * 0.78), 0.1),
      forward: s.tangent.clone(),
      up: s.up.clone(),
      routeDistance: d,
      radius: 2.9,
      // Vertical launch velocity, so the natural reference is a JUMP and not top
      // speed: 2.06 jumps' worth of rise is what this was when it was the bare
      // 34, and a spring that throws you about twice as high as your own jump is
      // the reason to aim for one.
      power: JUMP.velocity * 2.06,
    });
  }

  // Gaps get the full kit: a ramp on the near lip, then a chain of dash rings
  // strung across the void on the arc the ramp actually produces.
  for (const gap of out.gaps) {
    const lip = Math.max(6, gap.from - 10);
    const s = p.sample(lip, 0);
    const rampAngle = 0.42;
    out.boosters.push({
      kind: BoosterKind.Ramp,
      position: p.point(lip, p.range(-0.3, 0.3) * s.halfWidth, 0.0),
      forward: s.tangent.clone(),
      up: s.up.clone(),
      routeDistance: lip,
      radius: 4.2,
      power: rampAngle,
    });

    const width = gap.to - gap.from;
    const rings = clamp(Math.round(width / 26), 1, 4);
    for (let i = 1; i <= rings; i++) {
      const u = i / (rings + 1);
      const d = lerp(gap.from, gap.to, u);
      const sr = p.sample(d, 0);
      // Ballistic height of a launch at `rampAngle` off the lip, so the rings
      // sit ON the arc rather than above a guess of it.
      const v = RUN.max;
      const vy = v * Math.sin(rampAngle);
      const tflight = (d - lip) / Math.max(1, v * Math.cos(rampAngle));
      // `GRAVITY.accel`, not a literal 36. The literal was Spark's gravity in
      // SPARK units, and this solve is in world metres — so it placed the rings
      // on the arc of a launch under 3.7 Earth gravities and buried them in the
      // ravine wall.
      const y = vy * tflight - 0.5 * GRAVITY.accel * tflight * tflight;
      out.boosters.push({
        kind: BoosterKind.DashRing,
        position: p.point(d, 0, Math.max(3.2, y)),
        forward: sr.tangent.clone(),
        up: sr.up.clone(),
        routeDistance: d,
        radius: 3.4,
        // ABSOLUTE — a dash ring replaces the velocity outright, so this number
        // is the speed the player leaves at and it has to be read against the
        // speed table. 1.24x top speed is a shade over a dash (`DASH.speed` is
        // 1.19x), which is what makes flying the ring better than dashing the gap.
        power: RUN.max * 1.243,
      });
    }
  }

  // One dash ring at the exit of every shortcut and helix, as the reward for
  // having taken the line and as the thing that carries the exit speed on.
  for (const rail of out.rails) {
    if (rail.kind !== RailKind.Shortcut && rail.kind !== RailKind.Helix) continue;
    const d = rail.exitRouteDistance;
    const s = p.sample(d + 12, 0);
    out.boosters.push({
      kind: BoosterKind.DashRing,
      position: p.point(d + 12, 0, 3.0),
      forward: s.tangent.clone(),
      up: s.up.clone(),
      routeDistance: d + 12,
      radius: 3.6,
      // The reward ring at a shortcut exit, so it pays slightly better than the
      // ones strung across a gap: 1.30x top speed against their 1.24x.
      power: RUN.max * 1.297,
    });
  }
}

// ── Pickups ──────────────────────────────────────────────────────────────────

function planPickups(p: Planner, out: Layout, density: number): void {
  const L = p.L;
  const spacing = 7 / clamp(density, 0.15, 4);

  // Fragment lines down the trail, drifting across it in long slow arcs so
  // following the line is a racing line and not a corridor.
  for (let d = 25; d < L - 20; d += spacing) {
    const s = p.sample(d, 0);
    const lateral = Math.sin(d * 0.021) * s.halfWidth * 0.65;
    out.pickups.push({
      kind: PickupKind.Fragment,
      position: p.point(d, lateral, 1.1),
      routeDistance: d,
    });
  }

  // Fragments along every rail, at chest height on the grind line, so taking
  // the rail pays for itself.
  for (const rail of out.rails) {
    const n = rail.cage.length;
    const stepNodes = Math.max(2, Math.round(8 / NODE_SPACING));
    for (let i = stepNodes; i < n - stepNodes; i += stepNodes) {
      const q = rail.cage[i].clone();
      q.y += 0.95;
      const u = i / (n - 1);
      out.pickups.push({
        kind: PickupKind.Fragment,
        position: q,
        routeDistance: lerp(rail.routeDistance, rail.exitRouteDistance, u),
      });
    }
  }

  // Shards: rare, off the route, and always at the far end of something —
  // the top of a helix, the middle of a span, the outside of a wall run.
  for (const rail of out.rails) {
    if (rail.kind === RailKind.Route) continue;
    const q = rail.cage[Math.floor(rail.cage.length * 0.5)].clone();
    q.y += 3.4;
    out.pickups.push({
      kind: PickupKind.Shard,
      position: q,
      routeDistance: lerp(rail.routeDistance, rail.exitRouteDistance, 0.5),
    });
  }
  for (const wall of out.walls) {
    if (!wall.chimney) continue;
    const mid = wall.nodes[Math.floor(wall.nodes.length * 0.5)];
    const q = mid.clone().addScaledVector(wall.normals[0], 2.2);
    q.y += wall.height * 0.72;
    out.pickups.push({ kind: PickupKind.Shard, position: q, routeDistance: wall.routeDistance });
  }

  // Charges next to boosters, cells and clock time on a slow cadence.
  for (const b of out.boosters) {
    if (b.kind !== BoosterKind.DashRing) continue;
    const q = b.position.clone().addScaledVector(b.forward, 7);
    out.pickups.push({ kind: PickupKind.Charge, position: q, routeDistance: b.routeDistance + 7 });
  }
  for (let d = 180; d < L - 40; d += 420) {
    const s = p.sample(d, 0);
    out.pickups.push({
      kind: PickupKind.Cell,
      position: p.point(d, s.halfWidth * 0.8 * (p.next() < 0.5 ? 1 : -1), 1.3),
      routeDistance: d,
    });
  }
  for (let d = 260; d < L - 40; d += 300) {
    out.pickups.push({
      kind: PickupKind.Time,
      position: p.point(d, 0, 1.4),
      routeDistance: d,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants other traversal files need from the plan
// ─────────────────────────────────────────────────────────────────────────────

export const LAYOUT_CONSTANTS = {
  NODE_SPACING,
  ENTRY_HEIGHT,
  BODY_HEIGHT,
  /** Vertical drop from the grind line to the tube's axis. */
  RIDE_HEIGHT: GRIND.rideHeight,
  /** Wall plate thickness, metres. */
  WALL_THICKNESS: 1.1,
  /** How far the plate's face stands off the terrain. */
  WALL_STANDOFF: 1.3,
  /** Contact threshold for the wall sweep: hull radius plus a hand's reach. */
  WALL_CONTACT: HULL.radius + 0.34,
  /** Minimum along-wall speed a plate is worth building for. */
  WALL_MIN_SPEED: WALL.mountSpeed,
} as const;
