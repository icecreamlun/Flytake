import { FLIGHT_DURATION } from './camera/timeline';
import { runtime, tileStats, tilesLoading } from './scene/runtime';
import { WATER_UNIFORMS } from './scene/water';
import { surfaceHeightAt } from './drone/DroneSim';
import { useFlytake, type Phase } from './state/store';
import { world } from './world/handles';
import { SCENE_LIGHT } from './world/light';
import { useSun } from './world/sun';
import { Raycaster, Vector3 } from 'three';
import { SCENE_FRAME, fromSceneEnu } from './world/scene';

/**
 * Automation hooks for screenshot checks (Playwright etc.):
 *   window.__flytake.state         current phase: loading | start | flying | arrived | free
 *   window.__flytake.progress      flight progress 0..1 (frozen value when ?t= / jump())
 *   window.__flytake.tilesLoading  true while tiles are queued / downloading / parsing
 *   window.__flytake.jump(t)       freeze the flight at fraction t (1 = arrival pose, held)
 *   window.__flytake.fly() / replay() / handoff() / stats()
 *   window.__flytake.enterDrone() / exitDrone() / drone()   drone mode + telemetry snapshot
 */
export interface FlytakeDebug {
  readonly state: Phase;
  readonly progress: number;
  readonly tilesLoading: boolean;
  jump(t: number): void;
  fly(): void;
  replay(): void;
  handoff(): void;
  stats(): Record<string, unknown>;
  enterDrone(): void;
  exitDrone(): void;
  drone(): Record<string, unknown> | null;
  /** ellipsoidal height of the loaded tiles at lat/lon (null if nothing loaded there) */
  surfaceAt(lat: number, lon: number): number | null;
  /** live three.js objects, for inspection from the devtools console */
  readonly runtime: typeof runtime;
  /** water recolouring uniforms (look-dev) */
  readonly water: typeof WATER_UNIFORMS;
  /** the custom lidar scene: terrain tiles renderer, forest hooks, lighting uniforms */
  readonly world: typeof world;
  readonly light: typeof SCENE_LIGHT;
  /** time of day: local PST hours on demo day (7.25 .. 16.4) */
  time: number;
  /** look-dev: put the free camera at an Emerald Bay ENU eye looking at an ENU target (m) */
  pose(eye: [number, number, number], target: [number, number, number]): void;
  /** look-dev: ENU height of the lidar terrain mesh under (e, n), or null */
  groundAtEnu(e: number, n: number): number | null;
}

declare global {
  interface Window {
    __flytake?: FlytakeDebug;
  }
}

export function installDebugHooks(): void {
  const api: FlytakeDebug = {
    get state() {
      return useFlytake.getState().phase;
    },
    get progress() {
      const { frozenT, phase } = useFlytake.getState();
      if (frozenT != null) return frozenT;
      if (phase === 'loading' || phase === 'start' || runtime.path == null) return 0;
      return Math.min(1, runtime.flightSeconds / FLIGHT_DURATION);
    },
    get tilesLoading() {
      return tilesLoading();
    },
    get runtime() {
      return runtime;
    },
    get water() {
      return WATER_UNIFORMS;
    },
    get world() {
      return world;
    },
    get light() {
      return SCENE_LIGHT;
    },
    get time() {
      return useSun.getState().hours;
    },
    set time(h: number) {
      useSun.getState().setHours(h);
    },
    groundAtEnu: (e, n) => {
      const tiles = world.terrain;
      if (!tiles) return null;
      const origin = fromSceneEnu(new Vector3(e, n, 2000));
      const down = new Vector3(0, 0, -1).transformDirection(SCENE_FRAME);
      const ray = new Raycaster(origin, down, 0, 5000);
      const hit = ray.intersectObject(tiles.group, true)[0];
      if (!hit) return null;
      return hit.point.applyMatrix4(SCENE_FRAME.clone().invert()).z;
    },
    pose: (eye, target) => {
      const cam = runtime.camera;
      if (!cam) return;
      if (useFlytake.getState().phase === 'arrived') useFlytake.getState().handoff();
      if (runtime.controls) runtime.controls.enabled = false;
      const up = new Vector3(0, 0, 1).transformDirection(SCENE_FRAME);
      cam.position.copy(fromSceneEnu(new Vector3(...eye)));
      cam.up.copy(up);
      cam.lookAt(fromSceneEnu(new Vector3(...target)));
      cam.updateMatrixWorld();
    },
    jump: (t) => useFlytake.getState().jump(t),
    fly: () => useFlytake.getState().fly(),
    replay: () => useFlytake.getState().replay(),
    handoff: () => useFlytake.getState().handoff(),
    enterDrone: () => useFlytake.getState().enterDrone(),
    surfaceAt: (lat, lon) => surfaceHeightAt(lat, lon),
    exitDrone: () => useFlytake.getState().exitDrone(),
    drone: () => {
      const d = runtime.drone;
      if (d == null) return null;
      const s = d.state;
      return {
        status: s.status,
        mode: s.mode,
        lat: s.lat,
        lon: s.lon,
        heightAboveHome: s.height - s.home.height,
        heightAboveGround: s.height - s.groundHeight,
        heading: s.heading,
        gimbalPitch: s.gimbalPitch,
        view: d.ui.view,
        speed: Math.hypot(s.vEast, s.vNorth),
        vUp: s.vUp,
        battery: s.battery,
        warnings: { ...s.warnings },
        sticks: { ...d.sticks },
        preparing: d.preparing,
        raycastMs: d.raycastMs,
        ui: { ...d.ui },
      };
    },
    stats: () => {
      const tiles = runtime.tiles;
      const lru = tiles?.lruCache as unknown as { cachedBytes?: number } | undefined;
      return {
        fps: Math.round(runtime.fps),
        phase: useFlytake.getState().phase,
        flightSeconds: runtime.flightSeconds,
        tiles: tiles ? { ...tileStats(tiles) } : null,
        cacheMB: lru?.cachedBytes != null ? Math.round(lru.cachedBytes / 2 ** 20) : null,
        errorTarget: tiles?.errorTarget ?? null,
        camera: runtime.camera
          ? {
              position: runtime.camera.position.toArray(),
              quaternion: runtime.camera.quaternion.toArray(),
              near: runtime.camera.near,
              far: runtime.camera.far,
              fov: runtime.camera.fov,
            }
          : null,
        controlsEnabled: runtime.controls?.enabled ?? null,
      };
    },
  };
  Object.defineProperty(window, '__flytake', { value: api, configurable: true });
}
