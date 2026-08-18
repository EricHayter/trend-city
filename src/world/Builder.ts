import { BufferGeometry, BufferAttribute, BoxGeometry, CylinderGeometry, IcosahedronGeometry,
  InstancedMesh, Matrix4, Group, Object3D, Vector3, ShaderMaterial, Color } from 'three';
import { MaterialLibrary, MatClass } from '../render/CelMaterial';
import { makeOutlineMaterial, prepareOutlineGeometry, attachOutline } from '../render/Outline';
import { LAYER_OUTLINE } from '../render/Pipeline';
import { DistrictStyle } from '../render/Palette';
import { Solid } from './Types';

export type GeoKey = 'box' | 'cyl' | 'tube' | 'sphere' | 'wedge' | 'pole';

/** Triangular prism, used for ramps and roof wedges. Unit sized, apex along +Y at -Z. */
function makeWedge(): BufferGeometry {
  const g = new BufferGeometry();
  const v: number[] = [];
  const push = (a: number[], b: number[], c: number[]) => { v.push(...a, ...b, ...c); };
  const A = [-0.5, -0.5, 0.5], B = [0.5, -0.5, 0.5], C = [0.5, -0.5, -0.5], D = [-0.5, -0.5, -0.5];
  const E = [-0.5, 0.5, -0.5], F = [0.5, 0.5, -0.5];
  push(A, B, C); push(A, C, D);          // base
  push(D, C, F); push(D, F, E);          // back wall
  push(A, E, F); push(A, F, B);          // slope
  push(A, D, E);                          // left
  push(B, F, C);                          // right
  g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Shared geometry pool. Six primitives are reused for the entire borough; variation
 * comes from per-instance transforms and procedural surface patterns, not from unique
 * meshes. This is what keeps a dense city inside a handful of draw calls.
 */
export class GeometryLibrary {
  private map = new Map<GeoKey, BufferGeometry>();
  get(key: GeoKey): BufferGeometry {
    let g = this.map.get(key);
    if (g) return g;
    switch (key) {
      case 'box': g = new BoxGeometry(1, 1, 1); break;
      case 'cyl': g = new CylinderGeometry(0.5, 0.5, 1, 14, 1); break;
      case 'tube': g = new CylinderGeometry(0.5, 0.5, 1, 9, 1); break;
      case 'pole': g = new CylinderGeometry(0.5, 0.5, 1, 6, 1); break;
      case 'sphere': g = new IcosahedronGeometry(0.5, 1); break;
      case 'wedge': g = makeWedge(); break;
    }
    prepareOutlineGeometry(g!);
    this.map.set(key, g!);
    return g!;
  }
}

interface Batch {
  geo: GeoKey;
  cls: MatClass;
  matKey: string;
  outline: boolean;
  outlineWidth: number;
  matrices: number[];
}

export interface Chunk {
  index: number;
  group: Group;
  center: Vector3;
  radius: number;
  active: boolean;
  district: number;
  triangles: number;
}

/**
 * Accumulates instances per chunk, then bakes them into InstancedMesh batches with
 * paired inverted-hull twins that share the same instance buffer.
 */
export class WorldBuilder {
  private batches = new Map<string, Batch>();
  private chunkBatches = new Map<number, Map<string, Batch>>();
  readonly geo = new GeometryLibrary();
  readonly outlineMaterials: ShaderMaterial[] = [];
  private outlineCache = new Map<string, ShaderMaterial>();
  private tmp = new Matrix4();

  constructor(private lib: MaterialLibrary) {}

  private outlineMat(width: number, ink: number, farInk: number): ShaderMaterial {
    const key = width.toFixed(2) + '_' + ink;
    let m = this.outlineCache.get(key);
    if (!m) {
      m = makeOutlineMaterial(ink, farInk, width);
      this.outlineCache.set(key, m);
      this.outlineMaterials.push(m);
    }
    return m;
  }

  /** Queue one instance. matKey lets two districts share a class with different colour. */
  push(chunk: number, geo: GeoKey, cls: MatClass, matKey: string, m: Matrix4, outline: boolean, outlineWidth = 1) {
    let per = this.chunkBatches.get(chunk);
    if (!per) { per = new Map(); this.chunkBatches.set(chunk, per); }
    const key = geo + '|' + cls + '|' + matKey + '|' + (outline ? outlineWidth.toFixed(2) : 'n');
    let b = per.get(key);
    if (!b) {
      b = { geo, cls, matKey, outline, outlineWidth, matrices: [] };
      per.set(key, b);
    }
    for (let i = 0; i < 16; i++) b.matrices.push(m.elements[i]);
  }

  pushTRS(chunk: number, geo: GeoKey, cls: MatClass, matKey: string, pos: Vector3, scale: Vector3, quat: any, outline: boolean, outlineWidth = 1) {
    this.tmp.compose(pos, quat, scale);
    this.push(chunk, geo, cls, matKey, this.tmp, outline, outlineWidth);
  }

  /** Bakes every queued chunk into scene-ready groups. */
  bake(resolve: (matKey: string) => any, chunkDistrict: (c: number) => number): Chunk[] {
    const chunks: Chunk[] = [];
    this.chunkBatches.forEach((per, index) => {
      const group = new Group();
      group.matrixAutoUpdate = false;
      const center = new Vector3();
      let n = 0;
      let tris = 0;
      per.forEach((b) => {
        const count = b.matrices.length / 16;
        if (count === 0) return;
        const geo = this.geo.get(b.geo);
        const overrides = resolve(b.matKey) || {};
        const mat = this.lib.get(b.cls, overrides, b.matKey);
        const mesh = new InstancedMesh(geo, mat, count);
        mesh.frustumCulled = true;
        const arr = (mesh.instanceMatrix.array as Float32Array);
        for (let i = 0; i < b.matrices.length; i++) arr[i] = b.matrices[i];
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
        tris += (geo.getAttribute('position').count / 3) * count;
        for (let i = 0; i < count; i++) {
          center.x += b.matrices[i * 16 + 12];
          center.y += b.matrices[i * 16 + 13];
          center.z += b.matrices[i * 16 + 14];
          n++;
        }
        if (b.outline) {
          const om = this.outlineMat(2.1 * b.outlineWidth, 0x120a26, 0x4a2a6e);
          const twin = attachOutline(mesh, om) as InstancedMesh;
          twin.layers.set(LAYER_OUTLINE);
          twin.frustumCulled = true;
          twin.boundingSphere = mesh.boundingSphere;
          group.add(twin);
          tris += (geo.getAttribute('position').count / 3) * count;
        }
      });
      if (n > 0) center.divideScalar(n);
      let radius = 40;
      per.forEach((b) => {
        const count = b.matrices.length / 16;
        for (let i = 0; i < count; i++) {
          const dx = b.matrices[i * 16 + 12] - center.x;
          const dy = b.matrices[i * 16 + 13] - center.y;
          const dz = b.matrices[i * 16 + 14] - center.z;
          radius = Math.max(radius, Math.hypot(dx, dy, dz) + 12);
        }
      });
      group.updateMatrix();
      chunks.push({ index, group, center, radius, active: true, district: chunkDistrict(index), triangles: Math.round(tris) });
    });
    chunks.sort((a, b) => a.index - b.index);
    return chunks;
  }

  clear() { this.chunkBatches.clear(); }
}

/**
 * CHUNK STREAMING
 * Chunks are activated by distance along the stage rather than by frustum alone, so
 * geometry behind the player stays live long enough for a look-back camera swing while
 * everything far ahead costs nothing.
 */
export class WorldStreamer {
  constructor(public chunks: Chunk[], public root: Group, public aheadRadius = 520, public behindRadius = 240) {
    for (const c of chunks) root.add(c.group);
  }

  update(playerPos: Vector3, forward: Vector3) {
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const dx = c.center.x - playerPos.x;
      const dz = c.center.z - playerPos.z;
      const dy = c.center.y - playerPos.y;
      const dist = Math.hypot(dx, dy, dz) - c.radius;
      const ahead = dx * forward.x + dz * forward.z > 0;
      const want = dist < (ahead ? this.aheadRadius : this.behindRadius);
      if (want !== c.active) {
        c.active = want;
        c.group.visible = want;
      }
    }
  }

  get activeCount() { let n = 0; for (const c of this.chunks) if (c.active) n++; return n; }
  get activeTriangles() { let n = 0; for (const c of this.chunks) if (c.active) n += c.triangles; return n; }
}
