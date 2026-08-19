/**
 * Shared render uniforms. Every cel material references *these exact objects*,
 * so writing `Shared.sunDir.value` once updates the whole scene — no per-material
 * uniform walk, no per-frame allocation.
 */
import * as THREE from 'three';
import { C, hexToRgb } from './Palette';

const col = (h: string) => new THREE.Color().setRGB(...hexToRgb(h), THREE.SRGBColorSpace);

export const Shared = {
  time: { value: 0 },
  /** dilated game time — animation that must freeze during hit-stop uses this */
  gtime: { value: 0 },
  resolution: { value: new THREE.Vector2(1920, 1080) },
  cameraFar: { value: 3000 },
  cameraNear: { value: 0.2 },

  sunDir: { value: new THREE.Vector3(-0.42, 0.58, -0.70).normalize() },
  sunColor: { value: col(C.cream) },
  ambSky: { value: col('#6a4aa8') },
  ambGround: { value: col('#54233f') },
  /** overall exposure of the ramp lookup — nudged per zone */
  lightGain: { value: 1.0 },

  fogColor: { value: col('#b85a9c') },
  fogColorHi: { value: col('#4b1d8f') },
  fogNear: { value: 140 },
  fogFar: { value: 1250 },
  fogBands: { value: 5 },
  fogStrength: { value: 0.92 },

  // shadow map
  shadowMap: { value: null as THREE.Texture | null },
  shadowMatrix: { value: new THREE.Matrix4() },
  shadowTexel: { value: 1 / 2048 },
  shadowStrength: { value: 1.0 },
  shadowBias: { value: 0.0016 },

  hatchMap: { value: null as THREE.Texture | null },
  hatchScale: { value: 3.4 },
  noiseMap: { value: null as THREE.Texture | null },

  /** global ink tint pushed by the grade so lines sit in the palette */
  inkTint: { value: col('#170c26') },
  /** 0..1 white-out used for one-frame impact flashes on geometry */
  flash: { value: 0 },
};

export function updateSharedResolution(w: number, h: number) {
  Shared.resolution.value.set(w, h);
}
