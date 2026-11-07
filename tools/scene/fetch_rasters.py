"""Resample the USGS 3DEP 1 m bare-earth DEM and NAIP 2022 0.6 m imagery (RGB + NIR) onto the
scene grid (see common.grid_xy).

Outputs (WORK/):
  dem.npy   float32 [H, W] at 1 m, WGS84 ellipsoidal metres
  naip.npy  uint8   [H2, W2, 4] at 0.5 m (R, G, B, NIR)
"""
from __future__ import annotations

import json
import sys
import urllib.request

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from scipy.ndimage import map_coordinates

from common import E_MAX, E_MIN, MSL_TO_ELLIPSOID, N_MAX, N_MIN, RAW, WORK, enu_to_lonlat, lonlat_to_utm

DEM_TILES = [RAW / "USGS_1M_10_x74y432.tif", RAW / "USGS_1M_10_x75y432.tif"]
NAIP_IDS = [
    "ca_m_3812007_ne_10_060_20220721",
    "ca_m_3812007_se_10_060_20220721",
    "ca_m_3812008_nw_10_060_20220721",
    "ca_m_3812008_sw_10_060_20220721",
    "ca_m_3812008_ne_10_060_20220721",
    "ca_m_3812008_se_10_060_20220721",
]
COARSE = 16


def utm_grid(step: float):
    """UTM 10N coordinates of every cell centre of the scene grid at `step` metres, computed
    exactly on a coarse lattice and interpolated (the mapping is smooth to < 1 mm)."""
    w = int(round((E_MAX - E_MIN) / step))
    h = int(round((N_MAX - N_MIN) / step))
    cs = COARSE * step
    ce = np.arange(E_MIN, E_MAX + cs + 1e-6, cs)
    cn = np.arange(N_MIN, N_MAX + cs + 1e-6, cs)
    CE, CN = np.meshgrid(ce, cn)
    lon, lat = enu_to_lonlat(CE, CN)
    ux, uy = lonlat_to_utm(lon, lat)
    ux, uy = np.asarray(ux), np.asarray(uy)
    # fractional coarse index of each fine cell centre
    fe = ((np.arange(w) + 0.5) * step) / cs
    fn = ((np.arange(h) + 0.5) * step) / cs
    FE, FN = np.meshgrid(fe, fn)
    X = map_coordinates(ux, [FN.ravel(), FE.ravel()], order=1).reshape(h, w)
    Y = map_coordinates(uy, [FN.ravel(), FE.ravel()], order=1).reshape(h, w)
    return X, Y


def sample(path_or_url: str, X: np.ndarray, Y: np.ndarray, out: np.ndarray, bands, order: int):
    with rasterio.open(path_or_url) as src:
        pad = 4 * abs(src.transform.a)
        left, right = max(X.min() - pad, src.bounds.left), min(X.max() + pad, src.bounds.right)
        bottom, top = max(Y.min() - pad, src.bounds.bottom), min(Y.max() + pad, src.bounds.top)
        if left >= right or bottom >= top:
            return 0
        win = from_bounds(left, bottom, right, top, src.transform).round_offsets().round_lengths()
        data = src.read(bands, window=win)
        t = src.window_transform(win)
        nodata = src.nodata
    col = (X - t.c) / t.a - 0.5
    row = (Y - t.f) / t.e - 0.5
    inside = (col >= 0) & (col <= data.shape[2] - 1) & (row >= 0) & (row <= data.shape[1] - 1)
    if nodata is not None and data.dtype.kind == "f":
        valid = data[0] != nodata
    else:
        valid = None
    rr, cc = row[inside], col[inside]
    if valid is not None:
        ok = map_coordinates(valid.astype(np.float32), [rr, cc], order=1) > 0.999
        idx = np.flatnonzero(inside)[ok]
        rr, cc = rr[ok], cc[ok]
    else:
        idx = np.flatnonzero(inside)
    for bi in range(len(bands)):
        v = map_coordinates(data[bi].astype(np.float32), [rr, cc], order=order)
        if out.ndim == 2:
            out.reshape(-1)[idx] = v
        else:
            # (out[..., bi].ravel() would be a copy: write through a 2-D view instead)
            out.reshape(-1, out.shape[-1])[idx, bi] = np.clip(np.round(v), 0, 255)
    return idx.size


def build_dem():
    X, Y = utm_grid(1.0)
    dem = np.full(X.shape, np.nan, np.float32)
    for p in DEM_TILES:
        n = sample(str(p), X, Y, dem, [1], order=1)
        print(f"  {p.name}: {n} cells")
    missing = np.isnan(dem).mean()
    print(f"dem missing fraction {missing:.5f}")
    dem += MSL_TO_ELLIPSOID
    np.save(WORK / "dem.npy", dem)


def build_naip():
    tok = json.load(urllib.request.urlopen("https://planetarycomputer.microsoft.com/api/sas/v1/token/naipeuwest/naip"))["token"]
    X, Y = utm_grid(0.5)
    out = np.zeros(X.shape + (4,), np.uint8)
    for item_id in NAIP_IDS:
        item = json.load(urllib.request.urlopen(f"https://planetarycomputer.microsoft.com/api/stac/v1/collections/naip/items/{item_id}"))
        href = item["assets"]["image"]["href"]
        n = sample(str(RAW / "naip" / f"{item_id}.tif"), X, Y, out, [1, 2, 3, 4], order=1)
        print(f"  {item_id}: {n} px", flush=True)
    print("naip empty fraction", float((out[..., :3].sum(-1) == 0).mean()))
    np.save(WORK / "naip.npy", out)


if __name__ == "__main__":
    what = sys.argv[1:] or ["dem", "naip"]
    if "dem" in what:
        build_dem()
    if "naip" in what:
        build_naip()
