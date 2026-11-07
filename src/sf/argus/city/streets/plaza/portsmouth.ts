/**
 * Portsmouth Square: Chinatown's "living room", a plaza on the roof of a public garage. The DEM drapes it as a
 * wavy hump; here it becomes a level paved deck (see ground/deck.ts) furnished with a ring of trees, a children's
 * play structure on rubber safety surfacing, benches, acorn lamps and the concrete footbridge that crosses Kearny
 * Street to the Chinese Culture Center in the Hilton.
 */
import * as THREE from 'three';
import type { CityData, TreeRecord } from '../../../contracts';
import type { Deck, GroundSurface } from '../core/surface';
import type { RoadNet } from '../core/roadnet';
import { SegIndex } from '../core/segindex';
import { pointInRing, ringBBox } from '../core/contour';
import { hash01 } from '../core/zone';
import { Emit, Kit } from '../props/kit';
import { createPropMaterial, type PropUniforms } from '../props/material';
import { acornLamp, bench } from '../props/models';

const NAME = 'Portsmouth Square';

/**
 * Register the deck (before the ground tiles are built). Deck level = median terrain inside the square; the
 * lattice around it is re-graded to the adjacent streets so the retaining walls meet level sidewalks.
 */
export function portsmouthDeck(city: CityData, surface: GroundSurface, net: RoadNet): Deck | null {
  const a = city.areas.find((r) => r.name === NAME);
  if (!a) return null;
  const src = a.polygon.flat();
  const bb = ringBBox(src);
  const hs: number[] = [];
  for (let z = bb[1]; z <= bb[3]; z += surface.cs) for (let x = bb[0]; x <= bb[2]; x += surface.cs) if (pointInRing(src, x, z)) hs.push(surface.meshHeight(x, z));
  if (hs.length < 20) return null;
  hs.sort((p, q) => p - q);
  const d: Deck = { name: NAME, src, y: hs[Math.floor(hs.length * 0.5)] + 0.15, loop: null, bb };
  surface.decks.push(d);
  const segs = new SegIndex(net, (r) => r.curbed);
  const P = { x: 0, z: 0, dx: 0, dz: 0 };
  surface.gradeDeck(d, (x, z) => {
    const s = segs.nearest(x, z, 26);
    if (!s) return null;
    net.at(s.road, s.s, P);
    return surface.meshHeight(P.x, P.z);
  });
  return d;
}

/** Buildings standing on/in the square (clubhouse, kiosks): keep furniture out of them. */
function footprints(city: CityData, bb: number[]): number[][] {
  return city.buildings
    .filter((b) => b.footprint.some(([x, z]) => x > bb[0] - 5 && x < bb[2] + 5 && z > bb[1] - 5 && z < bb[3] + 5))
    .map((b) => b.footprint.flat());
}

export class PortsmouthSquare {
  readonly object = new THREE.Group();
  readonly trees: TreeRecord[] = [];
  private loop: number[];
  private blds: number[][];
  private y: number;
  private reserved: [number, number, number][] = [];

  constructor(
    private city: CityData,
    private surface: GroundSurface,
    deck: Deck,
  ) {
    this.object.name = 'portsmouthSquare';
    this.loop = deck.loop!;
    this.y = deck.y;
    this.blds = footprints(city, ringBBox(this.loop));
    this.planTrees();
  }

  /** Clear of buildings and inside the deck by `m` metres (tested on a small ring of points). */
  private free(x: number, z: number, m: number): boolean {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const px = x + Math.cos(a) * m;
      const pz = z + Math.sin(a) * m;
      if (!pointInRing(this.loop, px, pz)) return false;
      if (this.blds.some((b) => pointInRing(b, px, pz))) return false;
    }
    if (this.blds.some((b) => pointInRing(b, x, z))) return false;
    return !this.reserved.some(([rx, rz, rr]) => Math.hypot(rx - x, rz - z) < rr + m);
  }

  /** Trees ringing the deck ~3.5 m in from its edge, every ~8.5 m. */
  private planTrees(): void {
    const L = this.loop;
    const n = L.length / 2;
    const cx = L.filter((_, i) => i % 2 === 0).reduce((s, v) => s + v, 0) / n;
    const cz = L.filter((_, i) => i % 2 === 1).reduce((s, v) => s + v, 0) / n;
    // Reserve the playground and bridge landing first.
    this.playAt = this.findSpot(cx - 14, cz - 26, 7.5);
    if (this.playAt) this.reserved.push([this.playAt[0], this.playAt[1], 8]);
    let acc = 0;
    let idx = 0;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const ax = L[k * 2];
      const az = L[k * 2 + 1];
      const bx = L[j * 2];
      const bz = L[j * 2 + 1];
      const len = Math.hypot(bx - ax, bz - az);
      for (let s = 8.5 - acc; s < len; s += 8.5) {
        const t = s / len;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        // Step inward 3.5 m.
        const dx = cx - x;
        const dz = cz - z;
        const dl = Math.hypot(dx, dz) || 1;
        const tx = x + (dx / dl) * 3.5;
        const tz = z + (dz / dl) * 3.5;
        if (!this.free(tx, tz, 2.2)) continue;
        this.reserved.push([tx, tz, 3]);
        const r = hash01(idx++, 77);
        const species = r < 0.45 ? "Ficus microcarpa nitida 'Green Gem'" : r < 0.75 ? 'Platanus x hispanica' : r < 0.9 ? 'Magnolia grandiflora' : 'Ginkgo biloba';
        this.trees.push({ x: tx, z: tz, species, dbh: 9 + 9 * hash01(idx, 3), source: 'estimated' });
      }
      acc = (acc + len) % 8.5;
    }
    // Interior groves on a loose 11 m grid, leaving an open central plaza.
    const bb = ringBBox(L);
    for (let z = bb[1] + 9; z < bb[3] - 6; z += 11) {
      for (let x = bb[0] + 9; x < bb[2] - 6; x += 11) {
        const jx = x + (hash01(idx, 41) - 0.5) * 3;
        const jz = z + (hash01(idx, 43) - 0.5) * 3;
        idx++;
        if (Math.hypot((jx - cx) / 1.2, jz - cz) < 15) continue;
        if (!this.free(jx, jz, 2.6)) continue;
        this.reserved.push([jx, jz, 3]);
        const r = hash01(idx, 47);
        const species = r < 0.5 ? "Ficus microcarpa nitida 'Green Gem'" : r < 0.8 ? 'Platanus x hispanica' : 'Pittosporum undulatum';
        this.trees.push({ x: jx, z: jz, species, dbh: 8 + 10 * hash01(idx, 5), source: 'estimated' });
        this.planters.push([jx, jz]);
      }
    }
  }
  /** Raised planter rings around the interior trees. */
  private planters: [number, number][] = [];
  private playAt: [number, number] | null = null;

  private findSpot(x: number, z: number, r: number): [number, number] | null {
    for (let ring = 0; ring < 12; ring++) {
      for (let k = 0; k < Math.max(1, ring * 6); k++) {
        const a = (k / Math.max(1, ring * 6)) * Math.PI * 2;
        const px = x + Math.cos(a) * ring * 2.5;
        const pz = z + Math.sin(a) * ring * 2.5;
        if (this.free(px, pz, r)) return [px, pz];
      }
    }
    return null;
  }

  /** Build the furniture meshes (needs the shared prop uniforms for lamp emissives). */
  build(uniforms: PropUniforms): THREE.Object3D {
    const mat = createPropMaterial(uniforms, { instAttr: false });
    const add = (g: THREE.BufferGeometry, name: string, shadows = true) => {
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.castShadow = shadows;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      this.object.add(m);
    };
    const y = this.y;
    if (this.playAt) add(playground(this.playAt[0], y, this.playAt[1]), 'playground');
    // Benches & lamps on a ring between the trees and the centre.
    const furn = new Kit();
    const L = this.loop;
    const n = L.length / 2;
    const cx = L.filter((_, i) => i % 2 === 0).reduce((s, v) => s + v, 0) / n;
    const cz = L.filter((_, i) => i % 2 === 1).reduce((s, v) => s + v, 0) / n;
    const benchG = bench();
    const lampG = acornLamp();
    const m4 = new THREE.Matrix4();
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2 + 0.2;
      for (let r = 26; r > 6; r -= 2) {
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r * 0.9;
        if (!this.free(x, z, k % 2 ? 1.2 : 0.8)) continue;
        this.reserved.push([x, z, 1.5]);
        // Bench back faces outward (local +X toward the centre).
        m4.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(Math.sin(a), -Math.cos(a))), new THREE.Vector3(1, 1, 1));
        furn.addBuilt(k % 2 ? benchG : lampG, m4);
        break;
      }
    }
    // Granite-curbed planter squares (raised 45 cm) around the interior trees, with soil and ground cover.
    for (const [px, pz] of this.planters) {
      const a = hash01(Math.round(px * 7), Math.round(pz * 7)) * 0.2;
      const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
      const pk = new Kit();
      for (const [ox, oz, w, d] of [
        [0, -1.35, 3.0, 0.3],
        [0, 1.35, 3.0, 0.3],
        [-1.35, 0, 0.3, 2.4],
        [1.35, 0, 0.3, 2.4],
      ])
        pk.box(w, 0.47, d, ox, 0.235 - 0.02, oz, '#9b968c', { r: 0.7 });
      pk.box(2.4, 0.36, 2.4, 0, 0.17, 0, '#2a1f16', { r: 0.95 });
      for (let k = 0; k < 6; k++) pk.sphere(0.32 + 0.12 * hash01(k, px | 0), (hash01(k, 3) - 0.5) * 1.8, 0.38, (hash01(k, 5) - 0.5) * 1.8, '#2f4a24', { r: 0.9, sy: 0.6, seg: 7 });
      m4.compose(new THREE.Vector3(px, y, pz), rot, new THREE.Vector3(1, 1, 1));
      furn.addBuilt(pk.build(), m4);
    }
    add(furn.build(), 'plazaFurniture', false);
    const br = this.bridge();
    if (br) add(br, 'kearnyFootbridge');
    return this.object;
  }

  /** Concrete footbridge from the deck's east edge over Kearny St to the Hilton / Chinese Culture Center. */
  private bridge(): THREE.BufferGeometry | null {
    const L0 = ringBBox(this.loop);
    const cx0 = (L0[0] + L0[2]) / 2;
    const cz0 = (L0[1] + L0[3]) / 2;
    const dist = (b: CityData['buildings'][number]) => Math.min(...b.footprint.map(([x, z]) => Math.hypot(x - cx0, z - cz0)));
    const hilton = this.city.buildings
      .filter((b) => /hilton/i.test(b.name ?? '') && b.height > 40 && dist(b) < 160)
      .sort((p, q) => dist(p) - dist(q))[0];
    if (!hilton) return null;
    const hf = hilton.footprint.flat();
    const hb = ringBBox(hf);
    const L = this.loop;
    const bb = ringBBox(L);
    // Crossing line: middle of the z-overlap between the deck and the hotel tower, eastward.
    const za = Math.max(bb[1], hb[1]) + 3;
    const zb = Math.min(bb[3], hb[3]) - 3;
    if (zb <= za) return null;
    const z = (za + zb) / 2;
    let x0 = -Infinity;
    for (let x = bb[0]; x <= bb[2] + 1; x += 0.25) if (pointInRing(L, x, z)) x0 = x;
    if (!isFinite(x0)) return null;
    let x1 = NaN;
    for (let x = x0 + 4; x < x0 + 90; x += 0.25)
      if (pointInRing(hf, x, z)) {
        x1 = x + 1.0;
        break;
      }
    if (!isFinite(x1)) return null;
    const y = this.y;
    const k = new Kit();
    const CONC = '#bdb7ab';
    const len = x1 - (x0 - 1.5);
    const mid = (x1 + x0 - 1.5) / 2;
    const W = 3.6;
    // Box girder (deck slab + haunched soffit), walking surface, solid parapets with a steel handrail.
    k.box(len, 0.35, W, mid, y - 0.175, z, CONC, { r: 0.75 });
    k.box(len, 0.7, W * 0.7, mid, y - 0.7, z, '#a9a399', { r: 0.8 });
    k.box(len, 0.02, W - 0.5, mid, y + 0.01, z, '#6d6a64', { r: 0.85 });
    for (const s of [-1, 1]) {
      k.box(len, 1.05, 0.22, mid, y + 0.5, z + s * (W / 2 - 0.11), CONC, { r: 0.75 });
      k.box(len, 0.05, 0.08, mid, y + 1.12, z + s * (W / 2 - 0.11), '#3c4044', { r: 0.4, m: 0.7 });
    }
    // Light steel canopy frames every 4 m.
    for (let x = x0 - 1; x < x1 - 1; x += 4) {
      for (const s of [-1, 1]) k.box(0.08, 2.4, 0.08, x, y + 1.2 + 1.0, z + s * (W / 2 - 0.15), '#5b6064', { r: 0.4, m: 0.7 });
      k.box(0.08, 0.08, W, x, y + 3.4, z, '#5b6064', { r: 0.4, m: 0.7 });
    }
    k.box(len - 1, 0.05, W + 0.3, mid, y + 3.46, z, '#7e8a8f', { r: 0.25, m: 0.4 });
    // Columns where the bridge passes over sidewalk (not the carriageway).
    for (const t of [0.12, 0.3, 0.7, 0.88]) {
      const x = x0 + (x1 - x0) * t;
      if (this.surface.blockAt(x, z) < 0.9) continue;
      const g = this.surface.top(x, z);
      k.box(0.7, y - 1.05 - g + 0.1, 0.7, x, (y - 1.05 + g) / 2 - 0.05, z, CONC, { r: 0.75 });
    }
    // Soffit lights.
    for (let x = x0 + 2; x < x1 - 2; x += 6) k.box(0.5, 0.03, 0.25, x, y - 1.06, z, '#fff2d6', { e: Emit.Globe, r: 0.2 });
    return k.build();
  }
}

/** Children's play structure on rubber safety surfacing (local frame centred on x,z). */
function playground(x: number, y: number, z: number): THREE.BufferGeometry {
  const k = new Kit();
  const POST = '#2f6d4f';
  const DECK = '#c8a24a';
  const RED = '#b8342a';
  const BLUE = '#2f5f9e';
  // Rubber surfacing pad (raised 4 cm: never coplanar with the deck).
  k.box(13, 0.04, 10, x, y + 0.02, z, '#7a3b2e', { r: 0.95 });
  k.box(5, 0.045, 4, x - 3.5, y + 0.025, z + 2.5, '#2f5a78', { r: 0.95 });
  // Two platforms on posts, linked by a bridge; roof on the tall tower.
  const towers: [number, number, number][] = [
    [x - 2.2, z - 1.2, 1.4],
    [x + 2.2, z + 0.6, 0.9],
  ];
  for (const [tx, tz, h] of towers) {
    for (const sx of [-0.8, 0.8]) for (const sz of [-0.8, 0.8]) k.cyl(0.07, 0.07, h + 1.2, tx + sx, y, tz + sz, POST, { r: 0.5, m: 0.4, seg: 8 });
    k.box(1.7, 0.08, 1.7, tx, y + h, tz, DECK, { r: 0.7 });
    for (const s of [-1, 1]) k.box(1.7, 0.6, 0.04, tx, y + h + 0.45, tz + s * 0.82, BLUE, { r: 0.6 });
  }
  k.prismoid([x - 3.1, x - 1.3, z - 2.1, z - 0.3, y + 2.6], [x - 2.2, x - 2.2, z - 1.2, z - 1.2, y + 3.5], RED, RED, { r: 0.6 }, { r: 0.6 });
  // Bridge between the platforms.
  k.box(2.6, 0.06, 1.0, x, y + 1.15, z - 0.3, DECK, { r: 0.7, ry: -0.39 });
  // Slide off the tall tower.
  k.box(0.6, 0.05, 3.2, x - 2.2, y + 0.75, z + 1.95, '#d9b02c', { r: 0.35, rx: 0.45 });
  for (const s of [-1, 1]) k.box(0.05, 0.2, 3.2, x - 2.2 + s * 0.3, y + 0.85, z + 1.95, '#d9b02c', { r: 0.35, rx: 0.45 });
  // Swing frame.
  for (const sx of [-1.6, 1.6]) {
    k.cyl(0.06, 0.06, 2.6, x + 4.2 + sx, y, z - 2.8, POST, { r: 0.5, m: 0.5, rx: 0.25 });
    k.cyl(0.06, 0.06, 2.6, x + 4.2 + sx, y, z - 1.6, POST, { r: 0.5, m: 0.5, rx: -0.25 });
  }
  k.cyl(0.06, 0.06, 3.4, x + 2.5, y + 2.5, z - 2.2, POST, { r: 0.5, m: 0.5, rz: -Math.PI / 2 });
  for (const sx of [-0.7, 0.7]) {
    k.box(0.02, 1.7, 0.02, x + 4.2 + sx, y + 1.62, z - 2.2, '#3a3a3a', { r: 0.5, m: 0.6 });
    k.box(0.5, 0.04, 0.2, x + 4.2 + sx, y + 0.75, z - 2.2, '#1d1d1d', { r: 0.8 });
  }
  return k.build();
}
