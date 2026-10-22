# ts so cool

import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT, OUT = sys.argv[1], sys.argv[2]
W, H = 1600, 900
S = 2  # supersample
BLUE = (0, 85, 255)
rng = np.random.default_rng(7)


def ridge(n, octaves, base, amp):
    x = np.linspace(0, 1, n)
    y = np.full(n, base, dtype=float)
    for o in range(octaves):
        f = 2**o
        pts = rng.random(f + 2)
        y += np.interp(x * (f + 1), np.arange(f + 2), pts) * amp / (1.6**o)
    return y


# brightness field: sky light, mountains darker with shading, foreground noise
cols, rows = W // 12, H // 12


def smooth(a, k):
    w = np.hanning(k)
    return np.convolve(np.pad(a, k, mode="edge"), w / w.sum(), mode="same")[k:-k]


def noise2d(scale):
    small = (rng.random((rows // scale + 2, cols // scale + 2)) * 255).astype(np.uint8)
    im = Image.fromarray(small).resize((cols, rows), Image.BICUBIC)
    return np.asarray(im, dtype=float) / 255


def fit(a, lo, hi):
    return lo + (a - a.min()) / (a.max() - a.min()) * (hi - lo)


far = fit(
    smooth(ridge(cols, 5, 0, 1), 5), 0.42, 0.85
)  # height as fraction of frame, from bottom
near = fit(smooth(ridge(cols, 5, 0, 1), 7), 0.12, 0.42)
slope_far = np.gradient(far) * cols
slope_near = np.gradient(near) * cols
rock = noise2d(4) * 0.6 + noise2d(2) * 0.4
field = np.zeros((rows, cols))
for r in range(rows):
    h = 1 - r / rows  # height of this row from bottom
    v = np.full(cols, 0.62 + 0.25 * h)  # sky: dense dots, denser at top
    # faces turned to the light (rising left->right) are lit; light fades with depth
    depth = np.clip((far - h) / 0.35, 0, 1)
    lit_far = (
        0.18
        + 0.5 * np.clip(np.tanh(slope_far * 0.8), 0, 1) * (1 - depth)
        + 0.35 * rock[r] * (1 - 0.5 * depth)
    )
    v = np.where(h < far, lit_far, v)
    depth = np.clip((near - h) / 0.25, 0, 1)
    lit_near = (
        0.08
        + 0.45 * np.clip(np.tanh(-slope_near * 0.8), 0, 1) * (1 - depth)
        + 0.3 * rock[r][::-1]
    )
    v = np.where(h < near, lit_near, v)
    field[r] = v
field += rng.normal(0, 0.05, field.shape)
field = np.clip(field, 0, 1)

img = Image.new("RGB", (W * S, H * S), BLUE)
d = ImageDraw.Draw(img)
cell = 12 * S
for r in range(rows):
    for c in range(cols):
        rad = field[r, c] * cell * 0.46
        if rad < 1.2 * S:
            continue
        cx, cy = c * cell + cell / 2, r * cell + cell / 2
        d.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill="white")

# title
font = ImageFont.truetype(FONT, 210 * S)
text = "OpenGym"
bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
tx, ty = (W * S - tw) / 2 - bbox[0], (H * S - th) / 2 - bbox[1] - 40 * S
shadow = Image.new("L", img.size, 0)
ImageDraw.Draw(shadow).text((tx, ty), text, font=font, fill=255)
glow = shadow.filter(ImageFilter.GaussianBlur(30 * S)).point(lambda p: min(255, p * 4))
img.paste(Image.new("RGB", img.size, BLUE), mask=glow)
d = ImageDraw.Draw(img)
d.text((tx, ty), text, font=font, fill="white")

img = img.resize((W, H), Image.LANCZOS)
# rounded corners
mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, W - 1, H - 1), radius=28, fill=255)
out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
out.paste(img, mask=mask)
out.save(OUT, optimize=True)
print("ok", OUT)
