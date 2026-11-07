import { rng } from './geometry';
import { COVER, type GroundTile, type GroundTiles } from './tiles';

/**
 * Deterministic scatter of one category over one 32 m chunk of the scene grid. Instances are
 * packed as 12 floats: pos (x, y, z, scale), quaternion (x, y, z, w), misc (seed, green,
 * canopy, z-scale / aspect), plus a variant index.
 */
export const CHUNK = 32;
export const STRIDE = 12;
const R_EARTH = 6_371_000;
/** raster height of the lake surface (1873.79 m ellipsoidal - H0) */
const LAKE_HGT = 1873.79 - 1873.5;

export interface Placement {
  /** scene grid xy and raster height */
  x: number;
  y: number;
  hgt: number;
  /** ground normal (from the height grid) */
  nx: number;
  ny: number;
  nz: number;
  green: number;
  canopy: number;
  r: () => number;
}

export interface CategorySpec {
  id: number;
  /** candidate spacing (m) on a jittered grid */
  spacing: number;
  /** acceptance probability from the tile's cover densities at the candidate */
  accept(tiles: GroundTiles, tile: GroundTile, x: number, y: number, hLake: number): number;
  /** variant count (meshes) */
  variants: number;
  /** writes one instance; returns false to skip */
  make(p: Placement, out: Float32Array, o: number): { variant: number } | null;
}

export interface ChunkCategory {
  data: Float32Array;
  variant: Uint8Array;
  count: number;
}

const tmp = new Float32Array(STRIDE);

/** quaternion rotating +z onto (nx, ny, nz) by `k` (0..1), then yaw about the result */
export function tiltYawQuat(nx: number, ny: number, nz: number, k: number, yaw: number, out: Float32Array, o: number): void {
  // partial tilt: slerp-ish by scaling the axis angle
  let ax = -ny;
  let ay = nx;
  const s = Math.hypot(ax, ay);
  const ang = Math.acos(Math.min(1, Math.max(-1, nz))) * k;
  if (s > 1e-6) {
    ax /= s;
    ay /= s;
  } else {
    ax = 1;
    ay = 0;
  }
  const hs = Math.sin(ang / 2);
  const tq = [ax * hs, ay * hs, 0, Math.cos(ang / 2)] as const;
  // yaw quaternion about z
  const yq = [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)] as const;
  // q = tq * yq
  const [x1, y1, z1, w1] = tq;
  const [x2, y2, z2, w2] = yq;
  out[o] = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2;
  out[o + 1] = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2;
  out[o + 2] = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2;
  out[o + 3] = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2;
}

/** ENU position of a grid point at raster height hgt (Earth curvature, local vertical) */
export function enuOf(x: number, y: number, hgt: number, out: Float32Array, o: number): void {
  out[o] = x + (hgt * x) / R_EARTH;
  out[o + 1] = y + (hgt * y) / R_EARTH;
  out[o + 2] = hgt - (x * x + y * y) / (2 * R_EARTH);
}

function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

/** low-frequency value noise 0..1 (clumping of grass / shrubs) */
export function clump(x: number, y: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const v = (i: number, j: number) => hash(i, j, seed) / 4294967296;
  const a = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * sx;
  const b = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * sx;
  return a + (b - a) * sy;
}

/**
 * Returns null when a tile under the chunk is still loading (the caller retries later).
 */
export function scatterChunk(tiles: GroundTiles, spec: CategorySpec, cx: number, cy: number): ChunkCategory | null {
  const x0 = cx * CHUNK;
  const y0 = cy * CHUNK;
  // all tiles under the chunk must be loaded
  const corners = [
    [x0, y0],
    [x0 + CHUNK - 0.01, y0],
    [x0, y0 + CHUNK - 0.01],
    [x0 + CHUNK - 0.01, y0 + CHUNK - 0.01],
  ];
  for (const [x, y] of corners) {
    const t = tiles.tileOf(x!, y!);
    if (t == null) continue;
    const tile = tiles.get(t[0], t[1]);
    if (tile === undefined) {
      void tiles.load(t[0], t[1]);
      return null;
    }
  }
  const r = rng(hash(cx, cy, spec.id + 101));
  const n = Math.max(1, Math.round(CHUNK / spec.spacing));
  const step = CHUNK / n;
  const cap = n * n;
  let data = new Float32Array(Math.min(cap, 256) * STRIDE);
  let variant = new Uint8Array(Math.min(cap, 256));
  let count = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i + r()) * step;
      const y = y0 + (j + r()) * step;
      const u = r();
      const t = tiles.tileOf(x, y);
      if (t == null) continue;
      const tile = tiles.get(t[0], t[1]);
      if (!tile) continue;
      const hgt = tiles.height(tile, x, y);
      const hLake = hgt - LAKE_HGT;
      const p = spec.accept(tiles, tile, x, y, hLake);
      if (u >= p) continue;
      const e = 0.6;
      const hx = tiles.height(tile, x + e, y) - tiles.height(tile, x - e, y);
      const hy = tiles.height(tile, x, y + e) - tiles.height(tile, x, y - e);
      const nl = Math.hypot(hx, hy, 2 * e);
      const placement: Placement = {
        x,
        y,
        hgt,
        nx: -hx / nl,
        ny: -hy / nl,
        nz: (2 * e) / nl,
        green: tiles.cover(tile, COVER.green, x, y),
        canopy: tiles.cover(tile, COVER.canopy, x, y),
        r,
      };
      const res = spec.make(placement, tmp, 0);
      if (!res) continue;
      if (count === variant.length) {
        const d2 = new Float32Array(data.length * 2);
        d2.set(data);
        data = d2;
        const v2 = new Uint8Array(variant.length * 2);
        v2.set(variant);
        variant = v2;
      }
      data.set(tmp, count * STRIDE);
      variant[count] = res.variant;
      count++;
    }
  }
  return { data, variant, count };
}
