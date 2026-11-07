/**
 * Shared GLSL helpers for the streets module: precision-safe hashes / value noise (with analytic derivatives)
 * over world coordinates. World coordinates reach ±3 km, so noise lattices are made periodic (1024 cells) and
 * coordinates are reduced with mod() BEFORE scaling — this keeps float32 precision at every frequency.
 */
export const NOISE_GLSL = /* glsl */ `
float sHash( vec2 i ) {
	i = mod( i, 1024.0 );
	vec3 p3 = fract( vec3( i.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float sHash3( vec3 i ) {
	i = mod( i, 1024.0 );
	vec3 p3 = fract( i * 0.1031 );
	p3 += dot( p3, p3.zyx + 31.32 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
// Value noise with derivatives (x: value 0..1, yz: d/dx, d/dy) on lattice coords.
vec3 sNoiseD( vec2 x ) {
	vec2 i = floor( x );
	vec2 f = x - i;
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	vec2 du = 6.0 * f * ( 1.0 - f );
	float a = sHash( i );
	float b = sHash( i + vec2( 1.0, 0.0 ) );
	float c = sHash( i + vec2( 0.0, 1.0 ) );
	float d = sHash( i + vec2( 1.0, 1.0 ) );
	float k1 = b - a;
	float k2 = c - a;
	float k4 = a - b - c + d;
	return vec3( a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * ( vec2( k1, k2 ) + k4 * u.yx ) );
}
// World-space noise at frequency f (cycles per metre): derivatives in 1/m.
vec3 sNoiseW( vec2 p, float f ) {
	float per = 1024.0 / f;
	return sNoiseD( mod( p, per ) * f ) * vec3( 1.0, f, f );
}
float sNoise( vec2 p, float f ) {
	return sNoiseW( p, f ).x;
}
// 2-octave fbm (value, d/dx, d/dz), octaves faded out once they drop below ~2 px (px = metres per pixel).
vec3 sFbm( vec2 p, float f, float px ) {
	vec3 s = vec3( 0.0 );
	float a = 0.5;
	float norm = 0.0;
	for ( int k = 0; k < 2; k ++ ) {
		float fade = 1.0 - smoothstep( 0.25, 0.5, px * f );
		s += sNoiseW( p + float( k ) * 17.3, f ) * a * fade;
		norm += a;
		f *= 2.03;
		a *= 0.5;
	}
	return s / norm;
}
// Cellular noise on lattice coords x: (F1, F2 − F1 ≈ distance to the cell border, cell hash a, cell hash b).
vec4 sVoronoi( vec2 x ) {
	vec2 i = floor( x );
	vec2 f = x - i;
	float d1 = 8.0;
	float d2 = 8.0;
	vec2 id = vec2( 0.0 );
	for ( int j = - 1; j <= 1; j ++ ) {
		for ( int k = - 1; k <= 1; k ++ ) {
			vec2 c = vec2( float( k ), float( j ) );
			vec2 o = vec2( sHash( i + c ), sHash( i + c + 57.0 ) );
			vec2 r = c + 0.08 + o * 0.84 - f;
			float d = dot( r, r );
			if ( d < d1 ) {
				d2 = d1;
				d1 = d;
				id = i + c;
			} else if ( d < d2 ) d2 = d;
		}
	}
	d1 = sqrt( d1 );
	return vec4( d1, sqrt( d2 ) - d1, sHash( id + 113.0 ), sHash( id + 271.0 ) );
}
// World-space cellular noise at frequency f (cells per metre); x, y in metres.
vec4 sVoronoiW( vec2 p, float f ) {
	vec4 v = sVoronoi( mod( p, 1024.0 / f ) * f );
	return vec4( v.xy / f, v.zw );
}
`;
