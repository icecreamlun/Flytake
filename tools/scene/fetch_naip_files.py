"""Download the NAIP 2022 COGs over the scene with parallel HTTP range requests (GDAL's
/vsicurl/ reads one block at a time and was ~50x slower). Writes RAW/naip/<id>.tif."""
from __future__ import annotations

import concurrent.futures as cf
import json
import urllib.request

from common import RAW
from fetch_rasters import NAIP_IDS

OUT = RAW / "naip"
OUT.mkdir(exist_ok=True)
CHUNK = 8 << 20
tok = json.load(urllib.request.urlopen("https://planetarycomputer.microsoft.com/api/sas/v1/token/naipeuwest/naip"))["token"]


def fetch_range(url, start, end, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception:
            if i == tries - 1:
                raise


def download(item_id):
    dest = OUT / f"{item_id}.tif"
    if dest.exists():
        return item_id, dest.stat().st_size
    item = json.load(urllib.request.urlopen(f"https://planetarycomputer.microsoft.com/api/stac/v1/collections/naip/items/{item_id}"))
    url = item["assets"]["image"]["href"] + "?" + tok
    req = urllib.request.Request(url, method="HEAD")
    size = int(urllib.request.urlopen(req).headers["Content-Length"])
    ranges = [(s, min(size, s + CHUNK) - 1) for s in range(0, size, CHUNK)]
    with cf.ThreadPoolExecutor(8) as ex:
        parts = list(ex.map(lambda r: fetch_range(url, *r), ranges))
    tmp = dest.with_suffix(".part")
    with open(tmp, "wb") as f:
        for p in parts:
            f.write(p)
    tmp.rename(dest)
    return item_id, size


with cf.ThreadPoolExecutor(3) as ex:
    for item_id, size in ex.map(download, NAIP_IDS):
        print(item_id, size // (1 << 20), "MB", flush=True)
