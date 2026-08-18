import { BufferGeometry, BufferAttribute, Mesh, Object3D, Group, Vector3, Quaternion, ShaderMaterial } from 'three';
import { MaterialLibrary } from '../render/CelMaterial';
import { makeOutlineMaterial, prepareOutlineGeometry, attachOutline } from '../render/Outline';
import { LAYER_OUTLINE } from '../render/Pipeline';

/**
 * Tapered box: eight corners with independent top and bottom footprints. Every limb,
 * boot and shoulder plate on the character is one of these, which is what gives the
 * silhouette hard angular breaks instead of the tube-and-sphere look.
 */
export function taperBox(bw: number, bd: number, tw: number, td: number, h: number, shear = 0): BufferGeometry {
  const g = new BufferGeometry();
  const b = h * -0.5, t = h * 0.5;
  const v: number[][] = [
    [-bw / 2, b, -bd / 2], [bw / 2, b, -bd / 2], [bw / 2, b, bd / 2], [-bw / 2, b, bd / 2],
    [-tw / 2 + shear, t, -td / 2], [tw / 2 + shear, t, -td / 2], [tw / 2 + shear, t, td / 2], [-tw / 2 + shear, t, td / 2],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3],       // bottom
    [4, 6, 5], [4, 7, 6],       // top
    [0, 5, 1], [0, 4, 5],       // -z
    [2, 6, 7], [2, 7, 3],       // +z
    [1, 6, 2], [1, 5, 6],       // +x
    [3, 7, 4], [3, 4, 0],       // -x
  ];
  const pos: number[] = [];
  for (const f of faces) for (const i of f) pos.push(v[i][0], v[i][1], v[i][2]);
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  prepareOutlineGeometry(g);
  return g;
}

/** Four-sided spike, used for hair shards, boot fins and shoulder blades. */
export function shard(w: number, d: number, h: number, tipShear = 0): BufferGeometry {
  const g = new BufferGeometry();
  const v: number[][] = [
    [-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, 0, d / 2], [-w / 2, 0, d / 2], [tipShear, h, 0],
  ];
  const faces = [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [0, 3, 2], [0, 2, 1]];
  const pos: number[] = [];
  for (const f of faces) for (const i of f) pos.push(v[i][0], v[i][1], v[i][2]);
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  prepareOutlineGeometry(g);
  return g;
}

export interface Bones {
  root: Object3D; hips: Object3D; chest: Object3D; neck: Object3D; head: Object3D;
  armL: Object3D; foreL: Object3D; handL: Object3D;
  armR: Object3D; foreR: Object3D; handR: Object3D;
  thighL: Object3D; shinL: Object3D; footL: Object3D;
  thighR: Object3D; shinR: Object3D; footR: Object3D;
  tail: Object3D[];      // coat tail chain, simulated
  scarf: Object3D[];     // scarf chain, simulated
}

/**
 * VEX, the protagonist. An original digital courier: long-legged, narrow-waisted, with
 * a heavy angular collar and a split coat tail so the silhouette reads instantly at
 * speed even when the character is only forty pixels tall.
 */
export class Rig {
  readonly group = new Group();
  readonly bones: Bones;
  private outlineMat: ShaderMaterial;
  readonly outlineMaterials: ShaderMaterial[] = [];
  private flashMats: ShaderMaterial[] = [];

  constructor(lib: MaterialLibrary, accent = 0x4de8ff, cloth = 0xff3d9a) {
    const suit = lib.get('character', { base: 0x36255e }, 'vexSuit');
    const plate = lib.get('character', { base: 0xe8dcff }, 'vexPlate');
    const trim = lib.get('characterTrim', { base: 0xffffff, emissive: 0.55, emissiveColor: accent, rim: { color: accent, power: 2.0, cut: 0.28, strength: 1.2 } }, 'vexTrim');
    const coat = lib.get('cloth', { base: cloth }, 'vexCoat');
    const visor = lib.get('characterTrim', { base: 0x0d0a24, emissive: 0.9, emissiveColor: accent }, 'vexVisor');
    const core = lib.get('bossCore', { emissiveColor: accent, emissive: 1.7 }, 'vexCore');
    this.flashMats = [suit, plate, trim, coat, visor, core];
    this.outlineMat = makeOutlineMaterial(0x0a0618, 0x2a1a4e, 2.7, 1.25);
    this.outlineMaterials.push(this.outlineMat);

    const mk = (geo: BufferGeometry, mat: ShaderMaterial, parent: Object3D, x = 0, y = 0, z = 0) => {
      const m = new Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = false;
      parent.add(m);
      const twin = attachOutline(m, this.outlineMat);
      twin.layers.set(LAYER_OUTLINE);
      m.add(twin);
      return m;
    };
    const bone = (parent: Object3D, x = 0, y = 0, z = 0) => {
      const o = new Object3D();
      o.position.set(x, y, z);
      parent.add(o);
      return o;
    };

    const root = new Object3D();
    this.group.add(root);
    const hips = bone(root, 0, 0.98, 0);
    mk(taperBox(0.52, 0.36, 0.44, 0.3, 0.3), suit, hips, 0, -0.04, 0);
    const chest = bone(hips, 0, 0.2, 0);
    mk(taperBox(0.46, 0.32, 0.74, 0.38, 0.56, 0), suit, chest, 0, 0.26, 0);
    // Collar: the widest hard shape on the body, the silhouette anchor.
    mk(taperBox(0.82, 0.5, 0.62, 0.34, 0.2, -0.02), plate, chest, 0, 0.6, -0.02);
    mk(taperBox(0.26, 0.16, 0.2, 0.12, 0.16), core, chest, 0, 0.34, 0.19);
    const neck = bone(chest, 0, 0.62, 0);
    const head = bone(neck, 0, 0.1, 0);
    mk(taperBox(0.34, 0.36, 0.32, 0.3, 0.36, 0.01), plate, head, 0, 0.16, 0);
    mk(taperBox(0.3, 0.1, 0.26, 0.08, 0.12), visor, head, 0, 0.18, 0.16);
    // Hair: three swept shards, deliberately asymmetric.
    mk(shard(0.2, 0.16, 0.62, -0.34), trim, head, -0.08, 0.3, -0.04);
    mk(shard(0.16, 0.14, 0.48, -0.26), trim, head, 0.1, 0.3, -0.08);
    mk(shard(0.13, 0.12, 0.4, -0.34), trim, head, 0.0, 0.28, 0.08);

    const buildArm = (side: number) => {
      const arm = bone(chest, side * 0.42, 0.52, 0);
      mk(taperBox(0.24, 0.24, 0.18, 0.18, 0.44), suit, arm, 0, -0.22, 0);
      mk(shard(0.3, 0.26, 0.3, side * 0.1), plate, arm, side * 0.04, 0.02, 0);
      const fore = bone(arm, 0, -0.46, 0);
      mk(taperBox(0.18, 0.18, 0.15, 0.15, 0.4), plate, fore, 0, -0.2, 0);
      const hand = bone(fore, 0, -0.42, 0);
      mk(taperBox(0.2, 0.16, 0.16, 0.12, 0.22), trim, hand, 0, -0.1, 0.01);
      return { arm, fore, hand };
    };
    const L = buildArm(-1);
    const R = buildArm(1);

    const buildLeg = (side: number) => {
      const thigh = bone(hips, side * 0.2, -0.12, 0);
      mk(taperBox(0.28, 0.28, 0.22, 0.22, 0.52), suit, thigh, 0, -0.26, 0);
      const shin = bone(thigh, 0, -0.54, 0);
      mk(taperBox(0.22, 0.22, 0.2, 0.2, 0.48), suit, shin, 0, -0.24, 0);
      const foot = bone(shin, 0, -0.5, 0);
      // Boot: chunky, forward-weighted, with a fin. Reads as speed footwear.
      mk(taperBox(0.26, 0.44, 0.3, 0.3, 0.2), plate, foot, 0, -0.08, 0.06);
      mk(taperBox(0.22, 0.22, 0.16, 0.14, 0.16), trim, foot, 0, -0.16, -0.1);
      mk(shard(0.14, 0.3, 0.26, -0.16), trim, foot, side * 0.12, 0.02, -0.06);
      return { thigh, shin, foot };
    };
    const legL = buildLeg(-1);
    const legR = buildLeg(1);

    // Coat tail: two chains of tapered strips, simulated as verlet segments.
    const tail: Object3D[] = [];
    let parent: Object3D = chest;
    for (let i = 0; i < 4; i++) {
      const seg = bone(parent, 0, i === 0 ? 0.18 : -0.3, i === 0 ? -0.16 : 0);
      mk(taperBox(0.6 - i * 0.09, 0.1, 0.5 - i * 0.1, 0.08, 0.34), coat, seg, 0, -0.16, 0);
      tail.push(seg);
      parent = seg;
    }
    // Scarf: shorter chain off the collar, whips with turns.
    const scarf: Object3D[] = [];
    parent = chest;
    for (let i = 0; i < 3; i++) {
      const seg = bone(parent, i === 0 ? 0.1 : 0, i === 0 ? 0.56 : -0.24, i === 0 ? -0.1 : 0);
      mk(taperBox(0.24 - i * 0.04, 0.1, 0.2 - i * 0.04, 0.08, 0.3), coat, seg, 0, -0.14, 0);
      scarf.push(seg);
      parent = seg;
    }

    this.bones = {
      root, hips, chest, neck, head,
      armL: L.arm, foreL: L.fore, handL: L.hand,
      armR: R.arm, foreR: R.fore, handR: R.hand,
      thighL: legL.thigh, shinL: legL.shin, footL: legL.foot,
      thighR: legR.thigh, shinR: legR.shin, footR: legR.foot,
      tail, scarf,
    };
  }

  /** Hit flash drives every character material at once, so the read is unmistakable. */
  setFlash(v: number, color = 0xffffff) {
    for (const m of this.flashMats) {
      m.uniforms.uFlash.value = v;
      (m.uniforms.uFlashColor.value as any).setHex(color);
    }
  }
}
