create table if not exists atlas_private.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  campaign_type text not null default 'always_on'
    check (campaign_type in ('promotion','event','seasonal','always_on','brand','other')),
  status text not null default 'draft'
    check (status in ('draft','active','paused','completed','cancelled')),
  objective text,
  target_audience text,
  platforms text[] not null default '{}'::text[],
  start_date date,
  end_date date,
  created_by uuid,
  created_by_label text,
  created_by_role text,
  updated_by uuid,
  updated_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table if not exists atlas_private.marketing_content_items (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid unique,
  campaign_id uuid references atlas_private.marketing_campaigns(id) on delete set null,
  title text not null,
  content_type text not null
    check (content_type in ('post','story','reel','campaign_task','event_promotion','content_idea','google_post')),
  status text not null default 'idea'
    check (status in ('idea','draft','pending_approval','changes_requested','approved','scheduled','published','completed','rejected','cancelled')),
  priority text not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  platforms text[] not null default '{}'::text[],
  scheduled_for timestamptz,
  reminder_at timestamptz,
  event_starts_at timestamptz,
  event_ends_at timestamptz,
  suggested_format text,
  caption_draft text,
  creative_brief text,
  frames jsonb not null default '[]'::jsonb,
  media_requirements jsonb not null default '{}'::jsonb,
  owner_id uuid,
  owner_label text,
  created_by uuid,
  created_by_label text,
  created_by_role text,
  published_at timestamptz,
  completed_at timestamptz,
  external_publication_ids jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(title) between 1 and 180),
  check (caption_draft is null or char_length(caption_draft) <= 10000),
  check (creative_brief is null or char_length(creative_brief) <= 10000),
  check (event_ends_at is null or event_starts_at is null or event_ends_at >= event_starts_at),
  check (jsonb_typeof(frames)='array'),
  check (jsonb_typeof(media_requirements)='object'),
  check (jsonb_typeof(external_publication_ids)='object'),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.marketing_content_revisions (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references atlas_private.marketing_content_items(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  change_type text not null
    check (change_type in ('create','edit','status','approval','publication','completion','cancellation')),
  previous_payload jsonb,
  new_payload jsonb,
  changed_by uuid,
  changed_by_label text not null,
  changed_by_role text not null,
  note text,
  created_at timestamptz not null default now(),
  unique (content_id,revision_number)
);

create table if not exists atlas_private.marketing_content_approvals (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references atlas_private.marketing_content_items(id) on delete cascade,
  decision text not null
    check (decision in ('submitted','approved','changes_requested','rejected','cancelled')),
  actor_id uuid,
  actor_label text not null,
  actor_role text not null,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists atlas_private.marketing_recommendations (
  id uuid primary key default gen_random_uuid(),
  recommendation_key text not null unique,
  title text not null,
  summary text not null,
  content_type text not null
    check (content_type in ('post','story','reel','campaign_task','event_promotion','content_idea','google_post')),
  platforms text[] not null default '{}'::text[],
  recurrence text not null default 'one_off'
    check (recurrence in ('one_off','daily','weekly')),
  day_of_week smallint,
  active_from date,
  active_to date,
  suggested_time time,
  suggested_format text,
  caption_draft text,
  creative_brief text,
  frames jsonb not null default '[]'::jsonb,
  reason text not null,
  evidence jsonb not null default '[]'::jsonb,
  confidence_score numeric not null default 0.5
    check (confidence_score between 0 and 1),
  status text not null default 'active'
    check (status in ('active','converted','dismissed','expired')),
  converted_content_id uuid references atlas_private.marketing_content_items(id) on delete set null,
  converted_at timestamptz,
  converted_by uuid,
  converted_by_label text,
  dismissed_at timestamptz,
  dismissed_by uuid,
  dismissed_by_label text,
  dismiss_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (day_of_week is null or day_of_week between 0 and 6),
  check (active_to is null or active_from is null or active_to >= active_from),
  check (jsonb_typeof(frames)='array'),
  check (jsonb_typeof(evidence)='array'),
  check (jsonb_typeof(metadata)='object')
);

create table if not exists atlas_private.marketing_workspace_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null
    check (event_type in ('campaign_created','content_created','content_updated','approval_submitted','approval_decided','content_published','content_completed','content_cancelled','recommendation_converted','recommendation_dismissed','connection_state_changed')),
  campaign_id uuid references atlas_private.marketing_campaigns(id) on delete set null,
  content_id uuid references atlas_private.marketing_content_items(id) on delete set null,
  recommendation_id uuid references atlas_private.marketing_recommendations(id) on delete set null,
  actor_id uuid,
  actor_label text,
  actor_role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table atlas_private.integration_connections
  add column if not exists authorization_state text not null default 'not_connected',
  add column if not exists publishing_permission_state text not null default 'not_requested',
  add column if not exists analytics_permission_state text not null default 'not_requested',
  add column if not exists token_expires_at timestamptz,
  add column if not exists last_connection_error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='integration_connections_authorization_state_check'
      and conrelid='atlas_private.integration_connections'::regclass
  ) then
    alter table atlas_private.integration_connections
      add constraint integration_connections_authorization_state_check
      check (authorization_state in ('not_connected','waiting_authorization','authorized','expired'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname='integration_connections_publishing_permission_state_check'
      and conrelid='atlas_private.integration_connections'::regclass
  ) then
    alter table atlas_private.integration_connections
      add constraint integration_connections_publishing_permission_state_check
      check (publishing_permission_state in ('not_requested','pending','granted','missing','not_supported'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname='integration_connections_analytics_permission_state_check'
      and conrelid='atlas_private.integration_connections'::regclass
  ) then
    alter table atlas_private.integration_connections
      add constraint integration_connections_analytics_permission_state_check
      check (analytics_permission_state in ('not_requested','pending','granted','missing','not_supported'));
  end if;
end $$;

create index if not exists marketing_campaigns_status_dates_idx
  on atlas_private.marketing_campaigns(status,start_date,end_date);
create index if not exists marketing_content_calendar_idx
  on atlas_private.marketing_content_items(scheduled_for,status);
create index if not exists marketing_content_reminder_idx
  on atlas_private.marketing_content_items(reminder_at,status)
  where reminder_at is not null;
create index if not exists marketing_content_campaign_idx
  on atlas_private.marketing_content_items(campaign_id,status)
  where campaign_id is not null;
create index if not exists marketing_content_owner_idx
  on atlas_private.marketing_content_items(owner_id,status)
  where owner_id is not null;
create index if not exists marketing_revisions_content_idx
  on atlas_private.marketing_content_revisions(content_id,revision_number desc);
create index if not exists marketing_approvals_content_idx
  on atlas_private.marketing_content_approvals(content_id,created_at desc);
create index if not exists marketing_recommendations_due_idx
  on atlas_private.marketing_recommendations(status,recurrence,day_of_week,active_from,active_to);
create index if not exists marketing_events_created_idx
  on atlas_private.marketing_workspace_events(created_at desc);
create index if not exists marketing_events_content_idx
  on atlas_private.marketing_workspace_events(content_id,created_at desc)
  where content_id is not null;

alter table atlas_private.marketing_campaigns enable row level security;
alter table atlas_private.marketing_content_items enable row level security;
alter table atlas_private.marketing_content_revisions enable row level security;
alter table atlas_private.marketing_content_approvals enable row level security;
alter table atlas_private.marketing_recommendations enable row level security;
alter table atlas_private.marketing_workspace_events enable row level security;

drop policy if exists "service role manages marketing campaigns" on atlas_private.marketing_campaigns;
create policy "service role manages marketing campaigns"
  on atlas_private.marketing_campaigns for all to service_role using (true) with check (true);
drop policy if exists "service role manages marketing content" on atlas_private.marketing_content_items;
create policy "service role manages marketing content"
  on atlas_private.marketing_content_items for all to service_role using (true) with check (true);
drop policy if exists "service role manages marketing revisions" on atlas_private.marketing_content_revisions;
create policy "service role manages marketing revisions"
  on atlas_private.marketing_content_revisions for all to service_role using (true) with check (true);
drop policy if exists "service role manages marketing approvals" on atlas_private.marketing_content_approvals;
create policy "service role manages marketing approvals"
  on atlas_private.marketing_content_approvals for all to service_role using (true) with check (true);
drop policy if exists "service role manages marketing recommendations" on atlas_private.marketing_recommendations;
create policy "service role manages marketing recommendations"
  on atlas_private.marketing_recommendations for all to service_role using (true) with check (true);
drop policy if exists "service role manages marketing events" on atlas_private.marketing_workspace_events;
create policy "service role manages marketing events"
  on atlas_private.marketing_workspace_events for all to service_role using (true) with check (true);

revoke all on atlas_private.marketing_campaigns from public,anon,authenticated;
revoke all on atlas_private.marketing_content_items from public,anon,authenticated;
revoke all on atlas_private.marketing_content_revisions from public,anon,authenticated;
revoke all on atlas_private.marketing_content_approvals from public,anon,authenticated;
revoke all on atlas_private.marketing_recommendations from public,anon,authenticated;
revoke all on atlas_private.marketing_workspace_events from public,anon,authenticated;
grant all on atlas_private.marketing_campaigns to service_role;
grant all on atlas_private.marketing_content_items to service_role;
grant all on atlas_private.marketing_content_revisions to service_role;
grant all on atlas_private.marketing_content_approvals to service_role;
grant all on atlas_private.marketing_recommendations to service_role;
grant all on atlas_private.marketing_workspace_events to service_role;

drop trigger if exists marketing_campaigns_touch on atlas_private.marketing_campaigns;
create trigger marketing_campaigns_touch before update on atlas_private.marketing_campaigns
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists marketing_content_items_touch on atlas_private.marketing_content_items;
create trigger marketing_content_items_touch before update on atlas_private.marketing_content_items
  for each row execute function atlas_private.touch_updated_at();
drop trigger if exists marketing_recommendations_touch on atlas_private.marketing_recommendations;
create trigger marketing_recommendations_touch before update on atlas_private.marketing_recommendations
  for each row execute function atlas_private.touch_updated_at();

update atlas_private.integration_connections
set authorization_state=case
      when status='connected' then 'authorized'
      when status='expired' then 'expired'
      when status in ('authorization_required','pending_review') then 'waiting_authorization'
      else 'not_connected'
    end,
    publishing_permission_state=case
      when status='connected' then 'granted'
      when provider_key='tripadvisor' then 'not_supported'
      else 'not_requested'
    end,
    analytics_permission_state=case
      when status='connected' then 'granted'
      when provider_key='tripadvisor' then 'not_supported'
      else 'not_requested'
    end,
    metadata=metadata || jsonb_build_object(
      'marketing_checkpoint','D',
      'tokens_stored_server_side_only',true,
      'automatic_publishing_enabled',false,
      'automatic_analytics_enabled',false
    ),
    updated_at=now();

update atlas_private.integration_connections
set requirements=requirements || case provider_key
      when 'instagram' then jsonb_build_object(
        'professional_account',true,
        'meta_app_review',true,
        'publishing_permission_required',true,
        'insights_permission_required',true
      )
      when 'facebook' then jsonb_build_object(
        'facebook_page',true,
        'meta_app_review',true,
        'page_publishing_permission_required',true,
        'page_insights_permission_required',true
      )
      when 'tiktok' then jsonb_build_object(
        'content_posting_api',true,
        'developer_app_review',true,
        'url_property_verification',true,
        'publishing_scopes',jsonb_build_array('video.publish','video.upload'),
        'analytics_scope','video.list'
      )
      when 'google-business-profile' then jsonb_build_object(
        'business_profile_api_access',true,
        'google_cloud_project',true,
        'oauth_scope','https://www.googleapis.com/auth/business.manage',
        'location_access',true
      )
      else '{}'::jsonb
    end,
    updated_at=now()
where provider_key in ('instagram','facebook','tiktok','google-business-profile');

insert into atlas_private.marketing_recommendations (
  recommendation_key,title,summary,content_type,platforms,recurrence,day_of_week,
  suggested_time,suggested_format,caption_draft,creative_brief,frames,reason,evidence,
  confidence_score,status,metadata
) values
  (
    'daily-happy-hour-instagram-story',
    'Suggested Instagram Story for today',
    'Promote Happy Hour from 15:00–18:00.',
    'story',array['instagram']::text[],'daily',null,'14:30',
    'Three-frame vertical Story',
    'Happy Hour at VÁ · Every day from 15:00–18:00 · Cocktails from 1,990 ISK. Find us inside Hafnartorg Gallery.',
    'Use one atmospheric image, one close cocktail detail and one practical location/booking frame.',
    jsonb_build_array(
      jsonb_build_object('frame',1,'title','Atmosphere','instruction','Show the bar, warm light and guests arriving.'),
      jsonb_build_object('frame',2,'title','The offer','instruction','Feature cocktails from 1,990 ISK and the 15:00–18:00 window.'),
      jsonb_build_object('frame',3,'title','Visit VÁ','instruction','Add Hafnartorg Gallery, Reykjavík and the booking link.')
    ),
    'The daily offer benefits from a same-day reminder shortly before it begins.',
    jsonb_build_array(
      jsonb_build_object('source','VÁ operating schedule','fact','Happy Hour runs daily from 15:00–18:00.'),
      jsonb_build_object('source','VÁ menu pricing','fact','Selected Happy Hour cocktails are 1,990 ISK.')
    ),
    0.90,'active',jsonb_build_object('shadow_recommendation',true,'publishing_disabled',true)
  ),
  (
    'sunday-two-for-one-beer-reel',
    'Suggested Sunday Reel',
    'Feature the 2-for-1 beer offer from 18:00–20:00.',
    'reel',array['instagram','facebook','tiktok']::text[],'weekly',0,'17:00',
    '10–15 second vertical Reel',
    'Sunday at VÁ: two beers for the price of one from 18:00–20:00. Bring a friend and make it a VÁ evening.',
    'Film a fast pour, two glasses meeting, the offer text and a final location card. Keep the first two seconds visually strong.',
    jsonb_build_array(
      jsonb_build_object('frame',1,'title','Hook','instruction','Close-up beer pour with “Sunday at VÁ” on screen.'),
      jsonb_build_object('frame',2,'title','Offer','instruction','Show two beers and “2 for 1 · 18:00–20:00”.'),
      jsonb_build_object('frame',3,'title','Location','instruction','End with VÁ Bar · Hafnartorg Gallery · Reykjavík.')
    ),
    'The promotion is time-specific and benefits from a short video reminder shortly before the offer begins.',
    jsonb_build_array(
      jsonb_build_object('source','VÁ Sunday promotion','fact','Two-for-one beer runs Sundays from 18:00–20:00.')
    ),
    0.88,'active',jsonb_build_object('shadow_recommendation',true,'publishing_disabled',true)
  )
on conflict (recommendation_key) do update set
  title=excluded.title,
  summary=excluded.summary,
  content_type=excluded.content_type,
  platforms=excluded.platforms,
  recurrence=excluded.recurrence,
  day_of_week=excluded.day_of_week,
  suggested_time=excluded.suggested_time,
  suggested_format=excluded.suggested_format,
  caption_draft=excluded.caption_draft,
  creative_brief=excluded.creative_brief,
  frames=excluded.frames,
  reason=excluded.reason,
  evidence=excluded.evidence,
  confidence_score=excluded.confidence_score,
  metadata=excluded.metadata,
  updated_at=now();

create or replace function atlas_private.marketing_connection_display_status(
  p_authorization_state text,
  p_publishing_state text,
  p_analytics_state text,
  p_token_expires_at timestamptz
)
returns text
language sql
stable
security invoker
set search_path=''
as $$
  select case
    when p_authorization_state='expired'
      or (p_token_expires_at is not null and p_token_expires_at<=pg_catalog.now())
      then 'connection_expired'
    when p_authorization_state='not_connected' then 'not_connected'
    when p_authorization_state='waiting_authorization' then 'waiting_for_authorization'
    when p_publishing_state='missing' then 'missing_publishing_permission'
    when p_analytics_state='missing' then 'missing_analytics_permission'
    when p_authorization_state='authorized'
      and p_publishing_state in ('granted','not_supported')
      and p_analytics_state in ('granted','not_supported','not_requested')
      then 'connected'
    else 'waiting_for_authorization'
  end;
$$;

create or replace function atlas_private.marketing_record_revision(
  p_content_id uuid,
  p_change_type text,
  p_previous_payload jsonb,
  p_new_payload jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_note text
)
returns integer
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare revision_no integer;
begin
  select coalesce(max(revision_number),0)+1 into revision_no
  from atlas_private.marketing_content_revisions
  where content_id=p_content_id;

  insert into atlas_private.marketing_content_revisions (
    content_id,revision_number,change_type,previous_payload,new_payload,
    changed_by,changed_by_label,changed_by_role,note
  ) values (
    p_content_id,revision_no,p_change_type,p_previous_payload,p_new_payload,
    p_actor_id,p_actor_label,p_actor_role,nullif(trim(coalesce(p_note,'')),'')
  );
  return revision_no;
end;
$$;

create or replace function atlas_private.marketing_workspace_snapshot(
  p_user_id uuid,
  p_user_role text,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  local_date date := (pg_catalog.now() at time zone 'Atlantic/Reykjavik')::date;
  start_date date := coalesce(p_start_date,date_trunc('month',local_date)::date);
  end_date date := coalesce(p_end_date,(date_trunc('month',local_date)+interval '1 month - 1 day')::date);
  content_json jsonb := '[]'::jsonb;
  recommendations_json jsonb := '[]'::jsonb;
  campaigns_json jsonb := '[]'::jsonb;
  connections_json jsonb := '[]'::jsonb;
  history_json jsonb := '[]'::jsonb;
  reminders_json jsonb := '[]'::jsonb;
  stats_json jsonb := '{}'::jsonb;
begin
  if start_date>end_date or end_date-start_date>92 then
    raise exception 'Marketing calendar range must be between 1 and 93 days';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',campaign.id,
    'name',campaign.name,
    'description',campaign.description,
    'campaign_type',campaign.campaign_type,
    'status',campaign.status,
    'objective',campaign.objective,
    'target_audience',campaign.target_audience,
    'platforms',campaign.platforms,
    'start_date',campaign.start_date,
    'end_date',campaign.end_date,
    'created_by_label',campaign.created_by_label,
    'created_at',campaign.created_at,
    'updated_at',campaign.updated_at
  ) order by campaign.start_date nulls last,campaign.name),'[]'::jsonb)
  into campaigns_json
  from atlas_private.marketing_campaigns campaign
  where campaign.status<>'cancelled';

  select coalesce(jsonb_agg(row_data.item order by row_data.sort_time,row_data.title),'[]'::jsonb)
  into content_json
  from (
    select
      coalesce(content.scheduled_for,content.reminder_at,content.created_at) as sort_time,
      content.title,
      jsonb_build_object(
        'id',content.id,
        'campaign_id',content.campaign_id,
        'campaign_name',campaign.name,
        'title',content.title,
        'content_type',content.content_type,
        'status',content.status,
        'priority',content.priority,
        'platforms',content.platforms,
        'scheduled_for',content.scheduled_for,
        'reminder_at',content.reminder_at,
        'event_starts_at',content.event_starts_at,
        'event_ends_at',content.event_ends_at,
        'suggested_format',content.suggested_format,
        'caption_draft',content.caption_draft,
        'creative_brief',content.creative_brief,
        'frames',content.frames,
        'media_requirements',content.media_requirements,
        'owner_id',content.owner_id,
        'owner_label',content.owner_label,
        'created_by',content.created_by,
        'created_by_label',content.created_by_label,
        'created_by_role',content.created_by_role,
        'published_at',content.published_at,
        'completed_at',content.completed_at,
        'external_publication_ids',content.external_publication_ids,
        'metadata',content.metadata,
        'created_at',content.created_at,
        'updated_at',content.updated_at,
        'can_edit',(
          content.status not in ('published','completed','cancelled')
          and (p_user_role in ('admin','manager') or content.created_by=p_user_id or content.owner_id=p_user_id)
        ),
        'can_approve',(p_user_role in ('admin','manager') and content.status='pending_approval'),
        'approval_history',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',approval.id,
            'decision',approval.decision,
            'actor_label',approval.actor_label,
            'actor_role',approval.actor_role,
            'note',approval.note,
            'created_at',approval.created_at
          ) order by approval.created_at)
          from atlas_private.marketing_content_approvals approval
          where approval.content_id=content.id
        ),'[]'::jsonb)
      ) as item
    from atlas_private.marketing_content_items content
    left join atlas_private.marketing_campaigns campaign on campaign.id=content.campaign_id
    where (
      content.scheduled_for::date between start_date and end_date
      or content.reminder_at::date between start_date and end_date
      or content.event_starts_at::date between start_date and end_date
      or (content.scheduled_for is null and content.status in ('idea','draft','pending_approval','changes_requested','approved'))
    )
  ) row_data;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',recommendation.id,
    'recommendation_key',recommendation.recommendation_key,
    'title',recommendation.title,
    'summary',recommendation.summary,
    'content_type',recommendation.content_type,
    'platforms',recommendation.platforms,
    'recurrence',recommendation.recurrence,
    'day_of_week',recommendation.day_of_week,
    'suggested_time',recommendation.suggested_time,
    'suggested_format',recommendation.suggested_format,
    'caption_draft',recommendation.caption_draft,
    'creative_brief',recommendation.creative_brief,
    'frames',recommendation.frames,
    'reason',recommendation.reason,
    'evidence',recommendation.evidence,
    'confidence_score',recommendation.confidence_score,
    'status',recommendation.status,
    'is_due_today',case
      when recommendation.recurrence='daily' then true
      when recommendation.recurrence='weekly' then recommendation.day_of_week=extract(dow from local_date)::smallint
      when recommendation.recurrence='one_off' then recommendation.active_from=local_date
      else false
    end,
    'metadata',recommendation.metadata
  ) order by
    case
      when recommendation.recurrence='daily' then 0
      when recommendation.recurrence='weekly' and recommendation.day_of_week=extract(dow from local_date)::smallint then 0
      else 1
    end,
    recommendation.suggested_time nulls last,
    recommendation.title),'[]'::jsonb)
  into recommendations_json
  from atlas_private.marketing_recommendations recommendation
  where recommendation.status='active'
    and (recommendation.active_from is null or recommendation.active_from<=local_date)
    and (recommendation.active_to is null or recommendation.active_to>=local_date);

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_key',connection.provider_key,
    'label',connection.label,
    'category',connection.category,
    'display_status',atlas_private.marketing_connection_display_status(
      connection.authorization_state,
      connection.publishing_permission_state,
      connection.analytics_permission_state,
      connection.token_expires_at
    ),
    'authorization_state',connection.authorization_state,
    'publishing_permission_state',connection.publishing_permission_state,
    'analytics_permission_state',connection.analytics_permission_state,
    'external_account_label',connection.external_account_label,
    'last_verified_at',connection.last_verified_at,
    'token_expires_at',connection.token_expires_at,
    'last_connection_error',connection.last_connection_error,
    'capabilities',connection.capabilities,
    'requirements',connection.requirements,
    'metadata',connection.metadata
  ) order by connection.label),'[]'::jsonb)
  into connections_json
  from atlas_private.integration_connections connection
  where connection.provider_key in ('instagram','facebook','tiktok','google-business-profile');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',content.id,
    'title',content.title,
    'content_type',content.content_type,
    'status',content.status,
    'reminder_at',content.reminder_at,
    'scheduled_for',content.scheduled_for,
    'platforms',content.platforms,
    'priority',content.priority
  ) order by content.reminder_at nulls last,content.scheduled_for nulls last),'[]'::jsonb)
  into reminders_json
  from atlas_private.marketing_content_items content
  where content.status not in ('published','completed','rejected','cancelled')
    and content.reminder_at is not null
    and content.reminder_at <= pg_catalog.now()+interval '14 days';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',event.id,
    'event_type',event.event_type,
    'campaign_id',event.campaign_id,
    'content_id',event.content_id,
    'recommendation_id',event.recommendation_id,
    'actor_label',event.actor_label,
    'actor_role',event.actor_role,
    'payload',event.payload,
    'created_at',event.created_at
  ) order by event.created_at desc),'[]'::jsonb)
  into history_json
  from (
    select * from atlas_private.marketing_workspace_events
    order by created_at desc
    limit 40
  ) event;

  select jsonb_build_object(
    'total_items',count(*)::bigint,
    'ideas',count(*) filter (where status='idea')::bigint,
    'drafts',count(*) filter (where status in ('draft','changes_requested'))::bigint,
    'awaiting_approval',count(*) filter (where status='pending_approval')::bigint,
    'approved',count(*) filter (where status in ('approved','scheduled'))::bigint,
    'published',count(*) filter (where status='published')::bigint,
    'completed',count(*) filter (where status='completed')::bigint,
    'overdue_reminders',count(*) filter (
      where reminder_at is not null
        and reminder_at<pg_catalog.now()
        and status not in ('published','completed','rejected','cancelled')
    )::bigint
  ) into stats_json
  from atlas_private.marketing_content_items;

  return jsonb_build_object(
    'version','atlas-marketing-workspace/0.1.0',
    'generated_at',pg_catalog.now(),
    'venue_date',local_date,
    'range',jsonb_build_object('start_date',start_date,'end_date',end_date),
    'stats',stats_json,
    'campaigns',campaigns_json,
    'content_items',content_json,
    'recommendations',recommendations_json,
    'reminders',reminders_json,
    'connections',connections_json,
    'history',history_json,
    'permissions',jsonb_build_object(
      'can_create',p_user_role in ('admin','manager','bartender'),
      'can_approve',p_user_role in ('admin','manager'),
      'can_mark_published',p_user_role in ('admin','manager'),
      'can_manage_connections',p_user_role in ('admin','manager')
    ),
    'trust',jsonb_build_object(
      'actual_publishing_enabled',false,
      'analytics_ingestion_enabled',false,
      'oauth_tokens_in_browser',false,
      'recommendations_shadow_only',true,
      'manager_approval_required',true,
      'history_preserved',true
    )
  );
end;
$$;

create or replace function atlas_private.marketing_create_campaign(
  p_name text,
  p_description text,
  p_campaign_type text,
  p_objective text,
  p_target_audience text,
  p_platforms text[],
  p_start_date date,
  p_end_date date,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare campaign_row atlas_private.marketing_campaigns;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can create campaigns'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Campaign name is required'; end if;
  if p_campaign_type not in ('promotion','event','seasonal','always_on','brand','other') then raise exception 'Campaign type is invalid'; end if;
  if p_end_date is not null and p_start_date is not null and p_end_date<p_start_date then raise exception 'Campaign end date cannot precede its start date'; end if;

  insert into atlas_private.marketing_campaigns (
    name,description,campaign_type,status,objective,target_audience,platforms,
    start_date,end_date,created_by,created_by_label,created_by_role,updated_by,updated_by_label
  ) values (
    trim(p_name),nullif(trim(coalesce(p_description,'')),''),p_campaign_type,'draft',
    nullif(trim(coalesce(p_objective,'')),''),nullif(trim(coalesce(p_target_audience,'')),''),coalesce(p_platforms,'{}'::text[]),
    p_start_date,p_end_date,p_actor_id,p_actor_label,p_actor_role,p_actor_id,p_actor_label
  ) returning * into campaign_row;

  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,actor_id,actor_label,actor_role,payload
  ) values (
    'campaign_created',campaign_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('name',campaign_row.name,'campaign_type',campaign_row.campaign_type)
  );
  return to_jsonb(campaign_row);
end;
$$;

create or replace function atlas_private.marketing_create_content(
  p_client_request_id uuid,
  p_campaign_id uuid,
  p_title text,
  p_content_type text,
  p_priority text,
  p_platforms text[],
  p_scheduled_for timestamptz,
  p_reminder_at timestamptz,
  p_event_starts_at timestamptz,
  p_event_ends_at timestamptz,
  p_suggested_format text,
  p_caption_draft text,
  p_creative_brief text,
  p_frames jsonb,
  p_media_requirements jsonb,
  p_owner_id uuid,
  p_owner_label text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  content_row atlas_private.marketing_content_items;
  initial_status text;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot create marketing content'; end if;
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;
  select * into content_row from atlas_private.marketing_content_items where client_request_id=p_client_request_id;
  if found then return jsonb_build_object('duplicate',true,'content',to_jsonb(content_row)); end if;
  if nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Content title is required'; end if;
  if p_content_type not in ('post','story','reel','campaign_task','event_promotion','content_idea','google_post') then raise exception 'Content type is invalid'; end if;
  if p_priority not in ('low','normal','high','urgent') then raise exception 'Priority is invalid'; end if;
  if p_event_ends_at is not null and p_event_starts_at is not null and p_event_ends_at<p_event_starts_at then raise exception 'Event end cannot precede event start'; end if;

  initial_status := case when p_content_type='content_idea' then 'idea' else 'draft' end;
  insert into atlas_private.marketing_content_items (
    client_request_id,campaign_id,title,content_type,status,priority,platforms,
    scheduled_for,reminder_at,event_starts_at,event_ends_at,suggested_format,
    caption_draft,creative_brief,frames,media_requirements,owner_id,owner_label,
    created_by,created_by_label,created_by_role,metadata
  ) values (
    p_client_request_id,p_campaign_id,trim(p_title),p_content_type,initial_status,p_priority,coalesce(p_platforms,'{}'::text[]),
    p_scheduled_for,p_reminder_at,p_event_starts_at,p_event_ends_at,nullif(trim(coalesce(p_suggested_format,'')),''),
    nullif(trim(coalesce(p_caption_draft,'')),''),nullif(trim(coalesce(p_creative_brief,'')),''),
    coalesce(p_frames,'[]'::jsonb),coalesce(p_media_requirements,'{}'::jsonb),p_owner_id,p_owner_label,
    p_actor_id,p_actor_label,p_actor_role,coalesce(p_metadata,'{}'::jsonb)
  ) returning * into content_row;

  perform atlas_private.marketing_record_revision(
    content_row.id,'create',null,to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,'Initial content draft'
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'content_created',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('title',content_row.title,'content_type',content_row.content_type,'status',content_row.status)
  );
  return jsonb_build_object('duplicate',false,'content',to_jsonb(content_row));
end;
$$;

create or replace function atlas_private.marketing_update_content(
  p_content_id uuid,
  p_campaign_id uuid,
  p_title text,
  p_priority text,
  p_platforms text[],
  p_scheduled_for timestamptz,
  p_reminder_at timestamptz,
  p_event_starts_at timestamptz,
  p_event_ends_at timestamptz,
  p_suggested_format text,
  p_caption_draft text,
  p_creative_brief text,
  p_frames jsonb,
  p_media_requirements jsonb,
  p_owner_id uuid,
  p_owner_label text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text,
  p_note text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot edit marketing content'; end if;
  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status in ('published','completed','cancelled') then raise exception 'Published, completed or cancelled content cannot be edited'; end if;
  if p_actor_role not in ('admin','manager') and previous_row.created_by is distinct from p_actor_id and previous_row.owner_id is distinct from p_actor_id then
    raise exception 'Only the owner, creator or a manager can edit this content';
  end if;
  if nullif(trim(coalesce(p_title,'')),'') is null then raise exception 'Content title is required'; end if;
  if p_priority not in ('low','normal','high','urgent') then raise exception 'Priority is invalid'; end if;
  if p_event_ends_at is not null and p_event_starts_at is not null and p_event_ends_at<p_event_starts_at then raise exception 'Event end cannot precede event start'; end if;

  update atlas_private.marketing_content_items
  set campaign_id=p_campaign_id,
      title=trim(p_title),
      priority=p_priority,
      platforms=coalesce(p_platforms,'{}'::text[]),
      scheduled_for=p_scheduled_for,
      reminder_at=p_reminder_at,
      event_starts_at=p_event_starts_at,
      event_ends_at=p_event_ends_at,
      suggested_format=nullif(trim(coalesce(p_suggested_format,'')),''),
      caption_draft=nullif(trim(coalesce(p_caption_draft,'')),''),
      creative_brief=nullif(trim(coalesce(p_creative_brief,'')),''),
      frames=coalesce(p_frames,'[]'::jsonb),
      media_requirements=coalesce(p_media_requirements,'{}'::jsonb),
      owner_id=p_owner_id,
      owner_label=p_owner_label,
      status=case when status='changes_requested' then 'draft' else status end
  where id=p_content_id
  returning * into content_row;

  perform atlas_private.marketing_record_revision(
    content_row.id,'edit',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'content_updated',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('title',content_row.title,'status',content_row.status,'note',p_note)
  );
  return to_jsonb(content_row);
end;
$$;

create or replace function atlas_private.marketing_submit_approval(
  p_content_id uuid,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
  approval_row atlas_private.marketing_content_approvals;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot submit marketing content'; end if;
  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status not in ('idea','draft','changes_requested','approved') then raise exception 'This content cannot be submitted from its current state'; end if;
  if p_actor_role not in ('admin','manager') and previous_row.created_by is distinct from p_actor_id and previous_row.owner_id is distinct from p_actor_id then
    raise exception 'Only the owner, creator or a manager can submit this content';
  end if;

  update atlas_private.marketing_content_items set status='pending_approval' where id=p_content_id returning * into content_row;
  insert into atlas_private.marketing_content_approvals (content_id,decision,actor_id,actor_label,actor_role,note)
  values (p_content_id,'submitted',p_actor_id,p_actor_label,p_actor_role,nullif(trim(coalesce(p_note,'')),''))
  returning * into approval_row;

  perform atlas_private.marketing_record_revision(
    p_content_id,'approval',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'approval_submitted',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('approval_id',approval_row.id,'note',p_note)
  );
  return jsonb_build_object('content',to_jsonb(content_row),'approval',to_jsonb(approval_row));
end;
$$;

create or replace function atlas_private.marketing_decide_approval(
  p_content_id uuid,
  p_decision text,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
  approval_row atlas_private.marketing_content_approvals;
  next_status text;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can approve marketing content'; end if;
  if p_decision not in ('approved','changes_requested','rejected') then raise exception 'Approval decision is invalid'; end if;
  if p_decision<>'approved' and nullif(trim(coalesce(p_note,'')),'') is null then raise exception 'A note is required for changes or rejection'; end if;

  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status<>'pending_approval' then raise exception 'Content is not awaiting approval'; end if;

  next_status := case
    when p_decision='approved' and previous_row.scheduled_for is not null then 'scheduled'
    when p_decision='approved' then 'approved'
    when p_decision='changes_requested' then 'changes_requested'
    else 'rejected'
  end;

  update atlas_private.marketing_content_items set status=next_status where id=p_content_id returning * into content_row;
  insert into atlas_private.marketing_content_approvals (content_id,decision,actor_id,actor_label,actor_role,note)
  values (p_content_id,p_decision,p_actor_id,p_actor_label,p_actor_role,nullif(trim(coalesce(p_note,'')),''))
  returning * into approval_row;

  perform atlas_private.marketing_record_revision(
    p_content_id,'approval',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'approval_decided',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('decision',p_decision,'approval_id',approval_row.id,'note',p_note)
  );
  return jsonb_build_object('content',to_jsonb(content_row),'approval',to_jsonb(approval_row));
end;
$$;

create or replace function atlas_private.marketing_mark_published(
  p_content_id uuid,
  p_published_at timestamptz,
  p_external_publication_ids jsonb,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can mark content published'; end if;
  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status not in ('approved','scheduled') then raise exception 'Only approved or scheduled content can be marked published'; end if;

  update atlas_private.marketing_content_items
  set status='published',published_at=coalesce(p_published_at,pg_catalog.now()),
      external_publication_ids=coalesce(p_external_publication_ids,'{}'::jsonb)
  where id=p_content_id returning * into content_row;

  perform atlas_private.marketing_record_revision(
    p_content_id,'publication',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'content_published',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('published_at',content_row.published_at,'platforms',content_row.platforms,'note',p_note)
  );
  return to_jsonb(content_row);
end;
$$;

create or replace function atlas_private.marketing_mark_completed(
  p_content_id uuid,
  p_note text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  previous_row atlas_private.marketing_content_items;
  content_row atlas_private.marketing_content_items;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot complete marketing tasks'; end if;
  select * into previous_row from atlas_private.marketing_content_items where id=p_content_id for update;
  if not found then raise exception 'Marketing content not found'; end if;
  if previous_row.status in ('completed','cancelled','rejected') then raise exception 'This content is already final'; end if;
  if previous_row.content_type not in ('campaign_task','event_promotion') and p_actor_role not in ('admin','manager') then
    raise exception 'Only managers can complete non-task content';
  end if;

  update atlas_private.marketing_content_items
  set status='completed',completed_at=pg_catalog.now()
  where id=p_content_id returning * into content_row;

  perform atlas_private.marketing_record_revision(
    p_content_id,'completion',to_jsonb(previous_row),to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,p_note
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,campaign_id,content_id,actor_id,actor_label,actor_role,payload
  ) values (
    'content_completed',content_row.campaign_id,content_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('note',p_note)
  );
  return to_jsonb(content_row);
end;
$$;

create or replace function atlas_private.marketing_convert_recommendation(
  p_recommendation_id uuid,
  p_client_request_id uuid,
  p_scheduled_for timestamptz,
  p_reminder_at timestamptz,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  recommendation_row atlas_private.marketing_recommendations;
  content_row atlas_private.marketing_content_items;
begin
  if p_actor_role not in ('admin','manager','bartender') then raise exception 'This role cannot convert a recommendation'; end if;
  if p_client_request_id is null then raise exception 'Client request ID is required'; end if;

  select * into content_row from atlas_private.marketing_content_items where client_request_id=p_client_request_id;
  if found then return jsonb_build_object('duplicate',true,'content',to_jsonb(content_row)); end if;

  select * into recommendation_row
  from atlas_private.marketing_recommendations
  where id=p_recommendation_id
  for update;
  if not found then raise exception 'Marketing recommendation not found'; end if;
  if recommendation_row.status<>'active' then raise exception 'Marketing recommendation is no longer active'; end if;

  insert into atlas_private.marketing_content_items (
    client_request_id,title,content_type,status,priority,platforms,scheduled_for,reminder_at,
    suggested_format,caption_draft,creative_brief,frames,media_requirements,owner_id,owner_label,
    created_by,created_by_label,created_by_role,metadata
  ) values (
    p_client_request_id,recommendation_row.title,recommendation_row.content_type,'draft','normal',recommendation_row.platforms,
    p_scheduled_for,p_reminder_at,recommendation_row.suggested_format,recommendation_row.caption_draft,
    recommendation_row.creative_brief,recommendation_row.frames,'{}'::jsonb,p_actor_id,p_actor_label,
    p_actor_id,p_actor_label,p_actor_role,
    recommendation_row.metadata || jsonb_build_object('source_recommendation_id',recommendation_row.id,'source_recommendation_key',recommendation_row.recommendation_key)
  ) returning * into content_row;

  update atlas_private.marketing_recommendations
  set status='converted',converted_content_id=content_row.id,converted_at=pg_catalog.now(),
      converted_by=p_actor_id,converted_by_label=p_actor_label
  where id=recommendation_row.id;

  perform atlas_private.marketing_record_revision(
    content_row.id,'create',null,to_jsonb(content_row),p_actor_id,p_actor_label,p_actor_role,'Converted from Atlas recommendation'
  );
  insert into atlas_private.marketing_workspace_events (
    event_type,content_id,recommendation_id,actor_id,actor_label,actor_role,payload
  ) values (
    'recommendation_converted',content_row.id,recommendation_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('recommendation_key',recommendation_row.recommendation_key,'scheduled_for',p_scheduled_for)
  );
  return jsonb_build_object('duplicate',false,'content',to_jsonb(content_row),'recommendation',to_jsonb(recommendation_row));
end;
$$;

create or replace function atlas_private.marketing_dismiss_recommendation(
  p_recommendation_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare recommendation_row atlas_private.marketing_recommendations;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can dismiss marketing recommendations'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A dismiss reason is required'; end if;
  update atlas_private.marketing_recommendations
  set status='dismissed',dismissed_at=pg_catalog.now(),dismissed_by=p_actor_id,
      dismissed_by_label=p_actor_label,dismiss_reason=trim(p_reason)
  where id=p_recommendation_id and status='active'
  returning * into recommendation_row;
  if not found then raise exception 'Marketing recommendation is not active'; end if;

  insert into atlas_private.marketing_workspace_events (
    event_type,recommendation_id,actor_id,actor_label,actor_role,payload
  ) values (
    'recommendation_dismissed',recommendation_row.id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('recommendation_key',recommendation_row.recommendation_key,'reason',p_reason)
  );
  return to_jsonb(recommendation_row);
end;
$$;

create or replace function public.atlas_marketing_workspace_snapshot(
  p_user_id uuid,p_user_role text,p_start_date date,p_end_date date
)
returns jsonb language sql stable security invoker set search_path=''
as $$ select atlas_private.marketing_workspace_snapshot(p_user_id,p_user_role,p_start_date,p_end_date); $$;

create or replace function public.atlas_marketing_create_campaign(
  p_name text,p_description text,p_campaign_type text,p_objective text,p_target_audience text,p_platforms text[],p_start_date date,p_end_date date,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_create_campaign(p_name,p_description,p_campaign_type,p_objective,p_target_audience,p_platforms,p_start_date,p_end_date,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_marketing_create_content(
  p_client_request_id uuid,p_campaign_id uuid,p_title text,p_content_type text,p_priority text,p_platforms text[],p_scheduled_for timestamptz,p_reminder_at timestamptz,
  p_event_starts_at timestamptz,p_event_ends_at timestamptz,p_suggested_format text,p_caption_draft text,p_creative_brief text,p_frames jsonb,p_media_requirements jsonb,
  p_owner_id uuid,p_owner_label text,p_actor_id uuid,p_actor_label text,p_actor_role text,p_metadata jsonb
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_create_content(p_client_request_id,p_campaign_id,p_title,p_content_type,p_priority,p_platforms,p_scheduled_for,p_reminder_at,p_event_starts_at,p_event_ends_at,p_suggested_format,p_caption_draft,p_creative_brief,p_frames,p_media_requirements,p_owner_id,p_owner_label,p_actor_id,p_actor_label,p_actor_role,p_metadata); $$;

create or replace function public.atlas_marketing_update_content(
  p_content_id uuid,p_campaign_id uuid,p_title text,p_priority text,p_platforms text[],p_scheduled_for timestamptz,p_reminder_at timestamptz,p_event_starts_at timestamptz,
  p_event_ends_at timestamptz,p_suggested_format text,p_caption_draft text,p_creative_brief text,p_frames jsonb,p_media_requirements jsonb,p_owner_id uuid,p_owner_label text,
  p_actor_id uuid,p_actor_label text,p_actor_role text,p_note text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_update_content(p_content_id,p_campaign_id,p_title,p_priority,p_platforms,p_scheduled_for,p_reminder_at,p_event_starts_at,p_event_ends_at,p_suggested_format,p_caption_draft,p_creative_brief,p_frames,p_media_requirements,p_owner_id,p_owner_label,p_actor_id,p_actor_label,p_actor_role,p_note); $$;

create or replace function public.atlas_marketing_submit_approval(
  p_content_id uuid,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_submit_approval(p_content_id,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_marketing_decide_approval(
  p_content_id uuid,p_decision text,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_decide_approval(p_content_id,p_decision,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_marketing_mark_published(
  p_content_id uuid,p_published_at timestamptz,p_external_publication_ids jsonb,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_mark_published(p_content_id,p_published_at,p_external_publication_ids,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_marketing_mark_completed(
  p_content_id uuid,p_note text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_mark_completed(p_content_id,p_note,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_marketing_convert_recommendation(
  p_recommendation_id uuid,p_client_request_id uuid,p_scheduled_for timestamptz,p_reminder_at timestamptz,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_convert_recommendation(p_recommendation_id,p_client_request_id,p_scheduled_for,p_reminder_at,p_actor_id,p_actor_label,p_actor_role); $$;

create or replace function public.atlas_marketing_dismiss_recommendation(
  p_recommendation_id uuid,p_reason text,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.marketing_dismiss_recommendation(p_recommendation_id,p_reason,p_actor_id,p_actor_label,p_actor_role); $$;

revoke execute on function public.atlas_marketing_workspace_snapshot(uuid,text,date,date) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_create_campaign(text,text,text,text,text,text[],date,date,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_create_content(uuid,uuid,text,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,jsonb) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_update_content(uuid,uuid,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_submit_approval(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_decide_approval(uuid,text,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_mark_published(uuid,timestamptz,jsonb,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_mark_completed(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_convert_recommendation(uuid,uuid,timestamptz,timestamptz,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_marketing_dismiss_recommendation(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_marketing_workspace_snapshot(uuid,text,date,date) to service_role;
grant execute on function public.atlas_marketing_create_campaign(text,text,text,text,text,text[],date,date,uuid,text,text) to service_role;
grant execute on function public.atlas_marketing_create_content(uuid,uuid,text,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,jsonb) to service_role;
grant execute on function public.atlas_marketing_update_content(uuid,uuid,text,text,text[],timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,jsonb,jsonb,uuid,text,uuid,text,text,text) to service_role;
grant execute on function public.atlas_marketing_submit_approval(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_marketing_decide_approval(uuid,text,text,uuid,text,text) to service_role;
grant execute on function public.atlas_marketing_mark_published(uuid,timestamptz,jsonb,text,uuid,text,text) to service_role;
grant execute on function public.atlas_marketing_mark_completed(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_marketing_convert_recommendation(uuid,uuid,timestamptz,timestamptz,uuid,text,text) to service_role;
grant execute on function public.atlas_marketing_dismiss_recommendation(uuid,text,uuid,text,text) to service_role;

comment on table atlas_private.marketing_content_items is 'Private VÁ content calendar, draft, reminder, approval and publication history.';
comment on table atlas_private.marketing_recommendations is 'Deterministic shadow recommendations that must be converted and approved by staff before use.';
comment on function public.atlas_marketing_workspace_snapshot(uuid,text,date,date) is 'Service-role-only Marketing workspace snapshot. Browser publishing and analytics remain disabled.';
