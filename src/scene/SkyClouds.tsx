import { useFrame } from '@react-three/fiber';
import type { CloudsEffect } from '@takram/three-clouds';
import { CloudLayer, Clouds } from '@takram/three-clouds/r3f';
import { useCallback, useEffect, useRef, type FC } from 'react';
import type { Texture, WebGLRenderTarget, WebGLRenderer } from 'three';
import { CloudsDenoise } from './cloudsDenoise';
import { CloudsThrottle } from './cloudsThrottle';
import { MathUtils } from 'three';
import { getDestination } from '../camera/destinations';
import { ecefToGeodetic } from '../geo/wgs84';
import { useFlytake } from '../state/store';

/**
 * Volumetric clouds (@takram/three-clouds): fair-weather Sierra afternoon cumulus with a thin
 * cirrus deck. The weather is fixed; only the sun moves (time of day). Clouds render into
 * buffers that AerialPerspective composites (overlay), and their Beer shadow map darkens the
 * sunlit ground (shadow) and adds light shafts (shadowLength).
 *
 *   ?clouds=0          no clouds (also no cloud shadows / shafts)
 *   ?clouds=low|medium|high|ultra   quality preset (default high)
 *   ?coverage=0.24     cloud amount
 *   look-dev: ?cloudtu=0 (no temporal upscaling), ?cloudres=0.5, ?cloudden=0 (no denoise),
 *             ?cloudthrottle=0 (no pass alternation while the time of day is scrubbed)
 *
 * Every asset is served locally from /public/clouds (no GitHub at demo time).
 */
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const rawClouds = params.get('clouds');
export const CLOUDS_ENABLED = rawClouds !== '0' && rawClouds !== 'false' && rawClouds !== 'off';
const QUALITY = (['low', 'medium', 'high', 'ultra'] as const).find((q) => q === rawClouds) ?? 'high';
const coverageParam = Number(params.get('coverage'));
export const CLOUD_COVERAGE = params.get('coverage') != null && Number.isFinite(coverageParam) ? coverageParam : 0.24;
/** look-dev: ?cloudtu=0 disables temporal upscaling, ?cloudres=0.5 scales the clouds buffer */
const TEMPORAL_UPSCALE = params.get('cloudtu') !== '0';
const resParam = Number(params.get('cloudres'));
const RESOLUTION_SCALE = params.get('cloudres') != null && Number.isFinite(resParam) ? resParam : 1;
/** look-dev: ?cloudden=0 shows the raw (grainy) temporal-upscaled clouds */
const DENOISE = params.get('cloudden') !== '0';
/** look-dev: ?cloudthrottle=0 keeps both cloud passes every frame while the time is scrubbed */
const THROTTLE = params.get('cloudthrottle') !== '0';

type Updatable = { update(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget, deltaTime?: number): void };

/** Run the denoise right after the clouds resolve and hand its output to AerialPerspective. */
function attachDenoise(effect: CloudsEffect): () => void {
  const denoise = new CloudsDenoise();
  const target = effect as unknown as Updatable;
  const original = target.update;
  target.update = function update(renderer, inputBuffer, deltaTime) {
    original.call(effect, renderer, inputBuffer, deltaTime);
    const overlay = effect.atmosphereOverlay as { map: Texture } | null;
    if (overlay?.map != null) overlay.map = denoise.render(renderer, overlay.map, effect.mainCamera);
  };
  return () => {
    target.update = original;
    denoise.dispose();
  };
}

/** Ellipsoidal heights (m). Lake Tahoe sits at ~1,874 m, the crest peaks at ~2,950 m. */
const CUMULUS_BASE = 3900;

const ASSETS = '/clouds';
const geo = { lat: 0, lon: 0, height: 0 };

/**
 * The cloud field is a tiled local-weather texture: fine from inside the atmosphere, an
 * obviously repeating pattern from orbit. Fade the coverage in during the descent instead.
 */
function coverageForHeight(heightAboveSurface: number): number {
  const k = 1 - MathUtils.smoothstep(Math.log(Math.max(heightAboveSurface, 1)), Math.log(60_000), Math.log(350_000));
  return CLOUD_COVERAGE * k;
}

export const SkyClouds: FC = () => {
  const ref = useRef<CloudsEffect | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const throttle = useRef<CloudsThrottle | null>(null);
  useEffect(
    () => () => {
      detach.current?.();
      throttle.current?.dispose();
    },
    [],
  );
  const setRef = useCallback((effect: CloudsEffect | null) => {
    if (effect === ref.current) return;
    detach.current?.();
    throttle.current?.dispose();
    detach.current = effect != null && DENOISE ? attachDenoise(effect) : null;
    throttle.current = effect != null && THROTTLE ? new CloudsThrottle(effect) : null;
    ref.current = effect;
    // look-dev handle (GPU timing from the smoke scripts)
    const w = window as unknown as { __flytakeClouds?: CloudsEffect | null; __flytakeCloudsThrottle?: CloudsThrottle | null };
    w.__flytakeClouds = effect;
    w.__flytakeCloudsThrottle = throttle.current;
  }, []);
  useFrame(({ camera }) => {
    const effect = ref.current;
    if (effect == null) return;
    throttle.current?.tick(camera);
    const surface = getDestination(useFlytake.getState().destinationId).surfaceHeight;
    const height = ecefToGeodetic(camera.position, geo).height - surface;
    const coverage = coverageForHeight(height);
    if (Math.abs(effect.coverage - coverage) > 1e-4) effect.coverage = coverage;
  }, 0);

  return (
    <Clouds
      ref={setRef}
      qualityPreset={QUALITY}
      temporalUpscale={TEMPORAL_UPSCALE}
      resolutionScale={RESOLUTION_SCALE}
      coverage={CLOUD_COVERAGE}
      localWeatherTexture={`${ASSETS}/local_weather.png`}
      shapeTexture={`${ASSETS}/shape.bin`}
      shapeDetailTexture={`${ASSETS}/shape_detail.bin`}
      turbulenceTexture={`${ASSETS}/turbulence.png`}
      stbnTexture={`${ASSETS}/stbn.bin`}
      disableDefaultLayers
      // Scattered fair-weather cumulus, ~2 km above the lake (local weather repeats every
      // ~60 km at the default repeat; a smaller repeat gives smaller, more numerous cells)
      localWeatherRepeat-x={100}
      localWeatherRepeat-y={100}
      // a light westerly (~6 m/s): weather tiles are ~100 km, the shape textures repeat every
      // ~3.3 km / ~170 m, so the cells drift slowly and boil a little
      localWeatherVelocity-x={0.00006}
      shapeVelocity-x={0.0018}
      shapeDetailVelocity-x={0.012}
      // cloud shadows only matter within a few km of the camera
      shadow-farScale={0.25}
      shadow-maxFar={60_000}
    >
      <CloudLayer
        channel="r"
        altitude={CUMULUS_BASE}
        height={900}
        densityScale={0.2}
        shapeAlteringBias={0.32}
        coverageFilterWidth={0.55}
        shadow
      />
      <CloudLayer
        channel="g"
        altitude={CUMULUS_BASE + 250}
        height={1500}
        densityScale={0.16}
        shapeAlteringBias={0.3}
        coverageFilterWidth={0.6}
        shadow
      />
      <CloudLayer
        channel="b"
        altitude={9200}
        height={450}
        densityScale={0.0025}
        shapeAmount={0.4}
        shapeDetailAmount={0}
        coverageFilterWidth={0.5}
      />
    </Clouds>
  );
};
