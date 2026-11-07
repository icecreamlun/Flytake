"""Ground-cover props from Poly Haven CC0 scans (rocks, logs, stump).

Usage: python -I ground_assets.py <download_dir>
  <download_dir>/<asset>/<asset>_1k.gltf (+ .bin, textures/) as served by
  https://api.polyhaven.com/files/<asset> (gltf, 1k).

For each asset: Y-up glTF -> Z-up ENU, origin at the bottom centre, decimated with texture
coordinates kept (quadric edge collapse) into two LODs, written as one compact binary per LOD:
  public/scene/ground/props/<name>_<lod>.bin
     u32 vertexCount, u32 indexCount, f32 bbox[6],
     f32 position[3 * n], i8 normal[4 * n] (xyz, pad), u16 uv[2 * n] (unorm), u16|u32 index
plus 1k textures public/textures/ground2/<name>_diff.jpg (AO multiplied in) and _nor.jpg (GL).
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np
import pymeshlab
import trimesh
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "scene" / "ground" / "props"
TEX = ROOT / "public" / "textures" / "ground2"

# asset -> (short name, faces per LOD)
ASSETS = {
    "namaqualand_boulder_05": ("rock_a", (2400, 320, 64)),
    "namaqualand_boulder_03": ("rock_b", (2000, 280, 60)),
    "namaqualand_boulder_04": ("rock_c", (2000, 280, 60)),
    "stone_01": ("rock_d", (2000, 280, 60)),
    "moon_rock_02": ("rock_e", (1800, 260, 60)),
    "dead_tree_trunk_02": ("log_a", (3000, 420)),
    "dead_tree_trunk": ("log_b", (2400, 360)),
    "tree_stump_01": ("stump", (1800, 260)),
}


def load(path: Path):
    scene = trimesh.load(path, force="scene")
    meshes = []
    for name, geom in scene.geometry.items():
        for node in scene.graph.geometry_nodes.get(name, []):
            m = geom.copy()
            m.apply_transform(scene.graph.get(node)[0])
            meshes.append(m)
    uv = [m.visual.uv if getattr(m.visual, "uv", None) is not None else np.zeros((len(m.vertices), 2)) for m in meshes]
    verts, faces, uvs, off = [], [], [], 0
    for m, u in zip(meshes, uv):
        verts.append(np.asarray(m.vertices))
        faces.append(np.asarray(m.faces) + off)
        uvs.append(np.asarray(u))
        off += len(m.vertices)
    v = np.concatenate(verts)
    f = np.concatenate(faces)
    t = np.concatenate(uvs)
    material = meshes[0].visual.material
    return v, f, t, material


def decimate(v, f, t, target):
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=v, face_matrix=f, v_tex_coords_matrix=t))
    ms.compute_texcoord_transfer_vertex_to_wedge()
    ms.meshing_decimation_quadric_edge_collapse_with_texture(
        targetfacenum=int(target), qualitythr=0.3, extratcoordw=1.0, preserveboundary=False, optimalplacement=True, preservenormal=True
    )
    m = ms.current_mesh()
    vv = m.vertex_matrix()
    ff = m.face_matrix()
    wt = m.wedge_tex_coord_matrix().reshape(-1, 3, 2)
    # split vertices by (vertex, uv) pairs
    corner_v = ff.reshape(-1)
    corner_t = wt.reshape(-1, 2)
    key = np.concatenate([corner_v[:, None].astype(np.float64), np.round(corner_t * 65535)], 1)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    pos = vv[uniq[:, 0].astype(np.int64)]
    uv = uniq[:, 1:] / 65535.0
    idx = inv.reshape(-1, 3)
    # smooth normals per original vertex (shared across uv seams)
    fn = np.cross(vv[ff[:, 1]] - vv[ff[:, 0]], vv[ff[:, 2]] - vv[ff[:, 0]])
    vn = np.zeros_like(vv)
    for k in range(3):
        np.add.at(vn, ff[:, k], fn)
    vn /= np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12
    nrm = vn[uniq[:, 0].astype(np.int64)]
    return pos, nrm, uv, idx


def write_bin(path: Path, pos, nrm, uv, idx):
    n = len(pos)
    bbox = np.concatenate([pos.min(0), pos.max(0)]).astype(np.float32)
    head = struct.pack("<II", n, idx.size) + bbox.tobytes()
    p = pos.astype(np.float32).tobytes()
    q = np.zeros((n, 4), np.int8)
    q[:, :3] = np.clip(np.round(nrm * 127), -127, 127)
    u = np.clip(np.round(np.clip(uv, 0, 1) * 65535), 0, 65535).astype(np.uint16)
    ind = idx.astype(np.uint16 if n < 65536 else np.uint32).ravel()
    path.write_bytes(head + p + q.tobytes() + u.tobytes() + ind.tobytes())
    return path.stat().st_size


def main():
    src = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    TEX.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for asset, (name, lods) in ASSETS.items():
        gltf = next((src / asset).glob("*.gltf"))
        v, f, t, mat = load(gltf)
        # glTF Y-up -> ENU Z-up: (x, y, z) -> (x, -z, y)
        v = np.stack([v[:, 0], -v[:, 2], v[:, 1]], 1)
        lo, hi = v.min(0), v.max(0)
        v = v - np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
        sizes = {}
        for lod, target in enumerate(lods):
            pos, nrm, uv, idx = decimate(v, f, t, min(target, len(f)))
            # glTF uv origin is top-left; three samples with flipY=false for our raw textures
            sizes[lod] = write_bin(OUT / f"{name}_{lod}.bin", pos, nrm, uv, idx)
        ext = (v.max(0) - v.min(0)).round(3).tolist()
        # textures: diffuse x AO (from ARM), GL normal
        tex_dir = gltf.parent / "textures"
        diff = next(tex_dir.glob("*_diff_1k.*"))
        nor = next(tex_dir.glob("*_nor_gl_1k.*"))
        arm = next(iter(tex_dir.glob("*_arm_1k.*")), None)
        d = np.asarray(Image.open(diff).convert("RGB"), np.float32)
        if arm is not None:
            ao = np.asarray(Image.open(arm).convert("RGB"), np.float32)[..., 0:1] / 255.0
            if ao.shape[:2] == d.shape[:2]:
                d = d * (0.35 + 0.65 * ao)
        Image.fromarray(np.clip(d, 0, 255).astype(np.uint8)).save(TEX / f"{name}_diff.jpg", quality=88)
        Image.open(nor).convert("RGB").save(TEX / f"{name}_nor.jpg", quality=92)
        mean = (d.reshape(-1, 3).mean(0) / 255.0).round(4).tolist()
        manifest[name] = {"asset": asset, "size": ext, "faces": list(lods), "bytes": sizes, "mean": mean}
        print(name, asset, "src faces", len(f), "size", ext, "bytes", sizes)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
