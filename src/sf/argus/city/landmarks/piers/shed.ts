/**
 * Pier shed (Port of San Francisco transit shed, 1910s–30s): a long reinforced-concrete warehouse on the
 * pier deck — pilastered side walls with tall rolling cargo doors, a continuous band of steel-sash clerestory
 * windows under the cornice, a low-pitch gable roof with a glazed monitor along the ridge, gutters, roof
 * ventilators, and a gabled bay-end wall.
 *
 * Built in the pier frame: x along the pier (u, bay-ward), z across it (v), y up from the deck.
 */
import * as THREE from 'three';
import { box, cyl, hexa, wall, rectPath } from '../common/geom';
import type { Add } from './bulkhead';

const COL = {
  wall: '#e2d9c5',
  pilaster: '#ebe4d3',
  base: '#a9a294',
  door: '#4a6152',
  doorAlt: '#56605a',
  roof: '#7c7a74',
  monitorRoof: '#6d6b66',
  gutter: '#5b5e5c',
  vent: '#8a8d8c',
};

export interface ShedSpec {
  x0: number;
  x1: number;
  /** Centre line (z) and half width. */
  zc: number;
  hw: number;
  eaves: number;
  seed: number;
  /** Close the landward end with a plain gable (when no bulkhead stands in front). */
  closeRoot: boolean;
}

const BAY = 6.1; // 20 ft structural bay
const PITCH = THREE.MathUtils.degToRad(9);

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function addShed(add: Add, s: ShedSpec): void {
  const { x0, x1, zc, hw, eaves: He } = s;
  let k = s.seed | 0 || 1;
  const rnd = () => ((k = (k * 16807) % 2147483647) / 2147483647);
  const L = x1 - x0;
  const nb = Math.max(4, Math.round(L / BAY));
  const bw = L / nb;
  const winY0 = 7.4; // clerestory band
  const winY1 = He - 1.5;
  const doorW = Math.min(4.6, bw - 1.4);
  const doorH = 5.4;
  const t = 0.4; // wall thickness

  // ── Long side walls (both sides) ──
  for (const side of [-1, 1]) {
    const zf = zc + side * hw; // outer face
    const holes: THREE.Path[] = [];
    const doors: number[] = [];
    for (let i = 0; i < nb; i++) {
      const xm = x0 + (i + 0.5) * bw;
      // Cargo doors in two bays out of three; pedestrian door now and then.
      if (i % 3 !== 1) {
        // The −z wall is built mirrored (x → −x) and turned 180° so its face looks outward.
        holes.push(rectPath(side * xm, doorW, 0, doorH));
        doors.push(xm);
      }
    }
    // Lower wall (with door openings), then the spandrel above the clerestory.
    const [wx0, wx1] = side > 0 ? [x0, x1] : [-x1, -x0];
    const low = wall(wx0, wx1, 0, winY0, t, holes);
    const up = wall(wx0, wx1, winY1, He, t, []);
    for (const g of [low, up]) {
      if (side < 0) g.rotateY(Math.PI);
      g.translate(0, 0, zf);
      add('wall', g, { color: COL.wall });
    }
    // Clerestory glazing, set back between the pilasters; each bay lit (or not) at night as a unit.
    for (let i = 0; i < nb; i++) {
      const xm = x0 + (i + 0.5) * bw;
      const on = rnd();
      add('glass', box(bw - 0.9, winY1 - winY0, 0.1, xm, winY0, zf - side * 0.3), { glow: on < 0.22 ? 0.75 + rnd() * 0.4 : on < 0.35 ? 0.2 : 0 });
      // Sill + transom bar.
      add('wall', box(bw - 0.9, 0.22, 0.45, xm, winY0 - 0.02, zf - side * 0.1), { color: COL.pilaster });
      add('wall', box(bw - 0.9, 0.16, 0.12, xm, winY0 + (winY1 - winY0) * 0.55, zf - side * 0.22), { color: COL.door });
    }
    // Door leaves (rolling steel doors, recessed) with a little lintel band.
    for (const xm of doors) {
      add('roof', box(doorW, doorH, 0.1, xm, 0, zf - side * (t - 0.06)), { color: rnd() < 0.8 ? COL.door : COL.doorAlt });
      add('wall', box(doorW + 0.5, 0.35, 0.18, xm, doorH, zf + side * 0.05), { color: COL.pilaster });
    }
    // Pilasters at every bay line, plinth, frieze and cornice.
    for (let i = 0; i <= nb; i++) {
      const x = x0 + i * bw;
      const w = i === 0 || i === nb ? 1.3 : 0.85;
      add('wall', box(w, He - 0.2, 0.42, Math.min(Math.max(x, x0 + w / 2), x1 - w / 2), 0, zf + side * 0.18), { color: COL.pilaster });
    }
    add('wall', box(L, 0.9, 0.2, (x0 + x1) / 2, 0, zf + side * 0.08), { color: COL.base });
    add('wall', box(L + 0.6, 0.55, 0.75, (x0 + x1) / 2, He - 0.2, zf + side * 0.2), { color: COL.pilaster });
    // Gutter and downpipes.
    add('roof', box(L + 0.8, 0.28, 0.35, (x0 + x1) / 2, He + 0.22, zf + side * 0.55), { color: COL.gutter });
    for (let i = 2; i < nb; i += 4) add('roof', cyl(0.09, 0.09, He + 0.3, 6, x0 + i * bw, 0.2, zf + side * 0.62), { color: COL.gutter });
  }

  // ── Roof: low-pitch gable up to a glazed monitor along the ridge ──
  const mw = Math.max(5, hw * 0.55); // monitor half-width
  const rise = (hw - mw) * Math.tan(PITCH);
  const yM = He + rise; // where the slopes meet the monitor
  const monH = 2.3;
  const ov = 0.7; // eave overhang
  const rt = 0.3; // roof thickness
  for (const side of [-1, 1]) {
    const zE = zc + side * (hw + ov);
    const zM = zc + side * mw;
    const yE = He - ov * Math.tan(PITCH);
    add(
      'roof',
      hexa([V(x0 - ov, yE, zE), V(x1 + ov, yE, zE), V(x1 + ov, yM, zM), V(x0 - ov, yM, zM), V(x0 - ov, yE + rt, zE), V(x1 + ov, yE + rt, zE), V(x1 + ov, yM + rt, zM), V(x0 - ov, yM + rt, zM)]),
      { color: COL.roof },
    );
    // Monitor side: glazing strip between posts.
    add('glass', box(L - 1, monH - 0.5, 0.1, (x0 + x1) / 2, yM + 0.3, zM - side * 0.15), { glow: 0.05 });
    for (let x = x0; x <= x1 + 0.01; x += bw) add('wall', box(0.3, monH, 0.3, Math.min(Math.max(x, x0 + 0.15), x1 - 0.15), yM, zM), { color: COL.pilaster });
    add('wall', box(L, 0.35, 0.35, (x0 + x1) / 2, yM, zM), { color: COL.pilaster });
  }
  // Monitor roof (shallow gable) + ridge cap.
  const yMR = yM + monH;
  const mRise = mw * Math.tan(PITCH * 0.8);
  for (const side of [-1, 1]) {
    const zE = zc + side * (mw + 0.5);
    add(
      'roof',
      hexa([V(x0 - 0.5, yMR, zE), V(x1 + 0.5, yMR, zE), V(x1 + 0.5, yMR + mRise, zc), V(x0 - 0.5, yMR + mRise, zc), V(x0 - 0.5, yMR + 0.25, zE), V(x1 + 0.5, yMR + 0.25, zE), V(x1 + 0.5, yMR + mRise + 0.25, zc), V(x0 - 0.5, yMR + mRise + 0.25, zc)]),
      { color: COL.monitorRoof },
    );
  }
  add('roof', box(L + 1, 0.3, 0.5, (x0 + x1) / 2, yMR + mRise + 0.1, zc), { color: COL.gutter });
  // Roof ventilators along both slopes.
  for (let x = x0 + bw * 2; x < x1 - bw; x += bw * 4) {
    for (const side of [-1, 1]) {
      const z = zc + side * (mw + (hw - mw) * 0.45);
      const y = He + (hw - Math.abs(z - zc)) * Math.tan(PITCH);
      add('roof', cyl(0.45, 0.5, 1.2, 8, x, y, z), { color: COL.vent });
      add('roof', cyl(0.75, 0.2, 0.45, 8, x, y + 1.2, z), { color: COL.vent });
    }
  }

  // ── Gable end walls ──
  const gable = (x: number, dir: number, withDoor: boolean) => {
    const holes: THREE.Path[] = [];
    if (withDoor) holes.push(rectPath(0, 7.5, 0, 6.2));
    const winZ = [-hw * 0.62, -hw * 0.22, hw * 0.22, hw * 0.62];
    for (const zz of winZ) holes.push(rectPath(zz, hw * 0.3, winY0, winY1 - winY0)); // symmetric → no mirroring needed
    // Wall in the XY plane facing +Z, then turned to face ±X.
    const g = wall(-hw, hw, 0, He, t, holes);
    g.rotateY(dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    g.translate(x, 0, zc);
    add('wall', g, { color: COL.wall });
    // Triangular gable up to the monitor and the monitor end.
    const tri = new THREE.Shape();
    tri.moveTo(-hw - 0.2, He - 0.01);
    tri.lineTo(hw + 0.2, He - 0.01);
    tri.lineTo(mw, yM);
    tri.lineTo(mw, yMR);
    tri.lineTo(0, yMR + mRise);
    tri.lineTo(-mw, yMR);
    tri.lineTo(-mw, yM);
    tri.lineTo(-hw - 0.2, He - 0.01);
    const tg = new THREE.ExtrudeGeometry(tri, { depth: t, bevelEnabled: false });
    tg.translate(0, 0, -t);
    tg.rotateY(dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    tg.translate(x, 0, zc);
    add('wall', tg, { color: COL.wall });
    // Window band and a round louvred vent in the gable.
    const wx = x + dir * 0.06;
    for (const zz of winZ) add('glass', box(0.1, winY1 - winY0, hw * 0.3, x - dir * 0.28, winY0, zc + zz), { glow: rnd() < 0.3 ? 0.8 : 0 });
    add('wall', box(0.3, 0.25, 2 * hw, wx, winY0 - 0.1, zc), { color: COL.pilaster });
    const vent = cyl(1.2, 1.2, 0.3, 16, 0, 0, 0);
    vent.rotateZ(Math.PI / 2);
    vent.translate(wx, He + rise * 0.55, zc);
    add('roof', vent, { color: COL.gutter });
    if (withDoor) add('roof', box(0.1, 6.2, 7.5, x - dir * (t - 0.05), 0, zc), { color: COL.door });
    for (const zz of [-hw, -hw * 0.42, hw * 0.42, hw]) add('wall', box(0.5, He - 0.2, 0.9, wx + dir * 0.1, 0, zc + Math.max(-hw + 0.45, Math.min(hw - 0.45, zz))), { color: COL.pilaster });
  };
  gable(x1, 1, true);
  if (s.closeRoot) gable(x0, -1, true);
}
