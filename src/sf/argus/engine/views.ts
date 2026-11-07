/**
 * Secondary views (e.g. drone picture-in-picture feeds): render the scene from any camera into a
 * caller-owned render target, display-ready (exposure + AgX tone mapping + sRGB), sharing the
 * main view's sky, lights, fog and shadow map. The main post chain (AO, bloom, SMAA) is skipped
 * to keep extra feeds cheap.
 */
import * as THREE from 'three';

const FRAG = /* glsl */ `
#include <tonemapping_pars_fragment>
uniform sampler2D tHDR;
varying vec2 vUv;
void main() {
	vec3 c = AgXToneMapping( texture2D( tHDR, vUv ).rgb );
	gl_FragColor = vec4( sRGBTransferOETF( vec4( c, 1.0 ) ).rgb, 1.0 );
}
`;

export class ViewRenderer {
  private readonly hdr = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: true });
  private readonly quad: THREE.Mesh;
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: THREE.ShaderMaterial;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
  ) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tHDR: { value: null } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
  }

  render(camera: THREE.Camera, target: THREE.WebGLRenderTarget | null): void {
    const r = this.renderer;
    const w = target ? target.width : r.domElement.width;
    const h = target ? target.height : r.domElement.height;
    if (this.hdr.width !== w || this.hdr.height !== h) this.hdr.setSize(w, h);
    const prev = r.getRenderTarget();
    const shadowAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false; // reuse the main view's shadow map
    r.setRenderTarget(this.hdr);
    r.clear();
    r.render(this.scene, camera);
    this.mat.uniforms.tHDR.value = this.hdr.texture;
    r.setRenderTarget(target);
    r.render(this.quad, this.cam);
    r.setRenderTarget(prev);
    r.shadowMap.autoUpdate = shadowAuto;
  }

  dispose(): void {
    this.hdr.dispose();
    this.mat.dispose();
    this.quad.geometry.dispose();
  }
}
