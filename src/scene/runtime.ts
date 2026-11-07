import type { GlobeControls as GlobeControlsImpl, TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer';
import type { PerspectiveCamera, Scene } from 'three';
import type { FlyInPath } from '../camera/flyIn';
import type { DroneController } from '../drone/controller';

/**
 * Mutable per-frame state shared between the R3F scene and the DOM overlays. Nothing in here
 * triggers React renders; the HUD polls it at ~30 Hz and the store holds the discrete state.
 */
export const runtime = {
  tiles: null as TilesRendererImpl | null,
  controls: null as GlobeControlsImpl | null,
  camera: null as PerspectiveCamera | null,
  scene: null as Scene | null,
  /** seconds spent idling on the start screen (drives the slow globe rotation) */
  idleSeconds: 0,
  /** seconds since the current flight started (continues through the drift) */
  flightSeconds: 0,
  /** active fly-in path (null before the first flight) */
  path: null as FlyInPath | null,
  /** smoothed frames per second */
  fps: 0,
  /** first-person drone (drone phase only): DroneSim here, SfDroneSim in San Francisco */
  drone: null as DroneController | null,
};

/** TilesRenderer.stats (present at runtime, missing from the 0.5.4 typings). */
export interface TileStats {
  inCache: number;
  queued: number;
  downloading: number;
  parsing: number;
  loaded: number;
  failed: number;
  inFrustum: number;
  used: number;
  active: number;
  visible: number;
  refused: number;
}

export function tileStats(tiles: TilesRendererImpl): TileStats {
  return (tiles as unknown as { stats: TileStats }).stats;
}

/** true while the tiles download / parse queues still have work (or the root is loading). */
export function tilesLoading(tiles: TilesRendererImpl | null = runtime.tiles): boolean {
  if (tiles == null) return false;
  const s = tileStats(tiles);
  return Boolean((tiles as unknown as { isLoading?: boolean }).isLoading) || s.queued + s.downloading + s.parsing > 0;
}
