import { useFrame, useThree } from '@react-three/fiber';
import { useRef, type FC } from 'react';
import { useFlytake } from '../state/store';

const WINDOW_SECONDS = 2;
const MIN_FPS = 40;
const STEP = 0.25;
/** Longer frames are loading stalls (tile parse / GPU upload, tab switch), not fill-rate. */
const STALL_SECONDS = 0.25;

/**
 * Safety net for slower laptops: if two consecutive 2 s windows have a median frame time
 * above 1/40 s, lower the device-pixel ratio by 0.25 (never below 1, never raised again to
 * avoid oscillation). The post stack is fill-rate bound, so this is the cheapest knob that
 * keeps the shot smooth.
 *
 * The median (not the mean) and the stall cut-off keep tile streaming hitches from lowering
 * the resolution for the whole demo; the start screen is not measured until the arrival view
 * has finished preloading (~1 GB of tiles parsed and uploaded).
 */
export const AdaptiveResolution: FC = () => {
  const setDpr = useThree((s) => s.setDpr);
  const state = useRef({ elapsed: 0, deltas: [] as number[], slowWindows: 0 });

  useFrame(({ viewport }, delta) => {
    const s = state.current;
    const { phase, heroReady, frozenT } = useFlytake.getState();
    if (phase === 'loading' || (phase === 'start' && !heroReady) || frozenT != null) {
      s.elapsed = 0;
      s.deltas.length = 0;
      return;
    }
    s.elapsed += delta;
    if (delta > 0 && delta < STALL_SECONDS) s.deltas.push(delta);
    if (s.elapsed < WINDOW_SECONDS) return;
    const deltas = s.deltas.sort((a, b) => a - b);
    const median = deltas.length > 0 ? deltas[deltas.length >> 1]! : 0;
    s.elapsed = 0;
    s.deltas = [];
    if (median === 0) return;
    const fps = 1 / median;
    s.slowWindows = fps < MIN_FPS ? s.slowWindows + 1 : 0;
    if (s.slowWindows >= 2 && viewport.dpr > 1) {
      s.slowWindows = 0;
      const next = Math.max(1, Math.round((viewport.dpr - STEP) * 100) / 100);
      console.info(`[flytake] median ${fps.toFixed(0)} fps, lowering pixel ratio to ${next}`);
      setDpr(next);
    }
  });

  return null;
};
