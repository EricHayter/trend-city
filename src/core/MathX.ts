/**
 * MathX — allocation-free math helpers used across the whole game.
 * Every function here is called many times per frame; none of them allocate.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v: number, a: number, b: number, c: number, d: number) =>
  lerp(c, d, clamp01(invLerp(a, b, v)));
export const sign = (v: number) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const sqr = (v: number) => v * v;

export const smoothstep = (t: number) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (t: number) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Framerate-independent exponential approach. `rate` = how much of the gap is closed per second. */
export const damp = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Angle-aware damp; handles wraparound at ±PI. */
export const dampAngle = (cur: number, target: number, rate: number, dt: number) =>
  cur + wrapPi(target - cur) * (1 - Math.exp(-rate * dt));

export const wrapPi = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** Move toward with a hard per-second speed limit (used for acceleration curves). */
export const moveTo = (cur: number, target: number, maxDelta: number) => {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
};

/**
 * Critically-damped spring integrator. Returns the new value and writes the new
 * velocity back into `state[idx]`. Stable at large dt (semi-implicit).
 */
export function spring(
  cur: number,
  target: number,
  state: Float32Array,
  idx: number,
  stiffness: number,
  damping: number,
  dt: number,
): number {
  const v = state[idx];
  const a = (target - cur) * stiffness - v * damping;
  const nv = v + a * dt;
  state[idx] = nv;
  return cur + nv * dt;
}

// --- easing (used by animation + UI) ---
export const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
export const easeInQuad = (t: number) => t * t;
export const easeInCubic = (t: number) => t * t * t;
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOutBack = (t: number) => {
  const c = 1.70158, c3 = c + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
export const easeOutElastic = (t: number) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
/** Snappy anticipation-then-overshoot curve, the backbone of the attack poses. */
export const easeAnticipate = (t: number) => {
  if (t < 0.28) return -0.22 * smoothstep(t / 0.28);
  const u = (t - 0.28) / 0.72;
  return -0.22 + 1.22 * easeOutQuint(u);
};

/** Deterministic hash noise in [0,1) — used where we want repeatable jitter without RNG state. */
export const hash1 = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
};
export const hash2 = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
};

/** Cheap 1D value noise; C1 continuous. Good enough for camera shake and idle sway. */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i) * 2 - 1, hash1(i + 1) * 2 - 1, u);
}

/** Layered noise for organic drift. */
export function fbm1(x: number, oct = 3): number {
  let a = 0.5, s = 0, f = 1;
  for (let i = 0; i < oct; i++) { s += noise1(x * f) * a; f *= 2.03; a *= 0.5; }
  return s;
}

/** Shortest signed difference between two headings, in turns of PI. */
export const angleTo = (fromX: number, fromZ: number, toX: number, toZ: number) =>
  Math.atan2(toX - fromX, toZ - fromZ);
