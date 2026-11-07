import { useEffect, useRef, type FC } from 'react';
import { useFlytake } from '../state/store';
import { blurActive } from '../ui/StartScreen';
import { previewClock, startPreview, stopPreview, usePreview } from './preview';
import { FLIGHT_SECONDS, PREVIEW_TAKEOFF, flightPolyline } from './previewRoute';
import type { SfWorld } from './session';

const PlayIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
  </svg>
);

const PLAN = (() => {
  const { points, distance } = flightPolyline();
  const top = Math.max(...points.map((p) => p.y)) - PREVIEW_TAKEOFF.y;
  return `Take-off Ferry Plaza · ${(distance[distance.length - 1]! / 1000).toFixed(1)} km · ${FLIGHT_SECONDS} s · max ${Math.round(top)} m`;
})();

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** "Preview" (or P) in the drone and orbit views: plays the flight plan. */
export const PreviewButton: FC<{ world: SfWorld | null }> = ({ world }) => {
  const phase = useFlytake((s) => s.phase);
  const preparing = useFlytake((s) => s.dronePreparing);
  const blackout = useFlytake((s) => s.blackout);
  const active = usePreview((s) => s.active);
  const visible = world != null && !active && !blackout && ((phase === 'drone' && !preparing) || phase === 'free');

  useEffect(() => {
    if (!visible || world == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyP' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      startPreview(world);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, world]);

  const onClick = () => {
    blurActive();
    if (world != null) startPreview(world);
  };
  return (
    <button className="pill sf-preview-button" data-visible={visible} tabIndex={visible ? 0 : -1} onClick={onClick}>
      <PlayIcon /> Preview flight <kbd className="mono sf-kbd">P</kbd>
    </button>
  );
};

/** Letterbox, captions and progress while the preview plays; Esc leaves it. */
export const PreviewOverlay: FC<{ world: SfWorld | null }> = ({ world }) => {
  const active = usePreview((s) => s.active);
  const stage = usePreview((s) => s.stage);
  const barRef = useRef<HTMLElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!active || world == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      stopPreview(world);
    };
    window.addEventListener('keydown', onKey);
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = usePreview.getState().stage === 'flight' ? Math.min(previewClock.seconds, FLIGHT_SECONDS) : 0;
      if (barRef.current != null) barRef.current.style.transform = `scaleX(${(s / FLIGHT_SECONDS).toFixed(4)})`;
      const text = `${clock(s)} / ${clock(FLIGHT_SECONDS)}`;
      if (timeRef.current != null && timeRef.current.textContent !== text) timeRef.current.textContent = text;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
    };
  }, [active, world]);

  return (
    <div className="sf-preview" data-visible={active} data-stage={stage} aria-hidden={!active}>
      <div className="letterbox" data-visible={active}>
        <div className="bar bar-top" />
        <div className="bar bar-bottom" />
      </div>
      <div className="sf-preview-plan">
        <p className="sf-preview-kicker mono">Flight plan</p>
        <h2 className="sf-preview-title">Ferry Building</h2>
        <p className="sf-preview-meta mono">{PLAN}</p>
      </div>
      <div className="sf-preview-foot mono">
        <span>Preview · Ferry Building, San Francisco · 4:00 PM</span>
        <span className="sf-preview-right">
          <span ref={timeRef} />
          <button className="sf-preview-exit" tabIndex={active ? 0 : -1} onClick={() => world != null && stopPreview(world)}>
            Esc · Exit
          </button>
        </span>
        <i className="sf-preview-progress">
          <i ref={barRef} />
        </i>
      </div>
    </div>
  );
};
