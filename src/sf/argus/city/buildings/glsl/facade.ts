/**
 * Facade fragment shading (runs inside MeshStandardMaterial via onBeforeCompile, so PBR lighting,
 * shadows, IBL and fog are kept). argFacade() fills the f* globals that replace the material inputs:
 *   fAlbedo, fRough, fMetal, fNT (tangent-space normal: x along wall, y up, z out), fEmis, fAO, fGlass.
 *
 * Layout per wall segment: modules of width mw = L / round(L / module); storeys of floorH above a
 * ground floor of groundH; a solid top band (frieze / parapet) of topBand under the roof.
 * Near the camera windows are real openings: recessed glass (parallax jambs, sills, heads) with
 * interior-mapped rooms behind; far away everything collapses to box-filtered averages (no moiré).
 */
export const FACADE_PARS = /* glsl */ `
varying vec4 vFac;      // s, L, key, groundY
varying float vH;       // height above building base (undeformed)
varying vec3 vWPos;     // deformed world position
varying vec3 vNrmW;     // deformed world normal
flat varying float vBld;
flat varying float vFlags;
flat varying vec4 vDyn; // damage, lightsOut, crush, highlighted
flat varying vec4 vPiv; // cx, cz, base, height
uniform float uLightLevel;

vec3 fAlbedo; float fRough; float fMetal; vec3 fNT; vec3 fEmis; float fAO; float fGlass;

float argFresnel( float cosT ) { return 0.04 + 0.96 * pow( 1.0 - clamp( cosT, 0.0, 1.0 ), 5.0 ); }

// Storefront joinery colour: black steel, bronze or painted wood.
vec3 frameCol( float shopH ) {
	float f = h11( shopH * 2.3 );
	return f < 0.5 ? vec3( 0.07, 0.065, 0.06 ) : f < 0.75 ? vec3( 0.3, 0.22, 0.12 ) : vec3( 0.55, 0.53, 0.5 );
}

void argFacade() {
	int bi = int( vBld + 0.5 );
	vec4 S0 = argStyle( bi, 0 ); vec4 S1 = argStyle( bi, 1 ); vec4 S2 = argStyle( bi, 2 ); vec4 S3 = argStyle( bi, 3 );
	vec4 S4 = argStyle( bi, 4 ); vec4 S5 = argStyle( bi, 5 ); vec4 S6 = argStyle( bi, 6 );
	float style = S0.x; float mat = S0.y; float floorH = S0.z; float groundH = S0.w;
	float module = S1.x; float winWf = S1.y; float winH = S1.z; float sill = S1.w;
	vec3 baseC = S2.rgb; float recess = S2.w;
	vec3 trimC = S3.rgb; float seed = S3.w;
	vec3 glassC = S4.rgb; float flags = S4.w;
	vec3 accent = S5.rgb; float dirt = S5.w;
	float topBand = S6.x; float occ = S6.y; float litProb = S6.z;
	float H = vPiv.w;

	float street = mod( floor( vFlags / 2.0 ), 2.0 );
	float kind = floor( mod( vFlags, 16.0 ) / 4.0 );
	// Lot-line wall: blank only up to a storey above the abutting neighbour's roof.
	float partyTopRel = floor( vFlags / 16.0 ) * 0.5;
	float party = mod( vFlags, 2.0 ) * step( vH, partyTopRel + 3.0 );

	float s = vFac.x; float L = vFac.y; float key = vFac.z; float groundY = vFac.w;
	float v = vH;
	float fwS = max( fwidth( s ), 1e-4 );
	float fwV = max( fwidth( v ), 1e-4 );

	vec3 N = normalize( vNrmW );
	vec3 T = normalize( vec3( - N.z, 0.0, N.x ) + vec3( 1e-6, 0.0, 0.0 ) );
	vec3 B = cross( T, N );
	vec3 V = normalize( vWPos - cameraPosition );
	vec3 d = vec3( dot( V, T ), dot( V, B ), dot( V, N ) );
	float dist = length( vWPos - cameraPosition );
	float cosV = clamp( - d.z, 0.0, 1.0 );

	bool sCurtain = abs( style - 3.0 ) < 0.5;
	bool sConcrete = abs( style - 4.0 ) < 0.5;
	bool sMidc = abs( style - 5.0 ) < 0.5;
	bool sChina = style < 0.5;
	bool sParking = abs( style - 9.0 ) < 0.5;
	bool sUtil = abs( style - 8.0 ) < 0.5;
	bool sHouse = abs( style - 7.0 ) < 0.5;
	bool sPrewar = abs( style - 2.0 ) < 0.5;
	bool sHist = abs( style - 1.0 ) < 0.5;

	fNT = vec3( 0.0, 0.0, 1.0 );
	fAO = 1.0;
	fEmis = vec3( 0.0 );
	fGlass = 0.0;
	fMetal = 0.0;
	float night = uNight;
	float lightsOn = 1.0 - clamp( vDyn.y, 0.0, 1.0 );

	// ── Wall material ─────────────────────────────────────────────
	vec2 fp = vec2( s + key * 13.0, v );
	// Distance LOD: beyond ~0.15 m/pixel material micro-patterns and streak noise are invisible, so
	// those branches are skipped (spatially coherent → cheap dynamic branching).
	float pxSize = max( fwS, fwV );
	bool nearD = pxSize < 0.15;
	float big = nearD ? fbm3( fp * vec2( 0.07, 0.05 ) + seed * 50.0 ) : vnoise( fp * vec2( 0.07, 0.05 ) + seed * 50.0 );
	vec3 wallC = baseC * ( 0.9 + 0.2 * big );
	float wallRough = 0.88;
	float wallMetal = 0.0;
	vec3 wallNT = vec3( 0.0, 0.0, 1.0 );
	float detailLod = 1.0 - smoothstep( 0.02, 0.08, fwS );
	if ( !nearD ) {
		// Far: pre-averaged material tone (brick incl. ~18% mortar), roughness only.
		// (Values = the near path's box-filtered limits, so there is no seam at the LOD switch.)
		if ( mat < 1.5 ) wallC = mix( mat < 0.5 ? wallC : wallC * 0.885, mat < 0.5 ? wallC * 0.86 : vec3( 0.50, 0.47, 0.43 ), 0.14 );
		else if ( mat > 2.5 && mat < 5.5 ) wallC *= 0.99;
		else if ( mat > 7.5 && mat < 8.5 ) wallC *= 0.92;
		else if ( mat > 8.5 ) wallC *= 0.975;
		wallRough = mat > 6.5 && mat < 7.5 ? 0.38 : mat > 8.5 ? 0.55 : mat > 3.5 && mat < 4.5 ? 0.55 : 0.88;
		wallMetal = mat > 6.5 && mat < 7.5 ? 0.55 : mat > 8.5 ? 0.45 : 0.0;
	} else if ( mat < 1.5 ) {
		// Running-bond brick (filtered joints, per-brick tint fading out with distance).
		float rowH = 0.0762;
		float row = floor( v / rowH );
		float bx = s / 0.23 + 0.5 * mod( row, 2.0 );
		float jH = fPulse( v / rowH, 0.0, 0.14, fwV / rowH );
		float jV = fPulse( bx, 0.0, 0.05, fwS / 0.23 );
		float mortar = max( jH, jV * ( 1.0 - jH ) );
		float lodB = 1.0 - smoothstep( 0.2, 0.55, fwV / rowH );
		float bh = mix( 0.5, h21( vec2( floor( bx ), row ) + seed * 97.0 ), lodB );
		vec3 brickC = mat < 0.5 ? wallC * ( 0.96 + 0.08 * bh ) : wallC * ( 0.78 + 0.42 * bh * bh );
		vec3 mortarC = mat < 0.5 ? wallC * 0.86 : vec3( 0.50, 0.47, 0.43 );
		wallC = mix( brickC, mortarC, mortar );
		wallRough = 0.9;
		wallNT.y += ( fPulse( v / rowH, 0.0, 0.07, fwV / rowH ) - fPulse( v / rowH, 0.07, 0.14, fwV / rowH ) ) * 0.35 * lodB;
	} else if ( mat < 2.5 ) {
		wallC *= 0.94 + 0.12 * vnoise( fp * 1.3 + seed * 7.0 ) * detailLod + 0.06 * ( 1.0 - detailLod );
		wallRough = 0.93;
	} else if ( mat < 4.5 ) {
		// Ashlar (limestone) or terracotta blocks.
		vec2 bs = mat < 3.5 ? vec2( 1.25, 0.62 ) : vec2( 0.62, 0.46 );
		float row = floor( v / bs.y );
		float bx = s / bs.x + 0.5 * mod( row, 2.0 );
		float jH = fPulse( v / bs.y, 0.0, 0.012 / bs.y, fwV / bs.y );
		float jV = fPulse( bx, 0.0, 0.012 / bs.x, fwS / bs.x );
		float lodB = 1.0 - smoothstep( 0.1, 0.4, fwV / bs.y );
		float bh = mix( 0.5, h21( vec2( floor( bx ), row ) + seed * 31.0 ), lodB );
		wallC *= ( 0.94 + 0.12 * bh ) * ( 1.0 - 0.35 * max( jH, jV ) );
		wallRough = mat < 3.5 ? 0.8 : 0.55;
	} else if ( mat < 5.5 ) {
		// Precast / cast-in-place concrete: panel joints, mottling.
		float jx = fPulse( s / 3.0 + key, 0.0, 0.015 / 3.0, fwS / 3.0 );
		float jy = fPulse( ( v - groundH ) / floorH, 0.0, 0.02 / floorH, fwV / floorH );
		wallC *= ( 0.92 + 0.14 * vnoise( fp * 0.8 + seed * 3.0 ) ) * ( 1.0 - 0.4 * max( jx, jy ) );
		wallRough = 0.9;
	} else if ( mat < 6.5 ) {
		wallRough = 0.3;
	} else if ( mat < 7.5 ) {
		float jx = fPulse( s / 1.5, 0.0, 0.01 / 1.5, fwS / 1.5 );
		float jy = fPulse( v / ( floorH * 0.5 ), 0.0, 0.01 / ( floorH * 0.5 ), fwV / ( floorH * 0.5 ) );
		wallC *= 1.0 - 0.5 * max( jx, jy );
		wallRough = 0.38;
		wallMetal = 0.55;
	} else if ( mat < 8.5 ) {
		// Clapboard siding: lapped boards with a shadow line at each lap.
		float f = fract( v / 0.16 );
		float lod = 1.0 - smoothstep( 0.1, 0.4, fwV / 0.16 );
		wallC *= mix( 0.92, 0.78 + 0.22 * smoothstep( 0.0, 0.25, f ), lod );
		wallNT.y += -0.45 * ( 1.0 - smoothstep( 0.0, 0.2, f ) ) * lod + 0.08 * lod;
		wallRough = 0.85;
	} else {
		// Corrugated metal.
		float lod = 1.0 - smoothstep( 0.03, 0.08, fwS );
		wallNT.x += 0.5 * sin( s * 6.2832 / 0.15 ) * lod;
		wallC *= 0.95 + 0.05 * vnoise( fp * 0.5 );
		wallRough = 0.55;
		wallMetal = 0.45;
	}

	// Weathering (wall-space noise; s runs continuously along each wall, v is height):
	//  splash grime rising from the pavement, large discoloured patches, corner wear, stains under the top band.
	float gH = vWPos.y - groundY;
	float gN = nearD ? vnoise( vec2( s * 1.7 + key, gH * 3.0 ) ) : 0.5;
	float grime = ( 1.0 - smoothstep( 0.0, 1.1 + 0.6 * gN, gH ) ) * ( 0.3 + 0.4 * dirt );
	grime += ( 1.0 - smoothstep( 0.0, 0.3, gH ) ) * 0.15; // wet kick zone right at the pavement
	float blot = smoothstep( 0.45, 0.9, nearD ? fbm3( fp * vec2( 0.18, 0.09 ) + seed * 19.0 ) : vnoise( fp * vec2( 0.18, 0.09 ) + seed * 19.0 ) ) * dirt * 0.28;
	// Big repaint / water-damage patches (very low frequency, both lighter and darker).
	float patchN = vnoise( fp * vec2( 0.045, 0.06 ) + seed * 7.0 ) - 0.5;
	wallC *= 1.0 + patchN * 0.16;
	float underTop = ( 1.0 - smoothstep( 0.0, 2.5, ( H - topBand ) - v ) ) * step( v, H - topBand ) * 0.15 * dirt;
	// Corner wear: building corners collect grime and chipped edges.
	float cornerD = min( s, L - s );
	float corner = ( 1.0 - smoothstep( 0.0, 0.45, cornerD ) ) * step( 0.5, L ) * ( nearD ? 0.4 + 0.6 * vnoise( vec2( v * 1.3, s * 3.0 ) ) : 0.7 );
	float weather = clamp( grime + blot + underTop + corner * 0.16 * ( 0.4 + dirt ), 0.0, 0.7 );

	// ── Openings layout ───────────────────────────────────────────
	float n = max( 1.0, floor( L / module + 0.25 ) );
	float mw = L / n;
	float cxm = s / mw;
	float col = clamp( floor( cxm ), 0.0, n - 1.0 );
	float fx = ( cxm - col ) * mw;
	float ww = winWf * mw;
	float x0 = 0.5 * ( mw - ww );
	float x1 = x0 + ww;
	float segOK = step( 1.2, L ) * ( 1.0 - party ) * step( kind, 2.5 );
	if ( kind > 1.5 && kind < 2.5 ) { // bay faces: one centred window each
		x0 = max( 0.12 * mw, 0.5 * ( mw - max( ww, mw * 0.62 ) ) );
		x1 = mw - x0;
	}

	bool ground = v < groundH;
	bool storefront = ground && street > 0.5 && argFlag( flags, 1.0 ) && kind < 0.5 && party < 0.5;
	bool garage = ground && argFlag( flags, 128.0 ) && !storefront && street > 0.5 && kind < 0.5 && party < 0.5;
	float nf = floor( ( H - topBand - groundH ) / floorH + 0.05 );
	float fh = floorH;
	float fy = ( v - groundH ) / floorH;
	float flo = floor( fy );
	float yIn = ( fy - flo ) * floorH;
	float y0 = sill;
	float y1 = sill + winH;
	float validF = aStep( 0.0, fy, fwV / floorH ) * ( 1.0 - aStep( nf, fy, fwV / floorH ) );
	if ( ground ) {
		fh = groundH;
		flo = -1.0;
		yIn = v;
		y0 = max( 0.9, groundH - 0.6 - winH );
		y1 = groundH - 0.6;
		validF = step( 2.6, groundH );
	}
	validF *= segOK;

	// Storefront module.
	float smw = mw < 3.0 ? mw * 2.0 : mw;
	float sn = max( 1.0, floor( L / smw + 0.25 ) );
	smw = L / sn;
	float scol = clamp( floor( s / smw ), 0.0, sn - 1.0 );
	float sfx = s - scol * smw;
	// Shop identity (type, opening hours, door side) and the recessed entry door span.
	float shopH = h21( vec2( scol + key * 3.0, seed * 7.0 ) );
	bool modernSF = sCurtain || sConcrete || sMidc || sPrewar;
	float dX0 = 0.0, dX1 = -1.0;
	float doorZone = 0.0;
	if ( storefront ) {
		mw = smw;
		col = scol + 100.0;
		fx = sfx;
		x0 = 0.28;
		x1 = mw - 0.28;
		y0 = modernSF ? 0.25 : 0.55; // bulkhead (kick plate) below the display window
		y1 = modernSF ? groundH - 0.5 : groundH - 1.05;
		// Recessed entry: one side of the bay, or centred on wide bays.
		if ( x1 - x0 > 2.6 && y1 > 2.4 ) {
			float dw = modernSF ? 1.8 : 1.1;
			float side = h11( shopH * 13.1 );
			if ( side < 0.4 ) { dX0 = x0; dX1 = x0 + dw; }
			else if ( side < 0.8 || x1 - x0 < 4.4 ) { dX1 = x1; dX0 = x1 - dw; }
			else { dX0 = 0.5 * mw - 0.5 * dw; dX1 = dX0 + dw; }
			doorZone = aBox( fx, dX0 - 0.1, dX1 + 0.1, fwS ) * ( 1.0 - aStep( y1, v, fwV ) );
		}
		yIn = v;
		validF = segOK;
		recess = 0.12;
	}

	float cellPx = min( mw / fwS, fh / fwV );
	float fine = smoothstep( 4.0, 12.0, cellPx );

	// Far: box-filtered window coverage.
	float winFar;
	if ( ground || storefront ) winFar = fPulse( s / mw, x0 / mw, x1 / mw, fwS / mw ) * aBox( v, y0, y1, fwV ) * validF;
	else winFar = fPulse( s / mw, x0 / mw, x1 / mw, fwS / mw ) * fPulse( fy, y0 / floorH, y1 / floorH, fwV / floorH ) * validF;
	if ( garage && !storefront ) winFar *= 0.3;

	// Near: recessed opening with parallax jambs.
	float openW = 0.0;
	float glassM = 0.0;
	float gx = fx;
	float gy = yIn;
	vec3 jambNT = vec3( 0.0, 0.0, 1.0 );
	bool arched = argFlag( flags, 8.0 ) && !storefront && !ground;
	if ( fine > 0.001 ) {
		float k = recess / max( cosV, 0.15 );
		gx = fx + d.x * k;
		gy = yIn + d.y * k;
		float aax = fwS * 1.1;
		float aay = fwV * 1.1;
		openW = aBox( fx, x0, x1, aax ) * aBox( yIn, y0, y1, aay );
		float openG = aBox( gx, x0, x1, aax ) * aBox( gy, y0, y1, aay );
		if ( arched ) {
			float r = 0.5 * ( x1 - x0 );
			float yc = y1 - r;
			float xc = 0.5 * ( x0 + x1 );
			if ( yIn > yc ) openW *= 1.0 - aStep( r, length( vec2( fx - xc, yIn - yc ) ), aax );
			if ( gy > yc ) openG *= 1.0 - aStep( r, length( vec2( gx - xc, gy - yc ) ), aax );
		}
		openW *= validF * ( 1.0 - doorZone );
		glassM = openW * openG;
		// Which reveal face does the ray hit?
		float ox0 = x0 - gx, ox1 = gx - x1, oy0 = y0 - gy, oy1 = gy - y1;
		float m = max( max( ox0, ox1 ), max( oy0, oy1 ) );
		jambNT = m == ox0 ? vec3( 1.0, 0.0, 0.25 ) : m == ox1 ? vec3( -1.0, 0.0, 0.25 ) : m == oy0 ? vec3( 0.0, 1.0, 0.25 ) : vec3( 0.0, -1.0, 0.25 );
	}
	float opening = mix( winFar, openW, fine );
	float glass = mix( winFar, glassM, fine );
	float jamb = max( opening - glass, 0.0 );

	// ── Wall articulation (pilasters, belt courses, rustication, top band, trims) ──
	vec3 wC = wallC;
	vec3 wNT = wallNT;
	float wAO = 1.0;
	// Belt course above the ground floor.
	if ( !sCurtain && !sMidc && !sParking ) {
		float belt = aBox( v, groundH - 0.05, groundH + 0.3, fwV ) * ( 1.0 - street );
		wC = mix( wC, mix( wallC * 0.9, trimC, sChina ? 0.35 : 0.0 ), belt );
		wNT.y += ( aBox( v, groundH + 0.22, groundH + 0.3, fwV ) - aBox( v, groundH - 0.05, groundH + 0.02, fwV ) ) * 0.7 * fine;
	}
	// Pilasters at module boundaries + recessed spandrels (vertical emphasis).
	if ( argFlag( flags, 16.0 ) && !ground && v < H - topBand ) {
		float pw = ( mw - ww ) * 0.85;
		float dx = min( fx, mw - fx );
		float pil = 1.0 - aStep( pw * 0.5, dx, fwS );
		wC = mix( wC, wC * 1.08, pil );
		float edge = aBox( dx, pw * 0.5 - 0.05, pw * 0.5, fwS ) * fine;
		wNT.x += edge * ( fx < mw * 0.5 ? -0.8 : 0.8 );
		float spand = aBox( fx, x0, x1, fwS ) * ( 1.0 - aBox( yIn, y0, y1, fwV ) );
		wC = mix( wC, trimC * 0.85, spand * 0.7 );
		wAO *= 1.0 - 0.15 * spand;
	}
	// Corner quoins on older masonry (alternating long / short stones at segment ends).
	if ( ( sHist || sPrewar || ( sChina && mat < 1.5 ) || ( abs( style - 6.0 ) < 0.5 && mat < 1.5 ) ) && kind < 0.5 && party < 0.5 && nearD ) {
		float course = floor( v / 0.55 );
		float qw = mod( course, 2.0 ) < 0.5 ? 0.75 : 0.45;
		float ce = min( s, L - s );
		float q = ( 1.0 - aStep( qw, ce, fwS ) ) * step( groundH * 0.5, v ) * step( v, H - topBand );
		float qj = fPulse( v / 0.55, 0.0, 0.04, fwV / 0.55 );
		wC = mix( wC, mix( trimC, baseC * 1.25, sChina ? 0.0 : 0.6 ) * ( 1.0 - 0.4 * qj ), q );
		wNT.y += q * qj * 0.6 * fine;
	}
	// Rusticated stone base.
	if ( argFlag( flags, 32.0 ) && v < groundH + floorH && !storefront ) {
		// The base storeys are dressed stone regardless of the upper material: rebuild the colour
		// (no inherited brick / ashlar joints) and cut deep horizontal channels.
		float j = fPulse( v / 0.6, 0.0, 0.08, fwV / 0.6 );
		wC = baseC * ( 0.94 + 0.12 * big ) * 1.04 * ( 1.0 - 0.45 * j );
		wNT = vec3( 0.0, ( fPulse( v / 0.6, 0.0, 0.04, fwV / 0.6 ) - fPulse( v / 0.6, 0.04, 0.08, fwV / 0.6 ) ) * 0.9 * fine, 1.0 );
		wAO *= 1.0 - 0.25 * j;
	}
	// Window surrounds / sills on punched-window styles.
	if ( !sCurtain && !sMidc && !sConcrete && !sParking && !sUtil && !storefront && fine > 0.001 ) {
		float tw = sHouse || sChina ? 0.13 : 0.1;
		float sur = aBox( fx, x0 - tw, x1 + tw, fwS ) * aBox( yIn, y0 - 0.16, y1 + tw, fwV ) * validF;
		sur = max( sur - openW, 0.0 ) * fine;
		vec3 surC = sPrewar || sHist ? wallC * 1.12 : trimC;
		wC = mix( wC, surC, sur );
		float sillM = aBox( fx, x0 - tw - 0.06, x1 + tw + 0.06, fwS ) * aBox( yIn, y0 - 0.16, y0 - 0.04, fwV ) * validF * fine;
		wC = mix( wC, surC * 1.05, sillM );
		wNT.y += sillM * 0.8;
		// Lintel shadow line.
		wAO *= 1.0 - 0.3 * aBox( yIn, y1 + tw - 0.03, y1 + tw, fwV ) * aBox( fx, x0 - tw, x1 + tw, fwS ) * validF * fine;
	}
	// Rain streaks: dirt washed off each sill runs down in long tapered streaks, through the spandrel
	// and on past the lintel of the window below (strongest under the sill ends).
	if ( !sCurtain && !ground && !storefront && validF > 0.0 ) {
		float dS = yIn < y0 ? y0 - yIn : ( yIn > y1 && fy + 1.0 < nf ? y0 + floorH - yIn : -1.0 );
		float colS = yIn < y0 ? flo : flo + 1.0;
		float len = 0.9 + 2.4 * h21( vec2( col + key, colS + seed ) );
		float under = aBox( fx, x0 - 0.06, x1 + 0.06, fwS ) * step( 0.0, dS ) * ( 1.0 - smoothstep( 0.0, len, dS ) );
		float sx = clamp( ( fx - x0 ) / max( x1 - x0, 0.1 ), 0.0, 1.0 );
		float ends = 0.55 + 0.45 * ( 1.0 - smoothstep( 0.0, 0.22, min( sx, 1.0 - sx ) ) );
		float st = detailLod > 0.01 ? smoothstep( 0.25, 0.75, vnoise( vec2( s * 8.0 + key, v * 0.4 + seed * 9.0 ) ) ) * detailLod + 0.45 * ( 1.0 - detailLod ) : 0.45;
		weather += under * st * ends * 0.55 * ( 0.35 + dirt );
	}
	// Top band (frieze / attic / parapet face).
	float topZ = aStep( H - topBand, v, fwV );
	if ( topZ > 0.0 ) {
		float tb = max( topBand, 0.5 );
		float rel = ( v - ( H - tb ) ) / tb; // 0 at the band bottom, 1 at the roofline
		vec3 tc = wallC * 0.97;
		if ( sCurtain ) tc = trimC;
		else if ( sMidc ) tc = baseC * 0.8;
		float frieze = aBox( v, H - tb + 0.12, H - tb + 0.12 + min( 0.45, tb * 0.35 ), fwV );
		float capLine = aStep( H - 0.14, v, fwV );
		// Frieze / cap line: wall-tone mouldings (Chinatown keeps a hint of painted trim).
		if ( !sCurtain && !sMidc ) tc = mix( tc, sChina ? mix( wallC * 0.88, trimC, 0.45 ) : wallC * 0.92, max( frieze, capLine ) );
		float mould = fPulse( rel, 0.55, 0.6, fwV / tb );
		tc *= 1.0 - 0.22 * mould;
		wC = mix( wC, tc, topZ );
		wNT.y += ( frieze * 0.25 + mould * 0.35 ) * fine * topZ;
	}
	// Rain wash below the roofline: streaky darkening.
	{
		float below = H - topBand - v;
		float wash = ( 1.0 - smoothstep( 0.0, 3.0 + 6.0 * vnoise( vec2( s * 0.9 + key, 3.7 ) ), below ) ) * step( 0.0, below );
		float st = nearD ? vnoise( vec2( s * 3.1 + key, v * 0.1 ) ) : 0.5;
		weather += wash * ( nearD ? smoothstep( 0.25, 0.8, st ) : 0.35 ) * 0.42 * ( 0.3 + dirt );
	}
	// Attic band between the last storey and the top band.
	float attic = aStep( groundH + nf * floorH, v, fwV ) * ( 1.0 - topZ );
	wC = mix( wC, wC * 0.97, attic );
	// Curtain wall / midcentury: "wall" is spandrel glass or panels between mullions.
	float mullion = 0.0;
	if ( sCurtain || sMidc ) {
		float mwid = max( ( mw - ww ) * 0.5, 0.04 );
		float mx = 1.0 - aBox( fx, mwid, mw - mwid, fwS );
		float tr = sCurtain && !ground ? aBox( yIn, y0 - 0.06, y0, fwV ) + aBox( yIn, y1, y1 + 0.06, fwV ) : 0.0;
		mullion = clamp( mx + tr, 0.0, 1.0 ) * ( 1.0 - topZ * 0.5 );
		if ( argFlag( flags, 16.0 ) ) mullion = max( mullion, 1.0 - aStep( 0.09, min( fx, mw - fx ), fwS ) );
	}

	// Diagonal-braced exoskeleton (e.g. the Alcoa Building): X braces spanning ~4 storeys per bay.
	float brace = 0.0;
	if ( argFlag( flags, 2048.0 ) && v > groundH && v < H - 0.5 ) {
		float bw = max( L / max( 1.0, floor( L / 11.0 + 0.5 ) ), 4.0 );
		vec2 bc = vec2( s / bw, ( v - groundH ) / ( floorH * 4.0 ) );
		vec2 fb = fract( bc );
		float dA = abs( fb.x - fb.y );
		float dB = abs( fb.x + fb.y - 1.0 );
		float wB = 0.75 / bw;
		float fwB = fwidth( bc.x ) * 1.2;
		brace = max( 1.0 - smoothstep( wB - fwB, wB + fwB, min( dA, dB ) ), 1.0 - smoothstep( wB - fwB, wB + fwB, min( fb.x, 1.0 - fb.x ) ) );
	}

	// ── Assemble wall ─────────────────────────────────────────────
	vec3 alb = wC;
	float rough = wallRough;
	float metal = wallMetal;
	vec3 nt = wNT;
	float glassy = 0.0; // spandrel glass reflectivity
	vec3 tintN = trimC / max( dot( trimC, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.005 );
	if ( sCurtain ) {
		// Coated spandrel glass: metal 0.9 with a ~0.2-luminance tint gives F0 ≈ 0.18 and ~0.02 diffuse.
		alb = mix( clamp( tintN * 0.2, 0.0, 1.0 ), baseC, mullion );
		rough = mix( 0.1, 0.35, mullion );
		metal = mix( 0.9, 0.85, mullion );
		glassy = 1.0 - mullion;
		vec2 sj = h22( vec2( col * 0.73 + key, floor( ( v - groundH ) / floorH ) * 1.9 + seed ) ) - 0.5;
		nt = mix( nt, normalize( vec3( sj * 0.03, 1.0 ) ), glassy );
	} else if ( sMidc ) {
		vec3 pan = mat < 3.5 ? trimC * ( 0.95 + 0.1 * big ) : trimC;
		alb = mix( pan, baseC, mullion );
		rough = mix( mat > 6.5 ? 0.4 : 0.6, 0.35, mullion );
		metal = mix( mat > 6.5 ? 0.3 : 0.0, 0.85, mullion );
	}
	// Ground floor treatments.
	if ( garage ) {
		float gw = sUtil ? 4.2 : 2.6;
		float gh = sUtil ? min( groundH - 0.6, 4.2 ) : 2.3;
		float gm = max( 1.0, floor( L / ( gw + 1.6 ) ) );
		float gcell = L / gm;
		float gfx = mod( s, gcell );
		float door = aBox( gfx, 0.5 * ( gcell - gw ), 0.5 * ( gcell + gw ), fwS ) * aBox( v, 0.0, gh, fwV ) * segOK;
		float panels = fPulse( v / 0.55, 0.0, 0.06, fwV / 0.55 );
		vec3 dc = ( sUtil ? vec3( 0.42, 0.44, 0.45 ) : mix( trimC, vec3( 0.75 ), 0.4 ) ) * ( 1.0 - 0.3 * panels );
		alb = mix( alb, dc, door );
		nt.y += door * ( fPulse( v / 0.55, 0.0, 0.03, fwV / 0.55 ) - fPulse( v / 0.55, 0.03, 0.06, fwV / 0.55 ) ) * 0.8 * fine;
		metal = mix( metal, 0.4, door );
		rough = mix( rough, 0.5, door );
	}
	// Storefront bulkhead (kick plate): black tile, painted panels or stone.
	if ( storefront && segOK > 0.5 ) {
		float bulk = aBox( fx, 0.28, mw - 0.28, fwS ) * ( 1.0 - aStep( y0, v, fwV ) ) * ( 1.0 - doorZone );
		float tb = h11( shopH * 5.9 );
		vec3 bcol = tb < 0.4 ? vec3( 0.045, 0.045, 0.05 ) : tb < 0.7 ? trimC * 0.7 : vec3( 0.5, 0.48, 0.44 );
		float pan = tb < 0.4 ? max( fPulse( fx / 0.3, 0.0, 0.03, fwS / 0.3 ), fPulse( v / 0.15, 0.0, 0.06, fwV / 0.15 ) ) : 1.0 - aBox( v, 0.1, y0 - 0.1, fwV ) * aBox( fx, 0.4, mw - 0.4, fwS );
		bcol *= 1.0 - 0.3 * pan * fine;
		alb = mix( alb, bcol, bulk );
		rough = mix( rough, tb < 0.4 ? 0.22 : 0.6, bulk );
		nt = mix( nt, normalize( nt + vec3( 0.0, pan * 0.3 * fine, 0.0 ) ), bulk );
	}
	weather = min( weather, 0.75 );
	alb = mix( alb, alb * vec3( 0.36, 0.33, 0.30 ), weather );
	rough = clamp( rough + weather * 0.2, 0.0, 1.0 );

	// Reveal (jamb) faces: wall material, in partial shadow.
	alb = mix( alb, wallC * 0.82 * ( 1.0 - weather ), jamb );
	nt = mix( nt, jambNT, jamb * fine );
	float ao = wAO * ( 1.0 - 0.35 * jamb );

	// ── Glass & interiors ────────────────────────────────────────
	vec3 emis = vec3( 0.0 );
	float roomSpan = occ < 0.5 && !storefront ? 3.0 : 1.0;
	float rcol = floor( col / roomSpan );
	float rh = h21( vec2( rcol + key * 17.0 + seed * 3.0, flo + seed * 311.0 ) );
	// Who is home: each window decides on its own, nudged by soft zones along the floor (open-plan
	// areas, flats) and per floor, against a lit fraction set by use and local hour.
	float wh = h21( vec2( col + key * 17.0, flo + seed * 311.0 ) + 0.37 );
	float closedness = 1.0 - smoothstep( 6.5, 9.0, uHour ) * ( 1.0 - smoothstep( 19.0, 23.0, uHour ) );
	float shopClosed = storefront && shopH < closedness * 0.85 ? 1.0 : 0.0;
	float lit;
	if ( storefront ) lit = 1.0;
	else {
		float frac = argLitFraction( occ, uHour ) * ( 0.6 + 0.8 * h11( seed * 91.7 + 0.3 ) );
		float zoneW = occ < 0.5 ? 5.0 : 2.5;
		float zn = vnoise( vec2( col / zoneW + key * 7.0 + seed * 13.0, flo * 0.45 + seed * 29.0 ) );
		float fn = h21( vec2( flo * 1.7 + 0.3, seed * 57.0 ) );
		lit = step( wh, frac * ( 0.45 + 1.1 * zn ) * ( 0.8 + 0.4 * fn ) );
	}
	lit *= lightsOn;
	if ( sParking ) lit = night * lightsOn;
	// Lamp brightness varies window to window (desk lamp vs. ceiling light, dimmers, curtains).
	float wI = occ < 0.5 ? 0.6 + 0.4 * h11( wh * 7.3 ) : 0.35 + 0.65 * h11( wh * 7.3 );
	float classI = storefront ? mix( 1.0, 0.1, shopClosed ) : wI * ( occ > 0.5 && occ < 1.5 ? 0.6 : occ > 1.5 && occ < 2.5 ? 0.72 : 0.8 );
	float litI = lit * uLightLevel * mix( storefront ? 0.04 : 0.06, 1.0, night ) * classI;
	vec3 lightC = argRoomLight( occ, wh );
	if ( storefront ) lightC = argKelvin( shopH < 0.35 ? 0.9 : shopH < 0.6 ? 0.05 : 0.45 );
	// Damage: blown-out windows.
	float dmg = vDyn.x;
	// Blown-out windows: ~8 % at slight, ~40 % moderate, ~70 % extensive, ~92 % complete.
	float brokenF = min( 0.92, 0.08 * dmg + 0.24 * max( dmg - 1.0, 0.0 ) ) * step( 0.5, dmg );
	float broken = step( h21( vec2( col * 3.1 + key, flo * 7.7 + seed ) ), brokenF );

	if ( glass > 0.001 ) {
		vec3 inter;
		float interF = fine * ( 1.0 - smoothstep( 160.0, 260.0, dist ) );
#ifdef ARG_CHEAP
		interF = 0.0;
#endif
		vec3 far = argRoomAverage( occ, rh, litI, lightC );
#ifdef ARG_CHEAP
		far *= 0.7;
#endif
		if ( sParking ) far = vec3( 0.03 ) * uDayLevel * 10.0 + vec3( 0.9, 0.95, 1.0 ) * litI * 0.25;
		inter = far;
		float blindsM = 0.0;
		if ( interF > 0.001 ) {
			float W = storefront ? mw : mw * roomSpan;
			float ox = storefront ? clamp( gx, 0.0, mw ) : clamp( gx, 0.0, mw ) + mod( col, roomSpan ) * mw;
			float Hr = storefront ? min( groundH - 0.2, 3.1 ) : floorH - 0.25; // shops: dropped ceiling
			float D = storefront ? 7.0 + 5.0 * rh : ( occ < 0.5 ? 6.0 + 6.0 * rh : 3.5 + 2.5 * rh );
			vec3 o = vec3( ox, clamp( gy, 0.02, Hr - 0.02 ), 0.0 );
			vec4 r = argInterior( o, d, W, Hr, D, occ, rh, litI, lightC, storefront ? 1.0 : 0.0 );
			vec3 near = r.rgb;
			if ( sParking ) near = far;
			// Blinds / curtains on the glass plane.
			if ( !storefront && !sParking ) {
				float bf = step( 0.45, h11( rh * 13.7 ) ) * ( 0.15 + 0.6 * h11( rh * 5.3 ) );
				float gyRel = ( gy - y0 ) / max( y1 - y0, 0.1 );
				blindsM = step( 1.0 - bf, gyRel );
				if ( occ > 0.5 && h11( rh * 3.3 ) > 0.5 ) {
					float gxRel = ( gx - x0 ) / max( x1 - x0, 0.1 );
					blindsM = max( blindsM, 1.0 - step( 0.18, gxRel ) * step( gxRel, 0.82 ) );
				}
				vec3 bc = occ < 0.5 ? vec3( 0.72, 0.72, 0.70 ) : mix( vec3( 0.78, 0.7, 0.55 ), vec3( 0.6, 0.25, 0.2 ), step( 0.75, h11( rh * 8.1 ) ) );
				float slats = occ < 0.5 ? 0.85 + 0.15 * step( 0.5, fract( gy / 0.05 ) ) : 1.0;
				vec3 blindRad = bc * slats * ( uDayLevel * ( 1.0 - night ) * 0.9 + lightC * litI * 0.7 );
				near = mix( near, blindRad, blindsM );
			}
			inter = mix( far, near, interF );
		}
		// Glass optics.
		float F = argFresnel( cosV );
		vec3 trans = mix( vec3( 1.0 ), clamp( glassC * 3.5, 0.0, 1.0 ), 0.55 );
		float clarity = sCurtain || sMidc ? 0.6 : 0.85;
		vec3 interRad = inter * trans * clarity * ( 1.0 - F );
		// Vision glass. Curtain walls: low-e coated (F0 ≈ 0.14); punched windows: clear float glass (F0 0.04).
		vec3 gTint = glassC / max( dot( glassC, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.005 );
		vec3 gAlb = sCurtain || sMidc ? clamp( gTint * 0.15, 0.0, 1.0 ) : glassC * 0.3;
		float gRough = 0.04 + dirt * 0.05;
		float gMetal = sCurtain || sMidc ? 0.86 : 0.0;
		// Frames, mullions, meeting rails (at the glass plane).
		float frame = 0.0;
		if ( fine > 0.001 && !sParking ) {
			float fw = storefront ? 0.07 : sCurtain ? 0.0 : 0.055;
			float inner = aBox( gx, x0 + fw, x1 - fw, fwS ) * aBox( gy, y0 + fw, y1 - fw, fwV );
			frame = 1.0 - inner;
			float gw = x1 - x0;
			if ( storefront ) {
				// Display window mullions every ~1.5 m, transom bar and small-paned transom lights above it.
				float nm = max( 2.0, floor( gw / 1.5 + 0.5 ) );
				float pw = gw / nm;
				float mxd = abs( fract( ( gx - x0 ) / pw + 0.5 ) - 0.5 ) * pw;
				frame = max( frame, 1.0 - aStep( 0.035, mxd, fwS ) );
				float tr = aStep( y1 - 0.45, gy, fwV );
				float tm = abs( fract( ( gx - x0 ) / 0.36 + 0.5 ) - 0.5 ) * 0.36;
				frame = max( frame, tr * ( 1.0 - aStep( 0.015, tm, fwS ) ) );
			} else if ( !sCurtain && gw > 1.3 ) frame = max( frame, 1.0 - aStep( 0.03, abs( gx - 0.5 * ( x0 + x1 ) ), fwS ) );
			if ( ( sChina || sHouse || sHist || sPrewar || abs( style - 6.0 ) < 0.5 ) && !storefront ) frame = max( frame, 1.0 - aStep( 0.028, abs( gy - ( y0 + ( y1 - y0 ) * 0.52 ) ), fwV ) );
			if ( storefront ) frame = max( frame, 1.0 - aStep( 0.04, abs( gy - ( y1 - 0.45 ) ), fwV ) );
			frame *= fine * glassM;
		}
		vec3 frameC = sChina || sHouse ? trimC : sCurtain || sMidc || sConcrete ? baseC * 0.7 : vec3( 0.12, 0.12, 0.11 );
		if ( storefront ) frameC = sChina && h11( shopH * 4.1 ) < 0.4 ? trimC * 0.8 : frameCol( shopH );
		if ( abs( style - 6.0 ) < 0.5 ) frameC = vec3( 0.85, 0.84, 0.8 );
		// Broken: dark void with ragged glass shards at the edges.
		float shard = 0.0;
		if ( broken > 0.5 ) {
			float e = min( min( gx - x0, x1 - gx ), min( gy - y0, y1 - gy ) );
			shard = step( e, 0.05 + 0.25 * vnoise( vec2( gx, gy ) * 9.0 ) );
			interRad = vec3( 0.004 ) * ( 1.0 - shard );
			gAlb = mix( vec3( 0.02 ), gAlb, shard );
			gRough = mix( 0.9, 0.2, shard );
		}
		float gl = glass * ( 1.0 - frame );
		if ( sParking ) {
			alb = mix( alb, vec3( 0.05 ), gl );
			rough = mix( rough, 0.95, gl );
			metal = mix( metal, 0.0, gl );
			emis += interRad * gl;
		} else {
			alb = mix( alb, gAlb, gl );
			rough = mix( rough, gRough, gl );
			metal = mix( metal, gMetal, gl );
			emis += interRad * gl;
			glassy = max( glassy, gl * ( 1.0 - broken * ( 1.0 - shard ) ) );
			alb = mix( alb, frameC, frame );
			rough = mix( rough, 0.45, frame );
			metal = mix( metal, sCurtain || sMidc ? 0.8 : 0.1, frame );
		}
		// Panes are never perfectly coplanar: a tiny per-pane tilt breaks up reflections pane by pane.
		vec2 pj = h22( vec2( col * 1.31 + key, flo * 2.17 + seed * 13.0 ) ) - 0.5;
		nt = mix( nt, normalize( vec3( pj * 0.035, 1.0 ) ), gl );
		ao = mix( ao, 1.0, gl );
	}

	// Closed shops at night: roll-down security shutters over the display window and the entry.
	if ( storefront && shopClosed > 0.5 && !modernSF && h11( shopH * 7.7 ) < 0.7 && segOK > 0.5 ) {
		float gate = aBox( fx, 0.28, mw - 0.28, fwS ) * ( 1.0 - aStep( y1 + 0.08, v, fwV ) );
		float rib = fPulse( v / 0.085, 0.0, 0.5, fwV / 0.085 );
		float gsel = h11( shopH * 3.1 );
		vec3 gcol = gsel < 0.65 ? vec3( 0.40, 0.41, 0.42 ) : gsel < 0.85 && sChina ? trimC * 0.75 : vec3( 0.16, 0.26, 0.2 );
		gcol *= ( 0.85 + 0.15 * rib ) * ( 1.0 - 0.35 * smoothstep( 0.45, 0.9, vnoise( vec2( fx * 1.5, v * 0.7 ) + seed * 5.0 ) ) * ( 0.4 + dirt ) );
		alb = mix( alb, gcol, gate );
		metal = mix( metal, 0.5, gate );
		rough = mix( rough, 0.5, gate );
		emis *= 1.0 - gate;
		glassy *= 1.0 - gate;
		ao = mix( ao, 1.0, gate );
		nt = mix( nt, normalize( vec3( 0.0, ( fPulse( v / 0.085, 0.0, 0.25, fwV / 0.085 ) - fPulse( v / 0.085, 0.25, 0.5, fwV / 0.085 ) ) * 0.5 * fine, 1.0 ) ), gate );
		doorZone *= 1.0 - gate;
	}
	// Recessed shop entry: a parallax box behind the facade plane with a glazed door at the back,
	// mosaic-tile floor, panelled side returns and a soffit light.
	if ( storefront && doorZone > 0.001 && fine > 0.001 && segOK > 0.5 ) {
		float zone = doorZone * fine;
		float Rd = 1.25;
		float k2 = Rd / max( cosV, 0.12 );
		float bx = fx + d.x * k2;
		float by = v + d.y * k2;
		float ox0 = dX0 - bx, ox1 = bx - dX1, oy0 = - by, oy1 = by - y1;
		float m = max( max( ox0, ox1 ), max( oy0, oy1 ) );
		vec3 shopRad = argRoomAverage( occ, rh, litI, lightC ) * 1.4;
		vec3 rc; vec3 rn = vec3( 0.0, 0.0, 1.0 ); vec3 re = vec3( 0.0 );
		float rao = 0.6; float rr = 0.6; float rm = 0.0;
		if ( m <= 0.0 ) {
			float dw = dX1 - dX0;
			float dfx = bx - dX0;
			float pane = aBox( dfx, 0.11, dw - 0.11, fwS * 2.0 ) * aBox( by, 0.3, y1 - 0.14, fwV * 2.0 );
			vec3 doorFrame = sChina ? trimC * 0.7 : frameCol( shopH );
			rc = mix( doorFrame, glassC * 0.25, pane );
			re = shopRad * pane * ( 1.0 - argFresnel( cosV ) );
			rr = mix( 0.45, 0.06, pane );
			rm = mix( 0.3, 0.0, pane );
			rao = 0.8;
			float bar = aBox( by, 0.98, 1.05, fwV ) * aBox( dfx, 0.16, dw - 0.16, fwS );
			rc = mix( rc, vec3( 0.6, 0.55, 0.45 ), bar );
			rm = mix( rm, 0.9, bar );
			re *= 1.0 - bar;
		} else if ( m == oy0 ) {
			float tF = - v / min( d.y, -1e-3 );
			vec2 q = vec2( fx + d.x * tF, d.z * tF ) / 0.06;
			float lodT = 1.0 - smoothstep( 0.015, 0.04, fwS );
			float ck = mix( 0.5, mod( floor( q.x ) + floor( q.y ), 2.0 ), lodT );
			rc = mix( vec3( 0.72, 0.7, 0.66 ), vec3( 0.18, 0.24, 0.26 ), ck * 0.4 + 0.1 );
			rn = vec3( 0.0, 1.0, 0.0 );
			rao = 0.5;
			rr = 0.45;
		} else if ( m == oy1 ) {
			rc = trimC * 0.3;
			rn = vec3( 0.0, -1.0, 0.0 );
			rao = 0.45;
			re = lightC * litI * 0.5 * night;
		} else {
			// Side returns: polished dark panelling with a glazed upper half catching a little shop light.
			rc = mix( vec3( 0.06, 0.05, 0.045 ), glassC * 0.25, step( 0.9, by ) );
			rn = m == ox0 ? vec3( 1.0, 0.0, 0.2 ) : vec3( -1.0, 0.0, 0.2 );
			re = shopRad * 0.12 * step( 0.9, by ) * ( 0.5 + 0.5 * smoothstep( 0.9, y1, by ) );
			rao = 0.5;
			rr = 0.2;
		}
		alb = mix( alb, rc, zone );
		emis = mix( emis, re, zone );
		rough = mix( rough, rr, zone );
		metal = mix( metal, rm, zone );
		nt = mix( nt, normalize( rn ), zone );
		ao = mix( ao, rao, zone );
		glassy *= 1.0 - zone;
	}

	// Storefront sign band & night glow.
	if ( storefront && segOK > 0.5 && !( sCurtain || sConcrete || sMidc || sPrewar ) ) {
		float band = aBox( v, groundH - 0.95, groundH - 0.2, fwV ) * aBox( sfx, 0.3, smw - 0.3, fwS );
		float sh = h21( vec2( scol + key * 3.0, seed * 7.0 ) );
		vec3 sc = sh < 0.3 ? vec3( 0.55, 0.06, 0.04 ) : sh < 0.5 ? vec3( 0.75, 0.55, 0.08 ) : sh < 0.65 ? vec3( 0.06, 0.25, 0.12 ) : sh < 0.8 ? vec3( 0.04, 0.04, 0.04 ) : accent;
		float cell = 0.62;
		vec2 guv = vec2( fract( ( sfx - 0.3 ) / cell ), ( v - ( groundH - 0.95 ) ) / 0.75 );
		float glyphOK = step( 0.35, sh ) + ( sChina ? 1.0 : 0.0 );
		float txt = argGlyph( guv, floor( ( sfx - 0.3 ) / cell ) + scol * 13.0 + seed * 100.0 ) * step( 0.5, glyphOK );
		if ( !sChina ) txt = aBox( guv.y, 0.35, 0.62, fwV / 0.75 ) * step( 0.2, fract( ( sfx - 0.3 ) / 0.33 ) ) * aBox( sfx, 1.0, smw - 1.0, fwS );
		float txtLod = 1.0 - smoothstep( 0.03, 0.1, fwS );
		txt *= txtLod;
		vec3 tc = sh < 0.3 || sh > 0.65 ? vec3( 0.95, 0.78, 0.25 ) : vec3( 0.95, 0.92, 0.85 );
		alb = mix( alb, mix( sc, tc, txt + ( 1.0 - txtLod ) * 0.2 ), band );
		rough = mix( rough, 0.5, band );
		metal = mix( metal, 0.0, band );
		float neon = step( sChina ? 0.25 : 0.6, h11( sh * 17.0 ) ) * lightsOn;
		vec3 nc = sh < 0.3 ? vec3( 1.0, 0.06, 0.04 ) : sh < 0.55 ? vec3( 1.0, 0.42, 0.04 ) : sh < 0.75 ? vec3( 0.08, 1.0, 0.3 ) : vec3( 1.0, 0.1, 0.45 );
		emis += band * night * neon * ( txt * nc * 3.2 + sc * 0.5 );
	}

	// Street-lamp spill on the lower storeys of street frontages at night (sodium / LED mix).
	if ( street > 0.5 && night > 0.01 ) {
		float spill = ( 1.0 - smoothstep( 1.0, 11.0, gH ) ) * ( 0.7 + 0.3 * vnoise( vec2( s * 0.15 + key, 0.5 ) ) );
		emis += alb * mix( vec3( 1.0, 0.62, 0.3 ), vec3( 0.95, 0.9, 0.8 ), step( 0.5, h11( key ) ) ) * spill * night * 0.22 * ( 1.0 - glass * 0.7 );
	}
	// Floodlit facades at night (warm uplight from the base, crown wash).
	if ( argFlag( flags, 256.0 ) ) {
		// Fixtures every ~7 m along the base throw scalloped cones upward; a second row washes the crown.
		float fxs = fract( s / 7.0 + key ) - 0.5;
		float cone = exp( - fxs * fxs * 9.0 );
		float hb = max( v - groundH, 0.0 );
		float up = cone * exp( - hb / 22.0 ) * ( 1.0 - exp( - hb / 1.5 ) ) + 0.5 * cone * smoothstep( H - topBand - 10.0, H - topBand, v ) * ( 1.0 - smoothstep( H - 1.0, H, v ) );
		emis += alb * vec3( 1.0, 0.76, 0.48 ) * up * night * 2.2 * ( 1.0 - glassy ) * lightsOn;
	}

	// ── Earthquake damage ─────────────────────────────────────────
	// Two layers: a fine crack network for close views, and bold macro cues (1–8 m features) that stay
	// legible from a helicopter 150–250 m away, escalating with the HAZUS state:
	//   1 slight     a few dark (broken) windows, light dust streaks
	//   2 moderate   blackened / spalled patches, stepped diagonal cracks, ~40 % windows out, parapet notches
	//   3 extensive  gaping facade losses with exposed floor slabs, soot plumes, most windows out
	//   4 complete   heavier still + the soft (ground) storey pancaked (vertex stage, argSoftK / argSoftH)
	if ( dmg > 0.02 ) {
		float ds = clamp( dmg, 0.0, 4.0 );
		float pxM = max( max( fwS, fwV ), 1e-4 ); // metres per pixel
		float wallOnly = 1.0 - glass;
		// Crack network: jagged Voronoi borders; each border (cell pair) activates independently.
		vec2 cp = vec2( s + key * 7.0, v ) * 0.42;
		// Fine jaggedness (not big wiggles): cracks stay mostly straight between branch points.
		cp += ( vec2( vnoise( cp * 9.0 ), vnoise( cp * 9.0 + 9.2 ) ) - 0.5 ) * 0.07 + ( vec2( vnoise( cp * 1.3 ), vnoise( cp * 1.3 + 4.1 ) ) - 0.5 ) * 0.25;
		vec2 ip = floor( cp );
		vec2 fq = fract( cp );
		float d1 = 8.0, d2 = 8.0;
		vec2 id1 = ip, id2 = ip;
		for ( int j = -1; j <= 1; j ++ ) for ( int i = -1; i <= 1; i ++ ) {
			vec2 g = vec2( float( i ), float( j ) );
			vec2 r = g + h22( ip + g ) - fq;
			float dd = dot( r, r );
			if ( dd < d1 ) { d2 = d1; id2 = id1; d1 = dd; id1 = ip + g; } else if ( dd < d2 ) { d2 = dd; id2 = ip + g; }
		}
		float edgeM = ( sqrt( d2 ) - sqrt( d1 ) ) * 0.5 / 0.42;
		vec2 pk = id1 + id2;
		vec2 pd = abs( id1 - id2 );
		float act = step( h21( vec2( pk.x + pk.y * 7.13, pd.x * 3.1 + pd.y * 1.7 ) + seed ), 0.05 + 0.075 * ds );
		float wM = 0.0025 + 0.004 * ds;          // crack half-width (m)
		float wD = max( wM, pxM * 0.5 );
		float cov = clamp( wM / pxM, 0.0, 1.0 ); // thinner than a pixel → fainter, never fatter
		float crack = ( 1.0 - smoothstep( wD * 0.5, wD * 1.5, edgeM ) ) * cov * act;
		crack *= smoothstep( 0.2, 1.0, ds + vnoise( cp * 0.31 ) - 0.5 );
		// Big stepped diagonal (shear) cracks running across several storeys (moderate+): 8–25 cm wide, so
		// they survive as dark lines at ~0.3 m / pixel.
		if ( ds > 1.4 ) {
			vec2 dq = vec2( s + key * 11.0, v );
			float P = 7.5;
			float sg = h21( floor( vec2( dq.x / ( 2.0 * P ), dq.y / ( 2.0 * P ) ) ) + seed ) > 0.5 ? 1.0 : -1.0;
			float u = ( dq.x + sg * dq.y ) / P + 0.35 * ( vnoise( dq * 0.9 ) - 0.5 ) + 0.12 * ( vnoise( dq * 3.7 ) - 0.5 );
			vec2 cell = floor( vec2( u, ( dq.x - sg * dq.y ) / ( 1.6 * P ) ) );
			float on = step( h21( cell + seed * 3.0 ), 0.12 + 0.16 * ( ds - 1.4 ) );
			float dl = abs( fract( u ) - 0.5 ) * P * 0.7071;
			float wB = 0.08 + 0.05 * ( ds - 1.4 );
			float wBD = max( wB, pxM * 0.5 );
			float bigC = ( 1.0 - smoothstep( wBD * 0.5, wBD * 1.5, dl ) ) * clamp( wB / pxM, 0.0, 1.0 ) * on;
			crack = max( crack, bigC * smoothstep( 1.4, 1.9, ds ) );
		}
		crack *= wallOnly;

		// Dust staining: light streaks washing down the wall (slight+, strongest at slight / moderate).
		float streak = smoothstep( 0.45, 0.85, vnoise( vec2( ( s + key * 5.0 ) * 0.7, v * 0.06 + seed ) ) );
		float stain = streak * smoothstep( 0.2, 1.0, ds ) * 0.32 * ( 0.6 + 0.4 * vnoise( fp * 0.3 ) );
		alb = mix( alb, vec3( 0.60, 0.57, 0.52 ), stain * mix( 1.0, 0.4, glass ) );

		// Blackened / spalled patches (moderate+): 2–6 m blobs, soot-dark core over exposed brick / concrete.
		vec2 mp = vec2( s + key * 23.0, v );
		float pn = fbm3( mp * vec2( 0.21, 0.27 ) + seed * 17.0 );
		float thrP = 0.76 - 0.06 * ds; // ~12 % of the wall at moderate, ~20 % extensive, ~30 % complete
		float spall = smoothstep( thrP, thrP + 0.025, pn ) * smoothstep( 1.4, 1.9, ds );
		float rim = ( smoothstep( thrP - 0.05, thrP, pn ) ) * smoothstep( 1.4, 1.9, ds ) * ( 1.0 - spall );
		vec3 structC = mat < 1.5 ? vec3( 0.20, 0.10, 0.065 ) : vec3( 0.24, 0.23, 0.21 );
		float soot = smoothstep( thrP + 0.04, thrP + 0.12, pn );
		vec3 spallC = mix( structC * ( 0.75 + 0.5 * vnoise( fp * 2.0 ) ), vec3( 0.03, 0.028, 0.026 ), soot * 0.85 );

		// Gaping facade losses (extensive+): the skin has fallen off whole bays — a dark void with the floor
		// slab edges and the cut ends of walls showing. Moderate only loses parapet / cornice chunks at the top.
		float hn = fbm3( mp * vec2( 0.13, 0.17 ) + seed * 31.0 + 5.0 );
		float topZ = smoothstep( H - topBand - 2.5, H - 0.3, v );
		float thrH = mix( 0.8, 0.56, smoothstep( 2.4, 4.0, ds ) ) - 0.16 * topZ * smoothstep( 1.5, 2.2, ds );
		float hole = smoothstep( thrH, thrH + 0.02, hn + 0.06 * vnoise( mp * 1.7 ) ) * smoothstep( 1.5, 2.0, ds );
		hole *= ds < 2.5 ? topZ : 1.0;
		float holeRim = smoothstep( thrH - 0.035, thrH, hn ) * ( 1.0 - hole ) * smoothstep( 1.5, 2.0, ds );
		// Inside the void: storey slabs (pale broken edges) every floor, deep shadow between them.
		float slabY = fract( ( v - groundH ) / floorH );
		float slab = ( 1.0 - smoothstep( 0.0, max( 0.3 / floorH, fwV / floorH ), slabY ) ) * step( groundH, v );
		vec3 voidC = mix( vec3( 0.012, 0.011, 0.010 ), vec3( 0.42, 0.40, 0.37 ) * ( 0.7 + 0.5 * vnoise( mp * 3.0 ) ), slab * 0.9 );
		// A few rubble-choked bays show debris heaped on the slab.
		voidC = mix( voidC, vec3( 0.30, 0.27, 0.23 ) * ( 0.6 + 0.6 * vnoise( mp * 4.0 ) ), step( 0.75, slabY ) * step( 0.6, vnoise( mp * 0.5 + 3.0 ) ) * 0.8 );

		// Dust coating (patchy, never a uniform whitewash that would read as a clean, intact wall).
		float dust = clamp( ds * 0.06, 0.0, 0.2 ) * ( 0.3 + 0.7 * vnoise( fp * 0.45 ) );
		alb = mix( alb, vec3( 0.52, 0.49, 0.45 ), dust * mix( 1.0, 0.35, glass ) );
		// General grime / desaturation of a battered building.
		alb *= 1.0 - 0.05 * ds;
		alb = mix( alb, vec3( dot( alb, vec3( 0.3, 0.55, 0.15 ) ) ), 0.08 * ds );
		alb = mix( alb, vec3( 0.025 ), crack );
		alb *= 1.0 - 0.35 * rim - 0.45 * holeRim;
		alb = mix( alb, spallC, spall );
		ao *= 1.0 - 0.6 * crack - 0.25 * spall;
		rough = mix( rough, 1.0, max( dust, max( spall, hole ) ) );
		metal *= 1.0 - max( dust, max( spall, hole ) );
		glassy *= ( 1.0 - dust * 0.6 ) * ( 1.0 - spall ) * ( 1.0 - hole );
		emis *= ( 1.0 - dust * 0.5 ) * ( 1.0 - spall ) * ( 1.0 - hole );
		// Soot licking up from gutted windows (extensive+, more with complete damage).
		if ( ds > 2.5 && !ground ) {
			float sw = step( h21( vec2( col + key, flo ) + 0.7 ), 0.12 + 0.22 * ( ds - 2.5 ) );
			float xc = 0.5 * ( x0 + x1 );
			float hgt = ( yIn - y1 ) / ( floorH * 0.8 );
			float width = ( x1 - x0 ) * 0.5 * ( 1.0 - 0.6 * clamp( hgt, 0.0, 1.0 ) ) + 0.15 * vnoise( vec2( fx, v ) * 2.0 );
			float plume = step( 0.0, hgt ) * ( 1.0 - smoothstep( 0.4, 1.0, hgt ) ) * ( 1.0 - smoothstep( width * 0.7, width, abs( fx - xc ) ) );
			alb = mix( alb, vec3( 0.03 ), max( plume, glass ) * sw * 0.85 );
			glassy *= 1.0 - sw * glass;
		}
		alb = mix( alb, voidC, hole );
		nt = mix( nt, vec3( 0.0, 0.0, 1.0 ), hole );
		ao *= 1.0 - 0.5 * hole;
		// Pancaked soft storey (complete, standing): the ground storey is crushed to a ragged dark band of
		// broken storefronts, slabs and rubble (geometry squashed in argDeform).
		float ssK = argSoftK( ds, vDyn.z );
		if ( ssK > 0.001 ) {
			float gh = argSoftH( H );
			float band = ( 1.0 - aStep( gh + 0.5 * ( vnoise( vec2( s * 0.8 + key, 1.0 ) ) - 0.3 ), v, fwV ) ) * ssK;
			float rub = vnoise( vec2( s, v ) * 1.3 + key );
			vec3 bandC = mix( vec3( 0.015 ), vec3( 0.36, 0.33, 0.29 ) * ( 0.7 + 0.5 * rub ), smoothstep( 0.45, 0.6, rub ) );
			bandC = mix( bandC, vec3( 0.45, 0.43, 0.40 ), ( 1.0 - smoothstep( 0.0, 0.25, abs( v - gh * 0.55 ) ) ) * 0.8 );
			alb = mix( alb, bandC, band );
			emis *= 1.0 - band;
			glassy *= 1.0 - band;
			nt = mix( nt, vec3( 0.0, 0.0, 1.0 ), band );
		}
		// Collapsed: everything reads as broken, dusty rubble.
		float crush = vDyn.z;
		alb = mix( alb, vec3( 0.42, 0.40, 0.37 ) * ( 0.6 + 0.5 * vnoise( fp * 1.5 ) ), smoothstep( 0.2, 0.6, crush ) );
		emis *= 1.0 - smoothstep( 0.1, 0.4, crush );
		glassy *= 1.0 - smoothstep( 0.1, 0.4, crush );
	}

	if ( brace > 0.0 ) {
		alb = mix( alb, baseC * 1.2, brace );
		rough = mix( rough, 0.5, brace );
		metal = mix( metal, 0.6, brace );
		glassy *= 1.0 - brace;
		emis *= 1.0 - brace;
		nt = mix( nt, vec3( 0.0, 0.0, 1.0 ), brace );
	}
	fAlbedo = alb;
	fRough = rough;
	fMetal = metal;
	fNT = normalize( nt );
	fEmis = emis;
	fAO = ao;
	fGlass = glassy;

	// ── Overlays & selection ─────────────────────────────────────
	vec4 ovl = argOverlay( bi );
	if ( uDamageOverlay > 0.5 ) {
		vec3 rc = argDamageRamp( dmg );
		fAlbedo = mix( fAlbedo, rc, 0.9 );
		fEmis = mix( fEmis, rc * 0.3, 0.9 );
		fMetal *= 0.1;
		fGlass *= 0.1;
	} else if ( ovl.a > 1.5 ) {
		fAlbedo = mix( fAlbedo, ovl.rgb, 0.78 );
		fEmis = mix( fEmis, ovl.rgb * 0.18, 0.8 );
		fMetal *= 0.2;
		fGlass *= 0.2;
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
		float fres = pow( 1.0 - cosV, 2.5 );
		float edge = max( 1.0 - aStep( 0.3, cornerD, fwS * 1.5 ), 1.0 - aStep( 0.3, H - v, fwV * 1.5 ) );
		float pulse = 0.85 + 0.15 * sin( uTime * 3.0 );
		fEmis += vec3( 1.0, 0.42, 0.06 ) * ( fres * 1.4 + edge * 5.0 + 0.05 ) * pulse;
		fAlbedo = mix( fAlbedo, vec3( 1.0, 0.55, 0.2 ), 0.12 );
	}
}
`;
