"""Download the USGS 3DEP lidar point cloud (CA_SierraNevada_5_2022, Entwine EPT on AWS) over the
scene extent and rasterise a 1 m first-surface model (max Z per cell), a ground-return model and
per-cell classification flags. Writes WORK/lidar_*.npy on the ENU 1 m grid.

Usage: python fetch_lidar.py [depth]
"""
from __future__ import annotations

import concurrent.futures as cf
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

import laspy
import numpy as np

from common import E_MAX, E_MIN, N_MAX, N_MIN, MSL_TO_ELLIPSOID, WORK, enu_to_lonlat, grid_xy, lonlat_to_3857, m3857_to_lonlat

BASE = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SierraNevada_5_2022"
CACHE = WORK / "ept"
CACHE.mkdir(parents=True, exist_ok=True)
DEPTH = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 11
PAD = 60.0


def get(url: str, cache: Path | None = None, tries: int = 4) -> bytes:
    if cache is not None and cache.exists():
        return cache.read_bytes()
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            if cache is not None:
                cache.write_bytes(data)
            return data
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(url)


meta = json.loads(get(f"{BASE}/ept.json", CACHE / "ept.json"))
cube = meta["bounds"]
# scene box in EPSG:3857 (corners + edges, padded)
es = np.linspace(E_MIN - PAD, E_MAX + PAD, 9)
ns = np.linspace(N_MIN - PAD, N_MAX + PAD, 9)
E, N = np.meshgrid(es, ns)
lon, lat = enu_to_lonlat(E, N)
X, Y = lonlat_to_3857(lon, lat)
box = (X.min(), Y.min(), X.max(), Y.max())
print("3857 box", [round(v) for v in box])


def node_bounds(d, x, y, z):
    w = (cube[3] - cube[0]) / 2**d
    return (cube[0] + x * w, cube[1] + y * w, cube[0] + (x + 1) * w, cube[1] + (y + 1) * w)


def intersects(b):
    return not (b[2] < box[0] or b[0] > box[2] or b[3] < box[1] or b[1] > box[3])


# walk the hierarchy
nodes: dict[str, int] = {}


def load_hierarchy(key: str):
    h = json.loads(get(f"{BASE}/ept-hierarchy/{key}.json", CACHE / f"h-{key}.json"))
    return h


pending = ["0-0-0-0"]
hier = load_hierarchy("0-0-0-0")
stack = ["0-0-0-0"]
seen_h = {"0-0-0-0"}
while stack:
    key = stack.pop()
    d, x, y, z = map(int, key.split("-"))
    if d > DEPTH or not intersects(node_bounds(d, x, y, z)):
        continue
    if key not in hier:
        continue
    count = hier[key]
    if count == -1:
        hier.update(load_hierarchy(key))
        count = hier[key]
        if count == -1:
            continue
    if count > 0:
        nodes[key] = count
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                stack.append(f"{d + 1}-{2 * x + dx}-{2 * y + dy}-{2 * z + dz}")

total = sum(nodes.values())
print(f"{len(nodes)} nodes up to depth {DEPTH}, {total / 1e6:.1f} M points")
for dd in range(DEPTH + 1):
    print("  depth", dd, sum(v for k, v in nodes.items() if k.startswith(f"{dd}-")) / 1e6, "M")
if "count" in sys.argv:
    sys.exit(0)

# rasters on the ENU 1 m grid
W = int(E_MAX - E_MIN)
H = int(N_MAX - N_MIN)
first = np.full((H, W), -np.inf, np.float32)  # highest return (any class except noise / water)
ground = np.full((H, W), np.inf, np.float32)  # lowest ground return
gcount = np.zeros((H, W), np.uint16)
count = np.zeros((H, W), np.uint16)
building = np.zeros((H, W), np.uint8)
water = np.zeros((H, W), np.uint8)


def fetch(key: str):
    data = get(f"{BASE}/ept-data/{key}.laz", CACHE / f"{key}.laz")
    las = laspy.read(io.BytesIO(data))
    return key, np.asarray(las.x), np.asarray(las.y), np.asarray(las.z, np.float64), np.asarray(las.classification)


done = 0
t0 = time.time()
with cf.ThreadPoolExecutor(12) as ex:
    for key, x, y, z, cls in ex.map(fetch, sorted(nodes)):
        keep = (cls != 7) & (cls != 18)
        x, y, z, cls = x[keep], y[keep], z[keep], cls[keep]
        lo, la = m3857_to_lonlat(x, y)
        # Grid coordinates are the tangent-plane position of (lat, lon) lifted to the origin
        # height (see common.grid_xy); rasters store WGS84 ellipsoidal heights (lidar Z is
        # NAVD88 orthometric).
        e, n = grid_xy(lo, la)
        u = z + MSL_TO_ELLIPSOID
        ci = np.floor(e - E_MIN).astype(np.int64)
        ri = np.floor(n - N_MIN).astype(np.int64)
        ok = (ci >= 0) & (ci < W) & (ri >= 0) & (ri < H)
        ci, ri, u, cls = ci[ok], ri[ok], u[ok].astype(np.float32), cls[ok]
        idx = ri * W + ci
        np.maximum.at(first.ravel(), idx[cls != 9], u[cls != 9])
        np.add.at(count.ravel(), idx, 1)
        g = cls == 2
        np.minimum.at(ground.ravel(), idx[g], u[g])
        np.add.at(gcount.ravel(), idx[g], 1)
        building.ravel()[idx[cls == 6]] = 1
        water.ravel()[idx[cls == 9]] = 1
        done += 1
        if done % 200 == 0:
            print(f"  {done}/{len(nodes)} nodes, {time.time() - t0:.0f}s", flush=True)

print(f"rasterised in {time.time() - t0:.0f}s; cells with returns {np.mean(count > 0):.3f}, ground {np.mean(gcount > 0):.3f}")
np.save(WORK / "lidar_first.npy", first)
np.save(WORK / "lidar_ground.npy", ground)
np.save(WORK / "lidar_count.npy", count)
np.save(WORK / "lidar_building.npy", building)
np.save(WORK / "lidar_water.npy", water)
