import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DRONE } from '../drone/specs';
import { CLOCK_TOWER, FLIGHT_KEYS, FLIGHT_SECONDS, PREVIEW_TAKEOFF, flightPolyline, sampleFlight } from './previewRoute';

describe('Ferry Building flight plan', () => {
  const { points, distance, times } = flightPolyline();

  it('takes off from Ferry Plaza and lasts about a minute', () => {
    expect(FLIGHT_SECONDS).toBe(60);
    const p = new Vector3();
    sampleFlight(0, p, new Vector3());
    expect(Math.hypot(p.x - PREVIEW_TAKEOFF.x, p.z - PREVIEW_TAKEOFF.z)).toBeLessThan(1);
    expect(p.y - PREVIEW_TAKEOFF.y).toBeLessThan(1);
    expect(FLIGHT_KEYS[0]!.t).toBe(0);
  });

  it('stays under the 120 m height limit and above the plaza', () => {
    for (const p of points) {
      expect(p.y - PREVIEW_TAKEOFF.y).toBeLessThanOrEqual(DRONE.heightLimit);
      expect(p.y).toBeGreaterThan(PREVIEW_TAKEOFF.y);
    }
  });

  it('flies at drone-like speeds, smoothly', () => {
    let maxSpeed = 0;
    for (let i = 1; i < points.length; i++) maxSpeed = Math.max(maxSpeed, (distance[i]! - distance[i - 1]!) / (times[i]! - times[i - 1]!));
    expect(maxSpeed).toBeLessThan(25);
    expect(distance[distance.length - 1]!).toBeGreaterThan(800);
  });

  it('keeps clear of the clock tower (75 m tall)', () => {
    for (const p of points) {
      const horizontal = Math.hypot(p.x - CLOCK_TOWER.x, p.z - CLOCK_TOWER.z);
      if (p.y < 85) expect(horizontal).toBeGreaterThan(40);
    }
  });
});
