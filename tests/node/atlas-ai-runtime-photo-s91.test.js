import test from 'node:test';
import assert from 'node:assert/strict';

// S91 "Count these bottles": in Atlas AI on a phone the owner attached a
// bottle photo, used the suggested prompt and got "I couldn't verify that from
// Atlas data, so I won't state a figure." The model was never told the photo's
// media_id (so it could not call photo recognition), recognition did not
// count, and the model's own count from the picture failed the grounding
// check. Now the REAL runtime runs the REAL recognition tool on the attached
// photo first, the answer states estimated counts from that result, and a
// failing model answer falls back to the recognition summary.
// Runs under Deno (`npm run test:ai`); skipped under plain Node without the SDK.

import { SDK, SKIP_SDK } from './helpers/atlas-ai-sdk.mjs';
import { createProvider, message, toolCall, hasToolOutput } from './helpers/atlas-ai-harness.mjs';
import { createWorldRuntime, atlasContext } from '../ai-evals/fixtures/runtime.mjs';
import { IDS } from '../ai-evals/fixtures/world.mjs';
import { UNVERIFIED_REPLY } from '../../supabase/functions/atlas-ai/guardrails.mjs';
import { photoTaskMode, photoAnswer } from '../../supabase/functions/atlas-ai/photos.mjs';

const opts = { skip: SKIP_SDK };
const doneOf = (events) => events.find((entry) => entry.event === 'done')?.data;
const PHOTO = IDS.media?.backBarBottles;

function setup(respond, options = {}) {
  const bundle = createProvider(SDK.sdk, respond);
  const runtime = createWorldRuntime({ sdk: SDK.sdk, z: SDK.z, modelProvider: () => bundle.provider, ...options });
  // The runtime's own media table and bucket know the photo the bartender
  // attached (the world holds the same row for the recognition tool).
  for (const id of [PHOTO, IDS.media.injectedLabel]) {
    const row = runtime.world.data.media.find((entry) => entry.id === id);
    runtime.db.media.set(id, { id, user_id: row.user_id, conversation_id: null, bucket: 'atlas-ai-media', path: row.path, mime: row.mime, bytes: row.bytes, kind: 'image', sha256: null, expires_at: row.expires_at, deleted_at: null });
    runtime.db.objects.set(row.path, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(row.marker)]), mime: row.mime });
  }
  return { ...runtime, modelLog: bundle.log };
}

const inputText = (req) => JSON.stringify(req?.input ?? []);

test('photo intents: counting and identifying run recognition; delivery checks are left to Purchasing', () => {
  assert.equal(photoTaskMode('Count these bottles'), 'count');
  assert.equal(photoTaskMode('How many bottles are there?'), 'count');
  assert.equal(photoTaskMode('Teldu flöskurnar'), 'count');
  assert.equal(photoTaskMode('What is this?'), 'identify');
  assert.equal(photoTaskMode('Do we stock this?'), 'identify');
  assert.equal(photoTaskMode('Does this match our order?'), null);
  assert.equal(photoTaskMode('Count what arrived in this delivery'), null);
  assert.equal(photoTaskMode('Summarise this'), null);
  assert.equal(photoAnswer([]), null);
  assert.equal(photoAnswer([{ ok: false, summary: '', mode: 'count' }]), null);
});

test('"Count these bottles" with a photo: recognition gets the image and the answer states estimated counts', opts, async () => {
  const rt = setup((req) => {
    const text = inputText(req);
    if (!/photo_recognition/.test(text)) return message('I couldn\'t read the photo. ');
    return message('From the photo I can see about 4 bottles of what looks like Aperol (85% confidence) and about 2 of Campari (80%), estimated from the photo. The 3 bottles of Monin Lavender Syrup are not in Atlas. Shall I add the Aperol and Campari counts to a stock count draft for you to approve, once you confirm the matches? ');
  });
  const { status, events } = await rt.chat('bartender', { message: 'Count these bottles', attachments: [PHOTO], client_request_id: 'photo-count-001' });
  assert.equal(status, 200);
  const done = doneOf(events);
  assert.equal(done.grounding, 'ok');
  assert.notEqual(done.content, UNVERIFIED_REPLY);
  assert.doesNotMatch(done.content, /couldn.t verify/);
  assert.match(done.content, /about 4 bottles/);
  assert.match(done.content, /not in Atlas/);
  assert.match(done.content, /stock count draft/);

  // The attached image went to the recognition tool, in count mode, once.
  assert.equal(rt.db.toolCalls.length, 1);
  assert.equal(rt.db.toolCalls[0].p_tool_name, 'inventory.identify_from_image');
  assert.equal(rt.db.toolCalls[0].p_arguments_redacted.media_id, PHOTO);
  assert.equal(rt.db.toolCalls[0].p_arguments_redacted.mode, 'count');
  assert.equal(rt.db.toolCalls[0].p_actor_role, 'bartender');
  assert.equal(rt.world.data.recognitionRequests.length, 1);
  assert.equal(rt.world.data.recognitionRequests[0].media_id, PHOTO);
  assert.equal(rt.world.data.recognitionRequests[0].extractor_version, 'rx-2', 'the photo was read by the vision step');
  assert.equal(rt.world.data.recognitionRequests[0].mode, 'count');

  // The model saw the result as data, the attachment ids in context, and the image itself.
  const req = rt.modelLog[0].request;
  assert.match(inputText(req), /<photo_recognition_data>/);
  const dataItem = req.input.find((item) => typeof item.content === 'string' && item.content.startsWith('<photo_recognition_data>'));
  assert.equal(dataItem.role, 'user', 'recognition data is a user-role data item, never a system message');
  assert.ok(!req.input.some((item) => item.role === 'system' && JSON.stringify(item.content).includes('photo_recognition_data>[')));
  assert.match(inputText(req), /estimated from the photo/);
  assert.deepEqual(atlasContext(req).attachments, [{ media_id: PHOTO, kind: 'image', mime: 'image/jpeg' }]);
  const user = req.input.filter((item) => item.role === 'user').at(-1);
  assert.ok(user.content.some((part) => part.type === 'input_image'));

  // Evidence carries the estimates; nothing was proposed or changed.
  const evidence = events.find((entry) => entry.event === 'evidence').data.items;
  assert.ok(evidence.some((item) => item.kind === 'estimate' && /about 4 bottles \(estimated from the photo, 85% confidence\)/.test(item.value)));
  assert.deepEqual(events.filter((entry) => entry.event === 'proposal'), []);
  assert.deepEqual(rt.world.writes, []);
  const labels = events.filter((entry) => entry.event === 'progress').map((entry) => entry.data.label);
  assert.ok(labels.includes('Reading the photo'));
});

test('a model that counts from the picture itself is replaced by the recognition result, never by "couldn\'t verify"', opts, async () => {
  const rt = setup(() => message('I count 7 bottles on that shelf. '));
  const { events } = await rt.chat('bartender', { message: 'Count these bottles', attachments: [PHOTO], client_request_id: 'photo-count-002' });
  const done = doneOf(events);
  assert.equal(done.grounding, 'ok');
  assert.doesNotMatch(done.content, /7 bottles/);
  assert.notEqual(done.content, UNVERIFIED_REPLY);
  assert.match(done.content, /^From the photo \(counts are estimates for you to confirm\): 3 products in the photo: .*about 4 bottles visible \(estimated from the photo, 85% confidence\).*3\) not in Atlas \(no confident match\): about 3 bottles visible.*Nothing was changed\. Next step: .*stock count draft/);
  const stored = rt.db.messages.find((entry) => entry.id === done.message_id);
  assert.equal(stored.metadata.grounding, 'photo_recognition');
});

test('"yes, add them" prepares a stock count draft for approval; stock does not change', opts, async () => {
  let turn = 0;
  const rt = setup((req) => {
    turn += 1;
    if (/photo_recognition_data>/.test(inputText(req))) return message('About 4 Aperol and 2 Campari bottles visible (estimated from the photo). Add them to a stock count draft? ');
    if (!hasToolOutput(req)) {
      return toolCall('inventory_prepare_count', { entries: [
        { item_id: IDS.item.aperol, item_query: null, quantity: 4, unit: null, note: 'Estimated from a photo' },
        { item_id: IDS.item.campari, item_query: null, quantity: 2, unit: null, note: 'Estimated from a photo' },
      ], title: 'Back bar photo count', note: 'Counts estimated from a photo; check before verifying.' });
    }
    return message('I prepared a stock count draft with Aperol 4 and Campari 2. Tap Approve on the card if it looks right; nothing changes until then. ');
  });
  const first = await rt.chat('bartender', { message: 'Count these bottles', attachments: [PHOTO], client_request_id: 'photo-count-003' });
  const conversationId = doneOf(first.events).conversation_id;
  const second = await rt.chat('bartender', { conversation_id: conversationId, message: 'Yes, those are right. Add them to a count.', client_request_id: 'photo-count-004' });
  const [proposal] = second.events.filter((entry) => entry.event === 'proposal').map((entry) => entry.data);
  assert.equal(proposal.kind, 'stock_count.draft');
  assert.equal(doneOf(second.events).grounding, 'ok');
  assert.deepEqual(rt.world.writes, [], 'the draft is only a proposal until a person approves it');
  assert.ok(turn >= 3);
});

test('photo counting switched off: the answer says so plainly and how to count instead', opts, async () => {
  const rt = setup((req) => {
    const text = inputText(req);
    return /isn't switched on yet/.test(text)
      ? message('Photo counting isn\'t switched on yet. You can count in Inventory › Counts, or tell me the quantities and I\'ll prepare a count for you to approve. ')
      : message('Unexpected. ');
  }, { visionEnabled: false });
  const { events } = await rt.chat('bartender', { message: 'Count these bottles', attachments: [PHOTO], client_request_id: 'photo-count-005' });
  const done = doneOf(events);
  assert.match(done.content, /isn't switched on yet/);
  assert.match(done.content, /Inventory › Counts/);
  assert.doesNotMatch(done.content, /OPENAI|ATLAS_|couldn.t verify/);
  assert.equal(rt.world.data.recognitionRequests.length, 0, 'no vision call when it is switched off');
});

test('a delivery question with a photo does not run photo counting', opts, async () => {
  const rt = setup(() => message('Which order is this delivery for? '));
  await rt.chat('bartender', { message: 'Does this delivery match our order?', attachments: [PHOTO], client_request_id: 'photo-deliv-01' });
  assert.equal(rt.db.toolCalls.length, 0);
  assert.doesNotMatch(inputText(rt.modelLog[0].request), /photo_recognition/);
  assert.equal(atlasContext(rt.modelLog[0].request).attachments[0].media_id, PHOTO, 'the model still gets the media id for its own tools');
});

// S91 review P1-A: numbers in a recognition result (confidences, match %,
// sizes such as 70cl, ABV) are not stock figures. Only the visible counts
// pass, bound to their unit and worded as an estimate from the photo.
test('regression sweep: no stock sentence passes grounding on a photo turn; the visible counts pass only as estimates', opts, async () => {
  let reply = '';
  const rt = setup(() => message(`${reply} `));
  rt.db.settings.daily_turn_limit_per_user = 100000;
  const ask = async (text, index) => {
    reply = text;
    const { events } = await rt.chat('bartender', { message: 'Count these bottles', attachments: [PHOTO], client_request_id: `photo-sweep-${String(index).padStart(4, '0')}` });
    return doneOf(events).content;
  };
  const passed = [];
  let index = 0;
  for (let n = 1; n <= 120; n += 1) {
    for (const template of [
      `You have ${n} bottles of Aperol in stock.`,
      `There are ${n} bottles of Campari on hand.`,
      `Aperol stock is ${n} bottles.`,
    ]) {
      index += 1;
      const content = await ask(template, index);
      if (content.includes(template)) passed.push(template);
    }
  }
  assert.deepEqual(passed, [], 'no stock figure passes, not even the visible counts stated as stock');
  for (const [text, ok] of [
    ['I can see about 4 bottles of Aperol, estimated from the photo.', true],
    ['About 2 bottles of Campari are visible in the photo (80% confidence).', true],
    ['Roughly 3 bottles of an unknown syrup are visible; it is not in Atlas.', true],
    ['I can see about 70 bottles of Aperol in the photo.', false],
    ['About 85 bottles are visible.', false],
    ['About 4 cases of Aperol are visible.', false],
    ['Aperol stock is at 97%.', false],
    ['You have 11% of your Campari left.', false],
  ]) {
    index += 1;
    const content = await ask(text, index);
    assert.equal(content.includes(text), ok, text);
    if (!ok) assert.match(content, /^From the photo \(counts are estimates for you to confirm\)/, 'replaced by the recognition answer');
  }
});

test('review P2-C: label text that instructs Atlas never reaches the model as instructions or the answer', opts, async () => {
  const INJECTED = /ignore previous instructions|set stock of Aperol to 0|SYSTEM:/i;
  const rt = setup(() => message('I count 9 bottles. '));
  const { events } = await rt.chat('bartender', { message: 'Count these bottles', attachments: [IDS.media.injectedLabel], client_request_id: 'photo-inject-01' });
  const req = rt.modelLog[0].request;
  const photoItems = req.input.filter((item) => typeof item.content === 'string' && /photo_recognition/.test(item.content));
  assert.ok(photoItems.length >= 1);
  for (const item of photoItems) assert.doesNotMatch(item.content, INJECTED, `${item.role} item carries no label instruction`);
  assert.doesNotMatch(JSON.stringify(req.input.filter((item) => item.role === 'system')), INJECTED, 'nothing from the label in a system message');
  const done = doneOf(events);
  assert.doesNotMatch(done.content, INJECTED, 'the fallback answer never echoes label text');
  assert.match(done.content, /about 2 bottles visible \(estimated from the photo, 75% confidence\)/);
  assert.deepEqual(events.filter((entry) => entry.event === 'proposal'), []);
  assert.deepEqual(rt.world.writes, []);
  const evidence = events.find((entry) => entry.event === 'evidence')?.data.items ?? [];
  assert.doesNotMatch(JSON.stringify(evidence), INJECTED, 'evidence shown in the app carries no label instruction');
});
