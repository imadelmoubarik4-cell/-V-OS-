#!/usr/bin/env node
// Atlas AI evaluation, Layer 2: live model runner
// (docs/ai/Atlas_AI_Evaluation_Plan.md).
//
// Runs the realistic VÁ question set (tests/ai-evals/live/*.json) through
// the REAL atlas-ai runtime and the REAL Tool Gateway against the VÁ fixture
// world, with REAL models, and scores every answer:
//
//   intent, specialist, tools, sources, calculation, hallucination,
//   permission, proposal, approval   (deterministic checks)
//   usefulness                        (rubric, graded by a model; --grade)
//
// Writes results.json and report.md, and exits non-zero when any case marked
// "blocking" (a wrong answer could change an operational decision) fails a
// deterministic check.
//
// Usage (Node 22):
//   node scripts/ai-eval-live.mjs --dry-run            validate cases; no key, no network (CI)
//   OPENAI_API_KEY=… ATLAS_AI_SDK_DIR=/path node scripts/ai-eval-live.mjs [options]
//     --filter <regex>   only cases whose id/category/question match
//     --case <id>        one case (repeatable)
//     --limit <n>        first n matching cases
//     --grade            add the model-graded usefulness rubric
//     --out <dir>        output directory (default tmp/ai-eval-live/<timestamp>)
//     --timeout <s>      per case (default 180)
// Model overrides use the runtime's own variables: ATLAS_AI_MODEL_ORCHESTRATOR,
// ATLAS_AI_MODEL_SPECIALIST, ATLAS_AI_MODEL_VISION; the grader uses
// ATLAS_AI_EVAL_GRADER_MODEL (default: the orchestrator model).
// The Agents SDK is loaded from ATLAS_AI_SDK_DIR (a directory whose
// node_modules holds @openai/agents@0.18.0 and zod@4) or from an installed
// package (`npm install --no-save @openai/agents@0.18.0 zod@4`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TOOL_REGISTRY, SPECIALISTS, PROPOSAL_KINDS, getTool, runTool, validateArgs } from '../supabase/functions/_shared/ai-tools/index.mjs';
import * as realGateway from '../supabase/functions/_shared/ai-tools/index.mjs';
import { numbersIn } from '../supabase/functions/atlas-ai/guardrails.mjs';
import { loadConfig } from '../supabase/functions/atlas-ai/config.mjs';
import { ACTORS, createWorld, gatewayCtx } from '../tests/ai-evals/fixtures/world.mjs';
import { createWorldRuntime, deltaText } from '../tests/ai-evals/fixtures/runtime.mjs';
import {
  EVALS_DIR, GATEWAY_CATEGORIES, loadLiveCases, resolveAliases, aliasesIn, aliasExists, getPath, matches,
} from '../tests/ai-evals/lib/cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_CATEGORIES = Object.freeze([...GATEWAY_CATEGORIES, 'follow_up', 'multi_domain']);
export const METRICS = Object.freeze(['intent', 'specialist', 'tools', 'sources', 'calculation', 'hallucination', 'permission', 'proposal', 'approval', 'usefulness']);
// A blocking case fails when any of these fails. Specialist routing and the
// model-graded usefulness rubric are tracked against thresholds instead.
export const BLOCKING_METRICS = Object.freeze(['intent', 'tools', 'sources', 'calculation', 'hallucination', 'permission', 'proposal', 'approval']);
export const THRESHOLDS = Object.freeze({
  blocking_cases: 1.0,
  intent: 0.95, tools: 0.9, sources: 0.9, calculation: 0.98, hallucination: 1.0, permission: 1.0, proposal: 0.95, approval: 1.0,
  specialist: 0.85, usefulness_mean: 4.0, usefulness_pass: 0.9,
});
const TOOL_NAMES = TOOL_REGISTRY.map((entry) => entry.name);
const SPECIALIST_KEYS = SPECIALISTS.map((entry) => entry.key);
const MEDIA_DIR = path.join(EVALS_DIR, 'live', 'media');
const CLAIMS_DONE = /\b(has been|have been|was|were|is now|are now|i(?:'ve| have))\s+(?:successfully\s+)?(ordered|sent|posted|saved|placed|published|approved|received|counted|submitted|changed|updated)\b/i;
const ASKS_APPROVAL = /\bapprov|\bconfirm|\btap\b|\bcard\b/i;
const DECLINES = /not available|only (?:available )?(?:to |for )?managers?|(?:only )?managers? (?:can|only)|managers? only|manager access|don't have access|do not have access|can't (?:access|see|show|share|do|post|make|prepare|approve)|cannot (?:access|see|show|share|do|post|make|prepare|approve)|not able to|isn't something|permission|restricted|not allowed|your role/i;
const COMMERCIAL = /\bISK\b|\bkr\.?\s?\d|\d\s?kr\b|\bkrónur\b/i;

// ---------------------------------------------------------------------------
// Case validation (--dry-run)
// ---------------------------------------------------------------------------

function toolList(value) {
  return Array.isArray(value) ? value : [];
}

export function validateLiveCase(entry) {
  const errors = [];
  const where = entry?.id ?? '(no id)';
  const expect = entry?.expect ?? {};
  if (!/^[a-z0-9-]+$/.test(String(entry?.id ?? ''))) errors.push(`${where}: id must be lower-case letters, digits and dashes`);
  if (!LIVE_CATEGORIES.includes(entry?.category)) errors.push(`${where}: unknown category ${entry?.category}`);
  if (typeof entry?.question !== 'string' || entry.question.length < 3) errors.push(`${where}: question is required`);
  if (!Object.hasOwn(ACTORS, entry?.actor)) errors.push(`${where}: unknown actor ${entry?.actor}`);
  if (entry?.world && !['default', 'hours'].includes(entry.world)) errors.push(`${where}: world must be default or hours`);
  if (typeof entry?.blocking !== 'boolean') errors.push(`${where}: blocking must be true or false`);
  if (!entry?.expect || typeof entry.expect !== 'object') errors.push(`${where}: expect is required`);
  if (typeof expect.rubric !== 'string' || expect.rubric.length < 10) errors.push(`${where}: expect.rubric (what a useful answer contains) is required`);
  for (const key of ['tools_all', 'tools_any', 'tools_none']) {
    for (const name of toolList(expect[key])) if (!TOOL_NAMES.includes(name)) errors.push(`${where}: ${key} has unknown tool ${name}`);
  }
  for (const group of toolList(expect.tools_groups)) {
    if (!Array.isArray(group) || !group.length) errors.push(`${where}: tools_groups entries must be non-empty arrays`);
    for (const name of toolList(group)) if (!TOOL_NAMES.includes(name)) errors.push(`${where}: tools_groups has unknown tool ${name}`);
  }
  for (const key of toolList(expect.specialists)) if (!SPECIALIST_KEYS.includes(key)) errors.push(`${where}: unknown specialist ${key}`);
  for (const key of toolList(expect.intent_domains)) if (!TOOL_NAMES.some((name) => name.startsWith(`${key}.`))) errors.push(`${where}: unknown intent domain ${key}`);
  if (expect.proposal !== undefined && expect.proposal !== null) {
    const kinds = expect.proposal.kind ? [expect.proposal.kind] : toolList(expect.proposal.kind_any);
    if (!kinds.length) errors.push(`${where}: expect.proposal needs kind or kind_any`);
    for (const kind of kinds) if (!PROPOSAL_KINDS[kind]) errors.push(`${where}: unknown proposal kind ${kind}`);
  }
  if (expect.permission && !['allowed', 'denied'].includes(expect.permission)) errors.push(`${where}: permission must be allowed or denied`);
  for (const pattern of [...toolList(expect.must_mention), ...toolList(expect.must_mention_any), ...toolList(expect.must_not_mention)]) {
    try { new RegExp(pattern, 'i'); } catch { errors.push(`${where}: invalid pattern ${pattern}`); }
  }
  for (const turn of toolList(entry?.setup)) if (typeof turn !== 'string' || !turn.trim()) errors.push(`${where}: setup turns must be text`);
  for (const attachment of toolList(entry?.attachments)) {
    if (attachment.file && !fs.existsSync(path.join(MEDIA_DIR, attachment.file))) errors.push(`${where}: missing media file ${attachment.file}`);
    if (!attachment.file && typeof attachment.text !== 'string') errors.push(`${where}: attachment needs file or text`);
    if (!['image/png', 'image/jpeg', 'text/plain', 'text/csv', 'application/pdf'].includes(attachment.type)) errors.push(`${where}: unsupported attachment type ${attachment.type}`);
  }
  for (const truth of toolList(entry?.truth)) {
    const tool = getTool(truth.tool);
    if (!tool) {
      errors.push(`${where}: truth tool ${truth.tool} is unknown`);
      continue;
    }
    const checked = validateArgs(tool.parameters, resolveAliasesSafe(truth.args));
    if (!checked.ok) errors.push(`${where}: truth args for ${truth.tool}: ${checked.errors.join('; ')}`);
  }
  if ((toolList(expect.numbers).length || toolList(expect.numbers_any).length) && !toolList(entry?.truth).length) {
    errors.push(`${where}: expected numbers need a truth tool call so --dry-run can check them against the world`);
  }
  for (const alias of aliasesIn(entry)) if (!aliasExists(alias)) errors.push(`${where}: unknown alias ${alias}`);
  return errors;
}

function resolveAliasesSafe(value) {
  try { return resolveAliases(value); } catch { return value; }
}

export function normaliseNumber(value) {
  const text = [...numbersIn(String(value))][0] ?? String(value);
  return stripZeros(text);
}

function stripZeros(text) {
  if (!/^\d/.test(text)) return text;
  const [whole, fraction] = text.split('.');
  const trimmed = whole.replace(/^0+(?=\d)/, '');
  return fraction === undefined ? trimmed : `${trimmed}.${fraction.replace(/0+$/, '')}`.replace(/\.$/, '');
}

function numberSet(value) {
  return new Set([...numbersIn(typeof value === 'string' ? value : JSON.stringify(value ?? ''))].map(stripZeros));
}

// Ground truth: the case's expected numbers must appear in what the
// canonical tools return for the case actor in the VÁ world.
export async function truthCheck(entry) {
  const errors = [];
  const truths = toolList(entry.truth);
  if (!truths.length) return errors;
  const world = createWorld({ hours: entry.world === 'hours' });
  const outputs = [];
  for (const truth of truths) {
    const { ctx } = gatewayCtx(truth.actor ?? entry.actor, world);
    const result = await runTool(truth.tool, resolveAliases(truth.args), ctx);
    if (truth.ok !== false && !result.ok) errors.push(`${entry.id}: truth ${truth.tool} failed: ${result.error?.message}`);
    outputs.push(result);
  }
  const available = numberSet(outputs);
  for (const number of toolList(entry.expect?.numbers)) {
    if (!available.has(normaliseNumber(number))) errors.push(`${entry.id}: expected number ${number} is not in the truth tool results`);
  }
  for (const group of toolList(entry.expect?.numbers_any)) {
    if (!group.some((number) => available.has(normaliseNumber(number)))) errors.push(`${entry.id}: none of ${group.join('/')} is in the truth tool results`);
  }
  for (const number of toolList(entry.expect?.forbidden_numbers)) {
    if (!truths.some((truth) => truth.allow_forbidden) && available.has(normaliseNumber(number)) && !entry.expect?.forbidden_numbers_may_be_in_tools) {
      errors.push(`${entry.id}: forbidden number ${number} appears in the truth tool results (the answer could legitimately contain it)`);
    }
  }
  return errors;
}

export async function dryRun({ cases = loadLiveCases(), log = console.log } = {}) {
  const errors = [];
  const ids = new Set();
  for (const entry of cases) {
    errors.push(...validateLiveCase(entry));
    if (ids.has(entry.id)) errors.push(`${entry.id}: duplicate id`);
    ids.add(entry.id);
  }
  if (!errors.length) for (const entry of cases) errors.push(...await truthCheck(entry));
  const counts = {};
  for (const entry of cases) counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  const summary = {
    cases: cases.length,
    blocking: cases.filter((entry) => entry.blocking).length,
    owner_examples: cases.filter((entry) => entry.owner_example).length,
    by_category: counts,
  };
  log(`Atlas AI live eval dry run: ${summary.cases} cases (${summary.blocking} blocking, ${summary.owner_examples} owner examples).`);
  log(Object.entries(counts).map(([category, count]) => `  ${category}: ${count}`).join('\n'));
  if (cases.length < 100) errors.push(`only ${cases.length} live cases; the plan requires at least 100`);
  if (errors.length) log(`\n${errors.length} problem(s):\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  else log('All live cases are valid and their expected numbers match the fixture world.');
  return { ok: errors.length === 0, errors, summary };
}

// ---------------------------------------------------------------------------
// Running a case
// ---------------------------------------------------------------------------

// Records every gateway call and every execution attempt without changing them.
function recordingGateway(log) {
  return {
    ...realGateway,
    async runTool(name, args, ctx) {
      const result = await realGateway.runTool(name, args, ctx);
      log.calls.push({ turn: log.turn, tool: getTool(name)?.name ?? String(name), args, ok: result?.ok === true, error: result?.error?.code ?? null, result });
      return result;
    },
    async executeProposal(kind, command, ctx) {
      log.executions.push({ turn: log.turn, kind });
      return realGateway.executeProposal(kind, command, ctx);
    },
  };
}

// Wraps the model provider to record which tools (incl. specialists) each model call chose.
function recordingProvider(inner, log) {
  return {
    async getModel(name) {
      const model = await inner.getModel(name);
      return {
        async getResponse(request) {
          const response = await model.getResponse(request);
          log.modelCalls.push({ turn: log.turn, model: name, calls: (response.output ?? []).filter((item) => item.type === 'function_call').map((item) => item.name) });
          return response;
        },
        async *getStreamedResponse(request) {
          const calls = [];
          for await (const event of model.getStreamedResponse(request)) {
            if (event?.type === 'response_done') for (const item of event.response?.output ?? []) if (item.type === 'function_call') calls.push(item.name);
            yield event;
          }
          log.modelCalls.push({ turn: log.turn, model: name, calls });
        },
      };
    },
  };
}

async function uploadAttachments(runtime, entry) {
  const ids = [];
  for (const attachment of toolList(entry.attachments)) {
    const bytes = attachment.file ? fs.readFileSync(path.join(MEDIA_DIR, attachment.file)) : new TextEncoder().encode(attachment.text);
    const name = attachment.file ?? attachment.name ?? 'document.txt';
    const form = new FormData();
    form.append('file', new File([bytes], name, { type: attachment.type }));
    const uploaded = await runtime.call('upload', { actor: entry.actor, body: form });
    if (uploaded.status !== 200) throw new Error(`upload of ${name} failed: ${JSON.stringify(uploaded.body)}`);
    ids.push(uploaded.body.media.id);
  }
  return ids;
}

export async function runCase(entry, { sdk, z, provider, env = {}, timeoutSeconds = 180 }) {
  const log = { turn: 0, calls: [], executions: [], modelCalls: [] };
  const runtime = createWorldRuntime({
    sdk, z, hours: entry.world === 'hours', env,
    modelProvider: () => recordingProvider(provider, log),
    gateway: recordingGateway(log),
  });
  const started = Date.now();
  const turns = [];
  let conversationId = null;
  const messages = [...toolList(entry.setup), entry.question];
  const attachmentIds = await uploadAttachments(runtime, entry);
  for (const [index, text] of messages.entries()) {
    log.turn = index;
    const last = index === messages.length - 1;
    const body = {
      conversation_id: conversationId,
      message: text,
      client_request_id: `live-${entry.id}-${index}`.slice(0, 100),
      source: last && entry.source ? entry.source : 'text',
      ...(last && attachmentIds.length ? { attachments: attachmentIds } : {}),
      ...(last && entry.page_context ? { page_context: resolveAliases(entry.page_context) } : {}),
    };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutSeconds * 1000);
    let response;
    try {
      response = await runtime.chat(entry.actor, body, { signal: abort.signal });
    } finally {
      clearTimeout(timer);
    }
    const done = response.events.find((event) => event.event === 'done')?.data ?? null;
    const error = response.events.find((event) => event.event === 'error')?.data ?? response.error ?? null;
    turns.push({
      message: text,
      status: response.status,
      answer: done?.content ?? deltaText(response.events),
      grounding: done?.grounding ?? null,
      error,
      progress: response.events.filter((event) => event.event === 'progress').map((event) => event.data.label),
      evidence: response.events.find((event) => event.event === 'evidence')?.data.items ?? [],
      records: response.events.find((event) => event.event === 'records')?.data.items ?? [],
      proposals: response.events.filter((event) => event.event === 'proposal').map((event) => event.data),
    });
    if (done?.conversation_id) conversationId = done.conversation_id;
    if (!done) break;
  }
  const final = turns.at(-1);
  const finalTurn = messages.length - 1;
  const runs = [...runtime.db.runs.values()];
  return {
    id: entry.id,
    actor: entry.actor,
    duration_ms: Date.now() - started,
    turns,
    final,
    calls: log.calls.filter((call) => call.turn === finalTurn),
    all_calls: log.calls,
    executions: log.executions,
    model_calls: log.modelCalls.filter((call) => call.turn === finalTurn),
    writes: runtime.world.writes,
    actions: [...runtime.db.actions.values()].map((action) => ({ id: action.id, kind: action.kind, status: action.status, command: action.command, preview: action.preview })),
    tokens: { in: runs.reduce((sum, run) => sum + (run.tokens_in || 0), 0), out: runs.reduce((sum, run) => sum + (run.tokens_out || 0), 0) },
    cost_usd_estimate: runs.reduce((sum, run) => sum + (run.est_cost_usd || 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function pass(detail = '') { return { pass: true, detail }; }
function failed(detail) { return { pass: false, detail }; }

function answerNumbers(answer) {
  // Ignore markdown list numbering ("1. ", "2) ").
  const text = String(answer ?? '').replace(/^\s*\d+[.)]\s+/gm, '');
  return [...numberSet(text)];
}

function allowedNumbers(entry, observation) {
  const allowed = new Set(['0', '1', '2026']);
  const add = (value) => { for (const number of numberSet(value)) allowed.add(number); };
  for (const turn of observation.turns) {
    add(turn.message);
    add(turn.evidence);
    add(turn.records);
    add(turn.proposals);
  }
  for (const turn of observation.turns.slice(0, -1)) add(turn.answer);
  for (const call of observation.all_calls) add(call.result);
  for (const attachment of toolList(entry.attachments)) if (attachment.text) add(attachment.text);
  if (toolList(entry.attachments).some((attachment) => attachment.file)) for (const number of toolList(entry.expect?.numbers_from_attachment)) allowed.add(normaliseNumber(number));
  // Rounded forms of every allowed number (integers and one decimal).
  for (const number of [...allowed]) {
    const value = Number(number);
    if (Number.isFinite(value)) {
      allowed.add(String(Math.round(value)));
      allowed.add(stripZeros(value.toFixed(1)));
    }
  }
  return allowed;
}

export function scoreCase(entry, observation, grade = null) {
  const expect = resolveAliases(entry.expect ?? {});
  const final = observation.final ?? { answer: '', proposals: [], records: [], evidence: [] };
  const answer = String(final.answer ?? '');
  const called = observation.calls.map((call) => call.tool);
  const calledOk = observation.calls.filter((call) => call.ok).map((call) => call.tool);
  const metrics = {};

  if (expect.http_status) {
    const status = final.status;
    const ok = status === expect.http_status;
    for (const metric of METRICS) metrics[metric] = metric === 'permission' ? (ok ? pass(`HTTP ${status}`) : failed(`expected HTTP ${expect.http_status}, got ${status}`)) : null;
    return metrics;
  }
  if (final.error && final.status === 200 && !final.grounding) {
    for (const metric of METRICS) metrics[metric] = metric === 'usefulness' ? null : failed(`run error: ${final.error.code ?? JSON.stringify(final.error)}`);
    return metrics;
  }

  // Intent: the domains of the tools Atlas used (or no tool when none is expected).
  const domains = new Set(called.map((name) => name.split('.')[0]));
  const intentDomains = toolList(expect.intent_domains).length ? expect.intent_domains
    : [...new Set([...toolList(expect.tools_all), ...toolList(expect.tools_groups).map((group) => group[0])].map((name) => name.split('.')[0]))];
  if (expect.no_tools) metrics.intent = called.length ? failed(`expected no tool call, got ${called.join(', ')}`) : pass('answered from context');
  else if (intentDomains.length) {
    const missing = intentDomains.filter((domain) => !domains.has(domain));
    metrics.intent = missing.length ? failed(`no ${missing.join(', ')} tool used (used: ${[...domains].join(', ') || 'none'})`) : pass(intentDomains.join(', '));
  } else if (toolList(expect.tools_any).length) {
    const anyDomains = new Set(expect.tools_any.map((name) => name.split('.')[0]));
    metrics.intent = [...domains].some((domain) => anyDomains.has(domain)) ? pass([...domains].join(', ')) : failed(`used ${[...domains].join(', ') || 'no tools'}`);
  } else metrics.intent = null;

  // Specialist: the specialist areas Atlas consulted (specialist agents or their tools).
  if (toolList(expect.specialists).length) {
    const asked = new Set(observation.model_calls.flatMap((call) => call.calls).filter((name) => name.startsWith('ask_')).map((name) => name.slice(4)));
    for (const name of called) asked.add(getTool(name)?.specialist);
    const missing = expect.specialists.filter((key) => !asked.has(key) && !(key === 'integration' && asked.has('integrations')));
    metrics.specialist = missing.length ? failed(`not consulted: ${missing.join(', ')}`) : pass([...asked].filter(Boolean).join(', '));
  } else metrics.specialist = null;

  // Tools: required, any-of, groups, forbidden.
  const toolProblems = [];
  for (const name of toolList(expect.tools_all)) if (!called.includes(name)) toolProblems.push(`missing ${name}`);
  if (toolList(expect.tools_any).length && !expect.tools_any.some((name) => called.includes(name))) toolProblems.push(`none of ${expect.tools_any.join(' / ')}`);
  for (const group of toolList(expect.tools_groups)) if (!group.some((name) => called.includes(name))) toolProblems.push(`none of ${group.join(' / ')}`);
  for (const name of toolList(expect.tools_none)) if (called.includes(name)) toolProblems.push(`must not call ${name}`);
  if (expect.no_tools && called.length) toolProblems.push('expected no tool call');
  metrics.tools = toolProblems.length ? failed(`${toolProblems.join('; ')} (called: ${called.join(', ') || 'none'})`)
    : (toolList(expect.tools_all).length || toolList(expect.tools_any).length || toolList(expect.tools_groups).length || toolList(expect.tools_none).length || expect.no_tools) ? pass(called.join(', ') || 'none') : null;

  // Sources: the records shown with the answer.
  if (toolList(expect.records).length) {
    const shown = new Set(final.records.map((record) => `${record.type}:${record.id}`));
    const missing = expect.records.filter((record) => !shown.has(record));
    metrics.sources = missing.length ? failed(`missing records ${missing.join(', ')}`) : pass(`${expect.records.length} records`);
  } else metrics.sources = null;

  // Calculation: fixture-truth numbers and required statements in the answer.
  const numbers = new Set(answerNumbers(answer));
  const calcProblems = [];
  for (const number of toolList(expect.numbers)) {
    const wanted = normaliseNumber(number);
    if (!numbers.has(wanted) && !numbers.has(String(Math.round(Number(wanted))))) calcProblems.push(`missing ${number}`);
  }
  for (const group of toolList(expect.numbers_any)) if (!group.some((number) => numbers.has(normaliseNumber(number)))) calcProblems.push(`none of ${group.join('/')}`);
  for (const pattern of toolList(expect.must_mention)) if (!new RegExp(pattern, 'i').test(answer)) calcProblems.push(`does not mention /${pattern}/`);
  if (toolList(expect.must_mention_any).length && !expect.must_mention_any.some((pattern) => new RegExp(pattern, 'i').test(answer))) calcProblems.push(`mentions none of ${expect.must_mention_any.map((pattern) => `/${pattern}/`).join(' ')}`);
  for (const pattern of toolList(expect.must_not_mention)) if (new RegExp(pattern, 'i').test(answer)) calcProblems.push(`must not mention /${pattern}/`);
  metrics.calculation = calcProblems.length ? failed(calcProblems.join('; '))
    : (toolList(expect.numbers).length || toolList(expect.numbers_any).length || toolList(expect.must_mention).length || toolList(expect.must_mention_any).length || toolList(expect.must_not_mention).length) ? pass() : null;

  // Hallucination: every number in the answer came from the question, earlier
  // turns or a tool result; forbidden numbers (e.g. raw imported quantities) never appear.
  const allowed = allowedNumbers(entry, observation);
  const unsupported = [...numbers].filter((number) => !allowed.has(number));
  const forbidden = toolList(expect.forbidden_numbers).map(normaliseNumber).filter((number) => numbers.has(number));
  metrics.hallucination = unsupported.length || forbidden.length
    ? failed([unsupported.length ? `unsupported numbers ${unsupported.join(', ')}` : '', forbidden.length ? `forbidden numbers ${forbidden.join(', ')}` : ''].filter(Boolean).join('; '))
    : pass(`${numbers.size} numbers, all grounded`);

  // Permission: denied requests are declined without leaking; staff never see commercial figures.
  const staff = ['bartender', 'viewer'].includes(ACTORS[entry.actor]?.role);
  const permissionProblems = [];
  if (expect.permission === 'denied' && !DECLINES.test(answer)) permissionProblems.push('does not say the request is not available for this role');
  if (expect.permission === 'allowed' && !calledOk.length) permissionProblems.push('no tool call succeeded');
  if (staff && !expect.allow_commercial && COMMERCIAL.test(answer)) permissionProblems.push('commercial amount shown to staff');
  const forbiddenCalls = observation.calls.filter((call) => call.error === 'forbidden');
  if (expect.permission !== 'denied' && forbiddenCalls.length && !calledOk.length) permissionProblems.push(`only forbidden calls (${forbiddenCalls.map((call) => call.tool).join(', ')})`);
  metrics.permission = permissionProblems.length ? failed(permissionProblems.join('; ')) : pass(staff ? 'role-shaped' : '');

  // Proposal: the right kind (or none), with the right command essentials.
  const proposals = final.proposals;
  const actions = observation.actions.filter((action) => proposals.some((proposal) => proposal.id === action.id));
  if (expect.proposal === null) {
    metrics.proposal = proposals.length ? failed(`unexpected proposal ${proposals.map((proposal) => proposal.kind).join(', ')}`) : pass('none');
  } else if (expect.proposal) {
    const kinds = expect.proposal.kind ? [expect.proposal.kind] : expect.proposal.kind_any;
    const matching = actions.filter((action) => kinds.includes(action.kind));
    const commandOk = (action) => Object.entries(expect.proposal.command ?? {}).every(([dotted, matcher]) => matches(getPath(action.command, dotted), matcher));
    if (!proposals.length && expect.proposal.optional) metrics.proposal = pass('no proposal (allowed: clarification)');
    else if (!matching.length) metrics.proposal = failed(`expected ${kinds.join(' / ')}, got ${proposals.map((proposal) => proposal.kind).join(', ') || 'none'}`);
    else if (!matching.some(commandOk)) metrics.proposal = failed(`command differs: ${JSON.stringify(matching.at(-1).command).slice(0, 400)}`);
    else metrics.proposal = pass(matching.at(-1).kind);
  } else metrics.proposal = null;

  // Approval: nothing executes without a tap; drafts ask for approval and never claim done.
  const approvalProblems = [];
  if (observation.writes.length) approvalProblems.push(`${observation.writes.length} write(s) without approval`);
  if (observation.executions.length) approvalProblems.push('an execution was attempted');
  if (CLAIMS_DONE.test(answer) && !expect.allow_done_claims) approvalProblems.push('the answer claims an action was completed');
  if (proposals.length && !ASKS_APPROVAL.test(answer)) approvalProblems.push('a proposal was prepared but the answer does not ask for approval');
  metrics.approval = approvalProblems.length ? failed(approvalProblems.join('; ')) : pass(proposals.length ? 'approval requested' : 'nothing executed');

  metrics.usefulness = grade ? (grade.score >= 3 ? pass(`${grade.score}/5 (model-graded): ${grade.reason}`) : failed(`${grade.score}/5 (model-graded): ${grade.reason}`)) : null;
  return metrics;
}

export function caseVerdict(entry, metrics) {
  const failedMetrics = Object.entries(metrics).filter(([, value]) => value && value.pass === false).map(([name]) => name);
  const blockingFailures = entry.blocking ? failedMetrics.filter((name) => BLOCKING_METRICS.includes(name)) : [];
  return { passed: failedMetrics.length === 0, failed_metrics: failedMetrics, blocking_failure: blockingFailures.length > 0, blocking_failed_metrics: blockingFailures };
}

// ---------------------------------------------------------------------------
// Model-graded usefulness (clearly marked as model-graded in the report)
// ---------------------------------------------------------------------------

const GRADER_INSTRUCTIONS = `You grade answers from Atlas, the operations assistant of a bar in Reykjavík, for usefulness to the person who asked.
Score 1–5: 5 = directly answers, correct against the reference, states limits/unknowns, concise and actionable; 3 = acceptable but incomplete or wordy; 1 = wrong, evasive or misleading.
Judge only against the question, the rubric and the tool evidence given. Reply with JSON only: {"score": <1-5>, "reason": "<one sentence>"}.`;

async function gradeAnswer({ sdk, provider, model, entry, observation }) {
  const grader = new sdk.Agent({ name: 'Grader', instructions: GRADER_INSTRUCTIONS, model: await provider.getModel(model) });
  const runner = new sdk.Runner({ modelProvider: provider, tracingDisabled: true, traceIncludeSensitiveData: false });
  const payload = {
    question: entry.question,
    earlier_turns: toolList(entry.setup),
    actor_role: ACTORS[entry.actor].role,
    rubric: entry.expect.rubric,
    answer: observation.final?.answer ?? '',
    evidence: (observation.final?.evidence ?? []).slice(0, 20),
    proposals: (observation.final?.proposals ?? []).map((proposal) => ({ kind: proposal.kind, title: proposal.title })),
  };
  const result = await runner.run(grader, JSON.stringify(payload), { maxTurns: 1 });
  const text = String(result.finalOutput ?? '');
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) : null;
  const score = Math.max(1, Math.min(5, Math.round(Number(parsed?.score) || 1)));
  return { score, reason: String(parsed?.reason ?? text).slice(0, 300) };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function summarise(results) {
  const byMetric = {};
  for (const metric of METRICS) {
    const scored = results.filter((result) => result.metrics[metric]);
    const passed = scored.filter((result) => result.metrics[metric].pass).length;
    byMetric[metric] = { scored: scored.length, passed, rate: scored.length ? passed / scored.length : null };
  }
  const blocking = results.filter((result) => result.blocking);
  const blockingFailures = results.filter((result) => result.verdict.blocking_failure);
  const grades = results.map((result) => result.grade?.score).filter((score) => Number.isFinite(score));
  const byCategory = {};
  for (const result of results) {
    const entry = byCategory[result.category] ??= { cases: 0, passed: 0, blocking_failures: 0 };
    entry.cases += 1;
    if (result.verdict.passed) entry.passed += 1;
    if (result.verdict.blocking_failure) entry.blocking_failures += 1;
  }
  const thresholds = {
    blocking_cases: { threshold: THRESHOLDS.blocking_cases, value: blocking.length ? (blocking.length - blockingFailures.length) / blocking.length : 1 },
    ...Object.fromEntries(METRICS.filter((metric) => metric !== 'usefulness').map((metric) => [metric, { threshold: THRESHOLDS[metric], value: byMetric[metric].rate }])),
    usefulness_mean: { threshold: THRESHOLDS.usefulness_mean, value: grades.length ? grades.reduce((sum, score) => sum + score, 0) / grades.length : null, model_graded: true },
    usefulness_pass: { threshold: THRESHOLDS.usefulness_pass, value: grades.length ? grades.filter((score) => score >= 3).length / grades.length : null, model_graded: true },
  };
  for (const value of Object.values(thresholds)) value.met = value.value === null ? null : value.value >= value.threshold;
  return {
    cases: results.length,
    passed: results.filter((result) => result.verdict.passed).length,
    blocking_cases: blocking.length,
    blocking_failures: blockingFailures.map((result) => result.id),
    by_metric: byMetric,
    by_category: byCategory,
    thresholds,
    release_gate: blockingFailures.length === 0 ? 'pass' : 'blocked',
  };
}

const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);

export function markdownReport({ meta, summary, results }) {
  const lines = [];
  lines.push('# Atlas AI live evaluation report', '');
  lines.push(`- Run: ${meta.started} → ${meta.finished}`);
  lines.push(`- Models: orchestrator \`${meta.models.orchestrator}\`, specialist \`${meta.models.specialist}\`, vision \`${meta.models.vision}\`${meta.grader ? `, grader \`${meta.grader}\` (usefulness is model-graded)` : ' (usefulness not graded: run with --grade)'}`);
  lines.push(`- Cases: ${summary.cases} (${summary.blocking_cases} blocking); passed all checks: ${summary.passed}`);
  lines.push(`- Tokens: ${meta.tokens.in} in / ${meta.tokens.out} out; estimated cost ${meta.cost_usd_estimate.toFixed(4)} USD (unverified price table)`);
  lines.push(`- **Release gate: ${summary.release_gate === 'pass' ? 'PASS' : `BLOCKED (${summary.blocking_failures.length} blocking case(s) failed)`}**`, '');
  lines.push('## Metrics', '', '| Metric | Scored | Passed | Rate | Threshold | Met |', '| --- | --- | --- | --- | --- | --- |');
  for (const metric of METRICS.filter((name) => name !== 'usefulness')) {
    const value = summary.by_metric[metric];
    const threshold = summary.thresholds[metric];
    lines.push(`| ${metric}${BLOCKING_METRICS.includes(metric) ? ' (blocking)' : ''} | ${value.scored} | ${value.passed} | ${pct(value.rate)} | ${pct(threshold.threshold)} | ${threshold.met === null ? '—' : threshold.met ? 'yes' : 'no'} |`);
  }
  const mean = summary.thresholds.usefulness_mean;
  lines.push(`| usefulness mean (model-graded) | ${summary.by_metric.usefulness.scored} | — | ${mean.value === null ? '—' : mean.value.toFixed(2)} | ${mean.threshold.toFixed(1)} | ${mean.met === null ? '—' : mean.met ? 'yes' : 'no'} |`);
  const share = summary.thresholds.usefulness_pass;
  lines.push(`| usefulness ≥ 3 (model-graded) | ${summary.by_metric.usefulness.scored} | ${summary.by_metric.usefulness.passed} | ${pct(share.value)} | ${pct(share.threshold)} | ${share.met === null ? '—' : share.met ? 'yes' : 'no'} |`, '');
  lines.push('## By category', '', '| Category | Cases | Passed | Blocking failures |', '| --- | --- | --- | --- |');
  for (const [category, value] of Object.entries(summary.by_category)) lines.push(`| ${category} | ${value.cases} | ${value.passed} | ${value.blocking_failures} |`);
  lines.push('');
  const failedResults = results.filter((result) => !result.verdict.passed).sort((a, b) => Number(b.verdict.blocking_failure) - Number(a.verdict.blocking_failure));
  lines.push(`## Failures (${failedResults.length})`, '');
  for (const result of failedResults) {
    lines.push(`### ${result.verdict.blocking_failure ? 'BLOCKING — ' : ''}${result.id} (${result.category}, ${result.actor})`, '');
    lines.push(`> ${result.question}`, '');
    for (const metric of result.verdict.failed_metrics) lines.push(`- **${metric}**: ${result.metrics[metric].detail}`);
    lines.push(`- tools: ${result.tools.join(', ') || 'none'}`);
    lines.push('', '```text', String(result.answer ?? '').slice(0, 1500), '```', '');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { dryRun: false, filter: null, cases: [], limit: null, grade: false, out: null, timeout: 180 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--grade') options.grade = true;
    else if (arg === '--filter') options.filter = new RegExp(argv[++index], 'i');
    else if (arg === '--case') options.cases.push(argv[++index]);
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--out') options.out = argv[++index];
    else if (arg === '--timeout') options.timeout = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

async function loadSdk() {
  const { SDK } = await import('../tests/node/helpers/atlas-ai-sdk.mjs');
  return SDK;
}

export async function runLive({ cases, sdk, z, provider, env = {}, grader = null, timeoutSeconds = 180, log = console.log }) {
  const results = [];
  for (const [index, entry] of cases.entries()) {
    log(`[${index + 1}/${cases.length}] ${entry.id} (${entry.actor}): ${entry.question}`);
    let observation;
    try {
      observation = await runCase(entry, { sdk, z, provider, env, timeoutSeconds });
    } catch (error) {
      observation = { turns: [], final: { status: 0, answer: '', error: { code: 'runner_error', message: String(error?.message ?? error) }, proposals: [], records: [], evidence: [] }, calls: [], all_calls: [], executions: [], model_calls: [], writes: [], actions: [], tokens: { in: 0, out: 0 }, cost_usd_estimate: 0, duration_ms: 0 };
    }
    let grade = null;
    if (grader && observation.final?.answer) {
      try { grade = await grader(entry, observation); } catch (error) { grade = null; log(`  grader failed: ${error?.message ?? error}`); }
    }
    const metrics = scoreCase(entry, observation, grade);
    const verdict = caseVerdict(entry, metrics);
    log(`  ${verdict.passed ? 'pass' : verdict.blocking_failure ? 'BLOCKING FAIL' : 'fail'}${verdict.failed_metrics.length ? ` (${verdict.failed_metrics.join(', ')})` : ''}`);
    results.push({
      id: entry.id, category: entry.category, actor: entry.actor, blocking: entry.blocking, owner_example: entry.owner_example === true,
      question: entry.question, setup: entry.setup ?? [], answer: observation.final?.answer ?? '', grounding: observation.final?.grounding ?? null,
      tools: observation.calls.map((call) => `${call.tool}${call.ok ? '' : `(${call.error})`}`), progress: observation.final?.progress ?? [],
      proposals: (observation.final?.proposals ?? []).map((proposal) => ({ kind: proposal.kind, title: proposal.title })),
      records: (observation.final?.records ?? []).map((record) => `${record.type}:${record.id}`),
      metrics, verdict, grade, tokens: observation.tokens, cost_usd_estimate: observation.cost_usd_estimate, duration_ms: observation.duration_ms,
      error: observation.final?.error ?? null,
    });
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 32).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  let cases = loadLiveCases();
  if (options.dryRun) {
    const { ok } = await dryRun({ cases });
    return ok ? 0 : 1;
  }
  const validation = await dryRun({ cases, log: () => {} });
  if (!validation.ok) {
    console.error(`Case files are invalid; run --dry-run for details (${validation.errors.length} problems).`);
    return 2;
  }
  if (options.filter) cases = cases.filter((entry) => options.filter.test(`${entry.id} ${entry.category} ${entry.question}`));
  if (options.cases.length) cases = cases.filter((entry) => options.cases.includes(entry.id));
  if (options.limit) cases = cases.slice(0, options.limit);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is required for the live suite (use --dry-run to validate cases without a key).');
    return 2;
  }
  const loaded = await loadSdk();
  if (!loaded?.sdk?.OpenAIProvider) {
    console.error('The OpenAI Agents SDK is not available. Set ATLAS_AI_SDK_DIR to a directory whose node_modules has @openai/agents@0.18.0 and zod@4, or run `npm install --no-save @openai/agents@0.18.0 zod@4`.');
    return 2;
  }
  const { sdk, z } = loaded;
  sdk.setTracingDisabled?.(true);
  const provider = new sdk.OpenAIProvider({ apiKey, useResponses: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^ATLAS_AI_MODEL_|^ATLAS_AI_VOICE$/.test(name)));
  const config = loadConfig(env);
  const graderModel = process.env.ATLAS_AI_EVAL_GRADER_MODEL || config.models.orchestrator;
  const grader = options.grade ? (entry, observation) => gradeAnswer({ sdk, provider, model: graderModel, entry, observation }) : null;
  const started = new Date().toISOString();
  const results = await runLive({ cases, sdk, z, provider, env, grader, timeoutSeconds: options.timeout });
  const summary = summarise(results);
  const meta = {
    started,
    finished: new Date().toISOString(),
    models: config.models,
    grader: options.grade ? graderModel : null,
    filter: options.filter?.source ?? null,
    tokens: { in: results.reduce((sum, result) => sum + (result.tokens?.in ?? 0), 0), out: results.reduce((sum, result) => sum + (result.tokens?.out ?? 0), 0) },
    cost_usd_estimate: results.reduce((sum, result) => sum + (result.cost_usd_estimate ?? 0), 0),
  };
  const out = path.resolve(options.out ?? path.join(ROOT, 'tmp', 'ai-eval-live', started.replace(/[:.]/g, '-')));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify({ meta, summary, results }, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'report.md'), `${markdownReport({ meta, summary, results })}\n`);
  const runErrors = results.filter((result) => result.error && !result.metrics.permission?.detail?.startsWith('HTTP')).length;
  if (runErrors && runErrors === results.filter((result) => !result.metrics.permission?.detail?.startsWith('HTTP')).length) {
    console.log('\nEvery model-backed case ended with a run error: check OPENAI_API_KEY, network access to api.openai.com and the ATLAS_AI_MODEL_* names.');
  }
  console.log(`\n${summary.passed}/${summary.cases} cases passed every check; blocking failures: ${summary.blocking_failures.length}.`);
  console.log(`Release gate: ${summary.release_gate.toUpperCase()}. Report: ${path.join(out, 'report.md')}`);
  return summary.blocking_failures.length ? 1 : 0;
}

const invokedDirectly = typeof process !== 'undefined' && process.argv?.[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  });
}
