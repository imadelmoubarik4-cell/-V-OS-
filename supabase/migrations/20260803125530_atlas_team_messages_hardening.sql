-- Checkpoint C defense-in-depth hardening.
-- The authoritative authorization decision remains the active production profile
-- verified by the Edge Function on every request. These statements keep the
-- private branch inaccessible to browser roles even if Data API exposure changes.

alter table atlas_private.team_channels enable row level security;
alter table atlas_private.team_messages enable row level security;
alter table atlas_private.team_message_revisions enable row level security;
alter table atlas_private.team_channel_reads enable row level security;
alter table atlas_private.team_message_events enable row level security;

revoke all on atlas_private.team_channels from public,anon,authenticated;
revoke all on atlas_private.team_messages from public,anon,authenticated;
revoke all on atlas_private.team_message_revisions from public,anon,authenticated;
revoke all on atlas_private.team_channel_reads from public,anon,authenticated;
revoke all on atlas_private.team_message_events from public,anon,authenticated;

grant all on atlas_private.team_channels to service_role;
grant all on atlas_private.team_messages to service_role;
grant all on atlas_private.team_message_revisions to service_role;
grant all on atlas_private.team_channel_reads to service_role;
grant all on atlas_private.team_message_events to service_role;

create index if not exists team_messages_channel_created_idx
  on atlas_private.team_messages(channel_id,created_at desc);
create index if not exists team_messages_sender_created_idx
  on atlas_private.team_messages(sender_id,created_at desc)
  where sender_id is not null;
create index if not exists team_message_revisions_message_idx
  on atlas_private.team_message_revisions(message_id,revision_number desc);
create index if not exists team_channel_reads_last_message_idx
  on atlas_private.team_channel_reads(last_read_message_id)
  where last_read_message_id is not null;
create index if not exists team_message_events_message_idx
  on atlas_private.team_message_events(message_id,created_at desc)
  where message_id is not null;
create index if not exists team_message_events_channel_idx
  on atlas_private.team_message_events(channel_id,created_at desc)
  where channel_id is not null;

revoke execute on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) from public,anon,authenticated;
revoke execute on function public.atlas_team_messages_send(text,text,uuid,text,text,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
revoke execute on function public.atlas_team_messages_edit(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_team_messages_delete(uuid,text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.atlas_team_messages_mark_read(text,uuid,text,text) from public,anon,authenticated;

grant execute on function public.atlas_team_messages_snapshot(uuid,text,uuid[],text,integer) to service_role;
grant execute on function public.atlas_team_messages_send(text,text,uuid,text,text,uuid,text,text,text,text,jsonb) to service_role;
grant execute on function public.atlas_team_messages_edit(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_team_messages_delete(uuid,text,uuid,text,text) to service_role;
grant execute on function public.atlas_team_messages_mark_read(text,uuid,text,text) to service_role;
