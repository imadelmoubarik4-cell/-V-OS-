-- Checkpoint G — Knowledge
-- Private, role-aware, versioned staff guidance. Source documents and source
-- URLs are deliberately not seeded in this public repository migration.

create table if not exists atlas_private.knowledge_settings (
  setting_key text primary key,
  google_drive_connection_status text not null default 'not_connected'
    check (google_drive_connection_status in ('not_connected','waiting_authorization','connected','degraded','expired')),
  automatic_drive_sync_enabled boolean not null default false,
  browser_notifications_enabled boolean not null default false,
  staff_source_urls_visible boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.knowledge_categories (
  id uuid primary key default gen_random_uuid(),
  category_key text not null unique,
  name text not null,
  description text,
  icon text not null default 'book-open',
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (category_key ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  check (char_length(name) between 1 and 100),
  check (description is null or char_length(description)<=1000)
);

create table if not exists atlas_private.knowledge_articles (
  id uuid primary key default gen_random_uuid(),
  article_key text not null unique,
  category_id uuid not null references atlas_private.knowledge_categories(id) on delete restrict,
  article_type text not null default 'reference'
    check (article_type in ('policy','sop','checklist','training','reference','live_resource')),
  status text not null default 'draft'
    check (status in ('draft','published','retired')),
  required boolean not null default false,
  target_roles text[] not null default array['all']::text[],
  live_route text,
  current_version integer not null default 0,
  current_version_id uuid,
  draft_version_id uuid,
  created_by uuid,
  created_by_label text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (article_key ~ '^[a-z0-9][a-z0-9-]{1,119}$'),
  check (cardinality(target_roles)>0),
  check (target_roles <@ array['all','admin','manager','bartender','viewer']::text[]),
  check (live_route is null or char_length(live_route)<=160),
  check (current_version>=0)
);

create table if not exists atlas_private.knowledge_article_versions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  version_number integer not null check (version_number>0),
  state text not null default 'draft' check (state in ('draft','published','superseded')),
  title text not null,
  summary text,
  content text not null,
  content_format text not null default 'markdown' check (content_format in ('markdown','plain_text')),
  change_note text,
  created_by uuid,
  created_by_label text,
  published_at timestamptz,
  published_by uuid,
  published_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (article_id,version_number),
  check (char_length(title) between 1 and 220),
  check (summary is null or char_length(summary)<=3000),
  check (char_length(content) between 1 and 250000),
  check (change_note is null or char_length(change_note)<=3000),
  check ((state='published' and published_at is not null) or state<>'published')
);

alter table atlas_private.knowledge_articles
  drop constraint if exists knowledge_articles_current_version_id_fkey;
alter table atlas_private.knowledge_articles
  add constraint knowledge_articles_current_version_id_fkey
  foreign key (current_version_id) references atlas_private.knowledge_article_versions(id) on delete set null;
alter table atlas_private.knowledge_articles
  drop constraint if exists knowledge_articles_draft_version_id_fkey;
alter table atlas_private.knowledge_articles
  add constraint knowledge_articles_draft_version_id_fkey
  foreign key (draft_version_id) references atlas_private.knowledge_article_versions(id) on delete set null;

create unique index if not exists knowledge_one_draft_per_article_uidx
  on atlas_private.knowledge_article_versions(article_id) where state='draft';
create unique index if not exists knowledge_one_current_published_uidx
  on atlas_private.knowledge_article_versions(article_id) where state='published';
create index if not exists knowledge_articles_category_status_idx
  on atlas_private.knowledge_articles(category_id,status,required);
create index if not exists knowledge_versions_article_state_idx
  on atlas_private.knowledge_article_versions(article_id,state,version_number desc);

create table if not exists atlas_private.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  source_type text not null
    check (source_type in ('google_drive','atlas_module','sprint3_import','manual','external')),
  source_label text not null,
  source_reference text,
  source_url text,
  source_version text,
  connection_status text not null default 'manual_reference'
    check (connection_status in ('manual_reference','not_connected','current','stale','error')),
  visible_to_staff boolean not null default false,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(source_label) between 1 and 220),
  check (source_reference is null or char_length(source_reference)<=1000),
  check (source_url is null or char_length(source_url)<=3000),
  check (jsonb_typeof(metadata)='object')
);
create index if not exists knowledge_sources_article_idx
  on atlas_private.knowledge_sources(article_id,source_type,updated_at desc);

create table if not exists atlas_private.knowledge_task_links (
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  onboarding_task_id uuid not null,
  required_for_task boolean not null default true,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  primary key (article_id,onboarding_task_id)
);
create index if not exists knowledge_task_links_task_idx
  on atlas_private.knowledge_task_links(onboarding_task_id,article_id);

create table if not exists atlas_private.knowledge_reads (
  version_id uuid not null references atlas_private.knowledge_article_versions(id) on delete cascade,
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  user_id uuid not null,
  user_label text not null,
  first_read_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  read_count integer not null default 1 check (read_count>0),
  primary key (version_id,user_id)
);
create index if not exists knowledge_reads_user_idx
  on atlas_private.knowledge_reads(user_id,last_read_at desc);

create table if not exists atlas_private.knowledge_acknowledgements (
  version_id uuid not null references atlas_private.knowledge_article_versions(id) on delete cascade,
  article_id uuid not null references atlas_private.knowledge_articles(id) on delete cascade,
  user_id uuid not null,
  user_label text not null,
  user_role text not null,
  acknowledged_at timestamptz not null default now(),
  primary key (version_id,user_id)
);
create index if not exists knowledge_acknowledgements_user_idx
  on atlas_private.knowledge_acknowledgements(user_id,acknowledged_at desc);
create index if not exists knowledge_acknowledgements_article_idx
  on atlas_private.knowledge_acknowledgements(article_id,version_id);

create table if not exists atlas_private.knowledge_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'article_created','draft_saved','version_published','article_retired',
    'article_read','article_acknowledged','source_saved','source_removed','task_links_updated'
  )),
  article_id uuid references atlas_private.knowledge_articles(id) on delete set null,
  version_id uuid references atlas_private.knowledge_article_versions(id) on delete set null,
  source_id uuid references atlas_private.knowledge_sources(id) on delete set null,
  user_id uuid,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload)='object')
);
create index if not exists knowledge_events_article_created_idx
  on atlas_private.knowledge_events(article_id,created_at desc) where article_id is not null;
create index if not exists knowledge_events_created_idx
  on atlas_private.knowledge_events(created_at desc);

alter table atlas_private.knowledge_settings enable row level security;
alter table atlas_private.knowledge_categories enable row level security;
alter table atlas_private.knowledge_articles enable row level security;
alter table atlas_private.knowledge_article_versions enable row level security;
alter table atlas_private.knowledge_sources enable row level security;
alter table atlas_private.knowledge_task_links enable row level security;
alter table atlas_private.knowledge_reads enable row level security;
alter table atlas_private.knowledge_acknowledgements enable row level security;
alter table atlas_private.knowledge_events enable row level security;

drop policy if exists "service role manages knowledge settings" on atlas_private.knowledge_settings;
create policy "service role manages knowledge settings" on atlas_private.knowledge_settings for all to service_role using (true) with check (true);
drop policy if exists "service role manages knowledge categories" on atlas_private.knowledge_categories;
create policy "service role manages knowledge categories" on atlas_private.knowledge_categories for all to service_role using (true) with check (true);
drop policy if exists "service role manages knowledge articles" on atlas_private.knowledge_articles;
create policy "service role manages knowledge articles" on atlas_private.knowledge_articles for all to service_role using (true) with check (true);
drop policy if exists "service role manages knowledge versions" on atlas_private.knowledge_article_versions;
create policy "service role manages knowledge versions" on atlas_private.knowledge_article_versions for all to service_role using (true) with check (true);
drop policy if exists "service role manages knowledge sources" on atlas_private.knowledge_sources;
create policy "service role manages knowledge sources" on atlas_private.knowledge_sources for all to service_role using (true) with check (true);
drop policy if exists "service role manages knowledge task links" on atlas_private.knowledge_task_links;
create policy "service role manages knowledge task links" on atlas_private.knowledge_task_links for all to service_role using (true) with check (true);
drop policy if exists "service role manages knowledge reads" on atlas_private.knowledge_reads;
create policy "service role manages knowledge reads" on atlas_private.knowledge_reads for all to service_role using (true) with check (true);
drop policy if exists "service role manages knowledge acknowledgements" on atlas_private.knowledge_acknowledgements;
create policy "service role manages knowledge acknowledgements" on atlas_private.knowledge_acknowledgements for all to service_role using (true) with check (true);
drop policy if exists "service role manages knowledge events" on atlas_private.knowledge_events;
create policy "service role manages knowledge events" on atlas_private.knowledge_events for all to service_role using (true) with check (true);

revoke all on atlas_private.knowledge_settings from public,anon,authenticated;
revoke all on atlas_private.knowledge_categories from public,anon,authenticated;
revoke all on atlas_private.knowledge_articles from public,anon,authenticated;
revoke all on atlas_private.knowledge_article_versions from public,anon,authenticated;
revoke all on atlas_private.knowledge_sources from public,anon,authenticated;
revoke all on atlas_private.knowledge_task_links from public,anon,authenticated;
revoke all on atlas_private.knowledge_reads from public,anon,authenticated;
revoke all on atlas_private.knowledge_acknowledgements from public,anon,authenticated;
revoke all on atlas_private.knowledge_events from public,anon,authenticated;
grant all on atlas_private.knowledge_settings to service_role;
grant all on atlas_private.knowledge_categories to service_role;
grant all on atlas_private.knowledge_articles to service_role;
grant all on atlas_private.knowledge_article_versions to service_role;
grant all on atlas_private.knowledge_sources to service_role;
grant all on atlas_private.knowledge_task_links to service_role;
grant all on atlas_private.knowledge_reads to service_role;
grant all on atlas_private.knowledge_acknowledgements to service_role;
grant all on atlas_private.knowledge_events to service_role;

drop trigger if exists knowledge_settings_touch on atlas_private.knowledge_settings;
create trigger knowledge_settings_touch before update on atlas_private.knowledge_settings for each row execute function atlas_private.touch_updated_at();
drop trigger if exists knowledge_categories_touch on atlas_private.knowledge_categories;
create trigger knowledge_categories_touch before update on atlas_private.knowledge_categories for each row execute function atlas_private.touch_updated_at();
drop trigger if exists knowledge_articles_touch on atlas_private.knowledge_articles;
create trigger knowledge_articles_touch before update on atlas_private.knowledge_articles for each row execute function atlas_private.touch_updated_at();
drop trigger if exists knowledge_versions_touch on atlas_private.knowledge_article_versions;
create trigger knowledge_versions_touch before update on atlas_private.knowledge_article_versions for each row execute function atlas_private.touch_updated_at();
drop trigger if exists knowledge_sources_touch on atlas_private.knowledge_sources;
create trigger knowledge_sources_touch before update on atlas_private.knowledge_sources for each row execute function atlas_private.touch_updated_at();

insert into atlas_private.knowledge_settings (
  setting_key,google_drive_connection_status,automatic_drive_sync_enabled,
  browser_notifications_enabled,staff_source_urls_visible,metadata
) values (
  'va','not_connected',false,false,false,
  jsonb_build_object(
    'checkpoint','G',
    'publishing_model','manager_draft_then_immutable_version',
    'drive_import_mode','manual_private_import',
    'source_text_in_public_repository',false,
    'sensitive_credentials_allowed',false
  )
)
on conflict (setting_key) do update set
  google_drive_connection_status='not_connected',
  automatic_drive_sync_enabled=false,
  browser_notifications_enabled=false,
  staff_source_urls_visible=false,
  metadata=excluded.metadata,
  updated_at=now();

insert into atlas_private.knowledge_categories (
  category_key,name,description,icon,sort_order,active
) values
  ('company-policies','Company policies','Employment rules, conduct, safety and company-wide standards.','shield-check',10,true),
  ('operations-sops','Operations & SOPs','Daily operational standards and role responsibilities.','workflow',20,true),
  ('opening-closing','Opening & closing','Service preparation, handover, closing and venue security.','door-open',30,true),
  ('service-standards','Service standards','Hospitality, communication and guest-experience guidance.','hand-heart',40,true),
  ('bar-beverage','Bar & beverage knowledge','Recipes, beverage preparation, wine, beer and coffee knowledge.','martini',50,true),
  ('cleaning-safety','Cleaning & safety','Hygiene, temperatures, incidents and equipment safety.','sparkles',60,true),
  ('management','Management','Leadership, scheduling, financial controls and manager responsibilities.','briefcase-business',70,true),
  ('checklists','Checklists','Operational checklists linked to live Atlas routines.','list-checks',80,true),
  ('training-onboarding','Training & onboarding','Required learning, role paths and manager sign-off.','graduation-cap',90,true)
on conflict (category_key) do update set
  name=excluded.name,description=excluded.description,icon=excluded.icon,
  sort_order=excluded.sort_order,active=excluded.active,updated_at=now();

create or replace function atlas_private.knowledge_article_visible(
  p_article atlas_private.knowledge_articles,
  p_actor_role text,
  p_is_manager boolean
)
returns boolean
language sql
stable
security invoker
set search_path=''
as $$
  select p_is_manager or (
    p_article.status='published'
    and ('all'=any(p_article.target_roles) or p_actor_role=any(p_article.target_roles))
  );
$$;

create or replace function atlas_private.knowledge_snapshot(
  p_profiles jsonb,
  p_tasks jsonb,
  p_progress jsonb,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  settings_row atlas_private.knowledge_settings;
  categories_json jsonb := '[]'::jsonb;
  articles_json jsonb := '[]'::jsonb;
  training_json jsonb := '{}'::jsonb;
  events_json jsonb := '[]'::jsonb;
  summary_json jsonb := '{}'::jsonb;
begin
  select * into settings_row from atlas_private.knowledge_settings where setting_key='va';

  with visible_articles as (
    select article.* from atlas_private.knowledge_articles article
    where atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',category.id,'key',category.category_key,'name',category.name,
    'description',category.description,'icon',category.icon,'sort_order',category.sort_order,
    'article_count',(select count(*)::bigint from visible_articles article where article.category_id=category.id)
  ) order by category.sort_order,category.name),'[]'::jsonb)
  into categories_json
  from atlas_private.knowledge_categories category where category.active=true;

  select coalesce(jsonb_agg(row_data.payload order by row_data.sort_required,row_data.sort_updated desc,row_data.sort_title),'[]'::jsonb)
  into articles_json
  from (
    select
      case when article.required then 0 else 1 end as sort_required,
      greatest(article.updated_at,coalesce(display_version.updated_at,article.updated_at)) as sort_updated,
      coalesce(display_version.title,published_version.title,article.article_key) as sort_title,
      jsonb_build_object(
        'id',article.id,'article_key',article.article_key,
        'category_id',article.category_id,'category_key',category.category_key,
        'category_name',category.name,'category_icon',category.icon,
        'article_type',article.article_type,'status',article.status,
        'required',article.required,'target_roles',article.target_roles,
        'live_route',article.live_route,
        'title',coalesce(display_version.title,published_version.title,article.article_key),
        'summary',coalesce(display_version.summary,published_version.summary),
        'display_version_id',display_version.id,
        'display_version_number',display_version.version_number,
        'display_version_state',display_version.state,
        'published_version_id',published_version.id,
        'published_version_number',published_version.version_number,
        'published_at',published_version.published_at,
        'published_by_label',published_version.published_by_label,
        'draft_available',(draft_version.id is not null),
        'draft_version_id',draft_version.id,
        'draft_version_number',draft_version.version_number,
        'updated_at',greatest(article.updated_at,coalesce(display_version.updated_at,article.updated_at)),
        'read',case when published_version.id is null then false else exists (
          select 1 from atlas_private.knowledge_reads reading
          where reading.version_id=published_version.id and reading.user_id=p_actor_id
        ) end,
        'acknowledged',case when published_version.id is null then false else exists (
          select 1 from atlas_private.knowledge_acknowledgements acknowledgement
          where acknowledgement.version_id=published_version.id and acknowledgement.user_id=p_actor_id
        ) end,
        'required_due',(
          not is_manager and article.required and published_version.id is not null
          and not exists (
            select 1 from atlas_private.knowledge_acknowledgements acknowledgement
            where acknowledgement.version_id=published_version.id and acknowledgement.user_id=p_actor_id
          )
        ),
        'acknowledgement_count',case when is_manager and published_version.id is not null then (
          select count(*)::bigint from atlas_private.knowledge_acknowledgements acknowledgement
          where acknowledgement.version_id=published_version.id
        ) else null end,
        'source_count',(select count(*)::bigint from atlas_private.knowledge_sources source where source.article_id=article.id),
        'task_count',(select count(*)::bigint from atlas_private.knowledge_task_links task_link where task_link.article_id=article.id),
        'can_edit',is_manager,
        'can_publish',(is_manager and draft_version.id is not null),
        'can_acknowledge',(
          article.required and published_version.id is not null
          and not exists (
            select 1 from atlas_private.knowledge_acknowledgements acknowledgement
            where acknowledgement.version_id=published_version.id and acknowledgement.user_id=p_actor_id
          )
        )
      ) as payload
    from atlas_private.knowledge_articles article
    join atlas_private.knowledge_categories category on category.id=article.category_id
    left join lateral (
      select * from atlas_private.knowledge_article_versions version
      where version.article_id=article.id and version.state='published'
      order by version.version_number desc limit 1
    ) published_version on true
    left join lateral (
      select * from atlas_private.knowledge_article_versions version
      where version.article_id=article.id and version.state='draft'
      order by version.version_number desc limit 1
    ) draft_version on true
    left join lateral (
      select version.* from atlas_private.knowledge_article_versions version
      where version.id=case when is_manager and draft_version.id is not null then draft_version.id else published_version.id end
    ) display_version on true
    where atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
  ) row_data;

  with profiles_input as (
    select * from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
      id uuid,email text,display_name text,role text,active boolean
    )
  ), tasks_input as (
    select * from jsonb_to_recordset(coalesce(p_tasks,'[]'::jsonb)) as task(
      id uuid,title text,description text,category text,sort_order integer,required boolean,active boolean
    )
  ), progress_input as (
    select * from jsonb_to_recordset(coalesce(p_progress,'[]'::jsonb)) as progress(
      id uuid,task_id uuid,user_id uuid,completed_at timestamptz,completed_by uuid,note text
    )
  )
  select jsonb_build_object(
    'tasks',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',task.id,'title',task.title,'description',task.description,
        'category',task.category,'sort_order',task.sort_order,'required',task.required,
        'completed',exists (
          select 1 from progress_input progress
          where progress.task_id=task.id and progress.user_id=p_actor_id and progress.completed_at is not null
        ),
        'completed_at',(
          select progress.completed_at from progress_input progress
          where progress.task_id=task.id and progress.user_id=p_actor_id and progress.completed_at is not null
          order by progress.completed_at desc limit 1
        ),
        'note',(
          select progress.note from progress_input progress
          where progress.task_id=task.id and progress.user_id=p_actor_id
          order by progress.completed_at desc nulls last limit 1
        ),
        'linked_articles',coalesce((
          select jsonb_agg(jsonb_build_object(
            'article_id',article.id,'article_key',article.article_key,
            'title',version.title,'required_for_task',link.required_for_task
          ) order by version.title)
          from atlas_private.knowledge_task_links link
          join atlas_private.knowledge_articles article on article.id=link.article_id
          join atlas_private.knowledge_article_versions version
            on version.article_id=article.id and version.state='published'
          where link.onboarding_task_id=task.id
            and atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
        ),'[]'::jsonb)
      ) order by task.sort_order,task.title)
      from tasks_input task where task.active=true
    ),'[]'::jsonb),
    'own_progress',jsonb_build_object(
      'required_total',(select count(*)::bigint from tasks_input task where task.active=true and task.required=true),
      'required_completed',(
        select count(*)::bigint from tasks_input task
        where task.active=true and task.required=true
          and exists (
            select 1 from progress_input progress
            where progress.task_id=task.id and progress.user_id=p_actor_id and progress.completed_at is not null
          )
      )
    ),
    'team',case when is_manager then coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id',profile.id,
        'name',coalesce(nullif(trim(profile.display_name),''),nullif(split_part(coalesce(profile.email,''),'@',1),''),'Team member'),
        'role',profile.role,'active',profile.active,
        'required_total',(select count(*)::bigint from tasks_input task where task.active=true and task.required=true),
        'required_completed',(
          select count(*)::bigint from tasks_input task
          where task.active=true and task.required=true
            and exists (
              select 1 from progress_input progress
              where progress.task_id=task.id and progress.user_id=profile.id and progress.completed_at is not null
            )
        )
      ) order by profile.active desc,coalesce(profile.display_name,profile.email))
      from profiles_input profile where profile.active=true
    ),'[]'::jsonb) else '[]'::jsonb end
  ) into training_json;

  if is_manager then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',event.id,'event_type',event.event_type,'article_id',event.article_id,
      'version_id',event.version_id,'source_id',event.source_id,'user_id',event.user_id,
      'actor_label',event.actor_label,'actor_role',event.actor_role,
      'payload',event.payload,'created_at',event.created_at
    ) order by event.created_at desc),'[]'::jsonb)
    into events_json
    from (select * from atlas_private.knowledge_events order by created_at desc limit 80) event;
  end if;

  select jsonb_build_object(
    'visible_articles',jsonb_array_length(articles_json),
    'published_articles',(
      select count(*)::bigint from atlas_private.knowledge_articles article
      where article.status='published'
        and atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
    ),
    'draft_articles',case when is_manager then (
      select count(*)::bigint from atlas_private.knowledge_article_versions version where version.state='draft'
    ) else null end,
    'required_due',(
      select count(*)::bigint
      from atlas_private.knowledge_articles article
      join atlas_private.knowledge_article_versions version
        on version.article_id=article.id and version.state='published'
      where article.required=true
        and atlas_private.knowledge_article_visible(article,p_actor_role,is_manager)
        and not exists (
          select 1 from atlas_private.knowledge_acknowledgements acknowledgement
          where acknowledgement.version_id=version.id and acknowledgement.user_id=p_actor_id
        )
    ),
    'acknowledged',(
      select count(*)::bigint from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.user_id=p_actor_id
    ),
    'source_references',case when is_manager then (
      select count(*)::bigint from atlas_private.knowledge_sources
    ) else (
      select count(*)::bigint from atlas_private.knowledge_sources source where source.visible_to_staff=true
    ) end
  ) into summary_json;

  return jsonb_build_object(
    'version','atlas-knowledge/0.1.0','generated_at',pg_catalog.now(),
    'categories',categories_json,'articles',articles_json,'training',training_json,
    'events',events_json,'summary',summary_json,
    'settings',jsonb_build_object(
      'google_drive_connection_status',settings_row.google_drive_connection_status,
      'automatic_drive_sync_enabled',settings_row.automatic_drive_sync_enabled,
      'browser_notifications_enabled',settings_row.browser_notifications_enabled,
      'staff_source_urls_visible',settings_row.staff_source_urls_visible,
      'metadata',settings_row.metadata
    ),
    'permissions',jsonb_build_object(
      'can_manage_articles',is_manager,'can_publish',is_manager,
      'can_manage_sources',is_manager,'can_acknowledge',true
    ),
    'trust',jsonb_build_object(
      'only_published_versions_visible_to_staff',true,
      'published_versions_immutable',true,
      'drive_automatic_sync_enabled',false,
      'source_urls_manager_only',not settings_row.staff_source_urls_visible,
      'direct_browser_table_access',false,
      'sensitive_credentials_imported',false
    )
  );
end;
$$;

create or replace function atlas_private.knowledge_article_detail(
  p_article_id uuid,p_actor_id uuid,p_actor_role text,p_prefer_draft boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  is_manager boolean := p_actor_role in ('admin','manager');
  article_row atlas_private.knowledge_articles;
  category_row atlas_private.knowledge_categories;
  version_row atlas_private.knowledge_article_versions;
begin
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id;
  if not found then raise exception 'Knowledge article not found'; end if;
  if not atlas_private.knowledge_article_visible(article_row,p_actor_role,is_manager) then
    raise exception 'Knowledge article is not available to this profile';
  end if;
  select * into category_row from atlas_private.knowledge_categories where id=article_row.category_id;

  if is_manager and coalesce(p_prefer_draft,false) then
    select * into version_row from atlas_private.knowledge_article_versions
    where article_id=article_row.id and state='draft' order by version_number desc limit 1;
  end if;
  if version_row.id is null then
    select * into version_row from atlas_private.knowledge_article_versions
    where article_id=article_row.id and state='published' order by version_number desc limit 1;
  end if;
  if version_row.id is null and is_manager then
    select * into version_row from atlas_private.knowledge_article_versions
    where article_id=article_row.id order by version_number desc limit 1;
  end if;
  if version_row.id is null then raise exception 'Knowledge article has no readable version'; end if;

  return jsonb_build_object(
    'article',jsonb_build_object(
      'id',article_row.id,'article_key',article_row.article_key,
      'category_id',article_row.category_id,'category_key',category_row.category_key,
      'category_name',category_row.name,'category_icon',category_row.icon,
      'article_type',article_row.article_type,'status',article_row.status,
      'required',article_row.required,'target_roles',article_row.target_roles,
      'live_route',article_row.live_route,'current_version',article_row.current_version,
      'created_at',article_row.created_at,'updated_at',article_row.updated_at
    ),
    'version',jsonb_build_object(
      'id',version_row.id,'version_number',version_row.version_number,'state',version_row.state,
      'title',version_row.title,'summary',version_row.summary,'content',version_row.content,
      'content_format',version_row.content_format,'change_note',version_row.change_note,
      'created_by_label',version_row.created_by_label,'published_at',version_row.published_at,
      'published_by_label',version_row.published_by_label,'created_at',version_row.created_at,
      'updated_at',version_row.updated_at
    ),
    'sources',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',source.id,'source_type',source.source_type,'source_label',source.source_label,
        'source_reference',case when is_manager or source.visible_to_staff then source.source_reference else null end,
        'source_url',case when is_manager then source.source_url else null end,
        'source_version',source.source_version,'connection_status',source.connection_status,
        'visible_to_staff',source.visible_to_staff,'last_verified_at',source.last_verified_at,
        'metadata',case when is_manager then source.metadata else '{}'::jsonb end,
        'updated_at',source.updated_at
      ) order by source.updated_at desc)
      from atlas_private.knowledge_sources source
      where source.article_id=article_row.id and (is_manager or source.visible_to_staff=true)
    ),'[]'::jsonb),
    'task_links',coalesce((
      select jsonb_agg(jsonb_build_object(
        'onboarding_task_id',link.onboarding_task_id,'required_for_task',link.required_for_task
      ) order by link.onboarding_task_id)
      from atlas_private.knowledge_task_links link where link.article_id=article_row.id
    ),'[]'::jsonb),
    'read',exists (
      select 1 from atlas_private.knowledge_reads reading
      where reading.version_id=version_row.id and reading.user_id=p_actor_id
    ),
    'acknowledged',exists (
      select 1 from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.version_id=version_row.id and acknowledgement.user_id=p_actor_id
    ),
    'can_acknowledge',(version_row.state='published' and article_row.required and not exists (
      select 1 from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.version_id=version_row.id and acknowledgement.user_id=p_actor_id
    )),
    'version_history',case when is_manager then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',version.id,'version_number',version.version_number,'state',version.state,
        'title',version.title,'change_note',version.change_note,
        'created_by_label',version.created_by_label,'published_at',version.published_at,
        'published_by_label',version.published_by_label,'created_at',version.created_at,
        'updated_at',version.updated_at
      ) order by version.version_number desc)
      from atlas_private.knowledge_article_versions version where version.article_id=article_row.id
    ),'[]'::jsonb) else '[]'::jsonb end,
    'acknowledgements',case when is_manager and version_row.state='published' then coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id',acknowledgement.user_id,'user_label',acknowledgement.user_label,
        'user_role',acknowledgement.user_role,'acknowledged_at',acknowledgement.acknowledged_at
      ) order by acknowledgement.acknowledged_at desc)
      from atlas_private.knowledge_acknowledgements acknowledgement
      where acknowledgement.version_id=version_row.id
    ),'[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

create or replace function atlas_private.knowledge_save_draft(
  p_article_id uuid,p_article_key text,p_category_id uuid,p_article_type text,p_title text,
  p_summary text,p_content text,p_required boolean,p_target_roles text[],p_live_route text,
  p_change_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  article_row atlas_private.knowledge_articles;
  draft_row atlas_private.knowledge_article_versions;
  next_version integer;
  created_article boolean := false;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can edit Knowledge'; end if;
  if nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Article title is required'; end if;
  if nullif(trim(coalesce(p_content,'')),'') is null then raise exception 'Article content is required'; end if;
  if p_article_type not in ('policy','sop','checklist','training','reference','live_resource') then raise exception 'Article type is invalid'; end if;
  if coalesce(cardinality(p_target_roles),0)=0 or not (p_target_roles <@ array['all','admin','manager','bartender','viewer']::text[]) then raise exception 'Target roles are invalid'; end if;
  if not exists (select 1 from atlas_private.knowledge_categories where id=p_category_id and active=true) then raise exception 'Knowledge category is invalid'; end if;

  if p_article_id is null then
    if nullif(trim(coalesce(p_article_key,'')),'') is null or p_article_key !~ '^[a-z0-9][a-z0-9-]{1,119}$' then raise exception 'Article key is invalid'; end if;
    insert into atlas_private.knowledge_articles (
      article_key,category_id,article_type,status,required,target_roles,live_route,
      created_by,created_by_label,updated_by,updated_by_label
    ) values (
      p_article_key,p_category_id,p_article_type,'draft',coalesce(p_required,false),p_target_roles,
      nullif(trim(coalesce(p_live_route,'')),''),p_actor_id,p_actor_label,p_actor_id,p_actor_label
    ) returning * into article_row;
    created_article := true;
    insert into atlas_private.knowledge_events (event_type,article_id,actor_id,actor_label,actor_role,payload)
    values ('article_created',article_row.id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('article_key',article_row.article_key));
  else
    select * into article_row from atlas_private.knowledge_articles where id=p_article_id for update;
    if not found then raise exception 'Knowledge article not found'; end if;
    update atlas_private.knowledge_articles
    set category_id=p_category_id,article_type=p_article_type,required=coalesce(p_required,false),
        target_roles=p_target_roles,live_route=nullif(trim(coalesce(p_live_route,'')),''),
        status=case when status='retired' then 'draft' else status end,
        updated_by=p_actor_id,updated_by_label=p_actor_label
    where id=article_row.id returning * into article_row;
  end if;

  select * into draft_row from atlas_private.knowledge_article_versions
  where article_id=article_row.id and state='draft' for update;

  if not found then
    select coalesce(max(version_number),0)+1 into next_version
    from atlas_private.knowledge_article_versions where article_id=article_row.id;
    insert into atlas_private.knowledge_article_versions (
      article_id,version_number,state,title,summary,content,content_format,change_note,
      created_by,created_by_label
    ) values (
      article_row.id,next_version,'draft',trim(p_title),nullif(trim(coalesce(p_summary,'')),''),
      p_content,'markdown',nullif(trim(coalesce(p_change_note,'')),''),p_actor_id,p_actor_label
    ) returning * into draft_row;
  else
    update atlas_private.knowledge_article_versions
    set title=trim(p_title),summary=nullif(trim(coalesce(p_summary,'')),''),content=p_content,
        change_note=nullif(trim(coalesce(p_change_note,'')),''),created_by=p_actor_id,
        created_by_label=p_actor_label,updated_at=pg_catalog.now()
    where id=draft_row.id returning * into draft_row;
  end if;

  update atlas_private.knowledge_articles
  set draft_version_id=draft_row.id,updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=article_row.id;

  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,actor_id,actor_label,actor_role,payload
  ) values (
    'draft_saved',article_row.id,draft_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('version_number',draft_row.version_number,'created_article',created_article)
  );

  return jsonb_build_object('article',to_jsonb(article_row),'draft',to_jsonb(draft_row));
end;
$$;

create or replace function atlas_private.knowledge_publish(
  p_article_id uuid,p_change_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  article_row atlas_private.knowledge_articles;
  draft_row atlas_private.knowledge_article_versions;
  published_row atlas_private.knowledge_article_versions;
  system_body text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can publish Knowledge'; end if;
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id for update;
  if not found then raise exception 'Knowledge article not found'; end if;
  select * into draft_row from atlas_private.knowledge_article_versions
  where article_id=article_row.id and state='draft' for update;
  if not found then raise exception 'This article has no draft to publish'; end if;

  update atlas_private.knowledge_article_versions
  set state='superseded',updated_at=pg_catalog.now()
  where article_id=article_row.id and state='published';

  update atlas_private.knowledge_article_versions
  set state='published',change_note=coalesce(nullif(trim(coalesce(p_change_note,'')),''),change_note),
      published_at=pg_catalog.now(),published_by=p_actor_id,published_by_label=p_actor_label,
      updated_at=pg_catalog.now()
  where id=draft_row.id returning * into published_row;

  update atlas_private.knowledge_articles
  set status='published',current_version=published_row.version_number,
      current_version_id=published_row.id,draft_version_id=null,
      updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=article_row.id returning * into article_row;

  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,actor_id,actor_label,actor_role,payload
  ) values (
    'version_published',article_row.id,published_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('version_number',published_row.version_number,'required',article_row.required,'target_roles',article_row.target_roles)
  );

  system_body := 'Knowledge article published' || E'\n' || published_row.title
    || ' · Version ' || published_row.version_number::text
    || case when article_row.required then E'\nRequired reading for assigned staff.' else '' end;
  begin
    perform atlas_private.team_messages_post_system(
      'announcements','knowledge-published:'||article_row.id::text||':'||published_row.version_number::text,
      system_body,'knowledge_article',article_row.id::text,published_row.title,'knowledge',
      jsonb_build_object('article_id',article_row.id,'version_id',published_row.id,
        'version_number',published_row.version_number,'required',article_row.required)
    );
  exception when others then null;
  end;

  return jsonb_build_object('article',to_jsonb(article_row),'version',to_jsonb(published_row));
end;
$$;

create or replace function atlas_private.knowledge_retire(
  p_article_id uuid,p_reason text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare article_row atlas_private.knowledge_articles;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can retire Knowledge'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A retirement reason is required'; end if;
  update atlas_private.knowledge_articles
  set status='retired',draft_version_id=null,updated_by=p_actor_id,updated_by_label=p_actor_label
  where id=p_article_id returning * into article_row;
  if not found then raise exception 'Knowledge article not found'; end if;
  update atlas_private.knowledge_article_versions set state='superseded'
  where article_id=article_row.id and state='draft';
  insert into atlas_private.knowledge_events (event_type,article_id,actor_id,actor_label,actor_role,payload)
  values ('article_retired',article_row.id,p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('reason',trim(p_reason)));
  return to_jsonb(article_row);
end;
$$;

create or replace function atlas_private.knowledge_mark_read(
  p_article_id uuid,p_version_id uuid,p_user_id uuid,p_user_label text,p_user_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  article_row atlas_private.knowledge_articles;
  version_row atlas_private.knowledge_article_versions;
  read_row atlas_private.knowledge_reads;
begin
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id;
  if not found or not atlas_private.knowledge_article_visible(article_row,p_user_role,p_user_role in ('admin','manager')) then
    raise exception 'Knowledge article is not available';
  end if;
  select * into version_row from atlas_private.knowledge_article_versions
  where id=p_version_id and article_id=article_row.id and state='published';
  if not found then raise exception 'Published Knowledge version not found'; end if;
  insert into atlas_private.knowledge_reads (version_id,article_id,user_id,user_label)
  values (version_row.id,article_row.id,p_user_id,p_user_label)
  on conflict (version_id,user_id) do update set
    last_read_at=pg_catalog.now(),
    read_count=atlas_private.knowledge_reads.read_count+1,
    user_label=excluded.user_label
  returning * into read_row;
  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,user_id,actor_id,actor_label,actor_role,payload
  ) values (
    'article_read',article_row.id,version_row.id,p_user_id,p_user_id,p_user_label,p_user_role,
    jsonb_build_object('read_count',read_row.read_count)
  );
  return to_jsonb(read_row);
end;
$$;

create or replace function atlas_private.knowledge_acknowledge(
  p_article_id uuid,p_version_id uuid,p_user_id uuid,p_user_label text,p_user_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  article_row atlas_private.knowledge_articles;
  version_row atlas_private.knowledge_article_versions;
  acknowledgement_row atlas_private.knowledge_acknowledgements;
begin
  select * into article_row from atlas_private.knowledge_articles where id=p_article_id;
  if not found or not atlas_private.knowledge_article_visible(article_row,p_user_role,p_user_role in ('admin','manager')) then
    raise exception 'Knowledge article is not available';
  end if;
  if not article_row.required then raise exception 'This article does not require acknowledgement'; end if;
  select * into version_row from atlas_private.knowledge_article_versions
  where id=p_version_id and article_id=article_row.id and state='published';
  if not found or version_row.id is distinct from article_row.current_version_id then
    raise exception 'Only the current published version can be acknowledged';
  end if;
  insert into atlas_private.knowledge_acknowledgements (
    version_id,article_id,user_id,user_label,user_role
  ) values (
    version_row.id,article_row.id,p_user_id,p_user_label,p_user_role
  )
  on conflict (version_id,user_id) do update set
    user_label=excluded.user_label,user_role=excluded.user_role,
    acknowledged_at=least(atlas_private.knowledge_acknowledgements.acknowledged_at,excluded.acknowledged_at)
  returning * into acknowledgement_row;
  insert into atlas_private.knowledge_events (
    event_type,article_id,version_id,user_id,actor_id,actor_label,actor_role,payload
  ) values (
    'article_acknowledged',article_row.id,version_row.id,p_user_id,p_user_id,p_user_label,p_user_role,
    jsonb_build_object('version_number',version_row.version_number)
  );
  return to_jsonb(acknowledgement_row);
end;
$$;

create or replace function atlas_private.knowledge_save_source(
  p_source_id uuid,p_article_id uuid,p_source_type text,p_source_label text,
  p_source_reference text,p_source_url text,p_source_version text,p_connection_status text,
  p_visible_to_staff boolean,p_metadata jsonb,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare source_row atlas_private.knowledge_sources;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can manage Knowledge sources'; end if;
  if not exists (select 1 from atlas_private.knowledge_articles where id=p_article_id) then raise exception 'Knowledge article not found'; end if;
  if p_source_type not in ('google_drive','atlas_module','sprint3_import','manual','external') then raise exception 'Source type is invalid'; end if;
  if p_connection_status not in ('manual_reference','not_connected','current','stale','error') then raise exception 'Source status is invalid'; end if;
  if nullif(trim(coalesce(p_source_label,'')),'') is null then raise exception 'Source label is required'; end if;

  if p_source_id is null then
    insert into atlas_private.knowledge_sources (
      article_id,source_type,source_label,source_reference,source_url,source_version,
      connection_status,visible_to_staff,last_verified_at,metadata,created_by,created_by_label
    ) values (
      p_article_id,p_source_type,trim(p_source_label),nullif(trim(coalesce(p_source_reference,'')),''),
      nullif(trim(coalesce(p_source_url,'')),''),nullif(trim(coalesce(p_source_version,'')),''),
      p_connection_status,coalesce(p_visible_to_staff,false),
      case when p_connection_status='current' then pg_catalog.now() else null end,
      coalesce(p_metadata,'{}'::jsonb),p_actor_id,p_actor_label
    ) returning * into source_row;
  else
    update atlas_private.knowledge_sources
    set source_type=p_source_type,source_label=trim(p_source_label),
        source_reference=nullif(trim(coalesce(p_source_reference,'')),''),
        source_url=nullif(trim(coalesce(p_source_url,'')),''),
        source_version=nullif(trim(coalesce(p_source_version,'')),''),
        connection_status=p_connection_status,visible_to_staff=coalesce(p_visible_to_staff,false),
        last_verified_at=case when p_connection_status='current' then pg_catalog.now() else last_verified_at end,
        metadata=coalesce(p_metadata,'{}'::jsonb)
    where id=p_source_id and article_id=p_article_id returning * into source_row;
    if not found then raise exception 'Knowledge source not found'; end if;
  end if;

  insert into atlas_private.knowledge_events (
    event_type,article_id,source_id,actor_id,actor_label,actor_role,payload
  ) values (
    'source_saved',p_article_id,source_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('source_type',source_row.source_type,'connection_status',source_row.connection_status)
  );
  return to_jsonb(source_row);
end;
$$;

create or replace function atlas_private.knowledge_remove_source(
  p_source_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare source_row atlas_private.knowledge_sources;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can remove Knowledge sources'; end if;
  delete from atlas_private.knowledge_sources where id=p_source_id returning * into source_row;
  if not found then raise exception 'Knowledge source not found'; end if;
  insert into atlas_private.knowledge_events (
    event_type,article_id,source_id,actor_id,actor_label,actor_role,payload
  ) values (
    'source_removed',source_row.article_id,null,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('source_id',source_row.id,'source_label',source_row.source_label,'source_type',source_row.source_type)
  );
  return to_jsonb(source_row);
end;
$$;

create or replace function atlas_private.knowledge_set_task_links(
  p_article_id uuid,p_task_ids uuid[],p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can link Knowledge to onboarding'; end if;
  if not exists (select 1 from atlas_private.knowledge_articles where id=p_article_id) then raise exception 'Knowledge article not found'; end if;
  delete from atlas_private.knowledge_task_links where article_id=p_article_id;
  insert into atlas_private.knowledge_task_links (
    article_id,onboarding_task_id,created_by,created_by_label
  )
  select p_article_id,task_id,p_actor_id,p_actor_label
  from unnest(coalesce(p_task_ids,'{}'::uuid[])) as task_id
  on conflict do nothing;
  insert into atlas_private.knowledge_events (
    event_type,article_id,actor_id,actor_label,actor_role,payload
  ) values (
    'task_links_updated',p_article_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('task_ids',coalesce(to_jsonb(p_task_ids),'[]'::jsonb))
  );
  return jsonb_build_object('article_id',p_article_id,'task_ids',coalesce(to_jsonb(p_task_ids),'[]'::jsonb));
end;
$$;

comment on table atlas_private.knowledge_articles is 'Private Knowledge article metadata. Staff only receive manager-published role-targeted versions through the gateway.';
comment on table atlas_private.knowledge_article_versions is 'Versioned Knowledge content. Published versions are immutable and prior acknowledgements remain attached to their original version.';
comment on table atlas_private.knowledge_acknowledgements is 'Per-user acknowledgement of a specific published Knowledge version.';
