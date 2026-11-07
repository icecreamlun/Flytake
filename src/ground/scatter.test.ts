import { describe, expect, it } from 'vitest';
import { clump, enuOf, tiltYawQuat } from './scatter';

function rotate(q: Float32Array, v: [number, number, number]): [number, number, number] {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  // v + 2 * cross(q.xyz, cross(q.xyz, v) + w * v)
  const cx = y * v[2] - z * v[1] + w * v[0];
  const cy = z * v[0] - x * v[2] + w * v[1];
  const cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
}

describe('ground scatter helpers', () => {
  it('tilts +z fully onto the ground normal (any yaw)', () => {
    const n: [number, number, number] = [0.3, -0.4, Math.sqrt(1 - 0.25)];
    const q = new Float32Array(4);
    tiltYawQuat(n[0], n[1], n[2], 1, 1.234, q, 0);
    expect(Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!)).toBeCloseTo(1, 5);
    const up = rotate(q, [0, 0, 1]);
    expect(up[0]).toBeCloseTo(n[0], 4);
    expect(up[1]).toBeCloseTo(n[1], 4);
    expect(up[2]).toBeCloseTo(n[2], 4);
  });

  it('keeps +z with no tilt and yaws about it', () => {
    const q = new Float32Array(4);
    tiltYawQuat(0.5, 0, Math.sqrt(0.75), 0, Math.PI / 2, q, 0);
    const up = rotate(q, [0, 0, 1]);
    expect(up[2]).toBeCloseTo(1, 5);
    const x = rotate(q, [1, 0, 0]);
    expect(x[1]).toBeCloseTo(1, 5);
  });

  it('places grid points on the curved ENU surface', () => {
    const out = new Float32Array(3);
    enuOf(4000, 0, 0, out, 0);
    expect(out[2]).toBeCloseTo(-(4000 * 4000) / (2 * 6_371_000), 3); // -1.26 m
    enuOf(4000, 0, 1000, out, 0);
    expect(out[0]).toBeCloseTo(4000 + (1000 * 4000) / 6_371_000, 2); // local vertical leans out
  });

  it('clump noise is deterministic and in 0..1', () => {
    for (let k = 0; k < 200; k++) {
      const v = clump(k * 3.7 - 400, k * 1.3, 7, 1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(clump(k * 3.7 - 400, k * 1.3, 7, 1)).toBe(v);
    }
  });
});
