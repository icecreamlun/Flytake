/**
 * GLSL shared by every water surface: the custom lake (waterShading.ts), the Google-side water
 * surface for low views (scene/WaterSurface.tsx) and the recoloured Google tile water
 * (scene/water.ts). Kept free of imports so scene/water.ts can use it without an import cycle.
 *
 * Needs (declared by the includer): uSunDir (scene ENU), uFlatSunInv, uSunColor, uAmbient,
 * uFlyTime; uniforms from waterAssets.ts (WATER_ASSET_UNIFORMS).
 */

export const WATER_COMMON_GLSL = /* glsl */ `
uniform highp sampler2DArray uWaves;
uniform vec4 uWaveMeta;
uniform highp samplerCube uSkyProbe;
uniform float uSkyOn;
uniform float uAlbedoInv;

const vec2 FLY_WIND = vec2(0.8, 0.6);
// deep-water body albedo (water-leaving light per unit downwelling): sapphire main lake,
// emerald bay; tuned against the fly-in / hero views
const vec3 FLY_BODY_LAKE = vec3(0.0030, 0.0150, 0.0850);
const vec3 FLY_BODY_BAY = vec3(0.0030, 0.0270, 0.0280);
// wave octaves: rms slope, patch scale, rotation, time scale (deep-water dispersion: sqrt)
const vec3 FLY_OCT0 = vec3(0.042, 1.0, 0.0);
const vec3 FLY_OCT1 = vec3(0.036, 0.19, 2.1);
const vec3 FLY_OCT2 = vec3(0.022, 4.3, -0.9);

float flyWHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float flyWNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(flyWHash(i), flyWHash(i + vec2(1.0, 0.0)), f.x), mix(flyWHash(i + vec2(0.0, 1.0)), flyWHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

/**
 * One octave of the looping wave slopes (unit rms) at scene xy p; dpdx / dpdy are the screen
 * derivatives of p (explicit gradients: callers may branch). keep = fraction of the octave's
 * slope variance the mip filter keeps at this pixel footprint.
 */
vec2 flyWaveOctave(vec2 p, vec2 dpdx, vec2 dpdy, vec3 oct, float t, out float keep) {
  float c = cos(oct.z), s = sin(oct.z);
  mat2 R = mat2(c, s, -s, c);
  float size = uWaveMeta.x * oct.y;
  vec2 q = R * p / size;
  vec2 gx = R * dpdx / size;
  vec2 gy = R * dpdy / size;
  float frames = uWaveMeta.y;
  float f = fract(t / (uWaveMeta.z * sqrt(oct.y))) * frames;
  float i0 = floor(f);
  float a = f - i0;
  float i1 = mod(i0 + 1.0, frames);
  vec2 s0 = textureGrad(uWaves, vec3(q, i0), gx, gy).rg;
  vec2 s1 = textureGrad(uWaves, vec3(q, i1), gx, gy).rg;
  vec2 st = (mix(s0, s1, a) * 2.0 - 1.0) * uWaveMeta.w;
  // footprint in texels (the larger axis: anisotropic filtering keeps a bit more)
  float texels = sqrt(max(dot(gx, gx), dot(gy, gy))) * 256.0;
  keep = clamp(1.0 - log2(max(texels, 1.0)) / 6.0, 0.0, 1.0);
  return st * R; // texture-space gradient back to scene xy (R^T)
}

/** Surface slope and roughness (Beckmann m^2 ~ GGX alpha^2) of the lake at scene xy p. */
vec2 flyWaveSlope(vec2 p, vec2 dpdx, vec2 dpdy, float t, float calm, out float alpha2) {
  // drifting calm / ruffled patches, stretched along the wind
  vec2 wq = vec2(dot(p, FLY_WIND), dot(p, vec2(-FLY_WIND.y, FLY_WIND.x)));
  float gust = 0.65 * flyWNoise(wq * vec2(1.0 / 320.0, 1.0 / 110.0) + vec2(t * 0.010, 0.0))
             + 0.35 * flyWNoise(wq / 70.0 - vec2(t * 0.025, 0.0) + 13.7);
  float rough = mix(0.45, 1.2, smoothstep(0.25, 0.78, gust)) * calm;
  float k0, k1, k2;
  vec2 s = FLY_OCT0.x * flyWaveOctave(p, dpdx, dpdy, FLY_OCT0, t, k0)
         + FLY_OCT1.x * flyWaveOctave(p, dpdx, dpdy, FLY_OCT1, t, k1)
         + FLY_OCT2.x * flyWaveOctave(p, dpdx, dpdy, FLY_OCT2, t, k2);
  float lost = FLY_OCT0.x * FLY_OCT0.x * (1.0 - k0) + FLY_OCT1.x * FLY_OCT1.x * (1.0 - k1) + FLY_OCT2.x * FLY_OCT2.x * (1.0 - k2);
  alpha2 = rough * rough * lost + 0.0005;
  return s * rough;
}

/**
 * Normal for the mirror term of a rough surface seen at a grazing angle: the facets tilted
 * toward the viewer dominate what is seen (masking), so the mean reflected ray points higher
 * into the sky (bluer) and the Fresnel factor is lower than for the flat mean surface.
 */
vec3 flyMaskedNormal(vec3 N, vec3 V, float alpha2) {
  vec3 vh = V - N * dot(V, N);
  float l = length(vh);
  if (l < 1e-4) return N;
  float tilt = sqrt(alpha2) * 1.8 * (1.0 - smoothstep(0.0, 0.6, dot(N, V)));
  return normalize(N + vh / l * tilt);
}

/** GGX sun specular in pre-lit units (times uFlatSunInv and sun visibility by the caller). */
float flySunSpec(vec3 N, vec3 V, vec3 L, float alpha2) {
  vec3 H = normalize(V + L);
  float nh = max(dot(N, H), 0.0);
  float nl = dot(N, L);
  if (nl <= 0.0) return 0.0;
  float nv = max(dot(N, V), 0.05);
  float d = nh * nh * (alpha2 - 1.0) + 1.0;
  float D = alpha2 / (3.14159265 * d * d);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  // Smith-GGX (separable) visibility
  float k = sqrt(alpha2) * 0.5;
  float G = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);
  // pi * f_spec * (n.l) / albedoScale, f_spec = D F G / (4 n.l n.v)
  return min(3.14159265 * D * F * G / (4.0 * nv) * uAlbedoInv, 400.0);
}

/** Sky reflection in pre-lit units (fallback: the old tuned reflection colour). */
vec3 flySkyReflection(vec3 R, float alpha2, vec3 fallback) {
  if (uSkyOn < 0.5) return fallback;
  R.z = max(R.z, 0.02);
  float lod = clamp(log2(max(sqrt(alpha2) * 160.0, 1.0)), 0.0, 6.0);
  return textureLod(uSkyProbe, normalize(R), lod).rgb * uAlbedoInv * uFlatSunInv;
}
`;

/**
 * Deep open water seen from afar (Google side of the box edge): the same light model as the
 * custom lake with the waves below pixel size (roughness only), in pre-lit units.
 * V, N in scene ENU; lake = 1 main lake (sapphire), 0 Emerald Bay (emerald).
 */
export const WATER_FAR_GLSL = /* glsl */ `
vec3 flyFarWater(vec3 V, vec3 N, float bay) {
  float alpha2 = 0.0045;
  vec3 Nm = flyMaskedNormal(N, V, alpha2);
  float nv = clamp(dot(Nm, V), 0.03, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  vec3 L = uSunDir;
  vec3 bodyAlb = mix(FLY_BODY_LAKE, FLY_BODY_BAY, bay);
  vec3 under = bodyAlb * (L.z * uSunColor + uAmbient) * (1.0 - F);
  vec3 spec = vec3(flySunSpec(N, V, L, alpha2));
  vec3 sky = flySkyReflection(reflect(-V, Nm), alpha2, uReflect);
  return (under + spec) * uFlatSunInv + sky * F;
}
`;
