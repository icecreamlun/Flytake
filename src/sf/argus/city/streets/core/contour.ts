/**
 * Marching squares (iso 0.5) on a scalar field → closed, oriented loops, plus polyline utilities.
 * Loops are oriented with the inside (value ≥ iso) on the map-left of the walking direction, where
 * left of (dx, dz) is (dz, -dx). With that convention outer boundaries have NEGATIVE shoelace area
 * (Σ x_i z_{i+1} − x_{i+1} z_i) and holes positive.
 */

/** Directed segments per case as [fromEdge, toEdge] with edges 0=T 1=R 2=B 3=L. Saddles handled separately. */
const TABLE: number[][] = [
  [],
  [3, 0],
  [0, 1],
  [3, 1],
  [1, 2],
  [], // saddle
  [0, 2],
  [3, 2],
  [2, 3],
  [2, 0],
  [], // saddle
  [2, 1],
  [1, 3],
  [1, 0],
  [0, 3],
  [],
];

let nextBuf: Int32Array | null = null;

/**
 * field: w*h samples; sample (i,j) sits at world (ox + i*res, oz + j*res).
 * Returns loops as flat [x0,z0,x1,z1,...] arrays (not closed).
 */
export function marchingSquares(field: Float32Array, w: number, h: number, ox: number, oz: number, res: number, iso = 0.5): number[][] {
  const N = w * h * 2;
  if (!nextBuf || nextBuf.length < N) nextBuf = new Int32Array(N);
  const next = nextBuf;
  next.fill(-1, 0, N);
  const starts: number[] = [];
  const eH = (i: number, j: number) => (j * w + i) * 2;
  const eV = (i: number, j: number) => (j * w + i) * 2 + 1;
  const link = (a: number, b: number) => {
    next[a] = b;
    starts.push(a);
  };
  for (let j = 0; j < h - 1; j++) {
    const row = j * w;
    for (let i = 0; i < w - 1; i++) {
      const f0 = field[row + i];
      const f1 = field[row + i + 1];
      const f2 = field[row + w + i + 1];
      const f3 = field[row + w + i];
      const c = (f0 >= iso ? 1 : 0) | (f1 >= iso ? 2 : 0) | (f2 >= iso ? 4 : 0) | (f3 >= iso ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const E = [eH(i, j), eV(i + 1, j), eH(i, j + 1), eV(i, j)];
      if (c === 5 || c === 10) {
        const centre = (f0 + f1 + f2 + f3) * 0.25 >= iso;
        if (c === 5) {
          if (centre) {
            link(E[1], E[0]);
            link(E[3], E[2]);
          } else {
            link(E[3], E[0]);
            link(E[1], E[2]);
          }
        } else if (centre) {
          link(E[0], E[3]);
          link(E[2], E[1]);
        } else {
          link(E[0], E[1]);
          link(E[2], E[3]);
        }
        continue;
      }
      const seg = TABLE[c];
      link(E[seg[0]], E[seg[1]]);
    }
  }
  // Crossing position on an edge.
  const pos = (e: number, out: number[]) => {
    const k = e >> 1;
    const i = k % w;
    const j = (k / w) | 0;
    const a = field[k];
    if ((e & 1) === 0) {
      const b = field[k + 1];
      const t = (iso - a) / (b - a);
      out.push(ox + (i + t) * res, oz + j * res);
    } else {
      const b = field[k + w];
      const t = (iso - a) / (b - a);
      out.push(ox + i * res, oz + (j + t) * res);
    }
  };
  const loops: number[][] = [];
  for (const s of starts) {
    if (next[s] < 0) continue;
    const loop: number[] = [];
    let e = s;
    let guard = 0;
    while (e >= 0 && next[e] >= 0 && guard++ < 4_000_000) {
      pos(e, loop);
      const n = next[e];
      next[e] = -1;
      e = n;
      if (e === s) break;
    }
    if (loop.length >= 6) loops.push(loop);
  }
  return loops;
}

/** Shoelace Σ x_i z_{i+1} − x_{i+1} z_i (×0.5). */
export function ringArea(r: number[]): number {
  let a = 0;
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a * 0.5;
}

/** Douglas–Peucker on a closed ring. */
export function simplifyRing(r: number[], tol: number): number[] {
  const n = r.length / 2;
  if (n <= 4) return r;
  // Split at vertex 0 and the vertex farthest from it.
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = (r[i * 2] - r[0]) ** 2 + (r[i * 2 + 1] - r[1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const tol2 = tol * tol;
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = r[a * 2];
    const az = r[a * 2 + 1];
    const bi = b % n;
    const bx = r[bi * 2];
    const bz = r[bi * 2 + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const L2 = dx * dx + dz * dz || 1e-12;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = r[i * 2] - ax;
      const pz = r[i * 2 + 1] - az;
      const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / L2));
      const d = (px - dx * t) ** 2 + (pz - dz * t) ** 2;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[i * 2], r[i * 2 + 1]);
  return out;
}

/** Insert the points where a closed ring crosses the lines x = gx0 + k*cs and z = gz0 + k*cs. */
export function densifyOnGrid(r: number[], gx0: number, gz0: number, cs: number): number[] {
  const out: number[] = [];
  const n = r.length / 2;
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const ax = r[i * 2];
    const az = r[i * 2 + 1];
    const j = (i + 1) % n;
    const bx = r[j * 2];
    const bz = r[j * 2 + 1];
    out.push(ax, az);
    ts.length = 0;
    const kx0 = Math.floor((Math.min(ax, bx) - gx0) / cs) + 1;
    const kx1 = Math.ceil((Math.max(ax, bx) - gx0) / cs) - 1;
    for (let k = kx0; k <= kx1; k++) {
      const t = (gx0 + k * cs - ax) / (bx - ax);
      if (t > 1e-6 && t < 1 - 1e-6) ts.push(t);
    }
    const kz0 = Math.floor((Math.min(az, bz) - gz0) / cs) + 1;
    const kz1 = Math.ceil((Math.max(az, bz) - gz0) / cs) - 1;
    for (let k = kz0; k <= kz1; k++) {
      const t = (gz0 + k * cs - az) / (bz - az);
      if (t > 1e-6 && t < 1 - 1e-6) ts.push(t);
    }
    if (ts.length) {
      ts.sort((p, q) => p - q);
      let last = -1;
      for (const t of ts) {
        if (t - last < 1e-5) continue;
        last = t;
        out.push(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    }
  }
  return out;
}

/** Ray-casting point-in-ring test. */
export function pointInRing(r: number[], x: number, z: number): boolean {
  let inside = false;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = r[i];
    const zi = r[i + 1];
    const xj = r[j];
    const zj = r[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function ringBBox(r: number[]): [number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    const x = r[i];
    const z = r[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}

/**
 * Laplacian smoothing of a closed ring (removes raster staircase noise). Vertices for which pinned(x,z) is true
 * (e.g. on a tile border) stay put so neighbouring tiles still meet exactly.
 */
export function smoothRing(r: number[], iterations: number, pinned: (x: number, z: number) => boolean): number[] {
  const n = r.length / 2;
  if (n < 5) return r;
  let a = r.slice();
  const pin = new Uint8Array(n);
  for (let i = 0; i < n; i++) pin[i] = pinned(r[i * 2], r[i * 2 + 1]) ? 1 : 0;
  for (let it = 0; it < iterations; it++) {
    const b = a.slice();
    for (let i = 0; i < n; i++) {
      if (pin[i]) continue;
      const ip = (i - 1 + n) % n;
      const inx = (i + 1) % n;
      b[i * 2] = a[i * 2] * 0.5 + (a[ip * 2] + a[inx * 2]) * 0.25;
      b[i * 2 + 1] = a[i * 2 + 1] * 0.5 + (a[ip * 2 + 1] + a[inx * 2 + 1]) * 0.25;
    }
    a = b;
  }
  return a;
}

/**
 * Douglas–Peucker applied only to maximal runs of flagged vertices of a closed ring (e.g. shoreline vertices),
 * keeping each run's end points so the rest of the ring is untouched.
 */
export function simplifyRuns(r: number[], flag: (x: number, z: number) => boolean, tol: number): number[] {
  const n = r.length / 2;
  if (n < 4) return r;
  const f = new Uint8Array(n);
  let any = false;
  let all = true;
  for (let i = 0; i < n; i++) {
    f[i] = flag(r[i * 2], r[i * 2 + 1]) ? 1 : 0;
    if (f[i]) any = true;
    else all = false;
  }
  if (!any) return r;
  if (all) return simplifyRing(r, tol);
  // Start at a non-flagged vertex so runs don't wrap.
  let s0 = 0;
  while (f[s0]) s0++;
  const keep = new Uint8Array(n).fill(1);
  const tol2 = tol * tol;
  let i = 0;
  while (i < n) {
    const a = (s0 + i) % n;
    if (!f[a]) {
      i++;
      continue;
    }
    // Run from the previous (unflagged) vertex through the flagged ones to the next unflagged vertex.
    let j = i;
    while (j < n && f[(s0 + j) % n]) j++;
    const idx: number[] = [];
    for (let k = i - 1; k <= j; k++) idx.push((s0 + k + n) % n);
    const m = idx.length;
    const kp = new Uint8Array(m);
    kp[0] = kp[m - 1] = 1;
    const st: [number, number][] = [[0, m - 1]];
    while (st.length) {
      const [p0, p1] = st.pop()!;
      const ax = r[idx[p0] * 2];
      const az = r[idx[p0] * 2 + 1];
      const dx = r[idx[p1] * 2] - ax;
      const dz = r[idx[p1] * 2 + 1] - az;
      const L2 = dx * dx + dz * dz || 1e-12;
      let best = -1;
      let bi = -1;
      for (let q = p0 + 1; q < p1; q++) {
        const px = r[idx[q] * 2] - ax;
        const pz = r[idx[q] * 2 + 1] - az;
        const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / L2));
        const d = (px - dx * t) ** 2 + (pz - dz * t) ** 2;
        if (d > best) {
          best = d;
          bi = q;
        }
      }
      if (bi >= 0 && best > tol2) {
        kp[bi] = 1;
        st.push([p0, bi], [bi, p1]);
      }
    }
    for (let q = 1; q < m - 1; q++) if (!kp[q]) keep[idx[q]] = 0;
    i = j;
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(r[k * 2], r[k * 2 + 1]);
  return out;
}
