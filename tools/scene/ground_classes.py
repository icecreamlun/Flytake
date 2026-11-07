"""Ground-cover placement data: per level-5 terrain tile, heights + cover densities.

Usage: python -I ground_classes.py [--probe]

Inputs (../Flytake-data/work): terrain.npy, lake.npy, chm.npy, naip.npy, lake_level.txt.
Output: public/scene/ground/tiles/<i>_<j>.bin (gzip) + public/scene/ground/index.json

Each file covers one finest-level terrain tile (build_tiles.py level 5: 250 m x 240.6 m) on its
own 129 x 129 vertex grid, so heights interpolate like the terrain mesh does (the mesh is an
RTIN simplification of exactly these samples, max error 0.15 m). Layout after gunzip
(row 0 = south, column 0 = west):
  f32 hMin (raster height = ellipsoidal - H0 of the lowest sample), f32 hStep (m)
  i16 dh[129 * 129]: height in hStep units above hMin, delta-coded (row starts against the
      previous row start, the rest against the left neighbour)
  u8 planes[7][65 * 65] cover densities 0..15 on every other vertex, in this order:
    rock    boulders / rocks
    u8  grass   grass + sedge tufts
    u8  shrub   manzanita / huckleberry oak mounds
    u8  debris  fallen logs, stumps, branches (forest floor)
    u8  pebble  waterline pebbles
    u8  canopy  canopy cover overhead (sun fallback until the live shadow field is on)
    u8  green   summer NDVI 0..1 (colour variation of grass / shrubs)
  (relative densities; the runtime scales them per category).
"""
from __future__ import annotations

import gzip
import json
import struct
import sys

import numpy as np
from scipy import ndimage as ndi

from common import E_MAX, E_MIN, H0, N_MAX, N_MIN, OUT, WORK, grid_xy

LEVEL = 5
GRID = 129
CGRID = 65  # cover densities: every other vertex (~3.9 m)
H_STEP = 0.02
DEST = OUT / "ground" / "tiles"


def smooth(a, s):
    return ndi.gaussian_filter(a.astype(np.float32), s)


def ramp(x, a, b):
    return np.clip((x - a) / (b - a), 0.0, 1.0).astype(np.float32)


def layers():
    terrain = np.load(WORK / "terrain.npy")
    lake = np.load(WORK / "lake.npy").astype(bool)
    chm = np.nan_to_num(np.load(WORK / "chm.npy"), nan=0.0)
    lake_h = float((WORK / "lake_level.txt").read_text())
    H, W = terrain.shape
    print("rasters", terrain.shape)

    # NAIP 0.5 m -> 1 m (RGB + NIR), in strips
    naip = np.load(WORK / "naip.npy", mmap_mode="r")
    rgbn = np.zeros((H, W, 4), np.float32)
    for r0 in range(0, H, 512):
        r1 = min(H, r0 + 512)
        blk = np.asarray(naip[2 * r0:2 * r1], np.float32)
        rgbn[r0:r1] = blk.reshape(r1 - r0, 2, W, 2, 4).mean(axis=(1, 3)) / 255.0
    ndvi = (rgbn[..., 3] - rgbn[..., 0]) / (rgbn[..., 3] + rgbn[..., 0] + 1e-3)
    bright = rgbn[..., :3].mean(-1)
    del rgbn

    hl = terrain - lake_h
    g = smooth(terrain, 1.0)
    gy, gx = np.gradient(g)
    slope = np.hypot(gx, gy)  # tan of the slope angle
    del g, gx, gy
    # other lakes (Cascade Lake, Granite Lake, ponds): flat surfaces with lidar water returns,
    # the hydro-flattened DEM is perfectly level there
    lw = ndi.binary_closing(np.load(WORK / "lidar_water.npy") > 0, iterations=3)
    lab, n = ndi.label(lw & ~lake)
    size = ndi.sum(np.ones(lab.shape, np.float32), lab, np.arange(1, n + 1))
    flat = ndi.maximum_filter(terrain, 5) - ndi.minimum_filter(terrain, 5) < 0.05
    flat_frac = ndi.mean(flat.astype(np.float32), lab, np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1:] = (size > 3000) & (flat_frac > 0.6)
    ponds = ndi.binary_fill_holes(keep[lab]) & flat
    ponds = ndi.binary_opening(ponds, iterations=2)
    print(f"other water bodies: {int(keep.sum())} ({ponds.sum() / 1e6:.2f} km2)")
    water = lake | ponds
    land = ~water
    dist_water = ndi.distance_transform_edt(land).astype(np.float32)
    canopy = chm > 2.5
    cover = smooth(canopy, 3.0)
    dist_canopy = ndi.distance_transform_edt(~canopy).astype(np.float32)
    shrubby = smooth((chm > 0.3) & (chm < 2.5) & (ndvi > 0.02), 1.5)
    ndvi_s = smooth(ndvi, 1.5)
    bright_s = smooth(bright, 1.5)

    sand = (
        ramp(-hl, -5.0, -2.0)  # hl < ~3 m
        * ramp(-dist_water, -70.0, -40.0)
        * ramp(-slope, -0.3, -0.18)
        * ramp(bright_s, 0.28, 0.36)
        * ramp(-ndvi_s, -0.12, -0.04)
        * ramp(-cover, -0.35, -0.15)
    )
    open_ = 1.0 - ramp(cover, 0.25, 0.7)
    steep = ramp(slope, 0.35, 0.9)
    bare = ramp(bright_s, 0.25, 0.4) * ramp(-ndvi_s, -0.08, 0.0) * open_

    shore = ramp(-dist_water, -16.0, -4.0)
    rock = np.maximum.reduce([
        0.85 * shore * (1.0 - sand),
        steep * open_ * 0.9,
        bare * (1.0 - sand) * 0.7,
        np.full_like(slope, 0.07),
    ]) * (1.0 - 0.9 * sand)
    # meadows: green, open, gentle; sparse tufts in open forest; sedge at the back of beaches
    meadow = ramp(ndvi_s, 0.12, 0.3) * ramp(-(chm), -0.6, -0.25) * ramp(-slope, -0.7, -0.4)
    grass = np.maximum.reduce([
        meadow,
        0.28 * open_ * ramp(-slope, -0.8, -0.5) * (1.0 - sand),
        0.22 * sand * ramp(hl, 1.2, 2.5),
        np.full_like(slope, 0.05) * (1.0 - sand),
    ]) * (1.0 - 0.6 * steep)
    shrub = np.maximum(ramp(shrubby, 0.08, 0.45), 0.25 * open_ * ramp(ndvi_s, 0.05, 0.2) * (1.0 - sand)) * (1.0 - sand)
    debris = (0.25 + 0.75 * cover) * ramp(-dist_canopy, -12.0, -1.0) * (1.0 - sand)
    pebble = ramp(-dist_water, -9.0, -1.0) * (0.4 + 0.6 * (1.0 - sand)) + 0.15 * sand * ramp(-dist_water, -18.0, -6.0)

    out = {
        "hl": hl, "rock": rock, "grass": grass, "shrub": shrub, "debris": debris, "pebble": pebble,
        "canopy": cover, "green": np.clip(ndvi_s * 2.5, 0, 1), "land": land.astype(np.float32),
        "sand": sand, "slope": slope, "bright": bright_s, "ndvi": ndvi_s, "dist_water": dist_water,
    }
    ko = keepout(terrain.shape)
    ko_soft = np.clip(smooth(ko, 1.5) * 1.6, 0, 1)
    out["keepout"] = ko_soft
    for k in ("rock", "shrub", "debris", "pebble"):
        out[k] = out[k] * (1.0 - ko_soft)
    out["grass"] = out["grass"] * (1.0 - 0.85 * ko)
    for k in ("rock", "grass", "shrub", "debris", "pebble"):
        out[k] = (out[k] * land).astype(np.float32)
    return terrain, out


ROAD_WIDTH = {"primary": 11.0, "secondary": 9.0, "tertiary": 8.0, "residential": 6.0, "service": 5.0,
              "unclassified": 6.0, "track": 4.0, "path": 2.2, "footway": 2.2, "cycleway": 2.5, "steps": 2.5}


def keepout(shape):
    """1 on OSM roads / paths / buildings / parking (cached by ground_osm.py), 0 elsewhere."""
    from PIL import Image, ImageDraw

    cache = WORK / "osm_ground.json"
    if not cache.exists():
        print("no OSM cache (run ground_osm.py): no road / building exclusion")
        return np.zeros(shape, np.float32)
    data = json.loads(cache.read_text())
    H, W = shape
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    for el in data["elements"]:
        geom = el.get("geometry")
        if not geom:
            continue
        lon = np.array([g["lon"] for g in geom])
        lat = np.array([g["lat"] for g in geom])
        x, y = grid_xy(lon, lat)
        pts = list(zip((x - E_MIN).tolist(), (y - N_MIN).tolist()))
        t = el.get("tags", {})
        if "building" in t or t.get("amenity") == "parking":
            if len(pts) >= 3:
                d.polygon(pts, fill=255, outline=255, width=3)
        elif t.get("highway") in ROAD_WIDTH:
            d.line(pts, fill=255, width=max(1, int(round(ROAD_WIDTH[t["highway"]]))), joint="curve")
    return np.asarray(img, np.float32) / 255.0


def sample(a, xs, ys):
    col = (xs - E_MIN) - 0.5
    row = (ys - N_MIN) - 0.5
    return ndi.map_coordinates(a, [row, col], order=1, mode="nearest")


def probe(terrain, L):
    pts = {
        "launch sand": (-120.106518, 38.95312),
        "vikingsholm": (-120.1088, 38.9535),
        "fannette": (-120.1004, 38.95416),
        "north shore": (-120.1000, 38.9585),
        "forest S": (-120.1060, 38.9480),
        "eagle falls": (-120.1135, 38.9530),
    }
    for name, (lon, lat) in pts.items():
        x, y = grid_xy(lon, lat)
        vals = {k: float(sample(v, np.array([x]), np.array([y]))[0]) for k, v in L.items()}
        print(f"{name:12s}", " ".join(f"{k}={v:.2f}" for k, v in vals.items()))


def main():
    terrain, L = layers()
    if "--probe" in sys.argv:
        probe(terrain, L)
        return
    if len(sys.argv) > 2 and sys.argv[1] == "--preview":
        from PIL import Image
        f = 4
        def ds(a):
            h, w = (a.shape[0] // f) * f, (a.shape[1] // f) * f
            return a[:h, :w].reshape(h // f, f, w // f, f).mean(axis=(1, 3))
        land = ds(L["land"])
        rgb = np.stack([ds(L["rock"]), ds(L["grass"]), ds(L["shrub"])], -1)
        rgb = rgb * 0.85 + ds(L["debris"])[..., None] * np.array([0.35, 0.2, 0.0])
        rgb = np.where(land[..., None] > 0.5, rgb, np.array([0.05, 0.1, 0.3]))
        rgb += ds(L["sand"])[..., None] * np.array([0.6, 0.55, 0.3])
        rgb += ds(L["pebble"])[..., None] * np.array([1.0, 1.0, 1.0])
        rgb = np.where(ds(L["keepout"])[..., None] > 0.5, np.array([1.0, 1.0, 0.0]), rgb)
        Image.fromarray((np.clip(rgb[::-1], 0, 1) * 255).astype(np.uint8)).save(sys.argv[2])
        return
    DEST.mkdir(parents=True, exist_ok=True)
    n = 2 ** LEVEL
    se = (E_MAX - E_MIN) / n
    sn = (N_MAX - N_MIN) / n
    keys = ["rock", "grass", "shrub", "debris", "pebble", "canopy", "green"]
    index = []
    total = 0
    for j in range(n):
        for i in range(n):
            e0, n0 = E_MIN + i * se, N_MIN + j * sn
            gx = e0 + np.linspace(0, se, GRID)
            gy = n0 + np.linspace(0, sn, GRID)
            X, Y = np.meshgrid(gx, gy)
            xs, ys = X.ravel(), Y.ravel()
            land = sample(L["land"], xs, ys)
            if land.max() < 0.5:
                continue
            h = sample(terrain, xs, ys).reshape(GRID, GRID) - H0  # raster convention: ellipsoidal - H0
            hmin = float(h.min())
            q = np.round((h - hmin) / H_STEP).astype(np.int32)
            dq = np.empty_like(q)
            dq[:, 1:] = q[:, 1:] - q[:, :-1]
            dq[0, 0] = q[0, 0]
            dq[1:, 0] = q[1:, 0] - q[:-1, 0]
            assert np.abs(dq).max() < 32768
            cx = e0 + np.linspace(0, se, CGRID)
            cy = n0 + np.linspace(0, sn, CGRID)
            CX, CY = np.meshgrid(cx, cy)
            planes = [np.clip(np.round(sample(L[k], CX.ravel(), CY.ravel()) * 15), 0, 15).astype(np.uint8) for k in keys]
            payload = struct.pack("<ff", hmin, H_STEP) + dq.astype("<i2").tobytes() + np.concatenate(planes).tobytes()
            data = gzip.compress(payload, 9)
            (DEST / f"{i}_{j}.bin").write_bytes(data)
            index.append([i, j])
            total += len(data)
    meta = {
        "level": LEVEL, "grid": GRID, "tiles": n, "extent": [E_MIN, E_MAX, N_MIN, N_MAX],
        "tileSize": [se, sn], "coverGrid": CGRID, "heightStep": H_STEP, "fields": keys, "present": index,
    }
    (OUT / "ground" / "index.json").write_text(json.dumps(meta))
    print(f"{len(index)} tiles, {total / 2**20:.1f} MB")


if __name__ == "__main__":
    main()
