/**
 * Ground-cover placement tiles (tools/scene/ground_classes.py): per finest-level terrain tile,
 * the terrain heights on the tile's own 129 x 129 vertex grid (so placed props follow the mesh)
 * and seven cover-density planes on every other vertex.
 */

export const COVER = { rock: 0, grass: 1, shrub: 2, debris: 3, pebble: 4, canopy: 5, green: 6 } as const;
export type CoverKey = keyof typeof COVER;
const COVER_PLANES = 7;

interface GroundIndex {
  level: number;
  grid: number;
  coverGrid: number;
  tiles: number;
  extent: [number, number, number, number];
  tileSize: [number, number];
  heightStep: number;
  present: [number, number][];
}

export interface GroundTile {
  i: number;
  j: number;
  e0: number;
  n0: number;
  /** raster heights (ellipsoidal - H0), GRID x GRID, row 0 = south */
  h: Float32Array;
  /** COVER_PLANES x CGRID x CGRID, 0..1 */
  cover: Float32Array;
}

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf);
  // a server may already have removed the gzip layer (Content-Encoding)
  if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export class GroundTiles {
  private index: GroundIndex | null = null;
  private present = new Set<number>();
  private tiles = new Map<number, GroundTile | null>();
  private pending = new Map<number, Promise<GroundTile | null>>();
  ready = false;

  constructor(private readonly base: string) {}

  async init(): Promise<void> {
    const res = await fetch(`${this.base}/index.json`);
    if (!res.ok) throw new Error(`ground index ${res.status}`);
    this.index = (await res.json()) as GroundIndex;
    for (const [i, j] of this.index.present) this.present.add(this.key(i, j));
    this.ready = true;
  }

  private key(i: number, j: number): number {
    return j * 4096 + i;
  }

  get grid(): number {
    return this.index?.grid ?? 129;
  }

  /** tile index of a scene xy (or null outside the extent) */
  tileOf(x: number, y: number): [number, number] | null {
    const ix = this.index;
    if (!ix) return null;
    const i = Math.floor((x - ix.extent[0]) / ix.tileSize[0]);
    const j = Math.floor((y - ix.extent[2]) / ix.tileSize[1]);
    if (i < 0 || j < 0 || i >= ix.tiles || j >= ix.tiles) return null;
    return [i, j];
  }

  /** the loaded tile (undefined while loading / not requested, null if it has no land) */
  get(i: number, j: number): GroundTile | null | undefined {
    return this.tiles.get(this.key(i, j));
  }

  /** request a tile; resolves to null for tiles without land */
  load(i: number, j: number): Promise<GroundTile | null> {
    const k = this.key(i, j);
    const have = this.tiles.get(k);
    if (have !== undefined) return Promise.resolve(have);
    const p = this.pending.get(k);
    if (p) return p;
    const ix = this.index!;
    if (!this.present.has(k)) {
      this.tiles.set(k, null);
      return Promise.resolve(null);
    }
    const job = (async () => {
      const res = await fetch(`${this.base}/tiles/${i}_${j}.bin`);
      if (!res.ok) throw new Error(`ground tile ${i}_${j}: ${res.status}`);
      const buf = await gunzip(await res.arrayBuffer());
      const dv = new DataView(buf);
      const hMin = dv.getFloat32(0, true);
      const step = dv.getFloat32(4, true);
      const G = ix.grid;
      const C = ix.coverGrid;
      const dq = new Int16Array(buf, 8, G * G);
      const h = new Float32Array(G * G);
      let rowStart = 0;
      for (let r = 0; r < G; r++) {
        rowStart += dq[r * G]!;
        let q = rowStart;
        h[r * G] = hMin + q * step;
        for (let c = 1; c < G; c++) {
          q += dq[r * G + c]!;
          h[r * G + c] = hMin + q * step;
        }
      }
      const planes = new Uint8Array(buf, 8 + G * G * 2, COVER_PLANES * C * C);
      const cover = new Float32Array(planes.length);
      for (let n = 0; n < planes.length; n++) cover[n] = planes[n]! / 15;
      const tile: GroundTile = {
        i,
        j,
        e0: ix.extent[0] + i * ix.tileSize[0],
        n0: ix.extent[2] + j * ix.tileSize[1],
        h,
        cover,
      };
      this.tiles.set(k, tile);
      this.pending.delete(k);
      return tile;
    })().catch((err: unknown) => {
      console.warn('[flytake] ground tile failed', err);
      this.tiles.set(k, null);
      this.pending.delete(k);
      return null;
    });
    this.pending.set(k, job);
    return job;
  }

  /** raster height at a scene xy inside `tile` (bilinear on the vertex grid) */
  height(tile: GroundTile, x: number, y: number): number {
    const ix = this.index!;
    const G = ix.grid;
    const fx = Math.min(G - 1.0001, Math.max(0, ((x - tile.e0) / ix.tileSize[0]) * (G - 1)));
    const fy = Math.min(G - 1.0001, Math.max(0, ((y - tile.n0) / ix.tileSize[1]) * (G - 1)));
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const tx = fx - c;
    const ty = fy - r;
    const h = tile.h;
    const a = h[r * G + c]!;
    const b = h[r * G + c + 1]!;
    const d = h[(r + 1) * G + c]!;
    const e = h[(r + 1) * G + c + 1]!;
    // bilinear: the RTIN mesh splits cells along either diagonal, this sits between both
    return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  }

  /** cover density (0..1) of one plane at a scene xy inside `tile` (bilinear) */
  cover(tile: GroundTile, plane: number, x: number, y: number): number {
    const ix = this.index!;
    const C = ix.coverGrid;
    const fx = Math.min(C - 1.0001, Math.max(0, ((x - tile.e0) / ix.tileSize[0]) * (C - 1)));
    const fy = Math.min(C - 1.0001, Math.max(0, ((y - tile.n0) / ix.tileSize[1]) * (C - 1)));
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const tx = fx - c;
    const ty = fy - r;
    const o = plane * C * C;
    const v = tile.cover;
    const top = v[o + r * C + c]! * (1 - tx) + v[o + r * C + c + 1]! * tx;
    const bot = v[o + (r + 1) * C + c]! * (1 - tx) + v[o + (r + 1) * C + c + 1]! * tx;
    return top * (1 - ty) + bot * ty;
  }
}
