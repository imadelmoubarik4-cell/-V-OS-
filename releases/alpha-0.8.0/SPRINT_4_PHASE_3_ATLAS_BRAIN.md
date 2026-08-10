# Sprint 4 — Atlas Brain Phase 3

Phase 3 turns Atlas from a source-aware briefing into a learning operational system for VÁ.

## Destination

Atlas should:

- learn from VÁ decisions and outcomes;
- remember previous manager decisions;
- predict shortages when live evidence is sufficient;
- recommend purchases in shadow mode before any action is allowed;
- recommend menu changes from verified sales, margin, complexity and waste evidence;
- identify waste and unexplained variance as investigation signals;
- explain every recommendation with confidence, sources, evidence, alternatives and limitations.

## Implemented checkpoint — Decision Memory

The first Phase 3 vertical slice is now implemented on the isolated branch.

1. Atlas creates deterministic, versioned shadow recommendations.
2. Every recommendation stores its evidence, source attribution, confidence, alternatives, limitations and consequence of inaction.
3. A manager can accept, reject, modify, defer or reset a recommendation.
4. Every decision carries a reason, notes, actor and idempotency key.
5. Atlas records outcomes with an observed result, status and optional success score.
6. Recommendation detail retrieves prior decisions and outcomes for the same subject.
7. Significant Real VÁ Data review transitions are surfaced as decision memory.
8. Repeated no-op review clicks remain in the source audit history but are filtered out of Brain memory.

The memory loop never mutates current stock, purchase orders, recipes, menu prices or any other operational table.

## Current private checkpoint

The Phase 3 branch contains the copied Real VÁ Data graph:

- 34 import batches;
- 357 inventory candidates;
- 747 recipe, menu, supplier, invoice, purchase, delivery and equipment records;
- 1,087 issue-level review records;
- 10 source-review audit events, representing one meaningful state transition and repeated no-op clicks;
- 13 active deterministic shadow recommendations;
- one meaningful decision-memory event;
- zero persisted Phase 3 recommendation decisions;
- zero persisted Phase 3 outcomes.

The transfer was verified with matching source and target row counts and digests. Temporary transfer RPCs, tokens, HTTP response rows and `pg_net` were removed after verification.

## Capability gates

Phase 3 exposes all intended capabilities, but each capability has an explicit evidence gate:

- **Decision memory:** enabled and verified.
- **Recommendation explanations:** enabled and verified.
- **Shortage prediction:** blocked until current stock, product-level sales history, confirmed incoming deliveries and supplier lead times are verified.
- **Purchase recommendations:** blocked until current stock, sales, deliveries, lead times and supplier package/cost/contract constraints are verified.
- **Menu recommendations:** blocked until product-level sales, complete recipe costs and current menu prices are verified.
- **Waste identification:** blocked until trusted stock movements, frequent stock counts and waste/expiry events are connected.

Blocked capabilities return verified explanations of what is missing. They do not invent an operational recommendation.

## Manager API

The `atlas-phase3-brain` Edge Function:

1. receives the normal production VÁ access token;
2. verifies the token against production Auth;
3. reads the server-controlled Atlas profile;
4. requires an active `manager` or `admin` role;
5. calls service-role-only Phase 3 RPCs inside the isolated branch;
6. exposes snapshot, recommendation detail, memory search, decision, outcome and refresh actions;
7. validates UUIDs, decision values, dates, body size and outcome scores;
8. uses client request IDs so decision and outcome submissions are idempotent.

An unauthenticated request returns HTTP 401.

## Atlas interface

The original Atlas visual system is preserved. Phase 3 appears below the Daily Briefing and provides:

- shadow-recommendation cards;
- confidence badges;
- capability-gate cards and explicit blockers;
- a Decision Memory timeline;
- a full “Why?” evidence dialog;
- alternatives, limitations and consequence-of-inaction sections;
- manager decision forms;
- outcome feedback forms;
- desktop, tablet and mobile layouts;
- reduced-motion support.

## Trust contract

- Shadow mode only: no automatic order, menu change or production mutation.
- Every recommendation has a stable fingerprint and version.
- Decisions and outcomes use idempotency keys.
- Every recommendation includes confidence state, score and explanation.
- Every recommendation names its evidence sources.
- Historical inventory never drives a live shortage or purchase recommendation by itself.
- Pending source rows remain review work, not operational facts.
- Manager decisions and outcomes are auditable memory events.
- Production remains unchanged during development.

## Validation

- Supabase preview database: `ACTIVE_HEALTHY`;
- workflow stage: `FUNCTIONS_DEPLOYED`;
- 17 migration versions through `20260802230000_atlas_brain_phase3_indexes`;
- `atlas-phase3-brain` Edge Function active;
- security advisor: no findings;
- Phase 3 relationship indexes cover its foreign keys;
- unauthenticated API request: HTTP 401;
- synthetic decision, idempotency, outcome and detail tests passed;
- synthetic test recommendation and all cascaded memory rows removed after testing;
- final Phase 3 decision and outcome counts returned to zero;
- 33 Node contract tests passed;
- 38 Python tests passed, with four private-source integration tests skipped because source files are intentionally absent from GitHub;
- production unchanged.

## Remaining checkpoint gate

The implementation now requires an authenticated browser review on a Netlify Deploy Preview. Confirm:

- Phase 3 loads under Atlas Brain;
- shadow recommendations and capability blockers are readable;
- “Why?” displays evidence, alternatives and limitations;
- accept, reject, modify, defer and reset operate on a reversible test recommendation;
- an outcome can be recorded and retrieved through Decision Memory;
- no operational record is changed;
- responsive desktop, tablet and mobile layouts remain usable.

Shortage prediction, purchase recommendations, menu recommendations and waste identification remain disabled until their live evidence streams are connected and verified.
