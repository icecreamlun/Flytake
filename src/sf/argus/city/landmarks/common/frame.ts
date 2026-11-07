/**
 * Local frames for landmarks. Every landmark is built in a local frame (x along its main axis, +Y up,
 * origin on the ground at its base centre) inside two groups:
 *   pivot (world position = base centre, identity rotation)   ← returned to quake FX: shake/tilt it freely
 *     └─ heading group (rotation.y = heading)                 ← aligns local +X with the footprint axis
 */
import * as THREE from 'three';
import type { BuildingRecord, XZ } from '../../../contracts';

export interface Frame {
  /** World position of the local origin. */
  cx: number;
  cz: number;
  /** Unit world direction of local +X (ux, uz). Local +Z maps to (-uz, ux). */
  ux: number;
  uz: number;
  heading: number;
}

export function frameFromAxis(cx: number, cz: number, ux: number, uz: number): Frame {
  const l = Math.hypot(ux, uz) || 1;
  ux /= l;
  uz /= l;
  return { cx, cz, ux, uz, heading: Math.atan2(-uz, ux) };
}

/** World (x, z) → local (x, z). */
export function toLocal(f: Frame, x: number, z: number): XZ {
  const dx = x - f.cx;
  const dz = z - f.cz;
  return [dx * f.ux + dz * f.uz, -dx * f.uz + dz * f.ux];
}

/** Local (x, z) → world (x, z). */
export function toWorld(f: Frame, lx: number, lz: number): XZ {
  return [f.cx + lx * f.ux - lz * f.uz, f.cz + lx * f.uz + lz * f.ux];
}

export interface Pivot {
  pivot: THREE.Group;
  inner: THREE.Group;
}

export function makePivot(name: string, f: Frame, baseY: number): Pivot {
  const pivot = new THREE.Group();
  pivot.name = `landmark:${name}`;
  pivot.position.set(f.cx, baseY, f.cz);
  const inner = new THREE.Group();
  inner.rotation.y = f.heading;
  pivot.add(inner);
  return { pivot, inner };
}

/** Area-weighted centroid of a footprint. */
export function centroid(fp: XZ[]): XZ {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < fp.length; i++) {
    const [x0, z0] = fp[i];
    const [x1, z1] = fp[(i + 1) % fp.length];
    const c = x0 * z1 - x1 * z0;
    a += c;
    cx += (x0 + x1) * c;
    cz += (z0 + z1) * c;
  }
  if (Math.abs(a) < 1e-9) {
    const n = fp.length;
    return [fp.reduce((s, p) => s + p[0], 0) / n, fp.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

/** Direction of the longest edge of a footprint (unit). */
export function longestEdge(fp: XZ[]): { a: XZ; b: XZ; ux: number; uz: number; len: number } {
  let best = { a: fp[0], b: fp[1], ux: 1, uz: 0, len: 0 };
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i];
    const b = fp[(i + 1) % fp.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > best.len) best = { a, b, ux: (b[0] - a[0]) / len, uz: (b[1] - a[1]) / len, len };
  }
  return best;
}

/** Minimum-area oriented rectangle of a point set (rotating calipers over hull edges). */
export function orientedRect(pts: XZ[]): { cx: number; cz: number; ux: number; uz: number; length: number; width: number } {
  const hull = convexHull(pts);
  let best = { area: Infinity, cx: 0, cz: 0, ux: 1, uz: 0, length: 0, width: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const ux = (b[0] - a[0]) / l;
    const uz = (b[1] - a[1]) / l;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, z] of hull) {
      const u = x * ux + z * uz;
      const v = -x * uz + z * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const mu = (minU + maxU) / 2;
      const mv = (minV + maxV) / 2;
      let L = maxU - minU;
      let W = maxV - minV;
      let ax = ux;
      let az = uz;
      if (W > L) {
        // Keep +X along the long side.
        [L, W] = [W, L];
        [ax, az] = [-uz, ux];
      }
      best = { area, cx: mu * ux - mv * uz, cz: mu * uz + mv * ux, ux: ax, uz: az, length: L, width: W };
    }
  }
  return best;
}

function convexHull(points: XZ[]): XZ[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: XZ, a: XZ, b: XZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XZ[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: XZ[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** All footprint points of a set of records. */
export function allPoints(recs: BuildingRecord[]): XZ[] {
  return recs.flatMap((r) => r.footprint);
}
