/**
 * Street furniture placement (instanced, CPU-culled) and the baked night light-pool map.
 *  - lamps: Path of Gold triple globes on Market St, dragon-lantern lamps on Chinatown's Grant Ave,
 *    cobra-heads elsewhere, acorn post-tops along the Embarcadero promenade;
 *  - traffic signals on every approach of signalised intersections (phase groups by street axis);
 *  - hydrants, trash cans, news racks, parking meters, benches, Muni shelters, Grant Ave lantern strings.
 * Light pools: radial falloff per lamp painted additively into a 2 m/px canvas over the detail zone, used by
 * the ground shader as night irradiance.
 */
import * as THREE from 'three';
import type { CityData } from '../../../contracts';
import type { GroundSurface } from '../core/surface';
import type { Road, RoadNet } from '../core/roadnet';
import { CORE_BBOX, project } from '../../../geo';
import { CTX, DZ, hash01, inRect, type Rect } from '../core/zone';
import { CulledSet } from './culled';
import { createPropMaterial, type PropUniforms } from './material';
import * as M from './models';

const CORE: Rect = (() => {
  const [x0, z0] = project(CORE_BBOX.north, CORE_BBOX.west);
  const [x1, z1] = project(CORE_BBOX.south, CORE_BBOX.east);
  return { minX: x0, minZ: z0, maxX: x1, maxZ: z1 };
})();

/** Grant Ave between Bush St (gate) and Broadway: Chinatown proper. */
const inChinatownGrant = (r: Road, z: number) => r.rec.name === 'Grant Avenue' && z < 330 && z > -470;

interface Pool {
  x: number;
  z: number;
  r: number;
  c: [number, number, number];
}

export class StreetProps {
  readonly object = new THREE.Group();
  readonly uniforms: PropUniforms = { uTime: { value: 0 }, uLamp: { value: 0 }, uSig: { value: 1 }, uVeh: { value: 0 }, uNight: { value: 0 } };
  readonly sets: CulledSet[] = [];
  readonly pools: Pool[] = [];
  lightMap: THREE.CanvasTexture | null = null;
  private occupied = new Map<number, number[]>();
  private bldMask: Uint8Array;
  private bmW: number;

  constructor(
    private city: CityData,
    private net: RoadNet,
    private surface: GroundSurface,
  ) {
    this.object.name = 'streetProps';
    this.bmW = (DZ.maxX - DZ.minX) / 2;
    this.bldMask = this.rasterBuildings();
    const mat = createPropMaterial(this.uniforms);
    const set = (g: THREE.BufferGeometry, cap: number, o: { colors?: boolean; shadows?: boolean; maxDist?: number; name: string }) => {
      const s = new CulledSet(g, mat, cap, { inst: true, ...o });
      this.sets.push(s);
      this.object.add(s.mesh);
      return s;
    };
    const S = {
      cobra: set(M.cobraLamp(), 6000, { maxDist: 1000, name: 'lamp-cobra' }),
      gold: set(M.pathOfGold(), 600, { maxDist: 1000, name: 'lamp-pathOfGold' }),
      china: set(M.chinatownLamp(), 400, { maxDist: 900, name: 'lamp-chinatown' }),
      acorn: set(M.acornLamp(), 1500, { maxDist: 800, name: 'lamp-acorn' }),
      signal: set(M.signalPole(), 3000, { maxDist: 550, name: 'signals' }),
      hydrant: set(M.hydrant(), 3000, { colors: true, shadows: false, maxDist: 200, name: 'hydrants' }),
      trash: set(M.trashCan(), 2000, { shadows: false, maxDist: 200, name: 'trash' }),
      news: set(M.newsBox(), 2000, { colors: true, shadows: false, maxDist: 180, name: 'newsracks' }),
      meter: set(M.parkingMeter(), 8000, { shadows: false, maxDist: 140, name: 'meters' }),
      bench: set(M.bench(), 800, { shadows: false, maxDist: 200, name: 'benches' }),
      shelter: set(M.muniShelter(), 200, { maxDist: 800, name: 'shelters' }),
      lantern: set(M.lantern(), 3000, { maxDist: 900, shadows: false, name: 'lanterns' }),
      bollard: set(M.bollard(), 2000, { maxDist: 200, shadows: false, name: 'bollards' }),
    };
    this.place(S);
    this.bakePools();
  }

  /** 2 m raster of building footprints (props must never stand inside a building). */
  private rasterBuildings(): Uint8Array {
    const W = this.bmW;
    const H = (DZ.maxZ - DZ.minZ) / 2;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.setTransform(0.5, 0, 0, 0.5, -DZ.minX / 2, -DZ.minZ / 2);
    g.fillStyle = '#fff';
    for (const b of this.city.buildings) {
      if (b.overWater && b.baseElevation < 0) continue;
      g.beginPath();
      g.moveTo(b.footprint[0][0], b.footprint[0][1]);
      for (let i = 1; i < b.footprint.length; i++) g.lineTo(b.footprint[i][0], b.footprint[i][1]);
      g.closePath();
      g.fill();
    }
    const d = g.getImageData(0, 0, W, H).data;
    const out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
    return out;
  }

  private inBuilding(x: number, z: number): boolean {
    const i = Math.floor((x - DZ.minX) / 2);
    const j = Math.floor((z - DZ.minZ) / 2);
    if (i < 0 || j < 0 || i >= this.bmW || j >= this.bldMask.length / this.bmW) return false;
    return this.bldMask[j * this.bmW + i] > 20;
  }

  /** Reserve a spot (min spacing r) — returns false when something is already there. */
  private claim(x: number, z: number, r: number): boolean {
    const cs = 4;
    const cx = Math.floor(x / cs);
    const cz = Math.floor(z / cs);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const l = this.occupied.get((cx + dx) * 100003 + cz + dz);
        if (!l) continue;
        for (let k = 0; k < l.length; k += 3) if (Math.hypot(l[k] - x, l[k + 1] - z) < Math.max(r, l[k + 2])) return false;
      }
    const key = cx * 100003 + cz;
    let l = this.occupied.get(key);
    if (!l) this.occupied.set(key, (l = []));
    l.push(x, z, r);
    return true;
  }

  private okSpot(x: number, z: number): boolean {
    return inRect(CTX, x, z, -20) && this.surface.blockAt(x, z) > 0.75 && !this.inBuilding(x, z);
  }

  /** Is s inside a crosswalk band (± margin) on road r? */
  private onCrossing(r: Road, s: number, margin: number): boolean {
    for (const c of r.crossings) if (s > c.s0 - margin && s < c.s1 + margin) return true;
    return false;
  }

  private place(S: Record<string, CulledSet>): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const P = { x: 0, z: 0, dx: 0, dz: 0 };
    const put = (set: CulledSet, x: number, z: number, faceX: number, faceZ: number, radius: number, color?: THREE.Color, inst: [number, number, number, number] = [0, 0, Math.random(), 0], yOff = 0) => {
      // Local +X → (faceX, faceZ).
      q.setFromAxisAngle(up, Math.atan2(-faceZ, faceX));
      m.compose(new THREE.Vector3(x, this.surface.top(x, z) + yOff, z), q, new THREE.Vector3(1, 1, 1));
      return set.add(m, radius, color, inst);
    };

    let seed = 1;
    for (const r of this.net.roads) {
      if (!r.major) continue;
      const mid = this.net.at(r, r.len / 2, P);
      if (!inRect(CTX, mid.x, mid.z, 50)) continue;
      const name = r.rec.name ?? '';
      const market = name === 'Market Street';
      const emb = name === 'The Embarcadero';
      const W = r.rec.width;
      const narrow = W < 9 && r.kind === 'residential';
      const spacing = market ? 30 : narrow ? 42 : 34;
      const L = r.layout;
      for (const side of [1, -1]) {
        const off = r.hw + 0.55;
        const phase = side === 1 ? spacing / 2 : 0;
        if (narrow && side === 1) continue;
        // ── Lamps.
        for (let s = phase + 6; s < r.len - 4; s += spacing) {
          if (this.onCrossing(r, s, 1.5)) continue;
          this.net.at(r, s, P);
          const lx = P.dz;
          const lz = -P.dx;
          const x = P.x + lx * off * side;
          const z = P.z + lz * off * side;
          if (!this.okSpot(x, z) || !this.claim(x, z, 2)) continue;
          const fx = -lx * side;
          const fz = -lz * side;
          const inst: [number, number, number, number] = [0, 0, hash01(seed++, 3), 0];
          if (market) {
            put(S.gold, x, z, fx, fz, 6, undefined, inst);
            this.pools.push({ x: x + fx * 0.5, z: z + fz * 0.5, r: 12, c: [1.0, 0.76, 0.5] });
          } else if (inChinatownGrant(r, z)) {
            put(S.china, x, z, fx, fz, 4, undefined, inst);
            this.pools.push({ x, z, r: 9, c: [1.0, 0.5, 0.26] });
          } else {
            put(S.cobra, x, z, fx, fz, 6, undefined, inst);
            this.pools.push({ x: x + fx * 2.4, z: z + fz * 2.4, r: emb ? 16 : 14, c: [1.0, 0.86, 0.68] });
          }
        }
        // ── Chinatown: extra lamps between (denser) and lantern strings across Grant Ave.
        // ── Hydrants (~every 85 m), trash cans and news racks near corners, parking meters along parking lanes.
        for (let s = (side === 1 ? 20 : 55) + (seed % 7); s < r.len - 10; s += 85) {
          if (this.onCrossing(r, s, 2)) continue;
          this.net.at(r, s, P);
          const x = P.x + P.dz * (r.hw + 0.5) * side;
          const z = P.z - P.dx * (r.hw + 0.5) * side;
          if (!this.okSpot(x, z) || !this.claim(x, z, 1.2)) continue;
          const caps = ['#2e6bd1', '#c2271d', '#e9e6df', '#1d1d1d', '#e0b020'];
          put(S.hydrant, x, z, -P.dz * side, P.dx * side, 1, new THREE.Color(caps[Math.floor(hash01(seed++, 9) * caps.length)]));
        }
        const inCore = inRect(CORE, mid.x, mid.z, 0);
        for (const c of r.crossings) {
          // Approach side corner just behind the crosswalk.
          const sC = c.s0 < 1 ? c.s1 + 2.5 : c.s1 > r.len - 1 ? c.s0 - 2.5 : (c.s0 + c.s1) / 2 < r.len / 2 ? c.s1 + 2.5 : c.s0 - 2.5;
          if (sC < 0 || sC > r.len) continue;
          this.net.at(r, sC, P);
          const o = r.hw + Math.min(1.6, Math.max(0.8, r.sw * 0.45));
          const x = P.x + P.dz * o * side;
          const z = P.z - P.dx * o * side;
          if (!inCore || !this.okSpot(x, z)) continue;
          const h = hash01(seed++, 17);
          if (h < 0.55 && this.claim(x, z, 1.0)) put(S.trash, x, z, -P.dz * side, P.dx * side, 1);
          if (h > 0.4 && (r.kind === 'primary' || r.kind === 'secondary' || market)) {
            // A cluster of 2–4 colourful news racks a little further along.
            const n = 2 + Math.floor(hash01(seed, 4) * 3);
            const sN = sC + (sC > r.len / 2 ? -3.5 : 3.5);
            const cols = ['#c8312a', '#2b5fa8', '#e2c23b', '#3a7d44', '#dcdcdc', '#1f3d6b', '#e07a26'];
            for (let k = 0; k < n; k++) {
              const sk = sN + (k - n / 2) * 0.58;
              this.net.at(r, sk, P);
              const xk = P.x + P.dz * (r.hw + 0.6) * side;
              const zk = P.z - P.dx * (r.hw + 0.6) * side;
              if (!this.okSpot(xk, zk) || !this.claim(xk, zk, 0.28)) continue;
              put(S.news, xk, zk, -P.dz * side, P.dx * side, 1, new THREE.Color(cols[Math.floor(hash01(seed++, k) * cols.length)]));
            }
          }
        }
        // Parking meters (core only).
        const parkSide = L && (side === 1 ? L.parkL : L.parkR) > 0;
        if (parkSide && inCore) {
          for (let s = 8; s < r.len - 8; s += 6.4) {
            if (this.onCrossing(r, s, 5)) continue;
            this.net.at(r, s, P);
            const x = P.x + P.dz * (r.hw + 0.42) * side;
            const z = P.z - P.dx * (r.hw + 0.42) * side;
            if (!this.okSpot(x, z) || !this.claim(x, z, 0.5)) continue;
            put(S.meter, x, z, -P.dz * side, P.dx * side, 1);
          }
        }
        // Benches & Muni shelters on Market St.
        if (market) {
          for (let s = 25 + (side === 1 ? 0 : 30); s < r.len - 10; s += 60) {
            if (this.onCrossing(r, s, 3)) continue;
            this.net.at(r, s, P);
            const o = r.hw + Math.min(2.4, r.sw * 0.5);
            const x = P.x + P.dz * o * side;
            const z = P.z - P.dx * o * side;
            if (!this.okSpot(x, z) || !this.claim(x, z, 1.4)) continue;
            put(S.bench, x, z, -P.dz * side, P.dx * side, 1.5);
          }
          for (let s = 120 + (side === 1 ? 0 : 200); s < r.len - 10; s += 400) {
            this.net.at(r, s, P);
            const o = r.hw + 1.3;
            const x = P.x + P.dz * o * side;
            const z = P.z - P.dx * o * side;
            if (!this.okSpot(x, z) || !this.claim(x, z, 3)) continue;
            put(S.shelter, x, z, -P.dz * side, P.dx * side, 4, undefined, [0, 0, hash01(seed++, 2), 0]);
            this.pools.push({ x, z, r: 4, c: [0.8, 0.85, 1.0] });
          }
        }
        // Embarcadero waterfront promenade: acorn post-tops along the bay side.
        if (emb) {
          for (let s = 10; s < r.len - 5; s += 26) {
            this.net.at(r, s, P);
            const o = r.hw + Math.max(4, r.sw * 0.9);
            const x = P.x + P.dz * o * side;
            const z = P.z - P.dx * o * side;
            if (!this.okSpot(x, z) || !this.claim(x, z, 3)) continue;
            put(S.acorn, x, z, 1, 0, 3, undefined, [0, 0, hash01(seed++, 6), 0]);
            this.pools.push({ x, z, r: 9, c: [1.0, 0.8, 0.55] });
          }
        }
      }
      // Grant Ave lantern strings: every 11 m a catenary of 5 red lanterns across the street.
      if (r.rec.name === 'Grant Avenue') {
        for (let s = 5; s < r.len - 3; s += 11) {
          this.net.at(r, s, P);
          if (!inChinatownGrant(r, P.z)) continue;
          const half = r.hw + 1.2;
          const yTop = this.surface.top(P.x, P.z) + 7.4;
          for (let k = 0; k < 5; k++) {
            const t = (k + 0.5) / 5 - 0.5; // -0.4..0.4
            const sag = 0.9 * (1 - (2 * t) ** 2);
            const x = P.x + P.dz * t * 2 * half;
            const z = P.z - P.dx * t * 2 * half;
            m.compose(new THREE.Vector3(x, yTop - sag - 0.45, z), q.setFromAxisAngle(up, 0), new THREE.Vector3(1, 1, 1));
            S.lantern.add(m, 1, undefined, [0, 0, hash01(seed++, 8), 0]);
          }
          this.pools.push({ x: P.x, z: P.z, r: 7, c: [1.0, 0.22, 0.12] });
        }
      }
    }

    // ── Muni shelters on the Embarcadero F-line median (beside the tracks, only where the median is raised).
    for (const r of this.net.roads) {
      if (r.cls !== 'rail' || !/Muni [EF]/.test(r.rec.name ?? '') || r.len < 300) continue;
      for (let s = 150; s < r.len - 50; s += 380) {
        this.net.at(r, s, P);
        for (const side of [1, -1]) {
          const x = P.x + P.dz * 2.5 * side;
          const z = P.z - P.dx * 2.5 * side;
          if (!this.okSpot(x, z) || this.surface.blockAt(x + P.dz * 1.2 * side, z - P.dx * 1.2 * side) < 0.75 || !this.claim(x, z, 3)) continue;
          put(S.shelter, x, z, -P.dz * side, P.dx * side, 4, undefined, [0, 0, hash01(seed++, 2), 0]);
          this.pools.push({ x, z, r: 4, c: [0.8, 0.85, 1.0] });
          break;
        }
      }
    }

    // ── Bollards across the entrances of pedestrian malls (Maiden Lane, Belden Pl, plazas).
    for (const r of this.net.roads) {
      if (r.cls !== 'pedestrian' || r.len < 8) continue;
      for (const end of [1.2, r.len - 1.2]) {
        this.net.at(r, end, P);
        for (const o of [-1.6, 0, 1.6]) {
          const x = P.x + P.dz * o;
          const z = P.z - P.dx * o;
          if (!this.okSpot(x, z) || !this.claim(x, z, 0.6)) continue;
          put(S.bollard, x, z, 1, 0, 1);
        }
      }
    }

    // ── Traffic signals: one pole per approach arm, at the near-side right corner, head facing approaching traffic.
    for (const n of this.net.nodes) {
      if (!n.signal || !inRect(CTX, n.x, n.z, -30)) continue;
      const offset = hash01(Math.round(n.x * 10), Math.round(n.z * 10)) * 60;
      const ref = n.arms.find((a) => a.road.major)!.angle;
      for (const a of n.arms) {
        if (!a.road.major) continue;
        if (a.road.oneway && a.sign === 1) continue; // traffic leaves the node on this arm
        const cr = a.road.crossings.find((c) => c.node === n);
        const along = cr ? (a.sign === 1 ? cr.s0 - a.s : a.s - cr.s1) - 0.6 : a.road.hw + 2;
        // Left of the arm direction = right of the approaching traffic.
        const o = a.road.hw + 0.7;
        const x = n.x + a.dx * along + a.dz * o;
        const z = n.z + a.dz * along - a.dx * o;
        if (!this.okSpot(x, z) || !this.claim(x, z, 1)) continue;
        let d = Math.abs(a.angle - ref) % Math.PI;
        if (d > Math.PI / 2) d = Math.PI - d;
        const group = d > Math.PI / 4 ? 1 : 0;
        // Head faces +arm direction (toward approaching traffic): local +Z → (dx, dz) ⇒ local +X → (dz, -dx).
        put(S.signal, x, z, a.dz, -a.dx, 5, undefined, [offset, group, hash01(seed++, 1), 0]);
      }
    }
  }

  private bakePools(): void {
    const W = (DZ.maxX - DZ.minX) / 2;
    const H = (DZ.maxZ - DZ.minZ) / 2;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    for (const p of this.pools) {
      const x = (p.x - DZ.minX) / 2;
      const z = (p.z - DZ.minZ) / 2;
      const R = p.r / 2;
      const grd = g.createRadialGradient(x, z, 0, x, z, R);
      const col = (a: number) => `rgba(${Math.round(p.c[0] * 255)},${Math.round(p.c[1] * 255)},${Math.round(p.c[2] * 255)},${a})`;
      grd.addColorStop(0, col(0.6));
      grd.addColorStop(0.25, col(0.38));
      grd.addColorStop(0.55, col(0.12));
      grd.addColorStop(1, col(0));
      g.fillStyle = grd;
      g.fillRect(x - R, z - R, 2 * R, 2 * R);
    }
    const t = new THREE.CanvasTexture(c);
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    this.lightMap = t;
  }

  update(camera: THREE.PerspectiveCamera, planes: THREE.Plane[], elapsed: number): void {
    this.uniforms.uTime.value = elapsed;
    for (const s of this.sets) s.update(planes, camera.position);
  }
}
