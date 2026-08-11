"""Generate the Markdown Interactor extension icon.

The artwork is drawn at high resolution and downsampled for smooth edges. It
uses only Pillow primitives so the result is reproducible without font files.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUTPUT = Path(__file__).resolve().parents[1] / "media" / "logo.png"
ICON_SIZE = 128
SCALE = 8
SIZE = ICON_SIZE * SCALE


def scaled_box(box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    return tuple(value * SCALE for value in box)


def rounded_polyline(
    draw: ImageDraw.ImageDraw,
    points: list[tuple[int, int]],
    fill: str,
    width: int,
) -> None:
    """Draw a polyline with consistently round joins and end caps."""
    points_scaled = [(x * SCALE, y * SCALE) for x, y in points]
    width_scaled = width * SCALE
    radius = width_scaled // 2
    draw.line(points_scaled, fill=fill, width=width_scaled, joint="curve")
    for x, y in points_scaled:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def make_vertical_gradient(top: str, bottom: str) -> Image.Image:
    top_rgb = Image.new("RGB", (1, 1), top).getpixel((0, 0))
    bottom_rgb = Image.new("RGB", (1, 1), bottom).getpixel((0, 0))
    gradient = Image.new("RGBA", (SIZE, SIZE))
    pixels = gradient.load()
    for y in range(SIZE):
        ratio = y / (SIZE - 1)
        color = tuple(
            round(start + (end - start) * ratio)
            for start, end in zip(top_rgb, bottom_rgb)
        ) + (255,)
        for x in range(SIZE):
            pixels[x, y] = color
    return gradient


def main() -> None:
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Soft outer shadow and a rounded violet-to-sky background.
    shadow = Image.new("RGBA", icon.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        scaled_box((5, 7, 123, 125)),
        radius=29 * SCALE,
        fill=(32, 46, 88, 72),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(3 * SCALE))
    icon.alpha_composite(shadow)

    background_mask = Image.new("L", icon.size, 0)
    ImageDraw.Draw(background_mask).rounded_rectangle(
        scaled_box((4, 3, 124, 123)), radius=29 * SCALE, fill=255
    )
    icon.alpha_composite(
        Image.composite(
            make_vertical_gradient("#8B7CF6", "#48BFE8"),
            Image.new("RGBA", icon.size, (0, 0, 0, 0)),
            background_mask,
        )
    )

    # A subtle glow makes the flat gradient feel friendly without adding noise.
    glow = Image.new("RGBA", icon.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(scaled_box((-18, -25, 82, 69)), fill=(255, 255, 255, 32))
    glow.putalpha(Image.composite(glow.getchannel("A"), Image.new("L", icon.size), background_mask))
    icon.alpha_composite(glow)

    # Rounded message card: Markdown content plus a small tail for interaction.
    card_shadow = Image.new("RGBA", icon.size, (0, 0, 0, 0))
    card_shadow_draw = ImageDraw.Draw(card_shadow)
    card_shadow_draw.rounded_rectangle(
        scaled_box((18, 27, 110, 101)), radius=21 * SCALE, fill=(38, 45, 80, 45)
    )
    card_shadow_draw.polygon(
        [(79 * SCALE, 96 * SCALE), (99 * SCALE, 111 * SCALE), (96 * SCALE, 92 * SCALE)],
        fill=(38, 45, 80, 45),
    )
    card_shadow = card_shadow.filter(ImageFilter.GaussianBlur(2 * SCALE))
    icon.alpha_composite(card_shadow)

    card = Image.new("RGBA", icon.size, (0, 0, 0, 0))
    card_draw = ImageDraw.Draw(card)
    card_draw.polygon(
        [(78 * SCALE, 91 * SCALE), (98 * SCALE, 107 * SCALE), (95 * SCALE, 87 * SCALE)],
        fill="#FFFDF8",
    )
    card_draw.rounded_rectangle(
        scaled_box((18, 23, 110, 98)), radius=21 * SCALE, fill="#FFFDF8"
    )
    icon.alpha_composite(card)

    symbol = Image.new("RGBA", icon.size, (0, 0, 0, 0))
    symbol_draw = ImageDraw.Draw(symbol)

    # Familiar Markdown M and down arrow, softened with rounded strokes.
    rounded_polyline(
        symbol_draw,
        [(33, 76), (33, 51), (49, 68), (65, 51), (65, 76)],
        "#263554",
        8,
    )
    rounded_polyline(symbol_draw, [(86, 50), (86, 75)], "#FF758B", 8)
    rounded_polyline(symbol_draw, [(76, 66), (86, 76), (96, 66)], "#FF758B", 8)
    icon.alpha_composite(symbol)

    # Tiny sparkles add a cute accent while remaining clear at 16–32 px.
    accents = Image.new("RGBA", icon.size, (0, 0, 0, 0))
    accent_draw = ImageDraw.Draw(accents)
    accent_draw.polygon(
        [(20 * SCALE, 12 * SCALE), (23 * SCALE, 18 * SCALE), (29 * SCALE, 21 * SCALE),
         (23 * SCALE, 24 * SCALE), (20 * SCALE, 30 * SCALE), (17 * SCALE, 24 * SCALE),
         (11 * SCALE, 21 * SCALE), (17 * SCALE, 18 * SCALE)],
        fill="#FFE48A",
    )
    accent_draw.ellipse(scaled_box((104, 15, 111, 22)), fill="#CFF8FF")
    icon.alpha_composite(accents)

    icon = icon.resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    icon.save(OUTPUT, format="PNG", optimize=True)
    print(f"Generated {OUTPUT} ({ICON_SIZE}x{ICON_SIZE})")


if __name__ == "__main__":
    main()
