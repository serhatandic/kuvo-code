#!/usr/bin/env python3
"""Generates KuvoCode/AppIcon.icon, the app icon in Icon Composer's format.

The icon is the team: Kuvo Code's five bots (bloom, gem, pebble, squircle and round, as
BotAvatar.swift draws them), each in its colour and with two eyes, packed together with the coral
one in front, on a cream tile in light mode and a near-black one in dark mode. They have no outlines: each is softly lit from above, rounds off at
its edges, has a fine matte grain, and is shaded where a bot in front of it overlaps it. Each bot
is its own image layer, so macOS still derives the clear and tinted styles from them. Xcode
compiles the file with the app.

It also renders the README's docs/images/icon.png with Icon Composer's ictool, and, given their
paths, writes the iPhone app's copy and the website's icon.png, icon-dark.png and
apple-touch-icon.png (the artwork itself, without the glass edge macOS adds):

    python3 scripts/icon.py [--phone ../kuvo-code-ios/KuvoCodeMobile/AppIcon.icon] [--web ../kuvo-web]

Needs numpy and OpenCV (pip install numpy opencv-python), and Xcode for ictool.
"""
import argparse
import colorsys
import json
import os
import shutil
import subprocess

import cv2
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "KuvoCode", "AppIcon.icon")
README_ICON = os.path.join(ROOT, "docs", "images", "icon.png")
ICTOOL = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"

# The tile, top and bottom: cream in light mode, near-black in dark mode.
TILES = {"light": ("#F5F2EB", "#E8E3D9"), "dark": ("#1B1A20", "#0E0D11")}

# The bots' colours, as BotLook.Tint has them, a little richer, and the eyes BotFace draws on
# them: light on the deep ones, dark on the rest.
TINTS = {
    "mint": (0.37, 0.78, 0.72), "sky": (0.31, 0.61, 0.96), "indigo": (0.36, 0.36, 0.94),
    "violet": (0.54, 0.36, 0.96), "pink": (0.93, 0.44, 0.71), "coral": (0.95, 0.45, 0.36),
    "orange": (0.96, 0.60, 0.24), "amber": (0.95, 0.76, 0.31), "lime": (0.55, 0.80, 0.31),
    "graphite": (0.43, 0.45, 0.50),
}
RICHER = 1.1
DEEP = {"indigo", "violet", "graphite"}
DARK_EYES, LIGHT_EYES = "#141318", "#F6F2EA"

# The team, back to front: shape, colour, centre, size, turn in degrees, and its eyes (centre,
# gap, width, height), on Icon Composer's 1024-point canvas. They fill the tile below a strip
# along its top, the three in front run off its bottom edge, and every face is whole.
TEAM = [
    ("bloom", "violet", 280, 440, 700, -8, (330, 400, 100, 42, 100)),
    ("gem", "amber", 770, 430, 620, 14, (762, 418, 86, 37, 84)),
    ("pebble", "sky", 92, 790, 590, -6, (100, 780, 76, 33, 72)),
    ("squircle", "mint", 932, 782, 580, 6, (930, 750, 76, 33, 72)),
    ("round", "coral", 512, 852, 660, 0, (530, 762, 108, 42, 86)),
]

# Everything is drawn at twice the canvas, as signed distances (negative inside), then scaled
# down for smooth edges.
SS = 2
N = 1024 * SS
_gy, _gx = np.mgrid[0:N, 0:N].astype(np.float32)
X, Y = (_gx + 0.5) / SS, (_gy + 0.5) / SS


def frame(cx, cy, deg):
    """Coordinates around (cx, cy), turned by deg."""
    a = np.deg2rad(deg)
    dx, dy = X - cx, Y - cy
    return np.cos(a) * dx + np.sin(a) * dy, -np.sin(a) * dx + np.cos(a) * dy


def ellipse(x, y, a, b):
    k0 = np.hypot(x / a, y / b)
    k1 = np.hypot(x / (a * a), y / (b * b))
    return k0 * (k0 - 1) / np.maximum(k1, 1e-9)


def superellipse(x, y, a, b, n):
    u, v = np.abs(x) / a + 1e-9, np.abs(y) / b + 1e-9
    f = (u ** n + v ** n) ** (1 / n)
    gx, gy = f ** (1 - n) * u ** (n - 1) / a, f ** (1 - n) * v ** (n - 1) / b
    return (f - 1) / np.maximum(np.hypot(gx, gy), 1e-9)


def polygon(x, y, points):
    d = np.full(x.shape, 1e9, np.float32)
    sign = np.ones(x.shape, np.float32)
    for (ax, ay), (bx, by) in zip(points[-1:] + points[:-1], points):
        px, py, ex, ey = x - ax, y - ay, bx - ax, by - ay
        h = np.clip((px * ex + py * ey) / (ex * ex + ey * ey), 0, 1)
        d = np.minimum(d, np.hypot(px - ex * h, py - ey * h))
        c1, c2, c3 = y >= ay, y < by, ex * (y - ay) > ey * (x - ax)
        sign = np.where((c1 & c2 & c3) | (~c1 & ~c2 & ~c3), -sign, sign)
    return sign * d


def rounded_polygon(x, y, points, r):
    """A polygon with every corner rounded by r: shrunk by r, then grown back."""
    p = np.array(points, float)
    area = sum(p[i - 1][0] * p[i][1] - p[i][0] * p[i - 1][1] for i in range(len(p)))
    lines = []
    for i in range(len(p)):
        t = (p[(i + 1) % len(p)] - p[i]) / np.linalg.norm(p[(i + 1) % len(p)] - p[i])
        lines.append((p[i] + np.array([-t[1], t[0]]) * np.sign(area) * r, t))
    inner = []
    for (p1, t1), (p2, t2) in zip(lines[-1:] + lines[:-1], lines):
        s = np.linalg.solve(np.array([[t1[0], -t2[0]], [t1[1], -t2[1]]]), p2 - p1)
        inner.append(tuple(p1 + t1 * s[0]))
    return polygon(x, y, inner) - r


def body(shape, x, y, s):
    """A bot's shape at size s, as BotShape in BotAvatar.swift draws it."""
    if shape == "round":
        return np.hypot(x, y) - 0.5 * s
    if shape == "squircle":
        return superellipse(x, y, 0.46 * s, 0.46 * s, 3.4)
    if shape == "pebble":
        return rounded_polygon(x, y, [(0, -0.66 * s), (0.6 * s, 0.44 * s), (-0.6 * s, 0.44 * s)], 0.24 * s)
    if shape == "gem":
        return rounded_polygon(x, y, [(0, -0.58 * s), (0.58 * s, 0), (0, 0.58 * s), (-0.58 * s, 0)], 0.22 * s)
    if shape == "bloom":
        a = np.arctan2(y, x) + np.pi / 2
        return (np.hypot(x, y) - s * (0.455 + 0.035 * np.cos(8 * a))) * 0.93
    raise ValueError(shape)


def coverage(d, soft=1.0):
    """Antialiased coverage from a signed distance."""
    return np.clip(0.5 - d * SS / soft, 0, 1).astype(np.float32)


def blur(a, sigma):
    s = sigma * SS
    return cv2.GaussianBlur(a, (int(s * 3) * 2 + 1,) * 2, s, borderType=cv2.BORDER_REFLECT)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def noise(scale, seed, octaves):
    """Smooth value noise in [0, 1], with features about `scale` points across."""
    rng = np.random.default_rng(seed)
    out = np.zeros((N, N), np.float32)
    amp = total = 1.0
    total = 0.0
    for o in range(octaves):
        cells = max(2, int(1024 / scale * 2 ** o))
        out += cv2.resize(rng.random((cells + 1, cells + 1)).astype(np.float32), (N, N), interpolation=cv2.INTER_CUBIC) * amp
        total += amp
        amp *= 0.5
    out /= total
    return (out - out.min()) / (out.max() - out.min() + 1e-6)


def linear(hex_or_rgb):
    c = np.array([int(hex_or_rgb[i:i + 2], 16) / 255 for i in (1, 3, 5)] if isinstance(hex_or_rgb, str) else hex_or_rgb, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def encoded(c):
    c = np.clip(c, 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def richer(rgb):
    h, l, s = colorsys.rgb_to_hls(*rgb)
    return colorsys.hls_to_rgb(h, l, min(1, s * RICHER))


def eye_pair(ex, ey, gap, w, h, deg):
    a = np.deg2rad(deg)
    dx, dy = np.cos(a) * gap / 2, np.sin(a) * gap / 2
    return np.minimum(ellipse(*frame(ex - dx, ey - dy, deg), w / 2, h / 2),
                      ellipse(*frame(ex + dx, ey + dy, deg), w / 2, h / 2))


def layers():
    """Each bot as its own image, back to front: (name, RGBA at 1024 px). A bot is lit from above,
    rounds off at its edges, has a fine grain, and is shaded where the bots in front of it sit."""
    grain = noise(1.4, seed=21, octaves=2) - 0.5
    dither = (noise(0.6, seed=5, octaves=1) - 0.5) * (1.5 / 255)
    shapes = []
    for shape, tint, cx, cy, s, deg, eyes in TEAM:
        d = body(shape, *frame(cx, cy, deg), s)
        shapes.append((d, coverage(d), s))
    out = []
    for i, (shape, tint, cx, cy, s, deg, (ex, ey, gap, w, h)) in enumerate(TEAM):
        d, a, _ = shapes[i]
        t = np.clip((Y - (cy - s * 0.5)) / s, 0, 1)
        colour = linear(richer(TINTS[tint]))[None, None, :] * (1.22 - 0.5 * smoothstep(0, 1, t))[..., None]
        edge = 1 - smoothstep(0, 0.12 * s, np.clip(-d, 0, None))
        colour *= (1 - 0.22 * edge * (0.4 + 0.6 * t))[..., None]
        colour *= (1 + 0.05 * grain)[..., None]
        face = coverage(eye_pair(ex, ey, gap, w, h, deg * 0.6), soft=1.6)
        ink = linear(LIGHT_EYES if tint in DEEP else DARK_EYES)
        colour = colour * (1 - face[..., None]) + ink * face[..., None]
        for _, front, fs in shapes[i + 1:]:                      # the soft shadow of each bot in front
            shift = np.float32([[1, 0, 0], [0, 1, 0.015 * fs * SS]])
            moved = cv2.warpAffine(front, shift, (N, N), borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            colour *= (1 - blur(moved, 0.045 * fs) * 0.55)[..., None]
        rgb = encoded(colour + dither[..., None])
        premultiplied = np.dstack([rgb * a[..., None], a])
        small = cv2.resize(premultiplied, (1024, 1024), interpolation=cv2.INTER_AREA)
        alpha = small[..., 3:]
        rgb = np.where(alpha > 1e-4, small[..., :3] / np.maximum(alpha, 1e-4), 0)
        rgba = (np.clip(np.dstack([rgb, alpha]), 0, 1) * 255 + 0.5).astype(np.uint8)
        out.append((shape, rgba))
    return out


def color(hex_value):
    r, g, b = (int(hex_value[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return f"srgb:{r:.5f},{g:.5f},{b:.5f},1.00000"


def write_icon(path, parts, platform):
    """An Icon Composer document: the tile, light or dark with the Mac, and the team on it, a layer
    for each bot."""
    if os.path.exists(path):
        shutil.rmtree(path)
    os.makedirs(os.path.join(path, "Assets"))
    entries = []
    for name, rgba in reversed(parts):       # Icon Composer lists the front first
        image = name + ".png"
        cv2.imwrite(os.path.join(path, "Assets", image), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
        entries.append({"image-name": image, "name": name, "glass": False,
                        "position": {"scale": 1, "translation-in-points": [0, 0]}})
    def gradient(top, bottom):
        return {"linear-gradient": [color(top), color(bottom)],
                "orientation": {"start": {"x": 0.5, "y": 0}, "stop": {"x": 0.5, "y": 1}}}
    icon = {
        "fill-specializations": [
            {"value": gradient(*TILES["light"])},
            {"appearance": "dark", "value": gradient(*TILES["dark"])},
        ],
        "groups": [{
            "name": "Team",
            "layers": entries,
            "shadow": {"kind": "none", "opacity": 0},
            "translucency": {"enabled": False, "value": 0},
            "lighting": "combined",
            "specular": False,
        }],
        "supported-platforms": {"squares": [platform]},
    }
    with open(os.path.join(path, "icon.json"), "w") as f:
        f.write(json.dumps(icon, indent=2) + "\n")
    print("Wrote", os.path.normpath(path))


def render(icon, out, size, platform="macOS", margin=0, rendition="Default"):
    """Icon Composer's own rendering of the icon (light, or Dark), with an empty margin round it."""
    subprocess.run([ICTOOL, icon, "--export-image", "--output-file", out, "--platform", platform,
                    "--rendition", rendition, "--width", str(size - 2 * margin), "--height", str(size - 2 * margin),
                    "--scale", "1"], check=True, capture_output=True)
    if margin:
        image = cv2.imread(out, cv2.IMREAD_UNCHANGED)
        cv2.imwrite(out, cv2.copyMakeBorder(image, margin, margin, margin, margin, cv2.BORDER_CONSTANT, value=(0, 0, 0, 0)))
    print("Wrote", os.path.normpath(out))


def flat(parts, size, look="light", corner=0.0):
    """The artwork itself at `size` pixels, without the glass edge macOS draws round an icon: the
    light or dark tile and the bots, with corners rounded by `corner` (a share of the side, as
    CSS's border-radius takes it), or square."""
    big = 1024 * SS
    top, bottom = TILES[look]
    t = smoothstep(0, 1, (np.arange(big, dtype=np.float32) + 0.5) / big)[:, None, None]
    tile = linear(top) * (1 - t) + linear(bottom) * t
    out = np.broadcast_to(encoded(tile), (big, big, 3)).copy()
    for _, rgba in parts:
        layer = cv2.resize(rgba, (big, big), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255
        a = layer[..., 3:]
        out = layer[..., :3] * a + out * (1 - a)
    alpha = np.ones((big, big, 1), np.float32)
    if corner:
        r = corner * big
        q = np.abs((np.arange(big, dtype=np.float32) + 0.5) - big / 2) - big / 2 + r
        qx, qy = np.meshgrid(q, q)
        d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
        alpha = np.clip(0.5 - d, 0, 1)[..., None]
    premultiplied = np.dstack([out * alpha, alpha])
    small = cv2.resize(premultiplied, (size, size), interpolation=cv2.INTER_AREA)
    a = small[..., 3:]
    rgb = np.where(a > 1e-4, small[..., :3] / np.maximum(a, 1e-4), 0)
    return (np.clip(np.dstack([rgb, a]), 0, 1) * 255 + 0.5).astype(np.uint8)


def save(rgba, path):
    cv2.imwrite(path, cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    print("Wrote", os.path.normpath(path))


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    args.add_argument("--phone", help="the iPhone app's AppIcon.icon, to write its copy")
    args.add_argument("--web", help="the kuvo-web checkout, to write its icon.png, icon-dark.png and apple-touch-icon.png")
    args = args.parse_args()
    parts = layers()
    write_icon(OUT, parts, "macOS")
    # the README's, dark; with macOS's icon grid, where the tile is 824 of 1024 points
    render(OUT, README_ICON, 256, margin=25, rendition="Dark")
    if args.phone:
        write_icon(args.phone, parts, "iOS")
    if args.web:
        # the site's icon beside its name, and its favicon, light and dark: the artwork with the
        # corners the page rounds it by; the touch icon square, as iPhones round it themselves
        code = os.path.join(args.web, "public", "code")
        save(flat(parts, 256, "light", corner=0.2266), os.path.join(code, "icon.png"))
        save(flat(parts, 256, "dark", corner=0.2266), os.path.join(code, "icon-dark.png"))
        save(flat(parts, 180, "light"), os.path.join(code, "apple-touch-icon.png"))
