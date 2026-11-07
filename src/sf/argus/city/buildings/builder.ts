/**
 * Growable vertex/index buffers for the merged building meshes.
 *
 * WallBuilder vertices: position, normal, aBld (building index), aFac = (s, L, key, groundY), aFlags.
 *   s = metres along the facade segment, L = segment length, key = per-segment random,
 *   groundY = terrain elevation under the vertex (for grime / local-ground effects).
 *   aFlags = party(1) + street(2) + 4 * surfaceKind (0 facade, 1 cornice band, 2 bay, 3 gable)
 *            + 16 * round(2 * neighbour roof height above base) for lot-line walls.
 *
 * PropBuilder vertices: position, normal, aBld, aCol (linear rgb), aProp = (kind, u, v, rand).
 */
import * as THREE from 'three';

class Growable {
  data: Float32Array;
  length = 0;
  constructor(initial = 1 << 16) {
    this.data = new Float32Array(initial);
  }
  reserve(n: number) {
    if (this.length + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.length + n) cap *= 2;
    const d = new Float32Array(cap);
    d.set(this.data.subarray(0, this.length));
    this.data = d;
  }
  push3(a: number, b: number, c: number) {
    this.reserve(3);
    const d = this.data;
    const l = this.length;
    d[l] = a;
    d[l + 1] = b;
    d[l + 2] = c;
    this.length = l + 3;
  }
  push4(a: number, b: number, c: number, e: number) {
    this.reserve(4);
    const d = this.data;
    const l = this.length;
    d[l] = a;
    d[l + 1] = b;
    d[l + 2] = c;
    d[l + 3] = e;
    this.length = l + 4;
  }
  push1(a: number) {
    this.reserve(1);
    this.data[this.length++] = a;
  }
  view() {
    return this.data.slice(0, this.length);
  }
}

class GrowableU32 {
  data = new Uint32Array(1 << 16);
  length = 0;
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) {
      const d = new Uint32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  view() {
    return this.data.slice(0, this.length);
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

abstract class BaseBuilder {
  readonly pos = new Growable();
  readonly nrm = new Growable();
  readonly bld = new Growable();
  readonly idx = new GrowableU32();
  get vertexCount() {
    return this.pos.length / 3;
  }
  get indexCount() {
    return this.idx.length;
  }
  /** Triangle with winding fixed so its geometric normal agrees with `n` (nx, ny, nz). */
  tri(i0: number, i1: number, i2: number, nx: number, ny: number, nz: number) {
    const p = this.pos.data;
    _a.set(p[i0 * 3], p[i0 * 3 + 1], p[i0 * 3 + 2]);
    _b.set(p[i1 * 3], p[i1 * 3 + 1], p[i1 * 3 + 2]).sub(_a);
    _c.set(p[i2 * 3], p[i2 * 3 + 1], p[i2 * 3 + 2]).sub(_a);
    _b.cross(_c);
    if (_b.x * nx + _b.y * ny + _b.z * nz < 0) this.idx.push3(i0, i2, i1);
    else this.idx.push3(i0, i1, i2);
  }
  quad(i0: number, i1: number, i2: number, i3: number, nx: number, ny: number, nz: number) {
    this.tri(i0, i1, i2, nx, ny, nz);
    this.tri(i0, i2, i3, nx, ny, nz);
  }
  protected baseGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.view(), 3));
    g.setAttribute('aBld', new THREE.BufferAttribute(this.bld.view(), 1));
    g.setIndex(new THREE.BufferAttribute(this.idx.view(), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export class WallBuilder extends BaseBuilder {
  readonly fac = new Growable();
  readonly flags = new Growable();
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, bld: number, s: number, L: number, key: number, groundY: number, flags: number): number {
    this.pos.push3(x, y, z);
    this.nrm.push3(nx, ny, nz);
    this.bld.push1(bld);
    this.fac.push4(s, L, key, groundY);
    this.flags.push1(flags);
    return this.vertexCount - 1;
  }
  build(): THREE.BufferGeometry {
    const g = this.baseGeometry();
    g.setAttribute('aFac', new THREE.BufferAttribute(this.fac.view(), 4));
    g.setAttribute('aFlags', new THREE.BufferAttribute(this.flags.view(), 1));
    return g;
  }
}

export const enum PropKind {
  Roof = 0,
  ParapetCap = 1,
  ParapetInner = 2,
  Soffit = 3,
  Hvac = 4,
  Penthouse = 5,
  WaterTank = 6,
  Metal = 7,
  Solar = 8,
  Skylight = 9,
  Awning = 10,
  Sign = 11,
  Railing = 12,
  TileRoof = 13,
  Dome = 14,
  Ledge = 15,
  WoodTank = 16,
  /** Profiled cornice / belt course / bay moulding (u along the run, v = strip index + fraction). */
  Moulding = 17,
  /** Brick chimney stack. */
  Chimney = 18,
  /** Vent pipes, exhaust fans (round sheet metal). */
  Vent = 19,
  /** Timber roof deck boards. */
  Deck = 20,
}

export class PropBuilder extends BaseBuilder {
  readonly col = new Growable();
  readonly prop = new Growable();
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, bld: number, r: number, g: number, b: number, kind: number, u: number, v: number, rand: number): number {
    this.pos.push3(x, y, z);
    this.nrm.push3(nx, ny, nz);
    this.bld.push1(bld);
    this.col.push3(r, g, b);
    this.prop.push4(kind, u, v, rand);
    return this.vertexCount - 1;
  }
  build(): THREE.BufferGeometry {
    const g = this.baseGeometry();
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col.view(), 3));
    g.setAttribute('aProp', new THREE.BufferAttribute(this.prop.view(), 4));
    return g;
  }

  /**
   * Oriented box: centre (cx, cz), bottom y0, size (sx along yaw direction, sz across), height h.
   * Faces get u/v in metres. Bottom face omitted unless `bottom`.
   */
  box(cx: number, y0: number, cz: number, sx: number, sz: number, h: number, yaw: number, bld: number, color: THREE.Color, kind: number, rand: number, bottom = false) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const hx = sx / 2;
    const hz = sz / 2;
    const corner = (ix: number, iz: number): [number, number] => [cx + c * ix * hx - s * iz * hz, cz + s * ix * hx + c * iz * hz];
    const P = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const y1 = y0 + h;
    const lens = [sx, sz, sx, sz];
    for (let i = 0; i < 4; i++) {
      const a = P[i];
      const b = P[(i + 1) % 4];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      // Outward normal: from box centre towards edge midpoint.
      let nx = dz / l;
      let nz = -dx / l;
      const mx = (a[0] + b[0]) / 2 - cx;
      const mz = (a[1] + b[1]) / 2 - cz;
      if (nx * mx + nz * mz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const L = lens[i];
      const i0 = this.vertex(a[0], y0, a[1], nx, 0, nz, bld, color.r, color.g, color.b, kind, 0, 0, rand);
      const i1 = this.vertex(b[0], y0, b[1], nx, 0, nz, bld, color.r, color.g, color.b, kind, L, 0, rand);
      const i2 = this.vertex(b[0], y1, b[1], nx, 0, nz, bld, color.r, color.g, color.b, kind, L, h, rand);
      const i3 = this.vertex(a[0], y1, a[1], nx, 0, nz, bld, color.r, color.g, color.b, kind, 0, h, rand);
      this.quad(i0, i1, i2, i3, nx, 0, nz);
    }
    const t = P.map((p) => this.vertex(p[0], y1, p[1], 0, 1, 0, bld, color.r, color.g, color.b, kind, (p[0] - cx) * c + (p[1] - cz) * s + hx, -(p[0] - cx) * s + (p[1] - cz) * c + hz, rand));
    this.quad(t[0], t[1], t[2], t[3], 0, 1, 0);
    if (bottom) {
      const bt = P.map((p) => this.vertex(p[0], y0, p[1], 0, -1, 0, bld, color.r, color.g, color.b, kind, 0, 0, rand));
      this.quad(bt[0], bt[1], bt[2], bt[3], 0, -1, 0);
    }
  }

  /** Vertical cylinder (radius r, height h) with optional cone cap. */
  cylinder(cx: number, y0: number, cz: number, r: number, h: number, seg: number, bld: number, color: THREE.Color, kind: number, rand: number, capH = 0, capColor?: THREE.Color) {
    const y1 = y0 + h;
    const ring: number[][] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      const u = (i / seg) * Math.PI * 2 * r;
      ring.push([
        this.vertex(cx + nx * r, y0, cz + nz * r, nx, 0, nz, bld, color.r, color.g, color.b, kind, u, 0, rand),
        this.vertex(cx + nx * r, y1, cz + nz * r, nx, 0, nz, bld, color.r, color.g, color.b, kind, u, h, rand),
      ]);
    }
    for (let i = 0; i < seg; i++) {
      const a = (i + 0.5) / seg * Math.PI * 2;
      this.quad(ring[i][0], ring[i + 1][0], ring[i + 1][1], ring[i][1], Math.cos(a), 0, Math.sin(a));
    }
    const cc = capColor ?? color;
    const apex = this.vertex(cx, y1 + capH, cz, 0, 1, 0, bld, cc.r, cc.g, cc.b, kind, 0, h + capH, rand);
    const up = capH > 0 ? r / Math.hypot(r, capH) : 1;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const nx = capH > 0 ? Math.cos(am) * (capH / Math.hypot(r, capH)) : 0;
      const nz = capH > 0 ? Math.sin(am) * (capH / Math.hypot(r, capH)) : 0;
      const ny = capH > 0 ? up : 1;
      const v0 = this.vertex(cx + Math.cos(a0) * r, y1, cz + Math.sin(a0) * r, nx, ny, nz, bld, cc.r, cc.g, cc.b, kind, 0, h, rand);
      const v1 = this.vertex(cx + Math.cos(a1) * r, y1, cz + Math.sin(a1) * r, nx, ny, nz, bld, cc.r, cc.g, cc.b, kind, 0, h, rand);
      this.tri(v0, v1, apex, nx, ny, nz);
    }
  }
}
