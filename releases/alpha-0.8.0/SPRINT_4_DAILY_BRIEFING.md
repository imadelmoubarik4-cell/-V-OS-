# Sprint 4 - Atlas Brain: Daily Briefing Phase 1

Atlas Brain begins with one truthful management briefing, not unrestricted AI chat.

## Phase 1 outcome

The Daily Atlas Briefing now provides:

- a manager-authenticated private API;
- deterministic priority ordering;
- confidence state, score, and explanation for every signal;
- explicit source attribution;
- evidence values rendered as responsive cards;
- domain-level review readiness;
- active limitations and safety guardrails;
- no automatic purchases, production mutations, forecasts, or canonical promotion.

## Branch synchronization

The Sprint 4 branch was synchronized exactly with the repaired Sprint 3 branch before Phase 1 work began. It is zero commits behind Sprint 3.

The full private checkpoint was then copied server-to-server into the Sprint 4 Supabase branch and verified with matching counts and digests:

- 34 import batches;
- 357 inventory rows;
- 747 non-inventory rows;
- 1,087 issue-level review rows;
- 1,104 unified review-queue rows;
- zero review decisions.

Temporary transfer RPCs, transfer endpoints, and the temporary `pg_net` extension were retired after verification.

## Daily Briefing API

The service-role-only database function `public.atlas_sprint4_daily_briefing()` reads the private review graph and returns aggregates only.

The `atlas-sprint4-briefing` Edge Function:

1. receives the normal production VÁ access token;
2. verifies it against production Auth;
3. reads the caller's server-controlled profile;
4. permits only active `manager` and `admin` roles;
5. calls the Sprint 4 branch briefing RPC internally;
6. returns the deterministic briefing without exposing service credentials or private rows.

An unauthenticated request returns HTTP 401.

## Confidence contract

Each signal and domain includes:

- `state`: `verified`, `reviewed`, `pending`, or `historical`;
- `score`: a value from 0 to 1;
- `reason`: a plain-language explanation of why the score applies.

Current examples:

- review-queue totals: verified, score 1.00;
- unresolved source mappings: pending, score 0.45;
- July inventory snapshot: historical, score 0.65.

## Source attribution

Every private briefing signal names its source contract, such as:

- `atlas_private.import_batches`;
- `atlas_private.review_queue`;
- `atlas_private.data_coverage`;
- `atlas_private.review_summary`;
- `atlas_private.import_inventory_rows` for dated historical evidence.

The interface never receives invoice documents, line-level supplier costs, private source rows, or service-role credentials.

## Evidence cards

Atlas Brain displays:

- data maturity;
- pending review volume;
- source-file coverage;
- open issue count;
- evidence-backed priority cards;
- source cards;
- confidence badges;
- domain-readiness progress;
- explicit statements describing what Atlas will not assume.

The renderer uses manual Icelandic number grouping and pauses its mutation observer during its own updates to prevent render loops.

## Verified current briefing

The private branch currently reports:

- 1,104 staged records awaiting review;
- 328 records missing a supplier;
- 324 records missing a cost;
- 210 package-size or unit gaps;
- 220 historical inventory rows dated 19-26 July 2026;
- forecasting disabled;
- trusted margin recommendations disabled;
- canonical promotion disabled;
- automatic ordering disabled.

These are review-readiness signals, not claims about current live stock.

## Security and migration state

- Sprint 4 Supabase branch: `ACTIVE_HEALTHY`;
- workflow stage: `FUNCTIONS_DEPLOYED`;
- migration history: 12 versions, including `20260802192300_sprint4_daily_briefing`;
- security advisor: no findings;
- production: unchanged.

## Remaining acceptance gate

Phase 1 still requires a browser preview while signed in with an active VÁ manager account. That review should confirm the responsive layout, authenticated API call, evidence-card readability, navigation into Real VÁ Data Review, and refresh behaviour.

Generative AI, demand forecasting, automatic ordering, and canonical promotion remain outside Phase 1.
