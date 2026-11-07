"""Stage 3: bake terrain heights, albedo and static sun lighting; export the tree instances.

Outputs:
  WORK/terrain.npy  f32 1 m   heights for the terrain mesh (lake flat at its level)
  WORK/bake.npy     u8  0.5 m RGBA: RGB albedo (sRGB, AO folded in; lake = NAIP colour of the
                    water / bed), A = direct sun on the surface (N.L x cast shadow)
  WORK/water.npy    u8  1 m   lake mask used for the vertex water flag
  public/scene/trees.bin      (format: src/forest/README.md / forest data contract)
  public/scene/scene.json     sun, lake level, extents
"""
from __future__ import annotations

import json
import math
import struct
import sys
import time

import numpy as np
from scipy import ndimage as ndi

from common import E_MAX, E_MIN, N_MAX, N_MIN, OUT, WORK, enu_to_lonlat, lonlat_to_enu, sun_direction
from light import shadow_height, sun_visibility

SUN_TIME = "2026-11-07T23:00:00Z"  # 15:00 PST (keep in sync with ATMOSPHERE_DATE)


def srgb_to_lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055) * 255.0


def up2(a: np.ndarray) -> np.ndarray:
    """1 m -> 0.5 m (bilinear, cell-centre aligned)."""
    h, w = a.shape
    rows = (np.arange(2 * h) + 0.5) / 2 - 0.5
    cols = (np.arange(2 * w) + 0.5) / 2 - 0.5
    return ndi.map_coordinates(a.astype(np.float32), np.meshgrid(rows, cols, indexing="ij"), order=1, mode="nearest")


def main():
    t0 = time.time()
    ground = np.load(WORK / "ground.npy")
    dsm = np.load(WORK / "dsm.npy")
    chm = np.load(WORK / "chm.npy")
    lake = np.load(WORK / "lake.npy").astype(bool)
    lake_h = float((WORK / "lake_level.txt").read_text())
    sun, az, el = sun_direction(SUN_TIME)
    print(f"sun az {az:.1f} el {el:.1f}")

    terrain = np.where(lake, lake_h, ground).astype(np.float32)
    np.save(WORK / "terrain.npy", terrain)
    np.save(WORK / "water.npy", lake.astype(np.uint8))

    # --- direct sun on the ground (1 m) ---
    g = ndi.gaussian_filter(terrain, 0.8)
    gy, gx = np.gradient(g)  # d/drow (north), d/dcol (east)
    nrm = np.stack([-gx, -gy, np.ones_like(g)], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    ndl = np.clip(nrm @ sun.astype(np.float32), 0, 1)
    S = shadow_height(dsm, sun, 1.0)
    np.save(WORK / "shadow_height.npy", S)
    vis = sun_visibility(terrain + 0.25, S, soft=0.8)
    vis = ndi.gaussian_filter(vis, 0.7)  # penumbra
    direct = ndl * vis
    # flat water: N.L = sin(elevation); shadows on the water are softer (scattering, waves)
    vis_w = ndi.gaussian_filter(vis, 2.5)
    direct[lake] = vis_w[lake] * sun[2]
    print(f"lighting {time.time() - t0:.0f}s; ground lit {float(vis[~lake].mean()):.2f}")

    # --- sky occlusion (ambient), multi-scale canopy + terrain openness ---
    occ = np.zeros_like(terrain)
    for r, w in [(2, 0.35), (5, 0.35), (12, 0.3)]:
        m = ndi.uniform_filter(dsm, 2 * r + 1)
        occ += w * np.clip((m - terrain) / (1.5 * r), 0, 1)
    big = ndi.uniform_filter(terrain, 301)
    valley = np.clip((big - terrain) / 250.0, 0, 0.35)
    ao = np.clip(1 - 0.75 * occ - valley, 0.15, 1)
    ao[lake] = 1.0

    # --- water colour (1 m): synthesised from an estimated depth. The imagery's lake is a
    # patchwork of acquisitions (straight seams, glint, boat wakes), so only the geometry is
    # used: depth ~ distance from shore x the slope of the land at the nearest shore point. ---
    water_alb = water_colour(terrain, lake)

    # --- albedo from NAIP (0.5 m), processed in strips; wide filters run on downsampled grids ---
    naip = np.load(WORK / "naip.npy", mmap_mode="r")
    H2, W2 = naip.shape[:2]
    canopy = ndi.binary_dilation(chm > 2.0, iterations=1)
    LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)

    # regional colour of open ground (4 m blocks, ~20 m blur) for the forest floor tint, and
    # local luminance (2 m blocks, ~6 m blur) for the shadow lift
    F4, F2 = 8, 4
    sum4 = np.zeros((H2 // F4, W2 // F4, 3), np.float32)
    cnt4 = np.zeros((H2 // F4, W2 // F4), np.float32)
    lum2 = np.zeros((H2 // F2, W2 // F2), np.float32)
    STRIP = 1024
    for r0 in range(0, H2, STRIP):
        r1 = min(H2, r0 + STRIP)
        rgb = srgb_to_lin(np.asarray(naip[r0:r1, :, :3], np.float32))
        can = np.repeat(np.repeat(canopy[r0 // 2:(r1 + 1) // 2], 2, 0), 2, 1)[: r1 - r0, :W2]
        lk = np.repeat(np.repeat(lake[r0 // 2:(r1 + 1) // 2], 2, 0), 2, 1)[: r1 - r0, :W2]
        open_ = (~can & ~lk).astype(np.float32)
        h4 = (r1 - r0) // F4
        blk = lambda a, f: a[: (a.shape[0] // f) * f, : (a.shape[1] // f) * f].reshape(a.shape[0] // f, f, a.shape[1] // f, f, *a.shape[2:]).sum(axis=(1, 3))
        sum4[r0 // F4:r0 // F4 + h4] = blk(rgb * open_[..., None], F4)
        cnt4[r0 // F4:r0 // F4 + h4] = blk(open_, F4)
        lum2[r0 // F2:r0 // F2 + (r1 - r0) // F2] = blk(rgb @ LUMA, F2) / (F2 * F2)
    w4 = ndi.gaussian_filter(cnt4, 5)
    reg4 = np.stack([ndi.gaussian_filter(sum4[..., c], 5) for c in range(3)], -1) / np.maximum(w4, 1e-3)[..., None]
    have4 = np.clip(w4 / (F4 * F4) * 4, 0, 1)
    local2 = ndi.gaussian_filter(lum2, 3)

    def upsample(a, f, r0, r1):
        """bilinear upsample of a low-res grid (factor f) to 0.5 m rows r0:r1, all columns"""
        rows = (np.arange(r0, r1) + 0.5) / f - 0.5
        cols = (np.arange(W2) + 0.5) / f - 0.5
        R, C = np.meshgrid(rows, cols, indexing="ij")
        if a.ndim == 2:
            return ndi.map_coordinates(a, [R, C], order=1, mode="nearest")
        return np.stack([ndi.map_coordinates(a[..., k], [R, C], order=1, mode="nearest") for k in range(a.shape[-1])], -1)

    floor = np.array([0.075, 0.060, 0.042], np.float32)  # needle litter / duff, linear
    rng = np.random.default_rng(3)
    bake = np.zeros((H2, W2, 4), np.uint8)
    M = 8  # strip overlap for the small filters
    for r0 in range(0, H2, STRIP):
        r1 = min(H2, r0 + STRIP)
        a0, a1 = max(0, r0 - M), min(H2, r1 + M)
        rgb = srgb_to_lin(np.asarray(naip[a0:a1, :, :3], np.float32))
        can = np.repeat(np.repeat(canopy[a0 // 2:(a1 + 1) // 2], 2, 0), 2, 1)[(a0 % 2): (a0 % 2) + a1 - a0, :W2]
        lk = np.repeat(np.repeat(lake[a0 // 2:(a1 + 1) // 2], 2, 0), 2, 1)[(a0 % 2): (a0 % 2) + a1 - a0, :W2]
        reg = upsample(reg4, F4, a0, a1)
        have = upsample(have4, F4, a0, a1)[..., None]
        floor_col = floor * (1 - 0.5 * have) + 0.5 * have * np.minimum(reg, 0.25)
        noise = ndi.gaussian_filter(rng.standard_normal((a1 - a0, W2)).astype(np.float32), 2.0)
        noise = 1 + 0.25 * noise / (noise.std() + 1e-6)
        floor_col = floor_col * noise[..., None]
        soft = ndi.gaussian_filter(can.astype(np.float32), 1.0)[..., None]
        alb = rgb * (1 - soft) + floor_col * soft
        # NAIP is summer late-morning light with real shadows: lift dark open ground a little
        lum = alb @ LUMA
        local = upsample(local2, F2, a0, a1)
        dark = np.clip((0.6 * local - lum) / np.maximum(0.6 * local, 1e-4), 0, 1)
        alb = alb * (1 + 1.2 * dark * (~lk))[..., None]
        # the lake: synthesised water / bed colour (soft shoreline)
        wl = upsample(water_alb, 2, a0, a1)
        wk = ndi.gaussian_filter(lk.astype(np.float32), 1.2)[..., None]
        alb = alb * (1 - wk) + wl * wk
        sl = slice(r0 - a0, r0 - a0 + (r1 - r0))
        ao2 = upsample(ao, 2, r0, r1)
        # RGB = albedo (a touch of contact darkening), A = sky occlusion: the sun is live in the
        # browser (shadowField.ts), the ambient term uses A
        bake[r0:r1, :, :3] = lin_to_srgb(alb[sl] * (ao2 ** 0.25)[..., None]).astype(np.uint8)
        bake[r0:r1, :, 3] = np.clip(ao2 * 255 + 0.5, 0, 255).astype(np.uint8)
        print(f"  strip {r0}/{H2} {time.time() - t0:.0f}s", flush=True)
    np.save(WORK / "bake.npy", bake)
    print(f"bake {time.time() - t0:.0f}s")

    export_trees(S, sun, lake_h)
    meta = {
        "sunTime": SUN_TIME, "sunAzimuth": az, "sunElevation": el, "sunEnu": sun.tolist(),
        "lakeLevel": lake_h, "extent": {"east": [E_MIN, E_MAX], "north": [N_MIN, N_MAX]},
    }
    (OUT / "scene.json").write_text(json.dumps(meta, indent=2))
    print(f"done in {time.time() - t0:.0f}s")


def water_colour(terrain: np.ndarray, lake: np.ndarray) -> np.ndarray:
    """Linear albedo of the lake as seen from above (bed through clear water), [H, W, 3]."""
    from common import E_MIN, N_MIN, grid_xy

    land = ~lake
    dist, (ri, ci) = ndi.distance_transform_edt(lake, return_indices=True)
    # land slope just inside the shore (gentle beaches -> wide shallows, cliffs -> narrow)
    g = ndi.gaussian_filter(terrain, 2.0)
    gy, gx = np.gradient(g)
    slope = np.hypot(gx, gy)
    near_shore = land & (ndi.distance_transform_edt(land) < 12)
    num = ndi.gaussian_filter(np.where(near_shore, slope, 0).astype(np.float32), 8)
    den = ndi.gaussian_filter(near_shore.astype(np.float32), 8)
    shore_slope = num / np.maximum(den, 1e-3)
    s = np.clip(shore_slope[ri, ci], 0.04, 1.2)
    # the nearest-shore lookup jumps between shore points: smooth it over the lake (no rays)
    s = ndi.gaussian_filter(np.where(lake, s, 0).astype(np.float32), 18) / np.maximum(ndi.gaussian_filter(lake.astype(np.float32), 18), 1e-3)
    depth = dist * np.maximum(s, 0.08) * 0.9 + (dist / 45.0) ** 2
    # bay vs main lake deep colour (cf. WATER_UNIFORMS uDeepBay / uDeep)
    bx, by = grid_xy(-120.0925, 38.9585)
    H, W = terrain.shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    db = np.hypot(xx + E_MIN + 0.5 - float(bx), yy + N_MIN + 0.5 - float(by))
    k_bay = 1 - np.clip((db - 900) / 900, 0, 1)
    k_bay = k_bay * k_bay * (3 - 2 * k_bay)
    deep = (1 - k_bay)[..., None] * np.array([0.0030, 0.0165, 0.118], np.float32) + k_bay[..., None] * np.array([0.0035, 0.032, 0.070], np.float32)
    stops = [  # depth (m), colour (linear albedo)
        (0.0, np.array([0.150, 0.150, 0.115], np.float32)),
        (0.6, np.array([0.060, 0.150, 0.140], np.float32)),
        (2.5, np.array([0.024, 0.120, 0.125], np.float32)),
        (7.0, np.array([0.010, 0.070, 0.098], np.float32)),
        (16.0, None),
    ]
    out = np.zeros((H, W, 3), np.float32)
    d = depth[..., None]
    for (d0, c0), (d1, c1) in zip(stops[:-1], stops[1:]):
        c0a = c0 if c0 is not None else deep
        c1a = c1 if c1 is not None else deep
        t = np.clip((d - d0) / (d1 - d0), 0, 1)
        seg = (d >= d0) & (d < d1)
        out = np.where(seg, c0a * (1 - t) + c1a * t, out)
    out = np.where(d >= stops[-1][0], deep, out)
    # gentle large-scale variation (sediment, light) so open water is not uniform
    rng = np.random.default_rng(11)
    n = ndi.zoom(rng.standard_normal((H // 64 + 2, W // 64 + 2)).astype(np.float32), 64, order=3)[:H, :W]
    out *= (1 + 0.08 * n)[..., None]
    print(f"water: depth p50 {np.median(depth[lake]):.1f} m, shallows(<3 m) {float((depth[lake] < 3).mean()):.3f}")
    return np.where(lake[..., None], out, 0).astype(np.float32)


def export_trees(S: np.ndarray, sun: np.ndarray, lake_h: float):
    trees = np.load(WORK / "trees.npy")
    # sun visibility at the crown top and at the crown base (sampled just outside the crown on
    # the sun side, so a tree does not shadow itself)
    sx, sy = sun[0] / math.hypot(sun[0], sun[1]), sun[1] / math.hypot(sun[0], sun[1])
    tan_el = sun[2] / math.hypot(sun[0], sun[1])

    def s_at(x, y):
        return ndi.map_coordinates(S, [y - N_MIN - 0.5, x - E_MIN - 0.5], order=1, mode="nearest")

    top = trees["ground"] + trees["height"]
    base = trees["ground"] + trees["height"] * 0.35
    off = trees["radius"] + 1.0
    # moving toward the sun by `off` the shadow plane rises by off*tan_el, compare consistently
    s_top = s_at(trees["x"] + sx * 1.0, trees["y"] + sy * 1.0) - 1.0 * tan_el
    s_base = s_at(trees["x"] + sx * off, trees["y"] + sy * off) - off * tan_el
    vis_top = np.clip((top - 0.5 - s_top) / 3.0 + 0.5, 0, 1)
    vis_base = np.clip((base - s_base) / 3.0 + 0.5, 0, 1)

    lon, lat = enu_to_lonlat(trees["x"].astype(np.float64), trees["y"].astype(np.float64))
    e, n, u = lonlat_to_enu(lon, lat, trees["ground"].astype(np.float64))
    order = np.lexsort((np.floor((e - E_MIN) / 64), np.floor((n - N_MIN) / 64)))
    rec = np.zeros(len(trees), np.dtype([("e", "<f4"), ("n", "<f4"), ("u", "<f4"), ("h", "<f4"), ("r", "<f4"),
                                         ("species", "u1"), ("seed", "u1"), ("sunTop", "u1"), ("sunBase", "u1")]))
    rec["e"], rec["n"], rec["u"] = e, n, u
    rec["h"] = trees["height"]
    rec["r"] = trees["radius"]
    rec["species"] = trees["species"]
    rec["seed"] = trees["seed"]
    rec["sunTop"] = np.round(vis_top * 255)
    rec["sunBase"] = np.round(vis_base * 255)
    rec = rec[order]
    assert rec.dtype.itemsize == 24
    with open(OUT / "trees.bin", "wb") as f:
        f.write(b"FTRE" + struct.pack("<III", 1, len(rec), 24))
        f.write(rec.tobytes())
    print(f"trees.bin: {len(rec)} trees, sunTop mean {vis_top.mean():.2f}, sunBase mean {vis_base.mean():.2f}")


if __name__ == "__main__":
    main()
