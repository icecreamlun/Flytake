/**
 * Picking without a BVH: ray vs. per-building AABBs, then exact triangle tests only for the
 * candidate buildings, nearest first (each building's triangles are a contiguous index range).
 */
import * as THREE from 'three';
import type { CityGeometry } from './geometry';
import type { BuildingStateStore } from './state';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _box = new THREE.Box3();
const _p = new THREE.Vector3();

function hitRange(ray: THREE.Ray, geo: THREE.BufferGeometry, start: number, count: number, best: number): number {
  const pos = geo.attributes.position.array as Float32Array;
  const idx = geo.index!.array as Uint32Array;
  for (let k = start; k < start + count; k += 3) {
    const ia = idx[k] * 3;
    const ib = idx[k + 1] * 3;
    const ic = idx[k + 2] * 3;
    _a.set(pos[ia], pos[ia + 1], pos[ia + 2]);
    _b.set(pos[ib], pos[ib + 1], pos[ib + 2]);
    _c.set(pos[ic], pos[ic + 1], pos[ic + 2]);
    if (ray.intersectTriangle(_a, _b, _c, true, _hit)) {
      const d = _hit.distanceTo(ray.origin);
      if (d < best) best = d;
    }
  }
  return best;
}

export function pickBuilding(worldRay: THREE.Ray, root: THREE.Object3D, geo: CityGeometry, state: BuildingStateStore): number {
  root.updateWorldMatrix(true, false);
  const ray = worldRay.clone().applyMatrix4(root.matrixWorld.clone().invert());
  const cands: [number, number][] = [];
  const b = geo.bounds;
  for (let i = 0; i < state.count; i++) {
    if (state.isHidden(i)) continue;
    const o = i * 6;
    const crush = state.crush(i);
    const top = b[o + 1] + (b[o + 4] - b[o + 1]) * (1 - crush);
    _box.min.set(b[o], b[o + 1], b[o + 2]);
    _box.max.set(b[o + 3], Math.max(top, b[o + 1] + 1), b[o + 5]);
    if (!ray.intersectBox(_box, _p)) continue;
    cands.push([i, _p.distanceTo(ray.origin)]);
  }
  cands.sort((x, y) => x[1] - y[1]);
  let best = Infinity;
  let bestI = -1;
  for (const [i, tEnter] of cands) {
    if (tEnter > best) break;
    const r = i * 5;
    const walls = geo.ranges[r] === 0 ? geo.wallsCore : geo.wallsContext;
    let d = hitRange(ray, walls, geo.ranges[r + 1], geo.ranges[r + 2], Infinity);
    d = hitRange(ray, geo.props, geo.ranges[r + 3], geo.ranges[r + 4], d);
    if (d < best) {
      best = d;
      bestI = i;
    }
  }
  return bestI;
}
