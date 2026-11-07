/**
 * Image-based lighting: a PMREM environment generated from the sky dome (sun disc and stars
 * removed, clouds / moon / horizon glow kept). Regenerated on demand, throttled, so glass towers and
 * the bay always reflect the current sky.
 */
import * as THREE from 'three';
import type { SkyDome } from './skyDome';

export class SkyEnvironment {
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private readonly envDome: THREE.Mesh;
  private target: THREE.WebGLRenderTarget | null = null;
  private lastAt = -Infinity;
  private pending = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    dome: SkyDome,
    private readonly minIntervalMs = 250,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // A dedicated material clone shares every uniform object with the visible dome except uEnvPass.
    const src = dome.material;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...src.uniforms, uEnvPass: { value: 1 } },
      vertexShader: src.vertexShader,
      fragmentShader: src.fragmentShader,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.envDome = new THREE.Mesh(dome.mesh.geometry, mat);
    this.envDome.frustumCulled = false;
    this.envScene.add(this.envDome);
  }

  /** Ask for a regeneration; runs now if the throttle allows, otherwise at the next update(). */
  request(force = false): void {
    this.pending = true;
    if (force) this.lastAt = -Infinity;
    this.update();
  }

  /** Call once per frame. */
  update(): void {
    if (!this.pending) return;
    const now = performance.now();
    if (now - this.lastAt < this.minIntervalMs) return;
    this.lastAt = now;
    this.pending = false;
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 10, { size: 256 });
    this.scene.environment = rt.texture;
    this.target?.dispose();
    this.target = rt;
  }

  get texture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }
}
