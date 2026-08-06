-- Preview-only transport used to restore the preserved Real VA review checkpoint.
--
-- Production has no atlas_private staging schema, so this migration is an
-- intentional production no-op. On an Atlas preview that has the private review
-- model, it enables pg_net only when that extension was not already installed
-- and leaves a private marker so the paired cleanup migration removes only the
-- extension created by this transfer sequence.

do $preview_transfer_enable$
begin
  if to_regclass('atlas_private.import_batches') is null then
    return;
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    create table if not exists atlas_private.p20_transfer_extension_marker (
      marker boolean primary key default true check (marker)
    );
    revoke all on atlas_private.p20_transfer_extension_marker from public, anon, authenticated;
    grant all on atlas_private.p20_transfer_extension_marker to service_role;
    execute 'create extension pg_net with schema extensions';
  end if;
end
$preview_transfer_enable$;
