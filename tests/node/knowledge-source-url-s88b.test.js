// Security review S88b G2: atlas-knowledge save-source stores only absolute
// http(s) source URLs; javascript:, data:, file: and relative values are
// refused before the private RPC is called.
import test from 'node:test';
import assert from 'node:assert/strict';

import { json, loadEdgeFunction } from './helpers/edge-function-harness.js';

const FUNCTION = 'supabase/functions/atlas-knowledge/index.ts';
const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_URL: 'https://branch.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};
const ARTICLE = '0f5b8a39-6a3f-4c1e-9d7a-6f1d6b3c2a11';

function backend() {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href === 'https://auth.test/auth/v1/user') return json({ id: 'user-1', email: 'manager@example.test' });
    if (url.origin === 'https://auth.test' && url.pathname === '/rest/v1/profiles') {
      return json([{ id: 'user-1', email: 'manager@example.test', display_name: 'Manager', role: 'manager', active: true }]);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      calls.push({ rpc: url.pathname.slice('/rest/v1/rpc/'.length), body: JSON.parse(init.body) });
      return json({ source_id: 'src-1' });
    }
    return json({});
  };
  return { calls, fetchImpl };
}

const handlerPromise = loadEdgeFunction(FUNCTION, ENV);
const saveSource = (sourceUrl) => new Request('https://fn.test/atlas-knowledge?action=save-source', {
  method: 'POST',
  headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
  body: JSON.stringify({ article_id: ARTICLE, source_type: 'manual', source_label: 'Closing checklist', source_url: sourceUrl }),
});
const saveCalls = (calls) => calls.filter((call) => call.rpc === 'atlas_knowledge_save_source');

for (const bad of ['javascript:fetch(1)', 'JavaScript:alert(1)', ' data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:msgbox(1)', '//evil.example/x', 'drive.example/doc']) {
  test(`G2: save-source refuses the source URL ${JSON.stringify(bad)}`, async () => {
    const handler = await handlerPromise;
    const { calls, fetchImpl } = backend();
    const response = await handler(saveSource(bad), fetchImpl);
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /http or https/);
    assert.equal(saveCalls(calls).length, 0);
  });
}

for (const good of ['https://drive.example/doc-1', 'http://intranet.example/closing']) {
  test(`G2: save-source stores the http(s) source URL ${good}`, async () => {
    const handler = await handlerPromise;
    const { calls, fetchImpl } = backend();
    const response = await handler(saveSource(good), fetchImpl);
    const [call] = saveCalls(calls);
    assert.ok(call, `status ${response.status}`);
    assert.equal(call.body.p_source_url, good);
  });
}

test('G2: save-source still accepts no source URL', async () => {
  const handler = await handlerPromise;
  const { calls, fetchImpl } = backend();
  await handler(saveSource(''), fetchImpl);
  assert.equal(saveCalls(calls)[0].body.p_source_url, null);
});
