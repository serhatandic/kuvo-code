#!/usr/bin/env python3
"""Generates KuvoCode/AppIcon.icon, the app icon in Icon Composer's format, from its artwork.

The icon is two pictures, KuvoCode/AppIcon.icon/Assets/artwork-light.png and artwork-dark.png at
1024 x 1024: Kuvo Code's bots peeking out from behind a big coral one, on a light tile and on a
dark one. The Mac shows the one that matches its appearance. Xcode compiles the file with the app.

`--light <image> --dark <image>` takes in new artwork: pictures of the icon, ideally its tile
edge to edge at 2048. Any band of background along a tile's edges is trimmed, the light picture
is moved to sit on the dark one (matched by the bots' eyes), both are cropped to the same square,
and their corners are filled from the pixels next to them, so macOS's own corner shape shows none
of the background.

It also renders the README's docs/images/icon.png (the dark one) with Icon Composer's ictool,
and, given their paths, writes the iPhone app's copy and the website's icon.png, icon-dark.png
and apple-touch-icon.png:

    python3 scripts/icon.py [--light <image> --dark <image>]
                            [--phone ../kuvo-code-ios/KuvoCodeMobile/AppIcon.icon] [--web ../kuvo-web]

Needs numpy and OpenCV (pip install numpy opencv-python), and Xcode for ictool.
"""
import argparse
import json
import os
import shutil
import subprocess

import cv2
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "KuvoCode", "AppIcon.icon")
ARTWORK = {look: os.path.join(OUT, "Assets", f"artwork-{look}.png") for look in ("light", "dark")}
README_ICON = os.path.join(ROOT, "docs", "images", "icon.png")
ICTOOL = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"


def load(path):
    """A picture as BGRA, opaque where it has no alpha."""
    image = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if image.shape[2] == 3:
        image = np.dstack([image, np.full(image.shape[:2], 255, np.uint8)])
    return image


def bands(image):
    """How far in from each edge (left, top, right, bottom) the background reaches before the
    tile starts: the first sharp step along lines through the middle of each side."""
    gray = cv2.GaussianBlur(cv2.cvtColor(image[..., :3], cv2.COLOR_BGR2GRAY).astype(np.float32), (5, 5), 1.0)
    n = gray.shape[0]
    lines = range(n // 4, 3 * n // 4, n // 80)

    def step(profile):
        jumps = np.nonzero(np.abs(np.diff(profile[: n // 10])) > 4)[0]
        return int(jumps[0]) + 1 if len(jumps) else 0

    return (int(np.median([step(gray[y, :]) for y in lines])), int(np.median([step(gray[:, x]) for x in lines])),
            int(np.median([step(gray[y, ::-1]) for y in lines])), int(np.median([step(gray[::-1, x]) for x in lines])))


def eyes(image):
    """The centres of the bots' eyes: tall ovals, black or white."""
    bgr, alpha = image[..., :3].astype(int), image[..., 3]
    found = []
    for mask in ((bgr.max(-1) < 30) & (alpha == 255), (bgr.min(-1) > 240) & (alpha == 255)):
        n, _, stats, centres = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        scale = (image.shape[0] / 2048) ** 2
        for (x, y, w, h, area), centre in zip(stats[1:], centres[1:]):
            if 1500 * scale < area < 40000 * scale and 1.4 < h / max(w, 1) < 3.2:
                found.append(centre)
    return np.array(found)


def offset(moved, still):
    """How far the bots in `moved` sit from those in `still`: the most common shift of each eye to
    its nearest eye in the other picture, so the group lines up even if one bot was moved."""
    a, b = eyes(moved), eyes(still)
    shifts = []
    for p in b:
        q = a[np.argmin(np.hypot(*(a - p).T))]
        if np.hypot(*(q - p)) < 0.08 * moved.shape[0]:
            shifts.append(q - p)
    return np.round(np.median(shifts, axis=0)).astype(int)


def fill_corners(image):
    """The picture with what isn't its tile (transparent corners, and background reached from
    them) filled from the pixels next to it."""
    bgr, alpha = image[..., :3].copy(), image[..., 3]
    outside = (alpha < 255).astype(np.uint8)
    if outside.any():
        # background just inside the cut, of the colour found right at its edge
        edge = cv2.dilate(outside, np.ones((3, 3), np.uint8)) - outside
        shade = np.median(bgr[edge.astype(bool)], axis=0)
        near = (np.abs(bgr.astype(int) - shade).max(-1) < 8).astype(np.uint8)
        grown = outside.copy()
        for _ in range(40):
            wider = cv2.dilate(grown, np.ones((3, 3), np.uint8)) & (near | outside)
            if (wider == grown).all():
                break
            grown = wider
        outside = cv2.dilate(grown, np.ones((5, 5), np.uint8))
    return cv2.inpaint(bgr, outside, 8, cv2.INPAINT_TELEA)


def take_in(light_path, dark_path):
    """The light and dark pictures as matching 1024 x 1024 artwork."""
    dark, light = load(dark_path), load(light_path)
    if light.shape != dark.shape:
        light = cv2.resize(light, dark.shape[1::-1], interpolation=cv2.INTER_AREA)
    n = dark.shape[0]
    dx, dy = offset(light, dark)
    pad = 4
    (dl, dt, dr, db), (ll, lt, lr, lb) = bands(dark), bands(light)
    # the square that's tile in both, in the dark picture's coordinates
    left, top = max(dl, ll - dx) + pad, max(dt, lt - dy) + pad
    right, bottom = min(n - dr, n - lr - dx) - pad, min(n - db, n - lb - dy) - pad
    side = min(right - left, bottom - top)
    left += (right - left - side) // 2
    top = bottom - side                       # any spare height comes off the top: tile only
    crops = {"dark": dark[top:top + side, left:left + side], "light": light[top + dy:top + dy + side, left + dx:left + dx + side]}
    print(f"Took in the pictures: the light one moved {-dx}, {-dy} px onto the dark one; both cropped to {side} px")
    return {look: cv2.resize(fill_corners(crop), (1024, 1024), interpolation=cv2.INTER_AREA) for look, crop in crops.items()}


def tile_colour(artwork):
    """The tile's own colour, from the top of the artwork, as Icon Composer writes colours."""
    b, g, r = artwork[20:60, 400:624].reshape(-1, 3).mean(0) / 255
    return f"srgb:{r:.5f},{g:.5f},{b:.5f},1.00000"


def write_icon(path, artwork, platform):
    """An Icon Composer document whose one layer shows the light or dark artwork with the Mac."""
    if os.path.exists(path):
        shutil.rmtree(path)
    os.makedirs(os.path.join(path, "Assets"))
    for look, image in artwork.items():
        cv2.imwrite(os.path.join(path, "Assets", f"artwork-{look}.png"), image)
    icon = {
        "fill-specializations": [
            {"value": {"solid": tile_colour(artwork["light"])}},
            {"appearance": "dark", "value": {"solid": tile_colour(artwork["dark"])}},
        ],
        "groups": [{
            "name": "Artwork",
            "layers": [{
                "name": "artwork",
                "image-name-specializations": [
                    {"value": "artwork-light.png"},
                    {"appearance": "dark", "value": "artwork-dark.png"},
                ],
                "glass": False,
                "position": {"scale": 1, "translation-in-points": [0, 0]},
            }],
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


def flat(artwork, size, corner=0.0):
    """The artwork itself at `size` pixels, without the glass edge macOS draws round an icon, with
    corners rounded by `corner` (a share of the side, as CSS's border-radius takes it), or square."""
    big = 2048
    image = cv2.resize(artwork, (big, big), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255
    alpha = np.ones((big, big, 1), np.float32)
    if corner:
        r = corner * big
        q = np.abs((np.arange(big, dtype=np.float32) + 0.5) - big / 2) - big / 2 + r
        qx, qy = np.meshgrid(q, q)
        d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
        alpha = np.clip(0.5 - d, 0, 1)[..., None]
    small = cv2.resize(np.dstack([image * alpha, alpha]), (size, size), interpolation=cv2.INTER_AREA)
    a = small[..., 3:]
    bgr = np.where(a > 1e-4, small[..., :3] / np.maximum(a, 1e-4), 0)
    return (np.clip(np.dstack([bgr, a]), 0, 1) * 255 + 0.5).astype(np.uint8)


def save(image, path):
    cv2.imwrite(path, image)
    print("Wrote", os.path.normpath(path))


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    args.add_argument("--light", help="a picture of the light icon, to take in as its artwork")
    args.add_argument("--dark", help="a picture of the dark icon, to take in as its artwork")
    args.add_argument("--phone", help="the iPhone app's AppIcon.icon, to write its copy")
    args.add_argument("--web", help="the kuvo-web checkout, to write its icon.png, icon-dark.png and apple-touch-icon.png")
    args = args.parse_args()
    if bool(args.light) != bool(args.dark):
        args.error("--light and --dark go together")
    artwork = (take_in(args.light, args.dark) if args.light
               else {look: cv2.imread(path, cv2.IMREAD_COLOR) for look, path in ARTWORK.items()})
    write_icon(OUT, artwork, "macOS")
    # the README's, dark; with macOS's icon grid, where the tile is 824 of 1024 points
    render(OUT, README_ICON, 256, margin=25, rendition="Dark")
    if args.phone:
        write_icon(args.phone, artwork, "iOS")
    if args.web:
        # the site's icon beside its name, and its favicon, light and dark: the artwork with the
        # corners the page rounds it by; the touch icon square, as iPhones round it themselves,
        # its corners the tile's colour
        code = os.path.join(args.web, "public", "code")
        save(flat(artwork["light"], 256, corner=0.2266), os.path.join(code, "icon.png"))
        save(flat(artwork["dark"], 256, corner=0.2266), os.path.join(code, "icon-dark.png"))
        touch = flat(artwork["light"], 180, corner=0.2266)
        tile = artwork["light"][20:60, 400:624].reshape(-1, 3).mean(0)
        a = touch[..., 3:].astype(np.float32) / 255
        touch = np.dstack([(touch[..., :3] * a + tile * (1 - a)).round().astype(np.uint8), np.full(touch.shape[:2], 255, np.uint8)])
        save(touch, os.path.join(code, "apple-touch-icon.png"))
