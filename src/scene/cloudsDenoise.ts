import {
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Texture,
  type WebGLRenderer,
} from 'three';

/**
 * Temporal + spatial denoise of the three-clouds output (the overlay AerialPerspective
 * composites).
 *
 * three-clouds' temporal upscaling renders 1/16 of the texels per frame and upsamples them
 * without accumulating, so every pixel keeps the noise of its single stochastic ray march:
 * at our exposure the clouds looked grainy ("salt" noise). Turning the upscaling off fixes it
 * but costs ~33 ms on an M4 Max (vs ~5 ms). Instead, after the clouds resolve:
 *  - a 3x3 tent filter (clouds are soft, ~1 px of blur is invisible),
 *  - an exponential history with variance clipping, reprojected by camera ROTATION only (the
 *    clouds are kilometres away; a drone's translation is negligible parallax).
 * The overlay is premultiplied (AerialPerspective: rgb * (1 - a) + overlay.rgb), so filtering
 * rgba together is correct at silhouettes.
 */
const VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform vec2 uTexel;
uniform mat4 uInvProj;
uniform mat3 uRot;
uniform mat4 uPrevProj;
uniform float uAlpha;
uniform float uGamma;
uniform float uHasHistory;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
  vec4 sum = vec4(0.0);
  vec4 m1 = vec4(0.0);
  vec4 m2 = vec4(0.0);
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec4 c = texture(tCurrent, vUv + vec2(float(x), float(y)) * uTexel);
      float w = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);
      sum += c * w;
      m1 += c;
      m2 += c * c;
    }
  }
  vec4 cur = sum / 16.0;
  if (uHasHistory < 0.5) {
    outColor = cur;
    return;
  }
  m1 /= 9.0;
  m2 /= 9.0;
  vec4 sigma = sqrt(max(m2 - m1 * m1, 0.0));

  // reproject the view direction into the previous frame (rotation only)
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = v.xyz / v.w;
  vec4 pc = uPrevProj * vec4(uRot * d, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  if (pc.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) {
    outColor = cur;
    return;
  }
  vec4 hist = texture(tHistory, puv);
  hist = clamp(hist, m1 - uGamma * sigma, m1 + uGamma * sigma);
  outColor = mix(hist, cur, uAlpha);
}
`;

const makeTarget = (): WebGLRenderTarget =>
  new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });

export class CloudsDenoise {
  private readonly targets: [WebGLRenderTarget, WebGLRenderTarget] = [makeTarget(), makeTarget()];
  private index = 0;
  private hasHistory = false;
  private readonly material = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      tCurrent: { value: null },
      tHistory: { value: null },
      uTexel: { value: new Vector2() },
      uInvProj: { value: new Matrix4() },
      uRot: { value: new Matrix3() },
      uPrevProj: { value: new Matrix4() },
      uAlpha: { value: 0.12 },
      uGamma: { value: 1.25 },
      uHasHistory: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  });
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly prevViewRot = new Matrix4();
  private readonly prevProj = new Matrix4();
  private readonly curViewRot = new Matrix4();
  private readonly rot4 = new Matrix4();

  constructor() {
    const quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Forget the history (hard camera cuts). */
  reset(): void {
    this.hasHistory = false;
  }

  render(renderer: WebGLRenderer, current: Texture, camera: Camera): Texture {
    const image = current.image as { width: number; height: number };
    const { width, height } = image;
    const read = this.targets[this.index]!;
    const write = this.targets[1 - this.index]!;
    if (write.width !== width || write.height !== height) {
      this.targets[0].setSize(width, height);
      this.targets[1].setSize(width, height);
      this.hasHistory = false;
    }

    // rotation-only view matrices
    this.curViewRot.extractRotation(camera.matrixWorldInverse);
    // uRot = prevViewRot * curViewRot^-1 (view space now -> view space then)
    this.rot4.copy(this.curViewRot).transpose().premultiply(this.prevViewRot);

    const u = this.material.uniforms;
    u.tCurrent!.value = current;
    u.tHistory!.value = read.texture;
    (u.uTexel!.value as Vector2).set(1 / width, 1 / height);
    (u.uInvProj!.value as Matrix4).copy(camera.projectionMatrixInverse);
    (u.uRot!.value as Matrix3).setFromMatrix4(this.rot4);
    (u.uPrevProj!.value as Matrix4).copy(this.prevProj);
    u.uHasHistory!.value = this.hasHistory ? 1 : 0;

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(write);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previousTarget);

    this.index = 1 - this.index;
    this.hasHistory = true;
    this.prevViewRot.copy(this.curViewRot);
    this.prevProj.copy(camera.projectionMatrix);
    return write.texture;
  }

  dispose(): void {
    this.targets[0].dispose();
    this.targets[1].dispose();
    this.material.dispose();
  }
}
