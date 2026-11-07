"""Builds public/textures/forest/* from the ez-tree assets (MIT) plus procedurally drawn
pine-needle tufts. Usage: python src/forest/make_textures.py <ez-tree package dir>

foliage.png (2048 x 1024 RGBA, sRGB, straight alpha); v = 0 is the image bottom:
  u 0.00..0.50, v 0..1     fir spray (ez-tree leaves/pine_color.png, a photographed conifer
                           branch, layered denser and recoloured blue-green); twig base at v = 0
  u 0.50..0.75, v 0.5..1   Jeffrey pine branch end seen from the side: three shoots ending in
                           upturned brushes of long needles (bundles of 3); shoot base at v = 0.5
  u 0.50..0.75, v 0..0.5   the same branch end seen along the shoot (front card, axis at the centre)
  u 0.75..1.00, v 0.5..1   lodgepole branch end from the side: short paired needles all along the
                           shoots (bottle brush)
  u 0.75..1.00, v 0..0.5   the same from the front
The pine cards are rendered from 3D needle simulations (needles.py).
"""
import math
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import needles as nd  # noqa: E402

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
OUT = Path(__file__).resolve().parents[2] / 'public' / 'textures' / 'forest'
OUT.mkdir(parents=True, exist_ok=True)
SS = 4  # supersampling


def tuft(w, h, seed, needle_len, needle_w, n_bundles, colours, twig_top, spread, bare, curl):
    rnd = random.Random(seed)
    W, H = w * SS, h * SS
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # twig: slight S curve from bottom centre
    pts = []
    for i in range(41):
        t = i / 40
        x = W / 2 + math.sin(t * 2.4 + seed) * W * 0.02
        y = H - t * (H - twig_top * SS)
        pts.append((x, y))
    strokes = []
    for b in range(n_bundles):
        t = bare + (1 - bare) * (b / n_bundles) ** 0.8
        i = min(40, int(t * 40))
        bx, by = pts[i]
        # needles point forward (up) and out; tighter near the tip
        side = rnd.choice((-1, 1))
        ang = side * rnd.uniform(0.15, 1.0) * spread * (1 - 0.55 * t) + rnd.gauss(0, 0.08)
        for k in range(rnd.randint(2, 3)):
            a = ang + rnd.gauss(0, 0.12)
            L = needle_len * SS * rnd.uniform(0.75, 1.1) * (0.7 + 0.3 * (1 - abs(a) / 1.6))
            depth = rnd.random()
            strokes.append((depth, bx, by, a, L, rnd.random()))
    strokes.sort(key=lambda s: s[0])
    for depth, bx, by, a, L, r in strokes:
        c0 = np.array(colours[0], float)
        c1 = np.array(colours[1], float)
        c2 = np.array(colours[2], float)
        base = c0 + (c1 - c0) * depth  # back needles darker
        seg = 6
        px, py = bx, by
        for s in range(seg):
            u = (s + 1) / seg
            aa = a + curl * u * (1 if a > 0 else -1)
            nx = bx + math.sin(aa) * L * u
            ny = by - math.cos(aa) * L * u
            col = base + (c2 - base) * (u ** 2) * (0.3 + 0.7 * depth) + (r - 0.5) * 18
            col = np.clip(col, 0, 255).astype(int)
            wdt = max(1, int(needle_w * SS * (1 - 0.6 * u)))
            d.line([(px, py), (nx, ny)], fill=(int(col[0]), int(col[1]), int(col[2]), 255), width=wdt)
            px, py = nx, ny
    # twig on top of the back needles but under nothing else is fine for cards seen from afar
    d.line(pts[: int(41 * 0.97)], fill=(92, 70, 52, 255), width=int(3.2 * SS), joint='curve')
    return downsample(img, w, h)


def starburst(size, seed, n, rmin, rmax, needle_w, colours, centre=(0.5, 0.5)):
    """Needles radiating from the twig end, as seen looking along the twig."""
    rnd = random.Random(seed)
    W = size * SS
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = centre[0] * W, centre[1] * W
    strokes = []
    for k in range(n):
        a = rnd.uniform(0, 2 * math.pi)
        L = W * 0.5 * rnd.uniform(rmin, rmax)
        # needles start a little off the centre (bundles along the twig)
        off = rnd.uniform(0.02, 0.16) * W
        strokes.append((rnd.random(), a, L, off, rnd.uniform(-0.25, 0.25), rnd.random()))
    strokes.sort(key=lambda s: s[0])
    c0, c1, c2 = (np.array(c, float) for c in colours)
    for depth, a, L, off, curl, r in strokes:
        base = c0 + (c1 - c0) * depth
        x0 = cx + math.cos(a + 1.3) * off * 0.3
        y0 = cy + math.sin(a + 1.3) * off * 0.3
        px, py = x0, y0
        seg = 5
        for s in range(seg):
            u = (s + 1) / seg
            aa = a + curl * u
            nx = x0 + math.cos(aa) * L * u
            ny = y0 + math.sin(aa) * L * u
            col = np.clip(base + (c2 - base) * (u ** 2) * (0.3 + 0.7 * depth) + (r - 0.5) * 16, 0, 255).astype(int)
            wdt = max(1, int(needle_w * SS * (1 - 0.55 * u)))
            d.line([(px, py), (nx, ny)], fill=(int(col[0]), int(col[1]), int(col[2]), 255), width=wdt)
            px, py = nx, ny
    return downsample(img, size, size)


def downsample(img, w, h):
    a = np.asarray(img).astype(np.float32) / 255
    rgb, al = a[..., :3] * a[..., 3:], a[..., 3:]
    pre = np.concatenate([rgb, al], -1)
    small = np.asarray(Image.fromarray((pre * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)).astype(np.float32) / 255
    al = small[..., 3:]
    rgb = np.where(al > 1e-3, small[..., :3] / np.maximum(al, 1e-3), 0)
    return np.concatenate([np.clip(rgb, 0, 1), al], -1)


def bleed(rgba):
    """Fill fully transparent texels with the colour of nearby opaque ones (no dark halos)."""
    from scipy.ndimage import distance_transform_edt
    al = rgba[..., 3]
    mask = al < 0.02
    _, (iy, ix) = distance_transform_edt(mask, return_indices=True)
    out = rgba.copy()
    out[..., :3] = rgba[iy, ix, :3]
    return out


def fir_spray():
    """The photographed spray is sparse (23% coverage): layer rotated / scaled copies around the
    twig base into a denser branch tip, back copies darker (self-shadowed)."""
    src = Image.open(SRC / 'src/lib/assets/leaves/pine_color.png').convert('RGBA').resize((1024, 1024), Image.LANCZOS)
    canvas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    layers = [(-34, 0.78, 0.62, False), (30, 0.8, 0.66, True), (-12, 0.9, 0.8, True), (14, 0.92, 0.86, False), (0, 1.0, 1.0, False)]
    for angle, scale, shade, flip in layers:
        im = src.transpose(Image.FLIP_LEFT_RIGHT) if flip else src
        w = int(1024 * scale)
        im = im.resize((w, w), Image.LANCZOS)
        a = np.asarray(im).astype(np.float32)
        a[..., :3] *= shade
        im = Image.fromarray(a.clip(0, 255).astype(np.uint8), 'RGBA')
        # rotate around the twig base (bottom centre)
        big = Image.new('RGBA', (2048, 2048), (0, 0, 0, 0))
        big.paste(im, (1024 - w // 2, 1024 - w), im)
        big = big.rotate(angle, resample=Image.BICUBIC, center=(1024, 1024))
        crop = big.crop((512, 0, 1536, 1024))
        canvas.alpha_composite(crop)
    a = np.asarray(canvas).astype(np.float32) / 255
    # recolour the (yellow-green spruce) photo towards Sierra fir blue-green, keeping its
    # luminance detail and a little of the original hue variation
    lum = (a[..., :3] @ np.array([0.30, 0.59, 0.11]))[..., None]
    target = np.array([0.36, 0.56, 0.50]) / 0.5
    a[..., :3] = np.clip(0.75 * lum * target + 0.25 * a[..., :3], 0, 1)
    return a


fir = fir_spray()
J_COL = [(30, 48, 40), (70, 98, 82), (128, 150, 118)]
L_COL = [(30, 42, 20), (70, 90, 42), (118, 132, 62)]
TWIG = (88, 70, 56)
jn, jt = nd.jeffrey_branch(5)
js, jts, _ = nd.fit_side(jn, jt)
jside = nd.downsample(nd.render(js, jts, 'side', 512, J_COL, 1.25, 2.2, TWIG), 512, 512)
jf, jft = nd.front_scene(jn, jt)
jfront = nd.downsample(nd.render(jf, jft, 'front', 512, J_COL, 1.25, 2.2, TWIG), 512, 512)
ln, lt = nd.lodgepole_branch(9)
ls, lts, _ = nd.fit_side(ln, lt)
lside = nd.downsample(nd.render(ls, lts, 'side', 512, L_COL, 1.3, 2.0, (90, 74, 56)), 512, 512)
lf, lft = nd.front_scene(ln, lt)
lfront = nd.downsample(nd.render(lf, lft, 'front', 512, L_COL, 1.3, 2.0, (90, 74, 56)), 512, 512)


def match_mean(front, side):
    """the front view sees more sunlit needle tips: keep both views at the same mean colour"""
    m = lambda im: (im[..., :3] * im[..., 3:]).reshape(-1, 3).sum(0) / im[..., 3].sum()
    out = front.copy()
    out[..., :3] = np.clip(front[..., :3] * (m(side) / m(front)), 0, 1)
    return out


jfront = match_mean(jfront, jside)
lfront = match_mean(lfront, lside)
atlas = np.zeros((1024, 2048, 4), np.float32)
atlas[:, :1024] = fir
# image row 0 is the top (v = 1)
atlas[:512, 1024:1536] = jside
atlas[512:, 1024:1536] = jfront
atlas[:512, 1536:] = lside
atlas[512:, 1536:] = lfront
atlas = bleed(atlas)
Image.fromarray((atlas * 255 + 0.5).astype(np.uint8), 'RGBA').save(OUT / 'foliage.png', optimize=True)
for name in ('color', 'normal'):
    Image.open(SRC / f'src/lib/assets/bark/pine_{name}_1k.jpg').convert('RGB').resize((512, 512), Image.LANCZOS).save(OUT / f'bark_{name}.jpg', quality=88)
print('ok', [p.name for p in OUT.iterdir()])
