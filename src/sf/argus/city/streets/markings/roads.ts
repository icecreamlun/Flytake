/**
 * Road markings from the analysed network: lane lines, double-yellow centre lines, red transit lanes (Market St),
 * green bike lanes, parking ticks, continental crosswalks, stop bars, tyre-wear / oil darkening in the wheel
 * paths, and concrete gutter pans along every curb. Longitudinal markings stop at intersections.
 */
import type { GroundSurface } from '../core/surface';
import type { Road, RoadNet } from '../core/roadnet';
import { CTX, inRect, type Rect } from '../core/zone';
import { CORE_BBOX, project } from '../../../geo';

const CORE: Rect = (() => {
  const [x0, z0] = project(CORE_BBOX.north, CORE_BBOX.west);
  const [x1, z1] = project(CORE_BBOX.south, CORE_BBOX.east);
  return { minX: x0, minZ: z0, maxX: x1, maxZ: z1 };
})();
import type { CurbLoop } from '../ground/tiles';
import { KIND_CURB } from '../ground/tiles';
import { Style } from './material';
import { StripBuilder } from './strips';

const STEP = 4;

/** Arc-length sample positions in [a, b], every ≤ step and at every polyline vertex. */
function samples(r: Road, a: number, b: number, STEP = 4): number[] {
  const out: number[] = [a];
  let k = 0;
  while (k < r.cum.length && r.cum[k] <= a) k++;
  let s = a;
  while (s < b) {
    const nextV = k < r.cum.length ? r.cum[k] : Infinity;
    const next = Math.min(s + STEP, nextV, b);
    if (next === nextV) k++;
    if (next - s > 0.05) out.push(next);
    s = next;
  }
  return out;
}

/** Free (non-intersection) runs along a road. */
function runs(r: Road): [number, number][] {
  const out: [number, number][] = [];
  let s = 0.3;
  for (const [a, b] of r.clear) {
    if (a > s + 1.5) out.push([s, Math.min(a, r.len - 0.3)]);
    s = Math.max(s, b);
  }
  if (r.len - 0.3 > s + 1.5) out.push([s, r.len - 0.3]);
  return out;
}

export function buildRoadMarkings(net: RoadNet, surface: GroundSurface, loops: CurbLoop[], sb: StripBuilder): void {
  const H = (x: number, z: number) => surface.meshHeight(x, z);
  const P = { x: 0, z: 0, dx: 0, dz: 0 };
  const Q = { x: 0, z: 0, dx: 0, dz: 0 };

  /** Offset polyline at lateral offset o (left positive) between a and b. */
  const offsetLine = (r: Road, a: number, b: number, o: number, step = 4): number[] => {
    const pts: number[] = [];
    for (const s of samples(r, a, b, step)) {
      net.at(r, s, P);
      // Smoothed tangent for stable offsets around polyline vertices.
      net.at(r, Math.max(0, s - 1.5), Q);
      const ax = Q.x;
      const az = Q.z;
      net.at(r, Math.min(r.len, s + 1.5), Q);
      let tx = Q.x - ax;
      let tz = Q.z - az;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      pts.push(P.x + tz * o, P.z - tx * o);
    }
    return pts;
  };

  for (const r of net.roads) {
    if (!r.major || !r.layout) continue;
    const mid = net.at(r, r.len / 2, P);
    if (!inRect(CTX, mid.x, mid.z, -10)) continue;
    const L = r.layout;
    const W = r.rec.width;
    const right = -W / 2;
    const kindRank = r.kind === 'primary' || r.kind === 'secondary' || r.kind === 'tertiary' || r.kind === 'motorway';
    const lines: { o: number; hw: number; style: Style }[] = [];
    const travel0 = right + L.parkR + L.bikeR; // right edge of the travel lanes
    if (!r.oneway && L.nb > 0) {
      if (kindRank || W >= 11) {
        lines.push({ o: L.centre + 0.11, hw: 0.055, style: Style.Yellow }, { o: L.centre - 0.11, hw: 0.055, style: Style.Yellow });
      }
      for (let k = 1; k < L.nf; k++) lines.push({ o: travel0 + k * L.lw, hw: 0.055, style: Style.White });
      for (let k = 1; k < L.nb; k++) lines.push({ o: L.centre + k * L.lw, hw: 0.055, style: Style.White });
    } else {
      for (let k = 1; k < L.n; k++) lines.push({ o: travel0 + k * L.lw, hw: 0.055, style: Style.White });
    }
    if (L.bikeR > 0) {
      lines.push({ o: right + L.parkR + L.bikeR, hw: 0.08, style: Style.White });
      lines.push({ o: right + L.parkR + L.bikeR / 2, hw: L.bikeR / 2 - 0.12, style: Style.Bike });
    }
    if (L.bikeL > 0) {
      lines.push({ o: W / 2 - L.parkL - L.bikeL, hw: 0.08, style: Style.White });
      lines.push({ o: W / 2 - L.parkL - L.bikeL / 2, hw: L.bikeL / 2 - 0.12, style: Style.Bike });
    }
    if (L.parkR > 0) lines.push({ o: right + L.parkR, hw: 0.05, style: Style.ParkTick });
    if (L.parkL > 0) lines.push({ o: W / 2 - L.parkL, hw: 0.05, style: Style.ParkTick });
    if (L.transit) {
      lines.push({ o: L.centre - L.lw / 2, hw: L.lw / 2 - 0.15, style: Style.Transit });
      lines.push({ o: L.centre + L.lw / 2, hw: L.lw / 2 - 0.15, style: Style.Transit });
    }
    // Wheel-path wear and the oily centre of each travel lane (arterials in the core study area only).
    const wearOn = kindRank && inRect(CORE, mid.x, mid.z, 0);
    for (let k = 0; k < (wearOn ? L.n : 0); k++) {
      const c = travel0 + (k + 0.5) * L.lw + (!r.oneway && k >= L.nf ? 0 : 0);
      lines.push({ o: c - 0.85, hw: 0.32, style: Style.Wear }, { o: c + 0.85, hw: 0.32, style: Style.Wear });
      lines.push({ o: c, hw: 0.3, style: Style.Oil });
    }

    for (const [a, b] of runs(r)) {
      for (const ln of lines) {
        const soft = ln.style === Style.Wear || ln.style === Style.Oil;
        const pts = offsetLine(r, a, b, ln.o, soft ? 8 : 4);
        sb.add(pts, ln.hw, ln.style, a, H, soft ? 0.012 : 0.02);
      }
    }

    // Crosswalks and stop bars.
    for (const c of r.crossings) {
      const sm = (c.s0 + c.s1) / 2;
      const hwBand = (c.s1 - c.s0) / 2;
      const o0 = right + 0.35;
      const o1 = W / 2 - 0.35;
      const n = Math.max(2, Math.ceil((o1 - o0) / 2));
      net.at(r, sm, P);
      const tx = P.dx;
      const tz = P.dz;
      // Across-road polyline from right to left: its left normal points back along -s… either way the band is symmetric.
      const pts: number[] = [];
      for (let k = 0; k <= n; k++) {
        const o = o0 + ((o1 - o0) * k) / n;
        pts.push(P.x + tz * o, P.z - tx * o);
      }
      const len = o1 - o0;
      const u0 = -((len % 1.2) - 0.6) / 2;
      sb.add(pts, hwBand, Style.Crosswalk, u0, H);
      if (!Number.isNaN(c.stopS) && L) {
        let lo = right + L.parkR + 0.2;
        let hi = W / 2 - L.parkL - 0.2;
        if (c.stopSide > 0) lo = L.centre + 0.25;
        else if (c.stopSide < 0) hi = L.centre - 0.25;
        if (hi - lo > 1.5) {
          net.at(r, c.stopS, P);
          const sp: number[] = [];
          const m = Math.max(2, Math.ceil((hi - lo) / 2));
          for (let k = 0; k <= m; k++) {
            const o = lo + ((hi - lo) * k) / m;
            sp.push(P.x + P.dz * o, P.z - P.dx * o);
          }
          sb.add(sp, 0.22, Style.StopBar, 0, H);
        }
      }
    }
  }

  // Gutter pans along curbs (road side of every curb face).
  for (const loop of loops) {
    const n = loop.pts.length / 2;
    // Collect maximal runs of curb edges.
    let start = -1;
    for (let i = 0; i < n; i++) if (loop.edge[i] !== KIND_CURB) start = i;
    if (start < 0) start = 0; // closed curb loop
    const emitRun = (idxs: number[]) => {
      if (idxs.length < 2) return;
      let pts: number[] = [];
      for (const i of idxs) pts.push(loop.pts[i * 2], loop.pts[i * 2 + 1]);
      // Simplify then re-densify (≤ 4 m) to follow the terrain.
      if (pts.length > 8) pts = simplifyOpen(pts, 0.08);
      const dense: number[] = [];
      for (let k = 0; k < pts.length - 2; k += 2) {
        const ax = pts[k];
        const az = pts[k + 1];
        const bx = pts[k + 2];
        const bz = pts[k + 3];
        const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP));
        for (let j = 0; j < m; j++) dense.push(ax + ((bx - ax) * j) / m, az + ((bz - az) * j) / m);
      }
      dense.push(pts[pts.length - 2], pts[pts.length - 1]);
      // The block is on the left of the loop direction, so the road side is the strip's right: offset by −0.24.
      const off: number[] = [];
      const m = dense.length / 2;
      for (let k = 0; k < m; k++) {
        const kp = Math.max(0, k - 1);
        const kn = Math.min(m - 1, k + 1);
        let tx = dense[kn * 2] - dense[kp * 2];
        let tz = dense[kn * 2 + 1] - dense[kp * 2 + 1];
        const l = Math.hypot(tx, tz) || 1;
        tx /= l;
        tz /= l;
        off.push(dense[k * 2] - tz * 0.24, dense[k * 2 + 1] + tx * 0.24);
      }
      sb.add(off, 0.22, Style.Gutter, 0, H, 0.015);
    };
    let run: number[] = [];
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (loop.edge[i] === KIND_CURB) {
        if (!run.length) run.push(i);
        run.push((i + 1) % n);
      } else if (run.length) {
        emitRun(run);
        run = [];
      }
    }
    if (run.length) emitRun(run);
  }
}

/** Douglas–Peucker on an open polyline (flat x,z). */
export function simplifyOpen(p: number[], tol: number): number[] {
  const n = p.length / 2;
  if (n < 3) return p;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = p[a * 2];
    const az = p[a * 2 + 1];
    const dx = p[b * 2] - ax;
    const dz = p[b * 2 + 1] - az;
    const L2 = dx * dx + dz * dz || 1e-12;
    let best = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = p[i * 2] - ax;
      const pz = p[i * 2 + 1] - az;
      const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / L2));
      const d = (px - dx * t) ** 2 + (pz - dz * t) ** 2;
      if (d > best) {
        best = d;
        idx = i;
      }
    }
    if (idx >= 0 && best > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}
