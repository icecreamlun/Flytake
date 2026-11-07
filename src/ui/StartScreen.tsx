import { useEffect, useState, type FC, type FormEvent } from 'react';
import { DESTINATIONS, findDestination, findPageDestination, PAGE_DESTINATIONS, SAN_FRANCISCO } from '../camera/destinations';
import { TILES_PROVIDER } from '../config';
import { useFlytake } from '../state/store';

const PinIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 1 1 13 0c0 5.4-6.5 11-6.5 11Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="10" r="2.3" fill="currentColor" />
  </svg>
);

const ArrowIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Drop keyboard focus so a later Enter / Space cannot re-trigger a hidden control. */
export function blurActive(): void {
  (document.activeElement as HTMLElement | null)?.blur?.();
}

export const StartScreen: FC = () => {
  const phase = useFlytake((s) => s.phase);
  const fly = useFlytake((s) => s.fly);
  const heroReady = useFlytake((s) => s.heroReady);
  const [query, setQuery] = useState(DESTINATIONS[0]!.label);
  const [error, setError] = useState<string | null>(null);
  /** destination clicked while the arrival view was still streaming in */
  const [pending, setPending] = useState<string | null>(null);
  const tilesError = useFlytake((s) => s.tilesError);
  // Without working tiles the setup card takes over; there is nothing to fly to.
  const visible = phase === 'start' && TILES_PROVIDER != null && tilesError == null;

  // Fly as soon as the arrival view is cached (it lands sharp instead of refining on screen).
  useEffect(() => {
    if (pending == null || !heroReady) return;
    setPending(null);
    fly(pending);
  }, [pending, heroReady, fly]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    blurActive();
    const destination = findDestination(query);
    if (destination == null) {
      // A preset with its own page (San Francisco): a full page load, no descent from space.
      const page = findPageDestination(query);
      if (page != null) {
        setQuery(page.label);
        window.location.assign(page.href);
        return;
      }
      setError(`Only preset locations are available in this preview — try “${DESTINATIONS[0]!.label}” or “${SAN_FRANCISCO.label}”.`);
      return;
    }
    setError(null);
    setQuery(destination.label);
    if (heroReady) fly(destination.id);
    else setPending(destination.id);
  };
  const preparing = pending != null && !heroReady;

  return (
    <div className="start" data-visible={visible} aria-hidden={!visible} inert={!visible}>
      <div className="start-scrim" />
      <header className="topbar">
        <div className="wordmark">Flytake</div>
        <div className="caption mono">Emerald Bay · Lake Tahoe · Nov 7</div>
      </header>
      <section className="start-panel">
        <h1 className="tagline">Rehearse your drone shot before you fly.</h1>
        <form className="fly-form" onSubmit={onSubmit}>
          <label className="fly-field">
            <PinIcon />
            <span className="visually-hidden">Location</span>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setError(null);
              }}
              list="flytake-presets"
              spellCheck={false}
              autoComplete="off"
              tabIndex={visible ? 0 : -1}
            />
            <datalist id="flytake-presets">
              {DESTINATIONS.map((d) => (
                <option key={d.id} value={d.label} />
              ))}
              {PAGE_DESTINATIONS.map((d) => (
                <option key={d.id} value={d.label} />
              ))}
            </datalist>
          </label>
          <button type="submit" className="fly-button" tabIndex={visible ? 0 : -1} data-busy={preparing} aria-busy={preparing}>
            {preparing ? 'Preparing' : 'Fly'} <ArrowIcon />
          </button>
        </form>
        <p className="start-note" data-error={error != null}>
          {error ?? (preparing ? 'Streaming the arrival view so it lands sharp…' : 'Photorealistic 3D Tiles · physically based atmosphere · real sun position')}
        </p>
        <a className="start-alt" href={SAN_FRANCISCO.href} tabIndex={visible ? 0 : -1}>
          Or fly the Ferry Building, San Francisco <ArrowIcon />
        </a>
      </section>
    </div>
  );
};
