// Atlas AI Tool Gateway — public interface for the atlas-ai runtime.
//
//   TOOL_REGISTRY                      registry entries (read + draft only)
//   toolsForRole(role, {specialist, levels})
//   functionDefinitions(role, options) Realtime / Responses function tools
//   runTool(nameOrFnName, rawArgs, ctx) → ToolResult (never throws for expected failures)
//   executeProposal(kind, storedCommand, ctx) → { ok, result | error }
//   buildContextPatch(toolName, toolResult, prevContext, args?) → context patch
//   SPECIALISTS / ORCHESTRATOR_INSTRUCTIONS
//
// ctx = { actor: { userId, role, active, displayName, label, token }, env
//         (object or { get(name) }), fetch, now (ms), venue: { timezone,
//         businessDate } | null, conversationId | null, runId | null,
//         audit: async (call) => void, services? }

export { TOOL_REGISTRY, getTool, toolsForRole, functionDefinitions } from "./registry.mjs";
export { runTool, redactForRole, redactArguments, COMMERCIAL_KEYS } from "./gateway.mjs";
export { executeProposal, buildPreview, buildProposal, PROPOSAL_KINDS, requiredRolesFor, validateCommand } from "./actions.mjs";
export {
  buildContextPatch, resolveFollowUp, resolveDateReference, resolveFilterReference, modifyProposalArgs, contextSummaryForPrompt, parseQuantity,
} from "./context.mjs";
export { SPECIALISTS, SHARED_RULES, ORCHESTRATOR_INSTRUCTIONS, specialistFor } from "./specialists.mjs";
export { validateArgs, jsonSchemaToZod, assertStrictSchema } from "./schema.mjs";
export { createServices, ServiceError } from "./services.mjs";
export { EVIDENCE_KINDS, ERROR_CODES, routeFor } from "./result.mjs";
