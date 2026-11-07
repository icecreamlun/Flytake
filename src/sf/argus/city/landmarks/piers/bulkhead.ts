/**
 * Embarcadero bulkhead building (1912–1931): the Beaux-Arts / Mission Revival front of a pier shed facing
 * The Embarcadero — a raised centre pavilion with the great arched cargo portal, paired columns, keystone,
 * pediment and the "PIER n" frieze, flanked by two-storey arcaded wings with pilasters, cornice and parapet.
 *
 * Built in a facade frame: x across the facade (centre 0), +z outward toward the street, y up from the deck.
 * The volume extends `depth` metres back (−z) so the shed behind butts into it.
 */
import * as THREE from 'three';
import type { AddOpts } from '../common/builder';
import { archPath, archivolt, box, wall } from '../common/geom';

export type Add = (key: string, g: THREE.BufferGeometry, o?: AddOpts) => void;

const COL = { wall: '#e6dcc6', trim: '#f2ece0', base: '#bfb7a5', sash: '#ffffff', door: '#3c5446', roof: '#8d8a84' };
/** Night wash on the bulkhead stucco (× albedo; see the piers' wall material glow). */
const GLOW = 0.55;

export interface BulkheadInfo {
  /** Height of the frieze sign centre and the pavilion top (m above the deck). */
  signY: number;
  top: number;
}

export function addBulkhead(add: Add, len: number, H: number, depth: number, seed: number): BulkheadInfo {
  const hx = len / 2;
  const HC = H + 4.5; // centre pavilion
  // Volume behind the facade (its roof hides the shed's end above the shed eaves).
  add('wall', box(len, H, depth, 0, 0, -depth / 2), { color: COL.wall, glow: GLOW * 0.6 });
  add('roof', box(len + 0.4, 0.35, depth + 0.2, 0, H, -depth / 2), { color: COL.roof });
  // Wings: arcaded ground floor + arched upper windows between pilasters.
  const pw = Math.min(17, len * 0.3);
  const wingBays = Math.max(2, Math.round((hx - pw / 2) / 5.2));
  const holes: THREE.Path[] = [];
  const glass: { x: number; w: number; y0: number; ys: number; glow: number }[] = [];
  let k = seed;
  const rnd = () => ((k = (k * 16807) % 2147483647) / 2147483647);
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -hx : pw / 2;
    const x1 = side < 0 ? -pw / 2 : hx;
    const bw = (x1 - x0) / wingBays;
    for (let i = 0; i < wingBays; i++) {
      const x = x0 + (i + 0.5) * bw;
      holes.push(archPath(x, bw * 0.56, 0.45, 3.9, 10));
      glass.push({ x, w: bw * 0.56, y0: 0.45, ys: 3.9, glow: rnd() < 0.6 ? 0.85 : 0.25 });
      holes.push(archPath(x, bw * 0.4, 6.2, H - 4.4, 10));
      glass.push({ x, w: bw * 0.4, y0: 6.2, ys: H - 4.4, glow: rnd() < 0.35 ? 0.9 : 0.15 });
    }
    for (let i = 0; i <= wingBays; i++) {
      const x = Math.min(Math.max(x0 + i * bw, -hx + 0.45), hx - 0.45);
      add('trim', box(0.8, H - 1.6, 0.3, x, 0.4, 0.85), { color: COL.trim, glow: GLOW });
    }
  }
  // Great arched cargo portal in the pavilion.
  const portalW = Math.min(8.6, pw * 0.55);
  holes.push(archPath(0, portalW, 0.0, 6.4, 16));
  const portal = new THREE.ShapeGeometry(new THREE.Shape(archPath(0, portalW, 0.0, 6.4, 16).getPoints()));
  portal.translate(0, 0, 0.3);
  add('glass', portal, { glow: 0.8 });
  // Mullions + transom bar in the portal glazing (steel sash, dark green).
  add('roof', box(portalW, 0.25, 0.12, 0, 4.6, 0.42), { color: COL.door });
  for (const dx of [-portalW / 4, 0, portalW / 4]) add('roof', box(0.16, 6.4 + (dx === 0 ? portalW / 2 : portalW * 0.43), 0.12, dx, 0, 0.42), { color: COL.door });
  add('wall', wall(-hx, hx, 0, H, 0.6, holes).translate(0, 0, 0.7), { color: COL.wall, glow: GLOW });
  add('wall', box(pw, HC - H, 3.0, 0, H, -0.8), { color: COL.wall, glow: GLOW });
  for (const g of glass) {
    const gl = new THREE.ShapeGeometry(new THREE.Shape(archPath(g.x, g.w, g.y0, g.ys, 10).getPoints()));
    gl.translate(0, 0, 0.32);
    add('glass', gl, { glow: g.glow });
    add('trim', archivolt(g.x, g.ys, g.w / 2, g.w / 2 + 0.28, 0.12, 10).translate(0, 0, 0.7), { color: COL.trim, glow: GLOW });
    // Sill.
    add('trim', box(g.w + 0.5, 0.18, 0.3, g.x, g.y0 - 0.18, 0.8), { color: COL.trim, glow: GLOW });
  }
  add('trim', archivolt(0, 6.4, portalW / 2, portalW / 2 + 0.7, 0.2, 18).translate(0, 0, 0.7), { color: COL.trim, glow: GLOW });
  add('trim', box(1.2, 1.5, 0.4, 0, 6.4 + portalW / 2 - 0.2, 0.7), { color: COL.trim, glow: GLOW }); // keystone
  // Paired columns flanking the portal, full height of the pavilion, with capitals and bases.
  for (const s of [-1, 1]) {
    for (const dx of [portalW / 2 + 1.1, portalW / 2 + 2.4]) {
      add('trim', box(0.95, HC - 2.2, 0.55, s * dx, 0.5, 1.0), { color: COL.trim, glow: GLOW });
      add('trim', box(1.3, 0.55, 0.8, s * dx, HC - 2.4, 1.0), { color: COL.trim, glow: GLOW });
      add('trim', box(1.25, 0.5, 0.8, s * dx, 0, 1.0), { color: COL.base, glow: GLOW });
    }
  }
  // Cornices, parapet with balusters' rhythm, pediment.
  add('trim', box(len + 0.8, 0.7, 1.4, 0, H - 1.0, 0.6), { color: COL.trim, glow: GLOW });
  add('wall', box(len + 0.4, 1.1, 0.6, 0, H - 0.3, 0.75), { color: COL.wall, glow: GLOW });
  add('trim', box(len + 0.6, 0.25, 0.8, 0, H + 0.8, 0.75), { color: COL.trim, glow: GLOW });
  for (let x = -hx + 2; x <= hx - 2; x += 4) if (Math.abs(x) > pw / 2 + 1) add('trim', box(0.7, 0.8, 0.7, x, H + 0.8, 0.75), { color: COL.trim, glow: GLOW });
  add('trim', box(pw + 1.4, 0.8, 1.5, 0, HC - 0.9, 0.6), { color: COL.trim, glow: GLOW });
  const ped = new THREE.Shape();
  ped.moveTo(-pw / 2 - 0.5, 0);
  ped.lineTo(pw / 2 + 0.5, 0);
  ped.lineTo(0, 3.0);
  ped.lineTo(-pw / 2 - 0.5, 0);
  add('trim', new THREE.ExtrudeGeometry(ped, { depth: 1.2, bevelEnabled: false }).translate(0, HC - 0.1, -0.1), { color: COL.trim, glow: GLOW });
  // Plinth / base course and the Embarcadero-side lamp brackets either side of the portal.
  add('trim', box(len + 0.5, 0.5, 1.0, 0, -0.2, 0.55), { color: COL.base, glow: GLOW * 0.5 });
  for (const s of [-1, 1]) {
    add('roof', box(0.25, 0.25, 0.7, s * (portalW / 2 + 3.3), 3.6, 1.35), { color: '#2a2b2a' });
    add('glass', box(0.45, 0.6, 0.45, s * (portalW / 2 + 3.3), 3.0, 1.65), { glow: 1.6 });
  }
  return { signY: H + 1.85, top: HC + 3 };
}
