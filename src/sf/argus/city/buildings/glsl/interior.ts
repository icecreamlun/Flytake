/**
 * Interior mapping (van Dongen 2008): a ray from the glass plane is intersected with an implicit
 * room box behind the window; walls / floor / ceiling / back wall get procedural furnishing and
 * light. Only evaluated close to the camera; far away the facade uses argRoomAverage().
 * Also: who is home — fraction of lit rooms by use and hour — and per-room lamp colour temperature.
 */
export const INTERIOR_PARS = /* glsl */ `
// Light colour temperatures (linear, luminance ≈ 0.7).
const vec3 ARG_WARM = vec3( 1.0, 0.58, 0.26 );
const vec3 ARG_NEUTRAL = vec3( 1.0, 0.84, 0.66 );
const vec3 ARG_COOL = vec3( 0.86, 0.92, 1.0 );

// Lamp colour from 2700 K (t = 0) to 4500 K (t = 1), normalised to a common luminance.
vec3 argKelvin( float t ) {
	vec3 c = mix( vec3( 1.0, 0.43, 0.13 ), vec3( 1.0, 0.72, 0.47 ), clamp( t, 0.0, 1.0 ) );
	return c * ( 0.7 / dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) );
}

// Per-room light colour from occupancy and a room hash.
vec3 argRoomLight( float occ, float rh ) {
	float k = h11( rh * 37.1 );
	if ( occ < 0.5 ) return argKelvin( 0.45 + 0.55 * k );                       // office: 3500-4500 K
	if ( occ < 1.5 ) {
		if ( rh > 0.95 ) return vec3( 0.45, 0.6, 1.0 );                            // TV glow
		return argKelvin( k * k * 0.55 );                                          // homes: 2700-3300 K
	}
	if ( occ < 2.5 ) return argKelvin( 0.1 + 0.35 * k );                         // hotel
	return argKelvin( 0.3 + 0.7 * k );
}

// Piecewise-linear table lookup over the 24 h day: values at hours h0..h7 (h sorted, wraps at 24).
float argDayCurve( float hr, vec4 h03, vec4 h47, vec4 v03, vec4 v47 ) {
	float h[8] = float[8]( h03.x, h03.y, h03.z, h03.w, h47.x, h47.y, h47.z, h47.w );
	float v[8] = float[8]( v03.x, v03.y, v03.z, v03.w, v47.x, v47.y, v47.z, v47.w );
	if ( hr <= h[0] ) return mix( v[7], v[0], ( hr + 24.0 - h[7] ) / max( h[0] + 24.0 - h[7], 1e-3 ) );
	for ( int i = 0; i < 7; i ++ ) {
		if ( hr <= h[i + 1] ) return mix( v[i], v[i + 1], ( hr - h[i] ) / max( h[i + 1] - h[i], 1e-3 ) );
	}
	return mix( v[7], v[0], ( hr - h[7] ) / max( h[0] + 24.0 - h[7], 1e-3 ) );
}

// Fraction of rooms with the lights on, by occupancy class and local hour.
float argLitFraction( float occ, float hr ) {
	if ( occ < 0.5 ) // offices: full by day, ~20 % at 21:30, a few cleaners / servers overnight
		return argDayCurve( hr, vec4( 2.0, 6.5, 8.5, 17.0 ), vec4( 19.0, 21.5, 23.5, 24.0 ), vec4( 0.07, 0.1, 0.85, 0.88 ), vec4( 0.45, 0.2, 0.1, 0.08 ) );
	if ( occ < 1.5 ) // homes: morning bump, evening peak 40-60 %, dark after midnight
		return argDayCurve( hr, vec4( 1.5, 5.0, 7.0, 9.5 ), vec4( 17.0, 19.5, 22.0, 23.5 ), vec4( 0.14, 0.05, 0.32, 0.12 ), vec4( 0.2, 0.52, 0.55, 0.32 ) );
	if ( occ < 2.5 ) // hotels
		return argDayCurve( hr, vec4( 1.5, 5.0, 7.0, 10.0 ), vec4( 17.0, 20.0, 22.5, 23.5 ), vec4( 0.2, 0.08, 0.35, 0.18 ), vec4( 0.3, 0.58, 0.6, 0.42 ) );
	return argDayCurve( hr, vec4( 2.0, 7.0, 9.0, 18.0 ), vec4( 20.0, 21.5, 23.0, 24.0 ), vec4( 0.05, 0.1, 0.9, 0.9 ), vec4( 0.6, 0.3, 0.1, 0.06 ) );
}

vec3 argRoomWall( float occ, float rh ) {
	vec3 a = vec3( 0.80, 0.77, 0.71 );
	vec3 b = occ < 0.5 ? vec3( 0.66, 0.69, 0.72 ) : vec3( 0.83, 0.70, 0.56 );
	vec3 c = occ < 0.5 ? vec3( 0.74, 0.74, 0.72 ) : vec3( 0.62, 0.70, 0.62 );
	return mix( mix( a, b, step( 0.45, rh ) ), c, step( 0.8, rh ) );
}

// Shop goods on shelving: packages of varied width / height per shelf, muted print colours, dark
// shelf boards with a shadow under each (p in metres on the wall plane).
vec3 argGoods( vec2 p, float rh, vec3 wallC ) {
	float shelfH = 0.42;
	float row = floor( p.y / shelfH );
	float sy = fract( p.y / shelfH ) * shelfH;
	float inRack = step( 0.25, p.y ) * step( p.y, 2.1 );
	// Items: variable widths along the shelf (two-level hash on 0.18 m cells split in two).
	float cx = p.x / 0.18 + h11( row * 7.1 + rh * 13.0 ) * 5.0;
	float ci = floor( cx );
	float split = 0.3 + 0.4 * h11( ci * 1.7 + row );
	float item = ci * 2.0 + step( split, fract( cx ) );
	float ih = h21( vec2( item, row ) + rh * 31.0 );
	float itemH = shelfH * ( 0.45 + 0.4 * h11( item * 3.3 + row ) );
	float onItem = step( 0.035, sy ) * step( sy, itemH ) * step( 0.06, abs( fract( cx ) - split ) ) * step( 0.04, fract( cx ) ) * step( fract( cx ), 0.96 );
	vec3 goods = vec3( h11( ih * 17.0 ), h11( ih * 29.0 ), h11( ih * 41.0 ) );
	goods = mix( vec3( dot( goods, vec3( 0.33 ) ) ), goods, 0.55 ) * 0.6 + 0.1;
	float gap = step( 0.85, h21( vec2( item, row ) + 3.7 ) );
	vec3 back = wallC * 0.35; // the shelf's back panel in shadow
	vec3 c = mix( back, goods, onItem * ( 1.0 - gap ) );
	c *= 0.55 + 0.45 * smoothstep( 0.0, 0.25, sy ); // shadow cast by the shelf above onto the goods
	c = mix( c, vec3( 0.09, 0.08, 0.07 ), step( sy, 0.035 ) ); // shelf board edge
	return mix( wallC, c, inRack );
}

/**
 * o: entry point on the glass plane in room space (x across [0,W], y up [0,Hr], z = 0);
 * d: tangent-space view direction (d.z < 0 going into the room).
 * Returns: rgb = surface albedo × lighting (radiance), a = how much of it is artificial light.
 */
vec4 argInterior( vec3 o, vec3 d, float W, float Hr, float D, float occ, float rh, float lit, vec3 lightCol, float shop ) {
	vec3 id = 1.0 / ( d + vec3( 1e-5 ) );
	float tx = d.x > 0.0 ? ( W - o.x ) * id.x : - o.x * id.x;
	float ty = d.y > 0.0 ? ( Hr - o.y ) * id.y : - o.y * id.y;
	float tz = - D * id.z;
	float t = min( min( tx, ty ), tz );
	vec3 hp = o + d * t;
	float depth = clamp( - hp.z / D, 0.0, 1.0 );
	vec3 wallC = argRoomWall( occ, rh );
	// Shops: market (rh < 0.35, white walls, packed shelves), restaurant (0.35-0.6, lacquer red or dark
	// wood, tables), boutique / lobby (> 0.6, pale walls, sparse displays).
	if ( shop > 0.5 ) wallC = rh < 0.35 ? vec3( 0.6, 0.58, 0.54 ) : rh < 0.6 ? ( rh < 0.47 ? vec3( 0.32, 0.06, 0.04 ) : vec3( 0.2, 0.12, 0.07 ) ) : vec3( 0.42, 0.38, 0.33 );
	vec3 col;
	float glow = 0.0; // ceiling fixtures
	if ( t == tz ) {
		col = wallC;
		float u = hp.x / W;
		if ( shop > 0.5 ) {
			col = rh < 0.35 ? argGoods( hp.xy, rh, wallC ) : wallC;
			// Restaurants: menu boards / art; boutiques: lit display niches. Counter across the back.
			if ( rh >= 0.35 && rh < 0.6 ) col = mix( col, vec3( 0.75, 0.6, 0.2 ), step( 1.6, hp.y ) * step( hp.y, 2.2 ) * step( 0.25, u ) * step( u, 0.75 ) * 0.6 );
			if ( rh >= 0.6 ) col = mix( col, argGoods( hp.xy * vec2( 0.6, 1.0 ), rh, wallC ), step( 0.3, fract( u * 2.0 ) ) * 0.7 );
			if ( rh >= 0.35 ) col = mix( col, vec3( 0.16, 0.1, 0.07 ), step( hp.y, 1.05 ) * step( 0.15, u ) * step( u, 0.85 ) );
		} else if ( occ < 0.5 ) {
			// Office: desks + monitors silhouette, a door or whiteboard.
			col = mix( col, vec3( 0.25, 0.25, 0.27 ), step( hp.y, 0.75 ) * step( 0.08, u ) * step( u, 0.92 ) );
			col = mix( col, vec3( 0.05 ), step( 0.75, hp.y ) * step( hp.y, 1.15 ) * step( 0.5, fract( u * 3.0 + rh ) ) * step( fract( u * 3.0 + rh ), 0.75 ) );
			col = mix( col, vec3( 0.92 ), step( 1.3, hp.y ) * step( hp.y, 2.2 ) * step( 0.6, rh ) * step( 0.2, u ) * step( u, 0.55 ) );
		} else {
			// Home: sofa/bed, picture frame, doorway.
			float w0 = 0.1 + 0.3 * h11( rh * 9.1 );
			col = mix( col, mix( vec3( 0.32, 0.22, 0.18 ), vec3( 0.25, 0.3, 0.4 ), h11( rh * 4.3 ) ), step( hp.y, 0.8 ) * step( w0, u ) * step( u, w0 + 0.45 ) );
			col = mix( col, vec3( 0.18, 0.15, 0.13 ), step( 1.4, hp.y ) * step( hp.y, 2.0 ) * step( 0.62, u ) * step( u, 0.8 ) * step( 0.4, rh ) );
			col = mix( col, wallC * 0.45, step( 0.82, u ) * step( hp.y, 2.1 ) * step( 0.7, h11( rh * 2.9 ) ) );
		}
	} else if ( t == ty ) {
		if ( d.y > 0.0 ) {
			col = vec3( 0.86, 0.85, 0.82 ) * ( shop > 0.5 ? 0.7 : 1.0 );
			// Ceiling fixtures: office / shop troffer rows, a single warm lamp at home.
			vec2 c = vec2( hp.x / W, - hp.z / D );
			if ( shop > 0.5 ) glow = step( 0.42, fract( - hp.z / 1.8 ) ) * step( fract( - hp.z / 1.8 ), 0.58 ) * step( 0.2, fract( hp.x / 1.5 ) ) * step( fract( hp.x / 1.5 ), 0.8 );
			else if ( occ < 0.5 ) glow = step( 0.3, fract( c.y * 2.0 ) ) * step( fract( c.y * 2.0 ), 0.7 ) * step( 0.25, c.x ) * step( c.x, 0.75 );
			else glow = 1.0 - smoothstep( 0.05, 0.14, length( c - vec2( 0.5, 0.45 ) ) * 0.6 );
		} else {
			col = occ < 0.5 ? vec3( 0.28, 0.29, 0.31 ) : mix( vec3( 0.42, 0.28, 0.18 ), vec3( 0.55, 0.5, 0.45 ), step( 0.6, rh ) );
			if ( shop > 0.5 ) {
				// Tiled shop floor.
				vec2 tq = floor( vec2( hp.x, - hp.z ) / 0.5 );
				col = mix( vec3( 0.42, 0.4, 0.37 ), vec3( 0.2, 0.19, 0.18 ), mod( tq.x + tq.y, 2.0 ) * step( 0.5, rh ) ) * 0.8;
				// Tables / displays near the window.
				vec2 tc = fract( vec2( hp.x / 1.6, - hp.z / 2.2 ) ) - 0.5;
				col = mix( col, vec3( 0.12, 0.08, 0.06 ), step( length( tc ), 0.22 ) * step( - hp.z, D * 0.7 ) );
			}
			// Office: desk tops seen from above near the window.
			if ( occ < 0.5 && shop < 0.5 ) col = mix( col, vec3( 0.6, 0.58, 0.55 ), step( 0.15, fract( - hp.z / 1.6 ) ) * step( fract( - hp.z / 1.6 ), 0.55 ) * 0.6 );
		}
	} else {
		col = wallC * 0.88;
		if ( shop > 0.5 ) {
			// Side walls: shelving in markets, dark wainscot + framed pictures elsewhere.
			if ( rh < 0.35 ) col = argGoods( vec2( - hp.z, hp.y ), rh + 0.13, wallC * 0.88 );
			else if ( rh >= 0.6 ) {
				// Boutique: display shelving bays separated by dark uprights.
				col = argGoods( vec2( - hp.z * 0.7, hp.y ), rh + 0.29, wallC * 0.7 );
				col = mix( col, vec3( 0.08, 0.07, 0.06 ), step( fract( - hp.z / 1.5 ), 0.08 ) );
			} else {
				col = mix( col, vec3( 0.1, 0.07, 0.05 ), step( hp.y, 1.0 ) );
				vec2 pf = vec2( fract( - hp.z / 2.4 ), hp.y );
				col = mix( col, mix( vec3( 0.15, 0.2, 0.25 ), vec3( 0.55, 0.45, 0.3 ), h11( floor( - hp.z / 2.4 ) + rh * 7.0 ) ), step( 0.3, pf.x ) * step( pf.x, 0.7 ) * step( 1.4, pf.y ) * step( pf.y, 2.1 ) );
			}
		}
		if ( occ < 0.5 && shop < 0.5 ) col = mix( col, vec3( 0.42, 0.44, 0.46 ), step( hp.y, 1.2 ) * 0.5 );
	}
	// Daylight from the window falls off with depth; artificial light is brightest under the fixtures
	// near the window and fades toward the back (and toward the floor).
	float dayL = uDayLevel * ( 1.0 - uNight ) * mix( 1.0, 0.25, depth * depth ) * ( t == ty && d.y > 0.0 ? 0.55 : 1.0 );
	float art = lit * ( 0.35 + 0.65 * ( 1.0 - depth ) ) * ( 0.75 + 0.25 * smoothstep( 0.0, 1.6, hp.y ) );
	// Shops: pools of light under the fixtures, darker between them and toward the floor.
	if ( shop > 0.5 && t != ty ) art *= ( 0.6 + 0.4 * smoothstep( 0.2, 1.2, hp.y ) ) * mix( 1.0, 0.45, smoothstep( 2.1, Hr, hp.y ) ) * ( 0.75 + 0.25 * cos( 6.2832 * ( - hp.z / 1.8 - 0.5 ) ) );
	vec3 rad = col * ( vec3( dayL ) + lightCol * art ) + lightCol * glow * lit * mix( 0.8, 2.2, uNight );
	return vec4( rad, art );
}

// Cheap far-field stand-in: average room radiance for a lit / unlit room.
vec3 argRoomAverage( float occ, float rh, float lit, vec3 lightCol ) {
	vec3 avg = argRoomWall( occ, rh ) * 0.6;
	return avg * ( vec3( uDayLevel * ( 1.0 - uNight ) * 0.5 ) + lightCol * lit * 0.75 ) + lightCol * lit * 0.28;
}
`;
