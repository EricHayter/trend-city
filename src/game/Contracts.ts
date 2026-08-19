/**
 * Contracts — the frozen interfaces between subsystems.
 *
 * This file is the architectural spine of the project. Every subsystem is
 * written against these types and nothing else, which is what lets terrain,
 * physics, the rider rig, the AI, the camera and the HUD be developed
 * independently without any of them reaching into another's internals.
 *
 * Rules:
 *  • Nothing in here imports a subsystem. It may import three and core utils.
 *  • Units are SI: metres, seconds, radians, m/s. Not km/h, not degrees.
 *  • +Y is up. The mountain descends toward -Y and (broadly) +Z.
 *  • Any subsystem that renders owns an Object3D and adds it to the scene
 *    itself; the Game never reaches into a subsystem's scene graph.
 */

import type { Object3D, Vector2, Vector3, Quaternion, Camera, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Terrain
// ─────────────────────────────────────────────────────────────────────────────

/** Which material zone a point on the mountain belongs to. */
export enum SurfaceKind {
  Rock = 0,
  Dirt = 1,
  Grass = 2,
  Scree = 3,
  Snow = 4,
  Water = 5,
  /** The groomed trail ribbon. Highest grip, fastest. */
  Trail = 6,
}

/** Grip and rolling behaviour per surface. Consumed by the bike physics. */
export interface SurfaceProperties {
  kind: SurfaceKind;
  /** Lateral grip coefficient. Trail ~1.0, scree ~0.42. */
  grip: number;
  /** Rolling resistance, m/s² of deceleration at 10 m/s. */
  rollingResistance: number;
  /** How much the surface slows you when you plough into it off-line. */
  drag: number;
  /** Dust colour multiplier and emission rate scale. */
  dustAmount: number;
  /** Suspension damping multiplier — rock is harsh, dirt is forgiving. */
  harshness: number;
  /** Audio tone selector for the tyre synth. */
  audioTone: 'hardpack' | 'gravel' | 'grass' | 'rock' | 'water' | 'snow';
}

/** A sample of the mountain at a world XZ position. */
export interface TerrainSample {
  height: number;
  /** Unit surface normal. */
  normal: Vector3;
  /** Steepest-descent slope in radians, 0 = flat. */
  slope: number;
  kind: SurfaceKind;
  surface: SurfaceProperties;
}

export interface ITerrain {
  readonly object: Object3D;
  /** World-space extent of the heightfield. */
  readonly worldSize: number;
  readonly maxHeight: number;

  /** Fast height-only query. Bilinear on the eroded heightmap. */
  heightAt(x: number, z: number): number;
  /** Full sample including normal and surface classification. */
  sampleAt(x: number, z: number, out?: TerrainSample): TerrainSample;
  /** Normal only — cheaper than a full sample. */
  normalAt(x: number, z: number, out?: Vector3): Vector3;
  /** Downhill direction at a point, normalised, XZ-projected. */
  downhillAt(x: number, z: number, out?: Vector3): Vector3;

  /** Raycast straight down from `y`. Returns hit height or null if off-map. */
  raycastDown(x: number, y: number, z: number): number | null;

  /**
   * Called every frame with the camera so the clipmap can re-centre and the
   * scatter systems can stream. Must be cheap — this is on the hot path.
   */
  update(camera: PerspectiveCamera, dt: number): void;

  /** Register a region where the track ribbon has flattened the ground. */
  applyTrackCarve(carve: TrackCarve): void;

  dispose(): void;
}

/** The trail flattens and smooths the terrain along its length. */
export interface TrackCarve {
  /** Sampled centreline points, world space. */
  points: Vector3[];
  /** Half-width of the flattened corridor at each point. */
  halfWidths: number[];
  /**
   * RIDEABLE half-width at each point — what the trail is, as opposed to how
   * wide the ground was flattened around it.
   *
   * `halfWidths` is the flattening reach and is inflated (about 1.22x plus a
   * berm term plus 1.1 m of shoulder), so it cannot be inverted back to the
   * trail's real width. Painting the Trail zone out to a fraction of the
   * INFLATED width left a 1-2 m ring of trail-coloured terrain outside the
   * ribbon mesh all the way down the course — which at the 1-2 degree grazing
   * incidence of a receding trail projects to 30-70 px of torn edge.
   */
  rideWidths?: number[];

  /**
   * Rise of the trail surface per metre of LEFT offset — the y component of the
   * banked surface-left unit vector, which is exactly what the ribbon mesh uses
   * to place its own vertices (`y = centre.y + surfaceLeft.y * lateral`).
   *
   * The carve used to rebuild this from `banks` as `tan(bank)`, and it came out
   * with the OPPOSITE SIGN. That gave the ground a mirror-image camber to the
   * trail drawn on it: measured at 300 m, the ribbon fell 0.672 m to the left
   * across the trail while the heightfield rose 0.613 m, so the two surfaces
   * were 1.285 m apart at the edge of a trail whose half-width is about 3 m.
   * The bike rides the heightfield and the player sees the ribbon, so on one
   * side of every banked corner the drawn trail stood above the rider and cut
   * him off at the chest.
   *
   * Supplying the gradient itself removes the chance to re-derive it wrongly.
   * `banks` remains for anything that wants the angle.
   */
  crossSlopes?: number[];
  /** Bank angle in radians at each point (positive = banked right). */
  banks: number[];
  /** Blend falloff distance beyond the half-width. */
  featherWidth: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Track
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackSampleResult {
  /** Position on the centreline. */
  position: Vector3;
  /** Forward tangent, normalised. */
  tangent: Vector3;
  /** Left-hand normal in the horizontal plane. */
  left: Vector3;
  /** Surface up at this point (accounts for bank). */
  up: Vector3;
  /** Half width of the rideable ribbon here. */
  halfWidth: number;
  /** Bank angle, radians. */
  bank: number;
  /** Signed curvature, 1/m. Positive = turning left. */
  curvature: number;
  /** Distance along the track from the start, metres. */
  distance: number;
  /** Normalised progress 0..1. */
  t: number;
  /** Which named section of the course this is. */
  section: TrackSectionKind;
}

export enum TrackSectionKind {
  TechnicalStart = 'technical-start',
  ScreeRun = 'scree-run',
  Switchbacks = 'switchbacks',
  RockGarden = 'rock-garden',
  Tabletop = 'tabletop',
  RavineGap = 'ravine-gap',
  RidgeSprint = 'ridge-sprint',
  StreamBed = 'stream-bed',
  FinalSprint = 'final-sprint',
}

export interface Checkpoint {
  index: number;
  /** Distance along the track. */
  distance: number;
  position: Vector3;
  /** Gate width, metres. */
  halfWidth: number;
  /** Forward direction through the gate. */
  forward: Vector3;
  isFinish: boolean;
}

export interface ITrack {
  readonly object: Object3D;
  readonly length: number;
  readonly checkpoints: Checkpoint[];

  /** Sample by distance along the centreline, metres. */
  sampleAtDistance(d: number, out?: TrackSampleResult): TrackSampleResult;
  /** Sample by normalised parameter 0..1. */
  sampleAtT(t: number, out?: TrackSampleResult): TrackSampleResult;

  /**
   * Project a world position onto the track.
   * Returns distance along, signed lateral offset (positive = left of centre),
   * and how far above/below the ribbon surface the point is.
   */
  project(
    position: Vector3,
    hintDistance?: number,
  ): { distance: number; lateral: number; vertical: number; sample: TrackSampleResult };

  /** The carve description handed to the terrain. */
  getCarve(): TrackCarve;

  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Player movement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The movement state machine.
 *
 * Every mode is mutually exclusive and the physics reads exactly one branch per
 * step. Modes exist rather than a pile of booleans because the transitions are
 * where the game lives — `Airborne → WallRun` has an entry speed condition, a
 * lockout and an animation blend, and none of that has anywhere to live if
 * "wall running" is a flag on a generic airborne state.
 */
export enum MoveMode {
  /** On the floor. Running, braking, standing, turning. */
  Grounded = 'grounded',
  /** Ballistic. Covers rising, falling, and the post-dash coast. */
  Airborne = 'airborne',
  /** Attached to a near-vertical surface, moving along it. */
  WallRun = 'wall-run',
  /** Attached to a rail spline. */
  Grinding = 'grinding',
  /** Low hull, low friction, gaining on descents. */
  Sliding = 'sliding',
  /** Committed to a dash. Steering is locked for `DASH.lockTime`. */
  Dashing = 'dashing',
  /** Travelling toward a homing-attack target. */
  Homing = 'homing',
  /** Straight-down dive. Resolves into a ground-pound shockwave. */
  Diving = 'diving',
  /** Stunned by damage. No control for `DAMAGE.stunTime`. */
  Hurt = 'hurt',
  /** Past the finish. Physics still runs so the victory run-out looks alive. */
  Finished = 'finished',
}

/** Which traversal affordance the player is currently able to use, for the HUD. */
export enum TraversalPrompt {
  None = 'none',
  Rail = 'rail',
  Wall = 'wall',
  Homing = 'homing',
  Spring = 'spring',
}

/**
 * The full state of the player. Read by the character rig, camera, FX, HUD,
 * audio and the stage director. Nothing else in the game may describe motion.
 *
 * This is the direct replacement for the old `BikeState` and deliberately keeps
 * the field names its consumers already use — `position`, `velocity`, `speed`,
 * `mode`, `boost`, `boosting`, `landedThisStep`, `landingImpact`, `airHeight`
 * — so the camera, dust, speed lines and audio port across by changing a type
 * name rather than by being rewritten.
 */
export interface PlayerState {
  position: Vector3;      // feet, world space
  velocity: Vector3;      // m/s, world
  orientation: Quaternion;
  /** Facing yaw in radians, separate from `orientation` so the rig can lead it. */
  facing: number;

  /** Horizontal speed, m/s. The number the game is about. */
  groundSpeed: number;
  /** Total speed magnitude including vertical, m/s. */
  speed: number;
  /** Signed speed along `facing`. Negative while running backwards. */
  forwardSpeed: number;

  mode: MoveMode;
  /** Seconds spent in the current mode. */
  modeTime: number;
  /** The mode the character was in before this one. Drives animation blends. */
  previousMode: MoveMode;

  /** Surface normal under the feet, or of the wall while wall running. */
  groundNormal: Vector3;
  /** Slerped visual up — never the raw floor normal. See `SLOPE.alignRate`. */
  alignedUp: Vector3;
  /** Signed gradient along travel, radians. Negative = descending. */
  gradient: number;
  /** Surface being stood on, or last stood on while airborne. */
  surface: SurfaceProperties;

  /** Metres to the ground directly below. 0 while grounded. */
  airHeight: number;
  /** Seconds since the character last had a floor. */
  airTime: number;
  /** Peak height above the takeoff point in the current airtime, metres. */
  peakAirHeight: number;
  /** Height the current airtime started at, for fall-damage and hard landings. */
  takeoffHeight: number;

  // ── Charges and cooldowns ─────────────────────────────────────────────────
  /** Double jumps remaining this airtime. */
  jumpsLeft: number;
  /** Air dashes remaining this airtime. */
  dashesLeft: number;
  /** Seconds until the next ground dash is allowed. */
  dashCooldown: number;

  // ── Attachments ───────────────────────────────────────────────────────────
  /** Index into the rail network while `Grinding`, else -1. */
  railIndex: number;
  /** Distance along the attached rail, metres. */
  railDistance: number;
  /** Outward normal of the wall while `WallRun`, else zero. */
  wallNormal: Vector3;
  /** Identity of the wall being run, so the same one cannot be remounted. */
  wallId: number;
  /** Seconds of wall run remaining before gravity returns in full. */
  wallTimeLeft: number;

  // ── Boost ─────────────────────────────────────────────────────────────────
  boost: number;          // 0..1 meter
  boosting: boolean;

  // ── Combat ────────────────────────────────────────────────────────────────
  attack: AttackState;
  health: number;
  /** Seconds of damage immunity remaining. */
  invulnTime: number;
  /** Homing target index, or -1. */
  homingTarget: number;
  /** What the player could do right now, for the HUD's contextual prompt. */
  prompt: TraversalPrompt;

  // ── One-step event flags ──────────────────────────────────────────────────
  /** True for exactly one physics step on touchdown. */
  landedThisStep: boolean;
  /** 0..1 landing severity, valid only on the step `landedThisStep` is true. */
  landingImpact: number;
  /** True when the landing was hard enough to cost recovery time. */
  hardLanding: boolean;
  /** True for exactly one step when a jump leaves the ground. */
  jumpedThisStep: boolean;
  /** True for exactly one step when a dash fires. */
  dashedThisStep: boolean;
  /** True for exactly one step when a wall is mounted. */
  wallMountedThisStep: boolean;
  /** True for exactly one step when a rail is mounted. */
  railMountedThisStep: boolean;
  /** True for exactly one step when damage lands. */
  hurtThisStep: boolean;
  /** Direction the damage came from, world, normalised. */
  hurtDirection: Vector3;
}

/** Everything the player physics needs from the outside world each step. */
export interface PlayerInput {
  /** Desired move direction in CAMERA space, -1..1 each. Magnitude is intent. */
  moveX: number;
  moveZ: number;
  /** Camera yaw the move vector is relative to, radians. */
  cameraYaw: number;

  /** Edge-triggered. Consumed by the physics, which clears it. */
  jump: boolean;
  /** Level. Releasing while rising cuts the jump. */
  jumpHeld: boolean;
  dash: boolean;
  /** Level. Crouch/slide. */
  crouch: boolean;
  attack: boolean;
  /** Level. Boost fires while held and the meter allows. */
  boost: boolean;
  /** Down-dash / dive request. */
  dive: boolean;
}

export interface IPlayer {
  readonly state: PlayerState;
  readonly object: Object3D;

  step(input: PlayerInput, dt: number): void;
  /** Interpolated visual update. `alpha` blends the last two physics states. */
  updateVisual(alpha: number, dt: number, time: number): void;

  /** Apply damage from a world position. Respects invulnerability. */
  damage(amount: number, from: Vector3): boolean;
  /** Refresh air charges — called on a homing hit, rail mount or wall jump. */
  refreshAirCharges(): void;

  reset(position: Vector3, facing: number): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Traversal furniture — rails, walls, springs
// ─────────────────────────────────────────────────────────────────────────────

/** A sample of a grind rail at a distance along it. */
export interface RailSample {
  position: Vector3;
  /** Unit tangent, in the rail's forward direction. */
  tangent: Vector3;
  /** Unit up, for placing the character and banking the rig. */
  up: Vector3;
  distance: number;
  /** Signed gradient along the tangent, radians. Negative = descending. */
  gradient: number;
}

export enum RailKind {
  /** A pipe or cable following the route. The bread and butter. */
  Route = 'route',
  /** A shortcut that leaves the route and rejoins it further down, faster. */
  Shortcut = 'shortcut',
  /** Crosses a gap the player otherwise has to jump. */
  Span = 'span',
  /** Spirals down a vertical drop. */
  Helix = 'helix',
}

export interface RailInfo {
  index: number;
  kind: RailKind;
  length: number;
  /** Track distance at which this rail becomes relevant, for activation. */
  routeDistance: number;
  /** Track distance the rail delivers you to. */
  exitRouteDistance: number;
  /** Both endpoints, world space, for proximity culling. */
  start: Vector3;
  end: Vector3;
}

export interface IRailNetwork {
  readonly object: Object3D;
  readonly rails: RailInfo[];

  /**
   * Find the best rail to mount for a character sweeping from `from` to `to`.
   *
   * Must be a SWEPT test. At 74 m/s a physics step covers 0.62 m and a rail is
   * a few centimetres across; a point-in-radius test misses it in almost every
   * step in which it should have hit.
   */
  findMount(
    from: Vector3,
    to: Vector3,
    velocity: Vector3,
    excludeIndex: number,
  ): { index: number; distance: number; sample: RailSample } | null;

  sampleAt(index: number, distance: number, out?: RailSample): RailSample;
  lengthOf(index: number): number;

  /** Activate/deactivate rail visuals by route progress. */
  update(playerRouteDistance: number, dt: number): void;
  dispose(): void;
}

/** A wall-run surface. */
export interface WallHit {
  id: number;
  /** Outward normal, unit, pointing away from the wall face. */
  normal: Vector3;
  /** Contact point on the wall. */
  point: Vector3;
  /** Unit direction along the wall, chosen to agree with the player's travel. */
  along: Vector3;
  /** Metres of wall remaining ahead along `along`. */
  runLength: number;
}

export interface IWallSet {
  readonly object: Object3D;
  /**
   * Swept probe for a runnable wall. Same tunnelling argument as `findMount`.
   */
  probe(from: Vector3, to: Vector3, velocity: Vector3, excludeId: number): WallHit | null;
  update(playerRouteDistance: number, dt: number): void;
  dispose(): void;
}

export enum BoosterKind {
  /** Launches the player on a fixed arc. */
  Spring = 'spring',
  /** Adds speed along the route without changing direction. */
  Booster = 'booster',
  /** A ring you dash through for a speed gain and a refreshed air dash. */
  DashRing = 'dash-ring',
  /** A ramp that converts speed into height. Geometry, not a trigger. */
  Ramp = 'ramp',
}

export interface BoosterHit {
  kind: BoosterKind;
  /** Velocity to SET (Spring, DashRing) or ADD (Booster), m/s. */
  impulse: Vector3;
  /** True if `impulse` replaces velocity rather than adding to it. */
  absolute: boolean;
  /** Refresh the player's air charges on use. */
  refreshes: boolean;
  position: Vector3;
}

export interface IBoosterField {
  readonly object: Object3D;
  /** Swept test. Returns at most one hit per step. */
  probe(from: Vector3, to: Vector3, velocity: Vector3): BoosterHit | null;
  update(playerRouteDistance: number, dt: number): void;
  dispose(): void;
}

/** Everything traversal, behind one handle the physics can hold. */
export interface ITraversal {
  readonly rails: IRailNetwork;
  readonly walls: IWallSet;
  readonly boosters: IBoosterField;
  readonly object: Object3D;
  update(playerRouteDistance: number, dt: number): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collectibles
// ─────────────────────────────────────────────────────────────────────────────

export enum PickupKind {
  /** The common collectible. Strung along fast lines to reward committing. */
  Fragment = 'fragment',
  /** Rare, hidden, off-route. The reason to explore on a replay. */
  Shard = 'shard',
  /** Restores one health. */
  Cell = 'cell',
  /** Fills the boost meter. */
  Charge = 'charge',
  /** Adds seconds to the stage clock. */
  Time = 'time',
}

export interface PickupEvent {
  kind: PickupKind;
  position: Vector3;
  /** Index in the field, so the stage can mark it taken. */
  index: number;
}

export interface IPickupField {
  readonly object: Object3D;
  readonly totals: Record<PickupKind, number>;
  /** Swept collection test. May return several in one step at speed. */
  collect(from: Vector3, to: Vector3, radius: number, out: PickupEvent[]): number;
  update(playerRouteDistance: number, dt: number, time: number): void;
  reset(): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Combat
// ─────────────────────────────────────────────────────────────────────────────

export enum AttackKind {
  None = 'none',
  /** Ground combo, three hits. */
  Combo1 = 'combo-1',
  Combo2 = 'combo-2',
  Combo3 = 'combo-3',
  /** In-air swipe. */
  Aerial = 'aerial',
  /** Attack out of a dash — carries the dash's speed into the hit. */
  DashAttack = 'dash-attack',
  /** Upward launcher. Pops an enemy into juggle range. */
  Launcher = 'launcher',
  /** The dive's landing shockwave. */
  Slam = 'slam',
  /** Held charge release. */
  Charged = 'charged',
}

export interface AttackState {
  kind: AttackKind;
  /** 0..1 through the active animation. */
  phase: number;
  /** True during the frames the hitbox is live. */
  active: boolean;
  /** Seconds of hit-stop remaining. Freezes the attacker AND the victim. */
  hitStop: number;
  /** Current combo count. Resets on a timeout or a whiff. */
  combo: number;
  /** Seconds left to continue the combo. */
  comboWindow: number;
  /** Held charge, 0..1. */
  charge: number;
}

export enum EnemyKind {
  /** Basic ground walker. */
  Drone = 'drone',
  /** Hovering, drifts across the route, a free homing-attack stepping stone. */
  Floater = 'floater',
  /** Fires tracking shots from a distance. */
  Lancer = 'lancer',
  /** Shielded from the front. Must be hit from behind or launched. */
  Bulwark = 'bulwark',
  /** Chases at speed and will follow the player onto rails. */
  Stalker = 'stalker',
  /** Anchored hazard — a turret or a crusher built into the mountain. */
  Emplacement = 'emplacement',
  /** Miniboss. Blocks the route until beaten. */
  Warden = 'warden',
}

export enum EnemyPhase {
  Idle = 'idle',
  Alert = 'alert',
  Pursue = 'pursue',
  /** Windup. This is the telegraph the player reads. */
  Telegraph = 'telegraph',
  Attack = 'attack',
  Recover = 'recover',
  Stagger = 'stagger',
  /** Popped into the air by a launcher. Juggleable. */
  Airborne = 'airborne',
  Dying = 'dying',
  Dead = 'dead',
}

export interface EnemyState {
  index: number;
  kind: EnemyKind;
  position: Vector3;
  velocity: Vector3;
  facing: number;
  phase: EnemyPhase;
  phaseTime: number;
  health: number;
  maxHealth: number;
  /** True while the front shield is up and absorbing hits. */
  guarding: boolean;
  /** Seconds of hit-stop remaining. */
  hitStop: number;
  /** True while this enemy is a valid homing target. */
  targetable: boolean;
  /** Distance along the route this enemy belongs to, for streaming. */
  routeDistance: number;
  active: boolean;
}

export interface HitEvent {
  enemyIndex: number;
  position: Vector3;
  /** Direction the hit pushed, world, normalised. */
  direction: Vector3;
  damage: number;
  killed: boolean;
  /** Combo count at the moment of the hit, for score and HUD feedback. */
  combo: number;
  /** True if this hit launched the enemy into the air. */
  launched: boolean;
}

export interface IEnemyDirector {
  readonly object: Object3D;
  readonly enemies: EnemyState[];

  /** Fixed step. Runs AI, movement and attack timing. */
  step(player: PlayerState, dt: number): void;
  updateVisual(alpha: number, dt: number, time: number): void;

  /** Resolve the player's live hitbox against every enemy. */
  resolvePlayerAttack(
    origin: Vector3,
    direction: Vector3,
    radius: number,
    kind: AttackKind,
    combo: number,
    out: HitEvent[],
  ): number;

  /** Best homing target for a player looking along `forward`. -1 if none. */
  pickHomingTarget(from: Vector3, forward: Vector3): number;
  /** Register a successful homing hit on a specific enemy. */
  hitTarget(index: number, from: Vector3, out: HitEvent[]): number;

  /** Damage the player should take this step, from contact and projectiles. */
  consumePlayerDamage(): { amount: number; from: Vector3 } | null;

  /** Stream enemies in and out by route progress. */
  activate(playerRouteDistance: number): void;
  reset(): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boss
// ─────────────────────────────────────────────────────────────────────────────

export enum BossPhase {
  Dormant = 'dormant',
  Intro = 'intro',
  Phase1 = 'phase-1',
  Transition = 'transition',
  Phase2 = 'phase-2',
  Enraged = 'phase-3',
  Defeated = 'defeated',
  Outro = 'outro',
}

export interface BossState {
  phase: BossPhase;
  phaseTime: number;
  health: number;
  maxHealth: number;
  /** 0..1 within the current phase's health band, for the HUD's segmented bar. */
  phaseHealth: number;
  position: Vector3;
  /** Name of the attack being wound up or executed, for the telegraph readout. */
  attackName: string | null;
  /** 0..1 telegraph progress. The HUD flashes on this. */
  telegraph: number;
  /** True while a weak point is exposed and damage is possible. */
  vulnerable: boolean;
  /** True while the arena is asking the player to grind, wall run or dash. */
  demandsTraversal: boolean;
  hitStop: number;
}

export interface IBoss {
  readonly object: Object3D;
  readonly state: BossState;
  readonly arenaCentre: Vector3;
  readonly arenaRadius: number;

  begin(): void;
  step(player: PlayerState, dt: number): void;
  updateVisual(alpha: number, dt: number, time: number): void;
  /** Resolve a player attack against the boss. Returns damage dealt. */
  resolvePlayerAttack(origin: Vector3, radius: number, kind: AttackKind, combo: number): HitEvent | null;
  consumePlayerDamage(): { amount: number; from: Vector3 } | null;
  reset(): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Character rig
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The character rig. Owns its skeleton, its meshes and all procedural
 * animation, and is a pure consumer of `PlayerState` — it never drives physics.
 *
 * The contract that matters: the feet must stay planted. A procedural
 * locomotion rig that lets the support foot drift is the single most obvious
 * tell that a character is not really running, and it is worse at speed, not
 * better.
 */
export interface ICharacterRig {
  readonly object: Object3D;
  update(state: PlayerState, dt: number, time: number): void;
  setColors(primary: number, accent: number): void;
  /** World transform of the hand, for anchoring weapon trails and FX. */
  handWorld(side: 'left' | 'right', out: Vector3): Vector3;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────────

export enum StagePhase {
  /** Attract loop behind the title. */
  Title = 'title',
  /** Character introduction / stage select. */
  Intro = 'intro',
  Countdown = 'countdown',
  Running = 'running',
  Boss = 'boss',
  /** Reached the goal. */
  Cleared = 'cleared',
  /** Clock hit zero. */
  Failed = 'failed',
  Results = 'results',
  Paused = 'paused',
}

export enum StageRank {
  S = 'S',
  A = 'A',
  B = 'B',
  C = 'C',
  D = 'D',
}

/** Everything tracked for the results screen. */
export interface StageStats {
  /** Seconds elapsed. */
  time: number;
  /** Seconds left on the clock. */
  timeLeft: number;
  fragments: number;
  fragmentsTotal: number;
  shards: number;
  shardsTotal: number;
  enemiesDefeated: number;
  enemiesTotal: number;
  damageTaken: number;
  /** Peak combo reached. */
  bestCombo: number;
  /** Accumulated style score. */
  styleScore: number;
  /** Shortcuts taken, out of those that exist. */
  shortcuts: number;
  shortcutsTotal: number;
  /** Metres of rail ground and wall run — the traversal-mastery signal. */
  grindDistance: number;
  wallRunDistance: number;
  /** Top speed reached, m/s. */
  topSpeed: number;
  rank: StageRank;
  /** True if the run beat the saved best. */
  isNewBest: boolean;
}

export interface IStageDirector {
  readonly phase: StagePhase;
  readonly stats: StageStats;
  readonly routeDistance: number;
  readonly routeProgress: number;
  begin(): void;
  step(player: PlayerState, dt: number): void;
  restart(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// FX + camera
// ─────────────────────────────────────────────────────────────────────────────

export enum CameraMode {
  Chase = 'chase',
  Cinematic = 'cinematic',
  Replay = 'replay',
  Orbit = 'orbit',
  Free = 'free',
  Fixed = 'fixed',
  /** Framed on the boss, orbiting the arena. */
  Boss = 'boss',
}

export interface ICameraDirector {
  readonly camera: PerspectiveCamera;
  mode: CameraMode;
  /** The yaw the player's move input is relative to. */
  readonly yaw: number;
  /** Called once per rendered frame, after physics. */
  update(target: PlayerState, dt: number, time: number): void;
  /** Kick the camera — landing shake, hit shake, boost punch. */
  shake(amount: number, duration: number): void;
  fovKick(amount: number): void;
  /** Trigger the automatic big-air swing-around. */
  beginAirSwing(duration: number): void;
  /** Frame a set piece or a boss opening. */
  beginCinematic(name: string, duration: number): void;
  snapTo(position: Vector3, lookAt: Vector3): void;
  dispose(): void;
}

export interface IEffects {
  readonly object: Object3D;
  update(dt: number, time: number, camera: Camera): void;
  /** Kick up a burst of cel dust. */
  dustBurst(position: Vector3, normal: Vector3, velocity: Vector3, amount: number, surface: SurfaceProperties): void;
  /** Continuous dust from running feet, a slide, or a grinding rail. */
  dustTrail(position: Vector3, normal: Vector3, velocity: Vector3, rate: number, surface: SurfaceProperties): void;
  /** Sparks off a rail or a parried hit. */
  sparkBurst(position: Vector3, direction: Vector3, amount: number, tint?: number): void;
  /** The anime impact hold: freeze + high-contrast flash for 1–2 frames. */
  impactFrame(intensity: number, tint?: number): void;
  /** Motion smear on a target for a short window. */
  smear(target: Object3D, amount: number): void;
  /** Brief time dilation. Returns to 1.0 over `duration`. */
  slowMotion(scale: number, duration: number): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD + audio
// ─────────────────────────────────────────────────────────────────────────────

export interface HudPopup {
  text: string;
  value: number;
  kind: 'combo' | 'pickup' | 'split' | 'warning' | 'style' | 'story';
}

export interface HudModel {
  phase: StagePhase;
  /** Display units — m/s × 2.5, the number Spark 3 itself shows. */
  speedDisplay: number;
  /** 0..1 of the run's top speed, for the needle and the speed FX. */
  speedFraction: number;
  mode: MoveMode;

  /** Seconds left. The primary objective readout. */
  timeLeft: number;
  /** Seconds elapsed. */
  time: number;
  /** True when the clock is low enough to alarm. */
  timeCritical: boolean;

  health: number;
  maxHealth: number;
  boost: number;
  boosting: boolean;

  combo: number;
  /** 0..1 of the combo window remaining, for the draining ring. */
  comboWindow: number;
  styleScore: number;
  /** Style grade letter shown beside the combo. */
  styleGrade: string;

  fragments: number;
  fragmentsTotal: number;
  shards: number;
  shardsTotal: number;

  /** Progress down the mountain, 0..1. */
  routeProgress: number;
  /** Live route profile for the descent widget. */
  routeProfile: Float32Array;
  /** Current objective line. */
  objective: string;
  /** Contextual traversal prompt. */
  prompt: TraversalPrompt;

  /** Checkpoint splits, with deltas to the saved best. */
  splits: { index: number; time: number | null; delta: number | null }[];
  popups: HudPopup[];

  /** Boss bar. Null when there is no boss. */
  boss: { name: string; phase: BossPhase; health: number; phases: number; telegraph: number } | null;

  /** A line of AI dialogue to type out, or null. */
  transmission: string | null;

  countdown: number | null;
  results: StageStats | null;
  wrongWay: boolean;
}

export interface IHud {
  readonly object: Object3D;
  update(model: HudModel, dt: number, time: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export type MusicIntensity = 'explore' | 'traverse' | 'combat' | 'boss' | 'critical' | 'victory' | 'defeat';

export interface IAudio {
  /** Must be called from a user gesture. */
  unlock(): Promise<void>;
  update(state: PlayerState, surface: SurfaceProperties, dt: number): void;
  playImpact(severity: number, surface: SurfaceProperties): void;
  playJump(doubleJump: boolean): void;
  playDash(air: boolean): void;
  playAttack(kind: AttackKind, combo: number): void;
  playHit(killed: boolean, combo: number): void;
  playRailMount(): void;
  playWallMount(): void;
  playPickup(kind: PickupKind, streak: number): void;
  playStinger(kind: 'boss' | 'phase' | 'clear' | 'fail' | 'shortcut'): void;
  playStartHorn(pitch?: number): void;
  playUi(kind: 'tick' | 'confirm' | 'score' | 'checkpoint' | 'warning'): void;
  /** Cross-fade the procedural score's layers. */
  setMusicIntensity(kind: MusicIntensity): void;
  setMasterVolume(v: number): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Post pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface IPostPipeline {
  /** Runs the whole frame: prepass, shadows, main, lines, bloom, grade. */
  render(scene: Scene, camera: PerspectiveCamera, dt: number, time: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay / ghost
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayFrame {
  t: number;
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  speed: number;
  lean: number;
  steer: number;
  /** Packed flags: grounded, airborne, trick id. */
  flags: number;
}

export interface IReplayRecorder {
  record(t: number, state: PlayerState): void;
  /** The window around the biggest air of the run, for the results replay. */
  getBiggestAir(): { start: number; end: number; peak: number } | null;
  frames: ReplayFrame[];
  clear(): void;
}
