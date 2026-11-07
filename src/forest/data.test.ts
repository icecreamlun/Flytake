import { describe, expect, it } from 'vitest';
import { encodeTrees, parseTrees, TREES_HEADER, TREES_STRIDE, type TreeRecord } from './data';

const tree = (e: number, n: number, extra: Partial<TreeRecord> = {}): TreeRecord => ({
  e,
  n,
  u: 10,
  height: 20,
  crownRadius: 3,
  species: 0,
  seed: 7,
  sunTop: 255,
  sunBase: 128,
  ...extra,
});

describe('trees.bin', () => {
  it('round-trips records and sorts them into grid cells', () => {
    const src = [tree(-100, -100), tree(1000, 5), tree(-98, -97, { species: 2, seed: 200, sunTop: 9 }), tree(0.5, 0.5, { height: 33.5 })];
    const buf = encodeTrees(src);
    expect(buf.byteLength).toBe(TREES_HEADER + src.length * TREES_STRIDE);
    const d = parseTrees(buf);
    expect(d.count).toBe(4);
    expect(d.maxHeight).toBeCloseTo(33.5);
    // every record survives (order changes)
    const found = Array.from({ length: d.count }, (_, i) => [d.e[i], d.n[i], d.species[i], d.seed[i], d.sunTop[i], d.sunBase[i]]);
    expect(found).toContainEqual([-98, -97, 2, 200, 9, 128]);
    // cell ranges cover every tree exactly once and contain trees of that cell
    const g = d.grid;
    let total = 0;
    for (let k = 0; k < g.cols * g.rows; k++) {
      for (let i = g.start[k]!; i < g.start[k]! + g.count[k]!; i++) {
        total++;
        expect(Math.floor((d.e[i]! - g.minE) / g.cell) + Math.floor((d.n[i]! - g.minN) / g.cell) * g.cols).toBe(k);
      }
    }
    expect(total).toBe(4);
    // the two trees 3 m apart share a cell
    const k = Math.floor((-100 - g.minE) / g.cell) + Math.floor((-100 - g.minN) / g.cell) * g.cols;
    expect(g.count[k]).toBe(2);
    expect(g.maxU[k]).toBeCloseTo(30);
  });

  it('rejects bad files', () => {
    expect(() => parseTrees(new ArrayBuffer(4))).toThrow(/truncated/);
    const buf = encodeTrees([tree(0, 0)]);
    new DataView(buf).setUint8(0, 88);
    expect(() => parseTrees(buf)).toThrow(/magic/);
    const short = encodeTrees([tree(0, 0), tree(1, 1)]).slice(0, TREES_HEADER + TREES_STRIDE);
    expect(() => parseTrees(short)).toThrow(/truncated/);
  });

  it('accepts a larger stride (future fields)', () => {
    const buf = new ArrayBuffer(TREES_HEADER + 2 * 32);
    const v = new DataView(buf);
    'FTRE'.split('').forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
    v.setUint32(4, 1, true);
    v.setUint32(8, 2, true);
    v.setUint32(12, 32, true);
    v.setFloat32(TREES_HEADER + 32 + 12, 41, true);
    const d = parseTrees(buf);
    expect(d.count).toBe(2);
    expect(Math.max(d.height[0]!, d.height[1]!)).toBe(41);
  });
});
