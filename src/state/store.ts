import type { Quaternion, Vector3 } from 'three';
import { create } from 'zustand';
import { FLAGS } from '../config';
import { FlyInPath } from '../camera/flyIn';
import { getDestination } from '../camera/destinations';
import { IDLE_BASE, cinematicIdlePose } from '../camera/idle';
import { CUES, FLIGHT_DURATION, cuesAt, sameCues, type Cues } from '../camera/timeline';
import { runtime } from '../scene/runtime';
import { DroneSim, launchSite, type DroneHooks, type DroneUi } from '../drone/DroneSim';
import type { DroneController } from '../drone/controller';

/**
 * loading  - waiting for the atmosphere tables and the first tiles
 * start    - Earth from space, start screen
 * flying   - the scripted 14 s descent
 * arrived  - at the hero pose, slow drift, title card
 * free     - GlobeControls own the camera
 * drone    - first-person drone flight (DroneSim owns the camera)
 */
export type Phase = 'loading' | 'start' | 'flying' | 'arrived' | 'free' | 'drone';

/** Makes the drone for drone mode; the store supplies the hooks. */
export type DroneFactory = (hooks: DroneHooks) => DroneController;

export interface FlytakeState {
  phase: Phase;
  destinationId: string;
  /** increments every time a flight (re)starts */
  flightId: number;
  /** freeze the flight at this fraction (debug / screenshots) */
  frozenT: number | null;
  /** hold the arrival pose without drifting (?pose=hero) */
  hold: boolean;
  cues: Cues;
  /** full-screen dip to black used to hide hard camera cuts (replay / skip) */
  blackout: boolean;
  atmosphereReady: boolean;
  tilesReady: boolean;
  tilesError: string | null;
  /** the arrival view's tiles are cached (or the preload timed out): Fly lands sharp */
  heroReady: boolean;
  /** drone mode: black screen while the launch site streams in */
  dronePreparing: boolean;
  /** drone mode: discrete UI state pushed by DroneSim */
  droneUi: DroneUi | null;
  /** launch site shown while the drone prepares (null = the Emerald Bay launch site) */
  droneSite: string | null;

  setAtmosphereReady(): void;
  setTilesReady(): void;
  setTilesError(message: string): void;
  setHeroReady(): void;
  /** leave the loading screen (honours ?autoplay / ?t / ?pose) */
  begin(): void;
  fly(destinationId?: string): void;
  replay(): void;
  skip(): void;
  /** run `action` hidden behind a short dip to black (for hard cuts) */
  cut(action: () => void): void;
  arrive(): void;
  handoff(): void;
  jump(t: number): void;
  setCues(cues: Cues): void;
  /** fade to black, put the drone on its launch site, reveal once the tiles are in */
  enterDrone(): void;
  /** leave the drone: GlobeControls take over from the drone's current view */
  exitDrone(): void;
  /**
   * Drone mode with a drone made elsewhere (San Francisco, which has its own engine): fade to
   * black (straight in while loading), then `create` it at `site` and reveal once it is ready.
   */
  flyDrone(site: string, create: DroneFactory): void;
}

/** Drift after arrival: starts at the arrival speed (2.5 m/s) and coasts to a stop. */
export const FLIGHT_OPTIONS = { duration: FLIGHT_DURATION, driftFloorSpeed: 0, driftTimeConstant: 6 } as const;

/** GlobeControls state that `enabled = false` does not clear (0.5.4). */
interface ControlsInternals {
  up: Vector3;
  zoomDelta: number;
  globeInertia?: Quaternion;
  globeInertiaFactor?: number;
  getCameraUpDirection(target: Vector3): void;
}

function disableControls(): void {
  const controls = runtime.controls;
  if (controls) {
    controls.enabled = false;
    // A globe flick from the previous free session would otherwise resume at the next handoff.
    const c = controls as unknown as ControlsInternals;
    c.globeInertia?.identity();
    c.globeInertiaFactor = 0;
    c.zoomDelta = 0;
  }
}

function enableControls(): void {
  const controls = runtime.controls;
  if (controls) {
    // `up` is only refreshed inside update(), which is skipped while disabled: without this
    // the first drag tests against a stale (or the default +Y) up vector and may be rejected.
    const c = controls as unknown as ControlsInternals & { camera?: unknown };
    if (c.camera != null) c.getCameraUpDirection(c.up);
    controls.enabled = true;
  }
}

function startFlight(startPose = cinematicIdlePose(runtime.idleSeconds), destinationId: string): void {
  runtime.path = new FlyInPath(startPose, getDestination(destinationId).hero, FLIGHT_OPTIONS);
  runtime.flightSeconds = 0;
  disableControls();
}

const emeraldDrone: DroneFactory = (hooks) => new DroneSim(launchSite(), hooks);

/** Create the drone at its launch site and switch to drone mode (the screen is already black). */
function startDrone(set: (partial: Partial<FlytakeState>) => void, create: DroneFactory = emeraldDrone): void {
  disableControls();
  runtime.drone?.dispose();
  const sim = create({
    onUi: (ui) => set({ droneUi: ui }),
    onExit: () => useFlytake.getState().exitDrone(),
    onReady: () => set({ dronePreparing: false, blackout: false }),
  });
  sim.attach();
  runtime.drone = sim;
  set({ phase: 'drone', dronePreparing: true, blackout: true, droneUi: sim.ui, cues: NO_CUES, frozenT: null, hold: false });
}

function launch(destinationId: string, set: (partial: Partial<FlytakeState>) => void, flightId: number): void {
  startFlight(undefined, destinationId);
  set({ phase: 'flying', destinationId, frozenT: null, hold: false, flightId: flightId + 1, cues: NO_CUES });
}

const NO_CUES = cuesAt(-1);
/** must match the .blackout transition in styles.css */
export const CUT_FADE_MS = 380;

export const useFlytake = create<FlytakeState>()((set, get) => ({
  phase: 'loading',
  destinationId: 'emerald-bay',
  flightId: 0,
  frozenT: null,
  hold: false,
  cues: NO_CUES,
  blackout: false,
  atmosphereReady: false,
  tilesReady: false,
  tilesError: null,
  heroReady: false,
  dronePreparing: false,
  droneUi: null,
  droneSite: null,

  setAtmosphereReady: () => set({ atmosphereReady: true }),
  setTilesReady: () => set({ tilesReady: true }),
  setTilesError: (message) => set({ tilesError: message }),
  setHeroReady: () => {
    if (!get().heroReady) set({ heroReady: true });
  },

  begin: () => {
    if (get().phase !== 'loading') return;
    if (FLAGS.heroPose) {
      startFlight(IDLE_BASE, get().destinationId);
      runtime.flightSeconds = FLIGHT_DURATION;
      set({ phase: 'arrived', hold: true, frozenT: 1, flightId: get().flightId + 1, cues: cuesAt(FLIGHT_DURATION + 1) });
    } else if (FLAGS.drone) {
      startDrone(set);
    } else if (FLAGS.frozenT != null) {
      get().jump(FLAGS.frozenT);
    } else if (FLAGS.autoplay) {
      runtime.idleSeconds = 0;
      launch(get().destinationId, set, get().flightId);
    } else {
      set({ phase: 'start' });
    }
  },

  fly: (destinationId) => {
    // Only from the start screen: a stale keyboard focus (Enter / Space) must never restart
    // the flight with a hard cut mid-descent or after arrival.
    if (get().phase !== 'start') return;
    launch(destinationId ?? get().destinationId, set, get().flightId);
  },

  replay: () => {
    const { phase } = get();
    if (phase !== 'arrived' && phase !== 'free') return;
    runtime.idleSeconds = 0;
    startFlight(IDLE_BASE, get().destinationId);
    set({ phase: 'flying', frozenT: null, hold: false, flightId: get().flightId + 1, cues: NO_CUES });
  },

  skip: () => {
    if (get().phase !== 'flying' || runtime.path == null) return;
    runtime.flightSeconds = Math.max(runtime.flightSeconds, FLIGHT_DURATION);
  },

  cut: (action) => {
    if (get().blackout) return;
    set({ blackout: true });
    window.setTimeout(() => {
      action();
      // let a couple of frames render at the new pose before revealing
      window.setTimeout(() => set({ blackout: false }), 160);
    }, CUT_FADE_MS);
  },

  arrive: () => {
    if (get().phase === 'flying') set({ phase: 'arrived' });
  },

  handoff: () => {
    const { phase } = get();
    if (phase !== 'arrived') return;
    // A held pose (?pose=hero / jump(1)) shows the title card; keep it up for its usual time.
    if (get().hold) runtime.flightSeconds = Math.max(runtime.flightSeconds, CUES.titleIn + 1);
    enableControls();
    set({ phase: 'free', frozenT: null, hold: false });
  },

  jump: (t) => {
    const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
    if (runtime.path == null || get().phase === 'loading' || get().phase === 'start') {
      startFlight(IDLE_BASE, get().destinationId);
    }
    if (runtime.controls) runtime.controls.enabled = false;
    runtime.flightSeconds = x * FLIGHT_DURATION;
    set({
      phase: x >= 1 ? 'arrived' : 'flying',
      frozenT: x,
      hold: x >= 1,
      flightId: get().flightId + 1,
      cues: cuesAt(runtime.flightSeconds),
    });
  },

  setCues: (cues) => {
    if (!sameCues(cues, get().cues)) set({ cues });
  },

  enterDrone: () => {
    const { phase, blackout } = get();
    if ((phase !== 'arrived' && phase !== 'free') || blackout) return;
    set({ blackout: true, dronePreparing: true });
    window.setTimeout(() => startDrone(set), CUT_FADE_MS);
  },

  exitDrone: () => {
    if (get().phase !== 'drone' || get().blackout) return;
    get().cut(() => {
      runtime.drone?.dispose();
      runtime.drone = null;
      // The fly-in clock stopped while flying the drone: keep the title card from coming back.
      runtime.flightSeconds = Math.max(runtime.flightSeconds, CUES.titleOut + 1);
      enableControls();
      set({ phase: 'free', dronePreparing: false, droneUi: null, frozenT: null, hold: false });
    });
  },

  flyDrone: (site, create) => {
    const { phase, blackout } = get();
    if (phase === 'drone' || blackout) return;
    if (phase === 'loading') {
      // the loading screen is still up: no fade needed
      set({ droneSite: site });
      startDrone(set, create);
      return;
    }
    set({ blackout: true, dronePreparing: true, droneSite: site });
    window.setTimeout(() => startDrone(set, create), CUT_FADE_MS);
  },
}));
