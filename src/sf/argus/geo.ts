/**
 * Local tangent-plane projection for the study area. Accurate to centimetres over a few km.
 * World frame: +X east, -Z north, +Y up (see contracts.ts).
 */

/** Core study area: Ferry Building (east) → Chinatown (west). */
export const CORE_BBOX = { south: 37.788, west: -122.41, north: 37.799, east: -122.386 } as const;

/** Context ring fetched around the core (adds Telegraph Hill / Coit Tower, Nob Hill edge, Bay Bridge approach). */
export const CONTEXT_BBOX = { south: 37.7835, west: -122.416, north: 37.804, east: -122.38 } as const;

/** World origin = centre of the core bbox. */
export const CITY_ORIGIN = {
  lat: (CORE_BBOX.south + CORE_BBOX.north) / 2,
  lon: (CORE_BBOX.west + CORE_BBOX.east) / 2,
} as const;

const phi = (CITY_ORIGIN.lat * Math.PI) / 180;
/** WGS84 metres per degree at the origin latitude. */
export const M_PER_DEG_LAT = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
export const M_PER_DEG_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);

/** lat/lon → world [x, z] metres. */
export function project(lat: number, lon: number): [number, number] {
  return [(lon - CITY_ORIGIN.lon) * M_PER_DEG_LON, -(lat - CITY_ORIGIN.lat) * M_PER_DEG_LAT];
}

/** world x/z metres → [lat, lon]. */
export function unproject(x: number, z: number): [number, number] {
  return [CITY_ORIGIN.lat - z / M_PER_DEG_LAT, CITY_ORIGIN.lon + x / M_PER_DEG_LON];
}

/** Great-circle distance in km (haversine). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371.0088;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
