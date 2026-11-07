/**
 * Detail-zone ground tiles. Per 640 m tile:
 *  1. rasterise the carriageway (curbed roads + curb-return fillets) at 0.5 m on a canvas,
 *  2. block field = land × ¬carriageway, padded with 0 so every block contour closes on the tile edge,
 *  3. marching squares → block outlines (curb lines / seawall lines) → simplified, densified on the 4 m lattice,
 *  4. block tops = outlines clipped to lattice cells, lifted to sidewalk level (+15 cm) / promenade level,
 *  5. curb faces (15 cm) and seawall faces (down into the bay) along the outlines,
 *  6. road-level lattice quads for every cell not completely covered by a block top.
 * All of it is one BufferGeometry per tile with an `aKind` attribute: 0 road, 1 block top, 2 curb face,
 * 3 seawall face.
 */
import * as THREE from 'three';
import type { GroundSurface } from '../core/surface';
import { LAND_ISO } from '../core/surface';
import type { RoadNet } from '../core/roadnet';
import { DZ, MASK_RES, TILE } from '../core/zone';
import { densifyOnGrid, marchingSquares, pointInRing, ringArea, ringBBox, simplifyRing, simplifyRuns, smoothRing } from '../core/contour';
import { clipToGrid, type CellPiece } from '../core/clip';
import { buildDeck, deckLoop } from './deck';

export const KIND_ROAD = 0;
export const KIND_BLOCK = 1;
export const KIND_CURB = 2;
export const KIND_SEAWALL = 3;
export const KIND_OUTER = 4;
export const KIND_PIER = 5; // pier deck lip (concrete)
export const KIND_UNDERDECK = 6; // shadowed bay under a pier deck (pilings)
export const KIND_WALL = 7; // board-formed concrete retaining wall / parapet

export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  kind: number[] = [];
  idx: number[] = [];
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, k: number): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.kind.push(k);
    return this.pos.length / 3 - 1;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.kind, 1));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export interface CurbLoop {
  /** Flat x,z ring, block on the map-left. */
  pts: number[];
  /** Per-edge face type: 0 none (tile border), 2 curb, 3 seawall. */
  edge: Uint8Array;
}

export interface GroundTile {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Full detail: road cells, raised blocks, curb faces. */
  detail: THREE.BufferGeometry;
  /** Far LOD: 8 m lattice at road/block level; surface kind comes from the block-mask texture (aKind = −1). */
  coarse: THREE.BufferGeometry;
  /** Seawall / pier faces, shown with either LOD. */
  faces: THREE.BufferGeometry | null;
}

export interface DetailGround {
  tiles: GroundTile[];
  loops: CurbLoop[];
}

export function buildDetailGround(surface: GroundSurface, net: RoadNet, piers: number[][] = []): DetailGround {
  const pierBB = piers.map((r) => ringBBox(r));
  const inPier = (x: number, z: number) => piers.some((r, i) => x >= pierBB[i][0] - 2 && x <= pierBB[i][2] + 2 && z >= pierBB[i][1] - 2 && z <= pierBB[i][3] + 2 && (pointInRing(r, x, z) || pointInRing(r, x + 1.5, z) || pointInRing(r, x - 1.5, z) || pointInRing(r, x, z + 1.5) || pointInRing(r, x, z - 1.5)));
  const PX = Math.round(TILE / MASK_RES);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PX;
  const g2 = canvas.getContext('2d', { willReadFrequently: true })!;
  const W = PX + 2;
  const field = new Float32Array(W * W);
  const maskW = DZ.maxX - DZ.minX;
  const maskH = DZ.maxZ - DZ.minZ;
  surface.blockMask = new Uint8Array(maskW * maskH);

  const curbed = net.roads.filter((r) => r.curbed);
  const rb = curbed.map((r) => {
    const [x0, z0, x1, z1] = ringBBox(r.pts);
    return [x0 - r.hw, z0 - r.hw, x1 + r.hw, z1 + r.hw];
  });

  const tiles: GroundTile[] = [];
  const loopsOut: CurbLoop[] = [];
  const cs = surface.cs;

  for (let tz0 = DZ.minZ; tz0 < DZ.maxZ - 1; tz0 += TILE) {
    for (let tx0 = DZ.minX; tx0 < DZ.maxX - 1; tx0 += TILE) {
      const tx1 = tx0 + TILE;
      const tz1 = tz0 + TILE;
      // 1. carriageway raster.
      g2.setTransform(1, 0, 0, 1, 0, 0);
      g2.fillStyle = '#000';
      g2.fillRect(0, 0, PX, PX);
      g2.setTransform(1 / MASK_RES, 0, 0, 1 / MASK_RES, -tx0 / MASK_RES, -tz0 / MASK_RES);
      g2.strokeStyle = '#fff';
      g2.fillStyle = '#fff';
      g2.lineCap = 'round';
      g2.lineJoin = 'round';
      curbed.forEach((r, i) => {
        const b = rb[i];
        if (b[2] < tx0 || b[0] > tx1 || b[3] < tz0 || b[1] > tz1) return;
        g2.lineWidth = r.hw * 2;
        g2.beginPath();
        g2.moveTo(r.pts[0], r.pts[1]);
        for (let k = 2; k < r.pts.length; k += 2) g2.lineTo(r.pts[k], r.pts[k + 1]);
        g2.stroke();
      });
      for (const n of net.nodes) {
        if (n.x < tx0 - 40 || n.x > tx1 + 40 || n.z < tz0 - 40 || n.z > tz1 + 40) continue;
        for (const f of n.fillets) {
          g2.beginPath();
          g2.moveTo(f[0], f[1]);
          for (let k = 2; k < f.length; k += 2) g2.lineTo(f[k], f[k + 1]);
          g2.closePath();
          g2.fill();
        }
      }
      const img = g2.getImageData(0, 0, PX, PX).data;

      // 2. block field (land × not carriageway), zero border.
      field.fill(0);
      // Per-lattice-cell shore flag: only cells whose lowest corner nears sea level need per-pixel land tests.
      const NCs = Math.round(TILE / cs);
      const ci0s = Math.round((tx0 - surface.minX) / cs);
      const cj0s = Math.round((tz0 - surface.minZ) / cs);
      const shore = new Uint8Array(NCs * NCs);
      for (let lj = 0; lj < NCs; lj++)
        for (let li = 0; li < NCs; li++) {
          const c = ci0s + li;
          const r = cj0s + lj;
          const h0 = surface.gridValue(c, r);
          const h1 = surface.gridValue(c + 1, r);
          const h2 = surface.gridValue(c, r + 1);
          const h3 = surface.gridValue(c + 1, r + 1);
          const lo = Math.min(h0, h1, h2, h3);
          const hi = Math.max(h0, h1, h2, h3);
          // 0 = dry land, 1 = straddles the shoreline, 2 = entirely bay.
          shore[lj * NCs + li] = lo > LAND_ISO + 0.3 ? 0 : hi < LAND_ISO - 0.3 ? 2 : 1;
        }
      const pxPerCell = Math.round(cs / MASK_RES);
      for (let j = 0; j < PX; j++) {
        const z = tz0 + (j + 0.5) * MASK_RES;
        const rowCell = ((j / pxPerCell) | 0) * NCs;
        const rowImg = j * PX * 4;
        const rowField = (j + 1) * W + 1;
        for (let i = 0; i < PX; i++) {
          const c = img[rowImg + i * 4];
          if (c === 255) continue;
          const sh = shore[rowCell + ((i / pxPerCell) | 0)];
          if (sh === 2) continue;
          let v = 1 - c * (1 / 255);
          if (sh === 1) {
            const h = surface.heightCubic(tx0 + (i + 0.5) * MASK_RES, z);
            v *= Math.min(1, Math.max(0, (h - LAND_ISO) / 0.25 + 0.5));
          }
          field[rowField + i] = v;
        }
      }
      // 1 m block mask for later height queries.
      const mx0 = tx0 - DZ.minX;
      const mz0 = tz0 - DZ.minZ;
      const step = Math.round(1 / MASK_RES);
      for (let j = 0; j < PX / step; j++) {
        for (let i = 0; i < PX / step; i++) {
          let s = 0;
          for (let b = 0; b < step; b++) for (let a = 0; a < step; a++) s += field[(j * step + b + 1) * W + i * step + a + 1];
          surface.blockMask[(mz0 + j) * maskW + mx0 + i] = Math.round((s / (step * step)) * 255);
        }
      }
      // 3. contours.
      const raw = marchingSquares(field, W, W, tx0 - 0.5 * MASK_RES, tz0 - 0.5 * MASK_RES, MASK_RES);
      const outers: { ring: number[]; holes: number[][]; bb: number[] }[] = [];
      const holes: number[][] = [];
      for (const r of raw) {
        const a = ringArea(r);
        if (Math.abs(a) < 1.5) continue;
        const onEdge = (x: number, z: number) => Math.abs(x - tx0) < 1e-3 || Math.abs(x - tx1) < 1e-3 || Math.abs(z - tz0) < 1e-3 || Math.abs(z - tz1) < 1e-3;
        // Curbs: light smoothing (raster staircase). Shorelines: strong smoothing (DEM scallops) on shore vertices only.
        let sm = smoothRing(r, 3, onEdge);
        sm = smoothRing(sm, 14, (x, z) => onEdge(x, z) || surface.heightCubic(x, z) > 1.2);
        // Seawalls are straight: straighten shoreline runs (DEM lobes) with a 1 m tolerance.
        sm = simplifyRuns(sm, (x, z) => !onEdge(x, z) && surface.heightCubic(x, z) <= 1.2, 2.5);
        const s = densifyOnGrid(simplifyRing(sm, 0.05), surface.minX, surface.minZ, cs);
        if (a < 0) outers.push({ ring: s, holes: [], bb: ringBBox(s) });
        else holes.push(s);
      }
      for (const h of holes) {
        const hx = h[0];
        const hz = h[1];
        let best: (typeof outers)[number] | null = null;
        let bestArea = Infinity;
        for (const o of outers) {
          if (hx < o.bb[0] || hx > o.bb[2] || hz < o.bb[1] || hz > o.bb[3]) continue;
          const area = (o.bb[2] - o.bb[0]) * (o.bb[3] - o.bb[1]);
          if (area < bestArea && pointInRing(o.ring, hx, hz)) {
            best = o;
            bestArea = area;
          }
        }
        if (best) best.holes.push(h);
      }
      // Decks (plazas over garages) fully inside this tile: carve their loops out of the containing block.
      const deckHoles = new Map<(typeof outers)[number], number[][]>();
      for (const d of surface.decks) {
        if (d.loop || d.bb[0] < tx0 + 2 || d.bb[2] > tx1 - 2 || d.bb[1] < tz0 + 2 || d.bb[3] > tz1 - 2) continue;
        const loop = deckLoop(d, field, W, tx0, tz0, surface);
        if (!loop) continue;
        const o = outers.find((o) => pointInRing(o.ring, loop[0], loop[1]) && !o.holes.some((h) => pointInRing(h, loop[0], loop[1])));
        if (!o) continue;
        d.loop = loop;
        d.bb = ringBBox(loop);
        const rev: number[] = [];
        for (let k = loop.length - 2; k >= 0; k -= 2) rev.push(loop[k], loop[k + 1]);
        let l = deckHoles.get(o);
        if (!l) deckHoles.set(o, (l = []));
        l.push(rev);
      }
      // 4. block tops.
      const gb = new GeoBuilder();
      const fb = new GeoBuilder(); // seawall & pier faces (shared by both LODs)
      const ci0 = Math.round((tx0 - surface.minX) / cs);
      const cj0 = Math.round((tz0 - surface.minZ) / cs);
      const NC = Math.round(TILE / cs);
      const full = new Uint8Array(NC * NC);
      const latBlock = new Int32Array((NC + 1) * (NC + 1)).fill(-1);
      const latRoad = new Int32Array((NC + 1) * (NC + 1)).fill(-1);
      const nTmp = new Float32Array(3);
      const vN = new THREE.Vector3();
      const latticeVert = (map: Int32Array, li: number, lj: number, block: boolean): number => {
        const key = lj * (NC + 1) + li;
        if (map[key] >= 0) return map[key];
        const c = ci0 + li;
        const r = cj0 + lj;
        const x = surface.gridX(c);
        const z = surface.gridZ(r);
        let y: number;
        if (block) {
          y = surface.levelGrid[Math.min(surface.rows - 1, r) * surface.cols + Math.min(surface.cols - 1, c)] + surface.liftAt(x, z);
          surface.latticeNormal(surface.levelGrid, c, r, nTmp, 0);
        } else {
          y = surface.gridValue(c, r);
          surface.latticeNormal(surface.data, c, r, nTmp, 0);
          // Low land right next to the bay: sink it so only the vertical seawall/pier face shows at the shore.
          if (y < 4 && y > -1.5) {
            let wet = false;
            for (let dr = -1; dr <= 1 && !wet; dr++) for (let dc = -1; dc <= 1; dc++) if (surface.gridValue(c + dc, r + dr) < LAND_ISO) wet = true;
            if (wet) y = -1.5;
          }
        }
        const v = gb.vert(x, y, z, nTmp[0], nTmp[1], nTmp[2], block ? KIND_BLOCK : KIND_ROAD);
        map[key] = v;
        return v;
      };
      const emitPiece = (p: CellPiece, setFull: boolean) => {
        const li = p.ci - ci0;
        const lj = p.cj - cj0;
        if (li < 0 || lj < 0 || li >= NC || lj >= NC) return;
        if (p.full) {
          if (setFull) full[lj * NC + li] = 1;
          const a = latticeVert(latBlock, li, lj, true);
          const b = latticeVert(latBlock, li + 1, lj, true);
          const d = latticeVert(latBlock, li, lj + 1, true);
          const e = latticeVert(latBlock, li + 1, lj + 1, true);
          gb.idx.push(a, d, b, d, e, b);
          return;
        }
        const base = gb.pos.length / 3;
        const v = p.verts;
        for (let k = 0; k < v.length; k += 2) {
          const x = v[k];
          const z = v[k + 1];
          surface.normalAt(x, z, vN);
          gb.vert(x, surface.blockTop(x, z), z, vN.x, vN.y, vN.z, KIND_BLOCK);
        }
        const t = p.tris;
        for (let k = 0; k < t.length; k += 3) {
          const A = t[k];
          const B = t[k + 1];
          const C = t[k + 2];
          const cy = (v[B * 2 + 1] - v[A * 2 + 1]) * (v[C * 2] - v[A * 2]) - (v[B * 2] - v[A * 2]) * (v[C * 2 + 1] - v[A * 2 + 1]);
          if (Math.abs(cy) < 1e-9) continue;
          if (cy > 0) gb.idx.push(base + A, base + B, base + C);
          else gb.idx.push(base + A, base + C, base + B);
        }
      };
      for (const o of outers) {
        const dh = deckHoles.get(o);
        if (dh) {
          // Cells under a deck count as covered (no road-level cells), but get no block-top geometry.
          clipToGrid([o.ring, ...o.holes], surface.minX, surface.minZ, cs, (p) => {
            const li = p.ci - ci0;
            const lj = p.cj - cj0;
            if (p.full && li >= 0 && lj >= 0 && li < NC && lj < NC) full[lj * NC + li] = 1;
          });
          clipToGrid([o.ring, ...o.holes, ...dh], surface.minX, surface.minZ, cs, (p) => emitPiece(p, false));
        } else clipToGrid([o.ring, ...o.holes], surface.minX, surface.minZ, cs, (p) => emitPiece(p, true));
      }
      for (const d of surface.decks) if (d.loop && d.bb[0] >= tx0 && d.bb[2] <= tx1 && d.bb[1] >= tz0 && d.bb[3] <= tz1) buildDeck(d, surface, fb);
      // 5. curb & seawall faces.
      const onBorder = (x: number, z: number) => Math.abs(x - tx0) < 1e-3 || Math.abs(x - tx1) < 1e-3 || Math.abs(z - tz0) < 1e-3 || Math.abs(z - tz1) < 1e-3;
      const allRings: number[][] = [];
      for (const o of outers) allRings.push(o.ring, ...o.holes);
      for (const ring of allRings) {
        const n = ring.length / 2;
        const edge = new Uint8Array(n);
        const enx = new Float32Array(n);
        const enz = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = ring[i * 2];
          const az = ring[i * 2 + 1];
          const bx = ring[j * 2];
          const bz = ring[j * 2 + 1];
          const dx = bx - ax;
          const dz = bz - az;
          const l = Math.hypot(dx, dz);
          if (l < 1e-6) continue;
          // Outward (road / water side) = right of the walking direction.
          const ox = -dz / l;
          const oz = dx / l;
          enx[i] = ox;
          enz[i] = oz;
          if (onBorder(ax, az) && onBorder(bx, bz) && (Math.abs(ax - bx) < 1e-3 || Math.abs(az - bz) < 1e-3)) continue;
          const mx = (ax + bx) / 2 + ox * 1.5;
          const mz = (az + bz) / 2 + oz * 1.5;
          edge[i] = surface.hf.heightAt(mx, mz) < LAND_ISO ? (inPier((ax + bx) / 2, (az + bz) / 2) ? KIND_PIER : KIND_SEAWALL) : KIND_CURB;
        }
        for (let i = 0; i < n; i++) {
          const k = edge[i];
          if (!k) continue;
          const j = (i + 1) % n;
          const ip = (i - 1 + n) % n;
          // Vertex normals: average with the neighbouring edge when it is a face of the same kind and the turn is gentle.
          const vn = (e0: number, e1: number) => {
            let x = enx[e0];
            let z = enz[e0];
            if (edge[e1] === k && enx[e0] * enx[e1] + enz[e0] * enz[e1] > 0.5) {
              x += enx[e1];
              z += enz[e1];
            }
            const l = Math.hypot(x, z) || 1;
            return [x / l, z / l];
          };
          const [nax, naz] = vn(i, ip);
          const [nbx, nbz] = vn(i, j);
          const ax = ring[i * 2];
          const az = ring[i * 2 + 1];
          const bx = ring[j * 2];
          const bz = ring[j * 2 + 1];
          const ta = surface.blockTop(ax, az);
          const tb = surface.blockTop(bx, bz);
          const ba = k === KIND_CURB ? surface.meshHeight(ax, az) - 0.04 : -6;
          const bb = k === KIND_CURB ? surface.meshHeight(bx, bz) - 0.04 : -6;
          // (Pier faces drop to −6 m too; the shader paints the deck lip and the shadowed piling bay below.)
          if (ta - ba < 0.03 && tb - bb < 0.03) continue;
          const up = k === KIND_CURB ? 0.55 : 0.15;
          const la = Math.hypot(nax, up, naz);
          const lb = Math.hypot(nbx, up, nbz);
          // Pier edges: a 0.9 m concrete lip above the dark under-deck bay.
          const bands: [number, number, number, number, number][] =
            k === KIND_PIER
              ? [
                  [ta, tb, ta - 0.9, tb - 0.9, KIND_PIER],
                  [ta - 0.9, tb - 0.9, ba, bb, KIND_UNDERDECK],
                ]
              : [[ta, tb, ba, bb, k]];
          const B = k === KIND_CURB ? gb : fb;
          for (const [t0, t1, b0, b1, kk] of bands) {
            const v0 = B.vert(ax, t0, az, nax / la, up / la, naz / la, kk);
            const v1 = B.vert(ax, b0, az, nax, 0, naz, kk);
            const v2 = B.vert(bx, b1, bz, nbx, 0, nbz, kk);
            const v3 = B.vert(bx, t1, bz, nbx / lb, up / lb, nbz / lb, kk);
            // Front face must point outward: winding of (v0, v1, v2) vs the outward normal.
            const e1y = b0 - t0;
            const e2x = bx - ax;
            const e2y = b1 - t0;
            const e2z = bz - az;
            const cx = e1y * e2z;
            const cz = -e1y * e2x;
            void e2y;
            if (cx * enx[i] + cz * enz[i] > 0) B.idx.push(v0, v1, v2, v0, v2, v3);
            else B.idx.push(v0, v2, v1, v0, v3, v2);
          }
        }
        loopsOut.push({ pts: ring, edge });
      }
      // 6. road-level cells (skipping cells fully under the opaque bay surface).
      for (let lj = 0; lj < NC; lj++) {
        for (let li = 0; li < NC; li++) {
          if (full[lj * NC + li]) continue;
          const c = ci0 + li;
          const r = cj0 + lj;
          if (
            surface.gridValue(c, r) < -0.6 &&
            surface.gridValue(c + 1, r) < -0.6 &&
            surface.gridValue(c, r + 1) < -0.6 &&
            surface.gridValue(c + 1, r + 1) < -0.6
          )
            continue;
          const a = latticeVert(latRoad, li, lj, false);
          const b = latticeVert(latRoad, li + 1, lj, false);
          const d = latticeVert(latRoad, li, lj + 1, false);
          const e = latticeVert(latRoad, li + 1, lj + 1, false);
          gb.idx.push(a, d, b, d, e, b);
        }
      }
      tiles.push({ x0: tx0, z0: tz0, x1: tx1, z1: tz1, detail: gb.build(), coarse: null as unknown as THREE.BufferGeometry, faces: fb.idx.length ? fb.build() : null });
    }
  }
  // Far LOD per tile (needs the complete block mask, hence a second pass).
  const nT = new Float32Array(3);
  for (const t of tiles) {
    const step = 8;
    const n = Math.round(TILE / step);
    const cb = new GeoBuilder();
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = t.x0 + i * step;
        const z = t.z0 + j * step;
        const c = Math.round((x - surface.minX) / cs);
        const r = Math.round((z - surface.minZ) / cs);
        let y = surface.gridValue(c, r);
        if (y < 4 && y > -1.5) {
          let wet = false;
          for (let dr = -2; dr <= 2 && !wet; dr++) for (let dc = -2; dc <= 2; dc++) if (surface.gridValue(c + dc, r + dr) < LAND_ISO) wet = true;
          if (wet) y = -1.5;
        }
        const b = surface.blockAt(x, z);
        if (b >= 0.5 && y > -1) y = Math.max(y, surface.blockTop(x, z) - 0.03);
        const dy = surface.decks.length ? surface.deckAt(x, z) : null;
        if (dy !== null) y = dy - 0.05;
        surface.latticeNormal(surface.data, c, r, nT, 0);
        cb.vert(x, y, z, nT[0], nT[1], nT[2], -1);
      }
    }
    const row = n + 1;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * row + i;
        const ys = [a, a + 1, a + row, a + row + 1].map((k) => cb.pos[k * 3 + 1]);
        if (ys.every((y) => y < -0.6)) continue;
        cb.idx.push(a, a + row, a + 1, a + row, a + row + 1, a + 1);
      }
    t.coarse = cb.build();
  }
  return { tiles, loops: loopsOut };
}
