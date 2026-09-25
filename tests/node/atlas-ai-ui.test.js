// S88 Atlas AI frontend source contract: no secrets in the browser bundle, no
// internal tool names or engineering words in the interface, the spec routes
// and canonical actions are registered through AtlasShell, and the pure
// helpers (SSE parsing, progress wording, answer formatting) behave.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../../', import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, ROOT), 'utf8');
const ai = read('apps/web/assets/js/atlas-ai.js');
const voice = read('apps/web/assets/js/atlas-ai-voice.js');
const css = read('apps/web/assets/css/atlas-ai.css');
const index = read('apps/web/index.html');
const config = read('apps/web/config.js');
const netlify = read('netlify.toml');

// Quoted and template string contents of a source file (what can reach the DOM).
function stringLiterals(source) {
  const out = [];
  const pattern = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  for (const match of source.replace(/^\s*\/\/.*$/gm, '').matchAll(pattern)) out.push(match[0].slice(1, -1));
  return out;
}

test('the browser bundle carries no provider keys or client secrets', () => {
  for (const [name, source] of [['atlas-ai.js', ai], ['atlas-ai-voice.js', voice], ['config.js', config]]) {
    assert.doesNotMatch(source, /\bsk-[A-Za-z0-9_-]{8,}/, `${name} contains an API key`);
    assert.doesNotMatch(source, /\bek_[A-Za-z0-9]{6,}/, `${name} contains a client secret`);
    assert.doesNotMatch(source, /OPENAI_API_KEY|ATLAS_AI_SERVICE_SECRET|service_role/i, `${name} references a server secret`);
  }
  // The client secret is read from the response, used for one SDP exchange and dropped.
  assert.match(voice, /secret = null;/);
  assert.doesNotMatch(voice, /localStorage|sessionStorage|indexedDB/, 'live voice never stores the secret');
  assert.match(voice, /'https:\/\/api\.openai\.com\/v1\/realtime\/calls'/);
  assert.match(voice, /createDataChannel\('oai-events'\)/);
});

test('config and CSP wire Atlas AI to production only', () => {
  assert.match(config, /ATLAS_AI_API: "https:\/\/dnefgcmjcgxlynycxkts\.supabase\.co\/functions\/v1\/atlas-ai"/);
  assert.match(netlify, /connect-src [^;]*https:\/\/api\.openai\.com;/);
  assert.match(netlify, /media-src 'self' blob:/);
  assert.match(netlify, /microphone=\(self\)/);
});

test('no internal tool names reach the interface', async () => {
  const { TOOL_REGISTRY } = await import(new URL('supabase/functions/_shared/ai-tools/registry.mjs', ROOT));
  const literals = [...stringLiterals(ai), ...stringLiterals(voice)].join('\n');
  for (const tool of TOOL_REGISTRY) {
    assert.ok(!literals.includes(tool.fnName), `${tool.fnName} appears in the Atlas AI frontend`);
    assert.ok(!literals.includes(tool.name), `${tool.name} appears in the Atlas AI frontend`);
  }
});

test('interface copy avoids engineering words (spec §5.9, §7.2)', () => {
  // Text between tags in template markup, plus toast/announce/friendly strings.
  const markupText = ai.split('\n').filter((line) => /[`'][^`']*<[a-z]/.test(line))
    .flatMap((line) => [...line.replace(/\$\{[^}]*\}/g, ' ').matchAll(/>([^<>{}();=]{3,})</g)].map((match) => match[1]));
  assert.ok(markupText.length > 40, 'markup copy was extracted');
  const spoken = [...ai.matchAll(/(?:toast|announce)\((['`])([^'`]+)\1/g)].map((match) => match[2]);
  const copy = [...markupText, ...spoken].join('\n');
  for (const word of ['agent', 'tool', 'function', 'JSON', 'payload', 'RPC', 'token', 'schema', 'model', 'runtime', 'Unknown', 'Submit']) {
    assert.doesNotMatch(copy, new RegExp(`\\b${word}\\b`, 'i'), `"${word}" in Atlas AI copy`);
  }
  assert.match(ai, /Atlas AI isn’t switched on yet/);
  assert.match(ai, /Atlas prepares changes for you to approve\. It never changes stock, orders or shifts on its own\./);
  assert.match(ai, /Atlas couldn’t finish this answer\. Nothing was changed\./);
  assert.match(ai, /Live voice disconnected\. Your conversation is saved\./);
  assert.match(ai, /No decisions recorded yet/);
});

test('Atlas AI registers through AtlasShell with the spec routes and actions', () => {
  assert.match(ai, /shell\.registerView\('ai',/);
  assert.doesNotMatch(ai, /registerView\('atlas'/, 'only the spec routes (#ai…)');
  for (const id of ['ai.ask', 'ai.ask.record', 'ai.voice']) assert.match(ai, new RegExp(`id: '${id.replace('.', '\\.')}'`));
  assert.match(ai, /shell\.links\?\.register\?\.\('ai'/);
  assert.match(ai, /home\.contribute\('ai'/);
  // Evidence kinds labelled per spec.
  for (const label of ['Verified', 'Calculated', 'Interpretation', 'Estimate', 'Missing']) assert.match(ai, new RegExp(`'${label}'`));
  // Approval goes through execute-action / reject-action only.
  assert.match(ai, /request\('execute-action', \{ method: 'POST', body: \{ action_id: id \} \}\)/);
  assert.match(ai, /request\('reject-action'/);
  // Stop generation aborts the fetch.
  assert.match(ai, /new AbortController\(\)/);
  assert.match(ai, /controller\.abort\(\)/);
});

test('index loads the Atlas AI view root, style and scripts with the S88 cache key', () => {
  assert.match(index, /<div id="ai-view" style="display:none;"><\/div>/);
  assert.match(index, /<link rel="stylesheet" href="assets\/css\/atlas-ai\.css\?v=20260929-s90u">/);
  assert.ok(index.indexOf('assets/js/atlas-ai-voice.js?v=20260926-s88') > index.indexOf('assets/js/atlas-search.js?v=20260929-s90u'));
  assert.ok(index.indexOf('assets/js/atlas-ai.js?v=20260929-s90u') > index.indexOf('assets/js/atlas-ai-voice.js?v=20260926-s88'));
});

test('stylesheet defines no global tokens and honours reduced motion', () => {
  assert.doesNotMatch(css, /:root\s*\{/);
  assert.match(css.replace(/\/\*[\s\S]*?\*\//g, '').trim(), /^@layer atlas\.modules \{[\s\S]*\}$/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /!important/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /var\(--accent, #1f6fdb\)/);
  assert.doesNotMatch(css, /backdrop-filter|linear-gradient\(1|radial-gradient/);
});

function loadHelpers() {
  const context = { console, URL, TextDecoder, setTimeout, clearTimeout };
  context.window = context;
  context.document = { readyState: 'loading', addEventListener() {}, documentElement: { classList: { contains: () => false } } };
  vm.createContext(context);
  vm.runInContext(ai, context);
  return context.AtlasAI;
}

test('SSE parsing handles split chunks, comments and CRLF', () => {
  const api = loadHelpers();
  const first = api.splitEvents(': keep-alive\n\nevent: progress\ndata: {"label":"Checking stock"}\n\nevent: delta\r\ndata: {"text":"Yes, ');
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].event, 'progress');
  assert.equal(first.events[0].data.label, 'Checking stock');
  const second = api.splitEvents(`${first.rest}but"}\r\n\r\nevent: done\ndata: {"content":"Yes, but"}\n\n`);
  assert.deepEqual(JSON.parse(JSON.stringify(second.events.map((event) => event.event))), ['delta', 'done']);
  assert.equal(second.events[0].data.text, 'Yes, but');
  assert.equal(second.rest, '');
});

test('progress wording is human and past tense when done', () => {
  const api = loadHelpers();
  assert.equal(api.stepsSummary([{ label: 'Checking stock' }, { label: 'Looking through recipes' }, { label: 'Preparing a draft order' }]),
    'Checked stock, looked through recipes and prepared a draft order');
  assert.equal(api.humanText('inventory_lookup_stock', 'Checking Atlas'), 'Checking Atlas');
  assert.equal(api.humanText('{"qty":1}', ''), '');
  assert.equal(api.humanText('Campari: 1 bottle', ''), 'Campari: 1 bottle');
});

test('answers are escaped and lightly formatted', () => {
  const api = loadHelpers();
  const html = api.formatAnswer('Yes, but only about 30. You have <b>one</b> bottle.\n\n- Campari\n- Aperol', { emphasiseFirst: true });
  assert.match(html, /^<p><strong>Yes, but only about 30\.<\/strong> You have &lt;b&gt;one&lt;\/b&gt; bottle\.<\/p><ul><li>Campari<\/li><li>Aperol<\/li><\/ul>$/);
  // S90: bold that runs past the first full stop is not sliced into garbled HTML.
  const across = api.formatAnswer('Campari is **out. Negroni** can’t be served tonight.', { emphasiseFirst: true });
  assert.equal(across, '<p>Campari is <strong>out. Negroni</strong> can’t be served tonight.</p>');
  const inside = api.formatAnswer('You have **2** bottles. Order more.', { emphasiseFirst: true });
  assert.equal(inside, '<p><strong>You have <strong>2</strong> bottles.</strong> Order more.</p>');
  assert.equal(api.recordRoute({ type: 'inventory_item', id: 'abc' }), '#inventory/item/abc');
  assert.equal(api.recordRoute({ type: 'purchase_order', id: 'po 1' }), '#purchasing/order/po%201');
  assert.equal(api.recordRoute({ type: 'unknown_type', route: '#reports/stock' }), '#reports/stock');
});
