import { useEffect, type FC, type SyntheticEvent } from 'react';
import { FLAGS, TILES_PROVIDER } from './config';
import { Experience } from './scene/Experience';
import { useFlytake } from './state/store';
import { Attribution } from './ui/Attribution';
import { MissingKey } from './ui/MissingKey';
import { Overlays, StatsReadout } from './ui/Overlays';

/** Leave the loading screen once the atmosphere tables and the first tiles are in. */
function useBeginWhenReady(): void {
  const phase = useFlytake((s) => s.phase);
  const atmosphereReady = useFlytake((s) => s.atmosphereReady);
  const tilesReady = useFlytake((s) => s.tilesReady);
  const tilesError = useFlytake((s) => s.tilesError);

  useEffect(() => {
    if (phase !== 'loading' || !atmosphereReady) return;
    const begin = () => useFlytake.getState().begin();
    // Give the first fully loaded frame a moment on screen before the reveal.
    if (TILES_PROVIDER == null || tilesReady || tilesError != null) {
      const id = window.setTimeout(begin, 400);
      return () => window.clearTimeout(id);
    }
    // Never get stuck behind a slow network: reveal whatever has streamed in so far.
    const id = window.setTimeout(begin, 15000);
    return () => window.clearTimeout(id);
  }, [phase, atmosphereReady, tilesReady, tilesError]);
}

export const App: FC = () => {
  useBeginWhenReady();

  // The first drag / scroll on the canvas after arrival hands the camera to GlobeControls.
  // Capture phase runs before the controls' own canvas listeners, so that same gesture
  // already drives the controls.
  const onUserInput = (event: SyntheticEvent) => {
    if (!(event.target instanceof HTMLCanvasElement)) return;
    const state = useFlytake.getState();
    if (state.phase === 'arrived') state.handoff();
  };

  return (
    <div className="app" onPointerDownCapture={onUserInput} onWheelCapture={onUserInput}>
      <Experience />
      {!FLAGS.noUI && <Overlays />}
      <MissingKey />
      <Attribution />
      {FLAGS.stats && <StatsReadout />}
    </div>
  );
};
