/**
 * Drone flight model: pure functions, no three.js scene access (unit-tested).
 *
 * The model is a velocity-commanded multirotor, which is how GPS camera drones actually fly:
 * the sticks set a target velocity / climb rate / yaw rate, and the flight controller eases
 * toward it with mode-dependent time constants. Position is geodetic (lat/lon/ellipsoidal
 * height), velocity is local East-North-Up, so it works anywhere on the globe.
 *
 * Stick conventions (Mode 2 remote): throttle + = climb, yaw + = turn right (clockwise),
 * pitch + = forward, roll + = right. All sticks are in [-1, 1].
 */
import { WGS84_A, WGS84_E2, wrap360, type Geodetic } from '../geo/wgs84';
import { DRONE, MODES, type FlightMode } from './specs';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export type DroneStatus = 'grounded' | 'takeoff' | 'flying' | 'landing' | 'crashed';

export interface Sticks {
  throttle: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export const neutralSticks = (): Sticks => ({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });

export interface DroneWarnings {
  heightLimit: boolean;
  obstacle: boolean;
  lowBattery: boolean;
}

export interface DroneState extends Geodetic {
  /** airframe heading, degrees clockwise from true north */
  heading: number;
  vEast: number;
  vNorth: number;
  vUp: number;
  /** deg/s, positive = clockwise */
  yawRate: number;
  status: DroneStatus;
  mode: FlightMode;
  /** take-off point (ground level, ellipsoidal height) */
  home: Geodetic;
  /** last known ground / water / canopy height under the drone (ellipsoidal) */
  groundHeight: number;
  /** 0..1 */
  battery: number;
  airborneSeconds: number;
  crashSeconds: number;
  warnings: DroneWarnings;
}

/** What the scene measured this frame (null = no hit / tiles not loaded yet). */
export interface DroneEnv {
  /** ellipsoidal height of the first surface straight below the drone */
  groundHeight: number | null;
  /** distance to the first surface along `probeDirection()` (horizontal), metres */
  obstacleDistance: number | null;
}

export interface HorizontalDir {
  east: number;
  north: number;
}

export interface Command {
  east: number;
  north: number;
  up: number;
  yawRate: number;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export function createDroneState(home: Geodetic, heading: number, mode: FlightMode = 'normal'): DroneState {
  return {
    lat: home.lat,
    lon: home.lon,
    height: home.height + DRONE.restHeight,
    heading: wrap360(heading),
    vEast: 0,
    vNorth: 0,
    vUp: 0,
    yawRate: 0,
    status: 'grounded',
    mode,
    home: { ...home },
    groundHeight: home.height,
    battery: 1,
    airborneSeconds: 0,
    crashSeconds: 0,
    warnings: { heightLimit: false, obstacle: false, lowBattery: false },
  };
}

/** Stick expo: linear blend with a cubic for finer control around centre. */
export function expo(x: number, e: number): number {
  const c = clamp(Number.isFinite(x) ? x : 0, -1, 1);
  return c * (1 - e) + c * c * c * e;
}

/** Target ENU velocity (m/s) and yaw rate (deg/s) the sticks ask for, before any limits. */
export function commanded(state: DroneState, sticks: Sticks, out: Command = { east: 0, north: 0, up: 0, yawRate: 0 }): Command {
  const m = MODES[state.mode];
  let fwd = expo(sticks.pitch, m.expo) * m.maxHorizontal;
  let right = expo(sticks.roll, m.expo) * m.maxHorizontal;
  const mag = Math.hypot(fwd, right);
  if (mag > m.maxHorizontal) {
    fwd *= m.maxHorizontal / mag;
    right *= m.maxHorizontal / mag;
  }
  const h = state.heading * DEG;
  const s = Math.sin(h);
  const c = Math.cos(h);
  out.east = fwd * s + right * c;
  out.north = fwd * c - right * s;
  const t = expo(sticks.throttle, m.expo * 0.5);
  out.up = t >= 0 ? t * m.maxAscent : t * m.maxDescent;
  out.yawRate = expo(sticks.yaw, m.expo) * m.maxYawRate;
  return out;
}

/**
 * Horizontal direction the forward obstacle sensor should look this frame: where the pilot is
 * steering, or where the drone is still coasting. Null when (nearly) stationary.
 */
export function probeDirection(state: DroneState, sticks: Sticks): HorizontalDir | null {
  if (state.status !== 'flying' && state.status !== 'landing') return null;
  const cmd = commanded(state, sticks, _probeCmd);
  const cm = Math.hypot(cmd.east, cmd.north);
  if (cm > 0.15) return { east: cmd.east / cm, north: cmd.north / cm };
  const vm = Math.hypot(state.vEast, state.vNorth);
  if (vm > 0.3) return { east: state.vEast / vm, north: state.vNorth / vm };
  return null;
}
const _probeCmd: Command = { east: 0, north: 0, up: 0, yawRate: 0 };
const _cmd: Command = { east: 0, north: 0, up: 0, yawRate: 0 };

/** Grounded -> take off; airborne -> auto land; landing -> cancel (hover). */
export function toggleTakeoffLanding(state: DroneState): void {
  switch (state.status) {
    case 'grounded':
      if (state.battery > 0.05) state.status = 'takeoff';
      break;
    case 'takeoff':
    case 'flying':
      state.status = 'landing';
      break;
    case 'landing':
      state.status = 'flying';
      break;
    case 'crashed':
      break;
  }
}

/** Put the drone back on its take-off point, landed, motors off (keeps the flight mode). */
export function resetToHome(state: DroneState, heading = state.heading): void {
  Object.assign(state, createDroneState(state.home, heading, state.mode));
}

/** Height above the take-off point. */
export const heightAboveHome = (s: DroneState): number => s.height - s.home.height;
/** Height above whatever is directly below (ground, water or tree tops). */
export const heightAboveGround = (s: DroneState): number => s.height - s.groundHeight;

/** Horizontal distance from the take-off point, metres (local flat-earth, fine within km). */
export function distanceFromHome(s: DroneState): number {
  const n = (s.lat - s.home.lat) * DEG * meridianRadius(s.lat);
  const e = (s.lon - s.home.lon) * DEG * primeVerticalRadius(s.lat) * Math.cos(s.lat * DEG);
  return Math.hypot(n, e);
}

/** Bearing from `from` to `to`, degrees clockwise from north. */
export function bearing(from: Geodetic, to: Geodetic): number {
  const n = (to.lat - from.lat) * DEG * meridianRadius(from.lat);
  const e = (to.lon - from.lon) * DEG * primeVerticalRadius(from.lat) * Math.cos(from.lat * DEG);
  return wrap360(Math.atan2(e, n) * RAD);
}

function meridianRadius(latDeg: number): number {
  const s = Math.sin(latDeg * DEG);
  const w = 1 - WGS84_E2 * s * s;
  return (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w));
}

function primeVerticalRadius(latDeg: number): number {
  const s = Math.sin(latDeg * DEG);
  return WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
}

function integrate(s: DroneState, dt: number): void {
  s.lat += ((s.vNorth * dt) / (meridianRadius(s.lat) + s.height)) * RAD;
  s.lon += ((s.vEast * dt) / ((primeVerticalRadius(s.lat) + s.height) * Math.cos(s.lat * DEG))) * RAD;
  s.height += s.vUp * dt;
}

function clampToGround(s: DroneState): boolean {
  const floor = s.groundHeight + DRONE.restHeight;
  if (s.height >= floor) return false;
  s.height = floor;
  if (s.vUp < 0) s.vUp = 0;
  return true;
}

/**
 * Advance the drone by `dt` seconds. `env` must have been measured for this same state and
 * sticks (the obstacle distance along `probeDirection(state, sticks)`).
 */
export function stepDrone(s: DroneState, sticks: Sticks, dt: number, env: DroneEnv): void {
  if (!(dt > 0)) return;
  if (env.groundHeight != null && Number.isFinite(env.groundHeight)) s.groundHeight = env.groundHeight;
  const m = MODES[s.mode];
  const dir = probeDirection(s, sticks);
  s.warnings.heightLimit = false;
  s.warnings.obstacle = false;

  if (s.status === 'grounded') {
    s.vEast = s.vNorth = s.vUp = s.yawRate = 0;
    s.height = s.groundHeight + DRONE.restHeight;
    // Throttle up on the ground spins up and lifts off, as with the motors already armed.
    if (sticks.throttle > 0.6 && s.battery > 0.05) s.status = 'takeoff';
    return;
  }

  if (s.status === 'crashed') {
    s.crashSeconds += dt;
    const k = Math.exp(-dt * 3);
    s.vEast *= k;
    s.vNorth *= k;
    s.yawRate *= Math.exp(-dt * 2);
    s.vUp = Math.max(s.vUp - 9.81 * dt, -15);
    s.heading = wrap360(s.heading + s.yawRate * dt);
    integrate(s, dt);
    if (clampToGround(s)) {
      s.vEast = s.vNorth = 0;
    }
    return;
  }

  const agl = s.height - s.groundHeight;
  const cmd = commanded(s, sticks, _cmd);
  let tE = cmd.east;
  let tN = cmd.north;
  let tU = cmd.up;
  let tYaw = cmd.yawRate;

  switch (s.status) {
    case 'takeoff':
      tE = 0;
      tN = 0;
      tYaw = 0;
      tU = DRONE.takeoffSpeed;
      if (agl >= DRONE.takeoffHoverHeight) {
        s.status = 'flying';
        tU = 0;
      }
      break;
    case 'landing':
      if (sticks.throttle > 0.5) {
        s.status = 'flying';
        break;
      }
      tU = -clamp(agl * 0.7, DRONE.landingMinSpeed, DRONE.landingMaxSpeed);
      if (agl <= DRONE.restHeight + 0.03) {
        s.status = 'grounded';
        s.vEast = s.vNorth = s.vUp = s.yawRate = 0;
        s.height = s.groundHeight + DRONE.restHeight;
        return;
      }
      break;
    case 'flying':
      if (s.battery <= 0) s.status = 'landing';
      else if (agl < 0.6 && sticks.throttle < -0.7) s.status = 'landing';
      break;
  }

  // Height limit, relative to the take-off point; slows the climb over the last metres.
  const roomUp = DRONE.heightLimit - (s.height - s.home.height);
  if (tU > 0 && tU > roomUp * 1.5) {
    tU = Math.max(0, roomUp * 1.5);
    if (roomUp < 1.5) s.warnings.heightLimit = true;
  }
  // Landing protection: never descend fast into the ground.
  if (s.status === 'flying' && tU < 0 && agl < DRONE.groundSlowZone) tU = Math.max(tU, -Math.max(0.4, agl * 0.8));

  // Forward obstacle sensing: cap the speed toward the obstacle so the drone can still stop.
  const d = dir != null ? env.obstacleDistance : null;
  if (dir != null && d != null && m.obstacleAvoidance) {
    const allowed = Math.sqrt(2 * DRONE.brakeDecel * Math.max(0, d - DRONE.obstacleMargin));
    const tc = tE * dir.east + tN * dir.north;
    if (tc > allowed) {
      tE -= (tc - allowed) * dir.east;
      tN -= (tc - allowed) * dir.north;
      s.warnings.obstacle = true;
    }
    const vc = s.vEast * dir.east + s.vNorth * dir.north;
    if (vc > allowed) {
      const cut = Math.min(vc - allowed, DRONE.brakeDecel * 2 * dt);
      s.vEast -= cut * dir.east;
      s.vNorth -= cut * dir.north;
      s.warnings.obstacle = true;
    }
  }

  // Ease toward the targets (accelerate and brake with different time constants).
  const tauH = Math.hypot(tE, tN) > Math.hypot(s.vEast, s.vNorth) ? m.accelTau : m.brakeTau;
  const kH = 1 - Math.exp(-dt / tauH);
  s.vEast += (tE - s.vEast) * kH;
  s.vNorth += (tN - s.vNorth) * kH;
  s.vUp += (tU - s.vUp) * (1 - Math.exp(-dt / m.verticalTau));
  s.yawRate += (tYaw - s.yawRate) * (1 - Math.exp(-dt / m.yawTau));

  // Contact with the obstacle: bump (stop) or, too fast with sensing off, crash.
  if (dir != null && d != null) {
    const vc = s.vEast * dir.east + s.vNorth * dir.north;
    if (vc > 0 && d - vc * dt < DRONE.contactDistance) {
      if (!m.obstacleAvoidance && vc > DRONE.crashSpeed) {
        s.status = 'crashed';
        s.crashSeconds = 0;
        s.yawRate = vc * 12 * (s.yawRate >= 0 ? 1 : -1);
        s.vEast = -s.vEast * 0.15;
        s.vNorth = -s.vNorth * 0.15;
        s.vUp = 0;
        return;
      }
      s.vEast -= vc * dir.east;
      s.vNorth -= vc * dir.north;
      s.warnings.obstacle = true;
    }
  }

  // Landing protection on the actual sink rate too (the target alone lags by verticalTau).
  if (s.status === 'flying' && agl < DRONE.groundSlowZone) s.vUp = Math.max(s.vUp, -Math.max(0.4, agl * 0.7));

  s.heading = wrap360(s.heading + s.yawRate * dt);
  integrate(s, dt);
  clampToGround(s);
  // Hard ceiling (the eased climb can overshoot the soft limit by a few decimetres).
  const ceiling = s.home.height + DRONE.heightLimit;
  if (s.height > ceiling) {
    s.height = ceiling;
    if (s.vUp > 0) s.vUp = 0;
    s.warnings.heightLimit = true;
  }

  s.airborneSeconds += dt;
  const effort =
    1 + 0.25 * Math.min(1, Math.hypot(s.vEast, s.vNorth) / m.maxHorizontal) + 0.25 * Math.max(0, s.vUp) / m.maxAscent;
  s.battery = Math.max(0, s.battery - (dt * effort) / DRONE.batterySeconds);
  s.warnings.lowBattery = s.battery < 0.2;
}
