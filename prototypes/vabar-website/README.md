# VÁ website redesign (vábar.is)

A redesign prototype for **vábar.is** (`https://www.xn--vbar-5na.is/`), the public site of VÁ at Hafnartorg, Reykjavík. It is a separate project: nothing in `apps/`, `packages/` or the root `package.json` changes.

- **Status:** prototype. `noindex` is set in `index.html`, and the footer says that drinks, hours and some links are placeholders until confirmed (see *Before launch*).
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
  - **Where it appears:** the landing hero (large, as the page's `<h1>` with the accessible name "VÁ"), the header (it appears once the hero logo has scrolled away), the navigation overlay, the footer and the favicon.
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

- **Props:** `slides`, `menuLabel`, `scrollLabel`, `palette`, `onMenuClick` and `children` (rendered under the landing subtitle). All default to the original content and colours.
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

`src/App.tsx` puts it together; all copy is in `src/content.ts` (English and Icelandic).

- **Header:** the solo logo (it wobbles on hover), section links, an animated **EN / IS** switch (remembered per device, and the default follows the browser language), and a Menu FlowButton. On phones there is a full-screen navigation overlay, which the hero's side menu also opens. It closes with Escape.
- **Hero:** the horizon scene in the brand colours. Three slides:
  - the **solo logo**, with "Cocktails, tapas and wines by the old harbour in Reykjavík" and the "See the menu" and "Find us" buttons;
  - **SKÁL**;
  - **HAFNARTORG**.
- **Marquee:** a tilted terracotta band, "Cocktails ✦ Tapas ✦ Wines ✦ Skál ✦ …" (static with reduced motion).
- **Shake:** choose moods (Fresh, Sour, Bitter, Sweet, Strong, Coffee, or "Surprise me"), then press the cocktail shaker.
  - The shaker wobbles while a progress ring fills, then bubbles pop and a cocktail card flips in, with a link to the menu.
  - It never suggests the same drink twice in a row.
- **Skál:** a "Skál!" button that clinks, bursts sparkles and counts glasses raised (stored on this device only), with levels that make the glow behind it brighter.
- **Visit:** Hafnartorg, directions, menu, and an hours card. Once hours are filled in, it shows an **Open now / Closed now** badge computed in Reykjavík time, including hours past midnight.
- **Footer:** the company line, Staff login and Back to top.
- **Throughout:**
  - sections fade up as they scroll in;
  - a soft terracotta glow follows the pointer (fine pointers only);
  - there is a skip link.
  - With reduced motion, everything still works, without movement.

## Before launch

Only these facts are confirmed: the logo, colours and "Cocktails, Tapas, Wines" (brand manual), the name VÁ, "Hafnartorg · Reykjavík" (the app's public menu page), the company line, and Staff login → `https://app.alcedo.is/`. Everything marked `[CONFIRM]` in `src/content.ts` needs the owner:

1. **Opening hours:** `site.hours` is `null`, so the page says hours are coming soon. Fill in `{ 0: { open: "17:00", close: "01:00" }, … }` and the table and the Open now badge appear.
2. **Drinks:** the Shake game uses eight classic cocktails, labelled "Classic cocktails, not the full menu". Swap in VÁ's own drinks. No prices are shown.
3. **Menu link:** `site.menuUrl` points to the app's public menu (`apps/web/menu.html`) at `https://app.alcedo.is/menu.html`. Check that the page loads there.
4. **Directions:** `site.mapsUrl` is a Google Maps search. Replace it with the venue's own Maps link.
5. **Content from the current vábar.is:** the live site could not be fetched from the build environment, so nothing from it (photos, social links, phone, events) is carried over yet. Send the content to keep, and it can be added.
6. **Icelandic copy:** have a native speaker read it.
7. **Going live:** remove `noindex`, remove the placeholder line in the footer (`copy.*.banner`), and add a canonical link to `https://www.xn--vbar-5na.is/`.

## Hosting

Deploy as its own Netlify site: base directory `prototypes/vabar-website`, build command `npm run build`, publish directory `dist`. `netlify.toml` sets a strict CSP (`script-src 'self'`) and the security headers. Note that the app's CSP already allows `frame-ancestors https://xn--vbar-5na.is`.

## Checks run

- `npm run build`: TypeScript and the Vite build pass.
- **Headless Chromium, 1440×900 and 390×844:**
  - no page errors or console errors;
  - no horizontal overflow;
  - the hero renders and the slides scroll;
  - the Shake game returns a drink;
  - the Skál counter counts;
  - the EN → IS switch sets `<html lang="is">`;
  - the side menu opens the overlay, and Escape closes it.
- **Performance:** three.js is split into its own chunk (about 141 kB gzipped). The app chunk is about 137 kB gzipped.
