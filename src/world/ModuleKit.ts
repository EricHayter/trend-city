import { Vector3 } from 'three';
import { Canvas } from './Canvas';
import { MomentumRole } from './Types';

export interface ModuleParams {
  speedIn: number;
  difficulty: number;   // 0..1 across the stage
  index: number;
  total: number;
}

export interface ModuleOut {
  exit: { pos: Vector3; heading: number };
  exitSpeed: number;
  distance: number;
  label: string;
}

export interface ModuleDef {
  name: string;
  label: string;
  role: MomentumRole;
  /** Entry speed the module is designed for; the grammar will not place it below this. */
  minSpeed: number;
  weight: number;
  /** Modules flagged unique appear at most once per stage. */
  unique?: boolean;
  build: (c: Canvas, p: ModuleParams) => ModuleOut;
}

export const ROUTE_L = -13;
export const ROUTE_C = 0;
export const ROUTE_R = 13;

/** Straight walkable deck segment. Returns the far edge z. */
export function deck(c: Canvas, z0: number, z1: number, x: number, width: number, y = 0, variant: any = 'roof', extra: any = {}) {
  const len = z1 - z0;
  c.slab(Object.assign({ x, y: y - 0.6, z: (z0 + z1) / 2, w: width, h: 1.2, l: len, kind: 'concrete', variant }, extra));
  return z1;
}

/** Descending or ascending ramp between two heights. Pitch is derived, not guessed. */
export function ramp(c: Canvas, z0: number, z1: number, x: number, width: number, y0: number, y1: number, variant: any = 'metal', extra: any = {}) {
  const len = z1 - z0;
  const rise = y1 - y0;
  const span = Math.hypot(len, rise);
  const pitch = Math.atan2(-rise, len);
  c.slab(Object.assign({
    x, y: (y0 + y1) / 2 - 0.45, z: (z0 + z1) / 2, w: width, h: 0.9, l: span, pitch,
    kind: variant === 'panel' ? 'panel' : 'metal', variant,
    boost: rise < -1 ? 1.14 : 1.0,
  }, extra));
  return { pitch, span };
}

/** Boost pad: reads instantly, hard graphic chevrons, and it actually adds speed. */
export function booster(c: Canvas, x: number, y: number, z: number, yaw = 0) {
  c.slab({ x, y: y + 0.15, z, w: 5, h: 0.35, l: 7, kind: 'metal', variant: 'boost', boost: 2.6, yawOffset: yaw, outline: true, outlineWidth: 1.2 });
  c.decor({ x, y: y + 0.45, z: z - 1.6, w: 3.4, h: 0.2, l: 1.2, kind: 'neon', variant: 'neon', yawOffset: yaw });
  c.decor({ x, y: y + 0.45, z: z + 0.4, w: 3.4, h: 0.2, l: 1.2, kind: 'neon', variant: 'neon', yawOffset: yaw });
}

/** Bounce pad: awning / tarp / fan grate that throws the player upward. */
export function bouncePad(c: Canvas, x: number, y: number, z: number, power = 34) {
  c.slab({ x, y, z, w: 6, h: 0.5, l: 6, geo: 'cyl', kind: 'metal', variant: 'duct', bounce: power, outline: true, outlineWidth: 1.2 });
  c.decor({ x, y: y + 0.5, z, w: 4.4, h: 0.3, l: 4.4, geo: 'cyl', kind: 'neon', variant: 'boost' });
}

/** Hazard block: hurts, but is always readable and always avoidable at speed. */
export function hazard(c: Canvas, x: number, y: number, z: number, w = 3, h = 3, l = 2) {
  c.slab({ x, y: y + h / 2, z, w, h, l, kind: 'hazard', variant: 'hazard', hazard: true, outline: true, outlineWidth: 1.1 });
}

/** Breakable crate: smashing it preserves momentum and pays out style. */
export function crate(c: Canvas, x: number, y: number, z: number, size = 2.4) {
  c.slab({ x, y: y + size / 2, z, w: size, h: size, l: size, kind: 'decor', variant: 'decor', breakable: true, outline: true, outlineWidth: 1.05 });
}

/** Flanking city mass so a route never feels like floating platforms. */
export function flankTowers(c: Canvas, z0: number, z1: number, spread = 34, count = 6, baseY = -60) {
  const rng = c.rng;
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    const z = z0 + (z1 - z0) * t + rng.range(-8, 8);
    for (const side of [-1, 1] as const) {
      const x = side * (spread + rng.range(0, 26));
      const h = rng.bell(30, 130, 2) + (1 - Math.abs(t - 0.5)) * 20;
      c.building(x, z, rng.range(14, 26), rng.range(14, 26), h, { baseY: baseY - rng.range(0, 20) });
    }
  }
}

/** Ground-level borough fill: streets, blocks and rooftops far below the play line. */
export function boroughFloor(c: Canvas, z0: number, z1: number, baseY = -70) {
  const rng = c.rng;
  for (let i = 0; i < 10; i++) {
    const z = rng.range(z0, z1);
    const x = rng.range(-90, 90);
    if (Math.abs(x) < 20) continue;
    c.decor({ x, y: baseY + rng.range(0, 14), z, w: rng.range(10, 30), h: rng.range(10, 40), l: rng.range(10, 30), kind: 'concrete', variant: 'facade' });
  }
}

/** Suspended cables and pipes strung across the route: depth without collision cost. */
export function overheadClutter(c: Canvas, z0: number, z1: number, y = 16) {
  const rng = c.rng;
  for (let i = 0; i < 5; i++) {
    const z = rng.range(z0, z1);
    c.decor({ x: rng.range(-6, 6), y: y + rng.range(-3, 6), z, w: 120, h: 0.22, l: 0.22, kind: 'metal', variant: 'metal', yawOffset: rng.range(-0.3, 0.3) });
  }
  for (let i = 0; i < 3; i++) {
    const z = rng.range(z0, z1);
    c.decor({ x: rng.range(-30, 30), y: y + rng.range(2, 10), z, w: 1.4, h: 1.4, l: 60, geo: 'tube', kind: 'metal', variant: 'duct' });
  }
}

/** Air-quality: floating debris, sparks, drifting signage. Pure silhouette dressing. */
export function ambientProps(c: Canvas, z0: number, z1: number) {
  const rng = c.rng;
  for (let i = 0; i < 6; i++) {
    c.decor({
      x: rng.range(-40, 40), y: rng.range(-8, 26), z: rng.range(z0, z1),
      w: rng.range(0.6, 2.2), h: rng.range(0.6, 2.2), l: rng.range(0.6, 2.2),
      geo: rng.chance(0.4) ? 'sphere' : 'box', kind: 'decor', variant: rng.chance(0.3) ? 'neon' : 'decor',
      yawOffset: rng.range(0, 3),
    });
  }
}
