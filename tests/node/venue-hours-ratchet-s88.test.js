// S88 ratchet: no browser file may carry hard-coded service hours.
//
// Opening, closing, offer and last-order times live only in Settings →
// business hours and reach the browser through AtlasVenueClock
// (apps/web/assets/js/atlas-venue-clock.js). The ceilings below are the
// remaining known sites, each listed with its owner in
// docs/design/Atlas_Time_Migration.md. They may only go down: when a module
// team removes one, lower (or delete) its ceiling in the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const WEB = 'apps/web';

const CEILINGS = Object.freeze({
  // E5: new-shift editor defaults (start 11:30, end 17:00).
  'assets/js/shifts-workspace.js': 2,
  'assets/js/shifts-month-calendar.js': 2
  // E4 (done, Team C): marketing no longer defaults a suggestion to '12:00'.
});

// Time-of-day literals: '11:30', "22:00:00", `…T11:30:00`. Midnight ('00:00',
// the day boundary) and 'T12:00' (the UTC-noon date-key pattern) are not hours.
const TIME_LITERAL = /(['"`])(?:[01]?\d|2[0-4]):[0-5]\d(?::[0-5]\d)?\1|T(?:0[1-9]|1[013-9]|2[0-3]):[0-5]\d/g;
const PATTERNS = [
  { name: 'time-of-day literal', regex: TIME_LITERAL, filter: (match) => !/^['"`]0?0:00(:00)?['"`]$/.test(match) },
  { name: 'setHours with a service hour', regex: /\.setHours\(\s*(?:[1-9]|1\d|2[0-3])\b/g },
  { name: 'hard-coded schedule helper', regex: /\b(?:venueSchedule|timelineEntries)\b/g }
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function sources() {
  const files = walk(WEB).filter((file) => file.endsWith('.js') && !file.endsWith('config.js')).sort();
  const list = files.map((file) => ({ name: path.relative(WEB, file), text: readFileSync(file, 'utf8') }));
  const index = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const inline = [...index.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n');
  list.push({ name: 'index.html<script>', text: inline });
  return list;
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

function findings() {
  const out = {};
  for (const source of sources()) {
    const text = stripComments(source.text);
    const hits = [];
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern.regex)) {
        if (pattern.filter && !pattern.filter(match[0])) continue;
        hits.push(`${pattern.name}: ${match[0]}`);
      }
    }
    if (hits.length) out[source.name] = hits;
  }
  return out;
}

test('no browser file contains hard-coded service hours beyond the ratchet ceilings', () => {
  const found = findings();
  for (const [file, hits] of Object.entries(found)) {
    const ceiling = CEILINGS[file] ?? 0;
    assert.ok(hits.length <= ceiling, `${file} has ${hits.length} hard-coded time(s) (ceiling ${ceiling}): ${hits.join(' | ')}. Use AtlasVenueClock (saved business hours) instead.`);
  }
  for (const [file, ceiling] of Object.entries(CEILINGS)) {
    const count = found[file]?.length ?? 0;
    assert.equal(count, ceiling, `${file} now has ${count} hard-coded time(s); lower its ceiling to ${count} in this test and tick it off in docs/design/Atlas_Time_Migration.md.`);
  }
});

test('Home, Operations and Settings carry no hard-coded hours or browser-zone clock', () => {
  // S88 Team A: Brain is retired; Home (home.js) owns the context line and timeline.
  for (const file of ['assets/js/home.js', 'assets/js/operations.js', 'assets/js/settings-workspace.js', 'assets/js/system-workspace.js']) {
    const source = readFileSync(path.join(WEB, file), 'utf8');
    assert.equal(findings()[file], undefined, file);
    for (const forbidden of ['getHours()', 'getDay()', 'getDate()', 'setHours(', 'toLocaleDateString(', 'toLocaleString(', "'Atlantic/Reykjavik'", "'Happy Hour'"]) {
      assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`);
    }
  }
  const home = readFileSync(path.join(WEB, 'assets/js/home.js'), 'utf8');
  assert.match(home, /AtlasVenueClock/);
  assert.match(home, /Opening hours not set/);
  assert.match(home, /Opening hours unavailable/);
  assert.match(home, /Opening hours aren’t set/);
  assert.ok(!existsSync(path.join(WEB, 'assets/js/brain.js')), 'brain.js is retired');
});

test('index.html loads the venue clock after the shell and config, before Home', () => {
  const index = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const at = (needle) => index.indexOf(needle);
  const clock = at('<script src="assets/js/atlas-venue-clock.js?v=20260926-s88"></script>');
  assert.ok(clock > 0, 'atlas-venue-clock.js is linked with ?v=20260926-s88');
  assert.ok(at('assets/js/atlas-shell.js') < clock);
  assert.ok(at('<script src="config.js"></script>') < clock);
  assert.ok(clock < at('assets/js/home.js'));
  assert.equal(index.split('atlas-venue-clock.js').length - 1, 1, 'linked once');
});

test('Settings tells the venue clock when hours or the venue zone are saved', () => {
  const settings = readFileSync(path.join(WEB, 'assets/js/settings-workspace.js'), 'utf8');
  assert.match(settings, /emit\?\.\('settings:saved', \{ action, section_key/);
  const clock = readFileSync(path.join(WEB, 'assets/js/atlas-venue-clock.js'), 'utf8');
  assert.match(clock, /shell\.on\('settings:saved'/);
  assert.doesNotMatch(clock, /getHours\(|getDay\(|getDate\(|setHours\(|toLocale(?:Date|Time)?String\(/, 'the clock never reads the browser zone');
});
