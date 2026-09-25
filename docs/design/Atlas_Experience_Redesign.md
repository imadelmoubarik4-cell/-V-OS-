# Atlas Experience Redesign — build specification

Status: S88 design spec, built. Owner: lead product designer.
Implementation status (2026-09-25): every module team has merged and the
design-system owner's final consolidation is done — all module requests are
implemented centrally in `atlas-tokens/base/components/shell`, the module
workarounds are removed, and the legacy layer (§9.1 step 3) is retired: no
`atlas.legacy` layer, no `assets/css/legacy/`, no inline `index.html` style,
`!important` only in base for `[hidden]`, reduced motion and role gating. The
canonical inventory is `docs/design/Atlas_Design_System.md`.
Visual north star: `docs/design/atlas-reference.html` (open it in a browser; screens
via `#home`, `#inventory`, `#inventory-new`, `#ai`, `#ai-approval`, `#ai-voice`,
`#count`, `#palette`, `#components`). Where this document and the reference
disagree, **this document wins**; report the mismatch to the designer.

This document supersedes the conflicting parts of `docs/design/Atlas_Design_System.md`
(colours, radius, type scale, navigation §12, responsive §16). E1 updates that file
in the same PR that lands the new tokens so there is one design system again.

Inputs: current UI inventory (screenshots of every view at 1440 and 390, admin and
bartender, in the S88 scratchpad `redesign-current/`), the CSS/architecture audit
(cascade layers, canonical `window.AtlasShell`), `docs/ai/Atlas_AI_Architecture.md`
and the S88 product-debt designs (venue clock, server checklists, purchasing
approvals and receiving, Data review and bulk pars, integrations).

Mechanisms this spec builds **on** and does not redesign: CSS cascade layers
`atlas.tokens, atlas.base, atlas.components, atlas.modules`; `AtlasShell.registerView /
show / on / home.contribute / links.register / modules.ensure`. One small extension is
specified (§4.8 `AtlasShell.actions`, §4.9 `AtlasShell.notify`), built by E1.

Contents
1. What is wrong today
2. Principles
3. Information architecture
4. Shell
5. Visual language and tokens
6. Components
7. Pages
8. Phone-first flows
9. Implementation map and work split
10. Acceptance criteria
11. Owner decisions

---

## 1. What is wrong today

Observed in the harness at 1440 and 390 for admin and bartender (Playwright,
fixtures with 10 items, 3 recipes, 3 suppliers).

**Structure**
- 17 sidebar destinations in 6 labelled groups; Settings and System fall below the
  fold at 1440×900. Four of them overlap: *Operations Center*, *Atlas Brain*,
  *Business Intelligence* and *Home* each open with a greeting or a readiness score
  for the same day. *Import* sits both in the Inventory tab bar and as a page;
  *Real VÁ Data* is a second import review.
- Bartenders see *Business Intelligence*, *Atlas Brain*, *Marketing* and *System*
  and land on empty or "unavailable" states in all four.
- Operations renders two implementations stacked (operations.js hero + checkpoint-A
  "Scheduled routines" + a device-local checklist).
- The bell opens Settings › Notifications (a preferences page), not notifications.
  In that page an administrator is labelled "YOUR ACCESS Staff".
- Three competing "do something" surfaces: a blue **Service Mode** button in the top
  bar, a floating **+** button (overlapping table row actions and the Reports "Ask
  Atlas" pill), and page primaries. Up to four blue buttons per screen.

**Hierarchy and noise**
- Every page title appears twice (top bar and page hero), often three times with an
  eyebrow ("CHECKPOINT C · INTERNAL COMMUNICATION / Team Messages / Messages").
- Every workspace opens with a gradient hero card and a row of 4–5 KPI cards, most
  showing `0`, `—` or `Unknown`. On a phone these KPI stacks push the real content
  two screens down (Shifts, Knowledge, Stock count, Brain).
- Engineering language in product UI: "Checkpoint I · System control room",
  "Phase A.1 · Knowledge import engine", "Isolated PR branch", "Production remains
  unchanged", "Daily Briefing returned an invalid response", "Checked Not recorded",
  "Refreshed Not refreshed", "0/0 sources available · 0 fully connected".
- Inventory: every quantity reads "Unknown", row actions are 20 % opacity until
  hovered, the category chip bar wraps to two lines, three rows of filters on Recipes
  (status chips, 12 category chips with "0" counts).
- Type below 11 px in ~550 declarations; uppercase micro labels everywhere; money in
  monospace on Purchasing; Fraunces display used for numbers (Operations `0/9`,
  Knowledge `0/0`).

**Phone**
- The desktop layout compressed: hamburger drawer, three icons plus a blue lightning
  button in a 390 px top bar, tab bars that clip ("Was…"), full-width stacked
  buttons ("Shift handover", "Refresh") above content, KPI cards before content.
- No bottom navigation; the FAB covers list content; no phone-specific counting,
  recipe lookup or chat layout.
- `maximum-scale=1` in the viewport meta blocks pinch zoom (accessibility failure).

**Visual**
- Glass surfaces, radial gradients and blue-tinted shadows on most cards; 18–22 px
  radii; primary blue `#2f80ed` gives 3.9:1 with white text (fails AA for 14 px
  button labels).
- Sign-in logo renders as a broken image.

---

## 2. Principles

1. **One product.** Every page uses the same shell, page header, components and
   tokens. A module never ships its own button, card, tab or colour.
2. **Today first.** Home answers "what needs me now?" in one screen. Everything else
   is one click (desktop) or one tap (phone) away.
3. **Content before chrome.** No hero cards, no KPI rows by default, no eyebrows. A
   number earns a place only when someone acts on it.
4. **Quiet until it matters.** Neutral surfaces; colour means status or the one
   primary action. Blue is used for: the primary button, links, focus, selection and
   the Atlas AI mark. Nothing else.
5. **Phone is a first-class product.** The six jobs people do standing at the bar
   (count, find a product, look up a recipe, check shifts, read messages, ask Atlas)
   are designed for one thumb.
6. **Say what happens.** Plain sentence-case English; buttons are verbs that describe
   the real outcome; errors say what failed, what is safe and what to do.
7. **Truth over decoration.** Never show a guessed number, a control that does
   nothing, or a status that has not been confirmed by the server.

---

## 3. Information architecture

### 3.1 Final navigation (desktop sidebar, top to bottom)

| Group (label) | Destination | Route | Replaces / absorbs |
|---|---|---|---|
| — | **Home** | `#home` | Home; Brain greeting + "closes in" timer; Daily briefing; Operations "Today's priorities"; Service Mode |
| — | **Atlas AI** | `#ai` | Brain "Ask"; search "Ask"; Reports "Ask Atlas about this report"; Brain Decision Memory (as the *Decisions* tab, managers) |
| — | **Messages** | `#messages` | "Messages / Team Messages" |
| Venue | **Operations** | `#operations` | Operations Center (operations.js + checkpoint-A + layout), daily checklists, temperature log, routines |
| Venue | **Inventory** | `#inventory` | Items, Stock count, Item master (becomes item detail), Movements, Waste |
| Venue | **Recipes** | `#recipes` | Recipe library, recipe detail, editor |
| Venue | **Purchasing** | `#purchasing` | Suppliers, Orders, Deliveries, Operations "Suggested purchasing" |
| People | **Shifts** | `#shifts` | Weekly planner, Month, Availability, Time off, Confirmations, Handover |
| People | **Team** | `#team` | Team Profiles |
| People | **Knowledge** | `#knowledge` | Knowledge |
| Business | **Reports** | `#reports` | Reports + Business Intelligence (as *Overview*) + Brain metrics |
| Business | **Marketing** | `#marketing` | Marketing |
| Business | **Data** | `#data` | Import Center, Real VÁ Data (*Import review*), Data review (*Issues*), bulk par editor (*Par levels*) |
| footer | **Settings** | `#settings` | Settings + System (as *System health*, admin) |
| footer | account menu | — | Profile, Preferences, Notification settings, Sign out |

Removed as destinations: *Operations Center* (renamed), *Atlas Brain*, *Business
Intelligence*, *Real VÁ Data*, *Import* (tab), *Item master* (tab), *System*,
*Service Mode*, the floating **+** button.

Rationale:
- **Brain + Business + Daily briefing** described the same day three times. The
  briefing and the day's context move to Home; the decision ledger (recommendations,
  decisions, outcomes) belongs next to the proposals that create it, so it becomes
  *Atlas AI › Decisions*; the business-health figures are reporting, so they become
  *Reports › Overview*.
- **Import + Review** are one job — getting outside data in correctly — so they are one
  manager page, *Data*, which also holds the live-record issue list and bulk pars
  (S88 product-debt §6).
- **Operations** becomes what staff actually do there: today's checklists and logs.
  Readiness and priorities move to Home; suggested purchasing moves to Purchasing.
- **Notifications** are an overlay, not a page (§4.9); preferences live in Settings.
- **Atlas AI** sits second in the sidebar and in the centre of the phone tab bar,
  and is reachable from every search field and every record ("Ask Atlas about…").
- **System** is an administrator's maintenance view, not a daily destination.

### 3.2 Page anatomy (all pages)

```
┌ Page header ─ title (24/32) · one-line subtitle (facts, not marketing)  [secondary] [primary] ┐
├ Tabs (only when the page has peer sub-sections)                                               ┤
├ Toolbar (search · filter chips · view options)                              count · export   ┤
└ Content (table / list / sections)                                                            ┘
```
- No hero cards, eyebrows or KPI rows. Where a page genuinely needs a figure (Reports),
  it is part of the content, not a header decoration.
- At most **one primary button** per page header, sheet or dialog.

### 3.3 Visibility by role

`●` full · `◐` limited (noted) · blank = hidden from navigation, palette and search;
direct links show the permission state (§6.24).

| Destination | admin | manager | bartender | viewer |
|---|---|---|---|---|
| Home | ● | ● | ◐ staff Home (§7.1) | ◐ read-only |
| Atlas AI | ● | ● | ◐ no Decisions tab; approves only staff-level proposals | ◐ answers only, no proposals |
| Messages | ● | ● | ● | ◐ read |
| Operations | ● | ● | ● tick items, log readings | ◐ read |
| Inventory | ● | ● | ◐ no cost/supplier columns, no Add item; can count, scan | ◐ read |
| Recipes | ● | ● | ◐ no costing/margin, no editor | ◐ read |
| Purchasing | ● | ● | | |
| Shifts | ● | ● | ◐ own schedule, availability, time off | ◐ own schedule |
| Team | ● | ● | ◐ directory, own profile | ◐ directory |
| Knowledge | ● | ● | ◐ no Sources/Activity, no editor | ◐ read |
| Reports | ● | ● | | |
| Marketing | ● | ● | | |
| Data | ● | ● | | |
| Settings | ● incl. System health, Security, Team access | ◐ venue sections per permission | ◐ Preferences + Notifications only (via account menu) | ◐ same as bartender |

The sidebar never shows an empty group: bartenders see 9 items (Home, Atlas AI,
Messages · Operations, Inventory, Recipes · Shifts, Team, Knowledge).

### 3.4 Routes and deep links

Hash routes, parsed by `AtlasShell` (`#<view>[/<sub>[/<id>]][?query]`). Every tab,
filter preset and record is linkable; the back button restores the previous route
and scroll position.

| Route | Opens |
|---|---|
| `#home` | Home |
| `#ai` · `#ai/c/<id>` · `#ai/new?context=<type>:<id>` · `#ai/decisions` | Atlas AI, a conversation, a new conversation with page context, Decisions |
| `#messages` · `#messages/<conversationId>` | Messages |
| `#operations` · `#operations/<checklistId>` · `#operations/temperature` · `#operations/schedule` | Today's checklists, a checklist, temperature log, routine schedule (manager) |
| `#inventory` · `#inventory/item/<id>` · `#inventory/counts` · `#inventory/counts/<sessionId>` · `#inventory/movements` · `#inventory/waste` | Items, item detail, counts, a count session, movements, waste |
| `#inventory?filter=below-par` | Items filtered (any filter is a query parameter) |
| `#recipes` · `#recipes/<id>` · `#recipes/<id>/edit` | Library, detail, editor |
| `#purchasing` · `#purchasing/order/<id>` · `#purchasing/deliveries` · `#purchasing/suppliers` · `#purchasing/suppliers/<id>` | Orders, an order, deliveries, suppliers |
| `#shifts` · `#shifts/month` · `#shifts/availability` · `#shifts/time-off` | Shifts |
| `#team` · `#team/<profileId>` | Team |
| `#knowledge` · `#knowledge/<articleId>` · `#knowledge/required` · `#knowledge/training` | Knowledge |
| `#reports` · `#reports/<report>` (`overview`, `stock`, `purchasing`, `recipes`, `waste`, `labour`) | Reports |
| `#marketing` · `#marketing/<tab>` | Marketing |
| `#data` · `#data/issues` · `#data/pars` · `#data/import-review` · `#data/import/<batchId>` | Data |
| `#settings/<section>` (`venue`, `hours`, `team-access`, `notifications`, `rules`, `ai`, `integrations`, `security`, `preferences`, `activity`, `system`) | Settings |
| `#notifications` | Phone only: full-screen notifications |

Legacy aliases (kept one release, then removed): `dashboard→home`,
`suppliers→purchasing/suppliers`, `imports→data`, `sprint3-review→data/import-review`,
`movements→inventory/movements`, `waste→inventory/waste`, `brain→home`,
`business→reports/overview`, `system→settings/system`, `team-profiles→team`,
`reports/stock` unchanged. **`#team` changes meaning** (was Messages, now Team):
E1 must grep push-notification payloads (`service-worker.js`, `supabase/functions/*notif*`,
team-messages deep links) and switch any Messages link to `#messages` in the same PR.
Internal view ids may stay (`team` element for Messages); only routes change.

---
## 4. Shell

### 4.1 Layout per breakpoint

| Width | Navigation | Sidebar | Top bar | Page gutter | Content max width |
|---|---|---|---|---|---|
| ≥1280 (1440, 1280) | Sidebar, expanded | 240 px, can collapse to 64 px rail (per-viewer, `localStorage`) | 56 px | 40 px at ≥1440, 32 px at 1280–1439 | Standard 1200 px; wide (data) pages 1400 px; reading 720 px |
| 1024–1279 (1024) | Rail | 64 px icons with tooltips; toggle opens the full sidebar as an overlay (scrim, Esc closes) | 56 px | 32 px | as above, fluid |
| 768–1023 (768) | Rail | 64 px | 56 px | 24 px | fluid |
| <768 (430, 390) | **Bottom tab bar** + More sheet | none | 52 px + safe area | 16 px | fluid |

- Content area: `max-width: calc(page-max + 2 × gutter); margin-inline: auto`. Wide pages
  (Inventory, Purchasing, Reports, Shifts, Data) use `.page--wide` (1400 px).
- Section rhythm: 40 px between page sections (28 px phone); 12 px from a section
  header to its content; 24 px from page header to tabs/toolbar.
- The page never scrolls horizontally at any width; wide tables scroll inside their
  wrapper.
- Sticky: top bar (all widths), table headers, sheet/dialog footers, phone tab bar,
  phone composer (Atlas AI), phone count footer.

### 4.2 Sidebar (≥768)

Anatomy (reference `#home`):
- Brand row, 56 px (aligns with the top bar): the supplied horizontal Midnight lockup
  (`assets/brand/Atlas_Primary_Horizontal_Midnight.svg`, 32 px high, 121 px wide);
  the mark alone on the rail and the phone top bar (Brand v1.0, 2026-09-24 —
  replaces the 26 px ink "A" square and typed "Atlas"). Venue "VÁ · Reykjavík"
  12/16 secondary below the lockup's clear space. Not a link target except to Home.
- Items: 34 px tall, 10 px inline padding, 8 px radius, 16 px icon (stroke 1.75) + 14 px
  label, 10 px gap. Rest: `--text-2`. Hover: `--bg-muted`. **Active: white surface,
  1 px `--line` ring, 1 px shadow, `--text` 500** — neutral, not blue. The Atlas AI icon
  is the only blue icon in navigation.
- Counts: `atlas-badge` right-aligned: blue for unread Messages, muted for Data issues.
  No count badges for anything else.
- Group labels: 12/16 500 `--text-3`, sentence case, 18 px above, 6 px below. In the
  rail, a group label becomes a 28 px hairline divider.
- Footer (pinned bottom): Settings item, then the account button (28 px avatar, name
  13/500, role 12, chevron) that opens the account menu (§4.10).
- Background `--bg-subtle` with a 1 px right border `--line`; scrolls internally when
  taller than the viewport, footer stays visible.
- Keyboard: the sidebar is a `<nav aria-label="Main">` with links (`<a href="#…">`),
  `aria-current="page"` on the active item. Rail items expose their label via
  `aria-label` and a tooltip on hover/focus (400 ms delay).

### 4.3 Top bar (≥768)

`56 px · white · 1 px bottom hairline --line-subtle · sticky`

```
[⇤ collapse]  [🔍 Search or ask Atlas            ⌘K]              [+]  [🔔•]
```
- Left: collapse toggle (36 px icon button), then the **omni field**: a button styled as
  a field, 360 px (280 px at 768–1023), `--bg-subtle`, 1 px `--line`, 8 px radius,
  placeholder "Search or ask Atlas", `⌘K` (Ctrl K on Windows/Linux) key hint. It opens
  the command palette (§4.7); it is not a text input itself.
- Right: **Quick actions** `+` (opens the palette in *Actions* mode) and
  **Notifications** bell with an unread dot (opens the panel, §4.9).
- The page title is **not** in the desktop top bar; the page header owns it.
- No Service Mode button.

### 4.4 Phone shell (<768)

**Top bar** — 52 px + `env(safe-area-inset-top)`, white, hairline appears only after
the page scrolls (`.is-scrolled`).
```
Inventory                                  [🔍] [🔔•]
```
- Title 17/22 600 left-aligned (this is the page title on phones; the in-page H1 is
  visually hidden but kept for screen readers). Detail screens show a back chevron
  (44 px) before the title.
- Right: Search (opens the palette as a full-screen sheet) and Notifications. Page-
  specific actions go in the page, never in the top bar, except Atlas AI (history,
  new conversation) and detail screens (one overflow `…`).

**Tab bar** — 56 px + safe area, white 97 %, 1 px top border, 5 equal slots, 22 px
icons (stroke 1.6; 2.0 when active), 12/14 500 labels, active colour `--accent`.

| Slot | Destination | Why it is here |
|---|---|---|
| 1 | Home | Starting point, attention list |
| 2 | Inventory | Counting, scanning, "do we have…?" — the most frequent phone job |
| 3 | **Atlas** (Atlas AI) | Ask, photo, voice note, live voice — central slot, same size as others (no floating button) |
| 4 | Recipes | Recipe lookup during service |
| 5 | More | Everything else, with the Messages unread count as a badge |

Why a tab bar and not a drawer: the six phone jobs must be one tap from anywhere and
visible without opening a menu; a drawer hides location and needs two taps. Five slots
is the most that fit 390 px with 12 px labels (78 px each). Messages sits in More
because on the bar's frequency data (counts, product and recipe lookups happen many
times per shift, messages a few times) and because new messages also surface in
Notifications and on Home. If the owner prefers Messages over Recipes, swap slots 4/5
contents only — the pattern does not change (§11).

**More sheet** — bottom sheet (§6.18), 16 px radius top corners:
```
┌───────────────────────────────┐
│  ▬                            │
│  (IE) Imad El Moubarik    ›   │  account → profile, preferences
│  ───────────────────────────  │
│  Messages                 3 › │
│  Operations                 › │
│  Purchasing                 › │
│  Shifts                     › │
│  Team                       › │
│  Knowledge                  › │
│  Reports · Marketing · Data   │  (manager, as rows)
│  ───────────────────────────  │
│  Settings                   › │
│  Sign out                     │
└───────────────────────────────┘
```
Rows 52 px, 20 px icon, grouped like the sidebar. Opening a row closes the sheet.

**Hidden tab bar**: inside Atlas AI conversations, the stock-count flow, full-screen
sheets and the palette (they own the bottom edge). A back chevron or Close is always
visible there.

### 4.5 Page header

- Title `--type-title` (24/32 600, −0.015 em; 22/28 on phones); subtitle `--type-body`
  `--text-2`, one line of facts ("84 active items · counted Tuesday 22 September").
- Actions right-aligned, bottom-aligned with the subtitle; order: secondary(ies) then
  primary. On phones actions sit below the subtitle, full width, max two; a third goes
  into the page's `…` menu.
- Home is the only page with a display greeting (Fraunces).

### 4.6 Universal search and Atlas AI entry

One entry point: **"Search or ask Atlas"** (top bar omni field, phone search icon,
`⌘K`/`Ctrl K`, `/` when focus is not in a field).
- Typing searches records (items, recipes, suppliers, orders, people, articles, pages)
  instantly from local data, then server results; results show type icon, name and one
  fact ("1 of 4 · Back bar").
- The last row is always **Ask Atlas "<query>"** (`⌘↵`). If the query reads as a
  question (ends with `?` or starts with who/what/when/why/how/can/do/does/is/are/should),
  that row moves to the top and is selected by default.
- Every record page offers **Ask Atlas** (ghost button with sparkles icon in the page
  header overflow or detail header) which opens `#ai/new?context=<type>:<id>`, showing
  the context chip in the composer. Atlas never guesses page context.

### 4.7 Command palette (Quick actions)

Reference `#palette`. Built by E1 as `assets/js/atlas-palette.js`, replacing the FAB,
the Service Mode grid and the search dropdown (`atlas-search.js` becomes its search
provider).

- **Open**: `⌘K`/`Ctrl K`, `/`, the omni field, the `+` button (opens scrolled to
  Actions with the input empty), phone search icon. **Close**: Esc, scrim click, phone
  Close button; focus returns to the trigger.
- **Size**: 640 px wide, top at 12 vh, max body height 420 px, 16 px radius,
  `--shadow-modal`, scrim `--overlay`. Phone: full-screen sheet, input at top, keyboard
  open.
- **Input row** 56 px: search icon, 16 px input, context tag (current page, e.g.
  "Inventory") that scopes suggestions; Backspace on an empty input removes the tag.
- **Sections, in order** (each hidden when empty; max 5 rows each, "Show all" row):
  1. *Suggested* (empty query only) — up to 4 actions relevant to the current page and
     time (e.g. Home before opening: "Open opening checklist", "Log temperature";
     Inventory: "Start stock count", "Add item"; a recipe detail: "Ask Atlas about this
     recipe").
  2. *Records* (query) — grouped by type.
  3. *Actions* — canonical actions matching the query, including record-aware ones
     ("Add Campari to an order", "Count Campari", "Record waste for Campari").
  4. *Go to* — destinations and tabs ("Reports › Waste").
  5. *Ask Atlas* — always last (first for questions).
- **Rows** 40 px (48 px on touch), 16 px icon, label 14, optional meta 13 `--text-2`,
  shortcut hint right. Active row `--bg-muted`.
- **Keyboard**: ↑/↓ move (wraps), ↵ run, `⌘↵` ask Atlas with the query, Tab moves
  between sections, Esc closes. ARIA: `role="dialog"` + `combobox` input with
  `aria-controls` listbox, `aria-activedescendant` for the active option.
- **Recent**: with an empty query and no context suggestions, show 5 recent records.
- Role-filtered: actions/destinations the user cannot use never appear.

### 4.8 Canonical actions (`AtlasShell.actions`)

The palette, Home attention rows, page buttons, notification actions and Atlas AI
"Open in …" links all call the same registered actions, so an action has one label,
one icon, one permission check and one implementation.

```js
AtlasShell.actions.register({
  id: 'inventory.count.start', label: 'Start stock count', icon: 'list-checks',
  keywords: ['count', 'stocktake'], roles: ['admin', 'manager', 'bartender'],
  contexts: ['home', 'inventory'],            // where it is suggested
  forRecord: 'inventory_item',                // optional: record-aware variant ("Count Campari")
  run(ctx) { /* opens the flow; returns a promise */ }
});
AtlasShell.actions.run(id, ctx); AtlasShell.actions.list(ctx);
```

Initial registry (owners in brackets):

| id | Label | Roles | Owner |
|---|---|---|---|
| `ai.ask` / `ai.voice` | Ask Atlas / Talk to Atlas | all | E6 |
| `inventory.item.add` | Add item | manager+ | E3 |
| `inventory.count.start` | Start stock count | bartender+ | E3 |
| `inventory.scan` | Scan a product | bartender+ | E3 |
| `inventory.waste.record` | Record waste | manager+ (bartender if the owner enables it, §11) | E3 |
| `purchasing.order.new` | New order | manager+ | E3 |
| `purchasing.delivery.receive` | Receive a delivery | manager+ | E3 |
| `purchasing.supplier.add` | Add supplier | manager+ | E3 |
| `recipes.new` | New recipe | manager+ | E4 |
| `operations.checklist.open` | Open today's checklist | bartender+ | E2 |
| `operations.temperature.log` | Log temperature | bartender+ | E2 |
| `shifts.add` | Add shift | manager+ | E5 |
| `shifts.availability` | Set my availability | bartender+ | E5 |
| `shifts.timeoff.request` | Request time off | bartender+ | E5 |
| `messages.new` | New message | bartender+ | E5 |
| `knowledge.article.new` | New article | manager+ | E5 |
| `team.invite` | Invite someone | admin (manager if permitted) | E5 |
| `data.import` | Import a file | manager+ | E4 |
| `marketing.post.new` | New post draft | manager+ | E4 |
| `settings.hours` | Set opening hours | admin | E2 |

"Log a restock" disappears as a name: receiving is **Receive a delivery** (against an
order, or without one for manager-only ad-hoc restock).

### 4.9 Notifications panel

- Trigger: bell (desktop top bar, phone top bar). Unread dot = any unread item; the
  count is in the panel header, not on the bell.
- Desktop: popover anchored under the bell, 400 × up to 560 px, 12 px radius,
  `--shadow-pop`. Phone: full-screen route `#notifications` with back chevron.
- Header: "Notifications" 15/600, segmented **All · Needs action**, `…` menu (Mark all
  as read, Notification settings → `#settings/notifications`).
- Row (64 px): 32 px type icon tile (same tones as Home attention rows), title 14/500,
  detail 13 `--text-2`, relative time 12 right; unread = 6 px accent dot left of the
  icon; inline action (secondary sm) when there is one canonical action ("Review
  order", "Log reading", "Open"). Clicking the row opens the record and marks read.
- Sources: Home attention rows (`AtlasShell.home` contributions), approvals waiting
  (purchasing, AI proposals), messages mentioning me / direct messages, shift
  published / changed / swap requests, required reading assigned, import finished or
  failed. E1 builds the panel UI and `AtlasShell.notify.contribute(key, fn)`; E2
  wires the feed (`notifications.js` stays the push-permission module).
- Empty: "You're up to date" + "New alerts, approvals and messages appear here."

### 4.10 Account menu

Menu (§6.19) from the sidebar footer (desktop) or More sheet header (phone):
name + email + role pill, then **Your profile** (`#team/<me>`), **Preferences**
(`#settings/preferences`), **Notification settings**, divider, **Keyboard shortcuts**
(desktop), **Sign out**. Sign out confirms only when there are unsaved drafts.

### 4.11 Global feedback

- **Toasts**: bottom centre on desktop (24 px from bottom), above the tab bar on
  phones; max 1 visible, 4 s (8 s with an action), pause on hover/focus; `role=status`.
  Used only for completed actions ("Order created · View"). Never for errors that need
  a decision.
- **Offline**: a 36 px bar under the top bar: "You're offline. Changes can't be saved
  until you reconnect." Write buttons disable with that reason as tooltip.
- **Session expired**: dialog "Your session has ended. Sign in again to continue — your
  unsaved text is kept on this page."
- **Loading the app**: brand mark centred + 2 px accent progress line under the top
  bar; the shell renders immediately with page skeletons, never a blank screen.

### 4.12 Retired shell elements

FAB (`.fab-wrap`, `#fab-menu`, module injections in operations.js L278, brain.js L436,
business.js L529, inventory-scanner.js L690, recipes.js L445), Service Mode
(`#service-mode-btn`, `.service-view`, `body.service-mode` styles), top-bar page title
on desktop, hamburger drawer on phones, `alert()` permission messages in
`setActiveView`, the viewport `maximum-scale=1`.

---

## 5. Visual language and tokens

### 5.1 Character

Light, warm-neutral, precise. White canvas; the sidebar and inset areas are a warm
off-white. Structure comes from typography, spacing and hairlines, not boxes: use a
card only to group a set of rows or a self-contained object (a briefing, an approval,
a form section in a sheet). No glass, no gradients, no blur except the phone tab bar
(97 % white, no blur needed). Radii are small; shadows are almost invisible at rest and
only real on overlays.

### 5.2 Colour tokens (replace values in `atlas-tokens.css`)

| New token | Value | Use | Legacy names mapped to it |
|---|---|---|---|
| `--bg` | `#ffffff` | Content canvas | `--atlas-bg`, `--color-background` |
| `--bg-subtle` | `#f7f7f5` | Sidebar, table header, inset panels, AI list | `--atlas-surface-sunken` |
| `--bg-muted` | `#efefec` | Hover on subtle, active segmented track, skeleton | — |
| `--surface` | `#ffffff` | Cards, sheets, popovers | `--atlas-surface`, `--atlas-surface-solid`, `--color-surface`, `--atlas-sidebar` |
| `--overlay` | `rgba(23,25,30,.32)` | Scrim | — |
| `--text` | `#17191e` | Primary text | `--atlas-text`, `--color-text` |
| `--text-2` | `#5b616b` (5.9:1) | Secondary text, metadata, table headers | `--atlas-muted`, `--color-text-secondary` |
| `--text-3` | `#80858e` | Placeholders, disabled, group labels. Never for body copy | `--atlas-subtle`, `--color-text-tertiary` |
| `--line` | `#e7e7e3` | Card borders, dividers | `--atlas-line`, `--color-border` |
| `--line-strong` | `#d4d4cf` | Inputs, secondary buttons | `--atlas-line-strong` |
| `--line-subtle` | `#f0f0ed` | Row dividers inside cards/tables | — |
| `--accent` | `#1f6fdb` (4.8:1 with white) | Primary button, links, focus, selection, AI mark | `--atlas-accent`, `--color-primary`, `--atlas-action`, `--atlas-home-accent`, `--s38-blue`, `--blue-600`, `--atlas-info` |
| `--accent-hover` | `#195fc0` | Primary hover | `--atlas-accent-strong`, `--blue-700`, `--s38-blue-strong` |
| `--accent-press` | `#154fa2` | Primary pressed | — |
| `--accent-soft` | `#edf3fd` | Selected rows, active chip, info tiles | `--atlas-accent-soft`, `--atlas-info-soft`, `--s38-blue-soft` |
| `--accent-text` | `#1a5ec0` | Link/label text on white or accent-soft | — |
| `--positive` / `--positive-soft` | `#177a52` / `#e9f5ef` | Ready, counted, verified, done | `--atlas-green(-soft)` |
| `--warning` / `--warning-icon` / `--warning-soft` | `#93580a` / `#c07a12` / `#fdf3e2` | Below par, due soon, draft needing attention | `--atlas-warn(-soft)` |
| `--danger` / `--danger-soft` | `#c0362c` / `#fcecea` | Out, failed, overdue, destructive | `--atlas-danger(-soft)` |
| `--neutral-soft` | `#f1f1ee` | Neutral pills, count badges, icon tiles | — |

Rules: status colours always come with a word or icon; tinted backgrounds only on
pills, icon tiles, alerts and selected rows — never on whole cards or page sections;
no blue icon tiles as decoration (the current "blue square with icon" on every card is
removed). Dark mode is out of scope for S88; tokens are named so a dark set can be
added under `:root[data-theme="dark"]` later.

> **2026-09-24 — Brand v1.0 supersedes accent `#1f6fdb` and the warm neutrals.**
> The owner's Atlas Brand Identity Kit v1.0 (`docs/brand/`) is now the source of
> truth. Palette: Midnight `#0B0F14`, Slate `#1F2937`, Mist `#CBD5E1`, Snow
> `#F8FAFC`, Atlas Blue `#3B82F6`. The warm greys above are replaced by the cool
> family: `--text` Midnight `#0b0f14`, `--text-2` `#475569`, `--text-3` `#606c80`
> (AA on every surface), `--bg-subtle` Snow, `--bg-muted` `#f1f5f9`, `--line`
> `#e2e8f0`, `--line-strong` Mist, `--ink` Slate, overlay and shadows from
> Midnight. Atlas Blue `#3B82F6` (`--accent-brand`, `--focus-color`) is the
> brand/interface accent for focus rings, selection and active-nav markers,
> unread dots, icons, badges and charts. Because white text on it is 3.7:1
> (fails AA), text-bearing fills and blue text use the same-hue `--accent`
> `#2563EB` (5.2:1), hover `#1D4ED8`, press `#1E40AF`, soft `#EFF6FF`. Status
> colours retuned for the cool palette: positive `#047857`, warning
> `#b45309`/`#d97706`, danger `#c42020`. Every legacy alias still resolves. The
> table above is kept as the S88 record; current values live in
> `docs/design/Atlas_Design_System.md` §1 and `atlas-tokens.css`. The brand mark
> (§4.2, §7.17) is the supplied kit SVG, never a typed "A" tile or wordmark.

### 5.3 Typography

Families: **IBM Plex Sans** (UI, 400/500/600), **Fraunces** (Home greeting, sign-in
heading, Atlas AI empty-state greeting only — 500, `opsz` 72), **IBM Plex Mono**
(codes, SKUs, times in audit logs only; never money or quantities).

| Role | Token | Size/line | Weight | Tracking | Use |
|---|---|---|---|---|---|
| Display | `--type-display` | 32/38 (28/34 phone) | Fraunces 500 | −0.02 em | Home greeting only |
| Page title | `--type-title` | 24/32 (22/28 phone) | 600 | −0.015 em | One per page |
| Section | `--type-section` | 17/24 | 600 | −0.005 em | Section headers, sheet titles (18) |
| Heading | `--type-heading` | 15/22 | 600 | 0 | Card titles, column titles |
| Body | `--type-body` | 14/20 (15/22 phone) | 400 | 0 | Default text, table cells |
| Body large | `--type-body-lg` | 15/24 | 400 | 0 | Atlas AI answers, briefing, Knowledge articles (16/26 on article pages) |
| Label | `--type-label` | 13/18 | 500 | 0 | Field labels, chips, tabs (14 for tabs and buttons) |
| Meta | `--type-meta` | 13/18 | 400 | 0 | Secondary lines, row details |
| Caption | `--type-caption` | 12/16 | 400/500 | 0 | Table headers, timestamps, help text. **Minimum size.** |
| KPI | `--type-kpi` | 28/32 (22/28 phone) | 500 | −0.02 em | Figures in Reports and Home "at a glance" |
| Numeric | `--type-num` | 14/20 | 500 | 0 | Quantities in rows |

- Numbers: `font-variant-numeric: tabular-nums` in tables, KPIs, times and money.
  Right-align numeric columns. Money: `Intl.NumberFormat('is-IS', {style:'currency',
  currency:'ISK', maximumFractionDigits:0})` rendered "3.900 kr" via one helper
  `AtlasFormat.money()`. Dates: "Thu 24 Sep", "Thursday 24 September"; times 24 h
  "17:00"; relative only under 24 h ("12 min ago").
- No uppercase labels, no letter-spaced eyebrows, nothing under 12 px. Weight 600 only
  for titles/headings/selected emphasis; 500 for labels and row titles; 700+ never.

### 5.4 Spacing

4 px base. Tokens `--s-1 … --s-20` = 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80.
- Inside controls: 8–12 horizontal. Rows: 10–12 vertical. Cards: 16 (rows) / 20 (content
  cards) / 24 (sheets, desktop).
- Form fields: 6 between label and control, 16 between fields, 24 between groups.
- Buttons in a group: 8. Chips: 8.
- Page: header → tabs 16, tabs → toolbar 20, toolbar → content 12, sections 40
  (phone 28), page bottom padding 80 (phone: tab bar + 40).

### 5.5 Radius

`--r-xs 4` (checkbox, kbd, skeleton) · `--r-sm 6` (segmented inner, small tags) ·
`--r-md 8` (buttons, inputs, nav items, record chips) · `--r-lg 12` (cards, tables,
alerts, popovers) · `--r-xl 16` (dialogs, sheets, palette, composer) · `--r-pill`
(pills, chips, avatars, toggles).

### 5.6 Elevation

`--shadow-1` `0 1px 2px rgba(23,25,30,.05)` — secondary buttons, active nav item,
approval card. `--shadow-pop` — menus, popovers, notification panel, toasts, voice
panel. `--shadow-modal` — dialogs, sheets, palette. Cards at rest have **no shadow**,
only a 1 px `--line` border. No coloured shadows.

### 5.7 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-1` | 120 ms | Hover, press, colour changes |
| `--dur-2` | 180 ms | Menus, popovers, toggles, tab underline, row expand |
| `--dur-3` | 240 ms | Sheets, dialogs, palette, page-level transitions |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | Entering |
| `--ease-in-out` | `cubic-bezier(.4,0,.2,1)` | Moving/resizing |

Enter = 4–8 px translate + opacity; exit = opacity only, 70 % of enter duration. No
bounces, no scale above 1.0, no looping animation except spinners/skeletons and the
live-voice waveform. `prefers-reduced-motion` and `html.atlas-reduce-motion`: all
durations 0 except opacity fades ≤120 ms; skeleton shimmer becomes static.

### 5.8 Icons

- Lucide only (the pinned 0.454.0). Sizes: 16 (inline, buttons, rows), 18 (top bar,
  icon buttons in headers), 20 (sheet close, phone top bar), 22 (tab bar). Stroke 1.75
  (1.6 at 22 px, 2.0 for active tab / send arrow). Colour inherits `currentColor`,
  default `--text-2`.
- An icon appears only when it helps recognition: navigation, row type, button that
  is ambiguous without it, status. Remove decorative icons from headings, KPI cards,
  section eyebrows and empty "info" tiles.
- One meaning per icon: `package` inventory item, `martini` recipe, `truck`
  purchasing/supplier/order, `list-checks` checklist/count, `thermometer` temperature,
  `calendar-days` shifts, `users` team, `messages-square` messages, `book-open`
  knowledge, `chart-no-axes-column` reports, `megaphone` marketing, `database` data,
  `settings` settings, `sparkles` Atlas AI (only), `bell` notifications.
- Emoji never appear in UI copy (the FAB's 📦 🍸 🚚 go).

### 5.9 Copy rules

- Sentence case everywhere (titles, buttons, tabs, labels). "Stock count", not "Stock
  Count".
- Buttons are verb + object and describe what actually happens: "Create order",
  "Mark as ordered", "Log reading", "Save changes". Never "Submit", "OK", "Confirm"
  alone. Dialog buttons repeat the verb of the title ("Delete Campari?" → "Delete").
- No engineering terms: checkpoint, sprint, phase, branch, edge function, RPC, payload,
  JSON, agent, tool, token, snapshot, sync, runtime, production, staging, schema.
- Say the fact, then the consequence: "Campari is almost out · Negroni and Boulevardier
  are affected".
- "Not counted" instead of "Unknown"; "—" only inside tables, with the reason in a
  tooltip.
- Errors: what failed + what is safe + what to do. "Shifts couldn't be loaded. Your
  changes are safe. Try again, or check your connection." Never show HTTP codes or raw
  messages; log them to the console with the request id.
- Second person for the user ("your order"), first person for Atlas AI ("I've prepared
  an order").

| Today | Becomes |
|---|---|
| Operations Center / Operations Intelligence | Operations |
| CHECKPOINT C · INTERNAL COMMUNICATION — Team Messages | Messages |
| PHASE A.1 · KNOWLEDGE IMPORT ENGINE — Import Queue | Data › Imports |
| Real VÁ Data · Isolated PR branch · Production remains unchanged | Data › Import review · "Nothing here changes live records until you approve it." |
| Atlas Brain — Good evening, owner. | (removed; Home greets by first name) |
| Daily Briefing unavailable · Daily Briefing returned an invalid response. | "Today's briefing isn't available right now. Everything else on Home is up to date." [Try again] |
| Inventory is ready for review. 10 active items are available… See analysis → | (removed) |
| Items below par: Unknown · 10 items not counted / verified | "Stock hasn't been counted yet" [Start stock count] |
| Quantity: Unknown | Not counted |
| Service Mode | (removed; Home and the tab bar are the service surface) |
| + Add new item / 📦 Log a restock / 🍸 Add new recipe / 🚚 Add supplier | Add item / Receive a delivery / New recipe / Add supplier (palette) |
| Overall status Unknown · Checked Not recorded | "Not checked yet" [Check now] |
| Refreshed Not refreshed · 0/0 sources available · 0 fully connected | "No data sources connected yet" |
| This workspace is limited to managers and administrators. (alert) | Permission state: "Purchasing is for managers" [Go to Home] |
| Your current role can read messages but cannot post. | "You can read messages. Ask a manager if you need to post." |
| Start the conversation in this channel. | "No messages yet. Say hello to the team." |
| Nothing matches these inventory filters. | "No items match 'xyz' in Below par." [Clear filters] |

---
## 6. Components

All live in `assets/css/atlas-components.css` (`@layer atlas.components`) with the
class names below (the reference page uses exactly these). JS helpers live in
`modal.js` (dialog, sheet), `atlas-shell.js` (toast, menu, tooltip) and
`atlas-palette.js`. Touch rule: under `@media (pointer: coarse)` every interactive
control is ≥44 px tall (or has a ≥44 px hit area).

### 6.1 Page header — `.page-head`
`__title` (h1) · `__sub` · `__actions`. Title and subtitle stack with 4 px gap; actions
bottom-aligned. Phone: title hidden visually (top bar shows it), actions full width
below the subtitle. One H1 per page.

### 6.2 Section header — `.atlas-section__head`
Title 17/24 600 (+ optional muted count badge) left; one text link or ghost sm button
right ("View all"). 12 px to content, 40 px above (28 phone). No icons, no eyebrows.

### 6.3 Buttons — `.atlas-btn`
| Variant | Look | When |
|---|---|---|
| `--primary` | `--accent` fill, white 14/500 | The one main action in a header, sheet, dialog or card |
| `--secondary` | white, 1 px `--line-strong`, `--shadow-1` | Other actions |
| `--ghost` | transparent, `--text`; hover `--bg-muted` | Cancel, low-emphasis, toolbar |
| `--danger` | white, `--line-strong` border, `--danger` text | Destructive entry points |
| `--danger-solid` | `--danger` fill | Only the confirm button of a destructive dialog |

Sizes: `--sm` 32 px (13 px text, 10 px padding) for rows, tables, cards; default 36 px
(14 px, 14 px padding); `--lg` 44 px (15 px, 18 px padding) for phone flows and
sign-in. Coarse pointers: default 44, sm 40. Radius 8. Icon 16 px, 8 px gap, leading
icon only (trailing arrow allowed for "Continue"/"Next" and navigation links).
States: hover (above), pressed (`--accent-press` / `--bg-muted`), focus-visible 2 px
accent outline + 2 px offset, disabled 45 % opacity + `not-allowed` + reason in
`title`/help text, loading `.is-loading` + `aria-busy="true"`: label kept for width,
spinner centred, button disabled, label changes are announced by the result toast.
Never more than one primary in view per context; a card inside a page may have its own
primary only if the page header has none (e.g. Home).

### 6.4 Icon button — `.atlas-icon-btn`
36 × 36 (44 touch), 8 px radius, 16–18 px icon, `--text-2` → hover `--bg-muted`/`--text`.
Always `aria-label`; tooltip on hover/focus after 400 ms with the same text. Optional
`.dot` (7 px, `--danger`, 2 px white ring) for unread.

### 6.5 Text input, select, textarea, date/time — `.atlas-input`, `.atlas-select`
36 px (44 touch, 16 px font to stop iOS zoom), 12 px padding, 8 px radius, 1 px
`--line-strong`, white. Hover border `#c2c2bc`; focus border `--accent` + 3 px ring
`rgba(31,111,219,.16)`; invalid border `--danger` + ring + `aria-invalid="true"` +
error line; disabled `--bg-subtle` fill, `--text-3` text; read-only renders as text,
not a disabled input. Select: native `<select>` with the custom chevron (keyboard and
phone pickers stay native). Textarea: min 3 rows, 10 px vertical padding, auto-grow to
10 rows. Affix: `.atlas-affix .suffix` for units ("ml", "kr", "°C"). Date/time: native
`type="date"`/`"time"` with the same anatomy; ranges use two fields with "to"; show
the venue time zone only when it differs from the device. Search: `.atlas-search`
(16 px icon at 11 px, 34 px left padding, `type="search"`, clear button when filled).

### 6.6 Field — `.atlas-field`
Label (13/18 500, above) → control → help (12/16 `--text-2`) → error (12/16 `--danger`
with 14 px `circle-alert`). Error replaces nothing: help stays below. Required fields
are the norm; mark **optional** ones with "(optional)" in the label. Validate on blur
and on submit, never on each keystroke; on submit failure focus the first invalid
field and show a summary only if the error is not next to a visible field.

### 6.7 Forms
- Single column in sheets and phone; two columns (`.atlas-grid-2`) only for short
  related pairs (size + cost, from + to).
- Groups: `.atlas-form-group` with a 15/22 heading; 24 px between groups.
- Footer: **Cancel** (ghost) then **primary** right-aligned; destructive action far
  left in edit forms ("Delete item", danger). Sticky footer in sheets and dialogs.
  Phone: buttons share the width.
- Save state per form: primary shows loading; success closes the sheet and toasts;
  failure keeps the form open with an inline alert at the top of the body.
- Unsaved changes: closing asks "Discard changes?" [Keep editing] [Discard].

### 6.8 Toggle — `.atlas-toggle` (`role="switch"`)
36 × 20 track, 16 px thumb, accent when on. Label left 14/500 + help 12 below, toggle
right (`.atlas-toggle-row`). Server-backed toggles show the new state only after the
server confirms (inline spinner in place of the thumb meanwhile); failure reverts
and shows the error under the label. Unavailable features are text, not disabled
toggles (unchanged rule).

### 6.9 Checkbox and radio — `.atlas-check`, `.atlas-radio`
16 px box (4 px radius) / circle, 1.5 px `#bdbdb7`; checked accent fill with white mark;
indeterminate a white bar. Hit area is the whole label row (≥44 px touch). Native
inputs visually replaced but kept for semantics.

### 6.10 Segmented control — `.atlas-segmented`
For 2–4 mutually exclusive views of the same content (Week/Month, All/Needs action,
units). Track `--bg-muted` 2 px padding, 8 px radius; segment 28 px (36 touch), 13/500,
selected segment white with hairline shadow. `role="group"` + `aria-pressed`, or
`radiogroup` when it is a form value.

### 6.11 Tabs — `.atlas-tabs`
Page-level peers only (Inventory: Items · Counts · Movements · Waste). 40 px tall, 14/500,
24 px gap, `--text-2`; selected `--text` + 2 px ink underline (not blue); count in a
neutral pill. Links with routes (`aria-current="page"`), not JS-only buttons. Overflow
scrolls horizontally with a fade mask on phones; never wraps. Max 6 tabs; more means
the IA is wrong.

### 6.12 Chips — `.atlas-chip`
Filters and quick choices. 30 px (36 touch), pill, 1 px `--line-strong`, 13/500.
Filter chip with a menu shows a chevron; an applied filter is `.is-active`
(`--accent-soft`, `--accent-text`) with an × to clear; "More filters" is dashed.
Toolbar order: search, applied filters, filter menus, "More filters", then right-aligned
result count and view/export. Category lists longer than 6 go into a menu chip, not a
chip row (Inventory's 13 category chips and Recipes' 12 become one "Category" chip).

### 6.13 Status pill and badge — `.atlas-pill`, `.atlas-badge`
Pill: 22 px, 12/16 500, 6 px dot + word, tones positive/warning/danger/info/neutral.
The word is mandatory. Vocabulary (use exactly): Ready, Counted, Verified, Done ·
Below par, Due soon, Draft, Needs review · Out, Almost out, Overdue, Failed ·
Needs approval, Ordered, In progress · Not counted, Not started, Inactive.
Badge: 18 px numeric count; accent for unread, muted for totals.

### 6.14 Card — `.atlas-card`
White, 1 px `--line`, 12 px radius, no shadow. Use for: a list of rows (attention list,
up-next list), a self-contained object (briefing, approval, evidence, recipe tile), a
chart. Do **not** use for page headers, KPI rows, section wrappers or single lines of
text. Cards are never tinted; clickable cards are `<a>`/`<button>` with hover
`--line-strong` border.

### 6.15 List row — `.atlas-row`
Min 60 px (56 compact), 10–12 × 16 px padding, `--line-subtle` divider. Slots: leading
(32 px icon tile / 28–40 px avatar / checkbox), body (title 14/500, meta 13), trailing
(value, pill, secondary sm action, chevron). Whole row is the link when it navigates;
an inline action is a separate button (`stopPropagation`). Phone: trailing action
collapses to a chevron; the action moves to the detail.

### 6.16 Data table — `.atlas-table`
- Wrapper `.atlas-table-wrap` (1 px border, 12 px radius, internal scroll both axes).
- Header 36 px, `--bg-subtle`, 12/16 500 `--text-2`, sticky (`top: 0` of the wrapper
  when the table scrolls internally; top bar height when the page scrolls). Sortable
  columns show the direction chevron on the sorted column only; `aria-sort`.
- Rows 48 px (comfortable) / 40 px (compact, user preference in Settings); cells 12 px
  padding; `--line-subtle` dividers; hover `#fafaf8`; selected `--accent-soft`.
- Primary column: name 14/500 + sub-line 12 `--text-2` (size, location, SKU).
- Numeric columns right-aligned, tabular, unit in the header ("On hand", "Unit cost")
  or as small suffix; quantity may carry a 44 × 4 px par bar.
- Selection: 40 px checkbox column; header checkbox with indeterminate. Selecting shows
  the **bulk bar** above the table (44 px, ink background, white text: "2 selected ·
  actions · Clear"), replacing the toolbar actions — never a floating bar.
- Row actions: one `…` menu (36 px, visible on hover/focus/selected; always visible on
  touch) + the row itself opens the detail. Never red × buttons in rows.
- Empty/filtered: table header stays, body shows the empty state (§6.21).
- Loading: header + 8 skeleton rows at real column widths.
- Footer (outside the wrapper): result count left, data provenance right
  ("Quantities are from the last verified count plus recorded movements.").
- Column priority: each column declares `data-priority="1|2|3"`; ≤1279 hide 3, ≤1023 hide
  2 and 3. Phone (<768): the table is replaced by a **row list** (§6.15 style:
  title + meta line + right-aligned value and pill; 64 px rows, full-bleed dividers)
  with the same sort/filter state; selection via long-press is not used — bulk actions
  are desktop/tablet only.

### 6.17 KPI / stat — `.atlas-stat`
Label 13/500 `--text-2` (optional 16 px icon) · value `--type-kpi` tabular + unit word
14 `--text-2` · one context line 13 · optional link. Laid out in a row divided by
hairlines (Home "at a glance", Reports overview), not as cards. Show "—" plus the
reason when data is missing ("Not counted yet"); never 0 for unknown. Max 4 per row.

### 6.18 Dialog and sheet — `modal.js`
- **Dialog** (confirmations, short forms ≤3 fields): 440 px (560 for forms), centred,
  16 px radius, `--shadow-modal`, 24 px padding, title 17/600, body 14, footer
  right-aligned. Destructive: title is the question ("Delete Campari?"), body says what
  changes and what does not, confirm `--danger-solid` with the verb. Typing the name is
  required only for irreversible deletes of records with history (recipes, items).
- **Side sheet** (create/edit records, details): right edge, 480 px (640 for editors
  like recipes), inset 8 px, 16 px radius, header (title + one-line description +
  close), scrollable body, sticky footer. Reference `#inventory-new`.
- **Bottom sheet** (phone): full width, from bottom, 16 px top radius, grabber 36 × 4,
  height auto up to `100% - 12px`; swipe down or Close dismisses. All phone sheets and
  dialogs use it except destructive confirmations (centred dialog, 100 % − 32 px).
- All: `role="dialog"`, `aria-modal`, labelled by title, focus trap, focus to first
  field (or the title for read-only), Esc closes, focus returns to the trigger,
  background `inert`, body scroll locked, scrim `--overlay`. Enter submits single-line
  forms. Motion `--dur-3` translate 8 px (sheet: 24 px from its edge).

### 6.19 Popover, menu, tooltip
Menu: 8 px padding, 12 px radius, `--shadow-pop`, items 36 px (44 touch), 14 px label,
16 px icon, destructive items last in `--danger` after a divider; keyboard arrows,
Home/End, type-ahead, Esc. Popover: same surface, max 360 px. Tooltip: ink `#1f2229`,
white 12/16, 6 px radius, 400 ms delay, never holds essential information.

### 6.20 Avatar — `.atlas-avatar`
24 / 28 / 40 / 64 px circles; photo or initials (2 letters, 600) on one of four muted
tints chosen by a stable hash of the profile id. Status (on shift) as a 8 px positive
dot bottom-right with a white ring. Always paired with a name nearby or `alt`.

### 6.21 Empty state — `.atlas-empty`
40 px neutral icon tile · heading 15/600 saying what is missing · one line why/what it
is for · one action (secondary, or primary if the page has no other primary). Filter
empty states name the query and offer "Clear filters". Permission and "not set up yet"
states use the same component with the reason and who can change it.

### 6.22 Skeleton — `.atlas-skel`
`--bg-muted` blocks (4 px radius) matching the real layout: page header text lines,
rows at row height, table rows at column widths, cards at their size. Shimmer 1.4 s
(static with reduced motion). Show only after 150 ms; keep the real header/toolbar
rendered. No spinners for page loads; spinners only inside buttons and AI progress.

### 6.23 Inline alert — `.atlas-alert`
12 × 16 padding, 12 px radius, tinted background (warning/danger/info/neutral), 16 px
icon, title 14/500, body 14 `--text-2`, optional action (secondary sm or link) right.
Placement: top of the region it concerns (not page-level for a field error).
Error copy pattern: "**X couldn't be loaded.** Your changes are safe. [Try again]".
Retry buttons back off (existing S87 rules).

### 6.24 Permission and unavailable states
Direct link to a hidden page: page header with the page name + `.atlas-empty` "Purchasing
is for managers" / "Ask an administrator for access." [Go to Home]. Unconfigured
integration: "Not connected yet" + what it needs + who can connect it.

### 6.25 Toast — `.atlas-toast`
Ink `#1f2229`, white 14 px, 12 px radius, 44 px min, positive icon `#7fd1a8`, optional one
action in `#9cc3ff`. See §4.11 for behaviour.

### 6.26 Workflow stepper — `.atlas-steps`
For linear flows of 3–5 steps (Import: Upload · Review · Import; Receiving: Check ·
Confirm). 22 px numbered circles, done = ink with ✓, current = accent ring, 24 px
connectors, labels 13/500. Phone: "Step 2 of 3 · Review" text + 4 px progress line.

### 6.27 File and photo upload — `.atlas-upload`
Dashed 1 px `--line-strong`, 12 px radius, 44 px thumb tile, title + help + "Choose"
secondary sm; drag-over: `--accent-soft` fill + accent dashed border. Phone: "Choose"
opens the native picker offering camera. After selection: thumbnail, name, size,
remove (×), progress bar 2 px; errors inline ("This file is larger than 25 MB").

### 6.28 Atlas AI components (E6; reference `#ai`, `#ai-approval`, `#ai-voice`)

- **Conversation list item** — `.ai-conv`: title 14/500 one line, meta 12 (status
  "Order draft ready for approval" or relative date); selected = white with hairline
  ring. Groups: Pinned, Today, Previous 7 days, Earlier. Row `…` menu: Rename, Pin,
  Archive, Delete.
- **User message** — right-aligned bubble, `--bg-muted`, 16 px radius (4 px bottom-right),
  15/24, max 80 % (88 % phone). Attachments above the bubble as 120 × 84 thumbnails
  (photos) or file chips (PDF/CSV). Voice-note messages show a "Voice note · 0:18"
  chip above the transcript text.
- **Assistant message** — no bubble: 22 px Atlas mark (sparkles in accent-soft tile) +
  "Atlas" 13/500, then the answer 15/24 in the 720 px column. First sentence carries
  the answer in **600**; lists ≤5 items; numbers tabular. Actions under the message:
  Copy, Try again (icon buttons, `--text-3`).
- **Tool progress** — `.steps-line`: one pill-shaped line above the answer.
  While running: spinner + present-tense human step ("Checking stock…", "Reading the
  delivery note…"), updated in place (`aria-live="polite"`), plus two skeleton text
  lines. Done: green check + past-tense summary ("Checked stock, the Negroni recipe
  and Globus prices"), collapsed; expanding lists the steps with durations. Never
  show tool names, JSON, arguments or agent names.
- **Linked records** — `.record-chip`: 28 px, 8 px radius, type icon + name; opens the
  record route. Max 6, then "+3 more".
- **Evidence** — `.evidence` card "How Atlas knows · N sources": rows of *kind* ·
  statement · source. Kinds and colours: **Verified** (positive), **Calculated**
  (accent-text), **Estimate** (text-2), **Interpretation** (text-2, italic), **Missing**
  (warning). Collapsed by default when the answer has ≤2 sources and no Missing;
  expanded when anything is Missing. Source is a link when it has a record route.
- **Approval card** — `.approval`: header (type icon tile, title "Order from Globus",
  one-line summary, pill "Needs approval"), body (a compact line table or a before/after
  diff for changes), note line starting with `info` icon stating exactly what
  approving does and does not do, footer on `--bg-subtle`: expiry text left, **Dismiss**
  (ghost), **Edit** (secondary → opens the canonical editor prefilled), **primary with
  the canonical verb** ("Create order", "Save count for review", "Send message",
  "Save as draft"). States: *Needs approval* → *Working…* (buttons disabled, spinner in
  primary) → *Done* (positive pill "Order created", footer replaced by "View order →")
  / *Failed* (danger alert inside the card with reason and Try again) / *Expired* /
  *Dismissed* (card collapses to one muted line). A bartender sees manager-only proposals
  as "Waiting for a manager" with no primary.
- **Composer** — `.composer`: 16 px radius, 1 px `--line-strong`, soft shadow, max 720 px;
  auto-growing textarea (1–8 lines) 15/24, placeholder "Ask Atlas about stock,
  recipes, shifts…"; bar: `+` (menu: Take photo, Choose photo, Attach file), context
  chip (removable), spacer, **mic** (voice note), **audio-lines** (live voice), **send**
  (32 px accent circle; becomes **stop** square while streaming). Enter sends,
  Shift+Enter newline. Attachments render as chips above the textarea with upload
  progress. Helper under the composer (desktop): "Atlas prepares changes for you to
  approve. It never changes stock, orders or shifts on its own."
- **Voice note** — pressing mic replaces the composer bar with: red recording dot,
  timer, live level bars, Cancel (×) and Stop (✓). Stop → "Transcribing…" → transcript
  fills the textarea for editing; nothing is sent until the user sends.
- **Live voice** — `.voice` dark panel (ink `#1b1e24`, 16 px radius) above/instead of
  the composer: state label with coloured dot (*Connecting* grey, *Listening* green,
  *Thinking* accent pulse, *Speaking* white waveform, *Muted* amber, *Reconnecting*,
  *Ended*), elapsed time, waveform, the live transcript (final words white, interim
  50 %), controls **Mute** and **End** (red). Proposals created by voice appear as
  approval cards in the thread; approving is a tap, never speech. Errors: "Live voice
  disconnected. Your conversation is saved." [Reconnect].
- **Empty conversation** — Fraunces 28 "What can I help with, Imad?" + 4 suggestion
  chips relevant to role and time ("What's low before tonight?", "Who's on tomorrow?",
  "Does this delivery match our order?" (photo), "Count the back bar by voice").

---
## 7. Pages

Format per page: **Job** · **First seen** · **Secondary** · **Removed / combined** ·
layout (desktop, phone) · **Primary action** · **States** · **Copy**. Wireframes are
to scale in spirit, not in characters. "Wide" = `.page--wide` (1400 px).

### 7.1 Home — `#home` (E2)

**Job:** in ten seconds, know whether today is under control and what needs me.
**First seen:** date, greeting, the venue's state in one line; the attention list.
**Secondary:** Atlas briefing; Tonight (staff and times); opening and closing timeline;
at-a-glance Stock · Recipes · Purchasing.
**Removed / combined:** four KPI cards (Inventory items, Items below par "Unknown",
Average margin "—", Team members "—"), the orange "Scheduled today" banner (becomes an
attention row), "Low inventory" and "Recent activity" panels (→ attention rows /
Inventory), Brain hero + countdown (→ context line "Closes in 2 h 20 min" while
open), Brain metrics (→ Reports › Overview), Operations priorities (→ attention rows),
Business insights (→ Reports), `#home-timeline` hard-coded times (→ venue clock).

```
Desktop (1440, standard 1200)
┌──────────────────────────────────────────────────────────────────────────────┐
│ Thursday 24 September                                                          │
│ Good afternoon, Imad                                    [Opening checklist]   │  display 32 Fraunces
│ ● Opens at 17:00 · opening checks in progress   👥 3 on shift   📅 Quiz night · 40 booked │
│                                                                                │
│ Needs attention (4)                                                  View all  │
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │ [■] Campari is almost out                                   [Add to order] │ │
│ │     1 of 4 bottles left · Negroni and Boulevardier are affected            │ │
│ │ [■] Opening checklist is 4 of 9 done                       [Open checklist]│ │
│ │ [■] Globus order is waiting for your approval                [Review order]│ │
│ │ [■] Fridge 2 temperature not logged today                     [Log reading]│ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│ ┌ ✦ Today's briefing ─────────── Updated 16:32 ┐   Tonight               Shifts │
│ │ A busier Thursday than usual: quiz night…    │   (SJ) Sara  opening 16–00:00 │
│ │ Campari and limes are the only stock risks…  │   (GK) Gunnar        18–01:30 │
│ │ ✓ From stock counts, shifts…  Ask a follow-up→│   (EH) Elín  floor   19–01:30 │
│ └──────────────────────────────────────────────┘                               │
│ ─────────────────────────────────────────────── Opening and closing           │
│ Stock          │ Recipes         │ Purchasing      16:00 ● Opening checks      │
│ 6 below par    │ 2 unavailable   │ 1 to approve    17:00 ◉ Doors open           │
│ 2 out · Tue    │ Negroni, Paloma │ Ölgerðin 14:00  00:30 ○ Last orders          │
│ View inventory→│ View recipes →  │ View orders →   01:00 ○ Close + checklist    │
└──────────────────────────────────────────────────────────────────────────────┘
Grid: 7fr / 5fr, 40 px gap; ≤1279 one column (Tonight + timeline after the briefing).

Phone (390)
Home                              🔍 🔔
Thursday 24 September
Good afternoon, Imad            (28 Fraunces)
● Opens at 17:00 · opening checks in progress
👥 3 on shift tonight  📅 Quiz night · 40 booked
Needs attention (4)                View all
┌ [■] Campari is almost out           › ┐
│     1 of 4 left · Negroni affected    │
│ [■] Opening checklist 4 of 9 done   › │
│ …                                      │
└────────────────────────────────────────┘
┌ ✦ Today's briefing ─────────── 16:32 ┐
│ …                                     │
└───────────────────────────────────────┘
Tonight · Opening and closing · Stock / Recipes / Purchasing (rows: label left, value right)
[ Home | Inventory | Atlas | Recipes | More ]
```

- **Context line** (from venue clock, S88 §1): state dot + one phrase: before opening
  "Opens at 17:00 · opening checks in progress", open "Open · closes at 01:00 (in 2 h 20
  min)", after close "Closed · closing checklist done at 01:12", hours not set (admin)
  "Opening hours aren't set" [Set hours]. Then people on shift, then today's event or
  bookings when a source exists. Weather only if an integration provides it; never
  invented.
- **Needs attention** — from `AtlasShell.home.contribute(key, {focusRows})`. Row
  contract: `{id, severity:'danger'|'warning'|'info', icon, title, detail,
  action:{label, actionId|route}, due?, roles}`. Order: danger → warning → info, then
  by due time. Show 5; "View all" opens the Notifications panel filtered to *Needs
  action*. Contributors: Inventory (out/almost out that affect recipes; count overdue),
  Operations (checklists due/overdue, missing temperature readings), Purchasing
  (approvals, deliveries due today, overdue deliveries), Shifts (unfilled shift
  tonight, swap requests), Data (import failed), Knowledge (required reading overdue,
  staff), Atlas AI (proposals waiting). All clear: a single row with positive icon
  "Nothing needs you right now" + "Last checked 16:32".
- **Briefing** — `briefing.today` (Atlas AI §15). 2 short paragraphs max, 15/24,
  sources line, "Ask a follow-up" opens `#ai/new?context=briefing:<date>`. Hidden for
  viewers if the owner decides (§11). Unavailable: one muted line inside the card, no
  error styling.
- **Tonight** — rows from Shifts (avatar, name, role · note, time range right). Empty:
  "No shifts published for tonight" [Open Shifts] (manager).
- **Opening and closing** — venue clock + checklists: done (filled grey), now (accent),
  upcoming (hollow). Tapping a checklist line opens it.
- **At a glance** — three `.atlas-stat`s separated by hairlines; each whole block links
  to the filtered page. Bartender: Stock, Recipes, **My next shift**. Viewer: Stock,
  Recipes.
- **Staff Home (bartender)**: header action "Start stock count" when a count is assigned,
  otherwise none; attention list scoped to their tasks (checklists, temperature, count
  assigned, required reading, shift changes); briefing uses the staff variant (no
  costs); Tonight shows their own shift highlighted.
- **Primary action:** none in the header (Home is for reading); one secondary
  ("Opening checklist" before opening, "Closing checklist" after last orders, "Start
  stock count" when a count is due; otherwise none). Row actions are secondary sm.
- **States:** loading = real header + 4 skeleton rows + skeleton briefing; a contributor
  failing hides its rows and adds one neutral row "Purchasing couldn't be checked.
  [Try again]"; offline banner.

### 7.2 Atlas AI — `#ai` (E6)

**Job:** ask anything about the venue, by text, photo or voice, and act on the answer
safely. **First seen:** the current conversation (or the empty state with suggestions)
and the composer. **Secondary:** conversation list, pinned, search; *Decisions* tab
(managers). **Removed / combined:** Brain Ask card, search "Ask" answers panel,
Reports "Ask Atlas about this report" floating pill (→ header ghost button "Ask Atlas"),
brain.js assistantResponse.

```
Desktop (≥1024): app sidebar | conversation list 272 | thread (reading column 720, centred)
┌──────────────┬───────────────────────┬──────────────────────────────────────────┐
│ sidebar      │ [+ New conversation]🔍│ Negroni tonight and Campari order   📌 … │
│              │ Conversations·Decisions│                                          │
│              │ Pinned                │            [Can we still make Negronis…]  │
│              │  Weekly par review    │ ✦ Atlas                                   │
│              │ Today                 │ (✓ Checked stock, the Negroni recipe… ⌄)  │
│              │ ▸Negroni tonight…     │ **Yes, but only about 30 Negronis.** …    │
│              │  Does this delivery…  │ [Campari] [Negroni] [Globus]              │
│              │ Earlier               │ ┌ How Atlas knows · 4 sources ─────────┐  │
│              │  Quiz night staffing  │ │ Verified   Campari: 1 bottle   Count │  │
│              │                       │ └──────────────────────────────────────┘  │
│              │                       │ ┌ [■] Order from Globus  Needs approval┐  │
│              │                       │ │ Campari 1 L        6     23.400 kr   │  │
│              │                       │ │ ⓘ Approving creates the order in …   │  │
│              │                       │ │ Expires … [Dismiss] [Edit] [Create order]│
│              │                       │ └──────────────────────────────────────┘  │
│              │                       │ ┌ Ask Atlas about stock…               ┐  │
│              │                       │ │ [+] [Negroni ×]          🎤 ≋ (↑)    │  │
│              │                       │ └──────────────────────────────────────┘  │
└──────────────┴───────────────────────┴──────────────────────────────────────────┘
768–1023: list hidden; a "Conversations" icon button in the thread header opens it as a
left sheet.  Phone: see §8.7.
```

- List header segmented **Conversations · Decisions** (Decisions for managers only).
- Thread header: title (auto-generated after the first answer, editable inline),
  Pin, `…` (Rename, Archive, Delete, Copy link).
- Streaming: text streams into the answer; evidence, records and approval cards appear
  when their events arrive (fade in `--dur-2`). Stop generation replaces send.
- Page context: opening from a record adds its chip to the composer; the first answer
  starts "About Campari:" only when context was supplied.
- **Decisions** (`#ai/decisions`, from Brain Decision Memory, brain-phase3.js /
  brain-checkpoint-k.js): a table-like list of recommendations and proposals —
  columns: Recommendation (title + evidence summary), Source (Atlas AI / rule), Status
  (Proposed, Approved, Dismissed, Expired, Done — pills), Decided by, When, Outcome
  ("Delivered Friday", "Stock recovered"). Filters: status, area (Stock, Purchasing,
  Shifts, Recipes), period. Row opens a side sheet: what was recommended, evidence,
  decision + note, outcome, link to the conversation. Empty: "No decisions recorded yet.
  When you approve or dismiss something Atlas suggests, it appears here with what
  happened next."
- **Primary action:** send (composer). Header: none. List: "New conversation"
  (secondary; `⌘⇧O`).
- **States:** not configured (owner has not enabled Atlas AI): empty state "Atlas AI
  isn't switched on yet" + (admin) "Set it up in Settings › Atlas AI"; record search
  still works in the palette. Answer failed: inline alert in the message "Atlas couldn't
  finish this answer. Nothing was changed." [Try again]. Offline: composer disabled with
  reason.
- **Copy:** never "agent", "tool", "function", "run", "model". Progress steps are human
  ("Checking the Globus price list…").

### 7.3 Messages — `#messages` (E5)

**Job:** read and post team updates and handovers. **First seen:** channel list and the
selected channel's latest messages with the composer. **Secondary:** pinned, search,
unread. **Removed:** "CHECKPOINT C" eyebrow, hero, "0 active staff" pill, Refresh
button (auto-refresh + pull to refresh on phone), dark legal footer bar (→ one caption
under the composer for staff: "Messages are visible to everyone in this channel.").

```
Desktop: page--full-height, no page header text beyond title in list column
┌ Messages ─────────── [✎] ┬ # Service                     👥 8  🔍  …           ┐
│ 🔍 Search                │ ─────────── Today ───────────                        │
│ Channels                 │ (SJ) Sara  15:10                                     │
│ # Service            3   │   Keg of Einstök changed, spare in walk-in.           │
│ # Handover               │ (IE) Imad  15:40                                     │
│ # Managers               │   Thanks — Globus order is in.                        │
│ Direct                   │                                                       │
│ (GK) Gunnar              │ ┌ Message #Service                     [📎] (↑) ┐   │
└──────────────────────────┴───────────────────────────────────────────────────────┘
List 280 px (`--bg-subtle`), thread fluid with messages max 720 px.
```
- Message: avatar 28, name 13/600, time 12, text 15/22, attachments/photos 240 px max,
  linked records as record chips (knowledge articles via `AtlasShell.links`). Grouping:
  same author within 5 min collapses avatar/name. Day dividers. Unread divider
  "New" in accent. `role="log"`, `aria-live="polite"` for new messages.
- Handover: channel "Handover" with a template button "Write handover" (sheet: What
  happened, Stock issues, For the next shift) — replaces the Shifts "Shift handover"
  button (Shifts links here).
- Phone: channel list screen → channel screen (back chevron, title "# Service",
  composer sticky above the keyboard, tab bar hidden in channel).
- **Primary:** send. **Empty:** "No messages yet. Say hello to the team." **Viewer:**
  composer replaced by "You can read messages. Ask a manager if you need to post."
  **Error:** alert at top of the thread; unsent messages keep a "Not sent · Retry" line.

### 7.4 Operations — `#operations` (E2)

**Job:** get today's checklists and logs done, with who/when evidence.
**First seen:** today's checklists (Opening, Closing, scheduled routines such as
Temperature and Cleaning) with progress. **Secondary:** temperature history, routine
schedule (manager). **Removed / combined:** "Operations Intelligence" hero and 66 %
readiness (→ Home), 4 summary cards, "Today's priorities" (→ Home attention),
"Suggested purchasing" (→ Purchasing), the device-local checklist (→ server
checklists, S88 §3), the hidden checkpoint-A hero/summary, clone-and-delegate modals,
Tripadvisor/marketing boundary panel (→ Settings › Integrations).

Tabs: **Today** · **Temperature** · **Schedule** (manager).
```
Desktop (standard)
Operations                                                   [Log temperature]
Thursday 24 September · 2 of 4 checklists done
Today · Temperature · Schedule
──────────────────────────────────────────────────────────────────────────
Opening checklist        4 of 9 · due 17:00         ▓▓▓▓░░░░░   [Continue]
Temperature log          1 of 3 fridges · due 17:00 ▓▓▓░░░░░░   [Log reading]
Closing checklist        Starts 00:30               Not started
Weekly: Clean ice machine  Due today                Not started  [Open]
──────────────────────────────────────────────────────────────────────────
Checklist detail (#operations/<id>) — reading column 720:
Opening checklist                          4 of 9 done · Sara, Gunnar
[✓] Confirm POS, cash float and card terminals     Sara · 16:05
[✓] Ice wells filled                                Sara · 16:12
[ ] Garnish prep  (Note)                            
…                                                    [Complete checklist]
```
- Each checklist is a row (not a card): name 15/500, schedule/due meta, progress bar
  120 px, status pill, one action. Detail lists items as 52 px check rows (whole row
  toggles; shows who/when after ticking; "Add note" per item); completing asks nothing
  unless items are unchecked ("3 items aren't ticked. Complete anyway?").
- Temperature tab: table of points (Fridge 1/2, Walk-in, Freezer) × today's readings,
  target range, last reading, status pill ("In range", "Out of range", "Not logged");
  history chart per point (14 days) with range band. Log reading = dialog: point
  (segmented), value (°C, numeric keypad), note; out-of-range shows warning and asks for
  an action taken.
- Schedule tab (manager): routine templates with frequency, due time, assigned role;
  edit in side sheet.
- **Primary:** "Log temperature" if a reading is due, else none (row actions do the
  work). **Empty:** "No checklists today" + (manager) "Set up routines in Schedule".
  **Error:** "Checklists couldn't be loaded. Anything you ticked is saved." [Try again].
- Phone: rows full width; checklist detail is the phone flow §8 (big rows, sticky
  "Complete checklist").

### 7.5 Inventory — `#inventory` (E3)

**Job:** know what we have, find a product, fix an item, start a count.
**First seen:** the items table (wide), filtered to what matters when arriving from
Home. **Secondary:** Counts, Movements, Waste tabs; item detail. **Removed /
combined:** "Inventory is ready for review" banner, "Scan" + "Add item" duplicated with
FAB, 13 category chips (→ Category menu chip), "Item master" tab (→ item detail; draft
completeness → Data › Issues), "Import" tab (→ Data), red × delete in rows (→ `…` menu,
with dependency check, S88 §4), per-row pencil.

Tabs: **Items** · **Counts** · **Movements** · **Waste** (managers; bartender sees Items
and Counts; Waste if enabled).
```
Desktop (wide) — reference #inventory
Inventory                                            [Count stock] [+ Add item]
84 active items · counted Tuesday 22 September
Items  Counts  Movements  Waste
[🔍 Search items, suppliers or codes] (Below par ×) (Category ⌄) (Supplier ⌄) (⋯ More filters)   6 of 84  ⤓
┌ ☐ Item ⌄              Category   Supplier   On hand      Par  Status       Unit cost  Counted  … ┐
│ ☑ Campari             Aperitif   Globus        1 ▬──      4   ● Almost out  3.900 kr  Tue      … │
│   1 L bottle · Back bar                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
Showing 6 below-par items            Quantities are from the last verified count plus recorded movements.
```
- Columns (priority): Item (1), On hand (1), Status (1), Par (2), Supplier (2, manager),
  Unit cost (2, manager), Category (3), Counted (3). Default sort: status severity then
  name. "More filters": Location, Status, Active/Inactive (S88 §4), Needs review.
- Status vocabulary: Out, Almost out (≤25 % of par), Below par, OK (no pill; shown as
  nothing), Not counted (neutral pill; replaces "Unknown").
- Row click → **item detail** (`#inventory/item/<id>`), a side sheet 640 px (phone:
  full screen): header name + pill + `…` (Edit, Deactivate, Ask Atlas); facts grid (On
  hand, Par, Location, Supplier, Unit cost, Pack); "Used in" recipes (record chips);
  recent movements (last 10); counts history mini-chart; "Edit details" opens the
  edit sheet (the former Item master fields: names, category, packaging, barcodes,
  pars, supplier codes, with draft/publish only where the Item Master workflow requires
  it — label "Changes are reviewed before they apply" in that case).
- **Counts tab** — list of count sessions (table: Count, Area, Status pill Draft /
  Submitted / Verified, Counted by, Items, Variance, Date) + "Start stock count"
  primary in the tab toolbar. Session detail: items with expected vs counted vs variance,
  manager actions **Verify count** (primary) / "Send back". Removes the Checkpoint L1
  hero, 4+4 KPI cards and the "private until verified" banner (→ one caption line under
  the tab: "Counts update stock only after a manager verifies them.").
- **Movements** — table (Date, Item, Type pill, Change ±, By, Note), filters type/item/
  period. **Waste** — "Record waste" primary (dialog: item, quantity, reason select,
  note) + table.
- **Primary:** Add item (manager). Staff: "Count stock" becomes the primary.
- **States:** never counted: table shows items with "Not counted" pills and an info
  alert above the table "Stock hasn't been counted yet. Quantities appear after the
  first verified count." [Start stock count]. Empty catalogue: "No items yet" [Add item]
  [Import a file]. Filter empty per §6.21. Error: alert above table, keep last loaded
  rows with a "Showing data from 16:02" caption.
- Phone: see §8.1–8.2 (list rows, sticky search, Count as primary).

### 7.6 Stock count — `#inventory/counts/<sessionId>` (E3)
Phone-first flow, specified in §8.1. Desktop: same flow in a centred 560 px column
(reference `#count` at 1440) plus a toggle **One by one · List** — List is a dense
table with inline numeric inputs (Tab/Enter moves down) for managers counting at a
desk.

### 7.7 Recipes — `#recipes` (E4)

**Job:** look up how to make a drink (staff); keep specs, costs and availability right
(managers). **First seen:** search + the recipe grid/list with availability.
**Secondary:** category filter, availability filter, recipe detail, editor.
**Removed / combined:** "RECIPES / Recipe Library" eyebrow+hero, 4 KPI cards, "Atlas
intelligence" banner (→ availability pills + Home attention), 12 category chips with
zero counts (→ category menu chip and only non-empty categories), status chip row
(→ segmented All · Available · Unavailable · Drafts), duplicate "+" button next to
search, placeholder radial-gradient images.

```
Desktop (standard)
Recipes                                                          [+ New recipe]
38 recipes · 2 unavailable tonight
[🔍 Search recipes or ingredients]  (All|Available|Unavailable|Drafts)  (Category ⌄)   Grid ▦ List ☰
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐     4 columns ≥1280, 3 ≥1024, 2 ≥768
│  photo 4:3 │ │  photo     │ │ (no photo: │ │            │     no photo → neutral tile with
│            │ │            │ │  glass     │ │            │     glassware icon on --bg-subtle
│ Negroni    │ │ Aperol Spr.│ │  icon)     │ │            │
│ Classic · Rocks          ● Unavailable   │
│ Campari runs out         │
└────────────┘
```
- Tile: 4:3 image (12 px radius top), name 15/600, "Category · Glass" 13, availability
  pill (Available / Low · n left / Unavailable / Draft) + limiting ingredient line when
  not available. Manager list view adds Cost, Price, Margin columns (right-aligned).
- **Recipe detail** (`#recipes/<id>`, side sheet 640 / phone full screen): photo, name,
  pill, **Build** (ingredients with quantities and units, 15/24, each linking to the item
  with its stock status), **Method** (numbered steps), Glass, Garnish, Ice; manager
  section "Cost and price" (cost, price, margin %, per-ingredient cost); "Ask Atlas"
  and "Edit" (manager) in the header.
- **Editor** (`#recipes/<id>/edit`, side sheet 640 / phone full screen): groups
  Details · Ingredients (item picker with search, quantity + unit, reorder) · Method ·
  Service (glass, garnish, ice, menu toggle) · Price; sticky Save / Cancel; delete in
  `…` with type-to-confirm.
- **Primary:** New recipe (manager). **Empty:** "No recipes yet" [New recipe]. **Staff:**
  no cost/margin anywhere. **Error:** alert above grid.

### 7.8 Purchasing — `#purchasing` (E3)

**Job:** keep the bar stocked: decide what to order, approve, send, receive.
**First seen:** Orders — *Suggested order* summary (if any) then open orders.
**Secondary:** Deliveries, Suppliers. **Removed / combined:** supplier summary banner
"See analysis →", monospace money, "Spent this month 0 ISK" columns for suppliers with
no data, restock logging via FAB (→ Receive a delivery).

Tabs: **Orders** · **Deliveries** · **Suppliers**.
```
Desktop (wide)
Purchasing                                                         [+ New order]
2 open orders · 1 waiting for approval
Orders  Deliveries  Suppliers
┌ Suggested order ─────────────────────────────────────────────────────────────┐
│ 9 items are below par across 3 suppliers.   Globus 6 · Ölgerðin 2 · Mata 1  │
│                                                   [Review suggestions]      │
└──────────────────────────────────────────────────────────────────────────────┘
(Status ⌄) (Supplier ⌄)
┌ Order        Supplier   Status            Lines  Total       Delivery      … ┐
│ PO-0142      Globus     ● Needs approval    6    58.200 kr   Fri 25 Sep      │
│ PO-0141      Ölgerðin   ● Ordered           4    21.500 kr   Today 14:00     │
└──────────────────────────────────────────────────────────────────────────────┘
```
- Order detail (`#purchasing/order/<id>`, side sheet 640): header (supplier, status pill,
  `…`), stepper-like status line (Draft → Needs approval → Approved → Ordered → Partly
  received → Received; S88 §5), lines table (item, qty, unit cost, total; editable in
  Draft), expected delivery date, notes, activity (who/when). Footer primary follows the
  status: "Submit for approval" / "Approve" (manager) / "Mark as ordered" (with helper
  "Atlas doesn't send orders to suppliers. Send it as you usually do, then mark it as
  ordered.") / "Receive delivery".
- Receiving (`purchasing.delivery.receive`): full-screen sheet on phone, 640 sheet on
  desktop: each line with ordered qty and a counted-in stepper (defaults to ordered),
  "Short" / "Damaged" quick reasons, photo of delivery note (optional, and "Check with
  Atlas" opens AI with the photo + PO context), confirm "Receive 5 of 6 lines" →
  partial receiving per S88.
- Suggested order review: sheet grouped by supplier, each line with on hand / par /
  suggested qty (editable), "Create 3 orders" primary.
- Suppliers: table (Supplier, Contact, Items, Open orders, Last delivery, Spend 30 days
  — shown only when costed data exists, else "—" with tooltip); detail sheet with
  contact, ordering notes, items, orders.
- **Primary:** New order. **Empty:** Orders "No orders yet. Orders you create or approve
  appear here with their delivery status." [New order]. **Error:** as §6.23.

### 7.9 Shifts — `#shifts` (E5)

**Job:** managers plan and publish the week; staff see their shifts, set availability,
request time off, confirm. **First seen:** the week grid (manager) / "My shifts" list
(staff). **Secondary:** Month, Availability, Time off, Confirmations, Activity.
**Removed / combined:** "PEOPLE OPERATIONS" eyebrow + hero, 4 KPI cards (Planned
shifts, Planned hours, People scheduled, Responses → one summary line in the header
subtitle), "Shift handover" button (→ Messages › Handover), Refresh button,
shifts-month-tab-bridge (one tab bar), the amber "team sees only the latest published
revision" banner (→ caption next to the Publish button).

Header: title, subtitle "21–27 September · 14 shifts · 212 h · 2 awaiting
confirmation", actions: week navigator (‹ Today ›) + segmented **Week · Month** +
primary **Publish week** (manager; disabled with "No changes to publish" when clean;
shows "3 changes not published" caption otherwise).
Tabs (below header): **Schedule** · **Availability** · **Time off** · **Confirmations**
(manager) · **Activity** (manager).
```
Desktop (wide) week grid
         Mon 21   Tue 22   Wed 23   Thu 24•  Fri 25   Sat 26   Sun 27
Sara     16–00    —        16–00    16–00    18–02    18–02    off
Gunnar   —        18–01    18–01    18–01:30 …
Open     +        +        +        +
Row per person (avatar + name + weekly hours), column per day; shift chip = time 13/500
+ role colour stripe (neutral; role as text, not colour-only); unpublished changes have
a dashed border; conflicts (availability/time off) show a warning icon with tooltip.
Click empty cell → add shift popover; click shift → edit popover; drag to move (desktop).
```
- Month: calendar grid, each day lists coverage count and gaps; click day → day sheet.
- Staff view (bartender): "My shifts" list grouped by week (date, time, role, status pill
  Confirmed / Needs confirmation with "Confirm" button), then "Whole team this week"
  read-only grid (week) toggle.
- Phone: see §8.4.
- **Empty:** "No shifts this week" + [Copy last week] [Add shift]. **Error:** alert, grid
  keeps last data.

### 7.10 Team — `#team` (E5)

**Job:** find a colleague, see roles/contact, manage access and training (manager).
**First seen:** directory list. **Removed / combined:** "CHECKPOINT E" eyebrow, hero, 4 KPI
cards, dark policy footer, separate "Messages" and "Refresh" buttons.
```
Team                                                   [Invite someone] (admin)
12 people · 2 with training due
[🔍 Search people]  (Active|All|Inactive)  (Role ⌄)  (Training due)  (Contact missing)
Table: Person (avatar + name + email) · Role pill-neutral · On shift (today time) ·
Training (n of m, pill when due) · Emergency contact (✓ / "Missing") · …
Profile (#team/<id>, side sheet 480): photo, name, role, contact (tap to call/email),
emergency contact (manager, masked until "Show"), shifts this week, training progress,
required reading, Access (admin: role select, deactivate).
```
Staff: directory without emergency contacts; own profile editable (photo, phone,
emergency contact). Phone: list rows (avatar 40, name, role · today's shift), detail
full screen. Empty: "No team members yet" [Invite someone].

### 7.11 Knowledge — `#knowledge` (E5)

**Job:** find the right procedure fast; complete required reading and training.
**First seen:** search + categories + recent/most used articles; required reading
due (staff). **Removed / combined:** hero, 4 KPI cards, 5 full-width tab buttons,
"All categories" dropdown card.
Tabs: **Library** · **Required reading** (count) · **Training** · **Sources** (manager) ·
**Activity** (manager).
```
Knowledge                                                   [+ New article] (manager)
46 articles · 2 required for you
[🔍 Search procedures, recipes, policies]
Categories (left rail 220 on desktop; chips menu on phone)   Articles list:
  Service (12)                                              Closing the bar    Updated 2 d · 4 min read
  Opening & closing (8)                                     Handling a complaint …
  Health & safety (6) …
Article (#knowledge/<id>): reading column 720, title 28/34 600, meta (category, updated,
owner, "Required · due Fri"), body 16/26, headings 20/28, checklists render as check
rows, images full column width; footer "Mark as read" (primary when required) +
"Ask Atlas about this" + "Was this helpful?". Manager: Edit (full-screen editor),
version history in `…`.
```
Empty: "No articles yet" [New article] / staff "Nothing here yet. Your manager will add
procedures and training." Search no results: "No articles match 'x'." [Ask Atlas].

### 7.12 Reports — `#reports` (E4)

**Job:** understand how the business is doing and export evidence. **First seen:**
Overview for the selected period. **Secondary:** Stock, Purchasing, Recipes, Waste,
Labour reports; exports. **Removed / combined:** hero, "Refreshed Not refreshed" box,
floating "Ask Atlas about this report", Business Intelligence page (→ Overview:
inventory value, purchasing spend, suggested order exposure, recipe margin, cost per
serve, data completeness), Brain metrics (service readiness, risk → Overview "Service
readiness this period" when real data exists).
```
Reports                                   (Last 30 days ⌄) (vs previous period ⌄) [Export ⌄]
Updated 16:32 · 3 of 5 data sources connected
Overview  Stock  Purchasing  Recipes  Waste  Labour
Row of 4 stats (hairline-separated): Inventory value · Purchasing spend · Waste · Recipe margin
  each with delta vs comparison (▲ 4 % in --text-2; colour only when meaningfully bad/good,
  always with sign and word)
Section "Needs attention" (rows, from evidence-backed queue)
Section charts: one per card, title + one-sentence takeaway above the chart
("Spend is up 12 %, mostly Globus.") — dataviz tokens, no donut rings for a single %.
Section "Data completeness": rows with what's missing and a link to fix (Data › Issues).
```
- Each report tab = filters toolbar + 1–3 charts + the detail table (sortable, export).
- "Ask Atlas" ghost button in the header opens AI with `context=report:<tab>:<period>`.
- **Empty/unavailable:** per chart "Not enough data yet — needs 2 weeks of counted stock"
  instead of zeros. **Error:** alert per section. Manager+ only.

### 7.13 Marketing — `#marketing` (E4)

**Job:** plan posts and campaigns, get approvals, see what is scheduled.
**First seen:** Overview: "Coming up" (next 14 days list) and "Waiting for approval".
**Removed:** eyebrow, "Planning mode" banner (→ caption "Publishing is manual until a
social account is connected." under the header), 5 KPI cards, "Marketing chat" button
(→ Ask Atlas ghost button).
Tabs: **Overview** · **Calendar** · **Posts** (was Content) · **Campaigns** ·
**History**. Connections → Settings › Integrations (link from the caption).
Header primary: **New post draft**. Post editor: side sheet 640 with channel chips,
text, media upload, schedule date/time, preview (phone-width card), footer "Save draft" /
"Submit for approval" / manager "Approve". Empty: "Nothing planned yet" [New post draft].

### 7.14 Data — `#data` (E4)

**Job:** bring outside data in correctly and keep live records clean. Manager+.
**First seen:** Imports list with any file needing attention on top.
Tabs: **Imports** · **Issues** (count) · **Par levels** · **Import review** (count).
**Removed / combined:** "Phase A.1" eyebrow + hero, 5 KPI cards, the 6-step "Phase A
pipeline" card (→ stepper inside an import), Real VÁ Data page and its "Isolated PR
branch / Production remains unchanged" panel, 16 category chips.
```
Data                                                           [Import a file]
1 import needs attention · 12 record issues
Imports  Issues 12  Par levels  Import review 3
Imports table: File · Contains (Inventory and stock counts…) · Status (Uploaded,
Reading, Needs review, Imported, Failed) · Records · Uploaded by · When · …
Import detail (#data/import/<id>): stepper Upload · Review · Import, then the matched
rows table with Match / New / Skip per row, "Import 42 records" primary; failed: what
went wrong in plain words + "Try again" / "Upload a corrected file".
Issues (S88 §6): issue chips with counts (Missing par · No supplier · No cost · Recipe
without price · Needs review…), table of affected records with a "Fix" row action that
opens the canonical editor; count refreshes after save.
Par levels: bulk editor table (Item, Location, On hand, Current par, Suggested par +
evidence tooltip, New par input), filters by category/supplier, "Save 18 changes"
sticky footer bar; nothing saves until pressed.
Import review: the staged records from imports (was Real VÁ Data): type filter menu
(Inventory, Recipes, Menus, Suppliers, Invoices…), status, table + detail sheet with
Approve / Hold; caption "Nothing here changes live records until you approve it."
```
Upload: dialog with file drop (§6.27) + "What does this file contain?" select.

### 7.15 Settings — `#settings/<section>` (E2)

**Job:** configure the venue, access, notifications and personal preferences.
**Removed / combined:** hero with "YOUR ACCESS" card and Refresh, 10-tab wrapping tab bar,
"Overview" KPI cards (configuration areas, profiles…), duplicate "Where to find each
setting" card grid. System workspace → **System health** section (admin).
```
Desktop: section nav (left, 220 px, list of links) + content column 720
Settings
┌ Venue            ┐  Venue & hours
│ Opening hours    │  ─────────────────────────────────────────────
│ Team access      │  Venue name        [VÁ Bar                ]
│ Notifications    │  Legal name        [VÁ ehf.               ]
│ Operational rules│  Time zone         Atlantic/Reykjavik (fixed)
│ Atlas AI         │  Opening hours     Mon  [17:00]–[01:00]  [Closed ◯]
│ Integrations     │                    …7 rows, "Copy Monday to all"
│ Security (admin) │                                    [Cancel] [Save changes]
│ System health    │
│ ── Personal ──   │
│ Preferences      │
│ Activity         │
└──────────────────┘
```
- Every section is a form with its own Save (S87 per-form save state), sticky save bar
  appears only when the form is dirty ("Unsaved changes · [Discard] [Save changes]").
- Sections: *Venue* (name, legal, currency fixed ISK, language); *Opening hours* (7-day
  editor + exceptions/holidays — venue clock S88 §1); *Team access* (roles table,
  invitations, deactivate); *Notifications* (per-device push switch with real status
  from notifications.js: On / Off / Blocked in browser + how to unblock; which alerts
  go to which role); *Operational rules* (inventory thresholds, temperature ranges and
  reminders, cleaning, breaks); *Atlas AI* (on/off, reply length, speak answers,
  evidence mode, purchase learning — was "Marketing & Brain"; brand voice moves to
  Marketing › settings `…`); *Integrations* (S88 §7 cards: status pill Not connected /
  Connected / Needs attention / Waiting for platform review, Connect/Disconnect,
  what it needs); *Security* (sessions, sign-in methods, audit); *System health* (admin:
  services list with status pills, incidents, data sources, environments, jobs, audit
  & recovery as sub-tabs — the former System workspace, "Checkpoint I" copy removed,
  "Unknown" → "Not checked yet" [Check now]); *Preferences* (theme — light only for
  now, table density, start page, reduce motion, language); *Activity* (settings change
  log).
- Staff see only Preferences and Notifications (reached from the account menu); the
  section nav is hidden when only those exist.
- Phone: section list screen → section screen (back chevron); save bar sticky bottom.

### 7.16 Notifications — panel (E1 UI, E2 feed)
Specified in §4.9. Settings › Notifications holds preferences.

### 7.17 Sign in, invitation, recovery (E1)
`index.html` login screen, `invitation.html`, `recovery.html` share one layout:
```
White page (no gradient). Centred column 360 px, top third of viewport.
[stacked lockup]               Atlas_Primary_Stacked_Midnight.svg, 112 px wide, centred (Brand v1.0)
Welcome back                   Fraunces 28/34
Sign in to VÁ.                 body --text-2
Email      [                 ]
Password   [               👁]  show/hide toggle
[        Sign in        ]      lg primary, full width
Forgot your password?           link, centred
Footer caption: "VÁ · Reykjavík"  (--text-3, bottom 24 px)
```
- Invitation: "Set up your Atlas login" + name/email shown read-only, New password with
  live rules (≥10 characters) + Confirm, primary "Create login"; states: checking
  (skeleton), invalid/expired ("This invitation has expired. Ask your manager for a new
  one."), already used (link to sign in).
- Recovery: "Reset your password" → email → "Check your email" confirmation screen
  (never reveals whether an account exists) → set new password screen.
- Errors inline under the form ("Email or password is incorrect."), primary loading
  state, `autocomplete` attributes, no `maximum-scale`. Fix the broken logo (use the
  brand mark, not the PNG).

### 7.18 Modals and sheets inventory (owners)

| Today | Becomes | Owner |
|---|---|---|
| Item modal (`.item-modal`) | Add/Edit item side sheet (reference `#inventory-new`) | E3 |
| Restock modal | Receive a delivery sheet | E3 |
| Supplier modal | Add/Edit supplier side sheet | E3 |
| Recipe editor (`atlas-modal-panel`) | Recipe editor sheet 640 | E4 |
| Checkpoint-A temperature/range/schedule/settings modals | Log reading dialog; routine editor sheet | E2 |
| Operations context modal (clones) | Checklist detail route | E2 |
| Knowledge editor/source modals | Full-screen article editor; source sheet | E5 |
| Shift editor popovers | Shift popover (desktop) / bottom sheet (phone) | E5 |
| Team profile photo gallery | Photo picker inside profile sheet | E5 |
| Scanner overlay | Full-screen scanner (camera, torch, manual entry) | E3 |
| `alert()` / `confirm()` / `prompt()` calls | `AtlasModal.confirm/prompt` dialogs | each owner |

### 7.19 More, palette, notifications on phone
Specified in §4.4, §4.7, §4.9.

---
## 8. Phone-first flows

Common rules: one-thumb reach (primary actions in the bottom 30 % of the screen),
44 px minimum targets, 16 px gutters, sticky primary at the bottom inside flows,
numeric keypad (`inputmode="decimal"`) for quantities, no hover-only affordances,
haptic-feeling feedback via instant state change (no delays), everything works
offline-read (last data with its time) and says clearly when a write needs a
connection.

### 8.1 Stock counting (reference `#count` at 390)
1. **Start**: Inventory tab → "Count stock" (primary) or Home attention row "Back bar
   count assigned to you". Sheet: choose **Area** (Back bar, Store room, Walk-in — list
   with item counts and last counted) or **Full count**; "Start count".
2. **Count screen** (tab bar hidden): top bar title "Back bar count", back = "Pause"
   (keeps the session). Progress line under the header "12 of 40 counted".
   Card: location "Shelf 2 · item 13 of 40", item name 22/28 600, "Last verified 1 on
   Tuesday · par 4". **Stepper**: − / value / + at 72 px height, value 36 px tabular;
   tapping the value opens the numeric keypad; partial chips "+ ¼ / + ½ / + ¾" for
   bottles (only for items counted in bottles). Sticky footer: **Scan** (secondary,
   44 px square) + **Save and next** (primary, full width).
3. **Scan**: full-screen camera, finds the item by barcode and jumps to it; unknown
   barcode → "We don't know this barcode" + [Search items] + (manager) [Add barcode to an
   item].
4. **Voice** (optional): "Count by voice" in the `…` menu opens Atlas AI live voice with
   `context=count:<sessionId>`; spoken counts return as a *stock-count draft* approval
   card whose lines fill the session after the user taps "Add to count".
5. **Up next** list below the card (3 items) and a `…` → "Show all items" list (search,
   filter Not counted) to jump.
6. **Finish**: after the last item, summary screen: counted, skipped (list with "Count
   now"), big variances flagged (> tolerance from Settings) with "Recount" links;
   primary "Submit for verification" (staff) / "Verify and update stock" (manager).
   Copy under the button: "Stock changes only after a manager verifies this count."
7. Interruptions: a session survives app close; Home shows "Back bar count paused ·
   12 of 40" [Continue].

### 8.2 Product search ("do we have…?")
Inventory tab: sticky search field under the top bar (autofocus when opened from
Home's search icon with an item query). Results as rows: name 15/500, "Category ·
Supplier · Location", right: "1 / 4" with status pill. Tap → item detail full screen:
big on-hand figure, par, location (with photo if present), last count, "Used in"
recipes, actions "Count this" / (manager) "Add to order". The palette (search icon) finds
the same items from any page.

### 8.3 Recipe lookup
Recipes tab: search field + segmented All / Available + category menu chip. Results as
a two-column tile grid (photo 1:1, name, availability dot + word). Tap → recipe
detail full screen designed for reading at the bar: name 22/28, pill, **Build** list
with quantities 17/26 tabular in a left column (e.g. "30 ml  Tanqueray"), **Method**
numbered 17/26, Glass/Garnish/Ice as a 3-column fact row. Keep-awake while open
(Wake Lock API where available). Unavailable recipes show the limiting ingredient at
the top ("Campari runs out after about 30 serves").

### 8.4 Shifts
More → Shifts (or Home "My next shift"). Staff default: **My shifts** list (next 14
days: date header rows, shift row with time 17/600, role, colleagues' avatars, pill
Confirmed / Needs confirmation with inline "Confirm"). Segmented **Mine · Team**; Team
= day-by-day list (swipe days horizontally with a date strip at top). Actions in `…`:
Set availability (weekly grid of toggles per day/part), Request time off (dates + note).
Manager on phone: day view with "Add shift" (bottom sheet: person, start, end, role,
note), publish from the week summary; full week grid editing stays desktop/tablet.

### 8.5 Messages
More → Messages (badge). Channel list (rows: channel name 15/500, last message
preview 13, time, unread badge) → channel screen: messages as §7.3; composer sticky
above the keyboard (44 px min, `+` for photo/camera, send); new messages arriving while
scrolled up show "3 new messages ↓" pill. Tab bar hidden inside a channel.

### 8.6 Knowledge
More → Knowledge. Search at top, "Required for you (2)" rows first, then categories as
rows, then recent. Article: reading layout 17/28 on phones, sticky bottom bar with
"Mark as read" when required and "Ask Atlas" icon. Checklists inside articles are
tappable locally (not saved) unless the article is linked to an Operations checklist.

### 8.7 Atlas AI (reference `#ai` and `#ai-voice` at 390)
- Tab **Atlas** opens the most recent conversation if it is from today, otherwise the
  empty state. Top bar: History icon (left, opens the conversation list as a full
  screen with search, pinned, Decisions for managers), title "Atlas AI", New
  conversation icon (right). Bell and search are hidden here; tab bar hidden while the
  keyboard is open or voice is live.
- Composer fixed at the bottom with a 18 px white fade above it; attachments preview row
  above the textarea.
- **Photo**: `+` → action sheet *Take photo · Choose from library · Attach file*. After
  capture, thumbnail with remove ×; typical prompts appear as chips above the composer
  when a photo is attached ("Does this match our order?", "Count these bottles",
  "What is this?").
- **Voice note**: hold-free: tap mic → recording bar (red dot, timer, level, Cancel,
  Stop) → transcribing → editable transcript in the composer → send.
- **Live voice**: tap `audio-lines` → permission prompt explanation sheet the first time
  ("Atlas listens only while this panel is open.") → dark voice panel (Listening /
  Thinking / Speaking, transcript, Mute, End) replaces the composer; the thread keeps
  updating above it; approval cards appear inline and need a tap.
- Approval cards on phone: lines table keeps 3 columns (qty 48, total 84), footer
  wraps: primary full width, Edit and Dismiss beside it, expiry text below.

### 8.8 Quick actions on phone
Search icon → full-screen palette: input with keyboard open; with an empty query it
lists **Suggested** (context) then **Actions** (all role-permitted canonical actions,
grouped: Stock, Purchasing, Service, People) and **Recent**; typing searches records
and actions; "Ask Atlas" row at the bottom (top for questions).

---

## 9. Implementation map and work split

### 9.1 Order of work
1. **Day 1–3 — E1 foundations (blocking, but published early):** `atlas-tokens.css`
   new values + legacy aliases (§5.2), `atlas-base.css`, `atlas-components.css` (lift
   the component CSS from `docs/design/atlas-reference.html` verbatim as the starting
   point), shell markup (sidebar, top bar, tab bar, More sheet), routes and aliases in
   `AtlasShell`, `AtlasShell.actions`, palette skeleton, dialog/sheet in `modal.js`.
   E1 merges these in small PRs so module engineers rebase daily.
2. **Day 2 onward — E2–E6 in parallel:** rewrite each page's markup to the components
   and the page spec, register nav/route/actions/home rows through `AtlasShell`, move
   the page's surviving CSS into its one module file in `@layer atlas.modules`, delete
   its legacy override rules. The consolidation rule in the architecture audit ("take
   the last winning value") applies only to CSS that survives unchanged; redesigned
   pages are written fresh against tokens.
3. **Final 2 days — E1 deletes the global override layers** once every owner has
   confirmed their selectors are gone, then runs the acceptance pass (§10) with the
   design reviewer.

Rules for everyone: no new `:root` variables outside `atlas-tokens.css`; no
`!important` (except `[hidden]`, reduced motion, role gating in base); no module-
specific buttons, inputs, pills or cards — extend `atlas-components.css` through E1;
all copy per §5.9; keep `data-view` attributes on nav links (the browser harness and
tests use `.atlas-nav .nav-item[data-view]` — E1 keeps `.atlas-nav` and `.nav-item`
class names on the new sidebar links); update the browser tests you break in the same
PR.

### 9.2 Ownership

| Eng. | Scope | Files owned (edit) | CSS deleted by this engineer |
|---|---|---|---|
| **E1 Shell & system** | Tokens, base, components, shell (sidebar/rail/top bar/tab bar/More), routes, palette + search, actions registry, notifications panel UI, toasts, dialogs/sheets, sign-in/invitation/recovery, account menu, Design System doc | `apps/web/index.html` (shell, login, remove FAB `L818–826`, Service Mode, inline `<style>`), `assets/css/atlas-tokens.css`, new `atlas-base.css`, new `atlas-components.css`, new `assets/js/atlas-shell.js`, new `assets/js/atlas-palette.js`, `atlas-search.js`, `modal.js`, `atlas-search.css` (→ components), `invitation.html`, `recovery.html`, `account-invitation.js`, `account-recovery.js`, `config.js` (loader list only, with S42 re-pin), `runtime-module-guard.js` (delete), `s38-app-remediation.js` (delete after owners take their fixes), `docs/design/Atlas_Design_System.md` | index inline `<style>`, `atlas-glass.css`, `polish-pass2.css`, `s34-preproduction.css`, `accessibility-responsive-s61.css`, `workspaces-polish.css` (after owners), `s38-app-remediation.css` (after owners), `home-polish-baseline.css` (orphan), `atlas-search.css` |
| **E2 Today & admin** | Home, Operations, Notifications feed, Settings, System health | Home renderer in `index.html` (`renderAtlasHome`, `#home-*`) → new `assets/js/home.js` + `assets/css/home.css`, `operations.js`, `operations.css`, `brain.js` / `brain-daily-briefing-v2.js` / `business.js` (remove Home augmentation), `notifications.js` (feed wiring), `settings-workspace.js/.css`, `settings-mount-bridge.js` (delete), `system-workspace.js/.css` | `home-polish.css`, `operations-checkpoint-a.css`, `operations-checkpoint-a-layout.css` (+ their JS), `system-polish.css`, `brain-daily-briefing.css`, `business.css` (after E4 moves Overview) |
| **E3 Stock & buying** | Inventory (items, item detail, counts, movements, waste), stock count flow, scanner, Purchasing (orders, receiving, suppliers, suggestions) | inventory + purchasing renderers in `index.html` → new `assets/js/inventory.js`, `assets/js/purchasing.js`; `purchase-orders.js`, `stock-count-bootstrap.js`, `stock-count-workspace.js`, `stock-count-l1-verified.js`, `item-master-workspace.js`, `inventory-scanner.js`, `inventory-scanner-bootstrap.js` | `inventory-polish.css` → `inventory.css`, `inventory-operations-s58.css`, `purchasing-polish.css` → `purchasing.css`, `stock-count-workspace.css`, `item-master-workspace.css`, `inventory-scanner.css` (rewritten) |
| **E4 Menu & business** | Recipes, Reports (+ Overview from Business Intelligence), Marketing, Data (imports, issues, pars, import review) | `recipes.js`, `reports-workspace.js`, `business.js` (retire), `marketing-workspace.js`, `import-center.js`, `sprint3-review.js`, new `data-review-workspace.js` (S88 §6) | `recipes.css` + `recipes-gallery.css` → one `recipes.css`, `apps/web/recipes.css` (orphan), `reports-workspace.css`, `business.css`, `marketing-workspace.css`, `import-center.css` + `import-polish.css` → `data.css`, `sprint3-review.css`, `review-polish.css` |
| **E5 People** | Shifts (week, month, availability, time off, confirmations), Team, Messages (+ handover), Knowledge | `shifts-workspace.js`, `shifts-month-calendar.js`, `shifts-month-tab-bridge.js` (delete), `team-messages.js`, `team-unread-badge.js`, `team-profiles.source.js` + rebuild `.gz`, `team-profiles-bootstrap.js`, `team-profile-photos.js`, `team-profile-photo-gallery.js`, `knowledge-workspace.js`, `knowledge-team-link-bridge.js` (delete → `AtlasShell.links`) | `shifts-workspace.css`, `shifts-month-calendar.css` + `shifts-month-editor.css` → `shifts.css`, `team-messages.css`, `team-s57.css`, `team-profiles.source.css` + `.gz`, `team-profile-photos.css`, `knowledge-workspace.css`, `knowledge-s56.css` |
| **E6 Atlas AI** | Atlas AI workspace (list, thread, composer, evidence, approvals, progress), voice note + live voice UI, Decisions (from Brain), "Ask Atlas" entry points and `ai.*` actions, Home briefing card content (with E2) | new `assets/js/atlas-ai.js`, `assets/js/atlas-ai-voice.js`, `assets/css/atlas-ai.css`, `brain-phase3.js`, `brain-checkpoint-k.js` (→ Decisions), `brain.js` (retire page) | `brain.css`, `brain-phase3.css`, `brain-checkpoint-k.css` |

Shared seams (agree in the first stand-up, then don't change without the other owner):
- `AtlasShell.home.contribute` row contract (§7.1) — E2 owns the renderer; E3, E4, E5,
  E6 contribute rows.
- `AtlasShell.actions` ids (§4.8) — E1 owns the registry, each owner registers theirs.
- `AtlasShell.notify.contribute` — E1 panel, E2 feed, others contribute.
- Record routes (§3.4) — every owner makes their record routes work for links from
  AI, palette and notifications.

### 9.3 Tests to update (known)
`tests/browser/runtime.browser.test.mjs` (`#home-metrics .metric-card` → Home "at a
glance" links: E2), `operations-recipes.browser.test.mjs` (`operations-checklist`: E2),
`settings.browser.test.mjs` (tabs → section nav: E2), `shifts.browser.test.mjs`
(tab bridge: E5), `team.browser.test.mjs` (E5), `search.browser.test.mjs` (palette: E1);
node/python contract tests that pin override files or strings listed in the
architecture audit §7 move with the file that owns them. Add
`tests/browser/shell.browser.test.mjs` (E1): routes and aliases, palette keyboard
behaviour, tab bar at 390, no horizontal scroll at the six widths, focus return from
dialogs.

---

## 10. Acceptance criteria

The independent design reviewer checks every page at **1440, 1280, 1024, 768, 430,
390**, as admin and bartender, with (a) realistic data, (b) empty data, (c) the page's
API returning 503, (d) slow network (skeleton visible), (e) `prefers-reduced-motion`,
(f) keyboard only. Screenshots are compared side by side with
`docs/design/atlas-reference.html`. A page passes only when every applicable item holds.

### 10.1 Global checklist (every page)

**Clarity**
- G1 The page's purpose is clear from title + subtitle within 3 seconds; no eyebrows,
  hero cards or marketing copy.
- G2 No engineering language anywhere (§5.9 list), no raw error text, no "Unknown",
  no guessed zeros.
- G3 Every status has a word; nothing relies on colour alone.

**Hierarchy**
- G4 One H1; one primary button per context; primary is the most important action.
- G5 Content (the list/table/thread) is visible above the fold at 1440×900 and within
  the first screen at 390×844 (no KPI stacks before content).

**Efficiency**
- G6 The page's main job takes the fewest possible steps; every record and tab has a
  route that survives reload and back/forward.
- G7 Everything in the page is reachable from the palette (records, actions, tabs).

**Consistency**
- G8 Only components from `atlas-components.css`; no module-local button, input, chip,
  pill, card, tab or colour; no new `:root` variables; no `!important` outside base.
- G9 Page header, tabs, toolbar and section spacing exactly as §4.5, §5.4.
- G10 Icons are lucide at the sizes in §5.8; no emoji; no decorative icon tiles.

**Precision**
- G11 Everything aligns to the 4 px grid; gutters per §4.1; table numbers right-aligned
  and tabular; text never below 12 px; line lengths ≤ 80 characters in reading text.
- G12 No horizontal page scroll at any of the six widths; nothing clipped or
  overlapping (tab bar, composer, toasts, sticky footers respect safe areas).

**Beauty**
- G13 Calm: no gradients, glass, coloured shadows or tinted cards; blue only per §2.4;
  ≤ 3 status colours visible in a normal state.
- G14 Motion only per §5.7; nothing animates with reduced motion except ≤120 ms fades.

**Trust**
- G15 Loading shows layout-preserving skeletons; errors say what failed, what is safe
  and what to do, with a working retry; partial failures do not blank the page.
- G16 Actions state exactly what they change; destructive actions confirm with
  consequences; server-backed state is shown only after confirmation.
- G17 Role rules per §3.3: hidden destinations are absent from nav, palette, search and
  Home; direct links show the permission state.

**Accessibility**
- G18 Keyboard: all actions reachable in reading order; visible focus (2 px accent);
  Esc closes overlays; focus returns to the trigger; `⌘K` and `/` work.
- G19 Semantics: landmarks (`nav`, `main`, `header`), headings in order, labelled
  controls, `aria-current`, `aria-sort`, `aria-live` for streaming/new messages,
  dialogs `aria-modal` + labelled.
- G20 Contrast AA (text ≥ 4.5:1, large text/UI ≥ 3:1); touch targets ≥ 44 px on coarse
  pointers; pinch zoom allowed; works at 200 % browser zoom at 1280.

### 10.2 Per-page criteria

| Page | Must hold |
|---|---|
| Shell | Sidebar 240 / rail 64 / tab bar at the right widths; active item neutral; bell opens panel (not Settings); `+` opens palette Actions; no FAB, no Service Mode; More sheet lists every remaining destination for the role; phone title in top bar only; bartender sidebar has exactly 9 items. |
| Palette | Opens < 100 ms from `⌘K`, `/`, omni field, `+`, phone search; arrows/Enter/`⌘↵`/Esc work; context suggestions differ by page; role-filtered; "Ask Atlas" row always present; results for items, recipes, suppliers, orders, people, articles, pages. |
| Home | Greeting + context line from the venue clock (no hard-coded hours); attention list ordered by severity, ≤5 rows, each with one working action; briefing ≤2 paragraphs with sources line; Tonight and timeline from real data; at-a-glance links filter the target page; bartender variant; one-contributor failure shows one neutral row. At 390 the first attention row is visible without scrolling. |
| Atlas AI | Reading column 720; streaming with stop; progress line human, collapses when done; evidence kinds labelled; approval card states all reachable (proposed, working, done, failed, expired, dismissed, waiting for a manager); composer photo/file/voice note/live voice; voice states per §6.28; no JSON/tool/agent names anywhere (inspect DOM text); Decisions manager-only; phone: history + new in top bar, tab bar hidden in conversation. |
| Messages | Channel list + thread; grouping and day dividers; unread divider; handover template; viewer read-only copy; phone list→thread with sticky composer; failed send retry. |
| Operations | Today tab rows = server checklists (no device-local checklist); checklist detail with who/when; temperature log dialog with out-of-range handling; Schedule manager-only; no readiness %, no suggested purchasing, no duplicated implementations in the DOM. |
| Inventory | Table per §6.16 with column priorities at 1024/768 and row list at <768; "Not counted" instead of Unknown; Category as one menu chip; bulk bar; item detail sheet with Used in; Counts/Movements/Waste tabs; bartender without cost/supplier; no red × in rows. |
| Stock count | 390: stepper 72 px, partial chips for bottles, sticky Scan + Save and next, progress, pause/resume, finish summary with variances; desktop List mode with keyboard entry; copy about verification. |
| Recipes | Search + segmented + category chip; tiles with availability and limiting ingredient; detail readable at the bar (17/26 build list on phone, wake lock); editor sheet with sticky save; staff never see cost. |
| Purchasing | Orders default with Suggested order summary; order status flow and "Mark as ordered" copy; receiving with partial lines and optional photo check; suppliers without fake zero spend; money in "3.900 kr" tabular, never monospace. |
| Shifts | Week grid with navigator, Week/Month, Publish with unpublished count; staff "My shifts" with Confirm; availability and time off flows; phone Mine/Team lists; no KPI cards; handover links to Messages. |
| Team | Directory table / phone rows; profile sheet; emergency contacts masked and manager-only; invite (admin). |
| Knowledge | Search-first library; required reading first for staff; article reading layout 16/26 (17/28 phone) at 720; Mark as read; manager editor; no hero/KPI cards. |
| Reports | Period + comparison + export in header; Overview includes the former Business Intelligence figures; every chart has a one-sentence takeaway; "not enough data" instead of zeros; Ask Atlas opens with report context. |
| Marketing | Overview (Coming up, Waiting for approval); post editor sheet with preview; manual-publishing caption; Connections live in Settings. |
| Data | Four tabs; imports with stepper and plain-language failures; Issues with Fix actions to canonical editors; Par levels bulk editor saves only on "Save n changes"; Import review with "Nothing here changes live records until you approve it." |
| Settings | Section nav + 720 content; per-form save bar; opening hours editor feeds Home; Notifications shows real device status; Integrations per S88 §7; System health admin-only without "Checkpoint"/"Unknown"; staff see Preferences + Notifications only. |
| Sign-in / invitation / recovery | Same layout, working brand mark, inline errors, loading states, expired/used invitation states, recovery never reveals account existence, zoom allowed. |

---

## 11. Owner decisions (defaults used by this spec)

1. **Phone tab bar slot 4**: Recipes (default) vs Messages. Pattern unchanged either way.
2. **Service Mode** is retired (default); the phone tab bar and Home replace it. If
   the owner wants a kiosk mode for a bar tablet, it becomes a later "Bar display"
   preference, not a top-bar button.
3. **Bartenders recording waste**: off (default, matches today's `data-commercial-only`).
4. **Viewers see the Atlas briefing**: no (default) — they see attention rows only.
5. **Money format**: "3.900 kr" (is-IS grouping) in an English UI (default) vs
   "ISK 3,900".
6. **Fraunces** kept only for the Home greeting, sign-in heading and the Atlas AI empty
   state (default). Everything else IBM Plex Sans.
7. **Accent** darkened from `#2f80ed` to `#1f6fdb` for AA contrast (default). The old
   value stays available only as a brand illustration colour.
8. **Bookings / events / weather** on the Home context line appear only when a real
   source exists (default: hidden until then).
9. **Dark mode**: out of scope for this redesign; tokens are ready for it.

### Lead engineering note (binding for implementation)

The reference page (`docs/design/atlas-reference.html`) uses illustrative content
(bookings, quiz night, sales estimates, named staff, prices). Implementations must
render only real Atlas data. Where a source does not exist (bookings, POS sales,
weather) the element is hidden or shows the truthful "not connected" state — never
placeholder numbers. Owner-decision defaults 1–9 above are adopted for S88.

### Owner rules for module teams (binding, S88)

1. Module teams (A: Home · Operations · Settings; B: Inventory · Purchasing · Stock count;
   C: Recipes · Reports · Data; D: Shifts · Team · Messages · Knowledge) must not change
   global typography, spacing, buttons, inputs, navigation, shell or responsive rules inside
   their own pages. A missing or wrong global pattern is fixed in the design system
   (`atlas-tokens.css`, `atlas-base.css`, `atlas-components.css`, `atlas-shell.css`) by the
   design-system owner, then consumed by the module.
2. Module stylesheets contain only module layout and module-specific pieces, in
   `@layer atlas.modules`, with no `!important` and no new tokens.
3. Team B consumes the Visual Inventory Intelligence contracts and shared capture/recognition
   components; it does not build its own scanner or recognition UI.
4. Merge checkpoint before module teams start: tokens/components merged; shell rebased onto
   them and visually checked; Atlas AI rebased onto both; Visual Inventory foundation verified
   not to alter live stock; all suites at or above Node 802 / browser 57 / Deno AI 98 /
   Python OK.
