/**
 * Wild-land vegetation: shrubs and trees scattered over open, unclassified ground inside blocks (yards, vacant
 * lots and especially the Telegraph Hill slopes and quarry cliffs, which in reality are thick with ivy, coyote
 * brush, eucalyptus and Monterey cypress). Placement is a jittered 3.2 m grid filtered by:
 *   - inside a block, ≥ 3 m from any carriageway and ≥ 2.5 m from any building footprint;
 *   - unclassified landcover (no sidewalk, lawn, pavers, flush asphalt, dirt path or stairs), not on a deck;
 * with a density that rises with slope and follows a clumping noise. Returns tree records for the TreeSystem.
 */
import type { CityData, TreeRecord } from '../../../contracts';
import type { GroundSurface } from '../core/surface';
import type { Landcover } from '../ground/landcover';
import { CTX, DZ, hash01, inRect, smoothstep } from '../core/zone';

/** 2 m raster of building footprints over the detail zone. */
function buildingRaster(city: CityData): { data: Uint8Array; w: number; h: number } {
  const w = (DZ.maxX - DZ.minX) / 2;
  const h = (DZ.maxZ - DZ.minZ) / 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  g.setTransform(0.5, 0, 0, 0.5, -DZ.minX / 2, -DZ.minZ / 2);
  g.fillStyle = '#fff';
  for (const b of city.buildings) {
    g.beginPath();
    g.moveTo(b.footprint[0][0], b.footprint[0][1]);
    for (let i = 1; i < b.footprint.length; i++) g.lineTo(b.footprint[i][0], b.footprint[i][1]);
    g.closePath();
    g.fill();
  }
  const d = g.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = d[i * 4];
  return { data, w, h };
}

/** Smooth 2D value noise in [0,1] (lattice spacing 1). */
function vnoise(x: number, z: number, seed: number): number {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const fx = x - i;
  const fz = z - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash01(i, j, seed);
  const b = hash01(i + 1, j, seed);
  const c = hash01(i, j + 1, seed);
  const d = hash01(i + 1, j + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const TREES = ['Eucalyptus globulus', 'Cupressus macrocarpa', 'Pittosporum undulatum', 'Metrosideros excelsa', 'Acacia melanoxylon', 'Pinus radiata'];

export function scatterWildVegetation(city: CityData, surface: GroundSurface, lc: Landcover): TreeRecord[] {
  const out: TreeRecord[] = [];
  const bm = buildingRaster(city);
  const A = lc.texA.image.data as Uint8Array;
  const B = lc.texB.image.data as Uint8Array;
  const W = DZ.maxX - DZ.minX;
  const W2 = W / 2;
  const nearBuilding = (x: number, z: number) => {
    for (const [ox, oz] of [
      [0, 0],
      [2.5, 0],
      [-2.5, 0],
      [0, 2.5],
      [0, -2.5],
    ]) {
      const i = Math.floor((x + ox - DZ.minX) / 2);
      const j = Math.floor((z + oz - DZ.minZ) / 2);
      if (i < 0 || j < 0 || i >= bm.w || j >= bm.h) return true;
      if (bm.data[j * bm.w + i] > 20) return true;
    }
    return false;
  };
  const wild = (x: number, z: number) => {
    const i = Math.floor(x - DZ.minX);
    const j = Math.floor(z - DZ.minZ);
    const a = (j * W + i) * 4;
    if (A[a] > 40 || A[a + 1] > 40 || A[a + 2] > 40 || A[a + 3] > 40) return false;
    const b = (Math.floor(j / 2) * W2 + Math.floor(i / 2)) * 4;
    return B[b] < 40 && B[b + 1] < 40;
  };
  const step = 3.2;
  let k = 0;
  for (let z = CTX.minZ + 30; z < CTX.maxZ - 30; z += step) {
    for (let x = CTX.minX + 30; x < CTX.maxX - 30; x += step) {
      k++;
      const px = x + (hash01(k, 1) - 0.5) * step * 0.8;
      const pz = z + (hash01(k, 2) - 0.5) * step * 0.8;
      if (!inRect(DZ, px, pz, -4)) continue;
      // Clumping: dense thickets and open patches; denser on slopes.
      const clump = vnoise(px / 22, pz / 22, 5) * 0.7 + vnoise(px / 7, pz / 7, 9) * 0.3;
      const n = surface.normalAt(px, pz);
      const slope = 1 - n.y;
      const p = (0.025 + 0.85 * smoothstep(0.05, 0.25, slope)) * smoothstep(0.2, 0.6, clump);
      if (hash01(k, 3) > p) continue;
      if (surface.blockAt(px, pz) < 0.95) continue;
      if (surface.blockAt(px + 3, pz) < 0.9 || surface.blockAt(px - 3, pz) < 0.9 || surface.blockAt(px, pz + 3) < 0.9 || surface.blockAt(px, pz - 3) < 0.9) continue;
      if (!wild(px, pz) || nearBuilding(px, pz)) continue;
      if (surface.decks.length && surface.deckAt(px, pz) !== null) continue;
      const r = hash01(k, 4);
      const treeP = 0.12 + 0.25 * smoothstep(0.1, 0.3, slope) * smoothstep(0.5, 0.8, clump);
      if (r < treeP) {
        const sp = TREES[Math.floor(hash01(k, 5) * TREES.length)];
        out.push({ x: px, z: pz, species: sp, dbh: 6 + 16 * hash01(k, 6), source: 'estimated' });
      } else out.push({ x: px, z: pz, species: hash01(k, 7) < 0.3 ? 'Shrub grey' : 'Shrub', source: 'estimated' });
    }
  }
  return out;
}
