/**
 * Noise-free soft shadows. three r186's PCF path takes 5 Vogel-disk taps rotated by interleaved
 * gradient noise, which reads as grain on large flat façades without TAA. We swap it (at import
 * time, before any material compiles) for a 4×4 grid of hardware-filtered (bilinear PCF) taps:
 * smooth penumbrae, no per-pixel noise. Only the directional/spot PCF function is changed.
 */
import * as THREE from 'three';

const NOISY_START = 'float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;';
const NOISY_END = ') * 0.2;';

const SMOOTH = `// Argus: 4x4 grid of bilinear PCF taps (smooth, no noise).
				float stepUv = max( radius.x, texelSize.x ) * 0.5; // Flytake: radius is a vec2 since three r187
				shadow = 0.0;
				for ( int sx = 0; sx < 4; sx ++ ) {
					for ( int sy = 0; sy < 4; sy ++ ) {
						vec2 o = ( vec2( float( sx ), float( sy ) ) - 1.5 ) * stepUv;
						shadow += texture( shadowMap, vec3( shadowCoord.xy + o, shadowCoord.z ) );
					}
				}
				shadow *= 0.0625;`;

let done = false;

export function installSmoothShadows(): boolean {
  if (done) return true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const src = chunks.shadowmap_pars_fragment;
  const a = src.indexOf(NOISY_START);
  const b = a >= 0 ? src.indexOf(NOISY_END, a) : -1;
  if (a < 0 || b < 0 || b - a > 900) {
    console.warn('[engine] shadow filter patch: PCF chunk changed, keeping three default');
    return false;
  }
  // Replace only the first occurrence (the directional/spot getShadow).
  chunks.shadowmap_pars_fragment = src.slice(0, a) + SMOOTH + src.slice(b + NOISY_END.length);
  done = true;
  return true;
}

installSmoothShadows();
