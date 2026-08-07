# Phase 4 Interface Replacement — acceptance record

## Status

Implementation started on `agent/phase4-interface-replacement`, based on the stable Phase 2 branch.

This record does not authorize merge, production migration or release.

## Reason for the reset

The earlier Phase 4 overlay loaded a second presentation layer over the legacy application. Browser acceptance showed two login experiences alternating during startup and a spinner that remained for more than two minutes. That implementation strategy is retired.

## Replacement foundation

The new `/next.html` route has one static presentation tree and does not load the old application or Phase 4 overlay.

It currently provides:

- one bounded boot screen;
- one production Supabase login and session-recovery path;
- active-profile verification through `public.profiles`;
- real, role-permitted inventory reads;
- read-only quantity presentation;
- Claude-style responsive navigation, command palette, theme and Service Mode shell;
- visible placeholders for workflows awaiting direct gateway connection.

## Safety boundary

- no database migration;
- no RLS, role or grant change;
- no service-role credential;
- no operational insert, update, upsert or delete;
- no stock-adjustment RPC;
- no count publication;
- no supplier submission;
- no social publication;
- no POS ingestion;
- no production synchronization.

## Remaining first-unit acceptance

1. Browser JavaScript syntax.
2. Focused Node and Python contracts.
3. Complete repository suites and migration replay.
4. Exact Netlify Deploy Preview for the new draft PR.
5. One-login and bounded-startup acceptance.
6. Administrator, manager, bartender, viewer and inactive-profile acceptance.
7. 390 px, 768 px, 1024 px and 1440 px review.
8. Production fingerprint confirmation.

The accepted route may replace `/index.html` only after these checks and after L1, scanner and L2 gateway connections are restored in the new interface.
