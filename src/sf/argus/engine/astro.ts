/**
 * Astronomy for the scene: NOAA solar position (Meeus-based spreadsheet algorithm) and a
 * low-precision lunar ephemeris (same series as SunCalc), for San Francisco on 2026-11-07, PST.
 * All angles in degrees unless noted. World vectors use +X east, -Z north, +Y up.
 */
import * as THREE from 'three';

// Flytake: Flytake's demo day, 2026-11-07 PST (argus used 2026-10-25 PDT), so the shared
// time-of-day slider (src/world/sun.ts, local PST hours) maps 1:1 onto this clock.
export const SITE = { lat: 37.7935, lon: -122.398, tzHours: -8 } as const;
/** Scenario date (local). Standard time (PST) since Nov 1 2026. */
export const SCENE_DATE = { year: 2026, month: 11, day: 7 } as const;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Julian day at 0h UT for a Gregorian calendar date. */
function julianDay0h(y: number, m: number, d: number): number {
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

/** Julian day (UT) for a local clock time (hours) on the scene date. */
export function julianDayForLocal(hours: number): number {
  return julianDay0h(SCENE_DATE.year, SCENE_DATE.month, SCENE_DATE.day) + (hours - SITE.tzHours) / 24;
}

export interface SkyPosition {
  /** Elevation above the horizon incl. refraction (deg). */
  elevation: number;
  /** Azimuth clockwise from true north (deg). */
  azimuth: number;
}

/** Atmospheric refraction correction (deg) for a geometric elevation (deg) — NOAA formula. */
function refraction(elev: number): number {
  if (elev > 85) return 0;
  const te = Math.tan(elev * D2R);
  let r: number;
  if (elev > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575) r = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else r = -20.772 / te;
  return r / 3600;
}

/** NOAA solar position for local clock time `hours` (PST) on the scene date. */
export function solarPosition(hours: number, lat = SITE.lat, lon = SITE.lon): SkyPosition {
  const jd = julianDayForLocal(hours);
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * D2R;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * D2R);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * D2R);
  const decl = Math.asin(Math.sin(eps * D2R) * Math.sin(lambda * D2R));
  const y = Math.tan((eps / 2) * D2R) ** 2;
  const L0r = L0 * D2R;
  const eqTime =
    4 *
    R2D *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));
  const localMinutes = hours * 60;
  const tst = (((localMinutes + eqTime + 4 * lon - 60 * SITE.tzHours) % 1440) + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const latr = lat * D2R;
  const cosZen = Math.sin(latr) * Math.sin(decl) + Math.cos(latr) * Math.cos(decl) * Math.cos(ha * D2R);
  const zen = Math.acos(THREE.MathUtils.clamp(cosZen, -1, 1));
  const elevGeom = 90 - zen * R2D;
  const azDen = Math.cos(latr) * Math.sin(zen);
  let az: number;
  if (Math.abs(azDen) < 1e-9) az = 180;
  else {
    const c = THREE.MathUtils.clamp((Math.sin(latr) * Math.cos(zen) - Math.sin(decl)) / azDen, -1, 1);
    const a = Math.acos(c) * R2D;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  return { elevation: elevGeom + refraction(elevGeom), azimuth: az };
}

// ───────────── Moon (low precision, ~0.5° — plenty for rendering) ─────────────

const OBLIQ = D2R * 23.4397;

function raDec(l: number, b: number) {
  return {
    ra: Math.atan2(Math.sin(l) * Math.cos(OBLIQ) - Math.tan(b) * Math.sin(OBLIQ), Math.cos(l)),
    dec: Math.asin(Math.sin(b) * Math.cos(OBLIQ) + Math.cos(b) * Math.sin(OBLIQ) * Math.sin(l)),
  };
}

export function lunarPosition(hours: number, lat = SITE.lat, lon = SITE.lon): SkyPosition & { distanceKm: number } {
  const d = julianDayForLocal(hours) - 2451545;
  const L = D2R * (218.316 + 13.176396 * d);
  const M = D2R * (134.963 + 13.064993 * d);
  const F = D2R * (93.272 + 13.22935 * d);
  const l = L + D2R * 6.289 * Math.sin(M);
  const b = D2R * 5.128 * Math.sin(F);
  const dist = 385001 - 20905 * Math.cos(M);
  const { ra, dec } = raDec(l, b);
  const lw = D2R * -lon;
  const phi = D2R * lat;
  const H = D2R * (280.16 + 360.9856235 * d) - lw - ra;
  let h = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  // Parallax correction (moon is close) + refraction.
  h -= Math.asin(6371 / dist) * Math.cos(h);
  const elev = h * R2D;
  const azSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const az = ((azSouth * R2D + 180) % 360 + 360) % 360;
  return { elevation: elev + refraction(elev), azimuth: az, distanceKm: dist };
}

/** Unit world vector (+X east, -Z north, +Y up) from elevation/azimuth (deg). */
export function skyDirection(p: SkyPosition, target = new THREE.Vector3()): THREE.Vector3 {
  const e = p.elevation * D2R;
  const a = p.azimuth * D2R;
  return target.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

/** Night factor: 0 above +6° sun elevation, 1 below −6°, smooth in between. */
export function nightFactorFor(sunElevationDeg: number): number {
  const t = THREE.MathUtils.clamp((6 - sunElevationDeg) / 12, 0, 1);
  return t * t * (3 - 2 * t);
}
