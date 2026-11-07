import { describe, expect, it } from 'vitest';
import {
  bearing,
  createDroneState,
  distanceFromHome,
  heightAboveGround,
  heightAboveHome,
  neutralSticks,
  probeDirection,
  resetToHome,
  stepDrone,
  toggleTakeoffLanding,
  type DroneEnv,
  type DroneState,
  type Sticks,
} from './physics';
import { DRONE, MODES } from './specs';

const HOME = { lat: 38.946599, lon: -120.098107, height: 2053.7 };
const DT = 1 / 60;

/** Flat ground at home height; optional wall `wallAhead` metres north of home. */
function run(s: DroneState, sticks: Partial<Sticks>, seconds: number, wallNorth: number | null = null): void {
  const st = { ...neutralSticks(), ...sticks };
  for (let t = 0; t < seconds; t += DT) {
    const env: DroneEnv = { groundHeight: HOME.height, obstacleDistance: null };
    const dir = probeDirection(s, st);
    if (wallNorth != null && dir != null && dir.north > 0.5) {
      const north = northOfHome(s);
      env.obstacleDistance = Math.max(0, (wallNorth - north) / dir.north);
    }
    stepDrone(s, st, DT, env);
  }
}

const northOfHome = (s: DroneState): number => (s.lat - HOME.lat) * 111_000;
const eastOfHome = (s: DroneState): number => (s.lon - HOME.lon) * 111_000 * Math.cos((HOME.lat * Math.PI) / 180);
const speed = (s: DroneState): number => Math.hypot(s.vEast, s.vNorth);

function airborne(heading = 0, mode: DroneState['mode'] = 'normal'): DroneState {
  const s = createDroneState(HOME, heading, mode);
  toggleTakeoffLanding(s);
  run(s, {}, 3);
  return s;
}

describe('drone physics', () => {
  it('stays put on the ground with neutral sticks', () => {
    const s = createDroneState(HOME, 0);
    run(s, { pitch: 1, yaw: 1 }, 2);
    expect(s.status).toBe('grounded');
    expect(heightAboveGround(s)).toBeCloseTo(DRONE.restHeight, 6);
    expect(distanceFromHome(s)).toBe(0);
  });

  it('auto take-off climbs to the hover height and holds it', () => {
    const s = createDroneState(HOME, 0);
    toggleTakeoffLanding(s);
    run(s, {}, 4);
    expect(s.status).toBe('flying');
    const h = heightAboveGround(s);
    expect(h).toBeGreaterThan(DRONE.takeoffHoverHeight - 0.05);
    expect(h).toBeLessThan(DRONE.takeoffHoverHeight + 0.6);
    expect(Math.abs(s.vUp)).toBeLessThan(0.05);
  });

  it('throttle up on the ground also takes off', () => {
    const s = createDroneState(HOME, 0);
    run(s, { throttle: 1 }, 2);
    expect(s.status === 'takeoff' || s.status === 'flying').toBe(true);
    expect(heightAboveGround(s)).toBeGreaterThan(1);
  });

  it('forward stick at heading 0 flies north at the mode top speed', () => {
    const s = airborne(0);
    run(s, { pitch: 1 }, 4);
    expect(speed(s)).toBeGreaterThan(MODES.normal.maxHorizontal * 0.97);
    expect(speed(s)).toBeLessThanOrEqual(MODES.normal.maxHorizontal + 1e-6);
    expect(northOfHome(s)).toBeGreaterThan(30);
    expect(Math.abs(eastOfHome(s))).toBeLessThan(0.5);
  });

  it('forward at heading 90 flies east; right stick at heading 0 flies east', () => {
    const a = airborne(90);
    run(a, { pitch: 1 }, 3);
    expect(eastOfHome(a)).toBeGreaterThan(20);
    expect(Math.abs(northOfHome(a))).toBeLessThan(0.5);

    const b = airborne(0);
    run(b, { roll: 1 }, 3);
    expect(eastOfHome(b)).toBeGreaterThan(20);
    expect(Math.abs(northOfHome(b))).toBeLessThan(0.5);
  });

  it('yaw stick turns clockwise at the mode yaw rate', () => {
    const s = airborne(0);
    run(s, { yaw: 1 }, 1);
    expect(s.yawRate).toBeGreaterThan(MODES.normal.maxYawRate * 0.95);
    expect(s.heading).toBeGreaterThan(40);
    expect(s.heading).toBeLessThan(90);
  });

  it('flight modes cap the speed (Cine is slow)', () => {
    const s = airborne(0, 'cine');
    run(s, { pitch: 1 }, 8);
    expect(speed(s)).toBeLessThanOrEqual(MODES.cine.maxHorizontal + 1e-6);
    expect(speed(s)).toBeGreaterThan(MODES.cine.maxHorizontal * 0.95);
  });

  it('respects the 120 m height limit above the take-off point', () => {
    const s = airborne(0);
    run(s, { throttle: 1 }, 60);
    expect(heightAboveHome(s)).toBeLessThanOrEqual(DRONE.heightLimit + 0.2);
    expect(heightAboveHome(s)).toBeGreaterThan(DRONE.heightLimit - 1.5);
    expect(s.warnings.heightLimit).toBe(true);
  });

  it('never goes below the ground and slows the descent near it', () => {
    const s = airborne(0);
    run(s, { throttle: 1 }, 3);
    let minAgl = Infinity;
    let fastestNearGround = 0;
    const st = { ...neutralSticks(), throttle: -0.6 };
    for (let t = 0; t < 20; t += DT) {
      stepDrone(s, st, DT, { groundHeight: HOME.height, obstacleDistance: null });
      const agl = heightAboveGround(s);
      minAgl = Math.min(minAgl, agl);
      if (agl < 1) fastestNearGround = Math.max(fastestNearGround, -s.vUp);
    }
    expect(minAgl).toBeGreaterThanOrEqual(DRONE.restHeight - 1e-9);
    expect(fastestNearGround).toBeLessThan(1);
  });

  it('auto landing touches down and stops the motors', () => {
    const s = airborne(0);
    run(s, { throttle: 1 }, 3);
    toggleTakeoffLanding(s);
    expect(s.status).toBe('landing');
    run(s, {}, 30);
    expect(s.status).toBe('grounded');
    expect(heightAboveGround(s)).toBeCloseTo(DRONE.restHeight, 6);
  });

  it('obstacle sensing brakes before a wall in Normal mode', () => {
    const s = airborne(0, 'normal');
    run(s, { pitch: 1 }, 15, 60);
    expect(s.status).toBe('flying');
    expect(northOfHome(s)).toBeLessThan(60 - 1);
    expect(northOfHome(s)).toBeGreaterThan(40);
    expect(speed(s)).toBeLessThan(0.5);
    expect(s.warnings.obstacle).toBe(true);
  });

  it('Sport mode has no obstacle sensing: flying into a wall crashes', () => {
    const s = airborne(0, 'sport');
    run(s, { pitch: 1 }, 15, 60);
    expect(s.status).toBe('crashed');
    expect(northOfHome(s)).toBeLessThanOrEqual(60 + 0.01);
  });

  it('bearing and distance helpers agree with a known offset', () => {
    const to = { lat: HOME.lat + 0.001, lon: HOME.lon, height: HOME.height };
    expect(bearing(HOME, to)).toBeCloseTo(0, 6);
    const east = { lat: HOME.lat, lon: HOME.lon + 0.001, height: HOME.height };
    expect(bearing(HOME, east)).toBeCloseTo(90, 1);
    const s = createDroneState(HOME, 0);
    s.lat += 0.001;
    expect(distanceFromHome(s)).toBeCloseTo(111.0, 0);
  });
  it('the gimbal dial tilts the camera at the mode rate and holds the angle when released', () => {
    const s = createDroneState(HOME, 0, 'normal');
    expect(s.gimbalPitch).toBe(DRONE.gimbalPitch);
    run(s, { gimbal: -1 }, 1);
    expect(s.gimbalPitch).toBeCloseTo(DRONE.gimbalPitch - MODES.normal.gimbalPitchRate, 0);
    const held = s.gimbalPitch;
    run(s, {}, 2);
    expect(s.gimbalPitch).toBe(held);
    const cine = createDroneState(HOME, 0, 'cine');
    run(cine, { gimbal: 1 }, 1);
    expect(cine.gimbalPitch).toBeCloseTo(DRONE.gimbalPitch + MODES.cine.gimbalPitchRate, 0);
  });

  it('the gimbal stops at its range and resets with the drone', () => {
    const s = airborne(0, 'sport');
    run(s, { gimbal: -1 }, 10);
    expect(s.gimbalPitch).toBe(DRONE.gimbalMinPitch);
    run(s, { gimbal: 1 }, 10);
    expect(s.gimbalPitch).toBe(DRONE.gimbalMaxPitch);
    s.status = 'crashed';
    run(s, { gimbal: -1 }, 1);
    expect(s.gimbalPitch).toBe(DRONE.gimbalMaxPitch);
    resetToHome(s);
    expect(s.gimbalPitch).toBe(DRONE.gimbalPitch);
  });
});
