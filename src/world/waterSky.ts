import { SkyMaterial, type PrecomputedTextures } from '@takram/three-atmosphere';
import type { Ellipsoid } from '@takram/three-geospatial';
import {
  CubeCamera,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  Quaternion,
  Scene,
  Vector3,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
} from 'three';
import { SCENE_FRAME, SCENE_LAKE_LEVEL, fromSceneEnu } from './scene';

/**
 * Sky probe for the lake's reflection: takram's sky (no sun / moon disk: the water shader
 * adds the sun as a specular lobe) rendered into a small cube map at the lake surface, in the
 * scene ENU frame (sample it with ENU directions), whenever the sun moves.
 *
 * The shader is patched to store the sky luminance divided by the sun's normal illuminance at
 * the lake, times pi. The AerialPerspective pass multiplies every pixel by
 * albedoScale / pi * E_sun * flat, so a water pixel outputting
 *   probe(R) * F / albedoScale * uFlatSunInv
 * ends up at exactly F * L_sky(R): a physically matched sky reflection at any time of day.
 */
const SIZE = 64;

const PATCH_MAIN = /* glsl */ `
void main() {
  flySkyMain();
  vec3 flySkyIrr;
  vec3 flyEs = GetSunAndSkyIrradiance(vCameraPosition, sunDirection, sunDirection, flySkyIrr);
  outputColor.rgb *= 3.14159265 / max(flyEs, vec3(1e-6));
}
`;

export class WaterSkyProbe {
  readonly target: WebGLCubeRenderTarget;
  private readonly camera: CubeCamera;
  private readonly scene = new Scene();
  private readonly material: SkyMaterial;
  private readonly mesh: Mesh;

  constructor(textures: PrecomputedTextures, ellipsoid?: Ellipsoid, correctAltitude?: boolean) {
    this.target = new WebGLCubeRenderTarget(SIZE, {
      type: HalfFloatType,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.material = new SkyMaterial({ sun: false, moon: false });
    Object.assign(this.material, textures);
    if (ellipsoid) this.material.ellipsoid = ellipsoid;
    if (correctAltitude != null) this.material.correctAltitude = correctAltitude;
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.fragmentShader = this.material.fragmentShader.replace('void main() {', 'void flySkyMain() {') + PATCH_MAIN;
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.camera = new CubeCamera(1, 1000, this.target);
    // cube axes = scene ENU axes, at the lake surface in the bay
    fromSceneEnu(new Vector3(0, 0, SCENE_LAKE_LEVEL + 2), this.camera.position);
    const q = new Quaternion().setFromRotationMatrix(SCENE_FRAME);
    this.camera.quaternion.copy(q);
  }

  /** Re-render for a new sun (ECEF unit vector toward the sun). */
  update(renderer: WebGLRenderer, sunEcef: Vector3): void {
    this.material.sunDirection.copy(sunEcef);
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    this.camera.update(renderer, this.scene);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
