/**
 * WGS84 geodesy helpers shared by the camera, scene and (later) flight-path / drone code.
 *
 * FRAME: all positions are WGS84 ECEF metres, right-handed:
 *   +X -> (lat 0, lon 0), +Y -> (lat 0, lon 90E), +Z -> north pole.
 * This is the native frame of 3d-tiles-renderer / Google Photorealistic 3D Tiles when
 * `tiles.group` has an identity transform (which is how Flytake renders: world == ECEF).
 * Angles in this module are DEGREES; heights are metres above the WGS84 ellipsoid.
 * Quaternions use the three.js camera convention (looks down local -Z, +Y is screen-up).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * (1 - WGS84_F);
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2);
/** Mean Earth radius (IUGG), used only for horizon / clipping estimates. */
export const EARTH_MEAN_RADIUS = 6371008.8;

export interface Geodetic {
  /** geodetic latitude, degrees */
  lat: number;
  /** longitude, degrees (east positive) */
  lon: number;
  /** metres above the WGS84 ellipsoid */
  height: number;
}

export interface HeadingPitchRoll {
  heading: number;
  pitch: number;
  roll: number;
}

/** An orthonormal local frame given by its east / north / up unit vectors (ECEF). */
export interface LocalFrame {
  east: Vector3;
  north: Vector3;
  up: Vector3;
}

/** Wrap an angle in degrees to [-180, 180). */
export function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}
/** Wrap an angle in degrees to [0, 360). */
export function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}


// ---------------------------------------------------------------------------
// WGS84 <-> ECEF, ENU frames
// ---------------------------------------------------------------------------

export function geodeticToEcef(latDeg: number, lonDeg: number, height: number, out = new Vector3()): Vector3 {
  const phi = latDeg * DEG;
  const lam = lonDeg * DEG;
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sp * sp);
  return out.set((n + height) * cp * Math.cos(lam), (n + height) * cp * Math.sin(lam), (n * (1 - WGS84_E2) + height) * sp);
}

/** ECEF from an n-vector (unit ellipsoid normal) and ellipsoidal height. Pole-safe. */
export function nVectorToEcef(nv: Vector3, height: number, out = new Vector3()): Vector3 {
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * nv.z * nv.z);
  return out.set((n + height) * nv.x, (n + height) * nv.y, (n * (1 - WGS84_E2) + height) * nv.z);
}

/** Bowring's method, iterated to convergence (sub-micrometre for |h| < 1e8 m). */
export function ecefToGeodetic(p: Vector3, out: Geodetic = { lat: 0, lon: 0, height: 0 }): Geodetic {
  const { x, y, z } = p;
  const rho = Math.hypot(x, y);
  out.lon = Math.atan2(y, x) * RAD;
  if (rho < 1e-6) {
    out.lat = z >= 0 ? 90 : -90;
    out.height = Math.abs(z) - WGS84_B;
    return out;
  }
  let beta = Math.atan2(WGS84_A * z, WGS84_B * rho);
  let phi = beta;
  for (let i = 0; i < 10; i++) {
    const sb = Math.sin(beta);
    const cb = Math.cos(beta);
    const next = Math.atan2(z + WGS84_EP2 * WGS84_B * sb * sb * sb, rho - WGS84_E2 * WGS84_A * cb * cb * cb);
    const converged = Math.abs(next - phi) < 1e-15;
    phi = next;
    beta = Math.atan2(WGS84_B * Math.sin(phi), WGS84_A * Math.cos(phi));
    if (converged) break;
  }
  const sp = Math.sin(phi);
  out.lat = phi * RAD;
  out.height = rho * Math.cos(phi) + z * sp - WGS84_A * Math.sqrt(1 - WGS84_E2 * sp * sp);
  return out;
}

/** East / North / Up unit vectors (ECEF) at a geodetic lat/lon. `up` is the ellipsoid normal (n-vector). */
export function enuVectors(latDeg: number, lonDeg: number, east: Vector3, north: Vector3, up: Vector3): void {
  const phi = latDeg * DEG;
  const lam = lonDeg * DEG;
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const sl = Math.sin(lam);
  const cl = Math.cos(lam);
  east.set(-sl, cl, 0);
  north.set(-sp * cl, -sp * sl, cp);
  up.set(cp * cl, cp * sl, sp);
}

/** Local ENU -> ECEF transform (columns east, north, up; origin at lat/lon/height). */
export function enuToEcefMatrix(latDeg: number, lonDeg: number, height: number, out = new Matrix4()): Matrix4 {
  const e = new Vector3();
  const n = new Vector3();
  const u = new Vector3();
  enuVectors(latDeg, lonDeg, e, n, u);
  out.makeBasis(e, n, u);
  return out.setPosition(geodeticToEcef(latDeg, lonDeg, height));
}

const _e = new Vector3();
const _n = new Vector3();
const _u = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _m = new Matrix4();

/**
 * Camera quaternion (ECEF, three.js convention) from heading/pitch/roll in a local frame.
 * Smooth in all three angles, including pitch = +-90 (no look-at, so no up-vector singularity).
 */
export function quaternionFromHeadingPitchRollInFrame(
  frame: LocalFrame,
  headingDeg: number,
  pitchDeg: number,
  rollDeg = 0,
  out = new Quaternion(),
): Quaternion {
  const { east, north, up } = frame;
  const h = headingDeg * DEG;
  const p = pitchDeg * DEG;
  const r = rollDeg * DEG;
  const sh = Math.sin(h);
  const ch = Math.cos(h);
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const sr = Math.sin(r);
  const cr = Math.cos(r);
  // Local components: forward f, level-right r0 = (ch, -sh, 0), level-up u0 = r0 x f.
  const fE = sh * cp;
  const fN = ch * cp;
  const fU = sp;
  const u0E = -sh * sp;
  const u0N = -ch * sp;
  const u0U = cp;
  // Roll about forward: right = r0 cos r - u0 sin r, up = u0 cos r + r0 sin r.
  const rE = ch * cr - u0E * sr;
  const rN = -sh * cr - u0N * sr;
  const rU = -u0U * sr;
  const uE = u0E * cr + ch * sr;
  const uN = u0N * cr - sh * sr;
  const uU = u0U * cr;
  _x.set(0, 0, 0).addScaledVector(east, rE).addScaledVector(north, rN).addScaledVector(up, rU);
  _y.set(0, 0, 0).addScaledVector(east, uE).addScaledVector(north, uN).addScaledVector(up, uU);
  _z.set(0, 0, 0).addScaledVector(east, -fE).addScaledVector(north, -fN).addScaledVector(up, -fU);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Inverse of quaternionFromHeadingPitchRollInFrame. At exactly +-90 pitch, heading and roll are
 * degenerate; this returns roll = 0 and puts the screen-up compass direction into heading.
 */
export function headingPitchRollFromQuaternionInFrame(frame: LocalFrame, q: Quaternion): HeadingPitchRoll {
  const { east, north, up } = frame;
  _m.makeRotationFromQuaternion(q);
  _m.extractBasis(_x, _y, _z);
  const fE = -_z.dot(east);
  const fN = -_z.dot(north);
  const fU = -_z.dot(up);
  // atan2 (not asin) keeps full precision next to +-90 degrees.
  const pitch = Math.atan2(fU, Math.hypot(fE, fN));
  const rE = _x.dot(east);
  const rN = _x.dot(north);
  const rU = _x.dot(up);
  let heading: number;
  let roll: number;
  if (Math.hypot(fE, fN) > 1e-9) {
    heading = Math.atan2(fE, fN);
    const sh = Math.sin(heading);
    const ch = Math.cos(heading);
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    const alongLevelRight = rE * ch - rN * sh;
    const alongLevelUp = -rE * sh * sp - rN * ch * sp + rU * cp;
    roll = Math.atan2(-alongLevelUp, alongLevelRight);
  } else {
    roll = 0;
    heading = Math.atan2(-rN, rE);
  }
  return { heading: wrap360(heading * RAD), pitch: pitch * RAD, roll: roll * RAD };
}

const _frame: LocalFrame = { east: _e, north: _n, up: _u };

/** Camera quaternion from heading/pitch/roll in the local ENU frame at lat/lon. */
export function quaternionFromHeadingPitchRoll(
  latDeg: number,
  lonDeg: number,
  headingDeg: number,
  pitchDeg: number,
  rollDeg = 0,
  out = new Quaternion(),
): Quaternion {
  enuVectors(latDeg, lonDeg, _e, _n, _u);
  return quaternionFromHeadingPitchRollInFrame(_frame, headingDeg, pitchDeg, rollDeg, out);
}

/** Heading/pitch/roll of an ECEF camera quaternion in the local ENU frame at lat/lon. */
export function headingPitchRollFromQuaternion(latDeg: number, lonDeg: number, q: Quaternion): HeadingPitchRoll {
  enuVectors(latDeg, lonDeg, _e, _n, _u);
  return headingPitchRollFromQuaternionInFrame(_frame, q);
}

// ---------------------------------------------------------------------------
// Y-up scene support (Flytake itself renders in ECEF; kept for scenes that rotate the tiles group)
// ---------------------------------------------------------------------------

/** World(Y-up) = ECEF_TO_YUP * ECEF. Matches `tiles.group.rotation.x = -Math.PI / 2`. ECEF (x, y, z) -> (x, z, -y). */
export const ECEF_TO_YUP = new Matrix4().makeRotationX(-Math.PI / 2);
/** Inverse; use as takram `worldToECEFMatrix` when the scene is Y-up. */
export const YUP_TO_ECEF = new Matrix4().makeRotationX(Math.PI / 2);

/** Distance along a ray to the ellipsoid inflated by `height`, or null when it misses. */
export function rayToEllipsoid(origin: Vector3, dir: Vector3, height: number): number | null {
  const a2 = (WGS84_A + height) ** 2;
  const b2 = (WGS84_B + height) ** 2;
  const qa = (dir.x * dir.x + dir.y * dir.y) / a2 + (dir.z * dir.z) / b2;
  const qb = 2 * ((origin.x * dir.x + origin.y * dir.y) / a2 + (origin.z * dir.z) / b2);
  const qc = (origin.x * origin.x + origin.y * origin.y) / a2 + (origin.z * origin.z) / b2 - 1;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-qb - sq) / (2 * qa);
  const t2 = (-qb + sq) / (2 * qa);
  if (t1 > 0) return t1;
  if (t2 > 0) return t2;
  return null;
}

