/**
 * Terrain outside the detail zone, out to the edge of the terrain grid: lattice-aligned chunks at 8 m (land near
 * the city) or 16 m (bay floor / far land), merged into four band meshes. Every chunk carries short skirts so
 * the LOD seams (8/16 m vs the 4 m detail zone) never open cracks; the outer grid edge gets a deep skirt
 * (to −40 m) so the bay floor never shows a gap against the engine's far ring.
 */
import * as THREE from 'three';
import type { GroundSurface } from '../core/surface';
import { DZ, type Rect } from '../core/zone';
import { KIND_OUTER } from './tiles';

export function buildOuterGround(surface: GroundSurface): THREE.BufferGeometry[] {
  const cs = surface.cs;
  const G: Rect = {
    minX: surface.minX,
    minZ: surface.minZ,
    maxX: surface.minX + (surface.cols - 1) * cs,
    maxZ: surface.minZ + (surface.rows - 1) * cs,
  };
  const bands: Rect[] = [
    { minX: G.minX, maxX: G.maxX, minZ: G.minZ, maxZ: DZ.minZ },
    { minX: G.minX, maxX: G.maxX, minZ: DZ.maxZ, maxZ: G.maxZ },
    { minX: G.minX, maxX: DZ.minX, minZ: DZ.minZ, maxZ: DZ.maxZ },
    { minX: DZ.maxX, maxX: G.maxX, minZ: DZ.minZ, maxZ: DZ.maxZ },
  ];
  const out: THREE.BufferGeometry[] = [];
  const CH = 400;
  const nTmp = new Float32Array(3);
  for (const band of bands) {
    if (band.maxX - band.minX < cs || band.maxZ - band.minZ < cs) continue;
    const pos: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
      pos.push(x, y, z);
      nrm.push(nx, ny, nz);
      return pos.length / 3 - 1;
    };
    for (let cz0 = band.minZ; cz0 < band.maxZ - 1e-6; cz0 += CH) {
      for (let cx0 = band.minX; cx0 < band.maxX - 1e-6; cx0 += CH) {
        const cx1 = Math.min(band.maxX, cx0 + CH);
        const cz1 = Math.min(band.maxZ, cz0 + CH);
        // LOD: max height in chunk & distance to the detail zone.
        let maxH = -Infinity;
        for (let z = cz0; z <= cz1; z += 16) for (let x = cx0; x <= cx1; x += 16) maxH = Math.max(maxH, surface.meshHeight(x, z));
        const dx = Math.max(DZ.minX - cx1, 0, cx0 - DZ.maxX);
        const dz = Math.max(DZ.minZ - cz1, 0, cz0 - DZ.maxZ);
        const dist = Math.hypot(dx, dz);
        const step = maxH < -1.5 || dist > 700 ? 16 : 8;
        const xs: number[] = [];
        for (let x = cx0; x < cx1 - 1e-6; x += step) xs.push(x);
        xs.push(cx1);
        const zs: number[] = [];
        for (let z = cz0; z < cz1 - 1e-6; z += step) zs.push(z);
        zs.push(cz1);
        const nx = xs.length;
        const base = pos.length / 3;
        for (const z of zs) {
          for (const x of xs) {
            const c = Math.round((x - surface.minX) / cs);
            const r = Math.round((z - surface.minZ) / cs);
            surface.latticeNormal(surface.data, c, r, nTmp, 0);
            vert(x, surface.gridValue(c, r), z, nTmp[0], nTmp[1], nTmp[2]);
          }
        }
        // Cells entirely below the (opaque) bay surface are never visible: skip them.
        const wet = (v: number) => pos[v * 3 + 1] < -0.6;
        for (let j = 0; j < zs.length - 1; j++) {
          for (let i = 0; i < nx - 1; i++) {
            const a = base + j * nx + i;
            const b = a + 1;
            const d = a + nx;
            const e = d + 1;
            if (wet(a) && wet(b) && wet(d) && wet(e)) continue;
            idx.push(a, d, b, d, e, b);
          }
        }
        // Skirts along all four chunk edges (deep at the outer grid boundary).
        const skirt = (ids: number[], outward: [number, number], depth: number) => {
          if (ids.every((id) => pos[id * 3 + 1] < -0.6)) return;
          const start = pos.length / 3;
          for (const id of ids) {
            vert(pos[id * 3], pos[id * 3 + 1] - depth, pos[id * 3 + 2], outward[0], 0, outward[1]);
          }
          for (let k = 0; k < ids.length - 1; k++) {
            const a = ids[k];
            const b = ids[k + 1];
            const c = start + k;
            const d = start + k + 1;
            // Double-sided via both windings (skirts are thin and rarely seen).
            idx.push(a, c, b, b, c, d, a, b, c, b, d, c);
          }
        };
        const north = xs.map((_, i) => base + i);
        const south = xs.map((_, i) => base + (zs.length - 1) * nx + i);
        const west = zs.map((_, j) => base + j * nx);
        const east = zs.map((_, j) => base + j * nx + nx - 1);
        const deep = (edge: number, g: number) => (Math.abs(edge - g) < 1e-3 ? 60 : 6);
        skirt(north, [0, -1], deep(cz0, G.minZ));
        skirt(south, [0, 1], deep(cz1, G.maxZ));
        skirt(west, [-1, 0], deep(cx0, G.minX));
        skirt(east, [1, 0], deep(cx1, G.maxX));
      }
    }
    // Skirt hanging from the exact (4 m) detail-zone edge where this band touches it.
    const dzEdge = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.round(len / cs);
      const top: number[] = [];
      const bot: number[] = [];
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        const y = surface.meshHeight(x, z);
        top.push(vert(x, y, z, 0, 1, 0));
        bot.push(vert(x, y - 6, z, 0, 1, 0));
      }
      for (let k = 0; k < n; k++) idx.push(top[k], bot[k], top[k + 1], top[k + 1], bot[k], bot[k + 1], top[k], top[k + 1], bot[k], top[k + 1], bot[k + 1], bot[k]);
    };
    if (band.maxZ === DZ.minZ) dzEdge(DZ.minX, DZ.minZ, DZ.maxX, DZ.minZ);
    if (band.minZ === DZ.maxZ) dzEdge(DZ.minX, DZ.maxZ, DZ.maxX, DZ.maxZ);
    if (band.maxX === DZ.minX) dzEdge(DZ.minX, DZ.minZ, DZ.minX, DZ.maxZ);
    if (band.minX === DZ.maxX) dzEdge(DZ.maxX, DZ.minZ, DZ.maxX, DZ.maxZ);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(KIND_OUTER), 1));
    g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    out.push(g);
  }
  return out;
}
