import { useFrame, useThree } from '@react-three/fiber';
import { AtmosphereContext } from '@takram/three-atmosphere/r3f';
import { useContext, useEffect, useMemo, type FC } from 'react';
import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  PerspectiveCamera,
  Plane,
  Vector3,
  WebGLRenderTarget,
  type Object3D,
} from 'three';
import { getDestination } from '../camera/destinations';
import { FLAGS } from '../config';
import { TAHOE } from '../geo/locations';
import { ecefToGeodetic, enuVectors, geodeticToEcef } from '../geo/wgs84';
import { albedoForHeight } from '../scene/exposure';
import { useFlytake } from '../state/store';
import { REFLECTION_UNIFORMS } from './waterShading';
import { WATER_ASSET_UNIFORMS, loadWaterAssets } from './waterAssets';
import { WaterSkyProbe } from './waterSky';
import { SUN, onSunChange } from './sun';
import { insideScene, REFLECTION_LAYER, SCENE_FRAME, SCENE_FRAME_INV, SCENE_LAKE_LEVEL } from './scene';

/**
 * Planar reflection of the lake: every frame the camera is low over the custom scene, the
 * terrain and the forest are drawn from the camera mirrored in the water plane into a
 * half-resolution target, which the terrain's water shader samples (Fresnel-weighted,
 * wave-distorted, blurred by roughness through its mipmaps). Everything in that pass outputs the
 * same pre-lit albedo as the main pass, so the aerial-perspective lighting applies to the
 * reflection consistently.
 *
 * Also owns the other inputs of the lake shader (waterShading.ts): the wave / lake textures,
 * the sky probe (re-rendered whenever the sun moves) and the AerialPerspective albedo scale
 * (the same function of height PostFX uses).
 */
const MAX_HEIGHT = 1500; // m above the lake: higher up the reflections are too small to matter
const SCALE = 0.5;

const _geo = { lat: 0, lon: 0, height: 0 };
const _p0 = new Vector3();
const _n = new Vector3();
const _e = new Vector3();
const _no = new Vector3();
const _pos = new Vector3();
const _dir = new Vector3();
const _up = new Vector3();
const _target = new Vector3();
const _enu = new Vector3();
const _plane = new Plane();
const _geoA = { lat: 0, lon: 0, height: 0 };

export const WaterReflection: FC<{ forest?: () => Object3D | null }> = ({ forest }) => {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const target = useMemo(
    () =>
      new WebGLRenderTarget(1, 1, {
        type: HalfFloatType,
        minFilter: LinearMipmapLinearFilter,
        magFilter: LinearFilter,
        generateMipmaps: true,
        depthBuffer: true,
      }),
    [],
  );
  const mirror = useMemo(() => {
    const c = new PerspectiveCamera();
    c.layers.set(REFLECTION_LAYER);
    c.matrixAutoUpdate = true;
    return c;
  }, []);

  // lake textures, sky probe
  useEffect(() => {
    // ?water2=0: the previous lake shading (look-dev / perf A/B)
    if (new URLSearchParams(location.search).get('water2') === '0') return;
    loadWaterAssets(Math.min(8, gl.capabilities.getMaxAnisotropy()));
  }, [gl]);
  const atmosphere = useContext(AtmosphereContext);
  const probe = useMemo(
    () => (atmosphere.textures ? new WaterSkyProbe(atmosphere.textures, atmosphere.ellipsoid, atmosphere.correctAltitude) : null),
    [atmosphere.textures, atmosphere.ellipsoid, atmosphere.correctAltitude],
  );
  const probeState = useMemo(() => ({ dirty: true, ready: false }), []);
  useEffect(() => {
    if (!probe) return;
    const unbind = onSunChange(() => {
      probeState.dirty = true;
    });
    return () => {
      unbind();
      WATER_ASSET_UNIFORMS.uSkyOn.value = 0;
      WATER_ASSET_UNIFORMS.uSkyProbe.value = null;
      probe.dispose();
    };
  }, [probe, probeState]);
  useFrame(({ camera }) => {
    // the probe needs the atmosphere tables: render once they are in, then on every sun change
    const ready = useFlytake.getState().atmosphereReady;
    if (probe && ready && (probeState.dirty || !probeState.ready)) {
      probe.update(gl, SUN.dirEcef);
      WATER_ASSET_UNIFORMS.uSkyProbe.value = probe.target.texture;
      WATER_ASSET_UNIFORMS.uSkyOn.value = 1;
      probeState.dirty = false;
      probeState.ready = true;
    }
    // AerialPerspective's albedoScale (PostFX): radiance-true terms divide it out
    const surface = getDestination(useFlytake.getState().destinationId).surfaceHeight;
    const h = ecefToGeodetic(camera.position, _geoA).height - surface;
    WATER_ASSET_UNIFORMS.uAlbedoInv.value = 1 / (albedoForHeight(h) * (FLAGS.albedoScale / 1.4));
  }, 0.4);

  useEffect(() => {
    target.setSize(Math.max(1, Math.round(size.width * dpr * SCALE)), Math.max(1, Math.round(size.height * dpr * SCALE)));
  }, [target, size, dpr]);
  useEffect(
    () => () => {
      REFLECTION_UNIFORMS.uReflOn.value = 0;
      REFLECTION_UNIFORMS.uReflTex.value = null;
      target.dispose();
    },
    [target],
  );

  useFrame(({ camera }) => {
    const cam = camera as PerspectiveCamera;
    ecefToGeodetic(cam.position, _geo);
    const lake = TAHOE.lakeEllipsoidHeight + SCENE_LAKE_LEVEL;
    const above = _geo.height - lake;
    _enu.copy(cam.position).applyMatrix4(SCENE_FRAME_INV);
    const on =
      above > 0.05 && above < MAX_HEIGHT && insideScene(_enu, -2000) && !(window as { __flytakeReflOff?: boolean }).__flytakeReflOff;
    REFLECTION_UNIFORMS.uReflOn.value = on ? 1 : 0;
    if (!on) return;

    // the forest's meshes are (re)created as it streams: keep them on the reflection layer
    forest?.()?.traverse((o) => o.layers.enable(REFLECTION_LAYER));

    // water plane at the camera's nadir (geodetic up there), mirror the camera in it
    geodeticToEcef(_geo.lat, _geo.lon, lake, _p0);
    enuVectors(_geo.lat, _geo.lon, _e, _no, _n);
    const reflect = (v: Vector3, point: boolean) => {
      const d = point ? _target.copy(v).sub(_p0).dot(_n) : v.dot(_n);
      return v.addScaledVector(_n, -2 * d);
    };
    _pos.copy(cam.position);
    reflect(_pos, true);
    cam.getWorldDirection(_dir);
    reflect(_dir, false);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    reflect(_up, false);
    mirror.position.copy(_pos);
    mirror.up.copy(_up);
    mirror.lookAt(_target.copy(_pos).add(_dir));
    mirror.projectionMatrix.copy(cam.projectionMatrix);
    mirror.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    mirror.near = cam.near;
    mirror.far = cam.far;
    mirror.updateMatrixWorld();

    // ENU -> mirror clip space (float64 here; the shader gets small numbers)
    REFLECTION_UNIFORMS.uReflMatrix.value
      .copy(mirror.projectionMatrix)
      .multiply(mirror.matrixWorldInverse)
      .multiply(SCENE_FRAME);

    // clip away everything below the water (tile skirts would stand up as walls)
    _plane.setFromNormalAndCoplanarPoint(_n, _p0);
    const prevTarget = gl.getRenderTarget();
    const prevClip = gl.clippingPlanes;
    const prevAutoClear = gl.autoClear;
    const prevBg = scene.background;
    gl.clippingPlanes = [_plane];
    scene.background = null;
    gl.setRenderTarget(target);
    gl.setClearColor(0x000000, 0);
    gl.autoClear = true;
    // the water itself is never in its own reflection (and must not sample the target it is
    // being drawn into: a feedback loop invalidates the draw calls)
    REFLECTION_UNIFORMS.uReflOn.value = 0;
    REFLECTION_UNIFORMS.uReflTex.value = null;
    gl.render(scene, mirror);
    REFLECTION_UNIFORMS.uReflOn.value = 1;
    REFLECTION_UNIFORMS.uReflTex.value = target.texture;
    gl.setRenderTarget(prevTarget);
    gl.clippingPlanes = prevClip;
    gl.autoClear = prevAutoClear;
    scene.background = prevBg;
  }, 0.5);

  return null;
};

