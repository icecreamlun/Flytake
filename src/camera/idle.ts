import { ORBIT_START, type GeoPose, wrap180 } from './flyIn';

/**
 * Start-screen idle motion. The camera hangs 24,000 km above the eastern Pacific looking
 * straight down and glides east, like a satellite on a prograde orbit (the ground drifts
 * right -> left). It eases from `startSpeed` deg/s into a slow sway that stays bounded just
 * west of Lake Tahoe, so however long the page sits open before the demo the same view holds:
 * Tahoe near the centre of the sunlit side, the dusk terminator crossing Nevada, and Fly still
 * continuing the drift eastward. (An unbounded drift reached the night side after ~10 min.)
 *
 *   offset(t) = settle * (1 - e^(-t / tau)) + sway * sin(2 pi t / swayPeriod),  tau = settle / startSpeed
 *
 * The atmosphere date stays fixed, so the Tahoe lighting does not change while idling.
 */
export interface IdleOptions {
  base?: GeoPose;
  startSpeed?: number;
  settle?: number;
  sway?: number;
  swayPeriod?: number;
}

export const IDLE_BASE: GeoPose = { ...ORBIT_START, lon: -129.5 };

export function idleLongitudeOffset(seconds: number, startSpeed = 0.35, settle = 7, sway = 1.5, swayPeriod = 240): number {
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const tau = settle / Math.max(1e-6, startSpeed);
  return settle * (1 - Math.exp(-t / tau)) + sway * Math.sin((2 * Math.PI * t) / swayPeriod);
}

export function cinematicIdlePose(seconds: number, options: IdleOptions = {}): GeoPose {
  const base = options.base ?? IDLE_BASE;
  const offset = idleLongitudeOffset(seconds, options.startSpeed, options.settle, options.sway, options.swayPeriod);
  return { ...base, lon: wrap180(base.lon + offset) };
}
