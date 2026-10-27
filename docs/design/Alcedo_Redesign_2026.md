# ALCEDO redesign 2026 — "Basalt & Kingfisher"

Status: canonical from the October 2026 redesign. It replaces the ivory/teal/orange
ALCEDO look (Instrument Serif, Manrope, pill buttons, soft teal shadows). Where this file
and `Atlas_Design_System.md` disagree on a visual value, this file wins; the S88
architecture (files, cascade layers, hygiene rules, role gating) is unchanged.

Sources: the Taste skill's app-screen rules (`.claude/skills/taste-skill/references/app-screens.md`,
style `framed-sheet`, seed 291253737) and Emil Kowalski's design-engineering rules
(`.claude/skills/emil-design-eng/SKILL.md`, `animate`, `review-animations`, `mobile-native`).

## 1. The move

One tinted frame (stone `--bg-subtle` #f3f5f4) holds the sidebar and the 48px top bar
with **no rule between them**. The work sits on a **white sheet** (`--bg`) that butts
against the sidebar and the top bar and is inset 8px (`--sheet-inset`) from the window's
right and bottom edges, with a 1px `--line` edge, 16px corners (`--r-sheet`) and **no
shadow**. Inside the sheet the content has 24px padding (`--page-gutter`).

Colour budget under 3% of pixels. Colour goes on data, status and the one primary
action, never on chrome.

## 2. Palette (tokens in `apps/web/assets/css/atlas-tokens.css`)

| Role | Token | Value |
| --- | --- | --- |
| Frame (sidebar, top bar, phone bars, inset wells) | `--bg-subtle` | #f3f5f4 stone |
| Sheet, cards, inputs, popovers | `--bg`, `--surface` | #ffffff |
| Active nav pill, segmented track, skeleton | `--bg-muted` | #ebedee |
| Row / item hover | `--bg-hover` | #f6f7f8 |
| Ink | `--text` | #131416 |
| Secondary / meta text | `--text-2` / `--text-3` | #4f5254 / #5d6062 (both ≥ 4.5:1 everywhere) |
| Edges / row rules / control borders | `--line` / `--line-subtle` / `--line-strong` | #e8eaec / #f0f1f2 / #cdced1 |
| The one filled primary (white label) | `--accent` | #18191b near-black |
| The one hue: focus, selection, active tab underline, unread dots, charts | `--accent-brand`, `--highlight` | #1f6aa5 kingfisher blue |
| Links / accent text | `--accent-text` | #1b5d91 |
| Info wells, selected chip | `--accent-soft` | #edf3f9 |
| Status | `--positive` `--warning` `--danger` (+ `-soft`, `-ink`) | pale tint + dark ink of the same hue for pills |

The ALCEDO logo is used in **monochrome** (black on light, white on dark), as the logo
kit allows for single-colour use. The 3D kingfisher mascot keeps its own colours.

## 3. Type

- One grotesk: **IBM Plex Sans** (self-hosted variable, latin + latin-ext) for every
  role. No serif anywhere. `--font-display` resolves to Plex Sans.
- **IBM Plex Mono** has one job: IDs, keys, codes. Not for labels, eyebrows or numbers.
- Sizes: page title 22/600 (`--type-title`), section 16/600, card heading 14/600,
  body 14/400, label 13/500, meta 13, caption 12 (the floor). KPI values 28/400 —
  the semibold goes on the label, not the number. Nothing reaches 48px; the greeting
  on Home is the one 26px display line.
- Tabular figures (`font-variant-numeric: tabular-nums`) on every number in a table,
  KPI, count or anything that updates; numbers right-aligned in columns.
- Sentence case everywhere. **No tracked uppercase labels, no monospace eyebrows.**

## 4. Shape and depth

- Tight radii: controls and nav items 6px (`--r-sm`/`--r-md`), cards and popovers 8px
  (`--r-lg`), dialogs and sheets 12px (`--r-xl`), the work sheet 16px. Status pills,
  avatars, toggles and dots stay round (`--r-pill`). **Buttons are not pills.**
- Flat: a resting card has a 1px `--line` border and no shadow. A border or a shadow,
  never both. Shadows (`--shadow-pop`, `--shadow-modal`) only on what floats: menus,
  popovers, tooltips, toasts, dialogs, the palette.
- No gradients, glows, glass or backdrop blur. No icons in tinted circles or squares.

## 5. Components

- **Buttons**: 32px (sm) / 36px (md) / 44px (touch) tall, 6px radius. Primary = near-black
  fill, white label, one per screen. Secondary = white, 1px `--line-strong` border.
  Tertiary = text. Every pressable element: `transform: scale(var(--press-scale))` on
  `:active`, `transition: transform var(--motion-press) var(--ease-out)`.
- **Inputs**: white, 1px `--line-strong`, 6px radius, 36-40px tall; label above at
  13-14/500; on phones `font-size: 16px` so iOS does not zoom.
- **Tabs**: underline tabs on a full-width 1px rule, 2px indicator in ink (or kingfisher
  for the app's active tab), as wide as the label.
- **Nav**: sidebar rows 32px hit area on a 34px pitch, 16px outline icons at 1.5 stroke in
  `--text-2`, label 14/400. Active = neutral `--bg-muted` pill, label unchanged in ink.
  No coloured left bar. Group labels 12px grey sentence case.
- **Tables / lists**: no zebra, no header band; header 12px grey sentence case; rows
  44-56px; 1px `--line-subtle` rules; numbers right-aligned tabular; one status mark per
  row; a missing value is a grey dash, a zero is printed.
- **Status pills**: a 6px dot plus a 13/500 word, no fill, 20px tall, `flex: none;
  white-space: nowrap`. Warning and danger words take their own ink; neutral is a
  hollow ring. One filled tag (`.atlas-pill--solid`) is kept for the single most
  critical state on a screen.
- **Alerts**: a white block with a 1px hairline; the status colour is on the icon
  only (no pink or cream slabs). Tab counts are plain grey numbers.
- **KPIs**: type, not tiles: one container split by 1px dividers, label above value.
- **Empty / loading / error**: the frame and header stay; one sentence; loading is flat
  grey bars at the real size (no shimmer gradient); errors live inside the failed block.

## 6. Motion (Emil Kowalski)

- Should it animate? Keyboard-initiated actions (palette, shortcuts) never animate.
  Hover effects only under `@media (hover: hover) and (pointer: fine)`.
- Easing: enter/exit `--ease-out` cubic-bezier(.23,1,.32,1); on-screen movement
  `--ease-in-out`; sheets/drawers `--ease-drawer`. Never ease-in.
- Durations: press 140ms, hover/colour 120ms, menus/popovers 180ms, dialogs/sheets
  240ms. Nothing in the UI over 300ms.
- Specify properties: never `transition: all`. Animate `transform` and `opacity` only.
- Never from `scale(0)`: popovers enter from `scale(.96)` + `opacity: 0`, origin-aware
  (`transform-origin` at the trigger); modals stay centred.
- Exits faster than enters. Use transitions (interruptible) over keyframes for
  anything triggered repeatedly. `@starting-style` for enter states where supported.
- `prefers-reduced-motion`: keep opacity and colour fades, drop movement (the
  `--move-*` tokens already collapse to 0).
- Phone sheets drag down to dismiss (`AtlasShell.sheetGesture`): they follow the
  finger, resist upward, and close on a flick or a drag past 30%. Esc, Cancel and
  submit close at once.
- Tooltips appear instantly when another tooltip showed in the last 300ms; shared
  menus grow from the trigger's corner (`--atlas-origin`).

## 7. Phone (≤ 767px)

The frame disappears: the sheet becomes the screen (`--sheet-inset: 0`), a 48px top bar
on the stone frame tint, the bottom tab bar on the frame tint with a 1px top rule. Touch
targets ≥ 44px, margins 16px, inputs at 16px, `-webkit-tap-highlight-color: transparent`,
`touch-action: manipulation` on controls, safe-area insets respected, `100dvh` not
`100vh`. Tables become two-line rows.

**Large title.** The page H1 stays visible at 20px under the top bar; the bar shows
the page name only once that H1 scrolls under it (or at once when the page has no
visible H1 or owns the bar with a back button). The bar's Alcedo mark has a 44px hit
area.

## 8. Icons

One self-hosted set replaces Lucide (unpkg): `apps/web/assets/js/alcedo-icons.js`,
the ALCEDO icon set, built on **Phosphor Icons 2.1.1 Regular** (MIT,
`apps/web/assets/icons/LICENSE-phosphor.txt`) plus custom glyphs drawn as 16-unit
round-capped centre lines on Phosphor's 256 grid, so every icon carries the same
weight and corners. `apps/web/assets/icons/README.md` maps every app name to its
glyph and records how each custom glyph is built.

- Filled paths in `currentColor`; size with width and height (`--icon-sm` 16,
  `--icon-md` 18, `--icon-lg` 20, `--icon-xl` 22). There is no stroke width.
- Markup is unchanged: `<i data-lucide="name">` plus `lucide.createIcons()` (the
  set provides that API and the `lucide.icons` nodes), or
  `AlcedoIcons.svg(name, { size, className, label })` in template strings. An
  unknown name draws a dashed circle and warns once; `tests/node/alcedo-icons.test.js`
  fails if any name used in `apps/web` has no glyph.
- Icons are plain grey glyphs (`--text-2`/`--text-3`); colour only where the icon
  is the status (a warning or failure glyph in its status colour). Never in a
  tinted circle or square.
- **The kingfisher mark** (`alcedo`, `atlas-bot`) is Alcedo's symbol at UI size:
  the sidebar and tab-bar Alcedo AI entries and every small "Ask Alcedo" control
  (Home briefing, module headers and drawers, the palette, the More sheet, the
  Alcedo system avatar in Messages, "Filled by Alcedo" in Accounting). The full
  3D mascot (`atlas-bot.js`) is drawn only inside the Alcedo AI view: the welcome
  robot, the who-line of an answer and the voice panel.
- **The navigation family** (house, messages, clipboard, martini, a bottle for
  Inventory, truck, calendars, users, book, chart, megaphone, receipt, price tag,
  database, gear) is drawn for Alcedo on Phosphor's stroke weight with round caps
  and joins; its signature is one sharp "beak" corner at the top right of each
  container. Purchasing uses the truck everywhere (nav, palette, actions).
- Toasts, the PWA banner and the shell build their icons from the same set; the
  file is precached by the service worker and allowed by the CSP as same-origin.

## 9. Patterns the module teams settled on

Good deviations and additions from the module passes, now part of the direction:

- **One question per screen.** Each page's subtitle states its finding, counted
  from the rows on screen ("2 deliveries late · 1 waiting for approval", "41 of 59
  locked prices are under the 5% cash floor"), and the biggest block answers it.
- **Data marks instead of tiles.** Tick bars (one segment per checklist item:
  kingfisher while open, positive when done) on Home and Operations; an on-hand
  track at the true ratio to par under every Inventory quantity, plus one stacked
  stock-health partition; a pipeline strip that doubles as the Purchasing stage
  filter; the Shifts rota (filled = published, dashed = draft, hatched = time
  off); the Bookings floor plan with one mark per booking state; inline-SVG
  charts in Reports in one hue, drawn only when their buckets add up to the KPI
  shown.
- **Missing is a dash.** `.atlas-stat__value.is-empty` is the shared grey dash at
  section size for a KPI the data does not report; a real zero is printed.
- **One primary per screen**, enforced where several rows need a next step
  (Settings › Integrations fills only the first provider's step).
- **Phone rows**: a row that opens as a whole (a stretched link) shows a chevron
  and hides its trailing buttons; a row whose buttons are its job (Confirm,
  Approve, Count now, Edit) keeps them.
- **No page-entry animation.** Navigation is the most frequent action, so a page
  appears at once; nothing replays when a module re-renders on a keystroke,
  filter or save.
- **Floating composers.** The Alcedo AI and Messages composers are the one
  floating surface on their screens (`--shadow-pop`, 12 px corners).
- **Identity colour is data.** Six muted hues (`--person-1..6`, no orange, no
  teal) serve the twelve Shifts person slots and the Bookings areas, only as a
  14 % tint, a 3 px edge or an 8 px dot.
- **Figures read the Icelandic way.** Krónur group with "." ("3.900 kr");
  percentages use a decimal comma and a no-break space ("64,0 %"); Menu Pricing
  writes a loss with a true minus ("−2,3 %"). `AtlasFormat.money` keeps the
  hyphen for now because the server's formatter (Atlas AI, Reports) must match
  it byte for byte; switching both is a backend change.
- **The Alcedo AI welcome robot** is the whole bird (`framing: 'full'`), its feet
  about 12px above the greeting.
- **Header actions**: at most one secondary and the primary; an Alcedo action is
  the ghost kingfisher-glyph button just before the primary; anything else goes in
  a ⋯ menu.
- **Shared two-factor enrolment** (`.atlas-mfa-enroll`, three numbered steps on
  one hairline, the setup key the one mono string) serves Settings, the sign-in
  step and the invitation wizard.
- **Monochrome logo** in the sidebar and phone top bar is the kit symbol drawn
  inline at small size (the open A and the beak, without the hairline horizon)
  beside the wordmark cropped from `logo-black.svg`, the venue on its own caption
  line; sign-in, invitation and recovery use
  the stacked `logo-black.svg`.

## 10. What must not change

Behaviour, routes, data, ARIA, test hooks (`data-*`, ids, class names the JS or tests
query), role gating, CSP (no inline styles/scripts, no new hosts), the S88 cascade
architecture and hygiene ratchet (`tests/node/css-hygiene-s88.test.js`: one `@layer`
block per stylesheet, tokens only in `atlas-tokens.css`, no new `!important`, no
cross-file duplicate selectors, no font size under 12px).
