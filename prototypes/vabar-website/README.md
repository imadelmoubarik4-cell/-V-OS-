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

`src/App.tsx` puts it together; all copy and venue facts are in `src/content.ts` (English and Icelandic).

- **Header:** the solo logo (it wobbles on hover), section links (Drinks, Shake, Skál, Visit), an animated **EN / IS** switch (remembered per device; the default follows the browser language) and a Menu button. On phones a full-screen navigation overlay opens instead; the hero's side menu opens it too, and Escape closes it.
- **Hero:** the horizon scene in the brand colours. Three slides:
  - **SKÁL**: "Handcrafted cocktails, curated wines and Mediterranean-inspired tapas", with the "See the menu" and "Find us" buttons;
  - **COFFEE** (*KAFFI*): "Coffee from 11:30, cocktails until late";
  - **HAFNARTORG**: "Inside Hafnartorg Gallery Food Hall, Geirsgata 17, by the old harbour".
- **Marquee:** a tilted terracotta band, "Cocktails ✦ Coffee ✦ Tapas ✦ Wines ✦ Skál ✦ Hafnartorg" (static with reduced motion).
- **On the menu** (`#drinks`): four tabs (Coffee, Cocktails, Spritz & zero, Wine & beer), each with real item names and small tags (Signature, Frozen, Hot, 0.0%, Draught, House). There are no prices; "Full menu & prices" goes to the live menu. The tabs follow the WAI-ARIA pattern, so arrow keys move between them.
- **Shake:** choose moods (Fresh, Sour, Bitter, Sweet, Strong, Coffee, Frozen, Warm, Alcohol-free, or "Surprise me"), then press the cocktail shaker. It suggests one of 20 VÁ drinks, with VÁ's own signatures marked, and never the same drink twice in a row.
- **Skál:** a "Skál!" button that clinks, bursts sparkles and counts glasses raised (stored on this device only), with levels that make the glow behind it brighter.
- **Visit:** the address card (VÁ BAR · Hafnartorg Gallery Food Hall · Geirsgata 17, 101 Reykjavík) with directions and menu buttons, and the opening-hours table with today highlighted and an **Open now / Closed now** badge in Reykjavík time. Closing at 00:00 counts as midnight.
- **Footer:** address, hours, the company line, Staff login and Back to top.
- **Throughout:** sections fade up as they scroll in, a soft terracotta glow follows the pointer (fine pointers only), and there is a skip link. With reduced motion everything still works, without movement.

## Where the facts come from

| Fact | Source |
|---|---|
| Opening hours: Sun–Thu 11:30–22:00, Fri–Sat 11:30–00:00 | The owner, 2 October 2026 |
| Address: VÁ BAR, Hafnartorg Gallery Food Hall, Geirsgata 17, 101 Reykjavík | The owner, 2 October 2026 |
| Menu link `https://app.alcedo.is/menu.html` | The owner, 2 October 2026 |
| Drink names and ingredients | VÁ's recipes in Atlas: `data/flavor/recipes-snapshot.json` (exported 27 September 2026; names and ingredient links only, no prices or quantities) |
| "Handcrafted cocktails, curated wines and Mediterranean-inspired tapas" | The business description on the current Wix site (VÁ BAR Reykjavik) |
| Logo, colours | The brand manual |
| Company line | `prototypes/alcedo-website` |

When the menu changes, update `drinks` and `menuTabs` in `src/content.ts`. The full menu, with prices, always comes from the live menu page.

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
  - **Also:** the canonical URL `https://www.xn--vbar-5na.is/` and Open Graph tags.
- **Headings and copy:** the page heading reads "VÁ BAR: cocktail bar, wine bar and coffee with tapas at Hafnartorg, Reykjavík" for screen readers and search engines, while the big visual title stays "SKÁL". The keywords appear in normal sentences, not as a keyword list.
- **Crawling:** `robots.txt` allows everything and points to `sitemap.xml`. With no JavaScript, the hero text and every section are still visible.
- **Language:** one URL, English by default in the HTML, with the EN / IS switch in the browser. Separate `/is/` pages with `hreflang` would help Icelandic searches; they can be added later.
- **Off the site:** the Google Business Profile matters most for "bar near me" and "coffee near me". Keep its hours, address, menu link and website the same as here. Search terms in German and Spanish ("kaffee", "cafetería", "restaurantes") come from tourists' phones and are served by that profile, not by page text.

## Before launch

1. **Directions:** `site.mapsUrl` is a Google Maps search for the full address. Replace it with the Google Business Profile's own Maps link.
2. **Icelandic copy:** have a native speaker read it.
3. **Menu page:** check that `https://app.alcedo.is/menu.html` shows the current menu (it reads live from Atlas).
4. **Optional:** a share image (`og:image`, 1200×630) for links on Facebook and Messenger, and a phone number if you want one on the site.

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
- **Performance:** three.js is in its own chunk (about 141 kB gzipped). The app chunk is about 140 kB gzipped.
