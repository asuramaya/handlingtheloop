#!/usr/bin/env python3
"""Generate the site's default social-share card (public/og.png, 1200x630).

WHY A SCRIPT AND NOT A CHECKED-IN BINARY: an og:image is brand surface, and a PNG in the repo
with no source is a dead end the first time the wordmark or the palette changes. This is the
source. Re-run it; do not hand-edit the output.

    python3 scripts/make-og-image.py

Palette and mark are taken from the real brand, not invented: #050507 ground and the cyan ring +
magenta centre come straight from public/favicon.svg; #e8eef5 / #8b9bad / #00e5ff are the
landing page's own values. The headline is landing.html's <h1>, verbatim.

1200x630 is the size every major unfurler wants (Slack, Discord, iMessage, X, Facebook,
LinkedIn) and is the 1.91:1 ratio og:image is specified against.
"""
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
GROUND = (5, 5, 7)
PANEL = (11, 15, 20)
CYAN = (0, 229, 255)
MAGENTA = (255, 45, 156)
TEXT = (232, 238, 245)
MUTED = (139, 155, 173)

F = "/usr/share/fonts/truetype/lato/"
title_f = ImageFont.truetype(F + "Lato-Black.ttf", 78)
tag_f = ImageFont.truetype(F + "Lato-Regular.ttf", 40)
foot_f = ImageFont.truetype(F + "Lato-Bold.ttf", 27)

img = Image.new("RGB", (W, H), GROUND)
d = ImageDraw.Draw(img)

# A soft panel band behind the text so the card still reads on a light chat background that
# letterboxes it — unfurlers crop and pad unpredictably.
d.rounded_rectangle([40, 40, W - 40, H - 40], radius=28, fill=PANEL)

# THE MARK — the favicon's record, drawn large. Supersampled 4x then downscaled, because PIL's
# ellipse has no antialiasing and a jagged ring is worse than no mark.
S = 4
mark = Image.new("RGBA", (300 * S, 300 * S), (0, 0, 0, 0))
md = ImageDraw.Draw(mark)
cx = cy = 150 * S
md.ellipse([cx - 96 * S, cy - 96 * S, cx + 96 * S, cy + 96 * S], outline=CYAN, width=17 * S)
md.ellipse([cx - 30 * S, cy - 30 * S, cx + 30 * S, cy + 30 * S], fill=MAGENTA)
mark = mark.resize((300, 300), Image.LANCZOS)
img.paste(mark, (96, 165), mark)

x = 452
d.text((x, 210), "Handling", font=title_f, fill=TEXT)
d.text((x, 292), "The Loop", font=title_f, fill=CYAN)
d.text((x, 396), "A DJ rig that runs in a browser tab.", font=tag_f, fill=MUTED)

# The one line that says what it costs and what it needs, which is the whole pitch.
d.text((x, 470), "FREE  ·  NO DOWNLOAD  ·  STEM SEPARATION", font=foot_f, fill=CYAN)

img.save("public/og.png", "PNG", optimize=True)
print(f"public/og.png  {W}x{H}")
