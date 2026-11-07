import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { bearing, distanceFromHome, heightAboveGround, heightAboveHome } from '../drone/physics';
import { DRONE, MODES, MODE_ORDER, type FlightMode } from '../drone/specs';
import type { DroneStatus } from '../drone/physics';
import { wrap180 } from '../geo/wgs84';
import { launchSite } from '../drone/DroneSim';
import { runtime } from '../scene/runtime';
import { useFlytake } from '../state/store';
import { blurActive } from './StartScreen';

const STATUS_LABEL: Record<DroneStatus, string> = {
  grounded: 'Ready to take off',
  takeoff: 'Taking off',
  flying: 'In flight',
  landing: 'Landing',
  crashed: 'Crashed',
};

const MODE_NOTE: Record<FlightMode, string> = {
  cine: 'Cine · 5 m/s · slow, smooth moves for filming',
  normal: 'Normal · 12 m/s · obstacle sensing on',
  sport: 'Sport · 16 m/s · obstacle sensing OFF',
};

/* ---------------------------------------------------------------- compass */

const PX_PER_DEG = 3;
const TAPE_WIDTH = 420;
const CARDINALS: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

const CompassTape: FC<{ stripRef: React.RefObject<HTMLDivElement | null>; homeRef: React.RefObject<HTMLSpanElement | null>; headingRef: React.RefObject<HTMLSpanElement | null> }> = ({
  stripRef,
  homeRef,
  headingRef,
}) => {
  const ticks = useMemo(() => {
    const out: Array<{ deg: number; label: string | null; major: boolean }> = [];
    for (let d = -180; d <= 540; d += 5) {
      const n = ((d % 360) + 360) % 360;
      const label = CARDINALS[n] ?? (n % 15 === 0 ? String(n) : null);
      out.push({ deg: d, label, major: n % 15 === 0 });
    }
    return out;
  }, []);
  return (
    <div className="dh-compass" style={{ width: TAPE_WIDTH }} aria-hidden="true">
      <div className="dh-compass-strip" ref={stripRef}>
        {ticks.map(({ deg, label, major }) => (
          <span key={deg} className="dh-tick" data-major={major} data-cardinal={label != null && /[A-Z]/.test(label)} style={{ left: (deg + 180) * PX_PER_DEG }}>
            {label != null && <b>{label}</b>}
          </span>
        ))}
      </div>
      <span className="dh-home" ref={homeRef}>
        H
      </span>
      <span className="dh-caret" />
      <span className="dh-heading mono" ref={headingRef} />
    </div>
  );
};

/* ----------------------------------------------------------------- sticks */

const StickViz: FC<{ leftRef: React.RefObject<HTMLElement | null>; rightRef: React.RefObject<HTMLElement | null>; gamepad: boolean }> = ({ leftRef, rightRef, gamepad }) => (
  <div className="dh-sticks" aria-hidden="true">
    <div className="dh-stick">
      <div className="dh-stick-pad">
        <i ref={leftRef} />
      </div>
      <span className="dh-stick-label mono">{gamepad ? 'L' : 'W A S D'}</span>
      <span className="dh-stick-sub">climb · turn</span>
    </div>
    <div className="dh-stick">
      <div className="dh-stick-pad">
        <i ref={rightRef} />
      </div>
      <span className="dh-stick-label mono">{gamepad ? 'R' : '↑ ← ↓ →'}</span>
      <span className="dh-stick-sub">move</span>
    </div>
  </div>
);

/* ------------------------------------------------------------------- help */

const HELP: Array<[string, string]> = [
  ['T', 'Take off / land'],
  ['W  S', 'Climb / descend'],
  ['A  D', 'Turn left / right'],
  ['↑  ↓', 'Forward / back'],
  ['←  →', 'Slide left / right'],
  ['K  M', 'Camera tilt up / down'],
  ['1 2 3', 'Cine / Normal / Sport'],
  ['G', 'Rule-of-thirds grid'],
  ['N', 'Mute motors'],
  ['H', 'Show / hide this'],
  ['Esc', 'Leave the drone'],
];

const HelpPanel: FC<{ visible: boolean; gamepad: boolean }> = ({ visible, gamepad }) => (
  <div className="dh-help" data-visible={visible} aria-hidden={!visible}>
    <p className="dh-help-title">Controls · Mode 2, like a DJI remote</p>
    <dl>
      {HELP.map(([keys, what]) => (
        <div key={keys} className="dh-help-row">
          <dt className="mono">{keys}</dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
    {gamepad && <p className="dh-help-note">Gamepad: left stick climb + turn · right stick move · LT / RT camera tilt · A take off / land · LB / RB mode</p>}
  </div>
);

/* -------------------------------------------------------------------- HUD */

/** First-person drone HUD, modelled on DJI Fly. Numbers are written straight to the DOM at ~30 Hz. */
export const DroneHud: FC = () => {
  const phase = useFlytake((s) => s.phase);
  const preparing = useFlytake((s) => s.dronePreparing);
  const ui = useFlytake((s) => s.droneUi);
  const visible = phase === 'drone' && !preparing && ui != null;

  const hRef = useRef<HTMLSpanElement>(null);
  const dRef = useRef<HTMLSpanElement>(null);
  const hsRef = useRef<HTMLSpanElement>(null);
  const vsRef = useRef<HTMLSpanElement>(null);
  const aglRef = useRef<HTMLSpanElement>(null);
  const gimbalRef = useRef<HTMLSpanElement>(null);
  const batteryRef = useRef<HTMLSpanElement>(null);
  const batteryFillRef = useRef<HTMLElement>(null);
  const warningRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const homeRef = useRef<HTMLSpanElement>(null);
  const headingRef = useRef<HTMLSpanElement>(null);
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Flight-mode change toast.
  const mode = ui?.mode;
  const firstMode = useRef(true);
  useEffect(() => {
    if (mode == null) return;
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    setToast(MODE_NOTE[mode]);
    const id = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(id);
  }, [mode]);

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 33) return;
      last = now;
      const drone = runtime.drone;
      if (drone == null) return;
      const s = drone.state;
      const set = (ref: React.RefObject<HTMLElement | null>, text: string) => {
        if (ref.current && ref.current.textContent !== text) ref.current.textContent = text;
      };
      set(hRef, heightAboveHome(s).toFixed(1));
      set(dRef, distanceFromHome(s).toFixed(0));
      set(hsRef, Math.hypot(s.vEast, s.vNorth).toFixed(1));
      set(vsRef, (Math.abs(s.vUp) < 0.05 ? 0 : s.vUp).toFixed(1));
      set(aglRef, heightAboveGround(s).toFixed(1));
      const tilt = Math.round(s.gimbalPitch);
      set(gimbalRef, (tilt < 0 ? '\u2212' : '') + Math.abs(tilt));

      const pct = Math.round(s.battery * 100);
      const minutes = (s.battery * DRONE.batterySeconds) / 60;
      set(batteryRef, `${pct}% · ${Math.floor(minutes)}:${String(Math.floor((minutes % 1) * 60)).padStart(2, '0')}`);
      if (batteryFillRef.current) {
        batteryFillRef.current.style.transform = `scaleX(${s.battery.toFixed(3)})`;
        batteryFillRef.current.dataset.low = String(s.battery < 0.2);
      }

      // Compass: heading under the caret, home marker where the take-off point lies.
      const heading = s.heading;
      if (stripRef.current) stripRef.current.style.transform = `translateX(${(TAPE_WIDTH / 2 - (heading + 180) * PX_PER_DEG).toFixed(1)}px)`;
      set(headingRef, String(Math.round(heading) % 360).padStart(3, '0') + '°');
      if (homeRef.current) {
        const dist = distanceFromHome(s);
        const delta = wrap180(bearing(s, s.home) - heading);
        const shown = dist > 3 && Math.abs(delta) < 68;
        homeRef.current.style.opacity = shown ? '1' : '0';
        homeRef.current.style.transform = `translateX(${(TAPE_WIDTH / 2 + delta * PX_PER_DEG).toFixed(1)}px)`;
      }

      // Sticks.
      const R = 22;
      const st = drone.sticks;
      if (leftRef.current) leftRef.current.style.transform = `translate(${(st.yaw * R).toFixed(1)}px, ${(-st.throttle * R).toFixed(1)}px)`;
      if (rightRef.current) rightRef.current.style.transform = `translate(${(st.roll * R).toFixed(1)}px, ${(-st.pitch * R).toFixed(1)}px)`;

      // Warnings, most important first.
      const w = s.warnings;
      let text = '';
      let level = 'warn';
      if (s.status === 'crashed') {
        text = drone.splashed
          ? `Splashdown — the drone landed in the ${drone.site.water ?? 'lake'} · press R to reset`
          : 'Collision — drone down · press R to reset';
        level = 'danger';
      } else if (w.obstacle) text = 'Obstacle ahead · braking';
      else if (w.heightLimit) text = `Height limit · ${DRONE.heightLimit} m above take-off`;
      else if (w.lowBattery) text = 'Low battery · land soon';
      if (warningRef.current) {
        set(warningRef, text);
        warningRef.current.dataset.visible = String(text !== '');
        warningRef.current.dataset.level = level;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  const status = ui?.status ?? 'grounded';
  const action = (() => {
    switch (status) {
      case 'grounded':
        return { label: 'Take off', key: 'T' };
      case 'takeoff':
      case 'flying':
        return { label: 'Land', key: 'T' };
      case 'landing':
        return { label: 'Cancel landing', key: 'T' };
      case 'crashed':
        return { label: 'Reset drone', key: 'R' };
    }
  })();

  const onAction = () => {
    blurActive();
    const drone = runtime.drone;
    if (drone == null) return;
    if (drone.state.status === 'crashed') drone.reset();
    else drone.takeoffOrLand();
  };
  const onMode = (m: FlightMode) => {
    blurActive();
    runtime.drone?.setMode(m);
  };
  const onExit = () => {
    blurActive();
    useFlytake.getState().exitDrone();
  };
  const onHelp = () => {
    blurActive();
    runtime.drone?.toggleHelp();
  };

  return (
    <div className="drone-hud" data-visible={visible} aria-hidden={!visible} inert={!visible}>
      <div className="dh-grid" data-visible={visible && ui?.grid === true} />

      <div className="dh-top">
        <div className="dh-top-left">
          <span className="wordmark dh-wordmark">Flytake</span>
          <div className="dh-modes" role="group" aria-label="Flight mode">
            {MODE_ORDER.map((m) => (
              <button key={m} className="dh-mode" data-active={ui?.mode === m} onClick={() => onMode(m)} title={MODE_NOTE[m]}>
                {MODES[m].short}
              </button>
            ))}
          </div>
          <span className="dh-status" data-status={status}>
            <i />
            {STATUS_LABEL[status]}
          </span>
        </div>
        <CompassTape stripRef={stripRef} homeRef={homeRef} headingRef={headingRef} />
        <div className="dh-top-right">
          {ui?.gamepad && <span className="dh-chip mono">Gamepad</span>}
          {ui?.muted && <span className="dh-chip mono">Muted</span>}
          <span className="dh-battery mono">
            <span className="dh-battery-icon">
              <i ref={batteryFillRef} />
            </span>
            <span ref={batteryRef} />
          </span>
          <button className="pill pill-ghost dh-small" onClick={onHelp}>
            Help · H
          </button>
          <button className="pill pill-ghost dh-small" onClick={onExit}>
            Exit · Esc
          </button>
        </div>
      </div>

      <div className="dh-warning" ref={warningRef} data-visible="false" role="status" />
      <div className="dh-toast" data-visible={toast != null}>
        {toast}
      </div>

      <div className="dh-bottom">
        <div className="dh-telemetry mono">
          <div>
            <span className="dh-k">H</span>
            <span className="dh-v" ref={hRef} />
            <span className="dh-u">m</span>
          </div>
          <div>
            <span className="dh-k">D</span>
            <span className="dh-v" ref={dRef} />
            <span className="dh-u">m</span>
          </div>
          <div>
            <span className="dh-k">H.S</span>
            <span className="dh-v" ref={hsRef} />
            <span className="dh-u">m/s</span>
          </div>
          <div>
            <span className="dh-k">V.S</span>
            <span className="dh-v" ref={vsRef} />
            <span className="dh-u">m/s</span>
          </div>
          <div className="dh-agl">
            <span className="dh-k">AGL</span>
            <span className="dh-v" ref={aglRef} />
            <span className="dh-u">m</span>
          </div>
          <div className="dh-agl">
            <span className="dh-k">GIM</span>
            <span className="dh-v" ref={gimbalRef} />
            <span className="dh-u">°</span>
          </div>
        </div>

        <button className="dh-action" data-status={status} onClick={onAction}>
          {action.label}
          <kbd className="mono">{action.key}</kbd>
        </button>

        <StickViz leftRef={leftRef} rightRef={rightRef} gamepad={ui?.gamepad === true} />
      </div>

      <HelpPanel visible={visible && ui?.help === true} gamepad={ui?.gamepad === true} />
    </div>
  );
};

/** Shown on the black screen while the launch site streams in. */
export const DronePreparing: FC = () => {
  const preparing = useFlytake((s) => s.dronePreparing);
  const site = useFlytake((s) => s.droneSite) ?? launchSite().name;
  return (
    <div className="drone-preparing" data-visible={preparing} aria-hidden={!preparing}>
      <p className="mono">Preparing drone · {site}</p>
    </div>
  );
};
