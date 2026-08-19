import { clamp, damp } from './MathX';

/**
 * Clock — owns dt, time dilation, hit-stop and the one-frame impact flashes.
 *
 * Two dt values are published every frame:
 *   `rawDt`  — real wall time (UI animation, music, anything that must not freeze)
 *   `dt`     — dilated game time (physics, animation, particles)
 *
 * Hit-stop is a *hard* freeze with a tiny residual so poses don't look dead,
 * whereas slow-motion is a smooth ramp used for spectacle.
 */
export class Clock {
  rawDt = 1 / 60;
  dt = 1 / 60;
  /** Total dilated game time — every animation phase derives from this. */
  time = 0;
  /** Total real time. */
  wall = 0;
  frame = 0;

  private last = 0;
  private hitstop = 0;
  private slowmo = 0;
  private slowmoScale = 1;
  private scale = 1;
  /** Rolling average frame time in ms, for the adaptive resolution controller. */
  avgMs = 16.7;
  worstMs = 16.7;
  private ring = new Float32Array(60);
  private ringI = 0;

  reset(now: number) { this.last = now; }

  tick(nowMs: number) {
    if (this.last === 0) this.last = nowMs - 16.7;
    let raw = (nowMs - this.last) / 1000;
    this.last = nowMs;
    // Clamp: tab-switch spikes must never teleport the player through the world.
    raw = clamp(raw, 1 / 400, 1 / 24);
    this.rawDt = raw;
    this.wall += raw;
    this.frame++;

    const ms = raw * 1000;
    this.ring[this.ringI++ % this.ring.length] = ms;
    this.avgMs = damp(this.avgMs, ms, 6, raw);
    let w = 0;
    for (let i = 0; i < this.ring.length; i++) if (this.ring[i] > w) w = this.ring[i];
    this.worstMs = w;

    let s = 1;
    if (this.hitstop > 0) {
      this.hitstop -= raw;
      s = 0.045;                       // not exactly 0 — keeps trails/rim alive
    } else if (this.slowmo > 0) {
      this.slowmo -= raw;
      // ease back out of slow-mo so the return to speed reads as a "snap"
      const k = clamp(this.slowmo / 0.18, 0, 1);
      s = 1 + (this.slowmoScale - 1) * (k * k * (3 - 2 * k));
    }
    this.scale = s;
    this.dt = raw * s;
    this.time += this.dt;
  }

  /** Freeze on impact. Longest request wins so a big hit isn't cut short by a small one. */
  addHitstop(sec: number) { if (sec > this.hitstop) this.hitstop = sec; }
  /** Cinematic dilation. `scale` < 1 slows down. */
  addSlowmo(sec: number, scale = 0.35) {
    if (sec > this.slowmo) { this.slowmo = sec; this.slowmoScale = scale; }
  }
  get dilating() { return this.hitstop > 0 || this.slowmo > 0; }
  get timeScale() { return this.scale; }
  clearDilation() { this.hitstop = 0; this.slowmo = 0; }
}
