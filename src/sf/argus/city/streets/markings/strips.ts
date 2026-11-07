/**
 * Draped strip geometry builder used by markings, tracks and other ground decals.
 */
import * as THREE from 'three';

class Bucket {
  pos: number[] = [];
  mk: number[] = [];
  ax: number[] = [];
  idx: number[] = [];
}

/** Strips are bucketed into 640 m tiles (by their first point) so each tile's decal mesh can be frustum-culled. */
export class StripBuilder {
  private buckets = new Map<number, Bucket>();
  private cur!: Bucket;
  private get pos() {
    return this.cur.pos;
  }
  private get mk() {
    return this.cur.mk;
  }
  private get ax() {
    return this.cur.ax;
  }
  private get idx() {
    return this.cur.idx;
  }

  /**
   * Strip along a centre polyline (flat x,z). Left side (v = +1) is (dz, -dx) of the walking direction.
   * height(x, z) gives the surface height; `lift` is added.
   */
  add(pts: number[], hw: number, style: number, u0: number, height: (x: number, z: number) => number, lift = 0.02): void {
    const n = pts.length / 2;
    if (n < 2) return;
    const k = Math.floor(pts[0] / 640) * 1000 + Math.floor(pts[1] / 640);
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = new Bucket()));
    this.cur = b;
    let u = u0;
    const base = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2];
      const z = pts[i * 2 + 1];
      // Mitered normal from the two adjacent segments.
      const ip = Math.max(0, i - 1);
      const inx = Math.min(n - 1, i + 1);
      let tx = 0;
      let tz = 0;
      if (i > 0) {
        const dx = x - pts[ip * 2];
        const dz = z - pts[ip * 2 + 1];
        const l = Math.hypot(dx, dz) || 1;
        tx += dx / l;
        tz += dz / l;
      }
      if (i < n - 1) {
        const dx = pts[inx * 2] - x;
        const dz = pts[inx * 2 + 1] - z;
        const l = Math.hypot(dx, dz) || 1;
        tx += dx / l;
        tz += dz / l;
      }
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      // Miter length correction (clamped).
      let miter = 1;
      if (i > 0 && i < n - 1) {
        const dx = x - pts[ip * 2];
        const dz = z - pts[ip * 2 + 1];
        const l = Math.hypot(dx, dz) || 1;
        const c = (dx / l) * tx + (dz / l) * tz;
        miter = 1 / Math.max(0.5, c);
      }
      const nx = tz;
      const nz = -tx;
      if (i > 0) u += Math.hypot(x - pts[ip * 2], z - pts[ip * 2 + 1]);
      for (const side of [1, -1]) {
        const px = x + nx * hw * miter * side;
        const pz = z + nz * hw * miter * side;
        this.pos.push(px, height(px, pz) + lift, pz);
        this.mk.push(u, side, hw, style);
        this.ax.push(nx, nz);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      // left(i)=a, right(i)=a+1, left(i+1)=a+2, right(i+1)=a+3; wind so the strip faces +Y.
      this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  build(): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = [];
    for (const b of this.buckets.values()) {
      if (!b.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      const nrm = new Float32Array(b.pos.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('aMk', new THREE.Float32BufferAttribute(b.mk, 4));
      g.setAttribute('aAx', new THREE.Float32BufferAttribute(b.ax, 2));
      g.setIndex(b.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
      g.computeBoundingSphere();
      out.push(g);
    }
    return out;
  }
}
