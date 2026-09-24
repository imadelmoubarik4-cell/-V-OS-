// S88 Atlas AI (#ai): conversations, streamed answers with progress, evidence
// and records, approvals, attachments, voice notes, live voice, history,
// Decisions, deep links, phone layout and accessibility. Runs the shipped
// atlas-ai.js / atlas-ai-voice.js in Chromium against a mocked atlas-ai.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, requestsTo, USERS } from './harness.mjs';
import { aiFixtures, IDS, fakeMediaInit, orderProposal } from './atlas-ai-fixtures.mjs';

const skip = harnessAvailable() ? false : 'Playwright/Chromium harness dependencies are not installed';

// Replaces the chat response with a stream the test feeds event by event.
function manualStreamInit() {
  const original = window.fetch.bind(window);
  window.__chat = { bodies: [], aborted: false };
  window.fetch = (input, init = {}) => {
    const url = String(input?.url || input);
    if (url.includes('/functions/v1/atlas-ai') && url.includes('action=chat')) {
      window.__chat.bodies.push(JSON.parse(init.body));
      const encoder = new TextEncoder();
      let controller;
      const stream = new ReadableStream({ start(value) { controller = value; } });
      init.signal?.addEventListener('abort', () => {
        window.__chat.aborted = true;
        try { controller.error(new DOMException('The user aborted a request.', 'AbortError')); } catch { /* closed */ }
      });
      window.__chat.push = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      window.__chat.end = () => controller.close();
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }
    return original(input, init);
  };
}

async function openAi(options = {}) {
  const { fixtures, backend } = aiFixtures(options.backend || {});
  const launched = await launchAtlas({
    user: options.user || USERS.admin,
    fixtures,
    hash: options.hash || '#ai/new',
    viewport: options.viewport,
    contextOptions: options.contextOptions,
    storage: { 'atlas.ai.voice.explained.v1': 'yes', ...(options.storage || {}) },
    initScript: options.initScript
  });
  await launched.page.waitForSelector('#ai-view .composer textarea');
  await launched.page.waitForTimeout(300);
  return { ...launched, backend };
}

const aiText = (page) => page.$eval('#ai-view', (node) => node.innerText);
const calls = (backend, action) => backend.state.calls.filter((entry) => entry.action === action);

async function typeAndSend(page, text) {
  await page.fill('#ai-composer-input', text);
  await page.keyboard.press('Enter');
}

test('a new conversation streams progress, text, evidence, records and a proposal', { skip }, async () => {
  const { page, close, backend, record } = await openAi({ initScript: manualStreamInit });
  try {
    assert.match(await aiText(page), /What can I help with, Imad\?/);
    await typeAndSend(page, 'Can we still make Negronis tonight?');
    await page.waitForFunction(() => window.__chat?.push);
    assert.equal(calls(backend, 'create').length, 1, 'the conversation is created before the first turn');
    const [body] = await page.evaluate(() => window.__chat.bodies);
    assert.equal(body.conversation_id, IDS.created);
    assert.equal(body.message, 'Can we still make Negronis tonight?');
    assert.equal(body.source, 'text');
    assert.match(body.client_request_id, /^[A-Za-z0-9._:-]{8,100}$/);
    assert.ok(await page.isVisible('[data-ai-stop]'), 'stop replaces send while streaming');

    await page.evaluate(() => window.__chat.push('progress', { label: 'Checking stock' }));
    await page.waitForSelector('.steps-line.is-running');
    assert.match(await page.textContent('.steps-line.is-running'), /Checking stock…/);
    await page.evaluate(() => window.__chat.push('progress', { label: 'Looking through recipes' }));
    await page.evaluate(() => window.__chat.push('delta', { text: 'Yes, but only about ' }));
    await page.waitForFunction(() => /Yes, but only about/.test(document.querySelector('.msg-ai [data-ai-text]')?.innerText || ''));
    await page.evaluate((proposal) => {
      window.__chat.push('proposal', proposal);
      window.__chat.push('delta', { text: 'thirty Negronis (draft).' });
    }, orderProposal());
    await page.waitForSelector('[data-ai-approval]');
    await page.evaluate(({ IDS: ids }) => {
      window.__chat.push('evidence', { items: [
        { kind: 'fact', label: 'Campari on hand', value: '1 bottle', source: { type: 'stock_count', label: 'Count · Tue 22 Sep' } },
        { kind: 'calculation', label: 'Negronis per bottle', value: '33', source: { type: 'recipe', id: ids.negroni, label: 'Recipe · Negroni' } },
        { kind: 'interpretation', label: 'Tonight looks busy', value: null, source: null },
        { kind: 'estimate', label: 'Usual sales', value: '40–50', source: { type: 'report', id: 'sales', label: 'Reports · sales' } },
        { kind: 'missing', label: 'Sales since the count', value: 'not recorded', source: { type: 'integration', label: 'No POS link' } }
      ] });
      window.__chat.push('records', { items: [{ type: 'inventory_item', id: ids.campari, label: 'Campari' }, { type: 'recipe', id: ids.negroni, label: 'Negroni' }] });
      window.__chat.push('done', { message_id: 'm-9', conversation_id: ids.created, content: 'Yes, but only about 30 Negronis. You have one bottle of Campari left.' });
      window.__chat.end();
    }, { IDS });
    await page.waitForSelector('[data-ai-steps]');
    assert.equal((await page.textContent('[data-ai-steps]')).trim(), 'Checked stock and looked through recipes');
    const answer = await page.textContent('.msg-ai [data-ai-text]');
    assert.equal(answer.trim(), 'Yes, but only about 30 Negronis. You have one bottle of Campari left.', 'done.content is authoritative');
    assert.match(await page.innerHTML('.msg-ai [data-ai-text]'), /<strong>Yes, but only about 30 Negronis\.<\/strong>/);
    const kinds = await page.$$eval('.evidence .kind', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(kinds, ['Verified', 'Calculated', 'Interpretation', 'Estimate', 'Missing']);
    assert.equal(await page.getAttribute('[data-ai-evidence]', 'aria-expanded'), 'true', 'evidence opens when something is missing');
    const chips = await page.$$eval('.records .record-chip', (nodes) => nodes.map((node) => [node.textContent.trim(), node.getAttribute('href')]));
    assert.deepEqual(chips, [['Campari', `#inventory/item/${IDS.campari}`], ['Negroni', `#recipes/${IDS.negroni}`]]);
    assert.ok(await page.isVisible('[data-ai-approve]'));
    assert.ok(await page.isVisible('.send:not(.send--stop)'), 'send returns after the answer');
    const text = await aiText(page);
    assert.doesNotMatch(text, /[{}]|\b(function|tool|agent|JSON)\b|_[a-z]+_/i, 'no internal names or JSON in the thread');
    // Record chips open the record through the shell routes.
    await page.click('.records .record-chip');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'inventory');
    assert.equal(record.pageErrors.length, 0, record.pageErrors.join('\n'));
  } finally { await close(); }
});

test('stop aborts the stream, keeps the partial answer and try again regenerates', { skip }, async () => {
  const { page, close } = await openAi({ initScript: manualStreamInit });
  try {
    await typeAndSend(page, 'What should I order?');
    await page.waitForFunction(() => window.__chat?.push);
    await page.evaluate(() => { window.__chat.push('progress', { label: 'Working out what to order' }); window.__chat.push('delta', { text: 'Start with Campari' }); });
    await page.waitForFunction(() => /Start with Campari/.test(document.querySelector('.msg-ai [data-ai-text]')?.innerText || ''));
    await page.click('[data-ai-stop]');
    await page.waitForSelector('.msg-ai__stopped');
    assert.equal(await page.evaluate(() => window.__chat.aborted), true, 'the request was aborted');
    assert.match(await page.textContent('.msg-ai__stopped'), /Stopped\. This answer is incomplete\./);
    assert.match(await page.textContent('.msg-ai [data-ai-text]'), /Start with Campari/);
    assert.ok(await page.isVisible('.send:not(.send--stop)'));
    await page.click('.msg-actions [data-ai-retry]');
    await page.waitForFunction(() => window.__chat.bodies.length === 2);
    const second = await page.evaluate(() => window.__chat.bodies[1]);
    assert.equal(second.regenerate, true);
    assert.equal(second.conversation_id, IDS.created);
  } finally { await close(); }
});

test('approving calls execute-action once and shows the confirmed result', { skip }, async () => {
  const { page, close, backend } = await openAi({ hash: `#ai/c/${IDS.convNegroni}` });
  try {
    await page.waitForSelector('[data-ai-approve]');
    assert.match(await page.textContent('[data-ai-approval]'), /Order from Globus[\s\S]*Needs approval[\s\S]*Campari 1 L[\s\S]*23\.400 kr[\s\S]*39\.100 kr/);
    assert.match(await page.textContent('.approval__note'), /Will change:.*Purchasing[\s\S]*Will not change:.*not placed or sent/);
    assert.match(await page.textContent('.approval__foot'), /Expires (today|tomorrow) at \d\d:\d\d/);
    // Two taps in a row still approve once.
    await page.evaluate(() => { const button = document.querySelector('[data-ai-approve]'); button.click(); button.click(); });
    await page.waitForSelector('[data-ai-approval] .atlas-pill--positive');
    assert.equal(calls(backend, 'execute-action').length, 1);
    assert.equal(calls(backend, 'execute-action')[0].body.action_id, IDS.action);
    assert.match(await page.textContent('[data-ai-approval]'), /Order created/);
    assert.match(await page.textContent('.approval__foot--done'), /Draft order saved in Purchasing\.[\s\S]*View order/);
    assert.equal(await page.getAttribute('.approval__foot--done a', 'href'), '#purchasing/order/po-1');
    assert.equal(await page.locator('[data-ai-approve]').count(), 0, 'no approve button after success');
  } finally { await close(); }
});

test('a failed approval says so and never shows success', { skip }, async () => {
  const { fixtures } = aiFixtures();
  const original = fixtures.functions['atlas-ai'];
  fixtures.functions['atlas-ai'] = (entry) => (entry.action === 'execute-action'
    ? { ok: false, action: { id: IDS.action, status: 'failed' }, result: null, error: { code: 'conflict', message: 'raw database text' } }
    : original(entry));
  const { page, close } = await launchAtlas({ fixtures, hash: `#ai/c/${IDS.convNegroni}` });
  try {
    await page.waitForSelector('[data-ai-approve]');
    await page.click('[data-ai-approve]');
    await page.waitForSelector('.approval__failed');
    const text = await page.textContent('[data-ai-approval]');
    assert.match(text, /Failed[\s\S]*This couldn’t be completed\.[\s\S]*Nothing was changed/);
    assert.doesNotMatch(text, /raw database text|Order created/);
    assert.equal(await page.locator('[data-ai-approval] [data-ai-approve]').count(), 0, 'a refused proposal is not retried from the card');
  } finally { await close(); }
});

test('a bartender sees manager-only proposals as waiting, with approve disabled', { skip }, async () => {
  const { page, close, backend } = await openAi({ user: USERS.bartender, hash: `#ai/c/${IDS.convNegroni}` });
  try {
    await page.waitForSelector('[data-ai-approval]');
    const card = await page.textContent('[data-ai-approval]');
    assert.match(card, /Waiting for a manager/);
    assert.match(card, /Only a manager can approve this\./);
    const button = await page.$('.approval__foot .atlas-btn--primary');
    assert.equal(await button.isDisabled(), true);
    assert.equal(await button.getAttribute('title'), 'Only a manager can approve this');
    await button.click({ force: true });
    await page.waitForTimeout(200);
    assert.equal(calls(backend, 'execute-action').length, 0);
    assert.equal(await page.locator('[data-ai-mode="decisions"]').filter({ visible: true }).count(), 0, 'no Decisions tab for staff');
  } finally { await close(); }
});

test('when Atlas AI is off the page says so and falls back to quick answers', { skip }, async () => {
  const { page, close, backend } = await openAi({ backend: { configured: false } });
  try {
    await page.waitForSelector('.ai-empty--off');
    const text = await aiText(page);
    assert.match(text, /Atlas AI isn’t switched on yet/);
    assert.match(text, /Set it up in Settings › Atlas AI/);
    assert.ok(await page.isVisible('.ai-empty--off a[href="#settings/ai"]'));
    await typeAndSend(page, 'What is low in stock?');
    await page.waitForSelector('.msg-ai__label');
    assert.match(await page.textContent('.msg-ai'), /Quick answer[\s\S]*Atlas AI is off/);
    assert.equal(calls(backend, 'chat').length, 0, 'no chat request once Atlas AI is known to be off');
    await typeAndSend(page, 'Why are margins lower this month?');
    await page.waitForFunction(() => document.querySelectorAll('.msg-ai').length === 2);
    assert.match(await page.$$eval('.msg-ai', (nodes) => nodes[1].innerText), /Atlas AI is off, so I can’t answer that yet/);
    assert.equal(await page.isDisabled('[data-ai-attach]'), true, 'uploads need Atlas AI');
  } finally { await close(); }
});

test('a 503 on the first question switches to the truthful off state', { skip }, async () => {
  const { fixtures } = aiFixtures();
  const original = fixtures.functions['atlas-ai'];
  // Staff cannot read the owner settings, so the first answer tells the truth.
  fixtures.functions['atlas-ai'] = (entry) => (entry.action === 'settings'
    ? { __status: 403, body: { error_code: 'forbidden', message: 'Managers only.' } }
    : entry.action === 'chat' ? { __status: 503, body: { error_code: 'not_configured', message: 'Atlas AI is not configured' } }
      : original(entry));
  const { page, close } = await launchAtlas({ fixtures, hash: '#ai/new' });
  try {
    await page.waitForSelector('#ai-composer-input');
    await page.waitForTimeout(300);
    await typeAndSend(page, 'Who works tomorrow?');
    await page.waitForSelector('.msg-ai__label');
    assert.equal(await page.$$eval('.msg-user', (nodes) => nodes.length), 1, 'the question appears once');
    assert.match(await page.textContent('.msg-ai'), /Quick answer/);
    assert.match(await page.textContent('#ai-view'), /Atlas AI is off/);
  } finally { await close(); }
});

test('photos and files upload with progress and are sent with the question', { skip }, async () => {
  const { page, close, backend } = await openAi();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('[data-ai-file-any]', { name: 'delivery-note.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('[data-ai-att] .file-chip__meta');
    assert.match(await page.textContent('[data-ai-att]'), /delivery-note\.png/);
    assert.equal(calls(backend, 'upload').length, 1);
    assert.equal(calls(backend, 'create').length, 1, 'uploads belong to a conversation');
    assert.ok(await page.isVisible('[data-ai-prompt="Does this match our order?"]'), 'photo prompts appear');
    await page.click('[data-ai-prompt="Does this match our order?"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-ai-steps]');
    const chat = calls(backend, 'chat')[0];
    assert.deepEqual(chat.body.attachments, [IDS.media]);
    assert.equal(chat.body.message, 'Does this match our order?');
    assert.ok(await page.isVisible('.msg-user .msg-photo img'));
    assert.equal(await page.isVisible('[data-ai-att]'), false, 'attachments clear after sending');
    // Removing a chip before sending drops it.
    await page.setInputFiles('[data-ai-file-any]', { name: 'second.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('[data-ai-remove-att]');
    await page.click('[data-ai-remove-att]');
    assert.equal(await page.locator('[data-ai-att]').count(), 0);
  } finally { await close(); }
});

test('a voice note is recorded, transcribed, edited and sent as a voice note', { skip }, async () => {
  const { page, close, backend } = await openAi({ initScript: fakeMediaInit });
  try {
    await page.click('[data-ai-voice-note]');
    await page.waitForSelector('[data-ai-rec-stop]');
    assert.ok(await page.evaluate(() => window.__recorderStarted));
    assert.match(await page.textContent('[data-ai-record]'), /0:0\d/);
    await page.click('[data-ai-rec-stop]');
    await page.waitForFunction(() => document.querySelector('#ai-composer-input').value.length > 0);
    assert.equal(calls(backend, 'transcribe').length, 1);
    assert.equal(await page.inputValue('#ai-composer-input'), 'I just counted six bottles of Tanqueray and two Campari');
    assert.match(await page.textContent('[data-ai-attachments]'), /Voice note · 0:04/);
    assert.equal(calls(backend, 'chat').length, 0, 'nothing is sent until the person sends');
    await page.fill('#ai-composer-input', 'I just counted seven bottles of Tanqueray and two Campari');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-ai-steps]');
    const chat = calls(backend, 'chat')[0];
    assert.equal(chat.body.source, 'voice_note');
    assert.equal(chat.body.duration, 4.2);
    assert.equal(chat.body.message, 'I just counted seven bottles of Tanqueray and two Campari');
    assert.match(await page.textContent('.msg-user'), /Voice note · 0:04/);
    // Cancel discards a recording without transcribing.
    await page.click('[data-ai-voice-note]');
    await page.waitForSelector('[data-ai-rec-cancel]');
    await page.click('[data-ai-rec-cancel]');
    assert.equal(calls(backend, 'transcribe').length, 1);
    assert.ok(await page.isVisible('[data-ai-voice-note]'));
  } finally { await close(); }
});

test('live voice connects over WebRTC, runs tools through the server and shows proposals', { skip }, async () => {
  const { page, context, close, backend } = await openAi({ initScript: fakeMediaInit, hash: `#ai/c/${IDS.convNegroni}` });
  const sdp = [];
  await context.route('https://api.openai.com/**', (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    sdp.push({ url: request.url(), auth: request.headers().authorization, type: request.headers()['content-type'], body: request.postData() });
    return route.fulfill({ status: 201, contentType: 'application/sdp', headers: { 'access-control-allow-origin': '*' }, body: 'v=0 harness-answer' });
  });
  try {
    await page.click('[data-ai-live]');
    await page.waitForSelector('.voice[data-state="listening"]');
    assert.equal(calls(backend, 'voice-session').length, 1);
    assert.equal(calls(backend, 'voice-session')[0].body.conversation_id, IDS.convNegroni);
    assert.deepEqual(sdp, [{ url: 'https://api.openai.com/v1/realtime/calls', auth: 'Bearer ek_harness_secret', type: 'application/sdp', body: 'v=0 harness-offer' }]);
    assert.equal(await page.evaluate(() => window.__pc.label), 'oai-events');
    assert.equal(await page.evaluate(() => window.__pc.remoteDescription.sdp), 'v=0 harness-answer');
    assert.equal(await page.isVisible('.composer'), false, 'the voice panel replaces the composer');

    const state = () => page.getAttribute('.voice', 'data-state');
    await page.evaluate(() => window.__dc.serverEvent({ type: 'input_audio_buffer.speech_started' }));
    assert.equal(await state(), 'listening');
    await page.evaluate(() => window.__dc.serverEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: 'Six bottles of Tanqueray' }));
    await page.waitForSelector('.voice__transcript .is-interim');
    await page.evaluate(() => window.__dc.serverEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Six bottles of Tanqueray and two Campari' }));
    await page.evaluate(() => window.__dc.serverEvent({ type: 'input_audio_buffer.speech_stopped' }));
    assert.equal(await state(), 'thinking');
    assert.match(await page.textContent('.voice__state'), /Thinking/);

    await page.evaluate(() => window.__dc.serverEvent({ type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', call_id: 'call_1', name: 'stock_count_draft', arguments: '{"entries":[]}' } }));
    await page.waitForFunction(() => window.__dc.sent.some((event) => event.type === 'response.create'));
    const tool = calls(backend, 'voice-tool');
    assert.equal(tool.length, 1);
    assert.deepEqual({ name: tool[0].body.name, call: tool[0].body.call_id, conversation: tool[0].body.conversation_id, session: tool[0].body.voice_session_id }, { name: 'stock_count_draft', call: 'call_1', conversation: IDS.convNegroni, session: 'sess_harness' });
    const sent = await page.evaluate(() => window.__dc.sent);
    assert.deepEqual(sent[0], { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: 'Tanqueray: 6 bottles counted. Prepared "Back bar count" as a proposal card on screen.' } });
    assert.deepEqual(sent[1], { type: 'response.create' });
    // The same call delivered twice runs once.
    await page.evaluate(() => window.__dc.serverEvent({ type: 'response.function_call_arguments.done', call_id: 'call_1', name: 'stock_count_draft', arguments: '{}' }));
    await page.waitForTimeout(150);
    assert.equal(calls(backend, 'voice-tool').length, 1);
    await page.waitForSelector(`[data-ai-approval="${IDS.voiceAction}"]`);
    assert.match(await page.textContent(`[data-ai-approval="${IDS.voiceAction}"]`), /Back bar count[\s\S]*Save count for review/);

    await page.evaluate(() => window.__dc.serverEvent({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'Got it, six Tanqueray.' }));
    assert.equal(await state(), 'speaking');
    await page.evaluate(() => window.__dc.serverEvent({ type: 'input_audio_buffer.speech_started' }));
    assert.equal(await state(), 'interrupted', 'speaking over Atlas interrupts it');
    await page.evaluate(() => window.__dc.serverEvent({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: 'Got it, six Tanqueray.' }));
    await page.click('[data-ai-live-mute]');
    assert.equal(await state(), 'muted');
    assert.match(await page.textContent('[data-ai-live-mute]'), /Unmute/);
    await page.click('[data-ai-live-transcript]');
    assert.equal(await page.locator('.voice__transcript').count(), 0, 'transcript can be hidden');

    await page.click('[data-ai-live-end]');
    await page.waitForSelector('.voice', { state: 'detached' });
    for (let tries = 0; tries < 40 && calls(backend, 'voice-append').flatMap((entry) => entry.body.turns).length < 2; tries += 1) await page.waitForTimeout(100);
    await page.waitForFunction(() => document.querySelector('.composer') && getComputedStyle(document.querySelector('.composer')).display !== 'none');
    const appended = calls(backend, 'voice-append').flatMap((entry) => entry.body.turns);
    assert.deepEqual(appended.map((turn) => [turn.role, turn.text]), [['user', 'Six bottles of Tanqueray and two Campari'], ['assistant', 'Got it, six Tanqueray.']]);
    assert.ok(appended.every((turn) => /^[A-Za-z0-9._:-]{8,128}$/.test(turn.client_request_id)));
    assert.doesNotMatch(await aiText(page), /stock_count_draft|ek_harness_secret|function_call/);
  } finally { await close(); }
});

test('history: search, rename, pin and delete with confirmation', { skip }, async () => {
  const { page, close, backend } = await openAi({ hash: `#ai/c/${IDS.convNegroni}` });
  try {
    const labels = await page.$$eval('.ai-list__label', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(labels, ['Pinned', 'Today', 'Earlier']);
    assert.equal(await page.getAttribute(`[data-ai-open-conv="${IDS.convNegroni}"]`, 'aria-current'), 'true');

    await page.click('[data-ai-search-toggle]');
    await page.fill('#ai-list-search-input', 'paloma');
    await page.waitForTimeout(400);
    assert.deepEqual(await page.$$eval('.ai-conv__t', (nodes) => nodes.map((node) => node.textContent)), ['Cost of a Paloma']);
    assert.ok(calls(backend, 'conversations').some((entry) => new URLSearchParams(entry.search).get('q') === 'paloma'));
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval('.ai-conv', (nodes) => nodes.length), 4);

    await page.hover(`[data-ai-open-conv="${IDS.convPaloma}"]`);
    await page.click(`[data-ai-conv-menu="${IDS.convPaloma}"]`);
    await page.click('.ai-menu__item:has-text("Rename")');
    await page.fill('.ai-dialog input', 'Paloma costing');
    await page.click('.ai-dialog button[type="submit"]');
    await page.waitForSelector('.ai-conv__t:has-text("Paloma costing")');
    assert.equal(calls(backend, 'rename').at(-1).body.title, 'Paloma costing');

    await page.click(`[data-ai-conv-menu="${IDS.convPaloma}"]`);
    await page.click('.ai-menu__item:has-text("Pin")');
    await page.waitForFunction(() => [...document.querySelectorAll('.ai-list__group')][0].innerText.includes('Paloma costing'));
    assert.equal(calls(backend, 'pin').at(-1).body.pinned, true);

    const trigger = `[data-ai-conv-menu="${IDS.convPaloma}"]`;
    await page.click(trigger);
    await page.click('.ai-menu__item:has-text("Delete")');
    await page.waitForSelector('.ai-dialog');
    assert.match(await page.textContent('.ai-dialog'), /Delete this conversation\?[\s\S]*Orders, counts or messages Atlas already created stay as they are\./);
    // Focus stays inside the dialog.
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.activeElement.closest('.ai-dialog') !== null));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ai-dialog', { state: 'detached' });
    assert.equal(calls(backend, 'delete').length, 0, 'Escape cancels');
    assert.ok(await page.evaluate((selector) => document.activeElement === document.querySelector(selector), trigger), 'focus returns to the trigger');
    await page.click(trigger);
    await page.click('.ai-menu__item:has-text("Delete")');
    await page.click('.ai-dialog [data-ai-confirm]');
    await page.waitForFunction((id) => !document.querySelector(`[data-ai-open-conv="${id}"]`), IDS.convPaloma);
    assert.equal(calls(backend, 'delete')[0].body.conversation_id, IDS.convPaloma);

    // Opening another conversation updates the route.
    await page.click(`[data-ai-open-conv="${IDS.convDelivery}"]`);
    await page.waitForFunction((id) => location.hash === `#ai/c/${id}`, IDS.convDelivery);
  } finally { await close(); }
});

test('deep links open a conversation, Decisions for managers and the #atlas alias', { skip }, async () => {
  const opened = await openAi({ hash: `#ai/c/${IDS.convNegroni}` });
  try {
    await opened.page.waitForSelector('.msg-ai');
    assert.equal(await opened.page.evaluate(() => document.body.dataset.atlasView), 'ai');
    assert.match(await opened.page.textContent('.ai-thread__title'), /Negroni tonight and Campari order/);
    assert.ok(calls(opened.backend, 'conversation').some((entry) => new URLSearchParams(entry.search).get('id') === IDS.convNegroni));
  } finally { await opened.close(); }

  const decisions = await openAi({ hash: '#atlas/decisions' });
  try {
    await decisions.page.waitForSelector('.ai-dec-row:not(.ai-dec-row--head)');
    assert.equal(await decisions.page.evaluate(() => location.hash), '#ai/decisions');
    const rows = await decisions.page.$$eval('.ai-dec-row:not(.ai-dec-row--head)', (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, ' ')));
    assert.equal(rows.length, 3);
    assert.match(rows[0], /Order Campari before Friday.*Atlas AI.*Proposed/);
    await decisions.page.selectOption('#ai-dec-status', 'dismissed');
    assert.equal(await decisions.page.$$eval('.ai-dec-row:not(.ai-dec-row--head)', (nodes) => nodes.length), 1);
    await decisions.page.selectOption('#ai-dec-status', 'all');
  } finally { await decisions.close(); }

  const staff = await openAi({ user: USERS.bartender, hash: '#ai/decisions' });
  try {
    await staff.page.waitForSelector('[data-ai-decisions]:not([hidden])');
    assert.match(await staff.page.textContent('[data-ai-decisions]'), /Decisions are for managers/);
    assert.equal(await staff.page.locator('.ai-dec-row').count(), 0);
  } finally { await staff.close(); }
});

test('Decisions opens a record sheet and saves a decision', { skip }, async () => {
  const { fixtures } = aiFixtures();
  const posts = [];
  fixtures.functions['atlas-phase3-brain'] = (entry) => {
    if (entry.method === 'POST') { posts.push(entry); return { result: { ok: true } }; }
    if (entry.action === 'detail') return { detail: { recommendation: { id: 'r-1', title: 'Order Campari before Friday', summary: 'One bottle left.', explanation: 'Negroni needs Campari.', evidence: [{ label: 'Campari on hand', value: { bottles: 1 } }] }, memory: [] } };
    return { snapshot: { recommendations: [{ id: 'r-1', title: 'Order Campari before Friday', summary: 'One bottle left.', status: 'active', generated_by: 'atlas-ai/s88', recommendation_type: 'purchasing' }], memory: [] } };
  };
  const { page, close } = await launchAtlas({ fixtures, hash: '#ai/decisions' });
  try {
    await page.click('[data-ai-dec-open="r-1"]');
    await page.waitForSelector('.ai-sheet [data-ai-dec-form]');
    assert.match(await page.textContent('.ai-sheet'), /What was recommended[\s\S]*Negroni needs Campari\.[\s\S]*Campari on hand[\s\S]*bottles: 1/);
    await page.selectOption('.ai-sheet select[name="decision"]', 'accept');
    await page.fill('.ai-sheet textarea[name="notes"]', 'Ordered with Friday delivery');
    await page.click('.ai-sheet [data-ai-dec-form] button[type="submit"]');
    await page.waitForSelector('.ai-sheet', { state: 'detached' });
    assert.equal(posts[0].action, 'decision');
    assert.deepEqual({ id: posts[0].body.recommendation_id, decision: posts[0].body.decision, notes: posts[0].body.notes }, { id: 'r-1', decision: 'accept', notes: 'Ordered with Friday delivery' });
  } finally { await close(); }
});

test('search questions and Ask Atlas actions open Atlas AI with the question', { skip }, async () => {
  const { fixtures, backend } = aiFixtures();
  const { page, close } = await launchAtlas({ fixtures });
  try {
    await page.click('#global-search');
    await page.fill('#global-search', 'pinot');
    await page.waitForTimeout(250);
    const options = await page.$$eval('.atlas-search-option', (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, ' ').trim()));
    assert.match(options.at(-1), /^Ask Atlas “pinot”/, 'the last row asks Atlas');
    await page.fill('#global-search', 'Why are margins lower this month?');
    await page.waitForTimeout(250);
    assert.match((await page.$$eval('.atlas-search-option', (nodes) => nodes.map((node) => node.innerText)))[0], /Ask Atlas/, 'questions put Ask Atlas first');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'ai');
    await page.waitForSelector('[data-ai-steps]');
    assert.equal(backend.state.calls.find((entry) => entry.action === 'chat').body.message, 'Why are margins lower this month?');
    // Record-scoped canonical action carries page context.
    const actions = await page.evaluate(() => window.AtlasShell.actions.list({ role: 'admin', record: { type: 'recipe', id: 'r1', label: 'Negroni' } }).map((action) => action.id));
    assert.ok(actions.includes('ai.ask') && actions.includes('ai.ask.record'));
    await page.evaluate(() => window.AtlasShell.actions.run('ai.ask.record', { role: 'admin', record: { type: 'recipe', id: 'r1', label: 'Negroni' } }));
    await page.waitForSelector('.composer__ctx');
    assert.match(await page.textContent('.composer__ctx'), /Negroni/);
    await typeAndSend(page, 'What does it cost?');
    await page.waitForFunction(() => document.querySelectorAll('[data-ai-steps]').length >= 1 && !document.querySelector('.composer__ctx'));
    const chat = backend.state.calls.filter((entry) => entry.action === 'chat').at(-1);
    assert.deepEqual(chat.body.page_context, { view: 'ai', entity: { type: 'recipe', id: 'r1', label: 'Negroni' } });
    // The context chip is removable before sending.
    await page.evaluate(() => window.AtlasAI.askAbout({ type: 'inventory_item', id: 'x1', label: 'Campari' }));
    await page.waitForSelector('[data-ai-clear-context]');
    await page.click('[data-ai-clear-context]');
    assert.equal(await page.locator('.composer__ctx').count(), 0);
  } finally { await close(); }
});

test('phone: no sideways scroll, composer in reach, 44 px targets and a focus-trapped history sheet', { skip }, async () => {
  const { page, close } = await openAi({ hash: `#ai/c/${IDS.convNegroni}`, viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    await page.waitForSelector('.msg-ai');
    const layout = await page.evaluate(() => {
      const composer = document.querySelector('.composer').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth - window.innerWidth, composerBottom: composer.bottom, height: window.innerHeight, composerTop: composer.top };
    });
    assert.ok(layout.overflow <= 0, `page scrolls sideways by ${layout.overflow}px`);
    assert.ok(layout.composerBottom <= layout.height && layout.composerTop > layout.height * 0.6, JSON.stringify(layout));
    const small = await page.evaluate(() => [...document.querySelectorAll('#ai-view button, #ai-view a[href]')]
      .filter((node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && !node.closest('.ai-list') && rect.bottom > 0 && rect.top < window.innerHeight; })
      .map((node) => { const rect = node.getBoundingClientRect(); return { label: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 30), h: Math.round(rect.height), w: Math.round(rect.width) }; })
      .filter((entry) => entry.h < 44 || entry.w < 44));
    assert.deepEqual(small, []);
    assert.equal(await page.isVisible('.atlas-topbar'), false, 'Atlas AI owns the phone top bar');
    await page.click('.ai-phonebar [data-ai-open-list]');
    await page.waitForSelector('.atlas-ai.is-list-open');
    assert.equal(await page.getAttribute('.ai-list', 'aria-modal'), 'true');
    for (let index = 0; index < 12; index += 1) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.activeElement.closest('.ai-list') !== null), 'focus stays in the history sheet');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.querySelector('.atlas-ai').classList.contains('is-list-open')), false);
    assert.ok(await page.evaluate(() => document.activeElement.matches('.ai-phonebar [data-ai-open-list]')), 'focus returns to History');
  } finally { await close(); }
});

test('accessibility: every control is labelled and streaming is announced', { skip }, async () => {
  const { page, close } = await openAi({ hash: `#ai/c/${IDS.convNegroni}` });
  try {
    await page.waitForSelector('.msg-ai');
    const unlabelled = await page.evaluate(() => [...document.querySelectorAll('#ai-view button, #ai-view a[href], #ai-view input, #ai-view textarea, #ai-view select')]
      .filter((node) => node.offsetParent !== null && node.type !== 'file')
      .filter((node) => {
        const label = node.getAttribute('aria-label') || node.textContent.trim() || (node.id && document.querySelector(`label[for="${node.id}"]`)?.textContent.trim()) || node.getAttribute('title');
        return !label;
      }).map((node) => node.outerHTML.slice(0, 80)));
    assert.deepEqual(unlabelled, []);
    assert.equal(await page.getAttribute('.ai-list', 'aria-label'), 'Conversations');
    assert.equal(await page.$$eval('#ai-view h1', (nodes) => nodes.filter((node) => !node.closest('[hidden]')).length), 1, 'one H1');
    assert.ok(await page.locator('#ai-view [aria-live="polite"]').count() > 0);
    assert.equal(await page.getAttribute('label[for="ai-composer-input"]', 'class'), 'sr-only');
    // Keyboard: Enter sends, Shift+Enter adds a line.
    await page.focus('#ai-composer-input');
    await page.keyboard.type('Line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Line two');
    assert.equal(await page.inputValue('#ai-composer-input'), 'Line one\nLine two');
  } finally { await close(); }
});
