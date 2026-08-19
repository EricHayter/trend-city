/**
 * EnemyVisuals — the scene-graph half of the enemy director.
 *
 * Owns every material, every mesh and every animation the enemies have. The
 * director owns the simulation and never touches three beyond handing this
 * module numbers.
 *
 * ── RULES THIS FILE IS BOUND BY ─────────────────────────────────────────────
 *
 *  • No `MeshStandardMaterial`, ever. Every surface is a `CelMaterial` built
 *    from a `RampPreset` in `Palette.ts`.
 *  • No literal colour. Every colour used here is read out of `RAMPS`.
 *  • Every outlined geometry has already been through `finalizeGeometry()` in
 *    `EnemyGeometry.ts`, which is what makes `attachOutline`'s inverted hull
 *    close instead of tearing at each hard edge.
 *
 * ── MATERIALS ARE SHARED, TRANSFORMS ARE NOT ────────────────────────────────
 *
 * A telegraph cannot be sold by tinting a material, because the material is
 * shared by every enemy of that kind and tinting one tints all sixty. So every
 * piece of per-enemy expression in here is a TRANSFORM — a scale, a spin, a
 * lift, a squash — which is per-object and free. That constraint turned out to
 * be a gift: a shape that grows is more legible at 150 m than a colour that
 * changes, and it survives the fog bands, which a hue shift does not.
 *
 * ── DISTANCE IDENTITY ───────────────────────────────────────────────────────
 *
 * Every enemy material opts into `CelOptions.identity` with its own real world
 * height. That is the pipeline's chroma-and-rim floor for subjects that have
 * become small in frame, and an enemy at the 150 m read distance is precisely
 * that case — twelve pixels tall, at which point the ramp bands average toward
 * the fog and the thing stops having a colour at all. The identity floor is
 * what keeps a Drone red-cored and a Floater teal at the distance the player
 * has to identify them from.
 */

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  Object3D,
  ShaderMaterial,
} from 'three';

import { EnemyKind, EnemyPhase } from '../game/Contracts';
import type { CelOptions } from '../npr/CelMaterial';
import {
  CelMaterial,
  createHullMaterial,
  disposeCelMaterial,
  registerNprMesh,
} from '../npr/CelMaterial';
import { RAMPS } from '../npr/Palette';
import type { RampName } from '../npr/Palette';
import { clamp01, lerp } from '../core/MathX';
import {
  buildBeaconGeometry,
  buildEnemyParts,
  buildProjectileGeometry,
  buildRingGeometry,
} from './EnemyGeometry';
import { PROFILES } from './CombatConstants';

/** Per-enemy scene node. Everything the director animates hangs off this. */
export interface EnemyVisual {
  readonly root: Group;
  /** Squash / lean pivot. Holds the body meshes. */
  readonly body: Object3D;
  /** The moving part — legs, ring, barrel, shield, blades, turret head, arms. */
  readonly motor: Object3D;
  /** The weak point. Pulses on telegraph, flares on a hit. */
  readonly core: Object3D;
  /** The warning glyph above the enemy. Always on, swells on telegraph. */
  readonly beacon: Object3D;
  /** Ground danger ring, unit radius, scaled to the live threat. */
  readonly ring: Object3D;
  kind: EnemyKind;
  /** Per-enemy animation phase so a row of drones is not one stamp. */
  phase: number;
  /** Smoothed telegraph 0..1, so the swell is not a step. */
  swell: number;
  /** Smoothed hit flinch 0..1. */
  flinch: number;
}

/** Parameters the director hands the animator each frame. Reused, never new. */
export interface VisualParams {
  alpha: number;
  time: number;
  dt: number;
  /** 0..1 through the current telegraph. 0 when not telegraphing. */
  telegraph: number;
  /** World radius the danger ring should be drawn at. <= 0 hides it. */
  ringRadius: number;
  /** World Y the ring sits at. */
  ringY: number;
  /** Radians the aiming part should pitch (Lancer barrel, Emplacement head). */
  aimPitch: number;
  /** Radians of yaw offset for the aiming part, relative to the body. */
  aimYaw: number;
  /** 0..1 of the death animation. */
  dying: number;
  /** 0..1 health remaining. */
  health: number;
}

const _c = new Color();

/**
 * The material library. One `CelMaterial` and one hull material per
 * (ramp, matcap, kind) triple — shared by every enemy of that kind, so sixty
 * drones cost three materials and three programs rather than a hundred and
 * eighty.
 */
export class CombatMaterials {
  private cel = new Map<string, CelMaterial>();
  private hull = new Map<string, ShaderMaterial>();

  get(ramp: RampName, matcap: number, height: number, key: string): CelMaterial {
    const id = `${ramp}|${matcap}|${key}`;
    let m = this.cel.get(id);
    if (!m) {
      m = new CelMaterial(RAMPS[ramp], this.optionsFor(ramp, matcap, height, id));
      this.cel.set(id, m);
    }
    return m;
  }

  getHull(ramp: RampName, matcap: number, height: number, key: string): ShaderMaterial | null {
    if (RAMPS[ramp].outlineWidth <= 0) return null;
    const id = `${ramp}|${matcap}|${key}`;
    let m = this.hull.get(id);
    if (!m) {
      m = createHullMaterial(RAMPS[ramp], this.optionsFor(ramp, matcap, height, id));
      this.hull.set(id, m);
    }
    return m;
  }

  /**
   * The identity colour is taken from the ramp's own second-brightest band —
   * its lit body colour. Reading it out of the preset rather than declaring one
   * is what keeps this subsystem free of literal colour.
   */
  private optionsFor(ramp: RampName, matcap: number, height: number, name: string): CelOptions {
    const preset = RAMPS[ramp];
    const idx = Math.max(0, preset.colors.length - 2);
    return {
      vertexAo: true,
      matcapMix: matcap > 0 ? matcap : undefined,
      identity: { color: _c.copy(preset.colors[idx]).clone(), height },
      idName: `enemy-${ramp}`,
      name: `combat:${name}`,
    };
  }

  dispose(): void {
    for (const m of this.cel.values()) disposeCelMaterial(m);
    for (const m of this.hull.values()) m.dispose();
    this.cel.clear();
    this.hull.clear();
  }
}

/**
 * Builds and owns every enemy node. One instance per director.
 *
 * Geometry is built ONCE per kind and shared by every instance of that kind —
 * a mesh is a geometry reference plus a transform, so a hundred drones are a
 * hundred draw calls but only three buffers.
 */
export class EnemyVisualFactory {
  readonly materials = new CombatMaterials();
  private geometries: BufferGeometry[] = [];
  private kindParts = new Map<EnemyKind, { slot: string; geo: BufferGeometry; ramp: RampName; matcap: number }[]>();
  private beaconGeo: BufferGeometry | null = null;
  private ringGeo: BufferGeometry | null = null;
  private projGeo: BufferGeometry | null = null;

  /** Build (or fetch) the shared parts for a kind. */
  private partsFor(kind: EnemyKind): { slot: string; geo: BufferGeometry; ramp: RampName; matcap: number }[] {
    let p = this.kindParts.get(kind);
    if (!p) {
      p = buildEnemyParts(kind).map((part) => {
        this.geometries.push(part.geometry);
        return { slot: part.slot, geo: part.geometry, ramp: part.ramp, matcap: part.matcap ?? 0 };
      });
      this.kindParts.set(kind, p);
    }
    return p;
  }

  private get beacon(): BufferGeometry {
    if (!this.beaconGeo) {
      this.beaconGeo = buildBeaconGeometry();
      this.geometries.push(this.beaconGeo);
    }
    return this.beaconGeo;
  }

  private get ringGeometry(): BufferGeometry {
    if (!this.ringGeo) {
      this.ringGeo = buildRingGeometry();
      this.geometries.push(this.ringGeo);
    }
    return this.ringGeo;
  }

  get projectileGeometry(): BufferGeometry {
    if (!this.projGeo) {
      this.projGeo = buildProjectileGeometry();
      this.geometries.push(this.projGeo);
    }
    return this.projGeo;
  }

  /**
   * Add one mesh plus its inverted-hull sibling.
   *
   * The hull shares the geometry buffer — no duplication — and is drawn one
   * render order EARLIER so the depth buffer resolves the stroke behind the
   * surface. `isHull` keeps it out of the G-buffer and out of the shadow map,
   * which `RenderLists` enforces; a hull in the shadow map draws a dark fringe
   * around every contact shadow.
   */
  private addMesh(
    parent: Object3D, geo: BufferGeometry, ramp: RampName, matcap: number,
    height: number, key: string, name: string, opts: { shadow?: boolean } = {},
  ): void {
    const mat = this.materials.get(ramp, matcap, height, key);
    const mesh = new Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = opts.shadow !== false;
    mesh.receiveShadow = opts.shadow !== false;
    registerNprMesh(mesh, mat);
    if (opts.shadow === false) mesh.userData.skipShadow = true;
    parent.add(mesh);

    const hullMat = this.materials.getHull(ramp, matcap, height, key);
    if (hullMat) {
      const hull = new Mesh(geo, hullMat);
      hull.name = `${name}:hull`;
      hull.renderOrder = -1;
      hull.castShadow = false;
      hull.receiveShadow = false;
      hull.userData.isHull = true;
      parent.add(hull);
    }
  }

  /** Build one enemy's node tree. Called once per pooled enemy, never in step. */
  create(kind: EnemyKind): EnemyVisual {
    const prof = PROFILES[kind];
    const root = new Group();
    root.name = `enemy:${kind}`;
    const body = new Group();
    const motor = new Group();
    const core = new Group();
    const beaconPivot = new Group();
    const ringPivot = new Group();
    root.add(body, motor, core, beaconPivot, ringPivot);

    const key = kind as string;
    for (const part of this.partsFor(kind)) {
      const target = part.slot === 'motor' ? motor : part.slot === 'core' ? core : body;
      this.addMesh(target, part.geo, part.ramp, part.matcap, prof.height, key, `${kind}:${part.slot}`);
    }

    // The beacon floats a body-height above the enemy and is scaled by the
    // enemy's size class, because its job is a pixel count at 150 m.
    const beaconScale = 0.55 + prof.height * 0.16;
    beaconPivot.position.set(0, prof.height + 1.1, 0);
    beaconPivot.scale.setScalar(beaconScale);
    this.addMesh(beaconPivot, this.beacon, 'marker', 0, prof.height, `${key}:beacon`, `${kind}:beacon`, { shadow: false });

    // The danger ring is a diagram: double-sided, unlit by shadows, no hull.
    const ringMat = this.materials.get('marker', 0, prof.height, `${key}:ring`);
    ringMat.side = DoubleSide;
    const ringMesh = new Mesh(this.ringGeometry, ringMat);
    ringMesh.name = `${kind}:ring`;
    ringMesh.castShadow = false;
    ringMesh.receiveShadow = false;
    ringMesh.userData.skipShadow = true;
    registerNprMesh(ringMesh, ringMat);
    ringPivot.add(ringMesh);
    ringPivot.visible = false;

    root.visible = false;
    return {
      root, body, motor, core,
      beacon: beaconPivot,
      ring: ringPivot,
      kind,
      phase: 0,
      swell: 0,
      flinch: 0,
    };
  }

  /** A pooled projectile node. */
  createProjectile(): Object3D {
    const g = new Group();
    const geo = this.projectileGeometry;
    this.addMesh(g, geo, 'marker', 0, 1.2, 'projectile', 'projectile', { shadow: false });
    g.visible = false;
    return g;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.kindParts.clear();
    this.beaconGeo = null;
    this.ringGeo = null;
    this.projGeo = null;
    this.materials.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Animate one enemy for one rendered frame.
 *
 * `phase` and `phaseTime` come straight from the simulation; nothing here
 * feeds back into it. This runs on a FRAME dt, which is legal — it is the
 * visual half. Nothing in the physics path ever reads a frame dt.
 */
export function animateEnemy(
  v: EnemyVisual,
  phase: EnemyPhase,
  phaseTime: number,
  hitStop: number,
  guarding: boolean,
  p: VisualParams,
): void {
  const prof = PROFILES[v.kind];
  const t = p.time + v.phase;

  // Smoothed telegraph swell. A step function reads as a pop at 60 fps; the
  // rise is fast (danger appearing) and the fall is slow (danger passing).
  const targetSwell = p.telegraph;
  const rate = targetSwell > v.swell ? 14 : 5;
  v.swell += (targetSwell - v.swell) * clamp01(p.dt * rate);
  v.flinch += (0 - v.flinch) * clamp01(p.dt * 9);
  if (hitStop > 0) v.flinch = 1;

  const swell = v.swell;
  const dying = p.dying;

  // ── Body: bob, squash, death collapse ────────────────────────────────────
  const bob = prof.grounded ? Math.sin(t * 5.2) * 0.05 : Math.sin(t * 1.9) * 0.28;
  const squash = 1 - v.flinch * 0.16 - swell * 0.10;
  const stretch = 1 + v.flinch * 0.20 + swell * 0.14;
  v.body.position.y = bob - swell * 0.25;
  v.body.scale.set(stretch, squash, stretch);
  v.core.position.y = bob;

  // ── Core: pulses with the telegraph, flares on a hit ─────────────────────
  const pulse = 1 + Math.sin(t * (6 + swell * 26)) * (0.06 + swell * 0.22) + v.flinch * 0.5;
  v.core.scale.setScalar(pulse * (guarding ? 0.55 : 1));
  v.core.rotation.y = t * 1.3;

  // ── Beacon: always spinning, swells with the telegraph ───────────────────
  v.beacon.rotation.y = t * 2.1;
  const beaconBase = 0.55 + prof.height * 0.16;
  v.beacon.scale.setScalar(beaconBase * (1 + swell * 0.9 + Math.sin(t * 3.1) * 0.06));
  v.beacon.position.y = prof.height + 1.1 + Math.sin(t * 1.7) * 0.22 + swell * 0.5;

  // ── Motor: the part that names the kind ──────────────────────────────────
  switch (v.kind) {
    case EnemyKind.Drone: {
      // A gait: the legs group rocks, and rocks faster in pursuit.
      const gait = phase === EnemyPhase.Pursue ? 9 : 3;
      v.motor.rotation.x = Math.sin(t * gait) * 0.18 - swell * 0.3;
      v.motor.position.y = Math.abs(Math.sin(t * gait)) * 0.07;
      break;
    }
    case EnemyKind.Floater: {
      v.motor.rotation.y = t * 0.9;
      v.motor.rotation.z = Math.sin(t * 0.7) * 0.35;
      v.motor.position.y = bob;
      break;
    }
    case EnemyKind.Lancer: {
      v.motor.rotation.x = p.aimPitch;
      v.motor.rotation.y = p.aimYaw;
      v.motor.position.z = -swell * 0.55;
      v.motor.position.y = bob;
      break;
    }
    case EnemyKind.Bulwark: {
      // The shield drops when the guard is broken — the single clearest
      // "now" signal in the roster, and it is pure transform.
      const drop = guarding ? 0 : 1;
      v.motor.rotation.x = lerp(0, 0.95, drop) + swell * -0.25;
      v.motor.position.y = lerp(0, -0.55, drop);
      break;
    }
    case EnemyKind.Stalker: {
      // Blades flare open through the windup and stay open in the dash.
      const open = phase === EnemyPhase.Attack ? 1 : swell;
      v.motor.rotation.y = open * 0.5;
      v.motor.scale.set(1 + open * 0.22, 1, 1 + open * 0.35);
      v.motor.rotation.z = Math.sin(t * 11) * 0.06 * open;
      break;
    }
    case EnemyKind.Emplacement: {
      v.motor.rotation.y = p.aimYaw;
      v.motor.rotation.x = p.aimPitch;
      // The head lifts and the barrels spin as the shot charges.
      v.motor.position.y = swell * 0.3;
      v.motor.rotation.z = swell * t * 5.0;
      break;
    }
    case EnemyKind.Warden: {
      // Arms raise through the telegraph and hammer down on the attack.
      let arm = -swell * 1.15;
      if (phase === EnemyPhase.Attack) arm = lerp(-1.15, 0.55, clamp01(phaseTime / 0.18));
      else if (phase === EnemyPhase.Recover) arm = lerp(0.55, 0, clamp01(phaseTime / prof.recover));
      v.motor.rotation.x = arm;
      v.motor.position.y = -arm * 0.35;
      break;
    }
  }

  // ── The danger ring ──────────────────────────────────────────────────────
  if (p.ringRadius > 0) {
    v.ring.visible = true;
    v.ring.scale.setScalar(p.ringRadius);
    v.ring.position.y = p.ringY;
    v.ring.rotation.y = t * 0.6;
  } else {
    v.ring.visible = false;
  }

  // ── Death ────────────────────────────────────────────────────────────────
  if (dying > 0) {
    const k = 1 - dying;
    v.root.scale.setScalar(k * k);
    v.body.rotation.y = dying * 14;
    v.core.scale.setScalar(pulse * (1 + dying * 2.2));
  } else if (v.root.scale.x !== 1) {
    v.root.scale.setScalar(1);
    v.body.rotation.y = 0;
  }
}

/** Put a visual back to its rest pose. Called on spawn and on reset. */
export function resetVisual(v: EnemyVisual): void {
  v.swell = 0;
  v.flinch = 0;
  v.root.scale.setScalar(1);
  v.body.rotation.set(0, 0, 0);
  v.body.scale.setScalar(1);
  v.body.position.set(0, 0, 0);
  v.motor.rotation.set(0, 0, 0);
  v.motor.position.set(0, 0, 0);
  v.motor.scale.setScalar(1);
  v.core.scale.setScalar(1);
  v.ring.visible = false;
}
