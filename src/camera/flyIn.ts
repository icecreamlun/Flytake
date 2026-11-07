/**
 * Flytake: cinematic "orbit to Emerald Bay" fly-in camera.
 *
 * FRAME
 *   All positions are WGS84 ECEF, metres, right-handed:
 *     +X -> (lat 0, lon 0), +Y -> (lat 0, lon 90E), +Z -> north pole.
 *   This is the native frame of 3d-tiles-renderer / Google Photorealistic 3D Tiles
 *   when `tiles.group` has an identity transform.
 *   Quaternions use the three.js camera convention: the camera looks down its local -Z,
 *   local +Y is screen-up, local +X is screen-right.
 *   If the scene is Y-up (`tiles.group.rotation.x = -Math.PI / 2`), pass every sample
 *   through `toYUp()` (position' = Rx(-pi/2) * p, quaternion' = qRx(-pi/2) * q) and give the
 *   atmosphere `worldToECEFMatrix = YUP_TO_ECEF`.
 *
 * MOTION MODEL (pivot / orbit camera)
 *   The camera always looks at a pivot point. The pivot slides along a great circle from the
 *   start ground point to the target, the camera-to-pivot range shrinks in log space, and
 *   heading/pitch/roll are plain scalars in the pivot's ENU frame. Heading is never derived
 *   from a look-at vector, so the straight-down start has no heading singularity: at pitch -90
 *   the heading just says which compass direction is screen-up.
 *   The ENU frame is the local one at both ends. In between it is parallel-transported along
 *   the great circle (rotated about the great circle's axis), so even a path over a pole
 *   cannot whip the camera round.
 *   In the final ~45% the pivot is pushed forward along the final horizontal heading
 *   ("dolly"). The push ends at exactly `driftSpeed` m/s, and `drift()` continues from there,
 *   so the landing flows into a slow forward glide instead of stopping dead.
 *
 * Only three.js math types are used: Vector3, Quaternion, Matrix4.
 */
import { Quaternion, Vector3 } from 'three';
import {
  EARTH_MEAN_RADIUS,
  ECEF_TO_YUP,
  type Geodetic,
  type LocalFrame,
  ecefToGeodetic,
  enuVectors,
  geodeticToEcef,
  headingPitchRollFromQuaternionInFrame,
  nVectorToEcef,
  quaternionFromHeadingPitchRoll,
  quaternionFromHeadingPitchRollInFrame,
  rayToEllipsoid,
  wrap180,
} from '../geo/wgs84';
import { TAHOE } from '../geo/locations';

// Re-exported so existing callers (and the tests) can keep importing everything from here.
export * from '../geo/wgs84';
export { TAHOE } from '../geo/locations';

export interface GeoPose extends Geodetic {
  /** degrees clockwise from true north (0 = N, 90 = E) */
  heading: number;
  /** degrees, 0 = level, -90 = straight down (nadir), +90 = straight up */
  pitch: number;
  /** degrees, positive = image rotates clockwise (right side dips). Default 0. */
  roll?: number;
  /** vertical field of view, degrees (three.js PerspectiveCamera.fov) */
  fov: number;
}

export interface CameraSample {
  /** ECEF metres */
  position: Vector3;
  /** ECEF orientation, three.js camera convention */
  quaternion: Quaternion;
  /** vertical FOV, degrees */
  fov: number;
}


export interface FlyInOptions {
  /** Flight duration in seconds; only used to convert speeds (default 14). */
  duration?: number;
  /** Ellipsoidal height of the surface the pivot lies on (default: Lake Tahoe surface). */
  pivotHeight?: number;
  /** Normalised time at which the great-circle pivot travel is complete (default 0.55). */
  travelEnd?: number;
  /** Window [t0, t1] for the heading change (default [0.08, 0.8]). */
  headingWindow?: [number, number];
  /** Normalised time at which pitch starts tilting away from the start pitch (default 0.4). Tilt always ends at t = 1. */
  tiltStart?: number;
  /** Window [t0, t1] for the FOV change (default [0.45, 1]). */
  fovWindow?: [number, number];
  /** Normalised time at which the final forward dolly starts (default 0.55). */
  dollyStart?: number;
  /** Distance of the final forward dolly in metres (default 220). */
  dollyDistance?: number;
  /** Forward speed at arrival in m/s; drift() starts at exactly this speed (default 2.5). */
  driftSpeed?: number;
  /** Speed the drift settles towards after arrival, m/s (default 0.4; 0 = coast to a stop). */
  driftFloorSpeed?: number;
  /** Exponential time constant (s) of the drift slowing from driftSpeed to driftFloorSpeed (default 30). */
  driftTimeConstant?: number;
}

export interface Telemetry extends Geodetic {
  /** metres above `pivotHeight` (the lake surface by default) */
  heightAboveLake: number;
  /** camera speed, m/s */
  speed: number;
  /** vertical speed, m/s (negative = descending) */
  verticalSpeed: number;
}

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number): number => clamp(x, 0, 1);

/** Ken Perlin's smootherstep: C2, with zero velocity and acceleration at both ends. */
export function smootherstep(x: number): number {
  const s = clamp01(x);
  return s * s * s * (s * (s * 6 - 15) + 10);
}

/** smootherstep remapped to the window [a, b]. */
export function ramp(t: number, a: number, b: number): number {
  return b <= a ? (t >= b ? 1 : 0) : smootherstep((t - a) / (b - a));
}

/**
 * Quintic Hermite "landing" ease from 0 to 1. Zero velocity and acceleration at s = 0,
 * slope `m` and zero acceleration at s = 1. With m = 0 it is plain smootherstep.
 * Monotonic for 0 <= m <= 2.5.
 */
export function landingEase(s: number, m: number): number {
  const x = clamp01(s);
  return smootherstep(x) + m * x * x * x * (-4 + x * (7 - 3 * x));
}


export function createSample(): CameraSample {
  return { position: new Vector3(), quaternion: new Quaternion(), fov: 50 };
}

/** Geodetic pose -> ECEF camera sample. */
export function poseToSample(pose: GeoPose, out: CameraSample = createSample()): CameraSample {
  geodeticToEcef(pose.lat, pose.lon, pose.height, out.position);
  quaternionFromHeadingPitchRoll(pose.lat, pose.lon, pose.heading, pose.pitch, pose.roll ?? 0, out.quaternion);
  out.fov = pose.fov;
  return out;
}
const Q_ECEF_TO_YUP = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

/** Convert an ECEF camera sample into a scene whose tiles group is rotated -PI/2 about X. */
export function toYUp(sample: CameraSample, out: CameraSample = createSample()): CameraSample {
  out.position.copy(sample.position).applyMatrix4(ECEF_TO_YUP);
  out.quaternion.copy(sample.quaternion).premultiply(Q_ECEF_TO_YUP);
  out.fov = sample.fov;
  return out;
}

// ---------------------------------------------------------------------------
// Clipping planes
// ---------------------------------------------------------------------------

export interface ClippingOptions {
  /**
   * true (default): renderer created with `logarithmicDepthBuffer: true` (takram's
   * AerialPerspectiveEffect supports it through USE_LOGDEPTHBUF / reverseLogDepth).
   * false: standard 24-bit perspective depth; far/near is capped at `maxRatio`.
   */
  logarithmicDepth?: boolean;
  /** Highest terrain (ellipsoidal m) that may show above the horizon. Default 4500 (Sierra Nevada). */
  maxTerrainHeight?: number;
  /** far/near cap for non-log depth (default 2e4). */
  maxRatio?: number;
}

/**
 * Dynamic near/far from altitude.
 *   far  = distance to the geometric horizon + distance at which the highest terrain can still
 *          appear above it: sqrt(h(2R+h)) + sqrt(H(2R+H)).
 *   near = 1% of the height above terrain (log depth), or 25% of it (regular depth), raised
 *          until far/near <= maxRatio.
 */
export function clippingPlanes(
  heightAboveTerrain: number,
  heightAboveEllipsoid: number,
  options: ClippingOptions = {},
): { near: number; far: number } {
  const R = EARTH_MEAN_RADIUS;
  const log = options.logarithmicDepth ?? true;
  const hMax = options.maxTerrainHeight ?? 4500;
  const agl = Math.max(0.5, Number.isFinite(heightAboveTerrain) ? heightAboveTerrain : 0.5);
  const h = Math.max(agl, Number.isFinite(heightAboveEllipsoid) ? heightAboveEllipsoid : agl);
  const far = Math.sqrt(h * (2 * R + h)) + Math.sqrt(hMax * (2 * R + hMax)) + 1000;
  if (log) {
    return { near: clamp(agl * 0.01, 0.1, 1e5), far };
  }
  const ratio = options.maxRatio ?? 2e4;
  return { near: Math.max(clamp(agl * 0.25, 0.5, 1e6), far / ratio), far };
}

// ---------------------------------------------------------------------------
// Fly-in path
// ---------------------------------------------------------------------------

const DEFAULTS: Required<FlyInOptions> = {
  duration: 14,
  pivotHeight: TAHOE.lakeEllipsoidHeight,
  travelEnd: 0.55,
  headingWindow: [0.08, 0.8],
  tiltStart: 0.4,
  fovWindow: [0.45, 1],
  dollyStart: 0.55,
  dollyDistance: 220,
  driftSpeed: 2.5,
  driftFloorSpeed: 0.4,
  driftTimeConstant: 30,
};

/**
 * Distance from the camera to its pivot: where the view ray meets the pivot surface; if it
 * passes the limb, the ray's closest approach to the Earth (continuous with the hit case at
 * grazing incidence); if it points away from the Earth, one altitude ahead.
 */
function pivotRange(pos: Vector3, fwd: Vector3, camHeight: number, pivotHeight: number): number {
  const hit = rayToEllipsoid(pos, fwd, pivotHeight);
  if (hit !== null && hit > 1) return hit;
  const closest = -pos.dot(fwd);
  if (closest > 1) return closest;
  return Math.max(1, camHeight - pivotHeight);
}

function validatePose(name: string, p: GeoPose): void {
  for (const k of ['lat', 'lon', 'height', 'heading', 'pitch', 'fov'] as const) {
    if (!Number.isFinite(p[k])) throw new RangeError(`${name}.${k} must be a finite number`);
  }
  if (p.roll !== undefined && !Number.isFinite(p.roll)) throw new RangeError(`${name}.roll must be a finite number`);
  if (Math.abs(p.lat) > 90) throw new RangeError(`${name}.lat out of range`);
  if (p.pitch < -90 || p.pitch > 90) throw new RangeError(`${name}.pitch must be within [-90, 90]`);
  if (p.fov <= 0 || p.fov >= 180) throw new RangeError(`${name}.fov must be within (0, 180)`);
}

const _f = new Vector3();
const _pivot = new Vector3();
const _rot = new Quaternion();
const _tf: LocalFrame = { east: new Vector3(), north: new Vector3(), up: new Vector3() };

export class FlyInPath {
  readonly duration: number;
  readonly start: Readonly<GeoPose>;
  readonly end: Readonly<GeoPose>;
  readonly options: Readonly<Required<FlyInOptions>>;
  readonly startPosition = new Vector3();
  readonly endPosition = new Vector3();
  readonly startQuaternion = new Quaternion();
  readonly endQuaternion = new Quaternion();
  /** Unit ECEF vector of the final forward dolly and of the post-arrival drift (level at the hero camera). */
  readonly driftDirection = new Vector3();
  /** Pivot (look-at) points of the start and end poses. */
  readonly startPivot = new Vector3();
  readonly endPivot = new Vector3();

  /** start-pivot ENU frame (transported along the great circle during the flight) */
  private readonly frame0: LocalFrame = { east: new Vector3(), north: new Vector3(), up: new Vector3() };
  /** n-vector (ellipsoid normal) of the pre-dolly end pivot */
  private readonly n1 = new Vector3();
  private readonly height0: number;
  private readonly height1: number;
  /** great-circle rotation axis and total angle */
  private readonly axis = new Vector3(0, 0, 1);
  private readonly omega: number;
  private readonly lnRange0: number;
  private readonly lnRange1: number;
  private readonly h0: number;
  private readonly dH: number;
  private readonly p0: number;
  private readonly dP: number;
  private readonly r0: number;
  private readonly dR: number;
  private readonly dollySlope: number;

  constructor(start: GeoPose, end: GeoPose, options: FlyInOptions = {}) {
    validatePose('start', start);
    validatePose('end', end);
    const o: Required<FlyInOptions> = { ...DEFAULTS, ...options };
    if (!(o.duration > 0)) throw new RangeError('duration must be > 0');
    if (!(o.travelEnd > 0 && o.travelEnd <= 1)) throw new RangeError('travelEnd must be in (0, 1]');
    if (!(o.tiltStart >= 0 && o.tiltStart < 1)) throw new RangeError('tiltStart must be in [0, 1)');
    if (!(o.dollyStart >= 0 && o.dollyStart < 1)) throw new RangeError('dollyStart must be in [0, 1)');
    if (o.driftSpeed < 0 || o.driftFloorSpeed < 0 || !(o.driftTimeConstant > 0)) throw new RangeError('invalid drift parameters');
    if (o.driftSpeed > 0 && !(o.dollyDistance > 0)) throw new RangeError('dollyDistance must be > 0 when driftSpeed > 0');
    this.duration = o.duration;
    this.options = o;
    this.start = { ...start };
    this.end = { ...end };

    geodeticToEcef(start.lat, start.lon, start.height, this.startPosition);
    geodeticToEcef(end.lat, end.lon, end.height, this.endPosition);
    quaternionFromHeadingPitchRoll(start.lat, start.lon, start.heading, start.pitch, start.roll ?? 0, this.startQuaternion);
    quaternionFromHeadingPitchRoll(end.lat, end.lon, end.heading, end.pitch, end.roll ?? 0, this.endQuaternion);

    // Pivots: where each view ray meets the pivot surface.
    const f0 = new Vector3(0, 0, -1).applyQuaternion(this.startQuaternion);
    const f1 = new Vector3(0, 0, -1).applyQuaternion(this.endQuaternion);
    const range0 = pivotRange(this.startPosition, f0, start.height, o.pivotHeight);
    const range1 = pivotRange(this.endPosition, f1, end.height, o.pivotHeight);
    this.startPivot.copy(this.startPosition).addScaledVector(f0, range0);
    this.endPivot.copy(this.endPosition).addScaledVector(f1, range1);
    this.lnRange0 = Math.log(range0);
    this.lnRange1 = Math.log(range1);

    // Dolly / drift direction: the final view direction projected on the hero camera's
    // horizontal plane, so the post-arrival drift is level flight.
    const e = new Vector3();
    const n = new Vector3();
    const u = new Vector3();
    enuVectors(end.lat, end.lon, e, n, u);
    this.driftDirection.copy(f1).addScaledVector(u, -f1.dot(u));
    if (this.driftDirection.lengthSq() < 1e-12) {
      // Final view is straight down/up: drift towards screen-up instead.
      this.driftDirection.set(0, 1, 0).applyQuaternion(this.endQuaternion);
      this.driftDirection.addScaledVector(u, -this.driftDirection.dot(u));
    }
    this.driftDirection.normalize();

    // The great-circle travel ends at the pre-dolly pivot; the dolly then pushes it to endPivot.
    const prePivot = this.endPivot.clone().addScaledVector(this.driftDirection, -o.dollyDistance);
    const g0 = ecefToGeodetic(this.startPivot);
    const g1 = ecefToGeodetic(prePivot);
    this.height0 = g0.height;
    this.height1 = g1.height;
    enuVectors(g0.lat, g0.lon, this.frame0.east, this.frame0.north, this.frame0.up);
    enuVectors(g1.lat, g1.lon, e, n, this.n1);

    // Great circle between the two n-vectors as a rotation (axis, omega).
    const cosOmega = clamp(this.frame0.up.dot(this.n1), -1, 1);
    this.omega = Math.acos(cosOmega);
    this.axis.copy(this.frame0.up).cross(this.n1);
    if (this.axis.lengthSq() < 1e-18) {
      // No travel, or (near-)antipodal: any axis perpendicular to the start normal works.
      this.axis.copy(this.frame0.north);
    }
    this.axis.normalize();

    // Orientation as heading/pitch/roll in the start frame and in the transported end frame
    // (both exact, so q(0) == start and q(1) == end).
    const a = headingPitchRollFromQuaternionInFrame(this.frame0, this.startQuaternion);
    const b = headingPitchRollFromQuaternionInFrame(this.transportedFrame(1, _tf), this.endQuaternion);
    this.h0 = a.heading;
    this.dH = wrap180(b.heading - a.heading);
    this.p0 = a.pitch;
    this.dP = b.pitch - a.pitch;
    this.r0 = a.roll;
    this.dR = wrap180(b.roll - a.roll);

    // Dolly end slope so the arrival speed equals driftSpeed (m/s).
    this.dollySlope = o.dollyDistance > 0 ? (o.driftSpeed * o.duration * (1 - o.dollyStart)) / o.dollyDistance : 0;
    if (this.dollySlope > 1.5) {
      throw new RangeError(
        `driftSpeed too high for dollyDistance (slope ${this.dollySlope.toFixed(2)} > 1.5); increase dollyDistance`,
      );
    }
  }

  /** Start-pivot ENU frame rotated `s` of the way along the great circle (s in [0, 1]). */
  private transportedFrame(s: number, out: LocalFrame): LocalFrame {
    _rot.setFromAxisAngle(this.axis, this.omega * s);
    out.east.copy(this.frame0.east).applyQuaternion(_rot);
    out.north.copy(this.frame0.north).applyQuaternion(_rot);
    out.up.copy(this.frame0.up).applyQuaternion(_rot);
    return out;
  }

  /** Pivot (look-at point, ECEF) at normalised time t. Also leaves the orientation frame in `frame`. */
  pivotAt(t: number, out = new Vector3(), frame: LocalFrame = { east: new Vector3(), north: new Vector3(), up: new Vector3() }): Vector3 {
    const o = this.options;
    const x = clamp01(Number.isFinite(t) ? t : 0);
    // 1. Pivot travel along the great circle, done by `travelEnd`.
    const s = ramp(x, 0, o.travelEnd);
    this.transportedFrame(s, frame);
    nVectorToEcef(s >= 1 ? this.n1 : frame.up, this.height0 + (this.height1 - this.height0) * s, out);
    // 2. Final forward dolly of the pivot (and so of the camera). Ends at driftSpeed.
    if (x > o.dollyStart) {
      const sDolly = landingEase((x - o.dollyStart) / (1 - o.dollyStart), this.dollySlope);
      out.addScaledVector(this.driftDirection, o.dollyDistance * sDolly);
    }
    return out;
  }

  /** Camera at normalised time t in [0, 1] (clamped). */
  sample(t: number, out: CameraSample = createSample()): CameraSample {
    const o = this.options;
    const x = clamp01(Number.isFinite(t) ? t : 0);

    // 1 + 2. Pivot: great-circle travel, then the final forward dolly.
    this.pivotAt(x, _pivot, _tf);

    // 3. Orientation: scalar heading/pitch/roll in the travelling pivot frame.
    const sHeading = ramp(x, o.headingWindow[0], o.headingWindow[1]);
    const sTilt = ramp(x, o.tiltStart, 1);
    quaternionFromHeadingPitchRollInFrame(
      _tf,
      this.h0 + this.dH * sHeading,
      this.p0 + this.dP * sTilt,
      this.r0 + this.dR * sTilt,
      out.quaternion,
    );

    // 4. Camera-to-pivot range, interpolated in log space (= altitude while looking straight down).
    const range = Math.exp(this.lnRange0 + (this.lnRange1 - this.lnRange0) * smootherstep(x));
    _f.set(0, 0, -1).applyQuaternion(out.quaternion);
    out.position.copy(_pivot).addScaledVector(_f, -range);

    // 5. Field of view.
    out.fov = this.start.fov + (this.end.fov - this.start.fov) * ramp(x, o.fovWindow[0], o.fovWindow[1]);
    return out;
  }

  /**
   * Camera `timeSeconds` after arrival: a slow level glide along `driftDirection` that starts
   * at driftSpeed (equal to the flight's arrival velocity) and eases towards driftFloorSpeed.
   * Orientation and FOV stay at the hero values.
   */
  drift(timeSeconds: number, out: CameraSample = createSample()): CameraSample {
    const o = this.options;
    const tau = Math.max(0, Number.isFinite(timeSeconds) ? timeSeconds : 0);
    const dist =
      o.driftFloorSpeed * tau + (o.driftSpeed - o.driftFloorSpeed) * o.driftTimeConstant * (1 - Math.exp(-tau / o.driftTimeConstant));
    out.position.copy(this.endPosition).addScaledVector(this.driftDirection, dist);
    out.quaternion.copy(this.endQuaternion);
    out.fov = this.end.fov;
    return out;
  }

  /** Convenience: seconds since the flight started -> flight sample, then drift. */
  at(seconds: number, out: CameraSample = createSample()): CameraSample {
    return seconds < this.duration ? this.sample(seconds / this.duration, out) : this.drift(seconds - this.duration, out);
  }

  /** Readouts for the HUD at `seconds` since the flight started (works during the drift too). */
  telemetry(seconds: number): Telemetry {
    const dt = 1 / 120;
    const t0 = Math.max(0, seconds - dt);
    const t1 = seconds + dt;
    const a = this.at(t0).position;
    const b = this.at(t1).position;
    const g = ecefToGeodetic(this.at(seconds).position);
    return {
      ...g,
      heightAboveLake: g.height - this.options.pivotHeight,
      speed: a.distanceTo(b) / (t1 - t0),
      verticalSpeed: (ecefToGeodetic(b).height - ecefToGeodetic(a).height) / (t1 - t0),
    };
  }
}

export function createFlyIn(start: GeoPose, end: GeoPose, options?: FlyInOptions): FlyInPath {
  return new FlyInPath(start, end, options);
}

// ---------------------------------------------------------------------------
// Art-directed poses (heights are WGS84 ellipsoidal = TAHOE.lakeEllipsoidHeight + metres above lake)
// ---------------------------------------------------------------------------

/**
 * HERO A, "Inspiration Point classic, from the air": 520 m above the lake over the north slope
 * of Mt Tallac (176 m above the ground), looking NNE. Fannette Island sits on the lower-left
 * third point, the bay runs diagonally to its mouth on the right third line, and the open lake
 * and Carson Range / Mt Rose (Nevada) fill the horizon.
 */
export const HERO_A: GeoPose = {
  lat: 38.942,
  lon: -120.104,
  height: TAHOE.lakeEllipsoidHeight + 520,
  heading: 25.2,
  // -11 (was -13.4): horizon at ~22% of the frame height, so the golden sky and the Carson
  // Range get more room; Fannette stays on the lower third, the specky west shallows crop off.
  pitch: -11.0,
  roll: 0,
  fov: 38,
};

/**
 * HERO B, "down the bay": 520 m above the lake over the Eagle Falls / Maggies Peaks slope
 * (313 m above the ground), looking ENE along the bay's axis. Fannette is on the lower-right
 * third point, the mouth is near frame centre and Genoa Peak / Carson Range sit on the horizon.
 */
export const HERO_B: GeoPose = {
  lat: 38.947,
  lon: -120.12,
  height: TAHOE.lakeEllipsoidHeight + 520,
  heading: 54.4,
  pitch: -9.1,
  roll: 0,
  fov: 34,
};

/** Start-screen camera: 24,000 km above Utah, straight down, north-up, Earth disc ~80% of frame height. */
export const ORBIT_START: GeoPose = {
  lat: 38.5,
  lon: -111.5,
  height: 24_000_000,
  heading: 0,
  pitch: -90,
  roll: 0,
  fov: 30,
};

/**
 * Idle start-screen motion: the globe turns like the real Earth (features drift left to right)
 * at `degPerSecond` (default 0.35 deg/s, about 84x real), so Tahoe slides from left of centre
 * towards the middle. Feed the pose at click time to `new FlyInPath(idlePose(t), HERO_A)`.
 */
export function idlePose(seconds: number, base: GeoPose = ORBIT_START, degPerSecond = 0.35): GeoPose {
  return { ...base, lon: wrap180(base.lon - degPerSecond * Math.max(0, seconds)) };
}
