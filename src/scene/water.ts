import { MathUtils, Matrix3, Vector3, type Material, type Texture, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { FLAGS } from '../config';
import { TAHOE } from '../geo/locations';
import { enuVectors, geodeticToEcef } from '../geo/wgs84';
import { SCENE_LIGHT } from '../world/light';
import { SCENE_FRAME_INV } from '../world/scene';
import { WATER_ASSET_UNIFORMS } from '../world/waterAssets';
import { WATER_COMMON_GLSL, WATER_FAR_GLSL } from '../world/waterCommon';

/**
 * Water recolouring in the tile shader.
 *
 * Google's imagery of Lake Tahoe is stitched from captures with different water colours, so
 * neighbouring tiles (and different LODs of the same area) show straight-edged light / dark
 * blue rectangles, plus white specks (boats, glints) on Emerald Bay. Lake-level, blue-dominant
 * texels inside the lake's bounding box are replaced by one deep-water albedo with a Fresnel
 * lift towards the horizon (the AerialPerspective pass then lights and hazes it like any
 * other ground). Turquoise shallows, sand, rock, forest and Fannette Island fail the colour or
 * height tests and keep their imagery; the blurred texture sample decides the test so specks
 * do not punch holes into it.
 *
 * Google's ocean seen from orbit is a pale shaded-relief seafloor map; sea-level, blue texels
 * are darkened so the atmosphere supplies the blue and the sunlit land reads.
 *
 * Debug: ?water=0 disables it, ?water=debug paints the lake mask red and the ocean magenta.
 */

const LAKE_CENTER = { lat: 39.09, lon: -120.045 };
const BAY_CENTER = { lat: 38.9585, lon: -120.0925 };
/** Cascade Lake: ~68 m above Tahoe, 1 km south of Emerald Bay (centre measured on the tiles). */
const CASCADE_LAKE = { lat: 38.9419, lon: -120.0906, height: TAHOE.lakeEllipsoidHeight + 68 };

const east = new Vector3();
const north = new Vector3();
const up = new Vector3();
enuVectors(LAKE_CENTER.lat, LAKE_CENTER.lon, east, north, up);

/**
 * One object shared by every patched material (exposed as window.__flytake.water for look-dev).
 * Colours are linear albedo; the AerialPerspective pass lights them with the (orange, low) sun
 * only, so they carry more blue than the water looks in the end.
 */
export const WATER_UNIFORMS = {
  // Tuned at the hero view: bay ~(50, 90, 110) sRGB, main lake a deep sapphire that lifts
  // smoothly towards the horizon (Fresnel) instead of in tile-shaped steps.
  uDeep: { value: new Vector3(0.004, 0.022, 0.16) },
  uDeepBay: { value: new Vector3(0.005, 0.05, 0.11) },
  uReflect: { value: new Vector3(0.08, 0.17, 0.45) },
  uLakeCenter: { value: geodeticToEcef(LAKE_CENTER.lat, LAKE_CENTER.lon, TAHOE.lakeEllipsoidHeight) },
  uLakeEast: { value: east },
  uLakeNorth: { value: north },
  uLakeUp: { value: up },
  uBayCenter: { value: geodeticToEcef(BAY_CENTER.lat, BAY_CENTER.lon, TAHOE.lakeEllipsoidHeight) },
  uCascade: { value: geodeticToEcef(CASCADE_LAKE.lat, CASCADE_LAKE.lon, CASCADE_LAKE.height) },
  /** seconds, drives the close-up ripples (advanced by CameraDirector) */
  uFlyTime: { value: 0 },
  /**
   * Water surface, metres above TAHOE.lakeEllipsoidHeight. Tahoe is so clear that Google's
   * photogrammetry reconstructed the sandy bottom of the shallows (draped with water imagery)
   * instead of a flat surface; raycasts put open water at +1..3 m and the beach at +2.5..3.
   */
  uWaterLevel: { value: 2.6 },
  /** albedo of sun-lit sand seen through 0-3 m of clear water (Tahoe's turquoise rim) */
  uShallow: { value: new Vector3(0.018, 0.105, 0.115) },
};
/** ECEF -> Emerald Bay scene ENU rotation (the sky probe and the sun live in that frame) */
const ECEF_TO_ENU = { value: new Matrix3().setFromMatrix4(SCENE_FRAME_INV) };
const SHARED_UNIFORMS = { ...WATER_UNIFORMS, ...SCENE_LIGHT, ...WATER_ASSET_UNIFORMS, uEcefToEnu: ECEF_TO_ENU };

/**
 * Height tolerance (m) of the lake-level test; texels pass up to 1x and fade out by 2x above
 * the lake. Coarse tiles' simplified meshes sit further from the true surface, so the band
 * scales with the tile's geometric error (x0.2, ?watertol=). Raycasts put Google's water mesh
 * 1-3 m above TAHOE.lakeEllipsoidHeight in the bay on fine tiles and ~9 m above it on coarse
 * ones; a wider band (x0.5) let shadowed low shoreline land into the mask. The two
 * higher lakes inside the box (Cascade, Fallen Leaf) are excluded by position instead, so they
 * look the same at every LOD.
 */
export function waterTolerance(geometricError: number): number {
  const ge = Number.isFinite(geometricError) ? geometricError : 0;
  return MathUtils.clamp(ge * FLAGS.waterTolerance, 4, 150);
}

/**
 * Same for the sea-level test. Planet-scale tiles (geometric error 16-130 km) are a few huge
 * flat triangles whose vertices sit kilometres above the ellipsoid and whose middles sag
 * kilometres below it, so there the colour test alone decides.
 */
export function oceanTolerance(geometricError: number): number {
  const ge = Number.isFinite(geometricError) ? geometricError : 0;
  return MathUtils.clamp(ge * 0.5, 250, 50_000);
}

const VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vFlyWorld;
`;

const VERTEX_BODY = /* glsl */ `
vFlyWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec3 vFlyWorld;
uniform vec3 uLakeCenter;
uniform vec3 uLakeEast;
uniform vec3 uLakeNorth;
uniform vec3 uLakeUp;
uniform vec3 uBayCenter;
uniform vec3 uCascade;
uniform vec3 uDeep;
uniform vec3 uDeepBay;
uniform vec3 uReflect;
uniform float uFlyWaterTol;
uniform float uFlyOceanTol;
uniform float uFlyTime;
uniform float uWaterLevel;
uniform vec3 uShallow;
uniform vec3 uSunDir;
uniform float uFlatSunInv;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform mat3 uEcefToEnu;
uniform float uWaterOn;
${WATER_COMMON_GLSL}
${WATER_FAR_GLSL}
`;

const FRAGMENT_BODY = /* glsl */ `
#if defined(FLYTAKE_WATER) && defined(USE_MAP)
{
  // Lake Tahoe: height above the lake surface, corrected for curvature (2R = 12.75e6 m).
  // One-sided: nothing in the lake's box lies below the lake surface except water, and coarse
  // tiles' flat triangles sag below it (chord sag), so only "too high" is rejected.
  vec3 d = vFlyWorld - uLakeCenter;
  float e = dot(d, uLakeEast);
  float n = dot(d, uLakeNorth);
  float hLake = dot(d, uLakeUp) + (e * e + n * n) / 12.75e6;
  // box: the south edge (38.93 N) runs between Tahoe's south shore (38.94) and Fallen Leaf
  // Lake (north tip 38.92, ~70 m higher); Cascade Lake is cut out by distance.
  float inLake = step(abs(e), 11500.0) * step(-17700.0, n) * step(n, 19500.0)
    * step(750.0, length(vFlyWorld - uCascade));
  float band = 1.0 - smoothstep(uFlyWaterTol, 2.0 * uFlyWaterTol, hLake);

  // Colour tests run on a blurred sample (two mip levels above the one in use), so specks and
  // glints do not punch holes into them. The blurred sample bleeds atlas gutters in along tile
  // edges, so a strongly blue sharp sample (deep water; shadows on land are never this blue)
  // also passes.
  //
  // Close-up water (a drone flying low): the imagery is magnified and seen at grazing angles
  // until its JPEG blocks show, and both the per-texel colour tests and the luma "detail" turn
  // them into a checkerboard. When the camera itself is low over the lake (drone heights, not
  // the 520 m hero view), nearby lake-level texels that are not land are drawn as one clean
  // water surface with soft procedural ripples, and the luma detail is dropped further out.
  vec3 flyCam = cameraPosition - uLakeCenter;
  float flyCamE = dot(flyCam, uLakeEast);
  float flyCamN = dot(flyCam, uLakeNorth);
  float flyCamH = dot(flyCam, uLakeUp) + (flyCamE * flyCamE + flyCamN * flyCamN) / 12.75e6;
  float flyLow = 1.0 - smoothstep(90.0, 320.0, flyCamH);
  float flyDist = length(cameraPosition - vFlyWorld);
  float flyNear = flyLow * (1.0 - smoothstep(90.0, 320.0, flyDist));
  float flyClose = flyLow * (1.0 - smoothstep(400.0, 1600.0, flyDist));
  vec2 flyTexel = vMapUv * vec2(textureSize(map, 0));
  vec2 flyDx = dFdx(flyTexel);
  vec2 flyDy = dFdy(flyTexel);
  float flyLod = 0.5 * log2(max(max(dot(flyDx, flyDx), dot(flyDy, flyDy)), 1e-8));
  vec3 cb = texture2D(map, vMapUv, 2.0).rgb;
  // land test for the close-up override: blurred past the JPEG blocks, not across the beach
  vec3 cn = textureLod(map, vMapUv, max(flyLod + 1.0, 5.0)).rgb;
  vec3 cs = diffuseColor.rgb;
  float invBb = 1.0 / max(cb.b, 1e-4);
  float invBs = 1.0 / max(cs.b, 1e-4);
  float deepSharp = (1.0 - flyNear) * (1.0 - smoothstep(0.50, 0.62, cs.g * invBs)) * (1.0 - smoothstep(0.60, 0.75, cs.r * invBs));
  // grey-blue water imagery sits at r/b ~0.6-0.9; sand and granite at ~1.1-1.6
  // only in the metre above the water level: lower is water by height, higher is land
  float flyAbove = hLake - uWaterLevel;
  float nearWater = flyNear * (1.0 - smoothstep(0.98, 1.12, cn.r / max(cn.b, 1e-4)))
    * (1.0 - smoothstep(0.5, 1.0, flyAbove));
  float lakeColour = max(max(deepSharp,
    (1.0 - smoothstep(0.62, 0.90, cb.g * invBb))     // keep turquoise shallows
    * (1.0 - smoothstep(0.85, 1.00, cb.r * invBb))), // keep sand, rock and forest
    nearWater);

  // Close up and low: anything in the lake below the water surface is lake bottom seen through
  // the water, so it is drawn as water (lighter over the shallows), whatever its imagery says.
  float flyDepth = uWaterLevel - hLake;
  float underwater = flyClose * inLake * smoothstep(-0.2, 0.3, flyDepth);
  float water = max(inLake * band * lakeColour, underwater);

  // Open ocean: near or below sea level (tolerance from the tile's geometric error) and
  // blue-dominant. Never inside the Tahoe box, so the lake looks the same at every LOD.
  vec3 dir = normalize(vFlyWorld);
  float hE = length(vFlyWorld) - inversesqrt(dot(dir.xy, dir.xy) / 4.0680631590769e13 + dir.z * dir.z / 4.0408299984661e13);
  float ocean = (1.0 - smoothstep(uFlyOceanTol, 2.0 * uFlyOceanTol, hE)) * (1.0 - inLake)
    * max(deepSharp, 1.0 - smoothstep(0.62, 0.80, max(cb.r, cb.g) * invBb));

  #if FLYTAKE_WATER == 3
  diffuseColor.rgb = cn; // look-dev: the blurred sample used by the close-up land test
  #elif FLYTAKE_WATER == 2
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.0, 0.0), water);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.0, 1.0), ocean);
  #else
  vec3 V = normalize(cameraPosition - vFlyWorld);
  float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(V, uLakeUp), 0.0, 1.0), 5.0);
  float bay = 1.0 - smoothstep(900.0, 1800.0, length(vFlyWorld - uBayCenter));
  vec3 deep = mix(uDeep, uDeepBay, bay); // slight emerald tint in the bay
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  float detail = mix(clamp(dot(cs, LUMA) / max(dot(cb, LUMA), 1e-4), 0.9, 1.08), 1.0, flyClose);
  // Ripples (close up only): a few incommensurate swells, wavelengths ~1-4 m, drifting slowly;
  // faded out where a pixel spans too much water to resolve them (no moire towards the horizon).
  vec2 rp = vec2(e, n);
  float rippleRes = 1.0 - smoothstep(0.12, 0.45, length(fwidth(rp)));
  float ripple = flyNear * rippleRes * (
      sin(dot(rp, vec2(0.83, 0.55)) * 1.70 + uFlyTime * 1.30)
    + sin(dot(rp, vec2(-0.41, 0.91)) * 2.90 - uFlyTime * 1.70)
    + 0.6 * sin(dot(rp, vec2(0.97, -0.24)) * 5.30 + uFlyTime * 2.30)
    + 0.4 * sin(dot(rp, vec2(-0.66, -0.75)) * 8.10 - uFlyTime * 2.90)) / 3.0;
  float Fr = clamp(F * (1.0 + 0.45 * ripple) + 0.015 * ripple, 0.0, 1.0);
  float shallow = underwater * (1.0 - smoothstep(0.4, 3.5, flyDepth));
  vec3 body = mix(deep, uShallow, 0.85 * shallow);
  vec3 flyCol = mix(body, uReflect, Fr) * detail;
  // once the sky probe exists: the custom lake's light model (sky reflection, sun glints), so
  // the water matches across the edge of the lidar scene; close-up shallows keep the above
  if (uSkyOn > 0.5 && uWaterOn > 0.5) {
    vec3 Ve = normalize(uEcefToEnu * V);
    vec3 Ne = normalize(uEcefToEnu * uLakeUp);
    flyCol = mix(flyFarWater(Ve, Ne, bay) * detail, flyCol, shallow);
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, flyCol, water);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * 0.25, vec3(0.010, 0.022, 0.050), 0.6), ocean);
  #endif
}
#endif
`;

const PATCHED = Symbol('flytake-water');

type WaterMaterial = Material & {
  map?: Texture | null;
  defines?: Record<string, unknown>;
  [PATCHED]?: true;
};

function inject(source: string, anchor: string, code: string): string {
  if (!source.includes(anchor)) {
    console.warn(`[flytake] water patch: ${anchor} not found`);
    return source;
  }
  return source.replace(anchor, `${anchor}\n${code}`);
}

/**
 * Adds the water recolouring to a tile material. Chains any existing onBeforeCompile (the
 * fade plugin wraps the same way), so the order the two are applied in does not matter.
 */
export function patchWaterMaterial(material: WaterMaterial, geometricError: number): void {
  if (FLAGS.water === 'off' || material.map == null || material[PATCHED]) return;
  material[PATCHED] = true;

  const tolerance = { value: waterTolerance(geometricError) };
  const oceanTol = { value: oceanTolerance(geometricError) };
  material.defines = { ...(material.defines ?? {}), FLYTAKE_WATER: FLAGS.water === 'debug' ? 2 : FLAGS.water === 'blur' ? 3 : 1 };

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function onBeforeCompileWater(
    this: Material,
    shader: WebGLProgramParametersWithUniforms,
    renderer: WebGLRenderer,
  ) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, SHARED_UNIFORMS, { uFlyWaterTol: tolerance, uFlyOceanTol: oceanTol });
    shader.vertexShader = inject(
      inject(shader.vertexShader, '#include <common>', VERTEX_DECLARATIONS),
      '#include <project_vertex>',
      VERTEX_BODY,
    );
    shader.fragmentShader = inject(
      inject(shader.fragmentShader, '#include <common>', FRAGMENT_DECLARATIONS),
      '#include <map_fragment>',
      FRAGMENT_BODY,
    );
  };
  material.needsUpdate = true;
}
