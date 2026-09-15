-- Cover Knowledge foreign-key paths used by article/version lookup and audit history.

create index if not exists knowledge_articles_current_version_idx
  on atlas_private.knowledge_articles(current_version_id)
  where current_version_id is not null;

create index if not exists knowledge_articles_draft_version_idx
  on atlas_private.knowledge_articles(draft_version_id)
  where draft_version_id is not null;

create index if not exists knowledge_events_source_idx
  on atlas_private.knowledge_events(source_id,created_at desc)
  where source_id is not null;

create index if not exists knowledge_events_version_idx
  on atlas_private.knowledge_events(version_id,created_at desc)
  where version_id is not null;

create index if not exists knowledge_reads_article_idx
  on atlas_private.knowledge_reads(article_id,last_read_at desc);
