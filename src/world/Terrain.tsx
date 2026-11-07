import { useThree } from '@react-three/fiber';
import { LRUCache, PriorityQueue, type TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer';
import { TilesFadePlugin } from '3d-tiles-renderer/plugins';
import { TilesPlugin, TilesRenderer } from '3d-tiles-renderer/r3f';
import { useCallback, useEffect, useMemo, type FC } from 'react';
import {
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
  type Camera,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { SCENE_LIGHT } from './light';
import { SCENE_FRAME_INV, SCENE_LAKE_LEVEL } from './scene';
import { world } from './handles';
import { REFLECTION_LAYER } from './scene';
import { SHADOW_GLSL, SHADOW_UNIFORMS } from './shadowGlsl';
import { WATER_GLSL, WATER_SHADING_UNIFORMS } from './waterShading';

export { REFLECTION_UNIFORMS } from './waterShading';

/**
 * Lidar terrain of Emerald Bay (public/scene/terrain, built by tools/scene/build_tiles.py):
 * a 3D Tiles quadtree of RTIN-simplified height meshes with an RGBA texture per tile (RGB albedo,
 * A sky occlusion) and an ENU normal map from the 1 m terrain.
 *
 * The material outputs pre-lit albedo (see light.ts), lit by the live sun (sun.ts) with shadows
 * from the GPU shadow field (shadowGlsl.ts / shadowField.ts). Up close five CC0 ground
 * materials (sand, decomposed-granite gravel, pine needles, granite, dry ground) add colour
 * structure and normal detail on top of the imagery. Lake pixels (the hydro-flattened lake
 * surface) are shaded as water by waterShading.ts.
 */
const FADE_ARGS = [{ fadeDuration: 350, maximumFadeOutTiles: 120 }];
const ownQueues = new WeakSet<object>();

/** ground materials: texture-array layer order, mean linear albedo of the colour map, scale (m) */
const MATERIALS = [
  { name: 'sand', mean: [0.2281, 0.1747, 0.1108], scale: 3.0 },
  { name: 'gravel', mean: [0.2938, 0.1632, 0.0776], scale: 2.6 },
  { name: 'needles', mean: [0.243, 0.131, 0.0579], scale: 2.2 },
  { name: 'granite', mean: [0.4011, 0.3401, 0.2733], scale: 4.0 },
  { name: 'dryground', mean: [0.3193, 0.1878, 0.0879], scale: 3.0 },
] as const;

const VERTEX_DECL = /* glsl */ `
uniform mat4 uTileToScene;
varying vec3 vScene;
`;
const VERTEX_BODY = /* glsl */ `
vScene = (uTileToScene * vec4(transformed, 1.0)).xyz;
`;
const FRAGMENT_DECL = /* glsl */ `
uniform mat4 uTileToScene;
uniform vec3 uSunDir;
uniform float uFlatSunInv;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uSceneCam;
uniform float uLakeLevel;
uniform sampler2DArray uMatC;
uniform sampler2DArray uMatN;
uniform float uMatOn;
varying vec3 vScene;
${SHADOW_GLSL}
${WATER_GLSL}

// ground materials (CC0, Poly Haven; public/textures/terrain): layer, mean linear albedo, scale (m)
#define M_SAND 0
#define M_GRAVEL 1
#define M_NEEDLES 2
#define M_GRANITE 3
#define M_DRY 4
const vec3 M_MEAN[5] = vec3[5](${MATERIALS.map((m) => `vec3(${m.mean.join(', ')})`).join(', ')});
const float M_SCALE[5] = float[5](${MATERIALS.map((m) => m.scale.toFixed(2)).join(', ')});
const mat2 M_ROT = mat2(0.8, -0.6, 0.6, 0.8);
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float flyTHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float flyTNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(flyTHash(i), flyTHash(i + vec2(1, 0)), f.x), mix(flyTHash(i + vec2(0, 1)), flyTHash(i + vec2(1, 1)), f.x), f.y);
}

/**
 * One ground material at p: colour relative to its mean (rgb), height (a), and the ENU xy
 * perturbation of its normal map. Two octaves: the near one (scale) and a rotated macro one
 * (4.3 x scale) that stays on to mid distance, so neither repeats visibly.
 */
vec4 flyMat(int i, vec2 p, float nearW, float macroW, out vec2 dn) {
  vec2 q = vec2(p.x, -p.y);
  vec3 c = vec3(1.0);
  float h = 0.5;
  dn = vec2(0.0);
  if (macroW > 0.0) {
    vec2 uv = M_ROT * q / (M_SCALE[i] * 4.3) + 0.37;
    vec3 cb = texture(uMatC, vec3(uv, float(i))).rgb / M_MEAN[i];
    vec4 nb = texture(uMatN, vec3(uv, float(i)));
    c = mix(vec3(1.0), cb, macroW * 0.7);
    h = mix(h, nb.b, macroW);
    dn += (M_ROT * (nb.xy * 2.0 - 1.0)) * macroW * 0.6;
  }
  if (nearW > 0.0) {
    vec2 uv = q / M_SCALE[i];
    vec3 ca = texture(uMatC, vec3(uv, float(i))).rgb / M_MEAN[i];
    vec4 na = texture(uMatN, vec3(uv, float(i)));
    c *= mix(vec3(1.0), ca, nearW);
    h = mix(h, 0.5 * h + 0.5 * na.b, nearW);
    dn += (na.xy * 2.0 - 1.0) * nearW;
  }
  return vec4(c, h);
}
`;
const FRAGMENT_BODY = /* glsl */ `
{
  float ao = diffuseColor.a;
  vec3 albedo = diffuseColor.rgb;
  diffuseColor.a = 1.0;
  vec3 toCam = uSceneCam - vScene;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-3);
  // height above the lake surface (curvature-corrected; the lake mesh is flat on the ellipsoid)
  float hLake = flyHgt(vScene) - uLakeLevel;
  float water = flyWaterMask(hLake, vScene.xy);
  vec2 p = vScene.xy;

  // shading normal: the tile's ENU normal map (1 m terrain at the finest level)
  float rockiness = 0.0;
  #ifdef USE_NORMALMAP
  vec4 nt = texture2D(normalMap, vNormalMapUv);
  vec3 N = normalize(nt.xyz * 2.0 - 1.0);
  rockiness = nt.a;
  #else
  vec3 N = normalize(cross(dFdx(vScene), dFdy(vScene)));
  if (N.z < 0.0) N = -N;
  #endif
  float sunVis = flySunVis(vScene + vec3(0.0, 0.0, 0.25), mix(0.6, 3.0, smoothstep(150.0, 1500.0, dist)));

  // --- ground materials, weighted from the imagery, slope, height above the lake and the
  // canopy (sky occlusion), height-blended, two octaves; the imagery keeps the regional colour
  float px = length(fwidth(p));
  float on = uMatOn * (1.0 - water);
  float nearW = (1.0 - smoothstep(0.06, 0.4, px)) * on;
  float macroW = (1.0 - smoothstep(0.6, 3.0, px)) * on;
  vec3 matDbg = vec3(0.0);
  if (macroW > 0.001) {
    float lum = dot(albedo, LUMA);
    float mx = max(albedo.r, max(albedo.g, albedo.b));
    float sat = (mx - min(albedo.r, min(albedo.g, albedo.b))) / max(mx, 1e-4);
    float slope = 1.0 - N.z;
    float n1 = flyTNoise(p * 0.11);
    float n2 = flyTNoise(p * 0.043 + 7.3);
    float n3 = flyTNoise(p * 0.21 + 3.1);
    float wSand = (1.0 - smoothstep(1.2, 4.5, hLake + 2.0 * (n1 - 0.5))) * (1.0 - smoothstep(0.10, 0.28, slope)) * smoothstep(0.04, 0.09, lum);
    float wRock = max(smoothstep(0.25, 0.65, rockiness + 0.25 * (n2 - 0.5)), smoothstep(0.32, 0.58, slope + 0.12 * (n2 - 0.5)));
    float wForest = max(1.0 - smoothstep(0.5, 0.85, ao + 0.15 * (n3 - 0.5)), 1.0 - smoothstep(0.04, 0.08, lum));
    wSand *= 1.0 - wRock;
    wForest *= (1.0 - wSand) * (1.0 - 0.9 * wRock);
    float open = max(0.0, 1.0 - wSand - wRock - wForest) + 0.08;
    float g = smoothstep(0.3, 0.7, n2 + 1.5 * (0.22 - sat));
    // Tahoe beaches are coarse decomposed-granite sand: mostly gravelly, finer sand in patches
    float fine = smoothstep(0.45, 0.75, n3);
    float w[5] = float[5](wSand * fine, open * g + wSand * (1.0 - fine), wForest, wRock, open * (1.0 - g));
    vec3 cs[5];
    vec2 ns[5];
    float best = 0.0;
    for (int i = 0; i < 5; i++) {
      cs[i] = vec3(1.0);
      ns[i] = vec2(0.0);
      if (w[i] > 0.02) {
        vec4 m = flyMat(i, p, nearW, macroW, ns[i]);
        cs[i] = m.rgb;
        // height blend: taller texels of a material win the transitions (crisp, natural edges)
        w[i] *= 0.25 + 1.5 * m.a;
      } else {
        w[i] = 0.0;
      }
      best = max(best, w[i]);
    }
    vec3 dc = vec3(0.0);
    vec2 dn = vec2(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 5; i++) {
      float k = max(w[i] - best * 0.55, 0.0);
      dc += cs[i] * k;
      dn += ns[i] * k;
      wsum += k;
    }
    dc /= max(wsum, 1e-4);
    dn /= max(wsum, 1e-4);
    matDbg = vec3(max(w[0] - best * 0.55, 0.0) + max(w[4] - best * 0.55, 0.0), max(w[2] - best * 0.55, 0.0), max(w[3] - best * 0.55, 0.0) + max(w[1] - best * 0.55, 0.0) * 0.5) / max(wsum, 1e-4);
    // keep the imagery's hue, take the material's luminance structure and part of its colour;
    // on rock, lean further on the granite (the imagery there is a blur of rock, duff and shade)
    float dl = dot(dc, LUMA);
    float rockK = max(w[3] - best * 0.55, 0.0) / max(wsum, 1e-4);
    albedo *= clamp(mix(vec3(dl), dc, 0.55), 0.0, 3.0);
    // Sierra granite: light grey, darker weathered / lichen patches and streaks
    float lichen = smoothstep(0.45, 0.8, flyTNoise(p * 0.6 + 5.0) * 0.6 + flyTNoise(p * 2.3) * 0.4);
    vec3 granite = vec3(0.125, 0.123, 0.118) * pow(dc, vec3(1.6)) * mix(0.6, 1.15, flyTNoise(p * 0.35 + 11.0)) * mix(1.0, 0.45, lichen);
    albedo = mix(albedo, granite, rockK * 0.9 * macroW);
    // relief: sand and needles have faint normal maps, granite strong ones
    float sandK = max(w[0] - best * 0.55, 0.0) / max(wsum, 1e-4);
    N = normalize(N + vec3(dn * (0.85 + 1.2 * sandK + 0.4 * rockK), 0.0));
    // crevices between stones / needles hold less sky light
    ao *= mix(1.0, clamp(0.55 + 0.6 * dl, 0.5, 1.0), nearW);
  }

  float direct = sunVis * max(dot(N, uSunDir), 0.0);
  vec3 land = albedo * (direct * uSunColor + uAmbient * ao * (0.65 + 0.35 * N.z)) * uFlatSunInv;
  land = flyShore(land, albedo, vScene, hLake, dist);
  vec3 lake = flyWater(albedo, vScene, V, dist, sunVis, hLake);
  diffuseColor.rgb = mix(land, lake, water);
  #ifdef FLYTAKE_TERRAIN_DEBUG
  diffuseColor.rgb = vec3(fract(vScene.z / 20.0), water, fract(vScene.x / 500.0)) * uFlatSunInv;
  #endif
  #ifdef FLYTAKE_TERRAIN_MAT
  diffuseColor.rgb = (matDbg * 0.5 + vec3(0.0, 0.0, water * 0.3)) * uFlatSunInv;
  #endif
  #ifdef FLYTAKE_TERRAIN_SHADOW
  diffuseColor.rgb = vec3(sunVis * 0.5, max(dot(N, uSunDir), 0.0) * 0.5, water * 0.3) * uFlatSunInv;
  #endif
}
`;

const PATCHED = Symbol('flytake-terrain');
type TerrainMaterial = Material & { map?: Texture | null; [PATCHED]?: true };

const sceneCam = { value: SCENE_LIGHT.uSunDir.value.clone() };

/** ground material texture arrays (loaded once by <Terrain>) */
export const MATERIAL_UNIFORMS = {
  uMatC: { value: null as DataArrayTexture | null },
  uMatN: { value: null as DataArrayTexture | null },
  uMatOn: { value: 0 },
};
let materialsLoading = false;

/** Decodes same-sized images into one RGBA8 texture array (layer i = urls[i]). */
async function loadArray(urls: string[], size: number, srgb: boolean, anisotropy: number): Promise<DataArrayTexture> {
  const data = new Uint8Array(size * size * 4 * urls.length);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  for (let i = 0; i < urls.length; i++) {
    const blob = await (await fetch(urls[i]!)).blob();
    const bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
      resizeWidth: size,
      resizeHeight: size,
      resizeQuality: 'high',
    });
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    data.set(ctx.getImageData(0, 0, size, size).data, i * size * size * 4);
  }
  const tex = new DataArrayTexture(data, size, size, urls.length);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function loadMaterials(anisotropy: number): void {
  if (materialsLoading) return;
  materialsLoading = true;
  const names = MATERIALS.map((m) => m.name);
  Promise.all([
    loadArray(names.map((n) => `/textures/terrain/${n}_c.jpg`), 2048, true, anisotropy),
    loadArray(names.map((n) => `/textures/terrain/${n}_n.jpg`), 1024, false, anisotropy),
  ])
    .then(([c, n]) => {
      MATERIAL_UNIFORMS.uMatC.value = c;
      MATERIAL_UNIFORMS.uMatN.value = n;
      MATERIAL_UNIFORMS.uMatOn.value = 1;
      world.materials = MATERIAL_UNIFORMS;
    })
    .catch((err: unknown) => console.warn('[flytake] ground materials failed', err));
}

const lakeLevel = { value: SCENE_LAKE_LEVEL };

function patchTerrainMaterial(material: TerrainMaterial, mesh: Mesh): void {
  if (material[PATCHED] || material.map == null) return;
  material[PATCHED] = true;
  const tileToScene = { value: new Matrix4() };
  // tile -> scene ENU, computed in float64 every frame the mesh renders
  mesh.onBeforeRender = () => {
    tileToScene.value.multiplyMatrices(SCENE_FRAME_INV, mesh.matrixWorld);
  };
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function onBeforeCompileTerrain(this: Material, shader: WebGLProgramParametersWithUniforms, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, SCENE_LIGHT, SHADOW_UNIFORMS, WATER_SHADING_UNIFORMS, MATERIAL_UNIFORMS, {
      uTileToScene: tileToScene,
      uSceneCam: sceneCam,
      uLakeLevel: lakeLevel,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAGMENT_BODY}`)
      // the colour computed above is the output: no three.js lighting (the tiles' glTF material
      // is a lit one only so that GLTFLoader keeps the normal map)
      .replace('#include <opaque_fragment>', 'gl_FragColor = vec4(diffuseColor.rgb, 1.0);');
  };
  // the program differs from plain MeshBasicMaterial: give it its own cache key
  material.customProgramCacheKey = () => 'flytake-terrain';
  const debug = new URLSearchParams(location.search).get('terrain');
  const DEBUG_DEFINES: Record<string, string> = { debug: 'FLYTAKE_TERRAIN_DEBUG', shadow: 'FLYTAKE_TERRAIN_SHADOW', mat: 'FLYTAKE_TERRAIN_MAT' };
  if (debug != null && DEBUG_DEFINES[debug]) {
    (material as Material & { defines?: Record<string, unknown> }).defines = { [DEBUG_DEFINES[debug]!]: 1 };
  }
  material.needsUpdate = true;
}

/** Updates the camera position in scene ENU (float64 on the CPU) for the terrain shader. */
export function updateTerrainCamera(camera: Camera): void {
  sceneCam.value.copy(camera.position).applyMatrix4(SCENE_FRAME_INV);
}

export const Terrain: FC = () => {
  const gl = useThree((s) => s.gl);
  const anisotropy = useMemo(() => Math.min(8, gl.capabilities.getMaxAnisotropy()), [gl]);
  useEffect(() => loadMaterials(Math.min(8, gl.capabilities.getMaxAnisotropy())), [gl]);

  const setTiles = useCallback((tiles: TilesRendererImpl | null) => {
    if (tiles && !ownQueues.has(tiles)) {
      // The tiles renderers share one LRU cache and one parse queue by default: the Google
      // tiles (hundreds in flight during the fly-in) would starve the lidar terrain, which then
      // sits at coarse LODs for many seconds. Give the terrain its own cache and parse queue.
      ownQueues.add(tiles);
      const parse = new PriorityQueue();
      parse.maxJobs = 8;
      parse.priorityCallback = tiles.parseQueue.priorityCallback;
      tiles.parseQueue = parse;
      const lru = new LRUCache();
      lru.unloadPriorityCallback = tiles.lruCache.unloadPriorityCallback;
      lru.maxBytesSize = 1100 * 2 ** 20;
      lru.minBytesSize = 800 * 2 ** 20;
      lru.maxSize = 3000;
      lru.minSize = 2000;
      tiles.lruCache = lru;
    }
    world.terrain = tiles;
  }, []);

  const onLoadModel = useCallback(
    ({ scene }: { scene: Object3D }) => {
      scene.traverse((object) => {
        const mesh = object as Mesh;
        const material = mesh.material as TerrainMaterial | undefined;
        if (material == null || Array.isArray(material)) return;
        if (material.map) material.map.anisotropy = anisotropy;
        const nm = (material as Material & { normalMap?: Texture | null }).normalMap;
        if (nm) nm.anisotropy = anisotropy;
        patchTerrainMaterial(material, mesh);
        mesh.layers.enable(REFLECTION_LAYER);
      });
    },
    [anisotropy],
  );

  return (
    <TilesRenderer
      ref={setTiles}
      url="/scene/terrain/tileset.json"
      errorTarget={2}
      onLoadModel={onLoadModel}
    >
      <TilesPlugin plugin={TilesFadePlugin} args={FADE_ARGS} />
    </TilesRenderer>
  );
};
