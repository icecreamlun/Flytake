/**
 * GLSL for unclassified open land inside blocks: yards, vacant lots, the Telegraph Hill slopes and quarry cliffs.
 * A slope- and noise-driven stack (never neutral concrete):
 *   flat/moderate ground: late-October dry grass, bare dirt & gravel, green scrub / ivy clumps, a few old paved pads;
 *   slopes above ~30°:    triplanar Franciscan greywacke (ochre-grey beds, darker chert bands, dark joints/crevices),
 *                         with ivy/scrub clinging where the slope stays under ~50°.
 * `gWildFar` is the band-limited mean of `gWild`: near pixels fade into it with distance so the near → far switch
 * never shows a line. Requires NOISE_GLSL and the globals gRough (float), gBump (vec2), gBump3 (vec3).
 */
export const WILD_GLSL = /* glsl */ `
// Slope weights from the world normal y: x = rock (>~30°), y = scrub allowed on rock (<~50°).
vec2 gSlopeW( float ny, float n ) {
	float rock = smoothstep( 0.86, 0.74, ny + ( n - 0.5 ) * 0.2 );
	float cling = smoothstep( 0.5, 0.64, ny );
	return vec2( rock, cling );
}

// Large-scale landcover mix shared by the near and far paths (all frequencies <= 0.12 / m).
// x: green scrub coverage, y: bare dirt/gravel, z: old paved pad (flat ground only).
vec3 gWildMix( vec2 p, float ny, vec3 nL ) {
	float nC = sNoise( p + 71.0, 0.11 );
	float slope = 1.0 - ny;
	float veg = smoothstep( 0.42, 0.62, nC * 0.65 + nL.x * 0.35 + slope * 1.4 );
	float dirt = smoothstep( 0.5, 0.72, sNoise( p + 13.0, 0.07 ) ) * ( 1.0 - veg );
	float paved = step( 0.72, sHash( floor( p / 23.0 ) + 41.0 ) ) * smoothstep( 0.985, 0.995, ny ) * ( 1.0 - veg );
	return vec3( veg, dirt, paved );
}

vec3 gDryGrass( float t ) {
	return mix( vec3( 0.17, 0.13, 0.065 ), vec3( 0.29, 0.225, 0.115 ), t );
}
vec3 gScrubCol( float t ) {
	return mix( vec3( 0.028, 0.045, 0.018 ), vec3( 0.07, 0.088, 0.036 ), t );
}
const vec3 G_DIRT = vec3( 0.15, 0.112, 0.078 );
const vec3 G_PAD = vec3( 0.115, 0.108, 0.098 );
const vec3 G_ROCK = vec3( 0.2, 0.172, 0.13 );

// Mid-scale (2-8 m) breakup shared by the near and far paths, kept until a pixel covers ~1-2 m:
// x = scrub clump shading, y = ground mottling, z = 1 while active. Adds a macro bump that breaks up the DEM's
// smooth 'sculpted' folds.
vec3 gWildMid( vec2 p, float px ) {
	float f = 1.0 - smoothstep( 0.9, 2.2, px );
	if ( f <= 0.0 ) return vec3( 1.0, 1.0, 0.0 );
	vec3 c = sNoiseW( p + 3.0, 0.22 );
	vec3 d = sNoiseW( p + 29.0, 0.45 );
	gBump += ( c.yz * 0.5 + d.yz * 0.22 ) * f;
	return vec3( mix( 1.0, mix( 0.5, 1.3, smoothstep( 0.2, 0.8, c.x ) ), f ), mix( 1.0, 0.82 + 0.36 * d.x, f ), f );
}

// Large-scale rock structure for steep ground, readable from the air: ~7 m Voronoi blocks (angular cracks,
// per-block tone and facet tilt). Facet bump goes to gBump3.
float gRockMacro( vec3 wp, vec3 n, float px ) {
	float f = 1.0 - smoothstep( 0.7, 2.0, px );
	if ( f <= 0.0 ) return 1.0;
	vec2 t = normalize( vec2( - n.z, n.x ) + 1e-4 );
	vec2 uv = vec2( dot( wp.xz, t ), wp.y );
	vec2 q = uv + vec2( sNoise( uv, 0.05 ), sNoise( uv + 9.0, 0.05 ) ) * 5.0;
	vec4 v = sVoronoiW( q * vec2( 1.0, 1.5 ), 0.14 );
	float crack = 1.0 - smoothstep( 0.1, 0.35 + px * 0.5, v.y );
	vec2 tilt = vec2( v.z, v.w ) - 0.5;
	gBump3 += ( vec3( t.x, 0.0, t.y ) * tilt.x + vec3( 0.0, tilt.y, 0.0 ) ) * 0.6 * f;
	return mix( 1.0, ( 1.0 - 0.35 * crack ) * ( 0.84 + 0.32 * v.z ), f );
}

// Far / band-limited mean of the wild land (with mid-scale breakup while it is still resolvable).
vec3 gWildFar( vec3 wp, vec3 n, vec3 nL, float px ) {
	vec2 p = wp.xz;
	vec3 m = gWildMix( p, n.y, nL );
	vec2 sw = gSlopeW( n.y, nL.x );
	vec3 mid = gWildMid( p, px );
	vec3 col = gDryGrass( 0.35 + 0.4 * nL.x ) * mid.y;
	col = mix( col, G_DIRT * mid.y, m.y );
	col = mix( col, G_PAD, m.z );
	col = mix( col, gScrubCol( 0.45 ) * 0.85 * mid.x, m.x );
	if ( sw.x > 0.001 ) {
		float onRock = sw.x * ( 1.0 - sw.y * smoothstep( 0.35, 0.5, sNoise( p + 5.0, 0.09 ) ) * 0.85 );
		vec3 b0 = gBump3;
		vec3 rock = G_ROCK * ( 0.78 + 0.3 * nL.x ) * gRockMacro( wp, n, px );
		gBump3 = b0 + ( gBump3 - b0 ) * onRock;
		col = mix( col, mix( rock, gScrubCol( 0.4 ), 0.12 ), onRock );
	}
	gRough = 0.93;
	return col;
}

// One rock projection plane (u along the face, v = elevation): fractured greywacke as warped Voronoi blocks
// (~2 m, slabby) with finer fractures, per-block tone and facet tilt, iron staining, lichen and grain.
// Returns albedo, writes the height gradient d/du, d/dv.
vec3 gRockPlane( vec2 uv, float px, out vec2 g ) {
	vec2 q = uv + vec2( sNoise( uv, 0.2 ), sNoise( uv + 37.0, 0.2 ) ) * 1.4;
	vec4 v = sVoronoiW( q * vec2( 1.0, 1.7 ), 0.5 );
	float fJ = 1.0 - smoothstep( 0.12, 0.35, px );
	vec4 v2 = fJ > 0.0 ? sVoronoiW( q * vec2( 1.3, 1.0 ) + 7.0, 1.6 ) : vec4( 1.0 );
	vec3 col = mix( vec3( 0.15, 0.13, 0.1 ), vec3( 0.28, 0.245, 0.19 ), v.z );
	col = mix( col, vec3( 0.21, 0.125, 0.08 ), step( 0.8, v.w ) * 0.55 );
	col *= 0.85 + 0.3 * sNoise( q, 0.9 );
	float ca = 1.0 - smoothstep( 0.02, 0.06 + px * 0.6, v.y );
	float cb = ( 1.0 - smoothstep( 0.008, 0.025 + px * 0.4, v2.y ) ) * fJ;
	float fG = 1.0 - smoothstep( 0.02, 0.06, px );
	vec3 gr = sNoiseW( uv, 4.0 );
	col *= 1.0 + ( gr.x - 0.5 ) * 0.3 * fG;
	float lichen = smoothstep( 0.7, 0.82, sNoise( uv + 7.0, 1.3 ) ) * fJ;
	col = mix( col, vec3( 0.3, 0.29, 0.24 ), lichen * 0.5 );
	col = mix( col, vec3( 0.028, 0.025, 0.02 ), max( ca * 0.85, cb * 0.6 ) );
	// Each block is a tilted facet; edges round off into the cracks.
	g = ( vec2( v.z, v.w ) - 0.5 ) * 0.9 * ( 1.0 - ca ) + ( vec2( v2.z, v2.w ) - 0.5 ) * 0.25 * fJ + gr.yz * 0.01 * fG;
	return col;
}

// Triplanar rock: x-facing (z, y), z-facing (x, y) and top (x, z) planes blended by the normal.
vec3 gRock( vec3 wp, vec3 n, float px ) {
	vec3 aw = pow( abs( n ), vec3( 4.0 ) );
	aw /= aw.x + aw.y + aw.z;
	vec3 col = vec3( 0.0 );
	vec3 grad = vec3( 0.0 );
	vec2 g;
	if ( aw.x > 0.03 ) {
		col += gRockPlane( vec2( wp.z, wp.y ), px, g ) * aw.x;
		grad += vec3( 0.0, g.y, g.x ) * aw.x;
	}
	if ( aw.z > 0.03 ) {
		col += gRockPlane( vec2( wp.x, wp.y ), px, g ) * aw.z;
		grad += vec3( g.x, g.y, 0.0 ) * aw.z;
	}
	if ( aw.y > 0.03 ) {
		col += gRockPlane( wp.xz + 300.0, px, g ) * aw.y;
		grad += vec3( g.x, 0.0, g.y ) * aw.y;
	}
	gBump3 += grad;
	return col;
}

// Detailed wild land; fades to gWildFar as the pixel footprint grows (fd: 0 near → 1 far).
vec3 gWild( vec3 wp, vec3 n, float px, vec3 nL, vec3 nM, float fd ) {
	vec2 p = wp.xz;
	vec3 m = gWildMix( p, n.y, nL );
	vec2 sw = gSlopeW( n.y, nL.x );
	vec3 mid = gWildMid( p, px );
	float fG = 1.0 - smoothstep( 0.03, 0.09, px );
	// Dry grass with tufts and streaks.
	vec3 gs = sNoiseW( p * vec2( 1.0, 2.5 ), 2.2 );
	vec3 grass = gDryGrass( clamp( 0.35 + 0.4 * nL.x + ( nM.x - 0.5 ) * 0.5 + ( gs.x - 0.5 ) * 0.3 * fG, 0.0, 1.0 ) ) * mid.y;
	gBump += gs.yz * vec2( 1.0, 2.5 ) * 0.004 * fG;
	// Dirt with gravel speckle.
	float grav = sHash( floor( p * 9.0 ) ) * fG;
	vec3 dirt = G_DIRT * ( 0.82 + 0.3 * nM.x ) * ( 1.0 + ( grav - 0.5 ) * 0.5 ) * mid.y;
	// Old paved pad: dark weathered asphalt/concrete with cracks and weeds in them.
	vec3 pad = G_PAD * ( 0.85 + 0.25 * nM.x );
	float crk = ( 1.0 - smoothstep( 0.0, 0.02 + px * 0.3, abs( sNoise( p + vec2( sNoise( p, 0.3 ) * 1.5 ), 0.7 ) - 0.5 ) ) ) * fG;
	pad = mix( pad, gScrubCol( 0.3 ), crk * 0.7 );
	// Scrub / ivy: lumpy clumps with dark gaps (self-shadowing) and leafy speckle.
	vec3 cl = sNoiseW( p + 3.0, 0.6 );
	vec3 lf = sNoiseW( p + 11.0, 3.1 );
	float lump = smoothstep( 0.25, 0.75, cl.x * 0.75 + lf.x * 0.25 * fG );
	vec3 scrub = gScrubCol( 0.25 + 0.75 * lf.x * fG + 0.2 * nM.x ) * mix( 0.45, 1.15, lump ) * mid.x;
	vec3 col = mix( grass, dirt, m.y );
	col = mix( col, pad, m.z );
	col = mix( col, scrub, m.x );
	float r = mix( 0.95, 0.9, m.z );
	gBump += ( cl.yz * 0.12 + lf.yz * 0.012 * fG ) * m.x;
	// Rock outcrops on steep ground; scrub clings where it is not too steep.
	if ( sw.x > 0.001 ) {
		float clingN = smoothstep( 0.35, 0.5, sNoise( p + 5.0, 0.09 ) * 0.7 + cl.x * 0.3 );
		float onRock = sw.x * ( 1.0 - sw.y * clingN * 0.85 );
		vec3 b0 = gBump3;
		vec3 rock = gRock( wp, n, px ) * gRockMacro( wp, n, px );
		gBump3 = b0 + ( gBump3 - b0 ) * onRock;
		col = mix( col, rock, onRock );
		r = mix( r, 0.88, onRock );
	}
	gRough = r;
	if ( fd > 0.0 ) {
		vec2 b2 = gBump;
		vec3 b3 = gBump3;
		vec3 farC = gWildFar( wp, n, nL, px );
		gBump = b2;
		gBump3 = b3;
		gRough = mix( r, 0.93, fd );
		col = mix( col, farC, fd );
	}
	return col;
}
`;
