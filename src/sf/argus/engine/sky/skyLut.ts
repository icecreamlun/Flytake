/**
 * Sky-View LUT: a small lat-long HDR texture of single-scattered sky radiance (+ isotropic multiple
 * scattering, moonlight, night airglow and city light-pollution glow) for the current sun / moon.
 * Baked on the GPU only when time of day or haze changes. The sky dome, the PMREM environment
 * (hence glass + water reflections) and the aerial-perspective fog all derive from it.
 *
 * Mapping: u = azimuth clockwise from north (wraps), v = 0.5 + 0.5·sign(e)·sqrt(|e|/(π/2)) so texels
 * concentrate around the horizon where the sky changes fastest.
 */
import * as THREE from 'three';
import { ATMOSPHERE_GLSL } from './atmosphere';

export const LUT_W = 256;
export const LUT_H = 128;

/** GLSL helpers shared by every shader that samples the LUT. */
export const SKY_LUT_GLSL = /* glsl */ `
vec2 skyLutUv( vec3 d ) {
	float az = atan( d.x, - d.z );
	float e = asin( clamp( d.y, - 1.0, 1.0 ) );
	float v = 0.5 + 0.5 * sign( e ) * sqrt( abs( e ) / 1.5707963 );
	return vec2( fract( az / 6.28318530718 + 1.0 ), v );
}
vec3 skyLutDir( vec2 uv ) {
	float az = uv.x * 6.28318530718;
	float s = uv.y * 2.0 - 1.0;
	float e = sign( s ) * s * s * 1.5707963;
	return vec3( sin( az ) * cos( e ), sin( e ), - cos( az ) * cos( e ) );
}
`;

const BAKE_FRAG = /* glsl */ `
precision highp float;
uniform float uMieScale;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uMoonE;
uniform vec3 uGlow;
uniform vec3 uNightSky;
uniform vec3 uGroundAlbedo;
varying vec2 vUv;
${ATMOSPHERE_GLSL}
${SKY_LUT_GLSL}

// In-scattered radiance along a view ray for a light of unit illuminance from direction L.
vec3 inscatter( vec3 ro, vec3 rd, float tMax, vec3 L, out vec3 viewT ) {
	const int N = 32;
	float cosT = dot( rd, L );
	float pR = atmPhaseR( cosT );
	float pM = atmPhaseM( cosT, ATM_MIE_G );
	vec3 sum = vec3( 0.0 );
	vec3 od = vec3( 0.0 );
	float tPrev = 0.0;
	for ( int i = 0; i < N; i ++ ) {
		float f = ( float( i ) + 1.0 ) / float( N );
		float t = tMax * f * f;
		float dt = t - tPrev;
		float tm = 0.5 * ( t + tPrev );
		tPrev = t;
		vec3 p = ro + rd * tm;
		float h = max( length( p ) - ATM_RG, 0.0 );
		vec3 ext = atmExtinction( h, uMieScale );
		vec3 Tv = exp( - ( od + ext * dt * 0.5 ) );
		od += ext * dt;
		vec3 Ts = atmSunTransmittance( p, L, uMieScale );
		float sR = exp( - h / ATM_RAY_H );
		float sM = exp( - h / ATM_MIE_H ) * uMieScale * ATM_MIE_S;
		vec3 scR = ATM_RAY * sR;
		vec3 sc = scR * pR + vec3( sM * pM ) + ( scR + vec3( sM ) ) * ( ATM_MS * 0.0795775 );
		sum += Tv * sc * Ts * dt;
	}
	viewT = exp( - od );
	return sum;
}

void main() {
	vec3 rd = normalize( skyLutDir( vUv ) );
	vec3 ro = vec3( 0.0, ATM_RG + ATM_VIEW_H, 0.0 );
	float tTop = atmRaySphereFar( ro, rd, ATM_RT );
	float tG = atmRayGround( ro, rd );
	float tMax = tG > 0.0 ? tG : tTop;
	vec3 viewT;
	vec3 L = inscatter( ro, rd, tMax, uSunDir, viewT );
	if ( uMoonE > 0.0 && uMoonDir.y > - 0.2 ) {
		vec3 vt2;
		L += uMoonE * inscatter( ro, rd, tMax, uMoonDir, vt2 );
	}
	if ( tG > 0.0 ) {
		// Ground seen below the horizon: Lambertian albedo lit by the transmitted sun + a sky term.
		vec3 pg = ro + rd * tG;
		vec3 up = normalize( pg );
		vec3 Ts = atmSunTransmittance( pg, uSunDir, uMieScale );
		vec3 E = Ts * max( dot( up, uSunDir ), 0.0 ) + vec3( 0.06, 0.08, 0.11 ) * clamp( uSunDir.y * 4.0 + 0.3, 0.0, 1.0 );
		L += viewT * uGroundAlbedo * E * 0.31831;
	}
	float e = asin( clamp( rd.y, - 1.0, 1.0 ) );
	// Twilight: single scattering + our cheap multiple-scattering term under-estimate the blue
	// light that the sunlit upper atmosphere scatters into the zenith / anti-solar sky (real dusk
	// zeniths are deep blue, not mauve). Re-tint toward blue there, keeping luminance.
	{
		float tw = smoothstep( 0.06, - 0.06, uSunDir.y );
		float toward = smoothstep( - 0.2, 0.9, dot( normalize( rd.xz + 1e-5 ), normalize( uSunDir.xz + 1e-5 ) ) ) * smoothstep( - 0.3, - 0.04, uSunDir.y );
		// Keep the warm band low over the sunset horizon; everything else goes blue.
		float away = smoothstep( 0.0, 0.25, max( e, 0.0 ) + ( 1.0 - toward ) * 0.12 ) * ( 1.0 - 0.6 * toward * ( 1.0 - smoothstep( 0.1, 0.5, e ) ) );
		float lum = dot( L, vec3( 0.2126, 0.7152, 0.0722 ) );
		L = mix( L, lum * vec3( 0.36, 0.74, 2.1 ), tw * away * 0.9 );
	}
	// Night airglow + scattered city light (light pollution) concentrated at the horizon.
	float above = max( e, 0.0 );
	L += uNightSky * ( 0.35 + 0.65 * exp( - above * 2.2 ) );
	float az = atan( rd.x, - rd.z );
	// Brighter over land (SF west/south, Oakland east), darker toward Marin / the Golden Gate (north-west).
	float landMod = 0.55 + 0.45 * smoothstep( - 0.2, 0.9, cos( az - 2.0 ) ) + 0.25 * smoothstep( 0.3, 1.0, cos( az - 1.35 ) );
	L += uGlow * landMod * ( exp( - above / 0.045 ) * 0.82 + exp( - above / 0.22 ) * 0.18 ) * ( e < 0.0 ? 0.6 : 1.0 );
	gl_FragColor = vec4( L, 1.0 );
}
`;

export interface SkyLutParams {
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  /** Moon illuminance relative to the sun (artistic). */
  moonE: number;
  mieScale: number;
  glow: THREE.Color;
  nightSky: THREE.Color;
}

export class SkyLut {
  readonly target: THREE.WebGLRenderTarget;
  readonly texture: THREE.Texture;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly pixels = new Uint16Array(LUT_W * LUT_H * 4);
  /** Decoded LUT (linear radiance per unit solar illuminance), RGB floats, row-major from v=0. */
  readonly data = new Float32Array(LUT_W * LUT_H * 3);

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    this.texture = this.target.texture;
    this.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMieScale: { value: 1 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uMoonE: { value: 0 },
        uGlow: { value: new THREE.Color(0, 0, 0) },
        uNightSky: { value: new THREE.Color(0, 0, 0) },
        uGroundAlbedo: { value: new THREE.Color(0.09, 0.1, 0.1) },
      },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
      fragmentShader: BAKE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
  }

  /** Re-bake the LUT on the GPU. If `readback`, also decode it to `data` for CPU-side lighting. */
  bake(p: SkyLutParams, readback: boolean): void {
    const u = this.material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(p.sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(p.moonDir);
    u.uMoonE.value = p.moonE;
    u.uMieScale.value = p.mieScale;
    (u.uGlow.value as THREE.Color).copy(p.glow);
    (u.uNightSky.value as THREE.Color).copy(p.nightSky);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.setRenderTarget(this.target);
    r.render(this.quad, this.cam);
    if (readback) {
      r.readRenderTargetPixels(this.target, 0, 0, LUT_W, LUT_H, this.pixels);
      const px = this.pixels;
      const out = this.data;
      const h2f = THREE.DataUtils.fromHalfFloat;
      for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
        out[j] = h2f(px[i]);
        out[j + 1] = h2f(px[i + 1]);
        out[j + 2] = h2f(px[i + 2]);
      }
    }
    r.setRenderTarget(prev);
    r.xr.enabled = prevXr;
  }

  /** Bilinear CPU sample of the decoded LUT for a world direction. */
  sample(dir: THREE.Vector3, target = new THREE.Color()): THREE.Color {
    const az = Math.atan2(dir.x, -dir.z);
    const e = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    const u = (((az / (Math.PI * 2) + 1) % 1) + 1) % 1;
    const v = 0.5 + 0.5 * Math.sign(e) * Math.sqrt(Math.abs(e) / (Math.PI / 2));
    const fx = u * LUT_W - 0.5;
    const fy = THREE.MathUtils.clamp(v * LUT_H - 0.5, 0, LUT_H - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const xa = ((x0 % LUT_W) + LUT_W) % LUT_W;
    const xb = (xa + 1) % LUT_W;
    const ya = y0;
    const yb = Math.min(y0 + 1, LUT_H - 1);
    const d = this.data;
    const idx = (x: number, y: number) => (y * LUT_W + x) * 3;
    const r = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = d[idx(xa, ya) + c] * (1 - tx) + d[idx(xb, ya) + c] * tx;
      const b = d[idx(xa, yb) + c] * (1 - tx) + d[idx(xb, yb) + c] * tx;
      r[c] = a * (1 - ty) + b * ty;
    }
    return target.setRGB(r[0], r[1], r[2]);
  }

  /** Cosine-weighted irradiance on an up-facing surface from the decoded LUT (per unit solar E). */
  irradianceUp(target = new THREE.Color()): THREE.Color {
    let r = 0;
    let g = 0;
    let b = 0;
    const d = this.data;
    const dPhi = (Math.PI * 2) / LUT_W;
    for (let y = LUT_H / 2; y < LUT_H; y++) {
      const v0 = y / LUT_H;
      const v1 = (y + 1) / LUT_H;
      const el = (v: number) => {
        const s = v * 2 - 1;
        return Math.sign(s) * s * s * (Math.PI / 2);
      };
      const e0 = el(v0);
      const e1 = el(v1);
      // ∫ sin(e) cos(e) de over the row = (sin²e1 − sin²e0)/2, times dφ.
      const w = ((Math.sin(e1) ** 2 - Math.sin(e0) ** 2) / 2) * dPhi;
      for (let x = 0; x < LUT_W; x += 2) {
        const i = (y * LUT_W + x) * 3;
        r += d[i] * w * 2;
        g += d[i + 1] * w * 2;
        b += d[i + 2] * w * 2;
      }
    }
    return target.setRGB(r, g, b);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
