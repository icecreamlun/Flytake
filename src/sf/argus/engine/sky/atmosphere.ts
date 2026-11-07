/**
 * Physically based single-scattering atmosphere (Rayleigh + Mie + ozone, Hillaire 2020 Earth
 * parameters, km units) with a cheap isotropic multiple-scattering term.
 *
 * The GLSL is used to bake a Sky-View LUT (see skyLut.ts) that the sky dome, the IBL environment
 * (glass + water reflections) and the aerial-perspective fog all sample, so they always agree.
 * The JS mirror computes the sun colour (transmittance) for the key light with the same
 * constants; sky irradiance is integrated from the LUT read-back.
 *
 * Radiance units: per unit solar illuminance. Multiply by SUN_E (engine photometric scale).
 */
import * as THREE from 'three';

/** Engine photometric scale: sun illuminance at the top of the atmosphere, in three.js light units. */
export const SUN_E = 5.2;

export const ATM = {
  rg: 6360, // km
  rt: 6460,
  ray: [5.802e-3, 13.558e-3, 33.1e-3] as const, // km^-1
  rayH: 8,
  mieS: 3.996e-3,
  mieA: 4.4e-3,
  mieH: 1.2,
  mieG: 0.78,
  ozone: [0.65e-3, 1.881e-3, 0.085e-3] as const,
  /** Observer altitude the LUT is baked for (km). */
  viewH: 0.15,
  /** Isotropic multiple-scattering boost (fraction of scattering lit by a diffuse sky). */
  ms: 0.32,
} as const;

/** Shared GLSL: constants, phase functions, density, sun transmittance. Expects `uniform float uMieScale;`. */
export const ATMOSPHERE_GLSL = /* glsl */ `
#ifndef ATM_DEFINED
#define ATM_DEFINED
#define ATM_PI 3.141592653589793
const float ATM_RG = ${ATM.rg.toFixed(1)};
const float ATM_RT = ${ATM.rt.toFixed(1)};
const vec3 ATM_RAY = vec3(${ATM.ray.map((v) => v.toExponential(4)).join(',')});
const float ATM_RAY_H = ${ATM.rayH.toFixed(2)};
const float ATM_MIE_S = ${ATM.mieS.toExponential(4)};
const float ATM_MIE_A = ${ATM.mieA.toExponential(4)};
const float ATM_MIE_H = ${ATM.mieH.toFixed(3)};
const float ATM_MIE_G = ${ATM.mieG.toFixed(3)};
const vec3 ATM_OZONE = vec3(${ATM.ozone.map((v) => v.toExponential(4)).join(',')});
const float ATM_VIEW_H = ${ATM.viewH.toFixed(3)};
const float ATM_MS = ${ATM.ms.toFixed(3)};

float atmPhaseR(float c) { return 3.0 / (16.0 * ATM_PI) * (1.0 + c * c); }
float atmPhaseM(float c, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * ATM_PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
// Far intersection with a sphere centred at the origin (ray starts inside). Returns -1 if none.
float atmRaySphereFar(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  return -b + sqrt(d);
}
// Near ground hit distance, or -1.
float atmRayGround(vec3 ro, vec3 rd) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - ATM_RG * ATM_RG;
  float d = b * b - c;
  if (d < 0.0 || b > 0.0) return -1.0;
  return -b - sqrt(d);
}
vec3 atmExtinction(float h, float mieScale) {
  float dR = exp(-h / ATM_RAY_H);
  float dM = exp(-h / ATM_MIE_H) * mieScale;
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  return ATM_RAY * dR + vec3(ATM_MIE_S + ATM_MIE_A) * dM + ATM_OZONE * dO;
}
// Transmittance from point p (km, planet-centred) toward the sun, with a soft Earth shadow.
vec3 atmSunTransmittance(vec3 p, vec3 sunDir, float mieScale) {
  float r = length(p);
  float mu = dot(p, sunDir) / r;
  float tTop = atmRaySphereFar(p, sunDir, ATM_RT);
  if (tTop <= 0.0) return vec3(1.0);
  // Earth shadow: the sun is hidden once it drops below this point's geometric horizon
  // (soft over ~0.6° for the solar disc + refraction).
  float muHorizon = -sqrt(max(0.0, 1.0 - (ATM_RG * ATM_RG) / (r * r)));
  float shadow = smoothstep(-0.0065, 0.0045, mu - muHorizon);
  const int N = 10;
  float dt = tTop / float(N);
  vec3 od = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 q = p + sunDir * (dt * (float(i) + 0.5));
    od += atmExtinction(max(length(q) - ATM_RG, 0.0), mieScale) * dt;
  }
  return exp(-od) * shadow;
}
#endif
`;

// ───────────────────────────── JS mirror ─────────────────────────────

function extinction(h: number, mieScale: number, out: number[]) {
  const dR = Math.exp(-h / ATM.rayH);
  const dM = Math.exp(-h / ATM.mieH) * mieScale;
  const dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
  for (let i = 0; i < 3; i++) out[i] = ATM.ray[i] * dR + (ATM.mieS + ATM.mieA) * dM + ATM.ozone[i] * dO;
}

const _ext = [0, 0, 0];

/**
 * Transmittance from an observer at altitude hKm toward a direction with vertical component `dirY`
 * (unit vector). Returns linear RGB in `target`. Includes a soft Earth shadow below the horizon.
 */
export function transmittance(dirY: number, hKm: number, mieScale: number, target = new THREE.Color()): THREE.Color {
  const r = ATM.rg + hKm;
  const mu = THREE.MathUtils.clamp(dirY, -1, 1);
  // Ray-sphere far hit with the top of the atmosphere (2D: radial and horizontal components).
  const b = r * mu;
  const c = r * r - ATM.rt * ATM.rt;
  const tTop = -b + Math.sqrt(Math.max(0, b * b - c));
  // Earth shadow: below this altitude's geometric horizon (soft over ~0.6°), see GLSL twin.
  const muHorizon = -Math.sqrt(Math.max(0, 1 - (ATM.rg * ATM.rg) / (r * r)));
  const shadow = THREE.MathUtils.smoothstep(mu - muHorizon, -0.0065, 0.0045);
  const N = 64;
  const dt = tTop / N;
  const od = [0, 0, 0];
  const sinT = Math.sqrt(Math.max(0, 1 - mu * mu));
  for (let i = 0; i < N; i++) {
    const t = dt * (i + 0.5);
    const x = t * sinT;
    const y = r + t * mu;
    const h = Math.max(Math.hypot(x, y) - ATM.rg, 0);
    extinction(h, mieScale, _ext);
    od[0] += _ext[0] * dt;
    od[1] += _ext[1] * dt;
    od[2] += _ext[2] * dt;
  }
  return target.setRGB(Math.exp(-od[0]) * shadow, Math.exp(-od[1]) * shadow, Math.exp(-od[2]) * shadow);
}
