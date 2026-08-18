import { BufferGeometry, BufferAttribute, Mesh, InstancedMesh, ShaderMaterial, BackSide, Color, Object3D } from 'three';

// INVERTED-HULL OUTLINES
// The mesh is drawn a second time with BackSide, pushed along a smoothed normal.
// Two details separate this from the usual cheap version:
//  1. the push is computed in view space and scaled by distance, so a line keeps a
//     constant pixel width instead of fattening up close and vanishing far away;
//  2. width is modulated by per-vertex curvature, so lines taper on flat panels and
//     thicken into creases the way a deliberate ink stroke would.

const OUTLINE_VERT = /* glsl */ `
attribute vec3 aSmoothNormal;
attribute float aCurvature;

uniform float uWidth;          // base stroke width in pixels
uniform float uUnitsPerPixel;  // view-space units per pixel at unit depth
uniform float uCurveBoost;
uniform float uMinPixels;
uniform float uMaxPixels;

varying float vFade;

void main() {
  vec3 sn = aSmoothNormal;
  #ifdef USE_INSTANCING
    mat4 im = instanceMatrix;
    vec4 worldPos = modelMatrix * im * vec4(position, 1.0);
    vec3 n = normalize(mat3(im) * sn);
    vec3 viewNormal = normalize(mat3(viewMatrix) * normalize(mat3(modelMatrix) * n));
  #else
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vec3 viewNormal = normalize(mat3(viewMatrix) * normalize(mat3(modelMatrix) * sn));
  #endif

  vec4 viewPos = viewMatrix * worldPos;
  float depth = max(0.05, -viewPos.z);

  // Curvature thickens creases; distance is compensated so width is screen-constant.
  float px = uWidth * (1.0 + uCurveBoost * aCurvature);
  px = clamp(px, uMinPixels, uMaxPixels);
  float offset = px * uUnitsPerPixel * depth;

  viewPos.xyz += viewNormal * offset;
  vFade = clamp(depth / 700.0, 0.0, 1.0);
  gl_Position = projectionMatrix * viewPos;
}
`;

const OUTLINE_FRAG = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uFarInk;
varying float vFade;
void main() {
  // Distant ink lifts toward the atmospheric tone in hard steps so far silhouettes
  // stay graphic instead of punching black holes in the skyline.
  float band = floor(vFade * 3.0 + 0.4) / 3.0;
  gl_FragColor = vec4(mix(uInk, uFarInk, band * 0.75), 1.0);
}
`;

export function makeOutlineMaterial(ink = 0x0b0718, farInk = 0x4a2a6e, width = 2.4, curveBoost = 1.1): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: BackSide,
    uniforms: {
      uInk: { value: new Color(ink) },
      uFarInk: { value: new Color(farInk) },
      uWidth: { value: width },
      uUnitsPerPixel: { value: 0.0016 },
      uCurveBoost: { value: curveBoost },
      uMinPixels: { value: 1.15 },
      uMaxPixels: { value: 5.5 },
    },
  });
}

const keyOf = (x: number, y: number, z: number) =>
  (Math.round(x * 200) / 200) + '_' + (Math.round(y * 200) / 200) + '_' + (Math.round(z * 200) / 200);

/**
 * Adds aSmoothNormal + aCurvature to a geometry. Vertices that share a position but
 * were split for hard shading get a single averaged normal, which is what stops the
 * hull from cracking open at box corners and producing broken outlines.
 */
export function prepareOutlineGeometry(geo: BufferGeometry): BufferGeometry {
  if (geo.getAttribute('aSmoothNormal')) return geo;
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const pos = geo.getAttribute('position') as BufferAttribute;
  const nrm = geo.getAttribute('normal') as BufferAttribute;
  const count = pos.count;
  const groups = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const k = keyOf(pos.getX(i), pos.getY(i), pos.getZ(i));
    let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); }
    g.push(i);
  }
  const smooth = new Float32Array(count * 3);
  const curve = new Float32Array(count);
  groups.forEach((idx) => {
    let ax = 0, ay = 0, az = 0;
    for (const i of idx) { ax += nrm.getX(i); ay += nrm.getY(i); az += nrm.getZ(i); }
    const len = Math.hypot(ax, ay, az) || 1;
    ax /= len; ay /= len; az /= len;
    for (const i of idx) {
      smooth[i * 3] = ax; smooth[i * 3 + 1] = ay; smooth[i * 3 + 2] = az;
      const d = nrm.getX(i) * ax + nrm.getY(i) * ay + nrm.getZ(i) * az;
      curve[i] = Math.min(1, Math.max(0, (1 - d) * 1.6));
    }
  });
  geo.setAttribute('aSmoothNormal', new BufferAttribute(smooth, 3));
  geo.setAttribute('aCurvature', new BufferAttribute(curve, 1));
  return geo;
}

/**
 * Builds the hull twin for a mesh. Geometry and the instance matrix buffer are shared
 * with the source mesh, so an outline costs one extra draw call and zero extra memory.
 */
export function attachOutline(mesh: Mesh | InstancedMesh, material: ShaderMaterial): Mesh | InstancedMesh {
  prepareOutlineGeometry(mesh.geometry as BufferGeometry);
  let twin: Mesh | InstancedMesh;
  if ((mesh as InstancedMesh).isInstancedMesh) {
    const src = mesh as InstancedMesh;
    const im = new InstancedMesh(src.geometry, material, src.count);
    im.instanceMatrix = src.instanceMatrix;
    im.count = src.count;
    twin = im;
  } else {
    twin = new Mesh(mesh.geometry, material);
  }
  twin.frustumCulled = mesh.frustumCulled;
  twin.renderOrder = (mesh.renderOrder || 0) - 1;
  (twin as any).isOutline = true;
  (mesh as any).outlineTwin = twin;
  return twin;
}

/** Mirrors a transform hierarchy for outline twins parented under animated bones. */
export function outlineForHierarchy(root: Object3D, material: ShaderMaterial, holder: Object3D) {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!(m as any).isMesh) return;
    if ((m as any).isOutline || (m as any).noOutline) return;
    const twin = attachOutline(m, material);
    m.add(twin);
  });
  return holder;
}
