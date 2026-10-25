# KANEL inbox activation — 25 Oct 2026

PR #135 was merged as `38eea04`. The staff test was reported passed by the owner.
The staff `atlas-bookings` edge was deployed from that merged source as version 3;
no migration was applied in this continuation. The public booking endpoint remains
independently gated, and kanel.is still serves the preview booking form.

PR #136 adds the bounded inbox refresh and was merged as `b6e6d25`. Its checks:

| Check | Result |
|---|---|
| contracts | pass |
| migration replay | pass |
| synthetic visual evidence | pass |
| browser | 451 pass, 3 fail, 1 skip; all booking/inbox tests pass |

The full browser failures were `atlas-bot:520` (canvas resize timeout; newly
observed, not established as baseline), `atlas-bot:690` (previously documented
instability), and `ux-acceptance:69` (documented header release exception). These
failures are retained as unresolved app-suite results; the suite is not green.
No test was weakened, skipped or retried to obtain a pass. The inbox code shipped
with both flags off, and no website publication followed from this merge.

This follow-up explicitly enables the manager/admin inbox and its 60-second
visible/online refresh, after the staff edge deployment. It leaves
`PUBLIC_BOOKING_ENABLED: false` in the staff app; that setting does not control
the website's public endpoint.

The flag contract now asserts the intended production state (inbox on, refresh 60,
staff-app guest flag off). Mocked browser tests explicitly isolate background
inbox work by default, and inbox tests opt in. A new real-shell browser test
advances controlled timers and requires a newly queued request to appear in the
notification bell without user interaction. All existing disabled-state
assertions remain in place, as do the worker VM tests for absent/invalid flags,
roles, stale auth, hidden/offline tabs, backoff, de-duplication and cleanup.

The final live website-to-Alcedo test and website publication are still pending.
