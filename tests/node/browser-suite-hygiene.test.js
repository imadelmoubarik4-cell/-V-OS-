// Browser-suite robustness (S88 architecture review, P2 #14): browser tests
// wait on conditions, never on fixed sleeps, and every page runs on a frozen
// clock anchored to fixture time, so no test depends on the wall clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('tests/browser');
const files = readdirSync(DIR).filter((name) => name.endsWith('.mjs'));

test('browser tests never sleep for a fixed time', () => {
  assert.ok(files.length > 10);
  for (const name of files) {
    const source = readFileSync(path.join(DIR, name), 'utf8');
    assert.doesNotMatch(source, /\bwaitForTimeout\s*\(/, `${name} uses page.waitForTimeout; wait on a condition (see tests/browser/README.md)`);
  }
});

test('the harness freezes every page clock at the fixture anchor by default', () => {
  const harness = readFileSync(path.join(DIR, 'harness.mjs'), 'utf8');
  assert.match(harness, /export const HARNESS_NOW = '2026-09-24T14:00:00\.000Z';/);
  assert.match(harness, /fixedTime = HARNESS_NOW, controlTimers = false \} = \{\}\) \{/);
  assert.match(harness, /else if \(fixedTime !== null && fixedTime !== undefined\) await page\.clock\.setFixedTime\(fixedTime\);/);
});

test('browser fixtures build dates from the fixture anchor, not the wall clock', () => {
  // Node-side fixture modules and test data: Date.now()/new Date() inside
  // page.evaluate callbacks run on the frozen page clock and are allowed.
  for (const name of files.filter((file) => file !== 'harness.mjs')) {
    const lines = readFileSync(path.join(DIR, name), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/\bDate\.now\(\)|new Date\(\)/.test(line)) return;
      const inPage = /window\.|document\.|page\.evaluate/.test(line);
      assert.ok(inPage, `${name}:${index + 1} reads the wall clock: ${line.trim()}`);
    });
  }
});
