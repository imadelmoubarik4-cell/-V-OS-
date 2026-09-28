import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// S96: Atlas AI model calls are not stored at the provider (Responses API
// store defaults to true). Fails before the fix: RESPONSES_MODEL_SETTINGS
// does not exist and chat.mjs passes no modelSettings.
import * as config from '../../supabase/functions/atlas-ai/config.mjs';

test('Atlas AI Responses calls set store: false and carry encrypted reasoning inline', () => {
  assert.ok(config.RESPONSES_MODEL_SETTINGS, 'RESPONSES_MODEL_SETTINGS is exported');
  assert.equal(config.RESPONSES_MODEL_SETTINGS.store, false);
  assert.deepEqual([...config.RESPONSES_MODEL_SETTINGS.providerData.include], ['reasoning.encrypted_content']);
  const chat = readFileSync(new URL('../../supabase/functions/atlas-ai/chat.mjs', import.meta.url), 'utf8');
  assert.match(chat, /modelSettings: \{ orchestrator: RESPONSES_MODEL_SETTINGS, specialist: RESPONSES_MODEL_SETTINGS \}/);
  assert.match(chat, /modelSettings: RESPONSES_MODEL_SETTINGS,/, 'the optional guardrail classifier too');
});
