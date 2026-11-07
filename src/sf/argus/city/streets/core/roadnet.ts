/**
 * Road network analysis: classifies OSM road records, builds intersection nodes from shared vertices,
 * derives lane layouts (travel / parking / bike / transit lanes), curb-return fillet polygons and the
 * crosswalk / stop-bar / no-marking intervals every other street sub-system uses.
 *
 * Conventions: arc length `s` runs along the record's point order. Lateral offset `o` is positive to the
 * LEFT of the direction of increasing s (left = (dz, -dx) for direction (dx, dz) in our +X east / +Z south frame).
 */
import type { RoadKind, RoadRecord } from '../../../contracts';

export type RoadClass = 'street' | 'service' | 'flush' | 'path' | 'steps' | 'cycle' | 'pedestrian' | 'rail' | 'cable' | 'skip';

export interface LaneLayout {
  /** Travel lanes total, forward (right of centreline, along s), backward. */
  n: number;
  nf: number;
  nb: number;
  lw: number;
  parkL: number;
  parkR: number;
  bikeL: number;
  bikeR: number;
  /** Lateral offset of the direction divider (two-way only). */
  centre: number;
  /** Centre lanes are red transit-only lanes (Market St). */
  transit: boolean;
}

export interface Crossing {
  /** Arc-length interval of the crosswalk band on this road. */
  s0: number;
  s1: number;
  /** Stop bar centre arc length (NaN when none) and which side it covers: +1 left half, -1 right half, 0 full width. */
  stopS: number;
  stopSide: number;
  node: RoadNode;
}

export interface Road {
  rec: RoadRecord;
  index: number;
  kind: RoadKind;
  cls: RoadClass;
  /** Interleaved x,z of the cleaned centreline. */
  pts: number[];
  cum: number[];
  len: number;
  hw: number;
  sw: number;
  /** Cut into the carriageway mask (below raised blocks, real curbs). */
  curbed: boolean;
  /** Non-service street (gets crosswalks / lane markings / furniture). */
  major: boolean;
  oneway: boolean;
  layout: LaneLayout | null;
  crossings: Crossing[];
  /** Arc-length intervals with no longitudinal markings (intersections). */
  clear: [number, number][];
  /** Arc-length positions of intersection nodes on this road. */
  nodeS: number[];
}

export interface Arm {
  road: Road;
  s: number;
  sign: 1 | -1;
  dx: number;
  dz: number;
  angle: number;
}

export interface RoadNode {
  x: number;
  z: number;
  arms: Arm[];
  majorArms: number;
  signal: boolean;
  /** Fillet polygons (curb returns) as flat x,z arrays. */
  fillets: number[][];
}

const RANK: Partial<Record<RoadKind, number>> = { motorway: 6, primary: 5, secondary: 4, tertiary: 3, residential: 2, living_street: 1, service: 0 };

function classify(r: RoadRecord): RoadClass {
  if (r.tunnel || (r.layer ?? 0) < 0) return 'skip';
  switch (r.kind) {
    case 'motorway':
      return r.bridge || (r.layer ?? 0) >= 1 ? 'skip' : 'street';
    case 'primary':
    case 'secondary':
    case 'tertiary':
    case 'residential':
    case 'living_street':
      return r.bridge ? 'skip' : 'street';
    case 'service':
      if (r.bridge) return 'skip';
      return (r.sidewalk ?? 0) > 0 ? 'service' : 'flush';
    case 'pedestrian':
      return r.bridge ? 'skip' : 'pedestrian';
    case 'footway':
      return r.bridge ? 'skip' : 'path';
    case 'steps':
      return r.bridge ? 'skip' : 'steps';
    case 'cycleway':
      return r.bridge ? 'skip' : 'cycle';
    case 'rail':
      return 'rail';
    case 'cable_car':
      return 'cable';
  }
  return 'skip';
}

const BIKE_STREETS = /^(Market Street|The Embarcadero|Howard Street|Folsom Street|2nd Street|Polk Street|Valencia Street|Sansome Street|Townsend Street)$/;
const NO_PARKING = /^(Market Street|The Embarcadero|Broadway Tunnel)$/;

function layoutFor(r: RoadRecord, cls: RoadClass): LaneLayout | null {
  if (cls !== 'street' && cls !== 'service') return null;
  const W = r.width;
  const name = r.name ?? '';
  const oneway = !!r.oneway;
  let n = r.lanes ?? 0;
  if (!n) {
    if (r.kind === 'service' || r.kind === 'living_street') n = oneway || W < 6 ? 1 : 2;
    else if (oneway) n = Math.max(1, Math.min(4, Math.floor((W - 2.4) / 3.2)));
    else n = W >= 15 ? 4 : 2;
  }
  n = Math.max(1, Math.min(n, Math.floor(W / 2.7)));
  let bikeL = 0;
  let bikeR = 0;
  if (BIKE_STREETS.test(name) && W >= 9) {
    bikeR = 1.8;
    if (!oneway) bikeL = 1.8;
  }
  let parkL = 0;
  let parkR = 0;
  const parkable = !NO_PARKING.test(name) && r.kind !== 'motorway' && r.kind !== 'service';
  if (parkable) {
    const avail = W - n * 3.1 - bikeL - bikeR;
    if (avail >= 4.6) parkL = parkR = 2.4;
    else if (avail >= 2.2) parkR = 2.3;
  }
  const lw = (W - parkL - parkR - bikeL - bikeR) / n;
  const nf = oneway ? n : Math.ceil(n / 2);
  const nb = oneway ? 0 : n - nf;
  const centre = -W / 2 + parkR + bikeR + nf * lw;
  return { n, nf, nb, lw, parkL, parkR, bikeL, bikeR, centre, transit: name === 'Market Street' && !oneway && n >= 4 };
}

export class RoadNet {
  readonly roads: Road[] = [];
  readonly nodes: RoadNode[] = [];

  constructor(records: RoadRecord[]) {
    records.forEach((rec, index) => {
      const cls = classify(rec);
      const pts: number[] = [];
      for (const [x, z] of rec.points) {
        const n = pts.length;
        if (n >= 2 && Math.hypot(x - pts[n - 2], z - pts[n - 1]) < 0.05) continue;
        pts.push(x, z);
      }
      if (pts.length < 4) return;
      const cum = [0];
      for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
      const curbed = cls === 'street' || cls === 'service';
      this.roads.push({
        rec,
        index,
        kind: rec.kind,
        cls,
        pts,
        cum,
        len: cum[cum.length - 1],
        hw: rec.width / 2,
        sw: rec.sidewalk ?? 0,
        curbed,
        major: cls === 'street',
        oneway: !!rec.oneway,
        layout: layoutFor(rec, cls),
        crossings: [],
        clear: [],
        nodeS: [],
      });
    });
    this.buildNodes();
  }

  /** Point and unit tangent at arc length s. */
  at(r: Road, s: number, out: { x: number; z: number; dx: number; dz: number } = { x: 0, z: 0, dx: 1, dz: 0 }) {
    const { cum, pts } = r;
    s = Math.max(0, Math.min(r.len, s));
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi] - cum[lo] || 1;
    const t = (s - cum[lo]) / segLen;
    const ax = pts[lo * 2];
    const az = pts[lo * 2 + 1];
    const bx = pts[hi * 2];
    const bz = pts[hi * 2 + 1];
    out.x = ax + (bx - ax) * t;
    out.z = az + (bz - az) * t;
    out.dx = (bx - ax) / segLen;
    out.dz = (bz - az) / segLen;
    return out;
  }

  private buildNodes(): void {
    // Vertex → incident (road, vertex index) for the curbed network.
    const key = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
    const map = new Map<string, { road: Road; vi: number }[]>();
    for (const r of this.roads) {
      if (!r.curbed) continue;
      const nv = r.pts.length / 2;
      for (let vi = 0; vi < nv; vi++) {
        const k = key(r.pts[vi * 2], r.pts[vi * 2 + 1]);
        let list = map.get(k);
        if (!list) map.set(k, (list = []));
        list.push({ road: r, vi });
      }
    }
    const tmp = { x: 0, z: 0, dx: 0, dz: 0 };
    for (const list of map.values()) {
      // Degree = number of incident segments.
      let degree = 0;
      for (const { road, vi } of list) degree += vi === 0 || vi === road.pts.length / 2 - 1 ? 1 : 2;
      const distinctRoads = new Set(list.map((l) => l.road)).size;
      if (degree < 3 && !(degree === 2 && distinctRoads === 2)) continue;
      const { road: r0, vi: v0 } = list[0];
      const node: RoadNode = { x: r0.pts[v0 * 2], z: r0.pts[v0 * 2 + 1], arms: [], majorArms: 0, signal: false, fillets: [] };
      for (const { road, vi } of list) {
        const s = road.cum[vi];
        for (const sign of [1, -1] as const) {
          if ((sign === 1 && vi === road.pts.length / 2 - 1) || (sign === -1 && vi === 0)) continue;
          const look = Math.min(8, sign === 1 ? road.len - s : s);
          this.at(road, s + sign * look, tmp);
          let dx = tmp.x - node.x;
          let dz = tmp.z - node.z;
          const l = Math.hypot(dx, dz) || 1;
          dx /= l;
          dz /= l;
          node.arms.push({ road, s, sign, dx, dz, angle: Math.atan2(dz, dx) });
        }
        road.nodeS.push(s);
      }
      node.arms.sort((a, b) => a.angle - b.angle);
      node.majorArms = node.arms.filter((a) => a.road.major).length;
      const strong = node.arms.filter((a) => (RANK[a.road.kind] ?? 0) >= 3).length;
      node.signal = node.majorArms >= 3 && strong >= 2;
      this.buildFillets(node);
      if (node.majorArms >= 3) this.buildCrossings(node);
      this.nodes.push(node);
    }
    for (const r of this.roads) {
      r.nodeS.sort((a, b) => a - b);
      r.clear.sort((a, b) => a[0] - b[0]);
    }
  }

  /** Curb-return fillets between angularly adjacent arms (filled as carriageway in the mask). */
  private buildFillets(node: RoadNode): void {
    const arms = node.arms;
    if (arms.length < 2) return;
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      const b = arms[(i + 1) % arms.length];
      let phi = b.angle - a.angle;
      if (phi <= 0) phi += Math.PI * 2;
      if (phi > (165 * Math.PI) / 180 || phi < (15 * Math.PI) / 180) continue;
      // Normals pointing into the wedge between a and b.
      const nax = -a.dz;
      const naz = a.dx;
      const nbx = b.dz;
      const nbz = -b.dx;
      const ha = a.road.hw;
      const hb = b.road.hw;
      // Solve N + da*t + na*ha = N + db*u + nb*hb.
      const rx = nbx * hb - nax * ha;
      const rz = nbz * hb - naz * ha;
      const det = a.dx * -b.dz - a.dz * -b.dx;
      if (Math.abs(det) < 1e-6) continue;
      const t = (rx * -b.dz - rz * -b.dx) / det;
      const cx = node.x + a.dx * t + nax * ha;
      const cz = node.z + a.dz * t + naz * ha;
      const service = a.road.cls === 'service' || b.road.cls === 'service';
      let R = service ? 1.5 : Math.max(a.road.rec.width, b.road.rec.width) > 14 ? 4.5 : 3.5;
      const half = phi / 2;
      let k = R / Math.tan(half);
      // Don't run past the end of either arm's road.
      const availA = (a.sign === 1 ? a.road.len - a.s : a.s) - Math.max(t, 0);
      const availB = (b.sign === 1 ? b.road.len - b.s : b.s) - Math.max(t, 0);
      const kMax = Math.max(0, Math.min(availA, availB) * 0.7);
      if (k > kMax) {
        k = kMax;
        R = k * Math.tan(half);
      }
      if (R < 0.4) continue;
      const tax = cx + a.dx * k;
      const taz = cz + a.dz * k;
      const tbx = cx + b.dx * k;
      const tbz = cz + b.dz * k;
      let bx = a.dx + b.dx;
      let bz = a.dz + b.dz;
      const bl = Math.hypot(bx, bz) || 1;
      bx /= bl;
      bz /= bl;
      const od = R / Math.sin(half);
      const ox = cx + bx * od;
      const oz = cz + bz * od;
      const poly = [cx, cz, tax, taz];
      const a0 = Math.atan2(taz - oz, tax - ox);
      let a1 = Math.atan2(tbz - oz, tbx - ox);
      // Arc on the side facing C: the short way round.
      let da = a1 - a0;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const steps = Math.max(3, Math.ceil(Math.abs(da) / 0.12));
      for (let j = 1; j < steps; j++) {
        const ang = a0 + (da * j) / steps;
        poly.push(ox + Math.cos(ang) * R, oz + Math.sin(ang) * R);
      }
      poly.push(tbx, tbz);
      node.fillets.push(poly);
    }
  }

  private buildCrossings(node: RoadNode): void {
    const majors = node.arms.filter((a) => a.road.major);
    for (const a of majors) {
      let d0 = 0;
      for (const b of majors) {
        if (b === a) continue;
        // The same street continuing on the far side (opposite direction) is not a crossing street.
        if (a.dx * b.dx + a.dz * b.dz < -0.85) continue;
        const sin = Math.abs(a.dx * b.dz - a.dz * b.dx);
        d0 = Math.max(d0, b.road.hw / Math.max(sin, 0.45));
      }
      if (d0 === 0) continue;
      d0 += 0.8;
      const band = 3.0;
      const avail = a.sign === 1 ? a.road.len - a.s : a.s;
      const r = a.road;
      if (avail < d0 + band + 2) {
        // Short link between two close intersections: just keep it clear of lane lines.
        const lo = a.sign === 1 ? a.s : a.s - avail;
        const hi = a.sign === 1 ? a.s + avail : a.s;
        r.clear.push([lo, hi]);
        continue;
      }
      const s0 = a.s + a.sign * d0;
      const s1 = a.s + a.sign * (d0 + band);
      // Approach lanes: traffic moving toward the node. Arm direction d points away from the node; approaching
      // traffic drives on the right of -d, i.e. the LEFT of d. In road (s) terms: sign=+1 → left (+1), sign=-1 → right (-1).
      let stopSide = a.sign === 1 ? 1 : -1;
      let stopS = a.s + a.sign * (d0 + band + 1.2);
      if (r.oneway) {
        // One-way: traffic flows along +s. It approaches the node only on arms that point back (sign -1).
        if (a.sign === 1) stopS = NaN;
        else stopSide = 0;
      }
      if (node.signal === false && !r.oneway && (RANK[r.kind] ?? 0) <= 2) stopS = NaN;
      r.crossings.push({ s0: Math.min(s0, s1), s1: Math.max(s0, s1), stopS, stopSide, node });
      const clearTo = d0 + band + 2.2;
      r.clear.push(a.sign === 1 ? [a.s - 0.01, a.s + clearTo] : [a.s - clearTo, a.s + 0.01]);
    }
  }

  /** Is arc length s on road r inside a cleared (intersection) interval? */
  isClear(r: Road, s: number): boolean {
    for (const [a, b] of r.clear) if (s >= a && s <= b) return true;
    return false;
  }
}
