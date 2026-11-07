/**
 * Alcatraz Island from its real OpenStreetMap outline and building footprints (alcatrazData.ts):
 *  - a 3 m heightfield clipped to the coastline: sheer 8–40 m rock cliffs on the west / north,
 *    a low quay on the east (dock, Building 64), a terraced top that peaks at the cellhouse (~41 m)
 *    and steps down to the parade ground (south) and the industries bench (north-west),
 *  - vertex colours: dark rock with guano streaks on the cliffs, scrub / ice-plant on the benches,
 *    concrete around the buildings and on the parade ground,
 *  - every OSM building extruded (cellhouse, administration block, Building 64, industries,
 *    powerhouse, ruins …) plus the lighthouse, the water tower on stilts, the powerhouse chimney
 *    and the ferry dock.
 * Returned as one vertex-coloured, world-space geometry (one draw call).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { project } from '../../geo';
import { fbm2 } from './geography';
import { BUILDINGS, CHIMNEY, COAST, LIGHTHOUSE, WATER_TOWER } from './alcatrazData';

export interface AlcatrazModel {
  geo: THREE.BufferGeometry;
  /** Lighthouse lamp position (world). */
  lamp: [number, number, number];
}

const ROCK = new THREE.Color(0.075, 0.066, 0.058);
const ROCK_LIGHT = new THREE.Color(0.16, 0.145, 0.125);
const GUANO = new THREE.Color(0.36, 0.35, 0.33);
const SCRUB = new THREE.Color(0.04, 0.055, 0.028);
const SCRUB_DRY = new THREE.Color(0.12, 0.105, 0.065);
const DIRT = new THREE.Color(0.17, 0.15, 0.125);
const CONCRETE = new THREE.Color(0.3, 0.29, 0.27);
const WALL = new THREE.Color(0.46, 0.445, 0.41);
const WALL_WARM = new THREE.Color(0.5, 0.46, 0.39);
const RUIN = new THREE.Color(0.3, 0.26, 0.22);
const ROOF = new THREE.Color(0.26, 0.25, 0.24);

/** Top-surface height control points [lat, lon, metres] (benches and crest of the real island). */
const TOP: [number, number, number][] = [
  [37.82663, -122.42293, 41], // cellhouse crest
  [37.8263, -122.4224, 38], // administration block / lighthouse
  [37.82632, -122.42192, 33], // warden's house
  [37.8257, -122.4228, 26], // parade ground
  [37.8252, -122.4219, 16], // south tip
  [37.8277, -122.4232, 28], // officers' club
  [37.82757, -122.42393, 30], // water tower
  [37.8268, -122.4245, 22], // west slope
  [37.8275, -122.4247, 12], // new industries bench
  [37.828, -122.4254, 8], // model industries
  [37.8282, -122.4246, 6], // powerhouse
  [37.82723, -122.42234, 14], // sally port ramp
  [37.8267, -122.4217, 5], // Building 64
  [37.82665, -122.4209, 3], // dock
  [37.8271, -122.4214, 4], // north quay
];

/** Surface kinds for the material (attribute aKind). */
const KIND_GROUND = 0;
const KIND_BUILDING = 1;
const KIND_STRUCTURE = 2;

function paint(g: THREE.BufferGeometry, c: THREE.Color, kind = KIND_STRUCTURE): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  ng.computeVertexNormals();
  const n = ng.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
  ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  ng.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(n).fill(kind), 1));
  return ng;
}

/**
 * Material for the island: vertex colours plus per-pixel rock texture (noise + strata on the
 * cliffs) and window rows on the building walls — the island is often seen from a few hundred m.
 */
export function createAlcatrazMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aKind;\nvarying float vKind;\nvarying vec3 vAW;\nvarying vec3 vAN;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvKind = aKind;\nvAW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvAN = normalize( mat3( modelMatrix ) * objectNormal );',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying float vKind;
varying vec3 vAW;
varying vec3 vAN;
float aHash( vec3 p ) { p = fract( p * 0.1031 ); p += dot( p, p.zyx + 31.32 ); return fract( ( p.x + p.y ) * p.z ); }
float aNoise( vec3 p ) {
	vec3 i = floor( p ); vec3 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( mix( aHash( i ), aHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( aHash( i + vec3( 0, 1, 0 ) ), aHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
		mix( mix( aHash( i + vec3( 0, 0, 1 ) ), aHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( aHash( i + vec3( 0, 1, 1 ) ), aHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
float gAWin;`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
gAWin = 0.0;
{
	vec3 n = normalize( vAN );
	float fp = length( fwidth( vAW ) );
	if ( vKind < 0.5 ) {
		// Rock / ground: two noise octaves + horizontal strata on steep faces (faded when sub-pixel).
		float k = 1.0 - smoothstep( 0.6, 2.5, fp );
		float rn = aNoise( vAW * 0.45 ) * 0.6 + aNoise( vAW * 1.7 ) * 0.4;
		float steep = 1.0 - smoothstep( 0.35, 0.7, n.y );
		float strata = 0.5 + 0.5 * sin( vAW.y * 2.1 + aNoise( vAW * 0.25 ) * 6.0 );
		diffuseColor.rgb *= mix( 1.0, ( 0.7 + 0.6 * rn ) * mix( 1.0, 0.75 + 0.4 * strata, steep ), k );
	} else if ( vKind < 1.5 && abs( n.y ) < 0.3 ) {
		// Building walls: rows of tall windows (cellhouse / Building 64 style), filtered at range.
		vec2 t = normalize( vec2( - n.z, n.x ) );
		vec2 c = vec2( dot( vAW.xz, t ) / 3.0, vAW.y / 3.7 );
		vec2 f = fract( c );
		vec2 w = fwidth( c );
		float lod = smoothstep( 0.2, 0.5, max( w.x, w.y ) );
		float win = smoothstep( 0.28, 0.28 + w.x, f.x ) * smoothstep( 0.72, 0.72 - w.x, f.x ) * smoothstep( 0.25, 0.25 + w.y, f.y ) * smoothstep( 0.85, 0.85 - w.y, f.y );
		gAWin = mix( win, 0.17, lod );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.035, 0.038, 0.04 ), gAWin * 0.9 );
		// Weathering: streaks under the windows, darker toward the ground.
		diffuseColor.rgb *= 0.85 + 0.3 * aNoise( vec3( dot( vAW.xz, t ) * 0.8, vAW.y * 0.08, 0.0 ) );
	}
}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.25, gAWin );');
  };
  mat.customProgramCacheKey = () => 'argus-alcatraz-v1';
  return mat;
}

/** Signed distance to a closed polygon (negative inside). */
function signedDist(x: number, z: number, pts: [number, number][]): number {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j];
    const [bx, bz] = pts[i];
    if (bz > z !== az > z && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    const ex = ax + dx * t - x;
    const ez = az + dz * t - z;
    best = Math.min(best, ex * ex + ez * ez);
  }
  return inside ? -Math.sqrt(best) : Math.sqrt(best);
}

export function buildAlcatraz(): AlcatrazModel {
  const coast = COAST.map(([la, lo]) => project(la, lo));
  const top = TOP.map(([la, lo, h]) => {
    const [x, z] = project(la, lo);
    return { x, z, h };
  });
  const xs = coast.map((p) => p[0]);
  const zs = coast.map((p) => p[1]);
  const M = 30;
  const x0 = Math.min(...xs) - M;
  const x1 = Math.max(...xs) + M;
  const z0 = Math.min(...zs) - M;
  const z1 = Math.max(...zs) + M;
  // The east (dock) side is a low quay with a sea wall rather than a cliff.
  const [dockX] = project(37.82665, -122.4209);

  /** Smooth top surface: inverse-distance weighting of the control points, gently terraced. */
  const topAt = (x: number, z: number) => {
    let ws = 0;
    let hs = 0;
    for (const p of top) {
      const d2 = (x - p.x) ** 2 + (z - p.z) ** 2 + 400;
      const w = 1 / (d2 * d2);
      ws += w;
      hs += w * p.h;
    }
    const h = hs / ws;
    // Terraces (retaining walls, benches cut for the prison and the fort before it).
    const step = 5;
    const f = h / step - Math.floor(h / step);
    const terr = (Math.floor(h / step) + THREE.MathUtils.smoothstep(f, 0.7, 1)) * step;
    return THREE.MathUtils.lerp(h, terr, 0.55) + (fbm2(x / 18, z / 18, 2) - 0.5) * 1.6;
  };
  const heightAt = (x: number, z: number): { h: number; sd: number } => {
    const sd = signedDist(x, z, coast);
    if (sd >= 0) {
      // Rubble just off the cliffs, then the bay floor.
      const rubble = (1 - THREE.MathUtils.smoothstep(sd, 0, 6)) * (fbm2(x / 5, z / 5, 2) * 2.2 - 0.6);
      return { h: rubble - THREE.MathUtils.smoothstep(sd, 2, 26) * 12, sd };
    }
    const quay = THREE.MathUtils.smoothstep(x, dockX - 120, dockX - 40);
    // Buttresses and gullies along the cliff line: the cliff top wanders in and out by a few metres.
    const inland = -sd + (fbm2(x / 11 + 2.1, z / 11 - 4.3, 3) - 0.5) * 9 * (1 - quay);
    const cliffW = THREE.MathUtils.lerp(15, 3, quay);
    const t = THREE.MathUtils.smoothstep(inland, 0, cliffW);
    const h = topAt(x, z);
    // Cliff faces: steep, broken rock (ledges + noise); the quay drops ~2.5 m to the water.
    const ledges = (fbm2(x / 5, z / 5, 3) - 0.5) * 6 * t * (1 - t) * 4;
    const face = Math.pow(t, 0.6) * h + ledges * (1 - quay);
    return { h: Math.max(face, 0.6 + 1.8 * quay * t), sd };
  };

  // ── Island heightfield (2 m) ──
  const RES = 2;
  const nx = Math.ceil((x1 - x0) / RES) + 1;
  const nz = Math.ceil((z1 - z0) / RES) + 1;
  const pos = new Float32Array(nx * nz * 3);
  const col = new Float32Array(nx * nz * 3);
  const H = new Float32Array(nx * nz);
  const SD = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * RES;
      const z = z0 + j * RES;
      const s = heightAt(x, z);
      const k = j * nx + i;
      H[k] = s.h;
      SD[k] = s.sd;
      pos.set([x, s.h, z], k * 3);
    }
  }
  const tmp = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = x0 + i * RES;
      const z = z0 + j * RES;
      const hx = H[j * nx + Math.min(i + 1, nx - 1)] - H[j * nx + Math.max(i - 1, 0)];
      const hz = H[Math.min(j + 1, nz - 1) * nx + i] - H[Math.max(j - 1, 0) * nx + i];
      const slope = Math.hypot(hx, hz) / (2 * RES); // rise / run
      const n = fbm2(x / 9, z / 9, 3);
      const n2 = fbm2(x / 3.5 + 7, z / 3.5, 2);
      // Benches: bare dirt and rubble with patches of dark scrub / ice plant, concrete pads and paths.
      tmp.copy(DIRT).lerp(SCRUB_DRY, n2 * 0.6);
      tmp.lerp(SCRUB, THREE.MathUtils.smoothstep(n, 0.5, 0.62) * 0.85);
      if (n2 > 0.64) tmp.lerp(CONCRETE, 0.8);
      // Cliffs: rock, lighter weathered bands, white guano streaks running down the faces.
      const rockT = THREE.MathUtils.smoothstep(slope, 0.45, 0.95);
      const rock = tmp.clone().copy(ROCK).lerp(ROCK_LIGHT, n2);
      const streak = THREE.MathUtils.smoothstep(fbm2(x / 2.5, z / 2.5 + H[k] * 0.02, 2), 0.62, 0.75);
      rock.lerp(GUANO, streak * 0.6);
      tmp.lerp(rock, rockT);
      // Wet dark rock at the waterline; seabed below.
      if (H[k] < 1.5) tmp.copy(ROCK).multiplyScalar(H[k] < 0 ? 0.5 : 0.75);
      col.set([tmp.r, tmp.g, tmp.b], k * 3);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Skip quads entirely out in the bay (keeps the skirt small).
      if (SD[a] > 24 && SD[b] > 24 && SD[c] > 24 && SD[d] > 24) continue;
      idx.push(a, c, b, b, c, d); // counter-clockwise seen from +Y (z grows south)
    }
  }
  let island = new THREE.BufferGeometry();
  island.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  island.setAttribute('color', new THREE.BufferAttribute(col, 3));
  island.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(nx * nz).fill(KIND_GROUND), 1));
  island.setIndex(idx);
  island.computeVertexNormals(); // smooth (indexed) normals for the rock and benches
  island = island.toNonIndexed();

  const parts: THREE.BufferGeometry[] = [island];
  const groundAt = (x: number, z: number) => Math.max(heightAt(x, z).h, 0.5);

  // ── OSM buildings, extruded from their footprints ──
  for (const b of BUILDINGS) {
    const pts = b.pts.map(([la, lo]) => project(la, lo));
    const gs = pts.map(([x, z]) => groundAt(x, z));
    const base = Math.min(...gs) - 1.5;
    const topY = Math.max(...gs) + b.h;
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: topY - base, bevelEnabled: false });
    // Shape space (x, -z) extruded along +Z → rotate so the extrusion points up (+Y).
    g.rotateX(-Math.PI / 2);
    g.translate(0, base, 0);
    const wall = b.ruin ? RUIN : b.name === 'Building 64' || b.name === 'Quartermaster' ? WALL_WARM : WALL;
    const painted = paint(g, wall, b.ruin ? KIND_STRUCTURE : KIND_BUILDING);
    // Roofs a little darker (tar / weathered concrete).
    const p = painted.getAttribute('position') as THREE.BufferAttribute;
    const nrm = painted.getAttribute('normal') as THREE.BufferAttribute;
    const c = painted.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      if (nrm.getY(i) > 0.7 && !b.ruin) c.setXYZ(i, ROOF.r, ROOF.g, ROOF.b);
      else if (p.getY(i) < base + 2.2) c.setXYZ(i, c.getX(i) * 0.7, c.getY(i) * 0.7, c.getZ(i) * 0.7);
    }
    parts.push(painted);
  }

  // ── Lighthouse (26 m), water tower on stilts, powerhouse chimney, ferry dock ──
  const [lx, lz] = project(LIGHTHOUSE[0], LIGHTHOUSE[1]);
  const lgY = groundAt(lx, lz);
  const shaft = new THREE.CylinderGeometry(2.0, 2.9, 23, 8);
  shaft.translate(lx, lgY + 11.5, lz);
  parts.push(paint(shaft, new THREE.Color(0.72, 0.71, 0.66)));
  const gallery = new THREE.CylinderGeometry(3.0, 3.0, 0.8, 8);
  gallery.translate(lx, lgY + 23.4, lz);
  parts.push(paint(gallery, new THREE.Color(0.12, 0.12, 0.12)));
  const lantern = new THREE.CylinderGeometry(1.9, 1.9, 2.6, 8);
  lantern.translate(lx, lgY + 25.1, lz);
  parts.push(paint(lantern, new THREE.Color(0.25, 0.26, 0.24)));
  const capL = new THREE.ConeGeometry(2.2, 1.6, 8);
  capL.translate(lx, lgY + 27.2, lz);
  parts.push(paint(capL, new THREE.Color(0.1, 0.1, 0.1)));

  const [wx, wz] = project(WATER_TOWER[0], WATER_TOWER[1]);
  const wgY = groundAt(wx, wz);
  for (const [dx, dz] of [
    [-4.5, -4.5],
    [4.5, -4.5],
    [-4.5, 4.5],
    [4.5, 4.5],
  ]) {
    const leg = new THREE.CylinderGeometry(0.35, 0.45, 20, 4);
    leg.translate(wx + dx, wgY + 10, wz + dz);
    parts.push(paint(leg, new THREE.Color(0.3, 0.25, 0.2)));
  }
  const tank = new THREE.CylinderGeometry(6.2, 6.2, 8, 14);
  tank.translate(wx, wgY + 24, wz);
  parts.push(paint(tank, new THREE.Color(0.66, 0.63, 0.57)));
  const capT = new THREE.ConeGeometry(6.5, 2.5, 14);
  capT.translate(wx, wgY + 29.2, wz);
  parts.push(paint(capT, new THREE.Color(0.35, 0.3, 0.26)));

  const [sx, sz] = project(CHIMNEY[0], CHIMNEY[1]);
  const stack = new THREE.CylinderGeometry(1.4, 2.1, 30, 10);
  stack.translate(sx, groundAt(sx, sz) + 14, sz);
  parts.push(paint(stack, new THREE.Color(0.38, 0.27, 0.21)));

  // Ferry dock + pier (OSM ways 27999864 / 27609572) on piles at ~2.5 m.
  const [d0x, d0z] = project(37.82674, -122.42102);
  const [d1x, d1z] = project(37.82652, -122.42072);
  const dock = new THREE.BoxGeometry(Math.abs(d1x - d0x), 1.2, Math.abs(d1z - d0z));
  dock.translate((d0x + d1x) / 2, 2.2, (d0z + d1z) / 2);
  parts.push(paint(dock, new THREE.Color(0.3, 0.28, 0.25)));
  const [p0x, p0z] = project(37.82703, -122.42169);
  const [p1x, p1z] = project(37.8272, -122.42141);
  const pier = new THREE.BoxGeometry(Math.hypot(p1x - p0x, p1z - p0z) + 4, 1.0, 9);
  pier.rotateY(-Math.atan2(p1z - p0z, p1x - p0x));
  pier.translate((p0x + p1x) / 2, 2.0, (p0z + p1z) / 2);
  parts.push(paint(pier, new THREE.Color(0.28, 0.26, 0.23)));

  const geo = mergeGeometries(parts, false)!;
  geo.computeBoundingSphere();
  return { geo, lamp: [lx, lgY + 25.1, lz] };
}
