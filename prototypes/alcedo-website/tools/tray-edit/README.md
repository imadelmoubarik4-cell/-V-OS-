# Hero tray edit

`assets/hero-tray.mp4` is `assets/hero.mp4` (the original footage) with the twig replaced by the approved
round black non-slip serving tray, held from below by a hand. The reference is
`assets/reference/tray-hand-reference.webp`. The real bird is the original footage, not a regenerated one.

- `build_tray_layer.py` cuts the tray, hand and sleeve out of the reference.
  - It removes the reference's own bird and fits the sage backdrop.
  - It rebuilds the parts of the tray that the reference bird covered, plus the right end beyond the image edge, from the tray's measured ellipse. The rebuild uses mirrored texture bands next to each gap.
  - It writes `tray_layer_wide.png` (RGBA).
- `stab_closeup.json` holds a per-frame transform for the close-up (frames 97–192).
  - It was measured by tracking features on the original twig.
  - It cancels the twig's bounce (up to about 25 px) after the landing, so the perch point is fixed and the tray can stay steady under the feet.
  - The bird's own movement is kept.
- `compose.py` builds every frame.
  - It paints out the twig with a fitted backdrop plate plus matched grain.
  - It places the tray lip where the toes gripped the twig: close-up (640, 565) at 0.80× the reference scale; wide shot (585, 700) at 0.64×.
  - It adds contact shadows under the toes and a soft body shadow on the tray.
  - It keeps the real bird in front using a matte from the backdrop difference.
  - Pixels away from the tray and twig are the original frame, unchanged.

Rebuild (needs `opencv-python-headless`, `numpy`, and ffmpeg):

```bash
mkdir -p full && ffmpeg -i ../../assets/hero.mp4 full/f%03d.png
cp ../../assets/reference/tray-hand-reference.webp ref.webp
python3 build_tray_layer.py && python3 compose.py
ffmpeg -framerate 24 -i out/o%03d.png -c:v libx264 -profile:v high -preset slow -crf 18 \
  -pix_fmt yuv420p -movflags +faststart -an ../../assets/hero-tray.mp4
```

Checks run on the encoded file:
- 192 frames, 8.00 s, 24 fps; the cut stays at frame 97 (4.00 s), as in the original.
- **Front foot:** within 2 px of its final position in every close-up frame.
- **Back toes:** stay on the rim line (checked on a frame sheet); the leg above moves as the bird settles.
- **Tray and hand:** frame-to-frame change 0.31 on a 0–255 scale, which is codec noise only.
