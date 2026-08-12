#!/usr/bin/env python3
"""generate-icons.py — Chrome Web Store extension icons (PLAN-FRONTEND.md §8.4).

Produces the four required sizes (16/32/48/128px) of the flattened, single-color
verdict-seal motif: a concentric ring + inner dot in brass (#9C7A3C, the shared
`--sg-brass` token) on a transparent background. No verdict-color variants —
the static icon stays neutral-brand; the runtime badge carries color (§5).

Rendering is supersampled 4x and downscaled with LANCZOS so the 16px tile keeps
crisp anti-aliased edges.

Requires Pillow (PIL) >= 9. Run:  python3 scripts/generate-icons.py
"""

import os

from PIL import Image, ImageDraw

BRASS = (0x9C, 0x7A, 0x3C, 255)
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

# Seal geometry as fractions of the tile size (radius/stroke widths). The outer
# ring's outer edge stays within the tile (0.475 < 0.5) to survive Chrome's
# own downscaling at the toolbar without clipping.
OUTER_RING_RADIUS = 0.42
OUTER_RING_WIDTH = 0.11
INNER_RING_RADIUS = 0.27
INNER_RING_WIDTH = 0.06
CENTER_DOT_RADIUS = 0.12


def draw_seal(canvas):
    """Draw the verdict-seal motif centered on `canvas` (square PIL image)."""
    size = canvas.width
    center = size / 2
    draw = ImageDraw.Draw(canvas)

    def ring(radius_fraction, stroke_fraction):
        radius = radius_fraction * size
        width = max(1, round(stroke_fraction * size))
        draw.ellipse(
            [center - radius, center - radius, center + radius, center + radius],
            outline=BRASS,
            width=width,
        )

    ring(OUTER_RING_RADIUS, OUTER_RING_WIDTH)
    ring(INNER_RING_RADIUS, INNER_RING_WIDTH)

    dot_radius = CENTER_DOT_RADIUS * size
    draw.ellipse(
        [center - dot_radius, center - dot_radius, center + dot_radius, center + dot_radius],
        fill=BRASS,
    )


def generate(output_dir):
    os.makedirs(output_dir, exist_ok=True)
    written = []
    for size in SIZES:
        high_res = size * SUPERSAMPLE
        canvas = Image.new("RGBA", (high_res, high_res), (0, 0, 0, 0))
        draw_seal(canvas)
        icon = canvas.resize((size, size), Image.Resampling.LANCZOS)
        path = os.path.join(output_dir, f"icon-{size}.png")
        icon.save(path, "PNG")
        written.append(path)
    return written


if __name__ == "__main__":
    for path in generate(OUT_DIR):
        print(f"wrote {path}")
