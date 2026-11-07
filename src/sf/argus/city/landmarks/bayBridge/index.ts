/**
 * San Francisco–Oakland Bay Bridge, western span (1936): two back-to-back suspension bridges from the
 * Rincon Hill anchorage to Yerba Buena Island with four steel towers and the Center Anchorage, double-deck
 * truss, main cables and suspenders, plus The Bay Lights at night. Mostly a backdrop element, so details
 * are instanced/merged into a handful of draw calls.
 */
import * as THREE from 'three';
import { PartBuilder } from '../common/builder';
import { lmMaterial } from '../common/materials';
import { centroid, frameFromAxis, makePivot } from '../common/frame';
import type { LandmarkBuild, LandmarkEnv } from '../common/types';
import { buildStructure } from './structure';
import { buildLights } from './lights';
import { AXIS_A, AXIS_U, S, pos } from './path';

/** Asphalt with lane markings: u across the 18.8 m roadway (0..1), v along in metres. */
function roadTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a3b3d';
  g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // Tyre-polished wheel paths (slightly darker).
  g.fillStyle = 'rgba(20,20,22,0.25)';
  for (let k = 0; k < 5; k++) for (const o of [0.28, 0.72]) g.fillRect(((k + o) / 5) * W - 4, 0, 8, H);
  g.fillStyle = '#d8d6cf';
  g.fillRect(6, 0, 4, H);
  g.fillRect(W - 10, 0, 4, H);
  // Dashed lane lines: 3 m dash / 9 m gap over the 24 m tile.
  for (let k = 1; k < 5; k++) {
    const x = (k / 5) * W - 1.5;
    for (const y0 of [0, 0.5]) g.fillRect(x, y0 * H, 3, H * (3 / 24));
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 1 / 24);
  t.anisotropy = 8;
  return t;
}

export function buildBayBridge(env: LandmarkEnv): LandmarkBuild | null {
  // Pivot at the middle of the first main span (between towers W2/W3 on OSM), at sea level.
  const origin = pos((S.t1 + S.t2) / 2);
  const b = new PartBuilder();
  // The two towers that exist as OSM buildings (W2/W3 pylons) get their own builders / pivots so quake FX
  // can rock them individually (the rest of the 3.5 km structure stays put).
  const pylons = env.byLandmark('bay_bridge');
  const towerOf = new Map<number, { id: string; pb: PartBuilder }>();
  for (const r of pylons) {
    const [cx, cz] = centroid(r.footprint);
    const sAlong = (cx - AXIS_A[0]) * AXIS_U[0] + (cz - AXIS_A[1]) * AXIS_U[1];
    const ts = [S.t1, S.t2, S.t3, S.t4].reduce((a, c) => (Math.abs(c - sAlong) < Math.abs(a - sAlong) ? c : a));
    if (Math.abs(ts - sAlong) < 40 && !towerOf.has(ts)) towerOf.set(ts, { id: r.id, pb: new PartBuilder() });
  }
  const st = buildStructure(b, origin, env.ground, (s) => towerOf.get(s)?.pb ?? null);
  const mats: Record<string, THREE.Material> = {
    steel: lmMaterial({ tex: 'paint', color: '#ffffff', metalness: 0.45, roughness: 0.55, bump: 0.5, flood: { color: '#cfe0ff', intensity: 0.05, y0: 0, y1: 160, topScale: 1 } }),
    cable: lmMaterial({ color: '#ffffff', metalness: 0.5, roughness: 0.45 }),
    concrete: lmMaterial({ tex: 'concrete', roughness: 0.85, weather: { baseY: 0, grime: 0.35, mottle: 0.12 }, flood: { color: '#ffe0b8', intensity: 0.12, y0: 0, y1: 95, topScale: 0.6 } }),
    deck: lmMaterial({ tex: 'concrete', roughness: 0.9 }),
    road: lmMaterial({ map: roadTexture(), roughness: 0.85 }),
    dark: lmMaterial({ color: '#ffffff', roughness: 1 }),
  };
  const model = b.build(mats, 'bay_bridge');
  const objectFor: Record<string, THREE.Object3D> = {};
  for (const [s, { id, pb }] of towerOf) {
    const [px, pz] = pos(s);
    const tp = new THREE.Group();
    tp.name = `landmark:bay_bridge_tower_${id}`;
    tp.position.set(px - origin[0], 0, pz - origin[1]);
    const g = pb.build(mats, `bay_bridge_tower_${id}`);
    g.position.set(-(px - origin[0]), 0, -(pz - origin[1]));
    tp.add(g);
    model.add(tp);
    objectFor[id] = tp;
  }

  // Suspenders: thin lines (continuous at any distance; real ropes are sub-pixel beyond ~300 m).
  const sp: number[] = [];
  for (const s of st.suspenders) sp.push(s.bottom.x, s.bottom.y, s.bottom.z, s.top.x, s.top.y, s.top.z);
  const ropeGeo = new THREE.BufferGeometry();
  ropeGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const ropes = new THREE.LineSegments(ropeGeo, new THREE.LineBasicMaterial({ color: 0x8e9498, transparent: true, opacity: 0.7 }));
  ropes.name = 'bay_bridge:suspenders';
  model.add(ropes);

  const lights = buildLights(st.suspenders, st.roadLamps, st.lowerLamps, st.beacons);
  model.add(lights.group);

  const f = frameFromAxis(origin[0], origin[1], 1, 0);
  const { pivot, inner } = makePivot('bay_bridge', f, 0);
  inner.add(model);
  return {
    name: 'bay_bridge',
    pivot,
    buildingIds: pylons.map((r) => r.id),
    objectFor,
    update(_dt, t) {
      lights.update(t);
    },
  };
}
