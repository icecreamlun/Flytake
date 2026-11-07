/**
 * PartBuilder: accumulates many small geometries per material key and merges them into one mesh per
 * key (one draw call per material per landmark). Every part gets:
 *   - flat normals (architecture reads crisper),
 *   - box-projected UVs in metres of the landmark's local frame (textures keep a constant texel density;
 *     material textures set .repeat = 1/tile),
 *   - a per-vertex linear RGB tint (`color`) and a night-glow weight (`aGlow`, see materials.ts).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface AddOpts {
  /** Albedo tint (multiplies the material colour/map). */
  color?: THREE.ColorRepresentation;
  /** Night emissive weight 0..1 (multiplies the material's glow colour). */
  glow?: number;
  /** 'box' = planar UVs in metres (default); 'keep' = use the geometry's own UVs. */
  uv?: 'box' | 'keep';
  /** Extra scale applied to box UVs (e.g. 2 = texture appears half size). */
  uvScale?: number;
  /** Keep smooth normals from the source geometry instead of flat ones. */
  smooth?: boolean;
}

const tmpC = new THREE.Color();

export class PartBuilder {
  private parts = new Map<string, THREE.BufferGeometry[]>();
  /** Running triangle count (for budgeting). */
  triangles = 0;

  add(key: string, geo: THREE.BufferGeometry, o: AddOpts = {}): void {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!o.smooth || !g.getAttribute('normal')) {
      g.deleteAttribute('normal');
      g.computeVertexNormals(); // non-indexed → flat per-triangle normals
    }
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const n = pos.count;
    if (o.uv !== 'keep' || !g.getAttribute('uv')) boxUV(g, o.uvScale ?? 1);
    const col = new Float32Array(n * 3);
    tmpC.set(o.color ?? 0xffffff);
    for (let i = 0; i < n; i++) {
      col[i * 3] = tmpC.r;
      col[i * 3 + 1] = tmpC.g;
      col[i * 3 + 2] = tmpC.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(n).fill(o.glow ?? 0), 1));
    let list = this.parts.get(key);
    if (!list) this.parts.set(key, (list = []));
    list.push(g);
    this.triangles += n / 3;
  }

  has(key: string): boolean {
    return this.parts.has(key);
  }

  /** Merge each key into one Mesh with materials[key]. */
  build(materials: Record<string, THREE.Material>, name = 'landmark'): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [key, list] of this.parts) {
      const mat = materials[key];
      if (!mat) throw new Error(`PartBuilder: no material for key "${key}"`);
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = (mat as THREE.Material & { userData: { noShadow?: boolean } }).userData.noShadow !== true;
      mesh.receiveShadow = true;
      group.add(mesh);
      list.forEach((g) => g.dispose());
    }
    this.parts.clear();
    return group;
  }
}

/** Planar UVs from the dominant axis of each triangle's normal, in metres. */
export function boxUV(g: THREE.BufferGeometry, scale = 1): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (let t = 0; t + 2 < n; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    e1.cross(e2);
    const ax = Math.abs(e1.x);
    const ay = Math.abs(e1.y);
    const az = Math.abs(e1.z);
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      let u: number;
      let v: number;
      if (ay >= ax && ay >= az) {
        u = x;
        v = -z;
      } else if (ax >= az) {
        u = e1.x > 0 ? -z : z;
        v = y;
      } else {
        u = e1.z > 0 ? x : -x;
        v = y;
      }
      uv[i * 2] = u * scale;
      uv[i * 2 + 1] = v * scale;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
