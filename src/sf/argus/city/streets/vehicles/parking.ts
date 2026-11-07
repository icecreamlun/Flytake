/**
 * Surface parking lots (OSM amenity=parking areas): stall lines laid out in double-loaded rows along the lot's
 * main axis, with ~65% of the stalls occupied by parked cars. Lots at sidewalk level use the raised surface.
 */
import type { CityData } from '../../../contracts';
import type { GroundSurface } from '../core/surface';
import { pointInRing } from '../core/contour';
import { CTX, hash01, inRect } from '../core/zone';
import { Style } from '../markings/material';
import type { StripBuilder } from '../markings/strips';
import type { Vehicles } from '.';

export function buildParkingLots(city: CityData, surface: GroundSurface, sb: StripBuilder, vehicles: Vehicles): number {
  const H = (x: number, z: number) => surface.top(x, z);
  let cars = 0;
  let seed = 9000;
  for (const a of city.areas) {
    if (a.kind !== 'parking') continue;
    const ring = a.polygon.flat();
    const n = ring.length / 2;
    if (n < 3) continue;
    // Principal axis = direction of the longest edge.
    let best = 0;
    let ux = 1;
    let uz = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = ring[j * 2] - ring[i * 2];
      const dz = ring[j * 2 + 1] - ring[i * 2 + 1];
      const L = Math.hypot(dx, dz);
      if (L > best) {
        best = L;
        ux = dx / L;
        uz = dz / L;
      }
    }
    const vx = -uz;
    const vz = ux;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const u = ring[i * 2] * ux + ring[i * 2 + 1] * uz;
      const v = ring[i * 2] * vx + ring[i * 2 + 1] * vz;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    if (u1 - u0 < 8 || v1 - v0 < 6) continue;
    const cx = ring[0];
    const cz = ring[1];
    if (!inRect(CTX, cx, cz, -30)) continue;
    const toXZ = (u: number, v: number): [number, number] => [ux * u + vx * v, uz * u + vz * v];
    const inside = (u: number, v: number) => {
      const [x, z] = toXZ(u, v);
      return pointInRing(ring, x, z) && surface.blockAt(x, z) > 0.5;
    };
    // Rows: [stall 5][stall 5][aisle 7] repeating across the lot.
    for (let vr = v0 + 5.5; vr < v1 - 0.5; vr += 17) {
      for (let uk = u0 + 1; uk < u1 - 1; uk += 2.6) {
        for (const side of [-1, 1]) {
          const va = vr;
          const vb = vr + side * 5;
          if (!inside(uk, va) || !inside(uk, vb) || !inside(uk + 2.6, vb)) continue;
          const [x0, z0] = toXZ(uk, va);
          const [x1, z1] = toXZ(uk, vb);
          sb.add([x0, z0, x1, z1], 0.06, Style.White, 0, H, 0.02);
          if (hash01(seed++, 3) < 0.65) {
            const [px, pz] = toXZ(uk + 1.3, vr + side * 2.6);
            const head = hash01(seed, 5) < 0.75 ? side : -side; // most cars nose-in
            vehicles.addParked(px, pz, vx * head, vz * head, seed);
            cars++;
          }
        }
      }
    }
  }
  return cars;
}
