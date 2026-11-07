/**
 * Procedural tree archetype geometry (built once, instanced thousands of times).
 * Each archetype has two LODs built at a reference size:
 *   LOD0 (near): tapered trunk + limbs, ~15-30 foliage clumps of alpha-tested leaf cards whose lighting normals
 *                are bent toward the crown's ellipsoid normal (soft volumetric shading) with baked crown AO;
 *   LOD1 (mid):  trunk + a handful of big cards (same silhouette, ~10% of the triangles).
 * Far trees use a shared low-poly blob (see buildBlob).
 * Attributes: position, normal, uv (atlas), aLeaf (0 bark, 1 leaf, 2 palm frond), aAO.
 */
import * as THREE from 'three';
import { rng } from '../core/zone';
import { Arch } from './species';
import { R_BARK, R_BROAD, R_FROND, R_NEEDLE, R_PALMBARK, R_SMALL, R_SWATCH, regionUV, type Region } from './atlas';

class G {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  leaf: number[] = [];
  ao: number[] = [];
  idx: number[] = [];
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, vv: number, leaf: number, ao: number): number {
    this.pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nrm.push(nx / l, ny / l, nz / l);
    this.uv.push(u, vv);
    this.leaf.push(leaf);
    this.ao.push(ao);
    return this.pos.length / 3 - 1;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(this.leaf, 1));
    g.setAttribute('aAO', new THREE.Float32BufferAttribute(this.ao, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

interface TubePt {
  x: number;
  y: number;
  z: number;
  r: number;
}

function tube(g: G, pts: TubePt[], sides: number, reg: Region, ao = 0.8): void {
  const base = g.pos.length / 3;
  const H = pts[pts.length - 1].y - pts[0].y || 1;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      const [u, v] = regionUV(reg, k / sides, 1 - Math.min(1, (p.y - pts[0].y) / H));
      g.v(p.x + nx * p.r, p.y, p.z + nz * p.r, nx, 0.15, nz, u, v, 0, ao * (0.75 + 0.25 * Math.min(1, p.y / 3)));
    }
  }
  const row = sides + 1;
  for (let i = 0; i < pts.length - 1; i++)
    for (let k = 0; k < sides; k++) {
      const a = base + i * row + k;
      const b = a + row;
      g.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
}

/** One leaf card. n: face normal; centre c; crown centre/radii for the volumetric normal. */
function card(
  g: G,
  r: () => number,
  c: THREE.Vector3,
  n: THREE.Vector3,
  w: number,
  h: number,
  reg: Region,
  cc: THREE.Vector3,
  rad: THREE.Vector3,
  bend: number,
  leaf = 1,
): void {
  const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(n, up).normalize();
  const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
  const rot = r() * Math.PI * 2;
  const a1 = t1.clone().multiplyScalar(Math.cos(rot)).addScaledVector(t2, Math.sin(rot));
  const a2 = new THREE.Vector3().crossVectors(n, a1).normalize();
  const flip = r() < 0.5;
  const base = g.pos.length / 3;
  const corners: [number, number][] = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  const p = new THREE.Vector3();
  const e = new THREE.Vector3();
  for (const [sx, sy] of corners) {
    p.copy(c).addScaledVector(a1, sx * w).addScaledVector(a2, sy * h);
    // Ellipsoid normal of the crown at this point.
    e.set((p.x - cc.x) / (rad.x * rad.x), (p.y - cc.y) / (rad.y * rad.y), (p.z - cc.z) / (rad.z * rad.z)).normalize();
    const nn = n.clone().multiplyScalar(1 - bend).addScaledVector(e, bend);
    const dist = Math.sqrt(((p.x - cc.x) / rad.x) ** 2 + ((p.y - cc.y) / rad.y) ** 2 + ((p.z - cc.z) / rad.z) ** 2);
    const ao = THREE.MathUtils.clamp(0.35 + 0.65 * dist, 0.35, 1) * (0.72 + 0.28 * THREE.MathUtils.clamp((p.y - (cc.y - rad.y)) / (2 * rad.y), 0, 1));
    const [u, v] = regionUV(reg, flip ? 0.5 - sx : sx + 0.5, sy + 0.5);
    g.v(p.x, p.y, p.z, nn.x, nn.y, nn.z, u, v, leaf, ao);
  }
  g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

interface CrownSpec {
  H: number;
  W: number;
  base: number; // crown bottom (m)
  top: number; // crown top (m)
  clumps: number;
  cards: number;
  cardSize: number;
  reg: Region;
  trunkR: number;
  limbs: number;
  shape: 'ellipsoid' | 'cone' | 'flat';
  /** Bias card normals upward (pads) 0..1. */
  padUp: number;
}

function broadTree(s: CrownSpec, lod: 0 | 1, seed: number): THREE.BufferGeometry {
  const g = new G();
  const r = rng(seed);
  const cc = new THREE.Vector3(0, (s.base + s.top) / 2, 0);
  const rad = new THREE.Vector3(s.W / 2, (s.top - s.base) / 2, s.W / 2);
  // Trunk with a slight lean, rising into the crown.
  const lean = new THREE.Vector2((r() - 0.5) * 0.25, (r() - 0.5) * 0.25);
  const trunkTop = s.shape === 'cone' ? s.top * 0.97 : s.base + (s.top - s.base) * 0.45;
  const tp: TubePt[] = [];
  const nT = lod === 0 ? 6 : 3;
  for (let i = 0; i <= nT; i++) {
    const t = i / nT;
    const y = -0.3 + (trunkTop + 0.3) * t;
    const flare = i === 0 ? 1.35 : 1;
    tp.push({ x: lean.x * t * t * 2, y, z: lean.y * t * t * 2, r: s.trunkR * (1 - 0.55 * t) * flare });
  }
  tube(g, tp, lod === 0 ? 7 : 4, R_BARK);
  // Clump centres.
  const clumps: THREE.Vector3[] = [];
  const nC = lod === 0 ? s.clumps : Math.max(4, Math.round(s.clumps / 3.5));
  let guard = 0;
  while (clumps.length < nC && guard++ < 5000) {
    const v = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    const L = v.length();
    if (L > 1 || L < 0.05) continue;
    v.normalize().multiplyScalar(0.5 + 0.5 * Math.sqrt(r()));
    if (s.shape === 'flat') v.y = v.y * 0.55 + 0.25;
    const p = new THREE.Vector3(cc.x + v.x * rad.x, cc.y + v.y * rad.y, cc.z + v.z * rad.z);
    if (s.shape === 'cone') {
      const f = 1 - (p.y - s.base) / (s.top - s.base);
      const maxR = Math.max(0.4, (s.W / 2) * Math.pow(Math.max(0, f), 0.85));
      const hr = Math.hypot(p.x, p.z);
      if (hr > maxR) {
        p.x *= maxR / hr;
        p.z *= maxR / hr;
      }
    }
    clumps.push(p);
  }
  // Limbs from the trunk to the lower clumps (LOD0 only).
  if (lod === 0 && s.limbs > 0) {
    const sorted = [...clumps].sort((a, b) => a.y - b.y).slice(0, s.limbs);
    for (const c of sorted) {
      const sx = tp[nT - 2].x;
      const sz = tp[nT - 2].z;
      const sy = s.base + (trunkTop - s.base) * 0.25;
      const pts: TubePt[] = [];
      for (let i = 0; i <= 3; i++) {
        const t = i / 3;
        pts.push({ x: sx + (c.x - sx) * t * 0.85, y: sy + (c.y - sy) * Math.sqrt(t) * 0.9, z: sz + (c.z - sz) * t * 0.85, r: s.trunkR * 0.45 * (1 - 0.7 * t) });
      }
      tube(g, pts, 4, R_BARK, 0.7);
    }
  }
  // Cards.
  const nCards = lod === 0 ? s.cards : 4;
  const size = lod === 0 ? s.cardSize : s.cardSize * 1.75;
  for (const c of clumps) {
    for (let j = 0; j < nCards; j++) {
      const n = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1 + s.padUp * 1.5, r() * 2 - 1).normalize();
      const off = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(size * 0.55);
      const sz = size * (0.8 + r() * 0.45);
      card(g, r, c.clone().add(off), n, sz, sz, s.reg, cc, rad, 0.72);
    }
  }
  return g.build();
}

function palmTree(lod: 0 | 1, seed: number): THREE.BufferGeometry {
  const g = new G();
  const r = rng(seed);
  const H = 12;
  // Thick straight trunk with the pruned "pineapple" knob under the crown.
  const tp: TubePt[] = [];
  const crownY = H - 0.6;
  const nT = lod === 0 ? 10 : 4;
  for (let i = 0; i <= nT; i++) {
    const t = i / nT;
    const y = -0.3 + (crownY + 0.3) * t;
    let rr = 0.46 - 0.08 * t;
    if (y > H - 2.2) rr = 0.5 + 0.12 * Math.sin(((y - (H - 2.2)) / 1.6) * Math.PI);
    if (i === 0) rr *= 1.25;
    tp.push({ x: Math.sin(t * 1.3) * 0.12, y, z: 0, r: rr });
  }
  tube(g, tp, lod === 0 ? 9 : 5, R_PALMBARK, 0.9);
  const top = new THREE.Vector3(tp[nT].x, crownY, 0);
  const cc = new THREE.Vector3(top.x, crownY, 0);
  const rad = new THREE.Vector3(5, 2.5, 5);
  const N = lod === 0 ? 58 : 18;
  const segs = lod === 0 ? 7 : 3;
  for (let f = 0; f < N; f++) {
    const layer = f / N;
    const az = f * 2.39996 + r() * 0.3; // golden-angle spread
    const elev = THREE.MathUtils.lerp(1.15, -0.55, Math.pow(layer, 0.75)) + (r() - 0.5) * 0.25;
    const L = 4.6 + r() * 1.2 - layer * 0.6;
    const droop = 0.35 + layer * 0.35;
    const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const d = L * t;
      pts.push(
        top
          .clone()
          .addScaledVector(dir, Math.cos(elev) * d + 0.25)
          .add(new THREE.Vector3(0, Math.sin(elev) * d - droop * L * t * t, 0)),
      );
    }
    const base = g.pos.length / 3;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const w = 1.55 * (0.3 + 0.7 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.9 + 0.15));
      const p = pts[k];
      const along = (k < segs ? pts[k + 1].clone().sub(p) : p.clone().sub(pts[k - 1])).normalize();
      const nUp = new THREE.Vector3().crossVectors(side, along).normalize();
      if (nUp.y < 0) nUp.negate();
      const fold = lod === 0 ? 0.35 : 0.15;
      const ao = 0.55 + 0.45 * t;
      const [uc, vc] = regionUV(R_FROND, 0.5, 1 - t);
      const [ul] = regionUV(R_FROND, 0, 1 - t);
      const [ur] = regionUV(R_FROND, 1, 1 - t);
      const e = p.clone().sub(cc);
      e.set(e.x / 25, e.y / 6.25, e.z / 25).normalize();
      const nn = nUp.clone().multiplyScalar(0.5).addScaledVector(e, 0.5);
      g.v(p.x - side.x * w * 0.5, p.y + w * 0.5 * fold, p.z - side.z * w * 0.5, nn.x, nn.y, nn.z, ul, vc, 2, ao);
      g.v(p.x, p.y, p.z, nn.x, nn.y, nn.z, uc, vc, 2, ao * 0.92);
      g.v(p.x + side.x * w * 0.5, p.y + w * 0.5 * fold, p.z + side.z * w * 0.5, nn.x, nn.y, nn.z, ur, vc, 2, ao);
    }
    for (let k = 0; k < segs; k++) {
      const a = base + k * 3;
      const b = a + 3;
      g.idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    }
  }
  return g.build();
}

export interface ArchGeometry {
  lod: [THREE.BufferGeometry, THREE.BufferGeometry];
  refH: number;
  refW: number;
  /** Crown centre height and radii at reference size (for the far blob). */
  crownY: number;
  crownR: [number, number];
}

export function buildArchetypes(): ArchGeometry[] {
  const out: ArchGeometry[] = [];
  const mk = (s: CrownSpec, seed: number): ArchGeometry => ({
    lod: [broadTree(s, 0, seed), broadTree(s, 1, seed + 7)],
    refH: s.H,
    refW: s.W,
    crownY: (s.base + s.top) / 2,
    crownR: [s.W / 2, (s.top - s.base) / 2],
  });
  // Order must follow the Arch enum.
  out[Arch.Plane] = mk({ H: 12, W: 9, base: 3.6, top: 12, clumps: 18, cards: 6, cardSize: 2.3, reg: R_BROAD, trunkR: 0.24, limbs: 5, shape: 'ellipsoid', padUp: 0.1 }, 101);
  out[Arch.Round] = mk({ H: 8, W: 6.5, base: 2.4, top: 8, clumps: 20, cards: 6, cardSize: 1.8, reg: R_SMALL, trunkR: 0.2, limbs: 3, shape: 'ellipsoid', padUp: 0 }, 202);
  out[Arch.Column] = mk({ H: 10, W: 4, base: 2.2, top: 10, clumps: 16, cards: 5, cardSize: 1.6, reg: R_SMALL, trunkR: 0.17, limbs: 3, shape: 'ellipsoid', padUp: 0.15 }, 303);
  out[Arch.Palm] = { lod: [palmTree(0, 404), palmTree(1, 405)], refH: 12, refW: 9, crownY: 11.2, crownR: [4.2, 2.2] };
  out[Arch.Cone] = mk({ H: 28, W: 7, base: 4, top: 28, clumps: 30, cards: 5, cardSize: 2.6, reg: R_NEEDLE, trunkR: 0.55, limbs: 0, shape: 'cone', padUp: 0.35 }, 505);
  out[Arch.Pine] = mk({ H: 16, W: 12, base: 6, top: 16, clumps: 20, cards: 6, cardSize: 3.0, reg: R_NEEDLE, trunkR: 0.38, limbs: 4, shape: 'flat', padUp: 0.6 }, 606);
  out[Arch.Shrub] = mk({ H: 2.4, W: 3, base: -0.1, top: 2.4, clumps: 12, cards: 5, cardSize: 0.95, reg: R_SMALL, trunkR: 0.03, limbs: 0, shape: 'ellipsoid', padUp: 0.35 }, 707);
  return out;
}

/** Far-LOD crown blob: unit icosahedron with smooth normals, swatch UVs. */
export function buildBlob(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 0);
  const pos = ico.getAttribute('position');
  const n = pos.count;
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const leaf = new Float32Array(n).fill(1);
  const ao = new Float32Array(n);
  const [u0, v0] = regionUV(R_SWATCH, 0.5, 0.5);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const l = Math.hypot(x, y, z);
    nrm[i * 3] = x / l;
    nrm[i * 3 + 1] = y / l;
    nrm[i * 3 + 2] = z / l;
    uv[i * 2] = u0 + (x * 0.05);
    uv[i * 2 + 1] = v0 + (z * 0.05);
    ao[i] = 0.6 + 0.4 * (y * 0.5 + 0.5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', pos);
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aLeaf', new THREE.BufferAttribute(leaf, 1));
  g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  g.computeBoundingSphere();
  return g;
}
