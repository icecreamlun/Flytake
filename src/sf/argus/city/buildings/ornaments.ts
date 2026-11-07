/**
 * Architectural relief as real geometry (so it casts shadows and breaks silhouettes):
 *  - profiled crown cornices on street frontages, mitred at corners and wrapping around bay windows
 *  - belt course / storefront cornice at the top of the ground floor
 *  - San Francisco three-sided bay windows on residential / Chinatown street walls, aligned to the
 *    facade shader's window grid so no window is cut in half
 *  - Chinatown pagoda eaves (green glazed tile with up-turned corners)
 */
import * as THREE from 'three';
import type { Heightfield, XZ } from '../../contracts';
import { PropBuilder, PropKind, WallBuilder } from './builder';
import type { BuildingGeo, EdgeInfo } from './geometry';
import { PROFILES, edgeRuns, extrudeProfile, scaleProfile, type Profile } from './mouldings';
import { F, Style } from './styles';

const KIND_BAY = 2;

/** Build-time counters (logged by index.ts). */
export const ornamentStats = { corniceSegs: 0, beltSegs: 0, bays: 0, bayBuildings: 0, bayIds: [] as number[], frontage: 0, edges: 0, why: {} as Record<string, number>, tris: { corniceCore: 0, corniceCtx: 0, belt: 0, bay: 0, pagoda: 0 } };
const why = (k: string) => (ornamentStats.why[k] = (ornamentStats.why[k] ?? 0) + 1);

interface Bay {
  /** Wall-line points (A, E) and projected corners (B, C), in edge direction order. */
  pts: [XZ, XZ, XZ, XZ];
  t0: number;
  t1: number;
  /** Bottom of the bay (world Y): on a floor line, clear of the street below it. */
  y0: number;
}

export function addOrnaments(W: WallBuilder, P: PropBuilder, g: BuildingGeo, terrain: Heightfield) {
  const s = g.style;
  if (g.wallTop < g.top - 0.01) return; // pitched roofs: no cornice / bays
  const pagoda = (s.flags & F.pagoda) !== 0 && s.style === Style.Chinatown;
  for (const e of g.edges) if (e.ring === 0) {
    ornamentStats.edges++;
    if (isFrontage(e)) ornamentStats.frontage++;
  }
  const bays = (s.flags & F.bays) !== 0 && !pagoda ? planBays(g, terrain) : new Map<number, Bay[]>();
  for (const [i, list] of bays) g.bays.set(i, list.map((b) => [b.t0, b.t1]));
  const cornice = !pagoda && (s.flags & F.cornice) !== 0 ? corniceDims(g) : null;
  const T = ornamentStats.tris;
  let t = P.indexCount;
  if (pagoda) addPagodaEaves(P, g);
  T.pagoda += (P.indexCount - t) / 3;
  t = P.indexCount;
  // Context ring: the cornice runs straight and bays stop just under it (no wrap-around detours).
  const wrap = !!cornice && !g.rec.context;
  if (cornice) addCornice(P, g, cornice, wrap ? bays : new Map());
  if (g.rec.context) T.corniceCtx += (P.indexCount - t) / 3;
  else T.corniceCore += (P.indexCount - t) / 3;
  t = P.indexCount;
  addBelt(P, g, terrain);
  T.belt += (P.indexCount - t) / 3;
  t = P.indexCount;
  if (bays.size) {
    emitBays(W, P, g, bays, cornice, wrap);
    T.bay += (P.indexCount - t) / 3;
    ornamentStats.bayBuildings++;
    ornamentStats.bayIds.push(g.index);
  }
}

/** Street frontage that carries cornices, belts and bays. */
const isFrontage = (e: EdgeInfo) => e.ring === 0 && e.exposed && e.street.street && e.party < 0.3 && e.len > 1.5;

// ─────────────────────────── cornice ───────────────────────────

interface CorniceSpec {
  D: number;
  H: number;
  profile: Profile;
  /** Profile code for the prop shader (0 crown, 1 simple, 2 low). */
  code: number;
}

/** Moulding prop `rand`: integer profile code (0 crown, 1 simple, 2 low, 3 belt, 4 skirt) + small random. */
const mouldRand = (code: number, r: number) => code + 0.1 * r;

function corniceDims(g: BuildingGeo): CorniceSpec | null {
  const h = g.rec.height;
  const st = g.style.style;
  let D: number;
  let H: number;
  let unit: Profile = PROFILES.CROWN;
  switch (st) {
    case Style.Chinatown:
      [D, H] = [0.5, 0.8];
      break;
    case Style.HistoricMasonry:
      [D, H] = [0.62, 0.95];
      break;
    case Style.PrewarOffice:
      [D, H] = [THREE.MathUtils.clamp(0.55 + h * 0.005, 0.65, 1.25), THREE.MathUtils.clamp(0.85 + h * 0.007, 1.0, 2.0)];
      break;
    case Style.House:
      [D, H] = [0.48, 0.62];
      unit = PROFILES.SIMPLE;
      break;
    default:
      [D, H] = [0.45, 0.66];
      unit = g.rec.yearBuilt < 1925 ? PROFILES.CROWN : PROFILES.SIMPLE;
  }
  // Context ring: same silhouette, fewer strips (seen from far away).
  if (g.rec.context && st !== Style.PrewarOffice) unit = PROFILES.LOW;
  if (g.wallTop - H < g.base + 2.5) return null;
  const code = unit === PROFILES.CROWN ? 0 : unit === PROFILES.SIMPLE ? 1 : 2;
  return { D, H, profile: scaleProfile(unit, D, H), code };
}

/** Build a cornice path along a run of frontage edges, detouring around bays (A → B → C → E). */
function runPath(g: BuildingGeo, edges: number[], bays: Map<number, Bay[]>): XZ[] {
  const ring = g.rings[0];
  const path: XZ[] = [];
  for (const i of edges) {
    path.push(ring[i]);
    for (const b of bays.get(i) ?? []) path.push(...b.pts);
  }
  path.push(ring[(edges[edges.length - 1] + 1) % ring.length]);
  return path;
}

function addCornice(P: PropBuilder, g: BuildingGeo, c: CorniceSpec, bays: Map<number, Bay[]>) {
  const ring0 = g.edges.filter((e) => e.ring === 0);
  const runs = edgeRuns(g.rings[0], (i) => !!ring0[i] && isFrontage(ring0[i]));
  if (!runs.length) return;
  const col = g.style.trim.clone();
  const rnd = g.rand();
  for (const run of runs) {
    const path = run.closed ? closedPath(g, bays) : runPath(g, run.edges, bays);
    ornamentStats.corniceSegs += extrudeProfile(P, path, c.profile, { y: g.wallTop, bld: g.index, color: col, kind: PropKind.Moulding, rand: mouldRand(c.code, rnd), closed: run.closed, under: 0.82 });
  }
  // Bay tops between the wall line and the cornice path, level with the cornice top.
  const cap = g.style.trim.clone().multiplyScalar(0.85);
  for (const list of bays.values())
    for (const b of list) {
      const v = b.pts.map((p) => P.vertex(p[0], g.wallTop, p[1], 0, 1, 0, g.index, cap.r, cap.g, cap.b, PropKind.Ledge, p[0], p[1], rnd));
      P.quad(v[0], v[1], v[2], v[3], 0, 1, 0);
    }
}

function closedPath(g: BuildingGeo, bays: Map<number, Bay[]>): XZ[] {
  const ring = g.rings[0];
  const path: XZ[] = [];
  for (let i = 0; i < ring.length; i++) {
    path.push(ring[i]);
    for (const b of bays.get(i) ?? []) path.push(...b.pts);
  }
  return path;
}

// ─────────────────────────── belt course ───────────────────────────

function addBelt(P: PropBuilder, g: BuildingGeo, terrain: Heightfield) {
  const s = g.style;
  const st = s.style;
  if (g.rec.context && st !== Style.PrewarOffice && st !== Style.HistoricMasonry) return;
  if (!(st === Style.Chinatown || st === Style.HistoricMasonry || st === Style.PrewarOffice || st === Style.ResidentialMid || st === Style.House)) return;
  if (st === Style.ResidentialMid && g.rec.yearBuilt > 1950) return;
  const yTop = g.base + s.groundH + 0.06;
  if (g.wallTop - yTop < 3) return;
  const [D, H] = st === Style.PrewarOffice ? [0.32, 0.62] : st === Style.House ? [0.14, 0.28] : [0.24, 0.46];
  const ground = (p: XZ) => (g.rec.overWater ? g.base : terrain.heightAt(p[0], p[1]));
  const ring0 = g.edges.filter((e) => e.ring === 0);
  // Skip frontage that is buried by an uphill street (the belt would run into the pavement).
  const ok = (i: number) => {
    const e = ring0[i];
    if (!e || !isFrontage(e)) return false;
    const mid: XZ = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    return Math.max(ground(e.a), ground(e.b), ground(mid)) < yTop - H - 2.3;
  };
  const runs = edgeRuns(g.rings[0], ok);
  if (!runs.length) return;
  const col = st === Style.PrewarOffice || st === Style.HistoricMasonry ? s.trim.clone() : s.trim.clone().lerp(s.base, 0.25);
  const rnd = g.rand();
  const prof = scaleProfile(PROFILES.BELT, D, H);
  for (const run of runs) ornamentStats.beltSegs += extrudeProfile(P, run.path, prof, { y: yTop, bld: g.index, color: col, kind: PropKind.Moulding, rand: mouldRand(3, rnd), closed: run.closed, under: 0.8 });
}

// ─────────────────────────── bay windows ───────────────────────────

/**
 * Bays per frontage edge, aligned to the facade's window modules: each bay covers m whole modules
 * (so the windows behind it are hidden entirely) with `gap` plain modules between bays.
 */
function planBays(g: BuildingGeo, terrain: Heightfield): Map<number, Bay[]> {
  const s = g.style;
  const out = new Map<number, Bay[]>();
  const yFirst = g.base + s.groundH + 0.3;
  if (g.wallTop - yFirst < 3.2 || g.rec.height > 26) {
    why('height');
    return out;
  }
  if (!g.edges.some(isFrontage)) why('noFrontage');
  const R = g.rand;
  const D = 0.62 + R() * 0.26;
  const gapPref = R() < 0.5 ? 1 : 2;
  g.edges.forEach((e, idx) => {
    if (!isFrontage(e)) return;
    if (e.len < 3.6) return void why('short');
    const n = Math.max(1, Math.floor(e.len / s.module + 0.25));
    const mw = e.len / n;
    const m = mw >= 2.45 ? 1 : 2;
    // 0.25 m of wall each side of the bay, still wide enough to hide the window(s) behind it.
    let bw = m * mw - 0.5;
    if (bw > 3.9) bw = 3.4;
    if (bw < 1.8 || bw < s.winW * mw * m + 0.15) return void why('bw');
    const Db = Math.min(D, (bw - 0.7) / 2);
    const gap = n >= 5 ? gapPref : 1;
    const k = Math.floor((n + gap) / (m + gap));
    if (k < 1) return;
    const used = k * m + (k - 1) * gap;
    const off = Math.floor((n - used) / 2);
    const dx = (e.b[0] - e.a[0]) / e.len;
    const dz = (e.b[1] - e.a[1]) / e.len;
    const list: Bay[] = [];
    for (let j = 0; j < k; j++) {
      const c = (off + j * (m + gap) + m / 2) * mw;
      const t0 = c - bw / 2;
      const t1 = c + bw / 2;
      if (t0 < 0.2 || t1 > e.len - 0.2) {
        why('ends');
        continue;
      }
      const A: XZ = [e.a[0] + dx * t0, e.a[1] + dz * t0];
      const E: XZ = [e.a[0] + dx * t1, e.a[1] + dz * t1];
      // Hillside lots: the street may be storeys above the building's lowest corner. Start the bay on
      // the first floor line that clears the pavement (keeps it on the facade's window grid).
      const gr = g.rec.overWater ? g.base : Math.max(terrain.heightAt(A[0], A[1]), terrain.heightAt(E[0], E[1]));
      let y0 = yFirst;
      while (y0 < gr + 2.7) y0 += s.floorH;
      if (g.wallTop - y0 < 3.0) {
        why('uphill');
        continue;
      }
      const B: XZ = [A[0] + dx * Db + e.n[0] * Db, A[1] + dz * Db + e.n[1] * Db];
      const C: XZ = [E[0] - dx * Db + e.n[0] * Db, E[1] - dz * Db + e.n[1] * Db];
      list.push({ pts: [A, B, C, E], t0, t1, y0 });
    }
    if (list.length) out.set(idx, list);
  });
  return out;
}

function emitBays(W: WallBuilder, P: PropBuilder, g: BuildingGeo, bays: Map<number, Bay[]>, cornice: CorniceSpec | null, wrap: boolean) {
  const s = g.style;
  // Wrapped: the bay rises into the cornice, which follows its outline. Otherwise the bay stops under
  // the cornice (flat top) or, without one, gets its own small moulded cap.
  const y1 = wrap ? g.wallTop - 0.01 : cornice ? g.wallTop - cornice.H - 0.01 : g.wallTop - Math.max(0.55, s.topBand * 0.5);
  const trim = s.trim;
  const under = s.base.clone().multiplyScalar(0.62);
  const rnd = g.rand();
  const skirt = scaleProfile(PROFILES.SKIRT, 0.12, 0.34);
  const capProf = scaleProfile(g.rec.context ? PROFILES.LOW : PROFILES.SIMPLE, 0.26, 0.38);
  for (const list of bays.values())
    for (const b of list) {
      const pts = b.pts;
      const y0 = b.y0;
      if (y1 - y0 < 2.4) continue;
      const key = g.rand() * 991;
      for (let f = 0; f < 3; f++) {
        const p = pts[f];
        const q = pts[f + 1];
        const fl = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const nx = (q[1] - p[1]) / fl;
        const nz = -(q[0] - p[0]) / fl;
        const flags = 2 + 4 * KIND_BAY;
        const i0 = W.vertex(p[0], y0, p[1], nx, 0, nz, g.index, 0, fl, key + f, g.base, flags);
        const i1 = W.vertex(q[0], y0, q[1], nx, 0, nz, g.index, fl, fl, key + f, g.base, flags);
        const i2 = W.vertex(q[0], y1, q[1], nx, 0, nz, g.index, fl, fl, key + f, g.base, flags);
        const i3 = W.vertex(p[0], y1, p[1], nx, 0, nz, g.index, 0, fl, key + f, g.base, flags);
        W.quad(i0, i1, i2, i3, nx, 0, nz);
      }
      // Underside and a moulded skirt along the bottom edge.
      const bot = pts.map((p) => P.vertex(p[0], y0, p[1], 0, -1, 0, g.index, under.r, under.g, under.b, PropKind.Soffit, p[0], p[1], key));
      P.quad(bot[0], bot[1], bot[2], bot[3], 0, -1, 0);
      if (!g.rec.context) extrudeProfile(P, pts, skirt, { y: y0, bld: g.index, color: trim, kind: PropKind.Moulding, rand: mouldRand(4, rnd), caps: false });
      if (!wrap) {
        if (!cornice) extrudeProfile(P, pts, capProf, { y: y1, bld: g.index, color: trim, kind: PropKind.Moulding, rand: mouldRand(g.rec.context ? 2 : 1, rnd), caps: false });
        const top = pts.map((p) => P.vertex(p[0], y1, p[1], 0, 1, 0, g.index, trim.r * 0.85, trim.g * 0.85, trim.b * 0.85, PropKind.Ledge, p[0], p[1], key));
        P.quad(top[0], top[1], top[2], top[3], 0, 1, 0);
      }
      ornamentStats.bays++;
    }
}

// ─────────────────────────── Chinatown pagoda eaves ───────────────────────────

/** Sloped green-tile eave along the street frontage with up-turned ends. */
function addPagodaEaves(P: PropBuilder, g: BuildingGeo) {
  const tile = new THREE.Color('#2f7a4a').lerp(new THREE.Color('#3f8a5a'), g.rand());
  const red = new THREE.Color('#9e2018');
  const rnd = g.rand();
  const levels = g.wallTop - g.base > 14 && g.rand() < 0.5 ? [g.wallTop - 0.25, g.base + g.style.groundH + g.style.floorH - 0.2] : [g.wallTop - 0.25];
  for (const e of g.edges) {
    if (!isFrontage(e) || e.len < 3) continue;
    const dx = (e.b[0] - e.a[0]) / e.len;
    const dz = (e.b[1] - e.a[1]) / e.len;
    for (const yA of levels) {
      const D = 1.15;
      const drop = 0.75;
      const lift = 0.45;
      const ext = 0.35; // eave overhangs the corners slightly
      const a: XZ = [e.a[0] - dx * 0.05, e.a[1] - dz * 0.05];
      const b: XZ = [e.b[0] + dx * 0.05, e.b[1] + dz * 0.05];
      const oa: XZ = [e.a[0] - dx * ext + e.n[0] * D, e.a[1] - dz * ext + e.n[1] * D];
      const ob: XZ = [e.b[0] + dx * ext + e.n[0] * D, e.b[1] + dz * ext + e.n[1] * D];
      // Slope normal (tilted out of the wall).
      const sl = Math.hypot(D, drop);
      const ny = D / sl;
      const nx = (e.n[0] * drop) / sl;
      const nz = (e.n[1] * drop) / sl;
      const seg = Math.max(2, Math.round(e.len / 1.5));
      // Subdivide along the edge so the up-turned ends curve smoothly.
      for (let k = 0; k < seg; k++) {
        const t0 = k / seg;
        const t1 = (k + 1) / seg;
        const lerp = (p: XZ, q: XZ, t: number): XZ => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const curl = (t: number) => lift * Math.pow(Math.abs(t * 2 - 1), 4);
        const w0 = lerp(a, b, t0), w1 = lerp(a, b, t1), o0 = lerp(oa, ob, t0), o1 = lerp(oa, ob, t1);
        const yo0 = yA - drop + curl(t0);
        const yo1 = yA - drop + curl(t1);
        const v = [
          P.vertex(w0[0], yA, w0[1], nx, ny, nz, g.index, tile.r, tile.g, tile.b, PropKind.TileRoof, t0 * e.len, 0, rnd),
          P.vertex(w1[0], yA, w1[1], nx, ny, nz, g.index, tile.r, tile.g, tile.b, PropKind.TileRoof, t1 * e.len, 0, rnd),
          P.vertex(o1[0], yo1, o1[1], nx, ny, nz, g.index, tile.r, tile.g, tile.b, PropKind.TileRoof, t1 * e.len, sl, rnd),
          P.vertex(o0[0], yo0, o0[1], nx, ny, nz, g.index, tile.r, tile.g, tile.b, PropKind.TileRoof, t0 * e.len, sl, rnd),
        ];
        P.quad(v[0], v[1], v[2], v[3], nx, ny, nz);
        // Red underside.
        const u = [
          P.vertex(w0[0], yA - 0.08, w0[1], -nx, -ny, -nz, g.index, red.r, red.g, red.b, PropKind.Soffit, 0, 0, rnd),
          P.vertex(w1[0], yA - 0.08, w1[1], -nx, -ny, -nz, g.index, red.r, red.g, red.b, PropKind.Soffit, 0, 0, rnd),
          P.vertex(o1[0], yo1 - 0.08, o1[1], -nx, -ny, -nz, g.index, red.r, red.g, red.b, PropKind.Soffit, 0, 0, rnd),
          P.vertex(o0[0], yo0 - 0.08, o0[1], -nx, -ny, -nz, g.index, red.r, red.g, red.b, PropKind.Soffit, 0, 0, rnd),
        ];
        P.quad(u[0], u[1], u[2], u[3], -nx, -ny, -nz);
        // Fascia (front lip).
        const f = [
          P.vertex(o0[0], yo0 - 0.22, o0[1], e.n[0], 0, e.n[1], g.index, red.r, red.g, red.b, PropKind.Ledge, t0 * e.len, 0, rnd),
          P.vertex(o1[0], yo1 - 0.22, o1[1], e.n[0], 0, e.n[1], g.index, red.r, red.g, red.b, PropKind.Ledge, t1 * e.len, 0, rnd),
          P.vertex(o1[0], yo1, o1[1], e.n[0], 0, e.n[1], g.index, red.r, red.g, red.b, PropKind.Ledge, t1 * e.len, 0.22, rnd),
          P.vertex(o0[0], yo0, o0[1], e.n[0], 0, e.n[1], g.index, red.r, red.g, red.b, PropKind.Ledge, t0 * e.len, 0.22, rnd),
        ];
        P.quad(f[0], f[1], f[2], f[3], e.n[0], 0, e.n[1]);
      }
    }
  }
}
