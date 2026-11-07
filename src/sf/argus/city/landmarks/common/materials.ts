/**
 * Landmark materials: MeshStandardMaterial + a small shader patch adding three night-time emissive
 * terms, all scaled by the shared uniform uLmNight (= nightFactor / exposure, so emissives read the same
 * at any auto-exposure; see index.ts):
 *   1. per-vertex glow   — `aGlow` attribute × glow colour (× albedo with glowAlbedo, e.g. clock dials)
 *   2. floodlight        — albedo × flood colour, fading with height, weak on up-facing surfaces
 *   3. windows           — glass (low roughness texels) lit per texture cell with random occupancy
 * plus the per-landmark state (state.ts): ShakeMap / damage overlay tints and earthquake damage
 * (procedural crack network, spalled patches, dust; rubble tint once collapsed), keyed by `aLmSlot`.
 */
import * as THREE from 'three';
import { getTextures, type TexKind } from './textures';
import { lmStateUniforms } from './state';

export const lmUniforms = {
  /** nightFactor / exposure × (1 − powerOut). */
  uLmNight: { value: 0 },
  uLmTime: { value: 0 },
  /** 0..1 local earthquake shaking (drives lantern swing etc.). */
  uLmShake: { value: 0 },
};

export interface LmMatOpts extends THREE.MeshStandardMaterialParameters {
  tex?: TexKind;
  /** Multiplies the texture-set normal map strength. */
  bump?: number;
  glow?: THREE.ColorRepresentation;
  glowIntensity?: number;
  /** Multiply the vertex glow by albedo (dials, lanterns, signs: dark ink must stay dark). */
  glowAlbedo?: boolean;
  flood?: { color: THREE.ColorRepresentation; intensity: number; y0: number; y1: number; topScale?: number; stage?: number };
  windows?: { color: THREE.ColorRepresentation; intensity: number; lit: number };
  noShadow?: boolean;
  /** Pendulum sway (needs an instanced `aPhase` attribute; geometry origin = hanging point). */
  sway?: boolean;
  /** Paper/silk lantern: the night glow is a warm core seen through translucent skin (bright face-on, red rim). */
  lantern?: boolean;
  /** Weathering: base elevation (world y), ground-grime darkening 0..1, mottling 0..1. */
  weather?: { baseY: number; grime?: number; mottle?: number };
  /** Night glow mask texture (white = glows); uses the emissiveMap slot with a black base emissive. */
  glowMask?: THREE.Texture;
  /** Precast look: per-texture-cell (panel) albedo variation ± this fraction + fine aggregate speckle. */
  panelVar?: number;
}

const VERT_HEAD = /* glsl */ `
#ifdef LM_SWAY
attribute float aPhase;
uniform float uLmTime;
uniform float uLmShake;
#endif
attribute float aGlow;
attribute float aLmSlot;
uniform highp sampler2D uLmState;
varying float vLmGlow;
varying vec3 vLmWorld;
varying vec3 vLmWNormal;
varying vec4 vLmOvl;
varying vec4 vLmDmg;
varying vec3 vLmLocal;
varying vec3 vLmLNormal;
`;

/** Pendulum sway about the object's local origin (the hanging point), stronger while the ground shakes. */
const VERT_SWAY = /* glsl */ `
#ifdef LM_SWAY
{
  float lmAmp = 0.05 + 0.32 * uLmShake;
  float lmW = 1.25 + 2.2 * uLmShake;
  float lmA = lmAmp * sin( uLmTime * lmW + aPhase );
  float lmB = 0.7 * lmAmp * sin( uLmTime * lmW * 0.83 + aPhase * 1.71 + 1.3 );
  float ca = cos( lmA ), sa = sin( lmA ), cb = cos( lmB ), sb = sin( lmB );
  transformed.yz = vec2( ca * transformed.y - sa * transformed.z, sa * transformed.y + ca * transformed.z );
  transformed.xy = vec2( cb * transformed.x - sb * transformed.y, sb * transformed.x + cb * transformed.y );
}
#endif
`;

const VERT_BODY = /* glsl */ `
{
  vec4 lmW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    lmW = instanceMatrix * lmW;
  #endif
  lmW = modelMatrix * lmW;
  vLmWorld = lmW.xyz;
  vLmWNormal = normalize( mat3( modelMatrix ) * objectNormal );
  vLmGlow = aGlow;
  int lmSl = int( aLmSlot + 0.5 );
  vLmOvl = texelFetch( uLmState, ivec2( lmSl * 2, 0 ), 0 );
  vLmDmg = texelFetch( uLmState, ivec2( lmSl * 2 + 1, 0 ), 0 );
  vLmLocal = transformed;
  vLmLNormal = objectNormal;
}
`;

const FRAG_HEAD = /* glsl */ `
uniform float uLmNight;
uniform vec3 uLmGlow;
uniform vec3 uLmFlood;
uniform vec4 uLmFloodY;
uniform vec3 uLmWin;
uniform float uLmWinLit;
varying float vLmGlow;
varying vec3 vLmWorld;
varying vec3 vLmWNormal;
uniform vec3 uLmWeather;
uniform float uLmDamageOverlay;
uniform float uLmPanelVar;
varying vec4 vLmOvl;
varying vec4 vLmDmg;
varying vec3 vLmLocal;
varying vec3 vLmLNormal;
float lmHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
vec2 lmHash22( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.xx + p3.yz ) * p3.zy ); }
vec3 lmDamageRamp( float d ) {
  // Same ramp as the buildings' damage overlay (linear RGB).
  d = clamp( d, 0.0, 4.0 );
  vec3 c = mix( vec3( 0.05, 0.30, 0.10 ), vec3( 0.80, 0.65, 0.02 ), clamp( d, 0.0, 1.0 ) );
  c = mix( c, vec3( 0.90, 0.25, 0.01 ), clamp( d - 1.0, 0.0, 1.0 ) );
  c = mix( c, vec3( 0.70, 0.02, 0.01 ), clamp( d - 2.0, 0.0, 1.0 ) );
  return mix( c, vec3( 0.22, 0.0, 0.06 ), clamp( d - 3.0, 0.0, 1.0 ) );
}
float lmNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( lmHash( i ), lmHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( lmHash( i + vec2( 0.0, 1.0 ) ), lmHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
`;

const FRAG_WEATHER = /* glsl */ `
#if defined( LM_PANELVAR ) && defined( USE_MAP )
{
  // Each texture tile is one precast panel: slight tone shift per panel, plus exposed-aggregate speckle
  // that fades out before it can alias.
  vec2 lmCellP = floor( vMapUv + 0.001 );
  diffuseColor.rgb *= 1.0 + ( lmHash( lmCellP * 1.37 + 0.71 ) - 0.5 ) * uLmPanelVar;
  vec2 lmAg = vMapUv * vec2( 90.0, 170.0 );
  float lmAgW = max( fwidth( lmAg.x ), fwidth( lmAg.y ) );
  float lmSpeck = ( lmHash( floor( lmAg ) ) - 0.5 ) * ( 1.0 - smoothstep( 0.3, 1.0, lmAgW ) );
  diffuseColor.rgb *= 1.0 + lmSpeck * 0.09;
}
#endif
#ifdef LM_WEATHER
{
  // Ground grime + soft large-scale mottling (breaks the CG-clean look of big uniform surfaces).
  float lmHb = vLmWorld.y - uLmWeather.x;
  float lmGrime = 1.0 - uLmWeather.y * ( 1.0 - smoothstep( 0.0, 2.8, lmHb ) );
  vec2 lmWp = vec2( vLmWorld.x + vLmWorld.z, vLmWorld.y * 1.7 + ( vLmWorld.x - vLmWorld.z ) * 0.3 ) * 0.11;
  float lmN = lmNoise( lmWp ) * 0.65 + lmNoise( lmWp * 3.7 + 11.0 ) * 0.35;
  diffuseColor.rgb *= lmGrime * ( 1.0 - uLmWeather.z * ( lmN - 0.5 ) * 2.0 );
}
#endif
`;

/** Earthquake damage + overlay tints (after roughness / metalness are known). */
const FRAG_STATE = /* glsl */ `
float lmOvlMix = 0.0;
vec3 lmOvlCol = vec3( 0.0 );
{
  float lmD = vLmDmg.x;
  // Planar coordinates in the landmark's own frame (cracks stay glued to the surface while it rocks).
  vec3 lmAn = abs( vLmLNormal );
  vec2 lmP = lmAn.y > max( lmAn.x, lmAn.z ) ? vLmLocal.xz : ( lmAn.x > lmAn.z ? vLmLocal.zy : vLmLocal.xy );
  float lmPx = max( length( fwidth( vLmLocal ) ), 1e-4 ); // metres per pixel
  if ( lmD > 0.02 ) {
    float lmGlass = 1.0 - smoothstep( 0.18, 0.4, roughnessFactor - metalnessFactor * 0.3 );
    float lmWallOnly = 1.0 - lmGlass;
    // Crack network: jagged Voronoi borders, each border activating independently as damage grows.
    vec2 cp = lmP * 0.5 + vLmDmg.z * 37.0;
    cp += ( vec2( lmNoise( cp * 11.0 ), lmNoise( cp * 11.0 + 9.2 ) ) - 0.5 ) * 0.1 + ( vec2( lmNoise( cp * 1.3 ), lmNoise( cp * 1.3 + 4.1 ) ) - 0.5 ) * 0.2;
    vec2 ip = floor( cp );
    vec2 fq = fract( cp );
    float d1 = 8.0, d2 = 8.0;
    vec2 id1 = ip, id2 = ip;
    for ( int j = -1; j <= 1; j ++ ) for ( int i = -1; i <= 1; i ++ ) {
      vec2 g = vec2( float( i ), float( j ) );
      vec2 r = g + lmHash22( ip + g ) - fq;
      float dd = dot( r, r );
      if ( dd < d1 ) { d2 = d1; id2 = id1; d1 = dd; id1 = ip + g; } else if ( dd < d2 ) { d2 = dd; id2 = ip + g; }
    }
    float edgeM = ( sqrt( d2 ) - sqrt( d1 ) ) * 0.5 / 0.5;
    vec2 pk = id1 + id2;
    vec2 pd = abs( id1 - id2 );
    float act = step( lmHash( vec2( pk.x + pk.y * 7.13, pd.x * 3.1 + pd.y * 1.7 ) + vLmDmg.z ), 0.06 + 0.11 * lmD );
    float wM = 0.003 + 0.0035 * lmD; // crack half-width (m)
    float wD = max( wM, lmPx * 0.5 );
    float cov = clamp( wM / lmPx, 0.0, 1.0 ); // thinner than a pixel → fainter, never fatter
    float crack = ( 1.0 - smoothstep( wD * 0.5, wD * 1.5, edgeM ) ) * cov * act * lmWallOnly;
    crack *= smoothstep( 0.2, 1.0, lmD + lmNoise( cp * 0.31 ) - 0.5 );
    // Spalled patches exposing darker structure (moderate+), with a shadowed rim.
    float sp = lmNoise( lmP * 0.35 + vLmDmg.z * 9.0 ) * 0.62 + lmNoise( lmP * 1.1 + 3.7 ) * 0.38;
    float thr = 0.84 - ( lmD - 2.0 ) * 0.07;
    float spall = smoothstep( thr, thr + 0.02, sp ) * step( 2.0, lmD ) * lmWallOnly;
    float rim = ( smoothstep( thr - 0.035, thr, sp ) - spall ) * step( 2.0, lmD ) * lmWallOnly;
    vec3 lmStruct = vec3( 0.24, 0.17, 0.13 ) * ( 0.75 + 0.5 * lmNoise( lmP * 4.0 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, lmStruct, spall );
    diffuseColor.rgb *= 1.0 - 0.4 * rim;
    // Dust coating (glass reads dulled rather than painted).
    float dust = clamp( lmD * 0.11, 0.0, 0.45 ) * ( 0.5 + 0.5 * lmNoise( lmP * 0.45 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.55, 0.52, 0.47 ), dust * mix( 1.0, 0.35, lmGlass ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.02 ), crack );
    roughnessFactor = mix( roughnessFactor, 1.0, max( dust, spall ) );
    metalnessFactor *= 1.0 - dust;
    // Collapsed: broken, dusty rubble.
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.42, 0.40, 0.37 ) * ( 0.6 + 0.5 * lmNoise( lmP * 1.5 ) ), smoothstep( 0.2, 0.6, vLmDmg.y ) );
  }
  if ( uLmDamageOverlay > 0.5 && vLmDmg.w > 0.5 ) {
    lmOvlCol = lmDamageRamp( lmD );
    lmOvlMix = 0.9;
  } else if ( vLmOvl.a > 0.5 ) {
    lmOvlCol = vLmOvl.rgb;
    lmOvlMix = 0.78;
  }
  if ( lmOvlMix > 0.0 ) {
    diffuseColor.rgb = mix( diffuseColor.rgb, lmOvlCol, lmOvlMix );
    metalnessFactor *= 0.15;
    roughnessFactor = max( roughnessFactor, 0.55 );
  }
}
`;

const FRAG_BODY = /* glsl */ `
{
  vec3 lmE = uLmGlow * vLmGlow;
  #ifdef LM_GLOW_ALBEDO
    lmE *= diffuseColor.rgb * 1.6;
  #endif
  #ifdef USE_EMISSIVEMAP
    lmE *= emissiveColor.rgb;
  #endif
  #ifdef LM_LANTERN
  {
    float lmNdv = abs( dot( normal, normalize( vViewPosition ) ) );
    // A bulb seen through silk: small hot orange-yellow core face-on (bright enough to bloom), deep red
    // toward the silhouette where the light crosses more silk.
    float lmCore = pow( lmNdv, 4.0 );
    lmE *= vec3( 0.32, 0.025, 0.006 ) * ( 0.4 + 0.6 * lmNdv ) + vec3( 2.6, 1.05, 0.26 ) * lmCore;
  }
  #endif
  #ifdef LM_FLOOD
    float lmH = clamp( ( vLmWorld.y - uLmFloodY.x ) / max( uLmFloodY.y - uLmFloodY.x, 0.01 ), 0.0, 1.0 );
    float lmFace = 1.0 - 0.8 * max( vLmWNormal.y, 0.0 );
    // Optional per-storey uplight banding: bright at the foot of each stage, fading upward.
    float lmStage = uLmFloodY.w > 0.0 ? 0.22 + 0.78 * pow( 1.0 - fract( ( vLmWorld.y - uLmFloodY.x ) / uLmFloodY.w ), 1.8 ) : 1.0;
    lmE += diffuseColor.rgb * uLmFlood * mix( 1.0, uLmFloodY.z, lmH ) * lmFace * lmStage;
  #endif
  #if defined( LM_WINDOWS ) && defined( USE_MAP )
    float lmMask = 1.0 - smoothstep( 0.1, 0.3, roughnessFactor );
    vec2 lmCell = floor( vMapUv + 0.001 );
    float lmR = lmHash( lmCell );
    float lmOn = step( 1.0 - uLmWinLit, lmR );
    float lmTone = lmHash( lmCell + 17.3 );
    vec3 lmCol = mix( uLmWin, uLmWin * vec3( 0.75, 0.9, 1.15 ), step( 0.8, lmTone ) );
    lmE += lmCol * lmMask * lmOn * ( 0.55 + 0.9 * lmHash( lmCell + 5.1 ) );
  #endif
  totalEmissiveRadiance += lmE * uLmNight;
  if ( lmOvlMix > 0.0 ) totalEmissiveRadiance = mix( totalEmissiveRadiance, lmOvlCol * ( lmOvlMix > 0.8 ? 0.3 : 0.18 ), 0.85 );
  else if ( vLmDmg.x > 0.02 ) totalEmissiveRadiance *= 1.0 - clamp( vLmDmg.x * 0.11, 0.0, 0.45 ) * 0.5;
}
`;

let uid = 0;

/** Create a patched standard material. Texture sets come from textures.ts (UVs in metres). */
export function lmMaterial(o: LmMatOpts = {}): THREE.MeshStandardMaterial {
  const { tex, bump, glow, glowIntensity, glowAlbedo, flood, windows, noShadow, glowMask, weather, sway, panelVar, lantern, ...std } = o;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...std });
  if (tex) {
    const t = getTextures(tex);
    if (!std.map) m.map = t.map;
    m.normalMap = t.normalMap;
    m.normalScale = new THREE.Vector2(bump ?? 1, bump ?? 1);
    if (std.roughnessMap === undefined) m.roughnessMap = t.roughnessMap;
  }
  if (noShadow) m.userData.noShadow = true;
  if (glowMask) {
    m.emissiveMap = glowMask;
    m.emissive.setRGB(0, 0, 0);
  }
  const u = {
    uLmNight: lmUniforms.uLmNight,
    uLmTime: lmUniforms.uLmTime,
    uLmShake: lmUniforms.uLmShake,
    uLmGlow: { value: new THREE.Color(glow ?? 0x000000).multiplyScalar(glowIntensity ?? 1) },
    uLmFlood: { value: new THREE.Color(flood?.color ?? 0x000000).multiplyScalar(flood?.intensity ?? 0) },
    uLmFloodY: { value: new THREE.Vector4(flood?.y0 ?? 0, flood?.y1 ?? 1, flood?.topScale ?? 0.5, flood?.stage ?? 0) },
    uLmWin: { value: new THREE.Color(windows?.color ?? 0x000000).multiplyScalar(windows?.intensity ?? 0) },
    uLmWinLit: { value: windows?.lit ?? 0 },
    uLmWeather: { value: new THREE.Vector3(weather?.baseY ?? 0, weather?.grime ?? 0.25, weather?.mottle ?? 0.08) },
    uLmPanelVar: { value: panelVar ?? 0 },
    uLmState: lmStateUniforms.uLmState,
    uLmDamageOverlay: lmStateUniforms.uLmDamageOverlay,
  };
  m.userData.lm = u;
  const defines: Record<string, string> = {};
  if (glowAlbedo) defines.LM_GLOW_ALBEDO = '';
  if (flood) defines.LM_FLOOD = '';
  if (windows) defines.LM_WINDOWS = '';
  if (weather) defines.LM_WEATHER = '';
  if (sway) defines.LM_SWAY = '';
  if (panelVar) defines.LM_PANELVAR = '';
  if (lantern) defines.LM_LANTERN = '';
  m.defines = { ...(m.defines ?? {}), ...defines };
  const key = `lm:${Object.keys(defines).sort().join(',')}`;
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_SWAY}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_WEATHER}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FRAG_STATE}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_BODY}`);
  };
  m.name = `lm${uid++}`;
  return m;
}

/** Plain helper for colours given as sRGB hex (returns linear THREE.Color). */
export function srgb(hex: THREE.ColorRepresentation): THREE.Color {
  return new THREE.Color(hex);
}
