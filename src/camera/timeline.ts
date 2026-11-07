/**
 * Cue sheet for the fly-in (seconds since the click). The camera path itself lives in flyIn.ts;
 * this only decides when overlays appear so the UI and the camera share one clock.
 *
 *   0.0 - 0.6   start UI fades out
 *   0.6         HUD fades in (readouts sit inside the letterbox zones)
 *   6.2         letterbox bars ease in to 2.39:1 for the atmosphere entry and final approach
 *  12.0 / 12.2  HUD fades out, bars retract (1.4 s) so the frame is clear before the landing
 *  14.0         arrival; slow drift continues
 *  14.2 - 19.6  title card
 *  15.2         replay / explore controls
 *  28.0         drift has settled -> hand the camera to GlobeControls
 */
export const FLIGHT_DURATION = 14;

export const CUES = {
  hudIn: 0.6,
  barsIn: 6.2,
  hudOut: 12.0,
  barsOut: 12.2,
  titleIn: 14.2,
  titleOut: 19.6,
  controlsIn: 15.2,
  autoHandoff: 28,
} as const;

export interface Cues {
  hud: boolean;
  bars: boolean;
  title: boolean;
  controls: boolean;
}

export function cuesAt(seconds: number): Cues {
  const s = Number.isFinite(seconds) ? seconds : 0;
  return {
    hud: s >= CUES.hudIn && s < CUES.hudOut,
    bars: s >= CUES.barsIn && s < CUES.barsOut,
    title: s >= CUES.titleIn && s < CUES.titleOut,
    controls: s >= CUES.controlsIn,
  };
}

export function sameCues(a: Cues, b: Cues): boolean {
  return a.hud === b.hud && a.bars === b.bars && a.title === b.title && a.controls === b.controls;
}
