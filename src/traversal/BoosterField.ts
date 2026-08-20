/**
 * BoosterField — the springs, pads, dash rings and kickers.
 *
 * Three of the four kinds are TRIGGERS and one is pure geometry:
 *
 *   Booster   adds speed along the route. Additive, so it rewards arriving fast.
 *   Spring    replaces the velocity with a fixed launch. Absolute, so it is a
 *             recovery for a player who ran wide, not a speed exploit.
 *   DashRing  replaces the velocity with a fast one along the ring's axis. This
 *             is the thing that carries a gap crossing or a shortcut exit.
 *   Ramp      has no trigger at all. A kicker converts speed to height because
 *             the character RUNS UP IT — the geometry does the work, and a
 *             trigger here would fight the physics instead of using it.
 *
 * PROBING IS SWEPT, AND NOT FOR THE REASON THIS SAID
 *
 * See the long version in `RailNetwork`. Short version: the old argument was
 * that a point test misses features the player flew through, and it was quoted
 * here as "a dash ring is 3.4 m across, which is five steps at 74 m/s". Two
 * things were wrong with that. 3.4 is the RADIUS, so the ring is 6.8 m wide; and
 * a step covers 0.168 m now, not 0.62, so it is forty steps of travel and a
 * point test cannot miss it. The sweep is kept because it reports the closest
 * approach — which is what `nearest wins` below resolves overlaps by — and
 * because it holds regardless of how big a step gets.
 *
 * ONE HIT PER STEP
 *
 * `probe` returns at most one hit, the earliest along the segment, because the
 * physics applies the impulse to the velocity that the rest of the step is
 * integrated with. Firing two boosters in a step would apply the second one to
 * a velocity that never existed.
 *
 * ALLOCATION
 *
 * `probe` returns a module-scoped result, reused every call, on the same terms
 * as `RailNetwork.findMount`: consume it before calling again.
 */

import { Group, Matrix4, Object3D, Vector3 } from 'three';
import { BufferAttribute, BufferGeometry } from 'three';

import { BoosterKind } from '../game/Contracts';
import type { BoosterHit, IBoosterField } from '../game/Contracts';
import { BOOST, RUN } from '../player/SparkConstants';
import type { BoosterSpec } from './Layout';
import { MeshBuilder, chevronGeometry, coilGeometry, coneGeometry, padGeometry, ringGeometry } from './Meshes';

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

const BOOSTER_TUNING = {
  /**
   * Seconds before the same booster can fire again.
   *
   * Not a debounce for double-triggering inside one step — `probe` returns one
   * hit per step, so that cannot happen. This is for the player who lands ON a
   * spring and stays inside its radius: without a cooldown the spring re-fires
   * every step and the character is welded to it in a buzzing hover.
   */
  cooldown: 0.85,
  /** Route metres either side of the player a booster can fire. */
  activeRange: 260,
  /** Route metres either side of the player a chunk is drawn. */
  drawRange: 620,
  /**
   * Minimum |cos| between travel and the booster's forward. 0.30 is 72 degrees.
   * A pad you cross sideways is not a pad you used.
   */
  minAlign: 0.30,
  /**
   * A spring only fires on a player who is not already climbing away from it.
   * Rising faster than this through a spring means they have already been
   * launched by something else and re-launching would eat that momentum.
   */
  // Both of these are SPEEDS and both were bare m/s from when `RUN.max` was 74.
  // A 20 m/s floor on a spring's forward throw is a gentle nudge against a top
  // speed of 74 and very nearly top speed itself against 20.2, which would have
  // made every spring on the mountain a free launch to the speed ceiling.
  springMaxRise: RUN.max * 0.041,
  /** Fraction of the incoming horizontal speed a spring preserves. */
  springCarry: 0.72,
  /** Floor on a spring's forward speed, so a standing start still goes places. */
  springMinForward: RUN.max * 0.27,
  /** Ramp lip length, metres. The rise comes from the spec's angle. */
  rampLength: 10.0,
  /**
   * Fraction of a ramp's ideal deflection the trigger actually delivers.
   *
   * A ramp is the one booster whose effect is supposed to be free: run up the
   * wedge, the wedge turns your velocity, no trigger involved. That was the
   * design and the comment in `probe` said so — "Ramps are geometry. They never
   * fire." It was not true. The wedge is built through `MeshBuilder`, which is
   * RENDER geometry, and the character resolves against the terrain heightfield
   * and nothing else, so the wedge was a prop the player ran straight through.
   * Measured with `tools/capture/_kicker.mjs` at the ravine lip: peak vertical
   * velocity over 200 steps of running at it was -0.04 m/s. It never launched
   * anybody.
   *
   * So the ramp fires, and what it fires is what the geometry would have done:
   * rotate the velocity up by the lip angle, conserving magnitude. Not quite —
   * a real wedge scrubs some speed to friction and to the two direction changes
   * at its base and lip, and a lossless deflection off a 24-degree lip at top
   * speed is a bigger launch than the wedge looks like it should give. This is
   * that loss, and it is the knob to turn if the kicker feels weak or strong.
   */
  rampEfficiency: 0.86,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Scratch
// ─────────────────────────────────────────────────────────────────────────────

const _hit: BoosterHit = {
  kind: BoosterKind.Booster,
  impulse: new Vector3(),
  absolute: false,
  refreshes: false,
  position: new Vector3(),
};

const _seg = new Vector3();
const _rel = new Vector3();
const _near = new Vector3();
const _m = new Matrix4();
const _side = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const _p = new Vector3();

// ─────────────────────────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────────────────────────

interface Item {
  kind: BoosterKind;
  position: Vector3;
  forward: Vector3;
  up: Vector3;
  routeDistance: number;
  radius2: number;
  power: number;
  cooldown: number;
}

/**
 * A kicker: a wedge whose top face climbs from the ground to `rise` over
 * `length`, with a lip thickness so it reads in silhouette from the side.
 *
 * Built by hand rather than sheared out of a box because the top face has to be
 * a single flat quad — the outline weld creases at 78 degrees, and a box with a
 * displaced vertex gives the top face a diagonal seam that strokes across the
 * middle of the ramp.
 */
function wedgeGeometry(width: number, length: number, rise: number): BufferGeometry {
  const hw = width * 0.5;
  const z0 = -length * 0.5;
  const z1 = length * 0.5;
  const lip = 0.14;

  // 0..3 bottom (y=0), 4..7 top face, front edge low, back edge high.
  const v = [
    -hw, 0, z0, hw, 0, z0, hw, 0, z1, -hw, 0, z1,
    -hw, lip, z0, hw, lip, z0, hw, rise, z1, -hw, rise, z1,
  ];
  const idx = [
    // bottom, wound so it faces down
    0, 2, 1, 0, 3, 2,
    // top
    4, 5, 6, 4, 6, 7,
    // front (low end)
    0, 1, 5, 0, 5, 4,
    // back (high end)
    3, 7, 6, 3, 6, 2,
    // left
    0, 4, 7, 0, 7, 3,
    // right
    1, 2, 6, 1, 6, 5,
  ];

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Closest point on segment a→b to `c`, and the squared distance to it. */
function closestOnSegment(c: Vector3, a: Vector3, b: Vector3, out: Vector3): number {
  _seg.subVectors(b, a);
  const len2 = _seg.lengthSq();
  let t = 0;
  if (len2 > 1e-9) {
    _rel.subVectors(c, a);
    t = _rel.dot(_seg) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  out.copy(a).addScaledVector(_seg, t);
  return out.distanceToSquared(c);
}

// ─────────────────────────────────────────────────────────────────────────────
// BoosterField
// ─────────────────────────────────────────────────────────────────────────────

export class BoosterField implements IBoosterField {
  readonly object: Object3D = new Group();

  private items: Item[] = [];
  private meshes: MeshBuilder;
  private routeDistance = 0;

  constructor(specs: BoosterSpec[]) {
    this.object.name = 'traversal-boosters';
    this.meshes = new MeshBuilder(this.object);

    for (const spec of specs) {
      const up = spec.up.clone().normalize();
      const fwd = spec.forward.clone();
      // Project the forward onto the plane of the up so the pair is orthonormal
      // even where the track's own frame has drifted a degree or two.
      fwd.addScaledVector(up, -fwd.dot(up));
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
      fwd.normalize();

      const item: Item = {
        kind: spec.kind,
        position: spec.position.clone(),
        forward: fwd,
        up,
        routeDistance: spec.routeDistance,
        radius2: spec.radius * spec.radius,
        power: spec.power,
        cooldown: 0,
      };
      this.items.push(item);
      this.buildGeometry(item, spec.radius);
    }

    this.meshes.build();
  }

  // ── Geometry ───────────────────────────────────────────────────────────────

  /** Local +Z is the direction of travel, local +Y is the booster's up. */
  private orient(item: Item, lift = 0): Matrix4 {
    _up.copy(item.up);
    _fwd.copy(item.forward);
    _side.crossVectors(_up, _fwd).normalize();
    _m.makeBasis(_side, _up, _fwd);
    _p.copy(item.position).addScaledVector(_up, lift);
    _m.setPosition(_p);
    return _m;
  }

  private buildGeometry(item: Item, radius: number): void {
    const d = item.routeDistance;

    switch (item.kind) {
      case BoosterKind.Booster: {
        // A pad you can see from far enough away to aim at, with chevrons on it
        // that say which way it fires. At 74 m/s the pad is on screen for a
        // third of a second, so the arrows do the communicating, not the shape.
        const pad = padGeometry(radius, 0.16, 14);
        pad.applyMatrix4(this.orient(item));
        this.meshes.add(pad, 'metal', 'boost-pad', d, { matcapMix: 0.4, specPower: 30 });

        for (let k = 0; k < 3; k++) {
          const g = chevronGeometry(radius * 1.05, radius * 0.72, 0.07);
          g.translate(0, 0.17, (k - 1) * radius * 0.62);
          g.applyMatrix4(this.orient(item));
          this.meshes.add(g, 'marker', 'boost-mark', d, { outlineWidth: 0.012 });
        }
        break;
      }

      case BoosterKind.Spring: {
        const base = padGeometry(radius * 0.62, 0.14, 12);
        base.applyMatrix4(this.orient(item));
        this.meshes.add(base, 'metal', 'spring-base', d, { matcapMix: 0.35 });

        const coil = coilGeometry(radius * 0.34, 0.72, 3.5, 0.075);
        coil.translate(0, 0.14, 0);
        coil.applyMatrix4(this.orient(item));
        this.meshes.add(coil, 'metal', 'spring-coil', d, { matcapMix: 0.5, specPower: 40 });

        const cap = coneGeometry(radius * 0.5, 0.42);
        cap.translate(0, 0.86, 0);
        cap.applyMatrix4(this.orient(item));
        this.meshes.add(cap, 'rubber', 'spring-cap', d, {});
        break;
      }

      case BoosterKind.DashRing: {
        // `ringGeometry`'s hole faces +Z, which the orient basis maps onto the
        // direction of travel — so the ring is something you fly THROUGH with
        // no extra rotation.
        const ring = ringGeometry(radius, radius * 0.11);
        ring.applyMatrix4(this.orient(item));
        this.meshes.add(ring, 'frame', 'dash-ring', d, { matcapMix: 0.55, specPower: 36 });
        break;
      }

      case BoosterKind.Ramp: {
        // `power` is the lip angle in radians for a ramp, not a speed.
        const len = BOOSTER_TUNING.rampLength;
        const rise = Math.tan(item.power) * len;
        const wedge = wedgeGeometry(radius * 1.7, len, rise);
        // The spec's position is the lip's near edge, so the wedge's centre is
        // half a length further along.
        wedge.translate(0, 0, len * 0.5);
        wedge.applyMatrix4(this.orient(item));
        this.meshes.add(wedge, 'wood', 'ramp-body', d, { matcapMix: 0.12 });

        for (const s of [-1, 1]) {
          const rail = chevronGeometry(0.5, len * 0.9, 0.10);
          rail.translate(s * radius * 0.82, rise * 0.5 + 0.2, len * 0.5);
          rail.applyMatrix4(this.orient(item));
          this.meshes.add(rail, 'marker', 'ramp-mark', d, { outlineWidth: 0.012 });
        }
        break;
      }
    }
  }

  // ── IBoosterField ──────────────────────────────────────────────────────────

  /**
   * The swept probe. At most one hit, the earliest in the step.
   *
   * Returns a module-scoped result. Consume it before calling again.
   */
  probe(from: Vector3, to: Vector3, velocity: Vector3): BoosterHit | null {
    const speed = velocity.length();
    const lo = this.routeDistance - BOOSTER_TUNING.activeRange;
    const hi = this.routeDistance + BOOSTER_TUNING.activeRange;

    let best: Item | null = null;
    let bestDist2 = Infinity;

    for (const item of this.items) {
      if (item.cooldown > 0) continue;
      if (item.routeDistance < lo || item.routeDistance > hi) continue;

      const dist2 = closestOnSegment(item.position, from, to, _near);
      if (dist2 > item.radius2) continue;

      if (item.kind === BoosterKind.Spring) {
        if (velocity.dot(item.up) > BOOSTER_TUNING.springMaxRise) continue;
      } else if (item.kind === BoosterKind.Ramp) {
        // A ramp only works on someone running UP it, in the direction it faces
        // — not on someone crossing the lip sideways and not on someone already
        // flying over it. `minAlign` alone would fire on a backwards run.
        if (speed < 1e-3) continue;
        if (velocity.dot(item.forward) / speed < BOOSTER_TUNING.minAlign) continue;
        if (velocity.dot(item.up) > BOOSTER_TUNING.springMaxRise) continue;
      } else if (speed > 1e-3) {
        const align = Math.abs(velocity.dot(item.forward)) / speed;
        if (align < BOOSTER_TUNING.minAlign) continue;
      }

      // Nearest wins. Two boosters overlapping is a layout accident, and the
      // one the player actually went through is the one they were closest to.
      if (dist2 < bestDist2) {
        bestDist2 = dist2;
        best = item;
      }
    }

    if (!best) return null;
    best.cooldown = BOOSTER_TUNING.cooldown;

    _hit.kind = best.kind;
    _hit.position.copy(best.position);

    switch (best.kind) {
      case BoosterKind.Booster: {
        // Additive, but never past the boost ceiling: a chain of pads down a
        // straight should not stack the character into a speed the collision
        // sweep was never sized for.
        const along = velocity.dot(best.forward);
        const room = Math.max(0, BOOST.max - Math.max(along, 0));
        _hit.impulse.copy(best.forward).multiplyScalar(Math.min(best.power, room));
        _hit.absolute = false;
        _hit.refreshes = false;
        break;
      }

      case BoosterKind.Spring: {
        // Keep some of what the player brought, so hitting a spring at speed is
        // better than walking onto it — but the launch itself is fixed, which
        // is what makes a spring a recovery and not a launcher exploit.
        const carried = Math.max(
          BOOSTER_TUNING.springMinForward,
          velocity.dot(best.forward) * BOOSTER_TUNING.springCarry,
        );
        _hit.impulse
          .copy(best.forward)
          .multiplyScalar(Math.min(carried, RUN.max))
          .addScaledVector(best.up, best.power);
        _hit.absolute = true;
        _hit.refreshes = true;
        break;
      }

      case BoosterKind.DashRing: {
        _hit.impulse.copy(best.forward).multiplyScalar(best.power);
        _hit.absolute = true;
        _hit.refreshes = true;
        break;
      }

      case BoosterKind.Ramp: {
        // Do what the wedge would have done: rotate the velocity up by the lip
        // angle, keeping its magnitude, minus `rampEfficiency`. `power` is the
        // lip angle in radians for a ramp, not a speed.
        //
        // Rotating rather than adding is the whole point of a kicker, and it is
        // what makes this different from a spring: everything the player gets
        // out of it, they brought. Arrive slow and it is a hop; arrive at top
        // speed and it is the launch that carries the ravine. There is no floor
        // and no fixed component anywhere in it.
        const along = Math.max(0, velocity.dot(best.forward));
        const out = along * BOOSTER_TUNING.rampEfficiency;
        // Decompose against the ramp's own frame and rebuild. The LATERAL part
        // survives, so drifting across the lip is not erased; the VERTICAL part
        // does not, because a wedge you are standing on absorbs your descent
        // rather than carrying it through — and keeping it is what made the
        // first version of this fire and still not launch anyone. Running at the
        // ravine lip on a 27% grade, the arriving velocity is about (20, -14),
        // and preserving that -14 ate the whole 7.6 m/s the deflection gave.
        _hit.impulse
          .copy(velocity)
          .addScaledVector(best.forward, -velocity.dot(best.forward))
          .addScaledVector(best.up, -velocity.dot(best.up))
          .addScaledVector(best.forward, out * Math.cos(best.power))
          .addScaledVector(best.up, out * Math.sin(best.power));
        _hit.absolute = true;
        // A kicker is earned height, not a reset. Refreshing the air charges on
        // top would make it strictly better than a jump from the same spot.
        _hit.refreshes = false;
        break;
      }

      default:
        return null;
    }

    return _hit;
  }

  update(playerRouteDistance: number, dt: number): void {
    this.routeDistance = playerRouteDistance;
    this.meshes.setWindow(playerRouteDistance, BOOSTER_TUNING.drawRange);
    for (const item of this.items) {
      if (item.cooldown > 0) item.cooldown = Math.max(0, item.cooldown - dt);
    }
  }

  dispose(): void {
    this.meshes.dispose();
    this.items.length = 0;
  }
}
