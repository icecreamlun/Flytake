/**
 * Per-building GPU data textures (all RGBA32F, TEX_W texels per row):
 *   state   — 3 texels / building, layout exactly as documented in contracts.ts
 *   style   — STYLE_TEXELS texels / building (static, from styles.ts)
 *   overlay — 1 texel / building: rgb tint, a = (2 when the tint is set) + veil (0..1, scan veil)
 */
import * as THREE from 'three';
import type { BuildingDynamicState } from '../../contracts';
import { TEX_W } from './glsl/common';
import { STYLE_TEXELS } from './styles';

function makeTexture(texels: number): { data: Float32Array; tex: THREE.DataTexture } {
  const rows = Math.max(1, Math.ceil(texels / TEX_W));
  const data = new Float32Array(TEX_W * rows * 4);
  const tex = new THREE.DataTexture(data, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { data, tex };
}

export class BuildingStateStore {
  readonly stateData: Float32Array;
  readonly stateTex: THREE.DataTexture;
  readonly styleTex: THREE.DataTexture;
  readonly overlayData: Float32Array;
  readonly overlayTex: THREE.DataTexture;
  private dirty = false;
  private overlayDirty = false;
  /** Scan veil per building (0..1), packed into the overlay alpha next to the tint flag. */
  private readonly veil: Float32Array;

  constructor(readonly count: number, pivots: Float32Array, styleData: Float32Array) {
    const st = makeTexture(count * 3);
    this.stateData = st.data;
    this.stateTex = st.tex;
    for (let i = 0; i < count; i++) this.stateData.set(pivots.subarray(i * 4, i * 4 + 4), (i * 3 + 2) * 4);
    const sy = makeTexture(count * STYLE_TEXELS);
    sy.data.set(styleData);
    this.styleTex = sy.tex;
    const ov = makeTexture(count);
    this.overlayData = ov.data;
    this.overlayTex = ov.tex;
    this.veil = new Float32Array(count);
  }

  set(i: number, s: BuildingDynamicState): void {
    if (i < 0 || i >= this.count) return;
    const d = this.stateData;
    const a = i * 12;
    if (s.shakeX !== undefined) d[a] = s.shakeX;
    if (s.shakeZ !== undefined) d[a + 1] = s.shakeZ;
    if (s.tiltX !== undefined) d[a + 2] = s.tiltX;
    if (s.tiltZ !== undefined) d[a + 3] = s.tiltZ;
    if (s.crush !== undefined) d[a + 4] = s.crush;
    if (s.damage !== undefined) d[a + 5] = s.damage;
    if (s.lightsOut !== undefined) d[a + 6] = s.lightsOut;
    if (s.hidden !== undefined) d[a + 7] = s.hidden;
    this.dirty = true;
  }

  get(i: number): Required<BuildingDynamicState> {
    const d = this.stateData;
    const a = i * 12;
    return { shakeX: d[a], shakeZ: d[a + 1], tiltX: d[a + 2], tiltZ: d[a + 3], crush: d[a + 4], damage: d[a + 5], lightsOut: d[a + 6], hidden: d[a + 7] };
  }

  /**
   * Clears all dynamic state. `keepHidden[i]` marks buildings whose hidden flag survives a reset
   * (footprints replaced by hand-built landmark models).
   */
  resetAll(keepHidden?: Uint8Array): void {
    const d = this.stateData;
    for (let i = 0; i < this.count; i++) {
      const a = i * 12;
      const hidden = keepHidden?.[i] ? d[a + 7] : 0;
      d.fill(0, a, a + 8);
      d[a + 7] = hidden;
    }
    this.dirty = true;
  }

  isHidden(i: number): boolean {
    return this.stateData[i * 12 + 7] > 0.5;
  }
  crush(i: number): number {
    return this.stateData[i * 12 + 4];
  }

  setOverlay(i: number, rgb: [number, number, number] | null): void {
    if (i < 0 || i >= this.count) return;
    const o = i * 4;
    if (rgb) {
      this.overlayData[o] = rgb[0];
      this.overlayData[o + 1] = rgb[1];
      this.overlayData[o + 2] = rgb[2];
      this.overlayData[o + 3] = 2 + this.veil[i];
    } else this.overlayData[o + 3] = this.veil[i];
    this.overlayDirty = true;
  }

  /** Scan veil (0..1): slight desaturate + darken in the shaders. */
  setVeil(i: number, amount: number): void {
    if (i < 0 || i >= this.count) return;
    const v = Math.min(1, Math.max(0, amount));
    if (v === this.veil[i]) return;
    this.veil[i] = v;
    const o = i * 4 + 3;
    this.overlayData[o] = (this.overlayData[o] >= 1.5 ? 2 : 0) + v;
    this.overlayDirty = true;
  }

  commit(): void {
    if (this.dirty) {
      this.stateTex.needsUpdate = true;
      this.dirty = false;
    }
    if (this.overlayDirty) {
      this.overlayTex.needsUpdate = true;
      this.overlayDirty = false;
    }
  }
}
