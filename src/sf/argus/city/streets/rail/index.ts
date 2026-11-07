/**
 * Rail: embedded track decals for the F/E-line (standard gauge girder rails with grooves on a concrete band)
 * and the cable-car lines (3'6" gauge plus the central cable slot), overhead trolley wire for the F-line, and
 * animated vehicles: heritage PCC streetcars in varied liveries on Market St / The Embarcadero and California
 * Street cable cars shuttling up and down Nob Hill (dwelling at the Drumm St terminus).
 */
import * as THREE from 'three';
import type { GroundSurface } from '../core/surface';
import type { Road, RoadNet } from '../core/roadnet';
import { CTX, DZ, hash01, inRect } from '../core/zone';
import { Style } from '../markings/material';
import type { StripBuilder } from '../markings/strips';
import type { PropUniforms } from '../props/material';
import { createPropMaterial } from '../props/material';
import { cableCar, pccCar } from './models';

class Path {
  pts: number[] = [];
  cum: number[] = [0];
  len = 0;
  /** Arc lengths where a vehicle should dwell (seconds). */
  dwell: [number, number][] = [];
  append(r: Road, reverse = false): void {
    const n = r.pts.length / 2;
    for (let k = 0; k < n; k++) {
      const i = reverse ? n - 1 - k : k;
      const x = r.pts[i * 2];
      const z = r.pts[i * 2 + 1];
      const m = this.pts.length;
      if (m >= 2) {
        const d = Math.hypot(x - this.pts[m - 2], z - this.pts[m - 1]);
        if (d < 0.05) continue;
        this.len += d;
        this.cum.push(this.len);
      }
      this.pts.push(x, z);
    }
  }
  at(s: number, out = { x: 0, z: 0, dx: 1, dz: 0 }) {
    s = ((s % this.len) + this.len) % this.len;
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const L = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / L;
    const ax = this.pts[lo * 2];
    const az = this.pts[lo * 2 + 1];
    const bx = this.pts[hi * 2];
    const bz = this.pts[hi * 2 + 1];
    out.x = ax + (bx - ax) * t;
    out.z = az + (bz - az) * t;
    out.dx = (bx - ax) / L;
    out.dz = (bz - az) / L;
    return out;
  }
}

interface Vehicle {
  path: Path;
  s: number;
  speed: number;
  len: number;
  wait: number;
  mesh: THREE.InstancedMesh;
  index: number;
  lastDwell: number;
}

const LIVERIES = ['#2f6b46', '#c9a227', '#b8402c', '#2e5f8a', '#d8722b', '#3e7d5a', '#7a1f1f', '#e2c64a', '#4f6f2f', '#1f4f74'];
const CABLE_LIVERY = ['#7a1d17', '#7a1d17', '#7a1d17', '#2c4e7a', '#2f5e3c'];

export class RailSystem {
  readonly object = new THREE.Group();
  private vehicles: Vehicle[] = [];
  private tmp = { x: 0, z: 0, dx: 0, dz: 0 };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(
    private net: RoadNet,
    private surface: GroundSurface,
    uniforms: PropUniforms,
  ) {
    this.object.name = 'rail';
    const mat = createPropMaterial(uniforms, { instAttr: false });
    const byId = new Map<string, Road>();
    for (const r of net.roads) byId.set(r.rec.id, r);
    const chain = (ids: string[]): Path | null => {
      const p = new Path();
      for (const id of ids) {
        const r = byId.get(id);
        if (!r) return null;
        // Orient each piece so it continues from the current path end.
        if (p.pts.length) {
          const ex = p.pts[p.pts.length - 2];
          const ez = p.pts[p.pts.length - 1];
          const d0 = Math.hypot(r.pts[0] - ex, r.pts[1] - ez);
          const d1 = Math.hypot(r.pts[r.pts.length - 2] - ex, r.pts[r.pts.length - 1] - ez);
          p.append(r, d1 < d0);
        } else p.append(r);
      }
      return p.len > 50 ? p : null;
    };
    // F-line: Market St inbound → Ferry loop → Embarcadero northbound, and the reverse.
    const fNorth = chain(['R0479', 'R3184', 'R3204']) ?? this.findPath('Muni F');
    const fSouth = chain(['R1457', 'R3197', 'R3176']);
    // California St cable: eastbound down to Drumm, through the terminus, back west up the hill.
    const cal = chain(['R0003', 'R2652', 'R2657', 'R2708']);
    if (cal) {
      // Dwell where the line reverses at the Drumm St terminus.
      const p = new Path();
      p.append(byId.get('R0003')!);
      cal.dwell.push([p.len + 8, 22]);
    }

    // Powell St line (Powell–Mason / Powell–Hyde trunk between Market and Jackson): a shuttle over the two tracks.
    const powell = chain(['R0811', 'R0639']);

    const pcc = new THREE.InstancedMesh(pccCar(), mat, 12);
    pcc.castShadow = true;
    pcc.receiveShadow = true;
    pcc.frustumCulled = false;
    pcc.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(12 * 3), 3);
    pcc.name = 'streetcars';
    const cc = new THREE.InstancedMesh(cableCar(), mat, 8);
    cc.castShadow = true;
    cc.receiveShadow = true;
    cc.frustumCulled = false;
    cc.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(8 * 3), 3);
    cc.name = 'cableCars';
    this.object.add(pcc, cc);
    let ip = 0;
    let ic = 0;
    for (const path of [fNorth, fSouth]) {
      if (!path) continue;
      const n = 4;
      for (let k = 0; k < n; k++) {
        const v: Vehicle = { path, s: (path.len * (k + hash01(ip, 4) * 0.4)) / n, speed: 6.5 + hash01(ip, 7) * 1.5, len: 14.2, wait: 0, mesh: pcc, index: ip, lastDwell: -1 };
        pcc.setColorAt(ip, new THREE.Color(LIVERIES[ip % LIVERIES.length]));
        this.vehicles.push(v);
        ip++;
      }
    }
    if (powell) {
      for (let k = 0; k < 2; k++) {
        const v: Vehicle = { path: powell, s: (powell.len * k) / 2 + 60, speed: 4.2, len: 9.1, wait: 0, mesh: cc, index: ic, lastDwell: -1 };
        cc.setColorAt(ic, new THREE.Color('#7a1d17'));
        this.vehicles.push(v);
        ic++;
      }
    }
    if (cal) {
      for (let k = 0; k < 4; k++) {
        const v: Vehicle = { path: cal, s: (cal.len * k) / 4 + 30, speed: 4.2, len: 9.1, wait: 0, mesh: cc, index: ic, lastDwell: -1 };
        cc.setColorAt(ic, new THREE.Color(CABLE_LIVERY[ic % CABLE_LIVERY.length]));
        this.vehicles.push(v);
        ic++;
      }
    }
    pcc.count = ip;
    cc.count = ic;
    this.update(0);
  }

  private findPath(name: string): Path | null {
    const r = this.net.roads.filter((x) => x.rec.name === name).sort((a, b) => b.len - a.len)[0];
    if (!r) return null;
    const p = new Path();
    p.append(r);
    return p;
  }

  /** Track decals (bed, rails, grooves / cable slot) and the F-line trolley wire. */
  addTracks(sb: StripBuilder): void {
    const H = (x: number, z: number) => this.surface.top(x, z);
    const wire: number[] = [];
    for (const r of this.net.roads) {
      if (r.cls !== 'rail' && r.cls !== 'cable') continue;
      const mid = this.net.at(r, r.len / 2);
      if (!inRect(CTX, mid.x, mid.z, 30) || !inRect(DZ, mid.x, mid.z)) continue;
      const cable = r.cls === 'cable';
      const gauge = cable ? 1.067 : 1.435;
      const pts: number[] = [];
      // Resample every 3 m for draping.
      for (let s = 0; s <= r.len; s += 3) {
        const p = this.net.at(r, s);
        pts.push(p.x, p.z);
      }
      const e = this.net.at(r, r.len);
      pts.push(e.x, e.z);
      const offset = (o: number): number[] => {
        const out: number[] = [];
        const n = pts.length / 2;
        for (let i = 0; i < n; i++) {
          const ip = Math.max(0, i - 1);
          const inx = Math.min(n - 1, i + 1);
          let tx = pts[inx * 2] - pts[ip * 2];
          let tz = pts[inx * 2 + 1] - pts[ip * 2 + 1];
          const l = Math.hypot(tx, tz) || 1;
          tx /= l;
          tz /= l;
          out.push(pts[i * 2] + tz * o, pts[i * 2 + 1] - tx * o);
        }
        return out;
      };
      sb.add(pts, cable ? 1.15 : 1.35, Style.TrackBed, 0, H, 0.018);
      for (const s of [-1, 1]) {
        sb.add(offset((s * gauge) / 2), 0.036, Style.Rail, 0, H, 0.03);
        sb.add(offset((s * gauge) / 2 - s * 0.06), 0.018, Style.Slot, 0, H, 0.026);
      }
      if (cable) {
        sb.add(pts, 0.012, Style.Slot, 0, H, 0.028);
        for (const s of [-1, 1]) sb.add(offset(s * 0.035), 0.016, Style.Rail, 0, H, 0.03);
      } else {
        // Overhead trolley wire ~5.8 m above the rail, slight sag between hangers every 30 m.
        const n = pts.length / 2;
        for (let i = 0; i < n - 1; i++) {
          const x0 = pts[i * 2];
          const z0 = pts[i * 2 + 1];
          const x1 = pts[i * 2 + 2];
          const z1 = pts[i * 2 + 3];
          const sag = (k: number) => 0.18 * Math.sin(((((i + k) * 3) % 30) / 30) * Math.PI);
          wire.push(x0, H(x0, z0) + 5.8 - sag(0), z0, x1, H(x1, z1) + 5.8 - sag(1), z1);
        }
      }
    }
    if (wire.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x15181a, transparent: true, opacity: 0.55 }));
      lines.name = 'trolleyWire';
      lines.frustumCulled = true;
      this.object.add(lines);
    }
  }

  update(dt: number): void {
    const P = this.tmp;
    const dirty = new Set<THREE.InstancedMesh>();
    for (const v of this.vehicles) {
      if (v.wait > 0) v.wait -= dt;
      else {
        const before = v.s;
        v.s += v.speed * Math.min(dt, 0.1);
        for (const [ds, secs] of v.path.dwell) {
          if (before < ds && v.s >= ds) {
            v.wait = secs;
            v.s = ds;
          }
        }
        if (v.s > v.path.len) v.s -= v.path.len;
      }
      // Body pose from the two trucks (pitch follows the hill).
      const half = v.len * 0.32;
      const f = v.path.at(v.s + half, { ...P });
      const b = v.path.at(v.s - half, { ...P });
      const yf = this.surface.top(f.x, f.z);
      const yb = this.surface.top(b.x, b.z);
      const cx = (f.x + b.x) / 2;
      const cz = (f.z + b.z) / 2;
      const yaw = Math.atan2(f.x - b.x, f.z - b.z);
      const pitch = -Math.atan2(yf - yb, Math.hypot(f.x - b.x, f.z - b.z));
      this.e.set(pitch, yaw, 0);
      this.q.setFromEuler(this.e);
      this.m.compose(new THREE.Vector3(cx, (yf + yb) / 2 + 0.02, cz), this.q, new THREE.Vector3(1, 1, 1));
      v.mesh.setMatrixAt(v.index, this.m);
      dirty.add(v.mesh);
    }
    for (const m of dirty) m.instanceMatrix.needsUpdate = true;
  }
}
