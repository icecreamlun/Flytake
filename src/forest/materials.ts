import { DoubleSide, FrontSide, GLSL3, ShaderMaterial, Vector2, Vector3, type IUniform, type Texture } from 'three';
import { PROFILE_SAMPLES, VARIANT_BASE, VARIANT_COUNT, type ConiferVariant } from './conifer';

const SNAG_VARIANT = VARIANT_BASE[3];
import { SHADOW_GLSL, SHADOW_UNIFORMS } from '../world/shadowGlsl';
import { FOREST_LIGHT, LIGHT_FUNCS, LIGHT_PARS } from './lighting';

/**
 * Forest shaders. Everything is in the Emerald Bay ENU frame (the Forest group's local space):
 *   instance i: base iPos, dims iDim = (height, crownRadius), iMisc = (variant, seed01, sunTop01,
 *   sunBase01), iFade (dithered LOD fade, see lighting.ts forestFadeDiscard).
 * A variant's geometry is canonical (variant.height tall, variant.crownRadius wide); instances
 * scale it non-uniformly and rotate it around z by a seed-derived angle.
 */

export interface ForestShared {
  uniforms: Record<string, IUniform>;
}

/** Shared per-variant tables + camera (one object referenced by every forest material). */
export function createSharedUniforms(variants: ConiferVariant[]): Record<string, IUniform> {
  const H = new Float32Array(VARIANT_COUNT);
  const R = new Float32Array(VARIANT_COUNT);
  const B = new Float32Array(VARIANT_COUNT);
  const D = new Float32Array(VARIANT_COUNT);
  const P = new Float32Array(VARIANT_COUNT * PROFILE_SAMPLES);
  const FT: Vector3[] = [];
  const BT: Vector3[] = [];
  for (const v of variants) {
    H[v.id] = v.height;
    R[v.id] = v.crownRadius;
    B[v.id] = v.boundRadius;
    D[v.id] = v.density;
    P.set(v.profile, v.id * PROFILE_SAMPLES);
    FT[v.id] = new Vector3(...v.foliageTint);
    BT[v.id] = new Vector3(...v.barkTint);
  }
  return {
    ...FOREST_LIGHT,
    ...SHADOW_UNIFORMS,
    uVarH: { value: H },
    uVarR: { value: R },
    uVarBound: { value: B },
    uVarDensity: { value: D },
    uProfile: { value: P },
    uFoliageTint: { value: FT },
    uBarkTint: { value: BT },
    uCamLocal: { value: new Vector3() },
    /** impostor fade band in effective distance: (start, end) */
    uImpostorLod: { value: new Vector2(190, 230) },
  };
}

/** per needle-card colour variation (also baked into the impostors) */
const CARD_VARIATION = /* glsl */ `
vec3 cardVariation(float r) {
  return vec3(0.95 + 0.12 * r, 1.0, 1.07 - 0.14 * r) * (0.78 + 0.44 * fract(r * 7.13));
}
`;

const VARIANT_PARS = /* glsl */ `
#define VARIANTS ${VARIANT_COUNT}
#define PROFILE_SAMPLES ${PROFILE_SAMPLES}
uniform float uVarH[VARIANTS];
uniform float uVarR[VARIANTS];
uniform float uVarBound[VARIANTS];
uniform float uVarDensity[VARIANTS];
uniform float uProfile[VARIANTS * PROFILE_SAMPLES];
uniform vec3 uFoliageTint[VARIANTS];
uniform vec3 uBarkTint[VARIANTS];
uniform vec3 uCamLocal;

float crownRadiusAt(int v, float hf) {
  float x = clamp(hf, 0.0, 1.0) * float(PROFILE_SAMPLES - 1);
  int i = min(int(floor(x)), PROFILE_SAMPLES - 2);
  float t = x - float(i);
  return mix(uProfile[v * PROFILE_SAMPLES + i], uProfile[v * PROFILE_SAMPLES + i + 1], t);
}

float treeRotation(float seed01) { return fract(seed01 * 255.0 * 0.6180339887 + 0.31) * 6.2831853; }

vec2 treeScale(int v, vec2 dim) {
  float sz = dim.x / uVarH[v];
  float sxy = clamp(dim.y / uVarR[v], 0.7 * sz, 1.4 * sz);
  return vec2(sxy, sz);
}

vec3 instanceTint(float seed01) {
  float h1 = fract(seed01 * 255.0 * 0.754877666 + 0.13);
  float h2 = fract(seed01 * 255.0 * 0.569840291 + 0.71);
  // yellower / older <-> bluer / younger, and a wide brightness range: neighbouring crowns read apart
  vec3 hue = mix(vec3(1.1, 1.02, 0.8), vec3(0.9, 0.98, 1.14), h2);
  return hue * (0.74 + 0.46 * h1 * h1);
}

/** Light direction in a tree's canonical space (ray parameter = world path length). */
vec3 canonicalLight(float rot, vec2 s) {
  float c = cos(rot), sn = sin(rot);
  vec3 L = uSunDir;
  vec2 lr = vec2(c * L.x + sn * L.y, -sn * L.x + c * L.y);
  return vec3(lr / s.x, L.z / s.y);
}

vec2 rotate2(vec2 p, float rot) {
  float c = cos(rot), s = sin(rot);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
`;

/**
 * Direct sun past the terrain and the other crowns, from the live shadow field (world/shadowGlsl.ts).
 * The field contains this tree's own crown (a cone of the lidar radius r), so it is sampled where
 * the sun ray through p leaves a cylinder of radius r around the stem; the tree's self-shadow is
 * crownTransmittance(). Falls back to the baked per-tree visibility until the field is live.
 */
const FOREST_SHADOW = /* glsl */ `
${SHADOW_GLSL}
float forestTerrainSun(vec3 p, vec3 base, float r, float fallback) {
  if (uShOn < 0.5 || uForestDebug == 5) return fallback;
  vec2 rel = p.xy - base.xy;
  float R = r + 0.6;
  float b = dot(rel, uShSun.xy);
  float c = dot(rel, rel) - R * R;
  float tExit = max(-b + sqrt(max(b * b - c, 0.0)), 0.5);
  return flySunVisOffset(p, tExit, 1.2 + 0.06 * tExit);
}
`;

// ------------------------------------------------------------------------------------------------
// instanced meshes (LOD0 / LOD1)

const MESH_VERT = /* glsl */ `
${LIGHT_PARS}
${VARIANT_PARS}
${CARD_VARIATION}
${LIGHT_FUNCS}
${FOREST_SHADOW}
in vec4 aCrown;
in vec3 iPos;
in vec2 iDim;
in vec4 iMisc;
in float iFade;
out vec2 vUv;
out vec3 vNormal;
out vec3 vLocal;
out float vAo;
out float vSun;
out float vFade;
out vec3 vTint;
out float vDesat;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  int v = int(iMisc.x + 0.5);
  vDesat = v >= ${SNAG_VARIANT} ? 0.85 : 0.0;
  float Hc = uVarH[v];
  vec2 s = treeScale(v, iDim);
  float rot = treeRotation(iMisc.y);
  vec3 p = position;
  float hf = clamp(p.z / Hc, 0.0, 1.0);

  // self-shadow and terrain shadow (before wind, canonical space)
  vec3 Lc = canonicalLight(rot, s);
  float selfVis = crownTransmittance(p, Lc, crownRadiusAt(v, hf + 0.04), Hc, uVarDensity[v]);
  float selfSun = selfVis * (aCrown.w > 0.5 ? dapple(p) : 1.0);

  // wind: whole-tree sway grows with height^2, needle flutter on the outer cards
  float phase = dot(iPos.xy, vec2(0.071, 0.053));
  float sway = (sin(uTime * 0.63 + phase) * 0.65 + sin(uTime * 1.71 + phase * 1.37) * 0.25) * uWind;
  p.xy += vec2(0.83, 0.56) * sway * 0.22 * hf * hf;
  float fl = aCrown.z * aCrown.w;
  p += normal * (sin(uTime * 3.3 + aCrown.y * 41.0 + phase * 3.0) * 0.045 * fl * uWind);

  vec3 local = vec3(rotate2(p.xy * s.x, rot), p.z * s.y) + iPos;
  vSun = selfSun * forestTerrainSun(local, iPos, iDim.y, mix(iMisc.w, iMisc.z, smoothstep(0.05, 0.95, hf)));
  vec3 n = normal / vec3(s.x, s.x, s.y);
  n = normalize(vec3(rotate2(n.xy, rot), n.z));

  vUv = uv;
  vNormal = n;
  vLocal = local;
  vAo = aCrown.x;
  vFade = iFade;
  vTint = instanceTint(iMisc.y) * (aCrown.w > 0.5 ? uFoliageTint[v] * cardVariation(aCrown.y) : uBarkTint[v]);
  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const FOLIAGE_FRAG = /* glsl */ `
${LIGHT_PARS}
${LIGHT_FUNCS}
uniform sampler2D uMap;
uniform vec3 uCamLocal;
in vec2 vUv;
in vec3 vNormal;
in vec3 vLocal;
in float vAo;
in float vSun;
in float vFade;
in vec3 vTint;
out vec4 fragColor;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec4 tex = texture(uMap, vUv);
  vec3 V = normalize(uCamLocal - vLocal);
  // cards seen edge-on collapse into dense lines of needles: thin them out
  vec3 Ng = normalize(cross(dFdx(vLocal), dFdy(vLocal)));
  float edge = abs(dot(Ng, V));
  if (tex.a < mix(0.5, 0.92, 1.0 - smoothstep(0.08, 0.32, edge))) discard;
  if (forestFadeDiscard(vFade, gl_FragCoord.xy)) discard;
  vec3 N = normalize(vNormal);
  fragColor = vec4(forestShade(tex.rgb * vTint, N, V, vSun, vAo, 1.0), 1.0);
}
`;

const BARK_FRAG = /* glsl */ `
${LIGHT_PARS}
${LIGHT_FUNCS}
uniform sampler2D uBark;
uniform sampler2D uBarkNormal;
uniform vec3 uCamLocal;
in vec2 vUv;
in vec3 vNormal;
in vec3 vLocal;
in float vAo;
in float vSun;
in float vFade;
in vec3 vTint;
in float vDesat;
out vec4 fragColor;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  if (forestFadeDiscard(vFade, gl_FragCoord.xy)) discard;
  vec3 bark = texture(uBark, vUv).rgb;
  bark = mix(bark, vec3(dot(bark, vec3(0.3, 0.55, 0.15))), vDesat);
  vec3 albedo = bark * vTint;
  vec3 N = normalize(vNormal);
  // bark relief from the normal map (cotangent frame from derivatives)
  vec3 dp1 = dFdx(vLocal), dp2 = dFdy(vLocal);
  vec2 duv1 = dFdx(vUv), duv2 = dFdy(vUv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-12);
  vec3 tn = texture(uBarkNormal, vUv).xyz * 2.0 - 1.0;
  tn.xy *= 1.4;
  vec3 Nb = normalize(mat3(T * invmax, B * invmax, N) * tn);
  float detail = clamp(length(duv1) * 60.0, 0.0, 1.0);
  N = normalize(mix(Nb, N, detail));
  vec3 V = normalize(uCamLocal - vLocal);
  fragColor = vec4(forestShade(albedo, N, V, vSun, vAo, 0.0), 1.0);
}
`;

export function createFoliageMaterial(shared: Record<string, IUniform>, map: Texture): ShaderMaterial {
  return new ShaderMaterial({
    name: 'forest-foliage',
    glslVersion: GLSL3,
    uniforms: { ...shared, uMap: { value: map } },
    vertexShader: MESH_VERT,
    fragmentShader: FOLIAGE_FRAG,
    side: DoubleSide,
  });
}

export function createBarkMaterial(shared: Record<string, IUniform>, bark: Texture, barkNormal: Texture): ShaderMaterial {
  return new ShaderMaterial({
    name: 'forest-bark',
    glslVersion: GLSL3,
    uniforms: { ...shared, uBark: { value: bark }, uBarkNormal: { value: barkNormal } },
    vertexShader: MESH_VERT,
    fragmentShader: BARK_FRAG,
    side: FrontSide,
  });
}

// ------------------------------------------------------------------------------------------------
// impostor bake (canonical, non-instanced)

export const IMPOSTOR_GLSL = /* glsl */ `
vec2 hemiOctEncode(vec3 d) {
  vec3 n = d / (abs(d.x) + abs(d.y) + max(d.z, 0.0) + 1e-6);
  return vec2(n.x + n.y, n.x - n.y);
}
vec3 hemiOctDecode(vec2 e) {
  vec2 t = vec2(e.x + e.y, e.x - e.y) * 0.5;
  return normalize(vec3(t, max(1.0 - abs(t.x) - abs(t.y), 0.0)));
}
vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return e * 0.5 + 0.5;
}
vec3 octDecode(vec2 f) {
  f = f * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
`;

const BAKE_VERT = /* glsl */ `
in vec4 aCrown;
out vec2 vUv;
out vec3 vNormal;
out vec3 vPos;
out float vAo;
out float vFoliage;
out float vRand;
void main() {
  vUv = uv;
  vNormal = normal;
  vPos = position;
  vAo = aCrown.x;
  vFoliage = aCrown.w;
  vRand = aCrown.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** mode 0: albedo (sRGB-encoded, premultiplied by coverage); mode 1: (octNormal, depth, ao) */
const BAKE_FRAG = /* glsl */ `
${IMPOSTOR_GLSL}
${CARD_VARIATION}
uniform sampler2D uMap;
uniform sampler2D uBark;
uniform vec3 uTint;
uniform vec3 uBarkTintBake;
uniform int uMode;
uniform vec3 uFrameDir;
uniform vec3 uCenter;
uniform float uDepthRange;
uniform float uIsFoliage;
uniform float uDesat;
in vec2 vUv;
in vec3 vNormal;
in vec3 vPos;
in float vAo;
in float vFoliage;
in float vRand;
out vec4 fragColor;
void main() {
  vec3 albedo;
  if (uIsFoliage > 0.5) {
    vec4 t = texture(uMap, vUv);
    if (t.a < 0.5) discard;
    albedo = t.rgb * uTint * cardVariation(vRand);
  } else {
    albedo = texture(uBark, vUv).rgb;
    albedo = mix(albedo, vec3(dot(albedo, vec3(0.3, 0.55, 0.15))), uDesat) * uBarkTintBake;
  }
  if (uMode == 0) {
    fragColor = vec4(pow(clamp(albedo, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
  } else {
    float depth = dot(vPos - uCenter, uFrameDir) / uDepthRange * 0.5 + 0.5;
    // ao in [0, 0.5) marks bark, [0.5, 1] foliage
    float ao = uIsFoliage > 0.5 ? 0.5 + 0.5 * vAo : 0.49 * vAo;
    fragColor = vec4(octEncode(normalize(vNormal)), clamp(depth, 0.0, 1.0), ao);
  }
}
`;

export function createBakeMaterial(map: Texture, bark: Texture, foliage: boolean): ShaderMaterial {
  return new ShaderMaterial({
    name: 'forest-bake',
    glslVersion: GLSL3,
    uniforms: {
      uMap: { value: map },
      uBark: { value: bark },
      uTint: { value: new Vector3(1, 1, 1) },
      uBarkTintBake: { value: new Vector3(1, 1, 1) },
      uMode: { value: 0 },
      uFrameDir: { value: new Vector3(0, 0, 1) },
      uCenter: { value: new Vector3() },
      uDepthRange: { value: 1 },
      uIsFoliage: { value: foliage ? 1 : 0 },
      uDesat: { value: 0 },
    },
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    side: foliage ? DoubleSide : FrontSide,
  });
}

// ------------------------------------------------------------------------------------------------
// impostors

export interface ImpostorLayout {
  /** frames per side of a variant's hemi-octahedral grid */
  frames: number;
  /** pixels per frame */
  framePx: number;
  /** gutter pixels inside each frame */
  gutter: number;
  /** variant slots per atlas row */
  slotCols: number;
  slotRows: number;
}

const IMPOSTOR_VERT = /* glsl */ `
${LIGHT_PARS}
${VARIANT_PARS}
${IMPOSTOR_GLSL}
${FOREST_SHADOW}
uniform vec2 uImpostorLod;
uniform vec4 uAtlas; // frames, framePx, gutter, slotCols
uniform vec2 uAtlasSize;
in vec3 iPos;
in vec2 iDim;
in vec4 iMisc;
out vec2 vAtlasUv;
out vec2 vQuad;
out float vFade;
out vec3 vTint;
out vec3 vRight;
out vec3 vUp;
out vec3 vDir;
out vec3 vCenterC;
out vec2 vHalf;
out float vDepthRange;
flat out int vVariant;
out vec2 vScale;
out float vRot;
out vec3 vSun;
out vec3 vLocal;
out float vDist;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  int v = int(iMisc.x + 0.5);
  float Hc = uVarH[v];
  float Rb = uVarBound[v];
  vec2 s = treeScale(v, iDim);
  float rot = treeRotation(iMisc.y);
  vec3 centerW = iPos + vec3(0.0, 0.0, iDim.x * 0.5);
  vec3 toCam = uCamLocal - centerW;
  float dist = length(toCam);
  float dEff = dist / clamp(iDim.x / 20.0, 0.6, 1.6);
  float fade = clamp((dEff - uImpostorLod.x) / (uImpostorLod.y - uImpostorLod.x), 0.0, 1.0);
  if (fade <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vFade = fade;
  vDist = dist;

  // view direction in the tree's canonical space picks the frame
  vec3 dir = toCam / dist;
  vec2 dr = rotate2(dir.xy, -rot);
  vec3 dc = normalize(vec3(dr / s.x, dir.z / s.y));
  dc.z = max(dc.z, 0.0);
  float N = uAtlas.x;
  vec2 e = hemiOctEncode(dc);
  vec2 cell = clamp(floor((e * 0.5 + 0.5) * N), 0.0, N - 1.0);
  vec3 fd = hemiOctDecode((cell + 0.5) / N * 2.0 - 1.0);
  vec3 right = normalize(cross(vec3(0.0, 0.0, 1.0), fd));
  vec3 up = cross(fd, right);
  float sinT = fd.z;
  float cosT = length(fd.xy);
  vec2 half_ = vec2(Rb, 0.5 * (Hc * cosT + 2.0 * Rb * sinT)) * 1.04;
  vec3 centerC = vec3(0.0, 0.0, Hc * 0.5);
  vec3 pc = centerC + right * position.x * half_.x + up * position.y * half_.y;
  vec3 local = vec3(rotate2(pc.xy * s.x, rot), pc.z * s.y) + iPos;
  // pull the card towards the camera so the crown is not cut by the ground behind it
  local += dir * Rb * s.x * 0.6;

  float slot = float(v);
  vec2 slotOrigin = vec2(mod(slot, uAtlas.w), floor(slot / uAtlas.w)) * N * uAtlas.y;
  vec2 framePx = slotOrigin + cell * uAtlas.y + uAtlas.z + (position.xy * 0.5 + 0.5) * (uAtlas.y - 2.0 * uAtlas.z);
  vAtlasUv = framePx / uAtlasSize;
  vQuad = position.xy;
  vRight = right;
  vUp = up;
  vDir = fd;
  vCenterC = centerC;
  vHalf = half_;
  vDepthRange = sqrt(Rb * Rb + 0.25 * Hc * Hc);
  vVariant = v;
  vScale = s;
  vRot = rot;
  // live sun past the terrain / other crowns at the crown base, middle and top (per instance:
  // per-texel sampling of every overlapping impostor fragment costs ~2 ms on a hillside)
  float bakedMid = mix(iMisc.w, iMisc.z, 0.5);
  vSun = vec3(
    forestTerrainSun(iPos + vec3(0.0, 0.0, iDim.x * 0.35), iPos, iDim.y, iMisc.w),
    forestTerrainSun(iPos + vec3(0.0, 0.0, iDim.x * 0.65), iPos, iDim.y, bakedMid),
    forestTerrainSun(iPos + vec3(0.0, 0.0, iDim.x * 0.95), iPos, iDim.y, iMisc.z));
  vTint = instanceTint(iMisc.y);
  vLocal = local;
  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const IMPOSTOR_FRAG = /* glsl */ `
${LIGHT_PARS}
${VARIANT_PARS}
${LIGHT_FUNCS}
${IMPOSTOR_GLSL}
uniform sampler2D uAlbedoAtlas;
uniform sampler2D uNormalAtlas;
uniform vec2 uAtlasSize;
in vec2 vAtlasUv;
in vec2 vQuad;
in float vFade;
in vec3 vTint;
in vec3 vRight;
in vec3 vUp;
in vec3 vDir;
in vec3 vCenterC;
in vec2 vHalf;
in float vDepthRange;
flat in int vVariant;
in vec2 vScale;
in float vRot;
in vec3 vSun;
in vec3 vLocal;
in float vDist;
out vec4 fragColor;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec4 a = texture(uAlbedoAtlas, vAtlasUv);
  vec2 px = vAtlasUv * uAtlasSize;
  float lod = 0.5 * log2(max(max(dot(dFdx(px), dFdx(px)), dot(dFdy(px), dFdy(px))), 1e-8));
  // box-filtered coverage shrinks with the mip level; lower the threshold to keep crowns full
  float threshold = mix(0.5, 0.28, smoothstep(0.5, 4.0, lod));
  if (a.a < threshold) discard;
  if (forestFadeDiscard(vFade, gl_FragCoord.xy)) discard;
  vec3 albedo = pow(a.rgb / max(a.a, 1e-3), vec3(2.2)) * vTint;
  vec4 nn = texture(uNormalAtlas, vAtlasUv);
  vec3 nc = octDecode(nn.xy);
  float foliage = step(0.5, nn.w);
  float ao = foliage > 0.5 ? nn.w * 2.0 - 1.0 : nn.w / 0.49;
  int v = vVariant;
  albedo *= foliage > 0.5 ? uFoliageTint[v] : uBarkTint[v];
  // canonical position of this texel
  vec3 pc = vCenterC + vRight * vQuad.x * vHalf.x + vUp * vQuad.y * vHalf.y + vDir * (nn.z * 2.0 - 1.0) * vDepthRange;
  float Hc = uVarH[v];
  float hf = clamp(pc.z / Hc, 0.0, 1.0);
  vec3 Lc = canonicalLight(vRot, vScale);
  float selfVis = crownTransmittance(pc, Lc, crownRadiusAt(v, hf + 0.04), Hc, uVarDensity[v]);
  float terrain = (hf < 0.65 ? mix(vSun.x, vSun.y, smoothstep(0.35, 0.65, hf)) : mix(vSun.y, vSun.z, smoothstep(0.65, 0.95, hf)))
    * (foliage > 0.5 ? (vDist < 520.0 ? mix(dapple(pc), 0.65, smoothstep(380.0, 520.0, vDist)) : 0.65) : 1.0);
  vec3 n = nc / vec3(vScale.x, vScale.x, vScale.y);
  n = normalize(vec3(rotate2(n.xy, vRot), n.z));
  vec3 V = normalize(uCamLocal - vLocal);
  fragColor = vec4(forestShade(albedo, n, V, selfVis * terrain, ao, foliage), 1.0);
}
`;

export function createImpostorMaterial(
  shared: Record<string, IUniform>,
  albedo: Texture,
  normal: Texture,
  layout: ImpostorLayout,
  atlasSize: Vector2,
): ShaderMaterial {
  return new ShaderMaterial({
    name: 'forest-impostor',
    glslVersion: GLSL3,
    uniforms: {
      ...shared,
      uAlbedoAtlas: { value: albedo },
      uNormalAtlas: { value: normal },
      uAtlas: { value: [layout.frames, layout.framePx, layout.gutter, layout.slotCols] },
      uAtlasSize: { value: atlasSize },
    },
    vertexShader: IMPOSTOR_VERT,
    fragmentShader: IMPOSTOR_FRAG,
    side: DoubleSide,
  });
}
