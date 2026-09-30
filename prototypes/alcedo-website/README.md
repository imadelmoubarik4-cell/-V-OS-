# Alcedo website — platform preview (prototype)

This is a website prototype for **Alcedo**, the proposed new brand direction for the restaurant operations platform currently called Atlas. It is **for review only**:

- not deployed, not linked from the application, and marked `noindex`;
- the Atlas application, its authentication, database names and production branding are unchanged. Nothing in `apps/` or `scripts/` is modified by this work.

`index.html` holds all CSS and JavaScript inline, with no framework and no build step. Media are separate files in `assets/`.

For the complete file list with sizes, hashes and provenance, see **[INVENTORY.md](INVENTORY.md)**.

## Preview

- **Run it locally:**

  ```bash
  npx http-server prototypes/alcedo-website -p 8080     # open http://localhost:8080
  ```

  Serve over HTTP so background-colour matching can read the local video. Everything else also works from `file://`.
- **Single-file review copy:**

  ```bash
  python3 prototypes/alcedo-website/tools/build_preview.py /tmp/alcedo-preview.html
  ```

  This embeds every local asset as a data URI (about 2.9 MB), so reviewers can open the one file anywhere. It is generated on demand, not committed.

## Folder

```text
index.html                              the page
INVENTORY.md                            every file on this branch: bytes, sha256, provenance
assets/hero.mp4                         supplied hero footage (8.0 s, 1280×720, 24 fps, H.264 High)
assets/hero-final.webp                  its last frame (8.00 s)
assets/brand/alcedo-horizontal-*.svg    horizontal lockups (light / dark), derived, pending brand approval
assets/brand/logo-color.svg             kit source of the lockup paths (input to the lockup script)
assets/brand/symbol-color.svg           kit symbol (source of the robot decal paths)
assets/brand/logo-dark.svg, favicon.ico, icon-32.png, icon-180.png   kit files used by the page
assets/ai-robot-alcedo.png              the app's AI robot re-rendered with the Alcedo symbol
assets/screens/*.webp                   product screenshots (current app, built-in test data)
tools/build_horizontal_lockup.py        regenerates the two lockups from the kit
tools/robot-alcedo-mark.patch           the only change to the robot scene (mark texture)
tools/render_robot_alcedo.sh            regenerates ai-robot-alcedo.png (never writes into apps/)
tools/build_preview.py                  builds the single-file review copy
```

## Changing things

Search `index.html` for the marker comments: `[ASSET: …]`, `[COPY]`, `[STATUS]`, `[DESTINATION]`, `[CROP]` and `[TIMING]`.

1. **Video source and static final frame**
   - **Video:** the `<source>` elements inside `#hero-video` are tried in order: local `assets/hero.mp4` first, then the reference URL `https://thinkingods.com/demos/kingfisher-hero/hero.mp4`. Reorder or replace them.
   - **Final frame:** `#hero-still` is used for reduced motion, blocked autoplay, playback failure, no-JS, and as the thumbnail source when the video can't be drawn. When the footage changes, replace `assets/hero-final.webp` with the new last frame.
2. **Logo**
   - **Header:** `assets/brand/alcedo-horizontal-light.svg`, shown at 58 px tall (about 185 px wide; the kit minimum is 180 px). Use `alcedo-horizontal-dark.svg` on dark or deep-teal surfaces.
   - **Footer:** the kit's `logo-dark.svg` (stacked lockup on its teal field).
   - **How the lockups are built:** see *Horizontal lockup* below.
3. **AI robot:** `--robot-sprite` in `:root`. See *Robot* below.
4. **Copy and status labels**
   - All copy is plain HTML.
   - Status chips: `.status` = **Implemented**, `.status--preview` = **Preview**, `.status--soon` = **Coming soon**. A legend on the page explains all three.
   - Screenshot labels (`.shot__label`): "Sample data", "Scripted demonstration · sample data", or "Sample lessons · pre-release build".
5. **Destinations**
   - **Staff login** links directly to `https://os-vabar.netlify.app`, the current application origin documented in `docs/DEPLOYMENT.md`. The `href` is set in the HTML so it works without JavaScript; search for the URL to change it.
   - **Request a demo** and **Privacy** stay labelled *prototype destinations*. Set `DESTINATIONS.requestDemo` and `DESTINATIONS.privacy` at the top of the script once the details are supplied; while empty, links go to the labelled blocks on the page.
   - Nothing is submitted, collected or stored, and no second authentication system exists.
6. **Thumbnail crops:** `data-crop="centreX,centreY,size"` on each hero-card canvas. Current values:
   - head `0.555,0.335,0.22`;
   - wing `0.43,0.60,0.24`;
   - perch `0.50,0.79,0.24`.

   Crops are drawn at device pixel ratio, only from the true final frame.
7. **`REVEAL_AT`**
   - Set to `4.3` seconds. In the supplied clip there is a hard cut to the perched close-up at 4.00 s, and motion settles by about 4.3–4.4 s.
   - For another clip, scrub to the first frame where the bird is settled and set that time.
   - The 9 s `FALLBACK_MS` still guarantees the content appears.

## Horizontal lockup

The kit (v1.0, review edition) has only stacked lockups, so the two horizontal versions are **derived** and pending brand approval.

- **Source:** the four symbol paths and the six outlined letter paths are copied verbatim from `logo-color.svg`. Only uniform scale and translation are applied.
- **Proportions:** wordmark cap height = 0.32 × symbol height. The gap and outer margins equal the kit's clear-space unit, 15 % of the symbol width (70 units).
- **Colours:** light version in deep teal `#08495C`, dark version in ivory `#F8F5ED`, with the orange beak `#E8732A` in both.
- **Rebuild:** `python3 tools/build_horizontal_lockup.py assets/brand/logo-color.svg`.
- **Note for brand:** the kit's horizon arc is a 3-unit stroke, so it renders as a hairline (about 0.4 px) at header size.

## Robot

`assets/ai-robot-alcedo.png` is the application's own robot (`scripts/mascot/atlas-mascot-scene.src.mjs`), rendered by the repository's renderer (`scripts/render_atlas_bot_badges.mjs`).

- **What changed:** only the decal texture. The Atlas mark is replaced by the ALCEDO symbol paths (teal A, orange beak, teal arc), drawn at the decal's aspect so the symbol keeps its proportions.
- **What is preserved:** the model, materials, lighting, framing and the four sprite frames (open · blink · sleep · happy) that drive the blink animation.
- **Verification:**
  - rendering the unmodified scene through the same pipeline reproduces the app's committed `atlas-bot.png` pixel for pixel;
  - in the Alcedo render, only the forehead and chest mark regions differ, and the face and visor rows are identical in all four frames.
- **Rebuild:** `tools/render_robot_alcedo.sh`. It works in a temp folder and needs npm access and Playwright Chromium.

The application's own robot is unchanged.

## Status labels

| Label | Meaning | Used for |
|---|---|---|
| **Implemented** | Built in the current application and checked against its code. Production rollout is **not** confirmed by this page. | Inventory, Purchasing, Recipes, Stock Count, Shifts, Reports, Alcedo AI, Knowledge library |
| **Preview** | Built; release awaiting approval. | Food Intelligence: `docs/flavor/Deployment.md` requires owner approval, and the live site is not confirmed. |
| **Coming soon** | Built; not yet deployed. | Alcedo Training: `docs/release/Atlas_Training_MVP.md` records no production migration applied. |

Purchasing and Reports are marked for managers and administrators. Reports has no sales or point-of-sale connection. The AI only reads and drafts; a person approves every change. The Discover intro reads "explore implemented capabilities and upcoming features", matching the legend beside it.

## Testing

Two browser suites ran against this page. They are kept **separate**:

- **H.264 (original file):** Google Chrome for Testing 140.0.7339.207, which reports `canPlayType('video/mp4; codecs="avc1.64001F"') === "probably"`. It plays the unmodified `assets/hero.mp4` (sha256 `4caf7b35…40df`, H.264 High, 1280×720, 24 fps).
- **VP9 (substitute encode):** Playwright's bundled Chromium, which has no H.264 decoder. Requests for `hero.mp4` are answered with a VP9 re-encode of the same clip.

Both suites cover:

- **Playback:** the landing reveal and its timing, final-frame retention, replay, pause/resume, and the hard 9 s timeout.
- **Failures:** video failure with and without the still, a hanging network, blocked autoplay, and slow fonts.
- **Accessibility:** keyboard order, reduced motion, no-JS, the mobile menu, and 200 % zoom.
- **Layout:** 11 viewports (360–2560 px, including short landscape) with no horizontal overflow and thumbnails drawn.

Results for this revision:

- **H.264 suite:** 66/66 checks passed. The playing source was the local `assets/hero.mp4`, at 1280×720, with 108 frames decoded and none dropped at the landing. The reveal fired at 4.335 s, and replay revealed again at 4.344 s.
- **VP9 suite:** 65/65 checks passed. The reveal fired at 4.325 s, and replay revealed again at 4.316 s. It has one check fewer because the H.264 source check does not apply.

## Screenshots and privacy

The screenshots show the real `apps/web` UI running in the repository's mocked backend (`tests/browser/harness.mjs`), with a frozen clock and no production traffic.

- **Replaced before capture:** fixture names that could be real people, the venue name and Icelandic supplier names ("Alex Morgan", "Harbor Bar", "Northwind Wines", …).
- **Checked afterwards:** every shot's visible text, for the original names, emails and phone numbers; none remain.
- **Sample content:** the training lessons were written for the capture.
- **Staying private:** staff schedules, messages, training results, manuals and business records stay behind sign-in.

## Open items before publication

- **Brand approval**
  - the derived horizontal lockups and the re-rendered robot;
  - the kit itself, which is a review edition;
  - the giant ALCEDO word, which is decorative serif type, separate from the logo.
- **Domain:** `alcedo.is` is shown as the *intended* domain only.
- **Destinations:** demo/contact and privacy details are still to be supplied.
- **Product sign-off:** confirm the status labels.
