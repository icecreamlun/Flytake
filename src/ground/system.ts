import {
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  Vector3,
  Vector4,
  type BufferGeometry,
  type Camera,
  type ShaderMaterial,
} from 'three';
import { CHUNK, STRIDE, scatterChunk, type CategorySpec, type ChunkCategory } from './scatter';
import { GROUND_UNIFORMS } from './materials';
import type { GroundTiles } from './tiles';

/** One draw: a base geometry + an instance buffer. */
class Bucket {
  capacity = 0;
  count = 0;
  data = new Float32Array(0);
  geometry!: InstancedBufferGeometry;
  readonly mesh: Mesh;

  constructor(
    private readonly base: BufferGeometry,
    material: ShaderMaterial,
    private readonly group: Group,
  ) {
    this.mesh = new Mesh(undefined, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.allocate(64);
    group.add(this.mesh);
  }

  private allocate(capacity: number): void {
    this.capacity = capacity;
    const old = this.data;
    this.data = new Float32Array(capacity * STRIDE);
    this.data.set(old.subarray(0, Math.min(old.length, this.data.length)));
    const buffer = new InstancedInterleavedBuffer(this.data, STRIDE);
    const g = new InstancedBufferGeometry();
    g.index = this.base.index;
    for (const [name, attr] of Object.entries(this.base.attributes)) g.setAttribute(name, attr);
    g.setAttribute('iPos', new InterleavedBufferAttribute(buffer, 4, 0));
    g.setAttribute('iQuat', new InterleavedBufferAttribute(buffer, 4, 4));
    g.setAttribute('iMisc', new InterleavedBufferAttribute(buffer, 4, 8));
    this.geometry?.dispose();
    this.geometry = g;
    this.mesh.geometry = g;
  }

  begin(): void {
    this.count = 0;
  }

  push(src: Float32Array, o: number): void {
    if (this.count === this.capacity) this.allocate(this.capacity * 2);
    this.data.set(src.subarray(o, o + STRIDE), this.count * STRIDE);
    this.count++;
  }

  commit(): void {
    const attr = this.geometry.getAttribute('iPos') as InterleavedBufferAttribute;
    const buffer = attr.data as InstancedInterleavedBuffer;
    buffer.clearUpdateRanges();
    buffer.addUpdateRange(0, this.count * STRIDE);
    buffer.needsUpdate = true;
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.group.remove(this.mesh);
    this.geometry.dispose();
  }
}

export interface LodDef {
  /** upper effective distance of this LOD */
  to: number;
  /** per variant: geometry + material */
  draws: { geometry: BufferGeometry; material: ShaderMaterial }[];
  /** the fade window the materials of this LOD use (shared Vector4) */
  fade: Vector4;
}

export interface CategoryDef {
  name: string;
  spec: CategorySpec;
  /** generation / draw radius, plain 3D distance (m) */
  radius: number;
  /** effective distance = distance / clamp(size / sizeRef, 0.5, 2.5); 0 = plain distance */
  sizeRef: number;
  /** cross-fade width between LODs (effective m) */
  fadeWidth: number;
  lods: LodDef[];
  /** reflection layer for these meshes (or null) */
  layer?: number | null;
}

interface CategoryState {
  def: CategoryDef;
  chunks: Map<number, ChunkCategory>;
  buckets: Bucket[][];
  lastCam: Vector3;
  dirty: boolean;
  move: number;
}

const ckey = (cx: number, cy: number): number => (cy + 2048) * 4096 + (cx + 2048);

/** Streams the ground cover around the camera (see README.md). */
export class GroundSystem {
  readonly group = new Group();
  private readonly cats: CategoryState[] = [];
  private readonly camLocal = new Vector3();
  private readonly inv = new Matrix4();
  /** ms of chunk generation allowed per frame (main thread) */
  genBudgetMs = 2;
  stats = { instances: 0, chunks: 0, tris: 0, draws: 0, updateMs: 0, updateMaxMs: 0, rebuildMs: 0, byCat: {} as Record<string, number> };

  constructor(
    private readonly tiles: GroundTiles,
    defs: CategoryDef[],
  ) {
    this.group.name = 'ground-cover';
    this.group.matrixAutoUpdate = false;
    for (const def of defs) {
      // LOD fade windows: complementary cross-fades at every boundary, fade-out at the end
      let from = 0;
      def.lods.forEach((lod, k) => {
        const last = k === def.lods.length - 1;
        const f = def.fadeWidth;
        lod.fade.set(k === 0 ? -2 : from - f / 2, k === 0 ? -1 : from + f / 2, last ? lod.to - f : lod.to - f / 2, last ? lod.to : lod.to + f / 2);
        for (const d of lod.draws) {
          d.material.uniforms.uFade!.value = lod.fade;
          if (d.material.uniforms.uSizeRef) d.material.uniforms.uSizeRef.value = def.sizeRef;
        }
        from = lod.to;
      });
      const buckets = def.lods.map((lod) =>
        lod.draws.map((d) => {
          const b = new Bucket(d.geometry, d.material, this.group);
          if (def.layer != null) b.mesh.layers.enable(def.layer);
          return b;
        }),
      );
      this.cats.push({ def, chunks: new Map(), buckets, lastCam: new Vector3(1e9, 0, 0), dirty: true, move: Math.min(4, Math.max(1.5, def.radius * 0.01)) });
    }
  }

  setFrame(frame: Matrix4): void {
    this.group.matrix.copy(frame);
    this.group.matrixWorldNeedsUpdate = true;
    this.inv.copy(frame).invert();
  }

  update(camera: Camera): void {
    const cam = this.camLocal.copy(camera.position).applyMatrix4(this.inv);
    GROUND_UNIFORMS.uCamLocal.value.copy(cam);
    // camera height above the ground (if its tile is loaded)
    let agl = Math.max(0, cam.z);
    const t = this.tiles.tileOf(cam.x, cam.y);
    if (t) {
      const tile = this.tiles.get(t[0], t[1]);
      if (tile) agl = Math.max(0, cam.z - this.tiles.height(tile, cam.x, cam.y));
      else if (tile === undefined) void this.tiles.load(t[0], t[1]);
    }
    const t0 = performance.now();
    let instances = 0;
    let chunks = 0;
    let tris = 0;
    let draws = 0;
    // stream every category (shared time budget), then rebuild at most one per frame: the one
    // whose camera moved furthest (relative to its step) since its last rebuild
    let pick: CategoryState | null = null;
    let pickScore = 1;
    for (const cat of this.cats) {
      const r = cat.def.radius;
      const rh = agl < r ? Math.sqrt(r * r - agl * agl) : -1;
      this.stream(cat, cam, rh, t0);
      const score = cat.dirty ? 1e6 + cat.lastCam.distanceTo(cam) : cat.lastCam.distanceTo(cam) / cat.move;
      if (score >= pickScore) {
        pick = cat;
        pickScore = score;
      }
    }
    if (pick) this.rebuild(pick, cam);
    for (const cat of this.cats) {
      const trisBefore = tris;
      for (const lod of cat.buckets)
        for (const b of lod) {
          instances += b.count;
          if (b.count > 0) {
            draws++;
            tris += (b.count * (b.geometry.index?.count ?? 0)) / 3;
          }
        }
      chunks += cat.chunks.size;
      this.stats.byCat[cat.def.name] = Math.round((tris - trisBefore) / 1000);
    }
    const dt = performance.now() - t0;
    this.stats.updateMs = this.stats.updateMs * 0.95 + dt * 0.05;
    this.stats.updateMaxMs = Math.max(this.stats.updateMaxMs * 0.995, dt);
    this.stats.instances = instances;
    this.stats.chunks = chunks;
    this.stats.tris = tris;
    this.stats.draws = draws;
  }

  private stream(cat: CategoryState, cam: Vector3, rh: number, t0: number): void {
    // drop chunks that left the radius (with hysteresis)
    const keep = rh * 1.25 + CHUNK;
    for (const k of cat.chunks.keys()) {
      const cx = (k % 4096) - 2048;
      const cy = Math.floor(k / 4096) - 2048;
      if (rh < 0 || chunkDist(cx, cy, cam) > keep) {
        cat.chunks.delete(k);
        cat.dirty = true;
      }
    }
    if (rh < 0) return;
    const c0x = Math.floor((cam.x - rh) / CHUNK);
    const c1x = Math.floor((cam.x + rh) / CHUNK);
    const c0y = Math.floor((cam.y - rh) / CHUNK);
    const c1y = Math.floor((cam.y + rh) / CHUNK);
    const want: [number, number, number][] = [];
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const d = chunkDist(cx, cy, cam);
        if (d > rh || cat.chunks.has(ckey(cx, cy))) continue;
        want.push([d, cx, cy]);
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cy] of want) {
      if (performance.now() - t0 > this.genBudgetMs) break;
      const res = scatterChunk(this.tiles, cat.def.spec, cx, cy);
      if (res == null) continue; // tile loading
      cat.chunks.set(ckey(cx, cy), res);
      cat.dirty = true;
    }
  }

  private rebuild(cat: CategoryState, cam: Vector3): void {
    const t0 = performance.now();
    cat.lastCam.copy(cam);
    cat.dirty = false;
    const { lods, sizeRef, fadeWidth } = cat.def;
    // instances further out than the next rebuild can bring them stay out of a bucket (their
    // vertices would still be processed before the shader collapses them)
    const margin = (sizeRef > 0 ? 2 : 1) * cat.move + fadeWidth / 2 + 0.5;
    for (const lod of cat.buckets) for (const b of lod) b.begin();
    const bounds = lods.map((l, k) => [k === 0 ? -1e9 : lods[k - 1]!.to - margin, l.to + margin] as const);
    for (const ch of cat.chunks.values()) {
      const d = ch.data;
      for (let n = 0; n < ch.count; n++) {
        const o = n * STRIDE;
        const dx = d[o]! - cam.x;
        const dy = d[o + 1]! - cam.y;
        const dz = d[o + 2]! - cam.z;
        let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (sizeRef > 0) dist /= Math.min(2.5, Math.max(0.5, d[o + 3]! / sizeRef));
        const v = ch.variant[n]!;
        for (let k = 0; k < lods.length; k++) {
          const [lo, hi] = bounds[k]!;
          if (dist >= lo && dist <= hi) cat.buckets[k]![v]?.push(d, o);
        }
      }
    }
    for (const lod of cat.buckets) for (const b of lod) b.commit();
    this.stats.rebuildMs = performance.now() - t0;
  }

  dispose(): void {
    for (const cat of this.cats) for (const lod of cat.buckets) for (const b of lod) b.dispose();
  }
}

function chunkDist(cx: number, cy: number, cam: Vector3): number {
  const x0 = cx * CHUNK;
  const y0 = cy * CHUNK;
  const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + CHUNK));
  const dy = Math.max(y0 - cam.y, 0, cam.y - (y0 + CHUNK));
  return Math.hypot(dx, dy);
}
