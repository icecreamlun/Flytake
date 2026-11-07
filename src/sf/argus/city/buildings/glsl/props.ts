/**
 * Fragment shading for the prop mesh (roofs, parapets, cornice/bay caps, rooftop clutter, awnings,
 * blade signs, fire-escape railings, tile roofs). Kind ids match PropKind in builder.ts.
 */
export const PROPS_PARS = /* glsl */ `
varying vec3 vCol;
varying vec4 vProp;     // kind, u, v, rand
varying vec3 vWPos;
varying vec3 vNrmW;
varying float vH;
flat varying float vBld;
flat varying vec4 vDyn;
flat varying vec4 vPiv;
uniform float uLightLevel;

vec3 fAlbedo; float fRough; float fMetal; vec3 fEmis; float fAO; float fGlass;
vec3 fBump; // world-space normal offset (roof gravel, deck boards, brick courses)

void argProps() {
	int bi = int( vBld + 0.5 );
	float kind = floor( vProp.x + 0.5 );
	vec2 uv = vProp.yz;
	float rnd = vProp.w;
	vec3 N = normalize( vNrmW );
	vec3 c = vCol;
	float rough = 0.85;
	float metal = 0.0;
	vec3 emis = vec3( 0.0 );
	float ao = 1.0;
	float glassy = 0.0;
	float night = uNight;
	float lightsOn = 1.0 - clamp( vDyn.y, 0.0, 1.0 );
	vec2 fw = max( fwidth( uv ), vec2( 1e-4 ) );
	float lod = 1.0 - smoothstep( 0.05, 0.2, max( fw.x, fw.y ) );
	fBump = vec3( 0.0 );
	float dirtK = argStyle( bi, 5 ).w; // building dirt 0..1

	if ( kind < 0.5 ) {
		// Roof deck: membrane strips / tar & gravel / green roof, with ponding stains, repair patches
		// and soot / pigeon grime; gravel and seams perturb the normal so low sun rakes across them.
		vec4 S7 = argStyle( bi, 7 );
		float rk = S7.w;
		vec2 w = vWPos.xz;
		float wfw = max( fw.x, fw.y );
		float stain = smoothstep( 0.4, 0.85, lod > 0.01 ? fbm3( w * 0.11 + rnd * 40.0 ) : vnoise( w * 0.11 + rnd * 40.0 ) );
		// Rectangular repair patches on a per-building rotated grid.
		float ang = rnd * 6.2832;
		vec2 rw = mat2( cos( ang ), - sin( ang ), sin( ang ), cos( ang ) ) * w;
		vec2 cellSz = vec2( 3.0 + 4.0 * rnd, 2.2 + 2.5 * fract( rnd * 7.3 ) );
		vec2 pc = floor( rw / cellSz );
		float ph = h21( pc + rnd * 71.0 );
		vec2 pf = fract( rw / cellSz );
		// Patch covers a random sub-rectangle of its cell, so neighbours never tile into a grid.
		vec2 lo = h22( pc + 5.3 ) * 0.4;
		vec2 hi = lo + 0.35 + 0.25 * h22( pc + 9.1 );
		float patchM = step( 0.86, ph ) * step( lo.x, pf.x ) * step( pf.x, hi.x ) * step( lo.y, pf.y ) * step( pf.y, hi.y );
		if ( rk < 0.5 ) {
			float seamCoord = ( w.x * 0.7 + w.y * 0.71 ) / 1.83;
			float seam = fPulse( seamCoord, 0.0, 0.03, wfw / 1.83 );
			c *= ( 0.92 + 0.1 * vnoise( w * 0.6 ) ) * ( 1.0 - 0.18 * seam );
			c *= mix( 1.0, 0.9 + 0.14 * h11( ph * 13.0 ), patchM );
			rough = 0.7;
			// Lap-seam ridges.
			float sd = fract( seamCoord ) - 0.015;
			fBump.xz += vec2( 0.7, 0.71 ) * ( 1.0 - smoothstep( 0.0, 0.02, abs( sd ) ) ) * sign( sd ) * 0.5 * lod;
		} else if ( rk < 1.5 ) {
			// Tar & gravel: fine aggregate speckle (fades to its average with distance), a gentle bumpy
			// normal, and patches of fresh dark tar.
			float gl = 1.0 - smoothstep( 0.008, 0.03, wfw );
			float g1 = h21( floor( w * 40.0 ) ) * 0.6 + h21( floor( w * 17.0 + 3.1 ) ) * 0.4;
			c *= 0.9 + 0.2 * mix( 0.5, g1, gl );
			c *= mix( 1.0, 0.7, patchM );
			rough = 0.95;
			float bl = 1.0 - smoothstep( 0.01, 0.05, wfw );
			if ( bl > 0.01 ) {
				vec2 q = w * 22.0;
				float n0 = vnoise( q );
				fBump.x += ( vnoise( q + vec2( 0.3, 0.0 ) ) - n0 ) * 0.5 * bl;
				fBump.z += ( vnoise( q + vec2( 0.0, 0.3 ) ) - n0 ) * 0.5 * bl;
			}
		} else {
			c *= 0.75 + 0.45 * fbm3( w * 0.8 );
			rough = 0.95;
		}
		c *= 1.0 - ( 0.22 + 0.18 * dirtK ) * stain;
		// Soot / grime gathering in broad drifts.
		c *= 1.0 - 0.12 * smoothstep( 0.55, 0.9, vnoise( w * 0.035 + rnd * 9.0 ) );
	} else if ( kind < 1.5 ) {
		// Coping: weathered top, darker on the drip face where water runs off.
		c *= 0.88 + 0.16 * vnoise( vWPos.xz * 1.5 + vWPos.y );
		if ( abs( N.y ) < 0.5 ) c *= 0.8;
		rough = 0.75;
	} else if ( kind < 2.5 ) {
		// Parapet inner face: wet / grimy toward the roof deck.
		c *= 0.8 + 0.2 * smoothstep( 0.0, 0.8, uv.y );
		rough = 0.9;
		ao = 0.75 + 0.25 * smoothstep( 0.0, 0.5, uv.y );
	} else if ( kind < 3.5 ) {
		rough = 0.9;
		ao = 0.7;
	} else if ( kind < 4.5 ) {
		// HVAC unit: louvres on the sides, fan grilles on top.
		if ( abs( N.y ) < 0.5 ) {
			float lv = fPulse( uv.y / 0.09, 0.0, 0.45, fw.y / 0.09 ) * aBox( uv.y, 0.15, 10.0, fw.y );
			c *= 1.0 - 0.35 * lv * aBox( fract( uv.x / 1.2 ), 0.08, 0.92, fw.x / 1.2 );
		} else {
			vec2 cell = vec2( fract( uv.x / 1.1 ), fract( uv.y / 1.1 ) ) - 0.5;
			float fan = 1.0 - smoothstep( 0.3, 0.34, length( cell ) );
			c *= 1.0 - 0.55 * fan * lod;
		}
		rough = 0.55;
		metal = 0.25;
	} else if ( kind < 5.5 ) {
		// Penthouse / mechanical screen: louvre band near the top.
		if ( abs( N.y ) < 0.5 ) {
			float H = 3.0;
			float lv = fPulse( uv.y / 0.12, 0.0, 0.4, fw.y / 0.12 ) * step( 1.4, uv.y );
			c *= 1.0 - 0.3 * lv;
			float door = aBox( uv.x, 0.8, 1.8, fw.x ) * aBox( uv.y, 0.0, 2.1, fw.y ) * step( 0.5, rnd );
			c = mix( c, vec3( 0.25, 0.27, 0.28 ), door );
		}
		rough = 0.8;
	} else if ( kind < 7.5 ) {
		rough = 0.45;
		metal = 0.75;
	} else if ( kind < 8.5 ) {
		// Solar panel: cell grid on the top face.
		if ( N.y > 0.5 ) {
			float g = max( fPulse( uv.x / 0.166, 0.0, 0.06, fw.x / 0.166 ), fPulse( uv.y / 0.166, 0.0, 0.06, fw.y / 0.166 ) );
			c = mix( c, vec3( 0.55, 0.57, 0.6 ), g * 0.6 );
			rough = 0.12;
			metal = 0.3;
			glassy = 0.6;
		} else {
			c = vec3( 0.6 );
			metal = 0.8;
			rough = 0.4;
		}
	} else if ( kind < 9.5 ) {
		// Skylight glass.
		rough = 0.08;
		metal = 0.3;
		glassy = 0.8;
		emis += vec3( 1.0, 0.8, 0.55 ) * night * step( 0.5, rnd ) * 0.6 * lightsOn;
	} else if ( kind < 10.5 ) {
		// Fabric awning, some striped; glows faintly at night from the shop light below.
		float stripes = step( 0.6, rnd ) * fPulse( uv.x / 0.6, 0.0, 0.5, fw.x / 0.6 );
		c = mix( c, vec3( 0.92, 0.9, 0.86 ), stripes );
		c *= 0.92 + 0.08 * vnoise( uv * vec2( 3.0, 8.0 ) );
		rough = 0.88;
		emis += c * vec3( 1.0, 0.75, 0.45 ) * night * 0.35 * lightsOn * step( N.y, 0.2 );
	} else if ( kind < 11.5 ) {
		// Blade sign: a column of glyphs on the broad faces (u across the projection, v up), neon at night.
		float broad = step( abs( N.y ), 0.5 );
		float cell = 0.72;
		float row = floor( uv.y / cell );
		float txt = argGlyph( vec2( clamp( uv.x / 0.8, 0.0, 1.0 ), fract( uv.y / cell ) ), row + rnd * 97.0 ) * lod * broad;
		vec3 tc = dot( c, vec3( 0.33 ) ) > 0.45 ? vec3( 0.7, 0.05, 0.03 ) : vec3( 0.98, 0.82, 0.3 );
		float rim = ( 1.0 - aBox( uv.x, 0.05, 0.7, fw.x ) ) * broad;
		c = mix( c, tc, max( txt, rim * 0.5 ) );
		rough = 0.45;
		vec3 neon = rnd < 0.3 ? vec3( 1.0, 0.06, 0.04 ) : rnd < 0.5 ? vec3( 1.0, 0.42, 0.04 ) : rnd < 0.7 ? vec3( 0.08, 1.0, 0.3 ) : rnd < 0.85 ? vec3( 1.0, 0.1, 0.45 ) : vec3( 0.2, 0.45, 1.0 );
		emis += ( neon * ( txt * 3.5 + rim * 2.0 ) + c * 0.35 ) * night * lightsOn * step( abs( N.y ), 0.5 );
	} else if ( kind < 12.5 ) {
#ifdef ARG_RAILINGS
		// Fire-escape railings (bars) and stairs (treads); cut-outs are discarded.
		float keep;
		if ( uv.x >= 9.5 ) {
			float u = uv.x - 10.0;
			keep = max( fPulse( uv.y / 0.25, 0.0, 0.3, fw.y / 0.25 ), 1.0 - aBox( u, 0.05, 0.55, fw.x ) );
		} else {
			float bars = fPulse( uv.x / 0.14, 0.0, 0.18, fw.x / 0.14 );
			float rails = max( 1.0 - aStep( 0.05, uv.y, fw.y ), aStep( 0.88, uv.y, fw.y ) );
			keep = max( bars, rails );
		}
		if ( keep < 0.5 ) discard;
#endif
		rough = 0.6;
		metal = 0.5;
	} else if ( kind < 13.5 ) {
		// Tile / shingle roof: courses with shadow lines.
		float course = fract( uv.y / 0.28 );
		float l2 = 1.0 - smoothstep( 0.05, 0.25, fw.y / 0.28 );
		c *= mix( 0.9, 0.78 + 0.3 * smoothstep( 0.0, 0.35, course ), l2 );
		c *= 0.92 + 0.16 * mix( 0.5, h21( vec2( floor( uv.x / 0.25 ), floor( uv.y / 0.28 ) ) ), l2 );
		rough = 0.5;
	} else if ( kind < 14.5 ) {
		rough = 0.45;
		metal = 0.35;
	} else if ( kind < 15.5 ) {
		rough = 0.75;
	} else if ( kind < 16.5 ) {
		// Wooden water tank: staves + steel hoops.
		float staves = fPulse( uv.x / 0.14, 0.0, 0.12, fw.x / 0.14 );
		float hoops = fPulse( uv.y / 0.55, 0.0, 0.08, fw.y / 0.55 );
		c *= ( 0.9 + 0.2 * vnoise( vec2( uv.x * 7.0, uv.y * 0.5 ) ) ) * ( 1.0 - 0.3 * staves );
		c = mix( c, vec3( 0.12 ), hoops * step( abs( N.y ), 0.5 ) );
		rough = 0.92;
	} else if ( kind < 17.5 ) {
		// Profiled moulding. rnd = profile code (0 crown, 1 simple, 2 low, 3 belt, 4 skirt) + 0.1 * random.
		float code = floor( rnd + 0.001 );
		float strip = floor( uv.y );
		float across = fract( uv.y );
		float u = uv.x;
		float fwu = fw.x;
		// Dentils on the crown's bed band, modillion brackets on soffits.
		if ( code < 0.5 && abs( strip - 2.0 ) < 0.5 ) {
			float tooth = fPulse( u / 0.2, 0.0, 0.55, fwu / 0.2 );
			c *= mix( 0.45, 1.05, tooth );
			ao = mix( 0.55, 1.0, tooth );
		}
		bool soffit = ( code < 0.5 && abs( strip - 3.0 ) < 0.5 ) || ( code > 0.5 && code < 1.5 && abs( strip - 2.0 ) < 0.5 );
		if ( soffit ) {
			float br = fPulse( u / 0.62, 0.0, 0.22, fwu / 0.62 );
			c *= mix( 0.62, 1.15, br );
			ao = mix( 0.6, 1.0, br );
		}
		// Weathering: dirty wash on up-facing strips, streaks down the fascias, slight paint chalking.
		float up = smoothstep( 0.3, 0.9, N.y );
		c *= 1.0 - up * ( 0.18 + 0.2 * dirtK ) * ( 0.6 + 0.4 * vnoise( vWPos.xz * 2.0 ) );
		float streak = smoothstep( 0.5, 0.85, vnoise( vec2( u * 3.1, vWPos.y * 0.7 ) ) ) * step( abs( N.y ), 0.4 );
		c *= 1.0 - streak * 0.2 * dirtK * lod;
		c *= 0.95 + 0.08 * vnoise( vec2( u * 0.7, vWPos.y * 2.0 ) );
		rough = 0.68;
	} else if ( kind < 18.5 ) {
		// Brick chimney: running bond, sooty crown, dark flue on top.
		if ( N.y > 0.5 ) {
			vec2 f = abs( uv - vec2( 0.3, 0.45 ) );
			c *= 0.55;
			c = mix( c, vec3( 0.03 ), step( max( f.x, f.y ), 0.14 ) );
		} else {
			float row = floor( uv.y / 0.076 );
			float bx = uv.x / 0.23 + 0.5 * mod( row, 2.0 );
			float lodB = 1.0 - smoothstep( 0.2, 0.6, fw.y / 0.076 );
			float jH = fPulse( uv.y / 0.076, 0.0, 0.14, fw.y / 0.076 );
			float jV = fPulse( bx, 0.0, 0.05, fw.x / 0.23 );
			float bh = mix( 0.5, h21( vec2( floor( bx ), row ) + rnd * 37.0 ), lodB );
			c *= ( 0.78 + 0.4 * bh ) * ( 1.0 - 0.35 * max( jH, jV * ( 1.0 - jH ) ) );
			// Soot near the crown, streaking down.
			c *= 1.0 - 0.55 * smoothstep( 1.0, 1.9, uv.y ) * ( 0.6 + 0.4 * vnoise( vec2( uv.x * 4.0, uv.y * 0.5 ) ) );
		}
		rough = 0.92;
	} else if ( kind < 19.5 ) {
		// Galvanised vents / exhaust fans.
		c *= 0.9 + 0.15 * vnoise( vec2( uv.x * 6.0, uv.y * 2.0 ) );
		rough = 0.42;
		metal = 0.75;
	} else {
		// Timber roof deck: boards with gaps, weathered silver-brown.
		float board = floor( uv.x / 0.14 );
		float gap = fPulse( uv.x / 0.14, 0.0, 0.08, fw.x / 0.14 );
		c *= ( 0.82 + 0.3 * h11( board + rnd * 17.0 ) ) * ( 1.0 - 0.6 * gap * lod ) * ( 0.92 + 0.12 * vnoise( vec2( uv.x * 2.0, uv.y * 0.3 ) ) );
		rough = 0.85;
		if ( N.y > 0.5 ) fBump.x += ( fPulse( uv.x / 0.14, 0.0, 0.04, fw.x / 0.14 ) - fPulse( uv.x / 0.14, 0.04, 0.08, fw.x / 0.14 ) ) * 0.6 * lod;
	}

	// Damage (props share the building's state). Roofs carry most of the signal from an oblique helicopter view,
	// so every state leaves a distinct, coarse (1–10 m) mark on the roof deck:
	//   1 slight     dust and a few fallen bits
	//   2 moderate   littered with parapet / chimney debris, broad cracks, dark gaps along the parapet
	//   3 extensive  a partial roof collapse: a sagging, broken area (dark void, rubble, exposed joists)
	//   4 complete   most of the roof broken in, charred and rubble-choked
	float dmg = vDyn.x;
	if ( dmg > 0.02 ) {
		float ds = clamp( dmg, 0.0, 4.0 );
		float seedB = argStyle( bi, 3 ).w;
		vec2 w = vWPos.xz;
		vec2 rel = vWPos.xz - vPiv.xy;
		float wfw = max( fwidth( w.x ), fwidth( w.y ) ) + 1e-4;
		float dust = clamp( ds * 0.07, 0.0, 0.24 ) * ( 0.4 + 0.6 * vnoise( w * 0.4 ) );
		c = mix( c, vec3( 0.50, 0.47, 0.42 ), dust );
		rough = mix( rough, 1.0, dust );
		metal *= 1.0 - dust;
		emis *= 1.0 - dust;
		glassy *= 1.0 - dust;
		bool deck = kind < 0.5 || ( kind > 12.5 && kind < 13.5 ) || kind > 19.5;
		bool upF = N.y > 0.5;
		if ( upF ) {
			// Fallen debris littering the roof: irregular heaps of brick / plaster with dark gaps (two noise
			// octaves → ragged shapes, no dots), coverage growing with the state.
			vec2 lq = w + seedB * 41.0;
			float ln1 = vnoise( lq * 0.55 );
			float ln2 = vnoise( lq * 2.1 + 3.3 );
			float litT = 0.88 - 0.07 * ds;
			float lit = smoothstep( litT, litT + 0.06, ln1 * 0.7 + ln2 * 0.3 + 0.08 * ( 1.0 - lod ) );
			float lgrain = vnoise( lq * 6.0 );
			vec3 litC = mix( vec3( 0.40, 0.25, 0.18 ), vec3( 0.46, 0.43, 0.39 ), step( 0.5, vnoise( lq * 0.3 + 9.0 ) ) ) * ( 0.55 + 0.6 * lgrain );
			litC = mix( litC, vec3( 0.05, 0.045, 0.04 ), smoothstep( 0.55, 0.75, ln2 ) * 0.7 * smoothstep( 2.3, 3.0, ds ) );
			c = mix( c, litC, lit );
			// Broad roof cracks (moderate+).
			if ( ds > 1.4 ) {
				vec2 cq = w * 0.16 + seedB * 7.0;
				cq += ( vec2( vnoise( cq * 3.0 ), vnoise( cq * 3.0 + 7.7 ) ) - 0.5 ) * 0.3;
				vec2 ci = floor( cq );
				vec2 cf = fract( cq );
				float e1 = 8.0, e2 = 8.0;
				for ( int j = -1; j <= 1; j ++ ) for ( int i = -1; i <= 1; i ++ ) {
					vec2 g = vec2( float( i ), float( j ) );
					vec2 r = g + h22( ci + g ) - cf;
					float dd = dot( r, r );
					if ( dd < e1 ) { e2 = e1; e1 = dd; } else if ( dd < e2 ) e2 = dd;
				}
				float em = ( sqrt( e2 ) - sqrt( e1 ) ) * 0.5 / 0.16;
				float cw = 0.04 + 0.05 * ( ds - 1.4 );
				// Only some cell borders crack through.
				em += 9.0 * step( 0.25 + 0.2 * ds, h21( floor( cq * 0.5 ) + seedB ) );
				float cwD = max( cw, wfw * 0.5 );
				float rc = ( 1.0 - smoothstep( cwD * 0.5, cwD * 1.5, em ) ) * clamp( cw / wfw, 0.0, 1.0 ) * smoothstep( 1.4, 2.0, ds );
				c = mix( c, vec3( 0.03 ), rc * 0.9 );
			}
			// Partial / total roof collapse (extensive+): a broken area biased toward the middle of the roof.
			if ( deck && ds > 2.4 ) {
				float rr = length( rel );
				float cn = fbm3( w * 0.11 + seedB * 23.0 ) + 0.06 * vnoise( w * 1.3 );
				float bias = 0.3 * ( 1.0 - smoothstep( 3.0, 16.0, rr ) );
				float thr = mix( 0.9, 0.56, smoothstep( 2.4, 4.0, ds ) );
				float brk = smoothstep( thr, thr + 0.015, cn + bias ) * smoothstep( 2.4, 2.9, ds );
				float rimB = smoothstep( thr - 0.06, thr, cn + bias ) * ( 1.0 - brk ) * smoothstep( 2.4, 2.9, ds );
				// Inside: deep void, exposed joists / beams across it, rubble heaps and charring.
				float ja = seedB * 6.2832;
				float ju = dot( w, vec2( cos( ja ), sin( ja ) ) );
				// A few surviving beams spanning the hole (each beam broken into segments, some missing).
				float jv = dot( w, vec2( - sin( ja ), cos( ja ) ) );
				float jid = floor( ju / 2.4 );
				float joist = fPulse( ju / 2.4, 0.0, 0.1, wfw / 2.4 ) * step( 0.45, h11( jid + seedB * 7.0 ) ) * step( 0.4, vnoise( vec2( jv * 0.6, jid * 3.1 ) ) );
				float heap = smoothstep( 0.62, 0.8, vnoise( w * 0.45 + seedB * 3.0 ) );
				vec3 inC = vec3( 0.01, 0.009, 0.008 );
				inC = mix( inC, vec3( 0.30, 0.27, 0.23 ) * ( 0.6 + 0.6 * vnoise( w * 2.5 ) ), heap * 0.7 );
				inC = mix( inC, mix( vec3( 0.32, 0.24, 0.16 ), vec3( 0.05 ), step( 3.4, ds ) * 0.6 ), joist * 0.85 );
				c *= 1.0 - 0.5 * rimB;
				c = mix( c, inC, brk );
				rough = mix( rough, 1.0, brk );
				fBump *= 1.0 - brk;
				ao *= 1.0 - 0.4 * rimB - 0.3 * brk;
			}
		} else if ( ds > 1.4 && ( kind > 0.5 && kind < 2.5 ) ) {
			// Parapet / coping: chunks knocked off → dark raw gaps along the roof edge.
			float gn = vnoise( vec2( ( vWPos.x + vWPos.z ) * 0.35 + seedB * 9.0, 0.5 ) );
			float gap = smoothstep( mix( 0.8, 0.5, smoothstep( 1.4, 4.0, ds ) ), 0.95, gn );
			c = mix( c, vec3( 0.05, 0.045, 0.04 ), gap );
		}
		// Rooftop clutter and edges also get battered: darker, rougher.
		if ( !deck ) c *= 1.0 - 0.06 * ds;
		c = mix( c, vec3( 0.42, 0.40, 0.37 ), smoothstep( 0.2, 0.6, vDyn.z ) );
	}

	fAlbedo = c;
	fRough = rough;
	fMetal = metal;
	fEmis = emis;
	fAO = ao;
	fGlass = glassy;

	vec4 ovl = argOverlay( bi );
	if ( uDamageOverlay > 0.5 ) {
		vec3 rc = argDamageRamp( dmg );
		fAlbedo = mix( fAlbedo, rc, 0.9 );
		fEmis = mix( fEmis, rc * 0.3, 0.9 );
		fMetal *= 0.2;
		fGlass = 0.0;
	} else if ( ovl.a > 1.5 ) {
		fAlbedo = mix( fAlbedo, ovl.rgb, 0.78 );
		fEmis = mix( fEmis, ovl.rgb * 0.18, 0.8 );
		fMetal *= 0.2;
		fGlass = 0.0;
	}
	{
		// Scan veil (overlay alpha minus the tint flag): slight grey for areas AIR 1 has not scanned.
		float veil = ovl.a - step( 1.5, ovl.a ) * 2.0;
		if ( veil > 0.001 ) {
			float lum = dot( fAlbedo, vec3( 0.2126, 0.7152, 0.0722 ) );
			fAlbedo = mix( fAlbedo, vec3( lum ), veil * 0.55 ) * ( 1.0 - veil * 0.18 );
			fEmis = mix( fEmis, vec3( dot( fEmis, vec3( 0.2126, 0.7152, 0.0722 ) ) ), veil * 0.5 ) * ( 1.0 - veil * 0.25 );
			fGlass *= 1.0 - veil * 0.3;
		}
	}
	if ( vDyn.w > 0.5 ) {
		float pulse = 0.85 + 0.15 * sin( uTime * 3.0 );
		fEmis += vec3( 1.0, 0.42, 0.06 ) * 0.35 * pulse;
		fAlbedo = mix( fAlbedo, vec3( 1.0, 0.55, 0.2 ), 0.15 );
	}
}
`;
