/**
 * Wall-edge analysis across the whole city, run once at load:
 *  - coplanar suppression: nested / flush building:part prisms produce coincident wall planes that
 *    would z-fight; the lower one is clipped (its wall starts where the covering wall ends).
 *  - party walls: a wall that backs onto another building (opposite-facing coincident edge of a
 *    different group) is a blank lot-line wall — no windows.
 *  - street frontage: walls that face a road get storefronts, awnings, signs, cornices.
 */
import type { RoadRecord, XZ } from '../../contracts';
import { GridHash, distToSegment, edgeNormal } from './footprint';

export interface Solid {
  /** Building index in city.buildings. */
  bld: number;
  group: string;
  rings: XZ[][]; // [outer, ...holes], oriented per footprint.ts
  bottom: number; // world Y where the walls start
  top: number; // world Y of the roof top
}

export interface WallPiece {
  bld: number;
  ring: number;
  edge: number;
  /** Parameter range along the edge (0..1). */
  t0: number;
  t1: number;
  bottom: number;
  /** World Y of the abutting neighbour's roof where this is a lot-line (party) wall, else 0. */
  partyTop: number;
}

export interface EdgeFlags {
  street: boolean;
  /** Distance from the wall to the road centreline (m), if street-facing. */
  streetDist: number;
}

interface EdgeRef {
  s: number; // solid index
  ring: number;
  edge: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  len: number;
  dx: number;
  dz: number;
}

const PLANE_TOL = 0.35; // m — max offset between two walls considered coincident
const PARALLEL = 0.985;

export function analyseWalls(solids: Solid[]): WallPiece[] {
  const edges: EdgeRef[] = [];
  const hash = new GridHash<EdgeRef>(10);
  solids.forEach((sol, s) => {
    sol.rings.forEach((ring, r) => {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.05) continue;
        const e: EdgeRef = { s, ring: r, edge: i, ax: a[0], az: a[1], bx: b[0], bz: b[1], len, dx: (b[0] - a[0]) / len, dz: (b[1] - a[1]) / len };
        edges.push(e);
        hash.insertBox(Math.min(a[0], b[0]) - 0.5, Math.min(a[1], b[1]) - 0.5, Math.max(a[0], b[0]) + 0.5, Math.max(a[1], b[1]) + 0.5, e);
      }
    });
  });

  const pieces: WallPiece[] = [];
  const near: EdgeRef[] = [];
  for (const e of edges) {
    const E = solids[e.s];
    near.length = 0;
    hash.query(Math.min(e.ax, e.bx) - 0.5, Math.min(e.az, e.bz) - 0.5, Math.max(e.ax, e.bx) + 0.5, Math.max(e.az, e.bz) + 0.5, near);
    // Intervals along e: [t0, t1, kind, value]; kind 0 = cover (value = cover top), 1 = party.
    const ivs: [number, number, number, number][] = [];
    const seen = new Set<EdgeRef>();
    for (const o of near) {
      if (o.s === e.s || seen.has(o)) continue;
      seen.add(o);
      const dot = e.dx * o.dx + e.dz * o.dz;
      if (Math.abs(dot) < PARALLEL) continue;
      // Perpendicular offset of o's endpoints from e's line.
      const da = Math.abs((o.ax - e.ax) * e.dz - (o.az - e.az) * e.dx);
      const db = Math.abs((o.bx - e.ax) * e.dz - (o.bz - e.az) * e.dx);
      if (da > PLANE_TOL || db > PLANE_TOL) continue;
      const ta = ((o.ax - e.ax) * e.dx + (o.az - e.az) * e.dz) / e.len;
      const tb = ((o.bx - e.ax) * e.dx + (o.bz - e.az) * e.dz) / e.len;
      const t0 = Math.max(0, Math.min(ta, tb));
      const t1 = Math.min(1, Math.max(ta, tb));
      if ((t1 - t0) * e.len < 0.3) continue;
      const O = solids[o.s];
      if (dot > 0) {
        // Same-facing coincident wall: the covering wall hides ours where it spans our bottom.
        if (O.bottom > E.bottom + 0.15 || O.top <= E.bottom + 0.05) continue;
        if (Math.abs(O.top - E.top) < 0.05 && Math.abs(O.bottom - E.bottom) < 0.15 && E.bld < O.bld) continue; // tie: keep lower index
        ivs.push([t0, t1, 0, O.top]);
      } else if (O.group !== E.group) {
        ivs.push([t0, t1, 1, O.top]);
      }
    }
    if (!ivs.length) {
      pieces.push({ bld: E.bld, ring: e.ring, edge: e.edge, t0: 0, t1: 1, bottom: E.bottom, partyTop: 0 });
      continue;
    }
    const cuts = new Set<number>([0, 1]);
    for (const iv of ivs) {
      cuts.add(iv[0]);
      cuts.add(iv[1]);
    }
    const ts = [...cuts].sort((a, b) => a - b);
    let cur: WallPiece | null = null;
    for (let k = 0; k < ts.length - 1; k++) {
      const a = ts[k];
      const b = ts[k + 1];
      if ((b - a) * e.len < 0.02) continue;
      const m = (a + b) / 2;
      let bottom = E.bottom;
      let partyTop = 0;
      for (const iv of ivs) {
        if (m < iv[0] || m > iv[1]) continue;
        if (iv[2] === 0) bottom = Math.max(bottom, iv[3]);
        else partyTop = Math.max(partyTop, iv[3]);
      }
      if (bottom >= E.top - 0.05) {
        cur = null;
        continue;
      }
      if (cur && cur.t1 === a && Math.abs(cur.bottom - bottom) < 1e-3 && cur.partyTop === partyTop) {
        cur.t1 = b;
      } else {
        cur = { bld: E.bld, ring: e.ring, edge: e.edge, t0: a, t1: b, bottom, partyTop };
        pieces.push(cur);
      }
    }
  }
  return pieces;
}

const STREET_KINDS = new Set(['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living_street', 'pedestrian', 'footway', 'steps', 'cycleway']);

/** Builds a road-segment index and returns a classifier for wall edges. */
export function createStreetClassifier(roads: RoadRecord[]) {
  interface Seg {
    ax: number;
    az: number;
    bx: number;
    bz: number;
    reach: number;
    dx: number;
    dz: number;
    major: boolean;
  }
  const hash = new GridHash<Seg>(25);
  for (const r of roads) {
    if (!STREET_KINDS.has(r.kind) || r.tunnel) continue;
    const major = r.kind !== 'footway' && r.kind !== 'steps' && r.kind !== 'cycleway' && r.kind !== 'service';
    const reach = r.width / 2 + (r.sidewalk ?? (major ? 3 : 0.5)) + 6.5;
    for (let i = 0; i < r.points.length - 1; i++) {
      const [ax, az] = r.points[i];
      const [bx, bz] = r.points[i + 1];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 0.1) continue;
      const seg: Seg = { ax, az, bx, bz, reach, dx: (bx - ax) / l, dz: (bz - az) / l, major };
      hash.insertBox(Math.min(ax, bx) - reach, Math.min(az, bz) - reach, Math.max(ax, bx) + reach, Math.max(az, bz) + reach, seg);
    }
  }
  const near: Seg[] = [];
  return (a: XZ, b: XZ): EdgeFlags => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const res: EdgeFlags = { street: false, streetDist: 0 };
    if (len < 1.5) return res;
    const n = edgeNormal(a, b);
    const ex = (b[0] - a[0]) / len;
    const ez = (b[1] - a[1]) / len;
    let hits = 0;
    let best = Infinity;
    for (const f of [0.2, 0.5, 0.8]) {
      const px = a[0] + (b[0] - a[0]) * f;
      const pz = a[1] + (b[1] - a[1]) * f;
      near.length = 0;
      hash.query(px - 1, pz - 1, px + 1, pz + 1, near);
      let ok = false;
      for (const s of near) {
        if (Math.abs(s.dx * ex + s.dz * ez) < 0.6) continue;
        const { d, t } = distToSegment(px, pz, s.ax, s.az, s.bx, s.bz);
        if (d > s.reach) continue;
        const qx = s.ax + (s.bx - s.ax) * t - px;
        const qz = s.az + (s.bz - s.az) * t - pz;
        if (qx * n[0] + qz * n[1] <= 0.5) continue; // road must be in front of the wall
        ok = true;
        if (d < best) best = d;
      }
      if (ok) hits++;
    }
    res.street = hits >= 2;
    res.streetDist = res.street ? best : 0;
    return res;
  };
}
