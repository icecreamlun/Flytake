import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PrecomputedTexturesLoader, type PrecomputedTextures } from '@takram/three-atmosphere';
import { Atmosphere, Sky, Stars, type AtmosphereApi, type StarsImpl } from '@takram/three-atmosphere/r3f';
import { useMemo, type FC } from 'react';
import { MathUtils, type Mesh, type ShaderMaterial, type WebGLRenderer } from 'three';
import { ecefToGeodetic } from '../geo/wgs84';
import { ATMOSPHERE_DATE, FLAGS, TILES_PROVIDER } from '../config';
import { useFlytake } from '../state/store';
import { AdaptiveResolution } from './AdaptiveResolution';
import { CameraDirector } from './CameraDirector';
import { Globe } from './Globe';
import { patchMaterial, patchStarsDepth } from './patchAtmosphere';
import { PostFX } from './PostFX';
import { ProxyGlobe } from './ProxyGlobe';
import { WaterSurface } from './WaterSurface';
import { World } from '../world/World';
import { onSunChange } from '../world/sun';

// Precomputed atmosphere tables are served from /public/atmosphere (no runtime generation,
// no dependency on GitHub during a demo). One load per renderer, even under StrictMode.
let texturesCache: { gl: WebGLRenderer; textures: PrecomputedTextures } | null = null;
function useAtmosphereTextures(): PrecomputedTextures {
  const gl = useThree((s) => s.gl);
  return useMemo(() => {
    if (texturesCache?.gl === gl) return texturesCache.textures;
    const textures = new PrecomputedTexturesLoader().setType(gl).load(
      '/atmosphere',
      () => useFlytake.getState().setAtmosphereReady(),
      undefined,
      (error) => {
        console.error('[flytake] atmosphere textures failed to load', error);
        useFlytake.getState().setAtmosphereReady();
      },
    );
    texturesCache = { gl, textures };
    return textures;
  }, [gl]);
}

// Both materials carry takram's "halo seen from space" bug; patch their shaders on mount.
// Neither object may be hit by raycasts: GlobeControls would grab the screen quad or a star as
// its drag pivot (that turned the camera into NaN).
const noRaycast = (): void => {};
let stars: StarsImpl | null = null;
const patchStars = (points: StarsImpl | null): void => {
  stars = points;
  if (!points) return;
  patchStarsDepth(patchMaterial(points.material));
  points.raycast = noRaycast;
};

/** Brighter than physical in orbit (the exposure is set for the sunlit planet), gone by the
 * time the camera is inside the daytime atmosphere. */
const STARS_INTENSITY = 30;
const starsGeo = { lat: 0, lon: 0, height: 0 };
const StarsFader: FC = () => {
  useFrame(({ camera }) => {
    if (stars == null) return;
    const h = ecefToGeodetic(camera.position, starsGeo).height;
    const k = MathUtils.smoothstep(Math.log(Math.max(h, 1)), Math.log(40_000), Math.log(400_000));
    stars.material.intensity = STARS_INTENSITY * k;
    stars.visible = k > 0;
  });
  return null;
};
const patchSky = (mesh: Mesh | null): void => {
  if (!mesh) return;
  if (!Array.isArray(mesh.material)) patchMaterial(mesh.material as ShaderMaterial);
  mesh.raycast = noRaycast;
};

// The time of day is live (src/world/sun.ts): drive the atmosphere imperatively, so dragging
// the time does not re-render the scene graph.
let unbindSun: (() => void) | null = null;
const bindAtmosphere = (api: AtmosphereApi | null): void => {
  unbindSun?.();
  unbindSun = api ? onSunChange((date) => api.updateByDate(date)) : null;
};

const Scene: FC = () => {
  const textures = useAtmosphereTextures();
  return (
    <Atmosphere ref={bindAtmosphere} textures={textures} date={ATMOSPHERE_DATE}>
      {/* The sky is a screen quad drawn first (not AerialPerspective's `sky` option, which
          overwrites every far-plane pixel and erases the stars); stars draw over it. */}
      <Sky ref={patchSky} renderOrder={-1} />
      <Stars data="/atmosphere/stars.bin" ref={patchStars} intensity={STARS_INTENSITY} pointSize={2} />
      <StarsFader />
      {TILES_PROVIDER != null ? <Globe /> : <ProxyGlobe />}
      {TILES_PROVIDER != null && FLAGS.water !== 'off' && <WaterSurface />}
      {FLAGS.scene && <World />}
      <CameraDirector />
      <PostFX />
      <AdaptiveResolution />
    </Atmosphere>
  );
};

export const Experience: FC = () => (
  <Canvas
    className="scene-canvas"
    // The effect composer owns the depth buffer; the atmosphere reads it.
    gl={{ depth: false, stencil: false, antialias: false, alpha: false, powerPreference: 'high-performance' }}
    dpr={[1, FLAGS.dpr]}
    flat
    frameloop="always"
    camera={{ fov: 30, near: 1e6, far: 1e8, position: [0, 0, 3e7] }}
  >
    <Scene />
  </Canvas>
);
