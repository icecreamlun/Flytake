/**
 * Small geometry toolkit for hand-built landmarks. All functions return fresh BufferGeometries in the
 * landmark's local frame (metres, +Y up). "y0" arguments are bottoms, not centres.
 */
import * as THREE from 'three';

export type V2 = [number, number];

/** Axis-aligned box with its bottom at y0. */
export function box(w: number, h: number, d: number, x = 0, y0 = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y0 + h / 2, z);
  return g;
}

/** Cylinder / frustum with its bottom at y0. */
export function cyl(rTop: number, rBot: number, h: number, seg = 12, x = 0, y0 = 0, z = 0, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  g.translate(x, y0 + h / 2, z);
  return g;
}

export function sphere(r: number, x = 0, y = 0, z = 0, ws = 12, hs = 8): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, ws, hs);
  g.translate(x, y, z);
  return g;
}

/** Lathe a (radius, y) profile around +Y. */
export function lathe(profile: V2[], seg = 16, x = 0, y0 = 0, z = 0, phiStart = 0): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y)), seg, phiStart);
  g.translate(x, y0, z);
  return g;
}

/** Apply translation / rotation (radians, Euler XYZ) / scale in place. */
export function xf(
  g: THREE.BufferGeometry,
  o: { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; sx?: number; sy?: number; sz?: number },
): THREE.BufferGeometry {
  if (o.sx !== undefined || o.sy !== undefined || o.sz !== undefined) g.scale(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
  if (o.rx) g.rotateX(o.rx);
  if (o.ry) g.rotateY(o.ry);
  if (o.rz) g.rotateZ(o.rz);
  g.translate(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  return g;
}

/** Signed area of an XZ polygon (positive = counter-clockwise in the (x, z) plane). */
export function signedArea(poly: V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i];
    const [x1, z1] = poly[(i + 1) % poly.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/**
 * Sweep a moulding profile along a closed XZ polygon. Profile points are (out, up): `out` is the
 * offset along the outward normal (m), `up` the height above y0. Corners are mitred. Traverse the
 * profile bottom → out → top → back in (solid on the left in (out, up)); faces then point outward.
 */
export function sweepClosed(poly: V2[], profile: V2[], y0 = 0): THREE.BufferGeometry {
  const n = poly.length;
  const sgn = signedArea(poly) > 0 ? 1 : -1;
  const en: V2[] = [];
  for (let i = 0; i < n; i++) {
    const [x0, z0] = poly[i];
    const [x1, z1] = poly[(i + 1) % n];
    const l = Math.hypot(x1 - x0, z1 - z0) || 1;
    // Outward normal: for a positive-area loop in (x, z) it is (dz, -dx)/l.
    en.push([(sgn * (z1 - z0)) / l, (sgn * -(x1 - x0)) / l]);
  }
  const mit: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = en[(i - 1 + n) % n];
    const b = en[i];
    let mx = a[0] + b[0];
    let mz = a[1] + b[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const k = 1 / Math.max(0.2, mx * b[0] + mz * b[1]);
    mit.push([mx * k, mz * k]);
  }
  const P = (i: number, j: number): THREE.Vector3 => {
    const [x, z] = poly[i % n];
    const m = mit[i % n];
    const [o, u] = profile[j];
    return new THREE.Vector3(x + m[0] * o, y0 + u, z + m[1] * o);
  };
  // Decide the winding once from a rising profile segment on edge 0 (its normal must point outward).
  let flip = false;
  for (let j = 0; j + 1 < profile.length; j++) {
    if (profile[j + 1][1] - profile[j][1] > 1e-4) {
      const a = P(0, j);
      const b = P(1, j);
      const c = P(1, j + 1);
      const nrm = b.clone().sub(a).cross(c.clone().sub(a));
      flip = nrm.x * en[0][0] + nrm.z * en[0][1] < 0;
      break;
    }
  }
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j + 1 < profile.length; j++) {
      const a = P(i, j);
      const b = P(i + 1, j);
      const c = P(i + 1, j + 1);
      const d = P(i, j + 1);
      if (!flip) pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
      else pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/**
 * Sweep a profile (out, up) along a straight run from (x0,z0) to (x1,z1). `outDir` is the outward
 * horizontal direction of the profile's +out axis (normalised internally). Ends are capped.
 */
export function sweepLine(x0: number, z0: number, x1: number, z1: number, profile: V2[], y0: number, outDir: V2): THREE.BufferGeometry {
  const dir = new THREE.Vector3(x1 - x0, 0, z1 - z0);
  const l = dir.length() || 1;
  dir.divideScalar(l);
  const nrm = new THREE.Vector3(outDir[0], 0, outDir[1]).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Vector3().crossVectors(nrm, up);
  const forward = c.dot(dir) > 0;
  const zAxis = forward ? dir : dir.clone().negate();
  const shape = new THREE.Shape(profile.map(([o, u]) => new THREE.Vector2(o, u)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: l, bevelEnabled: false, steps: 1 });
  const m = new THREE.Matrix4().makeBasis(nrm, up, zAxis);
  g.applyMatrix4(m);
  if (forward) g.translate(x0, y0, z0);
  else g.translate(x1, y0, z1);
  return g.toNonIndexed();
}

/** Rectangle polygon centred at (cx, cz), half extents hx (x), hz (z). CCW in (x,z). */
export function rect(hx: number, hz: number, cx = 0, cz = 0): V2[] {
  return [
    [cx - hx, cz - hz],
    [cx + hx, cz - hz],
    [cx + hx, cz + hz],
    [cx - hx, cz + hz],
  ];
}

/** Extrude an XZ polygon from y0 to y1 (solid prism with caps). */
export function prism(poly: V2[], y0: number, y1: number, holes: V2[][] = []): THREE.BufferGeometry {
  // Shape lives in (x, -z) so that rotating -90° about X maps shape y → world -z… i.e. back to z.
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

/**
 * Round-arch opening path in the XY plane (for wall holes): width w, centred at cx, sill at y0,
 * springing height ys (where the semicircle starts). Clockwise (hole orientation).
 */
export function archPath(cx: number, w: number, y0: number, ys: number, seg = 10, rise?: number): THREE.Path {
  const r = w / 2;
  const k = rise !== undefined ? rise / r : 1; // < 1 → segmental-looking elliptical arch
  const p = new THREE.Path();
  p.moveTo(cx - r, y0);
  p.lineTo(cx - r, ys);
  for (let i = 1; i <= seg; i++) {
    const a = Math.PI - (i / seg) * Math.PI;
    p.lineTo(cx + Math.cos(a) * r, ys + Math.sin(a) * r * k);
  }
  p.lineTo(cx + r, y0);
  p.lineTo(cx - r, y0);
  return p;
}

/** Pointed (Gothic) arch path: two arcs of radius `r = w * f` meeting at the apex. */
export function gothicPath(cx: number, w: number, y0: number, ys: number, seg = 8, f = 0.85): THREE.Path {
  const half = w / 2;
  const r = w * f;
  const p = new THREE.Path();
  p.moveTo(cx - half, y0);
  p.lineTo(cx - half, ys);
  // Left arc centred at (cx - half + r, ys); right arc mirrored.
  const lc = cx - half + r;
  const apexA = Math.acos((lc - cx) / r);
  for (let i = 1; i <= seg; i++) {
    const a = Math.PI - (i / seg) * (Math.PI - apexA);
    p.lineTo(lc + Math.cos(a) * r, ys + Math.sin(a) * r);
  }
  const rc = cx + half - r;
  for (let i = seg - 1; i >= 0; i--) {
    const a = (i / seg) * (Math.PI - apexA);
    p.lineTo(rc + Math.cos(a) * r, ys + Math.sin(a) * r);
  }
  p.lineTo(cx + half, y0);
  p.lineTo(cx - half, y0);
  return p;
}

/** Rectangular hole path in the XY plane (clockwise). */
export function rectPath(cx: number, w: number, y0: number, h: number): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(cx - w / 2, y0);
  p.lineTo(cx - w / 2, y0 + h);
  p.lineTo(cx + w / 2, y0 + h);
  p.lineTo(cx + w / 2, y0);
  p.lineTo(cx - w / 2, y0);
  return p;
}

/**
 * A wall slab in the XY plane spanning x ∈ [x0, x1], y ∈ [y0, y1], extruded from z = 0 to z = -t
 * (front face at z = 0 looks toward +Z), with the given openings punched through.
 */
export function wall(x0: number, x1: number, y0: number, y1: number, t: number, holes: THREE.Path[] = []): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(x0, y0);
  s.lineTo(x1, y0);
  s.lineTo(x1, y1);
  s.lineTo(x0, y1);
  s.lineTo(x0, y0);
  s.holes.push(...holes);
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 8 });
  g.translate(0, 0, -t);
  return g;
}

/** Ring-shaped arch moulding (archivolt) in the XY plane, thickness d toward +Z from z = 0. */
export function archivolt(cx: number, ys: number, rIn: number, rOut: number, d: number, seg = 12): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI - (i / seg) * Math.PI;
    pts.push(new THREE.Vector2(cx + Math.cos(a) * rOut, ys + Math.sin(a) * rOut));
  }
  for (let i = seg; i >= 0; i--) {
    const a = Math.PI - (i / seg) * Math.PI;
    pts.push(new THREE.Vector2(cx + Math.cos(a) * rIn, ys + Math.sin(a) * rIn));
  }
  return new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: d, bevelEnabled: false });
}

/** Map XY-plane geometry built "facing +Z" onto a facade: rotate by ry about Y, then translate. */
export function place(g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** Catenary-ish sag curve between two points (parabola), n segments, sag (m) at the middle. */
export function sagCurve(a: THREE.Vector3, b: THREE.Vector3, sag: number, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t);
    out.push(p);
  }
  return out;
}

/** Thin box "beam" between two 3D points with a w × h cross-section (h along the up-ish axis). */
export function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const len = d.length();
  const g = new THREE.BoxGeometry(w, h, len);
  const dir = d.normalize();
  const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3().crossVectors(up, dir).normalize();
  const yAxis = new THREE.Vector3().crossVectors(dir, xAxis).normalize();
  const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, dir);
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  g.applyMatrix4(m);
  return g;
}

/** Tube through points with radius r and `radial` sides. */
export function tube(points: THREE.Vector3[], r: number, radial = 6, segPerPoint = 1): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  return new THREE.TubeGeometry(curve, Math.max(2, points.length * segPerPoint), r, radial, false);
}

/**
 * Solid hexahedron from 8 corners: bottom quad b0..b3 then top quad t0..t3 (same winding, t_i above b_i).
 * Faces are oriented outward from the centroid (works for any convex, possibly sheared/tapered block).
 */
export function hexa(c: THREE.Vector3[]): THREE.BufferGeometry {
  const quads = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const ctr = c.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / 8);
  const pos: number[] = [];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (const [a, b, d, e] of quads) {
    for (const [i, j, k] of [
      [a, b, d],
      [a, d, e],
    ]) {
      e1.subVectors(c[j], c[i]);
      e2.subVectors(c[k], c[i]);
      const n = e1.clone().cross(e2);
      const mid = c[i].clone().add(c[j]).add(c[k]).multiplyScalar(1 / 3).sub(ctr);
      if (n.dot(mid) >= 0) pos.push(c[i].x, c[i].y, c[i].z, c[j].x, c[j].y, c[j].z, c[k].x, c[k].y, c[k].z);
      else pos.push(c[i].x, c[i].y, c[i].z, c[k].x, c[k].y, c[k].z, c[j].x, c[j].y, c[j].z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** Quad (two triangles) with explicit UVs; vertices CCW as seen from the front. */
export function quadUV(p: THREE.Vector3[], uv: [number, number][]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const idx = [0, 1, 2, 0, 2, 3];
  g.setAttribute('position', new THREE.Float32BufferAttribute(idx.flatMap((i) => [p[i].x, p[i].y, p[i].z]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(idx.flatMap((i) => uv[i]), 2));
  return g;
}
