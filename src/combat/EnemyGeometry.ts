/**
 * EnemyGeometry — every enemy body, built in code.
 *
 * Zero external assets: these are three primitives welded together, run
 * through `finalizeGeometry()` so the inverted-hull outline has the
 * `aSmoothNormal` and `aCurvature` attributes it needs. Skipping that step is
 * the documented cause of the "exploded mesh" defect on the streambed
 * boulders — a hull built without a smooth normal explodes at every hard edge,
 * and one built without curvature inks every edge at full weight.
 *
 * ── SILHOUETTE IS THE WHOLE BRIEF ───────────────────────────────────────────
 *
 * At 74 m/s an enemy that is legible at 40 m gives half a second of warning,
 * which is not a fight, it is a collision. The requirement is 150 m, and at
 * 150 m with this camera's field of view a 1080-line frame gives roughly
 * 6.9 px per metre of subject height — so a person-sized enemy is TWELVE
 * PIXELS TALL. Nothing about its surface detail can possibly read at that
 * size; only its outline, its size class, and its colour block can.
 *
 * Hence, deliberately:
 *
 *   • every body is 2.5–8 m, not 1.8 m;
 *   • each kind has a different aspect ratio, so the size class alone names it
 *     (squat wedge, ringed sphere, tall spike, wide plate, thin dart, tower,
 *     colossus);
 *   • every kind carries a high-chroma `marker` CORE, which is the one thing
 *     that survives to twenty pixels;
 *   • every kind carries a BEACON — a spinning glyph floating above it — whose
 *     only job is to be visible before the body is, and to swell during the
 *     telegraph;
 *   • the ground RING is shared by every kind and is drawn at the exact radius
 *     of the attack that is winding up, so the danger zone is a shape on the
 *     ground rather than a number in a design document.
 *
 * The ring and the beacon are the two pieces of pure gameplay-readability
 * geometry in the subsystem. They are not decoration.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  OctahedronGeometry,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';

import { EnemyKind } from '../game/Contracts';
import { finalizeGeometry } from '../npr/OutlineGeometry';
import type { RampName } from '../npr/Palette';
import { PROFILES } from './CombatConstants';

/** Which animation slot a part belongs to. */
export type PartSlot = 'body' | 'motor' | 'core';

export interface EnemyPart {
  slot: PartSlot;
  geometry: BufferGeometry;
  ramp: RampName;
  /** Extra matcap weight — metals sit around 0.45. */
  matcap?: number;
}

const _m = new Matrix4();
const _m2 = new Matrix4();

// ─────────────────────────────────────────────────────────────────────────────
// Local geometry utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Translate/rotate/scale a primitive in place and return it, for chaining. */
function place(
  geo: BufferGeometry,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = sx, sz = sx,
): BufferGeometry {
  _m.makeScale(sx, sy, sz);
  if (rx) geo.applyMatrix4(_m2.makeRotationX(rx));
  if (ry) geo.applyMatrix4(_m2.makeRotationY(ry));
  if (rz) geo.applyMatrix4(_m2.makeRotationZ(rz));
  geo.applyMatrix4(_m);
  geo.applyMatrix4(_m2.makeTranslation(x, y, z));
  return geo;
}

/**
 * Weld a list of primitives into one buffer.
 *
 * Written locally rather than imported from another subsystem: `src/combat`
 * may only depend on `Contracts`, the NPR layer and core utils, and a shared
 * mesh utility does not exist in any of those.
 */
export function mergeGeos(parts: BufferGeometry[]): BufferGeometry {
  let vcount = 0;
  let icount = 0;
  for (const p of parts) {
    if (!p.getAttribute('normal')) p.computeVertexNormals();
    const pc = p.getAttribute('position').count;
    if (!p.getAttribute('uv')) p.setAttribute('uv', new BufferAttribute(new Float32Array(pc * 2), 2));
    vcount += pc;
    icount += p.getIndex() ? p.getIndex()!.count : pc;
  }

  const position = new Float32Array(vcount * 3);
  const normal = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const index = vcount > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);

  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pp = p.getAttribute('position') as BufferAttribute;
    const pn = p.getAttribute('normal') as BufferAttribute;
    const pu = p.getAttribute('uv') as BufferAttribute;
    position.set(pp.array as Float32Array, vo * 3);
    normal.set(pn.array as Float32Array, vo * 3);
    uv.set(pu.array as Float32Array, vo * 2);
    const pi = p.getIndex();
    if (pi) {
      for (let i = 0; i < pi.count; i++) index[io + i] = pi.getX(i) + vo;
      io += pi.count;
    } else {
      for (let i = 0; i < pp.count; i++) index[io + i] = i + vo;
      io += pp.count;
    }
    vo += pp.count;
    p.dispose();
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(position, 3));
  geo.setAttribute('normal', new BufferAttribute(normal, 3));
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  geo.setIndex(new BufferAttribute(index, 1));
  return geo;
}

/**
 * The one finalize call every geometry in this file ends with.
 *
 * `maxWeldAngle: 78` is the hard-surface setting: creases sharper than that
 * keep a genuine break in the hull, so a machine reads as a machine and not as
 * an inflated balloon, while everything softer welds and the hull stays closed.
 */
function finish(geo: BufferGeometry): BufferGeometry {
  return finalizeGeometry(geo, { tolerance: 5e-4, maxWeldAngle: 78, ao: true, aoStrength: 0.5 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared readability geometry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The warning beacon: a stacked double-pyramid that spins above every enemy.
 *
 * Built at a nominal 1 m half-height and scaled per kind, because the ONE
 * thing it has to do is subtend enough pixels at 150 m, and that is a decision
 * per enemy size class rather than a shape decision.
 */
export function buildBeaconGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  parts.push(place(new OctahedronGeometry(0.5, 0), 0, 0, 0, 0, 0, 0, 1, 1.7, 1));
  // Three fins, so it never presents as a single flat facet from any heading.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    parts.push(place(new BoxGeometry(0.42, 0.10, 0.06), Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42, 0, -a, 0));
  }
  return finish(mergeGeos(parts));
}

/**
 * The danger ring: a flat annulus of unit radius, laid in the XZ plane.
 *
 * Scaled at runtime to the exact radius of whatever is about to happen. Drawn
 * double-sided and without an outline hull — it is a diagram, not an object.
 */
export function buildRingGeometry(): BufferGeometry {
  const g = new RingGeometry(0.86, 1.0, 48, 1);
  g.rotateX(-Math.PI / 2);
  return finish(g);
}

/** A projectile: a faceted shard, long on Z so it points where it travels. */
export function buildProjectileGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  parts.push(place(new OctahedronGeometry(0.42, 0), 0, 0, 0, 0, 0, 0, 1, 1, 2.1));
  parts.push(place(new ConeGeometry(0.3, 0.75, 6), 0, 0, 0.72, Math.PI / 2, 0, 0));
  return finish(mergeGeos(parts));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind bodies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build one kind's parts. Local space has the origin at the FEET (or at the
 * hover base) and +Z forward, matching `EnemyState.position` and `facing`.
 */
export function buildEnemyParts(kind: EnemyKind): EnemyPart[] {
  switch (kind) {
    case EnemyKind.Drone: return buildDrone();
    case EnemyKind.Floater: return buildFloater();
    case EnemyKind.Lancer: return buildLancer();
    case EnemyKind.Bulwark: return buildBulwark();
    case EnemyKind.Stalker: return buildStalker();
    case EnemyKind.Emplacement: return buildEmplacement();
    case EnemyKind.Warden: return buildWarden();
  }
}

/**
 * Drone — a squat forward-leaning wedge on four splayed legs.
 *
 * The read at range is "wide and low", which is the opposite of the Lancer and
 * the Emplacement and is what lets the player tell at 150 m whether the thing
 * ahead is in their lane or above it.
 */
function buildDrone(): EnemyPart[] {
  const h = PROFILES[EnemyKind.Drone].height;
  const body: BufferGeometry[] = [];
  // Chassis: a hexagonal prism lying on its side, nose down.
  body.push(place(new CylinderGeometry(1.05, 0.72, 2.0, 6, 1), 0, h * 0.62, 0.12, Math.PI / 2, 0, 0, 1, 1, 1));
  // Shoulder cowl, so the top edge is not a plain cylinder cap.
  body.push(place(new BoxGeometry(1.5, 0.45, 1.2), 0, h * 0.86, -0.15, -0.22, 0, 0));
  const legs: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const sx = i < 2 ? -1 : 1;
    const sz = i % 2 === 0 ? -1 : 1;
    legs.push(place(new BoxGeometry(0.26, 1.35, 0.26), sx * 0.78, h * 0.30, sz * 0.62, 0, 0, sx * 0.34));
    legs.push(place(new BoxGeometry(0.5, 0.22, 0.62), sx * 0.98, 0.11, sz * 0.72));
  }
  const core: BufferGeometry[] = [];
  // The eye. One big lens, forward, at aim height.
  core.push(place(new SphereGeometry(0.46, 10, 8), 0, h * 0.66, 0.92));
  core.push(place(new TorusGeometry(0.55, 0.09, 6, 14), 0, h * 0.66, 0.86, Math.PI / 2, 0, 0, 1, 1, 1));

  return [
    { slot: 'body', geometry: finish(mergeGeos(body)), ramp: 'metal', matcap: 0.42 },
    { slot: 'motor', geometry: finish(mergeGeos(legs)), ramp: 'tyre' },
    { slot: 'core', geometry: finish(mergeGeos(core)), ramp: 'marker' },
  ];
}

/**
 * Floater — a glassy sphere inside a wide ring.
 *
 * The ring is 3.6 m across on a 2 m body specifically so a CHAIN of them reads
 * as a staircase from a long way off. This is the enemy whose entire purpose is
 * to be seen early and jumped to, so it is the one that is nearly all outline.
 */
function buildFloater(): EnemyPart[] {
  const body: BufferGeometry[] = [];
  body.push(place(new IcosahedronGeometry(0.92, 1), 0, 1.05, 0));
  const ring: BufferGeometry[] = [];
  ring.push(place(new TorusGeometry(1.75, 0.14, 6, 24), 0, 1.05, 0, Math.PI / 2, 0, 0));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    ring.push(place(new BoxGeometry(0.9, 0.12, 0.12), Math.cos(a) * 1.3, 1.05, Math.sin(a) * 1.3, 0, -a + Math.PI / 2, 0));
  }
  const core: BufferGeometry[] = [];
  core.push(place(new OctahedronGeometry(0.5, 0), 0, 1.05, 0));

  return [
    { slot: 'body', geometry: finish(mergeGeos(body)), ramp: 'lens', matcap: 0.6 },
    { slot: 'motor', geometry: finish(mergeGeos(ring)), ramp: 'metal', matcap: 0.5 },
    { slot: 'core', geometry: finish(mergeGeos(core)), ramp: 'marker' },
  ];
}

/**
 * Lancer — a tall, thin, hovering spike with a forward barrel and swept fins.
 *
 * Reads as vertical, which is what separates it from the Drone at range. The
 * barrel is long enough to show which way it is aiming from 150 m; that is the
 * only telegraph that matters for a shooter.
 */
function buildLancer(): EnemyPart[] {
  const body: BufferGeometry[] = [];
  body.push(place(new CylinderGeometry(0.34, 0.62, 2.5, 7, 1), 0, 1.5, 0));
  body.push(place(new ConeGeometry(0.62, 1.0, 7), 0, 3.0, 0, Math.PI, 0, 0));
  // Two swept fins.
  for (const sx of [-1, 1]) {
    body.push(place(new BoxGeometry(1.5, 0.72, 0.14), sx * 0.9, 1.55, -0.28, 0, 0, sx * 0.5));
  }
  const barrel: BufferGeometry[] = [];
  barrel.push(place(new CylinderGeometry(0.20, 0.26, 2.3, 8, 1), 0, 1.7, 1.0, Math.PI / 2, 0, 0));
  barrel.push(place(new TorusGeometry(0.34, 0.08, 6, 14), 0, 1.7, 1.95, 0, 0, 0));
  const core: BufferGeometry[] = [];
  core.push(place(new OctahedronGeometry(0.42, 0), 0, 1.7, 2.15));
  core.push(place(new SphereGeometry(0.34, 10, 8), 0, 2.35, -0.1));

  return [
    { slot: 'body', geometry: finish(mergeGeos(body)), ramp: 'frame', matcap: 0.4 },
    { slot: 'motor', geometry: finish(mergeGeos(barrel)), ramp: 'metal', matcap: 0.5 },
    { slot: 'core', geometry: finish(mergeGeos(core)), ramp: 'marker' },
  ];
}

/**
 * Bulwark — a 4.6 m shield plate with a small body behind it.
 *
 * The design constraint here is that "do not hit this from the front" has to be
 * legible before contact, at speed. So the shield is the whole silhouette from
 * the front and the exposed core is on the BACK, where it is visible only once
 * the player has got behind — which is exactly the instruction.
 */
function buildBulwark(): EnemyPart[] {
  const body: BufferGeometry[] = [];
  body.push(place(new BoxGeometry(1.6, 2.0, 1.3), 0, 1.35, -0.75));
  body.push(place(new CylinderGeometry(0.55, 0.75, 0.7, 6, 1), 0, 2.55, -0.75));
  for (const sx of [-1, 1]) {
    body.push(place(new BoxGeometry(0.55, 1.3, 0.55), sx * 1.0, 0.7, -0.8, 0, 0, sx * -0.12));
  }
  const shield: BufferGeometry[] = [];
  shield.push(place(new BoxGeometry(4.6, 3.1, 0.42), 0, 1.75, 0.55, 0.10, 0, 0));
  shield.push(place(new BoxGeometry(4.9, 0.42, 0.62), 0, 3.25, 0.42, 0.10, 0, 0));
  shield.push(place(new BoxGeometry(0.5, 3.2, 0.6), 0, 1.75, 0.62, 0.10, 0, 0));
  const core: BufferGeometry[] = [];
  // Rear weak point, deliberately the only warm shape on the model.
  core.push(place(new OctahedronGeometry(0.62, 0), 0, 1.65, -1.42));
  core.push(place(new TorusGeometry(0.78, 0.12, 6, 16), 0, 1.65, -1.48, 0, 0, 0));

  return [
    { slot: 'body', geometry: finish(mergeGeos(body)), ramp: 'tyre' },
    { slot: 'motor', geometry: finish(mergeGeos(shield)), ramp: 'metal', matcap: 0.5 },
    { slot: 'core', geometry: finish(mergeGeos(core)), ramp: 'marker' },
  ];
}

/**
 * Stalker — a thin swept dart with two trailing blades.
 *
 * It is the only enemy that travels at the player's own speed, so its
 * silhouette is built to read while it is BESIDE the camera rather than ahead
 * of it: long on Z, narrow on X, with blades that stick out in silhouette from
 * a side view.
 */
function buildStalker(): EnemyPart[] {
  const body: BufferGeometry[] = [];
  body.push(place(new OctahedronGeometry(0.9, 0), 0, 1.4, 0, 0, 0, 0, 1, 1, 2.4));
  body.push(place(new ConeGeometry(0.52, 1.6, 6), 0, 1.4, 1.9, Math.PI / 2, 0, 0));
  body.push(place(new BoxGeometry(0.24, 1.0, 1.0), 0, 2.15, -1.0, -0.35, 0, 0));
  const blades: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    blades.push(place(new BoxGeometry(2.0, 0.16, 0.62), sx * 1.15, 1.45, -0.55, 0, sx * 0.42, sx * 0.22));
    blades.push(place(new ConeGeometry(0.3, 1.1, 5), sx * 2.0, 1.45, -1.15, 0, 0, sx * -1.4));
  }
  const core: BufferGeometry[] = [];
  core.push(place(new SphereGeometry(0.44, 10, 8), 0, 1.4, 0.55));
  core.push(place(new TorusGeometry(0.6, 0.1, 6, 14), 0, 1.4, 0.2, Math.PI / 2, 0, 0));

  return [
    { slot: 'body', geometry: finish(mergeGeos(body)), ramp: 'frame', matcap: 0.45 },
    { slot: 'motor', geometry: finish(mergeGeos(blades)), ramp: 'metal', matcap: 0.55 },
    { slot: 'core', geometry: finish(mergeGeos(core)), ramp: 'marker' },
  ];
}

/**
 * Emplacement — a 6.4 m pylon growing out of the mountain, with a turret head.
 *
 * The tallest thing in the roster and the one that has to be read earliest,
 * because it starts shooting from 150 m. Its whole shape is a vertical line
 * with a heavy mass on top: the one silhouette that survives being drawn eight
 * pixels wide.
 */
function buildEmplacement(): EnemyPart[] {
  const body: BufferGeometry[] = [];
  body.push(place(new CylinderGeometry(1.05, 2.1, 4.2, 6, 1), 0, 2.1, 0));
  // Buttresses at the base, so it reads as built into the ground.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    body.push(place(new BoxGeometry(0.5, 2.2, 1.5), Math.cos(a) * 1.5, 1.0, Math.sin(a) * 1.5, 0.34, -a, 0));
  }
  body.push(place(new CylinderGeometry(1.5, 1.1, 0.5, 8, 1), 0, 4.4, 0));
  const head: BufferGeometry[] = [];
  head.push(place(new CylinderGeometry(1.25, 1.45, 1.5, 8, 1), 0, 5.35, 0));
  head.push(place(new BoxGeometry(2.9, 0.5, 0.9), 0, 5.9, 0));
  for (const sx of [-1, 1]) {
    head.push(place(new CylinderGeometry(0.22, 0.28, 2.2, 7, 1), sx * 0.55, 5.35, 0.9, Math.PI / 2, 0, 0));
  }
  head.push(place(new CylinderGeometry(0.26, 0.32, 2.6, 7, 1), 0, 5.75, 1.0, Math.PI / 2, 0, 0));
  const core: BufferGeometry[] = [];
  core.push(place(new OctahedronGeometry(0.7, 0), 0, 5.35, 0));
  core.push(place(new TorusGeometry(1.05, 0.16, 6, 18), 0, 5.35, 0));
  core.push(place(new SphereGeometry(0.3, 8, 6), 0, 5.35, 2.05));

  return [
    { slot: 'body', geometry: finish(mergeGeos(body)), ramp: 'metal', matcap: 0.38 },
    { slot: 'motor', geometry: finish(mergeGeos(head)), ramp: 'frame', matcap: 0.45 },
    { slot: 'core', geometry: finish(mergeGeos(core)), ramp: 'marker' },
  ];
}

/**
 * Warden — the miniboss. 7.2 m, broad-shouldered, two slab arms.
 *
 * It exists to stop the run dead, so it is built to be unmistakable from the
 * top of the section: twice the height of anything else and three times the
 * width. The chest core is the punish target and is exposed only in recovery,
 * which the visual layer sells by opening the shoulder plates.
 */
function buildWarden(): EnemyPart[] {
  const body: BufferGeometry[] = [];
  body.push(place(new BoxGeometry(3.0, 3.4, 2.2), 0, 3.7, 0));
  body.push(place(new CylinderGeometry(1.5, 2.0, 1.9, 6, 1), 0, 1.35, 0));
  for (const sx of [-1, 1]) {
    body.push(place(new BoxGeometry(1.2, 2.6, 1.2), sx * 1.0, 0.9, 0, 0, 0, sx * 0.08));
    body.push(place(new BoxGeometry(1.6, 0.6, 1.8), sx * 1.05, 0.2, 0.15));
  }
  body.push(place(new BoxGeometry(1.7, 1.2, 1.6), 0, 6.0, 0.1));
  const arms: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    arms.push(place(new BoxGeometry(1.5, 1.6, 1.7), sx * 2.3, 5.1, 0, 0, 0, sx * -0.2));
    arms.push(place(new BoxGeometry(1.1, 3.0, 1.2), sx * 2.75, 3.5, 0.1, 0, 0, sx * -0.1));
    arms.push(place(new BoxGeometry(1.7, 1.3, 1.9), sx * 3.0, 2.0, 0.2));
  }
  const core: BufferGeometry[] = [];
  core.push(place(new OctahedronGeometry(0.95, 0), 0, 3.9, 1.05));
  core.push(place(new TorusGeometry(1.3, 0.18, 6, 20), 0, 3.9, 0.95));
  core.push(place(new SphereGeometry(0.36, 8, 6), -0.42, 6.1, 0.9));
  core.push(place(new SphereGeometry(0.36, 8, 6), 0.42, 6.1, 0.9));

  return [
    { slot: 'body', geometry: finish(mergeGeos(body)), ramp: 'helmet' },
    { slot: 'motor', geometry: finish(mergeGeos(arms)), ramp: 'metal', matcap: 0.45 },
    { slot: 'core', geometry: finish(mergeGeos(core)), ramp: 'marker' },
  ];
}
