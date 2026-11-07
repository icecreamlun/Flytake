"""Stage 4: cut the terrain into a 3D Tiles 1.0 quadtree (public/scene/terrain/).

Each tile is a GLB: an RTIN-simplified (Martini) height grid with skirts, positions in the exact
local ENU frame of the Emerald Bay origin (relative to the tile centre, glTF Y-up), and two WebP
textures:
  baseColorTexture  RGBA 512^2: RGB = albedo (sRGB), A = sky occlusion (linear)
  normalTexture     RGBA 256^2: RGB = the terrain normal in scene ENU (x east, y north, z up)
                    encoded as n * 0.5 + 0.5, from the 1 m terrain (an object-space map, not
                    tangent space; the browser samples it itself, see src/world/Terrain.tsx);
                    A = rockiness (metre-scale lidar roughness or steepness, 0..1)
The material is a plain (lit) glTF material so that three's GLTFLoader keeps the normal map.
The tileset root transform is ENU -> ECEF.

Inputs (WORK/): terrain.npy (1 m heights incl. lake bed), bake.npy (0.5 m RGBA, north-up rows
growing northward), lake_level.txt.
"""
from __future__ import annotations

import io
import json
import math
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from common import E_MAX, E_MIN, EAST, H0, N_MAX, N_MIN, NORTH, ORIGIN_ECEF, OUT, UP, WORK, enu_to_lonlat, lonlat_to_enu

LEVELS = 6  # 0..5, leaves 250 m x 240.6 m
GRID = 129  # samples per tile edge (2^k + 1 for Martini)
TEX = 512
NTEX = 256
MAX_ERROR = [8.0, 4.0, 2.0, 0.8, 0.35, 0.15]  # metres, RTIN simplification per level
WEBP_QUALITY = 82
DEST = OUT / "terrain"

_terrain = None
_bake = None
_pyr: dict[int, np.ndarray] = {}


def load():
    global _terrain, _bake
    if _terrain is None:
        _terrain = np.load(WORK / "terrain.npy", mmap_mode="r")
        _bake = np.load(WORK / "bake.npy", mmap_mode="r")


def level_heights(level: int) -> tuple[np.ndarray, float]:
    """Height raster pre-filtered for a level (block mean), and its cell size in metres."""
    if level not in _pyr:
        tile_e = (E_MAX - E_MIN) / 2**level
        spacing = tile_e / (GRID - 1)
        f = max(1, int(spacing // 2))
        t = np.asarray(_terrain)
        if f > 1:
            h, w = (t.shape[0] // f) * f, (t.shape[1] // f) * f
            t = t[:h, :w].reshape(h // f, f, w // f, f).mean(axis=(1, 3))
        _pyr[level] = (t.astype(np.float32), float(f))
    return _pyr[level]


def sample_heights(level: int, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    t, cell = level_heights(level)
    col = (xs - E_MIN) / cell - 0.5
    row = (ys - N_MIN) / cell - 0.5
    return ndi.map_coordinates(t, [row, col], order=1, mode="nearest")


def tile_rect(level: int, i: int, j: int):
    se = (E_MAX - E_MIN) / 2**level
    sn = (N_MAX - N_MIN) / 2**level
    return E_MIN + i * se, N_MIN + j * sn, se, sn


def glb(positions: np.ndarray, uvs: np.ndarray, indices: np.ndarray, image: bytes, normal: bytes, translation) -> bytes:
    idx_type = 5123 if positions.shape[0] < 65536 else 5125
    idx = indices.astype(np.uint16 if idx_type == 5123 else np.uint32).tobytes()
    pos = positions.astype(np.float32).tobytes()
    uv = uvs.astype(np.float32).tobytes()

    def pad4(b: bytes, fill=b"\0") -> bytes:
        return b + fill * ((4 - len(b) % 4) % 4)

    chunks = [pad4(idx), pad4(pos), pad4(uv), pad4(image), pad4(normal)]
    offsets = np.cumsum([0] + [len(c) for c in chunks])[:-1]
    lens = [len(idx), len(pos), len(uv), len(image), len(normal)]
    gltf = {
        "asset": {"version": "2.0", "generator": "flytake tools/scene"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "translation": [float(v) for v in translation]}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 1, "TEXCOORD_0": 2}, "indices": 0, "material": 0}]}],
        "materials": [{
            "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 1},
            "normalTexture": {"index": 1},
        }],
        "textures": [{"source": 0, "sampler": 0}, {"source": 1, "sampler": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": 3, "mimeType": "image/webp"}, {"bufferView": 4, "mimeType": "image/webp"}],
        "buffers": [{"byteLength": int(sum(len(c) for c in chunks))}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": int(offsets[0]), "byteLength": lens[0], "target": 34963},
            {"buffer": 0, "byteOffset": int(offsets[1]), "byteLength": lens[1], "target": 34962},
            {"buffer": 0, "byteOffset": int(offsets[2]), "byteLength": lens[2], "target": 34962},
            {"buffer": 0, "byteOffset": int(offsets[3]), "byteLength": lens[3]},
            {"buffer": 0, "byteOffset": int(offsets[4]), "byteLength": lens[4]},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": idx_type, "count": int(indices.size), "type": "SCALAR"},
            {"bufferView": 1, "componentType": 5126, "count": int(positions.shape[0]), "type": "VEC3",
             "min": positions.min(0).astype(float).tolist(), "max": positions.max(0).astype(float).tolist()},
            {"bufferView": 2, "componentType": 5126, "count": int(uvs.shape[0]), "type": "VEC2"},
        ],
    }
    js = pad4(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    binary = b"".join(chunks)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def normal_image(e0: float, n0: float, se: float, sn: float) -> bytes:
    """ENU terrain normals over the tile, NTEX^2, row 0 = north, from the 1 m terrain."""
    t = _terrain
    px = max(se, sn) / NTEX
    sigma = max(0.6, 0.5 * px)
    m = int(math.ceil(3 * sigma)) + 2
    c0 = int(math.floor(e0 - E_MIN)) - m
    c1 = int(math.ceil(e0 + se - E_MIN)) + m
    r0 = int(math.floor(n0 - N_MIN)) - m
    r1 = int(math.ceil(n0 + sn - N_MIN)) + m
    H, W = t.shape
    crop = np.asarray(t[max(r0, 0):min(r1, H), max(c0, 0):min(c1, W)], np.float32)
    crop = np.pad(crop, ((max(0, -r0), max(0, r1 - H)), (max(0, -c0), max(0, c1 - W))), mode="edge")
    # rockiness on the full 1 m grid (also for the coarser levels, block-averaged below with the
    # heights): bare granite reads as metre-scale roughness (boulders, slabs, ledges)
    rough_full = None
    if px <= 16:
        g1 = ndi.gaussian_filter(crop, 0.7)
        rough_full = ndi.gaussian_filter(np.abs(g1 - ndi.gaussian_filter(g1, 4.0)), 1.5)
    if px > 3:
        # pre-shrink large tiles (block mean) so the blur stays cheap
        f = int(px // 2)
        hh, ww = (crop.shape[0] // f) * f, (crop.shape[1] // f) * f
        crop = crop[:hh, :ww].reshape(hh // f, f, ww // f, f).mean(axis=(1, 3))
        if rough_full is not None:
            rough_full = rough_full[:hh, :ww].reshape(hh // f, f, ww // f, f).mean(axis=(1, 3))
        cell = float(f)
    else:
        cell = 1.0
    g = ndi.gaussian_filter(crop, sigma / cell)
    gy, gx = np.gradient(g, cell)  # rows grow northward
    # output texel centres -> crop index space (cell centres at +0.5)
    es = e0 + (np.arange(NTEX) + 0.5) * se / NTEX
    ns = n0 + sn - (np.arange(NTEX) + 0.5) * sn / NTEX
    E, N = np.meshgrid(es, ns)
    ci = (E - E_MIN - c0) / cell - 0.5
    ri = (N - N_MIN - r0) / cell - 0.5
    sx = ndi.map_coordinates(gx, [ri, ci], order=1, mode="nearest")
    sy = ndi.map_coordinates(gy, [ri, ci], order=1, mode="nearest")
    nrm = np.stack([-sx, -sy, np.ones_like(sx)], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    # rockiness: the roughness above or steep faces; beaches and the duff under the forest are smooth
    if rough_full is not None:
        rr = ndi.map_coordinates(rough_full, [ri, ci], order=1, mode="nearest")
        rock = np.clip((rr - 0.07) / 0.25, 0, 1)
    else:
        rock = np.zeros_like(sx)
    steep = np.clip((1 - nrm[..., 2] - 0.3) / 0.35, 0, 1)
    rock = np.maximum(rock, steep)
    img = np.clip(np.round((nrm * 0.5 + 0.5) * 255), 0, 255).astype(np.uint8)
    img = np.dstack([img, np.round(rock * 255).astype(np.uint8)])
    buf = io.BytesIO()
    Image.fromarray(img, "RGBA").save(buf, "WEBP", quality=88, alpha_quality=80, method=4, exact=True)
    return buf.getvalue()


def build_tile(args):
    level, i, j = args
    load()
    from pymartini import Martini

    e0, n0, se, sn = tile_rect(level, i, j)
    gx = e0 + np.linspace(0, se, GRID)
    gy = n0 + np.linspace(0, sn, GRID)
    X, Y = np.meshgrid(gx, gy)  # row = y index (south -> north), col = x
    H = sample_heights(level, X.ravel(), Y.ravel()).reshape(GRID, GRID).astype(np.float32)
    martini = Martini(GRID)
    tile = martini.create_tile(H.ravel())
    verts, tris = tile.get_mesh(MAX_ERROR[level])
    verts = np.asarray(verts, np.int64).reshape(-1, 2)
    tris = np.asarray(tris, np.int64).reshape(-1, 3)
    vx, vy = verts[:, 0], verts[:, 1]
    xs, ys, hs = gx[vx], gy[vy], H[vy, vx]

    # skirts: extrude boundary edges downwards to hide cracks between LODs
    edges = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    key = np.sort(edges, axis=1)
    uniq, inv, counts = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    border = edges[counts[inv.ravel()] == 1]
    # keep only edges on the tile boundary (martini meshes have no interior holes)
    on_b = lambda v: (vx[v] == 0) | (vx[v] == GRID - 1) | (vy[v] == 0) | (vy[v] == GRID - 1)
    border = border[on_b(border[:, 0]) & on_b(border[:, 1])]
    skirt_depth = max(1.0, 3 * MAX_ERROR[level])
    bv = np.unique(border)
    remap = np.full(len(xs), -1, np.int64)
    remap[bv] = len(xs) + np.arange(len(bv))
    xs = np.concatenate([xs, xs[bv]])
    ys = np.concatenate([ys, ys[bv]])
    hs = np.concatenate([hs, hs[bv] - skirt_depth])
    a, b = border[:, 0], border[:, 1]
    skirt_tris = np.concatenate([np.stack([a, b, remap[b]], 1), np.stack([a, remap[b], remap[a]], 1)])
    tris = np.concatenate([tris, skirt_tris])

    # exact ENU positions (Earth curvature included)
    lon, lat = enu_to_lonlat(xs, ys)
    e, n, u = lonlat_to_enu(lon, lat, hs)
    ce, cn = e0 + se / 2, n0 + sn / 2
    cu = 0.5 * (float(u.min()) + float(u.max()))
    # glTF is Y-up: (x, y, z) = (east, up, -north); 3D Tiles rotates it back to Z-up
    pos = np.stack([e - ce, u - cu, -(n - cn)], 1)
    # Martini winds triangles clockwise in (east, north) seen from above (its y is the row,
    # which grows northward here): flip them (skirts included) so the top faces are front faces.
    uvs = np.stack([(xs - e0) / se, 1 - (ys - n0) / sn], 1)
    tris = tris[:, [0, 2, 1]]

    # texture: crop of the 0.5 m bake (rows grow northward -> flip so the image top is north)
    c0 = int(math.floor((e0 - E_MIN) * 2))
    c1 = int(math.ceil((e0 + se - E_MIN) * 2))
    r0 = int(math.floor((n0 - N_MIN) * 2))
    r1 = int(math.ceil((n0 + sn - N_MIN) * 2))
    crop = np.asarray(_bake[max(r0, 0):r1, max(c0, 0):c1])[::-1]
    # resize RGB and A separately: Pillow resizes RGBA premultiplied, which would darken the
    # colour wherever the occlusion (alpha) is low
    filt = Image.Resampling.BOX if crop.shape[0] > TEX else Image.Resampling.LANCZOS
    rgb = Image.fromarray(np.ascontiguousarray(crop[..., :3]), "RGB").resize((TEX, TEX), filt)
    a = Image.fromarray(np.ascontiguousarray(crop[..., 3]), "L").resize((TEX, TEX), filt)
    im = Image.merge("RGBA", (*rgb.split(), a))
    buf = io.BytesIO()
    # exact: keep the RGB under low alpha (alpha is sky occlusion, not transparency)
    im.save(buf, "WEBP", quality=WEBP_QUALITY, alpha_quality=90, method=4, exact=True)
    data = glb(pos, uvs, tris, buf.getvalue(), normal_image(e0, n0, se, sn), (ce, cu, -cn))
    path = DEST / f"{level}" / f"{i}_{j}.glb"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return level, i, j, float(u.min()) - skirt_depth, float(u.max()), len(data), len(tris)


def geometric_error(level: int) -> float:
    if level == LEVELS - 1:
        return 0.0
    # error of drawing this tile instead of its children ~ 2 texels of this level
    return 2.0 * ((E_MAX - E_MIN) / 2**level) / TEX


def enu_to_ecef_matrix() -> list[float]:
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = EAST, NORTH, UP, ORIGIN_ECEF
    return m.T.ravel().tolist()  # column-major


def main():
    t0 = time.time()
    DEST.mkdir(parents=True, exist_ok=True)
    jobs = [(L, i, j) for L in range(LEVELS) for i in range(2**L) for j in range(2**L)]
    results = {}
    total = 0
    tris = 0
    with ProcessPoolExecutor(10) as ex:
        for k, (L, i, j, umin, umax, size, ntri) in enumerate(ex.map(build_tile, jobs, chunksize=4)):
            results[(L, i, j)] = (umin, umax)
            total += size
            tris += ntri
            if k % 200 == 0:
                print(f"  {k}/{len(jobs)} tiles, {total / 2**20:.0f} MB, {time.time() - t0:.0f}s", flush=True)

    def node(L, i, j):
        e0, n0, se, sn = tile_rect(L, i, j)
        umin, umax = results[(L, i, j)]
        children = [node(L + 1, 2 * i + di, 2 * j + dj) for dj in (0, 1) for di in (0, 1)] if L + 1 < LEVELS else []
        if children:
            umin = min(umin, *(c["_umin"] for c in children))
            umax = max(umax, *(c["_umax"] for c in children))
        margin = 3.0
        box = [e0 + se / 2, n0 + sn / 2, (umin + umax) / 2,
               se / 2 + margin, 0, 0, 0, sn / 2 + margin, 0, 0, 0, (umax - umin) / 2 + margin]
        out = {"boundingVolume": {"box": box}, "geometricError": geometric_error(L), "refine": "REPLACE",
               "content": {"uri": f"{L}/{i}_{j}.glb"}, "_umin": umin, "_umax": umax}
        if children:
            out["children"] = children
        return out

    root = node(0, 0, 0)

    def strip(n):
        n.pop("_umin", None)
        n.pop("_umax", None)
        for c in n.get("children", []):
            strip(c)

    strip(root)
    root["transform"] = enu_to_ecef_matrix()
    tileset = {"asset": {"version": "1.0", "gltfUpAxis": "Y"}, "geometricError": 2 * root["geometricError"] + 16, "root": root}
    (DEST / "tileset.json").write_text(json.dumps(tileset))
    print(f"{len(jobs)} tiles, {total / 2**20:.0f} MB, {tris / 1e6:.1f} M triangles in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
