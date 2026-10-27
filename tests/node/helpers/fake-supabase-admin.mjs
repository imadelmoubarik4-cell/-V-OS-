// A scripted stand-in for `npm:@supabase/supabase-js` createClient, for
// behavioural tests of Edge Functions that use the service-role admin client.
// A test sets globalThis.__fakeSupabase = fakeSupabaseWorld({...}) and reads
// world.calls afterwards. Only the calls the tested functions make exist.
export function fakeSupabaseWorld(handlers = {}) {
  const world = {
    calls: [],
    getUserById: handlers.getUserById ?? (async (id) => ({ data: { user: { id } }, error: null })),
    updateUserById: handlers.updateUserById ?? (async (id) => ({ data: { user: { id } }, error: null })),
    query: handlers.query ?? (async () => ({ data: null, error: null })),
  };
  return world;
}

function builder(world, table) {
  const request = { table, op: 'select', values: null, filters: [], select: null };
  const run = () => {
    world.calls.push(['query', { ...request, filters: [...request.filters] }]);
    return world.query({ ...request, filters: [...request.filters] });
  };
  const chain = {
    update(values) { request.op = 'update'; request.values = values; return chain; },
    select(columns) { request.select = columns ?? '*'; return chain; },
    eq(column, value) { request.filters.push(['eq', column, value]); return chain; },
    ilike(column, value) { request.filters.push(['ilike', column, value]); return chain; },
    maybeSingle() { return run(); },
    single() { return run(); },
    then(resolve, reject) { return run().then(resolve, reject); },
  };
  return chain;
}

export function createClient(url, key) {
  const world = globalThis.__fakeSupabase;
  if (!world) throw new Error('fake supabase: no world set');
  world.calls.push(['createClient', url, key]);
  return {
    auth: {
      admin: {
        getUserById: async (id) => { world.calls.push(['getUserById', id]); return world.getUserById(id); },
        updateUserById: async (id, attributes) => { world.calls.push(['updateUserById', id, attributes]); return world.updateUserById(id, attributes); },
      },
    },
    from: (table) => builder(world, table),
  };
}
