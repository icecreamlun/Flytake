/**
 * Small-scale building props, all merged into the prop mesh with the owning building's index:
 *  rooftop clutter (mechanical penthouses, HVAC units, wooden water tanks, masts, solar, skylights),
 *  street-level awnings, Chinatown blade signs, and fire escapes on older walk-ups.
 */
import * as THREE from 'three';
import type { Heightfield, XZ } from '../../contracts';
import { PropBuilder, PropKind } from './builder';
import type { BuildingGeo, EdgeInfo } from './geometry';
import { distToBoundary, pointInPolygon } from './footprint';
import { F, Style } from './styles';

const tmpC = new THREE.Color();

/** R receives the alpha-cut railing / stair quads (own mesh, so the big prop mesh never uses discard). */
export function addProps(P: PropBuilder, R: PropBuilder, g: BuildingGeo, terrain: Heightfield) {
  addRooftop(P, R, g);
  if (g.rec.context) return;
  addStreetProps(P, g, terrain);
  addFireEscapes(P, R, g);
}

// ─────────────────────────── rooftop ───────────────────────────

const OLD_RES = new Set([Style.House, Style.ResidentialMid, Style.Chinatown, Style.HistoricMasonry]);

function addRooftop(P: PropBuilder, R: PropBuilder, g: BuildingGeo) {
  if (g.wallTop < g.top - 0.01 || g.area < 30 || g.rec.overWater || g.skipRoof) return;
  const rings = g.inner ?? g.rings;
  const outer = rings[0];
  const holes = rings.slice(1);
  const rand = g.rand;
  const h = g.rec.height;
  const s = g.style;
  const y = g.roofY;
  const oldRes = OLD_RES.has(s.style) && g.rec.yearBuilt < 1950;
  const commercial = s.style === Style.ModernGlass || s.style === Style.ModernConcrete || s.style === Style.Midcentury || s.style === Style.PrewarOffice || s.style === Style.Utilitarian;
  // Align clutter with the longest edge.
  let yaw = 0;
  let best = 0;
  for (const e of g.edges) if (e.ring === 0 && e.len > best) {
    best = e.len;
    yaw = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]);
  }
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of outer) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const placed: [number, number, number][] = [];
  const tryPlace = (w: number, d: number, margin: number, prefer?: XZ, tries = 14): XZ | null => {
    const r = Math.hypot(w, d) / 2;
    for (let k = 0; k < tries; k++) {
      let x: number, z: number;
      if (prefer && k < 4) {
        x = prefer[0] + (rand() - 0.5) * k * 1.5;
        z = prefer[1] + (rand() - 0.5) * k * 1.5;
      } else {
        x = minX + rand() * (maxX - minX);
        z = minZ + rand() * (maxZ - minZ);
      }
      if (!pointInPolygon(x, z, outer, holes)) continue;
      if (distToBoundary(x, z, rings) < r + margin) continue;
      // Not inside (or touching) a taller part of the same building.
      if (g.blockers.some((b) => pointInPolygon(x, z, b) || distToBoundary(x, z, [b]) < r + 0.3)) continue;
      if (placed.some(([px, pz, pr]) => Math.hypot(px - x, pz - z) < pr + r + 0.4)) continue;
      placed.push([x, z, r]);
      return [x, z];
    }
    return null;
  };
  const ctx = !!g.rec.context;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const side = Math.sqrt(g.area);
  const c = Math.cos(yaw), sn = Math.sin(yaw);

  // Chimneys first (old residential): brick stacks hugging a side (lot-line) wall, as SF flats have.
  if (oldRes && h < 30) {
    const sideEdges = g.edges.filter((e) => e.ring === 0 && !e.street.street && e.len > 3);
    const nCh = sideEdges.length ? (rand() < 0.35 ? 0 : g.rec.context ? 1 : 1 + Math.floor(rand() * (g.area > 220 ? 3 : 2))) : 0;
    for (let k = 0; k < nCh; k++) {
      const e = sideEdges[Math.floor(rand() * sideEdges.length)];
      const t = 1 + rand() * (e.len - 2);
      const w = 0.55 + rand() * 0.25;
      const d = 0.75 + rand() * 0.55;
      const inset = (g.inner ? 0.35 : 0) + d / 2 + 0.05;
      const px = e.a[0] + ((e.b[0] - e.a[0]) / e.len) * t - e.n[0] * inset;
      const pz = e.a[1] + ((e.b[1] - e.a[1]) / e.len) * t - e.n[1] * inset;
      if (!pointInPolygon(px, pz, outer, holes) || placed.some(([qx, qz, qr]) => Math.hypot(qx - px, qz - pz) < qr + 0.9)) continue;
      placed.push([px, pz, 0.8]);
      const brick = new THREE.Color(rand() < 0.7 ? '#8a4b38' : '#9a8f80').multiplyScalar(0.8 + rand() * 0.3);
      const ch = (g.wallTop - y) + 1.0 + rand() * 1.0;
      const eyaw = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]);
      P.box(px, y - 0.05, pz, d, w, ch, eyaw, g.index, brick, PropKind.Chimney, rand(), false);
      // Corbelled cap (core only).
      if (!g.rec.context) P.box(px, y - 0.05 + ch, pz, d + 0.12, w + 0.12, 0.14, eyaw, g.index, brick.clone().multiplyScalar(0.8), PropKind.Chimney, rand(), false);
    }
  }

  // Mechanical penthouse / screen: bigger on towers, it shapes the skyline.
  if (h > 15 && g.area > 110 && (commercial || h > 26)) {
    const tower = h > 60;
    const sx = THREE.MathUtils.clamp(side * (tower ? 0.5 : 0.3), 3.5, tower ? 30 : 12);
    const sz = sx * (0.55 + rand() * 0.35);
    const ph = tower ? 4.5 + rand() * 4 : 3 + rand() * 1.2;
    const p = tryPlace(sx, sz, 0.8, [cx, cz]);
    if (p) {
      const col = s.style === Style.ModernGlass ? s.glass.clone().lerp(s.base, 0.35) : tmpC.copy(s.base).multiplyScalar(0.88).clone();
      P.box(p[0], y, p[1], sx, sz, ph, yaw, g.index, col, PropKind.Penthouse, rand(), false);
      // Second, smaller tier on towers.
      if (tower && rand() < 0.6) P.box(p[0], y + ph, p[1], sx * 0.55, sz * 0.6, 2.5 + rand() * 2, yaw, g.index, col, PropKind.Penthouse, rand(), false);
    }
  } else if (h > 8.5 && g.area > 55 && rand() < (oldRes ? 0.75 : 0.5)) {
    // Stair bulkhead (roof access) with a door, set back from the street.
    const bx = 2.0 + rand() * 0.8;
    const bz = 2.6 + rand() * 1.2;
    const p = tryPlace(bx, bz, 0.5);
    if (p) {
      const col = oldRes ? s.base.clone().lerp(new THREE.Color('#d9d3c6'), 0.5).multiplyScalar(0.9) : tmpC.copy(s.base).multiplyScalar(0.85).clone();
      const bh = 2.3 + rand() * 0.5;
      P.box(p[0], y, p[1], bx, bz, bh, yaw, g.index, col, PropKind.Penthouse, 0.6 + rand() * 0.4, false);
      if (!g.rec.context) P.box(p[0], y + bh, p[1], bx + 0.12, bz + 0.12, 0.1, yaw, g.index, new THREE.Color('#5d5a55'), PropKind.ParapetCap, rand(), false);
    }
  }

  // HVAC: packaged rooftop units on curbs, condensers, exhaust fans — sized and placed with variety.
  let n = Math.round((g.area / (commercial ? 120 : 260)) * (0.4 + rand()));
  n = Math.min(n, ctx ? (g.area > 600 ? 3 : 1) : 14);
  if (commercial && g.area > 40 && n === 0 && rand() < 0.6) n = 1;
  const metal = new THREE.Color();
  for (let k = 0; k < n; k++) {
    const r = rand();
    metal.setRGB(0.36, 0.37, 0.37).multiplyScalar(0.7 + rand() * 0.5);
    if (rand() < 0.25) metal.setRGB(0.45, 0.43, 0.38); // beige-painted units
    if (r < 0.5) {
      // Packaged unit on a curb, sometimes with a duct running away.
      const sx = 1.6 + rand() * 2.4;
      const sz = 1.1 + rand() * 0.9;
      const p = tryPlace(sx + 0.3, sz + 0.3, 0.5);
      if (!p) continue;
      const uy = (rand() - 0.5) * 0.3 + yaw;
      const curb = ctx ? 0 : 0.28;
      if (!ctx) P.box(p[0], y, p[1], sx + 0.25, sz + 0.25, curb, uy, g.index, new THREE.Color('#4a4846'), PropKind.Metal, rand(), false);
      P.box(p[0], y + curb, p[1], sx, sz, 0.8 + rand() * 0.7, uy, g.index, metal, PropKind.Hvac, rand(), false);
      if (!ctx && rand() < 0.4) {
        const dl = 2 + rand() * 4;
        P.box(p[0] + Math.cos(uy) * (sx / 2 + dl / 2), y + 0.15, p[1] + Math.sin(uy) * (sx / 2 + dl / 2), dl, 0.55, 0.5, uy, g.index, new THREE.Color('#8d9091'), PropKind.Vent, rand(), false);
      }
    } else if (r < 0.8) {
      // Split condenser: small cube with fan grille.
      const sx = 0.8 + rand() * 0.5;
      const p = tryPlace(sx, sx, 0.4);
      if (!p) continue;
      P.box(p[0], y, p[1], sx, sx * (0.8 + rand() * 0.4), 0.7 + rand() * 0.4, yaw, g.index, metal.clone().multiplyScalar(1.15), PropKind.Hvac, rand(), false);
    } else if (!ctx) {
      // Mushroom exhaust fan.
      const rr = 0.3 + rand() * 0.25;
      const p = tryPlace(rr * 2, rr * 2, 0.4);
      if (!p) continue;
      P.cylinder(p[0], y, p[1], rr * 0.8, 0.45, 6, g.index, new THREE.Color('#9a9c9c'), PropKind.Vent, rand());
      P.cylinder(p[0], y + 0.45, p[1], rr * 1.25, 0.18, 6, g.index, new THREE.Color('#a4a6a6'), PropKind.Vent, rand(), 0.22);
    }
  }
  if (ctx) return;

  // Plumbing vent stacks (every walk-up has a few).
  const nv = Math.min(3, Math.floor(g.area / 90) + (oldRes ? 1 : 0));
  for (let k = 0; k < nv; k++) {
    const p = tryPlace(0.25, 0.25, 0.4);
    const r = 0.1 + rand() * 0.07;
    if (p) P.box(p[0], y, p[1], r, r, 0.5 + rand() * 0.6, rand() * 3, g.index, new THREE.Color('#3c3b3a'), PropKind.Vent, rand(), false);
  }

  // Wooden water tank on legs (pre-war walk-ups and offices).
  const tankStyle = s.style === Style.PrewarOffice || s.style === Style.HistoricMasonry || s.style === Style.ResidentialMid || s.style === Style.Chinatown;
  if (tankStyle && h > 14 && h < 80 && rand() < 0.3) {
    const r = 1.3 + rand() * 0.6;
    const p = tryPlace(r * 2, r * 2, 0.6);
    if (p) {
      const legs = new THREE.Color('#2b2a28');
      const lh = 1.8 + rand() * 0.8;
      for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) P.box(p[0] + ox * r * 0.6, y, p[1] + oz * r * 0.6, 0.22, 0.22, lh, 0, g.index, legs, PropKind.Metal, rand(), false);
      P.box(p[0], y + lh - 0.15, p[1], r * 1.5, r * 1.5, 0.15, 0, g.index, legs, PropKind.Metal, rand(), true);
      const wood = new THREE.Color('#6e5038').multiplyScalar(0.8 + rand() * 0.4);
      P.cylinder(p[0], y + lh, p[1], r, 3 + rand(), 12, g.index, wood, PropKind.WoodTank, rand(), 0.9, new THREE.Color('#3a3631'));
    }
  }

  // Masts on tall towers.
  if (h > 80) {
    const m = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < m; k++) {
      const p = tryPlace(0.4, 0.4, 1.2);
      if (!p) continue;
      const mh = 5 + rand() * 10;
      P.box(p[0], y, p[1], 0.35, 0.35, mh, yaw, g.index, new THREE.Color('#7d8084'), PropKind.Metal, rand(), false);
    }
  }

  // Roof deck with railing (North Beach / Telegraph Hill flats).
  if (oldRes && h < 18 && g.area > 60 && rand() < 0.22) {
    const dw = Math.min(side * 0.5, 6) * (0.7 + rand() * 0.3);
    const dd = Math.min(side * 0.45, 5) * (0.7 + rand() * 0.3);
    const p = tryPlace(dw, dd, 0.5, undefined, 8);
    if (p) {
      const wood = new THREE.Color(rand() < 0.6 ? '#8c7a62' : '#9a6f4c');
      P.box(p[0], y, p[1], dw, dd, 0.22, yaw, g.index, wood, PropKind.Deck, rand(), false);
      const corner = (ix: number, iz: number): XZ => [p[0] + c * ix * dw / 2 - sn * iz * dd / 2, p[1] + sn * ix * dw / 2 + c * iz * dd / 2];
      const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      const iron = new THREE.Color('#2a2a2a');
      for (let i = 0; i < 4; i++) railing(R, g.index, iron, pts[i], pts[(i + 1) % 4], y + 0.22, 0.95, rand());
    }
  }

  // Solar arrays / skylights on low-rise.
  if (h < 30 && g.area > 70 && rand() < 0.12) {
    const cols = 2 + Math.floor(rand() * 4);
    const rows = 1 + Math.floor(rand() * 3);
    const p = tryPlace(cols * 1.1 + 0.6, rows * 1.9 + 0.6, 0.8);
    if (p) {
      for (let i = 0; i < cols; i++)
        for (let j = 0; j < rows; j++) {
          const lx = (i - (cols - 1) / 2) * 1.1;
          const lz = (j - (rows - 1) / 2) * 1.9;
          P.box(p[0] + c * lx - sn * lz, y + 0.25, p[1] + sn * lx + c * lz, 1.0, 1.7, 0.06, yaw, g.index, new THREE.Color('#1a2433'), PropKind.Solar, rand(), true);
        }
    }
  }
  if (h < 25 && g.area > 45 && rand() < (oldRes ? 0.4 : 0.15)) {
    const k = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < k; i++) {
      const sw = 0.9 + rand() * 0.8;
      const sl = 1.2 + rand() * 1.4;
      const p = tryPlace(sw, sl, 0.5);
      if (!p) continue;
      P.box(p[0], y, p[1], sw + 0.16, sl + 0.16, 0.3, yaw, g.index, new THREE.Color('#77736c'), PropKind.ParapetCap, rand(), false);
      P.box(p[0], y + 0.3, p[1], sw, sl, 0.18, yaw, g.index, new THREE.Color('#5c666e'), PropKind.Skylight, rand(), false);
    }
  }
  // Roof hatch.
  if (oldRes && g.area > 40 && rand() < 0.35) {
    const p = tryPlace(0.9, 0.9, 0.5);
    if (p) P.box(p[0], y, p[1], 0.9, 0.9, 0.45, yaw, g.index, new THREE.Color('#6f6a62'), PropKind.Metal, rand(), false);
  }
}

// ─────────────────────────── street level ───────────────────────────

const AWNING = ['#b3201b', '#1d7a46', '#d9a521', '#1f4f8a', '#7a1c28', '#d6561a', '#0f6e6a', '#a31c1c', '#2b6b2b', '#3a3a3a', '#6b2d5c'];
const SIGN = ['#b51d17', '#d8a521', '#f1ece2', '#1d5f99', '#1d7a46', '#c63a1a', '#111111', '#b51d17', '#d8a521'];

function awningProbability(g: BuildingGeo): number {
  if ((g.style.flags & F.storefront) === 0) return 0;
  switch (g.style.style) {
    case Style.Chinatown:
      return 0.72;
    case Style.HistoricMasonry:
      return 0.45;
    case Style.ResidentialMid:
      return 0.4;
    case Style.PrewarOffice:
      return g.rec.use === 'retail' || g.rec.use === 'mixed' || g.rec.use === 'hotel' ? 0.25 : 0.05;
    default:
      return 0.04;
  }
}

/** True when [t0, t1] along ring-0 edge `e` overlaps a bay window (with a clearance margin). */
function hitsBay(g: BuildingGeo, e: EdgeInfo, t0: number, t1: number, margin = 0.3): boolean {
  const spans = g.bays.get(g.edges.indexOf(e));
  return !!spans && spans.some(([a, b]) => t1 > a - margin && t0 < b + margin);
}

/** Window AC units on old walk-ups, placed on the facade shader's exact window grid. */
function addWindowUnits(P: PropBuilder, g: BuildingGeo, e: EdgeInfo, dx: number, dz: number, yaw: number) {
  const s = g.style;
  const old = s.style === Style.Chinatown || (s.style === Style.ResidentialMid && g.rec.yearBuilt < 1960);
  if (!old || e.len < 2.5) return;
  const n = Math.max(1, Math.floor(e.len / s.module + 0.25));
  const mw = e.len / n;
  const nf = Math.floor((g.wallTop - s.topBand - (g.base + s.groundH)) / s.floorH + 0.05);
  const c = new THREE.Color();
  for (let f = 0; f < nf; f++)
    for (let k = 0; k < n; k++) {
      if (g.rand() > 0.09) continue;
      const t = (k + 0.5) * mw + (g.rand() - 0.5) * 0.3;
      if (hitsBay(g, e, t - 0.4, t + 0.4)) continue;
      const y = g.base + s.groundH + f * s.floorH + s.sill + 0.02;
      const out = 0.22;
      c.setRGB(0.62, 0.62, 0.6).multiplyScalar(0.7 + g.rand() * 0.4);
      P.box(e.a[0] + dx * t + e.n[0] * (out - 0.12), y, e.a[1] + dz * t + e.n[1] * (out - 0.12), 0.62, 0.55, 0.4, yaw, g.index, c, PropKind.Hvac, g.rand(), true);
    }
}

function addStreetProps(P: PropBuilder, g: BuildingGeo, terrain: Heightfield) {
  const s = g.style;
  const pA = awningProbability(g);
  const chinatown = s.style === Style.Chinatown;
  const signP = chinatown ? 0.9 : s.style === Style.HistoricMasonry || (s.style === Style.ResidentialMid && (s.flags & F.storefront) !== 0) ? 0.25 : 0;
  for (const e of g.edges) {
    if (e.ring !== 0 || !e.exposed || !e.street.street || e.party > 0.3 || e.len < 3) continue;
    const dx = (e.b[0] - e.a[0]) / e.len;
    const dz = (e.b[1] - e.a[1]) / e.len;
    const yaw = Math.atan2(dz, dx);
    const gAt = (t: number) => (g.rec.overWater ? g.base : terrain.heightAt(e.a[0] + dx * t, e.a[1] + dz * t));
    addWindowUnits(P, g, e, dx, dz, yaw);
    // Awnings per storefront bay.
    if (pA > 0) {
      const bayW = Math.max(3.2, s.module * 2);
      const nb = Math.max(1, Math.floor(e.len / bayW));
      const bw = e.len / nb;
      for (let k = 0; k < nb; k++) {
        if (g.rand() > pA) continue;
        const t0 = k * bw + 0.3;
        const t1 = (k + 1) * bw - 0.3;
        const gr = Math.max(gAt(t0), gAt(t1));
        const yA = g.base + s.groundH - 0.55;
        if (yA - gr < 2.7 || t1 - t0 < 1.5) continue;
        const col = new THREE.Color(chinatown && g.rand() < 0.5 ? `#${s.accent.getHexString()}` : AWNING[Math.floor(g.rand() * AWNING.length)]);
        if (chinatown && g.rand() < 0.5) col.copy(s.accent);
        const kind = g.rand();
        if (kind < 0.25) canopy(P, g, e, dx, dz, t0, t1, yA + 0.1, 0.9 + g.rand() * 0.6);
        else if (kind < 0.4) awning(P, g, e, dx, dz, t0, t1, yA, 0.7 + g.rand() * 0.2, 0.75 + g.rand() * 0.2, col); // steep, shallow
        else awning(P, g, e, dx, dz, t0, t1, yA, 1.1 + g.rand() * 0.5, 0.45 + g.rand() * 0.3, col);
      }
    }
    // Blade signs.
    if (signP > 0) {
      const ns = Math.floor(e.len / (chinatown ? 7 : 14));
      for (let k = 0; k < ns; k++) {
        if (g.rand() > signP) continue;
        const t = 1.2 + g.rand() * (e.len - 2.4);
        if (hitsBay(g, e, t - 0.2, t + 0.2, 0.5)) continue;
        const yB = g.base + s.groundH + 0.25 + g.rand() * 0.8;
        const maxTop = g.wallTop - 0.8;
        const hh = Math.min(1.6 + g.rand() * (chinatown ? 3.2 : 1.6), maxTop - yB);
        if (hh < 1.2 || yB - gAt(t) < 3) continue;
        const proj = 0.75 + g.rand() * 0.45;
        const cx = e.a[0] + dx * t + e.n[0] * (proj / 2 + 0.12);
        const cz = e.a[1] + dz * t + e.n[1] * (proj / 2 + 0.12);
        const col = new THREE.Color(SIGN[Math.floor(g.rand() * SIGN.length)]);
        P.box(cx, yB, cz, 0.14, proj, hh, yaw, g.index, col, PropKind.Sign, g.rand(), true);
        // Bracket.
        P.box(e.a[0] + dx * t + e.n[0] * 0.1, yB + hh, e.a[1] + dz * t + e.n[1] * 0.1, 0.06, 0.2, 0.08, yaw, g.index, new THREE.Color('#222222'), PropKind.Metal, 0, true);
      }
    }
  }
}

function awning(P: PropBuilder, g: BuildingGeo, e: EdgeInfo, dx: number, dz: number, t0: number, t1: number, yA: number, D: number, drop: number, col: THREE.Color) {
  const w0: XZ = [e.a[0] + dx * t0 + e.n[0] * 0.02, e.a[1] + dz * t0 + e.n[1] * 0.02];
  const w1: XZ = [e.a[0] + dx * t1 + e.n[0] * 0.02, e.a[1] + dz * t1 + e.n[1] * 0.02];
  const o0: XZ = [w0[0] + e.n[0] * D, w0[1] + e.n[1] * D];
  const o1: XZ = [w1[0] + e.n[0] * D, w1[1] + e.n[1] * D];
  const yO = yA - drop;
  const W = t1 - t0;
  const sl = Math.hypot(D, drop);
  const ny = D / sl;
  const nx = (e.n[0] * drop) / sl;
  const nz = (e.n[1] * drop) / sl;
  const r = g.rand();
  const v = [
    P.vertex(w0[0], yA, w0[1], nx, ny, nz, g.index, col.r, col.g, col.b, PropKind.Awning, 0, 0, r),
    P.vertex(w1[0], yA, w1[1], nx, ny, nz, g.index, col.r, col.g, col.b, PropKind.Awning, W, 0, r),
    P.vertex(o1[0], yO, o1[1], nx, ny, nz, g.index, col.r, col.g, col.b, PropKind.Awning, W, sl, r),
    P.vertex(o0[0], yO, o0[1], nx, ny, nz, g.index, col.r, col.g, col.b, PropKind.Awning, 0, sl, r),
  ];
  P.quad(v[0], v[1], v[2], v[3], nx, ny, nz);
  // Underside (darker, lit from below by the street).
  const u = [w0, w1, o1, o0].map((p, i) => P.vertex(p[0], (i < 2 ? yA : yO) - 0.03, p[1], -nx, -ny, -nz, g.index, col.r * 0.6, col.g * 0.6, col.b * 0.6, PropKind.Awning, i === 1 || i === 2 ? W : 0, i >= 2 ? sl : 0, r));
  P.quad(u[0], u[1], u[2], u[3], -nx, -ny, -nz);
  // Valance.
  const vh = 0.28;
  const f = [
    P.vertex(o0[0], yO - vh, o0[1], e.n[0], 0, e.n[1], g.index, col.r, col.g, col.b, PropKind.Awning, 0, sl + vh, r),
    P.vertex(o1[0], yO - vh, o1[1], e.n[0], 0, e.n[1], g.index, col.r, col.g, col.b, PropKind.Awning, W, sl + vh, r),
    P.vertex(o1[0], yO, o1[1], e.n[0], 0, e.n[1], g.index, col.r, col.g, col.b, PropKind.Awning, W, sl, r),
    P.vertex(o0[0], yO, o0[1], e.n[0], 0, e.n[1], g.index, col.r, col.g, col.b, PropKind.Awning, 0, sl, r),
  ];
  P.quad(f[0], f[1], f[2], f[3], e.n[0], 0, e.n[1]);
  // Side cheeks.
  for (const [w, o, sgn] of [[w0, o0, -1], [w1, o1, 1]] as [XZ, XZ, number][]) {
    const sx = dx * sgn, sz = dz * sgn;
    const a = P.vertex(w[0], yA, w[1], sx, 0, sz, g.index, col.r, col.g, col.b, PropKind.Awning, 0, 0, r);
    const b = P.vertex(o[0], yO, o[1], sx, 0, sz, g.index, col.r, col.g, col.b, PropKind.Awning, D, drop, r);
    const c = P.vertex(o[0], yO - vh, o[1], sx, 0, sz, g.index, col.r, col.g, col.b, PropKind.Awning, D, drop + vh, r);
    P.tri(a, b, c, sx, 0, sz);
  }
}

/** Flat steel canopy: a thin cantilevered slab with a fascia (modern & pre-war shopfronts). */
function canopy(P: PropBuilder, g: BuildingGeo, e: EdgeInfo, dx: number, dz: number, t0: number, t1: number, y: number, D: number) {
  const L = t1 - t0;
  const tm = (t0 + t1) / 2;
  const cx = e.a[0] + dx * tm + e.n[0] * (D / 2 + 0.02);
  const cz = e.a[1] + dz * tm + e.n[1] * (D / 2 + 0.02);
  const yaw = Math.atan2(dz, dx);
  const steel = new THREE.Color(g.rand() < 0.6 ? '#2a2b2c' : '#6d6a63');
  P.box(cx, y - 0.22, cz, L, D, 0.22, yaw, g.index, steel, PropKind.Metal, g.rand(), true);
}

// ─────────────────────────── fire escapes ───────────────────────────

function addFireEscapes(P: PropBuilder, R: PropBuilder, g: BuildingGeo) {
  const s = g.style;
  if ((s.flags & F.fireEscape) === 0) return;
  const floorsTop = g.wallTop - s.topBand;
  const nFloors = Math.floor((floorsTop - (g.base + s.groundH)) / s.floorH);
  if (nFloors < 2) return;
  const iron = new THREE.Color('#1c1d1e');
  let placed = 0;
  for (const e of g.edges) {
    if (placed >= 2 || e.ring !== 0 || !e.exposed || !e.street.street || e.party > 0.3 || e.len < 7) continue;
    const dx = (e.b[0] - e.a[0]) / e.len;
    const dz = (e.b[1] - e.a[1]) / e.len;
    const yaw = Math.atan2(dz, dx);
    const w = THREE.MathUtils.clamp(s.module * 1.6, 3, 4.6);
    const t = e.len * (0.3 + g.rand() * 0.4);
    if (hitsBay(g, e, t - w / 2, t + w / 2)) continue;
    placed++;
    const depth = 0.95;
    const rnd = g.rand();
    for (let k = 0; k < nFloors; k++) {
      const y = g.base + s.groundH + k * s.floorH - 0.05;
      const cx = e.a[0] + dx * t + e.n[0] * (depth / 2 + 0.03);
      const cz = e.a[1] + dz * t + e.n[1] * (depth / 2 + 0.03);
      P.box(cx, y, cz, w, depth, 0.06, yaw, g.index, iron, PropKind.Metal, rnd, true);
      // Railings (front + two ends), double-faced, bars cut out in the shader.
      const fx0 = e.a[0] + dx * (t - w / 2) + e.n[0] * (depth + 0.03);
      const fz0 = e.a[1] + dz * (t - w / 2) + e.n[1] * (depth + 0.03);
      const fx1 = fx0 + dx * w;
      const fz1 = fz0 + dz * w;
      const wx0 = e.a[0] + dx * (t - w / 2) + e.n[0] * 0.03;
      const wz0 = e.a[1] + dz * (t - w / 2) + e.n[1] * 0.03;
      const wx1 = wx0 + dx * w;
      const wz1 = wz0 + dz * w;
      railing(R, g.index, iron, [wx0, wz0], [fx0, fz0], y + 0.06, 0.95, rnd);
      railing(R, g.index, iron, [fx0, fz0], [fx1, fz1], y + 0.06, 0.95, rnd);
      railing(R, g.index, iron, [fx1, fz1], [wx1, wz1], y + 0.06, 0.95, rnd);
      // Stair to the next platform (ladder pattern).
      if (k < nFloors - 1) {
        const sa: XZ = [e.a[0] + dx * (t - w / 2 + 0.3) + e.n[0] * 0.55, e.a[1] + dz * (t - w / 2 + 0.3) + e.n[1] * 0.55];
        const sb: XZ = [e.a[0] + dx * (t + w / 2 - 0.4) + e.n[0] * 0.55, e.a[1] + dz * (t + w / 2 - 0.4) + e.n[1] * 0.55];
        stair(R, g.index, iron, sa, sb, e.n, y + 0.06, y + s.floorH - 0.05, rnd);
      }
    }
  }
}

function railing(P: PropBuilder, bld: number, col: THREE.Color, a: XZ, b: XZ, y: number, h: number, rnd: number) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 0.05) return;
  const nx = (b[1] - a[1]) / L;
  const nz = -(b[0] - a[0]) / L;
  for (const sgn of [1, -1]) {
    const v = [
      P.vertex(a[0], y, a[1], nx * sgn, 0, nz * sgn, bld, col.r, col.g, col.b, PropKind.Railing, 0, 0, rnd),
      P.vertex(b[0], y, b[1], nx * sgn, 0, nz * sgn, bld, col.r, col.g, col.b, PropKind.Railing, L, 0, rnd),
      P.vertex(b[0], y + h, b[1], nx * sgn, 0, nz * sgn, bld, col.r, col.g, col.b, PropKind.Railing, L, h, rnd),
      P.vertex(a[0], y + h, a[1], nx * sgn, 0, nz * sgn, bld, col.r, col.g, col.b, PropKind.Railing, 0, h, rnd),
    ];
    P.quad(v[0], v[1], v[2], v[3], nx * sgn, 0, nz * sgn);
  }
}

function stair(P: PropBuilder, bld: number, col: THREE.Color, a: XZ, b: XZ, n: XZ, y0: number, y1: number, rnd: number) {
  const w = 0.6;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], y1 - y0);
  // Plane spanned by (b-a, y1-y0) and the wall normal; we want its up-facing normal.
  const ux = b[0] - a[0], uy = y1 - y0, uz = b[1] - a[1];
  const wx = n[0], wz = n[1];
  let nx = uy * wz, ny = uz * wx - ux * wz, nz = -uy * wx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const hw = w / 2;
  const pts: [number, number, number][] = [
    [a[0] - n[0] * hw, y0, a[1] - n[1] * hw],
    [b[0] - n[0] * hw, y1, b[1] - n[1] * hw],
    [b[0] + n[0] * hw, y1, b[1] + n[1] * hw],
    [a[0] + n[0] * hw, y0, a[1] + n[1] * hw],
  ];
  const uv = [[0, 0], [0, L], [w, L], [w, 0]];
  for (const sgn of [1, -1]) {
    const v = pts.map((p, i) => P.vertex(p[0], p[1], p[2], nx * sgn, ny * sgn, nz * sgn, bld, col.r, col.g, col.b, PropKind.Railing, uv[i][0] + 10, uv[i][1], rnd));
    P.quad(v[0], v[1], v[2], v[3], nx * sgn, ny * sgn, nz * sgn);
  }
}
