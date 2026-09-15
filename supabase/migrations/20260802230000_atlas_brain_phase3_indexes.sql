-- Sprint 4 Phase 3 - covering indexes for memory relationship lookups.
-- Public-safe performance contract only. Contains no VÁ operational rows.

create index if not exists brain_recommendations_supersedes_idx
  on atlas_private.brain_recommendations(supersedes_id)
  where supersedes_id is not null;

create index if not exists brain_outcomes_decision_idx
  on atlas_private.brain_outcomes(decision_id)
  where decision_id is not null;
