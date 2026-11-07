# Argus city data — sources, processing and assumptions

Files: `city.json` (CityData, see `src/contracts.ts`), `terrain.json` + `terrain.bin` (TerrainMeta + Float32 LE grid).
Built by `scripts/data/` (Python 3.11, numpy/scipy/shapely 1.8/Pillow):

```
python3 scripts/data/fetch.py all          # download + cache raw sources in scripts/data/.cache/ (idempotent)
python3 scripts/data/build_city.py --terrain   # terrain.json/.bin + city.json (atomic writes, ~15 s)
python3 scripts/data/validate.py           # contract checks, stats, real-world spot checks (exit 1 on failure)
```

## Coordinate frame

Exactly `src/geo.ts` (replicated in `scripts/data/geo.py`, which asserts round trips and known landmark positions
on import): local tangent plane at CITY_ORIGIN = centre of CORE_BBOX (37.7935, −122.398); metres; +X east, −Z north,
+Y up; Y = elevation in metres NAVD88 (≈ local mean sea level − 0.9 m; the engine's y = 0 water plane sits near
mean lower-low water).

## Sources and licences

| Data | Source | Licence |
|---|---|---|
| Buildings, building parts, streets, rail, piers, parks/plazas, OSM trees | OpenStreetMap via Overpass API (`out geom`) | © OpenStreetMap contributors, ODbL 1.0 |
| Building footprints + 2010 LiDAR zonal height stats | DataSF *Building Footprints* (ynuv-fyni) | PDDL (DataSF open data) |
| Year built, storeys, units, construction class, use code | DataSF *Assessor Historical Secured Property Tax Rolls* (wv5m-vpq2), closed roll year 2025 | PDDL |
| Construction class code book | SF Office of the Assessor-Recorder 2025-2026 secured roll workbook, sheet *Construction Code* (cached as `.cache/asr_roll_2025.xlsx`) | public record |
| Soft-story buildings | DataSF *Soft-Story Properties* (beah-shgi) | PDDL |
| Street trees | DataSF *Street Tree List* (tkzw-k3nq) | PDDL |
| Terrain + bathymetry | AWS Terrain Tiles (Terrarium PNG, zoom 15; USGS 3DEP on land, NOAA bathymetry in the bay) | public domain / open data |

## Terrain (`terrain.json`, `terrain.bin`)

* Grid x −2800…3600, z −2800…2400 (context bbox + ≥1.2 km margin, ~2 km to the east over the bay), cell 4 m,
  1601 × 1301 samples, row 0 = north (minZ), columns west→east. Elevation −39.2…114.8 m.
* Terrarium decode `(R·256 + G + B/256) − 32768`, bilinear resampling of the Web-Mercator mosaic onto the grid.
* Land/water mask from the OSM coastline (chained into the mainland polygon) + closed island rings + wide fixed piers.
* Land: masked Gaussian σ = 0.75 cell (removes pixel noise, keeps real slopes), clamped ≥ 1.6 m.
  Water: masked Gaussian σ = 2.5 cells, clamped ≤ −1.5 m; first water ring ≤ −3 m (crisp seawall, no smeared shore).
* Piers wider than 18 m (2A/P) are burned in as flat decks at their median DEM height clamped to 2.4–3.6 m;
  narrower/floating piers stay over water and are returned as `pier` areas with `elevation` 3 m.
* DEM artefact removal: Coit Tower's base leaked into the bare-earth DEM (+4.5 m bump); flattened to the
  surrounding hilltop (83.2 m).
* Checks: no NaN, no tile seams (hillshade inspected; land 2nd-difference p99.9 = 1.4 m).

## Buildings

**Selection.** OSM `building=*` ways and multipolygon relations (holes kept; multi-polygons split into several
records sharing the osmId), skipping `no/roof/canopy/carport/bridge/collapsed/demolished/proposed`, underground
(`location=underground`, negative layer). `building:part=*` pieces are render geometry of their building (see *Structural records*). Centroid must be inside CONTEXT_BBOX.
Footprints: simplified 5 cm, rounded to 1 cm, outer ring shoelace Σ(x_i·z_{i+1} − x_{i+1}·z_i) < 0 (CCW seen from
above), holes opposite, not closed; slivers < 6 m² and hair-thin strips dropped.

**Parts.** Parts link to their outline via `type=building` relations, else by max plan overlap (≥ 50 % of the part).
If the parts cover ≥ 80 % of the outline the outline is dropped (114 outlines); otherwise only the outline area not
covered by parts is kept (no coincident volumes). Parts inherit the outline's name/address/use/landmark tags.
When an outline's `height` exceeds its tallest part by > 3 m and that part is ≥ 80 % of it, the tallest part is lifted
to the outline height (mappers often stop parts at the last setback, e.g. Embarcadero Center 4: 154 → 174 m).

**Structural records** (one per real building). Records are render geometry; buildings are *groups* of records.
A group is an OSM outline with its parts (incl. the outline remainder around them and pieces cut by overlaps), or an
orphan part; touching groups are merged when they are one building mapped in pieces: orphan parts touching each other
(the Salesforce Transit Center: 24 parts, no outline) and touching groups sharing an OSM address or name (a tower and
its podium as two outlines; Notre Dame des Victoires school wings; Old St Mary's and its annex). Different landmarks are
never merged. 5,689 records → 5,165 buildings.
Each group has exactly one **anchor**, its tallest ground-standing piece: no `parentId`, `isPart` unset. It carries
the building's semantics and *all* its occupants. Every other piece has `isPart: true`, `parentId` = the anchor id,
the anchor's `structure` / `yearBuilt` / `codeLevel` / `softStory` / year+structure provenance, and 0 occupants
(totals are unchanged). So `!isPart` (equivalently `!parentId`) lists each building once, and the group of any record
is `parentId ?? id`. `use`, `height`, `levels`, `minHeight` and appearance tags stay per piece.
Year and structure are decided once per group with the group's height (tallest piece), the anchor's storeys and the
whole plan area, so a 17 m podium slice of Salesforce Tower no longer reads 'wood frame'.
All pieces of one outline share one `baseElevation`: the lowest terrain under the outline *and* every piece (parts
can poke out of their outline onto lower ground). Most parts start at ground (`minHeight` set on only 26): SF towers
are typically mapped as nested/adjacent setback prisms from the ground (Transamerica = 10 nested parts; EC towers =
slab parts).

**Overlaps.** Whole (non-part) buildings never overlap in plan: for every overlapping pair the taller keeps the
shared area; a whole building also loses area covered by ground-level parts of a different building.

**Height** (`provenance.height`) — m from `baseElevation` to the roof:
1. `osm_height`: OSM `height` (units parsed: m, ft, `'`, feet'inches"), unless the DataSF LiDAR footprint covers
   ≥ 50 % and disagrees by more than ×0.4…×2.5 for a pre-2009 building → LiDAR.
2. `osm_levels`: `building:levels` × 3.4 m (+ `roof:height`, else `roof:levels`·2.8, else 2.5 m pitched / 0.8 m parapet);
   replaced by LiDAR when that agrees within ×0.5…×2 (measured roof beats a storey count).
3. `datasf_lidar`: area-weighted `hgt_mediancm` of DataSF footprints overlapping the OSM footprint (calibration on
   3,925 OSM-tagged buildings: median/OSM = 0.997, IQR 0.98–1.02; `hgt_max` is spires/parapets, ×1.22). Not used for
   buildings dated ≥ 2009 unless > 6 m (2010 flight predates Salesforce Tower, 181 Fremont, Park Tower, …).
4. `estimated`: parts → outline height; assessor storeys × 3.4 + 0.8; else district default storeys
   (Chinatown 4.5, FiDi 6, Nob Hill 5, North Beach 3.5, Jackson Sq 3, SoMa 4, waterfront 2; ±1 jitter).
Heights clamped to 2.5–330 m.

**Assessor join.** Each roll-2025 parcel (centroid point) is assigned to exactly one OSM outline: the footprint
containing it, else the outline whose DataSF footprint carries the parcel's block/lot (`mblr`), else the nearest
footprint within 15 m. Per outline: year = floor-area-weighted mode, storeys = max, units = sum (split across a
group's records by floor area), construction class & use code = floor-area-weighted mode, address from the largest
parcel. 4,493 outline groups matched.

**Structure** (`provenance.structure`) — assessor *Class of construction* → HAZUS:

| Class (code book) | HAZUS |
|---|---|
| A — fireproofed structural steel frame | `S1`; `S5` if built < 1935 (steel with brick/terra-cotta infill) |
| B — reinforced concrete frame | `C2`; `C3` if < 1935 (infilled frames); `C1` for 1945–1975 office/commercial/parking (non-ductile moment frames) |
| C — masonry / concrete bearing walls | `URM` if < 1935 and < 22 m; `C3` if < 1935 and ≥ 22 m (tall early bearing-wall blocks were mostly RC frames with infill); otherwise `RM`, or `PC` for ≤ 2-storey boxes > 900 m² (tilt-up) |
| D — wood (or light steel) studs | `W1`; `W2` if outline > 1000 m², ≥ 5 storeys, or non-residential ≥ 3 storeys |
| S — light metal / pre-engineered | `S2` |
| STE / REI / WOO (rare) | as A / B / D |

**Size sanity.** The assessor class describes a parcel's improvements; on high-rise parcels it is often the class of a
podium, a garage or an earlier building (808 Kearny 65 m 'D' wood; 505/555 Montgomery 93-100 m 'C' masonry; 45 Fremont
149 m 'D'). Wood frames and (un)reinforced masonry bearing walls (`W1/W2/RM/URM`) above 25 m are reassigned
(`provenance.structure = estimated`): built < 1935 → `S5` for ≥ 45 m office/commercial/hotel blocks, else `C3`;
later → `S1` for ≥ 50 m office/commercial towers, else `C2`. 172 records (incl. group-consistency changes) changed class.

Soft-Story Properties (432 of 488 matched by APN or point) set `softStory = true` on buildings ≤ 25 m (a match on a
taller building is a parcel-join artefact); wood (`W1/W2`) becomes `W1_SOFT`.
Gaps (23 %) use district/era/height heuristics: piers → `S2`/`PC`; ≥ 60 m → `S1`/`C2` (`S5` pre-1935);
Jackson Square pre-1906 → `URM`; pre-1935 Chinatown → 75 % `URM`; pre-1935 ≥ 25 m → `S5`/`C3`; low residential → `W1`.

**Year** (`provenance.year`): assessor (84 %), else OSM `start_date`, else estimate. The assessor year is rejected
when it is impossible for the building's size — era envelope (max storeys / height incl. crowns): ≤ 1889 8 / 40 m;
1890–1920 21 / 100 m (Hobart, Call Building); 1921–31 32 / 150 m (Russ 133 m); 1932–58 30 / 130 m; 1959–68 45 / 195 m
(Wells Fargo 171 m); 200 m+ only from 1969 — e.g. PG&E 77 Beale 154 m '1909' → estimated 1978 (real 1971), Westin
St Francis Tower 120 m '1904' → 1968 (real 1972). The assessor's spike years (1900 and 1906–09 hold 3–4× their
neighbours: partly real post-fire rebuilding, partly a default) give way to an OSM `start_date` on buildings > 40 m;
without one they are kept when inside the envelope, because the post-fire steel frames are real (Phelan 1908, Humboldt
Bank 1908, Hearst 1909, Adam Grant 1908 are 42–58 m). OSM `start_date` is trusted even outside the envelope.
Estimates: ≥ 100 m → 1968–1990; 40–100 m → by facade: brick/stone/terracotta `building:material` → 1921–1931,
glass/metal, FiDi/SoMa/waterfront or ≥ 60 m → 1960–1990, else 30 % 1921–1931 / 70 % 1960–1990; lower: Chinatown
1907–1925; Jackson Square ≤ 14 m → 1855–1867; waterfront ≤ 20 m → 1912–1932, 20–40 m → 1975–1990; elsewhere 1907–1930;
any estimate outside the envelope is lifted to 1960–1990 (1969–1990 above 195 m). Deterministic jitter by group key.

**Code level**: pre < 1940, low 1940–1972, moderate 1973–1994, high > 1994. URM → `low` (SF's 1992 UMB ordinance
retrofits; Chinatown's brick stock largely retrofitted) except Jackson Square survivors → `pre`.

**Landmark facts** (override year/structure/code): Ferry Building 1898 S5 moderate (2003 retrofit); Transamerica
Pyramid 1972 S1 moderate; Old St Mary's 1854 URM low; Sentinel Building 1907 C3 pre; One Maritime Plaza 1964 S2 low;
Hyatt Regency 1973 C2 moderate; US Customs House 1911 S5 pre; Coit Tower 1933 C2 pre; Embarcadero Center 1/2/3/4
1971/1974/1977/1982.

**Use**: OSM specific tags first (hotel, church, school, civic, parking, station…), then assessor use code
(SRES/MRES → residential, COMO office, COMR retail, COMH hotel incl. residential SRO hotels, COMM commercial,
IND, GOVT civic); residential in Chinatown and retail with ≥ 3 units → `mixed`; else district default.

**Occupancy** (GFA = footprint × levels):

| Use | Day (weekday 2 pm) | Night |
|---|---|---|
| residential | 0.4 × night | units × 2.3 (units unknown: GFA / 85 m²) |
| mixed | 0.4 × residents + ground floor / 35 m² | residents + ground / 400 m² (upper floors: units or GFA / 75 m²) |
| office | GFA / 30 m² (1 / 25 m² design density × ~83 % attendance) | 3 % of day |
| retail, commercial | GFA / 40 m² | 3 % of day |
| hotel | 0.35 × guests + staff | guests + 0.25 × staff (rooms = GFA / 50, 80 % occupied, 1.6 guests, 0.5 staff/room) |
| school / religious / civic / transport | GFA / 12 / 60 / 30 / 20 | GFA / 2000 / 1000 / 400 / 300 |
| industrial / parking / other | GFA / 90 / 400 / 120 | GFA / 900 / 3000 / 1000 |

Totals: day ≈ 437 k (core 300 k), night ≈ 203 k (core 69 k). Per building the occupants of all its pieces are
summed onto the anchor record (see *Structural records*).

**District** (hand-made polygons whose corners are real street intersections computed from OSM centrelines):
`embarcadero` = within 100 m of The Embarcadero, on a pier, or north of Broadway east of Sansome; `chinatown` =
Bush–Broadway × Kearny–Powell; `jackson_square` = Washington–Broadway × Kearny–Sansome; `fidi` = Market–Washington
(Kearny–Sansome) and Market–Broadway east of Sansome; `nob_hill` = west of Powell, Bush–Broadway; `north_beach`
(incl. Telegraph Hill) = north of Broadway, Powell–Sansome; `soma` = south-east of Market; else `other`
(Union Square, Tenderloin edge, Russian Hill).

**Historic shoreline / fill.** `meta.historicShoreline` approximates the ~1849 Yerba Buena Cove shore (after the
1853 US Coast Survey chart and SF historic-shoreline maps): Telegraph Hill's east foot along Sansome (Lombard, Green)
→ Battery & Vallejo → Clark's Point (Battery & Broadway) → Montgomery & Jackson → Montgomery & Bush → Market & 2nd →
Mission & 1st → Fremont & Folsom → Rincon Point (Harrison & Spear) → 2nd & Bryant (Mission Bay shore), extended
past both ends. Everything east of it, plus every pier/over-water building, is `onFill` (735 records).
Accuracy ≈ ±1 block.

**Vs30** (m/s, loosely after Wills et al. 2015): fill 180 + 50·e^(−d/120 m), d = distance east of the old shore
(≈ 230 at the shoreline → 180 over deep cove fill/Bay Mud); native ground 330 + 4.6·(ground − 6 m) (dune sand near
sea level stiffening toward Franciscan bedrock on Nob Hill ≈ 600); Telegraph Hill within 450 m of the summit and
above 35 m ≥ 700 + 2·(ground − 35). Clamped 300–800 on native ground.

**Site.** `baseElevation` = min of the app's bilinear sampler (`heightfield.ts` replica) over the outline vertices +
an interior point (centroid, or a representative point for concave shapes); parts use their outline's.
`overWater` (contract addition): pier sheds/wharf buildings stand on the pier deck (2.4–3.6 m), moored vessels
(`building=ship`: Santa Rosa, San Francisco Belle) at −1 m, Bay Bridge pylons at 0 m, and buildings mostly over water without a mapped pier (e.g. the floating Fireboat Station 35) at −0.5 m so their walls meet the water. `context = true` when the
centroid is outside CORE_BBOX. Ids `B0001…` sorted by centroid (x, z).

## Roads (`RoadRecord`)

OSM `highway=*` (no sidewalk/crossing footways — the streets module draws sidewalks from carriageways; no indoor
corridors) and surface rail. `railway=tram` with `cable_tram=cable` or 1067 mm gauge = **`cable_car`** (California
St and Powell lines); standard-gauge tram (F/E lines) and surface Muni Metro = `rail`; BART / Muni Metro / Central
Subway tunnels skipped. Road tunnels (Stockton St, Broadway) kept with `tunnel: true`; bridges (`bridge: true`)
include the Bay Bridge approach and Transbay ramps, clipped to the context bbox + 150 m.

Carriageway width: OSM `width` if present, else lanes × lane width (motorway 3.6, primary/secondary 3.3, tertiary
3.2, residential 3.1, service 3.0) + parking/bike allowance (primary 2.4, secondary/tertiary 4.4, residential 4.0;
×0.6 one-way), default lanes 3/4/4/2/2/1, capped at 26 m. Named overrides: Market St 23 m (11.5 m per one-way half),
The Embarcadero lanes × 3.4 + 2 m per one-way half (mapped as dual carriageway; the F-line median is separate rail),
Grant Ave 8.5 m, alleys (… Alley/Place/Lane/Way/Court/Walk/Terrace) 5–6 m; pedestrian 6–7, footway 2.2, steps 2.4,
cycleway 2.2, rail 3.0, cable car 2.6. Sidewalk each side: Market 6, Embarcadero 5, primary 4.0, secondary 3.6,
tertiary 3.4, residential 2.8, alleys 1.0, else 0.

## Areas (`AreaRecord`)

`pier` (man_made=pier; `elevation` = deck), `park` (leisure park/garden/playground/dog_park), `pitch`, `plaza`
(place=square, pedestrian areas, Maritime Plaza), `parking` (surface lots only), `grass`, `construction`, `water`
(ponds, fountains incl. Vaillancourt Fountain). Clipped to the context bbox + 60 m.

## Trees (`TreeRecord`)

DataSF street trees (`planttype = Tree`, DBH in inches when 0–80) + OSM `natural=tree` (DBH from circumference);
deduplicated within 1.5 m (DataSF wins), dropped when inside a building footprint (457) or in the bay.

## Known limitations

* Year built is the assessor's "blend of original and newer construction"; heavily remodelled buildings may read late.
* Construction-class → HAZUS is necessarily coarse (no lateral-system information); URM retrofit status is not
  per-building (no open URM-retrofit dataset was joined).
* Colour/material/roof shape are present for < 2 % of buildings (OSM sparsity) — renderers must estimate.
* DataSF LiDAR is from 2010; the historic shoreline and Vs30 are approximations at roughly block resolution.
