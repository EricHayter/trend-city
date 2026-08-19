/**
 * EnemyLayout — where the enemies are, decided once, deterministically.
 *
 * The layout is built at construction from a seeded RNG and the finished
 * track, so two runs of the same build place the same enemy in the same metre.
 * That is not a nicety: the capture harness steps the sim at a fixed dt and
 * compares two builds frame for frame, and an encounter that moves between
 * runs makes every comparison worthless.
 *
 * ── ENCOUNTERS, NOT ENEMIES ─────────────────────────────────────────────────
 *
 * Enemies are placed in GROUPS with a shape, never individually, because at
 * 74 m/s the player does not perceive an enemy — they perceive an arrangement.
 * A single drone at 40 m spacing is noise. Two drones abreast is a gate. Four
 * floaters climbing to the left is a route. The group is the unit of design,
 * so it is the unit of code here too.
 *
 * ── SPACING IS A CLOCK, NOT A DISTANCE ──────────────────────────────────────
 *
 * `LAYOUT.spacing` is 55 m, which at top speed is 0.75 s between encounters.
 * That is the fastest cadence a player can actually read. It is not a
 * statement about how dense the mountain looks.
 */

import { Vector3 } from 'three';

import { EnemyKind, ITerrain, ITrack, TrackSampleResult } from '../game/Contracts';
import { Rng } from '../core/RNG';
import { clamp } from '../core/MathX';
import { LAYOUT, PROFILES } from './CombatConstants';

/** One placed enemy, before it becomes an `EnemyState`. */
export interface EnemySpawn {
  kind: EnemyKind;
  /** Distance along the route this enemy belongs to. Drives streaming. */
  routeDistance: number;
  /** Anchor position, world. `EnemyState.position` starts here. */
  position: Vector3;
  /** Initial facing, radians (yaw, +Z forward). */
  facing: number;
  /** Metres of lateral room this enemy may use around its anchor. */
  roam: number;
}

const _p = new Vector3();

/** How far off the centreline a lateral fraction lands, in metres. */
function lateralAt(smp: TrackSampleResult, frac: number): number {
  return smp.halfWidth * LAYOUT.lateralSpread * frac;
}

/**
 * Place one enemy relative to a track sample.
 *
 * `lift` is metres above the ground for hovering kinds; grounded kinds are
 * planted on the heightfield, and clamped so a spawn that lands in a gully
 * beside the trail does not end up ten metres below the line the player is
 * actually travelling on.
 */
function spawnAt(
  terrain: ITerrain,
  smp: TrackSampleResult,
  kind: EnemyKind,
  routeDistance: number,
  lateralFrac: number,
  ahead: number,
  facing: number,
  roam: number,
  out: EnemySpawn[],
): void {
  const prof = PROFILES[kind];
  const lat = lateralAt(smp, lateralFrac);
  const x = smp.position.x + smp.left.x * lat + smp.tangent.x * ahead;
  const z = smp.position.z + smp.left.z * lat + smp.tangent.z * ahead;
  const surfaceY = smp.position.y + smp.tangent.y * ahead;
  let y: number;
  if (prof.grounded) {
    const ground = terrain.heightAt(x, z);
    y = Number.isFinite(ground) ? clamp(ground, surfaceY - 6, surfaceY + 6) : surfaceY;
  } else {
    const ground = terrain.heightAt(x, z);
    const base = Number.isFinite(ground) ? Math.max(ground, surfaceY - 4) : surfaceY;
    y = base + prof.hover;
  }
  out.push({
    kind,
    routeDistance,
    position: new Vector3(x, y, z),
    facing,
    roam,
  });
}

/** Yaw that faces back UP the route — toward an oncoming player. */
function facingUpRoute(smp: TrackSampleResult): number {
  return Math.atan2(-smp.tangent.x, -smp.tangent.z);
}

/**
 * Build the whole roster.
 *
 * Returns spawns ordered by route distance, which the director relies on: the
 * streaming window is then a contiguous index range and activation is two
 * moving cursors rather than a scan of the whole array every step.
 */
export function buildEnemyLayout(
  terrain: ITerrain,
  track: ITrack,
  seed: string,
  maxEnemies: number,
): EnemySpawn[] {
  const rng = new Rng(seed);
  const out: EnemySpawn[] = [];
  const length = track.length;
  const last = length - LAYOUT.tailClearance;
  const wardenDistance = length * LAYOUT.wardenAt;
  let wardenPlaced = false;

  let d = LAYOUT.firstEncounter;
  while (d < last && out.length < maxEnemies) {
    const smp = track.sampleAtDistance(d);
    const t = d / Math.max(1, length);

    // The Warden claims its slot and clears the two either side of it: a
    // miniboss with a drone squabbling at the player's ankles is not a
    // miniboss, it is a mess.
    if (!wardenPlaced && d >= wardenDistance) {
      spawnAt(terrain, smp, EnemyKind.Warden, d, 0, 0, facingUpRoute(smp), 18, out);
      wardenPlaced = true;
      d += LAYOUT.spacing * 2.2;
      continue;
    }

    placeEncounter(terrain, track, rng, smp, d, t, out, maxEnemies);
    d += LAYOUT.spacing + rng.signed() * LAYOUT.spacingJitter;
  }

  out.sort((a, b) => a.routeDistance - b.routeDistance);
  return out;
}

/**
 * One encounter. The template is chosen by route progress so the stage teaches
 * its vocabulary in order — walkers, then the homing staircase, then a shooter,
 * then something that must be gone around, then something that chases.
 */
function placeEncounter(
  terrain: ITerrain,
  track: ITrack,
  rng: Rng,
  smp: TrackSampleResult,
  d: number,
  t: number,
  out: EnemySpawn[],
  maxEnemies: number,
): void {
  const roll = rng.next();
  const face = facingUpRoute(smp);

  // ── Act one: read the lane, then read the air ────────────────────────────
  if (t < 0.18) {
    if (roll < 0.55) {
      spawnAt(terrain, smp, EnemyKind.Drone, d, -0.45, 0, face, 12, out);
      spawnAt(terrain, smp, EnemyKind.Drone, d, 0.5, rng.range(-6, 6), face, 12, out);
    } else {
      floaterChain(terrain, track, rng, d, out, maxEnemies, 4);
    }
    return;
  }

  // ── Act two: a shooter joins, chains get longer ──────────────────────────
  if (t < 0.42) {
    if (roll < 0.32) {
      droneLine(terrain, track, rng, d, out, maxEnemies, 3);
    } else if (roll < 0.68) {
      floaterChain(terrain, track, rng, d, out, maxEnemies, 5);
    } else {
      const side = rng.chance(0.5) ? -1 : 1;
      spawnAt(terrain, smp, EnemyKind.Lancer, d, side * 1.5, 0, face, 20, out);
      spawnAt(terrain, smp, EnemyKind.Drone, d, side * 0.3, 12, face, 12, out);
    }
    return;
  }

  // ── Act three: things that must be gone around ───────────────────────────
  if (t < 0.62) {
    if (roll < 0.34) {
      spawnAt(terrain, smp, EnemyKind.Bulwark, d, rng.range(-0.35, 0.35), 0, face, 6, out);
      spawnAt(terrain, smp, EnemyKind.Drone, d, -0.8, -14, face, 10, out);
      spawnAt(terrain, smp, EnemyKind.Drone, d, 0.8, -14, face, 10, out);
    } else if (roll < 0.62) {
      const side = rng.chance(0.5) ? -1 : 1;
      spawnAt(terrain, smp, EnemyKind.Lancer, d, side * 1.7, 0, face, 24, out);
      spawnAt(terrain, smp, EnemyKind.Lancer, d, side * 1.1, 22, face, 24, out);
    } else {
      floaterChain(terrain, track, rng, d, out, maxEnemies, 5);
    }
    return;
  }

  // ── Act four: the mountain shoots back, and something keeps pace ─────────
  if (roll < 0.3) {
    const side = rng.chance(0.5) ? -1 : 1;
    spawnAt(terrain, smp, EnemyKind.Emplacement, d, side * 1.9, 0, face, 0, out);
  } else if (roll < 0.56) {
    spawnAt(terrain, smp, EnemyKind.Stalker, d, rng.range(-0.5, 0.5), -22, face + Math.PI, 40, out);
  } else if (roll < 0.78) {
    spawnAt(terrain, smp, EnemyKind.Bulwark, d, rng.range(-0.5, 0.5), 0, face, 6, out);
    spawnAt(terrain, smp, EnemyKind.Lancer, d, rng.range(-1.6, 1.6), 26, face, 20, out);
  } else {
    droneLine(terrain, track, rng, d, out, maxEnemies, 4);
  }
}

/**
 * A staircase of floaters climbing away from the trail.
 *
 * This is the shape that makes the homing attack a ROUTE rather than an
 * attack: each hit refreshes the air charges and bounces the player upward, so
 * a chain that rises 3.4 m per 26 m link is exactly followable, and the last
 * link is placed high enough that finishing it puts the player somewhere they
 * could not otherwise have got to.
 */
function floaterChain(
  terrain: ITerrain, track: ITrack, rng: Rng, d: number,
  out: EnemySpawn[], maxEnemies: number, links: number,
): void {
  const side = rng.chance(0.5) ? -1 : 1;
  const step = LAYOUT.floaterChainStep;
  for (let i = 0; i < links && out.length < maxEnemies; i++) {
    const dist = d + i * step;
    if (dist >= track.length - LAYOUT.tailClearance) break;
    const smp = track.sampleAtDistance(dist);
    const lat = side * (0.25 + i * 0.22) * (i % 2 === 0 ? 1 : 0.7);
    const prof = PROFILES[EnemyKind.Floater];
    const latM = lateralAt(smp, lat);
    const x = smp.position.x + smp.left.x * latM;
    const z = smp.position.z + smp.left.z * latM;
    const ground = terrain.heightAt(x, z);
    const base = Number.isFinite(ground) ? Math.max(ground, smp.position.y - 4) : smp.position.y;
    _p.set(x, base + prof.hover + i * LAYOUT.floaterChainRise, z);
    out.push({
      kind: EnemyKind.Floater,
      routeDistance: dist,
      position: _p.clone(),
      facing: facingUpRoute(smp),
      roam: 5,
    });
  }
}

/** Three or four drones staggered down the lane, alternating sides. */
function droneLine(
  terrain: ITerrain, track: ITrack, rng: Rng, d: number,
  out: EnemySpawn[], maxEnemies: number, count: number,
): void {
  const side = rng.chance(0.5) ? -1 : 1;
  for (let i = 0; i < count && out.length < maxEnemies; i++) {
    const dist = d + i * 15;
    if (dist >= track.length - LAYOUT.tailClearance) break;
    const smp = track.sampleAtDistance(dist);
    spawnAt(
      terrain, smp, EnemyKind.Drone, dist,
      side * (i % 2 === 0 ? 0.55 : -0.5), 0,
      facingUpRoute(smp), 12, out,
    );
  }
}
