import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('apps/web/config.js', 'utf8');
const layout = readFileSync('apps/web/assets/js/operations-checkpoint-a-layout.js', 'utf8');
const css = readFileSync('apps/web/assets/css/operations-checkpoint-a-layout.css', 'utf8');

test('compact layout is loaded after Checkpoint A', () => {
  assert.match(config, /operations-checkpoint-a-layout\.css/);
  assert.match(config, /operations-checkpoint-a-layout\.js/);
  assert.ok(
    config.indexOf("assets/js/operations-checkpoint-a.js")
      < config.indexOf("assets/js/operations-checkpoint-a-layout.js"),
    'The presentation layer must load after the routine engine.'
  );
});

test('Operations surfaces only scheduled work and opens details contextually', () => {
  assert.match(layout, /Atlas keeps the weekly schedule in the background and surfaces only what is due today/);
  assert.match(layout, /data-checkpoint-compact-open="routine"/);
  assert.match(layout, /data-checkpoint-compact-open="temperature"/);
  assert.match(layout, /checkpoint-a-context-modal/);
  assert.match(layout, /Open checklist/);
  assert.match(layout, /Open log/);
  assert.match(layout, /shell\.querySelector\('\.checkpoint-a-layout'\)\?\.setAttribute\('hidden'/);
});

test('Home receives one visually focused scheduled-day prompt', () => {
  assert.match(layout, /checkpoint-a-home-prompt/);
  assert.match(layout, /Scheduled today/);
  assert.match(layout, /homePromptSignature/);
  assert.match(layout, /data-checkpoint-home-open/);
});

test('marketing and reputation readiness move to Settings', () => {
  assert.match(layout, /checkpoint-a-integrations-settings/);
  assert.match(layout, /Marketing and reputation connections/);
  assert.match(layout, /Connection readiness belongs in Settings/);
  assert.match(layout, /Tripadvisor Management Center/);
});

test('refined layout keeps original Atlas styling and responsive behavior', () => {
  assert.match(css, /var\(--atlas-surface\)/);
  assert.match(css, /'Fraunces'/);
  assert.match(css, /'IBM Plex Sans'/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /@media\(max-width:430px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /Caprasimo|Figtree|--color-accent-2/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length);
});

test('presentation layer contains no direct database or operational mutation code', () => {
  assert.doesNotMatch(layout, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(layout, /\.from\s*\(/);
  assert.doesNotMatch(layout, /inventory_items|temperature_logs|routine_item_results/);
  assert.match(layout, /original\.click\(\)/);
});
