/**
 * Static instance set with per-frame CPU frustum + distance culling: only visible instances are packed into
 * the InstancedMesh (matrix, optional colour and aInst attribute).
 */
import * as THREE from 'three';

export class CulledSet {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private mats: Float32Array;
  private cols: Float32Array | null;
  private inst: Float32Array | null;
  private pos: Float32Array;
  private rad: Float32Array;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    private cap: number,
    opts: { colors?: boolean; inst?: boolean; shadows?: boolean; maxDist?: number; minDist?: number; name?: string } = {},
  ) {
    this.maxDist = opts.maxDist ?? 1200;
    this.minDist = opts.minDist ?? 0;
    this.mats = new Float32Array(cap * 16);
    this.pos = new Float32Array(cap * 3);
    this.rad = new Float32Array(cap);
    this.cols = opts.colors ? new Float32Array(cap * 3) : null;
    this.inst = opts.inst ? new Float32Array(cap * 4) : null;
    const g = geometry;
    if (opts.inst) g.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, cap) * 4), 4).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.InstancedMesh(g, material, Math.max(1, cap));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = opts.shadows ?? true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (opts.colors) this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, cap) * 3), 3).setUsage(THREE.DynamicDrawUsage);
    if (opts.name) this.mesh.name = opts.name;
  }
  maxDist: number;
  minDist: number;

  get count(): number {
    return this.n;
  }

  add(m: THREE.Matrix4, radius: number, color?: THREE.Color, inst?: [number, number, number, number]): number {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    m.toArray(this.mats, i * 16);
    this.pos[i * 3] = this.mats[i * 16 + 12];
    this.pos[i * 3 + 1] = this.mats[i * 16 + 13];
    this.pos[i * 3 + 2] = this.mats[i * 16 + 14];
    this.rad[i] = radius;
    if (this.cols && color) {
      this.cols[i * 3] = color.r;
      this.cols[i * 3 + 1] = color.g;
      this.cols[i * 3 + 2] = color.b;
    }
    if (this.inst && inst) this.inst.set(inst, i * 4);
    return i;
  }

  /** Replace an instance's matrix (moving objects). */
  setMatrix(i: number, m: THREE.Matrix4): void {
    m.toArray(this.mats, i * 16);
    this.pos[i * 3] = this.mats[i * 16 + 12];
    this.pos[i * 3 + 1] = this.mats[i * 16 + 13];
    this.pos[i * 3 + 2] = this.mats[i * 16 + 14];
  }

  update(planes: THREE.Plane[], cam: THREE.Vector3): void {
    const M = this.mesh.instanceMatrix.array as Float32Array;
    const C = this.mesh.instanceColor?.array as Float32Array | undefined;
    const I = this.inst ? ((this.mesh.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute).array as Float32Array) : null;
    let k = 0;
    const md2 = this.maxDist * this.maxDist;
    const mn2 = this.minDist * this.minDist;
    for (let i = 0; i < this.n; i++) {
      const x = this.pos[i * 3];
      const y = this.pos[i * 3 + 1];
      const z = this.pos[i * 3 + 2];
      const dx = x - cam.x;
      const dy = y - cam.y;
      const dz = z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > md2 || d2 < mn2) continue;
      const r = this.rad[i] + (d2 < 160000 ? 25 : 0);
      let vis = true;
      for (let p = 0; p < 6; p++) {
        const pl = planes[p];
        if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -r) {
          vis = false;
          break;
        }
      }
      if (!vis) continue;
      M.set(this.mats.subarray(i * 16, i * 16 + 16), k * 16);
      if (C && this.cols) C.set(this.cols.subarray(i * 3, i * 3 + 3), k * 3);
      if (I && this.inst) I.set(this.inst.subarray(i * 4, i * 4 + 4), k * 4);
      k++;
    }
    this.mesh.count = k;
    if (k) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, k * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.clearUpdateRanges();
        this.mesh.instanceColor.addUpdateRange(0, k * 3);
        this.mesh.instanceColor.needsUpdate = true;
      }
      if (I) {
        const a = this.mesh.geometry.getAttribute('aInst') as THREE.InstancedBufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, k * 4);
        a.needsUpdate = true;
      }
    }
  }
}
