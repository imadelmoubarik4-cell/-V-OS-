-- Cover the remaining Marketing foreign keys used by history and
-- recommendation lookups. These are intentionally partial where null is the
-- common case.

create index if not exists marketing_recommendations_converted_content_idx
  on atlas_private.marketing_recommendations(converted_content_id)
  where converted_content_id is not null;

create index if not exists marketing_events_campaign_idx
  on atlas_private.marketing_workspace_events(campaign_id,created_at desc)
  where campaign_id is not null;

create index if not exists marketing_events_recommendation_idx
  on atlas_private.marketing_workspace_events(recommendation_id,created_at desc)
  where recommendation_id is not null;
