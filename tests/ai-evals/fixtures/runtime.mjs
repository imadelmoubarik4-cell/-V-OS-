// The REAL atlas-ai runtime (supabase/functions/atlas-ai/handler.mjs) wired to
// the REAL Tool Gateway and the VÁ fixture world. Used by the Layer 1b
// runtime evals (scripted model, Deno) and by the Layer 2 live runner
// (real models, Node). Nothing is stubbed between the model and the data:
//   model ⇄ Agents SDK ⇄ atlas-ai (auth, SSE, guardrails, proposals,
//   approvals) ⇄ Tool Gateway ⇄ world.fetch (Auth, PostgREST + RLS, RPCs,
//   Edge Functions).
// Only the Atlas AI tables (conversations, messages, runs, tool calls,
// actions, media) are the in-memory store from the runtime test harness.

import { createAtlasAiHandler } from '../../../supabase/functions/atlas-ai/handler.mjs';
import * as gateway from '../../../supabase/functions/_shared/ai-tools/index.mjs';
import { createFakeDb } from '../../node/helpers/atlas-ai-harness.mjs';
import { ACTORS, ENV, NOW, createWorld, tokenFor } from './world.mjs';

export const RUNTIME_ENV = Object.freeze({
  ...ENV,
  OPENAI_API_KEY: 'sk-test-openai-key-never-returned-000000',
});

export function createWorldRuntime({ sdk, z, modelProvider, hours = false, env = {}, now = () => NOW } = {}) {
  const world = createWorld({ hours });
  const fake = createFakeDb({ users: ACTORS });
  const mergedEnv = { ...RUNTIME_ENV, ...env };
  const handle = createAtlasAiHandler({
    env: (name) => mergedEnv[name],
    fetchImpl: world.fetch,
    now,
    sdk,
    z,
    gateway,
    modelProvider,
    services: fake.services,
  });

  function request(action, { actor = 'manager', method = 'POST', body, query = '', signal } = {}) {
    const init = { method, headers: { authorization: `Bearer ${tokenFor(ACTORS[actor])}` }, signal };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    return new Request(`${ENV.SUPABASE_URL}/functions/v1/atlas-ai?action=${action}${query}`, init);
  }

  async function call(action, options = {}) {
    const response = await handle(request(action, options));
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  }

  async function chat(actor, body, { signal } = {}) {
    const response = await handle(request('chat', { actor, body, signal }));
    if (!/^text\/event-stream/.test(response.headers.get('content-type') ?? '')) {
      return { status: response.status, events: [], error: await response.json().catch(() => null) };
    }
    return { status: response.status, events: parseSse(await response.text()) };
  }

  return { handle, request, call, chat, world, db: fake.db, services: fake.services, gateway };
}

export function parseSse(text) {
  const events = [];
  for (const block of String(text).split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    if (event) events.push({ event, data: data ? JSON.parse(data) : null });
  }
  return events;
}

export function deltaText(events) {
  return events.filter((entry) => entry.event === 'delta').map((entry) => entry.data.text).join('');
}

// The <atlas_context> block the runtime puts in front of each turn.
export function atlasContext(request) {
  const text = JSON.stringify(request?.input ?? []);
  const match = text.match(/<atlas_context>(.*?)<\/atlas_context>/);
  if (!match) return null;
  try {
    return JSON.parse(JSON.parse(`"${match[1]}"`));
  } catch {
    return null;
  }
}

export function lastUserText(request) {
  const users = (Array.isArray(request?.input) ? request.input : []).filter((item) => item.role === 'user');
  const last = users.at(-1);
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : last.content.map((part) => part.text ?? '').join(' ');
}
