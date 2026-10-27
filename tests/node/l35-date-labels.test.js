// Audit L35 (atlas-chrome.js and bookings-workspace.js parts): date labels
// follow the venue clock, not the device's zone or language. The bell's
// "older than a day" label is the venue's calendar day spelled 'Sep' (ICU
// en-GB says 'Sept'); the Bookings fallback label never uses the device
// language.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const CHROME = fs.readFileSync('apps/web/assets/js/atlas-chrome.js', 'utf8');
const CLOCK = fs.readFileSync('apps/web/assets/js/atlas-venue-clock.js', 'utf8');
const BOOKINGS = fs.readFileSync('apps/web/assets/js/bookings-workspace.js', 'utf8');

function extract(source, name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end + 4);
}

test('L35: the bell shows an older notification as the venue day, spelled "Sep"', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  class FrozenDate extends Date { static now() { return now; } }
  const context = { Date: FrozenDate, Intl, Number, Math, String, Object, Array, RegExp, JSON };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(CLOCK, context);
  vm.runInContext(`${extract(CHROME, 'relativeTime')}; this.relativeTime = relativeTime;`, context);
  // 23:30 on 27 September in Reykjavik is the 28th in Copenhagen or Tokyo:
  // the label is the venue's day either way.
  assert.equal(context.relativeTime('2026-09-27T23:30:00Z'), 'Sun 27 Sep');
  assert.equal(context.relativeTime(Date.parse('2026-09-30T11:30:00Z')), '30 min ago');
});

test('L35: the Bookings date fallback names its locale', () => {
  const longDate = extract(BOOKINGS, 'longDate');
  assert.doesNotMatch(longDate, /toLocaleDateString\(undefined/);
  const fn = vm.runInNewContext(`(${longDate.replace('function longDate', 'function')})`, { Date, Number });
  assert.equal(fn('2026-11-05'), 'Thu 5 Nov');
});
