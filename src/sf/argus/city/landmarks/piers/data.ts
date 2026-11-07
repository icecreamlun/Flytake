/**
 * Embarcadero finger piers north of the Ferry Building. Deck rectangles were fitted (PCA of the flattened
 * pier blocks) to public/data/terrain.bin, i.e. the decks the ground renders, which follow the OSM coastline
 * / pier polygons; shed extents and heights follow the OSM shed footprints (Pier 1, 9, 15, 17, 19/23) and
 * Port of San Francisco shed proportions (≈ 12-14 m eaves, low-pitch roofs with a clerestory monitor).
 * Pier 7 (open fishing pier) and Pier 27 (2014 cruise terminal) have no shed. Pier 3's bulkhead is the
 * separate Piers 1½-5 bulkhead building in the city data, so its shed starts behind it.
 */
import type { XZ } from '../../../contracts';

export interface PierSpec {
  /** Name painted on the bulkhead ("PIER 9"). */
  name: string;
  /** Centre of the deck's landward end (on the Embarcadero promenade). */
  root: XZ;
  /** Deck axis, degrees, atan2(dz, dx) pointing out into the bay. */
  angle: number;
  /** Deck length / width (m). */
  length: number;
  width: number;
  /** Shed width, lateral offset of its centre line (+ = to the right looking bay-ward), start / end along the axis. */
  shedWidth: number;
  shedOffset?: number;
  shedStart?: number;
  shedEnd: number;
  /** Eaves height above the deck (m). */
  eaves: number;
  /** Beaux-Arts bulkhead facade on the Embarcadero end (default true). */
  bulkhead?: boolean;
  /** Piers sharing one building record (e.g. Piers 19 & 23) are built as one landmark with one pivot. */
  group?: string;
}

export const PIERS: PierSpec[] = [
  { name: 'Pier 1', root: [263.9, -374.7], angle: -38.9, length: 224, width: 55, shedWidth: 42, shedEnd: 216, eaves: 13 },
  { name: 'Pier 3', root: [202.0, -460.5], angle: -36.1, length: 219, width: 46, shedWidth: 36, shedStart: 38, shedEnd: 210, eaves: 11.5, bulkhead: false },
  { name: 'Pier 9', root: [15.6, -730.2], angle: -35.4, length: 242, width: 51, shedWidth: 42, shedEnd: 234, eaves: 12.5 },
  { name: 'Pier 15', root: [-45.7, -822.9], angle: -38.8, length: 240, width: 95, shedWidth: 50, shedOffset: -7, shedEnd: 204, eaves: 13.5 },
  { name: 'Pier 17', root: [-104.5, -898.3], angle: -35.2, length: 243, width: 57, shedWidth: 44, shedEnd: 234, eaves: 12.5 },
  { name: 'Pier 19', root: [-165.1, -990.7], angle: -35.2, length: 239, width: 51, shedWidth: 42, shedEnd: 231, eaves: 12, group: '19-23' },
  { name: 'Pier 23', root: [-225.9, -1073.1], angle: -36.6, length: 240, width: 53, shedWidth: 42, shedEnd: 231, eaves: 12, group: '19-23' },
  { name: 'Pier 29', root: [-537.1, -1391.9], angle: -57.3, length: 253, width: 50, shedWidth: 40, shedEnd: 244, eaves: 12.5 },
  { name: 'Pier 31', root: [-625.1, -1471.5], angle: -70.5, length: 246, width: 50, shedWidth: 40, shedEnd: 237, eaves: 12.5 },
  { name: 'Pier 35', root: [-713.2, -1551.3], angle: -98.1, length: 288, width: 71, shedWidth: 56, shedEnd: 278, eaves: 14 },
];
