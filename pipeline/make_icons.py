#!/usr/bin/env python3
"""Render the app icons: ことば on indigo, in Zen Maru Gothic.

    pip install pillow
    python3 pipeline/make_icons.py
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, "pipeline", "ZenMaruGothic-Bold.ttf")
OUT = os.path.join(ROOT, "app", "icons")
INDIGO, PAPER = "#2b3f8c", "#f8f6f0"


def render(size=1024):
    img = Image.new("RGB", (size, size), INDIGO)
    d = ImageDraw.Draw(img)
    pad = int(size * 0.11)
    d.ellipse((pad, pad, size - pad, size - pad), fill=PAPER)
    font = ImageFont.truetype(FONT, int(size * 0.244))
    y = int(size * 0.264)
    for line in ("こと", "ば"):
        bb = d.textbbox((0, 0), line, font=font)
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        d.text(((size - w) / 2 - bb[0], y - bb[1]), line, font=font, fill=INDIGO)
        y += h + int(size * 0.03)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    big = render()
    big.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"), optimize=True)
    big.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"), optimize=True)
    big.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, "apple-touch-icon.png"), optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
