import type { Effect } from 'postprocessing'

// Fix for @takram/three-atmosphere <= 0.19.1 (WebGL path, still present on main
// as of 2026-11): in GetSkyRadiance(), when the camera is OUTSIDE the atmosphere,
// rays that miss the atmosphere but point toward Earth (rmu < 0) are treated as
// hitting it (SafeSqrt clamps the negative discriminant to 0, PR #26), which
// paints a huge fake atmosphere halo around the planet on the day side.
// Only GetSkyRadiance() (the variant with the `else if (r > top_radius)` early
// return) is patched; GetSkyRadianceToPoint() is left untouched.
const BUGGY =
  /if \(distance_to_top_atmosphere_boundary > 0\.0 \* m\) \{(\s*camera = camera \+ view_ray \* distance_to_top_atmosphere_boundary;\s*r = atmosphere\.top_radius;\s*rmu \+= distance_to_top_atmosphere_boundary;\s*\} else if \(r > atmosphere\.top_radius\))/g
const FIXED =
  'if (distance_to_top_atmosphere_boundary > 0.0 * m && ' +
  'rmu * rmu - r * r + atmosphere.top_radius * atmosphere.top_radius >= 0.0) {$1'

export function patchSpaceHalo(glsl: string): string {
  return glsl.replace(BUGGY, FIXED)
}

// AerialPerspectiveEffect (its `sky` option and SkyMaterial share the code).
export function patchEffect<T extends Effect>(effect: T): T {
  const src = effect.getFragmentShader()
  const next = patchSpaceHalo(src)
  if (next !== src) {
    // setFragmentShader() is protected in the typings but public at runtime.
    ;(effect as unknown as { setFragmentShader: (s: string) => void }).setFragmentShader(next)
  }
  return effect
}

/**
 * Look tweak (not a fix): near the ground, thin the aerial perspective a little. Transmittance
 * is raised to 0.8 and in-scatter scaled by 0.8 while the camera is below 30 km, fading back to
 * the physical values by 300 km. At the golden-hour hero view the full haze turned the Carson
 * Range (20-35 km away) into the same pale grey as the sky behind it.
 */
const HAZE = 'mix(0.8, 1.0, smoothstep(30.0, 300.0, length(vCameraPosition) - ATMOSPHERE.bottom_radius))'; // km
const TRANSMITTANCE = 'radiance = radiance * transmittance;';
const INSCATTER = 'radiance = radiance + inscatter;';
export function patchHaze<T extends Effect>(effect: T): T {
  const src = effect.getFragmentShader()
  if (src.includes('FLYTAKE_HAZE')) return effect
  if (!src.includes(TRANSMITTANCE) || !src.includes(INSCATTER)) {
    console.warn('[flytake] haze patch: aerial perspective shader changed, skipped')
    return effect
  }
  const next =
    '// FLYTAKE_HAZE\n' +
    src
      .replace(TRANSMITTANCE, `radiance = radiance * pow(transmittance, vec3(${HAZE}));`)
      .replace(INSCATTER, `radiance = radiance + inscatter * ${HAZE};`)
  ;(effect as unknown as { setFragmentShader: (s: string) => void }).setFragmentShader(next)
  return effect
}

// SkyMaterial, StarsMaterial (ShaderMaterials).
export function patchMaterial<T extends { fragmentShader: string; needsUpdate: boolean }>(material: T): T {
  const next = patchSpaceHalo(material.fragmentShader)
  if (next !== material.fragmentShader) {
    material.fragmentShader = next
    material.needsUpdate = true
  }
  return material
}

/**
 * Stars are drawn as points exactly on the far plane (cameraPosition + direction * far). With
 * Flytake's tight near/far range in orbit (far/near ~ 1.3) float32 rounding pushes them just
 * beyond it and every star is clipped. Pin them to depth 1.0 instead: z = w is still inside
 * the clip volume, and the aerial-perspective pass treats depth 1.0 as background, so the
 * stars are not relit as if they were terrain.
 */
const STAR_POINT_SIZE = /(\n\s*)gl_PointSize = pointSize;/;
export function patchStarsDepth<T extends { vertexShader: string; needsUpdate: boolean }>(material: T): T {
  if (!material.vertexShader.includes('FLYTAKE_STARS_DEPTH')) {
    material.vertexShader = material.vertexShader.replace(
      STAR_POINT_SIZE,
      '$1// FLYTAKE_STARS_DEPTH$1#ifdef BACKGROUND$1gl_Position.z = gl_Position.w;$1#endif$1gl_PointSize = pointSize;',
    );
    material.needsUpdate = true;
  }
  return material;
}

/**
 * Cloud shadows (three-clouds BSM) multiply AerialPerspective's sun irradiance by the clouds'
 * sun transmittance. Flytake's custom scene materials output PRE-LIT albedo (their sky fill is
 * already inside the colour, see src/world/light.ts) and the Google tiles have no separate sky
 * term either, so a plain multiply turns cloud shadows black. Keep a floor that stands in for
 * the sky light still reaching the shadowed ground (~30 % of the total at golden hour), a bit
 * more because cloud shadows on the lake looked like dark stains (the reflection is not shadowed).
 */
const CLOUD_SHADOW = 'sunIrradiance *= sunTransmittance;';
export const CLOUD_SHADOW_FLOOR = 0.42;
export function patchCloudShadow<T extends Effect>(effect: T): T {
  const src = effect.getFragmentShader()
  if (src.includes('FLYTAKE_CLOUD_SHADOW')) return effect
  if (!src.includes(CLOUD_SHADOW)) {
    console.warn('[flytake] cloud shadow patch: aerial perspective shader changed, skipped')
    return effect
  }
  const next =
    '// FLYTAKE_CLOUD_SHADOW\n' +
    src.replace(CLOUD_SHADOW, `sunIrradiance *= mix(${CLOUD_SHADOW_FLOOR.toFixed(3)}, 1.0, sunTransmittance);`)
  ;(effect as unknown as { setFragmentShader: (s: string) => void }).setFragmentShader(next)
  return effect
}
