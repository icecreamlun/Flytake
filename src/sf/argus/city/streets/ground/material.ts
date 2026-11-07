/**
 * The one ground material for every ground mesh (road-level cells, raised block tops, curb faces, seawalls,
 * outer terrain). A MeshStandardMaterial (so it gets the engine's shadows, IBL and aerial-perspective fog
 * untouched) whose albedo / roughness / normal / emissive are replaced by procedural, world-anchored detail:
 *  - asphalt: patch/resurfacing tones, aggregate grain, crack network, repair patches;
 *  - sidewalks: scored concrete panels aligned to the street, per-panel tone, stains, joints as grooves;
 *  - pavers (brick running bond or granite slabs), grass, decomposed granite, stairs;
 *  - curb faces (with painted red/yellow/white zones), seawalls with an algae band, murky bay floor;
 *  - beyond the data: the engine's procedural distant-city look so the far-ring seam vanishes;
 *  - night: baked street-lamp light pools (albedo × irradiance) as emissive.
 */
import * as THREE from 'three';
import { CITY_GLSL } from '../../../engine/backdrop/cityShading';
import { CTX, DZ } from '../core/zone';
import { NOISE_GLSL } from './glsl';
import type { Landcover } from './landcover';
import { WILD_GLSL } from './wild';

const PARS = /* glsl */ `
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform sampler2D uLightMap;
uniform sampler2D uBlockMask;
uniform vec4 uDZ;
uniform vec4 uCTX;
uniform float uNight;
uniform float uLamps;
varying vec3 vGWorld;
varying vec3 vGNrm;
varying float vGKind;
float gRough;
vec2 gBump;
vec3 gBump3;
vec3 gEmit;
${NOISE_GLSL}
${CITY_GLSL}
${WILD_GLSL}

// Crisp-but-irregular edge from a soft 1 m coverage value.
float gEdge( float m, float n, float px, float amp ) {
	float e = clamp( px * 0.6, 0.04, 0.5 );
	return smoothstep( 0.5 - e, 0.5 + e, m + ( n - 0.5 ) * amp );
}
// Groove profile: 1 on a joint line of width w (m), AA'd with pixel size px.
float gJoint( float d, float w, float px ) {
	return 1.0 - smoothstep( w * 0.5, w * 0.5 + px, d );
}

vec3 gAsphalt( vec2 p, float px, vec3 nL, vec3 nM ) {
	vec3 base = vec3( 0.066, 0.064, 0.061 );
	// Resurfacing / age blotches (tens of metres) and mid-scale mottling.
	float age = smoothstep( 0.25, 0.8, nL.x );
	base *= mix( 0.8, 1.38, age );
	base *= 0.92 + 0.16 * nM.x;
	// Aggregate grain.
	float fG = 1.0 - smoothstep( 0.2, 0.55, px * 7.0 );
	vec3 g = sNoiseW( p, 7.0 );
	base *= 1.0 + ( g.x - 0.5 ) * 0.2 * fG;
	gBump += g.yz * 0.003 * fG;
	float rough = 0.86 + 0.08 * g.x;
	// Hairline cracks (old pavement only): thin ridged lines of a warped noise, faded with distance.
	float fC = 1.0 - smoothstep( 0.02, 0.06, px );
	if ( fC > 0.0 ) {
		vec2 w = p + vec2( sNoise( p, 0.37 ), sNoise( p + 41.0, 0.37 ) ) * 1.6;
		float r = abs( sNoise( w, 0.9 ) - 0.5 );
		float crack = ( 1.0 - smoothstep( 0.004, 0.012 + px * 0.2, r ) ) * smoothstep( 0.55, 0.85, nL.x + 0.3 * ( nM.x - 0.5 ) );
		base *= 1.0 - 0.45 * crack * fC;
	}
	// Tar-sealed cracks: sparse, mostly transverse / longitudinal glossy black lines (they follow old joints).
	float fT = 1.0 - smoothstep( 0.05, 0.14, px );
	if ( fT > 0.0 ) {
		vec2 wq = p + vec2( sNoise( p + 9.0, 0.5 ), sNoise( p + 77.0, 0.5 ) ) * 0.7;
		float lx = abs( sNoise( wq * vec2( 0.12, 1.0 ), 0.9 ) - 0.5 );
		float lz = abs( sNoise( wq * vec2( 1.0, 0.12 ) + 50.0, 0.9 ) - 0.5 );
		float w = 0.012 + px * 0.15;
		float tar = max( 1.0 - smoothstep( w * 0.5, w, lx ), 1.0 - smoothstep( w * 0.5, w, lz ) );
		tar *= step( 0.72, sNoise( p + 300.0, 0.07 ) );
		base = mix( base, vec3( 0.03, 0.029, 0.028 ), tar * fT * 0.8 );
		rough = mix( rough, 0.68, tar * fT );
	}
	// Utility-cut repair patches: slightly darker, newer rectangles of varied size.
	vec2 cellSz = vec2( 9.0, 5.0 );
	vec2 cell = floor( p / cellSz );
	float ph = sHash( cell + 311.0 );
	vec2 fr = fract( p / cellSz );
	vec2 lo = vec2( 0.1, 0.15 ) + 0.25 * vec2( sHash( cell + 1.7 ), sHash( cell + 3.1 ) );
	vec2 hi = lo + vec2( 0.25, 0.3 ) + 0.3 * vec2( sHash( cell + 5.3 ), sHash( cell + 8.9 ) );
	float inPatch = step( 0.955, ph ) * step( lo.x, fr.x ) * step( fr.x, hi.x ) * step( lo.y, fr.y ) * step( fr.y, hi.y );
	base = mix( base, base * vec3( 0.8, 0.8, 0.82 ), inPatch );
	gRough = rough - 0.04 * inPatch;
	return base;
}

vec3 gConcrete( vec2 q, vec2 p, float px, vec3 nL, vec3 nM ) {
	// Scored panels ~1.5 m along the street, 1.5 m across.
	vec2 cellSz = vec2( 1.52, 1.5 );
	vec2 c = floor( q / cellSz );
	vec2 f = fract( q / cellSz );
	vec2 dd = min( f, 1.0 - f ) * cellSz;
	float joint = max( gJoint( dd.x, 0.012, px ), gJoint( dd.y, 0.012, px ) ) * ( 1.0 - smoothstep( 0.05, 0.12, px ) );
	float tone = 0.9 + 0.16 * sHash( c );
	vec3 base = vec3( 0.36, 0.352, 0.335 ) * tone;
	base *= 0.86 + 0.18 * nM.x;
	base *= mix( 0.8, 1.0, smoothstep( 0.2, 0.7, nL.x ) );
	// Gum / drip spots.
	float spot = step( 0.985, sHash( floor( p * 3.0 ) ) ) * ( 1.0 - smoothstep( 0.03, 0.1, px ) );
	base *= 1.0 - 0.35 * spot;
	base *= 1.0 - 0.45 * joint;
	gRough = 0.8 - 0.05 * joint;
	return base;
}

// Street-aligned frame at p (nearest direction texel: no swirl where directions change).
vec2 gStreetFrame( vec2 p, vec2 uv ) {
	ivec2 bs = textureSize( uTexB, 0 );
	vec2 dirE = texelFetch( uTexB, clamp( ivec2( uv * vec2( bs ) ), ivec2( 0 ), bs - 1 ), 0 ).ba * 2.0 - 1.0;
	float th = length( dirE ) > 0.35 ? 0.5 * atan( dirE.y, dirE.x ) : 0.0;
	vec2 t = vec2( cos( th ), sin( th ) );
	return vec2( dot( p, t ), dot( p, vec2( - t.y, t.x ) ) );
}
// Designed granite plazas: dark stone bands every 7.2 m both ways (still readable from the air).
float gPaverBand( vec2 q, float px ) {
	vec2 b = abs( fract( q / 7.2 + 0.5 ) - 0.5 ) * 7.2;
	float d = min( b.x, b.y );
	return ( 1.0 - smoothstep( 0.3, 0.3 + max( px, 0.01 ), d ) ) * ( 1.0 - smoothstep( 0.5, 1.2, px ) );
}
const vec3 G_BAND = vec3( 0.12, 0.112, 0.105 );

vec3 gPavers( vec2 q, vec2 p, float px, vec3 nL ) {
	float granite = step( 0.5, sHash( floor( p / 90.0 ) + 7.0 ) );
	vec2 sz = mix( vec2( 0.2, 0.1 ), vec2( 0.6, 0.3 ), granite );
	float row = floor( q.y / sz.y );
	vec2 qq = vec2( q.x + mod( row, 2.0 ) * sz.x * 0.5, q.y );
	vec2 c = floor( qq / sz );
	vec2 f = fract( qq / sz );
	vec2 dd = min( f, 1.0 - f ) * sz;
	float mortar = max( gJoint( dd.x, 0.008, px ), gJoint( dd.y, 0.008, px ) ) * ( 1.0 - smoothstep( 0.02, 0.06, px ) );
	float h = sHash( c + row * 13.0 );
	vec3 brick = vec3( 0.235, 0.125, 0.09 ) * ( 0.72 + 0.45 * h );
	vec3 slab = vec3( 0.27, 0.265, 0.255 ) * ( 0.8 + 0.3 * h );
	vec3 col = mix( brick, slab, granite );
	// Far away the pattern averages out to the mean colour.
	float far = smoothstep( 0.03, 0.12, px );
	col = mix( col, mix( vec3( 0.21, 0.115, 0.085 ), vec3( 0.27, 0.262, 0.25 ), granite ), far );
	col = mix( col, vec3( 0.2, 0.19, 0.18 ), mortar );
	col *= 0.85 + 0.25 * nL.x;
	col = mix( col, G_BAND * ( 0.9 + 0.2 * h * ( 1.0 - far ) ), gPaverBand( q, px ) * granite );
	gRough = 0.78 + 0.1 * mortar;
	return col;
}

vec3 gGrass( vec2 p, float px, vec3 nL, vec3 nM ) {
	vec3 lush = vec3( 0.045, 0.085, 0.024 );
	vec3 dry = vec3( 0.13, 0.12, 0.06 );
	vec3 col = mix( lush, dry, smoothstep( 0.55, 0.9, nL.x ) * 0.6 );
	col *= 0.75 + 0.5 * nM.x;
	float fG = 1.0 - smoothstep( 0.1, 0.3, px * 4.0 );
	vec3 g = sNoiseW( p, 9.0 );
	col *= 1.0 + ( g.x - 0.5 ) * 0.35 * fG;
	gBump += g.yz * 0.004 * fG;
	gRough = 0.95;
	return col;
}

// Band-limited means of the near-path materials (what each converges to once its detail has faded).
vec3 gGrassFar( vec3 nL ) {
	return mix( vec3( 0.045, 0.085, 0.024 ), vec3( 0.13, 0.12, 0.06 ), smoothstep( 0.55, 0.9, nL.x ) * 0.6 );
}
vec3 gAsphaltFar( vec3 nL ) {
	return vec3( 0.066, 0.064, 0.061 ) * mix( 0.8, 1.38, smoothstep( 0.25, 0.8, nL.x ) );
}
vec3 gPaversFar( vec2 p, vec3 nL, float px ) {
	float granite = step( 0.5, sHash( floor( p / 90.0 ) + 7.0 ) );
	vec3 col = mix( vec3( 0.21, 0.115, 0.085 ), vec3( 0.27, 0.262, 0.25 ), granite ) * ( 0.85 + 0.25 * nL.x );
	if ( granite > 0.5 && px < 1.2 ) col = mix( col, G_BAND, gPaverBand( gStreetFrame( p, ( p - uDZ.xy ) / uDZ.zw ), px ) );
	return col;
}
// Distant block tops: landcover composited in the same priority order as the near path, flat colours.
vec3 gBlockFar( vec4 A, vec4 B, vec3 wp, vec3 n, vec3 nL, float px ) {
	vec2 p = wp.xz;
	vec3 col = gWildFar( wp, n, nL, px );
	col = mix( col, gGrassFar( nL ), A.g );
	col = mix( col, vec3( 0.36, 0.352, 0.335 ) * 0.93 * mix( 0.8, 1.0, smoothstep( 0.2, 0.7, nL.x ) ), A.r );
	col = mix( col, gAsphaltFar( nL ) * 1.25, A.a );
	col = mix( col, vec3( 0.33, 0.32, 0.30 ) * 0.78, B.g );
	col = mix( col, vec3( 0.29, 0.235, 0.16 ) * 0.975, B.r );
	if ( A.b > 0.004 ) col = mix( col, gPaversFar( p, nL, px ), A.b );
	gRough = 0.9;
	return col;
}

void gShade( out vec3 alb ) {
	vec2 p = vGWorld.xz;
	float y = vGWorld.y;
	float kind = vGKind;
	float px = max( length( dFdx( p ) ), length( dFdy( p ) ) );
	gRough = 0.9;
	gBump = vec2( 0.0 );
	gBump3 = vec3( 0.0 );
	gEmit = vec3( 0.0 );
	vec3 nW = normalize( vGNrm );
	vec3 nL = sNoiseW( p, 0.045 );
	// Far pixels (footprint > 12 cm) take a cheap path: no fine noise at all.
	bool farPx = px > 0.12;
	vec3 nM = farPx ? vec3( 0.5, 0.0, 0.0 ) : sFbm( p, 0.55, px );

	vec2 uv = ( p - uDZ.xy ) / uDZ.zw;
	float inDZ = step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 );
	// Far-LOD tiles carry kind −1: road vs raised block comes from the 1 m block mask.
	if ( kind < -0.5 ) kind = texture2D( uBlockMask, uv ).r > 0.5 ? 1.0 : 0.0;
	vec2 cd = min( p - uCTX.xy, uCTX.zw - p );
	float dataW = inDZ * smoothstep( 0.0, 40.0, min( cd.x, cd.y ) );

	vec3 col;
	if ( kind > 2.5 && kind < 3.5 ) {
		// Seawall face: weathered concrete, algae / wet band around the tide range.
		col = vec3( 0.17, 0.165, 0.158 ) * ( 0.8 + 0.35 * nM.x );
		float tide = 1.0 - smoothstep( 0.3, 1.2, y );
		col = mix( col, vec3( 0.03, 0.045, 0.03 ) * ( 0.7 + 0.6 * nM.x ), tide );
		float salt = smoothstep( 1.0, 1.4, y ) * ( 1.0 - smoothstep( 1.4, 2.2, y ) );
		col *= 1.0 + 0.25 * salt * nM.x;
		gRough = 0.88;
		alb = col;
		return;
	}
	if ( kind > 4.5 && kind < 6.5 ) {
		float u = ( p.x + p.y ) * 0.7071;
		if ( kind < 5.5 ) {
			// Pier deck lip: weathered concrete with a dark timber fender rail.
			col = vec3( 0.25, 0.24, 0.225 ) * ( 0.78 + 0.35 * nM.x );
			float rail = step( fract( y * 1.2 ), 0.22 );
			col = mix( col, vec3( 0.08, 0.065, 0.05 ), rail * 0.6 );
			gRough = 0.85;
		} else {
			// Under the deck: deep shade with creosoted piles every ~3 m and a green tide band.
			float pile = 1.0 - smoothstep( 0.08, 0.13, abs( fract( u / 3.0 ) - 0.5 ) );
			col = mix( vec3( 0.004, 0.0045, 0.005 ), vec3( 0.035, 0.03, 0.025 ) * ( 0.7 + 0.5 * nM.x ), pile );
			col = mix( col, vec3( 0.02, 0.03, 0.018 ), ( 1.0 - smoothstep( 0.0, 0.9, y ) ) * pile );
			gRough = 0.95;
		}
		alb = col;
		return;
	}
	if ( kind > 6.5 && kind < 7.5 ) {
		// Retaining wall / parapet: board-formed concrete, per-board tone, rust/drip streaks, grime at the foot.
		vec2 tw = normalize( vec2( - nW.z, nW.x ) + 1e-4 );
		float u = dot( p, tw );
		float bc = y / 0.3;
		float bi = floor( bc );
		float bd = min( fract( bc ), 1.0 - fract( bc ) ) * 0.3;
		float form = gJoint( bd, 0.012, px ) * ( 1.0 - smoothstep( 0.04, 0.1, px ) );
		col = vec3( 0.29, 0.28, 0.262 ) * ( 0.84 + 0.22 * nM.x ) * ( 0.93 + 0.1 * sHash( vec2( bi, floor( u / 2.4 ) ) ) );
		float streak = smoothstep( 0.55, 0.85, sNoise( vec2( u * 1.7, y * 0.12 ), 1.0 ) );
		col *= 1.0 - 0.3 * streak;
		col = mix( col, vec3( 0.09, 0.085, 0.07 ), 0.35 * smoothstep( 0.7, 0.95, sNoise( p + y, 0.35 ) ) );
		col *= 1.0 - 0.4 * form;
		gBump3 += vec3( 0.0, ( fract( bc ) - 0.5 ) * 0.4, 0.0 ) * form;
		gRough = 0.86;
		alb = col;
		return;
	}
	if ( kind > 1.5 && kind < 2.5 ) {
		// Curb face: concrete, grimy at the gutter, some painted zones.
		col = vec3( 0.43, 0.42, 0.40 ) * ( 0.85 + 0.25 * nM.x );
		float zone = sHash( vec2( floor( ( p.x * 0.7 + p.y * 0.7 ) / 9.0 ), 91.0 ) );
		vec3 paint = zone > 0.86 ? vec3( 0.42, 0.04, 0.03 ) : zone > 0.8 ? vec3( 0.62, 0.42, 0.04 ) : zone > 0.77 ? vec3( 0.65, 0.65, 0.62 ) : vec3( -1.0 );
		if ( paint.x >= 0.0 ) col = mix( col, paint * ( 0.85 + 0.2 * nM.x ), 0.85 );
		gRough = 0.75;
		alb = col;
		return;
	}

	col = vec3( 0.1 );
	if ( dataW > 0.0 ) {
		if ( kind < 0.5 ) {
			// Road level: carriageway asphalt (bay floor / shore handled below).
			if ( farPx ) {
				col = gAsphaltFar( nL );
				gRough = 0.88;
			} else {
				float fd = smoothstep( 0.07, 0.12, px );
				col = mix( gAsphalt( p, px, nL, nM ), gAsphaltFar( nL ), fd );
				gRough = mix( gRough, 0.88, fd );
				gBump *= 1.0 - fd;
			}
		} else if ( farPx ) {
			// Distant block tops: flat landcover colours, large-scale variation only.
			col = gBlockFar( texture2D( uTexA, uv ), texture2D( uTexB, uv ), vGWorld, nW, nL, px );
		} else {
			vec4 A = texture2D( uTexA, uv );
			vec4 B = texture2D( uTexB, uv );
			float ne = sNoise( p, 1.7 );
			float pav = gEdge( A.b, ne, px, 0.08 );
			float dirt = gEdge( B.r, ne, px, 0.3 );
			float asph = gEdge( A.a, ne, px, 0.06 );
			float conc = gEdge( A.r, ne, px, 0.06 );
			float grass = gEdge( A.g, ne, px, 0.14 );
			float steps = gEdge( B.g, ne, px, 0.05 );
			vec2 q = gStreetFrame( p, uv );
			// Open land inside blocks, not otherwise classified: yards, slopes, cliffs (dry grass, dirt, scrub, rock).
			// (Skipped where another landcover layer covers the pixel completely, e.g. sidewalks.)
			col = vec3( 0.0 );
			gRough = 0.9;
			if ( max( max( max( pav, dirt ), max( asph, conc ) ), max( grass, steps ) ) < 0.999 ) col = gWild( vGWorld, nW, px, nL, nM, 0.0 );
			float rr = gRough;
			if ( grass > 0.0 ) {
				vec3 gcol = gGrass( p, px, nL, nM );
				col = mix( col, gcol, grass );
				rr = mix( rr, gRough, grass );
			}
			if ( conc > 0.0 ) {
				vec3 cc = gConcrete( q, p, px, nL, nM );
				col = mix( col, cc, conc );
				rr = mix( rr, gRough, conc );
			}
			if ( asph > 0.0 ) {
				vec3 ac = gAsphalt( p, px, nL, nM ) * 1.25;
				col = mix( col, ac, asph );
				rr = mix( rr, gRough, asph );
			}
			if ( steps > 0.0 ) {
				float tread = fract( q.x / 0.32 );
				vec3 sc = vec3( 0.33, 0.32, 0.30 ) * ( 0.85 + 0.2 * nM.x ) * mix( 0.6, 1.0, smoothstep( 0.0, 0.15, tread ) );
				col = mix( col, sc, steps );
			}
			if ( dirt > 0.0 ) {
				vec3 dc = vec3( 0.29, 0.235, 0.16 ) * ( 0.8 + 0.35 * nM.x );
				col = mix( col, dc, dirt );
				rr = mix( rr, 0.97, dirt );
			}
			if ( pav > 0.0 ) {
				vec3 pc = gPavers( q, p, px, nL );
				col = mix( col, pc, pav );
				rr = mix( rr, gRough, pav );
			}
			// Converge on the far composite so the near → far switch never draws a line.
			float fd = smoothstep( 0.07, 0.12, px );
			if ( fd > 0.0 ) {
				vec2 b2 = gBump;
				vec3 b3 = gBump3;
				vec3 fc = gBlockFar( A, B, vGWorld, nW, nL, px );
				gBump = b2;
				gBump3 = b3;
				col = mix( col, fc, fd );
				rr = mix( rr, gRough, fd );
				gBump *= 1.0 - fd;
				gBump3 *= 1.0 - fd;
			}
			gRough = rr;
		}
	}
	if ( dataW < 1.0 ) {
		// Procedural distant-city ground beyond the data (matches the engine's far ring).
		float urban = smoothstep( 0.6, 3.0, y );
		CityLook cl = cityLook( p, urban, uNight, vec3( 0.07, 0.085, 0.045 ) );
		col = mix( cl.albedo, col, dataW );
		gEmit = cl.emissive * 0.5 * ( 1.0 - dataW );
		gRough = mix( 0.92, gRough, dataW );
		gBump *= dataW;
		gBump3 *= dataW;
	}

	// Shore and bay floor (any non-block surface near or below sea level).
	if ( ( kind < 0.5 || kind > 3.5 ) && y < 2.6 ) {
		float depth = - y;
		vec3 rock = vec3( 0.16, 0.15, 0.13 ) * ( 0.6 + 0.8 * sNoise( p, 1.3 ) );
		vec3 mud = mix( vec3( 0.06, 0.058, 0.045 ), vec3( 0.025, 0.03, 0.028 ), smoothstep( 0.0, 12.0, depth ) );
		float shore = 1.0 - smoothstep( 1.5, 2.6, y );
		vec3 bed = mix( mud, rock, 1.0 - smoothstep( -1.5, 0.5, depth ) );
		col = mix( col, bed, shore );
		gRough = mix( gRough, 0.85, shore );
	}

	// Street-lamp light pools (night).
	if ( uLamps > 0.001 && inDZ > 0.5 ) gEmit += col * texture2D( uLightMap, uv ).rgb * uLamps * 4.0;
	alb = col;
}
`;

export class GroundMaterial {
  readonly material: THREE.MeshStandardMaterial;
  readonly uniforms = {
    uTexA: { value: null as THREE.Texture | null },
    uTexB: { value: null as THREE.Texture | null },
    uLightMap: { value: null as THREE.Texture | null },
    uBlockMask: { value: null as THREE.Texture | null },
    uDZ: { value: new THREE.Vector4(DZ.minX, DZ.minZ, DZ.maxX - DZ.minX, DZ.maxZ - DZ.minZ) },
    uCTX: { value: new THREE.Vector4(CTX.minX, CTX.minZ, CTX.maxX, CTX.maxZ) },
    uNight: { value: 0 },
    uLamps: { value: 0 },
  };

  constructor(lc: Landcover) {
    this.uniforms.uTexA.value = lc.texA;
    this.uniforms.uTexB.value = lc.texB;
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this.uniforms.uLightMap.value = blank;
    this.uniforms.uBlockMask.value = blank;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aKind;\nvarying vec3 vGWorld;\nvarying vec3 vGNrm;\nvarying float vGKind;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvGNrm = mat3( modelMatrix ) * objectNormal;\nvGKind = aKind;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${PARS}`)
        .replace('#include <color_fragment>', '#include <color_fragment>\n{ vec3 alb; gShade( alb ); diffuseColor.rgb = alb; }')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
{
	vec3 nW = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
	// Height gradient (flat-ground 2D bump + triplanar 3D bump) projected into the surface's tangent plane.
	vec3 gr = vec3( gBump.x, 0.0, gBump.y ) + gBump3;
	gr -= dot( gr, nW ) * nW;
	nW = normalize( nW - gr );
	normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
}`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmit;');
    };
    mat.customProgramCacheKey = () => 'argus-ground-v3';
    this.material = mat;
  }

  setBlockMask(mask: Uint8Array, w: number, h: number): void {
    const t = new THREE.DataTexture(mask, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.uniforms.uBlockMask.value = t;
  }

  setLightMap(t: THREE.Texture): void {
    this.uniforms.uLightMap.value = t;
  }

  update(night: number, lamps: number): void {
    this.uniforms.uNight.value = night;
    this.uniforms.uLamps.value = lamps;
  }
}
