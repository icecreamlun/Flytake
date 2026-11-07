/**
 * Sentinel Building / Columbus Tower (1907), Columbus Ave & Kearny St: the copper-clad flatiron with
 * its verdigris facades, cream window surrounds, a granite-and-glass storefront base (Café Zoetrope),
 * heavy cornice, and the round turret at the north tip crowned by a copper dome. Built on the OSM
 * footprint (main outline + the round cupola part).
 */
import * as THREE from 'three';
import type { XZ } from '../../contracts';
import { PartBuilder } from './common/builder';
import { box, cyl, lathe, prism, rectPath, sphere, sweepClosed, wall, type V2 } from './common/geom';
import { lmMaterial } from './common/materials';
import { centroid, frameFromAxis, makePivot, toLocal } from './common/frame';
import type { LandmarkBuild, LandmarkEnv } from './common/types';

const COL = {
  copper: '#dfe6e2',
  cream: '#e9e1cb',
  granite: '#7d776d',
  stucco: '#c9bfae',
};

const FL = { ground: 4.6, floor: 3.35, floors: 6 };
const CORNICE = FL.ground + FL.floor * FL.floors; // 24.7

type Add = (key: string, g: THREE.BufferGeometry, o?: { color?: THREE.ColorRepresentation; glow?: number; smooth?: boolean }) => void;

function runMatrix(p0: V2, p1: V2, out: V2): { m: THREE.Matrix4; len: number } {
  let a = p0;
  let b = p1;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let ux = (b[0] - a[0]) / len;
  let uz = (b[1] - a[1]) / len;
  if (-uz * out[0] + ux * out[1] < 0) {
    [a, b] = [b, a];
    ux = -ux;
    uz = -uz;
  }
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(ux, 0, uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-uz, 0, ux));
  m.setPosition(a[0], 0, a[1]);
  return { m, len };
}

/** A copper street facade: storefront below, `bays` window pairs per floor above. */
function facade(add: Add, p0: V2, p1: V2, out: V2, bays: number, glowSeed: number): void {
  const { m, len } = runMatrix(p0, p1, out);
  const put = (key: string, g: THREE.BufferGeometry, o?: Parameters<Add>[2]) => {
    g.applyMatrix4(m);
    add(key, g, o);
  };
  const bw = len / bays;
  const holes: THREE.Path[] = [];
  let seed = glowSeed;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let f = 0; f < FL.floors; f++) {
    const y0 = FL.ground + f * FL.floor + 0.75;
    const h = FL.floor - 1.25;
    for (let i = 0; i < bays; i++) {
      const cx = (i + 0.5) * bw;
      for (const dx of [-0.36, 0.36]) {
        const x = cx + dx * bw * 0.62;
        const w = bw * 0.27;
        holes.push(rectPath(x, w, y0, h));
        const glass = new THREE.PlaneGeometry(w, h);
        glass.translate(x, y0 + h / 2, -0.22);
        const lit = rnd();
        put('glass', glass, { glow: lit < 0.45 ? 0.05 : 0.4 + 0.6 * lit });
        put('cream', box(w + 0.24, 0.16, 0.2, x, y0 - 0.16, 0.06), { color: COL.cream }); // sill
        put('cream', box(w + 0.3, 0.22, 0.14, x, y0 + h, 0.05), { color: COL.cream }); // head
        put('cream', box(0.07, h, 0.08, x, y0, -0.18), { color: COL.cream }); // mullion
      }
      // Spandrel panel between floors.
      if (f < FL.floors - 1) put('copper', box(bw * 0.78, 0.5, 0.08, cx, y0 + h + 0.3, 0.04), { color: '#cdd8d3' });
    }
    // Belt course.
    put('cream', box(len, 0.14, 0.1, len / 2, FL.ground + f * FL.floor, 0.05), { color: COL.cream });
  }
  // Pilasters between bays.
  for (let i = 0; i <= bays; i++) put('copper', box(0.42, CORNICE - FL.ground, 0.16, Math.min(Math.max(i * bw, 0.21), len - 0.21), FL.ground, 0.08), { color: '#d2dcd7' });
  put('copper', wall(0, len, FL.ground, CORNICE, 0.35, holes), { color: COL.copper });
  // Storefront: granite piers + tall glass + transom band.
  const piers = Math.max(2, Math.round(len / 3.2));
  for (let i = 0; i <= piers; i++) put('granite', box(0.6, FL.ground, 0.5, Math.min(Math.max((i * len) / piers, 0.3), len - 0.3), 0, -0.1), { color: COL.granite });
  const sf = new THREE.PlaneGeometry(len, FL.ground - 1.2);
  sf.translate(len / 2, 0.5 + (FL.ground - 1.2) / 2, -0.28);
  put('glass', sf, { glow: 0.9 });
  put('granite', box(len, 0.5, 0.4, len / 2, 0, -0.15), { color: COL.granite });
  put('copper', box(len, 0.7, 0.3, len / 2, FL.ground - 0.7, -0.1), { color: COL.copper });
}

export function buildSentinel(env: LandmarkEnv): LandmarkBuild | null {
  const recs = env.byLandmark('sentinel_building');
  if (!recs.length) return null;
  const main = recs.find((r) => !r.isPart) ?? recs[0];
  const cup = recs.find((r) => r !== main);
  const base = Math.min(...recs.map((r) => r.baseElevation));
  const [cx, cz] = centroid(main.footprint);
  const f = frameFromAxis(cx, cz, 1, 0);
  const L = (p: XZ): V2 => toLocal(f, p[0], p[1]);
  const fp = main.footprint.map(L);
  // Turret: the round cupola part (fallback: the footprint vertex farthest from the centroid).
  let tc: V2;
  let tr: number;
  if (cup) {
    const c = L(centroid(cup.footprint));
    tc = c;
    tr = Math.max(...cup.footprint.map((p) => Math.hypot(L(p)[0] - c[0], L(p)[1] - c[1])));
  } else {
    tc = fp.reduce((a, b) => (Math.hypot(b[0], b[1]) > Math.hypot(a[0], a[1]) ? b : a));
    tr = 2.4;
  }
  tr = Math.min(Math.max(tr, 2.0), 3.0) + 0.15;
  // Three corners of the flatiron: the two far from the turret are the rear corners; the street sides
  // run from them to the turret.
  const far = [...fp].sort((a, b) => Math.hypot(b[0] - tc[0], b[1] - tc[1]) - Math.hypot(a[0] - tc[0], a[1] - tc[1]));
  const rA = far[0];
  const rB = far.find((p) => Math.hypot(p[0] - rA[0], p[1] - rA[1]) > 5) ?? far[1];
  // End points of the street facades where they meet the turret.
  const toward = (p: V2): V2 => {
    const dx = tc[0] - p[0];
    const dz = tc[1] - p[1];
    const d = Math.hypot(dx, dz);
    const k = (d - tr * 0.85) / d;
    return [p[0] + dx * k, p[1] + dz * k];
  };
  const eA = toward(rA);
  const eB = toward(rB);
  const outOf = (a: V2, b: V2, other: V2): V2 => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz);
    let n: V2 = [dz / l, -dx / l];
    if ((other[0] - a[0]) * n[0] + (other[1] - a[1]) * n[1] > 0) n = [-n[0], -n[1]];
    return n;
  };

  const b = new PartBuilder();
  const add: Add = (k, g, o) => b.add(k, g, o);
  const lenA = Math.hypot(eA[0] - rA[0], eA[1] - rA[1]);
  const lenB = Math.hypot(eB[0] - rB[0], eB[1] - rB[1]);
  facade(add, rA, eA, outOf(rA, eA, rB), Math.max(2, Math.round(lenA / 4)), 7);
  facade(add, rB, eB, outOf(rB, eB, rA), Math.max(2, Math.round(lenB / 4)), 13);
  // Rear party wall (plain stucco / brick).
  const nR = outOf(rA, rB, tc);
  const rr = runMatrix(rA, rB, nR);
  const rear = box(rr.len, CORNICE + 1.6, 0.4, rr.len / 2, -0.5, -0.2);
  rear.applyMatrix4(rr.m);
  add('stucco', rear, { color: COL.stucco });
  // Core volume (inset so it never shows through the window openings).
  const inset = (p: V2): V2 => {
    const g = centroid([rA, rB, tc] as XZ[]);
    return [g[0] + (p[0] - g[0]) * 0.86, g[1] + (p[1] - g[1]) * 0.86];
  };
  add('stucco', prism([inset(rA), inset(rB), inset(eB), inset(eA)], -0.5, CORNICE + 0.6), { color: '#3a3833' });
  // Roof slab and cornice around the triangle.
  const outline: V2[] = [rA, rB, eB, eA];
  add(
    'copper',
    sweepClosed(
      outline,
      [
        [-0.3, CORNICE],
        [0.12, CORNICE],
        [0.2, CORNICE + 0.25],
        [0.7, CORNICE + 0.6],
        [0.75, CORNICE + 0.85],
        [-0.3, CORNICE + 0.85],
      ],
    ),
    { color: '#c9d4cf' },
  );
  add('copper', sweepClosed(outline, [[-0.25, CORNICE + 0.85], [0.08, CORNICE + 0.85], [0.08, CORNICE + 1.65], [-0.25, CORNICE + 1.65]]), { color: COL.copper });
  add('stucco', prism(outline, CORNICE + 0.6, CORNICE + 0.9), { color: '#5b5751' });

  // ── Turret ──
  const [tx, tz] = tc;
  add('granite', cyl(tr + 0.1, tr + 0.1, FL.ground, 24, tx, -0.5, tz), { color: COL.granite, smooth: true });
  add('copper', cyl(tr, tr, CORNICE - FL.ground, 24, tx, FL.ground, tz), { color: COL.copper, smooth: true });
  // Storefront glazing around the turret's granite base (Café Zoetrope corner).
  for (const da of [-0.9, -0.3, 0.3, 0.9]) {
    const a = Math.atan2(tz - (fp[0][1] + fp[1][1]) / 2, tx - (fp[0][0] + fp[1][0]) / 2) + da;
    const g = box(1.25, FL.ground - 1.3, 0.12, 0, 0.6, 0);
    g.rotateY(-a + Math.PI / 2);
    g.translate(tx + Math.cos(a) * (tr + 0.12), 0, tz + Math.sin(a) * (tr + 0.12));
    add('glass', g, { glow: 0.9 });
  }
  const outDir = Math.atan2(tz - (rA[1] + rB[1]) / 2, tx - (rA[0] + rB[0]) / 2);
  for (let fl = 0; fl < FL.floors; fl++) {
    const y0 = FL.ground + fl * FL.floor + 0.75;
    const h = FL.floor - 1.25;
    for (const da of [-0.75, 0, 0.75]) {
      const a = outDir + da;
      const g = box(0.95, h, 0.12, 0, y0, 0);
      g.rotateY(-a + Math.PI / 2);
      g.translate(tx + Math.cos(a) * (tr + 0.0), 0, tz + Math.sin(a) * (tr + 0.0));
      add('glass', g, { glow: (fl + da * 3) % 2 > 0.5 ? 0.9 : 0.15 });
      const fr = box(1.25, 0.18, 0.2, 0, y0 + h, 0);
      fr.rotateY(-a + Math.PI / 2);
      fr.translate(tx + Math.cos(a) * tr, 0, tz + Math.sin(a) * tr);
      add('cream', fr, { color: COL.cream });
    }
    add('cream', cyl(tr + 0.08, tr + 0.08, 0.14, 24, tx, FL.ground + fl * FL.floor, tz), { color: COL.cream, smooth: true });
  }
  // Crown: cornice ring, drum with round windows, copper dome and finial.
  add(
    'copper',
    lathe(
      [
        [tr, 0],
        [tr + 0.25, 0.3],
        [tr + 0.7, 0.75],
        [tr + 0.7, 0.95],
        [tr - 0.05, 1.0],
      ],
      24,
      tx,
      CORNICE,
      tz,
    ),
    { color: '#c9d4cf', smooth: true },
  );
  add('copper', cyl(tr - 0.15, tr - 0.1, 2.6, 24, tx, CORNICE + 1.0, tz), { color: COL.copper, smooth: true });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const g = cyl(0.42, 0.42, 0.1, 12);
    g.rotateX(Math.PI / 2);
    g.rotateY(-a + Math.PI / 2);
    g.translate(tx + Math.cos(a) * (tr - 0.1), CORNICE + 2.3, tz + Math.sin(a) * (tr - 0.1));
    add('glass', g, { glow: 0.8 });
  }
  add('cream', cyl(tr + 0.15, tr + 0.15, 0.25, 24, tx, CORNICE + 3.6, tz), { color: COL.cream, smooth: true });
  add(
    'dome',
    lathe(
      [
        [tr + 0.05, 0],
        [tr - 0.05, 0.6],
        [tr * 0.8, 1.5],
        [tr * 0.5, 2.25],
        [0.35, 2.7],
        [0.2, 2.9],
      ],
      24,
      tx,
      CORNICE + 3.85,
      tz,
    ),
    { color: '#eef4f1', smooth: true },
  );
  add('cream', cyl(0.18, 0.25, 0.7, 10, tx, CORNICE + 6.75, tz), { color: COL.cream });
  add('gold', sphere(0.2, tx, CORNICE + 7.6, tz, 10, 8), { color: '#ffffff', smooth: true });
  add('dark', cyl(0.03, 0.04, 1.4, 6, tx, CORNICE + 7.8, tz), { color: '#333' });

  const y0 = base;
  const mats: Record<string, THREE.Material> = {
    copper: lmMaterial({ tex: 'copper', roughness: 1, metalness: 0.15, weather: { baseY: y0, grime: 0.2, mottle: 0.12 }, flood: { color: '#ffe0b0', intensity: 0.35, y0, y1: y0 + 33, topScale: 1.3, stage: 0 } }),
    dome: lmMaterial({ tex: 'copper', roughness: 1, metalness: 0.2, flood: { color: '#ffe0b0', intensity: 0.5, y0, y1: y0 + 33, topScale: 1.3 } }),
    cream: lmMaterial({ tex: 'ashlar', roughness: 0.8, bump: 0.3, flood: { color: '#ffe0b0', intensity: 0.4, y0, y1: y0 + 33, topScale: 1.2 } }),
    granite: lmMaterial({ tex: 'concrete', roughness: 0.6, weather: { baseY: y0, grime: 0.3, mottle: 0.1 } }),
    stucco: lmMaterial({ tex: 'concrete', roughness: 0.9 }),
    glass: lmMaterial({ tex: 'curtain', metalness: 0.4, glow: '#ffcf96', glowIntensity: 2.2 }),
    gold: lmMaterial({ color: '#d4a640', roughness: 0.3, metalness: 1 }),
    dark: lmMaterial({ color: '#ffffff', roughness: 0.8 }),
  };
  const model = b.build(mats, 'sentinel');
  const { pivot, inner } = makePivot('sentinel_building', f, base);
  inner.add(model);
  return { name: 'sentinel_building', pivot, buildingIds: recs.map((r) => r.id) };
}
