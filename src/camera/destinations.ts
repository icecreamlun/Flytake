import { HERO_A, type GeoPose } from './flyIn';
import { POIS, TAHOE } from '../geo/locations';

/** A preset fly-to target. Only presets are supported for now (no geocoding). */
export interface Destination {
  id: string;
  /** what the location field shows */
  label: string;
  /** lowercase fragments that select this preset when typed */
  aliases: string[];
  /** arrival ("hero") camera pose */
  hero: GeoPose;
  /** ellipsoidal height of the reference surface (lake level) for "height above" readouts */
  surfaceHeight: number;
  /** title card shown on arrival */
  title: { name: string; region: string; meta: string };
  /** HUD place caption by camera height above the surface (first match from the top wins) */
  places: Array<{ below: number; label: string }>;
}

const fannette = POIS.fannetteIsland;

export const EMERALD_BAY: Destination = {
  id: 'emerald-bay',
  label: 'Emerald Bay, Lake Tahoe',
  aliases: ['emerald', 'tahoe', 'fannette', 'vikingsholm', 'inspiration point'],
  hero: HERO_A,
  surfaceHeight: TAHOE.lakeEllipsoidHeight,
  title: {
    name: 'Emerald Bay',
    region: 'Lake Tahoe, California',
    meta: `ELEV 6,225 FT · 1,897 M · ${fannette.lat.toFixed(3)}° N ${Math.abs(fannette.lon).toFixed(3)}° W`,
  },
  places: [
    { below: 15_000, label: 'EMERALD BAY' },
    { below: 300_000, label: 'LAKE TAHOE BASIN' },
    { below: 3_000_000, label: 'SIERRA NEVADA' },
    { below: Number.POSITIVE_INFINITY, label: 'EARTH' },
  ],
};

export const DESTINATIONS: readonly Destination[] = [EMERALD_BAY];

export function findDestination(query: string): Destination | null {
  const q = query.trim().toLowerCase();
  if (q === '') return null;
  return (
    DESTINATIONS.find((d) => d.label.toLowerCase() === q || d.id === q) ??
    DESTINATIONS.find((d) => d.aliases.some((a) => q.includes(a) || a.includes(q))) ??
    null
  );
}

export function getDestination(id: string): Destination {
  return DESTINATIONS.find((d) => d.id === id) ?? EMERALD_BAY;
}
