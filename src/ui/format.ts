/** HUD number formatting (all inputs in SI units). */

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const M_TO_FT = 3.28084;

/** Altitude above mean sea level: "24,000 km", "91.1 km", "6.42 km · 21,063 ft", "971 m · 3,186 ft". */
export function formatAltitude(meters: number): string {
  const m = Number.isFinite(meters) ? meters : 0;
  const km = m / 1000;
  if (km >= 100) return `${int.format(km)} km`;
  if (km >= 10) return `${km.toFixed(1)} km`;
  const ft = `${int.format(m * M_TO_FT)} ft`;
  if (km >= 1) return `${km.toFixed(2)} km · ${ft}`;
  return `${int.format(m)} m · ${ft}`;
}

/** "38.9420° N 120.1040° W" */
export function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}  ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

/** "7.6 km/s", "972 m/s", "2.5 m/s" */
export function formatSpeed(mps: number): string {
  const v = Math.max(0, Number.isFinite(mps) ? mps : 0);
  if (v >= 1000) return `${(v / 1000).toFixed(1)} km/s`;
  if (v >= 10) return `${int.format(v)} m/s`;
  return `${v.toFixed(1)} m/s`;
}

/** Gimbal pitch and compass heading: "−90.0° · 000°", "−11.0° · 025°". */
export function formatGimbal(pitchDeg: number, headingDeg: number): string {
  const p = Number.isFinite(pitchDeg) ? pitchDeg : 0;
  const h = Number.isFinite(headingDeg) ? ((Math.round(headingDeg) % 360) + 360) % 360 : 0;
  const pitch = Math.abs(p).toFixed(1);
  const sign = p < 0 && pitch !== '0.0' ? '\u2212' : '';
  return `${sign}${pitch}° · ${String(h).padStart(3, '0')}°`;
}
