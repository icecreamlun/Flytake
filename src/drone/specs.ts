/**
 * Drone performance envelope, modelled on a DJI Mini 4 Pro class camera drone.
 * Speeds in m/s, yaw rates in deg/s, time constants (tau) in seconds: the drone reaches ~63%
 * of a commanded change after one tau, which is what gives the stick its weight.
 */
export type FlightMode = 'cine' | 'normal' | 'sport';

export interface ModeSpec {
  label: string;
  /** one-letter badge, as on the DJI remote's C / N / S switch */
  short: string;
  maxHorizontal: number;
  maxAscent: number;
  maxDescent: number;
  maxYawRate: number;
  /** speeding up */
  accelTau: number;
  /** slowing down (sticks released) */
  brakeTau: number;
  verticalTau: number;
  yawTau: number;
  /** how far the stabilised camera lags the airframe's yaw (smooth pans) */
  gimbalYawTau: number;
  /** camera tilt speed at full gimbal-dial deflection, deg/s */
  gimbalPitchRate: number;
  /** stick expo: 0 = linear, 1 = fully cubic (fine control around centre) */
  expo: number;
  /** forward obstacle sensing brakes the drone (off in Sport, like the real thing) */
  obstacleAvoidance: boolean;
}

export const MODES: Record<FlightMode, ModeSpec> = {
  cine: {
    label: 'Cine',
    short: 'C',
    maxHorizontal: 5,
    maxAscent: 2,
    maxDescent: 1.5,
    maxYawRate: 30,
    accelTau: 1.1,
    brakeTau: 0.9,
    verticalTau: 0.6,
    yawTau: 0.45,
    gimbalYawTau: 0.3,
    gimbalPitchRate: 15,
    expo: 0.35,
    obstacleAvoidance: true,
  },
  normal: {
    label: 'Normal',
    short: 'N',
    maxHorizontal: 12,
    maxAscent: 5,
    maxDescent: 4,
    maxYawRate: 75,
    accelTau: 0.6,
    brakeTau: 0.45,
    verticalTau: 0.35,
    yawTau: 0.2,
    gimbalYawTau: 0.1,
    gimbalPitchRate: 30,
    expo: 0.25,
    obstacleAvoidance: true,
  },
  sport: {
    label: 'Sport',
    short: 'S',
    maxHorizontal: 16,
    maxAscent: 6,
    maxDescent: 5,
    maxYawRate: 120,
    accelTau: 0.4,
    brakeTau: 0.32,
    verticalTau: 0.25,
    yawTau: 0.12,
    gimbalYawTau: 0.05,
    gimbalPitchRate: 45,
    expo: 0.15,
    obstacleAvoidance: false,
  },
};

export const MODE_ORDER: readonly FlightMode[] = ['cine', 'normal', 'sport'];

export const DRONE = {
  /** max height above the take-off point (DJI default; FAA limit is 400 ft AGL) */
  heightLimit: 120,
  /** auto take-off climbs to this height above the ground and hovers */
  takeoffHoverHeight: 1.2,
  takeoffSpeed: 1.5,
  /** camera height above the ground while the drone sits on its legs */
  restHeight: 0.18,
  landingMaxSpeed: 3,
  landingMinSpeed: 0.5,
  /** below this height above ground, descent is slowed (landing protection) */
  groundSlowZone: 3,
  /** deceleration the obstacle brake is allowed to plan with, m/s^2 */
  brakeDecel: 6,
  /** distance the obstacle brake tries to keep, m */
  obstacleMargin: 2.5,
  /** contact distance: closer than this counts as touching the obstacle, m */
  contactDistance: 0.35,
  /** hitting something faster than this (with avoidance off) is a crash, m/s */
  crashSpeed: 3,
  /** hover endurance at 100% battery, s (Mini 4 Pro: ~34 min) */
  batterySeconds: 34 * 60,
  /** camera tilt at power-on / reset, degrees (0 = level, negative = down) */
  gimbalPitch: -12,
  /** controllable tilt range (Mini 4 Pro: -90 to +60), degrees */
  gimbalMinPitch: -90,
  gimbalMaxPitch: 60,
  /** vertical field of view, degrees (~78 deg horizontal at 16:9) */
  fov: 48,
} as const;
