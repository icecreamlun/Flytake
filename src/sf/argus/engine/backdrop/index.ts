/**
 * Distant world beyond the data: far ground ring (rest of SF, Marin, East Bay, islands) and
 * low-poly landmark silhouettes. Everything is fogged by the shared aerial perspective.
 */
import * as THREE from 'three';
import { buildFarTerrain, type FarTerrain, type Rect } from './farTerrain';
import { buildDistantLandmarks, type DistantLandmarks } from './landmarks';
import { buildFillerCity, type FillerCity } from './filler';
import { buildCityLights, type CityLights } from './cityLights';

export interface Backdrop {
  group: THREE.Group;
  setNight(nightFactor: number, exposure: number): void;
  update(elapsed: number): void;
}

export interface BackdropOptions {
  /** Terrain grid extent (the far ring starts here). */
  rect: Rect;
  ground: (x: number, z: number) => number;
  /** Area already covered by real city data — filler buildings stay outside it. */
  dataRect: Rect;
}

export function buildBackdrop(opts: BackdropOptions): Backdrop {
  const group = new THREE.Group();
  group.name = 'backdrop';
  const t0 = performance.now();
  const far: FarTerrain = buildFarTerrain(opts.rect, opts.ground);
  group.add(far.mesh);
  const t1 = performance.now();
  const marks: DistantLandmarks = buildDistantLandmarks(opts.rect, opts.ground);
  group.add(marks.group);
  const t2 = performance.now();
  const filler: FillerCity = buildFillerCity(opts.rect, opts.dataRect, opts.ground);
  group.add(filler.mesh);
  const t3 = performance.now();
  const lights: CityLights = buildCityLights(opts.rect, opts.dataRect, opts.ground);
  group.add(lights.points);
  group.userData.buildMs = {
    farTerrain: Math.round(t1 - t0),
    landmarks: Math.round(t2 - t1),
    filler: Math.round(t3 - t2),
    cityLights: Math.round(performance.now() - t3),
    lightPoints: lights.points.geometry.getAttribute('position').count,
  };
  return {
    group,
    setNight(night, exposure) {
      // Emissive city lights in scene-referred units: scale against exposure so they read the same.
      const k = (night * 1.2) / Math.max(exposure, 1e-3);
      far.setNight(k);
      filler.setNight(k, night);
      lights.setNight(night, exposure);
      marks.setNight(night, exposure);
    },
    update(elapsed) {
      marks.update(elapsed);
    },
  };
}
