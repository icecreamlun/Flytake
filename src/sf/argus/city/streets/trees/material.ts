/**
 * Foliage material shared by every tree LOD: atlas albedo with alpha test, per-instance foliage tint (bark keeps
 * its own colour), baked crown AO, wind sway (whole tree) + leaf flutter + palm-frond bounce in the vertex shader,
 * two-sided leaves that keep their outward volumetric normal, and a sun-through-leaves translucency term.
 * A matching depth material makes the shadows sway too.
 */
import * as THREE from 'three';

export interface FoliageUniforms {
  uTime: { value: number };
  uWind: { value: number };
  uSunView: { value: THREE.Vector3 };
  uSunCol: { value: THREE.Color };
}

const PARS_V = /* glsl */ `
attribute float aLeaf;
attribute float aAO;
uniform float uTime;
uniform float uWind;
varying float vLeaf;
`;

const WIND = /* glsl */ `
{
	vec3 ip = vec3( instanceMatrix[ 3 ][ 0 ], instanceMatrix[ 3 ][ 1 ], instanceMatrix[ 3 ][ 2 ] );
	float ph = ip.x * 0.071 + ip.z * 0.093;
	float h = max( transformed.y, 0.0 ) * 0.1;
	float sw = ( sin( uTime * 0.9 + ph ) * 0.7 + sin( uTime * 2.1 + ph * 1.3 ) * 0.3 ) * uWind;
	transformed.xz += vec2( sw, sw * 0.6 ) * h * h * 0.22;
	if ( aLeaf > 0.5 ) {
		float fl = sin( uTime * 5.3 + dot( position, vec3( 1.7, 2.3, 1.1 ) ) + ph );
		transformed += normal * fl * 0.035 * uWind;
	}
	if ( aLeaf > 1.5 ) {
		float d = length( transformed.xz );
		transformed.y += sin( uTime * 1.7 + ph + atan( transformed.z, transformed.x ) * 2.0 ) * 0.05 * d * uWind;
	}
}
`;

export function createFoliageMaterials(atlas: THREE.Texture, blob = false): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; uniforms: FoliageUniforms } {
  const uniforms: FoliageUniforms = {
    uTime: { value: 0 },
    uWind: { value: 1 },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
  };
  const material = new THREE.MeshStandardMaterial({
    map: atlas,
    alphaTest: blob ? 0 : 0.42,
    side: blob ? THREE.FrontSide : THREE.DoubleSide,
    roughness: 0.8,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS_V}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${blob ? '' : WIND}\nvLeaf = aLeaf;`)
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	vColor = vec4( vec3( aAO ), 1.0 );
	#ifdef USE_INSTANCING_COLOR
		vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, step( 0.5, aLeaf ) );
	#endif
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLeaf;\nuniform vec3 uSunView;\nuniform vec3 uSunCol;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', 'if ( vLeaf < 0.5 ) normal *= faceDirection;'))
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( 0.92, 0.68, step( 0.5, vLeaf ) );')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
if ( vLeaf > 0.5 ) {
	float back = pow( max( dot( normalize( - vViewPosition ), uSunView ), 0.0 ), 5.0 );
	totalEmissiveRadiance += diffuseColor.rgb * uSunCol * back * 0.22;
}`,
      );
  };
  material.customProgramCacheKey = () => (blob ? 'argus-foliage-blob-v1' : 'argus-foliage-v1');

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: blob ? 0 : 0.42 });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS_V}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${blob ? '' : WIND}\nvLeaf = aLeaf;`);
  };
  depth.customProgramCacheKey = () => (blob ? 'argus-foliage-depth-blob-v1' : 'argus-foliage-depth-v1');
  return { material, depth, uniforms };
}
