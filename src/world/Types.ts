import { Matrix4, Vector3, Quaternion } from 'three';

export type Surface = 'concrete' | 'metal' | 'glass' | 'panel' | 'duct' | 'neon' | 'rail' | 'hazard' | 'digital' | 'foliage' | 'decor';

/**
 * One collision volume: an oriented box. Everything the player can stand on, run
 * along, bounce off or smash is one of these, which keeps the collision solver small
 * enough to stay exact and fast while still allowing ramps, banking and spirals.
 */
export interface Solid {
  id: number;
  center: Vector3;
  half: Vector3;
  quat: Quaternion;
  mat: Matrix4;
  inv: Matrix4;
  radius: number;      // bounding sphere for broadphase rejection
  kind: Surface;
  chunk: number;
  /** Momentum role of the surface: >1 accelerates, <1 drags. */
  boost: number;
  /** Vertical impulse when landed on (bounce pads, tarps, awnings). */
  bounce: number;
  /** Launch impulse along the surface forward axis (ramps handled by slope physics). */
  hazard: boolean;
  breakable: boolean;
  broken: boolean;
  wallrun: boolean;
  grindable: boolean;
  moving: MovingSpec | null;
  collapse: CollapseSpec | null;
}

export interface MovingSpec {
  origin: Vector3;
  axis: Vector3;
  amplitude: number;
  speed: number;
  phase: number;
  mode: 'sine' | 'loop' | 'orbit';
  velocity: Vector3;
}

export interface CollapseSpec {
  delay: number;      // seconds after trigger before it falls
  triggered: boolean;
  timer: number;
  fallSpeed: number;
  spin: number;
}

export interface Rail {
  id: number;
  points: Vector3[];
  lengths: number[];   // cumulative arc length per point
  total: number;
  chunk: number;
  boost: number;
  launchAtEnd: number; // extra upward impulse when leaving the end
}

export type PickupKind = 'fragment' | 'shard' | 'orb' | 'time' | 'boost' | 'health' | 'token';

export interface Pickup {
  id: number;
  kind: PickupKind;
  pos: Vector3;
  taken: boolean;
  chunk: number;
  value: number;
  /** Pickups on risky lines are worth more and are flagged for the results screen. */
  risky: boolean;
  bob: number;
}

export type EnemyKind = 'grunt' | 'flyer' | 'ranger' | 'armored' | 'pursuer' | 'turret' | 'miniboss';

export interface EnemySpawn {
  kind: EnemyKind;
  pos: Vector3;
  chunk: number;
  patrol: number;
  /** Marked when the enemy is placed as a traversal stepping stone on a fast line. */
  traversal: boolean;
}

export type MomentumRole = 'build' | 'preserve' | 'redirect' | 'require' | 'spend' | 'recover' | 'reward' | 'decide';

export interface ModuleResult {
  /** Exit frame for the next module: position, heading, and the height the path is at. */
  exit: { pos: Vector3; heading: number };
  /** Speed the generator believes the player will carry out of this module (m/s). */
  exitSpeed: number;
  /** Path length travelled through the module, used for pacing and the timer budget. */
  distance: number;
  role: MomentumRole;
  label: string;
  /** Route centre lines the validator uses for reachability checks. */
  nodes: TraversalNode[];
}

export interface TraversalNode {
  pos: Vector3;
  /** Minimum speed needed to arrive here from the previous node. */
  requiredSpeed: number;
  /** Which of the left / centre / right lines this node belongs to. */
  route: number;
  kind: 'ground' | 'air' | 'rail' | 'wall' | 'launch' | 'goal';
}
