/**
 * Building materials: MeshStandardMaterial patched with onBeforeCompile so the engine's PBR lights,
 * shadows, image-based lighting, fog and tone mapping all keep working. The procedural shading
 * replaces the albedo / roughness / metalness / normal / emissive / AO inputs; the vertex stage
 * applies the per-building deformation from the state texture (also in the shadow-depth material).
 */
import * as THREE from 'three';
import { COMMON_PARS, DEFORM_PARS } from './glsl/common';
import { FACADE_PARS } from './glsl/facade';
import { INTERIOR_PARS } from './glsl/interior';
import { PROPS_PARS } from './glsl/props';

export interface SharedUniforms {
  [name: string]: THREE.IUniform;
  uState: THREE.IUniform<THREE.Texture>;
  uStyle: THREE.IUniform<THREE.Texture>;
  uOverlay: THREE.IUniform<THREE.Texture>;
  uHighlight: THREE.IUniform<number>;
  uDamageOverlay: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  uDayLevel: THREE.IUniform<number>;
  uHour: THREE.IUniform<number>;
  uLightLevel: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
}

// Vertex: fetch state once, tilt the normal (before defaultnormal_vertex), deform the position.
const VERT_STATE = /* glsl */ `
	int argBi = int( aBld + 0.5 );
	vec4 argA = argState( argBi, 0 );
	vec4 argB = argState( argBi, 1 );
	vec4 argS = argState( argBi, 2 );
	objectNormal = argTilt( objectNormal, argA.zw );
`;

const VERT_DEFORM = /* glsl */ `
	vH = position.y - argS.z;
	transformed = argDeform( transformed, argA, argB, argS );
	vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	vNrmW = normalize( mat3( modelMatrix ) * objectNormal );
	vBld = aBld;
	vDyn = vec4( argB.y, argB.z, argB.x, abs( aBld - uHighlight ) < 0.5 ? 1.0 : 0.0 );
	vPiv = argS;
`;

// Normal perturbation in the wall's tangent frame (x along the wall, y up, z out).
const NORMAL_FACADE = /* glsl */ `
	{
		vec3 argNw = normalize( vNrmW );
		vec3 argTw = normalize( vec3( - argNw.z, 0.0, argNw.x ) + vec3( 1e-6, 0.0, 0.0 ) );
		vec3 argTv = normalize( ( viewMatrix * vec4( argTw, 0.0 ) ).xyz );
		vec3 argBv = cross( argTv, normal );
		normal = normalize( argTv * fNT.x + argBv * fNT.y + normal * fNT.z );
	}
`;

const AO_CHUNK = /* glsl */ `
	float ambientOcclusion = fAO;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
`;

// Glass reflects a fake city instead of open sky near / below the horizon (no SSR needed): building
// silhouettes of varying height by azimuth, toned from the wall's own diffuse irradiance so the
// reflected facades match the surrounding light; below the horizon, the street.
const GLASS_REFLECTION = /* glsl */ `
	#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	if ( fGlass > 0.001 ) {
		vec3 argRw = reflect( normalize( vWPos - cameraPosition ), normalize( vNrmW ) );
		float argAz = atan( argRw.z, argRw.x );
		float argBld = floor( argAz * 14.0 );
		float argSky = 0.03 + 0.16 * h11( argBld + 0.37 ) * h11( argBld * 1.7 + 4.1 ) + 0.05 * fbm3( vec2( argAz * 3.0, 1.0 ) );
		float argOcc = 1.0 - smoothstep( argSky - 0.006, argSky + 0.006, argRw.y );
		vec3 argAvg = iblIrradiance * RECIPROCAL_PI;
		float argTone = 0.45 + 0.5 * h11( argBld * 3.1 + 0.9 );
		vec3 argCity = argAvg * argTone * mix( 0.45, 1.0, smoothstep( -0.25, 0.0, argRw.y ) );
		argCity += vec3( 1.0, 0.72, 0.42 ) * uNight * 0.08 * step( 0.5, h11( argBld * 7.3 ) );
		radiance = mix( radiance, argCity, argOcc * fGlass );
	}
	#endif
`;

function patchCommonFragment(src: string, body: string, call: string): string {
  return src
    .replace('#include <common>', `#include <common>\n${COMMON_PARS}\n${body}`)
    .replace('#include <map_fragment>', call)
    .replace('#include <color_fragment>', 'diffuseColor.rgb = fAlbedo;')
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = fRough;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = fMetal;')
    .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = fEmis;')
    .replace('#include <aomap_fragment>', AO_CHUNK)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${GLASS_REFLECTION}`);
}

export function createFacadeMaterial(shared: SharedUniforms, cheap: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  mat.name = cheap ? 'buildingFacadeCheap' : 'buildingFacade';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${COMMON_PARS}\n${DEFORM_PARS}
attribute float aBld;
attribute vec4 aFac;
attribute float aFlags;
varying vec4 vFac;
varying float vH;
varying vec3 vWPos;
varying vec3 vNrmW;
flat varying float vBld;
flat varying float vFlags;
flat varying vec4 vDyn;
flat varying vec4 vPiv;
uniform float uLightLevel;`,
      )
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_STATE}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_DEFORM}\n\tvFac = aFac;\n\tvFlags = aFlags;`);
    shader.fragmentShader = patchCommonFragment(
      shader.fragmentShader,
      `${cheap ? '#define ARG_CHEAP' : ''}\n${INTERIOR_PARS}\n${FACADE_PARS}`,
      'argFacade();',
    ).replace('#include <normal_fragment_maps>', NORMAL_FACADE);
  };
  mat.customProgramCacheKey = () => (cheap ? 'argus-facade-cheap' : 'argus-facade');
  return mat;
}

/** railings = true compiles the alpha-cut variant (the only building shader that uses discard). */
export function createPropsMaterial(shared: SharedUniforms, railings = false): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  mat.name = railings ? 'buildingRailings' : 'buildingProps';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${COMMON_PARS}\n${DEFORM_PARS}
attribute float aBld;
attribute vec3 aCol;
attribute vec4 aProp;
varying vec3 vCol;
varying vec4 vProp;
varying vec3 vWPos;
varying vec3 vNrmW;
varying float vH;
flat varying float vBld;
flat varying vec4 vDyn;
flat varying vec4 vPiv;`,
      )
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_STATE}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_DEFORM}\n\tvCol = aCol;\n\tvProp = aProp;`);
    shader.fragmentShader = patchCommonFragment(shader.fragmentShader, `${railings ? '#define ARG_RAILINGS' : ''}\n${PROPS_PARS}`, 'argProps();').replace(
      '#include <normal_fragment_maps>',
      'if ( dot( fBump, fBump ) > 1e-8 ) normal = normalize( normal + ( viewMatrix * vec4( fBump, 0.0 ) ).xyz );',
    );
  };
  mat.customProgramCacheKey = () => (railings ? 'argus-railings' : 'argus-props');
  return mat;
}

/**
 * Shadow material applying the same deformation (and railing cut-outs for props): a MeshDepthMaterial
 * for directional / spot lights, or (distance = true) a MeshDistanceMaterial for point lights.
 */
export function createDepthMaterial(shared: SharedUniforms, props: boolean, distance = false): THREE.MeshDepthMaterial | THREE.MeshDistanceMaterial {
  const mat = distance ? new THREE.MeshDistanceMaterial() : new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.name = `${props ? 'buildingPropsDepth' : 'buildingDepth'}${distance ? 'Distance' : ''}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${COMMON_PARS}\n${DEFORM_PARS}\nattribute float aBld;\n${props ? 'attribute vec4 aProp;\nvarying vec4 vPropD;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
	{
		int argBi = int( aBld + 0.5 );
		transformed = argDeform( transformed, argState( argBi, 0 ), argState( argBi, 1 ), argState( argBi, 2 ) );
	}
	${props ? 'vPropD = aProp;' : ''}`,
      );
    if (props) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vPropD;')
        .replace(
          'void main() {',
          `void main() {
	if ( abs( vPropD.x - 12.0 ) < 0.5 && vPropD.y < 9.5 ) {
		float bars = step( fract( vPropD.y / 0.14 ), 0.18 );
		float rails = step( vPropD.z, 0.05 ) + step( 0.88, vPropD.z );
		if ( bars + rails < 0.5 ) discard;
	}`,
        );
    }
  };
  mat.customProgramCacheKey = () => `${props ? 'argus-depth-props' : 'argus-depth'}${distance ? '-dist' : ''}`;
  return mat;
}
