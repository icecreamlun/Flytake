"""Shared definitions for the Emerald Bay scene build (see tools/scene/README.md)."""
from __future__ import annotations

import math
import os
from pathlib import Path

import numpy as np
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("FLYTAKE_DATA", ROOT.parent / "Flytake-data"))
RAW = DATA / "raw"
WORK = DATA / "work"
OUT = ROOT / "public" / "scene"
for d in (RAW, WORK, OUT):
    d.mkdir(parents=True, exist_ok=True)

# Local ENU frame: Fannette Island at the lake surface (EMERALD_BAY_ORIGIN in src/geo/locations.ts).
LAT0 = 38.95416
LON0 = -120.1004
H0 = 1873.5  # WGS84 ellipsoidal height of the lake surface (TAHOE.lakeEllipsoidHeight)
# NAVD88 (GEOID18) orthometric -> WGS84 ellipsoidal around the bay (MSL_TO_ELLIPSOID)
MSL_TO_ELLIPSOID = -24.1
LAKE_ORTHO = 1897.6

# Scene extent in the ENU frame (metres). Covers the Emerald Bay basin, its rim and the
# shoreline beyond both points; the rest of the world stays Google 3D Tiles.
E_MIN, E_MAX = -4000.0, 4000.0
N_MIN, N_MAX = -3500.0, 4200.0

A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)


def geodetic_to_ecef(lat, lon, h):
    lat = np.radians(lat)
    lon = np.radians(lon)
    s = np.sin(lat)
    n = A / np.sqrt(1 - E2 * s * s)
    x = (n + h) * np.cos(lat) * np.cos(lon)
    y = (n + h) * np.cos(lat) * np.sin(lon)
    z = (n * (1 - E2) + h) * s
    return x, y, z


def enu_basis(lat=LAT0, lon=LON0):
    la, lo = math.radians(lat), math.radians(lon)
    east = np.array([-math.sin(lo), math.cos(lo), 0.0])
    north = np.array([-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)])
    up = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
    return east, north, up


ORIGIN_ECEF = np.array(geodetic_to_ecef(LAT0, LON0, H0))
EAST, NORTH, UP = enu_basis()

_ecef_to_ll = Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True)
_ll_to_utm = Transformer.from_crs("EPSG:4326", "EPSG:26910", always_xy=True)
_ll_to_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
_3857_to_ll = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


def enu_to_ecef(e, n, u):
    e, n, u = np.broadcast_arrays(np.asarray(e, float), np.asarray(n, float), np.asarray(u, float))
    p = ORIGIN_ECEF[:, None] + np.outer(EAST, e.ravel()) + np.outer(NORTH, n.ravel()) + np.outer(UP, u.ravel())
    return p[0].reshape(e.shape), p[1].reshape(e.shape), p[2].reshape(e.shape)


def ecef_to_enu(x, y, z):
    d = np.stack([np.asarray(x) - ORIGIN_ECEF[0], np.asarray(y) - ORIGIN_ECEF[1], np.asarray(z) - ORIGIN_ECEF[2]])
    return (np.tensordot(EAST, d, 1), np.tensordot(NORTH, d, 1), np.tensordot(UP, d, 1))


def enu_to_lonlat(e, n):
    """Lon/lat under the tangent-plane point (e, n, 0)."""
    x, y, z = enu_to_ecef(e, n, 0.0)
    lon, lat, _ = _ecef_to_ll.transform(x, y, z)
    return lon, lat


def lonlat_to_enu(lon, lat, h_ellipsoid):
    x, y, z = geodetic_to_ecef(lat, lon, h_ellipsoid)
    return ecef_to_enu(x, y, z)


def grid_xy(lon, lat):
    """Scene grid coordinates of (lon, lat): the ENU east/north of the point at the origin's
    ellipsoidal height. enu_to_lonlat() is its inverse to < 1 mm over the scene. Every raster
    is indexed by these coordinates and stores WGS84 ellipsoidal heights; exact ENU positions
    (with Earth curvature) are only computed for mesh vertices and tree instances."""
    e, n, _ = lonlat_to_enu(lon, lat, H0)
    return e, n


def lonlat_to_utm(lon, lat):
    return _ll_to_utm.transform(lon, lat)


def lonlat_to_3857(lon, lat):
    return _ll_to_3857.transform(lon, lat)


def m3857_to_lonlat(x, y):
    return _3857_to_ll.transform(x, y)


def grid(step: float, pad: float = 0.0):
    """Cell-centre ENU coordinates of a regular grid over the scene extent."""
    e = np.arange(E_MIN - pad + step / 2, E_MAX + pad, step)
    n = np.arange(N_MIN - pad + step / 2, N_MAX + pad, step)
    return e, n


def sun_direction(utc_iso: str, lat: float = LAT0, lon: float = LON0):
    """Unit vector toward the sun in the ENU frame (NOAA solar position algorithm, ~0.01 deg),
    plus (azimuth from north, elevation) in degrees. Refraction is ignored."""
    from datetime import datetime, timezone

    t = datetime.fromisoformat(utc_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    jd = t.timestamp() / 86400.0 + 2440587.5
    jc = (jd - 2451545.0) / 36525.0
    l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360
    m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    c = (math.sin(math.radians(m)) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
         + math.sin(math.radians(2 * m)) * (0.019993 - 0.000101 * jc) + math.sin(math.radians(3 * m)) * 0.000289)
    true_long = l0 + c
    omega = 125.04 - 1934.136 * jc
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60
    eps = eps0 + 0.00256 * math.cos(math.radians(omega))
    decl = math.degrees(math.asin(math.sin(math.radians(eps)) * math.sin(math.radians(app_long))))
    y = math.tan(math.radians(eps / 2)) ** 2
    eq_time = 4 * math.degrees(y * math.sin(2 * math.radians(l0)) - 2 * e * math.sin(math.radians(m))
                               + 4 * e * y * math.sin(math.radians(m)) * math.cos(2 * math.radians(l0))
                               - 0.5 * y * y * math.sin(4 * math.radians(l0)) - 1.25 * e * e * math.sin(2 * math.radians(m)))
    minutes = t.hour * 60 + t.minute + t.second / 60
    tst = (minutes + eq_time + 4 * lon) % 1440
    ha = tst / 4 - 180
    la, de, h = math.radians(lat), math.radians(decl), math.radians(ha)
    cos_zen = math.sin(la) * math.sin(de) + math.cos(la) * math.cos(de) * math.cos(h)
    zen = math.acos(max(-1, min(1, cos_zen)))
    el = 90 - math.degrees(zen)
    az = math.degrees(math.atan2(math.sin(h), math.cos(h) * math.sin(la) - math.tan(de) * math.cos(la))) + 180
    az %= 360
    ce = math.cos(math.radians(el))
    v = np.array([ce * math.sin(math.radians(az)), ce * math.cos(math.radians(az)), math.sin(math.radians(el))])
    return v, az, el
