"""Roads, paths and buildings from OpenStreetMap (Overpass API), cached in WORK/osm_ground.json.

Used by ground_classes.py to keep rocks, shrubs and logs off Highway 89, the Vikingsholm road,
trails and buildings. Usage: python -I ground_osm.py
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request

import numpy as np

from common import E_MAX, E_MIN, N_MAX, N_MIN, WORK, enu_to_lonlat

CACHE = WORK / "osm_ground.json"


def fetch():
    lon, lat = enu_to_lonlat(np.array([E_MIN, E_MAX, E_MIN, E_MAX]), np.array([N_MIN, N_MIN, N_MAX, N_MAX]))
    s, w, n, e = float(np.min(lat)), float(np.min(lon)), float(np.max(lat)), float(np.max(lon))
    q = f"""[out:json][timeout:60];
(
  way["highway"]({s},{w},{n},{e});
  way["building"]({s},{w},{n},{e});
  way["amenity"="parking"]({s},{w},{n},{e});
);
out geom;"""
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": q}).encode(),
        headers={"User-Agent": "flytake-scene-pipeline"},
    )
    data = json.load(urllib.request.urlopen(req, timeout=120))
    CACHE.write_text(json.dumps(data))
    kinds = {}
    for el in data["elements"]:
        t = el.get("tags", {})
        k = t.get("highway") or ("building" if "building" in t else t.get("amenity", "?"))
        kinds[k] = kinds.get(k, 0) + 1
    print(len(data["elements"]), "ways", kinds)


if __name__ == "__main__":
    fetch()
