/** Canvas-drawn art: clock dials, building lettering, the Dragon Gate plaque. */
import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const ROMAN = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];

/** Opal-glass clock dial with Roman numerals and a minute track (no hands — they are geometry). */
export function clockDial(size = 512): THREE.CanvasTexture {
  const [c, g] = canvas(size, size);
  const R = size / 2;
  g.fillStyle = '#2b2a27';
  g.fillRect(0, 0, size, size);
  // Dial: warm opal glass.
  const grad = g.createRadialGradient(R, R, R * 0.1, R, R, R * 0.95);
  grad.addColorStop(0, '#f6f1e2');
  grad.addColorStop(1, '#e6dcc4');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(R, R, R * 0.96, 0, Math.PI * 2);
  g.fill();
  // Outer bronze bezel rings.
  g.strokeStyle = '#3a3226';
  g.lineWidth = size * 0.03;
  g.beginPath();
  g.arc(R, R, R * 0.95, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = size * 0.008;
  g.beginPath();
  g.arc(R, R, R * 0.74, 0, Math.PI * 2);
  g.stroke();
  // Minute track.
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const r0 = R * (i % 5 === 0 ? 0.8 : 0.84);
    g.lineWidth = i % 5 === 0 ? size * 0.012 : size * 0.005;
    g.beginPath();
    g.moveTo(R + Math.sin(a) * r0, R - Math.cos(a) * r0);
    g.lineTo(R + Math.sin(a) * R * 0.89, R - Math.cos(a) * R * 0.89);
    g.stroke();
  }
  // Roman numerals, radially oriented like a tower clock.
  g.fillStyle = '#1d1a15';
  g.font = `bold ${Math.round(size * 0.085)}px "Times New Roman", Georgia, serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.save();
    g.translate(R + Math.sin(a) * R * 0.62, R - Math.cos(a) * R * 0.62);
    g.rotate(a);
    g.fillText(ROMAN[i], 0, 0);
    g.restore();
  }
  // Centre boss.
  g.fillStyle = '#2a241b';
  g.beginPath();
  g.arc(R, R, size * 0.025, 0, Math.PI * 2);
  g.fill();
  return tex(c);
}

/**
 * Opaque inscription panel (e.g. "PORT OF SAN FRANCISCO"): letters baked into an albedo texture on a
 * stone-coloured ground (mip-maps keep them legible at any distance, unlike alpha-tested text) plus a
 * matching glow mask (white letters on black) used for night illumination.
 */
export function signPanel(
  text: string,
  opts: { bg?: string; fg?: string; shadow?: string; font?: string; height?: number; spacing?: number; pad?: number } = {},
): { map: THREE.CanvasTexture; mask: THREE.CanvasTexture; aspect: number } {
  const h = opts.height ?? 128;
  const font = opts.font ?? `bold ${Math.round(h * 0.66)}px "Times New Roman", Georgia, serif`;
  const [, mg] = canvas(8, 8);
  mg.font = font;
  const spacing = (opts.spacing ?? 0.12) * h;
  let wText = -spacing;
  for (const ch of text) wText += mg.measureText(ch).width + spacing;
  const pad = (opts.pad ?? 0.5) * h;
  const w = Math.ceil(wText + 2 * pad);
  const draw = (g: CanvasRenderingContext2D, bg: string, layers: [number, number, string][]) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.font = font;
    g.textBaseline = 'middle';
    for (const [dx, dy, col] of layers) {
      g.fillStyle = col;
      let x = pad;
      for (const ch of text) {
        g.fillText(ch, x + dx, h / 2 + dy + h * 0.03);
        x += g.measureText(ch).width + spacing;
      }
    }
  };
  const [c, g] = canvas(w, h);
  const layers: [number, number, string][] = [];
  if (opts.shadow) layers.push([h * 0.025, h * 0.035, opts.shadow]);
  layers.push([0, 0, opts.fg ?? '#2e2a24']);
  draw(g, opts.bg ?? '#d9cfba', layers);
  // Subtle stone mottling on the ground.
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const d = (n - 0.5) * 10;
    img.data[i] += d;
    img.data[i + 1] += d;
    img.data[i + 2] += d;
  }
  g.putImageData(img, 0, 0);
  const [mc, mgx] = canvas(w, h);
  draw(mgx, '#000000', [[0, 0, '#ffffff']]);
  return { map: tex(c), mask: tex(mc, false), aspect: w / h };
}

/** The Dragon Gate plaque: gold characters 天下為公 on a deep blue field with a carved gold frame. */
export function gatePlaque(): THREE.CanvasTexture {
  const W = 512;
  const H = 256;
  const [c, g] = canvas(W, H);
  // Frame: red lacquer border with a gold bead.
  g.fillStyle = '#7a1410';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#c99a2e';
  g.fillRect(10, 10, W - 20, H - 20);
  g.fillStyle = '#1b2f5e';
  g.fillRect(22, 22, W - 44, H - 44);
  // Fine inner gold line.
  g.strokeStyle = '#d8b24a';
  g.lineWidth = 3;
  g.strokeRect(32, 32, W - 64, H - 64);
  g.fillStyle = '#f2cf62';
  g.font = `bold 150px "Kaiti SC", "STKaiti", "Songti SC", "STSong", "PingFang SC", "Hiragino Sans GB", serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const chars = ['天', '下', '為', '公'];
  chars.forEach((ch, i) => {
    const x = 70 + i * ((W - 140) / 3);
    g.fillStyle = '#6b4a10';
    g.fillText(ch, x + 3, H / 2 + 6);
    g.fillStyle = '#f2cf62';
    g.fillText(ch, x, H / 2 + 3);
  });
  return tex(c);
}

/**
 * Painted beam decoration (Chinese "caihua"): repeating bands of green/blue with gold-outlined
 * cartouches on a red ground. Tiles horizontally.
 */
export function beamPaint(): THREE.CanvasTexture {
  const W = 512;
  const H = 128;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#1f5e4a';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#244f86';
  g.fillRect(0, H * 0.18, W, H * 0.64);
  // Central cartouche on red.
  g.fillStyle = '#9b1d16';
  g.beginPath();
  g.ellipse(W / 2, H / 2, W * 0.26, H * 0.32, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#e1b84a';
  g.lineWidth = 5;
  g.stroke();
  // Gold swirls (simple whorls) at both ends.
  g.lineWidth = 4;
  for (const cx of [W * 0.1, W * 0.9]) {
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.arc(cx, H / 2, 10 + k * 12, 0, Math.PI * 2);
      g.stroke();
    }
  }
  // Gold borders.
  g.fillStyle = '#e1b84a';
  g.fillRect(0, 0, W, 6);
  g.fillRect(0, H - 6, W, 6);
  g.fillRect(0, H * 0.18 - 3, W, 3);
  g.fillRect(0, H * 0.82, W, 3);
  const t = tex(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
