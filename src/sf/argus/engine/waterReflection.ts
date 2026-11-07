/**
 * Screen-space planar reflections for the bay (post effect, HDR, before bloom).
 *
 * The bay is an exact plane (y = 0), so a water pixel is found analytically: intersect the pixel's
 * view ray with y = 0 and accept it when the depth buffer agrees. From there the reflected ray
 * (perturbed by an animated wave normal) is marched through the depth buffer; on a hit the scene
 * colour is fetched with a short vertical blur, which turns lights into the long shimmering
 * streaks you see on the bay at night (skyline, Bay Lights, the Embarcadero) and gives the
 * waterfront soft, wobbling reflections by day. Fresnel-weighted; fades at the screen edges where
 * the information is missing. Misses keep the material's own sky (IBL) reflection.
 *
 * Cost: one depth fetch for non-water pixels; ≈ 24 march steps + 5 colour taps for water.
 */
import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

const FRAG = /* glsl */ `
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform mat4 uViewM;
uniform mat4 uCamWorld;
uniform float uTime;
uniform float uStrength;
uniform float uStreak;
uniform float uDebug;

vec3 wrViewPos( vec2 p, float d ) {
	vec4 v = uInvProj * vec4( p * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
	return v.xyz / v.w;
}
float wrHash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float wrNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( wrHash( i ), wrHash( i + vec2( 1, 0 ) ), u.x ), mix( wrHash( i + vec2( 0, 1 ) ), wrHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}

void mainImage( const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor ) {
	outputColor = inputColor;
	if ( uStrength <= 0.0 || depth >= 1.0 ) return;
	vec3 camPos = uCamWorld[ 3 ].xyz;
	if ( camPos.y <= 0.05 ) return;
	vec3 vp = wrViewPos( uv, depth );
	vec3 rd = normalize( ( uCamWorld * vec4( vp, 0.0 ) ).xyz );
	if ( rd.y > -1e-4 ) return;
	float t = - camPos.y / rd.y;
	// Is the visible surface the bay plane? Test the reconstructed height, not the distance: at
	// grazing angles a shore 1.5 m above the water is only metres "short" of the plane along the ray,
	// but its height error stays tiny (depth error × |rd.y|).
	float dz = length( vp );
	if ( abs( camPos.y + rd.y * dz ) > 0.3 + dz * 2e-5 ) return;
	vec3 P = camPos + rd * t;
	if ( uDebug > 0.5 ) outputColor = vec4( 0.0, 0.25, 0.0, 1.0 );

	// Wave normal: two drifting noise octaves, flatter with distance (no shimmer at range).
	float amp = mix( 0.055, 0.012, smoothstep( 60.0, 4000.0, t ) );
	vec2 q = P.xz;
	vec2 g = vec2( wrNoise( q * 0.11 + uTime * vec2( 0.31, 0.17 ) ), wrNoise( q * 0.11 + 17.0 - uTime * vec2( 0.13, 0.27 ) ) )
		+ 0.5 * vec2( wrNoise( q * 0.37 - uTime * vec2( 0.4, 0.1 ) ), wrNoise( q * 0.37 + 5.0 + uTime * vec2( 0.2, 0.45 ) ) );
	vec3 N = normalize( vec3( ( g.x - 0.75 ) * amp * 2.0, 1.0, ( g.y - 0.75 ) * amp * 2.0 ) );
	vec3 R = reflect( rd, N );
	if ( R.y <= 0.0 ) return;
	float NoV = clamp( dot( N, - rd ), 0.0, 1.0 );
	float F = 0.02 + 0.98 * pow( 1.0 - NoV, 5.0 );
	float w = F * uStrength;
	if ( w < 0.004 ) return;

	// March the reflected ray through the depth buffer (geometric steps).
	float s = max( 1.5, t * 0.004 );
	float sPrev = 0.0;
	bool hit = false;
	vec2 huv = vec2( 0.0 );
	for ( int i = 0; i < 26; i ++ ) {
		vec3 Q = P + R * s;
		vec4 clip = uProj * ( uViewM * vec4( Q, 1.0 ) );
		if ( clip.w <= 0.0 ) break;
		vec2 quv = clip.xy / clip.w * 0.5 + 0.5;
		if ( quv.x < 0.0 || quv.x > 1.0 || quv.y < 0.0 || quv.y > 1.0 ) break;
		float sd = readDepth( quv );
		float qz = clip.w;                         // view depth of the ray sample
		float sz = - wrViewPos( quv, sd ).z;       // view depth of the scene there
		if ( sd < 1.0 && qz > sz && qz - sz < max( 3.0, ( s - sPrev ) * 2.0 ) ) {
			// Binary refinement between the previous and this step.
			float a = sPrev;
			float b = s;
			for ( int k = 0; k < 5; k ++ ) {
				float m = 0.5 * ( a + b );
				vec4 c2 = uProj * ( uViewM * vec4( P + R * m, 1.0 ) );
				vec2 u2 = c2.xy / c2.w * 0.5 + 0.5;
				float z2 = - wrViewPos( u2, readDepth( u2 ) ).z;
				if ( c2.w > z2 ) b = m; else a = m;
			}
			vec4 c3 = uProj * ( uViewM * vec4( P + R * b, 1.0 ) );
			huv = c3.xy / c3.w * 0.5 + 0.5;
			hit = true;
			break;
		}
		sPrev = s;
		s *= 1.3;
	}
	if ( ! hit ) return;
	// A planar reflection always comes from above the water pixel on screen, from something farther
	// away (horizontally) and above the water: reject anything else (shore / depth-edge false hits).
	vec3 hw = ( uCamWorld * vec4( wrViewPos( huv, readDepth( huv ) ), 1.0 ) ).xyz;
	if ( huv.y <= uv.y || hw.y < 0.5 || length( hw.xz - camPos.xz ) < t - 1.0 ) return;
	if ( uDebug > 0.5 ) { outputColor = vec4( huv, 1.0, 1.0 ); return; }
	// Vertical streak blur: wave facets smear reflections along the screen's vertical. 9 taps spaced
	// finely enough that 1–2 px lights become continuous streaks, not dotted columns.
	float k = uStreak * ( 0.4 + 0.6 * smoothstep( 0.0, 0.25, 1.0 - NoV ) ) * 0.5;
	vec3 refl = vec3( 0.0 );
	float ws = 0.0;
	for ( int j = - 4; j <= 4; j ++ ) {
		float fj = float( j );
		float wj = exp( - fj * fj / 9.0 );
		vec3 c = texture2D( inputBuffer, huv + vec2( 0.0, fj * k ) ).rgb;
		// Cap very bright sources (sun glints on glass) so they don't turn into white bars.
		float lc = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
		refl += c * ( min( lc, 3.0 ) / max( lc, 1e-4 ) ) * wj;
		ws += wj;
	}
	refl /= ws;
	float edge = smoothstep( 0.0, 0.08, min( huv.x, 1.0 - huv.x ) ) * smoothstep( 0.0, 0.08, min( huv.y, 1.0 - huv.y ) );
	outputColor = vec4( mix( inputColor.rgb, refl, clamp( w * edge, 0.0, 1.0 ) ), inputColor.a );
}
`;

export class WaterReflectionEffect extends Effect {
  constructor(private readonly camera: THREE.PerspectiveCamera) {
    super('WaterReflectionEffect', FRAG, {
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['uProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uInvProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uViewM', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uTime', new THREE.Uniform(0)],
        ['uStrength', new THREE.Uniform(1)],
        ['uStreak', new THREE.Uniform(0.004)],
        ['uDebug', new THREE.Uniform(0)],
      ]),
    });
  }

  /** Overall strength (0 disables); streak: vertical blur half-length in UV units. */
  set(strength: number, streak: number): void {
    this.uniforms.get('uStrength')!.value = strength;
    this.uniforms.get('uStreak')!.value = streak;
  }

  override update(_renderer: THREE.WebGLRenderer, _input: THREE.WebGLRenderTarget, dt?: number): void {
    const cam = this.camera;
    const u = this.uniforms;
    (u.get('uProj')!.value as THREE.Matrix4).copy(cam.projectionMatrix);
    (u.get('uInvProj')!.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (u.get('uViewM')!.value as THREE.Matrix4).copy(cam.matrixWorldInverse);
    (u.get('uCamWorld')!.value as THREE.Matrix4).copy(cam.matrixWorld);
    u.get('uTime')!.value += dt ?? 0;
  }
}
