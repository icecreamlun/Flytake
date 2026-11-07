import type * as THREE from 'three';
import type { AppContext, BuildingRecord, LandmarkId, RoadRecord } from '../../../contracts';

/** What every landmark builder receives. */
export interface LandmarkEnv {
  ctx: AppContext;
  ground(x: number, z: number): number;
  byLandmark(id: LandmarkId): BuildingRecord[];
  byId(id: string): BuildingRecord | undefined;
  roadsNamed(name: string): RoadRecord[];
}

/** What every landmark builder returns. */
export interface LandmarkBuild {
  name: string;
  /** Root object, positioned at the base centre (quake FX may shake/tilt it). */
  pivot: THREE.Object3D;
  /** Footprints whose generic extrusion this model replaces. */
  buildingIds: string[];
  /** Buildings this model is attached to without replacing them (quake FX moves the model with them). */
  attachedIds?: string[];
  /**
   * How quake FX motion reaches the model. 'rigid' (default): FX rocks the pivot about its base (towers).
   * 'translate': long low structures (pier sheds) that must not see-saw — FX gets a proxy object and the
   * landmarks module slides the pivot with the replaced building's roof drift and squashes it on collapse.
   */
  motion?: 'rigid' | 'translate';
  /** Optional per-building override of the object returned by objectForBuilding (default: pivot). */
  objectFor?: Record<string, THREE.Object3D>;
  /** World-fixed extras (e.g. rubble on the street) that must not follow the pivot's quake rocking. */
  statics?: THREE.Object3D;
  /** Per-frame animation (clock hands, lantern sway, LED twinkle…). */
  update?(dt: number, elapsed: number): void;
  /**
   * Earthquake damage of the replaced/attached building(s) (0..4, HAZUS state ramped in by quake FX),
   * called every frame; `instant` is true when the value jumped (seek / reset) rather than evolved, so
   * partial-collapse animations should snap to their end pose.
   */
  onDamage?(damage: number, instant: boolean, dt: number): void;
}
