/**
 * Global aerial perspective for EVERY material that uses three's fog chunks — without other modules
 * having to do anything.
 *
 * How: at import time we replace the fog shader chunks with an exponential height fog whose
 * in-scattered colour comes from the sky (16 horizon colours by azimuth, sampled from the baked
 * sky-view LUT) plus a Mie forward-scattering glow around the sun, and a separate low-lying dust
 * haze (setHaze). The extra parameters live in ONE shared Float32Array uniform `argusFog[]` that is
 * injected into ShaderLib / UniformsLib.fog. three's UniformsUtils.clone() copies typed arrays by
 * reference, so every material compiled later shares the same live array — updating it once per
 * time-of-day change updates the whole city.
 *
 * Materials that don't carry the uniform (custom ShaderMaterials that skipped UniformsLib.fog) see
 * argusFog[0].w == 0 and fall back to stock FogExp2 behaviour.
 */
import * as THREE from 'three';

export const FOG_SLOTS = 23;
/** Layout (vec4 slots):
 *  0: x = Rayleigh/aerosol extinction at y=0 (1/m), y = height falloff (1/m), z = dust extinction (1/m), w = enabled
 *  1: xyz = sun direction, w = Mie g
 *  2: rgb = sun in-scatter colour (radiance scale), w = dust height falloff (1/m)
 *  3: rgb = dust colour (radiance), w = max fog opacity (keeps far silhouettes faintly readable)
 *  4..19: rgb = horizon radiance for azimuth bins 0..15 (bin 0 = north, clockwise)
 *  20: rgb = zenith-ish radiance (for up-looking rays)
 *  21: dust cloud footprint: xy = centre (world x,z), z = radius (m) — dust is local to the city
 *  22: distance profile of the aerial perspective: optical depth is scaled by
 *      mix(x, y, smoothstep(z, w, distance)) — thin near the camera (crisp city), denser at range
 */
export const fogData = new Float32Array(FOG_SLOTS * 4);

const PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vArgusFogRel;
#endif
`;

// mvPosition is view-space; R^T * p_view = p_world - cameraPosition (camera-relative, precise).
const VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vArgusFogRel = transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif
`;

const PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vArgusFogRel;
	uniform vec4 argusFog[ ${FOG_SLOTS} ];
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	// Average of exp(-b*y) over a straight segment from height y0 to y1.
	float argusAvgDensity( float b, float y0, float y1 ) {
		float e0 = exp( - b * y0 );
		float dy = y1 - y0;
		return abs( b * dy ) > 1e-4 ? ( e0 - exp( - b * y1 ) ) / ( b * dy ) : e0;
	}
	vec3 argusApplyFog( vec3 col, vec3 rel ) {
		float dist = length( rel );
		vec3 rd = rel / max( dist, 1e-4 );
		float y0 = max( cameraPosition.y, -50.0 );
		float y1 = max( cameraPosition.y + rel.y, -50.0 );
		vec4 p0 = argusFog[ 0 ];
		vec4 pr = argusFog[ 22 ];
		float prof = pr.z < pr.w ? mix( pr.x, pr.y, smoothstep( pr.z, pr.w, dist ) ) : 1.0;
		float od = p0.x * dist * argusAvgDensity( p0.y, y0, y1 ) * prof;
		// Dust is confined to a disc over the city: average the radial falloff at 3 points.
		vec4 dc = argusFog[ 21 ];
		vec2 c0 = cameraPosition.xz - dc.xy;
		float R = max( dc.z, 1.0 );
		float rad = ( 1.0 - smoothstep( 0.55 * R, 1.25 * R, length( c0 ) ) )
			+ ( 1.0 - smoothstep( 0.55 * R, 1.25 * R, length( c0 + rel.xz * 0.5 ) ) )
			+ ( 1.0 - smoothstep( 0.55 * R, 1.25 * R, length( c0 + rel.xz ) ) );
		float odDust = p0.z * dist * argusAvgDensity( argusFog[ 2 ].w, y0, y1 ) * rad * ( 1.0 / 3.0 );
		float T = max( exp( - od ), 1.0 - argusFog[ 3 ].w );
		// Sky radiance toward this azimuth (16 bins, clockwise from north; +X east, -Z north).
		float az = atan( rd.x, - rd.z );
		float fi = fract( az / 6.28318530718 + 1.0 ) * 16.0;
		int i0 = int( floor( fi ) );
		int i1 = i0 == 15 ? 0 : i0 + 1;
		vec3 Lh = mix( argusFog[ 4 + i0 ].rgb, argusFog[ 4 + i1 ].rgb, fract( fi ) );
		Lh = mix( Lh, argusFog[ 20 ].rgb, clamp( rd.y * 1.5, 0.0, 1.0 ) * 0.6 );
		// Mie forward scattering (Henyey-Greenstein) — the warm glare looking toward a low sun.
		float g = argusFog[ 1 ].w;
		float cs = dot( rd, argusFog[ 1 ].xyz );
		float hg = ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * cs, 1e-4 ), 1.5 ) * 0.0795775;
		Lh += argusFog[ 2 ].rgb * hg;
		col = col * T + Lh * ( 1.0 - T );
		float Td = exp( - odDust );
		return col * Td + argusFog[ 3 ].rgb * ( 1.0 - Td );
	}
#endif
`;

const FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	if ( argusFog[ 0 ].w > 0.5 ) {
		gl_FragColor.rgb = argusApplyFog( gl_FragColor.rgb, vArgusFogRel );
	} else {
		#ifdef FOG_EXP2
			float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
		#else
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		#endif
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	}
#endif
`;

let installed = false;

/** Patch three's fog chunks + inject the shared uniform. Idempotent; runs at engine import time. */
export function installAerialPerspective(): void {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.fog_pars_vertex = PARS_VERTEX;
  chunks.fog_vertex = VERTEX;
  chunks.fog_pars_fragment = PARS_FRAGMENT;
  chunks.fog_fragment = FRAGMENT;
  const uniform = () => ({ value: fogData });
  (THREE.UniformsLib.fog as Record<string, THREE.IUniform>).argusFog = uniform();
  for (const lib of Object.values(THREE.ShaderLib)) {
    if (lib.uniforms && 'fogDensity' in lib.uniforms) lib.uniforms.argusFog = uniform();
  }
}

installAerialPerspective();

/** Fog uniforms (incl. the shared argusFog array) for custom ShaderMaterials that set fog: true. */
export function fogUniforms(): Record<string, THREE.IUniform> {
  return THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
}
