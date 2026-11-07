/**
 * Tiny modelling kit: merge transformed primitives into one BufferGeometry with per-vertex colour (linear),
 * PBR (roughness, metalness) and an emissive type id (aEmit) consumed by the props / vehicle shaders.
 */
import * as THREE from 'three';

export const enum Emit {
  None = 0,
  Lamp = 1, // street lamp (neutral-warm LED)
  Lantern = 2, // Chinatown lantern (red-orange)
  SigRed = 3,
  SigAmber = 4,
  SigGreen = 5,
  Ped = 6, // pedestrian signal
  Panel = 7, // backlit ad panel / shelter
  Head = 8, // vehicle headlight
  Tail = 9, // vehicle tail light
  Cabin = 10, // streetcar / bus interior glow
  Globe = 11, // warm globe lamp (Path of Gold, acorns)
}

export class Kit {
  private parts: { g: THREE.BufferGeometry; c: THREE.Color | null; r: number; m: number; e: number; t: number }[] = [];
  private tmp = new THREE.Matrix4();

  add(g: THREE.BufferGeometry, color: THREE.ColorRepresentation | [number, number, number], opts: { r?: number; m?: number; e?: number; t?: number; at?: THREE.Matrix4 } = {}): this {
    const geo = (g.index ? g.toNonIndexed() : g.clone()) as THREE.BufferGeometry;
    if (opts.at) geo.applyMatrix4(opts.at);
    const c = Array.isArray(color) ? new THREE.Color().setRGB(color[0], color[1], color[2]) : new THREE.Color(color);
    this.parts.push({ g: geo, c, r: opts.r ?? 0.6, m: opts.m ?? 0, e: opts.e ?? 0, t: opts.t ?? 0 });
    return this;
  }

  /** Add an already built Kit geometry (keeps its per-vertex colour / PBR / emissive), transformed by `at`. */
  addBuilt(g: THREE.BufferGeometry, at: THREE.Matrix4): this {
    const geo = g.clone();
    geo.applyMatrix4(at);
    this.parts.push({ g: geo, c: null, r: 0, m: 0, e: 0, t: 0 });
    return this;
  }

  /** Helpers producing transform matrices. */
  T(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.ColorRepresentation | [number, number, number], o: { r?: number; m?: number; e?: number; t?: number; ry?: number; rx?: number; rz?: number } = {}): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, { ...o, at: this.T(x, y, z, o.rx ?? 0, o.ry ?? 0, o.rz ?? 0) });
  }

  /** Cylinder from its base point (x,y,z) along local +Y, rotated (rx, ry, rz) about that base point. */
  cyl(r0: number, r1: number, h: number, x: number, y: number, z: number, color: THREE.ColorRepresentation | [number, number, number], o: { r?: number; m?: number; e?: number; t?: number; seg?: number; rx?: number; rz?: number; ry?: number } = {}): this {
    const at = this.T(x, y, z, o.rx ?? 0, o.ry ?? 0, o.rz ?? 0).multiply(new THREE.Matrix4().makeTranslation(0, h / 2, 0));
    return this.add(new THREE.CylinderGeometry(r1, r0, h, o.seg ?? 8, 1), color, { ...o, at });
  }

  sphere(r: number, x: number, y: number, z: number, color: THREE.ColorRepresentation | [number, number, number], o: { r?: number; m?: number; e?: number; t?: number; sy?: number; seg?: number } = {}): this {
    const s = o.seg ?? 10;
    return this.add(new THREE.SphereGeometry(r, s, Math.max(4, Math.round(s * 0.6))), color, { ...o, at: this.T(x, y, z, 0, 0, 0, 1, o.sy ?? 1, 1) });
  }

  /**
   * Prismoid between an axis-aligned bottom rectangle and a top rectangle (x0,x1,z0,z1,y each): sloped sides
   * (windshields / greenhouse) get `side` colour, the top face `top` colour. Bottom face omitted.
   */
  prismoid(
    b: [number, number, number, number, number],
    t: [number, number, number, number, number],
    side: THREE.ColorRepresentation | [number, number, number],
    top: THREE.ColorRepresentation | [number, number, number],
    so: { r?: number; m?: number; e?: number; t?: number } = {},
    to: { r?: number; m?: number; e?: number; t?: number } = {},
  ): this {
    const B = [
      [b[0], b[4], b[2]],
      [b[1], b[4], b[2]],
      [b[1], b[4], b[3]],
      [b[0], b[4], b[3]],
    ];
    const T = [
      [t[0], t[4], t[2]],
      [t[1], t[4], t[2]],
      [t[1], t[4], t[3]],
      [t[0], t[4], t[3]],
    ];
    const sides: number[] = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      // Quad B[i], B[j], T[j], T[i] wound to face outward (CCW seen from outside).
      sides.push(...B[i], ...T[j], ...B[j], ...B[i], ...T[i], ...T[j]);
    }
    const gs = new THREE.BufferGeometry();
    gs.setAttribute('position', new THREE.Float32BufferAttribute(sides, 3));
    gs.computeVertexNormals();
    this.add(gs, side, so);
    const gt = new THREE.BufferGeometry();
    gt.setAttribute('position', new THREE.Float32BufferAttribute([...T[0], ...T[2], ...T[1], ...T[0], ...T[3], ...T[2]], 3));
    gt.computeVertexNormals();
    this.add(gt, top, to);
    return this;
  }

  build(): THREE.BufferGeometry {
    let n = 0;
    for (const p of this.parts) n += p.g.getAttribute('position').count;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const pbr = new Float32Array(n * 3);
    const emit = new Float32Array(n);
    let o = 0;
    for (const p of this.parts) {
      const P = p.g.getAttribute('position');
      if (!p.g.getAttribute('normal')) p.g.computeVertexNormals();
      const N = p.g.getAttribute('normal');
      const C = p.c ? null : p.g.getAttribute('color');
      const PB = p.c ? null : p.g.getAttribute('aPbr');
      const E = p.c ? null : p.g.getAttribute('aEmit');
      for (let i = 0; i < P.count; i++, o++) {
        pos[o * 3] = P.getX(i);
        pos[o * 3 + 1] = P.getY(i);
        pos[o * 3 + 2] = P.getZ(i);
        nrm[o * 3] = N.getX(i);
        nrm[o * 3 + 1] = N.getY(i);
        nrm[o * 3 + 2] = N.getZ(i);
        if (p.c) {
          col[o * 3] = p.c.r;
          col[o * 3 + 1] = p.c.g;
          col[o * 3 + 2] = p.c.b;
          pbr[o * 3] = p.r;
          pbr[o * 3 + 1] = p.m;
          pbr[o * 3 + 2] = p.t;
          emit[o] = p.e;
        } else {
          col[o * 3] = C!.getX(i);
          col[o * 3 + 1] = C!.getY(i);
          col[o * 3 + 2] = C!.getZ(i);
          pbr[o * 3] = PB!.getX(i);
          pbr[o * 3 + 1] = PB!.getY(i);
          pbr[o * 3 + 2] = PB!.getZ(i);
          emit[o] = E!.getX(i);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 3));
    g.setAttribute('aEmit', new THREE.BufferAttribute(emit, 1));
    g.computeBoundingSphere();
    return g;
  }
}
