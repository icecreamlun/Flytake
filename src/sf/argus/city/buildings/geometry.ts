/**
 * Builds the merged building geometry for the whole city:
 *   walls (core / context ring)  → facade shader
 *   props (roofs, parapets, cornice soffits, bays' caps, rooftop clutter, awnings, signs…) → prop shader
 * Every vertex carries its building index (aBld) so the shaders can deform / hide / tint it
 * from the per-building state texture.
 */
import * as THREE from 'three';
import type { BuildingRecord, Heightfield, XZ } from '../../contracts';
import { PropBuilder, PropKind, WallBuilder } from './builder';
import { analyseWalls, createStreetClassifier, type EdgeFlags, type Solid, type WallPiece } from './edges';
import { centroid, cleanRing, edgeNormal, offsetRing, pointInRing, signedArea, thickness } from './footprint';
import { addOrnaments } from './ornaments';
import { addProps } from './props';
import { STYLE_TEXELS, Style, applyIconic, computeStyle, hashString, packStyle, type StyleParams } from './styles';
import type { RoadRecord } from '../../contracts';

/** How far walls are sunk below baseElevation so nothing floats on slopes (m). */
const SINK = 3.0;

export interface EdgeInfo {
  ring: number;
  edge: number;
  a: XZ;
  b: XZ;
  len: number;
  n: XZ;
  street: EdgeFlags;
  /** Fraction of the edge that is a party wall. */
  party: number;
  /** False when the wall on this edge was dropped entirely (covered by a flush, taller part of the same building). */
  exposed: boolean;
}

export interface BuildingGeo {
  rec: BuildingRecord;
  index: number;
  rings: XZ[][];
  style: StyleParams;
  base: number;
  /** Top of the walls (eave for pitched roofs). */
  wallTop: number;
  top: number;
  bottom: number;
  roofY: number;
  parapet: boolean;
  /** Inset rings of the parapet (same order as rings), when parapet. */
  inner: XZ[][] | null;
  edges: EdgeInfo[];
  area: number;
  rand: () => number;
  /** Roof hidden inside a same-height containing part of the same building (avoids coplanar z-fighting). */
  skipRoof: boolean;
  /** Outer rings of taller parts of the same building overlapping this roof (keep clutter out). */
  blockers: XZ[][];
  /** Bay-window spans per ring-0 edge index ([t0, t1] metres along the edge), set by ornaments. */
  bays: Map<number, [number, number][]>;
}

export interface CityGeometry {
  wallsCore: THREE.BufferGeometry;
  wallsContext: THREE.BufferGeometry;
  props: THREE.BufferGeometry;
  /** Fire-escape railings / stairs (alpha-cut). */
  railings: THREE.BufferGeometry;
  styleData: Float32Array;
  /** Per building: [wallMesh (0 core, 1 context), wallIndexStart, wallIndexCount, propIndexStart, propIndexCount]. */
  ranges: Int32Array;
  /** Per building AABB: minX, minY, minZ, maxX, maxY, maxZ. */
  bounds: Float32Array;
  /** Per building pivot: centreX, centreZ, base, height. */
  pivots: Float32Array;
  stats: { wallTris: number; propTris: number; ms: number };
}

/** Build-time prop triangle budget by category (logged by index.ts). */
export const triBudget = { ornaments: 0, roof: 0, props: 0 };

const PITCHED = new Set(['gabled', 'hipped', 'pyramidal', 'half-hipped', 'gambrel', 'mansard']);

export function buildCityGeometry(buildings: BuildingRecord[], roads: RoadRecord[], terrain: Heightfield): CityGeometry {
  const t0 = performance.now();
  const N = buildings.length;

  // ── 1. Group styles (all parts of a building share one look, from its tallest piece) ──
  const groupOf = (b: BuildingRecord) => b.parentId ?? b.id;
  const tallest = new Map<string, BuildingRecord>();
  for (const b of buildings) {
    const g = groupOf(b);
    const t = tallest.get(g);
    if (!t || b.height > t.height) tallest.set(g, b);
  }
  const groupStyle = new Map<string, StyleParams>();
  for (const [g, b] of tallest) groupStyle.set(g, applyIconic(b, computeStyle(b, hashString(g))));

  // ── 2. Solids ──
  const geos: BuildingGeo[] = [];
  const solids: Solid[] = [];
  for (let i = 0; i < N; i++) {
    const rec = buildings[i];
    const outer = cleanRing(rec.footprint, true);
    const rings: XZ[][] = outer.length >= 3 ? [outer] : [];
    if (rings.length && rec.holes) for (const h of rec.holes) {
      const r = cleanRing(h, false);
      if (r.length >= 3) rings.push(r);
    }
    const style = groupStyle.get(groupOf(rec))!;
    const base = rec.baseElevation;
    const top = base + Math.max(rec.height, 1);
    const minH = rec.minHeight ?? 0;
    const sink = rec.overWater ? (base < 0.5 ? 0.3 : 0.8) : SINK;
    const bottom = minH > 0.3 ? base + minH : base - sink;
    const shape = (rec.roofShape ?? '').toLowerCase();
    const area = rings.length ? Math.abs(signedArea(rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(signedArea(r)), 0) : 0;
    let wallTop = top;
    if (rings.length && PITCHED.has(shape)) {
      const roofH = Math.min(Math.max(2, thickness(rings[0]) * 0.45), (top - bottom) * 0.45, 9);
      wallTop = top - roofH;
    } else if (rings.length && shape === 'dome') {
      const domeH = Math.min(Math.sqrt(area / Math.PI) * 0.8, (top - bottom) * 0.5);
      wallTop = top - domeH;
    }
    const rand = mulberry(hashString(rec.id) ^ 0x9e3779b9);
    const g: BuildingGeo = { rec, index: i, rings, style, base, wallTop, top, bottom, roofY: wallTop, parapet: false, inner: null, edges: [], area, rand, skipRoof: false, blockers: [], bays: new Map() };
    geos.push(g);
    if (rings.length) solids.push({ bld: i, group: groupOf(rec), rings, bottom, top: wallTop });
  }

  // ── 2b. Same-building parts: coplanar roofs and clutter blockers ──
  const byGroup = new Map<string, BuildingGeo[]>();
  for (const g of geos) if (g.rings.length) {
    const k = groupOf(g.rec);
    let arr = byGroup.get(k);
    if (!arr) byGroup.set(k, (arr = []));
    arr.push(g);
  }
  for (const parts of byGroup.values()) {
    if (parts.length < 2) continue;
    for (const a of parts) {
      const ca = centroid(a.rings[0]);
      for (const b of parts) {
        if (a === b) continue;
        const contains = pointInRing(ca[0], ca[1], b.rings[0]);
        if (Math.abs(a.wallTop - b.wallTop) < 0.06 && contains && (b.area > a.area || (b.area === a.area && b.index < a.index))) a.skipRoof = true;
        if (b.wallTop > a.wallTop + 0.5 && ringsOverlap(a.rings[0], b.rings[0])) a.blockers.push(b.rings[0]);
      }
    }
  }

  // ── 3. Wall analysis (coplanar suppression + party walls) and street frontage ──
  const pieces = analyseWalls(solids);
  const piecesOf: WallPiece[][] = Array.from({ length: N }, () => []);
  for (const p of pieces) piecesOf[p.bld].push(p);
  const streetOf = createStreetClassifier(roads);
  for (const g of geos) {
    const partyLen = new Map<string, number>();
    // Edge length fraction whose wall survives up to (near) the top.
    const topLen = new Map<string, number>();
    for (const p of piecesOf[g.index]) {
      const k = `${p.ring}:${p.edge}`;
      // Party fraction counts only lot-line walls that reach (nearly) our roof: blank to the top.
      if (p.partyTop > g.wallTop - 3) partyLen.set(k, (partyLen.get(k) ?? 0) + (p.t1 - p.t0));
      if (p.bottom < g.wallTop - 1.5) topLen.set(k, (topLen.get(k) ?? 0) + (p.t1 - p.t0));
    }
    g.rings.forEach((ring, r) => {
      for (let e = 0; e < ring.length; e++) {
        const a = ring[e];
        const b = ring[(e + 1) % ring.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const party = partyLen.get(`${r}:${e}`) ?? 0;
        const street = r === 0 && party < 0.5 ? streetOf(a, b) : { street: false, streetDist: 0 };
        const exposed = (topLen.get(`${r}:${e}`) ?? 0) > 0.6;
        g.edges.push({ ring: r, edge: e, a, b, len, n: edgeNormal(a, b), street, party, exposed });
      }
    });
  }

  // ── 4. Emit geometry per building (contiguous ranges for picking) ──
  const core = new WallBuilder();
  const ctxw = new WallBuilder();
  const props = new PropBuilder();
  const rails = new PropBuilder();
  const styleData = new Float32Array(N * STYLE_TEXELS * 4);
  const ranges = new Int32Array(N * 5);
  const bounds = new Float32Array(N * 6);
  const pivots = new Float32Array(N * 4);

  for (const g of geos) {
    const i = g.index;
    const rec = g.rec;
    packStyle(g.style, styleData, i * STYLE_TEXELS * 4);
    const W = rec.context ? ctxw : core;
    const c = g.rings.length ? centroid(g.rings[0]) : ([0, 0] as XZ);
    pivots.set([c[0], c[1], g.base, Math.max(rec.height, 1)], i * 4);
    const wStart = W.indexCount;
    const pStart = props.indexCount;

    if (g.rings.length) {
      decideParapet(g);
      emitWalls(W, g, piecesOf[i], terrain);
      let t = props.indexCount;
      addOrnaments(W, props, g, terrain);
      triBudget.ornaments += (props.indexCount - t) / 3;
      t = props.indexCount;
      emitRoof(W, props, g);
      triBudget.roof += (props.indexCount - t) / 3;
      t = props.indexCount;
      addProps(props, rails, g, terrain);
      triBudget.props += (props.indexCount - t) / 3;
    }

    ranges.set([rec.context ? 1 : 0, wStart, W.indexCount - wStart, pStart, props.indexCount - pStart], i * 5);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of g.rings[0] ?? [[c[0], c[1]]]) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    bounds.set([minX - 2, g.bottom, minZ - 2, maxX + 2, g.top + (rec.height > 60 ? 20 : 6), maxZ + 2], i * 6);
  }

  const wallsCore = core.build();
  const wallsContext = ctxw.build();
  const propsGeo = props.build();
  return {
    wallsCore,
    wallsContext,
    props: propsGeo,
    railings: rails.build(),
    styleData,
    ranges,
    bounds,
    pivots,
    stats: { wallTris: (core.indexCount + ctxw.indexCount) / 3, propTris: (props.indexCount + rails.indexCount) / 3, ms: performance.now() - t0 },
  };
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flat roofs of reasonably sized buildings get a parapet ring; the roof deck sits below its top. */
function decideParapet(g: BuildingGeo) {
  const shape = (g.rec.roofShape ?? '').toLowerCase();
  if (g.wallTop < g.top - 0.01) return; // pitched / dome
  if (g.rec.overWater && g.rec.height < 4) return;
  const outer = g.rings[0];
  const th = thickness(outer);
  if (th < 3.2 || g.area < 25 || g.wallTop - g.bottom < 3.5 || shape === 'skillion') return;
  // Small context-ring houses: a parapet rim is invisible from where they are seen; save the triangles.
  if (g.rec.context && g.rec.height < 14 && g.area < 220) return;
  const d = g.rec.height > 60 ? 0.45 : g.rec.height > 15 ? 0.36 : 0.28;
  const inner: XZ[][] = [];
  for (const r of g.rings) {
    const off = offsetRing(r, -d);
    const a0 = signedArea(r);
    const a1 = signedArea(off);
    // Reject insets that flipped or collapsed (thin / spiky rings).
    if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) > Math.abs(a0) || Math.abs(a1) < Math.abs(a0) * 0.35) return;
    inner.push(off);
  }
  g.parapet = true;
  g.inner = inner;
  g.roofY = g.wallTop - g.style.parapetH;
}

function emitWalls(W: WallBuilder, g: BuildingGeo, pieces: WallPiece[], terrain: Heightfield) {
  const ground = (x: number, z: number) => (g.rec.overWater ? g.base : terrain.heightAt(x, z));
  for (const p of pieces) {
    const info = g.edges.find((e) => e.ring === p.ring && e.edge === p.edge);
    if (!info) continue;
    const { a, b, len, n } = info;
    const ax = a[0] + (b[0] - a[0]) * p.t0;
    const az = a[1] + (b[1] - a[1]) * p.t0;
    const bx = a[0] + (b[0] - a[0]) * p.t1;
    const bz = a[1] + (b[1] - a[1]) * p.t1;
    const s0 = p.t0 * len;
    const s1 = p.t1 * len;
    const key = ((hashString(`${g.rec.id}:${p.ring}:${p.edge}`) % 10007) / 10007) * 997;
    // aFlags: party(1) + street(2) + 4*kind + 16*round(2*(neighbour roof - base)).
    const party = p.partyTop > 0;
    const partyRel = party ? Math.max(0, Math.round((p.partyTop - g.base) * 2)) : 0;
    const flags = (party ? 1 : 0) + (info.street.street && !party ? 2 : 0) + 16 * partyRel;
    const ga = ground(ax, az);
    const gb = ground(bx, bz);
    const y0 = p.bottom;
    const y1 = g.wallTop;
    const i0 = W.vertex(ax, y0, az, n[0], 0, n[1], g.index, s0, len, key, ga, flags);
    const i1 = W.vertex(bx, y0, bz, n[0], 0, n[1], g.index, s1, len, key, gb, flags);
    const i2 = W.vertex(bx, y1, bz, n[0], 0, n[1], g.index, s1, len, key, gb, flags);
    const i3 = W.vertex(ax, y1, az, n[0], 0, n[1], g.index, s0, len, key, ga, flags);
    W.quad(i0, i1, i2, i3, n[0], 0, n[1]);
  }
}

function emitRoof(W: WallBuilder, P: PropBuilder, g: BuildingGeo) {
  const s = g.style;
  const shape = (g.rec.roofShape ?? '').toLowerCase();
  const roofCol = s.roof;
  const rnd = g.rand();
  if (g.wallTop < g.top - 0.01) {
    if (shape === 'dome') emitDome(P, g);
    else emitPitched(W, P, g, shape);
  } else {
    if (!g.skipRoof) emitFlat(P, g.rings, g.roofY, g.index, roofCol, PropKind.Roof, rnd, true);
  }
  // Underside of parts that start above the ground.
  if ((g.rec.minHeight ?? 0) > 0.3) emitFlat(P, g.rings, g.bottom, g.index, s.base.clone().multiplyScalar(0.6), PropKind.Soffit, rnd, false);

  if (g.parapet && g.inner && !g.skipRoof) {
    const capCol = capColour(s);
    const innerCol = s.style === Style.ModernGlass ? s.base.clone().multiplyScalar(0.55) : s.base.clone().multiplyScalar(0.82);
    // Coping: a stone / metal cap slightly proud of the wall with a drip edge (casts a crisp shadow line).
    // Context ring: flush cap (no overhang / drip) — invisible at the distances it is seen from.
    const ctxCheap = !!g.rec.context;
    const over = ctxCheap ? 0 : s.style === Style.ModernGlass || s.style === Style.Midcentury ? 0.03 : 0.06;
    const capT = ctxCheap ? 0 : s.style === Style.ModernGlass || s.style === Style.Midcentury ? 0.05 : 0.08;
    const yW = g.wallTop;
    const yC = yW + capT;
    g.rings.forEach((ring, r) => {
      const inner = g.inner![r];
      const outer = over > 0 ? offsetRing(ring, over) : ring;
      for (let e = 0; e < ring.length; e++) {
        const e1 = (e + 1) % ring.length;
        const a = ring[e];
        const b = ring[e1];
        const ia = inner[e];
        const ib = inner[e1];
        const oa = outer[e];
        const ob = outer[e1];
        const n = edgeNormal(a, b);
        const l = Math.hypot(ib[0] - ia[0], ib[1] - ia[1]);
        // Inner face (faces the roof deck), up to the underside of the cap.
        const y0 = g.roofY - 0.05;
        const v0 = P.vertex(ia[0], y0, ia[1], -n[0], 0, -n[1], g.index, innerCol.r, innerCol.g, innerCol.b, PropKind.ParapetInner, 0, 0, rnd);
        const v1 = P.vertex(ib[0], y0, ib[1], -n[0], 0, -n[1], g.index, innerCol.r, innerCol.g, innerCol.b, PropKind.ParapetInner, l, 0, rnd);
        const v2 = P.vertex(ib[0], yC, ib[1], -n[0], 0, -n[1], g.index, innerCol.r, innerCol.g, innerCol.b, PropKind.ParapetInner, l, yC - y0, rnd);
        const v3 = P.vertex(ia[0], yC, ia[1], -n[0], 0, -n[1], g.index, innerCol.r, innerCol.g, innerCol.b, PropKind.ParapetInner, 0, yC - y0, rnd);
        P.quad(v0, v1, v2, v3, -n[0], 0, -n[1]);
        // Cap top.
        const c0 = P.vertex(oa[0], yC, oa[1], 0, 1, 0, g.index, capCol.r, capCol.g, capCol.b, PropKind.ParapetCap, oa[0], oa[1], rnd);
        const c1 = P.vertex(ob[0], yC, ob[1], 0, 1, 0, g.index, capCol.r, capCol.g, capCol.b, PropKind.ParapetCap, ob[0], ob[1], rnd);
        const c2 = P.vertex(ib[0], yC, ib[1], 0, 1, 0, g.index, capCol.r, capCol.g, capCol.b, PropKind.ParapetCap, ib[0], ib[1], rnd);
        const c3 = P.vertex(ia[0], yC, ia[1], 0, 1, 0, g.index, capCol.r, capCol.g, capCol.b, PropKind.ParapetCap, ia[0], ia[1], rnd);
        P.quad(c0, c1, c2, c3, 0, 1, 0);
        // Drip face of the overhang (crisp shadow line under the coping).
        if (ctxCheap) continue;
        const lo = Math.hypot(ob[0] - oa[0], ob[1] - oa[1]);
        const yD = yW - 0.03;
        const d0 = P.vertex(oa[0], yD, oa[1], n[0], 0, n[1], g.index, capCol.r, capCol.g, capCol.b, PropKind.ParapetCap, 0, 0, rnd);
        const d1 = P.vertex(ob[0], yD, ob[1], n[0], 0, n[1], g.index, capCol.r, capCol.g, capCol.b, PropKind.ParapetCap, lo, 0, rnd);
        const d2 = P.vertex(ob[0], yC, ob[1], n[0], 0, n[1], g.index, capCol.r, capCol.g, capCol.b, PropKind.ParapetCap, lo, capT, rnd);
        const d3 = P.vertex(oa[0], yC, oa[1], n[0], 0, n[1], g.index, capCol.r, capCol.g, capCol.b, PropKind.ParapetCap, 0, capT, rnd);
        P.quad(d0, d1, d2, d3, n[0], 0, n[1]);
      }
    });
  }
}

export function capColour(s: StyleParams): THREE.Color {
  switch (s.style) {
    case Style.ModernGlass:
    case Style.Midcentury:
      return new THREE.Color('#8d9195');
    case Style.Chinatown:
      return s.trim.clone().lerp(new THREE.Color('#d8d2c4'), 0.5);
    case Style.PrewarOffice:
      return s.base.clone().multiplyScalar(0.92);
    default:
      return new THREE.Color('#b3ada2').lerp(s.base, 0.3);
  }
}

/** Triangulated horizontal polygon (with holes). */
export function emitFlat(P: PropBuilder, rings: XZ[][], y: number, bld: number, col: THREE.Color, kind: number, rnd: number, up: boolean) {
  const contour = rings[0].map(([x, z]) => new THREE.Vector2(x, z));
  const holes = rings.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return;
  }
  const all = [...contour, ...holes.flat()];
  const ny = up ? 1 : -1;
  const ids = all.map((p) => P.vertex(p.x, y, p.y, 0, ny, 0, bld, col.r, col.g, col.b, kind, p.x, p.y, rnd));
  for (const f of faces) P.tri(ids[f[0]], ids[f[1]], ids[f[2]], 0, ny, 0);
}

/** Pyramid / hip / gable roofs. Gable end triangles go into the wall mesh so they get the facade. */
function emitPitched(W: WallBuilder, P: PropBuilder, g: BuildingGeo, shape: string) {
  const ring = g.rings[0];
  const col = g.style.roof.clone();
  if (g.style.roofKind < 3) col.set('#6d5547').lerp(g.style.roof, 0.3); // shingles / tiles read darker
  const rnd = g.rand();
  const y0 = g.wallTop;
  const y1 = g.top;
  const rect = ring.length === 4;
  if (rect && (shape === 'gabled' || shape === 'hipped' || shape === 'half-hipped')) {
    // Ridge along the longer axis.
    const e0 = Math.hypot(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]);
    const e1 = Math.hypot(ring[2][0] - ring[1][0], ring[2][1] - ring[1][1]);
    const k = e0 >= e1 ? 0 : 1; // edges k and k+2 are the long sides
    const A = ring[k], B = ring[k + 1], C = ring[(k + 2) % 4], D = ring[(k + 3) % 4];
    const mid = (p: XZ, q: XZ): XZ => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    let r0 = mid(D, A);
    let r1 = mid(B, C);
    if (shape !== 'gabled') {
      const inset = Math.min(e0, e1) * 0.5;
      const dx = r1[0] - r0[0], dz = r1[1] - r0[1];
      const l = Math.hypot(dx, dz) || 1;
      const f = Math.min(inset / l, 0.45);
      r0 = [r0[0] + dx * f, r0[1] + dz * f];
      r1 = [r1[0] - dx * f, r1[1] - dz * f];
    }
    const slope = (p: XZ, q: XZ, rA: XZ, rB: XZ) => {
      // Quad p,q (eave) to rB,rA (ridge).
      const v = [p, q].map((e) => [e[0], y0, e[1]] as const).concat([rB, rA].map((e) => [e[0], y1, e[1]] as const));
      const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
      const wx = v[3][0] - v[0][0], wy = v[3][1] - v[0][1], wz = v[3][2] - v[0][2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const ids = v.map((p) => P.vertex(p[0], p[1], p[2], nx, ny, nz, g.index, col.r, col.g, col.b, PropKind.TileRoof, p[0], p[2], rnd));
      P.quad(ids[0], ids[1], ids[2], ids[3], nx, ny, nz);
    };
    slope(A, B, r0, r1);
    slope(C, D, r1, r0);
    if (shape === 'gabled') {
      // Gable walls (facade material).
      for (const [p, q, r] of [[B, C, r1], [D, A, r0]] as [XZ, XZ, XZ][]) {
        const n = edgeNormal(p, q);
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const flags = 4 * 3;
        const i0 = W.vertex(p[0], y0, p[1], n[0], 0, n[1], g.index, 0, L, 1, g.base, flags);
        const i1 = W.vertex(q[0], y0, q[1], n[0], 0, n[1], g.index, L, L, 1, g.base, flags);
        const i2 = W.vertex(r[0], y1, r[1], n[0], 0, n[1], g.index, L / 2, L, 1, g.base, flags);
        W.tri(i0, i1, i2, n[0], 0, n[1]);
      }
    } else {
      for (const [p, q, r] of [[B, C, r1], [D, A, r0]] as [XZ, XZ, XZ][]) triFace(P, g, col, rnd, [p[0], y0, p[1]], [q[0], y0, q[1]], [r[0], y1, r[1]]);
    }
    return;
  }
  // Pyramid over any ring (apex at centroid).
  const c = centroid(ring);
  for (let e = 0; e < ring.length; e++) {
    const a = ring[e];
    const b = ring[(e + 1) % ring.length];
    triFace(P, g, col, rnd, [a[0], y0, a[1]], [b[0], y0, b[1]], [c[0], y1, c[1]]);
  }
}

function triFace(P: PropBuilder, g: BuildingGeo, col: THREE.Color, rnd: number, a: number[], b: number[], c: number[]) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const ids = [a, b, c].map((p) => P.vertex(p[0], p[1], p[2], nx, ny, nz, g.index, col.r, col.g, col.b, PropKind.TileRoof, p[0], p[2], rnd));
  P.tri(ids[0], ids[1], ids[2], nx, ny, nz);
}

function emitDome(P: PropBuilder, g: BuildingGeo) {
  const ring = g.rings[0];
  const c = centroid(ring);
  const col = g.style.roof.clone().lerp(new THREE.Color('#8a9a8c'), 0.5);
  const rnd = g.rand();
  const H = g.top - g.wallTop;
  const STEPS = 6;
  let prev: number[] = [];
  for (let k = 0; k <= STEPS; k++) {
    const ang = (k / STEPS) * (Math.PI / 2);
    const sc = Math.cos(ang);
    const y = g.wallTop + Math.sin(ang) * H;
    const cur = ring.map(([x, z]) => {
      const px = c[0] + (x - c[0]) * sc;
      const pz = c[1] + (z - c[1]) * sc;
      const rx = x - c[0], rz = z - c[1];
      const rl = Math.hypot(rx, rz) || 1;
      const nx = (rx / rl) * Math.cos(ang), ny = Math.sin(ang), nz = (rz / rl) * Math.cos(ang);
      return P.vertex(px, y, pz, nx, ny, nz, g.index, col.r, col.g, col.b, PropKind.Dome, px, y, rnd);
    });
    if (k > 0) {
      const am = ((k - 0.5) / STEPS) * (Math.PI / 2);
      for (let e = 0; e < ring.length; e++) {
        const e1 = (e + 1) % ring.length;
        const mx = (ring[e][0] + ring[e1][0]) / 2 - c[0];
        const mz = (ring[e][1] + ring[e1][1]) / 2 - c[1];
        const ml = Math.hypot(mx, mz) || 1;
        P.quad(prev[e], prev[e1], cur[e1], cur[e], (mx / ml) * Math.cos(am), Math.sin(am), (mz / ml) * Math.cos(am));
      }
    }
    prev = cur;
  }
}

/** Cheap overlap test for two rings: bbox overlap plus any vertex of one inside the other. */
function ringsOverlap(a: XZ[], b: XZ[]): boolean {
  const bb = (r: XZ[]) => r.reduce((m, [x, z]) => [Math.min(m[0], x), Math.min(m[1], z), Math.max(m[2], x), Math.max(m[3], z)], [Infinity, Infinity, -Infinity, -Infinity]);
  const A = bb(a);
  const B = bb(b);
  if (A[2] < B[0] || B[2] < A[0] || A[3] < B[1] || B[3] < A[1]) return false;
  return b.some(([x, z]) => pointInRing(x, z, a)) || a.some(([x, z]) => pointInRing(x, z, b));
}
