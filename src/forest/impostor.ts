import {
  Color,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OrthographicCamera,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { ConiferVariant } from './conifer';
import { createBakeMaterial, type ImpostorLayout } from './materials';

export interface ImpostorAtlas {
  albedo: Texture;
  normal: Texture;
  layout: ImpostorLayout;
  size: Vector2;
  dispose(): void;
}

export const DEFAULT_LAYOUT: ImpostorLayout = { frames: 8, framePx: 128, gutter: 3, slotCols: 4, slotRows: 3 };

function hemiOctDecode(ex: number, ey: number, out: Vector3): Vector3 {
  const tx = (ex + ey) * 0.5;
  const ty = (ex - ey) * 0.5;
  return out.set(tx, ty, Math.max(1 - Math.abs(tx) - Math.abs(ty), 0)).normalize();
}

/**
 * Renders every variant's LOD0 from frames x frames hemi-octahedral directions into two
 * atlases: albedo (sRGB-encoded, coverage in alpha) and (oct normal, depth, ao|foliage).
 * Both get mipmaps. Must match IMPOSTOR_VERT's frame / quad construction.
 */
export function bakeImpostors(
  gl: WebGLRenderer,
  variants: ConiferVariant[],
  foliageMap: Texture,
  bark: Texture,
  layout: ImpostorLayout = DEFAULT_LAYOUT,
): ImpostorAtlas {
  const { frames: N, framePx, gutter, slotCols, slotRows } = layout;
  const size = new Vector2(slotCols * N * framePx, slotRows * N * framePx);
  const make = (): WebGLRenderTarget => {
    const rt = new WebGLRenderTarget(size.x, size.y, { depthBuffer: true, stencilBuffer: false });
    rt.texture.generateMipmaps = false;
    rt.texture.minFilter = LinearMipmapLinearFilter;
    rt.texture.magFilter = LinearFilter;
    rt.texture.anisotropy = 4;
    return rt;
  };
  const albedoRT = make();
  const normalRT = make();

  const scene = new Scene();
  const barkMat = createBakeMaterial(foliageMap, bark, false);
  const foliageMat = createBakeMaterial(foliageMap, bark, true);
  const barkMesh = new Mesh(undefined, barkMat);
  const foliageMesh = new Mesh(undefined, foliageMat);
  barkMesh.frustumCulled = false;
  foliageMesh.frustumCulled = false;
  scene.add(barkMesh, foliageMesh);
  const cam = new OrthographicCamera();
  cam.up.set(0, 0, 1);

  const prevTarget = gl.getRenderTarget();
  const prevAutoClear = gl.autoClear;
  const prevClear = new Color();
  gl.getClearColor(prevClear);
  const prevAlpha = gl.getClearAlpha();
  gl.autoClear = false;

  const fd = new Vector3();
  const center = new Vector3();
  for (const [rt, mode] of [
    [albedoRT, 0],
    [normalRT, 1],
  ] as const) {
    gl.setRenderTarget(rt);
    if (mode === 0) gl.setClearColor(0x000000, 0);
    else gl.setClearColor(new Color(0.5, 0.5, 0.5), 0.85);
    gl.clear(true, true, false);
    barkMat.uniforms.uMode!.value = mode;
    foliageMat.uniforms.uMode!.value = mode;
    for (const v of variants) {
      barkMesh.geometry = v.lods[0].bark;
      foliageMesh.geometry = v.lods[0].foliage ?? v.lods[0].bark;
      foliageMesh.visible = v.lods[0].foliage != null;
      const H = v.height;
      const Rb = v.boundRadius;
      const depthRange = Math.sqrt(Rb * Rb + 0.25 * H * H);
      center.set(0, 0, H / 2);
      const sx = (v.id % slotCols) * N * framePx;
      const sy = Math.floor(v.id / slotCols) * N * framePx;
      barkMat.uniforms.uDesat!.value = v.species === 3 ? 0.85 : 0;
      for (const m of [barkMat, foliageMat]) {
        m.uniforms.uCenter!.value.copy(center);
        m.uniforms.uDepthRange!.value = depthRange;
      }
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          hemiOctDecode(((i + 0.5) / N) * 2 - 1, ((j + 0.5) / N) * 2 - 1, fd);
          const sinT = fd.z;
          const cosT = Math.hypot(fd.x, fd.y);
          const hx = Rb * 1.04;
          const hy = 0.5 * (H * cosT + 2 * Rb * sinT) * 1.04;
          cam.left = -hx;
          cam.right = hx;
          cam.top = hy;
          cam.bottom = -hy;
          cam.near = 0.01;
          cam.far = 2 * (Rb + H) + 10;
          cam.position.copy(center).addScaledVector(fd, Rb + H + 4);
          cam.lookAt(center);
          cam.updateProjectionMatrix();
          cam.updateMatrixWorld(true);
          for (const m of [barkMat, foliageMat]) m.uniforms.uFrameDir!.value.copy(fd);
          rt.viewport.set(sx + i * framePx + gutter, sy + j * framePx + gutter, framePx - 2 * gutter, framePx - 2 * gutter);
          gl.setRenderTarget(rt);
          gl.render(scene, cam);
        }
      }
    }
    // build the mip chain once: an empty render with generateMipmaps on triggers it
    rt.texture.generateMipmaps = true;
    rt.viewport.set(0, 0, 1, 1);
    gl.setRenderTarget(rt);
    barkMesh.visible = false;
    foliageMesh.visible = false;
    gl.render(scene, cam);
    barkMesh.visible = true;
    foliageMesh.visible = true;
    rt.texture.generateMipmaps = false;
    rt.viewport.set(0, 0, size.x, size.y);
  }

  gl.setRenderTarget(prevTarget);
  gl.autoClear = prevAutoClear;
  gl.setClearColor(prevClear, prevAlpha);
  barkMat.dispose();
  foliageMat.dispose();

  return {
    albedo: albedoRT.texture,
    normal: normalRT.texture,
    layout,
    size,
    dispose() {
      albedoRT.dispose();
      normalRT.dispose();
    },
  };
}
