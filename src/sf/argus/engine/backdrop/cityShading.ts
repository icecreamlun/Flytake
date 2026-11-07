/**
 * Shared GLSL for distant-city ground shading, seen from the air: SF-sized blocks subdivided into
 * lots with individual roof tones (pastel stucco, tar, terracotta), dark back-yard cores with
 * trees, asphalt streets with lighter sidewalks — all filtered with fwidth so it never aliases,
 * converging to the average colour when blocks shrink below a few pixels. Night lights (street
 * lamps along the grid + lit windows) come out as emissive, gated by a separate `lights` mask so
 * wild hills, parks and summits stay dark (see GeoSample.lights).
 */
export const CITY_GLSL = /* glsl */ `
float cHash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float cNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( cHash( i ), cHash( i + vec2( 1, 0 ) ), u.x ), mix( cHash( i + vec2( 0, 1 ) ), cHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}
// Filtered band mask: 1 inside |fract(c)-0.5| > 0.5-w (i.e. near cell borders).
vec2 cBorder( vec2 c, float w ) {
	vec2 fw = max( fwidth( c ), vec2( 1e-4 ) );
	vec2 f = abs( fract( c ) - 0.5 );
	return smoothstep( 0.5 - w - fw, 0.5 - w + fw, f );
}
struct CityLook { vec3 albedo; vec3 emissive; float rough; };

// p: world xz; urban 0..1 (ground texture); lights 0..1 (inhabited); night: emissive scale; veg: natural ground colour.
CityLook cityLook( vec2 p, float urban, float lights, float night, vec3 veg ) {
	CityLook o;
	// Axis-aligned grid north of Market, 45° grid south of it (as in San Francisco).
	float south = step( 0.0, p.y - p.x * 0.75 - 200.0 );
	vec2 pr = mat2( 0.7071, - 0.7071, 0.7071, 0.7071 ) * p;
	vec2 bsz = mix( vec2( 125.0, 84.0 ), vec2( 160.0, 110.0 ), south );
	vec2 q = mix( p, pr, south );
	vec2 c = q / bsz;
	vec2 bid = floor( c );
	vec2 fwc = fwidth( c );
	float lod = smoothstep( 0.08, 0.3, max( fwc.x, fwc.y ) );   // block < ~4 px → average

	// Streets (kerb-to-kerb) and sidewalks.
	vec2 road = cBorder( c, 0.06 );
	vec2 walk = cBorder( c, 0.085 );
	float street = max( road.x, road.y );
	float sidewalk = max( walk.x, walk.y ) * ( 1.0 - street );

	// Lots: rows of ~8–14 m frontages along the long block edges; deep back-yard core.
	vec2 f = fract( c ) - 0.5;
	float edgeDist = min( 0.5 - abs( f.x ), ( 0.5 - abs( f.y ) ) * bsz.y / bsz.x );
	float core = smoothstep( 0.2, 0.26, edgeDist );                 // back yards
	float along = abs( f.y ) > abs( f.x ) * bsz.x / bsz.y ? q.x : q.y;
	float lotW = mix( 8.0, 15.0, cHash( bid + 1.7 ) );
	float lotId = floor( along / lotW );
	float lotF = fract( along / lotW );
	float lotFw = fwidth( along / lotW );
	float party = 1.0 - smoothstep( 0.0, 0.08 + lotFw, min( lotF, 1.0 - lotF ) ); // party walls
	float h = cHash( vec2( lotId, bid.x * 7.0 + bid.y * 13.0 ) );
	float h2 = cHash( vec2( lotId * 3.1, bid.y + bid.x * 5.0 ) );
	vec3 roof = mix( vec3( 0.34, 0.33, 0.31 ), vec3( 0.58, 0.56, 0.52 ), h );        // stucco / gravel
	roof = mix( roof, vec3( 0.13, 0.13, 0.14 ), step( 0.72, h2 ) * 0.85 );            // tar roofs
	roof = mix( roof, vec3( 0.42, 0.23, 0.16 ), step( 0.93, h2 ) );                   // terracotta
	roof *= 1.0 - party * 0.45;
	vec3 yard = mix( vec3( 0.07, 0.09, 0.05 ), vec3( 0.2, 0.19, 0.16 ), cNoise( p / 7.0 ) );
	vec3 lotCol = mix( roof, yard, core );
	vec3 asphalt = vec3( 0.06, 0.062, 0.066 );
	vec3 walkCol = vec3( 0.36, 0.35, 0.33 );
	vec3 detailed = mix( mix( lotCol, walkCol, sidewalk ), asphalt, street );
	// Average for distant pixels (same mean, no shimmer).
	vec3 avg = vec3( 0.21, 0.205, 0.195 );
	vec3 cityCol = mix( detailed, avg, lod );
	// Parks scattered through the grid.
	float park = step( 0.94, cHash( bid + 3.1 ) );
	cityCol = mix( cityCol, veg * 0.75 + vec3( 0.0, 0.02, 0.0 ), park * ( 1.0 - street ) );
	o.albedo = mix( veg, cityCol, urban );
	o.rough = mix( 0.95, 0.88, urban );

	// Night: sodium / LED lamps along streets + scattered lit windows (filtered at range). Seen from
	// afar the grid averages out, so neighbourhood-scale variation (busy strips vs. dark residential
	// blocks) keeps it from reading as a flat beige glow.
	vec3 lamp = mix( vec3( 1.0, 0.55, 0.22 ), vec3( 0.95, 0.85, 0.7 ), step( 0.6, cHash( bid + 9.0 ) ) );
	float hood = 0.35 + 1.3 * cNoise( p / 650.0 + 7.0 ) * cNoise( p / 230.0 - 3.0 );
	// Pools of light under lamps every ~32 m along the street (faded to their mean when sub-pixel).
	float alongSt = ( road.x > road.y ? q.y : q.x ) / 32.0;
	float poolLod = smoothstep( 0.15, 0.45, fwidth( alongSt ) );
	float pools = mix( 0.15 + 0.85 * pow( 0.5 + 0.5 * cos( alongSt * 6.2832 ), 3.0 ), 0.45, poolLod );
	float lampMask = mix( street * pools * ( 0.7 + 0.6 * cHash( bid + 2.0 ) ), 0.07, lod );
	float win = cNoise( p / 6.0 + bid * 3.0 );
	float windows = mix( smoothstep( 0.68, 0.84, win ) * ( 1.0 - street ) * ( 1.0 - core ), 0.05, lod ) * ( 1.0 - park );
	o.emissive = ( lamp * lampMask * 0.8 + vec3( 1.0, 0.72, 0.45 ) * windows * 0.4 ) * lights * hood * night;
	return o;
}
// Back-compat overload (streets' ground shader): lights follow the urban mask.
CityLook cityLook( vec2 p, float urban, float night, vec3 veg ) {
	return cityLook( p, urban, urban, night, veg );
}
`;

/**
 * Natural-terrain micro relief for the far mesh: value noise with analytic gradients at 230 / 75 /
 * 26 m, each octave faded once it shrinks below a few pixels (fp = pixel footprint in metres).
 * Returns x = ravine-ness 0..1 (valleys / gullies), yz = d(height)/dx, d(height)/dz.
 */
export const TERRAIN_DETAIL_GLSL = /* glsl */ `
vec3 cNoiseD( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	vec2 du = 6.0 * f * ( 1.0 - f );
	float a = cHash( i ), b = cHash( i + vec2( 1, 0 ) ), c = cHash( i + vec2( 0, 1 ) ), d = cHash( i + vec2( 1, 1 ) );
	float k = a - b - c + d;
	return vec3( a + ( b - a ) * u.x + ( c - a ) * u.y + k * u.x * u.y, du * vec2( b - a + k * u.y, c - a + k * u.x ) );
}
vec3 terrainDetail( vec2 p, float fp ) {
	vec3 a = cNoiseD( p / 230.0 + 3.7 );
	vec3 b = cNoiseD( p / 75.0 - 1.9 );
	vec3 c = cNoiseD( p / 26.0 + 5.3 );
	float ka = 1.0 - smoothstep( 230.0 / 8.0, 230.0 / 3.0, fp );
	float kb = 1.0 - smoothstep( 75.0 / 8.0, 75.0 / 3.0, fp );
	float kc = 1.0 - smoothstep( 26.0 / 8.0, 26.0 / 3.0, fp );
	vec2 g = a.yz * ( 24.0 / 230.0 ) * ka + b.yz * ( 8.0 / 75.0 ) * kb + c.yz * ( 2.5 / 26.0 ) * kc;
	float ravine = smoothstep( 0.55, 0.2, a.x * 0.7 + mix( 0.5, b.x, kb ) * 0.3 );
	return vec3( ravine, g );
}
`;
