/**
 * Glue between the flight model and the 3D world: reads the pilot's input, measures the
 * ground and obstacles by ray-casting the photorealistic tiles, steps the physics and produces
 * the drone camera pose (gimbal-stabilised: level horizon, fixed tilt, smoothed yaw).
 * Runs inside CameraDirector's frame callback, so input -> camera has zero frames of latency.
 */
import { Raycaster, Vector3, type Intersection } from 'three';
import type { CameraSample } from '../camera/flyIn';
import { FLAGS } from '../config';
import { POIS, TAHOE } from '../geo/locations';
import { enuVectors, geodeticToEcef, quaternionFromHeadingPitchRoll, wrap180, wrap360, type Geodetic } from '../geo/wgs84';
import { runtime, tilesLoading } from '../scene/runtime';
import { waterSurfaceAt } from '../scene/WaterSurface';
import { world } from '../world/handles';
import { insideScene, SCENE_FRAME_INV, SCENE_LAKE_LEVEL } from '../world/scene';
import { MotorAudio } from './audio';
import type { DroneController } from './controller';
import { DroneInput } from './input';
import {
  bearing,
  createDroneState,
  heightAboveGround,
  neutralSticks,
  probeDirection,
  resetToHome,
  stepDrone,
  toggleTakeoffLanding,
  type DroneEnv,
  type DroneState,
  type DroneStatus,
  type Sticks,
} from './physics';
import { DRONE, MODE_ORDER, MODES, type FlightMode } from './specs';

export interface LaunchSite {
  name: string;
  /** ground position (ellipsoidal height is only a first guess; the tiles are ray-cast) */
  position: Geodetic;
  heading: number;
}

/**
 * Vikingsholm beach, at the head of Emerald Bay, facing Fannette Island down the bay.
 * Chosen on the lidar scene (tools/scene): flat sand ~0.8 m above the lake, 12 m from the
 * water, the nearest tree crown 16 m away, open water ahead. The height is refined by
 * ray-casting before take-off.
 */
const VIKINGSHOLM_BEACH_POSITION = { lat: 38.95312, lon: -120.106518, height: TAHOE.lakeEllipsoidHeight + 2 };
export const VIKINGSHOLM_BEACH: LaunchSite = {
  name: 'Vikingsholm Beach',
  position: VIKINGSHOLM_BEACH_POSITION,
  heading: bearing(VIKINGSHOLM_BEACH_POSITION, POIS.fannetteIsland),
};

/** The launch site in use: ?launch= override, else the default. */
export function launchSite(): LaunchSite {
  const o = FLAGS.launch;
  if (o == null) return VIKINGSHOLM_BEACH;
  const position = { lat: o.lat, lon: o.lon, height: TAHOE.lakeEllipsoidHeight };
  return { name: 'Custom launch', position, heading: o.heading ?? bearing(position, POIS.fannetteIsland) };
}

/** Discrete state the React UI renders (pushed only when it changes). */
export interface DroneUi {
  status: DroneStatus;
  mode: FlightMode;
  grid: boolean;
  help: boolean;
  muted: boolean;
  gamepad: boolean;
}

export interface DroneHooks {
  onUi(ui: DroneUi): void;
  onExit(): void;
  /** the area around the drone has streamed in: safe to reveal the view */
  onReady(): void;
}

const GROUND_PROBE_ABOVE_FLYING = 1.5;
const GROUND_PROBE_ABOVE_LANDED = 60;
/** ellipsoidal height above any terrain the drone could launch from (Sierra peaks are < 4.5 km) */
const LAUNCH_PROBE_HEIGHT = 9000;
const OBSTACLE_RANGE = 45;
const HELP_AUTOHIDE_AFTER_TAKEOFF = 5;

const _up = new Vector3();
const _east = new Vector3();
const _north = new Vector3();
const _origin = new Vector3();
const _dir = new Vector3();
const _down = new Vector3();
const _above = new Vector3();

const _probeRay = new Raycaster();
(_probeRay as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
const _probeHits: Intersection[] = [];
const _probeOrigin = new Vector3();
const _probeDown = new Vector3();
const _probeE = new Vector3();
const _probeN = new Vector3();

/** Ellipsoidal height of the first loaded tile surface at lat/lon (cast from `from` m ellipsoidal). */
export function surfaceHeightAt(lat: number, lon: number, from = 4000): number | null {
  enuVectors(lat, lon, _probeE, _probeN, _probeDown);
  _probeDown.negate();
  geodeticToEcef(lat, lon, from, _probeOrigin);
  const target = collisionGroup(_probeOrigin);
  if (target == null) return null;
  _probeRay.set(_probeOrigin, _probeDown);
  _probeRay.far = from + 500;
  _probeHits.length = 0;
  _probeRay.intersectObject(target, true, _probeHits);
  const hit = _probeHits[0];
  return hit != null ? from - hit.distance : null;
}

const _enu = new Vector3();
const _enuDir = new Vector3();
/** Ellipsoidal height of the custom scene's lake surface. */
const SCENE_LAKE_ELLIPSOID = TAHOE.lakeEllipsoidHeight + SCENE_LAKE_LEVEL;

/** true when an ECEF point is over the custom lidar scene and its terrain is streaming. */
export function inCustomScene(ecef: Vector3): boolean {
  return FLAGS.scene && world.terrain?.root != null && insideScene(_enu.copy(ecef).applyMatrix4(SCENE_FRAME_INV), 30);
}

/** What the drone collides with at an ECEF point: the lidar terrain inside the scene, else Google. */
function collisionGroup(ecef: Vector3) {
  if (inCustomScene(ecef)) return world.terrain!.group;
  return runtime.tiles?.group ?? null;
}

/** Camera sample for the drone resting at a launch site (used while the scene loads). */
export function launchCameraSample(site: LaunchSite, out: CameraSample): CameraSample {
  const p = site.position;
  geodeticToEcef(p.lat, p.lon, p.height + DRONE.restHeight, out.position);
  quaternionFromHeadingPitchRoll(p.lat, p.lon, site.heading, DRONE.gimbalPitch, 0, out.quaternion);
  out.fov = DRONE.fov;
  return out;
}

export class DroneSim implements DroneController {
  readonly state: DroneState;
  readonly sticks: Sticks = neutralSticks();
  ui: DroneUi;
  /** camera height above whatever is below it (for the near plane) */
  cameraAgl: number = DRONE.restHeight;
  /** ms spent ray-casting last frame */
  raycastMs = 0;
  preparing = true;

  private readonly input = new DroneInput();
  private readonly audio = new MotorAudio();
  private readonly raycaster = new Raycaster();
  private readonly hits: Intersection[] = [];
  private detachInput: (() => void) | null = null;
  private cameraHeading: number;
  private crashBlend = 0;
  private spin = 0;
  private prepSeconds = 0;
  private quietSeconds = 0;
  private groundFound = false;
  private sinceTakeoff = -1;
  private helpPinned = false;
  private readonly env: DroneEnv = { groundHeight: null, obstacleDistance: null };
  private overWater = false;
  /** the current crash was a landing on the water */
  splashed = false;

  constructor(
    readonly site: LaunchSite,
    private readonly hooks: DroneHooks,
    mode: FlightMode = 'normal',
  ) {
    this.state = createDroneState(site.position, site.heading, mode);
    this.cameraHeading = this.state.heading;
    this.ui = { status: 'grounded', mode, grid: false, help: true, muted: false, gamepad: false };
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  }

  attach(): void {
    this.detachInput ??= this.input.attach(() => this.audio.unlock());
  }

  dispose(): void {
    this.detachInput?.();
    this.detachInput = null;
    this.audio.dispose();
  }

  /** UI buttons call these (same as the keys). */
  takeoffOrLand(): void {
    this.audio.unlock();
    if (!this.preparing) toggleTakeoffLanding(this.state);
  }

  setMode(mode: FlightMode): void {
    this.state.mode = mode;
  }

  /** Back to the launch site, landed (only when crashed or already on the ground). */
  reset(): void {
    const s = this.state;
    if (s.status !== 'crashed' && s.status !== 'grounded') return;
    resetToHome(s, this.site.heading);
    this.cameraHeading = s.heading;
    this.crashBlend = 0;
  }

  /** published on the next frame */
  toggleHelp(): void {
    this.ui = { ...this.ui, help: !this.ui.help };
    this.helpPinned = this.ui.help;
  }

  step(dt: number, out: CameraSample): void {
    const s = this.state;
    const actions = this.input.read(dt, this.sticks);
    if (this.preparing) Object.assign(this.sticks, neutralSticks());
    else this.applyActions(actions);

    const t0 = performance.now();
    this.measure();
    this.raycastMs = performance.now() - t0;
    // Until the first take-off, home sits exactly on the measured ground (the site's height is a guess).
    if (s.status === 'grounded' && s.airborneSeconds === 0 && this.env.groundHeight != null) s.home.height = this.env.groundHeight;

    const before = s.status;
    stepDrone(s, this.sticks, dt, this.env);
    // Touching down on the lake is a splashdown.
    if (this.overWater && before !== 'grounded' && s.status === 'grounded') {
      s.status = 'crashed';
      s.crashSeconds = 0;
      this.splashed = true;
    }
    if (s.status !== 'crashed') this.splashed = false;
    if (before !== 'flying' && s.status === 'takeoff') this.sinceTakeoff = 0;
    if (this.sinceTakeoff >= 0) {
      this.sinceTakeoff += dt;
      if (this.sinceTakeoff > HELP_AUTOHIDE_AFTER_TAKEOFF && this.ui.help && !this.helpPinned) {
        this.ui = { ...this.ui, help: false };
      }
    }

    // Gimbal: level horizon, pilot-set tilt, yaw follows the airframe with a little smoothing.
    const m = MODES[s.mode];
    this.cameraHeading = wrap360(this.cameraHeading + wrap180(s.heading - this.cameraHeading) * (1 - Math.exp(-dt / m.gimbalYawTau)));
    this.crashBlend += ((s.status === 'crashed' ? 1 : 0) - this.crashBlend) * (1 - Math.exp(-dt / 0.18));
    const pitch = s.gimbalPitch - 30 * this.crashBlend;
    const roll = 24 * this.crashBlend;
    geodeticToEcef(s.lat, s.lon, s.height, out.position);
    quaternionFromHeadingPitchRoll(s.lat, s.lon, this.cameraHeading, pitch, roll, out.quaternion);
    out.fov = DRONE.fov;
    this.cameraAgl = Math.max(0.05, heightAboveGround(s));

    this.updateAudio(dt);
    this.updateReadiness(dt);
    this.publishUi();
  }

  private applyActions(a: ReturnType<DroneInput['read']>): void {
    const s = this.state;
    if (a.exit) {
      this.hooks.onExit();
      return;
    }
    if (a.takeoffLand) toggleTakeoffLanding(s);
    if (a.mode) s.mode = a.mode;
    if (a.modeStep !== 0) {
      const i = MODE_ORDER.indexOf(s.mode);
      s.mode = MODE_ORDER[Math.max(0, Math.min(MODE_ORDER.length - 1, i + a.modeStep))]!;
    }
    if (a.reset) this.reset();
    if (a.grid) this.ui = { ...this.ui, grid: !this.ui.grid };
    if (a.help) {
      this.ui = { ...this.ui, help: !this.ui.help };
      this.helpPinned = this.ui.help;
    }
    if (a.mute) {
      this.audio.muted = !this.audio.muted;
      this.ui = { ...this.ui, muted: this.audio.muted };
    }
  }

  /** Ray-cast the loaded tiles: surface straight below, and obstacles along the travel direction. */
  private measure(): void {
    const s = this.state;
    const env = this.env;
    env.groundHeight = null;
    env.obstacleDistance = null;
    const tiles = runtime.tiles;
    if (tiles == null) return;

    enuVectors(s.lat, s.lon, _east, _north, _up);
    geodeticToEcef(s.lat, s.lon, s.height, _origin);

    // Before the first take-off the launch height is only a guess (it may even be underground):
    // probe from far above any terrain. Landed: from well above, so a refined tile that pokes up
    // through the legs is found. Flying: from just above, so overhangs don't count as ground.
    const onLaunchPad = s.status === 'grounded' && s.airborneSeconds === 0;
    const above = onLaunchPad
      ? Math.max(GROUND_PROBE_ABOVE_LANDED, LAUNCH_PROBE_HEIGHT - s.height)
      : s.status === 'grounded' || s.status === 'crashed'
        ? GROUND_PROBE_ABOVE_LANDED
        : GROUND_PROBE_ABOVE_FLYING;
    const hit = this.cast(_above.copy(_origin).addScaledVector(_up, above), _down.copy(_up).negate(), above + 8000);
    if (hit != null) {
      env.groundHeight = s.height + above - hit;
      this.groundFound = true;
    }
    if (inCustomScene(_origin)) {
      // the lidar terrain's lake is a flat surface at the water level
      this.overWater = env.groundHeight != null && Math.abs(env.groundHeight - SCENE_LAKE_ELLIPSOID) < 0.12;
    } else {
      // Over the lake the surface is the water, not the (visible-through-clear-water) bottom.
      const water = waterSurfaceAt(s.lat, s.lon);
      this.overWater = water != null && (env.groundHeight == null || water > env.groundHeight);
      if (this.overWater) env.groundHeight = water;
    }

    const probe = probeDirection(s, this.sticks);
    if (probe != null) {
      _dir.copy(_east).multiplyScalar(probe.east).addScaledVector(_north, probe.north).normalize();
      const d = this.cast(_origin, _dir, OBSTACLE_RANGE);
      if (d != null) env.obstacleDistance = d;
    }
  }

  private cast(origin: Vector3, dir: Vector3, far: number): number | null {
    const target = collisionGroup(origin);
    if (target == null) return null;
    this.raycaster.set(origin, dir);
    this.raycaster.near = 0;
    this.raycaster.far = far;
    this.hits.length = 0;
    this.raycaster.intersectObject(target, true, this.hits);
    const hit = this.hits[0];
    let best = hit != null && Number.isFinite(hit.distance) ? hit.distance : null;
    // hand-built props (the Tea House): plain meshes in world space
    for (const prop of world.props) {
      this.hits.length = 0;
      this.raycaster.far = best ?? far;
      this.raycaster.intersectObject(prop, true, this.hits);
      const h = this.hits[0];
      if (h != null && (best == null || h.distance < best)) best = h.distance;
    }
    // the lidar forest: trunks and crowns (analytic, in the scene ENU frame)
    if (world.forestRaycast != null && inCustomScene(origin)) {
      _enu.copy(origin).applyMatrix4(SCENE_FRAME_INV);
      _enuDir.copy(dir).transformDirection(SCENE_FRAME_INV);
      const d = world.forestRaycast(_enu, _enuDir, best ?? far);
      if (d != null && (best == null || d < best)) best = d;
    }
    return best;
  }

  private updateAudio(dt: number): void {
    const s = this.state;
    const m = MODES[s.mode];
    const running = s.status === 'takeoff' || s.status === 'flying' || s.status === 'landing';
    this.spin += ((running ? 1 : 0) - this.spin) * (1 - Math.exp(-dt / (running ? 0.35 : 0.6)));
    const load =
      0.45 * Math.max(0, s.vUp) / m.maxAscent +
      0.35 * Math.hypot(s.vEast, s.vNorth) / m.maxHorizontal +
      0.2 * Math.abs(s.yawRate) / m.maxYawRate;
    this.audio.update(this.spin, load);
  }

  private updateReadiness(dt: number): void {
    if (!this.preparing) return;
    this.prepSeconds += dt;
    this.quietSeconds = tilesLoading() || tilesLoading(world.terrain) ? 0 : this.quietSeconds + dt;
    const ready = (this.groundFound && this.prepSeconds > 1.2 && this.quietSeconds > 0.8) || this.prepSeconds > 14;
    if (ready) {
      this.preparing = false;
      this.hooks.onReady();
    }
  }

  private publishUi(): void {
    const s = this.state;
    const next: DroneUi = { ...this.ui, status: s.status, mode: s.mode, gamepad: this.input.gamepadConnected };
    this.ui = next;
    const prev = this.published;
    if (
      prev == null ||
      next.status !== prev.status ||
      next.mode !== prev.mode ||
      next.gamepad !== prev.gamepad ||
      next.grid !== prev.grid ||
      next.help !== prev.help ||
      next.muted !== prev.muted
    ) {
      this.published = next;
      this.hooks.onUi(next);
    }
  }
  private published: DroneUi | null = null;
}
