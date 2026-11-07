/**
 * Far ground ring: everything outside the terrain grid out to ~45 km (rest of SF, Marin, the East
 * Bay hills, Angel / Treasure Island, Mt Diablo). Built as concentric rectangles around the grid
 * with geometric spacing, stitched with zipper triangulation. The two innermost rings (one cell
 * inside the grid, and exactly on its edge) sit on the grid's own 4 m lattice 0.35 m below the
 * terrain, so there is never a crack or a z-fight at the seam; outward the ground blends into the
 * procedural geography (geography.ts) over ~700 m.
 */
import * as THREE from 'three';
import { sampleGeo, fbm2, type GeoSample } from './geography';
import { CITY_GLSL, TERRAIN_DETAIL_GLSL } from './cityShading';

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

const OUTER = 46000;

/** Loop of points along a rectangle offset by d, starting at the NW corner, clockwise (seen from +Y). */
function ringPoints(r: Rect, d: number, spacing: number): { pts: [number, number][]; corners: number[] } {
  const x0 = r.minX - d;
  const x1 = r.maxX + d;
  const z0 = r.minZ - d;
  const z1 = r.maxZ + d;
  const sides: [number, number, number, number][] = [
    [x0, z0, x1, z0], // north edge, west → east
    [x1, z0, x1, z1], // east edge, north → south
    [x1, z1, x0, z1], // south edge, east → west
    [x0, z1, x0, z0], // west edge, south → north
  ];
  const pts: [number, number][] = [];
  const corners: number[] = [];
  for (const [ax, az, bx, bz] of sides) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / spacing));
    corners.push(pts.length);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      pts.push([ax + (bx - ax) * t, az + (bz - az) * t]);
    }
  }
  corners.push(pts.length); // sentinel = loop length
  return { pts, corners };
}

/** 0 at the grid edge → 1 at 700 m outside: how much procedural geography replaces the edge height. */
export function farBlend(rect: Rect, x: number, z: number): number {
  const ox = Math.max(rect.minX - x, 0, x - rect.maxX);
  const oz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
  return smooth(0, 700, Math.hypot(ox, oz));
}

/** Ground height of the far ring at x,z (also used to seat filler buildings outside the grid). */
export function farHeight(
  rect: Rect,
  ground: (x: number, z: number) => number,
  x: number,
  z: number,
  geo: GeoSample,
  w = farBlend(rect, x, z),
  spacing = 0,
): number {
  const edgeH = ground(x, z) - 0.35;
  if (w <= 0) {
    geo.urban = 0;
    geo.lights = 0;
    return edgeH;
  }
  sampleGeo(x, z, geo, spacing);
  let h = edgeH * (1 - w) + geo.h * w;
  // Under water keep the floor well below sea level so the bay plane never z-fights it.
  if ((w > 0.5 && geo.h < 0) || h < 0) h = Math.min(h, -2.5);
  return h;
}

export interface FarTerrain {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  setNight(v: number): void;
}

export function buildFarTerrain(rect: Rect, ground: (x: number, z: number) => number): FarTerrain {
  // Ring offsets and spacings.
  // Two seam rings on the grid's own 4 m lattice (one cell inside, and exactly on the edge).
  const rings: { d: number; s: number }[] = [
    { d: -4, s: 4 },
    { d: 0, s: 4 },
  ];
  // Spacing grows ~linearly with distance from the grid edge: ~30 m near the seam, ~90 m at
  // Marin (5 km), ~0.7 km at Mt Diablo (40 km). Relief finer than ~4 spacings is band-limited away
  // in sampleGeo — sampling it anyway is what made the ridgelines stair-stepped; the shader adds
  // that detail back as a per-pixel normal.
  const spacing = (d: number) => THREE.MathUtils.clamp(12 + d * 0.017, 16, 2400);
  let d = 24;
  rings.push({ d, s: 16 });
  while (d < OUTER) {
    const g = spacing(d);
    d += g;
    rings.push({ d, s: g * 1.05 });
  }
  // The innermost ring must use the grid's 4 m lattice (exact bilinear match along the seam).
  const positions: number[] = [];
  const land: number[] = [];
  const index: number[] = [];
  const geo: GeoSample = { h: 0, urban: 0, coast: 0 };
  const loops: { start: number; corners: number[] }[] = [];

  for (let k = 0; k < rings.length; k++) {
    const { d: off, s } = rings[k];
    const lp = ringPoints(rect, off, s);
    const start = positions.length / 3;
    for (const [x, z] of lp.pts) {
      const w = k <= 1 ? 0 : farBlend(rect, x, z);
      const h = farHeight(rect, ground, x, z, geo, w, s);
      positions.push(x, h, z);
      const veg = fbm2(x / 900, z / 900, 3);
      // Sand only on a thin fringe along the coast.
      const sand = w > 0 ? THREE.MathUtils.smoothstep(-geo.coast, 70, 0) * w : 0;
      // x urban (ground texture), y vegetation (>1: forest/park cover), z sand, w night-light density.
      land.push(w > 0 ? geo.urban * w : 0, w > 0 && geo.forest ? 1 + geo.forest : veg, sand, w > 0 ? (geo.lights ?? 0) * w : 0);
    }
    loops.push({ start, corners: lp.corners });
  }

  // Zipper-stitch consecutive loops side by side (corners align).
  for (let k = 0; k < loops.length - 1; k++) {
    const a = loops[k];
    const b = loops[k + 1];
    const na = a.corners[4];
    const nb = b.corners[4];
    for (let side = 0; side < 4; side++) {
      const a0 = a.corners[side];
      const a1 = side === 3 ? na : a.corners[side + 1];
      const b0 = b.corners[side];
      const b1 = side === 3 ? nb : b.corners[side + 1];
      const ca = a1 - a0; // segment counts on this side
      const cb = b1 - b0;
      let i = 0;
      let j = 0;
      const ia = (q: number) => a.start + ((a0 + q) % na);
      const ib = (q: number) => b.start + ((b0 + q) % nb);
      while (i < ca || j < cb) {
        const ta = (i + 1) / ca;
        const tb = (j + 1) / cb;
        if (j >= cb || (i < ca && ta <= tb)) {
          index.push(ia(i), ib(j), ia(i + 1));
          i++;
        } else {
          index.push(ia(i), ib(j), ib(j + 1));
          j++;
        }
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('aLand', new THREE.Float32BufferAttribute(land, 4));
  g.setIndex(index);
  g.computeVertexNormals();
  // Ensure upward-facing winding (flip if the zipper produced clockwise triangles).
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  let up = 0;
  for (let i = 0; i < nrm.count; i++) up += nrm.getY(i);
  if (up < 0) {
    const idx = g.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
      const t = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, t);
    }
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();

  const nightU = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 1;
  mat.polygonOffsetUnits = 2;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNightLights = nightU;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aLand;\nvarying vec4 vLand;\nvarying vec3 vFarWorld;\nvarying vec3 vFarN;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvLand = aLand;\nvFarWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvFarN = normalize( mat3( modelMatrix ) * objectNormal );',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec4 vLand;\nvarying vec3 vFarWorld;\nvarying vec3 vFarN;\nuniform float uNightLights;\n${CITY_GLSL}\n${TERRAIN_DETAIL_GLSL}\nCityLook gLook;\nvec3 gFarN;`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
	// Per-pixel relief the coarse far mesh can't carry: gullies and spurs as a detail normal.
	float fp = length( fwidth( vFarWorld.xz ) );
	vec3 base = normalize( vFarN );
	float wild = 1.0 - clamp( vLand.x, 0.0, 1.0 );
	float relief = smoothstep( 4.0, 60.0, vFarWorld.y ) * wild;
	vec3 dd = terrainDetail( vFarWorld.xz, fp );            // x: ravine-ness 0..1, yz: height gradient
	gFarN = normalize( base + vec3( - dd.y, 0.0, - dd.z ) * relief * base.y );
	// October California: golden dry grass on sunny (south/west-facing) slopes, dark oak woodland
	// and chaparral on north-facing slopes and in ravines; rock on the steeps.
	float n = cNoise( vFarWorld.xz / 140.0 ) * 0.6 + cNoise( vFarWorld.xz / 37.0 ) * 0.4;
	vec3 grass = mix( vec3( 0.25, 0.175, 0.085 ), vec3( 0.17, 0.13, 0.075 ), n );
	grass = mix( grass, vec3( 0.13, 0.12, 0.07 ), cNoise( vFarWorld.xz / 610.0 ) * 0.5 );   // greener swales
	vec3 oak = mix( vec3( 0.03, 0.045, 0.025 ), vec3( 0.06, 0.07, 0.038 ), n );
	vec3 chap = vec3( 0.075, 0.075, 0.045 );                                                  // grey-green scrub
	float north = - gFarN.z;                    // world north is -Z
	float west = - gFarN.x;
	float slope = 1.0 - gFarN.y;
	float forest = max( vLand.y - 1.0, 0.0 );   // parks / Angel Island woods (attribute > 1)
	float patches = cNoise( vFarWorld.xz / 420.0 ) * 0.55 + n * 0.45;
	// Chaparral / oak: on north-facing slopes, down every ravine and in large patches on the sunny side.
	float chapPatch = smoothstep( 0.55, 0.75, cNoise( vFarWorld.xz / 1300.0 + 4.0 ) );
	float woods = smoothstep( 0.42, 0.6, patches + north * 0.6 - west * 0.12 + dd.x * 0.75 + chapPatch * 0.35 + forest * 0.7
		+ ( min( vLand.y, 1.0 ) - 0.5 ) * 0.25 - 0.22 );
	vec3 veg = mix( grass, mix( chap, oak, smoothstep( 0.3, 0.7, dd.x + n * 0.3 ) ), woods );
	veg = mix( veg, vec3( 0.15, 0.135, 0.115 ), smoothstep( 0.38, 0.7, slope ) * 0.65 ); // rocky steeps
	// Night lights only where people live AND the ground is flat enough to build on (< ~12-18°).
	float lights = clamp( vLand.w, 0.0, 1.0 ) * smoothstep( 0.95, 0.978, base.y );
	gLook = cityLook( vFarWorld.xz, clamp( vLand.x, 0.0, 1.0 ), lights, uNightLights, veg );
	diffuseColor.rgb = gLook.albedo;
	// Beaches / rocky shore fringe.
	diffuseColor.rgb = mix( diffuseColor.rgb, mix( vec3( 0.33, 0.3, 0.25 ), vec3( 0.17, 0.155, 0.14 ), step( 0.5, n ) ), vLand.z * ( 1.0 - smoothstep( 2.0, 9.0, vFarWorld.y ) ) );
}`,
      )
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize( ( viewMatrix * vec4( gFarN, 0.0 ) ).xyz );')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gLook.rough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gLook.emissive;');
  };
  mat.customProgramCacheKey = () => 'argus-far-terrain-v4';

  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'farTerrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return { mesh, material: mat, setNight: (v) => (nightU.value = v) };
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
