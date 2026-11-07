/**
 * Lake Tahoe / Emerald Bay points of interest.
 *
 * Heights:
 *  - `orthometricHeight`: metres above mean sea level (NAVD88, USGS 3DEP lidar / GNIS).
 *  - `ellipsoidHeight`: metres above the WGS84 ellipsoid = orthometric + geoid undulation.
 *    The geoid at Emerald Bay is ~ -23.6 m (EGM2008 -23.55, GEOID18 -23.73), so
 *    ellipsoidal = orthometric - 24.1 m (incl. the ~0.5 m NAD83 -> WGS84 shift).
 * Everything 3D in Flytake (tiles, camera, future flight paths / drone) is in WGS84 ECEF, so
 * use `ellipsoidHeight` for geometry and `orthometricHeight` for anything shown to people.
 */
import { Matrix4, Vector3 } from 'three';
import { enuToEcefMatrix, enuVectors, geodeticToEcef, type Geodetic, type LocalFrame } from './wgs84';

/**
 * Lake Tahoe vertical reference (see research notes):
 *  - orthometric lake surface 1897.6 m NAVD88 (USGS 3DEP lidar, hydro-flattened) ~ 6,226 ft
 *  - geoid undulation at 38.95N 120.10W: EGM2008 -23.55 m, EGM96 -23.71 m, GEOID18 -23.73 m
 *  - WGS84 ellipsoidal height of the lake surface ~ 1873.5 m (+-0.7 m; calibrate by ray-casting
 *    the Google tiles over open water once at runtime).
 */
export const TAHOE = {
  lakeOrthometricHeight: 1897.6,
  geoidUndulationEGM2008: -23.55,
  lakeEllipsoidHeight: 1873.5,
} as const;

/** Orthometric (MSL) -> WGS84 ellipsoidal height around Lake Tahoe. */
export const MSL_TO_ELLIPSOID = -24.1;

export interface PointOfInterest extends Geodetic {
  id: string;
  name: string;
  /** metres above mean sea level (NAVD88); `height` is the WGS84 ellipsoidal height */
  orthometricHeight: number;
  /** short note on where the coordinate comes from */
  source: string;
}

function poi(id: string, name: string, lat: number, lon: number, orthometricHeight: number, source: string): PointOfInterest {
  return { id, name, lat, lon, orthometricHeight, height: orthometricHeight + MSL_TO_ELLIPSOID, source };
}

/** Points of interest at Emerald Bay (all heights are ground / water level). */
export const POIS = {
  fannetteIsland: poi('fannette-island', 'Fannette Island', 38.95416, -120.1004, 1925.6, 'DEM summit (teahouse)'),
  emeraldBay: poi('emerald-bay', 'Emerald Bay', 38.9574078, -120.0924073, TAHOE.lakeOrthometricHeight, 'GNIS 259888'),
  bayMouth: poi('bay-mouth', 'Emerald Bay mouth', 38.9656, -120.081, TAHOE.lakeOrthometricHeight, 'between Emerald Pt and Eagle Pt'),
  emeraldPoint: poi('emerald-point', 'Emerald Point', 38.96574, -120.08324, TAHOE.lakeOrthometricHeight, 'GNIS 259895'),
  eaglePoint: poi('eagle-point', 'Eagle Point', 38.96546, -120.0788, TAHOE.lakeOrthometricHeight, 'GNIS 259672'),
  vikingsholm: poi('vikingsholm', 'Vikingsholm', 38.95216, -120.10675, 1902, 'OSM building'),
  inspirationPoint: poi('inspiration-point', 'Inspiration Point', 38.946599, -120.098107, 2077.8, 'OSM viewpoint / USGS EPQS'),
  eagleFalls: poi('eagle-falls', 'Eagle Falls', 38.9517041, -120.1112379, 1957, 'GNIS 259656'),
  emeraldBayOverlook: poi('emerald-bay-overlook', 'Emerald Bay Overlook', 38.954389, -120.109822, 2018, 'OSM viewpoint'),
} as const satisfies Record<string, PointOfInterest>;

export type PoiKey = keyof typeof POIS;

/** Origin used for local (ENU) work at Emerald Bay: Fannette Island at lake level. */
export const EMERALD_BAY_ORIGIN: Geodetic = {
  lat: POIS.fannetteIsland.lat,
  lon: POIS.fannetteIsland.lon,
  height: TAHOE.lakeEllipsoidHeight,
};

/** ECEF position of a geodetic point. */
export function ecefOf(p: Geodetic, out = new Vector3()): Vector3 {
  return geodeticToEcef(p.lat, p.lon, p.height, out);
}

/**
 * Local ENU frame (X east, Y north, Z up, metres) -> ECEF matrix at a geodetic origin.
 * Parent any custom geometry (flight paths, drone) under a group with this matrix instead of
 * storing raw ECEF vertices, which would jitter in float32.
 */
export function enuFrameAt(origin: Geodetic, out = new Matrix4()): Matrix4 {
  return enuToEcefMatrix(origin.lat, origin.lon, origin.height, out);
}

/** ENU frame at Emerald Bay (origin: Fannette Island, at the lake surface). */
export function emeraldBayFrame(out = new Matrix4()): Matrix4 {
  return enuFrameAt(EMERALD_BAY_ORIGIN, out);
}

/** East / north / up unit vectors (ECEF) at Emerald Bay. */
export function emeraldBayAxes(): LocalFrame {
  const frame: LocalFrame = { east: new Vector3(), north: new Vector3(), up: new Vector3() };
  enuVectors(EMERALD_BAY_ORIGIN.lat, EMERALD_BAY_ORIGIN.lon, frame.east, frame.north, frame.up);
  return frame;
}

/** Convert an ECEF point to local ENU metres relative to `origin`. */
export function ecefToEnu(point: Vector3, origin: Geodetic = EMERALD_BAY_ORIGIN, out = new Vector3()): Vector3 {
  const inv = enuFrameAt(origin).invert();
  return out.copy(point).applyMatrix4(inv);
}

/** Convert local ENU metres relative to `origin` into ECEF. */
export function enuToEcef(enu: Vector3, origin: Geodetic = EMERALD_BAY_ORIGIN, out = new Vector3()): Vector3 {
  return out.copy(enu).applyMatrix4(enuFrameAt(origin));
}
