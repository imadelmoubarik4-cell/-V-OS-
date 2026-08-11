-- The initial Marketing snapshot uses local start_date/end_date variables that
-- share names with campaign columns. Recompile the existing versioned function
-- with PL/pgSQL's use-variable directive so its calendar range remains
-- unambiguous without duplicating the large snapshot definition.

do $migration$
declare
  function_definition text;
begin
  select pg_get_functiondef('atlas_private.marketing_workspace_snapshot(uuid,text,date,date)'::regprocedure)
  into function_definition;

  if function_definition not like '%#variable_conflict use_variable%' then
    function_definition := replace(
      function_definition,
      E'AS $function$\ndeclare',
      E'AS $function$\n#variable_conflict use_variable\ndeclare'
    );
    execute function_definition;
  end if;
end;
$migration$;
