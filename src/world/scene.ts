import { Matrix4, Vector3 } from 'three';
import { EMERALD_BAY_ORIGIN, emeraldBayFrame } from '../geo/locations';
import { geodeticToEcef } from '../geo/wgs84';

/**
 * The custom-built Emerald Bay scene (tools/scene → public/scene): lidar terrain tiles, the
 * lidar forest and its water. Everything is authored in the ENU frame of EMERALD_BAY_ORIGIN
 * (Fannette Island at TAHOE.lakeEllipsoidHeight). Inside SCENE_EXTENT the Google tiles and the
 * old water plane are hidden. Keep in sync with tools/scene/common.py.
 */
export const SCENE_EXTENT = { east: [-4000, 4000], north: [-3500, 4200] } as const;
/** Google tiles fade out over this band inside the extent edge (m). */
export const SCENE_FEATHER = 160;
/** hydro-flattened lake surface of the 3DEP DEM, metres above EMERALD_BAY_ORIGIN.height */
export const SCENE_LAKE_LEVEL = 1873.79 - EMERALD_BAY_ORIGIN.height;
/** 15:00 PST on demo day: the baked shadows were computed for this sun (see config.ts) */
export const SCENE_SUN_TIME = '2026-11-07T23:00:00Z';

export const SCENE_FRAME = emeraldBayFrame();
export const SCENE_FRAME_INV = SCENE_FRAME.clone().invert();

const east = new Vector3();
const north = new Vector3();
const up = new Vector3();
SCENE_FRAME.extractBasis(east, north, up);

/** Shader uniforms for the footprint test on ECEF world positions (float32 is ~0.5 m there). */
export const SCENE_CLIP_UNIFORMS = {
  uSceneOrigin: { value: geodeticToEcef(EMERALD_BAY_ORIGIN.lat, EMERALD_BAY_ORIGIN.lon, EMERALD_BAY_ORIGIN.height) },
  uSceneEast: { value: east.clone() },
  uSceneNorth: { value: north.clone() },
  /** (eMin, eMax, nMin, nMax) */
  uSceneBox: { value: [SCENE_EXTENT.east[0], SCENE_EXTENT.east[1], SCENE_EXTENT.north[0], SCENE_EXTENT.north[1]] },
  uSceneFeather: { value: SCENE_FEATHER },
  /** 0 = custom scene off (Google everywhere) */
  uSceneOn: { value: 1 },
};

/**
 * GLSL: 1 inside the custom scene (fully), 0 outside, ramping across the feather band.
 * Requires the SCENE_CLIP_UNIFORMS declarations.
 */
export const SCENE_CLIP_GLSL = /* glsl */ `
uniform vec3 uSceneOrigin;
uniform vec3 uSceneEast;
uniform vec3 uSceneNorth;
uniform float uSceneBox[4];
uniform float uSceneFeather;
uniform float uSceneOn;
float flytakeSceneCover(vec3 worldPos) {
  vec3 d = worldPos - uSceneOrigin;
  float e = dot(d, uSceneEast);
  float n = dot(d, uSceneNorth);
  float inset = min(min(e - uSceneBox[0], uSceneBox[1] - e), min(n - uSceneBox[2], uSceneBox[3] - n));
  return uSceneOn * smoothstep(0.0, uSceneFeather, inset);
}
// ordered 4x4 Bayer threshold for dithered fades
float flytakeBayer(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}
`;

/** ENU (east, north, up) of an ECEF point in the scene frame. */
export function toSceneEnu(ecef: Vector3, out = new Vector3()): Vector3 {
  return out.copy(ecef).applyMatrix4(SCENE_FRAME_INV);
}

/** ECEF of an ENU point in the scene frame. */
export function fromSceneEnu(enu: Vector3, out = new Vector3()): Vector3 {
  return out.copy(enu).applyMatrix4(SCENE_FRAME);
}

export function insideScene(enu: Vector3, margin = 0): boolean {
  return (
    enu.x > SCENE_EXTENT.east[0] + margin &&
    enu.x < SCENE_EXTENT.east[1] - margin &&
    enu.y > SCENE_EXTENT.north[0] + margin &&
    enu.y < SCENE_EXTENT.north[1] - margin
  );
}

export const SCENE_IDENTITY = new Matrix4();

/** Objects drawn into the lake's planar reflection (terrain tiles, forest). */
export const REFLECTION_LAYER = 3;
