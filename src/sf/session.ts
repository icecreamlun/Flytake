/**
 * One San Francisco session per page: the argus city (boot.ts), its collision trees
 * (collision.ts) and the drone the store flies (SfDroneSim at Ferry Building Plaza).
 */
import { useFlytake } from '../state/store';
import { bootSfCity, type SfCity } from './boot';
import { buildSfCollider, type SfCollider } from './collision';
import { FERRY_BUILDING_PLAZA, SfDroneSim } from './SfDroneSim';

export interface SfWorld {
  readonly city: SfCity;
  readonly collider: SfCollider;
}

export type SfProgress = (label: string, fraction: number) => void;

/** share of the loading bar the city build takes (the collision trees get the rest) */
const CITY_SHARE = 0.86;

/** React StrictMode mounts effects twice in dev: every call for a container gets the same world. */
const prepared = new WeakMap<HTMLElement, Promise<SfWorld>>();

export function prepareSf(container: HTMLElement, onProgress: SfProgress): Promise<SfWorld> {
  const existing = prepared.get(container);
  if (existing != null) return existing;
  const world = (async () => {
    const city = await bootSfCity(container, (label, fraction) => onProgress(label, fraction * CITY_SHARE));
    onProgress('Mapping obstacles', CITY_SHARE);
    const collider = await buildSfCollider(city, (f) => onProgress('Mapping obstacles', CITY_SHARE + (1 - CITY_SHARE) * f));
    return { city, collider };
  })();
  prepared.set(container, world);
  // A failed boot may be retried.
  world.catch(() => prepared.delete(container));
  return world;
}

/** Fly the drone from Ferry Building Plaza (straight in while loading, else through a dip to black). */
export function flySf(world: SfWorld): void {
  const site = FERRY_BUILDING_PLAZA;
  useFlytake.getState().flyDrone(site.name, (hooks) => new SfDroneSim(site, hooks, world.city.engine, world.collider));
}
