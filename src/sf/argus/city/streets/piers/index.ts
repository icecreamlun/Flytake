/**
 * Piers over open water. Wide piers were flattened into the terrain by the data pipeline and come out of the
 * ground tiles as raised blocks with pier-lip / under-deck faces; this module adds the rest:
 *  - pier decks (flat at their recorded elevation) for piers that stand over water,
 *  - a concrete deck lip and a dark under-deck bay along every water-facing edge,
 *  - instanced creosoted pilings under the edges and timber fender piles on the outside.
 */
import * as THREE from 'three';
import { Earcut } from 'three/src/extras/Earcut.js';
import type { CityData } from '../../../contracts';
import type { GroundSurface } from '../core/surface';
import { LAND_ISO } from '../core/surface';
import { pointInRing, ringArea, ringBBox } from '../core/contour';
import { KIND_BLOCK, KIND_PIER, KIND_UNDERDECK } from '../ground/tiles';
import { CulledSet } from '../props/culled';
import { Kit } from '../props/kit';
import { createPropMaterial, type PropUniforms } from '../props/material';

export class Piers {
  readonly object = new THREE.Group();
  geometry: THREE.BufferGeometry | null = null;
  /** All pier rings (flat x,z), for the ground builder's pier-edge faces. */
  readonly rings: number[][] = [];

  constructor(
    private city: CityData,
    private surface: GroundSurface,
  ) {
    this.object.name = 'piers';
    for (const a of city.areas) if (a.kind === 'pier') this.rings.push(a.polygon.flat());
  }

  build(groundMaterial: THREE.Material, uniforms: PropUniforms): void {
    const S = this.surface;
    const pos: number[] = [];
    const nrm: number[] = [];
    const kind: number[] = [];
    const idx: number[] = [];
    const v = (x: number, y: number, z: number, nx: number, ny: number, nz: number, k: number) => {
      pos.push(x, y, z);
      nrm.push(nx, ny, nz);
      kind.push(k);
      return pos.length / 3 - 1;
    };
    const kit = new Kit();
    kit.cyl(0.28, 0.26, 1, 0, 0, 0, '#2b2620', { r: 0.9, seg: 8 });
    const pileGeo = kit.build();
    const piles = new CulledSet(pileGeo, createPropMaterial(uniforms, { instAttr: false }), 6000, { shadows: false, maxDist: 600, name: 'pilings' });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();

    for (const a of this.city.areas) {
      if (a.kind !== 'pier') continue;
      const ring = a.polygon.flat();
      const elev = a.elevation ?? 2.6;
      // How much of it stands over water?
      const [x0, z0, x1, z1] = ringBBox(ring);
      let n = 0;
      let wet = 0;
      for (let x = x0 + 1.5; x < x1; x += 3)
        for (let z = z0 + 1.5; z < z1; z += 3) {
          if (!pointInRing(ring, x, z)) continue;
          n++;
          if (S.hf.heightAt(x, z) < LAND_ISO) wet++;
        }
      if (!n || wet / n < 0.15) continue;
      // Deck top: earcut of the polygon at the deck elevation (nudged up where it would z-fight with land).
      const holes = (a.holes ?? []).map((h) => h.flat());
      const flat = ring.slice();
      const holeIdx: number[] = [];
      for (const h of holes) {
        holeIdx.push(flat.length / 2);
        flat.push(...h);
      }
      const tris = Earcut.triangulate(flat, holeIdx.length ? holeIdx : undefined, 2);
      const base = pos.length / 3;
      for (let i = 0; i < flat.length; i += 2) {
        const x = flat[i];
        const z = flat[i + 1];
        const land = S.top(x, z);
        const y = Math.abs(land - elev) < 0.04 ? elev + 0.05 : elev;
        v(x, y, z, 0, 1, 0, KIND_BLOCK);
      }
      for (let i = 0; i < tris.length; i += 3) {
        const A = tris[i];
        const B = tris[i + 1];
        const C = tris[i + 2];
        const cy = (flat[B * 2 + 1] - flat[A * 2 + 1]) * (flat[C * 2] - flat[A * 2]) - (flat[B * 2] - flat[A * 2]) * (flat[C * 2 + 1] - flat[A * 2 + 1]);
        if (cy > 0) idx.push(base + A, base + B, base + C);
        else idx.push(base + A, base + C, base + B);
      }
      // Edges over water: lip + under-deck bay, pilings and fenders.
      const orient = ringArea(ring) < 0 ? 1 : -1; // so that (ox, oz) points outward
      const rings = [ring, ...holes];
      for (let ri = 0; ri < rings.length; ri++) {
        const r = rings[ri];
        const sgn = ri === 0 ? orient : -orient;
        const nv = r.length / 2;
        for (let i = 0; i < nv; i++) {
          const j = (i + 1) % nv;
          const ax = r[i * 2];
          const az = r[i * 2 + 1];
          const bx = r[j * 2];
          const bz = r[j * 2 + 1];
          const L = Math.hypot(bx - ax, bz - az);
          if (L < 0.2) continue;
          const tx = (bx - ax) / L;
          const tz = (bz - az) / L;
          const ox = -tz * sgn;
          const oz = tx * sgn;
          const mx = (ax + bx) / 2 + ox * 1.5;
          const mz = (az + bz) / 2 + oz * 1.5;
          if (S.hf.heightAt(mx, mz) >= LAND_ISO) continue;
          for (const [top, bot, k] of [
            [elev, elev - 0.9, KIND_PIER],
            [elev - 0.9, -5, KIND_UNDERDECK],
          ] as const) {
            const a0 = v(ax, top, az, ox, 0.2, oz, k);
            const a1 = v(ax, bot, az, ox, 0, oz, k);
            const b1 = v(bx, bot, bz, ox, 0, oz, k);
            const b0 = v(bx, top, bz, ox, 0.2, oz, k);
            // Winding: (a0, a1, b1) normal = (a1-a0)×(b1-a0); x comp = (bot-top)*(bz-az), z comp = -(bot-top)*(bx-ax).
            const cx = (bot - top) * (bz - az);
            const cz = -(bot - top) * (bx - ax);
            if (cx * ox + cz * oz > 0) idx.push(a0, a1, b1, a0, b1, b0);
            else idx.push(a0, b1, a1, a0, b0, b1);
          }
          // Pilings (inset) and fender piles (outside) every ~3 m.
          for (let s = 1.5; s < L; s += 3) {
            const px = ax + tx * s;
            const pz = az + tz * s;
            const bottom = -4.5;
            const pileTop = elev - 0.85;
            m.compose(new THREE.Vector3(px - ox * 0.8, bottom, pz - oz * 0.8), q, new THREE.Vector3(1, pileTop - bottom, 1));
            piles.add(m, 4);
            m.compose(new THREE.Vector3(px + ox * 0.18, bottom + 1, pz + oz * 0.18), q, new THREE.Vector3(0.8, elev + 0.25 - bottom - 1, 0.8));
            piles.add(m, 4);
          }
        }
      }
    }
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
      g.setIndex(idx);
      g.computeBoundingSphere();
      this.geometry = g;
      const mesh = new THREE.Mesh(g, groundMaterial);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      mesh.name = 'pierDecks';
      this.object.add(mesh);
    }
    this.object.add(piles.mesh);
    this.piles = piles;
  }

  private piles: CulledSet | null = null;

  update(planes: THREE.Plane[], cam: THREE.Vector3): void {
    this.piles?.update(planes, cam);
  }
}
