// Builds the Atlas agent graph for one verified actor with the OpenAI Agents
// SDK (injected as `sdk`, with zod as `z`):
//   Atlas (orchestrator) ── direct read/draft tools for simple questions
//                        └─ specialists via agent.asTool() (manager pattern)
// Every tool is an SDK tool() whose zod schema is generated from the Tool
// Gateway's JSON Schema and whose execute() calls gateway.runTool with the
// server-built context from the run context — never with an actor taken from
// the model's arguments. Execute-level tools are never exposed; draft tools
// create proposals (needsApproval is not used).

import { toolParametersToZod } from "./schema.mjs";
import { orchestratorInstructions, specialistInstructions } from "./instructions.mjs";
import { screenUserText } from "./guardrails.mjs";

export const SPECIALIST_PROGRESS = Object.freeze({
  inventory: "Checking stock",
  recipes: "Checking recipes",
  purchasing: "Looking at purchasing",
  operations: "Checking today's operations",
  reports: "Looking at the numbers",
  shifts: "Looking at the rota",
  team: "Checking the team",
  knowledge: "Searching Knowledge",
  marketing: "Looking at marketing",
  data_quality: "Checking data quality",
  integration: "Checking connections",
  integrations: "Checking connections",
});

export function specialistToolName(key) {
  return `ask_${String(key).replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
}

function allowedEntries(gateway, role, options) {
  return (gateway.toolsForRole(role, options) ?? []).filter((entry) => entry && entry.level !== "execute" && entry.fnName);
}

function turnFrom(runContext) {
  const turn = runContext?.context?.turn;
  if (!turn) throw new Error("Atlas AI tool called without a server turn context");
  return turn;
}

export function registryTool(sdk, z, entry) {
  return sdk.tool({
    name: entry.fnName,
    description: String(entry.description ?? entry.name).slice(0, 1000),
    parameters: toolParametersToZod(z, entry.parameters),
    strict: true,
    execute: async (args, runContext) => {
      const turn = turnFrom(runContext);
      const { output } = await turn.runTool(entry, args);
      return output;
    },
  });
}

// Input guardrail: deterministic heuristics on the user's own text, plus an
// optional cheap model classifier (ATLAS_AI_GUARDRAIL_CLASSIFIER=model).
export function atlasInputGuardrail({ classify = null } = {}) {
  return {
    name: "atlas_input_screen",
    runInParallel: false,
    execute: async ({ context }) => {
      const userText = context?.context?.userText ?? context?.userText ?? "";
      const screened = screenUserText(userText);
      if (screened.tripped) return { tripwireTriggered: true, outputInfo: { reason: screened.reason, source: "heuristic" } };
      if (classify) {
        try {
          const verdict = await classify(userText);
          if (verdict === "block") return { tripwireTriggered: true, outputInfo: { reason: "classifier", source: "model" } };
        } catch {
          // The classifier is advisory; the deterministic screen already ran.
        }
      }
      return { tripwireTriggered: false, outputInfo: { reason: null } };
    },
  };
}

// Returns {agent, toolNames, specialistNames}.
export function buildAtlasAgent({ sdk, z, gateway, actor, venue, nowIso, preferences, models, modelSettings = {}, inputGuardrails = [] }) {
  const specialists = [];
  // Friendly progress labels by tool name, used by the stream's tool_called
  // events (registry tools also report their own label when they run).
  const progressLabels = {};
  for (const specialist of gateway.SPECIALISTS ?? []) {
    const entries = allowedEntries(gateway, actor.role, { specialist: specialist.key, levels: ["read", "draft"] });
    if (!entries.length) continue;
    const agent = new sdk.Agent({
      name: specialist.name,
      instructions: specialistInstructions(specialist),
      model: models.specialist,
      modelSettings: modelSettings.specialist ?? {},
      tools: entries.map((entry) => registryTool(sdk, z, entry)),
    });
    const toolName = specialistToolName(specialist.key);
    progressLabels[toolName] = SPECIALIST_PROGRESS[specialist.key] ?? "Working on it";
    specialists.push(agent.asTool({
      toolName,
      toolDescription: String(specialist.description ?? specialist.name).slice(0, 1000),
    }));
  }
  const directEntries = allowedEntries(gateway, actor.role, { levels: ["read", "draft"] });
  for (const entry of directEntries) progressLabels[entry.fnName] = entry.progress || "Checking Atlas";
  const direct = directEntries.map((entry) => registryTool(sdk, z, entry));
  const agent = new sdk.Agent({
    name: "Atlas",
    instructions: orchestratorInstructions({ actor, venue, nowIso, preferences }),
    model: models.orchestrator,
    modelSettings: modelSettings.orchestrator ?? {},
    tools: [...direct, ...specialists],
    inputGuardrails,
  });
  return {
    agent,
    toolNames: [...direct.map((tool) => tool.name), ...specialists.map((tool) => tool.name)],
    specialistNames: specialists.map((tool) => tool.name),
    progressLabels,
  };
}
