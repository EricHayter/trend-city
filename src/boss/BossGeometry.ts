/**
 * BossGeometry — every piece of the boss and its arena, generated in code.
 *
 * Zero external assets: there is no mesh file, no texture file and no rig file
 * anywhere in this subsystem. Everything below is built from one primitive.
 *
 * ── THE ONE PRIMITIVE ───────────────────────────────────────────────────────
 *
 * `ringedHull` — a closed surface swept from a 2D cross-section along a stack
 * of rings, where each ring carries its own scale and, optionally, its own
 * per-section radial multiplier.
 *
 * That single generator covers everything this fight needs: chamfered slabs
 * (rectangular section, four rings), faceted drums and columns (polygonal
 * section), cones and spikes (top scale 0), domes (several rings on a circle),
 * and irregular rock (a polygonal section with per-ring radial jitter). Having
 * one generator rather than eight matters for a specific reason given below.
 *
 * ── WHY THE JITTER LIVES IN THE RING DATA ───────────────────────────────────
 *
 * The single worst visual defect in the predecessor project was the streambed
 * boulders: "interpenetrating flat triangles with no shared hull, strokes
 * terminating in open air, solid violet wedges up to 112 px shooting into
 * space". The cause was displacing vertices AFTER the geometry existed. A box
 * has its corner vertices split three ways for the three face normals, so
 * displacing each copy by its own random amount separates them — and then
 * `finalizeGeometry` has nothing left at a shared position to weld, so
 * `aSmoothNormal` is per-face, the inverted hull tears at every corner, and
 * each loose backfacing triangle fills as a solid ink wedge.
 *
 * The rule this file follows, without exception: irregularity is expressed in
 * the RING AND SECTION DATA, before a single vertex exists. Two triangles that
 * share a corner are generated from the same ring/section entry and therefore
 * from bit-identical floats, so the weld always finds them. Nothing in this
 * file ever touches a position buffer after it has been written.
 *
 * The boss is the largest mesh in the game, so it is where that defect would
 * be most visible. Every geometry leaving this file has been through
 * `finalizeGeometry`.
 */

import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';

import { Rng } from '../core/RNG';
import { finalizeGeometry } from '../npr/OutlineGeometry';
import { ARENA, BODY } from './BossConstants';

// ─────────────────────────────────────────────────────────────────────────────
// Cross-sections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A cross-section is a flat array of unit (x, z) pairs wound so that, viewed
 * from above, they advance from +Z toward +X. That winding is what makes the
 * side quads emitted by `ringedHull` come out front-facing without a flip, and
 * getting it backwards is the classic cause of a mesh that renders as a hole
 * with its interior lit.
 */
export type Section = Float32Array;

/** Regular N-gon. `phase` rotates it, in radians. */
export function polySection(sides: number, phase = 0): Section {
  const s = new Float32Array(sides * 2);
  for (let i = 0; i < sides; i++) {
    const a = phase + (i / sides) * Math.PI * 2;
    s[i * 2] = Math.sin(a);
    s[i * 2 + 1] = Math.cos(a);
  }
  return s;
}

/**
 * Rectangle of half-extents 1 in x and `depthRatio` in z, with its four
 * corners chamfered by `chamfer` (as a fraction of the half-extent).
 *
 * The chamfer is not decoration. An unchamfered box gives the inverted hull a
 * 90-degree corner to reconcile, and even welded it produces a visible mitre;
 * a chamfered one gives the hull two 45-degree steps and the stroke turns the
 * corner cleanly. It also gives the Sobel crease detector something with a
 * real dihedral to find, which is what makes hard-surface panelling read.
 */
export function boxSection(depthRatio = 1, chamfer = 0.16): Section {
  const c = Math.max(0, Math.min(0.49, chamfer));
  const d = depthRatio;
  const cz = c * d;
  // Wound from +Z toward +X, as documented above.
  const pts = [
    -1 + c, d,
    1 - c, d,
    1, d - cz,
    1, -d + cz,
    1 - c, -d,
    -1 + c, -d,
    -1, -d + cz,
    -1, d - cz,
  ];
  return new Float32Array(pts);
}

// ─────────────────────────────────────────────────────────────────────────────
// The generator
// ─────────────────────────────────────────────────────────────────────────────

export interface HullRing {
  y: number;
  /** Scale on the section's x and z. */
  sx: number;
  sz: number;
  /**
   * Optional per-section radial multiplier, length = section point count.
   * This is where irregularity belongs — see the file header.
   */
  radial?: Float32Array;
}

export interface HullOpts {
  capBottom?: boolean;
  capTop?: boolean;
}

/**
 * Sweep `section` through `rings`. Non-indexed, so `computeVertexNormals`
 * produces genuinely flat facets — which is the look, and which is also why
 * `finalizeGeometry` has real work to do afterwards.
 */
export function ringedHull(section: Section, rings: HullRing[], opts: HullOpts = {}): BufferGeometry {
  const n = section.length / 2;
  const r = rings.length;
  const capBottom = opts.capBottom !== false;
  const capTop = opts.capTop !== false;

  const sideTris = (r - 1) * n * 2;
  const capTris = (capBottom ? n : 0) + (capTop ? n : 0);
  const triCount = sideTris + capTris;
  const pos = new Float32Array(triCount * 9);
  const uv = new Float32Array(triCount * 6);

  let p = 0;
  let u = 0;

  const px = (ri: number, si: number): number => {
    const ring = rings[ri];
    const m = ring.radial ? ring.radial[si] : 1;
    return section[si * 2] * ring.sx * m;
  };
  const pz = (ri: number, si: number): number => {
    const ring = rings[ri];
    const m = ring.radial ? ring.radial[si] : 1;
    return section[si * 2 + 1] * ring.sz * m;
  };

  const push = (x: number, y: number, z: number, uu: number, vv: number): void => {
    pos[p++] = x;
    pos[p++] = y;
    pos[p++] = z;
    uv[u++] = uu;
    uv[u++] = vv;
  };

  for (let ri = 0; ri < r - 1; ri++) {
    const y0 = rings[ri].y;
    const y1 = rings[ri + 1].y;
    const v0 = ri / (r - 1);
    const v1 = (ri + 1) / (r - 1);
    for (let si = 0; si < n; si++) {
      const sj = (si + 1) % n;
      const u0 = si / n;
      const u1 = (si + 1) / n;
      const ax = px(ri, si);
      const az = pz(ri, si);
      const bx = px(ri, sj);
      const bz = pz(ri, sj);
      const cx = px(ri + 1, sj);
      const cz = pz(ri + 1, sj);
      const dx = px(ri + 1, si);
      const dz = pz(ri + 1, si);
      push(ax, y0, az, u0, v0);
      push(bx, y0, bz, u1, v0);
      push(cx, y1, cz, u1, v1);
      push(ax, y0, az, u0, v0);
      push(cx, y1, cz, u1, v1);
      push(dx, y1, dz, u0, v1);
    }
  }

  if (capBottom) {
    const y = rings[0].y;
    for (let si = 0; si < n; si++) {
      const sj = (si + 1) % n;
      push(0, y, 0, 0.5, 0.5);
      push(px(0, sj), y, pz(0, sj), 1, 0);
      push(px(0, si), y, pz(0, si), 0, 0);
    }
  }
  if (capTop) {
    const ri = r - 1;
    const y = rings[ri].y;
    for (let si = 0; si < n; si++) {
      const sj = (si + 1) % n;
      push(0, y, 0, 0.5, 0.5);
      push(px(ri, si), y, pz(ri, si), 0, 1);
      push(px(ri, sj), y, pz(ri, sj), 1, 1);
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition
// ─────────────────────────────────────────────────────────────────────────────

const _m = new Matrix4();
const _mr = new Matrix4();

/** Translate/rotate/scale a geometry in place and return it, for chaining. */
export function place(
  geo: BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): BufferGeometry {
  _m.makeScale(sx, sy, sz);
  if (rz !== 0) _m.premultiply(_mr.makeRotationZ(rz));
  if (rx !== 0) _m.premultiply(_mr.makeRotationX(rx));
  if (ry !== 0) _m.premultiply(_mr.makeRotationY(ry));
  _m.setPosition(x, y, z);
  geo.applyMatrix4(_m);
  return geo;
}

/**
 * Merge parts that share position/normal/uv.
 *
 * Written here rather than pulled from three's addons so this subsystem
 * depends on nothing outside the core three module, `core/` and `npr/` — the
 * same rule the track subsystem follows.
 */
export function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  let vcount = 0;
  for (const part of parts) {
    if (!part.getAttribute('normal')) part.computeVertexNormals();
    if (!part.getAttribute('uv')) {
      part.setAttribute('uv', new BufferAttribute(new Float32Array(part.getAttribute('position').count * 2), 2));
    }
    vcount += part.getAttribute('position').count;
  }

  const position = new Float32Array(vcount * 3);
  const normal = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);

  let vo = 0;
  for (const part of parts) {
    const pp = part.getAttribute('position') as BufferAttribute;
    const pn = part.getAttribute('normal') as BufferAttribute;
    const pu = part.getAttribute('uv') as BufferAttribute;
    position.set(pp.array as Float32Array, vo * 3);
    normal.set(pn.array as Float32Array, vo * 3);
    uv.set(pu.array as Float32Array, vo * 2);
    vo += pp.count;
    part.dispose();
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  return g;
}

/**
 * Weld tolerance for boss-scale geometry.
 *
 * 2 mm. The default 0.1 mm is right for a bike lug; on a 20 m body assembled
 * from parts whose shared corners are produced by separate `place` calls the
 * floats differ in the last couple of bits after a rotation, and a tolerance
 * that tight leaves them unwelded — which is exactly the state that tears the
 * hull.
 */
export const WELD_TOLERANCE = 2e-3;

/** Every geometry in this subsystem leaves through here. */
export function finishHardSurface(geo: BufferGeometry): BufferGeometry {
  return finalizeGeometry(geo, {
    tolerance: WELD_TOLERANCE,
    maxWeldAngle: 78,
    ao: true,
    aoStrength: 0.55,
  });
}

/** As above, for organic/rock shapes that want everything welded. */
export function finishOrganic(geo: BufferGeometry): BufferGeometry {
  return finalizeGeometry(geo, {
    tolerance: WELD_TOLERANCE,
    maxWeldAngle: 180,
    ao: true,
    aoStrength: 0.7,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience shapes
// ─────────────────────────────────────────────────────────────────────────────

/** A chamfered slab standing on the XZ plane, centred in x and z. */
export function slab(w: number, h: number, d: number, chamfer = 0.12): BufferGeometry {
  const c = Math.min(Math.min(w, d) * chamfer, h * 0.3);
  const section = boxSection(d / w, chamfer);
  const hw = w * 0.5;
  const inset = 1 - (c / hw) * 0.9;
  return ringedHull(section, [
    { y: 0, sx: hw * inset, sz: hw * inset },
    { y: c, sx: hw, sz: hw },
    { y: h - c, sx: hw, sz: hw },
    { y: h, sx: hw * inset, sz: hw * inset },
  ]);
}

/** A tapered slab — wide at the base, narrow at the top. */
export function taperSlab(
  w0: number,
  d0: number,
  w1: number,
  d1: number,
  h: number,
  chamfer = 0.12,
): BufferGeometry {
  const section = boxSection(1, chamfer);
  const c = Math.min(h * 0.16, Math.min(w0, w1) * 0.2);
  const k = 0.92;
  return ringedHull(section, [
    { y: 0, sx: w0 * 0.5 * k, sz: d0 * 0.5 * k },
    { y: c, sx: w0 * 0.5, sz: d0 * 0.5 },
    { y: h - c, sx: w1 * 0.5, sz: d1 * 0.5 },
    { y: h, sx: w1 * 0.5 * k, sz: d1 * 0.5 * k },
  ]);
}

/** A faceted column / drum. */
export function drum(sides: number, r0: number, r1: number, h: number, phase = 0): BufferGeometry {
  return ringedHull(polySection(sides, phase), [
    { y: 0, sx: r0 * 0.9, sz: r0 * 0.9 },
    { y: h * 0.06, sx: r0, sz: r0 },
    { y: h * 0.94, sx: r1, sz: r1 },
    { y: h, sx: r1 * 0.9, sz: r1 * 0.9 },
  ]);
}

/** A faceted spike. */
export function spike(sides: number, radius: number, h: number, phase = 0): BufferGeometry {
  return ringedHull(polySection(sides, phase), [
    { y: 0, sx: radius * 0.85, sz: radius * 0.85 },
    { y: h * 0.12, sx: radius, sz: radius },
    { y: h, sx: radius * 0.02, sz: radius * 0.02 },
  ]);
}

/** A faceted ball, built as a stack of rings so it stays part of one system. */
export function ball(sides: number, stacks: number, radius: number): BufferGeometry {
  const rings: HullRing[] = [];
  for (let i = 0; i <= stacks; i++) {
    const t = i / stacks;
    const a = t * Math.PI;
    const s = Math.sin(a) * radius;
    rings.push({ y: -Math.cos(a) * radius, sx: Math.max(s, radius * 0.02), sz: Math.max(s, radius * 0.02) });
  }
  return ringedHull(polySection(sides), rings, { capBottom: false, capTop: false });
}

/**
 * An open band — a cylinder wall with no caps. The shock ring's mesh.
 *
 * It hangs `skirt` metres below its hazard band so it stays visually planted
 * on rolling ground: the arena floor is a mountainside, and a flat annulus
 * drawn at the emitter's height would float metres above the far side of the
 * bowl and read as a halo rather than as ground being thrown up.
 */
export function openBand(sides: number, yLow: number, yHigh: number, flare: number): BufferGeometry {
  return ringedHull(polySection(sides), [
    { y: yLow, sx: 1, sz: 1 },
    { y: 0, sx: 1 + flare * 0.35, sz: 1 + flare * 0.35 },
    { y: yHigh, sx: 1 + flare, sz: 1 + flare },
  ], { capBottom: false, capTop: false });
}

/** A flat disc lying in XZ, for ground markers. Unit radius. */
export function disc(sides: number): BufferGeometry {
  return ringedHull(polySection(sides), [
    { y: 0, sx: 1, sz: 1 },
    { y: 0.05, sx: 1, sz: 1 },
  ]);
}

/**
 * Irregular rock. The jitter is baked into per-ring radial arrays before any
 * vertex exists — see the file header for why that distinction is the whole
 * difference between a rock and a pile of loose triangles.
 */
export function rock(rng: Rng, sides: number, stacks: number, radius: number, roughness: number): BufferGeometry {
  const rings: HullRing[] = [];
  for (let i = 0; i <= stacks; i++) {
    const t = i / stacks;
    const a = t * Math.PI;
    const s = Math.max(Math.sin(a), 0.06) * radius;
    const radial = new Float32Array(sides);
    for (let k = 0; k < sides; k++) radial[k] = 1 + rng.signed() * roughness;
    rings.push({ y: -Math.cos(a) * radius * 0.82, sx: s, sz: s, radial });
  }
  return ringedHull(polySection(sides), rings, { capBottom: false, capTop: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// Boss parts
//
// Each returns geometry in the LOCAL space of the joint that carries it, with
// the joint's pivot at the origin. Nothing here knows where it ends up; the
// rig does the assembly, which is what lets the rig animate.
// ─────────────────────────────────────────────────────────────────────────────

/** Pelvis and lower spine. Pivot at the hip. */
export function pelvisGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  parts.push(place(taperSlab(BODY.hipHalfWidth * 2, 4.4, BODY.hipHalfWidth * 1.7, 3.4, 3.0), 0, -1.4, 0));
  parts.push(place(drum(6, 1.5, 1.2, 2.2), 0, 1.2, 0));
  // Hip yokes.
  parts.push(place(drum(8, 1.5, 1.4, 2.4, 0.4), -BODY.legSpread, -2.2, 0, 0, 0, Math.PI * 0.5));
  parts.push(place(drum(8, 1.5, 1.4, 2.4, 0.4), BODY.legSpread, -2.2, 0, 0, 0, -Math.PI * 0.5));
  return mergeParts(parts);
}

/** Torso. Pivot at the waist joint. */
export function torsoGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const w = BODY.torsoHalfWidth * 2;
  const d = BODY.torsoHalfDepth * 2;
  parts.push(place(taperSlab(w * 0.72, d * 0.82, w, d, BODY.torsoHeight * 0.62), 0, 0, 0));
  parts.push(place(taperSlab(w, d, w * 0.86, d * 0.7, BODY.torsoHeight * 0.42), 0, BODY.torsoHeight * 0.6, 0));
  // Clavicle beam the shoulders hang off.
  parts.push(place(drum(6, 1.15, 1.15, BODY.shoulderOffset * 2), -BODY.shoulderOffset, BODY.torsoHeight * 0.9, 0, 0, 0, Math.PI * 0.5));
  // Chest cowl over the core.
  parts.push(place(taperSlab(w * 0.56, 1.5, w * 0.34, 1.0, 2.4), 0, BODY.torsoHeight * 0.28, d * 0.42));
  return mergeParts(parts);
}

/** The chest keel and shoulder guards — the `frame` accent pass on the torso. */
export function torsoTrimGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const w = BODY.torsoHalfWidth * 2;
  const d = BODY.torsoHalfDepth * 2;
  for (let i = 0; i < 3; i++) {
    const y = BODY.torsoHeight * (0.12 + i * 0.2);
    parts.push(place(slab(w * 0.86 - i * 0.5, 0.42, d * 0.9, 0.3), 0, y, 0));
  }
  parts.push(place(spike(5, 1.1, 2.6), 0, BODY.torsoHeight * 0.98, -d * 0.32, -0.5));
  return mergeParts(parts);
}

/** One dorsal vent plate. Pivot on its hinge at the spine side. */
export function ventPlateGeometry(): BufferGeometry {
  return place(taperSlab(BODY.ventWidth, BODY.ventDepth, BODY.ventWidth * 0.8, BODY.ventDepth * 0.7, 0.5), 0, 0, BODY.ventWidth * 0.32, Math.PI * 0.5);
}

/** The core crystal. Centred on its own origin. */
export function coreGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  parts.push(ball(7, 4, BODY.coreRadius));
  parts.push(place(spike(5, BODY.coreRadius * 0.5, BODY.coreRadius * 1.7), 0, 0, 0, Math.PI * 0.5, 0, 0));
  parts.push(place(spike(5, BODY.coreRadius * 0.5, BODY.coreRadius * 1.7), 0, 0, 0, -Math.PI * 0.5, 0, 0));
  return mergeParts(parts);
}

/** Head. Pivot at the neck. */
export function headGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const r = BODY.headRadius;
  parts.push(place(taperSlab(r * 2.2, r * 2.6, r * 1.5, r * 1.8, r * 1.5), 0, 0, 0));
  parts.push(place(drum(6, r * 0.85, r * 0.4, r * 1.1), 0, r * 1.4, -r * 0.2, 0.35));
  // Brow horns.
  parts.push(place(spike(4, r * 0.34, r * 2.0), -r * 0.8, r * 1.2, -r * 0.4, -0.7, 0, -0.25));
  parts.push(place(spike(4, r * 0.34, r * 2.0), r * 0.8, r * 1.2, -r * 0.4, -0.7, 0, 0.25));
  return mergeParts(parts);
}

/** Visor lens. Sits in the head's local space. */
export function visorGeometry(): BufferGeometry {
  const r = BODY.headRadius;
  return place(taperSlab(BODY.visorWidth, 0.5, BODY.visorWidth * 0.7, 0.4, 1.0), 0, r * 0.6, r * 1.22, Math.PI * 0.5);
}

/** Shoulder pauldron. Pivot at the shoulder joint. */
export function pauldronGeometry(side: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  parts.push(place(taperSlab(4.4, 4.0, 3.2, 3.0, 3.2), side * 0.9, -1.4, 0, 0, 0, side * 0.22));
  parts.push(place(spike(5, 0.7, 2.4), side * 2.4, 0.6, 0, 0, 0, side * 1.0));
  return mergeParts(parts);
}

/** Upper arm. Pivot at the shoulder, running down -Y. */
export function upperArmGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const t = BODY.armThickness;
  parts.push(place(taperSlab(t * 2, t * 2, t * 1.7, t * 1.7, BODY.upperArmLength), 0, -BODY.upperArmLength, 0));
  parts.push(place(drum(8, t * 1.1, t * 1.1, t * 1.8, 0.4), -t * 0.9, 0, 0, 0, 0, Math.PI * 0.5));
  return mergeParts(parts);
}

/** Forearm. Pivot at the elbow, running down -Y. */
export function forearmGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const t = BODY.armThickness;
  parts.push(place(taperSlab(t * 1.8, t * 1.8, t * 2.1, t * 2.1, BODY.forearmLength), 0, -BODY.forearmLength, 0));
  // Blade fin along the outside — the thing the arc sweep is drawn with.
  parts.push(place(taperSlab(0.5, 3.4, 0.4, 1.6, BODY.forearmLength * 0.8), t * 1.1, -BODY.forearmLength * 0.85, 0));
  return mergeParts(parts);
}

/** Fist. Pivot at the wrist. */
export function fistGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const r = BODY.fistRadius;
  parts.push(place(taperSlab(r * 2, r * 2.2, r * 2.2, r * 2.4, r * 2.0), 0, -r * 2.0, 0));
  for (let i = 0; i < 3; i++) {
    parts.push(place(slab(r * 0.5, r * 1.2, r * 2.0, 0.2), (i - 1) * r * 0.62, -r * 2.3, r * 0.4));
  }
  return mergeParts(parts);
}

/** Thigh. Pivot at the hip, running down -Y. */
export function thighGeometry(): BufferGeometry {
  const t = BODY.legThickness;
  return place(taperSlab(t * 2.1, t * 2.3, t * 1.7, t * 1.9, BODY.thighLength), 0, -BODY.thighLength, 0);
}

/** Shin. Pivot at the knee. */
export function shinGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const t = BODY.legThickness;
  parts.push(place(taperSlab(t * 1.7, t * 1.9, t * 1.9, t * 2.0, BODY.shinLength), 0, -BODY.shinLength, 0));
  parts.push(place(drum(8, t * 1.2, t * 1.2, t * 2.0, 0.4), -t, 0, 0, 0, 0, Math.PI * 0.5));
  return mergeParts(parts);
}

/** Foot. Pivot at the ankle. */
export function footGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const t = BODY.legThickness;
  const l = BODY.footLength;
  parts.push(place(taperSlab(t * 2.2, l, t * 1.9, l * 0.8, 1.7), 0, -1.7, l * 0.18));
  for (let i = 0; i < 3; i++) {
    parts.push(place(spike(4, 0.55, 1.5), (i - 1) * t * 0.8, -1.7, l * 0.52, Math.PI * 0.42));
  }
  return mergeParts(parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Arena parts
// ─────────────────────────────────────────────────────────────────────────────

/** One of the leaning monoliths that ring the bowl. */
export function monolithGeometry(rng: Rng, height: number): BufferGeometry {
  const sides = 7;
  const rings: HullRing[] = [];
  const stacks = 6;
  const baseR = height * 0.13;
  for (let i = 0; i <= stacks; i++) {
    const t = i / stacks;
    const radial = new Float32Array(sides);
    for (let k = 0; k < sides; k++) radial[k] = 1 + rng.signed() * 0.20;
    const taper = 1 - t * 0.55 + Math.sin(t * 3.1) * 0.06;
    rings.push({ y: -height * 0.12 + t * height * 1.12, sx: baseR * taper, sz: baseR * taper * 0.72, radial });
  }
  return ringedHull(polySection(sides), rings);
}

/** The stepped dais the boss wakes on. */
export function daisGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const steps = ARENA.daisSteps;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const r = ARENA.daisRadius * (1 - t * 0.24);
    const y = -ARENA.daisHeight * 0.5 + (ARENA.daisHeight / steps) * i;
    parts.push(place(drum(11, r, r * 0.985, ARENA.daisHeight / steps + 0.2, i * 0.14), 0, y, 0));
  }
  return mergeParts(parts);
}

/** A buttress ramp running from the floor up the arena wall. */
export function buttressGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const l = ARENA.buttressLength;
  const w = ARENA.buttressWidth;
  const h = ARENA.buttressHeight;
  // The ramp deck: a long wedge rising along +Z.
  const section = boxSection(1, 0.1);
  parts.push(ringedHull(section, [
    { y: 0, sx: w * 0.5, sz: l * 0.5 },
    { y: h * 0.5, sx: w * 0.46, sz: l * 0.5 },
    { y: h, sx: w * 0.34, sz: l * 0.5 },
  ]));
  // Cut the wedge by leaning the whole block, then buttress it underneath.
  parts.push(place(taperSlab(w * 0.5, l * 0.3, w * 0.3, l * 0.2, h * 0.7), 0, 0, l * 0.3));
  return mergeParts(parts);
}

/** A slab the boss tears out of the headwall and drops. Pivot at its base. */
export function pillarGeometry(rng: Rng, radius: number, height: number): BufferGeometry {
  const sides = 6;
  const rings: HullRing[] = [];
  const stacks = 4;
  for (let i = 0; i <= stacks; i++) {
    const t = i / stacks;
    const radial = new Float32Array(sides);
    for (let k = 0; k < sides; k++) radial[k] = 1 + rng.signed() * 0.16;
    rings.push({ y: t * height, sx: radius * (1 - t * 0.2), sz: radius * 0.62 * (1 - t * 0.2), radial });
  }
  return ringedHull(polySection(sides), rings);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounds helper
// ─────────────────────────────────────────────────────────────────────────────

const _bmin = new Vector3();
const _bmax = new Vector3();

/** Height of a geometry's bounding box, for sanity checks in the rig. */
export function geometryHeight(geo: BufferGeometry): number {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return 0;
  _bmin.copy(bb.min);
  _bmax.copy(bb.max);
  return _bmax.y - _bmin.y;
}
