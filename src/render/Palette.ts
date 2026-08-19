/**
 * Palette — the single source of colour truth for TREND CITY.
 *
 * Everything (geometry, particles, HUD, sky, ink) pulls from here. The rule is:
 * no module invents a colour. If a new hue is needed it gets added to this file
 * so the whole game shifts together and the palette can never drift into
 * generic procedural-game mush.
 *
 * The palette is deliberately narrow: a violet→magenta core, a single cold cyan
 * for energy, one acid green and one gold used *sparsely* as punctuation, and a
 * warm cream that only ever appears as the brightest lit band or a hot spark.
 */

export const C = {
  ink:      '#140a22',
  inkSoft:  '#241239',
  hot:      '#ff2e6e',
  hotDeep:  '#a2124a',
  hotPale:  '#ff8fb4',
  volt:     '#35e8ff',
  voltDeep: '#0f7fa8',
  violet:   '#7b2ff7',
  violetDk: '#3d1580',
  acid:     '#c8ff35',
  gold:     '#ffc23a',
  ember:    '#ff7a1a',
  cream:    '#fff3e0',
  white:    '#ffffff',
  steel:    '#5d7684',
  rust:     '#b45a2c',
} as const;

export type Hex = string;

export const hexToRgb = (h: Hex): [number, number, number] => {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
export const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

export const mixHex = (a: Hex, b: Hex, t: number): Hex => {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
};

/** A cel ramp: `n` hard bands, listed dark→light with the threshold each one ends at. */
export interface RampSpec {
  /** thresholds in 0..1 of the shaded term; must be ascending, last should be 1. */
  stops: number[];
  colors: Hex[];
  /** Multiplier applied to the ramp before it tints the albedo (keeps bands from washing out). */
  gain?: number;
}

/** A tuned material class. Each of these is deliberately different — that is the point. */
export interface MatClass {
  ramp: RampSpec;
  /** rim light colour + exponent + hard cut position */
  rim: { color: Hex; power: number; cut: number; strength: number };
  /** banded specular */
  spec: { color: Hex; power: number; steps: number; strength: number };
  /** stylised fake env reflection strength (matcap) */
  matcap: number;
  /** hatch/halftone amount inside the darkest band */
  hatch: number;
  /** ink outline colour + base width in pixels at 1x */
  ink: { color: Hex; width: number };
}

const R = (stops: number[], colors: Hex[], gain = 1): RampSpec => ({ stops, colors, gain });

/**
 * CHARACTER — 4 bands, wide lit plateau so the silhouette reads as a poster.
 * Thresholds pushed low (0.30) so the terminator lands high on the chest, which
 * is what makes hand-painted anime characters look lit rather than dim.
 */
export const MC_CHARACTER: MatClass = {
  ramp: R([0.30, 0.52, 0.80, 1.0], ['#3a2352', '#7b4e9e', '#cfa8e8', '#fff3e0'], 1.0),
  rim: { color: C.volt, power: 2.4, cut: 0.42, strength: 1.15 },
  spec: { color: C.cream, power: 44, steps: 2, strength: 0.9 },
  matcap: 0.30, hatch: 0.34,
  ink: { color: '#190b28', width: 2.5 },
};

/** ENEMY — colder, more contrast, only 3 bands so they read as flat cut-outs. */
export const MC_ENEMY: MatClass = {
  ramp: R([0.38, 0.70, 1.0], ['#2a1338', '#8a2359', '#ff6d97'], 1.0),
  rim: { color: C.hot, power: 2.0, cut: 0.38, strength: 1.35 },
  spec: { color: C.hotPale, power: 30, steps: 1, strength: 0.75 },
  matcap: 0.24, hatch: 0.28,
  ink: { color: '#1b0716', width: 2.4 },
};

export const MC_BOSS: MatClass = {
  ramp: R([0.26, 0.48, 0.74, 1.0], ['#1b0f30', '#42207a', '#8a4ad6', '#e8c8ff'], 1.05),
  rim: { color: C.volt, power: 1.7, cut: 0.30, strength: 1.6 },
  spec: { color: C.white, power: 60, steps: 2, strength: 1.1 },
  matcap: 0.42, hatch: 0.40,
  ink: { color: '#0d0518', width: 3.2 },
};

/** CONCRETE — 3 broad bands, almost no spec, heavy hatch. Reads as gouache. */
export const MC_CONCRETE: MatClass = {
  ramp: R([0.34, 0.66, 1.0], ['#2e2145', '#6a5490', '#b9a5d8'], 0.96),
  rim: { color: C.violet, power: 4.5, cut: 0.72, strength: 0.35 },
  spec: { color: C.cream, power: 12, steps: 1, strength: 0.10 },
  matcap: 0.05, hatch: 0.42,
  ink: { color: '#1a1029', width: 1.9 },
};

/** METAL — tight dark bands then a hard bright kick, strong matcap. */
export const MC_METAL: MatClass = {
  ramp: R([0.30, 0.50, 0.72, 1.0], ['#182338', '#2c4468', '#5c8cbe', '#cfeaff'], 1.0),
  rim: { color: C.volt, power: 2.8, cut: 0.55, strength: 0.8 },
  spec: { color: C.white, power: 80, steps: 2, strength: 1.25 },
  matcap: 0.55, hatch: 0.20,
  ink: { color: '#0e1626', width: 2.1 },
};

/** GLASS — dark body, huge fresnel, the reflection does all the work. */
export const MC_GLASS: MatClass = {
  ramp: R([0.45, 0.85, 1.0], ['#120f30', '#1d2a5c', '#4a6fb0'], 0.9),
  rim: { color: C.volt, power: 1.4, cut: 0.20, strength: 1.9 },
  spec: { color: C.white, power: 120, steps: 1, strength: 1.6 },
  matcap: 0.85, hatch: 0.0,
  ink: { color: '#0a0a24', width: 1.5 },
};

/** VEGETATION — 3 bands with a yellow-green lit band; hatch reads as leaf texture. */
export const MC_FOLIAGE: MatClass = {
  ramp: R([0.36, 0.68, 1.0], ['#152e26', '#2f6b46', '#a8e87a'], 1.0),
  rim: { color: C.acid, power: 3.0, cut: 0.60, strength: 0.55 },
  spec: { color: C.acid, power: 20, steps: 1, strength: 0.25 },
  matcap: 0.08, hatch: 0.50,
  ink: { color: '#0f2018', width: 1.8 },
};

/** RUST / industrial panelling. */
export const MC_RUST: MatClass = {
  ramp: R([0.32, 0.60, 1.0], ['#33190f', '#8a4020', '#e8a154'], 1.0),
  rim: { color: C.ember, power: 3.2, cut: 0.62, strength: 0.6 },
  spec: { color: C.gold, power: 26, steps: 1, strength: 0.4 },
  matcap: 0.18, hatch: 0.38,
  ink: { color: '#1c0d07', width: 2.0 },
};

/** DIGITAL — the deep-grid biome. Almost binary: void or blazing. */
export const MC_DIGITAL: MatClass = {
  ramp: R([0.42, 0.78, 1.0], ['#0d0a22', '#2a1a63', '#7d55e0'], 1.0),
  rim: { color: C.volt, power: 1.6, cut: 0.26, strength: 1.7 },
  spec: { color: C.volt, power: 90, steps: 1, strength: 1.3 },
  matcap: 0.35, hatch: 0.16,
  ink: { color: '#07041a', width: 2.3 },
};

/** Fully emissive signage / rails / energy — unlit, ramp unused. */
export const MC_EMISSIVE: MatClass = {
  ramp: R([1.0], [C.cream], 1.0),
  rim: { color: C.white, power: 1.0, cut: 0.0, strength: 0.0 },
  spec: { color: C.white, power: 1, steps: 1, strength: 0.0 },
  matcap: 0.0, hatch: 0.0,
  ink: { color: '#20103a', width: 1.6 },
};

export const MAT_CLASSES = {
  character: MC_CHARACTER,
  enemy: MC_ENEMY,
  boss: MC_BOSS,
  concrete: MC_CONCRETE,
  metal: MC_METAL,
  glass: MC_GLASS,
  foliage: MC_FOLIAGE,
  rust: MC_RUST,
  digital: MC_DIGITAL,
  emissive: MC_EMISSIVE,
} as const;
export type MatClassName = keyof typeof MAT_CLASSES;

// ---------------------------------------------------------------------------
// BIOMES
// ---------------------------------------------------------------------------

export interface Biome {
  id: 'borough' | 'works' | 'grid';
  name: string;
  /** sky gradient, bottom→top; quantised in the sky shader */
  sky: Hex[];
  horizon: Hex;
  sun: Hex;
  sunDir: [number, number, number];
  /** hemisphere fill from the sky and the ground bounce */
  ambSky: Hex;
  ambGround: Hex;
  /** atmospheric perspective target + band count */
  fog: Hex;
  fogNear: number;
  fogFar: number;
  fogBands: number;
  fogStrength: number;
  cloud: { color: Hex; shade: Hex; cover: number; speed: number; scale: number };
  /** accent hues this zone is allowed to use for neon and fx */
  accents: Hex[];
  /** default material class for structural geometry */
  structure: MatClassName;
  /** procedural building facade parameters for this zone */
  facade: {
    body: Hex; frame: Hex; lit: Hex;
    cols: number; rows: number; litChance: number;
  };
  /** default tints the Kit applies to generated surface textures in this zone */
  tints: { deck: Hex; metal: Hex; trim: Hex; dark: Hex };
}

export const BIOME_BOROUGH: Biome = {
  id: 'borough', name: 'LANTERN ROW',
  sky: ['#ffb06b', '#ff4d8d', '#a02fb0', '#4b1d8f', '#241a5c'],
  horizon: '#ffd0a0', sun: '#fff0c0', sunDir: [-0.42, 0.58, -0.70],
  ambSky: '#6a4aa8', ambGround: '#54233f',
  fog: '#b85a9c', fogNear: 300, fogFar: 1800, fogBands: 5, fogStrength: 0.84,
  cloud: { color: '#ffd9b0', shade: '#c05a92', cover: 0.46, speed: 0.0055, scale: 1.0 },
  accents: [C.hot, C.volt, C.gold],
  structure: 'concrete',
  facade: { body: '#3b2a4e', frame: '#1d1430', lit: '#ffcf7a', cols: 7, rows: 14, litChance: 0.42 },
  tints: { deck: '#8f7fa8', metal: '#b9a4c8', trim: C.hot, dark: '#241a38' },
};

export const BIOME_WORKS: Biome = {
  id: 'works', name: 'MACHINE WORKS',
  sky: ['#e07a2b', '#a8442e', '#5c2a4a', '#26224e', '#101a34'],
  horizon: '#ffab52', sun: '#ffd07a', sunDir: [0.55, 0.42, -0.72],
  ambSky: '#3f4a7a', ambGround: '#5c2f1e',
  fog: '#c06a34', fogNear: 90, fogFar: 900, fogBands: 4, fogStrength: 1.0,
  cloud: { color: '#ffc07a', shade: '#7a3a3c', cover: 0.66, speed: 0.011, scale: 1.5 },
  accents: [C.ember, C.volt, C.gold],
  structure: 'rust',
  facade: { body: '#4a3226', frame: '#241610', lit: '#ffb040', cols: 5, rows: 9, litChance: 0.30 },
  tints: { deck: '#9c8570', metal: '#c69a6a', trim: C.ember, dark: '#2a1a12' },
};

export const BIOME_GRID: Biome = {
  id: 'grid', name: 'DEEP GRID',
  sky: ['#1a0f4a', '#12083a', '#0a0526', '#06031a', '#03020f'],
  horizon: '#4a2ad0', sun: '#a8f0ff', sunDir: [0.18, 0.86, -0.48],
  ambSky: '#2a1a6e', ambGround: '#120a30',
  fog: '#2a1470', fogNear: 200, fogFar: 1700, fogBands: 6, fogStrength: 0.8,
  cloud: { color: '#5a3ae0', shade: '#1a0e46', cover: 0.24, speed: 0.02, scale: 2.4 },
  accents: [C.volt, C.hot, C.acid],
  structure: 'digital',
  facade: { body: '#1a1240', frame: '#0a0620', lit: '#6ef2ff', cols: 9, rows: 18, litChance: 0.55 },
  tints: { deck: '#6a5fd0', metal: '#8aa0ff', trim: C.volt, dark: '#0c0724' },
};

export const BIOMES = [BIOME_BOROUGH, BIOME_WORKS, BIOME_GRID];
export const BIOME_BY_ID: Record<string, Biome> = {
  borough: BIOME_BOROUGH, works: BIOME_WORKS, grid: BIOME_GRID,
};

/** Smoothly interpolate every numeric/colour field so zone transitions are seamless. */
export function blendBiome(a: Biome, b: Biome, t: number): Biome {
  const mh = (x: Hex, y: Hex) => mixHex(x, y, t);
  const ml = (x: number, y: number) => x + (y - x) * t;
  return {
    id: t < 0.5 ? a.id : b.id,
    name: t < 0.5 ? a.name : b.name,
    sky: a.sky.map((c, i) => mh(c, b.sky[i] ?? c)),
    horizon: mh(a.horizon, b.horizon), sun: mh(a.sun, b.sun),
    sunDir: [ml(a.sunDir[0], b.sunDir[0]), ml(a.sunDir[1], b.sunDir[1]), ml(a.sunDir[2], b.sunDir[2])],
    ambSky: mh(a.ambSky, b.ambSky), ambGround: mh(a.ambGround, b.ambGround),
    fog: mh(a.fog, b.fog),
    fogNear: ml(a.fogNear, b.fogNear), fogFar: ml(a.fogFar, b.fogFar),
    fogBands: Math.round(ml(a.fogBands, b.fogBands)), fogStrength: ml(a.fogStrength, b.fogStrength),
    cloud: {
      color: mh(a.cloud.color, b.cloud.color), shade: mh(a.cloud.shade, b.cloud.shade),
      cover: ml(a.cloud.cover, b.cloud.cover), speed: ml(a.cloud.speed, b.cloud.speed),
      scale: ml(a.cloud.scale, b.cloud.scale),
    },
    accents: t < 0.5 ? a.accents : b.accents,
    structure: t < 0.5 ? a.structure : b.structure,
    facade: {
      body: mh(a.facade.body, b.facade.body),
      frame: mh(a.facade.frame, b.facade.frame),
      lit: mh(a.facade.lit, b.facade.lit),
      cols: Math.round(ml(a.facade.cols, b.facade.cols)),
      rows: Math.round(ml(a.facade.rows, b.facade.rows)),
      litChance: ml(a.facade.litChance, b.facade.litChance),
    },
    tints: {
      deck: mh(a.tints.deck, b.tints.deck),
      metal: mh(a.tints.metal, b.tints.metal),
      trim: mh(a.tints.trim, b.tints.trim),
      dark: mh(a.tints.dark, b.tints.dark),
    },
  };
}
