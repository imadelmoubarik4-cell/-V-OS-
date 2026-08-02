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

## First vertical slice — Decision Memory

The first Phase 3 checkpoint is a complete memory-and-feedback loop:

1. Atlas creates a deterministic shadow recommendation.
2. Every recommendation stores its evidence, source attribution, confidence and limitations.
3. A manager can accept, reject, modify or defer it.
4. Atlas records the decision, reason and actor without mutating operational records.
5. An outcome can later be attached to measure whether the recommendation was useful.
6. Future recommendations can retrieve relevant previous decisions and outcomes.

This is the foundation for learning. Atlas must not silently change assumptions or claim learning without an auditable decision/outcome trail.

## Capability gates

Phase 3 exposes all intended capabilities, but each capability has an evidence gate:

- **Decision memory:** enabled once the private Phase 3 schema is deployed.
- **Recommendation explanations:** enabled for deterministic shadow recommendations.
- **Shortage prediction:** blocked until current stock, sales history, confirmed incoming deliveries and supplier lead time are connected.
- **Purchase recommendations:** blocked until shortage prediction and supplier package/cost constraints are trustworthy.
- **Menu recommendations:** blocked until product-level sales, complete recipe costs and menu prices are verified.
- **Waste identification:** blocked until stock movements, stock counts and waste/expiry events are connected.

Blocked capabilities must return explicit reasons rather than invented recommendations.

## Trust contract

- Shadow mode only: no automatic order, menu change or production mutation.
- Every recommendation has a stable fingerprint and is idempotent.
- Every recommendation includes confidence state, score and explanation.
- Every recommendation names its evidence sources.
- Historical inventory never drives a live shortage or purchase recommendation by itself.
- Pending Sprint 3 rows remain review work, not operational facts.
- Manager decisions and outcome records are immutable audit events.
- Production remains unchanged during development.

## Initial Phase 3 modules

- `brain_recommendations`: versioned shadow recommendations.
- `brain_recommendation_evidence`: normalized evidence links and supporting values.
- `brain_decisions`: accept, reject, modify, defer and reset events.
- `brain_outcomes`: observed results and recommendation accuracy.
- `brain_capability_gates`: current readiness and blockers for forecast, purchasing, menu and waste intelligence.
- Manager-authenticated Phase 3 API.
- Atlas Brain panels for Decision Memory, Shadow Recommendations and capability readiness.

## Exit condition for the first checkpoint

The first Phase 3 checkpoint is complete when an active VÁ manager can:

- view deterministic shadow recommendations;
- inspect the full “Why?” evidence chain;
- see relevant previous decisions;
- accept, reject, modify or defer a recommendation;
- record an outcome;
- verify that Atlas recalls that decision in a subsequent snapshot;
- confirm that no operational table was mutated.
