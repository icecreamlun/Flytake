import { Texture, Vector3, Vector4 } from 'three';

/**
 * Live sun shadows of the Emerald Bay scene: the GLSL interface shared by the terrain, water
 * and forest shaders. The GPU passes that fill these textures live in shadowField.ts.
 *
 * Heights ("hgt") are in the raster convention of tools/scene: WGS84 ellipsoidal height minus
 * the origin height (H0 = EMERALD_BAY_ORIGIN.height). A point in scene ENU (x east, y north,
 * z up, tangent plane at the origin) has hgt = z + (x^2 + y^2) / (2 R) (Earth curvature).
 *
 * Shadow height S(x, y): the height above which a point in that column sees the sun past the
 * terrain + forest canopy upstream (S = max over t > 0 of H(p + t d) - t tan(el), H being the
 * ground + canopy surface). A point is lit where hgt > S.
 *  - far field: the whole scene at 4 m
 *  - near field: a 1 km window around the camera at 0.5 m (sharp tree shadows), which also
 *    folds in the far field beyond 250 m
 * Until the first computation finished uShOn = 0 and flySunVis() returns 1.
 */
export const SHADOW_UNIFORMS = {
  /** ground height (hgt), whole scene, 2 m, R32F */
  uDtm: { value: null as Texture | null },
  /** (e0, n0, 1 / width_m, 1 / height_m) of the texture's outer edges */
  uDtmBox: { value: new Vector4(-4000, -3500, 1 / 8000, 1 / 7700) },
  uShFar: { value: null as Texture | null },
  uShFarBox: { value: new Vector4(-4000, -3500, 1 / 8000, 1 / 7700) },
  uShNear: { value: null as Texture | null },
  uShNearBox: { value: new Vector4(0, 0, 1 / 1024, 1 / 1024) },
  /** 1 once the shadow field is valid for the current sun */
  uShOn: { value: 0 },
  /** 1 once the ground height texture is loaded */
  uDtmOn: { value: 0 },
  /** (horizontal unit vector toward the sun: x, y; tan(elevation)) */
  uShSun: { value: new Vector3(0, 1, 1) },
};

export const SHADOW_GLSL = /* glsl */ `
uniform sampler2D uDtm;
uniform vec4 uDtmBox;
uniform sampler2D uShFar;
uniform vec4 uShFarBox;
uniform sampler2D uShNear;
uniform vec4 uShNearBox;
uniform float uShOn;
uniform float uDtmOn;
uniform vec3 uShSun;

/** raster height (ellipsoidal - H0) of a scene-ENU point */
float flyHgt(vec3 pEnu) { return pEnu.z + dot(pEnu.xy, pEnu.xy) * ${(1 / 12_742_000).toExponential(8)}; }
vec2 flyBoxUv(vec2 p, vec4 box) { return (p - box.xy) * box.zw; }

/** ground height (hgt) at a scene xy, bilinear on the 2 m DTM */
float flyGroundHgt(vec2 p) { return texture(uDtm, flyBoxUv(p, uDtmBox)).r; }

/** ground normal (scene ENU) from the 2 m DTM; (0, 0, 1) until it is loaded */
vec3 flyGroundNormal(vec2 p) {
  if (uDtmOn < 0.5) return vec3(0.0, 0.0, 1.0);
  const float e = 2.0;
  float hx = flyGroundHgt(p + vec2(e, 0.0)) - flyGroundHgt(p - vec2(e, 0.0));
  float hy = flyGroundHgt(p + vec2(0.0, e)) - flyGroundHgt(p - vec2(0.0, e));
  return normalize(vec3(-hx, -hy, 2.0 * e));
}

/** shadow height (hgt) at a scene xy: near field where it covers p, far field elsewhere */
float flyShadowHgt(vec2 p) {
  float far = texture(uShFar, flyBoxUv(p, uShFarBox)).r;
  vec2 nuv = flyBoxUv(p, uShNearBox);
  vec2 edge = min(nuv, 1.0 - nuv);
  float wNear = smoothstep(0.0, 0.06, min(edge.x, edge.y));
  if (wNear <= 0.0) return far;
  float near = texture(uShNear, nuv).r;
  return mix(far, near, wNear);
}

/** 0..1 direct-sun visibility of a point at scene-xy p with raster height hgt */
float flySunVisAt(vec2 p, float hgt, float soft) {
  if (uShOn < 0.5) return 1.0;
  return clamp((hgt - flyShadowHgt(p)) / soft + 0.5, 0.0, 1.0);
}

/** 0..1 direct-sun visibility of a scene-ENU point (soft = penumbra width in metres) */
float flySunVis(vec3 pEnu, float soft) { return flySunVisAt(pEnu.xy, flyHgt(pEnu), soft); }

/**
 * Visibility of a point inside a tree crown that must not be shadowed by its own crown: the
 * shadow field is sampled \`offset\` metres toward the sun (outside the crown), where the sun
 * ray through the point is offset * tan(el) higher.
 */
float flySunVisOffset(vec3 pEnu, float offset, float soft) {
  vec2 q = pEnu.xy + uShSun.xy * offset;
  return flySunVisAt(q, flyHgt(pEnu) + offset * uShSun.z, soft);
}
`;
