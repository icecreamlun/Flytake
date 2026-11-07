/**
 * Post-processing chain (pmndrs postprocessing + n8ao), HDR half-float throughout:
 *   RenderPass → N8AO (half-res, depth-aware upsampling) → EffectPass[bay reflections (SSR)]
 *   → EffectPass[bloom, white balance, tone mapping, grade, vignette]
 *   → EffectPass[SMAA] (edge detection on display-referred colour, where it works best).
 */
import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  EdgeDetectionMode,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { WaterReflectionEffect } from './waterReflection';

const GRADE_FRAG = /* glsl */ `
uniform float uSaturation;
uniform float uToe;
uniform float uShoulder;
uniform float uPivot;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uLift;

void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
	vec3 c = inputColor.rgb;
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	// Split toning (weights fade in the mid-tones).
	float hs = smoothstep( 0.0, 0.55, l );
	c *= mix( uShadowTint, uHighlightTint, hs );
	// Filmic contrast after AgX, in a perceptual-ish space: a power toe below the pivot (deeper,
	// cleaner shadows — AgX alone reads milky) and a gentle power shoulder above it.
	vec3 g = pow( max( c, 0.0 ), vec3( 1.0 / 2.2 ) );
	vec3 lo = uPivot * pow( g / uPivot, vec3( uToe ) );
	vec3 hi = 1.0 - ( 1.0 - uPivot ) * pow( max( 1.0 - g, 0.0 ) / ( 1.0 - uPivot ), vec3( uShoulder ) );
	g = mix( lo, hi, smoothstep( uPivot - 0.04, uPivot + 0.04, g ) );
	c = pow( max( g, 0.0 ), vec3( 2.2 ) );
	l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	c = max( mix( vec3( l ), c, uSaturation ), 0.0 );
	c += uLift * ( 1.0 - c );
	// Triangular dither (±0.5/255) breaks banding in the sky gradients.
	float n = fract( sin( dot( uv * 1337.0, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) + fract( sin( dot( uv * 731.0, vec2( 39.346, 11.135 ) ) ) * 24634.6345 ) - 1.0;
	c += n / 255.0;
	outputColor = vec4( c, inputColor.a );
}
`;

const WB_FRAG = /* glsl */ `
uniform vec3 uGain;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
	outputColor = vec4( inputColor.rgb * uGain, inputColor.a );
}
`;

/** Partial white balance toward the current illuminant (scene-referred, before tone mapping). */
export class WhiteBalanceEffect extends Effect {
  constructor() {
    super('WhiteBalanceEffect', WB_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([['uGain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))]]),
    });
  }
  /**
   * illuminant: linear RGB colour of the dominant light; strength 0..1; bias: extra RGB gain applied
   * on top (e.g. a slightly warm daylight balance). Luminance preserved.
   */
  setIlluminant(illuminant: THREE.Color, strength: number, bias: THREE.Vector3Like = { x: 1, y: 1, z: 1 }): void {
    const l = 0.2126 * illuminant.r + 0.7152 * illuminant.g + 0.0722 * illuminant.b;
    const g = this.uniforms.get('uGain')!.value as THREE.Vector3;
    const ok = l > 1e-8 && strength > 0;
    const r = (ok ? Math.pow(l / Math.max(illuminant.r, 1e-6), strength) : 1) * bias.x;
    const gg = (ok ? Math.pow(l / Math.max(illuminant.g, 1e-6), strength) : 1) * bias.y;
    const b = (ok ? Math.pow(l / Math.max(illuminant.b, 1e-6), strength) : 1) * bias.z;
    const n = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    g.set(r / n, gg / n, b / n);
  }
}

export interface GradeParams {
  saturation: number;
  /** Power below / above the pivot (1 = linear). */
  toe: number;
  shoulder: number;
  /** Pivot in display (gamma 2.2) space. */
  pivot: number;
  shadow: THREE.Vector3Like;
  highlight: THREE.Vector3Like;
  lift: number;
}

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uSaturation', new THREE.Uniform(1.08)],
        ['uToe', new THREE.Uniform(1.2)],
        ['uShoulder', new THREE.Uniform(1.1)],
        ['uPivot', new THREE.Uniform(0.45)],
        ['uShadowTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uHighlightTint', new THREE.Uniform(new THREE.Vector3(1.03, 1.0, 0.96))],
        ['uLift', new THREE.Uniform(0.0)],
      ]),
    });
  }
  set(p: GradeParams): void {
    const u = this.uniforms;
    u.get('uSaturation')!.value = p.saturation;
    u.get('uToe')!.value = p.toe;
    u.get('uShoulder')!.value = p.shoulder;
    u.get('uPivot')!.value = p.pivot;
    (u.get('uShadowTint')!.value as THREE.Vector3).copy(p.shadow);
    (u.get('uHighlightTint')!.value as THREE.Vector3).copy(p.highlight);
    u.get('uLift')!.value = p.lift;
  }
}

export interface PostChain {
  composer: EffectComposer;
  ao: N8AOPostPass;
  bloom: BloomEffect;
  toneMapping: ToneMappingEffect;
  grade: GradeEffect;
  whiteBalance: WhiteBalanceEffect;
  vignette: VignetteEffect;
  smaa: SMAAEffect;
  waterReflection: WaterReflectionEffect;
  setSize(w: number, h: number): void;
  render(dt: number): void;
}

/**
 * Flytake (three r187): n8ao 2.0.1's multiple-render-target class (its half-res depth/normal target)
 * overrides `texture` to return the whole `textures` array. three r187's setupRenderTarget reads
 * `renderTarget.texture.mipmaps`, so that throws on the first AO frame. Drop the override on n8ao's
 * class so `texture` is `textures[0]` again, as on three's own MRT targets (n8ao only uses `textures`).
 */
function restoreN8aoMrtTexture(ao: N8AOPostPass): void {
  const rt = (ao as unknown as { depthDownsampleTarget?: THREE.WebGLRenderTarget }).depthDownsampleTarget;
  if (rt == null) return;
  const proto = Object.getPrototypeOf(rt) as object;
  if (proto !== THREE.WebGLRenderTarget.prototype && Object.prototype.hasOwnProperty.call(proto, 'texture')) {
    delete (proto as { texture?: unknown }).texture;
  }
}

export function createPostChain(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): PostChain {
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
    stencilBuffer: false,
    depthBuffer: true,
  });
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  composer.addPass(new RenderPass(scene, camera));

  const ao = new N8AOPostPass(scene, camera, size.x, size.y);
  const c = ao.configuration;
  c.aoSamples = 10;
  c.denoiseSamples = 5;
  c.denoiseRadius = 10;
  c.aoRadius = 6;
  c.distanceFalloff = 1.2;
  c.intensity = 2.6;
  c.halfRes = true;
  c.depthAwareUpsampling = true;
  c.gammaCorrection = false;
  c.color = new THREE.Color(0x0b0d12);
  composer.addPass(ao);
  restoreN8aoMrtTexture(ao);

  // Bay reflections read the AO'd HDR frame and feed bloom (night light streaks glow).
  const waterReflection = new WaterReflectionEffect(camera);
  composer.addPass(new EffectPass(camera, waterReflection));

  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 1.6,
    luminanceSmoothing: 0.35,
    intensity: 0.75,
    radius: 0.72,
    levels: 6,
  });
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const grade = new GradeEffect();
  const whiteBalance = new WhiteBalanceEffect();
  const vignette = new VignetteEffect({ offset: 0.28, darkness: 0.42 });
  composer.addPass(new EffectPass(camera, bloom, whiteBalance, toneMapping, grade, vignette));

  const smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM, edgeDetectionMode: EdgeDetectionMode.COLOR });
  composer.addPass(new EffectPass(camera, smaa));

  return {
    composer,
    ao,
    bloom,
    toneMapping,
    grade,
    whiteBalance,
    vignette,
    smaa,
    waterReflection,
    setSize(w, h) {
      composer.setSize(w, h);
    },
    render(dt) {
      composer.render(dt);
    },
  };
}
