/**
 * Baked landcover for the detail zone, painted with Canvas2D in world space and packed into two textures:
 *   texA (1 m/texel): R sidewalk concrete, G grass/vegetation, B pavers (plazas, pedestrian streets),
 *                     A flush asphalt (alleys/driveways/parking lots/cycleways at sidewalk level)
 *   texB (2 m/texel): R decomposed-granite / dirt (park paths, construction), G stairs,
 *                     B,A local street direction as (cos 2θ, sin 2θ)·0.5+0.5 (axial, so it blends safely)
 * Channels are painted with additive ('lighter') compositing so each layer is an independent coverage mask;
 * the ground shader resolves priorities and turns the soft 1 m coverage into crisp, slightly irregular edges.
 */
import * as THREE from 'three';
import type { AreaRecord, CityData } from '../../../contracts';
import type { RoadNet, Road } from '../core/roadnet';
import { pointInRing, ringBBox } from '../core/contour';
import { DZ } from '../core/zone';

export interface Landcover {
  texA: THREE.DataTexture;
  texB: THREE.DataTexture;
}

function canvas2d(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d', { willReadFrequently: true })!;
}

function pathRoad(g: CanvasRenderingContext2D, r: Road) {
  g.beginPath();
  g.moveTo(r.pts[0], r.pts[1]);
  for (let k = 2; k < r.pts.length; k += 2) g.lineTo(r.pts[k], r.pts[k + 1]);
}

function pathArea(g: CanvasRenderingContext2D, a: AreaRecord) {
  g.beginPath();
  const ring = (pts: [number, number][]) => {
    g.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
    g.closePath();
  };
  ring(a.polygon);
  for (const h of a.holes ?? []) ring(h);
}

const RANK: Record<string, number> = { motorway: 6, primary: 5, secondary: 4, tertiary: 3, residential: 2, living_street: 1, service: 0 };

export function bakeLandcover(city: CityData, net: RoadNet): Landcover {
  const W = DZ.maxX - DZ.minX;
  const H = DZ.maxZ - DZ.minZ;
  const world = (g: CanvasRenderingContext2D, res: number) => g.setTransform(1 / res, 0, 0, 1 / res, -DZ.minX / res, -DZ.minZ / res);

  // Park polygons for "is this path inside a park" tests.
  const parks = city.areas.filter((a) => a.kind === 'park' || a.kind === 'grass' || a.kind === 'pitch');
  const parkRings = parks.map((a) => {
    const flat = a.polygon.flat();
    return { flat, bb: ringBBox(flat) };
  });
  const inPark = (x: number, z: number) => parkRings.some((p) => x >= p.bb[0] && x <= p.bb[2] && z >= p.bb[1] && z <= p.bb[3] && pointInRing(p.flat, x, z));

  // ── Canvas A (1 m): concrete / grass / pavers.
  const A = canvas2d(W, H);
  A.fillStyle = '#000';
  A.fillRect(0, 0, W, H);
  world(A, 1);
  A.globalCompositeOperation = 'lighter';
  A.lineCap = 'round';
  A.lineJoin = 'round';
  // Grass first (parks, lawns, pitches).
  A.fillStyle = 'rgb(0,255,0)';
  for (const a of parks) {
    pathArea(A, a);
    A.fill('evenodd');
  }
  // Plazas → pavers.
  A.fillStyle = 'rgb(0,0,255)';
  for (const a of city.areas) {
    if (a.kind !== 'plaza') continue;
    pathArea(A, a);
    A.fill('evenodd');
  }
  A.strokeStyle = 'rgb(0,0,255)';
  for (const r of net.roads) {
    if (r.cls !== 'pedestrian') continue;
    A.lineWidth = Math.max(4, r.rec.width);
    pathRoad(A, r);
    A.stroke();
  }
  // Sidewalk bands along curbed roads.
  A.strokeStyle = 'rgb(255,0,0)';
  for (const r of net.roads) {
    if (!r.curbed || r.sw <= 0) continue;
    A.lineWidth = 2 * (r.hw + r.sw);
    pathRoad(A, r);
    A.stroke();
  }
  // Paths outside parks are concrete.
  const parkPaths: Road[] = [];
  for (const r of net.roads) {
    if (r.cls !== 'path') continue;
    const mid = net.at(r, r.len / 2);
    if (inPark(mid.x, mid.z)) {
      parkPaths.push(r);
      continue;
    }
    A.lineWidth = Math.max(1.5, r.rec.width);
    pathRoad(A, r);
    A.stroke();
  }
  const imgA = A.getImageData(0, 0, W, H).data;

  // ── Canvas B (1 m): flush asphalt / dirt / steps.
  const B = canvas2d(W, H);
  B.fillStyle = '#000';
  B.fillRect(0, 0, W, H);
  world(B, 1);
  B.globalCompositeOperation = 'lighter';
  B.lineCap = 'round';
  B.lineJoin = 'round';
  B.fillStyle = 'rgb(255,0,0)';
  for (const a of city.areas) {
    if (a.kind !== 'parking') continue;
    pathArea(B, a);
    B.fill('evenodd');
  }
  B.strokeStyle = 'rgb(255,0,0)';
  for (const r of net.roads) {
    if (r.cls !== 'flush' && r.cls !== 'cycle') continue;
    B.lineWidth = Math.max(2.5, r.rec.width);
    pathRoad(B, r);
    B.stroke();
  }
  B.fillStyle = 'rgb(0,255,0)';
  for (const a of city.areas) {
    if (a.kind !== 'construction') continue;
    pathArea(B, a);
    B.fill('evenodd');
  }
  B.strokeStyle = 'rgb(0,255,0)';
  for (const r of parkPaths) {
    B.lineWidth = Math.max(1.8, r.rec.width);
    pathRoad(B, r);
    B.stroke();
  }
  B.strokeStyle = 'rgb(0,0,255)';
  for (const r of net.roads) {
    if (r.cls !== 'steps') continue;
    B.lineWidth = Math.max(2, r.rec.width);
    pathRoad(B, r);
    B.stroke();
  }
  const imgB = B.getImageData(0, 0, W, H).data;

  // ── Direction canvas (2 m).
  const W2 = W / 2;
  const H2 = H / 2;
  const D = canvas2d(W2, H2);
  D.fillStyle = 'rgb(128,128,0)';
  D.fillRect(0, 0, W2, H2);
  world(D, 2);
  D.lineCap = 'butt';
  D.lineJoin = 'round';
  const dirRoads = net.roads
    .filter((r) => r.curbed || r.cls === 'path' || r.cls === 'pedestrian' || r.cls === 'steps' || r.cls === 'flush')
    .sort((a, b) => (a.curbed ? 10 + (RANK[a.kind] ?? 0) : 0) - (b.curbed ? 10 + (RANK[b.kind] ?? 0) : 0));
  for (const r of dirRoads) {
    D.lineWidth = r.curbed ? 2 * (r.hw + r.sw) + 3 : Math.max(3, r.rec.width + 2);
    for (let k = 0; k < r.pts.length - 2; k += 2) {
      const dx = r.pts[k + 2] - r.pts[k];
      const dz = r.pts[k + 3] - r.pts[k + 1];
      const th = Math.atan2(dz, dx);
      const c = Math.round((Math.cos(2 * th) * 0.5 + 0.5) * 255);
      const s = Math.round((Math.sin(2 * th) * 0.5 + 0.5) * 255);
      D.strokeStyle = `rgb(${c},${s},255)`;
      D.beginPath();
      D.moveTo(r.pts[k], r.pts[k + 1]);
      D.lineTo(r.pts[k + 2], r.pts[k + 3]);
      D.stroke();
    }
  }
  const imgD = D.getImageData(0, 0, W2, H2).data;

  // ── Pack.
  const dataA = new Uint8Array(W * H * 4);
  for (let i = 0, n = W * H; i < n; i++) {
    dataA[i * 4] = imgA[i * 4];
    dataA[i * 4 + 1] = imgA[i * 4 + 1];
    dataA[i * 4 + 2] = imgA[i * 4 + 2];
    dataA[i * 4 + 3] = imgB[i * 4];
  }
  const dataB = new Uint8Array(W2 * H2 * 4);
  for (let j = 0; j < H2; j++) {
    for (let i = 0; i < W2; i++) {
      const o = (j * W2 + i) * 4;
      // 2×2 average of dirt / steps from the 1 m canvas.
      let dirt = 0;
      let steps = 0;
      for (let b = 0; b < 2; b++)
        for (let a = 0; a < 2; a++) {
          const q = ((j * 2 + b) * W + i * 2 + a) * 4;
          dirt += imgB[q + 1];
          steps += imgB[q + 2];
        }
      dataB[o] = dirt >> 2;
      dataB[o + 1] = steps >> 2;
      dataB[o + 2] = imgD[o];
      dataB[o + 3] = imgD[o + 1];
    }
  }
  const mk = (data: Uint8Array, w: number, h: number) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  return { texA: mk(dataA, W, H), texB: mk(dataB, W2, H2) };
}
