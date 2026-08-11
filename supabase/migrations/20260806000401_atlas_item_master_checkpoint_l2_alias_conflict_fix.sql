-- Complete the Checkpoint L2 publication ledger and use a distinctly named
-- barcode variable so conflict checks compare column-to-value deterministically.

create or replace function atlas_private.item_master_complete_publication(
  p_publication_id uuid,
  p_status text,
  p_applied_values jsonb,
  p_failure_message text,
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
  publication_row atlas_private.item_master_publications;
  draft_row atlas_private.item_master_drafts;
  alias_entry jsonb;
  v_raw_code text;
  v_normalized_code text;
  conflicting_item uuid;
begin
  if p_actor_role not in ('admin','manager') then raise exception 'Only managers can complete item-master publication'; end if;
  if p_status not in ('published','failed') then raise exception 'Publication result is invalid'; end if;
  if jsonb_typeof(coalesce(p_applied_values,'{}'::jsonb)) <> 'object' then raise exception 'Applied item-master values must be an object'; end if;

  select * into publication_row from atlas_private.item_master_publications where id=p_publication_id for update;
  if not found then raise exception 'Item-master publication not found'; end if;
  if publication_row.status='published' then return to_jsonb(publication_row); end if;
  if publication_row.status not in ('ready','publishing','failed') then raise exception 'Item-master publication is not ready for completion'; end if;

  select * into draft_row from atlas_private.item_master_drafts where id=publication_row.draft_id for update;

  if p_status='published' then
    for alias_entry in select value from jsonb_array_elements(publication_row.proposed_barcode_aliases) loop
      v_raw_code := trim(alias_entry->>'code');
      v_normalized_code := regexp_replace(lower(v_raw_code),'[^a-z0-9]','','g');
      select alias_row.external_item_id into conflicting_item
      from atlas_private.inventory_scan_aliases alias_row
      where alias_row.normalized_code=v_normalized_code
      limit 1;
      if conflicting_item is not null and conflicting_item <> publication_row.external_item_id then
        raise exception 'Barcode alias % is already linked to another inventory item',v_raw_code;
      end if;

      insert into atlas_private.inventory_scan_aliases (
        normalized_code,raw_code,symbology,external_item_id,external_item_name,
        external_item_category,external_item_unit,active,verified,linked_by,
        linked_by_label,linked_at,metadata
      ) values (
        v_normalized_code,v_raw_code,coalesce(nullif(trim(alias_entry->>'symbology'),''),'unknown'),
        publication_row.external_item_id,draft_row.item_name,draft_row.category,
        draft_row.source_snapshot->>'unit',true,true,p_actor_id,p_actor_label,now(),
        jsonb_build_object('source','checkpoint_l2_item_master','publication_id',publication_row.id)
      )
      on conflict (normalized_code) do update
      set raw_code=excluded.raw_code,symbology=excluded.symbology,
          external_item_name=excluded.external_item_name,external_item_category=excluded.external_item_category,
          external_item_unit=excluded.external_item_unit,active=true,verified=true,
          linked_by=excluded.linked_by,linked_by_label=excluded.linked_by_label,
          linked_at=excluded.linked_at,
          metadata=atlas_private.inventory_scan_aliases.metadata || excluded.metadata,
          updated_at=now();
    end loop;
  end if;

  update atlas_private.item_master_publications
  set status=p_status,
      published_by=case when p_status='published' then p_actor_id else published_by end,
      published_by_label=case when p_status='published' then p_actor_label else published_by_label end,
      published_at=case when p_status='published' then now() else published_at end,
      applied_values=coalesce(p_applied_values,'{}'::jsonb),
      failure_message=case when p_status='failed' then nullif(trim(coalesce(p_failure_message,'')),'') else null end,
      updated_at=now()
  where id=publication_row.id returning * into publication_row;

  update atlas_private.item_master_drafts
  set status=case when p_status='published' then 'published' else 'draft' end,
      version=version+1,updated_by=p_actor_id,updated_by_label=p_actor_label,updated_at=now()
  where id=publication_row.draft_id;

  insert into atlas_private.item_master_events (
    event_type,draft_id,publication_id,external_item_id,actor_id,actor_label,actor_role,payload
  ) values (
    case when p_status='published' then 'publication_published' else 'publication_failed' end,
    publication_row.draft_id,publication_row.id,publication_row.external_item_id,
    p_actor_id,p_actor_label,p_actor_role,
    jsonb_build_object('request_id',publication_row.request_id,'applied_values',publication_row.applied_values,'failure_message',publication_row.failure_message)
  );
  return to_jsonb(publication_row);
end;
$$;

create or replace function public.atlas_item_master_complete_publication(uuid,text,jsonb,text,uuid,text,text)
returns jsonb language sql volatile security invoker set search_path=''
as $$ select atlas_private.item_master_complete_publication($1,$2,$3,$4,$5,$6,$7); $$;

revoke execute on function public.atlas_item_master_complete_publication(uuid,text,jsonb,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.atlas_item_master_complete_publication(uuid,text,jsonb,text,uuid,text,text) to service_role;
