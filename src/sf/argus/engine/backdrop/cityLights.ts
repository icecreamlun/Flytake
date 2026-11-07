/**
 * Distant street lamps as points. From the air at night a far city is a field of sparkling
 * sodium / LED points, not a smooth glow — shader emissive alone smears into a beige haze once the
 * street grid is sub-pixel. One THREE.Points draw (a few ten-thousand 2 px points), scattered on a
 * jittered grid with neighbourhood-scale density, only where GeoSample.lights says people live and
 * outside the real-data area (the streets module lights that). Hidden by day.
 */
import * as THREE from 'three';
import { fbm2, sampleGeo, type GeoSample } from './geography';
import { farBlend, farHeight, type Rect } from './farTerrain';

export interface CityLights {
  points: THREE.Points;
  setNight(night: number, exposure: number): void;
}

/** World region that can hold lights (m): SF to Daly City, Marin towns, East Bay to the hills. */
const AREA: Rect = { minX: -12000, minZ: -19000, maxX: 21000, maxZ: 15000 };
const COARSE = 500;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    s ^= s + Math.imul(s ^ (s >>> 7), 61 | s);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildCityLights(rect: Rect, dataRect: Rect, ground: (x: number, z: number) => number): CityLights {
  const geo: GeoSample = { h: 0, urban: 0, coast: 0 };
  const inGrid = (x: number, z: number) => x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
  const margin = 60;
  const inData = (x: number, z: number) =>
    x > dataRect.minX - margin && x < dataRect.maxX + margin && z > dataRect.minZ - margin && z < dataRect.maxZ + margin;
  /** Light density + ground height at x,z. */
  const sample = (x: number, z: number): { lights: number; h: number } => {
    if (inGrid(x, z)) {
      sampleGeo(x, z, geo);
      return { lights: geo.lights ?? 0, h: ground(x, z) };
    }
    const h = farHeight(rect, ground, x, z, geo, farBlend(rect, x, z), 150);
    return { lights: geo.lights ?? 0, h };
  };

  // Coarse occupancy pass: skip open water and wild land quickly.
  const cw = Math.ceil((AREA.maxX - AREA.minX) / COARSE);
  const ch = Math.ceil((AREA.maxZ - AREA.minZ) / COARSE);
  const coarse = new Float32Array((cw + 1) * (ch + 1));
  for (let j = 0; j <= ch; j++) {
    for (let i = 0; i <= cw; i++) {
      sampleGeo(AREA.minX + i * COARSE, AREA.minZ + j * COARSE, geo, COARSE);
      coarse[j * (cw + 1) + i] = geo.lights ?? 0;
    }
  }
  const coarseAny = (x: number, z: number) => {
    const i = Math.floor((x - AREA.minX) / COARSE);
    const j = Math.floor((z - AREA.minZ) / COARSE);
    if (i < 0 || j < 0 || i >= cw || j >= ch) return false;
    const k = j * (cw + 1) + i;
    return coarse[k] + coarse[k + 1] + coarse[k + cw + 1] + coarse[k + cw + 2] > 0.05;
  };

  const pos: number[] = [];
  const col: number[] = [];
  const rand = rng(4242);
  const sodium = new THREE.Color(1.0, 0.5, 0.17);
  const led = new THREE.Color(0.95, 0.88, 0.75);
  const c = new THREE.Color();
  // Jittered-grid scatter, density = lights × neighbourhood noise. A regular lattice of lamps
  // reads as converging "laser lines" at grazing angles; a jittered field reads as a city.
  const tiers = [
    { r0: 0, r1: 6000, cell: 75 },
    { r0: 6000, r1: 12000, cell: 110 },
    { r0: 12000, r1: 40000, cell: 160 },
  ];
  for (const t of tiers) {
    for (let z = AREA.minZ; z < AREA.maxZ; z += t.cell) {
      for (let x = AREA.minX; x < AREA.maxX; x += t.cell) {
        const px = x + (rand() - 0.5) * 0.9 * t.cell;
        const pz = z + (rand() - 0.5) * 0.9 * t.cell;
        const r = Math.hypot(px, pz);
        if (r < t.r0 || r >= t.r1) continue;
        if (inData(px, pz) || !coarseAny(px, pz)) continue;
        const hood = 0.25 + 1.2 * fbm2(px / 900 + 3.3, pz / 900 - 1.7, 2) * fbm2(px / 300, pz / 300, 2) * 2;
        const pick = rand();
        if (pick > 0.8 * hood) continue; // cheap reject before the costly sample
        const s = sample(px, pz);
        if (s.lights < 0.1 || pick > 0.8 * hood * s.lights || s.h < 1) continue;
        pos.push(px, s.h + 7, pz);
        c.copy(rand() < 0.62 ? sodium : led).multiplyScalar(0.45 + rand() * rand() * 1.6);
        col.push(c.r, c.g, c.b);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  const mat = new THREE.PointsMaterial({
    size: 2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  const points = new THREE.Points(g, mat);
  points.name = 'cityLights';
  points.frustumCulled = false;
  points.visible = false;
  points.matrixAutoUpdate = false;
  return {
    points,
    setNight(night, exposure) {
      const on = THREE.MathUtils.smoothstep(night, 0.35, 0.8);
      points.visible = on > 0.01;
      mat.color.setScalar((2.4 * on) / Math.max(exposure, 1e-3));
    },
  };
}
