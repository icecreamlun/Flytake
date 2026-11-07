/**
 * Embarcadero pier sheds + bulkheads: the continuous waterfront wall of 1910s–30s transit sheds north of
 * the Ferry Building (Piers 1–35). Each pier (or pier group sharing one building record) is one landmark
 * whose generic OSM extrusions on the deck are replaced. Long, low sheds do not rock rigidly about their
 * base like towers, so they use the 'translate' motion mode (see index.ts).
 */
import * as THREE from 'three';
import type { BuildingRecord, XZ } from '../../../contracts';
import { PartBuilder, type AddOpts } from '../common/builder';
import { lmMaterial } from '../common/materials';
import { signPanel } from '../common/canvasArt';
import { centroid, frameFromAxis, makePivot, toLocal, toWorld } from '../common/frame';
import type { LandmarkBuild, LandmarkEnv } from '../common/types';
import { addBulkhead } from './bulkhead';
import { addShed } from './shed';
import { PIERS, type PierSpec } from './data';

const BULK_DEPTH = 11;

let mats: Record<string, THREE.Material> | null = null;
function materials(): Record<string, THREE.Material> {
  if (mats) return mats;
  mats = {
    // Painted concrete; bulkhead parts carry a night wash via the vertex glow (× albedo).
    wall: lmMaterial({ tex: 'concrete', roughness: 0.92, bump: 0.45, glow: '#ffd9ae', glowIntensity: 0.55, glowAlbedo: true, weather: { baseY: 2.4, grime: 0.32, mottle: 0.12 } }),
    trim: lmMaterial({ tex: 'ashlar', roughness: 0.82, bump: 0.3, glow: '#ffd9ae', glowIntensity: 0.6, glowAlbedo: true, weather: { baseY: 2.4, grime: 0.25, mottle: 0.06 } }),
    // Steel-sash glazing (0.8 m panes); bays light up as units at night.
    glass: lmMaterial({ tex: 'panes', color: '#cdd8de', metalness: 0.55, glow: '#ffc98e', glowIntensity: 1.5 }),
    // Roofing, doors, gutters, vents (vertex-tinted paint).
    roof: lmMaterial({ tex: 'paint', roughness: 0.75, metalness: 0.15 }),
  };
  return mats;
}

interface PierGeom {
  spec: PierSpec;
  /** Pier-local frame (origin at the deck root centre, +x bay-ward). */
  ux: number;
  uz: number;
  deck: number;
  shed: { x0: number; x1: number; zc: number; hw: number };
}

function pierGeom(env: LandmarkEnv, p: PierSpec): PierGeom {
  const a = THREE.MathUtils.degToRad(p.angle);
  const ux = Math.cos(a);
  const uz = Math.sin(a);
  const f = frameFromAxis(p.root[0], p.root[1], ux, uz);
  // Deck level: median terrain height along the pier axis (the pipeline flattened decks to one level).
  const hs: number[] = [];
  for (let s = 20; s < p.length - 10; s += 20) {
    const [x, z] = toWorld(f, s, 0);
    hs.push(env.ground(x, z));
  }
  hs.sort((x, y) => x - y);
  const deck = hs.length ? hs[hs.length >> 1] : 2.5;
  const x0 = p.shedStart ?? (p.bulkhead === false ? 6 : BULK_DEPTH - 0.6);
  return { spec: p, ux, uz, deck, shed: { x0, x1: p.shedEnd, zc: p.shedOffset ?? 0, hw: p.shedWidth / 2 } };
}

/** Generic extrusions standing on this pier's shed (or bulkhead) footprint: replaced by the model. */
function coveredBuildings(env: LandmarkEnv, gs: PierGeom[]): BuildingRecord[] {
  const out: BuildingRecord[] = [];
  const frames = gs.map((g) => ({ g, f: frameFromAxis(g.spec.root[0], g.spec.root[1], g.ux, g.uz) }));
  const inside = (p: XZ, slack: number) =>
    frames.some(({ g, f }) => {
      const [u, v] = toLocal(f, p[0], p[1]);
      const { x0, x1, zc, hw } = g.shed;
      // Without a modelled bulkhead, keep whatever stands in front of the shed (e.g. Piers 1½-5 bulkheads).
      const u0 = g.spec.bulkhead === false ? x0 - 2 : -12;
      return u > u0 && u < x1 + slack && Math.abs(v - zc) < Math.max(hw, g.spec.width / 2) + slack;
    });
  for (const b of env.ctx.city.buildings) {
    if (b.landmark || b.height > 30) continue;
    const [cx, cz] = centroid(b.footprint);
    if (Math.abs(cx - gs[0].spec.root[0]) > 700 || Math.abs(cz - gs[0].spec.root[1]) > 700) continue;
    let n = 0;
    for (const p of b.footprint) if (inside(p, 8)) n++;
    if (inside([cx, cz], 4) || n >= b.footprint.length * 0.7) out.push(b);
  }
  return out;
}

function buildPier(g: PierGeom, seed: number): THREE.Group {
  const { spec, shed } = g;
  const b = new PartBuilder();
  const add = (k: string, geo: THREE.BufferGeometry, o?: AddOpts) => b.add(k, geo, o);
  const He = spec.eaves;
  addShed(add, { ...shed, eaves: He, seed, closeRoot: spec.bulkhead === false });
  let sign: THREE.Mesh | null = null;
  if (spec.bulkhead !== false) {
    // Bulkhead spans the deck width at the root; facade frame x → pier +z, facade +z (out) → pier −x.
    const len = Math.min(spec.width - 2, shed.hw * 2 + 14);
    const toPier = (geo: THREE.BufferGeometry) => geo.rotateY(-Math.PI / 2).translate(0, 0, shed.zc);
    const info = addBulkhead((k, geo, o) => add(k, toPier(geo), o), len, He + 3.5, BULK_DEPTH, seed + 7);
    // "PIER n" in the pavilion frieze (glows softly at night).
    const label = spec.name.toUpperCase();
    const sp = signPanel(label, { bg: '#e6dcc6', fg: '#34443a', height: 128, spacing: 0.22, pad: 0.5 });
    const sh = 1.5;
    const sg = new THREE.PlaneGeometry(sh * sp.aspect, sh);
    sg.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(4).fill(1), 1));
    sign = new THREE.Mesh(sg, lmMaterial({ map: sp.map, glowMask: sp.mask, roughness: 0.8, glow: '#fff1d8', glowIntensity: 1.6, vertexColors: false, noShadow: true }));
    sign.rotation.y = -Math.PI / 2;
    sign.position.set(-0.76, info.signY, shed.zc);
    sign.castShadow = false;
  }
  const model = b.build(materials(), `pier:${spec.name}`);
  if (sign) model.add(sign);
  return model;
}

export function buildPierSheds(env: LandmarkEnv): LandmarkBuild[] {
  const groups = new Map<string, PierSpec[]>();
  for (const p of PIERS) {
    const key = p.group ?? p.name;
    let l = groups.get(key);
    if (!l) groups.set(key, (l = []));
    l.push(p);
  }
  const out: LandmarkBuild[] = [];
  let seed = 1;
  for (const [key, specs] of groups) {
    const gs = specs.map((p) => pierGeom(env, p));
    const recs = coveredBuildings(env, gs);
    // Pivot at the middle of the group's sheds, on the deck.
    let cx = 0;
    let cz = 0;
    for (const g of gs) {
      const f = frameFromAxis(g.spec.root[0], g.spec.root[1], g.ux, g.uz);
      const [x, z] = toWorld(f, (g.shed.x0 + g.shed.x1) / 2, g.shed.zc);
      cx += x / gs.length;
      cz += z / gs.length;
    }
    const deck = gs.reduce((s, g) => s + g.deck, 0) / gs.length;
    const { pivot, inner } = makePivot(`pier_${key}`, frameFromAxis(cx, cz, 1, 0), deck);
    for (const g of gs) {
      const model = buildPier(g, (seed++ * 7919) % 2147483646 || 1);
      const f = frameFromAxis(g.spec.root[0], g.spec.root[1], g.ux, g.uz);
      model.position.set(g.spec.root[0] - cx, g.deck - deck, g.spec.root[1] - cz);
      model.rotation.y = f.heading;
      inner.add(model);
    }
    out.push({ name: `pier:${key}`, pivot, buildingIds: recs.map((r) => r.id), motion: 'translate' });
  }
  return out;
}
