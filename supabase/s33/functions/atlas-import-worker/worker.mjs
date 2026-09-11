import { extractCSV, MAX_BYTES } from './csv.mjs';
export const TARGET = 'https://atialqebqxcquzdkezln.supabase.co';
const ORIGIN = 'https://atlas-s32-rehearsal.coffee-cockt-8589.chatgpt.site';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class ImportError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
async function readBounded(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw new ImportError('Input is too large.');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maximum) throw new ImportError('Input is too large.');
      parts.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export function createHandler(env, transport = fetch) {
  if (env.SUPABASE_URL !== TARGET || env.ATLAS_AUTH_PROJECT_URL !== TARGET ||
      env.ATLAS_IMPORT_ENABLED !== 'true' || !env.SUPABASE_SERVICE_ROLE_KEY ||
      !/^sb_publishable_[A-Za-z0-9_-]+$/.test(env.ATLAS_AUTH_PUBLISHABLE_KEY || '')) {
    throw new Error('Import worker requires explicit isolated staging configuration and enablement.');
  }
  const headers = { 'access-control-allow-origin': ORIGIN, 'vary': 'Origin',
    'access-control-allow-headers': 'authorization, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS', 'cache-control': 'no-store',
    'content-type': 'application/json' };
  const send = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
  const request = (path, init) => transport(TARGET + path,
    { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
  return async req => {
    try {
      if (req.headers.get('origin') && req.headers.get('origin') !== ORIGIN) throw new ImportError('Origin not allowed.', 403);
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (req.method !== 'POST') throw new ImportError('Use POST.', 405);
      const authorization = req.headers.get('authorization') || '';
      if (!/^Bearer \S+$/.test(authorization)) throw new ImportError('Sign in to continue.', 401);
      const userHeaders = { apikey: env.ATLAS_AUTH_PUBLISHABLE_KEY, authorization };
      const auth = await request('/auth/v1/user', { headers: userHeaders });
      if (!auth.ok) throw new ImportError('Sign in again.', 401);
      const user = await auth.json();
      if (!UUID.test(user.id || '')) throw new ImportError('Account could not be verified.', 401);
      const profileResponse = await request(`/rest/v1/profiles?id=eq.${user.id}&select=id,role,active`, { headers: userHeaders });
      if (!profileResponse.ok) throw new ImportError('Role could not be verified.', 403);
      const profiles = await profileResponse.json();
      if (!profiles[0]?.active || !['admin', 'manager'].includes(profiles[0]?.role)) {
        throw new ImportError('An active manager or administrator is required.', 403);
      }
      const input = JSON.parse(new TextDecoder().decode(await readBounded(req, 1024)));
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(k => !['action', 'batch_id'].includes(k)) ||
          !['stage', 'promote', 'discard', 'source'].includes(input.action) || !UUID.test(input.batch_id || '')) {
        throw new ImportError('Choose an import action and a valid batch.');
      }
      const rpc = async (action, document = null) => {
        const response = await request('/rest/v1/rpc/atlas_import_command', { method: 'POST',
          headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'content-type': 'application/json' },
          body: JSON.stringify({ p_action: action, p_batch_id: input.batch_id, p_actor: user.id, p_document: document }) });
        const data = await response.json();
        if (!response.ok) throw new ImportError(data.message?.slice(0,250) || 'Import command failed.', response.status === 403 ? 403 : 409);
        return data;
      };
      if (input.action !== 'stage') return send(await rpc(input.action));
      const claim = await rpc('claim');
      if (['staged', 'promoted'].includes(claim.status)) return send(claim);
      if (claim.storage_bucket !== 'atlas-imports' || typeof claim.storage_path !== 'string' ||
          claim.storage_path.split('/').some(s => !s || s === '.' || s === '..')) {
        throw new ImportError('Invalid source location.');
      }
      const path = claim.storage_path.split('/').map(encodeURIComponent).join('/');
      const source = await request('/storage/v1/object/authenticated/atlas-imports/' + path, { headers: userHeaders });
      if (!source.ok) throw new ImportError('The private source file could not be read.', 409);
      const document = await extractCSV(await readBounded(source, MAX_BYTES));
      return send(await rpc('stage', document));
    } catch (error) {
      return send({ error: error instanceof ImportError || error instanceof SyntaxError || error?.message?.startsWith('Row ') || error?.message?.startsWith('CSV') || error?.message?.startsWith('Use unique') || error?.message?.includes('CSV quotation')
        ? error.message : 'Import did not complete. Check its status before retrying.' }, error.status || 400);
    }
  };
}
