# Atlas time migration checklist (S88)

One browser helper owns operational time: `window.AtlasVenueClock`
(`apps/web/assets/js/atlas-venue-clock.js`, loaded right after `atlas-stock-truth.js`,
before every module). This page lists every browser call site that still computes dates,
times, time zones or money on its own, with the owning module team, so each team
migrates its own pages. Tick a row off in the same PR that migrates it.

Owning teams (spec §11 "Owner rules for module teams"): **A** Home · Operations ·
Settings (incl. System health, Brain's Home pieces) · **B** Inventory · Purchasing ·
Stock count · **C** Recipes · Reports · Data (and Marketing, E4 scope) · **D** Shifts ·
Team · Messages · Knowledge. Rows outside A–D are marked **Shell** (E1) or **AI** (E6).

## 1. The helper

Backend: `GET atlas-settings?action=venue-clock` (all active roles) →
`{ clock: { timezone, timezone_source, hours_configured, business_hours[], offers[], venue_date,
business_date, venue_local_time, generated_at }, staff: { role, can_manage_hours } }`
(S88 backend contract §1; migration `20260926090000_s88_venue_clock.sql`).

| API | Returns / does |
| --- | --- |
| `load()` | One request after sign-in (`profile:ready`), cached; later calls return the cache. |
| `refresh()` | Re-fetch. Called automatically on `settings:saved` for `save-hours`, `save-offer`, `save-section` (venue), and when the business date rolls over (timer + focus/visibility check). |
| `state()` | `{ status: 'loading'\|'ready'\|'not_set'\|'unavailable', timezone, timezoneSource, timezoneIsDefault, businessDate, venueDate, hoursConfigured, today: { isOpen, open, close, closeNextDay, lastOrder, kitchenClose }\|null, offers, canManageHours, error }` |
| `onChange(fn)` | Called after every load/refresh; also shell event `venue-clock:changed` and window event `atlas:venue-clock`. |
| `apply(payload)` | Apply a venue-clock payload without a request (tests; a module that already has one). |
| `timeZone()`, `timezoneIsDefault()` | Venue IANA zone; `Atlantic/Reykjavik` only when the setting is missing/invalid or the clock is unavailable, and flagged. |
| `today()`, `tomorrow()` | **Business** date (operational day) and the day after, `'YYYY-MM-DD'`. |
| `businessDate(at)` | Business date of an instant: before the previous day's after-midnight close (`close_next_day`) it is the previous date; without saved hours it is the venue calendar date. Same rule as `atlas_private.venue_business_date`. |
| `venueDate(at)` | Venue **calendar** date of an instant. |
| `parts(at)` | `{ year, month, day, hour, minute, second, weekday, dateKey, time }` in the venue zone. |
| `weekday(date)` | 0 = Sunday … 6 = Saturday (same as `settings_business_hours.weekday`). |
| `addDays(dateKey, n)`, `startOfWeek(date)` (Monday), `monthKey(date)`, `monthRange(date)` | Date-key arithmetic at UTC noon; zone- and DST-independent. |
| `compareRange({ start, end })` | Reports comparison period, see §3. |
| `zonedToInstant(dateKey, 'HH:MM')` | Venue wall time → `Date` (offset solved twice, DST-safe). |
| `formatTime(v)` | `'17:00'` (24 h, venue zone); also accepts `'17:00:00'` time-of-day strings. |
| `formatDate(v, { long, year })` | `'Thu 24 Sep'` / `'Thursday 24 September'` (+ year). Date keys print as that date; instants as their venue date. |
| `formatDateTime(v)` | `'Thu 24 Sep, 17:00'`. |
| `formatRelative(v, at)` | `'just now'`, `'12 min ago'`, `'in 3 h'` under 24 h; otherwise `formatDateTime`. |
| `localInputValue(v, type)` | Value for `<input type="datetime-local">` (`'YYYY-MM-DDTHH:MM'`, venue wall time) or, with `'date'`, `<input type="date">`. |
| `fromLocalInput(value)` | Inverse: a datetime-local value is read as **venue** wall time → ISO instant (`…Z`); a date value stays a date key; invalid → `null`. |
| `dayWindow(dateKey)` | `{ state: 'loading'\|'unavailable'\|'not_set'\|'closed'\|'open', open, close, lastOrder, kitchenClose }` from saved hours. |
| `isOpenAt(at)` | `true`/`false`, or `null` when hours are not set / not loaded. |
| `nextEvent(at, { types })` | Next `opens` / `last_orders` / `kitchen_closes` / `closes` `{ type, label, at, time, businessDate }`, or `null` when hours are not set (never invented). |
| `offersOn(dateKey)`, `timeline(dateKey, at)` | Offers for a weekday; the day's timeline built only from saved hours + offers (`[]` when not set or closed). |
| `formatKr(n)` (= `AtlasFormat.money`) | `'3.900 kr'` (is-IS grouping, whole krónur; spec §11 decision 5). `null`/invalid → `'—'`. |

States every consumer must show truthfully:
- `loading` — "Loading opening hours…".
- `not_set` (production today: 0 hours rows) — "Opening hours not set", with a Settings link
  (`AtlasShell.show('settings', { section: 'general' })`) only when `state().canManageHours`;
  no timeline, no countdown, no default hours.
- `unavailable` (404: function not deployed; other errors) — "Opening hours unavailable".

## 2. Rules for migrating a call site

1. "Today" for operations (checklists, counts, shifts "today", briefing) → `today()` /
   `businessDate(at)`. Calendar display of "today's date" → `venueDate()`.
2. Never `getHours()/getDay()/getDate()/setHours()/setDate()/toLocale*String()` without
   `timeZone`, never `new Date(y, m, d)` for an operational date, never `new
   Date(datetimeLocalValue)`.
3. Date-only values stay `'YYYY-MM-DD'` strings; arithmetic via `addDays` / `startOfWeek` /
   `monthRange`.
4. Instants display via `formatTime` / `formatDate` / `formatDateTime` / `formatRelative`.
5. `<input type="datetime-local">` ↔ ISO only via `localInputValue` / `fromLocalInput`.
6. No literal `'Atlantic/Reykjavik'` outside `atlas-venue-clock.js` → `timeZone()`.
7. No hard-coded service hours. `tests/node/venue-hours-ratchet-s88.test.js` fails on any new
   time-of-day literal and holds ceilings for the rows marked **ratchet** below; lower the
   ceiling in the same PR that removes one.
8. Money → `formatKr` (drop `… ISK` and `toLocaleString('en-US')`).

## 3. Reports comparison rule (`compareRange`)

`reports-workspace.js:1083` computed the comparison end with
`end.setUTCDate(start.getUTCDate() - 1)`, i.e. the *start's* day-of-month applied to the
*end's* month, so any period spanning two months got a wrong comparison window. The rule now:

1. A period that is exactly one whole calendar month compares with the whole previous
   calendar month (1–30 Sep → 1–31 Aug; 1–31 Mar → 1–28 Feb).
2. Any other period compares with the period of the same number of days ending the day
   before it starts (25 Aug–23 Sep, 30 days → 26 Jul–24 Aug).

Returned as `{ start, end, days, rule: 'previous_month'|'previous_period' }`.

## 4. Done in S88 (this change)

- [x] `brain.js` — `venueSchedule()` (hard-coded 11:30/22:00/00:00 via browser `setHours`)
  replaced by `serviceClock()` on `isOpenAt` / `nextEvent`; the countdown exists only with
  saved hours and ticks only while Brain is visible.
- [x] `brain.js` — `timelineEntries()` (hard-coded 11:00, 11:30, 15:00, 18:00, 22:00,
  24:00) removed; Home `#home-timeline` and Brain use `timeline()`; not set / unavailable /
  closed states as above.
- [x] `brain.js` — greeting hour (`getHours()`) → `parts().hour`; hero date
  (`toLocaleDateString`) → `formatDate(…, { long, year })`.
- [x] `settings-workspace.js` `mutate()` emits `settings:saved` so the clock refreshes.

## 5. Remaining browser call sites

Line numbers are as of this commit.

### Team A — Home · Operations · Settings · System

| Done | File:line | Current | Change to |
| --- | --- | --- | --- |
| [x] | `index.html:2131-2145` `formatVenueDay()` / `venueGreeting()` | literal zone; `getHours()` fallback | `formatDate(new Date(), { long: true })`; `parts().hour` |
| [x] | `brain.js:171` `readiness()` fallback | invents `opening: { complete: 0, total: 9 }` | `opening: null` (unknown) until the server checklist (contract §2) answers |
| [x] | `brain-daily-briefing-v2.js:39-45` `formatDateTime` | `getDate/getHours` (browser zone) | `formatDateTime` |
| [x] | `operations.js:51-54` `dateKey()` | browser-local Y-M-D | `today()` (removed with the localStorage checklist, contract §2) |
| [x] | `operations.js:317` date label | `toLocaleDateString` without zone | `formatDate(today(), { long: true })` |
| [x] | `operations.js:48` money | `… ISK` | `formatKr` |
| [x] | `operations-checkpoint-a.js:46-52` `formatDateTime` | `getDate/getHours` | `formatDateTime` |
| [x] | `settings-workspace.js:150-158` `formatDateTime` | literal zone | `formatDateTime` |
| [x] | `settings-workspace.js:437`, `:778` | "All times use Atlantic/Reykjavik" text | `timeZone()` (+ "default" when `timezoneIsDefault()`) |
| [x] | `settings-workspace.js:1133` preferences timezone default | literal zone | `timeZone()` |
| [x] | `settings-workspace.js:452-453`, `:1175-1176` **ratchet (4)** | new offer prefilled 15:00–18:00 | empty time fields (required) — hours come from the manager |
| [x] | `system-workspace.js:125-135`, `:145` | literal zone | `formatDateTime`, `timeZone()` |
| [x] | `system-workspace.js:150-165` `relativeTime` | own relative formatter | `formatRelative` |

S88 Team A: every row above is done. `formatVenueDay()`/`venueGreeting()` and `brain*.js`,
`operations-checkpoint-a.js` are deleted; Home (`home.js`) greets with `parts().hour` and dates with
`formatDate`; readiness keeps `opening: null` until the server checklist answers; Operations reads the
business date from the server checklist (no device checklist, no money formatting); Settings and
System health format through `AtlasVenueClock` (`formatDateTime`, `formatRelative`, `timeZone()`,
`timezoneIsDefault()`, `formatKr`), and a new offer starts with empty times. No Team A file contains a
literal zone or hour default (`tests/node/venue-hours-ratchet-s88.test.js`).

### Team B — Inventory · Purchasing · Stock count

| Done | File:line | Current | Change to |
| --- | --- | --- | --- |
| [ ] | `index.html:1641-1649` `timeAgo()` | own relative formatter ("5m ago", "3d ago") | `formatRelative` |
| [ ] | `index.html:1657`, `:1670` movements / waste date | `toLocaleString()` (browser zone + locale) | `formatDateTime` |
| [ ] | `index.html:2351-2358` `monthKey()` / `monthLabel()` | browser-local month, `toLocaleDateString(undefined…)` | `monthKey()`, `formatDate`/month label from `monthRange` |
| [ ] | `index.html:2403`, `:2509` `thisMonthKey` | `monthKey(new Date().toISOString())` | `monthKey(today())` |
| [ ] | `index.html:1761`, `:2407`, `:2425`, `:2445`, `:2539`, `:2558-2559` money | `toLocaleString()` / `is-IS … ISK` | `formatKr` |
| [ ] | `purchase-orders.js:22-23` overdue | `Date` vs `Date.now()` on `expected_delivery_at` | compare `expected_delivery_date` with `today()` (purchasing v2, contract §4) |
| [ ] | `stock-count-workspace.js:73-81` `formatDate` | literal zone | `formatDateTime` |
| [ ] | `item-master-workspace.js:59-66` `formatDate` | no `timeZone` (browser zone) | `formatDateTime` |
| [ ] | `inventory-scanner.js:55` number format | ad-hoc grouping | keep for quantities; money via `formatKr` |

### Team C — Recipes · Reports · Data · Marketing

| Done | File:line | Current | Change to |
| --- | --- | --- | --- |
| [x] | `reports-workspace.js:1076-1088` comparison period | **wrong across months** (see §3) | `compareRange({ start, end })` |
| [x] | `reports-workspace.js:92-104`, `:106-114`, `:121` | literal zone | `formatDateTime` / `formatDate` |
| [x] | `reports-workspace.js:891` | literal zone fallback | `snapshot.timezone \|\| timeZone()` |
| [x] | `reports-workspace.js:77` money | `… ISK` | `formatKr` |
| [x] | `business.js:56-62` `periodStart()` | browser-local midnight, `setHours/setDate` | `zonedToInstant(addDays(today(), 1 - n), '00:00')` |
| [x] | `business.js:223-247` `monthKey` / `monthLabel` / 6-month buckets | browser-local months | `monthKey()`, buckets from `monthRange` |
| [x] | `business.js:24`, `recipes.js:57`, `atlas-calculations.js:155` money | `… ISK` (`en-US` grouping) | `formatKr` (change `AtlasCalculations.formatIsk` to delegate, then drop the fallbacks) |
| [x] | `import-center.js:42-45` `formatDate` | `toLocaleString([])` | `formatDateTime` (display only; `:217-218` UTC storage path stays) |
| [x] | `sprint3-review.js:53-57` `formatDate` | `toLocaleString` without zone | `formatDateTime` |
| [x] | `marketing-workspace.js:83-99` `dateKey` / `currentMonthRange` / `shiftMonth` | browser-local `getDate` / `new Date(y, m, d)` | `monthRange`, `addDays` |
| [x] | `marketing-workspace.js:101-109` `formatDate` | no `timeZone` | `formatDate` / `formatDateTime` |
| [x] | `marketing-workspace.js:116-128` `toLocalInput` / `inputToIso` | browser offset — **stores wrong instants** for non-Iceland browsers | `localInputValue` / `fromLocalInput` |
| [x] | `marketing-workspace.js:130-135` `venueDate()` | duplicate (correct) with literal zone | `venueDate()` |
| [x] | `marketing-workspace.js:139` **ratchet (1)** | default suggested time `'12:00'` | leave the time empty when the recommendation has none |
| [x] | `marketing-workspace.js:382-397`, `:413` calendar grid | `getDay/setDate/getDate` browser-local | date keys via `startOfWeek`, `addDays`, `weekday` |

Team C notes (S88): Reports computes its period in the venue zone and asks for the
`compareRange` comparison (`preset=custom`, `comparison=custom`); `atlas-reports` accepts a
whole-previous-month comparison of a whole-month period. `business.js` is retired: its
figures are Reports › Overview (`reports-overview.js`, period from venue date keys).
`import-center.js` and `sprint3-review.js` are retired into `data-workspace.js` (venue
`formatDateTime` / `formatRelative`). `AtlasCalculations.formatIsk` delegates to
`AtlasFormat.money` when the clock is loaded. Marketing's ratchet row is removed (0).

### Team D — Shifts · Team · Messages · Knowledge

| Done | File:line | Current | Change to |
| --- | --- | --- | --- |
| [x] | `shifts-workspace.js:54-63` `venueDate()` | duplicate (correct), literal zone | `venueDate()` / `today()` — S88: the module keeps no zone of its own; `today()` delegates to `AtlasVenueClock.today()` |
| [x] | `shifts-workspace.js:98-106` `formatDateTime` | literal zone | `formatDateTime` — S88: timestamps go through `AtlasVenueClock.formatDateTime` / `formatRelative` |
| [x] | `shifts-workspace.js:468-469` **ratchet (2)** | new shift defaults `T11:30` – `T17:00` | S88: `defaultStart(date)` prefills the open time from `dayWindow(date)` when the day is open; otherwise the start is empty with "Business hours are not set — enter a start time." (or the closed-day note). The end is never invented. Ratchet ceiling removed. |
| [x] | `shifts-month-calendar.js:71-80` `venueDate()` | duplicate, literal zone | S88: file deleted — the month calendar is part of `shifts-workspace.js` |
| [x] | `shifts-month-calendar.js:456-457` **ratchet (2)** | same defaults as above | S88: file deleted; the one editor uses `defaultStart(date)` |
| [x] | `team-messages.js:85-97` `formatDateTime` | same-day check in browser zone, format without zone | S88: `venueDate(a) === venueDate(b)` → `formatTime`, else `formatDateTime`; day dividers use venue dates |
| [x] | `team-profiles.source.js:63-70`, `:72-79` (rebuild `.gz`) | no `timeZone`; date keys at local noon | S88: `formatDate` / `formatDateTime` / `formatRelative`; bundle rebuilt with `node scripts/build_team_profiles_bundle.mjs` |
| [x] | `knowledge-workspace.js:43-55`, `:57-64` | no `timeZone` | S88: `formatDateTime` / `formatDate` / `formatRelative` |

Not defects (kept): Shifts sends venue-local `YYYY-MM-DDTHH:MM` strings (`starts_local`,
`ends_local`; an end at or before the start is the next day) and the server converts them
with `shift_settings.timezone`. Date keys are plain `YYYY-MM-DD` strings moved with
`AtlasVenueClock.addDays` / `startOfWeek` / `weekday`, so no browser-zone arithmetic
remains in the module.

### Shell (E1) and Atlas AI (E6)

| Done | File:line | Current | Change to |
| --- | --- | --- | --- |
| [ ] | `atlas-search.js:16`, `:105-110` `venueDate(offset)` | duplicate (correct), literal zone | `today()` / `addDays(today(), n)` ("who works tomorrow" = `tomorrow()`) |
| [ ] | `atlas-search.js:317` week bounds | `toISOString().slice(0, 10)` | `startOfWeek`, `addDays` |
| [ ] | `atlas-chrome.js:505-513` `relativeTime` (notifications) | own relative formatter, no zone | `formatRelative` |
| [x] | `brain-phase3.js:40-46` `formatDateTime` (AI) | `getDate/getHours` | `formatDateTime` (file retired with the Brain page, S88 Team A; Atlas AI › Decisions owns these) |
| [x] | `brain-phase3.js:407-418` defer until (AI) | `new Date(datetimeLocal).toISOString()` — **stores wrong instant** | `fromLocalInput(value)` (and `localInputValue` when prefilling) (file retired with the Brain page, S88 Team A; Atlas AI › Decisions owns these) |

## 6. Server call sites (not browser; for reference)

Literal `'Atlantic/Reykjavik'` remains in SQL and Edge Functions
(`atlas_operations_checkpoint_a.sql`, `sprint4_daily_briefing.sql`, marketing migrations,
`atlas-reports/index.ts`, `atlas-marketing-workspace/index.ts`,
`atlas-team-messages/index.ts`). Each is migrated to `atlas_private.venue_date()` /
`venue_business_date()` when that function is next re-created; the value is identical today.
