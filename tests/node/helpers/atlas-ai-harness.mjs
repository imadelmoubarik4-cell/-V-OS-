// Test harness for the atlas-ai runtime: an in-memory stand-in for the S88
// Atlas AI RPCs and the private bucket, a fake Auth/OpenAI fetch, a scripted
// model implementing the Agents SDK Model interface, and SSE parsing.

import { createAtlasAiHandler } from '../../../supabase/functions/atlas-ai/handler.mjs';
import { mapRpcError } from '../../../supabase/functions/atlas-ai/http.mjs';
import * as gateway from './atlas-ai-tools-stub.mjs';

export const USERS = {
  manager: { id: '00000000-0000-4000-8000-0000000000a1', role: 'manager', active: true, display_name: 'Maria Manager', email: 'm@example.invalid' },
  bartender: { id: '00000000-0000-4000-8000-0000000000b2', role: 'bartender', active: true, display_name: 'Bjarni Bar', email: 'b@example.invalid' },
  viewer: { id: '00000000-0000-4000-8000-0000000000c3', role: 'viewer', active: true, display_name: 'Vala Viewer', email: 'v@example.invalid' },
  gone: { id: '00000000-0000-4000-8000-0000000000d4', role: 'bartender', active: false, display_name: 'Former', email: 'f@example.invalid' },
};

export const ENV = {
  ATLAS_AUTH_PROJECT_URL: 'https://auth.example.test',
  ATLAS_AUTH_PUBLISHABLE_KEY: 'sb_publishable_testkeyvalue',
  SUPABASE_URL: 'https://branch.example.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  OPENAI_API_KEY: 'sk-test-openai-key-never-returned-000000',
  ATLAS_AI_SERVICE_SECRET: 'service-secret-0123456789abcdef0123456789',
  ATLAS_AI_BACKGROUND_ACTOR_ID: USERS.manager.id,
};

let counter = 0;
export function uuid() {
  counter += 1;
  return `10000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

class RpcFailure extends Error {
  constructor(code, message) {
    super(message);
    this.dbCode = code;
  }
}

const fail = (code, message) => { throw new RpcFailure(code, message); };

// In-memory implementation of the Atlas AI RPC contract (ai-data-contract.md)
// with the owner, role, single-use and expiry rules the gateway relies on.
export function createFakeDb({ users = USERS } = {}) {
  const db = {
    settings: {
      enabled: true, media_retention_days: 30, audio_retention: 'delete_after_transcription', daily_turn_limit_per_user: 200,
      voice_sessions_per_day: 20, voice_minutes_per_day: 60, max_concurrent_voice_sessions: 1,
      upload_bytes_per_day: 262144000, upload_files_per_day: 100,
    },
    voiceSessions: new Map(),
    voiceEvents: [],
    rateEvents: [],
    conversations: new Map(),
    messages: [],
    runs: new Map(),
    toolCalls: [],
    actions: new Map(),
    media: new Map(),
    objects: new Map(),
    removed: [],
    decisions: [],
    proposalsRecorded: [],
    signals: new Map(),
    calls: [],
    preferences: new Map(),
  };
  const profiles = Object.fromEntries(Object.values(users).map((user) => [user.id, user]));
  const requireActor = (id, role) => {
    const profile = profiles[id];
    if (!profile || !profile.active || profile.role !== role) fail('42501', 'forbidden: inactive or role mismatch');
  };
  const owned = (conversationId, actorId) => {
    const conversation = db.conversations.get(conversationId);
    if (!conversation || conversation.user_id !== actorId) fail('P0002', 'not_found: conversation');
    return conversation;
  };
  const conversationJson = (row) => ({ ...row });
  const actionJson = (row) => {
    const { command, ...rest } = row;
    return { ...rest, status: row.status === 'proposed' && Date.parse(row.expires_at) <= Date.now() ? 'expired' : row.status };
  };

  // Mirrors the S88 hardening SQL (20260926106000_s88_ai_hardening.sql) and
  // the S91 voice lease and takeover (20260930092000).
  const turnsUsed = (userId) => [...db.runs.values()].filter((run) => run.user_id === userId && !['voice_tool', 'background'].includes(run.channel)).length;
  const rateTake = (userId, bucket, limit) => {
    const now = Date.now();
    const used = db.rateEvents.filter((event) => event.user_id === userId && event.bucket === bucket && now - event.at < 60000).length;
    if (used >= limit) return false;
    db.rateEvents.push({ user_id: userId, bucket, at: now });
    return true;
  };
  const liveVoice = (row) => !row.ended_at && Date.now() < Math.min(row.lease_expires_at, row.hard_expires_at);
  const voiceUsage = (userId) => {
    const rows = [...db.voiceSessions.values()].filter((row) => row.user_id === userId && row.end_reason !== 'mint_failed');
    const minutes = rows.reduce((sum, row) => sum + ((row.ended_at ?? Math.min(Date.now(), row.lease_expires_at, row.hard_expires_at)) - row.started_at) / 60000, 0);
    return { sessions_used: rows.length, live_sessions: rows.filter(liveVoice).length, minutes_used_estimate: Math.ceil(minutes) };
  };
  const voiceJson = (row) => ({
    voice_session_id: row.id, conversation_id: row.conversation_id, run_id: row.run_id, provider_session_id: row.provider_session_id,
    started_at: new Date(row.started_at).toISOString(), lease_expires_at: new Date(row.lease_expires_at).toISOString(),
    hard_expires_at: new Date(row.hard_expires_at).toISOString(), ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    end_reason: row.end_reason, replaced: row.end_reason === 'replaced', live: liveVoice(row), tool_calls: row.tool_calls,
    appended_turns: row.appended_turns, heartbeats: row.heartbeats ?? 0, lease_seconds: row.lease_seconds ?? 120,
  });
  const renew = (row) => { row.lease_expires_at = Math.max(row.lease_expires_at, Math.min(row.hard_expires_at, Date.now() + (row.lease_seconds ?? 120) * 1000)); };

  const rpcs = {
    atlas_ai_rate_check: ({ p_actor_id, p_actor_role }) => {
      requireActor(p_actor_id, p_actor_role);
      const used = turnsUsed(p_actor_id);
      const limit = db.settings.daily_turn_limit_per_user;
      return { enabled: db.settings.enabled, allowed: db.settings.enabled && used < limit, used, limit, remaining: Math.max(0, limit - used), window_hours: 24, resets_at: null };
    },
    atlas_ai_preferences_get: ({ p_actor_id, p_actor_role }) => {
      requireActor(p_actor_id, p_actor_role);
      return db.preferences.get(p_actor_id) ?? { reply_length: 'normal', speak_answers: false, voice_enabled: true, language: 'auto', stored: false };
    },
    atlas_ai_preferences_set: ({ p_actor_id, p_actor_role, p_patch }) => {
      requireActor(p_actor_id, p_actor_role);
      const next = { ...(db.preferences.get(p_actor_id) ?? { reply_length: 'normal', speak_answers: false, voice_enabled: true, language: 'auto' }), ...p_patch, stored: true };
      db.preferences.set(p_actor_id, next);
      return next;
    },
    atlas_ai_settings_get: ({ p_actor_id, p_actor_role }) => {
      requireActor(p_actor_id, p_actor_role);
      return { ...db.settings, can_edit: ['admin', 'manager'].includes(p_actor_role) };
    },
    atlas_ai_settings_set: ({ p_actor_id, p_actor_role, p_patch }) => {
      requireActor(p_actor_id, p_actor_role);
      if (!['admin', 'manager'].includes(p_actor_role)) fail('42501', 'forbidden: managers only');
      Object.assign(db.settings, p_patch);
      return { ...db.settings, can_edit: true };
    },
    atlas_ai_conversations_list: ({ p_actor_id, p_actor_role, p_query }) => {
      requireActor(p_actor_id, p_actor_role);
      const rows = [...db.conversations.values()].filter((row) => row.user_id === p_actor_id && (!p_query || row.title.includes(p_query)));
      return { conversations: rows.map(conversationJson), total: rows.length, has_more: false, query: p_query, limit: 30, offset: 0 };
    },
    atlas_ai_conversation_create: ({ p_actor_id, p_actor_role, p_title, p_context }) => {
      requireActor(p_actor_id, p_actor_role);
      const row = { id: uuid(), user_id: p_actor_id, title: p_title ?? 'New conversation', pinned: false, archived: false, context: p_context ?? {}, created_at: new Date().toISOString() };
      db.conversations.set(row.id, row);
      return conversationJson(row);
    },
    atlas_ai_conversation_get: ({ p_conversation_id, p_actor_id, p_actor_role, p_limit }) => {
      requireActor(p_actor_id, p_actor_role);
      const conversation = owned(p_conversation_id, p_actor_id);
      const messages = db.messages.filter((message) => message.conversation_id === conversation.id).slice(-(p_limit ?? 50));
      return { conversation: conversationJson(conversation), messages: messages.map((message) => ({ ...message })), has_more: false, next_before_id: null, actions: [...db.actions.values()].filter((action) => action.conversation_id === conversation.id).map(actionJson) };
    },
    atlas_ai_conversation_rename: ({ p_conversation_id, p_actor_id, p_actor_role, p_title }) => {
      requireActor(p_actor_id, p_actor_role);
      const row = owned(p_conversation_id, p_actor_id);
      row.title = p_title;
      return conversationJson(row);
    },
    atlas_ai_conversation_pin: ({ p_conversation_id, p_actor_id, p_actor_role, p_pinned }) => {
      requireActor(p_actor_id, p_actor_role);
      const row = owned(p_conversation_id, p_actor_id);
      row.pinned = p_pinned;
      return conversationJson(row);
    },
    atlas_ai_conversation_archive: ({ p_conversation_id, p_actor_id, p_actor_role, p_archived }) => {
      requireActor(p_actor_id, p_actor_role);
      const row = owned(p_conversation_id, p_actor_id);
      row.archived = p_archived;
      return conversationJson(row);
    },
    atlas_ai_conversation_delete: ({ p_conversation_id, p_actor_id, p_actor_role }) => {
      requireActor(p_actor_id, p_actor_role);
      owned(p_conversation_id, p_actor_id);
      const marked = [...db.media.values()].filter((media) => media.conversation_id === p_conversation_id && !media.deleted_at);
      for (const media of marked) media.expires_at = new Date(Date.now() - 1).toISOString();
      db.conversations.delete(p_conversation_id);
      db.messages = db.messages.filter((message) => message.conversation_id !== p_conversation_id);
      return { deleted: true, conversation_id: p_conversation_id, media_marked_for_purge: marked.map((media) => ({ id: media.id, bucket: media.bucket, path: media.path })) };
    },
    atlas_ai_conversation_context_merge: ({ p_conversation_id, p_actor_id, p_actor_role, p_patch }) => {
      requireActor(p_actor_id, p_actor_role);
      const row = owned(p_conversation_id, p_actor_id);
      for (const [key, value] of Object.entries(p_patch)) {
        if (value === null) delete row.context[key];
        else row.context[key] = value;
      }
      return { conversation_id: row.id, context: row.context };
    },
    atlas_ai_messages_append: ({ p_conversation_id, p_actor_id, p_actor_role, p_messages }) => {
      requireActor(p_actor_id, p_actor_role);
      const conversation = owned(p_conversation_id, p_actor_id);
      const out = [];
      for (const message of p_messages) {
        if (!['user', 'assistant', 'tool', 'system_note'].includes(message.role)) fail('22023', 'invalid_arguments: role');
        const existing = message.client_request_id && db.messages.find((row) => row.conversation_id === conversation.id && row.client_request_id === message.client_request_id);
        if (existing) {
          out.push({ id: existing.id, client_request_id: existing.client_request_id, created: false });
          continue;
        }
        const row = {
          id: uuid(), conversation_id: conversation.id, role: message.role, content: message.content ?? '', items: message.items ?? [],
          source: message.source ?? 'text', attachments: message.attachments ?? [], evidence: message.evidence ?? [], records: message.records ?? [],
          proposals: message.proposals ?? [], metadata: message.metadata ?? {}, run_id: message.run_id ?? null,
          status: message.status ?? 'complete', client_request_id: message.client_request_id ?? null, created_at: new Date().toISOString(),
        };
        db.messages.push(row);
        if (conversation.title === 'New conversation' && row.role === 'user') conversation.title = row.content.slice(0, 80);
        out.push({ id: row.id, client_request_id: row.client_request_id, created: true });
      }
      return { conversation_id: conversation.id, title: conversation.title, messages: out };
    },
    atlas_ai_message_update: ({ p_message_id, p_actor_id, p_actor_role, p_patch }) => {
      requireActor(p_actor_id, p_actor_role);
      const row = db.messages.find((message) => message.id === p_message_id);
      if (!row || db.conversations.get(row.conversation_id)?.user_id !== p_actor_id) fail('P0002', 'not_found: message');
      for (const [key, value] of Object.entries(p_patch)) row[key] = key === 'metadata' ? { ...row.metadata, ...value } : value;
      return { ...row };
    },
    atlas_ai_run_start: ({ p_actor_id, p_actor_role, p_conversation_id, p_channel, p_models }) => {
      requireActor(p_actor_id, p_actor_role);
      if (p_conversation_id) owned(p_conversation_id, p_actor_id);
      if (p_channel !== 'background') {
        if (!db.settings.enabled) fail('55000', 'not_configured: Atlas AI is disabled');
        if (p_channel !== 'voice_tool' && turnsUsed(p_actor_id) >= db.settings.daily_turn_limit_per_user) fail('53400', 'rate_limited: daily Atlas AI limit reached');
      }
      const run = { id: uuid(), user_id: p_actor_id, role: p_actor_role, conversation_id: p_conversation_id, channel: p_channel, models: p_models, status: 'running' };
      db.runs.set(run.id, run);
      return { run_id: run.id, status: 'running' };
    },
    // Mirrors 20260930092000_s91_voice_lease_and_takeover.sql: a short
    // renewable lease and a same-user takeover that is rolled back when a
    // quota refuses the new session.
    atlas_ai_voice_session_start: ({ p_actor_id, p_actor_role, p_conversation_id, p_models, p_mints_per_minute, p_takeover = false, p_lease_seconds = 600 }) => {
      requireActor(p_actor_id, p_actor_role);
      if (p_conversation_id) owned(p_conversation_id, p_actor_id);
      if (!db.settings.enabled) fail('55000', 'not_configured: Atlas AI is disabled');
      if (!rateTake(p_actor_id, 'voice_mint', p_mints_per_minute ?? 6)) fail('53400', 'rate_limited: too many voice sessions started this minute');
      if (turnsUsed(p_actor_id) >= db.settings.daily_turn_limit_per_user) fail('53400', 'rate_limited: daily Atlas AI limit reached');
      const now = Date.now();
      const replaced = p_takeover === true
        ? [...db.voiceSessions.values()].filter((row) => row.user_id === p_actor_id && liveVoice(row))
        : [];
      const saved = replaced.map((row) => ({ row, ended_at: row.ended_at, end_reason: row.end_reason }));
      for (const row of replaced) Object.assign(row, { ended_at: Math.max(row.started_at, now), end_reason: 'replaced' });
      const usage = voiceUsage(p_actor_id);
      const refuse = usage.sessions_used >= db.settings.voice_sessions_per_day ? 'daily_sessions'
        : usage.live_sessions >= db.settings.max_concurrent_voice_sessions ? 'concurrent'
          : usage.minutes_used_estimate >= db.settings.voice_minutes_per_day ? 'daily_minutes' : null;
      if (refuse) {
        for (const entry of saved) Object.assign(entry.row, { ended_at: entry.ended_at, end_reason: entry.end_reason });
        fail('53400', `voice_quota_exceeded: ${refuse}`);
      }
      const run = { id: uuid(), user_id: p_actor_id, role: p_actor_role, conversation_id: p_conversation_id, channel: 'voice', models: p_models, status: 'running' };
      db.runs.set(run.id, run);
      const lease = Math.min(600, Math.max(30, Number(p_lease_seconds) || 600));
      const row = { id: uuid(), user_id: p_actor_id, conversation_id: p_conversation_id, run_id: run.id, provider_session_id: null, started_at: now, lease_seconds: lease, lease_expires_at: now + lease * 1000, hard_expires_at: now + 3600000, ended_at: null, end_reason: null, replaced_by: null, tool_calls: 0, appended_turns: 0, heartbeats: 0 };
      db.voiceSessions.set(row.id, row);
      for (const old of replaced) {
        old.replaced_by = row.id;
        db.voiceEvents.push({ voice_session_id: old.id, user_id: p_actor_id, actor_role: p_actor_role, event: 'replaced', replaced_by: row.id });
      }
      return { ...voiceJson(row), replaced_sessions: replaced.length };
    },
    atlas_ai_voice_session_touch: ({ p_voice_session_id, p_actor_id, p_actor_role, p_event, p_provider_session_id }) => {
      requireActor(p_actor_id, p_actor_role);
      const key = String(p_voice_session_id ?? '').trim();
      if (!key) fail('55000', 'voice_session_inactive: a live voice session is required');
      const row = [...db.voiceSessions.values()].filter((entry) => entry.user_id === p_actor_id && (entry.id === key || entry.provider_session_id === key)).sort((a, b) => b.started_at - a.started_at)[0];
      if (!row) fail('55000', 'voice_session_inactive: unknown voice session');
      const live = liveVoice(row);
      const end = row.ended_at ?? Math.min(row.lease_expires_at, row.hard_expires_at);
      if (!['activate', 'heartbeat', 'tool', 'append', 'end', 'mint_failed'].includes(p_event)) fail('22023', 'invalid_arguments: event');
      if (p_event === 'end' || p_event === 'mint_failed') {
        if (!row.ended_at) Object.assign(row, { ended_at: Math.max(row.started_at, Math.min(Date.now(), row.lease_expires_at, row.hard_expires_at)), end_reason: p_event === 'mint_failed' ? 'mint_failed' : 'client_end' });
        return voiceJson(row);
      }
      if (row.end_reason === 'replaced' && (p_event !== 'append' || Date.now() > row.ended_at + 300000)) fail('55000', 'voice_session_replaced: live voice moved to another device');
      if (p_event === 'append') {
        if (!live && Date.now() > end + 300000) fail('55000', 'voice_session_inactive: the voice session has ended');
        if (!rateTake(p_actor_id, 'voice_append', 30)) fail('53400', 'rate_limited: too many voice transcript updates this minute');
        row.appended_turns += 1;
        if (live) renew(row);
        return voiceJson(row);
      }
      if (!live) fail('55000', 'voice_session_inactive: the voice session has ended');
      if (p_event === 'tool') {
        if (!rateTake(p_actor_id, 'voice_tool', 30)) fail('53400', 'rate_limited: too many voice tool calls this minute');
        row.tool_calls += 1;
        renew(row);
      } else if (p_event === 'heartbeat') {
        if (row.last_heartbeat_at && Date.now() - row.last_heartbeat_at < 15000) fail('53400', 'rate_limited: too many voice heartbeats');
        row.heartbeats = (row.heartbeats ?? 0) + 1;
        row.last_heartbeat_at = Date.now();
        row.lease_seconds = Math.min(row.lease_seconds ?? 600, 120);
        row.lease_expires_at = Math.min(row.hard_expires_at, Date.now() + row.lease_seconds * 1000);
      } else if (p_event === 'activate') {
        row.provider_session_id = row.provider_session_id ?? p_provider_session_id ?? null;
      }
      return voiceJson(row);
    },
    atlas_ai_run_finish: ({ p_run_id, p_actor_id, p_actor_role, ...rest }) => {
      requireActor(p_actor_id, p_actor_role);
      const run = db.runs.get(p_run_id);
      if (!run || run.user_id !== p_actor_id) fail('P0002', 'not_found: run');
      Object.assign(run, { status: rest.p_status, tokens_in: rest.p_tokens_in, tokens_out: rest.p_tokens_out, est_cost_usd: rest.p_est_cost_usd, tool_calls: rest.p_tool_calls, error_code: rest.p_error_code, finished: true });
      return { run_id: run.id, status: run.status };
    },
    atlas_ai_tool_call_record: (payload) => {
      requireActor(payload.p_actor_id, payload.p_actor_role);
      db.toolCalls.push(payload);
      return { id: uuid(), run_id: payload.p_run_id };
    },
    atlas_ai_action_create: (payload) => {
      requireActor(payload.p_actor_id, payload.p_actor_role);
      if (payload.p_conversation_id) owned(payload.p_conversation_id, payload.p_actor_id);
      if (!payload.p_command || !Object.keys(payload.p_command).length) fail('22023', 'invalid_arguments: command');
      const row = {
        id: uuid(), conversation_id: payload.p_conversation_id, message_id: payload.p_message_id, user_id: payload.p_actor_id,
        role_at_proposal: payload.p_actor_role, kind: payload.p_kind, title: payload.p_title, preview: payload.p_preview,
        command: payload.p_command, required_roles: payload.p_required_roles, status: 'proposed',
        expires_at: new Date(Date.now() + 86400000).toISOString(), decided_by: null, brain_recommendation_id: null,
      };
      db.actions.set(row.id, row);
      return actionJson(row);
    },
    atlas_ai_record_proposal: (payload) => {
      requireActor(payload.p_actor_id, payload.p_actor_role);
      const row = db.actions.get(payload.p_action_id);
      if (!row || row.user_id !== payload.p_actor_id) fail('P0002', 'not_found: action');
      row.brain_recommendation_id = row.brain_recommendation_id ?? uuid();
      db.proposalsRecorded.push(payload);
      return { action_id: row.id, brain_recommendation_id: row.brain_recommendation_id, created: true };
    },
    atlas_ai_action_transition: ({ p_action_id, p_to_status, p_actor_id, p_actor_role, p_result, p_error }) => {
      requireActor(p_actor_id, p_actor_role);
      const row = db.actions.get(p_action_id);
      const manager = ['admin', 'manager'].includes(p_actor_role);
      if (!row || !(row.user_id === p_actor_id || manager)) fail('P0002', 'not_found: action');
      const previous = row.status;
      if (p_to_status === 'executing') {
        if (row.status !== 'proposed') fail('55000', `conflict: proposal is already ${row.status}`);
        if (Date.parse(row.expires_at) <= Date.now()) fail('55000', 'conflict: proposal expired');
        if (!(row.required_roles.includes(p_actor_role) || p_actor_role === 'admin')) fail('42501', 'forbidden: role');
        Object.assign(row, { status: 'executing', decided_by: p_actor_id, decided_by_role: p_actor_role });
        return { action: actionJson(row), command: row.command, previous_status: previous };
      }
      if (p_to_status === 'executed' || p_to_status === 'failed') {
        if (row.status !== 'executing') fail('55000', 'conflict: not executing');
        if (row.decided_by !== p_actor_id) fail('42501', 'forbidden: only approver');
        Object.assign(row, { status: p_to_status, result: p_result, error: p_to_status === 'failed' ? (p_error ?? 'Execution failed') : null });
        return { action: actionJson(row), command: null, previous_status: previous };
      }
      if (p_to_status === 'rejected') {
        if (row.status !== 'proposed') fail('55000', `conflict: proposal is already ${row.status}`);
        Object.assign(row, { status: 'rejected', decided_by: p_actor_id, error: p_error });
        return { action: actionJson(row), command: null, previous_status: previous };
      }
      return fail('22023', 'invalid_arguments: status');
    },
    atlas_ai_record_decision: ({ p_action_id, p_decision, p_actor_id, p_actor_role, p_notes }) => {
      requireActor(p_actor_id, p_actor_role);
      const row = db.actions.get(p_action_id);
      if (!row) fail('P0002', 'not_found: action');
      if (!row.brain_recommendation_id) fail('55000', 'conflict: not recorded');
      if (row.decided_by !== p_actor_id) fail('55000', 'conflict: decision mismatch');
      db.decisions.push({ action_id: p_action_id, decision: p_decision, actor: p_actor_id, notes: p_notes });
      return { action_id: p_action_id, decision: p_decision };
    },
    atlas_ai_actions_expire: () => ({ expired: 0, action_ids: [] }),
    atlas_ai_media_register: (payload) => {
      requireActor(payload.p_actor_id, payload.p_actor_role);
      const prefix = `${payload.p_actor_id}/${payload.p_conversation_id ?? 'unsorted'}/`;
      if (!payload.p_path.startsWith(prefix)) fail('22023', 'invalid_arguments: path');
      const today = [...db.media.values()].filter((row) => row.user_id === payload.p_actor_id);
      if (today.length + 1 > db.settings.upload_files_per_day) fail('53400', 'upload_quota_exceeded: daily_files');
      if (today.reduce((sum, row) => sum + row.bytes, 0) + payload.p_bytes > db.settings.upload_bytes_per_day) fail('53400', 'upload_quota_exceeded: daily_bytes');
      const row = { id: uuid(), user_id: payload.p_actor_id, conversation_id: payload.p_conversation_id, bucket: 'atlas-ai-media', path: payload.p_path, mime: payload.p_mime, bytes: payload.p_bytes, kind: payload.p_kind, sha256: payload.p_sha256, expires_at: null, deleted_at: null };
      db.media.set(row.id, row);
      return { ...row };
    },
    atlas_ai_media_get: ({ p_media_id, p_actor_id, p_actor_role }) => {
      requireActor(p_actor_id, p_actor_role);
      const row = db.media.get(p_media_id);
      if (!row || row.user_id !== p_actor_id || row.deleted_at) fail('P0002', 'not_found: media');
      return { ...row };
    },
    atlas_ai_media_purge_expired: () => {
      const media = [...db.media.values()].filter((row) => !row.deleted_at && row.expires_at && Date.parse(row.expires_at) <= Date.now());
      return { media: media.map((row) => ({ id: row.id, bucket: row.bucket, path: row.path, kind: row.kind })), count: media.length };
    },
    atlas_ai_media_purge_confirm: ({ p_media_ids }) => {
      let confirmed = 0;
      for (const id of p_media_ids) {
        const row = db.media.get(id);
        if (row && !row.deleted_at && row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
          row.deleted_at = new Date().toISOString();
          confirmed += 1;
        }
      }
      return { confirmed };
    },
    atlas_ai_signals_upsert: ({ p_actor_id, p_actor_role, p_signals }) => {
      requireActor(p_actor_id, p_actor_role);
      if (!['admin', 'manager'].includes(p_actor_role)) fail('42501', 'forbidden: manager only');
      let created = 0;
      let refreshed = 0;
      for (const signal of p_signals) {
        const previous = db.signals.get(signal.key);
        if (previous && previous.fingerprint === signal.fingerprint) refreshed += 1;
        else created += 1;
        db.signals.set(signal.key, signal);
      }
      return { count: p_signals.length, created, refreshed, recommendation_ids: [] };
    },
  };

  const errors = {
    '42501': { status: 403 }, P0002: { status: 404 }, 22023: { status: 400 }, 55000: { status: 409 },
  };

  const services = {
    async rpc(name, payload) {
      db.calls.push({ name, payload });
      const fn = rpcs[name];
      if (!fn) throw Object.assign(new Error(`unknown rpc ${name}`), { status: 500 });
      try {
        return structuredClone(fn(structuredClone(payload ?? {})));
      } catch (error) {
        if (error instanceof RpcFailure) throw mapRpcError(name, error.dbCode, error.message);
        throw error;
      }
    },
    async uploadObject(path, bytes, mime) { db.objects.set(path, { bytes, mime }); },
    async downloadObject(path) {
      const object = db.objects.get(path);
      if (!object) throw new Error('missing object');
      return object.bytes;
    },
    async signObject(path, expiresIn) { return `https://branch.example.test/storage/v1/object/sign/atlas-ai-media/${path}?token=t&expires=${expiresIn}`; },
    async removeObjects(paths) {
      for (const path of paths) { db.objects.delete(path); db.removed.push(path); }
      return { removed: paths.length };
    },
    async profileById(id) { return Object.values(users).find((user) => user.id === id) ?? null; },
    async restAsUser(_actor, table) {
      if (table === 'inventory_catalog') return [{ name: 'Tanqueray' }, { name: 'Campari' }];
      if (table === 'suppliers') return [{ name: 'Globus' }];
      if (table === 'profiles') return [{ display_name: 'Bjarni Bar' }];
      return [];
    },
  };
  void errors;
  return { db, services };
}

// Fake fetch for Auth (token → profile) and OpenAI endpoints.
export function createFakeFetch({ openai = {} } = {}) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.startsWith(`${ENV.ATLAS_AUTH_PROJECT_URL}/auth/v1/user`)) {
      const token = String(init.headers?.authorization ?? '').replace(/^Bearer /, '');
      const user = Object.values(USERS).find((entry) => `token-${entry.role}-${entry.active ? 'on' : 'off'}` === token);
      if (!user) return new Response('{}', { status: 401 });
      return Response.json({ id: user.id, email: user.email });
    }
    if (url.startsWith(`${ENV.ATLAS_AUTH_PROJECT_URL}/rest/v1/profiles`)) {
      const id = new URL(url).searchParams.get('id').replace('eq.', '');
      const user = Object.values(USERS).find((entry) => entry.id === id);
      return Response.json(user ? [user] : []);
    }
    if (url === 'https://api.openai.com/v1/realtime/client_secrets') {
      return openai.clientSecret
        ? openai.clientSecret(init)
        : Response.json({ value: 'ek_test_ephemeral_value_1234567890', expires_at: 1790000060, session: { id: 'sess_123', type: 'realtime' } });
    }
    if (url === 'https://api.openai.com/v1/audio/transcriptions') {
      return openai.transcribe ? openai.transcribe(init) : Response.json({ text: 'I just counted six bottles of Tanqueray', usage: { type: 'duration', seconds: 4.2 } });
    }
    if (url === 'https://api.openai.com/v1/audio/speech') {
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, requests };
}

// A scripted model implementing the Agents SDK Model interface. `respond`
// receives (request, callIndex) and returns an array of output items.
export class ScriptedModel {
  constructor(name, respond, log) {
    this.name = name;
    this.respond = respond;
    this.log = log;
  }

  async #output(request) {
    const index = this.log.length;
    this.log.push({ model: this.name, request });
    return await this.respond(request, index, this.name);
  }

  async getResponse(request) {
    if (request.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const output = await this.#output(request);
    return { usage: new this.Usage({ requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 }), output, responseId: `resp_${this.log.length}` };
  }

  async *getStreamedResponse(request) {
    const output = await this.#output(request);
    yield { type: 'response_started' };
    for (const item of output) {
      if (item.type !== 'message') continue;
      for (const part of item.content) {
        const words = String(part.text).split(/(?<= )/);
        for (const word of words) {
          if (request.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          if (this.hooks?.onDelta) await this.hooks.onDelta(word);
          yield { type: 'output_text_delta', delta: word };
        }
      }
    }
    yield { type: 'response_done', response: { id: `resp_${this.log.length}`, usage: { requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 }, output } };
  }
}

export function message(text) {
  return [{ type: 'message', role: 'assistant', status: 'completed', id: `msg_${Math.random().toString(16).slice(2)}`, content: [{ type: 'output_text', text }] }];
}

export function toolCall(name, args, callId = `call_${Math.random().toString(16).slice(2, 10)}`) {
  return [{ type: 'function_call', name, callId, id: callId, status: 'completed', arguments: JSON.stringify(args) }];
}

// Did this request already receive a tool output (i.e. is this the follow-up turn)?
export function hasToolOutput(request) {
  return Array.isArray(request.input) && request.input.some((item) => item.type === 'function_call_result');
}

export function createProvider(sdk, respond) {
  const log = [];
  const models = [];
  const hooks = {};
  const provider = {
    getModel(name) {
      const model = new ScriptedModel(name, respond, log);
      model.Usage = sdk.Usage;
      model.hooks = hooks;
      models.push(model);
      return model;
    },
  };
  return { provider, log, models, hooks };
}

export function createHandler({ sdk, z, respond, env = {}, services, fetchOptions } = {}) {
  gateway.reset();
  const fake = services ? { services } : createFakeDb();
  const fetch = createFakeFetch(fetchOptions);
  const providerBundle = sdk?.Usage ? createProvider(sdk, respond ?? (() => message('Hello.'))) : { provider: null, log: [], models: [], hooks: {} };
  const handle = createAtlasAiHandler({
    env: (name) => ({ ...ENV, ...env })[name],
    fetchImpl: fetch.fetchImpl,
    now: () => Date.now(),
    sdk,
    z,
    gateway,
    modelProvider: () => providerBundle.provider,
    services: fake.services,
  });
  return { handle, db: fake.db, services: fake.services, fetch, gateway, modelLog: providerBundle.log, models: providerBundle.models, hooks: providerBundle.hooks };
}

// Starts a live voice session through the handler (voice-tool and
// voice-append require one) and returns the voice-session response body.
export async function startVoice(handle, user, conversationId) {
  const response = await handle(request('voice-session', { user, body: conversationId ? { conversation_id: conversationId } : {} }));
  const body = await response.json();
  if (response.status !== 200) throw new Error(`voice-session failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

export function token(user) {
  return `token-${user.role}-${user.active ? 'on' : 'off'}`;
}

export function request(action, { user = USERS.manager, method = 'POST', body, query = '', headers = {}, signal } = {}) {
  const init = { method, headers: { authorization: `Bearer ${token(user)}`, ...headers }, signal };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return new Request(`https://branch.example.test/functions/v1/atlas-ai?action=${action}${query}`, init);
}

export async function readSse(response) {
  const text = await response.text();
  const events = [];
  for (const block of text.split('\n\n')) {
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
