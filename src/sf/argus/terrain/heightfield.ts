import * as THREE from 'three';
import type { Heightfield, TerrainMeta } from '../contracts';

export function createHeightfield(meta: TerrainMeta, data: Float32Array): Heightfield {
  const { minX, minZ, cellSize, cols, rows } = meta;

  const sample = (c: number, r: number) => {
    c = c < 0 ? 0 : c >= cols ? cols - 1 : c;
    r = r < 0 ? 0 : r >= rows ? rows - 1 : r;
    return data[r * cols + c];
  };

  const heightAt = (x: number, z: number) => {
    const fc = (x - minX) / cellSize;
    const fr = (z - minZ) / cellSize;
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const tx = fc - c0;
    const tz = fr - r0;
    const h00 = sample(c0, r0);
    const h10 = sample(c0 + 1, r0);
    const h01 = sample(c0, r0 + 1);
    const h11 = sample(c0 + 1, r0 + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  };

  const normalAt = (x: number, z: number, target = new THREE.Vector3()) => {
    const e = cellSize;
    const dx = heightAt(x + e, z) - heightAt(x - e, z);
    const dz = heightAt(x, z + e) - heightAt(x, z - e);
    return target.set(-dx, 2 * e, -dz).normalize();
  };

  return { meta, data, heightAt, normalAt };
}

/** Load public/data/terrain.json + terrain.bin. */
export async function loadHeightfield(base = '/sf/data'): Promise<Heightfield> {
  const meta: TerrainMeta = await (await fetch(`${base}/terrain.json`)).json();
  const buf = await (await fetch(`${base}/terrain.bin`)).arrayBuffer();
  return createHeightfield(meta, new Float32Array(buf));
}
