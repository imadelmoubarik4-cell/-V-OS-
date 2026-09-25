#!/usr/bin/env node
// Generates docs/ai/Atlas_AI_Tool_Registry.md from the Atlas AI tool registry
// (supabase/functions/_shared/ai-tools). tests/node/ai-tools-registry.test.js
// fails when the committed document is out of date.
//
//   node scripts/generate_ai_tool_registry.mjs          # write the document
//   node scripts/generate_ai_tool_registry.mjs --check  # exit 1 if stale

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../supabase/functions/_shared/ai-tools/registry.mjs';
import { PROPOSAL_KINDS } from '../supabase/functions/_shared/ai-tools/actions.mjs';
import { SPECIALISTS } from '../supabase/functions/_shared/ai-tools/specialists.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY_DOC = path.join(ROOT, 'docs/ai/Atlas_AI_Tool_Registry.md');

const ROLE_SHORT = { admin: 'A', manager: 'M', bartender: 'B', viewer: 'V' };

const EXECUTION = {
  'purchase_order.create': 'PostgREST RPC `atlas_purchase_order_command_v2` action `create` (user JWT; p_id pre-generated, idempotent)',
  'purchase_order.update_draft': 'PostgREST RPC `atlas_purchase_order_command_v2` action `update` on the supplier\'s existing Draft (user JWT; current p_version, full line set; never a second draft)',
  'purchase_order.receive': 'PostgREST RPC `atlas_purchase_order_command_v2` action `receive_lines` (user JWT; p_version + new p_request_id)',
  'stock_count.draft': '`atlas-stock-counts` `start` then `save-line` per counted line (user JWT); left for normal submit/verify',
  'shift.draft': '`atlas-shifts` `save-shift` (user JWT); never publishes',
  'team_message.send': '`atlas-team-messages` `send` (user JWT → `atlas_team_messages_send`)',
  'knowledge.draft': '`atlas-knowledge` `save-draft` (user JWT); never publishes',
  'settings.suggestion': 'none — opens Settings',
  'par_level.suggestion': 'none — opens the par editor',
};

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function inputs(schema) {
  const properties = schema?.properties || {};
  const names = Object.entries(properties).map(([key, child]) => {
    const types = Array.isArray(child.type) ? child.type : [child.type];
    return `${key}${types.includes('null') ? '?' : ''}`;
  });
  return names.length ? names.map((name) => `\`${name}\``).join(', ') : '—';
}

function approval(entry) {
  if (entry.level === 'read') return 'None (read only)';
  const kinds = String(entry.proposalKind || '').split(' or ').map((part) => part.split(' ')[0]);
  const kind = kinds[0];
  const definition = PROPOSAL_KINDS[kind];
  if (!definition) return 'Proposal';
  const roles = definition.roles.map((role) => ROLE_SHORT[role]).join(' ');
  return definition.executable
    ? `Proposal ${kinds.map((name) => `\`${name}\``).join(' or ')}; a person taps Approve (${roles}${kind === 'team_message.send' ? '; announcements A M' : ''})`
    : `Suggestion \`${kind}\`; link only, Atlas never executes`;
}

export function renderRegistryDoc() {
  const lines = [];
  lines.push('# Atlas AI — Tool Registry');
  lines.push('');
  lines.push('Generated from `supabase/functions/_shared/ai-tools/registry.mjs` by');
  lines.push('`node scripts/generate_ai_tool_registry.mjs`. Do not edit by hand: a test fails');
  lines.push('when this document and the registry differ.');
  lines.push('');
  lines.push('Roles: A = admin, M = manager, B = bartender, V = viewer. `?` marks a nullable');
  lines.push('(optional) input; every input is required in the strict schema and optional');
  lines.push('ones accept `null`. The model can only call Read and Draft tools. Execute');
  lines.push('happens only in `actions.mjs executeProposal` after a person approves a');
  lines.push('proposal card; the stored command is re-validated and the role re-checked.');
  lines.push('');
  lines.push(`Tools: ${TOOL_REGISTRY.length} (${TOOL_REGISTRY.filter((entry) => entry.level === 'read').length} read, ${TOOL_REGISTRY.filter((entry) => entry.level === 'draft').length} draft).`);
  lines.push('');
  lines.push('| Tool | Read/Draft/Execute | Roles | Inputs | Source of truth | Approval requirement | Evidence produced |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of TOOL_REGISTRY) {
    lines.push(`| \`${entry.name}\` | ${entry.level === 'read' ? 'Read' : 'Draft'} | ${entry.roles.map((role) => ROLE_SHORT[role]).join(' ')} | ${cell(inputs(entry.parameters))} | ${cell(entry.source)} | ${cell(approval(entry))} | ${cell(entry.evidence)} |`);
  }
  lines.push('');
  lines.push('## Execute: approved proposals');
  lines.push('');
  lines.push('| Proposal kind | Execute | Required roles | Command |');
  lines.push('| --- | --- | --- | --- |');
  for (const [kind, definition] of Object.entries(PROPOSAL_KINDS)) {
    lines.push(`| \`${kind}\` | ${definition.executable ? 'Execute on approval' : 'Not executable'} | ${definition.roles.map((role) => ROLE_SHORT[role]).join(' ')}${kind === 'team_message.send' ? ' (announcements: A M)' : ''} | ${cell(EXECUTION[kind])} |`);
  }
  lines.push('');
  lines.push('## Specialists');
  lines.push('');
  lines.push('| Specialist | Tools |');
  lines.push('| --- | --- |');
  for (const specialist of SPECIALISTS) {
    const names = TOOL_REGISTRY.filter((entry) => entry.specialist === specialist.key).map((entry) => `\`${entry.name}\``);
    lines.push(`| ${specialist.name} | ${names.join(', ') || '—'} |`);
  }
  const orchestrator = TOOL_REGISTRY.filter((entry) => !SPECIALISTS.some((specialist) => specialist.key === entry.specialist));
  lines.push(`| Atlas (orchestrator) | ${orchestrator.map((entry) => `\`${entry.name}\``).join(', ') || '—'} |`);
  lines.push('');
  lines.push('## Model-facing descriptions');
  lines.push('');
  for (const entry of TOOL_REGISTRY) {
    lines.push(`- \`${entry.name}\` (\`${entry.fnName}\`, progress “${entry.progress}”): ${entry.description}`);
  }
  lines.push('');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const rendered = renderRegistryDoc();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(REGISTRY_DOC) ? fs.readFileSync(REGISTRY_DOC, 'utf8') : '';
    if (current !== rendered) {
      console.error('docs/ai/Atlas_AI_Tool_Registry.md is out of date. Run node scripts/generate_ai_tool_registry.mjs');
      process.exit(1);
    }
    console.log('Atlas AI tool registry document is up to date.');
  } else {
    fs.writeFileSync(REGISTRY_DOC, rendered);
    console.log(`Wrote ${path.relative(ROOT, REGISTRY_DOC)} (${TOOL_REGISTRY.length} tools).`);
  }
}
