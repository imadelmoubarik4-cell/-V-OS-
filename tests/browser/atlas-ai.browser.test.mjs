// S88 Atlas AI (#ai): conversations, streamed answers with progress, evidence
// and records, approvals, attachments, voice notes, live voice, history,
// Decisions, deep links, phone layout and accessibility. Runs the shipped
// atlas-ai.js / atlas-ai-voice.js in Chromium against a mocked atlas-ai.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessAvailable, launchAtlas, settle, until, USERS } from './harness.mjs';
import { aiFixtures, IDS, fakeMediaInit, orderProposal, AI_FIXTURE_NOW } from './atlas-ai-fixtures.mjs';

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
    fixedTime: options.fixedTime ?? AI_FIXTURE_NOW,
    storage: { 'atlas.ai.voice.explained.v1': 'yes', ...(options.storage || {}) },
    initScript: options.initScript
  });
  try {
    await launched.page.waitForFunction(() => document.body.dataset.atlasView === 'ai' && document.querySelector('#ai-view [data-ai-composer]'));
    await settle(launched.page);
  } catch (error) {
    await launched.close();
    throw error;
  }
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
  const { page, close } = await launchAtlas({ fixtures, fixedTime: AI_FIXTURE_NOW, hash: `#ai/c/${IDS.convNegroni}` });
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
    await settle(page);
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
  const { page, close } = await launchAtlas({ fixtures, fixedTime: AI_FIXTURE_NOW, hash: '#ai/new' });
  try {
    await page.waitForSelector('#ai-composer-input');
    await settle(page);
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
    assert.deepEqual({ name: tool[0].body.name, call: tool[0].body.call_id, conversation: tool[0].body.conversation_id, session: tool[0].body.voice_session_id }, { name: 'stock_count_draft', call: 'call_1', conversation: IDS.convNegroni, session: IDS.voiceSession }, 'the Atlas voice session id, not the provider id');
    const sent = await page.evaluate(() => window.__dc.sent);
    assert.deepEqual(sent[0], { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: 'Tanqueray: 6 bottles counted. Prepared "Back bar count" as a proposal card on screen.' } });
    assert.deepEqual(sent[1], { type: 'response.create' });
    // The same call delivered twice runs once.
    await page.evaluate(() => window.__dc.serverEvent({ type: 'response.function_call_arguments.done', call_id: 'call_1', name: 'stock_count_draft', arguments: '{}' }));
    await settle(page);
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
    await until(() => calls(backend, 'voice-append').flatMap((entry) => entry.body.turns).length >= 2, { message: 'both voice turns appended' });
    await page.waitForFunction(() => document.querySelector('.composer') && getComputedStyle(document.querySelector('.composer')).display !== 'none');
    const appendCalls = calls(backend, 'voice-append');
    const appended = appendCalls.flatMap((entry) => entry.body.turns);
    assert.deepEqual(appended.map((turn) => [turn.role, turn.text]), [['user', 'Six bottles of Tanqueray and two Campari'], ['assistant', 'Got it, six Tanqueray.']]);
    assert.ok(appendCalls.every((entry) => entry.body.voice_session_id === IDS.voiceSession), 'every transcript append carries the voice session id');
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
    await page.waitForFunction(() => [...document.querySelectorAll('.ai-conv__t')].map((node) => node.textContent).join('|') === 'Cost of a Paloma');
    assert.deepEqual(await page.$$eval('.ai-conv__t', (nodes) => nodes.map((node) => node.textContent)), ['Cost of a Paloma']);
    await until(() => calls(backend, 'conversations').some((entry) => new URLSearchParams(entry.search).get('q') === 'paloma'), { message: 'the server search for paloma' });
    await settle(page);
    assert.deepEqual(await page.$$eval('.ai-conv__t', (nodes) => nodes.map((node) => node.textContent)), ['Cost of a Paloma']);
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval('.ai-conv', (nodes) => nodes.length), 4);

    await page.hover(`[data-ai-open-conv="${IDS.convPaloma}"]`);
    await page.click(`[data-ai-conv-menu="${IDS.convPaloma}"]`);
    await page.click('.atlas-menu__item:has-text("Rename")');
    await page.fill('.ai-dialog input', 'Paloma costing');
    await page.click('.ai-dialog button[type="submit"]');
    await page.waitForSelector('.ai-conv__t:has-text("Paloma costing")');
    assert.equal(calls(backend, 'rename').at(-1).body.title, 'Paloma costing');

    await page.click(`[data-ai-conv-menu="${IDS.convPaloma}"]`);
    await page.click('.atlas-menu__item:has-text("Pin")');
    await page.waitForFunction(() => [...document.querySelectorAll('.ai-list__group')][0].innerText.includes('Paloma costing'));
    assert.equal(calls(backend, 'pin').at(-1).body.pinned, true);

    const trigger = `[data-ai-conv-menu="${IDS.convPaloma}"]`;
    await page.click(trigger);
    await page.click('.atlas-menu__item:has-text("Delete")');
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
    await page.click('.atlas-menu__item:has-text("Delete")');
    await page.click('.ai-dialog [data-ai-confirm]');
    await page.waitForFunction((id) => !document.querySelector(`[data-ai-open-conv="${id}"]`), IDS.convPaloma);
    assert.equal(calls(backend, 'delete')[0].body.conversation_id, IDS.convPaloma);

    // Opening another conversation updates the route.
    await page.click(`[data-ai-open-conv="${IDS.convDelivery}"]`);
    await page.waitForFunction((id) => location.hash === `#ai/c/${id}`, IDS.convDelivery);
  } finally { await close(); }
});

test('deep links open a conversation and Decisions for managers', { skip }, async () => {
  const opened = await openAi({ hash: `#ai/c/${IDS.convNegroni}` });
  try {
    await opened.page.waitForSelector('.msg-ai');
    assert.equal(await opened.page.evaluate(() => document.body.dataset.atlasView), 'ai');
    assert.match(await opened.page.textContent('.ai-thread__title'), /Negroni tonight and Campari order/);
    assert.ok(calls(opened.backend, 'conversation').some((entry) => new URLSearchParams(entry.search).get('id') === IDS.convNegroni));
  } finally { await opened.close(); }

  const decisions = await openAi({ hash: '#ai/decisions' });
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
  const { page, close } = await launchAtlas({ fixtures, fixedTime: AI_FIXTURE_NOW, hash: '#ai/decisions' });
  try {
    await page.click('[data-ai-dec-open="r-1"]');
    await page.waitForSelector('.ai-sheet [data-ai-dec-form]');
    assert.match(await page.textContent('.ai-sheet'), /What was recommended[\s\S]*Negroni needs Campari\.[\s\S]*Campari on hand[\s\S]*bottles: 1/);
    await page.selectOption('.ai-sheet select[name="decision"]', 'accept');
    await page.fill('.ai-sheet textarea[name="notes"]', 'Ordered with Friday delivery');
    await page.click('.ai-sheet [data-ai-dec-form] button[type="submit"]');
    await page.waitForSelector('.ai-sheet', { state: 'detached' });
    const decision = posts.find((entry) => entry.action === 'decision');
    assert.ok(decision, 'a decision was posted');
    assert.deepEqual({ id: decision.body.recommendation_id, decision: decision.body.decision, notes: decision.body.notes }, { id: 'r-1', decision: 'accept', notes: 'Ordered with Friday delivery' });
  } finally { await close(); }
});

test('search questions and Ask Atlas actions open Atlas AI with the question', { skip }, async () => {
  const { fixtures, backend } = aiFixtures();
  const { page, close } = await launchAtlas({ fixtures, fixedTime: AI_FIXTURE_NOW });
  try {
    // The palette's Ask Atlas row (and ⌘/Ctrl+Enter) opens #ai/new?q=…&from=<page>.
    await page.click('#atlas-omni');
    await page.fill('#atlas-palette-input', 'Why are margins lower this month?');
    await page.waitForFunction(() => document.getElementById('atlas-palette-list')?.dataset.answerState !== 'pending' && document.querySelector('.atlas-palette__item--ask'));
    const options = await page.$$eval('.atlas-palette__item', (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, ' ').trim()));
    assert.ok(options.some((option) => /Ask Atlas “Why are margins lower this month\?”/.test(option)), JSON.stringify(options));
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.body.dataset.atlasView === 'ai');
    assert.match(await page.evaluate(() => location.hash), /^#ai(\/|$|\?)/);
    await page.waitForSelector('[data-ai-steps]');
    assert.equal(backend.state.calls.find((entry) => entry.action === 'chat').body.message, 'Why are margins lower this month?');
    // A direct #ai/new?q=… link from another page asks once.
    await page.evaluate(() => { location.hash = '#ai/new?q=Who%20works%20tomorrow%3F&from=inventory'; });
    await page.waitForFunction(() => document.querySelectorAll('.msg-user').length === 1 && /Who works tomorrow/.test(document.querySelector('.msg-user').innerText));
    await page.waitForSelector('[data-ai-steps]');
    assert.equal(backend.state.calls.filter((entry) => entry.action === 'chat').length, 2);
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
    // Atlas AI owns the phone top bar: History and New, no search or bell (spec §8.7).
    assert.ok(await page.evaluate(() => document.body.classList.contains('atlas-topbar-own')));
    assert.deepEqual(await page.$$eval('#atlas-topbar-actions [data-topbar-action]', (nodes) => nodes.map((node) => node.getAttribute('aria-label'))), ['Conversations', 'New conversation']);
    assert.equal(await page.isVisible('.atlas-tabbar'), false, 'the tab bar is hidden inside a conversation');
    await page.click('#atlas-topbar-actions [data-topbar-action="0"]');
    await page.waitForSelector('.atlas-ai.is-list-open');
    assert.equal(await page.getAttribute('.ai-list', 'aria-modal'), 'true');
    for (let index = 0; index < 12; index += 1) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.activeElement.closest('.ai-list') !== null), 'focus stays in the history sheet');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.querySelector('.atlas-ai').classList.contains('is-list-open')), false);
    assert.ok(await page.evaluate(() => document.activeElement.matches('#atlas-topbar-actions [data-topbar-action="0"]')), 'focus returns to History');
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

// ---------- hardened voice and upload contract (owner brief S88 §1–4, §7, §10) ----------

async function startLiveCall(page, context) {
  await context.route('https://api.openai.com/**', (route) => (route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } })
    : route.fulfill({ status: 201, contentType: 'application/sdp', headers: { 'access-control-allow-origin': '*' }, body: 'v=0 harness-answer' })));
  await page.click('[data-ai-live]');
  await page.waitForSelector('.voice[data-state="listening"]');
}

test('live voice ends its session with voice-end on End, after saving the transcript', { skip }, async () => {
  const { page, context, close, backend } = await openAi({ initScript: fakeMediaInit, hash: `#ai/c/${IDS.convNegroni}` });
  try {
    await startLiveCall(page, context);
    // No transcript: End sends voice-end with the Atlas voice session id.
    await page.click('[data-ai-live-end]');
    await page.waitForSelector('.voice', { state: 'detached' });
    await until(() => calls(backend, 'voice-end').length, { message: 'voice-end' });
    assert.deepEqual(calls(backend, 'voice-end').map((entry) => entry.body), [{ voice_session_id: IDS.voiceSession }]);
    assert.equal(backend.state.voiceActive, false);

    // With a pending transcript, the last append carries ended:true.
    await startLiveCall(page, context);
    await page.evaluate(() => window.__dc.serverEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u9', transcript: 'Two limes left' }));
    await page.click('[data-ai-live-end]');
    await until(() => !backend.state.voiceActive, { message: 'the voice session to end' });
    const appends = calls(backend, 'voice-append').map((entry) => entry.body);
    assert.ok(appends.every((body) => body.voice_session_id === IDS.voiceSession));
    assert.deepEqual(appends.flatMap((body) => body.turns.map((turn) => turn.text)), ['Two limes left']);
    // The session ends either with the final append (ended:true) or voice-end.
    assert.ok(appends.at(-1).ended === true || calls(backend, 'voice-end').length === 2);
    assert.equal(backend.state.voiceActive, false);
    assert.equal(calls(backend, 'voice-session').length, 2, 'each call starts its own session');
  } finally { await close(); }
});

test('leaving the page sends voice-end for the live session', { skip }, async () => {
  const { page, context, close, backend } = await openAi({ initScript: fakeMediaInit, hash: `#ai/c/${IDS.convNegroni}` });
  try {
    await startLiveCall(page, context);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await until(() => calls(backend, 'voice-end').length, { message: 'voice-end on pagehide' });
    assert.deepEqual(calls(backend, 'voice-end').map((entry) => entry.body), [{ voice_session_id: IDS.voiceSession }]);
  } finally { await close(); }
});

test('an inactive voice session stops tools and transcripts and offers a fresh session', { skip }, async () => {
  const { page, context, close, backend } = await openAi({
    initScript: fakeMediaInit,
    hash: `#ai/c/${IDS.convNegroni}`,
    backend: { overrides: { 'voice-tool': (_entry, state) => { state.voiceActive = false; return { __status: 409, body: { error_code: 'voice_session_inactive', message: 'raw server detail' } }; } } }
  });
  try {
    await startLiveCall(page, context);
    await page.evaluate(() => window.__dc.serverEvent({ type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', call_id: 'call_x', name: 'inventory_search', arguments: '{}' } }));
    await page.waitForSelector('.voice[data-state="inactive"]');
    const panel = await page.textContent('.voice');
    assert.match(panel, /Session ended[\s\S]*This live voice session has ended\. Start a new one to continue\.[\s\S]*Start a new session/);
    assert.doesNotMatch(panel, /raw server detail/);
    assert.equal(await page.evaluate(() => window.__dc.sent.length), 0, 'no tool output is sent for an inactive session');
    // Further events for that session do nothing: no tool call, no transcript append, no retry.
    await page.evaluate(() => {
      window.__dc.serverEvent({ type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', call_id: 'call_y', name: 'inventory_search', arguments: '{}' } });
      window.__dc.serverEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u5', transcript: 'Anything' });
    });
    await settle(page);
    assert.equal(calls(backend, 'voice-tool').length, 1);
    assert.equal(calls(backend, 'voice-append').length, 0);
    assert.equal(calls(backend, 'voice-session').length, 1, 'never silently retried');
    await page.click('[data-ai-live-end]');
    await page.waitForSelector('.voice', { state: 'detached' });
    assert.equal(calls(backend, 'voice-end').length, 0, 'an inactive session is not ended again');
    // A fresh session is a new voice-session call.
    await startLiveCall(page, context);
    assert.equal(calls(backend, 'voice-session').length, 2);
  } finally { await close(); }
});

test('voice limits show fixed, friendly copy for each reason', { skip }, async () => {
  const reasons = [['concurrent', /already open in another tab or device/, true], ['daily_minutes', /used today’s live voice time/, false], ['daily_sessions', /used today’s live voice sessions/, false]];
  for (const [reason, copy, retry] of reasons) {
    const { page, close, backend } = await openAi({
      initScript: fakeMediaInit,
      hash: `#ai/c/${IDS.convNegroni}`,
      backend: { overrides: { 'voice-session': () => ({ __status: 429, body: { error_code: 'voice_quota_exceeded', reason, message: 'raw quota text from the database' } }) } }
    });
    try {
      await page.click('[data-ai-live]');
      await page.waitForSelector('.voice[data-state="error"]');
      await page.waitForFunction(() => /Voice|voice|tab/.test(document.querySelector('.voice__error')?.textContent || ''));
      const text = await page.textContent('.voice');
      assert.match(text, copy, reason);
      assert.doesNotMatch(text, /raw quota text/);
      assert.equal(await page.locator('[data-ai-live-reconnect]').count(), retry ? 1 : 0, `${reason} retry offered: ${retry}`);
      assert.equal(calls(backend, 'voice-tool').length, 0);
    } finally { await close(); }
  }
  const { page, close } = await openAi({
    initScript: fakeMediaInit,
    hash: `#ai/c/${IDS.convNegroni}`,
    backend: { overrides: { 'voice-session': () => ({ __status: 429, body: { error_code: 'rate_limited', message: 'mint throttle' } }) } }
  });
  try {
    await page.click('[data-ai-live]');
    await page.waitForSelector('.voice[data-state="error"]');
    await page.waitForFunction(() => /Wait a minute/.test(document.querySelector('.voice__error')?.textContent || ''));
    assert.doesNotMatch(await page.textContent('.voice'), /mint throttle/);
  } finally { await close(); }
});

test('upload limits and sizes show fixed copy and nothing is sent', { skip }, async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const cases = [
    [{ error_code: 'upload_quota_exceeded', reason: 'daily_files' }, 429, /today’s limit of 100 files/],
    [{ error_code: 'upload_quota_exceeded', reason: 'daily_bytes' }, 429, /today’s upload size limit/],
    [{ error_code: 'too_large' }, 413, /larger than 25 MB/],
    [{ error_code: 'not_configured' }, 503, /need Atlas AI to be switched on/]
  ];
  for (const [payload, status, copy] of cases) {
    const { page, close, backend } = await openAi({ backend: { overrides: { upload: () => ({ __status: status, body: { ...payload, message: 'raw storage detail' } }) } } });
    try {
      await page.setInputFiles('[data-ai-file-any]', { name: 'note.png', mimeType: 'image/png', buffer: png });
      await page.waitForSelector('[data-ai-att].is-error');
      const text = await page.textContent('[data-ai-att]');
      assert.match(text, copy, payload.error_code);
      assert.doesNotMatch(text, /raw storage detail/);
      await page.fill('#ai-composer-input', 'What is this?');
      await page.keyboard.press('Enter');
      await settle(page);
      const chat = calls(backend, 'chat')[0];
      assert.ok(!chat || !chat.body.attachments, 'a failed upload is never attached');
    } finally { await close(); }
  }
});

test('photos over 20 MB together are stopped before sending; a 413 from the server is explained', { skip }, async () => {
  const { page, close, backend } = await openAi({ backend: { overrides: { chat: () => ({ __status: 413, body: { error_code: 'attachments_too_large', message: 'Attachments in one message can be up to 20 MB in total.' } }) } } });
  try {
    // Two 11 MB PNGs are built inside the page and handed to the real file
    // input. Pushing 22 MB through page.setInputFiles crossed the automation
    // protocol and could exceed its timeout on a loaded runner (the flake).
    await page.evaluate(() => {
      const input = document.querySelector('[data-ai-file-any]');
      const png = (name) => {
        const bytes = new Uint8Array(11 * 1024 * 1024).fill(1);
        bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
        return new File([bytes], name, { type: 'image/png' });
      };
      const transfer = new DataTransfer();
      transfer.items.add(png('a.png'));
      transfer.items.add(png('b.png'));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-ai-att] .file-chip__meta').length === 2, null, { timeout: 20000 });
    await page.fill('#ai-composer-input', 'Do these match?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.atlas-toast');
    assert.match(await page.textContent('.atlas-toast'), /up to 20 MB together/);
    assert.equal(calls(backend, 'chat').length, 0, 'not sent');
    // The server's own limit (for example media counted differently) is explained the same way.
    await page.click('[data-ai-remove-att]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg-ai .atlas-alert');
    assert.match(await page.textContent('.msg-ai .atlas-alert'), /Atlas couldn’t finish this answer\. Nothing was changed\.[\s\S]*up to 20 MB together/);
  } finally { await close(); }
});

test('an answer the server replaced for lack of evidence is shown as sent, with Try again', { skip }, async () => {
  const safe = 'I can’t confirm that figure from Atlas records, so I won’t guess. Try again, or check Inventory.';
  const { page, close } = await openAi({ initScript: manualStreamInit });
  try {
    await typeAndSend(page, 'How many Negronis did we sell?');
    await page.waitForFunction(() => window.__chat?.push);
    await page.evaluate((text) => {
      window.__chat.push('progress', { label: 'Checking sales data' });
      window.__chat.push('delta', { text: 'You sold 4' });
      window.__chat.push('done', { message_id: 'm-g', conversation_id: 'x', content: text, grounding: 'replaced_unverified' });
      window.__chat.end();
    }, safe);
    await page.waitForSelector('.msg-ai [data-ai-retry]');
    assert.equal((await page.textContent('.msg-ai [data-ai-text]')).trim(), safe);
    assert.doesNotMatch(await page.textContent('.msg-ai'), /You sold 4/, 'streamed text is replaced, never completed client-side');
    assert.equal(await page.locator('.msg-ai [data-ai-text] strong').count(), 0);
  } finally { await close(); }
});

test('phone: the empty state keeps the tab bar with the composer above it', { skip }, async () => {
  const { page, close } = await openAi({ viewport: { width: 390, height: 844 }, contextOptions: { hasTouch: true, isMobile: true } });
  try {
    assert.ok(await page.isVisible('.atlas-tabbar'));
    const gap = await page.evaluate(() => document.querySelector('.atlas-tabbar').getBoundingClientRect().top - document.querySelector('.composer').getBoundingClientRect().bottom);
    assert.ok(gap >= 0, `composer overlaps the tab bar by ${-gap}px`);
    await typeAndSend(page, 'What is low before tonight?');
    await page.waitForSelector('[data-ai-steps]');
    assert.equal(await page.isVisible('.atlas-tabbar'), false);
    // Leaving Atlas AI gives the tab bar back.
    await page.evaluate(() => { location.hash = '#home'; });
    await page.waitForFunction(() => document.body.dataset.atlasView === 'dashboard');
    assert.ok(await page.isVisible('.atlas-tabbar'));
  } finally { await close(); }
});
