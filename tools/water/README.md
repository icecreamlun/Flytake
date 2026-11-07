# Lake data for the water shader

Generated assets in `public/textures/water/` (re-run after changing the scene rasters):

```sh
source <venv with numpy scipy pillow>/bin/activate
python make_waves.py   # waves.bin / waves.json: 64-frame looping FFT wind-wave slopes (256^2, RG8)
python make_lake.py    # lake.png: depth / shore distance / bottom brightness / lake coverage, 2 m grid
```

`make_lake.py` reads the tools/scene work rasters (`lake.npy`, `terrain.npy`, `island.npy`,
`bake.npy` in `$FLYTAKE_DATA/work`). Depth is an estimate (distance to the shore x the slope of
the land at the shore); there is no bathymetry in the pipeline.

Shaders: `src/world/waterShading.ts` (lidar scene lake), `src/world/waterCommon.ts` (shared
waves / sky reflection / sun glints, also used by `src/scene/WaterSurface.tsx` and the Google
tile water in `src/scene/water.ts`), sky probe `src/world/waterSky.ts`.
