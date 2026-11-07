"""Export the ground height field the browser uses for live sun shading (src/world/shadowField.ts).

public/scene/dtm.bin: little-endian
  'FDTM' u32 version(1) u32 width u32 height f32 e0 f32 n0 f32 step f32 offset f32 scale
  then width*height u16, row 0 = south, column 0 = west; cell (i, j) centre at
  (e0 + (i + 0.5) step, n0 + (j + 0.5) step); hgt = offset + scale * value, where hgt is the
  WGS84 ellipsoidal height minus H0 (the lake surface is flat at the measured lake level).
"""
from __future__ import annotations

import struct

import numpy as np

from common import E_MIN, H0, N_MIN, OUT, WORK

STEP = 2.0
OFFSET = -60.0
SCALE = 0.02


def main():
    terrain = np.load(WORK / "terrain.npy")  # 1 m, row 0 = south, ellipsoidal heights
    h, w = terrain.shape
    t = terrain[: h // 2 * 2, : w // 2 * 2].reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3)) - H0
    q = np.clip(np.round((t - OFFSET) / SCALE), 0, 65535).astype("<u2")
    print(f"dtm {q.shape[1]}x{q.shape[0]} hgt {t.min():.1f}..{t.max():.1f}")
    with open(OUT / "dtm.bin", "wb") as f:
        f.write(b"FDTM" + struct.pack("<III", 1, q.shape[1], q.shape[0]))
        f.write(struct.pack("<fffff", E_MIN, N_MIN, STEP, OFFSET, SCALE))
        f.write(q.tobytes())
    print(f"wrote {OUT / 'dtm.bin'} {(OUT / 'dtm.bin').stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
