/**
 * Flat decks (plazas built on garage roofs, e.g. Portsmouth Square). The DEM drapes such sites as wavy humps;
 * here the site becomes a level paved deck:
 *  - `deckLoop`: the deck outline = source polygon ∩ block (≥ 1.5 m from every curb, so sidewalks stay), traced
 *    from the tile's 0.5 m block raster and densified on the terrain lattice;
 *  - `buildDeck`: deck surface (kind 1 → landcover pavers), board-formed retaining walls to the surrounding block
 *    top (down where the street falls away, up where it climbs) and 1 m parapets where the drop exceeds ~0.6 m.
 */
import { Earcut } from 'three/src/extras/Earcut.js';
import type { Deck, GroundSurface } from '../core/surface';
import { densifyOnGrid, marchingSquares, pointInRing, ringArea, simplifyRing, smoothRing } from '../core/contour';
import { MASK_RES } from '../core/zone';
import type { GeoBuilder } from './tiles';

const KIND_BLOCK = 1;
const KIND_WALL = 7;
const PARAPET_H = 1.0;
const PARAPET_T = 0.3;

/** Deck outline from the tile's block field (W×W, 1-px zero border, origin tx0/tz0 at 0.5 m per px). */
export function deckLoop(d: Deck, field: Float32Array, W: number, tx0: number, tz0: number, surface: GroundSurface): number[] | null {
  const sub = new Float32Array(W * W);
  const E = 3; // erosion: 1.5 m away from the carriageway
  const i0 = Math.max(E + 1, Math.floor((d.bb[0] - tx0) / MASK_RES) - 1);
  const i1 = Math.min(W - E - 3, Math.ceil((d.bb[2] - tx0) / MASK_RES) + 1);
  const j0 = Math.max(E + 1, Math.floor((d.bb[1] - tz0) / MASK_RES) - 1);
  const j1 = Math.min(W - E - 3, Math.ceil((d.bb[3] - tz0) / MASK_RES) + 1);
  const offs = [
    [E, 0],
    [-E, 0],
    [0, E],
    [0, -E],
    [2, 2],
    [-2, 2],
    [2, -2],
    [-2, -2],
  ];
  let n = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = tx0 + (i + 0.5) * MASK_RES;
      const z = tz0 + (j + 0.5) * MASK_RES;
      if (!pointInRing(d.src, x, z)) continue;
      const fi = (j + 1) * W + i + 1;
      if (field[fi] < 0.99) continue;
      let ok = true;
      for (const [a, b] of offs) if (field[fi + b * W + a] < 0.99) ok = false;
      if (ok) {
        sub[fi] = 1;
        n++;
      }
    }
  }
  if (n < 200) return null;
  const rings = marchingSquares(sub, W, W, tx0 - 0.5 * MASK_RES, tz0 - 0.5 * MASK_RES, MASK_RES);
  let best: number[] | null = null;
  let bestA = 0;
  for (const r of rings) {
    const a = ringArea(r);
    if (a < 0 && -a > bestA) {
      bestA = -a;
      best = r;
    }
  }
  if (!best) return null;
  const sm = simplifyRing(smoothRing(best, 4, () => false), 0.35);
  return densifyOnGrid(sm, surface.minX, surface.minZ, surface.cs);
}

/** Deck surface, retaining walls and parapets for a deck whose loop is set. */
export function buildDeck(d: Deck, surface: GroundSurface, B: GeoBuilder): void {
  const L = d.loop!;
  const n = L.length / 2;
  const y = d.y;
  // ── Surface.
  const tris = Earcut.triangulate(L, [], 2);
  const base = B.pos.length / 3;
  for (let k = 0; k < n; k++) B.vert(L[k * 2], y, L[k * 2 + 1], 0, 1, 0, KIND_BLOCK);
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k];
    const b = tris[k + 1];
    const c = tris[k + 2];
    const cy = (L[b * 2 + 1] - L[a * 2 + 1]) * (L[c * 2] - L[a * 2]) - (L[b * 2] - L[a * 2]) * (L[c * 2 + 1] - L[a * 2 + 1]);
    if (cy > 0) B.idx.push(base + a, base + b, base + c);
    else B.idx.push(base + a, base + c, base + b);
  }
  // ── Edge frames: outward normals per edge, mitred per vertex; ground height per vertex.
  const enx = new Float32Array(n);
  const enz = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const dx = L[j * 2] - L[k * 2];
    const dz = L[j * 2 + 1] - L[k * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    let ox = dz / l;
    let oz = -dx / l;
    if (pointInRing(L, (L[k * 2] + L[j * 2]) / 2 + ox * 0.2, (L[k * 2 + 1] + L[j * 2 + 1]) / 2 + oz * 0.2)) {
      ox = -ox;
      oz = -oz;
    }
    enx[k] = ox;
    enz[k] = oz;
  }
  const mx = new Float32Array(n);
  const mz = new Float32Array(n);
  const g = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const p = (k - 1 + n) % n;
    let x = enx[p] + enx[k];
    let z = enz[p] + enz[k];
    const l = Math.hypot(x, z) || 1;
    x /= l;
    z /= l;
    const c = Math.max(0.5, x * enx[k] + z * enz[k]);
    mx[k] = x / c;
    mz[k] = z / c;
    g[k] = surface.blockTop(L[k * 2], L[k * 2 + 1]);
  }
  // Quad with a given facing (normal nx, ny, nz); vertex order p0..p3 around the quad.
  const quad = (p: number[][], nx: number, ny: number, nz: number) => {
    const v = p.map((q) => B.vert(q[0], q[1], q[2], nx, ny, nz, KIND_WALL));
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    if (cx * nx + cy * ny + cz * nz > 0) B.idx.push(v[0], v[1], v[2], v[0], v[2], v[3]);
    else B.idx.push(v[0], v[2], v[1], v[0], v[3], v[2]);
  };
  const side = (dd: number) => (dd > 0.6 ? 1 : dd < -0.6 ? -1 : 0);
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const ax = L[k * 2];
    const az = L[k * 2 + 1];
    const bx = L[j * 2];
    const bz = L[j * 2 + 1];
    const da = y - g[k];
    const db = y - g[j];
    const ox = enx[k];
    const oz = enz[k];
    // Retaining wall (split where deck and ground levels cross).
    const pieces: [number, number][] = [];
    if (da * db < 0) {
      const t = da / (da - db);
      pieces.push([0, t], [t, 1]);
    } else pieces.push([0, 1]);
    const sa = side(da);
    const parapet = sa !== 0 && sa === side(db);
    for (const [t0, t1] of pieces) {
      const tm = (t0 + t1) / 2;
      const dm = da + (db - da) * tm;
      if (Math.abs(da + (db - da) * t0) < 0.02 && Math.abs(da + (db - da) * t1) < 0.02) continue;
      const P = [ax + (bx - ax) * t0, az + (bz - az) * t0, g[k] + (g[j] - g[k]) * t0];
      const Q = [ax + (bx - ax) * t1, az + (bz - az) * t1, g[k] + (g[j] - g[k]) * t1];
      // Visible face: outward where the deck stands above the street, inward where the street is higher.
      const s = dm > 0 ? 1 : -1;
      const topP = Math.max(y, P[2]) + (parapet ? PARAPET_H : 0);
      const topQ = Math.max(y, Q[2]) + (parapet ? PARAPET_H : 0);
      const botP = Math.min(y, P[2]) - 0.08;
      const botQ = Math.min(y, Q[2]) - 0.08;
      quad(
        [
          [P[0], topP, P[1]],
          [P[0], botP, P[1]],
          [Q[0], botQ, Q[1]],
          [Q[0], topQ, Q[1]],
        ],
        ox * s,
        0,
        oz * s,
      );
    }
    if (!parapet) continue;
    // Parapet on the upper side: cap + back face, offset by its thickness (inward on the deck, outward on the street).
    const s = sa;
    const off = -s * PARAPET_T;
    const ix = ax + mx[k] * off;
    const iz = az + mz[k] * off;
    const jx = bx + mx[j] * off;
    const jz = bz + mz[j] * off;
    const topA = Math.max(y, g[k]) + PARAPET_H;
    const topB = Math.max(y, g[j]) + PARAPET_H;
    const lowA = s > 0 ? y - 0.05 : surface.blockTop(ix, iz) - 0.08;
    const lowB = s > 0 ? y - 0.05 : surface.blockTop(jx, jz) - 0.08;
    quad(
      [
        [ax, topA, az],
        [ix, topA, iz],
        [jx, topB, jz],
        [bx, topB, bz],
      ],
      0,
      1,
      0,
    );
    quad(
      [
        [ix, topA, iz],
        [ix, lowA, iz],
        [jx, lowB, jz],
        [jx, topB, jz],
      ],
      -ox * s,
      0,
      -oz * s,
    );
    // End caps where a parapet run starts or stops.
    const prevOn = side(y - g[(k - 1 + n) % n]) === s && side(da) === s;
    const nextOn = side(y - g[(j + 1) % n]) === s && side(db) === s;
    const cap = (px: number, pz: number, qx: number, qz: number, top: number, low: number, dx: number, dz: number) =>
      quad(
        [
          [px, top, pz],
          [px, low, pz],
          [qx, low, qz],
          [qx, top, qz],
        ],
        dx,
        0,
        dz,
      );
    const ex = bx - ax;
    const ez = bz - az;
    const el = Math.hypot(ex, ez) || 1;
    if (!prevOn) cap(ax, az, ix, iz, topA, Math.min(lowA, y - 0.05), -ex / el, -ez / el);
    if (!nextOn) cap(bx, bz, jx, jz, topB, Math.min(lowB, y - 0.05), ex / el, ez / el);
  }
}
