# VÁ website redesign (vábar.is)

A redesign prototype for **vábar.is** (`https://www.xn--vbar-5na.is/`), the public site of VÁ at Hafnartorg, Reykjavík. It is a separate project: nothing in `apps/`, `packages/` or the root `package.json` changes.

- **Status:** ready for review. Hours, address, menu link and drinks are real; the page is indexable and SEO-ready (see *SEO*). The live vábar.is is still the Wix site until the domain is moved (see *Hosting*).
- **Stack:** Vite, React 19, TypeScript, Tailwind CSS v4 and the shadcn/ui project structure (`components.json`, `@/` alias, `src/components/ui`, `src/lib/utils.ts`).
- **Brand:** follows the owner's brand manual (`MANUAL_DE_MARCA.pdf`, supplied 2 October 2026, not committed). See *Brand* below.
- **No third-party requests:** fonts (Quicksand and IBM Plex Sans) are self-hosted via `@fontsource`, and three.js and GSAP are bundled.

## Run it

```bash
cd prototypes/vabar-website
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check (tsc -b) + production build into dist/
npm run preview    # serve dist/ at http://localhost:4173
```

## Why a new project folder

The rest of this repository is plain HTML/JS with no build step: no React, TypeScript, Tailwind or shadcn. The two supplied components (`horizon-hero-section.tsx`, `flow-button.tsx`) are React + TypeScript + Tailwind, so they need a project that supports all three. That setup lives in its own folder, with its own `package.json` and lockfile, so the app and its tests are untouched.

### How this folder was set up (and how to recreate it)

The shadcn CLI can do the same setup in one go:

```bash
npm create vite@latest vabar-website -- --template react-ts   # React + TypeScript
cd vabar-website
npm install tailwindcss @tailwindcss/vite                      # Tailwind v4
# vite.config.ts: add tailwindcss() to plugins and alias "@" -> ./src
# tsconfig.json + tsconfig.app.json: "paths": { "@/*": ["./src/*"] }
# src/index.css: @import "tailwindcss";
npx shadcn@latest init                                         # writes components.json, src/lib/utils.ts, CSS tokens
npm install three gsap lucide-react && npm install -D @types/three
```

Here the files were written by hand to the same layout (TypeScript 7 no longer accepts `baseUrl`, so only `paths` is used). `npx shadcn@latest add <component>` works in this folder and writes into `src/components/ui`.

### Default paths

| What | Path | Set in |
|---|---|---|
| UI components | `src/components/ui` (import as `@/components/ui/...`) | `components.json` → `aliases.ui` |
| Other components | `src/components` (`site/` for page sections, `demos/` for the supplied demos) | `components.json` → `aliases.components` |
| Global styles and theme tokens | `src/index.css` | `components.json` → `tailwind.css` |
| `cn()` helper | `src/lib/utils.ts` | `components.json` → `aliases.utils` |

**Why `components/ui` matters:** it is where the shadcn CLI installs components, and copied components (like the two here) import each other and `@/lib/utils` through that path. If the folder or the `@/` alias were missing, `npx shadcn add` would write to the wrong place and imports such as `@/components/ui/horizon-hero-section` in the demos would not resolve. Keeping primitive, reusable UI there also separates it from page-specific sections (`src/components/site`).

## Brand

- **Logo:** `src/assets/brand/va-logo.svg` is the **solo logo**: the VÁ mark without the "Cocktails | Tapas | Wines" slogan. It uses the white and terracotta-gradient version for dark backgrounds.
  - **Source:** the vector paths are copied from page 10 of the brand manual. The slogan and the page background were removed, the viewBox was cropped to the mark, and coordinates were rounded to two decimals. The shapes and colours are unchanged.
  - **Where it appears:** small in the top-left of the header (always visible, 56–64 px wide), plus the navigation overlay and the footer at the same small size, and the favicon. It is never shown large.
  - **Slogan:** the lockup is not used anywhere. Cocktails, tapas and wines are mentioned in the copy instead (hero line and marquee).
- **Colours** (tokens in `src/index.css`):

  | Manual name | Hex | Token |
  |---|---|---|
  | Azul primario | `#143A4D` | `--navy` (cards, panels) |
  | Azul secundario | `#2D5668` | `--ocean` |
  | Terracota primario | `#E08D6D` | `--copper` (accents, button fills, labels) |
  | Terracota secundario | `#A15C3F` | `--rust` (gradients) |
  | Charcoal (manual backgrounds) | `#2E2E2E` | `--charcoal`; the page background is `#262626` |

  The hero scene uses the same colours: navy mountain layers and a terracotta glow.
- **Type:** the manual's typeface, *Bubbleboddy Neue*, is a **trial** font and can't be shipped. **Quicksand** (SIL OFL), a close rounded geometric face, stands in for headings. IBM Plex Sans is used for body text. If a full Bubbleboddy Neue web licence is bought, add it with `@font-face` and it takes over: it is already first in `--font-display`.

## Components

### `src/components/ui/horizon-hero-section.tsx`

The supplied WebGL hero (three.js star field, nebula, mountain layers and bloom; GSAP intro), ported to TypeScript. Styles are in `horizon-hero-section.css` next to it, since the original relied on CSS classes that were not supplied. The default export and the `Component` named export keep the original API, so `src/components/demos/horizon-hero-demo.tsx` (the supplied `demo.tsx`) works unchanged.

Changes from the original:

- **Props:** `slides`, `menuLabel`, `scrollLabel`, `palette`, `onMenuClick`, `logo` (optional; shown instead of the landing title text, not used on this page) and `children` (rendered under the landing subtitle). All default to the original content and colours.
- **Scroll range:** progress is measured over the hero only (it was the whole document), so the page continues below. The canvas sits in a sticky stage and the slides scroll over it.
- **Title intro:** the landing title is now split into characters, so the GSAP character animation actually runs. The original reused `titleRef` / `subtitleRef` on every slide, so the refs ended up on the last slide.
- **Robustness:** typed refs, arrays reset on remount (React StrictMode), composer and atmosphere disposed, and rendering pauses while the hero is off-screen or the tab is hidden. With no WebGL, a CSS gradient shows and the text still appears.
- **Accessibility:**
  - the side menu is a real `<button>` that opens the site navigation;
  - the canvas and progress bar are `aria-hidden`;
  - with reduced motion, one still frame is drawn (re-rendered on scroll), with no float or intro animation.
- **Sizing:** long titles shrink to fit (`--chars`), so "HAFNARTORG" never overflows.

### `src/components/ui/flow-button.tsx`

The supplied FlowButton. The default look and the demo (`src/components/demos/flow-button-demo.tsx`) are unchanged. Additions:

- `tone="light"` for dark backgrounds (ivory outline, with a terracotta fill on hover);
- `href` renders an `<a>`;
- other props pass through;
- a focus ring;
- a 320 px fill circle (was 220 px), so longer labels are fully covered.

It is used for every call-to-action button on the page.

## The page

`src/App.tsx` puts it together. Copy and venue facts are in `src/content.ts`; the menu is in `src/menu-data.ts`. Both are in English and Icelandic.

1. **Header:** the solo logo, section links (Drinks, Happy hour, Shake, Visit), the **EN / IS** switch, **Book a table** and a Menu button (on phones, booking is a calendar icon next to the menu button). On phones, links open in a full-screen overlay (the hero's side menu opens it too).
2. **Hero:** the 3D horizon scene with three words. The scene changes mood with each word, blending smoothly as you scroll (sky glow, mountains, atmosphere, background and title glow). The moods are `heroScenes` in `src/content.ts`.
   - **COCKTAILS** (*KOKTEILAR*): a photo story of a cocktail being made: **pour → garnish → present**. The photos cross-fade every 4.5 s with a slow zoom, under a dark fade so the word stays readable, with the 3D scene dimmed on top. Rising **bubbles** float over it. "Handcrafted at the bar, from our signatures to the classics", with the See the menu and Find us buttons.
   - **TAPAS:** a photo of tapas on slate (soft-focus, because the supplied file is only 239×158 px), warm saffron tones and drifting golden **sparks**. "Mediterranean-inspired plates, made for sharing". To use a sharper photo, replace `src/assets/hero/tapas.webp` (landscape, at least 1600 px wide) and remove `soft: true` in `heroScenes`. If it is a stock photo, check the licence covers a business website.
   - **WINE** (*VÍN*): the owner's photo of a wine glass with the VÁ logo etched in its base (`src/assets/hero/wine-glass.webp`), under a burgundy colour wash (`tint`), with slow glossy rosé **drops**. "Curated wines by the glass or bottle, at Hafnartorg in Reykjavík".
   - **Stars:** kept sparse (about 1,100 per layer on desktop and 600 on phones, smaller than before) so they stay in the background.
   - **Play:** tap or click anywhere on the background for a burst of that word's particles. The scene leans gently towards the mouse. A small "Tap to play" hint disappears after the first tap. With reduced motion, the photos and particles stay still.
   - **Replacing the COCKTAILS photos:** overwrite `src/assets/hero/cocktails-pour.webp`, `cocktails-garnish.webp` and `cocktails-present.webp` (portrait, about 1080×1920) and rebuild. The current files are stand-ins from the bar photos until Imad's pour, garnish and present shots arrive as files.
3. **Marquee:** "Cocktails ✦ Coffee ✦ Tapas ✦ Wines ✦ Happy hour 15–18 ✦ Hafnartorg".
4. **Our story** (`#story`): "One shared vision", with the founders' text from the current site and the numbers 20 (years of experience), 2024 (opened) and 101 (downtown Reykjavík), which count up as they scroll in.
5. **On the menu** (`#drinks`): the whole printed menu with prices, in six tabs:
   - Cocktails: signature, most popular, frozen, hot;
   - Spritz & zero proof, including shots;
   - Wine, with glass and bottle prices;
   - Beer;
   - Coffee;
   - Treats & juices.

   It ends with the allergy note and a link to the live menu.
6. **Happy hour** (`#happy-hour`): every day 15:00–18:00, plus the late night on Friday and Saturday 22:00–00:00.
   - A live line says "Happy hour is on · ends in …" or "Next happy hour today at 15:00 · in …".
   - The lineup cards come from the happy hour menu: cocktails 1,990, wine 1,090, draught beer, bottles & cans and shots 990.
   - The menu's fine print is underneath.
7. **What's happening** (`#events`): three event cards. The one on now gets an "On now" badge; one later the same day gets "Tonight".
   - **Girls' Night:** every Thursday 18:00–22:00, 50% off cocktails.
   - **Weekend Late Hour:** Friday and Saturday 22:00–00:00.
   - **Sunday 2-for-1:** all beers, Sundays 18:00–20:00.
8. **Behind the bar** (`#bar`): the photo deck (tap, swipe, arrow keys).
9. **Shake:** choose moods, shake, and get one of 22 drinks from the menu, with its menu description and price; VÁ's signatures are marked.
10. **Reviews** (`#reviews`): the three reviews quoted on the current site, shown as tilted speech bubbles.
11. **Say VÁ!** (`#skal`): explains the name. *Vá* (said like "vow") is Icelandic for "wow!", what you say when something amazes you. The big button counts every VÁ (stored on this device only), with sparkle bursts and a glow that brightens level by level.
12. **FAQ** (`#faq`): the 12 questions and answers from the current site, in both languages. They use native `<details>`, so they work without JavaScript and every answer is in the HTML.
13. **Visit:** the address, info@vábar.is, directions, menu and **Book a table**, plus the opening hours with the Open now badge.
14. **Footer:**
    - **Partners:** the Mekka Wines & Spirits and Ölgerðin logos on ivory tiles, so their own colours stay untouched. Each links to the partner's site (`partners` in `src/content.ts`; check the two URLs).
    - **Powered by Alcedo:** the white Alcedo logo from the Alcedo Logo Kit v1, the kit's version for dark backgrounds, shown at its 180 px minimum or wider and linking to www.alcedo.is.
    - **Below them:** address, hours, email, the company line and Staff login.

Every interaction works with a keyboard and a touch screen. With reduced motion everything still works, without movement.

## Where the facts come from

| Fact | Source |
|---|---|
| Opening hours, address, menu link | The owner, 2 October 2026 |
| Every menu item, description and price; the happy hour lineup and fine print | The printed menus: "VÁ Cocktails Menu Redesign" A3 and "VÁ Happy hour Menu Redesign" A4, English and Icelandic (supplied 2 October 2026), in `src/menu-data.ts` |
| Happy hour times and prices, founders' text, the numbers, reviews, FAQ answers, events, info@vábar.is | The current vábar.is (screenshots and FAQ text from the owner, 2 October 2026). Girls' Night replaces Date Nights, at the owner's request. |
| "Handcrafted cocktails, curated wines and Mediterranean-inspired tapas" | The current Wix site's business profile |
| Logo, colours | The brand manual |
| Photos | The owner, 2 October 2026 (`src/assets/photos/`, `public/og-image.jpg`) |
| Company line | `prototypes/alcedo-website` |
| Partner logos (Mekka Wines & Spirits, Ölgerðin) | The owner, 2 October 2026 (`src/assets/partners/`) |
| Alcedo logo | `ALCEDO_Logo_Kit_v1.zip` (review edition), `logo-white.svg` |

When the printed menu changes, update `src/menu-data.ts`. The shaker game reads names, descriptions and prices from it. FAQ answers written in only one language on the old site were translated for the other.

## SEO

Built around the search terms VÁ BAR is found with on Google (bar, coffee, restaurants, food hall, cafe, cocktail bar, wine bar, tapas, Reykjavík, "vá bar"):

- **Prerendered HTML:** `npm run build` renders the page on the server (`src/entry-server.tsx`) and writes it into `dist/index.html` (`scripts/prerender.mjs`). Crawlers and link previews therefore get the full text (the menu, address and hours) without running JavaScript. In the browser, React then takes over.
- **Structured data:** a JSON-LD block, generated from `src/content.ts`, describes a `BarOrPub` + `CafeOrCoffeeShop` with:
  - its address and the containing place (Hafnartorg Gallery Food Hall);
  - opening hours (Friday and Saturday close as `23:59`, which Google reads as midnight);
  - the menu link, cuisine (cocktails, wine, tapas, Mediterranean, coffee) and the operating company.
- **Head:**
  - **Title:** "VÁ BAR · Cocktail & wine bar, coffee and tapas at Hafnartorg, Reykjavík".
  - **Meta description:** names the food hall, the address and "open daily from 11:30".
  - **Also:** the canonical URL `https://www.xn--vbar-5na.is/`, Open Graph tags and a share image (`og-image.jpg`, the VÁ logo etched in a glass) for links on Facebook, Messenger and other apps.
- **Headings and copy:** the page heading reads "VÁ BAR: cocktail bar, wine bar and coffee with tapas at Hafnartorg, Reykjavík" for screen readers and search engines, while the big visual title stays "SKÁL". The keywords appear in normal sentences, not as a keyword list.
- **Crawling:** `robots.txt` allows everything and points to `sitemap.xml`. With no JavaScript, the hero text and every section are still visible.
- **Language:** one URL, English by default in the HTML, with the EN / IS switch in the browser. Separate `/is/` pages with `hreflang` would help Icelandic searches; they can be added later.
- **Off the site:** the Google Business Profile matters most for "bar near me" and "coffee near me". Keep its hours, address, menu link and website the same as here. Search terms in German and Spanish ("kaffee", "cafetería", "restaurantes") come from tourists' phones and are served by that profile, not by page text.

## Before launch

1. **Booking link (Alcedo):** bookings move to Alcedo. "Book a table" / "Bóka borð" is in the header, the hero, the phone menu and the Visit section. Until Alcedo's guest booking page is live (`site.bookingUrl` is `null`), every booking button opens a pre-filled booking request email to info@vábar.is (date, time, guests, name, phone; English or Icelandic to match the page). When the page is live, paste its URL into `site.bookingUrl` in `src/content.ts`; all buttons switch to it and open it in a new tab, and Google's data (`acceptsReservations`) points to it.
2. **Social links:** paste the Instagram, Facebook and TikTok profile URLs into `site.socials` in `src/content.ts`. Each one adds an icon to the footer and the phone menu and is listed for Google (`sameAs`); a `null` link stays hidden. The icons are Simple Icons paths (CC0) in `src/components/site/social-icons.tsx`.
3. **Reviews:** the three reviews are copied word for word from the current site. Check that each is a real review on Google or Tripadvisor. Google's guidelines don't allow invented or edited reviews.
4. **Illustrations:** the current site's line drawings (the founders, the bartender, the guests) came only as screenshots. Send the original files to use them, for example inverted to light lines on the dark background.
5. **Directions:** replace the Maps search in `site.mapsUrl` with the Google Business Profile's Maps link.
6. **Icelandic copy:** have a native speaker read the text that was translated (marked in the commit history).
7. **Photos:** the bartender is recognisable. Make sure he's happy to appear on the website.
8. **Hero photos:** send Imad's three photos (pouring, garnishing with the cherry, presenting the cocktail) as files, to replace the stand-ins in `src/assets/hero/`.

## Hosting

`https://www.xn--vbar-5na.is/` is currently a published **Wix** site ("VÁ BAR Reykjavik", Premium plan with the custom domain). To serve this redesign there:

1. Create a Netlify site from this repository: base directory `prototypes/vabar-website`, build command `npm run build`, publish directory `dist`. `netlify.toml` sets a strict CSP (`script-src 'self'`) and the security headers.
2. Check the Netlify URL, then add `www.xn--vbar-5na.is` and `xn--vbar-5na.is` as custom domains in Netlify.
3. Point the domain's DNS at Netlify (at the DNS host, or by moving the nameservers as was done for alcedo.is). Until that switch, the Wix site stays live, and nothing here changes it.
4. After the switch, submit `https://www.xn--vbar-5na.is/sitemap.xml` in Google Search Console.

The app's CSP already allows `frame-ancestors https://xn--vbar-5na.is`.

## Checks run

- `npm run build`: TypeScript, the Vite build and the prerender pass. The output contains the page text, the JSON-LD and the head tags.
- **Headless Chromium, 1440×900 and 390×844:**
  - no page errors or console errors or warnings;
  - no horizontal overflow;
  - the hero renders and the slides scroll;
  - the menu tabs switch;
  - the Shake game returns a VÁ drink (with "Coffee" chosen: VÁ Espresso Martini, then Irish Coffee);
  - the Skál counter counts;
  - the EN → IS switch sets `<html lang="is">`;
  - the side menu opens the overlay, and Escape closes it;
  - the hours badge read "Closed now" on Friday at 10:15 Reykjavík time, which is correct (VÁ opens at 11:30).
  - with the clock set to Thursday 19:00, Girls' Night showed "On now"; on Friday at 16:10, happy hour showed "on · ends in 1 h 50 min" and the Weekend Late Hour showed "Tonight";
  - the photo deck moved on tap, swipe, the ← key and the Next button;
  - the menu tabs switch, and wine rows show glass and bottle prices that line up at 390 px;
  - with "Warm" chosen, the shaker returned Irish Coffee (2,990 kr) and Spiked Hot Chocolate (3,090 kr), with their menu descriptions;
  - FAQ answers open and close.
- **Performance:** three.js is in its own chunk (about 141 kB gzipped). The app chunk is about 150 kB gzipped. The photos are 20–67 kB each and load lazily.
