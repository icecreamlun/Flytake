import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  RawShaderMaterial,
  RedFormat,
  Scene,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { SHADOW_UNIFORMS } from './shadowGlsl';
import { SUN } from './sun';

/**
 * GPU shadow field of the Emerald Bay scene (see shadowGlsl.ts for what the shaders read).
 *
 *  DSM  = ground (2 m DTM, public/scene/dtm.bin) + every lidar tree crown as a cone (apex at
 *         the tree top, base radius r at 35 % of the height), rendered top-down with a depth
 *         test so the highest surface wins. Static: the far DSM is drawn once, the near DSM
 *         whenever the near window moves.
 *  S    = shadow height: per texel, march toward the sun over the DSM (geometric steps,
 *         mip-filtered further out) and keep max(H - t tan(el)). Recomputed on every sun change
 *         (time of day) and, for the near field, when the window re-centres on the camera.
 *  far  : the whole scene at 4 m.
 *  near : 1024 m x 1024 m at 0.5 m around the camera (biased toward the view direction); it
 *         marches the first NEAR_REACH metres itself and folds in the far field beyond.
 */

const R2 = 12_742_000; // 2 x Earth radius (curvature: hgt = z + r^2 / 2R)
const H_MIN = -5;
const H_MAX = 1000;

const FAR_STEP = 4;
const NEAR_STEP = 0.5;
const NEAR_SIZE = 2048; // texels
const NEAR_EXTENT = NEAR_SIZE * NEAR_STEP; // m
const NEAR_REACH = 300; // m marched in the near field before folding in the far field
const NEAR_RECENTER = 160; // m of camera travel before the near window moves

interface Box {
  e0: number;
  n0: number;
  w: number;
  h: number;
}

// ------------------------------------------------------------------------------------------------
// shaders

const DEPTH_GLSL = /* glsl */ `
uniform vec2 uDepthRange;
float depthOf(float h) { return clamp(1.0 - (h - uDepthRange.x) / (uDepthRange.y - uDepthRange.x), 0.0, 1.0); }
`;

const QUAD_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const GROUND_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uDtm;
uniform vec4 uDtmBox; // e0, n0, w, h
uniform vec4 uBox;    // target e0, n0, w, h
${DEPTH_GLSL}
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 p = uBox.xy + vUv * uBox.zw;
  float h = texture(uDtm, (p - uDtmBox.xy) / uDtmBox.zw).r;
  fragColor = vec4(h, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(h);
}
`;

const CROWN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 iTree; // e, n, hgt of the stem base, tree height
in float iRadius;
uniform vec4 uBox;
uniform float uInflate;
out vec2 vLocal;
out float vR;
out float vTop;
out float vBase;
void main() {
  float R = iRadius + uInflate;
  vec2 p = iTree.xy + position.xy * R;
  vLocal = position.xy * R;
  vR = iRadius;
  vTop = iTree.z + iTree.w;
  vBase = iTree.z + 0.35 * iTree.w;
  gl_Position = vec4((p - uBox.xy) / uBox.zw * 2.0 - 1.0, 0.0, 1.0);
}
`;

const CROWN_FRAG = /* glsl */ `
precision highp float;
uniform float uInflate;
${DEPTH_GLSL}
in vec2 vLocal;
in float vR;
in float vTop;
in float vBase;
out vec4 fragColor;
void main() {
  float d = length(vLocal);
  if (d > vR + uInflate) discard;
  float k = clamp((d - uInflate) / max(vR, 0.1), 0.0, 1.0);
  float h = mix(vTop, vBase, k);
  fragColor = vec4(h, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(h);
}
`;

const PROP_VERT = /* glsl */ `
precision highp float;
in vec3 position; // ENU x, y and the top height (hgt)
uniform vec4 uBox;
out float vTop;
void main() {
  vTop = position.z;
  gl_Position = vec4((position.xy - uBox.xy) / uBox.zw * 2.0 - 1.0, 0.0, 1.0);
}
`;

const PROP_FRAG = /* glsl */ `
precision highp float;
${DEPTH_GLSL}
in float vTop;
out vec4 fragColor;
void main() {
  fragColor = vec4(vTop, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vTop);
}
`;

const MARCH_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uDsm;
uniform vec4 uBox;     // DSM == output box: e0, n0, w, h
uniform vec3 uSun;     // horizontal unit vector toward the sun (x, y), tan(elevation)
uniform float uStep0;  // first step (m) = texel size
uniform float uGrow;   // step growth per metre of distance
uniform float uMaxLod;
uniform float uReach;  // march at most this far (m), then fold in the far field
uniform float uHMax;
uniform float uHMin;
uniform sampler2D uFar;
uniform vec4 uFarBox;
uniform float uUseFar;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 p = uBox.xy + vUv * uBox.zw;
  float S = -1.0e4;
  float t = uStep0;
  float tEnd = t;
  for (int i = 0; i < 512; i++) {
    tEnd = t;
    if (t > uReach) break;
    // nothing further along can rise above what we have (or above any receiver)
    if (uHMax - t * uSun.z < max(S, uHMin)) { tEnd = 1.0e9; break; }
    vec2 uv = (p + uSun.xy * t - uBox.xy) / uBox.zw;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float step = max(uStep0, t * uGrow);
    float lod = clamp(log2(step / uStep0) - 0.5, 0.0, uMaxLod);
    S = max(S, textureLod(uDsm, uv, lod).r - t * uSun.z);
    t += step;
  }
  if (uUseFar > 0.5 && tEnd < 1.0e8) {
    vec2 uv = (p + uSun.xy * tEnd - uFarBox.xy) / uFarBox.zw;
    if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) S = max(S, texture(uFar, uv).r - tEnd * uSun.z);
  }
  fragColor = vec4(S, 0.0, 0.0, 1.0);
}
`;

// ------------------------------------------------------------------------------------------------

function floatTarget(w: number, h: number, depth: boolean, mips: boolean): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(w, h, {
    type: FloatType,
    format: RedFormat,
    depthBuffer: depth,
    stencilBuffer: false,
    minFilter: mips ? LinearMipmapLinearFilter : LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: mips,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
  });
  return rt;
}

function quadGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, 3, 0, -1, -1, 0, 3, -1, 0]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 2, 0, 0, 2, 0]), 2));
  return g;
}

async function loadDtm(url: string): Promise<{ texture: DataTexture; box: Box }> {
  const buf = await (await fetch(url)).arrayBuffer();
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'FDTM') throw new Error(`dtm.bin: bad magic ${magic}`);
  const w = view.getUint32(8, true);
  const h = view.getUint32(12, true);
  const e0 = view.getFloat32(16, true);
  const n0 = view.getFloat32(20, true);
  const step = view.getFloat32(24, true);
  const offset = view.getFloat32(28, true);
  const scale = view.getFloat32(32, true);
  const q = new Uint16Array(buf, 36, w * h);
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = offset + scale * q[i]!;
  const texture = new DataTexture(data, w, h, RedFormat, FloatType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, box: { e0, n0, w: w * step, h: h * step } };
}

/** Crown instances from trees.bin: (e, n, stem-base hgt, height) and radius; snags skipped. */
async function loadCrowns(url: string): Promise<{ tree: Float32Array; radius: Float32Array; count: number }> {
  const buf = await (await fetch(url)).arrayBuffer();
  const view = new DataView(buf);
  const count = view.getUint32(8, true);
  const stride = view.getUint32(12, true);
  const tree = new Float32Array(count * 4);
  const radius = new Float32Array(count);
  let k = 0;
  for (let i = 0; i < count; i++) {
    const o = 16 + i * stride;
    if (view.getUint8(o + 20) === 3) continue; // snag: no crown
    const e = view.getFloat32(o, true);
    const n = view.getFloat32(o + 4, true);
    const u = view.getFloat32(o + 8, true);
    tree[k * 4] = e;
    tree[k * 4 + 1] = n;
    tree[k * 4 + 2] = u + (e * e + n * n) / R2;
    tree[k * 4 + 3] = view.getFloat32(o + 12, true);
    radius[k] = view.getFloat32(o + 16, true);
    k++;
  }
  return { tree: tree.subarray(0, k * 4), radius: radius.subarray(0, k), count: k };
}

const _cam = new Vector3();
const _dir = new Vector3();

export class ShadowField {
  readonly renderer: WebGLRenderer;
  private dtm: { texture: DataTexture; box: Box } | null = null;
  private crowns: { tree: Float32Array; radius: Float32Array; count: number } | null = null;

  private readonly farBox: Box = { e0: -4000, n0: -3500, w: 8000, h: 7700 };
  private readonly farDsm: WebGLRenderTarget;
  private readonly farSh: WebGLRenderTarget;
  private readonly nearDsm: WebGLRenderTarget;
  private readonly nearSh: WebGLRenderTarget;
  private nearBox: Box | null = null;

  private readonly dsmScene = new Scene();
  private readonly marchScene = new Scene();
  private readonly camera = new Camera();
  private readonly groundMat: RawShaderMaterial;
  private readonly crownMat: RawShaderMaterial;
  private readonly marchMat: RawShaderMaterial;
  private crownMesh: Mesh | null = null;
  private readonly propMat: RawShaderMaterial;

  private farDsmReady = false;
  private lastMarch: 'far' | 'near' = 'near';
  private sunVersion = -1;
  private farSunVersion = -1;
  private nearSunVersion = -1;
  /** last timings (ms, CPU-side submit; GPU work is async) for debugging */
  readonly stats = { far: 0, near: 0, farCount: 0, nearCount: 0 };
  disposed = false;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    const fw = Math.round(this.farBox.w / FAR_STEP);
    const fh = Math.round(this.farBox.h / FAR_STEP);
    this.farDsm = floatTarget(fw, fh, true, true);
    this.farSh = floatTarget(fw, fh, false, false);
    this.nearDsm = floatTarget(NEAR_SIZE, NEAR_SIZE, true, true);
    this.nearSh = floatTarget(NEAR_SIZE, NEAR_SIZE, false, false);

    const depthRange = { value: new Vector2(H_MIN, H_MAX + 100) };
    this.groundMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: GROUND_FRAG,
      uniforms: {
        uDtm: { value: null },
        uDtmBox: { value: new Vector4() },
        uBox: { value: new Vector4() },
        uDepthRange: depthRange,
      },
      depthTest: true,
      depthWrite: true,
    });
    this.crownMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: CROWN_VERT,
      fragmentShader: CROWN_FRAG,
      uniforms: {
        uBox: this.groundMat.uniforms.uBox!,
        uInflate: { value: 0 },
        uDepthRange: depthRange,
      },
      depthTest: true,
      depthWrite: true,
    });
    this.propMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: PROP_VERT,
      fragmentShader: PROP_FRAG,
      uniforms: { uBox: this.groundMat.uniforms.uBox!, uDepthRange: depthRange },
      depthTest: true,
      depthWrite: true,
    });
    this.marchMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: MARCH_FRAG,
      uniforms: {
        uDsm: { value: null },
        uBox: { value: new Vector4() },
        uSun: { value: new Vector3() },
        uStep0: { value: 1 },
        uGrow: { value: 0.02 },
        uMaxLod: { value: 6 },
        uReach: { value: 1e9 },
        uHMax: { value: H_MAX },
        uHMin: { value: H_MIN },
        uFar: { value: null },
        uFarBox: { value: new Vector4() },
        uUseFar: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const ground = new Mesh(quadGeometry(), this.groundMat);
    ground.frustumCulled = false;
    ground.renderOrder = 0;
    this.dsmScene.add(ground);
    const march = new Mesh(quadGeometry(), this.marchMat);
    march.frustumCulled = false;
    this.marchScene.add(march);
  }

  async load(dtmUrl: string, treesUrl: string): Promise<void> {
    const [dtm, crowns] = await Promise.all([loadDtm(dtmUrl), loadCrowns(treesUrl)]);
    if (this.disposed) {
      dtm.texture.dispose();
      return;
    }
    this.dtm = dtm;
    this.crowns = crowns;
    SHADOW_UNIFORMS.uDtm.value = dtm.texture;
    SHADOW_UNIFORMS.uDtmBox.value.set(dtm.box.e0, dtm.box.n0, 1 / dtm.box.w, 1 / dtm.box.h);
    SHADOW_UNIFORMS.uDtmOn.value = 1;
    this.groundMat.uniforms.uDtm!.value = dtm.texture;
    this.groundMat.uniforms.uDtmBox!.value.set(dtm.box.e0, dtm.box.n0, dtm.box.w, dtm.box.h);

    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('iTree', new InstancedBufferAttribute(crowns.tree, 4));
    g.setAttribute('iRadius', new InstancedBufferAttribute(crowns.radius, 1));
    g.instanceCount = crowns.count;
    const mesh = new Mesh(g, this.crownMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.crownMesh = mesh;
    this.dsmScene.add(mesh);
  }

  /**
   * Adds a flat-topped prop footprint to the DSM (e.g. a building): a convex polygon in scene
   * ENU (x, y) with its roof / wall-top height in hgt. Both fields recompute.
   */
  addProp(polygon: [number, number][], topHgt: number): void {
    const pos: number[] = [];
    for (let i = 1; i + 1 < polygon.length; i++) {
      for (const k of [0, i, i + 1]) pos.push(polygon[k]![0], polygon[k]![1], topHgt);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    const mesh = new Mesh(g, this.propMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.dsmScene.add(mesh);
    this.farDsmReady = false;
    this.nearBox = null;
    this.sunVersion++;
  }

  get ready(): boolean {
    return this.dtm != null && this.crowns != null;
  }

  /** Bumps the sun version: both fields recompute on the next update(). */
  invalidateSun(): void {
    this.sunVersion++;
  }

  private renderDsm(target: WebGLRenderTarget, box: Box, texel: number): void {
    const gl = this.renderer;
    this.groundMat.uniforms.uBox!.value.set(box.e0, box.n0, box.w, box.h);
    // keep sub-texel crowns from falling between pixel centres
    this.crownMat.uniforms.uInflate!.value = texel * 0.71;
    gl.setRenderTarget(target);
    gl.setClearColor(0x000000, 0);
    gl.clear(true, true, false);
    gl.render(this.dsmScene, this.camera);
  }

  private march(dsm: WebGLRenderTarget, out: WebGLRenderTarget, box: Box, step: number, reach: number, useFar: boolean): void {
    const u = this.marchMat.uniforms;
    const sun = SUN.dirEnu;
    const horiz = Math.max(Math.hypot(sun.x, sun.y), 1e-4);
    u.uDsm!.value = dsm.texture;
    u.uBox!.value.set(box.e0, box.n0, box.w, box.h);
    u.uSun!.value.set(sun.x / horiz, sun.y / horiz, Math.max(sun.z, 0.02) / horiz);
    u.uStep0!.value = step;
    u.uGrow!.value = useFar ? 0.025 : 0.02;
    u.uMaxLod!.value = useFar ? 5 : 6;
    u.uReach!.value = reach;
    u.uFar!.value = useFar ? this.farSh.texture : null;
    u.uFarBox!.value.set(this.farBox.e0, this.farBox.n0, this.farBox.w, this.farBox.h);
    u.uUseFar!.value = useFar ? 1 : 0;
    const gl = this.renderer;
    gl.setRenderTarget(out);
    gl.render(this.marchScene, this.camera);
  }

  /** Ideal near-window centre: ahead of the camera along its horizontal view direction. */
  private nearCentre(camEnu: Vector3, viewEnu: Vector3, out: Vector2): Vector2 {
    const hl = Math.hypot(viewEnu.x, viewEnu.y);
    const ahead = hl > 1e-3 ? NEAR_EXTENT * 0.3 : 0;
    out.set(camEnu.x + (hl > 1e-3 ? (viewEnu.x / hl) * ahead : 0), camEnu.y + (hl > 1e-3 ? (viewEnu.y / hl) * ahead : 0));
    return out;
  }

  private readonly _centre = new Vector2();

  /**
   * Per frame: recompute what is stale. camEnu / viewEnu are the camera position and view
   * direction in scene ENU.
   */
  update(camEnu: Vector3, viewEnu: Vector3): void {
    if (!this.ready) return;
    const gl = this.renderer;
    const prevTarget = gl.getRenderTarget();
    const prevAutoClear = gl.autoClear;
    const prevClip = gl.clippingPlanes;
    gl.autoClear = false;
    gl.clippingPlanes = [];

    if (!this.farDsmReady) {
      this.renderDsm(this.farDsm, this.farBox, FAR_STEP);
      this.farDsmReady = true;
    }
    // at most one march per frame once both fields exist (while the time is being scrubbed the
    // far and the near field alternate, each at half the frame rate)
    const farStale = this.farSunVersion !== this.sunVersion;
    const nearStale = this.nearSunVersion !== this.sunVersion;
    const skipFar = farStale && nearStale && this.farSunVersion >= 0 && this.nearBox != null && this.lastMarch === 'far';
    let marched = false;
    if (farStale && !skipFar) {
      marched = true;
      this.lastMarch = 'far';
      const t0 = performance.now();
      this.march(this.farDsm, this.farSh, this.farBox, FAR_STEP, 1e9, false);
      this.stats.far = performance.now() - t0;
      this.stats.farCount++;
      this.farSunVersion = this.sunVersion;
      SHADOW_UNIFORMS.uShFar.value = this.farSh.texture;
      SHADOW_UNIFORMS.uShFarBox.value.set(this.farBox.e0, this.farBox.n0, 1 / this.farBox.w, 1 / this.farBox.h);
    }

    const c = this.nearCentre(camEnu, viewEnu, this._centre);
    // only worth a near field when the camera is low enough to see 0.5 m detail
    const height = camEnu.z;
    const wantNear = height < 1500;
    const moved = this.nearBox == null || Math.hypot(c.x - (this.nearBox.e0 + NEAR_EXTENT / 2), c.y - (this.nearBox.n0 + NEAR_EXTENT / 2)) > NEAR_RECENTER;
    if (wantNear && (moved || nearStale) && !(marched && !moved && this.nearSunVersion >= 0)) {
      this.lastMarch = 'near';
      const t0 = performance.now();
      if (moved || this.nearBox == null) {
        const e0 = Math.round((c.x - NEAR_EXTENT / 2) / NEAR_STEP) * NEAR_STEP;
        const n0 = Math.round((c.y - NEAR_EXTENT / 2) / NEAR_STEP) * NEAR_STEP;
        this.nearBox = { e0, n0, w: NEAR_EXTENT, h: NEAR_EXTENT };
        this.renderDsm(this.nearDsm, this.nearBox, NEAR_STEP);
      }
      this.march(this.nearDsm, this.nearSh, this.nearBox, NEAR_STEP, NEAR_REACH, true);
      this.stats.near = performance.now() - t0;
      this.stats.nearCount++;
      this.nearSunVersion = this.sunVersion;
      const b = this.nearBox;
      SHADOW_UNIFORMS.uShNear.value = this.nearSh.texture;
      SHADOW_UNIFORMS.uShNearBox.value.set(b.e0, b.n0, 1 / b.w, 1 / b.h);
    }
    if (!wantNear) {
      // park the near window far away: everything uses the far field
      SHADOW_UNIFORMS.uShNearBox.value.set(1e7, 1e7, 1 / NEAR_EXTENT, 1 / NEAR_EXTENT);
      this.nearBox = null;
    }

    const sun = SUN.dirEnu;
    const horiz = Math.max(Math.hypot(sun.x, sun.y), 1e-4);
    SHADOW_UNIFORMS.uShSun.value.set(sun.x / horiz, sun.y / horiz, Math.max(sun.z, 0.02) / horiz);
    SHADOW_UNIFORMS.uShOn.value = 1;

    gl.setRenderTarget(prevTarget);
    gl.autoClear = prevAutoClear;
    gl.clippingPlanes = prevClip;
  }

  dispose(): void {
    this.disposed = true;
    SHADOW_UNIFORMS.uShOn.value = 0;
    SHADOW_UNIFORMS.uDtmOn.value = 0;
    SHADOW_UNIFORMS.uDtm.value = null;
    SHADOW_UNIFORMS.uShFar.value = null;
    SHADOW_UNIFORMS.uShNear.value = null;
    this.dtm?.texture.dispose();
    this.farDsm.dispose();
    this.farSh.dispose();
    this.nearDsm.dispose();
    this.nearSh.dispose();
    this.groundMat.dispose();
    this.crownMat.dispose();
    this.marchMat.dispose();
    this.propMat.dispose();
    this.crownMesh?.geometry.dispose();
  }
}

/** camera position / view direction in scene ENU helpers for the component */
export function cameraEnu(camera: Camera, frameInv: import('three').Matrix4, pos: Vector3, dir: Vector3): void {
  pos.copy(camera.position).applyMatrix4(frameInv);
  camera.getWorldDirection(_dir);
  dir.copy(_dir).transformDirection(frameInv);
  _cam.copy(pos);
}
