/**
 * Lofted vehicle bodies. A body is a list of stations along z (local +Z forward), each a right-half profile from
 * the bottom centre-line (x = 0) up around the side to the top centre-line (x = 0); the left half is mirrored.
 * Every quad (station s → s+1, ring segment k) gets its own material, so paint, glass, black trim strips, door
 * seams, livery bands and windows are all part of one surface. Vertices are shared between quads of the same
 * material only: shading is smooth inside a panel and crisp at every material border. The two end faces are cut
 * into horizontal bands (one material per band: bumper, grille, windscreen…).
 * Output attributes match the props Kit (color, aPbr = roughness/metalness/tint, aEmit).
 */
import * as THREE from 'three';
import { Emit } from '../props/kit';

export interface Mat {
  c: THREE.Color;
  r: number;
  m: number;
  /** 1 = body paint (per-instance tint + clear coat). */
  t: number;
  e: number;
}

const mat = (hex: string, r: number, m = 0, t = 0, e = 0): Mat => ({ c: new THREE.Color(hex), r, m, t, e });

/** Shared vehicle palette. */
export const VM = {
  PAINT: mat('#ffffff', 0.34, 0.25, 1),
  UNDER: mat('#0a0a0b', 0.95),
  TRIM: mat('#141516', 0.6),
  SEAM: mat('#1c1d1e', 0.7, 0, 0),
  GLASS: mat('#06090b', 0.04, 0.0),
  CHROME: mat('#b9bec2', 0.18, 1),
  TYRE: mat('#111111', 0.9),
  RIM: mat('#8e9398', 0.32, 0.9),
  RIM_DARK: mat('#2b2e31', 0.4, 0.7),
  HEAD: mat('#f4f2ea', 0.08, 0, 0, Emit.Head),
  TAIL: mat('#6e0b07', 0.2, 0, 0, Emit.Tail),
  AMBER: mat('#b8650e', 0.25),
  PLATE: mat('#d9d9d2', 0.5),
  MUNI_RED: mat('#a3221a', 0.38, 0.2),
  MUNI_WHITE: mat('#e4e4df', 0.4, 0.2),
  MUNI_GREY: mat('#8c9094', 0.45, 0.4),
  SIGN: mat('#ffcf6a', 0.3, 0, 0, Emit.Cabin),
  CABIN: mat('#fff4dc', 0.9, 0, 0, Emit.Cabin),
  WHITE: mat('#e6e6e2', 0.4, 0.1),
};

export interface Station {
  z: number;
  /** Right-half profile x0,y0, x1,y1 … from the bottom centre (x0 = 0) to the top centre (xn = 0). */
  pts: number[];
}

export class GeoSink {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  pbr: number[] = [];
  emit: number[] = [];
  idx: number[] = [];
  vert(x: number, y: number, z: number, m: Mat, nx = 0, ny = 0, nz = 0): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(m.c.r, m.c.g, m.c.b);
    this.pbr.push(m.r, m.m, m.t);
    this.emit.push(m.e);
    return this.pos.length / 3 - 1;
  }
  build(smooth: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPbr', new THREE.Float32BufferAttribute(this.pbr, 3));
    g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.emit, 1));
    g.setIndex(this.idx);
    if (smooth) g.computeVertexNormals();
    return g;
  }
}

/**
 * Loft through the stations. quadMat(s, k, side) gives the material of the quad between stations s and s+1 on
 * right-half segment k (side +1 right, −1 left). capMat(end, k) the material of end-face band k (end 0 = rear,
 * 1 = front) or null to leave that end open.
 */
export function loft(
  st: Station[],
  quadMat: (s: number, k: number, side: 1 | -1) => Mat,
  capMat: ((end: 0 | 1, k: number) => Mat | null) | null,
): THREE.BufferGeometry {
  const g = new GeoSink();
  const P = st[0].pts.length / 2;
  const keys = new Map<string, number>();
  const vtx = (s: number, k: number, side: 1 | -1, m: Mat) => {
    // Centre-line points are shared by both halves.
    const sd = k === 0 || k === P - 1 ? 0 : side;
    const key = `${s}|${k}|${sd}|${m.c.getHex()}|${m.r}|${m.e}|${m.t}`;
    let v = keys.get(key);
    if (v === undefined) {
      const p = st[s].pts;
      v = g.vert(p[k * 2] * side, p[k * 2 + 1], st[s].z, m);
      keys.set(key, v);
    }
    return v;
  };
  for (let s = 0; s < st.length - 1; s++) {
    for (let k = 0; k < P - 1; k++) {
      for (const side of [1, -1] as const) {
        const m = quadMat(s, k, side);
        const a = vtx(s, k, side, m);
        const b = vtx(s, k + 1, side, m);
        const c = vtx(s + 1, k + 1, side, m);
        const d = vtx(s + 1, k, side, m);
        // Outward winding: right half (a, b, c) faces +x/up when z increases with s; the mirrored half flips.
        if (side === 1) g.idx.push(a, b, c, a, c, d);
        else g.idx.push(a, c, b, a, d, c);
      }
    }
  }
  const geo = g.build(true);
  if (!capMat) return geo;
  // End faces: horizontal bands between the right and left profile points.
  const cap = new GeoSink();
  for (const end of [0, 1] as const) {
    const s = end === 0 ? 0 : st.length - 1;
    const p = st[s].pts;
    const z = st[s].z;
    const nz = end === 0 ? -1 : 1;
    for (let k = 0; k < P - 1; k++) {
      const m = capMat(end, k);
      if (!m) continue;
      const x0 = p[k * 2];
      const y0 = p[k * 2 + 1];
      const x1 = p[k * 2 + 2];
      const y1 = p[k * 2 + 3];
      if (Math.abs(y1 - y0) < 1e-4) continue;
      const a = cap.vert(x0, y0, z, m, 0, 0, nz);
      const b = cap.vert(x1, y1, z, m, 0, 0, nz);
      const c = cap.vert(-x1, y1, z, m, 0, 0, nz);
      const d = cap.vert(-x0, y0, z, m, 0, 0, nz);
      if (end === 1) cap.idx.push(a, b, c, a, c, d);
      else cap.idx.push(a, c, b, a, d, c);
    }
  }
  return merge([geo, cap.build(false)]);
}

/** Merge geometries carrying the vehicle attributes (all indexed). */
export function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new GeoSink();
  for (const g of gs) {
    const base = out.pos.length / 3;
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    const C = g.getAttribute('color');
    const R = g.getAttribute('aPbr');
    const E = g.getAttribute('aEmit');
    for (let i = 0; i < P.count; i++) {
      out.pos.push(P.getX(i), P.getY(i), P.getZ(i));
      out.nrm.push(N.getX(i), N.getY(i), N.getZ(i));
      out.col.push(C.getX(i), C.getY(i), C.getZ(i));
      out.pbr.push(R.getX(i), R.getY(i), R.getZ(i));
      out.emit.push(E.getX(i));
    }
    const I = g.getIndex();
    if (I) for (let i = 0; i < I.count; i++) out.idx.push(base + I.getX(i));
    else for (let i = 0; i < P.count; i++) out.idx.push(base + i);
  }
  return out.build(false);
}

/** Convert a plain geometry (position/normal, any index) into vehicle attributes with one material. */
export function painted(g: THREE.BufferGeometry, m: Mat, at?: THREE.Matrix4): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g.clone();
  if (at) geo.applyMatrix4(at);
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  const pbr = new Float32Array(n * 3);
  const emit = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    col.set([m.c.r, m.c.g, m.c.b], i * 3);
    pbr.set([m.r, m.m, m.t], i * 3);
    emit[i] = m.e;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 3));
  geo.setAttribute('aEmit', new THREE.BufferAttribute(emit, 1));
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'color', 'aPbr', 'aEmit'].includes(k)) geo.deleteAttribute(k);
  return geo;
}

const T = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));

export const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: Mat, ry = 0, rx = 0) => painted(new THREE.BoxGeometry(w, h, d), m, T(x, y, z, rx, ry));

/**
 * Wheel at (x, y = R, z): tyre (lathe profile with rounded shoulders), dished rim face with spokes and hub on the
 * outer side (side = +1 right, −1 left). detail 0 = near, 1 = mid (no spokes), 2 = far (octagonal drum).
 */
export function wheel(R: number, width: number, x: number, z: number, side: 1 | -1, detail: number, rim: Mat = VM.RIM, spokes = 5): THREE.BufferGeometry {
  const hw = width / 2;
  const parts: THREE.BufferGeometry[] = [];
  const seg = detail === 0 ? 14 : detail === 1 ? 10 : 7;
  const prof =
    detail === 2
      ? [new THREE.Vector2(R * 0.6, -hw), new THREE.Vector2(R, -hw), new THREE.Vector2(R, hw), new THREE.Vector2(R * 0.6, hw)]
      : [
          new THREE.Vector2(R * 0.64, -hw),
          new THREE.Vector2(R * 0.93, -hw),
          new THREE.Vector2(R, -hw * 0.55),
          new THREE.Vector2(R, hw * 0.55),
          new THREE.Vector2(R * 0.93, hw),
          new THREE.Vector2(R * 0.64, hw),
        ];
  // Lathe around local Y, then turn the axle to X.
  const tyre = new THREE.LatheGeometry(prof, seg);
  const toX = T(x, R, z, 0, 0, Math.PI / 2);
  parts.push(painted(tyre, VM.TYRE, toX));
  // Rim face (outer side), slightly dished.
  const rimFace = new THREE.CircleGeometry(R * 0.64, seg);
  parts.push(painted(rimFace, detail === 2 ? VM.RIM_DARK : rim, T(x + side * (hw - 0.03), R, z, 0, (side * Math.PI) / 2, 0)));
  // Inner face (dark) so the tyre never looks hollow from behind.
  parts.push(painted(new THREE.CircleGeometry(R * 0.66, Math.max(6, seg - 4)), VM.UNDER, T(x - side * (hw - 0.02), R, z, 0, (-side * Math.PI) / 2, 0)));
  if (detail === 0) {
    // Spokes and centre hub, proud of the rim face.
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      const sp = new THREE.BoxGeometry(0.03, R * 0.5, 0.075);
      const m = new THREE.Matrix4()
        .makeTranslation(x + side * (hw - 0.012), R, z)
        .multiply(new THREE.Matrix4().makeRotationX(a))
        .multiply(new THREE.Matrix4().makeTranslation(0, R * 0.32, 0));
      parts.push(painted(sp, rim, m));
    }
    parts.push(painted(new THREE.CylinderGeometry(R * 0.16, R * 0.18, 0.04, 8), VM.RIM_DARK, T(x + side * (hw - 0.01), R, z, 0, 0, Math.PI / 2)));
  }
  return merge(parts);
}
