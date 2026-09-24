import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// S88 Atlas AI data layer: source contract for grants, revokes and the
// browser boundary. The runtime proof is scripts/verify_s88_ai_preview.sql.

const migrationsRoot = new URL('../../supabase/migrations/', import.meta.url);
const files = [
  '20260926100000_s88_ai_private_tables.sql',
  '20260926101000_s88_ai_conversation_rpcs.sql',
  '20260926102000_s88_ai_actions_and_brain.sql',
  '20260926103000_s88_knowledge_search.sql',
  '20260926104000_s88_ai_media_bucket.sql',
];
const read = name => readFile(new URL(name, migrationsRoot), 'utf8');

const aiTables = [
  'ai_conversations', 'ai_runs', 'ai_messages', 'ai_tool_calls',
  'ai_actions', 'ai_media', 'ai_user_preferences', 'ai_settings',
];

// Splits a parameter list on top-level commas (defaults may contain arrays).
function splitParams(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

function declaredFunctions(sql, schema) {
  const out = [];
  const pattern = new RegExp(`create or replace function ${schema}\\.([a-z0-9_]+)\\(([\\s\\S]*?)\\)\\s*returns`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    const types = splitParams(match[2]).map(param => {
      const withoutDefault = param.split(/\s+default\s+/i)[0].trim();
      return withoutDefault.split(/\s+/).slice(1).join(' ').toLowerCase();
    });
    const start = match.index;
    const end = sql.indexOf('$$;', sql.indexOf('$$', start) + 2);
    out.push({ name: match[1], signature: `${schema}.${match[1]}(${types.join(',')})`, body: sql.slice(start, end) });
  }
  return out;
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('S88 migrations sit in the reserved 2026092610xxxx window', async () => {
  for (const name of files) {
    const version = name.split('_')[0];
    assert.ok(version >= '20260926100000' && version <= '20260926104000', name);
    assert.ok((await read(name)).length > 100, `${name} is empty`);
  }
});

test('every atlas_private ai_* table has RLS, a service-role policy and no browser grant', async () => {
  const sql = await read(files[0]);
  for (const table of aiTables) {
    assert.match(sql, new RegExp(`create table if not exists atlas_private\\.${table} \\(`, 'i'), table);
    assert.match(sql, new RegExp(`alter table atlas_private\\.${table} enable row level security;`, 'i'), table);
    assert.match(sql, new RegExp(`revoke all on atlas_private\\.${table} from public, anon, authenticated;`, 'i'), table);
    assert.match(sql, new RegExp(`grant all on atlas_private\\.${table} to service_role;`, 'i'), table);
    assert.match(sql, new RegExp(`on atlas_private\\.${table} for all to service_role using \\(true\\) with check \\(true\\);`, 'i'), table);
  }
  const all = (await Promise.all(files.map(read))).join('\n').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(all, /\bgrant\s[^;]*\bto\s+(anon|authenticated|public)\b/i);
  assert.doesNotMatch(all, /create policy[^;]*\bto\s+(anon|authenticated|public)\b/i);
  assert.match(sql, /enabled boolean not null default false/i, 'Atlas AI must start disabled');
});

test('every new public RPC is service-role only with an exact revoke and grant', async () => {
  const functions = [];
  for (const name of files.slice(1)) {
    const sql = await read(name);
    for (const fn of declaredFunctions(sql, 'public')) functions.push({ ...fn, sql, file: name });
  }
  const names = functions.map(fn => fn.name).sort();
  assert.equal(names.length, 31, names.join(', '));
  for (const expected of [
    'atlas_ai_conversations_list', 'atlas_ai_conversation_create', 'atlas_ai_conversation_get',
    'atlas_ai_conversation_rename', 'atlas_ai_conversation_pin', 'atlas_ai_conversation_archive',
    'atlas_ai_conversation_delete', 'atlas_ai_conversation_context_merge', 'atlas_ai_messages_append',
    'atlas_ai_message_update', 'atlas_ai_run_start', 'atlas_ai_run_finish', 'atlas_ai_tool_call_record',
    'atlas_ai_media_register', 'atlas_ai_media_get', 'atlas_ai_media_mark_deleted',
    'atlas_ai_media_purge_expired', 'atlas_ai_media_purge_confirm', 'atlas_ai_preferences_get',
    'atlas_ai_preferences_set', 'atlas_ai_settings_get', 'atlas_ai_settings_set', 'atlas_ai_rate_check',
    'atlas_ai_action_create', 'atlas_ai_action_get', 'atlas_ai_action_transition', 'atlas_ai_actions_expire',
    'atlas_ai_record_proposal', 'atlas_ai_record_decision', 'atlas_ai_memory_search', 'atlas_knowledge_search',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  for (const fn of functions) {
    const signature = escape(fn.signature);
    assert.match(fn.sql, new RegExp(`revoke execute on function ${signature} from public, anon, authenticated;`, 'i'), fn.signature);
    assert.match(fn.sql, new RegExp(`grant execute on function ${signature} to service_role;`, 'i'), fn.signature);
    assert.match(fn.body, /security invoker/i, fn.signature);
    assert.doesNotMatch(fn.body, /security definer/i, fn.signature);
    assert.match(fn.body, /set search_path = ''/i, fn.signature);
  }
});

test('atlas_private helpers are revoked from browser roles and granted to service_role', async () => {
  for (const name of files.slice(1)) {
    const sql = await read(name);
    for (const fn of declaredFunctions(sql, 'atlas_private')) {
      const signature = escape(fn.signature);
      assert.match(sql, new RegExp(`revoke execute on function ${signature} from public, anon, authenticated;`, 'i'), fn.signature);
      assert.match(sql, new RegExp(`grant execute on function ${signature} to service_role;`, 'i'), fn.signature);
      assert.doesNotMatch(fn.body, /security definer/i, fn.signature);
    }
  }
});

test('actor-bound RPCs re-check the active profile role and enforce ownership in SQL', async () => {
  const sql = (await Promise.all(files.slice(1).map(read))).join('\n');
  const systemJobs = new Set(['atlas_ai_media_purge_expired', 'atlas_ai_media_purge_confirm', 'atlas_ai_actions_expire', 'atlas_ai_memory_search']);
  for (const fn of declaredFunctions(sql, 'public')) {
    if (systemJobs.has(fn.name)) continue;
    assert.match(fn.body, /atlas_private\.ai_require_actor\(p_actor_id, p_actor_role\)/, fn.name);
  }
  const helper = declaredFunctions(sql, 'atlas_private').find(fn => fn.name === 'ai_require_actor');
  assert.match(helper.body, /profile\.active is true/);
  assert.match(helper.body, /v_role is distinct from p_actor_role/);
  const owned = declaredFunctions(sql, 'atlas_private').find(fn => fn.name === 'ai_owned_conversation');
  assert.match(owned.body, /c\.user_id = p_actor_id/);
  assert.match(sql, /decision memory is manager-only/);
});

test('approval returns the stored command and reuses the Brain decide function', async () => {
  const sql = await read(files[2]);
  const transition = declaredFunctions(sql, 'public').find(fn => fn.name === 'atlas_ai_action_transition');
  assert.doesNotMatch(transition.signature, /jsonb,jsonb,text\)$/, 'transition must not accept a command payload');
  assert.match(transition.body, /'command', v_row\.command/);
  assert.match(transition.body, /for update/);
  assert.match(transition.body, /expires_at <= pg_catalog\.now\(\)/);
  assert.match(transition.body, /p_actor_role = any\(v_row\.required_roles\)/);
  const decision = declaredFunctions(sql, 'public').find(fn => fn.name === 'atlas_ai_record_decision');
  assert.match(decision.body, /atlas_private\.decide_phase3_recommendation\(/);
  assert.doesNotMatch(sql, /insert into atlas_private\.brain_decisions/i, 'decisions must go through the decide function');
  assert.match(sql, /'data_quality','shortage','purchase','menu','waste','operations','governance','assistant'/);
  assert.match(sql, /'atlas_ai_tool'/);
});

test('Knowledge search filters by visibility and never returns source metadata', async () => {
  const sql = await read(files[3]);
  assert.match(sql, /atlas_private\.knowledge_article_visible\(article, v_role, v_is_manager\)/);
  assert.match(sql, /using gin \(atlas_private\.knowledge_version_search_document\(title, summary, content\)\)/i);
  assert.match(sql, /'simple'::regconfig/);
  assert.doesNotMatch(sql, /knowledge_sources|source_url|source_reference/i);
});

test('atlas-ai-media is a private bucket with no browser object policies', async () => {
  const sql = await read(files[4]);
  assert.match(sql, /'atlas-ai-media',\s*'atlas-ai-media',\s*false,\s*26214400/);
  assert.match(sql, /public = false/);
  assert.doesNotMatch(sql, /create policy/i);
  for (const mime of ['image/heic', 'application/pdf', 'text/csv', 'audio/webm', 'audio/wav']) {
    assert.ok(sql.includes(`'${mime}'`), mime);
  }
});

test('the migration replay workflow runs the S88 acceptance script', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/migration-replay.yml', import.meta.url), 'utf8');
  assert.match(workflow, /bash scripts\/verify_s88_ai_previews\.sh/);
  const runner = await readFile(new URL('../../scripts/verify_s88_ai_previews.sh', import.meta.url), 'utf8');
  assert.match(runner, /verify_s88_ai_preview\.sql/);
  assert.match(runner, /Refusing non-loopback PGHOST/);
});
