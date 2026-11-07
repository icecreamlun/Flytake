/**
 * Shared contracts between modules. Every module codes against these types.
 * Change only when a contract is genuinely wrong, and keep changes backward compatible.
 *
 * Coordinate system (world space, metres):
 *   origin = CITY_ORIGIN (see geo.ts), +X = east, -Z = north (+Z = south), +Y = up.
 *   Y is elevation above mean sea level in metres (no vertical exaggeration).
 *   2D footprints/polylines are stored as [x, z] pairs in this frame.
 */
import type * as THREE from 'three';

// ───────────────────────────── City data (public/data/city.json) ─────────────────────────────

export type XZ = [number, number];

/** HAZUS-style model building types. */
export type StructureType =
  | 'W1' // light wood frame, small residential
  | 'W1_SOFT' // wood frame with soft/weak first storey (SF soft-story program)
  | 'W2' // large wood frame (commercial)
  | 'URM' // unreinforced masonry
  | 'RM' // reinforced masonry
  | 'C1' // concrete moment frame
  | 'C2' // concrete shear wall
  | 'C3' // concrete frame with URM infill
  | 'PC' // precast / tilt-up
  | 'S1' // steel moment frame
  | 'S2' // steel braced frame
  | 'S5'; // steel frame with URM infill

/** Seismic design code era. */
export type CodeLevel = 'pre' | 'low' | 'moderate' | 'high';

export type BuildingUse =
  | 'residential'
  | 'mixed'
  | 'commercial'
  | 'office'
  | 'retail'
  | 'hotel'
  | 'civic'
  | 'religious'
  | 'school'
  | 'industrial'
  | 'transport'
  | 'parking'
  | 'other';

export type District =
  | 'chinatown'
  | 'fidi'
  | 'embarcadero'
  | 'jackson_square'
  | 'nob_hill'
  | 'north_beach'
  | 'soma'
  | 'other';

export interface BuildingRecord {
  id: string; // stable, e.g. "B0001"
  osmId: string; // "way/123" | "relation/456"
  name?: string;
  address?: string; // "455 Grant Ave"
  /** Outer ring, local metres, counter-clockwise when viewed from above (+Y), not closed (first != last). */
  footprint: XZ[];
  holes?: XZ[][];
  /** Terrain elevation (m) at the lowest point of the footprint. Geometry starts here. */
  baseElevation: number;
  /** Height above baseElevation to the roof top (m). */
  height: number;
  /** For building:part pieces that start above ground (m above baseElevation). */
  minHeight?: number;
  levels: number;
  use: BuildingUse;
  structure: StructureType;
  yearBuilt: number;
  codeLevel: CodeLevel;
  occupantsDay: number;
  occupantsNight: number;
  softStory: boolean;
  district: District;
  /** On historic bay fill (east of the ~1850 shoreline) — liquefaction-susceptible. */
  onFill: boolean;
  /** Time-averaged shear-wave velocity to 30 m depth (m/s), site class proxy. */
  vs30: number;
  roofShape?: string; // OSM roof:shape
  colour?: string; // OSM building:colour or estimated, CSS colour
  roofColour?: string;
  material?: string; // OSM building:material (brick, glass, concrete, stone, wood, plaster…)
  /** Set when a hand-built landmark model replaces/augments this footprint. */
  landmark?: LandmarkId;
  /**
   * True if this record is a piece of a bigger building (OSM building:part, outline remainder, podium mapped
   * separately) that is NOT its structural record. Each building has exactly one record without isPart/parentId
   * (its anchor = tallest ground-standing piece), which carries ALL the building's occupants; pieces carry 0 and
   * share the anchor's structure/yearBuilt/codeLevel/softStory. So `!isPart` enumerates buildings exactly once.
   */
  isPart?: boolean;
  /** Outside the core study area (context ring): rendered for realism, still simulated, may use cheaper LOD. */
  context?: boolean;
  /**
   * Stands over the bay rather than on terrain: a pier shed / wharf building (baseElevation = pier deck, ~2.4-3.6 m)
   * or a moored vessel (baseElevation ≈ -1, hull below the waterline). Terrain under it is bay floor; don't drape
   * foundations onto it.
   */
  overWater?: boolean;
  /** Id of the building's anchor record (set on every isPart piece, never on the anchor): group key = parentId ?? id. */
  parentId?: string;
  provenance: {
    height: 'osm_height' | 'datasf_lidar' | 'osm_levels' | 'estimated';
    year: 'assessor' | 'osm' | 'estimated';
    structure: 'assessor' | 'estimated';
  };
}

export type LandmarkId =
  | 'ferry_building'
  | 'transamerica_pyramid'
  | 'chinatown_gate'
  | 'embarcadero_center'
  | 'old_st_marys'
  | 'sentinel_building'
  | 'one_maritime_plaza'
  | 'hyatt_regency'
  | 'customs_house'
  | 'coit_tower'
  | 'bay_bridge'
  | 'other';

export type RoadKind =
  | 'motorway'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'living_street'
  | 'pedestrian'
  | 'footway'
  | 'steps'
  | 'cycleway'
  | 'rail' // heavy/light rail, streetcar (F-line)
  | 'cable_car';

export interface RoadRecord {
  id: string; // "R0001"
  osmId: string;
  name?: string;
  kind: RoadKind;
  /** Centreline polyline, local metres. */
  points: XZ[];
  /** Carriageway width (m), kerb to kerb. Sidewalks are drawn by the streets module outside this. */
  width: number;
  lanes?: number;
  oneway?: boolean;
  bridge?: boolean;
  tunnel?: boolean;
  layer?: number;
  /** Sidewalk width each side (m), 0 if none. */
  sidewalk?: number;
}

export type AreaKind = 'park' | 'plaza' | 'pier' | 'water' | 'parking' | 'grass' | 'pitch' | 'construction';

export interface AreaRecord {
  id: string;
  osmId?: string;
  kind: AreaKind;
  name?: string;
  polygon: XZ[];
  holes?: XZ[][];
  /** Deck elevation for piers (m). */
  elevation?: number;
}

export interface TreeRecord {
  x: number;
  z: number;
  species?: string;
  /** Diameter at breast height (inches), from DataSF street-tree list when available. */
  dbh?: number;
  source: 'datasf' | 'osm' | 'estimated';
}

export interface CityMeta {
  name: string;
  /** Core study area (Ferry Building → Chinatown). */
  bbox: { south: number; west: number; north: number; east: number };
  /** Larger area that buildings/terrain were fetched for (context ring around the core). */
  contextBBox: { south: number; west: number; north: number; east: number };
  origin: { lat: number; lon: number };
  generatedAt: string;
  sources: string[]; // human-readable attributions
  /** Approximate ~1850 shoreline polyline (local metres). Land west of it is native ground; east is fill. */
  historicShoreline?: XZ[];
}

export interface CityData {
  meta: CityMeta;
  buildings: BuildingRecord[];
  roads: RoadRecord[];
  areas: AreaRecord[];
  trees: TreeRecord[];
}

/** public/data/terrain.json (+ terrain.bin Float32 little-endian, row-major, rows = north→south). */
export interface TerrainMeta {
  /** World X of column 0 and world Z of row 0 (north-west corner sample). */
  minX: number;
  minZ: number;
  /** Sample spacing (m). */
  cellSize: number;
  cols: number;
  rows: number;
  /** Min/max elevation present (m). Bay bathymetry is negative. */
  minElevation: number;
  maxElevation: number;
  source: string;
}

/** Bilinear sampler over the terrain grid (src/terrain/heightfield.ts). */
export interface Heightfield {
  meta: TerrainMeta;
  data: Float32Array;
  /** Elevation (m) at world x,z; clamps outside the grid. */
  heightAt(x: number, z: number): number;
  /** Unit surface normal at world x,z. */
  normalAt(x: number, z: number, target?: THREE.Vector3): THREE.Vector3;
}

// ───────────────────────────── Runtime context ─────────────────────────────

export interface EnvironmentState {
  /** Local solar time in hours, 0..24. */
  timeOfDay: number;
  /** World-space unit vector pointing from the scene towards the sun. */
  sunDirection: THREE.Vector3;
  /** 0 = full day, 1 = full night (smooth through dusk/dawn). Drives window lights & street lamps. */
  nightFactor: number;
  /** 0..1 extra atmospheric dust/haze (raised after collapses). */
  haze: number;
}

export type AppEvent =
  | { type: 'environment-changed'; env: EnvironmentState }
  | { type: 'building-selected'; id: string | null }
  | { type: 'quake-started'; event: UsgsEvent }
  | { type: 'quake-tick'; simSeconds: number }
  | { type: 'quake-finished' }
  | { type: 'quake-reset' }
  | { type: 'overlay-changed'; overlay: OverlayMode };

export type OverlayMode = 'none' | 'shakemap' | 'damage';

export interface EventBus {
  emit(e: AppEvent): void;
  on<T extends AppEvent['type']>(type: T, fn: (e: Extract<AppEvent, { type: T }>) => void): () => void;
}

export type UpdateFn = (dt: number, elapsed: number) => void;

export interface AppContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Parent group for everything that belongs to the city (ground, streets, buildings, landmarks, props). */
  cityRoot: THREE.Group;
  city: CityData;
  terrain: Heightfield;
  env: EnvironmentState;
  events: EventBus;
  /** Register a per-frame callback; returns an unsubscribe function. */
  onUpdate(fn: UpdateFn): () => void;
}

// ───────────────────────────── Engine (src/engine) ─────────────────────────────

export type CameraPresetId = 'overview' | 'ferry' | 'chinatown' | 'street' | 'transamerica' | 'embarcadero' | 'aerial_east';

export interface CameraPreset {
  id: CameraPresetId;
  label: string;
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

export interface Engine {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  env: EnvironmentState;
  /** Set local solar time (hours). Updates sun, sky, lights, fog, env map, then emits 'environment-changed' via the bus given in start(). */
  setTimeOfDay(hours: number): void;
  setHaze(amount: number): void;
  /** Adds screen-space camera shake (metres of camera jitter); decays automatically unless re-set each frame. */
  setCameraShake(amplitude: number): void;
  /** Smoothly fly camera to a preset or explicit pose. duration in seconds (0 = instant). */
  flyTo(pose: CameraPresetId | { position: [number, number, number]; target: [number, number, number] }, duration?: number): void;
  cameraPresets: CameraPreset[];
  /** Begin the render loop. update callbacks run before render each frame. */
  start(bus: EventBus, onFrame: UpdateFn): void;
  /** Render one frame synchronously (used by screenshot harness). */
  renderOnce(): void;
  /** Expose the shadow-casting sun so modules can tune shadow camera bounds if needed. */
  sun: THREE.DirectionalLight;
  /** Optional: terrain sampler so camera controls/presets never go below ground. Wired by main.ts. */
  setGroundHeightSampler?(fn: (x: number, z: number) => number): void;
  /**
   * Optional: render the scene from another camera (e.g. a drone feed) into a render target,
   * display-ready (exposure + tone mapping + sRGB; no AO/bloom). Shares sky, lights, fog and the
   * main view's shadow map. `target` null renders to the canvas.
   */
  renderView?(camera: THREE.Camera, target: THREE.WebGLRenderTarget | null): void;
  /**
   * Flytake: hand the main camera to an external controller (e.g. the drone). While a driver is set
   * the orbit rig is frozen and ignores pointer / keyboard input, and `driver(camera, dt)` runs at the
   * start of every frame (before `onFrame`, so culling / LOD see this frame's pose). It owns position,
   * orientation, fov, near and far; the engine calls updateProjectionMatrix / updateMatrixWorld after
   * it. `null` gives the camera back to the rig as a free orbit camera from the current pose.
   */
  setCameraDriver(driver: CameraDriver | null): void;
  /** Flytake: stop the loop, drop listeners and GPU resources, remove the canvas. */
  dispose(): void;
}

/** Flytake: per-frame camera controller, see Engine.setCameraDriver. dt in seconds (clamped to 0.1). */
export type CameraDriver = (camera: THREE.PerspectiveCamera, dt: number) => void;

// ───────────────────────────── Buildings (src/city/buildings) ─────────────────────────────

/**
 * Per-building dynamic state, written by quake FX, read by the building material's vertex/fragment shaders.
 * Stored in a float DataTexture, 3 texels per building (index i → texels 3i, 3i+1, 3i+2):
 *   texel 0 (dynamic A): shakeX (m), shakeZ (m), tiltX (rad, rotation about world X), tiltZ (rad, about world Z)
 *   texel 1 (dynamic B): crush 0..1 (vertical squash toward base; 1 = flattened),
 *                        damage 0..4 (HAZUS state, float for smooth tinting), lightsOut 0..1, hidden 0/1
 *   texel 2 (static):    centreX, centreZ, baseElevation, height
 * Deformation (vertex shader), for a vertex with world position p and h = p.y - base:
 *   1. crush:  p.y = base + h * (1 - crush)
 *   2. tilt:   rotate (p - [cx, base, cz]) by tiltX about X then tiltZ about Z, add back
 *   3. shake:  p.xz += [shakeX, shakeZ] * (h / height)   (cantilever: top moves most)
 *   4. hidden: collapse vertex to degenerate (or discard in fragment) when hidden > 0.5
 */
export interface BuildingDynamicState {
  shakeX?: number;
  shakeZ?: number;
  tiltX?: number;
  tiltZ?: number;
  crush?: number;
  damage?: number;
  lightsOut?: number;
  hidden?: number;
}

export interface BuildingsHandle {
  object: THREE.Object3D;
  count: number;
  /** Index of building id in the state buffer, or -1. Index order == city.buildings order. */
  indexOf(id: string): number;
  /** Merge-update dynamic state for one building (by index). Call commit() once per frame after updates. */
  setState(index: number, s: BuildingDynamicState): void;
  getState(index: number): Required<BuildingDynamicState>;
  /** Reset every building to the undamaged state. */
  resetAll(): void;
  commit(): void;
  /** Damage-colour overlay on/off (tints by damage value; colour ramp owned by buildings module). */
  setDamageOverlay(on: boolean): void;
  /** Optional per-building tint for overlays such as ShakeMap MMI (null clears). RGB 0..1. */
  setOverlayColor(index: number, rgb: [number, number, number] | null): void;
  /** Optional (M3 scan): slight grey veil for unscanned buildings, 0..1 (desaturate ~55%, darken ~18% at 1). Independent of the overlay tint. */
  setVeil?(index: number, amount: number): void;
  /** Highlight one building (selection outline / glow). */
  setHighlight(id: string | null): void;
  /** Raycast pick → building id or null. */
  pick(raycaster: THREE.Raycaster): string | null;
}

// ───────────────────────────── Streets & ground (src/city/streets) ─────────────────────────────

export interface StreetsHandle {
  object: THREE.Object3D;
  /** Street lamps & traffic lights follow env.nightFactor; quake FX can cut power. 0 = on, 1 = all off. */
  setPowerOut(amount: number): void;
}

// ───────────────────────────── Landmarks (src/city/landmarks) ─────────────────────────────

export interface LandmarksHandle {
  object: THREE.Object3D;
  /** Landmark object that replaces a building footprint, for quake FX to shake/tilt via its transform. */
  objectForBuilding(buildingId: string): THREE.Object3D | null;
  /** Building ids whose generic extrusion was hidden because a landmark model replaces it. */
  replacedBuildingIds: string[];
  /** Optional (landmarks): cut landmark night lighting (floodlights, windows, Bay Lights…). 0 = on, 1 = all off. */
  setPowerOut?(amount: number): void;
  /**
   * Optional (landmarks): overlay tint for the landmark replacing building `index` (same semantics as
   * BuildingsHandle.setOverlayColor). Landmarks already mirror the calls made on the buildings handle, so
   * callers do not need to invoke this; it exists for explicit control.
   */
  setOverlayColor?(index: number, rgb: [number, number, number] | null): void;
  /** Optional (landmarks): damage-state colour overlay on/off (mirrors BuildingsHandle.setDamageOverlay). */
  setDamageOverlay?(on: boolean): void;
}

// ───────────────────────────── Earthquake model (src/quake/model) — pure TS, no three.js ─────────────────────────────

/** Exactly the USGS earthquake GeoJSON Feature format (earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). */
export interface UsgsEvent {
  type: 'Feature';
  id: string;
  properties: {
    mag: number;
    place: string;
    time: number; // ms since epoch (origin time)
    updated: number;
    tz: number | null;
    url: string;
    detail: string;
    felt: number | null;
    cdi: number | null;
    mmi: number | null;
    alert: 'green' | 'yellow' | 'orange' | 'red' | null;
    status: 'automatic' | 'reviewed';
    tsunami: 0 | 1;
    sig: number;
    net: string;
    code: string;
    ids: string;
    sources: string;
    types: string;
    nst: number | null;
    dmin: number | null;
    rms: number | null;
    gap: number | null;
    magType: string;
    type: 'earthquake';
    title: string;
  };
  geometry: { type: 'Point'; coordinates: [number, number, number] }; // [lon, lat, depthKm]
}

export interface QuakeScenario {
  id: string;
  name: string; // "San Andreas M7.8 — 1906 repeat"
  description: string;
  event: UsgsEvent;
  /** Surface trace of the rupture as [lon, lat] — used for finite-fault distance. Omit for point source. */
  ruptureTrace?: [number, number][];
  /** Fault dip info for Rrup: top-of-rupture depth (km). */
  ztorKm?: number;
  /** Local solar time (hours) the scenario happens at, drives occupancy (day/night). */
  localHour: number;
}

export interface BuildingShaking {
  /** Rupture distance (km). */
  distanceKm: number;
  pgaG: number; // peak ground acceleration (g)
  pgvCms: number; // peak ground velocity (cm/s)
  mmi: number; // Modified Mercalli Intensity (float)
  /** Seconds after origin time the P and S waves arrive at this building. */
  pArrivalS: number;
  sArrivalS: number;
  /** Strong-shaking duration at this site (s). */
  durationS: number;
  /** Optional (quake model): the ground under this building liquefied (sand boils, settlement, lateral spreading). */
  liquefaction?: boolean;
  /** Optional (quake model): site Vs30 used (m/s). */
  vs30?: number;
}

export type DamageState = 0 | 1 | 2 | 3 | 4; // none, slight, moderate, extensive, complete

export interface BuildingDamage {
  state: DamageState;
  /** P(state >= ds) for ds = 1..4 */
  exceedance: [number, number, number, number];
  /**
   * What the quake model can PREDICT minutes after the event, P(state >= ds) for ds = 1..4: median ground
   * motion only (the within-event residual is unknowable in advance), database attributes as recorded
   * (no hidden retrofits / defects), liquefaction only as an expectation. `exceedance` is the truth-world value.
   */
  predictedExceedance?: [number, number, number, number];
  /**
   * Blind prediction re-evaluated at demand scales PREDICTION_SCALES (quake/model): flattened
   * [s0e1, s0e2, s0e3, s0e4, s1e1, …]. Lets observations correct the model spatially (if a neighbourhood
   * shook harder than the median, its unobserved buildings move up the curve).
   */
  predictedExceedanceK?: number[];
  collapsed: boolean; // a subset of complete damage
  /** Fraction of the building's height lost (0..1) for collapse visuals. */
  collapseFraction: number;
  /** Lean direction (radians, world XZ) and magnitude for extensive/complete damage visuals.
   *  The roof moves along (cos leanDirection, sin leanDirection) in world (x, z); leanAngle is in radians. */
  leanDirection: number;
  leanAngle: number;
  /** Debris spill radius beyond footprint (m). */
  debrisRadius: number;
  fire: boolean;
  /** Seconds after origin when the damage manifests (≥ sArrival). */
  failTimeS: number;
  /** Expected casualties by HAZUS severity 1..4 and trapped estimate. */
  trappedEstimate: number;
  casualties: [number, number, number, number];
}

export interface RoadBlockage {
  roadId: string;
  /** Segment index i means the segment points[i] → points[i+1]. */
  segment: number;
  /** Fraction of carriageway width covered by debris (0..1). >= 0.6 ⇒ impassable. */
  coverage: number;
  causeBuildingId: string;
  /** Debris pile centre (world x,z). */
  at: XZ;
}

export interface QuakeResult {
  scenario: QuakeScenario;
  shaking: BuildingShaking[]; // aligned with city.buildings
  damage: BuildingDamage[]; // aligned with city.buildings
  roads: RoadBlockage[];
  stats: {
    buildings: number;
    byState: [number, number, number, number, number];
    collapsed: number;
    fires: number;
    trappedEstimate: number;
    blockedSegments: number;
    maxMmi: number;
    occupantsAtTime: number;
  };
  /** ShakeAlert: seconds between alert issuance and S-wave arrival at the city centre (can be ≤ 0 = blind zone). */
  shakeAlert: { issuedAtS: number; warningSecondsAtCentre: number; expectedMmi: number };
  /** Simulated time span of the event visualization (s after origin). */
  durationS: number;
}

export interface QuakeModel {
  scenarios: QuakeScenario[];
  /** Deterministic for a given seed. */
  run(city: CityData, scenario: QuakeScenario, seed?: number): QuakeResult;
  /** Build a custom scenario from an epicentre & magnitude. */
  customScenario(lat: number, lon: number, depthKm: number, mag: number, localHour: number): QuakeScenario;
  /** Ground-motion field for overlays: MMI at an arbitrary world x,z (uses vs30 heuristic from nearest building or default). */
  mmiAt(city: CityData, scenario: QuakeScenario, x: number, z: number): number;
}

// ───────────────────────────── Earthquake FX (src/quake/fx) ─────────────────────────────

export interface QuakeFxHandle {
  object: THREE.Object3D;
  /** Start playing a computed quake result. timeScale = sim seconds per real second. */
  play(result: QuakeResult, opts?: { timeScale?: number }): void;
  /** Jump the playback to t sim-seconds after origin (deterministic, used by screenshot harness). */
  seek(simSeconds: number): void;
  pause(): void;
  resume(): void;
  reset(): void;
  readonly playing: boolean;
  readonly simSeconds: number;
  setOverlay(mode: OverlayMode): void;
}

// ───────────────────────────── UI (src/ui) ─────────────────────────────

export interface UiHandlers {
  /** M5: Copilot chat. */
  onCopilotAsk?(text: string): void;
  onCopilotShowPlan?(messageId: string): void;
  onCopilotDispatch?(messageId: string): void;
  onCopilotToggle?(open: boolean): void;
  onCopilotHighlight?(incidentId: string | null): void;
  /** M4: commander approves / rejects the proposed Argon drone plan. */
  onApprovePlan?(): void;
  onRejectPlan?(): void;
  onTriggerScenario(scenarioId: string): void;
  onTriggerCustom(lat: number, lon: number, depthKm: number, mag: number): void;
  onReset(): void;
  onTimeOfDay(hours: number): void;
  onOverlay(mode: OverlayMode): void;
  onCameraPreset(id: CameraPresetId): void;
  onTimeScale(scale: number): void;
  onPauseToggle(): void;
}

export interface BuildingInfo {
  record: BuildingRecord;
  shaking?: BuildingShaking;
  damage?: BuildingDamage;
}

export interface UiHandle {
  /** M6: pop a resident-report toast (analysis null = just received). */
  showReport?(item: ReportItem): void;
  /** M6: community reports panel (list + counters). */
  setReports?(items: ReportItem[], stats: { received: number; analysed: number; buildings: number; mode: ReportsResponse['mode'] | null }): void;
  /** M5: Copilot chat drawer. */
  copilotSetMessages?(messages: ChatMessage[], situation: CopilotSituation | null): void;
  copilotSetThinking?(thinking: boolean): void;
  copilotOpen?(open: boolean): void;
  /** M4: Argon drone plan card (null hides). info.schedule shows mission progress while executing. */
  showPlan?(plan: DronePlan | null, state: PlanUiState, info?: { schedule?: DroneScheduleEntry[]; simS?: number; wavesUsed?: number }): void;
  /** M4: drone camera thumbnails (latest captured frame per drone). */
  showDroneFeeds?(feeds: DroneFeed[]): void;
  /** Show the incoming USGS event card (as if received from the USGS feed). */
  showEvent(event: UsgsEvent, scenario: QuakeScenario): void;
  /** ShakeAlert banner: countdown seconds until strong shaking (≤0 hides countdown), expected MMI. */
  showShakeAlert(secondsToShaking: number, expectedMmi: number): void;
  hideShakeAlert(): void;
  updateStats(stats: QuakeResult['stats'] | null, simSeconds: number): void;
  showBuilding(info: BuildingInfo | null): void;
  setTimeOfDay(hours: number): void;
  setPlaying(playing: boolean): void;
  setScenarios(scenarios: QuakeScenario[]): void;
  setCameraPresets(presets: CameraPreset[]): void;
  setCityStats(city: CityData): void;
  /** Optional (M3): AIR 1 aerial-reconstruction panel. null hides it (no flight / reset). */
  showAir?(s: AirUiState | null): void;
  /** Optional (M3): Predicted / Argon observed / Truth block in the inspector for the shown building (null clears). */
  showComparison?(c: BuildingComparison | null): void;
}

// ═════════════════════════════ M3: aerial reconnaissance + Argon reconstruction ═════════════════════════════
//
// Flow: quake plays (truth world) → police helicopter "AIR 1" flies a HARD-CODED route → its gimbal camera is
// rendered off-screen (never shown on screen) with an AR overlay (street names + building address tags, like
// real police-helicopter AR mapping systems) → frames are batched into ~15 s chunks → server encodes an mp4
// and asks gemini-4-argon to reconstruct buildings / people / roads seen in the footage (blind: no model
// prediction is sent) → results are drawn on the city and compared with the quake model's prediction and
// the hidden truth. Areas the helicopter has not scanned are veiled slightly grey.
// Time base: everything is a pure function of quake simSeconds (deterministic seek for screenshots);
// flightSeconds = simSeconds - AIR_LAUNCH_S(result). Frame capture & network only happen while playing.

/** Ground-truth people generated from the quake result (src/truth/people). Hidden from Argon. */
export interface PersonTruth {
  id: string;
  kind: 'trapped' | 'crowd';
  /** Building the person is trapped on/in (trapped only). */
  buildingId?: string;
  /** Crowd id (crowd only). */
  crowdId?: string;
  x: number;
  y: number;
  z: number;
  /** Visible from the air (standing on rubble / roof / street). Hidden = buried inside. */
  visible: boolean;
  /** Waving for help (trapped & visible). */
  waving: boolean;
  /** simSeconds when the person appears (trapped: building failTime + a few s; crowd: gathers after shaking). */
  appearS: number;
}

export interface CrowdTruth {
  id: string;
  name?: string; // e.g. "Portsmouth Square"
  x: number;
  z: number;
  radius: number;
  count: number;
  appearS: number;
}

export interface PeopleTruth {
  persons: PersonTruth[];
  crowds: CrowdTruth[];
  /** Per building id: trapped people visible from the air / buried. */
  byBuilding: Record<string, { visible: number; hidden: number }>;
}

export interface PeopleHandle {
  object: THREE.Object3D;
  /** Generate (deterministic) and instantiate people for a quake result. */
  build(result: QuakeResult): PeopleTruth;
  /** Pose/visibility at simSeconds (deterministic; waving animation may use wall-clock). */
  update(simSeconds: number): void;
  reset(): void;
  readonly truth: PeopleTruth | null;
}

/** Helicopter pose at a flight time (src/air/heli). */
export interface HeliPose {
  flightS: number;
  position: [number, number, number];
  /** Heading in radians, 0 = north (-Z), clockwise positive. */
  heading: number;
  /** Where the gimbal camera looks (world point on the ground). */
  cameraTarget: [number, number, number];
  fovDeg: number;
  /** Camera frustum ∩ ground (terrain) as a polygon, world x/z (≈ quad). */
  footprint: XZ[];
}

export interface HelicopterHandle {
  object: THREE.Object3D;
  callsign: string; // "AIR 1 · SFPD"
  /** Hard-coded route centreline (x/z) and timing. */
  route: XZ[];
  durationS: number;
  altitudeAGL: number;
  /** Deterministic pose for a flight time (clamped to [0, durationS]). */
  poseAt(flightS: number): HeliPose;
  /** Gimbal camera (PerspectiveCamera) kept in sync by setFlightTime; used for off-screen capture. */
  camera: THREE.PerspectiveCamera;
  /** Place helicopter + camera at flight time t; null hides it (not launched / reset). */
  setFlightTime(t: number | null): void;
  readonly flightTime: number | null;
}

/** One captured frame of the helicopter camera (src/air/scan). */
export interface ScanFrame {
  index: number; // global frame index within the flight
  flightS: number;
  simS: number;
  pose: HeliPose;
  /** JPEG, base64 without data: prefix. */
  jpegBase64: string;
  /** Buildings whose AR tag was drawn in this frame (inside the frustum, in range). */
  taggedBuildingIds: string[];
}

export interface ScanChunk {
  /** M4: footage source; drone chunks carry their mission. Default 'heli'. */
  source?: 'heli' | 'drone';
  droneId?: DroneId;
  missionId?: string;
  targetBuildingIds?: string[];
  chunkIndex: number;
  frames: ScanFrame[];
  /** Union of tagged building ids across frames. */
  buildingIds: string[];
  startFlightS: number;
  endFlightS: number;
}

export interface ScanHandle {
  /** Ground veil + footprint trail visuals. */
  object: THREE.Object3D;
  /** Recompute coverage so everything under footprints for flight time 0..t is scanned (deterministic). null = nothing scanned / veil off. */
  setCoverageUntil(t: number | null): void;
  /** Building index → scanned? */
  isScanned(index: number): boolean;
  /** Fraction of the CORE area scanned (0..1). */
  scannedFraction(): number;
  /** Capture one frame from the helicopter camera with AR overlay (live playback only). */
  captureFrame(pose: HeliPose, simS: number): ScanFrame;
  /**
   * Optional (integration): same, but the scene is rendered now and the pixels are read back asynchronously
   * (no GPU-queue drain on the main thread). One capture at a time.
   */
  captureFrameAsync?(pose: HeliPose, simS: number): Promise<ScanFrame>;
  reset(): void;
}

export type ObservedDamage = 'none' | 'slight' | 'moderate' | 'extensive' | 'collapsed';

export interface ObservedBuilding {
  id: string;
  damage: ObservedDamage;
  confidence: number; // 0..1
  peopleVisible: number;
  trappedSigns: boolean; // people on rubble/roof waving, SOS, etc.
  fire: boolean;
  smoke: boolean;
  /** Seconds into the chunk video where the evidence is clearest (== frame offset within chunk). */
  evidenceS: number;
  notes?: string;
}

export interface ObservedRoad {
  street: string;
  nearBuildingId?: string;
  status: 'blocked' | 'partial' | 'clear';
  evidenceS: number;
  notes?: string;
}

export interface ObservedCrowd {
  place?: string;
  nearBuildingId?: string;
  approxCount: number;
  evidenceS: number;
}

/** POST /api/reconstruct request body. */
export interface ReconstructionRequest {
  chunkIndex: number;
  scenarioId: string;
  localHour: number;
  /** Frames in order; server encodes them at 1 fps so video second k == frames[k]. */
  frames: { index: number; flightS: number; simS: number; position: [number, number, number]; heading: number; jpegBase64: string; taggedBuildingIds: string[] }[];
  /** Candidate buildings (the AR-tagged ones) — geometry/identity only, NO predicted damage. */
  buildings: { id: string; tag: string; address?: string; name?: string; x: number; z: number; height: number; levels: number; use: string }[];
  /** Force mock/replay behaviour for debugging. */
  mode?: 'auto' | 'mock' | 'replay-only';
  /** M4: footage source (drone = low-altitude close-up orbit of targetBuildingIds). Default 'heli'. */
  source?: 'heli' | 'drone';
  droneId?: DroneId;
  missionId?: string;
  targetBuildingIds?: string[];
}

export interface ReconstructionResult {
  chunkIndex: number;
  model: string;
  mode: 'gemini' | 'replay' | 'mock';
  latencyMs: number;
  buildings: ObservedBuilding[];
  roads: ObservedRoad[];
  crowds: ObservedCrowd[];
  summary: string;
  error?: string;
}

/** Recon layer: applies results to the city, compares with prediction & truth (src/argus). */
export interface ReconHandle {
  /** M6: fuse analysed resident reports as low-weight evidence (revealed at revealS). Planner/Copilot ignore them. */
  applyReports?(res: ReportsResponse, reports: CitizenReport[], revealS: number): void;
  /** M6 (recon): revealed resident reports fused per building id (≤3 most credible each). NOT in observations(). */
  citizenEvidence?(): ReadonlyMap<string, readonly CitizenEvidence[]>;
  object: THREE.Object3D;
  /** Register the quake result + truth people for comparison. */
  begin(result: QuakeResult, people: PeopleTruth): void;
  apply(res: ReconstructionResult, chunk: ScanChunk): void;
  /** Show/hide the recon colouring + markers. */
  setVisible(on: boolean): void;
  /** Comparison over scanned+observed buildings. */
  stats(): ReconStats;
  /** Per-building comparison for the inspector (null if never observed). */
  compare(buildingId: string): BuildingComparison | null;
  reset(): void;
  /**
   * Optional (recon): time gate. Results are revealed once simSeconds ≥ their chunk's last frame simS, so
   * seeking back hides later results (pure function of simSeconds). Never called ⇒ everything applied is shown.
   */
  update?(simSeconds: number): void;
  /** Optional (recon): count a chunk as sent (stats.chunksSent; pending = sent − done). */
  markSent?(chunkIndex: number): void;
  /**
   * Optional (recon): temporarily strip building tints + markers (e.g. around the off-screen helicopter
   * capture so Argon never sees its own results) without changing setVisible. Commits the buildings texture.
   */
  suspend?(on: boolean): void;
  /** Optional (recon): applied results + chunk ids (debug / replay). */
  readonly results?: readonly ReconstructionResult[];
  /** M4 (recon): effective REVEALED observation per building id (drone outranks heli). Read-only view. */
  observations?(): ReadonlyMap<string, ReconObservation>;
  /** M4 (recon): effective revealed road / crowd observations (latest per street+building / place). */
  observedRoads?(): readonly ObservedRoad[];
  observedCrowds?(): readonly ObservedCrowd[];
}

/** M4: one effective observation with its provenance (ReconHandle.observations). */
export type ReconObservation = ObservedBuilding & {
  chunkIndex: number;
  flightS: number;
  source: 'heli' | 'drone';
  droneId?: DroneId;
  missionId?: string;
  /** simSeconds the result was revealed at. */
  revealS: number;
};

/** M3 UI: AIR 1 aerial reconstruction panel state (UiHandle.showAir). */
export interface AirUiState {
  callsign: string;
  status: 'standby' | 'en route' | 'scanning' | 'returning' | 'complete';
  flightS: number;
  durationS: number;
  scannedFraction: number;
  stats: ReconStats;
  /** Chunks sent and still awaiting a result. */
  pending: number;
  mode: 'gemini' | 'replay' | 'mock' | null;
  /** Optional: mean Argon latency (s) over completed chunks. */
  avgLatencyS?: number;
}

export interface ReconStats {
  chunksSent: number;
  chunksDone: number;
  buildingsObserved: number;
  /** Accuracy vs truth (exact HAZUS state, collapsed counted as complete) of the model's most-likely state, over observed buildings. */
  predictionAccuracy: number;
  /** Accuracy vs truth of Argon's observation over the same buildings. */
  reconAccuracy: number;
  /** Within-one-state accuracy (more forgiving). */
  predictionWithinOne: number;
  reconWithinOne: number;
  collapsesTruth: number;
  collapsesPredicted: number;
  collapsesObserved: number;
  peopleTruthVisible: number;
  peopleObserved: number;
  crowdsObserved: number;
  surprises: { id: string; predicted: DamageState; observed: ObservedDamage; truth: DamageState }[];
  lastSummary: string;
  model: string;
  mode: ReconstructionResult['mode'] | null;
  /** Optional: mean Argon latency (s) over completed chunks. */
  avgLatencyS?: number;
  /** Optional: candidate buildings in the revealed chunks (scanned + AR-tagged). */
  buildingsCovered?: number;
  /**
   * Optional (headline): xBD-style 4-class accuracy over the same buildings — no damage (DS0) / minor (DS1) /
   * major (DS2–3) / destroyed (DS4 or collapsed). Aerial footage cannot see interior damage; xBD is the standard
   * aerial damage scale. Prediction class = argmax of the model's class-aggregated probabilities.
   */
  predictionXbd?: number;
  reconXbd?: number;
  /**
   * Optional (headline): the model CORRECTED by Argon — Bayesian fusion per observed building (model's xBD class
   * probabilities as prior × Argon observation likelihood weighted by its confidence). Same buildings as above.
   */
  fusedXbd?: number;
  /** xBD macro-F1 (mean per-class F1; the xBD challenge's damage score) for model / Argon / model+Argon. */
  predictionF1?: number;
  reconF1?: number;
  fusedF1?: number;
  /** Balanced accuracy (mean per-class recall) for model / Argon / model+Argon. */
  predictionBal?: number;
  reconBal?: number;
  fusedBal?: number;
  /** M6: resident reports fused so far (analysed, linked to a building). */
  citizenReports?: number;
  /** M4: accuracy timeline, one point per applied result (audience only — never sent to Argon). */
  history?: ReconHistoryPoint[];
  /** M4: buildings observed by drones / confirmed collapses so far. */
  droneObserved?: number;
  /** Fixed-set (whole core area) metrics, same definitions as ReconHistoryPoint.city*. */
  cityPredictionF1?: number;
  cityFusedF1?: number;
  cityPredictionXbd?: number;
  cityFusedXbd?: number;
  cityBuildings?: number;
}

export interface BuildingComparison {
  id: string;
  predicted: { mostLikely: DamageState; pCollapse: number; probs: [number, number, number, number, number] };
  observed: ObservedBuilding & { chunkIndex: number; flightS: number };
  truth: { state: DamageState; collapsed: boolean; trappedVisible: number; trappedHidden: number };
}

// ═════════════════════════════ M4: Argon-planned drone verification (human-approved) ═════════════════════════════
//
// After helicopter reconstruction results arrive, gemini-4-argon is asked (text-only, fast) whether to dispatch
// drones and where. It reasons over UNCERTAINTY (unscanned areas, low-confidence calls, model/observation
// disagreement, people at risk) — never over truth-based accuracy. A proposed plan pauses the sim and shows a
// plan card; the commander clicks Approve (or Reject). Approved missions fly 3 drones (D1–D3) from a staging
// point; each orbits its targets at low altitude, frames go to /api/reconstruct (source 'drone'), and the recon
// layer updates (drone observations outrank helicopter ones). At most 2 approved waves. Scenario: 1906 repeat.

export type DroneId = 'D1' | 'D2' | 'D3';

export interface DroneMission {
  id: string; // "W1-D1"
  wave: 1 | 2;
  droneId: DroneId;
  kind: 'verify_building' | 'survey_area';
  /** 1–4 buildings to inspect, in order (survey_area: buildings around the area centre). Must be candidate ids. */
  targetBuildingIds: string[];
  areaCentre?: XZ;
  /** Argon's reason, shown to the commander. */
  purpose: string;
  priority: number; // 1 = highest
}

export interface DronePlan {
  wave: 1 | 2;
  /** false = Argon recommends holding for now (holdReason says why). */
  dispatch: boolean;
  rationale: string;
  holdReason?: string;
  missions: DroneMission[];
  model: string;
  mode: 'gemini' | 'replay' | 'mock';
  latencyMs: number;
  createdAtSimS: number;
  error?: string;
}

export interface PlanCandidate {
  id: string; // candidate id == building id for building targets, "A-<n>" for areas
  buildingId?: string;
  /** M4 (planner): area candidates — the 2–4 building ids of the cluster (a mission targeting the area expands to these). */
  buildingIds?: string[];
  /** M4 (planner): candidate category: unscanned risk / seen-not-assessed / low-confidence severe / disagreement / fire. */
  kind?: 'unscanned' | 'unassessed' | 'low_confidence' | 'disagreement' | 'fire';
  label: string; // "401 Washington St (B3291)"
  x: number;
  z: number;
  scanned: boolean;
  observed?: ObservedDamage;
  observedConfidence?: number;
  predicted: { mostLikely: DamageState; pMajorPlus: number; pDestroyed: number };
  occupants: number;
  peopleSeen?: number;
  fire?: boolean;
  /** Why it is a candidate (e.g. "unscanned URM cluster", "low-confidence collapse call", "model/observation disagree"). */
  reason: string;
  /** Code-side priority score (higher = more valuable to inspect). */
  score: number;
  distanceFromBaseM: number;
}

/** POST /api/plan request body. */
export interface PlanRequest {
  scenarioId: string;
  localHour: number;
  simS: number;
  wave: 1 | 2;
  dronesAvailable: DroneId[];
  drone: { speedMs: number; altitudeAGL: number; orbitS: number; base: XZ; enduranceS: number };
  coverage: { scannedFraction: number; heliStatus: string; chunksDone: number; chunksTotal: number };
  situation: {
    collapsesObserved: { id: string; label: string; confidence: number }[];
    peopleSeen: number;
    crowds: { place: string; approxCount: number }[];
    fires: string[];
    blockedRoads: string[];
    latestSummary: string;
  };
  candidates: PlanCandidate[];
  previousPlans?: { wave: number; approved: boolean; missions: string[]; outcome?: string }[];
  mode?: 'auto' | 'replay-only';
}

export type DronePhase = 'idle' | 'transit' | 'orbit' | 'return' | 'done';

export interface DronePose extends HeliPose {
  droneId: DroneId;
  phase: DronePhase;
  missionId?: string;
  /** Index into the mission's targetBuildingIds while orbiting/transiting. */
  targetIndex?: number;
}

export interface DroneScheduleEntry {
  missionId: string;
  droneId: DroneId;
  startS: number;
  targets: { buildingId: string; arriveS: number; leaveS: number }[];
  endS: number;
}

export interface DroneFleetHandle {
  object: THREE.Object3D;
  base: XZ;
  speedMs: number;
  altitudeAGL: number;
  orbitS: number;
  enduranceS: number;
  /** Schedule approved missions starting at startSimS (deterministic flight plan from then on). */
  assign(missions: DroneMission[], startSimS: number): void;
  /** Deterministic poses of all 3 drones at simS (idle drones sit at the base). */
  posesAt(simS: number): DronePose[];
  /** Update visuals (drones, rotors, paths, target markers, footprints) to simS. */
  setTime(simS: number): void;
  schedule(): DroneScheduleEntry[];
  /** Drones free (not on a mission) at simS. */
  available(simS: number): DroneId[];
  reset(): void;
}

/** One point of the live accuracy timeline (for the audience; never sent to Argon). */
export interface ReconHistoryPoint {
  simS: number;
  source: 'heli' | 'drone' | 'citizen';
  observed: number;
  predictionF1: number;
  reconF1: number;
  fusedF1: number;
  fusedXbd: number;
  collapsesConfirmed: number;
  peopleSeen: number;
  /**
   * Fixed-set metrics over EVERY core-area building (the denominator never changes): observed buildings use the
   * model+Argon estimate, unobserved ones the model prediction. Model-only is therefore constant and the
   * corrected curve can only move as observations replace predictions.
   */
  cityPredictionF1?: number;
  cityFusedF1?: number;
  cityPredictionXbd?: number;
  cityFusedXbd?: number;
  cityBuildings?: number;
}

export type PlanUiState = 'thinking' | 'hold' | 'proposed' | 'approved' | 'rejected' | 'executing' | 'done';

export interface DroneFeed {
  droneId: DroneId;
  phase: DronePhase;
  label: string; // "D1 · orbit 401 Washington St"
  jpegBase64: string | null; // latest captured frame
  missionId?: string;
}

// ═════════════════════════════ M5: Argus Copilot — rescue planning chat ═════════════════════════════
//
// The commander asks in a chat drawer (right side), e.g. "I have 10 engines, 20 officers and 2 helicopters —
// how do I route them and what are the priorities?". Code packages the current situation (Argon-verified
// incidents + unverified model risk, verified/likely blocked roads, real facilities, road-network ETAs —
// NEVER truth). gemini-4-argon returns a reply + a structured RescuePlan; code computes the actual routes on
// the road graph and the 3D rescue layer draws them (flowing route ribbons, moving units, priority markers).
// Units move only after the commander clicks Dispatch.

export type UnitType = 'engine' | 'truck' | 'usar' | 'ambulance' | 'police' | 'helicopter';
export type FacilityKind = 'fire_station' | 'police_station' | 'hospital' | 'staging' | 'helipad';

export interface Facility {
  id: string; // "SFFD-13", "SFPD-CENTRAL", "HOSP-CHINESE", "STAGE-EMB"
  kind: FacilityKind;
  name: string;
  address?: string;
  lat: number;
  lon: number;
  x: number;
  z: number;
  /** Units normally based here (defaults; the commander's numbers override). */
  units?: Partial<Record<UnitType, number>>;
}

export type IncidentKind = 'trapped' | 'fire' | 'suspected_collapse' | 'crowd' | 'collapse';

export interface RescueIncident {
  id: string; // "I-B3291", "I-CROWD-2"
  kind: IncidentKind;
  buildingId?: string;
  label: string; // "401 Washington St (B3291)"
  x: number;
  z: number;
  /** true = seen by Argon in helicopter/drone footage; false = model-predicted risk only. */
  verified: boolean;
  confidence: number;
  damage?: ObservedDamage;
  peopleSeen?: number;
  trappedSigns?: boolean;
  fire?: boolean;
  crowdSize?: number;
  /** Building occupants at this hour (database estimate). */
  occupants?: number;
  /** Model probability of destruction (unverified incidents). */
  pDestroyed?: number;
  evidence?: string; // "drone D2 · W1 · t+14 s" / "AIR 1 chunk 3"
}

export interface RoadStatus {
  roadId: string;
  segment: number;
  name?: string;
  status: 'verified_blocked' | 'likely_blocked' | 'partial';
  source: 'argon' | 'model';
}

export interface RouteResult {
  mode: 'road' | 'air';
  reachable: boolean;
  /** World-space polyline (x, y, z) following streets (road) or an arc (air). */
  points: [number, number, number][];
  lengthM: number;
  etaMin: number;
  avoidedBlocked: number;
  passesLikelyBlocked: boolean;
  /** Street names along the route, in order, deduplicated. */
  via: string[];
}

export interface TravelTime {
  fromFacilityId: string;
  incidentId: string;
  roadMin: number | null; // null = unreachable by road
  airMin: number;
  passesLikelyBlocked: boolean;
}

export interface RouterHandle {
  /** Verified/likely road blockages to respect (verified = impassable, likely = heavy time penalty). */
  setRoadStatus(list: RoadStatus[]): void;
  route(from: XZ, to: XZ, opts?: { unitType?: UnitType }): RouteResult;
  travelTimes(facilities: Facility[], incidents: RescueIncident[]): TravelTime[];
}

export interface CopilotSituation {
  scenarioId: string;
  simS: number;
  localTime: string; // "15:07 PDT"
  minutesSinceQuake: number;
  summary: {
    buildingsAssessed: number;
    collapsesVerified: number;
    peopleSeen: number;
    trappedSitesVerified: number;
    fires: number;
    crowds: number;
    areaScannedPct: number;
    latestArgonSummary: string;
  };
  incidents: RescueIncident[];
  roads: RoadStatus[];
  facilities: Facility[];
  travelTimes: TravelTime[];
}

export interface RescuePlan {
  priorities: { rank: number; incidentId: string; reason: string }[];
  assignments: { unitType: UnitType; count: number; fromFacilityId: string; incidentId: string; task: string }[];
  routeClearing: { roadName: string; unitType: UnitType; reason: string }[];
  reassessInMinutes: number;
  assumptions?: string[];
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** POST /api/chat request body. */
export interface ChatRequest {
  messages: ChatTurn[]; // full history, last = the new user question
  situation: CopilotSituation;
  mode?: 'auto' | 'replay-only';
}

export interface ChatResponse {
  reply: string; // markdown
  plan: RescuePlan | null;
  model: string;
  mode: 'gemini' | 'replay' | 'mock';
  latencyMs: number;
  error?: string;
}

export interface ChatMessage extends ChatTurn {
  id: string;
  at: number; // simS when asked/answered
  plan?: RescuePlan | null;
  mode?: ChatResponse['mode'];
  latencyMs?: number;
  /** UI state of the plan attached to this message. */
  planState?: 'none' | 'shown' | 'dispatched';
}

/** One routed assignment ready to draw / animate. */
export interface RoutedAssignment {
  key: string; // "a0-2" (assignment 0, unit 2)
  unitType: UnitType;
  fromFacilityId: string;
  incidentId: string;
  task: string;
  route: RouteResult;
}

export interface RescueLayerHandle {
  object: THREE.Object3D;
  /** Draw a plan: routes (static, flowing), incident priority markers, used facilities. Replaces any previous plan. */
  show(plan: RescuePlan, situation: CopilotSituation, routed: RoutedAssignment[]): void;
  /** Start moving units along their routes (visual clock; ETA labels count down). */
  dispatch(): void;
  readonly dispatched: boolean;
  setHighlight(incidentId: string | null): void;
  clear(): void;
}

// ═════════════════════════════ M6: Resident reports (community app) — a side channel that sharpens the model ═════════════════════════════
//
// Simulated residents post short reports from a community app (SF311-style): text + GPS. They are generated from
// the truth world with realistic noise (wrong building, exaggeration, false alarms, "my building is fine"), like
// the helicopter footage is rendered from it. Batches go to gemini-4-argon (/api/reports), which links each report
// to a building, reads damage / trapped / hazards and rates credibility. The recon layer fuses them as a THIRD,
// lower-weight evidence source (and in the spatial correction). Drone planning and the Copilot do NOT use them.

export type ReportCategory = 'damage' | 'trapped' | 'fire' | 'gas' | 'road' | 'ok';

export interface CitizenReport {
  id: string; // "R-0042"
  simS: number; // when it is posted
  lat: number;
  lon: number;
  x: number;
  z: number;
  /** GPS accuracy (m) — the phone fix wanders. */
  accuracyM: number;
  text: string;
  lang: 'en' | 'zh' | 'es';
  category: ReportCategory;
  /** Display-only reporter handle, e.g. "Resident · Chinatown". */
  reporter: string;
  /** HIDDEN (evaluation only, never sent to Argon): the building the reporter really means and how. */
  truthRef?: { buildingId: string | null; kind: 'self' | 'neighbor' | 'false_alarm' | 'street' };
}

export interface ReportAnalysis {
  reportId: string;
  /** Building Argon linked the report to (null if it could not / road / not a building). */
  buildingId: string | null;
  damage: ObservedDamage | null;
  peopleTrapped: number;
  hazards: string[]; // "fire", "gas", "blocked road"…
  /** 0..1 — Argon's credibility of the report (specificity, consistency, duplicates). */
  credibility: number;
  duplicateOf?: string;
  note?: string; // short Argon note shown on the toast ("linked to B3291 · consistent with AIR 1")
}

/** POST /api/reports request body. */
export interface ReportsRequest {
  batchIndex: number;
  scenarioId: string;
  localHour: number;
  reports: {
    id: string;
    simS: number;
    text: string;
    lang: CitizenReport['lang'];
    x: number;
    z: number;
    accuracyM: number;
    /** Nearest buildings to the GPS fix (identity only, no damage info). */
    candidates: { id: string; label: string; distanceM: number; use: string; levels: number }[];
  }[];
  mode?: 'auto' | 'replay-only';
}

export interface ReportsResponse {
  batchIndex: number;
  analyses: ReportAnalysis[];
  summary: string;
  model: string;
  mode: 'gemini' | 'replay' | 'mock';
  latencyMs: number;
  error?: string;
}

export interface ReportItem {
  report: CitizenReport;
  analysis: ReportAnalysis | null; // null = waiting for Argon
}

/** M6 (recon): one resident report fused on a building (ReconHandle.citizenEvidence). confidence = credibility × 0.6. */
export interface CitizenEvidence {
  source: 'citizen';
  reportId: string;
  /** Building the report is fused on (anchor of a part). */
  buildingId: string;
  damage: ObservedDamage;
  confidence: number;
  credibility: number;
  peopleTrapped: number;
  hazards: string[];
  revealS: number;
  /** Report GPS fix (falls back to the building centroid). */
  x: number;
  z: number;
}
