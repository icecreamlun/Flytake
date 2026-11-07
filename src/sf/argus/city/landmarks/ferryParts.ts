/**
 * Ferry Building architectural kit (shared by the main building and the Ferry Station Post Office annex):
 * storey levels, palette, two-storey arcaded facade runs, balustrades, cornices, hipped roofs, urns.
 */
import * as THREE from 'three';
import { archPath, archivolt, box, cyl, lathe, sweepClosed, wall, type V2 } from './common/geom';

export const COL = {
  stone: '#d6cbb3',
  trim: '#e6dcc8',
  rustic: '#c9bc9f',
  granite: '#8f8a80',
  roof: '#6a6660',
  dark: '#2a2622',
};

// Storey levels (m above the base).
export const Y = {
  plinth: 0.6,
  lowerTop: 7.4,
  string: 8.2,
  upperTop: 13.6,
  cornice: 14.6,
  rail: 15.7,
  attic: 17.6,
};

export type Add = (key: string, g: THREE.BufferGeometry, o?: { color?: THREE.ColorRepresentation; glow?: number; uv?: 'box' | 'keep' }) => void;

/** Matrix taking a facade frame (x along the run, y up, +z outward, front face at z = 0) into the local frame. */
export function runMatrix(p0: V2, p1: V2, out: V2): { m: THREE.Matrix4; len: number } {
  let a = p0;
  let b = p1;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let ux = (b[0] - a[0]) / len;
  let uz = (b[1] - a[1]) / len;
  // x × y = (-uz, 0, ux) must point outward.
  if (-uz * out[0] + ux * out[1] < 0) {
    [a, b] = [b, a];
    ux = -ux;
    uz = -uz;
  }
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(ux, 0, uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-uz, 0, ux));
  m.setPosition(a[0], 0, a[1]);
  return { m, len };
}

export interface RunOpts {
  bays: number;
  grand?: number[];
}

/** One straight two-storey arcaded run. */
let occSeed = 1;
/** Deterministic pseudo-random 0..1 for window occupancy. */
function occ(): number {
  occSeed = (occSeed * 16807) % 2147483647;
  return occSeed / 2147483647;
}

export function addRun(add: Add, p0: V2, p1: V2, out: V2, o: RunOpts): void {
  const { m, len } = runMatrix(p0, p1, out);
  const put = (key: string, g: THREE.BufferGeometry, opts?: Parameters<Add>[2]) => {
    g.applyMatrix4(m);
    add(key, g, opts);
  };
  const bw = len / o.bays;
  const grand = new Set(o.grand ?? []);
  const lowerHoles: THREE.Path[] = [];
  const upperHoles: THREE.Path[] = [];
  for (let i = 0; i < o.bays; i++) {
    const cx = (i + 0.5) * bw;
    const g = grand.has(i);
    // Ground floor arch.
    const w = Math.min(g ? 0.74 * bw : 0.58 * bw, g ? 5.2 : 4.0);
    const ys = g ? 4.8 : 4.5;
    const r = w / 2;
    lowerHoles.push(archPath(cx, w, Y.plinth, ys, 12));
    const glassShape = new THREE.Shape(archPath(cx, w, Y.plinth, ys, 12).getPoints());
    const glass = new THREE.ShapeGeometry(glassShape);
    glass.translate(0, 0, -0.55);
    put('glass', glass, { glow: 0.45 + 0.55 * occ() });
    // Transom bar + door frame in the arch.
    put('bronze', box(w, 0.16, 0.12, cx, ys - 0.25, -0.5));
    put('bronze', box(0.12, ys - 0.25 - Y.plinth, 0.12, cx, Y.plinth, -0.5));
    // Archivolt + keystone.
    put('trim', archivolt(cx, ys, r, r + 0.34, 0.12, 14), { color: COL.trim });
    put('trim', box(0.55, 0.85, 0.22, cx, ys + r - 0.1, 0.0), { color: COL.trim });
    // Upper arched window.
    const uw = Math.min(0.46 * bw, 3.0) * (g ? 1.1 : 1);
    const uys = 11.3;
    const ur = uw / 2;
    upperHoles.push(archPath(cx, uw, 8.9, uys, 12));
    const ug = new THREE.ShapeGeometry(new THREE.Shape(archPath(cx, uw, 8.9, uys, 12).getPoints()));
    ug.translate(0, 0, -0.4);
    const ro = occ();
    put('glass', ug, { glow: ro < 0.3 ? 0.06 : 0.35 + 0.65 * ro });
    put('trim', archivolt(cx, uys, ur, ur + 0.22, 0.09, 12), { color: COL.trim });
    put('trim', box(0.42, 0.62, 0.16, cx, uys + ur - 0.08, 0.0), { color: COL.trim });
    put('trim', box(uw + 0.6, 0.16, 0.3, cx, 8.74, 0.15), { color: COL.trim }); // sill
    put('trim', box(uw + 0.3, 0.5, 0.12, cx, 8.24, 0.06), { color: COL.trim }); // apron
  }
  // Wall slabs with real openings (deep reveals).
  put('rustic', wall(0, len, Y.plinth, Y.lowerTop, 0.9, lowerHoles), { color: COL.rustic });
  put('stone', wall(0, len, Y.string, Y.upperTop, 0.7, upperHoles), { color: COL.stone });
  // Fill strip behind the string course and base under the plinth sweep.
  put('stone', box(len, Y.string - Y.lowerTop, 0.9, len / 2, Y.lowerTop, -0.45), { color: COL.stone });
  // Pilasters, bases and capitals on the upper storey; impost bands on the ground floor piers.
  for (let k = 0; k <= o.bays; k++) {
    const x = Math.min(Math.max(k * bw, 0.45), len - 0.45);
    put('stone', box(0.8, Y.upperTop - Y.string - 0.6, 0.2, x, Y.string + 0.3, 0.1), { color: COL.trim });
    put('trim', box(0.98, 0.3, 0.34, x, Y.string, 0.17), { color: COL.trim });
    put('trim', box(1.05, 0.42, 0.36, x, Y.upperTop - 0.42, 0.18), { color: COL.trim });
    put('trim', box(Math.min(bw * 0.42, 1.6), 0.28, 0.14, x, 4.36, 0.07), { color: COL.trim });
  }
}

/** Balustrade along a straight edge: plinth rail, square-ish balusters, top rail, dies every `dieEvery` m. */
export function addBalustrade(add: Add, p0: V2, p1: V2, out: V2, y0: number, dieEvery = 6.5): void {
  const { m, len } = runMatrix(p0, p1, out);
  const put = (g: THREE.BufferGeometry) => {
    g.applyMatrix4(m);
    add('trim', g, { color: COL.trim });
  };
  put(box(len, 0.2, 0.62, len / 2, y0, 0.0));
  put(box(len, 0.2, 0.7, len / 2, y0 + 0.85, 0.0));
  const dies = Math.max(1, Math.round(len / dieEvery));
  const dw = len / dies;
  for (let k = 0; k <= dies; k++) put(box(0.62, 1.12, 0.62, Math.min(Math.max(k * dw, 0.31), len - 0.31), y0, 0.0));
  const bal = cyl(0.08, 0.11, 0.65, 4, 0, 0, 0, true);
  bal.rotateY(Math.PI / 4);
  for (let k = 0; k < dies; k++) {
    const a = k * dw + 0.55;
    const b = (k + 1) * dw - 0.55;
    const n = Math.max(1, Math.floor((b - a) / 0.3));
    for (let i = 0; i <= n; i++) {
      const g = bal.clone();
      g.translate(a + ((b - a) * i) / n, y0 + 0.2, 0);
      put(g);
    }
  }
}

/** Hipped roof over an axis-aligned rectangle (inset inside the parapet). */
export function hipRoof(hx: number, hz: number, y0: number, pitch: number): THREE.BufferGeometry {
  const rise = hz * Math.tan(pitch);
  const r0 = -hx + hz;
  const r1 = hx - hz;
  const P = (x: number, y: number, z: number) => [x, y, z];
  const A = P(-hx, y0, -hz);
  const B = P(hx, y0, -hz);
  const Cc = P(hx, y0, hz);
  const D = P(-hx, y0, hz);
  const R0 = P(r0, y0 + rise, 0);
  const R1 = P(r1, y0 + rise, 0);
  const tri = (...v: number[][]) => v.flat();
  const pos = [
    ...tri(A, R1, B), ...tri(A, R0, R1), // north (−z) slope
    ...tri(D, Cc, R1), ...tri(D, R1, R0), // south (+z) slope
    ...tri(A, D, R0), // west hip
    ...tri(B, R1, Cc), // east hip
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Ensure outward (upward) facing triangles.
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < p.count; t += 3) {
    a.fromBufferAttribute(p, t);
    b.fromBufferAttribute(p, t + 1);
    c.fromBufferAttribute(p, t + 2);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    if (n.y < 0) {
      p.setXYZ(t + 1, c.x, c.y, c.z);
      p.setXYZ(t + 2, b.x, b.y, b.z);
    }
  }
  return g;
}

/** Hollow square stage with `n` arches per face, engaged columns, and a dark core behind the openings. */
export function arcadedStage(add: Add, cx: number, cz: number, half: number, y0: number, y1: number, n: number, archW: number, ys: number, t = 0.65): void {
  const side = 2 * half;
  const holes = () => {
    const hs: THREE.Path[] = [];
    for (let i = 0; i < n; i++) hs.push(archPath(-half + ((i + 0.5) * side) / n, archW, y0 + 0.5, ys, 10));
    return hs;
  };
  const faces: { ry: number; ox: number; oz: number }[] = [
    { ry: 0, ox: 0, oz: half },
    { ry: Math.PI / 2, ox: half, oz: 0 },
    { ry: Math.PI, ox: 0, oz: -half },
    { ry: -Math.PI / 2, ox: -half, oz: 0 },
  ];
  faces.forEach((f, k) => {
    // Front/back slabs full width; side slabs shortened so corners don't overlap.
    const shrink = k % 2 === 1 ? t : 0;
    const w = wall(-half + shrink, half - shrink, y0, y1, t, holes());
    w.rotateY(f.ry);
    w.translate(cx + f.ox, 0, cz + f.oz);
    add('stone', w, { color: COL.stone });
    for (let i = 0; i <= n; i++) {
      const x = -half + (i * side) / n;
      const xc = Math.min(Math.max(x, -half + 0.35), half - 0.35);
      const col = cyl(0.16, 0.19, ys - y0 - 0.7, 8, xc, y0 + 0.6, 0.22);
      col.rotateY(f.ry);
      col.translate(cx + f.ox * 1.0, 0, cz + f.oz * 1.0);
      add('trim', col, { color: COL.trim });
      const capital = box(0.55, 0.3, 0.55, xc, ys - 0.12, 0.22);
      capital.rotateY(f.ry);
      capital.translate(cx + f.ox, 0, cz + f.oz);
      add('trim', capital, { color: COL.trim });
    }
    for (let i = 0; i < n; i++) {
      const ax = -half + ((i + 0.5) * side) / n;
      const av = archivolt(ax, ys, archW / 2, archW / 2 + 0.16, 0.08, 10);
      av.rotateY(f.ry);
      av.translate(cx + f.ox, 0, cz + f.oz);
      add('trim', av, { color: COL.trim });
    }
  });
  add('dark', box(side - 2 * t - 1.2, y1 - y0 - 0.2, side - 2 * t - 1.2, cx, y0 + 0.1, cz), { color: COL.dark });
}

export function cornice(add: Add, poly: V2[], y: number, proj: number, h = 0.8): void {
  const p: V2[] = [
    [-0.4, 0],
    [0.05, 0],
    [0.08, h * 0.15],
    [proj * 0.35, h * 0.35],
    [proj * 0.85, h * 0.62],
    [proj, h * 0.7],
    [proj, h],
    [-0.4, h],
    [-0.4, 0],
  ];
  add('trim', sweepClosed(poly, p, y), { color: COL.trim });
}

export function balustradeRing(add: Add, half: number, cx: number, cz: number, y0: number, dieEvery: number): void {
  const c: V2[] = [
    [cx - half, cz - half],
    [cx + half, cz - half],
    [cx + half, cz + half],
    [cx - half, cz + half],
  ];
  const outs: V2[] = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  for (let i = 0; i < 4; i++) addBalustrade(add, c[i], c[(i + 1) % 4], outs[i], y0, dieEvery);
}

export function urn(add: Add, x: number, y0: number, z: number, s = 1): void {
  const g = lathe(
    [
      [0.35 * s, 0],
      [0.35 * s, 0.18 * s],
      [0.14 * s, 0.3 * s],
      [0.32 * s, 0.6 * s],
      [0.36 * s, 0.85 * s],
      [0.18 * s, 1.1 * s],
      [0.22 * s, 1.2 * s],
      [0.05 * s, 1.55 * s],
      [0.0, 1.6 * s],
    ],
    10,
    x,
    y0,
    z,
  );
  add('trim', g, { color: COL.trim });
}

