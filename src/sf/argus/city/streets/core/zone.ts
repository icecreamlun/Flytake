/**
 * Shared constants for the streets/ground module: the detail zone (where real road data, curbs and the
 * baked landcover live), tile layout and physical dimensions.
 */
import { CONTEXT_BBOX, project } from '../../../geo';

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Height of raised sidewalks / blocks above the carriageway (m). */
export const CURB_H = 0.15;

/** Data rectangle (context bbox) in world metres: roads/areas/trees exist inside it only. */
export const CTX: Rect = (() => {
  const [x0, z0] = project(CONTEXT_BBOX.north, CONTEXT_BBOX.west);
  const [x1, z1] = project(CONTEXT_BBOX.south, CONTEXT_BBOX.east);
  return { minX: x0, minZ: z0, maxX: x1, maxZ: z1 };
})();

/** Detail-zone tiles (aligned to the 4 m terrain lattice). */
export const TILE = 640;
export const DZ: Rect = { minX: -1600, maxX: 1600, minZ: -1200, maxZ: 1360 };
/** Carriageway raster resolution inside the detail zone (m per pixel). */
export const MASK_RES = 0.5;
/** Landcover texture resolution (m per texel). */
export const LC_RES = 1.0;

export const inRect = (r: Rect, x: number, z: number, pad = 0) =>
  x >= r.minX - pad && x <= r.maxX + pad && z >= r.minZ - pad && z <= r.maxZ + pad;

/** Distance (m) from a point inside r to r's nearest edge (negative outside). */
export const insideDist = (r: Rect, x: number, z: number) => Math.min(x - r.minX, r.maxX - x, z - r.minZ, r.maxZ - z);

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Deterministic hash → [0,1). */
export function hash01(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
