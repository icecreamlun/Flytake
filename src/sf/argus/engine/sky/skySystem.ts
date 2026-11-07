/**
 * Time-of-day orchestration: astronomy → sky LUT → dome / IBL / fog / lights / exposure.
 * Everything is derived from one physically based sky so it stays coherent at any hour.
 *
 * Exposure strategy (important for other modules' emissives): the natural light (sun, moon, sky,
 * fog colours, env map) is scaled by an adaptation factor `envScale` computed from the scene's
 * physical luminance, while the renderer exposure itself stays close to 1. Emissive materials
 * (windows, street lamps, fire) can therefore be authored in display-ish units — ≈1 reads as a
 * clearly lit window, ≥3 blooms — and look the same at noon and at midnight.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../contracts';
import { lunarPosition, nightFactorFor, skyDirection, solarPosition } from '../astro';
import { fogData } from '../fog';
import { ambientData } from '../ambient';
import type { Lighting } from '../lighting';
import { SUN_E, transmittance } from './atmosphere';
import { SkyDome } from './skyDome';
import { SkyEnvironment } from './environment';
import { SkyLut } from './skyLut';

const D2R = Math.PI / 180;

/** Artistic knobs (live-tunable via __argus.engineDebug.sky.art + setTimeOfDay). */
const ART = {
  /** Base aerosol load (SF bay air is a little hazy). */
  mieBase: 0.7,
  /** Moon illuminance relative to the sun, for the sky LUT (real ≈ 2.5e-6 at full moon). */
  moonE: 2.2e-3,
  /** Moonlight key intensity relative to the sun (boosted: "day-for-night" readability). */
  moonKey: 1.5e-3,
  /** Light-pollution glow radiance at the horizon (per unit solar E). */
  glow: new THREE.Color(1.0, 0.58, 0.32).multiplyScalar(4.5e-4),
  nightSky: new THREE.Color(0.04, 0.08, 0.26).multiplyScalar(2.6e-4),
  /** Sea-level extinction for aerial perspective (1/m): visibility ≈ 3.9/β ≈ 60 km. */
  fogBeta: 5e-5,
  fogFalloff: 1 / 1100,
  /** Optical-depth multipliers near the camera / at range (see fog.ts slot 22). */
  fogNear: 0.45,
  fogFar: 1.35,
  /** Adaptation: scale = clamp((ref / sceneLum)^p). */
  adaptRef: 5.2,
  adaptPow: 0.62,
  adaptMax: 260,
  /** Night cap on adaptation (keeps night reading as night). */
  adaptNight: 50,
  /** Renderer exposure stays in this band; the rest goes into envScale. */
  exposureMin: 0.95,
  exposureMax: 1.25,
  /** Warm uplight from street lighting at night (hemisphere ground colour). */
  cityBounce: 0.02,
  /** Diffuse sky light: saturation by day / night, intensity scale by day, neutralising tint. */
  ambSat: 0.45,
  ambSatNight: 0.62,
  ambScale: 0.85,
  ambTint: new THREE.Color(1.06, 1.0, 0.9),
  /** Share of the horizontal sun illuminance reaching the (partly shadowed) ground that bounces. */
  bounceSunShare: 0.55,
};

/** Average city ground / façade albedo for the bounce light: warm grey #8a8070. */
const GROUND_ALBEDO = new THREE.Color(0x8a8070);

function desaturate(c: THREE.Color, sat: number): THREE.Color {
  const l = luminance(c);
  return c.setRGB(l + (c.r - l) * sat, l + (c.g - l) * sat, l + (c.b - l) * sat);
}

export interface SkyState {
  sunElevation: number;
  sunAzimuth: number;
  moonElevation: number;
  moonDir: THREE.Vector3;
  keyIsMoon: boolean;
  /** Renderer tone-mapping exposure. */
  exposure: number;
  /** Multiplier applied to all natural light (sun, moon, sky, IBL, fog). */
  envScale: number;
  /** Physical (unscaled) sky irradiance on an up-facing surface, per three.js light unit. */
  skyIrradiance: THREE.Color;
  sunColor: THREE.Color;
  moonPhase: number;
}

export class SkySystem {
  readonly lut: SkyLut;
  readonly dome: SkyDome;
  readonly environment: SkyEnvironment;
  readonly state: SkyState;
  /** Cloud layer coverage 0..1. */
  cloudCover = 0.3;
  readonly art = ART;
  /** Where collapse dust hangs (world x,z) and how far it spreads (m). */
  dustCenter: [number, number] = [-250, -100];
  dustRadius = 1900;
  private haze = 0;
  private readonly moonDir = new THREE.Vector3(0, -1, 0);
  private readonly tmpC = new THREE.Color();
  private readonly tmpV = new THREE.Vector3();

  constructor(
    renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly lighting: Lighting,
    private readonly env: EnvironmentState,
    private readonly fog: THREE.FogExp2,
  ) {
    this.lut = new SkyLut(renderer);
    this.dome = new SkyDome(this.lut.texture);
    scene.add(this.dome.mesh);
    this.environment = new SkyEnvironment(renderer, scene, this.dome);
    this.state = {
      sunElevation: 0,
      sunAzimuth: 0,
      moonElevation: 0,
      moonDir: this.moonDir,
      keyIsMoon: false,
      exposure: 1,
      envScale: 1,
      skyIrradiance: new THREE.Color(),
      sunColor: new THREE.Color(),
      moonPhase: 0,
    };
  }

  setHaze(amount: number): void {
    this.haze = THREE.MathUtils.clamp(amount, 0, 1);
  }

  /** Recompute everything for env.timeOfDay (+ haze). GPU bake + small readback; call on change only. */
  apply(forceEnv = false): void {
    const env = this.env;
    const st = this.state;
    const sun = solarPosition(env.timeOfDay);
    const moon = lunarPosition(env.timeOfDay);
    skyDirection(sun, env.sunDirection);
    skyDirection(moon, this.moonDir);
    env.nightFactor = nightFactorFor(sun.elevation);
    env.haze = this.haze;
    const night = env.nightFactor;
    st.sunElevation = sun.elevation;
    st.sunAzimuth = sun.azimuth;
    st.moonElevation = moon.elevation;
    const elong = Math.acos(THREE.MathUtils.clamp(env.sunDirection.dot(this.moonDir), -1, 1));
    st.moonPhase = (1 - Math.cos(elong)) / 2; // illuminated fraction

    // ── Bake the sky (physical units: per unit solar illuminance) ──
    const mie = ART.mieBase + this.haze * 4;
    const moonUp = THREE.MathUtils.smoothstep(moon.elevation, -2, 6);
    const moonBright = (0.2 + 0.8 * st.moonPhase) * moonUp;
    this.lut.bake(
      {
        sunDir: env.sunDirection,
        moonDir: this.moonDir,
        moonE: ART.moonE * moonBright * night,
        mieScale: mie,
        glow: this.tmpC.copy(ART.glow).multiplyScalar(night * (1 - 0.4 * this.haze)),
        nightSky: ART.nightSky.clone().multiplyScalar(night),
      },
      true,
    );
    const sunT = transmittance(env.sunDirection.y, 0.03, mie, st.sunColor);
    const skyIrrPhys = this.lut.irradianceUp(st.skyIrradiance).multiplyScalar(SUN_E);

    // ── Key light: sun, or the moon once the sun is well below the horizon ──
    const useMoon = sun.elevation < -4 && moon.elevation > -1;
    st.keyIsMoon = useMoon;
    let keyColor: THREE.Color;
    let keyIPhys: number;
    let keyDir: THREE.Vector3;
    if (!useMoon) {
      keyDir = env.sunDirection.y < 0.02 ? this.tmpV.copy(env.sunDirection).setY(0.02).normalize() : env.sunDirection;
      keyColor = sunT.clone();
      keyIPhys = SUN_E;
    } else {
      keyDir = this.moonDir.y < 0.05 ? this.tmpV.copy(this.moonDir).setY(0.05).normalize() : this.moonDir;
      keyColor = new THREE.Color(0.5, 0.66, 1.0).multiply(transmittance(this.moonDir.y, 0.03, mie));
      keyIPhys = SUN_E * ART.moonKey * moonBright * THREE.MathUtils.smoothstep(-sun.elevation, 4, 10);
    }
    const keyLum = luminance(keyColor) * keyIPhys * Math.max(keyDir.y, 0);

    // ── Adaptation → exposure + envScale ──
    const sceneLum = keyLum + luminance(skyIrrPhys) + 1e-6;
    const cap = THREE.MathUtils.lerp(ART.adaptNight, ART.adaptMax, THREE.MathUtils.smoothstep(sun.elevation, -12, -4));
    const adapt = THREE.MathUtils.clamp(Math.pow(ART.adaptRef / sceneLum, ART.adaptPow), 0.5, cap);
    const exposure = THREE.MathUtils.clamp(adapt, ART.exposureMin, ART.exposureMax);
    const k = adapt / exposure;
    st.exposure = exposure;
    st.envScale = k;
    const E = SUN_E * k; // scaled solar illuminance used for everything visible

    const L = this.lighting;
    L.setKeyDirection(keyDir);
    L.sun.color.copy(keyColor);
    L.sun.intensity = keyIPhys * k;
    L.sun.castShadow = L.sun.intensity > 1e-5;

    // ── Ambient balance (see ambient.ts) ──
    // The diffuse sky light is desaturated (eye adaptation to the sun) and scaled so the sun:sky
    // illuminance ratio sits near 8–10 : 1 at mid-day; at night the cool moonlit sky keeps more colour.
    const day = 1 - night;
    ambientData[0] = THREE.MathUtils.lerp(ART.ambSatNight, ART.ambSat, day);
    ambientData[1] = THREE.MathUtils.lerp(1.0, ART.ambScale, day);
    ambientData[4] = THREE.MathUtils.lerp(1, ART.ambTint.r, day);
    ambientData[5] = THREE.MathUtils.lerp(1, ART.ambTint.g, day);
    ambientData[6] = THREE.MathUtils.lerp(1, ART.ambTint.b, day);
    // Hemisphere: faint (equally desaturated) sky top-up + warm-grey ground bounce from the sunlit
    // streets and façades (multi-bounce approximation); warm city uplight at night.
    const skyIrr = skyIrrPhys.clone().multiplyScalar(k);
    const skyGrey = desaturate(skyIrr.clone(), ambientData[0]).multiplyScalar(ambientData[1]);
    const sunIrr = keyColor.clone().multiplyScalar(L.sun.intensity * Math.max(keyDir.y, 0));
    L.hemi.color.copy(skyGrey).multiplyScalar(0.05).add(sunIrr.clone().multiplyScalar(0.035));
    const bounce = this.tmpC.copy(sunIrr).multiplyScalar(ART.bounceSunShare).add(skyGrey).multiply(GROUND_ALBEDO);
    L.hemi.groundColor.copy(bounce).add(new THREE.Color(1.0, 0.64, 0.38).multiplyScalar(night * ART.cityBounce));
    L.hemi.intensity = 1;
    this.scene.environmentIntensity = 1;

    // ── Dome ──
    const u = this.dome.uniforms;
    u.uSunE.value = E;
    (u.uSunDir.value as THREE.Vector3).copy(env.sunDirection);
    (u.uSunDisc.value as THREE.Color).copy(sunT).multiplyScalar(Math.min(E * 70, 700));
    (u.uMoonDir.value as THREE.Vector3).copy(this.moonDir);
    // Moon disc: faint by day, bright (blooming) at night.
    const zenithScene = this.lut.sample(this.tmpV.set(0, 1, 0), new THREE.Color()).multiplyScalar(E);
    const moonDiscI = THREE.MathUtils.lerp(luminance(zenithScene) * 2.2, 2.6, night) * moonUp;
    (u.uMoonColor.value as THREE.Color).setRGB(1.0, 0.96, 0.88).multiplyScalar(moonDiscI);
    // City light pollution + a bright moon wash out the fainter stars.
    u.uStars.value = THREE.MathUtils.smoothstep(-sun.elevation, 7, 15) * 1.1 * (1 - this.haze * 0.8) * (1 - 0.45 * moonBright);
    u.uCloudCover.value = this.cloudCover;
    const cloudT = transmittance(env.sunDirection.y, 3.5, mie, new THREE.Color());
    (u.uCloudLit.value as THREE.Color).copy(cloudT).multiplyScalar(E * 0.3);
    if (useMoon) (u.uCloudLit.value as THREE.Color).add(keyColor.clone().multiplyScalar(L.sun.intensity * 0.3));
    const amb = (u.uCloudAmb.value as THREE.Color).copy(skyIrr).multiplyScalar(0.16);
    amb.add(new THREE.Color(1.0, 0.6, 0.35).multiplyScalar(night * 0.025));
    u.uHaze.value = this.haze * 0.45;
    const dust = (u.uDust.value as THREE.Color).setRGB(0.62, 0.5, 0.38);
    dust.multiply(this.tmpC.copy(keyColor).multiplyScalar(L.sun.intensity * Math.max(keyDir.y, 0) * 0.12).add(skyIrr.clone().multiplyScalar(0.3)));
    dust.add(new THREE.Color(0.9, 0.55, 0.3).multiplyScalar(night * 0.04));

    // ── Fog (shared uniform array, see fog.ts for the layout) ──
    const f = fogData;
    f[0] = ART.fogBeta * (1 + this.haze * 0.8);
    f[1] = ART.fogFalloff;
    f[2] = this.haze * 2.6e-3;
    f[3] = 1;
    f[4] = env.sunDirection.x;
    f[5] = env.sunDirection.y;
    f[6] = env.sunDirection.z;
    f[7] = 0.76;
    const sunGlow = this.tmpC.copy(sunT).multiplyScalar(E * 0.022);
    f[8] = sunGlow.r;
    f[9] = sunGlow.g;
    f[10] = sunGlow.b;
    f[11] = 1 / 160;
    f[12] = dust.r;
    f[13] = dust.g;
    f[14] = dust.b;
    f[15] = 0.992;
    const dir = new THREE.Vector3();
    const col = new THREE.Color();
    const avg = new THREE.Color(0, 0, 0);
    // In-scatter colour for km-scale paths is bluer than the (infinite-path) horizon: sample ~5° up.
    const e = 5 * D2R;
    for (let i = 0; i < 16; i++) {
      const az = (i / 16) * Math.PI * 2;
      dir.set(Math.sin(az) * Math.cos(e), Math.sin(e), -Math.cos(az) * Math.cos(e));
      this.lut.sample(dir, col).multiplyScalar(E);
      col.lerp(dust, this.haze * 0.5);
      f[16 + i * 4] = col.r;
      f[17 + i * 4] = col.g;
      f[18 + i * 4] = col.b;
      avg.r += col.r / 16;
      avg.g += col.g / 16;
      avg.b += col.b / 16;
    }
    const zen = new THREE.Color(0, 0, 0);
    for (let i = 0; i < 4; i++) {
      const az = (i / 4) * Math.PI * 2;
      dir.set(Math.sin(az) * Math.cos(0.6), Math.sin(0.6), -Math.cos(az) * Math.cos(0.6));
      this.lut.sample(dir, col).multiplyScalar(E / 4);
      zen.add(col);
    }
    f[80] = zen.r;
    f[81] = zen.g;
    f[82] = zen.b;
    // Dust footprint: the core study area (FiDi → Chinatown) plus margin.
    f[84] = this.dustCenter[0];
    f[85] = this.dustCenter[1];
    f[86] = this.dustRadius;
    // Aerial-perspective distance profile: ~45% density inside ~1.2 km, ramping to 1.35× by ~8 km.
    f[88] = ART.fogNear;
    f[89] = ART.fogFar;
    f[90] = 1200;
    f[91] = 8000;
    this.fog.color.copy(avg);
    this.fog.density = Math.sqrt(f[0] * 3000) / 3000;

    this.environment.request(forceEnv);
  }

  /** Per-frame: animate clouds/stars, finish throttled env-map regeneration. */
  update(elapsed: number): void {
    this.dome.uniforms.uTime.value = elapsed;
    this.environment.update();
  }
}

function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}
