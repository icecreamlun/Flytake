import { useEffect, type ChangeEvent, type FC } from 'react';
import { useFlytake } from '../state/store';
import { TIME_MAX, TIME_MIN, formatLocalHours, useSun } from '../world/sun';

/** hours of scene time per second of holding [ or ] */
const SCRUB_RATE = 1.2;

/** [ / ] scrub the time of day (hold for a continuous sweep). */
function useTimeKeys(): void {
  useEffect(() => {
    const held = new Set<string>();
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const dir = (held.has('BracketRight') ? 1 : 0) - (held.has('BracketLeft') ? 1 : 0);
      if (dir !== 0) {
        const s = useSun.getState();
        s.setHours(s.hours + dir * SCRUB_RATE * dt);
      }
      raf = held.size > 0 ? requestAnimationFrame(tick) : 0;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'BracketLeft' && e.code !== 'BracketRight') return;
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      e.preventDefault();
      held.add(e.code);
      if (raf === 0) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    const up = (e: KeyboardEvent) => held.delete(e.code);
    const blur = () => held.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}

const SunIcon: FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
  </svg>
);

/** Time-of-day control: the sun (and every shadow in the Emerald Bay scene) follows it live. */
export const TimeOfDay: FC = () => {
  useTimeKeys();
  const hours = useSun((s) => s.hours);
  const setHours = useSun((s) => s.setHours);
  const phase = useFlytake((s) => s.phase);
  const visible = phase === 'drone' || phase === 'free' || phase === 'arrived';
  const onChange = (e: ChangeEvent<HTMLInputElement>) => setHours(Number(e.target.value));
  return (
    <div className="time-of-day" data-visible={visible} inert={!visible}>
      <SunIcon />
      <input
        type="range"
        min={TIME_MIN}
        max={TIME_MAX}
        step={1 / 60}
        value={hours}
        onChange={onChange}
        onPointerUp={(e) => e.currentTarget.blur()}
        aria-label="Time of day"
      />
      <span className="mono time-label">{formatLocalHours(hours)}</span>
      <span className="time-keys mono">[ ]</span>
    </div>
  );
};
