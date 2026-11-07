import { BufferAttribute, BufferGeometry, Vector3 } from 'three';

/**
 * Deterministic procedural Sierra Nevada conifers.
 *
 * Every variant is built once at a canonical size (metres, z up, trunk base at the origin) in
 * two LODs, each split into a bark geometry (trunk + branches, opaque) and a foliage geometry
 * (alpha-tested needle cards). Instances are scaled to the lidar height / crown radius.
 *
 * Vertex attributes: position, normal (shading normal: cards blend their own normal with the
 * crown's outward normal so the crown shades as a volume), uv (bark: tiling; foliage: atlas),
 * aCrown = (ao, rand, flex, foliage).
 *
 * Foliage atlas (public/textures/forest/foliage.png, 2048 x 1024): u 0..0.5 fir spray (twig base
 * at v = 0); u 0.5..0.75 Jeffrey pine branch end, side view (v 0.5..1, shoot base at v 0.5) and
 * front view (v 0..0.5); u 0.75..1 the same for lodgepole (see make_textures.py / needles.py).
 */

export const SPECIES_NAMES = ['fir', 'jeffrey', 'lodgepole', 'snag'] as const;
export const VARIANTS_PER_SPECIES = [3, 3, 2, 2] as const; // last fir / pine / lodgepole variant = young
export const VARIANT_BASE = [0, 3, 6, 8] as const;
export const VARIANT_COUNT = 10;
export const PROFILE_SAMPLES = 8;

/** Trees shorter than this (m) use the species' young variant (the last one). */
export const YOUNG_BELOW = [13, 13, 9, 0] as const;

/**
 * Variant of a tree: young trees (open-grown cones with crowns to the ground) get the
 * species' last variant, older ones one of the mature variants by seed. Snags pick by seed.
 */
export function variantIndex(species: number, seed: number, height = 30): number {
  const s = Math.min(3, Math.max(0, species | 0));
  const n = VARIANTS_PER_SPECIES[s]!;
  if (s === 3) return VARIANT_BASE[s]! + (seed % n);
  if (height < YOUNG_BELOW[s]!) return VARIANT_BASE[s]! + n - 1;
  return VARIANT_BASE[s]! + (seed % (n - 1));
}

export interface ConiferLod {
  bark: BufferGeometry;
  foliage: BufferGeometry | null;
  triangles: number;
}

export interface ConiferVariant {
  id: number;
  species: number;
  /** canonical height (m) */
  height: number;
  /** canonical crown radius (m): instances scale horizontally by lidarRadius / crownRadius */
  crownRadius: number;
  /** max horizontal extent of any vertex (m) */
  boundRadius: number;
  /** crown radius (m) at height fractions i / (PROFILE_SAMPLES - 1) */
  profile: Float32Array;
  /** needle extinction for the self-shadow (1/m) */
  density: number;
  /** linear albedo multipliers */
  foliageTint: [number, number, number];
  barkTint: [number, number, number];
  lods: [ConiferLod, ConiferLod];
}

// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UP = new Vector3(0, 0, 1);
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  crown: number[] = [];
  idx: number[] = [];

  vertex(p: Vector3, n: Vector3, u: number, v: number, ao: number, rand: number, flex: number, foliage: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.crown.push(ao, rand, flex, foliage);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aCrown', new BufferAttribute(new Float32Array(this.crown), 4));
    const n = this.vertexCount;
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** A curve through space (branch / trunk axis). */
type Path = (t: number, out: Vector3) => Vector3;

const _t = new Vector3();
const _n = new Vector3();
const _b = new Vector3();
const _p = new Vector3();
const _q = new Vector3();
const _ref = new Vector3();

/**
 * Tapered tube along `path`. Bark texture tiles `wraps` times around and keeps its aspect
 * along the length. aoAt / flexAt give per-ring ambient occlusion and wind flexibility.
 */
function tube(
  b: Builder,
  path: Path,
  radius: (t: number) => number,
  sides: number,
  segs: number,
  opts: { wraps: number; uvLen: number; ao: (t: number) => number; flex: (t: number) => number; rand: number; jag?: () => number },
): void {
  const base = b.vertexCount;
  let along = 0;
  const prev = new Vector3();
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    path(t, _p);
    path(Math.min(1, t + 1e-3), _q);
    if (t >= 1) {
      path(1 - 1e-3, _q);
      _t.subVectors(_p, _q).normalize();
    } else {
      _t.subVectors(_q, _p).normalize();
    }
    if (s > 0) along += _p.distanceTo(prev);
    prev.copy(_p);
    _ref.copy(Math.abs(_t.z) > 0.9 ? new Vector3(1, 0, 0) : UP);
    _n.crossVectors(_t, _ref).normalize();
    _b.crossVectors(_n, _t).normalize();
    const r = radius(t);
    const jag = s === segs && opts.jag ? opts.jag : null;
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const nx = _n.x * c + _b.x * sn;
      const ny = _n.y * c + _b.y * sn;
      const nz = _n.z * c + _b.z * sn;
      const dz = jag ? jag() : 0;
      const p = new Vector3(_p.x + nx * r, _p.y + ny * r, _p.z + nz * r + dz);
      b.vertex(p, new Vector3(nx, ny, nz), (k / sides) * opts.wraps, along / opts.uvLen, opts.ao(t), opts.rand, opts.flex(t), 0);
    }
  }
  const ring = sides + 1;
  for (let s = 0; s < segs; s++) {
    for (let k = 0; k < sides; k++) {
      const a = base + s * ring + k;
      const c = a + ring;
      b.tri(a, a + 1, c + 1);
      b.tri(a, c + 1, c);
    }
  }
}

interface CardOpts {
  /** atlas u range */
  u0: number;
  u1: number;
  /** fold the card along its midline (tent) for volume */
  fold: number;
  rand: number;
  flex: number;
}

const _side = new Vector3();
const _cn = new Vector3();

/**
 * One needle card: centre c, long axis `axis` (unit, base -> tip), roll around the axis.
 * The temporary normal is the card plane normal; finishFoliage() blends in the crown normal.
 */
function card(b: Builder, c: Vector3, axis: Vector3, length: number, width: number, roll: number, o: CardOpts): void {
  _ref.copy(Math.abs(axis.z) > 0.92 ? new Vector3(1, 0, 0) : UP);
  _side.crossVectors(_ref, axis).normalize();
  // roll the side vector around the axis
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  _b.crossVectors(axis, _side);
  _side.multiplyScalar(cr).addScaledVector(_b, sr).normalize();
  _cn.crossVectors(_side, axis).normalize();
  if (_cn.z < 0) _cn.negate();
  const hl = length / 2;
  const hw = width / 2;
  const foldH = o.fold * width;
  const rows = [0, 1];
  const cols = [-1, 0, 1];
  const base = b.vertexCount;
  for (const r of rows) {
    for (const k of cols) {
      const p = new Vector3()
        .copy(c)
        .addScaledVector(axis, (r - 0.5) * 2 * hl)
        .addScaledVector(_side, k * hw)
        .addScaledVector(_cn, k === 0 ? foldH : 0);
      const u = o.u0 + ((k + 1) / 2) * (o.u1 - o.u0);
      b.vertex(p, _cn, u, r === 0 ? 0.002 : 0.998, 1, o.rand, o.flex, 1);
    }
  }
  b.tri(base, base + 1, base + 4);
  b.tri(base, base + 4, base + 3);
  b.tri(base + 1, base + 2, base + 5);
  b.tri(base + 1, base + 5, base + 4);
}

/** Flat card without fold (LOD1). */
function flatCard(b: Builder, c: Vector3, axis: Vector3, length: number, width: number, roll: number, o: CardOpts): void {
  _ref.copy(Math.abs(axis.z) > 0.92 ? new Vector3(1, 0, 0) : UP);
  _side.crossVectors(_ref, axis).normalize();
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  _b.crossVectors(axis, _side);
  _side.multiplyScalar(cr).addScaledVector(_b, sr).normalize();
  _cn.crossVectors(_side, axis).normalize();
  if (_cn.z < 0) _cn.negate();
  const base = b.vertexCount;
  for (const r of [0, 1]) {
    for (const k of [-1, 1]) {
      const p = new Vector3()
        .copy(c)
        .addScaledVector(axis, (r - 0.5) * length)
        .addScaledVector(_side, (k * width) / 2);
      b.vertex(p, _cn, k < 0 ? o.u0 : o.u1, r === 0 ? 0.002 : 0.998, 1, o.rand, o.flex, 1);
    }
  }
  b.tri(base, base + 1, base + 3);
  b.tri(base, base + 3, base + 2);
}

/** Card spanned by unit vectors a1, a2 around c, uv rect [u0,u1] x [v0,v1]. */
function quad(b: Builder, c: Vector3, a1: Vector3, a2: Vector3, s1: number, s2: number, uv: [number, number, number, number], rand: number, flex: number): void {
  const n = new Vector3().crossVectors(a1, a2).normalize();
  if (n.z < 0) n.negate();
  const base = b.vertexCount;
  for (const j of [-1, 1]) {
    for (const i of [-1, 1]) {
      const p = c.clone().addScaledVector(a1, (i * s1) / 2).addScaledVector(a2, (j * s2) / 2);
      b.vertex(p, n, i < 0 ? uv[0] : uv[1], j < 0 ? uv[2] : uv[3], 1, rand, flex, 1);
    }
  }
  b.tri(base, base + 1, base + 3);
  b.tri(base, base + 3, base + 2);
}

/**
 * Crown profile from the foliage vertices, then the final shading normals and AO:
 * normal = card normal blended with the crown's outward normal, AO darker towards the axis and
 * towards the bottom of the crown.
 */
function finishFoliage(f: Builder, height: number, crownBase: number): Float32Array {
  const n = f.vertexCount;
  const profile = new Float32Array(PROFILE_SAMPLES);
  const bins = PROFILE_SAMPLES - 1;
  for (let i = 0; i < n; i++) {
    const x = f.pos[i * 3]!;
    const y = f.pos[i * 3 + 1]!;
    const z = f.pos[i * 3 + 2]!;
    const r = Math.hypot(x, y);
    const h = Math.min(1, Math.max(0, z / height));
    const k = Math.round(h * bins);
    for (const j of [k - 1, k, k + 1]) {
      if (j >= 0 && j <= bins) profile[j] = Math.max(profile[j]!, r * (j === k ? 1 : 0.85));
    }
  }
  for (let j = 0; j <= bins; j++) profile[j] = Math.max(profile[j]!, 0.35);
  const profileAt = (h: number): number => {
    const x = Math.min(1, Math.max(0, h)) * bins;
    const i = Math.min(bins - 1, Math.floor(x));
    const t = x - i;
    return profile[i]! * (1 - t) + profile[i + 1]! * t;
  };
  const crownN = new Vector3();
  const cardN = new Vector3();
  for (let i = 0; i < n; i++) {
    const x = f.pos[i * 3]!;
    const y = f.pos[i * 3 + 1]!;
    const z = f.pos[i * 3 + 2]!;
    const h = z / height;
    const hc = Math.min(1, Math.max(0, (h - crownBase) / (1 - crownBase)));
    const r = Math.hypot(x, y);
    const rf = Math.min(1, r / profileAt(h));
    const rx = r > 1e-4 ? x / r : 0;
    const ry = r > 1e-4 ? y / r : 0;
    crownN.set(rx * (0.3 + 0.7 * rf), ry * (0.3 + 0.7 * rf), 0.12 + 0.3 * (1 - rf) + 0.3 * hc).normalize();
    cardN.set(f.nor[i * 3]!, f.nor[i * 3 + 1]!, f.nor[i * 3 + 2]!);
    if (cardN.dot(crownN) < 0) cardN.negate();
    cardN.multiplyScalar(0.35).addScaledVector(crownN, 0.65).normalize();
    f.nor[i * 3] = cardN.x;
    f.nor[i * 3 + 1] = cardN.y;
    f.nor[i * 3 + 2] = cardN.z;
    const rand = f.crown[i * 4 + 1]!;
    const ao = (0.28 + 0.72 * smooth(0.05, 0.95, rf)) * (0.72 + 0.28 * Math.sqrt(hc)) * (0.88 + 0.12 * rand);
    f.crown[i * 4] = Math.min(1, ao);
    // flex grows towards the outside of the crown and the top
    f.crown[i * 4 + 2] = Math.min(1, f.crown[i * 4 + 2]! * (0.4 + 0.6 * rf));
  }
  return profile;
}

// species
//
// Each variant first draws a skeleton (trunk, limbs, twigs) from its seeded random stream; both
// LODs are emitted from the same skeleton so the LOD0 <-> LOD1 cross-fade keeps the crown shape.

const range = (rnd: () => number, a: number, b: number): number => a + (b - a) * rnd();
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

interface Twig {
  t: number;
  side: number;
  len: number;
  lift: number;
  r: number[];
}
interface Limb {
  base: Vector3;
  dir: Vector3;
  len: number;
  pitch: number;
  droop: number;
  upturn: number;
  r0: number;
  hc: number;
  /** 0 main limb, 1 inter-whorl shoot, 2 dead stub */
  kind: 0 | 1 | 2;
  r: number[];
  twigs: Twig[];
}
interface CoreCard {
  z: number;
  w: number;
  h: number;
  roll: number;
  r: number;
}
interface Skeleton {
  species: number;
  young: boolean;
  H: number;
  crownBase: number;
  Rmax: number;
  density: number;
  trunkR: number;
  topZ: number;
  lean: number;
  leanAz: number;
  ph: [number, number];
  jag: number[] | null;
  limbs: Limb[];
  core: CoreCard[];
  leader: { len: number; r: number[] };
}

const rands = (rnd: () => number, n = 6): number[] => Array.from({ length: n }, rnd);

function trunkPath(sk: Skeleton): Path {
  const { topZ, lean, leanAz, ph, trunkR } = sk;
  return (t, out) => {
    const w = 0.5 * trunkR * t;
    return out.set(
      Math.cos(leanAz) * lean * t * t + Math.sin(t * 7 + ph[0]) * w * 0.15,
      Math.sin(leanAz) * lean * t * t + Math.sin(t * 5 + ph[1]) * w * 0.15,
      t * topZ,
    );
  };
}
const trunkAt = (sk: Skeleton, z: number): Vector3 => trunkPath(sk)(Math.min(1, Math.max(0, z / sk.topZ)), new Vector3());

function newSkeleton(rnd: () => number, species: number, young: boolean, H: number, crownBase: number, Rmax: number, density: number, trunkR: number): Skeleton {
  return {
    species,
    young,
    H,
    crownBase,
    Rmax,
    density,
    trunkR,
    topZ: H * 0.985,
    lean: range(rnd, 0.1, 0.4),
    leanAz: rnd() * 6.283,
    ph: [rnd() * 6.283, rnd() * 6.283],
    jag: null,
    limbs: [],
    core: [],
    leader: { len: 1.6, r: rands(rnd) },
  };
}

function limb(rnd: () => number, sk: Skeleton, z: number, az: number, len: number, pitch: number, droop: number, upturn: number, r0: number, kind: 0 | 1 | 2): Limb {
  const hc = Math.min(1, Math.max(0, (z / sk.H - sk.crownBase) / (1 - sk.crownBase)));
  return {
    base: trunkAt(sk, z),
    dir: new Vector3(Math.cos(az), Math.sin(az), 0),
    len,
    pitch,
    droop,
    upturn,
    r0,
    hc,
    kind,
    r: rands(rnd),
    twigs: [],
  };
}

// --- skeletons --------------------------------------------------------------------------------

function firSkeleton(rnd: () => number, variant: number): Skeleton {
  const young = variant === 2;
  const H = young ? 10 : variant === 1 ? 33 : 29;
  const sk = newSkeleton(
    rnd,
    0,
    young,
    H,
    young ? range(rnd, 0.03, 0.07) : range(rnd, 0.22, 0.3),
    young ? range(rnd, 2.2, 2.5) : range(rnd, 3.3, 3.8) * (variant === 1 ? 0.9 : 1),
    0.45,
    young ? 0.16 : 0.44,
  );
  const zb = sk.crownBase * H;
  if (!young) {
    for (let i = 0; i < 12; i++) {
      sk.limbs.push(limb(rnd, sk, range(rnd, 2.5, zb), rnd() * 6.283, range(rnd, 0.3, 1.3), -0.2, 0.15, 0, 0.05, 2));
    }
  }
  const spacing = young ? 0.32 : 0.5;
  let az = rnd() * 6.283;
  for (let z = zb; z < H - 0.6; ) {
    const hc = (z - zb) / (H - zb);
    const nb = 5 + Math.floor(rnd() * 3);
    const Lw = young
      ? sk.Rmax * Math.pow(1 - hc, 0.95) + 0.15
      : sk.Rmax * Math.pow(1 - hc, 0.9) * (0.6 + 0.4 * smooth(0, 0.15, hc)) + 0.25;
    for (let k = 0; k < nb; k++) {
      az += (Math.PI * 2) / nb + range(rnd, -0.35, 0.35);
      const L = Lw * range(rnd, 0.85, 1.12);
      const pitch = 0.2 * hc - 0.3 * (1 - hc) + range(rnd, -0.08, 0.08);
      sk.limbs.push(limb(rnd, sk, z, az, L, pitch, 0.15 * (1 - hc), 0.08, 0.025 + 0.03 * L, 0));
    }
    // inter-whorl shoots
    const zi = z + spacing * 0.5;
    if (zi < H - 0.8) {
      for (let k = 0; k < 3; k++) {
        const L = Lw * range(rnd, 0.35, 0.6);
        sk.limbs.push(limb(rnd, sk, zi, rnd() * 6.283, L, 0.05, 0.08, 0, 0.02, 1));
      }
    }
    z += spacing * range(rnd, 0.85, 1.15) * (1 - 0.3 * hc);
  }
  // core fill: crossed vertical cards hide the trunk inside the crown
  for (let z = zb + 0.5; z < H - 1.5; z += young ? 0.8 : 1.3) {
    const hc = (z - zb) / (H - zb);
    sk.core.push({ z, w: (sk.Rmax * Math.pow(1 - hc, 0.9) + 0.3) * 1.15, h: young ? 1.2 : 1.8, roll: rnd() * 3.14, r: rnd() });
  }
  sk.leader.len = young ? 1.0 : 1.7;
  return sk;
}

function pineSkeleton(rnd: () => number, variant: number): Skeleton {
  const young = variant === 2;
  const H = young ? 11 : variant === 1 ? 33 : 29;
  const sk = newSkeleton(
    rnd,
    1,
    young,
    H,
    young ? range(rnd, 0.12, 0.2) : range(rnd, 0.42, 0.52),
    young ? range(rnd, 2.4, 2.8) : range(rnd, 4.4, 5.3) * (variant === 1 ? 0.88 : 1),
    0.3,
    young ? 0.2 : 0.56,
  );
  sk.topZ = H * 0.97;
  const zb = sk.crownBase * H;
  if (!young) {
    for (let i = 0; i < 6; i++) {
      sk.limbs.push(limb(rnd, sk, range(rnd, 4, zb), rnd() * 6.283, range(rnd, 0.2, 0.7), -0.1, 0.1, 0, 0.06, 2));
    }
  }
  let az = rnd() * 6.283;
  for (let z = zb; z < H - 1.0; ) {
    const hc = (z - zb) / (H - zb);
    const nb = young ? 4 + Math.floor(rnd() * 2) : 2 + Math.floor(rnd() * 4);
    const Lw = young
      ? sk.Rmax * Math.pow(1 - hc, 0.85) + 0.3
      : sk.Rmax * Math.pow(1 - hc, 0.5) * (0.62 + 0.38 * smooth(0, 0.35, hc)) + 0.4;
    for (let k = 0; k < nb; k++) {
      az += GOLDEN * 1.3 + range(rnd, -0.4, 0.4);
      const gap = rnd();
      const L = Lw * range(rnd, 0.6, 1.2);
      const pitch = young ? 0.15 + 0.35 * hc + range(rnd, -0.1, 0.1) : -0.15 * (1 - hc) + 0.6 * hc * hc + range(rnd, -0.18, 0.2);
      const l = limb(rnd, sk, z, az, L, pitch, young ? 0.1 : 0.22 * (1 - hc), young ? 0.2 : 0.32, 0.03 + 0.024 * L, 0);
      const nt = Math.round(2 + L * (young ? 1.2 : 1.8));
      for (let s = 0; s < nt; s++) {
        l.twigs.push({
          t: range(rnd, 0.12, 0.92),
          side: s % 2 ? 1 : -1,
          len: L * range(rnd, 0.18, 0.34) + 0.2,
          lift: range(rnd, 0.25, 0.6),
          r: rands(rnd),
        });
      }
      if (!young && gap < 0.15) continue; // gaps keep the crown open
      sk.limbs.push(l);
    }
    z += (young ? range(rnd, 0.45, 0.75) : range(rnd, 0.55, 1.6)) * (1 - 0.25 * hc);
  }
  sk.leader.len = young ? 0.9 : 1.2;
  return sk;
}

function lodgepoleSkeleton(rnd: () => number, variant: number): Skeleton {
  const young = variant === 1;
  const H = young ? 8 : 20;
  const sk = newSkeleton(
    rnd,
    2,
    young,
    H,
    young ? range(rnd, 0.06, 0.12) : range(rnd, 0.4, 0.5),
    young ? range(rnd, 1.4, 1.7) : range(rnd, 1.9, 2.4),
    0.38,
    young ? 0.1 : 0.24,
  );
  const zb = sk.crownBase * H;
  let az = rnd() * 6.283;
  for (let z = zb; z < H - 0.5; ) {
    const hc = (z - zb) / (H - zb);
    const nb = 5 + Math.floor(rnd() * 3);
    const Lw = sk.Rmax * Math.pow(1 - hc, 0.75) * (0.6 + 0.4 * smooth(0, 0.2, hc)) + 0.2;
    for (let k = 0; k < nb; k++) {
      az += (Math.PI * 2) / nb + range(rnd, -0.4, 0.4);
      const L = Lw * range(rnd, 0.75, 1.15);
      sk.limbs.push(limb(rnd, sk, z, az, L, 0.1 + 0.3 * hc - 0.25 * (1 - hc) + range(rnd, -0.1, 0.1), 0.1, 0.15, 0.03, 0));
    }
    z += (young ? 0.3 : 0.45) * range(rnd, 0.85, 1.15);
  }
  sk.leader.len = young ? 0.6 : 0.8;
  return sk;
}

function snagSkeleton(rnd: () => number, variant: number): Skeleton {
  const H = 20;
  const sk = newSkeleton(rnd, 3, false, H, 0.3, 1.6, 0.05, variant === 0 ? 0.48 : 0.3);
  sk.topZ = H * (variant === 0 ? range(rnd, 0.82, 0.93) : 0.99);
  sk.lean = range(rnd, 0.1, 0.5);
  if (variant === 0) sk.jag = rands(rnd, 12);
  for (let i = 0; i < 26; i++) {
    const z = range(rnd, H * 0.3, sk.topZ - 0.3);
    const long = rnd() < 0.3;
    const L = long ? range(rnd, 1.2, 2.6) * (1 - z / H) + 0.4 : range(rnd, 0.2, 0.7);
    const l = limb(rnd, sk, z, rnd() * 6.283, L, long ? -0.25 : -0.05, long ? 0.18 : 0.05, 0, long ? 0.06 : 0.07, long ? 0 : 2);
    sk.limbs.push(l);
  }
  return sk;
}

// --- emission ---------------------------------------------------------------------------------

const FIR_U: [number, number] = [0.0, 0.5];

function limbPath(l: Limb): Path {
  return branchPath(l.base, l.dir, l.len, l.pitch, l.droop, l.upturn);
}

/** Point on a branch: horizontal direction `dir`, pitch, length, droop / upturn shape. */
function branchPath(base: Vector3, dir: Vector3, len: number, pitch: number, droop: number, upturn: number): Path {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return (t, out) =>
    out.set(
      base.x + dir.x * len * t * cp,
      base.y + dir.y * len * t * cp,
      base.z + len * (sp * t - droop * t * t + upturn * t * t * t),
    );
}

function tangent(path: Path, t: number, out: Vector3): Vector3 {
  const a = path(Math.max(0, t - 0.01), new Vector3());
  const b = path(Math.min(1, t + 0.01), new Vector3());
  return out.subVectors(b, a).normalize();
}

function emitTrunk(b: Builder, sk: Skeleton, lod: 0 | 1): void {
  const zb = sk.crownBase * sk.H;
  const jag = sk.jag;
  let j = 0;
  tube(
    b,
    trunkPath(sk),
    (t) => {
      const z = t * sk.topZ;
      const flare = 1 + 0.75 * Math.exp(-z * 2.2);
      const taper = sk.species === 3 ? 0.55 : 0.93;
      return Math.max(0.025, sk.trunkR * (1 - taper * Math.pow(t, 0.95)) * flare);
    },
    lod === 0 ? 10 : 6,
    lod === 0 ? 14 : 5,
    {
      wraps: lod === 0 ? 2 : 1,
      uvLen: (2 * Math.PI * sk.trunkR) / (lod === 0 ? 2 : 1),
      // trunks stand among other trees: sky partly occluded even below the crown
      ao: (t) => (t * sk.topZ > zb ? 0.45 : 0.68),
      flex: (t) => t * t * 0.3,
      rand: 0.5,
      jag: jag ? () => (jag[j++ % jag.length]! - 0.3) * 0.9 : undefined,
    },
  );
}

function emitLimbTube(b: Builder, l: Limb, sides: number, segs: number): void {
  tube(b, limbPath(l), (t) => l.r0 * (1 - 0.82 * t), sides, segs, {
    wraps: 1,
    uvLen: 0.5,
    ao: (t) => (l.kind === 2 ? 0.6 : 0.22 + 0.4 * t),
    flex: (t) => (l.kind === 2 ? 0 : t),
    rand: l.r[0]!,
  });
}

/** n flat cards around `axis` through `cen` (a star seen end-on). */
function star(b: Builder, cen: Vector3, axis: Vector3, len: number, wid: number, n: number, roll0: number, u: [number, number], rand: number, flex: number, fold = 0): void {
  for (let k = 0; k < n; k++) {
    const roll = roll0 + (k / n) * Math.PI;
    if (fold > 0) card(b, cen, axis, len, wid, roll, { u0: u[0], u1: u[1], fold, rand, flex });
    else flatCard(b, cen, axis, len, wid, roll, { u0: u[0], u1: u[1], fold: 0, rand, flex });
  }
}

function emitFir(sk: Skeleton, lod: 0 | 1, bark: Builder, fol: Builder): void {
  emitTrunk(bark, sk, lod);
  for (const l of sk.limbs) {
    const bp = limbPath(l);
    if (l.kind === 2) {
      if (lod === 0) emitLimbTube(bark, l, 3, 1);
      continue;
    }
    if (l.kind === 1) {
      if (lod === 1 && l.r[3]! < 0.5) continue;
      const cen = bp(0.6, new Vector3());
      const ax = tangent(bp, 0.6, new Vector3());
      const len = l.len * 0.9 + 0.25;
      star(fol, cen, ax, len, len * 0.9, 2, l.r[1]! * 3, FIR_U, l.r[2]!, 0.6);
      continue;
    }
    if (lod === 0 && l.len > 1.3) emitLimbTube(bark, l, 3, 2);
    if (lod === 0) {
      const segs = Math.max(1, Math.round(l.len / 0.85));
      for (let s = 0; s < segs; s++) {
        const t0 = 0.06 + (0.94 * s) / segs;
        const t1 = 0.06 + (0.94 * (s + 1)) / segs + (s === segs - 1 ? 0.1 : 0.03);
        const tm = (t0 + t1) / 2;
        const cen = bp(tm, new Vector3());
        const ax = tangent(bp, tm, new Vector3()).applyAxisAngle(UP, (l.r[(s + 1) % 6]! - 0.5) * 0.5).normalize();
        const len = (t1 - t0) * l.len * 1.3 + 0.2;
        star(fol, cen, ax, len, len, 3, (l.r[s % 6]! - 0.5) * 0.6, FIR_U, l.r[(s + 2) % 6]!, 0.3 + 0.7 * tm);
      }
    } else {
      // LOD1: ~60% of the limbs with bigger cards keep the same envelope
      if (l.r[5]! < 0.4) continue;
      const cen = bp(0.55, new Vector3());
      const ax = tangent(bp, 0.55, new Vector3());
      const len = l.len * 1.2 + 0.35;
      star(fol, cen, ax, len, len * 1.05, 2, (l.r[0]! - 0.5) * 0.6 + 0.4, FIR_U, l.r[2]!, 0.7);
    }
  }
  sk.core.forEach((c, i) => {
    if (lod === 1 && i % 2 === 1) return;
    const cen = trunkAt(sk, c.z);
    cen.z += c.h * 0.3;
    star(fol, cen, new Vector3(0, 0, 1), c.h * (lod === 1 ? 1.6 : 1), c.w, 2, c.roll, FIR_U, c.r, 0.2);
  });
  const top = trunkAt(sk, sk.H * 0.95);
  top.z += sk.leader.len * 0.25;
  star(fol, top, new Vector3(0, 0, 1), sk.leader.len, sk.leader.len * 0.6, lod === 0 ? 3 : 2, sk.leader.r[0]! * 3, FIR_U, sk.leader.r[1]!, 1);
}

type Uv = [number, number, number, number];
interface PineCards {
  /** branch end seen from the side, shoot base at the bottom centre */
  side: Uv;
  /** the same branch end seen down the shoot */
  front: Uv;
}
const JEFFREY_CARDS: PineCards = { side: [0.5, 0.75, 0.5, 1], front: [0.5, 0.75, 0, 0.5] };
const LODGE_CARDS: PineCards = { side: [0.75, 1, 0.5, 1], front: [0.75, 1, 0, 0.5] };
const _c1 = new Vector3();
const _c2 = new Vector3();

/**
 * Pine branch end at `c` pointing along `axis`: two crossed side cards with the shoots running
 * up from their base at `c` (needles brushing forward), plus a front card across the axis
 * through the middle of the needles (the same branch end seen down the shoot). The textures are
 * two views of one 3D needle simulation (needles.py), so the clump reads as needles from every
 * side. Mirrored at random for variety. `cards` 2 drops the front card (LOD1).
 */
function clump(b: Builder, c: Vector3, axis: Vector3, size: number, uv: PineCards, roll: number, rand: number, flex: number, cards = 3): void {
  const ax = axis.clone().normalize();
  _ref.copy(Math.abs(ax.z) > 0.9 ? new Vector3(1, 0, 0) : UP);
  _c1.crossVectors(ax, _ref).normalize();
  _c2.crossVectors(ax, _c1).normalize();
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const p1 = _c1.clone().multiplyScalar(cr).addScaledVector(_c2, sr);
  const p2 = new Vector3().crossVectors(ax, p1).normalize();
  const flip = (u: Uv, m: boolean): Uv => (m ? [u[1], u[0], u[2], u[3]] : u);
  const cen = c.clone().addScaledVector(ax, size * 0.49);
  quad(b, cen, p1, ax, size, size, flip(uv.side, rand > 0.5), rand, flex);
  quad(b, cen, p2, ax, size * 0.92, size * 0.92, flip(uv.side, rand <= 0.5), rand, flex);
  if (cards > 2) quad(b, c.clone().addScaledVector(ax, size * 0.42), p1, p2, size * 0.9, size * 0.9, flip(uv.front, rand > 0.3), rand, flex);
}

function emitPine(sk: Skeleton, lod: 0 | 1, bark: Builder, fol: Builder): void {
  emitTrunk(bark, sk, lod);
  const lodge = sk.species === 2;
  const uv = lodge ? LODGE_CARDS : JEFFREY_CARDS;
  const cs = lodge ? (sk.young ? 0.75 : 1.0) : sk.young ? 1.0 : 1.3;
  for (const l of sk.limbs) {
    if (l.kind === 2) {
      if (lod === 0) emitLimbTube(bark, l, 3, 1);
      continue;
    }
    const bp = limbPath(l);
    if (!lodge) {
      if (lod === 0) emitLimbTube(bark, l, 4, 4);
      else if (l.r0 > 0.08) emitLimbTube(bark, { ...l, r0: l.r0 * 0.7 }, 3, 2);
    } else if (lod === 0) {
      emitLimbTube(bark, l, 3, 1);
    }
    const tipAx = tangent(bp, 0.98, new Vector3()).addScaledVector(UP, 0.7).normalize();
    // upturned branch end
    clump(fol, bp(0.97, new Vector3()), tipAx, cs * (lod === 0 ? 1.1 : 1.4) * (0.85 + 0.3 * l.r[0]!), uv, l.r[1]! * 3, l.r[2]!, 1, lod === 0 ? 3 : 2);
    // shoots along the outer limb
    const step = lodge ? 0.5 : 0.7;
    const span = lodge ? 0.75 : 0.55;
    const nAlong = lod === 0 ? Math.floor((l.len * span) / step) : lodge ? 1 : 0;
    for (let s = 0; s < nAlong; s++) {
      const t = lod === 0 ? 1 - span + 0.02 + ((span - 0.12) * (s + 0.5)) / nAlong : 0.5;
      const side = new Vector3().crossVectors(UP, tangent(bp, t, new Vector3())).normalize().multiplyScalar(s % 2 ? 0.6 : -0.6);
      const ax = tangent(bp, t, new Vector3()).add(side).addScaledVector(UP, 0.9).normalize();
      clump(fol, bp(t, new Vector3()), ax, cs * (lod === 0 ? 0.85 : 1.35) * (0.85 + 0.3 * l.r[(s + 3) % 6]!), uv, l.r[(s + 2) % 6]! * 3 + s, l.r[(s + 4) % 6]!, 0.4 + 0.6 * t, lod === 0 ? 3 : 2);
    }
    if (lodge) continue;
    // Jeffrey pine: side twigs ending in branch ends
    l.twigs.forEach((tw, k) => {
      if (lod === 1 && k % 2 === 1) return;
      const p0 = bp(tw.t, new Vector3());
      const tg = tangent(bp, tw.t, new Vector3());
      const side = new Vector3().crossVectors(UP, tg).normalize().multiplyScalar(tw.side);
      const sdir = tg.clone().multiplyScalar(0.7).add(side).normalize();
      const hd = new Vector3(sdir.x, sdir.y, 0).normalize();
      const sbp = branchPath(p0, hd, tw.len, Math.asin(Math.max(-0.9, Math.min(0.9, sdir.z))) + tw.lift, 0.05, 0.2);
      if (lod === 0) tube(bark, sbp, (q) => l.r0 * 0.5 * (1 - 0.8 * q), 3, 1, { wraps: 1, uvLen: 0.4, ao: () => 0.45, flex: () => 1, rand: tw.r[0]! });
      const ax = tangent(sbp, 0.95, new Vector3()).addScaledVector(UP, 0.7).normalize();
      clump(fol, sbp(0.95, new Vector3()), ax, cs * (lod === 0 ? 0.95 : 1.35) * (0.85 + 0.3 * tw.r[1]!), uv, tw.r[2]! * 3, tw.r[3]!, 1, lod === 0 ? 3 : 2);
    });
  }
  const top = trunkAt(sk, sk.topZ * 0.94);
  clump(fol, top, new Vector3(0, 0, 1), cs * 1.25, uv, sk.leader.r[0]! * 3, sk.leader.r[1]!, 1, 3);
}

function emitSnag(sk: Skeleton, lod: 0 | 1, bark: Builder): void {
  emitTrunk(bark, sk, lod);
  for (const l of sk.limbs) {
    if (lod === 1 && l.kind === 2) continue;
    emitLimbTube(bark, l, 3, l.kind === 0 && lod === 0 ? 2 : 1);
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Linear albedo multipliers on the atlas / bark textures. Targets (effective card albedo, the
 * cards themselves carry no needle-to-needle shadowing): Sierra conifers are dark blue-green
 * to olive, ~0.03-0.06 linear, not bright grass green.
 */
const TINTS: Record<number, { foliage: [number, number, number]; bark: [number, number, number] }> = {
  // white / red fir: deep blue-green with a silvery cast
  0: { foliage: [0.66, 0.52, 0.74], bark: [0.45, 0.55, 0.72] },
  // Jeffrey pine: grey-blue-green needles, cinnamon bark plates
  1: { foliage: [0.48, 0.46, 0.55], bark: [0.62, 0.72, 0.85] },
  // lodgepole: dark yellow-green, thin scaly grey-brown bark
  2: { foliage: [0.5, 0.52, 1.0], bark: [0.55, 0.68, 0.85] },
  // snag: silver-grey weathered wood
  3: { foliage: [1, 1, 1], bark: [1.6, 1.58, 1.55] },
};

let cache: ConiferVariant[] | null = null;

/** All variants (built once, ~50 ms). */
export function buildConifers(): ConiferVariant[] {
  if (cache) return cache;
  const out: ConiferVariant[] = [];
  for (let species = 0; species < 4; species++) {
    for (let v = 0; v < VARIANTS_PER_SPECIES[species]!; v++) {
      const id = VARIANT_BASE[species]! + v;
      const rnd = mulberry32(1000 + id * 97);
      const sk = [firSkeleton, pineSkeleton, lodgepoleSkeleton, snagSkeleton][species]!(rnd, v);
      const lods: ConiferLod[] = [];
      let profile: Float32Array = new Float32Array(PROFILE_SAMPLES);
      let boundRadius = 0;
      for (const lod of [0, 1] as const) {
        const bark = new Builder();
        const fol = new Builder();
        if (species === 0) emitFir(sk, lod, bark, fol);
        else if (species === 3) emitSnag(sk, lod, bark);
        else emitPine(sk, lod, bark, fol);
        const prof = fol.vertexCount > 0 ? finishFoliage(fol, sk.H, sk.crownBase) : snagProfile(bark, sk.H);
        if (lod === 0) {
          profile = prof;
          for (const b of [bark, fol]) {
            for (let i = 0; i < b.vertexCount; i++) boundRadius = Math.max(boundRadius, Math.hypot(b.pos[i * 3]!, b.pos[i * 3 + 1]!));
          }
        }
        lods.push({
          bark: bark.geometry(),
          foliage: fol.vertexCount > 0 ? fol.geometry() : null,
          triangles: bark.triangleCount + fol.triangleCount,
        });
      }
      const tint = TINTS[species]!;
      out.push({
        id,
        species,
        height: sk.H,
        crownRadius: species === 3 ? sk.Rmax : profile.reduce((m, r) => Math.max(m, r), 0) * 0.92,
        boundRadius: Math.max(boundRadius, 0.5),
        profile,
        density: sk.density,
        foliageTint: tint.foliage,
        barkTint: tint.bark,
        lods: [lods[0]!, lods[1]!],
      });
    }
  }
  cache = out;
  return out;
}

function snagProfile(b: Builder, H: number): Float32Array {
  const p = new Float32Array(PROFILE_SAMPLES).fill(0.3);
  for (let i = 0; i < b.vertexCount; i++) {
    const k = Math.round(Math.min(1, Math.max(0, b.pos[i * 3 + 2]! / H)) * (PROFILE_SAMPLES - 1));
    p[k] = Math.max(p[k]!, Math.hypot(b.pos[i * 3]!, b.pos[i * 3 + 1]!));
  }
  return p;
}
