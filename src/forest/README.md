# Forest renderer

Lidar-placed Sierra Nevada conifers (white / red fir, Jeffrey pine, lodgepole pine, snags) for
the custom Emerald Bay scene: procedural trees in two mesh LODs plus GPU-baked hemi-octahedral
impostors, instanced, ~0.2-0.5 ms of JS per frame.

## Use

```tsx
import { Forest } from './forest/Forest';
import { setForestSun, FOREST_LIGHT } from './forest/lighting';
import { forestRaycast, forestLoaded } from './forest/collide';
import { emeraldBayFrame } from './geo/locations';

const FRAME = emeraldBayFrame();           // ENU (Fannette Island, lake level) -> ECEF
<Forest url="/scene/trees.bin" frame={FRAME} />

setForestSun(sunDirectionEnu);             // unit vector towards the sun in the ENU frame (also sets uFlatSunInv
                                           // and scales uAmbient with the elevation like world/light.ts)
FOREST_LIGHT.uWind.value = 0.6             // 0 = still
FOREST_LIGHT.uForestDebug.value = 1        // look-dev: 1 sun visibility, 2 N.L, 3 AO, 4 albedo, 5 baked sun
// window.__forestRuntime = { system, data, light, gl } in the app for screenshot scripts

// drone collision (ENU metres; direction need not be unit): distance along the ray or null
if (forestLoaded()) forestRaycast(originEnu, dirEnu, 45);
```

- The group's matrix is `frame`; the camera may live in ECEF. Every frame the forest computes the
  camera position in the frame itself (float64 on the CPU), so nothing jitters.
- `forestRuntime.system` (from `Forest.tsx`) exposes `stats` (`lod0`, `lod1`, `impostorChunks`,
  `selectMs`) and `setLod({ lod0, lod0Fade, lod1, lod1Fade })` (effective metres, see below) to
  trade quality for speed on slower GPUs.
- All meshes have `raycast` disabled (GlobeControls never grabs a tree); use `forestRaycast`.
- Materials output **pre-lit albedo relative to the flat sun term**, i.e. what takram's
  AerialPerspective (`sunLight`, no normal buffer) multiplies by `sunIrradiance * dot(flatNormal, sun)`:
  `albedo * (sunVis * shade(N, L) + uAmbient * sky * ao) * uFlatSunInv`. They write alpha 1 and
  use alpha test only (no blending), so they work with the HalfFloat composer buffer and SMAA.

## Data: `trees.bin`

Little endian. Header 16 bytes: `char[4] 'FTRE'`, `u32 version = 1`, `u32 count`, `u32 stride (>= 24)`.
Record (24 bytes):

| bytes | type | field |
|---|---|---|
| 0-11 | f32 x3 | e, n, u: trunk base on the ground, ENU metres in the Emerald Bay frame |
| 12 | f32 | height (m, ground to top) |
| 16 | f32 | crown radius (m) |
| 20 | u8 | species: 0 fir, 1 Jeffrey pine, 2 lodgepole / young pine, 3 dead snag |
| 21 | u8 | seed (variant, rotation, tint) |
| 22 | u8 | sunTop: baked 15:00 sun visibility at the crown top (255 = lit); only used until the live shadow field is ready |
| 23 | u8 | sunBase: same at the crown base |

`parseTrees()` sorts the trees into 32 m cells grouped in 512 m chunks (`data.ts`).

## How it works

- `conifer.ts` - deterministic generator. Each variant draws a skeleton (trunk, whorls of limbs,
  side twigs) and emits LOD0 (4-9k triangles) and LOD1 (0.9-1.8k) from the same skeleton, so the
  crown keeps its shape across the switch. Fir: whorls of limbs covered by three crossed spray
  cards per segment, inter-whorl shoots, crossed core cards hiding the trunk inside the crown,
  a leader. Pines: limbs and side twigs ending in needle clumps (three perpendicular starburst
  cards = a pom-pom from any side) plus upright brush tufts; lodgepole has short clumps all
  along its limbs. Pine branch ends are two crossed side cards + one front card showing the same
  3D-simulated branch end (`needles.py`): fox-tail brushes of long needles for Jeffrey pine,
  bottle brushes of short paired needles for lodgepole, so they read as needles from every side
  (no flat starburst discs). Snags: grey trunk (broken top on one variant) with stubs. Trees below 13 m
  (fir / Jeffrey) or 9 m (lodgepole) use a young variant (open-grown cone with a crown to the
  ground). Shading normals blend each card's normal with the crown's outward normal; AO is
  darker towards the axis and the bottom of the crown.
- `lighting.ts` / `materials.ts` - wrap diffuse, back-lit translucency (needles glow when the
  camera looks towards the sun), a faint waxy sheen, sky fill (strongly occluded inside the
  crown), a volumetric self-shadow (path length through the tree's own crown profile towards
  the sun), dappled light (3D noise, sprays shading each other), the live sun past the terrain
  and the other crowns from the GPU shadow field (`world/shadowGlsl.ts`: per vertex for the
  meshes, sampled where the sun ray leaves the tree's lidar crown cylinder; per instance at
  35 / 65 / 95 % of the height for impostors; falls back to the baked sunBase -> sunTop until
  the field is live), per-card and per-tree colour variation (yellower / bluer, wide brightness),
  bark normal map, wind sway / needle flutter. Cards seen edge-on are thinned so crossed cards do
  not show as lines.
- `impostor.ts` - at load, every variant's LOD0 is rendered from 8 x 8 hemi-octahedral
  directions into two 4096 x 3072 atlases (albedo + coverage; octahedral normal, depth, AO /
  foliage flag), with mipmaps. The impostor shader picks the frame from the view direction in
  the tree's own (rotated, scaled) space, reconstructs each texel's position from the depth and
  runs the same lighting (incl. self-shadow and dapple) as the meshes, so the switch does not
  change brightness. Alpha threshold drops with the mip level to keep distant crowns full.
- `system.ts` - LODs by effective distance `d / clamp(height / 20, 0.6, 1.6)`: LOD0 < 60 m,
  LOD1 < 240 m, impostors beyond, each switch a 12 / 45 m dithered cross-fade (complementary
  screen-space masks, no popping, no blending). Near trees are re-selected on the CPU only when
  the camera moved / turned (per-cell frustum culling, ~0.2-0.5 ms); impostors are static
  instanced buffers per 512 m chunk (three.js frustum culling per chunk) that hide themselves
  near the camera in the vertex shader.
- `textures.ts` - foliage atlas with coverage-preserving mipmaps per region (Castaño), so
  alpha-tested needles do not thin out and vanish at distance.

## Look-dev page

`http://localhost:5173/forest.html` (dev server only): synthetic hills with ~50k synthetic trees
and a clearing with one specimen of each variant. URL flags: `pose=close|fir|firback|jeffrey|
jeffreyback|lodgepole|snag|youngs|specimens|specimensback|drone|backlit|low|canopy|high`,
`n=` tree count, `sun=az,el` (degrees), `only=0..3` species, `lod=imp|mesh1|mesh0` (force one
representation), `debug=1..4`, `amb=` ambient scale. `window.__forest.stats()` returns fps /
triangles / draw calls / LOD counts. Its post stack (sun irradiance x flat term, distance haze,
AgX) only approximates the main app.

## Textures and licences

`public/textures/forest/` is generated by `make_textures.py` (Python + Pillow + NumPy + SciPy):

- `foliage.png` 2048 x 1024: fir spray built from `leaves/pine_color.png` of
  [ez-tree](https://github.com/dgreenheck/ez-tree) by Daniel Greenheck (MIT), layered and
  recoloured; the Jeffrey / lodgepole branch ends (side + front views) are rendered from 3D
  needle simulations by `needles.py`.
- Species tints (`conifer.ts` TINTS) target dark Sierra conifer albedos (~0.03-0.06 linear),
  measured against the atlas means; re-measure if the atlas changes.
- `bark_color.jpg`, `bark_normal.jpg`: ez-tree's pine bark (MIT package; the source texture is
  from [TextureCan](https://www.texturecan.com/details/588/), CC0), resized to 512 px.
