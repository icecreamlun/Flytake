/**
 * Materials for the chase-view drone at Emerald Bay. Like every custom material under takram's
 * aerial perspective they output pre-lit albedo (see world/light.ts): Lambert from the live sun,
 * sky fill, and the shadow field sampled at the drone's centre (trees and ridges shade it).
 * Normals go ECEF -> scene ENU with a rotation-only uniform, so nothing depends on float32 ECEF
 * positions on the GPU.
 */
import { Color, GLSL3, Matrix3, ShaderMaterial, Vector3, type Material } from 'three';
import { SCENE_LIGHT } from '../world/light';
import { SCENE_FRAME_INV } from '../world/scene';
import { SHADOW_GLSL, SHADOW_UNIFORMS } from '../world/shadowGlsl';
import type { DroneMaterialRole } from './model';

/** the drone's centre in the scene ENU frame (DroneSim updates it every frame) */
export const DRONE_CENTER_ENU = new Vector3();

const ECEF_TO_ENU = new Matrix3().setFromMatrix4(SCENE_FRAME_INV);

const ALBEDO: Record<DroneMaterialRole, string> = {
  body: '#b4b7bb',
  dark: '#1d1f22',
  prop: '#9da1a6',
  disc: '#9da1a6',
  glass: '#040507',
  metal: '#6b6f75',
  led: '#ff2a1a',
};

const VERT = /* glsl */ `
uniform mat3 uEcefToEnu;
out vec3 vN;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vN = normalize(uEcefToEnu * (mat3(modelMatrix) * normal));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform float uFlatSunInv;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uAlbedo;
uniform float uOpacity;
uniform vec3 uCenterEnu;
${SHADOW_GLSL}
in vec3 vN;
out vec4 fragColor;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  float sunVis = flySunVis(uCenterEnu, 0.4);
  float ndl = max(dot(N, uSunDir), 0.0);
  // plastic: a soft highlight toward the sun on top of Lambert
  float sheen = pow(max(dot(N, normalize(uSunDir + vec3(0.0, 0.0, 1.0))), 0.0), 24.0) * 0.25;
  vec3 lit = uAlbedo * (sunVis * ndl * uSunColor + uAmbient * (0.7 + 0.3 * N.z)) + sheen * sunVis * uSunColor;
  fragColor = vec4(lit * uFlatSunInv, uOpacity);
}
`;

export function preLitDroneMaterial(role: DroneMaterialRole): Material {
  const c = new Color(ALBEDO[role]);
  const disc = role === 'disc';
  return new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: disc,
    depthWrite: !disc,
    uniforms: {
      ...SCENE_LIGHT,
      ...SHADOW_UNIFORMS,
      uEcefToEnu: { value: ECEF_TO_ENU },
      uCenterEnu: { value: DRONE_CENTER_ENU },
      uAlbedo: { value: new Vector3(c.r, c.g, c.b) },
      uOpacity: { value: disc ? 0 : 1 },
    },
  });
}
