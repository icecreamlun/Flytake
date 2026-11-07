/**
 * Street-tree species → archetype, size (from DBH) and late-October foliage tint.
 */
import type { TreeRecord } from '../../../contracts';
import { hash01 } from '../core/zone';

export const enum Arch {
  Plane = 0, // broad deciduous crown (London plane, sweetgum, elm, maple, tulip tree…)
  Round = 1, // dense rounded evergreen (Indian laurel fig, NZ Christmas tree, Victorian box, olive, Brisbane box…)
  Column = 2, // narrow upright (ginkgo, ornamental pear, fern pine…)
  Palm = 3, // Canary Island date palm & other palms
  Cone = 4, // coast redwood / tall narrow conifer
  Pine = 5, // Monterey pine / cypress / eucalyptus: big irregular crowns
  Shrub = 6, // low dense dome from the ground (coyote brush, toyon, pittosporum hedges, ivy mounds)
}
export const ARCH_COUNT = 7;

export interface TreeSpec {
  arch: Arch;
  /** Total height (m) and crown diameter (m). */
  h: number;
  w: number;
  /** Linear-ish tint multiplied onto the foliage albedo. */
  tint: [number, number, number];
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function archOf(sp: string): Arch {
  const s = sp.toLowerCase();
  if (/phoenix|palm|washingtonia|syagrus|trachycarpus|archontophoenix|butia|chamaerops/.test(s)) return Arch.Palm;
  if (/sequoia|redwood|cedrus|araucaria|metasequoia/.test(s)) return Arch.Cone;
  if (/pinus|cupressus|eucalyptus|corymbia|melaleuca|acacia|pine|cypress/.test(s)) return Arch.Pine;
  if (/ginkgo|pyrus|afrocarpus|podocarpus|carpinus|quercus robur 'fastigiata'|populus|ulmus 'frontier'|lagerstroemia/.test(s)) return Arch.Column;
  if (/platanus|liquidambar|ulmus|tilia|acer|liriodendron|fraxinus|celtis|gleditsia|zelkova|betula|catalpa|quercus|robinia|jacaranda|prunus|koelreuteria/.test(s)) return Arch.Plane;
  return Arch.Round;
}

export function specFor(t: TreeRecord, inRedwoodGrove: boolean, inPioneerPark: boolean, idx: number): TreeSpec | null {
  const sp = t.species ?? '';
  if (/planting site|paved over|stump|vacant/i.test(sp)) return null;
  if (/^shrub/i.test(sp)) {
    // Scattered wild-land shrubs (see scatter.ts): dark glossy evergreens to grey-green coastal scrub.
    const r1 = hash01(idx, 11);
    const r2 = hash01(idx, 23);
    const v = 0.85 + 0.3 * r1;
    const tint: [number, number, number] = /grey/i.test(sp) ? [0.85 * v, 0.88 * v, 0.66 * v] : r2 < 0.5 ? [0.58 * v, 0.74 * v, 0.46 * v] : [0.72 * v, 0.84 * v, 0.5 * v];
    return { arch: Arch.Shrub, h: 1.2 + 2.2 * r1, w: 1.8 + 2.6 * r2, tint };
  }
  let arch = sp ? archOf(sp) : Arch.Round;
  const r1 = hash01(idx, 11);
  const r2 = hash01(idx, 23);
  if (!sp) {
    if (inRedwoodGrove) arch = Arch.Cone;
    else if (inPioneerPark) arch = r1 < 0.55 ? Arch.Pine : r1 < 0.8 ? Arch.Plane : Arch.Round;
    else arch = r1 < 0.45 ? Arch.Plane : r1 < 0.85 ? Arch.Round : Arch.Column;
  }
  const dbh = t.dbh && t.dbh > 0 ? Math.min(t.dbh, 60) : 6 + r2 * 10;
  let h: number;
  let w: number;
  let tint: [number, number, number];
  const v = 0.88 + 0.24 * r1;
  switch (arch) {
    case Arch.Plane: {
      h = clamp(4.5 + dbh * 0.5, 5.5, 22);
      w = clamp(2.5 + dbh * 0.38, 3.5, 15);
      // October: planes / sweetgums are part green, part yellow-brown.
      const turn = /platanus|liquidambar|acer|ulmus|liriodendron|prunus/i.test(sp) ? r2 : r2 * 0.4;
      tint = [v * (0.92 + 0.5 * turn), v * (0.95 + 0.12 * turn), v * (0.7 - 0.25 * turn)];
      if (/acer rubrum|liquidambar/i.test(sp) && r2 > 0.6) tint = [1.5 * v, 0.62 * v, 0.3 * v];
      break;
    }
    case Arch.Round: {
      h = clamp(3.8 + dbh * 0.32, 4.2, 13);
      w = clamp(2.4 + dbh * 0.33, 3, 11);
      const magnolia = /magnolia/i.test(sp);
      const grey = /metrosideros|olea|pittosporum|acacia/i.test(sp);
      tint = magnolia ? [0.62 * v, 0.78 * v, 0.55 * v] : grey ? [0.82 * v, 0.9 * v, 0.72 * v] : [0.7 * v, 0.88 * v, 0.56 * v];
      break;
    }
    case Arch.Column: {
      h = clamp(4.5 + dbh * 0.5, 5.5, 16);
      w = clamp(1.8 + dbh * 0.2, 2.2, 6);
      if (/ginkgo/i.test(sp)) {
        // Ginkgos turn butter-yellow in late October / November.
        const y = r2;
        tint = [v * (1.0 + 0.55 * y), v * (1.02 + 0.2 * y), v * (0.55 - 0.3 * y)];
      } else if (/pyrus/i.test(sp)) tint = [v * (1.0 + 0.5 * r2), v * (0.9 - 0.2 * r2), v * 0.55];
      else tint = [0.75 * v, 0.9 * v, 0.6 * v];
      break;
    }
    case Arch.Palm:
      h = clamp(dbh * 0.42, 7, 17);
      w = clamp(7 + dbh * 0.06, 7.5, 11);
      tint = [0.95 * v, 1.0 * v, 0.78 * v];
      break;
    case Arch.Cone:
      h = clamp(10 + dbh * 0.7, 14, 34);
      w = clamp(3 + dbh * 0.12, 4, 8);
      tint = [0.6 * v, 0.75 * v, 0.55 * v];
      break;
    default:
      h = clamp(7 + dbh * 0.45, 8, 24);
      w = clamp(4 + dbh * 0.32, 5, 15);
      tint = [0.68 * v, 0.82 * v, 0.6 * v];
  }
  return { arch, h, w, tint };
}
