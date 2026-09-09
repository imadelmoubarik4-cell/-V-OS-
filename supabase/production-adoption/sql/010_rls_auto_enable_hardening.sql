-- Production candidate: keep the internal event trigger operational while
-- removing direct browser-role execution of its SECURITY DEFINER function.

revoke execute on function public.rls_auto_enable()
  from public, anon, authenticated;

comment on function public.rls_auto_enable() is
  'Internal ensure_rls event-trigger function. Direct execution is not granted to browser roles.';
