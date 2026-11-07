/**
 * Per-landmark dynamic state for the landmark shaders (overlays + earthquake damage), mirroring what the
 * buildings module does for generic extrusions so data views stay consistent.
 *
 * One "slot" per landmark build, 2 RGBA float texels per slot in a 1-row DataTexture:
 *   texel 2s   : overlay rgb (linear), a = 1 when an overlay colour is set
 *   texel 2s+1 : damage 0..4, crush 0..1, seed 0..1, mapped (1 = tied to city.json buildings)
 * Slot 0 is reserved for geometry that is not tied to any building (all zeros → no overlay / damage).
 * Every landmark vertex carries `aLmSlot` (see materials.ts); the vertex shader fetches its slot once.
 */
import * as THREE from 'three';

export const MAX_SLOTS = 64;

export const lmStateUniforms = {
  uLmState: { value: null as THREE.DataTexture | null },
  /** 1 while the damage-state overlay is on (colour ramp by damage, like the buildings). */
  uLmDamageOverlay: { value: 0 },
};

export class LandmarkStateStore {
  readonly data = new Float32Array(MAX_SLOTS * 2 * 4);
  readonly tex: THREE.DataTexture;
  private n = 1;
  private dirty = true;

  constructor() {
    this.tex = new THREE.DataTexture(this.data, MAX_SLOTS * 2, 1, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    lmStateUniforms.uLmState.value = this.tex;
  }

  /** Allocate a slot (0 when full: the landmark then simply shows no overlay/damage). */
  alloc(seed: number): number {
    if (this.n >= MAX_SLOTS) return 0;
    const s = this.n++;
    const o = (s * 2 + 1) * 4;
    this.data[o + 2] = seed;
    this.data[o + 3] = 1;
    this.dirty = true;
    return s;
  }

  setOverlay(slot: number, rgb: [number, number, number] | null): void {
    if (slot <= 0) return;
    const o = slot * 2 * 4;
    if (rgb) {
      this.data[o] = rgb[0];
      this.data[o + 1] = rgb[1];
      this.data[o + 2] = rgb[2];
      this.data[o + 3] = 1;
    } else this.data[o + 3] = 0;
    this.dirty = true;
  }

  /** Returns true when the value changed. */
  setDamage(slot: number, damage: number, crush: number): boolean {
    if (slot <= 0) return false;
    const o = (slot * 2 + 1) * 4;
    if (Math.abs(this.data[o] - damage) < 1e-3 && Math.abs(this.data[o + 1] - crush) < 1e-3) return false;
    this.data[o] = damage;
    this.data[o + 1] = crush;
    this.dirty = true;
    return true;
  }

  damage(slot: number): number {
    return slot > 0 ? this.data[(slot * 2 + 1) * 4] : 0;
  }

  commit(): void {
    if (!this.dirty) return;
    this.tex.needsUpdate = true;
    this.dirty = false;
  }
}
