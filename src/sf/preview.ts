/**
 * The Ferry Building flight preview: an overview where the dashed plan draws itself in, then the
 * 60 s flight along it from the drone's point of view (letterboxed, at 4 PM), then back to the
 * drone on the plaza with the plan left in the city to fly by hand. The camera is driven through
 * Engine.setCameraDriver, like the drone, so the city culls and renders from the preview pose.
 */
import { MathUtils, Vector3, type PerspectiveCamera } from 'three';
import { create } from 'zustand';
import { DRONE } from '../drone/specs';
import { runtime } from '../scene/runtime';
import { CUT_FADE_MS, useFlytake } from '../state/store';
import { useSun } from '../world/sun';
import { FLIGHT_SECONDS, OVERVIEW, PREVIEW_HOURS, sampleFlight } from './previewRoute';
import { RouteLine } from './routeLine';
import { flySf, type SfWorld } from './session';

export type PreviewStage = 'overview' | 'flight';

interface PreviewState {
  active: boolean;
  stage: PreviewStage;
}

export const usePreview = create<PreviewState>(() => ({ active: false, stage: 'overview' }));

/** Seconds into the current stage, read by the overlay's progress bar every frame. */
export const previewClock = { seconds: 0 };

/** hold the last frame this long before cutting back to the drone */
const END_HOLD = 1.2;
const CAMERA_FAR = 80000;
/** the dashed line stops this far ahead of the camera, so it never runs through the lens */
const LINE_LEAD = 10;

const route = new WeakMap<SfWorld, RouteLine>();

/** The plan in the city (built on first use, then left visible). */
function routeFor(world: SfWorld): RouteLine {
  let line = route.get(world);
  if (line == null) {
    line = new RouteLine();
    world.city.cityRoot.add(line.object);
    const canvas = world.city.engine.renderer.domElement;
    world.city.onFrame((dt) => line!.update(dt, canvas.clientWidth, canvas.clientHeight));
    route.set(world, line);
  }
  return line;
}

const _pos = new Vector3();
const _look = new Vector3();

function aim(camera: PerspectiveCamera, pos: Vector3, look: Vector3, near: number): void {
  camera.position.copy(pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(look);
  camera.fov = DRONE.fov;
  camera.near = near;
  camera.far = CAMERA_FAR;
}

let hoursBefore: number | null = null;
let ending = false;

/** Play the preview from wherever the user is (drone or orbit view). */
export function startPreview(world: SfWorld): void {
  const store = useFlytake.getState();
  if (usePreview.getState().active || store.blackout) return;
  const line = routeFor(world);
  ending = false;

  store.cut(() => {
    runtime.drone?.dispose();
    runtime.drone = null;
    hoursBefore = useSun.getState().hours;
    useSun.getState().setHours(PREVIEW_HOURS);
    usePreview.setState({ active: true, stage: 'overview' });
    useFlytake.setState({ phase: 'free', dronePreparing: false, droneUi: null });
    line.object.visible = true;
    line.setRange(0, 0);

    let stage: PreviewStage = 'overview';
    let t = 0;
    world.city.engine.setCameraDriver((camera, dt) => {
      t += dt;
      previewClock.seconds = t;
      if (stage === 'overview') {
        const k = MathUtils.smootherstep(t, 0, OVERVIEW.seconds);
        _pos.lerpVectors(OVERVIEW.from, OVERVIEW.to, k);
        aim(camera, _pos, OVERVIEW.look, 1);
        line.setRange(0, line.length * MathUtils.smootherstep(t, 0.4, OVERVIEW.drawSeconds));
        if (t >= OVERVIEW.seconds) {
          stage = 'flight';
          t = 0;
          usePreview.setState({ stage });
        }
        return;
      }
      const ft = Math.min(t, FLIGHT_SECONDS);
      sampleFlight(ft, _pos, _look);
      aim(camera, _pos, _look, MathUtils.clamp((_pos.y - 2.6) * 0.4, 0.2, 1));
      line.setRange(line.distanceAt(ft) + LINE_LEAD);
      if (t >= FLIGHT_SECONDS + END_HOLD) stopPreview(world);
    });
  });
}

/** Back to the drone on the plaza; the plan stays drawn in the city. */
export function stopPreview(world: SfWorld): void {
  // (while the opening fade is still running, flyDrone would refuse: wait for the picture)
  if (!usePreview.getState().active || ending || useFlytake.getState().blackout) return;
  ending = true;
  route.get(world)?.setRange(0);
  // flyDrone fades to black first; the preview keeps the last frame until the drone takes over.
  flySf(world);
  window.setTimeout(() => {
    if (hoursBefore != null) useSun.getState().setHours(hoursBefore);
    hoursBefore = null;
    usePreview.setState({ active: false, stage: 'overview' });
  }, CUT_FADE_MS);
}
