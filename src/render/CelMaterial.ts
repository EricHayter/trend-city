import { ShaderMaterial, Color, Vector2, Vector3, DoubleSide, FrontSide, Texture, AdditiveBlending } from 'three';
import { CEL_VERTEX } from './CelVertex';
import { CEL_FRAGMENT } from './CelFragment';
import { makeRampTexture, makeMatcap, makeHatchTexture } from './Textures';
import { DistrictStyle, DISTRICTS } from './Palette';

export type MatClass = 'character' | 'characterTrim' | 'cloth' | 'enemy' | 'enemyTrim' | 'boss' | 'bossCore'
  | 'concrete' | 'metal' | 'glass' | 'panel' | 'duct' | 'neon' | 'rail' | 'hazard' | 'digital' | 'foliage' | 'decor';

export interface CelSpec {
  base: number;
  bands: { at: number; color: number }[];
  spec?: { color?: number; power?: number; cut?: number; strength?: number };
  rim?: { color?: number; power?: number; cut?: number; strength?: number };
  matcap?: number;          // strength
  matcapKey?: string;
  hatch?: number;           // strength
  hatchBand?: number;       // ramp value below which hatching applies
  emissive?: number;
  emissiveColor?: number;
  opacity?: number;
  pattern?: number;
  patternScale?: number;
  patternA?: number;
  patternB?: number;
  patternGlow?: number;
  haze?: number;            // per-class haze susceptibility
  ambient?: number;
  outline?: boolean;
  outlineWidth?: number;
}

// Band thresholds below were tuned by eye against captured frames: characters get a
// tight, high-contrast four-band split so the silhouette reads instantly, architecture
// gets a wider three-band split so it never fights the character for attention.
const SPECS: Record<MatClass, CelSpec> = {
  character: {
    base: 0xffffff,
    bands: [{ at: 0, color: 0x3f2a6e }, { at: 0.47, color: 0x8f74c8 }, { at: 0.63, color: 0xf2e8ff }, { at: 0.85, color: 0xfffaf2 }],
    spec: { color: 0xffffff, power: 34, cut: 0.42, strength: 0.5 },
    rim: { color: 0x9ef0ff, power: 2.6, cut: 0.34, strength: 0.85 },
    matcap: 0.1, matcapKey: 'chrome', hatch: 0.22, hatchBand: 0.42, haze: 0.35, outline: true, outlineWidth: 1.0,
  },
  characterTrim: {
    base: 0xffffff,
    bands: [{ at: 0, color: 0x4a2a7a }, { at: 0.44, color: 0xa084e0 }, { at: 0.6, color: 0xffffff }, { at: 0.8, color: 0xffffff }],
    spec: { color: 0xffffff, power: 56, cut: 0.3, strength: 0.8 },
    rim: { color: 0xffffff, power: 2.2, cut: 0.3, strength: 1.0 },
    matcap: 0.22, matcapKey: 'chrome', hatch: 0.12, haze: 0.3, outline: true, outlineWidth: 0.9,
  },
  cloth: {
    base: 0xffffff,
    bands: [{ at: 0, color: 0x36215e }, { at: 0.5, color: 0x8a68c0 }, { at: 0.7, color: 0xffe8ff }],
    rim: { color: 0xff9ee0, power: 2.0, cut: 0.28, strength: 0.9 },
    spec: { strength: 0.1 }, hatch: 0.3, hatchBand: 0.46, haze: 0.35, outline: true, outlineWidth: 1.1,
  },
  enemy: {
    base: 0xffffff,
    bands: [{ at: 0, color: 0x2e2050 }, { at: 0.5, color: 0x8676b8 }, { at: 0.74, color: 0xfff2ff }],
    spec: { color: 0xffffff, power: 28, cut: 0.46, strength: 0.42 },
    rim: { color: 0xff6ac0, power: 2.4, cut: 0.32, strength: 0.9 },
    matcap: 0.12, matcapKey: 'chrome', hatch: 0.26, haze: 0.5, outline: true, outlineWidth: 1.0,
  },
  enemyTrim: {
    base: 0xffffff,
    bands: [{ at: 0, color: 0x6a1a4a }, { at: 0.42, color: 0xff5aa0 }, { at: 0.66, color: 0xffffff }],
    emissive: 0.55, emissiveColor: 0xff3d9a, spec: { strength: 0.5, power: 40, cut: 0.4 },
    rim: { color: 0xffffff, power: 2.0, cut: 0.3, strength: 0.7 }, hatch: 0.0, haze: 0.4, outline: true,
  },
  boss: {
    base: 0xffffff,
    bands: [{ at: 0, color: 0x241a4e }, { at: 0.44, color: 0x7768b4 }, { at: 0.62, color: 0xe8e0ff }, { at: 0.86, color: 0xffffff }],
    spec: { color: 0xffffff, power: 44, cut: 0.38, strength: 0.66 },
    rim: { color: 0x9ef0ff, power: 2.2, cut: 0.3, strength: 1.05 },
    matcap: 0.2, matcapKey: 'chrome', hatch: 0.24, haze: 0.4, outline: true, outlineWidth: 1.35,
  },
  bossCore: {
    base: 0xffffff, bands: [{ at: 0, color: 0xffffff }],
    emissive: 1.5, emissiveColor: 0xff3d9a, spec: { strength: 0 }, rim: { color: 0xffffff, power: 1.6, cut: 0.2, strength: 1.2 },
    hatch: 0, haze: 0.2, outline: true, outlineWidth: 1.2,
  },
  concrete: {
    base: 0xd8d3e8,
    bands: [{ at: 0, color: 0x3a2f5c }, { at: 0.44, color: 0x8a80b0 }, { at: 0.68, color: 0xe6e0f5 }, { at: 0.9, color: 0xfffdf5 }],
    spec: { strength: 0.06, power: 14, cut: 0.7 }, rim: { color: 0xbfe8ff, power: 3.2, cut: 0.52, strength: 0.25 },
    hatch: 0.34, hatchBand: 0.46, haze: 1.0, pattern: 6, patternScale: 1, patternA: 0xa89ec8, outline: false,
  },
  metal: {
    base: 0xa8bede,
    bands: [{ at: 0, color: 0x2b2748 }, { at: 0.42, color: 0x6b73a4 }, { at: 0.62, color: 0xcfd8f0 }, { at: 0.84, color: 0xffffff }],
    spec: { color: 0xffffff, power: 48, cut: 0.34, strength: 0.72 }, rim: { color: 0x9ef0ff, power: 2.8, cut: 0.44, strength: 0.4 },
    matcap: 0.26, matcapKey: 'chrome', hatch: 0.24, haze: 0.95, outline: false,
  },
  glass: {
    base: 0x4de8ff,
    bands: [{ at: 0, color: 0x2a3a6e }, { at: 0.5, color: 0x6fd8ff }, { at: 0.76, color: 0xdcfbff }],
    spec: { color: 0xffffff, power: 70, cut: 0.28, strength: 0.9 }, rim: { color: 0xffffff, power: 1.9, cut: 0.24, strength: 0.8 },
    matcap: 0.34, matcapKey: 'sky', hatch: 0.0, emissive: 0.1, emissiveColor: 0x4de8ff, opacity: 0.72, haze: 0.9, outline: false,
  },
  panel: {
    base: 0x3f5fb0,
    bands: [{ at: 0, color: 0x1c2a52 }, { at: 0.46, color: 0x4a6ab0 }, { at: 0.7, color: 0xb8e4ff }],
    spec: { color: 0xffffff, power: 60, cut: 0.3, strength: 0.85 }, rim: { color: 0x9ef0ff, power: 2.4, cut: 0.4, strength: 0.5 },
    matcap: 0.3, matcapKey: 'sky', hatch: 0.1, haze: 0.9, pattern: 2, patternScale: 1, patternA: 0x8fa2c8, patternB: 0x9ef0ff, patternGlow: 0.5, outline: true, outlineWidth: 0.8,
  },
  duct: {
    base: 0x9aa8bf,
    bands: [{ at: 0, color: 0x2e2c46 }, { at: 0.44, color: 0x6f7498 }, { at: 0.66, color: 0xdfe6f4 }],
    spec: { color: 0xffffff, power: 30, cut: 0.42, strength: 0.5 }, rim: { color: 0xbfe8ff, power: 2.6, cut: 0.42, strength: 0.45 },
    matcap: 0.2, matcapKey: 'chrome', hatch: 0.26, haze: 0.95, pattern: 3, patternScale: 1, patternA: 0x74809c, patternB: 0xcfd8f0, outline: true, outlineWidth: 0.85,
  },
  neon: {
    base: 0xffffff, bands: [{ at: 0, color: 0xffffff }],
    emissive: 1.35, emissiveColor: 0xff3d9a, spec: { strength: 0 }, rim: { strength: 0 }, hatch: 0, haze: 0.15, outline: false,
  },
  rail: {
    base: 0xffffff, bands: [{ at: 0, color: 0xdfe8ff }, { at: 0.5, color: 0xffffff }],
    emissive: 1.1, emissiveColor: 0x4de8ff, spec: { color: 0xffffff, power: 60, cut: 0.3, strength: 0.6 },
    rim: { color: 0xffffff, power: 1.8, cut: 0.2, strength: 0.9 }, hatch: 0, haze: 0.4, outline: true, outlineWidth: 1.15,
  },
  hazard: {
    base: 0xffb03a,
    bands: [{ at: 0, color: 0x5a3a1a }, { at: 0.45, color: 0xc08a3a }, { at: 0.7, color: 0xfff0c0 }],
    spec: { strength: 0.3, power: 30, cut: 0.45 }, rim: { color: 0xffd27a, power: 2.4, cut: 0.4, strength: 0.6 },
    hatch: 0.18, haze: 0.8, pattern: 4, patternScale: 1, patternA: 0x1a1030, patternGlow: 0.1, outline: true, outlineWidth: 0.9,
  },
  digital: {
    base: 0x2a1a5e,
    bands: [{ at: 0, color: 0x160e3a }, { at: 0.5, color: 0x5a3ac8 }, { at: 0.76, color: 0xb8a0ff }],
    spec: { strength: 0.2, power: 40, cut: 0.5 }, rim: { color: 0x7b3bff, power: 2.0, cut: 0.28, strength: 1.0 },
    hatch: 0.1, haze: 0.7, pattern: 5, patternScale: 1, patternA: 0x4de8ff, patternGlow: 0.85, outline: true, outlineWidth: 0.9,
  },
  foliage: {
    base: 0x6ad86a,
    bands: [{ at: 0, color: 0x1e3a2a }, { at: 0.46, color: 0x4a8f4a }, { at: 0.72, color: 0xc8ff8a }],
    spec: { strength: 0.12, power: 20, cut: 0.6 }, rim: { color: 0xb6ff3d, power: 2.6, cut: 0.4, strength: 0.5 },
    hatch: 0.3, haze: 0.9, outline: true, outlineWidth: 0.8,
  },
  decor: {
    base: 0xcfc4f2,
    bands: [{ at: 0, color: 0x352a5e }, { at: 0.45, color: 0x8478b8 }, { at: 0.7, color: 0xe8e0ff }],
    spec: { strength: 0.25, power: 26, cut: 0.5 }, rim: { color: 0x9ef0ff, power: 2.6, cut: 0.42, strength: 0.5 },
    hatch: 0.24, haze: 0.95, outline: true, outlineWidth: 0.85,
  },
};

export interface CelMaterialOptions extends Partial<CelSpec> { transparent?: boolean; }

export class MaterialLibrary {
  private cache = new Map<string, ShaderMaterial>();
  private matcaps = new Map<string, Texture>();
  private hatch: Texture;
  readonly all: ShaderMaterial[] = [];
  private resolution = new Vector2(1920, 1080);
  private light = new Vector3(0.4, 0.8, 0.45).normalize();
  private lightColor = new Color(0xffffff);
  private ambient = new Color(0x4a3a8c);
  private haze = new Color(0xc86bb4);
  time = 0;

  constructor() {
    this.hatch = makeHatchTexture(64);
    this.matcaps.set('chrome', makeMatcap(0x8fa8d8, 0x4a5a90, 0x22243f, 0xffffff));
    this.matcaps.set('sky', makeMatcap(0x9ef0ff, 0x3f7fd0, 0x1a2a5e, 0xffffff));
  }

  /** Materials are cached by class + override key so geometry batches share them. */
  get(cls: MatClass, overrides?: CelMaterialOptions, key?: string): ShaderMaterial {
    const id = cls + (key ? '#' + key : '');
    const hit = this.cache.get(id);
    if (hit) return hit;
    const spec: CelSpec = Object.assign({}, SPECS[cls], overrides || {});
    const mat = this.build(spec, overrides && overrides.transparent);
    (mat as any).celClass = cls;
    (mat as any).celSpec = spec;
    this.cache.set(id, mat);
    this.all.push(mat);
    return mat;
  }

  specFor(cls: MatClass): CelSpec { return SPECS[cls]; }

  private build(spec: CelSpec, transparent?: boolean): ShaderMaterial {
    const spc = spec.spec || {};
    const rim = spec.rim || {};
    const mat = new ShaderMaterial({
      vertexShader: CEL_VERTEX,
      fragmentShader: CEL_FRAGMENT,
      transparent: transparent || (spec.opacity !== undefined && spec.opacity < 1),
      side: FrontSide,
      uniforms: {
        uRamp: { value: makeRampTexture(spec.bands) },
        uMatcap: { value: this.matcaps.get(spec.matcapKey || 'chrome') },
        uHatch: { value: this.hatch },
        uBaseColor: { value: new Color(spec.base) },
        uLightDir: { value: this.light },
        uLightColor: { value: this.lightColor },
        uAmbientColor: { value: this.ambient },
        uAmbientStrength: { value: spec.ambient !== undefined ? spec.ambient : 0.24 },
        uSpecColor: { value: new Color(spc.color !== undefined ? spc.color : 0xffffff) },
        uSpecPower: { value: spc.power !== undefined ? spc.power : 30 },
        uSpecCut: { value: spc.cut !== undefined ? spc.cut : 0.45 },
        uSpecStrength: { value: spc.strength !== undefined ? spc.strength : 0.4 },
        uRimColor: { value: new Color(rim.color !== undefined ? rim.color : 0x9ef0ff) },
        uRimPower: { value: rim.power !== undefined ? rim.power : 2.6 },
        uRimCut: { value: rim.cut !== undefined ? rim.cut : 0.4 },
        uRimStrength: { value: rim.strength !== undefined ? rim.strength : 0.6 },
        uMatcapStrength: { value: spec.matcap || 0 },
        uHatchStrength: { value: spec.hatch !== undefined ? spec.hatch : 0.2 },
        uHatchScale: { value: 26 },
        uHatchBand: { value: spec.hatchBand !== undefined ? spec.hatchBand : 0.44 },
        uResolution: { value: this.resolution },
        uHaze: { value: this.haze },
        uHazeNear: { value: 90 },
        uHazeFar: { value: 900 },
        uHazeBands: { value: 4 },
        uHazeMax: { value: spec.haze !== undefined ? spec.haze : 0.9 },
        uEmissiveColor: { value: new Color(spec.emissiveColor !== undefined ? spec.emissiveColor : 0xffffff) },
        uEmissive: { value: spec.emissive || 0 },
        uOpacity: { value: spec.opacity !== undefined ? spec.opacity : 1 },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uFlashColor: { value: new Color(0xffffff) },
        uPattern: { value: spec.pattern || 0 },
        uPatternScale: { value: spec.patternScale || 1 },
        uPatternA: { value: new Color(spec.patternA !== undefined ? spec.patternA : 0x8fa2c8) },
        uPatternB: { value: new Color(spec.patternB !== undefined ? spec.patternB : 0xffd27a) },
        uPatternGlow: { value: spec.patternGlow !== undefined ? spec.patternGlow : 0.9 },
        uScaleHint: { value: new Vector3(1, 1, 1) },
        uWobble: { value: 0 },
      },
    });
    return mat;
  }

  setResolution(w: number, h: number) { this.resolution.set(w, h); }

  /** District lighting is blended, not switched, so borough transitions never pop. */
  applyDistrict(style: DistrictStyle, blend = 1) {
    const l = new Vector3(style.lightDir[0], style.lightDir[1], style.lightDir[2]).normalize();
    this.light.lerp(l, blend).normalize();
    this.lightColor.lerp(new Color(style.lightColor), blend);
    this.ambient.lerp(new Color(style.ambient), blend);
    this.haze.lerp(new Color(style.haze), blend);
  }

  update(dt: number) {
    this.time += dt;
    const all = this.all;
    // lib.all also holds outline materials, which have no time uniform.
    for (let i = 0; i < all.length; i++) { const u = all[i].uniforms.uTime; if (u) u.value = this.time; }
  }
}
