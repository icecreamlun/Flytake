/**
 * GLSL shared by every building shader (facade, props, depth): texture fetch helpers for the
 * per-building state / style / overlay textures, hashing & noise, box-filtered pulse trains,
 * and the contract-specified vertex deformation.
 */

/** Texels per row of every per-building data texture. */
export const TEX_W = 1024;

export const COMMON_PARS = /* glsl */ `
#define ARG_TEXW ${TEX_W}
uniform highp sampler2D uState;   // 3 texels / building (see contracts.ts)
uniform highp sampler2D uStyle;   // 8 texels / building (see styles.ts packStyle)
uniform highp sampler2D uOverlay; // 1 texel / building: rgb tint, a = enabled
uniform float uHighlight;         // highlighted building index (-1 none)
uniform float uDamageOverlay;     // 0/1
uniform float uNight;             // 0 day … 1 night
uniform float uDayLevel;          // interior daylight radiance scale
uniform float uHour;              // local solar time (hours), drives occupancy of lit rooms
uniform float uTime;

ivec2 argTexel( int t ) { return ivec2( t % ARG_TEXW, t / ARG_TEXW ); }
vec4 argState( int i, int k ) { return texelFetch( uState, argTexel( i * 3 + k ), 0 ); }
vec4 argStyle( int i, int k ) { return texelFetch( uStyle, argTexel( i * 8 + k ), 0 ); }
vec4 argOverlay( int i ) { return texelFetch( uOverlay, argTexel( i ), 0 ); }

float h11( float p ) { p = fract( p * 0.1031 ); p *= p + 33.33; p *= p + p; return fract( p ); }
float h21( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
vec2 h22( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.xx + p3.yz ) * p3.zy ); }
float h31( vec3 p3 ) { p3 = fract( p3 * 0.1031 ); p3 += dot( p3, p3.zyx + 31.32 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float vnoise( vec2 p ) {
	vec2 i = floor( p ); vec2 f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), u.x ), mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float fbm3( vec2 p ) { return ( vnoise( p ) * 0.5 + vnoise( p * 2.03 + 17.1 ) * 0.25 + vnoise( p * 4.07 + 31.7 ) * 0.125 ) / 0.875; }
bool argFlag( float flags, float bit ) { return mod( floor( flags / bit ), 2.0 ) > 0.5; }

// Integral of a unit-period pulse train that is 1 on [a, b].
float pInt( float x, float a, float b ) { return floor( x ) * ( b - a ) + clamp( fract( x ), a, b ) - a; }
// Box-filtered pulse train (filter width w in the same units): alias-free at any distance.
float fPulse( float x, float a, float b, float w ) {
	w = max( w, 1e-4 );
	return ( pInt( x + 0.5 * w, a, b ) - pInt( x - 0.5 * w, a, b ) ) / w;
}
// Anti-aliased step: 0 below e, 1 above (w = filter width).
float aStep( float e, float x, float w ) { return clamp( ( x - e ) / max( w, 1e-5 ) + 0.5, 0.0, 1.0 ); }
// Anti-aliased box [a, b].
float aBox( float x, float a, float b, float w ) { return aStep( a, x, w ) * ( 1.0 - aStep( b, x, w ) ); }

// Fake CJK-ish glyph in a unit cell: a dense 5x5 stroke lattice with random horizontal / vertical
// strokes and an occasional enclosing box (radical), so blocks read as characters, not letters.
float argGlyph( vec2 uv, float seed ) {
	vec2 g = uv * 5.0;
	vec2 c = floor( g );
	vec2 f = g - c;
	float m = 0.0;
	// Horizontal stroke through this lattice cell if row r carries a stroke spanning column c.
	float hr = h11( seed + c.y * 7.13 );
	float h0 = floor( h11( seed + c.y * 3.7 ) * 2.0 );
	float h1 = 3.0 + floor( h11( seed + c.y * 5.3 ) * 2.0 );
	m = max( m, step( 0.25, hr ) * step( h0, c.x ) * step( c.x, h1 ) * step( abs( f.y - 0.5 ), 0.2 ) );
	float vr = h11( seed + c.x * 11.7 + 3.0 );
	float v0 = floor( h11( seed + c.x * 5.1 ) * 2.0 );
	float v1 = 2.0 + floor( h11( seed + c.x * 9.9 ) * 3.0 );
	m = max( m, step( 0.4, vr ) * step( v0, c.y ) * step( c.y, v1 ) * step( abs( f.x - 0.5 ), 0.2 ) );
	// Enclosing box on some glyphs.
	if ( h11( seed * 1.37 + 0.5 ) > 0.6 ) {
		vec2 b = abs( uv - 0.5 );
		m = max( m, step( max( b.x, b.y ), 0.42 ) * step( 0.34, max( b.x, b.y ) ) );
	}
	return m * step( 0.06, uv.x ) * step( uv.x, 0.94 ) * step( 0.06, uv.y ) * step( uv.y, 0.94 );
}

// Pancaked soft storey of a standing building with complete damage: height of the crushed ground storey
// (m, from the undeformed base) and how much of it is in effect (0..1; off while a collapse is under way).
float argSoftH( float H ) { return clamp( H * 0.22, 2.8, 4.5 ); }
float argSoftK( float dmg, float crush ) { return smoothstep( 3.3, 3.9, dmg ) * ( 1.0 - smoothstep( 0.0, 0.04, crush ) ); }

// 5-step HAZUS damage ramp (none, slight, moderate, extensive, complete).
vec3 argDamageRamp( float d ) {
	// Linear RGB, saturated so the ramp survives lighting + tone mapping.
	vec3 c0 = vec3( 0.05, 0.30, 0.10 );
	vec3 c1 = vec3( 0.80, 0.65, 0.02 );
	vec3 c2 = vec3( 0.90, 0.25, 0.01 );
	vec3 c3 = vec3( 0.70, 0.02, 0.01 );
	vec3 c4 = vec3( 0.22, 0.0, 0.06 );
	d = clamp( d, 0.0, 4.0 );
	vec3 c = mix( c0, c1, clamp( d, 0.0, 1.0 ) );
	c = mix( c, c2, clamp( d - 1.0, 0.0, 1.0 ) );
	c = mix( c, c3, clamp( d - 2.0, 0.0, 1.0 ) );
	return mix( c, c4, clamp( d - 3.0, 0.0, 1.0 ) );
}
`;

/**
 * Vertex deformation per contracts.ts (crush → tilt → cantilever shake → hidden).
 * A, B, S = state texels 0, 1, 2. Rotation conventions: tiltX rotates about +X (y→z), tiltZ about +Z (x→y),
 * right-handed, applied in that order around the base centre (cx, base, cz).
 */
export const DEFORM_PARS = /* glsl */ `
vec3 argTilt( vec3 r, vec2 tilt ) {
	float ca = cos( tilt.x ), sa = sin( tilt.x );
	r = vec3( r.x, ca * r.y - sa * r.z, sa * r.y + ca * r.z );
	float cb = cos( tilt.y ), sb = sin( tilt.y );
	return vec3( cb * r.x - sb * r.y, sb * r.x + cb * r.y, r.z );
}
vec3 argDeform( vec3 p, vec4 A, vec4 B, vec4 S ) {
	if ( B.w > 0.5 ) return vec3( S.x, -5000.0, S.y ); // hidden: whole building collapses to one point
	float base = S.z;
	float H = max( S.w, 0.5 );
	float h = p.y - base;
	float crush = clamp( B.x, 0.0, 1.0 );
	vec3 q = p;
	q.y = base + h * ( 1.0 - crush );
	if ( crush > 0.001 && h > 0.0 ) {
		// Slump into a rubble heap: walls bulge outward and the crown gets ragged.
		vec2 rel = p.xz - S.xy;
		vec2 dir = rel / max( length( rel ), 0.01 );
		float n = h31( floor( p * 0.37 ) + 0.5 );
		float k = crush * clamp( h / H, 0.0, 1.0 );
		q.xz += dir * k * min( H * 0.09, 5.0 ) * ( 0.4 + n );
		q.y += crush * ( n - 0.35 ) * min( H * 0.06, 2.5 );
		q.y = max( q.y, base - 0.5 );
	}
	// Complete damage, still standing: the ground storey pancakes to ~1/3 of its height and everything above
	// drops onto it (the soft-storey failure), the crushed storey bulging out a little.
	float ssK = argSoftK( B.y, crush );
	if ( ssK > 0.001 && h > 0.0 ) {
		float gh = argSoftH( H );
		float drop = gh * 0.66 * ssK;
		if ( h < gh ) {
			q.y -= drop * h / gh;
			vec2 rel = p.xz - S.xy;
			q.xz += rel / max( length( rel ), 0.01 ) * 0.35 * ssK * sin( 3.14159 * h / gh );
		} else q.y -= drop;
	}
	vec3 c = vec3( S.x, base, S.y );
	q = c + argTilt( q - c, A.zw );
	q.xz += A.xy * ( h / H );
	return q;
}
`;
