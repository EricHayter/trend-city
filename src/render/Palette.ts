import { Color } from 'three';

// ART DIRECTION, SINGLE SOURCE OF TRUTH
// One limited, high-saturation palette drives characters, world, effects, UI and the
// final grading LUT. Nothing in the game picks a colour that is not derived from here.

export const INK = 0x0b0718;          // outline / deepest shadow
export const INK_SOFT = 0x1a1030;     // interior line colour
export const CYAN = 0x4de8ff;
export const AZURE = 0x2a7bff;
export const MAGENTA = 0xff3d9a;
export const VIOLET = 0x7b3bff;
export const LIME = 0xb6ff3d;
export const AMBER = 0xffb03a;
export const CORAL = 0xff6a3d;
export const PAPER = 0xfff3e0;
export const STEEL = 0x8fa2c8;
export const CONCRETE = 0xd8d3e8;

export interface DistrictStyle {
  id: number;
  key: string;
  name: string;
  /** Sky dome gradient. */
  skyTop: number;
  skyMid: number;
  skyHorizon: number;
  sun: number;
  cloud: number;
  cloudShade: number;
  /** Quantised atmospheric-perspective target colour for distant geometry. */
  haze: number;
  /** Surface families. */
  concrete: number;
  concreteShade: number;
  metal: number;
  glass: number;
  accent: number;
  accent2: number;
  /** Light rig. */
  lightDir: [number, number, number];
  lightColor: number;
  ambient: number;
  /** Density of window lights, signage, decoration. */
  signDensity: number;
  atmosphere: 'dusk' | 'day' | 'smog' | 'storm' | 'reactor' | 'void';
}

export const DISTRICTS: DistrictStyle[] = [
  {
    id: 0, key: 'residential', name: 'LANTERN ROW',
    skyTop: 0x2b1b5e, skyMid: 0x8c3a9e, skyHorizon: 0xff8ac4, sun: 0xffd27a,
    cloud: 0xffc4e4, cloudShade: 0xb85fa8, haze: 0xc86bb4,
    concrete: 0xe8dcf2, concreteShade: 0x6b4a8c, metal: 0x9d8ec4, glass: 0x6be0ff,
    accent: MAGENTA, accent2: CYAN,
    lightDir: [0.42, 0.78, 0.46], lightColor: 0xffe0c0, ambient: 0x5a3a8c,
    signDensity: 1.0, atmosphere: 'dusk',
  },
  {
    id: 1, key: 'commercial', name: 'GLASS TIER',
    skyTop: 0x123a86, skyMid: 0x2f7fd6, skyHorizon: 0xa8ecff, sun: 0xfff3c0,
    cloud: 0xffffff, cloudShade: 0x7fb6ec, haze: 0x8fd2f5,
    concrete: 0xf2f0fa, concreteShade: 0x5f7bb0, metal: 0xa8bede, glass: 0x4de8ff,
    accent: CYAN, accent2: MAGENTA,
    lightDir: [-0.34, 0.86, 0.38], lightColor: 0xffffff, ambient: 0x4a6ea8,
    signDensity: 0.8, atmosphere: 'day',
  },
  {
    id: 2, key: 'transit', name: 'THE INTERCHANGE',
    skyTop: 0x4a1d5e, skyMid: 0xb44a5e, skyHorizon: 0xffb03a, sun: 0xfff0b0,
    cloud: 0xffd9a0, cloudShade: 0xa8506e, haze: 0xe08a5e,
    concrete: 0xe0d2c8, concreteShade: 0x7a4f52, metal: 0xc8a06a, glass: 0xffd27a,
    accent: AMBER, accent2: CORAL,
    lightDir: [0.62, 0.62, -0.3], lightColor: 0xffcf8a, ambient: 0x6e3a52,
    signDensity: 0.9, atmosphere: 'smog',
  },
  {
    id: 3, key: 'industrial', name: 'FOUNDRY STACK',
    skyTop: 0x14243a, skyMid: 0x2e5a58, skyHorizon: 0x9ecf6a, sun: 0xdcffa0,
    cloud: 0xc2e8b0, cloudShade: 0x3f6b58, haze: 0x74a878,
    concrete: 0xc9cfc4, concreteShade: 0x3f5148, metal: 0x8fa08a, glass: 0xb6ff3d,
    accent: LIME, accent2: AMBER,
    lightDir: [-0.5, 0.7, -0.5], lightColor: 0xe8ffd0, ambient: 0x2f4a44,
    signDensity: 0.65, atmosphere: 'storm',
  },
  {
    id: 4, key: 'reactor', name: 'CORE ASCENT',
    skyTop: 0x140a34, skyMid: 0x5a1060, skyHorizon: 0xff3d9a, sun: 0xffffff,
    cloud: 0xff9ac8, cloudShade: 0x7a1a5e, haze: 0xd0348c,
    concrete: 0xdcd0e8, concreteShade: 0x4a2a60, metal: 0xb0a0d0, glass: 0xff6ac0,
    accent: MAGENTA, accent2: PAPER,
    lightDir: [0.2, 0.9, -0.36], lightColor: 0xffdcf0, ambient: 0x4a1a54,
    signDensity: 1.1, atmosphere: 'reactor',
  },
  {
    id: 5, key: 'digital', name: 'HALCYON LATTICE',
    skyTop: 0x05041a, skyMid: 0x24106e, skyHorizon: 0x7b3bff, sun: 0x9ef0ff,
    cloud: 0x8f7bff, cloudShade: 0x2c1a6e, haze: 0x5a34c8,
    concrete: 0xcfc4f2, concreteShade: 0x2a1a5e, metal: 0x8f7bd8, glass: 0x4de8ff,
    accent: VIOLET, accent2: CYAN,
    lightDir: [0.0, 0.92, 0.4], lightColor: 0xd8e8ff, ambient: 0x2a1a6e,
    signDensity: 1.2, atmosphere: 'void',
  },
];

const tmp = new Color();
export function col(hex: number): Color { return new Color(hex); }

/** Shift a palette colour without leaving the palette: keeps hue, moves value only. */
export function shade(hex: number, amount: number): number {
  tmp.setHex(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  tmp.getHSL(hsl);
  tmp.setHSL(hsl.h, Math.min(1, hsl.s * (amount < 0 ? 1.12 : 0.94)), Math.max(0, Math.min(1, hsl.l + amount)));
  return tmp.getHex();
}

export function districtFor(t: number): DistrictStyle {
  const i = Math.max(0, Math.min(DISTRICTS.length - 1, Math.floor(t * DISTRICTS.length)));
  return DISTRICTS[i];
}
