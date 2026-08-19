/**
 * WallSet — the runnable walls.
 *
 * A wall is a chain of vertical plates standing beside the trail, each plate a
 * genuine plane with a base, a top and two ends. That is deliberate: the run
 * needs a surface whose normal is horizontal (`WALL.maxNormalY` is 0.40, so the
 * physics rejects anything more sloped than 66 degrees), and an eroded
 * heightfield face is 50-70 degrees. Registering the terrain itself as the wall
 * puts the vertical contact plane INSIDE the ground, and then the terrain
 * resolve and `WALL.stick` push the character in opposite directions for the
 * whole run. The plate stands proud of the face instead, and the terrain scan
 * in `Layout` decides where a plate is believable.
 *
 * `runLength` is real: it is the metres of plate left ahead of the contact
 * point, walking the chain, in the direction the character is actually
 * travelling. The physics does not currently read it, but a wall that cannot
 * say how long it is cannot be used to decide when to jump.
 *
 * THE PROBE IS SWEPT. A 1.1 m thick plate at 74 m/s is crossed in under two
 * physics steps; testing the character's point position against it misses the
 * wall in most of the steps that should have hit, which is exactly the
 * tunnelling failure `HULL.maxSubstep` exists to prevent.
 */

import { Group, Matrix4, Object3D, Vector3 } from 'three';

import type { IWallSet, WallHit } from '../game/Contracts';
import { WALL } from '../player/SparkConstants';
import { LAYOUT_CONSTANTS } from './Layout';
import type { WallSpec } from './Layout';
import { MeshBuilder, chevronGeometry, slabGeometry } from './Meshes';

const { WALL_THICKNESS, WALL_CONTACT } = LAYOUT_CONSTANTS;

const WALL_TUNING = {
  /** Metres above the plate's base the runnable band starts. */
  bandBottom: 0.6,
  /** Metres below the plate's top the runnable band ends. */
  bandTop: 0.3,
  /** Route metres either side of the player a plate is considered. */
  activeRange: 300,
  /** Route metres either side of the player a plate chunk is drawn. */
  drawRange: 620,
  /** Height of the grip stripe up the face, metres. */
  stripeHeight: 2.6,
  /** Metres between chevrons on the face. */
  chevronSpacing: 9,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Scratch
// ─────────────────────────────────────────────────────────────────────────────

const _hit: WallHit = {
  id: -1,
  normal: new Vector3(),
  point: new Vector3(),
  along: new Vector3(),
  runLength: 0,
};
const _m = new Matrix4();
const _ax = new Vector3();
const _ay = new Vector3();
const _az = new Vector3();
const _p = new Vector3();

// ─────────────────────────────────────────────────────────────────────────────
// Panel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One plate. Everything is flat typed arrays: the probe walks it 240 times a
 * second (the physics probe and the HUD prompt look-ahead) and must not touch
 * the heap.
 */
interface Panel {
  id: number;
  /** Face nodes, xyz flat. y is the base of the plate. */
  face: Float32Array;
  /** Per-segment unit horizontal normal, xz flat. */
  seg: Float32Array;
  /** Per-segment unit direction, xz flat. */
  dir: Float32Array;
  /** Per-segment length. */
  len: Float32Array;
  /** Cumulative length at each node. */
  cum: Float32Array;
  count: number;
  baseY: number;
  topY: number;
  routeDistance: number;
  minX: number; minZ: number; maxX: number; maxZ: number;
}

export class WallSet implements IWallSet {
  readonly object: Object3D = new Group();
  private panels: Panel[] = [];
  private meshes: MeshBuilder;
  private routeDistance = 0;

  constructor(specs: WallSpec[]) {
    this.object.name = 'traversal-walls';
    this.meshes = new MeshBuilder(this.object);

    for (let i = 0; i < specs.length; i++) {
      const panel = this.buildPanel(specs[i], i);
      if (panel) {
        this.panels.push(panel);
        this.buildGeometry(specs[i], panel);
      }
    }
    this.meshes.build();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  private buildPanel(spec: WallSpec, id: number): Panel | null {
    const n = spec.nodes.length;
    if (n < 2) return null;

    const face = new Float32Array(n * 3);
    const seg = new Float32Array((n - 1) * 2);
    const dir = new Float32Array((n - 1) * 2);
    const len = new Float32Array(n - 1);
    const cum = new Float32Array(n);

    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const half = WALL_THICKNESS * 0.5;

    for (let i = 0; i < n; i++) {
      const q = spec.nodes[i];
      const nrm = spec.normals[Math.min(i, spec.normals.length - 1)];
      // The runnable surface is the FACE of the plate, not its centreline.
      const x = q.x + nrm.x * half;
      const z = q.z + nrm.z * half;
      face[i * 3] = x;
      face[i * 3 + 1] = q.y;
      face[i * 3 + 2] = z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    for (let i = 0; i < n - 1; i++) {
      const dx = face[(i + 1) * 3] - face[i * 3];
      const dz = face[(i + 1) * 3 + 2] - face[i * 3 + 2];
      const l = Math.hypot(dx, dz);
      len[i] = l;
      cum[i + 1] = cum[i] + l;
      const ux = l > 1e-6 ? dx / l : 0;
      const uz = l > 1e-6 ? dz / l : 1;
      dir[i * 2] = ux;
      dir[i * 2 + 1] = uz;
      // Perpendicular, sign-matched to the authored outward normal so the
      // runnable side is the side that faces the trail.
      let nx = -uz;
      let nz = ux;
      const ref = spec.normals[Math.min(i, spec.normals.length - 1)];
      if (nx * ref.x + nz * ref.z < 0) { nx = -nx; nz = -nz; }
      seg[i * 2] = nx;
      seg[i * 2 + 1] = nz;
    }

    const baseY = face[1];
    return {
      id,
      face, seg, dir, len, cum,
      count: n,
      baseY,
      topY: baseY + spec.height,
      routeDistance: spec.routeDistance,
      minX: minX - 4, minZ: minZ - 4, maxX: maxX + 4, maxZ: maxZ + 4,
    };
  }

  private buildGeometry(spec: WallSpec, panel: Panel): void {
    const d = spec.routeDistance;
    const h = panel.topY - panel.baseY;

    for (let i = 0; i < panel.count - 1; i++) {
      const l = panel.len[i];
      if (l < 0.2) continue;
      const cx = (panel.face[i * 3] + panel.face[(i + 1) * 3]) * 0.5;
      const cz = (panel.face[i * 3 + 2] + panel.face[(i + 1) * 3 + 2]) * 0.5;
      const ux = panel.dir[i * 2];
      const uz = panel.dir[i * 2 + 1];
      const nx = panel.seg[i * 2];
      const nz = panel.seg[i * 2 + 1];

      // Slight overlap so a curved chain has no wedge of daylight at a joint.
      const geo = slabGeometry(l + 0.4, h, WALL_THICKNESS);
      _ax.set(ux, 0, uz);
      _ay.set(0, 1, 0);
      _az.set(nx, 0, nz);
      _m.makeBasis(_ax, _ay, _az);
      _m.setPosition(cx - nx * WALL_THICKNESS * 0.5, panel.baseY + h * 0.5, cz - nz * WALL_THICKNESS * 0.5);
      geo.applyMatrix4(_m);
      this.meshes.add(geo, 'rock', 'wall-plate', d, { hatchStrength: undefined, outlineWidth: 0.011 });
    }

    // Grip stripe: a shallow ledge proud of the face at run height. This is the
    // read at distance — the plate alone is just a cliff.
    for (let i = 0; i < panel.count - 1; i++) {
      const l = panel.len[i];
      if (l < 0.2) continue;
      const cx = (panel.face[i * 3] + panel.face[(i + 1) * 3]) * 0.5;
      const cz = (panel.face[i * 3 + 2] + panel.face[(i + 1) * 3 + 2]) * 0.5;
      const ux = panel.dir[i * 2];
      const uz = panel.dir[i * 2 + 1];
      const nx = panel.seg[i * 2];
      const nz = panel.seg[i * 2 + 1];
      const geo = slabGeometry(l + 0.3, 0.34, 0.16);
      _ax.set(ux, 0, uz);
      _ay.set(0, 1, 0);
      _az.set(nx, 0, nz);
      _m.makeBasis(_ax, _ay, _az);
      _m.setPosition(cx + nx * 0.09, panel.baseY + WALL_TUNING.stripeHeight, cz + nz * 0.09);
      geo.applyMatrix4(_m);
      this.meshes.add(geo, 'marker', 'wall-mark', d, { outlineWidth: 0.010 });
    }

    // Chevrons pointing down the wall, so the direction of the run is legible
    // before the character is on it.
    const total = panel.cum[panel.count - 1];
    for (let s = WALL_TUNING.chevronSpacing * 0.5; s < total; s += WALL_TUNING.chevronSpacing) {
      const i = this.segmentAt(panel, s);
      const u = s - panel.cum[i];
      const ux = panel.dir[i * 2];
      const uz = panel.dir[i * 2 + 1];
      const nx = panel.seg[i * 2];
      const nz = panel.seg[i * 2 + 1];
      const px = panel.face[i * 3] + ux * u + nx * 0.1;
      const pz = panel.face[i * 3 + 2] + uz * u + nz * 0.1;
      const geo = chevronGeometry(1.0, 1.4, 0.08);
      _az.set(ux, 0, uz);
      _ay.set(nx, 0, nz);
      _ax.crossVectors(_ay, _az).normalize();
      _m.makeBasis(_ax, _ay, _az);
      _m.setPosition(px, panel.baseY + WALL_TUNING.stripeHeight + 1.5, pz);
      geo.applyMatrix4(_m);
      this.meshes.add(geo, 'marker', 'wall-mark', d, { outlineWidth: 0.010 });
    }
  }

  private segmentAt(panel: Panel, s: number): number {
    for (let i = 0; i < panel.count - 1; i++) {
      if (s <= panel.cum[i + 1]) return i;
    }
    return panel.count - 2;
  }

  // ── IWallSet ───────────────────────────────────────────────────────────────

  /**
   * Swept probe. Returns a module-scoped hit; consume it before probing again.
   */
  probe(from: Vector3, to: Vector3, velocity: Vector3, excludeId: number): WallHit | null {
    const vx = velocity.x;
    const vz = velocity.z;
    const vh = Math.hypot(vx, vz);
    if (vh < 1e-3) return null;

    const lo = this.routeDistance - WALL_TUNING.activeRange;
    const hi = this.routeDistance + WALL_TUNING.activeRange;

    const qMinX = Math.min(from.x, to.x) - WALL_CONTACT;
    const qMaxX = Math.max(from.x, to.x) + WALL_CONTACT;
    const qMinZ = Math.min(from.z, to.z) - WALL_CONTACT;
    const qMaxZ = Math.max(from.z, to.z) + WALL_CONTACT;

    let bestT = Infinity;
    let bestPanel: Panel | null = null;
    let bestSeg = 0;
    let bestU = 0;
    let bestSign = 1;
    let bestY = 0;

    for (let pi = 0; pi < this.panels.length; pi++) {
      const panel = this.panels[pi];
      if (panel.id === excludeId) continue;
      if (panel.routeDistance + panel.cum[panel.count - 1] < lo || panel.routeDistance > hi) continue;
      if (qMaxX < panel.minX || qMinX > panel.maxX || qMaxZ < panel.minZ || qMinZ > panel.maxZ) continue;
      // Vertical band: the whole plate shares one base and one top.
      if (Math.max(from.y, to.y) < panel.baseY + WALL_TUNING.bandBottom) continue;
      if (Math.min(from.y, to.y) > panel.topY - WALL_TUNING.bandTop) continue;

      for (let i = 0; i < panel.count - 1; i++) {
        const l = panel.len[i];
        if (l < 0.2) continue;
        const ax = panel.face[i * 3];
        const az = panel.face[i * 3 + 2];
        const nx = panel.seg[i * 2];
        const nz = panel.seg[i * 2 + 1];

        const dFrom = (from.x - ax) * nx + (from.z - az) * nz;
        const dTo = (to.x - ax) * nx + (to.z - az) * nz;

        // Behind the face for the whole step — the character is inside the
        // hill, not approaching the plate.
        if (dFrom < -0.75 && dTo < -0.75) continue;
        if (dFrom > WALL_CONTACT && dTo > WALL_CONTACT) continue;

        let t: number;
        if (dFrom <= WALL_CONTACT) {
          t = 0;
        } else {
          const denom = dFrom - dTo;
          if (denom <= 1e-6) continue;
          t = (dFrom - WALL_CONTACT) / denom;
          if (t < 0 || t > 1) continue;
        }
        if (t >= bestT) continue;

        // Must be closing on the face, or already against it.
        if (vx * nx + vz * nz > 0.25 && dFrom > WALL_CONTACT * 0.5) continue;

        const cx = from.x + (to.x - from.x) * t;
        const cy = from.y + (to.y - from.y) * t;
        const cz = from.z + (to.z - from.z) * t;

        if (cy < panel.baseY + WALL_TUNING.bandBottom) continue;
        if (cy > panel.topY - WALL_TUNING.bandTop) continue;

        const ux = panel.dir[i * 2];
        const uz = panel.dir[i * 2 + 1];
        const u = (cx - ax) * ux + (cz - az) * uz;
        if (u < -0.3 || u > l + 0.3) continue;

        const alongSpeed = vx * ux + vz * uz;
        if (Math.abs(alongSpeed) < WALL.mountSpeed * 0.25) continue;

        bestT = t;
        bestPanel = panel;
        bestSeg = i;
        bestU = u < 0 ? 0 : u > l ? l : u;
        bestSign = alongSpeed >= 0 ? 1 : -1;
        bestY = cy;
      }
    }

    if (!bestPanel) return null;

    const panel = bestPanel;
    const i = bestSeg;
    const ux = panel.dir[i * 2];
    const uz = panel.dir[i * 2 + 1];
    const nx = panel.seg[i * 2];
    const nz = panel.seg[i * 2 + 1];
    const s = panel.cum[i] + bestU;
    const total = panel.cum[panel.count - 1];

    _hit.id = panel.id;
    _hit.normal.set(nx, 0, nz);
    _hit.along.set(ux * bestSign, 0, uz * bestSign);
    _hit.point.set(
      panel.face[i * 3] + ux * bestU,
      bestY,
      panel.face[i * 3 + 2] + uz * bestU,
    );
    _hit.runLength = bestSign > 0 ? total - s : s;
    return _hit;
  }

  update(playerRouteDistance: number, _dt: number): void {
    this.routeDistance = playerRouteDistance;
    this.meshes.setWindow(playerRouteDistance, WALL_TUNING.drawRange);
  }

  /** Metres of plate in the chain that owns `id`. Debug and stage use. */
  lengthOf(id: number): number {
    const p = this.panels[id];
    return p ? p.cum[p.count - 1] : 0;
  }

  /** A plate's base point, for FX and the stage director. */
  anchorOf(id: number, out: Vector3): Vector3 {
    const p = this.panels[id];
    if (!p) return out.set(0, 0, 0);
    return out.set(p.face[0], p.baseY, p.face[2]);
  }

  dispose(): void {
    this.meshes.dispose();
    this.panels.length = 0;
    _p.set(0, 0, 0);
  }
}
