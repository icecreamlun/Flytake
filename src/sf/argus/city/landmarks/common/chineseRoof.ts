/**
 * Chinese hip roof (廡殿 style) with concave slopes and swept-up corners, as used on paifang gates.
 * Four parametric slopes share their hip edges exactly. Returns tile surface (UVs: u across the
 * slope, v down the slope, metres), the painted underside, the eave fascia, and the ridge curves for
 * ridge tiles / ornaments.
 */
import * as THREE from 'three';

export interface RoofSpec {
  /** Eave half-length (x) and half-depth (z). */
  ae: number;
  be: number;
  /** Main ridge half-length. */
  ar: number;
  /** Eave and ridge heights. */
  ye: number;
  yr: number;
  /** Upturn of the corners (m). */
  curl: number;
  thick?: number;
  segS?: number;
  segT?: number;
}

export interface RoofParts {
  tiles: THREE.BufferGeometry;
  under: THREE.BufferGeometry;
  fascia: THREE.BufferGeometry;
  /** Main ridge endpoints. */
  ridge: [THREE.Vector3, THREE.Vector3];
  /** Four hip curves from the ridge ends to the eave corners. */
  hips: THREE.Vector3[][];
  /** Eave corner tips. */
  corners: THREE.Vector3[];
}

export function chineseRoof(sp: RoofSpec): RoofParts {
  const segS = sp.segS ?? 16;
  const segT = sp.segT ?? 8;
  const thick = sp.thick ?? 0.22;
  const Y = (t: number) => sp.yr - (sp.yr - sp.ye) * (2 * t - t * t);
  const curl = (s: number, t: number) => sp.curl * Math.pow(Math.abs(s), 5) * t * t;
  // side: 0 = +z front, 1 = -z back, 2 = +x right, 3 = -x left
  const P = (side: number, s: number, t: number, dy = 0): THREE.Vector3 => {
    const reach = sp.ar + (sp.ae - sp.ar) * t;
    const y = Y(t) + curl(s, t) + dy;
    switch (side) {
      case 0:
        return new THREE.Vector3(s * reach, y, sp.be * t);
      case 1:
        return new THREE.Vector3(-s * reach, y, -sp.be * t);
      case 2:
        return new THREE.Vector3(reach, y, -s * sp.be * t);
      default:
        return new THREE.Vector3(-reach, y, s * sp.be * t);
    }
  };
  const slopeLen = Math.hypot(sp.be, sp.yr - sp.ye) * 1.08;
  const surf = (dy: number, flip: boolean) => {
    const pos: number[] = [];
    const uv: number[] = [];
    for (let side = 0; side < 4; side++) {
      for (let i = 0; i < segS; i++) {
        for (let j = 0; j < segT; j++) {
          const s0 = -1 + (2 * i) / segS;
          const s1 = -1 + (2 * (i + 1)) / segS;
          const t0 = j / segT;
          const t1 = (j + 1) / segT;
          const q = [P(side, s0, t0, dy), P(side, s1, t0, dy), P(side, s1, t1, dy), P(side, s0, t1, dy)];
          const u = (s: number, t: number) => s * (side < 2 ? sp.ar + (sp.ae - sp.ar) * t : sp.be * t);
          const quv: [number, number][] = [
            [u(s0, t0), t0 * slopeLen],
            [u(s1, t0), t0 * slopeLen],
            [u(s1, t1), t1 * slopeLen],
            [u(s0, t1), t1 * slopeLen],
          ];
          // Outward (upward) winding: (q0, q2, q1), (q0, q3, q2) for this parametrisation.
          const order = flip ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
          for (const k of order) {
            pos.push(q[k].x, q[k].y, q[k].z);
            uv.push(quv[k][0], quv[k][1]);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  };
  const tiles = orientUp(surf(0, false), true);
  const under = orientUp(surf(-thick, false), false);
  // Fascia: ribbon along every eave edge.
  const fpos: number[] = [];
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < segS; i++) {
      const s0 = -1 + (2 * i) / segS;
      const s1 = -1 + (2 * (i + 1)) / segS;
      const a = P(side, s0, 1);
      const b = P(side, s1, 1);
      const c = P(side, s1, 1, -thick);
      const d = P(side, s0, 1, -thick);
      fpos.push(a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    }
  }
  const fascia = new THREE.BufferGeometry();
  fascia.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
  orientOutward(fascia);
  const hips: THREE.Vector3[][] = [];
  for (const [side, s] of [
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 1],
  ] as const) {
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j <= segT; j++) pts.push(P(side, s, j / segT));
    hips.push(pts);
  }
  return {
    tiles,
    under,
    fascia,
    ridge: [new THREE.Vector3(-sp.ar, sp.yr, 0), new THREE.Vector3(sp.ar, sp.yr, 0)],
    hips,
    corners: hips.map((h) => h[h.length - 1]),
  };
}

/** Flip triangles so normals point up (tiles) or down (underside). */
function orientUp(g: THREE.BufferGeometry, up: boolean): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < p.count; t += 3) {
    a.fromBufferAttribute(p, t);
    b.fromBufferAttribute(p, t + 1);
    c.fromBufferAttribute(p, t + 2);
    const ny = b.clone().sub(a).cross(c.clone().sub(a)).y;
    if (ny > 0 !== up) {
      p.setXYZ(t + 1, c.x, c.y, c.z);
      p.setXYZ(t + 2, b.x, b.y, b.z);
      const u1 = uv.getX(t + 1);
      const v1 = uv.getY(t + 1);
      uv.setXY(t + 1, uv.getX(t + 2), uv.getY(t + 2));
      uv.setXY(t + 2, u1, v1);
    }
  }
  return g;
}

/** Flip triangles whose normal points toward the vertical axis (x = z = 0). */
function orientOutward(g: THREE.BufferGeometry): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < p.count; t += 3) {
    a.fromBufferAttribute(p, t);
    b.fromBufferAttribute(p, t + 1);
    c.fromBufferAttribute(p, t + 2);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    const m = a.clone().add(b).add(c);
    if (n.x * m.x + n.z * m.z < 0) {
      p.setXYZ(t + 1, c.x, c.y, c.z);
      p.setXYZ(t + 2, b.x, b.y, b.z);
    }
  }
}
