/**
 * Shared material for instanced props and vehicles: vertex colours, per-vertex roughness / metalness,
 * optional per-instance tint (only on vertices flagged tintable), and typed emissives:
 * street lamps & lanterns follow the night factor and power state (with a flicker as power fails),
 * traffic signals cycle red → green → amber per intersection phase group, vehicle lights stay on.
 * uLamp = night factor, uSig = mains power 0..1 (flicker in between).
 * Per-instance attribute aInst = (signal cycle offset s, phase group 0/1, power-flicker seed, unused).
 */
import * as THREE from 'three';

export interface PropUniforms {
  uTime: { value: number };
  uLamp: { value: number };
  uSig: { value: number };
  uVeh: { value: number };
  uNight: { value: number };
}

/**
 * opts.physical: MeshPhysicalMaterial with a clear coat on tintable (painted) vertices only — vehicle bodies get a
 * lacquer highlight over the base coat, glass / trim / tyres do not.
 */
export function createPropMaterial(uniforms: PropUniforms, opts: { instAttr?: boolean; physical?: boolean } = {}): THREE.MeshStandardMaterial {
  const mat = opts.physical
    ? new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.07 })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
  const inst = opts.instAttr !== false;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aPbr;
attribute float aEmit;
${inst ? 'attribute vec4 aInst;' : ''}
varying vec3 vPbr;
varying float vEmit;
varying vec4 vInst;`,
      )
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	vColor = vec4( color, 1.0 );
	#ifdef USE_INSTANCING_COLOR
		vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, aPbr.z );
	#endif
#endif
vPbr = aPbr;
vEmit = aEmit;
vInst = ${inst ? 'aInst' : 'vec4( 0.0 )'};`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uLamp;
uniform float uSig;
uniform float uVeh;
uniform float uNight;
varying vec3 vPbr;
varying float vEmit;
varying vec4 vInst;
vec3 propEmit() {
	int e = int( vEmit + 0.5 );
	if ( e == 0 ) return vec3( 0.0 );
	// Per-instance flicker while the power is failing (uLamp/uSig between 0 and 1).
	// uSig = mains power (1 on, 0 out); flicker only while it is failing / returning.
	float pw = uSig;
	if ( pw > 0.02 && pw < 0.98 ) pw = step( 1.0 - pw, fract( sin( floor( uTime * 13.0 ) * 12.9898 + vInst.z * 78.233 ) * 43758.5453 ) );
	if ( e == 1 || e == 2 || e == 11 || e == 7 ) {
		float k = uLamp * step( 0.5, pw );
		if ( e == 1 ) return vec3( 1.0, 0.84, 0.62 ) * 16.0 * k;
		if ( e == 2 ) return vec3( 1.0, 0.09, 0.03 ) * 1.25 * k;
		if ( e == 11 ) return vec3( 1.0, 0.78, 0.5 ) * 12.0 * k;
		return vec3( 0.85, 0.9, 1.0 ) * 2.5 * k;
	}
	if ( e >= 3 && e <= 6 ) {
		float s = step( 0.5, pw );
		float t = mod( uTime + vInst.x + vInst.y * 30.0, 60.0 );
		// green 0-26, amber 26-29, red 29-60
		float g = step( t, 26.0 );
		float a = step( 26.0, t ) * step( t, 29.0 );
		float r = step( 29.0, t );
		vec3 day = vec3( 1.0 ) * ( 2.5 + 3.0 * uNight );
		if ( e == 3 ) return vec3( 1.0, 0.06, 0.03 ) * r * day * s + vec3( 0.04, 0.0, 0.0 );
		if ( e == 4 ) return vec3( 1.0, 0.5, 0.04 ) * a * day * s + vec3( 0.03, 0.015, 0.0 );
		if ( e == 5 ) return vec3( 0.12, 1.0, 0.55 ) * g * day * s + vec3( 0.0, 0.03, 0.015 );
		return vec3( 1.0, 0.42, 0.1 ) * ( 0.6 + 1.6 * uNight ) * s;
	}
	if ( e == 8 ) return vec3( 1.0, 0.95, 0.85 ) * ( 0.4 + 18.0 * uVeh );
	if ( e == 9 ) return vec3( 1.0, 0.03, 0.02 ) * ( 0.25 + 5.0 * uVeh );
	if ( e == 10 ) return vec3( 1.0, 0.85, 0.62 ) * 1.6 * uNight;
	return vec3( 0.0 );
}`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
      .replace('material.clearcoat = clearcoat;', 'material.clearcoat = clearcoat * vPbr.z;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += propEmit();');
  };
  mat.customProgramCacheKey = () => `argus-props-v1-${inst ? 1 : 0}-${opts.physical ? 1 : 0}`;
  return mat;
}
