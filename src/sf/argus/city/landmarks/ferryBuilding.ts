/**
 * San Francisco Ferry Building (A. Page Brown, 1898). Beaux-Arts, Colusa sandstone, ~201 m long:
 * two-storey arcaded facades (rusticated ground-floor arches, arched upper windows between pilasters),
 * cornice + balustrade, a hipped roof with the nave skylight, the projecting entrance pavilion on The
 * Embarcadero, and the 75 m clock tower modelled on the Giralda of Seville (square shaft, four dials,
 * arched belfry, two stacked lanterns, dome, finial). "PORT OF SAN FRANCISCO" lettering on both fronts.
 *
 * Placement comes from the OSM footprint: local +X runs along the long east wall (NW → SE), local +Z
 * points at the city (west) façade; the tower centre is taken from the tallest tower part.
 */
import * as THREE from 'three';
import { PartBuilder } from './common/builder';
import { archPath, archivolt, box, cyl, lathe, rect, sweepClosed, wall, type V2 } from './common/geom';
import { COL, Y, addBalustrade, addRun, arcadedStage, balustradeRing, cornice, hipRoof, urn, type Add } from './ferryParts';
import { buildPostOffice } from './ferryPostOffice';
import { lmMaterial } from './common/materials';
import { clockDial, signPanel } from './common/canvasArt';
import { clockHands } from './common/clock';
import { centroid, frameFromAxis, longestEdge, makePivot, toLocal } from './common/frame';
import type { LandmarkBuild, LandmarkEnv } from './common/types';

export function buildFerryBuilding(env: LandmarkEnv): LandmarkBuild[] | null {
  const recs = env.byLandmark('ferry_building');
  if (!recs.length) return null;
  const main = recs.reduce((a, b) => (Math.abs(polyArea(b.footprint)) > Math.abs(polyArea(a.footprint)) ? b : a));
  const towerRec = recs.filter((r) => r !== main).reduce<typeof main | null>((a, b) => (!a || polyArea(b.footprint) > polyArea(a.footprint) ? b : a), null);
  const fp = main.footprint;

  // Frame: X along the long east wall, Z toward the city façade.
  const e = longestEdge(fp);
  let ux = e.ux;
  let uz = e.uz;
  const [mx, mz] = centroid(fp);
  if (-uz * (mx - e.a[0]) + ux * (mz - e.a[1]) < 0) {
    ux = -ux;
    uz = -uz;
  }
  const f0 = frameFromAxis(e.a[0], e.a[1], ux, uz);
  const lp = fp.map(([x, z]) => toLocal(f0, x, z));
  const minX = Math.min(...lp.map((p) => p[0]));
  const maxX = Math.max(...lp.map((p) => p[0]));
  const sortedZ = lp.map((p) => p[1]).filter((v) => v > 10).sort((a, b) => a - b);
  const D = sortedZ[Math.floor(sortedZ.length / 2)] ?? 47.3;
  const L = maxX - minX;
  // Re-centre the frame on the main block.
  const ox = (minX + maxX) / 2;
  const oz = D / 2;
  const cxw = f0.cx + ox * f0.ux - oz * f0.uz;
  const czw = f0.cz + ox * f0.uz + oz * f0.ux;
  const f = frameFromAxis(cxw, czw, ux, uz);
  const HX = L / 2;
  const HZ = D / 2;
  // Entrance pavilion on the city side (footprint vertices beyond the main wall).
  const loc = fp.map(([x, z]) => toLocal(f, x, z));
  const pav = loc.filter((p) => p[1] > HZ + 2);
  const pavX0 = pav.length ? Math.min(...pav.map((p) => p[0])) : -21.5;
  const pavX1 = pav.length ? Math.max(...pav.map((p) => p[0])) : 21.5;
  const pavZ = pav.length ? Math.max(...pav.map((p) => p[1])) : HZ + 8.9;
  let [tx, tz] = towerRec ? toLocal(f, ...centroid(towerRec.footprint)) : [(pavX0 + pavX1) / 2, HZ - 5];
  if (!isFinite(tx)) [tx, tz] = [0, HZ - 5];

  const b = new PartBuilder();
  const add: Add = (key, g, o) => b.add(key, g, o);

  // ── Facades ──
  const W = HZ; // west (city) wall z
  const Eas = -HZ;
  const wingBays = (len: number) => Math.max(1, Math.round(len / 6.5));
  addRun(add, [-HX, W], [pavX0, W], [0, 1], { bays: wingBays(pavX0 + HX) });
  addRun(add, [pavX1, W], [HX, W], [0, 1], { bays: wingBays(HX - pavX1) });
  addRun(add, [pavX0, pavZ], [pavX1, pavZ], [0, 1], { bays: 7, grand: [2, 3, 4] });
  addRun(add, [pavX0, W], [pavX0, pavZ], [-1, 0], { bays: 1 });
  addRun(add, [pavX1, W], [pavX1, pavZ], [1, 0], { bays: 1 });
  const eastBays = Math.round(L / 6.5) | 1;
  const mid = Math.floor(eastBays / 2);
  addRun(add, [-HX, Eas], [HX, Eas], [0, -1], { bays: eastBays, grand: [mid - 1, mid, mid + 1] });
  addRun(add, [-HX, -HZ], [-HX, HZ], [-1, 0], { bays: 7 });
  addRun(add, [HX, -HZ], [HX, HZ], [1, 0], { bays: 7 });

  // ── Continuous mouldings around the whole outline ──
  const outline: V2[] = [
    [-HX, -HZ],
    [HX, -HZ],
    [HX, HZ],
    [pavX1, HZ],
    [pavX1, pavZ],
    [pavX0, pavZ],
    [pavX0, HZ],
    [-HX, HZ],
  ];
  add(
    'granite',
    sweepClosed(
      outline,
      [
        [-0.6, -1.6],
        [0.32, -1.6],
        [0.32, 0.42],
        [0.16, 0.6],
        [-0.6, 0.6],
      ],
      0,
    ),
    { color: COL.granite },
  );
  add(
    'trim',
    sweepClosed(
      outline,
      [
        [-0.4, Y.lowerTop],
        [0.12, Y.lowerTop + 0.04],
        [0.16, Y.lowerTop + 0.2],
        [0.16, Y.lowerTop + 0.4],
        [0.32, Y.lowerTop + 0.56],
        [0.32, Y.lowerTop + 0.72],
        [0.0, Y.string],
        [-0.4, Y.string],
      ],
      0,
    ),
    { color: COL.trim },
  );
  // Entablature + main cornice.
  add(
    'trim',
    sweepClosed(
      outline,
      [
        [-0.4, Y.upperTop],
        [0.1, Y.upperTop],
        [0.1, Y.upperTop + 0.22],
        [0.04, Y.upperTop + 0.26],
        [0.04, Y.upperTop + 0.48],
        [0.3, Y.upperTop + 0.56],
        [0.85, Y.upperTop + 0.78],
        [1.0, Y.upperTop + 0.84],
        [1.0, Y.cornice],
        [-0.4, Y.cornice],
      ],
      0,
    ),
    { color: COL.trim },
  );
  // Rusticated quoins on the convex corners (also hide the wall-slab end caps).
  const quoinH = Y.upperTop - Y.plinth;
  const quoins: [V2, V2][] = [
    [[-HX, -HZ], [1, 1]],
    [[HX, -HZ], [-1, 1]],
    [[HX, HZ], [-1, -1]],
    [[-HX, HZ], [1, -1]],
    [[pavX0, pavZ], [1, -1]],
    [[pavX1, pavZ], [-1, -1]],
  ];
  for (const [[qx, qz], [sx, sz]] of quoins) {
    add('rustic', box(1.25, quoinH, 1.25, qx + sx * 0.56, Y.plinth, qz + sz * 0.56), { color: COL.rustic });
  }
  // Balustrade on the main block (not on the pavilion, which has a solid attic).
  addBalustrade(add, [-HX, -HZ], [HX, -HZ], [0, -1], Y.cornice);
  addBalustrade(add, [HX, -HZ], [HX, HZ], [1, 0], Y.cornice);
  addBalustrade(add, [-HX, HZ], [-HX, -HZ], [-1, 0], Y.cornice);
  addBalustrade(add, [-HX, HZ], [pavX0, HZ], [0, 1], Y.cornice);
  addBalustrade(add, [pavX1, HZ], [HX, HZ], [0, 1], Y.cornice);
  // Corner pavilions: raised solid attics with urns at the four corners of the block.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (HX - 3.2);
      const z = sz * (HZ - 3.2);
      add('stone', box(7.0, 2.2, 7.0, x, Y.cornice, z), { color: COL.stone });
      cornice(add, rect(3.5, 3.5, x, z), Y.cornice + 2.2, 0.35, 0.45);
      urn(add, sx * (HX - 0.6), Y.cornice + 2.65, sz * (HZ - 0.6), 0.9);
    }
  }

  // ── Entrance pavilion attic with lettering ──
  const pavC: V2 = [(pavX0 + pavX1) / 2, (HZ + pavZ) / 2];
  const pavHX = (pavX1 - pavX0) / 2;
  const pavHZ = (pavZ - HZ) / 2;
  add('stone', box(pavX1 - pavX0, Y.attic - Y.cornice, pavZ - HZ + 4, pavC[0], Y.cornice, pavC[1] - 2), { color: COL.stone });
  cornice(add, rect(pavHX, pavHZ + 2, pavC[0], pavC[1] - 2), Y.attic, 0.55, 0.6);
  addBalustrade(add, [pavX0 + 0.4, pavZ - 0.3], [pavX1 - 0.4, pavZ - 0.3], [0, 1], Y.attic + 0.6, 5.5);
  // East attic carrying the bay-side lettering.
  add('stone', box(40, 3.6, 3.0, tx, Y.cornice, -HZ + 1.2), { color: COL.stone });
  cornice(add, rect(20, 1.5, tx, -HZ + 1.2), Y.cornice + 3.6, 0.45, 0.5);
  for (const sx of [-1, 1]) urn(add, tx + sx * 19.4, Y.cornice + 4.1, -HZ + 0.4, 1.0);

  // ── Roof: hipped slate roof + glazed nave skylight ──
  const roofPitch = THREE.MathUtils.degToRad(15);
  add('roof', hipRoof(HX - 0.7, HZ - 0.7, Y.cornice - 0.05, roofPitch), { color: COL.roof });
  const ridgeY = Y.cornice - 0.05 + (HZ - 0.7) * Math.tan(roofPitch);
  const skyHalf = 3.4;
  const skyBase = ridgeY - skyHalf * Math.tan(roofPitch) - 0.1;
  const skyLen = 2 * (HX - HZ - 6);
  for (const s of [-1, 1]) {
    const side = new THREE.PlaneGeometry(skyLen, ridgeY + 1.1 - skyBase);
    side.rotateY(s > 0 ? 0 : Math.PI);
    side.translate(0, (ridgeY + 1.1 + skyBase) / 2, s * skyHalf);
    add('skylight', side, { glow: 0.6 });
    const top = new THREE.PlaneGeometry(skyLen, Math.hypot(skyHalf, 1.0));
    top.rotateX(-Math.PI / 2 + (s > 0 ? 1 : -1) * Math.atan2(1.0, skyHalf));
    top.translate(0, ridgeY + 1.6, (s * skyHalf) / 2);
    add('skylight', top, { glow: 0.6 });
  }
  for (const s of [-1, 1]) add('trim', box(0.3, ridgeY + 2.2 - skyBase, 2 * skyHalf + 0.3, (s * skyLen) / 2, skyBase, 0), { color: COL.trim });

  // ── Clock tower ──
  const T = (g: THREE.BufferGeometry) => {
    g.translate(tx, 0, tz);
    return g;
  };
  const addT: Add = (key, g, o) => add(key, T(g), o);
  const sh = 6; // shaft half width
  const shaftY0 = 12;
  const shaftY1 = 41;
  // Shaft walls with three stacked arched windows per face (real openings with glass behind).
  const shaftHoles = () => [archPath(0, 1.6, 18.6, 20.6, 10), archPath(0, 1.6, 26.0, 28.0, 10), archPath(0, 1.8, 33.2, 35.6, 10)];
  [0, Math.PI / 2, Math.PI, -Math.PI / 2].forEach((ry, k) => {
    const shrink = k % 2 === 1 ? 0.7 : 0;
    const wg = wall(-sh + shrink, sh - shrink, shaftY0, shaftY1, 0.7, shaftHoles());
    wg.rotateY(ry);
    const dir = new THREE.Vector3(0, 0, sh).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    wg.translate(dir.x, 0, dir.z);
    addT('stone', wg, { color: COL.stone });
    for (const [wy, ys, w] of [
      [18.6, 20.6, 1.6],
      [26.0, 28.0, 1.6],
      [33.2, 35.6, 1.8],
    ]) {
      const gl = new THREE.ShapeGeometry(new THREE.Shape(archPath(0, w, wy, ys, 10).getPoints()));
      gl.translate(0, 0, -0.45);
      gl.rotateY(ry);
      gl.translate(dir.x, 0, dir.z);
      addT('glass', gl, { glow: 0.5 });
      const av = archivolt(0, ys, w / 2, w / 2 + 0.2, 0.08, 10);
      av.rotateY(ry);
      av.translate(dir.x, 0, dir.z);
      addT('trim', av, { color: COL.trim });
    }
    // Raised panel frame: vertical strips and band courses.
    for (const sx of [-1, 1]) {
      const strip = box(0.9, shaftY1 - 16.5, 0.34, sx * 2.5, 16.5, sh + 0.17);
      strip.rotateY(ry);
      addT('trim', strip, { color: COL.trim });
    }
    for (const by of [17.4, 24.9, 32.2]) {
      const band = box(5.9, 0.4, 0.3, 0, by, sh + 0.15);
      band.rotateY(ry);
      addT('trim', band, { color: COL.trim });
    }
  });
  addT('dark', box(2 * sh - 1.6, shaftY1 - shaftY0, 2 * sh - 1.6, 0, shaftY0, 0), { color: COL.dark });
  // Rusticated corner piers.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) addT('rustic', box(1.5, shaftY1 - shaftY0, 1.5, sx * (sh - 0.6), shaftY0, sz * (sh - 0.6)), { color: COL.rustic });
  cornice(add, rect(sh + 0.1, sh + 0.1, tx, tz), shaftY1, 0.5, 0.8);

  // Clock stage.
  const cy0 = shaftY1 + 0.8;
  const cy1 = cy0 + 8.2;
  const ch = sh + 0.3;
  addT('stone', box(2 * ch, cy1 - cy0, 2 * ch, 0, cy0, 0), { color: COL.stone });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) addT('rustic', box(1.6, cy1 - cy0, 1.6, sx * (ch - 0.6), cy0, sz * (ch - 0.6)), { color: COL.rustic });
  const dialY = (cy0 + cy1) / 2 + 0.2;
  const dialR = 3.15;
  const dialTex = clockDial(512);
  const dials: { ry: number; n: THREE.Vector3 }[] = [];
  [0, Math.PI / 2, Math.PI, -Math.PI / 2].forEach((ry) => {
    const n = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    dials.push({ ry, n });
    const ring = new THREE.RingGeometry(dialR, dialR + 0.45, 48, 1);
    ring.translate(0, dialY, ch + 0.16);
    ring.applyMatrix4(new THREE.Matrix4().makeRotationY(ry));
    addT('trim', ring, { color: COL.trim });
    const rim = cyl(dialR + 0.45, dialR + 0.45, 0.16, 48, 0, 0, 0, true);
    rim.rotateX(Math.PI / 2);
    rim.translate(0, dialY, ch + 0.08);
    rim.applyMatrix4(new THREE.Matrix4().makeRotationY(ry));
    addT('trim', rim, { color: COL.trim });
    const dial = new THREE.CircleGeometry(dialR, 48);
    dial.translate(0, dialY, ch + 0.06);
    dial.applyMatrix4(new THREE.Matrix4().makeRotationY(ry));
    addT('dial', dial, { uv: 'keep', glow: 1 });
  });
  cornice(add, rect(ch, ch, tx, tz), cy1, 0.65, 0.9);
  balustradeRing(addT, ch + 0.15, 0, 0, cy1 + 0.9, 4.5);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) urn(addT, sx * (ch - 0.2), cy1 + 2.0, sz * (ch - 0.2), 1.1);

  // Belfry: three arches per side.
  const by0 = cy1 + 0.9;
  const by1 = by0 + 7.0;
  const bh = 4.9;
  arcadedStage(addT, 0, 0, bh, by0, by1, 3, 1.9, by0 + 4.3);
  cornice(add, rect(bh, bh, tx, tz), by1, 0.55, 0.75);
  balustradeRing(addT, bh + 0.1, 0, 0, by1 + 0.75, 3.3);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const ob = lathe(
        [
          [0.42, 0],
          [0.42, 0.5],
          [0.3, 0.6],
          [0.24, 1.6],
          [0.0, 2.3],
        ],
        4,
        sx * (bh - 0.1),
        by1 + 0.75,
        sz * (bh - 0.1),
        Math.PI / 4,
      );
      addT('trim', ob, { color: COL.trim });
    }
  }

  // Upper lantern: one large arch per side.
  const ly0 = by1 + 1.9;
  const ly1 = ly0 + 5.0;
  const lh = 3.6;
  arcadedStage(addT, 0, 0, lh, ly0, ly1, 1, 2.3, ly0 + 3.2);
  cornice(add, rect(lh, lh, tx, tz), ly1, 0.45, 0.6);

  // Octagonal drum, dome, finial.
  const dy0 = ly1 + 0.6;
  addT('stone', cyl(2.85, 2.95, 2.6, 8, 0, dy0, 0), { color: COL.stone });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const win = new THREE.ShapeGeometry(new THREE.Shape(archPath(0, 0.8, dy0 + 0.5, dy0 + 1.7, 8).getPoints()));
    win.translate(0, 0, 2.72);
    win.rotateY(a);
    addT('dark', win, { color: COL.dark, glow: 0.4 });
  }
  addT('trim', cyl(3.15, 3.15, 0.35, 8, 0, dy0 + 2.6, 0), { color: COL.trim });
  addT(
    'stone',
    lathe(
      [
        [3.0, 0],
        [2.95, 0.3],
        [2.75, 1.0],
        [2.35, 1.8],
        [1.7, 2.5],
        [0.9, 3.0],
        [0.5, 3.15],
      ],
      16,
      0,
      dy0 + 2.95,
      0,
    ),
    { color: COL.stone },
  );
  const fy = dy0 + 6.1;
  addT('trim', cyl(0.5, 0.6, 0.9, 8, 0, fy, 0), { color: COL.trim });
  addT('gold', lathe([[0.001, -0.45], [0.42, -0.25], [0.45, 0], [0.42, 0.25], [0.001, 0.45]], 12, 0, fy + 1.4, 0), { color: '#ffffff' });
  addT('bronze', cyl(0.04, 0.06, 2.4, 6, 0, fy + 1.8, 0));

  // ── Materials ──
  const towerTop = fy + 4;
  const warm = '#ffd2a0';
  const mats: Record<string, THREE.Material> = {
    stone: lmMaterial({ tex: 'ashlar', roughness: 0.9, weather: { baseY: main.baseElevation, grime: 0.3, mottle: 0.1 }, flood: { color: warm, intensity: 0.75, y0: main.baseElevation + 0.3, y1: main.baseElevation + towerTop, topScale: 1.3, stage: 7.2 } }),
    trim: lmMaterial({ tex: 'ashlar', roughness: 0.85, bump: 0.5, weather: { baseY: main.baseElevation, grime: 0.3, mottle: 0.1 }, flood: { color: warm, intensity: 0.8, y0: main.baseElevation + 0.3, y1: main.baseElevation + towerTop, topScale: 1.3, stage: 7.2 } }),
    rustic: lmMaterial({ tex: 'rustic', roughness: 0.92, bump: 1.2, weather: { baseY: main.baseElevation, grime: 0.3, mottle: 0.1 }, flood: { color: warm, intensity: 0.75, y0: main.baseElevation + 0.3, y1: main.baseElevation + towerTop, topScale: 1.3, stage: 7.2 } }),
    granite: lmMaterial({ tex: 'concrete', roughness: 0.8 }),
    roof: lmMaterial({ tex: 'slate', roughness: 0.75, metalness: 0.05 }),
    glass: lmMaterial({ tex: 'panes', metalness: 0.2, glow: '#ffb46a', glowIntensity: 2.2 }),
    skylight: lmMaterial({ tex: 'frosted', metalness: 0.1, glow: '#ffc890', glowIntensity: 1.4, side: THREE.DoubleSide }),
    dark: lmMaterial({ color: '#ffffff', roughness: 0.95, glow: '#ffb070', glowIntensity: 1.5 }),
    bronze: lmMaterial({ color: '#3a3128', roughness: 0.45, metalness: 0.7 }),
    gold: lmMaterial({ color: '#d4a640', roughness: 0.25, metalness: 1 }),
    dial: lmMaterial({ map: dialTex, roughness: 0.35, glow: '#fff1d6', glowIntensity: 1.3, glowAlbedo: true }),
  };
  const model = b.build(mats, 'ferry_building');

  // ── Lettering: opaque inscription panels (dark bronze letters by day, lit at night) ──
  const sign = signPanel('PORT OF SAN FRANCISCO', { bg: '#dcd2bd', fg: '#3b3226', shadow: 'rgba(255,250,240,0.6)', height: 128, spacing: 0.14, pad: 0.6 });
  const signMat = lmMaterial({
    map: sign.map,
    glowMask: sign.mask,
    roughness: 0.8,
    glow: '#fff4e0',
    glowIntensity: 3.2,
    vertexColors: false,
  });
  const addSign = (x: number, y: number, z: number, ry: number, signH: number) => {
    const signW = signH * sign.aspect;
    const g = new THREE.PlaneGeometry(signW, signH);
    g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(1), 1));
    const mesh = new THREE.Mesh(g, signMat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.receiveShadow = true;
    model.add(mesh);
  };
  const frameAt = (x: number, y: number, z: number, ry: number, signH: number) => {
    const signW = signH * sign.aspect;
    const fr = new THREE.Group();
    const pb = new PartBuilder();
    const t = 0.18;
    pb.add('trim', box(signW + 2 * t, t, 0.16, 0, -signH / 2 - t, -0.04), { color: COL.trim });
    pb.add('trim', box(signW + 2 * t, t, 0.16, 0, signH / 2, -0.04), { color: COL.trim });
    pb.add('trim', box(t, signH, 0.16, -signW / 2 - t / 2, -signH / 2, -0.04), { color: COL.trim });
    pb.add('trim', box(t, signH, 0.16, signW / 2 + t / 2, -signH / 2, -0.04), { color: COL.trim });
    fr.add(pb.build({ trim: mats.trim }, 'sign-frame'));
    fr.position.set(x, y, z);
    fr.rotation.y = ry;
    model.add(fr);
  };
  const westSignY = (Y.cornice + Y.attic) / 2;
  addSign(pavC[0], westSignY, pavZ + 0.02, 0, 2.0);
  frameAt(pavC[0], westSignY, pavZ + 0.02, 0, 2.0);
  addSign(tx, Y.cornice + 1.75, -HZ - 0.32, Math.PI, 2.5);
  frameAt(tx, Y.cornice + 1.75, -HZ - 0.32, Math.PI, 2.5);

  // ── Clock hands (instanced, follow the simulated local time) ──
  const hands = clockHands(
    dials.map((d) => ({
      centre: new THREE.Vector3(tx + d.n.x * (ch + 0.08), dialY, tz + d.n.z * (ch + 0.08)),
      normal: d.n,
      radius: dialR,
    })),
  );
  hands.set(env.ctx.env.timeOfDay);
  model.add(hands.mesh);

  const { pivot, inner } = makePivot('ferry_building', f, main.baseElevation);
  inner.add(model);
  const out: LandmarkBuild[] = [
    {
      name: 'ferry_building',
      pivot,
      buildingIds: recs.map((r) => r.id),
      update() {
        hands.set(env.ctx.env.timeOfDay);
      },
    },
  ];
  // The 1915 post office annex at the south end (same order and materials).
  const po = env.ctx.city.buildings.find((r) => !r.landmark && /ferry station post office/i.test(r.name ?? ''));
  if (po) out.push(buildPostOffice(po, mats));
  return out;
}

function polyArea(fp: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < fp.length; i++) {
    const [x0, z0] = fp[i];
    const [x1, z1] = fp[(i + 1) % fp.length];
    a += x0 * z1 - x1 * z0;
  }
  return Math.abs(a / 2);
}
