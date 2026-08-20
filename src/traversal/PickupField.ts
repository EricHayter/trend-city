/**
 * PickupField — the fragments, shards, cells, charges and time bonuses.
 *
 * WHY INSTANCED AND NOT MERGED
 *
 * A 2 km course at seven-metre fragment spacing is roughly three hundred
 * collectibles. Three hundred meshes is three hundred draw calls plus three
 * hundred outline hulls, which is more draw calls than the rest of the frame put
 * together. Merging them into route chunks the way `MeshBuilder` does for rails
 * would fix the draw calls but not the problem: a collectible has to VANISH when
 * it is taken and SPIN while it waits, and neither is expressible on a merged
 * mesh without rewriting vertex buffers.
 *
 * So: one `InstancedMesh` per kind, with the spin, the bob and the collect pop
 * all living in the instance matrix. Five draw calls for the whole course, and
 * the animation is a matrix compose per visible item — which at seventy-odd
 * visible items is nothing next to the terrain.
 *
 * COLLECTION IS SWEPT, AND HERE IT IS NEARLY REDUNDANT
 *
 * The old claim — 0.62 m steps against a one-metre radius, so a point test drops
 * a third of them — was arithmetic on 74 m/s. `PICKUP_REACH` is 1.5 m and a step
 * covers 0.168 m, so the reach is eighteen steps wide and a point test would
 * take every fragment on the mountain. This sweep changes no outcome today. It
 * is a segment test because it costs the same as a point test, and because the
 * one thing it does not depend on is the step staying small.
 *
 * WHAT IS NOT REDUNDANT: SEVERAL HITS PER STEP
 *
 * Unlike the rail and booster probes, this one returns EVERY hit rather than the
 * nearest. Fragments are strung about seven metres apart, so one step never
 * crosses two — but `PICKUP_REACH` is 1.5 m and the reach is a sphere, so a line
 * of fragments taken at an angle can put two inside it at once, and a spring or
 * dash-ring launch moves the player far enough in one step to do it deliberately.
 * Returning one would silently eat the other.
 */

import {
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { BufferGeometry } from 'three';

import { PickupKind } from '../game/Contracts';
import type { IPickupField, PickupEvent } from '../game/Contracts';
import { CelMaterial, disposeCelMaterial } from '../npr/CelMaterial';
import type { CelOptions } from '../npr/CelMaterial';
import { attachOutline, registerNprMesh } from '../npr/CelMaterial';
import { finalizeGeometry } from '../npr/OutlineGeometry';
import { RAMPS } from '../npr/Palette';
import type { RampName } from './Meshes';
import { cellGeometry, fragmentGeometry, ringGeometry, shardGeometry } from './Meshes';
import type { PickupSpec } from './Layout';

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

const PICKUP_TUNING = {
  /**
   * Route metres either side of the player an item animates and can be taken.
   *
   * Generous, because a shortcut rail can put the player a long way off the
   * centreline while their route distance barely moves, and a collectible that
   * refuses to be collected because the window closed is a bug the player reads
   * as the game cheating.
   */
  activeRange: 340,
  /** Seconds the collect pop takes to play out. */
  popTime: 0.16,
  /** Peak extra scale during the pop. */
  popScale: 2.4,
  /** Bob amplitude, metres, and rate, radians per second. */
  bobAmp: 0.14,
  bobRate: 2.3,
  /** Spin rate, radians per second. */
  spinRate: 1.9,
} as const;

/** Geometry, palette and scale for each kind. */
const KIND_STYLE: Record<PickupKind, { geo: () => BufferGeometry; ramp: RampName; spin: number }> = {
  [PickupKind.Fragment]: { geo: () => fragmentGeometry(0.34), ramp: 'marker', spin: 1.0 },
  [PickupKind.Shard]: { geo: () => shardGeometry(0.40), ramp: 'lens', spin: 0.55 },
  [PickupKind.Cell]: { geo: () => cellGeometry(0.36), ramp: 'frame', spin: 0.8 },
  [PickupKind.Charge]: { geo: () => cellGeometry(0.32), ramp: 'frame', spin: 1.4 },
  [PickupKind.Time]: { geo: () => ringGeometry(0.34, 0.09), ramp: 'metal', spin: 0.7 },
};

const PICKUP_OPTS: CelOptions = {
  matcapMix: 0.55,
  specPower: 34,
  specStrength: 0.6,
};

// ─────────────────────────────────────────────────────────────────────────────
// Scratch
// ─────────────────────────────────────────────────────────────────────────────

const _seg = new Vector3();
const _rel = new Vector3();
const _near = new Vector3();
const _m = new Matrix4();
const _pos = new Vector3();
const _quat = new Quaternion();
const _scale = new Vector3();
const _axis = new Vector3(0, 1, 0);
const _zero = new Matrix4().makeScale(0, 0, 0);

// ─────────────────────────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────────────────────────

interface Item {
  kind: PickupKind;
  position: Vector3;
  routeDistance: number;
  /** Index in `all` — this is the `index` the contract's events carry. */
  index: number;
  /** Which bucket, and which instance slot inside it. */
  bucket: number;
  slot: number;
  taken: boolean;
  /** Seconds left of the collect pop. */
  pop: number;
  /** Per-item offset so a line of fragments does not pulse in unison. */
  phase: number;
  /** True while the instance matrix is not the zero matrix. */
  live: boolean;
}

interface Bucket {
  kind: PickupKind;
  mesh: InstancedMesh;
  material: CelMaterial;
  geometry: BufferGeometry;
  items: Item[];
  spin: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PickupField
// ─────────────────────────────────────────────────────────────────────────────

export class PickupField implements IPickupField {
  readonly object: Object3D = new Group();
  readonly totals: Record<PickupKind, number> = {
    [PickupKind.Fragment]: 0,
    [PickupKind.Shard]: 0,
    [PickupKind.Cell]: 0,
    [PickupKind.Charge]: 0,
    [PickupKind.Time]: 0,
  };

  private all: Item[] = [];
  private buckets: Bucket[] = [];
  private routeDistance = 0;
  private time = 0;

  constructor(specs: PickupSpec[]) {
    this.object.name = 'traversal-pickups';

    // Group by kind first: an InstancedMesh's count is fixed at construction,
    // so every item of a kind has to be known before its mesh exists.
    const byKind = new Map<PickupKind, PickupSpec[]>();
    for (const spec of specs) {
      let list = byKind.get(spec.kind);
      if (!list) { list = []; byKind.set(spec.kind, list); }
      list.push(spec);
      this.totals[spec.kind]++;
    }

    for (const [kind, list] of byKind) {
      const style = KIND_STYLE[kind];
      if (!style || list.length === 0) continue;
      const bucketIndex = this.buckets.length;

      const items: Item[] = [];
      for (let slot = 0; slot < list.length; slot++) {
        const spec = list[slot];
        const item: Item = {
          kind,
          position: spec.position.clone(),
          routeDistance: spec.routeDistance,
          index: this.all.length,
          bucket: bucketIndex,
          slot,
          taken: false,
          pop: 0,
          // Deterministic, and derived from the position so the same course
          // always animates the same way. A random phase here would make the
          // capture harness non-reproducible.
          phase: (spec.routeDistance * 0.7 + spec.position.x * 0.31) % (Math.PI * 2),
          live: false,
        };
        items.push(item);
        this.all.push(item);
      }

      this.buckets.push(this.buildBucket(kind, items, style));
    }
  }

  private buildBucket(
    kind: PickupKind,
    items: Item[],
    style: { geo: () => BufferGeometry; ramp: RampName; spin: number },
  ): Bucket {
    const geo = style.geo();
    finalizeGeometry(geo, { tolerance: 5e-4, maxWeldAngle: 78, ao: true, aoStrength: 0.35 });

    const n = items.length;
    // The cel vertex shader reads all three per-instance channels whenever three
    // defines USE_INSTANCING. An unbound one reads as (0,0,0,1) and tints every
    // instance black — the same trap `Furniture.addInstanced` documents.
    const tint = new Float32Array(n * 3);
    const fade = new Float32Array(n);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      tint[i * 3] = 1;
      tint[i * 3 + 1] = 1;
      tint[i * 3 + 2] = 1;
      fade[i] = 1;
      phase[i] = items[i].phase;
    }
    geo.setAttribute('aInstanceTint', new InstancedBufferAttribute(tint, 3));
    geo.setAttribute('aInstanceFade', new InstancedBufferAttribute(fade, 1));
    geo.setAttribute('aInstancePhase', new InstancedBufferAttribute(phase, 1));

    const name = `pickup-${kind}`;
    const opts: CelOptions = { ...PICKUP_OPTS, name, instanced: true };
    const material = new CelMaterial(RAMPS[style.ramp], opts);
    const mesh = new InstancedMesh(geo, material, n);
    mesh.name = name;
    // Collectibles are small, bright and everywhere. Having them cast shadows
    // costs a shadow-pass draw for every one and buys a 20 cm smudge.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Every instance starts hidden. `update` reveals the ones in the window, so
    // there is no frame where three hundred collectibles are all on screen.
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, _zero);
    mesh.instanceMatrix.needsUpdate = true;
    // The bounding sphere from the zeroed matrices would be a point at the
    // origin, which frustum-culls the whole bucket. Instancing is a per-course
    // spread, so the cheap correct answer is not to cull it at all.
    mesh.frustumCulled = false;
    registerNprMesh(mesh, material);

    const group = new Group();
    group.name = `${name}:group`;
    const hull = attachOutline(mesh, RAMPS[style.ramp], opts);
    if (hull) {
      hull.frustumCulled = false;
      group.add(hull);
    }
    group.add(mesh);
    this.object.add(group);

    return { kind, mesh, material, geometry: geo, items, spin: style.spin };
  }

  // ── IPickupField ───────────────────────────────────────────────────────────

  /**
   * Swept collection.
   *
   * `out` is a caller-owned pool: entries already in it are overwritten in place
   * and only a genuinely new slot allocates, so a hot loop that reuses one array
   * never allocates at all. Returns how many entries of `out` are valid.
   */
  collect(from: Vector3, to: Vector3, radius: number, out: PickupEvent[]): number {
    const lo = this.routeDistance - PICKUP_TUNING.activeRange;
    const hi = this.routeDistance + PICKUP_TUNING.activeRange;
    const r2 = radius * radius;
    let count = 0;

    for (const item of this.all) {
      if (item.taken) continue;
      if (item.routeDistance < lo || item.routeDistance > hi) continue;

      // Test against the item's RESTING height, not its bobbed one. The bob is
      // a visual flourish and making it part of the hitbox means a fragment is
      // sometimes uncollectable depending on when in its cycle you arrive.
      _seg.subVectors(to, from);
      const len2 = _seg.lengthSq();
      let t = 0;
      if (len2 > 1e-9) {
        _rel.subVectors(item.position, from);
        t = _rel.dot(_seg) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      _near.copy(from).addScaledVector(_seg, t);
      if (_near.distanceToSquared(item.position) > r2) continue;

      item.taken = true;
      item.pop = PICKUP_TUNING.popTime;

      const slot = out[count];
      if (slot) {
        slot.kind = item.kind;
        slot.position.copy(item.position);
        slot.index = item.index;
      } else {
        out.push({ kind: item.kind, position: item.position.clone(), index: item.index });
      }
      count++;
    }

    return count;
  }

  /**
   * Set the route window without animating.
   *
   * `update` is a render-rate call — it composes an instance matrix per visible
   * item, which at 120 Hz would be three times the work for no visible gain. But
   * `collect` runs at PHYSICS rate and windows on the same route distance, so the
   * physics loop needs a way to keep that window current without paying for the
   * animation. This is it.
   */
  setRoute(playerRouteDistance: number): void {
    this.routeDistance = playerRouteDistance;
  }

  update(playerRouteDistance: number, dt: number, time: number): void {
    this.routeDistance = playerRouteDistance;
    this.time = time;

    const lo = playerRouteDistance - PICKUP_TUNING.activeRange;
    const hi = playerRouteDistance + PICKUP_TUNING.activeRange;

    for (const bucket of this.buckets) {
      let dirty = false;

      for (const item of bucket.items) {
        const inWindow = item.routeDistance >= lo && item.routeDistance <= hi;

        // A taken item plays its pop out and then stays hidden forever.
        if (item.taken) {
          if (item.pop <= 0) {
            if (item.live) {
              bucket.mesh.setMatrixAt(item.slot, _zero);
              item.live = false;
              dirty = true;
            }
            continue;
          }
          item.pop = Math.max(0, item.pop - dt);
          const u = 1 - item.pop / PICKUP_TUNING.popTime;
          const s = 1 + u * PICKUP_TUNING.popScale;
          _pos.copy(item.position).addScaledVector(_axis, u * 0.9);
          _quat.setFromAxisAngle(_axis, this.time * bucket.spin * PICKUP_TUNING.spinRate * 3);
          _scale.setScalar(s * (1 - u * 0.85));
          _m.compose(_pos, _quat, _scale);
          bucket.mesh.setMatrixAt(item.slot, _m);
          item.live = true;
          dirty = true;
          continue;
        }

        if (!inWindow) {
          if (item.live) {
            bucket.mesh.setMatrixAt(item.slot, _zero);
            item.live = false;
            dirty = true;
          }
          continue;
        }

        const bob = Math.sin(this.time * PICKUP_TUNING.bobRate + item.phase) * PICKUP_TUNING.bobAmp;
        _pos.copy(item.position).addScaledVector(_axis, bob);
        _quat.setFromAxisAngle(_axis, this.time * bucket.spin * PICKUP_TUNING.spinRate + item.phase);
        _scale.setScalar(1);
        _m.compose(_pos, _quat, _scale);
        bucket.mesh.setMatrixAt(item.slot, _m);
        item.live = true;
        dirty = true;
      }

      if (dirty) bucket.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  reset(): void {
    for (const item of this.all) {
      item.taken = false;
      item.pop = 0;
    }
    // The next `update` re-places whatever is in the window. Hiding everything
    // here keeps the one frame between reset and update from showing an item at
    // its pop scale.
    for (const bucket of this.buckets) {
      for (const item of bucket.items) {
        bucket.mesh.setMatrixAt(item.slot, _zero);
        item.live = false;
      }
      bucket.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const bucket of this.buckets) {
      disposeCelMaterial(bucket.material);
      bucket.geometry.dispose();
      bucket.mesh.dispose();
    }
    this.buckets.length = 0;
    this.all.length = 0;
    this.object.clear();
  }
}
