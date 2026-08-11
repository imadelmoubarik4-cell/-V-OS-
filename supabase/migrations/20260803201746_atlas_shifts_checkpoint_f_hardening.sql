-- Avoid writing a profile-sync audit event on every Shifts snapshot when the
-- production staff roster has not changed. Also cover the shift-event foreign
-- key path reported by the database advisor.

create index if not exists shift_events_shift_created_idx
  on atlas_private.shift_events(shift_id,created_at desc)
  where shift_id is not null;

create or replace function atlas_private.shift_sync_profiles(
  p_profiles jsonb,
  p_actor_id uuid,
  p_actor_label text,
  p_actor_role text
)
returns bigint
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare
  changed_count bigint := 0;
begin
  if jsonb_typeof(coalesce(p_profiles,'[]'::jsonb))<>'array' then
    raise exception 'Profiles payload must be an array';
  end if;

  insert into atlas_private.shift_people (
    id,profile_id,display_name,email,default_role,active,login_enabled,source,
    created_by,created_by_label,updated_by,updated_by_label
  )
  select
    profile.id,
    profile.id,
    coalesce(
      nullif(trim(profile.display_name),''),
      nullif(split_part(coalesce(profile.email,''),'@',1),''),
      'Team member'
    ),
    nullif(trim(profile.email),''),
    case profile.role
      when 'admin' then 'Manager'
      when 'manager' then 'Manager'
      when 'bartender' then 'Bartender'
      else 'Team'
    end,
    coalesce(profile.active,false),
    true,
    'profile',
    p_actor_id,p_actor_label,p_actor_id,p_actor_label
  from jsonb_to_recordset(coalesce(p_profiles,'[]'::jsonb)) as profile(
    id uuid,email text,display_name text,role text,active boolean
  )
  where profile.id is not null
  on conflict (id) do update set
    profile_id=excluded.profile_id,
    display_name=excluded.display_name,
    email=excluded.email,
    default_role=excluded.default_role,
    active=excluded.active,
    login_enabled=true,
    source='profile',
    updated_by=p_actor_id,
    updated_by_label=p_actor_label,
    updated_at=pg_catalog.now()
  where (
    atlas_private.shift_people.profile_id,
    atlas_private.shift_people.display_name,
    atlas_private.shift_people.email,
    atlas_private.shift_people.default_role,
    atlas_private.shift_people.active,
    atlas_private.shift_people.login_enabled,
    atlas_private.shift_people.source
  ) is distinct from (
    excluded.profile_id,
    excluded.display_name,
    excluded.email,
    excluded.default_role,
    excluded.active,
    excluded.login_enabled,
    excluded.source
  );
  get diagnostics changed_count=row_count;

  if changed_count>0 then
    insert into atlas_private.shift_events (
      event_type,actor_id,actor_label,actor_role,payload
    ) values (
      'profiles_synced',p_actor_id,p_actor_label,p_actor_role,
      jsonb_build_object(
        'profile_count',jsonb_array_length(coalesce(p_profiles,'[]'::jsonb)),
        'changed_count',changed_count
      )
    );
  end if;

  return changed_count;
end;
$$;
