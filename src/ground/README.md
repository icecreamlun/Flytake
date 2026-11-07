# Ground cover (src/ground)

Streamed 3D scatter on top of the lidar terrain of Emerald Bay: granite boulders and stones,
waterline pebbles, dry grass and sedge tufts, manzanita / huckleberry-oak mounds, fallen logs,
driftwood and stumps. Mounted by `src/world/World.tsx` (`<Ground frame={SCENE_FRAME} />`);
`?ground=0` turns it off (A/B, perf). Debug handle: `window.__flytakeGround.system.stats`.

**Re-run `ground_classes.py` whenever `terrain.npy` changes** (island rebuild, re-bake): the
tiles carry their own copy of the terrain heights so the props sit on the mesh.

## Data (tools/scene)

```sh
python -I ground_assets.py <download_dir>   # Poly Haven scans (gltf 1k) -> public/scene/ground/props + public/textures/ground2 (needs pymeshlab, trimesh)
python ground_osm.py                        # OSM roads / paths / buildings (exclusion), cached in WORK
python ground_classes.py                    # per terrain tile: heights + cover densities
python ground_classes.py --probe            # print the cover layers at a few known places
python ground_classes.py --preview out.png  # colour map of the layers (4 m)
```

`public/scene/ground/tiles/<i>_<j>.bin` (gzip, ~19 MB total) covers one finest-level terrain
tile (250 m x 240.6 m) on the same 129 x 129 vertex grid the RTIN mesh was built from, so props
sit on the mesh within its 0.15 m simplification error. Cover planes (every other vertex, 16
levels): rock, grass, shrub, debris, pebble, canopy cover, summer NDVI. They come from the 1 m
terrain (height above the lake, slope, distance to the water), the lidar canopy height model
(trees > 2.5 m, shrubs 0.3-2.5 m), NAIP 2022 (NDVI, brightness: sand / bare granite), OSM
(no rocks or logs on Highway 89, roads, trails and buildings) and the lidar water class (Cascade
Lake, Granite Lake and ponds are flat, hydro-flattened surfaces: nothing grows on them).

## Runtime

- `tiles.ts` loads tiles on demand (DecompressionStream) and samples heights / densities.
- `scatter.ts` + `catalog.ts`: deterministic jittered-grid scatter per 32 m chunk and category
  (seeded by the chunk index, so the same rock is always in the same place).
- `system.ts`: chunks within each category's radius are generated nearest first (2 ms budget
  per frame); instances are sorted into LOD buckets (one instanced draw per LOD and variant)
  when the camera moved 1.5-4 m (one category per frame, ~0.3 ms average CPU while flying).
  LODs cross-fade with complementary dither in the shader; big rocks use a size-scaled
  distance (clamped 0.5-2.5x) so they stay longer.
- `materials.ts`: pre-lit output (see world/light.ts) with the live sun and the GPU shadow
  field (`flySunVis`); before the shadow field is on, the per-instance canopy cover shades
  props under the trees. Grass sways in gusts; shrubs move slightly.

| category | radius | LODs (effective m) |
| --- | --- | --- |
| boulders 0.45-3.8 m | 340 m | scan 2k tris < 16, 300 tris < 50, 60 tris < 270 (distance / size) |
| stones 0.12-0.6 m | 95 m | 300 tris < 16, 60 tris < 90 |
| pebbles 4-24 cm | 48 m | 60 tris |
| grass / sedge tufts | 80 m | 16 blades < 16 m, 6 blades < 75 m (thinned to 35 % with distance) |
| shrubs | 300 m | 70 leaf cards < 45, 16 cards < 280 (distance / size) |
| logs, driftwood, stumps | 220 m | scan < 28, low < 160 (distance / size) |

Typical load: 0.6-1.6 M triangles, 30-40 draws (`stats.tris`, `stats.byCat` in thousands).

## Credits

3D scans by Poly Haven (CC0): namaqualand_boulder_03, namaqualand_boulder_04,
namaqualand_boulder_05, stone_01, moon_rock_02, dead_tree_trunk, dead_tree_trunk_02,
tree_stump_01 (https://polyhaven.com). Road / building outlines
© OpenStreetMap contributors (ODbL), used only to keep props off them. Grass tufts, shrubs and
the leaf atlas are procedural.
