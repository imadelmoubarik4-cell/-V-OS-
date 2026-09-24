# Atlas S87 — Engineering Health Report

Branch: `claude/determined-brahmagupta-6ea5j6` (from `main` @ `a363eb2`, S86/S86.1).
Date: 2026-09-24. Nothing in this package has been applied to production.

This repository is public, so this report contains counts and code references only.
Record-level review lists (item, recipe and supplier names) were delivered privately.

## 1. Executive summary

Atlas is functionally broad and its database security is sound, but before S87 it
was **not release-ready**: several visible controls did nothing or reported states
that were not true, modules disagreed about basic facts, and a few front-end loops
could flood the backend during an outage.

What the audit measured (not assumed):

- **Live production evidence (24 h of logs):** Settings "Save hours" could never
  succeed (0 hour rows exist, the form rendered none); the Security section could
  never be saved; **no device has ever stored a push subscription** and the one
  queued notification was never delivered, yet the switch could show "On"; Reports
  failed 23 times before the S86.1 deploy and 13/13 after it (S86.1 verified fixed).
- **Measured in a browser harness running the real app:** during an API outage,
  an open Knowledge page sent ~50 requests/s, Messages ~30/s, Shifts ~10/s, and
  Messages showed an endless spinner with no retry; once Messages had rendered,
  every page ran a DOM loop every animation frame (~600 mutations/s while idle);
  every return to Home threw an exception that skipped its links and
  augmentations; a page opened during the first data load was replaced by Home.
- **Single truth:** "below par" had two definitions (`<` on Home/Reports stock,
  `<=` in Inventory, Operations, Brain, recipes and three server mirrors), so an
  item at par was low on some pages and healthy on others.
- **Safety:** a recipe (100 active in production) or an inventory item (which
  un-links its movement history and recipe links) could be hard-deleted from one
  confirm dialog; any signed-in account, including deactivated ones, could
  overwrite or delete public menu images.

Systemic causes: features added as successive overlay layers (18 "polish/
remediation/sN" stylesheets, 4 modules monkey-patching the same shell functions,
3 separate handlers on one search field); settings persisted with no consumer;
state reported from the client side only (push); and no browser-level tests.

S87 fixes every repository-fixable P0/P1 found, adds a Chromium test harness
(49 browser tests) and four database acceptance scripts, and leaves a short list
of owner decisions. **Atlas is not production-ready until the rollout in §15 is
done and the owner actions in §14 are completed** — most importantly par levels
(234 of 236 active items have none, so every "below par" signal is inert).

## 2. System inventory

Runtime: static shell `apps/web/index.html` (≈2,500 lines incl. inline controller),
44 stylesheets (679 KB), 45 scripts (≈1.1 MB); modules load via `<script>` tags,
`config.js` window-load loaders, `runtime-module-guard.js`, and three bootstraps
(gzip Team Profiles bundle; Stock Count / Item Master; scanner).
Backend: 18 Edge Functions in production (16 in `supabase/functions`, plus
`atlas-import-worker` in `supabase/s33` and an unreferenced
`atlas-backup-export-20260806`), 125 public functions, `private`/`atlas_private`
helpers, RLS on every public table, three Storage buckets.

Data flow (typical): `UI module → fetch Edge Function (JWT) → verifies active
profile → service-role RPC in atlas_private → JSON snapshot → module render`.
Direct browser → PostgREST paths: inventory/recipes/suppliers/purchase orders
(RLS + manager checks inside 4 public write RPCs).

## 3. Connection matrix

Legend: **C** connected end-to-end · **P** partially connected · **D** disconnected ·
**PH** placeholder · **ID** intentionally disabled. "After" = state on this branch.

| Area | Feature | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Home | KPI cards (items, below par, margin) | P (render threw on return) | C | |
| Home | Team members KPI | P ("—" until Team opened) | C | uses unread-badge snapshot |
| Home | Timeline / countdown | P | P | hard-coded hours; Settings hours unused (§6) |
| Home | Low stock banner / "Items below par" | P (scroll only) | C | opens "Below par only" filter |
| Inventory | List, categories, stock truth | C | C | |
| Inventory | Text search | PH (none) | C | |
| Inventory | Delete item | C but destructive | C (deactivate) | DB guard for history |
| Inventory | Edit item (quantity field) | C (disabled qty) | C | |
| Stock count / Item Master / Scanner | Sessions, publish, scan | C | C | not re-audited in depth |
| Recipes | List, filters, readiness, detail | C | C | blocker reason now correct |
| Recipes | Image upload | C (HEIC raw) | C | on-device re-encode |
| Recipes | Delete / archive | C but destructive | C | archive + typed delete + DB guard |
| Purchasing | Draft / amend / place / receive / cancel | C | C | "Mark as ordered" wording |
| Purchasing | Partial receiving, approval, expected delivery | PH | PH | backend has no such states (§14) |
| Operations | Summary cards | D | C | |
| Operations | "Mark ordered" | P (device-only) | C/P | real POs shown as "On order"; local note labelled |
| Operations | Daily checklist | P (device-only) | P | stored in this browser only (§6) |
| Messages | Send/edit/delete/pin/read | C | C | |
| Messages | Sender name / photo | P (email label, no photo) | C | |
| Team Profiles | Edit, photo upload | C | C | roster event on edit |
| Shifts | Week/Month, add/edit, publish, confirm | C | C | Month add-shift re-tested |
| Knowledge | Browse, search, versions, drafts | C | C | staff isolation verified |
| Knowledge | Google Drive sync | PH | PH | source links are manual references |
| Reports | All sections | C (since S86.1 deploy) | C | |
| Search / Ask Atlas | Records + questions | D (keyword navigation only) | C | |
| Brain | Rule-based summary, Ask box | P (could state untrue stock) | C | |
| Brain | Decision memory, Checkpoint K intelligence | C (read-only recommendations) | C | learning flags: see §6 |
| Brain | Automatic execution | ID | ID | |
| Marketing | Planning, approvals | C | C | |
| Marketing | Publishing / analytics | ID/PH | ID/PH | no OAuth exists |
| Settings | Venue, roles, offers | C | C | |
| Settings | Business hours | D (unsaveable) | C | |
| Settings | Security section | D (unsaveable, unused) | C (truthful status) | |
| Settings | Personal: start view, reduce motion | D (saved, unused) | C | |
| Settings | Personal: theme, density, language, time zone, email | D | PH (shown as not available) | |
| Settings | Organisation rules | P | P (usage labelled) | |
| Settings | Modules toggles | D | PH (labelled "not enforced") | |
| Notifications | Device subscription | P (client-only "On") | C | truthful states |
| Notifications | Server delivery | ID | ID | needs owner config (§14) |
| Integrations | GBP, Facebook, Instagram, TikTok, Tripadvisor | PH | PH | honest cards (§7) |
| System | Health, sources, jobs | C | C | read-only |

## 4. P0 findings (correctness, data, security, crash)

| # | Finding | Root cause | Fix | Test |
| --- | --- | --- | --- | --- |
| P0-1 | Request storms during outages (Knowledge ~50/s, Messages ~30/s, Shifts ~10/s; Knowledge also on a 200 without data) | `classList.add/remove` rewrote the host class attribute on every render, re-entering the module's own visibility observer | guarded class writes; 20 s backoff for observer-driven loads | `runtime.browser.test.mjs` |
| P0-2 | Two below-par definitions across modules and server mirrors | duplicated comparisons (`<` vs `<=`, par>0 not always required) | `AtlasStockTruth.belowPar()`; server mirrors aligned | `stock-parity-s87.test.js` |
| P0-3 | Menu images writable/deletable by any signed-in account incl. deactivated staff | storage policies only checked `auth.uid()` | migration `20260925091000` (manager writes, active-staff reads) | `verify_s87_atlas_media_policies_preview.sql` (fails on old policies, passes after) |
| P0-4 | Recipe hard delete from one confirm | UI + no guard | archive/restore; typed delete for archived only; migration `20260925090000` | browser + `verify_s87_recipe_delete_guard_preview.sql` |
| P0-5 | Inventory delete silently un-linked movement history and recipes | FKs `SET NULL`; UI hard delete | deactivate; migration `20260925093000` | browser + `verify_s87_inventory_delete_guard_preview.sql` |
| P0-6 | Push "On" without a server subscription; orphaned device subscriptions | client-only state; no cleanup on server failure | server-confirmed states; cleanup; honest delivery/config states | `settings.browser.test.mjs` (4 tests) |
| P0-7 | Brain assistant said stock was above par when nothing was verified | fallback message ignored unknown stock | discloses unverified items; shared answers | search/brain paths |

## 5. P1 findings (broken core functionality)

| # | Finding | Fix |
| --- | --- | --- |
| P1-1 | Settings: one shared "saving" flag relabelled/disabled every form; saves re-rendered away unsaved edits; focus refresh overwrote drafts | per-form save state and feedback; draft capture/restore; no silent reload while dirty |
| P1-2 | Settings "Save hours" always 400 (no rows rendered; `HH:MM:SS` rejected) | seven default rows; `HH:MM` normalisation; server accepts `HH:MM:SS` (deploy) |
| P1-3 | Settings Security unsaveable (API rejected `api_keys_visible`, `password_policy_managed_by_auth`) and unused | truthful status panel; server key match anchored (deploy) |
| P1-4 | Preferences saved but unused (start view, reduce motion; theme etc. had no implementation) | start view + reduce motion applied at sign-in; others shown as unavailable |
| P1-5 | Home render threw on every return | null-safe optional regions |
| P1-6 | Messages endless spinner on outage | loading flag cleared before error render |
| P1-7 | Per-frame DOM loop on every page after Messages rendered | idempotent writes in `s38-app-remediation.js` (1,806 → 9 mutations / 3 s) |
| P1-8 | Page chosen during first load replaced by Home | initial view only if the person has not navigated |
| P1-9 | Search: 3 keystroke handlers navigated mid-word; no records; hidden on phones | unified `atlas-search.js`; records + grounded answers; phone control |
| P1-10 | Operations summary cards inert | buttons with filtered destinations |
| P1-11 | Messages showed email addresses as names; no photos; photos only loaded after visiting Team | `sender_id` → current profile; photos at sign-in; roster event on edit |
| P1-12 | Incomplete recipes blamed the wrong ingredient | `recipeBlockers()` names the real blocker and reason |
| P1-13 | Bell showed unread messages but opened Settings | opens Messages when unread |
| P1-14 | Push taps (`#team`, `#shifts`) opened Home | `#view` routing at sign-in |
| P1-15 | "Submit order" implied sending to the supplier | "Mark as ordered" + confirmation |
| P1-16 | `crypto.randomUUID()` unguarded (Purchasing failed on iOS < 15.4) | fallback |

## 6. P2 findings (data/usability remaining or partially addressed)

- Home timeline and Brain countdown use hard-coded hours in browser local time;
  Settings business hours and offers are not read. Enter hours in Settings (now
  possible), then wire the schedule to them (follow-up).
- Organisation rules: only reorder suggestions and purchase/menu/waste learning
  change behaviour today; the rest are stored and labelled as such.
- Operations daily checklist and local "Mark ordered" notes live in one browser.
- No reactivation UI for deactivated inventory items (Item Master has no
  active field); archived recipes can be restored.
- Purchasing has no partial receiving, approval step or expected delivery date.
- Inventory rows still render sub-44px targets on desktop by design (36px).

## 7. Integrations

| Provider | UI | OAuth | Credentials store | Read | Publish | Analytics | Production | Requires |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Google Business Profile | status card | none | none | no | no | no | not connected | Google Cloud project, Business Profile API access, OAuth (`business.manage`), verified profile, location access |
| Facebook | status card | none | none | no | no | no | not connected | Meta app + review, Page, page insights/publishing permissions, OAuth |
| Instagram | status card | none | none | no | no | no | not connected | Meta app + review, professional account, insights/publishing permissions, OAuth |
| TikTok | status card | none | none | no | no | no | not connected | developer app + review, Content Posting API, approved scopes, URL verification, OAuth |
| Tripadvisor | status card | none | none | no | no | no | not connected | claimed listing, Management Center access, Content API key + billing |
| Google Drive (Knowledge) | manual source links | none | none | no | – | – | manual references only | Drive API + OAuth if sync is wanted |
| Web push | Settings switch | – | server env | – | – | – | subscriptions possible, delivery off | VAPID keys, dispatch token, delivery flag, scheduler |

No Connect buttons are shown without a real flow. No tokens or secrets are in
browser code (history scanned).

## 8. Database / data quality (production, read-only)

| Check | Count |
| --- | --- |
| Inventory items (active / inactive) | 236 / 41 |
| Active items without par level | **234** |
| Active items without supplier | 58 (6 with supplier text but no link) |
| Active items without cost | 22 |
| Active items without SKU/barcode/supplier reference | 78 |
| Package sizes the engine cannot parse (e.g. multi-packs "24 x 330ml") | 82 (49 multi-pack) |
| Active items flagged `needs_review` | 14 |
| Same name active and inactive | 2 pairs |
| Negative / implausible quantities | 0 |
| Active items with stock evidence (owner/manager) | 194 of 236; 195 verified balances |
| Recipes (active) | 105 (100) |
| Active recipes without ingredients | 3 |
| Active recipes without menu price | 14 |
| Recipe names that look like tests | 2 |
| Ingredients unlinked / on inactive items / orphaned | 2 / 21 / 0 |
| Profiles (active) / without display name | 2 / **2** |
| Suppliers / without email or phone | 8 / 8 |
| Push subscriptions stored / notifications delivered | 0 / 0 (1 queued) |
| Business hours rows / offers | 0 / 0 |

Ambiguous merges were not attempted. The named review list was delivered privately.

## 9. Security

- Supabase security advisor: **0 findings**.
- `anon` can execute **no** public function; no public table lacks RLS; every
  SECURITY DEFINER function pins `search_path`.
- The 4 browser-callable write RPCs (`adjust_inventory`,
  `atlas_purchase_order_command`, `atlas_apply_item_master_update`,
  `atlas_save_recipe`) check `private.is_manager_or_admin()`, which requires an
  **active** profile; inactive staff lose access at the database.
- Edge Functions verify the JWT and an active profile per request; service keys
  stay server-side; no secrets in the repository or its history.
- Fixed: `atlas-media` write access (P0-3). Verified: Knowledge staff isolation
  (drafts, pending edits, source URLs) on a replay database.
- Note: `atlas-backup-export-20260806` is deployed but not in the repository —
  review whether it is still needed.

## 10. Performance

- Performance advisor: 1 WARN (duplicate `inventory_items(name)` index — migration
  `20260925092000` drops the unused copy), 5 unindexed FKs (INFO, small tables),
  84 unused indexes (INFO), Auth connection strategy (INFO).
- Measured front end: request storms and per-frame DOM loop fixed (§4, §5).
  Idle polling after fixes: unread badge every 8 s with `limit=1`, paused in
  hidden tabs (≈450/h per open tab — matches production's 953/day); Daily Briefing
  every 5 min; photos every 5 h.
- Brain's countdown ticks every second even when Brain is hidden (minor).

## 11. Mobile / accessibility

Sweep of 15 views at 1440/1024/768/390 px (before → after):

| Metric | Before | After |
| --- | --- | --- |
| Views with horizontal page scroll | 1 (Purchasing @768) | 0 |
| Unlabelled inputs | 16 | 0 |
| Controls under 32px | 181 | 133 |
| Distinct primary-button colours | 3 | 1 |
| Search available on phones | no | yes (44px) |

Also: search icon no longer blocks taps; focus-visible outline everywhere; reduce
motion honoured globally. Remaining: ~888 text nodes under 11px (mostly Shifts,
Recipes, Marketing, Business, Team) and icon buttons inside collapsible panels
to spot-check with a screen reader.

## 12. Architecture

Duplicate or layered systems that should be consolidated:

- Two Operations implementations run together (`operations.js` + Checkpoint A
  cards injected into it).
- `setActiveView`, `renderAtlasHome` and `loadAll` are monkey-patched by 4
  modules (operations, brain, business, checkpoint A); order-dependent.
- 18 override stylesheets, 844 `!important`, 921 selectors redeclared (up to
  20×); a search field pinned by two `!important` rules to 36–42px.
- Bridge scripts exist to arbitrate conflicts between layers
  (`settings-mount-bridge.js`, `shifts-month-tab-bridge.js`,
  `knowledge-team-link-bridge.js`, `s38-app-remediation.js`).
- Dead code: `settings-workspace-bootstrap.js` (loads a file that does not exist).
- Hard-coded assumptions: opening hours in `brain.js`; a greeting special case for
  one name in `index.html`.

Recommended order: retire the Home/Operations monkey-patches behind one event
(`atlas:view-change`), then merge `operations.js` with Checkpoint A, then fold
each "polish" stylesheet into its component file using `atlas-tokens.css`.

## 13. Fixes completed on the branch

| Commit | Scope |
| --- | --- |
| `89e3815` | Chromium harness (real app, mocked backend, request recording) |
| `fa18cf6` | request storms, Home crash, navigation during load, `#view` routing, bell |
| `1b50e4c` | Settings + Notifications (+ `atlas-settings` function) |
| `8f6d6c0` | Messages identity and photos; Team Profiles bundle rebuilt |
| `24833ed` | per-frame DOM loop |
| `d0f8593` | single below-par rule (browser + 3 function mirrors) |
| `c6deab6` | Search / Ask Atlas; Inventory search; recipe blockers |
| `a71d7da` | Operations cards, recipe archive/delete guard, image re-encode, UUID fallback |
| `1ee79e6` | purchase order wording, "On order", integration readiness |
| `50f1ab2` | Brain answers; plain product copy; Knowledge role matrix script |
| `a222913` | media storage policies |
| `25d2dde` | duplicate index |
| `7351ee3` | inventory deactivate + delete guard |
| `d6ffd31` | design tokens, one Atlas blue, visual and accessibility fixes |
| `6d44e7b`, `6b14a4d` | release re-pins (hash-only); line endings restored |

Tests: Node 365 pass · Python 253 pass (4 skipped) · browser 49 pass ·
migration replay 105 migrations pass · S87 DB acceptance 4/4 pass.

## 14. Owner actions (not decided by engineering)

1. **Set par levels** for items you reorder (234 of 236 have none).
2. **Business hours and offers** in Settings → Venue & hours (none saved).
3. **Display names** for both profiles (messages currently derive names from emails).
4. **Push notifications:** set `ATLAS_VAPID_PUBLIC_KEY`, `ATLAS_VAPID_PRIVATE_KEY`,
   `ATLAS_VAPID_SUBJECT`, `ATLAS_PUSH_DISPATCH_TOKEN`, then
   `ATLAS_PUSH_DELIVERY_ENABLED=true` and a scheduler calling `?action=dispatch`.
   On iPhone, staff must add Atlas to the Home Screen.
5. **Data review list** (sent privately): same-name active/inactive pairs, 21 recipe
   links to inactive items, 2 unlinked ingredients, 3 recipes without
   ingredients, 2 test-like recipe names, 14 `needs_review` items, 6 supplier
   texts without a supplier record, supplier contacts, 82 package sizes.
6. **Integrations:** decide which providers matter; each needs the accounts and
   approvals in §7 before any build.
7. **Purchasing:** decide whether partial receiving, approvals and expected
   delivery dates are wanted.
8. **Unreferenced function** `atlas-backup-export-20260806`: keep or remove.

## 15. Production rollout plan

Order matters: database first (backwards-compatible), then functions, then web.

1. Back up / confirm point-in-time recovery.
2. Migrations (in order):
   `20260925090000_s87_recipe_delete_guard.sql`,
   `20260925091000_s87_atlas_media_manager_writes.sql`,
   `20260925092000_s87_drop_duplicate_inventory_name_index.sql`,
   `20260925093000_s87_inventory_delete_guard.sql`.
   The web app currently in production keeps working with all four; only its
   destructive delete paths (active recipes, items with history) and non-manager
   media writes are refused.
3. Edge Functions: `atlas-settings`, `atlas-reports`,
   `atlas-phase3-intelligence`, `atlas-item-master`.
4. Web (Netlify) from this branch.
5. Verify (§16), then run Supabase advisors again.

Rollback: web → previous deploy; functions → previous versions; migrations are
additive guards/policies (drop the two triggers and restore the four previous
`atlas-media` policies from `20260801165947`; the dropped index was unused).

## 16. Final acceptance checklist (run in production)

- [ ] Settings → Venue & hours shows seven days; set Friday hours → Save shows
      "Business hours saved." only on that card; reload keeps them.
- [ ] Edit a field in one card, save another → the first edit is still there.
- [ ] Security shows enforced protections, no toggles.
- [ ] Preferences → Start view "Shifts", Reduce motion on → Save → sign out/in →
      Atlas opens on Shifts without animations.
- [ ] Notifications on a phone: turn on → "On" only if the server stored it;
      turn off → "Off". Without VAPID keys it says "Not set up".
- [ ] Messages: another person's message shows their name/photo, never an email.
- [ ] Search "pinot" → item with verified stock; Enter opens Inventory filtered.
- [ ] Ask "What is low in stock?", "Can we make Margarita?", "How many … remain?",
      "What needs ordering?", "Who works tomorrow?" → answers match the pages or
      say what data is missing.
- [ ] Operations cards open Inventory (below par), Recipes (Attention), the order
      and the opening checklist.
- [ ] Recipes: an active recipe offers Archive only; archived → Delete requires
      the name.
- [ ] Inventory ✕ deactivates; the item disappears from live stock and its recipe
      links remain.
- [ ] Home "Items below par" matches Inventory "Below par only" and Ask Atlas.
- [ ] Reports loads every section.
- [ ] On a phone: search opens, no page scrolls sideways, Month view can add a shift.
- [ ] Take Knowledge API offline in a test → Knowledge shows "Try again" and
      sends no further requests until pressed.

---

# Atlas Design Health Report

1. **Problems found:** 44 stylesheets (679 KB), 18 override layers, 844
   `!important`, 60 border radii, 51 font sizes (7–9px text ~390 times), 153 shadows,
   941 hex colours, 26 conflicting root tokens, 3 primary blues, a near-black
   primary in Settings, engineering copy on product screens.
2. **Screens affected:** every screen (tokens); visible defects on Home (timeline),
   Inventory (dates, search, row controls), Purchasing (overflow @768), Settings
   (black primaries, oversized phone hero), Operations (inert cards).
3. **Tokens before/after:** `--atlas-accent` brass vs blue → blue only; module blues
   `#2d78dc`/`#4f7df3` → aliases of `--atlas-accent`; new spacing, radius, type,
   elevation, control and motion scales (`atlas-tokens.css`).
4. **Duplicate CSS identified:** see §12; dead token blocks removed from the shell,
   `atlas-glass.css`, `home-polish.css`, `s34-preproduction.css`,
   `s38-app-remediation.css`.
5. **Consolidated:** colour tokens (one source), focus ring, table scroll wrapper,
   search field anatomy.
6. **Pages normalised:** primary actions on Home, Operations, Recipes,
   Purchasing, Brain, Settings; copy on Operations, Recipes, Brain, Business,
   Knowledge, Marketing, Reports, Shifts, Data review, Inventory, Settings.
7. **Responsive fixes:** Purchasing overflow, phone search, Month view verified,
   inventory search/row targets.
8. **Accessibility:** labels, accessible names, touch targets, focus, reduce motion.
9. **Remaining visual debt:** sub-11px text; override layers and `!important`;
   Settings phone hero height; Fraunces numerals mixed with Plex in KPI cards;
   per-module shadows and radii to move onto tokens.
10. **Before/after screenshots:** included in the privately delivered report.

Design rules for future screens: `docs/design/Atlas_Design_System.md`.
