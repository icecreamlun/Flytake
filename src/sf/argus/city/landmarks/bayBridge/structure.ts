/**
 * Bay Bridge structure: steel towers with stacked X-bracing on concrete caissons, the double-deck
 * Warren stiffening truss, concrete anchorages (Rincon Hill, Center, Yerba Buena) and the W1 cable bent,
 * main cables as parabolic catenaries, vertical suspenders, approach viaduct bents.
 * Geometry is expressed relative to `origin` (the bridge pivot) to keep coordinates small.
 */
import * as THREE from 'three';
import type { XZ } from '../../../contracts';
import type { PartBuilder } from '../common/builder';
import { beam, box, cyl, hexa, quadUV, tube } from '../common/geom';
import { APPROACH_END, CENTER_SIZE, DIM, S, deckY, lateral, pos } from './path';

export interface Suspender {
  top: THREE.Vector3;
  bottom: THREE.Vector3;
  /** Lateral side: -1 = north-west (city side), +1 = south-east. */
  side: number;
  s: number;
}

export interface StructureOut {
  suspenders: Suspender[];
  /** Points for night lights. */
  roadLamps: THREE.Vector3[];
  lowerLamps: THREE.Vector3[];
  beacons: THREE.Vector3[];
}

const C = {
  steel: '#aeb3b6',
  concrete: '#bdb7aa',
  road: '#ffffff',
};

/**
 * `towerBuilder(s)` may return a separate PartBuilder for the tower at station s (so it can get its
 * own pivot for quake motion); otherwise towers go into `b`.
 */
export function buildStructure(
  b: PartBuilder,
  origin: XZ,
  ground: (x: number, z: number) => number,
  towerBuilder?: (s: number) => PartBuilder | null,
): StructureOut {
  const V = (s: number, lat: number, y: number) => {
    const [x, z] = pos(s);
    const [nx, nz] = lateral(s);
    return new THREE.Vector3(x + nx * lat - origin[0], y, z + nz * lat - origin[1]);
  };
  const groundAt = (s: number, lat = 0) => {
    const v = V(s, lat, 0);
    return ground(v.x + origin[0], v.z + origin[1]);
  };
  const out: StructureOut = { suspenders: [], roadLamps: [], lowerLamps: [], beacons: [] };
  const H = DIM.cableHalf;

  /** A block aligned with the bridge axis at station s: `along` × `across`, from y0 to y1. */
  const blockIn = (pb: PartBuilder, key: string, s: number, along: number, across: number, y0: number, y1: number, latC = 0, color = C.concrete) => {
    const c: THREE.Vector3[] = [];
    for (const y of [y0, y1]) {
      c.push(V(s - along / 2, latC - across / 2, y), V(s + along / 2, latC - across / 2, y), V(s + along / 2, latC + across / 2, y), V(s - along / 2, latC + across / 2, y));
    }
    pb.add(key, hexa(c), { color });
  };
  const block = (key: string, s: number, along: number, across: number, y0: number, y1: number, latC = 0, color = C.concrete) =>
    blockIn(b, key, s, along, across, y0, y1, latC, color);

  // ── Double-deck stiffening truss + road decks ──
  const truss = (s0: number, s1: number, approach = false) => {
    const n = Math.max(1, Math.round((s1 - s0) / DIM.panel));
    const ds = (s1 - s0) / n;
    for (let i = 0; i < n; i++) {
      const sa = s0 + i * ds;
      const sb = sa + ds;
      const ya = deckY(sa);
      const yb = deckY(sb);
      for (const side of [-1, 1]) {
        const lat = side * H;
        const tA = V(sa, lat, ya + 1.4);
        const tB = V(sb, lat, yb + 1.4);
        const bA = V(sa, lat, ya + 1.4 - DIM.trussDepth);
        const bB = V(sb, lat, yb + 1.4 - DIM.trussDepth);
        b.add('steel', beam(tA, tB, 0.8, 1.0), { color: C.steel });
        b.add('steel', beam(bA, bB, 0.8, 1.0), { color: C.steel });
        b.add('steel', beam(tA, bA, 0.5, 0.5), { color: C.steel });
        if (!approach) b.add('steel', i % 2 ? beam(tA, bB, 0.42, 0.42) : beam(bA, tB, 0.42, 0.42), { color: C.steel });
        else b.add('steel', hexa([V(sa, lat - 0.15, ya - DIM.deckGap - 1.2), V(sb, lat - 0.15, yb - DIM.deckGap - 1.2), V(sb, lat + 0.15, yb - DIM.deckGap - 1.2), V(sa, lat + 0.15, ya - DIM.deckGap - 1.2), V(sa, lat - 0.15, ya + 1.2), V(sb, lat - 0.15, yb + 1.2), V(sb, lat + 0.15, yb + 1.2), V(sa, lat + 0.15, ya + 1.2)]), { color: C.steel });
      }
      // Decks: concrete slab + asphalt surface with lane markings (upper), plain (lower).
      for (const [dy, top] of [
        [0, true],
        [-DIM.deckGap, false],
      ] as const) {
        const w = H - 0.6;
        const y0a = ya + dy;
        const y0b = yb + dy;
        b.add(
          'deck',
          hexa([V(sa, -w, y0a - 0.6), V(sb, -w, y0b - 0.6), V(sb, w, y0b - 0.6), V(sa, w, y0a - 0.6), V(sa, -w, y0a - 0.02), V(sb, -w, y0b - 0.02), V(sb, w, y0b - 0.02), V(sa, w, y0a - 0.02)]),
          { color: C.concrete },
        );
        if (top) {
          b.add('road', quadUV([V(sa, -w, y0a), V(sa, w, y0a), V(sb, w, y0b), V(sb, -w, y0b)], [
            [0, sa],
            [1, sa],
            [1, sb],
            [0, sb],
          ]), { uv: 'keep', color: C.road });
        }
        // Floor beam under the deck at this station.
        b.add('steel', beam(V(sa, -H, y0a - 1.0), V(sa, H, y0a - 1.0), 0.45, 0.8), { color: C.steel });
      }
      // Lamps.
      if (i % 3 === 0) for (const side of [-1, 1]) out.roadLamps.push(V(sa, side * (H - 1.2), ya + 5.5));
      if (i % 2 === 0) out.lowerLamps.push(V(sa, 0, ya - DIM.deckGap + 5.2));
    }
  };

  // ── Tower: caisson pier, tapered legs, stacked X-bracing, top portal, saddle housings ──
  const tower = (s: number) => {
    const tb = towerBuilder?.(s) ?? b;
    const yd = deckY(s);
    blockIn(tb, 'concrete', s, 16, 36, -6, DIM.pierTop + 0.5);
    for (const side of [-1, 1]) tb.add('concrete', cyl(8, 8, DIM.pierTop + 6.5, 16, V(s, side * 18, 0).x, -6, V(s, side * 18, 0).z), { color: C.concrete });
    const legC = (side: number, y: number, inset: number) => {
      const k = (y - DIM.pierTop) / (DIM.towerTop - DIM.pierTop);
      const along = 9.5 - 3.0 * k - inset;
      const across = 5.4 - 1.2 * k - inset;
      const lat = side * H;
      return [V(s - along / 2, lat - across / 2, y), V(s + along / 2, lat - across / 2, y), V(s + along / 2, lat + across / 2, y), V(s - along / 2, lat + across / 2, y)];
    };
    for (const side of [-1, 1]) {
      tb.add('steel', hexa([...legC(side, DIM.pierTop, 0), ...legC(side, DIM.towerTop - 3, 0)]), { color: C.steel });
      // Saddle housing on top.
      tb.add('steel', hexa([...legC(side, DIM.towerTop - 3, -0.6), ...legC(side, DIM.towerTop, 0.4)]), { color: C.steel });
      out.beacons.push(V(s, side * H, DIM.towerTop + 0.8));
    }
    const inner = H - 2.3;
    const panel = (y0: number, y1: number) => {
      for (const a of [-2.4, 2.4]) {
        tb.add('steel', beam(V(s + a, -inner, y0), V(s + a, inner, y1), 1.1, 1.1), { color: C.steel });
        tb.add('steel', beam(V(s + a, inner, y0), V(s + a, -inner, y1), 1.1, 1.1), { color: C.steel });
      }
      tb.add('steel', hexa([V(s - 3.5, -inner, y1 - 1.6), V(s + 3.5, -inner, y1 - 1.6), V(s + 3.5, inner, y1 - 1.6), V(s - 3.5, inner, y1 - 1.6), V(s - 3.5, -inner, y1 + 1.6), V(s + 3.5, -inner, y1 + 1.6), V(s + 3.5, inner, y1 + 1.6), V(s - 3.5, inner, y1 + 1.6)]), { color: C.steel });
    };
    const above0 = yd + 4;
    const above1 = DIM.towerTop - 8;
    const nA = 3;
    for (let k = 0; k < nA; k++) panel(above0 + ((above1 - above0) * k) / nA, above0 + ((above1 - above0) * (k + 1)) / nA);
    const below0 = DIM.pierTop + 1;
    const below1 = yd - DIM.trussDepth - 1;
    panel(below0, (below0 + below1) / 2);
    panel((below0 + below1) / 2, below1);
    // Top portal strut (deep) between the saddles.
    tb.add('steel', hexa([V(s - 3.6, -inner, DIM.towerTop - 9), V(s + 3.6, -inner, DIM.towerTop - 9), V(s + 3.6, inner, DIM.towerTop - 9), V(s - 3.6, inner, DIM.towerTop - 9), V(s - 3.6, -inner, DIM.towerTop - 1), V(s + 3.6, -inner, DIM.towerTop - 1), V(s + 3.6, inner, DIM.towerTop - 1), V(s - 3.6, inner, DIM.towerTop - 1)]), { color: C.steel });
  };

  // ── Spans ──
  truss(APPROACH_END + 5, -32, true);
  truss(-32, S.center - CENTER_SIZE.along / 2 + 4);
  truss(S.center + CENTER_SIZE.along / 2 - 4, S.portal);
  for (const s of [S.t1, S.t2, S.t3, S.t4]) tower(s);

  // ── Center anchorage: caisson + Art-Deco fluted block; decks pass through it ──
  const ca = S.center;
  const caTop = 92;
  block('concrete', ca, CENTER_SIZE.along, CENTER_SIZE.across, -6, 12);
  block('concrete', ca, CENTER_SIZE.along - 7, CENTER_SIZE.across - 6, 12, caTop - 6);
  block('concrete', ca, CENTER_SIZE.along - 11, CENTER_SIZE.across - 10, caTop - 6, caTop);
  for (let k = -5; k <= 5; k++) {
    // Vertical pilaster ribs on the long faces.
    for (const side of [-1, 1]) block('concrete', ca + k * 5.4, 1.6, 1.4, 14, caTop - 7, side * ((CENTER_SIZE.across - 6) / 2 + 0.6));
  }
  for (const end of [-1, 1]) {
    // Dark portals where the decks run through the anchorage.
    const sf = ca + end * ((CENTER_SIZE.along - 7) / 2 + 0.05);
    for (const dy of [0, -DIM.deckGap]) {
      const y = deckY(sf) + dy;
      b.add('dark', hexa([V(sf - 0.2, -H + 0.3, y - 1), V(sf + 0.2, -H + 0.3, y - 1), V(sf + 0.2, H - 0.3, y - 1), V(sf - 0.2, H - 0.3, y - 1), V(sf - 0.2, -H + 0.3, y + 6.4), V(sf + 0.2, -H + 0.3, y + 6.4), V(sf + 0.2, H - 0.3, y + 6.4), V(sf - 0.2, H - 0.3, y + 6.4)]), { color: '#1b1b1b' });
    }
    for (const side of [-1, 1]) out.beacons.push(V(ca + end * 26, side * 14, caTop + 0.8));
  }

  // ── Rincon Hill anchorage (SF) ──
  const rg = Math.min(groundAt(0, -18), groundAt(0, 18), groundAt(-25, 0), groundAt(25, 0));
  block('concrete', 0, 58, 40, rg - 2, 53);
  block('concrete', 0, 52, 34, 53, 57);
  for (let k = -4; k <= 4; k++) for (const side of [-1, 1]) block('concrete', k * 6, 1.4, 1.2, rg, 52, side * 20.4);
  // Piers between the anchorage and W1.
  for (const s of [95, 190]) {
    const yb = deckY(s) + 1.4 - DIM.trussDepth;
    for (const side of [-1, 1]) {
      const c = V(s, side * 7.5, 0);
      b.add('concrete', cyl(1.6, 1.9, yb + 6, 10, c.x, -6, c.z), { color: C.concrete });
    }
    block('concrete', s, 3.2, 22, yb - 2.2, yb);
  }
  // W1: concrete pier + steel cable bent.
  const w1 = S.w1;
  block('concrete', w1, 14, 32, -6, deckY(w1) + 1.4 - DIM.trussDepth);
  for (const side of [-1, 1]) {
    const lat = side * H;
    b.add('steel', hexa([V(w1 - 2.5, lat - 1.6, deckY(w1) - 10), V(w1 + 2.5, lat - 1.6, deckY(w1) - 10), V(w1 + 2.5, lat + 1.6, deckY(w1) - 10), V(w1 - 2.5, lat + 1.6, deckY(w1) - 10), V(w1 - 2, lat - 1.3, 76), V(w1 + 2, lat - 1.3, 76), V(w1 + 2, lat + 1.3, 76), V(w1 - 2, lat + 1.3, 76)]), { color: C.steel });
    out.beacons.push(V(w1, lat, 77));
  }
  b.add('steel', hexa([V(w1 - 2, -H, 70), V(w1 + 2, -H, 70), V(w1 + 2, H, 70), V(w1 - 2, H, 70), V(w1 - 2, -H, 74), V(w1 + 2, -H, 74), V(w1 + 2, H, 74), V(w1 - 2, H, 74)]), { color: C.steel });

  // ── Yerba Buena Island anchorage + tunnel portal ──
  const yg = Math.min(groundAt(S.ybi, -18), groundAt(S.ybi, 18), groundAt(S.ybi - 20, 0));
  block('concrete', S.ybi, 44, 40, yg - 3, 72);
  for (let k = -3; k <= 3; k++) for (const side of [-1, 1]) block('concrete', S.ybi + k * 6, 1.4, 1.2, yg, 70, side * 20.4);
  const pg = groundAt(S.portal, 0);
  block('concrete', S.portal + 3, 8, 34, Math.min(pg, deckY(S.portal) - 14), deckY(S.portal) + 9);
  for (const dy of [0, -DIM.deckGap]) {
    const y = deckY(S.portal) + dy;
    b.add('dark', hexa([V(S.portal - 1.05, -8, y - 0.5), V(S.portal - 0.95, -8, y - 0.5), V(S.portal - 0.95, 8, y - 0.5), V(S.portal - 1.05, 8, y - 0.5), V(S.portal - 1.05, -8, y + 6), V(S.portal - 0.95, -8, y + 6), V(S.portal - 0.95, 8, y + 6), V(S.portal - 1.05, 8, y + 6)]), { color: '#151515' });
  }
  // Truss piers on YBI between the anchorage and the portal.
  for (const s of [3225, 3265]) {
    const yb = deckY(s) + 1.4 - DIM.trussDepth;
    const g0 = groundAt(s, 0);
    if (yb > g0 + 1) for (const side of [-1, 1]) {
      const c = V(s, side * 7.5, 0);
      b.add('concrete', cyl(1.5, 1.8, yb - g0 + 3, 10, c.x, g0 - 3, c.z), { color: C.concrete });
    }
  }

  // ── Approach viaduct bents over SoMa ──
  for (let s = -45; s > APPROACH_END + 10; s -= 32) {
    const yb = deckY(s) - DIM.deckGap - 1.3;
    for (const side of [-1, 1]) {
      const c = V(s, side * 7.0, 0);
      const g0 = ground(c.x + origin[0], c.z + origin[1]);
      if (yb > g0 + 1) b.add('steel', box(1.4, yb - g0 + 2, 1.4, c.x, g0 - 2, c.z), { color: C.steel });
    }
    block('steel', s, 1.6, 2 * H + 2, yb - 1.6, yb, 0, C.steel);
  }

  // ── Main cables (parabolic) + suspenders ──
  const cableY = (s: number): number | null => {
    const span = (sa: number, ya: number, sb: number, yb: number, sag: number) => {
      const u = (s - sa) / (sb - sa);
      return ya + (yb - ya) * u - 4 * sag * u * (1 - u);
    };
    if (s >= 30 && s <= S.w1) return span(30, 44, S.w1, 76, 1.5);
    if (s > S.w1 && s <= S.t1) return span(S.w1, 76, S.t1, DIM.saddle, 6);
    if (s > S.t1 && s <= S.t2) {
      const low = deckY((S.t1 + S.t2) / 2) + 3.6;
      return span(S.t1, DIM.saddle, S.t2, DIM.saddle, DIM.saddle - low);
    }
    if (s > S.t2 && s <= S.center - 28) return span(S.t2, DIM.saddle, S.center - 28, 88, 6);
    if (s >= S.center + 28 && s <= S.t3) return span(S.center + 28, 88, S.t3, DIM.saddle, 6);
    if (s > S.t3 && s <= S.t4) {
      const low = deckY((S.t3 + S.t4) / 2) + 3.6;
      return span(S.t3, DIM.saddle, S.t4, DIM.saddle, DIM.saddle - low);
    }
    if (s > S.t4 && s <= S.ybi - 18) return span(S.t4, DIM.saddle, S.ybi - 18, 66, 6);
    return null;
  };
  const cableRuns: [number, number][] = [
    [30, S.w1],
    [S.w1, S.t1],
    [S.t1, S.t2],
    [S.t2, S.center - 28],
    [S.center + 28, S.t3],
    [S.t3, S.t4],
    [S.t4, S.ybi - 18],
  ];
  for (const side of [-1, 1]) {
    for (const [sa, sb] of cableRuns) {
      const n = Math.max(4, Math.round((sb - sa) / 12));
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const s = sa + ((sb - sa) * i) / n;
        const yy = cableY(Math.min(Math.max(s, sa + 1e-3), sb)) ?? 0;
        pts.push(V(s, side * H, yy));
      }
      b.add('cable', tube(pts, 0.42, 6, 1), { color: C.steel, smooth: true });
    }
  }
  for (const [sa, sb] of cableRuns.slice(1)) {
    const n = Math.round((sb - sa) / DIM.panel);
    for (let i = 1; i < n; i++) {
      const s = sa + ((sb - sa) * i) / n;
      const cy = cableY(s);
      if (cy === null) continue;
      const bottom = deckY(s) + 1.4;
      if (cy - bottom < 1.2) continue;
      for (const side of [-1, 1]) out.suspenders.push({ top: V(s, side * H, cy - 0.3), bottom: V(s, side * H, bottom), side, s });
    }
  }
  return out;
}
