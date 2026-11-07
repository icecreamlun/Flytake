/**
 * Exact ground-surface queries. The ground mesh triangulates the 4 m terrain lattice with a fixed diagonal
 * (from (c, r+1) to (c+1, r)), so `meshHeight` reproduces the rendered surface exactly (bilinear sampling would
 * not: it bulges off the triangles by centimetres on curved slopes). Everything draped on the ground
 * (markings, curbs, block tops, props) uses these functions so nothing floats or sinks.
 *
 * `levelGrid` is the terrain with the land surface extended a couple of cells out over the bay so the raised
 * promenade / pier tops reach the seawall face at full height instead of sloping into the water.
 */
import * as THREE from 'three';
import type { Heightfield } from '../../../contracts';
import { CTX, CURB_H, DZ, insideDist, smoothstep } from './zone';
import { pointInRing } from './contour';

/** Terrain below this is treated as bay (m). */
export const LAND_ISO = 0.3;

/**
 * A flat hardscape deck replacing the terrain inside a polygon (e.g. Portsmouth Square, a plaza on a garage roof).
 * The tile builder carves `loop` out of its block top and builds the deck plus retaining walls down/up to the
 * surrounding ground.
 */
export interface Deck {
  name: string;
  /** Source polygon (flat x,z). */
  src: number[];
  /** Deck elevation (m). */
  y: number;
  /** Final outline (flat x,z, densified on the lattice), inset from the curbs; set by the tile builder. */
  loop: number[] | null;
  bb: [number, number, number, number];
}

export class GroundSurface {
  readonly minX: number;
  readonly minZ: number;
  readonly cs: number;
  readonly cols: number;
  readonly rows: number;
  readonly data: Float32Array;
  readonly levelGrid: Float32Array;
  /** Block (raised) mask at 1 m over DZ, 0..255; filled by the tile builder. */
  blockMask: Uint8Array | null = null;
  /** Flat decks (plazas over garages); their loops are filled in by the tile builder. */
  decks: Deck[] = [];
  readonly maskW = DZ.maxX - DZ.minX;
  readonly maskH = DZ.maxZ - DZ.minZ;

  constructor(readonly hf: Heightfield) {
    const m = hf.meta;
    this.minX = m.minX;
    this.minZ = m.minZ;
    this.cs = m.cellSize;
    this.cols = m.cols;
    this.rows = m.rows;
    // Private copy: decks re-grade the lattice locally (other modules keep the original DEM).
    this.data = new Float32Array(hf.data);
    this.levelGrid = this.buildLevelGrid();
  }

  private buildLevelGrid(): Float32Array {
    const { cols, rows, data } = this;
    const out = new Float32Array(data);
    const R = 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const h = data[r * cols + c];
        if (h >= LAND_ISO) continue;
        let best = -Infinity;
        for (let dr = -R; dr <= R; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -R; dc <= R; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            const v = data[rr * cols + cc];
            if (v >= LAND_ISO && v > best) best = v;
          }
        }
        if (best > -Infinity) out[r * cols + c] = best;
      }
    }
    return out;
  }

  /** Grid value with clamped indices. */
  private g(arr: Float32Array, c: number, r: number): number {
    c = c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
    r = r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
    return arr[r * this.cols + c];
  }

  /** Piecewise-linear interpolation on the mesh triangulation. */
  private tri(arr: Float32Array, x: number, z: number): number {
    const fc = (x - this.minX) / this.cs;
    const fr = (z - this.minZ) / this.cs;
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    const tx = fc - c;
    const tz = fr - r;
    const h00 = this.g(arr, c, r);
    const h10 = this.g(arr, c + 1, r);
    const h01 = this.g(arr, c, r + 1);
    const h11 = this.g(arr, c + 1, r + 1);
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }

  /** C1-smooth (Catmull-Rom) terrain height: its iso-lines are free of the bilinear "scallops" (shoreline test). */
  heightCubic(x: number, z: number): number {
    const fc = (x - this.minX) / this.cs;
    const fr = (z - this.minZ) / this.cs;
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    const tx = fc - c;
    const tz = fr - r;
    const w = (t: number, out: number[]) => {
      const t2 = t * t;
      const t3 = t2 * t;
      out[0] = -0.5 * t3 + t2 - 0.5 * t;
      out[1] = 1.5 * t3 - 2.5 * t2 + 1;
      out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
      out[3] = 0.5 * t3 - 0.5 * t2;
    };
    const wx = [0, 0, 0, 0];
    const wz = [0, 0, 0, 0];
    w(tx, wx);
    w(tz, wz);
    let h = 0;
    for (let j = 0; j < 4; j++) {
      let row = 0;
      for (let i = 0; i < 4; i++) row += wx[i] * this.g(this.data, c - 1 + i, r - 1 + j);
      h += wz[j] * row;
    }
    return h;
  }

  /** Height of the rendered road-level (carriageway) surface. */
  meshHeight(x: number, z: number): number {
    return this.tri(this.data, x, z);
  }

  /** Height of the land level (terrain extended over the seawall slope). */
  levelHeight(x: number, z: number): number {
    return this.tri(this.levelGrid, x, z);
  }

  /** Curb lift at x,z: full inside the data area, fading to 0 at its edge (no data beyond). */
  liftAt(x: number, z: number): number {
    return CURB_H * smoothstep(5, 45, insideDist(CTX, x, z));
  }

  /** Raised-block top height (only meaningful where the block mask is set). */
  blockTop(x: number, z: number): number {
    return this.levelHeight(x, z) + this.liftAt(x, z);
  }

  /** 0..1 block coverage at x,z (bilinear on the 1 m mask). */
  blockAt(x: number, z: number): number {
    const m = this.blockMask;
    if (!m) return 0;
    const fx = x - DZ.minX - 0.5;
    const fz = z - DZ.minZ - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= this.maskW - 1 || j >= this.maskH - 1) return 0;
    const tx = fx - i;
    const tz = fz - j;
    const W = this.maskW;
    const a = m[j * W + i];
    const b = m[j * W + i + 1];
    const c = m[(j + 1) * W + i];
    const d = m[(j + 1) * W + i + 1];
    return ((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz) / 255;
  }

  /** Deck elevation at x,z, or null when no deck covers the point. */
  deckAt(x: number, z: number): number | null {
    for (const d of this.decks) {
      if (!d.loop || x < d.bb[0] || x > d.bb[2] || z < d.bb[1] || z > d.bb[3]) continue;
      if (pointInRing(d.loop, x, z)) return d.y;
    }
    return null;
  }

  /** Height of whatever ground surface is rendered at x,z (deck, block top if raised, else carriageway). */
  top(x: number, z: number): number {
    const d = this.decks.length ? this.deckAt(x, z) : null;
    if (d !== null) return d;
    return this.blockAt(x, z) >= 0.5 ? this.blockTop(x, z) : this.meshHeight(x, z);
  }

  /** Bilinear sample of the (possibly re-graded) lattice. */
  private bilinear(x: number, z: number): number {
    const fc = (x - this.minX) / this.cs;
    const fr = (z - this.minZ) / this.cs;
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    const tx = fc - c;
    const tz = fr - r;
    const d = this.data;
    return (this.g(d, c, r) * (1 - tx) + this.g(d, c + 1, r) * tx) * (1 - tz) + (this.g(d, c, r + 1) * (1 - tx) + this.g(d, c + 1, r + 1) * tx) * tz;
  }

  /** Smooth vertex normal of the terrain (central differences, bilinear between lattice points). */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = this.cs;
    const dx = this.bilinear(x + e, z) - this.bilinear(x - e, z);
    const dz = this.bilinear(x, z + e) - this.bilinear(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  /**
   * Re-grade the lattice around a deck: the DEM smears a deck's vertical edges into ramps several metres wide, so
   * lattice points inside the deck polygon and up to `R` m outside it blend to the level of the nearest street
   * (`street` returns that height, or null to keep the DEM). Must run before the ground is built.
   */
  gradeDeck(d: Deck, street: (x: number, z: number) => number | null, R = 9): void {
    const src = d.src;
    const n = src.length / 2;
    const c0 = Math.max(0, Math.floor((d.bb[0] - R - this.minX) / this.cs));
    const c1 = Math.min(this.cols - 1, Math.ceil((d.bb[2] + R - this.minX) / this.cs));
    const r0 = Math.max(0, Math.floor((d.bb[1] - R - this.minZ) / this.cs));
    const r1 = Math.min(this.rows - 1, Math.ceil((d.bb[3] + R - this.minZ) / this.cs));
    const upd: [number, number][] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = this.gridX(c);
        const z = this.gridZ(r);
        let w = 1;
        if (!pointInRing(src, x, z)) {
          let dm = Infinity;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const ax = src[i * 2];
            const az = src[i * 2 + 1];
            const ex = src[j * 2] - ax;
            const ez = src[j * 2 + 1] - az;
            const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
            dm = Math.min(dm, Math.hypot(x - ax - ex * t, z - az - ez * t));
          }
          w = smoothstep(R, R * 0.4, dm);
        }
        if (w <= 0) continue;
        const h = street(x, z);
        if (h === null) continue;
        const i = r * this.cols + c;
        upd.push([i, this.data[i] + (h - this.data[i]) * w]);
      }
    }
    for (const [i, h] of upd) {
      this.data[i] = h;
      if (h >= LAND_ISO) this.levelGrid[i] = h;
    }
  }

  /** Lattice-vertex normal (exact central differences at grid point c,r) written into out[o..o+2]. */
  latticeNormal(arr: Float32Array, c: number, r: number, out: Float32Array, o: number): void {
    const dx = this.g(arr, c + 1, r) - this.g(arr, c - 1, r);
    const dz = this.g(arr, c, r + 1) - this.g(arr, c, r - 1);
    const ny = 2 * this.cs;
    const l = Math.hypot(dx, ny, dz);
    out[o] = -dx / l;
    out[o + 1] = ny / l;
    out[o + 2] = -dz / l;
  }

  gridX(c: number): number {
    return this.minX + c * this.cs;
  }
  gridZ(r: number): number {
    return this.minZ + r * this.cs;
  }
  gridValue(c: number, r: number): number {
    return this.g(this.data, c, r);
  }
}
