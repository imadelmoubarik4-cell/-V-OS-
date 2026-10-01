#!/usr/bin/env python3
"""Builds the website copies of the Alcedo AI mascot from the application's own renders.

    python3 tools/build_mascot_assets.py

Inputs (byte-identical copies of the app's files in apps/web/assets/atlas-bot/, owner-approved
glass finish, commit c8dc9f0 on main):
  assets/mascot/alcedo-mascot-poster.png   full mascot, 1280 x 1280
  assets/mascot/alcedo-mascot-head.png     head-and-upper-body crop, 640 x 640
Outputs:
  assets/mascot/alcedo-mascot.webp         full mascot cropped to the figure, 600 px tall
  assets/mascot/alcedo-mascot-head.webp    launcher badge, 256 px square
Rectangular crop and resize only; nothing is redrawn.
"""
import pathlib
from PIL import Image

M = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'mascot'
poster = Image.open(M / 'alcedo-mascot-poster.png').convert('RGBA')
x0, y0, x1, y1 = poster.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
m = 16
body = poster.crop((max(0, x0 - m), max(0, y0 - m), min(poster.width, x1 + m), min(poster.height, y1 + m)))
body.resize((round(body.width * 600 / body.height), 600), Image.LANCZOS).save(M / 'alcedo-mascot.webp', 'WEBP', quality=88, method=6)
head = Image.open(M / 'alcedo-mascot-head.png').convert('RGBA')
head.resize((256, 256), Image.LANCZOS).save(M / 'alcedo-mascot-head.webp', 'WEBP', quality=90, method=6)
print('body', body.size, '-> 600 px tall; head -> 256 px')
