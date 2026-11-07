"""Lake shading data for the water shader (public/textures/water/lake.png).

2 m grid over the scene extent (row 0 = south, same cells as tools/scene), RGBA uint8:
  R  sqrt(depth / 80 m)         estimated water depth (no bathymetry: from the distance to the
                                shore and the slope of the land at the shore)
  G  sqrt(shore distance / 64 m) distance to the nearest shore
  B  bottom brightness near the shore (the land albedo at the nearest shore point, carried
     under water: sandy beaches give bright turquoise shallows, granite / forest shores dark)
  A  lake coverage of the cell (the shader's water mask: the coarse terrain tiles' slivers
     along the shore are above the lake level, so the mesh height alone cannot decide)
Usage: python make_lake.py   (needs the tools/scene work rasters: lake, terrain, bake)
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scene"))
from common import OUT, WORK  # noqa: E402

DST = OUT.parent / "textures" / "water" / "lake.png"


def main() -> None:
    lake = np.load(WORK / "lake.npy").astype(bool)
    terrain = np.load(WORK / "terrain.npy")
    H, W = lake.shape
    land = ~lake
    dist, (ri, ci) = ndi.distance_transform_edt(lake, return_indices=True)

    # land slope just above the shore
    g = ndi.gaussian_filter(terrain, 2.0)
    gy, gx = np.gradient(g)
    slope = np.hypot(gx, gy).astype(np.float32)
    near_shore = land & (ndi.distance_transform_edt(land) < 10)
    num = ndi.gaussian_filter(np.where(near_shore, slope, 0).astype(np.float32), 6)
    den = ndi.gaussian_filter(near_shore.astype(np.float32), 6)
    shore_slope = num / np.maximum(den, 1e-3)
    s = np.clip(shore_slope[ri, ci], 0.05, 1.5)
    island = np.load(WORK / "island.npy").astype(bool)
    near_island = ndi.binary_dilation(island, iterations=60)
    s = np.where(near_island, np.maximum(s, 0.45), s)
    sm = ndi.gaussian_filter(lake.astype(np.float32), 12)
    s = ndi.gaussian_filter(np.where(lake, s, 0).astype(np.float32), 12) / np.maximum(sm, 1e-3)
    # underwater the bed keeps falling a little steeper than the land (wave-cut shelf)
    depth = dist * np.maximum(s * 1.1, 0.085) + (dist / 40.0) ** 2
    depth = np.where(lake, depth, 0).astype(np.float32)

    # bottom brightness from the land albedo at the shore (bake.npy is 0.5 m RGBA, AO in RGB)
    bake = np.load(WORK / "bake.npy", mmap_mode="r")
    lum = np.zeros((H, W), np.float32)
    for r0 in range(0, H, 512):
        r1 = min(H, r0 + 512)
        blk = np.asarray(bake[2 * r0:2 * r1, :, :3], np.float32) / 255.0
        blk = blk.reshape(r1 - r0, 2, W, 2, 3).mean(axis=(1, 3))
        lin = np.where(blk <= 0.04045, blk / 12.92, ((blk + 0.055) / 1.055) ** 2.4)
        lum[r0:r1] = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    # land just behind the waterline (1-5 m), smoothed along the shore
    band = land & (ndi.distance_transform_edt(land) <= 5)
    num = ndi.gaussian_filter(np.where(band, lum, 0), 4)
    den = ndi.gaussian_filter(band.astype(np.float32), 4)
    shore_lum = num / np.maximum(den, 1e-3)
    # nearest-shore lookups jump between shore points (radial streaks): smooth under water
    lk = lake.astype(np.float32)
    under = ndi.gaussian_filter(np.where(lake, shore_lum[ri, ci], 0).astype(np.float32), 8)
    under /= np.maximum(ndi.gaussian_filter(lk, 8), 1e-3)
    bottom = np.where(lake, under, shore_lum)

    def down(a: np.ndarray) -> np.ndarray:
        return a[: H // 2 * 2, : W // 2 * 2].reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))

    d2 = down(depth)
    s2 = down(np.where(lake, dist, 0).astype(np.float32))
    b2 = down(bottom.astype(np.float32))
    a2 = down(lake.astype(np.float32))
    rgb = np.stack([
        np.sqrt(np.clip(d2 / 80.0, 0, 1)),
        np.sqrt(np.clip(s2 / 64.0, 0, 1)),
        np.clip(b2 / 0.5, 0, 1),
        a2,
    ], -1)
    img = np.round(rgb * 255).astype(np.uint8)
    DST.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img, "RGBA").save(DST, optimize=True)
    print(f"{DST.name}: {img.shape[1]}x{img.shape[0]}, {DST.stat().st_size / 1e6:.1f} MB; depth p10/50/90 "
          f"{np.percentile(depth[lake], [10, 50, 90]).round(1)} m, shallow(<2 m) {float((depth[lake] < 2).mean()):.3f}, "
          f"bottom lum p10/50/90 {np.percentile(bottom[lake & (dist < 20)], [10, 50, 90]).round(3)}")
    # preview
    prev = Image.fromarray(img).resize((W // 8, H // 8)).transpose(Image.FLIP_TOP_BOTTOM)
    prev.save(Path("/tmp") / "lake_preview.png") if False else None


if __name__ == "__main__":
    main()
