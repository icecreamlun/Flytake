/**
 * trees.bin: the lidar-derived tree list (see README.md for the format).
 *
 * Parsed into struct-of-arrays, re-ordered so every grid cell's trees are contiguous
 * (cells inside a chunk are contiguous too, so a chunk is one range as well).
 */

export const TREES_MAGIC = 'FTRE';
export const TREES_VERSION = 1;
export const TREES_HEADER = 16;
export const TREES_STRIDE = 24;

export const Species = { Fir: 0, JeffreyPine: 1, Lodgepole: 2, Snag: 3 } as const;
export type Species = (typeof Species)[keyof typeof Species];

export interface TreeRecord {
  e: number;
  n: number;
  u: number;
  height: number;
  crownRadius: number;
  species: number;
  seed: number;
  sunTop: number;
  sunBase: number;
}

/** Spatial index: CELL-metre cells grouped into CHUNK x CHUNK chunks. */
export interface ForestGrid {
  cell: number;
  /** cells per chunk side */
  chunk: number;
  minE: number;
  minN: number;
  cols: number;
  rows: number;
  /** first tree of cell (row * cols + col) */
  start: Uint32Array;
  /** number of trees in each cell */
  count: Uint32Array;
  /** lowest ground / highest tree top per cell (u) */
  minU: Float32Array;
  maxU: Float32Array;
}

export interface ForestData {
  count: number;
  e: Float32Array;
  n: Float32Array;
  u: Float32Array;
  height: Float32Array;
  radius: Float32Array;
  species: Uint8Array;
  seed: Uint8Array;
  sunTop: Uint8Array;
  sunBase: Uint8Array;
  grid: ForestGrid;
  maxHeight: number;
  maxRadius: number;
}

export const GRID_CELL = 32;
export const GRID_CHUNK = 16; // 512 m chunks

export function parseTrees(buffer: ArrayBuffer, cell = GRID_CELL, chunk = GRID_CHUNK): ForestData {
  const view = new DataView(buffer);
  if (buffer.byteLength < TREES_HEADER) throw new Error('trees.bin: truncated header');
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== TREES_MAGIC) throw new Error(`trees.bin: bad magic ${JSON.stringify(magic)}`);
  const version = view.getUint32(4, true);
  if (version !== TREES_VERSION) throw new Error(`trees.bin: unsupported version ${version}`);
  const count = view.getUint32(8, true);
  const stride = view.getUint32(12, true);
  if (stride < TREES_STRIDE) throw new Error(`trees.bin: stride ${stride} < ${TREES_STRIDE}`);
  if (buffer.byteLength < TREES_HEADER + count * stride) throw new Error('trees.bin: truncated records');

  const e = new Float32Array(count);
  const n = new Float32Array(count);
  const u = new Float32Array(count);
  const height = new Float32Array(count);
  const radius = new Float32Array(count);
  const species = new Uint8Array(count);
  const seed = new Uint8Array(count);
  const sunTop = new Uint8Array(count);
  const sunBase = new Uint8Array(count);
  for (let i = 0, o = TREES_HEADER; i < count; i++, o += stride) {
    e[i] = view.getFloat32(o, true);
    n[i] = view.getFloat32(o + 4, true);
    u[i] = view.getFloat32(o + 8, true);
    height[i] = view.getFloat32(o + 12, true);
    radius[i] = view.getFloat32(o + 16, true);
    species[i] = Math.min(3, view.getUint8(o + 20));
    seed[i] = view.getUint8(o + 21);
    sunTop[i] = view.getUint8(o + 22);
    sunBase[i] = view.getUint8(o + 23);
  }
  return indexTrees({ count, e, n, u, height, radius, species, seed, sunTop, sunBase }, cell, chunk);
}

type Columns = Omit<ForestData, 'grid' | 'maxHeight' | 'maxRadius'>;

/** Sort the trees by (chunk, cell) and build the grid. */
export function indexTrees(src: Columns, cell = GRID_CELL, chunk = GRID_CHUNK): ForestData {
  const { count } = src;
  let minE = Infinity;
  let minN = Infinity;
  let maxE = -Infinity;
  let maxN = -Infinity;
  let maxHeight = 0;
  let maxRadius = 0;
  for (let i = 0; i < count; i++) {
    minE = Math.min(minE, src.e[i]!);
    maxE = Math.max(maxE, src.e[i]!);
    minN = Math.min(minN, src.n[i]!);
    maxN = Math.max(maxN, src.n[i]!);
    maxHeight = Math.max(maxHeight, src.height[i]!);
    maxRadius = Math.max(maxRadius, src.radius[i]!);
  }
  if (count === 0) {
    minE = minN = 0;
    maxE = maxN = 1;
  }
  const span = cell * chunk;
  minE = Math.floor(minE / span) * span;
  minN = Math.floor(minN / span) * span;
  const chunkCols = Math.max(1, Math.ceil((maxE - minE + 1e-3) / span));
  const chunkRows = Math.max(1, Math.ceil((maxN - minN + 1e-3) / span));
  const cols = chunkCols * chunk;
  const rows = chunkRows * chunk;

  // sort key: chunk-major, then cell within the chunk
  const key = new Uint32Array(count);
  const cellOf = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((src.e[i]! - minE) / cell)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((src.n[i]! - minN) / cell)));
    cellOf[i] = r * cols + c;
    const chunkIndex = Math.floor(r / chunk) * chunkCols + Math.floor(c / chunk);
    key[i] = chunkIndex * chunk * chunk + (r % chunk) * chunk + (c % chunk);
  }
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => key[a]! - key[b]!);

  const out: ForestData = {
    count,
    e: new Float32Array(count),
    n: new Float32Array(count),
    u: new Float32Array(count),
    height: new Float32Array(count),
    radius: new Float32Array(count),
    species: new Uint8Array(count),
    seed: new Uint8Array(count),
    sunTop: new Uint8Array(count),
    sunBase: new Uint8Array(count),
    maxHeight,
    maxRadius,
    grid: {
      cell,
      chunk,
      minE,
      minN,
      cols,
      rows,
      start: new Uint32Array(cols * rows),
      count: new Uint32Array(cols * rows),
      minU: new Float32Array(cols * rows).fill(Infinity),
      maxU: new Float32Array(cols * rows).fill(-Infinity),
    },
  };
  const g = out.grid;
  for (let j = 0; j < count; j++) {
    const i = order[j]!;
    out.e[j] = src.e[i]!;
    out.n[j] = src.n[i]!;
    out.u[j] = src.u[i]!;
    out.height[j] = src.height[i]!;
    out.radius[j] = src.radius[i]!;
    out.species[j] = src.species[i]!;
    out.seed[j] = src.seed[i]!;
    out.sunTop[j] = src.sunTop[i]!;
    out.sunBase[j] = src.sunBase[i]!;
    const c = cellOf[i]!;
    if (g.count[c] === 0) g.start[c] = j;
    g.count[c]!++;
    g.minU[c] = Math.min(g.minU[c]!, src.u[i]!);
    g.maxU[c] = Math.max(g.maxU[c]!, src.u[i]! + src.height[i]!);
  }
  return out;
}

/** Inverse of parseTrees (tests, dev page). */
export function encodeTrees(trees: ArrayLike<TreeRecord> | TreeRecord[]): ArrayBuffer {
  const count = trees.length;
  const buffer = new ArrayBuffer(TREES_HEADER + count * TREES_STRIDE);
  const view = new DataView(buffer);
  for (let k = 0; k < 4; k++) view.setUint8(k, TREES_MAGIC.charCodeAt(k));
  view.setUint32(4, TREES_VERSION, true);
  view.setUint32(8, count, true);
  view.setUint32(12, TREES_STRIDE, true);
  for (let i = 0, o = TREES_HEADER; i < count; i++, o += TREES_STRIDE) {
    const t = trees[i]!;
    view.setFloat32(o, t.e, true);
    view.setFloat32(o + 4, t.n, true);
    view.setFloat32(o + 8, t.u, true);
    view.setFloat32(o + 12, t.height, true);
    view.setFloat32(o + 16, t.crownRadius, true);
    view.setUint8(o + 20, t.species);
    view.setUint8(o + 21, t.seed);
    view.setUint8(o + 22, t.sunTop);
    view.setUint8(o + 23, t.sunBase);
  }
  return buffer;
}
