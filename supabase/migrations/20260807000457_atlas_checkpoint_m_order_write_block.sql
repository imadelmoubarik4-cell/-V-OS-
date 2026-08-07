-- Reconcile the applied Atlas private migration that keeps supplier/order writes
-- explicitly blocked until a separately reviewed future workflow authorizes them.

select set_config('atlas.allow_high_risk_capability_grant','on',true);

insert into atlas_private.connection_capability_grants(
  connection_key,
  capability_key,
  capability_kind,
  grant_state,
  risk_level,
  manager_approval_required,
  automatic_execution_allowed,
  metadata
)
values (
  'dineout',
  'orders.write',
  'write',
  'blocked',
  'critical',
  true,
  false,
  '{"automatic_ordering":false,"supplier_submission":false}'::jsonb
)
on conflict (connection_key,capability_key) do update
set capability_kind='write',
    grant_state='blocked',
    risk_level='critical',
    manager_approval_required=true,
    automatic_execution_allowed=false,
    metadata=excluded.metadata,
    updated_at=now();

notify pgrst,'reload schema';
