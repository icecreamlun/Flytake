import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
  type Texture,
} from 'three';

/** Atlas regions (u0, u1, v0, v1) whose alpha coverage is preserved independently across mips. */
const REGIONS: [number, number, number, number][] = [
  [0, 0.5, 0, 1],
  [0.5, 0.75, 0.5, 1],
  [0.5, 0.75, 0, 0.5],
  [0.75, 1, 0.5, 1],
  [0.75, 1, 0, 0.5],
];
const THRESHOLD = 128;

export interface ForestTextures {
  foliage: Texture;
  bark: Texture;
  barkNormal: Texture;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/** 2x2 box downsample of straight-alpha RGBA (colour weighted by alpha so edges keep their hue). */
function downsample(src: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const w2 = Math.max(1, w >> 1);
  const h2 = Math.max(1, h >> 1);
  const out = new Uint8Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(w - 1, x * 2 + dx);
          const sy = Math.min(h - 1, y * 2 + dy);
          const i = (sy * w + sx) * 4;
          const al = src[i + 3]!;
          const wt = al + 1;
          r += src[i]! * wt;
          g += src[i + 1]! * wt;
          b += src[i + 2]! * wt;
          wsum += wt;
          a += al;
        }
      }
      const o = (y * w2 + x) * 4;
      out[o] = r / wsum;
      out[o + 1] = g / wsum;
      out[o + 2] = b / wsum;
      out[o + 3] = a / 4;
    }
  }
  return out;
}

function coverage(data: Uint8Array, w: number, x0: number, x1: number, y0: number, y1: number, scale: number): number {
  let n = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++;
      if (data[(y * w + x) * 4 + 3]! * scale >= THRESHOLD) n++;
    }
  }
  return total > 0 ? n / total : 0;
}

/**
 * Alpha-tested needles thin out and vanish at distance because box-filtered mip alpha drops
 * below the test threshold. Scale each mip's alpha (per atlas region) so its coverage matches
 * level 0 (Castaño, "Computing alpha mipmaps").
 */
function coveragePreservingMips(level0: Uint8Array, w: number, h: number): { data: Uint8Array; width: number; height: number }[] {
  const mips = [{ data: level0, width: w, height: h }];
  const target = REGIONS.map(([u0, u1, v0, v1]) => coverage(level0, w, Math.round(u0 * w), Math.round(u1 * w), Math.round(v0 * h), Math.round(v1 * h), 1));
  let cur = level0;
  let cw = w;
  let ch = h;
  // keep the unscaled chain for downsampling, scale a copy per level
  while (cw > 1 || ch > 1) {
    const next = downsample(cur, cw, ch);
    cw = Math.max(1, cw >> 1);
    ch = Math.max(1, ch >> 1);
    cur = next;
    const scaled = new Uint8Array(next);
    REGIONS.forEach(([u0, u1, v0, v1], r) => {
      const x0 = Math.round(u0 * cw);
      const x1 = Math.max(x0 + 1, Math.round(u1 * cw));
      const y0 = Math.round(v0 * ch);
      const y1 = Math.max(y0 + 1, Math.round(v1 * ch));
      if (x1 > cw || y1 > ch) return;
      let lo = 0.5;
      let hi = 8;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        if (coverage(next, cw, x0, x1, y0, y1, mid) < target[r]!) lo = mid;
        else hi = mid;
      }
      const s = (lo + hi) / 2;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * cw + x) * 4 + 3;
          scaled[i] = Math.min(255, next[i]! * s);
        }
      }
    });
    mips.push({ data: scaled, width: cw, height: ch });
  }
  return mips;
}

let pending: Promise<ForestTextures> | null = null;

export function loadForestTextures(base = '/textures/forest', anisotropy = 8): Promise<ForestTextures> {
  if (pending) return pending;
  pending = (async () => {
    const img = await loadImage(`${base}/foliage.png`);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const raw = ctx.getImageData(0, 0, w, h).data;
    // flip rows: v = 0 at the twig base (image bottom)
    const level0 = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) level0.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    const mips = coveragePreservingMips(level0, w, h);
    const foliage = new DataTexture(level0, w, h, RGBAFormat, UnsignedByteType);
    foliage.mipmaps = mips as unknown as typeof foliage.mipmaps;
    foliage.generateMipmaps = false;
    foliage.minFilter = LinearMipmapLinearFilter;
    foliage.magFilter = LinearFilter;
    foliage.colorSpace = SRGBColorSpace;
    foliage.anisotropy = anisotropy;
    foliage.needsUpdate = true;

    const loader = new TextureLoader();
    const [bark, barkNormal] = await Promise.all([
      loader.loadAsync(`${base}/bark_color.jpg`),
      loader.loadAsync(`${base}/bark_normal.jpg`),
    ]);
    for (const t of [bark, barkNormal]) {
      t.wrapS = t.wrapT = RepeatWrapping;
      t.anisotropy = anisotropy;
      t.minFilter = LinearMipmapLinearFilter;
    }
    bark.colorSpace = SRGBColorSpace;
    return { foliage, bark, barkNormal };
  })();
  return pending;
}
