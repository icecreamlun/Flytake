"""Stage 2: derive surface / canopy / lake rasters and the tree list from DEM + lidar + NAIP.

Inputs  (WORK/): dem.npy (1 m), lidar_*.npy (1 m), naip.npy (0.5 m)
Outputs (WORK/): ground.npy  bare earth, gaps filled                     f32 1 m (ellipsoidal)
                 dsm.npy     first surface (canopy / buildings / ground)  f32 1 m
                 chm.npy     canopy height above ground                   f32 1 m
                 lake.npy    Lake Tahoe water mask                         u8  1 m
                 trees.npy   structured array of detected trees
"""
from __future__ import annotations

import time

import numpy as np
from scipy import ndimage as ndi

from common import E_MIN, H0, LAKE_ORTHO, MSL_TO_ELLIPSOID, N_MIN, WORK

LAKE_H = LAKE_ORTHO + MSL_TO_ELLIPSOID  # ellipsoidal height of the hydro-flattened lake


def fill_nan(a: np.ndarray) -> np.ndarray:
    bad = ~np.isfinite(a)
    if not bad.any():
        return a
    idx = ndi.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def surfaces():
    t = time.time()
    dem = np.load(WORK / "dem.npy")
    first = np.load(WORK / "lidar_first.npy")
    lground = np.load(WORK / "lidar_ground.npy")
    water = np.load(WORK / "lidar_water.npy")
    print("dem nan", float(np.isnan(dem).mean()), "first -inf", float(np.isinf(first).mean()))
    dem = np.where(np.isfinite(dem), dem, np.where(np.isfinite(lground), lground, np.nan)).astype(np.float32)
    ground = fill_nan(dem)

    # Lake: hydro-flattened DEM at lake level, connected to the big component (Tahoe itself).
    # The flattened level of this DEM is measured (mode of the near-lake heights).
    near = ground[np.abs(ground - LAKE_H) < 1.0]
    vals, counts = np.unique(np.round(near, 2), return_counts=True)
    lake_h = float(vals[np.argmax(counts)])
    print(f"lake level (ellipsoidal) {lake_h:.2f} m, nominal {LAKE_H:.2f}")
    (WORK / "lake_level.txt").write_text(f"{lake_h:.3f}\n")
    flat = np.abs(ground - lake_h) < 0.05
    lab, n = ndi.label(flat)
    sizes = ndi.sum(flat, lab, index=np.arange(1, n + 1))
    lake = lab == (1 + int(np.argmax(sizes)))
    lake |= (water > 0) & (np.abs(ground - lake_h) < 1.0)
    lake = ndi.binary_opening(lake, iterations=1)
    lab, n = ndi.label(lake)
    sizes = ndi.sum(lake, lab, index=np.arange(1, n + 1))
    lake = lab == (1 + int(np.argmax(sizes)))
    lake = ndi.binary_fill_holes(lake)

    # first surface: lidar max return; cells without returns get a 3x3 max, then the ground
    f = np.where(np.isfinite(first), first, np.nan)
    fm = ndi.maximum_filter(np.nan_to_num(f, nan=-1e9), size=3)
    f = np.where(np.isfinite(f), f, np.where(fm > -1e8, fm, np.nan))
    f = np.where(np.isfinite(f), f, ground)
    # remove single-cell noise spikes before using the returns as terrain
    fmed = ndi.median_filter(f, size=3)
    f = np.where(f - fmed > 6, fmed, f)

    # Islands: the DEM's hydro-flattening erased Fannette Island (its lidar returns are not
    # classified as ground). Rebuild land inside the flattened lake from the first returns:
    # blobs > 800 m^2 standing > 1 m out of the water (boats / buoys are smaller), with the
    # ground estimated as a morphological opening of the surface (removes the island's trees).
    up = lake & (f > lake_h + 1.0)
    up = ndi.binary_opening(up, iterations=2)
    lab, n = ndi.label(up)
    sizes = ndi.sum(up, lab, index=np.arange(1, n + 1))
    keep_ids = 1 + np.flatnonzero(sizes > 800)
    island = np.isin(lab, keep_ids)
    island = ndi.binary_closing(ndi.binary_fill_holes(island), iterations=3)
    if island.any():
        rows, cols = np.where(ndi.binary_dilation(island, iterations=40))
        r0, r1, c0, c1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
        sub = np.where(island[r0:r1, c0:c1], f[r0:r1, c0:c1], lake_h).astype(np.float32)
        g_est = ndi.grey_opening(sub, size=(11, 11))
        g_est = ndi.gaussian_filter(g_est, 2.0)
        g_est = np.minimum(g_est, sub)
        # preferred: the bare-earth surface from the full-density point cloud (island_ground.py)
        ig_path = WORK / "island_ground.npy"
        if ig_path.exists():
            ig = np.load(ig_path, mmap_mode="r")[r0:r1, c0:c1]
            isl = island[r0:r1, c0:c1]
            land = ndi.binary_dilation(isl, iterations=4) & np.isfinite(ig) & (np.nan_to_num(ig, nan=-1e9) > lake_h + 0.12)
            land = ndi.binary_opening(land, iterations=1)
            lab2, _ = ndi.label(land)
            ids = np.unique(lab2[isl & land])
            land = ndi.binary_fill_holes(np.isin(lab2, ids[ids > 0]))
            island[r0:r1, c0:c1] = land
            g_est = np.where(land, np.nan_to_num(np.asarray(ig), nan=lake_h), g_est).astype(np.float32)
            print(f"island ground from the point cloud: {int(land.sum())} m^2")
        # shoreline: blend down to the water over ~6 m around the island
        dist = ndi.distance_transform_edt(~island[r0:r1, c0:c1])
        shore = np.clip(1 - dist / 6.0, 0, 1)
        g_sub = np.where(island[r0:r1, c0:c1], g_est, lake_h + (np.maximum(g_est, lake_h) - lake_h) * shore - 0.5 * (1 - shore))
        ground[r0:r1, c0:c1] = np.where(island[r0:r1, c0:c1] | (shore > 0), g_sub, ground[r0:r1, c0:c1])
        for i in keep_ids:
            rr, cc = np.where(lab == i)
            print(f"island rebuilt: {len(rr)} m^2 at e={cc.mean() + E_MIN:.0f} n={rr.mean() + N_MIN:.0f}, top {f[rr, cc].max() - lake_h:.1f} m")
    lake &= ~island
    np.save(WORK / "island.npy", island.astype(np.uint8))
    print(f"lake fraction {lake.mean():.3f}")
    dsm = np.maximum(f, ground).astype(np.float32)
    dsm[lake] = lake_h
    chm = np.clip(dsm - ground, 0, 80).astype(np.float32)
    # isolated single-cell spikes (birds, wires, noise) -> median of the neighbourhood
    med = ndi.median_filter(chm, size=3)
    spike = (chm - med) > 6
    chm[spike] = med[spike]
    dsm = ground + chm
    np.save(WORK / "ground.npy", ground.astype(np.float32))
    np.save(WORK / "dsm.npy", dsm.astype(np.float32))
    np.save(WORK / "chm.npy", chm)
    np.save(WORK / "lake.npy", lake.astype(np.uint8))
    print(f"surfaces in {time.time() - t:.0f}s; canopy>2m {float((chm > 2).mean()):.3f}")


TREE_DTYPE = np.dtype([
    ("x", "f4"), ("y", "f4"),  # grid coordinates (common.grid_xy)
    ("ground", "f4"), ("height", "f4"), ("radius", "f4"),
    ("species", "u1"), ("seed", "u1"), ("ndvi", "f4"),
])


def detect_trees():
    """Variable-window local maxima on the smoothed canopy height model (Popescu & Wynne style),
    crown radius from the distance to the canopy edge / neighbours, species from crown shape,
    NAIP NDVI (snags) and context (lodgepole near water / meadows)."""
    t = time.time()
    chm = np.load(WORK / "chm.npy")
    ground = np.load(WORK / "ground.npy")
    lake = np.load(WORK / "lake.npy").astype(bool)
    naip = np.load(WORK / "naip.npy", mmap_mode="r")
    from common import E_MIN, N_MIN

    s = ndi.gaussian_filter(chm, 0.9)
    s[lake] = 0
    cand = s > 3.0
    # window radius grows with height: ~2 m for 5 m trees, ~4.5 m for 40 m trees
    peaks = np.zeros_like(cand)
    for r, lo, hi in [(1, 3, 7), (2, 7, 15), (3, 15, 28), (4, 28, 200)]:
        fp = np.hypot(*np.mgrid[-r:r + 1, -r:r + 1]) <= r + 0.01
        m = ndi.maximum_filter(s, footprint=fp)
        sel = cand & (s >= lo) & (s < hi) & (s >= m - 1e-4)
        peaks |= sel
    # plateaus produce several equal maxima: keep one per connected blob
    lab, n = ndi.label(peaks)
    pos = ndi.center_of_mass(peaks, lab, np.arange(1, n + 1))
    pos = np.array(pos, dtype=np.float64)
    r_i = np.clip(np.round(pos[:, 0]).astype(int), 0, chm.shape[0] - 1)
    c_i = np.clip(np.round(pos[:, 1]).astype(int), 0, chm.shape[1] - 1)
    h = chm[r_i, c_i]
    # refine: take the max of the raw CHM in a 3x3 around the peak (smoothing lowers tops)
    hm = ndi.maximum_filter(chm, size=3)[r_i, c_i]
    h = np.maximum(h, hm * 0.97)
    keep = h >= 3.0
    # no trees on roofs (lidar building class, dilated a little)
    bld = ndi.binary_dilation(np.load(WORK / "lidar_building.npy") > 0, iterations=2)
    keep &= ~bld[r_i, c_i]
    pos, r_i, c_i, h = pos[keep], r_i[keep], c_i[keep], h[keep]

    # crown radius: distance from the peak to where the canopy falls below 45% of its height,
    # capped by half the distance to the nearest taller neighbour
    from scipy.spatial import cKDTree

    tree_xy = np.stack([pos[:, 1], pos[:, 0]], 1)
    kd = cKDTree(tree_xy)
    d, _ = kd.query(tree_xy, k=2)
    nn = d[:, 1]
    radius = np.full(len(h), 0.0)
    angles = np.linspace(0, 2 * np.pi, 8, endpoint=False)
    for a in angles:
        dr, dc = np.sin(a), np.cos(a)
        reach = np.zeros(len(h))
        alive = np.ones(len(h), bool)
        for step in range(1, 11):
            rr = np.clip(np.round(r_i + dr * step).astype(int), 0, chm.shape[0] - 1)
            cc = np.clip(np.round(c_i + dc * step).astype(int), 0, chm.shape[1] - 1)
            inside = s[rr, cc] > 0.45 * h
            alive &= inside
            reach += alive
        radius += reach / len(angles)
    allo = np.clip(0.9 + 0.11 * h, 1.0, 7.0)  # Sierra mixed-conifer allometry (rough)
    radius = np.clip(0.5 * radius + 0.5 * allo, 0.8, 8.0)
    radius = np.minimum(radius, np.maximum(0.8, 0.75 * nn))

    # NDVI at the crown top from NAIP (0.5 m grid -> x2)
    rr2 = np.clip(r_i * 2, 0, naip.shape[0] - 1)
    cc2 = np.clip(c_i * 2, 0, naip.shape[1] - 1)
    px = np.asarray(naip[rr2, cc2], np.float32)
    red, nir = px[:, 0], px[:, 3]
    ndvi = (nir - red) / np.maximum(nir + red, 1)

    rng = np.random.default_rng(7)
    seed = rng.integers(0, 256, len(h)).astype(np.uint8)
    slender = radius / np.maximum(h, 1)
    species = np.where(slender < 0.13, 0, 1).astype(np.uint8)  # narrow spires: fir; broad: pine
    # firs dominate on the shaded north/east-facing slopes and in dense stands; keep a mix
    mix = rng.random(len(h))
    species = np.where((species == 1) & (mix < 0.30), 0, species)
    species = np.where((species == 0) & (mix > 0.85), 1, species)
    small = h < 12
    species = np.where(small & (mix < 0.5), 2, species)
    # near the shore / flats: lodgepole
    gx = ground[r_i, c_i]
    near_lake = gx < (LAKE_ORTHO + MSL_TO_ELLIPSOID + 8)
    species = np.where(near_lake & (mix < 0.5) & (h < 25), 2, species)
    # dead snags: grey crowns (no NIR response) on tall, narrow peaks
    snag = (ndvi < -0.02) & (h > 10) & (radius < 3.5)
    species = np.where(snag, 3, species)

    trees = np.zeros(len(h), TREE_DTYPE)
    trees["x"] = E_MIN + pos[:, 1] + 0.5
    trees["y"] = N_MIN + pos[:, 0] + 0.5
    trees["ground"] = gx
    trees["height"] = h
    trees["radius"] = radius
    trees["species"] = species
    trees["seed"] = seed
    trees["ndvi"] = ndvi
    np.save(WORK / "trees.npy", trees)
    area_ha = chm.size / 1e4
    print(f"{len(trees)} trees ({len(trees) / area_ha:.0f}/ha over the box) in {time.time() - t:.0f}s;"
          f" species counts {np.bincount(species, minlength=4)}; height p10/50/90"
          f" {np.percentile(h, [10, 50, 90]).round(1)}; radius p50 {np.median(radius):.1f}")


if __name__ == "__main__":
    import sys

    what = sys.argv[1:] or ["surfaces", "trees"]
    if "surfaces" in what:
        surfaces()
    if "trees" in what:
        detect_trees()
