/**
 * Low-poly silhouettes of the landmarks on the horizon: Golden Gate Bridge (International Orange,
 * catenary main cables, deck lights at night), Alcatraz (see alcatraz.ts) and Sutro Tower
 * (red/white, blinking aviation lights). Sized from real dimensions.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { project } from '../../geo';
import type { Rect } from './farTerrain';
import { buildAlcatraz, createAlcatrazMaterial } from './alcatraz';

export interface DistantLandmarks {
  group: THREE.Group;
  setNight(night: number, exposure: number): void;
  update(elapsed: number): void;
}

const ORANGE = new THREE.Color().setRGB(0.5, 0.06, 0.03); // International Orange (linear)

function box(w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

function colored(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.index) return g.toNonIndexed();
  return g;
}

/** Golden Gate Bridge geometry in world space + its night light positions. */
function goldenGate(): { geo: THREE.BufferGeometry; lamps: number[]; beacons: number[] } {
  const [sx, sz] = project(37.8077, -122.475);
  const [nx, nz] = project(37.8327, -122.4797);
  const ax = new THREE.Vector3(nx - sx, 0, nz - sz);
  const len = ax.length();
  ax.normalize();
  const side = new THREE.Vector3(-ax.z, 0, ax.x);
  const rot = Math.atan2(-ax.x, -ax.z); // yaw so local -Z points along the axis
  const at = (t: number, y: number, s = 0) =>
    new THREE.Vector3(sx + ax.x * len * t + side.x * s, y, sz + ax.z * len * t + side.z * s);
  const parts: THREE.BufferGeometry[] = [];
  const deckY = 67;
  const halfW = 13.5;
  const towers = [0.33, 0.79];
  // Deck (main span + side spans), sloping approach viaducts at both ends.
  const deck = box(27, 7.5, len * 0.82, 0, 0, 0);
  const mid = at(0.56, deckY);
  deck.rotateY(rot);
  deck.translate(mid.x, mid.y, mid.z);
  parts.push(colored(deck, ORANGE));
  for (const t of towers) {
    const base = at(t, 0);
    // Two tapered legs + portal struts.
    for (const s of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(4.2, 6.5, 227, 4, 1);
      leg.rotateY(Math.PI / 4 + rot);
      leg.scale(1, 1, 1);
      const p = at(t, 113.5, s * halfW);
      leg.translate(p.x, p.y, p.z);
      parts.push(colored(leg, ORANGE));
    }
    for (const y of [deckY + 30, 140, 175, 214]) {
      const strut = box(2 * halfW, 7, 5, 0, 0, 0);
      strut.rotateY(rot);
      const p = at(t, y);
      strut.translate(p.x, p.y, p.z);
      parts.push(colored(strut, ORANGE));
    }
    // Pier at the waterline.
    const pier = box(48, 18, 30, 0, 0, 0);
    pier.rotateY(rot);
    pier.translate(base.x, 6, base.z);
    parts.push(colored(pier, new THREE.Color(0.28, 0.27, 0.25)));
  }
  // Main cables: anchorage → tower → parabolic sag → tower → anchorage.
  const cablePts = (s: number) => {
    const pts: THREE.Vector3[] = [];
    const [t0, t1] = towers;
    const top = 222;
    const sag = deckY + 6;
    for (let i = 0; i <= 12; i++) pts.push(at(0.08 + ((t0 - 0.08) * i) / 12, 40 + (top - 40) * Math.pow(i / 12, 1.25), s));
    for (let i = 1; i <= 40; i++) {
      const u = i / 40;
      pts.push(at(t0 + (t1 - t0) * u, sag + (top - sag) * Math.pow(2 * u - 1, 2), s));
    }
    for (let i = 1; i <= 12; i++) pts.push(at(t1 + ((0.97 - t1) * i) / 12, top - (top - 40) * Math.pow(i / 12, 0.8), s));
    return pts;
  };
  for (const s of [-halfW, halfW]) {
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cablePts(s)), 140, 1.6, 4, false);
    parts.push(colored(tube, ORANGE));
  }
  const lamps: number[] = [];
  for (let i = 0; i <= 64; i++) {
    for (const s of [-halfW, halfW]) {
      const p = at(0.1 + (0.86 * i) / 64, deckY + 6, s);
      lamps.push(p.x, p.y, p.z);
    }
  }
  const beacons: number[] = [];
  for (const t of towers) for (const s of [-halfW, halfW]) {
    const p = at(t, 229, s);
    beacons.push(p.x, p.y, p.z);
  }
  const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false)!;
  geo.computeVertexNormals();
  return { geo, lamps, beacons };
}

/** Sutro Tower: 3 legs from a 50 m triangle, converging, with crossbars; mast top at ~550 m ASL. */
function sutro(ground: (x: number, z: number) => number): { geo: THREE.BufferGeometry; beacons: number[] } {
  const [cx, cz] = project(37.7552, -122.4528);
  const base = Math.max(ground(cx, cz), 250);
  const parts: THREE.BufferGeometry[] = [];
  const red = new THREE.Color(0.55, 0.06, 0.04);
  const white = new THREE.Color(0.75, 0.75, 0.73);
  const H = 298;
  const legTop = 0.62;
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const bx = cx + Math.cos(a) * 30;
    const bz = cz + Math.sin(a) * 30;
    const tx = cx + Math.cos(a) * 9;
    const tz = cz + Math.sin(a) * 9;
    // Leg as banded segments (red/white).
    const n = 7;
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      const p0 = new THREE.Vector3(bx + (tx - bx) * t0, base + H * legTop * t0, bz + (tz - bz) * t0);
      const p1 = new THREE.Vector3(bx + (tx - bx) * t1, base + H * legTop * t1, bz + (tz - bz) * t1);
      const seg = new THREE.CylinderGeometry(1.6, 2.2, p0.distanceTo(p1), 5);
      seg.translate(0, p0.distanceTo(p1) / 2, 0);
      const dir = p1.clone().sub(p0).normalize();
      seg.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      seg.translate(p0.x, p0.y, p0.z);
      parts.push(colored(seg, i % 2 ? white : red));
    }
    // Upper mast leg.
    const up = new THREE.CylinderGeometry(1.1, 1.5, H * (1 - legTop), 5);
    up.translate(tx, base + H * legTop + (H * (1 - legTop)) / 2, tz);
    parts.push(colored(up, k % 2 ? red : white));
  }
  for (const f of [0.33, 0.62, 0.9]) {
    const r = 30 + (9 - 30) * Math.min(f / legTop, 1);
    const ring = new THREE.TorusGeometry(r * 0.75, 1.4, 3, 3);
    ring.rotateX(Math.PI / 2);
    ring.translate(cx, base + H * f, cz);
    parts.push(colored(ring, red));
  }
  const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false)!;
  geo.computeVertexNormals();
  const beacons: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    beacons.push(cx + Math.cos(a) * 9, base + H + 2, cz + Math.sin(a) * 9);
  }
  return { geo, beacons };
}

function pointsMaterial(color: THREE.Color, size: number): THREE.PointsMaterial {
  return new THREE.PointsMaterial({ color, size, sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
}

export function buildDistantLandmarks(_rect: Rect, ground: (x: number, z: number) => number): DistantLandmarks {
  const group = new THREE.Group();
  group.name = 'distantLandmarks';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.0 });
  const gg = goldenGate();
  const al = buildAlcatraz();
  const st = sutro(ground);
  for (const [name, geo] of [
    ['goldenGate', gg.geo],
    ['alcatraz', al.geo],
    ['sutroTower', st.geo],
  ] as const) {
    const m = new THREE.Mesh(geo, name === 'alcatraz' ? createAlcatrazMaterial() : mat);
    m.name = name;
    m.castShadow = name === 'alcatraz';
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  // Night lights: sodium deck lamps on the bridge, red aviation beacons, Alcatraz lighthouse.
  const lampGeo = new THREE.BufferGeometry();
  lampGeo.setAttribute('position', new THREE.Float32BufferAttribute(gg.lamps, 3));
  const lampMat = pointsMaterial(new THREE.Color(1.0, 0.62, 0.25), 1.5);
  const lamps = new THREE.Points(lampGeo, lampMat);
  lamps.frustumCulled = false;
  const beaconGeo = new THREE.BufferGeometry();
  beaconGeo.setAttribute('position', new THREE.Float32BufferAttribute([...gg.beacons, ...st.beacons], 3));
  const beaconMat = pointsMaterial(new THREE.Color(1.0, 0.08, 0.04), 3.5);
  const beacons = new THREE.Points(beaconGeo, beaconMat);
  beacons.frustumCulled = false;
  const lhGeo = new THREE.BufferGeometry();
  lhGeo.setAttribute('position', new THREE.Float32BufferAttribute(al.lamp, 3));
  const lhMat = pointsMaterial(new THREE.Color(1.0, 0.95, 0.8), 4);
  const lighthouse = new THREE.Points(lhGeo, lhMat);
  lighthouse.frustumCulled = false;
  group.add(lamps, beacons, lighthouse);
  let nightK = 0;
  let expo = 1;
  return {
    group,
    setNight(night, exposure) {
      nightK = night;
      expo = exposure;
      lamps.visible = beacons.visible = lighthouse.visible = night > 0.05;
    },
    update(elapsed) {
      if (nightK <= 0.05) return;
      const k = (nightK * 2.2) / expo;
      lampMat.color.setRGB(1.0, 0.62, 0.25).multiplyScalar(k);
      const blink = Math.sin(elapsed * Math.PI * 0.9) > 0.2 ? 1 : 0.05;
      beaconMat.color.setRGB(1.0, 0.08, 0.04).multiplyScalar(k * 1.6 * blink);
      const sweep = Math.pow(Math.max(0, Math.sin(elapsed * 1.3)), 8);
      lhMat.color.setRGB(1.0, 0.95, 0.8).multiplyScalar(k * (0.4 + 3 * sweep));
    },
  };
}
