/**
 * PlayerSignals — the handful of derived readings the FX layer used to get for
 * free from the bike, restated against `PlayerState`.
 *
 * The old `BikeState` published two `WheelState` contacts, an
 * `angularVelocity` and a `crashSeverity`/`crashDirection` pair, and every
 * effect in this subsystem was authored against them: dust came out of a wheel
 * contact patch, the air swing orbited against the frame's spin, and a wreck
 * sized its debris from the solver's own severity number.
 *
 * A running character has none of those. It has ONE contact — `position` IS the
 * feet — a scalar `facing` rather than a rotation vector, and a `Hurt` mode
 * with no severity attached. Rather than scatter the same four reconstructions
 * across `index.ts`, `CameraDirector.ts` and `SpeedFX.ts`, they live here, once,
 * with the reasoning attached.
 *
 * Nothing here allocates. The two vector helpers write into a caller-supplied
 * `out`, and `YawRateTracker` holds two numbers.
 */

import type { Vector3 } from 'three';

import { MoveMode, type ITerrain, type PlayerState } from '../game/Contracts';

export const SIGNAL_TUNING = {
  /**
   * Metres of clearance still counted as a contact.
   *
   * `airHeight` is measured to the terrain under the feet and is exactly 0 only
   * while the physics calls the character grounded. A body sliding through a
   * `Hurt` tumble is repeatedly a few centimetres clear of the ground it is
   * scraping along, and treating that as "no contact" is what left the old
   * crash sequence dustless for its whole length.
   */
  contactEps: 0.06,

  /**
   * m/s at which a hit is read as maximally severe.
   *
   * The bike's physics published its own `crashSeverity`; the player physics
   * publishes a mode and a health count and nothing else, so severity is
   * reconstructed from the speed carried into the hit. 55 m/s rather than
   * `RUN.max` (74): by the time a hit lands the knockback has already replaced
   * the velocity, so what is being measured is a knockback speed, not a run.
   */
  hurtSpeedFull: 55.0,

  /** Floor under a reconstructed severity, so every hit still punctuates. */
  hurtSeverityFloor: 0.45,
} as const;

/**
 * Whether the feet are on the ground this frame.
 *
 * Replaces `!!(s.rear?.grounded || s.front?.grounded)`. The first two modes are
 * the only ones `PlayerPhysics` can be in while it calls itself grounded, and a
 * ground dash is the third — it zeroes `airHeight` where an air dash does not.
 * Everything else falls through to the height test, which is what makes this
 * correct during `Hurt`, the one mode that can be either.
 *
 * `Grinding` and `WallRun` are deliberately NOT contacts. The character is
 * attached to a rail or a wall, not standing on the mountain, and the terrain
 * under it is irrelevant — see `isAttached` for the test those want.
 */
export function isGrounded(s: PlayerState): boolean {
  if (s.mode === MoveMode.Grounded || s.mode === MoveMode.Sliding) return true;
  if (s.mode === MoveMode.Grinding || s.mode === MoveMode.WallRun) return false;
  return s.airHeight <= SIGNAL_TUNING.contactEps;
}

/** Grounded, or held onto a rail or a wall. Anything but genuinely ballistic. */
export function isAttached(s: PlayerState): boolean {
  return (
    s.mode === MoveMode.Grinding || s.mode === MoveMode.WallRun || isGrounded(s)
  );
}

/**
 * The point effects should be emitted from: the contact patch under the feet.
 *
 * `position` is the feet, so while grounded it IS the contact. Airborne it is
 * wherever the body happens to be, and an effect emitted there hangs in space —
 * so the terrain is probed and the ground below is used instead, which is the
 * same fallback the wheel version made when a contact had not been filled in.
 */
export function contactPoint(
  s: PlayerState,
  terrain: ITerrain | null,
  out: Vector3,
): Vector3 {
  out.copy(s.position);
  if (!isGrounded(s) && terrain) {
    out.y = terrain.heightAt(s.position.x, s.position.z);
  }
  return out;
}

/**
 * 0..1 severity for a hit, reconstructed from the speed it happened at.
 *
 * Consumed exactly where `crashSeverity` was: the size of the debris throw, the
 * amplitude of the shake, and whether the hit earns a slow-motion hold.
 */
export function hurtSeverity(s: PlayerState): number {
  const fromSpeed = Math.min(1, s.speed / SIGNAL_TUNING.hurtSpeedFull);
  const v = SIGNAL_TUNING.hurtSeverityFloor + fromSpeed * (1 - SIGNAL_TUNING.hurtSeverityFloor);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * d(facing)/dt in rad/s, which is the player's stand-in for the bike's
 * `angularVelocity.y`.
 *
 * The character's only rotational channel is `facing`, a scalar the physics
 * rewrites every step, so the rate has to be differenced by whoever wants it.
 * Two details matter and neither is optional:
 *
 *  • `facing` WRAPS. Differencing it naively reports ±2π/dt of spin every time
 *    the character crosses the seam, which at 60 fps is 377 rad/s — enough to
 *    put a full-strength whip smear on a character running in a straight line.
 *
 *  • A TELEPORT is not a rotation. The capture harness and every respawn set
 *    `facing` outright, and the frame after that must report zero, not the
 *    difference. `reset()` is what the caller uses to say so.
 */
export class YawRateTracker {
  /** rad/s, wrap-corrected. Zero until two frames have been seen. */
  rate = 0;

  private prev = 0;
  private primed = false;

  step(facing: number, dt: number): number {
    if (!this.primed || dt <= 0) {
      this.prev = facing;
      this.primed = true;
      this.rate = 0;
      return 0;
    }
    let d = facing - this.prev;
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    this.prev = facing;
    this.rate = d / dt;
    return this.rate;
  }

  /** Adopt a facing without reporting a rate. Use after a teleport. */
  reset(facing = 0): void {
    this.prev = facing;
    this.primed = true;
    this.rate = 0;
  }
}
