import { useEffect, useRef, useState, type FC } from 'react';
import { useFlytake } from '../state/store';
import { DroneHud, DronePreparing } from '../ui/DroneHud';
import { Blackout, DroneIcon } from '../ui/Overlays';
import { blurActive } from '../ui/StartScreen';
import { TimeOfDay } from '../ui/TimeOfDay';
import { useSun } from '../world/sun';
import { setSfDebugError, setSfDebugWorld } from './debug';
import { usePreview } from './preview';
import { PreviewButton, PreviewOverlay } from './PreviewOverlay';
import { flySf, prepareSf, type SfWorld } from './session';

/** Data credits for the argus city (public/sf/data/SOURCES.md). */
const CREDITS = '© OpenStreetMap contributors (ODbL) · DataSF · USGS 3DEP / NOAA via AWS Terrain Tiles · city model from argus';

/** The orbit view (after Esc): T or Enter flies again. */
function useFlyKeys(world: SfWorld | null, active: boolean): void {
  useEffect(() => {
    if (world == null || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code !== 'KeyT' && e.code !== 'Enter') return;
      // Enter on a focused button or link is that control's own click.
      if (e.code === 'Enter' && e.target instanceof HTMLElement && e.target.closest('button, a, input') != null) return;
      e.preventDefault();
      flySf(world);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [world, active]);
}

/**
 * San Francisco (/?loc=sf): the argus city around the Ferry Building, flown with Flytake's
 * drone. Boots the city and its collision trees behind the loading screen, then takes off from
 * Ferry Building Plaza with the usual HUD and time-of-day control. Esc hands the camera to
 * argus's orbit controls (drag / right-drag / scroll); T, Enter or the button flies again.
 * Preview (P) plays the hard-coded Ferry Building flight plan (preview.ts).
 */
export const SfApp: FC = () => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const [note, setNote] = useState('Loading San Francisco');
  const [world, setWorld] = useState<SfWorld | null>(null);
  const [error, setError] = useState<string | null>(null);
  const phase = useFlytake((s) => s.phase);
  const dronePreparing = useFlytake((s) => s.dronePreparing);
  const droneSite = useFlytake((s) => s.droneSite);
  const previewing = usePreview((s) => s.active);
  /** the first drone is ready: the loading screen is done (later flights use the blackout) */
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport == null) return;
    prepareSf(viewport, (label, fraction) => {
      setNote(label);
      if (barRef.current != null) barRef.current.style.transform = `scaleX(${Math.max(0.04, fraction).toFixed(3)})`;
    })
      .then((w) => {
        setSfDebugWorld(w);
        setWorld(w);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[sf] boot failed', err);
        setSfDebugError(message);
        setError(message);
      });
  }, []);

  // Take off as soon as the city is in (straight from the loading screen, no fade).
  useEffect(() => {
    if (world != null && useFlytake.getState().phase === 'loading') flySf(world);
  }, [world]);

  useEffect(() => {
    if (phase === 'drone' && !dronePreparing) setRevealed(true);
  }, [phase, dronePreparing]);

  // Time of day: Flytake's slider (and [ / ]) drives argus's sun, sky, shadows and tower clocks.
  useEffect(() => {
    if (world == null) return;
    world.city.setTimeOfDay(useSun.getState().hours);
    return useSun.subscribe((s, prev) => {
      if (s.hours !== prev.hours) world.city.setTimeOfDay(s.hours);
    });
  }, [world]);

  const orbit = world != null && phase === 'free' && !previewing;
  useFlyKeys(world, orbit);

  const onFly = () => {
    blurActive();
    if (world != null) flySf(world);
  };
  // One loading screen from the first byte to the first drone frame (above the blackout).
  const loading = !revealed;
  const loadingNote = error ?? (world != null && droneSite != null ? `Preparing drone · ${droneSite}` : note);

  return (
    <div className="app">
      <div ref={viewportRef} />

      <header className="topbar sf-topbar" data-visible={orbit} inert={!orbit}>
        <div className="wordmark">Flytake</div>
        <div className="sf-topbar-right">
          <span className="caption mono">Ferry Building · San Francisco</span>
          <a className="pill pill-ghost sf-link" href="/">
            Emerald Bay
          </a>
        </div>
      </header>
      <div className="after-controls" data-visible={orbit} inert={!orbit}>
        <p className="hint">Drag to orbit · Right-drag to pan · Scroll to zoom</p>
        <button className="pill pill-accent" onClick={onFly} tabIndex={orbit ? 0 : -1}>
          <DroneIcon /> Fly drone <kbd className="mono sf-kbd">T</kbd>
        </button>
      </div>

      <DroneHud />
      {!previewing && <TimeOfDay />}
      {revealed && <PreviewButton world={world} />}
      <PreviewOverlay world={world} />
      <p className="sf-credits" data-visible={!loading}>
        {CREDITS}
      </p>

      <div className="loader sf-loader" data-visible={loading} aria-hidden={!loading}>
        <div className="loader-inner">
          <div className="wordmark wordmark-lg">Flytake</div>
          <div className="loader-bar">
            <i ref={barRef} />
          </div>
          <p className="loader-note mono">{loadingNote}</p>
        </div>
      </div>
      <Blackout />
      {revealed && <DronePreparing />}
    </div>
  );
};
