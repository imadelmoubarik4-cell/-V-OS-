-- Paired cleanup for the preview-only Real VA checkpoint transfer transport.
--
-- The marker exists only when the preceding enable migration installed pg_net.
-- A project that already had pg_net is left unchanged. Production remains a
-- no-op because it has no Atlas private staging model and therefore no marker.

do $preview_transfer_cleanup$
begin
  if to_regclass('atlas_private.p20_transfer_extension_marker') is null then
    return;
  end if;

  execute 'drop extension if exists pg_net';
  drop table if exists atlas_private.p20_transfer_extension_marker;
end
$preview_transfer_cleanup$;
