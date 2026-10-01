# Alcedo website (alcedo.is)

This is the public website for **Alcedo**, the new brand for the restaurant operations platform currently called Atlas, operated by Coffee & Cocktails ehf.

- **Live mode:** switched on 1 October 2026 at the owner's request. Search engines may index the pages, which carry canonical links to `https://alcedo.is/`. Nothing is published until the Netlify site is set up and the domain connected (see Hosting).
- **No app changes:** the Atlas application, its authentication, database names and production branding are unchanged. Nothing in `apps/` or `scripts/` is modified by this work.

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
assets/mascot/alcedo-mascot-poster.png / -head.png   the app's Alcedo AI mascot renders (byte-identical, main c8dc9f0)
assets/mascot/alcedo-mascot.webp / -head.webp        web copies (600 px tall / 256 px badge)
assets/fonts/*.woff2, LICENSE-OFL.txt                self-hosted fonts (SIL Open Font License)
privacy.html                                         privacy notice
404.html                                             not-found page (stays noindex)
robots.txt, sitemap.xml                              allow indexing; list the two pages
netlify.toml                                         hosting config: security headers + hashed CSP (generated)
assets/screens/*.webp                   product screenshots (current app, built-in test data)
tools/build_horizontal_lockup.py        regenerates the two lockups from the kit
tools/build_mascot_assets.py            regenerates the mascot web copies from the app renders
tools/build_netlify_toml.py             regenerates netlify.toml (re-run after editing any inline <script>)
tools/build_preview.py                  builds the single-file review copy
```

## Changing things

Search `index.html` for the marker comments: `[ASSET: …]`, `[COPY]`, `[STATUS]`, `[DESTINATION]`, `[CROP]` and `[TIMING]`.

1. **Video source and static final frame**
   - **Video:** the `<source>` inside `#hero-video` is the local `assets/hero.mp4` (no third-party fallback, so the site loads nothing from other origins). Replace the file to change the footage.
   - **Final frame:** `#hero-still` is used for reduced motion, blocked autoplay, playback failure, no-JS, and as the thumbnail source when the video can't be drawn. When the footage changes, replace `assets/hero-final.webp` with the new last frame.
2. **Logo**
   - **Header:** `assets/brand/alcedo-horizontal-light.svg`, shown at 58 px tall (about 185 px wide; the kit minimum is 180 px). Use `alcedo-horizontal-dark.svg` on dark or deep-teal surfaces.
   - **Footer:** the kit's `logo-dark.svg` (stacked lockup on its teal field).
   - **How the lockups are built:** see *Horizontal lockup* below.
3. **Mascot:** copy the app's latest `alcedo-mascot-poster.png` and `alcedo-mascot-head.png` into `assets/mascot/` and run `python3 tools/build_mascot_assets.py`. See *Mascot* below.
4. **Copy and status labels**
   - All copy is plain HTML.
   - Status chips: `.status` = **Available**, `.status--soon` = **Coming soon**. A legend on the page explains both.
   - Screenshot labels (`.shot__label`): "Sample data", "Scripted demonstration · sample data", or "Sample lessons · pre-release build".
5. **Destinations**
   - **Staff login** links directly to `https://app.alcedo.is/`, the application's address under the Alcedo domain (set by the owner on 1 October 2026; it previously pointed to `https://os-vabar.netlify.app`). Make sure `app.alcedo.is` is connected to the application before launch. The `href` is set in the HTML so it works without JavaScript; search for the URL to change it.
   - **Request a demo** links to `mailto:Alcedo@Alcedo.is` (search the page for that address to change it); a Copy address button appears where the browser allows it.
   - **Privacy** links to `privacy.html`.
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

The site uses the same Alcedo AI mascot as the application: the owner-approved glossy 3D kingfisher (`main`, commit `c8dc9f0`). It replaces the realistic kingfisher used earlier.

- **Sources:** `assets/mascot/alcedo-mascot-poster.png` (full mascot) and `alcedo-mascot-head.png` (head and upper body), byte-identical copies of `apps/web/assets/atlas-bot/`.
- **Web copies** (`tools/build_mascot_assets.py`, crop and resize only):
  - `alcedo-mascot.webp`, the full figure at 600 px tall, used in the Alcedo AI card's demonstration;
  - `alcedo-mascot-head.webp`, a 256 px badge used on the hero AI card, the scroll-progress line and the 404 page.
- **Motion:** whole-image only, as before: gentle breathing, a 3.5° listening tilt and a hop when tapped. Fully static with reduced motion.
- **Demonstration:** labelled "Mascot demonstration · not connected to the assistant". Idle, Listening and Thinking states, with status text and a progress bar for Thinking. Tapping the mascot says "Hello! I'm Alcedo AI."

## Interactive and playful layer

All interactions work by keyboard and touch. With reduced motion, the interactions still work, but without movement.

- **Daily Operations:** "Try it · tonight's opening checklist", sample tasks.
  - The four tasks are toggle buttons (`aria-pressed`).
  - A progress ring and a status line (`role="status"`) follow the ticks.
  - Completing all four shows "All done · ready for service", with a short burst of dots. The burst is skipped with reduced motion.
- **Training:** "Try it · sample lesson", a mini player.
  - Play runs a 4.2 s progress bar (`role="progressbar"`) and ticks off the four steps.
  - At the end it shows "Lesson complete" and the button becomes Replay.
  - With reduced motion, the lesson completes instantly.
- **Mascot demo:** the kingfisher is a button, "Say hello".
  - Pressing it gives a small whole-image hop and the greeting "Hello! I'm the Alcedo kingfisher."; the previous status returns after 2.2 s.
  - With reduced motion there is no hop.
- **Cards** (hero, bento and route cards):
  - a soft spotlight follows the pointer;
  - hero cards tilt up to 2.5° while hovered;
  - bento and route cards lift by 3 px;
  - pointer devices only, and no tilt or lift with reduced motion.
- **Scroll progress:** a 3 px teal-to-orange line along the top of the window, with a small kingfisher riding it. It is decorative (`aria-hidden`).
- **Tour:** the chosen screenshot panel slides in gently. This is off with reduced motion.

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

Confirmed by the owner on 1 October 2026.

| Label | Meaning | Used for |
|---|---|---|
| **Available** | In the Alcedo application today. | Inventory, Purchasing, Recipes, Stock Count, Shifts, Reports, Alcedo AI, Food Intelligence, Alcedo Training, Knowledge library |
| **Coming soon** | In development; not yet available. | Bookings |

Purchasing and Reports are marked for managers and administrators. Reports has no sales or point-of-sale connection.

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

The screenshots show the Alcedo-branded pre-release build of the app, from PR #113 at commit `4e1e5d6` (the build behind `deploy-preview-113--os-vabar.netlify.app`).

- **How they were captured:** that build's `apps/web` ran in the same commit's mocked backend (`tests/browser/harness.mjs`), with a frozen clock and no production traffic. The deploy preview itself was not reachable from the capture environment, and it would have shown real venue data.
- **Branding:** no "Atlas" wording appears in any screenshot.

- **Replaced before capture:** fixture names that could be real people, the venue name and Icelandic supplier names ("Alex Morgan", "Harbor Bar", "Northwind Wines", …).
- **Checked afterwards:** every shot's visible text, for the original names, emails and phone numbers; none remain.
- **Sample content:** the training lessons were written for the capture.
- **Staying private:** staff schedules, messages, training results, manuals and business records stay behind sign-in.

## Contact, privacy and third parties

- **Demo and contact:** `Alcedo@Alcedo.is` (mailto links; no form, so the site itself collects nothing).
- **Privacy:** `privacy.html` states that the site uses no cookies, analytics, tracking or forms. The controller is Coffee & Cocktails ehf. and the host is Netlify, Inc. One highlighted `[TO CONFIRM]` remains: the company's kennitala and registered address. The email provider is not chosen yet, so the notice describes it as "our email service provider"; if the chosen provider stores mail outside the EEA, name it in the notice.
- **No third-party requests:** fonts are self-hosted (Instrument Serif, Manrope and JetBrains Mono, latin subset, SIL OFL), and the hero video is served from the site. A test serves the page with the production security headers, and checks that nothing outside the site is requested and that there are no CSP violations.

## Hosting

Recommended: **Netlify**, as its own site, separate from the application's.

- **Setup:** connect this repository and set the base directory to `prototypes/alcedo-website`. There is no build command, and the publish directory is the folder itself.
- **Why Netlify:**
  - the team already runs the app there;
  - static hosting with free HTTPS;
  - every pull request gets a deploy preview;
  - `netlify.toml` already sets the headers.
- **Headers in `netlify.toml`:**
  - CSP, where scripts are allowed only by hash;
  - HSTS, nosniff, Referrer-Policy, Permissions-Policy and COOP;
  - `tools/` and the `.md` files are blocked from being served.
- **Domain:** add `alcedo.is` and `www.alcedo.is` to the Netlify site, then point DNS at Netlify at the registrar (ISNIC for `.is`). Netlify issues the certificate.
- **Alternative:** Cloudflare Pages is equally suitable, but its headers file is `_headers`, so `netlify.toml` would need porting.

## Open items before launch

- **Owner details for the privacy page:** kennitala and registered address of Coffee & Cocktails ehf. (the remaining `[TO CONFIRM]` marker).
- **Email:** `Alcedo@Alcedo.is` has no mail provider yet. Every contact link on the site points to it, so the mailbox must be set up and tested before launch.
- **Application domain:** every Staff login link goes to `https://app.alcedo.is/`. Connect that subdomain to the application's Netlify site (with HTTPS) and test sign-in there before launch; the app's Supabase auth settings must allow the new origin for redirects.
- **Domain:** `alcedo.is` is registered to the owner and Netlify is the chosen host (both confirmed 1 October 2026). What remains is connecting the domain (see Hosting above).
- **Go-live switch:** done 1 October 2026. `noindex` was removed, canonical links point to `https://alcedo.is/`, the prototype footer lines were replaced by "© 2026 Coffee & Cocktails ehf.", and the title is now "Alcedo — Food & beverage operations, all in one place". If the primary domain on Netlify ends up being `www.alcedo.is`, change the canonical links and `sitemap.xml` to match.
- **Brand approval:** the derived horizontal lockups.
- **Legal review:** recommended for the privacy notice.
