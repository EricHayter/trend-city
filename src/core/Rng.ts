/**
 * Deterministic seeded PRNG (mulberry32).
 * Every procedural system pulls from one of these, never Math.random(), so a seed
 * string always reproduces the exact same borough.
 */
export class Rng {
  private s: number;
  readonly seedString: string;

  constructor(seed: string | number) {
    this.seedString = String(seed);
    this.s = typeof seed === 'number' ? seed >>> 0 : Rng.hash(this.seedString);
  }

  /** FNV-1a style hash so human-typeable seeds map to a 32 bit state. */
  static hash(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h ^ (h >>> 15)) >>> 0;
  }

  /** Fork a child stream so one subsystem cannot shift another subsystem's results. */
  fork(tag: string): Rng {
    return new Rng((this.s ^ Rng.hash(tag)) >>> 0);
  }

  float(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number { return a + (b - a) * this.float(); }
  int(a: number, b: number): number { return Math.floor(a + (b + 1 - a) * this.float() * 0.9999999); }
  chance(p: number): boolean { return this.float() < p; }
  sign(): number { return this.float() < 0.5 ? -1 : 1; }
  pick<T>(arr: readonly T[]): T { return arr[Math.min(arr.length - 1, Math.floor(this.float() * arr.length))]; }

  /** Central-limit bell curve: mostly average values with rare extremes. */
  bell(min: number, max: number, tightness = 3): number {
    let t = 0;
    for (let i = 0; i < tightness; i++) t += this.float();
    return min + (max - min) * (t / tightness);
  }

  weighted<T>(entries: readonly [T, number][]): T {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = this.float() * total;
    for (const e of entries) { r -= e[1]; if (r <= 0) return e[0]; }
    return entries[entries.length - 1][0];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

/** Pronounceable, memorable, shareable seed strings. */
export function randomSeedString(): string {
  const a = ['VOLT', 'NEON', 'HALO', 'DUSK', 'ARC', 'GRID', 'ZEPH', 'IRIS', 'KILO', 'ONYX'];
  const b = ['BORO', 'SPIRE', 'VENT', 'RUSH', 'CORE', 'WIRE', 'DRIFT', 'BLOOM'];
  const r = Math.floor(Math.random() * 1e9);
  return a[r % a.length] + '-' + b[(r >> 5) % b.length] + '-' + (100 + (r % 900));
}
