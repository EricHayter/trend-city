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
 * ── THE THREE ANCHORED VALUES ───────────────────────────────────────────────
 *
 * These are not tuned by feel. They are Spark 3's real numbers and everything
 * else in this table is chosen to be consistent with them:
 *
 *   GRAVITY      36 m/s²   — measured out of Spark 3's own speed readout.
 *   RUN_MAX      74 m/s    — the 185 top running speed, converted.
 *   GROUND_STICK -2.0 m/s  — NOT gravity. A small constant downward velocity
 *                            held while grounded, independent of gravity, which
 *                            is what keeps the character welded to a convex
 *                            slope instead of skipping off every crest. Getting
 *                            this confused with gravity is the single most
 *                            common way a Spark-alike ends up floaty.
 *
 * Consequences worth internalising, because they drive design decisions
 * elsewhere in the project:
 *
 *   • 74 m/s is 266 km/h. The character is 1.8 m tall. This is a hyper-fast
 *     game and the course has to be kilometres long to contain it — which is
 *     why COURSE_SCALE goes back to 1.0 and the whole route is raced.
 *   • At 74 m/s and a 120 Hz physics step the character advances 0.62 m per
 *     step. The heightfield samples every 2 m, so ground following is fine on
 *     a bilinear surface, but anything THIN — a rail, a wall, a spring — must
 *     be tested against the swept segment from the previous position, never
 *     against a point. A point test at this speed tunnels through everything.
 *   • Jump apex is 3.8 m and the whole jump lasts 0.92 s, during which the
 *     character covers 68 m of ground. Platforms are therefore spaced in tens
 *     of metres, not in metres.
 *
 * ── THIS TABLE WAS ONCE CUT TO 20 m/s. IT WAS PUT BACK. ─────────────────────
 *
 * A previous pass cut `RUN.max` to 20 and divided the whole horizontal half of
 * this table by 3.7, because the course was 800 m of truncated BMX track and a
 * 74 m/s character crossed it in 10.8 s. The diagnosis was right and the fix was
 * the wrong half of the mismatch: the speed is Spark 3's real number and the
 * brief is to match Spark exactly, so it is the COURSE that had to grow.
 *
 * It did. `COURSE_SCALE` is 1.0 and `RACE_LENGTH` is the whole route, which is
 * the "level-design job" the old header named as the right fix. Every curve the
 * cut retuned downward has been retuned back UP against 74 rather than reverted
 * blindly, because the original pair really did saturate at a third of top
 * speed: `CAMERA_TUNING.referenceSpeed` and `SPEED_TUNING.lineFloor` /
 * `lineCeiling` now bracket the real range, and the lens buffet stays at the
 * gentler amplitude the cut introduced — that part was a smoothness fix, not a
 * scale one.
 *
 * If the speed ever feels wrong again, the lever is the course, not this table.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Unit bridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * METRES PER SPARK UNIT. The number this whole file hangs off.
 *
 * Spark 3's published values — gravity 36, top running speed 185 display / 74 —
 * are in SPARK units, and they are only self-consistent with each other. Nothing
 * in them says how long a Spark unit is, so mapping them into a world is a choice,
 * and the previous choice here was 1 unit = 1 metre. That is what broke the game.
 *
 * At 1:1 the character runs at 74 m/s under 36 m/s² of gravity, which is 266 km/h
 * under 3.7 Earth gravities, on a mountain built in real metres with a 1.72 m
 * human on it. Every other system in the repository was calibrated against a
 * character doing about 20 m/s and every one of them broke at once:
 *
 *   - `CameraDirector` measured its framing on runs at "70 to 83 km/h" and solves
 *     a 3.05-to-6 m boom. At 74 m/s the character crosses that whole arm in 55 ms,
 *     so the rig cannot hold its subject and the terrain sweep has nothing to
 *     sweep. Its own comment records the reference speed as "20 against a
 *     cut-down 20 m/s table" before it was pushed to 74 to chase this scale.
 *   - `RUN.turnRateHigh` is 2.2 rad/s, so top speed meant a 34 m turning radius
 *     on a trail about 15 m wide. The character could not steer.
 *   - `WorldConstants` records "It was 0.58 while the character ran at 20 m/s".
 *   - `StageDirector.PAR_PACE` is 30 m/s, and an autopilot that only held forward
 *     cleared the 2 km descent in 21 s against a 67 s par.
 *
 * Anchor the mapping on GRAVITY instead — the one constant with a real-world
 * value to match — and the scale falls out: 9.81 / 36 = 0.2725 m per unit. Top
 * running speed becomes 74 * 0.2725 = 20.2 m/s, which is exactly the figure the
 * camera, the track and the layout were all built for. The 20 m/s table those
 * comments describe was right; treating Spark units as metres is what was wrong.
 *
 * The rescale is uniform and preserves Spark's feel exactly. Lengths, velocities
 * and accelerations all carry one factor of this constant; DURATIONS CARRY NONE.
 * Check it: with `a` scaled by k and `v` scaled by k, a time `v/a` is unchanged,
 * so every hang time, coyote window, cooldown and lockout in this file stays at
 * the number Spark uses, and every arc keeps its shape at 0.2725 of its size.
 * Angles and rates (`turnRateLow`, `alignRate`, `slipAngle`) are likewise
 * untouched — which is what shrinks the turning radius by the same factor and
 * hands steering back.
 *
 * Consequently every number still written in this file is SPARK'S OWN NUMBER,
 * wrapped in the converter. `accel: sparkAccel(36)` is Spark's 36. Read the
 * arguments to compare against the game; read the exports to get metres.
 */
export const SPARK_UNIT_METRES = 9.81 / 36;

/** Spark units/s → m/s. */
const sparkSpeed = (units: number): number => units * SPARK_UNIT_METRES;
/** Spark units/s² → m/s². Same factor as speed — see the note above on durations. */
const sparkAccel = (units: number): number => units * SPARK_UNIT_METRES;
/** Spark units → metres. */
const sparkLength = (units: number): number => units * SPARK_UNIT_METRES;

/**
 * Display units per m/s, so the HUD still reads Spark's own speedometer.
 *
 * Spark shows 185 at top speed and 2.5 display units per Spark unit. Top speed is
 * now 20.165 m/s, so the bridge is 2.5 / SPARK_UNIT_METRES and the gauge reads
 * 185 at the top exactly as before. The world moved; the dial did not.
 */
export const SPARK_UNITS_PER_MPS = 2.5 / SPARK_UNIT_METRES;

/** m/s → the number the speedometer shows. */
export const toSparkUnits = (mps: number): number => mps * SPARK_UNITS_PER_MPS;
/** A quoted Spark 3 display value → m/s, for anchoring new values in this file. */
export const fromSparkUnits = (units: number): number => units / SPARK_UNITS_PER_MPS;

// ─────────────────────────────────────────────────────────────────────────────
// Gravity and ground contact
// ─────────────────────────────────────────────────────────────────────────────

export const GRAVITY = {
  /** ANCHORED. m/s². Spark 3's real value. */
  accel: sparkAccel(36.0),

  /**
   * ANCHORED. m/s, applied as a velocity (not an acceleration) while grounded.
   *
   * Spark 3 holds a constant −2.0 on the vertical channel whenever the
   * character is on the floor. It is deliberately independent of `accel`: its
   * job is to keep contact over convex ground, and it must not scale with
   * gravity or the character launches off every ridge at speed.
   */
  groundStick: sparkSpeed(-2.0),

  /** Terminal fall speed. Nothing in Spark 3 falls faster than this. */
  maxFall: sparkSpeed(96.0),

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
  /** ANCHORED. m/s. Spark 3's 185 display units. */
  max: sparkSpeed(74.0),

  /**
   * Hard ceiling on ground speed, m/s. 275 display units.
   *
   * `max` is what the ACCELERATION will take you to. It is not a speed limit,
   * because the whole game is a descent and `SLOPE.accelScale` is 1.0 — a steep
   * gully is supposed to hand you speed you could not have run up to. This is
   * the number that stops a 40-degree face from producing an unrenderable
   * velocity, and nothing else should ever clamp to `max`.
   */
  hardMax: sparkSpeed(110.0),

  /**
   * m/s². Decay applied to ground speed ABOVE `max`.
   *
   * Deliberately far gentler than `friction` (22). A dash ends at 88 m/s and
   * `friction` would spend that back down to 74 in 0.64 s, which throws away
   * the entire point of dashing on the flat. At 6.0 the dash's overspeed
   * survives 2.3 s, long enough to be a routing decision.
   */
  overDecay: sparkAccel(6.0),

  /**
   * The speed the low-gear acceleration hands over to the high-gear one.
   *
   * Spark 3's acceleration is not linear to top speed — it leaves the line
   * hard and then takes a long time over the last third. Two constant-
   * acceleration phases reproduce that shape closely enough to feel identical
   * and stay trivially predictable, which a curve would not.
   */
  gearSpeed: sparkSpeed(30.0),

  /** m/s². Below `gearSpeed`. 0 → 30 m/s in 0.50 s. */
  accelLow: sparkAccel(60.0),
  /** m/s². Above `gearSpeed`. 30 → 74 m/s in 2.44 s. Total 0 → top: 2.94 s. */
  accelHigh: sparkAccel(18.0),

  /**
   * Minimum ground speed a standing start commits to, m/s.
   *
   * Tapping a direction from rest in Spark 3 does not produce a crawl — the
   * character is immediately jogging. Without a floor here, keyboard players
   * spend the first 80 ms of every recovery below walking pace, which reads as
   * unresponsive even though the acceleration number is high. The Reddit
   * thread's one gameplay complaint about a Spark-alike was exactly this.
   */
  floorSpeed: sparkSpeed(11.0),

  /** m/s². Deceleration with no directional input, on the ground. */
  friction: sparkAccel(22.0),

  /** m/s². Holding the opposite direction. Deliberately violent. */
  brake: sparkAccel(90.0),

  /**
   * Yaw rate, rad/s, at rest and at top speed.
   *
   * Turning authority falls off with speed. This is what makes momentum a
   * resource rather than a number: at 74 m/s the character needs 34 m of
   * radius to make a 90° turn, so a corner has to be set up before it arrives.
   * Interpolated on speed / `max`, not on a curve — linear is legible.
   */
  turnRateLow: 12.0,
  turnRateHigh: 2.2,

  /**
   * How sharply velocity is allowed to snap to a new heading below this speed,
   * m/s. Under it the character simply faces where you point — a platformer
   * needs precise footwork at low speed even in a momentum game.
   */
  pivotSpeed: sparkSpeed(16.0),

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
  launchThreshold: sparkSpeed(6.0),

  /**
   * Exponent on the taper that fades slope gain out between `RUN.max` and
   * `RUN.hardMax`. MEASURED, and the number that makes momentum a resource.
   *
   * The along-slope term is `18 * sin(2*theta)` m/s^2 — 9.2 at the 15.4 degree
   * average of this descent, 18 at its steepest. `RUN.overDecay` is a constant
   * 6.0, so with no taper every grade past 9.7 degrees wins that race outright
   * and keeps winning it. An autopilot that only ever held forward proved the
   * consequence: it reached `hardMax` two seconds after the start line and ran
   * the remaining 1990 m pinned there, so the whole 74-to-110 band collapsed to
   * a single number, and no rail, wall or booster could add to a speed that was
   * already at the ceiling.
   *
   * With the taper, gain scales by `(1 - over)^overTaper` where `over` is the
   * position in that band, which gives every grade a terminal speed instead of
   * a ramp to the ceiling. At 3.5, with the corrected unit scale:
   *
   *     grade    terminal          display
   *     25 deg   22.3 m/s (1.10x)  204
   *     35 deg   22.7 m/s (1.12x)  208
   *     45 deg   22.8 m/s (1.13x)  209
   *
   * Deliberately a NARROW spread. Exceeding flat-ground top speed downhill is
   * the whole premise, so the terminal has to sit above `RUN.max` — but the grade
   * should decide how fast you REACH that speed, not how high it is, because a
   * terminal that scales with the grade means the steepest line is always the
   * fastest line and there is no route decision left to make. So gravity alone
   * settles around 205 display and `hardMax`'s 275 belongs to a dash, a booster
   * chain or a slide stacked on top of a good line. The mountain hands you a
   * good speed; the traversal set is how you beat it.
   *
   * The exponent, and not `RUN.overDecay`, carries this on purpose. `overDecay`
   * is Spark's own 6, and its documented job is bleeding a DASH's overspeed on
   * the flat over about two seconds; raising it to hold a slope would take that
   * away. Spark has no descents, so nothing in its table was ever asked to
   * oppose one — this exponent is the term this game has to add for itself.
   *
   * The taper is on the SLOPE term alone, deliberately. Putting the extra decay
   * on `RUN.overDecay` instead would have bled a dash's overspeed away in a
   * second on the flat, and that constant's whole documented purpose is that it
   * does not.
   */
  overTaper: 3.5,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Jumping
// ─────────────────────────────────────────────────────────────────────────────

export const JUMP = {
  /**
   * m/s. Apex 1.03 m, 0.458 s to it, 0.917 s of total airtime.
   *
   * The two times are Spark's exactly and always will be — a duration is `v/a`
   * and both carry one factor of `SPARK_UNIT_METRES`, so the unit fix could not
   * touch them. The HEIGHT is `v^2/2g`, which carries one factor, and it is the
   * number that moved: this read 3.78 m while Spark units were being taken for
   * metres, and 3.78 is what 16.5 and 36 give you in Spark's own units.
   *
   * 1.03 m against a 1.72 m character is a jump to mid-chest — realistic-heroic
   * rather than cartoon-platformer, which is what falls out of pinning gravity
   * to 9.81 and keeping every other Spark number. It is a design choice worth
   * making on purpose rather than inheriting: this is the one knob for it, it
   * disturbs nothing else in the table, and the airtime stays 0.917 s whatever
   * it is set to only if `GRAVITY` moves with it.
   */
  velocity: sparkSpeed(16.5),

  /** m/s. The second jump is SET, not added — a floaty double is not Spark. */
  doubleVelocity: sparkSpeed(14.0),

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
  airAccel: sparkAccel(30.0),
  /** m/s². Air drag with no input. Much lower than ground friction. */
  airFriction: sparkAccel(4.0),

  /**
   * Extra upward velocity added when jumping off a slope, scaled by how much
   * of the surface normal points along travel. Jumping out of a transition
   * should reward having carried speed into it.
   */
  slopeBonus: sparkSpeed(4.0),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Dashes
// ─────────────────────────────────────────────────────────────────────────────

export const DASH = {
  /**
   * m/s the dash SETS speed to — 220 display units. Above `RUN.max`, so a dash
   * is always a gain, and it decays back rather than being clamped away.
   */
  speed: sparkSpeed(88.0),

  /** Seconds of suspended gravity at the start of an air dash. */
  hangTime: 0.14,

  /** m/s². How fast over-max speed bleeds back to `RUN.max`. */
  decay: sparkAccel(26.0),

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
  diveSpeed: sparkSpeed(70.0),
  /** m/s of upward pop the dive impact gives back, if it hits an enemy. */
  diveBounce: sparkSpeed(20.0),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Wall running and wall jumping
// ─────────────────────────────────────────────────────────────────────────────

export const WALL = {
  /** Minimum dot(normal, up) magnitude below which a surface counts as a wall. */
  maxNormalY: 0.40,

  /** m/s of speed into the wall needed to mount it. */
  mountSpeed: sparkSpeed(14.0),

  /** m/s². Reduced gravity while wall running. */
  gravity: sparkAccel(9.0),

  /** Seconds a wall run can last before gravity returns in full. */
  maxTime: 2.2,

  /** m/s². Along-wall acceleration while running it. */
  accel: sparkAccel(34.0),

  /** How strongly the character is held against the wall, m/s. */
  stick: sparkSpeed(3.0),

  /**
   * ADDITIVE upward velocity, m/s.
   *
   * Spark 1 added to the vertical channel; Spark 2 and 3 overwrite it. Additive
   * is the better feel and it is what this uses: chaining wall jumps up a
   * chimney gains height per jump instead of resetting to a fixed rise, which
   * is the whole reason to build a chimney.
   */
  jumpUp: sparkSpeed(15.0),
  /** Ceiling on the additive result, m/s, so a chimney is not a rocket. */
  jumpUpMax: sparkSpeed(26.0),

  /** m/s away from the wall. */
  jumpOut: sparkSpeed(30.0),

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
  minSpeed: sparkSpeed(8.0),
  /** m/s. Mounting below this speed sets you to it — a rail never slows you. */
  mountFloor: sparkSpeed(26.0),

  /**
   * Fraction of along-tangent gravity applied on a rail. 1.0, because a rail
   * down a mountain should be the fastest line available and therefore worth
   * the risk of taking it.
   */
  gravityScale: 1.0,

  /** m/s². Player-driven acceleration along the rail. */
  accel: sparkAccel(20.0),
  /** m/s². Drag along the rail with no input. Low — rails preserve momentum. */
  drag: sparkAccel(3.0),

  /** m/s of upward velocity added when jumping off a rail. */
  jumpUp: sparkSpeed(17.0),

  /** Seconds after dismounting before the same rail can be remounted. */
  lockout: 0.20,

  /** Metres the character's feet ride above the rail's centreline. */
  rideHeight: 0.94,

  /** Lateral m/s the character can shuffle to switch to a parallel rail. */
  switchSpeed: sparkSpeed(9.0),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Sliding
// ─────────────────────────────────────────────────────────────────────────────

export const SLIDE = {
  /** m/s². Friction while sliding. Far below `RUN.friction`. */
  friction: sparkAccel(6.0),
  /** Multiplier on along-slope gravity while sliding. Downhill slides gain. */
  slopeScale: 1.35,
  /** m/s. Below this the slide ends. */
  minSpeed: sparkSpeed(12.0),
  /** Collision hull height while sliding, metres. */
  hullHeight: 0.80,
  /** Seconds of minimum slide, so it cannot be flickered. */
  minTime: 0.18,
  /** m/s of forward pop when jumping out of a slide. */
  jumpBoost: sparkSpeed(6.0),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Homing attack
// ─────────────────────────────────────────────────────────────────────────────

export const HOMING = {
  /** Metres. Lock-on search radius. */
  range: sparkLength(44.0),
  /** Radians. Half-angle of the search cone around the camera forward. */
  coneAngle: 0.95,
  /** m/s the character travels toward the target. */
  speed: sparkSpeed(95.0),
  /** Seconds before a homing attack gives up and drops to a normal fall. */
  maxTime: 0.9,
  /** m/s of upward pop on a successful hit. Refreshes air dash + double jump. */
  bounce: sparkSpeed(18.0),
  /** Metres from the target at which the hit registers. */
  hitRadius: 2.4,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Boost
// ─────────────────────────────────────────────────────────────────────────────

export const BOOST = {
  /** m/s. Raised speed ceiling while boosting — 275 display units. */
  max: sparkSpeed(110.0),
  /** m/s². Acceleration toward `max` while boosting. */
  accel: sparkAccel(55.0),
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
  knockback: sparkSpeed(28.0),
  /** m/s of upward knockback. */
  knockbackUp: sparkSpeed(12.0),
  /** Seconds of lost control after a hit. */
  stunTime: 0.42,
  /** Fraction of speed kept through a hit. Momentum loss IS the punishment. */
  speedKeep: 0.30,
  /** Fall height, metres, above which a landing is "hard" and costs recovery. */
  hardLandHeight: sparkLength(26.0),
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
