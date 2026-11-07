import type { Vector3 } from 'three';
import type { ForestData } from './data';

/**
 * Drone collision against the loaded forest (ENU frame of the Forest component).
 * Each tree is a trunk cylinder (ground -> top) plus a crown cone (crown base -> top) with the
 * whole drawn crown (115% of the lidar crown radius) as its base radius.
 */

/** Crown base as a fraction of the height, per species (fir, Jeffrey pine, lodgepole, snag). */
const CROWN_BASE = [0.28, 0.48, 0.44, 1.0];
// the drawn crowns (instance width clamps, branch tips) reach a little beyond the lidar radius:
// collide with all of it so obstacle braking stops before the needles fill the camera
const CROWN_SOLID = 1.15;

let current: ForestData | null = null;
let stamp = new Uint32Array(0);
let stampId = 0;

export function setForestCollisionData(data: ForestData | null): void {
  current = data;
  stamp = new Uint32Array(data ? data.grid.cols * data.grid.rows : 0);
  stampId = 0;
}

export function forestLoaded(): boolean {
  return current != null;
}

export function trunkRadius(height: number): number {
  return Math.max(0.12, 0.011 * height + 0.05);
}

/** Ray vs vertical cylinder (axis through (cx, cy), z in [z0, z1]). Smallest t >= 0 or Infinity. */
export function rayCylinder(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  cx: number, cy: number, r: number, z0: number, z1: number,
): number {
  const px = ox - cx;
  const py = oy - cy;
  const a = dx * dx + dy * dy;
  const c = px * px + py * py - r * r;
  if (c <= 0 && oz >= z0 && oz <= z1) return 0; // inside
  if (a < 1e-12) return Infinity;
  const b = px * dx + py * dy;
  const disc = b * b - a * c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  for (const t of [(-b - s) / a, (-b + s) / a]) {
    if (t < 0) continue;
    const z = oz + t * dz;
    if (z >= z0 && z <= z1) return t;
  }
  return Infinity;
}

/**
 * Ray vs solid upright cone: apex (cx, cy, apexZ), base radius R at z = baseZ (< apexZ).
 * Smallest t >= 0 or Infinity.
 */
export function rayCone(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  cx: number, cy: number, apexZ: number, baseZ: number, R: number,
): number {
  const hgt = apexZ - baseZ;
  if (hgt <= 0 || R <= 0) return Infinity;
  const k = R / hgt;
  const k2 = k * k;
  const px = ox - cx;
  const py = oy - cy;
  const pz = apexZ - oz; // >= 0 below the apex
  const inside = (x: number, y: number, z: number): boolean =>
    z >= baseZ && z <= apexZ && x * x + y * y <= k2 * (apexZ - z) * (apexZ - z);
  if (inside(px, py, oz)) return 0;
  let best = Infinity;
  // lateral surface: px'^2 + py'^2 = k^2 (apexZ - z)^2
  const a = dx * dx + dy * dy - k2 * dz * dz;
  const b = 2 * (px * dx + py * dy + k2 * pz * dz);
  const c = px * px + py * py - k2 * pz * pz;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b - s) / (2 * a), (-b + s) / (2 * a));
    }
  }
  for (const t of roots) {
    if (t < 0 || t >= best) continue;
    const z = oz + t * dz;
    if (z >= baseZ && z <= apexZ) best = t;
  }
  // base disk
  if (Math.abs(dz) > 1e-12) {
    const t = (baseZ - oz) / dz;
    if (t >= 0 && t < best) {
      const x = px + t * dx;
      const y = py + t * dy;
      if (x * x + y * y <= R * R) best = t;
    }
  }
  return best;
}

/** Distance along a unit ray to one tree, or Infinity. */
export function rayTree(o: Vector3, d: Vector3, data: ForestData, i: number): number {
  const h = data.height[i]!;
  const u = data.u[i]!;
  const cx = data.e[i]!;
  const cy = data.n[i]!;
  let t = rayCylinder(o.x, o.y, o.z, d.x, d.y, d.z, cx, cy, trunkRadius(h), u - 1, u + h);
  const cb = CROWN_BASE[data.species[i]!] ?? 0.3;
  if (cb < 1) {
    const tc = rayCone(o.x, o.y, o.z, d.x, d.y, d.z, cx, cy, u + h, u + h * cb, data.radius[i]! * CROWN_SOLID);
    t = Math.min(t, tc);
  }
  return t;
}

/**
 * First hit of a ray (ENU, `dirEnu` need not be unit) against the trees within maxDist, as a
 * distance along the normalised direction, or null.
 */
export function forestRaycast(originEnu: Vector3, dirEnu: Vector3, maxDist: number, data: ForestData | null = current): number | null {
  if (data == null || data.count === 0) return null;
  const len = dirEnu.length();
  if (len < 1e-9 || !(maxDist > 0)) return null;
  const d = { x: dirEnu.x / len, y: dirEnu.y / len, z: dirEnu.z / len } as Vector3;
  const g = data.grid;
  if (stamp.length !== g.cols * g.rows) stamp = new Uint32Array(g.cols * g.rows);
  stampId = (stampId + 1) >>> 0 || 1;
  let best = Infinity;
  // walk the cells along the segment (2D DDA) and test each cell's 3x3 neighbourhood
  const x0 = (originEnu.x - g.minE) / g.cell;
  const y0 = (originEnu.y - g.minN) / g.cell;
  const x1 = (originEnu.x + d.x * maxDist - g.minE) / g.cell;
  const y1 = (originEnu.y + d.y * maxDist - g.minN) / g.cell;
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const ex = Math.floor(x1);
  const ey = Math.floor(y1);
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);
  const tdx = sx !== 0 ? Math.abs(1 / (x1 - x0)) : Infinity;
  const tdy = sy !== 0 ? Math.abs(1 / (y1 - y0)) : Infinity;
  let tmx = sx > 0 ? (cx + 1 - x0) * tdx : sx < 0 ? (x0 - cx) * tdx : Infinity;
  let tmy = sy > 0 ? (cy + 1 - y0) * tdy : sy < 0 ? (y0 - cy) * tdy : Infinity;
  for (let steps = 0; steps < 4096; steps++) {
    for (let r = cy - 1; r <= cy + 1; r++) {
      if (r < 0 || r >= g.rows) continue;
      for (let c = cx - 1; c <= cx + 1; c++) {
        if (c < 0 || c >= g.cols) continue;
        const k = r * g.cols + c;
        if (stamp[k] === stampId) continue;
        stamp[k] = stampId;
        const n = g.count[k]!;
        const s = g.start[k]!;
        for (let i = s; i < s + n; i++) {
          const t = rayTree(originEnu, d, data, i);
          if (t < best) best = t;
        }
      }
    }
    if (cx === ex && cy === ey) break;
    if (tmx < tmy) {
      if (tmx > 1) break;
      tmx += tdx;
      cx += sx;
    } else {
      if (tmy > 1) break;
      tmy += tdy;
      cy += sy;
    }
  }
  return best <= maxDist ? best : null;
}
