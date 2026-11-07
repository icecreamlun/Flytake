"""Fannette Island bare-earth surface from the lidar point cloud.

The 3DEP DEM is hydro-flattened (no island) and the island's returns carry no ground class,
so analyse.surfaces() used to estimate the ground as a morphological opening of the first
returns (a smooth blob). Here: the lowest non-noise return per 0.5 m cell from the cached EPT
nodes (under the island's open pine canopy many pulses reach the granite), a small grey
opening to drop residual branch hits, hole filling, then 1 m cells. Writes
WORK/island_ground.npy (1 m scene grid, NaN outside the island bbox) which analyse.surfaces()
prefers when present.
"""
from __future__ import annotations

import io
import json
from pathlib import Path

import laspy
import numpy as np
from scipy import ndimage as ndi

from common import E_MIN, MSL_TO_ELLIPSOID, N_MIN, WORK, enu_to_lonlat, grid_xy, lonlat_to_3857, m3857_to_lonlat

CACHE = WORK / "ept"
BASE = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SierraNevada_5_2022"
MAX_DEPTH = 16  # full density over this small box


def get(url: str, cache: Path) -> bytes:
    if cache.exists():
        return cache.read_bytes()
    import urllib.request

    with urllib.request.urlopen(url, timeout=60) as r:
        data = r.read()
    cache.write_bytes(data)
    return data


def island_nodes(cube, box) -> list[Path]:
    """Walk the EPT hierarchy over `box` down to MAX_DEPTH; fetch (cache) the node files."""
    import concurrent.futures as cf

    def bounds(d, x, y):
        w = (cube[3] - cube[0]) / 2**d
        return (cube[0] + x * w, cube[1] + y * w, cube[0] + (x + 1) * w, cube[1] + (y + 1) * w)

    hier = json.loads(get(f"{BASE}/ept-hierarchy/0-0-0-0.json", CACHE / "h-0-0-0-0.json"))
    stack, keys = ["0-0-0-0"], []
    while stack:
        key = stack.pop()
        d, x, y, z = map(int, key.split("-"))
        b = bounds(d, x, y)
        if d > MAX_DEPTH or b[2] < box[0] or b[0] > box[2] or b[3] < box[1] or b[1] > box[3] or key not in hier:
            continue
        if hier[key] == -1:
            hier.update(json.loads(get(f"{BASE}/ept-hierarchy/{key}.json", CACHE / f"h-{key}.json")))
        if hier[key] > 0:
            keys.append(key)
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    stack.append(f"{d + 1}-{2 * x + dx}-{2 * y + dy}-{2 * z + dz}")
    with cf.ThreadPoolExecutor(12) as ex:
        list(ex.map(lambda k: get(f"{BASE}/ept-data/{k}.laz", CACHE / f"{k}.laz"), keys))
    return [CACHE / f"{k}.laz" for k in keys]
# island bbox (scene grid metres) + margin
E0, E1, N0, N1 = -125.0, 70.0, -125.0, 75.0
CELL = 0.5


def main():
    meta = json.loads((CACHE / "ept.json").read_text())
    cube = meta["bounds"]
    es, ns = np.meshgrid(np.linspace(E0, E1, 5), np.linspace(N0, N1, 5))
    lon, lat = enu_to_lonlat(es, ns)
    X, Y = lonlat_to_3857(lon, lat)
    box = (X.min(), Y.min(), X.max(), Y.max())
    files = island_nodes(cube, box)
    print(f"{len(files)} EPT nodes over the island")
    nx, ny = int((E1 - E0) / CELL), int((N1 - N0) / CELL)
    low = np.full((ny, nx), np.inf, np.float32)
    cnt = np.zeros((ny, nx), np.int32)
    total = 0
    for f in files:
        las = laspy.read(io.BytesIO(f.read_bytes()))
        cls = np.asarray(las.classification)
        keep = (cls != 7) & (cls != 18) & (cls != 9)
        x, y, z = np.asarray(las.x)[keep], np.asarray(las.y)[keep], np.asarray(las.z, np.float64)[keep]
        inb = (x >= box[0]) & (x <= box[2]) & (y >= box[1]) & (y <= box[3])
        if not inb.any():
            continue
        lo, la = m3857_to_lonlat(x[inb], y[inb])
        e, n = grid_xy(lo, la)
        u = (z[inb] + MSL_TO_ELLIPSOID).astype(np.float32)
        ci = np.floor((e - E0) / CELL).astype(np.int64)
        ri = np.floor((n - N0) / CELL).astype(np.int64)
        ok = (ci >= 0) & (ci < nx) & (ri >= 0) & (ri < ny)
        idx = ri[ok] * nx + ci[ok]
        np.minimum.at(low.ravel(), idx, u[ok])
        np.add.at(cnt.ravel(), idx, 1)
        total += int(ok.sum())
    print(f"{total} points, cells hit {np.mean(cnt > 0):.2f}")
    lake_h = float((WORK / "lake_level.txt").read_text())
    g = np.where(np.isfinite(low), low, np.nan)
    # residual branch hits: local minimum envelope over 2.5 m, then a gentle closing back up
    valid = np.isfinite(g)
    filled = g.copy()
    # nearest-neighbour fill of empty cells for the morphology
    idx = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    filled = g[tuple(idx)]
    opened = ndi.grey_opening(filled, size=(5, 5))
    # only pull cells down where they stand well above the envelope (vegetation), keep rock edges
    ground = np.where(filled - opened > 1.2, opened, filled)
    ground = ndi.median_filter(ground, size=3)
    ground = np.maximum(ground, lake_h - 0.5)
    # 0.5 m -> 1 m scene grid cells
    g1 = ground[: ny // 2 * 2, : nx // 2 * 2].reshape(ny // 2, 2, nx // 2, 2).mean(axis=(1, 3))
    out = np.full((7700, 8000), np.nan, np.float32)
    r0 = int(round(N0 - N_MIN))
    c0 = int(round(E0 - E_MIN))
    out[r0:r0 + g1.shape[0], c0:c0 + g1.shape[1]] = g1
    np.save(WORK / "island_ground.npy", out)
    print(f"island ground: top {np.nanmax(g1) - lake_h:.1f} m above the lake")


if __name__ == "__main__":
    main()
