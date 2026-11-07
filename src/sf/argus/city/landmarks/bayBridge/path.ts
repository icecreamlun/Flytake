/**
 * Alignment of the San Francisco–Oakland Bay Bridge western span and its SoMa approach, from OSM
 * (ways 1011568818 "West Span", 432712476–79 towers, 236374789 "Center Anchorage", 1136339258/9 anchorages,
 * 202485364 / 1343738800 I-80 approach), projected with geo.ts.
 *
 * Arc length s = 0 at the Rincon Hill anchorage, increasing toward Yerba Buena Island; the approach
 * viaduct has negative s.
 */
import type { XZ } from '../../../contracts';

/** Main axis: Rincon Hill anchorage → Yerba Buena Island anchorage. */
export const AXIS_A: XZ = [657, 793];
export const AXIS_U: XZ = [0.6474, -0.7622];
export const AXIS_N: XZ = [0.7622, 0.6474]; // lateral, pointing south-east

/** Key stations (arc length from the Rincon anchorage, m) measured from the OSM tower/pier centroids. */
export const S = {
  rincon: 0,
  w1: 284, // cable bent / pier W1
  t1: 641,
  t2: 1345,
  center: 1724,
  t3: 2103,
  t4: 2807,
  ybi: 3179,
  portal: 3300,
} as const;

/** Center anchorage footprint (OSM): length along the axis, width across. */
export const CENTER_SIZE = { along: 69, across: 40 };

/** I-80 approach, from the anchorage westward (OSM way 1343738800 + 202485364). */
const APPROACH: XZ[] = [
  [657, 793],
  [640, 810],
  [596, 851],
  [543, 891],
  [469, 940],
  [432, 964],
  [396, 991],
  [362, 1020],
  [232, 1146],
];

const approachLen: number[] = [0];
for (let i = 1; i < APPROACH.length; i++) {
  approachLen.push(approachLen[i - 1] + Math.hypot(APPROACH[i][0] - APPROACH[i - 1][0], APPROACH[i][1] - APPROACH[i - 1][1]));
}
export const APPROACH_END = -approachLen[approachLen.length - 1];

/** Plan position at arc length s. */
export function pos(s: number): XZ {
  if (s >= 0) return [AXIS_A[0] + AXIS_U[0] * s, AXIS_A[1] + AXIS_U[1] * s];
  const d = Math.min(-s, approachLen[approachLen.length - 1]);
  let i = 1;
  while (i < approachLen.length - 1 && approachLen[i] < d) i++;
  const k = (d - approachLen[i - 1]) / (approachLen[i] - approachLen[i - 1]);
  const a = APPROACH[i - 1];
  const b = APPROACH[i];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

/** Unit tangent (toward YBI) at s, smoothed over ±6 m so the approach bends are gentle. */
export function tangent(s: number): XZ {
  if (s >= 6) return AXIS_U;
  const a = pos(s - 6);
  const b = pos(s + 6);
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

/** Lateral unit vector (right of travel toward YBI → south-east on the main axis). */
export function lateral(s: number): XZ {
  const [tx, tz] = tangent(s);
  return [-tz, tx];
}

/** Upper-deck road elevation (m ASL): gentle crest at the center anchorage. */
const PROFILE: [number, number][] = [
  [APPROACH_END, 33],
  [-150, 44],
  [0, 47],
  [S.w1, 55],
  [S.t1, 62.5],
  [(S.t1 + S.t2) / 2, 66.5],
  [S.t2, 68.5],
  [S.center, 70],
  [S.t3, 68.5],
  [(S.t3 + S.t4) / 2, 66.5],
  [S.t4, 63],
  [S.ybi, 58.5],
  [S.portal, 57.5],
];

export function deckY(s: number): number {
  const p = PROFILE;
  if (s <= p[0][0]) return p[0][1];
  if (s >= p[p.length - 1][0]) return p[p.length - 1][1];
  let i = 1;
  while (p[i][0] < s) i++;
  // Monotone cubic (Catmull-Rom with clamped ends) for a smooth vertical curve.
  const p0 = p[Math.max(0, i - 2)];
  const p1 = p[i - 1];
  const p2 = p[i];
  const p3 = p[Math.min(p.length - 1, i + 1)];
  const t = (s - p1[0]) / (p2[0] - p1[0]);
  const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0] || 1)) * (p2[0] - p1[0]);
  const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0] || 1)) * (p2[0] - p1[0]);
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
}

/** Bridge geometry constants (m). */
export const DIM = {
  cableHalf: 10.0, // main cables / truss planes at ±10 m
  trussDepth: 11.0, // top chord (deck + 1.4) → bottom chord
  deckGap: 9.5, // upper road → lower road
  panel: 9.1, // 30 ft panels
  towerTop: 160,
  saddle: 157,
  pierTop: 14,
};
