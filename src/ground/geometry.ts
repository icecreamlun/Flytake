import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';

/** Deterministic PRNG (mulberry32). */
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

export interface PropGeometry {
  geometry: BufferGeometry;
  /** bounding box min / max (canonical: origin at the bottom centre, z up, metres) */
  min: [number, number, number];
  max: [number, number, number];
}

/** Loads a prop LOD written by tools/scene/ground_assets.py. */
export async function loadProp(url: string): Promise<PropGeometry> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`prop ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const n = dv.getUint32(0, true);
  const ni = dv.getUint32(4, true);
  const bbox = new Float32Array(buf.slice(8, 32));
  let o = 32;
  const pos = new Float32Array(buf, o, n * 3);
  o += n * 12;
  const nrm = new Int8Array(buf, o, n * 4);
  o += n * 4;
  const uv = new Uint16Array(buf.slice(o, o + n * 4));
  o += n * 4;
  const index = n < 65536 ? new Uint16Array(buf.slice(o, o + ni * 2)) : new Uint32Array(buf.slice(o, o + ni * 4));
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new InterleavedBufferAttribute(new InterleavedBuffer(nrm, 4), 3, 0, true));
  g.setAttribute('uv', new BufferAttribute(uv, 2, true));
  g.setIndex(new BufferAttribute(index, 1));
  return { geometry: g, min: [bbox[0]!, bbox[1]!, bbox[2]!], max: [bbox[3]!, bbox[4]!, bbox[5]!] };
}

/**
 * A grass / sedge tuft, canonical height ~1 (instances scale it). Blades are tapered, curved
 * strips; attribute aGrass = (t along the blade 0..1, blade random 0..1, bend direction angle).
 */
export function buildGrassTuft(blades: number, segments: number, seed: number): BufferGeometry {
  const r = rng(seed);
  const pos: number[] = [];
  const nrm: number[] = [];
  const attr: number[] = [];
  const idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const ang = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * 0.16;
    const bx = Math.cos(ang) * rad;
    const by = Math.sin(ang) * rad;
    const h = 0.55 + 0.45 * r();
    const width = 0.022 + 0.018 * r();
    // lean outwards (with some randomness) and curve over
    const leanAng = ang + (r() - 0.5) * 1.2;
    const lean = 0.15 + 0.45 * r();
    const lx = Math.cos(leanAng);
    const ly = Math.sin(leanAng);
    // blade facing: perpendicular to the lean, twisted a little
    const face = leanAng + Math.PI / 2 + (r() - 0.5) * 0.8;
    const fx = Math.cos(face);
    const fy = Math.sin(face);
    const rnd = r();
    const base = pos.length / 3;
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const bend = lean * t * t;
      const cx = bx + lx * bend * h;
      const cy = by + ly * bend * h;
      const cz = h * (t - 0.35 * bend * t);
      const w = width * (1 - t) * (s === segments ? 0 : 1) + (s === segments ? 0.0005 : 0);
      // blade normal: towards the lean side, tilted up (soft, grass-like shading)
      const nx = lx * 0.55;
      const ny = ly * 0.55;
      const nz = 0.85;
      pos.push(cx - fx * w, cy - fy * w, cz, cx + fx * w, cy + fy * w, cz);
      nrm.push(nx, ny, nz, nx, ny, nz);
      attr.push(t, rnd, leanAng, t, rnd, leanAng);
      if (s < segments) {
        const a = base + s * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('aGrass', new Float32BufferAttribute(attr, 3));
  g.setIndex(idx);
  return g;
}

/**
 * A manzanita / huckleberry-oak mound: leaf cards scattered through a flattened dome of
 * canonical radius 1 and height 1. Normals point away from the dome centre (soft volume
 * shading); aShrub = (depth-ish occlusion 0..1, card random).
 */
export function buildShrub(cards: number, cardSize: number, seed: number): BufferGeometry {
  const r = rng(seed);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const attr: number[] = [];
  const idx: number[] = [];
  for (let c = 0; c < cards; c++) {
    // point in the dome, biased to the outer shell
    let x = 0;
    let y = 0;
    let z = 0;
    for (;;) {
      x = r() * 2 - 1;
      y = r() * 2 - 1;
      z = r();
      const d = x * x + y * y + z * z;
      if (d <= 1 && d > 0.15) break;
    }
    const shell = Math.sqrt(x * x + y * y + z * z);
    const k = Math.pow(shell, 0.35) / Math.max(shell, 1e-3);
    x *= k;
    y *= k;
    z = z * k * 0.9 + 0.05;
    // outward normal of the dome at this point
    let nx = x;
    let ny = y;
    let nz = z * 1.6 + 0.25;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // card orientation: random, leaning towards the outward normal
    const a1 = r() * Math.PI * 2;
    const a2 = (r() - 0.3) * 1.2;
    let ux = Math.cos(a1) * Math.cos(a2);
    let uy = Math.sin(a1) * Math.cos(a2);
    let uz = Math.sin(a2);
    // v = normal x u, re-orthogonalised
    let vx = ny * uz - nz * uy;
    let vy = nz * ux - nx * uz;
    let vz = nx * uy - ny * ux;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx /= vl;
    vy /= vl;
    vz /= vl;
    ux = vy * nz - vz * ny;
    uy = vz * nx - vx * nz;
    uz = vx * ny - vy * nx;
    const s = cardSize * (0.75 + 0.5 * r());
    const tile = Math.floor(r() * 4);
    const u0 = (tile % 2) * 0.5;
    const v0 = Math.floor(tile / 2) * 0.5;
    // outer leaves see the sky, inner / lower ones are occluded by the mound
    const outer = Math.min(1, Math.max(0, (Math.pow(shell, 0.35) - 0.7) / 0.3));
    const occ = Math.min(1, Math.max(0, outer * (0.55 + 0.6 * z)));
    const rnd = r();
    const base = pos.length / 3;
    for (const [du, dv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      pos.push(x + (ux * du + vx * dv) * s * 0.5, y + (uy * du + vy * dv) * s * 0.5, z + (uz * du + vz * dv) * s * 0.5);
      nrm.push(nx, ny, nz);
      uv.push(u0 + (du + 1) * 0.25, v0 + (dv + 1) * 0.25);
      attr.push(occ, rnd);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setAttribute('aShrub', new Float32BufferAttribute(attr, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Leaf atlas for the shrubs (2 x 2 tiles of leafy sprays): small oval, grey-green leaves
 * (manzanita) with a few red-brown twigs. Drawn once on a canvas.
 */
export function makeLeafTexture(anisotropy: number): Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  const r = rng(7);
  const half = size / 2;
  for (let t = 0; t < 4; t++) {
    const ox = (t % 2) * half;
    const oy = Math.floor(t / 2) * half;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, half, half);
    ctx.clip();
    const cx = ox + half / 2;
    const cy = oy + half / 2;
    // twigs
    ctx.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      ctx.strokeStyle = `rgba(${70 + r() * 30}, ${32 + r() * 14}, ${24 + r() * 10}, 0.9)`;
      ctx.lineWidth = 1.5 + r() * 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + (r() - 0.5) * 30, cy + (r() - 0.5) * 30);
      ctx.quadraticCurveTo(cx + (r() - 0.5) * 160, cy + (r() - 0.5) * 160, cx + (r() - 0.5) * 220, cy + (r() - 0.5) * 220);
      ctx.stroke();
    }
    // leaves, denser in the middle
    const leaves = 190;
    for (let k = 0; k < leaves; k++) {
      const rr = Math.sqrt(r()) * half * 0.47;
      const a = r() * Math.PI * 2;
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      const len = 9 + r() * 9;
      const wid = len * (0.45 + r() * 0.2);
      const g = 0.75 + r() * 0.5;
      const dry = r() < 0.12;
      const cr = dry ? 128 + r() * 30 : (66 + r() * 22) * g;
      const cg = dry ? 104 + r() * 24 : (84 + r() * 22) * g;
      const cb = dry ? 62 + r() * 16 : (60 + r() * 16) * g;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(r() * Math.PI * 2);
      const grad = ctx.createLinearGradient(-len, 0, len, 0);
      grad.addColorStop(0, `rgb(${cr * 0.7}, ${cg * 0.72}, ${cb * 0.7})`);
      grad.addColorStop(0.5, `rgb(${cr * 1.08}, ${cg * 1.08}, ${cb * 1.05})`);
      grad.addColorStop(1, `rgb(${cr * 0.85}, ${cg * 0.86}, ${cb * 0.85})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}
