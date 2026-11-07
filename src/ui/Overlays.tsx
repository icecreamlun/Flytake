import { useEffect, useRef, useState, type FC } from 'react';
import { getDestination } from '../camera/destinations';
import { FLIGHT_DURATION } from '../camera/timeline';
import { TILES_PROVIDER } from '../config';
import { runtime, tileStats, tilesLoading } from '../scene/runtime';
import { useFlytake } from '../state/store';
import { DroneHud, DronePreparing } from './DroneHud';
import { Hud } from './Hud';
import { blurActive, StartScreen } from './StartScreen';
import { TimeOfDay } from './TimeOfDay';

export const Letterbox: FC = () => {
  const visible = useFlytake((s) => s.cues.bars);
  return (
    <div className="letterbox" data-visible={visible} aria-hidden="true">
      <div className="bar bar-top" />
      <div className="bar bar-bottom" />
    </div>
  );
};

export const TitleCard: FC = () => {
  const visible = useFlytake((s) => s.cues.title);
  const destinationId = useFlytake((s) => s.destinationId);
  const { title } = getDestination(destinationId);
  return (
    <>
      <div className="title-scrim" data-visible={visible} aria-hidden="true" />
      <div className="title-card" data-visible={visible} aria-hidden={!visible}>
        <h2 className="title-name">{title.name}</h2>
        <p className="title-region">{title.region}</p>
        <p className="title-meta mono">{title.meta}</p>
      </div>
    </>
  );
};

/** Dip to black that hides hard cuts (replay from orbit, skip to arrival). */
export const Blackout: FC = () => {
  const visible = useFlytake((s) => s.blackout);
  return <div className="blackout" data-visible={visible} aria-hidden="true" />;
};

const ReplayIcon: FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const DroneIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    <circle cx="5.5" cy="5.5" r="3" />
    <circle cx="18.5" cy="5.5" r="3" />
    <circle cx="5.5" cy="18.5" r="3" />
    <circle cx="18.5" cy="18.5" r="3" />
    <path d="M8 8l2.5 2.5M16 8l-2.5 2.5M8 16l2.5-2.5M16 16l-2.5-2.5" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1.2" />
  </svg>
);

/** Skip during the flight; Replay + interaction hint after arrival. */
export const FlightControls: FC = () => {
  const phase = useFlytake((s) => s.phase);
  const frozen = useFlytake((s) => s.frozenT != null);
  const showControls = useFlytake((s) => s.cues.controls);
  const replay = useFlytake((s) => s.replay);
  const skip = useFlytake((s) => s.skip);
  const cut = useFlytake((s) => s.cut);
  const [skippable, setSkippable] = useState(false);

  useEffect(() => {
    if (phase !== 'flying' || frozen) {
      setSkippable(false);
      return;
    }
    const id = window.setInterval(() => {
      setSkippable(runtime.flightSeconds > 1 && runtime.flightSeconds < FLIGHT_DURATION - 2.5);
    }, 250);
    return () => window.clearInterval(id);
  }, [phase, frozen]);

  const after = (phase === 'arrived' || phase === 'free') && showControls;
  const onSkip = () => {
    blurActive();
    if (useFlytake.getState().phase === 'flying') cut(skip);
  };
  const onReplay = () => {
    blurActive();
    const current = useFlytake.getState().phase;
    if (current === 'arrived' || current === 'free') cut(replay);
  };
  const onDrone = () => {
    blurActive();
    useFlytake.getState().enterDrone();
  };
  return (
    <>
      <button
        className="pill pill-ghost skip"
        data-visible={skippable}
        tabIndex={skippable ? 0 : -1}
        inert={!skippable}
        onClick={onSkip}
      >
        Skip
      </button>
      <div className="after-controls" data-visible={after} inert={!after}>
        <p className="hint">{phase === 'free' ? 'Drag to pan · Right-drag or Shift-drag to orbit · Scroll to zoom' : 'Drag anywhere to take the controls'}</p>
        <button className="pill" onClick={onReplay} tabIndex={after ? 0 : -1}>
          <ReplayIcon /> Replay
        </button>
        <button className="pill pill-accent" onClick={onDrone} tabIndex={after ? 0 : -1}>
          <DroneIcon /> Fly a drone here
        </button>
      </div>
    </>
  );
};

/** Fades from black while the atmosphere tables and the first tiles stream in. */
export const Loader: FC = () => {
  const phase = useFlytake((s) => s.phase);
  const barRef = useRef<HTMLElement>(null);
  const visible = phase === 'loading';
  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { atmosphereReady } = useFlytake.getState();
      const tiles = runtime.tiles;
      const tileProgress = TILES_PROVIDER == null ? 1 : tiles == null || tiles.root == null ? 0 : tiles.loadProgress;
      const k = (atmosphereReady ? 0.3 : 0) + 0.7 * tileProgress;
      if (barRef.current) barRef.current.style.transform = `scaleX(${Math.max(0.04, k).toFixed(3)})`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible]);
  return (
    <div className="loader" data-visible={visible} aria-hidden={!visible}>
      <div className="loader-inner">
        <div className="wordmark wordmark-lg">Flytake</div>
        <div className="loader-bar">
          <i ref={barRef} />
        </div>
        <p className="loader-note mono">Streaming the planet</p>
      </div>
    </div>
  );
};

/** Optional ?stats=1 readout. */
export const StatsReadout: FC = () => {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      const tiles = runtime.tiles;
      const s = tiles ? tileStats(tiles) : undefined;
      const lru = tiles?.lruCache as unknown as { cachedBytes?: number } | undefined;
      if (ref.current) {
        ref.current.textContent = [
          `fps ${runtime.fps.toFixed(0)}`,
          s ? `tiles vis ${s.visible} act ${s.active} q ${s.queued} dl ${s.downloading} parse ${s.parsing}` : 'tiles —',
          lru?.cachedBytes != null ? `cache ${(lru.cachedBytes / 2 ** 20).toFixed(0)} MB` : '',
          `loading ${tilesLoading()}`,
        ]
          .filter(Boolean)
          .join('\n');
      }
    }, 250);
    return () => window.clearInterval(id);
  }, []);
  return <pre className="stats mono" ref={ref} />;
};

export const Overlays: FC = () => (
  <>
    <Letterbox />
    <StartScreen />
    <Hud />
    <TitleCard />
    <FlightControls />
    <DroneHud />
    <TimeOfDay />
    <Loader />
    <Blackout />
    <DronePreparing />
  </>
);
