/**
 * Clip a polygon (outer ring + holes) against the terrain lattice: recursive Sutherland–Hodgman halving along
 * grid lines until every piece fits in one cell. Each piece is then either a full cell (emitted with the
 * terrain's own diagonal so it is an exact offset of the terrain) or triangulated with earcut. The resulting
 * surface follows the triangulated terrain exactly on every cell edge.
 */
import { Earcut } from 'three/src/extras/Earcut.js';
import { ringArea } from './contour';

/** Split a ring by the line coord[axis] = v. Returns [≤ v side, ≥ v side]. */
function splitRing(r: number[], axis: 0 | 1, v: number): [number[], number[]] {
  const lo: number[] = [];
  const hi: number[] = [];
  const n = r.length / 2;
  const push = (arr: number[], x: number, z: number) => {
    const m = arr.length;
    if (m >= 2 && Math.abs(arr[m - 2] - x) < 1e-7 && Math.abs(arr[m - 1] - z) < 1e-7) return;
    arr.push(x, z);
  };
  for (let i = 0; i < n; i++) {
    const px = r[i * 2];
    const pz = r[i * 2 + 1];
    const j = (i + 1) % n;
    const qx = r[j * 2];
    const qz = r[j * 2 + 1];
    const pc = axis === 0 ? px : pz;
    const qc = axis === 0 ? qx : qz;
    const pIn = pc <= v;
    const qIn = qc <= v;
    if (pIn) push(lo, px, pz);
    else push(hi, px, pz);
    if (pIn !== qIn) {
      const t = (v - pc) / (qc - pc);
      const ix = axis === 0 ? v : px + (qx - px) * t;
      const iz = axis === 0 ? pz + (qz - pz) * t : v;
      push(lo, ix, iz);
      push(hi, ix, iz);
    }
  }
  return [lo, hi];
}

function valid(r: number[]): boolean {
  return r.length >= 6 && Math.abs(ringArea(r)) > 1e-4;
}

export interface CellPiece {
  ci: number;
  cj: number;
  full: boolean;
  /** Flat x,z vertex list and triangle indices (when not full). */
  verts: number[];
  tris: number[];
}

/**
 * rings[0] = outer, rest = holes. Grid lines at x = gx0 + ci*cs, z = gz0 + cj*cs.
 * Calls emit for every non-empty cell piece.
 */
export function clipToGrid(rings: number[][], gx0: number, gz0: number, cs: number, emit: (p: CellPiece) => void): void {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  const o = rings[0];
  for (let i = 0; i < o.length; i += 2) {
    x0 = Math.min(x0, o[i]);
    x1 = Math.max(x1, o[i]);
    z0 = Math.min(z0, o[i + 1]);
    z1 = Math.max(z1, o[i + 1]);
  }
  const ci0 = Math.floor((x0 - gx0) / cs);
  const ci1 = Math.ceil((x1 - gx0) / cs);
  const cj0 = Math.floor((z0 - gz0) / cs);
  const cj1 = Math.ceil((z1 - gz0) / cs);
  const full = cs * cs * 0.9999;

  const rec = (rs: number[][], a0: number, a1: number, b0: number, b1: number) => {
    if (a1 - a0 > 1 || b1 - b0 > 1) {
      const splitX = a1 - a0 >= b1 - b0;
      const mid = splitX ? (a0 + a1) >> 1 : (b0 + b1) >> 1;
      const v = splitX ? gx0 + mid * cs : gz0 + mid * cs;
      const loR: number[][] = [];
      const hiR: number[][] = [];
      for (let k = 0; k < rs.length; k++) {
        const [lo, hi] = splitRing(rs[k], splitX ? 0 : 1, v);
        if (k === 0) {
          // Outer ring must survive on a side for its holes to matter.
          loR.push(valid(lo) ? lo : []);
          hiR.push(valid(hi) ? hi : []);
        } else {
          if (valid(lo)) loR.push(lo);
          if (valid(hi)) hiR.push(hi);
        }
      }
      if (loR[0].length) {
        if (splitX) rec(loR, a0, mid, b0, b1);
        else rec(loR, a0, a1, b0, mid);
      }
      if (hiR[0].length) {
        if (splitX) rec(hiR, mid, a1, b0, b1);
        else rec(hiR, a0, a1, mid, b1);
      }
      return;
    }
    const outer = rs[0];
    const area = Math.abs(ringArea(outer));
    if (rs.length === 1 && area >= full) {
      emit({ ci: a0, cj: b0, full: true, verts: [], tris: [] });
      return;
    }
    const flat: number[] = outer.slice();
    const holes: number[] = [];
    for (let k = 1; k < rs.length; k++) {
      holes.push(flat.length / 2);
      for (const v of rs[k]) flat.push(v);
    }
    const tris = Earcut.triangulate(flat, holes.length ? holes : undefined, 2);
    if (tris.length) emit({ ci: a0, cj: b0, full: false, verts: flat, tris });
  };
  rec(rings, ci0, Math.max(ci1, ci0 + 1), cj0, Math.max(cj1, cj0 + 1));
}
