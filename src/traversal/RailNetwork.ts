/**
 * RailNetwork — the grind rails.
 *
 * A rail is stored as its GRIND LINE: the polyline the character's FEET follow,
 * not the axis of the tube you can see. `PlayerPhysics.mountRail` copies
 * `sample.position` straight into `state.position`, and `state.position` is the
 * feet, so the sampled line has to be the feet line. The visible tube is drawn
 * `GRIND.rideHeight` below it. Getting this backwards buries the character in
 * the rail or floats them a metre over it, and both look like an animation bug
 * rather than a geometry one.
 *
 * MOUNTING IS A SWEPT TEST, AND THE REASON IS NOT THE ONE THIS SAID
 *
 * This file used to argue that a point test would MISS rails: at 74 m/s a 120 Hz
 * step covers 0.62 m, so a 4 m vertical window passes in six steps and the odds
 * of sampling one of them inside it are poor. That argument died with the unit
 * fix. A step covers 0.168 m at top speed, `SOLVER.maxSubstep` caps a probe
 * segment at 0.35 m either way, and `GRIND.snapRadius` is 2.6 m — so the window
 * is fifteen-plus steps wide and a point test would land inside it every time.
 * The same is true of every other probe in this directory, and saying otherwise
 * in four files would be four comments arguing from a number none of them read.
 *
 * The sweep stays, for the two reasons that survive:
 *
 *   It returns the CLOSEST APPROACH, not the first sample that happened to be
 *   in range. That is the point the mount snaps to and the path parameter the
 *   grind starts from, so a point test would mount you up to a step of travel
 *   away from where you actually met the rail — cosmetically wrong on a tube
 *   0.085 m thick, and it costs nothing to be right.
 *
 *   It does not depend on the step being small. Everything above is a statement
 *   about today's speed table and today's `maxSubstep`; the sweep is a statement
 *   about the geometry. One of those two survives the next retune.
 *
 * ALLOCATION
 *
 * `findMount` returns a module-scoped scratch result, reused every call. The
 * physics consumes it immediately (it copies the sample into player state), so
 * this is safe — but it does mean a caller must not hold the returned object
 * across another `findMount`. That is the price of a zero-allocation probe on
 * a path that runs 240 times a second.
 */

import { Group, Object3D, Vector3 } from 'three';

import { RailKind } from '../game/Contracts';
import type { IRailNetwork, RailInfo, RailSample } from '../game/Contracts';
import { GRIND } from '../player/SparkConstants';
import type { RailSpec } from './Layout';
import { PolyPath, makePathSweep, sweepPath } from './Path';
import type { PathSweep } from './Path';
import { MeshBuilder, chevronGeometry, strutGeometry, tubeGeometry } from './Meshes';
import type { RampName } from './Meshes';

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

const RAIL_TUNING = {
  /**
   * Vertical weighting in the mount metric. Below 1 the vertical axis counts
   * for less than the horizontal, which is what lets a character drop onto a
   * rail from three metres up while still requiring them to be laterally on it.
   */
  yWeight: 0.72,
  /** Lowest the feet may be relative to the grind line and still catch it. */
  minDy: -0.9,
  /**
   * Minimum |cos| between the character's horizontal travel and the rail's
   * horizontal tangent. 0.35 is 70 degrees: you can arrive at a fairly sharp
   * angle, but a rail crossing overhead at right angles is not a mount.
   */
  minAlign: 0.35,
  /** Route metres either side of the player a rail is considered within. */
  activeRange: 420,
  /** Route metres either side of the player a rail chunk is drawn. */
  drawRange: 620,
  /** Metres between support struts. */
  strutSpacing: 11,
  /** Number of entry chevrons at each mouth. */
  entryChevrons: 3,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Scratch
// ─────────────────────────────────────────────────────────────────────────────

function makeRailSample(): RailSample {
  return {
    position: new Vector3(),
    tangent: new Vector3(0, 0, 1),
    up: new Vector3(0, 1, 0),
    distance: 0,
    gradient: 0,
  };
}

const _sweep: PathSweep = makePathSweep();
const _probeSample = makeRailSample();
const _scratchSample = makeRailSample();
const _mount: { index: number; distance: number; sample: RailSample } = {
  index: -1,
  distance: 0,
  sample: makeRailSample(),
};
const _v = new Vector3();
const _c = new Vector3();
const _u = new Vector3();

// ─────────────────────────────────────────────────────────────────────────────
// RailNetwork
// ─────────────────────────────────────────────────────────────────────────────

interface Rail {
  info: RailInfo;
  path: PolyPath;
  kind: RailKind;
}

export class RailNetwork implements IRailNetwork {
  readonly object: Object3D = new Group();
  readonly rails: RailInfo[] = [];

  private items: Rail[] = [];
  private meshes: MeshBuilder;
  private routeDistance = 0;

  constructor(specs: RailSpec[]) {
    this.object.name = 'traversal-rails';
    this.meshes = new MeshBuilder(this.object);

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (spec.cage.length < 2) continue;
      const path = new PolyPath(spec.cage, spec.ups);
      const info: RailInfo = {
        index: this.items.length,
        kind: spec.kind,
        length: path.length,
        routeDistance: spec.routeDistance,
        exitRouteDistance: spec.exitRouteDistance,
        start: spec.cage[0].clone(),
        end: spec.cage[spec.cage.length - 1].clone(),
      };
      this.items.push({ info, path, kind: spec.kind });
      this.rails.push(info);
      this.buildGeometry(spec, path);
    }

    this.meshes.build();
  }

  // ── Geometry ───────────────────────────────────────────────────────────────

  private buildGeometry(spec: RailSpec, path: PolyPath): void {
    const d = spec.routeDistance;
    const preset: RampName =
      spec.kind === RailKind.Shortcut || spec.kind === RailKind.Helix ? 'frame' : 'metal';
    const tag = preset === 'frame' ? 'rail-alt' : 'rail-main';

    // The tube's axis sits `rideHeight` below the grind line, along the rail's
    // own up — so a banked rail's tube stays under the feet on the bank.
    const centres: Vector3[] = [];
    const ups: Vector3[] = [];
    for (let i = 0; i < spec.cage.length; i++) {
      const up = spec.ups[Math.min(i, spec.ups.length - 1)];
      centres.push(spec.cage[i].clone().addScaledVector(up, -GRIND.rideHeight));
      ups.push(up.clone());
    }

    this.meshes.add(tubeGeometry(centres, ups, spec.radius, 6), preset, tag, d, {
      matcapMix: 0.45,
      specPower: 24,
    });

    if (spec.struts) {
      const spacing = RAIL_TUNING.strutSpacing;
      const count = Math.max(2, Math.round(path.length / spacing));
      for (let i = 0; i <= count; i++) {
        const u = i / count;
        const idx = Math.min(centres.length - 1, Math.round(u * (centres.length - 1)));
        const top = centres[idx];
        // A strut is only honest if there is ground under it.
        const baseY = top.y - this.strutDrop(top);
        if (top.y - baseY < 0.45) continue;
        this.meshes.add(strutGeometry(top, baseY, 0.085), 'tyre', 'rail-strut', d, {
          matcapMix: 0.2,
        });
      }
    }

    // Entry chevrons: a flat arrow on the ground at each mouth, pointing the
    // way the rail runs. At 74 m/s the tube itself is a 9 cm line and reads as
    // nothing; the chevrons are what the player actually sees in time.
    for (const end of [0, 1]) {
      const at = end === 0 ? 0 : path.length;
      path.sample(at, _scratchSample);
      const dirSign = end === 0 ? 1 : -1;
      for (let k = 0; k < RAIL_TUNING.entryChevrons; k++) {
        const off = 2.2 + k * 2.0;
        _c.copy(_scratchSample.position).addScaledVector(_scratchSample.tangent, -dirSign * off);
        _c.addScaledVector(_scratchSample.up, -GRIND.rideHeight + 0.08);
        const geo = chevronGeometry(1.7, 2.2, 0.09);
        // Orient: chevron points +Z, so rotate it onto the rail tangent.
        const yaw = Math.atan2(_scratchSample.tangent.x * dirSign, _scratchSample.tangent.z * dirSign);
        geo.rotateY(yaw);
        geo.translate(_c.x, _c.y, _c.z);
        this.meshes.add(geo, 'marker', 'rail-mark', d, { outlineWidth: 0.011 });
      }
    }
  }

  /** Placeholder drop for a strut with no terrain reference: a short leg. */
  private strutDrop(top: Vector3): number {
    // The layout has already guaranteed 1.1-1.4 m of ground clearance under a
    // strutted rail, so a fixed leg is correct and does not need a terrain
    // query at build time. Longer legs on the taller body sections read as a
    // trestle rather than as a row of identical pegs.
    return Math.max(0.5, Math.min(3.2, 1.0 + (top.y % 1) * 0.6));
  }

  // ── IRailNetwork ───────────────────────────────────────────────────────────

  lengthOf(index: number): number {
    const r = this.items[index];
    return r ? r.path.length : 0;
  }

  sampleAt(index: number, distance: number, out?: RailSample): RailSample {
    const o = out ?? _scratchSample;
    const r = this.items[index];
    if (!r) {
      o.position.set(0, 0, 0);
      o.tangent.set(0, 0, 1);
      o.up.set(0, 1, 0);
      o.distance = 0;
      o.gradient = 0;
      return o;
    }
    const d = distance < 0 ? 0 : distance > r.path.length ? r.path.length : distance;
    return r.path.sample(d, o);
  }

  /**
   * The swept mount test.
   *
   * Returns a module-scoped result. Consume it before calling again.
   */
  findMount(
    from: Vector3,
    to: Vector3,
    velocity: Vector3,
    excludeIndex: number,
  ): { index: number; distance: number; sample: RailSample } | null {
    const vx = velocity.x;
    const vz = velocity.z;
    const vh = Math.hypot(vx, vz);
    const hasHeading = vh > 1e-3;

    let bestScore = Infinity;
    let bestIndex = -1;
    let bestDistance = 0;

    const lo = this.routeDistance - RAIL_TUNING.activeRange;
    const hi = this.routeDistance + RAIL_TUNING.activeRange;

    for (let i = 0; i < this.items.length; i++) {
      if (i === excludeIndex) continue;
      const r = this.items[i];
      // Route window first — an O(1) reject that removes most of the course.
      if (r.info.exitRouteDistance < lo || r.info.routeDistance > hi) continue;

      if (!sweepPath(r.path, from, to, GRIND.snapRadius, RAIL_TUNING.yWeight, _sweep)) continue;

      // Re-test the geometry properly at the closest approach: the sweep's
      // metric is weighted, and the ACCEPTANCE has to be in real metres.
      const dy = _sweep.queryPoint.y - _sweep.point.y;
      if (dy < RAIL_TUNING.minDy || dy > GRIND.snapHeight) continue;
      const dx = _sweep.queryPoint.x - _sweep.point.x;
      const dz = _sweep.queryPoint.z - _sweep.point.z;
      const horiz2 = dx * dx + dz * dz;
      if (horiz2 > GRIND.snapRadius * GRIND.snapRadius) continue;

      if (hasHeading) {
        r.path.sample(_sweep.distance, _probeSample);
        const tx = _probeSample.tangent.x;
        const tz = _probeSample.tangent.z;
        const tl = Math.hypot(tx, tz);
        if (tl > 1e-4) {
          const align = Math.abs((vx * tx + vz * tz) / (vh * tl));
          if (align < RAIL_TUNING.minAlign) continue;
        }
      }

      // Prefer the rail the character is closest to, then the one they meet
      // EARLIEST in the step — otherwise a crossing rail further along the
      // sweep can steal a mount from the one they actually reached first.
      const score = _sweep.dist2 + _sweep.s * 0.35;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
        bestDistance = _sweep.distance;
      }
    }

    if (bestIndex < 0) return null;

    _mount.index = bestIndex;
    _mount.distance = bestDistance;
    this.items[bestIndex].path.sample(bestDistance, _mount.sample);
    return _mount;
  }

  update(playerRouteDistance: number, _dt: number): void {
    this.routeDistance = playerRouteDistance;
    this.meshes.setWindow(playerRouteDistance, RAIL_TUNING.drawRange);
  }

  // ── Extras beyond the contract ─────────────────────────────────────────────

  /** The rail nearest a world point, for the stage director and debug views. */
  nearestRail(point: Vector3, maxDistance = 40): number {
    let best = maxDistance * maxDistance;
    let idx = -1;
    for (let i = 0; i < this.items.length; i++) {
      const r = this.items[i];
      _v.copy(r.info.start);
      const d0 = _v.distanceToSquared(point);
      _u.copy(r.info.end);
      const d1 = _u.distanceToSquared(point);
      const d = Math.min(d0, d1);
      if (d < best) { best = d; idx = i; }
    }
    return idx;
  }

  kindOf(index: number): RailKind | null {
    return this.items[index]?.kind ?? null;
  }

  dispose(): void {
    this.meshes.dispose();
    this.items.length = 0;
    this.rails.length = 0;
  }
}
