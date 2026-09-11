# Atlas S34 launch-fix checklist

Status: **Git-only / not applied**

Source: `Atlas Pre-Integration and Launch Fix Reference.pdf` (15 pages)

Base: `b8a046f137f0daec9d519f4798b61727ee1d8122`

This checklist maps every page of the supplied launch-fix reference to the S34
candidate. The source PDF remains outside Git because its screenshots contain a
real staff name. `tests/fixtures/s34-visual-review.html` is the deterministic,
synthetic after-state review surface for desktop and 390 px mobile layouts. It
does not connect to Auth, Storage, a database, an Edge Function, or a hosted URL.

## Page-by-page mapping

| Page | Reference request | S34 implementation | Regression evidence |
| ---: | --- | --- | --- |
| 1 | Repair Home layout and robot treatment; add restrained daily-banner attention; hover on floating cards. | Shared S34 action, card, focus, shadow and motion layer; restrained `#home-focus::after` animation with reduced-motion override. | `s34-preproduction.test.js`: shared launch design; visual fixture `home`. |
| 2 | Correct Operations routine-card blue marker; replace black actions; card hover. | Shared Atlas blue action token and card/focus states apply to the Operations shell and routine cards without changing informational dark surfaces. | Shared design test; visual fixture `operations`. |
| 3 | Add wine subcategories; align scanner design; repair scanner close and quantity behavior. | Inventory now prefers the stored `subcategory`, quantity saves await `loadAll()` refetch, and the existing scanner close hook remains under regression coverage. | S34 inventory/close test; visual fixture `inventory`. |
| 4 | Align Stock Count styling; repair close and count controls; lighten actions and add hover. | Shared action layer applies Atlas blue and focus states; existing workspace close and quantity hooks are protected by contract tests. | S34 inventory/close test; visual fixture `stock`. |
| 5 | Repair current-count area and card interaction. | Shared card radius, shadow, hover, focus and spacing contract applies to current-count surfaces. | Shared design test; visual fixture `stock`. |
| 6 | Align Recipes layout; compact Apple-style search; card hover. | Shared compact search and card rules; recipes load the shared calculator before module logic. | Shared design and calculation-delegation tests; visual fixture `recipes`. |
| 7 | Align recipe editor/detail; replace black actions; reduce nonessential panels; fix spacing. | Shared blue primary actions, modal geometry and responsive spacing; recipe economics delegate to one calculator. | Shared design and cross-view calculation tests; visual fixture `recipes`. |
| 8 | Compact Purchasing search; make Orders and Deliveries work; improve Messages spacing, scroll and starring. | Both purchasing controls call `openSection`; delivery list and receive path are available; Team Messages has a bounded message region, persistent star action and visible composer. | Updated design-consistency test; S34 purchasing/star tests; visual fixtures `purchasing` and `messages`. |
| 9 | Apply chat fixes everywhere; align icons; add browser/mobile notifications. | Shared channel render covers every conversation; star state comes from the private gateway; explicit notification states and service-worker deep links target Team/Shifts only. | Notification, star and deep-link tests; visual fixtures `messages` and `team`. |
| 10 | Repair Shifts spacing and weekly/monthly visual consistency. | Shared responsive actions/cards plus existing month styles; week/month publishing now queues only disabled-by-default scoped events. | Shift enqueue scope test; visual fixture `shifts`. |
| 11 | Align Knowledge list/editor design. | Shared search, modal, card, blue action and focus contracts apply while the existing close hook stays tested. | Close-control and shared-design tests; visual fixture `knowledge`. |
| 12 | Complete Knowledge polish and remove black primary actions. | S34 last-loaded stylesheet replaces black primary actions while leaving destructive actions distinct. | Shared-design test; visual fixture `knowledge`. |
| 13 | Reorganize Atlas Brain content. | Brain and Business Intelligence delegate economics to the same source; visual contract groups priority, insight, action and history. | Cross-view delegation and deterministic calculation tests; visual fixture `brain`. |
| 14 | Polish Atlas Brain spacing and hierarchy. | Shared card/spacing/focus treatment and single financial formatter reduce dense, conflicting presentation. | Shared-design and calculation tests; visual fixture `brain`. |
| 15 | Bring Settings to the shared Atlas standard. | Settings renders explicit notification unsupported/denied/pending/enabled states and uses the shared action, input, card and feedback contract. | Notification-state test; visual fixture `settings`. |

## Module coverage matrix

| Module | Desktop contract | Mobile contract | Interaction/calculation gate |
| --- | --- | --- | --- |
| Home | `?module=home&mode=desktop` | `?module=home&mode=mobile` | Shared visual contract |
| Operations | `?module=operations&mode=desktop` | `?module=operations&mode=mobile` | Shared visual contract |
| Inventory | `?module=inventory&mode=desktop` | `?module=inventory&mode=mobile` | Save/refetch and close controls |
| Stock Count | `?module=stock&mode=desktop` | `?module=stock&mode=mobile` | Count and close controls |
| Recipes | `?module=recipes&mode=desktop` | `?module=recipes&mode=mobile` | 200 ISK cost, 500 ISK price, 60% margin, 5 servings |
| Purchasing | `?module=purchasing&mode=desktop` | `?module=purchasing&mode=mobile` | Orders and Deliveries handlers |
| Messages | `?module=messages&mode=desktop` | `?module=messages&mode=mobile` | Internal scroll, composer, persistent star |
| Team | `?module=team&mode=desktop` | `?module=team&mode=mobile` | Immutable role-authorized loader manifest |
| Shifts | `?module=shifts&mode=desktop` | `?module=shifts&mode=mobile` | Week/month layout and scoped queue event |
| Knowledge | `?module=knowledge&mode=desktop` | `?module=knowledge&mode=mobile` | Close, search and action contract |
| Atlas Brain | `?module=brain&mode=desktop` | `?module=brain&mode=mobile` | Shared cross-view economics |
| Settings | `?module=settings&mode=desktop` | `?module=settings&mode=mobile` | Notification state and opt-in flow |

## Visual evidence boundary

The 15-page source is fully mapped above, but its screenshots are intentionally
not committed because page 1 contains a real staff name. The source PDF remains
the before-state reference outside Git. `.github/workflows/s34-visual-evidence.yml`
uses pinned headless Chromium to capture the deterministic synthetic fixture with
all non-file requests blocked. Its review artifact contains 24 after-state PNGs,
an HTML gallery and a SHA-256 manifest: every matrix row at 1440 x 900 and
390 x 844. This evidence job does not connect to or authorize a hosted preview,
staging environment, SQL runner, function deployment, endpoint, or production.
