/**
 * Filler city: the real building data only covers the context bbox, so the rest of San Francisco
 * (Nob / Russian Hill, North Beach, SoMa, Mission Bay …) within a few km would otherwise be empty
 * ground. We line procedural city blocks (SF block sizes, the grid north of Market axis-aligned,
 * the SoMa grid rotated 45°) with instanced row-buildings: pastel stucco palette, height by area,
 * a shader-made window grid (darker glazing by day, randomly lit windows at night).
 * One InstancedMesh draw call.
 */
import * as THREE from 'three';
import { farHeight, farBlend, type Rect } from './farTerrain';
import type { GeoSample } from './geography';

export interface FillerCity {
  mesh: THREE.InstancedMesh;
  /** lights: emissive scale (night / exposure); night: 0..1 night factor (darkens the albedo). */
  setNight(lights: number, night?: number): void;
}

const PALETTE = ['#e9e4d8', '#ded6c4', '#d4cdbf', '#ece6d6', '#c9c3b8', '#d8cdb5', '#bfc4c4', '#e3d9c0', '#b9a58c', '#a2675a', '#cfc8ae', '#f0ece2'].map((c) =>
  new THREE.Color(c),
);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    s ^= s + Math.imul(s ^ (s >>> 7), 61 | s);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_INSTANCES = 36000;
const REACH = 3200; // metres beyond the grid edge (density thins out with distance)

export function buildFillerCity(rect: Rect, dataRect: Rect, ground: (x: number, z: number) => number): FillerCity {
  const geo: GeoSample = { h: 0, urban: 0, coast: 0 };
  const heightAt = (x: number, z: number) => {
    const inGrid = x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
    if (inGrid) return { h: ground(x, z), urban: 1 };
    const w = farBlend(rect, x, z);
    const h = farHeight(rect, ground, x, z, geo, w);
    return { h, urban: w > 0 ? geo.urban : 1 };
  };
  const margin = 40;
  const inData = (x: number, z: number) =>
    x > dataRect.minX - margin && x < dataRect.maxX + margin && z > dataRect.minZ - margin && z < dataRect.maxZ + margin;
  const outer: Rect = { minX: rect.minX - REACH, minZ: rect.minZ - REACH, maxX: rect.maxX + REACH, maxZ: rect.maxZ + REACH };

  const mats: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const seeds: number[] = [];
  const rand = rng(1906);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  // Two block lattices: axis-aligned (north of Market) and 45° (south of Market).
  const lattices = [
    { angle: 0, bw: 125, bd: 84, keep: (x: number, z: number) => z - x * 0.75 - 200 < 0 },
    { angle: Math.PI / 4, bw: 160, bd: 110, keep: (x: number, z: number) => z - x * 0.75 - 200 >= 0 },
  ];
  const street = 18;

  for (const L of lattices) {
    const ca = Math.cos(L.angle);
    const sa = Math.sin(L.angle);
    const toWorld = (u: number, v: number): [number, number] => [u * ca - v * sa, u * sa + v * ca];
    // Lattice-space bounds that cover the outer rect.
    const R = Math.max(Math.abs(outer.minX), Math.abs(outer.maxX), Math.abs(outer.minZ), Math.abs(outer.maxZ)) * 1.5;
    for (let bu = Math.floor(-R / L.bw); bu < R / L.bw; bu++) {
      for (let bv = Math.floor(-R / L.bd); bv < R / L.bd; bv++) {
        const cu = (bu + 0.5) * L.bw;
        const cv = (bv + 0.5) * L.bd;
        const [cx, cz] = toWorld(cu, cv);
        if (cx < outer.minX || cx > outer.maxX || cz < outer.minZ || cz > outer.maxZ) continue;
        if (!L.keep(cx, cz)) continue;
        if (inData(cx, cz)) continue;
        // Yerba Buena Island: wooded, keep it natural.
        if (Math.hypot(cx - 2950, cz + 1900) < 750) continue;
        const c = heightAt(cx, cz);
        if (c.h < 2 || c.urban < 0.45) continue;
        // Thin out with distance beyond the grid so the edge of the 3-D city is never a hard line.
        const ox = Math.max(rect.minX - cx, 0, cx - rect.maxX);
        const oz = Math.max(rect.minZ - cz, 0, cz - rect.maxZ);
        const beyond = Math.hypot(ox, oz);
        if (beyond > 0 && rand() < Math.pow(beyond / REACH, 1.5)) continue;
        // Skip steep blocks (cliffs) and blocks reaching into the bay.
        const hs = [heightAt(cx - L.bw / 2, cz), heightAt(cx + L.bw / 2, cz), heightAt(cx, cz - L.bd / 2), heightAt(cx, cz + L.bd / 2)];
        if (hs.some((s) => s.h < 1.5)) continue;
        const slope = Math.max(...hs.map((s) => s.h)) - Math.min(...hs.map((s) => s.h));
        if (slope > 32) continue;
        // Piers (the DEM flattens them to deck level) and narrow moles: water on several sides → no
        // city block there (real piers carry low sheds, which the streets / landmarks modules build).
        let wet = 0;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          if (heightAt(cx + Math.cos(a) * 95, cz + Math.sin(a) * 95).h < 0.5) wet++;
        }
        if (wet >= 4) continue;
        const area = areaProfile(cx, cz);
        // Line the block perimeter with row buildings.
        const iw = L.bw - street;
        const id = L.bd - street;
        const sides: [number, number, number, number, number][] = [
          // start u, start v, dir u, dir v, length
          [cu - iw / 2, cv - id / 2, 1, 0, iw],
          [cu + iw / 2, cv - id / 2, 0, 1, id],
          [cu + iw / 2, cv + id / 2, -1, 0, iw],
          [cu - iw / 2, cv + id / 2, 0, -1, id],
        ];
        for (const [su, sv, du, dv, len] of sides) {
          let s = 0;
          while (s < len - 6) {
            const w = Math.min(len - s, 9 + rand() * (area.wide ? 26 : 14));
            const depth = Math.min(area.wide ? 22 + rand() * 18 : 16 + rand() * 10, (du !== 0 ? id : iw) / 2);
            // Centre: along the edge, pushed inward by depth/2.
            const nu = -dv;
            const nv = du;
            const mu = su + du * (s + w / 2) + nu * (depth / 2);
            const mv = sv + dv * (s + w / 2) + nv * (depth / 2);
            const [x, z] = toWorld(mu, mv);
            s += w;
            if (inData(x, z)) continue;
            if (rand() < 0.06) continue; // gaps / lots
            let h = area.base + rand() * area.var;
            if (rand() < area.towerP) h = area.towerMin + rand() * area.towerVar;
            const ga = heightAt(x - 6, z - 6).h;
            const gb = heightAt(x + 6, z + 6).h;
            const gc = heightAt(x, z).h;
            const g0 = Math.min(ga, gb, gc);
            const g1 = Math.max(ga, gb, gc);
            const base = g0 - 2;
            const top = g1 + h;
            const yaw = L.angle + (du !== 0 ? 0 : Math.PI / 2);
            q.setFromAxisAngle(up, -yaw);
            m.compose(new THREE.Vector3(x, (base + top) / 2, z), q, new THREE.Vector3(w - 0.6, top - base, depth));
            mats.push(m.clone());
            const col = PALETTE[Math.floor(rand() * PALETTE.length)].clone();
            col.multiplyScalar(0.8 + rand() * 0.25);
            cols.push(col);
            seeds.push(rand());
            if (mats.length >= MAX_INSTANCES) break;
          }
          if (mats.length >= MAX_INSTANCES) break;
        }
        if (mats.length >= MAX_INSTANCES) break;
      }
      if (mats.length >= MAX_INSTANCES) break;
    }
  }

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(seeds), 1);
  boxGeo.setAttribute('aSeed', seedAttr);
  const nightU = { value: 0 };
  const nightF = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNightLights = nightU;
    shader.uniforms.uNightF = nightF;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aSeed;\nvarying float vSeed;\nvarying vec3 vFW;\nvarying vec3 vFN;\nvarying float vFH;\nvarying float vFTall;\nvarying float vFFront;',
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vSeed = aSeed;
vec4 fw = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
vFW = fw.xyz;
vFN = normalize( mat3( modelMatrix * instanceMatrix ) * objectNormal );
vFH = ( position.y + 0.5 ) * length( instanceMatrix[ 1 ].xyz );
vFTall = length( instanceMatrix[ 1 ].xyz );
vFFront = abs( objectNormal.z );`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vSeed;
varying vec3 vFW;
varying vec3 vFN;
varying float vFH;
varying float vFTall;
varying float vFFront;
uniform float uNightLights;
uniform float uNightF;
float fHash( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float gWin; float gLit;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
	gWin = 0.0; gLit = 0.0;
	if ( abs( vFN.y ) < 0.5 ) {
		// Per-building facade character from the seed: storey height, window proportions,
		// ribbon vs punched windows; row houses keep party walls (narrow sides) blank.
		float s1 = fract( vSeed * 7.31 );
		float s2 = fract( vSeed * 3.77 );
		float s3 = fract( vSeed * 11.13 );
		vec3 t = normalize( vec3( - vFN.z, 0.0, vFN.x ) );
		float u = dot( vFW, t );
		float floorH = 3.0 + s1 * 0.9;
		float bay = 2.6 + s2 * 1.6;
		vec2 c = vec2( u / bay, vFH / floorH );
		vec2 f = fract( c );
		vec2 fw = fwidth( c );
		float lod = smoothstep( 0.25, 0.6, max( fw.x, fw.y ) );
		float m = 0.12 + 0.16 * s3;
		float wx = s3 > 0.82 ? 1.0 : smoothstep( m, m + fw.x, f.x ) * smoothstep( 1.0 - m, 1.0 - m - fw.x, f.x );
		float wy = smoothstep( 0.28, 0.28 + fw.y, f.y ) * smoothstep( 0.86, 0.86 - fw.y, f.y );
		float facade = max( step( 0.5, vFFront ), step( 24.0, vFTall ) );   // windows on this side?
		float topBand = step( vFTall - 0.9, vFH );                          // cornice / parapet
		float groundFloor = step( 1.0, c.y );
		float avgWin = ( s3 > 0.82 ? 1.0 : 1.0 - 2.0 * m ) * 0.58;
		gWin = mix( wx * wy, avgWin, lod ) * groundFloor * facade * ( 1.0 - topBand );
		float h = fHash( floor( c ) + vSeed * 91.0 );
		// Far LOD: windows are sub-pixel, so lit windows average into a uniform facade glow. At full strength that
		// read as pale glowing boxes, ~3x brighter than the data-area buildings at night (visible step at the data
		// boundary); 0.1 keeps a speckle-level average that matches them. (Integration fix.)
		// ~15% of windows lit, clustered per building (some buildings mostly dark).
		float occ = 0.06 + 0.2 * fract( vSeed * 5.3 );
		gLit = mix( step( h, occ ) * wx * wy, 0.07 * avgWin, lod ) * groundFloor * facade * ( 1.0 - topBand );
		vec3 glass = vec3( 0.06, 0.075, 0.09 ) + diffuseColor.rgb * 0.12;
		diffuseColor.rgb = mix( diffuseColor.rgb, glass, gWin * 0.9 );
		diffuseColor.rgb *= 1.0 - topBand * 0.25;
		// Ground floor a bit darker (shopfronts / garages); faint grime toward the base.
		diffuseColor.rgb *= mix( 0.7, 1.0, smoothstep( 0.0, floorH, vFH ) );
	} else {
		diffuseColor.rgb *= 0.78; // roofs: tar / gravel
	}
	// Pale stucco under moonlight + night adaptation read as "sunlit"; at night the backdrop city
	// should be a dark mass carried by its lit windows (matches the data-area buildings).
	diffuseColor.rgb *= mix( 1.0, 0.4, uNightF );
}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.12, gWin * 0.85 );')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += mix( vec3( 1.0, 0.66, 0.36 ), vec3( 0.8, 0.85, 1.0 ), step( 0.75, fract( vSeed * 13.0 ) ) ) * gLit * uNightLights * 0.8;',
      );
  };
  mat.customProgramCacheKey = () => 'argus-filler-v3';

  const mesh = new THREE.InstancedMesh(boxGeo, mat, Math.max(1, mats.length));
  mesh.name = 'fillerCity';
  for (let i = 0; i < mats.length; i++) {
    mesh.setMatrixAt(i, mats[i]);
    mesh.setColorAt(i, cols[i]);
  }
  mesh.count = mats.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return {
    mesh,
    setNight: (lights, night = 0) => {
      nightU.value = lights;
      nightF.value = night;
    },
  };
}

/** Height character by neighbourhood (rough SF zoning). */
function areaProfile(x: number, z: number) {
  // SoMa / Mission Bay (south-east): bigger footprints, mid-rise, occasional towers.
  if (z > 1000 && x > -1800)
    return { base: 14, var: 26, towerP: x > -600 && z < 2200 ? 0.07 : 0.03, towerMin: 50, towerVar: 70, wide: true };
  // Nob Hill / Russian Hill / Pacific Heights (west): 4–8 storey apartments, some high-rises.
  if (x < -1500) return { base: 11, var: 16, towerP: 0.035, towerMin: 35, towerVar: 45, wide: false };
  // North Beach / waterfront.
  return { base: 9, var: 11, towerP: 0.01, towerMin: 25, towerVar: 20, wide: false };
}
