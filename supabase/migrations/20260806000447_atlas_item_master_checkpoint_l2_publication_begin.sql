-- Add the explicit manager publication start boundary. A blocked preview plan
-- cannot cross this function because production_apply_enabled remains false.

alter table atlas_private.item_master_events drop constraint if exists item_master_events_event_type_check;
alter table atlas_private.item_master_events add constraint item_master_events_event_type_check check (event_type in (
  'draft_saved','publication_prepared','publication_blocked','publication_started',
  'publication_published','publication_failed'
));

create or replace function atlas_private.item_master_begin_publication(
  p_publication_id uuid,p_actor_id uuid,p_actor_label text,p_actor_role text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path=''
as $$
declare publication_row atlas_private.item_master_publications;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can begin item-master publication'; end if;
  select * into publication_row from atlas_private.item_master_publications where id=p_publication_id for update;
  if not found then raise exception 'Item-master publication not found'; end if;
  if publication_row.status='published' then return to_jsonb(publication_row); end if;
  if publication_row.status <> 'ready' then raise exception 'Item-master publication is not ready'; end if;
  if not publication_row.production_apply_enabled then raise exception 'Production item-master publication is disabled'; end if;

  update atlas_private.item_master_publications set status='publishing',updated_at=now()
  where id=publication_row.id returning * into publication_row;
  insert into atlas_private.item_master_events (event_type,draft_id,publication_id,external_item_id,actor_id,actor_label,actor_role,payload)
  values ('publication_started',publication_row.draft_id,publication_row.id,publication_row.external_item_id,
    p_actor_id,p_actor_label,p_actor_role,jsonb_build_object('request_id',publication_row.request_id));
  return to_jsonb(publication_row);
end;
$$;

create or replace function public.atlas_item_master_begin_publication(uuid,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.item_master_begin_publication($1,$2,$3,$4); $$;
revoke execute on function public.atlas_item_master_begin_publication(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_item_master_begin_publication(uuid,uuid,text,text) to service_role;
