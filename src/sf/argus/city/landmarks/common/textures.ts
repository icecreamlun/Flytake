/**
 * Procedural, tileable PBR texture sets (albedo + normal + roughness) generated on the CPU at startup.
 * UVs on landmark geometry are in metres, so every set declares its physical tile size and the
 * returned textures already carry repeat = 1 / tile.
 */
import * as THREE from 'three';

export type TexKind =
  | 'ashlar'
  | 'rustic'
  | 'brick'
  | 'concrete'
  | 'copper'
  | 'tile'
  | 'slate'
  | 'paint'
  | 'precastGrid'
  | 'panes'
  | 'frosted'
  | 'curtain'
  | 'aluminum'
  | 'lacquer';

export interface TexSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  /** Physical size (m) of one texture tile. */
  tile: [number, number];
}

// ─── noise primitives ────────────────────────────────────────────────────────────────────────

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of integers → [0,1). */
export function hash2(x: number, y: number, s = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Periodic value noise on an N×W grid with `cx`×`cy` lattice cells per period. */
function valueNoise(W: number, H: number, cx: number, cy: number, seed: number): Float32Array {
  const lat = new Float32Array(cx * cy);
  const r = rng(seed);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = (y / H) * cy;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % cy) * cx;
    const r1 = ((y0 + 1) % cy) * cx;
    for (let x = 0; x < W; x++) {
      const fx = (x / W) * cx;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % cx;
      const c1 = (x0 + 1) % cx;
      const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
      const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
      out[y * W + x] = a + (b - a) * sy;
    }
  }
  return out;
}

/** Tileable fBm in [0,1]. */
export function fbm(W: number, H: number, base: number, octaves: number, seed: number, aspect = 1): Float32Array {
  const out = new Float32Array(W * H);
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const c = base << o;
    const n = valueNoise(W, H, c, Math.max(1, Math.round(c * aspect)), seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// ─── texture assembly ────────────────────────────────────────────────────────────────────────

function dataTex(data: Uint8Array, W: number, H: number, srgb: boolean, tile: [number, number]): THREE.DataTexture {
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.repeat.set(1 / tile[0], 1 / tile[1]);
  t.needsUpdate = true;
  return t;
}

interface Layers {
  W: number;
  H: number;
  /** sRGB albedo 0..1 */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  height: Float32Array;
  rough: Float32Array;
}

function layers(W: number, H: number): Layers {
  const n = W * H;
  return { W, H, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), height: new Float32Array(n), rough: new Float32Array(n) };
}

function finish(L: Layers, tile: [number, number], normalStrength: number): TexSet {
  const { W, H } = L;
  const alb = new Uint8Array(W * H * 4);
  const nrm = new Uint8Array(W * H * 4);
  const rgh = new Uint8Array(W * H * 4);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      alb[i * 4] = c(L.r[i]);
      alb[i * 4 + 1] = c(L.g[i]);
      alb[i * 4 + 2] = c(L.b[i]);
      alb[i * 4 + 3] = 255;
      const hl = L.height[y * W + ((x - 1 + W) % W)];
      const hr = L.height[y * W + ((x + 1) % W)];
      const hd = L.height[((y - 1 + H) % H) * W + x];
      const hu = L.height[((y + 1) % H) * W + x];
      let nx = -(hr - hl) * normalStrength;
      let ny = -(hu - hd) * normalStrength;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      nrm[i * 4] = c(nx * 0.5 + 0.5);
      nrm[i * 4 + 1] = c(ny * 0.5 + 0.5);
      nrm[i * 4 + 2] = c(nz * 0.5 + 0.5);
      nrm[i * 4 + 3] = 255;
      // roughnessMap reads G (and metalnessMap B): put roughness in G.
      rgh[i * 4] = 255;
      rgh[i * 4 + 1] = c(L.rough[i]);
      rgh[i * 4 + 2] = 0;
      rgh[i * 4 + 3] = 255;
    }
  }
  return {
    map: dataTex(alb, W, H, true, tile),
    normalMap: dataTex(nrm, W, H, false, tile),
    roughnessMap: dataTex(rgh, W, H, false, tile),
    tile,
  };
}

/** Rounded-edge profile: 0 in a joint, rising to 1 over `bevel` px from the joint edge. */
function bevel(d: number, joint: number, bev: number): number {
  if (d < joint) return 0;
  const t = Math.min(1, (d - joint) / bev);
  return Math.sin((t * Math.PI) / 2);
}

// ─── individual sets ─────────────────────────────────────────────────────────────────────────

/** Coursed ashlar: rectangular stone blocks in running courses, soft arrises, mineral mottling. */
function ashlar(rusticated: boolean): TexSet {
  const W = 512;
  const H = 512;
  const tile: [number, number] = [4.8, 4.8];
  const L = layers(W, H);
  const courses = 8;
  const ch = H / courses;
  const ppm = W / tile[0];
  const n1 = fbm(W, H, 4, 5, rusticated ? 11 : 7);
  const n2 = fbm(W, H, 32, 3, 13);
  const r = rng(rusticated ? 99 : 42);
  const joint = rusticated ? 5 : 1.4;
  const bev = rusticated ? 7 : 3;
  for (let k = 0; k < courses; k++) {
    // Random block lengths along this course (wrap so the tile seams vanish).
    const cuts: number[] = [0];
    let x = r() * 0.6 * ppm;
    cuts[0] = x;
    while (x < W + cuts[0] - 0.8 * ppm) {
      x += (rusticated ? 1.4 + r() * 0.5 : 0.9 + r() * 0.8) * ppm;
      if (x < W + cuts[0] - 0.6 * ppm) cuts.push(x);
    }
    const tints = cuts.map(() => 0.93 + r() * 0.09);
    for (let y = Math.floor(k * ch); y < Math.floor((k + 1) * ch); y++) {
      const dy = Math.min(y - k * ch, (k + 1) * ch - 1 - y);
      for (let px = 0; px < W; px++) {
        // Which block: find last cut <= px (with wrap).
        const xx = px < cuts[0] ? px + W : px;
        let bi = 0;
        for (let i = 0; i < cuts.length; i++) if (cuts[i] <= xx) bi = i;
        const left = xx - cuts[bi];
        const right = (bi + 1 < cuts.length ? cuts[bi + 1] : cuts[0] + W) - xx;
        const dx = Math.min(left, right);
        const e = bevel(Math.min(dx, dy), joint, bev);
        const i = y * W + px;
        const tint = tints[bi] * (0.94 + 0.08 * n1[i]) * (0.97 + 0.05 * n2[i]);
        const j = e < 0.05 ? 0.78 : 1;
        L.r[i] = tint * j;
        L.g[i] = tint * j * 0.985;
        L.b[i] = tint * j * 0.96;
        L.height[i] = e * (rusticated ? 1.0 : 0.6) + n2[i] * 0.12 + (rusticated ? n1[i] * 0.25 : 0);
        L.rough[i] = 0.78 + 0.15 * n2[i];
      }
    }
  }
  return finish(L, tile, rusticated ? 3.5 : 2.2);
}

function brick(): TexSet {
  const W = 512;
  const H = 512;
  const courses = 26;
  const per = 10; // bricks per course across the tile
  const tile: [number, number] = [2.0, 2.0];
  const L = layers(W, H);
  const ch = H / courses;
  const bw = W / per;
  const n = fbm(W, H, 8, 4, 5);
  const fine = fbm(W, H, 64, 2, 6);
  for (let y = 0; y < H; y++) {
    const k = Math.floor(y / ch);
    const dy = Math.min(y - k * ch, (k + 1) * ch - 1 - y);
    const off = (k % 2) * bw * 0.5;
    for (let x = 0; x < W; x++) {
      const xx = (x + off) % W;
      const bi = Math.floor(xx / bw);
      const dx = Math.min(xx - bi * bw, (bi + 1) * bw - 1 - xx);
      const e = bevel(Math.min(dx, dy), 2.2, 2);
      const i = y * W + x;
      const h = hash2(bi, k, 3);
      const h2 = hash2(bi, k, 9);
      // Red-brown bricks with occasional dark clinkers and paler salmon bricks.
      let br = 0.5 + h * 0.12;
      let bg = 0.2 + h * 0.06;
      let bb = 0.15 + h * 0.04;
      if (h2 > 0.88) {
        br *= 0.62;
        bg *= 0.66;
        bb *= 0.75;
      } else if (h2 < 0.1) {
        br *= 1.15;
        bg *= 1.25;
        bb *= 1.25;
      }
      const v = 0.9 + 0.14 * n[i] + 0.06 * (fine[i] - 0.5);
      if (e < 0.05) {
        const m = 0.6 + 0.08 * fine[i];
        L.r[i] = m;
        L.g[i] = m * 0.97;
        L.b[i] = m * 0.92;
      } else {
        L.r[i] = br * v;
        L.g[i] = bg * v;
        L.b[i] = bb * v;
      }
      L.height[i] = e * 0.8 + fine[i] * 0.15;
      L.rough[i] = e < 0.05 ? 0.95 : 0.82 + 0.1 * fine[i];
    }
  }
  return finish(L, tile, 2.6);
}

function concrete(): TexSet {
  const W = 512;
  const H = 512;
  const tile: [number, number] = [6, 6];
  const L = layers(W, H);
  const stains = fbm(W, H, 3, 5, 21);
  const pores = fbm(W, H, 96, 2, 22);
  const lift = H / 5; // formwork lifts every 1.2 m
  for (let y = 0; y < H; y++) {
    const ly = y % lift;
    const seam = ly < 1.5 ? 0.5 : 1;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // Vertical weathering streaks.
      const streak = 0.5 + 0.5 * Math.sin(x * 0.11 + stains[(y >> 3) * W + x] * 6);
      const v = 0.86 + 0.1 * stains[i] - 0.04 * streak * stains[i] + 0.04 * (pores[i] - 0.5);
      L.r[i] = v * (seam < 1 ? 0.92 : 1);
      L.g[i] = v * 0.985 * (seam < 1 ? 0.92 : 1);
      L.b[i] = v * 0.95 * (seam < 1 ? 0.92 : 1);
      L.height[i] = pores[i] * 0.3 + (seam < 1 ? -0.4 : 0);
      L.rough[i] = 0.86 + 0.1 * pores[i];
    }
  }
  return finish(L, tile, 1.4);
}

/** Verdigris copper: blue-green patina, darker drip streaks, bronze showing through, standing seams. */
function copper(): TexSet {
  const W = 512;
  const H = 512;
  const tile: [number, number] = [3, 3];
  const L = layers(W, H);
  const n = fbm(W, H, 6, 5, 31);
  const streakN = fbm(W, H, 24, 3, 32, 0.12); // stretched vertically
  const seamEvery = W / 6; // 0.5 m panels
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const s = streakN[i];
      const bronze = Math.max(0, (n[i] - 0.68) * 4);
      let r = 0.4 + 0.1 * n[i];
      let g = 0.57 + 0.08 * n[i];
      let b = 0.5 + 0.06 * n[i];
      const dark = Math.max(0, s - 0.55) * 1.6;
      r *= 1 - dark * 0.5;
      g *= 1 - dark * 0.45;
      b *= 1 - dark * 0.35;
      r = r * (1 - bronze) + 0.42 * bronze;
      g = g * (1 - bronze) + 0.31 * bronze;
      b = b * (1 - bronze) + 0.2 * bronze;
      const sx = x % seamEvery;
      const seam = sx < 2 ? 1 : 0;
      L.r[i] = r * (seam ? 0.85 : 1);
      L.g[i] = g * (seam ? 0.85 : 1);
      L.b[i] = b * (seam ? 0.85 : 1);
      L.height[i] = seam * 0.9 + n[i] * 0.1;
      L.rough[i] = 0.65 + 0.25 * n[i] - 0.15 * bronze;
    }
  }
  return finish(L, tile, 3);
}

/** Chinese barrel-tile roof: rows of convex cover tiles and concave pan channels running down slope (v). */
function tile(): TexSet {
  const W = 256;
  const H = 256;
  const tile: [number, number] = [1.0, 1.2];
  const L = layers(W, H);
  const n = fbm(W, H, 8, 3, 41);
  const cols = 4; // 0.25 m pitch
  const rows = 4; // 0.3 m courses
  const cw = W / cols;
  const rh = H / rows;
  for (let y = 0; y < H; y++) {
    const k = Math.floor(y / rh);
    const fy = (y - k * rh) / rh; // 0 at the lower lip of a course
    for (let x = 0; x < W; x++) {
      const c = Math.floor(x / cw);
      const fx = (x - c * cw) / cw;
      const i = y * W + x;
      // Cover tile occupies the middle 55%, rounded; the pan between is a shallow trough.
      const d = Math.abs(fx - 0.5) / 0.28;
      const cover = d < 1 ? Math.sqrt(1 - d * d) : 0;
      const pan = d >= 1 ? 0.25 * (1 - Math.cos(((fx < 0.5 ? fx : 1 - fx) / 0.22) * Math.PI)) * 0.5 : 0;
      const lip = fy < 0.08 ? 1 - fy / 0.08 : 0; // overlapping step at each course
      const h = cover * 0.9 + pan * 0.3 + lip * 0.25 * (cover > 0 ? 1 : 0.5);
      const t = 0.9 + 0.1 * hash2(c, k, 7);
      const shade = 0.82 + 0.18 * cover + 0.08 * (n[i] - 0.5);
      L.r[i] = t * shade;
      L.g[i] = t * shade;
      L.b[i] = t * shade;
      L.height[i] = h;
      L.rough[i] = cover > 0 ? 0.18 + 0.1 * n[i] : 0.35;
    }
  }
  return finish(L, tile, 6);
}

function slate(): TexSet {
  const W = 512;
  const H = 512;
  const tile: [number, number] = [3, 3];
  const L = layers(W, H);
  const rows = 12; // 0.25 m exposure
  const rh = H / rows;
  const sw = W / 10;
  const n = fbm(W, H, 16, 3, 51);
  for (let y = 0; y < H; y++) {
    const k = Math.floor(y / rh);
    const fy = (y - k * rh) / rh;
    const off = (k % 2) * sw * 0.5;
    for (let x = 0; x < W; x++) {
      const xx = (x + off) % W;
      const c = Math.floor(xx / sw);
      const dx = Math.min(xx - c * sw, (c + 1) * sw - 1 - xx);
      const i = y * W + x;
      const tnt = 0.85 + 0.2 * hash2(c, k, 5) + 0.06 * (n[i] - 0.5);
      const gap = dx < 1.2 ? 0.6 : 1;
      L.r[i] = tnt * gap;
      L.g[i] = tnt * gap * 1.0;
      L.b[i] = tnt * gap * 1.04;
      L.height[i] = (1 - fy) * 0.5 + (gap < 1 ? -0.3 : 0) + n[i] * 0.1;
      L.rough[i] = 0.7 + 0.15 * n[i];
    }
  }
  return finish(L, tile, 2.2);
}

function paint(): TexSet {
  const W = 256;
  const H = 256;
  const tile: [number, number] = [5, 5];
  const L = layers(W, H);
  const n = fbm(W, H, 4, 5, 61);
  const fine = fbm(W, H, 64, 2, 62);
  for (let i = 0; i < W * H; i++) {
    const v = 0.92 + 0.1 * n[i] + 0.03 * (fine[i] - 0.5);
    L.r[i] = v;
    L.g[i] = v;
    L.b[i] = v;
    L.height[i] = fine[i] * 0.15;
    L.rough[i] = 0.45 + 0.2 * n[i];
  }
  return finish(L, tile, 0.8);
}

/** Brushed aluminium panels (Transamerica spire): fine horizontal grain + panel joints. */
function aluminum(): TexSet {
  const W = 256;
  const H = 256;
  const tile: [number, number] = [2, 2];
  const L = layers(W, H);
  const grain = fbm(W, H, 128, 2, 71, 0.05);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const joint = x % 128 < 2 || y % 64 < 2 ? 1 : 0;
      const v = 0.92 + 0.08 * grain[i] - joint * 0.25;
      L.r[i] = v;
      L.g[i] = v;
      L.b[i] = v * 1.01;
      L.height[i] = -joint * 0.6 + grain[i] * 0.05;
      L.rough[i] = 0.3 + 0.12 * grain[i] + joint * 0.3;
    }
  }
  return finish(L, tile, 2);
}

/** Lacquered/painted wood or plaster with very subtle variation (Chinese gate beams). */
function lacquer(): TexSet {
  const W = 256;
  const H = 256;
  const tile: [number, number] = [2, 2];
  const L = layers(W, H);
  const n = fbm(W, H, 8, 4, 81);
  for (let i = 0; i < W * H; i++) {
    const v = 0.94 + 0.08 * n[i];
    L.r[i] = v;
    L.g[i] = v;
    L.b[i] = v;
    L.height[i] = n[i] * 0.1;
    L.rough[i] = 0.4 + 0.15 * n[i];
  }
  return finish(L, tile, 0.6);
}

/**
 * One Transamerica window bay (repeats): white quartz precast panel with a deep-set vertical window.
 * Glass is marked by low roughness (materials.ts derives the night window mask from roughness).
 */
function precastGrid(): TexSet {
  const W = 128;
  const H = 256;
  const tile: [number, number] = [2.05, 4.05]; // window pitch × floor height (overridden by geometry UVs)
  const L = layers(W, H);
  const n = fbm(W, H, 4, 3, 91);
  // Window: 46% of the bay width, 48% of the floor height (deep-set, white panels dominate).
  const x0 = W * 0.27;
  const x1 = W * 0.73;
  const y0 = H * 0.3;
  const y1 = H * 0.78;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const inX = x >= x0 && x < x1;
      const inY = y >= y0 && y < y1;
      const win = inX && inY;
      const dEdge = Math.min(x - x0, x1 - 1 - x, y - y0, y1 - 1 - y);
      const panel = 0.9 + 0.06 * n[i];
      if (win) {
        // Dark glass; the top band is in the shadow of the deep reveal.
        // Top of the opening sits in the reveal's shadow.
        const sh = (dEdge < 3 ? 0.6 : 1) * (y > y1 - (y1 - y0) * 0.25 ? 0.75 : 1);
        L.r[i] = 0.15 * sh;
        L.g[i] = 0.18 * sh;
        L.b[i] = 0.22 * sh;
        L.rough[i] = 0.06;
        L.height[i] = 0;
      } else {
        // Recess shading just outside the window opening (reveals) on the panel.
        const near = !win && x >= x0 - 3 && x < x1 + 3 && y >= y0 - 3 && y < y1 + 3;
        L.r[i] = panel * (near ? 0.82 : 1);
        L.g[i] = panel * 0.99 * (near ? 0.82 : 1);
        L.b[i] = panel * 0.965 * (near ? 0.82 : 1);
        L.rough[i] = 0.62 + 0.1 * n[i];
        L.height[i] = 1;
      }
    }
  }
  return finish(L, tile, 5);
}

/** Glazing in dark bronze sashes (Ferry Building arched windows, bulkheads). */
function panes(): TexSet {
  const W = 256;
  const H = 256;
  const tile: [number, number] = [2.4, 2.4];
  const L = layers(W, H);
  const n = fbm(W, H, 6, 3, 101);
  const cell = W / 3; // 0.8 m panes
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const bar = x % cell < 3 || y % cell < 3;
      if (bar) {
        L.r[i] = 0.2;
        L.g[i] = 0.18;
        L.b[i] = 0.15;
        L.rough[i] = 0.5;
        L.height[i] = 1;
      } else {
        // Slightly uneven old glass: faint variation, very smooth (reflects the sky).
        const v = 0.09 + 0.05 * n[i];
        L.r[i] = v;
        L.g[i] = v * 1.08;
        L.b[i] = v * 1.18;
        L.rough[i] = 0.04;
        L.height[i] = 0;
      }
    }
  }
  return finish(L, tile, 3);
}

/** Wired/frosted skylight glazing in a light steel frame. */
function frosted(): TexSet {
  const W = 256;
  const H = 256;
  const tile: [number, number] = [3.0, 1.5];
  const L = layers(W, H);
  const n = fbm(W, H, 8, 3, 111);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const bar = x % (W / 4) < 3 || y % (H / 2) < 3;
      const v = bar ? 0.28 : 0.5 + 0.08 * n[i];
      L.r[i] = v;
      L.g[i] = v * 1.03;
      L.b[i] = v * 1.08;
      L.rough[i] = bar ? 0.5 : 0.22;
      L.height[i] = bar ? 1 : 0;
    }
  }
  return finish(L, tile, 2);
}

/** Modern curtain wall: tall reflective panes in dark anodised mullions. */
function curtain(): TexSet {
  const W = 128;
  const H = 256;
  const tile: [number, number] = [1.6, 3.6];
  const L = layers(W, H);
  const n = fbm(W, H, 4, 3, 121);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const bar = x < 4 || y < 5 || Math.abs(y - H * 0.78) < 2;
      if (bar) {
        L.r[i] = L.g[i] = L.b[i] = 0.12;
        L.rough[i] = 0.45;
        L.height[i] = 1;
      } else {
        const v = 0.1 + 0.04 * n[i];
        L.r[i] = v;
        L.g[i] = v * 1.12;
        L.b[i] = v * 1.25;
        L.rough[i] = 0.04;
        L.height[i] = 0;
      }
    }
  }
  return finish(L, tile, 2.5);
}

const cache = new Map<TexKind, TexSet>();

export function getTextures(kind: TexKind): TexSet {
  let s = cache.get(kind);
  if (s) return s;
  switch (kind) {
    case 'ashlar':
      s = ashlar(false);
      break;
    case 'rustic':
      s = ashlar(true);
      break;
    case 'brick':
      s = brick();
      break;
    case 'concrete':
      s = concrete();
      break;
    case 'copper':
      s = copper();
      break;
    case 'tile':
      s = tile();
      break;
    case 'slate':
      s = slate();
      break;
    case 'paint':
      s = paint();
      break;
    case 'aluminum':
      s = aluminum();
      break;
    case 'lacquer':
      s = lacquer();
      break;
    case 'precastGrid':
      s = precastGrid();
      break;
    case 'panes':
      s = panes();
      break;
    case 'frosted':
      s = frosted();
      break;
    case 'curtain':
      s = curtain();
      break;
  }
  cache.set(kind, s);
  return s;
}
