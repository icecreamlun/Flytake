/**
 * Rail vehicles: a PCC streetcar (F-line heritage fleet) and a double-ended California Street cable car.
 * Local frame: +Z forward (direction of travel), +X right, origin on the track centre at rail-top level.
 * Tintable parts take the per-instance livery colour.
 */
import * as THREE from 'three';
import { Emit, Kit } from '../props/kit';

const GLASS = '#1b2329';
const CREAM = '#e8dcc0';

/** PCC streetcar, 14.2 m long, streamlined ends. */
export function pccCar(): THREE.BufferGeometry {
  const k = new Kit();
  const L = 14.2;
  const W = 2.54;
  // Lower body (livery colour) in slices so the ends taper (streamlined PCC nose).
  const slices = 14;
  for (let i = 0; i < slices; i++) {
    const t0 = i / slices;
    const t1 = (i + 1) / slices;
    const z0 = -L / 2 + L * t0;
    const z1 = -L / 2 + L * t1;
    const tc = (t0 + t1) / 2;
    const e = Math.min(tc, 1 - tc); // 0 at ends
    const taper = e < 0.12 ? 0.72 + 0.28 * Math.sin((e / 0.12) * (Math.PI / 2)) : 1;
    const w = W * taper;
    k.box(w, 1.2, z1 - z0 + 0.01, 0, 0.55 + 0.6, (z0 + z1) / 2, '#ffffff', { r: 0.35, m: 0.15, t: 1 });
    // Window band.
    k.box(w * 0.995, 0.95, z1 - z0 + 0.01, 0, 1.75 + 0.47, (z0 + z1) / 2, GLASS, { r: 0.08, m: 0.2 });
    // Letterboard / roof skirt (cream).
    k.box(w * 0.99, 0.3, z1 - z0 + 0.01, 0, 2.7 + 0.15, (z0 + z1) / 2, CREAM, { r: 0.4 });
    // Roof (curved approximated by two layers).
    k.box(w * 0.92, 0.12, z1 - z0 + 0.01, 0, 3.0 + 0.06, (z0 + z1) / 2, '#6d6f6c', { r: 0.6, m: 0.2 });
    k.box(w * 0.7, 0.1, z1 - z0 + 0.01, 0, 3.12 + 0.05, (z0 + z1) / 2, '#6d6f6c', { r: 0.6, m: 0.2 });
  }
  // Window posts (cream) every 1.2 m.
  for (let z = -5.4; z <= 5.4; z += 1.2) {
    for (const s of [-1, 1]) k.box(0.03, 0.95, 0.12, s * (W / 2 + 0.005), 2.22, z, CREAM, { r: 0.4 });
  }
  // Belt stripe (darker livery accent) and skirt.
  for (const s of [-1, 1]) k.box(0.02, 0.12, L * 0.82, s * (W / 2 + 0.01), 1.68, 0, '#2a2a2a', { r: 0.5 });
  k.box(W * 0.9, 0.3, L * 0.86, 0, 0.42, 0, '#1d1e1f', { r: 0.7, m: 0.3 });
  // Trucks (bogies) and wheels.
  for (const z of [-4.3, 4.3]) {
    k.box(2.0, 0.5, 2.2, 0, 0.35, z, '#1a1b1c', { r: 0.7, m: 0.4 });
    for (const dz of [-0.95, 0.95]) for (const s of [-1, 1]) k.cyl(0.33, 0.33, 0.1, s * 0.72, 0.33, z + dz, '#3a3b3c', { r: 0.4, m: 0.8, rz: (s * Math.PI) / 2, seg: 10 });
  }
  // Headlight & tail lights at both ends, interior glow behind the windows.
  k.sphere(0.13, 0, 1.55, L / 2 - 0.05, '#fff6e0', { e: Emit.Head, r: 0.1, seg: 8 });
  for (const s of [-1, 1]) k.box(0.16, 0.12, 0.05, s * 0.7, 1.05, -L / 2 + 0.2, '#ff2a1a', { e: Emit.Tail, r: 0.3 });
  k.box(W * 0.9, 0.7, L * 0.8, 0, 2.2, 0, '#fff0d0', { e: Emit.Cabin, r: 0.9 });
  // Destination signs.
  k.box(1.0, 0.25, 0.04, 0, 2.78, L / 2 - 0.25, '#fff4cc', { e: Emit.Cabin, r: 0.4 });
  // Trolley pole (rear) reaching up to the wire, and its retriever base.
  k.box(0.3, 0.15, 0.6, 0, 3.25, -4.6, '#2b2b2b', { r: 0.6, m: 0.5 });
  k.cyl(0.03, 0.025, 4.6, 0, 3.3, -4.6, '#2b2b2b', { r: 0.6, m: 0.5, rx: 1.06, seg: 5 });
  return k.build();
}

/** California Street double-ended cable car, 9.1 m. */
export function cableCar(): THREE.BufferGeometry {
  const k = new Kit();
  const L = 9.1;
  const W = 2.5;
  const WOOD = '#6b4a2e';
  // Underframe & running gear.
  k.box(W * 0.95, 0.35, L, 0, 0.55, 0, '#1c1c1c', { r: 0.7, m: 0.3 });
  for (const z of [-3.0, 3.0]) {
    for (const s of [-1, 1]) k.cyl(0.32, 0.32, 0.1, s * 0.53, 0.32, z, '#3b3b3b', { r: 0.4, m: 0.8, rz: (s * Math.PI) / 2, seg: 10 });
  }
  // Floor/step boards along the sides.
  for (const s of [-1, 1]) k.box(0.32, 0.06, L * 0.9, s * (W / 2 + 0.1), 0.62, 0, WOOD, { r: 0.8 });
  // Central enclosed cabin (livery lower panels, cream window posts, glass).
  k.box(W, 0.8, 4.6, 0, 1.1, 0, '#ffffff', { r: 0.35, m: 0.1, t: 1 });
  k.box(W * 0.99, 0.95, 4.6, 0, 1.97, 0, GLASS, { r: 0.1, m: 0.2 });
  for (let z = -2.1; z <= 2.1; z += 0.7) for (const s of [-1, 1]) k.box(0.06, 0.95, 0.1, s * (W / 2), 1.97, z, CREAM, { r: 0.4 });
  k.box(W * 1.01, 0.32, 4.7, 0, 2.6, 0, CREAM, { r: 0.4 });
  k.box(W * 0.94, 0.08, 4.7, 0, 2.82, 0, '#3e2a1d', { r: 0.5 });
  // Open end sections: benches, posts and roof.
  for (const e of [-1, 1]) {
    const zc = e * 3.45;
    k.box(W * 0.98, 0.5, 2.0, 0, 0.98, zc, '#ffffff', { r: 0.35, m: 0.1, t: 1 });
    k.box(0.5, 0.08, 1.9, -0.55, 1.28, zc, WOOD, { r: 0.8 });
    k.box(0.5, 0.08, 1.9, 0.55, 1.28, zc, WOOD, { r: 0.8 });
    for (const s of [-1, 1]) for (const dz of [-0.85, 0, 0.85]) k.cyl(0.03, 0.03, 1.6, s * (W / 2 - 0.05), 1.2, zc + dz, '#c4a24a', { r: 0.3, m: 0.9, seg: 6 });
    k.box(W * 1.02, 0.12, 2.15, 0, 2.86, zc, CREAM, { r: 0.4 });
    k.box(W * 0.9, 0.06, 2.2, 0, 2.95, zc, '#3e2a1d', { r: 0.5 });
    // End dash with headlight and route sign.
    k.box(W * 0.92, 0.9, 0.08, 0, 1.15, e * (L / 2), '#ffffff', { r: 0.35, m: 0.1, t: 1 });
    k.sphere(0.12, 0, 1.75, e * (L / 2 + 0.02), '#fff4dc', { e: Emit.Head, r: 0.1, seg: 8 });
    k.box(1.0, 0.24, 0.05, 0, 2.62, e * (L / 2 + 0.02), '#f1e7c9', { e: Emit.Cabin, r: 0.4 });
  }
  // Clerestory roof over the cabin.
  k.box(W * 0.6, 0.2, 4.4, 0, 3.0, 0, '#3e2a1d', { r: 0.5 });
  k.box(W * 0.62, 0.12, 4.0, 0, 2.95, 0, '#fff0d0', { e: Emit.Cabin, r: 0.5 });
  // Interior glow.
  k.box(W * 0.9, 0.6, 4.3, 0, 2.0, 0, '#fff0d0', { e: Emit.Cabin, r: 0.9 });
  return k.build();
}
