import { describe, expect, it } from 'vitest';
import { cinematicIdlePose, idleLongitudeOffset } from '../camera/idle';
import { findDestination } from '../camera/destinations';
import { cuesAt } from '../camera/timeline';
import { formatAltitude, formatGimbal, formatLatLon, formatSpeed } from './format';

describe('HUD formatting', () => {
  it('formats altitude bands', () => {
    expect(formatAltitude(24_000_000)).toBe('24,000 km');
    expect(formatAltitude(91_100)).toBe('91.1 km');
    expect(formatAltitude(6_420)).toBe('6.42 km · 21,063 ft');
    expect(formatAltitude(971)).toBe('971 m · 3,186 ft');
  });
  it('formats position and speed', () => {
    expect(formatLatLon(38.942, -120.104)).toBe('38.9420° N  120.1040° W');
    expect(formatSpeed(7600)).toBe('7.6 km/s');
    expect(formatSpeed(972.4)).toBe('972 m/s');
    expect(formatSpeed(2.5)).toBe('2.5 m/s');
  });
  it('formats gimbal pitch and heading', () => {
    expect(formatGimbal(-90, 0)).toBe('\u221290.0° · 000°');
    expect(formatGimbal(-11, 25.2)).toBe('\u221211.0° · 025°');
    expect(formatGimbal(-0.01, 359.7)).toBe('0.0° · 000°');
    expect(formatGimbal(5, -10)).toBe('5.0° · 350°');
  });
});

describe('start screen helpers', () => {
  it('finds the Emerald Bay preset from loose input', () => {
    expect(findDestination('Emerald Bay, Lake Tahoe')?.id).toBe('emerald-bay');
    expect(findDestination('lake tahoe')?.id).toBe('emerald-bay');
    expect(findDestination('Paris')).toBeNull();
    expect(findDestination('  ')).toBeNull();
  });
  it('idles eastward, then sways in a bounded window west of Tahoe', () => {
    expect(idleLongitudeOffset(0)).toBe(0);
    const a = idleLongitudeOffset(10) - idleLongitudeOffset(9);
    const b = idleLongitudeOffset(200) - idleLongitudeOffset(199);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(Math.abs(b));
    // Tahoe (-120.1) is near the centre of the disc after about a minute
    expect(Math.abs(cinematicIdlePose(60).lon - -120.1)).toBeLessThan(2);
    // Hours later the camera is still just west of Tahoe (never drifts onto the night side)
    for (let t = 30; t <= 6 * 3600; t += 7.3) {
      const lon = cinematicIdlePose(t).lon;
      expect(lon).toBeGreaterThan(-125);
      expect(lon).toBeLessThan(-120.5);
    }
  });
});

describe('cue sheet', () => {
  it('orders the overlays', () => {
    expect(cuesAt(0).hud).toBe(false);
    expect(cuesAt(1).hud).toBe(true);
    expect(cuesAt(5).bars).toBe(false);
    expect(cuesAt(8).bars).toBe(true);
    expect(cuesAt(13).bars).toBe(false);
    expect(cuesAt(15).title).toBe(true);
    expect(cuesAt(25).title).toBe(false);
    expect(cuesAt(25).controls).toBe(true);
  });
});
