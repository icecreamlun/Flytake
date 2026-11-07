/**
 * The drone in San Francisco: DroneSim's glue (pilot input, flight model, gimbal smoothing, crash
 * tumble, help auto-hide, motor audio, readiness, UI publishing) on the argus city instead of the
 * Google tiles. Ground and obstacles are ray-cast against the city's bounds trees (collision.ts);
 * the bay (water plane y = 0) behaves like Emerald Bay's lake: touching down on it is a splashdown.
 *
 * The flight state stays geodetic (physics.ts): lat/lon map to the argus x/z through geo.ts
 * project(), and the height is the argus y (m NAVD88, bay water at 0). Frame: +X east, +Y up,
 * +Z south. The camera is driven through Engine.setCameraDriver, so the physics steps inside
 * the engine's frame, before the city culls and the post chain renders (zero frames of latency).
 */
import { Vector3, type PerspectiveCamera } from 'three';
import { MotorAudio } from '../drone/audio';
import type { DroneController } from '../drone/controller';
import type { DroneHooks, DroneUi, LaunchSite } from '../drone/DroneSim';
import { DroneInput } from '../drone/input';
import {
  createDroneState,
  heightAboveGround,
  neutralSticks,
  probeDirection,
  resetToHome,
  stepDrone,
  toggleTakeoffLanding,
  type DroneEnv,
  type DroneState,
} from '../drone/physics';
import { DRONE, MODE_ORDER, MODES, type FlightMode } from '../drone/specs';
import { wrap180, wrap360 } from '../geo/wgs84';
import type { Engine } from './argus/contracts';
import { project, unproject } from './argus/geo';
import type { SfCollider } from './collision';

export interface SfLaunchSite extends LaunchSite {
  /** what a splashdown lands in */
  water: string;
}

/**
 * Ferry Plaza, the paved bay-side apron right behind the Ferry Building (where the farmers market
 * sets up): sunlit through the afternoon, clear sky above, the nearest structure 40 m away, open
 * water ahead. Facing ESE across the bay at the Bay Bridge's west span (tower T2 at 88°, T1 at
 * 131°); the clock tower stands right behind (278°): take off, climb and turn around.
 */
const PLAZA = { x: 500, z: -200 };
const [PLAZA_LAT, PLAZA_LON] = unproject(PLAZA.x, PLAZA.z);
export const FERRY_BUILDING_PLAZA: SfLaunchSite = {
  name: 'Ferry Building Plaza',
  water: 'bay',
  // the height is refined by ray-casting before take-off
  position: { lat: PLAZA_LAT, lon: PLAZA_LON, height: 2.6 },
  heading: 108,
};

const DEG = Math.PI / 180;
/** the bay's surface (argus y) */
const WATER_LEVEL = 0;
/** ground hits below this are the bay bed / shallows: the surface there is the water */
const WATER_TOLERANCE = 0.3;
/**
 * The ground probe starts this far above the drone: enough for a curb or a slope rising under
 * it within one frame, small enough that the underside of the bridge deck or an eave just above
 * the drone is not taken for ground (and less than CEILING_MARGIN, so climbing stops first).
 */
const GROUND_PROBE_ABOVE = 0.5;
/** above every structure (Transamerica tops out at 265 m, the bridge towers at 160 m) */
const LAUNCH_PROBE_HEIGHT = 600;
const OBSTACLE_RANGE = 45;
/** climbing stops this far below a ceiling (bridge deck, overhangs) */
const CEILING_MARGIN = 1;
const HELP_AUTOHIDE_AFTER_TAKEOFF = 5;
/** same step clamp as Emerald's CameraDirector: a hitch slows the flight instead of jumping */
const MAX_STEP = 1 / 20;
/** frames to render behind the black screen (shader compiles, sky environment map) */
const PREP_FRAMES = 24;
const PREP_MS = 1200;
const PREP_TIMEOUT_MS = 10000;
const CAMERA_FAR = 80000;

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const _origin = new Vector3();
const _above = new Vector3();
const _dir = new Vector3();

export class SfDroneSim implements DroneController {
  readonly state: DroneState;
  readonly sticks = neutralSticks();
  ui: DroneUi;
  cameraAgl: number = DRONE.restHeight;
  raycastMs = 0;
  preparing = true;
  /** the current crash was a landing on the bay */
  splashed = false;
  /** argus world position of the drone (camera), updated every frame */
  readonly position = new Vector3();

  private readonly input = new DroneInput();
  private readonly audio = new MotorAudio();
  private detachInput: (() => void) | null = null;
  private readonly drive = (camera: PerspectiveCamera, dt: number) => this.step(Math.min(dt, MAX_STEP), camera);
  private cameraHeading: number;
  private crashBlend = 0;
  private spin = 0;
  private prepStarted = 0;
  private prepFrames = 0;
  private groundFound = false;
  private sinceTakeoff = -1;
  private helpPinned = false;
  private readonly env: DroneEnv = { groundHeight: null, obstacleDistance: null };
  private overWater = false;
  private published: DroneUi | null = null;

  constructor(
    readonly site: SfLaunchSite,
    private readonly hooks: DroneHooks,
    private readonly engine: Engine,
    private readonly collider: SfCollider,
    mode: FlightMode = 'normal',
  ) {
    this.state = createDroneState(site.position, site.heading, mode);
    this.cameraHeading = this.state.heading;
    this.ui = { status: 'grounded', mode, grid: false, help: true, muted: false, gamepad: false };
  }

  /** Take the keyboard / gamepad and the engine camera (argus's orbit controls pause). */
  attach(): void {
    if (this.detachInput != null) return;
    this.detachInput = this.input.attach(() => this.audio.unlock());
    this.prepStarted = performance.now();
    this.engine.setCameraDriver(this.drive);
  }

  /** Release input and audio; the camera goes back to argus's orbit controls at the current view. */
  dispose(): void {
    if (this.detachInput != null) this.engine.setCameraDriver(null);
    this.detachInput?.();
    this.detachInput = null;
    this.audio.dispose();
  }

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

  toggleHelp(): void {
    this.ui = { ...this.ui, help: !this.ui.help };
    this.helpPinned = this.ui.help;
  }

  private step(dt: number, camera: PerspectiveCamera): void {
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
    const heightBefore = s.height;
    stepDrone(s, this.sticks, dt, this.env);
    this.stopAtCeiling(heightBefore);
    // Touching down on the bay is a splashdown.
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

    // Gimbal: level horizon, fixed tilt, yaw follows the airframe with a little smoothing.
    const m = MODES[s.mode];
    this.cameraHeading = wrap360(this.cameraHeading + wrap180(s.heading - this.cameraHeading) * (1 - Math.exp(-dt / m.gimbalYawTau)));
    this.crashBlend += ((s.status === 'crashed' ? 1 : 0) - this.crashBlend) * (1 - Math.exp(-dt / 0.18));
    const pitch = DRONE.gimbalPitch - 30 * this.crashBlend;
    const roll = 24 * this.crashBlend;
    this.cameraAgl = Math.max(0.05, heightAboveGround(s));

    // Camera: three looks down -Z (north here); yaw is clockwise from north, hence the minus.
    const [x, z] = project(s.lat, s.lon);
    this.position.set(x, s.height, z);
    camera.position.copy(this.position);
    camera.rotation.set(pitch * DEG, -this.cameraHeading * DEG, -roll * DEG, 'YXZ');
    camera.fov = DRONE.fov;
    // Sitting on the paving or nosing up to a wall: pull the near plane in (argus's decals use
    // polygonOffset, so a 0.1 m near plane still keeps the road paint clean).
    const obstacle = this.env.obstacleDistance ?? Number.POSITIVE_INFINITY;
    camera.near = Math.min(1, Math.max(0.1, Math.min(this.cameraAgl * 0.5, obstacle * 0.4)));
    camera.far = CAMERA_FAR;

    this.updateAudio(dt);
    this.updateReadiness();
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

  /** Ray-cast the city: surface straight below (or the bay), and obstacles along the travel direction. */
  private measure(): void {
    const s = this.state;
    const env = this.env;
    env.groundHeight = null;
    env.obstacleDistance = null;
    const [x, z] = project(s.lat, s.lon);
    _origin.set(x, s.height, z);

    // Before the first take-off the launch height is only a guess: probe from above every
    // structure. Otherwise from just above (the city is static, nothing refines up through the
    // legs as with streamed tiles), so the bridge deck or a cornice above the drone never counts
    // as ground and a crashed drone falls past overhangs instead of popping up onto them.
    const onLaunchPad = s.status === 'grounded' && s.airborneSeconds === 0;
    const above = onLaunchPad ? Math.max(GROUND_PROBE_ABOVE, LAUNCH_PROBE_HEIGHT - s.height) : GROUND_PROBE_ABOVE;
    _above.copy(_origin).addScaledVector(UP, above);
    const hit = this.collider.cast(_above, DOWN, above + 2000);
    const ground = hit != null ? s.height + above - hit : null;
    // The bay: nothing below (the ground mesh stops under the water) or only its bed. The
    // surface is the flat water plane.
    this.overWater = ground == null || ground < WATER_LEVEL + WATER_TOLERANCE;
    env.groundHeight = this.overWater ? WATER_LEVEL : ground;
    this.groundFound = true;

    const probe = probeDirection(s, this.sticks);
    if (probe != null) {
      // east = +X, north = -Z
      _dir.set(probe.east, 0, -probe.north).normalize();
      const d = this.collider.cast(_origin, _dir, OBSTACLE_RANGE);
      if (d != null) env.obstacleDistance = d;
    }
  }

  /**
   * The flight model only knows the ground: don't climb through the bridge deck or a pier roof.
   * Looks up from last frame's height, so a deck the drone is already above never counts.
   */
  private stopAtCeiling(heightBefore: number): void {
    const s = this.state;
    if (s.vUp <= 0 || (s.status !== 'flying' && s.status !== 'takeoff')) return;
    const [x, z] = project(s.lat, s.lon);
    _origin.set(x, heightBefore, z);
    const d = this.collider.cast(_origin, UP, Math.max(0, s.height - heightBefore) + CEILING_MARGIN);
    if (d == null) return;
    const ceiling = heightBefore + d - CEILING_MARGIN;
    if (s.height > ceiling) {
      s.height = Math.max(ceiling, s.groundHeight + DRONE.restHeight);
      s.vUp = 0;
      s.warnings.obstacle = true;
    }
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

  /** The city is all in memory: wait for the first frames (shader compiles, the sky's IBL) only. */
  private updateReadiness(): void {
    if (!this.preparing) return;
    this.prepFrames++;
    const waited = performance.now() - this.prepStarted;
    const ready = (this.groundFound && this.prepFrames >= PREP_FRAMES && waited > PREP_MS) || waited > PREP_TIMEOUT_MS;
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
}
