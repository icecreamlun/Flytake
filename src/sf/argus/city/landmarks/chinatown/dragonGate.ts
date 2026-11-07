/**
 * Dragon Gate (Chinatown Gateway, Clayton Lee, 1970) at Grant Ave & Bush St: a three-portal paifang.
 * Four stone pillars on plinths, painted lintels (red / green / blue with gold), the 天下為公 plaque,
 * dougong bracket rows, three green glazed-tile hip roofs with swept-up eaves, ridge dragons chasing a
 * flaming pearl, chiwen fish at the ridge ends, and two guardian lions (foo dogs).
 *
 * There is no OSM building for the gate; it is placed at the OSM node (man_made=ceremonial_gate), centred
 * between the building fronts and aligned to Grant Avenue from city.json.
 */
import * as THREE from 'three';
import { PartBuilder } from '../common/builder';
import { box, cyl, lathe, sphere, tube, xf } from '../common/geom';
import { chineseRoof, type RoofSpec } from '../common/chineseRoof';
import { lmMaterial } from '../common/materials';
import { beamPaint, gatePlaque } from '../common/canvasArt';
import { frameFromAxis, makePivot } from '../common/frame';
import type { LandmarkBuild, LandmarkEnv } from '../common/types';

/** OSM node 65328703 "Dragon Gate", projected. */
const GATE_XZ: [number, number] = [-669.3, 312.1];

const C = {
  stone: '#bdb8aa',
  plinth: '#9c978b',
  red: '#a3221a',
  green: '#1e6a4c',
  blue: '#24508a',
  gold: '#d6aa3e',
  tileGreen: '#3a7d4e',
  ridge: '#4d9a5a',
  lion: '#b9b4a8',
};

type Add = (key: string, g: THREE.BufferGeometry, o?: { color?: THREE.ColorRepresentation; glow?: number; uv?: 'box' | 'keep'; smooth?: boolean }) => void;

/** Direction of Grant Ave near the gate (unit, pointing north into Chinatown). */
function grantDirection(env: LandmarkEnv): [number, number] {
  const pts = env.roadsNamed('Grant Avenue').flatMap((r) => r.points);
  const near = pts.filter(([x, z]) => Math.hypot(x - GATE_XZ[0], z - GATE_XZ[1]) < 70).sort((a, b) => b[1] - a[1]);
  if (near.length >= 2) {
    const a = near[0];
    const b = near[near.length - 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > 10) return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  }
  return [-0.159, -0.987];
}

function roofAssembly(add: Add, sp: RoofSpec, x: number, ridgeOrnaments: 'grand' | 'small'): void {
  const r = chineseRoof(sp);
  const T = (g: THREE.BufferGeometry) => xf(g, { x });
  // Solid painted core between the bracket row and the ridge (no see-through gap under the roof).
  add('paint', T(box(2 * sp.ar + 0.6, sp.yr - sp.ye + 0.15, 0.62, 0, sp.ye - 0.45, 0)), { color: C.green });
  add('tile', T(r.tiles), { color: C.tileGreen, uv: 'keep' });
  add('paint', T(r.under), { color: C.green });
  add('paint', T(r.fascia), { color: C.red });
  // Ridge: a rounded ridge roll with a flat cap.
  const [a, b] = r.ridge;
  const ridgeLen = b.x - a.x + 0.5;
  add('ridge', T(xf(cyl(0.16, 0.16, ridgeLen, 8), { rz: Math.PI / 2, y: a.y + 0.12, x: 0 })), { color: C.ridge, smooth: true });
  add('ridge', T(box(ridgeLen, 0.28, 0.3, 0, a.y - 0.06, 0)), { color: C.ridge });
  for (const h of r.hips) add('ridge', T(tube(h.map((p) => p.clone().setY(p.y + 0.08)), 0.11, 6, 2)), { color: C.ridge, smooth: true });
  // Swept corner tips: small upturned horns with a gold bead.
  for (const c of r.corners) {
    const dir = new THREE.Vector3(c.x, 0, c.z).normalize();
    const tip = tube([c.clone().add(new THREE.Vector3(0, 0.08, 0)), c.clone().addScaledVector(dir, 0.35).add(new THREE.Vector3(0, 0.3, 0)), c.clone().addScaledVector(dir, 0.45).add(new THREE.Vector3(0, 0.62, 0))], 0.07, 6, 3);
    add('ridge', T(tip), { color: C.ridge, smooth: true });
    add('gold', T(sphere(0.08, c.x + dir.x * 0.45, c.y + 0.68, c.z + dir.z * 0.45, 8, 6)), { color: C.gold, smooth: true });
  }
  // Chiwen (ridge-end fish): curled upright fins at both ends of the main ridge.
  const fishH = ridgeOrnaments === 'grand' ? 0.95 : 0.6;
  for (const s of [-1, 1]) {
    const sh = new THREE.Shape();
    sh.moveTo(0, 0);
    sh.lineTo(0.35, 0);
    sh.quadraticCurveTo(0.42, fishH * 0.6, 0.1, fishH);
    sh.quadraticCurveTo(-0.25, fishH * 1.05, -0.2, fishH * 0.7);
    sh.quadraticCurveTo(0.05, fishH * 0.75, 0.05, fishH * 0.45);
    sh.quadraticCurveTo(-0.05, fishH * 0.2, 0, 0);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.18, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1, curveSegments: 6 });
    g.translate(0, 0, -0.09);
    if (s < 0) g.scale(-1, 1, 1);
    g.translate(s * (b.x + 0.05), a.y + 0.2, 0);
    add('gold', T(g), { color: C.gold });
  }
  if (ridgeOrnaments === 'grand') {
    // Flaming pearl on the ridge centre.
    add('gold', T(sphere(0.24, 0, a.y + 0.62, 0, 12, 8)), { color: '#f0c14a', smooth: true, glow: 0.6 });
    add('gold', T(lathe([[0.001, 0], [0.18, 0.05], [0.1, 0.3], [0.001, 0.38]], 8, 0, a.y + 0.22, 0)), { color: C.gold });
    // Two dragons undulating along the ridge toward the pearl.
    for (const s of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      const x0 = s * (b.x - 0.4);
      const x1 = s * 0.45;
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const x = x0 + (x1 - x0) * t;
        pts.push(new THREE.Vector3(x, a.y + 0.32 + 0.22 * Math.sin(t * Math.PI * 2.5) * (1 - t * 0.3), 0.06 * Math.cos(t * 7)));
      }
      add('dragon', T(tube(pts, 0.085, 7, 3)), { color: '#c9a640', smooth: true });
      // Head: snout block + horns, raised toward the pearl.
      const hp = pts[pts.length - 1];
      add('dragon', T(box(0.36, 0.22, 0.2, hp.x - s * 0.05, hp.y - 0.06, 0)), { color: '#c9a640' });
      add('dragon', T(box(0.22, 0.12, 0.16, hp.x + s * 0.18, hp.y - 0.02, 0)), { color: '#c9a640' });
      for (const z of [-0.07, 0.07]) add('dragon', T(xf(cyl(0.015, 0.03, 0.28, 5), { rz: s * 0.7, x: hp.x - s * 0.12, y: hp.y + 0.12, z })), { color: '#c9a640' });
      // Spines along the back.
      for (let i = 1; i < pts.length - 1; i += 2) add('dragon', T(xf(cyl(0.005, 0.04, 0.14, 4), { x: pts[i].x, y: pts[i].y + 0.07, z: pts[i].z })), { color: '#3f8a52' });
    }
  } else {
    add('gold', T(sphere(0.14, 0, a.y + 0.4, 0, 10, 6)), { color: C.gold, smooth: true });
  }
}

/** Dougong bracket row along x ∈ [x0, x1] under an eave, on both faces (z = ±d). */
function brackets(add: Add, x0: number, x1: number, y: number, d: number): void {
  const n = Math.max(2, Math.round((x1 - x0) / 0.55));
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    for (const s of [-1, 1]) {
      add('paint', box(0.2, 0.16, 0.2, x, y, s * d), { color: C.green });
      add('paint', box(0.46, 0.1, 0.14, x, y + 0.16, s * (d + 0.05)), { color: C.blue });
      add('paint', box(0.16, 0.12, 0.42, x, y + 0.16, s * (d + 0.12)), { color: C.green });
      add('gold', box(0.2, 0.08, 0.2, x, y + 0.26, s * (d + 0.18)), { color: C.gold });
      add('paint', box(0.6, 0.1, 0.16, x, y + 0.34, s * (d + 0.2)), { color: C.red });
    }
  }
}

/** Seated guardian lion on a plinth (stylised but readable). */
function fooDog(add: Add, x: number, z: number, facing: number, male: boolean): void {
  const parts: THREE.BufferGeometry[] = [];
  const L = (g: THREE.BufferGeometry) => parts.push(g);
  // Pedestal (two-step) with a carved band.
  L(box(1.2, 0.9, 1.4, 0, 0, 0));
  L(box(1.05, 0.12, 1.25, 0, 0.9, 0));
  // Haunches / body.
  L(xf(sphere(0.42, 0, 0, 0, 12, 8), { sx: 1.05, sy: 0.85, sz: 1.25, y: 1.42, z: -0.12 }));
  // Chest, raised.
  L(xf(sphere(0.36, 0, 0, 0, 12, 8), { sx: 1.0, sy: 1.25, sz: 0.9, y: 1.78, z: 0.12 }));
  // Front legs.
  for (const sx of [-0.2, 0.2]) L(cyl(0.1, 0.12, 0.75, 8, sx, 1.02, 0.36));
  // Head with mane curls.
  L(sphere(0.33, 0, 2.28, 0.2, 14, 10));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    L(sphere(0.11, Math.cos(a) * 0.3, 2.28 + Math.sin(a) * 0.3, 0.08, 6, 5));
  }
  L(xf(box(0.3, 0.18, 0.2, 0, 0, 0), { y: 2.12, z: 0.45 })); // muzzle
  for (const sx of [-0.1, 0.1]) L(sphere(0.045, sx, 2.36, 0.5, 6, 5)); // eyes
  // Paw on a ball (male) or on a cub (female).
  if (male) L(sphere(0.17, 0.26, 1.2, 0.48, 10, 8));
  else L(sphere(0.13, 0.26, 1.16, 0.48, 10, 8));
  // Tail curl.
  L(tube([new THREE.Vector3(0, 1.3, -0.55), new THREE.Vector3(0, 1.7, -0.68), new THREE.Vector3(0, 1.95, -0.55)], 0.08, 6, 3));
  for (const g of parts) {
    xf(g, { ry: facing, x, z });
    add('lion', g, { color: C.lion, smooth: true });
  }
}

export function buildDragonGate(env: LandmarkEnv): LandmarkBuild | null {
  const [nx, nz] = grantDirection(env);
  // Local +X across the street (east-ish), local +Z faces south toward Bush St (the gate's front).
  const ux = -nz;
  const uz = nx;
  const f = frameFromAxis(GATE_XZ[0], GATE_XZ[1], ux, uz);
  // Sit on the lowest ground under the pillar line so nothing floats.
  let base = Infinity;
  for (const s of [-6, -3, 0, 3, 6]) base = Math.min(base, env.ground(GATE_XZ[0] + ux * s, GATE_XZ[1] + uz * s));

  const b = new PartBuilder();
  const add: Add = (k, g, o) => b.add(k, g, o);

  const XC = 3.35; // central pillars
  const XO = 5.75; // outer pillars
  // Pillars on plinths (stone).
  for (const [x, w, h] of [
    [-XC, 0.78, 8.0],
    [XC, 0.78, 8.0],
    [-XO, 0.66, 5.6],
    [XO, 0.66, 5.6],
  ]) {
    add('plinth', box(w + 0.5, 0.9, w + 0.9, x, -0.6, 0), { color: C.plinth });
    add('plinth', box(w + 0.3, 0.2, w + 0.7, x, 0.3, 0), { color: C.plinth });
    add('stone', box(w, h, w, x, 0.5, 0), { color: C.stone });
    // Painted capital band where the beams meet.
    add('paint', box(w + 0.08, 0.5, w + 0.08, x, h - 0.6, 0), { color: C.red });
  }
  // Stone drum bases (bao gu shi) clasping the central pillars front and back.
  for (const x of [-XC, XC]) for (const z of [-0.75, 0.75]) add('plinth', xf(cyl(0.42, 0.42, 0.24, 14), { rx: Math.PI / 2, x, y: 1.0, z }), { color: C.plinth, smooth: true });

  // Central portal: two lintels with the plaque between them.
  const beamTex = (len: number) => {
    const g = new THREE.BoxGeometry(len, 0.5, 0.42);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (len / 2.4));
    return g;
  };
  const lintel = (len: number, x: number, y: number, z = 0) => {
    const g = beamTex(len);
    g.translate(x, y + 0.25, z);
    add('beam', g, { uv: 'keep' });
  };
  lintel(2 * XC + 1.3, 0, 5.9);
  lintel(2 * XC + 1.0, 0, 7.35);
  // Plaque frame panels.
  add('paint', box(2 * XC - 0.6, 0.95, 0.2, 0, 6.4, 0), { color: C.green });
  // Side portals: lintels.
  for (const s of [-1, 1]) {
    lintel(XO - XC + 1.0, (s * (XC + XO)) / 2, 4.0);
    lintel(XO - XC + 0.8, (s * (XC + XO)) / 2, 4.9);
    add('paint', box(XO - XC - 0.8, 0.4, 0.18, (s * (XC + XO)) / 2, 4.5, 0), { color: C.red });
  }
  // Bracket rows under the eaves.
  brackets(add, -XC - 0.2, XC + 0.2, 7.85, 0.12);
  for (const s of [-1, 1]) brackets(add, s > 0 ? XC + 0.2 : -XO - 0.2, s > 0 ? XO + 0.2 : -XC - 0.2, 5.4, 0.1);

  // Roofs.
  roofAssembly(add, { ae: XC + 1.55, be: 1.65, ar: XC - 0.2, ye: 8.25, yr: 9.55, curl: 0.42, thick: 0.2 }, 0, 'grand');
  for (const s of [-1, 1]) roofAssembly(add, { ae: (XO - XC) / 2 + 1.05, be: 1.35, ar: (XO - XC) / 2 - 0.3, ye: 5.8, yr: 6.75, curl: 0.3, thick: 0.18 }, (s * (XC + XO)) / 2, 'small');

  // Guardian lions in front of the central pillars, facing south (+Z).
  fooDog(add, -XC - 0.05, 1.55, 0, true);
  fooDog(add, XC + 0.05, 1.55, 0, false);

  const tile = lmMaterial({ tex: 'tile', roughness: 1, metalness: 0.05, bump: 1.2, flood: { color: '#ffd9a8', intensity: 0.5, y0: base, y1: base + 10, topScale: 1 } });
  const paint = beamPaint();
  const flood = { color: '#ffd2a0', intensity: 1.1, y0: base, y1: base + 10, topScale: 0.9 };
  const mats: Record<string, THREE.Material> = {
    stone: lmMaterial({ tex: 'concrete', roughness: 0.8, weather: { baseY: base, grime: 0.25, mottle: 0.1 }, flood }),
    plinth: lmMaterial({ tex: 'concrete', roughness: 0.85, weather: { baseY: base, grime: 0.3, mottle: 0.1 }, flood }),
    paint: lmMaterial({ tex: 'lacquer', roughness: 0.55, flood }),
    beam: lmMaterial({ map: paint, roughness: 0.5, flood }),
    gold: lmMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.75, glow: '#ffc060', glowIntensity: 1.2, flood }),
    ridge: lmMaterial({ tex: 'lacquer', roughness: 0.3, flood }),
    tile,
    dragon: lmMaterial({ color: '#ffffff', roughness: 0.3, metalness: 0.5, flood }),
    lion: lmMaterial({ tex: 'concrete', roughness: 0.75, flood }),
  };
  const model = b.build(mats, 'dragon_gate');

  // The 天下為公 plaque on both faces of the central portal.
  const plaqueMat = lmMaterial({ map: gatePlaque(), roughness: 0.45, vertexColors: false, glow: '#ffe2a0', glowIntensity: 1.2, glowAlbedo: true });
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(2.3, 0.9);
    g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(4).fill(1), 1));
    const m = new THREE.Mesh(g, plaqueMat);
    m.position.set(0, 6.88, s * 0.115);
    m.rotation.y = s > 0 ? 0 : Math.PI;
    model.add(m);
  }

  const { pivot, inner } = makePivot('chinatown_gate', f, base);
  inner.add(model);
  return { name: 'chinatown_gate', pivot, buildingIds: [] };
}
