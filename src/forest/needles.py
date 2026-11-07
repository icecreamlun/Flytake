"""3D needle-cluster renderer for the pine foliage cards of make_textures.py: needles are
simulated as curved 3D polylines in fascicles along the shoots, depth-sorted and drawn
(supersampled) from the side and from the front, so a crossed side + front card set shows the
same branch end from every direction (no flat "pom-pom" discs).

Pine foliage cards (side view = along the branch, front view =
looking down the branch). Card units: the side card spans x in [-0.5, 0.5], z in [0, 1] (branch
base at the bottom centre); the front card spans x, y in [-0.5, 0.5] (branch axis through the
centre)."""
import math
import random

import numpy as np
from PIL import Image, ImageDraw

SS = 4


def rot_to(axis, v):
    """rotate v (given around +z) so that +z maps onto axis."""
    axis = axis / np.linalg.norm(axis)
    z = np.array([0.0, 0.0, 1.0])
    c = float(axis @ z)
    if c > 0.9999:
        return v
    if c < -0.9999:
        return -v
    k = np.cross(z, axis)
    s = np.linalg.norm(k)
    k /= s
    return v * c + np.cross(k, v) * s + k * (k @ v) * (1 - c)


def bezier(p0, p1, p2, n):
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2


def twig_polyline(base, direction, length, bend, n=12):
    d = direction / np.linalg.norm(direction)
    p2 = base + d * length + np.array([0, 0, bend * length])
    p1 = base + d * length * 0.5
    return bezier(base, p1, p2, n)


def tuft(rnd, twig, n_fasc, per, needle_len, spread_base, spread_tip, start, curl, lengths=(0.8, 1.15)):
    """needles of fascicles along the end of a twig polyline (start = fraction where they begin)."""
    out = []
    pts = twig
    seg = np.diff(pts, axis=0)
    cum = np.concatenate([[0], np.cumsum(np.linalg.norm(seg, axis=1))])
    total = cum[-1]
    for f in range(n_fasc):
        u = start + (1 - start) * (f / max(1, n_fasc - 1)) ** 0.7
        s = u * total
        i = min(len(seg) - 1, np.searchsorted(cum, s) - 1)
        i = max(i, 0)
        t = (s - cum[i]) / max(1e-9, cum[i + 1] - cum[i])
        p = pts[i] + seg[i] * t
        axis = seg[i] / np.linalg.norm(seg[i])
        # needles near the tip point forward, further back they splay out
        spread = spread_tip + (spread_base - spread_tip) * (1 - (u - start) / max(1e-6, 1 - start))
        az0 = rnd.uniform(0, 2 * math.pi)
        for k in range(per):
            th = spread * rnd.uniform(0.55, 1.1)
            az = az0 + k * 2 * math.pi / per + rnd.gauss(0, 0.35)
            local = np.array([math.sin(th) * math.cos(az), math.sin(th) * math.sin(az), math.cos(th)])
            d = rot_to(axis, local)
            L = needle_len * rnd.uniform(*lengths)
            # curve: needles bend towards the twig direction and a little upward
            q = [p]
            dd = d.copy()
            for sgm in range(6):
                dd = dd + (axis * curl + np.array([0, 0, 0.12])) * 0.18
                dd /= np.linalg.norm(dd)
                q.append(q[-1] + dd * L / 6)
            out.append((np.array(q), rnd.random()))
    return out


def render(needles, twigs, view, size, colours, needle_w, twig_w, twig_col, light_bias=0.0):
    """view 'side': image (x, z), depth y (toward the viewer = -y); 'front': image (x, y), depth z."""
    W = size * SS
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c_in, c_mid, c_tip = (np.array(c, float) for c in colours)

    def proj(p):
        if view == 'side':
            return (p[..., 0] + 0.5) * W, (1 - p[..., 2]) * W
        return (p[..., 0] + 0.5) * W, (0.5 - p[..., 1]) * W

    def depth(p):
        return -p[..., 1] if view == 'side' else p[..., 2]

    items = []
    for q, r in needles:
        items.append((float(depth(q).mean()), 'n', q, r))
    for tw in twigs:
        for i in range(len(tw) - 1):
            items.append((float(depth(tw[i:i + 2]).mean()), 't', tw[i:i + 2], 0.0))
    items.sort(key=lambda it: it[0])
    dmin = min(it[0] for it in items)
    dmax = max(it[0] for it in items)
    for dep, kind, q, r in items:
        fz = (dep - dmin) / max(1e-6, dmax - dmin)  # 0 = far, 1 = near
        xs, ys = proj(q)
        if kind == 't':
            col = np.array(twig_col) * (0.6 + 0.4 * fz)
            d.line([(xs[0], ys[0]), (xs[1], ys[1])], fill=tuple(int(c) for c in col) + (255,), width=max(1, int(twig_w * SS)))
            continue
        n = len(xs)
        # needle direction: upward needles catch more skylight
        up = (q[-1, 2] - q[0, 2]) / max(1e-6, np.linalg.norm(q[-1] - q[0]))
        lit = np.clip(0.55 + 0.3 * up + light_bias, 0, 1.2)
        for s in range(n - 1):
            u = (s + 1) / (n - 1)
            base = c_in + (c_mid - c_in) * (0.25 + 0.75 * fz)
            col = base + (c_tip - base) * (u ** 1.3) * (0.25 + 0.45 * fz)
            col = col * lit + (r - 0.5) * 14
            col = np.clip(col, 0, 255)
            wdt = max(1, int(round(needle_w * SS * (1 - 0.5 * u))))
            d.line([(xs[s], ys[s]), (xs[s + 1], ys[s + 1])], fill=tuple(int(c) for c in col) + (255,), width=wdt)
    return img


def downsample(img, w, h):
    a = np.asarray(img).astype(np.float32) / 255
    rgb, al = a[..., :3] * a[..., 3:], a[..., 3:]
    pre = np.concatenate([rgb, al], -1)
    small = np.asarray(Image.fromarray((pre * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)).astype(np.float32) / 255
    al = small[..., 3:]
    rgb = np.where(al > 1e-3, small[..., :3] / np.maximum(al, 1e-3), 0)
    return np.concatenate([np.clip(rgb, 0, 1), al], -1)


def jeffrey_branch(seed):
    """A Jeffrey pine branch end: a main shoot and three side shoots, each a fox-tail brush of
    long needles (bundles of three, ~20 cm) around its outer part, tips upturned."""
    rnd = random.Random(seed)
    twigs = []
    needles = []
    main = twig_polyline(np.array([0.0, 0.0, 0.0]), np.array([rnd.uniform(-0.08, 0.08), rnd.uniform(-0.1, 0.1), 1.0]), 0.6, 0.0, 16)
    twigs.append(main)
    needles += tuft(rnd, main, 210, 3, 0.25, 1.15, 0.45, 0.4, 0.3)
    for k, (side, at) in enumerate(((-1, 5), (1, 7), (rnd.choice((-1, 1)), 3))):
        b = main[at]
        dirv = np.array([side * rnd.uniform(0.6, 1.0), rnd.uniform(-0.6, 0.6), rnd.uniform(0.6, 1.0)])
        tw = twig_polyline(b, dirv, rnd.uniform(0.3, 0.42) * (0.75 if k == 2 else 1), 0.45, 12)
        twigs.append(tw)
        needles += tuft(rnd, tw, 110, 3, 0.23, 1.2, 0.45, 0.35, 0.35)
    return needles, twigs


def lodgepole_branch(seed):
    """Lodgepole: short paired needles densely along the shoots (bottle brush), two shoots."""
    rnd = random.Random(seed)
    twigs = []
    needles = []
    main = twig_polyline(np.array([0.0, 0.0, 0.0]), np.array([rnd.uniform(-0.05, 0.05), 0.0, 1.0]), 0.78, 0.0)
    twigs.append(main)
    needles += tuft(rnd, main, 380, 2, 0.2, 1.05, 0.5, 0.06, 0.2, (0.75, 1.15))
    b = main[5]
    tw = twig_polyline(b, np.array([0.8, rnd.uniform(-0.4, 0.4), 0.8]), 0.4, 0.4)
    twigs.append(tw)
    needles += tuft(rnd, tw, 200, 2, 0.18, 1.05, 0.5, 0.08, 0.2, (0.75, 1.15))
    b = main[3]
    tw = twig_polyline(b, np.array([-0.8, rnd.uniform(-0.4, 0.4), 0.7]), 0.32, 0.4)
    twigs.append(tw)
    needles += tuft(rnd, tw, 160, 2, 0.18, 1.05, 0.5, 0.08, 0.2, (0.75, 1.15))
    return needles, twigs


def front_scene(needles, twigs):
    """Front card: centre the cluster on the branch axis (x, y) and scale it into the card."""
    pts = np.concatenate([q for q, _ in needles])
    c = np.array([0.0, 0.0, 0.0])
    r = np.abs(pts[:, :2]).max()
    k = 0.48 / r
    ns = [((q - c) * np.array([k, k, 1.0]), rr) for q, rr in needles]
    ts = [(t - c) * np.array([k, k, 1.0]) for t in twigs]
    return ns, ts


def fit_side(needles, twigs):
    pts = np.concatenate([q for q, _ in needles] + twigs)
    xr = np.abs(pts[:, 0]).max()
    zr = pts[:, 2].max()
    k = min(0.48 / xr, 0.97 / zr)
    ns = [(q * k, r) for q, r in needles]
    ts = [t * k for t in twigs]
    return ns, ts, k
