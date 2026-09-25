// Converts the Tool Gateway's strict JSON Schema parameters into a zod (v4)
// schema for the Agents SDK tool() helper. `z` is injected so this module has
// no npm import and loads under Node and Deno alike.
//
// Strict-mode rules (Agents SDK / Responses): every property is required and
// optional values are nullable. A property missing from `required` is made
// nullable so the generated schema is still strict-compatible.

function withDescription(schema, source) {
  return typeof source?.description === "string" && source.description
    ? schema.describe(source.description.slice(0, 1000))
    : schema;
}

function isNullSchema(schema) {
  return schema && (schema.type === "null" || (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null));
}

function stringSchema(z, schema) {
  if (Array.isArray(schema.enum) && schema.enum.length && schema.enum.every((value) => typeof value === "string")) {
    return z.enum(schema.enum);
  }
  let out = z.string();
  if (Number.isInteger(schema.minLength)) out = out.min(schema.minLength);
  if (Number.isInteger(schema.maxLength)) out = out.max(schema.maxLength);
  if (typeof schema.pattern === "string") {
    try { out = out.regex(new RegExp(schema.pattern)); } catch { /* keep unconstrained */ }
  }
  return out;
}

function numberSchema(z, schema, integer) {
  let out = z.number();
  if (integer) out = out.int();
  if (typeof schema.minimum === "number") out = out.min(schema.minimum);
  if (typeof schema.maximum === "number") out = out.max(schema.maximum);
  if (typeof schema.exclusiveMinimum === "number") out = out.gt(schema.exclusiveMinimum);
  if (typeof schema.exclusiveMaximum === "number") out = out.lt(schema.exclusiveMaximum);
  return out;
}

function typedSchema(z, schema, type, depth) {
  switch (type) {
    case "string": return stringSchema(z, schema);
    case "number": return numberSchema(z, schema, false);
    case "integer": return numberSchema(z, schema, true);
    case "boolean": return z.boolean();
    case "null": return z.null();
    case "array": {
      let out = z.array(schema.items ? convert(z, schema.items, depth + 1) : z.string());
      if (Number.isInteger(schema.minItems)) out = out.min(schema.minItems);
      if (Number.isInteger(schema.maxItems)) out = out.max(schema.maxItems);
      return out;
    }
    case "object": return objectSchema(z, schema, depth);
    default: throw new Error(`Unsupported JSON Schema type: ${type}`);
  }
}

function objectSchema(z, schema, depth) {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape = {};
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    let converted = convert(z, child, depth + 1);
    if (!required.has(key) && !converted.safeParse(null).success) converted = converted.nullable();
    shape[key] = converted;
  }
  return z.object(shape);
}

export function convert(z, schema, depth = 0) {
  if (depth > 12) throw new Error("JSON Schema is nested too deeply");
  if (!schema || typeof schema !== "object") return z.string();
  let out;
  if ("const" in schema) {
    out = z.literal(schema.const);
  } else if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const variants = schema.anyOf ?? schema.oneOf;
    const nullable = variants.some(isNullSchema);
    const rest = variants.filter((variant) => !isNullSchema(variant)).map((variant) => convert(z, variant, depth + 1));
    out = rest.length === 0 ? z.null() : rest.length === 1 ? rest[0] : z.union(rest);
    if (nullable) out = out.nullable();
  } else if (Array.isArray(schema.type)) {
    const nullable = schema.type.includes("null");
    const types = schema.type.filter((type) => type !== "null");
    const variants = types.map((type) => typedSchema(z, { ...schema, enum: schema.enum?.filter((value) => value !== null) }, type, depth));
    out = variants.length === 0 ? z.null() : variants.length === 1 ? variants[0] : z.union(variants);
    if (nullable) out = out.nullable();
  } else if (schema.type) {
    out = typedSchema(z, schema, schema.type, depth);
  } else if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((value) => value !== null);
    out = values.every((value) => typeof value === "string") && values.length
      ? z.enum(values)
      : z.union(values.map((value) => z.literal(value)));
    if (schema.enum.includes(null)) out = out.nullable();
  } else if (schema.properties) {
    out = objectSchema(z, schema, depth);
  } else {
    out = z.string();
  }
  return withDescription(out, schema);
}

// Tool parameters must be an object schema.
export function toolParametersToZod(z, parameters) {
  const schema = parameters && typeof parameters === "object" ? parameters : { type: "object", properties: {} };
  const converted = convert(z, schema.type ? schema : { ...schema, type: "object" });
  return converted;
}
