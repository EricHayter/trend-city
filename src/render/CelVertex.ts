// Shared cel vertex stage. Handles both single meshes and InstancedMesh batches, and
// exports the object-space position scaled into metres so the fragment stage can draw
// procedural surface patterns (facade windows, panel seams, ribs) at a real-world
// density regardless of how the instance was scaled.
export const CEL_VERTEX = /* glsl */ `
uniform vec3 uScaleHint;
uniform float uTime;
uniform float uWobble;

varying vec3 vNormalV;      // view-space normal
varying vec3 vWorldNormal;  // world-space normal
varying vec3 vLocalNormal;  // object-space normal (pattern face selection)
varying vec3 vLocalMetres;  // object-space position in metres
varying vec3 vViewPos;
varying vec3 vWorldPos;
varying vec2 vUv;
varying float vPatternSeed;

void main() {
  vUv = uv;
  vLocalNormal = normal;
  vec3 pos = position;

  #ifdef USE_INSTANCING
    mat4 im = instanceMatrix;
    vec3 iscale = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
    vec4 worldPos = modelMatrix * im * vec4(pos, 1.0);
    // Box normals are axis-aligned in object space, so normalising the linearly
    // transformed normal is exact here and avoids an inverse-transpose per instance.
    vec3 n = normalize(mat3(im) * normal);
    vNormalV = normalize(normalMatrix * n);
    vWorldNormal = normalize(mat3(modelMatrix) * n);
    vLocalMetres = pos * iscale;
    vPatternSeed = im[3].x * 0.137 + im[3].z * 0.311 + im[3].y * 0.079;
  #else
    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vLocalMetres = pos * uScaleHint;
    vPatternSeed = 0.0;
  #endif

  vWorldPos = worldPos.xyz;
  vec4 viewPos = viewMatrix * worldPos;
  vViewPos = viewPos.xyz;
  gl_Position = projectionMatrix * viewPos;
}
`;

// Normal + linear depth prepass, used by the screen-space Sobel ink pass.
// Packed as RGB = view normal, A = linear depth normalised to the far plane.
export const NORMAL_DEPTH_VERTEX = /* glsl */ `
varying vec3 vNormalV;
varying float vDepth;
uniform float uFar;
void main() {
  #ifdef USE_INSTANCING
    mat4 im = instanceMatrix;
    vec3 n = normalize(mat3(im) * normal);
    vNormalV = normalize(normalMatrix * n);
    vec4 worldPos = modelMatrix * im * vec4(position, 1.0);
  #else
    vNormalV = normalize(normalMatrix * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
  #endif
  vec4 viewPos = viewMatrix * worldPos;
  vDepth = -viewPos.z / uFar;
  gl_Position = projectionMatrix * viewPos;
}
`;

export const NORMAL_DEPTH_FRAGMENT = /* glsl */ `
varying vec3 vNormalV;
varying float vDepth;
void main() {
  gl_FragColor = vec4(normalize(vNormalV) * 0.5 + 0.5, vDepth);
}
`;
