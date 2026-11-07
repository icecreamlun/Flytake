import { useFrame, useThree } from '@react-three/fiber';
import type { GlobeControls as GlobeControlsImpl, TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer';
import {
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UpdateOnChangePlugin,
} from '3d-tiles-renderer/plugins';
import { GlobeControls, TilesPlugin, TilesRenderer, TilesRendererContext } from '3d-tiles-renderer/r3f';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type FC } from 'react';
import { PerspectiveCamera, type Material, type Mesh, type Object3D, type Texture } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { getDestination } from '../camera/destinations';
import { ecefToGeodetic, poseToSample } from '../camera/flyIn';
import { CESIUM_ION_TOKEN, FLAGS, GOOGLE_MAPS_API_KEY, ION_GOOGLE_TILES_ASSET_ID, TILES_PROVIDER } from '../config';
import { useFlytake } from '../state/store';
import { adjustNearFar, FAR_MARGIN, NEAR_MARGIN } from './clipping';
import { runtime, tilesLoading } from './runtime';
import { patchWaterMaterial } from './water';
import { patchSceneClip } from '../world/clip';

// Plugin constructor args must keep their identity across renders: TilesPlugin re-creates the
// plugin (new session, new root request, all tiles dropped) whenever `args` changes shallowly.
// useRecommendedSettings: false keeps our errorTarget (the plugin would force 20 otherwise).
const GOOGLE_ARGS = [{ apiToken: GOOGLE_MAPS_API_KEY, autoRefreshToken: true, useRecommendedSettings: false }];
const ION_ARGS = [
  { apiToken: CESIUM_ION_TOKEN, assetId: ION_GOOGLE_TILES_ASSET_ID, autoRefreshToken: true, useRecommendedSettings: false },
];
// Keep mipmaps: without them the lake and distant ridges shimmer at grazing angles.
// Google tiles carry no normals; generate them only when the post stack shades slopes.
const COMPRESSION_ARGS = [{ disableMipmaps: false, generateNormals: FLAGS.normals === 'generated' }];
// Dithered cross-fade between LODs instead of popping.
const FADE_ARGS = [{ fadeDuration: 450, maximumFadeOutTiles: 160 }];

// One decoder for the app lifetime (three's default decoder path resolves through Vite).
const draco = new DRACOLoader();

const GIB = 2 ** 30;

const HARDENED = Symbol('flytake-hardened');
interface GoogleCloudAuthLike {
  _tokenRefreshPromise: Promise<unknown> | null;
  refreshToken(options?: unknown): Promise<unknown>;
  [HARDENED]?: true;
}

/**
 * GoogleCloudAuth (0.5.4) keeps a rejected session-refresh promise forever: after one failed
 * refresh (e.g. a 429 followed by a network blip) every later tile fetch awaits it and fails
 * until reload. Clear it on failure so the next 4xx simply tries again. The ion route
 * registers this plugin internally once the ion endpoint resolves, so this is re-checked.
 */
function hardenTokenRefresh(tiles: TilesRendererImpl | null): void {
  const plugin = tiles?.getPluginByName('GOOGLE_CLOUD_AUTH_PLUGIN') as { auth?: GoogleCloudAuthLike } | null | undefined;
  const auth = plugin?.auth;
  if (auth == null || auth[HARDENED] || typeof auth.refreshToken !== 'function') return;
  auth[HARDENED] = true;
  const refresh = auth.refreshToken.bind(auth);
  auth.refreshToken = (options) => {
    const promise = refresh(options);
    promise.catch(() => {
      if (auth._tokenRefreshPromise === promise) auth._tokenRefreshPromise = null;
    });
    return promise;
  };
}
/** 1440 x 900 CSS px: the window size the default error target was tuned for */
const REFERENCE_VIEWPORT_AREA = 1440 * 900;

/** Google Photorealistic 3D Tiles in ECEF (tiles.group stays identity: world == ECEF). */
export const Globe: FC = () => {
  const gl = useThree((s) => s.gl);
  const anisotropy = useMemo(() => Math.min(8, gl.capabilities.getMaxAnisotropy()), [gl]);
  // The error target is in CSS px, so a bigger window loads quadratically more tiles. Scale
  // it with the window so the hero view stays near ~900 tiles / ~1 GB on any laptop screen.
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const errorTarget = useMemo(() => {
    const k = Math.sqrt((width * height) / REFERENCE_VIEWPORT_AREA);
    return Math.round(FLAGS.errorTarget * Math.min(1.5, Math.max(1, k)) * 10) / 10;
  }, [width, height]);

  const setTiles = useCallback((tiles: TilesRendererImpl | null) => {
    runtime.tiles = tiles;
  }, []);

  const setControls = useCallback((controls: GlobeControlsImpl | null) => {
    runtime.controls = controls;
    // The scripted camera owns the view until the handoff; `enabled` is only ever driven
    // imperatively (store.handoff / replay) so prop re-application can never reset it.
    if (controls) controls.enabled = useFlytake.getState().phase === 'free';
  }, []);

  const onLoadModel = useCallback(
    ({ scene, tile }: { scene: Object3D; tile?: { geometricError?: number } }) => {
      hardenTokenRefresh(runtime.tiles);
      const geometricError = tile?.geometricError ?? 0;
      scene.traverse((object) => {
        const materials = (object as Mesh).material as Material | Material[] | undefined;
        for (const material of Array.isArray(materials) ? materials : materials ? [materials] : []) {
          const textured = material as Material & { map?: Texture | null };
          if (textured.map == null) continue;
          textured.map.anisotropy = anisotropy;
          patchWaterMaterial(textured, geometricError);
          if (FLAGS.scene) patchSceneClip(textured);
        }
      });
    },
    [anisotropy],
  );

  const onTilesLoadEnd = useCallback(() => {
    if (runtime.tiles?.root != null) useFlytake.getState().setTilesReady();
  }, []);

  const onLoadError = useCallback(({ tile, error, url }: { tile: unknown; error: Error; url: string | URL }) => {
    hardenTokenRefresh(runtime.tiles);
    if (tile != null) return; // individual tile failures are retried / ignored
    const message = error?.message ?? String(error);
    console.error('[flytake] root tileset failed to load', String(url).replace(/(key|access_token|session)=[^&]+/g, '$1=…'), message);
    useFlytake.getState().setTilesError(message);
  }, []);

  if (TILES_PROVIDER == null) return null;

  return (
    <TilesRenderer
      ref={setTiles}
      errorTarget={errorTarget}
      autoDisableRendererCulling={false}
      // Hard cap: when full, refinement stops (stats.refused > 0). The hero view alone is ~0.9 GB.
      // Unused tiles are only evicted above minBytesSize, which is set high enough that the
      // arrival view preloaded on the start screen survives the descent untouched.
      lruCache-maxBytesSize={1.75 * GIB}
      lruCache-minBytesSize={1.5 * GIB}
      // library default; more parallel requests per origin only raise the odds of HTTP 429
      downloadQueue-maxJobsPerOrigin={25}
      parseQueue-maxJobs={6}
      onLoadModel={onLoadModel}
      onTilesLoadEnd={onTilesLoadEnd}
      onLoadError={onLoadError}
    >
      {TILES_PROVIDER === 'google' ? (
        <TilesPlugin plugin={GoogleCloudAuthPlugin} args={GOOGLE_ARGS} />
      ) : (
        <TilesPlugin plugin={CesiumIonAuthPlugin} args={ION_ARGS} />
      )}
      <TilesPlugin plugin={GLTFExtensionsPlugin} dracoLoader={draco} />
      <TilesPlugin plugin={TileCompressionPlugin} args={COMPRESSION_ARGS} />
      <TilesPlugin plugin={TilesFadePlugin} args={FADE_ARGS} />
      <TilesPlugin plugin={UpdateOnChangePlugin} />
      <Controls onControls={setControls} />
      <HeroPreloader />
    </TilesRenderer>
  );
};

/** GlobeControls that only ever raycast the tiles (not the sky quad, stars or future overlays). */
const Controls: FC<{ onControls: (controls: GlobeControlsImpl | null) => void }> = ({ onControls }) => {
  const tiles = useContext(TilesRendererContext);
  if (tiles == null) return null;
  return (
    <GlobeControls
      ref={onControls}
      scene={tiles.group}
      enableDamping
      maxAltitude={0.49 * Math.PI}
      nearMargin={NEAR_MARGIN}
      farMargin={FAR_MARGIN}
    />
  );
};

/** Below this camera height (m above the lake) the hidden arrival camera is dropped mid-flight. */
const PRELOAD_MIN_FLIGHT_HEIGHT = 1_500_000;
/** The arrival view counts as cached after this long with empty download / parse queues. */
const READY_QUIET_SECONDS = 0.6;
/** Never hold Fly back longer than this (slow network: land and refine on screen instead). */
const READY_TIMEOUT_SECONDS = 25;
const preloadGeo = { lat: 0, lon: 0, height: 0 };

/**
 * Registers a hidden camera at the arrival pose on the start screen (and for the first seconds
 * of a flight) so the hero view's tiles are already cached when the camera lands.
 *
 * TilesRenderer draws the union of what every registered camera selects, at the finest LOD
 * any camera asks for. Left registered during the descent, the hidden camera's wedge of very
 * fine tiles was drawn next to tiles several levels coarser (a patchwork of different water
 * colours from ~1,000 km down, plus ~900 extra draw calls). It is therefore removed once the
 * flight drops below PRELOAD_MIN_FLIGHT_HEIGHT; the LRU cache keeps its tiles until landing.
 * Also flags `heroReady` for the start screen's Fly button.
 */
const HeroPreloader: FC = () => {
  const tiles = useContext(TilesRendererContext);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const destinationId = useFlytake((s) => s.destinationId);
  const camera = useMemo(() => new PerspectiveCamera(), []);
  const state = useRef({ registered: false, quiet: 0, waited: 0 });

  // Pose the hidden camera at the arrival view; keep its resolution in sync with the canvas.
  useLayoutEffect(() => {
    if (width === 0 || height === 0) return;
    const sample = poseToSample(getDestination(destinationId).hero);
    camera.position.copy(sample.position);
    camera.quaternion.copy(sample.quaternion);
    camera.fov = sample.fov;
    camera.aspect = width / height;
    adjustNearFar(camera);
    camera.updateMatrixWorld(true);
    if (tiles != null && state.current.registered) tiles.setResolution(camera, width, height);
  }, [tiles, camera, width, height, destinationId]);

  useEffect(
    () => () => {
      if (tiles != null && state.current.registered) tiles.deleteCamera(camera);
      state.current.registered = false;
    },
    [tiles, camera],
  );

  useFrame(({ camera: main, size }, delta) => {
    if (tiles == null) return;
    const store = useFlytake.getState();
    const s = state.current;
    let wanted = false;
    if (store.frozenT == null) {
      if (store.phase === 'start') wanted = true;
      else if (store.phase === 'flying') {
        const surface = getDestination(store.destinationId).surfaceHeight;
        wanted = ecefToGeodetic(main.position, preloadGeo).height - surface > PRELOAD_MIN_FLIGHT_HEIGHT;
      }
    }
    if (wanted !== s.registered && size.width > 0 && size.height > 0) {
      if (wanted) {
        tiles.setCamera(camera);
        tiles.setResolution(camera, size.width, size.height);
      } else {
        tiles.deleteCamera(camera);
      }
      s.registered = wanted;
    }
    if (store.phase === 'start' && !store.heroReady) {
      s.waited += delta;
      s.quiet = s.registered && !tilesLoading() ? s.quiet + delta : 0;
      if (s.quiet >= READY_QUIET_SECONDS || s.waited >= READY_TIMEOUT_SECONDS) store.setHeroReady();
    }
  }, -1);

  return null;
};
