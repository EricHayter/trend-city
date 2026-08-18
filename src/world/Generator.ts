import { Group, Vector3, Quaternion } from 'three';
import { Rng } from '../core/Rng';
import { MaterialLibrary } from '../render/CelMaterial';
import { DISTRICTS, DistrictStyle } from '../render/Palette';
import { WorldBuilder, WorldStreamer, Chunk } from './Builder';
import { Canvas, WorldData } from './Canvas';
import { ModuleDef, ModuleParams } from './ModuleKit';
import { startPlaza, rooftopRun, downhillSlope, momentumBuild, obstacleCorridor, threeRouteBranch, aerialHoming } from './ModulesTraversal';
import { ventPipes, grindSection, solarSlope, wallrunCanyon, movingSpan, recoveryDeck, streetRun } from './ModulesCity';
import { combatArena, gauntlet, collapseSetpiece, shaftDescent, finalRoute, bossArena } from './ModulesEvent';
import { validateStage, ValidationReport } from './Validator';

export const ALL_MODULES: ModuleDef[] = [
  rooftopRun, downhillSlope, momentumBuild, obstacleCorridor, threeRouteBranch, aerialHoming,
  ventPipes, grindSection, solarSlope, wallrunCanyon, movingSpan, recoveryDeck, streetRun,
  combatArena, gauntlet, collapseSetpiece, shaftDescent,
];

/** District-specific module appetite. This is the level grammar's vocabulary bias. */
const DISTRICT_BIAS: Record<string, Record<string, number>> = {
  residential: { rooftop: 3.0, street: 2.2, downhill: 1.4, obstacle: 1.2, arena: 1.0, recover: 1.0, branch: 1.4 },
  commercial:  { branch: 2.4, wallrun: 2.2, rooftop: 1.6, grind: 1.4, moving: 1.4, solar: 1.2, arena: 1.0 },
  transit:     { grind: 3.0, moving: 2.2, street: 1.6, build: 1.6, branch: 1.2, aerial: 1.2 },
  industrial:  { vents: 3.0, obstacle: 2.0, gauntlet: 1.8, arena: 1.6, collapse: 1.4, grind: 1.0 },
  reactor:     { shaft: 2.6, solar: 2.2, gauntlet: 2.0, aerial: 1.8, wallrun: 1.6, arena: 1.4 },
  digital:     { aerial: 2.4, grind: 2.0, moving: 1.8, gauntlet: 1.6, branch: 1.4 },
};

export interface PlanEntry {
  index: number;
  name: string;
  label: string;
  role: string;
  district: number;
  entrySpeed: number;
  exitSpeed: number;
  distance: number;
  inserted?: boolean;
}

export interface Stage {
  seed: string;
  data: WorldData;
  chunks: Chunk[];
  streamer: WorldStreamer;
  root: Group;
  spawn: Vector3;
  spawnHeading: number;
  goal: Vector3;
  bossCenter: Vector3;
  timeLimit: number;
  plan: PlanEntry[];
  report: ValidationReport;
  chunkDistrict: number[];
  totalDistance: number;
  pickupTotal: number;
  enemyTotal: number;
}

/**
 * THE GENERATOR
 * A stage is a sentence in a small grammar: START, a body assembled under momentum and
 * repetition rules, then FINAL ROUTE and BOSS. The body is not sampled uniformly.
 * Each step:
 *   - filters the vocabulary by the current district's appetite,
 *   - rejects anything the player could not enter at the speed carried in,
 *   - rejects anything used in the last three steps,
 *   - and if a high-speed module is wanted but unreachable, inserts a momentum builder
 *     in front of it rather than dropping it.
 * That last rule is what makes the result read as pacing instead of shuffling.
 */
export function generateStage(seedString: string, lib: MaterialLibrary, opts?: { bodyCount?: number }): Stage {
  const rng = new Rng(seedString);
  const builder = new WorldBuilder(lib);
  const data = new WorldData(builder);
  const bodyCount = (opts && opts.bodyCount) || rng.int(13, 16);

  // --- 1. Compose the module sentence ---------------------------------------
  const sequence: ModuleDef[] = [startPlaza];
  const recent: string[] = [];
  const usedUnique = new Set<string>();
  let speed = 34;
  const grammarRng = rng.fork('grammar');

  for (let i = 0; i < bodyCount; i++) {
    const t = i / bodyCount;
    const district = DISTRICTS[Math.min(DISTRICTS.length - 2, Math.floor(t * (DISTRICTS.length - 1)))];
    const bias = DISTRICT_BIAS[district.key] || {};
    const lastRole = sequence.length ? (sequence[sequence.length - 1] as ModuleDef).role : 'build';

    const entries: [ModuleDef, number][] = [];
    for (const m of ALL_MODULES) {
      if (m.unique && usedUnique.has(m.name)) continue;
      if (recent.includes(m.name)) continue;
      let w = m.weight * (bias[m.name] !== undefined ? bias[m.name] : 0.35);
      if (w <= 0) continue;
      // Pacing rules: breathe after punishment, do not stack two spenders.
      if (lastRole === 'spend' && (m.role === 'spend' || m.role === 'require')) w *= 0.2;
      if (lastRole === 'recover' && m.role === 'recover') w = 0;
      if (lastRole === 'build' && m.role === 'build') w *= 0.35;
      if (m.role === 'require' && t < 0.25) w *= 0.3;
      if (m.role === 'reward' && t < 0.5) w *= 0.4;
      if (m.unique) w *= 0.7 + t;
      entries.push([m, w]);
    }
    if (!entries.length) entries.push([rooftopRun, 1]);
    let choice = grammarRng.weighted(entries);

    // Momentum coherence: never demand speed the previous section could not provide.
    if (choice.minSpeed > speed) {
      const builders = ALL_MODULES.filter((m) => m.role === 'build' && !recent.includes(m.name));
      const feeder = builders.length ? grammarRng.pick(builders) : momentumBuild;
      sequence.push(feeder);
      recent.push(feeder.name);
      if (recent.length > 3) recent.shift();
      speed = Math.max(speed, feeder.minSpeed) * 1.25 + 10;
    }
    sequence.push(choice);
    if (choice.unique) usedUnique.add(choice.name);
    recent.push(choice.name);
    if (recent.length > 3) recent.shift();
    speed = Math.min(62, Math.max(18, speed * 1.02));
  }
  sequence.push(finalRoute, bossArena);

  // --- 2. Lay the modules along a gently curving path ------------------------
  const plan: PlanEntry[] = [];
  const chunkDistrict: number[] = [];
  const nodeRanges: [number, number][] = [];
  const plannedSpeeds: number[] = [];
  const cursor = new Vector3(0, 0, 0);
  let heading = 0;
  let carried = 34;
  let total = 0;

  for (let i = 0; i < sequence.length; i++) {
    const def = sequence[i];
    const t = sequence.length > 1 ? i / (sequence.length - 1) : 0;
    // District walk: start residential, end in the lattice, always in order.
    const dIndex = def.name === 'boss' || def.name === 'final'
      ? DISTRICTS.length - 1
      : Math.min(DISTRICTS.length - 2, Math.floor(t * (DISTRICTS.length - 1)));
    const district = DISTRICTS[dIndex];
    chunkDistrict[i] = dIndex;

    const canvas = new Canvas(data, i, cursor.clone(), heading, district, rng.fork('mod' + i + def.name));
    const nodeStart = data.nodes.length;
    const params: ModuleParams = { speedIn: carried, difficulty: t, index: i, total: sequence.length };
    const result = def.build(canvas, params);
    nodeRanges.push([nodeStart, data.nodes.length]);
    plannedSpeeds.push(carried);

    plan.push({
      index: i, name: def.name, label: result.label, role: def.role, district: dIndex,
      entrySpeed: Math.round(carried), exitSpeed: Math.round(result.exitSpeed), distance: Math.round(result.distance),
    });

    // Distant skyline for this stretch: pure silhouette, no collision, LOD by distance.
    skyline(canvas, result.distance, rng.fork('sky' + i));

    total += result.distance;
    carried = result.exitSpeed;
    cursor.copy(result.exit.pos);
    // Keep the borough from spiralling: turns are damped back toward the main axis.
    heading = result.exit.heading * 0.86;
  }

  // --- 3. Timer budget -------------------------------------------------------
  const est = total / 30;
  const timeLimit = Math.max(120, Math.round((est * 1.55) / 5) * 5);

  // --- 4. Validate, repair, re-validate -------------------------------------
  data.physics.build();
  const report = validateStage(data, plannedSpeeds, nodeRanges, timeLimit);
  // Repairs added collision only; give them a body so the player can see what they land on.
  for (const rep of data.repairs) {
    const nearest = nearestChunk(rep.pos, plan, data);
    const c = new Canvas(data, nearest, rep.pos.clone(), 0, DISTRICTS[chunkDistrict[nearest] || 0], rng.fork('repair'));
    c.decor({ x: 0, y: -0.7, z: 0, w: 14, h: 1.4, l: 14, kind: 'metal', variant: 'panel', outline: true });
  }
  data.physics.build();

  // --- 5. Bake render batches ----------------------------------------------
  const root = new Group();
  const chunks = builder.bake((key) => data.matSpecs.get(key), (c) => chunkDistrict[c] || 0);
  const streamer = new WorldStreamer(chunks, root);
  for (const m of builder.outlineMaterials) lib.all.push(m);

  const spawn = new Vector3(0, 3.2, 6);
  return {
    seed: seedString, data, chunks, streamer, root, spawn, spawnHeading: 0,
    goal: data.goal.clone(), bossCenter: data.bossCenter.clone(), timeLimit, plan, report,
    chunkDistrict, totalDistance: Math.round(total),
    pickupTotal: data.pickups.length, enemyTotal: data.enemies.length,
  };
}

function nearestChunk(pos: Vector3, plan: PlanEntry[], data: WorldData): number {
  let best = 0, bestD = Infinity;
  for (const n of data.nodes) {
    const d = n.pos.distanceToSquared(pos);
    if (d < bestD) { bestD = d; best = 0; }
  }
  // Node list is authored in module order, so find the module whose nodes bracket it.
  let idx = 0;
  let closest = Infinity;
  for (let i = 0; i < data.nodes.length; i++) {
    const d = data.nodes[i].pos.distanceToSquared(pos);
    if (d < closest) { closest = d; idx = i; }
  }
  const frac = data.nodes.length ? idx / data.nodes.length : 0;
  return Math.min(plan.length - 1, Math.floor(frac * plan.length));
}

/**
 * DISTANT SILHOUETTES
 * Two rings of towers with no collision and no outlines, sized up with distance so the
 * horizon reads as layered graphic plates. Far geometry is deliberately coarse: it exists
 * to communicate scale and orientation, never to compete with the playable path.
 */
function skyline(c: Canvas, length: number, rng: Rng) {
  const nearRing = 14;
  for (let i = 0; i < nearRing; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * rng.range(90, 190);
    const z = rng.range(-40, length + 40);
    const h = rng.bell(70, 240, 2);
    c.decor({ x, y: -60 + h / 2, z, w: rng.range(20, 44), h, l: rng.range(20, 44), kind: 'concrete', variant: 'facade' });
  }
  const farRing = 10;
  for (let i = 0; i < farRing; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * rng.range(240, 520);
    const z = rng.range(-120, length + 120);
    const h = rng.bell(140, 420, 2);
    c.decor({ x, y: -120 + h / 2, z, w: rng.range(40, 90), h, l: rng.range(40, 90), kind: 'concrete', variant: 'plain' });
    if (rng.chance(0.3)) c.decor({ x, y: -120 + h + 20, z, w: 4, h: 40, l: 4, geo: 'pole', kind: 'metal', variant: 'metal' });
  }
  // One landmark per stretch, deliberately distinctive and always on the same side of
  // the path within a district so it works as a memory anchor on a replay.
  if (rng.chance(0.55)) {
    const side = rng.sign();
    const x = side * rng.range(150, 260);
    const z = length * rng.range(0.3, 0.7);
    const h = rng.range(320, 520);
    c.decor({ x, y: -100 + h / 2, z, w: 46, h, l: 46, kind: 'concrete', variant: 'facade' });
    c.decor({ x, y: -100 + h + 30, z, w: 8, h: 60, l: 8, geo: 'pole', kind: 'metal', variant: 'metal' });
    c.decor({ x, y: -100 + h + 66, z, w: 16, h: 16, l: 16, geo: 'sphere', kind: 'neon', variant: 'neon' });
    for (let k = 0; k < 3; k++) {
      c.decor({ x, y: -100 + h * rng.range(0.4, 0.9), z, w: 74, h: 3, l: 74, kind: 'metal', variant: 'metal' });
    }
  }
}
