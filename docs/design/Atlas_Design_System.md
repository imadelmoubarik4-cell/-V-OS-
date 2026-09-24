# Atlas Design System

Status: canonical from S87. Tokens live in `apps/web/assets/css/atlas-tokens.css`,
which loads after every other static stylesheet. New screens and new CSS must use
these tokens and components; do not add new `:root` colour, radius or spacing
definitions in module stylesheets.

Direction: calm, light, precise. Warm-neutral surfaces, Atlas blue as the only
interactive colour, restrained status colours, and information before decoration.
Functional truth comes before cosmetics: never style a control as available when
its behaviour does not exist.

## 1. Colour

| Token | Value | Use |
| --- | --- | --- |
| `--atlas-accent` / `--color-primary` | `#2f80ed` | The one interactive colour: primary buttons, links, focus, selection |
| `--atlas-accent-strong` | `#1f66c9` | Primary hover / pressed |
| `--atlas-accent-soft` | `#e8f1fd` | Selected rows, active tabs, highlight wash |
| `--atlas-text` / `--color-text` | `#10151c` | Primary text |
| `--atlas-muted` / `--color-text-secondary` | `#6b7787` | Secondary text, metadata |
| `--atlas-subtle` / `--color-text-tertiary` | `#8a94a3` | Placeholders, disabled labels |
| `--atlas-line` / `--color-border` | `rgba(16,60,110,.10)` | Hairlines and card borders |
| `--atlas-line-strong` | `rgba(16,60,110,.16)` | Input borders, dividers that must read |
| `--atlas-bg` / `--color-background` | `#ffffff` | Application background |
| `--atlas-surface` | `rgba(255,255,255,.72)` | Glass card surface |
| `--atlas-surface-solid` / `--color-surface` | `#ffffff` | Opaque surface (modals, popovers) |
| `--atlas-surface-sunken` | `#f6f7f9` | Inset areas, answer cards |

Status colours have one meaning everywhere:

| Meaning | Token | Soft background |
| --- | --- | --- |
| Positive / ready / verified | `--atlas-green` `#1f9d76` | `--atlas-green-soft` |
| Attention / below par / draft | `--atlas-warn` `#c98a2e` | `--atlas-warn-soft` |
| Danger / unavailable / destructive | `--atlas-danger` `#d05c5c` | `--atlas-danger-soft` |
| Information | `--atlas-info` `#2f80ed` | `--atlas-info-soft` |

Rules
- One primary blue. Before S87, primary actions used `#2d78dc`, `#4f7df3` and
  `#2f80ed`; the module aliases (`--atlas-action`, `--atlas-home-accent`,
  `--s38-blue`) now resolve to `--atlas-accent`.
- No black primary buttons. No colour-only status: pair colour with a label
  ("Below par", "Not counted") or an icon.
- Most cards are white/glass; do not tint cards by category.

## 2. Typography

| Role | Token | Size / weight |
| --- | --- | --- |
| Page title (display) | `--text-display` | 32px, `--font-display` (Fraunces) 500 |
| Section heading | `--text-title` | 22px, 500–600 |
| Card heading | `--text-heading` | 17px, 600 |
| Body | `--text-body` | 14px, 400 |
| Metadata | `--text-meta` | 13px, 400, `--atlas-muted` |
| Caption | `--text-caption` | 12px — the smallest size for readable text |
| Micro label | `--text-micro` | 11px, uppercase, `.06em` tracking — labels only |
| KPI number | `--text-kpi` | 30px, tabular figures |

Families: `--font-sans` (IBM Plex Sans) for UI, `--font-display` (Fraunces) for
page titles only, `--font-mono` for times and codes. Weights: 400, 500, 600 —
avoid 700+ except KPI numerals. Never go below 11px (S87 measured ~390 elements
at 7–9px; see the health report's remaining debt).

## 3. Spacing

Scale (px): `4 8 12 16 20 24 32 40 48 64` → `--space-1 … --space-16`.
- Inside controls: 8–12. Inside cards: 16–20 (24 on desktop panels).
- Between cards in a grid: 12–16. Between page sections: 24–32.
- Page gutter: 16 on phones, 24–32 on desktop.
Avoid off-scale values (17, 27, 38px…) unless aligning to an icon or border.

## 4. Radius

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | 8px | Badges, chips inside controls |
| `--radius-md` | 12px | Inputs, buttons |
| `--radius-lg` | 16px | Cards |
| `--radius-xl` | 20px | Panels, modals, sheets |
| `--radius-pill` | 999px | Pills, search fields, segmented tabs |

## 5. Surfaces, borders and elevation

- Hierarchy: background → card (`--atlas-surface`, `--atlas-line`) → raised
  (popover/modal: `--atlas-surface-solid`, `--shadow-popover`).
- Borders are hairlines (`--atlas-line`). Use `--shadow-1` for resting cards,
  `--shadow-2` for hover/raised, `--shadow-popover` for menus and dialogs.
- Elevation communicates hierarchy; do not add shadows for decoration.
- Selected: `--atlas-accent-soft` background + accent text or outline.
  Hover: a subtle border or shadow change. Disabled: 55% opacity and
  `cursor: not-allowed`.

## 6. Buttons

| Style | Look | Use |
| --- | --- | --- |
| Primary | `--atlas-accent` fill, white text, `--radius-md` | The single most important action on a screen |
| Secondary | White fill, `--atlas-line-strong` border, text colour | Other actions |
| Ghost | No fill, accent or text colour | Navigation, low emphasis ("Open", "See analysis") |
| Danger | `--atlas-danger` text or fill | Destructive actions only, always confirmed |

- Heights: `--control-md` (40px) default, `--control-sm` (32px) in dense
  tables; minimum `--touch-target` (44px) on touch screens (`pointer: coarse`).
- One primary action per screen or card. Icons 16px, 8px gap, weight 500–600.
- A button's label states what actually happens ("Mark as ordered", not
  "Submit order", when nothing is sent to the supplier).
- Icon-only buttons need an `aria-label`.

## 7. Inputs and forms

- Inputs and selects share one anatomy: 40px height, `--radius-md`,
  `--atlas-line-strong` border, 12px horizontal padding, 14px text.
- Labels sit above fields (`--text-meta`, 500). Help text below in
  `--text-caption` `--atlas-muted`. Validation appears next to the field or in
  the form footer — never only in a page-level banner.
- Every input has a `<label>` or `aria-label`; placeholders are examples, not
  labels.
- Save state is per form: only the saved form shows "Saving…" and its result.
- Search fields: pill radius, 16px magnifier inside the field at 12px from the
  left (decorative, `pointer-events: none`), 38px left padding.

## 8. Toggles

- One size everywhere (the Settings toggle). Label on the right, helper text
  below the label.
- A toggle that persists changes to the server shows the new state only after
  the server confirms; failures are reported beside it.
- Only show a toggle for behaviour that exists. Stored-but-unused settings are
  labelled "Saved for upcoming features"; unavailable features are shown as
  text ("Not available yet"), not as disabled toggles.

## 9. Tables and data workspaces

- Dense operational data stays in tables (Inventory, Purchasing, Reports).
- Row height 44–52px; numeric columns right-aligned with tabular figures;
  header sticky where the list scrolls.
- Wide tables scroll inside their card with `.atlas-table-scroll`; the page never
  scrolls sideways.
- Row actions: 36px targets (44px on touch), with accessible names.
- Filters are visible chips that can be cleared ("Below par only ×").

## 10. Cards

- Cards group one idea. A card that looks clickable must be a `<button>` or
  link that navigates to the matching filtered view (Operations summary cards,
  Home metric cards).
- KPI cards: label (`--text-meta`), value (`--text-kpi`), one line of context.
  Show "—" with a reason when data is not available; never a guessed number.

## 11. Modals and sheets

- `--radius-xl`, `--atlas-surface-solid`, `--shadow-popover`, max width 560px
  (720px for editors), full width minus 24px on phones.
- `role="dialog"`, `aria-modal="true"`, labelled by the title; focus moves in
  on open and returns on close; Escape closes; Enter submits the form.
- Destructive confirmations say exactly what will and will not change. Irreversible
  deletes require typing the record name (recipes).

## 12. Navigation

- One sidebar with grouped destinations (Home, Operations, People, Growth,
  Insights, System). The active item uses the accent wash.
- Page title in the top bar; one global search ("Search or ask Atlas…").
- Secondary navigation inside a page uses pill tabs.
- Deep links use `#view` (e.g. `#team`, `#reports/stock`).

## 13. States

| State | Pattern |
| --- | --- |
| Loading | Short title + one line of context + skeleton blocks; no spinners longer than needed |
| Empty | What is missing and the one action that fills it |
| Error | "X unavailable", the reason, and **Try again** (automatic retries back off) |
| Permission | "Limited to managers and administrators" |
| Unavailable integration | "Not available yet" + what it requires |
| No results | What was searched and a suggestion |

Copy uses operational language. Never show internal labels (checkpoints,
sprints, phases, branches, "production source mutation") in product UI.

## 14. Motion

- 150–200ms (`--motion-fast`, `--motion-base`) with `--ease-standard`.
- Hover, press, expand and selection only; no bouncing or decorative motion.
- Respect both `prefers-reduced-motion` and the personal **Reduce motion**
  preference (`html.atlas-reduce-motion`), which disables transitions globally.

## 15. Focus and accessibility

- Visible focus on every interactive element (`:focus-visible` outline in the
  accent colour, 2px, 2px offset — defined next to the tokens, since S88 in
  `legacy/atlas-tokens--base.css`; moves to `atlas-base.css`).
- Keyboard: Tab order follows reading order; `/` focuses search; arrows move
  through search results; Escape closes menus and dialogs.
- Contrast: text on surfaces meets WCAG AA; status is never colour-only.

## 16. Responsive rules

Verified widths: 1440, 1280, 1024, 768, 430, 390.

- ≥1050px: sidebar 268px; content max 1540px.
- 761–1049px: sidebar 224px; grids drop to two columns.
- ≤760px: sidebar becomes an overlay; the search field becomes a 44px control
  that expands across the top bar; cards stack; tables scroll inside their card.
- No horizontal page scroll at any width; modals fit the viewport; touch
  targets ≥44px on touch screens.

## 17. Governance

- New CSS uses tokens from `atlas-tokens.css`. Adding a colour, radius or font
  size means adding a token here first.
- Do not add new "polish"/"remediation" override layers or `!important`;
  change the owning component stylesheet instead.
- The S87 health report lists the remaining legacy debt (override layers,
  `!important`, off-scale sizes) to retire module by module.
- Cascade layers (S88). `atlas-tokens.css` is linked first and declares
  `@layer atlas.tokens, atlas.base, atlas.legacy, atlas.components, atlas.modules;`.
  A later layer beats an earlier one for normal declarations whatever the
  specificity or load order; for `!important` the order reverses. Every
  pre-S88 stylesheet sits in `atlas.legacy` in its old order, and the retired
  override files live on as `assets/css/legacy/<source>--<module>.css`
  fragments owned by the module they style. `atlas.base` sits below legacy so
  a new element-level rule cannot restyle a page that has not been rebuilt
  (land it together with deleting the legacy rule it replaces); opt-in
  component classes (`atlas.components`) and consolidated module sheets
  (`atlas.modules`) win over legacy. Consolidating a module means: merge its
  fragments into its stylesheet using their effective values (or rewrite it
  against the components), change its `@layer atlas.legacy` to
  `@layer atlas.modules`, remove its `!important` in the same commit (an
  `!important` left in `atlas.legacy` still wins), and delete the fragments.
  Custom properties are defined on `:root` only in `atlas-tokens.css`.
- Evidence for a CSS change: `tests/browser/tools/style-snapshot.mjs` (computed
  style of every element, 2 roles × 4 widths) and `cascade-graph.mjs`; the
  hygiene ratchet is `tests/node/css-hygiene-s88.test.js`.
