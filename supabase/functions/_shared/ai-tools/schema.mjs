// Atlas AI tool argument schemas.
//
// Tool parameters are plain JSON Schema in the strict function-calling
// dialect: every object lists all of its properties as required, forbids
// additional properties, and expresses "optional" as nullable. The same
// schema feeds the text agents (converted to zod at runtime with
// `jsonSchemaToZod`) and the Realtime session config (used as-is).
//
// `validateArgs` is a small strict validator for exactly this dialect. The
// gateway runs it on every call, so a malformed or padded argument object
// never reaches a tool, whatever the model or a modified browser sends.
//
// Dependency-free ESM; no Deno APIs.

export const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
export const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
export const LOCAL_DATETIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d$";

function withDescription(schema, description) {
  return description ? { ...schema, description } : schema;
}

// Builders. Each returns a fresh JSON Schema object.
export const S = {
  string(description, { minLength = 1, maxLength = 200, pattern } = {}) {
    const schema = { type: "string", minLength, maxLength };
    if (pattern) schema.pattern = pattern;
    return withDescription(schema, description);
  },
  uuid(description) {
    return withDescription({ type: "string", pattern: UUID_PATTERN }, description);
  },
  date(description) {
    return withDescription({ type: "string", pattern: DATE_PATTERN }, description);
  },
  localDateTime(description) {
    return withDescription({ type: "string", pattern: LOCAL_DATETIME_PATTERN }, description);
  },
  integer(description, { minimum, maximum } = {}) {
    const schema = { type: "integer" };
    if (minimum !== undefined) schema.minimum = minimum;
    if (maximum !== undefined) schema.maximum = maximum;
    return withDescription(schema, description);
  },
  number(description, { minimum, maximum } = {}) {
    const schema = { type: "number" };
    if (minimum !== undefined) schema.minimum = minimum;
    if (maximum !== undefined) schema.maximum = maximum;
    return withDescription(schema, description);
  },
  boolean(description) {
    return withDescription({ type: "boolean" }, description);
  },
  enum(values, description) {
    return withDescription({ type: "string", enum: [...values] }, description);
  },
  array(items, description, { minItems = 0, maxItems = 50 } = {}) {
    return withDescription({ type: "array", items, minItems, maxItems }, description);
  },
  object(properties, description) {
    return withDescription({
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    }, description);
  },
  // Strict-mode "optional": the key is still required but may be null.
  nullable(schema) {
    const next = { ...schema };
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    next.type = types.includes("null") ? types : [...types, "null"];
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) next.enum = [...schema.enum, null];
    return next;
  },
};

function typeList(schema) {
  if (!schema || schema.type === undefined) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function check(schema, value, path, errors) {
  if (errors.length >= 20) return;
  const types = typeList(schema);
  if (types.length && !types.some((type) => matchesType(value, type))) {
    errors.push(`${path} must be ${types.join(" or ")}`);
    return;
  }
  if (value === null) return;
  if (typeof value === "number" && !Number.isFinite(value)) {
    errors.push(`${path} must be a finite number`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.filter((entry) => entry !== null).join(", ")}`);
    return;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long (max ${schema.maxLength})`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
    return;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
    return;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} entries`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} entries`);
    if (schema.items) value.forEach((entry, index) => check(schema.items, entry, `${path}[${index}]`, errors));
    return;
  }
  if (typeof value === "object") {
    const properties = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key) && schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not an accepted argument`);
      }
    }
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required (use null when not needed)`);
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) check(propertySchema, value[key], `${path}.${key}`, errors);
    }
  }
}

// Validates `value` against a strict schema. Returns { ok, value, errors }.
// Strings arriving as JSON text (Realtime and SDK function calls) are parsed.
export function validateArgs(schema, rawValue) {
  let value = rawValue;
  if (value === undefined || value === "") value = {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, value: null, errors: ["arguments are not valid JSON"] };
    }
  }
  const errors = [];
  check(schema, value, "arguments", errors);
  return errors.length ? { ok: false, value: null, errors } : { ok: true, value, errors: [] };
}

// Verifies a schema follows the strict dialect (used by tests and at
// registry load): every object requires all properties and forbids extras.
export function assertStrictSchema(schema, path = "parameters") {
  const types = typeList(schema);
  if (types.includes("object")) {
    const keys = Object.keys(schema.properties || {});
    const required = [...(schema.required || [])].sort();
    if (schema.additionalProperties !== false) throw new Error(`${path} must set additionalProperties: false`);
    if (JSON.stringify(required) !== JSON.stringify([...keys].sort())) {
      throw new Error(`${path} must list every property as required`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) assertStrictSchema(child, `${path}.${key}`);
  }
  if (types.includes("array")) {
    if (!schema.items) throw new Error(`${path} must declare items`);
    assertStrictSchema(schema.items, `${path}[]`);
  }
  return true;
}

// JSON Schema (this dialect) → zod schema. `z` is injected (zod v4 in the
// Deno function) so this module stays dependency-free.
export function jsonSchemaToZod(schema, z) {
  const types = typeList(schema);
  const nullable = types.includes("null");
  const base = types.find((type) => type !== "null");
  let result;
  if (Array.isArray(schema.enum)) {
    result = z.enum(schema.enum.filter((entry) => entry !== null));
  } else if (base === "string") {
    result = z.string();
    if (schema.minLength !== undefined) result = result.min(schema.minLength);
    if (schema.maxLength !== undefined) result = result.max(schema.maxLength);
    if (schema.pattern) result = result.regex(new RegExp(schema.pattern));
  } else if (base === "integer" || base === "number") {
    result = base === "integer" ? z.number().int() : z.number();
    if (schema.minimum !== undefined) result = result.min(schema.minimum);
    if (schema.maximum !== undefined) result = result.max(schema.maximum);
  } else if (base === "boolean") {
    result = z.boolean();
  } else if (base === "array") {
    result = z.array(jsonSchemaToZod(schema.items, z));
    if (schema.minItems !== undefined) result = result.min(schema.minItems);
    if (schema.maxItems !== undefined) result = result.max(schema.maxItems);
  } else if (base === "object") {
    const shape = {};
    for (const [key, child] of Object.entries(schema.properties || {})) shape[key] = jsonSchemaToZod(child, z);
    result = z.object(shape).strict();
  } else {
    throw new Error(`Unsupported schema type ${String(base)}`);
  }
  if (schema.description && typeof result.describe === "function") result = result.describe(schema.description);
  return nullable ? result.nullable() : result;
}
