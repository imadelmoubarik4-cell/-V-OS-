-- Phase 2 performance hardening.
--
-- Add the lookup indexes required by the new P2.2 and Checkpoint M foreign-key
-- relationships. These indexes do not change connection state, mappings, source
-- evidence, production rows or any external side effect.

create index if not exists knowledge_sources_connection_key_idx
  on atlas_private.knowledge_sources(connection_key)
  where connection_key is not null;

create index if not exists pos_mapping_settings_provider_idx
  on atlas_private.pos_mapping_settings(provider_key);

create index if not exists pos_import_runs_provider_idx
  on atlas_private.pos_import_runs(provider_key,created_at desc);

create index if not exists pos_products_provider_idx
  on atlas_private.pos_products(provider_key,active,name);

create index if not exists pos_mapping_events_run_idx
  on atlas_private.pos_mapping_events(run_id,created_at desc)
  where run_id is not null;

create index if not exists pos_mapping_events_target_idx
  on atlas_private.pos_mapping_events(target_id,created_at desc)
  where target_id is not null;
