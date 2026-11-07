import {
  Box3,
  BufferAttribute,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  Sphere,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Camera,
  type IUniform,
  type ShaderMaterial,
  type WebGLRenderer,
} from 'three';
import { buildConifers, variantIndex, VARIANT_COUNT, type ConiferVariant } from './conifer';
import type { ForestData } from './data';
import { bakeImpostors, DEFAULT_LAYOUT, type ImpostorAtlas } from './impostor';
import { createBarkMaterial, createFoliageMaterial, createImpostorMaterial, createSharedUniforms } from './materials';
import type { ForestTextures } from './textures';

/**
 * LOD distances in "effective metres" (distance / clamp(height / 20, 0.6, 1.6), so big trees
 * keep their detail further out). Each switch is a dithered cross-fade over `fade` metres.
 */
export interface ForestLodSettings {
  lod0: number;
  lod0Fade: number;
  lod1: number;
  lod1Fade: number;
}
export const DEFAULT_LOD: ForestLodSettings = { lod0: 60, lod0Fade: 12, lod1: 240, lod1Fade: 45 };

const SIZE_REF = 20;
const sizeK = (h: number): number => Math.min(1.6, Math.max(0.6, h / SIZE_REF));

class Pool {
  capacity = 0;
  count = 0;
  iPos!: InstancedBufferAttribute;
  iDim!: InstancedBufferAttribute;
  iMisc!: InstancedBufferAttribute;
  iFade!: InstancedBufferAttribute;
  meshes: Mesh[] = [];

  constructor(
    private readonly bases: (BufferGeometry | null)[],
    private readonly materials: ShaderMaterial[],
    private readonly group: Group,
    capacity: number,
  ) {
    this.allocate(capacity);
  }

  private allocate(capacity: number): void {
    this.capacity = capacity;
    const mk = (n: number): InstancedBufferAttribute => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.iPos = mk(3);
    this.iDim = mk(2);
    this.iMisc = mk(4);
    this.iFade = mk(1);
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes = [];
    this.bases.forEach((base, k) => {
      if (base == null) return;
      const g = new InstancedBufferGeometry();
      g.index = base.index;
      for (const name of ['position', 'normal', 'uv', 'aCrown']) g.setAttribute(name, base.getAttribute(name) as BufferAttribute);
      g.setAttribute('iPos', this.iPos);
      g.setAttribute('iDim', this.iDim);
      g.setAttribute('iMisc', this.iMisc);
      g.setAttribute('iFade', this.iFade);
      g.instanceCount = 0;
      const mesh = new Mesh(g, this.materials[k]!);
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      this.meshes.push(mesh);
      this.group.add(mesh);
    });
  }

  begin(): void {
    this.count = 0;
  }

  push(data: ForestData, i: number, variant: number, fade: number): void {
    if (this.count >= this.capacity) this.grow();
    const k = this.count++;
    this.iPos.array[k * 3] = data.e[i]!;
    this.iPos.array[k * 3 + 1] = data.n[i]!;
    this.iPos.array[k * 3 + 2] = data.u[i]!;
    this.iDim.array[k * 2] = data.height[i]!;
    this.iDim.array[k * 2 + 1] = data.radius[i]!;
    this.iMisc.array[k * 4] = variant;
    this.iMisc.array[k * 4 + 1] = data.seed[i]! / 255;
    this.iMisc.array[k * 4 + 2] = data.sunTop[i]! / 255;
    this.iMisc.array[k * 4 + 3] = data.sunBase[i]! / 255;
    this.iFade.array[k] = fade;
  }

  private grow(): void {
    const old = { p: this.iPos.array, d: this.iDim.array, m: this.iMisc.array, f: this.iFade.array, n: this.count };
    this.allocate(Math.max(64, this.capacity * 2));
    (this.iPos.array as Float32Array).set(old.p);
    (this.iDim.array as Float32Array).set(old.d);
    (this.iMisc.array as Float32Array).set(old.m);
    (this.iFade.array as Float32Array).set(old.f);
  }

  end(): void {
    const n = this.count;
    for (const a of [this.iPos, this.iDim, this.iMisc, this.iFade]) {
      a.clearUpdateRanges();
      if (n > 0) a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    for (const m of this.meshes) {
      (m.geometry as InstancedBufferGeometry).instanceCount = n;
      m.visible = n > 0;
    }
  }

  dispose(): void {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
  }
}

export interface ForestStats {
  lod0: number;
  lod1: number;
  impostorChunks: number;
  selectMs: number;
}

/**
 * The forest: per-variant instanced LOD0 / LOD1 meshes for nearby trees (re-selected on the
 * CPU when the camera moves) and static per-chunk instanced impostors for everything else
 * (they hide themselves near the camera in the vertex shader).
 */
export class ForestSystem {
  readonly group = new Group();
  readonly variants: ConiferVariant[];
  readonly shared: Record<string, IUniform>;
  readonly atlas: ImpostorAtlas;
  readonly stats: ForestStats = { lod0: 0, lod1: 0, impostorChunks: 0, selectMs: 0 };
  lod: ForestLodSettings = { ...DEFAULT_LOD };

  private data: ForestData | null = null;
  private variantOf = new Uint8Array(0);
  private pools: Pool[][] = [];
  private chunks: Mesh[] = [];
  private readonly materials: ShaderMaterial[] = [];
  private readonly frustum = new Frustum();
  private readonly box = new Box3();
  private readonly m4 = new Matrix4();
  private readonly inv = new Matrix4();
  private readonly lastCam = new Vector3(Infinity, 0, 0);
  private readonly lastQuat = new Vector3(Infinity, 0, 0);
  private readonly tmp = new Vector3();

  constructor(gl: WebGLRenderer, textures: ForestTextures) {
    this.group.matrixAutoUpdate = false;
    this.group.name = 'flytake-forest';
    this.variants = buildConifers();
    this.shared = createSharedUniforms(this.variants);
    this.atlas = bakeImpostors(gl, this.variants, textures.foliage, textures.bark, DEFAULT_LAYOUT);
    const foliage = createFoliageMaterial(this.shared, textures.foliage);
    const bark = createBarkMaterial(this.shared, textures.bark, textures.barkNormal);
    this.materials.push(foliage, bark);
    for (const v of this.variants) {
      this.pools[v.id] = [0, 1].map(
        (lod) => new Pool([v.lods[lod]!.bark, v.lods[lod]!.foliage], [bark, foliage], this.group, lod === 0 ? 128 : 512),
      );
    }
    this.updateImpostorLod();
  }

  setFrame(frame: Matrix4): void {
    this.group.matrix.copy(frame);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);
    this.lastCam.set(Infinity, 0, 0);
  }

  setLod(lod: Partial<ForestLodSettings>): void {
    this.lod = { ...this.lod, ...lod };
    this.updateImpostorLod();
    this.lastCam.set(Infinity, 0, 0);
  }

  private updateImpostorLod(): void {
    (this.shared.uImpostorLod!.value as Vector2).set(this.lod.lod1 - this.lod.lod1Fade, this.lod.lod1);
  }

  setData(data: ForestData): void {
    this.clearData();
    this.data = data;
    this.variantOf = new Uint8Array(data.count);
    for (let i = 0; i < data.count; i++) this.variantOf[i] = variantIndex(data.species[i]!, data.seed[i]!, data.height[i]!);
    this.buildChunks();
    this.lastCam.set(Infinity, 0, 0);
  }

  private clearData(): void {
    for (const c of this.chunks) {
      this.group.remove(c);
      c.geometry.dispose();
    }
    this.chunks = [];
    this.data = null;
  }

  private buildChunks(): void {
    const data = this.data!;
    const g = data.grid;
    const quad = new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3);
    const index = new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
    const material = createImpostorMaterial(this.shared, this.atlas.albedo, this.atlas.normal, this.atlas.layout, this.atlas.size);
    this.materials.push(material);
    const chunkCols = g.cols / g.chunk;
    const chunkRows = g.rows / g.chunk;
    for (let cr = 0; cr < chunkRows; cr++) {
      for (let cc = 0; cc < chunkCols; cc++) {
        // trees of a chunk are contiguous: find the first / last non-empty cell
        let first = -1;
        let last = -1;
        for (let r = cr * g.chunk; r < (cr + 1) * g.chunk; r++) {
          for (let c = cc * g.chunk; c < (cc + 1) * g.chunk; c++) {
            const k = r * g.cols + c;
            if (g.count[k] === 0) continue;
            first = first < 0 ? g.start[k]! : Math.min(first, g.start[k]!);
            last = Math.max(last, g.start[k]! + g.count[k]!);
          }
        }
        if (first < 0) continue;
        const n = last - first;
        const pos = new Float32Array(n * 3);
        const dim = new Float32Array(n * 2);
        const misc = new Float32Array(n * 4);
        const box = new Box3();
        for (let j = 0; j < n; j++) {
          const i = first + j;
          pos[j * 3] = data.e[i]!;
          pos[j * 3 + 1] = data.n[i]!;
          pos[j * 3 + 2] = data.u[i]!;
          dim[j * 2] = data.height[i]!;
          dim[j * 2 + 1] = data.radius[i]!;
          misc[j * 4] = this.variantOf[i]!;
          misc[j * 4 + 1] = data.seed[i]! / 255;
          misc[j * 4 + 2] = data.sunTop[i]! / 255;
          misc[j * 4 + 3] = data.sunBase[i]! / 255;
          box.expandByPoint(this.tmp.set(data.e[i]!, data.n[i]!, data.u[i]!));
          box.expandByPoint(this.tmp.set(data.e[i]!, data.n[i]!, data.u[i]! + data.height[i]!));
        }
        box.expandByScalar(data.maxRadius * 1.5 + 2);
        const geo = new InstancedBufferGeometry();
        geo.setAttribute('position', quad);
        geo.setIndex(index);
        geo.setAttribute('iPos', new InstancedBufferAttribute(pos, 3));
        geo.setAttribute('iDim', new InstancedBufferAttribute(dim, 2));
        geo.setAttribute('iMisc', new InstancedBufferAttribute(misc, 4));
        geo.instanceCount = n;
        geo.boundingBox = box.clone();
        geo.boundingSphere = box.getBoundingSphere(new Sphere());
        const mesh = new Mesh(geo, material);
        mesh.raycast = () => {};
        mesh.name = `forest-impostors-${cc}-${cr}`;
        this.chunks.push(mesh);
        this.group.add(mesh);
      }
    }
    this.stats.impostorChunks = this.chunks.length;
  }

  /** Per frame: camera -> local frame, re-select the near trees when the view changed. */
  update(camera: Camera, time: number): void {
    this.shared.uTime!.value = time;
    const camLocal = this.shared.uCamLocal!.value as Vector3;
    this.group.updateMatrixWorld();
    this.inv.copy(this.group.matrixWorld).invert();
    camLocal.copy(camera.position).applyMatrix4(this.inv);
    const data = this.data;
    if (!data) return;
    // forward direction (local) to detect rotation
    const fwd = this.tmp.set(0, 0, -1).transformDirection(camera.matrixWorld).transformDirection(this.inv);
    if (camLocal.distanceToSquared(this.lastCam) < 0.25 && fwd.distanceToSquared(this.lastQuat) < 1e-4) return;
    this.lastCam.copy(camLocal);
    this.lastQuat.copy(fwd);
    const t0 = performance.now();
    this.select(camera, camLocal);
    this.stats.selectMs = performance.now() - t0;
  }

  private select(camera: Camera, cam: Vector3): void {
    const data = this.data!;
    const g = data.grid;
    const { lod0, lod0Fade, lod1, lod1Fade } = this.lod;
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.group.matrixWorld);
    this.frustum.setFromProjectionMatrix(this.m4);
    for (const pools of this.pools) for (const p of pools) p.begin();
    const reach = lod1 * 1.6 + data.maxRadius;
    const c0 = Math.max(0, Math.floor((cam.x - reach - g.minE) / g.cell));
    const c1 = Math.min(g.cols - 1, Math.floor((cam.x + reach - g.minE) / g.cell));
    const r0 = Math.max(0, Math.floor((cam.y - reach - g.minN) / g.cell));
    const r1 = Math.min(g.rows - 1, Math.floor((cam.y + reach - g.minN) / g.cell));
    let n0 = 0;
    let n1 = 0;
    const pad = data.maxRadius;
    for (let r = r0; r <= r1; r++) {
      const ny0 = g.minN + r * g.cell;
      for (let c = c0; c <= c1; c++) {
        const k = r * g.cols + c;
        const cnt = g.count[k]!;
        if (cnt === 0) continue;
        const ex0 = g.minE + c * g.cell;
        // nearest point of the cell to the camera (horizontal) for a quick distance reject
        const dx = Math.max(ex0 - cam.x, 0, cam.x - ex0 - g.cell);
        const dy = Math.max(ny0 - cam.y, 0, cam.y - ny0 - g.cell);
        if (dx * dx + dy * dy > reach * reach) continue;
        this.box.min.set(ex0 - pad, ny0 - pad, g.minU[k]!);
        this.box.max.set(ex0 + g.cell + pad, ny0 + g.cell + pad, g.maxU[k]!);
        if (!this.frustum.intersectsBox(this.box)) continue;
        const s = g.start[k]!;
        for (let i = s; i < s + cnt; i++) {
          const h = data.height[i]!;
          const ex = data.e[i]! - cam.x;
          const ny = data.n[i]! - cam.y;
          const uz = data.u[i]! + h * 0.5 - cam.z;
          const d = Math.sqrt(ex * ex + ny * ny + uz * uz) / sizeK(h);
          if (d >= lod1) continue;
          const v = this.variantOf[i]!;
          const pools = this.pools[v]!;
          if (d < lod0) {
            const t = Math.min(1, Math.max(0, (d - (lod0 - lod0Fade)) / lod0Fade));
            pools[0]!.push(data, i, v, t > 0 ? -t : 1);
            n0++;
            if (t > 0) {
              pools[1]!.push(data, i, v, t);
              n1++;
            }
          } else {
            const t = Math.min(1, Math.max(0, (d - (lod1 - lod1Fade)) / lod1Fade));
            pools[1]!.push(data, i, v, t > 0 ? -t : 1);
            n1++;
          }
        }
      }
    }
    for (const pools of this.pools) for (const p of pools) p.end();
    this.stats.lod0 = n0;
    this.stats.lod1 = n1;
  }

  dispose(): void {
    this.clearData();
    for (const pools of this.pools) for (const p of pools) p.dispose();
    for (const m of this.materials) m.dispose();
    this.atlas.dispose();
  }

  get variantCount(): number {
    return VARIANT_COUNT;
  }
}
