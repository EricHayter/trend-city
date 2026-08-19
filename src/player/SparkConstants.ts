/**
 * SparkConstants — the movement tuning table.
 *
 * This file is the heart of the game and the only place a movement number is
 * allowed to live. Everything in `PlayerPhysics` reads from here; nothing in
 * `PlayerPhysics` contains a literal.
 *
 * ── UNITS ───────────────────────────────────────────────────────────────────
 *
 * The simulation runs in SI: metres, seconds, radians, m/s. The HUD does NOT.
 *
 * Spark the Electric Jester 3 displays speed in its own unit, and every value
 * quoted by the community — including the ones this table is anchored to — is
 * quoted in it. The conversion is exactly 2.5 display units per m/s, so the
 * game's famous 185 top running speed is 74 m/s. Both numbers appear below:
 * the metres are what the physics integrates, the display number is what the
 * speedometer reads, and `SPARK_UNITS_PER_MPS` is the only bridge between them.
 *
 * Keeping the sim in SI matters because the terrain, the camera, gravity and
 * the collision hull are all in metres already. Converting the world into
 * Spark units instead would have meant re-deriving the mountain.
 *
 * ── RUN.max IS NO LONGER ANCHORED TO SPARK 3. THIS IS DELIBERATE. ───────────
 *
 * `RUN.max` was 74 m/s — Spark 3's real 185 display units — and this file used
 * to instruct the reader never to change it. It has been cut to 20 m/s, and the
 * whole horizontal half of this table with it (× 0.27). DO NOT PUT IT BACK
 * without also doing the thing the old value actually required.
 *
 * WHY. 74 m/s is Spark 3's number for SPARK 3'S LEVELS. This course is 800 m
 * long, inherited from the DESCENT BMX track. The two were mismatched by about
 * 4×, and the result was measured, not felt:
 *
 *   • The whole stage was crossed in 10.8 s. At `hardMax`, 7.3 s.
 *   • Human reaction time is ~250 ms. At 74 m/s that is 18.5 m of ground —
 *     and this file's own notes demanded an enemy be visible 150 m out, which
 *     is 19% of the entire level.
 *   • A 90° turn at `turnRateHigh` cost 52 m of travel, on a trail whose half
 *     width is 3.7 m. The character was a projectile, not a runner.
 *   • Every inherited camera and FX curve saturated far below the top speed and
 *     sat railed at maximum: `CAMERA_TUNING.referenceSpeed` was 26, so the FOV,
 *     the dolly AND the lens buffet were pinned flat out across 65% of the
 *     speed range — a permanent full-amplitude camera shake with no feedback
 *     left to give. `SPEED_TUNING.lineCeiling` was 24, so the speed lines were
 *     a solid white wall. Cutting the speed to the world's scale brings all of
 *     those back into the range they were authored in, which is why one change
 *     fixed both "too fast" and "not smooth".
 *
 * The alternative was to keep 74 and scale the course to ~3.2 km, re-authoring
 * the terrain carve, the track spline, the checkpoints and every feature
 * position. That remains the option if this project ever wants Spark's true
 * scale, and it is the RIGHT fix — but it is a level-design job, not a tuning
 * one. Choosing it means restoring this table by dividing the horizontal values
 * by 0.27 and re-tuning `referenceSpeed`/`lineCeiling` up rather than down.
 *
 * ── THE TWO VALUES THAT ARE STILL ANCHORED ──────────────────────────────────
 *
 * These are not tuned by feel, they are Spark 3's real numbers, and neither is
 * affected by the horizontal rescale — they describe the VERTICAL channel, and
 * a shorter stride does not change what gravity does:
 *
 *   GRAVITY      36 m/s²   — measured out of Spark 3's own speed readout.
 *   GROUND_STICK -2.0 m/s  — NOT gravity. A small constant downward velocity
 *                            held while grounded, independent of gravity, which
 *                            is what keeps the character welded to a convex
 *                            slope instead of skipping off every crest. Getting
 *                            this confused with gravity is the single most
 *                            common way a Spark-alike ends up floaty.
 *
 * `JUMP.velocity` and `JUMP.doubleVelocity` are unchanged for the same reason,
 * so the jump keeps its 3.8 m apex and its 0.92 s of airtime exactly. What
 * changed is only how much GROUND a jump covers: 68 m before, 18 m now, which
 * is what makes platforms spaced in tens of metres reachable rather than
 * trivially overshot.
 *
 * Consequences worth internalising at the new scale:
 *
 *   • 20 m/s is 72 km/h, 50 display units. Fast for a 1.8 m character on foot,
 *     and about the pace the 800 m descent was authored for.
 *   • At 20 m/s and a 120 Hz physics step the character advances 0.167 m per
 *     step — comfortably inside the 0.42 m hull radius, so `HULL.maxSubstep`
 *     rarely triggers now. It is still correct and still required: `DASH.speed`
 *     and a steep gully can both put the step back up, and anything THIN — a
 *     rail, a wall, a spring — must still be tested against the swept segment
 *     from the previous position, never against a point.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Unit bridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Display units per m/s. Spark 3 shows 185 at a true 74 m/s.
 * The HUD speedometer is the only consumer.
 */
export const SPARK_UNITS_PER_MPS = 2.5;

/** m/s → the number the speedometer shows. */
export const toSparkUnits = (mps: number): number => mps * SPARK_UNITS_PER_MPS;
/** A quoted Spark 3 display value → m/s, for anchoring new values in this file. */
export const fromSparkUnits = (units: number): number => units / SPARK_UNITS_PER_MPS;

// ─────────────────────────────────────────────────────────────────────────────
// Gravity and ground contact
// ─────────────────────────────────────────────────────────────────────────────

export const GRAVITY = {
  /** ANCHORED. m/s². Spark 3's real value. */
  accel: 36.0,

  /**
   * ANCHORED. m/s, applied as a velocity (not an acceleration) while grounded.
   *
   * Spark 3 holds a constant −2.0 on the vertical channel whenever the
   * character is on the floor. It is deliberately independent of `accel`: its
   * job is to keep contact over convex ground, and it must not scale with
   * gravity or the character launches off every ridge at speed.
   */
  groundStick: -2.0,

  /** Terminal fall speed. Nothing in Spark 3 falls faster than this. */
  maxFall: 42.0,

  /**
   * Gravity multiplier while rising with jump still held, vs released.
   *
   * Variable jump height in Spark 3 is a cut on release rather than a gravity
   * change, so this stays at 1.0 in both directions and `JUMP.cutScale` does
   * the work. Kept as a named knob because a 1.0 that is deliberate reads very
   * differently from a 1.0 that nobody considered.
   */
  riseScale: 1.0,
  fallScale: 1.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Ground running
// ─────────────────────────────────────────────────────────────────────────────

export const RUN = {
  /**
   * Top running speed, m/s. 50 display units.
   *
   * WAS 74 (Spark 3's 185), and was marked ANCHORED. Cut to match an 800 m
   * course — see "RUN.max IS NO LONGER ANCHORED" in the file header before
   * changing it, because putting it back requires a longer level, not a smaller
   * diff.
   */
  max: 20.0,

  /**
   * Hard ceiling on ground speed, m/s. 275 display units.
   *
   * `max` is what the ACCELERATION will take you to. It is not a speed limit,
   * because the whole game is a descent and `SLOPE.accelScale` is 1.0 — a steep
   * gully is supposed to hand you speed you could not have run up to. This is
   * the number that stops a 40-degree face from producing an unrenderable
   * velocity, and nothing else should ever clamp to `max`.
   */
  hardMax: 32.0,

  /**
   * m/s². Decay applied to ground speed ABOVE `max`.
   *
   * Deliberately far gentler than `friction` (22). A dash ends at 88 m/s and
   * `friction` would spend that back down to 74 in 0.64 s, which throws away
   * the entire point of dashing on the flat. At 6.0 the dash's overspeed
   * survives 2.3 s, long enough to be a routing decision.
   */
  overDecay: 2.0,

  /**
   * The speed the low-gear acceleration hands over to the high-gear one.
   *
   * Spark 3's acceleration is not linear to top speed — it leaves the line
   * hard and then takes a long time over the last third. Two constant-
   * acceleration phases reproduce that shape closely enough to feel identical
   * and stay trivially predictable, which a curve would not.
   */
  gearSpeed: 8.0,

  /** m/s². Below `gearSpeed`. 0 → 30 m/s in 0.50 s. */
  accelLow: 22.0,
  /** m/s². Above `gearSpeed`. 30 → 74 m/s in 2.44 s. Total 0 → top: 2.94 s. */
  accelHigh: 7.0,

  /**
   * Minimum ground speed a standing start commits to, m/s.
   *
   * Tapping a direction from rest in Spark 3 does not produce a crawl — the
   * character is immediately jogging. Without a floor here, keyboard players
   * spend the first 80 ms of every recovery below walking pace, which reads as
   * unresponsive even though the acceleration number is high. The Reddit
   * thread's one gameplay complaint about a Spark-alike was exactly this.
   */
  floorSpeed: 3.0,

  /** m/s². Deceleration with no directional input, on the ground. */
  friction: 6.0,

  /** m/s². Holding the opposite direction. Deliberately violent. */
  brake: 24.0,

  /**
   * Yaw rate, rad/s, at rest and at top speed.
   *
   * Turning authority falls off with speed. This is what makes momentum a
   * resource rather than a number: at 74 m/s the character needs 34 m of
   * radius to make a 90° turn, so a corner has to be set up before it arrives.
   * Interpolated on speed / `max`, not on a curve — linear is legible.
   */
  turnRateLow: 12.0,
  turnRateHigh: 6.0,

  /**
   * How sharply velocity is allowed to snap to a new heading below this speed,
   * m/s. Under it the character simply faces where you point — a platformer
   * needs precise footwork at low speed even in a momentum game.
   */
  pivotSpeed: 5.0,

  /**
   * Fraction of speed kept through a hard quick-turn (>135° of input change).
   * Spark 3 lets you reverse direction at cost rather than forbidding it.
   */
  quickTurnKeep: 0.45,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Slopes — the momentum core
// ─────────────────────────────────────────────────────────────────────────────

export const SLOPE = {
  /**
   * Fraction of the along-slope gravity component applied while grounded.
   *
   * 1.0 = the real physics. This is the whole game on a mountain: every metre
   * of descent is speed you keep, and the route choice between a steep gully
   * and a safe traverse is a genuine trade. Anything below 1.0 here quietly
   * turns the descent into a corridor with scenery.
   */
  accelScale: 1.0,

  /** Above this gradient (rad) the character cannot hold a standing start. */
  slipAngle: 0.86,

  /**
   * Minimum floor-normal Y the character can stand and run on. cos(58.7 deg).
   *
   * This is the single number that decides what the mountain IS. A platformer
   * value (cos(45 deg) = 0.707) turns most of an eroded alpine heightfield into
   * un-standable wall and the descent becomes a narrow corridor between cliffs.
   * At 0.52 the character runs down almost anything the erosion produced, which
   * is the requested game.
   *
   * Note the deliberate gap between this and `WALL.maxNormalY` (0.40): a face
   * between 0.40 and 0.52 is too steep to run and not steep enough to wall run,
   * so it is a scramble the character slides down. That band is a feature — it
   * is what makes committing to a steep line a real risk.
   */
  walkableNormalY: 0.52,

  /**
   * Rate the visual and the collision hull slerp toward the floor normal,
   * 1/s. Snapping to `get_floor_normal` directly is the documented cause of
   * the jitter this value exists to avoid — the character crosses a 2 m
   * heightfield sample 37 times a second at top speed and the normal steps at
   * every one of them.
   */
  alignRate: 12.0,

  /** Steepest normal the character will align to. Beyond this it stays upright. */
  maxAlign: 0.95,

  /**
   * Launch assist: leaving a convex crest faster than this (m/s of upward
   * surface velocity) converts the slope's vertical component into real
   * airtime instead of being eaten by `groundStick`.
   */
  launchThreshold: 3.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Jumping
// ─────────────────────────────────────────────────────────────────────────────

export const JUMP = {
  /** m/s. Apex 3.78 m, 0.458 s to it, 0.917 s of total airtime. */
  velocity: 16.5,

  /** m/s. The second jump is SET, not added — a floaty double is not Spark. */
  doubleVelocity: 14.0,

  /**
   * Upward velocity is multiplied by this the frame jump is released while
   * still rising. Variable height without touching gravity.
   */
  cutScale: 0.45,

  /** Seconds after leaving the ground a jump still counts as grounded. */
  coyoteTime: 0.09,
  /** Seconds a jump press is remembered while still airborne. */
  bufferTime: 0.12,

  /** m/s². Directional authority in the air. */
  airAccel: 11.0,
  /** m/s². Air drag with no input. Much lower than ground friction. */
  airFriction: 1.5,

  /**
   * Extra upward velocity added when jumping off a slope, scaled by how much
   * of the surface normal points along travel. Jumping out of a transition
   * should reward having carried speed into it.
   */
  slopeBonus: 2.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Dashes
// ─────────────────────────────────────────────────────────────────────────────

export const DASH = {
  /**
   * m/s the dash SETS speed to — 220 display units. Above `RUN.max`, so a dash
   * is always a gain, and it decays back rather than being clamped away.
   */
  speed: 28.0,

  /** Seconds of suspended gravity at the start of an air dash. */
  hangTime: 0.14,

  /** m/s². How fast over-max speed bleeds back to `RUN.max`. */
  decay: 8.0,

  /** Seconds before another ground dash is allowed. */
  groundCooldown: 0.34,

  /**
   * Air dashes per airtime. Refreshed by touching ground, landing a homing
   * attack, mounting a rail, or a wall jump — which is what makes a chain of
   * traversal self-sustaining and a chain of nothing terminal.
   */
  airCharges: 1,

  /** Seconds the dash locks out steering, so it commits to a direction. */
  lockTime: 0.10,

  /**
   * Down-dash (dive / ground pound). m/s straight down. On impact it emits a
   * shockwave that damages and pops nearby enemies.
   */
  diveSpeed: 30.0,
  /** m/s of upward pop the dive impact gives back, if it hits an enemy. */
  diveBounce: 12.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Wall running and wall jumping
// ─────────────────────────────────────────────────────────────────────────────

export const WALL = {
  /** Minimum dot(normal, up) magnitude below which a surface counts as a wall. */
  maxNormalY: 0.40,

  /** m/s of speed into the wall needed to mount it. */
  mountSpeed: 4.0,

  /** m/s². Reduced gravity while wall running. */
  gravity: 9.0,

  /** Seconds a wall run can last before gravity returns in full. */
  maxTime: 2.2,

  /** m/s². Along-wall acceleration while running it. */
  accel: 10.0,

  /** How strongly the character is held against the wall, m/s. */
  stick: 3.0,

  /**
   * ADDITIVE upward velocity, m/s.
   *
   * Spark 1 added to the vertical channel; Spark 2 and 3 overwrite it. Additive
   * is the better feel and it is what this uses: chaining wall jumps up a
   * chimney gains height per jump instead of resetting to a fixed rise, which
   * is the whole reason to build a chimney.
   */
  jumpUp: 15.0,
  /** Ceiling on the additive result, m/s, so a chimney is not a rocket. */
  jumpUpMax: 20.0,

  /** m/s away from the wall. */
  jumpOut: 9.0,

  /**
   * A wall jump leaves at no less than dash speed.
   *
   * The one piece of feedback the Reddit thread's author acted on and then
   * confirmed felt better: "I made the wall jump as fast as dashing and it
   * really does feel better. It really brings out the additive velocity."
   */
  jumpMinSpeed: DASH.speed,

  /**
   * Seconds of input buffer on a wall jump — deliberately generous, again
   * straight from that thread. At 74 m/s a wall passes in a handful of frames
   * and a tight window makes the mechanic feel broken rather than difficult.
   */
  jumpBuffer: 0.18,

  /** Seconds after a wall jump before the SAME wall can be remounted. */
  sameWallLockout: 0.22,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Grinding
// ─────────────────────────────────────────────────────────────────────────────

export const GRIND = {
  /** Metres. How close to a rail the character mounts. */
  snapRadius: 2.6,
  /** Metres of vertical reach for a mount from above. */
  snapHeight: 3.2,

  /** m/s. Minimum speed to hold a rail. Below it you fall off. */
  minSpeed: 2.5,
  /** m/s. Mounting below this speed sets you to it — a rail never slows you. */
  mountFloor: 8.0,

  /**
   * Fraction of along-tangent gravity applied on a rail. 1.0, because a rail
   * down a mountain should be the fastest line available and therefore worth
   * the risk of taking it.
   */
  gravityScale: 1.0,

  /** m/s². Player-driven acceleration along the rail. */
  accel: 6.0,
  /** m/s². Drag along the rail with no input. Low — rails preserve momentum. */
  drag: 1.0,

  /** m/s of upward velocity added when jumping off a rail. */
  jumpUp: 17.0,

  /** Seconds after dismounting before the same rail can be remounted. */
  lockout: 0.20,

  /** Metres the character's feet ride above the rail's centreline. */
  rideHeight: 0.94,

  /** Lateral m/s the character can shuffle to switch to a parallel rail. */
  switchSpeed: 3.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Sliding
// ─────────────────────────────────────────────────────────────────────────────

export const SLIDE = {
  /** m/s². Friction while sliding. Far below `RUN.friction`. */
  friction: 2.0,
  /** Multiplier on along-slope gravity while sliding. Downhill slides gain. */
  slopeScale: 1.35,
  /** m/s. Below this the slide ends. */
  minSpeed: 4.0,
  /** Collision hull height while sliding, metres. */
  hullHeight: 0.80,
  /** Seconds of minimum slide, so it cannot be flickered. */
  minTime: 0.18,
  /** m/s of forward pop when jumping out of a slide. */
  jumpBoost: 2.0,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Homing attack
// ─────────────────────────────────────────────────────────────────────────────

export const HOMING = {
  /** Metres. Lock-on search radius. */
  range: 18.0,
  /** Radians. Half-angle of the search cone around the camera forward. */
  coneAngle: 0.95,
  /** m/s the character travels toward the target. */
  speed: 30.0,
  /** Seconds before a homing attack gives up and drops to a normal fall. */
  maxTime: 0.9,
  /** m/s of upward pop on a successful hit. Refreshes air dash + double jump. */
  bounce: 18.0,
  /** Metres from the target at which the hit registers. */
  hitRadius: 2.4,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Boost
// ─────────────────────────────────────────────────────────────────────────────

export const BOOST = {
  /** m/s. Raised speed ceiling while boosting — 275 display units. */
  max: 32.0,
  /** m/s². Acceleration toward `max` while boosting. */
  accel: 15.0,
  /** Meter units per second consumed while boosting. Meter is 0..1. */
  drain: 0.42,
  /** Meter refilled per enemy defeated. */
  perKill: 0.16,
  /** Meter refilled per second of grinding or wall running. */
  perTraversalSecond: 0.11,
  /** Minimum meter needed to start a boost. Stops single-frame stutter-boosts. */
  minToStart: 0.10,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// The collision hull
// ─────────────────────────────────────────────────────────────────────────────

export const HULL = {
  /** Metres. A capsule: radius plus the height of its cylindrical section. */
  radius: 0.42,
  height: 1.72,
  /** Metres of ledge the character walks up without jumping. */
  stepHeight: 0.55,
  /** Metres of ground probe below the feet when looking for a floor. */
  groundProbe: 0.30,

  /**
   * Maximum metres of travel resolved per collision substep.
   *
   * At 110 m/s a 120 Hz step moves 0.92 m, which is larger than the hull
   * radius — so a single-shot resolve can pass through a wall between two
   * samples. Motion is split into substeps no longer than this before anything
   * is tested. This is not an optimisation; it is the reason the character
   * cannot leave the mountain.
   */
  maxSubstep: 0.35,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Damage and recovery
// ─────────────────────────────────────────────────────────────────────────────

export const DAMAGE = {
  maxHealth: 5,
  /** Seconds of invulnerability after taking a hit. */
  invulnTime: 1.4,
  /** m/s of knockback applied away from the damage source. */
  knockback: 10.0,
  /** m/s of upward knockback. */
  knockbackUp: 12.0,
  /** Seconds of lost control after a hit. */
  stunTime: 0.42,
  /** Fraction of speed kept through a hit. Momentum loss IS the punishment. */
  speedKeep: 0.30,
  /** Fall height, metres, above which a landing is "hard" and costs recovery. */
  hardLandHeight: 26.0,
  /** Seconds of reduced control after a hard landing. */
  hardLandRecovery: 0.30,
} as const;

/**
 * Every tuning group in one object, for the debug overlay's live editor and for
 * the capture harness, which pins these so a recorded clip is comparable across
 * builds even if a number changes underneath it.
 */
export const SPARK = {
  GRAVITY,
  RUN,
  SLOPE,
  JUMP,
  DASH,
  WALL,
  GRIND,
  SLIDE,
  HOMING,
  BOOST,
  HULL,
  DAMAGE,
} as const;
