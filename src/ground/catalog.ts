import { clump, enuOf, tiltYawQuat, type CategorySpec, type Placement } from './scatter';
import { COVER } from './tiles';

/**
 * What grows where (densities from tools/scene/ground_classes.py) and how big. Sizes are in
 * metres: prop geometries are normalised to a unit maximum dimension on load.
 */

export const ROCKS = ['rock_a', 'rock_b', 'rock_c', 'rock_d', 'rock_e'] as const;
export const LOGS = ['log_a', 'log_b', 'stump'] as const;

/** normalised canonical heights (z extent / max dimension), filled when the props load */
export const PROP_HEIGHT: Record<string, number> = {};

const TAU = Math.PI * 2;
/** raster height of the lake surface */
const LAKE_HGT = 1873.79 - 1873.5;
/** land this close above the lake is drawn as water by the terrain shader: keep small props off */
const WET = 0.15;

function pickRock(r: () => number): number {
  // the light, rounded granite boulders are the most common; the smooth grey one is rare
  const u = r();
  return u < 0.38 ? 0 : u < 0.6 ? 1 : u < 0.76 ? 2 : u < 0.94 ? 3 : 4;
}

function writeRock(p: Placement, out: Float32Array, size: number, sinkFrac: number, tilt: number, variant: number): void {
  const r = p.r;
  const aspect = 0.55 + 0.45 * r();
  const h = (PROP_HEIGHT[ROCKS[variant]!] ?? 0.6) * size * aspect;
  // on slopes the downhill edge must not float: follow the slope more and bury the residual
  const slopeAng = Math.acos(Math.min(1, p.nz));
  const k = Math.min(1, tilt + 0.6 * slopeAng);
  const residual = Math.tan((1 - k) * slopeAng);
  // rocks at the waterline sit partly in the lake
  const shore = p.hgt - LAKE_HGT < 0.6 ? 0.15 : 0;
  enuOf(p.x, p.y, p.hgt - h * (sinkFrac + shore) - 0.5 * size * residual, out, 0);
  out[3] = size;
  tiltYawQuat(p.nx, p.ny, p.nz, k, r() * TAU, out, 4);
  out[8] = r();
  out[9] = p.green;
  out[10] = p.canopy;
  out[11] = aspect;
}

/** large boulders: shorelines, steep open slopes, bare granite; a few everywhere */
export const BOULDERS: CategorySpec = {
  id: 1,
  spacing: 3.6,
  variants: ROCKS.length,
  accept: (tiles, tile, x, y, hLake) => (hLake < 0.05 ? 0 : Math.pow(tiles.cover(tile, COVER.rock, x, y), 1.2) * (0.3 + 1.3 * clump(x, y, 18, 5))),
  make(p, out) {
    const r = p.r;
    const u = r();
    const steep = p.nz < 0.82 ? 1.35 : 1.0;
    const size = (0.45 + 2.8 * u * u * u * u) * steep;
    const v = pickRock(r);
    writeRock(p, out, size, 0.18 + 0.2 * r(), 0.55, v);
    return { variant: v };
  },
};

/** fist- to knee-sized rocks */
export const STONES: CategorySpec = {
  id: 2,
  spacing: 1.7,
  variants: ROCKS.length,
  accept: (tiles, tile, x, y, hLake) =>
    hLake < WET ? 0 : 0.4 * tiles.cover(tile, COVER.rock, x, y) + 0.25 * tiles.cover(tile, COVER.pebble, x, y) + 0.03,
  make(p, out) {
    const r = p.r;
    const size = 0.12 + 0.45 * r() * r();
    const v = pickRock(r);
    writeRock(p, out, size, 0.25 + 0.2 * r(), 0.8, v);
    return { variant: v };
  },
};

/** waterline pebbles */
export const PEBBLES: CategorySpec = {
  id: 3,
  spacing: 0.42,
  variants: ROCKS.length,
  accept: (tiles, tile, x, y, hLake) => (hLake < WET ? 0 : 0.9 * tiles.cover(tile, COVER.pebble, x, y) * (0.35 + 1.1 * clump(x, y, 3.5, 3))),
  make(p, out) {
    const r = p.r;
    const size = 0.04 + 0.2 * r() * r();
    const v = pickRock(r);
    writeRock(p, out, size, 0.35, 1.0, v);
    out[11] = 0.4 + 0.35 * r();
    return { variant: v };
  },
};

/** dry grass and sedge tufts */
export const GRASS: CategorySpec = {
  id: 4,
  spacing: 0.55,
  variants: 1,
  accept: (tiles, tile, x, y, hLake) => {
    if (hLake < 0.12) return 0;
    const g = tiles.cover(tile, COVER.grass, x, y);
    return Math.min(1, g * 1.15 * (0.25 + 0.95 * clump(x, y, 7, 1) * clump(x, y, 2.3, 9)));
  },
  make(p, out) {
    const r = p.r;
    const sedge = p.hgt - 0.29 < 2.5 && p.green > 0.25;
    const size = 0.22 + 0.3 * r();
    enuOf(p.x, p.y, p.hgt - 0.03, out, 0);
    out[3] = size;
    tiltYawQuat(p.nx, p.ny, p.nz, 0.35, r() * TAU, out, 4);
    out[8] = r();
    out[9] = sedge ? Math.max(p.green, 0.7) : p.green;
    out[10] = p.canopy;
    out[11] = (sedge ? 1.5 : 1.0) * (0.7 + 0.6 * r()) * (1.0 - 0.4 * p.canopy);
    return { variant: 0 };
  },
};

/** manzanita / huckleberry oak mounds */
export const SHRUBS: CategorySpec = {
  id: 5,
  spacing: 2.3,
  variants: 1,
  accept: (tiles, tile, x, y, hLake) => {
    if (hLake < 0.5) return 0;
    return 0.42 * tiles.cover(tile, COVER.shrub, x, y) * (0.3 + 0.9 * clump(x, y, 13, 2));
  },
  make(p, out) {
    const r = p.r;
    const width = 0.7 + 1.8 * r() * r();
    enuOf(p.x, p.y, p.hgt - 0.12 * width, out, 0);
    out[3] = width;
    tiltYawQuat(p.nx, p.ny, p.nz, 0.5, r() * TAU, out, 4);
    out[8] = r();
    out[9] = p.green;
    out[10] = p.canopy;
    out[11] = 0.6 + 0.35 * r();
    return { variant: 0 };
  },
};

/** fallen logs and stumps on the forest floor */
export const LOGS_SPEC: CategorySpec = {
  id: 6,
  spacing: 8,
  variants: LOGS.length,
  // forest floor, plus bleached driftwood along the shore
  accept: (tiles, tile, x, y, hLake) =>
    hLake < 0.3 ? 0 : 0.2 * tiles.cover(tile, COVER.debris, x, y) + 0.08 * tiles.cover(tile, COVER.pebble, x, y),
  make(p, out) {
    const r = p.r;
    const u = r();
    const v = u < 0.5 ? 0 : u < 0.8 ? 1 : 2;
    // fallen trunks come to rest across the slope; none on steep ground (they would bridge it)
    if (v !== 2 && p.nz < 0.8) return null;
    const size = v === 2 ? 0.7 + 0.6 * r() : v === 0 ? 3 + 3 * r() : 3.5 + 3.5 * r();
    const h = (PROP_HEIGHT[LOGS[v]!] ?? 0.25) * size;
    enuOf(p.x, p.y, p.hgt - h * (v === 2 ? 0.15 : 0.3), out, 0);
    out[3] = size;
    // model x axis = trunk axis; contour direction = perpendicular to the downhill gradient
    const contour = Math.atan2(p.nx, -p.ny);
    const yaw = Math.hypot(p.nx, p.ny) > 0.05 ? contour + (r() - 0.5) * 0.9 : r() * TAU;
    tiltYawQuat(p.nx, p.ny, p.nz, v === 2 ? 0.2 : 1.0, v === 2 ? r() * TAU : yaw, out, 4);
    out[8] = r();
    out[9] = p.green;
    out[10] = p.canopy;
    out[11] = 1;
    return { variant: v };
  },
};
