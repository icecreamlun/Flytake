/**
 * 2D polygon helpers for footprints in the world XZ plane.
 *
 * Orientation convention used inside the buildings module (independent of the input data):
 * outer rings have positive shoelace area in (x, z) and holes negative, so for every ring edge
 * a → b the outward wall normal (pointing out of the solid) is (dz, -dx) / len.
 */
import type { XZ } from '../../contracts';

export function signedArea(ring: XZ[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Copy, drop duplicate / collinear-degenerate vertices, and orient (outer: area > 0, hole: area < 0). */
export function cleanRing(ring: XZ[], outer: boolean): XZ[] {
  const out: XZ[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.05) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05) out.pop();
    else break;
  }
  if (out.length < 3) return out;
  const a = signedArea(out);
  if ((outer && a < 0) || (!outer && a > 0)) out.reverse();
  return out;
}

export function centroid(ring: XZ[]): XZ {
  let cx = 0;
  let cz = 0;
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cz += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-6) {
    const m = ring.reduce((s, p) => [s[0] + p[0], s[1] + p[1]] as XZ, [0, 0] as XZ);
    return [m[0] / ring.length, m[1] / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(x: number, z: number, ring: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, z: number, outer: XZ[], holes?: XZ[][]): boolean {
  if (!pointInRing(x, z, outer)) return false;
  if (holes) for (const h of holes) if (pointInRing(x, z, h)) return false;
  return true;
}

/** Squared distance from point to segment, and the segment parameter t of the closest point. */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return { d: Math.sqrt(qx * qx + qz * qz), t };
}

/** Minimum distance from a point to any edge of the polygon (outer + holes). */
export function distToBoundary(x: number, z: number, rings: XZ[][]): number {
  let best = Infinity;
  for (const r of rings)
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      const { d } = distToSegment(x, z, a[0], a[1], b[0], b[1]);
      if (d < best) best = d;
    }
  return best;
}

/**
 * Offset a ring along its outward normals by `d` (negative = inward) using clamped miters.
 * Good enough for parapets/cornices on the mostly-orthogonal footprints of a city; callers skip
 * rings that are too small for the inset to stay valid.
 */
export function offsetRing(ring: XZ[], d: number, miterLimit = 2.5): XZ[] {
  const n = ring.length;
  const out: XZ[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n];
    const c = ring[i];
    const q = ring[(i + 1) % n];
    const n0 = edgeNormal(p, c);
    const n1 = edgeNormal(c, q);
    let mx = n0[0] + n1[0];
    let mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) {
      mx = n1[0];
      mz = n1[1];
    } else {
      mx /= ml;
      mz /= ml;
    }
    // Miter length so that the offset edges stay at distance d.
    const cosHalf = mx * n1[0] + mz * n1[1];
    const k = Math.min(1 / Math.max(cosHalf, 1e-3), miterLimit);
    out.push([c[0] + mx * d * k, c[1] + mz * d * k]);
  }
  return out;
}

/** Outward unit normal of edge a → b (see orientation convention above). */
export function edgeNormal(a: XZ, b: XZ): XZ {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  return [dz / l, -dx / l];
}

/** Rough "minimum width" of a ring: 2 * area / perimeter (exact for long rectangles' short side ×~1). */
export function thickness(ring: XZ[]): number {
  let per = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    per += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return per > 0 ? (2 * Math.abs(signedArea(ring))) / per : 0;
}

/** Simple uniform-grid spatial hash for segments / boxes. */
export class GridHash<T> {
  private cells = new Map<number, T[]>();
  constructor(private readonly size: number) {}
  private key(ix: number, iz: number) {
    return (ix + 4096) * 8192 + (iz + 4096);
  }
  insertBox(minX: number, minZ: number, maxX: number, maxZ: number, item: T): void {
    const s = this.size;
    for (let ix = Math.floor(minX / s); ix <= Math.floor(maxX / s); ix++)
      for (let iz = Math.floor(minZ / s); iz <= Math.floor(maxZ / s); iz++) {
        const k = this.key(ix, iz);
        let c = this.cells.get(k);
        if (!c) this.cells.set(k, (c = []));
        c.push(item);
      }
  }
  /** Items whose boxes touch the query box (may contain duplicates). */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: T[] = []): T[] {
    const s = this.size;
    for (let ix = Math.floor(minX / s); ix <= Math.floor(maxX / s); ix++)
      for (let iz = Math.floor(minZ / s); iz <= Math.floor(maxZ / s); iz++) {
        const c = this.cells.get(this.key(ix, iz));
        if (c) for (const it of c) out.push(it);
      }
    return out;
  }
}
