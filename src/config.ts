/**
 * Static configuration: data credentials, URL debug flags and look-dev constants.
 * URL flags (all optional):
 *   ?autoplay=1     skip the start screen and start the flight as soon as the scene is ready
 *   ?t=0.75         freeze the flight at this fraction (0..1) of the 14 s descent
 *   ?pose=hero      jump straight to the arrival pose and hold it (no drift)
 *   ?drone=1        start directly in drone mode (Vikingsholm Beach, Emerald Bay)
 *   ?launch=38.9533,-120.1049,68   override the drone launch site (lat, lon, heading)
 *   ?noui=1         hide the app overlays (the Google attribution always stays)
 *   ?dpr=1.5        cap the device-pixel ratio (default 1.5)
 *   ?exposure=1.2   multiply the scripted exposure
 *   ?error=12       tiles screen-space error target in CSS px (default 12)
 *   ?normals=generated|reconstruct|none   terrain normals for sun shading (look-dev A/B)
 *   ?light=sunsky|sun|none                post-process relighting of the tiles (look-dev A/B)
 *   ?tm=agx|aces|neutral                  tone mapping (look-dev A/B)
 *   ?sat=0.1&contrast=0.05                final grade (look-dev A/B)
 *   ?albedo=1.4                           tiles albedo scale for the relighting (look-dev A/B)
 *   ?water=0|debug|blur  recolouring off, paint its mask (lake red, ocean magenta), or show the blurred sample
 *   ?watertol=0.2   lake-level tolerance as a fraction of each tile's geometric error
 *   ?haze=0         disable the near-ground haze reduction (look-dev A/B)
 *   ?stats=1        show a small fps / tiles readout
 *   ?scene=0        Google tiles only (no lidar terrain / forest at Emerald Bay)
 *   ?time=15.5      initial time of day, local hours on demo day (PST); [ and ] change it live
 */

const env = import.meta.env as Record<string, string | undefined>;
const clean = (v: string | undefined): string => (v ?? '').trim();

export const GOOGLE_MAPS_API_KEY = clean(env.VITE_GOOGLE_MAPS_API_KEY);
export const CESIUM_ION_TOKEN = clean(env.VITE_CESIUM_ION_TOKEN);

/** Google Photorealistic 3D Tiles, either direct (Map Tiles API) or through Cesium ion. */
export type TilesProvider = 'google' | 'ion' | null;
export const TILES_PROVIDER: TilesProvider = GOOGLE_MAPS_API_KEY !== '' ? 'google' : CESIUM_ION_TOKEN !== '' ? 'ion' : null;
/** Cesium ion asset id of "Google Photorealistic 3D Tiles". */
export const ION_GOOGLE_TILES_ASSET_ID = '2275207';

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const num = (key: string): number | null => {
  const raw = params.get(key);
  if (raw == null || raw.trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
};
const flag = (key: string): boolean => {
  const raw = params.get(key);
  return raw != null && raw !== '0' && raw !== 'false';
};

function oneOf<T extends string>(raw: string | null, values: readonly T[], fallback: T): T {
  return values.includes(raw as T) ? (raw as T) : fallback;
}

const frozen = num('t');

function parseLaunch(raw: string | null): { lat: number; lon: number; heading: number | null } | null {
  if (raw == null) return null;
  const [lat, lon, heading] = raw.split(',').map((v) => Number(v.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat: lat!, lon: lon!, heading: Number.isFinite(heading) ? heading! : null };
}

export const FLAGS = {
  autoplay: flag('autoplay'),
  /** freeze the flight at this fraction of its duration */
  frozenT: frozen == null ? null : Math.min(1, Math.max(0, frozen)),
  heroPose: params.get('pose') === 'hero',
  drone: flag('drone'),
  launch: parseLaunch(params.get('launch')),
  noUI: flag('noui'),
  stats: flag('stats'),
  dpr: Math.min(3, Math.max(0.5, num('dpr') ?? 1.5)),
  exposureScale: num('exposure') ?? 1,
  errorTarget: Math.max(2, num('error') ?? 12),
  normals: oneOf(params.get('normals'), ['none', 'generated', 'reconstruct'] as const, 'none'),
  light: oneOf(params.get('light'), ['sun', 'sunsky', 'none'] as const, 'sun'),
  toneMapping: oneOf(params.get('tm'), ['agx', 'aces', 'neutral'] as const, 'agx'),
  /** extra saturation / contrast added on top of the altitude-dependent grade */
  saturation: num('sat') ?? 0,
  contrast: num('contrast') ?? 0,
  albedoScale: num('albedo') ?? 1.4,
  water:
    params.get('water') === 'debug'
      ? 'debug'
      : params.get('water') === 'blur'
        ? 'blur'
        : params.get('water') === '0' || params.get('water') === 'false'
          ? 'off'
          : 'on',
  waterTolerance: num('watertol') ?? 0.2,
  haze: params.get('haze') !== '0',
  /** the custom lidar-built Emerald Bay scene (terrain + forest); ?scene=0 shows Google tiles only */
  scene: params.get('scene') !== '0',
  /** initial time of day (local PST hours on 2026-11-07); see src/world/sun.ts */
  time: num('time'),
} as const;

/**
 * Initial atmosphere date: demo day, 2026-11-07, 15:00 PST by default (?time= overrides). The
 * time of day is live (src/world/sun.ts drives the atmosphere and the scene lighting); this is
 * only the value the <Atmosphere> starts with.
 */
export const ATMOSPHERE_DATE = new Date(Date.UTC(2026, 10, 7) + ((num('time') ?? 15) + 8) * 3_600_000);
