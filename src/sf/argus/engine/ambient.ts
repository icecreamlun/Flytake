/**
 * Ambient (diffuse IBL) grading for EVERY lit material, without other modules doing anything.
 *
 * The physically based sky irradiance is strongly blue (≈ 0.55 : 1.0 : 1.9 at noon). Used as-is for
 * the diffuse term it paints everything in shadow navy / cyan — the classic "CG" look. A real eye /
 * camera adapts to the dominant (sun) illuminant and the shadows read as a soft, only slightly cool
 * grey. We therefore grade the diffuse IBL irradiance (getIBLIrradiance): partial desaturation,
 * a neutral tint and an intensity scale. Specular IBL on smooth surfaces (glass, water, polished
 * metal) keeps the real sky colour, so reflections still read blue; rough materials' specular sky
 * sheen is graded like the diffuse term (it is ambient light in all but name).
 *
 * Like fog.ts this patches a shader chunk at import time and injects one shared Float32Array uniform
 * into the lit ShaderLib entries (typed arrays are shared by reference by UniformsUtils.clone, so
 * every material compiled later sees the live values). Materials without the uniform read zeros and
 * fall back to stock behaviour (slot 0 .w == 0).
 */
import * as THREE from 'three';

/** Layout (vec4 slots):
 *  0: x = saturation (0 grey .. 1 physical), y = diffuse IBL intensity scale, z = unused, w = enabled
 *  1: rgb = tint multiplier (luminance ≈ 1)
 */
export const ambientData = new Float32Array(2 * 4);
ambientData.set([0.45, 0.85, 0, 1, 1, 1, 1, 0]);

const ORIGINAL = 'return PI * envMapColor.rgb * envMapIntensity;';
const PATCHED = /* glsl */ `vec3 argusIrr = PI * envMapColor.rgb * envMapIntensity;
			if ( argusAmb[ 0 ].w > 0.5 ) {
				float argusL = dot( argusIrr, vec3( 0.2126, 0.7152, 0.0722 ) );
				argusIrr = mix( vec3( argusL ), argusIrr, argusAmb[ 0 ].x ) * argusAmb[ 1 ].rgb * argusAmb[ 0 ].y;
			}
			return argusIrr;`;

// Specular IBL: rough materials (asphalt, concrete, stucco) get the same adaptation — their sky
// sheen is effectively ambient light — while smooth ones (glass, water, polished metal) keep the
// physical sky colour.
const ORIGINAL_SPEC = 'return envMapColor.rgb * envMapIntensity;';
const PATCHED_SPEC = /* glsl */ `vec3 argusRad = envMapColor.rgb * envMapIntensity;
			if ( argusAmb[ 0 ].w > 0.5 ) {
				float argusL = dot( argusRad, vec3( 0.2126, 0.7152, 0.0722 ) );
				vec3 argusG = mix( vec3( argusL ), argusRad, argusAmb[ 0 ].x ) * argusAmb[ 1 ].rgb;
				argusRad = mix( argusRad, argusG, smoothstep( 0.3, 0.75, roughness ) );
			}
			return argusRad;`;

let installed = false;

export function installAmbientGrade(): void {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const src = chunks.envmap_physical_pars_fragment;
  const at = src.indexOf(ORIGINAL);
  if (at < 0) {
    console.warn('[engine] ambient grade: three envmap chunk changed; skipping patch');
    return;
  }
  chunks.envmap_physical_pars_fragment = src
    .replace('#ifdef USE_ENVMAP', '#ifdef USE_ENVMAP\n\tuniform vec4 argusAmb[ 2 ];')
    .replace(ORIGINAL, PATCHED)
    // First remaining occurrence = getIBLRadiance (the anisotropic variant comes later).
    .replace(ORIGINAL_SPEC, PATCHED_SPEC);
  for (const lib of Object.values(THREE.ShaderLib)) {
    if (lib.uniforms && 'envMap' in lib.uniforms) lib.uniforms.argusAmb = { value: ambientData };
  }
}

installAmbientGrade();
