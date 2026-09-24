# Atlas brand (v1.0)

`Atlas_Brand_Identity_Kit_v1.0/` is the owner's Atlas Brand Identity Kit v1.0,
committed byte-for-byte as the brand source of truth. Every file matches its
sha256 in `Atlas_Brand_Identity_Kit_v1.0/ASSET_MANIFEST.csv` (the manifest has
CRLF line endings; read it with CR stripped). `tests/node/brand-kit-v1.test.js`
checks the whole kit against the manifest and checks that every brand file in
`apps/web/assets/brand/` is a byte-identical copy of its kit source.

Do not edit anything inside the kit folder. If a newer kit arrives, replace the
folder as a whole and update the copies in `apps/web/assets/brand/`.

## The identity

- One mark: the geometric **A** with the horizon arc, and the wide-tracked
  **ATLAS** wordmark. All variants are generated from
  `00_MASTER_DO_NOT_EDIT/Atlas_Master_Artwork.svg`; only layout, scale and
  colour change between them.
- Guidelines: `01_Brand_Guidelines/Atlas_Brand_Guidelines_v1.0.pdf`.

### Usage rules

1. Use only the supplied master files.
2. Never redraw the A or the horizon arc (no CSS, icon-font or hand-made SVG
   versions).
3. Never type "ATLAS" in a substitute font as a logo. "Atlas" as an ordinary
   word in copy and labels is fine; a styled wordmark is not.
4. Never change proportions or spacing inside a lockup.
5. No gradients, outlines, shadows or effects on the mark.
6. Midnight on light surfaces, White on dark surfaces. The logo is monochrome.
7. The mark alone only where the context already identifies Atlas (inside the
   app, favicons, app icons).
8. SVG for the product and web UI; the dedicated app/favicon files for platform
   surfaces; transparent PNG for raster workflows; PDF/EPS for print and vendors.

### Clear space and minimum sizes (product decision)

- Clear space: at least the height of the horizon arc on every side of a
  lockup. The kit SVGs already carry a small margin inside their viewBox; the
  shell adds padding so the visible art keeps the arc height free (about 9 px
  around the 32 px sidebar lockup, more on sign-in).
- Minimum size: horizontal lockup **96 px wide**; mark **20 px high**.
  Sidebar lockup 121 × 32 px, rail mark 27 × 24 px, phone top-bar mark
  25 × 22 px, stacked lockup 128 px wide on sign-in (matching the intro clip)
  and 112 × 99 px on invitation and recovery.

### Colours

| Name | Hex | Role |
| --- | --- | --- |
| Midnight | `#0B0F14` | Logo on light surfaces, primary text (`--text`), overlay and shadow base |
| Slate | `#1F2937` | Dark UI surfaces (`--ink`: tooltips, toasts, bulk bar) |
| Mist | `#CBD5E1` | Strong lines (`--line-strong`), toggles off |
| Snow | `#F8FAFC` | Inset surfaces (`--bg-subtle`: sidebar, table headers), app background colour |
| Atlas Blue | `#3B82F6` | Product-interface accent. **Not a logo colour.** |

## Accessibility decision: Atlas Blue vs. text

White text on Atlas Blue `#3B82F6` is **3.7:1**, which fails WCAG AA (4.5:1)
for normal text. So in the product:

- **Atlas Blue `#3B82F6`** (`--atlas-blue`, `--accent-brand`, `--focus-color`)
  is used where no text sits on it: the focus ring, the active-nav marker,
  selection indicators, unread dots, icons, charts. As a non-text colour it
  clears 3:1 on white (3.7), Snow (3.5), `#f1f5f9` (3.4), `#eff6ff` (3.4) and
  Slate (4.0).
- **`--accent` `#2563EB`** (same hue, darker) is used for text-bearing fills
  (primary buttons, count badges: white text 5.2:1) and for blue text and links
  (5.2:1 on white, 4.8:1 on `--accent-soft`). Hover `#1D4ED8` (6.7:1), pressed
  `#1E40AF`.
- **`--accent-soft` `#EFF6FF`** / `--accent-soft-hover` `#DBEAFE` are washes of
  Atlas Blue for selected rows, active chips and info tiles.

The full token table and ratios are in `docs/design/Atlas_Design_System.md` §1;
`tests/node/brand-kit-v1.test.js` fails if a text pair drops below 4.5:1 or the
focus ring below 3:1.

## Where each asset is used in the product

All web copies live in `apps/web/assets/brand/` (byte-identical to the kit).

| Kit file | Web copy used by |
| --- | --- |
| `02_Vector_Logos/Atlas_Primary_Horizontal_Midnight.svg` | Sidebar brand row at ≥ 1280 px and the overlay sidebar (`index.html`, `.atlas-brand__lockup`); `docs/design/atlas-reference.html` |
| `02_Vector_Logos/Atlas_Primary_Horizontal_White.svg` | Shipped for dark surfaces; no dark surface shows the logo today |
| `02_Vector_Logos/Atlas_Primary_Stacked_Midnight.svg` | Sign-in (`index.html`), `invitation.html`, `recovery.html` (`.atlas-auth__lockup`); reference sign-in |
| `02_Vector_Logos/Atlas_Mark_Midnight.svg` | Sidebar rail at 768–1279 px (`.atlas-brand__mark`), phone top bar (`.atlas-topbar__mark`); reference rail |
| `02_Vector_Logos/Atlas_Mark_White.svg` | Shipped for dark surfaces; not placed yet |
| `05_Favicons_Web/favicon.ico`, `favicon.svg`, `favicon-16x16.png`, `favicon-32x32.png`, `favicon-48x48.png` | `<link rel="icon">` in `index.html` (all five); `invitation.html` and `recovery.html` (ico, svg, 32 px) |
| `05_Favicons_Web/apple-touch-icon.png` | `<link rel="apple-touch-icon">` on the same pages |
| `05_Favicons_Web/favicon-192x192.png`, `favicon-512x512.png` | `apps/web/site.webmanifest` icons; push notification icon (`service-worker.js`) |
| `05_Favicons_Web/site.webmanifest` | Adapted (not copied) as `apps/web/site.webmanifest`: name "Atlas", `theme_color` Midnight, `background_color` Snow, icon paths into `assets/brand/`, `start_url`/`scope` `./`, `display: standalone` |
| `06_Social/Atlas_OpenGraph_1200x630.jpg` | `og:image` on `index.html` |

Not shipped to the web bundle (kept in the kit for other channels): the Black
mark, White stacked lockup, wordmark-only files, EPS/PDF vectors, transparent
PNGs, the app icon tiles (`04_App_Icons`), the social avatar, the 64 px favicon.

`apps/web/menu.html` is the venue's public menu, not an Atlas page: it keeps
the venue's own brand and has no Atlas favicon.

The retired `apps/web/atlas-icon.png` and `apps/web/assets/logo/atlas-icon.png`
were removed.

## Sign-in motion (owner-approved exception)

The owner approved one motion asset: a short rotating-logo clip on the
**sign-in screen only** (`index.html` login view). This is an explicit,
owner-approved exception to guideline rule 05 ("no effects on the master
mark") for this single asset and this single place. The clip is **not** an
official logo file: the static kit lockup remains the logo everywhere,
including on the sign-in screen before, after and instead of the clip.

- Source (byte-exact, with audio): `docs/brand/motion/Atlas_Logo_Rotation_source.mp4`
  (sha256 `b3279e9d…b307dc`).
- Web encodes (audio stripped, 960 px, faststart):
  `apps/web/assets/brand/motion/atlas-signin-intro.webm` (VP9) and
  `atlas-signin-intro.mp4` (H.264), hashes pinned in
  `tests/node/brand-kit-v1.test.js`.
- Behaviour (`apps/web/assets/js/atlas-signin-intro.js`): starts only once the
  app knows there is no session; `muted`, `playsinline`,
  `disablepictureinpicture`, `aria-hidden="true"` (decorative — the heading and
  the static lockup's `alt="Atlas"` carry the meaning); never loops, no
  controls; plays at most once per browser session (`sessionStorage`
  `atlas.signinIntro.played.v1`; if storage is unavailable it does not play);
  never plays with `prefers-reduced-motion: reduce`, `html.atlas-reduce-motion`,
  Save-Data, or when autoplay is refused. `autoplay` and `preload="auto"` are
  set by the script only when it may play, so a reduced-motion visitor never
  downloads or starts it. On `ended` it crossfades (400 ms; none under reduced
  motion) to the kit's `Atlas_Primary_Stacked_Midnight.svg`, positioned where
  the clip's logo lands. The form is interactive immediately.
- Presentation: a 16:9 stage (320 px desktop, `clamp(240px, 70vw, 320px)` on
  phones) on the Snow sign-in page; the clip's light-grey studio background is
  lifted to Snow (`brightness(1.085)`) and its edges dissolve through a radial
  mask, so no rectangle shows.
- Not on invitation, recovery or any page of the app shell. The service worker
  has no fetch handler, so the clip is never precached (network only).

## Not yet branded

- The Atlas AI page (`atlas-ai.js` / `atlas-ai.css`) is being rebuilt on another
  branch. It uses the tokens, so its colours follow automatically; its empty
  state may use `Atlas_Mark_Midnight.svg` (via `<img>`) when it lands.
