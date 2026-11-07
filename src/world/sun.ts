import { getSunDirectionECEF } from '@takram/three-atmosphere';
import { Vector3 } from 'three';
import { create } from 'zustand';
import { FLAGS } from '../config';
import { SCENE_FRAME_INV } from './scene';

/**
 * Time of day (the one live lighting control). Everything that depends on the sun subscribes
 * here: the atmosphere (sky, aerial perspective), the scene / forest light uniforms and the
 * GPU shadow field (src/world/shadowField.ts), which recomputes when `version` changes.
 *
 * Hours are local (PST, UTC-8) on demo day 2026-11-07. The range keeps the sun > ~3 deg up
 * (the custom scene's pre-lit materials divide by the flat sun term, see light.ts).
 */
export const SUN_DAY_UTC_MS = Date.UTC(2026, 10, 7);
export const UTC_OFFSET_HOURS = -8;
export const TIME_MIN = 7.25;
export const TIME_MAX = 16.4;
export const TIME_DEFAULT = 15;

export function dateAtLocalHours(hours: number): Date {
  return new Date(SUN_DAY_UTC_MS + (hours - UTC_OFFSET_HOURS) * 3_600_000);
}

export function formatLocalHours(hours: number): string {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const clampHours = (h: number): number => Math.min(TIME_MAX, Math.max(TIME_MIN, h));

interface SunStore {
  /** local hours (PST) */
  hours: number;
  /** increments on every change (shadow field, probes) */
  version: number;
  setHours(hours: number): void;
}

export const useSun = create<SunStore>((set) => ({
  hours: clampHours(FLAGS.time ?? TIME_DEFAULT),
  version: 0,
  setHours: (hours) => set((s) => (clampHours(hours) === s.hours ? s : { hours: clampHours(hours), version: s.version + 1 })),
}));

/** Live sun state in the Emerald Bay scene ENU frame (updated synchronously on change). */
export const SUN = {
  /** unit vector toward the sun, scene ENU */
  dirEnu: new Vector3(0, 0, 1),
  /** unit vector toward the sun, ECEF */
  dirEcef: new Vector3(0, 0, 1),
  /** elevation (rad) and azimuth (rad, from north, clockwise) */
  elevation: 0,
  azimuth: 0,
  date: dateAtLocalHours(useSun.getState().hours),
};

type Listener = (date: Date) => void;
const listeners = new Set<Listener>();

/** Calls `fn` now and on every time-of-day change; returns the unsubscribe function. */
export function onSunChange(fn: Listener): () => void {
  listeners.add(fn);
  fn(SUN.date);
  return () => listeners.delete(fn);
}

function apply(hours: number): void {
  const date = dateAtLocalHours(hours);
  SUN.date = date;
  getSunDirectionECEF(date, SUN.dirEcef);
  SUN.dirEnu.copy(SUN.dirEcef).transformDirection(SCENE_FRAME_INV);
  SUN.elevation = Math.asin(Math.min(1, Math.max(-1, SUN.dirEnu.z)));
  SUN.azimuth = Math.atan2(SUN.dirEnu.x, SUN.dirEnu.y);
  for (const fn of listeners) fn(date);
}

apply(useSun.getState().hours);
useSun.subscribe((s, prev) => {
  if (s.hours !== prev.hours) apply(s.hours);
});
