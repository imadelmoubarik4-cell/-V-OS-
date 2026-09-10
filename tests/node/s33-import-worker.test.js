import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCSV, parseCSV, MAX_BYTES } from '../../supabase/s33/functions/atlas-import-worker/csv.mjs';
import { createHandler, TARGET } from '../../supabase/s33/functions/atlas-import-worker/worker.mjs';
const bytes = text => new TextEncoder().encode(text);
const csv = 'name,unit,quantity,cost_price,sku\r\n"Glass, tall",pcs,2.500,,S33-A\r\n';
const actor = '33000000-0000-4000-8000-000000000001';
const batch = '33000000-0000-4000-8000-000000000101';
const config = { SUPABASE_URL: TARGET, ATLAS_AUTH_PROJECT_URL: TARGET,
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test', ATLAS_IMPORT_ENABLED: 'true' };
const request = (action = 'stage', extra = {}) => new Request('https://worker.invalid', { method: 'POST',
  headers: { authorization: 'Bearer synthetic-user-token' }, body: JSON.stringify({ action, batch_id: batch, ...extra }) });
test('CSV preserves raw decimals and null costs, quoted commas, BOM and multiline fields', async () => {
  const result = await extractCSV(bytes('\ufeff' + csv));
  assert.equal(result.rows[0].raw_data.quantity, '2.500');
  assert.equal(result.rows[0].normalized_data.quantity, '2.500');
  assert.equal(result.rows[0].normalized_data.cost_price, null);
  assert.equal(result.rows[0].normalized_data.name, 'Glass, tall');
  assert.equal(result.source_hash.length, 64);
  assert.equal(parseCSV(bytes('name,unit,quantity\n"A\nB",pcs,0'))[0].raw_data.name, 'A\nB');
});
test('CSV rejects malformed, ambiguous, oversized and non-finite inputs', () => {
  for (const text of ['name,name,quantity\na,b,1','name,unit,quantity\nA,pcs,NaN',
    'name,unit,quantity\nA,pcs,-1','name,unit,quantity\nA,pcs,1e6','name,unit,quantity\nA,pcs,',
    'name,unit,quantity\n"A"x,pcs,1','name,unit,quantity\n"A,pcs,1',
    'name,unit,quantity\nA,pcs,1\na,pcs,2','name,unit,quantity\nA,pcs,1,2',
    'name,unit,quantity\n' + Array(1001).fill('A,pcs,1').join('\n')]) {
    assert.throws(() => parseCSV(bytes(text)), undefined, text.slice(0,80));
  }
  assert.throws(() => parseCSV(new Uint8Array(MAX_BYTES + 1)));
  assert.throws(() => parseCSV(new Uint8Array([0xff])));
});
test('worker refuses disabled, missing and foreign target configuration', () => {
  for (const key of Object.keys(config)) {
    const missing = { ...config }; delete missing[key];
    assert.throws(() => createHandler(missing));
  }
  assert.throws(() => createHandler({ ...config, SUPABASE_URL: 'https://other.invalid' }));
});
function mock(role = 'manager', active = true, authOK = true) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    assert.ok(url.startsWith(TARGET + '/'));
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: actor }, { status: authOK ? 200 : 401 });
    if (url.includes('/profiles?')) return Response.json([{ id: actor, role, active }]);
    if (url.includes('/object/authenticated/')) { assert.equal(init.headers.authorization, 'Bearer synthetic-user-token'); return new Response(bytes(csv)); }
    assert.ok(url.endsWith('/rpc/atlas_import_command'));
    assert.equal(init.headers.authorization, 'Bearer synthetic-service-key');
    const payload = JSON.parse(init.body);
    assert.equal(payload.p_actor, actor);
    if (payload.p_action === 'claim') return Response.json({ status: 'claimed', storage_bucket: 'atlas-imports', storage_path: actor + '/test.csv' });
    if (payload.p_action === 'stage') { assert.equal(payload.p_document.rows.length, 1); assert.equal(payload.p_document.rows[0].normalized_data.cost_price, null); }
    return Response.json({ status: payload.p_action === 'stage' ? 'staged' : 'promoted' });
  };
  return { calls, handler: createHandler(config, transport) };
}
test('unauthenticated, inactive and staff callers cannot reach privileged SQL or Storage', async () => {
  for (const args of [['viewer', true, true], ['bartender',true,true], ['manager',false,true], ['manager',true,false]]) {
    const { handler, calls } = mock(...args);
    assert.ok([401,403].includes((await handler(request())).status));
    assert.ok(calls.every(c => !c.url.includes('/rpc/') && !c.url.includes('/storage/')));
  }
  const { handler,calls } = mock();
  assert.equal((await handler(new Request('https://worker.invalid',{method:'POST'}))).status,401);
  assert.equal(calls.length,0);
});
test('manager extraction verifies identity, freezes source, downloads privately, then stages', async () => {
  const { handler,calls } = mock();
  const response = await handler(request());
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'staged');
  assert.equal(calls.length,5);
  assert.deepEqual(calls.filter(c=>c.url.includes('/rpc/')).map(c=>JSON.parse(c.init.body).p_action),['claim','stage']);
});
test('client-supplied actor or source location never reaches the command', async () => {
  for (const extra of [{p_actor:'spoof'},{storage_path:'outside'},{document:{rows:[]}}]) {
    const { handler,calls } = mock();
    assert.equal((await handler(request('stage',extra))).status,400);
    assert.equal(calls.filter(c=>c.url.includes('/rpc/')).length,0);
  }
});
