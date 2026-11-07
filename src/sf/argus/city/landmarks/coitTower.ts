/**
 * Coit Tower (Arthur Brown Jr., 1933) on Telegraph Hill: 64 m fluted reinforced-concrete column on a
 * square pedestal rising from the mural lobby, the ring of tall arched observation windows near the
 * top, a stepped crown, floodlit white at night. Built on the OSM parts (lobby outline, pedestal, shaft).
 */
import * as THREE from 'three';
import type { XZ } from '../../contracts';
import { PartBuilder } from './common/builder';
import { archPath, box, cyl, prism, rect, sweepClosed, type V2 } from './common/geom';
import { lmMaterial } from './common/materials';
import { centroid, frameFromAxis, makePivot, orientedRect, toLocal } from './common/frame';
import type { LandmarkBuild, LandmarkEnv } from './common/types';

const CREAM = '#e6dfcf';

/** Fluted shaft: `flutes` concave channels separated by narrow fillets. */
function flutedShaft(r: number, rTop: number, y0: number, y1: number, flutes: number, depth: number): THREE.BufferGeometry {
  const seg = flutes * 8;
  const rings = 2;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const y = y0 + (y1 - y0) * v;
    const R = r + (rTop - r) * v;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ph = ((i % 8) / 8) * Math.PI * 2; // 0 at the fillet
      const groove = Math.max(0, Math.sin(ph / 2)) ** 1.5; // smooth concave channel between fillets
      const rr = R - depth * groove;
      pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildCoitTower(env: LandmarkEnv): LandmarkBuild | null {
  const recs = env.byLandmark('coit_tower');
  if (!recs.length) return null;
  const byH = [...recs].sort((a, b) => b.height - a.height);
  const shaft = byH[0];
  const base = Math.min(...recs.map((r) => r.baseElevation));
  const [cx, cz] = centroid(shaft.footprint);
  const lobbyRec = recs.reduce((a, b) => (polyArea(b.footprint) > polyArea(a.footprint) ? b : a));
  const pedRec = recs.find((r) => r.height >= 11 && r.height <= 14 && r.footprint.length === 4);
  // Orient the frame with the pedestal square (falls back to the lobby rectangle).
  const or = orientedRect((pedRec ?? lobbyRec).footprint);
  const f = frameFromAxis(cx, cz, or.ux, or.uz);
  const L = (p: XZ): V2 => toLocal(f, p[0], p[1]);

  const b = new PartBuilder();
  const R = 5.6;
  const H = Math.max(60, Math.min(70, shaft.height));
  // Lobby: the OSM outline, two storeys with a cornice and parapet; entrance pavilions.
  const lobby = lobbyRec.footprint.map(L);
  const lobbyH = 6.2;
  b.add('concrete', prism(lobby, -1.5, lobbyH), { color: CREAM });
  b.add(
    'concrete',
    sweepClosed(lobby, [
      [-0.3, lobbyH - 0.6],
      [0.15, lobbyH - 0.55],
      [0.35, lobbyH - 0.2],
      [0.35, lobbyH + 0.05],
      [0.05, lobbyH + 0.05],
      [0.05, lobbyH + 0.9],
      [-0.3, lobbyH + 0.9],
    ]),
    { color: CREAM },
  );
  for (const r of recs) {
    if (r === lobbyRec || r === shaft || r === pedRec || r.height >= 40) continue;
    b.add('concrete', prism(r.footprint.map(L), -1, Math.min(r.height, 8.5)), { color: CREAM });
  }
  // Arched windows / doors on the lobby walls: sample the local bbox faces, keep spots where the real
  // outline wall is within reach (the outline has notches).
  const lx0 = Math.min(...lobby.map((p) => p[0]));
  const lx1 = Math.max(...lobby.map((p) => p[0]));
  const lz0 = Math.min(...lobby.map((p) => p[1]));
  const lz1 = Math.max(...lobby.map((p) => p[1]));
  const distToOutline = (x: number, z: number) => {
    let d = Infinity;
    for (let i = 0; i < lobby.length; i++) {
      const [ax, az] = lobby[i];
      const [bx, bz] = lobby[(i + 1) % lobby.length];
      const vx = bx - ax;
      const vz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1)));
      d = Math.min(d, Math.hypot(ax + vx * t - x, az + vz * t - z));
    }
    return d;
  };
  for (const [nx, nz] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const) {
    const along = nz !== 0 ? [lx0, lx1] : [lz0, lz1];
    const off = nz > 0 ? lz1 : nz < 0 ? lz0 : nx > 0 ? lx1 : lx0;
    for (const k of [0.2, 0.4, 0.6, 0.8]) {
      const t = along[0] + (along[1] - along[0]) * k;
      const x = nz !== 0 ? t : off;
      const z = nz !== 0 ? off : t;
      if (distToOutline(x, z) > 0.45) continue;
      const g = new THREE.ShapeGeometry(new THREE.Shape(archPath(0, 1.5, 0.8, 3.4, 10).getPoints()));
      g.rotateY(Math.atan2(nx, nz));
      g.translate(x + nx * 0.05, 0, z + nz * 0.05);
      b.add('glass', g, { glow: 0.8 });
    }
  }
  // Square pedestal.
  const ped = pedRec ? pedRec.footprint.map(L) : rect(5.9, 5.9);
  b.add('concrete', prism(ped, lobbyH, 12.5), { color: CREAM });
  b.add('concrete', sweepClosed(ped, [[-0.3, 12.3], [0.2, 12.35], [0.35, 12.7], [-0.3, 12.7]]), { color: CREAM });
  // Fluted shaft.
  const winY0 = H - 9.5;
  b.add('concrete', flutedShaft(R, R - 0.2, 12.7, winY0, 20, 0.32), { color: CREAM, smooth: true });
  b.add('concrete', cyl(R + 0.15, R + 0.15, 0.5, 40, 0, winY0, 0), { color: CREAM, smooth: true });
  // Observation level: tall arched openings between piers.
  b.add('concrete', flutedShaft(R - 0.25, R - 0.25, winY0 + 0.5, H - 3.4, 20, 0.2), { color: CREAM, smooth: true });
  const nWin = 10;
  for (let i = 0; i < nWin; i++) {
    const a = (i / nWin) * Math.PI * 2;
    const shp = new THREE.Shape(archPath(0, 1.15, 0, 3.6, 10).getPoints());
    const g = new THREE.ShapeGeometry(shp);
    g.translate(0, winY0 + 1.1, R - 0.2);
    g.rotateY(Math.PI / 2 - a);
    b.add('glass', g, { glow: 1 });
  }
  // Crown: projecting cornice, stepped parapet with small merlons.
  b.add('concrete', cyl(R + 0.35, R - 0.1, 0.9, 40, 0, H - 3.4, 0), { color: CREAM, smooth: true });
  b.add('concrete', cyl(R + 0.05, R + 0.05, 1.6, 40, 0, H - 2.5, 0), { color: CREAM, smooth: true });
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const g = box(1.1, 0.9, 0.7, 0, 0, 0);
    g.rotateY(Math.PI / 2 - a);
    g.translate(Math.cos(a) * (R - 0.2), H - 0.9, Math.sin(a) * (R - 0.2));
    b.add('concrete', g, { color: CREAM });
  }
  b.add('dark', cyl(R - 0.6, R - 0.6, 0.2, 32, 0, H - 1.1, 0), { color: '#5a5650' });

  const flood = { color: '#fff3e0', intensity: 1.0, y0: base, y1: base + H, topScale: 0.75 };
  const mats: Record<string, THREE.Material> = {
    concrete: lmMaterial({ tex: 'concrete', roughness: 0.85, bump: 0.6, weather: { baseY: base, grime: 0.25, mottle: 0.12 }, flood }),
    glass: lmMaterial({ color: '#1c1d20', roughness: 0.3, glow: '#ffd9a0', glowIntensity: 1.6 }),
    dark: lmMaterial({ color: '#ffffff', roughness: 0.9 }),
  };
  const model = b.build(mats, 'coit_tower');
  const { pivot, inner } = makePivot('coit_tower', f, base);
  inner.add(model);
  return { name: 'coit_tower', pivot, buildingIds: recs.map((r) => r.id) };
}

function polyArea(fp: XZ[]): number {
  let a = 0;
  for (let i = 0; i < fp.length; i++) {
    const [x0, z0] = fp[i];
    const [x1, z1] = fp[(i + 1) % fp.length];
    a += x0 * z1 - x1 * z0;
  }
  return Math.abs(a / 2);
}
