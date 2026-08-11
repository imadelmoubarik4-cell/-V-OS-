-- Checkpoint E.1 — private profile portraits.
-- Images are stored in a dedicated non-public bucket. Browser clients never
-- receive direct object permissions; the authenticated gateway issues short-
-- lived signed display URLs after revalidating the active VÁ profile.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'atlas-profile-photos',
  'atlas-profile-photos',
  false,
  2097152,
  array['image/webp','image/jpeg','image/png']::text[]
)
on conflict (id) do update set
  name=excluded.name,
  public=false,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types,
  updated_at=now();

create table if not exists atlas_private.team_profile_photos (
  profile_id uuid primary key,
  bucket_id text not null default 'atlas-profile-photos',
  storage_path text not null unique,
  mime_type text not null,
  byte_size integer not null,
  width integer,
  height integer,
  version uuid not null default gen_random_uuid(),
  uploaded_by uuid,
  uploaded_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (bucket_id='atlas-profile-photos'),
  check (storage_path ~ '^profiles/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|jpg|jpeg|png)$'),
  check (mime_type in ('image/webp','image/jpeg','image/png')),
  check (byte_size between 1 and 2097152),
  check (width is null or width between 64 and 2048),
  check (height is null or height between 64 and 2048)
);

create index if not exists team_profile_photos_updated_idx
  on atlas_private.team_profile_photos(updated_at desc);

alter table atlas_private.team_profile_photos enable row level security;

drop policy if exists "service role manages team profile photos" on atlas_private.team_profile_photos;
create policy "service role manages team profile photos"
  on atlas_private.team_profile_photos
  for all
  to service_role
  using (true)
  with check (true);

revoke all on atlas_private.team_profile_photos from public,anon,authenticated;
grant all on atlas_private.team_profile_photos to service_role;

drop trigger if exists team_profile_photos_touch on atlas_private.team_profile_photos;
create trigger team_profile_photos_touch
before update on atlas_private.team_profile_photos
for each row execute function atlas_private.touch_updated_at();

alter table atlas_private.team_profile_events
  drop constraint if exists team_profile_events_event_type_check;

alter table atlas_private.team_profile_events
  add constraint team_profile_events_event_type_check
  check (event_type in (
    'profile_details_updated',
    'display_name_changed',
    'role_changed',
    'active_status_changed',
    'emergency_contact_saved',
    'emergency_contact_removed',
    'onboarding_status_changed',
    'profile_photo_updated',
    'profile_photo_removed'
  ));

create or replace function atlas_private.team_profile_photos_snapshot(
  p_profile_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'profile_id',photo.profile_id,
    'bucket_id',photo.bucket_id,
    'storage_path',photo.storage_path,
    'mime_type',photo.mime_type,
    'byte_size',photo.byte_size,
    'width',photo.width,
    'height',photo.height,
    'version',photo.version,
    'updated_at',photo.updated_at
  ) order by photo.updated_at desc),'[]'::jsonb)
  from atlas_private.team_profile_photos photo
  where coalesce(cardinality(p_profile_ids),0)>0
    and photo.profile_id=any(p_profile_ids);
$$;

create or replace function atlas_private.team_profile_photo_upsert(
  p_profile_id uuid,
  p_bucket_id text,
  p_storage_path text,
  p_mime_type text,
  p_byte_size integer,
  p_width integer,
  p_height integer,
  p_version uuid,
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
  existing_row atlas_private.team_profile_photos;
  saved_row atlas_private.team_profile_photos;
begin
  if p_profile_id is null or p_actor_id is null then
    raise exception 'Profile and actor are required';
  end if;
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'Actor role is invalid';
  end if;
  if p_actor_role not in ('admin','manager') and p_profile_id<>p_actor_id then
    raise exception 'Staff may change only their own profile photo';
  end if;
  if p_bucket_id<>'atlas-profile-photos' then
    raise exception 'Profile photo bucket is invalid';
  end if;
  if p_storage_path !~ ('^profiles/'||p_profile_id::text||'/[0-9a-f-]{36}\.(webp|jpg|jpeg|png)$') then
    raise exception 'Profile photo path is invalid';
  end if;
  if p_mime_type not in ('image/webp','image/jpeg','image/png') then
    raise exception 'Profile photo type is invalid';
  end if;
  if p_byte_size is null or p_byte_size<1 or p_byte_size>2097152 then
    raise exception 'Profile photo must be no larger than 2 MB';
  end if;
  if p_width is not null and (p_width<64 or p_width>2048) then
    raise exception 'Profile photo width is invalid';
  end if;
  if p_height is not null and (p_height<64 or p_height>2048) then
    raise exception 'Profile photo height is invalid';
  end if;

  select * into existing_row
  from atlas_private.team_profile_photos
  where profile_id=p_profile_id
  for update;

  insert into atlas_private.team_profile_photos (
    profile_id,bucket_id,storage_path,mime_type,byte_size,width,height,version,
    uploaded_by,uploaded_by_label
  ) values (
    p_profile_id,p_bucket_id,p_storage_path,p_mime_type,p_byte_size,p_width,p_height,
    coalesce(p_version,gen_random_uuid()),p_actor_id,p_actor_label
  )
  on conflict (profile_id) do update set
    bucket_id=excluded.bucket_id,
    storage_path=excluded.storage_path,
    mime_type=excluded.mime_type,
    byte_size=excluded.byte_size,
    width=excluded.width,
    height=excluded.height,
    version=excluded.version,
    uploaded_by=excluded.uploaded_by,
    uploaded_by_label=excluded.uploaded_by_label,
    updated_at=pg_catalog.now()
  returning * into saved_row;

  insert into atlas_private.team_profile_events (
    event_type,profile_id,actor_id,actor_label,actor_role,payload
  ) values (
    'profile_photo_updated',p_profile_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'previous_storage_path',existing_row.storage_path,
      'storage_path',saved_row.storage_path,
      'mime_type',saved_row.mime_type,
      'byte_size',saved_row.byte_size,
      'width',saved_row.width,
      'height',saved_row.height,
      'version',saved_row.version
    )
  );

  return jsonb_build_object(
    'photo',to_jsonb(saved_row),
    'previous_storage_path',existing_row.storage_path
  );
end;
$$;

create or replace function atlas_private.team_profile_photo_remove(
  p_profile_id uuid,
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
  removed_row atlas_private.team_profile_photos;
begin
  if p_profile_id is null or p_actor_id is null then
    raise exception 'Profile and actor are required';
  end if;
  if p_actor_role not in ('admin','manager','bartender','viewer') then
    raise exception 'Actor role is invalid';
  end if;
  if p_actor_role not in ('admin','manager') and p_profile_id<>p_actor_id then
    raise exception 'Staff may remove only their own profile photo';
  end if;

  delete from atlas_private.team_profile_photos
  where profile_id=p_profile_id
  returning * into removed_row;

  if not found then
    return jsonb_build_object('removed',false,'profile_id',p_profile_id);
  end if;

  insert into atlas_private.team_profile_events (
    event_type,profile_id,actor_id,actor_label,actor_role,payload
  ) values (
    'profile_photo_removed',p_profile_id,p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object(
      'storage_path',removed_row.storage_path,
      'mime_type',removed_row.mime_type,
      'byte_size',removed_row.byte_size,
      'version',removed_row.version
    )
  );

  return jsonb_build_object(
    'removed',true,
    'photo',to_jsonb(removed_row)
  );
end;
$$;

create or replace function public.atlas_team_profile_photos_snapshot(
  p_profile_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select atlas_private.team_profile_photos_snapshot(p_profile_ids);
$$;

create or replace function public.atlas_team_profile_photo_upsert(
  p_profile_id uuid,p_bucket_id text,p_storage_path text,p_mime_type text,
  p_byte_size integer,p_width integer,p_height integer,p_version uuid,
  p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.team_profile_photo_upsert(
    p_profile_id,p_bucket_id,p_storage_path,p_mime_type,p_byte_size,p_width,p_height,
    p_version,p_actor_id,p_actor_label,p_actor_role
  );
$$;

create or replace function public.atlas_team_profile_photo_remove(
  p_profile_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language sql
volatile
security invoker
set search_path=''
as $$
  select atlas_private.team_profile_photo_remove(
    p_profile_id,p_actor_id,p_actor_label,p_actor_role
  );
$$;

revoke execute on function public.atlas_team_profile_photos_snapshot(uuid[]) from public,anon,authenticated;
revoke execute on function public.atlas_team_profile_photo_upsert(uuid,text,text,text,integer,integer,integer,uuid,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_team_profile_photo_remove(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_team_profile_photos_snapshot(uuid[]) to service_role;
grant execute on function public.atlas_team_profile_photo_upsert(uuid,text,text,text,integer,integer,integer,uuid,uuid,text,text) to service_role;
grant execute on function public.atlas_team_profile_photo_remove(uuid,uuid,text,text) to service_role;

comment on table atlas_private.team_profile_photos is 'Private metadata for staff profile photos stored in the atlas-profile-photos bucket.';
comment on function public.atlas_team_profile_photos_snapshot(uuid[]) is 'Service-role-only profile-photo metadata lookup. The gateway supplies only profile IDs visible to the caller.';
