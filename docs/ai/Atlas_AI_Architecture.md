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
- Model input: images as `input_image`, PDFs as `input_file` (base64 from
  storage, read server-side). Content extracted from documents is wrapped as
  untrusted data.
- Example: from a purchase order the user photographs a delivery and asks
  "Does this match our order?" → page context supplies the PO id; the Purchasing
  specialist reads the PO lines, the vision input yields observed items, Atlas
  explains matches and discrepancies and may prepare a **receiving proposal**
  — stock only changes after approval through the canonical receiving command.
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
manager-only, matching the Brain today.

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

- Input: length limits, attachment type/size limits, rate limits per user
  (`ai_runs` window), and an injection/scope check on user text and extracted
  document text.
- Tool: strict schemas, role checks, row and spend caps, execute-level commands
  unreachable from the model.
- Output: redaction of secrets/keys patterns; a grounding check — a reply that
  states operational quantities without a tool result in the same run is
  replaced with a "could not verify" answer.
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
| `atlas-search.js` answerFor (regex Ask) | Record search stays; questions route to Atlas AI. The deterministic answers remain as the offline fallback when Atlas AI is not configured. |
| `brain.js` Ask card / `assistantResponse` | Replaced by the Atlas AI entry point. |
| `brain.js` rule recommendations, hard-coded timeline, calc fallbacks | Removed; timeline uses business hours; recommendations come from `operations.alerts` / `briefing.today`. |
| `atlas-reports?action=ask` | Deprecated (kept until rollout for compatibility, no UI caller). |
| Brain decision memory (`atlas-phase3-brain`, `brain-phase3.js`) | Kept as the decision ledger and review UI; AI proposals flow into it. |
| Checkpoint K intelligence | Kept; now uses the shared stock rule; not called per chat turn. |
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
