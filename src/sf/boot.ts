/**
 * San Francisco: the Ferry Building / Financial District city from argus, rendered by argus's own
 * engine (physical sky, sun + shadow map, IBL, bay water, distant backdrop, n8ao post chain).
 * Mirrors argus's boot (data -> engine -> streets -> buildings -> landmarks) without the
 * earthquake, rescue or UI layers.
 *
 * Frame: +X east, +Y up (metres NAVD88, bay water plane at y = 0), +Z south. geo.ts `project`
 * maps lat/lon to x/z around 37.7935, -122.398.
 *
 * Order inside one frame: the camera driver (Engine.setCameraDriver), then the city's own
 * per-frame updates, then the onFrame subscribers, then the engine (shadow fit, water, sky) and
 * the post chain.
 */
import { Group } from 'three';
import { createBuildings } from './argus/city/buildings';
import { createLandmarks } from './argus/city/landmarks';
import { createStreets } from './argus/city/streets';
import type {
  AppContext,
  BuildingsHandle,
  CityData,
  Engine,
  Heightfield,
  LandmarksHandle,
  StreetsHandle,
  UpdateFn,
} from './argus/contracts';
import { createEngine } from './argus/engine';
import { createEventBus } from './argus/events';
import { loadHeightfield } from './argus/terrain/heightfield';

/** where public/sf is served from */
const DATA_BASE = '/sf/data';
/** local hours the city boots at (PST on 2026-11-07, the same clock as Flytake's time-of-day slider) */
export const SF_TIME_DEFAULT = 15;

export interface SfCity {
  readonly engine: Engine;
  /** what argus modules share: scene, camera, renderer, city data, terrain, env, events */
  readonly ctx: AppContext;
  readonly city: CityData;
  /** terrain + bathymetry sampler (y metres NAVD88; land >= 1.6, water <= -1.5) */
  readonly terrain: Heightfield;
  readonly streets: StreetsHandle;
  readonly buildings: BuildingsHandle;
  readonly landmarks: LandmarksHandle;
  /** all city geometry (ground, streets, buildings, landmarks incl. the Bay Bridge and piers) */
  readonly cityRoot: Group;
  /** per-frame callback (dt s, elapsed s), after the camera driver and the city updates */
  onFrame(fn: UpdateFn): () => void;
  setTimeOfDay(hours: number): void;
  dispose(): void;
}

export type SfProgress = (label: string, fraction: number) => void;

async function loadCity(): Promise<CityData> {
  const res = await fetch(`${DATA_BASE}/city.json`);
  if (!res.ok) throw new Error(`${DATA_BASE}/city.json missing (${res.status})`);
  return (await res.json()) as CityData;
}

/** Let the browser paint the loading screen between the synchronous build steps. */
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** One city per container: React StrictMode mounts effects twice in dev. */
const booted = new WeakMap<HTMLElement, Promise<SfCity>>();

export function bootSfCity(container: HTMLElement, onProgress?: SfProgress): Promise<SfCity> {
  const existing = booted.get(container);
  if (existing != null) return existing;
  const city = build(container, onProgress ?? (() => {}));
  booted.set(container, city);
  // A failed boot may be retried.
  city.catch(() => booted.delete(container));
  return city;
}

async function build(container: HTMLElement, progress: SfProgress): Promise<SfCity> {
  progress('Loading San Francisco', 0.05);
  const [city, terrain] = await Promise.all([loadCity(), loadHeightfield(DATA_BASE)]);

  progress('Lighting the sky', 0.3);
  await nextPaint();
  const events = createEventBus();
  const engine = createEngine(container);
  engine.setGroundHeightSampler?.((x, z) => terrain.heightAt(x, z));
  const cityRoot = new Group();
  cityRoot.name = 'cityRoot';
  engine.scene.add(cityRoot);

  const updates = new Set<UpdateFn>();
  const ctx: AppContext = {
    scene: engine.scene,
    camera: engine.camera,
    renderer: engine.renderer,
    cityRoot,
    city,
    terrain,
    env: engine.env,
    events,
    onUpdate(fn) {
      updates.add(fn);
      return () => updates.delete(fn);
    },
  };

  progress('Paving streets', 0.4);
  await nextPaint();
  const streets = createStreets(ctx);
  cityRoot.add(streets.object);

  progress(`Raising ${city.buildings.length.toLocaleString('en-US')} buildings`, 0.7);
  await nextPaint();
  const buildings = createBuildings(ctx);
  cityRoot.add(buildings.object);

  progress('Placing landmarks', 0.85);
  await nextPaint();
  const landmarks = createLandmarks(ctx, buildings);
  cityRoot.add(landmarks.object);

  const subscribers = new Set<UpdateFn>();
  engine.start(events, (dt, elapsed) => {
    updates.forEach((fn) => fn(dt, elapsed));
    subscribers.forEach((fn) => fn(dt, elapsed));
  });
  // After start(): the bus is wired, so the city hears 'environment-changed'.
  engine.setTimeOfDay(SF_TIME_DEFAULT);
  progress('Ready', 1);

  return {
    engine,
    ctx,
    city,
    terrain,
    streets,
    buildings,
    landmarks,
    cityRoot,
    onFrame(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    setTimeOfDay(hours) {
      engine.setTimeOfDay(hours);
    },
    dispose() {
      subscribers.clear();
      updates.clear();
      engine.dispose();
      booted.delete(container);
    },
  };
}
