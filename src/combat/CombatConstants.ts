/**
 * CombatConstants — the combat tuning table.
 *
 * Everything the enemy director and its behaviours read is here; nothing in
 * `EnemyDirector.ts` contains a literal. This is the same discipline
 * `SparkConstants.ts` applies to movement, for the same reason: the numbers
 * are the design, and they are only arguable when they are all in one place
 * next to each other.
 *
 * NOTHING IN HERE IS A COLOUR. Colour lives in `src/npr/Palette.ts`.
 *
 * ── THE SPEED CONSTRAINT ────────────────────────────────────────────────────
 *
 * `RUN.max` is 74 m/s. Every range in this file is derived from a TIME, not
 * chosen by eye, because a distance means nothing until it is divided by the
 * speed the player arrives at:
 *
 *   150 m  = 2.0 s of warning at top speed. This is the floor for the range at
 *            which an enemy must be VISIBLE, and it is why the silhouettes in
 *            `EnemyGeometry.ts` are 2.5–8 m rather than person-sized.
 *   220 m  = 3.0 s. What an enemy that has to turn, aim and wind up needs, so
 *            `alertRange` for the shooters sits here.
 *   320 m  = 4.3 s. The streaming horizon: an enemy has to exist and be lit
 *            before the player can possibly see it, so the spawn window is
 *            wider than the visibility requirement, not equal to it.
 *
 * Attack windows are the mirror image. A 0.35 s telegraph is 26 m of travel;
 * anything shorter than about 0.4 s cannot be reacted to at speed at all, so
 * every telegraph here is 0.45 s or longer and the heavy ones are near a
 * second.
 */

import { EnemyKind, AttackKind } from '../game/Contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Streaming and scheduling
// ─────────────────────────────────────────────────────────────────────────────

export const STREAM = {
  /** Metres of route ahead of the player within which enemies are live. */
  ahead: 320,
  /** Metres behind. Short — an enemy the player has passed is spent. */
  behind: 110,
  /**
   * Metres from the player inside which an enemy runs its AI EVERY step.
   * Beyond it the AI runs on a stride (see `farStride`) with the accumulated
   * dt, which is what stops sixty enemies thinking at once at 120 Hz.
   */
  thinkRadius: 170,
  /** One in N steps for a far enemy. 4 → 30 Hz, still far more than enough. */
  farStride: 4,
  /**
   * Steps between the fallback route-distance projection, used only when the
   * host never calls `activate()`. Cheap insurance against a wiring mistake
   * making the whole subsystem silently invisible.
   */
  fallbackProjectEvery: 12,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Layout — where enemies are placed along the route
// ─────────────────────────────────────────────────────────────────────────────

export const LAYOUT = {
  /** Route distance at which the first encounter may sit, metres. */
  firstEncounter: 70,
  /** Metres of route kept clear before the finish. */
  tailClearance: 45,
  /** Mean metres between encounter groups. 55 m ≈ 0.75 s at top speed. */
  spacing: 55,
  /** Uniform jitter applied to the spacing, ± metres. */
  spacingJitter: 14,
  /** Hard ceiling on the pool. */
  maxEnemies: 128,
  /** Lateral offset limit as a multiple of the trail half-width. */
  lateralSpread: 1.35,
  /** Route fraction at which the Warden encounter is placed. */
  wardenAt: 0.72,
  /** Metres a floater chain steps forward between links. */
  floaterChainStep: 26,
  /** Metres a floater chain steps up between links — it is a staircase. */
  floaterChainRise: 3.4,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// The player's attacks, as the enemy side sees them
// ─────────────────────────────────────────────────────────────────────────────

export interface AttackProfile {
  /** Metres the hitbox extends along `direction` beyond the given origin. */
  reach: number;
  /** Extra metres added to the caller's radius. */
  radiusBonus: number;
  /** Metres of vertical band below / above the origin the hitbox covers. */
  below: number;
  above: number;
  damage: number;
  /** Pops the victim into `EnemyPhase.Airborne`. */
  launch: boolean;
  /** Goes through a raised guard. */
  guardBreak: boolean;
  /** m/s of knockback imparted to the victim. */
  knockback: number;
  /** Seconds of hit-stop on a clean hit, before the combo bonus. */
  hitStop: number;
  /** True if the attack sweeps a radius around the player rather than ahead. */
  radial: boolean;
}

const atk = (p: Partial<AttackProfile>): AttackProfile => ({
  reach: 2.4,
  radiusBonus: 0.35,
  below: 1.1,
  above: 1.7,
  damage: 1,
  launch: false,
  guardBreak: false,
  knockback: 12,
  hitStop: 0.055,
  radial: false,
  ...p,
});

/**
 * One profile per `AttackKind`. The player half of the state machine lives in
 * `PlayerPhysics`; this is only what the hit means once it lands.
 */
export const ATTACKS: Record<AttackKind, AttackProfile> = {
  [AttackKind.None]: atk({ damage: 0, reach: 0, hitStop: 0 }),
  [AttackKind.Combo1]: atk({ reach: 2.4, damage: 1, knockback: 10, hitStop: 0.050 }),
  [AttackKind.Combo2]: atk({ reach: 2.7, damage: 1, knockback: 13, hitStop: 0.055 }),
  [AttackKind.Combo3]: atk({ reach: 3.4, damage: 2, knockback: 26, hitStop: 0.085, guardBreak: true }),
  [AttackKind.Aerial]: atk({ reach: 2.8, damage: 1, knockback: 14, hitStop: 0.055, above: 2.1 }),
  /**
   * The dash attack arrives at 88 m/s, so its reach is the one that has to
   * cover a whole step of travel on its own: 0.73 m of step plus the body.
   */
  [AttackKind.DashAttack]: atk({ reach: 4.2, damage: 2, knockback: 30, hitStop: 0.070, guardBreak: true }),
  [AttackKind.Launcher]: atk({ reach: 2.9, damage: 1, knockback: 8, hitStop: 0.090, launch: true, guardBreak: true, above: 2.4 }),
  /** The dive's shockwave. Radial, and the only attack with no direction. */
  [AttackKind.Slam]: atk({ reach: 0, radiusBonus: 7.5, damage: 2, knockback: 18, hitStop: 0.100, launch: true, guardBreak: true, radial: true, below: 2.5, above: 2.5 }),
  [AttackKind.Charged]: atk({ reach: 5.0, radiusBonus: 1.2, damage: 3, knockback: 34, hitStop: 0.130, guardBreak: true }),
};

export const COMBO = {
  /** Seconds the combo stays alive after a hit. */
  window: 2.0,
  /** Extra hit-stop per combo step, seconds, added to the attack's own. */
  hitStopPerStep: 0.006,
  /** Ceiling on total hit-stop, seconds. Two frames at 60 fps is the point. */
  hitStopMax: 0.150,
  /** Hit-stop on a kill, before the combo bonus. */
  killHitStop: 0.110,
  /** Damage multiplier at combo 10 and above. Interpolated linearly from 1. */
  damageScaleMax: 1.6,
  damageScaleAt: 10,
  /**
   * Seconds an enemy cannot be hit again by the player after being hit.
   *
   * Without this an attack whose hitbox is live for 0.2 s lands 24 times at
   * 120 Hz. This is the single most important number in the file for making a
   * combo counter mean anything.
   */
  hitRefractory: 0.16,
  /**
   * Seconds an enemy is excluded from homing target selection after a homing
   * hit, so the chain has to move on instead of ping-ponging on one victim.
   */
  homingLockout: 0.32,
} as const;

export const HOMING_SELECT = {
  /**
   * Seconds of travel added to `HOMING.range` when picking a target.
   *
   * `HOMING.range` is 44 m — 0.59 s at top speed, which is a target that
   * appears and is gone. Adding 0.55 s of the player's CURRENT speed gives
   * 85 m at 74 m/s and leaves the constant untouched at walking pace, so the
   * lock is generous exactly when the speed makes it necessary.
   */
  leadTime: 0.55,
  /** Metres. Never search less than this regardless of speed. */
  minRange: 52,
  /** Metres. Never search more than this — it stops reading as a lock-on. */
  maxRange: 165,
  /**
   * How much of the score an off-axis target pays. `score = distance *
   * (1 + offAxisWeight * angleFraction)`, lowest wins, so a target 30 m ahead
   * beats one 20 m out to the side. Picking the nearest instead makes the
   * lock grab the enemy you already ran past.
   */
  offAxisWeight: 2.6,
  /** Radians of extra cone half-angle granted within `closeRange`. */
  closeConeBonus: 0.55,
  closeRange: 14,
  /**
   * Targets more than this far BELOW the player are still valid — a homing
   * attack down a face is the point — but ones above by more than
   * `maxAbove` are not, or the lock fights the jump arc.
   */
  maxAbove: 26,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Enemy profiles
// ─────────────────────────────────────────────────────────────────────────────

export interface EnemyProfile {
  kind: EnemyKind;
  health: number;
  /** Body capsule radius, metres. */
  radius: number;
  /** Body capsule height above `EnemyState.position`, which is the BASE. */
  height: number;
  /**
   * Metres above the base of the aim point.
   *
   * `PlayerPhysics.stepHoming` steers at `position + (0, 0.9, 0)`, so anything
   * whose body does not span 0.9 m above its base cannot be homed into. Every
   * profile here satisfies that; keep it that way.
   */
  centre: number;
  /** Metres the base floats above the ground. 0 = walks. */
  hover: number;
  /** Gravity and ground-following apply. */
  grounded: boolean;
  /** Anchored to its spawn point — a turret, not a chaser. */
  anchored: boolean;
  /** Valid homing target. */
  targetable: boolean;
  /** Starts with its guard up. */
  guards: boolean;
  /** Launchable by a launcher / slam. Heavies are not. */
  launchable: boolean;
  /** Metres at which it notices the player. See the header on why ≥150. */
  alertRange: number;
  /** Metres at which it commits to its attack. */
  attackRange: number;
  /** Metres beyond which it gives up and returns to idle. */
  loseRange: number;
  /** Seconds of windup. THIS IS THE TELEGRAPH THE PLAYER READS. */
  telegraph: number;
  /** Seconds the attack is live. */
  attackTime: number;
  /** Seconds of recovery — the punish window. */
  recover: number;
  /** Seconds before it may attack again. */
  cooldown: number;
  /** m/s of pursuit. */
  moveSpeed: number;
  /** m/s during the committed attack. */
  attackSpeed: number;
  /** rad/s of turning. */
  turnRate: number;
  /** Damage on body contact while its attack is live. 0 = harmless to touch. */
  contactDamage: number;
  /** Damage of a projectile or shockwave. */
  attackDamage: number;
  /** Seconds of stagger a non-killing hit causes. */
  staggerTime: number;
  /** m/s the body is knocked back per unit of attack knockback. */
  knockScale: number;
  /** Visual scale multiplier applied to the built geometry. */
  scale: number;
  /** Boost meter granted on kill, 0..1. Overrides `BOOST.perKill` when set. */
  boostOnKill: number;
}

const enemy = (p: Partial<EnemyProfile> & Pick<EnemyProfile, 'kind'>): EnemyProfile => ({
  health: 2,
  radius: 1.1,
  height: 2.4,
  centre: 1.2,
  hover: 0,
  grounded: true,
  anchored: false,
  targetable: true,
  guards: false,
  launchable: true,
  alertRange: 165,
  attackRange: 11,
  loseRange: 260,
  telegraph: 0.55,
  attackTime: 0.35,
  recover: 0.6,
  cooldown: 1.1,
  moveSpeed: 20,
  attackSpeed: 34,
  turnRate: 3.2,
  contactDamage: 1,
  attackDamage: 1,
  staggerTime: 0.28,
  knockScale: 1,
  scale: 1,
  boostOnKill: 0.16,
  ...p,
});

/**
 * One profile per kind. Read these as four different QUESTIONS asked of the
 * player, not four different stat blocks:
 *
 *   Drone       — "something is in your lane." Answer: hit it or jump it.
 *   Floater     — "here is a staircase." Answer: chain a homing attack.
 *   Lancer      — "you are being aimed at." Answer: close, or break the lock.
 *   Bulwark     — "not from the front." Answer: go around, or launch it.
 *   Stalker     — "something is matching your speed." Answer: make it commit,
 *                 then punish the overshoot.
 *   Emplacement — "the mountain itself is shooting." Answer: read the sweep
 *                 and cross it during the reload.
 *   Warden      — "the route is closed." Answer: survive the slam, punish the
 *                 recovery, repeat.
 */
export const PROFILES: Record<EnemyKind, EnemyProfile> = {
  [EnemyKind.Drone]: enemy({
    kind: EnemyKind.Drone,
    health: 2,
    radius: 1.0,
    height: 2.6,
    centre: 1.3,
    alertRange: 155,
    attackRange: 10,
    telegraph: 0.50,
    attackTime: 0.32,
    recover: 0.62,
    moveSpeed: 21,
    attackSpeed: 36,
    scale: 1.15,
  }),

  [EnemyKind.Floater]: enemy({
    kind: EnemyKind.Floater,
    health: 1,
    radius: 1.45,
    height: 2.1,
    centre: 1.05,
    hover: 3.4,
    grounded: false,
    anchored: true,
    /** Harmless by design. It is a platform that happens to be alive. */
    contactDamage: 0,
    attackDamage: 0,
    telegraph: 0,
    attackTime: 0,
    alertRange: 200,
    attackRange: 0,
    moveSpeed: 5,
    scale: 1.25,
    boostOnKill: 0.10,
  }),

  [EnemyKind.Lancer]: enemy({
    kind: EnemyKind.Lancer,
    health: 2,
    radius: 1.15,
    height: 3.2,
    centre: 1.7,
    hover: 5.0,
    grounded: false,
    alertRange: 220,
    /** It shoots from range: "attackRange" is where it STOPS approaching. */
    attackRange: 95,
    telegraph: 0.80,
    attackTime: 0.20,
    recover: 0.95,
    cooldown: 2.1,
    moveSpeed: 16,
    contactDamage: 0,
    attackDamage: 1,
    scale: 1.25,
  }),

  [EnemyKind.Bulwark]: enemy({
    kind: EnemyKind.Bulwark,
    health: 3,
    radius: 1.9,
    height: 3.4,
    centre: 1.6,
    guards: true,
    launchable: true,
    alertRange: 170,
    attackRange: 7,
    telegraph: 0.70,
    attackTime: 0.30,
    recover: 1.10,
    moveSpeed: 9,
    attackSpeed: 16,
    turnRate: 1.1,
    contactDamage: 1,
    staggerTime: 1.5,
    knockScale: 0.35,
    scale: 1.35,
    boostOnKill: 0.20,
  }),

  [EnemyKind.Stalker]: enemy({
    kind: EnemyKind.Stalker,
    health: 3,
    radius: 1.15,
    height: 3.0,
    centre: 1.5,
    hover: 1.1,
    grounded: false,
    alertRange: 240,
    attackRange: 16,
    loseRange: 400,
    telegraph: 0.45,
    attackTime: 0.42,
    recover: 0.95,
    cooldown: 1.3,
    /** Fast enough to stay with a running player, not fast enough to catch a dash. */
    moveSpeed: 62,
    attackSpeed: 96,
    turnRate: 2.6,
    contactDamage: 2,
    staggerTime: 0.34,
    scale: 1.2,
    boostOnKill: 0.22,
  }),

  [EnemyKind.Emplacement]: enemy({
    kind: EnemyKind.Emplacement,
    health: 4,
    radius: 2.1,
    height: 6.4,
    centre: 2.6,
    anchored: true,
    guards: true,
    launchable: false,
    /** The tallest thing in the roster, and the earliest read. */
    alertRange: 260,
    attackRange: 150,
    loseRange: 300,
    telegraph: 1.10,
    attackTime: 0.55,
    recover: 0.80,
    cooldown: 1.6,
    moveSpeed: 0,
    turnRate: 1.5,
    contactDamage: 0,
    attackDamage: 1,
    staggerTime: 0.40,
    knockScale: 0,
    scale: 1.0,
    boostOnKill: 0.24,
  }),

  [EnemyKind.Warden]: enemy({
    kind: EnemyKind.Warden,
    health: 12,
    radius: 2.6,
    height: 7.2,
    centre: 3.0,
    guards: true,
    launchable: false,
    alertRange: 280,
    attackRange: 26,
    loseRange: 400,
    telegraph: 0.95,
    attackTime: 0.55,
    /** The whole fight is this window. Long, and unmistakable. */
    recover: 1.70,
    cooldown: 1.4,
    moveSpeed: 13,
    turnRate: 1.4,
    contactDamage: 1,
    attackDamage: 2,
    staggerTime: 0.45,
    knockScale: 0.2,
    scale: 1.0,
    boostOnKill: 0.5,
  }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Attack mechanics that are not per-kind
// ─────────────────────────────────────────────────────────────────────────────

export const PROJECTILE = {
  /** Pool size. Everything is pooled; nothing in a step allocates. */
  max: 64,
  /** m/s for a Lancer's tracking shot. Below `RUN.max` — it can be outrun. */
  lancerSpeed: 58,
  /** rad/s the tracking shot may turn. Loose enough to threaten, not to trap. */
  lancerTurn: 1.25,
  /** Seconds before it expires. */
  lancerLife: 4.0,
  /** m/s for an Emplacement's shell. Slower, heavier, fired in a fan. */
  shellSpeed: 44,
  shellLife: 5.0,
  /** Shells per fan, and the total fan angle in radians. */
  shellCount: 5,
  shellSpread: 0.62,
  /** Collision radius, metres. Generous — these must read as a threat. */
  radius: 0.85,
  /** Metres a projectile may pass below the terrain before it is spent. */
  groundBite: 0.4,
} as const;

export const SHOCKWAVE = {
  /** m/s the Warden's ring expands. 55 m/s is outrunnable but not by much. */
  speed: 55,
  /** Metres at which the ring dies. */
  maxRadius: 30,
  /** Metres of band thickness, for the "did the player cross it" test. */
  thickness: 2.6,
  /** Metres above the ground within which the player is considered grounded. */
  duckHeight: 2.2,
} as const;

export const REACTION = {
  /** Seconds an enemy is frozen when a hit lands, before the combo bonus. */
  hitStopEnemy: 0.075,
  /** m/s of upward pop a launch imparts. */
  launchUp: 17,
  /** Seconds an enemy stays juggleable in the air before falling normally. */
  airborneTime: 1.6,
  /** Seconds a death animation plays before the enemy is retired. */
  dyingTime: 0.55,
  /** Seconds between two damage packets the player may receive. */
  playerDamageCooldown: 0.55,
  /** Metres a guarded hit shoves the attacker's knockback back at them. */
  blockKnock: 6,
} as const;

/** Everything, for the debug overlay and the capture harness to pin. */
export const COMBAT = {
  STREAM,
  LAYOUT,
  ATTACKS,
  COMBO,
  HOMING_SELECT,
  PROFILES,
  PROJECTILE,
  SHOCKWAVE,
  REACTION,
} as const;
