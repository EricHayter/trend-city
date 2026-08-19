/**
 * BossConstants — the boss fight's tuning table.
 *
 * Same rule as `SparkConstants`: this is the only place in `src/boss` a number
 * about the FIGHT is allowed to live. Nothing in `Boss.ts`, `BossAttacks.ts` or
 * `BossRig.ts` contains a gameplay literal.
 *
 * ── EVERYTHING HERE IS DERIVED FROM 74 m/s ──────────────────────────────────
 *
 * `RUN.max` is 74 m/s. That single number decides every other one below, and
 * the derivations are written out because they are not obvious and they are the
 * difference between a fight and a cutscene:
 *
 *  • ARENA RADIUS. A player crossing the arena in under a second cannot be
 *    said to be moving through it. 190 m of radius is 380 m across, which is
 *    5.1 s at top speed and about 8 s at a realistic in-combat pace. That is an
 *    arena. It is also a quarter of the whole 800 m track, which is correct —
 *    this is the climax, not a room at the end of a corridor.
 *
 *  • TELEGRAPH LENGTH. The player closes 74 m every second. A telegraph they
 *    are meant to READ and ANSWER must therefore begin while they are still
 *    ~150 m out, i.e. no shorter than about 2 s. Every windup below is
 *    >= 1.4 s and the openers are 2.0-2.6 s. The Enraged phase shortens them by
 *    `ENRAGE.windupScale`, never below `MIN_WINDUP`.
 *
 *  • HAZARD SPEEDS. A shock ring at 62 m/s is slower than a running player, so
 *    it can be outrun downhill and it cannot be outrun uphill — which is what
 *    makes committing to the descent the correct answer. The beam sweeps at
 *    0.42 rad/s, so its ground speed equals the player's exactly at 176 m and
 *    is beatable inside that: the beam PUSHES THE PLAYER IN, toward the boss,
 *    which is the whole reason it exists.
 *
 *  • WEAK POINT HEIGHTS. A double jump reaches 6.5 m above its takeoff
 *    (JUMP.velocity 16.5 then JUMP.doubleVelocity 14.0 against 36 m/s^2). Every
 *    weak point below is at or under that, because a weak point above the
 *    moveset is a phase the player cannot beat. The fight's difficulty is
 *    CLOSING 190 m through live hazards inside a 2.4 s window, not climbing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The arena
// ─────────────────────────────────────────────────────────────────────────────

export const ARENA = {
  /**
   * Metres past the end of the track ribbon that the arena centre sits.
   *
   * The ribbon stops at 800 m but the mountain keeps falling for two more
   * kilometres, so the arena is built on open ground below the finish. It is
   * pushed down the fall line rather than along the last tangent because the
   * last tangent is a local thing and the fall line is where the player's
   * momentum is actually pointing.
   */
  setback: 210,

  /** Metres. See the header — 5.1 s across at top speed. */
  radius: 190,

  /** Fraction of `radius` the ring of monoliths stands at. */
  wallRingFraction: 0.88,
  monolithCount: 13,
  monolithHeightMin: 26,
  monolithHeightMax: 52,
  /** Radians of inward lean at the top. */
  monolithLean: 0.14,

  /** The uphill dais the boss wakes on. */
  daisFraction: 0.72,
  daisRadius: 46,
  daisHeight: 7.5,
  daisSteps: 3,

  /** Ramps up the arena wall, so the floor is not the only altitude. */
  buttressCount: 4,
  buttressLength: 74,
  buttressHeight: 17,
  buttressWidth: 15,

  /** Low debris ring, purely silhouette. */
  debrisCount: 46,
  debrisRadiusMin: 22,
  debrisRadiusMax: 6,

  /** Metres the boss is kept inside `radius`, so it never leaves the bowl. */
  bossMargin: 40,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// The body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All in metres, in the rig's local space with the feet at y = 0.
 *
 * 20 m is chosen so the SILHOUETTE fills a chase-camera frame from 120 m —
 * far enough out that a 2 s telegraph is still 148 m of the player's approach,
 * close enough that the read is legible.
 */
export const BODY = {
  totalHeight: 20.0,

  hipHeight: 9.4,
  torsoHeight: 6.2,
  shoulderHeight: 15.0,
  headHeight: 17.6,

  torsoHalfWidth: 3.6,
  torsoHalfDepth: 2.6,
  hipHalfWidth: 3.1,

  shoulderOffset: 4.6,
  upperArmLength: 5.4,
  forearmLength: 5.0,
  fistRadius: 1.9,
  armThickness: 1.5,

  thighLength: 5.0,
  shinLength: 4.4,
  footLength: 4.2,
  legThickness: 1.7,
  legSpread: 2.6,

  headRadius: 2.0,
  visorWidth: 3.0,

  /** The dorsal vent bank that opens in phase 2. */
  ventCount: 5,
  ventWidth: 4.6,
  ventDepth: 1.1,
  ventSpacing: 1.15,

  /** The core crystal behind the chest plate. */
  coreRadius: 1.5,

  /** Collision capsule used when the boss body itself is the hazard. */
  bodyRadius: 5.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Health and damage
// ─────────────────────────────────────────────────────────────────────────────

export const HEALTH = {
  /**
   * Total. Three equal bands of 20.
   *
   * A good vulnerability window is ~2.4 s, which is ~9 hits of a three-hit
   * ground combo averaging 0.8, so ~7 damage. Three windows per band, nine per
   * fight, plus the approach and the two transitions puts a clean fight around
   * two minutes — long enough to have an arc, short enough to retry.
   */
  max: 60,
  /** Band boundaries as absolute health, high to low. */
  bandPhase2: 40,
  bandPhase3: 20,

  /** Damage per attack kind, before the combo multiplier. */
  damage: {
    combo1: 0.5,
    combo2: 0.6,
    combo3: 1.0,
    aerial: 0.7,
    dashAttack: 1.2,
    launcher: 0.8,
    slam: 1.6,
    charged: 2.2,
    homing: 1.0,
  },
  /** damage *= 1 + min(combo, comboCap) * comboGain. */
  comboGain: 0.04,
  comboCap: 12,

  /**
   * Seconds one landed hit locks out further damage.
   *
   * The player's attack hitbox is resolved EVERY physics step it is live, so
   * without this a single 0.25 s swing would deal thirty hits. 0.11 s is a
   * shade under the fastest sustainable combo cadence, so nothing a player can
   * actually input is rejected.
   */
  hitLockout: 0.11,

  /** Seconds of hit-stop the boss eats per landed hit, and on a band break. */
  hitStop: 0.055,
  hitStopBreak: 0.18,

  /** Damage the boss does to the player. The player has 5 health. */
  playerDamage: {
    shockRing: 1,
    sweep: 1,
    beam: 1,
    orb: 1,
    pillar: 1,
    body: 1,
    lunge: 2,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Phase framing
// ─────────────────────────────────────────────────────────────────────────────

export const PHASE = {
  /** Seconds the wake-up takes. The camera is on a cinematic through this. */
  introTime: 4.2,
  /** Seconds the armour break between bands takes. Boss is invulnerable. */
  transitionTime: 2.8,
  /** Seconds of collapse. */
  defeatTime: 3.4,
  outroTime: 2.6,

  /**
   * Metres. Inside this the dormant boss wakes on its own, in case the stage
   * director never calls `begin()`. Two seconds of running at top speed.
   */
  autoBeginRange: 150,

  /** Seconds between the end of one move's recovery and the next windup. */
  moveGap: 0.9,
  moveGapEnraged: 0.45,
} as const;

/** Never let `ENRAGE.windupScale` take a telegraph below this. */
export const MIN_WINDUP = 1.35;

export const ENRAGE = {
  windupScale: 0.74,
  /** Hazard speeds multiply by this in the last band. */
  hazardScale: 1.16,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Moves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every move's three-part clock. `windup` is the telegraph and is the only
 * number in this file the player is directly reading; `strike` is the live
 * window; `recover` is the boss's own punish window (distinct from the
 * dedicated vulnerability windows, which are longer and are advertised).
 */
export const MOVES = {
  /**
   * SEISMIC SLAM. Both fists into the cirque floor; an expanding ring of
   * displaced ground.
   *
   * Answered by: jump, double jump, or being outside the ring's reach.
   * Punished by: the fists stay buried, and the wrist core is exposed at 4.0 m.
   */
  slam: {
    name: 'SEISMIC SLAM',
    windup: 2.15,
    strike: 0.20,
    recover: 0.55,
    /** Rings emitted, and the gap between them. */
    rings: 1,
    ringGap: 0,
    ringSpeed: 62,
    /** Metres the ring is dangerous for, radially. */
    ringHalfWidth: 3.4,
    /** Metres above the ground the ring hurts up to. A single jump clears it. */
    ringHeight: 3.2,
    ringMaxRadius: 250,
    /** Seconds the buried-fist weak point stays open. */
    vulnerable: 2.6,
    weakHeight: 4.0,
    weakRadius: 4.4,
  },

  /**
   * SCATTER VOLLEY. A fan of slow, weakly-tracking motes across the approach
   * lane. Individually trivial; the point is that they force the approach to
   * be steered instead of held.
   *
   * Answered by: air dash, or simply running a line.
   */
  volley: {
    name: 'SCATTER VOLLEY',
    windup: 1.55,
    strike: 1.30,
    recover: 0.60,
    count: 9,
    /** Radians of total fan spread. */
    spread: 0.95,
    speed: 46,
    /** Radians per second of lazy tracking. Deliberately beatable. */
    turnRate: 0.55,
    radius: 2.6,
    life: 6.5,
    /** Seconds between motes leaving the hand. */
    interval: 0.14,
  },

  /**
   * ARC SWEEP. A horizontal arm whip across the bowl at chest height.
   *
   * Answered by: SLIDE under it. The hazard band starts at 2.2 m, which is
   * above a standing 1.8 m character and far above an 0.80 m slide hull, and
   * ends at 6.4 m, which a double jump clears with 0.1 m to spare — so both
   * answers exist and the slide is the cheap one.
   */
  sweep: {
    name: 'ARC SWEEP',
    windup: 2.00,
    strike: 0.44,
    recover: 0.85,
    /** Metres of reach from the shoulder pivot. */
    reach: 30,
    radius: 3.2,
    bandLow: 2.2,
    bandHigh: 6.4,
    /** Radians the arm travels during `strike`. */
    arc: 3.05,
  },

  /**
   * BEAM RAKE. A continuous ground-tracking beam from the visor.
   *
   * Answered by: crossing it with an air dash, or closing distance — see the
   * header. The yaw rate is the design, not the damage.
   */
  beam: {
    name: 'BEAM RAKE',
    windup: 2.35,
    strike: 3.20,
    recover: 1.10,
    /** Radians per second the beam can track. Equals 74 m/s at 176 m. */
    turnRate: 0.42,
    /** Metres. Half-width of the scorch line. */
    radius: 3.0,
    length: 260,
    /** Seconds the overheated vents stay open afterwards. */
    vulnerable: 2.45,
    /** The boss drops to all fours; the dorsal core comes down to here. */
    weakHeight: 6.2,
    weakRadius: 5.0,
  },

  /**
   * PILLAR DROP. Slabs torn out of the headwall and dropped on the player.
   *
   * Answered by: keep moving. The warning disc is on the ground for 2.4 s
   * before anything falls, which at 74 m/s is 178 m of escape.
   */
  pillar: {
    name: 'PILLAR DROP',
    windup: 2.40,
    strike: 1.40,
    recover: 0.70,
    count: 4,
    /** Seconds between drops within the strike. */
    interval: 0.34,
    /** Metres the marker leads the player's current position. */
    lead: 46,
    fallSpeed: 74,
    radius: 6.0,
    height: 30,
    /** The impact ring each pillar throws. */
    ringSpeed: 44,
    ringMaxRadius: 60,
    /** Seconds a landed pillar stays standing as scenery and cover. */
    life: 11.0,
  },

  /**
   * PURSUIT LUNGE. The boss charges the fall line.
   *
   * Answered by: DASH (88 m/s) or BOOST (110 m/s). At 84 m/s the lunge is
   * faster than a running player and slower than a dashing one, which makes
   * the dash the answer rather than a luxury.
   * Punished by: it always ends in the arena wall, and it is down for 2.1 s.
   */
  lunge: {
    name: 'PURSUIT LUNGE',
    windup: 1.60,
    strike: 2.60,
    recover: 0.40,
    speed: 84,
    /** m/s^2 up to `speed`. */
    accel: 90,
    radius: 6.5,
    /** Metres above the feet the charging body hurts to. */
    height: 14,
    /** Seconds downed after the crash. */
    vulnerable: 2.10,
    weakHeight: 5.4,
    weakRadius: 5.6,
    /** The ring thrown by the crash. */
    ringSpeed: 70,
    ringMaxRadius: 200,
  },

  /**
   * RING BARRAGE. Three rings at staggered speeds.
   *
   * Answered by: jump, double jump, air dash — in that order, which is the
   * whole air moveset used once each. The speeds are staggered so the gaps
   * open rather than close as they travel.
   */
  barrage: {
    name: 'RING BARRAGE',
    windup: 1.85,
    strike: 1.30,
    recover: 0.75,
    rings: 3,
    ringGap: 0.52,
    /** First ring's speed; each subsequent ring is faster by `ringStep`. */
    ringSpeed: 56,
    ringStep: 9,
    ringHalfWidth: 3.4,
    ringHeight: 3.2,
    ringMaxRadius: 260,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Boss locomotion
// ─────────────────────────────────────────────────────────────────────────────

export const MOTION = {
  /** Radians per second the boss can turn to face the player, per phase. */
  turnRate1: 0.55,
  turnRate2: 0.90,
  turnRate3: 1.30,

  /** m/s the boss strides at in phase 2 and 3. It never has to catch anyone. */
  walkSpeed2: 30,
  walkSpeed3: 42,
  /** m/s^2. */
  walkAccel: 26,

  /**
   * Metres the boss tries to hold from the player.
   *
   * Everything it does reaches further than this, so the standoff is about
   * FRAMING — keeping the whole 20 m silhouette in a chase camera so the
   * telegraph is legible — not about safety.
   */
  standoff2: 96,
  standoff3: 72,
  /** Metres of slack before it bothers repositioning. */
  standoffSlack: 26,

  /** Seconds. Visual damping half-lives for the rig. */
  poseHalfLife: 0.10,
  yawHalfLife: 0.16,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Homing
// ─────────────────────────────────────────────────────────────────────────────

export const HOMING_TARGET = {
  /**
   * Metres. Deliberately wider than `HOMING.range` (44 m) is for enemies,
   * because the weak points of a 20 m boss are large fixed features rather
   * than drifting drones and the player is approaching them at 74 m/s.
   */
  range: 72,
  /** Radians. Half-angle of the search cone. */
  coneAngle: 1.05,
  /** Metres at which the homing dash registers as a hit. */
  hitRadius: 5.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Visual tuning that is not colour
// ─────────────────────────────────────────────────────────────────────────────

export const LOOK = {
  /** Outline hull widths. A 20 m subject wants a heavier stroke than a rider. */
  outlineArmour: 0.022,
  outlineFrame: 0.016,
  outlineCore: 0.020,
  outlineArena: 0.024,
  outlineHazard: 0.014,

  /** Emissive drive on the core, idle to fully telegraphed. */
  coreGlowIdle: 0.18,
  coreGlowTelegraph: 1.0,
  coreGlowVulnerable: 1.35,
  /** Hz of the vulnerable core's pulse. */
  corePulseHz: 3.2,

  /** Vent plate opening angle, radians. */
  ventOpenAngle: 1.15,

  /** Ring mesh: how far it hangs below the hazard band so it stays planted. */
  ringSkirt: 9.0,
  /** Ring opacity at birth and at `ringMaxRadius`. */
  ringFadeStart: 0.92,
  ringFadeEnd: 0.0,

  /** Seconds a beam takes to bloom to full width once it fires. */
  beamRamp: 0.22,
  beamWidth: 2.6,

  /** Scale the whole boss is built at while dormant / after defeat. */
  sinkDepth: 15.0,
} as const;
