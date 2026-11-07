/**
 * Moulding profiles extruded along wall polylines (cornices, belt courses, bay-window caps / skirts).
 *
 * A profile is a list of (out, up) points in metres, relative to the wall face and a reference height,
 * walked from the wall attachment at the bottom, outward and up, and back to the wall at the top.
 * Every strip between consecutive points becomes a quad per path segment, mitred at the joints, so the
 * moulding is real geometry: it casts shadows, catches the sun on its top faces and breaks silhouettes.
 *
 * Prop UVs: u = metres along the path, v = strip index + fraction across the strip (the prop shader
 * uses floor(v) to paint dentils / modillions on specific strips).
 */
import * as THREE from 'three';
import type { XZ } from '../../contracts';
import type { PropBuilder } from './builder';

export type Profile = readonly (readonly [number, number])[];

/** Max mitre stretch (1 / cos(half angle)); sharper joints are capped instead. */
const MITRE_LIMIT = 2.2;

/** Classical crown cornice (bed moulding, modillion soffit, corona, cyma crown). Unit size; scaled by (D, H). */
const CROWN: Profile = [
  [0, -1.0],
  [0.12, -1.0], // bed moulding underside
  [0.2, -0.76], // bed cove
  [0.24, -0.62], // dentil band (strip 2)
  [0.78, -0.56], // soffit / modillions (strip 3)
  [0.8, -0.42], // corona fascia
  [0.93, -0.24], // cyma recta crown
  [1.0, 0.0],
  [0.0, 0.0], // top wash back to the wall
];
/** Plainer cornice for houses / mid-century walk-ups: fascia + soffit + crown. */
const SIMPLE: Profile = [
  [0, -1.0],
  [0.1, -1.0],
  [0.16, -0.8],
  [0.85, -0.66], // soffit
  [0.88, -0.5],
  [1.0, -0.24],
  [1.0, 0.0],
  [0.0, 0.0],
];
/** Cheap 3-strip version for the context ring (soffit, fascia, top): same silhouette and shadow. */
const LOW: Profile = [
  [0, -1.0],
  [0.9, -0.62],
  [1.0, 0.0],
  [0.0, 0.0],
];
/** Belt / storefront cornice at the top of the ground floor. */
const BELT: Profile = [
  [0, -1.0],
  [0.55, -1.0],
  [0.6, -0.55],
  [1.0, -0.32], // drip
  [1.0, -0.06],
  [0.0, 0.08], // sloped wash sheds rain off the ledge
];
/** Skirt moulding at the bottom of a bay window (reference height = bay bottom). */
const SKIRT: Profile = [
  [0, -0.35],
  [0.55, -0.1],
  [1.0, -0.05],
  [1.0, 0.25],
  [0.0, 0.3],
];

export const PROFILES = { CROWN, SIMPLE, LOW, BELT, SKIRT } as const;

/** Scale a unit profile to projection D and height H (up values are fractions of H). */
export function scaleProfile(p: Profile, D: number, H: number): Profile {
  return p.map(([o, u]) => [o * D, u * H] as const);
}

interface StripNormals {
  /** Per strip: 2D normal (out, up) at its start and end point (smoothed across shallow joints). */
  n0: [number, number][];
  n1: [number, number][];
}

function stripNormals(p: Profile): StripNormals {
  const flat: [number, number][] = [];
  for (let k = 0; k < p.length - 1; k++) {
    const dO = p[k + 1][0] - p[k][0];
    const dU = p[k + 1][1] - p[k][1];
    const l = Math.hypot(dO, dU) || 1;
    flat.push([dU / l, -dO / l]);
  }
  const smooth = (a: [number, number], b: [number, number]): [number, number] | null => {
    if (a[0] * b[0] + a[1] * b[1] < Math.cos((40 * Math.PI) / 180)) return null;
    const x = a[0] + b[0];
    const y = a[1] + b[1];
    const l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  };
  const n0: [number, number][] = [];
  const n1: [number, number][] = [];
  for (let k = 0; k < flat.length; k++) {
    n0.push((k > 0 && smooth(flat[k - 1], flat[k])) || flat[k]);
    n1.push((k < flat.length - 1 && smooth(flat[k], flat[k + 1])) || flat[k]);
  }
  return { n0, n1 };
}

const capCache = new WeakMap<Profile, number[][]>();
function capTriangles(p: Profile): number[][] {
  let t = capCache.get(p);
  if (!t) {
    const pts = p.map(([o, u]) => new THREE.Vector2(o, u));
    // Closed by the wall segment from the last point back to the first.
    try {
      t = THREE.ShapeUtils.triangulateShape(pts, []);
    } catch {
      t = [];
    }
    capCache.set(p, t);
  }
  return t;
}

export interface ExtrudeOptions {
  /** Reference height (world Y) that profile `up` values are relative to. */
  y: number;
  bld: number;
  color: THREE.Color;
  kind: number;
  rand: number;
  /** Close the loop (path[last] → path[0]). */
  closed?: boolean;
  /** Emit profile-shaped end caps at open ends. */
  caps?: boolean;
  /** Per-vertex colour multiplier for strips facing down (soffits read darker as painted shadow). */
  under?: number;
}

/**
 * Extrude `profile` along a wall polyline. Points are on the wall face line, ordered so that the outward
 * normal of segment a → b is (dz, -dx) / len (the module-wide ring convention).
 * Returns the number of segments emitted.
 */
export function extrudeProfile(P: PropBuilder, path: XZ[], profile: Profile, o: ExtrudeOptions): number {
  const n = path.length;
  const segs = o.closed ? n : n - 1;
  if (segs < 1 || profile.length < 2) return 0;
  const normals: XZ[] = [];
  const lens: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    lens.push(l);
    normals.push([(b[1] - a[1]) / l, -(b[0] - a[0]) / l]);
  }
  const maxOut = profile.reduce((m, [p]) => Math.max(m, p), 0);
  // Joint j sits at path[j]; mitre direction and stretch, or null for a capped (free) joint.
  const joint = (j: number): { m: XZ; k: number } | null => {
    const i0 = j - 1;
    const i1 = j;
    const prev = o.closed ? (i0 + segs) % segs : i0;
    if (!o.closed && (i0 < 0 || i1 >= segs)) return null;
    const na = normals[prev];
    const nb = normals[i1 % segs];
    let mx = na[0] + nb[0];
    let mz = na[1] + nb[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-3) return null;
    mx /= ml;
    mz /= ml;
    const c = mx * nb[0] + mz * nb[1];
    if (c < 1 / MITRE_LIMIT) return null;
    const k = 1 / c;
    // The mitre slides the strip ends along both segments by maxOut * tan(half): keep it inside them.
    const slide = maxOut * Math.sqrt(Math.max(k * k - 1, 0));
    if (slide > 0.45 * Math.min(lens[prev], lens[i1 % segs])) return null;
    return { m: [mx, mz], k };
  };
  const joints = Array.from({ length: n }, (_, j) => joint(j));
  const { n0, n1 } = stripNormals(profile);
  const col = o.color;
  const under = o.under ?? 0.78;
  let emitted = 0;
  for (let i = 0; i < segs; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    const nn = normals[i];
    const ja = joints[i];
    const jb = joints[(i + 1) % n];
    const at = (p: XZ, j: { m: XZ; k: number } | null, out: number): XZ =>
      j ? [p[0] + j.m[0] * out * j.k, p[1] + j.m[1] * out * j.k] : [p[0] + nn[0] * out, p[1] + nn[1] * out];
    const dirx = (b[0] - a[0]) / lens[i];
    const dirz = (b[1] - a[1]) / lens[i];
    for (let k = 0; k < profile.length - 1; k++) {
      const [o0, u0] = profile[k];
      const [o1, u1] = profile[k + 1];
      const A0 = at(a, ja, o0);
      const B0 = at(b, jb, o0);
      const A1 = at(a, ja, o1);
      const B1 = at(b, jb, o1);
      const sn0 = n0[k];
      const sn1 = n1[k];
      const w0x = nn[0] * sn0[0], w0z = nn[1] * sn0[0], w0y = sn0[1];
      const w1x = nn[0] * sn1[0], w1z = nn[1] * sn1[0], w1y = sn1[1];
      const shade0 = sn0[1] < -0.5 ? under : 1;
      const shade1 = sn1[1] < -0.5 ? under : 1;
      // u along the path (projected on the segment so mitred ends stay continuous).
      const uA0 = (A0[0] - a[0]) * dirx + (A0[1] - a[1]) * dirz;
      const uB0 = (B0[0] - a[0]) * dirx + (B0[1] - a[1]) * dirz;
      const uA1 = (A1[0] - a[0]) * dirx + (A1[1] - a[1]) * dirz;
      const uB1 = (B1[0] - a[0]) * dirx + (B1[1] - a[1]) * dirz;
      const v0 = P.vertex(A0[0], o.y + u0, A0[1], w0x, w0y, w0z, o.bld, col.r * shade0, col.g * shade0, col.b * shade0, o.kind, uA0, k, o.rand);
      const v1 = P.vertex(B0[0], o.y + u0, B0[1], w0x, w0y, w0z, o.bld, col.r * shade0, col.g * shade0, col.b * shade0, o.kind, uB0, k, o.rand);
      const v2 = P.vertex(B1[0], o.y + u1, B1[1], w1x, w1y, w1z, o.bld, col.r * shade1, col.g * shade1, col.b * shade1, o.kind, uB1, k + 1, o.rand);
      const v3 = P.vertex(A1[0], o.y + u1, A1[1], w1x, w1y, w1z, o.bld, col.r * shade1, col.g * shade1, col.b * shade1, o.kind, uA1, k + 1, o.rand);
      const fx = (w0x + w1x) * 0.5, fy = (w0y + w1y) * 0.5, fz = (w0z + w1z) * 0.5;
      P.quad(v0, v1, v2, v3, fx, fy, fz);
    }
    emitted++;
    // End caps where the moulding stops (free ends / sharp joints).
    if (o.caps !== false) {
      if (!ja) cap(P, profile, a, nn, [-dirx, -dirz], o);
      if (!jb) cap(P, profile, b, nn, [dirx, dirz], o);
    }
  }
  return emitted;
}

function cap(P: PropBuilder, profile: Profile, p: XZ, n: XZ, facing: XZ, o: ExtrudeOptions) {
  const tris = capTriangles(profile);
  if (!tris.length) return;
  const c = o.color;
  const ids = profile.map(([out, up]) => P.vertex(p[0] + n[0] * out, o.y + up, p[1] + n[1] * out, facing[0], 0, facing[1], o.bld, c.r * 0.92, c.g * 0.92, c.b * 0.92, o.kind, out, 0.5, o.rand));
  for (const t of tris) P.tri(ids[t[0]], ids[t[1]], ids[t[2]], facing[0], 0, facing[1]);
}

/**
 * Split a ring's edges into maximal runs of consecutive edges accepted by `ok`.
 * Returns point paths (closed = every edge accepted) for extrudeProfile.
 */
export function edgeRuns(ring: XZ[], ok: (edge: number) => boolean): { path: XZ[]; closed: boolean; edges: number[] }[] {
  const n = ring.length;
  const flags = Array.from({ length: n }, (_, i) => ok(i));
  if (flags.every(Boolean)) return [{ path: ring.slice(), closed: true, edges: ring.map((_, i) => i) }];
  const groups: number[][] = [];
  // Start just after a rejected edge so runs never wrap mid-way.
  const start = flags.findIndex((f) => !f);
  const cur: number[] = [];
  for (let s = 1; s <= n; s++) {
    const i = (start + s) % n;
    if (flags[i]) cur.push(i);
    else if (cur.length) groups.push(cur.splice(0));
  }
  if (cur.length) groups.push(cur.splice(0));
  return groups.map((edges) => ({ path: [...edges.map((i) => ring[i]), ring[(edges[edges.length - 1] + 1) % n]], closed: false, edges }));
}
