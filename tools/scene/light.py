"""Sun shadow fields on the scene grid.

shadow_height(surface, sun, step) returns S where S[cell] is the height below which a point in
that cell's column is in the sun shadow of the surface upstream (excluding the cell itself):
S(x) = max_{x' upstream} surface(x') - |x - x'| * tan(elevation). Computed with one linear
sweep along the sun azimuth on a rotated copy of the grid.
"""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage as ndi


def shadow_height(surface: np.ndarray, sun: np.ndarray, step: float = 1.0) -> np.ndarray:
    """surface: [H, W] heights on a north-up grid (row 0 = south). sun: ENU unit vector."""
    az = math.degrees(math.atan2(sun[0], sun[1]))  # from north, clockwise
    el = math.asin(max(1e-3, sun[2]))
    drop = math.tan(el) * step
    base = float(np.nanmin(surface))
    a = (surface - base).astype(np.float32)
    # rotate so that the direction TOWARD the sun points along -x (sweep from x=0 = sun side).
    # Array axes: x = column (east), y = row (north). The sun-ward unit vector in (x, y) is
    # (sin az, cos az); its angle from +x is theta = 90 - az. Rotating the array by `angle`
    # degrees counter-clockwise in (col, row) space with ndi.rotate on (row, col) axes.
    theta = az - 90.0  # (rows grow northward, ndi.rotate assumes image rows: mirror N-S)
    rot_angle = 180.0 - theta  # bring the sun-ward vector to -x
    big = ndi.rotate(a, rot_angle, axes=(1, 0), reshape=True, order=1, mode="constant", cval=-1e4)
    valid = ndi.rotate(np.ones_like(a), rot_angle, axes=(1, 0), reshape=True, order=0, mode="constant", cval=0)
    big[valid < 0.5] = -1e4
    out = np.full_like(big, -1e4)
    h = np.full(big.shape[0], -1e4, np.float32)
    for x in range(big.shape[1]):
        out[:, x] = h
        h = np.maximum(h - drop, big[:, x])
    back = ndi.rotate(out, -rot_angle, axes=(1, 0), reshape=False, order=1, mode="constant", cval=-1e4)
    # crop the centre back to the original shape
    oy = (back.shape[0] - a.shape[0]) // 2
    ox = (back.shape[1] - a.shape[1]) // 2
    res = back[oy:oy + a.shape[0], ox:ox + a.shape[1]]
    return (res + base).astype(np.float32)


def sun_visibility(receiver: np.ndarray, shadow: np.ndarray, soft: float = 0.6) -> np.ndarray:
    return np.clip((receiver - shadow) / soft + 0.5, 0, 1).astype(np.float32)
