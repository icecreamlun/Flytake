import { Vector3 } from 'three';
import { ambientForElevation } from '../world/light';

/**
 * Forest lighting contract (shared by every forest material).
 *
 * The main scene goes through takram's AerialPerspective with sun relighting and no normal
 * buffer: every pixel is multiplied by albedoScale / PI * sunIrradiance * dot(flatNormal, sun)
 * before the haze is added. Forest materials therefore output PRE-LIT ALBEDO relative to that
 * flat term:
 *
 *   out.rgb = albedo * (sunVis * shadeSun(N, L) + uAmbient * sky * ao) * uFlatSunInv
 *
 * Everything is in the Emerald Bay ENU frame (x east, y north, z up).
 */

/** Look-dev default: 2026-11-07 15:00 PST over Emerald Bay (azimuth 230 deg, elevation 18.1 deg). */
export const DEFAULT_SUN_DIR = new Vector3(-0.729, -0.611, 0.311).normalize();

/**
 * Sky fill relative to the direct sun, tuned for the 15:00 sun (18 deg). setForestSun() scales
 * it with the elevation by the same ratio as the terrain's (world/light.ts ambientForElevation):
 * the lower the sun, the more of the light on the trees comes from the sky.
 */
export const FOREST_AMBIENT_18 = new Vector3(0.2, 0.235, 0.3);
const REF_ELEVATION = (18.1 * Math.PI) / 180;
const ambRef = ambientForElevation(REF_ELEVATION);
const ambNow = new Vector3();

export const FOREST_LIGHT = {
  /** unit vector towards the sun, ENU */
  uSunDir: { value: DEFAULT_SUN_DIR.clone() },
  /** 1 / max(sunDir.z, 0.05), kept in sync by setForestSun() (or the parent) */
  uFlatSunInv: { value: 1 / Math.max(DEFAULT_SUN_DIR.z, 0.05) },
  /** sky fill relative to the direct sun (cool); follows the sun elevation (setForestSun) */
  uAmbient: { value: FOREST_AMBIENT_18.clone() },
  /** seconds, drives the wind */
  uTime: { value: 0 },
  /** 0..1 wind strength */
  uWind: { value: 0.6 },
  /** look-dev: 0 shaded, 1 sun visibility, 2 N.L, 3 ao, 4 albedo, 5 baked (trees.bin) sun visibility */
  uForestDebug: { value: 0 },
};

export function setForestSun(dirEnu: Vector3): void {
  const L = FOREST_LIGHT.uSunDir.value.copy(dirEnu).normalize();
  FOREST_LIGHT.uFlatSunInv.value = 1 / Math.max(L.z, 0.05);
  ambientForElevation(Math.asin(Math.min(1, Math.max(-1, L.z))), ambNow).divide(ambRef);
  FOREST_LIGHT.uAmbient.value.copy(FOREST_AMBIENT_18).multiply(ambNow);
}

/** Uniform declarations for the lighting chunk. */
export const LIGHT_PARS = /* glsl */ `
uniform vec3 uSunDir;
uniform float uFlatSunInv;
uniform vec3 uAmbient;
uniform float uTime;
uniform float uWind;
uniform int uForestDebug;
`;

/**
 * forestShade(albedo, N, V, sunVis, ao, foliage)
 *  N        shading normal (ENU), V direction to the camera (ENU)
 *  sunVis   0..1 direct-sun visibility (terrain shadow x self-shadow)
 *  ao       0..1 ambient occlusion (crown interior / lower crown darker)
 *  foliage  1 for needles (wrap lighting + translucency), 0 for bark
 */
export const LIGHT_FUNCS = /* glsl */ `
vec3 forestShade(vec3 albedo, vec3 N, vec3 V, float sunVis, float ao, float foliage) {
  vec3 L = uSunDir;
  float ndl = dot(N, L);
  // needles scatter some light around the shoot: a little wrap, none for bark
  float wrap = 0.16 * foliage;
  float diff = max((ndl + wrap) / (1.0 + wrap), 0.0);
  // light transmitted through the needles towards the camera (back-lit glow, warm yellow-green)
  float back = pow(clamp(dot(-V, L), 0.0, 1.0), 5.0);
  float trans = foliage * back * (0.25 + 0.75 * ao) * 1.25;
  // waxy needles: a faint broad sheen towards the sun (the silvery cast of firs / Jeffrey pine)
  vec3 H = normalize(L + V);
  float sheen = foliage * pow(max(dot(N, H), 0.0), 12.0) * 0.018 * ao;
  vec3 sun = sunVis * (diff * vec3(1.05, 1.0, 0.93) + trans * vec3(0.85, 1.0, 0.38));
  // sky: brighter on up-facing normals, strongly occluded inside the crown
  float sky = (0.5 + 0.5 * N.z) * ao * mix(1.0, ao, 0.6 * foliage);
  vec3 lit = albedo * (sun * mix(0.45, 1.0, ao) + uAmbient * sky) + sunVis * sheen * vec3(0.9, 0.95, 1.0);
  if (uForestDebug == 1 || uForestDebug == 5) return vec3(sunVis) * uFlatSunInv * 0.3;
  if (uForestDebug == 2) return vec3(max(ndl, 0.0), max(-ndl, 0.0), 0.0) * uFlatSunInv * 0.3;
  if (uForestDebug == 3) return vec3(ao) * uFlatSunInv * 0.3;
  if (uForestDebug == 4) return albedo * uFlatSunInv;
  return lit * uFlatSunInv;
}

/**
 * Direct sun visibility through a tree's own crown. p is the point in the tree's canonical
 * (unscaled, unrotated) space, Lc the light direction transformed into that space (not unit:
 * the ray parameter is then the world-space path length), R the crown radius at p's height.
 */
float crownTransmittance(vec3 p, vec3 Lc, float R, float H, float density) {
  vec2 d = Lc.xy;
  float a = max(dot(d, d), 1e-6);
  float b = dot(p.xy, d);
  float c = dot(p.xy, p.xy) - R * R;
  float disc = b * b - a * c;
  float tSide = c < 0.0 ? (-b + sqrt(max(disc, 0.0))) / a : 0.0;
  float tTop = Lc.z > 1e-4 ? max(H - p.z, 0.0) / Lc.z : 1e4;
  float t = min(tSide, tTop);
  return mix(0.1, 1.0, exp(-density * t));
}

/** Smooth 3D value noise (0..1) for dappled light inside the crowns. */
float forestHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float forestNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(forestHash(i), forestHash(i + vec3(1, 0, 0)), f.x), mix(forestHash(i + vec3(0, 1, 0)), forestHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(forestHash(i + vec3(0, 0, 1)), forestHash(i + vec3(1, 0, 1)), f.x), mix(forestHash(i + vec3(0, 1, 1)), forestHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
/** Sprays shadowing each other: patchy sun on the crown, in tree-canonical metres. */
float dapple(vec3 pc) {
  return mix(0.3, 1.0, smoothstep(0.28, 0.7, forestNoise(pc * 0.85 + 17.0)));
}

/** Interleaved gradient noise for dithered LOD fades (same value for every LOD at a pixel). */
float forestDither(vec2 fragCoord) {
  return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
}

/** iFade >= 0: fading in, visible where noise < f; iFade < 0: fading out, visible where noise >= -f. */
bool forestFadeDiscard(float fade, vec2 fragCoord) {
  if (fade >= 1.0) return false;
  float n = forestDither(fragCoord);
  return fade >= 0.0 ? n >= fade : n < -fade;
}
`;
