import type { Material, WebGLProgramParametersWithUniforms } from 'three';
import { SCENE_CLIP_GLSL, SCENE_CLIP_UNIFORMS } from './scene';

const CLIPPED = Symbol('flytake-scene-clip');
type ClipMaterial = Material & { [CLIPPED]?: true };

const VERTEX_DECL = /* glsl */ `
varying vec3 vSceneClipWorld;
`;
const VERTEX_BODY = /* glsl */ `
vSceneClipWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const FRAGMENT_DECL = /* glsl */ `
varying vec3 vSceneClipWorld;
${SCENE_CLIP_GLSL}
`;
const FRAGMENT_BODY = /* glsl */ `
{
  float sceneCover = flytakeSceneCover(vSceneClipWorld);
  if (sceneCover > 0.0 && sceneCover >= flytakeBayer(gl_FragCoord.xy)) discard;
}
`;

/**
 * Hides a material's fragments inside the custom Emerald Bay scene (dithered across the
 * feather band), so the Google tiles / old water plane give way to the lidar terrain.
 * Chains any existing onBeforeCompile.
 */
export function patchSceneClip(material: ClipMaterial): void {
  if (material[CLIPPED]) return;
  material[CLIPPED] = true;
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function onBeforeCompileClip(this: Material, shader: WebGLProgramParametersWithUniforms, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, SCENE_CLIP_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAGMENT_BODY}`);
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|scene-clip`;
  material.needsUpdate = true;
}
