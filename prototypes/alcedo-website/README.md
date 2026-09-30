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
assets/brand/symbol-color.svg           kit symbol (reference copy)
assets/brand/logo-dark.svg, favicon.ico, icon-32.png, icon-180.png   kit files used by the page
assets/mascot/alcedo-kingfisher-master.webp    approved transparent kingfisher master (supplied, byte-identical)
assets/mascot/alcedo-kingfisher.webp           full-body web copy (600 px tall)
assets/mascot/alcedo-kingfisher-launcher.webp  head-and-upper-body launcher crop (256 px square)
assets/screens/*.webp                   product screenshots (current app, built-in test data)
tools/build_horizontal_lockup.py        regenerates the two lockups from the kit
tools/build_mascot_assets.py            regenerates the two mascot web copies from the master
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
3. **Mascot:** replace `assets/mascot/alcedo-kingfisher-master.webp` and run `python3 tools/build_mascot_assets.py`. See *Mascot* below.
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

## Mascot

The approved Alcedo kingfisher replaces the robot everywhere in this prototype. The application's own assistant and robot are unchanged; the app-side replacement belongs on `claude/alcedo-rebrand`.

- **Master:** `assets/mascot/alcedo-kingfisher-master.webp`, 1214×1295 with genuine transparency, kept byte-identical as supplied.
- **Edge check:** on ivory, deep teal, near-black and sage there is no white halo; fur edges are soft and the bill tip and claws are crisp. Only 0.2 % of the semi-transparent edge pixels are very light.
- **Web copies** (`tools/build_mascot_assets.py`), which change the alpha channel only, never the bird's pixels or shape:
  - the master's body is about 99 % opaque (alpha 252–253), so alpha of 248 or more becomes fully opaque;
  - 2,891 faint stray pixels (alpha ≤ 34) more than 7 px from the bird are cleared.
- **Versions:**
  - full body, 600 px tall, used in the mascot demonstration;
  - head and upper body, a square crop of crown, eye, full bill, breast and top of the wing at 256 px, used as the compact launcher on the Alcedo AI hero card.
- **Motion:**
  - whole image only: gentle idle breathing (1.4 % scale over 5.2 s) and a 3.5° listening tilt, both pivoting at the feet;
  - no new poses, no warping of the bill or wings, no opacity blinking;
  - reduced motion: completely static, with no breathing, no tilt and a static progress bar.
- **Demonstration:** it sits in the Alcedo AI card and is labelled "Mascot demonstration · not connected to the assistant".
  - **States:** Idle, Listening and Thinking buttons (`aria-pressed`) switch the preview.
  - **Status text:** a `role="status"` line announces "Ready to help", "Listening…" or "Thinking — preparing a draft for you to approve".
  - **Progress:** Thinking shows an indeterminate `role="progressbar"`.
  - **Without JavaScript:** the static mascot shows and the buttons stay hidden.

## Food Intelligence card

The card shows an illustrated **Flavor Map**, modelled on the app's pairing ring. It is labelled "Flavor Map · illustration with sample data".

- **Content:**
  - London dry gin sits in the centre, with six pairings around it: Lemon, Tonic water, Sweet vermouth, Basil, Honey and Mint.
  - Each pairing shows its stock state: filled dot = in stock, ring = not in stock, dashed ring = stock unknown.
  - Each pairing also shows its source, as the app labels it: "Culinary pairing", or "Learned from your recipes".
  - No strengths, confidence scores or other numbers are shown.
- **Motion:**
  - when the card scrolls into view, the lines draw out from the centre and the pairings fade in, staggered;
  - a tour then highlights one pairing every 3.4 s: the line turns orange, a spark travels along it, and the caption updates;
  - the tour runs only while the map is on screen and the tab is visible;
  - hovering or focusing the map pauses it, and a **Pause / Play tour** button stops it for good (WCAG 2.2.2).
- **Interaction:**
  - every pairing is a button (`aria-pressed`) with a full accessible name, for example "London dry gin and Sweet vermouth: learned from your recipes, in stock";
  - choosing one stops the tour and announces the caption;
  - automatic tour steps are not announced.
- **Reduced motion:** a static map with no draw-in, tour, spark or Pause button; choosing a pairing still works.
- **No JavaScript:** the full static map, with the first pairing captioned.
- **Narrow cards:** below 300 px of card width (three bento columns at about 900–1000 px), the map becomes taller so labels never collide. Checked at 360–1280 px.
- **Where to edit:** the pairings are the `.fmap__node` buttons. Change `data-name`, `data-source`, `data-stock`, the label, and the `--x` / `--y` position (the percentage of a 320 × 230 map). The matching line is the `<path>` with the same `data-key`.

## Colours

The dark surfaces use the brand kit's **deep teal `#08495C`** with **warm ivory `#F8F5ED`** text and restrained orange accents. That covers the hero feature cards, Daily Operations, the restaurant-owners card, the closing CTA and the footer. Deep-teal buttons and the selected tour tab follow the same token, so no near-black surfaces remain. The light cards stay ivory and the hero stays sage. Shadows are softer and teal-tinted, and hairlines on teal use ivory at 16 %.

- **Where to change it:** the shared tokens `--panel`, `--on-panel`, `--on-panel-2`, `--panel-line`, `--teal-2`, `--shadow` and `--shadow-soft` in `:root`. Desktop and mobile use the same tokens.
- **Footer logo:** the kit's `logo-dark.svg` sits on the teal footer, and its own teal field (the same `#08495C`) merges with it. Logo colours and geometry are unchanged.

Contrast checked (WCAG 2.x):

| Pair | Ratio |
|---|---|
| Ivory on deep teal (titles, body, buttons, selected tab) | 9.10:1 |
| Ivory 80 % on deep teal (descriptions, footer small print) | 6.46:1 |
| Status text `#9ED6DA` on deep teal | 6.18:1 |
| Orange `#F3A15E` labels on deep teal | 4.75:1 |
| Ink on orange buttons | 5.54:1 |
| Orange dots and buttons against deep teal (non-text) | 3.27:1 |
| Outline-button border (ivory 60 %) on deep teal (non-text) | 4.34:1 |
| Deep-teal button against ivory / sage (non-text) | 9.10:1 / 5.39:1 |

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
  - the derived horizontal lockups and the mascot crops;
  - the kit itself, which is a review edition;
  - the giant ALCEDO word, which is decorative serif type, separate from the logo.
- **Domain:** `alcedo.is` is shown as the *intended* domain only.
- **Destinations:** demo/contact and privacy details are still to be supplied.
- **Product sign-off:** confirm the status labels.
