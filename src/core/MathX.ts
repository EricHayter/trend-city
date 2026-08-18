/** Allocation-free math helpers shared by every subsystem. */
export const TAU = Math.PI * 2;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b - a === 0 ? 0 : clamp01((v - a) / (b - a)));

/** Framerate-independent exponential smoothing. rate is in 1/seconds. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function easeOutCubic(t: number) { const u = 1 - t; return 1 - u * u * u; }
export function easeInCubic(t: number) { return t * t * t; }
export function easeInOut(t: number) { return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); }
export function easeOutBack(t: number) { const c = 1.70158; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; }
export function easeOutElastic(t: number) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const p = 0.36;
  return Math.pow(2, -11 * t) * Math.sin(((t - p / 4) * TAU) / p) + 1;
}

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function angleDamp(current: number, target: number, rate: number, dt: number): number {
  return current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt));
}

export interface SpringState { v: number; }

/**
 * Semi-implicit spring integrator with sub-stepping. Camera, HUD needles and body
 * squash all share it, so every snappy response in the game has one physical feel.
 */
export function spring(value: number, state: SpringState, target: number, stiffness: number, damping: number, dt: number): number {
  const iterations = Math.max(1, Math.ceil(dt * 90));
  const h = dt / iterations;
  let v = state.v;
  let x = value;
  for (let i = 0; i < iterations; i++) {
    const a = (target - x) * stiffness - v * damping;
    v += a * h;
    x += v * h;
  }
  state.v = v;
  return x;
}

/** 1D value noise, deterministic from an integer seed. */
export function valueNoise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    let t = Math.imul(n ^ seed, 0x27d4eb2d);
    t ^= t >>> 15;
    return ((t >>> 0) % 100000) / 100000;
  };
  const a = h(i);
  const b = h(i + 1);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

export function fbm1(x: number, octaves = 4, seed = 0): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise1(x * freq, seed + o * 977) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
