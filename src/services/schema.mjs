import { canonical, integer, requireThat } from '../shared/index.mjs';

// Deliberately small JSON Schema subset. No references, regular expressions,
// custom formats or executable validators supplied by a provider.
export function schemaDefinition(schema, depth = 0) {
  requireThat(depth < 8 && schema && Object.getPrototypeOf(schema) === Object.prototype, 'invalid_service_schema');
  const allowed = {
    object: ['type', 'properties', 'required', 'additionalProperties'],
    array: ['type', 'items', 'maxItems'],
    string: ['type', 'maxLength', 'enum'],
    integer: ['type', 'minimum', 'maximum'],
    boolean: ['type']
  }[schema.type];
  requireThat(allowed && Object.keys(schema).every(k => allowed.includes(k)), 'invalid_service_schema');
  if (schema.type === 'object') {
    requireThat(schema.properties && Object.getPrototypeOf(schema.properties) === Object.prototype &&
      schema.additionalProperties === false && Array.isArray(schema.required) &&
      new Set(schema.required).size === schema.required.length &&
      schema.required.every(k => Object.hasOwn(schema.properties, k)), 'invalid_service_schema');
    requireThat(Object.keys(schema.properties).length <= 32, 'invalid_service_schema');
    for (const [key, value] of Object.entries(schema.properties)) {
      requireThat(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && !['constructor', 'prototype'].includes(key), 'invalid_service_schema');
      schemaDefinition(value, depth + 1);
    }
  } else if (schema.type === 'array') {
    integer(schema.maxItems, 0, 100); schemaDefinition(schema.items, depth + 1);
  } else if (schema.type === 'string') {
    integer(schema.maxLength, 1, 16000);
    if (schema.enum) requireThat(Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 32 &&
      schema.enum.every(v => typeof v === 'string' && v.length <= schema.maxLength), 'invalid_service_schema');
  } else if (schema.type === 'integer') {
    integer(schema.minimum); integer(schema.maximum, schema.minimum);
  }
  requireThat(Buffer.byteLength(canonical(schema)) <= 12000, 'invalid_service_schema');
}

export function schemaSample(schema) {
  schemaDefinition(schema);
  if (schema.type === 'object') return Object.fromEntries(schema.required.map(key => [key, schemaSample(schema.properties[key])]));
  if (schema.type === 'array') return [];
  if (schema.type === 'string') return schema.enum?.[0] ?? 'probe'.slice(0, schema.maxLength);
  if (schema.type === 'integer') return schema.minimum;
  return false;
}

export function schemaValue(schema, value) {
  let valid = false;
  if (schema.type === 'object') {
    valid = value && Object.getPrototypeOf(value) === Object.prototype &&
      Object.keys(value).every(k => Object.hasOwn(schema.properties, k)) && schema.required.every(k => Object.hasOwn(value, k));
    if (valid) for (const [k, v] of Object.entries(value)) schemaValue(schema.properties[k], v);
  } else if (schema.type === 'array') {
    valid = Array.isArray(value) && value.length <= schema.maxItems;
    if (valid) for (const item of value) schemaValue(schema.items, item);
  } else if (schema.type === 'string') {
    valid = typeof value === 'string' && value.length <= schema.maxLength && (!schema.enum || schema.enum.includes(value));
  } else if (schema.type === 'integer') {
    valid = Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  } else if (schema.type === 'boolean') valid = typeof value === 'boolean';
  requireThat(valid, 'service_schema_mismatch');
  requireThat(Buffer.byteLength(canonical(value)) <= 48000, 'service_payload_too_large');
}
