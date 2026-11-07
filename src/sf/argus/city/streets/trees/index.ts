/**
 * City trees: 7.7k real trees (DataSF street-tree list + OSM) as instanced procedural archetypes with
 * per-frame CPU LOD + frustum culling:
 *   LOD0 (< ~150 m, palms < 260 m): full card crowns, limbs, wind; cast shadows
 *   LOD1 (< ~560 m): few big cards; cast shadows
 *   LOD2 (beyond):   one shared smooth blob per crown
 * Tree wells (dark soil squares aligned to the street) are emitted as ground decals.
 */
import * as THREE from 'three';
import type { CityData, TreeRecord } from '../../../contracts';
import type { GroundSurface } from '../core/surface';
import { pointInRing } from '../core/contour';
import type { SegIndex } from '../core/segindex';
import { hash01 } from '../core/zone';
import type { StripBuilder } from '../markings/strips';
import { Style } from '../markings/material';
import { buildAtlas } from './atlas';
import { buildArchetypes, buildBlob } from './geometry';
import { createFoliageMaterials } from './material';
import { ARCH_COUNT, Arch, specFor } from './species';

const L0 = 150;
const L0_PALM = 260;
const L1 = 560;
const FAR = 3200;

export class TreeSystem {
  readonly object = new THREE.Group();
  readonly count: number;
  private x: Float32Array;
  private y: Float32Array;
  private z: Float32Array;
  private arch: Uint8Array;
  private cy: Float32Array;
  private rad: Float32Array;
  private m01: Float32Array;
  private m2: Float32Array;
  private tint: Float32Array;
  private meshes: THREE.InstancedMesh[][] = [];
  private blob: THREE.InstancedMesh;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private uni: ReturnType<typeof createFoliageMaterials>['uniforms'][] = [];
  private sun: THREE.DirectionalLight | null = null;

  constructor(city: CityData, surface: GroundSurface, extra: TreeRecord[] = []) {
    this.object.name = 'trees';
    const named = (n: string) => city.areas.filter((a) => a.name === n).map((a) => a.polygon.flat());
    const grove = named('Transamerica Redwood Park');
    const pioneer = named('Pioneer Park');
    const inAny = (rings: number[][], x: number, z: number) => rings.some((r) => pointInRing(r, x, z));

    const archs = buildArchetypes();
    const recs: { x: number; y: number; z: number; spec: NonNullable<ReturnType<typeof specFor>>; rot: number }[] = [];
    [...city.trees, ...extra].forEach((t, i) => {
      const spec = specFor(t, inAny(grove, t.x, t.z), inAny(pioneer, t.x, t.z), i);
      if (!spec) return;
      recs.push({ x: t.x, y: surface.top(t.x, t.z), z: t.z, spec, rot: hash01(i, 5) * Math.PI * 2 });
    });
    const N = (this.count = recs.length);
    this.x = new Float32Array(N);
    this.y = new Float32Array(N);
    this.z = new Float32Array(N);
    this.arch = new Uint8Array(N);
    this.cy = new Float32Array(N);
    this.rad = new Float32Array(N);
    this.m01 = new Float32Array(N * 16);
    this.m2 = new Float32Array(N * 16);
    this.tint = new Float32Array(N * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const counts = new Array(ARCH_COUNT).fill(0);
    recs.forEach((r, i) => {
      const a = archs[r.spec.arch];
      const sy = r.spec.h / a.refH;
      const sxz = sy * THREE.MathUtils.clamp(r.spec.w / r.spec.h / (a.refW / a.refH), 0.75, 1.3);
      q.setFromAxisAngle(up, r.rot);
      m.compose(new THREE.Vector3(r.x, r.y, r.z), q, new THREE.Vector3(sxz, sy, sxz));
      m.toArray(this.m01, i * 16);
      const crownY = a.crownY * sy;
      m.compose(new THREE.Vector3(r.x, r.y + crownY, r.z), q, new THREE.Vector3(a.crownR[0] * sxz, a.crownR[1] * sy, a.crownR[0] * sxz));
      m.toArray(this.m2, i * 16);
      this.x[i] = r.x;
      this.y[i] = r.y;
      this.z[i] = r.z;
      this.arch[i] = r.spec.arch;
      this.cy[i] = crownY;
      this.rad[i] = Math.max(r.spec.h * 0.6, r.spec.w * 0.6);
      this.tint.set(r.spec.tint, i * 3);
      counts[r.spec.arch]++;
    });

    const atlas = buildAtlas();
    const cards = createFoliageMaterials(atlas);
    const far = createFoliageMaterials(atlas, true);
    this.uni.push(cards.uniforms, far.uniforms);
    for (let k = 0; k < ARCH_COUNT; k++) {
      const row: THREE.InstancedMesh[] = [];
      for (let lod = 0; lod < 2; lod++) {
        const im = new THREE.InstancedMesh(archs[k].lod[lod], cards.material, Math.max(1, counts[k]));
        im.customDepthMaterial = cards.depth;
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        im.count = 0;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, counts[k]) * 3), 3);
        im.instanceColor.setUsage(THREE.DynamicDrawUsage);
        im.name = `trees-a${k}-lod${lod}`;
        this.object.add(im);
        row.push(im);
      }
      this.meshes.push(row);
    }
    this.blob = new THREE.InstancedMesh(buildBlob(), far.material, Math.max(1, N));
    this.blob.castShadow = false;
    this.blob.receiveShadow = true;
    this.blob.frustumCulled = false;
    this.blob.count = 0;
    this.blob.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blob.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.blob.name = 'trees-far';
    this.object.add(this.blob);
  }

  /** Dark soil wells around sidewalk trees (decals on the ground). */
  addTreeWells(sb: StripBuilder, surface: GroundSurface, segs: SegIndex): void {
    for (let i = 0; i < this.count; i++) {
      if (this.arch[i] === Arch.Cone || this.arch[i] === Arch.Pine || this.arch[i] === Arch.Shrub) continue;
      const x = this.x[i];
      const z = this.z[i];
      if (surface.blockAt(x, z) < 0.5) continue;
      const near = segs.nearest(x, z, 18);
      if (!near) continue;
      // Only sidewalk trees (within the sidewalk band of their street).
      if (near.dist > near.road.hw + Math.max(near.road.sw, 2.5) + 0.8) continue;
      const half = this.arch[i] === Arch.Palm ? 0.95 : 0.65;
      const pts = [x - near.dx * half, z - near.dz * half, x + near.dx * half, z + near.dz * half];
      sb.add(pts, half, Style.TreeWell, 0, (px, pz) => surface.top(px, pz), 0.012);
    }
  }

  update(camera: THREE.PerspectiveCamera, elapsed: number, sunDir: THREE.Vector3, scene: THREE.Scene): void {
    if (!this.sun) {
      scene.traverse((o) => {
        if (!this.sun && (o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.DirectionalLight).castShadow) this.sun = o as THREE.DirectionalLight;
      });
    }
    const sunView = sunDir.clone().transformDirection(camera.matrixWorldInverse);
    for (const u of this.uni) {
      u.uTime.value = elapsed;
      u.uSunView.value.copy(sunView);
      if (this.sun) u.uSunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    }
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const planes = this.frustum.planes;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const n01 = this.meshes.map(() => [0, 0]);
    let n2 = 0;
    const b2 = this.blob.instanceMatrix.array as Float32Array;
    const c2 = this.blob.instanceColor!.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const x = this.x[i];
      const y = this.y[i] + this.cy[i];
      const z = this.z[i];
      const d = Math.hypot(x - cx, y - cy, z - cz);
      if (d > FAR) continue;
      // Generous margin near the camera so off-screen trees still cast their shadows into view.
      const r = this.rad[i] + (d < 400 ? 35 : 0);
      let vis = true;
      for (let p = 0; p < 6; p++) {
        const pl = planes[p];
        if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -r) {
          vis = false;
          break;
        }
      }
      if (!vis) continue;
      const a = this.arch[i];
      const lod = d < (a === Arch.Palm ? L0_PALM : L0) ? 0 : d < L1 ? 1 : 2;
      if (lod < 2) {
        const im = this.meshes[a][lod];
        const k = n01[a][lod]++;
        (im.instanceMatrix.array as Float32Array).set(this.m01.subarray(i * 16, i * 16 + 16), k * 16);
        (im.instanceColor!.array as Float32Array).set(this.tint.subarray(i * 3, i * 3 + 3), k * 3);
      } else {
        b2.set(this.m2.subarray(i * 16, i * 16 + 16), n2 * 16);
        c2.set(this.tint.subarray(i * 3, i * 3 + 3), n2 * 3);
        n2++;
      }
    }
    this.meshes.forEach((row, a) =>
      row.forEach((im, lod) => {
        const n = n01[a][lod];
        im.count = n;
        if (n) {
          im.instanceMatrix.clearUpdateRanges();
          im.instanceMatrix.addUpdateRange(0, n * 16);
          im.instanceMatrix.needsUpdate = true;
          im.instanceColor!.clearUpdateRanges();
          im.instanceColor!.addUpdateRange(0, n * 3);
          im.instanceColor!.needsUpdate = true;
        }
      }),
    );
    this.blob.count = n2;
    if (n2) {
      this.blob.instanceMatrix.clearUpdateRanges();
      this.blob.instanceMatrix.addUpdateRange(0, n2 * 16);
      this.blob.instanceMatrix.needsUpdate = true;
      this.blob.instanceColor!.clearUpdateRanges();
      this.blob.instanceColor!.addUpdateRange(0, n2 * 3);
      this.blob.instanceColor!.needsUpdate = true;
    }
  }
}
