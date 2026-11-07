/**
 * Coarse procedural geography of the Bay Area beyond the terrain grid, from real coordinates:
 * coastlines (SF peninsula, Marin, East Bay, Treasure / Angel Island) as lat/lon polygons and the
 * main summits / ridges as gaussian bumps. Elevations in metres (negative = under the bay).
 * Accuracy target: believable silhouettes at 3–45 km, not survey-grade.
 */
import { project } from '../../geo';

type LL = [number, number]; // [lat, lon]

interface Poly {
  pts: [number, number][]; // world x,z
  urban: number;
}

const toXZ = (ll: LL[]) => ll.map(([la, lo]) => project(la, lo));

const SF: LL[] = [
  [37.808, -122.43], [37.8075, -122.434], [37.8065, -122.437], [37.807, -122.444], [37.806, -122.45],
  [37.8045, -122.464], [37.808, -122.472], [37.8105, -122.4775], [37.806, -122.481], [37.801, -122.483],
  [37.79, -122.49], [37.788, -122.495], [37.787, -122.505], [37.78, -122.513], [37.77, -122.511],
  [37.74, -122.507], [37.71, -122.502], [37.66, -122.495], [37.6, -122.49], [37.5, -122.47],
  [37.5, -122.3], [37.6, -122.37], [37.65, -122.38], [37.70, -122.39], [37.708, -122.385],
  [37.712, -122.378], [37.72, -122.365], [37.727, -122.357], [37.733, -122.36], [37.74, -122.37],
  [37.748, -122.378], [37.755, -122.381], [37.76, -122.383], [37.765, -122.386], [37.772, -122.3855],
  [37.785, -122.388], [37.80, -122.395], [37.808, -122.41],
];

const MARIN: LL[] = [
  [37.825, -122.535], [37.83, -122.49], [37.833, -122.478], [37.845, -122.476], [37.858, -122.483],
  [37.87, -122.49], [37.875, -122.47], [37.868, -122.456], [37.873, -122.45], [37.89, -122.46],
  [37.905, -122.47], [37.94, -122.48], [37.97, -122.48], [38.0, -122.45], [38.15, -122.45],
  [38.15, -122.85], [37.9, -122.68], [37.86, -122.6], [37.835, -122.54],
];

const EAST_BAY: LL[] = [
  [37.6, -122.13], [37.7, -122.21], [37.72, -122.225], [37.735, -122.255], [37.755, -122.28],
  [37.775, -122.33], [37.795, -122.322], [37.8, -122.32], [37.808, -122.335], [37.822, -122.338],
  [37.828, -122.31], [37.84, -122.296], [37.86, -122.305], [37.87, -122.315], [37.89, -122.32],
  [37.91, -122.33], [37.93, -122.37], [37.95, -122.42], [38.02, -122.38], [38.1, -122.25],
  [38.1, -121.6], [37.6, -121.6],
];

const TREASURE: LL[] = [
  [37.8165, -122.372], [37.819, -122.377], [37.83, -122.378], [37.832, -122.374], [37.831, -122.364],
  [37.82, -122.362], [37.817, -122.366],
];

/** Built-up pockets inside the (otherwise wild) Marin polygon: Sausalito, Belvedere–Tiburon, Mill Valley. */
const TOWNS: LL[][] = [
  [[37.85, -122.479], [37.858, -122.484], [37.869, -122.491], [37.874, -122.498], [37.872, -122.507], [37.862, -122.497], [37.853, -122.488]],
  [[37.866, -122.462], [37.869, -122.455], [37.876, -122.452], [37.888, -122.462], [37.884, -122.47], [37.874, -122.469]],
  [[37.885, -122.505], [37.895, -122.49], [37.92, -122.495], [37.935, -122.51], [37.925, -122.535], [37.9, -122.54]],
];
const TOWN_XZ = TOWNS.map(toXZ);

/** Night-light regions: lamps / windows only where people actually live (see GeoSample.lights). */
const enum Region {
  Wild = 0,
  SF = 1,
  EastBay = 2,
  Island = 3,
  Town = 4,
}

const POLYS: (Poly & { region: Region })[] = [
  { pts: toXZ(SF), urban: 1, region: Region.SF },
  { pts: toXZ(MARIN), urban: 0, region: Region.Wild },
  { pts: toXZ(EAST_BAY), urban: 1, region: Region.EastBay },
  { pts: toXZ(TREASURE), urban: 0.7, region: Region.Island },
];

interface Bump {
  x: number;
  z: number;
  h: number;
  r: number;
  urban?: number;
}
const bump = (lat: number, lon: number, h: number, r: number, urban?: number): Bump => {
  const [x, z] = project(lat, lon);
  return { x, z, h, r, urban };
};

const BUMPS: Bump[] = [
  // San Francisco
  bump(37.7544, -122.4477, 250, 950),
  bump(37.758, -122.458, 230, 700),
  bump(37.7383, -122.4545, 250, 750),
  bump(37.758, -122.47, 160, 900),
  bump(37.743, -122.414, 105, 450),
  bump(37.759, -122.399, 75, 520),
  bump(37.792, -122.435, 95, 900),
  bump(37.778, -122.452, 95, 520),
  bump(37.795, -122.465, 70, 1300),
  bump(37.718, -122.42, 140, 1100),
  bump(37.73, -122.378, 55, 520),
  bump(37.688, -122.434, 360, 2400),
  bump(37.69, -122.47, 180, 2400),
  // Marin
  bump(37.827, -122.499, 260, 900),
  bump(37.835, -122.49, 250, 750),
  bump(37.85, -122.495, 240, 1000),
  bump(37.86, -122.52, 280, 2600),
  bump(37.89, -122.55, 330, 3200),
  bump(37.9235, -122.5965, 760, 3600),
  bump(37.885, -122.465, 140, 1100),
  bump(37.95, -122.53, 300, 3500),
  // Angel Island (its own circle of land below)
  bump(37.8609, -122.4326, 235, 850),
  // Distant Mt Diablo
  bump(37.8816, -121.9142, 1120, 5500),
];

/** East Bay hills ridge line (lat, lon, crest height). */
const RIDGE: [number, number, number][] = [
  [37.96, -122.3, 280],
  [37.93, -122.27, 330],
  [37.882, -122.234, 520],
  [37.849, -122.205, 520],
  [37.82, -122.18, 470],
  [37.78, -122.15, 410],
  [37.73, -122.1, 360],
  [37.66, -122.04, 330],
];
const RIDGE_XZ = RIDGE.map(([la, lo, h]) => {
  const [x, z] = project(la, lo);
  return { x, z, h };
});

const ANGEL = project(37.8609, -122.4326);
const SUTRO = project(37.7585, -122.4555);
const ANGEL_R = 1250;

function pointInPoly(x: number, z: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distToPolyEdges(x: number, z: number, pts: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j];
    const [bx, bz] = pts[i];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    const ex = ax + dx * t - x;
    const ez = az + dz * t - z;
    const d = ex * ex + ez * ez;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Cheap deterministic value noise (for terrain roughness). */
function hash(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
export function fbm2(x: number, z: number, oct = 4): number {
  let s = 0;
  let a = 0.5;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, z);
    x = x * 2.03 + 11.7;
    z = z * 2.03 + 5.3;
    a *= 0.5;
  }
  return s;
}

/**
 * Band-limited fbm for geometry: x, z in units of the base wavelength `wl` (m). Octaves shorter
 * than ~4.5 vertex spacings (`spacing`, m) fade to their mean (0.5) — sampling them on a coarse mesh
 * is what made distant ridgelines stair-stepped; longer ones are kept (the mesh resolves them).
 */
export function fbm2Lod(x: number, z: number, oct: number, wl: number, spacing: number): number {
  let s = 0;
  let a = 0.5;
  for (let i = 0; i < oct; i++) {
    const k = spacing > 0 ? smoothstep(spacing * 2.5, spacing * 4.5, wl) : 1;
    if (k <= 0) {
      // Remaining octaves (amplitudes a, a/2, …) at their mean value 0.5.
      s += a * (1 - Math.pow(0.5, oct - i));
      break;
    }
    s += a * (0.5 + (vnoise(x, z) - 0.5) * k);
    x = x * 2.03 + 11.7;
    z = z * 2.03 + 5.3;
    wl /= 2.03;
    a *= 0.5;
  }
  return s;
}

export interface GeoSample {
  /** Elevation (m), negative under water. */
  h: number;
  /** 0..1 forest cover override (parks / Presidio / Mt Sutro eucalyptus). */
  forest?: number;
  /** 0..1 how urbanised (drives city texture, night lights, filler buildings). */
  urban: number;
  /** Signed distance to the nearest coast (m): negative on land. */
  coast: number;
  /** 0..1 night-light density: urban AND inhabited (no lamps on wild hills, parks or summits). */
  lights?: number;
}

/**
 * Elevation + land use at world x,z. `spacing` (m) is the caller's vertex spacing; relief noise it
 * can't represent is faded out (0 = full detail).
 */
export function sampleGeo(x: number, z: number, out: GeoSample = { h: 0, urban: 0, coast: 0 }, spacing = 0): GeoSample {
  // Signed distance to land (negative inside any land polygon).
  let sd = Infinity;
  let urbanBase = 0;
  let region = Region.Wild;
  for (const p of POLYS) {
    const d = distToPolyEdges(x, z, p.pts);
    if (pointInPoly(x, z, p.pts)) {
      if (-d < sd) {
        sd = -d;
        urbanBase = p.urban;
        region = p.region;
      }
    } else if (d < sd && sd >= 0) sd = d;
  }
  if (region === Region.Wild && sd < 0) {
    for (const t of TOWN_XZ) {
      if (pointInPoly(x, z, t)) {
        urbanBase = 0.6;
        region = Region.Town;
        break;
      }
    }
  }
  const da = Math.hypot(x - ANGEL[0], z - ANGEL[1]) - ANGEL_R * (0.85 + 0.3 * vnoise(x / 700, z / 700));
  let angel = false;
  if (da < sd) {
    sd = da;
    urbanBase = 0;
    region = Region.Wild;
    angel = da < 0;
  }
  // Relief.
  let hills = 0;
  let urbanMod = 1;
  for (const b of BUMPS) {
    const dx = x - b.x;
    const dz = z - b.z;
    const q = (dx * dx + dz * dz) / (b.r * b.r);
    if (q < 9) hills += b.h * Math.exp(-q);
  }
  // Ridge: steep to the west (Hayward fault scarp), gentler east.
  let ridge = 0;
  for (let i = 0; i < RIDGE_XZ.length - 1; i++) {
    const a = RIDGE_XZ[i];
    const b = RIDGE_XZ[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const side = x < px ? 2600 : 5200;
    const d = Math.hypot(x - px, z - pz);
    const h = (a.h + (b.h - a.h) * t) * Math.exp(-((d / side) ** 2));
    if (h > ridge) ridge = h;
  }
  hills += ridge;
  const rough = fbm2Lod(x / 1800, z / 1800, 4, 1800, spacing);
  hills *= 0.75 + 0.5 * rough;
  // Ridges and gullies on the slopes (ridged noise), proportional to relief: hills read as
  // eroded ridgelines rather than smooth domes. Band-limited to what the mesh can carry.
  const rid = 1 - Math.abs(fbm2Lod(x / 520 + 3.1, z / 520 - 7.7, 4, 520, spacing) * 2 - 1);
  const rid2 = 1 - Math.abs(fbm2Lod(x / 190 - 1.3, z / 190 + 2.9, 3, 190, spacing) * 2 - 1);
  const relief = Math.min(1, hills / 120);
  hills += hills * (0.55 * (rid - 0.6) + 0.18 * (rid2 - 0.6)) * relief;

  if (sd > 0) {
    out.h = -1.5 - Math.min(sd * 0.04, 14);
    out.urban = 0;
  } else {
    const inland = -sd;
    out.h = 1.5 + Math.min(inland * 0.015, 6) + hills * smoothstep(0, 350, inland) + (rough - 0.5) * 6;
    // Steeper / higher ground and parks are less built-up.
    urbanMod = 1 - smoothstep(urbanBase > 0.9 ? 190 : 110, urbanBase > 0.9 ? 300 : 330, out.h);
    out.urban = urbanBase * urbanMod * smoothstep(0, 60, inland);
  }
  out.coast = sd;
  // Parks / forests inside SF: Golden Gate Park, the Presidio, Mt Sutro's eucalyptus forest.
  out.forest = 0;
  if (inRect(x, z, 37.766, -122.511, 37.7735, -122.454) || inRect(x, z, 37.787, -122.485, 37.803, -122.447)) {
    out.urban *= 0.12;
    out.forest = 0.9;
  }
  // Angel Island is mostly wooded (oak / eucalyptus), unlike the grassy headlands.
  if (angel) out.forest = 0.75;
  if (Math.hypot(x - SUTRO[0], z - SUTRO[1]) < 650) {
    out.urban *= 0.2;
    out.forest = 1;
  }
  // Night lights: only inhabited ground. SF is built up to its summits (parks excepted); the East
  // Bay thins out up the hills; the Marin towns hug the shore; wild headlands / islands stay dark.
  let lights = 0;
  if (sd <= 0) {
    if (region === Region.SF) lights = out.urban * (1 - out.forest);
    else if (region === Region.EastBay) lights = out.urban * (1 - smoothstep(110, 230, out.h));
    else if (region === Region.Town) lights = urbanBase * (1 - smoothstep(50, 130, out.h)) * smoothstep(0, 40, -sd);
    else if (region === Region.Island) lights = out.urban;
  }
  out.lights = lights;
  return out;
}

function inRect(x: number, z: number, s: number, w: number, n: number, e: number): boolean {
  const [x0, z0] = project(n, w);
  const [x1, z1] = project(s, e);
  return x >= x0 && x <= x1 && z >= z0 && z <= z1;
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
