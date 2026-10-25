# KANEL booking release — verified resume state, 24 Oct 2026

User instruction: complete the release from PR #135, verify the staff inbox, and
publish the KANEL website only after a successful end-to-end test. This authorizes
the release work; earlier preparation-only approval wording is historical.
The live functional gates remain required. No guest messages are authorized.

## Verified source and CI

- PR #135 is open, draft and unmerged. Head:
  `1f24ba345f6b4e34ffb12b631894fe6700f82d22`.
- `main` is `e14ccf63d907a36e85583d3987efa0b5cbd56caf`.
- GitHub `Atlas verification` run `40095672699`: success.
- GitHub `Migration replay` run `40095672719`: success.
- `Production adoption dry run` `40095672785`: failure. The existing PR evidence
  attributes this job's inventory lint failure to main; do not call it green.

## Verified production (read-only)

The older handoff is stale: S110 is already applied, and `atlas-public-booking`
version 1 is ACTIVE with JWT gateway verification off. `atlas-bookings` is version 2.
No migration or edge deployment was performed in this continuation.

All four S110 function bodies match PR #135 at the exact head above:

| Function | Production and source `md5(prosrc)` |
|---|---|
| `booking_check_seat_group` | `a35b35a008b9d92497d44102619cc4d4` |
| `booking_table_json` | `eb9f653e0ca60e3d85c75ab79e4a9966` |
| `atlas_bookings_create` | `57db162e80ccc354095001218803067d` |
| `atlas_bookings_assign` | `f756ad1a4616500e9a58111236272f63` |

Each retains `{postgres=X/postgres,service_role=X/postgres}` and an empty
search path. Settings: online cap 4, turnaround 15 minutes, duration 120 minutes,
15-minute intervals, advance window 90 days, `auto_confirm=false`,
`public_online_enabled=false`. Counts: zero web requests, zero booking inbox rows,
zero email outbox rows. Edge secrets have not been inspected or changed.

## Inbox refresh follow-up

The planned Option A was absent from PR #135. It is implemented in
`codex/kanel-inbox-refresh-release`, based on that PR head, with:

- Single self-rescheduling timeout, manager/admin profile and session identity
  gating, visible/online only; interval accepts integer seconds 30–300.
- No overlapping requests; sign-out aborts requests and discards late responses.
- 403 stops the session's inbox work; 401 suspends timed work until recovery.
- Silent error backoff, capped at 300 seconds with jitter; full listener cleanup.
- `BOOKING_NOTIFICATIONS_REFRESH_SECONDS: 0` and master flag still false.
  S42 config checksum updated. No production activation.

Local checks: 11 new worker behavior tests and all 4 existing flag tests pass;
full Node suite: 1,639 passed, 42 skipped, zero failed. The 10 release-tooling
Python tests pass. These are local checks, not a live end-to-end result.
The 18 S108/S109 Python notification contracts also pass.

The implementation is committed locally as `22418e8`. Automatic approval review
rejected the attempted push to
`imadelmoubarik4-cell/-V-OS-:codex/kanel-inbox-refresh-release`, stating that the
release goal did not explicitly authorize export to that destination/new remote
branch. A read-only `git ls-remote --heads` returned no matching remote branch.
No follow-up PR was created. Obtain explicit approval for this exact push and
follow-up PR before retrying; do not use a connector to bypass the rejection.

## Current blockers and continuation order

1. The live Alcedo browser has no signed-in session. One secure sign-in attempt
   was rejected with **Email or password is incorrect**. Do not reset credentials
   or create/impersonate an account to bypass this. Continue with secure/manual
   sign-in, then A4a on the live staff UI.
2. Netlify `kanelbar` also requires sign-in. No Netlify plugin was found. The
   existing Netlify host must be retained; do not create a replacement Site.
3. Integrate the inbox follow-up, refresh exact-head CI, merge #135 only after
   A4a; verify the staff deployment and mandatory A4b multi-stool gate.
4. Deploy the current staff edge, then configure the inbox master flag and
   60-second refresh in a separate tracked config change with S42 re-pin.
5. Complete the runbook's hours, public secrets/config, guest-contact and privacy
   readiness; enable the API for controlled testing while the website stays off.
6. From the unpublished EN/IS website candidate, create a clearly labelled test
   request, see it appear automatically in the manager bell, open it, assign
   valid stools, verify reference/status/read state, and cancel all test bookings.
   Also verify 4-guest cap, sections, timing/buffer, retries and unavailable slots.
7. Only after that live test passes, publish the exact tested website to Netlify
   `kanelbar` and verify the live booking routes. Leave emails off.

No merge, new production write, test reservation, guest email, public activation
or website publication was performed in this continuation.
