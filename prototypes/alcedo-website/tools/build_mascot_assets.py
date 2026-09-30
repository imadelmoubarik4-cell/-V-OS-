#!/usr/bin/env python3
"""Builds the web copies of the approved ALCEDO kingfisher mascot from its transparent master.

    python3 tools/build_mascot_assets.py        (needs pillow, numpy, opencv-python-headless)

Input:  assets/mascot/alcedo-kingfisher-master.webp  (supplied master, kept byte-identical)
Output: assets/mascot/alcedo-kingfisher.webp          full body, 600 px tall
        assets/mascot/alcedo-kingfisher-launcher.webp head and upper body, 256 px square

Only two clean-ups are applied, both to the alpha channel, never to the bird's pixels or shape:
- the body is ~99 % opaque in the master (alpha 252-253); alpha >= 248 becomes fully opaque;
- faint stray pixels (alpha <= 40) more than 7 px away from the bird are cleared.
Crops are rectangular; nothing is redrawn, warped or re-posed.
"""
import pathlib
import cv2, numpy as np
from PIL import Image

MASCOT = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'mascot'
im = Image.open(MASCOT / 'alcedo-kingfisher-master.webp').convert('RGBA')
px = np.array(im)
a = px[..., 3]
a[a >= 248] = 255
core = (a >= 128).astype(np.uint8)
far = cv2.dilate(core, np.ones((15, 15), np.uint8)) == 0
a[far & (a <= 40)] = 0
clean = Image.fromarray(px)

# Full body: bird bounding box (alpha >= 8) plus a small margin, 600 px tall.
x0, y0, x1, y1 = Image.fromarray((a >= 8).astype(np.uint8) * 255).getbbox()
m = 16
body = clean.crop((max(0, x0 - m), max(0, y0 - m), min(im.width, x1 + m), min(im.height, y1 + m)))
body.resize((round(body.width * 600 / body.height), 600), Image.LANCZOS).save(MASCOT / 'alcedo-kingfisher.webp', 'WEBP', quality=88, method=6)

# Launcher: square crop of the head and upper body (crown, eye, full bill, breast, top of the wing).
# Master coordinates: crown top y~166, bill tip x~1146; square 740 px from (412, 140).
LAUNCH = (412, 140, 412 + 740, 140 + 740)
clean.crop(LAUNCH).resize((256, 256), Image.LANCZOS).save(MASCOT / 'alcedo-kingfisher-launcher.webp', 'WEBP', quality=90, method=6)
print('body', body.size, '-> 600 px tall; launcher crop', LAUNCH, '-> 256 px')
