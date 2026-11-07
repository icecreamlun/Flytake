/**
 * Sky dome: samples the Sky-View LUT and adds what the LUT can't hold — the sun disc, the moon with
 * its phase, stars, a thin procedural cloud layer lit by the (reddened) sun, and dust haze.
 * Always centred on the camera and drawn first at depth 1 (no depth write), so it never clips.
 * The same material (with uEnvPass = 1: no sun disc, no stars) renders the PMREM environment.
 */
import * as THREE from 'three';
import { SKY_LUT_GLSL } from './skyLut';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = position;
	vec4 clip = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
	gl_Position = vec4( clip.xy, clip.w * 0.99999, clip.w );
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uLut;
uniform float uSunE;
uniform vec3 uSunDir;
uniform vec3 uSunDisc;
uniform float uSunCos;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uMoonCos;
uniform float uStars;
uniform float uTime;
uniform float uEnvPass;
uniform float uCloudCover;
uniform vec3 uCloudLit;
uniform vec3 uCloudAmb;
uniform float uHaze;
uniform vec3 uDust;
uniform vec3 uCamPos;
varying vec3 vDir;
${SKY_LUT_GLSL}

float hash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float hash13( vec3 p3 ) {
	p3 = fract( p3 * 0.1031 );
	p3 += dot( p3, p3.zyx + 31.32 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float vnoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( hash12( i ), hash12( i + vec2( 1, 0 ) ), u.x ), mix( hash12( i + vec2( 0, 1 ) ), hash12( i + vec2( 1, 1 ) ), u.x ), u.y );
}
float fbm( vec2 p ) {
	float a = 0.5;
	float s = 0.0;
	mat2 r = mat2( 0.8, - 0.6, 0.6, 0.8 );
	for ( int i = 0; i < 5; i ++ ) {
		s += a * vnoise( p );
		p = r * p * 2.03 + 17.1;
		a *= 0.5;
	}
	return s;
}

vec3 stars( vec3 d ) {
	vec3 p = d * 320.0;
	vec3 c = floor( p );
	float h = hash13( c );
	if ( h < 0.988 ) return vec3( 0.0 );
	vec3 sp = c + 0.5 + 0.35 * ( vec3( hash13( c + 7.1 ), hash13( c + 3.7 ), hash13( c + 1.3 ) ) - 0.5 );
	float dist = length( p - sp );
	float w = fwidth( p.x ) + fwidth( p.y );
	float mag = pow( ( h - 0.988 ) / 0.012, 5.0 );
	float tw = 0.75 + 0.25 * sin( uTime * ( 2.0 + 5.0 * hash13( c + 9.0 ) ) + h * 50.0 );
	float core = smoothstep( 0.18 + w, 0.0, dist );
	vec3 tint = mix( vec3( 0.75, 0.82, 1.0 ), vec3( 1.0, 0.86, 0.7 ), hash13( c + 4.4 ) );
	return tint * core * ( 0.05 + 2.4 * mag ) * tw;
}

void main() {
	vec3 d = normalize( vDir );
	// The visible dome never shows "ground" below the horizon (that sliver is open water to the
	// curved horizon in reality): hold the horizon colour. The env-map pass keeps the darker ground.
	vec3 ds = uEnvPass > 0.5 ? d : normalize( vec3( d.x, max( d.y, 0.0015 ), d.z ) );
	vec3 L = texture2D( uLut, skyLutUv( ds ) ).rgb * uSunE;
	float above = max( d.y, 0.0 );

	// Sun disc with limb darkening (omitted from the environment map — the directional light covers it).
	if ( uEnvPass < 0.5 ) {
		float cs = dot( d, uSunDir );
		float r = sqrt( max( 0.0, 1.0 - cs * cs ) ) / sqrt( max( 1e-8, 1.0 - uSunCos * uSunCos ) );
		float aa = fwidth( r ) * 1.5 + 1e-4;
		float disc = smoothstep( 1.0 + aa, 1.0 - aa, r ) * step( 0.0, cs );
		float limb = 1.0 - 0.55 * ( 1.0 - sqrt( max( 0.0, 1.0 - r * r ) ) );
		L += uSunDisc * disc * limb;
	}

	// Moon disc with phase and faint maria.
	{
		float cm = dot( d, uMoonDir );
		vec3 right = normalize( cross( uMoonDir, vec3( 0.0, 1.0, 0.0 ) ) );
		vec3 up = cross( right, uMoonDir );
		float rad = sqrt( max( 1e-8, 1.0 - uMoonCos * uMoonCos ) );
		vec2 q = vec2( dot( d, right ), dot( d, up ) ) / rad;
		float r2 = dot( q, q );
		if ( cm > 0.0 && r2 < 1.3 ) {
			float r = sqrt( r2 );
			float aa = fwidth( r ) * 1.5 + 1e-4;
			float disc = smoothstep( 1.0 + aa, 1.0 - aa, r );
			vec3 n = q.x * right + q.y * up - sqrt( max( 0.0, 1.0 - r2 ) ) * uMoonDir;
			float lit = smoothstep( - 0.05, 0.12, dot( n, uSunDir ) );
			float maria = 0.72 + 0.28 * smoothstep( 0.35, 0.7, vnoise( q * 2.3 + 4.0 ) * 0.6 + vnoise( q * 6.0 ) * 0.4 );
			L = mix( L, L * 0.6 + uMoonColor * maria * ( 0.03 + lit ), disc );
		}
	}

	// Thin cloud layer (~3.5 km) with parallax to the camera; lit by the reddened sun and the sky.
	if ( uCloudCover > 0.0 && d.y > 0.0 ) {
		float H = 3500.0 - uCamPos.y;
		float t = H / max( d.y, 0.02 );
		vec2 p = ( uCamPos.xz + d.xz * t ) / 5200.0 + vec2( uTime * 0.0016, uTime * 0.0006 );
		float n = fbm( p );
		float cov = 1.0 - uCloudCover;
		float dens = smoothstep( cov, cov + 0.32, n );
		if ( dens > 0.0 ) {
			// One step toward the sun for self-shadowing; forward-scatter silver lining.
			float n2 = fbm( p + normalize( uSunDir.xz + 1e-4 ) * 0.04 );
			float shade = clamp( 0.45 + ( n - n2 ) * 5.0, 0.15, 1.0 );
			float fwd = pow( max( dot( d, uSunDir ), 0.0 ), 8.0 );
			vec3 cc = uCloudLit * ( shade * ( 0.55 + 1.6 * fwd ) ) + uCloudAmb * ( 0.6 + 0.4 * ( 1.0 - dens ) );
			float far = 1.0 - exp( - t / 26000.0 );
			cc = mix( cc, L, far );
			float a = dens * smoothstep( 0.015, 0.12, d.y ) * 0.92;
			L = mix( L, cc, a );
		}
	}

	if ( uEnvPass < 0.5 && uStars > 0.0 ) L += stars( d ) * uStars * smoothstep( 0.0, 0.18, d.y );

	// Dust haze after collapses: browner, flatter sky near the horizon.
	L = mix( L, uDust, uHaze * ( 0.35 + 0.55 * exp( - above / 0.18 ) ) );

	// Below the horizon we never want a visible "edge of the world": blend to the haze colour.
	gl_FragColor = vec4( max( L, vec3( 0.0 ) ), 1.0 );
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(lut: THREE.Texture) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uLut: { value: lut },
        uSunE: { value: 1 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunDisc: { value: new THREE.Color(1, 1, 1) },
        uSunCos: { value: Math.cos(THREE.MathUtils.degToRad(0.27)) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uMoonColor: { value: new THREE.Color(0, 0, 0) },
        uMoonCos: { value: Math.cos(THREE.MathUtils.degToRad(0.42)) },
        uStars: { value: 0 },
        uTime: { value: 0 },
        uEnvPass: { value: 0 },
        uCloudCover: { value: 0.32 },
        uCloudLit: { value: new THREE.Color(1, 1, 1) },
        uCloudAmb: { value: new THREE.Color(0.2, 0.2, 0.2) },
        uHaze: { value: 0 },
        uDust: { value: new THREE.Color(0.3, 0.25, 0.2) },
        uCamPos: { value: new THREE.Vector3() },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), this.material);
    this.mesh.name = 'skyDome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1e6;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      // The env-map pass keeps the main camera's position (cloud parallax stays consistent).
      if (this.material.uniforms.uEnvPass.value < 0.5) {
        (this.material.uniforms.uCamPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
      }
    };
  }

  get uniforms() {
    return this.material.uniforms;
  }
}
