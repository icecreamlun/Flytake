import type { DroneUi } from './DroneSim';
import type { DroneState, Sticks } from './physics';
import type { FlightMode } from './specs';

/**
 * What the HUD, the store and the debug hooks need from a first-person drone, whatever world it
 * flies in: DroneSim (Emerald Bay: Google tiles + the lidar scene, ECEF) and SfDroneSim (San
 * Francisco: the argus city, local metres). Each owns its own camera hookup.
 */
export interface DroneController {
  readonly site: {
    readonly name: string;
    /** what a splashdown landed in (HUD warning); default 'lake' */
    readonly water?: string;
  };
  readonly state: DroneState;
  readonly sticks: Sticks;
  readonly ui: DroneUi;
  /** true until the launch site is loaded and measured (the screen stays black) */
  readonly preparing: boolean;
  /** the current crash was a landing on the water */
  readonly splashed: boolean;
  /** ms spent ray-casting last frame */
  readonly raycastMs: number;
  /** camera height above whatever is below it (for the near plane) */
  readonly cameraAgl: number;
  /** start listening to the keyboard / gamepad */
  attach(): void;
  dispose(): void;
  takeoffOrLand(): void;
  setMode(mode: FlightMode): void;
  reset(): void;
  toggleHelp(): void;
  /** first-person <-> chase view (published on the next frame) */
  toggleView(): void;
  /** obstacle avoidance on <-> off (Cine / Normal brake before obstacles when on) */
  toggleAvoidance(): void;
}
