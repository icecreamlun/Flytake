import { Matrix4, Texture } from 'three';
import { WATER_UNIFORMS } from '../scene/water';
import { WATER_ASSET_UNIFORMS } from './waterAssets';
import { WATER_COMMON_GLSL } from './waterCommon';

/**
 * Lake shading of the Emerald Bay terrain (the hydro-flattened lake surface of the lidar tiles).
 * Terrain.tsx composes: land shading (its own) -> flyShore() -> mix with flyWater() by
 * flyWaterMask(). All outputs are PRE-LIT (see light.ts): they already include uFlatSunInv.
 *
 * Inputs available to these functions (declared by Terrain.tsx before WATER_GLSL):
 *   uniforms uSunDir, uFlatSunInv, uSunColor, uAmbient, uSceneCam, uLakeLevel, the ground
 *   material array (uMatC layer 0 = sand, uMatOn) and the shadow field (shadowGlsl.ts)
 *
 * The water model (once the assets of waterAssets.ts are in):
 *  - surface: three octaves of a looping FFT wind-wave slope animation (tools/water/
 *    make_waves.py), drifting calm / ruffled wind patches; slope variance the mip filter
 *    averages away becomes roughness (no aliasing / streaks at grazing angles, a sun path and
 *    blurred reflections in the distance)
 *  - reflection: the planar mirror render of terrain + forest (WaterReflection.tsx) over a sky
 *    probe (waterSky.ts) that is in radiance-matched pre-lit units; GGX sun glints
 *  - body: absorption along the refracted path over an estimated depth (tools/water/
 *    make_lake.py): clear turquoise shallows showing a sandy / rocky bottom with caustics,
 *    emerald in the bay, sapphire in the main lake
 *  - shore: wet sand band, a thin lapping foam line
 */

/** planar reflection of the lake (WaterReflection.tsx fills these) */
export const REFLECTION_UNIFORMS = {
  uReflTex: { value: null as Texture | null },
  uReflMatrix: { value: new Matrix4() },
  uReflOn: { value: 0 },
};

/** uniforms the water functions need (spread into the terrain material) */
export const WATER_SHADING_UNIFORMS = {
  uReflect: WATER_UNIFORMS.uReflect,
  uFlyTime: WATER_UNIFORMS.uFlyTime,
  ...REFLECTION_UNIFORMS,
  ...WATER_ASSET_UNIFORMS,
};

export const WATER_GLSL = /* glsl */ `
uniform vec3 uReflect;
uniform float uFlyTime;
uniform sampler2D uReflTex;
uniform mat4 uReflMatrix;
uniform float uReflOn;
uniform sampler2D uLakeTex;
uniform vec4 uLakeBox;
uniform float uWaterOn;
${WATER_COMMON_GLSL}

/**
 * 1 on the lake surface, 0 on land. hLake = height above the lake surface (m), p = scene xy.
 * The lake outline comes from the lake texture (coverage, 2 m): along the shore the coarser
 * terrain tiles have long sloped slivers above the lake level that the height test alone
 * painted as land, and flat beaches a few cm above the lake that it painted as water.
 */
float flyWaterMask(float hLake, vec2 p) {
  if (uWaterOn < 0.5) return 1.0 - smoothstep(0.03, 0.10, hLake);
  float cover = texture(uLakeTex, (p - uLakeBox.xy) * uLakeBox.zw).a;
  float byTex = smoothstep(0.4, 0.6, cover);
  // within a texel of the shore the outline is ambiguous: there the terrain height (1 m data,
  // exact on the fine tiles) draws the waterline
  float byHeight = 1.0 - smoothstep(0.03, 0.10, hLake);
  float ambiguous = smoothstep(0.03, 0.2, cover) * (1.0 - smoothstep(0.8, 0.97, cover));
  return mix(byTex, byHeight, ambiguous) * (1.0 - smoothstep(2.0, 4.0, hLake));
}

/** land colour near the waterline (wet sand, lapping foam); land is pre-lit */
vec3 flyShore(vec3 land, vec3 albedo, vec3 pScene, float hLake, float dist) {
  if (uWaterOn < 0.5 || hLake > 0.6 || dist > 2500.0) return land;
  vec2 p = pScene.xy;
  float n = flyWNoise(p * 0.45) * 0.6 + flyWNoise(p * 2.3) * 0.4;
  // lapping: the waterline breathes a few cm up and down the beach
  float lap = 0.5 + 0.5 * sin(uFlyTime * 0.8 + dot(p, vec2(0.031, 0.047)) + n * 2.5);
  float wetTop = 0.16 + 0.14 * n + 0.04 * lap;
  float wet = 1.0 - smoothstep(wetTop * 0.45, wetTop, hLake);
  vec3 light = land / max(albedo, vec3(0.02));
  vec3 outc = land * mix(1.0, 0.58, wet);
  // thin foam right at the waterline, broken up
  float foamLine = 1.0 - smoothstep(0.0, 0.035 + 0.05 * lap, hLake - 0.02);
  float foam = foamLine * smoothstep(0.42, 0.72, flyWNoise(p * 1.7 + vec2(uFlyTime * 0.15, 0.0)) * 0.7 + n * 0.3);
  foam *= 1.0 - smoothstep(60.0, 300.0, dist);
  outc = mix(outc, light * 0.55, foam * 0.75);
  return outc;
}

/** the previous lake shading (used until the water textures are loaded) */
vec3 flyWaterLegacy(vec3 albedo, vec3 pScene, vec3 V, float dist, float sunVis) {
  vec3 N = normalize(vec3(pScene.xy / 6371000.0, 1.0));
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  float direct = sunVis * max(uSunDir.z, 0.0);
  vec3 under = albedo * (0.55 * direct * uSunColor + vec3(0.20, 0.23, 0.28) * uSunDir.z * 2.2) * (1.0 - F);
  return under * uFlatSunInv + uReflect * F;
}

/**
 * Pre-lit lake colour. albedo = the baked lake colour (only used by the legacy path),
 * V = unit vector to the camera, sunVis = direct-sun visibility at the surface.
 */
vec3 flyWater(vec3 albedo, vec3 pScene, vec3 V, float dist, float sunVis, float hLake) {
  vec2 p = pScene.xy;
  // derivatives first: everything below may branch
  vec2 dpdx = dFdx(p);
  vec2 dpdy = dFdy(p);
  if (hLake > 4.0) return vec3(0.0);
  if (uWaterOn < 0.5) return flyWaterLegacy(albedo, pScene, V, dist, sunVis);

  vec2 luv = (p - uLakeBox.xy) * uLakeBox.zw;
  vec3 lk = textureGrad(uLakeTex, luv, dpdx * uLakeBox.zw, dpdy * uLakeBox.zw).rgb;
  // a little natural variation of the (estimated) depth: sand bars, scoured patches
  float depth = lk.r * lk.r * 80.0 * mix(0.75, 1.3, flyWNoise(p / 23.0 + 3.1) * 0.7 + flyWNoise(p / 7.0) * 0.3);
  float shoreD = lk.g * lk.g * 64.0;
  float bottomLum = lk.b * 0.5;
  // Emerald Bay (greener, a little murkier) vs the main lake (sapphire)
  float bay = 1.0 - smoothstep(900.0, 1900.0, length(p - vec2(684.0, 482.0)));

  // --- surface
  float t = uFlyTime;
  float calm = mix(0.55, 1.0, smoothstep(2.0, 30.0, shoreD));
  float alpha2;
  vec2 s = flyWaveSlope(p, dpdx, dpdy, t, calm, alpha2);
  vec3 N = normalize(vec3(-s + p / 6371000.0, 1.0));
  N = flyMaskedNormal(N, V, alpha2);
  float nv = dot(N, V);
  if (nv < 0.03) { N = normalize(N + (0.03 - nv) * V); nv = dot(N, V); }
  nv = clamp(nv, 0.03, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 L = uSunDir;

  // --- reflection: mirror render of terrain + forest over the sky probe
  vec3 sky = flySkyReflection(R, alpha2, uReflect);
  vec3 refl = sky;
  if (uReflOn > 0.5) {
    // the wave slope tilts the reflected ray by ~2 s: offset the mirror lookup accordingly
    vec3 pd = pScene + vec3(s * min(dist, 800.0) * 1.6, 0.0);
    vec4 rc = uReflMatrix * vec4(pd, 1.0);
    vec2 ruv = rc.xy / rc.w * 0.5 + 0.5;
    float rl = clamp(log2(1.0 + sqrt(alpha2) * 50.0), 0.0, 3.0);
    vec4 rs = textureLod(uReflTex, clamp(ruv, vec2(0.001), vec2(0.999)), rl);
    // the mirrored scene misses the haze between it and the water: thin it towards the sky
    float k = 1.0 - 0.3 * smoothstep(400.0, 5000.0, dist);
    refl = sky * (1.0 - rs.a * k) + rs.rgb * k;
  }

  // --- sun glints
  vec3 spec = vec3(flySunSpec(N, V, L, alpha2) * sunVis);

  // --- under the surface: absorption along the refracted paths
  float nvr = sqrt(1.0 - (1.0 - nv * nv) / 1.777);
  float nsr = sqrt(1.0 - (1.0 - L.z * L.z) / 1.777);
  vec3 absorb = mix(vec3(0.34, 0.048, 0.026), vec3(0.38, 0.060, 0.072), bay);
  vec3 bodyAlb = mix(FLY_BODY_LAKE, FLY_BODY_BAY, bay);
  // in-scattered light comes from a wide area of the surface: shadows on it are soft
  float lit = mix(0.4, 1.0, sunVis);
  vec3 eIn = lit * L.z * uSunColor + uAmbient;
  vec3 tPath = exp(-absorb * depth * (1.0 / nvr + 1.0 / nsr));
  vec3 under = bodyAlb * (1.0 - tPath) * eIn;
  float bottomVis = 1.0 - smoothstep(3.0, 20.0, depth);
  if (bottomVis > 0.0) {
    // the bottom, seen through the water a little displaced (refraction parallax)
    vec2 hv = -V.xy / max(length(V.xy), 1e-4);
    float tanr = sqrt(max(1.0 - nvr * nvr, 0.0)) / nvr;
    vec2 bp = p + hv * depth * min(tanr, 6.0) + s * depth * 0.8;
    vec3 sand = vec3(1.0);
    if (uMatOn > 0.5 && dist < 120.0) {
      // layer 0 of the terrain's ground materials is sand; normalise by its mean (top mip)
      vec2 su = vec2(bp.x, -bp.y) / 2.2;
      vec3 sd = textureGrad(uMatC, vec3(su, 0.0), dpdx / 2.2, dpdy / 2.2).rgb;
      vec3 sm = textureLod(uMatC, vec3(0.5, 0.5, 0.0), 12.0).rgb;
      sand = mix(vec3(1.0), sd / max(sm, vec3(0.01)), (1.0 - smoothstep(30.0, 120.0, dist)) * 0.6);
    }
    // granite boulders / darker patches on the bed
    float patches = smoothstep(0.6, 0.85, flyWNoise(bp * 0.35) * 0.7 + flyWNoise(bp * 1.3) * 0.3);
    vec3 bottomAlb = bottomLum * vec3(1.15, 1.0, 0.82) * 0.95 * mix(1.0, 0.55, patches) * sand;
    // deeper beds are silty and dark; only the shelf near the shore is bright sand / granite
    bottomAlb *= mix(1.0, 0.25, smoothstep(1.0, 9.0, depth));
    // caustics: refraction focuses the sunlight where the surface is concave
    float caustic = 1.0;
    if (depth < 6.0 && dist < 150.0) {
      float e = 0.18;
      float kk;
      vec3 oc = FLY_OCT1;
      vec2 sxp = flyWaveOctave(bp + vec2(e, 0.0), dpdx, dpdy, oc, t, kk);
      vec2 sxm = flyWaveOctave(bp - vec2(e, 0.0), dpdx, dpdy, oc, t, kk);
      vec2 syp = flyWaveOctave(bp + vec2(0.0, e), dpdx, dpdy, oc, t, kk);
      vec2 sym = flyWaveOctave(bp - vec2(0.0, e), dpdx, dpdy, oc, t, kk);
      float div = (sxp.x - sxm.x + syp.y - sym.y) / (2.0 * e) * FLY_OCT1.x;
      // first-order focusing (mean 1): concave patches brighten into lines, convex ones dim
      float x = -depth * 0.25 * 1.6 * div;
      caustic = clamp(1.0 + (x > 0.0 ? x * 1.3 : x * 0.6), 0.35, 2.6) / 1.12;
      caustic = mix(1.0, caustic, (1.0 - smoothstep(40.0, 150.0, dist)) * smoothstep(0.05, 0.5, depth) * kk);
    }
    vec3 tDown = exp(-absorb * depth / nsr);
    vec3 tUp = exp(-absorb * depth / nvr);
    // sky light under water: less blue than the sky itself (absorbed from all directions)
    vec3 amb = mix(uAmbient, vec3(dot(uAmbient, vec3(0.2126, 0.7152, 0.0722))), 0.5);
    vec3 eBottom = sunVis * L.z * uSunColor * caustic * tDown + amb * exp(-absorb * depth * 1.6);
    under += bottomAlb * eBottom * tUp * bottomVis;
  }
  under *= 1.0 - F;

  // --- foam where the water laps the shore
  float n = flyWNoise(p * 0.45) * 0.6 + flyWNoise(p * 2.3) * 0.4;
  float lap = 0.5 + 0.5 * sin(t * 0.8 + dot(p, vec2(0.031, 0.047)) + n * 2.5);
  float foam = (1.0 - smoothstep(0.0, 0.5 + 0.5 * lap, shoreD - 0.3))
             * smoothstep(0.5, 0.8, flyWNoise(p * 3.1 + vec2(t * 0.2, 0.0)) * 0.6 + flyWNoise(p * 0.9) * 0.4)
             * (1.0 - smoothstep(40.0, 200.0, dist)) * 0.35;
  vec3 foamCol = vec3(0.55) * (lit * L.z * uSunColor + uAmbient);
  under = mix(under, foamCol, foam);

  return (under + spec) * uFlatSunInv + refl * F * (1.0 - foam);
}
`;
