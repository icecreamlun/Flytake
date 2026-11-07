/**
 * Grant Avenue lantern canopy: strings of red silk lanterns hung across Grant Ave every ~12-15 m from the
 * Dragon Gate (Bush St) to Broadway (with gaps at the cross streets and the odd missing string), plus short
 * runs on the Chinatown side streets. Two instanced meshes (silk bodies / gold caps + tassels) sway on the
 * GPU (stronger while the ground shakes) and glow with a warm translucent core at night. Wires are a
 * single LineSegments.
 */
import * as THREE from 'three';
import type { RoadRecord, XZ } from '../../../contracts';
import { cyl, lathe } from '../common/geom';
import { lmMaterial } from '../common/materials';
import { rng } from '../common/textures';
import type { LandmarkBuild, LandmarkEnv } from '../common/types';

interface Station {
  p: XZ;
  /** Unit tangent along the street. */
  t: XZ;
  /** Half span between building fronts (m). */
  half: number;
}

/** Ordered polyline of a street's records within a z / x window (works for near-monotonic streets). */
function polyline(roads: RoadRecord[], keep: (p: XZ) => boolean, sortKey: (p: XZ) => number): XZ[] {
  const pts = roads.flatMap((r) => r.points).filter(keep);
  pts.sort((a, b) => sortKey(a) - sortKey(b));
  const out: XZ[] = [];
  for (const p of pts) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 1.5) out.push(p);
  return out;
}

/** Stations every `spacing` metres along a polyline between arc lengths s0 and s1. */
function stations(line: XZ[], spacing: number, s0: number, s1: number, half: number, jitter: () => number): Station[] {
  const out: Station[] = [];
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const total = cum[cum.length - 1];
  const end = Math.min(s1, total);
  for (let s = s0; s <= end; s += spacing * (0.85 + 0.3 * jitter())) {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const a = line[i - 1];
    const b = line[i];
    const seg = cum[i] - cum[i - 1] || 1;
    const k = (s - cum[i - 1]) / seg;
    const tx = (b[0] - a[0]) / seg;
    const tz = (b[1] - a[1]) / seg;
    out.push({ p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], t: [tx, tz], half });
  }
  return out;
}

function lanternGeometries(): { body: THREE.BufferGeometry; trim: THREE.BufferGeometry } {
  // Origin = hanging point; the lantern hangs along −Y.
  const prof: [number, number][] = [];
  const top = -0.3;
  const h = 0.5;
  for (let i = 0; i <= 7; i++) {
    const u = i / 7;
    const y = top - u * h;
    const r = 0.3 * Math.sqrt(Math.max(0.0, 1 - Math.pow(2 * u - 1, 2))) * 0.92 + 0.08;
    prof.push([r, y]);
  }
  prof.reverse(); // lathe wants increasing y
  const body = lathe(prof, 10);
  body.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(body.getAttribute('position').count).fill(1), 1));
  const parts = [
    cyl(0.012, 0.012, 0.26, 3, 0, -0.26, 0, true),
    cyl(0.1, 0.12, 0.07, 8, 0, -0.33, 0),
    cyl(0.12, 0.1, 0.07, 8, 0, -0.85, 0),
    cyl(0.022, 0.05, 0.32, 5, 0, -1.17, 0, true),
  ].map((g) => g.toNonIndexed());
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const g of parts) {
    g.computeVertexNormals();
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nrm.push(...(g.getAttribute('normal').array as Float32Array));
  }
  const trim = new THREE.BufferGeometry();
  trim.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  trim.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  trim.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(pos.length / 3), 1));
  return { body, trim };
}

export function buildLanterns(env: LandmarkEnv): LandmarkBuild | null {
  const rand = rng(1970);
  const grant = env.roadsNamed('Grant Avenue');
  if (!grant.length) return null;
  // Bush St (gate) → Broadway. The streets module may already string lanterns across Grant itself (its
  // 'lanterns' prop set); two canopies on top of each other read as a field of red dots, so only add ours
  // there when it does not.
  const g = polyline(grant, ([, z]) => z < 330 && z > -490, (p) => -p[1]);
  const grantTaken = !!env.ctx.cityRoot.getObjectByName('lanterns');
  const st: Station[] = grantTaken ? [] : stations(g, 13.5, 30, 1e9, 7.0, rand);
  // Side streets: one block west of Grant (toward Stockton) and a little east.
  for (const name of ['Sacramento Street', 'Clay Street', 'Washington Street', 'Jackson Street', 'Pacific Avenue']) {
    const roads = env.roadsNamed(name);
    if (!roads.length) continue;
    // Grant crossing x ≈ nearest Grant point by z.
    const zs = roads.flatMap((r) => r.points.map((p) => p[1]));
    const zMid = zs.reduce((a, b) => a + b, 0) / zs.length;
    const gx = g.reduce((best, p) => (Math.abs(p[1] - zMid) < Math.abs(best[1] - zMid) ? p : best), g[0])[0];
    const line = polyline(roads, ([x]) => x < gx + 30 && x > gx - 120, (p) => p[0]);
    if (line.length < 2) continue;
    const w = roads[0].width / 2 + (roads[0].sidewalk ?? 2.5);
    // Start ~12 m west of Grant, run ~55 m toward Stockton.
    const cum = line.reduce<number[]>((acc, p, i) => (i ? [...acc, acc[i - 1] + Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1])] : [0]), []);
    let sGrant = 0;
    for (let i = 0; i < line.length; i++) if (line[i][0] <= gx) sGrant = cum[i];
    st.push(...stations(line, 10, Math.max(0, sGrant - 70), Math.max(0, sGrant - 12), Math.min(w, 6.5), rand));
  }

  // Gaps at intersections: no string within a few metres of another street's carriageway, and a few
  // strings simply missing (merchants string their own; the canopy is never perfectly regular).
  const cross = env.ctx.city.roads.filter(
    (r) => r.name !== 'Grant Avenue' && ['primary', 'secondary', 'tertiary', 'residential', 'living_street', 'pedestrian'].includes(r.kind) && r.points.some(([x, z]) => x > -1000 && x < -450 && z > -560 && z < 400),
  );
  const nearCross = (p: XZ) => {
    for (const r of cross) {
      const lim = r.width / 2 + 5;
      for (let i = 0; i + 1 < r.points.length; i++) {
        const [ax, az] = r.points[i];
        const [bx, bz] = r.points[i + 1];
        const vx = bx - ax;
        const vz = bz - az;
        const t = Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - az) * vz) / (vx * vx + vz * vz || 1)));
        if (Math.hypot(p[0] - ax - vx * t, p[1] - az - vz * t) < lim) return true;
      }
    }
    return false;
  };
  const kept = st.filter((s) => !nearCross(s.p) && rand() > 0.2);

  // Build strings.
  const lanterns: { pos: THREE.Vector3; yaw: number; s: number }[] = [];
  const wire: number[] = [];
  kept.forEach((s, k) => {
    const nx = -s.t[1];
    const nz = s.t[0];
    const skew = k % 3 === 1 ? 1.8 : k % 3 === 2 ? -1.8 : 0;
    const ax = s.p[0] - nx * s.half + s.t[0] * skew;
    const az = s.p[1] - nz * s.half + s.t[1] * skew;
    const bx = s.p[0] + nx * s.half - s.t[0] * skew;
    const bz = s.p[1] + nz * s.half - s.t[1] * skew;
    const h = 6.4 + rand() * 1.4;
    const ya = env.ground(ax, az) + h;
    const yb = env.ground(bx, bz) + h + (rand() - 0.5) * 0.7;
    // Catenary sag varies string to string (tight new wires … old slack ones).
    const sag = 0.35 + Math.pow(rand(), 1.5) * 1.0;
    const P = (u: number) => new THREE.Vector3(ax + (bx - ax) * u, ya + (yb - ya) * u - sag * 4 * u * (1 - u), az + (bz - az) * u);
    const segs = 12;
    for (let i = 0; i < segs; i++) {
      const p0 = P(i / segs);
      const p1 = P((i + 1) / segs);
      wire.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
    const n = Math.max(3, Math.round((2 * s.half) / (2.6 + rand() * 0.9)));
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      lanterns.push({ pos: P(u), yaw: rand() * Math.PI * 2, s: 0.9 + rand() * 0.25 });
    }
  });
  if (!lanterns.length) return null;

  const { body, trim } = lanternGeometries();
  const phase = new Float32Array(lanterns.length);
  for (let i = 0; i < phase.length; i++) phase[i] = rand() * Math.PI * 2;
  body.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  trim.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  // Silk body: a bloom-friendly warm core at night (× uLmNight = night / exposure), faint glow by day.
  const bodyMat = lmMaterial({ color: '#b3140c', roughness: 0.6, vertexColors: false, sway: true, lantern: true, glow: '#ffffff', glowIntensity: 1.5, emissive: '#2a0402' });
  const trimMat = lmMaterial({ color: '#c99a32', roughness: 0.4, metalness: 0.6, vertexColors: false, sway: true });
  const bodies = new THREE.InstancedMesh(body, bodyMat, lanterns.length);
  const trims = new THREE.InstancedMesh(trim, trimMat, lanterns.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  lanterns.forEach((l, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.yaw);
    sc.setScalar(l.s);
    m.compose(l.pos, q, sc);
    bodies.setMatrixAt(i, m);
    trims.setMatrixAt(i, m);
  });
  bodies.castShadow = true;
  bodies.receiveShadow = true;
  trims.castShadow = false;
  bodies.computeBoundingSphere();
  trims.computeBoundingSphere();
  const wireGeo = new THREE.BufferGeometry();
  wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
  const wires = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x1b1a19 }));
  const group = new THREE.Group();
  group.name = 'landmark:grant_lanterns';
  group.add(bodies, trims, wires);
  return { name: 'grant_lanterns', pivot: group, buildingIds: [] };
}
