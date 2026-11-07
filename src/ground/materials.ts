import { DoubleSide, FrontSide, GLSL3, ShaderMaterial, Vector3, Vector4, type IUniform, type Texture } from 'three';
import { SCENE_LIGHT } from '../world/light';
import { SHADOW_GLSL, SHADOW_UNIFORMS } from '../world/shadowGlsl';

/**
 * Ground-cover shaders. Everything is in the Emerald Bay ENU frame (the Ground group's local
 * space). Instances: iPos = (x, y, z, scale), iQuat = rotation, iMisc = (seed, green 0..1,
 * canopy cover 0..1, z-scale).
 *
 * Output is PRE-LIT albedo (see world/light.ts): albedo * (sunVis * N.L * sunColor + ambient *
 * sky * ao) * uFlatSunInv, with the live sun of the time of day and the GPU shadow field
 * (flySunVis). Until the shadow field is on, the canopy cover baked per instance shades props
 * under the trees.
 */

/** shared by every ground material */
export const GROUND_UNIFORMS = {
  uCamLocal: { value: new Vector3() },
  /** wind strength 0..1 */
  uWind: { value: 0.6 },
};

const COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform float uFlatSunInv;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uTime;
uniform vec3 uCamLocal;
uniform float uWind;
/** effective-distance fade: (in start, in end, out start, out end) */
uniform vec4 uFade;
/** size reference for the effective distance (0 = plain distance) */
uniform float uSizeRef;
${SHADOW_GLSL}

vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

float groundHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

/** (fade in, fade out) from the effective distance: LODs cross-fade with complementary dither */
vec2 groundFade(float d) {
  return vec2(smoothstep(uFade.x, uFade.y, d), 1.0 - smoothstep(uFade.z, uFade.w, d));
}
bool groundFadeDiscard(vec2 f, vec2 fc) {
  float n = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
  return n >= f.y || n < 1.0 - f.x;
}

float groundEffDist(vec3 p, float scale) {
  float d = distance(uCamLocal, p);
  return uSizeRef > 0.0 ? d / clamp(scale / uSizeRef, 0.5, 2.5) : d;
}

/** direct sun visibility: live shadow field, or the canopy-cover fallback */
float groundSunVis(vec3 p, float canopy, float soft) {
  if (uShOn > 0.5) return flySunVis(p, soft);
  return 1.0 - 0.82 * smoothstep(0.15, 0.85, canopy);
}

vec3 groundShade(vec3 albedo, vec3 N, vec3 V, float sunVis, float ao, float trans) {
  float ndl = dot(N, uSunDir);
  float diff = max(ndl, 0.0);
  float back = trans * pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 3.0) * (1.0 - diff);
  float sky = (0.65 + 0.35 * N.z) * ao;
  vec3 lit = albedo * (sunVis * (diff + back) * uSunColor + uAmbient * sky);
  return lit * uFlatSunInv;
}

`;

const INSTANCE_ATTRS = /* glsl */ `
in vec4 iPos;
in vec4 iQuat;
in vec4 iMisc;
`;

// ------------------------------------------------------------------------------------------------
// props: rocks, pebbles, logs, stumps (scanned meshes + their textures)

const PROP_VERT = /* glsl */ `
${COMMON}
${INSTANCE_ATTRS}
out vec2 vUv;
out vec3 vNormal;
out vec3 vLocal;
out vec3 vObj;
out vec2 vFade;
out vec4 vMisc;
#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
  vec3 p = position;
  p.z *= iMisc.w;
  vec3 local = qrot(iQuat, p * iPos.w) + iPos.xyz;
  vec3 n = normalize(qrot(iQuat, normal / vec3(1.0, 1.0, iMisc.w)));
  vFade = groundFade(groundEffDist(iPos.xyz, iPos.w));
  vUv = uv;
  vNormal = n;
  vLocal = local;
  vObj = position;
  vMisc = iMisc;
  vec4 mvPosition = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  if (min(vFade.x, vFade.y) <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
}
`;

const PROP_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uMap;
uniform sampler2D uNormalMap;
/** (desaturate towards granite 0..1, albedo gain, normal strength, base occlusion height) */
uniform vec4 uLook;
uniform vec3 uTint;
in vec2 vUv;
in vec3 vNormal;
in vec3 vLocal;
in vec3 vObj;
in vec2 vFade;
in vec4 vMisc;
out vec4 fragColor;
#include <common>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  #include <clipping_planes_fragment>
  if (groundFadeDiscard(vFade, gl_FragCoord.xy)) discard;
  vec3 tex = texture(uMap, vUv).rgb;
  float seed = vMisc.x;
  // scanned rocks are African / coastal: pull them towards Sierra granite (light grey with
  // warm weathering), per instance
  float l = dot(tex, vec3(0.2126, 0.7152, 0.0722));
  vec3 granite = l * mix(vec3(1.0, 0.97, 0.92), vec3(1.05, 1.0, 0.9), fract(seed * 7.31));
  vec3 albedo = mix(tex, granite, uLook.x * (0.75 + 0.25 * fract(seed * 3.7))) * uTint * uLook.y * (0.85 + 0.3 * fract(seed * 13.1));
  vec3 N = normalize(vNormal);
  // normal map (cotangent frame from derivatives)
  vec3 dp1 = dFdx(vLocal), dp2 = dFdy(vLocal);
  vec2 duv1 = dFdx(vUv), duv2 = dFdy(vUv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-20);
  vec3 tn = texture(uNormalMap, vUv).xyz * 2.0 - 1.0;
  tn.xy *= uLook.z;
  vec3 Nm = normalize(mat3(T * invmax, B * invmax, N) * tn);
  N = gl_FrontFacing ? Nm : -Nm;
  vec3 V = normalize(uCamLocal - vLocal);
  // contact occlusion: darker where the prop meets the ground
  float ao = mix(0.45, 1.0, smoothstep(0.0, uLook.w, vObj.z * vMisc.w));
  // lichen / dust on top faces of rocks
  albedo *= mix(1.0, 1.08, smoothstep(0.6, 0.95, N.z));
  float sunVis = groundSunVis(vLocal + N * 0.08, vMisc.z, 0.4);
  fragColor = vec4(groundShade(albedo, N, V, sunVis, ao, 0.0), 1.0);
}
`;

export interface PropLook {
  desaturate: number;
  gain: number;
  normal: number;
  /** canonical height (m) over which the contact occlusion fades */
  aoHeight: number;
  tint?: [number, number, number];
}

export function createPropMaterial(map: Texture, normalMap: Texture, look: PropLook, fade: Vector4, sizeRef: number): ShaderMaterial {
  return new ShaderMaterial({
    name: 'ground-prop',
    glslVersion: GLSL3,
    uniforms: {
      ...SCENE_LIGHT,
      ...SHADOW_UNIFORMS,
      ...GROUND_UNIFORMS,
      uMap: { value: map },
      uNormalMap: { value: normalMap },
      uLook: { value: new Vector4(look.desaturate, look.gain, look.normal, look.aoHeight) },
      uTint: { value: new Vector3(...(look.tint ?? [1, 1, 1])) },
      uFade: { value: fade },
      uSizeRef: { value: sizeRef },
    } as Record<string, IUniform>,
    vertexShader: PROP_VERT,
    fragmentShader: PROP_FRAG,
    side: FrontSide,
    clipping: true,
  });
}

// ------------------------------------------------------------------------------------------------
// grass / sedge tufts

const GRASS_VERT = /* glsl */ `
${COMMON}
uniform float uGrassFar;
${INSTANCE_ATTRS}
in vec3 aGrass;
out vec3 vNormal;
out vec3 vLocal;
out vec3 vColor;
out vec2 vFade;
out float vT;
out float vSun;
#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
  float t = aGrass.x;
  float dist = groundEffDist(iPos.xyz, iPos.w);
  vec2 fade2 = groundFade(dist);
  // thin the far tufts out (and grow the survivors a little)
  float keep = mix(1.0, 0.35, smoothstep(14.0, 60.0, dist));
  if (iMisc.x > keep) fade2 = vec2(0.0);
  float fade = fade2.x * fade2.y;
  vec3 p = position;
  // shrink towards the far end (blends into the ground texture)
  float h = iPos.w * iMisc.w * mix(0.35, 1.0, 1.0 - smoothstep(uGrassFar * 0.6, uGrassFar, dist)) * mix(1.0, 1.3, 1.0 - keep);
  p.z *= h;
  p.xy *= iPos.w;
  // wind: gusts travelling across the meadow + per-blade flutter, growing with t^2
  float ph = dot(iPos.xy, vec2(0.21, 0.17));
  float gust = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 2.7 + ph * 1.9 + aGrass.y * 3.0) * 0.25;
  vec2 windDir = vec2(0.83, 0.56);
  p.xy += windDir * gust * uWind * 0.18 * h * t * t;
  p.xy += vec2(cos(aGrass.z), sin(aGrass.z)) * sin(uTime * 4.1 + aGrass.y * 17.0 + ph) * 0.03 * h * t * uWind;
  vec3 local = qrot(iQuat, p) + iPos.xyz;
  // shade mostly like the ground under the tuft (blades shadow each other), a little per blade
  vNormal = normalize(qrot(iQuat, mix(vec3(0.0, 0.0, 1.0), normalize(normal), 0.3)));
  vLocal = local;
  vT = t;
  vFade = fade2;
  // late-autumn grass: tan / straw, greener where it was green in summer, per blade variation
  float g = iMisc.y;
  // (linear albedo)
  vec3 dry = mix(vec3(0.22, 0.165, 0.08), vec3(0.33, 0.26, 0.135), aGrass.y);
  vec3 green = mix(vec3(0.045, 0.065, 0.02), vec3(0.085, 0.10, 0.035), aGrass.y);
  vec3 c = mix(dry, green, smoothstep(0.15, 0.75, g) * (0.55 + 0.45 * fract(iMisc.x * 5.3)));
  c *= mix(0.5, 1.05, t) * (0.85 + 0.3 * fract(iMisc.x * 11.7));
  c = mix(c, vec3(0.32, 0.26, 0.15), 0.3 * t * t * (1.0 - g));
  vColor = c;
  vSun = groundSunVis(local + vec3(0.0, 0.0, 0.05), iMisc.z, 0.5);
  vec4 mvPosition = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  if (fade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
}
`;

const GRASS_FRAG = /* glsl */ `
${COMMON}
in vec3 vNormal;
in vec3 vLocal;
in vec3 vColor;
in vec2 vFade;
in float vT;
in float vSun;
out vec4 fragColor;
#include <common>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  #include <clipping_planes_fragment>
  if (groundFadeDiscard(vFade, gl_FragCoord.xy)) discard;
  vec3 V = normalize(uCamLocal - vLocal);
  vec3 N = normalize(vNormal);
  float ao = mix(0.35, 1.0, smoothstep(0.0, 0.7, vT));
  fragColor = vec4(groundShade(vColor, N, V, vSun, ao, 0.6), 1.0);
}
`;

export function createGrassMaterial(fade: Vector4, far: number): ShaderMaterial {
  return new ShaderMaterial({
    name: 'ground-grass',
    glslVersion: GLSL3,
    uniforms: {
      ...SCENE_LIGHT,
      ...SHADOW_UNIFORMS,
      ...GROUND_UNIFORMS,
      uFade: { value: fade },
      uSizeRef: { value: 0 },
      uGrassFar: { value: far },
    } as Record<string, IUniform>,
    vertexShader: GRASS_VERT,
    fragmentShader: GRASS_FRAG,
    side: DoubleSide,
    clipping: true,
  });
}

// ------------------------------------------------------------------------------------------------
// shrubs (leaf-card mounds)

const SHRUB_VERT = /* glsl */ `
${COMMON}
${INSTANCE_ATTRS}
in vec2 aShrub;
out vec2 vUv;
out vec3 vNormal;
out vec3 vLocal;
out vec2 vFade;
out float vOcc;
out vec3 vTint;
out float vSun;
#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
  vec2 fade = groundFade(groundEffDist(iPos.xyz, iPos.w));
  vec3 p = position;
  // iPos.w = width, iMisc.w = height / width
  vec3 s = vec3(iPos.w, iPos.w, iPos.w * iMisc.w);
  float ph = dot(iPos.xy, vec2(0.13, 0.19));
  p.xy += vec2(0.83, 0.56) * sin(uTime * 1.1 + ph) * 0.025 * p.z * uWind;
  vec3 local = qrot(iQuat, p * s) + iPos.xyz;
  vNormal = normalize(qrot(iQuat, mix(normalize(normal / s), vec3(0.0, 0.0, 1.0), 0.35)));
  vLocal = local;
  vUv = uv;
  vFade = fade;
  vOcc = aShrub.x;
  float g = iMisc.y;
  vTint = mix(vec3(0.9, 0.86, 0.78), vec3(0.82, 0.95, 0.8), g) * (0.65 + 0.35 * fract(iMisc.x * 9.7)) * mix(0.85, 1.05, aShrub.y);
  vSun = groundSunVis(local + vNormal * 0.2, iMisc.z, 0.6);
  vec4 mvPosition = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  if (min(fade.x, fade.y) <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
}
`;

const SHRUB_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uLeaves;
in vec2 vUv;
in vec3 vNormal;
in vec3 vLocal;
in vec2 vFade;
in float vOcc;
in vec3 vTint;
in float vSun;
out vec4 fragColor;
#include <common>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  #include <clipping_planes_fragment>
  vec4 tex = texture(uLeaves, vUv);
  if (tex.a < 0.5) discard;
  if (groundFadeDiscard(vFade, gl_FragCoord.xy)) discard;
  vec3 albedo = tex.rgb / max(tex.a, 0.05) * vTint;
  vec3 V = normalize(uCamLocal - vLocal);
  vec3 N = normalize(vNormal);
  float ao = mix(0.3, 1.0, vOcc);
  // leaves inside the mound shade each other: less direct sun than a single leaf would get
  fragColor = vec4(groundShade(albedo, N, V, vSun * mix(0.25, 0.8, vOcc), ao, 0.35), 1.0);
}
`;

export function createShrubMaterial(leaves: Texture, fade: Vector4): ShaderMaterial {
  return new ShaderMaterial({
    name: 'ground-shrub',
    glslVersion: GLSL3,
    uniforms: {
      ...SCENE_LIGHT,
      ...SHADOW_UNIFORMS,
      ...GROUND_UNIFORMS,
      uLeaves: { value: leaves },
      uFade: { value: fade },
      uSizeRef: { value: 1.2 },
    } as Record<string, IUniform>,
    vertexShader: SHRUB_VERT,
    fragmentShader: SHRUB_FRAG,
    side: DoubleSide,
    clipping: true,
  });
}
