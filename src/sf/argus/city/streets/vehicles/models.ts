/**
 * Procedural road vehicles, lofted (see loft.ts). Local frame: +Z forward, +X right, y = 0 at the tyre contact.
 * Eight types: sedan, hatchback, SUV, van (cargo / passenger), taxi, SF Muni 40-ft trolley coach, pickup and box
 * truck. Each has three LODs: near (~1.2-1.9k tris: wheel arches, separate greenhouse with glass, door seams, belt
 * moulding, lamps, plates, mirrors, alloy wheels), mid (~400-600 tris) and far (~120-200 tris).
 * Body paint is tintable per instance (aPbr.z = 1, which also gets the clear coat).
 */
import * as THREE from 'three';
import { VM, box, loft, merge, painted, wheel, type Mat, type Station } from './loft';

export const enum VType {
  Sedan = 0,
  Hatch = 1,
  Suv = 2,
  Van = 3,
  Taxi = 4,
  Bus = 5,
  Pickup = 6,
  Truck = 7,
}
export const VTYPE_COUNT = 8;

interface CarSpec {
  L: number;
  W: number;
  R: number; // wheel radius
  tyreW: number;
  zF: number; // front axle z
  zRa: number; // rear axle z
  clear: number; // underbody height
  belt: number; // beltline height
  nose: number; // hood front edge height
  hood: number; // hood height at the windscreen base
  deck: number; // rear deck height at the rear window base
  tail: number; // height at the very rear
  roof: number;
  zA: number; // windscreen base
  zW: number; // windscreen top (roof front)
  zR: number; // roof rear (rear window top)
  zC: number; // rear window base
  wRoof: number; // roof half-width fraction
  pillars: number[]; // B (and C) pillar centres within the side glass
  seams: number[]; // door seam z positions
  cladding?: boolean; // black wheel-arch / sill cladding (SUVs)
  bed?: boolean; // pickup bed behind the cab
}

const SPECS: Record<number, CarSpec> = {
  [VType.Sedan]: { L: 4.85, W: 1.84, R: 0.33, tyreW: 0.22, zF: 1.42, zRa: -1.43, clear: 0.2, belt: 0.98, nose: 0.74, hood: 0.94, deck: 1.0, tail: 0.97, roof: 1.44, zA: 0.92, zW: 0.12, zR: -1.05, zC: -1.6, wRoof: 0.74, pillars: [-0.38], seams: [0.75, -0.38, -1.4] },
  [VType.Hatch]: { L: 4.26, W: 1.79, R: 0.32, tyreW: 0.21, zF: 1.33, zRa: -1.3, clear: 0.2, belt: 0.99, nose: 0.76, hood: 0.94, deck: 1.0, tail: 0.97, roof: 1.47, zA: 0.93, zW: 0.18, zR: -1.55, zC: -1.95, wRoof: 0.76, pillars: [-0.35], seams: [0.78, -0.35, -1.35] },
  [VType.Suv]: { L: 4.72, W: 1.9, R: 0.37, tyreW: 0.24, zF: 1.4, zRa: -1.35, clear: 0.3, belt: 1.12, nose: 0.92, hood: 1.08, deck: 1.15, tail: 1.1, roof: 1.7, zA: 0.92, zW: 0.25, zR: -1.95, zC: -2.2, wRoof: 0.8, pillars: [-0.33, -1.45], seams: [0.76, -0.33, -1.4], cladding: true },
  [VType.Taxi]: { L: 4.9, W: 1.84, R: 0.33, tyreW: 0.22, zF: 1.42, zRa: -1.43, clear: 0.2, belt: 0.98, nose: 0.74, hood: 0.94, deck: 1.0, tail: 0.97, roof: 1.45, zA: 0.92, zW: 0.12, zR: -1.05, zC: -1.6, wRoof: 0.74, pillars: [-0.38], seams: [0.75, -0.38, -1.4] },
  [VType.Pickup]: { L: 5.8, W: 2.0, R: 0.4, tyreW: 0.26, zF: 1.85, zRa: -1.85, clear: 0.38, belt: 1.25, nose: 1.08, hood: 1.2, deck: 1.22, tail: 1.2, roof: 1.92, zA: 1.12, zW: 0.55, zR: -0.65, zC: -0.72, wRoof: 0.82, pillars: [-0.1], seams: [0.95, -0.1, -0.68], cladding: true, bed: true },
};

const uniq = (zs: number[]) => {
  zs.sort((a, b) => a - b);
  const out: number[] = [];
  for (const z of zs) if (!out.length || z - out[out.length - 1] > 0.008) out.push(z);
  return out;
};
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Enforce a y-monotone profile (cap bands need it). */
const monotone = (p: number[]) => {
  for (let k = 3; k < p.length; k += 2) p[k] = Math.max(p[k], p[k - 2] + 0.001);
  return p;
};
/** Body bottom: clearance raised toward the bumpers and cut out by the wheel arches. */
function bottomAt(z: number, L: number, clear: number, R: number, axles: number[], gap = 0.05): number {
  const dEnd = Math.min(L / 2 - z, z + L / 2);
  let y0 = clear + 0.15 * Math.pow(Math.max(0, 1 - dEnd / 0.45), 1.5);
  const Ra = R + gap;
  for (const zw of axles) {
    const dz = z - zw;
    if (Math.abs(dz) < Ra) y0 = Math.max(y0, R + Math.sqrt(Ra * Ra - dz * dz));
  }
  return y0;
}

// ───────────────────────────── cars (sedan, hatch, SUV, taxi, pickup) ─────────────────────────────

function carBody(s: CarSpec, lod: number): THREE.BufferGeometry[] {
  const hw = s.W / 2;
  const axles = [s.zF, s.zRa];
  const Ra = s.R + 0.05;
  const lowerTop = (z: number) => {
    let yt: number;
    if (z >= s.zA) yt = s.hood + (s.nose - s.hood) * Math.pow((z - s.zA) / (s.L / 2 - s.zA), 1.7);
    else if (z <= s.zC) yt = s.deck + (s.tail - s.deck) * Math.pow((s.zC - z) / (s.zC + s.L / 2), 2);
    else yt = s.belt;
    const dEnd = Math.min(s.L / 2 - z, z + s.L / 2);
    return yt - 0.12 * Math.pow(Math.max(0, 1 - dEnd / 0.22), 2);
  };
  const profile = (z: number): number[] => {
    const dEnd = Math.min(s.L / 2 - z, z + s.L / 2);
    const w = hw * (1 - 0.13 * Math.pow(Math.max(0, 1 - dEnd / 0.75), 2));
    const y0 = bottomAt(z, s.L, s.clear, s.R, axles);
    const yt = lowerTop(z);
    const ys = Math.min(yt, s.belt) - 0.04;
    const crown = 0.03;
    if (lod === 2) return monotone([0, y0, w * 0.95, y0, w, (y0 + ys) / 2, w * 0.92, yt, 0, yt + crown]);
    return monotone([
      0, y0,
      w * 0.9, y0,
      w * 0.975, y0 + 0.07,
      w, y0 + (ys - y0) * 0.4,
      w * 0.99, ys - 0.07,
      w * 0.975, ys - 0.02,
      w * 0.95, ys + 0.02,
      w * 0.84, yt,
      0, yt + crown,
    ]);
  };
  // Stations.
  let zs: number[];
  const L2 = s.L / 2;
  if (lod === 2) zs = [-L2, -L2 + 0.3, s.zRa - Ra, s.zRa + Ra, s.zC, s.zA, s.zF - Ra, s.zF + Ra, L2 - 0.3, L2];
  else {
    const arch = lod === 0 ? [-1, -0.85, -0.5, 0, 0.5, 0.85, 1] : [-1, -0.6, 0, 0.6, 1];
    zs = [-L2, -L2 + 0.05, -L2 + 0.16, -L2 + 0.4, s.zC, (s.zC + s.zA) / 2, s.zA, L2 - 0.4, L2 - 0.16, L2 - 0.05, L2];
    for (const zw of axles) for (const a of arch) zs.push(zw + a * Ra);
    if (lod === 0) for (const sz of s.seams) zs.push(sz, sz + 0.02);
  }
  zs = uniq(zs.filter((z) => z >= -L2 && z <= L2));
  const st: Station[] = zs.map((z) => ({ z, pts: profile(z) }));
  const isSeam = (z0: number, z1: number) => lod === 0 && s.seams.some((sz) => Math.abs(z0 - sz) < 0.004 && Math.abs(z1 - sz - 0.02) < 0.004);
  const P = st[0].pts.length / 2;
  const lower = loft(
    st,
    (i, k) => {
      if (k === 0) return VM.UNDER;
      const z0 = st[i].z;
      const z1 = st[i + 1].z;
      const zm = (z0 + z1) / 2;
      if (lod === 2) return k === 1 && s.cladding ? VM.TRIM : VM.PAINT;
      if (k === 1) return s.cladding ? VM.TRIM : VM.PAINT;
      // Black cladding around the arches (SUV / pickup).
      if (s.cladding && k === 2 && axles.some((zw) => Math.abs(zm - zw) < Ra + 0.08)) return VM.TRIM;
      // Belt moulding along the greenhouse.
      if (lod === 0 && k === 5 && zm > s.zC && zm < s.zA) return VM.TRIM;
      if (isSeam(z0, z1) && k >= 2 && k <= 4) return VM.SEAM;
      // Pickup bed: dark tonneau cover on top.
      if (s.bed && zm < s.zC - 0.05 && k >= P - 3) return VM.TRIM;
      return VM.PAINT;
    },
    (end, k) => {
      if (k === 0) return VM.UNDER;
      const p = end === 1 ? st[st.length - 1].pts : st[0].pts;
      const y = (p[k * 2 + 1] + p[k * 2 + 3]) / 2;
      // Bumper zone dark, body colour above.
      if (y < s.clear + 0.22) return VM.TRIM;
      return VM.PAINT;
    },
  );
  // Greenhouse.
  const roofAt = (z: number) => {
    if (z >= s.zW) return s.roof - (s.roof - s.belt) * sstep(s.zW, s.zA + 0.02, z) - 0.015 * sstep(s.zW - 0.2, s.zW, z);
    if (z <= s.zR) return s.roof - (s.roof - s.belt) * Math.pow(Math.min(1, (s.zR - z) / (s.zR - s.zC)), 1.6);
    return s.roof + 0.015 * Math.sin(((z - s.zR) / (s.zW - s.zR)) * Math.PI);
  };
  const wb = hw * 0.93;
  const wr = hw * s.wRoof;
  const gz: number[] = [];
  const nG = lod === 0 ? 7 : lod === 1 ? 4 : 2;
  for (let i = 0; i <= nG; i++) gz.push(s.zC + (s.zR - s.zC) * (i / nG));
  for (let i = 1; i < 4; i++) gz.push(s.zR + (s.zW - s.zR) * (i / 4));
  for (let i = 0; i <= nG; i++) gz.push(s.zW + (s.zA - s.zW) * (i / nG));
  if (lod < 2) for (const pz of s.pillars) gz.push(pz - 0.05, pz + 0.05);
  const gzs = uniq(gz);
  const gst: Station[] = gzs.map((z) => {
    const h = Math.max(s.belt + 0.001, roofAt(z));
    const t = (h - s.belt) / (s.roof - s.belt);
    const w = wb + (wr - wb) * t;
    return { z, pts: [0, s.belt - 0.03, wb, s.belt - 0.03, w, h, w * 0.55, h + 0.03 * t, 0, h + 0.04 * t] };
  });
  const glassSide = (z: number) => z > s.zC + 0.2 && z < s.zA - 0.06 && !s.pillars.some((pz) => Math.abs(z - pz) < 0.05);
  const green = loft(
    gst,
    (i, k) => {
      const zm = (gst[i].z + gst[i + 1].z) / 2;
      if (k === 0) return VM.UNDER;
      if (k === 1) {
        if (s.pillars.some((pz) => Math.abs(zm - pz) < 0.05)) return lod === 2 ? VM.GLASS : VM.TRIM;
        return glassSide(zm) ? VM.GLASS : VM.PAINT;
      }
      if (zm > s.zW + 0.03 || zm < s.zR - 0.03) return VM.GLASS;
      return VM.PAINT;
    },
    null,
  );
  return [lower, green];
}

function carDetails(s: CarSpec, lod: number, type: VType): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const hw = s.W / 2;
  const L2 = s.L / 2;
  // Lamps (all LODs: they carry the night emissive).
  for (const x of [-1, 1]) {
    out.push(box(0.4, 0.1, 0.12, x * (hw - 0.3), s.nose - 0.07, L2 - 0.06, VM.HEAD, x * 0.22));
    out.push(box(0.36, 0.11, 0.12, x * (hw - 0.27), s.tail - 0.12, -L2 + 0.07, VM.TAIL, -x * 0.2));
  }
  if (lod === 0) {
    // Grille, lower intake, plates, mirrors, door handles.
    out.push(box(s.W * 0.42, 0.13, 0.06, 0, s.nose - 0.17, L2 - 0.01, VM.TRIM));
    out.push(box(s.W * 0.5, 0.08, 0.06, 0, s.clear + 0.14, L2 - 0.05, VM.TRIM));
    out.push(box(0.52, 0.11, 0.03, 0, s.clear + 0.3, L2 + 0.005, VM.PLATE));
    out.push(box(0.31, 0.16, 0.03, 0, s.tail - 0.33, -L2 - 0.005, VM.PLATE));
    for (const x of [-1, 1]) {
      out.push(box(0.05, 0.05, 0.1, x * (hw * 0.93 + 0.02), s.belt + 0.05, s.zA - 0.15, VM.TRIM));
      out.push(box(0.1, 0.11, 0.17, x * (hw * 0.93 + 0.1), s.belt + 0.08, s.zA - 0.16, VM.PAINT));
      for (const z of [s.seams[0] - 0.22, s.seams[1] - 0.22]) out.push(box(0.025, 0.025, 0.13, x * (hw + 0.004), s.belt - 0.12, z, VM.TRIM));
      // Amber side markers.
      out.push(box(0.012, 0.035, 0.06, x * (hw * 0.89 + 0.005), s.nose - 0.08, L2 - 0.3, VM.AMBER));
    }
  }
  if (type === VType.Taxi) {
    out.push(box(0.75, 0.2, 0.3, 0, s.roof + 0.1, (s.zR + s.zW) / 2, VM.SIGN));
    out.push(box(0.8, 0.03, 0.34, 0, s.roof + 0.015, (s.zR + s.zW) / 2, VM.TRIM));
  }
  return out;
}

function wheels(R: number, tyreW: number, trackHalf: number, axles: number[], lod: number, rim?: Mat): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const z of axles) for (const side of [1, -1] as const) out.push(wheel(R, tyreW, side * trackHalf, z, side, lod, rim));
  return out;
}

function car(type: VType, lod: number): THREE.BufferGeometry {
  const s = SPECS[type];
  const parts = [...carBody(s, lod), ...carDetails(s, lod, type), ...wheels(s.R, s.tyreW, s.W / 2 - s.tyreW / 2 - 0.05, [s.zF, s.zRa], lod)];
  return merge(parts);
}

// ───────────────────────────── van (Transit-style high roof) ─────────────────────────────

function van(lod: number): THREE.BufferGeometry {
  const L = 5.95;
  const W = 2.05;
  const hw = W / 2;
  const R = 0.36;
  const zF = 1.85;
  const zRa = -1.75;
  const axles = [zF, zRa];
  const Ra = R + 0.06;
  const roof = 2.62;
  const zA = 2.0; // windscreen base
  const zW = 1.25; // windscreen top
  const nose = 1.02;
  const hood = 1.2;
  const belt = 1.18;
  const topAt = (z: number) => {
    if (z >= zA) return hood + (nose - hood) * Math.pow((z - zA) / (L / 2 - zA), 1.4);
    if (z >= zW) return roof - (roof - hood) * sstep(zW, zA, z);
    return roof;
  };
  const profile = (z: number) => {
    const dEnd = Math.min(L / 2 - z, z + L / 2);
    const w = hw * (1 - 0.08 * Math.pow(Math.max(0, 1 - dEnd / 0.6), 2));
    const y0 = bottomAt(z, L, 0.3, R, axles, 0.06);
    const yt = topAt(z);
    if (lod === 2) return monotone([0, y0, w, y0, w, Math.min(belt, yt - 0.1), w * 0.94, yt, 0, yt + 0.02]);
    return monotone([
      0, y0,
      w * 0.93, y0,
      w, y0 + 0.08,
      w, 0.82,
      w, 0.9, // rubbing strip
      w, Math.min(belt, yt - 0.15),
      w * 0.995, Math.min(yt - 0.14, belt + 0.02),
      w * 0.975, yt - 0.12,
      w * 0.9, yt - 0.01,
      0, yt + 0.02,
    ]);
  };
  const doorF0 = zA - 0.95;
  const slideA = -0.15;
  const slideB = 0.95;
  let zs: number[] = [-L / 2, -L / 2 + 0.06, -L / 2 + 0.25, zW, (zW + zA) / 2, zA, L / 2 - 0.25, L / 2 - 0.08, L / 2];
  for (const zw of axles) for (const a of lod === 2 ? [-1, 1] : lod === 1 ? [-1, -0.6, 0, 0.6, 1] : [-1, -0.85, -0.5, 0, 0.5, 0.85, 1]) zs.push(zw + a * Ra);
  if (lod === 0) zs.push(doorF0, doorF0 + 0.02, slideA, slideA + 0.02, slideB - 0.02, slideB, -1.0, -0.98, -2.2, -2.18);
  if (lod < 2) zs.push(zA - 0.06, -L / 2 + 0.7, -1.1, -0.95);
  zs = uniq(zs.filter((z) => z >= -L / 2 && z <= L / 2));
  const st: Station[] = zs.map((z) => ({ z, pts: profile(z) }));
  const P = st[0].pts.length / 2;
  const body = (pass: boolean) =>
    loft(
      st,
      (i, k, side) => {
        const z0 = st[i].z;
        const z1 = st[i + 1].z;
        const zm = (z0 + z1) / 2;
        if (k === 0) return VM.UNDER;
        if (lod === 2) return k === P - 3 && zm < zA - 0.1 && zm > zA - 0.9 ? VM.GLASS : VM.PAINT;
        if (k === 1) return VM.TRIM;
        if (k === 3) return VM.TRIM; // rubbing strip
        const upper = k === 5 || k === 6;
        if (upper) {
          if (zm > zA - 0.9 && zm < zA - 0.08) return VM.GLASS; // cab door window
          if (pass && zm > -L / 2 + 0.75 && zm < doorF0 - 0.12 && !(zm > -1.1 && zm < -0.95) && !(zm > slideA - 0.06 && zm < slideA + 0.08)) return VM.GLASS;
        }
        if (k === P - 2 && zm > zW + 0.03 && zm < zA) return VM.GLASS; // windscreen
        if (k === P - 3 && zm > zW + 0.05 && zm < zA - 0.05) return VM.GLASS;
        if (lod === 0 && k >= 2 && k <= 6) {
          const seam = (a: number) => Math.abs(z0 - a) < 0.004 && Math.abs(z1 - a - 0.02) < 0.004;
          if (seam(doorF0) || seam(-1.0) || seam(-2.2)) return VM.SEAM;
          if (side === 1 && (seam(slideA) || Math.abs(z0 - (slideB - 0.02)) < 0.004)) return VM.SEAM;
        }
        return VM.PAINT;
      },
      (end, k) => {
        if (k === 0) return VM.UNDER;
        const p = end === 1 ? st[st.length - 1].pts : st[0].pts;
        const y = (p[k * 2 + 1] + p[k * 2 + 3]) / 2;
        if (y < 0.62) return VM.TRIM;
        if (end === 1 && y < nose - 0.08) return VM.TRIM; // grille
        if (end === 0 && pass && y > 1.35 && y < 2.2 && k >= 5) return VM.GLASS; // rear door windows
        return VM.PAINT;
      },
    );
  // Passenger-style: side windows behind the cab and in the rear doors.
  const parts = [body(lod < 2)];
  for (const x of [-1, 1]) {
    parts.push(box(0.3, 0.13, 0.1, x * (hw - 0.27), nose - 0.06, L / 2 - 0.05, VM.HEAD, x * 0.15));
    parts.push(box(0.14, 0.42, 0.06, x * (hw - 0.1), 1.25, -L / 2 + 0.02, VM.TAIL));
    if (lod === 0) {
      parts.push(box(0.12, 0.2, 0.22, x * (hw + 0.1), 1.65, zA - 0.25, VM.TRIM));
      parts.push(box(0.03, 0.03, 0.15, x * (hw + 0.01), 1.05, zA - 0.75, VM.TRIM));
    }
  }
  if (lod === 0) {
    parts.push(box(0.012, 1.5, 0.02, 0, 1.25, -L / 2 - 0.005, VM.SEAM)); // rear barn-door seam
    parts.push(box(0.52, 0.11, 0.03, 0, 0.5, L / 2 + 0.01, VM.PLATE));
    parts.push(box(0.31, 0.16, 0.03, 0, 0.55, -L / 2 - 0.01, VM.PLATE));
    parts.push(box(0.02, 0.025, 1.0, hw + 0.01, 2.0, (slideA + slideB) / 2, VM.TRIM)); // sliding door track
  }
  parts.push(...wheels(R, 0.23, hw - 0.17, axles, lod, VM.RIM_DARK));
  return merge(parts);
}

// ───────────────────────────── SF Muni trolley coach ─────────────────────────────

/** SF Muni 40-ft trolley coach (New Flyer XT40): red lower body, white stripe, black glazing band, grey roof. */
function bus(lod: number): THREE.BufferGeometry {
  const L = 12.3;
  const W = 2.59;
  const hw = W / 2;
  const R = 0.5;
  const zF = L / 2 - 2.55;
  const zRa = -L / 2 + 3.2;
  const axles = [zF, zRa];
  const Ra = R + 0.07;
  const profile = (z: number) => {
    const dEnd = Math.min(L / 2 - z, z + L / 2);
    const w = hw * (1 - 0.05 * Math.pow(Math.max(0, 1 - dEnd / 0.5), 2));
    const y0 = bottomAt(z, L, 0.32, R, axles, 0.07);
    const top = 3.12 - 0.12 * Math.pow(Math.max(0, 1 - dEnd / 0.35), 2);
    if (lod === 2) return monotone([0, y0, w, y0, w, 1.38, w, 2.78, w * 0.95, top, 0, top + 0.03]);
    return monotone([
      0, y0,
      w * 0.96, y0,
      w, y0 + 0.1,
      w, 0.95,
      w, 1.3,
      w, 1.38,
      w, 2.78,
      w * 0.99, 2.98,
      w * 0.92, top,
      0, top + 0.04,
    ]);
  };
  const frontDoor: [number, number] = [L / 2 - 1.62, L / 2 - 0.45];
  const midDoor: [number, number] = [-0.55, 0.7];
  let zs: number[] = [-L / 2, -L / 2 + 0.08, -L / 2 + 0.3, L / 2 - 0.3, L / 2 - 0.08, L / 2, ...frontDoor, ...midDoor];
  for (const zw of axles) for (const a of lod === 2 ? [-1, 1] : [-1, -0.7, 0, 0.7, 1]) zs.push(zw + a * Ra);
  // Window pillars every ~1.25 m.
  if (lod < 2) for (let z = -L / 2 + 0.6; z < L / 2 - 0.6; z += 1.25) zs.push(z - 0.07, z + 0.07);
  zs = uniq(zs.filter((z) => z >= -L / 2 && z <= L / 2));
  const st: Station[] = zs.map((z) => ({ z, pts: profile(z) }));
  const inDoor = (z: number) => (z > frontDoor[0] && z < frontDoor[1]) || (z > midDoor[0] && z < midDoor[1]);
  const pillar = (z: number) => {
    const t = (z - (-L / 2 + 0.6)) / 1.25;
    return Math.abs(t - Math.round(t)) * 1.25 < 0.07;
  };
  const P = st[0].pts.length / 2;
  const body = loft(
    st,
    (i, k, side) => {
      const zm = (st[i].z + st[i + 1].z) / 2;
      if (k === 0) return VM.UNDER;
      if (lod === 2) return k === 1 ? VM.MUNI_RED : k === 2 ? (zm > L / 2 - 0.3 ? VM.GLASS : VM.GLASS) : k === 3 ? VM.MUNI_WHITE : VM.MUNI_GREY;
      if (k === 1) return VM.TRIM;
      // Curb-side doors (right): glass full height.
      if (side === 1 && inDoor(zm) && k >= 2 && k <= 5) return VM.GLASS;
      if (k === 2) return VM.MUNI_GREY;
      if (k === 3) return VM.MUNI_RED;
      if (k === 4) return VM.MUNI_WHITE;
      if (k === 5) return pillar(zm) && !(side === 1 && inDoor(zm)) ? VM.TRIM : VM.GLASS;
      if (k === 6) return VM.MUNI_WHITE;
      return k >= P - 3 ? VM.MUNI_GREY : VM.MUNI_WHITE;
    },
    (end, k) => {
      if (k === 0) return VM.UNDER;
      const p = end === 1 ? st[st.length - 1].pts : st[0].pts;
      const y = (p[k * 2 + 1] + p[k * 2 + 3]) / 2;
      if (y < 0.6) return VM.TRIM;
      if (y < 1.34) return VM.MUNI_RED;
      if (y < 1.42) return VM.MUNI_WHITE;
      if (y < 2.6) return end === 1 ? VM.GLASS : VM.TRIM;
      return VM.MUNI_WHITE;
    },
  );
  const parts = [body];
  // Destination sign, lamps, roof pods, trolley poles.
  parts.push(box(1.7, 0.26, 0.04, 0, 2.72, L / 2 + 0.01, VM.SIGN));
  for (const x of [-1, 1]) {
    parts.push(box(0.32, 0.14, 0.05, x * (hw - 0.3), 0.85, L / 2 + 0.01, VM.HEAD));
    parts.push(box(0.22, 0.32, 0.05, x * (hw - 0.17), 1.05, -L / 2 - 0.01, VM.TAIL));
  }
  parts.push(box(1.9, 0.32, 3.2, 0, 3.3, 1.2, VM.MUNI_GREY));
  if (lod < 2) parts.push(box(1.2, 0.25, 1.6, 0, 3.27, -3.6, VM.MUNI_GREY));
  for (const x of [-0.28, 0.28]) {
    const pole = new THREE.CylinderGeometry(0.025, 0.035, 6.0, lod === 0 ? 6 : 4);
    pole.translate(0, 3.0, 0);
    pole.rotateX(-1.25);
    pole.translate(x, 3.4, -2.6);
    parts.push(painted(pole, VM.TRIM));
  }
  if (lod === 0) {
    parts.push(box(0.6, 0.5, 0.04, 0, 0.62, L / 2 + 0.01, VM.TRIM)); // bike rack
    parts.push(box(0.12, 0.25, 0.25, hw + 0.08, 2.5, L / 2 - 0.25, VM.TRIM)); // mirror
    parts.push(box(0.12, 0.25, 0.25, -hw - 0.08, 2.5, L / 2 - 0.25, VM.TRIM));
  }
  parts.push(...wheels(R, 0.3, hw - 0.22, [zF], lod, VM.RIM));
  parts.push(...wheels(R, 0.52, hw - 0.33, [zRa], lod, VM.RIM));
  return merge(parts);
}

// ───────────────────────────── box truck ─────────────────────────────

function truck(lod: number): THREE.BufferGeometry {
  const L = 7.4;
  const W = 2.3;
  const hw = W / 2;
  const R = 0.42;
  const zF = L / 2 - 1.15;
  const zRa = -L / 2 + 1.7;
  const cabW = 2.0;
  const zBox = L / 2 - 2.1; // box front
  const zA = L / 2 - 0.55;
  const zW = L / 2 - 1.1;
  const cab = (z: number) => {
    const dEnd = L / 2 - z;
    const w = (cabW / 2) * (1 - 0.06 * Math.pow(Math.max(0, 1 - dEnd / 0.4), 2));
    const y0 = bottomAt(z, L, 0.55, R, [zF], 0.07);
    const top = z > zA ? 1.45 - 0.3 * Math.pow((z - zA) / (L / 2 - zA), 1.5) : 2.45 - (2.45 - 1.5) * sstep(zW, zA, z);
    return monotone([0, y0, w * 0.95, y0, w, y0 + 0.1, w, 1.4, w * 0.98, Math.min(top - 0.1, 1.55), w * 0.9, top, 0, top + 0.02]);
  };
  let zs = uniq([zBox + 0.05, zW, (zW + zA) / 2, zA, L / 2 - 0.25, L / 2 - 0.08, L / 2, ...(lod === 2 ? [zF - R, zF + R] : [-1, -0.6, 0, 0.6, 1].map((a) => zF + a * (R + 0.07)))]);
  zs = zs.filter((z) => z >= zBox + 0.05 && z <= L / 2);
  const st: Station[] = zs.map((z) => ({ z, pts: cab(z) }));
  const P = st[0].pts.length / 2;
  const parts = [
    loft(
      st,
      (i, k) => {
        const zm = (st[i].z + st[i + 1].z) / 2;
        if (k === 0) return VM.UNDER;
        if (k === 1) return VM.TRIM;
        if ((k === P - 2 || k === P - 3) && zm > zW + 0.03 && zm < zA) return VM.GLASS;
        if (k === 4 && zm < zW + 0.1 && zm > zBox + 0.3) return VM.GLASS;
        return VM.WHITE;
      },
      (end, k) => {
        if (k === 0) return VM.UNDER;
        const p = end === 1 ? st[st.length - 1].pts : st[0].pts;
        const y = (p[k * 2 + 1] + p[k * 2 + 3]) / 2;
        return y < 0.95 ? VM.TRIM : VM.WHITE;
      },
    ),
  ];
  // Cargo box (tintable: fleet colours), chassis rail, bumper, lamps.
  parts.push(box(W, 2.75, zBox + L / 2 - 0.05, 0, 0.95 + 1.375, (zBox - L / 2) / 2, VM.PAINT));
  parts.push(box(1.0, 0.3, zBox + L / 2, 0, 0.75, (zBox - L / 2) / 2, VM.UNDER));
  if (lod < 2) {
    parts.push(box(W - 0.1, 0.06, 0.03, 0, 1.6, -L / 2 - 0.015, VM.SEAM));
    parts.push(box(W - 0.1, 0.06, 0.03, 0, 2.3, -L / 2 - 0.015, VM.SEAM));
    parts.push(box(W + 0.02, 0.12, zBox + L / 2 - 0.05, 0, 0.98, (zBox - L / 2) / 2, VM.TRIM));
  }
  for (const x of [-1, 1]) {
    parts.push(box(0.28, 0.14, 0.06, x * (cabW / 2 - 0.25), 1.05, L / 2 - 0.02, VM.HEAD));
    parts.push(box(0.15, 0.3, 0.05, x * (hw - 0.12), 1.2, -L / 2 - 0.01, VM.TAIL));
    if (lod === 0) parts.push(box(0.1, 0.35, 0.2, x * (cabW / 2 + 0.12), 1.85, zA - 0.2, VM.TRIM));
  }
  parts.push(box(cabW, 0.3, 0.14, 0, 0.7, L / 2 - 0.04, VM.TRIM));
  parts.push(...wheels(R, 0.24, cabW / 2 - 0.17, [zF], lod, VM.RIM_DARK));
  parts.push(...wheels(R, 0.42, hw - 0.24, [zRa], lod, VM.RIM_DARK));
  return merge(parts);
}

export function vehicleGeometry(type: VType, lod: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  if (type === VType.Van) g = van(lod);
  else if (type === VType.Bus) g = bus(lod);
  else if (type === VType.Truck) g = truck(lod);
  else g = car(type, lod);
  g.computeBoundingSphere();
  return g;
}

export const VEHICLE_LEN: Record<number, number> = {
  [VType.Sedan]: 4.85,
  [VType.Hatch]: 4.26,
  [VType.Suv]: 4.72,
  [VType.Van]: 5.95,
  [VType.Taxi]: 4.9,
  [VType.Bus]: 12.3,
  [VType.Pickup]: 5.8,
  [VType.Truck]: 7.4,
};
export const VEHICLE_WID: Record<number, number> = {
  [VType.Sedan]: 1.84,
  [VType.Hatch]: 1.79,
  [VType.Suv]: 1.9,
  [VType.Van]: 2.05,
  [VType.Taxi]: 1.84,
  [VType.Bus]: 2.59,
  [VType.Pickup]: 2.0,
  [VType.Truck]: 2.3,
};
