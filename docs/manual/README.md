# Atlas manuals

This folder holds the Atlas User Guide and the Atlas Quick Start Guide: the Markdown
sources, the theme, the images and the build that turns them into HTML and PDF.

| File | What it is |
| --- | --- |
| `Atlas_User_Guide.md` | Master source: every chapter |
| `Atlas_Quick_Start_Guide.md` | Quick Start source; can pull tagged sections from the master |
| `Atlas_User_Guide_Print.html`, `Atlas_User_Guide.pdf` | Built User Guide |
| `Atlas_Quick_Start_Guide.html`, `Atlas_Quick_Start_Guide.pdf` | Built Quick Start |
| `theme/manual.css` | The look: Atlas tokens, print and screen layout |
| `assets/screenshots/` | Screenshots (captured from the app on `main`) |
| `assets/diagrams/` | Hand-authored SVG diagrams (plain-text labels) |
| `assets/icons/` | Lucide icons used by the manual (ISC, see `LICENSE-lucide.txt`) |
| `assets/brand/` | Byte-identical copies of the Atlas logos from `apps/web/assets/brand/`, the Atlas AI robot art (`atlas-bot.png`, decorative, Atlas AI chapter openers only) and the robot badge (`atlas-bot-small.png`, byte-identical to `apps/web/assets/atlas-bot/`, for `icon=atlas-bot`) |
| `tools/capture_screenshots.mjs` | Captures every screenshot from the real `apps/web` code through the browser-test harness |
| `tools/manual-fixtures.mjs` | The demo venue (Harbour Room, Reykjavík) the screenshots show: invented people, suppliers, stock and records |
| `assets/screenshots/manifest.json` | One entry per screenshot: file, module, viewport, role, route, the state shown and a suggested caption (written by the capture) |
| `tools/build_manual.mjs` | The build (Markdown → HTML → PDF) |
| `tools/lib/` | Markdown renderer, components, includes, PDF page reader |
| `tools/showcase.md` | Every component on a few pages, for checking the theme |
| `tools/extract_icons.mjs` | Copies the Lucide icons the manual uses into `assets/icons/` |

## Sources of truth

- **What Atlas does** is the code on `main`. The guides document release 0.8.0 (main ef7c907):
  exact button labels, headings and messages come from `apps/web`, never from memory. Features that
  are not on `main` (Accounting, the Marketing publishing platform,
  delivery of device alerts) appear only in a short *Coming in a later release* note.
- **The text** is `Atlas_User_Guide.md` (the single master, every chapter) and
  `Atlas_Quick_Start_Guide.md`. The Quick Start pulls the sections tagged `.quick` in the master
  (`#home-routine`) with `::include`, so those are edited in one place.
- **The pictures** come from `tools/capture_screenshots.mjs` + `tools/manual-fixtures.mjs`. Never edit
  a PNG by hand: change the demo data or the shot script and capture again. Every figure in the guides
  must name a file listed in `assets/screenshots/manifest.json`.
- **The look** is `theme/manual.css` (tokens copied from `apps/web/assets/css/atlas-tokens.css`) and
  the logos in `assets/brand/` (byte-identical to `apps/web/assets/brand/`, used only on the covers).

## Rebuild: capture, then build

From the repository root, one browser run at a time (`flock`):

```sh
# 1. Screenshots (all of them, or --only name1,name2; --list shows the shots)
flock /tmp/atlas-browser.lock env ATLAS_BROWSER_LIBS=/path/to/node_modules \
  node docs/manual/tools/capture_screenshots.mjs

# 2. Both guides, HTML and PDF
flock /tmp/atlas-browser.lock env ATLAS_BROWSER_LIBS=/path/to/node_modules \
  node docs/manual/tools/build_manual.mjs

# 3. Tests
node --test tests/node/manual-build.test.js
```

The capture needs Playwright with Chromium and the pinned browser libraries (see
`tests/browser/README.md`; `ATLAS_PLAYWRIGHT` points at a Playwright install if it isn't in
`node_modules`). It serves `apps/web` locally and answers every backend call from the demo venue, so
nothing reaches production. The page clock is frozen at Thursday 24 September 2026, 16:40 in
Reykjavík, so two runs give the same pictures. The Atlas AI robot is a WebGL scene; the capture
browser draws WebGL in software, where Atlas would show the still poster, so the capture switches
the live robot on (`AtlasBot.animateInSoftware`, as the browser tests do) and waits for its first
frame. Motion is reduced, so the robot holds one still pose. Look at every new PNG before building.

The build must finish without warnings. After building, look at every PDF page (for example
`pdftoppm -r 50 -png docs/manual/Atlas_User_Guide.pdf /tmp/page`) for split figures, widows,
overflowing tables and empty half pages.

## Build options

From the repository root:

```sh
# Both guides, HTML and PDF (Playwright + Chromium; flock keeps browser runs one at a time)
flock /tmp/atlas-browser.lock node docs/manual/tools/build_manual.mjs

# HTML only (no browser needed)
node docs/manual/tools/build_manual.mjs --html-only

# One guide
node docs/manual/tools/build_manual.mjs --only user     # or: --only quick

# The component showcase, built outside docs/manual
node docs/manual/tools/build_manual.mjs --showcase --out /tmp/manual-showcase

# Any other source (a draft chapter), with an extra folder to look for images in
node docs/manual/tools/build_manual.mjs --src draft.md --out /tmp/draft --assets /tmp/shots
```

- **No npm dependencies.** The renderer is a small Markdown subset written for the
  manual. Playwright is loaded the way `tests/browser/harness.mjs` loads it
  (`ATLAS_PLAYWRIGHT`, the repo's `node_modules`, or a global install).
- **PDF:** A4, backgrounds printed, running footer (version line left, page number right),
  no footer on the cover or on blank pages, PDF bookmarks from headings, tagged PDF.
- **Contents with page numbers:** the build prints once, reads where each heading
  landed, writes the numbers into the contents and prints again.
- **Fonts:** the app's fonts (IBM Plex Sans, Fraunces, IBM Plex Mono) are loaded from
  Google Fonts exactly as `apps/web/index.html` loads them; the font files are not in
  the repository. Without network the build warns and uses the same fallback stack as
  the app. `--no-fonts` skips them on purpose.
- **Warnings** (missing screenshot, unknown icon or directive, unclosed block) are printed;
  a missing screenshot renders as a striped "Screenshot pending" box.
- The HTML works on its own when opened from `docs/manual/` (relative links to
  `theme/` and `assets/`); it also prints the same as the PDF.
- Tests: `node --test tests/node/manual-build.test.js`.

## Front matter

Each guide starts with:

```yaml
---
title: User Guide
subtitle: Restaurant & Hospitality Operating System
tagline: Everything your team needs to run the venue.
version: Atlas User Guide · Version 0.8 · September 2026
release: Based on Atlas production release 0.8.0 (main ef7c907, 26 September 2026)
footer: Atlas User Guide · Version 0.8 · September 2026
doc-title: Atlas User Guide          # browser tab / PDF title
cover: full                          # full (User Guide) | light (Quick Start) | none
chapter-start: right                 # right = chapters open on a right-hand page; default: new page
---
```

## Markdown

Standard Markdown, a deliberate subset:

- Headings `#`…`######`, with optional attributes at the end: `## Stock count {#stock-count .quick roles="admin manager"}`.
  Every heading gets an id (from the text if not given). `.no-toc` keeps it out of the contents.
  `roles=` prints an "Available to" line with role badges under the heading.
- Paragraphs; a line ending in two spaces or `\` breaks the line.
- `**bold**`, `*italic*` / `_italic_`, `` `code` ``, `[link](https://…)`, `![alt](path)`.
- Lists: `-` bullets and `1.` numbered steps (numbers drawn as discs), nested by indenting.
  A blank line between two numbered lists joins them (as in CommonMark); put a sentence between them to start again at 1.
- Tables (GitHub style, with `:---:` alignment; `\|` for a literal pipe). The first column is read as row headers.
- `> quote`, `---` rule, fenced code, and definition lists (`Term` then `: definition`).
- **No raw HTML.** Anything like `<b>` is shown as text. Links may only be `http(s)`, `mailto`, `tel`, `#anchor` or relative.
- Image and asset paths are written relative to `docs/manual/` (for example `assets/screenshots/home.png`) in every source file.

## Components

Blocks open with `:::name` and close with `:::`. A block inside another block uses one more
colon on the outer one (`::::figures` … `::::`). Text after the name is the block's title;
`{…}` holds attributes (`#id`, `.class`, `key=value`, `key="two words"`), before or after the title.
One-line components use two colons: `::name[text]{attributes}`.

### Callouts

```md
:::tip Optional title
Count one area at a time.
:::
```

| Directive | Label shown | Use for |
| --- | --- | --- |
| `:::tip` | Tip | A shortcut or good habit |
| `:::important` | Important | Something that goes wrong if skipped |
| `:::warning` | Warning | Loses data or cannot be undone |
| `:::note` | Note | Neutral side information |
| `:::admin-only` | Administrators only | Admin-only features |
| `:::roles{roles="admin manager"}` | Available to + badges | Who can use a feature |
| `:::ai` | Atlas AI | What Atlas AI can do here |
| `:::example` | Example | A worked scenario |
| `:::coming-later` | Coming in a later release | Features not in this release (never describe them as available) |

Any callout takes `roles="…"` (adds badges), `icon=` (another Lucide icon) and `label="…"` (another label).

### Roles

- Inline badge: `:role[admin]`, several at once: `:role[admin manager]`.
- Line under a heading: `## Orders {roles="admin manager"}`, or on its own: `::roles{roles="admin manager" label="Who uses it"}`.
- Keys and labels (the app's wording): `admin` Administrator, `manager` Manager, `bartender` Bartender,
  `viewer` Viewer, `schedule_only` Schedule only. Badges always show the word; colour is extra.

### Inline pieces

| Syntax | Result |
| --- | --- |
| `:ui[Add to order]` | A button or label exactly as it appears in Atlas (`{icon=plus}` adds its icon) |
| `:path[Inventory > Stock count]` | Where to go, with chevrons |
| `:kbd[Ctrl K]` | A key |
| `:icon[sparkles]` | A Lucide icon from `assets/icons/` |
| `:icon[atlas-bot]`, `{icon=atlas-bot}` | The Atlas AI robot badge, as the app shows it on Atlas AI, Ask Atlas and the briefing |
| `:badge[New]{tone=new}` | A small tag (`tone=new`, `live`, `warning`) |

Use the exact UI wording from the app in `:ui[…]` and `:path[…]`.

### Workflow

A numbered, visual step sequence. Horizontal for up to five steps on wide pages, vertical
otherwise or with `{layout=vertical}`. Each step is `Title — description` (em dash with spaces).

```md
:::workflow Receive a delivery {icon=truck}
1. Open the order — Find it in Purchasing.
2. Check the goods — Compare what arrived with the order lines.
3. Receive — Confirm what you received.
:::
```

### Do and don't

```md
::::do-dont
:::do
- Count what is on the shelf.
:::
:::dont
- Don't copy last week's numbers.
:::
::::
```

A title after `:::do` / `:::dont` replaces "Do" / "Don't".

### Feature cards

Each heading inside starts a card; `icon=` and `roles=` go on the heading. `cols=` sets the grid (default 2 or 3).

```md
:::cards{cols=3}
### Inventory {icon=package roles="admin manager"}
Items, stock levels and counts.

### Recipes {icon=martini}
Specs, costs and availability.
:::
```

### Screenshots

```md
:::figure{src="assets/screenshots/home-desktop.png" device=desktop caption="Home on a desktop."}
- [21%, 3%] **Search or ask Atlas** opens search and Atlas AI.
- [96%, 3%] **Notifications** shows what changed.
:::
```

- `device=desktop` (window frame), `phone` (light device frame, 60 mm wide), `none` (plain).
- Markers: one list item each, `[x%, y%] meaning`, measured from the top-left of the image.
  They are numbered in order and always explained in a legend under the image, so no meaning
  lives only in the picture.
- `caption=` is also the image's alt text (override with `alt=`). `width=` limits the size (`70%`, `120mm`).
- Without markers the one-line form works: `::figure[Caption]{src="…" device=phone}`.
- Phones side by side:

```md
::::figures
:::figure{src="assets/screenshots/a-phone.png" device=phone caption="Before."}
:::
:::figure{src="assets/screenshots/b-phone.png" device=phone caption="After."}
:::
::::
```

Capture guidance: desktop at 1280–1440 px wide, device scale 2, cropped to the part that
matters; phone at 390 × 844, device scale 2. Only synthetic data (the browser-test fixtures).

### Diagrams

`::diagram[Caption]{src="assets/diagrams/stock-truth.svg"}` inlines the SVG (its text stays
real, selectable text in the PDF). The caption is the diagram's accessible name. Diagram labels
are plain `<text>` elements: open the SVG in an editor and change the words.

| File | Shows |
| --- | --- |
| `atlas-ecosystem.svg` | The live modules around the venue |
| `purchase-order-lifecycle.svg` | Placeholder stages (`po-stage-N-title` / `po-stage-N-note`, `po-exception-*`) to relabel |
| `stock-truth.svg` | Imported quantities and stock-count evidence versus live stock |

### Role matrix

A table whose role columns become badges and whose cells become icon + word.

```md
:::role-matrix Purchasing
| Task | admin | manager | bartender | viewer |
| --- | --- | --- | --- | --- |
| Create a purchase order | yes | yes | no | no |
| See supplier prices | yes | yes | view | view |
| Edit a supplier | yes | limited (own venue) | own | — |
:::
```

Cell words: `yes`, `no` (or `—`), `view` (View only), `own` (Own only), `limited` (Limited).
Text after the word becomes a small note. Anything else is shown as written.

### Atlas AI prompt cards

```md
:::prompts Try asking {cols=2}
- What is below par tonight? — Checks stock against par levels.
- Who is working on Friday?
:::
```

### Chapter opener

Starts a new page (or a right-hand page with `chapter-start: right`). The `#` heading inside is
the chapter title in the contents; the paragraph is the one-line intro.

```md
:::chapter{number=3 icon=package}
# Inventory {#inventory}
Know what you have, what you need and what it costs.
:::
```

`art="assets/brand/atlas-bot.png" art-crop=left` adds decorative art (the robot sheet holds three
poses; `art-crop=left` shows the first). Brand rule: the Atlas logo is the product, the robot is
Atlas AI. Robot chapter art opens the Atlas AI chapters only; elsewhere the robot appears as the
`atlas-bot` badge, only where the app itself shows it.

### Quick reference and glossary

```md
:::quick-ref Everyday shortcuts {icon=zap}
| To do this | Go here |
| --- | --- |
| Start a stock count | :path[Inventory > Stock count] |
:::

:::glossary
Par level
: The quantity you want on hand before service.
:::
```

### Page and document

| Syntax | Result |
| --- | --- |
| `::toc{depth=2}` | Contents with page numbers (depth 1: chapters, 2: also `##` sections) |
| `::pagebreak` | Start a new page |
| `:::keep` … `:::` | Keep a group on one page |
| `:::section{#id .quick}` … `:::` | Wrap any content to give it an id or tag for includes |

### Sharing sections between the guides

Tag a section in the User Guide and pull it into the Quick Start, so both come from one source:

```md
## Signing in {#signing-in .quick}          <!-- in Atlas_User_Guide.md -->

::include{from="Atlas_User_Guide.md#signing-in"}           <!-- one section by id -->
::include{from="Atlas_User_Guide.md" tag=quick}           <!-- every section tagged .quick, in order -->
::include{from="Atlas_User_Guide.md#signing-in" shift=1}   <!-- demote headings one level -->
```

A section runs from its heading to the next heading of the same or higher level (or the next
chapter). Tag `##` sections, not the chapter's `#` title. A tagged `:::block` is included whole.

## Icons

`assets/icons/` holds the Lucide 0.454.0 icons (the version the app loads) that the manual uses,
including the side-bar icons: house, messages-square, clipboard-check, package, martini,
truck, calendar-days, users, book-open, chart-no-axes-column, megaphone, database, settings
(Atlas AI's side-bar icon is the robot badge, `atlas-bot`, not a Lucide icon).
To add one, put its Lucide name in `ICONS` in `tools/extract_icons.mjs` and run:

```sh
ATLAS_BROWSER_LIBS=/path/to/node_modules node docs/manual/tools/extract_icons.mjs
```

## Theme

`theme/manual.css` copies the product tokens from `apps/web/assets/css/atlas-tokens.css`
(Midnight, Slate, Mist, Snow, Atlas Blue, the neutrals, status colours, radii, shadows and font
stacks). Body text is 10.5 pt; text colours meet WCAG AA; status is never shown by colour alone.
Check theme changes with the showcase build before building the guides.
