/**
 * Road paint material. Every marking is a draped strip with attributes
 *   aMk = (u: metres along, v: −1..1 across, hw: true half width (m), style id)
 *   aAx = across direction (xz) used to widen thin lines to ≥ ~0.8 px in the vertex shader.
 * The fragment shader evaluates dash patterns and both edges analytically with fwidth-based AA, so lines
 * stay crisp up close and fade to their average coverage far away (no shimmer, no broken dashes).
 */
import * as THREE from 'three';
import { NOISE_GLSL } from '../ground/glsl';

export const enum Style {
  White = 0,
  Yellow = 1,
  Crosswalk = 2,
  StopBar = 3,
  Transit = 4,
  Bike = 5,
  Gutter = 6,
  Wear = 7,
  Oil = 8,
  TreeWell = 9,
  TrackBed = 10,
  Rail = 11,
  Slot = 12,
  ParkTick = 13,
  Grate = 14,
}

/** Per style: colour rgb (linear albedo), opacity. */
const STYLE_A: [number, number, number, number][] = [
  [0.62, 0.62, 0.6, 0.92], // white lane line
  [0.62, 0.42, 0.05, 0.92], // yellow centre line
  [0.66, 0.66, 0.64, 0.95], // crosswalk bars
  [0.66, 0.66, 0.64, 0.95], // stop bar
  [0.3, 0.035, 0.03, 0.9], // red transit-only lane
  [0.07, 0.26, 0.12, 0.85], // green bike lane
  [0.33, 0.325, 0.31, 0.97], // concrete gutter pan
  [0.012, 0.012, 0.012, 0.22], // tyre wear (darkening)
  [0.01, 0.01, 0.009, 0.16], // oil drip line
  [0.045, 0.035, 0.025, 0.96], // tree well soil
  [0.24, 0.235, 0.225, 0.96], // track bed (concrete)
  [0.42, 0.4, 0.38, 1.0], // rail head (steel)
  [0.01, 0.01, 0.01, 1.0], // cable slot
  [0.62, 0.62, 0.6, 0.9], // parking tick
  [0.05, 0.05, 0.05, 0.95], // cast-iron grate
];
/** Per style: dash length, gap length (0 = solid), roughness, metalness. */
const STYLE_B: [number, number, number, number][] = [
  [3.0, 9.0, 0.55, 0],
  [0, 0, 0.55, 0],
  [0.6, 0.6, 0.55, 0],
  [0, 0, 0.55, 0],
  [0, 0, 0.6, 0],
  [0, 0, 0.6, 0],
  [0, 0, 0.82, 0],
  [0, 0, 0.7, 0],
  [0, 0, 0.35, 0],
  [0, 0, 0.98, 0],
  [0, 0, 0.85, 0],
  [0, 0, 0.32, 0.85],
  [0, 0, 0.9, 0],
  [0.5, 5.6, 0.55, 0],
  [0, 0, 0.5, 0.6],
];

const PARS_V = /* glsl */ `
attribute vec4 aMk;
attribute vec2 aAx;
uniform float uPxAngle;
varying vec4 vMk;
varying float vMkCov;
varying vec3 vMkWorld;
`;

const MAIN_V = /* glsl */ `
{
	vec3 wp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	float pxm = distance( wp, cameraPosition ) * uPxAngle;
	float wEff = max( aMk.z, pxm * 0.8 );
	transformed.xz += aAx * aMk.y * ( wEff - aMk.z );
	vMkCov = aMk.z / wEff;
	vMk = aMk;
	vMkWorld = wp;
}
`;

const PARS_F = /* glsl */ `
uniform vec4 uStyleA[ 15 ];
uniform vec4 uStyleB[ 15 ];
varying vec4 vMk;
varying float vMkCov;
varying vec3 vMkWorld;
float mkRough;
float mkMetal;
${NOISE_GLSL}
`;

const COLOR_F = /* glsl */ `
{
	int sid = int( vMk.w + 0.5 );
	vec4 sa = uStyleA[ sid ];
	vec4 sb = uStyleB[ sid ];
	float u = vMk.x;
	float v = vMk.y;
	// Across: the true line occupies |v| <= cov (cov < 1 only when widened for distance).
	float fv = max( fwidth( v ), 1e-4 );
	float across = clamp( ( vMkCov - abs( v ) ) / fv + 0.5, 0.0, 1.0 );
	float soft = ( sid == 7 || sid == 8 ) ? 1.0 - smoothstep( 0.2, 1.0, abs( v ) ) : 1.0;
	across = min( across, 1.0 ) * soft;
	if ( vMkCov < 1.0 ) across = vMkCov * ( 1.0 - smoothstep( 0.5, 1.0, abs( v ) ) ) * 1.6;
	// Along: dash pattern.
	float along = 1.0;
	if ( sb.y > 0.0 ) {
		float P = sb.x + sb.y;
		float fu = max( fwidth( u ), 1e-4 );
		float ph = mod( u, P );
		float a0 = clamp( ( sb.x - ph ) / fu + 0.5, 0.0, 1.0 ) * clamp( ph / fu + 0.5, 0.0, 1.0 );
		float avg = sb.x / P;
		along = mix( a0, avg, smoothstep( 0.25, 0.7, fu / P ) );
	}
	// Worn paint: blotchy fading plus small chips.
	vec2 p = vMkWorld.xz;
	float px = length( fwidth( p ) );
	float wear = 0.72 + 0.28 * sNoise( p, 0.35 );
	float chips = mix( 0.45 + 0.55 * smoothstep( 0.1, 0.22, sNoise( p, 13.0 ) ), 0.88, smoothstep( 0.02, 0.06, px ) );
	float worn = ( sid <= 5 || sid == 13 ) ? wear * chips : ( sid == 7 || sid == 8 ) ? 0.6 + 0.8 * sNoise( p + 3.0, 0.6 ) : 1.0;
	float alpha = sa.a * across * along * worn;
	if ( alpha < 0.004 ) discard;
	vec3 col = sa.rgb;
	if ( sid == 6 || sid == 10 ) col *= 0.85 + 0.25 * sNoise( p, 1.3 );
	if ( sid == 9 ) col *= 0.7 + 0.6 * sNoise( p, 4.0 );
	if ( sid == 14 ) col *= 0.6 + 0.8 * step( 0.5, fract( u * 12.0 ) );
	diffuseColor = vec4( col, alpha );
	mkRough = sb.z;
	mkMetal = sb.w;
}
`;

export function createMarkingMaterial(): { material: THREE.MeshStandardMaterial; uniforms: { uPxAngle: { value: number } } } {
  const uniforms = {
    uPxAngle: { value: 0.001 },
    uStyleA: { value: STYLE_A.map((a) => new THREE.Vector4(...a)) },
    uStyleB: { value: STYLE_B.map((b) => new THREE.Vector4(...b)) },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -6,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS_V}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${MAIN_V}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS_F}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${COLOR_F}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mkRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mkMetal;');
  };
  mat.customProgramCacheKey = () => 'argus-markings-v1';
  return { material: mat, uniforms };
}
