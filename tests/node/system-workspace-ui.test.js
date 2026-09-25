import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const ui = readFileSync('apps/web/assets/js/system-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/settings-workspace.css', 'utf8');
const settings = readFileSync('apps/web/assets/js/settings-workspace.js', 'utf8');
const edge = readFileSync('supabase/functions/atlas-system/index.ts', 'utf8');
const foundation = readFileSync('supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql', 'utf8');
const snapshot = readFileSync('supabase/migrations/20260804134510_atlas_system_snapshot.sql', 'utf8');
const closure = readFileSync('supabase/migrations/20260909094553_atlas_pr27_reports_release_closure.sql', 'utf8');
const supabaseConfig = readFileSync('supabase/config.toml', 'utf8');

test('Checkpoint I loads through the isolated authenticated System gateway', () => {
  assert.match(config, /SYSTEM_API:\s*"https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-system"/);
  // S88 Team A: System health is a Settings section; its styles live in settings-workspace.css.
  assert.doesNotMatch(config, /assets\/css\/system-workspace\.css/);
  assert.match(config, /assets\/js\/system-workspace\.js/);
  assert.match(config, /AtlasSystem/);
  assert.doesNotMatch(config + ui, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('System health is a Settings section for administrators, not a separate view', () => {
  assert.doesNotMatch(ui, /registerView|data-view=\"system\"|system-view/);
  assert.match(ui, /window\.AtlasSystem = \{\s+mount,/);
  assert.match(settings, /\{ key: 'system', label: 'System health', icon: 'activity', roles: \['admin'\] \}/);
  assert.match(settings, /window\.AtlasSystem\?\.mount\?\./);
});

test('System health keeps the operational sections', () => {
  for (const section of ['Services', 'Incidents', 'Data sources', 'Environments', 'Jobs', 'Audit & recovery']) {
    assert.match(ui, new RegExp(`'${section}'`));
  }
  assert.match(ui, /Not checked yet/);
});

test('Reports incident history is preserved and PR27 closes the release blocker', () => {
  assert.match(foundation, /reports-loading-stall/);
  assert.match(foundation, /Reports authenticated snapshot does not complete/);
  assert.match(foundation, /production_records_changed',false/);
  assert.match(closure, /status='resolved'/);
  assert.match(closure, /'release_blocker',false/);
  assert.match(closure, /release_blockers='\[\]'::jsonb/);
  assert.match(closure, /production_sync_state='disabled'/);
  assert.match(closure, /settings_value->>'reports_state'='ready'/);
  assert.match(ui, /Release blocker/);
});

test('System is view-only and does not expose destructive controls', () => {
  assert.match(ui, /View only/);
  assert.match(ui, /Retry controls are disabled/);
  assert.match(ui, /Incidents are read-only here/);
  assert.match(ui, /Rollback unavailable/);
  assert.doesNotMatch(ui, /method:\s*['"]POST['"]/);
  assert.doesNotMatch(ui, /\.from\s*\(\s*['"]/);
  assert.doesNotMatch(ui, /delete\s+from|drop\s+table|truncate\s+/i);
});

test('System UI never renders privileged secrets or raw credentials', () => {
  assert.match(ui, /Passwords, keys and sign-in secrets are never shown here/);
  assert.match(edge, /secrets_returned:\s*false/);
  assert.match(edge, /tokens_returned:\s*false/);
  assert.match(ui, /authorization: `Bearer \$\{session\.access_token\}`/);
  assert.doesNotMatch(ui, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY|refresh_token\s*[:=]|client_secret\s*[:=]|password\s*[:=]/i);
  assert.doesNotMatch(edge, /return\s+\{[^}]*SUPABASE_SERVICE_ROLE_KEY/s);
});

test('System gateway revalidates production manager access on every request', () => {
  assert.match(edge, /requireManagerProfile/);
  assert.match(edge, /if \(!profile\?\.active\)/);
  assert.match(edge, /MANAGER_ROLES = new Set\(\["admin", "manager"\]\)/);
  assert.match(edge, /System is available only to managers and administrators/);
  assert.match(edge, /request\.method !== "GET"/);
  assert.match(edge, /Checkpoint I System is view-only/);
  assert.match(supabaseConfig, /\[functions\.atlas-system\]/);
  assert.match(supabaseConfig, /verify_jwt = false/);
});

test('private System tables are RLS protected and service-role only', () => {
  for (const table of [
    'system_settings', 'system_services', 'system_data_sources',
    'system_jobs', 'system_incidents', 'system_release_checkpoints', 'system_events'
  ]) {
    assert.match(foundation, new RegExp(`alter table atlas_private\\.${table} enable row level security`));
    assert.match(foundation, new RegExp(`revoke all on atlas_private\\.${table} from public,anon,authenticated`));
    assert.match(foundation, new RegExp(`grant all on atlas_private\\.${table} to service_role`));
  }
  assert.doesNotMatch(foundation + snapshot, /security definer/i);
});

test('System snapshot is service-role only and manager-gated', () => {
  assert.match(snapshot, /p_actor_role not in \('admin','manager'\)/);
  assert.match(snapshot, /revoke execute on function public\.atlas_system_snapshot\(jsonb,jsonb,jsonb,uuid,text\)/);
  assert.match(snapshot, /from public,anon,authenticated/);
  assert.match(snapshot, /grant execute on function public\.atlas_system_snapshot\(jsonb,jsonb,jsonb,uuid,text\)/);
  assert.match(snapshot, /to service_role/);
  assert.match(snapshot, /'secrets_returned',false/);
  assert.match(snapshot, /'tokens_returned',false/);
  assert.match(snapshot, /'production_source_mutation',false/);
});

test('System health styles follow the S88 design system', () => {
  assert.match(css, /\.sys-/);
  assert.doesNotMatch(css, /!important|gradient|'Fraunces'/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
