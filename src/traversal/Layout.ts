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
import { GRIND, HULL, RUN, WALL } from '../player/SparkConstants';
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
function planWalls(p: Planner, out: Layout, density: number): void {
  const L = p.L;
  const stride = 230 / Math.max(0.15, density);
  const probe = new Vector3();

  for (let d0 = 70; d0 < L - 60; d0 += stride) {
    // Score both sides over the next 60 m and take the steeper.
    let bestSide = 0;
    let bestScore = 0;
    for (const side of [-1, 1]) {
      let score = 0;
      for (let u = 0; u < 60; u += 6) {
        const s = p.sample(d0 + u, 1);
        probe.copy(s.position).addScaledVector(s.left, side * (s.halfWidth + 1.5));
        const h0 = p.groundAt(probe);
        probe.addScaledVector(s.left, side * 6);
        const h1 = p.groundAt(probe);
        const rise = h1 - h0;
        if (rise > 3.2) score += rise;
      }
      if (score > bestScore) { bestScore = score; bestSide = side; }
    }
    const side = bestSide !== 0 ? bestSide : (p.next() < 0.5 ? 1 : -1);
    const natural = bestScore > 45;

    // A chimney needs two facing plates and a corridor the character can bank
    // across. Only built where the trail is narrow enough to cross at speed.
    const s0 = p.sample(d0, 0);
    const chimney = natural && s0.halfWidth < 7 && p.next() < 0.45;

    const len = clamp(p.range(34, 68), 30, L - d0 - 20);
    const height = chimney ? 13.5 : natural ? clamp(6 + bestScore * 0.08, 7, 12) : 8.5;

    pushWall(p, out, d0, len, side, height, chimney);
    if (chimney) pushWall(p, out, d0, len, -side, height, true);
  }
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

  for (let u = 0; u <= len; u += step) {
    const s = p.sample(d0 + u, 1);
    const q = new Vector3()
      .copy(s.position)
      .addScaledVector(s.left, side * (s.halfWidth + 1.3));
    const g = p.terrainHeightAt(q.x, q.z);
    q.y = Math.min(g, s.position.y);
    if (q.y < baseY) baseY = q.y;
    nodes.push(q);
    // The runnable face looks back at the trail, so the outward normal is the
    // direction the player comes from: -side * left.
    normals.push(new Vector3(-side * s.left.x, 0, -side * s.left.z).normalize());
  }
  if (nodes.length < 3) return;

  // One base height for the whole plate. A plate that follows the ground has a
  // base edge that steps, and the run height then steps with it.
  for (const n of nodes) n.y = baseY - 0.6;

  out.walls.push({ routeDistance: d0, nodes, normals, height, chimney });
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
      power: 24,
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
      power: 34,
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
      const y = vy * tflight - 0.5 * 36 * tflight * tflight;
      out.boosters.push({
        kind: BoosterKind.DashRing,
        position: p.point(d, 0, Math.max(3.2, y)),
        forward: sr.tangent.clone(),
        up: sr.up.clone(),
        routeDistance: d,
        radius: 3.4,
        power: 92,
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
      power: 96,
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
