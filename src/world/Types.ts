/**
 * Types — THE CONTRACT.
 *
 * Every subsystem (generator, modules, physics, combat, camera, HUD, harness)
 * talks through these shapes. Conventions that are not negotiable:
 *
 *  • Y is up. Units are metres. The player is 1.8 m tall.
 *  • A traversal module is authored in LOCAL space with its entry at the origin
 *    and FORWARD = +Z. X is right, Y is up. The floor at the entry is y = 0.
 *  • A module publishes an `exit` frame in its own local space; the assembler
 *    concatenates those frames to lay the stage out, so modules never need to
 *    know where in the world they ended up.
 *  • Collision is a triangle soup with per-triangle surface flags. Modules do
 *    not implement collision; they call Kit helpers which emit both the visual
 *    mesh and the collision triangles from one description.
 */
import type * as THREE from 'three';
import type { Rng } from '../core/Rng';
import type { Biome } from '../render/Palette';

export interface V3 { x: number; y: number; z: number }
export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

/** Per-triangle surface behaviour. Bitmask so a surface can be several things. */
export const SF = {
  SOLID: 1,        // blocks, walkable if the normal allows
  WALLRUN: 2,      // vertical faces the player can run along
  BOUNCE: 4,       // trampoline
  BOOST: 8,        // accelerates on contact
  HAZARD: 16,      // damages
  SLIPPERY: 32,    // low friction (ice-like glass roofs)
  NOGRIND: 64,
  DEATH: 128,      // instant reset to last checkpoint
} as const;
export type SurfaceFlags = number;

/** A grind rail / pipe / wire the player can lock onto. */
export interface RailSpec {
  /** control points in module-local space; the assembler resamples them */
  points: V3[];
  radius?: number;      // lock-on distance, default 1.6
  boost?: number;       // 0..1 extra speed while grinding
  loop?: boolean;
  /** visual style */
  style?: 'rail' | 'wire' | 'pipe' | 'beam' | 'data';
  color?: string;
  /** if set, exiting the end of the rail launches the player */
  launch?: { power: number; up: number };
}

export type VolumeKind =
  | 'checkpoint' | 'boostpad' | 'bounce' | 'launch' | 'death' | 'goal'
  | 'setpiece' | 'transmission' | 'shortcut' | 'camera' | 'zone' | 'arena' | 'wind';

export interface VolumeSpec {
  kind: VolumeKind;
  center: V3;
  half: V3;
  yaw?: number;
  once?: boolean;
  data?: Record<string, unknown>;
}

export type EnemyKind =
  | 'drone'      // basic ground patroller
  | 'floater'    // flying, bobbing, good homing target
  | 'gunner'     // ranged, telegraphed shots
  | 'bulwark'    // armoured, must be broken from behind / by heavy attack
  | 'stalker'    // fast pursuit
  | 'turret'     // environmental, fixed
  | 'sentinel';  // miniboss

export interface EnemySpawn {
  kind: EnemyKind;
  pos: V3;
  yaw?: number;
  /** patrol waypoints in local space, optional */
  patrol?: V3[];
  /** 0..1 — scales health / aggression with stage progress */
  tier?: number;
  /** enemies flagged as gate must die before an arena door opens */
  gate?: boolean;
}

export type PickupKind = 'shard' | 'ring' | 'token' | 'health' | 'boost';
export interface PickupSpawn { kind: PickupKind; pos: V3; value?: number }

/** The intended traversal line through a module, used by the validator + AI. */
export interface RouteSpec {
  name: 'main' | 'left' | 'right' | 'high' | 'low' | 'secret';
  path: V3[];
  /** 0 = safe, 1 = expert-only */
  risk: number;
  /** 0 = nothing, 1 = major shortcut / big reward */
  reward: number;
  /** minimum entry speed the route needs to be possible */
  minSpeed?: number;
}

export interface ModuleExit {
  pos: V3;
  yaw: number;
  /** recommended speed the player will carry out (used for pacing) */
  speed: number;
}

export interface ModuleBuild {
  id: string;
  kind: ModuleKind;
  /** visual root; the Kit bakes world-space vertices, so this group sits at identity */
  group: THREE.Group;
  rails: RailSpec[];
  volumes: VolumeSpec[];
  enemies: EnemySpawn[];
  pickups: PickupSpawn[];
  routes: RouteSpec[];
  exit: ModuleExit;
  /** world-space AABB, for streaming */
  bounds: { min: V3; max: V3 };
  /** loose length along Z, used by the pacing model */
  length: number;
  /** narrative beat this module may fire */
  transmission?: string;
  /** set-piece identifier if this module is one */
  setpiece?: string;
}

export type ModuleKind =
  | 'start' | 'straight' | 'curve' | 'ramp' | 'climb' | 'wallrun' | 'grind'
  | 'gap' | 'arena' | 'tunnel' | 'launch' | 'branch' | 'platforms'
  | 'setpiece' | 'boss' | 'recovery' | 'goal';

export interface ModuleContext {
  rng: Rng;
  biome: Biome;
  /** index in the level sequence */
  index: number;
  /** 0..1 progress through the stage — drives difficulty and density */
  progress: number;
  /** 0..1 difficulty knob independent of progress (set by the grammar) */
  difficulty: number;
  /** speed the player is expected to arrive with, m/s */
  entrySpeed: number;
  /** how wide the previous module's exit was, so we can match up */
  entryWidth: number;
  /** the Kit, injected so modules never import renderer state directly */
  kit: import('./Kit').Kit;
}

export type ModuleFactory = (ctx: ModuleContext) => ModuleBuild;

/** What the assembler produces for the rest of the game. */
export interface StageData {
  seed: string;
  seedNumber: number;
  root: THREE.Group;
  /** module placements in world space, in traversal order */
  placements: Placement[];
  rails: WorldRail[];
  volumes: WorldVolume[];
  enemies: (EnemySpawn & { world: V3 })[];
  pickups: (PickupSpawn & { world: V3 })[];
  /** the full validated centreline through the stage, world space */
  spine: V3[];
  /** total spine length, metres */
  distance: number;
  /** par time in seconds for rank S */
  parTime: number;
  timeLimit: number;
  checkpoints: V3[];
  start: { pos: V3; yaw: number };
  goal: V3;
  bossArena: { center: V3; radius: number } | null;
  zones: { at: number; biome: Biome }[];
  stats: {
    modules: number;
    shortcuts: number;
    validationPasses: number;
    repairs: number;
    tris: number;
    colliderTris: number;
  };
}

export interface Placement {
  build: ModuleBuild;
  /** world transform applied to the module */
  pos: V3;
  yaw: number;
  /** arc distance along the spine at this module's entry */
  s: number;
  /** cached world AABB for streaming */
  min: V3;
  max: V3;
}

export interface WorldRail {
  id: number;
  /** resampled, world-space, even spacing */
  pts: Float32Array;
  n: number;
  total: number;
  seg: number;          // spacing between samples
  radius: number;
  boost: number;
  loop: boolean;
  launch: { power: number; up: number } | null;
}

export interface WorldVolume extends Omit<VolumeSpec, 'center' | 'half'> {
  id: number;
  center: V3;
  half: V3;
  yaw: number;
  fired: boolean;
}
