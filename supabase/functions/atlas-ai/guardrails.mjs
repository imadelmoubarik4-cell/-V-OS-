// Atlas AI guardrails (docs/ai/Atlas_AI_Architecture.md §12):
// * deterministic prompt-injection / secret-exfiltration heuristics for the
//   user's own text (document text is data and is wrapped, not screened out);
// * output redaction of key and secret patterns, stable while streaming;
// * the grounding check: an answer that states operational quantities or
//   prices is replaced unless every stated figure appears in the question,
//   the previous answer's evidence or the output of a tool that returned
//   operational evidence in the same run.

const INJECTION_PATTERNS = [
  { reason: "override_instructions", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(instructions?|rules|prompts?|guidelines|directions)\b/i },
  { reason: "reveal_prompt", re: /\b(reveal|show|print|repeat|display|leak|dump|output|tell me)\b[^.\n]{0,40}\b(system prompt|system message|developer (message|prompt)|hidden (prompt|instructions)|your (instructions|prompt|rules))\b/i },
  { reason: "secret_exfiltration", re: /\b(reveal|show|print|give|send|leak|dump|output|tell me|what(?:'s| is))\b[^.\n]{0,40}\b(your|the|atlas'?s?|server|system|function|environment|env)\s+(openai\s+)?(api[\s_-]?keys?|secret(?:s| keys?)?|service[\s_-]?role(?: key)?|access tokens?|bearer tokens?|jwts?|credentials|env(?:ironment)? variables)\b/i },
  { reason: "secret_names", re: /\b(OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|ATLAS_AI_SERVICE_SECRET|ATLAS_INTEGRATION_KEK_V\d+)\b/ },
  { reason: "mode_switch", re: /\byou are (now )?(in )?(developer|dan|jailbreak|god|unrestricted|admin) mode\b/i },
  { reason: "bypass_controls", re: /\b(disable|bypass|skip|turn off|circumvent)\b[^.\n]{0,30}\b(guardrails?|safety|restrictions|approvals?|permissions?|role checks?)\b/i },
  { reason: "impersonate_role", re: /\b(act|pretend|treat me) (as|like|that i am) (an? )?(admin|administrator|manager|system)\b/i },
];

// Deterministic screen for the user's own message.
export function screenUserText(text) {
  const value = String(text ?? "");
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.re.test(value)) return { tripped: true, reason: pattern.reason };
  }
  return { tripped: false, reason: null };
}

export const GUARDRAIL_REPLY =
  "I can't help with that. I can only work with Atlas data you're allowed to see, and I can't change my instructions, reveal secrets or skip approvals. Ask me about stock, recipes, orders, shifts or anything else in Atlas.";

// Token-level secret patterns: none spans whitespace, so redacting a prefix
// that ends at whitespace is stable while a reply streams.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bek_[A-Za-z0-9_-]{16,}/g,
  /\bsb_secret_[A-Za-z0-9_-]{8,}/g,
  /\bsb_publishable_[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
];
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
export const REDACTED = "[redacted]";

export function redactSecrets(text) {
  let value = String(text ?? "");
  value = value.replace(PRIVATE_KEY_BLOCK, REDACTED);
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, REDACTED);
  return value;
}

export function containsSecret(text) {
  return redactSecrets(text) !== String(text ?? "");
}

// Arguments stored in ai_tool_calls: secret-looking keys removed, strings
// shortened and secret patterns redacted, capped well below the 32 KB column.
export function redactArguments(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactSecrets(value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactArguments(entry, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 50)) {
      out[key] = /(secret|token|password|api[_-]?key|authorization|credential|jwt)/i.test(key)
        ? REDACTED
        : redactArguments(entry, depth + 1);
    }
    return out;
  }
  return null;
}

// Streams text through redaction: only text up to the last whitespace is
// released, so a secret token is always judged whole. `hold` keeps all text
// back (used until a verified tool result exists, so the grounding check can
// still replace the answer).
export function createRedactingStream() {
  let full = "";
  let released = "";
  return {
    push(delta) {
      full += String(delta ?? "");
    },
    get text() {
      return full;
    },
    // `holdTrailingFigure`: a figure (a word with a digit or a currency
    // marker) is released only together with the word after it, so the
    // grounding check has seen the whole quantity ("57" + "bottles") before
    // any of it reaches the browser.
    releasable({ holdTrailingFigure = false } = {}) {
      let boundary = Math.max(full.lastIndexOf(" "), full.lastIndexOf("\n"), full.lastIndexOf("\t"));
      if (boundary < 0) return "";
      while (holdTrailingFigure && boundary >= 0) {
        const head = full.slice(0, boundary).replace(/\s+$/, "");
        const start = head.search(/\S+$/);
        const word = start < 0 ? "" : head.slice(start);
        if (!word || !(/[\d€$£%]/.test(word) || /^(isk|eur|usd|gbp|kr\.?)$/i.test(word))) break;
        boundary = start - 1;
      }
      if (boundary < 0) return "";
      const safe = redactSecrets(full.slice(0, boundary + 1));
      if (!safe.startsWith(released)) return "";
      const next = safe.slice(released.length);
      released = safe;
      return next;
    },
    // Final release of the (possibly replaced) complete text.
    finish(finalText) {
      const safe = redactSecrets(finalText ?? full);
      if (safe.startsWith(released)) {
        const rest = safe.slice(released.length);
        released = safe;
        return { rest, replaced: false, text: safe };
      }
      released = safe;
      return { rest: null, replaced: true, text: safe };
    },
    get released() {
      return released;
    },
  };
}

// --- Grounding --------------------------------------------------------------

const UNIT_WORDS = [
  "bottles?", "btls?", "cases?", "crates?", "kegs?", "cans?", "units?", "pcs", "pieces?", "portions?",
  "servings?", "items?", "litres?", "liters?", "l", "ml", "cl", "dl", "kg", "kgs", "g", "grams?", "kilos?",
  "lbs?", "oz", "packs?", "boxes?", "bags?", "cartons?", "trays?", "shifts?", "covers?", "orders?",
  "percent", "kr", "isk", "eur", "usd", "gbp", "euros?", "dollars?", "krónur", "kronur",
];
const NUMBER = String.raw`\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const QUANTITY = new RegExp(
  String.raw`(?:[€$£]\s?(${NUMBER}))` +
  String.raw`|(?:\b(?:ISK|EUR|USD|GBP|kr\.?)\s?(${NUMBER}))` +
  String.raw`|(?:\b(${NUMBER})\s?%)` +
  String.raw`|(?:\b(${NUMBER})\s?(?:${UNIT_WORDS.join("|")})\b)`,
  "gi",
);

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12 };

function normaliseNumber(raw) {
  const compact = String(raw).replace(/\s/g, "");
  // "1,234.5" / "1.234,5" / "12,5" → digits only comparison is enough here.
  const plain = compact.replace(/[.,](?=\d{3}(\D|$))/g, "").replace(",", ".");
  // "4.50" and "4.5" are the same figure; "10.0" is "10".
  return plain.includes(".") ? plain.replace(/0+$/, "").replace(/\.$/, "") : plain;
}

export function quantityMentions(text) {
  const mentions = [];
  const value = String(text ?? "");
  QUANTITY.lastIndex = 0;
  let match;
  while ((match = QUANTITY.exec(value))) {
    const number = match[1] ?? match[2] ?? match[3] ?? match[4];
    mentions.push({ text: match[0], number: normaliseNumber(number) });
  }
  return mentions;
}

export function numbersIn(value) {
  const found = new Set();
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  for (const match of text.matchAll(/\d+(?:[.,]\d+)*/g)) found.add(normaliseNumber(match[0]));
  for (const [word, number] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) found.add(String(number));
  }
  return found;
}

// Numbers a verified tool output supports, with the roundings an answer may
// use ("11.6 bottles" may be said as "12" or "11.6").
export function evidenceNumbersFrom(values) {
  const found = new Set();
  for (const value of values) {
    for (const number of numbersIn(value)) {
      found.add(number);
      const parsed = Number(number);
      if (Number.isFinite(parsed)) {
        found.add(normaliseNumber(String(Math.round(parsed))));
        found.add(normaliseNumber(parsed.toFixed(1)));
        found.add(normaliseNumber(parsed.toFixed(2)));
      }
    }
  }
  return found;
}

export const UNVERIFIED_REPLY =
  "I couldn't verify that from Atlas data, so I won't state a figure. Ask me to check it and I'll look it up in Atlas.";

// Returns {ok, replaced, text, unverified[]}. `allowedNumbers` holds numbers
// the user supplied or that come from evidence already shown (previous
// turn), so "How do you know?" and "Change it to three cases" are not
// blocked. `evidenceNumbers` holds the figures in the outputs of tools that
// returned operational evidence in this run (TurnState.evidenceNumbers);
// `verifiedToolRan` alone no longer lets unverified figures through.
// Conversational replies without quantities always pass.
export function groundingCheck(text, { verifiedToolRan = false, allowedNumbers = new Set(), evidenceNumbers = new Set() } = {}) {
  const supported = (number) => allowedNumbers.has(number) || (verifiedToolRan && evidenceNumbers.has(number));
  const unverified = quantityMentions(text).filter((mention) => !supported(mention.number));
  if (!unverified.length) return { ok: true, replaced: false, text, unverified: [] };
  return { ok: false, replaced: true, text: UNVERIFIED_REPLY, unverified: unverified.map((entry) => entry.text).slice(0, 10) };
}
