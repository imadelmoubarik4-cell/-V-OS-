// Deterministic prompt-injection / secret-exfiltration heuristics, shared by
// the Atlas AI input guardrail (atlas-ai/guardrails.mjs re-exports them) and
// by photo recognition, whose label text is read from an image anyone could
// have written on (S91 review P2-C).

const INJECTION_PATTERNS = [
  { reason: "override_instructions", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(instructions?|rules|prompts?|guidelines|directions)\b/i },
  { reason: "reveal_prompt", re: /\b(reveal|show|print|repeat|display|leak|dump|output|tell me)\b[^.\n]{0,40}\b(system prompt|system message|developer (message|prompt)|hidden (prompt|instructions)|your (instructions|prompt|rules))\b/i },
  { reason: "secret_exfiltration", re: /\b(reveal|show|print|give|send|leak|dump|output|tell me|what(?:'s| is))\b[^.\n]{0,40}\b(your|the|atlas'?s?|server|system|function|environment|env)\s+(openai\s+)?(api[\s_-]?keys?|secret(?:s| keys?)?|service[\s_-]?role(?: key)?|access tokens?|bearer tokens?|jwts?|credentials|env(?:ironment)? variables)\b/i },
  { reason: "secret_names", re: /\b(OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|ATLAS_AI_SERVICE_SECRET|ATLAS_INTEGRATION_KEK_V\d+)\b/ },
  { reason: "mode_switch", re: /\byou are (now )?(in )?(developer|dan|jailbreak|god|unrestricted|admin) mode\b/i },
  { reason: "bypass_controls", re: /\b(disable|bypass|skip|turn off|circumvent)\b[^.\n]{0,30}\b(guardrails?|safety|restrictions|approvals?|permissions?|role checks?)\b/i },
  { reason: "impersonate_role", re: /\b(act|pretend|treat me) (as|like|that i am) (an? )?(admin|administrator|manager|system)\b/i },
];

// Deterministic screen for a piece of text.
export function screenUserText(text) {
  const value = String(text ?? "");
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.re.test(value)) return { tripped: true, reason: pattern.reason };
  }
  return { tripped: false, reason: null };
}

// Words that address a model or claim a role, which a product label never
// needs ("SYSTEM:", "assistant", "instructions", "set stock").
const ROLE_OR_COMMAND = /\b(system|assistant|developer|instructions?|prompt|ignore|disregard|override|approve|set stock|stock of)\b|[:<>{}[\]`\\]/i;

// Text read from an image (a brand, product or size on a label) made safe to
// show: short, one line, and null when it looks like an instruction.
export function safeLabelText(value, max = 60) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > max) return null;
  if (screenUserText(text).tripped || ROLE_OR_COMMAND.test(text)) return null;
  return text;
}
