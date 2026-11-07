import { Vector3 } from 'three';
import { SUN, onSunChange } from './sun';

/**
 * Lighting of the custom scene.
 *
 * Every pixel goes through takram's AerialPerspective with sun-only relighting and no normal
 * buffer: it multiplies the colour by sunIrradiance * max(dot(flatNormal, sunDir), 0). The
 * custom materials therefore output PRE-LIT ALBEDO relative to that flat term:
 *   rgb = albedo * (direct * uSunColor + uAmbient) * uFlatSunInv
 * where `direct` is N.L x shadow in units of the sun's normal irradiance (the shadow comes from
 * the live GPU shadow field, see shadowField.ts) and uAmbient the sky fill in the same units.
 * The sun follows the time of day (sun.ts).
 */
export const SCENE_LIGHT = {
  /** unit vector toward the sun in the scene ENU frame */
  uSunDir: { value: new Vector3(-0.729, -0.611, 0.311) },
  uFlatSunInv: { value: 1 / 0.311 },
  uSunColor: { value: new Vector3(1, 1, 1) },
  /** sky irradiance relative to the sun's normal irradiance (bluish) */
  uAmbient: { value: new Vector3(0.085, 0.105, 0.15) },
  uTime: { value: 0 },
};

/**
 * Sky fill relative to the direct sun as a function of the sun elevation. Pre-lit units: the
 * post pass multiplies everything by the sun's irradiance, which turns orange as the sun gets
 * low (its blue is scattered out first) while the sky light stays blue. So the ratio grows as
 * the sun drops, and its blue part grows fastest; otherwise the shade would come out golden.
 * Tuned at 18 deg (15:00 on demo day) = (0.085, 0.105, 0.15).
 */
export function ambientForElevation(elevationRad: number, out = new Vector3()): Vector3 {
  const deg = (elevationRad * 180) / Math.PI;
  const k = 18 / Math.max(deg, 3); // > 1 when the sun is lower than at 15:00
  const s = Math.pow(k, 0.35);
  const low = Math.min(1, Math.max(0, (14 - deg) / 10)); // 0 above 14 deg, 1 at 4 deg
  return out.set(0.085 * s * (1 - 0.15 * low), 0.105 * s * (1 + 0.1 * low), 0.15 * s * (1 + 0.7 * low));
}

/** Recompute the sun-dependent uniforms (called on every time-of-day change). */
export function updateSceneSun(): void {
  SCENE_LIGHT.uSunDir.value.copy(SUN.dirEnu);
  SCENE_LIGHT.uFlatSunInv.value = 1 / Math.max(SUN.dirEnu.z, 0.05);
  ambientForElevation(SUN.elevation, SCENE_LIGHT.uAmbient.value);
}
onSunChange(updateSceneSun);
