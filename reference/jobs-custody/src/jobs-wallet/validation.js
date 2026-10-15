function validate(schema, value, path = "input") {
  if (schema === true) return;
  if (Array.isArray(schema.type)) {
    if (value === null && schema.type.includes("null")) return;
    return validate({ ...schema, type: schema.type.find((type) => type !== "null") }, value, path);
  }
  if (schema.enum && !schema.enum.includes(value)) throw Object.assign(Error("invalid_choice"), { code: "invalid_input", field: path });
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(Error("invalid_input"), { code: "invalid_input", field: path });
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) throw Object.assign(Error("unknown_field"), { code: "invalid_input", field: path + "." + key });
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw Object.assign(Error("missing_field"), { code: "invalid_input", field: path + "." + key });
    for (const [key, item] of Object.entries(value)) validate(schema.properties[key], item, path + "." + key);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 1e3)) throw Object.assign(Error("invalid_array"), { code: "invalid_input", field: path });
    value.forEach((item, index) => validate(schema.items, item, path + "." + index));
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 65536)) throw Object.assign(Error("invalid_string"), { code: "invalid_input", field: path });
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? 0) || value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)) throw Object.assign(Error("invalid_integer"), { code: "invalid_input", field: path });
  } else if (schema.type === "boolean" && typeof value !== "boolean") throw Object.assign(Error("invalid_boolean"), { code: "invalid_input", field: path });
}
export {
  validate
};
