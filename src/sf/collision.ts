/**
 * What the San Francisco drone collides with: the city's static meshes, each with a three-mesh-bvh
 * bounds tree, ray-cast directly (no Raycaster, no global Mesh.raycast patch).
 *
 * In: the detailed ground tiles, seawalls and outer ground, the pier decks, Portsmouth Square,
 * building walls and roofs (roofs, parapets and rooftop clutter live in buildingProps), and every
 * landmark model: the Ferry Building, the Bay Bridge, the pier sheds, Transamerica...
 * Out: the sky, the bay water plane (y = 0; the drone treats it as water, see SfDroneSim), the
 * distant backdrop, the coarse ground LOD (a duplicate of the detailed tiles), road markings,
 * rail, traffic, trees and street props (instanced sets whose instance lists follow the camera),
 * railings, light beacons and lines.
 *
 * Buildings a landmark model replaces (the Ferry Building block, the Bay Bridge tower records...)
 * keep their triangles in the merged building geometry and are only collapsed in the vertex
 * shader; their triangles are dropped here so the drone cannot hit invisible boxes.
 */
import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Ray, Vector3, type Material, type Mesh, type Object3D } from 'three';
import { CENTER, MeshBVH } from 'three-mesh-bvh';
import type { SfCity } from './boot';

export interface SfCollider {
  /** distance along the unit direction `dir` from `origin` to the first surface within `far` (m), or null */
  cast(origin: Vector3, dir: Vector3, far: number): number | null;
  readonly meshes: number;
  readonly triangles: number;
  /** wall-clock time spent building the bounds trees, ms */
  readonly buildMs: number;
}

/** street groups that are solid ground (the rest move, follow the camera or are paint) */
const STREET_GROUPS = new Set(['ground', 'piers', 'portsmouthSquare']);
const SKIP_MESHES = new Set(['groundTileFar', 'buildingRailings']);
/** merged building meshes (vertex attribute aBld = index into city.buildings) */
const BUILDING_MESHES = new Set(['buildingWallsCore', 'buildingWallsContext', 'buildingProps']);
/** yield to the browser (loading bar) about this often while building, ms */
const SLICE_MS = 60;

interface Entry {
  bvh: MeshBVH;
  /** world -> mesh space, null when the mesh sits in world space */
  toLocal: Matrix4 | null;
  toWorld: Matrix4;
  /** world-space bounds, for a cheap reject before the tree */
  box: Box3;
}

const _ray = new Ray();
const _local = new Ray();
const _hit = new Vector3();
const _tip = new Vector3();

function isSolid(material: Material | Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  // glows, light cones and other effects don't write depth
  return list.some((m) => m.visible && m.depthWrite);
}

/**
 * A private copy of the triangle list (the bounds tree reorders it) sharing the source's
 * positions, optionally without the triangles `drop` rejects (by first vertex).
 */
function collisionGeometry(src: BufferGeometry, drop?: (vertex: number) => boolean): BufferGeometry | null {
  const position = src.getAttribute('position');
  if (position == null || position.count === 0) return null;
  const index = src.getIndex();
  const count = index != null ? index.count : position.count;
  const out = new Uint32Array(count);
  let n = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const a = index != null ? index.getX(i) : i;
    if (drop?.(a) === true) continue;
    out[n++] = a;
    out[n++] = index != null ? index.getX(i + 1) : i + 1;
    out[n++] = index != null ? index.getX(i + 2) : i + 2;
  }
  if (n === 0) return null;
  const geometry = new BufferGeometry();
  if ((position as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute === true) {
    const flat = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      flat[i * 3] = position.getX(i);
      flat[i * 3 + 1] = position.getY(i);
      flat[i * 3 + 2] = position.getZ(i);
    }
    geometry.setAttribute('position', new BufferAttribute(flat, 3));
  } else {
    geometry.setAttribute('position', position);
  }
  geometry.setIndex(new BufferAttribute(n === count ? out : out.slice(0, n), 1));
  return geometry;
}

/** The meshes to collide with, each with an optional triangle filter. */
function collectMeshes(city: SfCity): Array<{ mesh: Mesh; drop?: (vertex: number) => boolean }> {
  const out: Array<{ mesh: Mesh; drop?: (vertex: number) => boolean }> = [];
  const take = (root: Object3D, drop?: (vertex: number) => boolean, visibleOnly = false) => {
    const visit = (o: Object3D) => {
      const m = o as Mesh & { isInstancedMesh?: boolean };
      if (m.isMesh !== true || m.isInstancedMesh === true || SKIP_MESHES.has(m.name)) return;
      if (!isSolid(m.material)) return;
      out.push({ mesh: m, drop });
    };
    if (visibleOnly) root.traverseVisible(visit);
    else root.traverse(visit);
  };

  for (const group of city.streets.object.children) {
    if (STREET_GROUPS.has(group.name)) take(group);
  }

  // Footprints a landmark replaces are hidden (collapsed in the vertex shader), not removed.
  const hidden = new Uint8Array(city.buildings.count);
  for (let i = 0; i < hidden.length; i++) hidden[i] = (city.buildings.getState(i).hidden ?? 0) > 0.5 ? 1 : 0;
  for (const mesh of city.buildings.object.children) {
    if (!BUILDING_MESHES.has(mesh.name)) continue;
    const bld = (mesh as Mesh).geometry?.getAttribute('aBld');
    take(mesh, bld == null ? undefined : (v) => hidden[Math.round(bld.getX(v))] === 1);
  }

  // Landmark models; invisible parts such as the quake-only rubble are skipped at any depth.
  for (const group of city.landmarks.object.children) take(group, undefined, true);
  return out;
}

const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** Build the bounds trees (a second or two for ~2.5 M triangles; yields so the page can paint). */
export async function buildSfCollider(city: SfCity, onProgress?: (fraction: number) => void): Promise<SfCollider> {
  const started = performance.now();
  city.cityRoot.updateMatrixWorld(true);
  const sources = collectMeshes(city);
  const entries: Entry[] = [];
  /** meshes sharing a geometry (and filter) share one tree */
  const trees = new Map<BufferGeometry, MeshBVH | null>();
  let triangles = 0;
  let slice = performance.now();

  for (let i = 0; i < sources.length; i++) {
    const { mesh, drop } = sources[i]!;
    let bvh = trees.get(mesh.geometry);
    if (bvh === undefined) {
      const geometry = collisionGeometry(mesh.geometry, drop);
      bvh = geometry == null ? null : new MeshBVH(geometry, { strategy: CENTER, maxLeafTris: 8, setBoundingBox: false });
      trees.set(mesh.geometry, bvh);
      if (geometry != null) triangles += geometry.getIndex()!.count / 3;
    }
    if (bvh == null) continue;
    const toWorld = mesh.matrixWorld.clone();
    const identity = toWorld.equals(new Matrix4());
    const box = bvh.getBoundingBox(new Box3()).applyMatrix4(toWorld);
    entries.push({ bvh, toWorld, toLocal: identity ? null : toWorld.clone().invert(), box });

    if (performance.now() - slice > SLICE_MS) {
      onProgress?.((i + 1) / sources.length);
      await nextPaint();
      slice = performance.now();
    }
  }
  onProgress?.(1);

  const buildMs = performance.now() - started;
  return {
    meshes: entries.length,
    triangles,
    buildMs,
    cast(origin, dir, far) {
      _ray.set(origin, dir);
      let best = far;
      let found = false;
      for (const e of entries) {
        // Reject on the bounds first (also when the box is entirely farther than the best hit).
        // Ray.intersectBox returns the exit point from inside a box: only test from outside.
        if (!e.box.containsPoint(origin)) {
          const p = _ray.intersectBox(e.box, _hit);
          if (p == null || p.distanceTo(origin) > best) continue;
        }
        if (e.toLocal == null) {
          const hit = e.bvh.raycastFirst(_ray, DoubleSide, 0, best);
          if (hit != null && hit.distance < best) {
            best = hit.distance;
            found = true;
          }
          continue;
        }
        // Mesh space: a rigid pivot in practice, but scale-safe (distances are converted back).
        _local.origin.copy(origin).applyMatrix4(e.toLocal);
        _tip.copy(origin).add(dir).applyMatrix4(e.toLocal).sub(_local.origin);
        const scale = _tip.length();
        if (!(scale > 0)) continue;
        _local.direction.copy(_tip).divideScalar(scale);
        const hit = e.bvh.raycastFirst(_local, DoubleSide, 0, best * scale);
        if (hit == null) continue;
        const d = hit.point.applyMatrix4(e.toWorld).distanceTo(origin);
        if (d < best) {
          best = d;
          found = true;
        }
      }
      return found ? best : null;
    },
  };
}
