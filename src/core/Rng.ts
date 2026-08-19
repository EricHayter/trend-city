/**
 * Rng — deterministic seeded random. Every generated thing in the game
 * traces back to one of these, so a seed string fully reproduces a stage.
 */

/** FNV-1a string hash → 32-bit seed. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private s: number;
  readonly seed: number;

  constructor(seed: number | string) {
    this.seed = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
    this.s = this.seed || 0x9e3779b9;
  }

  /** mulberry32 — fast, decent distribution, tiny state. */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Fork a child stream — lets subsystems consume randomness without desyncing siblings. */
  fork(tag: string): Rng {
    return new Rng((this.seed ^ hashSeed(tag) ^ (this.nextInt(0, 1 << 30) >>> 0)) >>> 0);
  }

  range(a: number, b: number) { return a + (b - a) * this.next(); }
  nextInt(a: number, b: number) { return a + Math.floor(this.next() * (b - a + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length) % arr.length]; }

  /** Weighted pick. `weights` need not be normalized. */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < arr.length; i++) total += weights[i];
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Gaussian-ish via sum of uniforms — cheaper than Box-Muller, no trig. */
  gauss(mean = 0, sd = 1) {
    return mean + ((this.next() + this.next() + this.next() - 1.5) / 0.866) * sd;
  }

  /**
   * Bag shuffle: draws from `arr` without repeats until exhausted, then reshuffles.
   * This is the main tool against "obviously procedural" repetition.
   */
  bag<T>(arr: readonly T[]): () => T {
    let pool: T[] = [];
    let last: T | undefined;
    return () => {
      if (pool.length === 0) {
        pool = this.shuffle(arr.slice());
        // avoid the reshuffle immediately repeating the previous draw
        if (pool.length > 1 && pool[pool.length - 1] === last) {
          const t = pool[0]; pool[0] = pool[pool.length - 1]; pool[pool.length - 1] = t;
        }
      }
      last = pool.pop()!;
      return last;
    };
  }
}
