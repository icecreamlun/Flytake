# Emerald Bay scene build

Builds the custom, game-style Emerald Bay scene that replaces Google's photogrammetry inside an
8 km x 7.7 km box around the bay (ENU frame of `EMERALD_BAY_ORIGIN`, east -4000..4000 m,
north -3500..4200 m). Output goes to `public/scene/` (terrain 3D Tiles, `trees.bin`,
`scene.json`); raw and intermediate data go to `../Flytake-data/` (override with
`FLYTAKE_DATA`).

## Data (all public domain)

| what | source |
| --- | --- |
| bare-earth DEM, 1 m | USGS 3DEP `CA_SierraNevada_B22` (tiles `USGS_1M_10_x74y432`, `x75y432`) |
| lidar point cloud | USGS 3DEP `CA_SierraNevada_5_2022` (Entwine EPT on AWS `usgs-lidar-public`) |
| imagery, 0.6 m RGB + NIR | USDA NAIP 2022 California (Microsoft Planetary Computer) |

## Steps

```sh
uv venv geo --python 3.12 && source geo/bin/activate
uv pip install numpy scipy rasterio pyproj pillow "laspy[lazrs]" pymartini
cd tools/scene
# DEM tiles -> ../Flytake-data/raw (see fetch_rasters.DEM_TILES for the URLs)
python fetch_lidar.py 10        # EPT depth 10 (~4 pts/m^2): first-return / ground rasters
python fetch_naip_files.py      # parallel range downloads (GDAL /vsicurl/ is very slow here)
python fetch_rasters.py         # DEM 1 m + NAIP 0.5 m on the scene grid
python island_ground.py         # Fannette Island bare earth from the full-density point cloud
python analyse.py               # ground / DSM / canopy height / lake (+ Fannette Island), trees
python bake.py                  # albedo + sky occlusion, trees.bin, scene.json
python build_tiles.py           # 3D Tiles quadtree (6 levels, RTIN meshes, albedo + ENU normal/rockiness WebP)
python export_dtm.py            # public/scene/dtm.bin: 2 m ground heights for the live shadow field
python ground_classes.py        # ground-cover placement (src/ground); re-run whenever terrain.npy changes
```

Notes:
- Grid convention (`common.grid_xy`): raster cells are indexed by the tangent-plane east/north
  of (lat, lon) at the origin's ellipsoidal height and store WGS84 ellipsoidal heights. Mesh
  vertices and trees get exact ENU positions (Earth curvature included).
- The 3DEP DEM's hydro-flattening erased Fannette Island (and its returns carry no ground class);
  `island_ground.py` takes the lowest return per 0.5 m cell from the full-density EPT nodes and
  `analyse.surfaces` prefers it over the first-return opening.
- Lighting is live in the browser (time of day, GPU shadow field). `bake.SUN_TIME` only feeds
  the fallback per-tree visibility in trees.bin.
