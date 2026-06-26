// Minimal JSON Schema validator + default-filler.
// Local-only system, so we support just the subset our tool input_schemas use:
//   type (object/array/string/integer/number/boolean), properties, required,
//   enum, items, default, additionalProperties (boolean).
// If schemas ever outgrow this, swap in `ajv` behind the same interface.

function typeOf(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  if (Number.isInteger(v)) return "integer";
  return typeof v; // string | number | boolean | object | undefined
}

function matchesType(value, type) {
  if (!type) return true;
  const t = typeOf(value);
  if (type === "number") return t === "number" || t === "integer";
  if (type === "integer") return t === "integer";
  return t === type;
}

// Walks the schema, fills defaults into a copy, collects errors.
// Returns { valid, errors: string[], value }.
export function validate(schema, input, path = "$") {
  const errors = [];
  let value = input;

  if (!schema || typeof schema !== "object") return { valid: true, errors, value };

  // Apply default at this node when value is undefined.
  if (value === undefined && "default" in schema) {
    value = structuredClone(schema.default);
  }

  if (value === undefined) {
    // Presence is enforced by the parent's `required`; nothing to check here.
    return { valid: true, errors, value };
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return { valid: false, errors, value };
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type === "object" && value && typeof value === "object") {
    const props = schema.properties || {};
    const out = { ...value };
    for (const key of Object.keys(props)) {
      const r = validate(props[key], value[key], `${path}.${key}`);
      errors.push(...r.errors);
      if (r.value !== undefined) out[key] = r.value;
    }
    for (const req of schema.required || []) {
      if (out[req] === undefined) errors.push(`${path}.${req}: required`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(props));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}.${key}: unexpected property`);
      }
    }
    value = out;
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value = value.map((item, i) => {
      const r = validate(schema.items, item, `${path}[${i}]`);
      errors.push(...r.errors);
      return r.value;
    });
  }

  return { valid: errors.length === 0, errors, value };
}
