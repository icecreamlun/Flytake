/**
 * Street-furniture models (metres, +Y up, local +X points toward the street, local +Z along the street).
 */
import * as THREE from 'three';
import { Emit, Kit } from './kit';

const GALV = '#8b8f92';
const DARK_GREEN = '#1f2f27';
const BLACK = '#17191b';

/** Modern SF cobra-head: tapered steel pole with a mast arm reaching over the street. */
export function cobraLamp(): THREE.BufferGeometry {
  const k = new Kit();
  k.cyl(0.17, 0.15, 0.6, 0, 0, 0, '#6f7275', { r: 0.7 });
  k.cyl(0.12, 0.075, 8.6, 0, 0.6, 0, GALV, { r: 0.45, m: 0.6, seg: 10 });
  // Mast arm (slightly rising) and the luminaire.
  k.cyl(0.05, 0.04, 2.4, 0.05, 8.95, 0, GALV, { r: 0.45, m: 0.6, rz: -Math.PI / 2 + 0.12, seg: 6 });
  k.box(0.78, 0.17, 0.36, 2.45, 9.18, 0, '#7d8285', { r: 0.4, m: 0.5 });
  k.box(0.6, 0.03, 0.26, 2.47, 9.08, 0, '#ffffff', { e: Emit.Lamp, r: 0.2 });
  return k.build();
}

/** Market Street "Path of Gold" standard: fluted dark-bronze column with a trident of three globes. */
export function pathOfGold(): THREE.BufferGeometry {
  const k = new Kit();
  const BRONZE = '#2e3326';
  k.cyl(0.42, 0.36, 0.5, 0, 0, 0, BRONZE, { r: 0.5, m: 0.6, seg: 12 });
  k.cyl(0.3, 0.26, 1.4, 0, 0.5, 0, BRONZE, { r: 0.5, m: 0.6, seg: 12 });
  k.cyl(0.36, 0.3, 0.25, 0, 1.9, 0, BRONZE, { r: 0.5, m: 0.6, seg: 12 });
  k.cyl(0.19, 0.15, 5.0, 0, 2.15, 0, BRONZE, { r: 0.45, m: 0.65, seg: 12 });
  k.cyl(0.22, 0.2, 0.3, 0, 7.1, 0, BRONZE, { r: 0.45, m: 0.6, seg: 12 });
  // Trident: central stem + two curved arms.
  k.cyl(0.07, 0.06, 1.3, 0, 7.4, 0, BRONZE, { r: 0.45, m: 0.6 });
  for (const s of [-1, 1]) {
    k.cyl(0.05, 0.05, 0.94, 0, 7.65, 0, BRONZE, { r: 0.45, m: 0.6, rz: -s * 0.88 });
    k.cyl(0.05, 0.05, 0.5, 0.72 * s, 8.15, 0, BRONZE, { r: 0.45, m: 0.6 });
    k.sphere(0.28, 0.72 * s, 8.95, 0, '#fff4dc', { e: Emit.Globe, r: 0.15, seg: 12 });
    k.cyl(0.1, 0.12, 0.12, 0.72 * s, 8.62, 0, BRONZE, { r: 0.45, m: 0.6 });
  }
  k.sphere(0.32, 0, 9.25, 0, '#fff4dc', { e: Emit.Globe, r: 0.15, seg: 12 });
  k.cyl(0.12, 0.14, 0.14, 0, 8.88, 0, BRONZE, { r: 0.45, m: 0.6 });
  return k.build();
}

/** Grant Avenue Chinatown lamp: red & green pole, golden pagoda-roofed lantern. */
export function chinatownLamp(): THREE.BufferGeometry {
  const k = new Kit();
  const RED = '#8f1d14';
  const GOLD = '#b38a2e';
  const GREEN = '#1f5a3a';
  k.cyl(0.24, 0.2, 0.7, 0, 0, 0, GREEN, { r: 0.5, seg: 8 });
  k.cyl(0.11, 0.09, 4.2, 0, 0.7, 0, RED, { r: 0.45, seg: 8 });
  k.cyl(0.16, 0.16, 0.12, 0, 2.4, 0, GOLD, { r: 0.35, m: 0.8, seg: 8 });
  // Lantern body (glowing) with gold frame.
  k.cyl(0.3, 0.3, 0.75, 0, 4.9, 0, '#ffd9a0', { e: Emit.Globe, r: 0.3, seg: 6 });
  k.cyl(0.33, 0.33, 0.06, 0, 4.85, 0, GOLD, { r: 0.35, m: 0.8, seg: 6 });
  k.cyl(0.33, 0.33, 0.06, 0, 5.62, 0, GOLD, { r: 0.35, m: 0.8, seg: 6 });
  // Pagoda roof with upturned eaves.
  k.cyl(0.62, 0.12, 0.42, 0, 5.68, 0, GREEN, { r: 0.5, seg: 6 });
  k.cyl(0.06, 0.02, 0.35, 0, 6.08, 0, GOLD, { r: 0.35, m: 0.8, seg: 6 });
  return k.build();
}

/** Black acorn post-top (Embarcadero promenade, plazas, parks). */
export function acornLamp(): THREE.BufferGeometry {
  const k = new Kit();
  k.cyl(0.18, 0.14, 0.6, 0, 0, 0, BLACK, { r: 0.5, m: 0.5, seg: 10 });
  k.cyl(0.08, 0.065, 3.6, 0, 0.6, 0, BLACK, { r: 0.45, m: 0.6, seg: 8 });
  k.cyl(0.14, 0.1, 0.18, 0, 4.15, 0, BLACK, { r: 0.45, m: 0.6, seg: 8 });
  k.sphere(0.26, 0, 4.62, 0, '#fff2d6', { e: Emit.Globe, r: 0.15, sy: 1.35, seg: 12 });
  k.cyl(0.05, 0.09, 0.14, 0, 4.95, 0, BLACK, { r: 0.45, m: 0.6, seg: 8 });
  return k.build();
}

/** Traffic signal pole with a 3-lens head facing local +Z (toward approaching traffic) and a pedestrian head. */
export function signalPole(): THREE.BufferGeometry {
  const k = new Kit();
  k.cyl(0.13, 0.11, 0.4, 0, 0, 0, '#3a3d3f', { r: 0.6 });
  k.cyl(0.085, 0.075, 4.3, 0, 0.4, 0, '#2b3a33', { r: 0.5, m: 0.4, seg: 8 });
  // Vehicle head.
  k.box(0.38, 1.08, 0.26, 0, 3.75, 0.12, '#24282a', { r: 0.6 });
  k.box(0.5, 1.2, 0.03, 0, 3.75, -0.02, BLACK, { r: 0.8 });
  const lens: [number, number][] = [
    [4.1, Emit.SigRed],
    [3.75, Emit.SigAmber],
    [3.4, Emit.SigGreen],
  ];
  for (const [y, e] of lens) {
    k.cyl(0.12, 0.12, 0.02, 0, y, 0.26, '#1a1a1a', { e, r: 0.2, rx: Math.PI / 2, seg: 12 });
    // Visor.
    k.box(0.28, 0.03, 0.2, 0, y + 0.15, 0.35, '#1b1d1e', { r: 0.6 });
  }
  // Pedestrian head (faces the crosswalk, local -X side).
  k.box(0.32, 0.32, 0.24, -0.2, 2.6, 0, '#24282a', { r: 0.6 });
  k.box(0.02, 0.24, 0.2, -0.37, 2.6, 0, '#1a1a1a', { e: Emit.Ped, r: 0.3 });
  return k.build();
}

/** SF fire hydrant: white body, coloured bonnet (tintable). */
export function hydrant(): THREE.BufferGeometry {
  const k = new Kit();
  k.cyl(0.17, 0.17, 0.08, 0, 0, 0, '#d9d6cf', { r: 0.45, m: 0.3 });
  k.cyl(0.12, 0.11, 0.52, 0, 0.08, 0, '#e4e1da', { r: 0.4, m: 0.3, seg: 10 });
  k.cyl(0.14, 0.14, 0.06, 0, 0.58, 0, '#d0cdc5', { r: 0.4, m: 0.3, seg: 10 });
  k.sphere(0.12, 0, 0.66, 0, '#ffffff', { r: 0.4, m: 0.3, sy: 0.75, t: 1 });
  k.cyl(0.03, 0.03, 0.08, 0, 0.74, 0, '#ffffff', { r: 0.4, m: 0.3, t: 1 });
  for (const s of [-1, 1]) k.cyl(0.05, 0.05, 0.2, 0, 0.32, 0, '#d0cdc5', { r: 0.4, m: 0.3, rz: (-s * Math.PI) / 2 });
  k.cyl(0.07, 0.07, 0.1, 0, 0.36, 0.13, '#d0cdc5', { r: 0.4, m: 0.3, rx: Math.PI / 2 });
  return k.build();
}

/** SF green "Renew" trash can. */
export function trashCan(): THREE.BufferGeometry {
  const k = new Kit();
  k.cyl(0.3, 0.32, 0.95, 0, 0, 0, '#1d3a2c', { r: 0.55, m: 0.4, seg: 12 });
  k.sphere(0.32, 0, 0.95, 0, '#1a3327', { r: 0.5, m: 0.4, sy: 0.45, seg: 12 });
  k.box(0.26, 0.12, 0.05, 0, 0.98, 0.3, '#0c0d0d', { r: 0.8 });
  return k.build();
}

/** Newspaper rack (body colour tintable). */
export function newsBox(): THREE.BufferGeometry {
  const k = new Kit();
  k.box(0.5, 0.82, 0.45, 0, 0.55, 0, '#ffffff', { r: 0.45, m: 0.2, t: 1 });
  k.box(0.52, 0.08, 0.47, 0, 0.99, 0, '#ffffff', { r: 0.45, m: 0.2, t: 1 });
  k.box(0.4, 0.3, 0.02, 0, 0.72, 0.23, '#a9b4ba', { r: 0.1, m: 0.1 });
  for (const sx of [-0.2, 0.2]) k.box(0.05, 0.14, 0.05, sx, 0.07, 0, '#2a2a2a', { r: 0.6 });
  return k.build();
}

export function parkingMeter(): THREE.BufferGeometry {
  const k = new Kit();
  k.cyl(0.04, 0.035, 1.05, 0, 0, 0, '#5a5e60', { r: 0.5, m: 0.6 });
  k.box(0.2, 0.36, 0.16, 0, 1.2, 0, '#4b5157', { r: 0.45, m: 0.5 });
  k.box(0.14, 0.1, 0.01, 0, 1.28, 0.085, '#2b4b5c', { r: 0.1 });
  return k.build();
}

export function bench(): THREE.BufferGeometry {
  const k = new Kit();
  const WOOD = '#6b4c32';
  for (let i = 0; i < 3; i++) k.box(0.1, 0.04, 1.8, 0.05 - i * 0.13, 0.46, 0, WOOD, { r: 0.8 });
  for (let i = 0; i < 2; i++) k.box(0.04, 0.1, 1.8, 0.16, 0.62 + i * 0.14, 0, WOOD, { r: 0.8, rz: 0.15 });
  for (const z of [-0.75, 0.75]) {
    k.box(0.45, 0.04, 0.06, -0.05, 0.42, z, BLACK, { r: 0.5, m: 0.6 });
    k.box(0.05, 0.44, 0.06, -0.22, 0.22, z, BLACK, { r: 0.5, m: 0.6 });
    k.box(0.05, 0.84, 0.06, 0.15, 0.42, z, BLACK, { r: 0.5, m: 0.6, rz: 0.15 });
  }
  return k.build();
}

export function bollard(): THREE.BufferGeometry {
  const k = new Kit();
  k.cyl(0.12, 0.11, 0.85, 0, 0, 0, '#2c2f31', { r: 0.5, m: 0.5, seg: 10 });
  k.sphere(0.11, 0, 0.85, 0, '#2c2f31', { r: 0.5, m: 0.5, sy: 0.5, seg: 10 });
  k.cyl(0.115, 0.115, 0.06, 0, 0.66, 0, '#c9c4b5', { r: 0.3, m: 0.2, seg: 10 });
  return k.build();
}

/** Muni shelter: steel frame, glass walls, roof with red Muni band, backlit ad panel. Long axis along local Z. */
export function muniShelter(): THREE.BufferGeometry {
  const k = new Kit();
  const FRAME = '#5d6366';
  const GLASS = '#33434b';
  k.box(1.7, 0.08, 4.4, 0, 2.55, 0, '#9aa2a5', { r: 0.4, m: 0.6 });
  k.box(1.72, 0.18, 4.42, 0, 2.42, 0, '#a8302a', { r: 0.5 });
  for (const z of [-2.1, 2.1]) for (const x of [-0.75, 0.75]) k.box(0.07, 2.4, 0.07, x, 1.2, z, FRAME, { r: 0.4, m: 0.7 });
  k.box(0.04, 2.0, 4.2, -0.78, 1.25, 0, GLASS, { r: 0.05, m: 0.1 });
  k.box(1.5, 2.0, 0.04, 0, 1.25, -2.12, '#e9eef0', { e: Emit.Panel, r: 0.2 });
  k.box(1.5, 2.0, 0.04, 0, 1.25, -2.17, GLASS, { r: 0.05, m: 0.1 });
  k.box(0.4, 0.06, 3.2, -0.45, 0.45, 0, '#4a4f52', { r: 0.4, m: 0.6 });
  return k.build();
}

/** One red paper lantern (strung over Grant Ave). */
export function lantern(): THREE.BufferGeometry {
  const k = new Kit();
  k.sphere(0.28, 0, 0, 0, '#d1281b', { e: Emit.Lantern, r: 0.5, sy: 0.85, seg: 10 });
  k.cyl(0.12, 0.12, 0.06, 0, 0.22, 0, '#c8a040', { r: 0.4, m: 0.7 });
  k.cyl(0.12, 0.12, 0.06, 0, -0.28, 0, '#c8a040', { r: 0.4, m: 0.7 });
  k.cyl(0.015, 0.015, 0.2, 0, -0.42, 0, '#c8a040', { r: 0.6 });
  return k.build();
}
