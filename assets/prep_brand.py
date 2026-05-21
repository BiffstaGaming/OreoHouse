#!/usr/bin/env python3
"""Prep the hand-split Icon.png + Logo.png for use in the app.

- Flood-fills the white background from each corner to make it
  genuinely transparent (the source PNGs are flat RGB).
- Trims the result to the alpha bbox + a small breathing margin.
- Writes the icon to client/src-tauri/icons/source.png as a square
  1024×1024 for Tauri's icon generator to consume.
- Writes the logo to client/src/assets/logo.png at its native trimmed
  aspect ratio for the login screen.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
ROOT = HERE.parent
ICON_SRC = HERE / "Icon.png"
LOGO_SRC = HERE / "Logo.png"
TAURI_ICON = ROOT / "client" / "src-tauri" / "icons" / "source.png"
REACT_LOGO = ROOT / "client" / "src" / "assets" / "logo.png"


def make_transparent(img: Image.Image, fuzz: int = 18) -> Image.Image:
    """Flood-fill near-white background from all four corners to alpha=0.

    Connectivity-based so any near-white pixels INSIDE the icon (e.g.
    the house's window) stay opaque.
    """
    img = img.convert("RGBA")
    w, h = img.size
    pixels = img.load()
    assert pixels is not None
    corners = [
        pixels[0, 0],
        pixels[w - 1, 0],
        pixels[0, h - 1],
        pixels[w - 1, h - 1],
    ]
    bg = max(corners, key=lambda p: p[0] + p[1] + p[2])
    br, bgc, bb = bg[0], bg[1], bg[2]

    visited = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()
    for sx, sy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        q.append((sx, sy))
        visited[sy * w + sx] = 1
    while q:
        x, y = q.popleft()
        r, g, b, _ = pixels[x, y]
        if abs(r - br) > fuzz or abs(g - bgc) > fuzz or abs(b - bb) > fuzz:
            continue
        pixels[x, y] = (r, g, b, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx]:
                visited[ny * w + nx] = 1
                q.append((nx, ny))
    return img


def trim_alpha(img: Image.Image, pad: int = 8) -> Image.Image:
    img = img.convert("RGBA")
    bbox = img.split()[-1].getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    w, h = img.size
    return img.crop(
        (
            max(0, x0 - pad),
            max(0, y0 - pad),
            min(w, x1 + pad),
            min(h, y1 + pad),
        )
    )


def square_pad(img: Image.Image, size: int) -> Image.Image:
    """Fit img inside size×size on a transparent canvas, preserving
    aspect ratio."""
    img = img.convert("RGBA")
    w, h = img.size
    scale = min(size / w, size / h)
    new_w, new_h = round(w * scale), round(h * scale)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - new_w) // 2, (size - new_h) // 2), img)
    return canvas


def main() -> int:
    # ---- icon -------------------------------------------------------
    icon = Image.open(ICON_SRC)
    print(f"Icon source: {ICON_SRC} {icon.size} {icon.mode}")
    icon_trans = make_transparent(icon, fuzz=22)
    icon_tight = trim_alpha(icon_trans, pad=24)
    icon_1024 = square_pad(icon_tight, 1024)
    TAURI_ICON.parent.mkdir(parents=True, exist_ok=True)
    icon_1024.save(TAURI_ICON)
    print(f"Wrote {TAURI_ICON} (1024x1024)")

    # ---- logo (for login screen) ------------------------------------
    logo = Image.open(LOGO_SRC)
    print(f"Logo source: {LOGO_SRC} {logo.size} {logo.mode}")
    logo_trans = make_transparent(logo, fuzz=22)
    logo_tight = trim_alpha(logo_trans, pad=16)
    REACT_LOGO.parent.mkdir(parents=True, exist_ok=True)
    logo_tight.save(REACT_LOGO)
    print(f"Wrote {REACT_LOGO} ({logo_tight.size[0]}x{logo_tight.size[1]})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
