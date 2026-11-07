import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { forestLoaded, forestRaycast, rayCone, rayCylinder, setForestCollisionData, trunkRadius } from './collide';
import { encodeTrees, parseTrees, type TreeRecord } from './data';

const tree = (e: number, n: number, extra: Partial<TreeRecord> = {}): TreeRecord => ({
  e,
  n,
  u: 0,
  height: 20,
  crownRadius: 4,
  species: 0,
  seed: 0,
  sunTop: 255,
  sunBase: 255,
  ...extra,
});

describe('primitives', () => {
  it('ray vs cylinder', () => {
    expect(rayCylinder(-10, 0, 1, 1, 0, 0, 0, 0, 1, 0, 5)).toBeCloseTo(9);
    expect(rayCylinder(-10, 0, 6, 1, 0, 0, 0, 0, 1, 0, 5)).toBe(Infinity); // above
    expect(rayCylinder(0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 5)).toBe(0); // inside
    expect(rayCylinder(-10, 3, 1, 1, 0, 0, 0, 0, 1, 0, 5)).toBe(Infinity); // miss
  });

  it('ray vs cone (apex 10, base radius 2 at z 0)', () => {
    // horizontal ray at z 5: cone radius there is 1
    expect(rayCone(-10, 0, 5, 1, 0, 0, 0, 0, 10, 0, 2)).toBeCloseTo(9);
    // straight down onto the apex
    expect(rayCone(0, 0, 20, 0, 0, -1, 0, 0, 10, 0, 2)).toBeCloseTo(10);
    // up into the base disk
    expect(rayCone(1.5, 0, -5, 0, 0, 1, 0, 0, 10, 0, 2)).toBeCloseTo(5);
    // passes beside the narrow top
    expect(rayCone(-10, 0.8, 7, 1, 0, 0, 0, 0, 10, 0, 2)).toBe(Infinity);
    // inside
    expect(rayCone(0, 0, 3, 1, 0, 0, 0, 0, 10, 0, 2)).toBe(0);
  });
});

describe('forestRaycast', () => {
  afterEach(() => setForestCollisionData(null));

  it('hits the nearest crown or trunk along the ray', () => {
    const data = parseTrees(encodeTrees([tree(50, 0), tree(20, 0), tree(20, 30), tree(300, 2, { species: 3 })]));
    setForestCollisionData(data);
    expect(forestLoaded()).toBe(true);
    // crown of the fir at x=20: crown base 5.6 m, apex 20 m, solid radius 4.6 m (1.15 x lidar);
    // at z 10 radius ~3.19
    const t = forestRaycast(new Vector3(0, 0, 10), new Vector3(1, 0, 0), 100)!;
    expect(t).toBeGreaterThan(16.6);
    expect(t).toBeLessThan(17.0);
    // below the crown only the trunk counts
    expect(forestRaycast(new Vector3(0, 0, 2), new Vector3(2, 0, 0), 100)).toBeCloseTo(20 - trunkRadius(20), 3);
    // maxDist respected
    expect(forestRaycast(new Vector3(0, 0, 10), new Vector3(1, 0, 0), 10)).toBeNull();
    // over the trees
    expect(forestRaycast(new Vector3(0, 0, 25), new Vector3(1, 0, 0), 500)).toBeNull();
    // snags have no crown: only the trunk
    expect(forestRaycast(new Vector3(290, 3.5, 10), new Vector3(1, 0, 0), 50)).toBeNull();
    expect(forestRaycast(new Vector3(290, 2, 10), new Vector3(1, 0, 0), 50)).toBeCloseTo(10 - trunkRadius(20), 3);
  });

  it('walks long diagonal rays through many cells', () => {
    const trees: TreeRecord[] = [];
    for (let i = 0; i < 40; i++) trees.push(tree(i * 37 + 3, -500 + i * 11, { height: 10, crownRadius: 1 }));
    trees.push(tree(400, 400, { height: 30, crownRadius: 6 }));
    setForestCollisionData(parseTrees(encodeTrees(trees)));
    const o = new Vector3(0, 0, 15);
    const d = new Vector3(1, 1, 0);
    const t = forestRaycast(o, d, 2000)!;
    expect(t).toBeGreaterThan(Math.hypot(400, 400) - 6);
    expect(t).toBeLessThan(Math.hypot(400, 400));
  });

  it('returns null without data', () => {
    expect(forestLoaded()).toBe(false);
    expect(forestRaycast(new Vector3(), new Vector3(1, 0, 0), 10)).toBeNull();
  });
});
