/**
 * Outline — inverted-hull ink lines.
 *
 * Two things make this read as deliberate hand-inking instead of the usual
 * "scaled duplicate mesh" look:
 *
 *  1. WELDED NORMALS. Procedural geometry is full of split vertices (every box
 *     face has its own normals). Pushing along those gives torn corners. We
 *     weld by position, average the normals, and store the result in an extra
 *     attribute on the *same* BufferGeometry — so the hull mesh shares geometry
 *     with the surface mesh and costs no extra vertex memory.
 *
 *  2. PIXEL-CONSTANT WIDTH + CURVATURE TAPER. The push is computed in view
 *     space scaled by view depth and the projection, so a line is exactly N
 *     pixels wide at any distance. On top of that, thickness is modulated by
 *     per-vertex curvature (sharp corners get a fatter stroke, flat expanses
 *     get a hairline) and tapered with distance so far silhouettes read as
 *     thin graphic edges rather than a black mess.
 */
import * as THREE from 'three';
import { Shared } from './Shared';
import { MAT_CLASSES, type MatClassName, hexToRgb } from './Palette';

const OUT_NORMAL = 'oNormal';
const OUT_CURV = 'oCurv';

/**
 * Adds `oNormal` (welded, area-weighted smooth normal) and `oCurv` (0..1 local
 * normal spread) to a geometry. Idempotent and cached on the geometry itself.
 */
export function prepOutline(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geo.getAttribute(OUT_NORMAL)) return geo;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  let nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!nrm) { geo.computeVertexNormals(); nrm = geo.getAttribute('normal') as THREE.BufferAttribute; }
  const n = pos.count;

  // --- weld by quantised position ---
  const key = new Map<string, number>();
  const group = new Int32Array(n);
  const gx: number[] = [], gy: number[] = [], gz: number[] = [];
  const acc: number[] = [];
  const Q = 1e4;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * Q)},${Math.round(pos.getY(i) * Q)},${Math.round(pos.getZ(i) * Q)}`;
    let g = key.get(k);
    if (g === undefined) { g = gx.length; key.set(k, g); gx.push(0); gy.push(0); gz.push(0); acc.push(0); }
    group[i] = g;
    gx[g] += nrm.getX(i); gy[g] += nrm.getY(i); gz[g] += nrm.getZ(i);
    acc[g]++;
  }
  for (let g = 0; g < gx.length; g++) {
    const l = Math.hypot(gx[g], gy[g], gz[g]) || 1;
    gx[g] /= l; gy[g] /= l; gz[g] /= l;
  }

  // --- curvature = 1 - min(dot(faceNormal, smoothNormal)) over the group ---
  const spread = new Float32Array(gx.length);
  for (let i = 0; i < n; i++) {
    const g = group[i];
    const d = nrm.getX(i) * gx[g] + nrm.getY(i) * gy[g] + nrm.getZ(i) * gz[g];
    const s = 1 - Math.max(-1, Math.min(1, d));
    if (s > spread[g]) spread[g] = s;
  }

  const on = new Float32Array(n * 3);
  const oc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = group[i];
    on[i * 3] = gx[g]; on[i * 3 + 1] = gy[g]; on[i * 3 + 2] = gz[g];
    // spread of 0 = flat, ~1 = a 90° corner. Remap to a usable 0..1 stroke weight.
    oc[i] = Math.min(1, spread[g] * 1.15);
  }
  geo.setAttribute(OUT_NORMAL, new THREE.BufferAttribute(on, 3));
  geo.setAttribute(OUT_CURV, new THREE.BufferAttribute(oc, 1));
  return geo;
}

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 oNormal;
in float oCurv;
#ifdef USE_INSTANCING
in mat4 instanceMatrix;
#endif
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
uniform vec2 resolution;
uniform float uWidth, uCurvBoost, uNear, uFar, uTaper, uMinW;
out float vFade;

void main() {
  mat4 model = modelMatrix;
#ifdef USE_INSTANCING
  model = modelMatrix * instanceMatrix;
#endif
  vec4 wp = model * vec4(position, 1.0);
  mat3 mn = mat3(model);
  vec3 sc = vec3(length(mn[0]), length(mn[1]), length(mn[2]));
  vec3 nw = normalize(mn * (oNormal / max(sc * sc, vec3(1e-6))));

  vec4 vp = viewMatrix * wp;
  vec3 nv = normalize(mat3(viewMatrix) * nw);
  float dist = -vp.z;

  // thickness in pixels: curvature thickens corners, distance tapers the stroke
  float curv = mix(0.62, 1.0 + uCurvBoost, clamp(oCurv, 0.0, 1.0));
  float taper = mix(1.0, uTaper, clamp((dist - uNear) / max(uFar - uNear, 1.0), 0.0, 1.0));
  float wpx = max(uMinW, uWidth * curv * taper);

  // view-space push that lands exactly wpx pixels wide after projection
  float k = 2.0 * dist / (projectionMatrix[1][1] * resolution.y);
  vp.xyz += nv * (wpx * k);

  vFade = taper;
  gl_Position = projectionMatrix * vp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gNormalDepth;
in float vFade;
uniform vec3 uInk, fogColor;
uniform float uAtmos, flash;
void main() {
  // Distant ink lifts toward the atmosphere so silhouettes layer instead of
  // stacking into a black smear.
  vec3 c = mix(uInk, fogColor, (1.0 - vFade) * uAtmos);
  c = mix(c, vec3(1.0), flash);
  gColor = vec4(c, 1.0);
  // Ink must not create a second edge in the screen-space pass: alpha 0 keeps
  // the normal/depth target untouched, and depth-write still occludes correctly.
  gNormalDepth = vec4(0.0);
}
`;

export interface OutlineOptions {
  cls?: MatClassName;
  color?: string;
  width?: number;
  curvBoost?: number;
  taper?: number;
  near?: number;
  far?: number;
  minWidth?: number;
  atmos?: number;
  instanced?: boolean;
}

const cache = new Map<string, THREE.RawShaderMaterial>();

export function outlineMaterial(o: OutlineOptions = {}): THREE.RawShaderMaterial {
  const cls = o.cls ?? 'concrete';
  const mc = MAT_CLASSES[cls];
  const width = o.width ?? mc.ink.width;
  const ink = o.color ?? mc.ink.color;
  const key = `${cls}|${width}|${ink}|${o.instanced ? 1 : 0}|${o.taper ?? 0.5}|${o.curvBoost ?? 0.35}|${o.atmos ?? 0.7}|${o.far ?? 700}`;
  const hit = cache.get(key); if (hit) return hit;

  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: o.instanced ? { USE_INSTANCING: '' } : {},
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      resolution: Shared.resolution,
      fogColor: Shared.fogColor,
      flash: Shared.flash,
      uWidth: { value: width },
      uCurvBoost: { value: o.curvBoost ?? 0.35 },
      uTaper: { value: o.taper ?? 0.5 },
      uNear: { value: o.near ?? 30 },
      uFar: { value: o.far ?? 700 },
      uMinW: { value: o.minWidth ?? 0.85 },
      uAtmos: { value: o.atmos ?? 0.7 },
      uInk: { value: new THREE.Color().setRGB(...hexToRgb(ink), THREE.SRGBColorSpace) },
    },
    side: THREE.BackSide,
    depthWrite: true,
    depthTest: true,
    transparent: false,
  });
  m.name = 'ink:' + cls;
  cache.set(key, m);
  return m;
}

/**
 * Attaches an ink hull to a mesh. The hull shares the source geometry, sits on
 * layer 1 (drawn by the main camera, skipped by the shadow camera) and inherits
 * the parent transform by being a child.
 */
export function addOutline(mesh: THREE.Mesh, o: OutlineOptions = {}): THREE.Mesh {
  prepOutline(mesh.geometry);
  const inst = mesh instanceof THREE.InstancedMesh;
  const mat = outlineMaterial({ ...o, instanced: inst });
  let hull: THREE.Mesh;
  if (inst) {
    const im = mesh as THREE.InstancedMesh;
    const h = new THREE.InstancedMesh(mesh.geometry, mat, im.count);
    h.instanceMatrix = im.instanceMatrix;   // shared buffer: zero extra memory
    h.count = im.count;
    h.frustumCulled = im.frustumCulled;
    hull = h;
  } else {
    hull = new THREE.Mesh(mesh.geometry, mat);
  }
  hull.name = mesh.name + ':ink';
  hull.layers.set(1);
  hull.renderOrder = (mesh.renderOrder ?? 0) - 1;
  hull.castShadow = false;
  hull.matrixAutoUpdate = false;
  hull.matrix.identity();
  mesh.add(hull);
  (mesh as any).__ink = hull;
  return hull;
}

/** Recursively ink every mesh under a root, using each mesh's own material class. */
export function inkTree(root: THREE.Object3D, o: OutlineOptions = {}) {
  const targets: THREE.Mesh[] = [];
  root.traverse((c) => {
    if ((c as THREE.Mesh).isMesh && !(c as any).__ink && !c.name.endsWith(':ink') && !(c as any).noInk) {
      targets.push(c as THREE.Mesh);
    }
  });
  for (const m of targets) {
    const cls: MatClassName = (m.material as any)?.celClass ?? o.cls ?? 'concrete';
    addOutline(m, { ...o, cls: o.cls ?? cls });
  }
}

export function clearOutlineCache() { for (const m of cache.values()) m.dispose(); cache.clear(); }
