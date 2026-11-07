/**
 * Buildings module: every BuildingRecord as procedural, PBR-shaded architecture in three draw calls
 * (core facades with interior mapping, cheaper context-ring facades, and one prop mesh for roofs,
 * parapets, cornices, rooftop clutter, awnings, signs and fire escapes), all driven per building by
 * the state texture described in contracts.ts.
 */
import * as THREE from 'three';
import type { AppContext, BuildingDynamicState, BuildingsHandle } from '../../contracts';
import { buildCityGeometry, triBudget } from './geometry';
import { createDepthMaterial, createFacadeMaterial, createPropsMaterial, type SharedUniforms } from './materials';
import { ornamentStats } from './ornaments';
import { pickBuilding } from './pick';
import { BuildingStateStore } from './state';

export interface BuildingsStats {
  buildings: number;
  drawCalls: number;
  triangles: number;
  wallTriangles: number;
  propTriangles: number;
  buildMs: number;
}

export function createBuildings(ctx: AppContext): BuildingsHandle & { stats: BuildingsStats; uniforms: SharedUniforms; debug: unknown } {
  const records = ctx.city.buildings;
  const N = records.length;
  const geo = buildCityGeometry(records, ctx.city.roads, ctx.terrain);
  const store = new BuildingStateStore(N, geo.pivots, geo.styleData);
  const keepHidden = Uint8Array.from(records, (r) => (r.landmark ? 1 : 0));

  const uniforms: SharedUniforms = {
    uState: { value: store.stateTex },
    uStyle: { value: store.styleTex },
    uOverlay: { value: store.overlayTex },
    uHighlight: { value: -1 },
    uDamageOverlay: { value: 0 },
    uNight: { value: ctx.env.nightFactor },
    uDayLevel: { value: 0.1 },
    uHour: { value: ctx.env.timeOfDay },
    uLightLevel: { value: 1.45 },
    uTime: { value: 0 },
  };

  const object = new THREE.Group();
  object.name = 'buildings';
  const depth = createDepthMaterial(uniforms, false);
  const propsDepth = createDepthMaterial(uniforms, true);
  const dist = createDepthMaterial(uniforms, false, true);
  const propsDist = createDepthMaterial(uniforms, true, true);
  const addMesh = (g: THREE.BufferGeometry, mat: THREE.Material, d: THREE.Material, name: string) => {
    if (!g.index || g.index.count === 0) return null;
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    m.customDepthMaterial = d;
    m.customDistanceMaterial = d === propsDepth ? propsDist : dist;
    // Shake / tilt move vertices a little beyond the static bounds.
    if (g.boundingSphere) g.boundingSphere.radius += 30;
    object.add(m);
    return m;
  };
  addMesh(geo.wallsCore, createFacadeMaterial(uniforms, false), depth, 'buildingWallsCore');
  addMesh(geo.wallsContext, createFacadeMaterial(uniforms, true), depth, 'buildingWallsContext');
  addMesh(geo.props, createPropsMaterial(uniforms), depth, 'buildingProps');
  // Alpha-cut railings last: keeps discard out of the big opaque meshes (tile-based GPUs keep HSR).
  const rail = addMesh(geo.railings, createPropsMaterial(uniforms, true), propsDepth, 'buildingRailings');
  if (rail) rail.renderOrder = 1;

  const stats: BuildingsStats = {
    buildings: N,
    drawCalls: object.children.length,
    triangles: geo.stats.wallTris + geo.stats.propTris,
    wallTriangles: geo.stats.wallTris,
    propTriangles: geo.stats.propTris,
    buildMs: Math.round(geo.stats.ms),
  };
  console.info(`[buildings] ${N} buildings, ${stats.drawCalls} draw calls (+${stats.drawCalls} shadow), ${(stats.triangles / 1000).toFixed(0)}k tris (walls ${(stats.wallTriangles / 1000).toFixed(0)}k, props ${(stats.propTriangles / 1000).toFixed(0)}k), built in ${stats.buildMs} ms; ornaments: ${ornamentStats.corniceSegs} cornice segs, ${ornamentStats.beltSegs} belt segs, ${ornamentStats.bays} bays on ${ornamentStats.bayBuildings} buildings; prop tris: ornaments ${(triBudget.ornaments / 1000).toFixed(0)}k, roofs ${(triBudget.roof / 1000).toFixed(0)}k, clutter ${(triBudget.props / 1000).toFixed(0)}k`);

  // Environment → shader uniforms (read every frame so it also follows engine-internal changes).
  const syncEnv = () => {
    const env = ctx.env;
    uniforms.uNight.value = env.nightFactor;
    uniforms.uHour.value = env.timeOfDay;
    const sunUp = THREE.MathUtils.clamp(env.sunDirection.y * 3, 0, 1);
    uniforms.uDayLevel.value = 0.09 * (1 - env.nightFactor) * (0.35 + 0.65 * sunUp);
  };
  syncEnv();
  ctx.events.on('environment-changed', syncEnv);
  ctx.onUpdate((_dt, elapsed) => {
    uniforms.uTime.value = elapsed;
    syncEnv();
    if (overlayDirty) {
      store.commit();
      overlayDirty = false;
    }
  });

  const tmpColor = new THREE.Color();
  // Overlay uploads are batched: many setOverlayColor calls → one texture upload next frame.
  let overlayDirty = false;
  const ids = new Map<string, number>();
  records.forEach((b, i) => ids.set(b.id, i));

  const handle: BuildingsHandle & { stats: BuildingsStats; uniforms: SharedUniforms; debug: unknown } = {
    object,
    count: N,
    stats,
    uniforms,
    debug: { ornamentStats, geo },
    indexOf: (id) => ids.get(id) ?? -1,
    setState: (i: number, s: BuildingDynamicState) => store.set(i, s),
    getState: (i: number) => store.get(i),
    resetAll() {
      store.resetAll(keepHidden);
      store.commit();
    },
    commit: () => store.commit(),
    setDamageOverlay(on) {
      uniforms.uDamageOverlay.value = on ? 1 : 0;
    },
    setOverlayColor(i, rgb) {
      // Callers pick display (sRGB) colours; shading works in linear space.
      if (rgb) {
        tmpColor.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
        store.setOverlay(i, [tmpColor.r, tmpColor.g, tmpColor.b]);
      } else store.setOverlay(i, null);
      overlayDirty = true;
    },
    setVeil(i, amount) {
      store.setVeil(i, amount);
      overlayDirty = true;
    },
    setHighlight(id) {
      uniforms.uHighlight.value = id ? (ids.get(id) ?? -1) : -1;
    },
    pick(raycaster) {
      const i = pickBuilding(raycaster.ray, object, geo, store);
      return i >= 0 ? records[i].id : null;
    },
  };
  return handle;
}
