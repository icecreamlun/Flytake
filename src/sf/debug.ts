import { Vector3 } from 'three';
import { runtime } from '../scene/runtime';
import { useFlytake, type Phase } from '../state/store';
import { useSun } from '../world/sun';
import type { Engine } from './argus/contracts';
import type { SfCity } from './boot';
import type { SfCollider } from './collision';
import { flySf, type SfWorld } from './session';
import { SfDroneSim } from './SfDroneSim';

/**
 * Automation hooks for /?loc=sf (Playwright etc.), mirroring window.__flytake:
 *   window.__sf.ready        the city and its collision trees are built
 *   window.__sf.error        boot failure message, if any
 *   window.__sf.state        current phase: loading | drone | free
 *   window.__sf.drone()      telemetry snapshot (the fields of __flytake.drone()) + x / y / z in the argus frame
 *   window.__sf.time         time of day, local PST hours on demo day (7.25 .. 16.4); settable
 *   window.__sf.fly() / exitDrone()   enter (from the orbit view) / leave the drone
 *   window.__sf.cast(origin, dir, far)   distance to the first collision surface (argus frame), or null
 *   window.__sf.engine / city / collider / runtime  live objects, for the devtools console
 * argus frame: +X east, +Y up (m NAVD88, bay water at 0), +Z south.
 */
export interface SfDebug {
  readonly ready: boolean;
  readonly error: string | undefined;
  readonly state: Phase;
  time: number;
  readonly engine: Engine | undefined;
  readonly city: SfCity | undefined;
  readonly collider: SfCollider | undefined;
  /** shared with the HUD: runtime.drone is the SfDroneSim while flying */
  readonly runtime: typeof runtime;
  drone(): Record<string, unknown> | null;
  fly(): void;
  exitDrone(): void;
  cast(origin: [number, number, number], dir: [number, number, number], far?: number): number | null;
}

declare global {
  interface Window {
    __sf?: SfDebug;
  }
}

let world: SfWorld | null = null;
let error: string | undefined;

export function setSfDebugWorld(next: SfWorld): void {
  world = next;
}

export function setSfDebugError(message: string): void {
  error = message;
}

export function installSfDebugHooks(): void {
  const api: SfDebug = {
    get ready() {
      return world != null;
    },
    get error() {
      return error;
    },
    get state() {
      return useFlytake.getState().phase;
    },
    get time() {
      return useSun.getState().hours;
    },
    set time(h: number) {
      useSun.getState().setHours(h);
    },
    get engine() {
      return world?.city.engine;
    },
    get city() {
      return world?.city;
    },
    get collider() {
      return world?.collider;
    },
    get runtime() {
      return runtime;
    },
    fly: () => {
      if (world != null && useFlytake.getState().phase !== 'drone') flySf(world);
    },
    exitDrone: () => useFlytake.getState().exitDrone(),
    cast: (origin, dir, far = 2000) => world?.collider.cast(new Vector3(...origin), new Vector3(...dir).normalize(), far) ?? null,
    drone: () => {
      const d = runtime.drone;
      if (!(d instanceof SfDroneSim)) return null;
      const s = d.state;
      return {
        status: s.status,
        mode: s.mode,
        lat: s.lat,
        lon: s.lon,
        x: d.position.x,
        y: d.position.y,
        z: d.position.z,
        heightAboveHome: s.height - s.home.height,
        heightAboveGround: s.height - s.groundHeight,
        heading: s.heading,
        speed: Math.hypot(s.vEast, s.vNorth),
        vUp: s.vUp,
        battery: s.battery,
        warnings: { ...s.warnings },
        sticks: { ...d.sticks },
        preparing: d.preparing,
        splashed: d.splashed,
        raycastMs: d.raycastMs,
        ui: { ...d.ui },
      };
    },
  };
  Object.defineProperty(window, '__sf', { value: api, configurable: true });
}
