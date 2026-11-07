/**
 * Old St. Mary's Cathedral (1854), California St & Grant Ave: red-brick Gothic Revival church. Nave with
 * buttressed side walls and lancet windows under a steep slate roof, the gabled front on California St
 * with corner blocks, and the square clock tower (pointed entrance, lancet, clock dials over the
 * inscription "SON, OBSERVE THE TIME AND FLY FROM EVIL", louvred belfry, crenellated top with pinnacles).
 * The rectory annex and side chapel follow the OSM outline. The site falls ~9 m from California St to
 * the north-east, so the nave floor sits at street level on the front and the basement is exposed behind.
 */
import * as THREE from 'three';
import { PartBuilder } from './common/builder';
import { beam, box, cyl, gothicPath, prism, sweepClosed, wall, type V2 } from './common/geom';
import { lmMaterial } from './common/materials';
import { clockDial, signPanel } from './common/canvasArt';
import { clockHands } from './common/clock';
import { centroid, frameFromAxis, longestEdge, makePivot, toLocal } from './common/frame';
import type { LandmarkBuild, LandmarkEnv } from './common/types';

const COL = { brick: '#ffffff', trim: '#d3c9b6', roof: '#55575c', dark: '#25221f' };

type Add = (key: string, g: THREE.BufferGeometry, o?: { color?: THREE.ColorRepresentation; glow?: number; uv?: 'box' | 'keep'; smooth?: boolean }) => void;

/** Wall in the XY plane placed on a local-frame side: `side` = 'S' (+z), 'N' (−z), 'E' (+x), 'W' (−x). */
function placeWall(g: THREE.BufferGeometry, side: 'S' | 'N' | 'E' | 'W', at: number, centre: number): THREE.BufferGeometry {
  const ry = { S: 0, E: Math.PI / 2, N: Math.PI, W: -Math.PI / 2 }[side];
  g.rotateY(ry);
  if (side === 'S') g.translate(centre, 0, at);
  else if (side === 'N') g.translate(centre, 0, at);
  else if (side === 'E') g.translate(at, 0, centre);
  else g.translate(at, 0, centre);
  return g;
}

export function buildOldStMarys(env: LandmarkEnv): LandmarkBuild | null {
  const rec = env.byLandmark('old_st_marys')[0];
  if (!rec) return null;
  const fp = rec.footprint;
  // Axis: perpendicular to the longest (north) edge, pointing toward the centroid → local +Z = California St.
  const e = longestEdge(fp);
  const [gx, gz] = centroid(fp);
  let zx = -e.uz;
  let zz = e.ux;
  const mid: V2 = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
  if ((gx - mid[0]) * zx + (gz - mid[1]) * zz < 0) {
    zx = -zx;
    zz = -zz;
  }
  // frameFromAxis takes local +X; local +Z = (−uz, ux) → choose u so that equals (zx, zz).
  const f = frameFromAxis(gx, gz, zz, -zx);
  const loc = fp.map(([x, z]) => toLocal(f, x, z));
  const base = rec.baseElevation;
  const zMax = Math.max(...loc.map((p) => p[1]));
  const zMin = Math.min(...loc.map((p) => p[1]));
  // Tower front = vertices near zMax; facade line = the next band of z.
  const towerPts = loc.filter((p) => p[1] > zMax - 0.8);
  const tX0 = Math.min(...towerPts.map((p) => p[0]));
  const tX1 = Math.max(...towerPts.map((p) => p[0]));
  const facadeZ = Math.max(...loc.filter((p) => p[1] < zMax - 1.5).map((p) => p[1]));
  const tcx = (tX0 + tX1) / 2;
  const tHalfX = Math.max(3.0, (tX1 - tX0) / 2);
  const tFront = zMax;
  // Nave: centred on the tower, 21 m wide, from the north edge to the facade.
  const naveHalf = 10.55;
  const nx0 = tcx - naveHalf;
  const nx1 = tcx + naveHalf;
  const nz0 = zMin;
  const nz1 = facadeZ;
  const ground = (lx: number, lz: number) => {
    const [wx, wz] = [f.cx + lx * f.ux - lz * f.uz, f.cz + lx * f.uz + lz * f.ux];
    return env.ground(wx, wz) - base;
  };
  const Fy = Math.max(0, ground(tcx, tFront + 2) - 0.1); // nave floor = street level on California St
  const eaves = Fy + 9;
  const pitch = THREE.MathUtils.degToRad(35);
  const ridge = eaves + naveHalf * Math.tan(pitch);

  const b = new PartBuilder();
  const add: Add = (k, g, o) => b.add(k, g, o);
  const naveLen = nz1 - nz0;
  const bays = 6;
  const bw = naveLen / bays;
  // ── Side walls with lancets + buttresses ──
  for (const side of ['E', 'W'] as const) {
    const holes: THREE.Path[] = [];
    for (let i = 0; i < bays; i++) {
      // Wall-local x runs along the wall; for 'E' (rotated +90°) local x → −z, so mirror positions.
      const c = -naveLen / 2 + (i + 0.5) * bw;
      holes.push(gothicPath(c, 1.9, Fy + 2.4, Fy + 6.3, 8, 0.85));
    }
    const at = side === 'E' ? nx1 : nx0;
    add('brick', placeWall(wall(-naveLen / 2, naveLen / 2, 0, eaves, 0.6, holes), side, at, (nz0 + nz1) / 2), { color: COL.brick });
    for (let i = 0; i < bays; i++) {
      const c = -naveLen / 2 + (i + 0.5) * bw;
      const glass = new THREE.ShapeGeometry(new THREE.Shape(gothicPath(c, 1.9, Fy + 2.4, Fy + 6.3, 8, 0.85).getPoints()));
      glass.translate(0, 0, -0.35);
      add('glass', placeWall(glass, side, at, (nz0 + nz1) / 2), { glow: 0.7 + 0.3 * ((i * 7) % 3) / 2 });
      // Stone hood moulding over the lancet.
      add('trim', placeWall(box(2.4, 0.22, 0.16, c, Fy + 7.7, 0.08), side, at, (nz0 + nz1) / 2), { color: COL.trim });
      add('trim', placeWall(box(2.2, 0.16, 0.24, c, Fy + 2.25, 0.1), side, at, (nz0 + nz1) / 2), { color: COL.trim });
    }
    for (let i = 0; i <= bays; i++) {
      const c = -naveLen / 2 + i * bw;
      const cc = Math.min(Math.max(c, -naveLen / 2 + 0.5), naveLen / 2 - 0.5);
      add('brick', placeWall(box(0.9, eaves - 1.2, 1.0, cc, 0, 0.5), side, at, (nz0 + nz1) / 2), { color: COL.brick });
      add('trim', placeWall(box(1.0, 0.25, 1.1, cc, eaves - 1.25, 0.5), side, at, (nz0 + nz1) / 2), { color: COL.trim });
      add('trim', placeWall(box(1.0, 0.25, 1.15, cc, Fy + 4.0, 0.52), side, at, (nz0 + nz1) / 2), { color: COL.trim });
    }
  }
  // Base course + eaves cornice around the nave.
  const naveRect: V2[] = [
    [nx0, nz0],
    [nx1, nz0],
    [nx1, nz1],
    [nx0, nz1],
  ];
  add('trim', sweepClosed(naveRect, [[-0.4, -1], [0.18, -1], [0.18, Fy + 0.5], [0.05, Fy + 0.7], [-0.4, Fy + 0.7]]), { color: COL.trim });
  add('trim', sweepClosed(naveRect, [[-0.4, eaves - 0.3], [0.1, eaves - 0.3], [0.35, eaves], [-0.4, eaves]]), { color: COL.trim });
  // Dark interior volume behind the openings.
  add('dark', prism([[nx0 + 0.8, nz0 + 0.8], [nx1 - 0.8, nz0 + 0.8], [nx1 - 0.8, nz1 - 0.8], [nx0 + 0.8, nz1 - 0.8]], 0, eaves - 0.2), { color: COL.dark });

  // ── Gables (north plain with a rose window, south front around the tower) ──
  const gable = (z: number, out: 1 | -1, windows: boolean) => {
    const sh = new THREE.Shape();
    sh.moveTo(nx0 - 0.3, eaves - 0.01);
    sh.lineTo(nx1 + 0.3, eaves - 0.01);
    sh.lineTo(tcx, ridge + 0.4);
    sh.lineTo(nx0 - 0.3, eaves - 0.01);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.6, bevelEnabled: false });
    g.translate(0, 0, out > 0 ? -0.6 : 0);
    g.translate(0, 0, z);
    add('brick', g, { color: COL.brick });
    // Coping along the rakes (stops at the tower walls on the front gable).
    const rakeY = (x: number) => eaves + (ridge + 0.4 - eaves) * (1 - Math.abs(x - tcx) / (naveHalf + 0.3));
    const stop = windows ? 0 : tHalfX;
    for (const s of [-1, 1]) {
      const xa = tcx + s * (naveHalf + 0.3);
      const xb = tcx + s * stop;
      const a = new THREE.Vector3(xa, rakeY(xa) + 0.12, z - out * 0.3);
      const c = new THREE.Vector3(xb, rakeY(xb) + 0.12, z - out * 0.3);
      add('trim', beam(a, c, 0.8, 0.3), { color: COL.trim });
    }
    if (windows) {
      const rose = cyl(1.4, 1.4, 0.1, 20);
      rose.rotateX(Math.PI / 2);
      rose.translate(tcx, eaves + 3.0, z + out * 0.02);
      add('glass', rose, { glow: 0.8 });
    }
  };
  gable(nz0, -1, true);
  gable(nz1, 1, false);
  // Front wall (below the gable) with two side doors / lancets either side of the tower.
  {
    const holes: THREE.Path[] = [];
    const sideX = [(nx0 + tcx - tHalfX) / 2, (tcx + tHalfX + nx1) / 2].map((x) => x - tcx);
    for (const x of sideX) {
      holes.push(gothicPath(x, 1.8, Fy + 0.0, Fy + 2.6, 8, 0.8));
      holes.push(gothicPath(x, 1.7, Fy + 4.4, Fy + 7.0, 8, 0.85));
    }
    add('brick', placeWall(wall(nx0 - tcx, nx1 - tcx, 0, eaves, 0.6, holes), 'S', nz1, tcx), { color: COL.brick });
    for (const x of sideX) {
      const d = new THREE.ShapeGeometry(new THREE.Shape(gothicPath(x, 1.8, Fy, Fy + 2.6, 8, 0.8).getPoints()));
      d.translate(0, 0, -0.4);
      add('door', placeWall(d, 'S', nz1, tcx), { color: '#5a3a24' });
      const w = new THREE.ShapeGeometry(new THREE.Shape(gothicPath(x, 1.7, Fy + 4.4, Fy + 7.0, 8, 0.85).getPoints()));
      w.translate(0, 0, -0.35);
      add('glass', placeWall(w, 'S', nz1, tcx), { glow: 0.9 });
    }
    // Front steps up from the sidewalk.
    add('trim', box(nx1 - nx0, 0.5, 1.6, tcx, Fy - 0.5, nz1 + 0.8), { color: '#9c978c' });
  }
  // Front corner blocks with pinnacles (from the OSM outline corners).
  for (const s of [-1, 1]) {
    const x = s < 0 ? nx0 - 1.3 : nx1 + 1.6;
    const w = s < 0 ? 2.8 : 3.7;
    add('brick', box(w, Fy + 11.2, 4.2, x, 0, nz1 - 2.1), { color: COL.brick });
    add('trim', box(w + 0.3, 0.35, 4.5, x, Fy + 11.2, nz1 - 2.1), { color: COL.trim });
    add('trim', cyl(0.05, 0.5, 2.6, 4, x, Fy + 11.5, nz1 - 2.1), { color: COL.trim });
  }

  // ── Tower ──
  const tz0 = nz1 - 4.0; // tower runs back into the nave
  const tz1 = tFront;
  const tcz = (tz0 + tz1) / 2;
  const tHalfZ = (tz1 - tz0) / 2;
  const top = Fy + 26.6;
  // Shaft walls with openings (entrance, lancet, belfry), stage by stage on the three free faces.
  const towerFace = (side: 'S' | 'N' | 'E' | 'W') => {
    const half = side === 'S' || side === 'N' ? tHalfX : tHalfZ;
    const holes: THREE.Path[] = [];
    if (side === 'S') {
      holes.push(gothicPath(0, 2.6, Fy, Fy + 4.2, 10, 0.8));
      holes.push(gothicPath(0, 1.6, Fy + 7.2, Fy + 11.0, 8, 0.85));
    }
    for (const x of [-half * 0.42, half * 0.42]) holes.push(gothicPath(x, 1.1, Fy + 20.6, Fy + 23.0, 8, 0.85));
    const at = side === 'S' ? tz1 : side === 'N' ? tz0 : side === 'E' ? tcx + tHalfX : tcx - tHalfX;
    const c = side === 'S' || side === 'N' ? tcx : tcz;
    // E/W slabs are shortened at both ends so they butt against the S/N slabs without overlap.
    const shrink = side === 'S' || side === 'N' ? 0 : 0.6;
    const g = wall(-half + shrink, half - shrink, side === 'N' ? Fy + 8 : 0, top, 0.6, holes);
    add('brick', placeWall(g, side, at, c), { color: COL.brick });
    // Louvres in the belfry openings + glass/door fills.
    for (const x of [-half * 0.42, half * 0.42]) {
      const xx = x;
      for (let k = 0; k < 6; k++) add('trim', placeWall(box(1.0, 0.08, 0.3, xx, Fy + 20.9 + k * 0.5, -0.3), side, at, c), { color: '#6b655b' });
      const back = new THREE.ShapeGeometry(new THREE.Shape(gothicPath(xx, 1.1, Fy + 20.6, Fy + 23.0, 8, 0.85).getPoints()));
      back.translate(0, 0, -0.5);
      add('dark', placeWall(back, side, at, c), { color: COL.dark });
    }
    if (side === 'S') {
      const door = new THREE.ShapeGeometry(new THREE.Shape(gothicPath(0, 2.6, Fy, Fy + 4.2, 10, 0.8).getPoints()));
      door.translate(0, 0, -0.45);
      add('door', placeWall(door, 'S', at, c), { color: '#5a3a24' });
      const lan = new THREE.ShapeGeometry(new THREE.Shape(gothicPath(0, 1.6, Fy + 7.2, Fy + 11.0, 8, 0.85).getPoints()));
      lan.translate(0, 0, -0.35);
      add('glass', placeWall(lan, 'S', at, c), { glow: 1 });
    }
  };
  towerFace('S');
  towerFace('N');
  towerFace('E');
  towerFace('W');
  add('dark', box(2 * tHalfX - 1.2, top - 0.5, 2 * tHalfZ - 1.2, tcx, 0, tcz), { color: COL.dark });
  // Corner buttresses (stepped) and string courses.
  for (const sx of [-1, 1]) {
    for (const sz of [1]) {
      const x = tcx + sx * (tHalfX - 0.1);
      const z = tcz + sz * (tHalfZ - 0.1);
      add('brick', box(1.0, Fy + 10, 1.0, x, 0, z), { color: COL.brick });
      add('brick', box(0.75, 8, 0.75, x, Fy + 10, z), { color: COL.brick });
      add('trim', box(1.1, 0.3, 1.1, x, Fy + 10, z), { color: COL.trim });
    }
  }
  const towerRect: V2[] = [
    [tcx - tHalfX, tz0],
    [tcx + tHalfX, tz0],
    [tcx + tHalfX, tz1],
    [tcx - tHalfX, tz1],
  ];
  for (const y of [Fy + 6.6, Fy + 12.2, Fy + 15.0, Fy + 19.9]) add('trim', sweepClosed(towerRect, [[-0.3, y], [0.14, y], [0.2, y + 0.3], [-0.3, y + 0.3]]), { color: COL.trim });
  // Crenellated parapet with corner pinnacles: a separate "crown" group pivoting at the tower top, so an
  // extensive / complete damage state can dislodge or topple it (see onDamage below).
  const bt = new PartBuilder();
  const addTop: Add = (k, g, o) => bt.add(k, g.translate(-tcx, -top, -tcz), o);
  addTop('trim', sweepClosed(towerRect, [[-0.3, top - 0.1], [0.25, top - 0.1], [0.3, top + 0.25], [-0.3, top + 0.25]]), { color: COL.trim });
  const per = (x0: number, z0: number, x1: number, z1: number, n: number) => {
    for (let i = 0; i <= n; i++) {
      if (i % 2) continue;
      const t = i / n;
      addTop('brick', box(0.7, 1.0, 0.7, x0 + (x1 - x0) * t, top + 0.25, z0 + (z1 - z0) * t), { color: COL.brick });
    }
  };
  per(tcx - tHalfX + 0.35, tz1 - 0.35, tcx + tHalfX - 0.35, tz1 - 0.35, 8);
  per(tcx - tHalfX + 0.35, tz0 + 0.35, tcx + tHalfX - 0.35, tz0 + 0.35, 8);
  per(tcx - tHalfX + 0.35, tz0 + 0.35, tcx - tHalfX + 0.35, tz1 - 0.35, 8);
  per(tcx + tHalfX - 0.35, tz0 + 0.35, tcx + tHalfX - 0.35, tz1 - 0.35, 8);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = tcx + sx * (tHalfX - 0.35);
    const z = tcz + sz * (tHalfZ - 0.35);
    addTop('brick', box(0.9, 1.6, 0.9, x, top + 0.25, z), { color: COL.brick });
    addTop('trim', cyl(0.04, 0.55, 2.4, 4, x, top + 1.85, z), { color: COL.trim });
  }
  // Clock dials on S, E, W faces.
  const dialY = Fy + 17.6;
  const dialR = 1.45;
  const dials: { centre: THREE.Vector3; normal: THREE.Vector3; radius: number }[] = [];
  const dialTex = clockDial(256);
  for (const [nxx, nzz, px, pz] of [
    [0, 1, tcx, tz1],
    [1, 0, tcx + tHalfX, tcz],
    [-1, 0, tcx - tHalfX, tcz],
  ] as const) {
    const ring = cyl(dialR + 0.25, dialR + 0.25, 0.14, 32);
    ring.rotateX(Math.PI / 2);
    ring.rotateY(Math.atan2(nxx, nzz));
    ring.translate(px + nxx * 0.07, dialY, pz + nzz * 0.07);
    add('trim', ring, { color: COL.trim, smooth: true });
    const d = new THREE.CircleGeometry(dialR, 32);
    d.rotateY(Math.atan2(nxx, nzz));
    d.translate(px + nxx * 0.15, dialY, pz + nzz * 0.15);
    add('dial', d, { uv: 'keep', glow: 1 });
    dials.push({ centre: new THREE.Vector3(px + nxx * 0.16, dialY, pz + nzz * 0.16), normal: new THREE.Vector3(nxx, 0, nzz), radius: dialR });
  }

  // ── Annex (rectory) and side chapel from the OSM outline ──
  const clip = (poly: V2[], keep: (p: V2) => number): V2[] => {
    const out: V2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const c = poly[(i + 1) % poly.length];
      const da = keep(a);
      const dc = keep(c);
      if (da >= 0) out.push(a);
      if (da >= 0 !== dc >= 0) {
        const t = da / (da - dc);
        out.push([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]);
      }
    }
    return out;
  };
  /** Drop duplicate points and zero-width spikes that half-plane clipping leaves on concave outlines. */
  const despike = (p: V2[]): V2[] => {
    let q = p.slice();
    let changed = true;
    while (changed && q.length > 3) {
      changed = false;
      for (let i = 0; i < q.length; i++) {
        const a = q[(i - 1 + q.length) % q.length];
        const bb = q[i];
        const c = q[(i + 1) % q.length];
        const ux = bb[0] - a[0];
        const uz = bb[1] - a[1];
        const vx = c[0] - bb[0];
        const vz = c[1] - bb[1];
        const dup = Math.hypot(ux, uz) < 0.05;
        const back = Math.abs(ux * vz - uz * vx) < 0.05 * (Math.hypot(ux, uz) + Math.hypot(vx, vz)) && ux * vx + uz * vz < 0;
        if (dup || back) {
          q = q.filter((_, k) => k !== i);
          changed = true;
          break;
        }
      }
    }
    return q;
  };
  const annex = despike(clip(clip(loc, (p) => p[0] - (nx1 + 0.05)), (p) => nz1 - 4.4 - p[1]));
  if (annex.length >= 3 && Math.abs(polyArea(annex)) > 20) {
    const ah = 13;
    add('annexBrick', prism(annex, -0.5, ah), { color: '#ffffff' });
    add('trim', sweepClosed(annex, [[-0.3, ah - 0.4], [0.2, ah - 0.4], [0.3, ah], [-0.3, ah]]), { color: COL.trim });
    for (let i = 0; i < annex.length; i++) {
      const a = annex[i];
      const c = annex[(i + 1) % annex.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 4) continue;
      let onx = (c[1] - a[1]) / len;
      let onz = -(c[0] - a[0]) / len;
      const m: V2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      const ac = centroid(annex);
      if ((m[0] - ac[0]) * onx + (m[1] - ac[1]) * onz < 0) {
        onx = -onx;
        onz = -onz;
      }
      const n = Math.floor(len / 3.2);
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const x = a[0] + (c[0] - a[0]) * t + onx * 0.04;
        const z = a[1] + (c[1] - a[1]) * t + onz * 0.04;
        const g0 = Math.max(0, ground(x, z));
        for (let y = g0 + 1.8; y + 2 < ah - 0.8; y += 3.4) {
          const w = new THREE.PlaneGeometry(1.2, 1.9);
          w.rotateY(Math.atan2(onx, onz));
          w.translate(x, y + 0.95, z);
          add('glass', w, { glow: ((k + Math.round(y)) * 5) % 3 === 0 ? 0.9 : 0.1 });
          const sill = box(1.5, 0.14, 0.3, 0, 0, 0);
          sill.rotateY(Math.atan2(onx, onz));
          sill.translate(x, y - 0.08, z);
          add('trim', sill, { color: COL.trim });
        }
      }
    }
  }
  const chapel = despike(clip(clip(loc, (p) => nx0 - 0.05 - p[0]), (p) => nz1 - 4.5 - p[1]));
  if (chapel.length >= 3 && Math.abs(polyArea(chapel)) > 8) {
    add('brick', prism(chapel, -0.5, Fy + 6), { color: COL.brick });
    add('trim', sweepClosed(chapel, [[-0.3, Fy + 5.7], [0.15, Fy + 5.7], [0.25, Fy + 6.0], [-0.3, Fy + 6.0]]), { color: COL.trim });
  }

  // ── Roof ──
  const roof = new THREE.BufferGeometry();
  const rp: number[] = [];
  const ov = 0.5;
  const L0 = nz0 - 0.3;
  const L1 = nz1 + 0.3;
  const yE = eaves - ov * Math.tan(pitch);
  for (const s of [-1, 1]) {
    const xe = tcx + s * (naveHalf + ov);
    const q = [
      [xe, yE, L0],
      [xe, yE, L1],
      [tcx, ridge, L1],
      [tcx, ridge, L0],
    ];
    const order = s > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const k of order) rp.push(...q[k]);
  }
  roof.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
  add('roof', roof, { color: COL.roof });
  add('trim', box(0.35, 0.35, L1 - L0, tcx, ridge - 0.1, (L0 + L1) / 2), { color: '#47494d' });

  // ── Inscription band under the south dial ──
  const sign = signPanel('SON, OBSERVE THE TIME AND FLY FROM EVIL', { bg: '#1a1a1c', fg: '#efe9da', height: 96, spacing: 0.06, pad: 0.3 });

  const flood = { color: '#ffd8a8', intensity: 0.55, y0: base, y1: base + top + 4, topScale: 1.2 };
  const mats: Record<string, THREE.Material> = {
    brick: lmMaterial({ tex: 'brick', roughness: 1, bump: 1, weather: { baseY: base, grime: 0.25, mottle: 0.1 }, flood }),
    annexBrick: lmMaterial({ tex: 'brick', color: '#d9c7b8', roughness: 1, weather: { baseY: base, grime: 0.2, mottle: 0.1 }, flood: { ...flood, intensity: 0.2 } }),
    trim: lmMaterial({ tex: 'ashlar', roughness: 0.85, bump: 0.4, flood }),
    roof: lmMaterial({ tex: 'slate', roughness: 0.7 }),
    glass: lmMaterial({ color: '#1c1e25', roughness: 0.2, metalness: 0.2, glow: '#ffb46e', glowIntensity: 1.8 }),
    dark: lmMaterial({ color: '#ffffff', roughness: 1 }),
    door: lmMaterial({ tex: 'lacquer', roughness: 0.6 }),
    dial: lmMaterial({ map: dialTex, roughness: 0.4, glow: '#fff1d6', glowIntensity: 1.2, glowAlbedo: true }),
  };
  const model = b.build(mats, 'old_st_marys');
  const crown = bt.build(mats, 'old_st_marys:crown');
  crown.position.set(tcx, top, tcz);
  model.add(crown);
  // Rubble pile on the California St sidewalk where the crown lands (shown once it has fallen).
  const br = new PartBuilder();
  let rs = 7;
  const rr = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
  const yFront = ground(tcx, tz1 + 3);
  for (let i = 0; i < 46; i++) {
    const a = rr() * Math.PI * 2;
    const r = Math.sqrt(rr()) * 5.5;
    const sz = 0.25 + rr() * rr() * 1.0;
    const g = box(sz * (0.8 + rr()), sz * (0.5 + rr() * 0.6), sz * (0.8 + rr()), 0, -sz * 0.25, 0);
    g.rotateY(rr() * Math.PI);
    g.rotateX((rr() - 0.5) * 0.9);
    const px = tcx + Math.cos(a) * r * 1.2;
    const pz = tz1 + 3.6 + Math.sin(a) * r * 0.6;
    // Heap: taller near the middle.
    g.translate(px, ground(px, pz) + (1 - r / 5.5) * 1.1, pz);
    br.add(i % 5 === 0 ? 'trim' : 'brick', g, { color: i % 5 === 0 ? COL.trim : COL.brick });
  }
  const rubble = br.build(mats, 'old_st_marys:rubble');
  rubble.visible = false;
  /** Crown fall clock (s since the crown let go), -1 = intact. */
  let fallT = -1;
  const signMat = lmMaterial({ map: sign.map, glowMask: sign.mask, roughness: 0.6, glow: '#fff4e0', glowIntensity: 1.6, vertexColors: false });
  const sw = 2 * tHalfX - 0.6;
  const sg = new THREE.PlaneGeometry(sw, sw / sign.aspect);
  sg.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(4).fill(1), 1));
  const sm = new THREE.Mesh(sg, signMat);
  sm.position.set(tcx, dialY - dialR - 0.6, tz1 + 0.02);
  model.add(sm);
  const hands = clockHands(dials);
  hands.set(env.ctx.env.timeOfDay);
  model.add(hands.mesh);

  const { pivot, inner } = makePivot('old_st_marys', f, base);
  inner.add(model);
  // The rubble lies on the street: same frame, but outside the pivot that quake FX leans.
  const statics = makePivot('old_st_marys_rubble', f, base).pivot;
  statics.children[0].add(rubble);
  return {
    name: 'old_st_marys',
    pivot,
    buildingIds: [rec.id],
    statics,
    update() {
      hands.set(env.ctx.env.timeOfDay);
    },
    onDamage(d, instant, dt) {
      // Extensive: the crown is dislodged and slumps; complete: it topples onto California St.
      crown.position.set(tcx, top, tcz);
      crown.rotation.set(0, 0, 0);
      crown.visible = true;
      rubble.visible = false;
      if (d < 2.5) {
        fallT = -1;
        return;
      }
      if (d < 3.5) {
        fallT = -1;
        crown.rotation.set(0.05, 0, -0.07);
        crown.position.y -= 0.3;
        return;
      }
      const T = Math.sqrt((2 * (top - yFront + 1)) / 9.81); // free-fall time to the street
      fallT = instant ? T + 1 : Math.max(fallT, 0) + dt;
      const t = Math.min(fallT, T);
      crown.position.y = top - 0.5 * 9.81 * t * t;
      crown.position.z = tcz + 2.6 * t;
      crown.rotation.set(0.75 * t, 0, -0.12 * t);
      if (fallT >= T) {
        crown.visible = false;
        rubble.visible = true;
      }
    },
  };
}

function polyArea(p: V2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return a / 2;
}
