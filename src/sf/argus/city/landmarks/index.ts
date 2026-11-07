/**
 * Landmarks: hand-built models of San Francisco icons, placed on their real footprints/coordinates.
 * Each model replaces its generic OSM extrusion (hidden via the buildings state buffer) and is exposed
 * through objectForBuilding() as a pivot group at its base centre so quake FX can shake / tilt it.
 *
 * Night lighting: every landmark material shares uLmNight = nightFactor / exposure (× power), so emissive
 * features keep a constant display brightness under the engine's auto-exposure.
 *
 * Overlays & damage: each build gets a state slot (common/state.ts) tied to its city.json building(s).
 * Damage / crush are read back from the buildings state buffer (quake FX writes it for every building,
 * replaced ones included); ShakeMap tints and the damage-overlay toggle are mirrored from the calls quake FX
 * makes on the buildings handle, so landmarks follow every data view without FX knowing about them.
 */
import * as THREE from 'three';
import type { AppContext, BuildingRecord, BuildingsHandle, LandmarkId, LandmarksHandle, RoadRecord } from '../../contracts';
import { lmUniforms } from './common/materials';
import { LandmarkStateStore, lmStateUniforms } from './common/state';
import type { LandmarkBuild, LandmarkEnv } from './common/types';
import { buildFerryBuilding } from './ferryBuilding';
import { buildTransamerica } from './transamerica';
import { buildDragonGate } from './chinatown/dragonGate';
import { buildLanterns } from './chinatown/lanterns';
import { buildBayBridge } from './bayBridge';
import { buildSentinel } from './sentinel';
import { buildCoitTower } from './coitTower';
import { buildOldStMarys } from './oldStMarys';
import { buildPierSheds } from './piers';
import { CITY_ORIGIN, haversineKm } from '../../geo';

type Builder = (env: LandmarkEnv) => LandmarkBuild | LandmarkBuild[] | null;

const BUILDERS: [string, Builder][] = [
  ['ferry_building', buildFerryBuilding],
  ['transamerica_pyramid', buildTransamerica],
  ['chinatown_gate', buildDragonGate],
  ['grant_lanterns', buildLanterns],
  ['bay_bridge', buildBayBridge],
  ['sentinel_building', buildSentinel],
  ['coit_tower', buildCoitTower],
  ['old_st_marys', buildOldStMarys],
  ['pier_sheds', buildPierSheds],
];

export function createLandmarks(ctx: AppContext, buildings: BuildingsHandle): LandmarksHandle {
  const object = new THREE.Group();
  object.name = 'landmarks';

  const byLm = new Map<LandmarkId, BuildingRecord[]>();
  const byId = new Map<string, BuildingRecord>();
  for (const b of ctx.city.buildings) {
    byId.set(b.id, b);
    if (b.landmark) {
      let l = byLm.get(b.landmark);
      if (!l) byLm.set(b.landmark, (l = []));
      l.push(b);
    }
  }
  const roadsByName = new Map<string, RoadRecord[]>();
  for (const r of ctx.city.roads) {
    if (!r.name) continue;
    let l = roadsByName.get(r.name);
    if (!l) roadsByName.set(r.name, (l = []));
    l.push(r);
  }
  const env: LandmarkEnv = {
    ctx,
    ground: (x, z) => ctx.terrain.heightAt(x, z),
    byLandmark: (id) => byLm.get(id) ?? [],
    byId: (id) => byId.get(id),
    roadsNamed: (name) => roadsByName.get(name) ?? [],
  };

  const results: LandmarkBuild[] = [];
  for (const [name, fn] of BUILDERS) {
    try {
      const t0 = performance.now();
      const r = fn(env);
      const list = r ? (Array.isArray(r) ? r : [r]) : [];
      results.push(...list);
      if (import.meta.env.DEV) console.debug(`[landmarks] ${name}: ${(performance.now() - t0).toFixed(0)} ms`);
    } catch (err) {
      console.error(`[landmarks] failed to build ${name}`, err);
    }
  }

  const byBuilding = new Map<string, THREE.Object3D>();
  const replaced: string[] = [];
  for (const r of results) {
    object.add(r.pivot);
    if (r.statics) object.add(r.statics);
    // 'translate' builds hand FX a detached proxy (its rocking is ignored); see syncDamage().
    const proxy = r.motion === 'translate' ? new THREE.Object3D() : null;
    for (const id of r.buildingIds) {
      if (byBuilding.has(id)) continue;
      byBuilding.set(id, proxy ?? r.objectFor?.[id] ?? r.pivot);
      replaced.push(id);
    }
    for (const id of r.attachedIds ?? []) if (!byBuilding.has(id)) byBuilding.set(id, proxy ?? r.pivot);
  }
  const replacedIdx = replaced.map((id) => buildings.indexOf(id)).filter((i) => i >= 0);

  // ── State slots: one per build, tied to its replaced (else attached) buildings ──
  const store = new LandmarkStateStore();
  const slots: { slot: number; idx: number[]; build: LandmarkBuild; last: number; p0: THREE.Vector3 }[] = [];
  const slotOfPrimary = new Map<number, number>();
  const area = (b: BuildingRecord) => {
    let a = 0;
    const f = b.footprint;
    for (let i = 0; i < f.length; i++) a += f[i][0] * f[(i + 1) % f.length][1] - f[(i + 1) % f.length][0] * f[i][1];
    return Math.abs(a) / 2;
  };
  for (const r of results) {
    const ids = r.buildingIds.length ? r.buildingIds : (r.attachedIds ?? []);
    const idx = ids.map((id) => buildings.indexOf(id)).filter((i) => i >= 0);
    let slot = 0;
    if (idx.length) {
      // Overlay colour follows the largest footprint (what the inspector shows when it is clicked).
      const primary = idx.reduce((a, b) => (area(ctx.city.buildings[b]) > area(ctx.city.buildings[a]) ? b : a));
      slot = store.alloc((primary * 0.61803) % 1);
      if (slot > 0) {
        for (const i of idx) if (!slotOfPrimary.has(i) && i === primary) slotOfPrimary.set(i, slot);
        // Primary first: 'translate' builds follow its roof drift.
        slots.push({ slot, idx: [primary, ...idx.filter((i) => i !== primary)], build: r, last: 0, p0: r.pivot.position.clone() });
      }
    }
    tagSlot(r.pivot, slot);
    if (r.statics) tagSlot(r.statics, slot);
  }
  store.commit();

  // Mirror quake FX's overlay calls on the buildings handle (decorate the handle in place).
  const tmpCol = new THREE.Color();
  const origSetOverlay = buildings.setOverlayColor.bind(buildings);
  const origSetDamageOverlay = buildings.setDamageOverlay.bind(buildings);
  const mirrorOverlay = (i: number, rgb: [number, number, number] | null) => {
    const s = slotOfPrimary.get(i);
    if (s === undefined) return;
    // Same convention as the buildings module: callers pass display (sRGB) colours.
    if (rgb) {
      tmpCol.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      store.setOverlay(s, [tmpCol.r, tmpCol.g, tmpCol.b]);
    } else store.setOverlay(s, null);
  };
  const mirrorDamageOverlay = (on: boolean) => (lmStateUniforms.uLmDamageOverlay.value = on ? 1 : 0);
  buildings.setOverlayColor = (i, rgb) => {
    origSetOverlay(i, rgb);
    mirrorOverlay(i, rgb);
  };
  buildings.setDamageOverlay = (on) => {
    origSetDamageOverlay(on);
    mirrorDamageOverlay(on);
  };
  const hideReplaced = () => {
    for (const i of replacedIdx) buildings.setState(i, { hidden: 1 });
    buildings.commit();
  };
  hideReplaced();
  // A quake reset may restore every building's state; re-hide on the next frame.
  let rehide = false;
  ctx.events.on('quake-reset', () => (rehide = true));

  // Approximate local shaking envelope from the quake events (drives lantern swing etc.).
  let quake: { tS: number; dur: number; amp: number } | null = null;
  let simT = 0;
  ctx.events.on('quake-started', ({ event }) => {
    const [lon, lat, depth] = event.geometry.coordinates;
    const R = Math.hypot(haversineKm(lat, lon, CITY_ORIGIN.lat, CITY_ORIGIN.lon), depth);
    const M = event.properties.mag;
    quake = {
      tS: R / 3.5,
      dur: 6 + 4 * Math.pow(10, 0.4 * (M - 5)),
      amp: THREE.MathUtils.clamp((M - 4.5) / 3, 0, 1) * THREE.MathUtils.clamp(40 / (R + 20), 0.15, 1),
    };
    simT = 0;
  });
  ctx.events.on('quake-tick', ({ simSeconds }) => (simT = simSeconds));
  ctx.events.on('quake-reset', () => (quake = null));
  const shakeAt = (t: number) => {
    if (!quake) return 0;
    const { tS, dur, amp } = quake;
    if (t < tS * 0.58) return 0;
    if (t < tS) return amp * 0.15; // P-wave rattle
    const rise = Math.min(1, (t - tS) / 2);
    const decay = Math.exp(-Math.max(0, t - tS - dur * 0.5) / (dur * 0.35));
    return amp * rise * decay;
  };

  // Damage read-back (quake FX → buildings state buffer → landmark slots + partial-collapse hooks).
  let lastSimT = 0;
  const syncDamage = (dt: number) => {
    const jumped = Math.abs(simT - lastSimT) > 1.5;
    lastSimT = simT;
    for (const s of slots) {
      let dmg = 0;
      let crush = 0;
      for (let k = 0; k < s.idx.length; k++) {
        const st = buildings.getState(s.idx[k]);
        dmg = Math.max(dmg, st.damage);
        crush = Math.max(crush, st.crush);
        if (k === 0 && s.build.motion === 'translate') {
          // Whole-body drift ≈ 60 % of the roof displacement (no see-saw on a 200 m shed).
          const pv = s.build.pivot;
          pv.position.set(s.p0.x + st.shakeX * 0.6, s.p0.y, s.p0.z + st.shakeZ * 0.6);
          pv.scale.y = Math.max(0.02, 1 - st.crush);
        }
      }
      store.setDamage(s.slot, dmg, crush);
      s.build.onDamage?.(dmg, jumped || Math.abs(dmg - s.last) > 1.5, dt);
      s.last = dmg;
    }
    store.commit();
  };

  let powerOut = 0;
  let frame = 0;
  ctx.onUpdate((dt, elapsed) => {
    syncDamage(dt);
    const exposure = Math.max(ctx.renderer.toneMappingExposure || 1, 1e-3);
    lmUniforms.uLmNight.value = (ctx.env.nightFactor / exposure) * (1 - powerOut);
    lmUniforms.uLmTime.value = elapsed;
    lmUniforms.uLmShake.value = shakeAt(simT);
    for (const r of results) r.update?.(dt, elapsed);
    // Cheap watchdog: if someone reset the state buffer, hide the replaced extrusions again.
    if (rehide || (++frame % 60 === 0 && replacedIdx.length && buildings.getState(replacedIdx[0]).hidden < 0.5)) {
      rehide = false;
      hideReplaced();
    }
  });

  return {
    object,
    objectForBuilding: (id) => byBuilding.get(id) ?? null,
    replacedBuildingIds: replaced,
    setPowerOut(amount: number) {
      powerOut = THREE.MathUtils.clamp(amount, 0, 1);
    },
    setOverlayColor: mirrorOverlay,
    setDamageOverlay: mirrorDamageOverlay,
  };
}

/** Stamp every landmark geometry under `root` with its state slot (`aLmSlot`, see materials.ts). */
function tagSlot(root: THREE.Object3D, slot: number): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    if (!pos) return;
    if (g.userData.lmSlot !== undefined && g.userData.lmSlot !== slot) {
      // Geometry shared with another landmark: give this mesh its own copy.
      g = g.clone();
      mesh.geometry = g;
    }
    g.userData.lmSlot = slot;
    g.setAttribute('aLmSlot', new THREE.BufferAttribute(new Float32Array(pos.count).fill(slot), 1));
  });
}
