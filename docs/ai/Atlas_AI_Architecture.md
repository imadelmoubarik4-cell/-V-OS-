# Atlas AI — Architecture

Status: S88 design, implemented on the remediation branch. Not deployed.
Companion documents: `docs/ai/Atlas_AI_Tool_Registry.md` (every callable tool) and
`docs/ai/Atlas_AI_Evaluation_Plan.md` (how Atlas AI is measured before release).

Atlas is the operating system; Atlas AI is the conversational way to operate it.
The user talks to one assistant, **Atlas**. Atlas answers from the same canonical
services as every Atlas screen — there is no separate "AI truth".

---

## 1. Principles

1. **One assistant, one truth.** Stock, recipe readiness, order suggestions, costs,
   identity and permissions come from the canonical modules in
   `supabase/functions/_shared/` (parity-tested against the browser rules). The
   model never calculates stock or readiness itself.
2. **The model is not the permission boundary.** Every tool runs server-side with
   the verified profile of the signed-in user. Role checks happen in the tool
   gateway and again in the database (RLS / RPC role checks).
3. **Read → Draft → Execute.** Reads return role-permitted data. Drafts create a
   reviewable proposal and change nothing. Execution happens only when a person
   approves a specific proposal in the UI; the server then runs the normal Atlas
   command with the user's own authority and writes an audit event.
4. **Evidence or silence.** Operational answers carry evidence classified as
   *verified fact*, *deterministic calculation*, *interpretation*, *estimate* or
   *missing evidence*. When evidence is missing Atlas says so.
5. **Documents are data.** Text found in uploads, supplier documents, Knowledge
   articles or integration payloads is never treated as an instruction.
6. **No secrets in the browser.** The OpenAI key lives only in Edge Function
   secrets. Live voice uses short-lived client secrets minted per call.
7. **Structured screens stay.** Inventory, Recipes, Purchasing, Reports, Shifts,
   Team, Knowledge and Settings remain the professional workspaces; Atlas AI links
   into them and launches their canonical actions.

---

## 2. System overview

```
Browser (apps/web)
  atlas-ai.js ──────────── conversation workspace, composer, approvals, evidence
  atlas-ai-voice.js ────── voice notes (MediaRecorder) + live voice (WebRTC)
        │  HTTPS + user JWT (SSE for streaming)             │ WebRTC audio + data channel
        ▼                                                    ▼
Supabase Edge Function  atlas-ai                       OpenAI Realtime (ephemeral ek_ secret)
  ├─ auth (_shared/auth.mjs) → verified actor {userId, role, active, displayName}
  ├─ conversations API (list/search/create/rename/pin/archive/delete/messages)
  ├─ chat  → Agents SDK run(Atlas orchestrator, stream) → SSE to browser
  ├─ actions (approve / reject / execute) → canonical Atlas commands
  ├─ media  (upload / signed read) → private bucket atlas-ai-media
  ├─ transcribe (voice notes) → OpenAI transcription
  ├─ voice-session → mints Realtime client secret with server-built config
  ├─ voice-tool → executes a Realtime tool call through the same gateway
  └─ speak (optional read-aloud) → OpenAI speech
        │
        ▼
Tool Gateway (_shared registry, one per tool: level, roles, schema, execute)
        │  user JWT (RLS)  /  service RPC with verified actor (role re-checked)
        ▼
Postgres: canonical tables, atlas_* RPCs, atlas_private.ai_* (conversations,
messages, runs, tool calls, actions, media, preferences), brain_* decision memory
```

---

## 3. Orchestrator and specialist agents

- **Atlas (orchestrator)** owns every conversation and every final answer. It
  plans, calls specialists as tools (`agent.asTool()` — the "manager" pattern),
  reconciles their findings and replies once. Specialists never talk to the
  user directly, so there are no conflicting answers.
- **Specialists** (each a small agent with a focused prompt and only its own tools):

| Specialist | Owns | Tools (registry names) |
| --- | --- | --- |
| Inventory | stock, counts, par, barcodes | `inventory.*` |
| Recipes & Menu | readiness, blockers, cost, menu | `recipes.*` |
| Purchasing | suggestions, suppliers, draft POs, receiving | `purchasing.*` |
| Operations | routines, checklists, alerts, readiness | `operations.*`, `briefing.today` |
| Reports & Finance | inventory value, margin, spend, waste; sales = not connected | `reports.*` |
| Shifts | schedule, who is working, draft shifts | `shifts.*` |
| Team | profiles (role-shaped), message drafts | `team.*` |
| Knowledge | procedures, manuals, acknowledgements | `knowledge.*` |
| Marketing | calendar, seeded suggestions, drafts | `marketing.*` |
| Data Quality | review queues, missing data, par suggestions | `data_quality.*` |
| Integration | provider status and requirements (truthful) | `integrations.status` |

- Simple single-domain questions may be answered by the orchestrator calling a
  read tool directly (cheaper, faster); multi-domain work ("Prepare Friday") goes
  through several specialists and one reconciled briefing.
- Specialists are **invisible** by default. The UI shows friendly progress
  ("Checking stock…", "Looking at the rota…"), never agent or function names.

### Model strategy

Models are configuration, not code: `ATLAS_AI_MODEL_ORCHESTRATOR`,
`ATLAS_AI_MODEL_SPECIALIST`, `ATLAS_AI_MODEL_VISION`, `ATLAS_AI_MODEL_TRANSCRIBE`,
`ATLAS_AI_MODEL_REALTIME`, `ATLAS_AI_MODEL_SPEECH`, `ATLAS_AI_VOICE`. Defaults
live in `supabase/functions/atlas-ai/config.mjs` and follow the current
OpenAI recommendations at build time (a stronger reasoning model for the
orchestrator and vision, an efficient model for specialists, the current
transcription, realtime and speech models, voice `marin`). Switching models is
an environment change followed by the evaluation suite (§14).

---

## 4. Tool Gateway

One registry (`supabase/functions/_shared/ai-tools/registry.mjs`) is the only way
the model touches Atlas. Each entry:

```js
{
  name: 'inventory.current_stock',        // registry name; function name = inventory_current_stock
  level: 'read' | 'draft' | 'execute',
  roles: ['admin','manager','bartender','viewer'],
  specialist: 'inventory',
  description: '…',                        // model-facing
  progress: 'Checking stock',              // user-facing progress label
  parameters: zodSchema,                    // strict; optional fields are nullable
  execute: async (args, ctx) => ToolResult
}
```

`ctx` is built by the server from the verified actor: `{actor, userJwt, services,
now, venue}`. Tool arguments can never change who the actor is.

**ToolResult** (every tool):

```json
{
  "ok": true,
  "summary": "Short model-facing summary",
  "data": { },
  "evidence": [
    { "kind": "fact|calculation|interpretation|estimate|missing",
      "label": "Current reconciled stock", "value": "10 bottles",
      "source": { "type": "inventory_item", "id": "…", "label": "Angelo Pinot Grigio",
                  "route": "#inventory?item=…" } }
  ],
  "records": [ { "type": "recipe", "id": "…", "label": "Margarita", "route": "#recipes?recipe=…" } ],
  "proposal": null,
  "unknown": { "count": 234, "reason": "No par level set" }
}
```

Failures return `{ok:false, error:{code, message}}` — `forbidden`, `not_found`,
`invalid_arguments`, `not_connected`, `unavailable`. The model is instructed to
report failures plainly and never to invent a result.

Gateway enforcement, in order: tool exists → actor active → actor role in
`roles` → zod validation → per-tool limits (row caps, spend caps) → execute with
user JWT (RLS) or service RPC passing the verified actor → output redaction for
the role (cost/supplier stripped for bartender/viewer exactly as
`atlas-reports reportSources()` does) → audit row in `ai_tool_calls`.

Canonical sources are listed per tool in the Tool Registry. Highlights:
stock via `_shared` stock projection over `atlas_stock_count_verified_balances()`
and movements; recipe readiness via `_shared` `recipeStatus/recipeBlockers`;
order suggestions via `_shared` `orderSuggestions` with open purchase orders as
input; shifts via `atlas_shifts_snapshot`; Knowledge via the new
`atlas_knowledge_search` (full-text over visible versions only).

---

## 5. Permissions: Read → Draft → Execute

| Level | What the model can do | What actually changes |
| --- | --- | --- |
| Read | call role-permitted read tools | nothing |
| Draft | call a draft tool, which stores an **action proposal** (`ai_actions`, status `proposed`) with a human-readable preview and the exact command payload | nothing operational; a proposal row |
| Execute | nothing — the model cannot execute | when the user presses **Approve** on the proposal card, the browser calls `atlas-ai?action=execute-action` with the proposal id; the server re-loads the stored payload (never the client's), re-checks the actor's role for that command, runs the canonical Atlas command with the user's own JWT, stores the result and writes an audit event |

Proposal kinds (initial): draft purchase order, stock-count draft (counted
quantities saved into a new count session for verification — never a direct
stock adjustment), shift draft (unpublished), team message (sent only on
approval), Knowledge draft (saved as draft, never published), recipe draft,
manager briefing, marketing draft, suggested settings change (opens Settings;
Atlas never writes settings), par suggestion (opens the par editor).

Rules: proposals expire (24 h default); each is single-use (atomic
`proposed → executing → executed|failed`); only the proposing user or a
manager may approve; approvals are recorded in `brain_decisions` through the
Brain memory (§8); a bartender cannot approve a manager-only command even if
Atlas prepared it. Voice cannot approve by speech alone — approvals are taps on
the card (transcripts are approximate).

---

## 6. Conversations

- Tables (service-role only, owner-scoped): `atlas_private.ai_conversations`
  (id, user_id, title, pinned, archived, context jsonb, created/updated,
  last_message_at), `ai_messages` (id, conversation_id, role user|assistant|tool,
  content text, items jsonb for SDK history, attachments, evidence, records,
  proposals, status, created_at), full-text search over titles and message text.
- API (all through `atlas-ai`): `conversations` (list, search, pinned first),
  `conversation` (messages), `create`, `rename`, `pin`, `archive`, `delete`.
- The Agents SDK uses a custom `Session` backed by `ai_messages.items`, trimmed to
  a token budget (recent turns verbatim + a rolling summary).
- **Structured task context** (`ai_conversations.context`): the last referenced
  records, the active date focus, active filters (e.g. category "wine"), the
  last proposal. Follow-ups such as "What about tomorrow?", "Only wines",
  "Prepare that", "Why?", "Change it to three cases" resolve against it.
- **Page context**: the browser sends `{view, entity:{type,id,label}}` when the
  user opens Atlas from a record (inventory item, recipe, purchase order,
  report). It is explicit — Atlas never guesses what the user is looking at.
- Streaming: `POST atlas-ai?action=chat` returns `text/event-stream` with events
  `progress`, `delta`, `evidence`, `records`, `proposal`, `done`, `error`. Stop
  generation aborts the request (server run is cancelled via AbortSignal).
  Regenerate re-runs the last user message.

---

## 7. Multimodal input and media

- Composer supports images (camera or file), screenshots, PDFs and text
  documents (CSV/TXT; spreadsheets are summarised via the existing import
  parser where supported).
- Upload: `atlas-ai?action=upload` (multipart) → validated type and size →
  private bucket **`atlas-ai-media`** at `user_id/conversation_id/uuid.ext` →
  `ai_media` row. The bucket has no browser policies; access is only through the
  function (profile-photo pattern) with short-lived signed URLs.
- Upload limits (S88 hardening F2, F4, F8): uploads follow the Atlas AI switch
  (`503 not_configured` while disabled; they do not count as turns). Per user
  and rolling 24 hours, `atlas_ai_media_register` enforces
  `ai_settings.upload_files_per_day` (default 100) and `upload_bytes_per_day`
  (default 250 MB) atomically under a per-user lock; deleted media still counts.
  Over quota: `429 upload_quota_exceeded` with `reason` `daily_files` or
  `daily_bytes`, and the stored object is removed. A multipart body over 26 MB is
  refused from `content-length` before it is read and a streamed body is cut
  off at the limit (`413 too_large`). Every allowed type is sniffed by magic
  bytes: JPEG, PNG, WebP, HEIC/HEIF (a HEIF brand in the `ftyp` box, never an
  MP4/MOV brand), PDF, UTF-8 text/CSV, WebM (EBML), Ogg, WAV (RIFF/WAVE), MP3
  (ID3 or frame sync) and MP4 audio (an MP4 brand, no HEIF brand); voice notes
  sent to `transcribe` are sniffed too.
- Per turn, the images and PDFs sent to the model are capped at 20 MB in total
  (`413 attachments_too_large`), because they are base64-inlined.
- Model input: images as `input_image`, PDFs as `input_file` (base64 from
  storage, read server-side). Content extracted from documents is wrapped as
  untrusted data.
- Example: from a purchase order the user photographs a delivery and asks
  "Does this match our order?" → page context supplies the PO id; the Purchasing
  specialist reads the PO lines, the vision input yields observed items, Atlas
  explains matches and discrepancies and may prepare a **receiving proposal**
  — stock only changes after approval through the canonical receiving command.
- Product recognition (S89): `inventory.identify_from_image` runs the visual
  inventory pipeline (`_shared/recognition/*`, the same code as the
  `atlas-inventory-recognition` function) in process on an attached photo: a
  strict-schema vision reading (never shown the catalogue), then deterministic
  retrieval and scoring through the `atlas_recognition_*` RPCs only (NOLOGIN
  recognition definer, no stock writes). Results carry a band (High only for
  an exact barcode or code, still confirmed by a person; Medium = options with
  evidence; Low = no confident match), field-by-field confidence and the §7
  evidence sentences. `inventory.resolve_name` is the canonical name resolver
  (aliases, Icelandic/English spellings, sizes such as "70cl") that
  `inventory.prepare_count`, `purchasing.prepare_draft_po` and
  `purchasing.compare_delivery` use. `inventory.propose_alias`,
  `inventory.propose_item` (duplicate check first) and
  `inventory.report_wrong_match` are drafts: approving the card creates a
  pending catalogue request (source `ai_proposal`, linked to the action); a
  manager decides it in the approval queue, and that decision is written to
  the Brain through `atlas_catalog_record_ai_decision`. Vision reads follow the
  Atlas AI switch and the recognition limits in `ai_settings`
  (`recognition_identifications_per_hour`, `recognition_vision_per_day`,
  `recognition_vision_budget_usd_per_day`).
- Retention: voice-note audio deleted after successful transcription;
  photos/documents kept 30 days (configurable in `ai_settings`), then purged by
  `atlas_ai_purge_expired_media()`; transcripts and messages follow conversation
  retention (kept until the user deletes the conversation).

---

## 8. Memory

| Memory | Where | Notes |
| --- | --- | --- |
| Conversation memory | `ai_messages` + `ai_conversations.context` | per user; never shared |
| User preferences | `ai_user_preferences` (reply length, speak answers, voice on/off, language) | non-sensitive only |
| Business knowledge | canonical Atlas tables + Knowledge | never hidden in model memory |
| Decision memory | existing Brain tables (`brain_recommendations`, `_evidence`, `brain_decisions`, `brain_outcomes`) | AI proposals are recorded as shadow recommendations (`generated_by = 'atlas-ai'`) with evidence; approve/reject is written as a decision; `decisions.history` lets Atlas say "Last time you deferred this because a delivery was expected" |

There is no separate AI memory store and no second Brain. Decision memory stays
manager-only, matching the Brain today. Privacy (S88 hardening F12): a team
message proposal is recorded in Brain with its channel, recipients and effects
only; the drafted text and text-bearing evidence stay in the proposer's
conversation and the stored action, and are not copied to Brain.

---

## 9. Voice notes

`record (MediaRecorder, webm/opus or mp4)` → `atlas-ai?action=transcribe`
(multipart, ≤ 25 MB, ≤ 10 min) → OpenAI transcription with Atlas vocabulary
(item, supplier and staff names as keywords; English and Icelandic) → the
transcript is stored as the user message (with `source: voice_note` and audio
duration) → processed exactly like typed text. "I just counted six bottles of
Tanqueray and two Campari" → Inventory specialist resolves items → a stock-count
draft proposal is shown for approval. The transcript is always visible and
editable before sending.

---

## 10. Live voice

- **Credential**: `atlas-ai?action=voice-session` verifies the user, builds the
  session config server-side (instructions, voice, turn detection, transcription,
  the role-filtered tool list) and mints a Realtime client secret that expires in
  60 seconds. The browser receives only the `ek_…` value.
- **Transport**: WebRTC directly from the browser to OpenAI (`/v1/realtime/calls`,
  SDP offer/answer, `oai-events` data channel). CSP `connect-src` adds
  `https://api.openai.com`.
- **Tools**: the data channel delivers function calls to the browser; the
  browser forwards each to `atlas-ai?action=voice-tool` with the user JWT and the
  voice session id. The server executes it through the same Tool Gateway (same
  roles, same redaction, same audit) and returns the output, which the browser
  sends back (`conversation.item.create` + `response.create`). A modified browser
  can only call tools the user may already call.
- **Delegation**: the voice agent has an `ask_atlas` tool that runs the full text
  orchestrator (specialists) server-side for multi-step questions and returns a
  concise answer.
- **Behaviour**: semantic turn detection with barge-in (interruption), live
  user and assistant transcript, mute, stop. States shown: connecting,
  listening, thinking, speaking, muted, interrupted, disconnected/error.
- **Continuity**: transcripts are appended to the same conversation
  (`atlas-ai?action=voice-append`), so a conversation can move between text and
  voice. Proposals created by voice appear as approval cards in the conversation.
- **Voice identity**: one voice (`marin` by default) for live voice and
  read-aloud; instructions: calm, warm, professional, concise, hospitality
  manager tone; answers short unless asked for detail.
- A server-controlled sideband session would be a stronger boundary but needs a
  process that lives for the whole call, which Supabase Edge Functions cannot
  hold. The chosen design keeps the authority server-side at the tool gateway.
- **Metering (S88 hardening F1, F11).** Every `voice-session` call reserves a
  voice session atomically in the database before the provider is called
  (`atlas_ai_voice_session_start`, per-user advisory lock), in this order:
  Atlas AI enabled; a durable mint throttle (6 per user per minute, shared by
  every isolate); the daily turn limit (a mint is one turn); the daily session
  cap `ai_settings.voice_sessions_per_day` (default 20); the concurrency cap
  `max_concurrent_voice_sessions` (default 1); and the estimated daily minutes
  budget `voice_minutes_per_day` (default 60). Refusals are
  `429 rate_limited` or `429 voice_quota_exceeded` with `reason`
  `daily_sessions`, `concurrent` or `daily_minutes`. A failed mint releases its
  reservation. The response adds `voice_session_id` (and
  `voice_session_expires_at`) next to the provider `session_id`.
- **Live session required.** `voice-tool` and `voice-append` must send
  `voice_session_id` (the Atlas id, or the provider `session_id` from the same
  response) of a live session owned by the caller and bound to the same
  conversation; otherwise `409 voice_session_inactive`. A session is live until
  it is ended (`POST ?action=voice-end {voice_session_id}`, or `voice-append`
  with `"ended": true`), until 10 minutes pass without a tool call or
  transcript append, or 60 minutes after it started (the provider's maximum).
  Transcript appends are still accepted for 5 minutes after the end (final
  flush). Tool calls and transcript appends are each limited to 30 per user per
  minute (`429 rate_limited`), durably in the database. `voice-tool`
  re-resolves the actor from the JWT and re-checks the role on every call.
- **Server-side session bounds.** The session config sent with the client
  secret sets `max_output_tokens` 1024 per response, `truncation`
  `{type: "retention_ratio", retention_ratio: 0.8, token_limits:
  {post_instructions: 16000}}` (bounds the input tokens each turn carries),
  `parallel_tool_calls: false`, and a 60-second secret TTL
  (`expires_after`). The TTL only limits how long the secret can *start* a
  session; the Realtime API has no session-length field, and `idle_timeout_ms`
  exists only for `server_vad` (Atlas uses `semantic_vad`).
- **Residual risk (documented, accepted).** The browser owns the WebRTC call
  and its `oai-events` data channel, so a modified client can send
  `session.update` to replace instructions, tools and output limits, keep a
  call open up to the provider's 60-minute limit, and use the venue key as a
  general voice assistant during that call. None of the text-channel guardrails
  (input screen, grounding check, output redaction of spoken audio) apply to
  what the model says in audio. What still holds: tools only run through
  `voice-tool`, which re-authorizes every call with the JWT and role; one
  minted secret per reservation; the daily session, concurrency and minutes
  caps bound how many calls a user can open; and the minutes budget is an
  *estimate* (start to end, or to the end of the idle lease when a session is
  never ended), not a measurement of audio. The server cannot force-close an
  established Realtime call: deactivating or demoting a user stops their tool
  calls and new mints immediately, but an open call continues until the
  browser closes it or the provider's limit is reached. A server-controlled
  sideband connection (or the provider's call hangup endpoint driven by a
  long-lived worker) would close this gap and is the recommended next step if
  voice cost or misuse becomes material.

---

## 11. Knowledge and documents (RAG)

- `public.atlas_knowledge_search(p_query, p_actor_id, p_actor_role, p_limit)`:
  full-text search (`simple` configuration; English/Icelandic mix) over the
  **visible** version for the actor (published only for staff; drafts only for
  managers), returning snippets and article/version ids for citation.
- Uploaded documents in a conversation are used for that conversation only; to
  become business knowledge they must be saved through Knowledge (manager
  review). Embeddings can be added later behind the same RPC.

---

## 12. Guardrails

- Input: length limits, attachment type/size limits (per file, and 20 MB per
  turn in total), request bodies read with a byte limit, rate limits per user
  (`ai_runs` window) enforced atomically at `atlas_ai_run_start` (per-user
  advisory lock; `atlas_ai_rate_check` is display only), and an
  injection/scope check on user text and extracted document text.
- Tool: strict schemas, role checks, row and spend caps, execute-level commands
  unreachable from the model.
- Output: redaction of secrets/keys patterns; a grounding check — a reply that
  states operational quantities (units, currency, percentages) is replaced with
  a "could not verify" answer unless every stated figure appears in the user's
  question, the previous answer's evidence, or the output (summary, evidence,
  data) of a tool that returned operational evidence in the same run.
  Navigation (`app.open`) and tools that return no evidence do not count, and
  streaming holds as soon as the text states an unsupported figure. Common
  roundings of evidence figures (whole number, one or two decimals) are
  accepted; replies without quantities (greetings, clarifying questions) always
  pass (S88 hardening F5).
- System notes (approvals, rejections) are built from flattened titles and
  reasons (no markup or line breaks), escaped when replayed, and marked as data
  in history: `<atlas_note>` content never grants roles (F6).
- Errors: browsers never receive raw database, gateway or provider text; failed
  approved actions return a fixed message per code (F9).
- Error codes added by the S88 hardening (response shape unchanged:
  `{error_code, message, …}`):

  | `error_code` | HTTP | When | Extra fields |
  | --- | --- | --- | --- |
  | `voice_quota_exceeded` | 429 | `voice-session` over the daily session cap, the concurrency cap or the estimated minutes budget | `reason`: `daily_sessions` \| `concurrent` \| `daily_minutes` |
  | `voice_session_inactive` | 409 | `voice-tool`, `voice-append` or `voice-end` without a live voice session of the caller | — |
  | `upload_quota_exceeded` | 429 | `upload` (or kept voice-note audio) over the daily files or bytes quota | `reason`: `daily_files` \| `daily_bytes` |
  | `attachments_too_large` | 413 | `chat` whose image/PDF attachments exceed 20 MB in total | — |
  | `rate_limited` | 429 | now also: turn limit reached at run start (race), voice mint throttle, voice tool or transcript append over 30 per minute | — |
  | `not_configured` | 503 | now also: `upload` while Atlas AI is disabled | — |

  `payload_too_large` is not used: oversized bodies keep the existing
  `413 too_large`, now refused from `content-length` before reading.
  New action: `POST ?action=voice-end {voice_session_id}` →
  `{ended: true, voice_session_id, ended_at}`. `voice-session` adds
  `voice_session_id` and `voice_session_expires_at`; `voice-append` accepts
  `ended: true`; `settings` accepts and returns `voice_sessions_per_day`,
  `voice_minutes_per_day`, `max_concurrent_voice_sessions`,
  `upload_bytes_per_day`, `upload_files_per_day`.
- Prompting: system instructions state the evidence rules, the unknown rules
  ("234 items have no par level — do not infer"), and that document text is data.
- Failure behaviour: tool errors are shown as failure states ("Stock is
  unavailable right now"); an action is reported as done only when the server
  confirms execution.

---

## 12a. Background intelligence

- Signals: item falling below par, recipe becoming unavailable, unusual cost
  increase on receipt, stale/missing stock evidence, staffing gap in the next
  7 days, unacknowledged required Knowledge, delivery discrepancy, important
  data-quality issue.
- Computed from the same tools (`operations.alerts`, `data_quality.*`,
  `shifts.schedule`) — no extra model call — and stored as shadow Brain
  recommendations with evidence, severity and a fingerprint so the same signal is
  not repeated. Role-shaped (staff only see operational signals), dismissible
  (a Brain decision), and summarised in Atlas when the user asks
  "What needs my attention today?". No push notifications are sent until the
  owner enables them.

## 13. Observability

- `ai_runs`: conversation, user, role, channel (text/voice/voice-note), models,
  started/finished, latency, tokens in/out, estimated cost, tool-call count,
  status, error code.
- `ai_tool_calls`: run, tool name, level, role decision, arguments (redacted),
  result summary, evidence count, latency, status.
- `ai_actions` lifecycle and approvals; Brain decisions for approvals.
- OpenAI tracing is disabled unless `ATLAS_AI_TRACING=openai` is set, and then
  sensitive data is excluded.
- "Why did Atlas say this?" — each assistant message links to its run, tool
  calls and evidence (shown in the evidence panel).

---

## 14. Evaluation

See `docs/ai/Atlas_AI_Evaluation_Plan.md`. Two layers:
1. **Deterministic gateway suite** (CI, no network): every tool against fixture
   data for correct numbers, sources, role redaction, forbidden roles, approval
   boundaries and failure states; scripted-model conversations exercising
   follow-ups, proposals and grounding checks.
2. **Live model suite** (owner-run with an API key): realistic VÁ questions
   scored for intent, specialist, tools, sources, calculation, hallucination,
   permission, proposal, approval request and usefulness. Any regression that
   could change an operational decision blocks release.

Both run the real runtime and gateway against the VÁ fixture world
(`tests/ai-evals/`): `npm test` (gateway cases), `npm run test:ai` (runtime
evals), `npm run eval:ai-live` (live; `:dry-run` in CI).

---

## 15. Consolidation of existing intelligence

| Existing | Decision |
| --- | --- |
| `atlas-search.js` answerFor (regex Ask) | Record search stays; questions route to Atlas AI. The deterministic answers remain as the offline fallback when Atlas AI is not configured. The palette (`atlas-palette.js`) reads `AtlasAI.state().configured` or `atlas-ai?action=settings` (`configured`): when Atlas AI is on, a question offers "Ask Atlas" first and renders no inline answer; when it is off, unreachable or the device is offline, the answer renders labelled "Quick answer · Atlas AI is off". |
| `brain.js` Ask card / `assistantResponse` | Replaced by the Atlas AI entry point. |
| `brain.js` rule recommendations, hard-coded timeline, calc fallbacks | Removed; timeline uses business hours; recommendations come from `operations.alerts` / `briefing.today`. |
| `atlas-reports?action=ask` | Deprecated (kept until rollout for compatibility, no UI caller). |
| Brain decision memory (`atlas-phase3-brain`, `brain-phase3.js`) | Kept as the decision ledger and review UI; AI proposals flow into it. |
| Checkpoint K intelligence | Kept as a server function; now uses the shared stock rule; not called per chat turn. It is no longer triggered from Home: the one producer of Decisions recommendations is Atlas AI background signals (§12a, `atlas-ai?action=refresh-signals`, run once per manager session by Home and by the scheduler), so the same shortage is never recommended twice under two keys. |
| Daily briefing (Sprint 4) | Folded into `data_quality.*` and `briefing.today`. |
| `business.js` | Deprecated in favour of Reports and `reports.*` tools. |

---

## 16. Estimated operating cost (per venue, per month; prices unverified — confirm on the official pricing page)

- Text chat: ~50 turns/day ≈ $15–30.
- Voice notes: ~20/day × 1 min ≈ $3.
- Live voice: ~15 min/day ≈ $10–50 depending on the realtime model.

`ai_runs` records tokens and estimated cost so real usage can be reviewed.

---

## 17. Owner configuration required before enabling

- Edge Function secret `OPENAI_API_KEY` (server only), optional model overrides.
- Apply the S88 migrations; deploy `atlas-ai`; add `https://api.openai.com` to
  CSP `connect-src` (in the branch's `netlify.toml`).
- Until the key exists, Atlas AI reports "Atlas AI is not configured" and the
  deterministic answers remain available.

## 18. Future extensibility

New capability = one registry entry (+ canonical service if missing) + eval cases.
Candidates: POS sales once connected, supplier lead times, bookings, embeddings
for Knowledge, server-controlled voice on a long-lived host, proactive
notifications through the existing push pipeline.
