"""Looping wind-wave slope animation for the lake shader (public/textures/water/waves.bin).

A Phillips-spectrum FFT ocean patch (tileable by construction) evolved with deep-water
dispersion. Frequencies are quantised to multiples of 2 pi / PERIOD so the animation loops
exactly. Only the surface slopes are stored (what the shading needs; slopes average linearly
under mip filtering, normals do not).

Output: header (json, see waves.json) + FRAMES x N x N x RG uint8, slope = (v - 127.5) / 127.5 * SCALE.
Usage: python make_waves.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parents[2] / "public" / "textures" / "water"
N = 256          # texels per side
L = 24.0         # patch size, m
FRAMES = 64
PERIOD = 8.0     # s, loop length
WIND = 4.0       # m/s
WIND_DIR = np.array([0.8, 0.6])
G = 9.81
SEED = 7


def main() -> None:
    rng = np.random.default_rng(SEED)
    f = np.fft.fftfreq(N, d=L / N) * 2 * math.pi
    kx, ky = np.meshgrid(f, f)  # [row = y, col = x]
    k = np.hypot(kx, ky)
    k[0, 0] = 1e-6
    lw = WIND * WIND / G
    kd = (kx * WIND_DIR[0] + ky * WIND_DIR[1]) / k
    p = np.exp(-1.0 / (k * lw) ** 2) / k**4 * kd**2
    p[kd < 0] *= 0.3  # some waves against the wind
    # no waves shorter than ~4 texels (the shader adds a second, finer octave of this patch)
    k_cut = 2 * math.pi / (4.5 * L / N)
    p *= np.exp(-((k / k_cut) ** 4))
    p *= np.exp(-((0.6 / k) ** 2) * 0)  # (no long-wave cut: the patch period does that)
    p[0, 0] = 0
    h0 = (rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N))) * np.sqrt(p / 2)
    # h0(-k): index flip
    h0m = np.conj(np.roll(np.flip(h0), 1, axis=(0, 1)))
    w0 = 2 * math.pi / PERIOD
    omega = np.maximum(np.round(np.sqrt(G * k) / w0), 1) * w0

    frames = np.zeros((FRAMES, N, N, 2), np.float32)
    for i in range(FRAMES):
        t = i * PERIOD / FRAMES
        h = h0 * np.exp(1j * omega * t) + h0m * np.exp(-1j * omega * t)
        sx = np.real(np.fft.ifft2(1j * kx * h))
        sy = np.real(np.fft.ifft2(1j * ky * h))
        frames[i, ..., 0] = sx
        frames[i, ..., 1] = sy
    rms = float(np.sqrt(np.mean(frames**2) * 2))
    frames /= rms  # unit rms slope magnitude
    scale = 3.2
    q = np.clip(np.round(frames / scale * 127.5 + 127.5), 0, 255).astype(np.uint8)
    clipped = float(np.mean(np.abs(frames) > scale))
    meta = {"size": N, "patch": L, "frames": FRAMES, "period": PERIOD, "scale": scale, "wind": WIND, "windDir": WIND_DIR.tolist()}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "waves.bin").write_bytes(q.tobytes())
    (OUT / "waves.json").write_text(json.dumps(meta, indent=1))
    print(f"waves.bin: {FRAMES} x {N}^2, rms slope normalised to 1 (raw {rms:.4f}), clipped {clipped:.5f}, {q.nbytes / 1e6:.1f} MB")
    # loop check: frame FRAMES would equal frame 0
    t = PERIOD
    h = h0 * np.exp(1j * omega * t) + h0m * np.exp(-1j * omega * t)
    sx = np.real(np.fft.ifft2(1j * kx * h)) / rms
    print(f"loop error {float(np.abs(sx - frames[0, ..., 0]).max()):.2e}")


if __name__ == "__main__":
    main()
