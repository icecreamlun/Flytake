import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  ECEF_TO_YUP,
  FlyInPath,
  type GeoPose,
  HERO_A,
  HERO_B,
  ORBIT_START,
  TAHOE,
  YUP_TO_ECEF,
  clippingPlanes,
  ecefToGeodetic,
  enuVectors,
  geodeticToEcef,
  headingPitchRollFromQuaternion,
  idlePose,
  landingEase,
  quaternionFromHeadingPitchRoll,
  smootherstep,
  toYUp,
} from './flyIn';

const N = 2000;
const ts = Array.from({ length: N + 1 }, (_, i) => i / N);
const height = (p: Vector3) => ecefToGeodetic(p).height;
const isFiniteVec = (v: Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const isFiniteQuat = (q: Quaternion) => [q.x, q.y, q.z, q.w].every(Number.isFinite);
/** Rotation angle between two quaternions, accurate for tiny angles (unlike 2*acos|dot|). */
const qAngle = (a: Quaternion, b: Quaternion) => {
  const sgn = a.dot(b) < 0 ? -1 : 1;
  const d = Math.hypot(a.x - sgn * b.x, a.y - sgn * b.y, a.z - sgn * b.z, a.w - sgn * b.w);
  const s = Math.hypot(a.x + sgn * b.x, a.y + sgn * b.y, a.z + sgn * b.z, a.w + sgn * b.w);
  return 4 * Math.atan2(d, s);
};
const forward = (q: Quaternion) => new Vector3(0, 0, -1).applyQuaternion(q);
const screenUp = (q: Quaternion) => new Vector3(0, 1, 0).applyQuaternion(q);

const scenarios: Array<[string, GeoPose, GeoPose]> = [
  ['orbit -> hero A', ORBIT_START, HERO_A],
  ['orbit -> hero B', ORBIT_START, HERO_B],
  ['idle 90 s -> hero A', idlePose(90), HERO_A],
  ['start directly above target', { ...HERO_A, height: 2e7, pitch: -90, heading: 0, fov: 30 }, HERO_A],
  ['heading wrap 350 -> 10', { ...ORBIT_START, heading: 350 }, { ...HERO_A, heading: 10 }],
  ['tilted start (pitch -60, roll 5)', { ...ORBIT_START, height: 8e6, pitch: -60, roll: 5 }, HERO_A],
  ['start looks past the limb', { ...ORBIT_START, pitch: -5 }, HERO_A],
  ['near-antipodal start', { lat: -38.95, lon: 59.9, height: 2e7, heading: 0, pitch: -90, fov: 30 }, HERO_A],
  ['nadir end pose', ORBIT_START, { ...HERO_A, pitch: -90 }],
  ['end looks above horizon', ORBIT_START, { ...HERO_A, pitch: 5 }],
];

describe('WGS84 helpers', () => {
  it('round-trips geodetic <-> ECEF from the lake surface to deep space', () => {
    const cases: Array<[number, number, number]> = [
      [38.95407, -120.10046, TAHOE.lakeEllipsoidHeight],
      [0, 0, 0],
      [89.9999, 45, 1000],
      [-90, 0, -50],
      [38.5, -111.5, 2.4e7],
      [-33.9, 151.2, -100],
    ];
    for (const [lat, lon, h] of cases) {
      const g = ecefToGeodetic(geodeticToEcef(lat, lon, h));
      expect(g.lat).toBeCloseTo(lat, 9);
      if (Math.abs(lat) < 90) expect(g.lon).toBeCloseTo(lon, 9);
      expect(g.height).toBeCloseTo(h, 5);
    }
  });

  it('matches known ECEF coordinates (equator / pole)', () => {
    const eq = geodeticToEcef(0, 90, 0);
    expect(eq.x).toBeCloseTo(0, 6);
    expect(eq.y).toBeCloseTo(6378137, 6);
    const np = geodeticToEcef(90, 0, 0);
    expect(np.z).toBeCloseTo(6356752.314245, 5);
  });

  it('round-trips heading/pitch/roll, including straight down', () => {
    const cases: Array<[number, number, number]> = [
      [25.2, -13.4, 0],
      [300, 10, 3],
      [37, -90, 0],
      [181, 89.5, -20],
      [0, 0, 0],
    ];
    for (const [h, p, r] of cases) {
      const q = quaternionFromHeadingPitchRoll(38.95, -120.1, h, p, r);
      const back = headingPitchRollFromQuaternion(38.95, -120.1, q);
      const q2 = quaternionFromHeadingPitchRoll(38.95, -120.1, back.heading, back.pitch, back.roll);
      expect(qAngle(q, q2)).toBeLessThan(1e-12);
      expect(back.pitch).toBeCloseTo(p, 9);
      if (Math.abs(p) < 90) expect(back.heading).toBeCloseTo(h, 7);
    }
    // straight down: heading becomes the compass direction of screen-up
    const q = quaternionFromHeadingPitchRoll(38.95, -120.1, 37, -90, 0);
    expect(headingPitchRollFromQuaternion(38.95, -120.1, q).heading).toBeCloseTo(37, 9);
  });

  it('builds the camera frame: heading 90 pitch 0 looks east with up = local up', () => {
    const e = new Vector3();
    const n = new Vector3();
    const u = new Vector3();
    enuVectors(38.95, -120.1, e, n, u);
    const q = quaternionFromHeadingPitchRoll(38.95, -120.1, 90, 0, 0);
    expect(forward(q).dot(e)).toBeCloseTo(1, 12);
    expect(screenUp(q).dot(u)).toBeCloseTo(1, 12);
  });
});

describe('easing', () => {
  it('smootherstep and landingEase hit their end conditions', () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    const m = 0.3;
    const h = 1e-6;
    expect(landingEase(1, m)).toBeCloseTo(1, 12);
    expect((landingEase(1, m) - landingEase(1 - h, m)) / h).toBeCloseTo(m, 4);
    expect((landingEase(h, m) - landingEase(0, m)) / h).toBeCloseTo(0, 6);
    for (let i = 1; i <= 1000; i++) expect(landingEase(i / 1000, m)).toBeGreaterThanOrEqual(landingEase((i - 1) / 1000, m));
  });
});

describe.each(scenarios)('FlyInPath: %s', (_name, start, end) => {
  const path = new FlyInPath(start, end);
  const p0 = geodeticToEcef(start.lat, start.lon, start.height);
  const p1 = geodeticToEcef(end.lat, end.lon, end.height);
  const q0 = quaternionFromHeadingPitchRoll(start.lat, start.lon, start.heading, start.pitch, start.roll ?? 0);
  const q1 = quaternionFromHeadingPitchRoll(end.lat, end.lon, end.heading, end.pitch, end.roll ?? 0);

  it('matches both endpoints exactly', () => {
    const a = path.sample(0);
    const b = path.sample(1);
    expect(a.position.distanceTo(p0)).toBeLessThan(1e-3);
    expect(b.position.distanceTo(p1)).toBeLessThan(1e-6);
    expect(qAngle(a.quaternion, q0)).toBeLessThan(1e-12);
    expect(qAngle(b.quaternion, q1)).toBeLessThan(1e-12);
    expect(a.fov).toBe(start.fov);
    expect(b.fov).toBe(end.fov);
    // clamped outside [0, 1], and NaN-safe
    expect(path.sample(-1).position.distanceTo(p0)).toBeLessThan(1e-3);
    expect(path.sample(2).position.distanceTo(p1)).toBeLessThan(1e-6);
    expect(isFiniteVec(path.sample(Number.NaN).position)).toBe(true);
  });

  it('never produces NaN / Infinity', () => {
    for (const t of ts) {
      const s = path.sample(t);
      expect(isFiniteVec(s.position)).toBe(true);
      expect(isFiniteQuat(s.quaternion)).toBe(true);
      expect(Number.isFinite(s.fov)).toBe(true);
      expect(Math.abs(s.quaternion.length() - 1)).toBeLessThan(1e-9);
    }
    for (const sec of [0, 1, 10, 100, 1000]) {
      const d = path.drift(sec);
      expect(isFiniteVec(d.position)).toBe(true);
      expect(isFiniteQuat(d.quaternion)).toBe(true);
    }
  });

  // Guaranteed when the start looks at least as steeply down as the end (the design case).
  it.runIf(start.pitch <= end.pitch)('descends monotonically over the last 50%', () => {
    let prev = height(path.sample(0.5).position);
    for (const t of ts.filter((x) => x > 0.5)) {
      const h = height(path.sample(t).position);
      expect(h).toBeLessThanOrEqual(prev + 1e-6);
      prev = h;
    }
  });

  it('rotates continuously: no flips, no spikes', () => {
    const maxStepDeg = _name.includes('antipodal') ? 1.5 : 0.6;
    let prevQ = path.sample(0).quaternion.clone();
    let prevUp = screenUp(prevQ);
    let prevStep = 0;
    let maxStep = 0;
    for (const t of ts.slice(1)) {
      const q = path.sample(t).quaternion;
      const step = qAngle(prevQ, q);
      // 1/2000 of the flight = 7 ms; a flip would be ~180 deg in one step. (The antipodal case
      // turns the whole ENU frame through 180 deg in ~8 s, so it gets a looser bound.)
      expect(step).toBeLessThan(maxStepDeg * (Math.PI / 180));
      // no sudden jumps in angular speed (smooth = consecutive steps are similar)
      if (prevStep > 1e-4) expect(step).toBeLessThan(prevStep * 1.5 + 1e-4);
      const up = screenUp(q);
      expect(up.dot(prevUp)).toBeGreaterThan(Math.cos(maxStepDeg * (Math.PI / 180)));
      maxStep = Math.max(maxStep, step);
      prevStep = step;
      prevQ = q.clone();
      prevUp = up;
    }
    expect(maxStep).toBeGreaterThan(0);
  });

  it('continues into drift() seamlessly at t = 1', () => {
    const T = path.duration;
    const end1 = path.sample(1);
    const d0 = path.drift(0);
    expect(d0.position.distanceTo(end1.position)).toBeLessThan(1e-6);
    expect(qAngle(d0.quaternion, end1.quaternion)).toBeLessThan(1e-12);
    expect(d0.fov).toBe(end1.fov);
    // velocity (m/s) just before vs. just after arrival
    const h = 1e-5;
    const vIn = end1.position.clone().sub(path.sample(1 - h).position).divideScalar(h * T);
    const dt = h * T;
    const vOut = path.drift(dt).position.clone().sub(d0.position).divideScalar(dt);
    expect(vOut.length()).toBeCloseTo(path.options.driftSpeed, 3);
    expect(vIn.distanceTo(vOut)).toBeLessThan(0.02);
    // drift is level, goes the way the camera faces and keeps the hero framing
    const d10 = path.drift(10);
    expect(Math.abs(height(d10.position) - end.height)).toBeLessThan(0.05);
    const travel = d10.position.clone().sub(d0.position);
    expect(travel.dot(path.driftDirection)).toBeGreaterThan(0);
    const facing = Math.abs(end.pitch) < 89.9 ? forward(end1.quaternion) : screenUp(end1.quaternion);
    expect(travel.dot(facing)).toBeGreaterThan(0);
    expect(qAngle(d10.quaternion, end1.quaternion)).toBeLessThan(1e-12);
  });

  it('eases in from rest and lands slowly without a backward hiccup', () => {
    const T = path.duration;
    const speed = (t: number) => path.sample(t + 1e-5).position.distanceTo(path.sample(t).position) / (1e-5 * T);
    // eases in: first 1% of the flight covers a tiny fraction of the initial range
    const r0 = path.startPosition.distanceTo(path.startPivot);
    expect(path.sample(0.01).position.distanceTo(path.startPosition)).toBeLessThan(0.001 * r0);
    // final 15%: speed strictly decreasing towards driftSpeed, always moving forward
    let prev = Number.POSITIVE_INFINITY;
    for (let t = 0.85; t < 1 - 2e-5; t += 0.0025) {
      const v = speed(t);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThan(path.options.driftSpeed * 0.99);
      const along = path.sample(t + 1e-5).position.clone().sub(path.sample(t).position).dot(path.driftDirection);
      expect(along).toBeGreaterThan(0);
      prev = v;
    }
  });
});

describe('trajectory shape', () => {
  const path = new FlyInPath(ORBIT_START, HERO_A); // ~750 km of horizontal travel

  it('travels along a great circle while looking straight down', () => {
    // During the nadir phase (t < tiltStart) the camera is right above the pivot, so its
    // ground track must stay in the plane of the great circle through both pivots.
    const pre = path.pivotAt(path.options.travelEnd);
    const g1 = ecefToGeodetic(pre);
    const e = new Vector3();
    const n = new Vector3();
    const a = new Vector3();
    const b = new Vector3();
    enuVectors(ecefToGeodetic(path.startPivot).lat, ecefToGeodetic(path.startPivot).lon, e, n, a);
    enuVectors(g1.lat, g1.lon, e, n, b);
    const plane = a.clone().cross(b).normalize();
    for (let t = 0; t <= path.options.tiltStart; t += 0.01) {
      const g = ecefToGeodetic(path.sample(t).position);
      const up = new Vector3();
      enuVectors(g.lat, g.lon, e, n, up);
      expect(Math.abs(up.dot(plane))).toBeLessThan(1e-9);
    }
  });

  it('finishes the horizontal travel high above the ground, before the final descent', () => {
    const tEnd = path.options.travelEnd;
    const preDolly = path.pivotAt(tEnd);
    const total = path.startPivot.angleTo(preDolly);
    expect(total).toBeGreaterThan(0.1);
    // after travelEnd the pivot only moves by the (short, level) dolly
    for (let t = tEnd; t <= 1; t += 0.01) {
      expect(path.pivotAt(t).distanceTo(preDolly)).toBeLessThanOrEqual(path.options.dollyDistance + 1e-6);
    }
    // when the horizontal travel completes the camera is still > 50 km up
    expect(height(path.sample(tEnd).position) - TAHOE.lakeEllipsoidHeight).toBeGreaterThan(50_000);
    // and 95% of it is done above 300 km
    let t95 = 0;
    for (let t = 0; t <= 1; t += 0.001) {
      const left = path.pivotAt(t).angleTo(preDolly);
      if (left <= 0.05 * total) {
        t95 = t;
        break;
      }
    }
    expect(height(path.sample(t95).position) - TAHOE.lakeEllipsoidHeight).toBeGreaterThan(300_000);
  });

  it('starts straight down and ends on the hero heading/pitch', () => {
    const g = ecefToGeodetic(path.sample(0).position);
    expect(headingPitchRollFromQuaternion(g.lat, g.lon, path.sample(0).quaternion).pitch).toBeCloseTo(-90, 6);
    const e = ecefToGeodetic(path.sample(1).position);
    const hpr = headingPitchRollFromQuaternion(e.lat, e.lon, path.sample(1).quaternion);
    expect(hpr.heading).toBeCloseTo(HERO_A.heading, 6);
    expect(hpr.pitch).toBeCloseTo(HERO_A.pitch, 6);
  });

  it('reports sensible telemetry', () => {
    const t0 = path.telemetry(0);
    expect(t0.heightAboveLake).toBeCloseTo(ORBIT_START.height - TAHOE.lakeEllipsoidHeight, 0);
    const tEnd = path.telemetry(path.duration);
    expect(tEnd.speed).toBeCloseTo(path.options.driftSpeed, 1);
    expect(tEnd.heightAboveLake).toBeCloseTo(520, 3);
    expect(path.telemetry(path.duration * 0.7).verticalSpeed).toBeLessThan(0);
  });

  it('rejects a drift speed the dolly cannot reach smoothly', () => {
    expect(() => new FlyInPath(ORBIT_START, HERO_A, { driftSpeed: 50, dollyDistance: 50 })).toThrow(RangeError);
  });
});

describe('clipping planes & frames', () => {
  it('covers the horizon and the Earth limb', () => {
    const hero = clippingPlanes(176, HERO_A.height);
    expect(hero.near).toBeGreaterThan(0);
    expect(hero.far).toBeGreaterThan(150_000); // sees the Carson Range and beyond
    const space = clippingPlanes(2.4e7, 2.4e7);
    const limb = Math.sqrt((6371e3 + 2.4e7) ** 2 - 6371e3 ** 2);
    expect(space.far).toBeGreaterThan(limb);
    const linear = clippingPlanes(5, 2000, { logarithmicDepth: false });
    expect(linear.far / linear.near).toBeLessThanOrEqual(2e4 + 1e-6);
  });

  it('maps ECEF to the Y-up scene used when tiles.group.rotation.x = -PI/2', () => {
    const north = new Vector3(0, 0, 1).applyMatrix4(ECEF_TO_YUP);
    expect(north.y).toBeCloseTo(1, 12);
    const lon90 = new Vector3(0, 1, 0).applyMatrix4(ECEF_TO_YUP);
    expect(lon90.z).toBeCloseTo(-1, 12);
    const back = north.clone().applyMatrix4(YUP_TO_ECEF);
    expect(back.z).toBeCloseTo(1, 12);
    const s = new FlyInPath(ORBIT_START, HERO_A).sample(0.9);
    const y = toYUp(s);
    // the view direction must rotate with the positions
    const fEcef = forward(s.quaternion).applyMatrix4(ECEF_TO_YUP);
    expect(forward(y.quaternion).distanceTo(fEcef)).toBeLessThan(1e-12);
    expect(y.position.distanceTo(s.position.clone().applyMatrix4(ECEF_TO_YUP))).toBeLessThan(1e-6);
  });
});
