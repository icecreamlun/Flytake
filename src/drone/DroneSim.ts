/**
 * Glue between the flight model and the 3D world: reads the pilot's input, measures the
 * ground and obstacles by ray-casting the photorealistic tiles, steps the physics and produces
 * the drone camera pose (gimbal-stabilised: level horizon, fixed tilt, smoothed yaw).
 * Runs inside CameraDirector's frame callback, so input -> camera has zero frames of latency.
 */
import { Group, Matrix4, Raycaster, Vector3, type Intersection, type Mesh } from 'three';
import type { CameraSample } from '../camera/flyIn';
import { FLAGS } from '../config';
import { POIS, TAHOE } from '../geo/locations';
import { enuToEcefMatrix, enuVectors, geodeticToEcef, quaternionFromHeadingPitchRoll, wrap180, wrap360, type Geodetic } from '../geo/wgs84';
import { runtime, tilesLoading } from '../scene/runtime';
import { waterSurfaceAt } from '../scene/WaterSurface';
import { world } from '../world/handles';
import { insideScene, SCENE_FRAME_INV, SCENE_LAKE_LEVEL } from '../world/scene';
import { MotorAudio } from './audio';
import type { DroneController } from './controller';
import { DroneInput } from './input';
import { CHASE, DroneModel, MODEL_DROP } from './model';
import { DRONE_CENTER_ENU, preLitDroneMaterial } from './preLitModel';
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
/** fpv: the gimbal camera; chase: behind and above the drone, which is in view */
export type DroneView = 'fpv' | 'chase';

export interface DroneUi {
  status: DroneStatus;
  mode: FlightMode;
  grid: boolean;
  help: boolean;
  muted: boolean;
  gamepad: boolean;
  view: DroneView;
  /** obstacle avoidance switched on (DroneState.avoidance) */
  avoidance: boolean;
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
const _drone = new Vector3();
const _look = new Matrix4();
/** the model is Y-up / nose -Z; the drone's ENU frame is Z-up / north +Y */
const Y_UP_TO_ENU = new Matrix4().makeRotationX(Math.PI / 2);
const DEG = Math.PI / 180;
/** a crashed drone rolls over this fast while it falls, deg/s */
export const TUMBLE_RATE = 320;

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
  /** degrees the crashed drone has rolled over while falling */
  private tumble = 0;
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
  /** chase view: the drone model and the camera's lagging heading */
  private readonly model = new DroneModel(preLitDroneMaterial);
  private readonly modelRoot = new Group();
  private chaseHeading: number;

  constructor(
    readonly site: LaunchSite,
    private readonly hooks: DroneHooks,
    mode: FlightMode = 'normal',
  ) {
    this.state = createDroneState(site.position, site.heading, mode);
    this.cameraHeading = this.state.heading;
    this.ui = { status: 'grounded', mode, grid: false, help: true, muted: false, gamepad: false, view: 'fpv', avoidance: false };
    this.chaseHeading = this.state.heading;
    this.modelRoot.matrixAutoUpdate = false;
    this.modelRoot.visible = false;
    this.modelRoot.add(this.model.object);
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  }

  attach(): void {
    this.detachInput ??= this.input.attach(() => this.audio.unlock());
    if (this.modelRoot.parent == null) runtime.scene?.add(this.modelRoot);
  }

  dispose(): void {
    this.detachInput?.();
    this.detachInput = null;
    this.audio.dispose();
    this.modelRoot.removeFromParent();
    disposeModel(this.modelRoot);
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
    this.tumble = 0;
  }

  /** published on the next frame */
  toggleHelp(): void {
    this.ui = { ...this.ui, help: !this.ui.help };
    this.helpPinned = this.ui.help;
  }

  toggleView(): void {
    this.ui = { ...this.ui, view: this.ui.view === 'fpv' ? 'chase' : 'fpv' };
  }

  toggleAvoidance(): void {
    this.state.avoidance = !this.state.avoidance;
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
    // Crashed in the air: the airframe tumbles all the way down and stays as it lands.
    if (s.status !== 'crashed') this.tumble = 0;
    else if (heightAboveGround(s) > DRONE.restHeight + 0.15) this.tumble += TUMBLE_RATE * dt;
    const pitch = s.gimbalPitch - 30 * this.crashBlend;
    const roll = 24 * this.crashBlend + this.tumble;
    geodeticToEcef(s.lat, s.lon, s.height, out.position);
    quaternionFromHeadingPitchRoll(s.lat, s.lon, this.cameraHeading, pitch, roll, out.quaternion);
    out.fov = DRONE.fov;
    this.cameraAgl = Math.max(0.05, heightAboveGround(s));
    if (this.ui.view === 'chase') this.chase(dt, out);
    else {
      this.modelRoot.visible = false;
      this.chaseHeading = this.cameraHeading;
    }

    this.updateAudio(dt);
    this.updateReadiness(dt);
    this.publishUi();
  }

  /** Chase view: the camera behind and above the drone (pulled in if something is in between), looking at it. */
  private chase(dt: number, out: CameraSample): void {
    const s = this.state;
    this.chaseHeading = wrap360(this.chaseHeading + wrap180(s.heading - this.chaseHeading) * (1 - Math.exp(-dt / CHASE.headingTau)));
    // the model's centre, not the first-person camera, is what stays mid-frame
    geodeticToEcef(s.lat, s.lon, s.height - MODEL_DROP, _drone);
    enuVectors(s.lat, s.lon, _east, _north, _up);
    const h = this.chaseHeading * DEG;
    _dir.copy(_north).multiplyScalar(-Math.cos(h)).addScaledVector(_east, -Math.sin(h)).multiplyScalar(CHASE.distance).addScaledVector(_up, CHASE.height);
    const len = _dir.length();
    _dir.divideScalar(len);
    const hit = this.cast(_drone, _dir, len + 0.3);
    const dist = hit == null ? len : Math.max(CHASE.minDistance, Math.min(len, hit - 0.3));
    out.position.copy(_drone).addScaledVector(_dir, dist);
    out.quaternion.setFromRotationMatrix(_look.lookAt(out.position, _drone, _up));
    // the drone must stay in front of the near plane
    this.cameraAgl = Math.min(this.cameraAgl, 1.2);

    enuToEcefMatrix(s.lat, s.lon, s.height - MODEL_DROP, this.modelRoot.matrix).multiply(Y_UP_TO_ENU);
    this.modelRoot.matrixWorldNeedsUpdate = true;
    this.modelRoot.visible = true;
    this.model.object.visible = true;
    this.model.pose(s, dt, this.spin, 60 * this.crashBlend + this.tumble);
    DRONE_CENTER_ENU.copy(_drone).applyMatrix4(SCENE_FRAME_INV);
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
    if (a.view) this.toggleView();
    if (a.avoidance) this.toggleAvoidance();
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
    const next: DroneUi = { ...this.ui, status: s.status, mode: s.mode, gamepad: this.input.gamepadConnected, avoidance: s.avoidance };
    this.ui = next;
    const prev = this.published;
    if (
      prev == null ||
      next.status !== prev.status ||
      next.mode !== prev.mode ||
      next.gamepad !== prev.gamepad ||
      next.grid !== prev.grid ||
      next.help !== prev.help ||
      next.muted !== prev.muted ||
      next.view !== prev.view ||
      next.avoidance !== prev.avoidance
    ) {
      this.published = next;
      this.hooks.onUi(next);
    }
  }
  private published: DroneUi | null = null;
}

/** Free the chase model's GPU resources (geometries and materials). */
export function disposeModel(root: Group): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh !== true) return;
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) mat.dispose();
  });
}
