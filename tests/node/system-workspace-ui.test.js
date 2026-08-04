import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const ui = readFileSync('apps/web/assets/js/system-workspace.js', 'utf8');
const css = readFileSync('apps/web/assets/css/system-workspace.css', 'utf8');
const edge = readFileSync('supabase/functions/atlas-system/index.ts', 'utf8');
const foundation = readFileSync('supabase/migrations/20260804134509_atlas_system_checkpoint_i.sql', 'utf8');
const snapshot = readFileSync('supabase/migrations/20260804134510_atlas_system_snapshot.sql', 'utf8');
const supabaseConfig = readFileSync('supabase/config.toml', 'utf8');

test('Checkpoint I loads through the isolated authenticated System gateway', () => {
  assert.match(config, /SYSTEM_API:\s*"https:\/\/uhbamqetppqmygesoeeh\.supabase\.co\/functions\/v1\/atlas-system"/);
  assert.match(config, /assets\/css\/system-workspace\.css/);
  assert.match(config, /assets\/js\/system-workspace\.js/);
  assert.match(config, /AtlasSystem/);
  assert.doesNotMatch(config + ui, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('System dynamically creates the manager control-room navigation and view', () => {
  assert.match(ui, /data-view=\"system\"/);
  assert.match(ui, /nav-label/);
  assert.match(ui, /SYSTEM/);
  assert.match(ui, /system-view/);
  assert.match(ui, /Atlas System/);
  assert.match(ui, /Checkpoint I · System control room/);
});

test('System contains the complete operational control-room sections', () => {
  for (const section of [
    'Overview', 'Environments', 'Integrations', 'Data sources',
    'Jobs', 'Incidents', 'Security', 'Audit & recovery'
  ]) {
    assert.match(ui, new RegExp(section.replace('&', '&')));
  }
  assert.match(ui, /Core services/);
  assert.match(ui, /Environments & releases/);
  assert.match(ui, /Connection registry/);
  assert.match(ui, /Data sources & freshness/);
  assert.match(ui, /Jobs & synchronization/);
  assert.match(ui, /Security posture/);
  assert.match(ui, /Audit & recovery/);
});

test('Reports remains an honest open incident and release blocker', () => {
  assert.match(foundation, /reports-loading-stall/);
  assert.match(foundation, /Reports authenticated snapshot does not complete/);
  assert.match(foundation, /Reports authenticated snapshot remains unresolved/);
  assert.match(foundation, /production_records_changed',false/);
  assert.match(ui, /Release blocker/);
  assert.match(ui, /Incident centre/);
});

test('System is view-only and does not expose destructive controls', () => {
  assert.match(ui, /View only/);
  assert.match(ui, /Retry controls are disabled/);
  assert.match(ui, /Incident mutation is disabled/);
  assert.match(ui, /Rollback unavailable/);
  assert.match(ui, /Production synchronization/);
  assert.doesNotMatch(ui, /method:\s*['"]POST['"]/);
  assert.doesNotMatch(ui, /\.from\s*\(/);
  assert.doesNotMatch(ui, /delete\s+from|drop\s+table|truncate\s+/i);
});

test('System UI never renders raw secrets or credentials', () => {
  assert.match(ui, /Secrets hidden/);
  assert.match(ui, /Secrets and tokens never returned/);
  assert.match(edge, /secrets_returned:\s*false/);
  assert.match(edge, /tokens_returned:\s*false/);
  assert.doesNotMatch(ui, /service_role|access_token|refresh_token|client_secret|password/i);
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

test('System preserves original Atlas visual language and responsive behavior', () => {
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /@media\(max-width:1250px\)/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /@media\(max-width:460px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});
