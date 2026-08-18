import { Vector3 } from 'three';
import { Canvas } from './Canvas';
import { ModuleDef, ModuleOut, deck, ramp, booster, bouncePad, hazard, crate,
  flankTowers, boroughFloor, overheadClutter, ambientProps, ROUTE_L, ROUTE_C, ROUTE_R } from './ModuleKit';

const out = (c: Canvas, endZ: number, endY: number, turn: number, speed: number, label: string): ModuleOut => ({
  exit: { pos: c.toWorld(0, endY, endZ, new Vector3()), heading: c.heading + turn },
  exitSpeed: speed, distance: endZ, label,
});

// ---------------------------------------------------------------------------
// COMBAT ARENA. A bowl with cover, two elevated ledges, a rail ring and a bounce pad
// in the middle. Composition varies; the exit is always visible from the entry.
// ---------------------------------------------------------------------------
export const combatArena: ModuleDef = {
  name: 'arena', label: 'CONTESTED DECK', role: 'spend', minSpeed: 0, weight: 8,
  build(c, p) {
    const rng = c.rng;
    const R = rng.range(38, 50);
    deck(c, 0, 24, 0, 22, 0);
    // Floor plate.
    c.slab({ x: 0, y: -0.8, z: 24 + R, w: R * 2, h: 1.6, l: R * 2, kind: 'concrete', variant: 'roof' });
    // Parapet ring, broken deliberately at the entry and exit.
    const seg = 12;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      if (Math.abs(Math.cos(a)) > 0.86 && Math.sin(a) < 0) continue;
      const x = Math.sin(a) * R, z = 24 + R + Math.cos(a) * R;
      c.slab({ x, y: 1.6, z, w: 8, h: 3.2, l: 2, yawOffset: -a, kind: 'concrete', variant: 'facade' });
    }
    // Cover: chest-high blocks arranged asymmetrically so fights read differently.
    const covers = rng.int(4, 7);
    for (let i = 0; i < covers; i++) {
      const a = rng.range(0, 6.28), rr = rng.range(8, R - 10);
      const x = Math.sin(a) * rr, z = 24 + R + Math.cos(a) * rr;
      if (rng.chance(0.5)) c.slab({ x, y: 1.2, z, w: rng.range(4, 8), h: 2.4, l: rng.range(3, 6), yawOffset: rng.range(0, 3), kind: 'metal', variant: 'duct' });
      else crate(c, x, 0, z, rng.range(2, 3.4));
    }
    // Elevated ledges and a rail ring: fights stay traversal fights.
    for (const side of [-1, 1]) {
      c.slab({ x: side * (R - 8), y: 7, z: 24 + R, w: 14, h: 1.2, l: 26, kind: 'metal', variant: 'panel' });
      ramp(c, 24 + R - 22, 24 + R - 8, side * (R - 8), 8, 0, 7, 'metal');
      c.enemy(rng.pick(['ranger', 'turret'] as any), side * (R - 8), 8.4, 24 + R, false);
    }
    c.rail([[-R + 6, 11, 24 + R - 20], [0, 13, 24 + R + 10], [R - 6, 11, 24 + R - 20]], 1.04, 8);
    bouncePad(c, 0, 0.4, 24 + R, 38);
    const pack = rng.int(4, 7);
    for (let i = 0; i < pack; i++) {
      const a = rng.range(0, 6.28), rr = rng.range(10, R - 12);
      c.enemy(rng.weighted([['grunt', 5], ['armored', 2], ['flyer', 3], ['pursuer', 2]] as any), Math.sin(a) * rr, 1.6, 24 + R + Math.cos(a) * rr, false);
    }
    if (p.difficulty > 0.55 && rng.chance(0.5)) c.enemy('miniboss', 0, 2.4, 24 + R + 10, false);
    c.pickup('health', 0, 2.4, 24 + R - R * 0.5, false, 1);
    c.pickup('time', 0, 3, 24 + R + R * 0.5, false, 4);
    const endZ = 24 + R * 2 + 30;
    deck(c, 24 + R * 2 - 2, endZ, 0, 22, 0);
    booster(c, 0, 0, endZ - 12);
    flankTowers(c, 0, endZ, R + 18, 6, -70);
    boroughFloor(c, 0, endZ, -90);
    ambientProps(c, 0, endZ);
    c.node(0, 0, 24 + R, ROUTE_C, 'ground', 0);
    return out(c, endZ, 0, rng.range(-0.2, 0.2), Math.min(46, Math.max(22, p.speedIn * 0.8)), 'CONTESTED DECK');
  },
};

// ---------------------------------------------------------------------------
// GAUNTLET. Everything at once, tuned tight: hazards, turrets, moving blockers and a
// pursuit enemy on your heels. Placed late, and only after a momentum builder.
// ---------------------------------------------------------------------------
export const gauntlet: ModuleDef = {
  name: 'gauntlet', label: 'THE GAUNTLET', role: 'require', minSpeed: 30, weight: 6,
  build(c, p) {
    const rng = c.rng;
    const L = rng.range(210, 270);
    deck(c, 0, L, 0, 20, 0, 'panel', { boost: 1.08 });
    for (const side of [-1, 1]) c.slab({ x: side * 13, y: 8, z: L / 2, w: 4, h: 18, l: L, kind: 'concrete', variant: 'facade' });
    let z = 24;
    while (z < L - 18) {
      const t = rng.float();
      if (t < 0.3) {
        c.slab({ x: 0, y: 2, z, w: 8, h: 4, l: 2, kind: 'hazard', variant: 'hazard', hazard: true,
          moving: { axis: new Vector3(1, 0, 0), amplitude: rng.range(6, 9), speed: rng.range(0.8, 1.4), phase: rng.range(0, 6.3), mode: 'sine' } });
      } else if (t < 0.55) {
        hazard(c, rng.sign() * 6, 0, z, 6, 5, 2);
        c.pickup('orb', -Math.sign(rng.float() - 0.5) * 6, 2.4, z, true, 2);
      } else if (t < 0.75) {
        c.enemy('turret', rng.sign() * 10, 2, z, false);
      } else {
        booster(c, 0, 0, z);
      }
      z += rng.range(18, 26);
    }
    c.enemy('pursuer', 0, 2, 12, false, 40);
    c.enemy('pursuer', rng.range(-6, 6), 2, 20, false, 40);
    c.pickupArc('shard', [0, 2.2, 30], [0, 2.2, L - 24], 8, 0, true);
    c.pickup('time', 0, 3, L - 30, false, 6);
    overheadClutter(c, 0, L, 16);
    flankTowers(c, 0, L, 26, 6, -60);
    ambientProps(c, 0, L);
    c.node(0, 0, L * 0.5, ROUTE_C, 'ground', 28);
    return out(c, L, 0, rng.range(-0.16, 0.16), Math.min(58, p.speedIn), 'THE GAUNTLET');
  },
};

// ---------------------------------------------------------------------------
// SET PIECE: COLLAPSING ROOFTOPS. The floor falls away behind you, on a timer, with a
// wall-run bail-out if you hesitate. Scripted structure, procedural layout.
// ---------------------------------------------------------------------------
export const collapseSetpiece: ModuleDef = {
  name: 'collapse', label: 'STRUCTURAL FAILURE', role: 'require', minSpeed: 26, weight: 5, unique: true,
  build(c, p) {
    const rng = c.rng;
    deck(c, 0, 30, 0, 26, 0);
    booster(c, 0, 0, 20);
    let z = 30, y = 0;
    const plates = rng.int(7, 10);
    for (let i = 0; i < plates; i++) {
      const len = rng.range(24, 34);
      c.slab({ x: rng.range(-3, 3), y: y - 0.7, z: z + len / 2, w: rng.range(16, 24), h: 1.4, l: len,
        kind: 'concrete', variant: 'roof', collapse: 0.55 + i * 0.06, outline: true, outlineWidth: 1.1 });
      // Support columns that fall with it.
      c.decor({ x: rng.sign() * 8, y: y - 14, z: z + len / 2, w: 2.4, h: 26, l: 2.4, kind: 'concrete', variant: 'facade' });
      if (rng.chance(0.5)) c.pickup('shard', rng.range(-6, 6), y + 2.4, z + len * 0.5, true, 2);
      c.node(0, y, z + len / 2, ROUTE_C, 'ground', 26);
      z += len + rng.range(6, 13);
      y -= rng.range(0, 2.5);
    }
    // The bail-out wall, running the whole length on one side.
    const side = rng.sign();
    c.slab({ x: side * 17, y: 14, z: 60 + (z - 60) / 2, w: 6, h: 50, l: z - 40, kind: 'concrete', variant: 'facade' });
    c.decor({ x: side * 13.6, y: 6, z: 60 + (z - 60) / 2, w: 0.5, h: 1.4, l: (z - 40) * 0.9, kind: 'neon', variant: 'neon' });
    deck(c, z, z + 44, 0, 30, y - 2);
    c.pickup('time', 0, y + 1, z + 22, false, 8);
    boroughFloor(c, 0, z, -170);
    flankTowers(c, 0, z, 52, 5, -120);
    ambientProps(c, 0, z);
    return out(c, z + 44, y - 2, rng.range(-0.1, 0.1), Math.min(56, p.speedIn), 'STRUCTURAL FAILURE');
  },
};

// ---------------------------------------------------------------------------
// SET PIECE: VERTICAL SHAFT. A plunge down a reactor shaft: wall-run ribbons, drifting
// fans, flyers to homing-chain off, and a duct slope catching you at the bottom.
// ---------------------------------------------------------------------------
export const shaftDescent: ModuleDef = {
  name: 'shaft', label: 'THE DROP', role: 'redirect', minSpeed: 18, weight: 5, unique: true,
  build(c, p) {
    const rng = c.rng;
    deck(c, 0, 26, 0, 24, 0);
    const depth = rng.range(120, 170);
    const R = 26;
    // Shaft walls as a ring of facades: the silhouette of a huge circular void.
    const seg = 14;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = Math.sin(a) * R, z = 26 + R + Math.cos(a) * R;
      c.slab({ x, y: -depth / 2 + 10, z, w: 13, h: depth + 40, l: 6, yawOffset: -a, kind: 'metal', variant: 'metal' });
    }
    // Descending ledges spiralling down the wall: the intended fast line.
    const steps = Math.floor(depth / 12);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 4;
      const rr = R - 7;
      const x = Math.sin(a) * rr, z = 26 + R + Math.cos(a) * rr;
      const y = -(i / steps) * depth;
      c.slab({ x, y, z, w: 11, h: 1, l: 7, yawOffset: -a, pitch: 0.12, kind: 'metal', variant: 'panel', boost: 1.1 });
      if (i % 3 === 0) c.pickup('fragment', x, y + 2.4, z, true, 1);
      if (i % 4 === 2) c.enemy('flyer', x * 0.4, y + 4, z, true);
      if (i % 5 === 3) c.decor({ x: x * 0.5, y: y + 2, z, w: 8, h: 8, l: 1.4, geo: 'cyl', kind: 'metal', variant: 'duct', pitch: 1.57 });
      c.node(x, y, z, ROUTE_C, 'ground', 14);
    }
    // Bottom: a duct slope that converts the whole descent into exit speed.
    ramp(c, 26 + R, 26 + R + 70, 0, 20, -depth - 4, -depth - 18, 'duct', { boost: 1.28 });
    deck(c, 26 + R + 70, 26 + R + 120, 0, 26, -depth - 18);
    booster(c, 0, -depth - 18, 26 + R + 104);
    c.pickup('time', 0, -depth - 15, 26 + R + 90, false, 6);
    ambientProps(c, 0, 26 + R + 120);
    return out(c, 26 + R + 120, -depth - 18, rng.range(-0.12, 0.12), Math.min(60, p.speedIn * 1.3 + 12), 'THE DROP');
  },
};

// ---------------------------------------------------------------------------
// FINAL ROUTE. The lattice: digital architecture, three converging rails, and the goal
// ring. Fast, loud, and unmistakably the end of the stage.
// ---------------------------------------------------------------------------
export const finalRoute: ModuleDef = {
  name: 'final', label: 'LATTICE APPROACH', role: 'reward', minSpeed: 0, weight: 0,
  build(c, p) {
    const rng = c.rng;
    const L = 300;
    deck(c, 0, 40, 0, 26, 0, 'panel', { boost: 1.1 });
    booster(c, 0, 0, 26);
    // Three converging rails over a digital void.
    for (const lane of [-1, 0, 1]) {
      const pts: number[][] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        pts.push([lane * 14 * (1 - t * 0.85), 4 + Math.sin(t * 3.14) * 6 - t * 6, 46 + (L - 110) * t]);
      }
      c.rail(pts, 1.12, 10);
      c.pickupArc('orb', pts[1], pts[5], 8, 1.5, lane !== 0);
    }
    // Lattice pylons: tall, glowing, repeated with deliberate rhythm.
    for (let z = 50; z < L - 40; z += 44) {
      for (const side of [-1, 1]) {
        c.slab({ x: side * 26, y: 10, z, w: 5, h: 70, l: 5, kind: 'concrete', variant: 'digital' });
        c.decor({ x: side * 20, y: 30, z, w: 14, h: 1, l: 1, kind: 'neon', variant: 'neon' });
      }
      c.decor({ x: 0, y: 44, z, w: 56, h: 1.2, l: 1.2, kind: 'neon', variant: 'neon' });
      if (rng.chance(0.6)) c.enemy(rng.pick(['flyer', 'ranger'] as any), rng.range(-12, 12), 8, z, true);
    }
    deck(c, L - 70, L, 0, 34, -4, 'panel', { boost: 1.12 });
    booster(c, 0, -4, L - 40);
    // GOAL RING: two pylons, a crossbar, and a wall of light. Impossible to misread.
    const gz = L - 8;
    for (const side of [-1, 1]) {
      c.slab({ x: side * 12, y: 10, z: gz, w: 3.4, h: 22, l: 3.4, kind: 'metal', variant: 'metal' });
      c.decor({ x: side * 12, y: 22, z: gz, w: 5, h: 3, l: 5, geo: 'sphere', kind: 'neon', variant: 'neon' });
    }
    c.decor({ x: 0, y: 21, z: gz, w: 27, h: 2.6, l: 1.6, kind: 'neon', variant: 'neon' });
    c.decor({ x: 0, y: 10, z: gz, w: 23, h: 20, l: 0.4, kind: 'glass', variant: 'glass' });
    c.data.goal.copy(c.toWorld(0, 2, gz, new Vector3()));
    c.node(0, -4, gz, ROUTE_C, 'goal', 0);
    boroughFloor(c, 0, L, -200);
    flankTowers(c, 0, L, 60, 6, -160);
    ambientProps(c, 0, L);
    return out(c, L + 40, -4, 0, Math.min(58, p.speedIn), 'LATTICE APPROACH');
  },
};

// ---------------------------------------------------------------------------
// BOSS ARENA. A suspended ring inside the lattice: a central plate, four wall-run
// pylons, an orbiting rail and four bounce pads. The arena is a movement toy, because
// the fight is designed to be won by traversing it.
// ---------------------------------------------------------------------------
export const bossArena: ModuleDef = {
  name: 'boss', label: 'HALCYON WARDEN', role: 'reward', minSpeed: 0, weight: 0,
  build(c, p) {
    const rng = c.rng;
    const R = 74;
    deck(c, 0, 40, 0, 30, 0, 'panel');
    // Main plate, slightly domed by stacking two plates.
    c.slab({ x: 0, y: -1.2, z: 40 + R, w: R * 2, h: 2.4, l: R * 2, kind: 'concrete', variant: 'digital' });
    c.slab({ x: 0, y: -0.2, z: 40 + R, w: R * 1.4, h: 1.2, l: R * 1.4, kind: 'metal', variant: 'panel' });
    // Pylons for wall running, at the diagonals so they never block the fight read.
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
      const x = Math.sin(a) * (R - 16), z = 40 + R + Math.cos(a) * (R - 16);
      c.slab({ x, y: 20, z, w: 10, h: 44, l: 10, yawOffset: -a, kind: 'concrete', variant: 'digital' });
      c.decor({ x, y: 43, z, w: 6, h: 4, l: 6, geo: 'sphere', kind: 'neon', variant: 'neon' });
      bouncePad(c, Math.sin(a) * (R - 40), 0.4, 40 + R + Math.cos(a) * (R - 40), 40);
    }
    // Orbiting rail ring.
    const ring: number[][] = [];
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ring.push([Math.sin(a) * (R - 26), 9 + Math.sin(a * 2) * 3, 40 + R + Math.cos(a) * (R - 26)]);
    }
    c.rail(ring, 1.08, 8);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      c.pickup('health', Math.sin(a) * (R - 34), 2.6, 40 + R + Math.cos(a) * (R - 34), false, 1);
      c.pickup('boost', Math.sin(a + 0.8) * (R - 44), 2.6, 40 + R + Math.cos(a + 0.8) * (R - 44), false, 1);
    }
    c.data.bossCenter.copy(c.toWorld(0, 16, 40 + R, new Vector3()));
    boroughFloor(c, 0, 40 + R * 2, -240);
    for (let i = 0; i < 10; i++) {
      const a = rng.range(0, 6.28);
      c.decor({ x: Math.sin(a) * rng.range(R + 20, R + 90), y: rng.range(-60, 40), z: 40 + R + Math.cos(a) * rng.range(R + 20, R + 90),
        w: rng.range(10, 26), h: rng.range(40, 160), l: rng.range(10, 26), kind: 'concrete', variant: 'digital' });
    }
    ambientProps(c, 0, 40 + R * 2);
    c.node(0, 0, 40 + R, ROUTE_C, 'goal', 0);
    return out(c, 40 + R * 2, 0, 0, 30, 'HALCYON WARDEN');
  },
};
