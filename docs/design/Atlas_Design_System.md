# Atlas Design System

Status: canonical from S88 (the Atlas experience redesign). It replaces the S87
version of this file. Final S88 consolidation (2026-09-25): every module team's
design-system request is implemented here, the module workarounds are gone and
the legacy layer is retired — there is no `atlas.legacy` layer, no
`assets/css/legacy/` directory and no inline style block in `index.html`. The build specification is
`docs/design/Atlas_Experience_Redesign.md` (§5 visual language, §6 components);
the visual north star is `docs/design/atlas-reference.html`. Where this file and
the spec disagree, the spec wins; fix this file.

Direction (October 2026): **Basalt & Kingfisher**, the framed sheet
(`docs/design/Alcedo_Redesign_2026.md`, which wins on every visual value). A
stone frame holds the sidebar and top bar; the work sits on one white sheet.
Basalt ink, one filled near-black primary per screen, and one hue, kingfisher
blue, for focus, selection, active markers, unread dots and charts. The logo is
monochrome (the supplied kit files, never redrawn or typed). No glass, no
gradients, no blur, no coloured or resting shadows. Functional truth before
decoration: never style a control as available when its behaviour does not
exist, never show a guessed number.

## 0. Files and cascade

| File | Layer | Holds |
| --- | --- | --- |
| `apps/web/assets/css/atlas-tokens.css` | `atlas.tokens` | Every custom property (the only file that defines `:root` variables) and the layer order statement. Linked first. |
| `apps/web/assets/css/atlas-base.css` | `atlas.base` | Reset (including `fieldset`/`legend`), body type, links, focus, selection, `[hidden]`, role gating, reduced motion, icon sizing, layout primitives. |
| `apps/web/assets/css/atlas-components.css` | `atlas.components` | Every shared component (§6.1–6.27 of the spec). |
| `apps/web/assets/css/atlas-shell.css` | `atlas.components` | The shell (sidebar, rail, top bars, tab bar, More, palette, notifications, account menu, sign-in), full-height pages, view placeholders. |
| module sheets (`home.css`, `inventory.css`, `team-messages.css`, …) | `atlas.modules` | One stylesheet per module: layout and module-specific pieces only. |

`@layer atlas.tokens, atlas.base, atlas.components, atlas.modules;`

- A later layer beats an earlier one for normal declarations whatever the
  specificity or load order; for `!important` the order reverses (the earlier
  layer wins).
- There is no legacy layer: S88 retired `atlas.legacy`, the inline
  `index.html` style block and the `assets/css/legacy/` fragments. Nothing may
  reintroduce them (`tests/node/css-hygiene-s88.test.js` fails).
- `!important` exists only in `atlas-base.css`, for `[hidden]`, reduced motion
  and role gating (`body:not(.atlas-commercial-manager)` hides
  `[data-commercial-only]` and the Purchasing link; RLS stays the boundary).
  Nowhere else (the hygiene test pins the three rules).
- Every stylesheet is exactly one `@layer` block; `atlas-base.css` is
  `atlas.base`, `atlas-components.css` and `atlas-shell.css` are
  `atlas.components`, everything else is `atlas.modules`
  (`tests/node/css-hygiene-s88.test.js`).
- Hygiene end state (`tests/node/css-hygiene-s88.baseline.json`): 19
  stylesheets, 0 legacy fragments, 0 inline or injected style blocks, 0
  cross-file duplicate selectors, 0 font sizes under 11 px (the floor is
  12 px), 10 `!important` (the base contracts above).
- Living gallery: `tests/browser/tools/component-gallery.html` (loads the real
  stylesheets; not part of the app bundle), checked by
  `tests/browser/components.browser.test.mjs` at 1440 and 390.

## 1. Colour (Basalt & Kingfisher, October 2026)

The visual values below are the 2026 redesign
(`docs/design/Alcedo_Redesign_2026.md`, which wins on any visual value). Token
names are unchanged since S88; only their values moved. Every value lives in
`atlas-tokens.css`. The legacy `--atlas-*` anchors are internal identifiers.

| Token | Value | Use |
| --- | --- | --- |
| `--bg-subtle` | `#f3f5f4` stone (`--atlas-snow`) | The frame: sidebar, top bar, phone bars, inset wells |
| `--bg` / `--surface` | `#ffffff` | The work sheet, cards, inputs, popovers |
| `--bg-muted` | `#ebedee` | Active nav pill, segmented track, skeleton bars, neutral pills |
| `--bg-hover` | `#f6f7f8` | Row and item hover on white (fine pointers only) |
| `--overlay` | `rgba(19,20,22,.36)` | Scrim |
| `--text` | `#131416` basalt (18.4:1) | Headings, body, the filled primary |
| `--text-2` | `#4f5254` (8.0:1) | Secondary text, table headers |
| `--text-3` | `#5d6062` (6.4:1; 5.3:1 on `--bg-muted`) | Meta, placeholders, group labels, plain row icons |
| `--ink` | `#1d1f21` | Tooltips, toasts, bulk bar |
| `--line` / `--line-subtle` / `--line-strong` | `#e8eaec` / `#f0f1f2` / `#cdced1` | Edges and dividers / row rules / control borders |
| `--accent` | `#18191b` near-black | The one filled primary per screen (white label, 18:1), count badges |
| `--accent-brand`, `--highlight`, `--focus-color` | `#1f6aa5` kingfisher | The one hue: focus ring, selection, active tab underline, unread dots, charts, current-time lines. Never a large fill. |
| `--accent-text` | `#1b5d91` (6.9:1) | Links and accent text |
| `--accent-soft` | `#edf3f9` | Info wells, selected chip, the deep-linked record |
| `--accent-ring` | `rgba(31,106,165,.24)` | Input focus ring |
| `--positive` (`-soft`, `-ink`) | `#1e7b4f` / `#dcfae5` / `#04250e` | Done, counted, in stock |
| `--warning` (`-icon`, `-soft`, `-line`) | `#92400e` / `#b45309` / `#fffbeb` / `#fde68a` | Below par, due, needs attention |
| `--danger` (`-soft`, `-ink`) | `#c4242a` / `#ffedea` / `#831c1e` | Out, failed, overdue, destructive |

Rules
- Colour budget under 3 % of the pixels: colour goes on data, status and the
  one primary, never on chrome. No orange, no teal, no gradients, glass or blur.
- Status colour always comes with a word or an icon. Pills are a pale tint with
  dark ink of the same hue.
- Tints only on pills, alerts, wells and selected rows. No icons in tinted
  circles or squares: row and empty-state icons are plain grey glyphs.
- The logo is monochrome (`assets/brand/alcedo/logo-black.svg`,
  `symbol-black.svg`); the 3D kingfisher mascot keeps its own colours and
  appears only inside the Alcedo AI view.
- Dark mode is out of scope; a dark set can be added under
  `:root[data-theme="dark"]` without renaming anything.

Legacy names (aliases in `atlas-tokens.css`, do not use in new CSS):
`--atlas-bg`, `--color-background` → `--bg`; `--atlas-surface-sunken`,
`--atlas-sidebar`, `--blue-50`, `--glass-fill-soft` → `--bg-subtle`;
`--atlas-surface`, `--color-surface`, `--glass-fill*` → `--surface`;
`--atlas-text`, `--color-text`, `--s38-ink` → `--text`; `--atlas-muted`,
`--color-text-secondary` → `--text-2`; `--atlas-subtle` → `--text-3`;
`--atlas-line`, `--color-border`, `--glass-line` → `--line`;
`--atlas-accent`, `--color-primary`, `--atlas-action` → `--accent`;
`--atlas-accent-soft`, `--atlas-info-soft` → `--accent-soft`;
`--atlas-green(-soft)`, `--atlas-warn(-soft)`, `--atlas-danger(-soft)` → the
status tokens. Glass primitives are flat (`--glass-blur: none`).

## 2. Typography

One grotesk: `--font-sans` **IBM Plex Sans** (self-hosted variable woff2,
latin + latin-ext, `assets/fonts/`, preloaded) for every role;
`--font-display` resolves to Plex Sans. `--font-mono` **IBM Plex Mono** has one
job: IDs, keys, SKUs, storage codes and setup keys — never labels, eyebrows,
money or quantities. Instrument Serif, Manrope, Fraunces and JetBrains Mono are
retired and their files removed.

| Role | Token (`font:` shorthand) | Size/line (phone) | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Display (Home greeting only) | `--type-display` | 26/32 (22/28) | 600 | `--track-display` −0.02em |
| Page title | `--type-title` | 22/28 (20/26) | 600 | `--track-title` −0.015em |
| Section | `--type-section` | 16/24 | 600 | `--track-section` −0.005em |
| Heading (card) | `--type-heading` | 14/20 | 600 | 0 |
| Body | `--type-body` | 14/20 (15/22) | 400 | 0 |
| Body large (reading) | `--type-body-lg` | 16/24 | 400 | 0 |
| Label | `--type-label` | 13/18 | 500 | 0 |
| Meta | `--type-meta` | 13/18 | 400 | 0 |
| Caption | `--type-caption` | 12/16 — **the minimum size** | 400 | 0 |
| KPI | `--type-kpi` | 28/32 (24/28) | **400** (the semibold is on the label) | `--track-kpi` −0.02em |
| Numeric | `--type-num` | 14/20 | 500 | 0 |

Size-only tokens: `--fs-display` 26, `--fs-title` 22, `--fs-section` 16,
`--fs-heading` 14, `--fs-body` 14, `--fs-body-lg` 16, `--fs-label` 13,
`--fs-caption` 12, `--fs-kpi` 28.

- `font-variant-numeric: tabular-nums` on every number in a table, KPI, count,
  time or anything that updates (`.num`); numeric columns right-aligned, and a
  numeric header ends level with its figures (its sort chevron sits on the left).
- A missing value is a grey dash (`.atlas-stat__value.is-empty` for KPIs); a
  real zero is printed.
- Sentence case. No uppercase labels, no letter-spaced or monospace eyebrows,
  nothing under 12 px, nothing at 48 px. 700+ never.

## 3. Spacing (spec §5.4)

4 px base: `--s-1 … --s-20` = 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80
(`--space-*` are aliases).
- Inside controls 8–12 horizontal; rows 10–12 vertical; cards 16 (rows) / 20
  (content) / 24 (sheets, desktop).
- Fields: 6 between label and control, 16 between fields, 24 between groups.
- Buttons in a group: 8. Chips: 8.
- Page: header → tabs 16, tabs → toolbar 20, toolbar → content 12, sections 40
  (phone 28), page bottom 80 (phone: tab bar + 40). Gutter `--page-gutter`:
  40 / 32 (≤1279) / 24 (≤1023) / 16 (<768). Content max `--page-max` 1200,
  reading column `--reading-max` 720.

## 4. Radius

`--r-xs` 4 (checkbox, kbd, skeleton, tags) · `--r-sm` / `--r-md` 6 (buttons,
inputs, nav items, segmented, record chips) · `--r-lg` 8 (cards, tables,
alerts, popovers, toasts) · `--r-xl` 12 (dialogs, sheets, palette, composer) ·
`--r-sheet` 16 (the work sheet) · `--r-pill` (status pills, avatars, toggles,
dots only — **buttons are not pills**). Legacy `--radius-*` alias these.

## 5. Elevation

- Flat: a resting card has a 1 px `--line` border and **no shadow** (a border
  or a shadow, never both). `--shadow-soft` resolves to none.
- `--shadow-pop` — menus, popovers, notification panel, toasts, the floating
  composers (Alcedo AI, Messages).
- `--shadow-modal` — dialogs, sheets, the palette, the overlay sidebar.
- `--shadow-1` is kept for small lifts inside floating surfaces only. No
  coloured shadows.

## 6. Motion (Emil Kowalski)

| Token | Value | Use |
| --- | --- | --- |
| `--dur-1` | 120 ms | Hover, colour |
| `--motion-press` | 140 ms | `:active { transform: scale(var(--press-scale)) }`, `--press-scale` .97 (1 under reduced motion) |
| `--dur-2` | 180 ms | Menus, popovers, toggles, tabs, toasts in |
| `--dur-3` | 240 ms | Dialogs, sheets, page entry |
| `--ease-out` | `cubic-bezier(.23,1,.32,1)` | Enter and exit |
| `--ease-in-out` | `cubic-bezier(.77,0,.175,1)` | On-screen movement |
| `--ease-drawer` | `cubic-bezier(.32,.72,0,1)` | Sheets and drawers |

- Nothing in the UI over 300 ms; never `transition: all`; no ease-in (the
  `--ease-in` name resolves to the ease-out curve); animate transform and
  opacity only; never from `scale(0)` — popovers enter from `scale(.96)`.
- Overlays enter through transitions with `@starting-style` (interruptible).
  Keyboard-opened surfaces (the palette from Ctrl K, `.is-instant`) do not
  animate. Hover effects only under `(hover: hover) and (pointer: fine)`.
- The page header and KPI strip play their entry once per navigation
  (`.atlas-view-enter`, set by `atlas-app.js`), never on a module re-render.
- `prefers-reduced-motion` and `html.atlas-reduce-motion` keep opacity and
  colour and drop movement (`--move-*` and `--press-scale` collapse).

## 7. Focus and accessibility

- `--focus-outline` (2 px solid kingfisher `#1f6aa5`) with `--focus-offset`
  2 px on every interactive element (`:focus-visible`). Inputs show the
  kingfisher border plus `--focus-ring` (3 px `rgba(31,106,165,.24)`).
- Contrast AA: text ≥ 4.5:1, UI ≥ 3:1 (checked by the gallery test). Touch
  targets ≥ 44 px under `(pointer: coarse)` (a pseudo-element hit area counts);
  inputs use 16 px text on touch; `touch-action: manipulation`, no tap
  highlight, `100dvh`, safe-area insets.
- Keyboard: reading order; Esc closes overlays; focus returns to the trigger.

## 8. Icons

One self-hosted set: `apps/web/assets/js/alcedo-icons.js`, the ALCEDO icon set
(Phosphor Icons 2.1.1 Regular, MIT, plus custom glyphs drawn on the same grid;
`apps/web/assets/icons/README.md` lists every name and glyph). Lucide and its
CDN are gone from the pages and the CSP.

- Glyphs are filled paths in `currentColor` on a 256 grid. Size with width and
  height: `--icon-sm` 16 (inline, buttons, rows, nav), `--icon-md` 18 (top bar,
  sheet close), `--icon-lg` 20 (phone top bar, empty states), `--icon-xl` 22
  (tab bar). There is no stroke to set.
- Markup: `<i data-lucide="name" aria-hidden="true"></i>` plus
  `lucide.createIcons()` (the set provides that API), or
  `AlcedoIcons.svg(name, { size, className, label })` for template strings.
  `tests/node/alcedo-icons.test.js` fails if a name used in `apps/web` has no
  glyph.
- `alcedo` / `atlas-bot` is the kingfisher mark: the Alcedo AI nav entry and
  every small "Ask Alcedo" control (Home briefing, module headers and drawers,
  the palette, the More sheet, toasts). The 3D mascot (`atlas-bot.js`) is drawn
  only in the Alcedo AI view (welcome, answer who-line, voice).
- One meaning per icon; no emoji; no decorative icons; icons are plain glyphs,
  never set in tinted tiles.

## 9. Components (spec §6; all in `atlas-components.css`)

| § | Component | Classes | Key specs |
| --- | --- | --- | --- |
| 6.1 | Page header | `.page-head`, `__text`, `__title` (h1), `__sub`, `__actions`; `.atlas-toolbar`, `__end` | Title 24/32; the title column is never narrower than 280 px (or the full width): actions that don't fit beside it wrap onto their own line under it, at every width, so modules add no header breakpoints; phone: title visually hidden (top bar shows it), actions full width; the toolbar scrolls sideways and its `.atlas-search` keeps 240 px |
| 6.2 | Section | `.atlas-section`, `__head`, `__title`, `__meta`, `__link` | 17/24 title, 12 to content, 40 above (28 phone) |
| — | Text link action | `.atlas-link` (a `<button>` or `<a>` that reads as a link: "Show all items", a post title that opens it) | Accent text, underline on hover; 44 px touch hit area |
| 6.3 | Button | `.atlas-btn` + `--primary`/`--secondary`/`--ghost`/`--danger`/`--danger-solid`, `--sm`/`--lg`/`--block`, `.is-loading` (+`aria-busy`), `:disabled`/`[aria-disabled]`; `.atlas-btn-group` | 32/36/44; coarse 44/44/44; radius 8; one primary per context |
| 6.4 | Icon button | `.atlas-icon-btn` (+`--sm`/`--md`/`--lg`), `.dot`; `.kbd` | 36 (44 touch); always `aria-label` |
| 6.5 | Inputs | `.atlas-input`, `.atlas-select`, `.atlas-textarea` (or `textarea.atlas-input`), `.atlas-affix` + `.suffix`, `.atlas-search` + `.atlas-search__clear`, `.atlas-range` | 36 (44 + 16 px text on touch), 8 radius, focus accent + ring, `aria-invalid` danger |
| 6.6 | Field | `.atlas-field` > `label` / `.atlas-label`, `.optional`, `.help`, `.error` (or `__help`, `__error`) | Label 13/500, help and error 12 |
| 6.7 | Forms | `.atlas-form`, `.atlas-form-group` (a `<fieldset>` with its `<legend class="atlas-form-group__title">`; base resets fieldset/legend), `__title`, `.atlas-grid-2`, `.atlas-form-foot`, `__start` | 16 between fields, 24 between groups, legend 8 above the fields, single column on phones |
| 6.8 | Toggle | `button.atlas-toggle[role=switch][aria-checked]`, `.is-pending`; `.atlas-toggle-row`, `__label`, `__help`, `__error` | 36 × 20, 44 hit area |
| 6.9 | Check / radio | `input.atlas-check`, `input.atlas-radio` (`:checked`, `:indeterminate`), `.atlas-check-row` | 16 px, native input kept |
| 6.10 | Segmented | `.atlas-segmented` > `button[aria-pressed]` / `[aria-checked]` | 28 (44 touch) |
| 6.11 | Tabs | `.atlas-tabs` > `a[aria-current=page]` / `[role=tab][aria-selected]`, `.count` | 40 tall, ink underline (not blue), scrolls with a fade on phones |
| 6.12 | Chips | `.atlas-chip`, `.is-active` / `[aria-pressed=true]`, `--dashed`, `__clear`; `.atlas-chips` | 30 (44 touch) |
| — | Record chip | `.atlas-record-chip` (a link to a record: "Used in" recipes, a record attached to a message), `> svg`, `> span` (ellipsis) | 32, 8 radius, hairline; 44 px touch hit area |
| 6.13 | Pill, badge | `.atlas-pill` + `--positive`/`--warning`/`--danger`/`--info`/`--neutral`/`--plain`; `.atlas-badge`, `--muted` | Pill 22, 12/16 500, word mandatory; badge 18 |
| 6.14 | Card | `.atlas-card`, `--pad`/`--pad-sm`/`--pad-lg`, `--link` (or `a`/`button`), `__head`, `__title`, `__body`, `__foot` | White, 1 px line, 12 radius, no shadow, never tinted |
| 6.15 | Row | `.atlas-list` > `.atlas-row` (`--compact`, `--link`), `__icon` (+tones), `__body`, `__title`, `__link`, `__meta`, `__end`, `__value`, `__action`, `__chevron` | Min 60; phone: action collapses to chevron. Row link: the title is an `<a>`/`<button class="atlas-row__link">` whose hit area is the whole row (hover and focus ring on the row); controls in `__end` stay clickable above it |
| — | Linked target | `.is-linked-target` + `aria-current="true"` on the record a deep link opened (`?movement=`, `?recommendation=`, `?provider=`) | 2.4 s accent wash (`--accent-soft`) that settles on a 3 px `--accent-brand` inset edge; static wash with reduced motion; table rows wash their cells |
| 6.16 | Table | `.atlas-table-wrap` (`--scroll`, `--responsive`), `.atlas-table` (`--compact`), `.atlas-th-sort`, `.is-num`, `.col-check`, `.col-actions`, `.cell-primary`, `.cell-sub`, `.unit`, `.row-action`, `[data-priority]`, `.atlas-par`, `.atlas-bulkbar` (`--sticky`), `__sep`, `.atlas-table-foot`, `.atlas-table-list`, `__row`, `__body`, `__title`, `__meta`, `__value` | Header 36 sticky (`--table-sticky-top`), 12/16 500 sentence case (no uppercase, no tracking), rows 48 / 40 compact, priority 3 hides ≤1279, 2 ≤1023 (columns hide only by `data-priority`); row list below 768; the bulk bar hides below 768 except `--sticky` (a save bar pinned above the tab bar) |
| 6.17 | Stat | `.atlas-stats` > `.atlas-stat`, `__label`, `__value`, `__unit`, `__detail`, `__link` | Hairline-divided row, ≤4, KPI 28/32 |
| 6.18 | Dialog, sheet | `.atlas-modal` (modal.js root / scrim) or `.atlas-scrim`; `.atlas-dialog` (`--form`), `__title`, `__body`, `__error`, `__foot`; `.atlas-sheet` (`--wide`, `--full-phone`), `__grabber`, `__head`, `__title`, `__desc`, `__close`, `__body`, `__foot`, `__foot-start` | Dialog 440/560, sheet 480/640 inset 8; bottom sheet on phones, or a whole screen with `--full-phone`; opaque scrim, no blur |
| 6.19 | Menu, popover, tooltip | `.atlas-menu`, `__item` (`--danger`), `__sep`, `__label`; `.atlas-popover`; `.atlas-tooltip`, `[data-atlas-tooltip]` (`data-atlas-tooltip-align="start"`/`"end"`) | Items 36 (44 touch), tooltip ink 12/16 after 400 ms; a hidden tooltip is not rendered, so a trigger at the viewport edge never widens the page |
| 6.20 | Avatar | `.atlas-avatar` (`--sm` 24, default 28, `--lg` 40, `--xl` 64), tints `--a`…`--d`, `__status` | Initials 600 |
| 6.21, 6.24 | Empty, permission, unavailable | `.atlas-empty` (`--page`, `--inline`), `__icon`, `__title`, `__text`, `__actions` | 40 icon tile, one action. The action is `--secondary` when the page header already holds the primary (usually the same action); `--primary` only when it is the page's single main action |
| 6.22 | Skeleton | `.atlas-skel` (`--text`, `--title`, `--row`, `--block`, `--circle`); `.atlas-skel-page` (`AtlasShell.skeleton()`: page header, toolbar bar, rows) | Appears after 150 ms, 1.4 s shimmer, static with reduced motion |
| 6.23 | Alert | `.atlas-alert` + `--warning`/`--danger`/`--info`/`--positive`, `__content`, `__title`, `__body`, `__actions` | 12 × 16, 12 radius, tinted |
| 6.25 | Toast | `.atlas-toast-region` > `.atlas-toast` (`--success` default, `--info`, `--warning`), `__text`, `__action` | Ink, 44 min, bottom centre (above the tab bar on phones, and above a sticky action bar marked `[data-atlas-sticky-actions]` or `.atlas-bulkbar--sticky`); action 44 px on touch; `AtlasShell.toast(text, { tone })`: a permission or neutral fact is `info`, never the success check |
| 6.26 | Stepper | `.atlas-steps` > `li.is-done`/`.is-current`, `.n`, `.sep`; `.atlas-steps-compact`; `.atlas-steps-wrap`; `.atlas-progress` (`--thin`) | 22 circles; labels never wrap or split; phone "Step 2 of 3 · Review" + 4 px line. In a narrow container (a sheet) wrap both in `.atlas-steps-wrap`: under 720 px of container width the compact form shows |
| 6.27 | Upload | `.atlas-upload` (`.is-dragover`, `--file`), `__thumb`, `__body`, `__title`, `__help`, `__error` | Dashed line-strong, 44 thumb |
| 4.11 | Global feedback | `.atlas-offline-bar`, `.atlas-loading-line`, `.atlas-spinner` | 36 px offline bar, 2 px accent line |

Layout primitives (`atlas-base.css`): `.atlas-stack` (`--xs`/`--sm`/`--md`/`--lg`/`--xl`,
or `--stack-gap`), `.atlas-cluster` (`--end`, `--between`, `--nowrap`),
`.atlas-auto-grid` (`--grid-min`, `--grid-gap`), `.atlas-spacer`, `.atlas-page`
(`--wide`), `.atlas-reading`, `.sr-only`, `.num`, `.atlas-table-scroll`.
Page shapes (`atlas-shell.css`): `.page--wide` (1400 content), full-height
pages (a view registered with `AtlasShell.registerView(name, { fullHeight: true })`
sets `body.atlas-page-full-height`: no content padding or max width; its root
`.page--full-height` fills the height under the top bar and scrolls inside
itself; phones keep the normal flow), `.placeholder-view` +
`.atlas-view-loading` (a view root before its module renders).

Touch (`pointer: coarse`): every interactive element is at least 44 px —
buttons of every size, icon buttons, inputs and selects (16 px text), chips,
segmented buttons, menu items, check rows, notification row actions grow to
44 px. Small inline controls keep their visual size and get an invisible 44 px
hit area (`::after`): `.atlas-link`, `.atlas-section__link`,
`.atlas-record-chip`, `.atlas-chip__clear`, `details > summary`,
`a.cell-primary`, class-less text links (`a[href]:not([class])`, for example
an email or a "Manage" link in a sentence) and `.atlas-hit` for anything else.
The items of a tab set (`.atlas-tabs`) and a segmented control
(`.atlas-segmented`) never get this hit area: they are 44 px boxes already and a
tab draws its active indicator with its own `::after` (a merged `::after` once
drew the indicator through the label). A component that draws with `::after`
is excluded the same way rather than hijacked. The toast action (Undo) is a
44 px box on touch. Modules never add their own touch sizes for shared controls and never give a
link or summary a one-off class that opts it out; they use these classes.
`tests/browser/ux-acceptance.browser.test.mjs` enumerates every visible
interactive element on the key phone screens and fails under 44 px.

Page container: the shell's `.atlas-content` owns the page gutter, the space
above and below the page and its max width. A module's page wrapper
(`.atlas-page`) adds no padding or margin of its own, so every page header
starts at the same x and y.

Tables: `.cell-clip` (on a `td` or a span inside it) truncates a long name to
one line with an ellipsis in a fixed-layout or width-limited column; the full
text goes in `title`. Shared text containers (row title/meta, card and sheet
text, page header, alerts, empty states) wrap a long unbroken token
(`overflow-wrap: anywhere`) instead of overflowing the page. The card, sheet
and dialog bodies only break a token that cannot fit its line
(`overflow-wrap: break-word`), so labels, step names and table headers inside
them never split mid-word; table headers wrap between words only.
Phone lists: below 768 a table becomes an `.atlas-table-list` (the order lines
in an order sheet, temperature points, every list page), so no page or sheet
scrolls sideways; a phone toolbar that scrolls sideways fades out under the
right gutter like the tab strips.

Focus: a heading or sheet title focused programmatically (`tabindex="-1"`)
shows no ring; keyboard focus on controls always does.

Forms — dates and times use native controls: `<input type="date">`,
`<input type="time" step="60">` and `<input type="datetime-local"
step="60">`. The platform picker is the accessible, phone-friendly choice
(calendar and wheel pickers, screen-reader support, no custom widget), so
Atlas does not replace it with text fields. Inside the control the device
locale decides the display (an en-US browser may show mm/dd/yyyy or 5:00 PM);
that is accepted. The value is always ISO — `YYYY-MM-DD`, `HH:MM`,
`YYYY-MM-DDTHH:MM` — and a datetime is read and written in the venue zone
with `AtlasVenueClock.localInputValue` / `fromLocalInput`.

- Give every field its real limits: `min` / `max` (no delivery before the
  venue date, no report period after today), `step="60"` for times.
- An end date takes its start as `min` with
  `data-atlas-min-from="<start field id>"`; the venue clock keeps it in step.
- Inline validation is shared: when a native field is committed or left,
  `AtlasVenueClock.validateNativeField` marks an incomplete, out-of-range or
  off-step value `aria-invalid` and explains it under the field
  (`.atlas-field__error[data-atlas-input-error]`, linked with
  `aria-describedby`, e.g. "Choose Thu 24 Sep or later."). Modules keep
  their own submit checks (required, end after start).
- Times and dates Atlas renders itself (read-only text, tables, cards,
  messages) stay 24 h through `AtlasVenueClock.formatTime` / `formatDate`.
- Known platform exception: inside a native field the device locale decides
  the display, so an en-US device shows 12 h ("05:00 PM") and mm/dd/yyyy in
  Opening hours, Shifts and Marketing fields. Icelandic and UK devices show
  24 h and d.m.y. This is the only place Atlas shows 12 h.
- A submit check that fails marks the field `aria-invalid`, describes it with
  the message placed next to it (Opening hours: a row under that day), moves
  focus to the field and scrolls it into view; it never re-renders the form
  (typed values stay).

The Atlas AI components (spec §6.28: `.ai-conv`, messages, `.steps-line`,
`.record-chip`, `.evidence`, `.approval`, `.composer`, `.voice`) live in the
Atlas AI module stylesheet.

### JavaScript helpers

- `modal.js` (`AtlasModal.register/open/close/isOpen`): a `[data-atlas-modal]`
  root with a `[data-modal-panel]`. The panel gets `role="dialog"`,
  `aria-modal="true"` and `aria-labelledby` its title; focus moves to the first
  field (or the title for read-only dialogs), Tab is trapped, Esc closes, focus
  returns to the trigger, the rest of the page is `inert` and body scroll is
  locked (`body.atlas-modal-open`).
- Shared dialogs (`modal.js`; modules never build their own confirm or prompt):
  `AtlasModal.confirm({ title, body, confirmLabel, cancelLabel, danger, id })`
  → `Promise<boolean>`; `AtlasModal.prompt({ title, body, label, value,
  placeholder, required, multiline, rows, maxLength, type, confirmLabel,
  danger, id })` → `Promise<string | null>` (a required value is asked for in
  the dialog's error line); `AtlasModal.form({ title, body, submitLabel, danger,
  wide, id, onSubmit(form) })` → `Promise<boolean>` that also carries
  `{ root, form, close }`; `onSubmit` may be async and returns an error text to
  keep the dialog open. Text is escaped; `form()`'s `body` is trusted markup.
  `AtlasModal.layer({ id, panel, className, onClose, initialFocus })` opens a
  one-off `.atlas-modal` around a sheet or dialog and removes it on close;
  `AtlasModal.dismiss(root)` closes one.
- Routes: `AtlasShell.show()` / `navigate()` always write the address for the
  view shown, including a shorter route (`#messages/general` → `#messages`);
  modules never write `location.hash` themselves. A legacy alias (`#dashboard`,
  `#business`, `#brain`) is rewritten to its canonical address with
  `replaceState`; an address Atlas doesn't know (`AtlasShell.isKnownRoute`)
  opens the "Page not found" view. `navigate(hash, { replace: true })` writes
  with `replaceState` (closing a sheet opened from a link, so Back doesn't
  reopen it).
- Loading (spec §4.11): the requested page opens at once after sign-in, with
  the correct navigation item and the 2 px `.atlas-loading-line` under the top
  bar while the shell data loads. A view that reads the shell data registers
  with `data: 'shell'` (and optionally `skeleton: (params) => markup`); until
  `data:loaded` the shell draws its skeleton (default `AtlasShell.skeleton({
  title })`) and runs its render/onShow once the data is in. Views that load
  their own data render their own skeleton on show.
- `AtlasShell.notify.open({ filter: 'needs-action' | 'all' })` preselects the
  notifications filter (also `#notifications?filter=needs-action`).
- Badges: `[data-nav-badge="messages"]` (sidebar link, rail dot) and
  `[data-nav-badge="more"]` (tab bar) show the Messages unread count from
  `AtlasTeamUnreadBadge.count()`; `atlas-chrome.js` updates them on every
  `messages:unread` event.
- `AtlasAI.openDecision(recommendationId)` opens `#ai/decisions?recommendation=<id>` (the one decision route):
  Decisions with that row selected and its detail sheet open (Messages links,
  palette records and `AtlasShell.links` `brain_recommendation` use it).
- `AtlasShell.toast(message, { action: { label, onClick }, duration })`: one
  toast at a time, 4 s (8 s with an action), pauses on hover and focus,
  announced through a `role="status"` region. Completed actions only; never for
  errors that need a decision.
- `AtlasShell.menu(trigger, menuEl, { onSelect, align })`: `aria-haspopup` /
  `aria-expanded`, arrows, Home/End, type-ahead, Esc (focus back to the
  trigger), outside click. Idempotent: call it on every render of a list —
  the same trigger + menu returns the existing handle (new options apply), a
  re-rendered menu or trigger replaces the older binding, so listeners never
  pile up. `handle.dispose()` (alias `destroy()`) unbinds.

## 10. Copy (spec §5.9)

Sentence case everywhere. Buttons are verb + object and say what actually
happens ("Create order", "Mark as ordered"), never "Submit" or "OK". No
engineering terms (checkpoint, sprint, phase, branch, RPC, payload, JSON,
agent, tool, token, snapshot, sync, runtime, production, staging, schema).
"Not counted" instead of "Unknown"; "—" only inside tables with the reason in a
tooltip. Errors: what failed + what is safe + what to do. Second person for the
user, first person for Atlas AI.

## 11. States

| State | Pattern |
| --- | --- |
| Loading | Real header and toolbar + `.atlas-skel` at the real layout (after 150 ms); spinners only in buttons and AI progress |
| Empty | `.atlas-empty`: what is missing, why, one action |
| Filtered empty | Name the query; "Clear filters" |
| Error | `.atlas-alert--danger`: "X couldn't be loaded. Your changes are safe." + Try again (backs off) |
| Permission | Page header + `.atlas-empty` "Purchasing is for managers" / "Ask an administrator for access." [Go to Home] |
| Not set up | "Not connected yet" + what it needs + who can connect it |
| Offline | `.atlas-offline-bar`; write buttons disabled with the reason as tooltip |

## 12. Navigation, shell and responsive rules

The shell (sidebar 240 / rail 64 / phone tab bar, top bar, palette,
notifications panel, account menu) is specified in spec §3–§4. Shell geometry
tokens: `--sidebar-rail`, `--topbar-h`, `--tabbar-h`, `--page-max`,
`--page-gutter`, `--reading-max`. Verified widths: 1440, 1280, 1024, 768, 430,
390. No horizontal page scroll at any width; overlays fit the viewport.

## 13. Governance

- New CSS uses tokens from `atlas-tokens.css`; a new colour, radius, size or
  duration means a new token here first. No `:root` variables elsewhere.
- Modules never ship their own button, input, chip, pill, card, tab or colour:
  extend `atlas-components.css` through its owner.
- No override layers, no inline style blocks, no `!important` (except base:
  `[hidden]`, reduced motion, role gating).
- A selector is owned by one file: no cross-file duplicate selectors (the
  hygiene ratchet is at 0). Keyframe names are unique per file (the shell's
  are `atlas-shell-*`).
- A missing or wrong shared pattern is fixed here (tokens, base, components,
  shell) and then consumed; a module never works around it locally. Module
  requests are filed with the design-system owner.
- The S88 legacy layer, its bridge sections and every `legacy/` fragment are
  retired; do not recreate them.
- Evidence for a CSS change: `tests/browser/tools/style-snapshot.mjs`
  (computed styles and screenshots), `cascade-graph.mjs`, the gallery test, and
  the hygiene ratchet `tests/node/css-hygiene-s88.test.js` (ceilings may only go
  down).
