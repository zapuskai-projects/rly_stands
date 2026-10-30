import { asArray, asRecord } from './http';
import { refName, resolveRef, resolveRefTarget } from './document';

export type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  format: string | null;
  enum: unknown[];
  minimum: number | null;
  maximum: number | null;
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
  minItems: number | null;
  maxItems: number | null;
  additionalProperties: boolean | null;
};

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export function extraPropertiesAllowed(schema: Record<string, unknown>): boolean | null {
  const declared = schema.additionalProperties;
  if (declared === undefined) return null;
  return declared !== false;
}

function typeOf(node: unknown, schema: Record<string, unknown>): string {
  const declared = schema.type;
  if (Array.isArray(declared)) return declared.map(String).join('|');
  if (typeof declared === 'string' && declared !== 'object') return declared;
  const reference = refName(node);
  if (reference) return reference;
  if (declared === 'object' || schema.properties) return 'object';
  if (schema.enum) return 'string';
  return 'any';
}

function resolvedSchema(doc: Record<string, unknown>, node: unknown): Record<string, unknown> {
  const resolved = resolveRef(doc, node);
  if (typeof asRecord(node).$ref === 'string' && (resolved === undefined || typeof asRecord(resolved).$ref === 'string')) {
    throw new Error(`неразрешимая или циклическая ссылка: ${String(asRecord(node).$ref)}`);
  }
  return asRecord(resolved);
}

function mergedSchema(doc: Record<string, unknown>, node: unknown, seen = new Set<unknown>()) {
  if (seen.has(node)) throw new Error('циклический allOf');
  const next = new Set(seen);
  const schema = resolvedSchema(doc, node);
  const chain: unknown[] = [];
  let current = node;
  while (typeof asRecord(current).$ref === 'string') {
    if (next.has(current)) throw new Error('циклическая ссылка');
    next.add(current);
    chain.push(current);
    current = resolveRefTarget(doc, current);
  }
  if ((typeof current === 'object' && current !== null && current !== schema) || next.has(schema)) {
    throw new Error('циклический allOf');
  }
  next.add(schema);
  const applicable = /^3\.0(?:\.|$)/.test(String(doc.openapi ?? '')) ? [schema] : [...chain, schema];
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  const parts: unknown[] = [];
  for (const item of applicable) {
    const part = asRecord(item);
    Object.assign(properties, asRecord(part.properties));
    for (const name of asArray(part.required)) required.add(String(name));
    parts.push(...asArray(part.allOf));
  }
  for (const part of parts) {
    const nested = mergedSchema(doc, part, next);
    Object.assign(properties, nested.properties);
    for (const name of nested.required) required.add(name);
  }
  return { properties, required };
}

export function schemaRequired(doc: Record<string, unknown>, node: unknown): string[] {
  return [...mergedSchema(doc, node).required];
}

export function schemaFields(
  doc: Record<string, unknown>,
  schemaNode: unknown,
  prefix = '',
  depth = 0,
): SchemaField[] {
  const { properties, required } = mergedSchema(doc, schemaNode);
  const out: SchemaField[] = [];
  for (const [name, node] of Object.entries(properties)) {
    const property = resolvedSchema(doc, node);
    const full = `${prefix}${name}`;
    out.push({
      name: full,
      type: typeOf(node, property),
      required: required.has(name),
      format: typeof property.format === 'string' ? property.format : null,
      enum: asArray(property.enum),
      minimum: numberOrNull(property.minimum),
      maximum: numberOrNull(property.maximum),
      minLength: numberOrNull(property.minLength),
      maxLength: numberOrNull(property.maxLength),
      pattern: typeof property.pattern === 'string' ? property.pattern : null,
      minItems: numberOrNull(property.minItems),
      maxItems: numberOrNull(property.maxItems),
      additionalProperties: extraPropertiesAllowed(property),
    });
    if (depth < 4 && (property.properties || property.allOf)) {
      out.push(...schemaFields(doc, property, `${full}.`, depth + 1));
    }
    if (depth < 4 && property.type === 'array' && property.items) {
      const items = resolvedSchema(doc, property.items);
      if (items.properties || items.allOf) out.push(...schemaFields(doc, items, `${full}[].`, depth + 1));
    }
  }
  return out;
}

export function schemaTypeName(doc: Record<string, unknown>, node: unknown): string {
  return typeOf(node, resolvedSchema(doc, node));
}

export function schemaSummary(doc: Record<string, unknown>, schemaNode: unknown) {
  const { required } = mergedSchema(doc, schemaNode);
  return {
    type: schemaTypeName(doc, schemaNode),
    required: [...required],
    fields: schemaFields(doc, schemaNode),
  };
}
