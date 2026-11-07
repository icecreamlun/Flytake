/**
 * Architectural style families and per-building facade parameters, derived from the record
 * (district, use, structure, year, height, OSM material/colour). Deterministic per building id.
 */
import * as THREE from 'three';
import type { BuildingRecord } from '../../contracts';

export const enum Style {
  Chinatown = 0,
  HistoricMasonry = 1,
  PrewarOffice = 2,
  ModernGlass = 3,
  ModernConcrete = 4,
  Midcentury = 5,
  ResidentialMid = 6,
  House = 7,
  Utilitarian = 8,
  Parking = 9,
}

export const enum Mat {
  PaintedBrick = 0,
  RedBrick = 1,
  Stucco = 2,
  Limestone = 3,
  Terracotta = 4,
  Concrete = 5,
  Glass = 6,
  MetalPanel = 7,
  WoodSiding = 8,
  Corrugated = 9,
}

/** Bit flags (stored as a float, decoded with mod/floor in GLSL). */
export const F = {
  storefront: 1,
  cornice: 2,
  fireEscape: 4,
  arched: 8,
  pilasters: 16,
  rusticBase: 32,
  pagoda: 64,
  garage: 128,
  floodlit: 256,
  fins: 512,
  bays: 1024,
  braced: 2048,
} as const;

export const enum Occupancy {
  Office = 0,
  Residential = 1,
  Hotel = 2,
  Retail = 3,
}

export interface StyleParams {
  style: Style;
  material: Mat;
  floorH: number;
  groundH: number;
  module: number;
  winW: number; // fraction of module
  winH: number; // metres
  sill: number; // metres above floor
  recess: number; // metres
  base: THREE.Color; // linear
  trim: THREE.Color;
  glass: THREE.Color;
  accent: THREE.Color;
  seed: number;
  flags: number;
  dirt: number;
  topBand: number;
  occupancy: Occupancy;
  litProb: number;
  parapetH: number;
  roof: THREE.Color;
  /** Roof covering: 0 membrane, 1 tar/gravel, 2 green, 3 tile. */
  roofKind: number;
}

/** Texels per building in the style texture. */
export const STYLE_TEXELS = 8;

// ── helpers ──────────────────────────────────────────────────────────────

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];
const range = (rng: Rng, a: number, b: number) => a + (b - a) * rng();
const col = (hex: string) => new THREE.Color(hex);

/** Slightly jitter a colour in value/saturation so no two buildings match exactly. */
function vary(c: THREE.Color, rng: Rng, amount = 0.06): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  hsl.h = (hsl.h + (rng() - 0.5) * amount * 0.25 + 1) % 1;
  hsl.s = THREE.MathUtils.clamp(hsl.s * (1 + (rng() - 0.5) * amount * 2), 0, 1);
  hsl.l = THREE.MathUtils.clamp(hsl.l * (1 + (rng() - 0.5) * amount * 1.5), 0, 1);
  return new THREE.Color().setHSL(hsl.h, hsl.s, hsl.l);
}

// ── palettes (sRGB hex; THREE.Color converts to linear) ──────────────────

const P = {
  chinaWall: ['#eadfc3', '#f0e2ac', '#c8d9b6', '#b0ccb6', '#e9b79c', '#d8d1c3', '#f1ece0', '#b65a43', '#d8a675', '#b6c9d6', '#e8c886', '#a7c49e', '#e3d6a0', '#cf8f75'],
  chinaTrim: ['#b0281f', '#1f6b45', '#c9a33b', '#f2ede2', '#21665f', '#8a1c1c', '#2a4f7a', '#b0281f', '#1f6b45'],
  awning: ['#b3201b', '#1d7a46', '#d9a521', '#1f4f8a', '#7a1c28', '#d6561a', '#0f6e6a', '#a31c1c', '#2b6b2b'],
  brickRed: ['#8a4c3a', '#7b4433', '#8f5a45', '#6e4234', '#985f48', '#82503e', '#9a6a55'],
  brickPainted: ['#cfc4ab', '#3e3e3a', '#e3dccb', '#9a8f7c', '#5d6b5e'],
  castIron: ['#2f3a2f', '#262626', '#d8ccb0', '#4a3328', '#33404a'],
  limestone: ['#d6cbb2', '#cfc2a6', '#c8bda5', '#dcd3bf', '#bfb39a', '#d2c6ab'],
  terracotta: ['#e0d3b8', '#d9c7a5', '#e6dcc6', '#d4c3a0'],
  buffBrick: ['#c9a77f', '#b8956c', '#d0b58e', '#a8805d'],
  glass: ['#2f4a52', '#33414a', '#3e3a33', '#27405e', '#4d5a62', '#2e4a44', '#1f2a33', '#3a4a58'],
  mullion: ['#9aa2a8', '#2c2f33', '#5b5f63', '#b5b8ba', '#7d8286'],
  concrete: ['#c9c3b6', '#d6d1c6', '#bdb2a0', '#a9a49b', '#cfc6b2', '#b9b4aa'],
  darkGlass: ['#28323a', '#30383d', '#3a3530', '#2a3138'],
  spandrel: ['#4f6a7a', '#d9d5cc', '#7a9a9a', '#2b2d30', '#8a8f94', '#a3865f', '#5d7d8c'],
  stucco: ['#ece6d6', '#e8dcc0', '#f0e6c8', '#d9e0e3', '#d3dccb', '#e6cfc2', '#cfcac0', '#f3efe6', '#e2d4b4', '#c9d5dc', '#e8d9b0'],
  resTrim: ['#f4f1e8', '#e8e2d2', '#3a4a5a', '#5a3b2a', '#2e4a3a', '#f4f1e8', '#f4f1e8'],
  siding: ['#d8e2e6', '#e9dcc0', '#c7d6c3', '#f1e3c8', '#e6c7c0', '#c9d3de', '#efe9da', '#d9c9a3', '#a9b8c3', '#b8c4a8', '#e7d7d9'],
  pierShed: ['#d7cdb4', '#cfc4aa', '#dcd4c0'],
  corrugated: ['#9da3a6', '#b4b0a5', '#8f9a9c'],
  parking: ['#b8b3a8', '#a8a39a', '#c2bdb1'],
  roofMembrane: ['#bdbbb6', '#cfcdc7', '#a9a7a1', '#9a9993', '#b5aea2'],
  roofTar: ['#4a4846', '#5a5652', '#3e3d3b', '#615c55'],
  roofGravel: ['#8e877b', '#9c9488', '#7d776d'],
} as const;

const CSS_FALLBACK = new THREE.Color();
function osmColour(c: string | undefined): THREE.Color | null {
  if (!c) return null;
  const v = c.split(';')[0].trim().toLowerCase();
  // Only accept hex or plain CSS colour names (THREE.Color warns on anything else).
  if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(v) && !(v in THREE.Color.NAMES)) return null;
  CSS_FALLBACK.set(v);
  return CSS_FALLBACK.clone();
}

// ── classification ───────────────────────────────────────────────────────

function chooseStyle(b: BuildingRecord, rng: Rng): Style {
  const h = b.height;
  const y = b.yearBuilt;
  const d = b.district;
  const use = b.use;
  const st = b.structure;
  if (b.overWater) return Style.Utilitarian;
  if (use === 'parking') return Style.Parking;
  if (use === 'industrial' || use === 'transport') return h > 30 ? Style.ModernConcrete : Style.Utilitarian;
  if (b.landmark === 'embarcadero_center' || b.landmark === 'hyatt_regency') return Style.ModernConcrete;
  if (b.material === 'glass') return Style.ModernGlass;
  if (d === 'chinatown' && h < 34 && y < 1975) return Style.Chinatown;
  const office = use === 'office' || use === 'commercial' || use === 'hotel' || use === 'civic' || use === 'school' || use === 'religious';
  if (y >= 1960 && h >= 40) {
    const concreteBias = st === 'C1' || st === 'C2' || st === 'PC' ? 0.62 : 0.3;
    if (y >= 1985 && rng() < 0.65) return Style.ModernGlass;
    return rng() < concreteBias ? Style.ModernConcrete : rng() < 0.55 ? Style.ModernGlass : Style.Midcentury;
  }
  if (y >= 1975) {
    if (use === 'residential') return rng() < 0.7 ? Style.ResidentialMid : Style.ModernConcrete;
    return h > 20 ? (rng() < 0.5 ? Style.ModernGlass : Style.ModernConcrete) : rng() < 0.5 ? Style.Midcentury : Style.ModernConcrete;
  }
  if (y >= 1945) {
    if (use === 'residential') return h <= 11 && (st === 'W1' || st === 'W1_SOFT') ? Style.House : Style.ResidentialMid;
    return h > 14 ? Style.Midcentury : rng() < 0.5 ? Style.Midcentury : Style.ModernConcrete;
  }
  // Pre-war.
  if (d === 'jackson_square' && h < 26) return Style.HistoricMasonry;
  if (st === 'URM' && h < 20 && (use === 'commercial' || use === 'retail' || use === 'office' || use === 'mixed') && (d === 'fidi' || d === 'north_beach' || d === 'soma'))
    return rng() < 0.7 ? Style.HistoricMasonry : Style.PrewarOffice;
  if (office && h >= 16) return Style.PrewarOffice;
  if (use === 'residential' || use === 'mixed') {
    if (h <= 11.5 && (st === 'W1' || st === 'W1_SOFT' || st === 'W2')) return Style.House;
    return Style.ResidentialMid;
  }
  if (use === 'retail') return h < 12 ? Style.HistoricMasonry : Style.PrewarOffice;
  return h > 16 ? Style.PrewarOffice : rng() < 0.5 ? Style.HistoricMasonry : Style.ResidentialMid;
}

function occupancyOf(b: BuildingRecord): Occupancy {
  switch (b.use) {
    case 'residential':
    case 'mixed':
      return Occupancy.Residential;
    case 'hotel':
      return Occupancy.Hotel;
    case 'retail':
    case 'industrial':
    case 'transport':
    case 'parking':
      return Occupancy.Retail;
    default:
      return Occupancy.Office;
  }
}

export function computeStyle(b: BuildingRecord, groupSeed: number): StyleParams {
  // Parts of one building share the group seed so they get the same look.
  const rng = mulberry32(groupSeed);
  let style = chooseStyle(b, rng);
  const h = b.height;
  let flags = 0;
  let material: Mat;
  let base: THREE.Color;
  let trim: THREE.Color;
  let glass = vary(col(pick(rng, P.darkGlass)), rng);
  let accent = col(pick(rng, P.awning));
  let floorH = 3.6;
  let groundH = 4.6;
  let module = 2.8;
  let winW = 0.5;
  let winHf = 0.55;
  let sillF = 0.25;
  let recess = 0.15;
  let topBand = 1.2;
  let dirt = range(rng, 0.25, 0.7);
  const year = b.yearBuilt;
  const street = b.use === 'retail' || b.use === 'mixed' || b.use === 'commercial' || b.use === 'hotel';

  switch (style) {
    case Style.Chinatown: {
      const r = rng();
      material = r < 0.6 ? Mat.PaintedBrick : r < 0.9 ? Mat.Stucco : Mat.RedBrick;
      base = vary(col(material === Mat.RedBrick ? pick(rng, P.brickRed) : pick(rng, P.chinaWall)), rng);
      trim = col(pick(rng, P.chinaTrim));
      floorH = range(rng, 3.3, 3.8);
      groundH = range(rng, 4.3, 5.0);
      module = range(rng, 2.5, 3.2);
      winW = range(rng, 0.46, 0.58);
      winHf = range(rng, 0.5, 0.6);
      sillF = 0.26;
      recess = 0.14;
      topBand = range(rng, 1.3, 2.0);
      flags |= F.storefront;
      if (rng() < 0.8) flags |= F.cornice;
      if (rng() < 0.55) flags |= F.fireEscape;
      if (rng() < 0.1) flags |= F.arched;
      if (rng() < 0.55) flags |= F.bays;
      const grant = (b.address ?? '').toLowerCase().includes('grant');
      if (rng() < (grant ? 0.35 : 0.1)) flags |= F.pagoda;
      dirt = range(rng, 0.4, 0.85);
      break;
    }
    case Style.HistoricMasonry: {
      const r = rng();
      material = r < 0.72 ? Mat.RedBrick : r < 0.92 ? Mat.PaintedBrick : Mat.Stucco;
      base = vary(col(material === Mat.RedBrick ? pick(rng, P.brickRed) : pick(rng, P.brickPainted)), rng);
      trim = col(pick(rng, P.castIron));
      floorH = range(rng, 4.0, 4.6);
      groundH = range(rng, 4.8, 5.6);
      module = range(rng, 2.6, 3.4);
      winW = range(rng, 0.4, 0.5);
      winHf = range(rng, 0.58, 0.66);
      sillF = 0.2;
      recess = 0.22;
      topBand = range(rng, 1.2, 1.8);
      flags |= F.storefront | F.cornice;
      if (rng() < 0.6) flags |= F.arched;
      if (rng() < 0.3) flags |= F.pilasters;
      if (rng() < 0.2) flags |= F.fireEscape;
      break;
    }
    case Style.PrewarOffice: {
      const r = rng();
      material = r < 0.4 ? Mat.Limestone : r < 0.75 ? Mat.Terracotta : Mat.RedBrick;
      base = vary(col(material === Mat.Limestone ? pick(rng, P.limestone) : material === Mat.Terracotta ? pick(rng, P.terracotta) : pick(rng, P.buffBrick)), rng, 0.04);
      trim = base.clone().multiplyScalar(range(rng, 0.78, 0.9));
      floorH = range(rng, 3.6, 4.0);
      groundH = range(rng, 5.0, 6.5);
      module = range(rng, 2.3, 2.8);
      winW = range(rng, 0.5, 0.6);
      winHf = range(rng, 0.56, 0.64);
      sillF = 0.22;
      recess = 0.24;
      topBand = range(rng, 2.0, 3.2);
      flags |= F.cornice;
      if (street || b.use === 'office' || rng() < 0.5) flags |= F.storefront;
      if (rng() < 0.7) flags |= F.pilasters;
      if (rng() < 0.7) flags |= F.rusticBase;
      if (rng() < 0.15) flags |= F.arched;
      if (h > 40 && rng() < 0.35) flags |= F.floodlit;
      glass = vary(col('#2c3236'), rng);
      break;
    }
    case Style.ModernGlass: {
      material = Mat.Glass;
      glass = vary(col(pick(rng, P.glass)), rng, 0.08);
      base = col(pick(rng, P.mullion));
      trim = glass.clone().multiplyScalar(0.7); // spandrel glass
      floorH = range(rng, 3.8, 4.2);
      groundH = range(rng, 5.5, 7.5);
      module = pick(rng, [1.5, 1.5, 1.52, 3.0, 1.2]);
      winW = 0.965;
      winHf = range(rng, 0.66, 0.78);
      sillF = 0.12;
      recess = 0.03;
      topBand = range(rng, 1.4, 3.0);
      flags |= F.storefront;
      if (rng() < 0.25) flags |= F.pilasters; // expressed vertical mullion caps
      dirt = range(rng, 0.05, 0.25);
      break;
    }
    case Style.ModernConcrete: {
      material = Mat.Concrete;
      base = vary(col(pick(rng, P.concrete)), rng, 0.05);
      trim = base.clone().multiplyScalar(0.85);
      glass = vary(col(pick(rng, P.darkGlass)), rng);
      floorH = range(rng, 3.6, 4.0);
      groundH = range(rng, 5.0, 6.5);
      const fins = b.landmark === 'embarcadero_center' || rng() < 0.28;
      if (fins) {
        flags |= F.fins;
        module = range(rng, 1.1, 1.4);
        winW = range(rng, 0.42, 0.52);
        winHf = range(rng, 0.78, 0.86);
        sillF = 0.07;
        recess = range(rng, 0.55, 0.8);
      } else {
        module = range(rng, 1.5, 2.0);
        winW = range(rng, 0.55, 0.68);
        winHf = range(rng, 0.52, 0.62);
        sillF = 0.26;
        recess = range(rng, 0.3, 0.5);
      }
      topBand = range(rng, 1.4, 2.6);
      flags |= F.storefront;
      dirt = range(rng, 0.25, 0.6);
      break;
    }
    case Style.Midcentury: {
      const r = rng();
      material = r < 0.45 ? Mat.MetalPanel : r < 0.75 ? Mat.Limestone : Mat.Concrete;
      base = col(pick(rng, P.mullion));
      trim = vary(col(pick(rng, P.spandrel)), rng);
      glass = vary(col(pick(rng, [...P.glass, ...P.darkGlass])), rng);
      floorH = range(rng, 3.5, 3.9);
      groundH = range(rng, 4.5, 6.0);
      module = range(rng, 1.4, 1.8);
      winW = 0.95;
      winHf = range(rng, 0.45, 0.58);
      sillF = range(rng, 0.25, 0.32);
      recess = 0.06;
      topBand = range(rng, 1.0, 1.8);
      flags |= F.storefront;
      dirt = range(rng, 0.15, 0.45);
      break;
    }
    case Style.ResidentialMid: {
      const r = rng();
      const old = year < 1940;
      material = r < 0.5 ? Mat.Stucco : r < 0.75 ? Mat.PaintedBrick : r < 0.9 ? Mat.RedBrick : Mat.Concrete;
      base = vary(col(material === Mat.RedBrick ? pick(rng, P.brickRed) : material === Mat.Concrete ? pick(rng, P.concrete) : pick(rng, P.stucco)), rng);
      trim = col(pick(rng, P.resTrim));
      floorH = range(rng, 2.9, 3.3);
      groundH = range(rng, 3.4, 4.2);
      module = range(rng, 2.3, 2.9);
      winW = range(rng, 0.44, 0.56);
      winHf = range(rng, 0.5, 0.58);
      sillF = 0.28;
      recess = 0.12;
      topBand = range(rng, 0.8, 1.4);
      if (street || (b.district === 'north_beach' && rng() < 0.45)) flags |= F.storefront;
      else if (b.softStory || b.structure === 'W1_SOFT' || rng() < 0.35) flags |= F.garage;
      if (old && rng() < 0.7) flags |= F.cornice;
      if (old && material !== Mat.Stucco && rng() < 0.4) flags |= F.fireEscape;
      // Bay windows: the signature of pre-war SF flats; rarer on post-war apartment blocks.
      if (rng() < (year < 1950 ? 0.8 : 0.3)) flags |= F.bays;
      break;
    }
    case Style.House: {
      material = rng() < 0.6 ? Mat.WoodSiding : Mat.Stucco;
      base = vary(col(pick(rng, material === Mat.WoodSiding ? P.siding : P.stucco)), rng);
      trim = col(rng() < 0.75 ? '#f4f1e8' : pick(rng, P.resTrim));
      floorH = range(rng, 3.0, 3.4);
      groundH = range(rng, 2.8, 3.4);
      module = range(rng, 1.9, 2.5);
      winW = range(rng, 0.38, 0.48);
      winHf = range(rng, 0.56, 0.64);
      sillF = 0.24;
      recess = 0.1;
      topBand = range(rng, 0.7, 1.1);
      if (b.softStory || b.structure === 'W1_SOFT' || rng() < 0.6) flags |= F.garage;
      if (rng() < 0.85) flags |= F.cornice;
      if (rng() < (year < 1950 ? 0.88 : 0.45)) flags |= F.bays;
      break;
    }
    case Style.Utilitarian: {
      material = rng() < 0.6 ? Mat.Concrete : Mat.Corrugated;
      base = vary(col(material === Mat.Concrete ? pick(rng, P.pierShed) : pick(rng, P.corrugated)), rng, 0.04);
      trim = col(rng() < 0.6 ? '#3f5a48' : '#6b6f72');
      floorH = Math.max(4.5, Math.min(8, h * 0.5));
      groundH = Math.max(4.5, Math.min(8, h * 0.5));
      module = range(rng, 4.5, 6.5);
      winW = range(rng, 0.55, 0.75);
      winHf = floorH * 0.22;
      sillF = 0.62;
      recess = 0.08;
      topBand = 0.8;
      flags |= F.garage;
      dirt = range(rng, 0.4, 0.8);
      winHf = winHf / floorH;
      break;
    }
    case Style.Parking:
    default: {
      material = Mat.Concrete;
      base = vary(col(pick(rng, P.parking)), rng, 0.04);
      trim = base.clone().multiplyScalar(0.8);
      floorH = range(rng, 2.9, 3.2);
      groundH = range(rng, 3.4, 4.0);
      module = range(rng, 7, 9);
      winW = 0.9;
      winHf = 0.42;
      sillF = 0.36;
      recess = 0.4;
      topBand = 1.0;
      dirt = range(rng, 0.5, 0.9);
      break;
    }
  }

  // Moored vessels (hull below the waterline): white ferry superstructure with cabin ribbon windows.
  if (b.overWater && b.baseElevation < 0.5) {
    style = Style.Midcentury;
    material = Mat.MetalPanel;
    base = col('#2b3440');
    trim = col('#efede6');
    glass = col('#1d2a33');
    floorH = 2.8;
    groundH = 2.2;
    module = 1.6;
    winW = 0.92;
    winHf = 0.42;
    sillF = 0.32;
    recess = 0.04;
    topBand = 0.7;
    flags = 0;
    dirt = 0.2;
  }

  // OSM overrides (rare but authoritative).
  const oc = osmColour(b.colour);
  if (oc && material !== Mat.Glass) base = oc;
  if (b.material === 'brick' && material !== Mat.RedBrick && material !== Mat.PaintedBrick) {
    material = Mat.RedBrick;
    base = vary(col(pick(rng, P.brickRed)), rng);
  } else if (b.material === 'concrete' && material !== Mat.Concrete) material = Mat.Concrete;
  else if (b.material === 'wood') material = Mat.WoodSiding;
  else if (b.material === 'plaster') material = Mat.Stucco;

  // Real wall albedos: fresh white paint ~0.75, weathered stucco / concrete 0.4-0.6. Compress the
  // brightest palette entries so sunlit walls keep texture instead of blowing out to white boxes, and
  // give the residential pastels a little more colour (SF's painted houses read as colour, not white).
  if (material !== Mat.Glass) {
    const hsl = { h: 0, s: 0, l: 0 };
    base.getHSL(hsl);
    if (style === Style.House || style === Style.ResidentialMid) hsl.s = Math.min(1, hsl.s * 1.35 + 0.04);
    base.setHSL(hsl.h, hsl.s, hsl.l);
    const L = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
    if (L > 0.5) base.multiplyScalar((0.5 + (L - 0.5) * 0.6) / L);
  }

  // Use the real storey count when it is plausible: ground + (levels-1) typicals + top band = height.
  const usable = h - topBand;
  if (b.levels >= 2 && style !== Style.Utilitarian) {
    const fh = (usable - groundH) / (b.levels - 1);
    if (fh >= 2.7 && fh <= 5.2) floorH = fh;
    else if (fh > 5.2 && fh < 6.5) {
      groundH = Math.min(7.5, usable - (b.levels - 1) * 5.0);
      floorH = (usable - groundH) / (b.levels - 1);
    }
  }
  if (h < groundH + 1.5) {
    groundH = Math.max(2.6, h - topBand);
  }
  // One-storey buildings: whole wall is ground floor.
  if (style === Style.Utilitarian) groundH = Math.min(groundH, Math.max(3, h - topBand));

  const parapetH = style === Style.House ? 0.5 : h > 60 ? range(rng, 1.4, 2.6) : h > 20 ? range(rng, 0.9, 1.3) : range(rng, 0.6, 1.0);
  topBand = Math.max(topBand, parapetH + 0.2);

  // Roof covering.
  const rr = rng();
  let roofKind = 0;
  let roof: THREE.Color;
  if (style === Style.ModernGlass || style === Style.ModernConcrete || (year > 1970 && rr < 0.6)) {
    roof = col(pick(rng, P.roofMembrane));
  } else if (rr < 0.5) {
    roofKind = 1;
    roof = col(pick(rng, P.roofTar));
  } else if (rr < 0.78) {
    roofKind = 1;
    roof = col(pick(rng, P.roofGravel));
  } else {
    roof = col(pick(rng, P.roofMembrane));
  }
  if (rng() < 0.03 && h < 40) {
    roofKind = 2;
    roof = col('#5f7044');
  }
  if (b.roofColour) {
    const rc = osmColour(b.roofColour);
    if (rc) roof = rc;
  }
  roof = vary(roof, rng, 0.08);

  const occupancy = occupancyOf(b);
  // Night occupancy: for offices this is the fraction of floors still lit, for homes / hotels of units.
  const litProb = occupancy === Occupancy.Office ? range(rng, 0.1, 0.35) : occupancy === Occupancy.Residential ? range(rng, 0.25, 0.5) : occupancy === Occupancy.Hotel ? range(rng, 0.35, 0.6) : range(rng, 0.1, 0.3);

  return {
    style,
    material,
    floorH,
    groundH,
    module,
    winW,
    winH: winHf * floorH,
    sill: sillF * floorH,
    recess,
    base,
    trim,
    glass,
    accent,
    seed: rng(),
    flags,
    dirt,
    topBand,
    occupancy,
    litProb,
    parapetH,
    roof,
    roofKind,
  };
}

// ── iconic buildings ─────────────────────────────────────────────────────

interface Iconic {
  match: (b: BuildingRecord) => boolean;
  apply: (p: StyleParams) => void;
}
const named = (...names: string[]) => (b: BuildingRecord) => !!b.name && names.some((n) => b.name!.toLowerCase().includes(n));

/** Hand-tuned looks for the skyline's most recognisable towers (matched by OSM name / landmark id). */
const ICONIC: Iconic[] = [
  {
    // White aluminium sunshade bands over pale glass.
    match: named('salesforce tower'),
    apply: (p) => Object.assign(p, { style: Style.Midcentury, material: Mat.MetalPanel, base: col('#e4e6e6'), trim: col('#d5d9da'), glass: col('#6d8594'), module: 1.5, winW: 0.97, winH: p.floorH * 0.74, sill: p.floorH * 0.13, flags: F.storefront | F.pilasters }),
  },
  {
    // Bank of America Center: dark red carnelian granite, serrated bay windows.
    match: named('555 california'),
    apply: (p) => Object.assign(p, { style: Style.ModernConcrete, material: Mat.Terracotta, base: col('#4a2c29'), trim: col('#3a2220'), glass: col('#1f2224'), module: 1.45, winW: 0.62, winH: p.floorH * 0.66, sill: p.floorH * 0.18, recess: 0.35, flags: F.storefront }),
  },
  {
    // Alcoa Building: dark glass behind a diagonal-braced exoskeleton.
    match: (b) => b.landmark === 'one_maritime_plaza' || named('maritime plaza', 'alcoa')(b),
    apply: (p) => Object.assign(p, { style: Style.ModernGlass, material: Mat.Glass, base: col('#2a2724'), trim: col('#1d2226'), glass: col('#1d2428'), module: 1.5, flags: F.storefront | F.braced }),
  },
  {
    match: named('101 california', 'one sansome', 'citicorp'),
    apply: (p) => Object.assign(p, { style: Style.Midcentury, material: Mat.Limestone, base: col('#8f8a84'), trim: col('#b9ada0'), glass: col('#2f3a42'), winH: p.floorH * 0.5 }),
  },
  {
    match: named('44 montgomery', 'one montgomery tower', '50 california', 'hilton san francisco', 'chevron'),
    apply: (p) => Object.assign(p, { style: Style.ModernConcrete, material: Mat.Concrete, base: col('#dcd8ce'), trim: col('#c9c4b8') }),
  },
  {
    match: named('650 california', 'hartford'),
    apply: (p) => Object.assign(p, { style: Style.ModernConcrete, material: Mat.Concrete, base: col('#d8d3c8'), module: 1.2, winW: 0.5, winH: p.floorH * 0.82, sill: p.floorH * 0.08, recess: 0.6, flags: F.storefront | F.fins }),
  },
  {
    match: named('millennium tower', '181 fremont', 'park tower', '333 bush', 'spear tower', '555 mission'),
    apply: (p) => Object.assign(p, { style: Style.ModernGlass, material: Mat.Glass, glass: col(p.seed < 0.5 ? '#3d5566' : '#4a5a63'), trim: col('#2c3a44'), base: col('#9aa2a8') }),
  },
  {
    // US Custom House (1911): Beaux-Arts granite, rusticated base, arched windows.
    match: (b) => b.landmark === 'customs_house',
    apply: (p) => Object.assign(p, { style: Style.PrewarOffice, material: Mat.Limestone, base: col('#bdb6aa'), trim: col('#a9a194'), flags: F.storefront | F.cornice | F.pilasters | F.rusticBase | F.arched, recess: 0.35 }),
  },
];

export function applyIconic(b: BuildingRecord, p: StyleParams): StyleParams {
  for (const ic of ICONIC) if (ic.match(b)) {
    ic.apply(p);
    break;
  }
  return p;
}

/** Pack into STYLE_TEXELS RGBA float texels at `out[offset..]`. Layout mirrored in glsl/common.ts. */
export function packStyle(p: StyleParams, out: Float32Array, offset: number): void {
  const o = offset;
  out.set([p.style, p.material, p.floorH, p.groundH], o);
  out.set([p.module, p.winW, p.winH, p.sill], o + 4);
  out.set([p.base.r, p.base.g, p.base.b, p.recess], o + 8);
  out.set([p.trim.r, p.trim.g, p.trim.b, p.seed], o + 12);
  out.set([p.glass.r, p.glass.g, p.glass.b, p.flags], o + 16);
  out.set([p.accent.r, p.accent.g, p.accent.b, p.dirt], o + 20);
  out.set([p.topBand, p.occupancy, p.litProb, p.parapetH], o + 24);
  out.set([p.roof.r, p.roof.g, p.roof.b, p.roofKind], o + 28);
}
