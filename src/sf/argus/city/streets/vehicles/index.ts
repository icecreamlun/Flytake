/**
 * Vehicles: parked cars along every parking lane (static, slope-aligned) and moving traffic.
 *
 * Traffic model: every major street contributes directional lanes (one-way rules respected). Vehicles drive
 * along a lane keeping a safe gap to the vehicle ahead, then at the lane end pick a successor lane at the same
 * node (preferring straight-on / same street, never a U-turn), and cross the intersection on a quadratic
 * Bézier between the trimmed lane ends. If the successor's entry is occupied they wait. Vehicles that run off
 * the network respawn at an entry lane on the edge of the data area. Market Street carries buses and taxis only.
 * Rendering: per type a near (detailed) and far (box) CulledSet; matrices recomputed each frame.
 */
import * as THREE from 'three';
import type { GroundSurface } from '../core/surface';
import type { Road, RoadNet } from '../core/roadnet';
import { CTX, hash01, inRect, insideDist, rng } from '../core/zone';
import { CulledSet } from '../props/culled';
import { createPropMaterial, type PropUniforms } from '../props/material';
import { VEHICLE_LEN, VEHICLE_WID, VTYPE_COUNT, VType, vehicleGeometry } from './models';

/** LOD switch distances (m): near (full kit) < D_NEAR ≤ mid < D_MID ≤ far < D_FAR. */
const D_NEAR = 110;
const D_MID = 340;
const D_FAR = 900;

/** Soft rounded-rectangle falloff for the contact-shadow blobs. */
function blobTexture(): THREE.Texture {
  const N = 64;
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const u = Math.abs((i + 0.5) / N - 0.5) * 2;
      const v = Math.abs((j + 0.5) / N - 0.5) * 2;
      // Rounded-rectangle distance (superellipse), soft edge.
      const d = Math.pow(Math.pow(u, 6) + Math.pow(v, 6), 1 / 6);
      const a = Math.max(0, Math.min(1, (1 - d) / 0.45));
      const o = (j * N + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(255 * a * a * (3 - 2 * a));
    }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

interface Lane {
  road: Road;
  dir: 1 | -1;
  o: number;
  len: number;
  /** Trim at start/end (intersection clearance). */
  t0: number;
  t1: number;
  endKey: string;
  startKey: string;
  next: Lane[];
  cars: Car[];
  vmax: number;
  transit: boolean;
  index: number;
}

interface Car {
  type: VType;
  lane: Lane;
  s: number;
  v: number;
  vmax: number;
  len: number;
  set: number; // instance index in near/far sets
  turn: { p0: THREE.Vector3; p1: THREE.Vector3; p2: THREE.Vector3; t: number; L: number; to: Lane } | null;
  color: THREE.Color;
}

const PAINT: [string, number][] = [
  ['#e8e8e6', 0.24],
  ['#121314', 0.2],
  ['#5d6265', 0.16],
  ['#a7abae', 0.14],
  ['#1f3f6e', 0.08],
  ['#8e1b17', 0.08],
  ['#2f4a3a', 0.03],
  ['#8a7a62', 0.03],
  ['#4a3428', 0.02],
  ['#c9b26f', 0.02],
];

function paint(r: number): THREE.Color {
  let acc = 0;
  for (const [c, w] of PAINT) {
    acc += w;
    if (r < acc) return new THREE.Color(c);
  }
  return new THREE.Color(PAINT[0][0]);
}

const key = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
const VMAX: Record<string, number> = { motorway: 15, primary: 11, secondary: 10, tertiary: 9, residential: 7, living_street: 4, service: 5 };

export class Vehicles {
  readonly object = new THREE.Group();
  private near: CulledSet[] = [];
  private mid: CulledSet[] = [];
  private far: CulledSet[] = [];
  private blobs: { mesh: THREE.InstancedMesh; set: CulledSet }[] = [];
  private sets: CulledSet[] = [];
  private lanes: Lane[] = [];
  private sources: Lane[] = [];
  private cars: Car[] = [];
  private P = { x: 0, z: 0, dx: 0, dz: 0 };
  private Q = { x: 0, z: 0, dx: 0, dz: 0 };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private v3 = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private rand = rng(4242);

  constructor(
    private net: RoadNet,
    private surface: GroundSurface,
    uniforms: PropUniforms,
  ) {
    this.object.name = 'vehicles';
    const mat = createPropMaterial(uniforms, { instAttr: false, physical: false });
    const blobTex = blobTexture();
    const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: blobTex, transparent: true, opacity: 0.62, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (let t = 0; t < VTYPE_COUNT; t++) {
      const n = new CulledSet(vehicleGeometry(t, 0), mat, 4000, { colors: true, maxDist: D_NEAR, name: `veh${t}-near` });
      const m = new CulledSet(vehicleGeometry(t, 1), mat, 4000, { colors: true, minDist: D_NEAR, maxDist: D_MID, name: `veh${t}-mid` });
      const f = new CulledSet(vehicleGeometry(t, 2), mat, 4000, { colors: true, minDist: D_MID, maxDist: D_FAR, shadows: false, name: `veh${t}-far` });
      this.near.push(n);
      this.mid.push(m);
      this.far.push(f);
      this.sets.push(n, m, f);
      this.object.add(n.mesh, m.mesh, f.mesh);
      // Ambient-occlusion contact blob under the body: shares the LOD set's packed instance matrices.
      const L = VEHICLE_LEN[t];
      const W = VEHICLE_WID[t];
      const bg = new THREE.PlaneGeometry(W + 0.7, L + 0.8);
      bg.rotateX(-Math.PI / 2);
      bg.translate(0, 0.02, 0);
      for (const set of [n, m]) {
        const bm = new THREE.InstancedMesh(bg, blobMat, 1);
        bm.instanceMatrix = set.mesh.instanceMatrix;
        bm.count = 0;
        bm.frustumCulled = false;
        bm.castShadow = false;
        bm.receiveShadow = false;
        bm.renderOrder = 2;
        bm.name = `veh${t}-ao`;
        this.blobs.push({ mesh: bm, set });
        this.object.add(bm);
      }
    }
    this.placeParked();
    this.buildLanes();
    this.spawnTraffic();
  }

  // ───────────────────────── parked cars ─────────────────────────
  private placeParked(): void {
    const r = rng(77);
    const P = this.P;
    for (const road of this.net.roads) {
      const L = road.layout;
      if (!road.major || !L || (!L.parkL && !L.parkR)) continue;
      const mid = this.net.at(road, road.len / 2, P);
      if (!inRect(CTX, mid.x, mid.z, -15)) continue;
      for (const side of [1, -1]) {
        const pw = side === 1 ? L.parkL : L.parkR;
        if (!pw) continue;
        const o = side * (road.rec.width / 2 - pw / 2);
        // Parked cars face the direction of traffic on their side.
        const heading = road.oneway ? 1 : side === 1 ? -1 : 1;
        for (let s = 6; s < road.len - 6; s += 6.3) {
          if (r() < 0.27) continue;
          if (road.crossings.some((c) => s > c.s0 - 7 && s < c.s1 + 7)) continue;
          if (road.nodeS.some((ns) => Math.abs(ns - s) < 9)) continue;
          const u = r();
          const type = u < 0.38 ? VType.Sedan : u < 0.6 ? VType.Hatch : u < 0.84 ? VType.Suv : u < 0.93 ? VType.Van : u < 0.97 ? VType.Pickup : VType.Truck;
          const color = (type === VType.Van || type === VType.Truck) && r() < 0.7 ? new THREE.Color('#e8e8e6') : paint(r());
          const sj = s + (r() - 0.5) * 0.8;
          this.net.at(road, sj, P);
          const x = P.x + P.dz * o;
          const z = P.z - P.dx * o;
          this.pose(x, z, P.dx * heading, P.dz * heading, VEHICLE_LEN[type], this.m, 0.02);
          this.addAll(type, this.m, color);
        }
      }
    }
  }

  /** Register one instance in all three LOD sets (same index in each). */
  private addAll(type: VType, m: THREE.Matrix4, color: THREE.Color): number {
    const r = type === VType.Bus ? 7 : type === VType.Truck ? 4.5 : 3.2;
    const i = this.near[type].add(m, r, color);
    this.mid[type].add(m, r, color);
    this.far[type].add(m, r, color);
    return i;
  }

  /** Body pose on the ground: yaw from (dx,dz), pitch/roll from the surface under the wheels. */
  private pose(x: number, z: number, dx: number, dz: number, len: number, out: THREE.Matrix4, lift = 0, onTop = false): void {
    const S = this.surface;
    const H = onTop ? (a: number, b: number) => S.top(a, b) : (a: number, b: number) => S.meshHeight(a, b);
    const hl = len * 0.35;
    const hw = 0.8;
    const yf = H(x + dx * hl, z + dz * hl);
    const yb = H(x - dx * hl, z - dz * hl);
    const yl = H(x + dz * hw, z - dx * hw);
    const yr = H(x - dz * hw, z + dx * hw);
    const yaw = Math.atan2(dx, dz);
    const pitch = -Math.atan2(yf - yb, 2 * hl);
    const roll = Math.atan2(yl - yr, 2 * hw);
    this.e.set(pitch, yaw, roll);
    this.q.setFromEuler(this.e);
    out.compose(this.v3.set(x, (yf + yb) / 2 + lift, z), this.q, this.one);
  }

  /** A static parked vehicle (e.g. in a parking lot at sidewalk level). */
  addParked(x: number, z: number, dx: number, dz: number, seed: number): void {
    const u = hash01(seed, 31);
    const type = u < 0.42 ? VType.Sedan : u < 0.66 ? VType.Hatch : u < 0.9 ? VType.Suv : u < 0.96 ? VType.Van : VType.Pickup;
    const color = type === VType.Van && u > 0.93 ? new THREE.Color('#e8e8e6') : paint(hash01(seed, 37));
    this.pose(x, z, dx, dz, VEHICLE_LEN[type], this.m, 0.02, true);
    this.addAll(type, this.m, color);
  }

  // ───────────────────────── lanes ─────────────────────────
  private buildLanes(): void {
    const nodeAt = new Map<string, { clear: number }>();
    for (const n of this.net.nodes) {
      let c = 0;
      if (n.arms.length >= 3) for (const a of n.arms) c = Math.max(c, a.road.hw);
      nodeAt.set(key(n.x, n.z), { clear: n.arms.length >= 3 ? c + 1.5 : 0 });
    }
    const starts = new Map<string, Lane[]>();
    for (const r of this.net.roads) {
      if (!r.major || !r.layout || r.len < 8) continue;
      const mid = this.net.at(r, r.len / 2);
      if (!inRect(CTX, mid.x, mid.z, 20)) continue;
      const L = r.layout;
      const k0 = key(r.pts[0], r.pts[1]);
      const k1 = key(r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]);
      const c0 = nodeAt.get(k0)?.clear ?? 0;
      const c1 = nodeAt.get(k1)?.clear ?? 0;
      const travel0 = -r.rec.width / 2 + L.parkR + L.bikeR;
      const vmax = VMAX[r.kind] ?? 7;
      const mk = (dir: 1 | -1, o: number, index: number, transit: boolean) => {
        const lane: Lane = {
          road: r,
          dir,
          o,
          len: r.len,
          t0: dir === 1 ? c0 : c1,
          t1: dir === 1 ? c1 : c0,
          startKey: dir === 1 ? k0 : k1,
          endKey: dir === 1 ? k1 : k0,
          next: [],
          cars: [],
          vmax,
          transit,
          index,
        };
        if (lane.len - lane.t0 - lane.t1 < 4) return;
        this.lanes.push(lane);
        let l = starts.get(lane.startKey);
        if (!l) starts.set(lane.startKey, (l = []));
        l.push(lane);
      };
      const market = r.rec.name === 'Market Street';
      for (let k = 0; k < L.nf; k++) mk(1, travel0 + (k + 0.5) * L.lw, k, market);
      for (let k = 0; k < L.nb; k++) mk(-1, L.centre + (k + 0.5) * L.lw, k, market);
    }
    for (const lane of this.lanes) {
      lane.next = (starts.get(lane.endKey) ?? []).filter((n) => n.road !== lane.road);
      // Entry lanes: start at the edge of the data area or at a dead end.
      const p = this.laneAt(lane, lane.t0, this.P);
      if (insideDist(CTX, p.x, p.z) < 80) this.sources.push(lane);
    }
    if (!this.sources.length) this.sources = this.lanes.slice();
  }

  /** World position / heading on a lane at lane-arc s. */
  private laneAt(lane: Lane, s: number, out: { x: number; z: number; dx: number; dz: number }) {
    const r = lane.road;
    const rs = lane.dir === 1 ? s : r.len - s;
    const Q = this.Q;
    this.net.at(r, Math.max(0, rs - 1.5), Q);
    const ax = Q.x;
    const az = Q.z;
    this.net.at(r, Math.min(r.len, rs + 1.5), Q);
    let tx = Q.x - ax;
    let tz = Q.z - az;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    this.net.at(r, rs, out);
    out.x += tz * lane.o;
    out.z -= tx * lane.o;
    out.dx = tx * lane.dir;
    out.dz = tz * lane.dir;
    return out;
  }

  private spawnTraffic(): void {
    // Collect candidate spawn points on every lane, then keep transit lanes (Market St buses/taxis) first and a
    // deterministic shuffle of the rest so the vehicle cap spreads traffic evenly over the network.
    const cand: { lane: Lane; s: number; k: number }[] = [];
    let id = 0;
    for (const lane of this.lanes) {
      const p = this.laneAt(lane, lane.len / 2, this.P);
      const core = insideDist(CTX, p.x, p.z) > 300 ? 1 : 0.5;
      const density = (lane.transit ? 1 / 55 : lane.road.kind === 'residential' ? 1 / 70 : 1 / 42) * core;
      const usable = lane.len - lane.t0 - lane.t1;
      const n = Math.floor(usable * density + hash01(id++, 3));
      for (let k = 0; k < n; k++) cand.push({ lane, s: lane.t0 + ((k + 0.5) / n) * usable, k: lane.transit ? -1 : hash01(id, k + 7) });
    }
    cand.sort((a, b) => a.k - b.k);
    let cid = 0;
    for (const c of cand.slice(0, 760)) this.addCar(c.lane, c.s, cid++);
  }

  private addCar(lane: Lane, s: number, id: number): void {
    const u = hash01(id, 11);
    let type: VType;
    if (lane.transit) type = u < 0.45 ? VType.Bus : VType.Taxi;
    else type = u < 0.34 ? VType.Sedan : u < 0.54 ? VType.Hatch : u < 0.76 ? VType.Suv : u < 0.85 ? VType.Van : u < 0.89 ? VType.Pickup : u < 0.94 ? VType.Truck : VType.Taxi;
    const color =
      type === VType.Taxi
        ? new THREE.Color('#e9b51c')
        : type === VType.Van
          ? new THREE.Color(u < 0.83 ? '#e8e8e6' : '#7b2a1e')
          : type === VType.Truck
            ? new THREE.Color(['#e8e8e6', '#e8e8e6', '#c7c9c8', '#1f4e8c', '#b8352a'][Math.floor(hash01(id, 19) * 5)])
            : type === VType.Bus
              ? new THREE.Color('#ffffff')
              : paint(hash01(id, 17));
    this.pose(0, 0, 0, 1, 4, this.m);
    const ni = this.addAll(type, this.m, color);
    const car: Car = { type, lane, s, v: lane.vmax * 0.8, vmax: lane.vmax * (0.85 + 0.25 * hash01(id, 5)), len: VEHICLE_LEN[type], set: ni, turn: null, color };
    if (type === VType.Bus) car.vmax = Math.min(car.vmax, 8);
    lane.cars.push(car);
    lane.cars.sort((a, b) => a.s - b.s);
    this.cars.push(car);
  }

  private pickNext(car: Car): Lane | null {
    const L = car.lane;
    if (!L.next.length) return null;
    const end = this.laneAt(L, L.len - L.t1, this.P);
    const hx = end.dx;
    const hz = end.dz;
    let best: Lane | null = null;
    let bestW = -1;
    for (const n of L.next) {
      if (n.transit && car.type !== VType.Bus && car.type !== VType.Taxi) continue;
      if (car.type === VType.Bus && !n.transit && L.next.some((x) => x.transit)) continue;
      const p = this.laneAt(n, n.t0 + 1, this.Q);
      const straight = hx * p.dx + hz * p.dz; // 1 straight, 0 turn, -1 U-turn
      if (straight < -0.5) continue;
      const same = n.road.rec.name && n.road.rec.name === L.road.rec.name ? 1.5 : 0;
      const laneMatch = 1 / (1 + Math.abs(n.index - L.index));
      const w = (straight > 0.7 ? 3 : 1) + same + laneMatch + this.rand() * 2.2;
      if (w > bestW) {
        bestW = w;
        best = n;
      }
    }
    return best;
  }

  update(dt: number, planes: THREE.Plane[], cam: THREE.Vector3): void {
    dt = Math.min(dt, 0.1);
    for (const lane of this.lanes) {
      const cs = lane.cars;
      if (cs.length > 1) cs.sort((a, b) => a.s - b.s);
      for (let i = cs.length - 1; i >= 0; i--) {
        const car = cs[i];
        if (car.turn) continue;
        const lead = cs[i + 1];
        const endS = lane.len - lane.t1;
        let gap = lead ? lead.s - lead.len / 2 - (car.s + car.len / 2) : Infinity;
        // Approaching the lane end: is the next lane's entry free?
        let next: Lane | null = null;
        if (endS - car.s < 25) {
          next = (car as Car & { _next?: Lane | null })._next ?? null;
          if (next === null) {
            next = this.pickNext(car);
            (car as Car & { _next?: Lane | null })._next = next;
          }
          if (next) {
            const tail = next.cars[0];
            const free = !tail || tail.s - tail.len / 2 > next.t0 + 4;
            if (!free) gap = Math.min(gap, endS - car.s - car.len / 2 - 1);
          }
        }
        const vt = Math.min(car.vmax, Math.max(0, (gap - 2.5) / 1.1));
        const a = vt > car.v ? 2.2 : -7;
        car.v = Math.max(0, car.v + Math.max(-7 * dt, Math.min(2.2 * dt, a * dt * Math.min(1, Math.abs(vt - car.v)))));
        if (vt < car.v) car.v = Math.max(vt, car.v - 7 * dt);
        car.s += car.v * dt;
        if (car.s >= endS) this.leaveLane(car, next);
      }
    }
    // Turning vehicles follow their Bézier, then enter the next lane.
    for (const car of this.cars) {
      if (!car.turn) continue;
      const T = car.turn;
      T.t += (car.v * dt) / Math.max(1, T.L);
      if (T.t >= 1) {
        car.turn = null;
        car.s = T.to.t0;
        (car as Car & { _next?: Lane | null })._next = null;
      } else car.s = T.to.t0 - (1 - T.t) * T.L;
    }
    // Poses.
    for (const car of this.cars) {
      if (car.turn) {
        const T = car.turn;
        const t = T.t;
        const u = 1 - t;
        const x = u * u * T.p0.x + 2 * u * t * T.p1.x + t * t * T.p2.x;
        const z = u * u * T.p0.z + 2 * u * t * T.p1.z + t * t * T.p2.z;
        let dx = 2 * u * (T.p1.x - T.p0.x) + 2 * t * (T.p2.x - T.p1.x);
        let dz = 2 * u * (T.p1.z - T.p0.z) + 2 * t * (T.p2.z - T.p1.z);
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
        this.pose(x, z, dx, dz, car.len, this.m);
      } else {
        const p = this.laneAt(car.lane, car.s, this.P);
        this.pose(p.x, p.z, p.dx, p.dz, car.len, this.m);
      }
      this.near[car.type].setMatrix(car.set, this.m);
      this.mid[car.type].setMatrix(car.set, this.m);
      this.far[car.type].setMatrix(car.set, this.m);
    }
    for (const s of this.sets) s.update(planes, cam);
    for (const b of this.blobs) b.mesh.count = b.set.mesh.count;
  }

  private leaveLane(car: Car, next: Lane | null): void {
    const lane = car.lane;
    const i = lane.cars.indexOf(car);
    if (i >= 0) lane.cars.splice(i, 1);
    if (!next) next = this.pickNext(car);
    if (!next) {
      // Off the network: respawn at an entry lane on the data edge.
      for (let tries = 0; tries < 20; tries++) {
        const src = this.sources[Math.floor(this.rand() * this.sources.length)];
        if (src.transit && car.type !== VType.Bus && car.type !== VType.Taxi) continue;
        if (car.type === VType.Bus && !src.transit) continue;
        const tail = src.cars[0];
        if (tail && tail.s - tail.len / 2 < src.t0 + 8) continue;
        car.lane = src;
        car.s = src.t0;
        src.cars.unshift(car);
        (car as Car & { _next?: Lane | null })._next = null;
        return;
      }
      car.lane = lane;
      car.s = lane.t0;
      lane.cars.unshift(car);
      return;
    }
    const a = this.laneAt(lane, lane.len - lane.t1, this.P);
    const b = this.laneAt(next, next.t0, this.Q);
    const p0 = new THREE.Vector3(a.x, 0, a.z);
    const p2 = new THREE.Vector3(b.x, 0, b.z);
    // Control point: intersection of the two heading lines (fallback: midpoint).
    const det = a.dx * -b.dz - a.dz * -b.dx;
    let p1: THREE.Vector3;
    if (Math.abs(det) > 0.15) {
      const rx = b.x - a.x;
      const rz = b.z - a.z;
      const t = (rx * -b.dz - rz * -b.dx) / det;
      p1 = new THREE.Vector3(a.x + a.dx * t, 0, a.z + a.dz * t);
      if (t < 0 || t > 60) p1 = p0.clone().add(p2).multiplyScalar(0.5);
    } else p1 = p0.clone().add(p2).multiplyScalar(0.5);
    const L = p0.distanceTo(p1) + p1.distanceTo(p2);
    car.turn = { p0, p1, p2, t: 0, L, to: next };
    car.v = Math.max(car.v, 3);
    // Reserve the entry of the next lane right away (virtual position before its start).
    car.lane = next;
    car.s = next.t0 - L;
    next.cars.unshift(car);
  }
}
