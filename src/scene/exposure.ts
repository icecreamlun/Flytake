import { MathUtils } from 'three';
import { SUN } from '../world/sun';

/**
 * Scripted look by camera height above the lake, interpolated in log-height with an eased
 * blend between keys (so nothing ever changes slope abruptly). There is no auto-exposure.
 *
 * exposure    AgX `gl.toneMappingExposure`: scales everything, sky and haze included.
 * albedoScale AerialPerspective's albedo multiplier: scales only the sun-lit ground.
 *
 * Near the lake the low (~10 deg) sun lights flat ground weakly. Raising only the exposure to
 * compensate blew the sky and the haze to near-white and AgX drained their colour; raising the
 * albedo instead keeps the ground as bright as before (exposure x albedo ~ unchanged) while the
 * sky and haze sit ~0.6x lower and keep their blue. Values were tuned on screenshots at the
 * demo date with sun-only relighting.
 */
type Key<T> = [height: number, value: T];

function interpolate<T>(keys: ReadonlyArray<Key<T>>, heightAboveSurface: number, lerp: (a: T, b: T, k: number) => T): T {
  const h = Math.max(1, Number.isFinite(heightAboveSurface) ? heightAboveSurface : 1);
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (h >= first[0]) return first[1];
  if (h <= last[0]) return last[1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [h0, v0] = keys[i]!;
    const [h1, v1] = keys[i + 1]!;
    if (h <= h0 && h >= h1) {
      // 0 at h0 -> 1 at h1, eased
      const k = 1 - MathUtils.smoothstep(Math.log(h), Math.log(h1), Math.log(h0));
      return lerp(v0, v1, k);
    }
  }
  return last[1];
}

const logLerp = (a: number, b: number, k: number): number => Math.exp(MathUtils.lerp(Math.log(a), Math.log(b), k));

const EXPOSURE_KEYS: ReadonlyArray<Key<number>> = [
  [24_000_000, 6],
  [2_000_000, 6.2],
  [300_000, 6.8],
  [30_000, 6.5],
  [5_000, 7.0],
  [1_500, 7.6],
  [400, 8.2],
];

/** Relative to the ?albedo= default (1.4). */
const ALBEDO_KEYS: ReadonlyArray<Key<number>> = [
  [30_000, 1.4],
  [5_000, 2.0],
  [1_500, 2.3],
  [400, 2.4],
];

/**
 * Time of day (src/world/sun.ts): the scene gets darker and warmer as the sun drops (ground
 * irradiance ~ transmittance x sin(elevation)). Compensate about half of it in log space, so
 * noon is not blown out and 16:15 is still readable while keeping the evening mood.
 * Keys: sun elevation (deg) -> exposure multiplier, 1 at 15:00 on demo day (18.1 deg).
 */
const SUN_EXPOSURE_KEYS: ReadonlyArray<[number, number]> = [
  [3, 1.6],
  [6, 1.45],
  [9, 1.3],
  [13, 1.13],
  [18, 1],
  [25, 0.88],
  [35, 0.78],
];

function piecewise(keys: ReadonlyArray<[number, number]>, x: number): number {
  if (x <= keys[0]![0]) return keys[0]![1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [x0, v0] = keys[i]!;
    const [x1, v1] = keys[i + 1]!;
    if (x <= x1) return logLerp(v0, v1, MathUtils.smoothstep(x, x0, x1));
  }
  return keys[keys.length - 1]![1];
}

const sunElevationDeg = (): number => (SUN.elevation * 180) / Math.PI;

export function exposureForSun(elevationDeg = sunElevationDeg()): number {
  return piecewise(SUN_EXPOSURE_KEYS, elevationDeg);
}

/** 0 at midday, 1 at golden hour: scales the warm split tone of the grade. */
export function goldenHour(elevationDeg = sunElevationDeg()): number {
  return 1 - MathUtils.smoothstep(elevationDeg, 16, 30);
}

export function exposureForHeight(heightAboveSurface: number): number {
  // the sun's influence fades out in orbit (the whole planet is in view there)
  const k = 1 - MathUtils.smoothstep(Math.log(Math.max(heightAboveSurface, 1)), Math.log(60_000), Math.log(600_000));
  return interpolate(EXPOSURE_KEYS, heightAboveSurface, logLerp) * Math.pow(exposureForSun(), k);
}

export function albedoForHeight(heightAboveSurface: number): number {
  return interpolate(ALBEDO_KEYS, heightAboveSurface, logLerp);
}

export interface Grade {
  /** S-curve amount in display (gamma) space, 0..1 */
  contrast: number;
  /** -1..1, 0 = unchanged */
  saturation: number;
  /** split-tone amount: cool shadows, warm highlights */
  warmth: number;
  /** white-balance multipliers */
  wb: [number, number, number];
}

const GROUND: Grade = { contrast: 0.3, saturation: 0.12, warmth: 1, wb: [1, 1, 1] };
/** 100 - 2,500 km: Google's mid-scale imagery is strongly orange-red ("Mars"); cool it down. */
const REGIONAL: Grade = { contrast: 0.18, saturation: -0.08, warmth: 0.3, wb: [0.93, 0.98, 1.08] };
const ORBIT: Grade = { contrast: 0.18, saturation: 0.1, warmth: 0.2, wb: [1, 1, 1] };

const GRADE_KEYS: ReadonlyArray<Key<Grade>> = [
  [8_000_000, ORBIT],
  [2_500_000, REGIONAL],
  [100_000, REGIONAL],
  [20_000, GROUND],
];

const lerpGrade = (a: Grade, b: Grade, k: number): Grade => ({
  contrast: MathUtils.lerp(a.contrast, b.contrast, k),
  saturation: MathUtils.lerp(a.saturation, b.saturation, k),
  warmth: MathUtils.lerp(a.warmth, b.warmth, k),
  wb: [MathUtils.lerp(a.wb[0], b.wb[0], k), MathUtils.lerp(a.wb[1], b.wb[1], k), MathUtils.lerp(a.wb[2], b.wb[2], k)],
});

/** Final grade by height (see GradeEffect), with the golden split tone following the sun. */
export function gradeForHeight(heightAboveSurface: number): Grade {
  // copy: interpolate() returns the key objects themselves outside the key range
  const grade = { ...interpolate(GRADE_KEYS, heightAboveSurface, lerpGrade) };
  const golden = goldenHour();
  // midday: a cleaner, slightly cooler and more saturated look; golden hour as tuned
  grade.warmth *= MathUtils.lerp(0.35, 1, golden);
  grade.saturation += MathUtils.lerp(0.04, 0, golden);
  return grade;
}
