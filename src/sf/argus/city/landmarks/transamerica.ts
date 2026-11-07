/**
 * Transamerica Pyramid (William Pereira, 1972), 260 m. Four tapering faces of white crushed-quartz
 * precast with a fine grid of deep-set windows (44 m wide at the base → 14 m at the 48th floor), the two
 * vertical "wings" on the east (elevators) and west (stairs / smoke tower) faces rising from ~floor 29,
 * the 65 m aluminium-clad spire with its red aviation beacon, and the base "truss" of inclined columns
 * forming an arcade around the recessed glass lobby.
 */
import * as THREE from 'three';
import { PartBuilder } from './common/builder';
import { beam, box, cyl, hexa, quadUV, sphere } from './common/geom';
import { lmMaterial } from './common/materials';
import { allPoints, frameFromAxis, makePivot, orientedRect } from './common/frame';
import type { LandmarkBuild, LandmarkEnv } from './common/types';

// Vertical profile (m above base).
const H = {
  lobbyTop: 14,
  gridStart: 20,
  occupiedTop: 195,
  spireTop: 256,
  mastTop: 260,
  wingBase: 113,
  wingTop: 205,
};
const HW0 = 22.5; // face half-width at ground level (virtual)
const HW_TOP = 7.0; // at the occupied top
const slope = (HW0 - HW_TOP) / H.occupiedTop;
const hw = (y: number) => HW0 - slope * y;
const FOOT = 26.6; // inclined column feet half-width (outer arcade)

/** Warm off-white crushed-quartz precast. */
const WHITE = '#e8e2d6';

export function buildTransamerica(env: LandmarkEnv): LandmarkBuild | null {
  const recs = env.byLandmark('transamerica_pyramid');
  if (!recs.length) return null;
  const r = orientedRect(allPoints(recs));
  // Pick the rect axis closest to world east so the wings land on the east/west faces.
  const axes: [number, number][] = [
    [r.ux, r.uz],
    [-r.uz, r.ux],
    [-r.ux, -r.uz],
    [r.uz, -r.ux],
  ];
  const [ax, az] = axes.reduce((a, b) => (b[0] > a[0] ? b : a));
  const f = frameFromAxis(r.cx, r.cz, ax, az);
  const base = Math.min(...recs.map((b) => b.baseElevation));

  const b = new PartBuilder();
  const up = new THREE.Vector3(0, 1, 0);
  const normals = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1)];
  const P = (n: THREE.Vector3, x: number, y: number, out: number) => {
    const right = new THREE.Vector3().crossVectors(up, n);
    return right.multiplyScalar(x).addScaledVector(n, out).setY(y);
  };

  // ── Tapered faces with the window grid (UVs in metres: u along the face, v from the first office floor) ──
  for (const n of normals) {
    const y0 = H.gridStart;
    const y1 = H.occupiedTop;
    const a = hw(y0);
    const c = hw(y1);
    b.add(
      'grid',
      quadUV(
        [P(n, -a, y0, a), P(n, a, y0, a), P(n, c, y1, c), P(n, -c, y1, c)],
        [
          [-a, 0],
          [a, 0],
          [c, y1 - y0],
          [-c, y1 - y0],
        ],
      ),
      { uv: 'keep' },
    );
    // Spire face (aluminium), continuing from the top floor to the apex.
    const s0 = H.occupiedTop - 1;
    const sa = hw(s0);
    const st = 0.35;
    b.add(
      'alu',
      quadUV(
        [P(n, -sa, s0, sa), P(n, sa, s0, sa), P(n, st, H.spireTop, st), P(n, -st, H.spireTop, st)],
        [
          [-sa, 0],
          [sa, 0],
          [st, H.spireTop - s0],
          [-st, H.spireTop - s0],
        ],
      ),
      { uv: 'keep' },
    );
    // Precast belt at the top of the base (continues the face plane, slightly proud).
    const ba = hw(H.lobbyTop) + 0.45;
    const bc = hw(H.gridStart) + 0.45;
    b.add(
      'plain',
      quadUV(
        [P(n, -ba, H.lobbyTop, ba), P(n, ba, H.lobbyTop, ba), P(n, bc, H.gridStart, bc), P(n, -bc, H.gridStart, bc)],
        [
          [-ba, 0],
          [ba, 0],
          [bc, 6],
          [-bc, 6],
        ],
      ),
      { color: WHITE },
    );
    // Step between the belt and the window faces.
    const g = hw(H.gridStart);
    b.add(
      'plain',
      quadUV(
        [P(n, -bc, H.gridStart, bc), P(n, bc, H.gridStart, bc), P(n, g, H.gridStart, g), P(n, -g, H.gridStart, g)],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ),
      { color: WHITE },
    );
    // Soffit under the belt (faces down) out to the lobby glass line.
    const lob = 19.6;
    b.add(
      'plain',
      quadUV(
        [P(n, -ba, H.lobbyTop, ba), P(n, -lob, H.lobbyTop, lob), P(n, lob, H.lobbyTop, lob), P(n, ba, H.lobbyTop, ba)],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ),
      { color: '#d9d6cf' },
    );
    // Recessed lobby glazing.
    b.add(
      'lobby',
      quadUV(
        [P(n, -lob, 0, lob), P(n, lob, 0, lob), P(n, lob, H.lobbyTop, lob), P(n, -lob, H.lobbyTop, lob)],
        [
          [-lob, 0],
          [lob, 0],
          [lob, H.lobbyTop],
          [-lob, H.lobbyTop],
        ],
      ),
      { uv: 'keep', glow: 1 },
    );

    // Inclined columns: feet spread out to the arcade line, heads under the belt.
    const topHw = hw(H.lobbyTop) + 0.2;
    for (const s of [-0.62, -0.21, 0.21, 0.62]) {
      const xt = s * topHw;
      const xb = s * FOOT;
      const wt = 0.75;
      const wb = 1.05;
      const dt = 1.5;
      const db = 1.9;
      b.add(
        'plain',
        hexa([
          P(n, xb - wb, 0, FOOT),
          P(n, xb + wb, 0, FOOT),
          P(n, xb + wb, 0, FOOT - db),
          P(n, xb - wb, 0, FOOT - db),
          P(n, xt - wt, H.lobbyTop + 0.5, topHw),
          P(n, xt + wt, H.lobbyTop + 0.5, topHw),
          P(n, xt + wt, H.lobbyTop + 0.5, topHw - dt),
          P(n, xt - wt, H.lobbyTop + 0.5, topHw - dt),
        ]),
        { color: WHITE },
      );
    }
  }
  // Corner piers (diagonal legs, the strongest element of the base).
  for (let k = 0; k < 4; k++) {
    const n = normals[k];
    const m = normals[(k + 1) % 4];
    const ct = hw(H.lobbyTop) + 0.2;
    const cb = FOOT + 0.2;
    const corner = (h: number, y: number, inset: number, side: number) => {
      // Point near the corner (n·h, m·h) pulled in by `inset` along both axes, offset `side` along the diagonal normal.
      const v = n.clone().multiplyScalar(h - inset).add(m.clone().multiplyScalar(h - inset));
      const diag = n.clone().sub(m).normalize();
      return v.addScaledVector(diag, side).setY(y);
    };
    const wb = 1.5;
    const wt = 1.1;
    b.add(
      'plain',
      hexa([
        corner(cb, 0, 0, -wb),
        corner(cb, 0, 0, wb),
        corner(cb, 0, 2.4, wb),
        corner(cb, 0, 2.4, -wb),
        corner(ct, H.lobbyTop + 0.5, 0, -wt),
        corner(ct, H.lobbyTop + 0.5, 0, wt),
        corner(ct, H.lobbyTop + 0.5, 1.8, wt),
        corner(ct, H.lobbyTop + 0.5, 1.8, -wt),
      ]),
      { color: WHITE },
    );
  }

  // ── Wings on the east (+X) and west (−X) faces ──
  // Same material as the faces (identical shading day and night); constant UVs sample a solid
  // precast panel texel of the window texture, so no windows (and no night window glow).
  const panelUV = (g: THREE.BufferGeometry) => {
    const n = g.getAttribute('position').count;
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      uv[i * 2] = 0.1 * 2.05;
      uv[i * 2 + 1] = 0.12 * 4.05;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  };
  const wingOut = hw(H.wingBase);
  for (const sx of [1, -1]) {
    const inner = hw(H.wingTop) - 1.5;
    const cx = sx * (wingOut + inner) / 2;
    const w = wingOut - inner;
    b.add('grid', panelUV(box(w, H.wingTop - H.wingBase, 10, cx, H.wingBase, 0)), { uv: 'keep' });
    // Parapet cap and vertical fins on the outer face.
    b.add('grid', panelUV(box(w + 0.4, 0.8, 10.4, cx, H.wingTop, 0)), { uv: 'keep', color: '#f4f2ee' });
    for (const z of [-2.6, 0, 2.6]) b.add('grid', panelUV(box(0.35, H.wingTop - H.wingBase - 2, 0.5, sx * (wingOut + 0.17), H.wingBase + 2, z)), { uv: 'keep', color: '#f2f0ec' });
    // Vertical slot windows, one per floor between the fins (outer face) and up the side faces, each in a
    // deep precast reveal (jambs, head and sill stand 0.35 m proud so the opening reads recessed).
    const floorH = 3.9;
    const xo = sx * (wingOut + 0.01);
    const slot = (px: number, pz: number, y: number, alongX: boolean, outSign: number) => {
      const sw = 0.75;
      const sh = 2.5;
      const d = 0.35;
      const g = alongX ? box(sw, sh, 0.06, px, y, pz) : box(0.06, sh, sw, px, y, pz);
      // Stair / lobby lights: about a third of the slots glow at night.
      const hsh = Math.abs(Math.sin(px * 12.9898 + pz * 78.233 + y * 3.71) * 43758.5453) % 1;
      b.add('slot', g, { glow: hsh < 0.35 ? 0.5 + hsh : 0 });
      const o = (v: number) => v + outSign * d * 0.5;
      if (alongX) {
        for (const e of [-1, 1]) b.add('grid', panelUV(box(0.22, sh + 0.44, d, px + e * (sw / 2 + 0.11), y - 0.22, o(pz))), { uv: 'keep' });
        b.add('grid', panelUV(box(sw + 0.66, 0.22, d, px, y + sh, o(pz))), { uv: 'keep' });
        b.add('grid', panelUV(box(sw + 0.66, 0.22, d + 0.08, px, y - 0.22, o(pz))), { uv: 'keep' });
      } else {
        for (const e of [-1, 1]) b.add('grid', panelUV(box(d, sh + 0.44, 0.22, o(px), y - 0.22, pz + e * (sw / 2 + 0.11))), { uv: 'keep' });
        b.add('grid', panelUV(box(d, 0.22, sw + 0.66, o(px), y + sh, pz)), { uv: 'keep' });
        b.add('grid', panelUV(box(d + 0.08, 0.22, sw + 0.66, o(px), y - 0.22, pz)), { uv: 'keep' });
      }
    };
    for (let y = H.wingBase + 2.2; y < H.wingTop - 3.5; y += floorH) {
      for (const z of [-1.3, 1.3]) slot(xo, z, y, false, sx);
      // Side faces (±z): two slots per floor near the outer edge.
      for (const zs of [-1, 1])
        for (const xf of [0.3, 0.7]) {
          const ax = inner + (wingOut - inner) * xf;
          if (ax > hw(y) + 0.8) slot(sx * ax, zs * 5.01, y, true, zs); // only where the side face is exposed
        }
    }
  }

  // ── Spire cladding: horizontal panel ribs and corner hip ridges (aluminium) ──
  for (let y = H.occupiedTop + 3; y < H.spireTop - 4; y += 3.6) {
    const k = (y - (H.occupiedTop - 1)) / (H.spireTop - (H.occupiedTop - 1));
    const half = hw(H.occupiedTop - 1) * (1 - k) + 0.35 * k;
    const r = half + 0.06;
    for (let q = 0; q < 4; q++) {
      const g = box(2 * r + 0.12, 0.16, 0.12, 0, y, r);
      g.rotateY((q * Math.PI) / 2);
      b.add('alu', g, { color: '#f4f5f6' });
    }
  }
  for (let q = 0; q < 4; q++) {
    const n = normals[q];
    const m = normals[(q + 1) % 4];
    const s0 = H.occupiedTop - 1;
    const c0 = n.clone().add(m).multiplyScalar(hw(s0)).setY(s0);
    const c1 = n.clone().add(m).multiplyScalar(0.35).setY(H.spireTop);
    b.add('alu', beam(c0, c1, 0.45, 0.45), { color: '#f4f5f6' });
  }

  // ── Spire tip: beacon housing + mast ──
  b.add('alu', cyl(0.45, 0.6, 2.0, 8, 0, H.spireTop - 0.6, 0), { color: '#ffffff' });
  b.add('dark', cyl(0.06, 0.08, H.mastTop - H.spireTop - 1.0, 6, 0, H.spireTop + 1.4, 0), { color: '#333333' });

  const mats: Record<string, THREE.Material> = {
    grid: lmMaterial({
      tex: 'precastGrid',
      color: '#f6efe2',
      roughness: 1,
      bump: 1.3,
      panelVar: 0.07,
      weather: { baseY: base, grime: 0.0, mottle: 0.05 },
      windows: { color: '#ffe0b0', intensity: 2.0, lit: 0.32 },
      flood: { color: '#dfe6ff', intensity: 0.035, y0: base, y1: base + H.occupiedTop, topScale: 2.5 },
    }),
    plain: lmMaterial({ tex: 'concrete', roughness: 0.75, bump: 0.6, weather: { baseY: base, grime: 0.2, mottle: 0.05 }, flood: { color: '#fff1dc', intensity: 0.6, y0: base, y1: base + 30, topScale: 0.06 } }),
    alu: lmMaterial({ tex: 'aluminum', color: '#eef0f1', metalness: 0.4, roughness: 0.4, bump: 1.0, flood: { color: '#e8eeff', intensity: 0.28, y0: base + H.occupiedTop, y1: base + H.spireTop, topScale: 1.6 } }),
    slot: lmMaterial({ color: '#2a3036', roughness: 0.15, metalness: 0.5, glow: '#ffe0b0', glowIntensity: 1.2 }),
    lobby: lmMaterial({ tex: 'curtain', metalness: 0.6, glow: '#ffd9a8', glowIntensity: 2.2 }),
    dark: lmMaterial({ color: '#ffffff', roughness: 0.8 }),
  };
  const model = b.build(mats, 'transamerica');

  // Red aviation beacon (blinks; visible at dusk/night through uLmNight).
  const beaconMat = lmMaterial({ color: '#5a0a06', roughness: 0.4, glow: '#ff1a0a', glowIntensity: 12, vertexColors: false });
  const beaconGeo = sphere(0.55, 0, H.spireTop + 1.6, 0, 12, 8);
  beaconGeo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(beaconGeo.getAttribute('position').count).fill(1), 1));
  const beacon = new THREE.Mesh(beaconGeo, beaconMat);
  model.add(beacon);
  const beaconU = beaconMat.userData.lm.uLmGlow.value as THREE.Color;
  const beaconBase = beaconU.clone();

  const { pivot, inner } = makePivot('transamerica_pyramid', f, base);
  inner.add(model);
  return {
    name: 'transamerica_pyramid',
    pivot,
    buildingIds: recs.map((x) => x.id),
    update(_dt, t) {
      // FAA L-864 style: ~30 flashes per minute.
      const on = (t * 0.5) % 1 < 0.45 ? 1 : 0.04;
      beaconU.copy(beaconBase).multiplyScalar(on);
    },
  };
}
