import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, type FC } from 'react';
import {
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector2,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { EMERALD_BAY_ORIGIN, TAHOE } from '../geo/locations';
import { ecefToGeodetic, enuToEcefMatrix, geodeticToEcef } from '../geo/wgs84';
import { FLAGS } from '../config';
import { patchSceneClip } from '../world/clip';
import { SCENE_LIGHT } from '../world/light';
import { WATER_ASSET_UNIFORMS } from '../world/waterAssets';
import { WATER_COMMON_GLSL } from '../world/waterCommon';
import { WATER_UNIFORMS } from './water';

/**
 * A real water surface for low views (a drone, or the map controls near the lake).
 *
 * Lake Tahoe is so clear that Google's photogrammetry reconstructed the sandy bottom of the
 * shallows, draped with low-resolution water imagery, instead of a flat surface. From a drone
 * a few metres up that reads as lumpy, blocky "water" with sand pyramids poking through. This
 * mesh is a flat (curvature-following) water surface at lake level around the camera: the
 * lake bottom disappears under it and the shoreline is wherever the terrain rises out of it.
 *
 * It renders like the tiles (unlit albedo, then the AerialPerspective pass lights and hazes
 * it), using the same deep-water / sky-reflection colours as the recoloured tile water, plus
 * Fresnel and slow procedural ripples computed in local coordinates (ECEF in float32 is only
 * good to ~0.5 m). Hidden above SHOW_BELOW (the 520 m hero view never sees it).
 */

/** water surface, ellipsoidal (see WATER_UNIFORMS.uWaterLevel) */
export const WATER_SURFACE_HEIGHT = TAHOE.lakeEllipsoidHeight + WATER_UNIFORMS.uWaterLevel.value;
/** half-size of the water patch, m */
const HALF = 4000;
const SEGMENTS = 160;
/** re-centre the patch on this grid (m) so the ripple anchor stays exact */
const SNAP = 100;
/** camera height above the water below which the surface is shown, m */
const SHOW_BELOW = 450;
const EARTH_R = 6_371_000;

const LAKE_BOX = { east: 11_500, south: -17_700, north: 19_500 };
const BAY_CENTER = { lat: 38.9585, lon: -120.0925 };

/** Ellipsoidal height of the water surface at lat/lon, or null outside Lake Tahoe. */
export function waterSurfaceAt(lat: number, lon: number): number | null {
  return insideLake(geodeticToEcef(lat, lon, WATER_SURFACE_HEIGHT, _p)) ? WATER_SURFACE_HEIGHT : null;
}

const _p = new Vector3();
const _d = new Vector3();
function insideLake(ecef: Vector3): boolean {
  _d.copy(ecef).sub(WATER_UNIFORMS.uLakeCenter.value);
  const e = _d.dot(WATER_UNIFORMS.uLakeEast.value);
  const n = _d.dot(WATER_UNIFORMS.uLakeNorth.value);
  if (Math.abs(e) > LAKE_BOX.east || n < LAKE_BOX.south || n > LAKE_BOX.north) return false;
  // Cascade Lake sits 68 m higher, 1 km south of Emerald Bay
  return ecef.distanceTo(WATER_UNIFORMS.uCascade.value) > 750;
}

const VERTEX_DECL = /* glsl */ `
varying vec3 vWaterLocal;
`;
const VERTEX_BODY = /* glsl */ `
vWaterLocal = transformed;
`;
const FRAGMENT_DECL = /* glsl */ `
varying vec3 vWaterLocal;
uniform vec3 uWaterCam;
uniform vec2 uWaterAnchor;
uniform vec3 uWaterBody;
uniform vec3 uReflect;
uniform float uFlyTime;
uniform vec3 uSunDir;
uniform float uFlatSunInv;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uWaterOn;
${WATER_COMMON_GLSL}
`;
const FRAGMENT_BODY = /* glsl */ `
{
  vec3 toCam = uWaterCam - vWaterLocal;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-3);
  vec3 N = normalize(vec3(vWaterLocal.xy / ${EARTH_R.toFixed(1)}, 1.0));
  float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(V, N), 0.0, 1.0), 5.0);
  // slow swells, wavelengths ~1-4 m, faded where a pixel spans too much water to resolve them
  vec2 rp = vWaterLocal.xy + uWaterAnchor;
  // (and with distance: further out the regular pattern of a few sines reads as a texture)
  float res = (1.0 - smoothstep(0.12, 0.45, length(fwidth(rp)))) * (1.0 - smoothstep(35.0, 240.0, dist));
  float ripple = res * (
      sin(dot(rp, vec2(0.83, 0.55)) * 1.70 + uFlyTime * 1.30)
    + sin(dot(rp, vec2(-0.41, 0.91)) * 2.90 - uFlyTime * 1.70)
    + 0.6 * sin(dot(rp, vec2(0.97, -0.24)) * 5.30 + uFlyTime * 2.30)
    + 0.4 * sin(dot(rp, vec2(-0.66, -0.75)) * 8.10 - uFlyTime * 2.90)) / 3.0;
  // larger, slower wind patches so open water is not perfectly uniform
  float gust = 0.5 + 0.5 * sin(dot(rp, vec2(0.012, 0.007)) + uFlyTime * 0.05) * sin(dot(rp, vec2(-0.005, 0.011)) - uFlyTime * 0.04);
  float Fr = clamp(F * (1.0 + 0.45 * ripple + 0.25 * (gust - 0.5)) + 0.015 * ripple, 0.0, 1.0);
  diffuseColor.rgb = mix(uWaterBody, uReflect, Fr);
  // once the lake textures and the sky probe are in: the custom lake's wave / light model
  // (world/waterShading.ts), so the water matches across the edge of the lidar scene
  if (uWaterOn > 0.5 && uSkyOn > 0.5) {
    vec2 wp = vWaterLocal.xy + uWaterAnchor;
    float alpha2;
    vec2 s = flyWaveSlope(wp, dFdx(wp), dFdy(wp), uFlyTime, 1.0, alpha2);
    vec3 Nw = flyMaskedNormal(normalize(vec3(-s, 0.0) + N), V, alpha2);
    float nv = dot(Nw, V);
    if (nv < 0.03) { Nw = normalize(Nw + (0.03 - nv) * V); nv = dot(Nw, V); }
    nv = clamp(nv, 0.03, 1.0);
    float Fw = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    vec3 under = FLY_BODY_LAKE * (uSunDir.z * uSunColor + uAmbient) * (1.0 - Fw);
    vec3 spec = vec3(flySunSpec(Nw, V, uSunDir, alpha2));
    vec3 sky = flySkyReflection(reflect(-V, Nw), alpha2, uReflect);
    diffuseColor.rgb = (under + spec) * uFlatSunInv + sky * Fw;
  }
}
`;

const _frame = new Matrix4();
const _inv = new Matrix4();
const _anchorFrame = enuToEcefMatrix(EMERALD_BAY_ORIGIN.lat, EMERALD_BAY_ORIGIN.lon, WATER_SURFACE_HEIGHT);
const _anchorInv = _anchorFrame.clone().invert();
const _cam = new Vector3();
const _local = new Vector3();
const _geo = { lat: 0, lon: 0, height: 0 };
const _bay = geodeticToEcef(BAY_CENTER.lat, BAY_CENTER.lon, WATER_SURFACE_HEIGHT);
const _deep = new Vector3();

export const WaterSurface: FC = () => {
  const uniforms = useMemo(
    () => ({
      uWaterCam: { value: new Vector3() },
      uWaterAnchor: { value: new Vector2() },
      uWaterBody: { value: new Vector3() },
      uReflect: WATER_UNIFORMS.uReflect,
      uFlyTime: WATER_UNIFORMS.uFlyTime,
      ...SCENE_LIGHT,
      ...WATER_ASSET_UNIFORMS,
    }),
    [],
  );

  const mesh = useMemo(() => {
    const geometry = new PlaneGeometry(HALF * 2, HALF * 2, SEGMENTS, SEGMENTS);
    // follow the Earth's curvature (1.25 m drop at 4 km)
    const pos = geometry.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      pos.setZ(i, -(x * x + y * y) / (2 * EARTH_R));
    }
    geometry.computeBoundingSphere();
    const material = new MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAGMENT_BODY}`);
    };
    if (FLAGS.scene) patchSceneClip(material);
    const m = new Mesh(geometry, material);
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    m.visible = false;
    m.raycast = () => {};
    m.name = 'flytake-water-surface';
    return m;
  }, [uniforms]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    },
    [mesh],
  );

  const state = useMemo(() => ({ e: Number.NaN, n: Number.NaN }), []);

  useFrame(({ camera }) => {
    ecefToGeodetic(camera.position, _geo);
    const above = _geo.height - WATER_SURFACE_HEIGHT;
    const show = above < SHOW_BELOW && above > -50 && insideLake(camera.position);
    mesh.visible = show;
    if (!show) return;

    // Snap the patch centre (in the fixed anchor frame) so it only moves in SNAP steps.
    _local.copy(camera.position).applyMatrix4(_anchorInv);
    const e = Math.round(_local.x / SNAP) * SNAP;
    const n = Math.round(_local.y / SNAP) * SNAP;
    if (e !== state.e || n !== state.n) {
      state.e = e;
      state.n = n;
      const centre = _cam.set(e, n, 0).applyMatrix4(_anchorFrame);
      ecefToGeodetic(centre, _geo);
      enuToEcefMatrix(_geo.lat, _geo.lon, WATER_SURFACE_HEIGHT, _frame);
      mesh.matrix.copy(_frame);
      mesh.matrixWorld.copy(_frame);
      _inv.copy(_frame).invert();
      uniforms.uWaterAnchor.value.set(e, n);
      // emerald tint inside the bay, like the recoloured tile water
      const k = 1 - smoothstep(900, 1800, centre.distanceTo(_bay));
      _deep.copy(WATER_UNIFORMS.uDeep.value).lerp(WATER_UNIFORMS.uDeepBay.value, k);
      uniforms.uWaterBody.value.copy(_deep);
    }
    uniforms.uWaterCam.value.copy(camera.position).applyMatrix4(_inv);
  }, -1);

  return <primitive object={mesh} />;
};

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
