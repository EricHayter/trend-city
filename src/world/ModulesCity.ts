import { Vector3 } from 'three';
import { Canvas } from './Canvas';
import { ModuleDef, ModuleOut, deck, ramp, booster, bouncePad, hazard, crate,
  flankTowers, boroughFloor, overheadClutter, ambientProps, ROUTE_L, ROUTE_C, ROUTE_R } from './ModuleKit';

const out = (c: Canvas, endZ: number, endY: number, turn: number, speed: number, label: string): ModuleOut => ({
  exit: { pos: c.toWorld(0, endY, endZ, new Vector3()), heading: c.heading + turn },
  exitSpeed: speed, distance: endZ, label,
});

// ---------------------------------------------------------------------------
// VENT AND AIR-PIPE TRAVERSAL. Giant ductwork used as a road: sloped intake ramps,
// round pipe backs to balance along, and grate blowers that punch the player upward.
// ---------------------------------------------------------------------------
export const ventPipes: ModuleDef = {
  name: 'vents', label: 'AIR HANDLING', role: 'redirect', minSpeed: 14, weight: 8,
  build(c, p) {
    const rng = c.rng;
    deck(c, 0, 26, 0, 22, 0);
    // Intake mouth: a huge sloped duct that converts the drop into speed.
    const dropA = rng.range(12, 20);
    ramp(c, 26, 78, 0, 16, 0, -dropA, 'duct', { boost: 1.2 });
    let y = -dropA, z = 78;
    // Pipe run: cylinders you actually stand on, alternating sides so it reads as a route.
    const pipes = rng.int(3, 5);
    for (let i = 0; i < pipes; i++) {
      const len = rng.range(30, 46);
      const x = rng.range(-6, 6);
      const drop = rng.range(2, 7);
      const pitch = Math.atan2(drop, len);
      c.slab({ x, y: y - drop / 2 - 2.2, z: z + len / 2, w: 5.2, h: Math.hypot(len, drop), l: 5.2, geo: 'tube',
        kind: 'metal', variant: 'duct', pitch: Math.PI / 2 - pitch, boost: 1.1, outline: true, outlineWidth: 1.1 });
      // Parallel narrow pipe: the risky faster line.
      if (rng.chance(0.65)) {
        const sx = x + rng.sign() * 9;
        c.slab({ x: sx, y: y - drop / 2 - 1.6, z: z + len / 2, w: 2.6, h: Math.hypot(len, drop), l: 2.6, geo: 'tube',
          kind: 'metal', variant: 'duct', pitch: Math.PI / 2 - pitch, boost: 1.16, outline: true, outlineWidth: 1.0 });
        c.pickupArc('shard', [sx, y - 0.4, z + 6], [sx, y - drop - 0.4, z + len - 6], 5, 0, true);
      }
      if (rng.chance(0.5)) bouncePad(c, x, y - drop - 1.4, z + len - 4, 32);
      if (rng.chance(0.45)) c.enemy('flyer', x + rng.range(-8, 8), y + 6, z + len * 0.5, true);
      c.node(x, y - drop, z + len * 0.5, ROUTE_C, 'ground', 12);
      y -= drop;
      z += len;
    }
    deck(c, z, z + 40, 0, 24, y - 4);
    booster(c, 0, y - 4, z + 24);
    // Structure around the ducts so it reads as machinery, not floating tubes.
    for (let i = 0; i < 8; i++) {
      const pz = rng.range(30, z);
      c.decor({ x: rng.sign() * rng.range(10, 20), y: y + rng.range(-14, 10), z: pz, w: rng.range(6, 14), h: rng.range(10, 30), l: rng.range(6, 14), kind: 'metal', variant: 'metal' });
      c.decor({ x: rng.range(-16, 16), y: y + rng.range(6, 18), z: pz, w: 2.2, h: 2.2, l: 30, geo: 'tube', kind: 'metal', variant: 'duct' });
    }
    flankTowers(c, 0, z + 40, 34, 5, -50);
    ambientProps(c, 0, z + 40);
    return out(c, z + 40, y - 4, rng.range(-0.18, 0.18), Math.min(56, p.speedIn * 1.14 + 4), 'AIR HANDLING');
  },
};

// ---------------------------------------------------------------------------
// GRIND SECTION. A long elevated rail system with crossovers, a drop to a second rail,
// and a launch at the end. Rails preserve momentum and add a little.
// ---------------------------------------------------------------------------
export const grindSection: ModuleDef = {
  name: 'grind', label: 'RAIL NETWORK', role: 'preserve', minSpeed: 18, weight: 9,
  build(c, p) {
    const rng = c.rng;
    deck(c, 0, 30, 0, 24, 0);
    ramp(c, 30, 44, 0, 18, 0, 3, 'metal');
    const L = rng.range(230, 300);
    const lanes = [-1, 0, 1];
    for (const lane of lanes) {
      const x0 = lane * 11;
      const amp = rng.range(4, 10) * (lane === 0 ? 0.6 : 1);
      const pts: number[][] = [];
      const steps = 7;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const z = 46 + (L - 60) * t;
        const x = x0 + Math.sin(t * Math.PI * (1 + Math.abs(lane))) * amp;
        const y = 4 + Math.sin(t * Math.PI) * rng.range(2, 8) - t * rng.range(6, 14);
        pts.push([x, y, z]);
      }
      c.rail(pts, lane === 0 ? 1.04 : 1.1, lane === 0 ? 6 : 14);
      if (lane !== 0) c.pickupArc(lane < 0 ? 'shard' : 'orb', pts[1], pts[steps - 1], 8, 1.5, true);
      c.node(x0, 4, 46 + (L - 60) * 0.5, lane * 13, 'rail', 22);
    }
    // Support structure: towers and cross-braces make the rail system feel civic.
    for (let z = 50; z < L - 20; z += rng.range(46, 66)) {
      for (const side of [-1, 1]) {
        c.slab({ x: side * 20, y: -22, z, w: 6, h: 56, l: 6, kind: 'metal', variant: 'metal' });
        c.decor({ x: side * 13, y: 8, z, w: 16, h: 1.2, l: 1.2, kind: 'metal', variant: 'metal' });
      }
      c.decor({ x: 0, y: 12, z, w: 44, h: 1, l: 1, kind: 'metal', variant: 'metal' });
      if (rng.chance(0.5)) c.enemy('ranger', rng.sign() * 20, 2, z, false);
    }
    deck(c, L - 30, L, 0, 28, -10);
    booster(c, 0, -10, L - 12);
    flankTowers(c, 0, L, 44, 6, -70);
    boroughFloor(c, 0, L, -110);
    ambientProps(c, 0, L);
    c.node(0, -10, L - 12, ROUTE_C, 'ground', 0);
    return out(c, L, -10, rng.range(-0.2, 0.2), Math.min(58, p.speedIn * 1.12 + 4), 'RAIL NETWORK');
  },
};

// ---------------------------------------------------------------------------
// SOLAR SLOPE. Enormous panel arrays strung between towers, descending hard. Pure
// momentum gain with a hazard cost: panel frames hurt, the glass lanes are fast.
// ---------------------------------------------------------------------------
export const solarSlope: ModuleDef = {
  name: 'solar', label: 'SOLAR CASCADE', role: 'build', minSpeed: 12, weight: 8,
  build(c, p) {
    const rng = c.rng;
    deck(c, 0, 24, 0, 24, 0);
    let z = 24, y = 0;
    const tiers = rng.int(3, 5);
    for (let i = 0; i < tiers; i++) {
      const len = rng.range(46, 70);
      const drop = len * rng.range(0.3, 0.44);
      const width = rng.range(26, 40);
      ramp(c, z, z + len, rng.range(-3, 3), width, y, y - drop, 'panel', { boost: 1.24 });
      // Frame ribs: readable hazard stripes between panel lanes.
      const ribs = 3;
      for (let k = 1; k < ribs; k++) {
        const rx = -width / 2 + (width / ribs) * k;
        c.decor({ x: rx, y: y - drop * 0.5 + 0.4, z: z + len / 2, w: 0.7, h: 0.5, l: Math.hypot(len, drop), pitch: Math.atan2(drop, len), kind: 'metal', variant: 'metal' });
      }
      c.pickupArc('fragment', [0, y + 2, z + 6], [0, y - drop + 2, z + len - 6], 6, 0);
      if (rng.chance(0.6)) c.enemy('pursuer', rng.range(-8, 8), y - drop * 0.4 + 1.6, z + len * 0.6, true);
      // Under-panel truss so the cascade reads as engineering.
      c.decor({ x: 0, y: y - drop / 2 - 3.2, z: z + len / 2, w: width * 0.9, h: 1.2, l: Math.hypot(len, drop), pitch: Math.atan2(drop, len), kind: 'metal', variant: 'metal' });
      y -= drop;
      z += len;
      c.node(0, y, z, ROUTE_C, 'ground', 0);
      if (i < tiers - 1) {
        const gap = Math.min(24, 10 + p.speedIn * 0.28);
        c.pickupArc('orb', [0, y + 4, z + 2], [0, y + 2, z + gap - 2], 3, 2, true);
        z += gap;
      }
    }
    deck(c, z, z + 34, 0, 26, y - 2);
    booster(c, 0, y - 2, z + 18);
    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      c.building(side * rng.range(30, 44), rng.range(20, z), rng.range(16, 26), rng.range(16, 26), rng.range(60, 150), { baseY: -110 });
    }
    boroughFloor(c, 0, z, -140);
    ambientProps(c, 0, z);
    return out(c, z + 34, y - 2, rng.range(-0.16, 0.16), Math.min(60, p.speedIn * 1.3 + 10), 'SOLAR CASCADE');
  },
};

// ---------------------------------------------------------------------------
// WALL-RUN CANYON. Two facing facades with a gap the player cannot cross on foot.
// Entry speed is required, exit direction is preserved.
// ---------------------------------------------------------------------------
export const wallrunCanyon: ModuleDef = {
  name: 'wallrun', label: 'THE SLOT', role: 'require', minSpeed: 22, weight: 8,
  build(c, p) {
    const rng = c.rng;
    deck(c, 0, 28, 0, 22, 0);
    booster(c, 0, 0, 18);
    const L = rng.range(150, 200);
    const gapW = rng.range(15, 19);
    // Facing walls. Staggered so the player alternates sides rather than holding one.
    let z = 30;
    let side = rng.sign();
    while (z < L - 20) {
      const len = rng.range(40, 58);
      c.slab({ x: side * (gapW / 2 + 3), y: 12, z: z + len / 2, w: 6, h: 44, l: len, kind: 'concrete', variant: 'facade' });
      c.decor({ x: side * (gapW / 2 - 0.2), y: 6, z: z + len / 2, w: 0.5, h: 1.6, l: len * 0.8, kind: 'neon', variant: 'neon' });
      c.pickupArc('shard', [side * (gapW / 2 - 2), 7, z + 8], [side * (gapW / 2 - 2), 9, z + len - 8], 5, 1, true);
      // Small ledge on the opposite side: a recovery beat, not a free ride.
      if (rng.chance(0.6)) c.slab({ x: -side * (gapW / 2 - 1), y: 2.4, z: z + len * 0.7, w: 4, h: 0.8, l: 8, kind: 'metal', variant: 'panel' });
      c.node(side * (gapW / 2 - 2), 8, z + len / 2, side * 13, 'wall', 26);
      side *= -1;
      z += len;
    }
    // The floor of the slot is a long way down, and that is the point.
    boroughFloor(c, 0, L, -150);
    deck(c, L - 20, L + 24, 0, 26, 2);
    c.pickup('time', 0, 4, L + 8, false, 4);
    for (const s of [-1, 1]) c.building(s * (gapW / 2 + 26), L * 0.5, 30, L * 0.9, 90, { baseY: -60, sign: true });
    ambientProps(c, 0, L);
    return out(c, L + 24, 2, rng.range(-0.14, 0.14), Math.min(56, p.speedIn * 1.02), 'THE SLOT');
  },
};

// ---------------------------------------------------------------------------
// MOVING PLATFORM SPAN. Over an enormous void, with rails between drifting decks.
// ---------------------------------------------------------------------------
export const movingSpan: ModuleDef = {
  name: 'moving', label: 'THE SPAN', role: 'preserve', minSpeed: 18, weight: 6,
  build(c, p) {
    const rng = c.rng;
    deck(c, 0, 26, 0, 26, 0);
    let z = 26, y = 0;
    const decks = rng.int(4, 6);
    for (let i = 0; i < decks; i++) {
      const gap = Math.min(26, 12 + p.speedIn * 0.3);
      z += gap;
      const w = rng.range(12, 18);
      const horizontal = rng.chance(0.55);
      c.slab({
        x: rng.range(-6, 6), y, z, w, h: 1.4, l: rng.range(12, 20), kind: 'metal', variant: 'panel',
        moving: horizontal
          ? { axis: new Vector3(1, 0, 0), amplitude: rng.range(8, 16), speed: rng.range(0.5, 0.9), phase: rng.range(0, 6.28), mode: 'sine' }
          : { axis: new Vector3(0, 1, 0), amplitude: rng.range(4, 9), speed: rng.range(0.6, 1.1), phase: rng.range(0, 6.28), mode: 'sine' },
        outline: true, outlineWidth: 1.2,
      });
      c.pickup('orb', rng.range(-4, 4), y + 3, z, true, 2);
      c.node(0, y, z, ROUTE_C, 'ground', 16);
      if (rng.chance(0.4)) c.enemy('flyer', rng.range(-10, 10), y + 7, z + gap * 0.4, true);
      y += rng.range(-3, 3);
    }
    z += 20;
    deck(c, z, z + 40, 0, 28, y);
    // A rail underline for players who fall short: a miss costs time, not the run.
    c.rail([[0, y - 16, 30], [0, y - 22, z * 0.6], [0, y - 12, z + 8]], 1.06, 10);
    boroughFloor(c, 0, z, -180);
    flankTowers(c, 0, z, 60, 4, -140);
    ambientProps(c, 0, z);
    return out(c, z + 40, y, rng.range(-0.12, 0.12), Math.min(52, p.speedIn), 'THE SPAN');
  },
};

// ---------------------------------------------------------------------------
// RECOVERY DECK. Wide, calm, generous. Placed after anything punishing so the pacing
// breathes and the player can spend a beat reading the skyline.
// ---------------------------------------------------------------------------
export const recoveryDeck: ModuleDef = {
  name: 'recover', label: 'QUIET ROOF', role: 'recover', minSpeed: 0, weight: 5,
  build(c, p) {
    const rng = c.rng;
    const L = rng.range(90, 120);
    deck(c, 0, L, 0, 34, 0);
    c.pickup('health', -6, 2, L * 0.4, false, 1);
    c.pickup('health', 6, 2, L * 0.55, false, 1);
    c.pickup('time', 0, 2, L * 0.7, false, 5);
    for (let i = 0; i < 6; i++) {
      const x = rng.range(-14, 14), z = rng.range(10, L - 10);
      if (rng.chance(0.5)) c.slab({ x, y: 1.4, z, w: 3, h: 2.4, l: 3, kind: 'metal', variant: 'duct' });
      else c.decor({ x, y: 1.6, z, w: 2.4, h: 2.6, l: 2.4, geo: 'sphere', kind: 'foliage', variant: 'foliage' });
    }
    c.decor({ x: 0, y: 7, z: L * 0.5, w: 22, h: 0.4, l: 0.4, kind: 'neon', variant: 'neon' });
    booster(c, 0, 0, L - 14);
    flankTowers(c, 0, L, 28, 4);
    ambientProps(c, 0, L);
    c.node(0, 0, L * 0.5, ROUTE_C, 'ground', 0);
    return out(c, L, 0, rng.range(-0.24, 0.24), Math.min(48, p.speedIn * 0.9 + 8), 'QUIET ROOF');
  },
};

// ---------------------------------------------------------------------------
// STREET TRANSITION. Drops the player off the roofs into the borough itself: a curved
// canyon street at full speed with traffic barriers, awnings and a climb back up.
// ---------------------------------------------------------------------------
export const streetRun: ModuleDef = {
  name: 'street', label: 'BOROUGH STREETS', role: 'redirect', minSpeed: 14, weight: 7,
  build(c, p) {
    const rng = c.rng;
    const turn = rng.sign() * rng.range(0.3, 0.55);
    const L = rng.range(180, 230);
    // Descend into the street.
    ramp(c, 0, 60, 0, 22, 0, -34, 'duct', { boost: 1.2 });
    deck(c, 60, L, 0, 26, -34, 'roof', { boost: 1.04 });
    // Street walls: continuous facades with awnings to bounce along.
    for (const side of [-1, 1]) {
      for (let z = 60; z < L; z += 34) {
        c.building(side * 24, z + 17, 22, 34, rng.range(50, 110), { baseY: -36, sign: true });
        if (rng.chance(0.55)) c.slab({ x: side * 12, y: -28, z: z + rng.range(6, 26), w: 6, h: 0.6, l: 8, kind: 'metal', variant: 'panel', bounce: 30, pitch: side * 0.14 });
      }
    }
    for (let z = 74; z < L - 20; z += rng.range(24, 34)) {
      if (rng.chance(0.5)) hazard(c, rng.range(-8, 8), -34, z, 4, 3, 2.4);
      else crate(c, rng.range(-8, 8), -34, z);
      if (rng.chance(0.4)) c.enemy(rng.pick(['grunt', 'armored', 'turret'] as any), rng.range(-9, 9), -32.6, z, false);
    }
    c.pickupArc('fragment', [0, -32, 70], [0, -32, L - 20], 9, 0);
    overheadClutter(c, 60, L, -18);
    // Climb out: a ramp into a booster that fires up onto the next rooftop line.
    ramp(c, L, L + 54, 0, 20, -34, -6, 'panel', { boost: 1.2 });
    booster(c, 0, -6, L + 46);
    c.node(0, -34, L * 0.6, ROUTE_C, 'ground', 0);
    c.node(0, -6, L + 50, ROUTE_C, 'launch', 20);
    ambientProps(c, 0, L);
    return out(c, L + 54, -6, turn, Math.min(56, p.speedIn * 1.1 + 6), 'BOROUGH STREETS');
  },
};
