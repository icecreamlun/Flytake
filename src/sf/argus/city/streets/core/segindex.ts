/**
 * Uniform-grid spatial index of road centreline segments: nearest-street queries for props, tree wells and
 * vehicle placement.
 */
import type { Road, RoadNet } from './roadnet';

export interface NearestSeg {
  road: Road;
  /** Arc length of the closest point. */
  s: number;
  /** Distance from the query point to the centreline (m). */
  dist: number;
  /** Unit tangent of the segment. */
  dx: number;
  dz: number;
  /** +1 if the point is on the road's left side, −1 right. */
  side: number;
}

export class SegIndex {
  private cells = new Map<number, number[]>();
  private segs: { road: Road; i: number }[] = [];
  constructor(
    net: RoadNet,
    filter: (r: Road) => boolean,
    private cell = 24,
  ) {
    for (const r of net.roads) {
      if (!filter(r)) continue;
      for (let i = 0; i < r.pts.length / 2 - 1; i++) {
        const id = this.segs.length;
        this.segs.push({ road: r, i });
        const ax = r.pts[i * 2];
        const az = r.pts[i * 2 + 1];
        const bx = r.pts[i * 2 + 2];
        const bz = r.pts[i * 2 + 3];
        const x0 = Math.floor(Math.min(ax, bx) / cell);
        const x1 = Math.floor(Math.max(ax, bx) / cell);
        const z0 = Math.floor(Math.min(az, bz) / cell);
        const z1 = Math.floor(Math.max(az, bz) / cell);
        for (let cx = x0; cx <= x1; cx++)
          for (let cz = z0; cz <= z1; cz++) {
            const k = cx * 100003 + cz;
            let l = this.cells.get(k);
            if (!l) this.cells.set(k, (l = []));
            l.push(id);
          }
      }
    }
  }

  nearest(x: number, z: number, maxDist = 40): NearestSeg | null {
    const c = this.cell;
    const R = Math.ceil(maxDist / c);
    const cx0 = Math.floor(x / c);
    const cz0 = Math.floor(z / c);
    let best: NearestSeg | null = null;
    let bestD = maxDist;
    const seen = new Set<number>();
    for (let dx = -R; dx <= R; dx++)
      for (let dz = -R; dz <= R; dz++) {
        const l = this.cells.get((cx0 + dx) * 100003 + cz0 + dz);
        if (!l) continue;
        for (const id of l) {
          if (seen.has(id)) continue;
          seen.add(id);
          const { road, i } = this.segs[id];
          const ax = road.pts[i * 2];
          const az = road.pts[i * 2 + 1];
          const ex = road.pts[i * 2 + 2] - ax;
          const ez = road.pts[i * 2 + 3] - az;
          const L2 = ex * ex + ez * ez || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
          const px = ax + ex * t;
          const pz = az + ez * t;
          const d = Math.hypot(x - px, z - pz);
          if (d < bestD) {
            bestD = d;
            const L = Math.sqrt(L2);
            const tx = ex / L;
            const tz = ez / L;
            // Left of (tx, tz) is (tz, -tx).
            const side = (x - px) * tz + (z - pz) * -tx >= 0 ? 1 : -1;
            best = { road, s: road.cum[i] + L * t, dist: d, dx: tx, dz: tz, side };
          }
        }
      }
    return best;
  }
}
