import { useEffect, useRef, useState, type FC } from 'react';
import { getDestination } from '../camera/destinations';
import { MSL_TO_ELLIPSOID } from '../geo/locations';
import { ecefToGeodetic, headingPitchRollFromQuaternion } from '../geo/wgs84';
import { runtime } from '../scene/runtime';
import { useFlytake } from '../state/store';
import { formatAltitude, formatGimbal, formatLatLon } from './format';
import { formatLocalHours, useSun } from '../world/sun';

const START_HEIGHT = 24_000_000;
const cameraGeo = { lat: 0, lon: 0, height: 0 };

/** Descent readouts. DOM text is written directly at ~30 Hz from the shared runtime. */
export const Hud: FC = () => {
  const visible = useFlytake((s) => s.cues.hud);
  const destinationId = useFlytake((s) => s.destinationId);
  const altRef = useRef<HTMLSpanElement>(null);
  const posRef = useRef<HTMLSpanElement>(null);
  const gimbalRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const [place, setPlace] = useState('EARTH');
  const hours = useSun((st) => st.hours);

  useEffect(() => {
    const destination = getDestination(destinationId);
    let raf = 0;
    let last = 0;
    let lastPlace = '';
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 33) return;
      last = now;
      const path = runtime.path;
      const state = useFlytake.getState();
      if (path == null || (state.phase !== 'flying' && state.phase !== 'arrived')) return;
      const seconds = state.frozenT != null ? state.frozenT * path.duration : runtime.flightSeconds;
      const t = path.telemetry(seconds);
      const aboveSurface = t.height - destination.surfaceHeight;
      if (altRef.current) altRef.current.textContent = formatAltitude(t.height - MSL_TO_ELLIPSOID);
      if (posRef.current) posRef.current.textContent = formatLatLon(t.lat, t.lon);
      const camera = runtime.camera;
      if (gimbalRef.current && camera) {
        // Gimbal pitch and compass heading of the live camera (drone-pilot terms).
        ecefToGeodetic(camera.position, cameraGeo);
        const hpr = headingPitchRollFromQuaternion(cameraGeo.lat, cameraGeo.lon, camera.quaternion);
        gimbalRef.current.textContent = formatGimbal(hpr.pitch, hpr.heading);
      }
      if (barRef.current) {
        const endHeight = Math.max(1, destination.hero.height - destination.surfaceHeight);
        const k = 1 - Math.log(Math.max(aboveSurface, endHeight) / endHeight) / Math.log(START_HEIGHT / endHeight);
        barRef.current.style.transform = `scaleX(${Math.min(1, Math.max(0, k)).toFixed(4)})`;
      }
      const label = destination.places.find((p) => aboveSurface < p.below)?.label ?? '';
      if (label !== lastPlace) {
        lastPlace = label;
        setPlace(label);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [destinationId]);

  return (
    <div className="hud" data-visible={visible} aria-hidden={!visible}>
      <div className="hud-row hud-top">
        <span className="hud-label">Flytake · Descent</span>
        <span className="hud-place" key={place}>
          {place}
        </span>
        <span className="hud-label hud-right">Nov 7 · {formatLocalHours(hours)} PST</span>
      </div>
      <div className="hud-row hud-bottom">
        <div className="readout">
          <span className="readout-key">ALT</span>
          <span className="readout-value" ref={altRef} />
        </div>
        <div className="readout readout-center">
          <span className="readout-key">POS</span>
          <span className="readout-value" ref={posRef} />
        </div>
        <div className="readout readout-right">
          <span className="readout-key">GIMBAL · HDG</span>
          <span className="readout-value" ref={gimbalRef} />
        </div>
        <div className="hud-progress">
          <i ref={barRef} />
        </div>
      </div>
    </div>
  );
};
