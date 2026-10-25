# B0 Option A — 60-second staff inbox refresh: implementation and test requirements

**Status: implemented in the inbox-refresh follow-up branch; not deployed or activated.**
The owner requested completion of the booking release on 24 Oct 2026, with publication
only after a successful live end-to-end test. The refresh ships disabled (`0`), and
the master inbox flag stays off. Until activation, use the manual 10-minute check in
[`KANEL_Guest_Confirmation_SOP.md`](KANEL_Guest_Confirmation_SOP.md).

## Problem

Before this follow-up, `apps/web/assets/js/bookings-notifications.js` refreshed the manager inbox only on
events: sign-in, the tab becoming visible or focused, coming back `online`,
`atlas:bookings-changed`, or a push the service worker relays. Web-push delivery
(`ATLAS_PUSH_DELIVERY_ENABLED`) is off, so a manager with Alcedo open on one screen
never sees a new web request until one of those events happens. That doesn't meet the
10-minute review target against the 15-minute seat hold.

## Behaviour

While **all** of these hold, the worker refreshes the inbox every **60 s**:

1. `BOOKING_NOTIFICATIONS_ENABLED === true` (the existing master flag), **and**
2. the new flag `BOOKING_NOTIFICATIONS_REFRESH_SECONDS` is a whole number in
   **30–300**. It is unset or `0` by default, which means **off**. Planned value: `60`.
3. a user is signed in, their profile role is `manager` or `admin`, and the last
   inbox response was not 403;
4. the document is visible (`document.visibilityState === 'visible'`);
5. the device is online (`navigator.onLine !== false`).

When any condition stops holding, the timer stops. It restarts only when all of them
hold again. The existing event-driven refreshes stay exactly as they are.

## Implementation requirements

| # | Requirement |
|---|---|
| R1 | **Default OFF.** With either flag off, or the refresh value unset, `0` or out of range, no timer is ever created and the worker behaves byte-for-byte as today. `config.js` ships `BOOKING_NOTIFICATIONS_REFRESH_SECONDS: 0`. Enabling it is a separate config PR with the S42 re-pin. |
| R2 | **Authorization.** The timer starts only after the signed-in profile's role is known to be `manager` or `admin`. A bartender or viewer never creates a timer, so no request is made. A 403 from `?action=notifications` sets `forbidden` (as today) and stops the timer for the session. The server stays the authority: the RPCs re-check the actor. |
| R3 | **Stops when hidden.** On `visibilitychange` to hidden, `pagehide` or `offline`, clear the timer. On becoming visible or `online`: one immediate refresh (the existing handler), then the timer restarts. A hidden tab never makes a timed request. |
| R4 | **Stops on sign-out or user change.** On `SIGNED_OUT`, or when the user changes, clear the timer and the inbox (`clear()`), and abort any in-flight request. The timer restarts only after the R2 checks pass for the new user. |
| R5 | **One timer, one request.** Use a single self-rescheduling `setTimeout` (no `setInterval`), so a slow response can never queue overlapping ticks. A tick that finds `state.inFlight` skips. Event-driven and timed refreshes share the existing `inFlight` guard and `lastFetchAt` throttle, so a timed tick within the throttle window of another refresh sends nothing. Multiple tabs each refresh on their own, but only visible ones. |
| R6 | **Error backoff.** After a failed timed refresh (network error, timeout, 5xx, or 429), the next delay doubles: 60 → 120 → 240 → 300 s, capped at 300 s, plus ±10 % jitter. The first success resets it to the base interval. Errors are silent (no toast, no `console.error`); keep the existing `console.warn` path only for non-silent calls. A 401 triggers no renewal loop: the auth client handles the session, and the timer waits for the next successful refresh. |
| R7 | **Cost bound.** At most one request per visible manager tab per base interval, and at most 30 rows (`limit=30`). The edge already validates the limit. No new edge action or migration is needed. |
| R8 | **Cleanup.** All listeners and the timer are removed on `pagehide`. Nothing is left behind after sign-out. |
| R9 | **Comments and docs.** Update the worker header comment ("no polling loop") to describe the bounded, opt-in, visible-only refresh. Update the SOP to say the bell refreshes every minute while Alcedo is open and visible. |

## Test requirements (no test is weakened)

The follow-up adds `tests/node/bookings-notifications-refresh.test.js`: the real
worker runs in a VM with a controlled clock, auth, visibility, network responses,
and notification contributor. It covers timed delivery, invalid/default-off flags,
roles, 403, 401, hidden/offline tabs, sign-out during a request, stale data,
de-duplication, backoff, and complete page cleanup. Existing browser tests are
unchanged. These tests do not replace the live manager-bell gate below.

The node contract `tests/node/bookings-notifications-flag.test.js` currently asserts
`doesNotMatch(worker, /setInterval\s*\(/)`. **Keep that assertion.** R5 uses
`setTimeout`. Add stricter assertions alongside it: the timer is created only behind
the new flag check, and there is exactly one scheduling site.

Browser tests (`tests/browser/bookings-notifications.browser.test.mjs`) use a fake
clock or a 1 s test override via the existing harness `configOverrides`:

| # | Test |
|---|---|
| T1 | **Default OFF:** with `BOOKING_NOTIFICATIONS_ENABLED: true` and no refresh setting, advancing the clock 10 minutes makes **zero** extra inbox requests (only the existing event-driven ones). |
| T2 | **Master flag off:** with the refresh setting on but `BOOKING_NOTIFICATIONS_ENABLED: false`, there are zero requests and no timer. |
| T3 | **Manager, visible:** one inbox request per interval. A new server row appears in the bell and the unread count without any user action. |
| T4 | **Bartender / viewer:** zero inbox requests over 10 minutes. |
| T5 | **403:** after a 403, there are no further timed requests in that session. |
| T6 | **Hidden:** with the document hidden, zero timed requests. Becoming visible gives exactly one immediate request, then timed requests resume. |
| T7 | **Offline/online:** zero requests while offline; one on `online`, then the timer resumes. |
| T8 | **Sign-out:** after sign-out, zero requests and an empty bell. Signing in as a bartender gives zero requests. |
| T9 | **De-duplication:** a slow response (longer than the interval) keeps exactly one request in flight. A focus event and a timer tick within the throttle window make one request. |
| T10 | **Backoff:** three consecutive 503s space the requests at about 60 / 120 / 240 s (within jitter). A success resets to 60 s. Nothing reaches `console.error`. |
| T11 | **No regressions:** the existing bookings-notifications tests and the full browser suite pass, apart from the documented `ux-acceptance:69` release exception. |

## Rollout (each step needs approval)

1. Code PR implementing R1–R9 with T1–T11. It ships off.
2. Config PR: `BOOKING_NOTIFICATIONS_REFRESH_SECONDS: 60` plus the S42 re-pin. Requires
   A5–A7 to be done.
3. Check: a manager leaves Alcedo open, a test web request arrives, and it appears in
   the bell within about 60 s. This satisfies gate B0.
4. Rollback: set the value back to `0` (config PR), or revert.
