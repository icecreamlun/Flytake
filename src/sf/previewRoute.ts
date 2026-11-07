/**
 * The hard-coded Ferry Building flight plan and its 60 s preview shot, in argus's frame
 * (x east, y up in metres above the bay at y = 0, z SOUTH).
 *
 * The plan takes off from Ferry Building Plaza (the drone's launch site, behind the clock tower)
 * and is shot for 4 PM light, with the sun low in the south-west:
 *   0-9 s    pull away from the tower's shaded back, rising: the backlit FiDi skyline appears
 *   9-39 s   arc north round the tower to its sunlit west face, Bay Bridge behind it (hero frame)
 *   39-60 s  crane up over the tower top and out over the Ferry Building toward the bay and bridge
 * Every point stays under 120 m above the take-off point and clear of the towers (preview.test).
 *
 * Positions and look targets are keyframed in time and joined by Catmull-Rom (Hermite) splines
 * with zero velocity at both ends, so the shot eases in and out.
 */
import { Vector3 } from 'three';

/** Ferry Building Plaza ground (the drone's launch site, see SfDroneSim) */
export const PREVIEW_TAKEOFF = new Vector3(500, 2.6, -200);
/** the clock tower's axis (top ~75 m) */
export const CLOCK_TOWER = new Vector3(387, 0, -216);
/** local time the preview is shot at (PST hours, inside Flytake's time slider) */
export const PREVIEW_HOURS = 16;

export interface Keyframe {
  t: number;
  pos: [number, number, number];
  look: [number, number, number];
}

/** a point on a circle round the clock tower: bearing (deg clockwise from north), radius, height */
function orbit(bearing: number, radius: number, height: number): [number, number, number] {
  const b = (bearing * Math.PI) / 180;
  return [CLOCK_TOWER.x + radius * Math.sin(b), height, CLOCK_TOWER.z - radius * Math.cos(b)];
}

const TOWER_LOOK = (height: number): [number, number, number] => [CLOCK_TOWER.x, height, CLOCK_TOWER.z];

export const FLIGHT_KEYS: readonly Keyframe[] = [
  { t: 0, pos: [500, 3.2, -200], look: TOWER_LOOK(40) },
  { t: 4, pos: [520, 14, -198], look: TOWER_LOOK(44) },
  { t: 9, pos: [590, 42, -192], look: TOWER_LOOK(48) },
  { t: 15, pos: orbit(68, 185, 55), look: TOWER_LOOK(50) },
  { t: 21, pos: orbit(25, 165, 62), look: TOWER_LOOK(52) },
  { t: 27, pos: orbit(-20, 150, 68), look: TOWER_LOOK(54) },
  { t: 33, pos: orbit(-62, 140, 72), look: TOWER_LOOK(55) },
  // the hero frame: sunlit west face, the Bay Bridge across the water behind it
  { t: 39, pos: orbit(-95, 130, 74), look: [420, 55, -200] },
  { t: 46, pos: [330, 105, -212], look: [520, 40, -160] },
  { t: 53, pos: [460, 115, -195], look: [900, 60, 120] },
  { t: 60, pos: [565, 117, -182], look: [1150, 80, 120] },
];

export const FLIGHT_SECONDS = FLIGHT_KEYS[FLIGHT_KEYS.length - 1]!.t;

/** the opening overview: high in the north-west, the whole plan and the bridge in frame */
export const OVERVIEW = {
  seconds: 4.5,
  /** the plan draws itself over this long, from the take-off point */
  drawSeconds: 3.2,
  from: new Vector3(40, 330, -800),
  to: new Vector3(110, 285, -700),
  look: new Vector3(470, 30, -170),
};

/** Hermite spline through keyframes in time; Catmull-Rom tangents, zero at both ends. */
class TimeSpline {
  private readonly t: number[];
  private readonly p: Vector3[];
  private readonly v: Vector3[];

  constructor(times: number[], points: Vector3[]) {
    this.t = times;
    this.p = points;
    const n = points.length;
    this.v = points.map((_, i) =>
      i === 0 || i === n - 1 ? new Vector3() : points[i + 1]!.clone().sub(points[i - 1]!).divideScalar(times[i + 1]! - times[i - 1]!),
    );
  }

  at(time: number, out: Vector3): Vector3 {
    const t = this.t;
    const last = t.length - 1;
    if (time <= t[0]!) return out.copy(this.p[0]!);
    if (time >= t[last]!) return out.copy(this.p[last]!);
    let i = 0;
    while (time > t[i + 1]!) i++;
    const h = t[i + 1]! - t[i]!;
    const u = (time - t[i]!) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return out
      .copy(this.p[i]!)
      .multiplyScalar(h00)
      .addScaledVector(this.v[i]!, h10 * h)
      .addScaledVector(this.p[i + 1]!, h01)
      .addScaledVector(this.v[i + 1]!, h11 * h);
  }
}

const times = FLIGHT_KEYS.map((k) => k.t);
const POSITION = new TimeSpline(times, FLIGHT_KEYS.map((k) => new Vector3(...k.pos)));
const LOOK = new TimeSpline(times, FLIGHT_KEYS.map((k) => new Vector3(...k.look)));

/** Drone (camera) position and look target `t` seconds into the flight. */
export function sampleFlight(t: number, pos: Vector3, look: Vector3): void {
  POSITION.at(t, pos);
  LOOK.at(t, look);
}

/** The flight path as a polyline (for the dashed route) with the distance flown at each point. */
export function flightPolyline(step = 0.1): { points: Vector3[]; distance: number[]; times: number[] } {
  const points: Vector3[] = [];
  const distance: number[] = [];
  const stamps: number[] = [];
  const count = Math.ceil(FLIGHT_SECONDS / step);
  for (let i = 0; i <= count; i++) {
    const t = Math.min(FLIGHT_SECONDS, i * step);
    const p = POSITION.at(t, new Vector3());
    distance.push(points.length === 0 ? 0 : distance[distance.length - 1]! + p.distanceTo(points[points.length - 1]!));
    points.push(p);
    stamps.push(t);
  }
  return { points, distance, times: stamps };
}
