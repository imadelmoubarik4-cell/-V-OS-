import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as nodeModule from 'node:module';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const EDGE = read('supabase/functions/atlas-settings/index.ts');
const MIGRATION = read('supabase/migrations/20260926090000_s88_venue_clock.sql');
const canStrip = typeof nodeModule.stripTypeScriptTypes === 'function';

function helperBlock(source, name) {
  const start = source.indexOf(`// ${name}:start`);
  const end = source.indexOf(`// ${name}:end`);
  assert.ok(start >= 0 && end > start, `missing ${name} block`);
  return source.slice(start, end);
}

function loadHelpers() {
  const context = { Intl, String, Number, Object, Array, RegExp };
  vm.createContext(context);
  const code = nodeModule.stripTypeScriptTypes(helperBlock(EDGE, 's88-settings-helpers'));
  vm.runInContext(`${code}\nthis.helpers = { isValidTimeZone, timeZoneProblem, venueClockStaff, DEFAULT_VENUE_TIME_ZONE };`, context);
  return context.helpers;
}

test('time-zone validation accepts IANA names and rejects everything else', { skip: !canStrip }, () => {
  const { isValidTimeZone } = loadHelpers();
  for (const zone of ['Atlantic/Reykjavik', 'Europe/London', 'America/Argentina/Buenos_Aires', 'UTC', 'Pacific/Auckland']) {
    assert.equal(isValidTimeZone(zone), true, zone);
  }
  for (const zone of ['Mars/Base', '', ' Atlantic/Reykjavik', 'Atlantic/Reykjavik ', 'GMT+0; drop', null, undefined, 42, '../etc/passwd']) {
    assert.equal(isValidTimeZone(zone), false, String(zone));
  }
});

test('time-zone problems are readable and a missing key keeps the default', { skip: !canStrip }, () => {
  const { timeZoneProblem, DEFAULT_VENUE_TIME_ZONE } = loadHelpers();
  assert.equal(DEFAULT_VENUE_TIME_ZONE, 'Atlantic/Reykjavik');
  assert.equal(timeZoneProblem(undefined), null);
  assert.equal(timeZoneProblem('Europe/London'), null);
  assert.match(timeZoneProblem('Mars/Base'), /^Time zone Mars\/Base is not recognised\. Use an IANA name such as Atlantic\/Reykjavik\.$/);
  assert.match(timeZoneProblem(''), /Time zone \(empty\) is not recognised/);
});

test('venue clock staff payload exposes only role facts', { skip: !canStrip }, () => {
  const { venueClockStaff } = loadHelpers();
  assert.deepEqual({ ...venueClockStaff('bartender', 'u1') }, { id: 'u1', role: 'bartender', active: true, can_manage_hours: false });
  assert.equal(venueClockStaff('manager', 'u2').can_manage_hours, true);
  assert.equal(venueClockStaff('admin', 'u3').can_manage_hours, true);
  assert.equal(venueClockStaff('viewer', 'u4').can_manage_hours, false);
});

test('atlas-settings serves the venue clock to every active role before the snapshot guard', () => {
  assert.match(EDGE, /const FUNCTION_VERSION = "0\.1\.3";/);
  const getBranch = EDGE.slice(EDGE.indexOf('if (request.method === "GET")'), EDGE.indexOf('if (request.method !== "POST")'));
  assert.match(getBranch, /action === "venue-clock"/);
  assert.match(getBranch, /branchRpc\("atlas_settings_venue_clock", \{\s*p_actor_role: context\.profile\.role,\s*\}\)/);
  assert.ok(getBranch.indexOf('venue-clock') < getBranch.indexOf('action !== "snapshot"'));
  assert.doesNotMatch(getBranch.slice(0, getBranch.indexOf('action !== "snapshot"')), /requireManager/);
  // requireActiveProfile is the only gate: an inactive profile is refused, all four roles pass.
  assert.match(EDGE, /const PROFILE_ROLES = new Set\(\["admin", "manager", "bartender", "viewer"\]\);/);
  assert.match(EDGE, /if \(!profile\?\.active\) \{/);
  assert.match(EDGE, /const context = await requireActiveProfile\(request\);/);
});

test('venue and preference time zones are validated before the database write', () => {
  const saveSection = EDGE.slice(EDGE.indexOf('case "save-section"'), EDGE.indexOf('case "save-hours"'));
  assert.match(saveSection, /if \(sectionKey === "venue"\) \{\s*const problem = timeZoneProblem\(value\.timezone\);\s*if \(problem\) throw new ApiError\(400, problem\);/);
  const savePreferences = EDGE.slice(EDGE.indexOf('case "save-preferences"'), EDGE.indexOf('default:', EDGE.indexOf('case "save-preferences"')));
  assert.match(savePreferences, /timeZoneProblem\(preferenceZone\)/);
  assert.match(savePreferences, /p_timezone: preferenceZone,/);
});

test('venue clock migration is service-role only and validates zones on write', () => {
  assert.match(MIGRATION, /create or replace function atlas_private\.venue_business_date\(p_at timestamptz default pg_catalog\.now\(\)\)/);
  assert.match(MIGRATION, /hours\.close_next_day/);
  assert.match(MIGRATION, /'Atlantic\/Reykjavik'\)/);
  assert.match(MIGRATION, /before insert or update on atlas_private\.settings_sections/);
  assert.match(MIGRATION, /before insert or update of timezone on atlas_private\.settings_user_preferences/);
  assert.match(MIGRATION, /revoke all on function %s from public, anon, authenticated/);
  assert.match(MIGRATION, /grant execute on function %s to service_role/);
  assert.doesNotMatch(MIGRATION, /to authenticated/i);
  assert.doesNotMatch(MIGRATION, /security definer/i);
  assert.match(MIGRATION, /'hours_configured', rows_count = 7/);
  assert.doesNotMatch(MIGRATION, /'11:30'|'22:00'/);
});
