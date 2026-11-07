/**
 * Ferry Station Post Office (1915), the Beaux-Arts annex at the Ferry Building's south end on The
 * Embarcadero: the same two-storey arcaded sandstone order as the Ferry Building (rusticated arches,
 * arched upper windows between pilasters), cornice, balustrade and a flat roof behind the parapet.
 * Built from its OSM footprint with the Ferry Building kit and materials.
 */
import * as THREE from 'three';
import type { BuildingRecord } from '../../contracts';
import { PartBuilder } from './common/builder';
import { prism, sweepClosed, signedArea, type V2 } from './common/geom';
import { centroid, frameFromAxis, longestEdge, makePivot, toLocal } from './common/frame';
import type { LandmarkBuild } from './common/types';
import { COL, Y, addBalustrade, addRun, type Add } from './ferryParts';

export function buildPostOffice(rec: BuildingRecord, mats: Record<string, THREE.Material>): LandmarkBuild {
  const e = longestEdge(rec.footprint);
  const [cx, cz] = centroid(rec.footprint);
  const f = frameFromAxis(cx, cz, e.ux, e.uz);
  let poly: V2[] = rec.footprint.map(([x, z]) => toLocal(f, x, z));
  if (signedArea(poly) < 0) poly = poly.slice().reverse();
  const b = new PartBuilder();
  const add: Add = (k, g, o) => b.add(k, g, o);
  const n = poly.length;
  // Outward normal of edge i (polygon is CCW in (x, z) → outward = (dz, −dx)).
  for (let i = 0; i < n; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % n];
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (len < 2) continue;
    const out: V2 = [(p1[1] - p0[1]) / len, -(p1[0] - p0[0]) / len];
    if (len >= 5) addRun(add, p0, p1, out, { bays: Math.max(1, Math.round(len / 6.5)), grand: len > 30 ? [Math.floor(Math.round(len / 6.5) / 2)] : [] });
    else add('stone', prismWall(p0, p1, out), { color: COL.stone });
    addBalustrade(add, p0, p1, out, Y.cornice);
  }
  // Plinth, string course and main cornice swept round the outline.
  add('granite', sweepClosed(poly, [[-0.6, -1.6], [0.32, -1.6], [0.32, 0.42], [0.16, 0.6], [-0.6, 0.6]], 0), { color: COL.granite });
  add('trim', sweepClosed(poly, [[-0.4, Y.lowerTop], [0.12, Y.lowerTop + 0.04], [0.16, Y.lowerTop + 0.2], [0.16, Y.lowerTop + 0.4], [0.32, Y.lowerTop + 0.56], [0.32, Y.lowerTop + 0.72], [0.0, Y.string], [-0.4, Y.string]], 0), { color: COL.trim });
  add(
    'trim',
    sweepClosed(poly, [[-0.4, Y.upperTop], [0.1, Y.upperTop], [0.1, Y.upperTop + 0.22], [0.04, Y.upperTop + 0.26], [0.04, Y.upperTop + 0.48], [0.3, Y.upperTop + 0.56], [0.85, Y.upperTop + 0.78], [1.0, Y.upperTop + 0.84], [1.0, Y.cornice], [-0.4, Y.cornice]], 0),
    { color: COL.trim },
  );
  // Quoins on every convex corner.
  for (let i = 0; i < n; i++) {
    const a = poly[(i + n - 1) % n];
    const p = poly[i];
    const c = poly[(i + 1) % n];
    const cross = (p[0] - a[0]) * (c[1] - p[1]) - (p[1] - a[1]) * (c[0] - p[0]);
    if (cross <= 0) continue; // concave in a CCW polygon
    const [mx, mz] = [(a[0] + c[0]) / 2 - p[0], (a[1] + c[1]) / 2 - p[1]];
    const l = Math.hypot(mx, mz) || 1;
    const g = new THREE.BoxGeometry(1.25, Y.upperTop - Y.plinth, 1.25);
    g.rotateY(-Math.atan2(c[1] - p[1], c[0] - p[0]));
    g.translate(p[0] + (mx / l) * 0.5, Y.plinth + (Y.upperTop - Y.plinth) / 2, p[1] + (mz / l) * 0.5);
    add('rustic', g, { color: COL.rustic });
  }
  // Flat roof behind the parapet (gravel / membrane), with a low skylight and rooftop housings.
  add('granite', prism(insetPoly(poly, 0.6), Y.cornice - 0.6, Y.cornice - 0.1), { color: '#77736b' });
  add('roof', prism(insetPoly(poly, 9), Y.cornice - 0.1, Y.cornice + 1.4), { color: COL.roof });
  const model = b.build(mats, 'ferry_post_office');
  const { pivot, inner } = makePivot('ferry_post_office', f, rec.baseElevation);
  inner.add(model);
  return { name: 'ferry_post_office', pivot, buildingIds: [rec.id] };
}

/** Short filler wall (edges too short for an arcade bay). */
function prismWall(p0: V2, p1: V2, out: V2): THREE.BufferGeometry {
  const t = 0.9;
  return prism([p0, p1, [p1[0] - out[0] * t, p1[1] - out[1] * t], [p0[0] - out[0] * t, p0[1] - out[1] * t]], 0, Y.upperTop);
}

/** Polygon shrunk toward its centroid by roughly `d` metres (good enough for near-convex outlines). */
function insetPoly(poly: V2[], d: number): V2[] {
  const [cx, cz] = poly.reduce<V2>((s, p) => [s[0] + p[0] / poly.length, s[1] + p[1] / poly.length], [0, 0]);
  return poly.map(([x, z]) => {
    const l = Math.hypot(x - cx, z - cz) || 1;
    const k = Math.max(0.1, (l - d) / l);
    return [cx + (x - cx) * k, cz + (z - cz) * k] as V2;
  });
}
