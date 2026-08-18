import { Vector3 } from 'three';
import { Canvas } from './Canvas';
import { ModuleDef, ModuleOut, ModuleParams, deck, ramp, booster, bouncePad, hazard, crate,
  flankTowers, boroughFloor, overheadClutter, ambientProps, ROUTE_L, ROUTE_C, ROUTE_R } from './ModuleKit';

const out = (c: Canvas, endZ: number, endY: number, turn: number, speed: number, label: string): ModuleOut => ({
  exit: { pos: c.toWorld(0, endY, endZ, new Vector3()), heading: c.heading + turn },
  exitSpeed: speed,
  distance: endZ,
  label,
});

// ---------------------------------------------------------------------------
// START. Wide, unmistakable, and it sells the visual identity in one shot: a raised
// launch deck aimed down the borough with the skyline framed dead centre.
// ---------------------------------------------------------------------------
export const startPlaza: ModuleDef = {
  name: 'start', label: 'BOROUGH GATE', role: 'build', minSpeed: 0, weight: 0,
  build(c, p) {
    const L = 150;
    deck(c, -14, 60, 0, 30, 0);
    c.slab({ x: 0, y: 1.4, z: -13, w: 30, h: 4, l: 1.4, kind: 'metal', variant: 'metal' });
    for (const side of [-1, 1]) {
      c.decor({ x: side * 15.4, y: 3, z: 10, w: 0.6, h: 7, l: 26, kind: 'neon', variant: 'neon' });
      c.slab({ x: side * 15.6, y: 1.2, z: 30, w: 1.2, h: 2.4, l: 60, kind: 'metal', variant: 'metal' });
    }
    // Immediate downhill so the first two seconds are already fast.
    ramp(c, 60, 108, 0, 26, 0, -14, 'panel', { boost: 1.16 });
    deck(c, 108, L, 0, 24, -14);
    booster(c, 0, -14, 126);
    c.pickupArc('fragment', [0, 1.6, 68], [0, -12.4, 104], 8, 1.2);
    c.pickup('boost', 0, -12.4, 138, false, 1);
    flankTowers(c, -20, L, 30, 7);
    boroughFloor(c, -20, L);
    overheadClutter(c, 20, 60, 14);
    ambientProps(c, 0, L);
    c.node(0, 0, 0, ROUTE_C, 'ground', 0);
    c.node(0, -14, 108, ROUTE_C, 'ground', 0);
    c.node(0, -14, L, ROUTE_C, 'ground', 0);
    return out(c, L, -14, 0, 34, 'BOROUGH GATE');
  },
};

// ---------------------------------------------------------------------------
// ROOFTOP RUN. The bread and butter: staggered rooftops with real gaps, sloped roofs
// that give speed back, and three readable lines across the block.
// ---------------------------------------------------------------------------
export const rooftopRun: ModuleDef = {
  name: 'rooftop', label: 'ROOFTOP RUN', role: 'preserve', minSpeed: 14, weight: 10,
  build(c, p) {
    const rng = c.rng;
    const count = rng.int(4, 6);
    let z = 0;
    let y = 0;
    for (let i = 0; i < count; i++) {
      const len = rng.range(30, 52);
      const width = rng.range(20, 30);
      const sloped = rng.chance(0.45);
      if (sloped) {
        const drop = rng.range(4, 9);
        ramp(c, z, z + len, 0, width, y, y - drop, 'panel', { boost: 1.12 });
        y -= drop;
      } else {
        deck(c, z, z + len, 0, width, y);
        if (rng.chance(0.5)) {
          // Side terrace: a slower but safer line with a health pickup.
          const side = rng.sign();
          deck(c, z + len * 0.2, z + len * 0.9, side * (width / 2 + 7), 12, y - rng.range(3, 6));
          c.pickup(rng.chance(0.5) ? 'health' : 'fragment', side * (width / 2 + 7), y - 2.4, z + len * 0.55, false, 1);
          c.node(side * (width / 2 + 7), y - 4, z + len * 0.55, side < 0 ? ROUTE_L : ROUTE_R, 'ground', 10);
        }
      }
      // Roof furniture placed to be jumped, slid under or bounced off, never to block.
      const props = rng.int(1, 3);
      for (let k = 0; k < props; k++) {
        const px = rng.range(-width * 0.36, width * 0.36);
        const pz = z + rng.range(8, len - 8);
        const t = rng.float();
        if (t < 0.3) hazard(c, px, y, pz, 3, 2.6, 2);
        else if (t < 0.55) crate(c, px, y, pz);
        else if (t < 0.75) c.slab({ x: px, y: y + 1.4, z: pz, w: 3.4, h: 2.8, l: 3.4, kind: 'metal', variant: 'duct' });
        else bouncePad(c, px, y + 0.4, pz, 30);
      }
      c.node(0, y, z + len * 0.5, ROUTE_C, 'ground', 0);
      z += len;
      // Gap between rooftops, sized against the entry speed so it is always clearable.
      const gap = Math.min(26, 8 + p.speedIn * rng.range(0.28, 0.46));
      const nextDrop = rng.range(-3, 8);
      // Aerial reward on the risky line over the gap.
      if (rng.chance(0.7)) c.pickupArc('fragment', [rng.range(-6, 6), y + 4, z + 2], [rng.range(-6, 6), y + 6, z + gap - 2], 4, 2.5, true);
      if (rng.chance(0.35)) c.enemy('flyer', rng.range(-8, 8), y + 6, z + gap * 0.5, true);
      c.node(0, y + 5, z + gap * 0.5, ROUTE_C, 'air', 12 + gap * 0.55);
      z += gap;
      y -= nextDrop * 0.2;
    }
    flankTowers(c, 0, z, 32, Math.ceil(z / 60) + 2);
    boroughFloor(c, 0, z);
    ambientProps(c, 0, z);
    if (c.rng.chance(0.5)) overheadClutter(c, 0, z, 18);
    return out(c, z, y, c.rng.range(-0.14, 0.14), Math.min(52, p.speedIn * 1.04), 'ROOFTOP RUN');
  },
};

// ---------------------------------------------------------------------------
// DOWNHILL. A long descending run of panelled roof and duct slope. This is the module
// the grammar reaches for when a later section needs speed the player does not have.
// ---------------------------------------------------------------------------
export const downhillSlope: ModuleDef = {
  name: 'downhill', label: 'DOWNHILL PLUNGE', role: 'build', minSpeed: 0, weight: 8,
  build(c, p) {
    const rng = c.rng;
    const segs = rng.int(3, 4);
    let z = 0, y = 0;
    for (let i = 0; i < segs; i++) {
      const len = rng.range(40, 64);
      const drop = len * rng.range(0.24, 0.38);
      const variant = i % 2 === 0 ? 'panel' : 'duct';
      ramp(c, z, z + len, 0, rng.range(18, 26), y, y - drop, variant, { boost: 1.22 });
      // Rail lines flanking the slope for players who want to convert drop into speed.
      if (rng.chance(0.6)) {
        const side = rng.sign();
        c.rail([[side * 11, y + 1.2, z + 4], [side * 11, y - drop + 1.2, z + len - 4]], 1.08);
        c.pickupArc('orb', [side * 11, y + 2.6, z + 8], [side * 11, y - drop + 2.6, z + len - 8], 5, 0, true);
      }
      y -= drop;
      z += len;
      c.node(0, y, z, ROUTE_C, 'ground', 0);
      if (rng.chance(0.5)) c.enemy(rng.chance(0.5) ? 'grunt' : 'pursuer', rng.range(-7, 7), y + 1.5, z - len * 0.4, true);
    }
    booster(c, 0, y, z - 6);
    flankTowers(c, 0, z, 30, Math.ceil(z / 55) + 2, -40);
    boroughFloor(c, 0, z, -60);
    ambientProps(c, 0, z);
    return out(c, z, y, 0, Math.min(58, p.speedIn * 1.35 + 12), 'DOWNHILL PLUNGE');
  },
};

// ---------------------------------------------------------------------------
// MOMENTUM BUILD. Flat, clean, boosters and a tunnel throat. Nothing to fight, all
// acceleration. Deliberately placed before anything that demands entry speed.
// ---------------------------------------------------------------------------
export const momentumBuild: ModuleDef = {
  name: 'build', label: 'ACCELERATION LANE', role: 'build', minSpeed: 0, weight: 7,
  build(c, p) {
    const rng = c.rng;
    const L = rng.range(140, 190);
    deck(c, 0, L, 0, 22, 0, 'panel', { boost: 1.06 });
    for (let z = 26; z < L - 20; z += rng.range(38, 52)) booster(c, rng.range(-4, 4), 0, z);
    // Tunnel throat: a hard silhouette frame that reads as speed when it snaps past.
    const tz = L * 0.62;
    for (const side of [-1, 1]) {
      c.slab({ x: side * 12, y: 5, z: tz, w: 3, h: 11, l: 26, kind: 'concrete', variant: 'facade' });
      c.decor({ x: side * 10, y: 9.4, z: tz, w: 0.6, h: 0.6, l: 24, kind: 'neon', variant: 'neon' });
    }
    c.slab({ x: 0, y: 11.6, z: tz, w: 27, h: 1.6, l: 26, kind: 'concrete', variant: 'roof' });
    c.pickupArc('fragment', [0, 1.8, 20], [0, 1.8, L - 20], 10, 0);
    c.pickup('time', 0, 2.2, tz, false, 3);
    flankTowers(c, 0, L, 26, Math.ceil(L / 50) + 2);
    boroughFloor(c, 0, L);
    overheadClutter(c, 0, L, 15);
    c.node(0, 0, L * 0.5, ROUTE_C, 'ground', 0);
    return out(c, L, 0, rng.range(-0.1, 0.1), Math.min(58, p.speedIn * 1.2 + 16), 'ACCELERATION LANE');
  },
};

// ---------------------------------------------------------------------------
// OBSTACLE CORRIDOR. Deliberately spends momentum: readable hazards, slide gaps and
// breakables that reward precision instead of raw speed.
// ---------------------------------------------------------------------------
export const obstacleCorridor: ModuleDef = {
  name: 'obstacle', label: 'SERVICE CORRIDOR', role: 'spend', minSpeed: 10, weight: 7,
  build(c, p) {
    const rng = c.rng;
    const L = rng.range(120, 160);
    deck(c, 0, L, 0, 18, 0);
    for (const side of [-1, 1]) c.slab({ x: side * 10, y: 4, z: L / 2, w: 2.4, h: 9, l: L, kind: 'concrete', variant: 'facade' });
    let z = 18;
    while (z < L - 16) {
      const t = rng.float();
      if (t < 0.34) {
        // Low bar: slide under it, keep the speed.
        c.slab({ x: 0, y: 3.6, z, w: 17, h: 1.2, l: 1.6, kind: 'hazard', variant: 'hazard', hazard: true });
        c.decor({ x: 0, y: 4.6, z, w: 17, h: 0.4, l: 0.6, kind: 'neon', variant: 'neon' });
      } else if (t < 0.62) {
        // Offset blocks: weave without braking.
        const side = rng.sign();
        hazard(c, side * 4.5, 0, z, 8, 4, 2);
        crate(c, -side * 5, 0, z + 4);
      } else if (t < 0.82) {
        c.slab({ x: rng.range(-5, 5), y: 1.6, z, w: 4, h: 3.2, l: 3, kind: 'metal', variant: 'duct', breakable: true });
      } else {
        c.enemy(rng.chance(0.5) ? 'grunt' : 'armored', rng.range(-6, 6), 1.4, z, false, 4);
      }
      z += rng.range(14, 22);
    }
    c.pickupArc('shard', [0, 2, 24], [0, 2, L - 24], 6, 0, true);
    c.pickup('health', rng.sign() * 6, 2, L * 0.7, false, 1);
    flankTowers(c, 0, L, 22, 4);
    ambientProps(c, 0, L);
    c.node(0, 0, L * 0.5, ROUTE_C, 'ground', 0);
    return out(c, L, 0, rng.range(-0.2, 0.2), Math.max(20, p.speedIn * 0.78), 'SERVICE CORRIDOR');
  },
};

// ---------------------------------------------------------------------------
// THREE ROUTE BRANCH. The core decision module: a fast risky rail line, a normal
// rooftop line, and a safe low line with health. All three reconverge, by construction.
// ---------------------------------------------------------------------------
export const threeRouteBranch: ModuleDef = {
  name: 'branch', label: 'THREE WAYS ACROSS', role: 'decide', minSpeed: 16, weight: 8,
  build(c, p) {
    const rng = c.rng;
    const L = rng.range(170, 210);
    // Shared entry apron and exit apron: this is what guarantees reconvergence.
    deck(c, 0, 26, 0, 34, 0);
    deck(c, L - 26, L, 0, 34, -6);
    c.slab({ x: 0, y: 2.2, z: 14, w: 1.2, h: 5, l: 1.2, geo: 'pole', kind: 'metal', variant: 'metal' });
    c.decor({ x: 0, y: 5.6, z: 14, w: 7, h: 2.2, l: 0.4, kind: 'neon', variant: 'neon' });

    // LEFT: high-risk rail chain over the void, biggest payout.
    const railY = 6;
    c.rail([[ROUTE_L, railY, 30], [ROUTE_L - 4, railY + 4, L * 0.4], [ROUTE_L + 2, railY - 2, L * 0.72], [ROUTE_L, railY - 6, L - 28]], 1.12, 12);
    c.pickupArc('shard', [ROUTE_L, railY + 2.4, 40], [ROUTE_L, railY - 3.6, L - 40], 7, 2, true);
    c.pickup('time', ROUTE_L, railY + 2, L * 0.5, true, 5);
    c.node(ROUTE_L, railY, L * 0.5, ROUTE_L as any, 'rail', 24);

    // CENTRE: staggered rooftops, the honest line.
    let z = 30, y = 0;
    while (z < L - 34) {
      const len = rng.range(28, 40);
      deck(c, z, z + len, ROUTE_C, 18, y);
      if (rng.chance(0.5)) crate(c, rng.range(-5, 5), y, z + len * 0.5);
      if (rng.chance(0.4)) c.enemy('grunt', rng.range(-5, 5), y + 1.4, z + len * 0.6, false);
      c.node(0, y, z + len * 0.5, ROUTE_C, 'ground', 0);
      z += len + Math.min(22, 10 + p.speedIn * 0.3);
      y -= rng.range(0, 4);
    }

    // RIGHT: safe low balcony line with recovery, slower but forgiving.
    deck(c, 30, L - 28, ROUTE_R + 4, 14, -12);
    c.pickup('health', ROUTE_R + 4, -10, L * 0.4, false, 1);
    c.pickup('fragment', ROUTE_R + 4, -10, L * 0.6, false, 1);
    ramp(c, L - 34, L - 26, ROUTE_R + 4, 14, -12, -6, 'metal');
    c.node(ROUTE_R + 4, -12, L * 0.5, ROUTE_R as any, 'ground', 8);

    flankTowers(c, 0, L, 40, 6);
    boroughFloor(c, 0, L, -80);
    ambientProps(c, 0, L);
    return out(c, L, -6, rng.range(-0.16, 0.16), Math.min(56, p.speedIn * 1.05), 'THREE WAYS ACROSS');
  },
};

// ---------------------------------------------------------------------------
// AERIAL HOMING CHAIN. Enemies as stepping stones over an enormous void: the module
// where combat and traversal are literally the same action.
// ---------------------------------------------------------------------------
export const aerialHoming: ModuleDef = {
  name: 'aerial', label: 'AIR CHAIN', role: 'require', minSpeed: 26, weight: 7,
  build(c, p) {
    const rng = c.rng;
    deck(c, 0, 30, 0, 24, 0);
    booster(c, 0, 0, 18);
    ramp(c, 30, 46, 0, 20, 0, 4, 'metal');
    let z = 56, y = 8;
    const links = rng.int(4, 6);
    for (let i = 0; i < links; i++) {
      const x = rng.range(-9, 9);
      c.enemy(rng.chance(0.7) ? 'flyer' : 'ranger', x, y, z, true);
      c.pickup('orb', x, y + 1.6, z, true, 2);
      c.node(x, y, z, ROUTE_C, 'air', 30);
      // A small platform under every second link: a miss costs time, never the run.
      if (i % 2 === 1) c.slab({ x: x * 0.4, y: y - 12, z: z + 6, w: 14, h: 1.2, l: 14, kind: 'metal', variant: 'panel' });
      z += rng.range(26, 34);
      y += rng.range(-3, 5);
    }
    deck(c, z, z + 42, 0, 26, y - 6);
    bouncePad(c, 0, y - 5.6, z + 12, 36);
    c.pickup('time', 0, y - 3, z + 30, false, 4);
    flankTowers(c, 0, z + 42, 46, 5, -90);
    boroughFloor(c, 0, z + 42, -120);
    ambientProps(c, 0, z + 42);
    c.node(0, y - 6, z + 20, ROUTE_C, 'ground', 0);
    return out(c, z + 42, y - 6, rng.range(-0.12, 0.12), Math.min(54, p.speedIn), 'AIR CHAIN');
  },
};
