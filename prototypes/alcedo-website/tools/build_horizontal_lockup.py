#!/usr/bin/env python3
"""Builds the ALCEDO horizontal lockups (light and dark) for the website prototype.

The symbol paths and the outlined wordmark paths are copied verbatim from the ALCEDO Logo
Kit v1.0 file logo-color.svg; only uniform scaling and translation are applied.

    python3 tools/build_horizontal_lockup.py assets/brand/logo-color.svg   (kit copy, byte-identical)

Writes assets/brand/alcedo-horizontal-light.svg and alcedo-horizontal-dark.svg next to this
folder. Symbol bbox (from the kit): 465 x 285 units at (0, 25) in its local group; wordmark
bbox 306.674 x 43.112 at (245.285, 447.695), cap height 41.553, baseline y = 490.
"""
import pathlib, re, sys

src = pathlib.Path(sys.argv[1]).read_text()
paths = re.findall(r'\sd="([^"]+)"', src)
assert len(paths) == 10, 'expected 4 symbol paths + 6 letter paths in logo-color.svg'
symbol, word = paths[:4], paths[4:]
assert symbol[0].startswith('M 75,310') and word[0].startswith('m 264.32251')

PAD = 70           # 15 % of the 465-unit symbol width: the kit's clear-space unit
SCALE = 2.2        # wordmark cap height 41.553 x 2.2 = 91.4 = 0.32 x symbol height (285)
WORD_X = PAD + 468 + PAD            # symbol incl. 1.5-unit arc stroke overhang, then one clear-space gap
W = round(WORD_X + 306.674 * SCALE + PAD)
H = 285 + 2 * PAD
out = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'brand'

def build(fg, name, note):
    a1, a2, beak, arc = symbol
    letters = '\n'.join(f'    <path d="{d}"/>' for d in word)
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<!-- ALCEDO horizontal lockup ({name}) for the website prototype - PENDING BRAND APPROVAL.
     Composed from ALCEDO Logo Kit v1.0 (review edition): the symbol paths and the outlined
     wordmark paths of logo-color.svg, copied verbatim. Only uniform scaling and translation
     are applied; no path is redrawn or altered.
     Layout: wordmark cap height = 0.32 x symbol height; gap and outer margin = 15 % of the
     symbol width (the kit's clear-space unit, 70 units). {note} -->
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="Alcedo">
  <title>Alcedo</title>
  <g transform="translate({PAD + 1.5},{PAD - 25})">
    <path d="{a1}" fill="{fg}"/>
    <path d="{a2}" fill="{fg}"/>
    <path d="{beak}" fill="#e8732a"/>
    <path d="{arc}" fill="none" stroke="{fg}" stroke-width="3"/>
  </g>
  <g transform="translate({WORD_X},{PAD + 142.5}) scale({SCALE}) translate(-245.285,-469.2235)" fill="{fg}">
{letters}
  </g>
</svg>
'''

(out / 'alcedo-horizontal-light.svg').write_text(build('#08495c', 'light', 'Use on light backgrounds (ivory, sage, white).'))
(out / 'alcedo-horizontal-dark.svg').write_text(build('#f8f5ed', 'dark', 'Use on dark or deep-teal backgrounds.'))
print(f'{W} x {H} units ->', out)
