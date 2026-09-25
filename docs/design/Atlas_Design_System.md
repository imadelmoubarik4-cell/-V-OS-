# Atlas Design System

Status: canonical from S88 (the Atlas experience redesign). It replaces the S87
version of this file. Final S88 consolidation (2026-09-25): every module team's
design-system request is implemented here, the module workarounds are gone and
the legacy layer is retired — there is no `atlas.legacy` layer, no
`assets/css/legacy/` directory and no inline style block in `index.html`. The build specification is
`docs/design/Atlas_Experience_Redesign.md` (§5 visual language, §6 components);
the visual north star is `docs/design/atlas-reference.html`. Where this file and
the spec disagree, the spec wins; fix this file.

Direction: light, cool-neutral, precise (Brand v1.0, `docs/brand/README.md`).
White canvas, Snow insets, Midnight ink, Mist hairlines; structure from type,
spacing and hairlines rather than boxes. The logo is always monochrome (the
supplied kit files, never redrawn or typed). One accent colour, Atlas Blue, for
the primary action, links, focus, selection and the Atlas AI mark. No glass, no
gradients, no blur, no coloured shadows. Functional truth before decoration:
never style a control as available when its behaviour does not exist, never
show a guessed number.

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

## 1. Colour (spec §5.2; Brand v1.0 from 2026-09-24)

Brand palette (verbatim from the kit, `docs/brand/Atlas_Brand_Identity_Kit_v1.0/07_Developer/atlas-brand-tokens.css`):
`--atlas-midnight #0B0F14`, `--atlas-slate #1F2937`, `--atlas-mist #CBD5E1`,
`--atlas-snow #F8FAFC`, `--atlas-blue #3B82F6`. Every token below derives from
them. Contrast ratios are checked by `tests/node/brand-kit-v1.test.js`.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#ffffff` | Content canvas |
| `--bg-subtle` | `#f8fafc` (Snow) | Sidebar, table header, inset panels, AI list |
| `--bg-muted` | `#f1f5f9` | Hover on subtle, segmented track, skeleton |
| `--bg-hover` | `#fbfcfd` | Table row hover |
| `--surface` | `#ffffff` | Cards, sheets, popovers |
| `--overlay` | `rgba(11,15,20,.32)` (Midnight) | Scrim |
| `--text` | `#0b0f14` (Midnight, 19.2:1) | Headings and primary text |
| `--text-2` | `#475569` (7.6:1; 6.9:1 on `--bg-muted`) | Secondary text, metadata, table headers |
| `--text-3` | `#606c80` (5.3:1; 4.9:1 on `--bg-muted`) | Placeholders, disabled, group labels, meta — AA on every surface, still never body copy |
| `--ink` | `#1f2937` (Slate) | Tooltips, toasts, bulk bar (white text 14.7:1) |
| `--line` | `#e2e8f0` | Card borders, dividers (hairline derived from Mist) |
| `--line-strong` | `#cbd5e1` (Mist) | Inputs, secondary buttons |
| `--line-hover` / `--control-border` | `#94a3b8` | Input hover; checkbox / radio outline |
| `--line-subtle` | `#f1f5f9` | Row dividers inside cards and tables |
| `--accent-brand` | `#3b82f6` (Atlas Blue) | Focus ring, selection and active-nav markers, unread dots, icons, badges, charts, AI mark. Never behind text. |
| `--accent` | `#2563eb` (5.2:1 with white) | Primary button fill, accent text and links, count badges |
| `--accent-hover` / `--accent-press` | `#1d4ed8` / `#1e40af` | Primary hover / pressed |
| `--accent-soft` / `--accent-soft-hover` | `#eff6ff` / `#dbeafe` | Selected rows, active chip, info tiles (washes of Atlas Blue) |
| `--accent-text` | = `--accent` (4.8:1 on `--accent-soft`) | Link and label text on white or accent-soft |
| `--accent-ring` | `rgba(59,130,246,.20)` | Input focus ring |
| `--positive` / `--positive-soft` | `#047857` / `#ecfdf5` | Ready, counted, verified, done (5.2:1 on soft) |
| `--warning` / `--warning-icon` / `--warning-soft` | `#b45309` / `#d97706` / `#fffbeb` | Below par, due soon, draft (text 4.8:1 on soft; icon colour non-text only) |
| `--danger` / `--danger-soft` | `#c42020` / `#fef2f2` | Out, failed, overdue, destructive (5.4:1 on soft, 5.9:1 white-on-fill) |
| `--neutral-soft` | `#f1f5f9` | Neutral pills, count badges, icon tiles |
| `--accent-illustration` | = `--atlas-blue` | Charts and illustration |

**Accessibility decision (Brand v1.0).** Atlas Blue `#3B82F6` is the brand and
interface accent, but white text on it is 3.7:1 and fails WCAG AA (4.5:1).
Therefore text-bearing accent fills (primary buttons, count badges) and blue
text/links use the darker same-hue `--accent` `#2563EB` (5.2:1), hover
`#1D4ED8` (6.7:1). Atlas Blue itself (`--accent-brand`, `--focus-color`) is
used where no text sits on it: focus rings, markers, dots, icons and charts,
where it clears the 3:1 non-text minimum on white (3.7), Snow (3.5),
`--bg-muted` (3.4), `--accent-soft` (3.4) and Slate (4.0).

Rules
- Status colour always comes with a word or an icon.
- Tinted backgrounds only on pills, icon tiles, alerts and selected rows —
  never on whole cards or page sections. No blue icon tiles as decoration.
- Dark mode is out of scope; a dark set can be added under
  `:root[data-theme="dark"]` without renaming anything.

Legacy names (all aliases in `atlas-tokens.css`, do not use in new CSS):
`--atlas-bg`, `--color-background` → `--bg`; `--atlas-surface-sunken`,
`--atlas-sidebar`, `--blue-50`, `--glass-fill-soft` → `--bg-subtle`;
`--atlas-surface`, `--atlas-surface-solid`, `--color-surface`, `--glass-fill*`
→ `--surface`; `--atlas-text`, `--color-text`, `--s38-ink` → `--text`;
`--atlas-muted`, `--color-text-secondary`, `--s38-muted` → `--text-2`;
`--atlas-subtle`, `--color-text-tertiary` → `--text-3`; `--atlas-line`,
`--color-border`, `--glass-line`, `--s38-line` → `--line`;
`--atlas-line-strong`, `--glass-line-strong`, `--atlas-home-accent-line`,
`--s38-blue-line` → `--line-strong`; `--atlas-accent`, `--color-primary`,
`--atlas-action`, `--atlas-home-accent`, `--s38-blue`, `--blue-400/500/600`,
`--atlas-info` → `--accent`; `--atlas-accent-strong`, `--atlas-action-hover`,
`--blue-700`, `--s38-blue-strong` → `--accent-hover`; `--atlas-accent-soft`,
`--atlas-info-soft`, `--s38-blue-soft`, `--blue-100` → `--accent-soft`;
`--atlas-green(-soft)` → `--positive(-soft)`; `--atlas-warn(-soft)` →
`--warning-icon`/`--warning-soft`; `--atlas-danger(-soft)` → `--danger(-soft)`.
Glass primitives are flat: `--glass-blur: none`, `--glass-highlight` and
`--glass-shadow` are no shadow, `--glass-shadow-raised` is `--shadow-pop`.

## 2. Typography (spec §5.3)

Families: `--font-sans` IBM Plex Sans (UI, 400/500/600); `--font-display`
Fraunces 500 `opsz` 72 — Home greeting, sign-in heading and the Atlas AI empty
state only; `--font-mono` IBM Plex Mono — codes, SKUs and audit-log times only,
never money or quantities.

| Role | Token (`font:` shorthand) | Size/line | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Display | `--type-display` | 32/38 (28/34 phone) | Fraunces 500 | `--track-display` −0.02em |
| Page title | `--type-title` | 24/32 (22/28 phone) | 600 | `--track-title` −0.015em |
| Section | `--type-section` | 17/24 (sheet titles 18) | 600 | `--track-section` −0.005em |
| Heading | `--type-heading` | 15/22 | 600 | 0 |
| Body | `--type-body` | 14/20 (15/22 phone) | 400 | 0 |
| Body large | `--type-body-lg` | 15/24 | 400 | 0 |
| Label | `--type-label` | 13/18 (14 for tabs and buttons) | 500 | 0 |
| Meta | `--type-meta` | 13/18 | 400 | 0 |
| Caption | `--type-caption` | 12/16 — **the minimum size** | 400/500 | 0 |
| KPI | `--type-kpi` | 28/32 (22/28 phone) | 500 | `--track-kpi` −0.02em |
| Numeric | `--type-num` | 14/20 | 500 | 0 |

Size-only tokens for rules that set `font-size`: `--fs-display`, `--fs-title`,
`--fs-section`, `--fs-heading`, `--fs-body`, `--fs-body-lg`, `--fs-label`,
`--fs-caption`, `--fs-kpi`. Legacy `--text-*` sizes alias these by role;
`--text-micro` is 12 px (micro labels are retired).

- `font-variant-numeric: tabular-nums` in tables, KPIs, times and money (`.num`).
  Numeric columns are right-aligned. Money is "3.900 kr" via
  `AtlasFormat.money()`.
- Sentence case. No uppercase labels, no letter-spaced eyebrows, nothing under
  12 px. 600 only for titles, headings and selected emphasis; 500 for labels and
  row titles; 700+ never.

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

## 4. Radius (spec §5.5)

`--r-xs` 4 (checkbox, kbd, skeleton) · `--r-sm` 6 (segmented inner, small tags,
tooltip) · `--r-md` 8 (buttons, inputs, nav items, record chips) · `--r-lg` 12
(cards, tables, alerts, popovers, toasts) · `--r-xl` 16 (dialogs, sheets,
palette, composer) · `--r-pill` (pills, chips, avatars, toggles). Legacy
`--radius-*`, `--atlas-radius`, `--atlas-card-radius`, `--s38-radius` alias these.

## 5. Elevation (spec §5.6)

- `--shadow-1` `0 1px 2px rgba(23,25,30,.05)` — secondary buttons, active nav
  item, approval card.
- `--shadow-pop` — menus, popovers, notification panel, toasts, voice panel.
- `--shadow-modal` — dialogs, sheets, palette.
- Cards at rest have **no shadow**, only a 1 px `--line` border. No coloured
  shadows. `--shadow-none` is the explicit "no shadow" value.

## 6. Motion (spec §5.7)

| Token | Value | Use |
| --- | --- | --- |
| `--dur-1` | 120 ms | Hover, press, colour |
| `--dur-2` | 180 ms | Menus, popovers, toggles, tabs, row expand |
| `--dur-3` | 240 ms | Sheets, dialogs, palette |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | Entering |
| `--ease-in-out` | `cubic-bezier(.4,0,.2,1)` | Moving, resizing |

Enter = 4–8 px translate + opacity; exit = opacity only at 70 % of the enter
duration. No bounce, no scale above 1, no hover lift, no looping animation
except spinners, skeletons and the live-voice waveform. `prefers-reduced-motion`
and `html.atlas-reduce-motion` (the personal preference) cut every duration to
~0 in `atlas-base.css`; the skeleton shimmer is static.

## 7. Focus and accessibility

- `--focus-outline` (2 px solid `--focus-color` = Atlas Blue `#3b82f6`) with
  `--focus-offset` 2 px on every interactive element (`:focus-visible`,
  `atlas-base.css`). Inputs show the Atlas Blue border plus `--focus-ring`
  (3 px `rgba(59,130,246,.20)`) instead. The ring is ≥ 3:1 against every
  surface it can sit on (`tests/node/brand-kit-v1.test.js`).
- Contrast AA: text ≥ 4.5:1, large text and UI ≥ 3:1 (checked by the gallery
  test). Touch targets ≥ 44 px under `(pointer: coarse)`; inputs use 16 px text
  on touch. Pinch zoom stays allowed.
- Keyboard: reading order; Esc closes overlays; focus returns to the trigger.

## 8. Icons (spec §5.8)

Lucide 0.454.0 only. Sizes `--icon-sm` 16 (inline, buttons, rows), `--icon-md`
18 (top bar, header icon buttons), `--icon-lg` 20 (sheet close, phone top bar),
`--icon-xl` 22 (tab bar). Stroke `--icon-stroke` 1.75 (`--icon-stroke-xl` 1.6
at 22, `--icon-stroke-strong` 2 for the active tab and send). Classes `.icon`,
`.icon--md`, `.icon--lg`, `.icon--xl` (aliases `.atlas-icon*`); every rendered
`svg.lucide` gets the 1.75 stroke. Colour is `currentColor`. One meaning per
icon (spec §5.8 list); no emoji; no decorative icons.

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
| 6.25 | Toast | `.atlas-toast-region` > `.atlas-toast`, `__text`, `__action` | Ink, 44 min, bottom centre (above the tab bar on phones) |
| 6.26 | Stepper | `.atlas-steps` > `li.is-done`/`.is-current`, `.n`, `.sep`; `.atlas-steps-compact`; `.atlas-progress` (`--thin`) | 22 circles; phone "Step 2 of 3 · Review" + 4 px line |
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
Modules never add their own touch sizes for shared controls and never give a
link or summary a one-off class that opts it out; they use these classes.
`tests/browser/ux-acceptance.browser.test.mjs` enumerates every visible
interactive element on the key phone screens and fails under 44 px.

Page container: the shell's `.atlas-content` owns the page gutter, the space
above and below the page and its max width. A module's page wrapper
(`.atlas-page`) adds no padding or margin of its own, so every page header
starts at the same x and y.

Time fields: `<input … ${AtlasVenueClock.TIME_INPUT_ATTRS}>` (a text field
with `data-atlas-time`), never `type="time"`, which shows 12-hour times in
en-US browsers. The venue clock reads "1730", "17.30" or "9" as 17:30 / 09:00
when the field is committed; the value is `HH:MM` like a native time input.
Displayed times go through `AtlasVenueClock.formatTime` (24 h).

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
