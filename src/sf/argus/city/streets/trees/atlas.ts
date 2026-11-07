/**
 * Procedural foliage / bark atlas (1024², painted with Canvas2D):
 *   BROAD  (0,0)-(512,512)      broad palmate leaf cluster (plane trees)
 *   SMALL  (512,0)-(1024,512)   dense small-leaf cluster (ficus, box, ginkgo…)
 *   NEEDLE (0,512)-(512,1024)   conifer sprays
 *   FROND  (512,512)-(768,1024) Canary palm frond (rachis vertical, leaflets both sides)
 *   BARK   (768,512)-(1024,768) bark (opaque)
 *   SWATCH (768,768)-(1024,1024) opaque average foliage (far LOD blobs)
 * Transparent texels get the region's average colour so mipmaps don't bleed black fringes.
 */
import * as THREE from 'three';
import { rng } from '../core/zone';

export const ATLAS = 1024;
export type Region = [number, number, number, number]; // x0, y0, x1, y1 in px
export const R_BROAD: Region = [0, 0, 512, 512];
export const R_SMALL: Region = [512, 0, 1024, 512];
export const R_NEEDLE: Region = [0, 512, 512, 1024];
export const R_FROND: Region = [512, 512, 768, 1024];
export const R_BARK: Region = [768, 512, 1024, 768];
export const R_SWATCH: Region = [768, 768, 1024, 1024];
export const R_PALMBARK: Region = [768, 512, 896, 768];

function leafColor(r: () => number, base: [number, number, number], vary: number): string {
  const k = 1 - vary / 2 + r() * vary;
  const hue = (r() - 0.5) * 0.12;
  const c = [base[0] * k * (1 + hue), base[1] * k, base[2] * k * (1 - hue)].map((v) => Math.round(Math.min(255, v)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function buildAtlas(): THREE.DataTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = ATLAS;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.clearRect(0, 0, ATLAS, ATLAS);
  const r = rng(1234);

  // ── Broad leaves: a loose clump of palmate leaves around a few twigs.
  {
    const [x0, y0] = R_BROAD;
    const cx = x0 + 256;
    const cy = y0 + 256;
    g.strokeStyle = 'rgb(70,58,44)';
    g.lineWidth = 3;
    for (let k = 0; k < 6; k++) {
      const a = r() * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * 190, cy + Math.sin(a) * 190);
      g.stroke();
    }
    for (let k = 0; k < 120; k++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 205;
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      const s = 20 + r() * 18;
      const inner = 1 - d / 230;
      g.save();
      g.translate(x, y);
      g.rotate(r() * Math.PI * 2);
      g.fillStyle = leafColor(r, [84 - inner * 30, 102 - inner * 34, 54 - inner * 14], 0.35);
      // Palmate leaf: 5 lobes.
      g.beginPath();
      for (let j = 0; j <= 10; j++) {
        const t = (j / 10) * Math.PI * 2;
        const lobe = 0.62 + 0.38 * Math.abs(Math.cos(t * 2.5));
        g.lineTo(Math.cos(t) * s * lobe, Math.sin(t) * s * lobe * 0.9);
      }
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(40,52,22,0.5)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(s * 0.8, 0);
      g.stroke();
      g.restore();
    }
  }

  // ── Small leaves: dense ovals.
  {
    const [x0, y0] = R_SMALL;
    const cx = x0 + 256;
    const cy = y0 + 256;
    for (let k = 0; k < 700; k++) {
      const a = r() * Math.PI * 2;
      const d = Math.pow(r(), 0.6) * 215;
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      const inner = 1 - d / 230;
      g.save();
      g.translate(x, y);
      g.rotate(r() * Math.PI * 2);
      g.fillStyle = leafColor(r, [70 - inner * 28, 90 - inner * 34, 48 - inner * 16], 0.4);
      g.beginPath();
      g.ellipse(0, 0, 10 + r() * 6, 5 + r() * 2.5, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }

  // ── Needles: branching sprays of short strokes.
  {
    const [x0, y0] = R_NEEDLE;
    const spray = (x: number, y: number, a: number, len: number, depth: number) => {
      const ex = x + Math.cos(a) * len;
      const ey = y + Math.sin(a) * len;
      g.strokeStyle = 'rgb(66,54,40)';
      g.lineWidth = Math.max(1, depth * 1.2);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(ex, ey);
      g.stroke();
      const n = Math.floor(len / 3);
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const px = x + (ex - x) * t;
        const py = y + (ey - y) * t;
        for (const side of [-1, 1]) {
          const na = a + side * (0.7 + r() * 0.5);
          const nl = 9 + r() * 7;
          g.strokeStyle = leafColor(r, [50, 70, 46], 0.4);
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl);
          g.stroke();
        }
      }
      if (depth > 0) {
        for (let k = 0; k < 3; k++) {
          const t = 0.3 + r() * 0.6;
          spray(x + (ex - x) * t, y + (ey - y) * t, a + (r() - 0.5) * 1.6, len * (0.45 + r() * 0.2), depth - 1);
        }
      }
    };
    for (let k = 0; k < 5; k++) spray(x0 + 256 + (r() - 0.5) * 60, y0 + 470, -Math.PI / 2 + (r() - 0.5) * 1.4, 300, 2);
  }

  // ── Palm frond: rachis down the centre, long leaflets angled forward on both sides.
  {
    const [x0, y0, x1, y1] = R_FROND;
    const cx = (x0 + x1) / 2;
    const L = y1 - y0 - 16;
    g.strokeStyle = 'rgb(120,112,70)';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(cx, y1 - 4);
    g.lineTo(cx, y0 + 8);
    g.stroke();
    for (let k = 0; k < 70; k++) {
      const t = k / 70; // 0 at base (bottom) → 1 at tip (top)
      const y = y1 - 8 - t * L;
      const env = Math.sin(Math.min(1, t * 1.25) * Math.PI) * 0.85 + 0.15;
      for (const side of [-1, 1]) {
        const len = (20 + 100 * env) * (0.85 + r() * 0.3);
        const ang = -0.75 - r() * 0.25; // leaflets point toward the tip
        g.strokeStyle = leafColor(r, [88, 104, 58], 0.35);
        g.lineWidth = 3 + env * 2.5;
        g.beginPath();
        g.moveTo(cx, y);
        g.lineTo(cx + side * Math.cos(ang) * len, y + Math.sin(ang) * len * 0.55);
        g.stroke();
      }
    }
  }

  // ── Bark: grey-brown with vertical fissures (plane trees get mottled patches in the shader tint).
  {
    const [x0, y0, x1, y1] = R_BARK;
    g.fillStyle = 'rgb(96,88,78)';
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    for (let k = 0; k < 900; k++) {
      const x = x0 + r() * (x1 - x0);
      const y = y0 + r() * (y1 - y0);
      const v = 60 + r() * 70;
      g.fillStyle = `rgba(${v},${v * 0.92},${v * 0.82},0.5)`;
      g.fillRect(x, y, 1.5 + r() * 2, 6 + r() * 26);
    }
    // Palm trunk half (left 128 px): diamond leaf-base pattern.
    for (let yy = y0; yy < y1; yy += 14) {
      for (let xx = x0 + ((yy / 14) % 2) * 9; xx < x0 + 128; xx += 18) {
        g.fillStyle = `rgb(${110 + r() * 30},${92 + r() * 22},${64 + r() * 16})`;
        g.beginPath();
        g.moveTo(xx, yy);
        g.lineTo(xx + 9, yy + 7);
        g.lineTo(xx, yy + 14);
        g.lineTo(xx - 9, yy + 7);
        g.closePath();
        g.fill();
      }
    }
  }

  // ── Swatch: opaque mottled foliage.
  {
    const [x0, y0, x1, y1] = R_SWATCH;
    g.fillStyle = 'rgb(64,82,46)';
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    for (let k = 0; k < 1500; k++) {
      g.fillStyle = leafColor(r, [68, 86, 48], 0.6);
      g.beginPath();
      g.arc(x0 + r() * (x1 - x0), y0 + r() * (y1 - y0), 2 + r() * 5, 0, Math.PI * 2);
      g.fill();
    }
  }

  const img = g.getImageData(0, 0, ATLAS, ATLAS).data;
  const data = new Uint8Array(img.length);
  data.set(img);
  // Fill transparent texels with the region's average opaque colour (mip-safe edges).
  for (const reg of [R_BROAD, R_SMALL, R_NEEDLE, R_FROND]) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let y = reg[1]; y < reg[3]; y++)
      for (let x = reg[0]; x < reg[2]; x++) {
        const o = (y * ATLAS + x) * 4;
        if (data[o + 3] > 200) {
          sr += data[o];
          sg += data[o + 1];
          sb += data[o + 2];
          n++;
        }
      }
    if (!n) continue;
    for (let y = reg[1]; y < reg[3]; y++)
      for (let x = reg[0]; x < reg[2]; x++) {
        const o = (y * ATLAS + x) * 4;
        if (data[o + 3] < 200) {
          const a = data[o + 3] / 200;
          data[o] = data[o] * a + (sr / n) * (1 - a);
          data[o + 1] = data[o + 1] * a + (sg / n) * (1 - a);
          data[o + 2] = data[o + 2] * a + (sb / n) * (1 - a);
        }
      }
  }
  const tex = new THREE.DataTexture(data, ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** UV (0..1, v down = canvas y) of a point inside a region given local (s,t) ∈ [0,1]². */
export function regionUV(reg: Region, s: number, t: number): [number, number] {
  return [(reg[0] + (reg[2] - reg[0]) * s) / ATLAS, (reg[1] + (reg[3] - reg[1]) * t) / ATLAS];
}
