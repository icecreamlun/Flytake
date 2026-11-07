import type { TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer';
import type { Object3D, Vector3 } from 'three';
import type { ShadowField } from './shadowField';

/** Mutable handles of the custom Emerald Bay scene (no React state). */
export const world = {
  terrain: null as TilesRendererImpl | null,
  /** distance along an ENU ray to the first tree (trunk / crown), set once the forest loads */
  forestRaycast: null as ((originEnu: Vector3, dirEnu: Vector3, maxDist: number) => number | null) | null,
  /** live sun shadow field (shadowField.ts) */
  shadow: null as ShadowField | null,
  /** hand-built props the drone collides with (raycast in world space) */
  props: [] as Object3D[],
  /** terrain ground-material uniforms (look-dev / debugging) */
  materials: null as Record<string, { value: unknown }> | null,
};
